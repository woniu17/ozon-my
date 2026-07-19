// compose-sv-shape:把 Ozon /api/v1/search 原始 variants + bundle item 合成 sv shape
//
// 背景(方案B,2026-07):
//   旧版 qx-ozon 在写入 attribute_cache.search_data 之前会调 normalizeSearchVariantToSv
//   把 /api/v1/search 的扁平字段(variant_name/brand_name/description/main_image/...)
//   转成 sv shape({ variant_id, description_category_id, categories, _searchMeta, attributes }),
//   然后还会把 bundle 返回的物理属性(weight/depth/width/height/barcode)merge 进
//   items[0].attributes 并覆盖写回 search_data,导致 search_data 被污染:
//     - search 缓存不再代表 Ozon /api/v1/search 的真实返回(混入了 bundle 数据)
//     - 一些 /search 原始字段(price/sale_price/available_stock/vat/...)在 normalize 时丢失
//     - 调试时看不到 Ozon 真实返回,只能看到插件重塑产物
//
//   方案B 改造:search_data 只存 Ozon /api/v1/search 的原始 variants 数组,bundle_data
//   保持原始(本来就是),读取端按需调本函数合成 sv shape。
//
// 兼容性:
//   旧版 search_data 已经是 sv shape(有 attributes 数组),本函数检测到此情况直接返回,
//   不再重塑(避免重复处理 / 字段丢失)。
//
// 数据来源:
//   - searchRaw:Ozon /api/v1/search 返回的单个 variant 对象(扁平字段)
//   - bundleItem:Ozon create-bundle-by-variant-id 返回的 item(已是原始)
//
// 输出 sv shape(对齐 qx-ozon normalizeSearchVariantToSv + bundle merge 逻辑):
//   {
//     variant_id, description_category_id, categories, _searchMeta,
//     attributes: [...基础属性 + 物理属性 + bundle 简单属性],
//     _bundleItem,           // 完整 bundle item(供高级 caller 用)
//     _bundleComplexAttrs,   // bundle complex attrs(视频/PDF)
//   }

/**
 * 从 bundle item 顶层提取物理字段(weight/depth/width/height/barcode)
 * 并以 sv attr key(4497/9454/9455/9456/7822)形式返回。
 * 与 qx-ozon collect-queue.js _extractBundlePhysicalAttrs 一致。
 */
function extractBundlePhysicalAttrs(bundleItem) {
  if (!bundleItem) return [];
  const attrs = [];
  if (Number(bundleItem.weight) > 0) attrs.push({ key: '4497', value: String(bundleItem.weight) });
  if (Number(bundleItem.depth) > 0) attrs.push({ key: '9454', value: String(bundleItem.depth) });
  if (Number(bundleItem.width) > 0) attrs.push({ key: '9455', value: String(bundleItem.width) });
  if (Number(bundleItem.height) > 0) attrs.push({ key: '9456', value: String(bundleItem.height) });
  if (bundleItem.barcode) attrs.push({ key: '7822', value: String(bundleItem.barcode) });
  return attrs;
}

/**
 * 把 Ozon /api/v1/search 单个 variant(扁平字段)归一为 sv 基础 shape(不含物理 attrs)。
 * 与 qx-ozon collect-runner.js normalizeSearchVariantToSv 完全一致(纯函数镜像)。
 *
 * 已是 sv shape(有 attributes 数组)→ 原样返回,避免重复处理。
 */
export function normalizeSearchVariantToSv(v) {
  if (!v) return null;
  // 已是 sv shape(有 attributes 数组)→ 原样返回
  if (Array.isArray(v.attributes) && v.attributes.length > 0) return v;
  const attributes = [];
  if (v.description_type_name) attributes.push({ key: '8229', value: v.description_type_name });
  if (v.brand_name) attributes.push({ key: '85', value: v.brand_name });
  // /search 商品名实际字段是 variant_name;title/name 兜底(少数 shape 用过)
  const productName = v.variant_name || v.title || v.name;
  if (productName) attributes.push({ key: '4180', value: productName });
  if (v.description) attributes.push({ key: '4191', value: v.description });
  if (v.main_image) attributes.push({ key: '4194', value: v.main_image });
  const secondaries = Array.isArray(v.secondary_images) ? v.secondary_images : [];
  if (secondaries.length > 0) attributes.push({ key: '4195', collection: secondaries });
  // GTIN(7822) — 从 /search 的 barcodes 兜底
  if (Array.isArray(v.barcodes) && v.barcodes.length > 0) {
    const gtin = String(v.barcodes[0] || '').trim();
    if (gtin) attributes.push({ key: '7822', value: gtin });
  }
  return {
    // variant_id 优先 /search 真返的 variant_id,barcode 兜底
    variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || '',
    description_category_id: Number(v.description_type_dict_value) || 0,
    categories: (v.categories || []).map((c) => ({
      id: Number(c.id),
      level: Number(c.level),
      name: c.name || '',
      title: c.title || c.name || '',
    })),
    // 把 /search 的额外字段也带上,方便上层(如跟卖面板的 is_copy_allowed 检查)使用
    _searchMeta: {
      skus: v.skus || [],
      barcodes: v.barcodes || [],
      brand_id: v.brand_id,
      is_copy_allowed: v.is_copy_allowed,
      is_content_copy_allowed: v.is_content_copy_allowed,
      rating: v.rating,
    },
    attributes,
  };
}

