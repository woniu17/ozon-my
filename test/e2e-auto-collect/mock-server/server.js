// Mock Ozon Server — 模拟 www.ozon.ru + seller.ozon.ru
// 零依赖(仅用 Node.js 内置 http 模块),端口 7777
//
// 用法: node test/e2e-auto-collect/mock-server/server.js
// 环境变量:
//   MOCK_PORT (默认 7777)
//   MOCK_ANTIBOT (默认 '')  设为 '1' 时所有 API 返回 403,模拟反爬

import http from 'node:http';
import { URL } from 'node:url';
import { PRODUCTS, PRODUCT_MAP, CHINA_SHOP, FOREIGN_SHOP, RECOMMENDED_PRODUCTS, productUrl } from './products.js';

const PORT = process.env.MOCK_PORT || 7777;
const ANTIBOT_MODE = process.env.MOCK_ANTIBOT === '1';

// 按 SKU 注入故障(测试 retry-backoff 场景用)
// 通过 POST /__test/fail-sku { sku, fail: true } 动态控制
// fail: true → 该 SKU 的所有 /api/ 请求返回 500
// fail: false → 移除故障
const _failSkus = new Set();
function shouldFailSku(sku) {
  return sku && _failSkus.has(String(sku));
}

// ─── 辅助函数 ──────────────────────────────────────────────

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Set-Cookie': 'sc_company_id=test-company-id; path=/; domain=localhost',
  });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': 'sc_company_id=test-company-id; path=/; domain=localhost',
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => resolve(chunks));
  });
}

// 从 URL path 提取 SKU(/product/slug-12345/ → 12345)
function extractSkuFromPath(pathname) {
  const m = pathname.match(/-(\d{5,})\/?/);
  return m ? m[1] : null;
}

