/* =========================================================
 * followSell 采集逻辑单元测试
 *
 * 目的:排查"自动采集中跟卖列表采集不到"的根因
 *
 * 测试覆盖:
 *   1. SW 侧 modal 响应解析逻辑(从 fetchFollowSellModal 子函数抽出的纯函数)
 *   2. stale 判定逻辑(4h TTL)
 *   3. mock-server URL 匹配问题验证
 *   4. normSeller 字段抽取
 *
 * 运行: node qx-ozon/tests/follow-sell-collect.test.js
 * ========================================================= */

const assert = require('assert');
const path = require('path');

// ─── 测试结果统计 ──────────────────────────────────────────
let _passCount = 0;
let _failCount = 0;
const _failures = [];

function test(name, fn) {
  try {
    fn();
    _passCount++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    _failCount++;
    _failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    _passCount++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    _failCount++;
    _failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ============================================================
// 1. SW 侧 modal 响应解析逻辑(从 collect-tab.js fetchFollowSellModal 抽出)
// ============================================================
// 来源:collect-tab.js fetchFollowSellModal 子函数(原 doFetch 闭包内的 modal 解析逻辑)
// 原样复制,便于单元测试 fetchFollowSellModal 内的解析逻辑

/**
 * 模拟 fetchFollowSellModal 内的 followSell modal 解析逻辑
 * @param {object} fsResp - fetch 响应对象 { ok, status, json: async () => data }
 * @param {string} fsSku - 从 relPath 提取的 SKU
 * @returns {object|null} followSellData
 */
function swParseFollowSellModal(fsResp, fsSku) {
  let followSellData = null;
  if (!fsSku) return null;

  if (fsResp.ok) {
    const fsData = fsResp.jsonData;
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
        // normSeller: 14 字段完整版,与 collect-tab.js / shared-utils.js 对齐
        const normSeller = (item) => {
          if (!item || typeof item !== 'object') return null;
          const txt = (v) =>
            typeof v === 'string' ? v.trim() : v && typeof v === 'object' && v.text ? String(v.text).trim() : '';
          const str = (v) => (typeof v === 'string' ? v : '');
          const name = txt(item.name) || txt(item.sellerName) || txt(item.seller?.name) || txt(item.title) || '';
          const priceRaw = item.price?.cardPrice?.price ?? item.price?.cardPrice ?? item.price ?? item.finalPrice ?? '';
          const price = txt(priceRaw);
          if (!name && !price) return null;
          return {
            sku: txt(item.sku) || txt(item.skuId) || '',
            id: txt(item.id) || txt(item.sellerId) || '',
            name,
            link: str(item.link),
            credentials: Array.isArray(item.credentials) ? item.credentials.map(String) : [],
            logoImageUrl: str(item.logoImageUrl),
            advantages: Array.isArray(item.advantages) ? item.advantages : [],
            subtitle: txt(item.subtitle),
            price: item.price || null,
            coverImage: str(item.coverImage),
            productLink: str(item.productLink),
            trackingInfo: item.trackingInfo || null,
            sellerInfoTracking: item.sellerInfoTracking || null,
            informationBtnTracking: item.informationBtnTracking || null,
          };
        };
        const sellers = rawSellers.map(normSeller).filter(Boolean);
        followSellData = { count: rawSellers.length, sellers, source: 'modal' };
      }
    }
  } else {
    // HTTP 非 200 → 视为失败,不写缓存
    followSellData = null;
  }
  return followSellData;
}

console.log('\n=== 1. SW 侧 modal 响应解析 ===');

// 1.1 正常响应含 webSellerList widget
test('正常响应:webSellerList 含 3 个 seller → count=3, sellers=3', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-123': JSON.stringify({
          sellers: [
            { name: 'Seller A', price: { cardPrice: { price: '100 ₽' } } },
            { name: 'Seller B', price: { cardPrice: { price: '200 ₽' } } },
            { name: 'Seller C', price: { cardPrice: { price: '300 ₽' } } },
          ],
        }),
      },
    },
  };
  const result = swParseFollowSellModal(resp, '123');
  assert.ok(result, 'followSellData 不应为 null');
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.sellers.length, 3);
  assert.strictEqual(result.source, 'modal');
  assert.strictEqual(result.sellers[0].name, 'Seller A');
});

