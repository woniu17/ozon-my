/* =========================================================
 * PDP 采集函数(采集代码隔离 Phase 4)
 *
 * 从 content/ozon-product.js 提取的 3 个 A 类纯采集函数:
 *   - collectAllVariants       一键采集(多变体合并母体)
 *   - pushCollectBoxV2FromCollected  全源采集 v2 推送(字段级 source 标记)
 *   - performProductCollect    单品采集
 *
 * 架构(对齐 Phase 3 命名空间桥接模式):
 *   - 本文件在 ozon-product.js 之前注入(manifest 顺序)
 *   - 暴露 window.__jzPdpCollect = { collectAllVariants, performProductCollect }
 *   - 通过 window.__jzPdpCollectExtract.* 访问 ozon-product.js IIFE 内的 B 类共用函数
 *   - 通过 window.jzCaptureAndTransferPageVideoMedia 访问视频转存(跟卖共用,已挂 window)
 *
 * 时序安全:
 *   - 本文件先注入,但函数仅在用户点击按钮或收到 onMessage 时才执行
 *   - 此时 ozon-product.js 早已执行完毕,__jzPdpCollectExtract 桥接对象已就绪
 *   - 函数体内访问 window.__jzPdpCollectExtract.* 是惰性查找,无时序问题
 *
 * onMessage listener:
 *   - 独立注册 triggerCollectFromPopup(原 ozon-product.js init 内的混合 listener 拆分)
 *   - 与 ozon-product.js 保留的 openRecommendations listener 共存无冲突
 * ========================================================= */