/**
 * 把 search cache 的原始数据 + bundle item 合成完整 sv shape(供 prepare-bundle / opi-preview 用)
 *
 * @param {object|null} searchRaw - search cache 里的单个 variant 对象(可能是原始扁平字段,
 *                                  也可能是旧版 sv shape;本函数会自动识别)
 * @param {object|null} bundleItem - bundle cache 里的 item(原始,含 attributes 数组 +
 *                                   顶层 weight/depth/width/height/barcode)
 * @returns {object|null} 合成后的 sv shape,或 null(无数据时)
 *
 * 合成规则(对齐 qx-ozon service-worker.js searchVariants handler Step2):
 *   1. searchRaw → normalizeSearchVariantToSv 得到基础 sv(已含 5-6 个基础属性)
 *   2. bundle 物理属性(4497/9454/9455/9456/7822)merge 进 attributes(去重)
 *   3. bundle 简单属性(complex_id=0)merge 进 attributes(去重,保留 dictionary_value_id 信息)
 *   4. bundle complex属性(complex_id>0,视频/PDF)收集成 _bundleComplexAttrs
 *   5. 完整 bundle item 挂到 _bundleItem 字段
 */
export function composeSvShape(searchRaw, bundleItem) {
  // search 缺失时,只用 bundle 合成(原 fallback 逻辑)
  if (!searchRaw) {
    if (!bundleItem) return null;
    const attributes = [];
    const existingKeys = new Set();
    if (Array.isArray(bundleItem.attributes)) {
      for (const ba of bundleItem.attributes) {
        if (ba.complex_id && String(ba.complex_id) !== '0') continue;
        const key = String(ba.attribute_id || ba.id || '');
        if (!key || existingKeys.has(key)) continue;
        const vals = Array.isArray(ba.values)
          ? ba.values.filter((v) => v && v.value != null && v.value !== '')
          : [];
        if (vals.length === 0) continue;
        if (vals.length > 1) {
          attributes.push({ key, collection: vals.map((v) => String(v.value)) });
        } else {
          attributes.push({ key, value: String(vals[0].value) });
        }
        existingKeys.add(key);
      }
    }
    // 补物理属性
    for (const pa of extractBundlePhysicalAttrs(bundleItem)) {
      if (!existingKeys.has(pa.key)) {
        attributes.push(pa);
        existingKeys.add(pa.key);
      }
    }
    return {
      variant_id: bundleItem.variant_id || '',
      description_category_id: bundleItem.description_category_id || 0,
      categories: bundleItem.categories || [],
      attributes,
      _bundleItem: bundleItem,
      _bundleComplexAttrs: Array.isArray(bundleItem.attributes)
        ? bundleItem.attributes.filter((a) => a.complex_id && String(a.complex_id) !== '0')
        : [],
    };
  }

  // search 有数据 → 先 normalize 成基础 sv
  const sv = normalizeSearchVariantToSv(searchRaw);
  if (!sv) return null;

  // 无 bundle → 直接返回基础 sv
  if (!bundleItem) return sv;

  // 有 bundle → merge 物理属性 + 简单属性 + complex属性
  const existingKeys = new Set((sv.attributes || []).map((a) => String(a.key)));
  const mergedAttrs = [...(sv.attributes || [])];
  const bundleComplexAttrs = [];

  if (Array.isArray(bundleItem.attributes)) {
    for (const ba of bundleItem.attributes) {
      // complex属性(complex_id>0,视频/PDF)单独收集
      if (ba.complex_id && String(ba.complex_id) !== '0') {
        bundleComplexAttrs.push(ba);
        continue;
      }
      const key = String(ba.attribute_id || ba.id || '');
      if (!key || existingKeys.has(key)) continue;
      const vals = Array.isArray(ba.values)
        ? ba.values.filter((v) => v && v.value != null && v.value !== '')
        : [];
      if (vals.length === 0) continue;
      if (vals.length > 1) {
        mergedAttrs.push({ key, collection: vals.map((v) => String(v.value)) });
      } else {
        mergedAttrs.push({ key, value: String(vals[0].value) });
      }
      existingKeys.add(key);
    }
  }

  // 补 bundle 顶层物理字段(weight/depth/width/height/barcode)
  for (const pa of extractBundlePhysicalAttrs(bundleItem)) {
    if (!existingKeys.has(pa.key)) {
      mergedAttrs.push(pa);
      existingKeys.add(pa.key);
    }
  }

  return {
    ...sv,
    attributes: mergedAttrs,
    _bundleItem: bundleItem,
    _bundleComplexAttrs: bundleComplexAttrs.length > 0 ? bundleComplexAttrs : undefined,
  };
}

/**
 * 便利函数:从 attribute DAO 返回的 { searchData, bundleData } 直接合成 sv shape
 * @param {object} attrDoc - attribute DAO 返回的对象,含 searchData/bundleData 字段
 * @returns {object|null} 合成后的 sv shape
 */
export function composeSvFromAttrDoc(attrDoc) {
  if (!attrDoc) return null;
  const searchRaw =
    attrDoc.searchData && Array.isArray(attrDoc.searchData.items) && attrDoc.searchData.items.length > 0
      ? attrDoc.searchData.items[0]
      : null;
  const bundleItem = attrDoc.bundleData || null;
  return composeSvShape(searchRaw, bundleItem);
}