// 1.2 正常响应但无 webSellerList widget(零跟卖)
test('零跟卖:无 webSellerList widget → count=0, source=no-sellers', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'someOtherWidget-123': JSON.stringify({ foo: 'bar' }),
      },
    },
  };
  const result = swParseFollowSellModal(resp, '123');
  assert.ok(result);
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.sellers.length, 0);
  assert.strictEqual(result.source, 'no-sellers');
});

// 1.3 ★关键:空 widgetStates(反爬 stub)— 当前实现会缓存为零跟卖
test('★反爬 stub:空 widgetStates → 被错误缓存为零跟卖(潜在 bug)', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: { widgetStates: {} }, // 反爬 stub 返回 200 但空 widgetStates
  };
  const result = swParseFollowSellModal(resp, '123');
  // 当前行为:返回 {count:0, source:'no-sellers'} → 会写缓存,4h 内不再重试
  assert.ok(result, '当前实现返回非 null(会被缓存为零跟卖)');
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.source, 'no-sellers');
  console.log('    ⚠️  发现潜在 bug:反爬 stub(空 widgetStates)被误判为零跟卖并缓存');
});

// 1.4 HTTP 非 200 → 不写缓存
test('HTTP 403:followSellData=null,不写缓存', () => {
  const resp = { ok: false, status: 403, jsonData: null };
  const result = swParseFollowSellModal(resp, '123');
  assert.strictEqual(result, null);
});

test('HTTP 500:followSellData=null,不写缓存', () => {
  const resp = { ok: false, status: 500, jsonData: null };
  const result = swParseFollowSellModal(resp, '123');
  assert.strictEqual(result, null);
});

// 1.5 webSellerList 是 string 且 JSON.parse 失败
test('webSellerList JSON.parse 失败 → source=parse-fail', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-123': 'invalid-json{',
      },
    },
  };
  const result = swParseFollowSellModal(resp, '123');
  assert.ok(result);
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.source, 'parse-fail');
});

// 1.6 webSellerList 已经是 object(非 string)
test('webSellerList 为 object(非 string) → 正常解析', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-123': { sellers: [{ name: 'Seller X', price: '500 ₽' }] },
      },
    },
  };
  const result = swParseFollowSellModal(resp, '123');
  assert.ok(result);
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.sellers[0].name, 'Seller X');
});

// 1.7 ★count 与 sellers.length 不一致
test('★count > sellers.length:seller 无 name/price 被 filter 掉', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-123': JSON.stringify({
          sellers: [
            { name: 'Valid Seller', price: '100 ₽' },
            { name: '', price: '' }, // 无 name 且无 price → normSeller 返回 null
            { unrelatedField: 'foo' }, // 无 name 且无 price → null
          ],
        }),
      },
    },
  };
  const result = swParseFollowSellModal(resp, '123');
  assert.strictEqual(result.count, 3, 'count=rawSellers.length=3');
  assert.strictEqual(result.sellers.length, 1, 'sellers 被 filter 后只剩 1 个');
  console.log('    ⚠️  count(3) > sellers.length(1),UI 显示跟卖数与列表不一致');
});

// 1.8 fsSku 为空 → 返回 null
test('fsSku 为空 → 返回 null', () => {
  const resp = { ok: true, status: 200, jsonData: { widgetStates: {} } };
  const result = swParseFollowSellModal(resp, '');
  assert.strictEqual(result, null);
});