(function () {
  'use strict';

  if (window.__jzPdpCollect) return; // 防止 MV3 重注入

  // B 类共用函数桥接访问器(惰性查找,调用时 __jzPdpCollectExtract 已就绪)
  const E = () => window.__jzPdpCollectExtract;

  // ── 一键采集:多变体合并母体 ──────────────────────────────────────────────────
  // 静默执行,进度直接显示在按钮上;单/无变体页直接委托 performProductCollect(单采)。
  //
  // 注意:下面的 Phase A SSR 展开块是 toggleFollowSellPanel(§Phase A,约 7397-7480)
  // 的精简镜像(去掉了与 Phase B worker pool 的交错,改为展开完再统一 collectBySkus)。
  // 若 Ozon 改 aspects/SSR 格式,两处需同步更新。
  async function collectAllVariants(btn) {
    const ext = E();
    const setBtn = (text) => {
      if (btn) btn.innerHTML = `<span class="oh-btn-icon">${ext.lucideSvg('refresh-cw')}</span>${text}`;
    };

    // composer-api 缓存预热(限 3s),让后续 sync 提取走 cache fallback
    if (window.ensurePdpState) {
      try {
        await Promise.race([window.ensurePdpState(), new Promise((r) => setTimeout(r, 3000))]);
      } catch {}
    }

    let variants = ext.extractAspectVariants();

    // ── Phase 0:弹窗补全(单轴多值,如 38 色)──
    // 内联 webAspects 只带可见 ~6 个,其余在「Все N цветов」弹窗懒加载;Phase A 的
    // ≥2 轴门挡不住单轴场景,这里先按 aspectModalInfo.link 拉全量并集。
    variants = await ext.jzExpandVariantsViaModal(variants, ext.extractRawAspects(), setBtn);

    // ── Phase A:SSR 逐页展开补全所有变体 SKU(多轴网格)──
    try {
      const rawAspects = ext.extractRawAspects();
      const currentSku = String(ext.extractProductData()?.sku || '');
      const needPhaseA = rawAspects.length >= 2 && variants.length > 1 && currentSku;
      if (needPhaseA) {
        const variantMap = new Map(variants.map((v) => [String(v.sku), v]));
        const sortedAxes = [...rawAspects].sort((a, b) => (a.variants?.length || 0) - (b.variants?.length || 0));
        const linksToFetch = (sortedAxes[0]?.variants || [])
          .filter((v) => v && String(v.sku) !== currentSku && v.link)
          .slice(0, 8)
          .map((v) => ({ sku: String(v.sku), link: v.link }));
        for (let i = 0; i < linksToFetch.length; i++) {
          setBtn(`展开变体 ${i}/${linksToFetch.length}…`);
          if (i > 0) await new Promise((r) => setTimeout(r, 1200));
          try {
            const u = new URL(linksToFetch[i].link, 'https://www.ozon.ru');
            const r = await fetch(u.pathname, { credentials: 'include', headers: { accept: 'text/html' } });
            if (!r.ok) continue;
            const html = await r.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            let fetchedAspects = null;
            for (const el of doc.querySelectorAll('[data-state]')) {
              try {
                const data = JSON.parse(el.getAttribute('data-state') || '');
                if (Array.isArray(data?.aspects) && data.aspects.length > 0) {
                  fetchedAspects = data.aspects;
                  break;
                }
              } catch {}
            }
            if (!fetchedAspects) continue;
            for (const aspect of fetchedAspects) {
              const aspectName = aspect.aspectName || '';
              for (const v of aspect.variants || []) {
                const sku = String(v.sku || '');
                if (!sku) continue;
                if (!variantMap.has(sku)) {
                  const d = v.data || {};
                  const srcCurrency = ext.detectCurrencyFromPriceStr(d.price);
                  const rawPriceNum = window.normalizePrice(d.price) || 0;
                  const isRub = srcCurrency === 'RUB';
                  variantMap.set(sku, {
                    sku,
                    title: d.title || '',
                    price: isRub ? ext.rubToCny(rawPriceNum) : rawPriceNum,
                    priceCurrency: isRub ? 'CNY' : srcCurrency || 'CNY',
                    priceRub: isRub ? rawPriceNum : 0,
                    coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
                    link: v.link || '',
                    availability: v.availability || 'unknown',
                    active: v.active === true,
                    aspectValues: {},
                  });
                }
                const existing = variantMap.get(sku);
                const text = v.data?.searchableText || v.data?.textRs?.map((t) => t.content).join('') || '';
                if (aspectName && text) existing.aspectValues[aspectName] = text;
              }
            }
          } catch (e) {
            console.warn('[ozon-helper] collectAll phaseA err:', e?.message || e);
          }
        }
        variants = Array.from(variantMap.values());
      }
    } catch (e) {
      console.warn('[ozon-helper] collectAll expand guard:', e?.message || e);
    }

    // ── #160 一次性诊断(用 console.error，生产构建不会 DCE)──
    // 现象:一键采集对多变体商品只建 1 个 SKU。根因疑为变体检测(extractAspectVariants /
    // extractRawAspects / SSR·弹窗展开)在当前 Ozon 页面普遍返回 ≤1,退回单采把整页图塞进 1 SKU。
    // 这里 dump 检测各环节的产出 + 页面 state/widget key,定位 Ozon 把 aspects 挪到了哪。
    // 用户点一次「一键采集」把 Console 里 [JZ#160] 这行贴回即可。定位后删除本块。
    try {
      const stateEls = Array.from(document.querySelectorAll('[data-state]'));
      let withAspects = 0;
      const stateKeys = [];
      for (const el of stateEls) {
        const k = el.getAttribute('data-state-key') || el.getAttribute('data-widget') || '';
        if (k) stateKeys.push(k);
        try {
          const d = JSON.parse(el.getAttribute('data-state') || '');
          if (d && Array.isArray(d.aspects) && d.aspects.length > 0) withAspects++;
        } catch {}
      }
      const rawAspects = (() => {
        try {
          return ext.extractRawAspects();
        } catch {
          return [];
        }
      })();
      const rawAspectVariantTotal = rawAspects.reduce((n, a) => n + (a?.variants || []).length, 0);
      const aspectVariants = (() => {
        try {
          return ext.extractAspectVariants();
        } catch {
          return [];
        }
      })();
      const widgetKeys = Array.from(document.querySelectorAll('[data-widget]'))
        .map((el) => el.getAttribute('data-widget'))
        .filter(Boolean);
      console.error(
        '[JZ#160] 变体检测诊断',
        JSON.stringify({
          currentSku: String(ext.extractProductData()?.sku || ''),
          dataStateEls: stateEls.length,
          dataStateWithAspects: withAspects,
          rawAspects: rawAspects.length,
          rawAspectVariantTotal,
          aspectVariants: aspectVariants.length,
          variantsAfterExpand: variants.length,
          willFallbackToSingle: variants.length <= 1,
          stateKeys: Array.from(new Set(stateKeys)).slice(0, 50),
          widgetKeys: Array.from(new Set(widgetKeys)).slice(0, 50),
        })
      );
    } catch (e) {
      console.error('[JZ#160] 诊断块异常:', e?.message || e);
    }

    // 单/无变体 → 走现有单采(sv 优先已在其中),保持原行为
    if (variants.length <= 1) {
      return await performProductCollect();
    }

    // ── Phase B:逐变体抓 sv(search+bundle)──
    const allSkus = variants.map((v) => String(v.sku)).filter(Boolean);
    let sourceMap = new Map();
    if (window.JZSkuCollect?.collectBySkus) {
      try {
        const res = await window.JZSkuCollect.collectBySkus(allSkus, {
          onProgress: (done, total) => setBtn(`抓取变体 ${done}/${total}…`),
          // PDP 上有更优路径:母体富内容由 jzCollectPageRichContent 从 composer 缓存抽
          // (listing 级,见下方 variantData 注入),不必逐变体走买家 tab 重复拉。
          captureRichContent: false,
        });
        sourceMap = res.sourceMap || new Map();
      } catch (e) {
        console.warn('[ozon-helper] collectAll phaseB err:', e?.message || e);
      }
    }

    // ── 组装成「一条多变体采集记录」(锚定母体/当前页 SKU)──
    // 旧实现把每个变体 push 成独立一行(N 行),用户在采集箱看到一堆同款散行。
    // 现在改为:N 个变体写进母体 variantData.variants,后端按母体 SKU upsert 一行,
    // 编辑页 collect-adapter 据此渲染多变体 → 一个采集商品、多变体编辑。
    //
    // 母体顶层(name/image/统计/卖家/划线价 + variantData 的类目/描述/物理尺寸/完整
    // attributes)取当前页 anchor;每个变体行只存编辑页 VariantRow 用到的轻量字段。
    const anchorProduct = (() => {
      try {
        return ext.extractProductData();
      } catch {
        return null;
      }
    })();
    const anchorSku = String(anchorProduct?.sku || anchorProduct?.productId || '');

    // 把一个 aspect 变体裁成编辑页变体行 + catalog(sv 优先,DOM/aspect 兜底)。
    const toVariantRow = (v) => {
      const sku = String(v.sku);
      const distilled = sourceMap.get(sku) || null;
      const sv = distilled?._sourceVariant || null;
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(sv) : null;
      const name = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name || distilled?.name, v.title)
        : v.title || distilled?.name || '';
      const images = svCat?.images?.length
        ? svCat.images
        : distilled?.images?.length
          ? distilled.images
          : v.coverImage
            ? [v.coverImage]
            : [];
      let link = '';
      try {
        if (v.link) link = new URL(v.link, 'https://www.ozon.ru').href;
      } catch {}
      return {
        sku,
        sv,
        name: name || v.title || '',
        image: svCat?.mainImage || v.coverImage || undefined,
        images: images.length ? images : undefined,
        // 价格口径同单采/后端:RUB 源送原卢布 + 'RUB'(后端 ×汇率);
        //   CNY 源(含 Ozon 跨境页默认人民币)送原人民币 + 'CNY'(后端原值保留);其它外币留空不猜。
        price: v.priceRub ? String(v.priceRub) : v.priceCurrency === 'CNY' && v.price ? String(v.price) : undefined,
        priceCurrency: v.priceRub ? 'RUB' : v.priceCurrency === 'CNY' && v.price ? 'CNY' : undefined,
        // is_aspect 规格维度值(颜色/尺码 → 文本),编辑页可据此预填区分 SKU 的属性。
        aspectValues: v.aspectValues && Object.keys(v.aspectValues).length ? v.aspectValues : undefined,
        link: link || undefined,
      };
    };

    const rows = variants.map(toVariantRow).filter((r) => r.sku);
    // 母体:优先当前页 SKU 那条,取不到用第一条兜底。
    const anchorRow = rows.find((r) => r.sku === anchorSku) || rows[0];
    const anchorSv = anchorRow?.sv || null;

    // variantData.variants 只存轻量行(不带每变体完整 sv,避免 JSONB 膨胀;
    // 共享 attributes/类目/尺寸走母体顶层 anchorSv)。
    const variantRows = rows.map((r) => ({
      sku: r.sku,
      name: r.name || undefined,
      price: r.price,
      priceCurrency: r.priceCurrency,
      image: r.image,
      images: r.images,
      aspectValues: r.aspectValues,
      link: r.link,
    }));

    const variantData = Object.assign({}, anchorSv || {}, { variants: variantRows });
    // 源富内容(11254)listing 级:同视频语义,整组变体共用当前页(母体)的富内容。
    // 从 composer 缓存抽(通常零额外请求)注入母体 variantData.attributes —— 编辑页
    // textarea 自动预填,批量导入经 _sourceVariant 由后端统一下发。
    const collectAllRichContent = await ext.jzCollectPageRichContent();
    console.log('[jz-rc][call-batch] collectAll rcLen=', collectAllRichContent.length);
    ext.jzInjectRichContentAttr(variantData, collectAllRichContent);
    const contentCopy = window.JZFollowSellContentCopy;
    const collectAllDescription = contentCopy?.pickFollowSellDescription
      ? contentCopy.pickFollowSellDescription({
          customDescription: '',
          sourceVariant: variantData,
          richContent: collectAllRichContent,
          fallbackName: '',
          max: 4096,
        })
      : '';
    contentCopy?.mergeSourceDescriptionIntoVariant?.(variantData, collectAllDescription);
    contentCopy?.mergeSourceHashtagsIntoVariant?.(variantData, ext.extractKeywords());
    // 跟卖视频 listing 级:整组变体是同一商品的不同规格,共用当前页(母体)视频。抓一次转存,
    // 存进母体采集记录;编辑页 collect-adapter 会把它预填到每个变体行,上架时整组带同一视频。
    setBtn('转存视频…');
    const collectVideoMedia = await window.jzCaptureAndTransferPageVideoMedia((t) => setBtn(t));
    const collectVideoUrl = collectVideoMedia?.videoUrl || null;
    const collectVideoCover = collectVideoMedia?.videoCover || null;
    const s = anchorProduct?.statistics || {};
    const payload = {
      sku: String(anchorRow.sku),
      url: window.location.href,
      name: anchorRow.name || undefined,
      price: anchorRow.price,
      priceCurrency: anchorRow.priceCurrency,
      originalPrice: anchorProduct?.originalPrice != null ? String(anchorProduct.originalPrice) : undefined,
      image: anchorRow.image,
      images: anchorRow.images,
      videoUrl: collectVideoUrl || undefined,
      videoCover: collectVideoCover || undefined,
      variantData,
      sellerName: anchorProduct?.seller?.name || undefined,
      sellerLink: anchorProduct?.seller?.link || undefined,
      soldCount: s.sold_count != null ? s.sold_count : undefined,
      soldSum: s.sold_sum != null ? String(s.sold_sum) : undefined,
      views: s.views != null ? s.views : undefined,
      convViewToOrder: s.conv_view_to_order != null ? String(s.conv_view_to_order) : undefined,
      discount: s.discount != null ? String(s.discount) : undefined,
      gmvSum: s.gmv_sum != null ? String(s.gmv_sum) : undefined,
    };

    // ── 单次推送(母体一行,dedup 按母体 SKU)──
    setBtn('推送中…');
    let created = 0,
      updated = 0,
      failed = 0,
      dedupeHit = false;
    try {
      // forceResubmit:跳过 SW 的 24h SKU dedup。这是用户主动「采集全部变体」,即便母体
      // SKU 此前已被单品采集过(命中 dedup 会早返 result:null、不调后端 upsert),也必须
      // 强制重推,否则 variantData.variants 永远落不进库,合并采集静默失败(P1)。
      const resp = await window.sendMessage('pushSourceCollect', {
        sourceId: 'ozon',
        raw: payload,
        forceResubmit: true,
      });
      dedupeHit = !!resp?.dedupeHit;
      // SW envelope 现不返 created/updated 区分,统一记一次成功。
      created = 1;
    } catch (e) {
      console.error('[ozon-helper] collectAll push failed:', e?.message || e);
      failed = 1;
    }

    // ── 全源采集 v2 推送(字段级 source 标记 + rawBySource + synthesizedItems)──
    // 与上面 pushSourceCollect 并存:旧通道喂采集箱编辑页,新通道喂 admin 全源展示页。
    // 失败不阻塞返回值,只打 warn(旧通道成功就算采集成功)。
    try {
      setBtn('全源推送中…');
      await pushCollectBoxV2FromCollected({
        variants,
        rows,
        sourceMap,
        anchorProduct,
        anchorSku,
        anchorRow,
        collectAllRichContent,
        collectVideoMedia,
        variantData,
        setBtn,
      });
    } catch (e) {
      console.warn('[ozon-helper] collectAll v2 push failed:', e?.message || e);
    }

    return { ok: failed === 0, multiVariant: true, total: variantRows.length, created, updated, failed, dedupeHit };
  }

  // ── 全源采集 v2 推送 ──────────────────────────────────────────────────────────
  async function pushCollectBoxV2FromCollected(ctx) {
    const ext = E();
    const {
      variants,
      rows,
      sourceMap,
      anchorProduct,
      anchorSku,
      anchorRow,
      collectAllRichContent,
      collectVideoMedia,
      variantData,
      setBtn,
    } = ctx;
    const now = Date.now();
    // 字段包装:{ value, source, sourceDetail?, collectedAt }
    const sf = (value, source, sourceDetail) => ({
      value,
      source,
      ...(sourceDetail ? { sourceDetail } : {}),
      collectedAt: now,
    });

    // ── DOM 数据源(PDP 页面元素,listing 级,只采一次)──
    const domProduct = anchorProduct || null;
    let domBreadcrumbs = null;
    let domHashtags = null;
    let domCharacteristics = null;
    let domAspects = null;
    try {
      domBreadcrumbs = ext.extractBreadcrumbs();
    } catch {}
    try {
      domHashtags = ext.extractKeywords();
    } catch {}
    try {
      domCharacteristics = ext.extractCharacteristics();
    } catch {}
    try {
      domAspects = ext.extractAspectVariants();
    } catch {}
    const scrapedDims = ext.parseScrapedDimensionsFromCharacteristics(domCharacteristics || []) || null;

    // ── 每变体 fetchVariantGallery(图册 + 富内容,page-json)──
    // 单变体也跑:当前页 URL 就是 PDP link,page-json 原始响应对 admin 全源展示有价值。
    const galleryMap = new Map(); // sku → string[]
    const richContentMap = new Map(); // sku → string
    const pageJsonRaw = {}; // sku → { endpoint, url, response, gallery, richContent }
    if (rows.length > 0) {
      setBtn?.('抓取变体图册…');
      const BATCH = 3;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (r) => {
            if (!r.link) return;
            try {
              const g = await ext.fetchVariantGallery(r.link);
              const imgs = Array.isArray(g.images) ? g.images : [];
              if (imgs.length) galleryMap.set(r.sku, imgs);
              if (g.richContent) richContentMap.set(r.sku, g.richContent);
              pageJsonRaw[r.sku] = {
                endpoint: g.endpoint || 'entrypoint-api',
                url: r.link,
                gallery: imgs,
                richContent: g.richContent || '',
              };
            } catch (e) {
              console.warn('[ozon-helper] v2 gallery err for', r.sku, e?.message || e);
            }
          })
        );
      }
    }

    // ── 组装 CollectedVariant[](每变体一条,字段级 source 标记)──
    const collectedVariants = rows.map((r) => {
      const sku = String(r.sku);
      const sv = r.sv || sourceMap.get(sku)?._sourceVariant || null;
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(sv) : null;
      const gallery = galleryMap.get(sku) || [];
      const richContent = richContentMap.get(sku) || '';
      const isAnchor = sku === anchorSku;
      const aspectVariant = variants.find((v) => String(v.sku) === sku) || {};

      // 名称:sv 4180 > DOM title(翻译检测)
      const svName = svCat?.name || '';
      const domName = r.name || aspectVariant.title || '';
      const nameVal = window.jzPreferSourceName ? window.jzPreferSourceName(svName, domName) : domName || svName;
      const nameSource =
        svName && window.jzPreferSourceName && /[一-龥]/.test(domName) && !/[一-龥]/.test(svName)
          ? 'seller-portal'
          : 'dom';

      // 图片:page-json gallery > sv 4194/4195 > DOM coverImage
      let imagesVal = gallery;
      let imagesSource = 'page-json';
      let imageSource = 'pageState';
      if (!imagesVal.length && r.images?.length) {
        imagesVal = r.images;
        imagesSource = 'seller-portal';
        imageSource = 'sourceVariant';
      }
      if (!imagesVal.length && r.image) {
        imagesVal = [r.image];
        imagesSource = 'dom';
        imageSource = 'coverImage';
      }
      if (!imagesVal.length) {
        imagesVal = [];
        imagesSource = 'dom';
        imageSource = 'none';
      }

      const cv = {
        sku: sf(sku, 'dom', 'URL 正则 /product/.*-(\\d{5,})'),
        url: sf(r.link || '', 'dom'),
        isAnchor,
        name: sf(
          nameVal,
          nameSource,
          nameSource === 'seller-portal' ? 'sv.attributes[4180]' : 'aria-label/alt/textContent'
        ),
        brand: sf(
          svCat?.brand || domProduct?.brand || null,
          svCat?.brand ? 'seller-portal' : 'dom',
          svCat?.brand ? 'sv.attributes[85]' : 'extractProductData'
        ),
        categoryPath: sf(sv?.categories || [], 'seller-portal', 'sv.categories'),
        descriptionCategoryId: sf(sv?.description_category_id || null, 'seller-portal'),
        price: sf(aspectVariant.priceRub || aspectVariant.price || 0, aspectVariant.priceRub ? 'ssr-aspects' : 'dom'),
        priceCurrency: sf(aspectVariant.priceCurrency || 'CNY', 'computed', '_detectCurrencyFromPriceStr'),
        priceRub: sf(aspectVariant.priceRub || 0, 'computed'),
        priceCny: sf(aspectVariant.price || 0, 'computed', '_rubToCny'),
        oldPrice: sf(domProduct?.originalPrice || 0, 'dom'),
        discount: sf(domProduct?.statistics?.discount || 0, 'computed'),
        mainImage: sf(
          svCat?.mainImage || r.image || domProduct?.mainImage || '',
          svCat?.mainImage ? 'seller-portal' : 'dom',
          svCat?.mainImage ? 'sv.attributes[4194]' : '<img src>'
        ),
        images: sf(
          imagesVal,
          imagesSource,
          imagesSource === 'page-json'
            ? 'fetchVariantGallery widgetStates'
            : imagesSource === 'seller-portal'
              ? 'sv.attributes[4195]'
              : 'coverImage'
        ),
        imageSource: sf(imageSource, 'computed'),
        videoUrl: sf(collectVideoMedia?.videoUrl || null, 'video-transcode', 'SW uploadFollowSellVideo'),
        videoCover: sf(collectVideoMedia?.videoCover || null, 'video-transcode'),
        weight: sf(svCat?.weightG || null, 'seller-portal', 'sv.attributes[4497]||sv[4383]'),
        depth: sf(svCat?.depthMm || null, 'seller-portal', 'sv.attributes[9454]'),
        width: sf(svCat?.widthMm || null, 'seller-portal', 'sv.attributes[9455]'),
        height: sf(svCat?.heightMm || null, 'seller-portal', 'sv.attributes[9456]'),
        gtin: sf(svCat?.gtin || null, 'seller-portal', 'sv.attributes[7822]'),
        richContent: sf(
          richContent || collectAllRichContent || null,
          richContent ? 'page-json' : collectAllRichContent ? 'page-json' : 'computed',
          richContent ? 'fetchVariantGallery' : 'jzCollectPageRichContent'
        ),
        breadcrumbs: sf(domBreadcrumbs || null, 'dom', 'extractBreadcrumbs'),
        hashtags: sf(domHashtags || null, 'dom', 'extractKeywords/webHashtags'),
        scrapedDims: sf(scrapedDims, 'dom', 'extractCharacteristics'),
        aspectValues: sf(r.aspectValues || aspectVariant.aspectValues || {}, 'ssr-aspects'),
        sourceVariant: sf(sv || null, 'seller-portal', 'searchVariants picked'),
        bundleComplexAttrs: sf(sv?._bundleComplexAttrs || null, 'seller-portal', 'sv._bundleComplexAttrs'),
      };

      // 母体才有的统计 + 卖家信息
      if (isAnchor && domProduct) {
        const st = domProduct.statistics || {};
        cv.statistics = {
          soldCount: sf(st.sold_count ?? null, 'dom', 'extractProductData.statistics'),
          soldSum: sf(st.sold_sum ?? null, 'dom'),
          views: sf(st.views ?? null, 'dom'),
          convViewToOrder: sf(st.conv_view_to_order ?? null, 'dom'),
          gmvSum: sf(st.gmv_sum ?? null, 'dom'),
        };
        cv.seller = {
          name: sf(domProduct.seller?.name || null, 'dom'),
          link: sf(domProduct.seller?.link || null, 'dom'),
        };
      }
      return cv;
    });

    // ── 组装 rawBySource(5 类数据源原始响应)──
    const sellerPortalRaw = {};
    for (const [sku, distilled] of sourceMap.entries()) {
      sellerPortalRaw[sku] = {
        pickedSv: distilled?._sourceVariant || null,
        searchResponse: distilled?._searchMeta || null,
        bundleResponse: distilled?._bundleMeta || null,
      };
    }
    const rawBySource = {
      dom: {
        productData: domProduct,
        breadcrumbs: domBreadcrumbs,
        hashtags: domHashtags,
        characteristics: domCharacteristics,
        aspectVariants: domAspects,
      },
      sellerPortal: sellerPortalRaw,
      pageJson: pageJsonRaw,
      ssrAspects: { mergedVariants: variants },
      videoTranscode: {
        originalMp4Url: collectVideoMedia?.videoUrl || null,
        transferredVideoUrl: collectVideoMedia?.videoUrl || null,
        transferredCoverUrl: collectVideoMedia?.videoCover || null,
      },
    };

    // ── 推送后端 POST /ozon/collect-box/v2 ──
    await window.sendMessage('pushCollectBoxV2', {
      anchorSku: String(anchorSku || anchorRow?.sku || ''),
      sourcePageUrl: window.location.href,
      collectSource: '详情页一键采集',
      variants: collectedVariants,
      rawBySource,
      collectedAt: now,
    });
  }

  // ── 单品采集 ──────────────────────────────────────────────────────────────────
  // 抽自原 collectBtn click handler，便于 popup 远程触发同一逻辑
  async function performProductCollect() {
    const ext = E();
    // 采集流程对 SW composer-api 缓存的依赖现在是**软依赖**:DOM + JSON-LD + og:meta
    // 一般能独立拿全(7 层 fallback)。所以策略改:
    //   1. 先 sync 跑 extractProductData
    //   2. 三个必填字段都有 → 跳过 SW 缓存等待,直接 proceed
    //   3. 缺字段 → 才 await ensurePdpState(限 3s),再次提取
    //
    // 旧策略 `await ensurePdpState()` 无脑等(无超时)— 实测 SW
    // fetchProductPageState 偶发 hang 60s(Ozon 2026 反爬 + Chrome MV3
    // scripting.executeScript MAIN world 注入路径 race),阻塞用户感知的"采集中..."。
    // 新策略让健康 PDP 页采集**< 50ms 完成**,Ozon DOM 全剥离的极端情况才付 3s 等待。
    let product = ext.extractProductData();
    let hasTitle = !!(product?.title && product.title.trim());
    let hasImages = Array.isArray(product?.images) && product.images.length > 0;
    let hasSku = !!(product?.sku || product?.productId);

    // DOM 数据不全才等 SW 缓存预热兜底
    if ((!hasTitle || !hasImages || !hasSku) && window.ensurePdpState) {
      try {
        await Promise.race([window.ensurePdpState(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      } catch {
        /* noop */
      }
      product = ext.extractProductData();
      hasTitle = !!(product?.title && product.title.trim());
      hasImages = Array.isArray(product?.images) && product.images.length > 0;
      hasSku = !!(product?.sku || product?.productId);
    }

    // 防御:Ozon DOM 改版 / composer-api 也挂时,product 关键字段全空 →
    // 查 detail 缓存(IndexedDB+MongoDB)兜底,用历史静态字段救场。
    // 缓存也 miss 时才抛清晰错误,避免下游送给 backend 一个 sku/name 都空的 payload。
    if (!hasTitle || !hasImages || !hasSku) {
      // 从 URL 提取 sku 作为查 cache 的 key(/product/{slug}-{sku}/)
      const _urlSku = (window.location.pathname.match(/-(\d{5,})\/?$/) || [])[1] || product?.sku || '';
      if (_urlSku && window.sendMessage) {
        try {
          const cacheResp = await window.sendMessage('domCacheGet', { sku: String(_urlSku), type: 'detail' });
          const cached = cacheResp?.ok ? cacheResp.data : null;
          if (cached) {
            // 用缓存的静态字段补全 product(动态字段保持当前 DOM 解析值,可能为空)
            if (!hasTitle && cached.title) {
              product.title = cached.title;
              hasTitle = true;
            }
            if (!hasImages && Array.isArray(cached.images) && cached.images.length) {
              product.images = cached.images;
              hasImages = true;
            }
            if (!hasSku && cached.sku) {
              product.sku = cached.sku;
              hasSku = true;
            }
            if (!product.productId && cached.productId) product.productId = cached.productId;
            if (!product.brand && cached.brand) product.brand = cached.brand;
            if (!product.category && cached.category) product.category = cached.category;
            if (!product.characteristics && cached.characteristics) product.characteristics = cached.characteristics;
            if (!product.videos && cached.videos) product.videos = cached.videos;
            console.log('[ozon-helper] detail 缓存兜底命中,补全静态字段 sku=' + _urlSku);
          }
        } catch {
          /* 缓存查询失败,继续走原错误流程 */
        }
      }
    }

    // 动态字段兜底:price/seller/statistics 等动态字段为空时,查 detail 缓存
    // 跟静态字段兜底独立,允许只缺动态字段的场景单独命中
    if (product?.sku && window.sendMessage) {
      const _needDynamicFallback = !product.price && !product.seller?.name && !product.statistics?.sold_count;
      if (_needDynamicFallback) {
        try {
          const dynResp = await window.sendMessage('domCacheGet', { sku: String(product.sku), type: 'detail' });
          const dynCached = dynResp?.ok ? dynResp.data : null;
          if (dynCached) {
            if (!product.price && dynCached.price) product.price = dynCached.price;
            if (!product.walletPrice && dynCached.walletPrice) product.walletPrice = dynCached.walletPrice;
            if (!product.originalPrice && dynCached.originalPrice) product.originalPrice = dynCached.originalPrice;
            if (!product.seller?.name && dynCached.seller?.name) product.seller = dynCached.seller;
            if (!product.statistics && dynCached.statistics) product.statistics = dynCached.statistics;
            if (!product.freeRest && dynCached.freeRest) product.freeRest = dynCached.freeRest;
            if (!product.followSellCount && dynCached.followSellCount)
              product.followSellCount = dynCached.followSellCount;
            if (!product.followSellMinPrice && dynCached.followSellMinPrice)
              product.followSellMinPrice = dynCached.followSellMinPrice;
            if (!product.deliveryMode && dynCached.deliveryMode) product.deliveryMode = dynCached.deliveryMode;
            if (!product.rating && dynCached.rating) product.rating = dynCached.rating;
            if (!product.reviewCount && dynCached.reviewCount) product.reviewCount = dynCached.reviewCount;
            console.log('[ozon-helper] detail 缓存兜底命中,补全动态字段 sku=' + product.sku);
          }
        } catch {
          /* 动态缓存查询失败,忽略 */
        }
      }
    }

    // 缓存兜底后仍缺关键字段 → 抛清晰错误
    if (!hasTitle || !hasImages || !hasSku) {
      const missing = [!hasTitle ? '标题' : null, !hasImages ? '图片' : null, !hasSku ? 'SKU' : null]
        .filter(Boolean)
        .join(' / ');
      // 详细诊断:打出 product 对象关键字段,便于 devtools console 看根因。
      // 用 warn 在 production build.js 里会被 DCE,只有 dev 模式才打。
      console.warn('[ozon-helper] 采集 validation 失败 — product 字段诊断:', {
        missing,
        titleLen: product?.title?.length || 0,
        titlePreview: (product?.title || '').slice(0, 40),
        imagesType: Array.isArray(product?.images) ? `array len=${product.images.length}` : typeof product?.images,
        sku: product?.sku || '(empty)',
        productId: product?.productId || '(empty)',
        url: window.location.href,
      });
      throw new Error(`采集失败:页面解析缺 ${missing}(Ozon 改版?刷新重试)`);
    }
    try {
      ext.logProductSummary(product, ext.extractBreadcrumbs(), ext.extractCharacteristics(), '');
    } catch (e) {
      console.warn('[ozon-helper] logProductSummary threw:', e?.message);
      throw e;
    }

    const variantPromise = product.sku
      ? window.sendMessage('searchVariants', { sku: product.sku }).catch(() => null)
      : Promise.resolve(null);

    const variantResp = await variantPromise;
    const variantItems = variantResp?.items || variantResp?.data?.items || [];
    const variantMatch = variantItems.find((it) => String(it.variant_id) === product.sku) || variantItems[0] || null;

    if (variantMatch) {
      console.log(
        `[ozon-helper] collectProduct: searchVariants found variant_id=${variantMatch.variant_id}, images=${variantMatch.images?.length || 0}, attrs=${variantMatch.attributes?.length || 0}`
      );
    }

    // 跟卖式 catalog 抽取:name/images 切成 sv(search+bundle)优先,DOM 兜底。
    // statistics / price / seller 仍走 DOM(seller-portal 接口不返回)。
    const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
    const collectName = window.jzPreferSourceName
      ? window.jzPreferSourceName(svCat?.name, product.title)
      : product.title || svCat?.name || '';
    const collectImages = (svCat?.images?.length ? svCat.images : product.images) || [];
    const collectMainImage = svCat?.mainImage || product.images?.[0] || ext.getMainImageUrl(product) || undefined;

    // 跟卖视频:抓当前 PDP 视频转存成卖家自有 Ozon 视频,随采集存进采集箱;上架时自动带视频。
    const collectVideoMedia = await window.jzCaptureAndTransferPageVideoMedia();
    const collectVideoUrl = collectVideoMedia?.videoUrl || null;
    const collectVideoCover = collectVideoMedia?.videoCover || null;

    // 源富内容(11254):composer 缓存抽取注入 variantData(searchVariants 失败也会
    // 新建 {attributes} 兜底),编辑页预填 + 上架经 _sourceVariant 下发。
    const collectRichContent = await ext.jzCollectPageRichContent();
    console.log('[jz-rc][call-single] collect rcLen=', collectRichContent.length);
    let collectVariantData = ext.jzInjectRichContentAttr(variantMatch, collectRichContent);
    const contentCopy = window.JZFollowSellContentCopy;
    const collectDescription = contentCopy?.pickFollowSellDescription
      ? contentCopy.pickFollowSellDescription({
          customDescription: '',
          sourceVariant: collectVariantData || variantMatch,
          richContent: collectRichContent,
          fallbackName: '',
          max: 4096,
        })
      : '';
    collectVariantData = contentCopy?.mergeSourceDescriptionIntoVariant
      ? contentCopy.mergeSourceDescriptionIntoVariant(collectVariantData || variantMatch || {}, collectDescription)
      : collectVariantData;
    const collectHashtags = ext.extractKeywords();
    contentCopy?.mergeSourceHashtagsIntoVariant?.(collectVariantData, collectHashtags);
    const collectForceResubmit = contentCopy?.shouldForceCollectRefresh
      ? contentCopy.shouldForceCollectRefresh({
          videoUrl: collectVideoUrl,
          videoCover: collectVideoCover,
          description: collectDescription,
          richContent: collectRichContent,
          hashtags: collectHashtags,
        })
      : !!(collectVideoUrl || collectVideoCover);

    const collectPayload = {
      sku: product.sku,
      url: product.url,
      name: collectName || product.title,
      price: product.price != null ? String(product.price) : undefined,
      // 页面币种(CNY/RUB)随价上传 — 后端 provider 据此决定是否 ×汇率,
      // 修跨境店人民币价被当卢布砍 ~12 倍的 bug。探测不到则留空(后端默认按 RUB)。
      priceCurrency: ext.detectPageCurrency() || undefined,
      originalPrice: product.originalPrice != null ? String(product.originalPrice) : undefined,
      image: collectMainImage,
      images: collectImages.length ? collectImages : undefined,
      videoUrl: collectVideoUrl || undefined,
      videoCover: collectVideoCover || undefined,
      variantData: collectVariantData || undefined,
      sellerName: product.seller?.name || undefined,
      sellerLink: product.seller?.link || undefined,
      soldCount: product.statistics?.sold_count != null ? product.statistics.sold_count : undefined,
      soldSum: product.statistics?.sold_sum != null ? String(product.statistics.sold_sum) : undefined,
      views: product.statistics?.views != null ? product.statistics.views : undefined,
      convViewToOrder:
        product.statistics?.conv_view_to_order != null ? String(product.statistics.conv_view_to_order) : undefined,
      discount: product.statistics?.discount != null ? String(product.statistics.discount) : undefined,
      gmvSum: product.statistics?.gmv_sum != null ? String(product.statistics.gmv_sum) : undefined,
    };
    // Push via the multi-source endpoint so the row is tagged sourceId='ozon'.
    // SW 在 ok:false 时让 sendMessage 直接 reject(被外层 catch);ok:true 时
    // sendMessage wrapper resolve(response.data),所以这里 resp = SW envelope 的 data
    // 字段,SW 已统一为 { dedupeHit, lastAt, result }(c55083b ENVELOPE_FIX)。
    // 不要再检查 resp.ok — 那是 envelope fix 之前 SW 平铺返回的残留,resp 现在不再有 ok。
    // forceResubmit:视频/简介/富内容/标签任一存在时强制重推 —— 否则 24h dedupe
    // 命中会早返不调后端 upsert,旧采集记录里的空简介不会被新提取结果覆盖。
    const resp = await window.sendMessage('pushSourceCollect', {
      sourceId: 'ozon',
      raw: collectPayload,
      forceResubmit: collectForceResubmit,
    });

    // ── 全源采集 v2 推送(字段级 source 标记 + rawBySource + synthesizedItems)──
    // 单 SKU 商品也走 v2 通道,与多变体路径(collectAllVariants L1674)保持一致。
    // 失败不阻塞返回值,只打 warn(旧通道成功就算采集成功)。
    try {
      // pushCollectBoxV2FromCollected 内部用 setBtn?.() 更新按钮文案,本路径无按钮引用,传 noop。
      const setBtn = () => {};
      const _anchorSku = String(product.sku || product.productId || '');
      const _row = {
        sku: _anchorSku,
        sv: variantMatch,
        name: collectName || product.title || '',
        image: collectMainImage,
        images: collectImages.length ? collectImages : undefined,
        link: product.url || window.location.href,
        aspectValues: undefined,
      };
      const _sourceMap = new Map();
      if (_anchorSku) {
        _sourceMap.set(_anchorSku, {
          _sourceVariant: variantMatch || null,
          _searchMeta: variantResp || null,
          _bundleMeta: null,
        });
      }
      // 单 SKU 兜底:补全 price/priceRub/priceCurrency(对齐 toggleFollowSellPanel
      // 单变体兜底分支 line 11246-11255 的币种处理),避免 aspectVariants 为空时
      // pushCollectBoxV2FromCollected 内 line 1814 取不到 price 导致 price=0。
      const _rawPrice = product.price || 0;
      const _srcCurrency = ext.detectPageCurrency();
      const _isRub = _srcCurrency === 'RUB';
      await pushCollectBoxV2FromCollected({
        variants: [
          {
            sku: _anchorSku,
            title: collectName || product.title || '',
            price: _isRub ? ext.rubToCny(_rawPrice) : _rawPrice,
            priceRub: _isRub ? _rawPrice : 0,
            priceCurrency: _isRub ? 'CNY' : _srcCurrency || 'CNY',
            coverImage: collectMainImage,
            link: product.url || window.location.href,
            aspectValues: {},
          },
        ],
        rows: [_row],
        sourceMap: _sourceMap,
        anchorProduct: product,
        anchorSku: _anchorSku,
        anchorRow: _row,
        collectAllRichContent: collectRichContent,
        collectVideoMedia: collectVideoMedia,
        variantData: collectVariantData || variantMatch || {},
        setBtn,
      });
    } catch (e) {
      console.warn('[ozon-helper] performProductCollect v2 push failed:', e?.message || e);
    }

    return { ok: true, dedupeHit: !!resp?.dedupeHit, lastAt: resp?.lastAt || null, result: resp?.result || null };
  }

  // ── 暴露给 ozon-product.js 的按钮 click handler / popup 调用 ──
  window.__jzPdpCollect = { collectAllVariants, performProductCollect };

  // ── onMessage listener:处理 popup 远程触发采集 ──
  // 跟 action bar 一键采集一致:采当前商品所有变体合并成一条记录(popup 消费方
  // 只看 resp.ok,ok=true 时会把该 URL 标记为已采集并移出列表)。母体单次 push 失败
  // (failed>0)必须返回 ok:false,否则失败被隐藏、URL 被永久移出待采列表。
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'triggerCollectFromPopup') {
      collectAllVariants()
        .then((r) => {
          const ok = r?.multiVariant ? r.total > 0 && !r.failed : true;
          sendResponse({
            ok,
            multiVariant: !!r?.multiVariant,
            total: r?.total ?? null,
            failed: r?.failed ?? 0,
            dedupeHit: !!r?.dedupeHit,
            lastAt: r?.lastAt || null,
            error: ok ? undefined : '全部变体采集失败',
          });
        })
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true; // 异步 sendResponse
    }
    return false;
  });
})();
