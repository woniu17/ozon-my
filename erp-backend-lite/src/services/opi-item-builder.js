// OPI item 构造统一入口
//
// 目的:消除 cache.js / prepare-bundle.js / config.js 三处重复实现
//   - 字典白名单查询(三处各自维护本地 Map,且没用上 ozon-opi.js 的全局 metaCache)
//   - transformItemForPortal + toOpiItem 调用链(三处重复)
//   - 11254 富内容注入(cache.js 内联 / prepare-bundle.js 的 injectRichContentFromCache)
//
// 对外导出 3 个函数:
//   - resolveAttrWhitelist: 字典白名单 + 字典本体(供前端展示属性名)
//   - injectRichContentAttr / batchInjectRichContentAttr: 11254 富内容注入
//   - buildOpiItem: 单 item 构造 portalItem + opiItem
//
// 注:数据源装配(ERP 缓存 vs 插件 message.items)仍由调用方各自维护,
//     本模块只负责"白名单查询 / 11254 注入 / OPI item 转换"三件共性事。
import logger from '../middleware/log.js';
import { transformItemForPortal, extractCategoryIds } from './prepare-bundle.js';
import { toOpiItem, descriptionCategoryAttributes } from './ozon-opi.js';

/**
 * 字典白名单 + 字典本体查询(供 transformItemForPortal 的 allowedAttrIds 过滤用)
 *
 * 内部直接调 ozon-opi.js 的 descriptionCategoryAttributes(已有 5min 全局 metaCache),
 * 同一 (storeId, descriptionCategoryId, typeId) 组合全局只查一次,替代三处本地 Map 缓存。
 *
 * @param {object|null} store - config/stores.json 单条;为 null 时直接返回 null(降级为不过滤)
 * @param {object} item - 用于 extractCategoryIds 提取 (typeId, descriptionCategoryId)
 * @param {object} [opts]
 * @param {boolean} [opts.returnAttrDict=false] - 是否同时返回 attrDict(供前端展示属性名)
 * @param {boolean} [opts.enableWhitelist=false] - 是否启用白名单过滤(默认关闭,仅 cache.js 的 storeId 入参时启用)
 * @returns {Promise<{allowedAttrIds: Set<string>|null, attrDict: object|null}>}
 *   - allowedAttrIds: Set<string>|null,null 表示不过滤
 *   - attrDict: { [id]: { id, name, description, type, dictionary_id } }|null
 */
export async function resolveAttrWhitelist(store, item, opts = {}) {
  const { returnAttrDict = false, enableWhitelist = false } = opts;
  if (!store) return { allowedAttrIds: null, attrDict: null };

  const { typeId, descriptionCategoryId } = extractCategoryIds(item);
  if (!typeId || !descriptionCategoryId) return { allowedAttrIds: null, attrDict: null };

  let attrs = null;
  try {
    attrs = await descriptionCategoryAttributes(store, {
      description_category_id: descriptionCategoryId,
      type_id: typeId,
    });
  } catch (e) {
    logger.warn(
      { err: e?.message, descriptionCategoryId, typeId },
      '属性字典查询失败,降级为不过滤'
    );
    return { allowedAttrIds: null, attrDict: null };
  }
  if (!Array.isArray(attrs) || attrs.length === 0) {
    return { allowedAttrIds: null, attrDict: null };
  }

  const allowedAttrIds = enableWhitelist ? new Set(attrs.map((a) => String(a.id))) : null;
  let attrDict = null;
  if (returnAttrDict) {
    attrDict = {};
    for (const a of attrs) {
      attrDict[String(a.id)] = {
        id: a.id,
        name: a.name || '',
        description: a.description || '',
        type: a.type || '',
        dictionary_id: a.dictionary_id || 0,
      };
    }
  }
  return { allowedAttrIds, attrDict };
}

