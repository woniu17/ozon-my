/* =========================================================
 * 采集队列层(采集代码隔离 Phase 3)
 *
 * 从 service-worker.js 提取的队列相关代码,采用 init 桥接模式:
 *   - 注册 globalThis.__jzCollect.setupQueue 函数
 *   - 由 __jzCollect.init() 在 IIFE 工具函数就绪后调用
 *   - 通过 this._sw 访问 SW 工具(getBackendUrl/getStorage/setStorage/
 *     apiRequest/STORAGE_KEYS/loadAutoCollectConfig/IS_TEST_MODE/maybeStartConsume)
 *   - 通过 this.state.xxx 访问采集运行时状态(consuming/queueWriteLock/opsPollTimer/
 *     completedTodaySkus/collectManagerTabIds)
 *   - 通过 __jzCollect.xxx 访问缓存/配置层暴露的函数
 *
 * 覆盖范围:
 *   - 队列常量 + meta 默认值
 *   - 队列 CRUD(加锁 load/save/enqueue/update/delete/clear/getNextPending)
 *   - 已完成集合(completedTodaySkus add/has/init)
 *   - 辅助函数(buildSteps/retryBackoffMs/cleanupCompleted/syncConsumeRate)
 *   - 熔断检查(isCircuitBreakerActive)
 *   - 广播(queueStatus/taskStatus/collectManagers/collectDoneV2/paused/resumed/rescan)
 *   - ERP 镜像(queue insert/update/result/delete/getPendingOps/markOpProcessed)
 *   - 数据辅助(fetchProductDataStats/extractBundlePhysicalAttrs/getBundleItemForBroadcast/
 *     getSearchVariantForBroadcast/buildCollectDoneData)
 *   - 任务最终化(finalizeTask/handleRetryOrFinal/handleSkippedTask)
 *   - Ops 轮询(checkStaleRunningTasks/processQueueOp/pollOpsPending/startOpsPolling/
 *     stopOpsPolling)
 *   - 测试重置(resetQueueState)
 *   - Alarm 设置(setupCollectQueueAlarm)
 *   - 任务提交(handleSubmitTask — 通过 sw.maybeStartConsume() 桥接回 SW 编排层)
 *
 * 暂留 service-worker.js(编排层,调用 _doAutoCollect):
 *   - _processTask / _consumeOne / _maybeStartConsume(依赖 _doAutoCollect,
 *     通过委托包装器调用本层数据函数,通过 __jzCollect.state 共享状态)
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupQueue = function () {
    const sw = this._sw;
    const S = this.state;

    // ── 常量 ──────────────────────────────────────────────────────────────────
    // chrome.storage.local key + alarm
    const COLLECT_QUEUE_KEY = 'jz-collect-queue';
    const COLLECT_QUEUE_META_KEY = 'jz-collect-queue-meta';
    const COLLECT_QUEUE_ALARM = 'collect-queue-consume';
    const COLLECT_QUEUE_ALARM_MINUTES = 1;
    const COLLECT_QUEUE_OPS_POLL_MS = 5000;
    const COLLECT_QUEUE_MAX_COMPLETED = 500;
    const COLLECT_QUEUE_STALE_RUNNING_MS = 5 * 60 * 1000;

    const _COLLECT_QUEUE_META_DEFAULT = {
      consuming: false,
      circuitBreakerUntil: 0,
      consumeRateSec: 15,
      consumePaused: false,
      lastConsumeAt: 0,
      todayCount: 0,
      todayDate: '',
    };

    // 内存写锁初始化(namespace.js 中 queueWriteLock 初始为 null)
    if (!S.queueWriteLock) S.queueWriteLock = Promise.resolve();

    // ── 队列 CRUD ─────────────────────────────────────────────────────────────
    // 内存写锁:所有队列写入(入队/更新/删除/清理)串行化,消除 get-modify-set 竞态。
    const _withQueueLock = (fn) => {
      const prev = S.queueWriteLock;
      let release;
      S.queueWriteLock = new Promise((r) => {
        release = r;
      });
      return prev.then(async () => {
        try {
          return await fn();
        } finally {
          release();
        }
      });
    };

    const _loadQueue = async () => {
      try {
        const stored = await sw.getStorage([COLLECT_QUEUE_KEY]);
        return Array.isArray(stored?.[COLLECT_QUEUE_KEY]) ? stored[COLLECT_QUEUE_KEY] : [];
      } catch (e) {
        console.warn('[Queue] load queue failed:', e?.message || e);
        return [];
      }
    };

    const _loadQueueMeta = async () => {
      try {
        const stored = await sw.getStorage([COLLECT_QUEUE_META_KEY]);
        const raw = stored?.[COLLECT_QUEUE_META_KEY];
        return raw && typeof raw === 'object'
          ? { ..._COLLECT_QUEUE_META_DEFAULT, ...raw }
          : { ..._COLLECT_QUEUE_META_DEFAULT };
      } catch (e) {
        console.warn('[Queue] load meta failed:', e?.message || e);
        return { ..._COLLECT_QUEUE_META_DEFAULT };
      }
    };

    // 熔断期检查(供按需 API 调用入口使用,避免反爬时仍开 tab 发请求)
    // 返回 { active: boolean, remainingMs: number }
    const _isCircuitBreakerActive = async () => {
      const meta = await _loadQueueMeta();
      const now = Date.now();
      if (now < meta.circuitBreakerUntil) {
        return { active: true, remainingMs: meta.circuitBreakerUntil - now };
      }
      return { active: false, remainingMs: 0 };
    };

    const _saveQueueMeta = async (partial) => {
      return _withQueueLock(async () => {
        const meta = await _loadQueueMeta();
        const updated = { ...meta, ...partial };
        await sw.setStorage({ [COLLECT_QUEUE_META_KEY]: updated });
        return updated;
      });
    };

    const _syncConsumeRateFromConfig = async () => {
      try {
        const config = await sw.loadAutoCollectConfig();
        // skuInterval 历史单位为毫秒,consumeRateSec 为秒;优先使用 consumeRateSec。
        const rateSec = Math.max(
          5,
          Math.min(120, Math.round(config.consumeRateSec ?? (config.skuInterval ? config.skuInterval / 1000 : 15)))
        );
        const meta = await _loadQueueMeta();
        if (meta.consumeRateSec !== rateSec) {
          await _saveQueueMeta({ consumeRateSec: rateSec });
        }
      } catch (e) {
        console.warn('[Queue] sync consume rate failed:', e?.message || e);
      }
    };

    const _cleanupCompletedTasksLocked = (queue) => {
      const completed = queue.filter(
        (t) => t.status === 'success' || t.status === 'failed_final' || t.status === 'failed_partial'
      );
      if (completed.length > COLLECT_QUEUE_MAX_COMPLETED) {
        completed.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
        const toRemove = new Set(completed.slice(0, completed.length - COLLECT_QUEUE_MAX_COMPLETED).map((t) => t.sku));
        const kept = queue.filter((t) => !toRemove.has(t.sku));
        queue.length = 0;
        queue.push(...kept);
        // 同步删除 ERP 镜像(fire-and-forget,锁内不 await)
        for (const sku of toRemove) {
          _erpQueueDelete(sku);
        }
      }
    };

    const _enqueueTask = async (task) => {
      return _withQueueLock(async () => {
        const queue = await _loadQueue();
        // 锁内二次去重,消除并发提交同 SKU 的 check-then-act 竞态。
        if (queue.some((t) => t.sku === task.sku) || S.completedTodaySkus.has(task.sku)) {
          return { task: queue.find((t) => t.sku === task.sku) || task, isNew: false };
        }
        _cleanupCompletedTasksLocked(queue);
        queue.push(task);
        await sw.setStorage({ [COLLECT_QUEUE_KEY]: queue });
        // 广播 pending 徽章(fire-and-forget,不阻塞锁)
        _broadcastTaskStatus(task.sku, 'pending', 0, task.maxAttempts || 3, 0);
        return { task, isNew: true };
      });
    };

    const _updateQueueTask = async (sku, updates) => {
      return _withQueueLock(async () => {
        const queue = await _loadQueue();
        const task = queue.find((t) => t.sku === sku);
        if (!task) return null;
        Object.assign(task, updates);
        await sw.setStorage({ [COLLECT_QUEUE_KEY]: queue });
        return task;
      });
    };

    const _deleteQueueTask = async (sku) => {
      return _withQueueLock(async () => {
        const queue = await _loadQueue();
        const idx = queue.findIndex((t) => t.sku === sku);
        if (idx >= 0) {
          queue.splice(idx, 1);
          await sw.setStorage({ [COLLECT_QUEUE_KEY]: queue });
        }
        return true;
      });
    };

    // beforeTs 可选:仅清除 createdAt <= beforeTs 的 pending 任务,
    // 防止 markOpProcessed 失败后重复执行 clear op 误清新入队任务。
    const _clearPendingQueueTasks = async (beforeTs) => {
      return _withQueueLock(async () => {
        const queue = await _loadQueue();
        const kept = queue.filter((t) => {
          if (t.status !== 'pending') return true;
          if (beforeTs && t.createdAt > beforeTs) return true;
          return false;
        });
        await sw.setStorage({ [COLLECT_QUEUE_KEY]: kept });
        return kept.length;
      });
    };

    const _getNextPending = async () => {
      const queue = await _loadQueue();
      const now = Date.now();
      // pending 与 failed_retry(退避时间到)都可消费。failed_retry 是内部展示态,
      // 实际重试时回到 pending + nextRetryAt;兼容处理防止旧任务滞留。
      return queue.find(
        (t) => (t.status === 'pending' || t.status === 'failed_retry') && (!t.nextRetryAt || t.nextRetryAt <= now)
      );
    };

    const _addCompletedToday = (sku) => {
      S.completedTodaySkus.add(sku);
    };

    const _isTaskQueuedOrCompletedToday = async (sku) => {
      const queue = await _loadQueue();
      if (queue.some((t) => t.sku === sku)) return true;
      return S.completedTodaySkus.has(sku);
    };

    const _initCompletedTodaySet = async () => {
      try {
        const queue = await _loadQueue();
        const today = new Date().toLocaleDateString('en-CA');
        for (const t of queue) {
          if ((t.status === 'success' || t.status === 'failed_final' || t.status === 'failed_partial') && t.finishedAt) {
            const d = new Date(t.finishedAt).toLocaleDateString('en-CA');
            if (d === today) S.completedTodaySkus.add(t.sku);
          }
        }
      } catch (e) {
        console.warn('[Queue] init completed today set failed:', e?.message || e);
      }
    };

    const _buildSteps = (results) => {
      if (!Array.isArray(results)) return null;
      const steps = {};
      for (const r of results) {
        if (!r || !r.type) continue;
        steps[r.type] = r.hit ? 'ok' : r.error ? 'fail' : 'skip';
      }
      return steps;
    };

    const _retryBackoffMs = (attempts) => {
      const table = [10000, 30000, 90000];
      return table[Math.min(attempts, table.length - 1)] || 10000;
    };

    const _broadcastQueueStatus = async (sku, sellerSlug, status) => {
      try {
        const tabs = await chrome.tabs.query({
          url: sw.IS_TEST_MODE
            ? ['http://localhost:7777/seller/*', 'http://localhost:7777/product/*']
            : ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'],
        });
        for (const t of tabs) {
          if (!t.id) continue;
          chrome.tabs.sendMessage(t.id, { type: 'collectStatus', sku, sellerSlug, status }).catch(() => {});
        }
      } catch (e) {
        /* fire-and-forget */
      }
    };

    // 向所有 Ozon tab 广播任务中间态(pending/running/failed_retry),驱动前端徽章
    const _broadcastTaskStatus = async (sku, status, attempts, maxAttempts, nextRetryAt) => {
      try {
        const tabs = await chrome.tabs.query({
          url: sw.IS_TEST_MODE
            ? ['http://localhost:7777/seller/*', 'http://localhost:7777/product/*']
            : ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'],
        });
        const payload = {
          type: 'taskStatus',
          sku,
          status,
          attempts: attempts || 0,
          maxAttempts: maxAttempts || 3,
          nextRetryAt: nextRetryAt || 0,
        };
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, payload).catch(() => {});
        }
      } catch (e) {
        /* fire-and-forget */
      }
    };

    // 向所有已注册的深度采集管理页 tab 发送消息(供 collectDone/queuePaused/queueResumed 复用)。
    // MV3 SW 生命周期不可控,必须 await Promise.allSettled 确保 sendMessage 完成。
    const _broadcastToCollectManagers = async (payload) => {
      if (S.collectManagerTabIds.size === 0) return;
      const sends = [];
      for (const tabId of S.collectManagerTabIds) {
        sends.push(
          chrome.tabs.sendMessage(tabId, payload).catch((e) => {
            // tab 已关闭/不存在,从集合中移除
            if (e?.message?.includes('Could not establish connection') || e?.message?.includes('No tab')) {
              S.collectManagerTabIds.delete(tabId);
            }
          })
        );
      }
      await Promise.allSettled(sends);
    };

    const _broadcastCollectDoneV2 = async (sku, sellerSlug, status, data, collectedAt, duration, steps, error) => {
      try {
        const tabs = await chrome.tabs.query({
          url: sw.IS_TEST_MODE
            ? ['http://localhost:7777/seller/*', 'http://localhost:7777/product/*']
            : ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'],
        });
        const payload = {
          type: 'collectDone',
          sku,
          sellerSlug,
          status,
          data,
          collectedAt,
          duration,
          steps,
          error,
        };
        for (const t of tabs) {
          if (!t.id) continue;
          chrome.tabs.sendMessage(t.id, payload).catch(() => {});
        }
        // 同步发给深度采集管理页(让页面实时更新单 SKU 状态)
        await _broadcastToCollectManagers(payload);
      } catch (e) {
        /* fire-and-forget */
      }
    };

    // 队列暂停广播:当 daily-limit/not-running/paused 导致队列暂停时,
    // 通知所有 content script 将 loading 状态的 panel 设为 ready,
    // 避免 AutoScroller 的 isReadyToScroll 死锁。
    const _broadcastQueuePaused = async (reason) => {
      try {
        const urlFilter = sw.IS_TEST_MODE
          ? ['http://localhost:7777/seller/*', 'http://localhost:7777/product/*']
          : ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'];
        const tabs = await chrome.tabs.query({ url: urlFilter });
        const payload = { type: 'queuePaused', reason };
        // 必须等待所有 sendMessage 完成,否则 SW 可能在消息投递前被终止(MV3 生命周期),
        // 导致 content script 收不到广播,panel 永远卡 loading,AutoScroller 死锁。
        const sends = tabs
          .filter((t) => t.id)
          .map((t) =>
            chrome.tabs.sendMessage(t.id, payload).catch((e) => {
              console.warn('[broadcastQueuePaused] sendMessage failed tab=%d:', t.id, e?.message);
            })
          );
        await Promise.allSettled(sends);
        // 不发给 collect-manager:该广播是店铺页 content script 的 panel 死锁兜底,
        // collect-manager 无 AutoScroller 不会死锁,且批量提交时 N 次广播会风暴。
        // collect-manager 通过 5s 轮询 getCollectManagerState 获取暂停状态即可。
      } catch (e) {
        console.warn('[broadcastQueuePaused] error:', e?.message || e);
      }
    };

    // 队列恢复广播:跨日重置或熔断过期后恢复消费时通知 content script,
    // 清除 __jzQueuePaused 标志,让后续新 panel 正常走采集流程。
    const _broadcastQueueResumed = async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: sw.IS_TEST_MODE
            ? ['http://localhost:7777/seller/*', 'http://localhost:7777/product/*']
            : ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'],
        });
        const payload = { type: 'queueResumed' };
        const sends = tabs.filter((t) => t.id).map((t) => chrome.tabs.sendMessage(t.id, payload).catch(() => {}));
        await Promise.allSettled(sends);
        // 不发给 collect-manager(同 _broadcastQueuePaused 理由)
      } catch {
        /* fire-and-forget */
      }
    };

    // rescan 广播:不刷新页面重新提交所有可见 SKU。
    // 先发 __jzAutoCollectResetSeen 清空 dedup(content script 旧代码已有监听),
    // 再用 chrome.scripting.executeScript 注入 inline 脚本(ISOLATED world)遍历 cards 重新提交。
    // 这样不依赖 content script 的 rescan 消息处理(重载扩展后 content script 可能仍是旧代码)。
    const _broadcastRescan = async () => {
      try {
        const urlFilter = sw.IS_TEST_MODE
          ? ['http://localhost:7777/seller/*', 'http://localhost:7777/product/*']
          : ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'];
        const tabs = await chrome.tabs.query({ url: urlFilter });
        const sends = tabs
          .filter((t) => t.id)
          .map((t) => chrome.tabs.sendMessage(t.id, { type: '__jzAutoCollectResetSeen' }).catch(() => {}));
        await Promise.allSettled(sends);

        // 扩展重载后旧 content script 被孤立(无法收 SW 消息),
        // 需重新注入 content scripts 到新 ISOLATED world。
        // 各文件有加载守卫,新 world 未设标志,会正常执行。
        const injectFiles = [
          'content/shared-utils.js',
          'collect/content/collect-entry.js',
          'collect/content/task-queue.js',
          'content/ozon-data-panel.js',
        ];

        // rescan 脚本:遍历 cards + 清除旧 panel 守卫 + 调 __jzSubmitCollectTask 重新提交
        // 关键:扩展重载后旧 content script 被孤立,旧 panel 是骨架状态(loadPanelData
        // 因 ERP 无数据未调 jzRenderProductPanelV2)。card._ohPanelAttached 是 DOM expando
        // 属性,跨 ISOLATED world 共享,会阻止新 content script 的 ensureDataPanel 重建 panel。
        // 必须清除该标志 + 删除旧 panel,让新 content script 的 MutationObserver 触发
        // applyToAll → ensureDataPanel 重建 panel,新 IntersectionObserver 触发 loadPanelData
        // 重新查 ERP + 渲染 [data-field] 字段结构。
        const rescanFn = () => {
          try {
            let slug = '';
            let sellerId = '';
            try {
              const raw = document.documentElement.getAttribute('data-jz-seller-info');
              if (raw) {
                const parsed = JSON.parse(raw);
                slug = parsed?.detail?.slug || '';
                sellerId = parsed?.detail?.sellerId || '';
              }
            } catch (_) {
              /* ignore */
            }
            const selectors = [
              '.tile-root',
              '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
              '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
            ];
            const cardSet = new Set();
            selectors.forEach((s) => document.querySelectorAll(s).forEach((c) => cardSet.add(c)));
            let count = 0;
            for (const card of cardSet) {
              const link = card.querySelector('a[href*="/product/"]');
              if (!link) continue;
              const href = link.getAttribute('href') || '';
              const m = href.match(/\/product\/.*-(\d{5,})/);
              if (!m) continue;
              const productId = m[1];
              // 清除旧 content script 的加载守卫 + 删除旧骨架 panel,
              // 让新 content script 的 MutationObserver 触发 ensureDataPanel 重建 panel。
              card._ohPanelAttached = false;
              card._ohPanelSkipped = false;
              const oldPanel = card.querySelector('.ozon-helper-data-panel');
              if (oldPanel) oldPanel.remove();
              // 优先用 __jzSubmitCollectTask(含 dedup + config 检查 + DOM 信息提取)
              if (typeof window.__jzSubmitCollectTask === 'function') {
                window.__jzSubmitCollectTask(productId, card, slug, sellerId);
              } else {
                // 兜底:直接发消息到 SW
                try {
                  chrome.runtime.sendMessage({
                    type: 'submitTask',
                    sku: String(productId),
                    sellerSlug: slug,
                    sellerId: sellerId,
                    domInfo: null,
                  });
                } catch (_) {
                  /* ignore */
                }
              }
              count++;
            }
            console.log('[rescan] injected rescan done, submitted', count, 'SKUs');
            return count;
          } catch (e) {
            console.warn('[rescan] injected rescan failed:', e?.message || e);
            return 0;
          }
        };

        const injects = tabs
          .filter((t) => t.id)
          .map(async (t) => {
            try {
              // 1. 重新注入 content scripts
              await chrome.scripting.executeScript({ target: { tabId: t.id }, files: injectFiles });
              // 2. 等待 content script 初始化(读 config、注册 listener 等)
              await new Promise((r) => setTimeout(r, 500));
              // 3. 注入 rescan 脚本
              await chrome.scripting.executeScript({ target: { tabId: t.id }, func: rescanFn });
            } catch (e) {
              console.warn('[rescan] inject failed tab=%d:', t.id, e?.message);
            }
          });
        await Promise.allSettled(injects);
      } catch {
        /* fire-and-forget */
      }
    };

    // 测试专用:暴露队列状态重置函数,供 E2E 测试在场景间清除内存状态
    // (S.completedTodaySkus / S.consuming 无法通过 storage 重置)。
    // IS_TEST_MODE 异步读取,故在函数内部检查;生产模式下不可用。
    const resetQueueState = async () => {
      if (!sw.IS_TEST_MODE) return { ok: false, error: 'not in test mode' };
      S.completedTodaySkus.clear();
      S.consuming = false;
      await chrome.storage.local.set({ [COLLECT_QUEUE_KEY]: [] });
      await chrome.storage.local.set({
        [COLLECT_QUEUE_META_KEY]: {
          ..._COLLECT_QUEUE_META_DEFAULT,
          todayDate: new Date().toLocaleDateString('en-CA'),
        },
      });
      return { ok: true };
    };

    const _fetchProductDataStats = async (sku) => {
      try {
        const backendUrl = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token, sw.STORAGE_KEYS.storeId]);
        const token = stored[sw.STORAGE_KEYS.token];
        const storeId = stored[sw.STORAGE_KEYS.storeId];
        const r = await sw.apiRequest(
          'GET',
          `${backendUrl}/ozon/product-data/${encodeURIComponent(sku)}?skipMarket=1`,
          null,
          token,
          storeId
        );
        return r?.data ?? null;
      } catch (e) {
        console.warn('[Queue] fetch product data stats failed:', e?.message || e);
        return null;
      }
    };

    // 从 bundle item 顶层提取物理字段(weight/depth/width/height/barcode)
    // 并以 sv attr key (4497/9454/9455/9456/7822) 形式返回,与 searchVariants Step2
    // 的 merge 逻辑一致。用于 _getSearchVariantForBroadcast 的 bundle 兜底:
    // 当 search_cache 的 item 缺物理 attrs(因 searchVariants bundle 步骤失败/未跑)
    // 时,从 bundle_cache 顶层字段补齐,让面板重量·尺寸能显示。
    const _extractBundlePhysicalAttrs = (bundleItem) => {
      if (!bundleItem) return [];
      const attrs = [];
      if (Number(bundleItem.weight) > 0) attrs.push({ key: '4497', value: String(bundleItem.weight) });
      if (Number(bundleItem.depth) > 0) attrs.push({ key: '9454', value: String(bundleItem.depth) });
      if (Number(bundleItem.width) > 0) attrs.push({ key: '9455', value: String(bundleItem.width) });
      if (Number(bundleItem.height) > 0) attrs.push({ key: '9456', value: String(bundleItem.height) });
      if (bundleItem.barcode) attrs.push({ key: '7822', value: String(bundleItem.barcode) });
      return attrs;
    };

    // 从 bundle_cache(L1 IDB → L2 ERP)取 bundle item,不要求 attrs 非空
    // (bundle 顶层 weight/depth/width/height 即使 attributes 为空也有效)。
    const _getBundleItemForBroadcast = async (sku) => {
      try {
        const l1 = await this.idbGet(this.IDB_STORES.BUNDLE, sku);
        if (l1?.data) return l1.data;
        const l2 = await this.erpCacheGet('bundle', sku);
        if (l2?.data) return l2.data;
      } catch (e) {
        console.warn('[Queue] get bundle item failed:', e?.message || e);
      }
      return null;
    };

    const _getSearchVariantForBroadcast = async (sku) => {
      try {
        let item = null;
        const l1 = await this.idbGet(this.IDB_STORES.SEARCH, sku);
        if (l1 && Array.isArray(l1.data?.items) && l1.data.items.length > 0) {
          item = l1.data.items[0];
        }
        if (!item) {
          const l2 = await this.erpCacheGet('search', sku);
          if (l2 && Array.isArray(l2.data?.items) && l2.data.items.length > 0) {
            item = l2.data.items[0];
          }
        }
        // search_cache item 缺物理 attrs 时,从 bundle_cache 顶层字段补齐
        // (searchVariants Step2 的 bundle merge 可能因反爬/超时失败,导致 search_cache
        // 里的 item 没被 merge 进 4497/9454-9456,但 bundle_cache 独立写入,仍有数据)
        if (item) {
          const attrKeys = new Set((item.attributes || []).map((a) => String(a.key)));
          const needPhysical = !attrKeys.has('4497') && !attrKeys.has('9454');
          if (needPhysical) {
            const bundleItem = await _getBundleItemForBroadcast(sku);
            const physicalAttrs = _extractBundlePhysicalAttrs(bundleItem);
            if (physicalAttrs.length > 0) {
              item = {
                ...item,
                attributes: [...(item.attributes || []), ...physicalAttrs],
              };
            }
          }
          return item;
        }
        // search_cache 完全未命中:直接用 bundle item(含顶层物理字段 + 完整 attrs)
        // bundle item 顶层有 weight/depth/width/height,但 content 端按 attr key 读,
        // 这里转 sv shape:把顶层物理字段 push 进 attributes
        const bundleItem = await _getBundleItemForBroadcast(sku);
        if (bundleItem) {
          const attributes = Array.isArray(bundleItem.attributes)
            ? bundleItem.attributes
                .map((a) => {
                  const key = String(a.attribute_id || a.key || '');
                  if (!key) return null;
                  const vals = Array.isArray(a.values)
                    ? a.values.filter((v) => v && v.value != null && v.value !== '')
                    : [];
                  if (vals.length === 0) return null;
                  if (vals.length > 1) return { key, collection: vals.map((v) => String(v.value)) };
                  return { key, value: String(vals[0].value) };
                })
                .filter(Boolean)
            : [];
          const existingKeys = new Set(attributes.map((a) => String(a.key)));
          for (const pa of _extractBundlePhysicalAttrs(bundleItem)) {
            if (!existingKeys.has(pa.key)) {
              attributes.push(pa);
              existingKeys.add(pa.key);
            }
          }
          return {
            variant_id: bundleItem.variant_id || sku,
            description_category_id: bundleItem.description_category_id || 0,
            categories: bundleItem.categories || [],
            attributes,
            _bundleItem: bundleItem,
          };
        }
      } catch (e) {
        console.warn('[Queue] get search variant failed:', e?.message || e);
      }
      return null;
    };

    const _buildCollectDoneData = async (sku, collectResult) => {
      const [stats, market, variant, followCount] = await Promise.all([
        _fetchProductDataStats(sku).catch(() => null),
        this.marketStatsCacheGet(sku).catch(() => null),
        _getSearchVariantForBroadcast(sku).catch(() => null),
        this.followSellCacheGet(sku).catch(() => null),
      ]);
      return {
        stats: stats ? { status: 'fulfilled', value: stats } : { status: 'fulfilled', value: null },
        market: market?.data ? { status: 'fulfilled', value: market.data } : { status: 'fulfilled', value: null },
        variant: variant ? { status: 'fulfilled', value: variant } : { status: 'fulfilled', value: null },
        followCount: followCount?.data
          ? { status: 'fulfilled', value: followCount.data }
          : { status: 'fulfilled', value: null },
      };
    };

    // ERP 镜像写入(fire-and-forget,失败仅 warn)
    const _erpQueueInsert = async (task) => {
      const url = await sw.getBackendUrl();
      const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
      const doInsert = async () => {
        await sw.apiRequest('POST', `${url}/admin/api/collect-queue`, task, stored[sw.STORAGE_KEYS.token]);
      };
      try {
        await doInsert();
      } catch (e1) {
        try {
          await new Promise((r) => setTimeout(r, 2000));
          await doInsert();
        } catch (e2) {
          console.warn('[Queue] ERP insert failed after retry:', e2?.message || e2);
        }
      }
    };

    const _erpQueueUpdate = async (task) => {
      const url = await sw.getBackendUrl();
      const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
      const doUpdate = async () => {
        await sw.apiRequest('POST', `${url}/admin/api/collect-queue`, task, stored[sw.STORAGE_KEYS.token]);
      };
      try {
        await doUpdate();
      } catch (e1) {
        try {
          await new Promise((r) => setTimeout(r, 2000));
          await doUpdate();
        } catch (e2) {
          console.warn('[Queue] ERP update failed after retry:', e2?.message || e2);
        }
      }
    };

    const _erpQueueResult = async (sku, result) => {
      const url = await sw.getBackendUrl();
      const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
      const doResult = async () => {
        await sw.apiRequest(
          'POST',
          `${url}/admin/api/collect-queue/${encodeURIComponent(sku)}/result`,
          result,
          stored[sw.STORAGE_KEYS.token]
        );
      };
      try {
        await doResult();
      } catch (e1) {
        try {
          await new Promise((r) => setTimeout(r, 2000));
          await doResult();
        } catch (e2) {
          console.warn('[Queue] ERP result write failed after retry:', e2?.message || e2);
        }
      }
    };

    const _erpQueueDelete = async (sku) => {
      const url = await sw.getBackendUrl();
      const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
      try {
        await sw.apiRequest(
          'DELETE',
          `${url}/admin/api/collect-queue/${encodeURIComponent(sku)}/confirm`,
          null,
          stored[sw.STORAGE_KEYS.token]
        );
      } catch (e) {
        console.warn('[Queue] ERP delete failed:', e?.message || e);
      }
    };

    const _erpGetPendingOps = async () => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const r = await sw.apiRequest('GET', `${url}/admin/api/collect-queue/ops/pending`, null, stored[sw.STORAGE_KEYS.token]);
        // apiRequest 返回 { ok, data },data = { items, count }
        const items = r?.data?.items || r?.items || (Array.isArray(r) ? r : []);
        return items;
      } catch (e) {
        console.warn('[Queue] ERP ops pending failed:', e?.message || e);
        return [];
      }
    };

    const _erpMarkOpProcessed = async (opId) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest(
          'POST',
          `${url}/admin/api/collect-queue/ops/${encodeURIComponent(opId)}/processed`,
          {},
          stored[sw.STORAGE_KEYS.token]
        );
      } catch (e) {
        console.warn('[Queue] ERP mark op processed failed:', e?.message || e);
      }
    };

    const _finalizeTask = async (sku, status, lastError, steps, startedAt, duration, collectResult) => {
      const now = Date.now();
      const task = await _updateQueueTask(sku, {
        status,
        steps,
        lastError,
        finishedAt: now,
      });
      if (!task) return;

      // 先构建广播数据(_buildCollectDoneData),同时用于 ERP 结果存储和 collectDone 广播,
      // 确保 queryErpProductData 返回的数据格式与 collectDone 一致(preFetched 格式)
      const data = await _buildCollectDoneData(sku, collectResult);

      if (collectResult) {
        await _erpQueueResult(sku, {
          status,
          duration,
          steps,
          error: lastError,
          // 存 _buildCollectDoneData 的结果(与 collectDone 广播的 data 一致),
          // 让 queryErpProductData 返回的数据格式与 collectDone 一致,
          // content script 可直接用作 preFetched 回填面板。
          // 注意:字段名必须是 result(ERP 后端 /result 接口和 queryErpProductData 都查 result)
          ...(collectResult.status === 'success' || collectResult.status === 'partial' ? { result: data } : {}),
        });
      }

      await _erpQueueUpdate({ ...task, status, steps, lastError, finishedAt: now });

      await _broadcastCollectDoneV2(sku, task.sellerSlug, status, data, now, duration, steps, lastError);

      if (status === 'success' || status === 'failed_final' || status === 'failed_partial') {
        _addCompletedToday(sku);
      }
    };

    const _handleRetryOrFinal = async (task, result, steps, startedAt, duration, errorType, maxAttempts, backoffMs) => {
      const attempts = (task.attempts || 0) + 1;
      const lastError = {
        type: errorType,
        message: result?.error || errorType,
        step: 'unknown',
        ts: Date.now(),
      };
      if (attempts >= maxAttempts) {
        const finalStatus = errorType === 'partial' ? 'failed_partial' : 'failed_final';
        await _finalizeTask(task.sku, finalStatus, lastError, steps, startedAt, duration, result);
      } else {
        const nextRetryAt = Date.now() + backoffMs;
        const updated = await _updateQueueTask(task.sku, {
          status: 'failed_retry',
          attempts,
          maxAttempts,
          nextRetryAt,
          lastError,
        });
        if (updated) await _erpQueueUpdate(updated);
        _broadcastTaskStatus(task.sku, 'failed_retry', attempts, maxAttempts, nextRetryAt);
      }
    };

    const _handleSkippedTask = async (task, result, steps, startedAt, duration) => {
      const reason = result?.reason || 'skipped';
      if (reason === 'daily-limit') {
        await _saveQueueMeta({ consumePaused: true });
        await _updateQueueTask(task.sku, {
          status: 'pending',
          lastError: { type: 'daily-limit', message: reason, step: 'unknown', ts: Date.now() },
          finishedAt: Date.now(),
        });
        // 广播 collectDone(status='skipped')让 panel 变 ready,避免 AutoScroller 死锁。
        // 注意:任务回 pending(非终态),跨日恢复后会重新消费,但 panel 需要知道
        // "今天不会再处理了"的信号,否则永远卡 loading(isReadyToScroll 死锁)。
        const lastError = { type: 'daily-limit', message: reason, step: 'unknown', ts: Date.now() };
        await _broadcastCollectDoneV2(task.sku, task.sellerSlug, 'skipped', null, Date.now(), duration, steps, lastError);
        return;
      }
      const lastError = { type: 'skipped', message: reason, step: 'unknown', ts: Date.now() };
      await _finalizeTask(task.sku, 'failed_final', lastError, steps, startedAt, duration, result);
    };

    const _checkStaleRunningTasks = async () => {
      await _withQueueLock(async () => {
        const queue = await _loadQueue();
        const now = Date.now();
        let changed = false;
        for (const task of queue) {
          if (task.status === 'running' && task.startedAt && now - task.startedAt > COLLECT_QUEUE_STALE_RUNNING_MS) {
            // 达到 maxAttempts 则置终态,避免无限重试
            const nextAttempts = (task.attempts || 0) + 1;
            const maxAttempts = task.maxAttempts || 3;
            const isFinal = nextAttempts >= maxAttempts;
            task.status = isFinal ? 'failed_final' : 'failed_retry';
            task.attempts = nextAttempts;
            task.nextRetryAt = isFinal ? 0 : now + 30000;
            task.lastError = {
              type: 'timeout',
              message: 'SW killed, task stale',
              step: 'unknown',
              ts: now,
            };
            // 非终态(failed_retry)不应有 finishedAt,仅终态设置
            if (isFinal) {
              task.finishedAt = now;
            }
            changed = true;
            console.warn('[Queue] stale running task reset:', task.sku, '->', task.status);
            // 同步到 ERP(fire-and-forget,不阻塞锁)
            _erpQueueUpdate(task);
          }
        }
        if (changed) {
          await sw.setStorage({ [COLLECT_QUEUE_KEY]: queue });
        }
      });
    };

    const _processQueueOp = async (op) => {
      try {
        switch (op.op) {
          case 'retry': {
            if (!op.sku) return false;
            const task = await _updateQueueTask(op.sku, {
              status: 'pending',
              attempts: 0,
              nextRetryAt: 0,
              lastError: null,
              finishedAt: null,
            });
            if (!task) return false;
            sw.maybeStartConsume();
            return true;
          }
          case 'delete': {
            if (!op.sku) return false;
            await _deleteQueueTask(op.sku);
            return true;
          }
          case 'pause': {
            await _saveQueueMeta({ consumePaused: true });
            return true;
          }
          case 'resume': {
            await _saveQueueMeta({ consumePaused: false });
            sw.maybeStartConsume();
            return true;
          }
          case 'clear': {
            // 仅清除 op 创建时已入队的 pending 任务,避免重复执行误清新任务
            await _clearPendingQueueTasks(op.ts || 0);
            return true;
          }
          case 'rescan': {
            // 不刷新页面重新扫描:清空 SW 状态 + 广播让 content script 重新提交所有可见 SKU
            // 1. 清空已完成集合和本地队列(让 _isTaskQueuedOrCompletedToday 返回 false)
            S.completedTodaySkus.clear();
            await chrome.storage.local.set({ [COLLECT_QUEUE_KEY]: [] });
            // 2. 广播 rescan 消息(content script 收到后清空 dedup + 重置 panel + 重新提交)
            await _broadcastRescan();
            return true;
          }
          default:
            return false;
        }
      } catch (e) {
        console.warn('[Queue] process op failed:', op, e?.message || e);
        return false;
      }
    };

    const _pollOpsPending = async () => {
      const ops = await _erpGetPendingOps();
      if (!Array.isArray(ops) || ops.length === 0) return;
      for (const op of ops) {
        const ok = await _processQueueOp(op);
        if (ok) await _erpMarkOpProcessed(op._id);
      }
    };

    const _startOpsPolling = () => {
      if (S.opsPollTimer) return;
      S.opsPollTimer = setInterval(() => {
        _pollOpsPending().catch((e) => console.warn('[Queue] ops poll error:', e?.message || e));
      }, COLLECT_QUEUE_OPS_POLL_MS);
      _pollOpsPending().catch(() => {});
    };

    const _stopOpsPolling = () => {
      if (S.opsPollTimer) {
        clearInterval(S.opsPollTimer);
        S.opsPollTimer = null;
      }
    };

    const _handleSubmitTask = async ({ sku, sellerSlug, sellerId, domInfo, source }) => {
      if (!sku) return { ok: false, error: 'sku required' };
      const taskSource = source === 'manual' ? 'manual' : 'shop-page';
      const exists = await _isTaskQueuedOrCompletedToday(sku);
      if (exists) return { ok: true, data: { alreadyQueued: true } };

      // 前置缓存检查:8 类缓存全命中 → 直接 success,不入队
      // 避免缓存命中任务占用 15s 队列 slot,且不消耗 daily-limit 配额(修复原 bug)。
      // Gate 0(not-running/paused/daily-limit)的本质是限制真调,缓存命中无需真调,故不需要前置 Gate 0。
      const { allHit, results } = await this._checkAllCachesHit(sku);
      if (allHit) {
        const now = Date.now();
        const collectResult = { status: 'success', results, reason: 'all-cached', totalDuration: 0 };
        const steps = _buildSteps(results);
        _addCompletedToday(sku);
        const data = await _buildCollectDoneData(sku, collectResult);
        await _broadcastCollectDoneV2(sku, sellerSlug || '', 'success', data, now, 0, steps, null);
        console.log('[Queue] cache all hit, skip enqueue:', sku);
        return { ok: true, data: { cacheHit: true } };
      }

      const task = {
        sku,
        sellerSlug: sellerSlug || '',
        sellerId: sellerId || '',
        domInfo: domInfo || null,
        source: taskSource,
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        nextRetryAt: 0,
        lastError: null,
        steps: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      const { isNew } = await _enqueueTask(task);
      if (isNew) {
        _erpQueueInsert(task);
      }
      sw.maybeStartConsume();
      // 队列暂停兜底:_maybeStartConsume 是 fire-and-forget,可能被 _consuming 拦截,
      // 或 _consumeOne 设置 consumePaused 的时机晚于此处检查。
      // 直接检查暂停条件(daily-limit/not-running/paused/熔断),如果满足则广播 queuePaused,
      // 让新入队任务的 panel 设 ready 避免 AutoScroller 死锁。
      // 注意:source='manual' 时绕过 autoCollectRunning 检查(深度采集管理页独立运行),
      // 但仍受 daily-limit/paused/熔断限制(避免超额和反爬风险)。
      const _meta = await _loadQueueMeta();
      const _cfg = await sw.loadAutoCollectConfig();
      const _shouldPause =
        _meta.consumePaused ||
        (taskSource !== 'manual' && !_cfg.autoCollectRunning) ||
        (_cfg.paused && Date.now() < _cfg.pausedUntil) ||
        _meta.todayCount >= _cfg.perDayLimit ||
        Date.now() < _meta.circuitBreakerUntil; // 熔断期也需广播,否则 panel 卡 loading
      if (_shouldPause) {
        const _pauseReason = Date.now() < _meta.circuitBreakerUntil ? 'antibot' : 'paused';
        await _broadcastQueuePaused(_pauseReason);
      }
      return { ok: true, data: { queued: isNew, alreadyQueued: !isNew } };
    };

    const setupCollectQueueAlarm = () => {
      chrome.alarms.create(COLLECT_QUEUE_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: COLLECT_QUEUE_ALARM_MINUTES,
      });
    };

    // ── 暴露常量 ──
    this.COLLECT_QUEUE_KEY = COLLECT_QUEUE_KEY;
    this.COLLECT_QUEUE_META_KEY = COLLECT_QUEUE_META_KEY;
    this.COLLECT_QUEUE_ALARM = COLLECT_QUEUE_ALARM;
    this.COLLECT_QUEUE_ALARM_MINUTES = COLLECT_QUEUE_ALARM_MINUTES;
    this.COLLECT_QUEUE_OPS_POLL_MS = COLLECT_QUEUE_OPS_POLL_MS;
    this.COLLECT_QUEUE_MAX_COMPLETED = COLLECT_QUEUE_MAX_COMPLETED;
    this.COLLECT_QUEUE_STALE_RUNNING_MS = COLLECT_QUEUE_STALE_RUNNING_MS;
    this._COLLECT_QUEUE_META_DEFAULT = _COLLECT_QUEUE_META_DEFAULT;

    // ── 暴露函数(保留原 _ 前缀,SW 中用 const _xxx = (...) => __jzCollect._xxx(...) 委托) ──
    this._withQueueLock = _withQueueLock;
    this._loadQueue = _loadQueue;
    this._loadQueueMeta = _loadQueueMeta;
    this._saveQueueMeta = _saveQueueMeta;
    this._enqueueTask = _enqueueTask;
    this._updateQueueTask = _updateQueueTask;
    this._deleteQueueTask = _deleteQueueTask;
    this._clearPendingQueueTasks = _clearPendingQueueTasks;
    this._getNextPending = _getNextPending;
    this._addCompletedToday = _addCompletedToday;
    this._isTaskQueuedOrCompletedToday = _isTaskQueuedOrCompletedToday;
    this._initCompletedTodaySet = _initCompletedTodaySet;
    this._buildSteps = _buildSteps;
    this._retryBackoffMs = _retryBackoffMs;
    this._cleanupCompletedTasksLocked = _cleanupCompletedTasksLocked;
    this._syncConsumeRateFromConfig = _syncConsumeRateFromConfig;
    this._isCircuitBreakerActive = _isCircuitBreakerActive;
    this._broadcastQueueStatus = _broadcastQueueStatus;
    this._broadcastTaskStatus = _broadcastTaskStatus;
    this._broadcastToCollectManagers = _broadcastToCollectManagers;
    this._broadcastCollectDoneV2 = _broadcastCollectDoneV2;
    this._broadcastQueuePaused = _broadcastQueuePaused;
    this._broadcastQueueResumed = _broadcastQueueResumed;
    this._broadcastRescan = _broadcastRescan;
    this._erpQueueInsert = _erpQueueInsert;
    this._erpQueueUpdate = _erpQueueUpdate;
    this._erpQueueResult = _erpQueueResult;
    this._erpQueueDelete = _erpQueueDelete;
    this._erpGetPendingOps = _erpGetPendingOps;
    this._erpMarkOpProcessed = _erpMarkOpProcessed;
    this._fetchProductDataStats = _fetchProductDataStats;
    this._extractBundlePhysicalAttrs = _extractBundlePhysicalAttrs;
    this._getBundleItemForBroadcast = _getBundleItemForBroadcast;
    this._getSearchVariantForBroadcast = _getSearchVariantForBroadcast;
    this._buildCollectDoneData = _buildCollectDoneData;
    this._finalizeTask = _finalizeTask;
    this._handleRetryOrFinal = _handleRetryOrFinal;
    this._handleSkippedTask = _handleSkippedTask;
    this._checkStaleRunningTasks = _checkStaleRunningTasks;
    this._processQueueOp = _processQueueOp;
    this._pollOpsPending = _pollOpsPending;
    this._startOpsPolling = _startOpsPolling;
    this._stopOpsPolling = _stopOpsPolling;
    this._handleSubmitTask = _handleSubmitTask;
    this.setupCollectQueueAlarm = setupCollectQueueAlarm;
    this.resetQueueState = resetQueueState;
  };
})();