// 1.9 price 字段多种格式 fallback
// 新方案:price 字段保留原始 item.price 对象(便于读取侧自由提取 cardPrice/oldPrice 等)
// 无 item.price 时为 null(finalPrice/priceText 等不再单独提取到 price 字段)
test('price 字段:保留原始 item.price 对象,无 item.price 时为 null', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-123': JSON.stringify({
          sellers: [
            { name: 'A', price: { cardPrice: { price: '100 ₽' } } },
            { name: 'B', price: { cardPrice: '200 ₽' } },
            { name: 'C', price: '300 ₽' },
            { name: 'D', finalPrice: '400 ₽' },
          ],
        }),
      },
    },
  };
  const result = swParseFollowSellModal(resp, '123');
  assert.strictEqual(result.sellers.length, 4);
  // A/B/C 有 item.price,原样保留;D 无 item.price(finalPrice 不再提取到 price 字段)
  assert.deepStrictEqual(result.sellers[0].price, { cardPrice: { price: '100 ₽' } });
  assert.deepStrictEqual(result.sellers[1].price, { cardPrice: '200 ₽' });
  assert.strictEqual(result.sellers[2].price, '300 ₽');
  assert.strictEqual(result.sellers[3].price, null);
});

// 1.10 ★14 字段完整抽取(对齐 hello.json 真实结构)
test('★14 字段完整抽取:sku/id/name/link/credentials/logoImageUrl/advantages/subtitle/price/coverImage/productLink/trackingInfo/sellerInfoTracking/informationBtnTracking', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-4723017-default-1': JSON.stringify({
          sellers: [
            {
              sku: '4790402820',
              id: '3308213',
              name: 'Золотой эталон',
              link: '/seller/3308213/',
              credentials: ['Shenzhen Silugou Co., Ltd.', 'Room 102, Urumqi'],
              logoImageUrl: 'https://cdn1.ozonusercontent.com/logo.png',
              advantages: [{ key: 'delivery', iconKey: 'iconOrderPlane', contentRs: { headRs: [{ type: 'text', content: 'Доставим 30 июля' }] } }],
              subtitle: 'Перейти в магазин',
              price: { cardPrice: { price: '67,28 ¥' } },
              coverImage: 'https://ir-20.ozonstatic.cn/cover.jpg',
              productLink: 'https://www.ozon.ru/product/sumka-4790402820/',
              trackingInfo: { click: { actionType: 'click', key: 'k1' } },
              sellerInfoTracking: { click: { actionType: 'click', key: 'k2' } },
              informationBtnTracking: { click: { actionType: 'click', key: 'k3' } },
            },
          ],
        }),
      },
    },
  };
  const result = swParseFollowSellModal(resp, '4790402820');
  assert.strictEqual(result.sellers.length, 1);
  const s = result.sellers[0];
  // 标识(4)
  assert.strictEqual(s.sku, '4790402820');
  assert.strictEqual(s.id, '3308213');
  assert.strictEqual(s.name, 'Золотой эталон');
  assert.strictEqual(s.link, '/seller/3308213/');
  // 店铺资质(2)
  assert.deepStrictEqual(s.credentials, ['Shenzhen Silugou Co., Ltd.', 'Room 102, Urumqi']);
  assert.strictEqual(s.logoImageUrl, 'https://cdn1.ozonusercontent.com/logo.png');
  // 卖点(2)
  assert.strictEqual(s.advantages.length, 1);
  assert.strictEqual(s.advantages[0].key, 'delivery');
  assert.strictEqual(s.subtitle, 'Перейти в магазин');
  // 商品价格/图(3)
  assert.deepStrictEqual(s.price, { cardPrice: { price: '67,28 ¥' } });
  assert.strictEqual(s.coverImage, 'https://ir-20.ozonstatic.cn/cover.jpg');
  assert.strictEqual(s.productLink, 'https://www.ozon.ru/product/sumka-4790402820/');
  // 埋点(3)
  assert.deepStrictEqual(s.trackingInfo, { click: { actionType: 'click', key: 'k1' } });
  assert.deepStrictEqual(s.sellerInfoTracking, { click: { actionType: 'click', key: 'k2' } });
  assert.deepStrictEqual(s.informationBtnTracking, { click: { actionType: 'click', key: 'k3' } });
});

