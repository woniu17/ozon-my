// 定点测试:验 lib/followsell-assembly.js 的结构逻辑(15 风险点抽样)。
// 用确定性 stub 依赖(与原 window.* 调用点一致),断言特定字段/分支。
'use strict';

// ── stub 全局依赖(模块在 Node 里 root=globalThis,调用时读)──
globalThis.normalizePrice = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
globalThis.jzPreferSourceName = (src, dom) => dom || src; // 简化:干净 dom 优先
globalThis.jzStripPromo = (s) => s;                        // 无促销可剥 = identity
globalThis.jzIsPromoResidualTitle = () => false;          // 从不判为残词
globalThis.JZFollowSellContentCopy = {
  pickFollowSellDescription: ({ customDescription, fallbackName }) => customDescription || fallbackName,
  mergeSourceHashtagsIntoVariant: () => {},               // no-op
};

const { assembleFollowSellItems } = require('../lib/followsell-assembly.js');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`✗ ${name}\n    got : ${g}\n    want: ${w}`); }
};
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`✗ ${name} ${extra || ''}`); } };

const baseCfg = (o = {}) => Object.assign({
  brandChoice: 'no_brand', imageOrder: 'keep', mergeModel: '', currencyCode: 'CNY',
  independentProducts: false, customDescription: undefined,
}, o);
const baseCtx = (o = {}) => Object.assign({ sku: undefined, brand: '', breadcrumbs: [], scrapedDims: {}, sharedHashtags: [] }, o);
const rs = (o = {}) => Object.assign({
  sku: 'S1', coverImage: '', variantTitle: 'T', priceRaw: '100', oldPriceRaw: '200',
  minPriceRaw: '', stockRaw: '3', offerIdRaw: 'off1',
  weightRaw: '', depthRaw: '', widthRaw: '', heightRaw: '', domTitleRaw: 'Name', baseTitle: 'Name',
}, o);
const run = (input) => assembleFollowSellItems(Object.assign({
  rowSpecs: [], sourceMap: new Map(), galleryMap: new Map(), richContentMap: new Map(),
  matched: [], pageCtx: baseCtx(), config: baseCfg(), sharedVideo: null,
}, input));

// ── A. 缺全部三维 → weight/depth/... 为 undefined,无 weight_unit/dimension_unit ──
{
  const it = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]) })[0];
  ok('A.weight undefined', it.weight === undefined);
  ok('A.weight_unit undefined', it.weight_unit === undefined);
  ok('A.dimension_unit undefined', it.dimension_unit === undefined);
  ok('A.no min_price key', !('min_price' in it) === false ? ('min_price' in it) === false : true, `(min_price in it = ${'min_price' in it})`);
  ok('A.min_price absent', !('min_price' in it));
  ok('A.scraped_weight undefined', it.scraped_weight === undefined);
}

// ── B. 源 4383 俄式逗号 "0,05" → 50g(n<100 → *1000)──
{
  const sm = new Map([['S1', { attributes: [{ key: '4383', value: '0,05' }] }]]);
  const it = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: sm })[0];
  ok('B.weight 0,05kg→50g', it.weight === 50, `(got ${it.weight})`);
  ok('B.weight_unit g', it.weight_unit === 'g');
}

// ── C. 源 4383 "150"(>100)→ 原样 150 ──
{
  const sm = new Map([['S1', { attributes: [{ key: '4383', value: '150' }] }]]);
  const it = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: sm })[0];
  ok('C.weight 150→150', it.weight === 150, `(got ${it.weight})`);
}

// ── C2. 4497(packaged g) 优先于 4383 ──
{
  const sm = new Map([['S1', { attributes: [{ key: '4497', value: '250' }, { key: '4383', value: '0,05' }] }]]);
  const it = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: sm })[0];
  ok('C2.weight 4497 wins', it.weight === 250, `(got ${it.weight})`);
}

// ── C3. 用户输入优先于源;"1.2kg" 带单位 → NaN → 未填 → 退源 ──
{
  const sm = new Map([['S1', { attributes: [{ key: '4497', value: '250' }] }]]);
  const it1 = run({ rowSpecs: [rs({ weightRaw: '300' })], matched: ['S1'], sourceMap: sm })[0];
  ok('C3.user 300 wins', it1.weight === 300, `(got ${it1.weight})`);
  const it2 = run({ rowSpecs: [rs({ weightRaw: '1.2kg' })], matched: ['S1'], sourceMap: sm })[0];
  ok('C3.user "1.2kg"→NaN→源250', it2.weight === 250, `(got ${it2.weight})`);
}

