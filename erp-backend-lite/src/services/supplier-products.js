// 货源商品(2026-11-27)
// 目标:为每个 Ozon SKU 维护平台货源商品(1688 / 拼多多):平台商品ID(1688 offerId /
// 拼多多 goods_id)、规格SKU(1688)、规格文本、图片、最近采购价/次数、供应商/采购账号。
//
// 数据来源:
//   1) 采购订单 op_purchase_order.items_json(平台订单导入/补全时写入 goodsId/skuId/spec/price/thumbUrl)
//   2) op_purchase_link → op_ozon_order_item(sku/offer_id) 打通「采购单 ↔ Ozon SKU」
//
// 策略(用户 2026-11-27 确认):
//   - 独立「货源管理」页维护;多商品行订单只生成候选,人工确认,不自动绑定
//   - 单商品行采购单(无歧义)在采购保存/补全时自动积累
//   - 历史采购单支持一次性回填(仅单商品行无歧义订单)
import { db } from '../db/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { imageCacheUrlFor } from './order-image-cache.js';

const nowIso = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isBlank = (v) => v == null || String(v).trim() === '';

function parseJsonArray(s) {
  try {
    const v = JSON.parse(s || '');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseProductData(s) {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 平台货源商品 URL(当前仅 1688;其它平台按已知规则预留) */
export function buildSourceUrl(platform, itemId) {
  const id = String(itemId || '').trim();
  if (!id) return '';
  switch (String(platform || '')) {
    case '1688':
    case 'ali1688':
      return `https://detail.1688.com/offer/${id}.html`;
    case 'taobao':
      return `https://item.taobao.com/item.htm?id=${id}`;
    case 'yangkeduo':
    case 'pdd':
      return `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`;
    case 'xianyu':
      return '';
    default:
      return '';
  }
}

/** 从 1688/拼多多 链接或纯 ID 中提取商品 ID */
export function parseSourceItemId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = /offer\/(\d{6,})/i.exec(s)
    || /goods_id=(\d{6,})/i.exec(s)
    || /(\d{6,})/.exec(s);
  return m ? m[1] : '';
}

// 支持维护货源的平台(2026-11-27:1688 + 拼多多;淘宝/闲鱼后续按需放开)
export const SUPPORTED_SOURCE_PLATFORMS = new Set(['1688', 'yangkeduo']);
const SOURCE_PLATFORM_ALIASES = { ali1688: '1688', pdd: 'yangkeduo' };

export function normalizeSourcePlatform(p) {
  const s = String(p || '').trim();
  return SOURCE_PLATFORM_ALIASES[s] || s;
}

/** 按链接识别平台(手动新增货源用):拼多多优先,其次 1688 */
export function detectSourcePlatform(input, fallback = '1688') {
  const s = String(input || '').toLowerCase();
  if (/yangkeduo|pinduoduo/.test(s)) return 'yangkeduo';
  if (/1688/.test(s)) return '1688';
  return normalizeSourcePlatform(fallback) || '1688';
}

/** 货源身份键:有规格SKU用 skuId;没有(拼多多/老数据)用规格文本区分同商品不同规格 */
function sourceIdentityKey({ sku, platform, gid, sid, spec }) {
  const tail = sid ? sid : `~${String(spec || '').trim()}`;
  return `${sku}|${platform}|${gid}|${tail}`;
}

/** Ozon 商品简介(product_data_cache) */
function briefFromData(sku, storeId, data) {
  return {
    sku: Number(sku) || null,
    storeId: storeId || data.store_id || '',
    name: data.name || data.offer_id || '',
    offerId: data.offer_id || '',
    image: Array.isArray(data.images) && data.images.length ? data.images[0] : '',
    alias: data.alias || '',
  };
}

function resolveOzonProduct(sku) {
  const row = db
    .prepare(`SELECT sku, store_id, data FROM product_data_cache WHERE sku = ?`)
    .get(String(sku || ''));
  if (!row) return null;
  return { row, data: parseProductData(row.data) };
}

/** 批量取商品简介:sku -> brief */
function loadProductBriefs(skus) {
  const list = [...new Set((skus || []).map((s) => String(s || '')).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const ph = list.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT sku, store_id, data FROM product_data_cache WHERE sku IN (${ph})`)
    .all(...list);
  for (const r of rows) map.set(String(r.sku), briefFromData(r.sku, r.store_id, parseProductData(r.data)));
  return map;
}

/** 货源库已有键集合(与候选聚合同键口径) */
function loadExistingKeys() {
  const set = new Set();
  const rows = db
    .prepare(
      `SELECT COALESCE(ozon_sku, 0) AS sku, platform,
              COALESCE(source_item_id, '') AS gid, COALESCE(source_sku_id, '') AS sid,
              COALESCE(source_spec, '') AS spec
       FROM op_supplier_product`
    )
    .all();
  for (const r of rows) {
    set.add(sourceIdentityKey({ sku: r.sku, platform: r.platform, gid: r.gid, sid: r.sid, spec: r.spec }));
  }
  return set;
}

/**
 * 历史采购 → 货源候选聚合(1688 + 拼多多)
 * 每条 items_json 商品行(有非空 goodsId)生成候选,按身份键聚合:
 * 采购次数(去重采购单)、最近采购价/时间/单号、供应商/账号、商品名/规格/图片。
 * @returns {Map<string, object>} key = sourceIdentityKey(...)
 */
export function collectHistoryCandidates({ sku = null, platform = null } = {}) {
  const plats = platform
    ? [normalizeSourcePlatform(platform)].filter((p) => SUPPORTED_SOURCE_PLATFORMS.has(p))
    : [...SUPPORTED_SOURCE_PLATFORMS];
  if (!plats.length) return new Map();
  const params = [...plats];
  let where = `po.platform IN (${plats.map(() => '?').join(',')})
    AND po.items_json IS NOT NULL AND po.items_json LIKE '%goodsId%'`;
  if (sku != null) {
    where += ' AND oi.sku = ?';
    params.push(Number(sku));
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT oi.sku AS sku, oi.offer_id AS offer_id, p.store_id AS store_id,
              po.id AS po_id, po.purchase_sn, po.platform, po.buyer_account, po.seller_name,
              po.items_json, COALESCE(po.pay_at, po.gmt_create) AS purchase_at
       FROM op_purchase_link pl
       JOIN op_ozon_order_item oi ON oi.id = pl.ozon_order_item_id
       JOIN op_purchase_order po ON po.id = pl.purchase_order_id
       LEFT JOIN op_package p ON p.id = pl.package_id
       WHERE ${where}
       ORDER BY purchase_at DESC`
    )
    .all(...params);

  const map = new Map();
  for (const r of rows) {
    const goods = parseJsonArray(r.items_json);
    const ambiguous = goods.length > 1; // 多商品行采购单:无法确定与 Ozon SKU 的对应关系
    for (const g of goods) {
      const gid = String(g.goodsId || '').trim();
      if (!gid) continue;
      const sid = String(g.skuId || '').trim();
      const key = sourceIdentityKey({ sku: r.sku, platform: r.platform, gid, sid, spec: g.spec });
      let c = map.get(key);
      if (!c) {
        c = {
          ozonSku: Number(r.sku),
          offerId: r.offer_id || '',
          storeId: r.store_id || '',
          platform: r.platform,
          sourceItemId: gid,
          sourceSkuId: sid,
          sourceUrl: buildSourceUrl(r.platform, gid),
          title: g.goodsName || '',
          sourceSpec: g.spec || '',
          sourceImage: g.thumbUrl || '',
          sellerName: r.seller_name || '',
          buyerAccount: r.buyer_account || '',
          lastPrice: Number(g.price) || 0,
          lastPurchaseAt: r.purchase_at || '',
          lastPurchaseSn: r.purchase_sn || '',
          purchaseCount: 0,
          ambiguous,
          _poIds: new Set(),
        };
        map.set(key, c);
      }
      if (!c._poIds.has(r.po_id)) {
        c._poIds.add(r.po_id);
        c.purchaseCount += 1;
      }
    }
  }
  for (const c of map.values()) {
    delete c._poIds;
    c.sourceImage = imageCacheUrlFor(c.sourceImage) || '';
    c.lastPrice = round2(c.lastPrice);
  }
  return map;
}

/** DB 货源行 → 前端结构 */
function mapSourceRow(r, briefs) {
  const pdc = parseProductData(r.pdc_data);
  const product = briefs?.get(String(r.ozon_sku)) || briefFromData(r.ozon_sku, r.store_id, pdc);
  return {
    id: r.id,
    storeId: r.store_id,
    ozonSku: r.ozon_sku,
    offerId: r.offer_id || product.offerId || '',
    platform: r.platform,
    sourceUrl: r.source_url || buildSourceUrl(r.platform, r.source_item_id),
    sourceItemId: r.source_item_id || '',
    sourceSkuId: r.source_sku_id || '',
    sourceSpec: r.source_spec || '',
    sourceImage: imageCacheUrlFor(r.source_image) || '',
    title: r.title || '',
    sellerName: r.seller_name || '',
    buyerAccount: r.buyer_account || '',
    lastPrice: r.last_price != null ? Number(r.last_price) : null,
    lastPurchaseAt: r.last_purchase_at || '',
    lastPurchaseSn: r.last_purchase_sn || '',
    purchaseCount: r.purchase_count || 0,
    quantityRatio: r.quantity_ratio != null ? Number(r.quantity_ratio) : 1,
    isPrimary: !!r.is_primary,
    enabled: !!r.enabled,
    note: r.note || '',
    gmtCreate: r.gmt_create || '',
    gmtModified: r.gmt_modified || '',
    product,
  };
}

/** 货源列表(分页) */
export function listSources({ storeId = '', platform = '', keyword = '', page = 1, pageSize = 20 } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const where = [];
  const args = [];
  if (storeId) {
    where.push('sp.store_id = ?');
    args.push(storeId);
  }
  if (platform) {
    where.push('sp.platform = ?');
    args.push(normalizeSourcePlatform(platform));
  }
  const kw = String(keyword || '').trim();
  if (kw) {
    const like = `%${kw}%`;
    where.push(
      `(CAST(sp.ozon_sku AS TEXT) LIKE ? OR sp.offer_id LIKE ? OR sp.source_item_id LIKE ? OR sp.source_sku_id LIKE ? OR sp.title LIKE ? OR sp.source_spec LIKE ? OR pdc.data LIKE ?)`
    );
    args.push(like, like, like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM op_supplier_product sp
       LEFT JOIN product_data_cache pdc ON pdc.sku = CAST(sp.ozon_sku AS TEXT)
       ${whereSql}`
    )
    .get(...args).n;
  const rows = db
    .prepare(
      `SELECT sp.*, pdc.data AS pdc_data
       FROM op_supplier_product sp
       LEFT JOIN product_data_cache pdc ON pdc.sku = CAST(sp.ozon_sku AS TEXT)
       ${whereSql}
       ORDER BY sp.is_primary DESC, COALESCE(sp.last_purchase_at, sp.gmt_modified, sp.gmt_create) DESC, sp.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, size, (pageNum - 1) * size);
  const briefs = loadProductBriefs(rows.map((r) => r.ozon_sku));
  return { items: rows.map((r) => mapSourceRow(r, briefs)), total, page: pageNum, pageSize: size };
}

/**
 * 待确认候选(SKU 分组,仅返回尚未加入货源的候选)
 * 多商品行采购单的候选项带 ambiguous=true,前端提示「采购单含多件商品,请核对」
 */
export function listCandidates({ storeId = '', keyword = '', platform = '', page = 1, pageSize = 20 } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const existing = loadExistingKeys();
  const all = collectHistoryCandidates({ platform: platform || null });
  const groups = new Map();
  for (const c of all.values()) {
    if (existing.has(sourceIdentityKey({
      sku: c.ozonSku, platform: c.platform, gid: c.sourceItemId, sid: c.sourceSkuId, spec: c.sourceSpec,
    }))) continue;
    let g = groups.get(c.ozonSku);
    if (!g) {
      g = { ozonSku: c.ozonSku, offerId: c.offerId, storeId: c.storeId, latestAt: '', candidates: [] };
      groups.set(c.ozonSku, g);
    }
    g.candidates.push(c);
    if (!g.offerId) g.offerId = c.offerId;
    if (!g.storeId) g.storeId = c.storeId;
    if (String(c.lastPurchaseAt || '') > String(g.latestAt || '')) g.latestAt = c.lastPurchaseAt;
  }
  const briefs = loadProductBriefs([...groups.keys()]);
  for (const g of groups.values()) {
    g.product = briefs.get(String(g.ozonSku)) || briefFromData(g.ozonSku, g.storeId, {});
    if (!g.storeId) g.storeId = g.product.storeId || '';
    g.candidates.sort((a, b) => (b.purchaseCount || 0) - (a.purchaseCount || 0) || String(b.lastPurchaseAt).localeCompare(String(a.lastPurchaseAt)));
    g.candidateCount = g.candidates.length;
  }
  let list = [...groups.values()];
  if (storeId) list = list.filter((g) => g.storeId === storeId);
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((g) => {
      const hay = [
        g.ozonSku,
        g.offerId,
        g.product?.name,
        g.product?.offerId,
        ...g.candidates.flatMap((c) => [c.sourceItemId, c.sourceSkuId, c.title, c.sourceSpec]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(kw);
    });
  }
  list.sort((a, b) => String(b.latestAt || '').localeCompare(String(a.latestAt || '')));
  const total = list.length;
  const items = list.slice((pageNum - 1) * size, pageNum * size);
  return { items, total, page: pageNum, pageSize: size };
}

/** 单 SKU 货源详情:已维护货源 + 候选(含已存在标记) */
export function getSkuDetail(sku) {
  const product = resolveOzonProduct(sku);
  if (!product) throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `SKU ${sku} 未在本地商品缓存中,请先在商品列表同步该商品`);
  const brief = briefFromData(sku, product.row.store_id, product.data);
  const rows = db
    .prepare(`SELECT sp.* FROM op_supplier_product sp WHERE sp.ozon_sku = ? ORDER BY sp.is_primary DESC, sp.id DESC`)
    .all(Number(sku));
  const sources = rows.map((r) => mapSourceRow(r, new Map([[String(sku), brief]])));
  const existing = new Set(sources.map((s) => sourceIdentityKey({
    sku, platform: s.platform, gid: s.sourceItemId, sid: s.sourceSkuId, spec: s.sourceSpec,
  })));
  const candMap = collectHistoryCandidates({ sku });
  const candidates = [...candMap.values()].map((c) => ({
    ...c,
    exists: existing.has(sourceIdentityKey({
      sku: c.ozonSku, platform: c.platform, gid: c.sourceItemId, sid: c.sourceSkuId, spec: c.sourceSpec,
    })),
  }));
  candidates.sort((a, b) => (b.purchaseCount || 0) - (a.purchaseCount || 0));
  return { product: brief, sources, candidates };
}

/** 明确主货源(同一 SKU 仅一条) */
function applyPrimary(id, storeId, ozonSku) {
  db.prepare(`UPDATE op_supplier_product SET is_primary = 0, gmt_modified = ? WHERE store_id = ? AND ozon_sku = ?`).run(
    nowIso(),
    storeId,
    ozonSku
  );
  db.prepare(`UPDATE op_supplier_product SET is_primary = 1, gmt_modified = ? WHERE id = ?`).run(nowIso(), id);
}

/**
 * 新增/更新货源(按唯一键 upsert)
 * @param {object} p
 * @param {number} p.ozonSku
 * @param {string} [p.platform='1688']
 * @param {string} [p.sourceItemId] 1688商品ID(可传链接,自动解析)
 * @param {string} [p.sourceSkuId]
 * @param {string} [p.sourceUrl]
 * @param {string} [p.title]
 * @param {string} [p.sourceSpec]
 * @param {string} [p.sourceImage]
 * @param {string} [p.sellerName]
 * @param {string} [p.buyerAccount]
 * @param {number} [p.lastPrice]
 * @param {string} [p.lastPurchaseAt]
 * @param {string} [p.lastPurchaseSn]
 * @param {number} [p.purchaseCount]
 * @param {number} [p.quantityRatio=1]
 * @param {boolean} [p.isPrimary]
 * @param {boolean} [p.enabled=true]
 * @param {string} [p.note]
 * @returns {{id:number, created:boolean}}
 */
export function upsertSource(p = {}) {
  const platform = normalizeSourcePlatform(p.platform || '1688');
  if (!SUPPORTED_SOURCE_PLATFORMS.has(platform)) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, `暂不支持的货源平台: ${platform}(当前支持 1688/拼多多)`);
  }
  const ozonSku = Number(p.ozonSku);
  if (!Number.isInteger(ozonSku) || ozonSku <= 0) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, 'ozonSku 必填且必须为正整数');
  }
  const product = resolveOzonProduct(ozonSku);
  if (!product) {
    throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `SKU ${ozonSku} 未在本地商品缓存中,请先在商品列表同步该商品`);
  }
  const storeId = String(p.storeId || product.row.store_id || '');
  if (isBlank(storeId)) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId 缺失(商品缓存无店铺归属)');
  const sourceItemId = String(p.sourceItemId || '').trim() || parseSourceItemId(p.sourceUrl || '');
  if (!sourceItemId) throw new ApiError(ErrorCode.VALIDATION_ERROR, '请填写货源商品链接或商品ID(1688/拼多多)');
  const sourceSkuId = String(p.sourceSkuId || '').trim();
  const sourceSpec = String(p.sourceSpec || '').trim();
  const offerId = String(p.offerId || product.data.offer_id || '').trim();
  const sourceUrl = String(p.sourceUrl || '').trim() || buildSourceUrl(platform, sourceItemId);
  const now = nowIso();

  // 身份键:有平台规格SKU(如 1688 skuID)按 skuID;无 skuID(拼多多)按规格文本区分
  const existing = sourceSkuId
    ? db
        .prepare(
          `SELECT id, is_primary FROM op_supplier_product
           WHERE store_id = ? AND COALESCE(ozon_sku, 0) = ? AND platform = ?
             AND COALESCE(source_item_id, '') = ? AND COALESCE(source_sku_id, '') = ?`
        )
        .get(storeId, ozonSku, platform, sourceItemId, sourceSkuId)
    : db
        .prepare(
          `SELECT id, is_primary FROM op_supplier_product
           WHERE store_id = ? AND COALESCE(ozon_sku, 0) = ? AND platform = ?
             AND COALESCE(source_item_id, '') = ?
             AND COALESCE(source_sku_id, '') = '' AND COALESCE(source_spec, '') = ?`
        )
        .get(storeId, ozonSku, platform, sourceItemId, sourceSpec);

  const sets = [];
  const args = [];
  const set = (col, val) => {
    if (val === undefined) return;
    sets.push(`${col} = ?`);
    args.push(val);
  };
  set('offer_id', offerId || null);
  set('source_url', sourceUrl || null);
  set('title', isBlank(p.title) ? undefined : String(p.title));
  set('source_spec', isBlank(p.sourceSpec) ? undefined : String(p.sourceSpec).trim());
  set('source_image', isBlank(p.sourceImage) ? undefined : String(p.sourceImage));
  set('seller_name', isBlank(p.sellerName) ? undefined : String(p.sellerName));
  set('buyer_account', isBlank(p.buyerAccount) ? undefined : String(p.buyerAccount));
  if (p.lastPrice != null && Number.isFinite(Number(p.lastPrice))) set('last_price', round2(p.lastPrice));
  set('last_purchase_at', isBlank(p.lastPurchaseAt) ? undefined : String(p.lastPurchaseAt));
  set('last_purchase_sn', isBlank(p.lastPurchaseSn) ? undefined : String(p.lastPurchaseSn));
  if (p.purchaseCount != null && Number.isFinite(Number(p.purchaseCount))) set('purchase_count', Number(p.purchaseCount));
  if (p.quantityRatio != null && Number.isFinite(Number(p.quantityRatio)) && Number(p.quantityRatio) > 0) {
    set('quantity_ratio', Number(p.quantityRatio));
  }
  set('note', p.note === undefined ? undefined : String(p.note || ''));
  if (p.enabled !== undefined) set('enabled', p.enabled ? 1 : 0);

  let id;
  let created = false;
  if (existing) {
    id = existing.id;
    if (sets.length) {
      sets.push('gmt_modified = ?');
      args.push(now, id);
      db.prepare(`UPDATE op_supplier_product SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
  } else {
    created = true;
    const hasPrimary = db
      .prepare(`SELECT COUNT(*) AS n FROM op_supplier_product WHERE store_id = ? AND ozon_sku = ? AND is_primary = 1`)
      .get(storeId, ozonSku).n;
    const isPrimary = p.isPrimary === true || !hasPrimary;
    const base = {
      store_id: storeId,
      offer_id: offerId || null,
      ozon_sku: ozonSku,
      platform,
      source_url: sourceUrl || null,
      source_item_id: sourceItemId,
      source_sku_id: sourceSkuId || null,
      source_spec: isBlank(p.sourceSpec) ? null : String(p.sourceSpec).trim(),
      source_image: isBlank(p.sourceImage) ? null : String(p.sourceImage),
      seller_name: isBlank(p.sellerName) ? null : String(p.sellerName),
      buyer_account: isBlank(p.buyerAccount) ? null : String(p.buyerAccount),
      title: isBlank(p.title) ? null : String(p.title),
      last_price: p.lastPrice != null && Number.isFinite(Number(p.lastPrice)) ? round2(p.lastPrice) : null,
      last_purchase_at: isBlank(p.lastPurchaseAt) ? null : String(p.lastPurchaseAt),
      last_purchase_sn: isBlank(p.lastPurchaseSn) ? null : String(p.lastPurchaseSn),
      purchase_count: p.purchaseCount != null && Number.isFinite(Number(p.purchaseCount)) ? Number(p.purchaseCount) : 0,
      quantity_ratio: p.quantityRatio != null && Number(p.quantityRatio) > 0 ? Number(p.quantityRatio) : 1,
      is_primary: isPrimary ? 1 : 0,
      enabled: p.enabled === false ? 0 : 1,
      note: p.note == null ? null : String(p.note),
      gmt_create: now,
      gmt_modified: now,
    };
    const cols = Object.keys(base);
    const ins = db
      .prepare(`INSERT INTO op_supplier_product (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((k) => base[k]));
    id = Number(ins.lastInsertRowid);
    if (isPrimary) applyPrimary(id, storeId, ozonSku);
  }
  if (p.isPrimary === true && !created) applyPrimary(id, storeId, ozonSku);
  return { id, created };
}

/** 修改货源(规格/配比/备注/标题/链接/启用) */
export function updateSource(id, p = {}) {
  const row = db.prepare(`SELECT * FROM op_supplier_product WHERE id = ?`).get(Number(id));
  if (!row) throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '货源不存在');
  const sets = [];
  const args = [];
  const set = (col, val) => {
    if (val === undefined) return;
    sets.push(`${col} = ?`);
    args.push(val);
  };
  if (p.title !== undefined) set('title', String(p.title || ''));
  if (p.sourceSpec !== undefined) set('source_spec', String(p.sourceSpec || ''));
  if (p.sourceSkuId !== undefined) set('source_sku_id', String(p.sourceSkuId || '') || null);
  if (p.sourceUrl !== undefined) {
    const sid = parseSourceItemId(p.sourceUrl);
    if (sid) {
      set('source_item_id', sid);
      set('source_url', String(p.sourceUrl || buildSourceUrl(row.platform, sid)));
    } else {
      set('source_url', String(p.sourceUrl || ''));
    }
  }
  if (p.quantityRatio !== undefined) {
    const v = Number(p.quantityRatio);
    if (!Number.isFinite(v) || v <= 0) throw new ApiError(ErrorCode.VALIDATION_ERROR, '配比必须为正数');
    set('quantity_ratio', v);
  }
  if (p.note !== undefined) set('note', String(p.note || ''));
  if (p.enabled !== undefined) set('enabled', p.enabled ? 1 : 0);
  if (sets.length) {
    sets.push('gmt_modified = ?');
    args.push(nowIso(), row.id);
    db.prepare(`UPDATE op_supplier_product SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  if (p.isPrimary === true) applyPrimary(row.id, row.store_id, row.ozon_sku);
  return { id: row.id, updated: sets.length > 0 || p.isPrimary === true };
}

export function deleteSource(id) {
  const r = db.prepare(`DELETE FROM op_supplier_product WHERE id = ?`).run(Number(id));
  return { deleted: r.changes > 0 };
}

export function setPrimary(id) {
  const row = db.prepare(`SELECT * FROM op_supplier_product WHERE id = ?`).get(Number(id));
  if (!row) throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '货源不存在');
  applyPrimary(row.id, row.store_id, row.ozon_sku);
  return { id: row.id, isPrimary: true };
}

/** 批量确认候选(人工确认后加入货源) */
export function confirmCandidates(items = []) {
  let created = 0;
  let updated = 0;
  const errors = [];
  for (const it of items) {
    try {
      const r = upsertSource({ ...it, platform: it.platform || '1688' });
      if (r.created) created += 1;
      else updated += 1;
    } catch (e) {
      errors.push({ ozonSku: it?.ozonSku, sourceItemId: it?.sourceItemId, error: e?.message || String(e) });
    }
  }
  return { created, updated, errors };
}

/**
 * 历史采购回填:仅「单商品行 + 单 SKU」的无歧义采购单自动建档并刷新统计。
 * 多商品行/多 SKU 不自动绑定(在「待确认候选」里人工确认)。
 * 采购次数/最近价按该 SKU 全部历史采购聚合(幂等,可重复执行)。
 */
export function backfillFromHistory() {
  const orders = db
    .prepare(
      `SELECT po.id AS po_id, po.platform, po.items_json,
              GROUP_CONCAT(DISTINCT oi.sku) AS skus,
              MAX(COALESCE(po.pay_at, po.gmt_create)) AS latest
       FROM op_purchase_order po
       JOIN op_purchase_link pl ON pl.purchase_order_id = po.id
       JOIN op_ozon_order_item oi ON oi.id = pl.ozon_order_item_id
       WHERE po.platform IN ('1688', 'yangkeduo')
         AND po.items_json IS NOT NULL AND po.items_json LIKE '%goodsId%'
       GROUP BY po.id
       ORDER BY latest DESC, po.id DESC`
    )
    .all();
  const all = collectHistoryCandidates();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const o of orders) {
    const goods = parseJsonArray(o.items_json);
    const skus = String(o.skus || '').split(',').filter(Boolean);
    if (goods.length !== 1 || skus.length !== 1) { skipped += 1; continue; }
    const g = goods[0];
    const gid = String(g.goodsId || '').trim();
    if (!gid) { skipped += 1; continue; }
    const sid = String(g.skuId || '').trim();
    const cand = all.get(sourceIdentityKey({
      sku: String(skus[0]).trim(), platform: o.platform, gid, sid, spec: g.spec,
    }));
    if (!cand) { skipped += 1; continue; }
    try {
      const r = upsertSource(cand);
      if (r.created) created += 1;
      else updated += 1;
    } catch {
      skipped += 1;
    }
  }
  return { scanned: orders.length, created, updated, skipped };
}

/**
 * 采购单自动积累(采购保存/补全后调用)
 * 仅处理:1688/拼多多 + 单商品行 + 关联包裹只有 1 个 SKU 的无歧义场景。
 * @returns {{updated?:boolean, skipped?:string}}
 */
export function accumulateFromPurchaseOrder(purchaseOrderId) {
  const po = db
    .prepare(
      `SELECT id, platform, purchase_sn, items_json FROM op_purchase_order WHERE id = ?`
    )
    .get(Number(purchaseOrderId));
  if (!po) return { skipped: 'not_found' };
  if (!SUPPORTED_SOURCE_PLATFORMS.has(po.platform)) return { skipped: 'platform' };
  const goods = parseJsonArray(po.items_json);
  if (goods.length !== 1) return { skipped: 'multi_goods' };
  const gid = String(goods[0].goodsId || '').trim();
  if (!gid) return { skipped: 'no_goods_id' };
  const skus = db
    .prepare(
      `SELECT DISTINCT oi.sku, oi.offer_id, p.store_id
       FROM op_purchase_link pl
       JOIN op_ozon_order_item oi ON oi.id = pl.ozon_order_item_id
       LEFT JOIN op_package p ON p.id = pl.package_id
       WHERE pl.purchase_order_id = ?`
    )
    .all(Number(purchaseOrderId));
  const distinctSkus = [...new Set(skus.map((s) => s.sku).filter((v) => v != null))];
  if (distinctSkus.length !== 1) return { skipped: 'multi_sku' };
  const cand = collectHistoryCandidates({ sku: distinctSkus[0] });
  const sid = String(goods[0].skuId || '').trim();
  const c = cand.get(sourceIdentityKey({
    sku: distinctSkus[0], platform: po.platform, gid, sid, spec: goods[0].spec,
  }));
  if (!c) return { skipped: 'no_candidate' };
  try {
    const r = upsertSource(c);
    return { updated: true, id: r.id, created: r.created };
  } catch (e) {
    return { skipped: 'error', error: e?.message || String(e) };
  }
}

/** 按 (platform, purchaseSn) 定位采购单后自动积累(补全完成后调用) */
export function accumulateByPurchaseSn(platform, purchaseSn) {
  if (!purchaseSn) return { skipped: 'no_sn' };
  const po = db
    .prepare(`SELECT id FROM op_purchase_order WHERE platform = ? AND purchase_sn = ?`)
    .get(String(platform), String(purchaseSn));
  if (!po) return { skipped: 'not_found' };
  return accumulateFromPurchaseOrder(po.id);
}