// 1.11 字段缺失时安全降级(null/[] 兜底)
test('字段缺失安全降级:无 id/credentials/logoImageUrl → 空串/空数组/null', () => {
  const resp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-1': JSON.stringify({
          sellers: [{ name: 'Minimal Seller', price: '100 ₽' }],
        }),
      },
    },
  };
  const result = swParseFollowSellModal(resp, '1');
  const s = result.sellers[0];
  assert.strictEqual(s.sku, '');
  assert.strictEqual(s.id, '');
  assert.deepStrictEqual(s.credentials, []);
  assert.strictEqual(s.logoImageUrl, '');
  assert.deepStrictEqual(s.advantages, []);
  assert.strictEqual(s.subtitle, '');
  assert.strictEqual(s.coverImage, '');
  assert.strictEqual(s.productLink, '');
  assert.strictEqual(s.trackingInfo, null);
  assert.strictEqual(s.sellerInfoTracking, null);
  assert.strictEqual(s.informationBtnTracking, null);
});

// ============================================================
// 2. content 侧 fetchFollowSellFromModal 解析逻辑对比
// ============================================================
// 来源:shared-utils.js L2503-2544
// 关键差异:content 侧空 widgetStates 会 throw,SW 侧会缓存为零跟卖

console.log('\n=== 2. content 侧 vs SW 侧空 widgetStates 行为差异 ===');

function contentParseFollowSellModal(fsData) {
  const states = fsData?.widgetStates || {};
  if (!states || typeof states !== 'object' || Object.keys(states).length === 0) {
    throw new Error('empty widgetStates');
  }
  const wslKey = Object.keys(states).find((k) => k.startsWith('webSellerList'));
  if (!wslKey) {
    return { count: 0, sellers: [], source: 'no-sellers' };
  }
  return { count: 1, sellers: [], source: 'modal' }; // 简化
}

test('★content 侧空 widgetStates → throw(走 failure tracking)', () => {
  assert.throws(() => contentParseFollowSellModal({ widgetStates: {} }), /empty widgetStates/, 'content 侧应该 throw');
  console.log('    ✓ content 侧 throw,触发 recordFollowSellFailure 退避');
});

test('★SW 侧空 widgetStates → 返回 no-sellers(不 throw,写缓存)', () => {
  const swResult = swParseFollowSellModal({ ok: true, status: 200, jsonData: { widgetStates: {} } }, '123');
  assert.ok(swResult, 'SW 侧不 throw,返回非 null');
  assert.strictEqual(swResult.source, 'no-sellers');
  console.log('    ✗ SW 侧不 throw,会写缓存 → 反爬 stub 被误判为零跟卖,4h 内不再重试');
});

// ============================================================
// 2.1 fsSku 提取:query string 场景(真实根因)
// ============================================================
// 来源:service-worker.js L2291-2295
// 旧代码: const fsSku = (relPath.match(/-(\d+)\/?$/) || [])[1] || '';
// 新代码: const _fsPath = relPath.split('?')[0];
//         const fsSku = (_fsPath.match(/-(\d+)\/?$/) || [])[1] || '';

console.log('\n=== 2.1 fsSku 提取:query string 场景(真实根因) ===');

function extractFsSkuOld(relPath) {
  return (relPath.match(/-(\d+)\/?$/) || [])[1] || '';
}

function extractFsSkuNew(relPath) {
  const _fsPath = relPath.split('?')[0];
  return (_fsPath.match(/-(\d+)\/?$/) || [])[1] || '';
}

test('★旧代码:card.url 带 query string → fsSku 提取失败(根因)', () => {
  // 真实 card.url: https://www.ozon.ru/product/...-3295413158/?_bctx=...&hs=1
  // relPath = pathname + search = /product/...-3295413158/?_bctx=...&hs=1
  const relPath = '/product/samokleyashchiysya-plintus-3295413158/?_bctx=CAQQltDUAQ&hs=1';
  const fsSku = extractFsSkuOld(relPath);
  assert.strictEqual(fsSku, '', '旧代码 fsSku 为空 → modal 不执行 → 采集不到跟卖');
});

test('★新代码:card.url 带 query string → fsSku 正确提取', () => {
  const relPath = '/product/samokleyashchiysya-plintus-3295413158/?_bctx=CAQQltDUAQ&hs=1';
  const fsSku = extractFsSkuNew(relPath);
  assert.strictEqual(fsSku, '3295413158', '新代码去 query 后正确提取 SKU');
});

test('新代码:无 query string → 仍正常工作', () => {
  const relPath = '/product/samokleyashchiysya-plintus-3295413158/';
  const fsSku = extractFsSkuNew(relPath);
  assert.strictEqual(fsSku, '3295413158');
});