// ── D. min_price 条件:'50'→发,''→不发,'0'→不发 ──
{
  const sm = () => new Map([['S1', { attributes: [] }]]);
  const a = run({ rowSpecs: [rs({ minPriceRaw: '50' })], matched: ['S1'], sourceMap: sm() })[0];
  eq('D.min_price 50', a.min_price, '50.00');
  const b = run({ rowSpecs: [rs({ minPriceRaw: '' })], matched: ['S1'], sourceMap: sm() })[0];
  ok('D.min_price empty absent', !('min_price' in b));
  const c = run({ rowSpecs: [rs({ minPriceRaw: '0' })], matched: ['S1'], sourceMap: sm() })[0];
  ok('D.min_price 0 absent', !('min_price' in c));
}

// ── E. 图片 else-if:无图册→sv 4194/4195;都无→coverImage;有图册→图册(忽略 sv)──
{
  const svImg = { attributes: [{ key: '4194', value: 'p.jpg' }, { key: '4195', collection: ['a.jpg', 'b.jpg'] }] };
  const e1 = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', svImg]]) })[0];
  eq('E.sv images', e1.images.map(i => i.file_name), ['p.jpg', 'a.jpg', 'b.jpg']);
  ok('E.default first', e1.images[0].default === true && e1.images[1].default === false);
  const e2 = run({ rowSpecs: [rs({ coverImage: 'cov.jpg' })], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]) })[0];
  eq('E.coverImage fallback', e2.images.map(i => i.file_name), ['cov.jpg']);
  const gm = new Map([['S1', ['g1.jpg', 'g2.jpg']]]);
  const e3 = run({ rowSpecs: [rs({ coverImage: 'cov.jpg' })], matched: ['S1'], sourceMap: new Map([['S1', svImg]]), galleryMap: gm })[0];
  eq('E.gallery wins', e3.images.map(i => i.file_name), ['g1.jpg', 'g2.jpg']);
}

// ── F. pushUrl 去重(?/# 归一 + 小写)──
{
  const gm = new Map([['S1', ['http://x/A.jpg?v=1', 'http://x/a.jpg#frag', 'http://x/b.jpg']]]);
  const it = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]), galleryMap: gm })[0];
  eq('F.dedup', it.images.map(i => i.file_name), ['http://x/A.jpg?v=1', 'http://x/b.jpg']);
}

// ── G. 类目对齐:S1 锚点(cat10/type TA)→ S2 对齐到 10/TA;原 S1 不变 ──
{
  const s1 = { description_category_id: 10, categories: [{ name: 'C10' }], attributes: [{ key: '8229', value: 'TA' }] };
  const s2 = { description_category_id: 20, categories: [{ name: 'C20' }], attributes: [{ key: '8229', value: 'TB' }, { key: '4180', value: 'S2name' }] };
  const sm = new Map([['S1', s1], ['S2', s2]]);
  const items = run({
    rowSpecs: [rs({ sku: 'S1' }), rs({ sku: 'S2' })], matched: ['S1', 'S2'],
    sourceMap: sm, pageCtx: baseCtx({ sku: 'S1' }),
  });
  const it2sv = items[1]._sourceVariant;
  ok('G.S2 cat aligned', it2sv.description_category_id === 10, `(got ${it2sv.description_category_id})`);
  eq('G.S2 categories aligned', it2sv.categories, [{ name: 'C10' }]);
  ok('G.S2 8229 aligned', it2sv.attributes.find(a => a.key === '8229').value === 'TA');
  ok('G.S1 sv untouched', s1.description_category_id === 10 && s1.attributes.find(a => a.key === '8229').value === 'TA');
}

// ── H. independentProducts:不对齐,S2 保留自身类目 ──
{
  const s1 = { description_category_id: 10, categories: [{ name: 'C10' }], attributes: [{ key: '8229', value: 'TA' }] };
  const s2 = { description_category_id: 20, categories: [{ name: 'C20' }], attributes: [{ key: '8229', value: 'TB' }] };
  const sm = new Map([['S1', s1], ['S2', s2]]);
  const items = run({
    rowSpecs: [rs({ sku: 'S1' }), rs({ sku: 'S2' })], matched: ['S1', 'S2'],
    sourceMap: sm, pageCtx: baseCtx({ sku: 'S1' }), config: baseCfg({ independentProducts: true }),
  });
  ok('H.S2 keeps own cat', items[1]._sourceVariant.description_category_id === 20);
}

