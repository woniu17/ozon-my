/* =========================================================
 * MY 深度采集管理页面
 *
 * 数据流:
 *   页面 ──sendMessage──→ SW ──HTTP──→ ERP
 *                          │
 *                          ←─broadcast── (collectDone/taskStatus)
 *   页面 ←─onMessage──────────┘
 *
 * 雏形阶段:不改 SW 深度采集逻辑,复用现有 submitTask/queuePaused/collectDone
 * ========================================================= */
(() => {
  'use strict';

  // ─── DOM refs ───
  const $ = (id) => document.getElementById(id);
  const swDot = $('sw-dot');
  const swText = $('sw-text');
  const storeSelect = $('store-select');
  const storeCount = $('store-count');
  const btnLoadSkus = $('btn-load-skus');
  const btnRefresh = $('btn-refresh');
  const btnStart = $('btn-start');
  const btnPause = $('btn-pause');
  const filterCard = $('filter-card');
  const filterStat = $('filter-stat');
  const btnResetFilter = $('btn-reset-filter');
  const progressCard = $('progress-card');
  const progressBar = $('progress-bar');
  const progressStat = $('progress-stat');
  const progressSuccess = $('progress-success');
  const progressFailed = $('progress-failed');
  const runningList = $('running-list');
  const tableCard = $('table-card');
  const skuCount = $('sku-count');
  const skuTbody = $('sku-tbody');
  const emptyHint = $('empty-hint');
  const authNotice = $('auth-notice');
  const authNoticeText = $('auth-notice-text');

  // filter inputs
  const fChinese = $('f-chinese');
  const fRatingMin = $('f-rating-min');
  const fPriceMin = $('f-price-min');
  const fPriceMax = $('f-price-max');
  const fWeightMin = $('f-weight-min');
  const fWeightMax = $('f-weight-max');
  const fStatus = $('f-status');

  // ─── State ───
  /** @type {Array<{ sku: string, sellerId: string, sellerSlug: string, sellerName: string, card: any, status: string, cacheHits?: any }>} */
  let allSkus = [];
  /** @type {Map<string, { status: string, results?: any }>} SKU -> 状态 */
  const statusMap = new Map();
  /** @type {Set<string>} 已提交采集的 SKU(用于进度统计) */
  const submittedSkus = new Set();

  // 7 类缓存固定展示顺序(与数据面板 ozon-data-panel.js _CACHE_TYPE_LABELS 对齐)
  const CACHE_TYPE_LABELS = ['card', 'detail', 'pdp', 'search', 'bundle', 'marketStats', 'followSell'];
  let currentStoreSlug = '';
  let isCollecting = false;

  // ─── Generic helpers ───
  // 非扩展环境(http 测试 / chrome.runtime 缺失)下优雅降级,不抛错
  const hasRuntime = typeof chrome !== 'undefined' && !!chrome.runtime;
  const sendMessage = (payload) =>
    new Promise((resolve) => {
      if (!hasRuntime) {
        resolve({ ok: false, error: 'chrome.runtime unavailable (not extension context)' });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, resolve);
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });

  const showNotice = (text) => {
    authNoticeText.textContent = text;
    authNotice.style.display = 'block';
  };
  const hideNotice = () => {
    authNotice.style.display = 'none';
  };

  // ─── SW 连接检测 ───
  const checkSwConnection = async () => {
    try {
      const resp = await sendMessage({ action: 'autoCollectGetConfig' });
      if (resp?.ok) {
        swDot.parentElement.classList.add('is-on');
        swDot.parentElement.classList.remove('is-off');
        swText.textContent = 'SW 已连接';
        return true;
      }
      swDot.parentElement.classList.add('is-off');
      swDot.parentElement.classList.remove('is-on');
      swText.textContent = 'SW 未响应';
      return false;
    } catch {
      swDot.parentElement.classList.add('is-off');
      swText.textContent = 'SW 连接失败';
      return false;
    }
  };

  // ─── 店铺列表加载 ───
  const loadStores = async () => {
    storeSelect.innerHTML = '<option value="">加载中…</option>';
    btnLoadSkus.disabled = true;
    try {
      const resp = await sendMessage({ action: 'getCollectStores' });
      const data = resp?.ok ? resp.data : null;
      const items = data?.items || [];
      storeCount.textContent = String(items.length);
      if (!items.length) {
        storeSelect.innerHTML = '<option value="">暂无已分类店铺,请先在店铺页开启自动采集</option>';
        return;
      }
      storeSelect.innerHTML =
        '<option value="">请选择店铺…</option>' +
        items
          .map(
            (s) =>
              `<option value="${escapeHtml(s.sellerSlug)}">${escapeHtml(s.sellerName || s.sellerSlug)}${
                s.isChinese ? ' 🇨🇳' : ''
              }</option>`
          )
          .join('');
    } catch (e) {
      storeSelect.innerHTML = '<option value="">加载失败</option>';
      showNotice('店铺列表加载失败: ' + (e?.message || String(e)));
    }
  };

  // ─── 商品队列加载 ───
  const loadSkus = async () => {
    const slug = storeSelect.value;
    if (!slug) return;
    currentStoreSlug = slug;
    btnLoadSkus.disabled = true;
    btnLoadSkus.textContent = '加载中…';
    emptyHint.style.display = 'none';
    try {
      const resp = await sendMessage({ action: 'getStoreSkuList', slug });
      const data = resp?.ok ? resp.data : null;
      const items = data?.items || [];
      allSkus = items.map((it) => ({
        sku: String(it.sku),
        sellerId: it.sellerId || '',
        sellerSlug: it.sellerSlug || slug,
        sellerName: it.sellerName || '',
        card: it.card || null,
        status: 'pending',
        cacheHits: null,
      }));
      // 并行查缓存命中状态(用于展示 7 类缓存命中情况)
      await refreshCacheHits();
      renderTable();
      filterCard.style.display = 'block';
      tableCard.style.display = 'block';
      btnStart.disabled = false;
      // 启动定时刷新
      startStatePolling();
    } catch (e) {
      showNotice('商品队列加载失败: ' + (e?.message || String(e)));
      allSkus = [];
    } finally {
      btnLoadSkus.disabled = false;
      btnLoadSkus.textContent = '加载商品队列';
    }
  };

  // ─── 缓存命中查询(批量) ───
  const refreshCacheHits = async () => {
    if (!allSkus.length) return;
    try {
      // 一次批量查所有 SKU 的缓存状态(取代旧的逐个 sendMessage + BATCH=6 并发)
      const resp = await sendMessage({
        action: 'queryCacheStatusBatch',
        skus: allSkus.map((i) => i.sku),
      });
      const batch = resp?.ok ? resp.data || {} : {};
      for (const item of allSkus) {
        const data = batch[item.sku];
        if (data) {
          item.cacheHits = data;
          // 根据 cacheHits 推断初始状态:8 类全命中 = success
          if (item.status === 'pending' && data.hitCount === data.total) {
            item.status = 'success';
            statusMap.set(item.sku, { status: 'success', results: data.results });
          }
        }
      }
    } catch {
      /* ignore */
    }
  };

  // ─── 渲染表格 ───
  const renderTable = () => {
    const filtered = applyFilters(allSkus);
    filterStat.textContent = `${filtered.length} / ${allSkus.length}`;
    skuCount.textContent = String(filtered.length);

    if (!filtered.length) {
      skuTbody.innerHTML =
        '<tr><td colspan="10" style="text-align:center;color:#86909c;padding:24px">无符合条件的商品</td></tr>';
      return;
    }

    skuTbody.innerHTML = filtered
      .map((item) => {
        const status = item.status || 'pending';
        const card = item.card || {};
        const img = card.image
          ? `<img class="cell-img" src="${escapeHtml(card.image)}" alt="" loading="lazy" onerror="this.style.opacity=0.2">`
          : '<div class="cell-img"></div>';
        const rating = card.ratingCount != null ? String(card.ratingCount) : '-';
        const price = card.price != null ? formatPrice(card.price) : '-';
        const weight = item.weightText || '-';
        const dim = item.dimText || '-';
        const chinese = renderChinese(item.isChinese);
        const statusBadge = renderStatusBadge(status);
        const cacheStatus = renderCacheStatus(item.cacheHits);
        const finishTime = formatFinishedAt(item.finishedAt);
        const runningClass = status === 'running' ? ' is-running' : '';

        return `<tr class="sku-row${runningClass}" data-sku="${escapeHtml(item.sku)}">
          <td class="c-img">${img}</td>
          <td class="c-sku"><span class="cell-sku">${escapeHtml(item.sku)}</span></td>
          <td class="cell-mono">${rating}</td>
          <td class="cell-mono">${price}</td>
          <td class="${weight === '-' ? 'cell-empty' : 'cell-mono'}">${weight}</td>
          <td class="${dim === '-' ? 'cell-empty' : 'cell-mono'}">${dim}</td>
          <td class="c-chinese">${chinese}</td>
          <td class="c-status">${statusBadge}</td>
          <td class="${finishTime === '-' ? 'cell-empty' : 'cell-mono c-finish-cell'}">${finishTime}</td>
          <td class="c-detail">${cacheStatus}</td>
        </tr>`;
      })
      .join('');
  };

  // ─── 筛选 ───
  const applyFilters = (list) => {
    const chineseFilter = fChinese.value;
    const ratingMin = fRatingMin.value ? Number(fRatingMin.value) : 0;
    const priceMin = fPriceMin.value ? Number(fPriceMin.value) : null;
    const priceMax = fPriceMax.value ? Number(fPriceMax.value) : null;
    const weightMin = fWeightMin.value ? Number(fWeightMin.value) : null;
    const weightMax = fWeightMax.value ? Number(fWeightMax.value) : null;
    const statusFilter = fStatus.value;

    return list.filter((item) => {
      const card = item.card || {};
      // 中国店铺:需查 store-classification,雏形阶段先标 unknown
      if (chineseFilter === 'yes' && !item.isChinese) return false;
      if (chineseFilter === 'no' && item.isChinese) return false;
      // 评论数
      const rating = card.ratingCount ?? 0;
      if (rating < ratingMin) return false;
      // 价格
      const price = card.price != null ? Number(card.price) : null;
      if (priceMin != null && (price == null || price < priceMin)) return false;
      if (priceMax != null && (price == null || price > priceMax)) return false;
      // 重量(仅已采集的有值)
      const weight = item.weightG ?? null;
      if (weightMin != null && (weight == null || weight < weightMin)) return false;
      if (weightMax != null && (weight == null || weight > weightMax)) return false;
      // 状态
      if (statusFilter && item.status !== statusFilter) return false;
      return true;
    });
  };

  // ─── 渲染辅助 ───
  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const formatPrice = (p) => {
    const n = Number(p);
    if (isNaN(n)) return '-';
    return '₽' + n.toLocaleString('ru-RU');
  };

  // 格式化完成时间:HH:mm:ss(同天显示时分秒,跨天显示 MM-DD HH:mm)
  const formatFinishedAt = (ts) => {
    if (!ts || typeof ts !== 'number') return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const hhmmss = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (d.toDateString() === now.toDateString()) return hhmmss;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmmss}`;
  };

  const renderStatusBadge = (status) => {
    const map = {
      pending: { cls: 'status-pending', text: '待采集' },
      failed_retry: { cls: 'status-pending', text: '重试中' },
      running: { cls: 'status-running', text: '采集中' },
      success: { cls: 'status-success', text: '成功' },
      partial: { cls: 'status-partial', text: '部分' },
      failed_final: { cls: 'status-failed', text: '失败' },
      failed_partial: { cls: 'status-partial', text: '部分失败' },
      failed: { cls: 'status-failed', text: '失败' },
      skipped: { cls: 'status-skipped', text: '跳过' },
    };
    const m = map[status] || map.pending;
    return `<span class="status-badge ${m.cls}">${m.text}</span>`;
  };

  // 渲染缓存状态(参考数据面板 renderCollectStatusBar 的 3 行结构)
  // 行1:汇总(图标+文字+N/7) 行2/3:7 类缓存明细(3 列 grid,hit 绿色✓ / miss 灰色✗)
  const renderCacheStatus = (cacheHits) => {
    // 按 CACHE_TYPE_LABELS 固定顺序补齐,无数据时全 miss 占位
    const results =
      cacheHits && Array.isArray(cacheHits.results) && cacheHits.results.length > 0
        ? CACHE_TYPE_LABELS.map((type) => cacheHits.results.find((r) => r.type === type) || { type, hit: false })
        : CACHE_TYPE_LABELS.map((type) => ({ type, hit: false }));
    const hitCount = results.filter((r) => r.hit).length;
    const total = results.length;

    // 行1 汇总:全命中 ✓ 缓存完整(绿);部分命中 ◐ 缓存部分(橙);全未命中 ○ 无缓存(灰)
    let icon, color, text;
    if (hitCount === 0) {
      icon = '○';
      color = '#94a3b8';
      text = '无缓存';
    } else if (hitCount === total) {
      icon = '✓';
      color = '#16a34a';
      text = '缓存完整';
    } else {
      icon = '◐';
      color = '#f59e0b';
      text = '缓存部分';
    }
    const renderItem = (r) => `<span class="cache-${r.hit ? 'hit' : 'miss'}">${r.type}${r.hit ? '✓' : '✗'}</span>`;
    // 3 列 grid 对齐:每个 grid cell 放一个缓存项(7 项 + 2 空格 = 9 cell)
    const detailCells = results.map(renderItem).join('');
    return (
      `<div class="cache-status">` +
      `<div class="cache-row cache-row-1">` +
      `<span class="cache-icon" style="color:${color}">${icon}</span>` +
      `<span class="cache-text" style="color:${color}">${text}</span>` +
      `<span class="cache-summary"> · ${hitCount}/${total}</span>` +
      `</div>` +
      `<div class="cache-row-detail">${detailCells}</div>` +
      `</div>`
    );
  };

  const renderChinese = (isChinese) => {
    if (isChinese === true) return '<span class="cn-yes">是</span>';
    if (isChinese === false) return '<span class="cn-no">否</span>';
    return '<span class="cn-unknown">未知</span>';
  };

  // ─── 开始采集 ───
  // 直接采集当前队列里的所有商品(经筛选后的 allSkus),无需勾选
  const startCollect = async () => {
    const skus = applyFilters(allSkus).map((x) => x.sku);
    if (!skus.length) return;
    btnStart.disabled = true;
    isCollecting = true;
    btnPause.style.display = 'inline-flex';
    progressCard.style.display = 'block';

    // 标记为已提交
    for (const sku of skus) {
      submittedSkus.add(sku);
      // 更新状态为 pending(若未在采集)
      if (!statusMap.has(sku)) {
        statusMap.set(sku, { status: 'pending' });
      }
    }

    // 逐个提交任务(串行,避免瞬间涌入)
    // source='manual' 让 SW Gate 0 绕过 autoCollectRunning 检查(深度采集独立运行)
    for (const sku of skus) {
      const item = allSkus.find((x) => x.sku === sku);
      if (!item) continue;
      try {
        await sendMessage({
          action: 'submitTask',
          sku,
          sellerSlug: item.sellerSlug,
          sellerId: item.sellerId,
          domInfo: null,
          source: 'manual',
        });
        item.status = 'pending';
      } catch (e) {
        console.warn('[startCollect] submit failed:', sku, e);
        item.status = 'failed';
        statusMap.set(sku, { status: 'failed', error: e?.message });
      }
    }

    renderTable();
    updateProgress();
    btnStart.disabled = false;
  };

  // ─── 进度更新 ───
  const updateProgress = async () => {
    if (!submittedSkus.size) return;
    // 拉取 SW 队列状态(含每个 SKU 的 status/finishedAt)
    try {
      const resp = await sendMessage({ action: 'getCollectManagerState' });
      if (resp?.ok && resp.data) {
        const d = resp.data;
        const total = submittedSkus.size;
        const running = d.runningSkus || [];
        const tasks = Array.isArray(d.tasks) ? d.tasks : [];
        // 终态判定:success / failed_final / failed_partial / skipped
        const TERMINAL_STATUSES = ['success', 'failed_final', 'failed_partial', 'skipped'];
        // 用 tasks 数组更新每个 SKU 的状态和完成时间(tasks 来自 SW 队列,权威)
        const taskMap = new Map(tasks.map((t) => [String(t.sku), t]));
        // 先批量查出"之前 running 但现已不在队列"的 SKU 的 ERP 终态
        // (旧实现逐个 sendMessage 循环查,N 个 SKU = N 次消息;批量一次搞定)
        const needErpCheck = allSkus.filter((item) => {
          const t = taskMap.get(item.sku);
          return !t && !running.includes(item.sku) && item.status === 'running';
        });
        let erpBatch = {};
        if (needErpCheck.length) {
          try {
            const erpResp = await sendMessage({
              action: 'queryErpProductDataBatch',
              skus: needErpCheck.map((i) => i.sku),
            });
            erpBatch = erpResp?.ok ? erpResp.data || {} : {};
          } catch {
            /* ignore */
          }
        }
        for (const item of allSkus) {
          const t = taskMap.get(item.sku);
          if (t) {
            item.status = t.status;
            item.finishedAt = t.finishedAt || null;
            item.startedAt = t.startedAt || null;
            statusMap.set(item.sku, {
              status: t.status,
              finishedAt: item.finishedAt,
              results: item.cacheHits?.results,
            });
          } else if (running.includes(item.sku)) {
            item.status = 'running';
            statusMap.set(item.sku, { status: 'running' });
          } else if (item.status === 'running') {
            // 之前 running,现在不在队列中:用批量预查结果判定终态
            const erpData = erpBatch[item.sku];
            if (erpData?.preFetched) {
              item.status = 'success';
              item.finishedAt = Date.now();
              statusMap.set(item.sku, { status: 'success', finishedAt: item.finishedAt });
            }
          }
        }
        // 进度统计:分子=本次提交中已到终态的数量,分母=本次提交总数
        let finishedCount = 0;
        let successCount = 0;
        let failedCount = 0;
        for (const sku of submittedSkus) {
          const st = statusMap.get(sku)?.status;
          if (TERMINAL_STATUSES.includes(st)) {
            finishedCount++;
            if (st === 'success' || st === 'skipped') successCount++;
            else failedCount++;
          }
        }
        const progressPercent = total > 0 ? Math.min(100, (finishedCount / total) * 100) : 0;
        progressBar.style.width = progressPercent + '%';
        progressStat.textContent = `${finishedCount} / ${total}`;
        runningList.textContent = running.length ? running.join(', ') : '—';
        progressSuccess.style.display = successCount ? 'inline-flex' : 'none';
        progressSuccess.textContent = `成功 ${successCount}`;
        progressFailed.style.display = failedCount ? 'inline-flex' : 'none';
        progressFailed.textContent = `失败 ${failedCount}`;
        // 统一处理暂停 notice(以 SW 权威状态为准,不依赖广播)
        const now = Date.now();
        if (Date.now() < (d.circuitBreakerUntil || 0)) {
          const remainSec = Math.ceil(((d.circuitBreakerUntil || 0) - now) / 1000);
          showNotice(`检测到反爬熔断,采集将暂停 ${remainSec} 秒`);
        } else if (d.todayCount >= d.perDayLimit) {
          showNotice(`已达每日上限(${d.perDayLimit}),次日自动恢复`);
        } else {
          hideNotice();
        }
        renderTable();
      }
    } catch {
      /* ignore */
    }
  };

  // ─── 定时轮询 ───
  let pollTimer = null;
  const startStatePolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (isCollecting || submittedSkus.size > 0) {
        updateProgress();
      }
    }, 5000);
  };

  // ─── 广播订阅 ───
  // 非扩展环境下跳过(chrome.runtime.onMessage 不存在)
  if (hasRuntime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return;
      const type = message.type || message;
      if (type === 'collectDone') {
        const sku = String(message.sku || '');
        const status = message.status || 'success';
        // collectDone 携带 collectedAt(完成时间戳)
        const finishedAt = message.collectedAt || Date.now();
        if (sku && submittedSkus.has(sku)) {
          statusMap.set(sku, { status, finishedAt, results: message.results });
          const item = allSkus.find((x) => x.sku === sku);
          if (item) {
            item.status = status;
            item.finishedAt = finishedAt;
          }
          updateProgress();
        }
      } else if (type === 'taskStatus') {
        const sku = String(message.sku || '');
        const status = message.status || 'pending';
        if (sku && submittedSkus.has(sku)) {
          statusMap.set(sku, { status });
          const item = allSkus.find((x) => x.sku === sku);
          if (item) item.status = status;
          renderTable();
        }
      }
      // 不阻塞
      if (sendResponse) sendResponse({ ok: true });
    });
  }

  // ─── 事件绑定 ───
  btnRefresh.addEventListener('click', loadStores);
  storeSelect.addEventListener('change', () => {
    btnLoadSkus.disabled = !storeSelect.value;
  });
  btnLoadSkus.addEventListener('click', loadSkus);
  btnStart.addEventListener('click', startCollect);

  // 筛选实时生效
  [fChinese, fRatingMin, fPriceMin, fPriceMax, fWeightMin, fWeightMax, fStatus].forEach((el) => {
    el.addEventListener('change', renderTable);
    el.addEventListener('input', renderTable);
  });
  btnResetFilter.addEventListener('click', () => {
    fChinese.value = '';
    fRatingMin.value = '';
    fPriceMin.value = '';
    fPriceMax.value = '';
    fWeightMin.value = '';
    fWeightMax.value = '';
    fStatus.value = '';
    renderTable();
  });

  // ─── 初始化 ───
  (async () => {
    const ok = await checkSwConnection();
    if (!ok) {
      showNotice('无法连接 Service Worker,请确认插件已加载且未崩溃');
      return;
    }
    // 注册 tabId 到 SW,让 SW 广播 collectDone/queuePaused/queueResumed 时同步发给本 tab
    if (hasRuntime) {
      try {
        await sendMessage({ action: 'registerCollectManager' });
      } catch {
        /* ignore */
      }
      // beforeunload 主动注销(避免 SW 向已关闭 tab 发消息报错)
      window.addEventListener('beforeunload', () => {
        try {
          chrome.runtime.sendMessage({ action: 'unregisterCollectManager' });
        } catch {
          /* ignore */
        }
      });
    }
    await loadStores();
  })();
})();