test('新代码:多个 ? 字符 → 只去第一个之后', () => {
  // 边界:query string 内可能含 ? 字符(虽不常见)
  const relPath = '/product/foo-12345/?bar=1?baz=2';
  const fsSku = extractFsSkuNew(relPath);
  assert.strictEqual(fsSku, '12345');
});

test('新代码:无 SKU 的路径 → fsSku 为空', () => {
  const relPath = '/product/no-sku-here/?query=1';
  const fsSku = extractFsSkuNew(relPath);
  assert.strictEqual(fsSku, '');
});

// ============================================================
// 3. stale 判定逻辑(4h TTL)
// ============================================================
// 来源:service-worker.js L977-998 _followSellCacheGet

console.log('\n=== 3. stale 判定逻辑(4h TTL) ===');

function checkStale(fetchedAt, staleMs = 14400000) {
  return Date.now() - fetchedAt > staleMs;
}

test('1h 前缓存 → stale=false', () => {
  const fetchedAt = Date.now() - 1 * 60 * 60 * 1000;
  assert.strictEqual(checkStale(fetchedAt), false);
});

test('3h59m 前缓存 → stale=false', () => {
  const fetchedAt = Date.now() - (4 * 60 * 60 * 1000 - 60000);
  assert.strictEqual(checkStale(fetchedAt), false);
});

test('4h1m 前缓存 → stale=true', () => {
  const fetchedAt = Date.now() - (4 * 60 * 60 * 1000 + 60000);
  assert.strictEqual(checkStale(fetchedAt), true);
});

test('24h 前缓存 → stale=true', () => {
  const fetchedAt = Date.now() - 24 * 60 * 60 * 1000;
  assert.strictEqual(checkStale(fetchedAt), true);
});

test('自定义 staleMs(1h)→ 1h1m 前缓存 stale=true', () => {
  const fetchedAt = Date.now() - (1 * 60 * 60 * 1000 + 60000);
  assert.strictEqual(checkStale(fetchedAt, 3600000), true);
});

// ============================================================
// 4. mock-server URL 匹配问题验证
// ============================================================
// 来源:test/e2e-auto-collect/mock-server/server.js L57-60, L507-509

console.log('\n=== 4. mock-server URL 匹配问题 ===');

// mock-server 的 extractSkuFromPath
function mockExtractSkuFromPath(pathname) {
  const m = pathname.match(/-(\d{5,})\/?/);
  return m ? m[1] : null;
}

// mock-server 的 composer GET SKU 提取(L507-509)
function mockExtractComposerGetSku(fullUrl) {
  const urlParam = fullUrl.searchParams.get('url') || '';
  const m = urlParam.match(/-(\d{5,})\/?/);
  return m ? m[1] : null;
}

test('★modal URL 不匹配 -\\d{5,}/ 正则 → SKU 提取失败', () => {
  // SW 侧 followSell modal 请求 URL:
  // /api/composer-api.bx/page/json/v2?url=%2Fmodal%2FotherOffersFromSellers%3Fproduct_id%3D100001
  const modalUrl = new URL(
    'http://localhost:7777/api/composer-api.bx/page/json/v2?url=' +
      encodeURIComponent('/modal/otherOffersFromSellers?product_id=100001')
  );
  const sku = mockExtractComposerGetSku(modalUrl);
  assert.strictEqual(sku, null, 'modal URL 不含 -数字/ 模式,SKU 提取为 null');
  console.log('    ⚠️  mock-server 无法从 modal URL 提取 SKU → composerResponse(null) → 无 widgetStates');
});

test('主产品页 URL 正常匹配 -\\d{5,}/ 正则', () => {
  const productUrl = new URL(
    'http://localhost:7777/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent('/product/test-slug-100001/')
  );
  const sku = mockExtractComposerGetSku(productUrl);
  assert.strictEqual(sku, '100001');
});

