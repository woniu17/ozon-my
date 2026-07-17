/* =========================================================
 * 采集缓存层(采集代码隔离 Phase 3)
 *
 * 从 service-worker.js 提取的缓存相关代码,采用 init 桥接模式:
 *   - 注册 globalThis.__jzCollect.setupCache 函数
 *   - 由 __jzCollect.init() 在 IIFE 工具函数就绪后调用
 *   - 通过 this._sw 访问 SW 工具(getBackendUrl/getStorage/apiRequest/STORAGE_KEYS)
 *   - 通过 this.state.xxx 访问采集运行时状态
 *
 * 覆盖范围:
 *   - L1 IndexedDB 封装(8 个 store:search/bundle/card/composer/entrypoint/detail/
 *     market_stats/follow_sell)
 *   - L2 ERP MongoDB 缓存封装(/ozon/cache/{type}/:sku,JWT 鉴权)
 *   - 6 类业务缓存 Get/Set/Delete(card/composer/entrypoint/detail/marketStats/followSell)
 *   - L2 定时补写(chrome.alarms 每 5 分钟扫描 l2Synced=false 的记录)
 *   - 自动采集日志(fire-and-forget 写入 ERP)
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupCache = function () {
    const sw = this._sw;
    const S = this.state;

    // ── 常量 ──────────────────────────────────────────────────────────────────
    const _IDB_NAME = 'ozon-cache';
    const _IDB_VERSION = 6;
    const _IDB_STORE_SEARCH = 'search_cache';
    const _IDB_STORE_BUNDLE = 'bundle_cache';
    const _IDB_STORE_CARD = 'card_cache';
    const _IDB_STORE_COMPOSER = 'composer_cache';
    const _IDB_STORE_ENTRYPOINT = 'entrypoint_cache';
    const _IDB_STORE_DETAIL = 'detail_cache';
    // v6:新增 market_stats / follow_sell 缓存(带 stale 判定,不删旧 6 store)
    const _IDB_STORE_MARKET_STATS = 'market_stats_cache';
    const _IDB_STORE_FOLLOW_SELL = 'follow_sell_cache';
    const _ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验
    const CACHE_SYNC_ALARM = 'jz:cache-sync-l2';
    const CACHE_SYNC_INTERVAL_MINUTES = 5;

    // ── L1: IndexedDB 封装 ─────────────────────────────────────────────────────
    // MV3 SW 休眠后 indexedDB 连接会断,S.idbPromise=null 模式确保唤醒后重连。
    // 容量充足(GB 级),无 TTL(与 L2 一致),forceRefresh 时主动删除。
    const _openIdb = () => {
      if (S.idbPromise) return S.idbPromise;
      S.idbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(_IDB_STORE_SEARCH)) {
            db.createObjectStore(_IDB_STORE_SEARCH, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_BUNDLE)) {
            db.createObjectStore(_IDB_STORE_BUNDLE, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_CARD)) {
            db.createObjectStore(_IDB_STORE_CARD, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_COMPOSER)) {
            db.createObjectStore(_IDB_STORE_COMPOSER, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_ENTRYPOINT)) {
            db.createObjectStore(_IDB_STORE_ENTRYPOINT, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_DETAIL)) {
            db.createObjectStore(_IDB_STORE_DETAIL, { keyPath: 'sku' });
          }
          // v6:新增 market_stats / follow_sell 缓存 store(带 stale 判定)。
          // 用 contains 守卫保证从任意旧版本升级都幂等创建,不删旧 6 store。
          if (!db.objectStoreNames.contains(_IDB_STORE_MARKET_STATS)) {
            db.createObjectStore(_IDB_STORE_MARKET_STATS, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_FOLLOW_SELL)) {
            db.createObjectStore(_IDB_STORE_FOLLOW_SELL, { keyPath: 'sku' });
          }
          // v5:删除旧 pdp_cache / dynamic_store(已合并为 detail_cache)
          if (db.objectStoreNames.contains('pdp_cache')) {
            db.deleteObjectStore('pdp_cache');
          }
          if (db.objectStoreNames.contains('dynamic_cache')) {
            db.deleteObjectStore('dynamic_cache');
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // MV3 SW 休眠后 indexedDB 连接可能被浏览器关闭。
          // 监听 onclose/onversionchange,触发时重置缓存让下次调用重连。
          db.onclose = () => {
            S.idbPromise = null;
          };
          db.onversionchange = () => {
            db.close();
            S.idbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          S.idbPromise = null;
          reject(req.error);
        };
      });
      return S.idbPromise;
    };

    const _idbGet = (store, sku) =>
      _openIdb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).get(sku);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
          })
      );
    const _idbPut = (store, val) =>
      _openIdb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(val);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          })
      );
    const _idbDelete = (store, sku) =>
      _openIdb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(sku);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          })
      );

    // bundle 空属性判定:有 attributes → 可复用;无 attributes 且 6h 内已验证 → 可复用;否则 miss
    const _bundleUsable = (entry) => {
      if (!entry || !entry.data) return false;
      const hasAttrs = Array.isArray(entry.data.attributes) && entry.data.attributes.length > 0;
      if (hasAttrs) return true;
      const verifiedAt = Number(entry.attrsEmptyVerifiedAt || 0);
      return verifiedAt > 0 && Date.now() - verifiedAt < _ATTRS_EMPTY_REVERIFY_MS;
    };

    // ── L2: ERP MongoDB 缓存封装 ───────────────────────────────────────────────
    // ERP 路由 /ozon/cache/{search,bundle}/:sku,JWT 鉴权(不走 storeGuard,按 sku 全局共享)
    const _erpCacheGet = async (type, sku) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const r = await sw.apiRequest(
          'GET',
          `${url}/ozon/cache/${type}/${encodeURIComponent(sku)}`,
          null,
          stored[sw.STORAGE_KEYS.token]
        );
        return r;
      } catch (e) {
        console.warn(`[cache] ERP ${type} get failed for sku=${sku}:`, e?.message || e);
        return null;
      }
    };
    const _erpCacheSet = async (type, sku, body) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest(
          'POST',
          `${url}/ozon/cache/${type}/${encodeURIComponent(sku)}`,
          body,
          stored[sw.STORAGE_KEYS.token]
        );
        return true;
      } catch (e) {
        console.warn(`[cache] ERP ${type} set failed for sku=${sku}:`, e?.message || e);
        return false;
      }
    };
    const _erpCacheDelete = async (type, sku) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest(
          'DELETE',
          `${url}/ozon/cache/${type}/${encodeURIComponent(sku)}`,
          null,
          stored[sw.STORAGE_KEYS.token]
        );
      } catch (e) {
        console.warn(`[cache] ERP ${type} delete failed for sku=${sku}:`, e?.message || e);
      }
    };

    // L3 真调后用此函数写 L2:异步单次写入 + 成功后回更新 L1 l2Synced=true。
    // 失败时不重试,保持 l2Synced=false,由 CACHE_SYNC_ALARM 定时任务补写。
    const _erpCacheSetAndSyncFlag = (store, type, sku, body) => {
      _erpCacheSet(type, sku, body)
        .then((ok) => {
          if (ok) {
            _idbGet(store, sku)
              .then((entry) => {
                if (entry && entry.data) _idbPut(store, { ...entry, l2Synced: true }).catch(() => {});
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };

    // L1 命中但 L2 未同步时,用 L1 数据异步补写 L2(单次,失败留待定时任务)。
    const _syncL2FromL1 = async (store, type, sku, l1Entry) => {
      try {
        const ok = await _erpCacheSet(type, sku, {
          data: l1Entry.data,
          bundleId: l1Entry.bundleId || null,
        });
        if (ok) {
          const latest = await _idbGet(store, sku);
          if (latest && latest.data) {
            _idbPut(store, { ...latest, l2Synced: true }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn(`[cache] L2 sync from L1 failed sku=${sku}:`, e?.message || e);
      }
    };

    // ── 自动采集日志:fire-and-forget 写入 ERP(带 JWT) ─────────────────────────
    // 由 Task 6 自动采集流程的 Step 7 / Gate 0.5 跳过分支 / ANTIBOT 分支调用。
    // 调用方不应 await(不阻塞主流程),失败仅 warn 不影响采集结果。
    // payload: { sku, source, sellerSlug, storeClassified, depth, status,
    //   results, totalDuration }
    const _writeAutoCollectLog = async (payload) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest('POST', `${url}/admin/api/auto-collect/log`, payload, stored[sw.STORAGE_KEYS.token]);
      } catch (e) {
        console.warn('[auto-collect-log] write failed:', e?.message || e);
      }
    };

    // ── IDB 扫描未同步 ──────────────────────────────────────────────────────────
    // forceAll=true 时返回所有有 data 的记录(不论 l2Synced),用于 popup 手动全量同步;
    // forceAll=false(默认)只返回 l2Synced=false 的记录,用于定时补写。
    const _idbScanUnsynced = (store, forceAll = false) =>
      _openIdb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).getAll();
            req.onsuccess = () => {
              const all = req.result || [];
              resolve(all.filter((e) => e && e.data && (forceAll || e.l2Synced === false)));
            };
            req.onerror = () => reject(req.error);
          })
      );

    // ── 暴露 IDB/ERP 基础操作给外部 ──
    this.idbGet = _idbGet;
    this.idbPut = _idbPut;
    this.idbDelete = _idbDelete;
    this.erpCacheGet = _erpCacheGet;
    this.erpCacheSet = _erpCacheSet;
    this.erpCacheDelete = _erpCacheDelete;
    this.erpCacheSetAndSyncFlag = _erpCacheSetAndSyncFlag;
    this.syncL2FromL1 = _syncL2FromL1;
    this.bundleUsable = _bundleUsable;
    this.writeAutoCollectLog = _writeAutoCollectLog;
    this.IDB_STORES = {
      SEARCH: _IDB_STORE_SEARCH,
      BUNDLE: _IDB_STORE_BUNDLE,
      CARD: _IDB_STORE_CARD,
      COMPOSER: _IDB_STORE_COMPOSER,
      ENTRYPOINT: _IDB_STORE_ENTRYPOINT,
      DETAIL: _IDB_STORE_DETAIL,
      MARKET_STATS: _IDB_STORE_MARKET_STATS,
      FOLLOW_SELL: _IDB_STORE_FOLLOW_SELL,
    };
    this.ATTRS_EMPTY_REVERIFY_MS = _ATTRS_EMPTY_REVERIFY_MS;
    // loadAutoCollectConfig 由 SW 桥接传入(marketStats/followSell 缓存的 stale 判定需要读取配置)
    this.loadAutoCollectConfig = sw.loadAutoCollectConfig;

    // ── card 缓存(商品卡 DOM 字段:sku/url/name/price/image) ─────────────────────────
    // 缓存对象:搜索页/店铺页 extractCardInfo() 返回的基础 5 字段
    // 策略:无 TTL(永久),搜索页/店铺页采集时写入,全览展示 + OPI 预览 fallback
    // L1 IndexedDB → L2 MongoDB → 失败返回 null
    this.cardCacheGet = async (sku) => {
      try {
        const l1 = await _idbGet(_IDB_STORE_CARD, sku);
        if (l1 && l1.data) return l1.data;
        const l2 = await _erpCacheGet('card', sku);
        if (l2 && l2.data) {
          _idbPut(_IDB_STORE_CARD, {
            sku,
            data: l2.data,
            fetchedAt: Date.now(),
            l2Synced: true,
          }).catch(() => {});
          return l2.data;
        }
      } catch (e) {
        console.warn(`[cache] card get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.cardCacheSet = (sku, cardFields) => {
      _idbPut(_IDB_STORE_CARD, {
        sku,
        data: cardFields,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_CARD, 'card', sku, { data: cardFields });
    };

    this.cardCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_CARD, sku).catch(() => {});
      _erpCacheDelete('card', sku);
    };

    // ── composer 缓存(composer-api widgetStates,缓存优先) ─────────────────────────
    // 缓存对象:fetchProductPageState 返回的 19 个业务 widgetStates 子集
    // 策略:无 TTL(永久),缓存优先(命中直接返回,跳过网络请求)
    // L1 IndexedDB → L2 MongoDB → L3 真调 composer-api
    this.composerCacheGet = async (sku) => {
      try {
        // L1
        const l1 = await _idbGet(_IDB_STORE_COMPOSER, sku);
        if (l1 && l1.data) return l1.data;
        // L2
        const l2 = await _erpCacheGet('composer', sku);
        if (l2 && l2.data) {
          _idbPut(_IDB_STORE_COMPOSER, {
            sku,
            data: l2.data,
            fetchedAt: Date.now(),
            l2Synced: true,
          }).catch(() => {});
          return l2.data;
        }
      } catch (e) {
        console.warn(`[cache] composer get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.composerCacheSet = (sku, widgetStates) => {
      _idbPut(_IDB_STORE_COMPOSER, {
        sku,
        data: widgetStates,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_COMPOSER, 'composer', sku, { data: widgetStates });
    };

    this.composerCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_COMPOSER, sku).catch(() => {});
      _erpCacheDelete('composer', sku);
    };

    // ── entrypoint 缓存(entrypoint-api page-json,缓存优先) ─────────────────────────
    // 缓存对象:fetchVariantGallery / fetchVariantMediaViaBuyerTab 从 entrypoint-api.bx 蒸馏的
    //   { gallery, richContent, description, hashtags } 等字段
    // 策略:无 TTL(永久),缓存优先(命中直接返回,跳过 buyer tab 注入 + 网络请求)
    // L1 IndexedDB → L2 MongoDB → L3 真调 entrypoint-api
    this.entrypointCacheGet = async (sku) => {
      try {
        const l1 = await _idbGet(_IDB_STORE_ENTRYPOINT, sku);
        if (l1 && l1.data) return l1.data;
        const l2 = await _erpCacheGet('entrypoint', sku);
        if (l2 && l2.data) {
          _idbPut(_IDB_STORE_ENTRYPOINT, {
            sku,
            data: l2.data,
            fetchedAt: Date.now(),
            l2Synced: true,
          }).catch(() => {});
          return l2.data;
        }
      } catch (e) {
        console.warn(`[cache] entrypoint get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.entrypointCacheSet = (sku, data) => {
      _idbPut(_IDB_STORE_ENTRYPOINT, {
        sku,
        data,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_ENTRYPOINT, 'entrypoint', sku, { data });
    };

    this.entrypointCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_ENTRYPOINT, sku).catch(() => {});
      _erpCacheDelete('entrypoint', sku);
    };

    // ── detail 缓存(详情页 DOM 全字段:原 pdp 静态 + dynamic 动态合并) ─────────────────────────
    // 缓存对象:extractProductData() 返回的全字段(title/images/videos/sku/productId/url/brand/category/
    //   characteristics + price/walletPrice/originalPrice/seller/statistics/freeRest/followSellCount/
    //   followSellMinPrice/deliveryMode/rating/reviewCount)
    // 策略:无 TTL(永久),DOM 解析失败时兜底,不阻塞采集流程
    // L1 IndexedDB → L2 MongoDB → 失败返回 null
    this.detailCacheGet = async (sku) => {
      try {
        const l1 = await _idbGet(_IDB_STORE_DETAIL, sku);
        if (l1 && l1.data) return l1.data;
        const l2 = await _erpCacheGet('detail', sku);
        if (l2 && l2.data) {
          _idbPut(_IDB_STORE_DETAIL, {
            sku,
            data: l2.data,
            fetchedAt: Date.now(),
            l2Synced: true,
          }).catch(() => {});
          return l2.data;
        }
      } catch (e) {
        console.warn(`[cache] detail get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.detailCacheSet = (sku, detailFields) => {
      _idbPut(_IDB_STORE_DETAIL, {
        sku,
        data: detailFields,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_DETAIL, 'detail', sku, { data: detailFields });
    };

    this.detailCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_DETAIL, sku).catch(() => {});
      _erpCacheDelete('detail', sku);
    };

    // ── marketStats 缓存(市场统计:销量/评价/排名等,24h stale) ───────────────────
    // 缓存对象:getMarketStats 真调返回的市场统计聚合
    // 策略:24h stale(marketStatsStaleMs 从 loadAutoCollectConfig 读取),
    //   stale 时仍返回记录(含 stale=true),由调用方决定是否刷新。
    // L1 IndexedDB → L2 MongoDB → 失败返回 null
    // 返回:{ data, fetchedAt, stale } | null
    this.marketStatsCacheGet = async (sku) => {
      try {
        const l1 = await _idbGet(_IDB_STORE_MARKET_STATS, sku);
        if (l1 && l1.data) {
          const cfg = await this.loadAutoCollectConfig();
          const staleMs = Number(cfg.marketStatsStaleMs) || 86400000;
          const fetchedAt = Number(l1.fetchedAt || 0);
          return { data: l1.data, fetchedAt, stale: Date.now() - fetchedAt > staleMs };
        }
        const l2 = await _erpCacheGet('marketStats', sku);
        if (l2 && l2.data) {
          const fetchedAt = Date.now();
          _idbPut(_IDB_STORE_MARKET_STATS, {
            sku,
            data: l2.data,
            fetchedAt,
            l2Synced: true,
          }).catch(() => {});
          return { data: l2.data, fetchedAt, stale: false };
        }
      } catch (e) {
        console.warn(`[cache] marketStats get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.marketStatsCacheSet = (sku, data) => {
      _idbPut(_IDB_STORE_MARKET_STATS, {
        sku,
        data,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_MARKET_STATS, 'marketStats', sku, { data });
    };

    this.marketStatsCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_MARKET_STATS, sku).catch(() => {});
      _erpCacheDelete('marketStats', sku);
    };

    // ── followSell 缓存(跟卖预取结果,4h stale) ──────────────────────────────
    // 缓存对象:followSell 预取的跟卖可用性 / 竞品数据
    // 策略:4h stale(followSellStaleMs 从 loadAutoCollectConfig 读取),
    //   stale 时仍返回记录(含 stale=true),由调用方决定是否刷新。
    // L1 IndexedDB → L2 MongoDB → 失败返回 null
    // 返回:{ data, fetchedAt, stale } | null
    this.followSellCacheGet = async (sku) => {
      try {
        const l1 = await _idbGet(_IDB_STORE_FOLLOW_SELL, sku);
        if (l1 && l1.data) {
          const cfg = await this.loadAutoCollectConfig();
          const staleMs = Number(cfg.followSellStaleMs) || 14400000;
          const fetchedAt = Number(l1.fetchedAt || 0);
          return { data: l1.data, fetchedAt, stale: Date.now() - fetchedAt > staleMs };
        }
        const l2 = await _erpCacheGet('followSell', sku);
        if (l2 && l2.data) {
          const fetchedAt = Date.now();
          _idbPut(_IDB_STORE_FOLLOW_SELL, {
            sku,
            data: l2.data,
            fetchedAt,
            l2Synced: true,
          }).catch(() => {});
          return { data: l2.data, fetchedAt, stale: false };
        }
      } catch (e) {
        console.warn(`[cache] followSell get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.followSellCacheSet = (sku, data) => {
      _idbPut(_IDB_STORE_FOLLOW_SELL, {
        sku,
        data,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_FOLLOW_SELL, 'followSell', sku, { data });
    };

    this.followSellCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_FOLLOW_SELL, sku).catch(() => {});
      _erpCacheDelete('followSell', sku);
    };

    // ── 定时补写 L2:扫描 L1 中 l2Synced=false 的记录 ──────────────────────────
    // 由 chrome.alarms 每 5 分钟触发,不受 SW 休眠影响。
    // 扫描 search/bundle/card/composer/entrypoint/detail/marketStats/followSell 八个 store,
    // 逐条补写 L2,成功后置 l2Synced=true。
    // forceAll=true:全量同步(忽略 l2Synced 标志),由 popup 手动按钮触发
    // forceAll=false(默认):只补写 l2Synced=false 的记录,由定时 alarm 触发
    this.syncL2Batch = async (forceAll = false) => {
      if (S.cacheSyncRunning)
        return {
          search: 0,
          bundle: 0,
          card: 0,
          composer: 0,
          entrypoint: 0,
          detail: 0,
          marketStats: 0,
          followSell: 0,
        };
      S.cacheSyncRunning = true;
      const stats = {
        search: 0,
        bundle: 0,
        card: 0,
        composer: 0,
        entrypoint: 0,
        detail: 0,
        marketStats: 0,
        followSell: 0,
      };
      try {
        for (const { store, type } of [
          { store: _IDB_STORE_SEARCH, type: 'search' },
          { store: _IDB_STORE_BUNDLE, type: 'bundle' },
          { store: _IDB_STORE_CARD, type: 'card' },
          { store: _IDB_STORE_COMPOSER, type: 'composer' },
          { store: _IDB_STORE_ENTRYPOINT, type: 'entrypoint' },
          { store: _IDB_STORE_DETAIL, type: 'detail' },
          { store: _IDB_STORE_MARKET_STATS, type: 'marketStats' },
          { store: _IDB_STORE_FOLLOW_SELL, type: 'followSell' },
        ]) {
          const unsynced = await _idbScanUnsynced(store, forceAll).catch(() => []);
          for (const entry of unsynced) {
            const ok = await _erpCacheSet(type, entry.sku, {
              data: entry.data,
              bundleId: entry.bundleId || null,
            });
            if (ok) {
              await _idbPut(store, { ...entry, l2Synced: true }).catch(() => {});
              stats[type]++;
            }
          }
        }
        const total = stats.search + stats.bundle + stats.card + stats.marketStats + stats.followSell;
        if (total > 0)
          console.log(
            `[cache-sync] 补写 ${total} 条 L2 缓存 (search=${stats.search}, bundle=${stats.bundle}, card=${stats.card}, composer=${stats.composer}, entrypoint=${stats.entrypoint}, detail=${stats.detail}, marketStats=${stats.marketStats}, followSell=${stats.followSell}, forceAll=${forceAll})`
          );
      } catch (e) {
        console.warn('[cache-sync] batch failed:', e?.message || e);
      } finally {
        S.cacheSyncRunning = false;
      }
      return stats;
    };

    this.setupCacheSyncAlarm = () => {
      chrome.alarms.create(CACHE_SYNC_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: CACHE_SYNC_INTERVAL_MINUTES,
      });
    };
  };
})();
