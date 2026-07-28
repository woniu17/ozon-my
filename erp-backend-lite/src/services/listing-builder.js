// 上架核心逻辑(抽离自 Preview.vue onSubmit + products.js POST /import)
// 供 POST /ozon/products/import 和 batch-upload-poller 复用
//
// 依赖链(单向,无循环):
//   products.js → listing-builder.js → cache.js(buildSynthesizedFromCache) → daos
//   products.js re-export upsertTaskItems(从本模块),保持现有 import 路径不变
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { prepareBundleItems } from './prepare-bundle.js';
import * as opi from './ozon-opi.js';
import { indexDao } from '../db/dao/sqlite/index-dao.js';
import { buildSynthesizedFromCache } from '../modules/cache.js';
import config from '../config/index.js';
import logger from '../middleware/log.js';

// ── 常量(对齐 Preview.vue) ──────────────────────────────────
const BRAND_ATTR_ID = 85;
const NO_BRAND_VALUE = 'Нет бренда';
const NO_BRAND_DICTIONARY_VALUE_ID = 126745801;
const SELLER_CODE_ATTR_ID = 9024;
const MODEL_NAME_ATTR_ID = 9048;
const LISTING_VAT = '0';

// ── 内部工具:写入/更新上架记录明细 ───────────────────────
// 从 products.js 移入,保持原有导出签名(products.js re-export)
// storeId:用于即时标记 listed(跟卖到的目标店铺),空值则不标记
export function upsertTaskItems(localTaskId, items, storeId) {
  if (!Array.isArray(items) || items.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO follow_sell_task_items (local_task_id, offer_id, name, price, product_id, status, errors, has_error, has_warning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_task_id, offer_id) DO UPDATE SET
      product_id = excluded.product_id,
      status = excluded.status,
      errors = excluded.errors,
      has_error = excluded.has_error,
      has_warning = excluded.has_warning,
      updated_at = datetime('now')
  `);
  for (const it of items) {
    const offerId = String(it.offer_id || '');
    if (!offerId) continue;
    const errs = Array.isArray(it.errors) ? it.errors : [];
    const hasError = errs.some((e) => String(e.level || '').toLowerCase() === 'error') ? 1 : 0;
    const hasWarning = errs.some((e) => String(e.level || '').toLowerCase() === 'warning') ? 1 : 0;
    stmt.run(
      localTaskId,
      offerId,
      it.name || null,
      it.price || null,
      it.product_id ? String(it.product_id) : null,
      it.status || 'pending',
      errs.length > 0 ? JSON.stringify(errs) : null,
      hasError,
      hasWarning
    );
  }
  // 即时标记 listed(同步,SQLite 同步 API 毫秒级)
  // offer_id 格式:sku-variantId,取第一段作为 SKU 前缀
  const skuSet = new Set();
  for (const it of items) {
    const offerId = String(it.offer_id || '');
    if (!offerId || !offerId.includes('-')) continue;
    const sku = offerId.split('-')[0];
    if (sku) skuSet.add(sku);
  }
  if (skuSet.size > 0 && storeId) {
    try {
      indexDao.markListed([...skuSet], storeId, localTaskId);
    } catch (e) {
      logger.warn({ localTaskId, storeId, err: e.message }, 'markListed failed');
    }
  }
}

// 按 items 状态汇总任务状态(从 products.js 移入)
// 状态机:
//   有 pending/skipped           → PROCESSING
//   全部 failed(或 imported+has_error) → FAILED
//   全部 imported 无 has_error:
//     有 has_warning              → WARNING(新增,2026-07:OPI 响应含 level=warning)
//     无 has_warning              → SUCCESS
//   有 failed 也有 imported(无 has_error) → SUCCESS(部分成功,与 WARNING 互斥)
export function summarizeTaskStatus(localTaskId) {
  const rows = db
    .prepare(`SELECT status, has_error, has_warning FROM follow_sell_task_items WHERE local_task_id=?`)
    .all(localTaskId);
  if (rows.length === 0) return null;
  const imported = rows.filter((r) => r.status === 'imported' && !r.has_error).length;
  const failed = rows.filter((r) => r.status === 'failed' || (r.status === 'imported' && r.has_error)).length;
  const pending = rows.filter((r) => r.status === 'pending' || r.status === 'skipped').length;
  const warning = rows.filter((r) => r.status === 'imported' && !r.has_error && r.has_warning).length;
  let status;
  if (pending > 0) status = 'PROCESSING';
  else if (imported === 0 && failed > 0) status = 'FAILED';
  else if (failed > 0) status = 'SUCCESS'; // 部分成功
  else if (warning > 0) status = 'WARNING'; // 全部成功但有警告
  else status = 'SUCCESS';
  db.prepare(
    `UPDATE follow_sell_tasks SET status=?, completed_at=datetime('now') WHERE local_task_id=? AND status NOT IN ('SUCCESS','FAILED','WARNING')`
  ).run(status, localTaskId);
  return { status, imported, failed, pending, warning, total: rows.length };
}

// 保存 OPI 查询响应(从 products.js 移入)
export function saveOpiResponse(localTaskId, storeId, response) {
  if (!localTaskId) return;
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM follow_sell_task_payloads WHERE local_task_id=? AND stage='opi_response'`).run(localTaskId);
    db.prepare(
      `INSERT INTO follow_sell_task_payloads (local_task_id, store_id, stage, payload) VALUES (?, ?, 'opi_response', ?)`
    ).run(localTaskId, storeId || null, JSON.stringify(response ?? null));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    logger.warn({ localTaskId, err: e.message }, 'saveOpiResponse failed');
  }
}

