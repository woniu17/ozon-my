/* =========================================================
 * 采集 Tab/限流/编排层(采集代码隔离 Phase 3)
 *
 * 从 service-worker.js 提取的 Tab 管理 / 限流层 / 跨域快路 / B 类真调 /
 * 并发限流 / _doAutoCollect 核心编排代码,采用 init 桥接模式:
 *   - 注册 globalThis.__jzCollect.setupTab 函数
 *   - 由 __jzCollect.init() 在 IIFE 工具函数就绪后调用
 *   - 通过 this._sw 访问 SW 工具(getBackendUrl/apiRequest/getStorage/setStorage/
 *     STORAGE_KEYS/loadAutoCollectConfig/IS_TEST_MODE/OZON_WWW_ORIGIN/
 *     OZON_SELLER_ORIGIN/testModeReady/maybeStartConsume)
 *   - 通过 this.state.xxx 访问采集运行时状态(autoCollectRunning/autoCollectQueue/
 *     sellerPortalGateChain/sellerPortalLastAt)
 *   - 通过 this.xxx 访问缓存层 / 配置层 / Runner / 队列层暴露的函数
 *
 * 覆盖范围:
 *   - B 类纯函数(normalizeMarketItem/_isRichDoc/_extract*FromStates)
 *   - Tab 管理(_ensureSellerTabImpl/ensureSellerTab/ensureBuyerTab)
 *   - 限流层(_sellerPortalGate + sellerPortalGateChain/sellerPortalLastAt 状态)
 *   - 跨域快路(fetchSellerViaOzonTab/fetchSellerPortal)
 *   - B 类真调函数(fetchBundleByVariantId/transferVideoToOzon/
 *     fetchVariantMediaViaBuyerTab/_fetchMarketStatsDirect)
 *   - 并发限流(_acquireAutoCollectSlot/_releaseAutoCollectSlot +
 *     autoCollectRunning/autoCollectQueue 状态)
 *   - 核心编排(_doAutoCollect 8 步编排)
 *
 * 暂留 service-worker.js(编排层,调用 _doAutoCollect):
 *   - _processTask / _consumeOne / _maybeStartConsume(依赖 _doAutoCollect,
 *     通过委托包装器调用本层函数)
 *   - onMessage handler(通过委托包装器调用 fetchSellerPortal 等)
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupTab = function () {
    const sw = this._sw;
    const S = this.state;

    // ── 常量 ──────────────────────────────────────────────────────────────────
    const SELLER_PORTAL_MIN_INTERVAL_MS = 200;
    const _AUTO_COLLECT_MAX_CONCURRENT = 3;
    const _AUTO_COLLECT_QUEUE_TIMEOUT_MS = 60_000;

    // ── B 类纯函数 ─────────────────────────────────────────────────────────────
    // what_to_sell/data/v3 单条 item 字段归一 —— 防 Ozon 改大小写/命名导致「月销量等市场
    // 字段全空但无报错横幅」的静默回归。下游(shared-utils jzPopulatePanelV2 / jzMergeCardPanelData)
    // 只读固定 camelCase(d.soldCount / d.gmvSum / d.salesDynamics ...);后端 ozon-market-data
    // .service.ts:normalizeProductItem 早已对 SoldCount/GmvSum 等 PascalCase 做兜底,扩展这条
    // 直连路一直没做 → 这里对齐后端口径。spread 原 item 保留所有已有字段(零回归),只对会被
    // 下游消费的字段补「camelCase ?? PascalCase ?? snake_case」别名,缺失才回填、绝不覆盖已有值。
    const normalizeMarketItem = (item) => {
      if (!item || typeof item !== 'object') return item;
      const pick = (...keys) => {
        for (const k of keys) if (item[k] != null) return item[k];
        return undefined;
      };
      return {
        ...item,
        // 核心销量/金额
        soldCount: pick('soldCount', 'SoldCount', 'sold_count', 'sales', 'Sales'),
        gmvSum: pick('gmvSum', 'GmvSum', 'gmv_sum', 'revenue', 'Revenue'),
        avgPrice: pick('avgPrice', 'AvgGmv', 'avgGmv', 'avg_price', 'price', 'Price'),
        salesDynamics: pick('salesDynamics', 'SalesDynamics', 'sales_dynamics'),
        drr: pick('drr', 'Drr', 'DRR'),
        // 日均
        avgOrdersOnAccDays: pick('avgOrdersOnAccDays', 'AvgOrdersOnAccDays', 'avg_orders_on_acc_days'),
        avgGmvOnAccDays: pick('avgGmvOnAccDays', 'AvgGmvOnAccDays', 'avg_gmv_on_acc_days'),
        // 促销与推广
        daysInPromo: pick('daysInPromo', 'DaysInPromo', 'days_in_promo'),
        discount: pick('discount', 'Discount'),
        promoRevenueShare: pick('promoRevenueShare', 'PromoRevenueShare'),
        daysWithTrafarets: pick('daysWithTrafarets', 'DaysWithTrafarets'),
        // 流量与转化
        qtyViewPdp: pick('qtyViewPdp', 'QtyViewPdp', 'qty_view_pdp'),
        sessionCount: pick('sessionCount', 'SessionCount', 'session_count'),
        sessionCountSearch: pick('sessionCountSearch', 'SessionCountSearch', 'session_count_search'),
        pdpToCartConversion: pick('pdpToCartConversion', 'PdpToCartConversion'),
        convToCartPdp: pick('convToCartPdp', 'ConvToCartPdp'),
        convToCartSearch: pick('convToCartSearch', 'ConvToCartSearch'),
        convViewToOrder: pick('convViewToOrder', 'ConvViewToOrder'),
        views: pick('views', 'Views'),
        // 物流与商品
        stock: pick('stock', 'Stock', 'balance'),
        salesSchema: pick('salesSchema', 'SalesSchema', 'sales_schema'),
        nullableRedemptionRate: pick('nullableRedemptionRate', 'NullableRedemptionRate', 'redemptionRate'),
        nullableCreateDate: pick('nullableCreateDate', 'NullableCreateDate', 'createDate', 'CreateDate'),
      };
    };

    // 借买家 tab 抓某商品 PDP 的 webGallery .mp4 直链 + 源富内容(11254 文档)+ 源描述(4191)
    // + 源主题标签(23171)。给 batch-upload 逐 SKU 用:扩展页无 ozon.ru content_script,只能经
    // ensureBuyerTab 注入 fetch。/api/v1/search 不返 4191/11254/23171,这三样只活在 PDP 的
    // webDescription/富内容/webHashtags widget,故与视频同一次 page json 一并抽,零增量请求 ——
    // 让批量上架继承源店铺描述与标签(与手动跟卖 extractPageDescription/extractKeywords 同语义)。
    // 注:源标签裸下发会触发 Ozon BR_hashtag_brand,品牌清洗在 backend 注入处做(此处只负责抓回)。
    // 返回 { mp4, richContent, description, hashtags };失败返回全空(best-effort 降级)。
    // ── page-json widgetStates 共享抽取器(供缓存复用路径 + doFetch 内联版本共用) ──
    // 注:doFetch 在 buyer tab MAIN world 执行,其内联版可访问 globalThis.JZOzonVideoExtract
    // 和 globalThis.JZFollowSellContentCopy;SW 顶层共享版不依赖这些 helper(仅扫结构化数据)。
    const _isRichDoc = (o) =>
      o &&
      typeof o === 'object' &&
      Array.isArray(o.content) &&
      o.content.length > 0 &&
      o.content.some((b) => b && typeof b === 'object' && typeof b.widgetName === 'string');

    const _extractRichFromStates = (states) => {
      for (const k of Object.keys(states)) {
        let v = states[k];
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            continue;
          }
        }
        if (!v || typeof v !== 'object') continue;
        if (typeof v.richAnnotationJson === 'string' && v.richAnnotationJson.trim()) {
          try {
            if (_isRichDoc(JSON.parse(v.richAnnotationJson))) return v.richAnnotationJson.trim();
          } catch {}
        }
        if (_isRichDoc(v)) return JSON.stringify({ content: v.content, version: v.version || 0.3 });
      }
      return '';
    };

    const _extractMp4FromStates = (states) => {
      for (const k of Object.keys(states || {})) {
        if (!/gallery/i.test(k)) continue;
        let v = states[k];
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            continue;
          }
        }
        const vids = v && Array.isArray(v.videos) ? v.videos : [];
        for (const it of vids) {
          const raw = typeof it === 'string' ? it : (it && (it.url || it.src)) || '';
          if (raw && /\.mp4(\?|#|$)/i.test(raw)) return raw;
        }
      }
      return null;
    };

    const _extractDescriptionFromStates = (states) => {
      // SW 顶层无 JZFollowSellContentCopy helper,直接从 webDescription widget 抽 text 字段
      const keys = Object.keys(states || {});
      const descKeys = keys.filter((k) => /description/i.test(k));
      for (const k of descKeys) {
        let v = states[k];
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            continue;
          }
        }
        if (!v || typeof v !== 'object') continue;
        // webDescription widget 通常有 text/html 字段
        const text = v.text || v.html || v.content || '';
        if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 4096);
      }
      return '';
    };

    const _extractHashtagsFromStates = (states) => {
      const out = [];
      const seen = new Set();
      const push = (s) => {
        const t = String(s == null ? '' : s).trim();
        if (!t || t.length < 2 || !t.startsWith('#')) return;
        const key = t.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (out.length < 30) out.push(t);
      };
      const walk = (node, depth) => {
        if (out.length >= 30 || depth > 32 || node == null) return;
        if (typeof node === 'string') {
          push(node);
          return;
        }
        if (Array.isArray(node)) {
          for (const it of node) walk(it, depth + 1);
          return;
        }
        if (typeof node === 'object') {
          for (const k of Object.keys(node)) walk(node[k], depth + 1);
        }
      };
      for (const k of Object.keys(states || {})) {
        if (!/hashtag|taglist/i.test(k)) continue;
        let v = states[k];
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            continue;
          }
        }
        walk(v, 0);
      }
      return out;
    };

    // ── 从 widgetStates 提取图册(供 entrypoint 缓存写入时用) ──
    const _extractGalleryFromStates = (states) => {
      let bestImages = [];
      let bestCover = null;
      for (const k of Object.keys(states)) {
        let v = states[k];
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            continue;
          }
        }
        if (!v || typeof v !== 'object') continue;
        if (!Array.isArray(v.images)) continue;
        if (v.images.length > bestImages.length) {
          bestImages = v.images;
          bestCover = v.coverImage || null;
        }
      }
      // upgrade 到 wc1000 + 去重
      const upgrade = (u) =>
        typeof u === 'string' && u.includes('ir.ozone.ru') ? u.replace(/\/wc\d+\//, '/wc1000/') : u;
      const norm = (u) =>
        String(u || '')
          .split('?')[0]
          .split('#')[0]
          .toLowerCase();
      const seen = new Set();
      const out = [];
      const push = (raw) => {
        const upgraded = upgrade(raw);
        if (!upgraded) return;
        const n = norm(upgraded);
        if (seen.has(n)) return;
        seen.add(n);
        out.push(upgraded);
      };
      if (bestCover) push(bestCover);
      for (const img of bestImages) {
        const u = typeof img === 'string' ? img : img?.src || img?.url || img?.image;
        if (u) push(u);
      }
      return out;
    };

    // ── Tab 管理 ───────────────────────────────────────────────────────────────
    /**
     * 返回一个 status='complete' 的 seller.ozon.ru tab,优先 /app/* 路径
     * (避免命中 signin/login 中间页)。没有就自动后台打开 pinned tab 并等加载完成,
     * 用户首次跟卖时会看到一个 pinned 短标签,无须手动打开。
     *
     * caller 应直接用返回值,不要自己再 query+find,否则会引入
     * "等到了一个 complete 的,但 query 后却选了另一个 loading 的" 竞态。
     */
    // 内部实现;对外用下方带 single-flight 的 ensureSellerTab 包装。
    const _ensureSellerTabImpl = async (timeoutMs = 20000) => {
      const queryTabs = () => chrome.tabs.query({ url: sw.OZON_SELLER_ORIGIN + '/*' });
      // 2026-05-30:排除 signin/registration/auth/login 页 —— 它们的 URL 也含 /app/
      // (如 /app/registration/signin),旧 find(url.includes('/app/')) 会误选到登录页,
      // 注入后页面无有效会话 / SPA 拦截 fetch。优先选真业务页,auth 页排最后兜底。
      // (companyId 走域级 cookie 不依赖选哪个 tab,但选业务页注入更稳,也跟
      //  getMarketStats 的 tab 选择口径统一。)
      const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
      const pickReadyTab = (list) =>
        list.find((t) => t.status === 'complete' && t.url?.includes('/app/') && !isAuthUrl(t.url)) ||
        list.find((t) => t.status === 'complete' && !isAuthUrl(t.url)) ||
        list.find((t) => t.status === 'complete' && t.url?.includes('/app/')) ||
        list.find((t) => t.status === 'complete') ||
        null;

      let tabs = await queryTabs();
      let ready = pickReadyTab(tabs);
      if (ready) return ready;

      // 有 tab 但都在 loading → 等它们 complete;超时直接报错,不再新开 tab
      // (避免后台残留 pinned tab + 旧 tab 持续 loading 双重占用)
      if (tabs.length) {
        console.log('[ensureSellerTab] 已有 tab 但都在加载中，等待 complete...');
        const waitDeadline = Date.now() + timeoutMs;
        while (Date.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 500));
          tabs = await queryTabs();
          ready = pickReadyTab(tabs);
          if (ready) return ready;
          if (tabs.length === 0) break; // 全被关 → 落到下面 create
        }
        // 等待超时(旧 tab 仍 loading)→ 直接报错,不再新开
        if (tabs.length > 0) {
          throw new Error(`seller.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
        }
        console.warn('[ensureSellerTab] 已有 tab 全被关闭，新开一个');
      }

      console.log('[ensureSellerTab] 无可用 seller.ozon.ru tab，后台打开...');
      const created = await chrome.tabs.create({
        url: sw.OZON_SELLER_ORIGIN + '/app/products/copy/list',
        active: false,
        pinned: true,
      });

      const createDeadline = Date.now() + timeoutMs;
      while (Date.now() < createDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const t = await chrome.tabs.get(created.id);
          if (t.status === 'complete') {
            console.log(`[ensureSellerTab] tab ${created.id} 加载完成，url=${t.url}`);
            return t;
          }
        } catch {
          throw new Error('自动打开的 seller.ozon.ru tab 已被关闭');
        }
      }
      throw new Error(`seller.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
    };

    // single-flight 包装:并发调用(列表页多卡同时要市场数据/变体、或 fast-path 回退叠加)
    // 共享同一次"找或开 seller tab",避免各自 query→见无→create 把 seller tab 开出多个。
    // settle(成功/失败)即清缓存,允许该 tab 被关掉后下次重新开。
    let _ensureSellerTabInflight = null;
    const ensureSellerTab = (timeoutMs = 20000) => {
      if (_ensureSellerTabInflight) return _ensureSellerTabInflight;
      _ensureSellerTabInflight = _ensureSellerTabImpl(timeoutMs).finally(() => {
        _ensureSellerTabInflight = null;
      });
      return _ensureSellerTabInflight;
    };

    // 找/开一个 www.ozon.ru 买家 tab，用于在 MAIN world 跑 composer-api 抓 PDP 图册视频
    // （SW 直 fetch composer-api 反爬必死 403，必须借买家 tab 的 cookie/UA/fingerprint）。
    // 用于 batch-upload（扩展页发起、无 ozon.ru content_script sender）逐 SKU 抓竞品视频。
    const ensureBuyerTab = async (timeoutMs = 20000) => {
      const queryTabs = () =>
        chrome.tabs.query({
          url: sw.IS_TEST_MODE ? ['http://localhost:7777/*'] : ['https://www.ozon.ru/*', 'https://ozon.ru/*'],
        });
      const pickReady = (list) =>
        list.find((t) => t.status === 'complete' && /\/(product|category|search)\b/i.test(t.url || '')) ||
        list.find((t) => t.status === 'complete') ||
        null;
      let tabs = await queryTabs();
      let ready = pickReady(tabs);
      if (ready) return ready;
      // 有 tab 但都在 loading → 等它们 complete;超时直接报错,不再新开 tab
      // (反爬挑战页会一直 loading,新开 tab 只会加重反爬 + 残留 pinned tab)
      if (tabs.length) {
        const waitDeadline = Date.now() + timeoutMs;
        while (Date.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 500));
          tabs = await queryTabs();
          ready = pickReady(tabs);
          if (ready) return ready;
          if (tabs.length === 0) break; // 全被关 → 落到下面 create
        }
        if (tabs.length > 0) {
          throw new Error(`www.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
        }
        console.warn('[ensureBuyerTab] 已有 tab 全被关闭，新开一个');
      }
      console.log('[ensureBuyerTab] 无可用 www.ozon.ru tab，后台打开...');
      const created = await chrome.tabs.create({ url: sw.OZON_WWW_ORIGIN + '/', active: false, pinned: true });
      const createDeadline = Date.now() + timeoutMs;
      while (Date.now() < createDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const t = await chrome.tabs.get(created.id);
          if (t.status === 'complete') return t;
        } catch {
          throw new Error('自动打开的 www.ozon.ru tab 已被关闭');
        }
      }
      throw new Error(`www.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
    };

    // 把任意 .mp4 直链转存成卖家自有 Ozon 视频(ir.ozone.ru/s3):走 seller-tab MAIN world 会话
    // 上传 /api/media-storage/upload-file。返回 { ok, url } 或 { ok:false, error }。
    // 抽自原 uploadFollowSellVideo case,供「一键跟卖 / 单采 / 纯采集 / 批量上架」共用同一转存实现。
    const transferVideoToOzon = async (srcUrl) => {
      if (!srcUrl || typeof srcUrl !== 'string') return { ok: false, error: 'srcUrl required' };
      // 熔断期检查:反爬触发后不再开 seller tab,直接返失败
      if ((await this._isCircuitBreakerActive()).active) {
        return { ok: false, error: 'ANTIBOT_BLOCKED', message: '反爬熔断中,请稍后再试' };
      }
      const targetTab = await ensureSellerTab();
      const scCookies = await chrome.cookies.getAll({ url: sw.OZON_SELLER_ORIGIN + '/', name: 'sc_company_id' });
      const companyId = scCookies[0]?.value || '';
      if (!companyId) {
        return { ok: false, error: 'AUTH_REQUIRED', message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru' };
      }
      // 在 seller.ozon.ru tab 的 MAIN world 跑:跨源拉源 .mp4 → multipart 同源 POST(带 cookie)。
      const doUpload = async (src, xCompanyId, timeout) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const dl = await fetch(src, { signal: controller.signal });
          if (!dl.ok) {
            clearTimeout(timer);
            return { ok: false, error: '源视频下载失败 ' + dl.status };
          }
          const blob = await dl.blob();
          if (!blob || blob.size === 0) {
            clearTimeout(timer);
            return { ok: false, error: '源视频为空' };
          }
          const fname = (src.split('/').pop() || 'video.mp4').split('?')[0].split('#')[0] || 'video.mp4';
          const fd = new FormData();
          fd.append('file_name', fname);
          fd.append('tmp', 'true');
          fd.append('body', new File([blob], fname, { type: blob.type || 'video/mp4' }));
          const resp = await fetch('/api/media-storage/upload-file', {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: {
              accept: 'application/json, text/plain, */*',
              'x-o3-company-id': xCompanyId,
              'x-o3-language': 'zh-Hans',
            },
            body: fd,
          });
          clearTimeout(timer);
          if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
            return { ok: false, status: 401, error: 'Seller portal cookie已过期，请重新登录' };
          }
          if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            return { ok: false, status: resp.status, error: 'upload-file ' + resp.status + ': ' + t.slice(0, 200) };
          }
          const j = await resp.json().catch(() => null);
          return { ok: true, url: (j && j.url) || null, size: blob.size };
        } catch (e) {
          clearTimeout(timer);
          return { ok: false, error: e.name === 'AbortError' ? '上传超时' : e.message || String(e) };
        }
      };
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: doUpload,
          args: [srcUrl, companyId, 90000],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 95000)),
      ]);
      const r = results && results[0] && results[0].result;
      if (!r) return { ok: false, error: 'executeScript 未返回结果' };
      if (!r.ok || !r.url) return { ok: false, error: r.error || '上传未返回 url' };
      console.log(`[transferVideoToOzon] ${srcUrl} → ${r.url} (${r.size}B)`);
      return { ok: true, url: r.url };
    };

    // 借买家 tab 抓某商品 PDP 的 webGallery .mp4 直链 + 源富内容(11254 文档)+ 源描述(4191)
    // + 源主题标签(23171)。给 batch-upload 逐 SKU 用:扩展页无 ozon.ru content_script,只能经
    // ensureBuyerTab 注入 fetch。/api/v1/search 不返 4191/11254/23171,这三样只活在 PDP 的
    // webDescription/富内容/webHashtags widget,故与视频同一次 page json 一并抽,零增量请求 ——
    // 让批量上架继承源店铺描述与标签(与手动跟卖 extractPageDescription/extractKeywords 同语义)。
    // 注:源标签裸下发会触发 Ozon BR_hashtag_brand,品牌清洗在 backend 注入处做(此处只负责抓回)。
    // 返回 { mp4, richContent, description, hashtags };失败返回全空(best-effort 降级)。
    const fetchVariantMediaViaBuyerTab = async (productUrl, options = {}) => {
      const EMPTY = {
        mp4: null,
        richContent: '',
        description: '',
        hashtags: [],
        endpoint: null,
        errorReason: null,
      };
      if (!productUrl || typeof productUrl !== 'string') {
        EMPTY.errorReason = 'NO_PRODUCT_URL';
        return EMPTY;
      }
      let path = productUrl;
      try {
        const u = new URL(productUrl, sw.OZON_WWW_ORIGIN);
        path = u.pathname + u.search;
      } catch {}
      if (!path.startsWith('/')) path = '/' + path;

      // 从 path 提取 sku 用于缓存查询(/product/xxx-<sku>/)
      // 注意:只从 pathname 提取,不含 query string(card.url 可能带 ?_bctx=... 导致正则失配)
      const urlSku = (() => {
        try {
          const u = new URL(productUrl, sw.OZON_WWW_ORIGIN);
          return (u.pathname.match(/-(\d+)\/?$/) || [])[1] || '';
        } catch {
          return (path.match(/-(\d+)\/?$/) || [])[1] || '';
        }
      })();

      // ── 缓存优先:entrypoint + composer 都命中才直接返回 ──
      // entrypoint 缓存存蒸馏后的 { gallery, richContent, description, hashtags, mp4 }
      // composer 缓存存原始 widgetStates,需用同名抽取器解析
      // forceEntrypoint: 当 entrypoint 缓存为空但 composer 有数据时,仍真调 entrypoint-api 补全 entrypoint 缓存
      //
      // 重要:entrypoint 缓存命中但 composer 缓存不存在时,不能直接返回 — 否则 composer
      // 缓存永远不会被补全(doFetch 不执行 → 无 composerWidgetStates → 不写 composer 缓存),
      // 导致后续每次采集 composer 都显示 "-"(有记录无命中无错误)。
      // 修复:两个缓存都有才走缓存返回;缺一个就继续 doFetch 补全。
      if (urlSku && !options.forceEntrypoint) {
        let epCached = null;
        let ccCached = null;
        try {
          epCached = await this.entrypointCacheGet(urlSku);
        } catch {}
        try {
          ccCached = await this.composerCacheGet(urlSku);
        } catch {}
        console.log(
          '[fetchVariantMedia] 缓存检查:',
          urlSku,
          'ep=' + !!epCached,
          'cc=' + !!ccCached,
          'forceEntrypoint=' + !!options.forceEntrypoint
        );
        // 两个缓存都有 → 直接返回(entrypoint 缓存优先,HTTP 200 即缓存包括空内容)
        if (epCached && ccCached) {
          return {
            mp4: epCached.mp4 || null,
            richContent: epCached.richContent || '',
            description: epCached.description || '',
            hashtags: Array.isArray(epCached.hashtags) ? epCached.hashtags : [],
            endpoint: 'entrypoint-cache',
          };
        }
        // entrypoint 缓存有但 composer 没有 → 继续执行 doFetch 补全 composer 缓存
        // composer 缓存有但 entrypoint 没有 → 继续执行 doFetch 补全 entrypoint 缓存
        // 两个都没有 → 继续执行 doFetch
        // (doFetch 内部会依次试 entrypoint-api + composer-api,并写两个缓存)

        // composer 缓存单独命中且有内容 → 尝试用 composer 缓存返回(forceEntrypoint 时除外)
        if (ccCached && ccCached.widgetStates) {
          const states = ccCached.widgetStates;
          const richContent = _extractRichFromStates(states);
          const mp4 = _extractMp4FromStates(states);
          const description = _extractDescriptionFromStates(states);
          const hashtags = _extractHashtagsFromStates(states);
          if (richContent || mp4 || description || hashtags.length) {
            // 有内容但 entrypoint 缓存缺失 → 标记 endpoint 为 composer-cache,
            // doFetch 仍会执行(因为 epCached 为 null)来补全 entrypoint 缓存
            // 这里提前返回会让 doFetch 不执行,所以仅在 epCached 也存在时返回
            // 实际上 epCached 为 null 时走到这里,我们需要继续 doFetch
            // 所以这里不返回,继续执行 doFetch
          }
        }

        // cacheOnly 模式(熔断期):不真调,返回当前最佳 cache 数据或 EMPTY
        if (options.cacheOnly) {
          if (epCached) {
            return {
              mp4: epCached.mp4 || null,
              richContent: epCached.richContent || '',
              description: epCached.description || '',
              hashtags: Array.isArray(epCached.hashtags) ? epCached.hashtags : [],
              endpoint: 'entrypoint-cache',
            };
          }
          if (ccCached && ccCached.widgetStates) {
            const states = ccCached.widgetStates;
            return {
              mp4: _extractMp4FromStates(states),
              richContent: _extractRichFromStates(states),
              description: _extractDescriptionFromStates(states),
              hashtags: _extractHashtagsFromStates(states),
              endpoint: 'composer-cache',
            };
          }
          EMPTY.errorReason = 'CACHE_ONLY_MISS';
          return EMPTY;
        }
      }

      // cacheOnly 模式 + 无 urlSku(无法查 cache)→ 直接返空
      if (options.cacheOnly) {
        EMPTY.errorReason = 'CACHE_ONLY_MISS';
        return EMPTY;
      }

      let tab;
      try {
        tab = await ensureBuyerTab();
      } catch (e) {
        console.warn('[fetchVariantMedia] ensureBuyerTab 失败:', e?.message || e);
        EMPTY.errorReason = 'BUYER_TAB_FAILED:' + (e?.message || 'unknown');
        return EMPTY;
      }
      // MAIN world:相对路径同源命中(www.ozon.ru / ozon.kz),依次试 entrypoint→composer
      // (与 fetchOzonPublicProduct 同口径)。executeScript 序列化注入,不能引用 SW 闭包 ——
      // 富内容抽取逻辑须内联(与 content/ozon-product.js 的 jzExtractRichContentFromStates
      // 同规则:richAnnotationJson 字符串 / state 顶层 {content:[{widgetName}],version})。
      const doFetch = async (relPath, timeout) => {
        const endpoints = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(relPath)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(relPath)}`,
        ];
        const isRichDoc = (o) =>
          o &&
          typeof o === 'object' &&
          Array.isArray(o.content) &&
          o.content.length > 0 &&
          o.content.some((b) => b && typeof b === 'object' && typeof b.widgetName === 'string');
        const extractRich = (states) => {
          for (const k of Object.keys(states)) {
            let v = states[k];
            if (typeof v === 'string') {
              try {
                v = JSON.parse(v);
              } catch {
                continue;
              }
            }
            if (!v || typeof v !== 'object') continue;
            if (typeof v.richAnnotationJson === 'string' && v.richAnnotationJson.trim()) {
              try {
                if (isRichDoc(JSON.parse(v.richAnnotationJson))) return v.richAnnotationJson.trim();
              } catch {}
            }
            if (isRichDoc(v)) return JSON.stringify({ content: v.content, version: v.version || 0.3 });
          }
          return '';
        };
        const extractMp4 = (states) => {
          const helper = globalThis.JZOzonVideoExtract;
          if (helper && typeof helper.extractOzonMp4FromSources === 'function') {
            const found = helper.extractOzonMp4FromSources(Object.values(states || {}));
            if (found) return found;
          }
          for (const k of Object.keys(states || {})) {
            if (!/gallery/i.test(k)) continue;
            let v = states[k];
            if (typeof v === 'string') {
              try {
                v = JSON.parse(v);
              } catch {
                continue;
              }
            }
            const vids = v && Array.isArray(v.videos) ? v.videos : [];
            for (const it of vids) {
              const raw = typeof it === 'string' ? it : (it && (it.url || it.src)) || '';
              if (raw && /\.mp4(\?|#|$)/i.test(raw)) return raw;
            }
          }
          return null;
        };
        // 源描述(4191):优先 webDescription widget,复用注入的 JZFollowSellContentCopy.extractDescriptionText
        // (与手动跟卖同一套富文本/HTML 解析,绝不把原始 JSON 串当描述)。helper 注入失败则降级空。
        const extractDescription = (states) => {
          const helper = globalThis.JZFollowSellContentCopy;
          if (!helper || typeof helper.extractDescriptionText !== 'function') return '';
          const keys = Object.keys(states || {});
          const descKeys = keys.filter((k) => /description/i.test(k));
          for (const k of descKeys) {
            let v = states[k];
            if (typeof v === 'string') {
              try {
                v = JSON.parse(v);
              } catch {
                /* 当字符串直接抽 */
              }
            }
            const text = helper.extractDescriptionText(v, 4096);
            if (text) return text;
          }
          return '';
        };
        // 源主题标签(23171):从 webHashtags/tagList state 里递归捞 `#` 前缀串。纯内联(无 helper 依赖),
        // 去重 + 上限 30(Ozon 单卡上限)。品牌清洗在 backend 注入处做,这里只负责把源标签原样抓回。
        const extractHashtags = (states) => {
          const out = [];
          const seen = new Set();
          const push = (s) => {
            const t = String(s == null ? '' : s).trim();
            if (!t || t.length < 2 || !t.startsWith('#')) return;
            const key = t.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            if (out.length < 30) out.push(t);
          };
          const walk = (node, depth) => {
            if (out.length >= 30 || depth > 32 || node == null) return;
            if (typeof node === 'string') {
              push(node);
              return;
            }
            if (Array.isArray(node)) {
              for (const it of node) walk(it, depth + 1);
              return;
            }
            if (typeof node === 'object') {
              for (const k of Object.keys(node)) walk(node[k], depth + 1);
            }
          };
          for (const k of Object.keys(states || {})) {
            if (!/hashtag|taglist/i.test(k)) continue;
            let v = states[k];
            if (typeof v === 'string') {
              try {
                v = JSON.parse(v);
              } catch {
                continue;
              }
            }
            walk(v, 0);
          }
          return out;
        };
        let anyOk = false;
        let hitEndpoint = null;
        let richContent = '';
        let mp4 = null;
        let description = '';
        let hashtags = [];
        // 合并所有成功 endpoint 的 widgetStates(SW 侧用于抽 composer fields + 写缓存)
        const composerWidgetStates = {};
        // 收集每个 endpoint 的失败原因(全失败时用于细化 NO_ENDPOINT)
        const failReasons = [];
        for (const url of endpoints) {
          const epName = url.includes('entrypoint-api') ? 'entrypoint' : 'composer';
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const resp = await fetch(url, {
              credentials: 'include',
              headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
              signal: controller.signal,
            });
            clearTimeout(timer);
            if (!resp.ok) {
              failReasons.push(`${epName}:HTTP_${resp.status}`);
              continue;
            }
            anyOk = true;
            const data = await resp.json();
            const states = data && data.widgetStates ? data.widgetStates : {};
            if (!hitEndpoint) hitEndpoint = url.includes('entrypoint-api') ? 'entrypoint-api' : 'composer-api';
            if (!richContent) richContent = extractRich(states);
            if (!mp4) mp4 = extractMp4(states);
            if (!description) description = extractDescription(states);
            if (!hashtags.length) hashtags = extractHashtags(states);
            // 合并 widgetStates(后端覆盖前端,用于 SW 侧抽 composer fields)
            for (const k of Object.keys(states)) composerWidgetStates[k] = states[k];
            // 视频 + 富内容都到手即可提前结束(描述/标签随当前 states 顺带抽,不单独多跑 endpoint);
            // 否则继续试下一个 endpoint(视频/富内容偶尔只在 composer 而不在 entrypoint)。
            if (mp4 && richContent) break;
          } catch (e) {
            clearTimeout(timer);
            // 单个 endpoint 失败 → 试下一个。区分超时/网络错误
            const reason =
              e?.name === 'AbortError' ? `${epName}:TIMEOUT` : `${epName}:NET_${(e?.message || 'error').slice(0, 60)}`;
            failReasons.push(reason);
          }
        }

        // ── fetch 2:跟卖 modal endpoint(三合一改造) ──
        // /api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>
        // 解析 webSellerList widget,抽取 {count, sellers, source}。
        // 仅 HTTP 200 才写缓存(零跟卖/解析失败也写,避免重复真调);
        // HTTP 非 200(403/5xx 等)视为失败,不写缓存(允许后续重试),与内容侧行为对齐。
        // 注意:relPath = pathname + search,可能带 ?query=... 后缀,
        // 不能用 /-(\d+)\/?$/ 匹配(结尾是 query string 不是 -数字/),
        // 需先去 query 再从 pathname 提取 SKU。
        const _fsPath = relPath.split('?')[0];
        const fsSku = (_fsPath.match(/-(\d+)\/?$/) || [])[1] || '';
        let followSellData = null;
        if (fsSku) {
          try {
            const inner = `/modal/otherOffersFromSellers?product_id=${fsSku}`;
            const fsUrl = `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(inner)}`;
            const fsController = new AbortController();
            const fsTimer = setTimeout(() => fsController.abort(), timeout);
            const fsResp = await fetch(fsUrl, {
              credentials: 'include',
              headers: {
                'x-o3-app-name': 'dweb_client',
                'x-o3-language': 'ru', // 与内容侧对齐,避免 BFF 返回不同 shape
                accept: 'application/json',
              },
              signal: fsController.signal,
            });
            clearTimeout(fsTimer);
            if (fsResp.ok) {
              const fsData = await fsResp.json();
              const fsStates = fsData && fsData.widgetStates ? fsData.widgetStates : {};
              const wslKey = Object.keys(fsStates).find((k) => k.startsWith('webSellerList'));
              if (!wslKey) {
                // modal 正常加载但无 webSellerList widget — 零跟卖商品
                followSellData = { count: 0, sellers: [], source: 'no-sellers' };
              } else {
                let wsl = fsStates[wslKey];
                if (typeof wsl === 'string') {
                  try {
                    wsl = JSON.parse(wsl);
                  } catch {
                    followSellData = { count: 0, sellers: [], source: 'parse-fail' };
                  }
                }
                if (!followSellData) {
                  const rawSellers = Array.isArray(wsl?.sellers) ? wsl.sellers : [];
                  const normSeller = (item) => {
                    if (!item || typeof item !== 'object') return null;
                    const txt = (v) =>
                      typeof v === 'string'
                        ? v.trim()
                        : v && typeof v === 'object' && v.text
                          ? String(v.text).trim()
                          : '';
                    const name =
                      txt(item.name) || txt(item.sellerName) || txt(item.seller?.name) || txt(item.title) || '';
                    const priceRaw =
                      item.price?.cardPrice?.price ?? item.price?.cardPrice ?? item.price ?? item.finalPrice ?? '';
                    const price = txt(priceRaw);
                    if (!name && !price) return null;
                    const link =
                      (typeof item.productLink === 'string' ? item.productLink : '') ||
                      item.link?.action?.link ||
                      item.link?.link ||
                      item.link ||
                      '';
                    const avatar =
                      (typeof item.avatar === 'string' ? item.avatar : '') || item.avatar?.url || item.logo?.url || '';
                    const rating =
                      item.rating?.totalScore ?? item.rating?.value ?? item.rating ?? item.sellerRating ?? null;
                    const reviewsCount = item.rating?.reviewsCount ?? item.reviewsCount ?? item.reviewCount ?? null;
                    return {
                      name,
                      price,
                      sku: txt(item.sku) || txt(item.id) || txt(item.skuId),
                      link: typeof link === 'string' ? link : '',
                      avatar: typeof avatar === 'string' ? avatar : '',
                      rating: Number.isFinite(Number(rating)) ? Number(rating) : null,
                      reviewsCount: Number.isFinite(Number(reviewsCount)) ? Number(reviewsCount) : null,
                      region: txt(item.region) || txt(item.location),
                      deliveryText: txt(item.deliveryText) || txt(item.delivery?.text),
                      deliveryRank: null,
                    };
                  };
                  const sellers = rawSellers.map(normSeller).filter(Boolean);
                  followSellData = { count: rawSellers.length, sellers, source: 'modal' };
                }
              }
            } else {
              // HTTP 非 200(403/5xx 等)视为失败,不写缓存(允许后续重试)
              console.warn('[fetchVariantMedia] followSell modal HTTP', fsResp.status, 'sku=', fsSku);
              followSellData = null;
            }
          } catch (e) {
            // modal fetch 网络失败 / 超时 — 不写 no-sellers(允许后续重试)
            followSellData = null;
          }
        }

        // 有 200 过则按真实抽取结果返回;全失败则 ok:false。
        // 三合一改造:额外返回 composerWidgetStates(SW 抽 fields)+ followSellData
        // 全失败时返回 failReasons(细化 NO_ENDPOINT:HTTP 状态码/超时/网络错误)
        return anyOk
          ? {
              ok: true,
              mp4,
              richContent,
              description,
              hashtags,
              endpoint: hitEndpoint,
              composerWidgetStates,
              followSellData,
            }
          : {
              ok: false,
              error: 'all endpoints failed',
              failReasons: failReasons.length ? failReasons.join('|') : 'NO_REQUEST_ATTEMPTED',
              followSellData,
            };
      };
      try {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['lib/ozon-video-extract.js'],
            world: 'MAIN',
          });
        } catch (e) {
          console.warn('[fetchVariantMedia] video helper inject failed:', e?.message || e);
        }
        try {
          // doFetch 的 extractDescription 复用 JZFollowSellContentCopy.extractDescriptionText;
          // 注入失败仅降级描述抽取(返回空),不影响视频/富内容/标签。
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['lib/follow-sell-content-copy.js'],
            world: 'MAIN',
          });
        } catch (e) {
          console.warn('[fetchVariantMedia] content-copy helper inject failed:', e?.message || e);
        }
        const results = await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: doFetch,
            args: [path, 15000],
            world: 'MAIN',
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 40000)),
        ]);
        const r = results && results[0] && results[0].result;
        if (!r || !r.ok) {
          console.warn('[fetchVariantMedia] 抓取失败:', r && r.error, r && r.failReasons);
          // 即使产品页 fetch 全失败,跟卖 modal 可能成功 — 仍写 followSell 缓存
          if (urlSku && r && r.followSellData) {
            this.followSellCacheSet(urlSku, r.followSellData);
          }
          // 细化 errorReason:doFetch 全失败时透传 failReasons
          if (!r) {
            EMPTY.errorReason = 'DOFETCH_NO_RESULT';
          } else if (r.failReasons) {
            EMPTY.errorReason = 'ALL_ENDPOINTS_FAILED:' + r.failReasons;
          } else {
            EMPTY.errorReason = 'DOFETCH_FAILED:' + (r.error || 'unknown');
          }
          return EMPTY;
        }
        const result = {
          mp4: r.mp4 || null,
          richContent: r.richContent || '',
          description: r.description || '',
          hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
          endpoint: r.endpoint || null,
          composerFields: null,
          followSellData: r.followSellData || null,
        };
        // 真调成功后异步写 entrypoint 缓存(按 sku 索引,蒸馏后字段)
        // 只要 endpoint === 'entrypoint-api'(HTTP 200)就写入,包括空内容 ——
        // 空内容是商品本身的数据特征,缓存后避免后续重复无效真调
        if (urlSku && result.endpoint === 'entrypoint-api') {
          this.entrypointCacheSet(urlSku, {
            gallery: [],
            richContent: result.richContent || '',
            description: result.description || '',
            hashtags: Array.isArray(result.hashtags) ? result.hashtags : [],
            mp4: result.mp4 || null,
          });
        }
        // ── 三合一改造:从 composerWidgetStates 抽 fields + 写 composer 缓存 ──
        // 复用 fetchProductPageState 同口径的 widget 解析(gallery/heading/aspects/price/
        // seller/brand),把蒸馏后的 fields + 过滤后 widgetStates 写入 composer 缓存(L1+L2)。
        // 与 entrypoint 缓存一致:只要 doFetch 返回 anyOk(HTTP 200)就写入,包括空内容 —
        // 空内容是商品本身的数据特征,缓存后避免后续重复无效真调。
        const cwsKeys = r.composerWidgetStates ? Object.keys(r.composerWidgetStates).length : 0;
        console.log(
          '[fetchVariantMedia] composer 写入检查:',
          urlSku,
          'urlSku=' + !!urlSku,
          'r.ok=' + !!r?.ok,
          'cwsKeys=' + cwsKeys,
          'endpoint=' + (r?.endpoint || 'null')
        );
        if (urlSku && r.ok && r.composerWidgetStates) {
          try {
            const ws = r.composerWidgetStates;
            const keys = Object.keys(ws);
            const find = (prefix) => keys.find((k) => k.startsWith(prefix));
            const parse = (key) => {
              if (!key) return null;
              const raw = ws[key];
              if (typeof raw === 'object' && raw !== null) return raw;
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            };
            const gallery = parse(find('webGallery'));
            const heading = parse(find('webProductHeading'));
            const aspects = parse(find('webAspects'));
            const price = parse(find('webPrice'));
            const seller = parse(find('webCurrentSeller'));
            const shortChars = parse(find('webShortCharacteristics'));
            const detailSku = parse(find('webDetailSKU'));
            const brand = parse(find('webBrand'));
            const images = Array.isArray(gallery?.images)
              ? gallery.images.map((it) => (typeof it === 'string' ? it : it?.url || it?.link || it?.src)).filter(Boolean)
              : [];
            const coverImage =
              typeof gallery?.coverImage === 'string'
                ? gallery.coverImage
                : gallery?.coverImage?.url || gallery?.coverImage?.link || images[0] || '';
            let sellerName = '';
            let sellerLink = '';
            try {
              sellerName =
                seller?.header?.title?.text ||
                seller?.sellerCell?.centerBlock?.title?.text ||
                seller?.sellerCell?.name ||
                seller?.name ||
                '';
              sellerLink =
                seller?.header?.title?.link ||
                seller?.sellerCell?.centerBlock?.title?.link ||
                seller?.sellerCell?.link ||
                seller?.link ||
                '';
            } catch {}
            const fields = {
              title: heading?.title || '',
              sku: urlSku,
              productId: String(gallery?.sku || detailSku?.sku || detailSku?.itemId || urlSku || ''),
              price: price?.cardPrice || price?.price || price?.originalPrice || '',
              images,
              coverImage,
              aspects: Array.isArray(aspects?.aspects) ? aspects.aspects : [],
              seller: { name: sellerName, link: sellerLink },
              brand: brand?.title || brand?.name || '',
              shortCharacteristicsRaw: shortChars || null,
            };
            result.composerFields = fields;
            // 过滤后 widgetStates(仅业务 widget,剔除布局 meta)
            const usefulPrefixes = [
              'webGallery',
              'webProductHeading',
              'webAspects',
              'webPrice',
              'webAddToCart',
              'webCurrentSeller',
              'webBrand',
              'webDetailSKU',
              'webShortCharacteristics',
              'webCharacteristics',
              'webDescription',
              'webMarketingLabels',
              'webSale',
              'webReviewProductScore',
              'webSingleProductScore',
              'webModelParams',
              'webHashtags',
              'webBestSeller',
              'webProductMainWidget',
            ];
            const filteredStates = {};
            for (const k of keys) {
              if (usefulPrefixes.some((p) => k.startsWith(p))) filteredStates[k] = ws[k];
            }
            this.composerCacheSet(urlSku, { fields, widgetStates: filteredStates });
            console.log(
              '[fetchVariantMedia] composer 缓存已写入:',
              urlSku,
              'fieldsKeys=' + Object.keys(fields).length,
              'widgetStateKeys=' + Object.keys(filteredStates).length
            );
          } catch (e) {
            console.warn('[fetchVariantMedia] composer fields extract failed:', e?.message || e);
          }
        }
        // ── 三合一改造:写 followSell 缓存(L1+L2) ──
        if (urlSku && result.followSellData) {
          this.followSellCacheSet(urlSku, result.followSellData);
        }
        return result;
      } catch (e) {
        console.warn('[fetchVariantMedia] executeScript 异常:', e?.message || e);
        EMPTY.errorReason = 'EXECUTE_SCRIPT_FAILED:' + (e?.message || 'unknown').slice(0, 80);
        return EMPTY;
      }
    };

    // ── seller.ozon.ru 门户全局节奏闸门 ──────────────────────────────────────────
    // 所有走 fetchSellerPortal 的门户调用(采集 /search + create-bundle、跟卖预取、
    // 数据面板、bestsellers 等)共用这一把闸门,保证相邻两次门户请求至少间隔
    // SELLER_PORTAL_MIN_INTERVAL_MS。seller portal 按"短时请求密度"做反爬风险评分,
    // 批量上架 / 快速浏览叠加时会瞬时打出大量请求触发验证码 / 限制登录;这里把所有出口的
    // 请求节奏串行摊平,是采集层 BATCH 节流之外的全局兜底(作用域不同,二者互补)。
    // 注:transferVideoToOzon 的 upload-file 是独立 executeScript 路径,不经此闸门,
    // 由 sku-collect.js 的 VIDEO_INTERVAL_MS 单独节流。
    const _sellerPortalGate = () => {
      const wait = S.sellerPortalGateChain.then(async () => {
        const delta = Date.now() - S.sellerPortalLastAt;
        if (delta < SELLER_PORTAL_MIN_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, SELLER_PORTAL_MIN_INTERVAL_MS - delta));
        }
        S.sellerPortalLastAt = Date.now();
      });
      // 串行化:下一个调用排在这次放行之后;.catch 防止异常断链(wait 只 await setTimeout,不会 reject)。
      S.sellerPortalGateChain = wait.catch(() => {});
      return wait;
    };

    // ── 跨域快路:在「当前/任意 ozon.ru 标签页」内直发 seller 门户请求 ──────────────
    // 实测(2026-06-14):www.ozon.ru 与 seller.ozon.ru 同属 .ozon.ru,sc_company_id /
    // 登录态 cookie 域级共享;只要满足 CORS「简单请求」(content-type:text/plain、
    // 不带任何 x-o3-* 自定义头、company_id 放进 body),从 www 商品页就能跨域读到
    // seller.ozon.ru/api/v1/search 与 create-bundle-by-variant-id 的响应(type:cors 200)。
    // 好处:用户跟卖时本就在 www 商品页 → 无需另开 / 依赖一个已登录的 seller 专用标签,
    // 根治「请先打开 seller.ozon.ru / executeScript 与 bridge 均不可用」这类失败。
    // 限制:只适用于 company_id 可放 body 的端点(/search、create-bundle);
    // what_to_sell/data/v3 强制 x-o3-company-id 自定义头(必触发预检被 CORS 挡)→ 不走此路。
    // 失败(无 ozon 标签 / 注入失败 / 反爬 / 网络)由 fetchSellerPortal 回退老 seller-tab 路。
    const fetchSellerViaOzonTab = async (path, body, opts = {}, preferTabId = null) => {
      const timeoutMs = opts.timeoutMs || 30000;
      const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';

      // 解析目标标签:优先消息来源标签(用户正所在的 www 商品页),否则任意已加载完成的
      // *.ozon.ru 标签(www 或 seller 都行 —— cookie 域级共享、且都有真实浏览器指纹)。
      const isOzonUrl = (u) =>
        sw.IS_TEST_MODE ? /^http:\/\/localhost:7777\//i.test(u || '') : /^https?:\/\/([^/]+\.)?ozon\.ru\//i.test(u || '');
      let target = null;
      if (preferTabId) {
        try {
          const t = await chrome.tabs.get(preferTabId);
          if (t && isOzonUrl(t.url)) target = t; // 来源标签是 live 的(它刚发的消息),不强求 complete
        } catch {}
      }
      if (!target) {
        const tabs = await chrome.tabs.query({
          url: sw.IS_TEST_MODE ? ['http://localhost:7777/*'] : ['*://*.ozon.ru/*'],
        });
        target =
          tabs.find((t) => t.status === 'complete' && t.active) || tabs.find((t) => t.status === 'complete') || null;
      }
      if (!target) {
        const e = new Error('无可用 ozon.ru 标签(跨域快路)');
        e.tabUnavailable = true;
        throw e;
      }

      // 注入 MAIN world 的跨域 fetch:严格只用 CORS-safelisted 头(content-type:text/plain),
      // company_id 已在 body 内。任何自定义头都会触发预检 → seller 不放行 → Failed to fetch。
      const doFetchXO = async (apiPath, reqBody, timeout, prefix, sellerOrigin) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await fetch(sellerOrigin + (prefix || '/api/v1') + apiPath, {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify(reqBody),
          });
          clearTimeout(timer);
          if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
            return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' };
          }
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            let parsedCode = '';
            try {
              const j = JSON.parse(text);
              parsedCode = (j && (j.code || (j.error && j.error.code))) || '';
            } catch {}
            return {
              ok: false,
              status: resp.status,
              code: parsedCode,
              error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
            };
          }
          return { ok: true, data: await resp.json() };
        } catch (e) {
          clearTimeout(timer);
          if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
          return { ok: false, error: e.message || String(e) };
        }
      };

      let results;
      try {
        results = await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: target.id },
            func: doFetchXO,
            args: [path, body, timeoutMs, urlPrefix, sw.OZON_SELLER_ORIGIN],
            world: 'MAIN',
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
        ]);
      } catch (e) {
        // 注入层失败(标签正在导航 / 权限 / 超时)→ 标记 tabUnavailable,允许回退 seller-tab 路
        const err = new Error(`ozon-tab 注入失败: ${e.message || e}`);
        err.tabUnavailable = true;
        throw err;
      }
      const r = results?.[0]?.result;
      if (!r) {
        const e = new Error('ozon-tab executeScript 未返回结果');
        e.tabUnavailable = true;
        throw e;
      }
      if (!r.ok) {
        const err = new Error(r.error || 'unknown');
        if (typeof r.status === 'number') err.status = r.status;
        if (typeof r.code === 'string') err.code = r.code;
        throw err; // HTTP 层错误 → 交给 fetchSellerPortal 决定是否回退(404/ResourceNotFound 权威空结果不回退)
      }
      console.log(`[fetchSellerViaOzonTab] ok tab=${target.id} url=${target.url} path=${path}`);
      return r.data;
    };

    const fetchSellerPortal = async (path, body, timeoutMsOrOpts = 30000) => {
      await _sellerPortalGate(); // 全局节奏闸门(见上)——所有门户调用共用,摊平请求密度防反爬
      // 兼容旧调用：第三个参数可以是数字（timeoutMs，默认 page-type=products-other + url=/api/v1+path），
      // 也可以是 opts 对象 { timeoutMs, urlPrefix, pageType }
      const opts = typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts || {};
      const timeoutMs = opts.timeoutMs || 30000;
      const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';
      const pageType = opts.pageType || 'products-other';

      // 0. 跨域快路:opts.allowOzonTab 的调用(/search、create-bundle —— company_id 在 body、
      // 无需 x-o3-* 自定义头)优先在「当前 ozon.ru 标签页」内直发,免依赖 seller 专用标签。
      // 成功直接返回;404/ResourceNotFound 是权威空结果(SKU 不在目录)也直接抛;
      // 其余失败(无 ozon 标签 / 注入失败 / 反爬 / 网络)静默回退到下面的 seller-tab 老路。
      if (opts.allowOzonTab) {
        try {
          return await fetchSellerViaOzonTab(path, body, opts, opts.preferTabId);
        } catch (e) {
          if (e.status === 404 && e.code === 'ResourceNotFound') throw e;
          console.warn(`[fetchSellerPortal] ozon-tab 快路失败,回退 seller-tab: ${e.message || e}`);
        }
      }

      // 1. Find or auto-open seller.ozon.ru tab —— 直接用 ensureSellerTab 返回的
      // status=complete 的 tab,不再 query+find,避免选到 loading 中的 active tab。
      const targetTab = await ensureSellerTab();

      console.log(`[fetchSellerPortal] tab=${targetTab.id} url=${targetTab.url} path=${path}`);

      // 2. Resolve sc_company_id from chrome.cookies
      const scCookies = await chrome.cookies.getAll({ url: sw.OZON_SELLER_ORIGIN + '/', name: 'sc_company_id' });
      const companyId = scCookies[0]?.value || '';
      if (!companyId) {
        throw new Error('sc_company_id cookie 未找到，请确保已登录 seller.ozon.ru');
      }

      // 3. Try executeScript first (with hard timeout), fallback to bridge
      const doFetch = async (apiPath, reqBody, xCompanyId, timeout, prefix, pageTypeHdr, sellerOrigin) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await fetch(sellerOrigin + (prefix || '/api/v1') + apiPath, {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'x-o3-app-name': 'seller-ui',
              'x-o3-company-id': xCompanyId,
              'x-o3-language': 'zh-Hans',
              'x-o3-page-type': pageTypeHdr || 'products-other',
            },
            body: JSON.stringify(reqBody),
          });
          clearTimeout(timer);
          if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
            return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' };
          }
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            // codex review HIGH#7:把 status + response.code 单独抠出来传给上游
            // classifyError。原版只塞进字符串 msg,任何字串里凑巧含 "ResourceNotFound"
            // 都会被当业务空结果吞掉。
            let parsedCode = '';
            try {
              const json = JSON.parse(text);
              parsedCode = (json && (json.code || (json.error && json.error.code))) || '';
            } catch {}
            return {
              ok: false,
              status: resp.status,
              code: parsedCode,
              error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
            };
          }
          return { ok: true, data: await resp.json() };
        } catch (e) {
          clearTimeout(timer);
          if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
          return { ok: false, error: e.message || String(e) };
        }
      };

      // Wrap executeScript with a hard timeout to prevent hang
      const tryExecuteScript = () =>
        Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: doFetch,
            args: [path, body, companyId, timeoutMs, urlPrefix, pageType, sw.OZON_SELLER_ORIGIN],
            world: 'MAIN',
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
        ]);

      // Bridge fallback (tabs.sendMessage to ozon-seller-bridge.js)
      const tryBridge = () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('bridge 超时')), timeoutMs + 5000);
          chrome.tabs.sendMessage(
            targetTab.id,
            {
              type: 'sellerPortalFetch',
              apiPath: path,
              reqBody: body,
              fallbackCompanyId: companyId,
              timeoutMs,
              urlPrefix,
              pageType,
            },
            (resp) => {
              clearTimeout(timer);
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(resp);
            }
          );
        });

      // codex review HIGH#7:把 doFetch 返回的 status / code 透传到 Error 对象上,
      // 让上游 classifyError 直接看 status === 404 && code === 'ResourceNotFound',
      // 不再靠 msg.includes() 字符串 sniffing(会把 "Forbidden ... ResourceNotFound"
      // 之类的混合错误也吞成业务空结果)。
      const makeStructuredError = (r) => {
        const err = new Error(r.error || 'unknown');
        if (typeof r.status === 'number') err.status = r.status;
        if (typeof r.code === 'string') err.code = r.code;
        return err;
      };

      // Strategy: try executeScript → if fail, try bridge → if fail, throw
      const methods = [
        {
          name: 'executeScript',
          fn: async () => {
            const results = await tryExecuteScript();
            const r = results?.[0]?.result;
            if (!r) throw new Error('executeScript 未返回结果');
            if (!r.ok) throw makeStructuredError(r);
            return r.data;
          },
        },
        {
          name: 'bridge',
          fn: async () => {
            const r = await tryBridge();
            if (!r) throw new Error('bridge 返回错误');
            if (!r.ok) throw makeStructuredError(r);
            return r.data;
          },
        },
      ];

      // 收集每个策略的真实错误，最终 throw 时拼进 message —— 保留 "过期/登录/超时/403"
      // 等关键字,让上游 ozon-product.js prefetchSourceVariant 的 errorCode classifier
      // 能命中 AUTH_REQUIRED / TIMEOUT / ANTIBOT_BLOCKED 等具体分类。
      const lastErrors = [];
      for (const m of methods) {
        try {
          console.log(`[fetchSellerPortal] trying ${m.name}...`);
          const data = await m.fn();
          console.log(`[fetchSellerPortal] ${m.name} succeeded`);
          return data;
        } catch (e) {
          const msg = e.message || String(e);
          console.warn(`[fetchSellerPortal] ${m.name} failed: ${msg}`);
          // codex review HIGH#7:status=404 + code=ResourceNotFound 是稳定的业务
          // 空结果(SKU 不在自家目录),不是 strategy 失败 —— 不需要 fallback 到
          // bridge,也不该把它和 strategy 失败混在一起。直接抛 structured error。
          if (e.status === 404 && e.code === 'ResourceNotFound') {
            throw e;
          }
          lastErrors.push({ name: m.name, msg, status: e.status, code: e.code });
        }
      }
      const detail = lastErrors.map((x) => `${x.name}: ${x.msg}`).join(' | ');
      const err = new Error(`Seller portal 请求失败 — ${detail}`);
      // 多个 strategy 都失败,挑第一个非空 status 透传(通常 executeScript 已经拿到
      // 后端的 4xx 状态,bridge 失败可能是 chrome runtime 错)。
      const firstWithStatus = lastErrors.find((x) => typeof x.status === 'number');
      if (firstWithStatus) {
        err.status = firstWithStatus.status;
        if (firstWithStatus.code) err.code = firstWithStatus.code;
      }
      throw err;
    };

    // ── B 类真调函数 ────────────────────────────────────────────────────────────
    /**
     * /api/site/seller-prototype/create-bundle-by-variant-id —— 跟卖源数据完整接口
     *
     * 老 /api/v1/search-variant-model endpoint 2026-05 被 Ozon 下线(全员 404 ResourceNotFound)。
     * 实测 /search 还活但不返物理 attributes(weight/dimensions/description)。
     * Ozon SPA 的 /app/products/copy/list (跟卖列表)用 create-bundle-by-variant-id
     * 这个 endpoint 拿跟卖商品完整后台数据:
     *
     *   item.weight                ← 重量 (grams)
     *   item.depth/width/height    ← 长/宽/高 (mm,Ozon 把"长"叫 depth)
     *   item.barcode               ← GTIN
     *   item.primary_image, images ← 主图 + 图册
     *   item.attributes[]          ← 40-63 个完整后台 attr(品牌/类目/材质/包装/...)
     *
     * 输入 variant_id 必须是 /api/v1/search 返回的真 variant_id(不是 URL 数字 SKU,两者
     * 不同 namespace)。
     *
     * **副作用**: 每次调用 Ozon 端创建一个新 bundle draft,bundle_id 递增。用三层缓存
     * 最大化减少 draft 堆积:
     *   L1 IndexedDB (SW 本地,毫秒级命中)
     *   L2 MongoDB    (ERP 远程,多设备共享,永久存储)
     *   L3 Ozon 真调  (有副作用,创建 draft)
     *
     * 缓存 key 都用 sku(bundle item 是源商品数据,同一 SKU 跨店数据相同)。
     * 空属性(attributes=[])可能是瞬时降级产物,6h 重验一次(移植自 MY 项目)。
     * 需要立即刷新可在 sendMessage('searchVariants', { sku, forceRefresh: true })。
     *
     * Headers 实测带 / 不带 x-o3-app-name + x-o3-page-type 都 200 OK,沿用 fetchSellerPortal
     * 默认 headers + urlPrefix='/api/site' 即可。
     */
    const fetchBundleByVariantId = async (sku, variantId, companyId, opts = {}) => {
      // forceRefresh → 清 L1 + L2,确保真拉
      if (opts.forceRefresh) {
        await Promise.all([
          this.idbDelete(this.IDB_STORES.BUNDLE, sku).catch(() => {}),
          this.erpCacheDelete('bundle', sku),
        ]);
      } else {
        // L1: IndexedDB(毫秒级)
        try {
          const l1 = await this.idbGet(this.IDB_STORES.BUNDLE, sku);
          if (this.bundleUsable(l1)) {
            console.log(`[fetchBundleByVariantId] L1 hit sku=${sku}`);
            // L2 未同步(之前写入失败) → 用 L1 数据异步补写 L2,成功后置 l2Synced=true
            if (!l1.l2Synced) this.syncL2FromL1(this.IDB_STORES.BUNDLE, 'bundle', sku, l1);
            return l1.data;
          }
        } catch (e) {
          console.warn(`[fetchBundleByVariantId] L1 get failed sku=${sku}:`, e?.message || e);
        }

        // L2: ERP MongoDB(多设备共享)
        const l2 = await this.erpCacheGet('bundle', sku);
        if (l2 && l2.data) {
          // ERP 已做空属性 6h 重验判定,命中即可复用
          console.log(`[fetchBundleByVariantId] L2 hit sku=${sku}`);
          // 回填 L1(l2Synced=true,L2 已有数据)
          const verifiedAt =
            Array.isArray(l2.data.attributes) && l2.data.attributes.length > 0
              ? null
              : l2.attrsEmptyVerifiedAt
                ? new Date(l2.attrsEmptyVerifiedAt).getTime()
                : Date.now();
          this.idbPut(this.IDB_STORES.BUNDLE, {
            sku,
            data: l2.data,
            bundleId: l2.bundleId || null,
            fetchedAt: Date.now(),
            l2Synced: true,
            ...(verifiedAt ? { attrsEmptyVerifiedAt: verifiedAt } : {}),
          }).catch(() => {});
          return l2.data;
        }
      }

      // L3: 真调 Ozon endpoint(有副作用:每次创建新 bundle draft)
      const resp = await fetchSellerPortal(
        '/seller-prototype/create-bundle-by-variant-id',
        {
          company_id: String(companyId),
          variant_id: String(variantId),
          source: 'SOURCE_UI_COPY_APPAREL',
        },
        {
          urlPrefix: '/api/site',
          pageType: 'products',
          timeoutMs: 30000,
          allowOzonTab: true,
          preferTabId: opts.preferTabId,
        }
      );
      console.log(`[fetchBundleByVariantId] L3 fetch sku=${sku} variantId=${variantId}`);
      const item = resp?.item || null;
      if (!item) return null;

      // 异步写回 L1(l2Synced=false) + L2(带重试,成功后回更新 L1 l2Synced=true)
      const hasAttrs = Array.isArray(item.attributes) && item.attributes.length > 0;
      const verifiedAt = hasAttrs ? null : Date.now();
      this.idbPut(this.IDB_STORES.BUNDLE, {
        sku,
        data: item,
        bundleId: resp.bundle_id || null,
        fetchedAt: Date.now(),
        l2Synced: false, // L2 尚未同步;L2 重试成功后会回更新为 true,失败则下次查询补写(兜底)
        ...(verifiedAt ? { attrsEmptyVerifiedAt: verifiedAt } : {}),
      }).catch(() => {});
      this.erpCacheSetAndSyncFlag(this.IDB_STORES.BUNDLE, 'bundle', sku, {
        data: item,
        bundleId: resp.bundle_id || null,
      });

      return item;
    };

    // ── 直调市场统计(data/v3)—— 从 getMarketStats action 抽取的核心逻辑 ──────
    // 借 seller.ozon.ru tab 注入 fetch what_to_sell/data/v3,归一化后返回。
    // **不写缓存**(由调用方 getMarketStats action / autoCollect Step 6 决定)。
    // **不走 proxyMarketData 代采降级**(由调用方在 __needSellerLogin 时决定)。
    // 返回类型契约:
    //   { __needSellerLogin: true, __reason } — 需要卖家登录(无 seller tab / 会话过期)
    //   { __antibot: true } — 反爬(http_403 / 限流,非会话类失败)
    //   { __empty: true } — HTTP 200 但 data/v3 无 items(登录正常,SKU 无市场数据)
    //   NormalizedItem — 成功(normalizeMarketItem 归一化后的 18+ 字段)
    //   null — 临时性失败(所有 seller tab 注入异常)
    const _fetchMarketStatsDirect = async (sku, period) => {
      if (!sku) return null;
      const mPeriod = period === 'weekly' ? 'weekly' : 'monthly';
      try {
        let sellerTabs = await chrome.tabs.query({ url: sw.OZON_SELLER_ORIGIN + '/*' });
        // 没开任何 seller tab。已登录 seller 时自己开一个(ensureSellerTab 内含 single-flight);
        // 未登录则不开无用 signin tab,直接走「需登录」。
        if (!sellerTabs.length) {
          const _sc = await chrome.cookies.getAll({ url: sw.OZON_SELLER_ORIGIN + '/', name: 'sc_company_id' });
          if (_sc[0]?.value) {
            try {
              await ensureSellerTab();
            } catch (e) {
              console.log('[_fetchMarketStatsDirect] ensureSellerTab 失败:', e?.message || e);
            }
            sellerTabs = await chrome.tabs.query({ url: sw.OZON_SELLER_ORIGIN + '/*' });
          }
        }
        if (!sellerTabs.length) {
          return { __needSellerLogin: true, __reason: 'NO_SELLER_TAB' };
        }

        // 排序:auth/signin 页排最后,优先试业务页
        const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
        const orderedTabs = [...sellerTabs].sort((a, b) => (isAuthUrl(a.url) ? 1 : 0 - (isAuthUrl(b.url) ? 1 : 0)));

        const injectFetch = async (sku, period) => {
          try {
            const cookies = document.cookie.split(';').map((c) => c.trim());
            const scCookie = cookies.find((c) => c.startsWith('sc_company_id='));
            const companyId = scCookie ? scCookie.split('=')[1] : '';
            if (!companyId) return { ok: false, reason: 'no_company_id' };
            const resp = await fetch('/api/site/seller-analytics/what_to_sell/data/v3', {
              method: 'POST',
              credentials: 'include',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-o3-app-name': 'seller-ui',
                'x-o3-company-id': companyId,
                'x-o3-language': 'zh-Hans',
              },
              body: JSON.stringify({
                filter: { stock: 'any_stock', period: period || 'monthly', sku: String(sku) },
                sort: { key: 'sum_gmv_desc' },
                limit: '1',
                offset: '0',
              }),
            });
            if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
            const result = await resp.json();
            return { ok: true, data: result?.items?.[0] || result?.data?.[0] || null };
          } catch (e) {
            return { ok: false, reason: `exc_${(e && e.message) || 'unknown'}` };
          }
        };

        const reasons = [];
        for (const tab of orderedTabs) {
          if (!tab.id) continue;
          let injected;
          try {
            await _sellerPortalGate();
            injected = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: injectFetch,
              args: [sku, mPeriod],
            });
          } catch (e) {
            reasons.push(`tab${tab.id}:inject_err`);
            continue;
          }
          const r = injected?.[0]?.result;
          if (r?.ok) {
            // HTTP 200 即采集成功:有数据 → 归一化;无数据 → 空标记(缓存后避免重复真调)
            return r.data ? normalizeMarketItem(r.data) : { __empty: true };
          }
          reasons.push(`tab${tab.id}:${r?.reason || 'no_result'}`);
        }

        // 所有 seller tab 都拿不到。区分:
        //   - 全部 no_company_id/http_401/signin/login/redirect → __needSellerLogin
        //   - http_403/限流 → __antibot
        //   - 其余 → null(临时性失败,不强提示)
        console.log('[_fetchMarketStatsDirect] no usable seller tab:', reasons.join(', '));
        const sessionLike = reasons.every((r) => /no_company_id|http_401|signin|login|redirect/i.test(r));
        if (sessionLike) {
          return { __needSellerLogin: true, __reason: 'AUTH_REQUIRED' };
        }
        const antibotLike = reasons.some((r) => /http_403|http_429|rate|limit|blocked|antibot/i.test(r));
        if (antibotLike) {
          return { __antibot: true };
        }
        return null;
      } catch (e) {
        console.log('[_fetchMarketStatsDirect] failed:', e?.message || e);
        return null;
      }
    };

    // ── autoCollect 全局并发限流 ─────────────────────────────────
    // 防止扩展重载时 N 标签页 × M SKU 同时涌入 SW 导致消息风暴:
    //   - 最大并发 3(实测每个 _doAutoCollect 8 步编排含多步网络请求,3 并发已接近 SW 单线程能力上限)
    //   - 超出排队的请求最多等 60s,超时丢弃避免无限堆积
    //   - 计数器在 SW 内(非 storage),SW 休眠后清零(符合预期:重启=新一轮开始)
    const _acquireAutoCollectSlot = () =>
      new Promise((resolve, reject) => {
        if (S.autoCollectRunning < _AUTO_COLLECT_MAX_CONCURRENT) {
          S.autoCollectRunning++;
          resolve();
          return;
        }
        const entry = { resolve, reject, timer: null };
        entry.timer = setTimeout(() => {
          const idx = S.autoCollectQueue.indexOf(entry);
          if (idx >= 0) S.autoCollectQueue.splice(idx, 1);
          reject(new Error('autoCollect 队列等待超时,丢弃请求'));
        }, _AUTO_COLLECT_QUEUE_TIMEOUT_MS);
        S.autoCollectQueue.push(entry);
      });

    const _releaseAutoCollectSlot = () => {
      if (S.autoCollectQueue.length > 0) {
        const next = S.autoCollectQueue.shift();
        if (next.timer) clearTimeout(next.timer);
        // 不增减 _autoCollectRunning,直接把 slot 交给下一个
        next.resolve();
        return;
      }
      S.autoCollectRunning = Math.max(0, S.autoCollectRunning - 1);
    };

    // ── Task 6:autoCollect 核心编排函数(8 类编排 + Gate 0.5 中国店铺检查) ──────
    // 流程:Gate 0(基础检查) → Gate 0.5(中国店铺) → Step 1(并行查 8 类缓存)
    //   → Step 2(计算 pending) → Step 3(autoCollectGate 逐 SKU 间隔)
    //   → Step 4(买家页采集 composer+entrypoint+followSell)
    //   → Step 5(seller portal search+bundle) → Step 6(seller portal marketStats)
    //   → Step 7(写日志 + 更新计数器)
    // ANTIBOT 分支:Step 4/5/6 任一步检测到反爬 → _handleAntibot(暂停 10 分钟 + 通知 + 写日志)。
    // 失败不熔断:marketStats/followSell 失败返回 partial,不影响其他类目。
    const _doAutoCollect = async (sku, source, sellerSlug, depth, forceRefresh, sellerId) => {
      await sw.testModeReady; // 确保 IS_TEST_MODE / OZON_*_ORIGIN 已初始化
      const startTime = Date.now();
      const results = [
        { type: 'card', hit: false },
        { type: 'detail', hit: false },
        { type: 'composer', hit: false },
        { type: 'entrypoint', hit: false },
        { type: 'search', hit: false },
        { type: 'bundle', hit: false },
        { type: 'marketStats', hit: false },
        { type: 'followSell', hit: false },
      ];
      let storeClassified = 'unclassified'; // 默认未分类

      // 等待并发 slot(超时直接返回 partial,不让消息风暴压垮 SW)
      let acquiredSlot = false;
      try {
        await _acquireAutoCollectSlot();
        acquiredSlot = true;
      } catch (e) {
        console.warn('[SW autoCollect] 排队超时,丢弃:', sku, e?.message);
        return {
          status: 'skipped',
          results,
          totalDuration: Date.now() - startTime,
          reason: e?.message || 'queue_timeout',
        };
      }

      try {
        // === Gate 0: 基础检查 ===
        const config = await sw.loadAutoCollectConfig();

        // 跨日重置 todayCount
        const today = new Date().toDateString();
        if (config.todayDate !== today) {
          config.todayDate = today;
          config.todayCount = 0;
          await this.saveAutoCollectConfig({ todayDate: today, todayCount: 0 });
        }

        // 检查 autoCollectRunning(source='manual' 时绕过:深度采集管理页独立运行,
        // 不受店铺页自动采集开关影响;daily-limit/paused/熔断仍生效)
        if (source !== 'manual' && !config.autoCollectRunning) {
          console.log('[SW autoCollect] Gate0 跳过(not-running):', sku);
          this.pushAutoCollectRecent(sku, 'skipped', source, storeClassified, results, startTime, 'not-running');
          return { status: 'skipped', reason: 'not-running' };
        }
        // 检查 paused / 冷却期
        if (config.paused && Date.now() < config.pausedUntil) {
          const remainMs = config.pausedUntil - Date.now();
          console.log('[SW autoCollect] Gate0 跳过(paused):', sku, '剩余', Math.round(remainMs / 1000) + 's');
          this.pushAutoCollectRecent(sku, 'skipped', source, storeClassified, results, startTime, 'paused');
          return { status: 'skipped', reason: 'paused', pausedUntil: config.pausedUntil };
        }
        // 检查每日上限
        if (config.todayCount >= config.perDayLimit) {
          console.log('[SW autoCollect] Gate0 跳过(daily-limit):', sku, config.todayCount + '/' + config.perDayLimit);
          this.pushAutoCollectRecent(sku, 'skipped', source, storeClassified, results, startTime, 'daily-limit');
          return { status: 'skipped', reason: 'daily-limit' };
        }

        // === Gate 0.5: 中国店铺检查 ===
        const cls = await this.checkStoreClassification(sellerSlug, null, null, sellerId);
        if (cls) {
          storeClassified = cls.isChinese === true ? 'chinese' : cls.isChinese === false ? 'non-chinese' : 'unclassified';
        }
        console.log('[SW autoCollect] Gate0.5 店铺分类:', sku, 'slug=', sellerSlug, 'class=', storeClassified);
        if (config.onlyChineseStores && cls?.isChinese !== true) {
          const reason = cls?.isChinese === false ? 'non-chinese-store' : 'unclassified-store';
          // Gate 0.5 跳过分支也调 _writeAutoCollectLog
          this.writeAutoCollectLog({
            sku,
            source,
            sellerSlug,
            storeClassified,
            depth,
            status: 'skipped',
            results,
            totalDuration: Date.now() - startTime,
          });
          this.pushAutoCollectRecent(sku, 'skipped', source, storeClassified, results, startTime, reason);
          return { status: 'skipped', reason };
        }

        // === Step 1: 并行查 8 类缓存 ===
        // search/bundle 通过 Step 5 内部查缓存,这里用 null 占位
        const [card, detail, composer, entrypoint, , , marketStats, followSell] = await Promise.all([
          this.cardCacheGet(sku),
          this.detailCacheGet(sku),
          this.composerCacheGet(sku),
          this.entrypointCacheGet(sku),
          Promise.resolve(null), // 占位,Step 5 处理
          Promise.resolve(null), // 占位,Step 5 处理
          this.marketStatsCacheGet(sku),
          this.followSellCacheGet(sku),
        ]);

        // 标记命中(forceRefresh 时所有缓存不计为命中)
        // entrypoint/marketStats 只要缓存存在即命中(HTTP 200 即缓存,包括空内容/空数据)
        results[0].hit = !!card && !forceRefresh;
        results[1].hit = !!detail && !forceRefresh;
        results[2].hit = !!composer && !forceRefresh;
        results[3].hit = !!entrypoint && !forceRefresh;
        // search/bundle 在 Step 5 处理
        results[6].hit = !!marketStats && !marketStats.stale && !forceRefresh;
        results[7].hit = !!followSell && !followSell.stale && !forceRefresh;

        console.log(
          '[SW autoCollect] Step1 缓存查询:',
          sku,
          results.map((r) => `${r.type}:${r.hit ? '✓' : '✗'}`).join(' ')
        );

        // === Step 2: 计算 pending ===
        const pending = {
          composer: !results[2].hit,
          entrypoint: !results[3].hit,
          search: !forceRefresh, // 简化:Step 5 内部检查缓存
          bundle: !forceRefresh, // 简化:Step 5 内部检查缓存
          marketStats: !results[6].hit,
          followSell: !results[7].hit,
        };
        const hasPending = Object.values(pending).some(Boolean);
        const pendingList = Object.entries(pending)
          .filter(([, v]) => v)
          .map(([k]) => k);
        console.log('[SW autoCollect] Step2 pending:', sku, pendingList.length ? pendingList.join(',') : '(none)');
        if (!hasPending) {
          this.writeAutoCollectLog({
            sku,
            source,
            sellerSlug,
            storeClassified,
            depth,
            status: 'skipped',
            reason: 'all-cached',
            results,
            totalDuration: Date.now() - startTime,
          });
          this.pushAutoCollectRecent(sku, 'skipped', source, storeClassified, results, startTime, 'all-cached');
          return { status: 'skipped', reason: 'all-cached', results, totalDuration: Date.now() - startTime };
        }

        // === Step 4: 买家页采集(composer+entrypoint+followSell) ===
        // Phase 5: 移除 _autoCollectGate / _buyerPageGate 显式调用,由队列消费者统一限速。
        if (pending.composer || pending.entrypoint || pending.followSell) {
          try {
            // fetchVariantMediaViaBuyerTab 接收 productUrl,从 card 缓存取 url 或构造 fallback
            const productUrl = card?.url || `${sw.OZON_WWW_ORIGIN}/product/-${sku}/`;
            // forceEntrypoint: entrypoint 缓存为空时,即使 composer 缓存有数据也真调 entrypoint-api 补全
            const mediaResult = await fetchVariantMediaViaBuyerTab(productUrl, {
              forceEntrypoint: pending.entrypoint,
            });
            // fetchVariantMediaViaBuyerTab 内部已写 entrypoint/composer/followSell 缓存,
            // 这里仅根据返回字段标记命中。
            // 注意:endpoint 字段可能为 'entrypoint-api'/'composer-api'/'entrypoint-cache'/'composer-cache',
            // entrypoint 缓存在 endpoint === 'entrypoint-api' 时写入(HTTP 200 即写,包括空内容),
            // 所以 results[3].hit 只要匹配 'entrypoint-*' 即表示已采集。
            const ep = String(mediaResult?.endpoint || '');
            // 只要走了 entrypoint-* 就标记命中(HTTP 200 即采集完成,包括空内容)
            if (ep.startsWith('entrypoint-')) {
              results[3].hit = true;
            } else if (!ep) {
              // 细化 NO_ENDPOINT:从 mediaResult.errorReason 取具体原因
              // (BUYER_TAB_FAILED / ALL_ENDPOINTS_FAILED:entrypoint:HTTP_404|composer:HTTP_404 / TIMEOUT 等)
              results[3].error = mediaResult?.errorReason || 'NO_ENDPOINT';
              // 反爬检测:买家页 endpoint 全部 403/429 视为反爬挑战,抛 ANTIBOT_BLOCKED
              // 触发 _handleAntibot 熔断(暂停 10 分钟),避免持续无效真调被 Ozon 进一步限制。
              // (fetchVariantMediaViaBuyerTab 内部把 403 当普通 HTTP 错误记到 failReasons,
              //  不会抛 ANTIBOT_BLOCKED,这里补上检测)
              const reason = String(results[3].error || '');
              if (/HTTP_403|HTTP_429/.test(reason)) {
                throw new Error('ANTIBOT_BLOCKED');
              }
            } else {
              results[3].error = 'FALLBACK_' + ep;
            }
            if (ep.startsWith('composer-') || mediaResult?.composerFields) results[2].hit = true;
            if (mediaResult?.followSellData) results[7].hit = true;
            console.log(
              '[SW autoCollect] Step4 买家页采集:',
              sku,
              'endpoint=',
              ep || '(null)',
              'composer:',
              results[2].hit ? '✓' : '✗',
              'entrypoint:',
              results[3].hit ? '✓' : '✗',
              'followSell:',
              results[7].hit ? '✓' : '✗'
            );
          } catch (e) {
            if (e?.message === 'ANTIBOT_BLOCKED') {
              console.warn('[SW autoCollect] Step4 反爬熔断:', sku);
              return this._handleAntibot(sku, source, sellerSlug, storeClassified, depth, startTime, results);
            }
            // 截断到 80 字符,避免超长 HTML 挑战页内容污染日志
            results[3].error = e?.message ? String(e.message).slice(0, 80) : 'STEP4_FAILED';
            console.warn('[SW autoCollect] Step4 failed:', sku, e?.message || e);
          }
        }

        // === Step 5: seller portal 采集(search+bundle) ===
        if (pending.search || pending.bundle) {
          try {
            // 检查 search 缓存(L1 IndexedDB → L2 ERP MongoDB)
            let searchCacheHit = null;
            try {
              const l1 = await this.idbGet(this.IDB_STORES.SEARCH, sku);
              if (l1 && Array.isArray(l1.data?.items) && l1.data.items.length > 0) {
                searchCacheHit = l1.data;
                if (!l1.l2Synced) this.syncL2FromL1(this.IDB_STORES.SEARCH, 'search', sku, l1);
              }
            } catch (e) {
              console.warn('[autoCollect] search L1 get failed:', e?.message || e);
            }
            if (!searchCacheHit) {
              const l2 = await this.erpCacheGet('search', sku);
              if (l2 && Array.isArray(l2.data?.items) && l2.data.items.length > 0) {
                searchCacheHit = l2.data;
                this.idbPut(this.IDB_STORES.SEARCH, { sku, data: l2.data, fetchedAt: Date.now(), l2Synced: true }).catch(() => {});
              }
            }

            if (searchCacheHit) {
              results[4].hit = true; // search
              // search 缓存命中,检查 bundle 缓存
              try {
                const bundleL1 = await this.idbGet(this.IDB_STORES.BUNDLE, sku);
                if (this.bundleUsable(bundleL1)) {
                  results[5].hit = true; // bundle
                }
              } catch (e) {
                console.warn('[SW autoCollect] bundle L1 get failed:', e?.message || e);
              }
              console.log('[SW autoCollect] Step5 search/bundle 缓存命中:', sku);
            } else {
              // 未缓存 → 真调 /search + bundle(fetchSellerPortal 内部已调 _sellerPortalGate)
              const scCookies = await chrome.cookies.getAll({
                url: sw.OZON_SELLER_ORIGIN + '/',
                name: 'sc_company_id',
              });
              const companyId = scCookies[0]?.value || '';
              if (companyId) {
                const resp = await fetchSellerPortal(
                  '/search',
                  {
                    company_id: companyId,
                    need_total: true,
                    filter: {
                      children_nodes: {
                        children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }],
                        operator: 'AND',
                      },
                    },
                    pagination: { limit: '50' },
                    is_copy_allowed: false,
                  },
                  { urlPrefix: '/api/v1', pageType: 'products', timeoutMs: 30000, allowOzonTab: true }
                );
                const rawVariants = Array.isArray(resp?.variants)
                  ? resp.variants
                  : Array.isArray(resp?.items)
                    ? resp.items
                    : Array.isArray(resp?.products)
                      ? resp.products
                      : [];
                const items = rawVariants.map(this.normalizeSearchVariantToSv).filter(Boolean);
                if (items.length > 0) {
                  results[4].hit = true; // search
                  // 写 search 缓存(L1 + L2)
                  const cacheData = { items };
                  this.idbPut(this.IDB_STORES.SEARCH, {
                    sku,
                    data: cacheData,
                    fetchedAt: Date.now(),
                    l2Synced: false,
                  }).catch(() => {});
                  this.erpCacheSetAndSyncFlag(this.IDB_STORES.SEARCH, 'search', sku, { data: cacheData });

                  // 调 bundle(fetchBundleByVariantId 内部有 L1+L2+L3 三层缓存)
                  // bundle 返回后把物理 attrs(4497/9454-9456)merge 进 items[0],
                  // 并重新写 search_cache,让 _getSearchVariantForBroadcast 能读到完整数据
                  const variantId = items[0].variant_id;
                  if (variantId) {
                    const bundleItem = await fetchBundleByVariantId(sku, variantId, companyId, {
                      forceRefresh: false,
                    });
                    if (bundleItem) {
                      results[5].hit = true; // bundle
                      const existingKeys = new Set(items[0].attributes.map((a) => String(a.key)));
                      const physicalAttrs = [];
                      if (Number(bundleItem.weight) > 0 && !existingKeys.has('4497')) {
                        physicalAttrs.push({ key: '4497', value: String(bundleItem.weight) });
                      }
                      if (Number(bundleItem.depth) > 0 && !existingKeys.has('9454')) {
                        physicalAttrs.push({ key: '9454', value: String(bundleItem.depth) });
                      }
                      if (Number(bundleItem.width) > 0 && !existingKeys.has('9455')) {
                        physicalAttrs.push({ key: '9455', value: String(bundleItem.width) });
                      }
                      if (Number(bundleItem.height) > 0 && !existingKeys.has('9456')) {
                        physicalAttrs.push({ key: '9456', value: String(bundleItem.height) });
                      }
                      if (bundleItem.barcode && !existingKeys.has('7822')) {
                        physicalAttrs.push({ key: '7822', value: String(bundleItem.barcode) });
                      }
                      if (physicalAttrs.length > 0) {
                        items[0] = { ...items[0], attributes: [...items[0].attributes, ...physicalAttrs] };
                        // 重新写 search_cache(覆盖上面 5 attrs 版本)
                        const mergedCacheData = { items };
                        this.idbPut(this.IDB_STORES.SEARCH, {
                          sku,
                          data: mergedCacheData,
                          fetchedAt: Date.now(),
                          l2Synced: false,
                        }).catch(() => {});
                        this.erpCacheSetAndSyncFlag(this.IDB_STORES.SEARCH, 'search', sku, { data: mergedCacheData });
                      }
                    }
                  }
                  console.log('[SW autoCollect] Step5 search/bundle 真调成功:', sku, 'items=', items.length);
                } else {
                  console.log('[SW autoCollect] Step5 search 真调无数据:', sku);
                }
              } else {
                console.log('[SW autoCollect] Step5 跳过(无 sc_company_id cookie):', sku);
              }
            }
          } catch (e) {
            // ANTIBOT 检测:error message 含 HTML 挑战 / 403 / 限流关键词 → 跳 ANTIBOT 分支
            const msg = String(e?.message || e || '').toLowerCase();
            const looksAntibot =
              /<html|<!doctype|just a moment|attention required|enable javascript|are you a robot|captcha|challenge|too many requests|antibot|http_403|http_429/.test(
                msg
              );
            if (looksAntibot || e?.__antibot) {
              console.warn('[SW autoCollect] Step5 反爬熔断:', sku);
              return this._handleAntibot(sku, source, sellerSlug, storeClassified, depth, startTime, results);
            }
            console.warn('[SW autoCollect] Step5 failed:', sku, e?.message || e);
          }
        }

        // === Step 6: seller portal 采集 marketStats ===
        if (pending.marketStats) {
          try {
            // _fetchMarketStatsDirect 内部已调 _sellerPortalGate
            const marketData = await _fetchMarketStatsDirect(sku);
            // 检查顺序:__needSellerLogin(AUTH_REQUIRED) → __antibot(跳 ANTIBOT) → 其余(HTTP 200)写缓存
            if (marketData?.__needSellerLogin) {
              results[6].error = 'AUTH_REQUIRED';
              console.log('[SW autoCollect] Step6 marketStats: AUTH_REQUIRED:', sku);
            } else if (marketData?.__antibot) {
              console.warn('[SW autoCollect] Step6 marketStats 反爬熔断:', sku);
              return this._handleAntibot(sku, source, sellerSlug, storeClassified, depth, startTime, results);
            } else if (marketData) {
              // HTTP 200 即写缓存(包括 __empty 空数据),标记已采集
              this.marketStatsCacheSet(sku, marketData);
              results[6].hit = true;
              console.log('[SW autoCollect] Step6 marketStats 成功:', sku, marketData.__empty ? '(空数据)' : '');
            } else {
              // null:临时性失败(所有 tab 注入异常等),不写缓存
              results[6].error = 'NO_DATA';
              console.log('[SW autoCollect] Step6 marketStats: NO_DATA:', sku);
            }
          } catch (e) {
            console.warn('[SW autoCollect] Step6 failed:', sku, e?.message || e);
            results[6].error = e?.message || 'UNKNOWN';
            // 失败不熔断
          }
        }

        // === Step 7: 写日志 + 更新计数器 ===
        const totalDuration = Date.now() - startTime;
        const hasError = results.some((r) => r.error);
        const status = hasError ? 'partial' : 'success';
        const hitCount = results.filter((r) => r.hit).length;
        console.log(
          '[SW autoCollect] Step7 完成:',
          sku,
          'status=',
          status,
          'hit=',
          hitCount + '/8',
          'dur=',
          totalDuration + 'ms',
          '|',
          results.map((r) => `${r.type}:${r.hit ? '✓' : '✗'}${r.error ? '(' + r.error + ')' : ''}`).join(' ')
        );

        // 更新内存计数器
        this.pushAutoCollectRecent(sku, status, source, storeClassified, results, startTime, null);

        // 写日志(fire-and-forget,不阻塞返回)
        this.writeAutoCollectLog({
          sku,
          source,
          sellerSlug,
          storeClassified,
          depth,
          status,
          results,
          totalDuration,
        });

        // 上报 store-sku 关联(采集完成,覆盖 lastCollect*)
        // 仅当 sellerId 非空时上报(无 sellerId 表示非店铺页采集,store-sku 由 panel 上报)
        if (sellerId) {
          this._erpStoreSkuReport({
            sku,
            sellerId,
            sellerSlug,
            sellerName: null,
            lastCollectAt: new Date().toISOString(),
            lastCollectStatus: status,
            lastCollectResults: results,
          });
        }

        return { status, results, totalDuration };
      } catch (e) {
        console.error('[SW autoCollect] 异常:', sku, e);
        const totalDuration = Date.now() - startTime;
        this.writeAutoCollectLog({
          sku,
          source,
          sellerSlug,
          storeClassified,
          depth,
          status: 'failed',
          results,
          totalDuration,
          error: e?.message,
        });
        return { status: 'failed', error: e?.message, totalDuration };
      } finally {
        if (acquiredSlot) _releaseAutoCollectSlot();
      }
    };

    // ── 暴露函数(保留原 _ 前缀,SW 中用 const _xxx = (...) => __jzCollect._xxx(...) 委托) ──
    this.normalizeMarketItem = normalizeMarketItem;
    this._isRichDoc = _isRichDoc;
    this._extractRichFromStates = _extractRichFromStates;
    this._extractMp4FromStates = _extractMp4FromStates;
    this._extractDescriptionFromStates = _extractDescriptionFromStates;
    this._extractHashtagsFromStates = _extractHashtagsFromStates;
    this._extractGalleryFromStates = _extractGalleryFromStates;
    this._ensureSellerTabImpl = _ensureSellerTabImpl;
    this.ensureSellerTab = ensureSellerTab;
    this.ensureBuyerTab = ensureBuyerTab;
    this._sellerPortalGate = _sellerPortalGate;
    this.fetchSellerViaOzonTab = fetchSellerViaOzonTab;
    this.fetchSellerPortal = fetchSellerPortal;
    this.fetchBundleByVariantId = fetchBundleByVariantId;
    this.transferVideoToOzon = transferVideoToOzon;
    this.fetchVariantMediaViaBuyerTab = fetchVariantMediaViaBuyerTab;
    this._fetchMarketStatsDirect = _fetchMarketStatsDirect;
    this._acquireAutoCollectSlot = _acquireAutoCollectSlot;
    this._releaseAutoCollectSlot = _releaseAutoCollectSlot;
    this._doAutoCollect = _doAutoCollect;
  };
})();
