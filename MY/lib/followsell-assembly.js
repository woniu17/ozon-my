(function (root) {
  "use strict";

  // 跟卖上架 item 组装 —— 从 content/ozon-product.js handleMultiVariantFollowSell 抽出的纯逻辑。
  // 输入已是页面快照(rowSpecs / pageCtx / config,不碰 DOM),输出与原内联 build loop 逐字节一致。
  //
  // 依赖(从 root 全局读;content 上下文由 manifest content_scripts 顺序保证已加载):
  //   root.normalizePrice / root.jzPreferSourceName / root.jzStripPromo /
  //   root.jzIsPromoResidualTitle / root.JZFollowSellContentCopy
  // 这些**只引用不重写**:jzPreferSourceName 内部还调 jzCleanOzonCardTitle 等传递依赖,
  // 重写会立刻引入 drift。PR2 让 SW 也能跑时,把这些依赖 importScripts 进 service-worker 即可。

  const NAME_MAX = 200;
  const DESC_MAX = 4096;

  // 与原内联 safeText 同实现(不走 contentCopy.safeText,避免跨文件耦合 drift)。name≤200 / desc≤4096。
  function safeText(s, max) {
    if (s == null) return "";
    const trimmed = String(s).replace(/\s+/g, " ").trim();
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  }

  // 严格只接受纯数字串(允许俄式逗号 "0,05" 转点 —— 仅替换首个逗号);"1.2kg"/"10 cm" → NaN。
  function parseStrictNumber(raw) {
    if (raw == null) return NaN;
    const s = String(raw).replace(",", ".").trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  /**
   * @param {object} input 见 handleMultiVariantFollowSell 处的调用点 / PR 说明。
   *   rowSpecs[]、sourceMap(会被 MUTATE:类目对齐/11254 注入/hashtag 合并)、galleryMap、
   *   richContentMap、matched[]、pageCtx{sku,brand,breadcrumbs,scrapedDims,sharedHashtags}、
   *   config{brandChoice,imageOrder,mergeModel,currencyCode,independentProducts,customDescription}、
   *   sharedVideo{url,cover}|null
   * @returns {Array<object>} items —— 与原 8825–9056 push 的对象逐字段/逐顺序一致
   */
  function assembleFollowSellItems(input) {
    const {
      rowSpecs = [],
      sourceMap = new Map(),
      galleryMap = new Map(),
      richContentMap = new Map(),
      matched = [],
      pageCtx = {},
      config = {},
      sharedVideo = null,
    } = input || {};

    const {
      brandChoice = "no_brand",
      imageOrder = "keep",
      mergeModel = "",
      currencyCode = "CNY",
      independentProducts = false,
      customDescription,
    } = config;

    const breadcrumbs = pageCtx.breadcrumbs;
    const pageScrapedDims = pageCtx.scrapedDims || {};
    const sharedHashtags = Array.isArray(pageCtx.sharedHashtags) ? pageCtx.sharedHashtags : [];
    const contentCopy = root.JZFollowSellContentCopy;

    // ── 类目一致性: 强制所有变体跟锚点变体(优先当前页, 否则首个匹配)用同一类目。
    //    独立商品模式(跟卖本页商品卡)跳过 —— 各卡片是无关商品。浅克隆覆盖不污染原 sv。
    const anchorSku = (pageCtx.sku && sourceMap.has(String(pageCtx.sku)))
      ? String(pageCtx.sku)
      : matched[0];
    const anchorSv = anchorSku ? sourceMap.get(anchorSku) : null;
    if (anchorSv && !independentProducts) {
      const anchorDescCatId = anchorSv.description_category_id;
      const anchorCategories = anchorSv.categories;
      const anchorTypeAttr = (anchorSv.attributes || []).find((a) => String(a.key) === "8229");
      for (const [sku, sv] of sourceMap.entries()) {
        if (sku === anchorSku || !sv) continue;
        const cloned = { ...sv };
        cloned.description_category_id = anchorDescCatId;
        cloned.categories = anchorCategories;
        if (anchorTypeAttr) {
          const newAttrs = (sv.attributes || []).filter((a) => String(a.key) !== "8229");
          newAttrs.push({ ...anchorTypeAttr });
          cloned.attributes = newAttrs;
        }
        sourceMap.set(sku, cloned);
      }
    }

    // ── 视频/PDF complex 商品级兜底(独立商品模式不共享):锚点优先,否则扫首个非空。
    const sharedBundleComplex = independentProducts ? null : (() => {
      if (Array.isArray(anchorSv?._bundleComplexAttrs) && anchorSv._bundleComplexAttrs.length > 0) {
        return anchorSv._bundleComplexAttrs;
      }
      for (const s of sourceMap.values()) {
        if (Array.isArray(s?._bundleComplexAttrs) && s._bundleComplexAttrs.length > 0) return s._bundleComplexAttrs;
      }
      return null;
    })();

    // 「复制当前品牌」用:源品牌真名商品级共享(品牌非变体级,后端从 sv 找可能恒空)。
    const _sourceBrand = pageCtx.brand ? String(pageCtx.brand).trim() : "";

    const items = [];
    for (const rowSpec of rowSpecs) {
      const price = root.normalizePrice(rowSpec.priceRaw);
      const oldPrice = parseFloat(rowSpec.oldPriceRaw) || (price * 1.25);
      // 最低价(Ozon 自动调价下限,选填):留空 → 不传 min_price
      const minPriceRaw = rowSpec.minPriceRaw;
      const minPriceNum = minPriceRaw != null && minPriceRaw !== "" ? Number(minPriceRaw) : NaN;
      const minPrice = Number.isFinite(minPriceNum) && minPriceNum > 0 ? minPriceNum : null;
      const stock = parseInt(rowSpec.stockRaw) || 0;
      const offerId = rowSpec.offerIdRaw || `SKU${rowSpec.sku}-${Date.now().toString().slice(-4)}`;
      const sv = sourceMap.get(String(rowSpec.sku));
      // 该变体自己的 bundle 视频/PDF,缺失回退商品级兜底
      const bundleComplex = (Array.isArray(sv?._bundleComplexAttrs) && sv._bundleComplexAttrs.length > 0)
        ? sv._bundleComplexAttrs
        : sharedBundleComplex;

      // 物理参数优先级:用户输入 > 源 sv attrs > undefined(让后端沿兜底链补齐)
      const readSourceInt = (key) => {
        const a = (sv?.attributes || []).find((x) => String(x.key) === String(key));
        const n = parseStrictNumber(a?.value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      };
      const readSourceWeightKgAsG = () => {
        const a = (sv?.attributes || []).find((x) => String(x.key) === "4383");
        const n = parseStrictNumber(a?.value);
        if (!Number.isFinite(n) || n <= 0) return null;
        // 4383 通常 kg 浮点;>100 时可能本就是 g,跟后端 product.service.ts 启发式对齐
        return n < 100 ? Math.round(n * 1000) : Math.round(n);
      };
      // 用户实际输入:只有有限正数才算填了。NaN/0/空/带单位串 一律视为未填。
      const readUserInt = (raw) => {
        const n = parseStrictNumber(raw);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      };
      const userWeight = readUserInt(rowSpec.weightRaw);
      const userDepth = readUserInt(rowSpec.depthRaw);
      const userWidth = readUserInt(rowSpec.widthRaw);
      const userHeight = readUserInt(rowSpec.heightRaw);
      // weight: user > source 4497(packaged g) > source 4383(kg→g) > undefined
      const weight = userWeight || readSourceInt("4497") || readSourceWeightKgAsG() || undefined;
      const depth = userDepth || readSourceInt("9454") || undefined;
      const width = userWidth || readSourceInt("9455") || undefined;
      const height = userHeight || readSourceInt("9456") || undefined;
      const variantGallery = galleryMap.get(String(rowSpec.sku)) || [];
      // 源富内容(11254):抽到则注入 sv.attributes(幂等:已有不重复加),让后端 pickSourceRichContent 命中
      const variantRichContent = richContentMap.get(String(rowSpec.sku)) || "";
      if (variantRichContent && sv && typeof sv === "object") {
        if (!Array.isArray(sv.attributes)) sv.attributes = [];
        if (!sv.attributes.some((a) => String(a.key) === "11254")) {
          sv.attributes.push({ key: "11254", value: variantRichContent });
        }
      }
      let allImages = [];
      const seenUrls = new Set();
      const pushUrl = (u) => {
        if (!u || typeof u !== "string") return;
        const norm = u.split("?")[0].split("#")[0].toLowerCase();
        if (seenUrls.has(norm)) return;
        seenUrls.add(norm);
        allImages.push(u);
      };

      // 图片来源链(else-if,非叠加):变体图册 → sv 4194/4195 → coverImage
      if (variantGallery.length > 0) {
        for (const url of variantGallery) pushUrl(url);
      } else if (sv?.attributes) {
        const primaryImgAttr = sv.attributes.find((a) => String(a.key) === "4194");
        const addlImgAttr = sv.attributes.find((a) => String(a.key) === "4195");
        if (primaryImgAttr?.value) pushUrl(primaryImgAttr.value);
        if (addlImgAttr?.collection?.length > 0) {
          for (const url of addlImgAttr.collection) pushUrl(url);
        }
      }
      if (allImages.length === 0 && rowSpec.coverImage) {
        pushUrl(rowSpec.coverImage);
      }
      // Apply image order setting
      if (imageOrder === "shuffle" && allImages.length > 1) {
        for (let k = allImages.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [allImages[k], allImages[j]] = [allImages[j], allImages[k]];
        }
      } else if (imageOrder === "shuffle_keep_first" && allImages.length > 2) {
        const first = allImages[0];
        const rest = allImages.slice(1);
        for (let k = rest.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [rest[k], rest[j]] = [rest[j], rest[k]];
        }
        allImages = [first, ...rest];
      }
      const productImages = allImages.map((url, i) => ({ file_name: url, default: i === 0 }));

      // 名称取值链(避开浏览器翻译 + 角标污染):见原 handleMultiVariantFollowSell 注释块。
      const _name4180 = (sv?.attributes || []).find((a) => String(a.key) === "4180");
      const sourceName = _name4180?.value
        ? String(_name4180.value).replace(/\s+/g, " ").trim()
        : "";
      const _domRaw = String(rowSpec.domTitleRaw || "").trim();
      const domName = _domRaw === "-" ? "" : _domRaw; // '-' 是空标题的渲染占位
      const _baseTitle = String(rowSpec.baseTitle || "").trim();
      const titleEdited = !!domName && !!_baseTitle && domName !== _baseTitle;
      const _isCN = (s) => /[一-龥]/.test(s);
      const looksTranslated = sourceName && _isCN(domName) && !_isCN(sourceName);
      let rawName;
      if (titleEdited) {
        rawName = looksTranslated ? sourceName : domName;
      } else if (root.jzPreferSourceName) {
        rawName = root.jzPreferSourceName(sourceName, domName) || rowSpec.variantTitle || "";
      } else {
        rawName = looksTranslated
          ? sourceName
          : (domName || sourceName || rowSpec.variantTitle || "");
      }
      if (root.jzStripPromo) {
        const strippedName = root.jzStripPromo(rawName);
        if (root.jzIsPromoResidualTitle?.(rawName, strippedName)) {
          const svClean = sourceName
            ? (root.jzStripPromo(sourceName) || sourceName)
            : "";
          rawName = svClean || strippedName || rawName;
        } else if (strippedName) {
          rawName = strippedName;
        }
      }
      const variantName = safeText(rawName, NAME_MAX);
      // 简介只取源真实描述(自定义→源 4191),空则退标题;不用页面描述兜底(会抓回富内容)。
      const description = contentCopy?.pickFollowSellDescription
        ? contentCopy.pickFollowSellDescription({
            customDescription: customDescription,
            sourceVariant: sv,
            richContent: variantRichContent,
            fallbackName: variantName,
            max: DESC_MAX,
          })
        : safeText(customDescription || variantName, DESC_MAX);
      contentCopy?.mergeSourceHashtagsIntoVariant?.(sv, sharedHashtags);
      items.push({
        offer_id: offerId,
        name: variantName,
        price: price.toFixed(2),
        old_price: oldPrice.toFixed(2),
        ...(minPrice != null ? { min_price: minPrice.toFixed(2) } : {}),
        vat: "0",
        currency_code: currencyCode,
        images: productImages,
        bundleComplexAttrs: bundleComplex || undefined,
        ...(sharedVideo?.url ? { videoUrl: sharedVideo.url } : {}),
        ...(sharedVideo?.cover ? { videoCover: sharedVideo.cover } : {}),
        scraped_breadcrumbs: breadcrumbs,
        scraped_description: description,
        ...(sharedHashtags.length > 0 ? { _aiHashtags: sharedHashtags } : {}),
        scraped_sku: String(rowSpec.sku),
        scraped_brand: brandChoice,
        scraped_brand_value: (brandChoice === "copy" && _sourceBrand) ? _sourceBrand : undefined,
        scraped_model_name: mergeModel ? safeText(mergeModel, NAME_MAX) : undefined,
        _sourceVariant: sv || undefined,
        weight: weight,
        weight_unit: weight != null ? "g" : undefined,
        depth: depth, width: width, height: height,
        dimension_unit: (depth != null || width != null || height != null) ? "mm" : undefined,
        scraped_weight: pageScrapedDims.weight,
        scraped_depth: pageScrapedDims.depth,
        scraped_width: pageScrapedDims.width,
        scraped_height: pageScrapedDims.height,
        _stock: stock,
      });
    }
    return items;
  }

  const api = { assembleFollowSellItems, safeText, parseStrictNumber };
  root.JZFollowSellAssembly = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