// ── 价格策略:从上架模板计算售价/划线价/最低价 ───────────────
// 对齐 Preview.vue salePrice/oldPrice/minPrice computed 公式:
//   售价   = originalPrice × salePriceA% + salePriceB
//   划线价 = 售价 × oldPriceA%
//   最低价 = 售价 − minPriceB
// 任一参数缺失则对应字段返回 null(不覆盖)
// originalPrice 取缓存合成的 item.price(即 detailData.price || cardData.price)
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function computePricesFromTemplate(originalPrice, tplCfg) {
  const orig = Number(originalPrice);
  if (!isFinite(orig) || orig <= 0) return { salePrice: null, oldPrice: null, minPrice: null };
  const sa = Number(tplCfg?.salePriceA);
  const sb = Number(tplCfg?.salePriceB);
  const oa = Number(tplCfg?.oldPriceA);
  const mb = Number(tplCfg?.minPriceB);
  let salePrice = null;
  let oldPrice = null;
  let minPrice = null;
  if (isFinite(sa) && isFinite(sb)) {
    salePrice = round2(orig * (sa / 100) + sb);
    if (isFinite(oa)) oldPrice = round2(salePrice * (oa / 100));
    if (isFinite(mb)) minPrice = round2(salePrice - mb);
  }
  return { salePrice, oldPrice, minPrice };
}

// 按 templateId 读取 listing_templates.config_json(内存缓存,避免每次上架都查库)
const _templateConfigCache = new Map();
function getTemplateConfig(templateId) {
  const id = Number(templateId);
  if (!id) return null;
  if (_templateConfigCache.has(id)) return _templateConfigCache.get(id);
  let cfg = null;
  try {
    const row = db.prepare(`SELECT config_json FROM listing_templates WHERE id=?`).get(id);
    cfg = row?.config_json ? JSON.parse(row.config_json) : null;
  } catch (e) {
    logger.warn({ templateId: id, err: e.message }, 'getTemplateConfig 读取失败');
  }
  _templateConfigCache.set(id, cfg);
  return cfg;
}

// 模板被修改/删除时调用,清空对应缓存(传 null/undefined 清空全部)
export function invalidateTemplateConfigCache(templateId) {
  if (templateId == null) {
    _templateConfigCache.clear();
    return;
  }
  _templateConfigCache.delete(Number(templateId));
}

