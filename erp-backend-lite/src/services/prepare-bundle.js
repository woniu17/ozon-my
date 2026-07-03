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
  // 参考 /v3/product/import 官方 API schema(v3ImportProductsRequestItem):
  //   - attributes: [{id, values:[{value, dictionary_value_id}], complex_id}] (complex_id 是数字)
  //   - images: string[](URL 数组,不是 [{file_name, default}] 对象数组)
  //   - primary_image: string(主图 URL,单独于 images)
  //   - 不能带内部字段(_sourceVariant / _stock / _imageSource / scraped_* / bundleComplexAttrs 等)
  //
  // 数据源优先级:
  //   1) sv._bundleItem.attributes —— bundle 接口返回的完整后台数据,含 dictionary_value_id(最权威)
  //   2) sv.attributes —— /search 归一化数据,{key, value/collection} shape(可能缺 dictionary_value_id)
  const transformItemForPortal = (item) => {
    const sv = item._sourceVariant || null;
    const bundleItem = sv?._bundleItem || null;

    // 5.1 images: [{file_name, default}] → ["url1", "url2", ...]
    // v3 schema: images 是 string[](URL 数组),primary_image 单独传
    // ⚠️ OPI v3 要求 primary_image 不能与 images 数组中的任一图片重复,
    // 否则报错:"图片 - 该字段重复的。请检查 API 中的商品描述:所有字段只应指定一次,不得重复"
    // 修复策略:
    //   - 仅当某张图显式标记 default:true 时,才把它作为 primary_image,并从 images 数组中移除
    //   - 否则不传 primary_image(留空),OPI 会自动用 images[0] 作主图
    const rawImgObjs = Array.isArray(item.images) ? item.images : [];
    let primaryImg = '';
    const rawImages = [];
    for (const img of rawImgObjs) {
      const url = typeof img === 'string' ? img : img?.file_name || '';
      if (!url) continue;
      if (!primaryImg && img && typeof img === 'object' && img.default === true) {
        primaryImg = url; // 显式标记的主图,单独取出
      } else {
        rawImages.push(url);
      }
    }
    // 若所有图都被 push 进 rawImages(无显式 default),则 primaryImg 留空 '',
    // OPI 会用 images[0] 作主图,避免重复
    const images = rawImages;

    // 5.2 attributes: 优先从 bundleItem 提取 v3 标准格式(含 dictionary_value_id)
    // v3 schema: {complex_id: int, id: int, values: [{dictionary_value_id: int, value: string}]}
    //
    // ⚠️ 以下属性在 v3 schema 里由顶层字段单独传递,不能再放进 attributes 数组,否则 Ozon 报错:
    //   "图片 - 该字段重复的。请检查 API 中的商品描述:所有字段只应指定一次,不得重复"
    // bundleItem.attributes 和 sv.attributes 是旧版 seller portal 风格,会带这些字段,必须过滤掉:
    //   - 4194 主图 / 4195 图册 → 顶层 primary_image / images
    //   - 4497 重量 / 9454 深度 / 9455 宽度 / 9456 高度 → 顶层 weight+weight_unit / depth+width+height+dimension_unit
    //   注:8229(类型) 与 type_id 通过 dictionary_value_id 关联但非同一字段,保留 8229
    //       (type_id 是类目定位字段,8229 是商品属性展示,Ozon 期望两者共存)
    const SKIP_ATTR_IDS = new Set([4194, 4195, 4497, 9454, 9455, 9456]);
    const attributes = [];
    const usedKeys = new Set();

    // 5.2a 优先从 bundleItem.attributes 提取(complex_id==0 的简单 attr)
    // ⚠️ Ozon 字典类型属性(如 8229 "类型")的 values 可能只有 dictionary_value_id
    // 而 value 为空字符串。只按 value 非空过滤会丢掉这种必填属性,导致 Ozon 报错
    // "Вы не указали тип. Атрибут является обязательным для заполнения"。
    // 修复:同时保留有 dictionary_value_id 的条目。
    if (bundleItem && Array.isArray(bundleItem.attributes)) {
      for (const ba of bundleItem.attributes) {
        // 跳过 complex attr(由 5.3 complex_attributes 处理)
        if (ba.complex_id && Number(ba.complex_id) !== 0) continue;
        const attrId = Number(ba.attribute_id || ba.id || 0);
        if (!attrId) continue;
        if (SKIP_ATTR_IDS.has(attrId)) continue; // 图片属性走顶层 images/primary_image
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

    // 5.2b 兜底:从 sv.attributes 转换(可能缺 dictionary_value_id)
    if (sv && Array.isArray(sv.attributes)) {
      for (const a of sv.attributes) {
        const key = String(a.key || a.attribute_id || '');
        if (!key || usedKeys.has(key)) continue;
        // 跳过图片属性(4194 主图 / 4195 图册):v3 用顶层 primary_image / images 字段
        if (SKIP_ATTR_IDS.has(Number(key))) continue;
        // sv shape: {key, value} 或 {key, collection:[...]}
        // 可能带 dictionary_value_id(/search 部分字段有)
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

    // 5.2c 描述(4191):插件端把描述放在 item.scraped_description 顶层字段,
    // 但 /search 不返 4191,sv.attributes 可能没有。OPI v3 schema 无顶层 description,
    // 描述必须作为 attribute 4191 传递。这里补注入。
    const descText = String(item.scraped_description || item.description || '').trim();
    if (descText && !usedKeys.has('4191')) {
      attributes.push({
        complex_id: 0,
        id: 4191,
        values: [{ value: descText }],
      });
      usedKeys.add('4191');
    }

    // DEBUG: 记录 11254(富内容) 和 4191(描述) 和 85(品牌) 的提取情况,排查丢失
    const richAttr = attributes.find((a) => Number(a.id) === 11254);
    const descAttr = attributes.find((a) => Number(a.id) === 4191);
    const brandAttr = attributes.find((a) => Number(a.id) === 85);
    const svAttrKeys = Array.isArray(sv?.attributes) ? sv.attributes.map((a) => String(a.key)).join(',') : '';
    logger.info(
      {
        offer_id: item.offer_id,
        hasRichContent_11254: !!richAttr,
        richContentLen: richAttr?.values?.[0]?.value?.length || 0,
        hasDesc_4191: !!descAttr,
        descLen: descAttr?.values?.[0]?.value?.length || 0,
        hasBrand_85: !!brandAttr,
        brandValue: brandAttr?.values?.[0]?.value || '',
        brandDictId: brandAttr?.values?.[0]?.dictionary_value_id || '',
        svAttrKeys: svAttrKeys.slice(0, 200),
        usedKeys: Array.from(usedKeys).join(','),
        hasBundleItem: !!bundleItem,
        bundleAttrCount: bundleItem?.attributes?.length || 0,
        scrapedDescriptionLen: String(item.scraped_description || '').length,
      },
      'prepare-bundle: 11254/4191/85 提取详情'
    );

    // 5.3 complex_attributes(视频/PDF 等):bundleComplexAttrs 透传
    // v3 schema: [{attributes: [{complex_id, id, values:[{value, dictionary_value_id}]}]}]
    // bundle 接口返回的格式已接近 v3,只需字段名对齐(attribute_id → id)
    const complex_attributes = [];
    if (Array.isArray(item.bundleComplexAttrs)) {
      for (const ca of item.bundleComplexAttrs) {
        if (!ca || !Array.isArray(ca.attributes)) continue;
        const innerAttrs = ca.attributes
          .map((ba) => {
            const attrId = Number(ba.attribute_id || ba.id || 0);
            if (!attrId) return null;
            // 同 5.2a:字典类型属性可能只有 dictionary_value_id 而 value 为空
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
          })
          .filter(Boolean);
        if (innerAttrs.length > 0) {
          complex_attributes.push({ attributes: innerAttrs });
        }
      }
    }

    // 5.4 type_id + description_category_id(门户 bundle 接口也期望这两个字段)
    //
    // 字段语义(Ozon API):
    //   - description_category_id: 叶子类目 ID(必填,缺失→错误 description_type_is_empty)
    //   - type_id: 类目下的类型 ID(必填,可由 attribute 8229 替代)
    //
    // /search 响应字段(实测):
    //   - description_type_dict_value → 映射到 sv.description_category_id(命名混淆)
    //     字面意"描述类型字典值",实际是 type_id(因为 description_type_name → attr 8229 类型名)
    //   - categories[{id, level}] → 类目路径,deepest level 的 id 可能是 description_category_id
    //
    // bundle item(create-bundle-by-variant-id 返回)是最权威源,应包含这两个字段。
    //
    // ⚠️ 错误 description_type_is_empty 的 field=description_category_id,
    //    表示 description_category_id 为 0,而非 type_id 为 0。
    // bundleItem 已在 5.2 声明(优先从 bundle item 提取 attributes),这里复用
    const cats = Array.isArray(sv?.categories) ? sv.categories : [];
    const deepestCat = cats.filter((c) => c.id).sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];

    // type_id: sv.description_category_id 实际是 description_type_dict_value = type_id
    // bundle item 如有 type_id 则优先用
    const typeId = Number(bundleItem?.type_id) || Number(sv?.description_category_id) || 0;

    // description_category_id: 从多个源尝试
    // 1) bundle item 顶层 description_category_id
    // 2) bundle item 嵌套 category.description_category_id / description_category.id
    // 3) sv.search_description_category_id(/search 真字段,若有)
    // 4) sv.categories[] 最深一级 id
    const descriptionCategoryId =
      Number(bundleItem?.description_category_id) ||
      Number(bundleItem?.category?.description_category_id) ||
      Number(bundleItem?.description_category?.id) ||
      Number(sv?.search_description_category_id) ||
      Number(deepestCat?.id) ||
      0;

    // DEBUG: 完整记录解析过程,定位 description_category_id=0 的根因
    logger.info(
      {
        offer_id: item.offer_id,
        typeId,
        descriptionCategoryId,
        hasBundleItem: !!bundleItem,
        bundleItemKeys: bundleItem ? Object.keys(bundleItem).slice(0, 30) : null,
        bundleTypeId: bundleItem?.type_id,
        bundleDescCatId: bundleItem?.description_category_id,
        bundleCategoryObj: bundleItem?.category ? JSON.stringify(bundleItem.category).slice(0, 200) : null,
        bundleDescCatObj: bundleItem?.description_category
          ? JSON.stringify(bundleItem.description_category).slice(0, 200)
          : null,
        svDescCatId: sv?.description_category_id,
        searchDescCatId: sv?.search_description_category_id,
        deepestCatId: deepestCat?.id,
        deepestCatLevel: deepestCat?.level,
        catCount: cats.length,
        cats: cats.map((c) => ({ id: c.id, level: c.level, name: c.name })),
      },
      'prepare-bundle: type_id/description_category_id 解析详情'
    );

    if (!descriptionCategoryId) {
      logger.error(
        {
          offer_id: item.offer_id,
          descriptionCategoryId,
          hasBundleItem: !!bundleItem,
          bundleDescCatId: bundleItem?.description_category_id,
          svDescCatId: sv?.description_category_id,
          deepestCatId: deepestCat?.id,
          catCount: cats.length,
        },
        'prepare-bundle: description_category_id=0,将触发 Ozon 错误 description_type_is_empty'
      );
    }
    if (!typeId) {
      logger.warn(
        {
          offer_id: item.offer_id,
          typeId,
          svDescCatId: sv?.description_category_id,
          bundleTypeId: bundleItem?.type_id,
        },
        'prepare-bundle: type_id=0,可能触发 Ozon 拒绝(除非 attribute 8229 已填)'
      );
    }

    // 5.5 构造 seller.ozon.ru 期望的 item(对齐 /v3/product/import 官方 API schema)
    //
    // v3ImportProductsRequestItem 必填字段(required):
    //   attributes, description_category_id, depth, dimension_unit, height,
    //   images, name, offer_id, price, vat, weight, weight_unit, width, type_id
    //
    // ⚠️ type_id / description_category_id 处理策略(对齐 0.13 门户"按名匹配"机制):
    //   - 0.13 v3-payload.js 构造的 item **不含** type_id / description_category_id
    //   - 门户 update-bundle-items 接口通过 bundle 级的 description_category_lvl3_name
    //     (类目名,如 "Водолазки") 走"按名匹配",由 Ozon 自动填充这两个 ID
    //   - 如果 item 里显式传 type_id:0 / description_category_id:0,Ozon 会认为
    //     "用户显式设为 0"而非"未设置",不触发按名匹配 → 报错 description_type_is_empty
    //   - 因此:有值时透传(更精确),为 0 时**不传**(让 Ozon 走按名匹配)
    const portalItem = {
      // ── v3 必填字段 ──
      offer_id: String(item.offer_id || ''),
      name: String(item.name || ''),
      price: String(item.price || '0'),
      vat: String(item.vat || '0'),
      images,
      attributes,
      // 必填物理参数(缺省 100 兜底,对齐 0.13 v3-payload.js:52-55)
      weight: Number(item.weight) > 0 ? Math.round(Number(item.weight)) : 100,
      weight_unit: item.weight_unit || 'g',
      depth: Number(item.depth) > 0 ? Math.round(Number(item.depth)) : 100,
      width: Number(item.width) > 0 ? Math.round(Number(item.width)) : 100,
      height: Number(item.height) > 0 ? Math.round(Number(item.height)) : 100,
      dimension_unit: item.dimension_unit || 'mm',
      // ── v3 非必填字段(传默认值,对齐 v3 示例) ──
      old_price: String(item.old_price || item.price || '0'),
      currency_code: String(item.currency_code || 'RUB'),
      complex_attributes,
      // 主图(v3 schema:primary_image 单独于 images,空字符串表示用 images[0])
      primary_image: primaryImg || '',
      // 营销色彩图(默认空)
      color_image: '',
      // 360 图组(默认空数组)
      images360: [],
      // PDF 文件清单(默认空数组)
      pdf_list: [],
      // 新类目标识符(0 表示不更改类目)
      new_description_category_id: 0,
    };

    // 分类字段:有值才传,为 0 不传(让 Ozon 走 description_category_lvl3_name 按名匹配)
    if (typeId > 0) portalItem.type_id = typeId;
    if (descriptionCategoryId > 0) portalItem.description_category_id = descriptionCategoryId;

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