/**
 * 单 item 注入 11254 富内容(已有 richContent 字符串时用)
 *
 * 通过 _forcedAttributes 通路进入 transformItemForPortal 的 5.2d 强制属性分支
 * (跳过字典白名单过滤,覆盖 bundle/sv 中已有的同 id 属性)。
 * 幂等:item._forcedAttributes 已有 11254 时不重复注入。
 *
 * @param {object} item - 待注入的 item(会原地修改 item._forcedAttributes)
 * @param {string} richContent - 富内容 JSON 字符串
 * @returns {boolean} 是否实际注入(true=注入成功,false=richContent 为空或已存在)
 */
export function injectRichContentAttr(item, richContent) {
  if (!item || !richContent) return false;
  if (item._forcedAttributes?.some((fa) => Number(fa.id) === 11254)) return false;
  if (!Array.isArray(item._forcedAttributes)) item._forcedAttributes = [];
  item._forcedAttributes.push({
    id: 11254,
    complex_id: 0,
    values: [{ value: richContent }],
  });
  return true;
}

/**
 * 批量从 ERP richMedia 缓存补 11254 富内容
 *
 * 适用场景:插件采集时 captureRichContent 未触发或失败,_sourceVariant.attributes
 * 缺 11254,但 ERP richMedia 缓存中已有 richContent。
 *
 * SKU 提取优先级:_sourceVariant._searchMeta.skus[0] > scraped_sku > offer_id 数字前缀
 *
 * @param {Array} items - 待处理的 item 数组(原地修改)
 * @param {object} daos - DAO 集合(至少含 richMediaDao.findManyBySkuList)
 * @returns {Promise<{injected: number, total: number}>} injected=实际注入数, total=待补全数
 */
export async function batchInjectRichContentAttr(items, daos) {
  const pending = [];
  for (const item of items) {
    // 已有 11254(sv.attributes 或 _forcedAttributes 任一存在)则跳过
    const hasInSv = item._sourceVariant?.attributes?.some(
      (a) => String(a.key || a.attribute_id || a.id) === '11254'
    );
    const hasInForced = item._forcedAttributes?.some((fa) => Number(fa.id) === 11254);
    if (hasInSv || hasInForced) continue;
    const sku =
      item._sourceVariant?._searchMeta?.skus?.[0] ||
      item.scraped_sku ||
      (item.offer_id ? String(item.offer_id).split('-')[0] : '');
    if (sku) pending.push({ item, sku: String(sku) });
  }
  if (pending.length === 0) return { injected: 0, total: 0 };

  const skus = [...new Set(pending.map((p) => p.sku))];
  let docs = [];
  try {
    docs = await daos.richMediaDao.findManyBySkuList(skus);
  } catch (e) {
    logger.warn({ err: e?.message }, '[opi-item-builder] richMedia 批量查询失败');
    return { injected: 0, total: pending.length };
  }

  const rcBySku = new Map();
  for (const doc of docs) {
    const rc = doc?.data?.richContent || '';
    if (rc) rcBySku.set(String(doc.sku || doc._id), rc);
  }
  if (rcBySku.size === 0) return { injected: 0, total: pending.length };

  let injected = 0;
  for (const { item, sku } of pending) {
    const rc = rcBySku.get(sku);
    if (!rc) continue;
    if (injectRichContentAttr(item, rc)) injected++;
  }
  if (injected > 0) {
    logger.info(
      { injected, total: pending.length },
      '[opi-item-builder] 从 ERP 缓存补 11254 富内容'
    );
  }
  return { injected, total: pending.length };
}

/**
 * 单 item 构造 OPI v3 schema(portalItem + opiItem)
 *
 * 封装 transformItemForPortal + toOpiItem 调用链,消除三处重复。
 *
 * @param {object} item - 已装配好的 item(含 _sourceVariant / _forcedAttributes / 等)
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.allowedAttrIds=null] - 字典白名单;null 表示不过滤
 * @returns {{portalItem: object, opiItem: object}}
 */
export function buildOpiItem(item, opts = {}) {
  const { allowedAttrIds = null } = opts;
  const portalItem = transformItemForPortal(item, { allowedAttrIds });
  const opiItem = toOpiItem(portalItem);
  return { portalItem, opiItem };
}