// ── 从 SKU 构建上架 message ─────────────────────────────────
// 对齐 Preview.vue onSubmit 的改造逻辑:
//   1. 从缓存组装完整 item(buildSynthesizedFromCache)
//   2. 覆盖 price/old_price/min_price
//      - options 显式传入优先(预览页用户手填值)
//      - 否则按 templateId 读取模板配置自动算价(对齐 Preview.vue computed)
//   3. 注入 OPI 强制字段:offer_id(格式 {SKU}-{mmdd}-qx)、currency_code、vat
//   4. 强制注入 _forcedAttributes:品牌(85)=无品牌、卖家代码(9024)=Offer ID、型号名称(9048)=时间戳36进制
//
// 返回可直接传给 executeListing 的 message: { items, defaultStock, templateId }
// 抛错场景:店铺不存在 / SKU 缓存数据不足
export async function buildListingMessage(sku, storeId, options = {}) {
  const {
    defaultStock = 0,
    templateId = null,
    salePrice = null,
    oldPrice = null,
    minPrice = null,
    videoMode = 'skip',
  } = options;

  const store = config.loadStores().find((s) => s.id === storeId);
  if (!store) throw new Error(`店铺不存在: ${storeId}`);

  // 从缓存组装完整 item(含 _sourceVariant/_bundleItem/_forcedAttributes 11254)
  const synth = await buildSynthesizedFromCache(sku, storeId);
  if (!synth || !synth.item) throw new Error(`SKU ${sku} 缓存数据不足,无法组装上架 item`);
  // 深拷贝避免污染缓存合成结果
  const item = JSON.parse(JSON.stringify(synth.item));

  // 覆盖价格:
  //   - 显式传入优先(预览页用户手填值,批量均衡上架不传则走模板自动算价)
  //   - 缺失字段按 templateId 模板公式补齐(对齐 Preview.vue computed)
  let finalSalePrice = salePrice;
  let finalOldPrice = oldPrice;
  let finalMinPrice = minPrice;
  if (
    templateId &&
    (finalSalePrice == null || finalOldPrice == null || finalMinPrice == null)
  ) {
    const tplCfg = getTemplateConfig(templateId);
    if (tplCfg) {
      const computed = computePricesFromTemplate(item.price, tplCfg);
      if (finalSalePrice == null && computed.salePrice != null) finalSalePrice = computed.salePrice;
      if (finalOldPrice == null && computed.oldPrice != null) finalOldPrice = computed.oldPrice;
      if (finalMinPrice == null && computed.minPrice != null) finalMinPrice = computed.minPrice;
    }
  }
  if (finalSalePrice != null) item.price = String(finalSalePrice);
  if (finalOldPrice != null) item.old_price = String(finalOldPrice);
  if (finalMinPrice != null) item.min_price = String(finalMinPrice);

  // 图片顺序策略(对齐 Preview.vue reshuffle):
  //   - shuffle_non_primary: 主图(default:true)位置不变,其余图片 Fisher-Yates 随机打乱
  //   - keep / 其它: 保持原序
  // 显式 options.imageOrder 优先;否则按 templateId 读模板配置
  const imageOrder =
    options.imageOrder || (templateId ? getTemplateConfig(templateId)?.imageOrder : null) || 'keep';
  if (imageOrder === 'shuffle_non_primary' && Array.isArray(item.images) && item.images.length > 2) {
    const primaryIdx = item.images.findIndex((im) => im && im.default);
    if (primaryIdx >= 0) {
      const primary = item.images[primaryIdx];
      const rest = item.images.filter((_, i) => i !== primaryIdx);
      // Fisher-Yates 洗牌(每次上架独立随机,对齐 Preview.vue reshuffle 用 Math.random)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      item.images = [primary, ...rest];
    }
  }

  // OPI 强制字段:offer_id(格式 {SKU}-{mmdd}-qx)、currency_code、vat
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const offerId = `${sku}-${mmdd}-qx`;
  item.offer_id = offerId;
  item.currency_code = store.currency_code || '';
  item.vat = LISTING_VAT;
  if (videoMode === 'skip') item.videoUrl = '';

  // 强制注入:品牌(85)=无品牌、卖家代码(9024)=Offer ID、型号名称(9048)=毫秒级 Epoch 转 36 进制大写
  // 品牌 dictionary_value_id=126745801 是 Ozon 全局"无品牌"占位
  // 后端 transformItemForPortal 会按 _forcedAttributes 的 id 强制覆盖到最终 attributes 数组
  const modelName = Date.now().toString(36).toUpperCase();
  const forcedAttrValues = [
    { id: BRAND_ATTR_ID, value: NO_BRAND_VALUE, dictionaryValueId: NO_BRAND_DICTIONARY_VALUE_ID },
    { id: SELLER_CODE_ATTR_ID, value: offerId, dictionaryValueId: 0 },
    { id: MODEL_NAME_ATTR_ID, value: modelName, dictionaryValueId: 0 },
  ];
  item._forcedAttributes = forcedAttrValues.map((fe) => ({
    complex_id: 0,
    id: fe.id,
    values: [{ dictionary_value_id: fe.dictionaryValueId, value: fe.value }],
  }));
  // item.attributes 也同步覆盖(对齐前端,用于 raw payload 备份展示)
  if (Array.isArray(item.attributes)) {
    for (const fe of forcedAttrValues) {
      const idx = item.attributes.findIndex((a) => Number(a.id) === fe.id);
      const entry = { complex_id: 0, id: fe.id, values: [{ dictionary_value_id: fe.dictionaryValueId, value: fe.value }] };
      if (idx >= 0) item.attributes[idx] = entry;
      else item.attributes.push(entry);
    }
  }

  // 水印字段注入(供 prepareBundleItems 加工链读取)
  // 优先 options 显式传入,否则按 templateId 读模板配置
  let applyWatermark = options.applyWatermark ?? null;
  let watermarkTemplateId = options.watermarkTemplateId ?? null;
  if (templateId && (applyWatermark === null || watermarkTemplateId === null)) {
    const tplCfg = getTemplateConfig(templateId);
    if (tplCfg) {
      if (applyWatermark === null) applyWatermark = tplCfg.applyWatermark === true;
      if (watermarkTemplateId === null) watermarkTemplateId = tplCfg.watermarkTemplateId ?? null;
    }
  }

  return {
    message: {
      items: [item],
      defaultStock,
      templateId,
      applyWatermark: applyWatermark === true,
      watermarkTemplateId: watermarkTemplateId ?? null,
    },
    offerId,
  };
}