test('★mock-server composerResponse 把 followSell 放在错误 widget', () => {
  // mock-server L323: followSell 放在 searchResultsV2-${sku} widget 内
  // SW 代码 L2312: 查找 webSellerList-* 开头的 key
  const mockResp = {
    widgetStates: {
      'searchResultsV2-100001': JSON.stringify({
        followSell: { count: 5, sellers: [{ name: 'Seller A' }] },
      }),
    },
  };
  const wslKey = Object.keys(mockResp.widgetStates).find((k) => k.startsWith('webSellerList'));
  assert.strictEqual(wslKey, undefined, 'mock-server 响应中无 webSellerList-* widget');
  console.log('    ⚠️  mock-server 把 followSell 放在 searchResultsV2,SW 查找 webSellerList → 找不到');
});

test('正确的 webSellerList widget 结构', () => {
  const correctResp = {
    widgetStates: {
      'webSellerList-100001': JSON.stringify({
        sellers: [
          { name: 'Seller A', price: { cardPrice: { price: '100 ₽' } } },
          { name: 'Seller B', price: { cardPrice: { price: '200 ₽' } } },
        ],
      }),
    },
  };
  const wslKey = Object.keys(correctResp.widgetStates).find((k) => k.startsWith('webSellerList'));
  assert.ok(wslKey, '应找到 webSellerList-* key');
  const wsl = JSON.parse(correctResp.widgetStates[wslKey]);
  assert.strictEqual(wsl.sellers.length, 2);
});

// ============================================================
// 5. _checkAllCachesHit 中的 stale 判定
// ============================================================

console.log('\n=== 5. _checkAllCachesHit stale 判定 ===');

function checkFollowSellHit(followSellCache) {
  // 来源:service-worker.js L5297
  return !!followSellCache && !followSellCache.stale;
}

test('缓存存在且未 stale → hit=true', () => {
  const cache = { data: { count: 5 }, fetchedAt: Date.now() - 1000, stale: false };
  assert.strictEqual(checkFollowSellHit(cache), true);
});

test('缓存存在但 stale → hit=false(需重新采集)', () => {
  const cache = { data: { count: 5 }, fetchedAt: Date.now() - 5000000, stale: true };
  assert.strictEqual(checkFollowSellHit(cache), false);
});

test('缓存不存在 → hit=false', () => {
  assert.strictEqual(checkFollowSellHit(null), false);
});

test('★零跟卖缓存(count=0)未 stale → hit=true(不会重复采集)', () => {
  const cache = {
    data: { count: 0, sellers: [], source: 'no-sellers' },
    fetchedAt: Date.now() - 1000,
    stale: false,
  };
  assert.strictEqual(checkFollowSellHit(cache), true);
  console.log('    ℹ️  零跟卖缓存 4h 内 hit=true,不会重复采集(预期行为)');
});

// ============================================================
// 6. 综合场景:模拟完整采集流程
// ============================================================

console.log('\n=== 6. 综合场景 ===');

testAsync('★完整流程:反爬 stub → 缓存零跟卖 → 4h 内不再重试', async () => {
  // 场景:Ozon 返回 200 但空 widgetStates(反爬 stub)
  const antiBotResp = { ok: true, status: 200, jsonData: { widgetStates: {} } };

  // Step1: SW 解析 modal
  const followSellData = swParseFollowSellModal(antiBotResp, '100001');

  // Step2: 写缓存(模拟 _followSellCacheSet)
  const cache = followSellData ? { data: followSellData, fetchedAt: Date.now(), stale: false } : null;

  // Step3: 下次 _checkAllCachesHit 检查
  const hit = checkFollowSellHit(cache);

  assert.ok(followSellData, '反爬 stub 被解析为非 null');
  assert.strictEqual(followSellData.count, 0);
  assert.strictEqual(followSellData.source, 'no-sellers');
  assert.ok(cache, '缓存被写入');
  assert.strictEqual(hit, true, '4h 内 hit=true,不再重试');

  console.log('    ✗ 反爬 stub 被缓存为零跟卖,4h 内所有 SKU 都不会再尝试采集跟卖');
  console.log('    → 这就是"采集不到跟卖列表"的根因之一');
});

