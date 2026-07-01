// prepare-bundle-items 加工逻辑
// 对齐插件 service-worker.js:645-652 的 viaPortal 第 1 步
//
// 可插拔加工链(feature-flag 门控):
//   ai_rewrite → watermark → ai_poster → copy_ban_solution
// 严格模式 + 无效图片剔除:对齐 0.13 strictSkipped/invalidImage
import logger from '../middleware/log.js';
import config from '../config/index.js';
import { apply as applyAiRewrite } from './enrichments/ai-rewrite.js';
import { apply as applyWatermark } from './enrichments/watermark.js';
import { apply as applyPoster } from './enrichments/poster.js';
import { apply as applyCopyBan } from './enrichments/copy-ban.js';

/**
 * 严格模式校验:检查 item 是否有必要的物理参数
 * strict=true 时,缺少 weight/depth/width/height 的 item 被跳过
 * @param {Array} items
 * @param {boolean} strict
 * @returns {{ valid: Array, strictSkipped: Array }}
 */
function filterStrictMode(items, strict) {
  if (!strict) return { valid: items, strictSkipped: [] };
  const valid = [];
  const strictSkipped = [];
  for (const item of items) {
    const hasWeight = item.weight != null || item._sourceVariant?.attributes?.some((a) => String(a.key) === '4497');
    const hasDims =
      (item.depth != null && item.width != null && item.height != null) ||
      item._sourceVariant?.attributes?.some((a) => ['9454', '9455', '9456'].includes(String(a.key)));
    if (hasWeight && hasDims) {
      valid.push(item);
    } else {
      strictSkipped.push({ offer_id: item.offer_id, sku: item.scraped_sku, reason: '缺少物理参数(weight/depth/width/height)' });
    }
  }
  return { valid, strictSkipped };
}

/**
 * 无效图片剔除:检查 images 数组是否为空或 URL 格式错误
 * @param {Array} items
 * @returns {{ items: Array, invalidImage: Array }}
 */
