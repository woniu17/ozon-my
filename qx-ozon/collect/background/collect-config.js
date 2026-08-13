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
      consumeRateMinSec: 5,            // 队列消费间隔范围(秒),每次随机
      consumeRateMaxSec: 15,           // 队列消费间隔范围(秒),每次随机
      antibotPauseMin: 10,             // 反爬熔断时长(分钟),范围 [1, 120]
      // perDayLimit/todayCount/todayDate 已移除(去掉每日上限)
      // marketStatsStaleMs/followSellStaleMs 已移除(stale 策略改为永久)
      onlyMainlandChinaStores: true,
      // 2026-08:店铺白/黑名单改用 sellerId(稳定主键),不再用 slug
      knownMainlandChinaSellerIds: [],
      knownNonMainlandChinaSellerIds: [],
      // 深度采集门控开关(2026-08 新增)
      // marketStats 门控:无市场数据时跳过后续采集(richMedia/search/bundle/followSell)
      enableMarketStatsGate: true,
      // 类目过滤门控:search+bundle 采集后,类目在黑名单时跳过后续采集(richMedia/followSell)
      enableCategoryFilterGate: true,
      // 超轻小件门控:bundle 采集后,非超轻小件(重量≥500g 或 三边和≥900mm)跳过后续采集
      // 阈值与 index-dao.js buildFilterWhere ultraLight 一致(Ozon Extra Small 官方标准)
      enableUltraLightGate: true,
    };

    // ── 配置读取(带内存缓存) ──────────────────────────────────────────────────
    // 首次读取后缓存到 S.autoCollectConfigCache,写入时通过
    // invalidateAutoCollectConfigCache() 失效。SW 休眠后内存清空,下次读取重新落盘。
    // 默认值与 popup/content 端约定一致,缺失字段用默认补齐(浅合并)。
    const _loadAutoCollectConfig = async () => {
      if (S.autoCollectConfigCache) return S.autoCollectConfigCache;
      try {
        const stored = await sw.getStorage([_AUTO_COLLECT_CONFIG_KEY]);
        let raw = stored?.[_AUTO_COLLECT_CONFIG_KEY];
        const merged =
          raw && typeof raw === 'object'
            ? { ..._AUTO_COLLECT_CONFIG_DEFAULT, ...raw }
            : { ..._AUTO_COLLECT_CONFIG_DEFAULT };
        // 规整 consumeRateMinSec/consumeRateMaxSec 到 [5, 120]
        const _rawMin = raw?.consumeRateMinSec;
        const _rawMax = raw?.consumeRateMaxSec;
        if (_rawMin != null && _rawMax != null) {
          let _lo = Math.max(5, Math.min(120, Math.round(_rawMin)));
          let _hi = Math.max(5, Math.min(120, Math.round(_rawMax)));
          if (_lo > _hi) { const _t = _lo; _lo = _hi; _hi = _t; }
          merged.consumeRateMinSec = _lo;
          merged.consumeRateMaxSec = _hi;
        }
        // 规整 antibotPauseMin(分钟)到 [1, 120]
        const _rawPauseMin = raw?.antibotPauseMin;
        if (_rawPauseMin != null) {
          merged.antibotPauseMin = Math.max(1, Math.min(120, Math.round(_rawPauseMin)));
        }
        // defaults 已含 5/15/10,无需再补
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

    // ── Step 2 迁移:旧 Slugs 字段 → 新 SellerIds 字段 ────────────────────────
    // 2026-08:店铺分类改用 sellerId(稳定主键),旧 knownMainlandChinaSlugs /
    // knownNonMainlandChinaSlugs 字段需迁移到 knownMainlandChinaSellerIds /
    // knownNonMainlandChinaSellerIds。
    //
    // 迁移策略:
    // 1. 读旧字段,若都为空 → 跳过(默认值就是空,无需迁移)
    // 2. 调 ERP /admin/api/collect-box-v2/sellers 拉 (sellerId, sellerSlug) 对
    // 3. 按 slug 反查 sellerId,写入新字段
    // 4. 反查失败的 slug 记日志(用户需在 ERP 店铺分类页手动确认)
    // 5. 清空旧字段(写 []),避免重复迁移
    //
    // 幂等:若新字段已非空(用户已手动配置或已迁移过),跳过
    // 失败隔离:网络/ERP 不可达时跳过迁移,下次启动再试
    this.migrateSlugsToSellerIds = async () => {
      try {
        const cfg = await _loadAutoCollectConfig();
        const oldCn = Array.isArray(cfg.knownMainlandChinaSlugs) ? cfg.knownMainlandChinaSlugs : [];
        const oldNonCn = Array.isArray(cfg.knownNonMainlandChinaSlugs) ? cfg.knownNonMainlandChinaSlugs : [];
        const newCn = Array.isArray(cfg.knownMainlandChinaSellerIds) ? cfg.knownMainlandChinaSellerIds : [];
        const newNonCn = Array.isArray(cfg.knownNonMainlandChinaSellerIds) ? cfg.knownNonMainlandChinaSellerIds : [];

        // 旧字段都空 → 无需迁移
        if (oldCn.length === 0 && oldNonCn.length === 0) {
          console.log('[migrate-slugs] 旧 Slugs 字段为空,跳过迁移');
          return { migrated: false, reason: 'no-legacy-data' };
        }
        // 新字段已有数据 → 避免覆盖用户手动配置
        if (newCn.length > 0 || newNonCn.length > 0) {
          console.log('[migrate-slugs] 新 SellerIds 字段已有数据,跳过迁移(避免覆盖)');
          return { migrated: false, reason: 'already-migrated' };
        }

        // 拉 ERP sellers 列表(含 sellerId ↔ sellerSlug 映射)
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const token = stored[sw.STORAGE_KEYS.token];
        const resp = await sw.apiRequest('GET', `${url}/admin/api/collect-box-v2/sellers`, null, token);
        const sellers = Array.isArray(resp) ? resp : [];
        if (sellers.length === 0) {
          console.warn('[migrate-slugs] ERP sellers 列表为空,无法反查,跳过迁移');
          return { migrated: false, reason: 'erp-empty-sellers' };
        }

        // 建 slug → sellerId 反查表(只取 slug 非空的)
        const slugToSellerId = new Map();
        for (const s of sellers) {
          if (s.sellerSlug && s.sellerId) {
            slugToSellerId.set(String(s.sellerSlug), String(s.sellerId));
          }
        }
        console.log(`[migrate-slugs] ERP sellers 拉取成功,共 ${sellers.length} 家,有 slug 映射 ${slugToSellerId.size} 家`);

        // 反查迁移
        const migratedCn = [];
        const migratedNonCn = [];
        const failedCn = [];
        const failedNonCn = [];
        for (const slug of oldCn) {
          const sid = slugToSellerId.get(String(slug));
          if (sid) migratedCn.push(sid);
          else failedCn.push(slug);
        }
        for (const slug of oldNonCn) {
          const sid = slugToSellerId.get(String(slug));
          if (sid) migratedNonCn.push(sid);
          else failedNonCn.push(slug);
        }

        // 写入新字段 + 清空旧字段
        await _saveAutoCollectConfig({
          knownMainlandChinaSellerIds: migratedCn,
          knownNonMainlandChinaSellerIds: migratedNonCn,
          knownMainlandChinaSlugs: [],
          knownNonMainlandChinaSlugs: [],
        });

        console.log('[migrate-slugs] 迁移完成:', {
          cn: { ok: migratedCn.length, failed: failedCn.length },
          nonCn: { ok: migratedNonCn.length, failed: failedNonCn.length },
        });
        if (failedCn.length > 0) {
          console.warn('[migrate-slugs] CN 白名单反查失败的 slug(需手动确认):', failedCn);
        }
        if (failedNonCn.length > 0) {
          console.warn('[migrate-slugs] 非 CN 黑名单反查失败的 slug(需手动确认):', failedNonCn);
        }

        return {
          migrated: true,
          cnOk: migratedCn.length,
          cnFailed: failedCn,
          nonCnOk: migratedNonCn.length,
          nonCnFailed: failedNonCn,
        };
      } catch (e) {
        console.warn('[migrate-slugs] 迁移失败,下次启动再试:', e?.message || e);
        return { migrated: false, reason: 'error', error: e?.message || String(e) };
      }
    };

    // ── Step 3a:清理旧 L1 缓存 key(jz-store-class-${slug}) ──────────────────
    // 2026-08:店铺分类改用 sellerId 后,旧 slug key 成孤儿。
    // 新 key 格式:jz-store-class-<纯数字 sellerId>
    // 旧 key 格式:jz-store-class-<slug>(含字母/连字符)
    // 本方法扫描 chrome.storage.local,删除所有不符合新格式的 key。
    this.cleanupLegacyStoreClassCache = async () => {
      try {
        const all = await sw.getStorage(null);
        if (!all || typeof all !== 'object') return { cleaned: 0 };
        const keysToRemove = [];
        for (const k of Object.keys(all)) {
          // 只处理 jz-store-class- 前缀
          if (!k.startsWith('jz-store-class-')) continue;
          // 提取后缀
          const suffix = k.slice('jz-store-class-'.length);
          // 新格式:sellerId 为纯数字。旧 slug 含字母/连字符,删除
          if (!/^\d+$/.test(suffix)) {
            keysToRemove.push(k);
          }
        }
        if (keysToRemove.length === 0) {
          console.log('[cleanup-l1] 无旧 slug 缓存需清理');
          return { cleaned: 0 };
        }
        await sw.removeStorage(keysToRemove);
        console.log(`[cleanup-l1] 已清理 ${keysToRemove.length} 个旧 slug 缓存 key:`, keysToRemove);
        return { cleaned: keysToRemove.length };
      } catch (e) {
        console.warn('[cleanup-l1] 清理失败:', e?.message || e);
        return { cleaned: 0, error: e?.message || String(e) };
      }
    };

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
