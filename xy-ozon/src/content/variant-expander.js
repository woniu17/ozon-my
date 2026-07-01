// ──────────────────────────────────────────────────────────────
// variant-expander.js —— 多变体展开(Phase 0 弹窗补全 + Phase A SSR 多轴展开)
// 对齐 0.13 ozon-product.js:745-848(jzFetchAspectsModalVariants + jzExpandVariantsViaModal)
//        0.13 ozon-product.js:10200-10245(Phase A SSR 多轴展开)
//
// 为什么需要:Ozon 商品页内联只展示 ~6 个变体,其余在「Все N цветов」弹窗懒加载;
// 多轴(色×码)商品每轴只列与当前 SKU 共享其他维度的变体,6色×8码只能看到 13 unique SKU,
// 真实 model 可达 48。需要 fetch 弹窗 + SSR 色页才能拿全。
// ──────────────────────────────────────────────────────────────
(function () {
  'use strict';

  if (self.JZVariantExpander) return; // 防重入

  // 复用 product-extractor.js 的 extractRawAspects(单一数据源,避免重复定义)
  const extractRawAspects = () => self.JZProductExtractor?.extractRawAspects?.() || [];

  // ────────────────────────────────────────────────────────────
  // fetchAspectsModalVariants —— fetch 弹窗链接,提取全部变体
  // 对齐 0.13 jzFetchAspectsModalVariants(745-812)
  // ────────────────────────────────────────────────────────────
  async function fetchAspectsModalVariants(modalLink) {
    if (!modalLink || typeof modalLink !== 'string') return [];
    let path = modalLink;
    try {
      if (/^https?:\/\//i.test(path)) {
        const u = new URL(path);
        path = u.pathname + u.search;
      }
    } catch {}
    if (!path.startsWith('/')) path = '/' + path;

    const endpoints = [
      `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
      `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
    ];
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const states = data?.widgetStates || {};
        const seen = new Set();
        const rows = [];
        for (const k of Object.keys(states)) {
          let v = states[k];
          if (typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              continue;
            }
          }
          if (!v || !Array.isArray(v.aspects)) continue;
          for (const aspect of v.aspects) {
            const aspectName = aspect.aspectName || '';
            for (const av of aspect.variants || []) {
              const sku = String(av.sku || '');
              if (!sku || seen.has(sku)) continue;
              seen.add(sku);
              const d = av.data || {};
              const text = d.searchableText || (d.textRs || []).map((t) => t.content).join('') || '';
              rows.push({
                sku,
                title: d.title || '',
                price: d.price || '',
                coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
                link: av.link || '',
                availability: av.availability || 'unknown',
                active: av.active === true,
                aspectValues: aspectName && text ? { [aspectName]: text } : {},
              });
            }
          }
        }
        if (rows.length > 0) return rows;
      } catch (e) {
        console.warn('[variant-expander] aspectsModal fetch failed', url, e?.message);
      }
    }
    return [];
  }

  // ────────────────────────────────────────────────────────────
  // expandVariantsViaModal —— Phase 0:弹窗补全(单轴多值,如 38 色)
  // 对齐 0.13 jzExpandVariantsViaModal(819-848)
  // 若某 aspect 的 aspectModalInfo.realNumberOfVariants > 已采变体数 → 拉弹窗补全
  // ────────────────────────────────────────────────────────────
  async function expandVariantsViaModal(variants, rawAspects) {
    try {
      let best = null;
      for (const a of rawAspects || []) {
        const mi = a?.aspectModalInfo;
        const link = mi?.link;
        const total = parseInt(mi?.realNumberOfVariants, 10);
        if (link && Number.isFinite(total) && total > variants.length) {
          if (!best || total > best.total) best = { link, total };
        }
      }
      if (!best) return variants;

      const modalRows = await fetchAspectsModalVariants(best.link);
      if (modalRows.length === 0) {
        console.warn(`[variant-expander] aspect modal 拉取为空,保留内联 ${variants.length} 个变体(目标 ${best.total})`);
        return variants;
      }
      const map = new Map(variants.map((v) => [String(v.sku), v]));
      for (const r of modalRows) if (!map.has(r.sku)) map.set(r.sku, r);
      const merged = Array.from(map.values());
      console.log(`[variant-expander] Phase 0 弹窗补全:内联 ${variants.length} → ${merged.length}(弹窗 ${modalRows.length},目标 ${best.total})`);
      return merged;
    } catch (e) {
      console.warn('[variant-expander] expandVariantsViaModal err', e?.message);
      return variants;
    }
  }

  // ────────────────────────────────────────────────────────────
  // expandVariantsViaSSR —— Phase A:多轴 SSR 展开
  // 对齐 0.13 ozon-product.js:10200-10245
  //
  // 多轴(色×码)商品每轴只列与当前 SKU 共享其他维度的变体,
  // 6色×8码只能看到 13 unique SKU。挑最小轴 pivot iterate,
  // fetch 每个非当前 pivot variant 的 link 页 SSR HTML,
  // DOMParser 提 [data-state].aspects union 进 variantMap。
  //
  // 为什么走 SSR HTML 而非 composer-api:2026-05-26 验证 composer-api 全 403,Ozon 已 deprecate。
  // ────────────────────────────────────────────────────────────
  async function expandVariantsViaSSR(rawAspects, currentSku, variants) {
    // 门挡:只有真多轴(≥2 轴)+ 多变体才展开
    if (!Array.isArray(rawAspects) || rawAspects.length < 2) return variants;
    if (!Array.isArray(variants) || variants.length <= 1) return variants;
    if (!currentSku) return variants;

    try {
      // 取最小轴作 pivot(fetch 次数最少)
      const sortedAxes = [...rawAspects].sort((a, b) => (a.variants?.length || 0) - (b.variants?.length || 0));
      const pivotAxis = sortedAxes[0];
      const linksToFetch = (pivotAxis?.variants || [])
        .filter((v) => v && String(v.sku) !== currentSku && v.link)
        .slice(0, 8) // 最多 fetch 8 页,避免过度请求
        .map((v) => ({ sku: String(v.sku), link: v.link }));

      if (linksToFetch.length === 0) return variants;

      const variantMap = new Map(variants.map((v) => [String(v.sku), v]));

      for (let i = 0; i < linksToFetch.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1200)); // 1.2s 间隔,避免反爬
        const target = linksToFetch[i];
        try {
          const resp = await fetch(target.link, {
            credentials: 'include',
            headers: { accept: 'text/html,application/xhtml+xml' },
          });
          if (!resp.ok) continue;
          const html = await resp.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');

          // 提 [data-state].aspects union 进 variantMap
          const stateEls = doc.querySelectorAll('[data-state]');
          for (const el of stateEls) {
            try {
              const raw = el.getAttribute('data-state');
              if (!raw || raw.length < 20) continue;
              const data = JSON.parse(raw);
              if (!data || !Array.isArray(data.aspects)) continue;
              for (const aspect of data.aspects) {
                for (const av of aspect.variants || []) {
                  const sku = String(av.sku || '');
                  if (!sku || variantMap.has(sku)) continue;
                  const d = av.data || {};
                  variantMap.set(sku, {
                    sku,
                    title: d.title || '',
                    price: d.price || '',
                    coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
                    link: av.link || '',
                    availability: av.availability || 'unknown',
                    active: av.active === true,
                  });
                }
              }
            } catch {}
          }
        } catch (e) {
          console.warn(`[variant-expander] SSR fetch 失败 ${target.sku}:`, e?.message);
        }
      }

      const expanded = Array.from(variantMap.values());
      if (expanded.length > variants.length) {
        console.log(`[variant-expander] Phase A SSR 展开:${variants.length} → ${expanded.length}(fetch ${linksToFetch.length} 页)`);
      }
      return expanded;
    } catch (e) {
      console.warn('[variant-expander] expandVariantsViaSSR err', e?.message);
      return variants;
    }
  }

  // ────────────────────────────────────────────────────────────
  // expandVariants —— 统一入口
  // 先用已有 variants(来自 extractVariantSkus),再 Phase 0 弹窗补全,再 Phase A SSR 展开
  // 返回展开后的 variants 数组(失败时原样返回,不阻断)
  // ────────────────────────────────────────────────────────────
  async function expandVariants(variants, productData) {
    let result = Array.isArray(variants) ? variants : [];
    const currentSku = String(productData?.sku || '');
    const rawAspects = extractRawAspects();

    // Phase 0:弹窗补全(单轴多值,如 38 色)
    if (rawAspects.length > 0) {
      result = await expandVariantsViaModal(result, rawAspects);
    }

    // Phase A:多轴 SSR 展开(≥2 轴才触发)
    if (rawAspects.length >= 2 && result.length > 1 && currentSku) {
      result = await expandVariantsViaSSR(rawAspects, currentSku, result);
    }

    return result;
  }

  self.JZVariantExpander = {
    extractRawAspects,
    fetchAspectsModalVariants,
    expandVariantsViaModal,
    expandVariantsViaSSR,
    expandVariants,
  };
})();