// 从 entrypoint/composer 请求的 url 参数提取 SKU
function extractSkuFromUrlParam(body) {
  try {
    const parsed = JSON.parse(body);
    const innerUrl = parsed.url || '';
    const m = innerUrl.match(/-(\d{5,})\/?/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ─── HTML 模板 ─────────────────────────────────────────────
// 对齐真实 Ozon 新版 DOM 结构(2026-07 观察):
//   - card 外层 .tile-root 无 data-widget 属性(旧版有,新版移除)
//   - 评分和评价数是两个独立 span,不在同一元素内
//   - 评价数 span 文本含俄语 отзыв(ов/а)
//   - 店铺商品祖先含 [data-widget="infiniteVirtualPaginator"]#paginator
//   - 推荐区祖先含 [data-widget="skuGrid"]
//   - 插件 isStoreSkuCard 用 infiniteVirtualPaginator/skuGrid 区分

function ratingHtml(ratingCount) {
  if (!ratingCount) return '';
  const { score, count } = ratingCount;
  // 评分 span(真实页面有 SVG 星星图标,这里简化用 span)
  const scoreSpan = `<span class="tsBodyControl300XSmall" style="padding-left: 2px; color: var(--textPremium);">${score}</span>`;
  // 评价数 span(count=null 时不渲染,模拟新品无评价)
  const countSpan =
    count != null
      ? `<span class="c7w1_7_3-a0 tsBodyControl300XSmall" style="padding-left: 4px; color: var(--textSecondary);">${formatOtziv(count)}</span>`
      : '';
  return `<div class="g1s_20 c7w1_7_3-a" style="padding-top: 2px; padding-bottom: 2px;">${scoreSpan}${countSpan}</div>`;
}

// 俄语评价数复数形式:1=отзыв, 2-4=отзыва, 5+=отзывов, 0=отзывов
function formatOtziv(n) {
  if (n === 0) return '0 отзывов';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} отзыв`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} отзыва`;
  return `${n} отзывов`;
}

function storeCardHtml(p, index) {
  return `
      <div class="tile-root gr3_20 hl3_20 hl4_20" data-index="${index}">
        <a target="_blank" href="${productUrl(p.sku)}?_bctx=mock" rel="noopener" class="q4b1_5_6-a tile-clickable-element gr9_20 r9g_20">
          <div class="rg6_20">
            <div class="gr7_20">
              <img loading="eager" src="${p.image}" alt="${p.name}" class="g7r_20 b95_4_0-a" />
            </div>
          </div>
        </a>
        <div class="rg3_20">
          <div class="g1s_20 g2s_20 c35_4_0-a">
            <span class="c35_4_0-a1 tsHeadline500Medium">${p.price}</span>
          </div>
          <div class="ea5_6_0-a">
            <a target="_blank" href="${productUrl(p.sku)}?_bctx=mock" rel="noopener" class="q4b1_5_6-a tile-clickable-element sg2_20">
              <div class="bq03_8_3-a g1s_20" style="color: var(--textPrimary);">
                <span class="tsBody500Medium">${p.name}</span>
              </div>
            </a>
          </div>
          ${ratingHtml(p.ratingCount)}
        </div>
      </div>`;
}

function recommendedCardHtml(p) {
  return `
      <div class="tile-root gu4_20 ug4_20 gz7_20 g8z_20" data-index="0">
        <a target="_self" href="${productUrl(p.sku)}" rel="noopener" class="q4b1_5_6-a tile-clickable-element gu5_20 g3u_20">
          <div class="g2u_20 ug2_20">
            <div class="g1u_20">
              <img loading="lazy" src="${p.image}" alt="${p.name}" class="b95_4_0-a" />
            </div>
          </div>
          <section class="q1b1_5_8-a">
            <div class="b5_7_1-a0">
              <span class="tsBody500Medium">${p.name}</span>
            </div>
            <div class="c35_4_0-a">
              <span class="c35_4_0-a1 tsHeadline500Medium">${p.price}</span>
            </div>
            ${ratingHtml(p.ratingCount)}
          </section>
        </a>
      </div>`;
}

function sellerPageHtml(slug) {
  const shop = slug === CHINA_SHOP.slug ? CHINA_SHOP : slug === FOREIGN_SHOP.slug ? FOREIGN_SHOP : null;
  if (!shop) return `<!DOCTYPE html><html><body>Shop not found: ${slug}</body></html>`;

  const storeProducts = PRODUCTS.filter((p) => p.sellerSlug === slug);
  const storeCards = storeProducts.map((p, i) => storeCardHtml(p, i)).join('\n');

  // 推荐区商品(所有店铺页都显示相同的推荐商品,用于测试 isStoreSkuCard 排除逻辑)
  const recommendedCards = RECOMMENDED_PRODUCTS.map((p) => recommendedCardHtml(p)).join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${shop.name}</title>
  <meta property="og:title" content="${shop.name}" />
</head>
<body>
  <div data-widget="blockVertical">
    <div data-widget="wallpaper">
      <header data-widget="header"></header>
      <div data-widget="container" class="container c">
        <div data-widget="sellerTransparency">
          <span class="tsHeadline600Large">${shop.name}</span>
        </div>

        <!-- 店铺商品区:infiniteVirtualPaginator 标识为店铺商品 -->
        <div data-widget="row" class="e1">
          <div data-widget="column" class="c8">
            <div data-widget="infiniteVirtualPaginator" class="search_d3a" id="paginator">
              <div id="contentScrollPaginator" class="search_d1a search_a3d search_a2d">
                <div class="search_da2">
                  <div>
                    <div class="l2h_20">
                      ${storeCards}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 推荐区:skuGrid 标识为非店铺商品(isStoreSkuCard 返回 false) -->
        <div data-widget="island" class="k0c_7">
          <div data-widget="skuGrid" class="zg6_20">
            <div class="z6g_20">
              ${recommendedCards}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Ozon 用 Nuxt 框架,seller-info-main.js 从 window.__NUXT__ 读取 sellerId -->
  <script>
    window.__NUXT__ = {
      state: {
        pageInfo: {
          analyticsInfo: {
            sellerId: '${shop.sellerId}',
            sellerSlug: '${shop.slug}',
          },
        },
      },
    };
    // 标记页面已加载,供测试脚本检测
    window.__MOCK_READY__ = true;
  </script>
</body>
</html>`;
}

function productPageHtml(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return `<!DOCTYPE html><html><body>Product not found: ${sku}</body></html>`;

  // seller-info-main.js 详情页逻辑:读取 [id^="state-webCurrentSeller-"] 的 data-state 属性
  const sellerState = JSON.stringify({
    badge: { subscribed: { common: { action: { params: { sellerId: p.sellerId } } } } },
    sellerCell: {
      centerBlock: {
        title: { text: p.name },
        common: { action: { link: `/seller/${p.sellerSlug}` } },
      },
    },
    trustFactors: [
      {
        subtitle: [{ texts: [p.name, 'mock address', 'CN'] }],
      },
    ],
  });

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${p.name}</title>
</head>
<body>
  <h1>${p.name}</h1>
  <div data-widget="webPrice">${p.price}</div>
  <img src="${p.image}" alt="${p.name}" />

  <!-- seller-info-main.js 从此元素读取卖家信息 -->
  <div id="state-webCurrentSeller-0" data-state='${sellerState.replace(/'/g, '&#39;')}'></div>

  <script>
    window.__NUXT__ = { state: { pageInfo: { analyticsInfo: { sellerId: '${p.sellerId}' } } } };
    window.__MOCK_READY__ = true;
  </script>
</body>
</html>`;
}

function sellerPortalPageHtml() {
  // seller.ozon.ru tab 页面(ensureSellerTab 创建用),只需返回 200 带 cookie
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Seller Portal Mock</title></head>
<body>
  <div id="app">Seller Portal Mock</div>
  <script>window.__MOCK_SELLER_READY__ = true;</script>
</body>
</html>`;
}

// ─── API Mock 响应 ─────────────────────────────────────────

function entrypointResponse(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return { error: { code: 'NOT_FOUND' } };

  // entrypoint-api.bx 响应结构:widgetStates + layout
  return {
    widgetStates: {
      [`item-${sku}`]: JSON.stringify({
        seller: { name: p.name, link: `/seller/${p.sellerSlug}` },
        images: [p.image],
        gallery: { images: [p.image], videos: [] },
        description: `测试商品 ${sku} 的详细描述`,
        richAnnotationJson: JSON.stringify({
          content: [{ widgetName: 'text', text: { items: [{ content: `Rich content for ${sku}` }] } }],
          version: 0.3,
        }),
      }),
    },
    layout: [{ widget: `item-${sku}`, type: 'item' }],
  };
}

function composerResponse(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return { error: { code: 'NOT_FOUND' } };

  // composer-api.bx 响应结构:widgetStates(与 entrypoint 类似但更丰富)
  return {
    widgetStates: {
      [`searchResultsV2-${sku}`]: JSON.stringify({
        mainState: [{ title: p.name, price: { price: p.priceRub, currency: 'RUB' } }],
        seller: { name: p.name, link: `/seller/${p.sellerSlug}` },
        images: [p.image],
        gallery: { images: [p.image], videos: [] },
        description: `Composer description for ${sku}`,
        richAnnotationJson: JSON.stringify({
          content: [{ widgetName: 'text', text: { items: [{ content: `Composer rich for ${sku}` }] } }],
          version: 0.3,
        }),
        followSell: { count: 5, sellers: [{ name: 'Seller A', price: p.priceRub }] },
      }),
    },
    layout: [{ widget: `searchResultsV2-${sku}`, type: 'searchResultsV2' }],
  };
}

function searchResponse(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return { result: { items: [] } };

  // seller portal /api/v1/search 响应结构
  return {
    result: {
      items: [
        {
          sku: Number(sku),
          product_id: Number(sku),
          name: p.name,
          offer_id: `offer-${sku}`,
          price: { price: p.priceRub, old_price: p.priceRub + 100, currency: 'RUB' },
          stocks: [{ present: 50, reserved: 5, type: 'fbo' }],
          images: [p.image],
          status: 'active',
          variant_id: Number(sku) + 100000,
        },
      ],
      total: 1,
    },
  };
}

function bundleResponse(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return { result: { attributes: [] } };

  // create-bundle-by-variant-id 响应结构
  return {
    result: {
      id: Number(sku) + 200000,
      sku: Number(sku),
      name: p.name,
      attributes: [
        { attribute_id: '14', values: [{ value: p.name, sequence: 1, complex_sequence: 0, is_default: true }] },
        {
          attribute_id: '85',
          values: [{ value: String(p.priceRub), sequence: 1, complex_sequence: 0, is_default: true }],
        },
      ],
      complex_attributes: [],
      errors: [],
    },
  };
}

function marketStatsResponse(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return { items: [] };

  // what_to_sell/data/v3 响应结构
  return {
    items: [
      {
        sku: Number(sku),
        name: p.name,
        sum_gmv: p.priceRub * 50,
        units_sold: 50,
        revenue: p.priceRub * 50,
        stock: 100,
        conversion: 0.05,
        clicks: 1000,
        impressions: 20000,
        add_to_cart: 100,
        orders: 50,
      },
    ],
    total: 1,
  };
}

// ─── HTTP 服务 ─────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const fullUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = fullUrl.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  console.log(`[mock] ${method} ${pathname}`);

  try {
    // ── HTML 页面路由 ──

    // 店铺页 /seller/:slug
    if (method === 'GET' && /^\/seller\/([^/]+)\/?(?:products\/?)?$/.test(pathname)) {
      const slug = pathname.match(/^\/seller\/([^/]+)/)[1];
      return sendHtml(res, sellerPageHtml(slug));
    }

    // 详情页 /product/:slug-:sku/ 或 /product/-:sku/
    if (method === 'GET' && pathname.startsWith('/product/')) {
      const sku = extractSkuFromPath(pathname) || pathname.match(/\/product\/-?(\d+)/)?.[1];
      return sendHtml(res, productPageHtml(sku));
    }

    // seller portal 页面 /app/*
    if (method === 'GET' && pathname.startsWith('/app/')) {
      return sendHtml(res, sellerPortalPageHtml());
    }

    // 首页
    if (method === 'GET' && (pathname === '/' || pathname === '')) {
      return sendHtml(
        res,
        `<!DOCTYPE html><html><body><h1>Mock Ozon Home</h1><a href="/seller/${CHINA_SHOP.slug}">China Shop</a></body></html>`
      );
    }

    // ── API 路由 ──

    // 测试控制接口:按 SKU 注入/移除故障
    // POST /__test/fail-sku  body: { sku, fail: true|false }
    if (method === 'POST' && pathname === '/__test/fail-sku') {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        const sku = String(parsed?.sku || '');
        if (!sku) return sendJson(res, 400, { error: 'missing sku' });
        if (parsed?.fail === true) {
          _failSkus.add(sku);
          console.log(`[mock] fail-sku ADD: ${sku}`);
        } else {
          _failSkus.delete(sku);
          console.log(`[mock] fail-sku REMOVE: ${sku}`);
        }
        return sendJson(res, 200, { ok: true, failSkus: Array.from(_failSkus) });
      } catch (e) {
        return sendJson(res, 400, { error: e?.message || 'invalid body' });
      }
    }

    // 反爬模式:所有 API 返回 403
    if (ANTIBOT_MODE && pathname.startsWith('/api/')) {
      console.log('[mock] ANTIBOT mode → 403');
      return sendJson(res, 403, { error: { code: 'ANTIBOT_BLOCKED' } });
    }

    // entrypoint-api.bx (支持 GET 和 POST:SW doFetch 用 GET,seller-info-main.js 也用 GET)
    if (pathname.includes('/entrypoint-api.bx/page/json/v2')) {
      let sku = null;
      if (method === 'POST') {
        const body = await readBody(req);
        sku = extractSkuFromUrlParam(body) || extractSkuFromPath(pathname);
      } else {
        // GET: url 参数在 query string 中 (?url=/product/slug-12345/)
        const urlParam = fullUrl.searchParams.get('url') || '';
        const m = urlParam.match(/-(\d{5,})\/?/);
        sku = m ? m[1] : extractSkuFromPath(pathname);
      }
      if (shouldFailSku(sku)) {
        console.log(`[mock] fail-sku → 500: entrypoint sku=${sku}`);
        return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
      }
      return sendJson(res, 200, entrypointResponse(sku));
    }

    // composer-api.bx page/json/v2 (支持 GET 和 POST)
    if (pathname.includes('/composer-api.bx/page/json/v2')) {
      let sku = null;
      if (method === 'POST') {
        const body = await readBody(req);
        sku = extractSkuFromUrlParam(body) || extractSkuFromPath(pathname);
      } else {
        const urlParam = fullUrl.searchParams.get('url') || '';
        const m = urlParam.match(/-(\d{5,})\/?/);
        sku = m ? m[1] : extractSkuFromPath(pathname);
      }
      if (shouldFailSku(sku)) {
        console.log(`[mock] fail-sku → 500: composer sku=${sku}`);
        return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
      }
      return sendJson(res, 200, composerResponse(sku));
    }

    // composer-api.bx _action/*
    if (method === 'POST' && pathname.includes('/composer-api.bx/_action/')) {
      return sendJson(res, 200, { widgetStates: {}, layout: [] });
    }

    // seller portal /api/v1/search
    if (method === 'POST' && pathname === '/api/v1/search') {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        const sku = String(parsed?.filter?.sku || parsed?.filter?.sku_list?.[0] || '');
        if (shouldFailSku(sku)) {
          console.log(`[mock] fail-sku → 500: search sku=${sku}`);
          return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
        }
        return sendJson(res, 200, searchResponse(sku));
      } catch {
        return sendJson(res, 200, { result: { items: [] } });
      }
    }

    // seller portal create-bundle-by-variant-id
    if (method === 'POST' && pathname.includes('/seller-prototype/create-bundle-by-variant-id')) {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        const sku = String(parsed?.variant_id || parsed?.sku || '');
        if (shouldFailSku(sku)) {
          console.log(`[mock] fail-sku → 500: bundle sku=${sku}`);
          return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
        }
        return sendJson(res, 200, bundleResponse(sku));
      } catch {
        return sendJson(res, 200, { result: { attributes: [] } });
      }
    }

    // seller analytics what_to_sell/data/v3 (marketStats)
    if (method === 'POST' && pathname.includes('/seller-analytics/what_to_sell/data/v3')) {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        const sku = String(parsed?.filter?.sku || '');
        if (shouldFailSku(sku)) {
          console.log(`[mock] fail-sku → 500: marketStats sku=${sku}`);
          return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
        }
        return sendJson(res, 200, marketStatsResponse(sku));
      } catch {
        return sendJson(res, 200, { items: [] });
      }
    }

    // media-storage upload-file (视频转存)
    if (method === 'POST' && pathname.includes('/media-storage/upload-file')) {
      return sendJson(res, 200, { url: `https://mock.ozonusercontent.com/video/${Date.now()}.mp4` });
    }

    // modal/shop-in-shop-info (seller-info-main.js 方案 B)
    if (method === 'POST' && pathname.includes('/entrypoint-api.bx')) {
      const body = await readBody(req);
      const sku = extractSkuFromUrlParam(body);
      if (shouldFailSku(sku)) {
        console.log(`[mock] fail-sku → 500: entrypoint(modal) sku=${sku}`);
        return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
      }
      return sendJson(res, 200, entrypointResponse(sku));
    }

    // modal/otherOffersFromSellers (followSell 数据)
    if (method === 'POST' && pathname.includes('/composer-api.bx')) {
      const body = await readBody(req);
      const sku = extractSkuFromUrlParam(body);
      if (shouldFailSku(sku)) {
        console.log(`[mock] fail-sku → 500: composer(modal) sku=${sku}`);
        return sendJson(res, 500, { error: { code: 'INJECTED_FAIL', sku } });
      }
      return sendJson(res, 200, composerResponse(sku));
    }

    // ── 兜底 ──
    console.warn(`[mock] unhandled: ${method} ${pathname}`);
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Mock route not found: ${method} ${pathname}` } });
  } catch (err) {
    console.error('[mock] error:', err);
    return sendJson(res, 500, { error: { code: 'INTERNAL', message: err?.message || String(err) } });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-ozon] listening on http://localhost:${PORT}`);
  console.log(`[mock-ozon] ANTIBOT_MODE = ${ANTIBOT_MODE}`);
  console.log(`[mock-ozon] test shops:`);
  console.log(`  China shop:  http://localhost:${PORT}/seller/${CHINA_SHOP.slug}`);
  console.log(`  Foreign shop: http://localhost:${PORT}/seller/${FOREIGN_SHOP.slug}`);
});
