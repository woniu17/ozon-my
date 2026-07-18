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
 *   - L1 IndexedDB 封装(7 个 store:dom/attribute/rich_media/market_stats/follow_sell
 *     + 旧 search/bundle/card/detail/composer/entrypoint 保留扫老数据迁移到新 store)
 *   - L2 ERP SQLite 缓存封装(/ozon/cache/{dom|attribute|richMedia|marketStats|followSell}/:sku,JWT 鉴权)
 *   - 5 类业务缓存 Get/Delete(dom/attribute/richMedia/marketStats/followSell)
 *     · dom: type='card'|'detail' 参数区分,合并表字段独立
 *     · attribute: type='search'|'bundle' 参数区分,合并表字段独立,bundle 含 6h 空属性重验
 *   - L2 定时补写(chrome.alarms 每 5 分钟扫描 l2Synced=false 的记录,含旧 store 迁移)
 *   - 自动采集日志(fire-and-forget 写入 ERP)
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupCache = function () {
    const sw = this._sw;
    const S = this.state;

    // ── 常量 ──────────────────────────────────────────────────────────────────
    const _IDB_NAME = 'ozon-cache';
    // v8: 新增 dom_cache(合并 card+detail)+ attribute_cache(合并 search+bundle)
    //     旧 6 store(search/bundle/card/composer/entrypoint/detail)保留不删,
    //     由 syncL2Batch 扫描迁移到新 store,迁移完成后逐条删除。
    const _IDB_VERSION = 8;
    // 新合并 store
    const _IDB_STORE_DOM = 'dom_cache';
    const _IDB_STORE_ATTRIBUTE = 'attribute_cache';
    const _IDB_STORE_RICH_MEDIA = 'rich_media_cache';
    const _IDB_STORE_MARKET_STATS = 'market_stats_cache';
    const _IDB_STORE_FOLLOW_SELL = 'follow_sell_cache';
    // 旧 store(仅保留扫老数据迁移用,不再写入)
    const _IDB_STORE_SEARCH = 'search_cache';
    const _IDB_STORE_BUNDLE = 'bundle_cache';
    const _IDB_STORE_CARD = 'card_cache';
    const _IDB_STORE_COMPOSER = 'composer_cache';
    const _IDB_STORE_ENTRYPOINT = 'entrypoint_cache';
    const _IDB_STORE_DETAIL = 'detail_cache';
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
          // v8:新增 dom_cache + attribute_cache 合并 store
          // 用 contains 守卫保证从任意旧版本升级都幂等创建,不删旧 store(由 syncL2Batch 迁移)
          if (!db.objectStoreNames.contains(_IDB_STORE_DOM)) {
            db.createObjectStore(_IDB_STORE_DOM, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_ATTRIBUTE)) {
            db.createObjectStore(_IDB_STORE_ATTRIBUTE, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_RICH_MEDIA)) {
            db.createObjectStore(_IDB_STORE_RICH_MEDIA, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_MARKET_STATS)) {
            db.createObjectStore(_IDB_STORE_MARKET_STATS, { keyPath: 'sku' });
          }
          if (!db.objectStoreNames.contains(_IDB_STORE_FOLLOW_SELL)) {
            db.createObjectStore(_IDB_STORE_FOLLOW_SELL, { keyPath: 'sku' });
          }
          // 旧 store 保留(扫老数据迁移用),幂等创建以兼容全新安装走 same flow
          for (const name of [
            _IDB_STORE_SEARCH,
            _IDB_STORE_BUNDLE,
            _IDB_STORE_CARD,
            _IDB_STORE_COMPOSER,
            _IDB_STORE_ENTRYPOINT,
            _IDB_STORE_DETAIL,
          ]) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: 'sku' });
            }
          }
          // v5:删除更早的 pdp_cache / dynamic_cache(已被 detail_cache 替代,且 detail_cache 又被 dom 合并)
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
    // 兼容两种 entry 形状:
    //   1) 旧 bundle_cache 直接 idbGet 返回的 { data, attrsEmptyVerifiedAt, ... }
    //   2) 新 attributeCacheGet('bundle') 返回的 { data, attrsEmptyVerifiedAt, fetchedAt, bundleId }
    const _bundleUsable = (entry) => {
      if (!entry || !entry.data) return false;
      const hasAttrs = Array.isArray(entry.data.attributes) && entry.data.attributes.length > 0;
      if (hasAttrs) return true;
      const verifiedAt = Number(entry.attrsEmptyVerifiedAt || 0);
      return verifiedAt > 0 && Date.now() - verifiedAt < _ATTRS_EMPTY_REVERIFY_MS;
    };

    // ── L2: ERP SQLite 缓存封装 ───────────────────────────────────────────────
    // ERP 路由 /ozon/cache/{dom|attribute|richMedia|marketStats|followSell}/:sku,JWT 鉴权
    // (不走 storeGuard,按 sku 全局共享)
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
    // 仅用于单 l2Synced 标志的 store(richMedia/marketStats/followSell)。
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
    // 仅用于单 l2Synced 标志的 store(richMedia/marketStats/followSell)。
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
    // 仅用于单 l2Synced 标志的 store(richMedia/marketStats/followSell)。
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

    // 扫描 dom/attribute 合并 store 中未同步的 type 项
    // 返回 [{ sku, type, data, ...extra }] — 每个 type 一条
    // forceAll=true 时返回所有有数据的 type 项
    const _idbScanMergedUnsynced = async (store, forceAll = false) => {
      const db = await _openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          const out = [];
          for (const e of all) {
            if (!e || !e.sku) continue;
            // dom: card + detail
            // attribute: search + bundle
            if (store === _IDB_STORE_DOM) {
              if (e.cardData && (forceAll || e.cardL2Synced === false)) {
                out.push({ sku: e.sku, type: 'card', data: e.cardData });
              }
              if (e.detailData && (forceAll || e.detailL2Synced === false)) {
                out.push({ sku: e.sku, type: 'detail', data: e.detailData });
              }
            } else if (store === _IDB_STORE_ATTRIBUTE) {
              if (e.searchData && (forceAll || e.searchL2Synced === false)) {
                out.push({ sku: e.sku, type: 'search', data: e.searchData });
              }
              if (e.bundleData && (forceAll || e.bundleL2Synced === false)) {
                out.push({
                  sku: e.sku,
                  type: 'bundle',
                  data: e.bundleData,
                  bundleId: e.bundleId || null,
                  attrsEmptyVerifiedAt: e.attrsEmptyVerifiedAt || null,
                });
              }
            }
          }
          resolve(out);
        };
        req.onerror = () => reject(req.error);
      });
    };

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
      // 新合并 store(主用)
      DOM: _IDB_STORE_DOM,
      ATTRIBUTE: _IDB_STORE_ATTRIBUTE,
      RICH_MEDIA: _IDB_STORE_RICH_MEDIA,
      MARKET_STATS: _IDB_STORE_MARKET_STATS,
      FOLLOW_SELL: _IDB_STORE_FOLLOW_SELL,
      // 旧 store(仅迁移用,不再写入)
      SEARCH: _IDB_STORE_SEARCH,
      BUNDLE: _IDB_STORE_BUNDLE,
      CARD: _IDB_STORE_CARD,
      COMPOSER: _IDB_STORE_COMPOSER,
      ENTRYPOINT: _IDB_STORE_ENTRYPOINT,
      DETAIL: _IDB_STORE_DETAIL,
    };
    this.ATTRS_EMPTY_REVERIFY_MS = _ATTRS_EMPTY_REVERIFY_MS;
    // loadAutoCollectConfig 由 SW 桥接传入(marketStats/followSell 缓存的 stale 判定需要读取配置)
    this.loadAutoCollectConfig = sw.loadAutoCollectConfig;

    // ── dom 缓存(card + detail 合并表,字段独立,互相备份) ─────────────────────────
    // 缓存对象:
    //   card:搜索页/店铺页 extractCardInfo() 返回的基础 5 字段(sku/url/name/price/image)
    //   detail:extractProductData() 返回的详情页 DOM 全字段(title/images/sku/productId/...)
    // 策略:无 TTL(永久),搜索页/店铺页采集时写 card,详情页采集时写 detail,全览展示 + OPI 预览 fallback
    // L1 记录结构:{ sku, cardData, cardFetchedAt, cardL2Synced, detailData, detailFetchedAt, detailL2Synced }
    // L2 POST /ozon/cache/dom/:sku body: { type: 'card'|'detail', data }
    // L2 GET /ozon/cache/dom/:sku 返回 { card, detail, cardFetchedAt, detailFetchedAt }
    this.domCacheGet = async (sku, type) => {
      // type: 'card' | 'detail'
      try {
        const l1 = await _idbGet(_IDB_STORE_DOM, sku);
        if (l1 && l1[`${type}Data`]) return l1[`${type}Data`];
        const l2 = await _erpCacheGet('dom', sku);
        if (l2) {
          const data = type === 'card' ? l2.card : l2.detail;
          if (data) {
            // 回填 L1(合并写入,保留已有字段)
            const existing = (await _idbGet(_IDB_STORE_DOM, sku)) || { sku };
            const fetchedAt = type === 'card' ? l2.cardFetchedAt : l2.detailFetchedAt;
            const fetchedAtMs = fetchedAt ? new Date(fetchedAt).getTime() : Date.now();
            _idbPut(_IDB_STORE_DOM, {
              ...existing,
              sku,
              [`${type}Data`]: data,
              [`${type}FetchedAt`]: fetchedAtMs,
              [`${type}L2Synced`]: true,
            }).catch(() => {});
            return data;
          }
        }
      } catch (e) {
        console.warn(`[cache] dom ${type} get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.domCacheSet = (sku, type, data) => {
      // type: 'card' | 'detail'
      const dataKey = `${type}Data`;
      const fetchedAtKey = `${type}FetchedAt`;
      const l2SyncedKey = `${type}L2Synced`;
      // 先读现有记录(合并写入,不覆盖另一类型)
      _idbGet(_IDB_STORE_DOM, sku)
        .then((existing) => {
          _idbPut(_IDB_STORE_DOM, {
            ...(existing || { sku }),
            sku,
            [dataKey]: data,
            [fetchedAtKey]: Date.now(),
            [l2SyncedKey]: false,
          }).catch(() => {});
        })
        .catch(() => {});
      // L2 异步写入(成功后回更新 L1 对应 type 的 l2Synced=true)
      _erpCacheSet('dom', sku, { type, data })
        .then((ok) => {
          if (ok) {
            _idbGet(_IDB_STORE_DOM, sku)
              .then((entry) => {
                if (entry) _idbPut(_IDB_STORE_DOM, { ...entry, [l2SyncedKey]: true }).catch(() => {});
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };

    this.domCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_DOM, sku).catch(() => {});
      _erpCacheDelete('dom', sku);
    };

    // ── attribute 缓存(search + bundle 合并表,字段独立) ─────────────────────────
    // 缓存对象:
    //   search:/api/v1/search 归一化后的 items 数组(含基础元数据 + 物理 attrs 兜底)
    //   bundle:/api/site/seller-prototype/create-bundle-by-variant-id 返回的 item
    //          (含完整 attributes 40-63 个 + weight/depth/width/height + barcode)
    // 策略:无 TTL(永久),bundle 空属性 6h 重验;forceRefresh 主动删除
    // L1 记录结构:{ sku, searchData, searchFetchedAt, searchL2Synced,
    //               bundleData, bundleFetchedAt, bundleL2Synced, bundleId, attrsEmptyVerifiedAt }
    // L2 POST /ozon/cache/attribute/:sku body: { type: 'search'|'bundle', data, bundleId? }
    // L2 GET /ozon/cache/attribute/:sku 返回 { searchData, bundleData, searchFetchedAt,
    //   bundleFetchedAt, bundleId, attrsEmptyVerifiedAt, stale }
    //
    // 返回形状:
    //   type='search' → searchData(原始 items 对象)
    //   type='bundle' → { data, bundleId, attrsEmptyVerifiedAt, fetchedAt }
    this.attributeCacheGet = async (sku, type) => {
      // type: 'search' | 'bundle'
      try {
        const l1 = await _idbGet(_IDB_STORE_ATTRIBUTE, sku);
        if (l1 && l1[`${type}Data`]) {
          if (type === 'bundle') {
            return {
              data: l1.bundleData,
              bundleId: l1.bundleId || null,
              attrsEmptyVerifiedAt: l1.attrsEmptyVerifiedAt || null,
              fetchedAt: l1.bundleFetchedAt || 0,
            };
          }
          return l1.searchData;
        }
        const l2 = await _erpCacheGet('attribute', sku);
        if (l2) {
          const data = type === 'search' ? l2.searchData : l2.bundleData;
          if (data) {
            // 回填 L1(合并写入,保留已有字段)
            const existing = (await _idbGet(_IDB_STORE_ATTRIBUTE, sku)) || { sku };
            const fetchedAt = type === 'search' ? l2.searchFetchedAt : l2.bundleFetchedAt;
            const fetchedAtMs = fetchedAt ? new Date(fetchedAt).getTime() : Date.now();
            const patch = {
              ...existing,
              sku,
              [`${type}Data`]: data,
              [`${type}FetchedAt`]: fetchedAtMs,
              [`${type}L2Synced`]: true,
            };
            // bundle 类型额外回填 bundleId 和 attrsEmptyVerifiedAt
            if (type === 'bundle') {
              if (l2.bundleId != null) patch.bundleId = l2.bundleId;
              if (l2.attrsEmptyVerifiedAt) {
                patch.attrsEmptyVerifiedAt = new Date(l2.attrsEmptyVerifiedAt).getTime();
              }
            }
            _idbPut(_IDB_STORE_ATTRIBUTE, patch).catch(() => {});
            // 返回格式与 L1 一致
            if (type === 'bundle') {
              return {
                data,
                bundleId: patch.bundleId || null,
                attrsEmptyVerifiedAt: patch.attrsEmptyVerifiedAt || null,
                fetchedAt: fetchedAtMs,
              };
            }
            return data;
          }
        }
      } catch (e) {
        console.warn(`[cache] attribute ${type} get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.attributeCacheSet = (sku, type, data, extra = {}) => {
      // type: 'search' | 'bundle'
      // extra: { bundleId?, attrsEmptyVerifiedAt? } (仅 bundle 类型使用)
      const dataKey = `${type}Data`;
      const fetchedAtKey = `${type}FetchedAt`;
      const l2SyncedKey = `${type}L2Synced`;
      const body = { type, data };
      if (type === 'bundle' && extra.bundleId != null) body.bundleId = extra.bundleId;
      _idbGet(_IDB_STORE_ATTRIBUTE, sku)
        .then((existing) => {
          const patch = {
            ...(existing || { sku }),
            sku,
            [dataKey]: data,
            [fetchedAtKey]: Date.now(),
            [l2SyncedKey]: false,
          };
          if (type === 'bundle') {
            if (extra.bundleId != null) patch.bundleId = extra.bundleId;
            if (extra.attrsEmptyVerifiedAt != null) {
              patch.attrsEmptyVerifiedAt = extra.attrsEmptyVerifiedAt;
            }
          }
          _idbPut(_IDB_STORE_ATTRIBUTE, patch).catch(() => {});
        })
        .catch(() => {});
      _erpCacheSet('attribute', sku, body)
        .then((ok) => {
          if (ok) {
            _idbGet(_IDB_STORE_ATTRIBUTE, sku)
              .then((entry) => {
                if (entry) _idbPut(_IDB_STORE_ATTRIBUTE, { ...entry, [l2SyncedKey]: true }).catch(() => {});
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };

    this.attributeCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_ATTRIBUTE, sku).catch(() => {});
      _erpCacheDelete('attribute', sku);
    };

    // ── richMedia 缓存(合并 entrypoint + composer,对齐 MY 富内容打分制) ──────────
    // 缓存对象:fetchPdpBundleViaBuyerTab 从 entrypoint-api + composer-api page-json 蒸馏的
    //   {
    //     mp4, richContent, richContentHasText, description, hashtags, gallery,  // media 字段
    //     fields: { title, sku, productId, price, images, coverImage, aspects, seller, brand, ... },
    //     widgetStates: object,  // 过滤后的 19 类业务 widget 子集(供 ensurePdpState 兜底)
    //     hitEndpoints: string[], // 实际命中的 endpoint 列表(诊断用)
    //   }
    // 策略:无 TTL(永久),缓存优先(命中直接返回,跳过 buyer tab 注入 + 网络请求)
    // L1 IndexedDB → L2 SQLite → L3 真调 entrypoint-api + composer-api
    this.richMediaCacheGet = async (sku) => {
      try {
        const l1 = await _idbGet(_IDB_STORE_RICH_MEDIA, sku);
        if (l1 && l1.data) return l1.data;
        const l2 = await _erpCacheGet('richMedia', sku);
        if (l2 && l2.data) {
          _idbPut(_IDB_STORE_RICH_MEDIA, {
            sku,
            data: l2.data,
            fetchedAt: Date.now(),
            l2Synced: true,
          }).catch(() => {});
          return l2.data;
        }
      } catch (e) {
        console.warn(`[cache] richMedia get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.richMediaCacheSet = (sku, data) => {
      _idbPut(_IDB_STORE_RICH_MEDIA, {
        sku,
        data,
        fetchedAt: Date.now(),
        l2Synced: false,
      }).catch(() => {});
      _erpCacheSetAndSyncFlag(_IDB_STORE_RICH_MEDIA, 'richMedia', sku, { data });
    };

    this.richMediaCacheDelete = (sku) => {
      _idbDelete(_IDB_STORE_RICH_MEDIA, sku).catch(() => {});
      _erpCacheDelete('richMedia', sku);
    };

    // ── marketStats 缓存(市场统计:销量/评价/排名等,24h stale) ───────────────────
    // 缓存对象:getMarketStats 真调返回的市场统计聚合
    // 策略:24h stale(marketStatsStaleMs 从 loadAutoCollectConfig 读取),
    //   stale 时仍返回记录(含 stale=true),由调用方决定是否刷新。
    // L1 IndexedDB → L2 SQLite → 失败返回 null
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
    // L1 IndexedDB → L2 SQLite → 失败返回 null
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

    // ── 定时补写 L2:扫描 L1 中未同步的记录 ──────────────────────────
    // 由 chrome.alarms 每 5 分钟触发,不受 SW 休眠影响。
    // 扫描范围:
    //   1) 新 5 个 store(dom/attribute/richMedia/marketStats/followSell):补写 l2Synced=false 的 type
    //   2) 旧 4 个 store(search/bundle/card/detail):迁移到新 L2 路由,成功后删除旧 L1 记录
    //      composer/entrypoint 旧 store 已被 richMedia 替代,不再迁移(数据自然过期)
    // forceAll=true:全量同步(忽略 l2Synced 标志),由 popup 手动按钮触发
    // forceAll=false(默认):只补写 l2Synced=false 的记录,由定时 alarm 触发
    this.syncL2Batch = async (forceAll = false) => {
      if (S.cacheSyncRunning)
        return {
          dom: 0,
          attribute: 0,
          richMedia: 0,
          marketStats: 0,
          followSell: 0,
          migrated: 0,
        };
      S.cacheSyncRunning = true;
      const stats = {
        dom: 0,
        attribute: 0,
        richMedia: 0,
        marketStats: 0,
        followSell: 0,
        migrated: 0,
      };
      try {
        // 1) 新 store:dom/attribute(合并表,按 type 分别补写)
        const domUnsynced = await _idbScanMergedUnsynced(_IDB_STORE_DOM, forceAll).catch(() => []);
        for (const item of domUnsynced) {
          const ok = await _erpCacheSet('dom', item.sku, { type: item.type, data: item.data });
          if (ok) {
            const l2SyncedKey = `${item.type}L2Synced`;
            const existing = await _idbGet(_IDB_STORE_DOM, item.sku).catch(() => null);
            if (existing) {
              await _idbPut(_IDB_STORE_DOM, { ...existing, [l2SyncedKey]: true }).catch(() => {});
            }
            stats.dom++;
          }
        }

        const attrUnsynced = await _idbScanMergedUnsynced(_IDB_STORE_ATTRIBUTE, forceAll).catch(() => []);
        for (const item of attrUnsynced) {
          const body = { type: item.type, data: item.data };
          if (item.type === 'bundle' && item.bundleId != null) body.bundleId = item.bundleId;
          const ok = await _erpCacheSet('attribute', item.sku, body);
          if (ok) {
            const l2SyncedKey = `${item.type}L2Synced`;
            const existing = await _idbGet(_IDB_STORE_ATTRIBUTE, item.sku).catch(() => null);
            if (existing) {
              await _idbPut(_IDB_STORE_ATTRIBUTE, { ...existing, [l2SyncedKey]: true }).catch(() => {});
            }
            stats.attribute++;
          }
        }

        // 2) 新 store:richMedia/marketStats/followSell(单 l2Synced 标志)
        for (const { store, type } of [
          { store: _IDB_STORE_RICH_MEDIA, type: 'richMedia' },
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

        // 3) 旧 store 迁移:search/bundle → attribute,card/detail → dom
        //    成功后删除旧 L1 记录(避免重复迁移)
        //    composer/entrypoint 不迁移(已被 richMedia 替代)
        const legacyMappings = [
          { store: _IDB_STORE_SEARCH, type: 'attribute', subType: 'search' },
          { store: _IDB_STORE_BUNDLE, type: 'attribute', subType: 'bundle' },
          { store: _IDB_STORE_CARD, type: 'dom', subType: 'card' },
          { store: _IDB_STORE_DETAIL, type: 'dom', subType: 'detail' },
        ];
        for (const { store, type, subType } of legacyMappings) {
          const all = await _idbScanUnsynced(store, true).catch(() => []);
          for (const entry of all) {
            const body = { type: subType, data: entry.data };
            if (subType === 'bundle' && entry.bundleId != null) body.bundleId = entry.bundleId;
            const ok = await _erpCacheSet(type, entry.sku, body);
            if (ok) {
              await _idbDelete(store, entry.sku).catch(() => {});
              stats.migrated++;
            }
          }
        }

        const total = stats.dom + stats.attribute + stats.richMedia + stats.marketStats + stats.followSell + stats.migrated;
        if (total > 0)
          console.log(
            `[cache-sync] 补写 ${total} 条 L2 缓存 (dom=${stats.dom}, attribute=${stats.attribute}, richMedia=${stats.richMedia}, marketStats=${stats.marketStats}, followSell=${stats.followSell}, migrated=${stats.migrated}, forceAll=${forceAll})`
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
