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
 * transformItemForPortal: 把插件侧 item 格式转换为 OPI v3 portalItem 格式
 * 抽取为模块级导出函数,供 prepareBundleItems 和预览接口(preview-opi)复用
 *
 * 参考 /v3/product/import 官方 API schema(v3ImportProductsRequestItem):
 *   - attributes: [{id, values:[{value, dictionary_value_id}], complex_id}] (complex_id 是数字)
 *   - images: string[](URL 数组,不是 [{file_name, default}] 对象数组)
 *   - primary_image: string(主图 URL,单独于 images)
 *   - 不能带内部字段(_sourceVariant / _stock / _imageSource / scraped_* / bundleComplexAttrs 等)
 *
 * 数据源优先级:
 *   1) sv._bundleItem.attributes —— bundle 接口返回的完整后台数据,含 dictionary_value_id(最权威)
 *   2) sv.attributes —— /search 归一化数据,{key, value/collection} shape(可能缺 dictionary_value_id)
 */
export function transformItemForPortal(item) {
  const sv = item._sourceVariant || null;
  const bundleItem = sv?._bundleItem || null;

  // 5.1 images: [{file_name, default}] → ["url1", "url2", ...]
  // v3 schema: images 是 string[](URL 数组),primary_image 单独传
  // ⚠️ OPI v3 要求 primary_image 不能与 images 数组中的任一图片重复
  const rawImgObjs = Array.isArray(item.images) ? item.images : [];
  let primaryImg = '';
  const rawImages = [];
  for (const img of rawImgObjs) {
    const url = typeof img === 'string' ? img : img?.file_name || '';
    if (!url) continue;
    if (!primaryImg && img && typeof img === 'object' && img.default === true) {
      primaryImg = url;
    } else {
      rawImages.push(url);
    }
  }
  const images = rawImages;

  // 5.2 attributes: 优先从 bundleItem 提取 v3 标准格式(含 dictionary_value_id)
  const SKIP_ATTR_IDS = new Set([4194, 4195, 4497, 9454, 9455, 9456]);
  const attributes = [];
  const usedKeys = new Set();

  if (bundleItem && Array.isArray(bundleItem.attributes)) {
    for (const ba of bundleItem.attributes) {
      if (ba.complex_id && Number(ba.complex_id) !== 0) continue;
      const attrId = Number(ba.attribute_id || ba.id || 0);
      if (!attrId) continue;
      if (SKIP_ATTR_IDS.has(attrId)) continue;
      const key = String(attrId);
      if (usedKeys.has(key)) continue;
      const vals = Array.isArray(ba.values)
        ? ba.values.filter(
            (v) =>
              v &&
              ((v.value != null && v.value !== '') ||
                (v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0))
          )
        : [];
      if (vals.length === 0) continue;
      attributes.push({
        complex_id: 0,
        id: attrId,
        values: vals.map((v) => ({
          value: String(v.value ?? ''),
          ...(v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0
            ? { dictionary_value_id: Number(v.dictionary_value_id) }
            : {}),
        })),
      });
      usedKeys.add(key);
    }
  }

  // 5.2b 兜底:从 sv.attributes 转换
  if (sv && Array.isArray(sv.attributes)) {
    for (const a of sv.attributes) {
      const key = String(a.key || a.attribute_id || '');
      if (!key || usedKeys.has(key)) continue;
      if (SKIP_ATTR_IDS.has(Number(key))) continue;
      const rawVals = Array.isArray(a.collection)
        ? a.collection.filter((v) => v != null && v !== '')
        : a.value != null && a.value !== ''
          ? [a.value]
          : [];
      if (rawVals.length === 0) continue;
      const attrId = Number(key) || 0;
      if (!attrId) continue;
      attributes.push({
        complex_id: 0,
        id: attrId,
        values: rawVals.map((v) => {
          const val = typeof v === 'object' ? v : { value: String(v) };
          return {
            value: String(val.value != null ? val.value : v),
            ...(val.dictionary_value_id != null && Number(val.dictionary_value_id) > 0
              ? { dictionary_value_id: Number(val.dictionary_value_id) }
              : {}),
          };
        }),
      });
      usedKeys.add(key);
    }
  }

  // 5.2c 描述(4191)注入
  const descText = String(item.scraped_description || item.description || '').trim();
  if (descText && !usedKeys.has('4191')) {
    attributes.push({ complex_id: 0, id: 4191, values: [{ value: descText }] });
    usedKeys.add('4191');
  }

  // 5.3 complex_attributes(视频/PDF 等):bundleComplexAttrs 透传
  // 兼容两种输入形状:
  //   - 扁平: {attribute_id, complex_id, values}(来自 sv._bundleComplexAttrs,实际数据)
  //   - 容器: {attributes: [{attribute_id, complex_id, values}]}(旧假设,保留兼容)
  // 同一 complex_id 的多个属性属于同一组(如一个视频 = URL+时长+封面),按 complex_id 分组合并
  const complex_attributes = [];
  if (Array.isArray(item.bundleComplexAttrs)) {
    const toInnerAttr = (ba) => {
      const attrId = Number(ba.attribute_id || ba.id || 0);
      if (!attrId) return null;
      const vals = Array.isArray(ba.values)
        ? ba.values.filter(
            (v) =>
              v &&
              ((v.value != null && v.value !== '') ||
                (v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0))
          )
        : [];
      if (vals.length === 0) return null;
      return {
        complex_id: Number(ba.complex_id) || 0,
        id: attrId,
        values: vals.map((v) => ({
          value: String(v.value ?? ''),
          ...(v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0
            ? { dictionary_value_id: Number(v.dictionary_value_id) }
            : {}),
        })),
      };
    };
    // 归一化为单属性列表,再按 complex_id 分组
    const groups = new Map();
    for (const ca of item.bundleComplexAttrs) {
      if (!ca) continue;
      const list = Array.isArray(ca.attributes) ? ca.attributes : [ca];
      for (const ba of list) {
        const cid = Number(ba?.complex_id) || 0;
        if (!groups.has(cid)) groups.set(cid, []);
        groups.get(cid).push(ba);
      }
    }
    for (const bas of groups.values()) {
      const innerAttrs = bas.map(toInnerAttr).filter(Boolean);
      if (innerAttrs.length > 0) {
        complex_attributes.push({ attributes: innerAttrs });
      }
    }
  }

  // 5.4 type_id + description_category_id
  const cats = Array.isArray(sv?.categories) ? sv.categories : [];
  const deepestCat = cats.filter((c) => c.id).sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];
  const typeId = Number(bundleItem?.type_id) || Number(sv?.description_category_id) || 0;
  const descriptionCategoryId =
    Number(bundleItem?.description_category_id) ||
    Number(bundleItem?.category?.description_category_id) ||
    Number(bundleItem?.description_category?.id) ||
    Number(sv?.search_description_category_id) ||
    Number(deepestCat?.id) ||
    0;

  // 5.5 构造 portalItem(OPI v3 schema)
  const portalItem = {
    offer_id: String(item.offer_id || ''),
    name: String(item.name || ''),
    price: String(item.price || '0'),
    vat: String(item.vat || '0'),
    images,
    attributes,
    weight: Number(item.weight) > 0 ? Math.round(Number(item.weight)) : 100,
    weight_unit: item.weight_unit || 'g',
    depth: Number(item.depth) > 0 ? Math.round(Number(item.depth)) : 100,
    width: Number(item.width) > 0 ? Math.round(Number(item.width)) : 100,
    height: Number(item.height) > 0 ? Math.round(Number(item.height)) : 100,
    dimension_unit: item.dimension_unit || 'mm',
    old_price: String(item.old_price || item.price || '0'),
    currency_code: String(item.currency_code || 'RUB'),
    complex_attributes,
    primary_image: primaryImg || '',
    color_image: '',
    images360: [],
    pdf_list: [],
    new_description_category_id: 0,
  };
  if (typeId > 0) portalItem.type_id = typeId;
  if (descriptionCategoryId > 0) portalItem.description_category_id = descriptionCategoryId;
  const barcode = sv?._searchMeta?.barcodes?.[0] || item.barcode || '';
  if (barcode) portalItem.barcode = String(barcode);
  if (item.videoUrl) portalItem.video_url = String(item.videoUrl);
  if (item.videoCover) portalItem.video_cover = String(item.videoCover);
  return portalItem;
}

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
      strictSkipped.push({
        offer_id: item.offer_id,
        sku: item.scraped_sku,
        reason: '缺少物理参数(weight/depth/width/height)',
      });
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
  // ⚠️ seller.ozon.ru create-bundle 的 description_category_lvl3_name 是 string 字段,
  // 必须传**叶子类目名**(descriptionCategoryName,如 "Набор для подвижных игр" = 户外游戏套装),
  // 不能传类型名(如 "Дартс детский"),不能传数字 ID,也不能传"默认类目"
  // (Ozon 无法按名匹配 → 报错"您没有指定类型。属性是必填项")。
  //
  // 正确取值链(按可靠性排序):
  //   1) item.description_category_lvl3_name(上游显式传入)
  //   2) sv.description_category_lvl3_name(qx-ozon searchVariants 已通过 seller-tree
  //      反查 bundleItem.description_category_id → descriptionCategoryName,权威来源)
  //   3) sv.categories 里 level=3 的 name(/search 通常不返 name,留作兜底)
  //   4) '默认类目'(兜底,但会触发 Ozon 报错,仅作最后手段)
  //
  // ❌ 不再用 attribute 8229 的 value —— 那是 descriptionTypeName(类型名,如"Дартс детский"),
  //   不是叶子类目名。同一叶子类目(如"Набор для подвижных игр")下可有多个 type
  //   (Вертушка/Дартс детский/Нейроскакалка/...),传类型名会导致 Ozon 报
  //   "Вы не указали тип. Атрибут является обязательным для заполнения"
  const resolveCatLvl3Name = (item) => {
    if (item.description_category_lvl3_name) return item.description_category_lvl3_name;
    const sv = item._sourceVariant;
    if (!sv) return '默认类目';
    // qx-ozon searchVariants 注入的叶子类目名(权威来源 —— 来自 seller-tree 反查)
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
  // transformItemForPortal 已抽取为模块级导出函数(见文件顶部),此处直接调用

  const bundles = [];
  for (const [catName, groupItems] of groups) {
    const transformedItems = groupItems.map(transformItemForPortal);
    // DEBUG: 记录每个 bundle 的类目名和首个 item 的分类字段,排查按名匹配是否生效
    logger.info(
      {
        catName,
        itemCount: transformedItems.length,
        firstOfferId: transformedItems[0]?.offer_id,
        firstItemHasTypeId: transformedItems[0]?.type_id != null,
        firstItemHasDescCatId: transformedItems[0]?.description_category_id != null,
        firstItemTypeId: transformedItems[0]?.type_id,
        firstItemDescCatId: transformedItems[0]?.description_category_id,
      },
      'prepare-bundle: bundle 分组(类目名将用于 Ozon 按名匹配)'
    );
    bundles.push({
      items: transformedItems,
      source: 'SOURCE_MERGED',
      description_category_lvl3_name: catName,
    });
  }

  logger.info(
    {
      storeId,
      inCount: items.length,
      validCount: valid.length,
      bundleCount: bundles.length,
      strictSkipped: strictSkipped.length,
      invalidImage: invalidImage.length,
      flags: Object.entries(flags)
        .filter(([, v]) => v)
        .map(([k]) => k),
    },
    'prepare-bundle-items done'
  );

  return {
    bundles,
    store_company_id: store.company_id, // ⚠️ 护栏关键字段
    strictSkipped,
    invalidImage,
  };
}
