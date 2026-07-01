// prepare-bundle-items 加工逻辑
// 对齐插件 service-worker.js:645-652 的 viaPortal 第 1 步
//
// 个人版:透传加工(不做 AI 重写/水印/防搬运)
// 返回 bundles + store_company_id 供插件做公司一致性护栏
import logger from '../middleware/log.js';

/**
 * @param {object} message - 同插件 followSell 消息体
 * @param {string} storeId
 * @param {object} store - config/stores.json 单条
 */
export async function prepareBundleItems(message, storeId, store) {
  const items = Array.isArray(message?.items) ? message.items : [];
  if (items.length === 0) {
    return {
      bundles: [],
      store_company_id: store.company_id,
      strictSkipped: [],
      invalidImage: [],
      message: '无可上架商品',
    };
  }

  // 1. 类目分组(简化:按 description_category_lvl3_name 或 description_category_id 分组)
  const groups = new Map();
  for (const item of items) {
    const catName =
      item.description_category_lvl3_name ||
      item._sourceVariant?.description_category_id ||
      item._sourceVariant?.description_category_lvl3_name ||
      '默认类目';
    if (!groups.has(catName)) groups.set(catName, []);
    groups.get(catName).push(item);
  }

  // 2. 加工(个人版:透传源变体属性 4497/9454-9456/7822/11254/4191/23171)
  //    严格模式 + 无效图片:个人版不校验,返回空数组
  const bundles = [];
  for (const [catName, groupItems] of groups) {
    bundles.push({
      items: groupItems.map((item) => ({
        ...item,
        _sourceVariant: item._sourceVariant || null,
      })),
      source: 'SOURCE_MERGED',
      description_category_lvl3_name: catName,
    });
  }

  logger.info(
    { storeId, inCount: items.length, bundleCount: bundles.length },
    'prepare-bundle-items done(透传)'
  );

  return {
    bundles,
    store_company_id: store.company_id, // ⚠️ 护栏关键字段
    strictSkipped: [],
    invalidImage: [],
  };
}