testAsync('正常流程:有跟卖 → 缓存 → 4h 内 hit', async () => {
  const normalResp = {
    ok: true,
    status: 200,
    jsonData: {
      widgetStates: {
        'webSellerList-100001': JSON.stringify({
          sellers: [
            { name: 'Seller A', price: { cardPrice: { price: '100 ₽' } } },
            { name: 'Seller B', price: { cardPrice: { price: '200 ₽' } } },
          ],
        }),
      },
    },
  };

  const followSellData = swParseFollowSellModal(normalResp, '100001');
  const cache = followSellData ? { data: followSellData, fetchedAt: Date.now(), stale: false } : null;
  const hit = checkFollowSellHit(cache);

  assert.strictEqual(followSellData.count, 2);
  assert.strictEqual(followSellData.sellers.length, 2);
  assert.strictEqual(hit, true);
});

testAsync('HTTP 403 → 不写缓存 → 下次仍会重试', async () => {
  const resp403 = { ok: false, status: 403, jsonData: null };

  const followSellData = swParseFollowSellModal(resp403, '100001');
  const cache = followSellData ? { data: followSellData, fetchedAt: Date.now(), stale: false } : null;
  const hit = checkFollowSellHit(cache);

  assert.strictEqual(followSellData, null);
  assert.strictEqual(cache, null);
  assert.strictEqual(hit, false, '无缓存 → 下次会重试');
});

// ============================================================
// 7. 运行总结
// ============================================================

setTimeout(() => {
  console.log('\n' + '='.repeat(60));
  console.log(`测试结果: ${_passCount} 通过, ${_failCount} 失败`);
  if (_failures.length > 0) {
    console.log('\n失败项:');
    _failures.forEach((f) => {
      console.log(`  - ${f.name}: ${f.error.message}`);
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log('问题根因分析:');
  console.log('');
  console.log('1. ★★fsSku 提取失败(已确认真实根因):');
  console.log('   service-worker.js L2291 旧代码:');
  console.log('   const fsSku = (relPath.match(/-(\\d+)\\/?$/) || [])[1] || "";');
  console.log('   relPath = pathname + search,card.url 带 ?query=... 后缀,');
  console.log('   正则要求以 -数字/ 结尾 → 失配 → fsSku="" → modal 不执行。');
  console.log('   已修复:先 relPath.split("?")[0] 去 query 再匹配。');
  console.log('');
  console.log('2. ★反爬 stub 误判(潜在风险):');
  console.log('   SW 侧(L2311-2315)遇到空 widgetStates 不 throw,');
  console.log('   返回 {count:0, source:"no-sellers"} 并写缓存。');
  console.log('   4h 内所有受影响 SKU 都不会再尝试采集跟卖。');
  console.log('   content 侧(L2524-2527)会 throw 并触发退避,行为正确。');
  console.log('');
  console.log('3. mock-server 不支持 modal endpoint(E2E 测试根因):');
  console.log('   mock-server 用 /-(\\d{5,})\\/?/ 正则提取 SKU,');
  console.log('   但 modal URL 是 /modal/otherOffersFromSellers?product_id=xxx');
  console.log('   不匹配 → SKU=null → 无 widgetStates → 触发问题 2');
  console.log('');
  console.log('4. mock-server followSell 数据放错 widget:');
  console.log('   放在 searchResultsV2-${sku}(L323),');
  console.log('   SW 查找 webSellerList-*(L2312)找不到。');
  console.log('');
  console.log('5. count 与 sellers.length 不一致(数据问题):');
  console.log('   count=rawSellers.length,但 normSeller 可能返回 null 被 filter');
  console.log('   导致 UI 显示跟卖数 > 实际 seller 列表长度');
  console.log('');
  console.log('修复建议:');
  console.log('   [已修复] P0: fsSku 提取去 query string(L2291-2295)');
  console.log('   P1: SW 侧空 widgetStates 应 throw或不写缓存(对齐 content 侧)');
  console.log('   P1: mock-server 增加 /modal/otherOffersFromSellers 路由处理');
  console.log('   P1: mock-server composerResponse 区分 modal 请求(返回 webSellerList)');
  console.log('   P2: count 改为 sellers.length(normalize 后)');
  console.log('');

  process.exit(_failCount > 0 ? 1 : 0);
}, 500);
