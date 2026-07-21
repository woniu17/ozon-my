/* =========================================================
 * 采集配置层(采集代码隔离 Phase 3)
 *
 * 从 service-worker.js 提取的配置相关代码,采用 init 桥接模式:
 *   - 注册 globalThis.__jzCollect.setupConfig 函数
 *   - 由 __jzCollect.init() 在 IIFE 工具函数就绪后调用
 *   - 通过 this._sw 访问 SW 工具(getStorage/setStorage)
 *   - 通过 this.state.xxx 访问采集运行时状态
 *
 * 覆盖范围:
 *   - jz-auto-collect-config 键的读写(L1 内存缓存 + L2 chrome.storage.local)
 *   - chrome.storage.onChanged 监听器(外部修改时自动 invalidate 内存缓存)
 *   - autoCollectRecent 环形缓冲(最近 200 条采集记录,供面板查询)
 *
 * 注意:_completedTodaySkus / _addCompletedToday / _isTaskQueuedOrCompletedToday /
 *      _initCompletedTodaySet 因依赖 _loadQueue(队列层),暂留在 service-worker.js,
 *      待 Phase 3 队列层迁移时统一处理。
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupConfig = function () {
    const sw = this._sw;
    const S = this.state;

    // ── 常量 ──────────────────────────────────────────────────────────────────
    const _AUTO_COLLECT_CONFIG_KEY = 'jz-auto-collect-config';
    const _AUTO_COLLECT_CONFIG_DEFAULT = {
      enabled: true,
      autoCollectRunning: true,        // 深度采集开关(SW 队列真调 Step4/5/6)
      shallowCollectRunning: true,     // 浅度采集开关(content script DOM 写 card/detail + submitTask 入口)
      depth: 'Full',
      paused: false,
      pausedUntil: 0,
      buyerPageMinInterval: 5000,
      sellerPortalMinInterval: 200,
      skuInterval: 30000,
      consumeRateSec: 15,              // 旧字段(固定值),保留作为 fallback
      consumeRateMinSec: 5,            // 新字段:队列消费间隔范围(秒),每次随机
      consumeRateMaxSec: 15,           // 新字段:队列消费间隔范围(秒),每次随机
      perDayLimit: 2000,
      todayCount: 0,
      todayDate: '',
      marketStatsStaleMs: 86400000,
      followSellStaleMs: 14400000,
      onlyChineseStores: true,
      knownChineseSlugs: [],
      knownNonChineseSlugs: [],
    };

    // ── 配置读取(带内存缓存) ──────────────────────────────────────────────────
    // 首次读取后缓存到 S.autoCollectConfigCache,写入时通过
    // invalidateAutoCollectConfigCache() 失效。SW 休眠后内存清空,下次读取重新落盘。
    // 默认值与 popup/content 端约定一致,缺失字段用默认补齐(浅合并)。
    const _loadAutoCollectConfig = async () => {
      if (S.autoCollectConfigCache) return S.autoCollectConfigCache;
      try {
        const stored = await sw.getStorage([_AUTO_COLLECT_CONFIG_KEY]);
        const raw = stored?.[_AUTO_COLLECT_CONFIG_KEY];
        const merged =
          raw && typeof raw === 'object'
            ? { ..._AUTO_COLLECT_CONFIG_DEFAULT, ...raw }
            : { ..._AUTO_COLLECT_CONFIG_DEFAULT };
        // v2:consumeRateSec 取代 skuInterval,旧配置迁移(秒,限制 5-120)。
        // 注意:defaults 已含 consumeRateSec,所以需用 raw 原始字段判断是否存在旧 skuInterval。
        const _rawSec = raw?.consumeRateSec;
        const _rawMs = raw?.skuInterval;
        if (_rawSec != null) {
          merged.consumeRateSec = Math.max(5, Math.min(120, Math.round(_rawSec)));
        } else if (_rawMs != null) {
          merged.consumeRateSec = Math.max(5, Math.min(120, Math.round(_rawMs / 1000)));
        }
        // v3:consumeRateMinSec/consumeRateMaxSec 取代 consumeRateSec,支持范围随机。
        // 迁移策略:
        //   - 若 raw 已含 min/max 字段 → 直接 clamp 规整
        //   - 若 raw 仅含 consumeRateSec(旧版) → min = max = consumeRateSec(固定值兼容)
        //   - 若 raw 都没有 → 用 defaults 的 5/15
        const _rawMin = raw?.consumeRateMinSec;
        const _rawMax = raw?.consumeRateMaxSec;
        if (_rawMin != null && _rawMax != null) {
          let _lo = Math.max(5, Math.min(120, Math.round(_rawMin)));
          let _hi = Math.max(5, Math.min(120, Math.round(_rawMax)));
          if (_lo > _hi) { const _t = _lo; _lo = _hi; _hi = _t; }
          merged.consumeRateMinSec = _lo;
          merged.consumeRateMaxSec = _hi;
        } else if (_rawSec != null || _rawMs != null) {
          // 旧版仅有 consumeRateSec:迁移为 min = max = consumeRateSec
          merged.consumeRateMinSec = merged.consumeRateSec;
          merged.consumeRateMaxSec = merged.consumeRateSec;
        }
        // defaults 已含 5/15,无需再补
        S.autoCollectConfigCache = merged;
      } catch (e) {
        console.warn('[autoCollectConfig] load failed, fallback to defaults:', e?.message || e);
        S.autoCollectConfigCache = { ..._AUTO_COLLECT_CONFIG_DEFAULT };
      }
      return S.autoCollectConfigCache;
    };

    // 写入 jz-auto-collect-config 后调用,清内存缓存让下次 loadAutoCollectConfig 重读落盘。
    const _invalidateAutoCollectConfigCache = () => {
      S.autoCollectConfigCache = null;
    };

    // ── 配置保存(对应 loadAutoCollectConfig 的写入端) ─────────────────────────
    // 浅合并 partial 到当前配置,写 chrome.storage.local(jz-auto-collect-config),
    // 并调 invalidateAutoCollectConfigCache 失效内存缓存让下次读取重落盘。
    const _saveAutoCollectConfig = async (partial) => {
      const current = await _loadAutoCollectConfig();
      const updated = { ...current, ...partial };
      await sw.setStorage({ [_AUTO_COLLECT_CONFIG_KEY]: updated });
      _invalidateAutoCollectConfigCache();
      return updated;
    };

    // 监听 chrome.storage.local 变化:外部(如测试脚本、popup 直写)修改
    // jz-auto-collect-config 时自动 invalidate 内存缓存,避免读到过期值。
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[_AUTO_COLLECT_CONFIG_KEY]) {
        _invalidateAutoCollectConfigCache();
      }
    });

    // ── autoCollect 环形缓冲(最近 200 条,供面板查询采集状态) ──────────────────
    // SW 休眠后清零(非持久化)。持久化统计走 writeAutoCollectLog(ERP)。
    // 缓冲数组复用 S.autoCollectRecent,确保跨 setup 函数共享同一份数据。
    const _pushAutoCollectRecent = (sku, status, source, storeClassified, results, startTime, reason) => {
      const entry = {
        sku,
        source,
        status,
        reason: reason || null,
        results: Array.isArray(results) ? results.map((r) => ({ type: r.type, hit: !!r.hit })) : null,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
      S.autoCollectRecent.push(entry);
      if (S.autoCollectRecent.length > 200) S.autoCollectRecent.shift();
    };

    // 读取最近 N 条(倒序,默认 5 条),供 popup/content 查询采集状态。
    const _getAutoCollectRecent = (limit = 5) => S.autoCollectRecent.slice(-limit).reverse();

    // ── 暴露给外部 ──
    this.AUTO_COLLECT_CONFIG_KEY = _AUTO_COLLECT_CONFIG_KEY;
    this.AUTO_COLLECT_CONFIG_DEFAULT = _AUTO_COLLECT_CONFIG_DEFAULT;
    this.loadAutoCollectConfig = _loadAutoCollectConfig;
    this.saveAutoCollectConfig = _saveAutoCollectConfig;
    this.invalidateAutoCollectConfigCache = _invalidateAutoCollectConfigCache;
    this.pushAutoCollectRecent = _pushAutoCollectRecent;
    this.getAutoCollectRecent = _getAutoCollectRecent;
  };
})();
