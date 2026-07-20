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
 *   - ERP SQLite 缓存封装(/ozon/cache/{dom|attribute|richMedia|marketStats|followSell}/:sku,JWT 鉴权)
 *   - 5 类业务缓存 Get/Set/Delete(dom/attribute/richMedia/marketStats/followSell)
 *     · dom: type='card'|'detail' 参数区分,合并表字段独立
 *     · attribute: type='search'|'bundle' 参数区分,合并表字段独立,bundle 含 6h 空属性重验
 *   - 自动采集日志(fire-and-forget 写入 ERP)
 *
 * 架构变更(2026-07):
 *   取消 L1 IndexedDB 缓存层,所有缓存直接入库 SQLite。
 *   原双层架构(L1 IDB + L2 SQLite)简化为单层(SQLite only)。
 *   理由:SW 休眠后 IDB 连接不稳定、双层同步逻辑复杂、SQLite 已足够快。
 *   代价:每次缓存查询走 HTTP,延迟略增(可接受);网络失败时本次数据丢弃(下次采集重写)。
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupCache = function () {
    const sw = this._sw;
    const S = this.state;

    // ── 常量 ──────────────────────────────────────────────────────────────────
    const _ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验

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

    // ── ERP SQLite 缓存封装 ───────────────────────────────────────────────────
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

    // ── 批量缓存命中位查询 ────────────────────────────────────────────────────
    // POST /ozon/cache/status-batch,一次 HTTP 查多 SKU × 5 类缓存的命中位矩阵。
    // 替代原来对每个 SKU 调 _queryCacheStatusOne(7 次 HTTP)的 N×7 模式。
    // 返回: { [sku]: { dom, attribute, richMedia, marketStats, followSell } }(全 boolean)
    // 失败返回 null,调用方需兜底。
    this.batchCacheStatus = async (skus) => {
      if (!Array.isArray(skus) || !skus.length) return {};
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const r = await sw.apiRequest(
          'POST',
          `${url}/ozon/cache/status-batch`,
          { skus: skus.map(String).filter(Boolean).slice(0, 200) },
          stored[sw.STORAGE_KEYS.token]
        );
        return r || null;
      } catch (e) {
        console.warn('[cache] batch status failed:', e?.message || e);
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

    // ── 浅度采集日志:fire-and-forget 写入 ERP(带 JWT) ─────────────────────────
    // 由 ozon-data-panel.js 的 onCardExtracted 回调上报(每个发现的 SKU 一条)。
    // 调用方不应 await(不阻塞主流程),失败仅 warn 不影响采集结果。
    // payload: { sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
    //   passesFilter, skipReason, source }
    const _writeShallowCollectLog = async (payload) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest('POST', `${url}/admin/api/shallow-collect/log`, payload, stored[sw.STORAGE_KEYS.token]);
      } catch (e) {
        console.warn('[shallow-collect-log] write failed:', e?.message || e);
      }
    };

    // ── 暴露 ERP 基础操作给外部 ──
    this.erpCacheGet = _erpCacheGet;
    this.erpCacheSet = _erpCacheSet;
    this.erpCacheDelete = _erpCacheDelete;
    this.bundleUsable = _bundleUsable;
    this.writeAutoCollectLog = _writeAutoCollectLog;
    this.writeShallowCollectLog = _writeShallowCollectLog;
    this.ATTRS_EMPTY_REVERIFY_MS = _ATTRS_EMPTY_REVERIFY_MS;
    // loadAutoCollectConfig 由 SW 桥接传入(marketStats/followSell 缓存的 stale 判定需要读取配置)
    this.loadAutoCollectConfig = sw.loadAutoCollectConfig;

    // ── dom 缓存(card + detail 合并表,字段独立,互相备份) ─────────────────────────
    // 缓存对象:
    //   card:搜索页/店铺页 extractCardInfo() 返回的基础 5 字段(sku/url/name/price/image)
    //   detail:extractProductData() 返回的详情页 DOM 全字段(title/images/sku/productId/...)
    // 策略:无 TTL(永久),搜索页/店铺页采集时写 card,详情页采集时写 detail,全览展示 + OPI 预览 fallback
    // 直接入库 SQLite,POST /ozon/cache/dom/:sku body: { type: 'card'|'detail', data }
    // GET /ozon/cache/dom/:sku 返回 { card, detail, cardFetchedAt, detailFetchedAt }
    this.domCacheGet = async (sku, type) => {
      // type: 'card' | 'detail'
      try {
        const l2 = await _erpCacheGet('dom', sku);
        if (l2) {
          const data = type === 'card' ? l2.card : l2.detail;
          if (data) return data;
        }
      } catch (e) {
        console.warn(`[cache] dom ${type} get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.domCacheSet = (sku, type, data) => {
      // type: 'card' | 'detail'
      // 直接入库 SQLite(失败仅 warn,本次数据丢弃,下次采集重写)
      _erpCacheSet('dom', sku, { type, data }).catch(() => {});
    };

    this.domCacheDelete = (sku) => {
      _erpCacheDelete('dom', sku);
    };

    // ── attribute 缓存(search + bundle 合并表,字段独立) ─────────────────────────
    // 缓存对象:
    //   search:/api/v1/search 归一化后的 items 数组(含基础元数据 + 物理 attrs 兜底)
    //   bundle:/api/site/seller-prototype/create-bundle-by-variant-id 返回的 item
    //          (含完整 attributes 40-63 个 + weight/depth/width/height + barcode)
    // 策略:无 TTL(永久),bundle 空属性 6h 重验;forceRefresh 主动删除
    // 直接入库 SQLite,POST /ozon/cache/attribute/:sku body: { type: 'search'|'bundle', data, bundleId? }
    // GET /ozon/cache/attribute/:sku 返回 { searchData, bundleData, searchFetchedAt,
    //   bundleFetchedAt, bundleId, attrsEmptyVerifiedAt, stale }
    //
    // 返回形状:
    //   type='search' → searchData(原始 items 对象)
    //   type='bundle' → { data, bundleId, attrsEmptyVerifiedAt, fetchedAt }
    this.attributeCacheGet = async (sku, type) => {
      // type: 'search' | 'bundle'
      try {
        const l2 = await _erpCacheGet('attribute', sku);
        if (l2) {
          if (type === 'search') {
            if (l2.searchData) return l2.searchData;
          } else {
            // type === 'bundle'
            if (l2.bundleData) {
              const fetchedAt = l2.bundleFetchedAt
                ? new Date(l2.bundleFetchedAt).getTime()
                : 0;
              const verifiedAt = l2.attrsEmptyVerifiedAt
                ? new Date(l2.attrsEmptyVerifiedAt).getTime()
                : null;
              return {
                data: l2.bundleData,
                bundleId: l2.bundleId || null,
                attrsEmptyVerifiedAt: verifiedAt,
                fetchedAt,
              };
            }
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
      const body = { type, data };
      if (type === 'bundle' && extra.bundleId != null) body.bundleId = extra.bundleId;
      // 直接入库 SQLite(失败仅 warn,本次数据丢弃,下次采集重写)
      _erpCacheSet('attribute', sku, body).catch(() => {});
    };

    this.attributeCacheDelete = (sku) => {
      _erpCacheDelete('attribute', sku);
    };

    // 按 type 删除 attribute 缓存(仅删 L2 中该 type 的字段,保留另一 type 的数据)
    // 应用场景:fetchBundleByVariantId forceRefresh=true 时只需失效 bundle,
    //   不应清掉刚由 searchVariants 写入的 searchData。
    // L2 限制:当前后端 DELETE /ozon/cache/attribute/:sku 是整条删,不支持 ?type=bundle,
    //   所以 L2 仍整条删。损失:L2 中刚写入的 searchData 丢失。
    //   这是当前后端限制下最稳妥的折衷(取消 L1 后无法从 L1 补回,但下次采集会重写)。
    this.attributeCacheDeleteType = (sku, type) => {
      // type: 'search' | 'bundle'(当前后端忽略 type,整条删)
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
    // 直接入库 SQLite,GET /ozon/cache/richMedia/:sku 返回 { data, fetchedAt } | { data: null }
    this.richMediaCacheGet = async (sku) => {
      try {
        const l2 = await _erpCacheGet('richMedia', sku);
        if (l2 && l2.data) return l2.data;
      } catch (e) {
        console.warn(`[cache] richMedia get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.richMediaCacheSet = (sku, data) => {
      // 直接入库 SQLite(失败仅 warn,本次数据丢弃,下次采集重写)
      _erpCacheSet('richMedia', sku, { data }).catch(() => {});
    };

    this.richMediaCacheDelete = (sku) => {
      _erpCacheDelete('richMedia', sku);
    };

    // ── marketStats 缓存(市场统计:销量/评价/排名等,24h stale) ───────────────────
    // 缓存对象:getMarketStats 真调返回的市场统计聚合
    // 策略:24h stale(marketStatsStaleMs 从 loadAutoCollectConfig 读取),
    //   stale 时仍返回记录(含 stale=true),由调用方决定是否刷新。
    // 直接入库 SQLite,GET /ozon/cache/marketStats/:sku 返回 { data, fetchedAt, l2Synced, stale } | { data: null }
    // 返回:{ data, fetchedAt, stale } | null
    this.marketStatsCacheGet = async (sku) => {
      try {
        const l2 = await _erpCacheGet('marketStats', sku);
        if (l2 && l2.data) {
          const cfg = await this.loadAutoCollectConfig();
          const staleMs = Number(cfg.marketStatsStaleMs) || 86400000;
          const fetchedAtMs = l2.fetchedAt ? new Date(l2.fetchedAt).getTime() : 0;
          const stale = !fetchedAtMs || Date.now() - fetchedAtMs > staleMs || l2.stale === true;
          return { data: l2.data, fetchedAt: fetchedAtMs, stale };
        }
      } catch (e) {
        console.warn(`[cache] marketStats get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.marketStatsCacheSet = (sku, data) => {
      // 直接入库 SQLite(失败仅 warn,本次数据丢弃,下次采集重写)
      _erpCacheSet('marketStats', sku, { data }).catch(() => {});
    };

    this.marketStatsCacheDelete = (sku) => {
      _erpCacheDelete('marketStats', sku);
    };

    // ── followSell 缓存(跟卖预取结果,4h stale) ──────────────────────────────
    // 缓存对象:followSell 预取的跟卖可用性 / 竞品数据
    // 策略:4h stale(followSellStaleMs 从 loadAutoCollectConfig 读取),
    //   stale 时仍返回记录(含 stale=true),由调用方决定是否刷新。
    // 直接入库 SQLite,GET /ozon/cache/followSell/:sku 返回 { data, fetchedAt, l2Synced, stale } | { data: null }
    // 返回:{ data, fetchedAt, stale } | null
    this.followSellCacheGet = async (sku) => {
      try {
        const l2 = await _erpCacheGet('followSell', sku);
        if (l2 && l2.data) {
          const cfg = await this.loadAutoCollectConfig();
          const staleMs = Number(cfg.followSellStaleMs) || 14400000;
          const fetchedAtMs = l2.fetchedAt ? new Date(l2.fetchedAt).getTime() : 0;
          const stale = !fetchedAtMs || Date.now() - fetchedAtMs > staleMs || l2.stale === true;
          return { data: l2.data, fetchedAt: fetchedAtMs, stale };
        }
      } catch (e) {
        console.warn(`[cache] followSell get failed sku=${sku}:`, e?.message || e);
      }
      return null;
    };

    this.followSellCacheSet = (sku, data) => {
      // 直接入库 SQLite(失败仅 warn,本次数据丢弃,下次采集重写)
      _erpCacheSet('followSell', sku, { data }).catch(() => {});
    };

    this.followSellCacheDelete = (sku) => {
      _erpCacheDelete('followSell', sku);
    };
  };
})();