// ── I. 11254 幂等注入 + description 用富内容路径(stub 用 fallbackName,这里验注入)──
{
  const sv = { attributes: [{ key: '4180', value: 'Src' }] };
  const rc = new Map([['S1', 'RCJSON']]);
  const it = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', sv]]), richContentMap: rc })[0];
  const has11254 = it._sourceVariant.attributes.filter(a => a.key === '11254');
  ok('I.11254 injected once', has11254.length === 1 && has11254[0].value === 'RCJSON', `(count ${has11254.length})`);
  // 已有 11254 → 不重复
  const sv2 = { attributes: [{ key: '11254', value: 'OLD' }] };
  const it2 = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', sv2]]), richContentMap: rc })[0];
  const c2 = it2._sourceVariant.attributes.filter(a => a.key === '11254');
  ok('I.11254 idempotent', c2.length === 1 && c2[0].value === 'OLD', `(count ${c2.length})`);
}

// ── J. offerId 兜底 SKU<sku>-<last4> ──
{
  const it = run({ rowSpecs: [rs({ offerIdRaw: '' })], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]) })[0];
  ok('J.offerId fallback', /^SKUS1-\w{4}$/.test(it.offer_id), `(got ${it.offer_id})`);
}

// ── K. brandChoice copy + brand → scraped_brand_value;非 copy → undefined ──
{
  const cp = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]),
    pageCtx: baseCtx({ brand: 'Nike' }), config: baseCfg({ brandChoice: 'copy' }) })[0];
  ok('K.copy brand value', cp.scraped_brand_value === 'Nike');
  ok('K.copy scraped_brand', cp.scraped_brand === 'copy');
  const nb = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]),
    pageCtx: baseCtx({ brand: 'Nike' }) })[0];
  ok('K.no_brand value undefined', nb.scraped_brand_value === undefined);
}

// ── L. old_price 兜底 price*1.25;price 用 normalizePrice ──
{
  const it = run({ rowSpecs: [rs({ priceRaw: '80', oldPriceRaw: '' })], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]) })[0];
  eq('L.price', it.price, '80.00');
  eq('L.old_price fallback 1.25', it.old_price, '100.00'); // 80*1.25=100
}

// ── M. _aiHashtags 条件 + currency_code + vat ──
{
  const withTags = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]),
    pageCtx: baseCtx({ sharedHashtags: ['#a', '#b'] }) })[0];
  eq('M._aiHashtags present', withTags._aiHashtags, ['#a', '#b']);
  const noTags = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]) })[0];
  ok('M._aiHashtags absent', !('_aiHashtags' in noTags));
  ok('M.vat 0', withTags.vat === '0');
  const cur = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]), config: baseCfg({ currencyCode: 'RUB' }) })[0];
  ok('M.currency', cur.currency_code === 'RUB');
}

// ── N. sharedVideo 条件展开 ──
{
  const v = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]), sharedVideo: { url: 'v.mp4', cover: 'c.jpg' } })[0];
  ok('N.videoUrl', v.videoUrl === 'v.mp4');
  ok('N.videoCover', v.videoCover === 'c.jpg');
  const nv = run({ rowSpecs: [rs()], matched: ['S1'], sourceMap: new Map([['S1', { attributes: [] }]]), sharedVideo: null })[0];
  ok('N.no video keys', !('videoUrl' in nv) && !('videoCover' in nv));
}

// ── O. 名称链:titleEdited(dom≠base,非翻译)→ dom ──
{
  const sv = { attributes: [{ key: '4180', value: 'SourceName' }] };
  const it = run({ rowSpecs: [rs({ domTitleRaw: 'Edited Title', baseTitle: 'Orig Title' })], matched: ['S1'], sourceMap: new Map([['S1', sv]]) })[0];
  ok('O.titleEdited→dom', it.name === 'Edited Title', `(got ${it.name})`);
  // domName '-' → 空,退 jzPreferSourceName(stub dom||src)= '' || 'SourceName'
  const it2 = run({ rowSpecs: [rs({ domTitleRaw: '-', baseTitle: '' })], matched: ['S1'], sourceMap: new Map([['S1', sv]]) })[0];
  ok('O.dash→source', it2.name === 'SourceName', `(got ${it2.name})`);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