// ── 执行上架(复用 POST /import 核心逻辑) ──────────────────
// message: { items, defaultStock, templateId } — 与 POST /import 的 req.body 同构
// storeId: 目标店铺 ID
// store: 店铺对象(可选,空则从 loadStores 查找)
// 返回: { localTaskId, ozonTaskId, error }
//   - error 非 null 表示失败(已更新 follow_sell_tasks 为 FAILED + items 为 failed)
//   - error 为 null 表示 OPI 调用成功,任务进入 PROCESSING 等待 import-status-poller 收尾
export async function executeListing(message, storeId, store) {
  const items = Array.isArray(message.items) ? message.items : [];
  const localTaskId = `local-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stockSnapshot = Math.max(0, Math.min(100000, Number(message.defaultStock) || 0));
  const templateId = Number(message.templateId) || null;
  const storeObj = store || config.loadStores().find((s) => s.id === storeId);
  if (!storeObj) throw new Error(`店铺不存在: ${storeId}`);

  // 备份插件原始请求体(raw),便于排查
  try {
    db.prepare(
      `INSERT INTO follow_sell_task_payloads (local_task_id, store_id, stage, payload) VALUES (?, ?, 'raw', ?)`
    ).run(localTaskId, storeId, JSON.stringify(items));
  } catch (e) {
    logger.warn({ localTaskId, err: e.message }, 'backup raw payload failed');
  }

  // 入库 PENDING(含库存快照,供 stock-sync.js 定时任务读取)
  db.prepare(
    `INSERT INTO follow_sell_tasks
      (local_task_id, via_portal, store_id, status, items_count, items_preview, stock_snapshot, template_id)
     VALUES (?, 0, ?, 'PENDING', ?, ?, ?, ?)`
  ).run(localTaskId, storeId, items.length, JSON.stringify(items.slice(0, 5)), stockSnapshot, templateId);

  // 写入上架记录明细(pending 状态,待 import-info 查询后更新)+ 即时 markListed
  upsertTaskItems(
    localTaskId,
    items.map((it) => ({ offer_id: it.offer_id, name: it.name, price: it.price, status: 'pending' })),
    storeId
  );

  // 水印字段注入(与 buildListingMessage 对齐):
  // 若 message 未显式传入 applyWatermark / watermarkTemplateId,则按 templateId 读模板配置补齐
  // 确保 Preview.vue → /ozon/products/import → executeListing 路径下水印加工链能正常触发
  const tplId = Number(message.templateId) || 0;
  if (tplId && (message.applyWatermark === undefined || message.watermarkTemplateId === undefined)) {
    const tplCfg = getTemplateConfig(tplId);
    if (tplCfg) {
      if (message.applyWatermark === undefined) message.applyWatermark = tplCfg.applyWatermark === true;
      if (message.watermarkTemplateId === undefined) message.watermarkTemplateId = tplCfg.watermarkTemplateId ?? null;
    }
  }
  // 兜底:确保两个字段有默认值,避免 prepare-bundle.js 门控判定 undefined
  if (message.applyWatermark === undefined) message.applyWatermark = false;
  if (message.watermarkTemplateId === undefined) message.watermarkTemplateId = null;

  // 调 prepareBundleItems 做完整转换(含 dictionary_value_id、complex_attributes、描述 4191 注入等)
  try {
    const bundleResult = await prepareBundleItems(message, storeId, storeObj);
    const transformedItems = (bundleResult.bundles || []).flatMap((b) => b.items || []);
    if (transformedItems.length === 0) {
      throw new Error('prepareBundleItems 转换后无有效 items(可能全部被严格模式/无效图片过滤)');
    }
    // 备份转换后的请求体(transformed)
    try {
      db.prepare(
        `INSERT INTO follow_sell_task_payloads (local_task_id, store_id, stage, payload) VALUES (?, ?, 'transformed', ?)`
      ).run(localTaskId, storeId, JSON.stringify(transformedItems));
    } catch (e) {
      logger.warn({ localTaskId, err: e.message }, 'backup transformed payload failed');
    }
    // 备份最终发给 OPI 的请求体(opi_request)
    try {
      const opiRequestPayload = { items: transformedItems.map(opi.toOpiItem) };
      db.prepare(
        `INSERT INTO follow_sell_task_payloads (local_task_id, store_id, stage, payload) VALUES (?, ?, 'opi_request', ?)`
      ).run(localTaskId, storeId, JSON.stringify(opiRequestPayload));
    } catch (e) {
      logger.warn({ localTaskId, err: e.message }, 'backup opi_request payload failed');
    }
    const r = await opi.productImport(storeObj, transformedItems);
    const ozonTaskId = r?.result?.task_id ? String(r.result.task_id) : null;
    db.prepare(`UPDATE follow_sell_tasks SET status='PROCESSING', ozon_task_id=? WHERE local_task_id=?`).run(
      ozonTaskId,
      localTaskId
    );
    return { localTaskId, ozonTaskId, error: null };
  } catch (e) {
    const errorMessage = e.message;
    db.prepare(
      `UPDATE follow_sell_tasks SET status='FAILED', error_message=?, completed_at=datetime('now') WHERE local_task_id=?`
    ).run(errorMessage, localTaskId);
    upsertTaskItems(
      localTaskId,
      items.map((it) => ({
        offer_id: it.offer_id,
        name: it.name,
        price: it.price,
        status: 'failed',
        errors: [{ code: 'IMPORT_ERROR', message: errorMessage }],
      })),
      storeId
    );
    logger.warn({ localTaskId, err: errorMessage }, 'executeListing failed');
    return { localTaskId, ozonTaskId: null, error: errorMessage };
  }
}