function filterInvalidImages(items) {
  const invalidImage = [];
  const cleaned = [];
  for (const item of items) {
    const validImages = Array.isArray(item.images)
      ? item.images.filter((img) => img?.file_name && /^https?:\/\//i.test(img.file_name))
      : [];
    if (validImages.length === 0 && Array.isArray(item.images) && item.images.length > 0) {
      invalidImage.push({ offer_id: item.offer_id, sku: item.scraped_sku, reason: '图片 URL 无效或为空' });
    }
    item.images = validImages;
    cleaned.push(item);
  }
  return { items: cleaned, invalidImage };
}

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

  const flags = config.featureFlags || {};
  const strict = message.strict === true;

  // ── 1. 可选加工链(按 flag 顺序执行,关闭时透传) ──
  let processed = items;
  try {
    if (flags.ai_rewrite && message.applyAiRewrite !== false) {
      logger.info('加工链: AI 重写...');
      processed = await applyAiRewrite(processed, message);
    }
    if (flags.watermark && message.applyWatermark !== false) {
      logger.info('加工链: 水印...');
      processed = await applyWatermark(processed, message);
    }
    if (flags.ai_poster) {
      logger.info('加工链: AI 海报...');
      processed = await applyPoster(processed, message);
    }
    if (flags.copy_ban_solution) {
      logger.info('加工链: 防搬运...');
      processed = await applyCopyBan(processed, message);
    }
  } catch (e) {
    logger.error({ err: e?.message }, '加工链异常,降级为透传');
    processed = items;
  }

  // ── 2. 无效图片剔除 ──
  const imgResult = filterInvalidImages(processed);
  processed = imgResult.items;
  const invalidImage = imgResult.invalidImage;

  // ── 3. 严格模式校验 ──
  const { valid, strictSkipped } = filterStrictMode(processed, strict);

  // ── 4. 类目分组(按 description_category_lvl3_name) ──
  // ⚠️ seller.ozon.ru update-bundle-items 的 description_category_lvl3_name 是 string 字段,
  // 必须传类目名(如 "Водолазки"),不能传数字 ID(如 96091),否则 proto 校验报:
  //   invalid value for string field description_category_lvl3_name: 96091
  // 正确取值链:
  //   1) item.description_category_lvl3_name(上游显式传入)
  //   2) sv.description_category_lvl3_name(归一化时透传)
  //   3) sv.categories 中 level===3 的 name(sv.categories[].name/title)
  //   4) '默认类目'(兜底,seller 会用类目预测)
  const resolveCatLvl3Name = (item) => {
    if (item.description_category_lvl3_name) return item.description_category_lvl3_name;
    const sv = item._sourceVariant;
    if (!sv) return '默认类目';
    if (sv.description_category_lvl3_name) return sv.description_category_lvl3_name;
    const cats = Array.isArray(sv.categories) ? sv.categories : [];
    const lvl3 = cats.find((c) => Number(c.level) === 3 && (c.name || c.title));
    if (lvl3) return lvl3.name || lvl3.title;
    // 退化:取最深层级的类目名(避免传数字 ID)
    const deepest = cats
      .filter((c) => c.name || c.title)
      .sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];
    if (deepest) return deepest.name || deepest.title;
    return '默认类目';
  };

  const groups = new Map();
  for (const item of valid) {
    const catName = resolveCatLvl3Name(item);
    if (!groups.has(catName)) groups.set(catName, []);
    groups.get(catName).push(item);
  }

  // ── 5. 分组打包 + item 格式转换(面板格式 → seller.ozon.ru proto 格式) ──
  // seller.ozon.ru update-bundle-items 的 proto 要求:
  //   - images: repeated string(URL 数组),不是 [{file_name, default}] 对象数组
  //   - 不能带内部字段(_sourceVariant / _stock / _imageSource / scraped_* / bundleComplexAttrs 等)
  //   - attributes: seller 格式 {attribute_id, values:[{value}], complex_id}
  // 生产 ERP 后端做完整转换;erp-backend-lite 需在此对齐。
  const transformItemForPortal = (item) => {
    const sv = item._sourceVariant || null;

    // 5.1 images: [{file_name, default}] → ["url1", "url2", ...]
    const images = Array.isArray(item.images)
      ? item.images.map((img) => (typeof img === 'string' ? img : img?.file_name || '')).filter(Boolean)
      : [];

    // 5.2 attributes: sv 格式 {key, value/collection} → seller 格式 {attribute_id, values:[{value}], complex_id:"0"}
    const attributes = [];
    if (sv && Array.isArray(sv.attributes)) {
      for (const a of sv.attributes) {
        const key = String(a.key || a.attribute_id || '');
        if (!key) continue;
        const vals = Array.isArray(a.collection)
          ? a.collection.filter((v) => v != null && v !== '').map((v) => String(v))
          : a.value != null && a.value !== ''
            ? [String(a.value)]
            : [];
        if (vals.length === 0) continue;
        attributes.push({
          attribute_id: key,
          values: vals.map((v) => ({ value: v })),
          complex_id: '0',
        });
      }
    }

    // 5.3 complex_attributes(视频/PDF 等):bundleComplexAttrs 透传
    const complex_attributes = Array.isArray(item.bundleComplexAttrs) ? item.bundleComplexAttrs : [];

    // 5.4 type_id + description_category_id(门户 bundle 接口也期望这两个字段)
    //    - type_id: 从 sv.description_category_id(实际是 description_type_dict_value)取
    //    - description_category_id: 从 sv.categories[] 最深一级 id 取
    const typeId = Number(sv?.description_category_id) || 0;
    const cats = Array.isArray(sv?.categories) ? sv.categories : [];
    const deepestCat = cats
      .filter((c) => c.id)
      .sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];
    const descriptionCategoryId = Number(deepestCat?.id) || 0;

    // 5.5 构造 seller.ozon.ru 期望的 item(仅保留 proto 认识的字段)
    const portalItem = {
      offer_id: String(item.offer_id || ''),
      name: String(item.name || ''),
      price: String(item.price || '0'),
      old_price: String(item.old_price || item.price || '0'),
      vat: String(item.vat || '0'),
      currency_code: String(item.currency_code || 'RUB'),
      images,
      attributes,
      complex_attributes,
      // 必填分类字段
      type_id: typeId,
      description_category_id: descriptionCategoryId,
      // 必填物理参数(缺省 100 兜底,对齐 0.13 v3-payload.js:52-55)
      weight: Number(item.weight) > 0 ? Math.round(Number(item.weight)) : 100,
      weight_unit: item.weight_unit || 'g',
      depth: Number(item.depth) > 0 ? Math.round(Number(item.depth)) : 100,
      width: Number(item.width) > 0 ? Math.round(Number(item.width)) : 100,
      height: Number(item.height) > 0 ? Math.round(Number(item.height)) : 100,
      dimension_unit: item.dimension_unit || 'mm',
    };

    // barcode(从 sv._searchMeta.barcodes 或 item.barcode)
    const barcode = sv?._searchMeta?.barcodes?.[0] || item.barcode || '';
    if (barcode) portalItem.barcode = String(barcode);

    // 视频字段(如有)
    if (item.videoUrl) portalItem.video_url = String(item.videoUrl);
    if (item.videoCover) portalItem.video_cover = String(item.videoCover);

    return portalItem;
  };

  const bundles = [];
  for (const [catName, groupItems] of groups) {
    bundles.push({
      items: groupItems.map(transformItemForPortal),
      source: 'SOURCE_MERGED',
      description_category_lvl3_name: catName,
    });
  }

  logger.info(
    { storeId, inCount: items.length, validCount: valid.length, bundleCount: bundles.length, strictSkipped: strictSkipped.length, invalidImage: invalidImage.length, flags: Object.entries(flags).filter(([, v]) => v).map(([k]) => k) },
    'prepare-bundle-items done'
  );

  return {
    bundles,
    store_company_id: store.company_id, // ⚠️ 护栏关键字段
    strictSkipped,
    invalidImage,
  };
}
