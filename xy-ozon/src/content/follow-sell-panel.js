// 跟卖面板 UI + 提交逻辑 —— 精简版,保留核心配置项与全流程编排。
// 对齐原项目 createMultiVariantFollowSellPanel / handleMultiVariantFollowSell,
// 去掉多变体/批量/水印/AI重写等复杂项,聚焦 viaPortal=true 核心链路。
// 含「抓取数据预览」区:展示 Phase 2 页面数据 + Phase 3 变体数据。

(function () {
  'use strict';

  console.log('[FollowSell] 脚本加载 v2026-07-01-fix6 (import/info 固定结果区)');

  const contentCopy = self.JZFollowSellContentCopy;

  // ────────────────────────────────────────────────────────────
  // 消息发送(封装 chrome.runtime.sendMessage)
  // ────────────────────────────────────────────────────────────
  function sendMessage(type, data = {}) {
    return new Promise((resolve, reject) => {
      // chrome.runtime 可能在扩展重载/页面导航时序中短暂 undefined
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error('chrome.runtime 不可用(扩展可能正在重载)'));
        return;
      }
      chrome.runtime.sendMessage({ type, ...data }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  // 配置中心缓存(P1-2:启动时从 ERP 拉取 extension scope 配置替换硬编码)
  // ────────────────────────────────────────────────────────────
  let __extConfigCache = null;
  async function fetchExtensionConfig() {
    if (__extConfigCache) return __extConfigCache;
    try {
      const resp = await sendMessage('getConfig', { query: { scope: 'extension' } });
      // resp.data 形如 { data: {key: value}, items: [...] };只取字典
      __extConfigCache = resp?.data?.data || {};
    } catch (e) {
      console.warn('[FollowSell] 拉取配置中心失败,使用内置默认值:', e?.message || e);
      __extConfigCache = {};
    }
    return __extConfigCache;
  }

  // ────────────────────────────────────────────────────────────
  // 水印模板(P3:模板存后端,Canvas 渲染在插件端)
  // ────────────────────────────────────────────────────────────
  let __watermarkTemplatesCache = null;
  async function fetchWatermarkTemplates() {
    if (__watermarkTemplatesCache) return __watermarkTemplatesCache;
    try {
      const resp = await sendMessage('getWatermarkTemplates', {});
      // resp.data 形如 [{ id, name, config, isDefault }]
      const list = resp?.data?.data || resp?.data || [];
      __watermarkTemplatesCache = Array.isArray(list) ? list : [];
    } catch (e) {
      console.warn('[FollowSell] 拉取水印模板失败:', e?.message || e);
      __watermarkTemplatesCache = [];
    }
    return __watermarkTemplatesCache;
  }

  // 填充水印模板下拉框(替换硬编码的 tpl-1 单选项)
  async function populateWatermarkTemplates(panel) {
    const select = panel.querySelector('[data-field="watermark-template-id"]');
    if (!select) return;
    const templates = await fetchWatermarkTemplates();
    if (!templates.length) return;
    const defaultId = templates.find((t) => t.isDefault)?.id || templates[0].id;
    select.innerHTML =
      '<option value="">不使用水印</option>' +
      templates
        .map(
          (t) =>
            `<option value="${esc(String(t.id))}"${t.id === defaultId ? ' selected' : ''}>${esc(t.name || `模板${t.id}`)}</option>`
        )
        .join('');
  }

  // Canvas 渲染水印到单张图片,返回 data URL
  // tplConfig: { text, position, opacity, fontSize, color, bgColor, padding }
  async function applyWatermarkToImageUrl(url, tplConfig) {
    if (!tplConfig || !tplConfig.text) return null;
    // 跨域图片走 service worker 抓取为 data URL,避免 Canvas 污染
    let dataUrl = url;
    if (/^https?:\/\//i.test(url)) {
      const resp = await sendMessage('fetchImageAsDataUrl', { url });
      if (!resp?.ok || !resp?.dataUrl) {
        console.warn('[Watermark] 抓取图片失败,跳过:', url);
        return null;
      }
      dataUrl = resp.dataUrl;
    }
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // 水印参数
    const cfg = tplConfig;
    const fontSize = Math.max(12, Number(cfg.fontSize) || 24);
    const padding = Math.max(2, Number(cfg.padding) || 8);
    const opacity = Math.min(1, Math.max(0, Number(cfg.opacity ?? 0.5)));
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';
    const text = String(cfg.text);
    const metrics = ctx.measureText(text);
    const tw = Math.ceil(metrics.width);
    const th = Math.ceil(fontSize * 1.2);
    // 定位
    let x = padding;
    let y = padding;
    const pos = String(cfg.position || 'bottom-right');
    if (pos === 'top-right') x = canvas.width - tw - padding;
    else if (pos === 'bottom-left') y = canvas.height - th - padding;
    else if (pos === 'bottom-right') {
      x = canvas.width - tw - padding;
      y = canvas.height - th - padding;
    } else if (pos === 'center') {
      x = Math.floor((canvas.width - tw) / 2);
      y = Math.floor((canvas.height - th) / 2);
    }
    // 背景色块
    if (cfg.bgColor) {
      ctx.fillStyle = cfg.bgColor;
      ctx.fillRect(x - padding / 2, y - padding / 2, tw + padding, th + padding);
    }
    ctx.fillStyle = cfg.color || '#ffffff';
    ctx.fillText(text, x, y);
    ctx.restore();
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  // ────────────────────────────────────────────────────────────
  // 灰度 flag(5min 缓存,对齐原项目 isPortalImportEnabled)
  // ────────────────────────────────────────────────────────────
  let __portalFlagCache = null;
  async function isPortalImportEnabled() {
    try {
      const now = Date.now();
      if (__portalFlagCache && now - __portalFlagCache.at < 5 * 60 * 1000) return __portalFlagCache.on;
      const flags = await sendMessage('getFeatureFlags', {});
      const on = !!(flags && flags.data && flags.data['ozon_portal_import'] === true);
      __portalFlagCache = { at: now, on };
      return on;
    } catch {
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 会员配额校验(对齐原项目 evaluateListingQuota)
  // ────────────────────────────────────────────────────────────
  function evaluateListingQuota(summary, itemCount) {
    if (!summary) return { blocked: false };
    const cap = summary.caps?.listing || Infinity;
    const used = summary.usage?.listing || 0;
    if (used + itemCount > cap) {
      return { blocked: true, message: `配额不足:已用 ${used}/${cap},本次需 ${itemCount}` };
    }
    return { blocked: false };
  }

  // ────────────────────────────────────────────────────────────
  // 数据预览渲染工具
  // ────────────────────────────────────────────────────────────

  // HTML 转义,防 XSS
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 截断长文本
  function truncate(s, max) {
    const str = String(s ?? '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  // 把 sourceVariant 的 attributes[] 转成 {key: value} 映射,便于表格展示
  function attrsToMap(sv) {
    const map = {};
    const attrs = Array.isArray(sv?.attributes) ? sv.attributes : [];
    for (const a of attrs) {
      const k = String(a?.key ?? a?.id ?? '');
      if (!k) continue;
      const v = a.value ?? (Array.isArray(a.collection) ? a.collection.join(', ') : '') ?? '';
      map[k] = v;
    }
    return map;
  }

  // 已知 attr key 的中文注释(对齐原项目字段语义)
  const ATTR_LABELS = {
    4180: '名称',
    4194: '主图',
    4195: '图册',
    4191: '描述',
    8229: '类型',
    85: '品牌',
    7822: 'GTIN/条码',
    4497: '重量(g)',
    9454: '深度(cm)',
    9455: '宽度(cm)',
    9456: '高度(cm)',
    23171: '主题标签',
    11254: '富内容',
  };

  // 渲染字段表格(键值对)
  function renderFieldTable(rows) {
    if (!rows.length) return '<div class="xy-fs-empty">无数据</div>';
    return `
      <table class="xy-fs-table">
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td class="xy-fs-table-key">${esc(r.label || r.key)}</td>
              <td class="xy-fs-table-val" title="${esc(r.value)}">${esc(truncate(r.value, 80))}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  // 渲染图片缩略图列表
  function renderImageList(images) {
    const list = Array.isArray(images) ? images.filter(Boolean) : images ? [images] : [];
    if (!list.length) return '<div class="xy-fs-empty">无图片</div>';
    return `
      <div class="xy-fs-images">
        ${list
          .slice(0, 6)
          .map((url) => `<img class="xy-fs-thumb" src="${esc(url)}" alt="" onerror="this.style.display='none'">`)
          .join('')}
        ${list.length > 6 ? `<span class="xy-fs-more">+${list.length - 6} 张</span>` : ''}
      </div>
    `;
  }

  // 渲染可折叠 JSON
  function renderJsonBlock(label, obj) {
    const json = JSON.stringify(obj, null, 2);
    return `
      <details class="xy-fs-details">
        <summary class="xy-fs-summary">${esc(label)} <span class="xy-fs-hint">(点击展开 JSON)</span></summary>
        <pre class="xy-fs-json">${esc(json)}</pre>
      </details>
    `;
  }

  // 渲染页面抓取数据(Phase 2)
  function renderPageData(pd) {
    const fields = [
      { label: 'SKU', value: pd.sku },
      { label: 'URL', value: pd.url },
      { label: '标题', value: pd.title },
      { label: '价格', value: pd.price ? `${pd.price} ${pd.currency || 'RUB'}` : '' },
      { label: '品牌', value: pd.brand },
      { label: '面包屑', value: (pd.breadcrumbs || []).join(' / ') },
      { label: '视频', value: pd.videoUrl },
      { label: '关键词', value: (pd.keywords || []).join(', ') },
    ].filter((r) => r.value);

    return `
      <div class="xy-fs-preview-section">
        <div class="xy-fs-sublabel">主图</div>
        ${renderImageList(pd.coverImage)}
      </div>
      <div class="xy-fs-preview-section">
        <div class="xy-fs-sublabel">字段</div>
        ${renderFieldTable(fields)}
      </div>
      ${renderJsonBlock('完整 productData JSON', pd)}
    `;
  }

  // 渲染变体预取数据(Phase 3)
  function renderVariantData(sv) {
    if (!sv) return '<div class="xy-fs-empty">未抓取到变体数据</div>';

    const attrs = attrsToMap(sv);
    const fields = [
      { label: 'variant_id', value: sv.variant_id },
      { label: '类目 ID', value: sv.description_category_id },
      {
        label: '类目',
        value: (sv.categories || [])
          .map((c) => c.name || c.title)
          .filter(Boolean)
          .join(' / '),
      },
    ].filter((r) => r.value);

    // /search 元数据(_searchMeta:skus/barcodes/rating/is_copy_allowed)
    const sm = sv._searchMeta || {};
    const metaRows = [
      { label: 'skus', value: Array.isArray(sm.skus) ? sm.skus.join(', ') : '' },
      { label: 'barcodes', value: Array.isArray(sm.barcodes) ? sm.barcodes.join(', ') : '' },
      { label: 'brand_id', value: sm.brand_id },
      { label: 'rating', value: sm.rating },
      { label: 'is_copy_allowed', value: sm.is_copy_allowed },
      { label: 'is_content_copy_allowed', value: sm.is_content_copy_allowed },
    ].filter((r) => r.value !== '' && r.value !== undefined && r.value !== null);

    // 关键 attr 字段(带中文注释)
    const attrRows = Object.keys(attrs)
      .sort()
      .map((k) => ({ key: k, label: `${k} ${ATTR_LABELS[k] ? '(' + ATTR_LABELS[k] + ')' : ''}`, value: attrs[k] }));

    // 图片字段(4194 主图 + 4195 图册)
    const mainImg = attrs['4194'];
    const gallery = attrs['4195']
      ? String(attrs['4195'])
          .split(',')
          .map((s) => s.trim())
      : [];
    const allImages = [mainImg, ...gallery].filter(Boolean);

    // complex attr(视频/PDF)
    const complexAttrs = Array.isArray(sv._bundleComplexAttrs) ? sv._bundleComplexAttrs : [];

    return `
      <div class="xy-fs-preview-section">
        <div class="xy-fs-sublabel">基础信息</div>
        ${renderFieldTable(fields)}
      </div>
      ${metaRows.length > 0 ? `<div class="xy-fs-preview-section"><div class="xy-fs-sublabel">/search 元数据 (_searchMeta)</div>${renderFieldTable(metaRows)}</div>` : ''}
      <div class="xy-fs-preview-section">
        <div class="xy-fs-sublabel">图片(主图 4194 + 图册 4195)</div>
        ${renderImageList(allImages)}
      </div>
      <div class="xy-fs-preview-section">
        <div class="xy-fs-sublabel">属性(attr 字段表,${attrRows.length} 个)</div>
        ${renderFieldTable(attrRows)}
      </div>
      ${complexAttrs.length > 0 ? `<div class="xy-fs-preview-section"><div class="xy-fs-sublabel">Complex attr(视频/PDF,${complexAttrs.length} 个)</div>${renderJsonBlock('complex_attributes', complexAttrs)}</div>` : ''}
      ${sv._bundleItem ? renderJsonBlock('完整 _bundleItem(后台 40-63 attr)', sv._bundleItem) : ''}
      ${renderJsonBlock('完整 sourceVariant JSON', sv)}
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染变体表格行(对齐 0.13.31.1 createMultiVariantFollowSellPanel:全字段)
  // 每行包含:复选框/主图/变体/SKU/货号/原售价/月销量/跟卖数/
  //          实际售价/最低价/划线价/库存/长宽高/重量/操作
  // ────────────────────────────────────────────────────────────
  function renderVariantRows(productData, now) {
    const variants =
      Array.isArray(productData.variantSkus) && productData.variantSkus.length > 0
        ? productData.variantSkus
        : [{ sku: productData.sku || '' }];
    return variants
      .map((v, i) => {
        const sku = v.sku || '';
        const title = v.title || productData.title || 'Demo 商品';
        const cover = v.coverImage || productData.coverImage || '';
        const rawPrice = v.price || productData.price || '999';
        // 价格原值展示(含币种符号,如 "170 ₽");输入框只用数字
        const priceNum = _extractPriceNumber(rawPrice);
        const defaultOldPrice = priceNum ? (priceNum * 2).toFixed(2) : '';
        const offerId = `SKU${sku}-${String(now).slice(-4)}${i > 0 ? '-' + i : ''}`;
        return `
                  <tr data-sku="${esc(sku)}" data-idx="${i}">
                    <td><input type="checkbox" class="xy-fs-check xy-fs-mv-check" data-idx="${i}" checked></td>
                    <td><img src="${esc(cover)}" class="xy-fs-thumb" onerror="this.style.display='none'"></td>
                    <td class="xy-fs-variant-cell" title="${esc(title)}">${esc(title)}</td>
                    <td><span class="xy-fs-sku">${esc(sku) || '—'}</span></td>
                    <td><input type="text" class="xy-fs-input xy-fs-offerid" data-idx="${i}" value="${esc(offerId)}" placeholder="自动" style="width:140px;"></td>
                    <td><span class="xy-fs-price-original" data-base-price="${esc(priceNum)}" data-source-currency="${esc(v.priceCurrency || productData.currency || 'RUB')}">${esc(rawPrice)}</span></td>
                    <td><span class="xy-fs-mv-sales" data-idx="${i}" data-sku="${esc(sku)}" style="color:#94a3b8;" title="近30天销量">…</span></td>
                    <td><span class="xy-fs-mv-follow" data-idx="${i}" data-sku="${esc(sku)}" style="color:#94a3b8;" title="跟卖卖家数">…</span></td>
                    <td><input type="number" class="xy-fs-input xy-fs-price" data-idx="${i}" value="${esc(priceNum)}" min="0" step="0.01" style="width:80px;"></td>
                    <td><input type="number" class="xy-fs-input xy-fs-minprice" data-idx="${i}" value="${esc(priceNum)}" placeholder="可不填" min="0" step="0.01" title="Ozon 自动调价的下限,默认等于实际售价" style="width:80px;background:#fafafa;"></td>
                    <td><input type="number" class="xy-fs-input xy-fs-oldprice" data-idx="${i}" value="${esc(defaultOldPrice)}" min="0" step="0.01" style="width:80px;"></td>
                    <td><input type="number" class="xy-fs-input xy-fs-stock" data-idx="${i}" value="10" min="0" step="1" style="width:60px;"></td>
                    <td>
                      <div class="xy-fs-mv-lwh-cell" style="display:flex;align-items:center;gap:3px;">
                        <input type="number" class="xy-fs-input xy-fs-depth" data-idx="${i}" placeholder="0" min="0" step="1" title="留空或填写 0 时,沿用跟卖商品原有长宽高" style="width:48px;padding:4px;">
                        <span style="color:#94a3b8;">×</span>
                        <input type="number" class="xy-fs-input xy-fs-width" data-idx="${i}" placeholder="0" min="0" step="1" title="留空或填写 0 时,沿用跟卖商品原有长宽高" style="width:48px;padding:4px;">
                        <span style="color:#94a3b8;">×</span>
                        <input type="number" class="xy-fs-input xy-fs-height" data-idx="${i}" placeholder="0" min="0" step="1" title="留空或填写 0 时,沿用跟卖商品原有长宽高" style="width:48px;padding:4px;">
                        <span style="font-size:10px;color:#94a3b8;">mm</span>
                      </div>
                    </td>
                    <td>
                      <div class="xy-fs-mv-unit-cell" style="display:flex;align-items:center;gap:3px;">
                        <input type="number" class="xy-fs-input xy-fs-weight" data-idx="${i}" placeholder="0" min="0" step="1" title="留空或填写 0 时,沿用跟卖商品原有重量" style="width:60px;padding:4px;">
                        <span style="font-size:10px;color:#94a3b8;">g</span>
                      </div>
                    </td>
                    <td><button class="xy-fs-delete-btn" data-idx="${i}" title="删除">删除</button></td>
                  </tr>`;
      })
      .join('');
  }

  // 从价格字符串提取纯数字(支持 "170 ₽" / "1 234,56 ₽" / "999" / 1234.56)
  // 0.13 ozon-product.js 用 normalizePrice,这里简化:剥币种符号 + 空格 + 千分位,逗号转小数点
  function _extractPriceNumber(price) {
    if (price == null) return '';
    if (typeof price === 'number') return Number.isFinite(price) ? price : '';
    const s = String(price);
    // 剥所有非数字/非逗号/非点字符,再规范千分位
    // "1 234,56 ₽" → "1234.56"  /  "170 ₽" → "170"  /  "999" → "999"
    const cleaned = s
      .replace(/[^\d.,]/g, '') // 去币种符号和空格
      .replace(/\s+/g, ''); // 双保险
    if (!cleaned) return '';
    // 处理 "1,234.56"(千分位.) 和 "1234,56"(欧式小数,)
    // 规则:如果同时有 ,和.,且 ,在 . 前 → 去掉 ,;否则 , → .
    let normalized = cleaned;
    if (cleaned.includes(',') && cleaned.includes('.')) {
      normalized = cleaned.replace(/,/g, ''); // 千分位
    } else if (cleaned.includes(',')) {
      normalized = cleaned.replace(',', '.'); // 欧式小数
    }
    const num = parseFloat(normalized);
    return Number.isFinite(num) ? num : '';
  }

  // ────────────────────────────────────────────────────────────
  // 店铺基础数据(对齐后端 /auth/ozon-stores,popup 已缓存到 chrome.storage)
  // 目标店铺支持多选(对齐 0.13.31.1 createMultiVariantFollowSellPanel)
  // ────────────────────────────────────────────────────────────
  // 返回当前选中店铺对象 {id, name, company_id, warehouse_id, currency_code, ...}
  // 读不到时回退到第一个店铺,再回退到 {id:'store-001', currency_code:'RUB'}
  async function getCurrentStore() {
    try {
      const { ozonStores, ozonStoreId } = await chrome.storage.local.get(['ozonStores', 'ozonStoreId']);
      const stores = Array.isArray(ozonStores) ? ozonStores : [];
      const selected = stores.find((s) => s.id === ozonStoreId) || stores[0] || null;
      if (selected) {
        return {
          ...selected,
          currency_code: String(selected.currency_code || 'RUB').toUpperCase(),
        };
      }
    } catch (e) {
      console.warn('[FollowSell] 读取当前店铺失败:', e?.message);
    }
    return { id: 'store-001', currency_code: 'RUB' };
  }

  // 读取面板已选中的店铺 ID 列表(对齐 0.13.31.1 getSelectedFollowSellStoreIds)
  function getSelectedStoreIds(panel) {
    return Array.from(panel.querySelectorAll('.xy-fs-store-cb:checked'))
      .map((cb) => String(cb.value || '').trim())
      .filter(Boolean);
  }

  // 填充目标店铺多选下拉框(对齐 0.13.31.1 panel._followSellStoreList + store-picker)
  // - 触发器按钮显示「已选 N 家店」或占位文本
  // - 下拉面板含搜索框 + 店铺复选框列表
  // - 选中变化时同步货币 + 物流仓库 picker
  async function populateStoreSelect(panel) {
    const trigger = panel.querySelector('[data-action="toggle-stores"]');
    const dropdown = panel.querySelector('[data-field="store-dropdown"]');
    const currencySelect = panel.querySelector('[data-field="currency"]');
    if (!trigger || !dropdown) return;

    const { ozonStoreId } = await chrome.storage.local.get(['ozonStoreId']);
    const cachedStores = await chrome.storage.local.get(['ozonStores']).then((r) => r.ozonStores);
    let stores = Array.isArray(cachedStores) ? cachedStores : [];

    // 始终从后端拉取最新店铺列表(避免缓存陈旧导致新店铺不显示)
    // 失败时 fallback 到缓存
    try {
      const resp = await sendMessage('getStores');
      if (resp?.ok && Array.isArray(resp.data) && resp.data.length > 0) {
        stores = resp.data;
        await chrome.storage.local.set({ ozonStores: stores });
        console.log('[FollowSell] 拉取最新店铺列表:', stores.length, '个');
      } else {
        console.warn('[FollowSell] getStores 返回异常,使用缓存:', stores.length, '个', resp?.error || '');
      }
    } catch (e) {
      console.warn('[FollowSell] 拉取店铺列表失败,使用缓存:', stores.length, '个,', e?.message);
    }

    panel._followSellStoreList = stores;

    if (stores.length === 0) {
      trigger.textContent = '无可用店铺,请先在 ERP 添加';
      trigger.style.color = '#dc2626';
      return;
    }

    // 默认勾选 popup 选中的店铺(单选默认)
    const defaultChecked = new Set([String(ozonStoreId || stores[0]?.id || '')]);
    panel._defaultCheckedStoreIds = defaultChecked;

    // 渲染下拉面板(搜索框 + 复选框列表)
    // 注意:renderDropdown 会把 defaultChecked 的复选框写入 DOM,从而让 getSelectedStoreIds 能读到
    const renderDropdown = (filter = '') => {
      const f = String(filter || '').toLowerCase();
      const list = stores.filter((s) => {
        if (!f) return true;
        const name = String(s.name || s.label || s.companyName || s.id || '').toLowerCase();
        return name.includes(f);
      });
      dropdown.innerHTML = `
        <div class="xy-fs-store-search-wrap">
          <input type="text" class="xy-fs-store-search" placeholder="搜索店铺..." value="${esc(filter)}">
        </div>
        <div class="xy-fs-store-list">
          ${
            list.length === 0
              ? '<div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px;">无匹配店铺</div>'
              : list
                  .map((s) => {
                    const id = String(s.id || s.storeId || '');
                    const name = s.name || s.label || s.companyName || `店铺 ${id}`;
                    const cur = s.currency_code ? ` (${s.currency_code})` : '';
                    const checked = defaultChecked.has(id) ? 'checked' : '';
                    return `<label class="xy-fs-store-option">
                      <input type="checkbox" class="xy-fs-store-cb" value="${esc(id)}" ${checked}>
                      <span title="${esc(name)}">${esc(name)}${esc(cur)}</span>
                    </label>`;
                  })
                  .join('')
          }
        </div>
      `;
      // 搜索框 input
      const searchInput = dropdown.querySelector('.xy-fs-store-search');
      if (searchInput) {
        searchInput.addEventListener('input', () => renderDropdown(searchInput.value));
        searchInput.focus();
      }
      // 复选框变化
      dropdown.querySelectorAll('.xy-fs-store-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
          // 用户手动改动后,从 defaultChecked 同步实际勾选状态
          defaultChecked.clear();
          dropdown.querySelectorAll('.xy-fs-store-cb:checked').forEach((c) => defaultChecked.add(c.value));
          updateTrigger();
          syncCurrencyFromStores(panel, stores);
          syncWarehouseWithStores(panel);
          updateFooterCount(panel);
        });
      });
    };

    // 更新触发器文案 + 已选店铺 chip 列表(直观看到已勾选的店铺)
    const updateTrigger = () => {
      const ids = getSelectedStoreIds(panel);
      const selectedStores = ids
        .map((id) => stores.find((x) => String(x.id || x.storeId) === String(id)))
        .filter(Boolean);
      if (ids.length === 0) {
        trigger.innerHTML = `<span style="color:#94a3b8;">请选择店铺(可多选)</span>`;
      } else if (ids.length === 1) {
        const s = selectedStores[0];
        const name = s?.name || s?.label || s?.companyName || ids[0];
        trigger.innerHTML = `<span style="color:#0f172a;font-weight:500;">✓ ${esc(name)}</span>`;
      } else {
        // 多店:显示前 2 个店铺名 + 剩余数量
        const names = selectedStores.map((s) => s?.name || s?.label || s?.companyName || s?.id || '');
        const preview = names
          .slice(0, 2)
          .map((n) => `✓ ${esc(n)}`)
          .join(' · ');
        const more = names.length > 2 ? ` <em style="color:#6366f1;font-style:normal;">+${names.length - 2}</em>` : '';
        trigger.innerHTML = `<span style="color:#0f172a;font-weight:500;">${preview}${more}</span>`;
      }
    };

    // 触发器点击 → 切换下拉显示
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      if (isOpen) {
        dropdown.style.display = 'none';
        trigger.classList.remove('is-open');
      } else {
        renderDropdown('');
        dropdown.style.display = 'block';
        trigger.classList.add('is-open');
      }
    });
    // 点击外部关闭下拉
    document.addEventListener(
      'click',
      (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== trigger && !trigger.contains(ev.target)) {
          dropdown.style.display = 'none';
          trigger.classList.remove('is-open');
        }
      },
      { capture: true }
    );

    // 初始触发器文案 + 默认勾选触发同步
    // 关键:先 renderDropdown('') 把默认勾选的 checkbox 写入 DOM(即使下拉框隐藏),
    // 这样 getSelectedStoreIds 才能读到已勾选的店铺 ID,从而让 syncWarehouseWithStores 能正确加载仓库
    renderDropdown('');
    dropdown.style.display = 'none';
    trigger.classList.remove('is-open');
    updateTrigger();
    syncCurrencyFromStores(panel, stores);
    syncWarehouseWithStores(panel);
    updateFooterCount(panel);
  }

  // 根据已选店铺同步货币下拉框(取首个选中店铺的 currency_code)
  function syncCurrencyFromStores(panel, stores) {
    const currencySelect = panel.querySelector('[data-field="currency"]');
    if (!currencySelect) return;
    const ids = getSelectedStoreIds(panel);
    if (ids.length === 0) return;
    const first = stores.find((s) => String(s.id) === ids[0]);
    const cur = first?.currency_code ? String(first.currency_code).toUpperCase() : 'RUB';
    let opt = currencySelect.querySelector(`option[value="${cur}"]`);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = cur;
      currencySelect.appendChild(opt);
    }
    currencySelect.value = cur;
    console.log('[FollowSell] 货币联动(多店取首个):', cur);
  }

  // 同步物流仓库 picker:0 店/1 店 → 单选;多店 → per-store list
  function syncWarehouseWithStores(panel) {
    const ids = getSelectedStoreIds(panel);
    const multiList = panel.querySelector('[data-field="warehouse-multi-list"]');
    const singleRow = panel.querySelector('[data-field="warehouse-single-row"]');
    const hint = panel.querySelector('[data-field="warehouse-picker-hint"]');
    panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();
    panel._warehousesByStore = panel._warehousesByStore || new Map();

    if (ids.length === 0) {
      panel._followSellPreferredWarehouseStoreId = '';
      if (multiList) multiList.style.display = 'none';
      if (singleRow) singleRow.style.display = 'flex';
      if (hint) hint.textContent = '请先选择店铺';
      populateWarehouseSelect(panel, '');
      return;
    }

    if (ids.length === 1) {
      // 单店:沿用原 single-select 路径
      if (multiList) multiList.style.display = 'none';
      if (singleRow) singleRow.style.display = 'flex';
      if (hint) hint.textContent = '库存将写入此仓库(变体表格设置库存后生效)';
      populateWarehouseSelect(panel, ids[0]);
      return;
    }

    // 多店:并行 ensure 各店 warehouses 已加载 → 渲染 N 行 per-store 选择
    if (multiList) {
      multiList.style.display = 'flex';
      multiList.innerHTML = `<div style="font-size:12px;color:#64748b;">加载 ${ids.length} 家店仓库中…</div>`;
    }
    if (singleRow) singleRow.style.display = 'none';
    if (hint) hint.textContent = `库存将写入各店仓库(${ids.length} 家店,每家独立选择)`;
    (async () => {
      await ensureWarehousesForStores(panel, ids);
      renderMultiStoreWarehousePicker(panel, ids);
    })();
  }

  // 并行 ensure 所有 selected store 的 warehouses 已 fetched + cached
  async function ensureWarehousesForStores(panel, storeIds) {
    panel._warehousesByStore = panel._warehousesByStore || new Map();
    const toFetch = storeIds.filter((sid) => sid && !panel._warehousesByStore.has(sid));
    if (toFetch.length === 0) return;
    await Promise.all(
      toFetch.map(async (sid) => {
        try {
          const resp = await sendMessage('getWarehouses', { storeId: sid });
          const list = resp?.data?.warehouses || resp?.data?.result?.warehouses || resp?.data || [];
          panel._warehousesByStore.set(sid, { options: Array.isArray(list) ? list : [] });
        } catch (e) {
          panel._warehousesByStore.set(sid, { options: [], error: e?.message || String(e) });
        }
      })
    );
  }

  // 多店模式:渲染 N 行 per-store 仓库选择
  function renderMultiStoreWarehousePicker(panel, storeIds) {
    const multiList = panel.querySelector('[data-field="warehouse-multi-list"]');
    if (!multiList) return;
    panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();
    const storeList = Array.isArray(panel._followSellStoreList) ? panel._followSellStoreList : [];
    const nameOf = (sid) => {
      const s = storeList.find((x) => String(x.id || x.storeId) === String(sid));
      return s?.name || s?.label || s?.companyName || `店铺 ${String(sid).slice(0, 8)}`;
    };
    // 读取该店铺配置的默认 warehouse_id(用作 select 默认选中)
    const defaultWhOf = (sid) => {
      const s = storeList.find((x) => String(x.id || x.storeId) === String(sid));
      return s?.warehouse_id ? String(s.warehouse_id) : '';
    };

    const rowsHtml = storeIds
      .map((sid) => {
        const cache = panel._warehousesByStore?.get(sid);
        const list = cache?.options || [];
        const error = cache?.error;
        const saved = panel._selectedWarehouseByStore?.get(sid);
        // 优先级:用户已选 > 店铺配置的默认 warehouse_id > 空字符串(回退到列表第一项)
        const preferred = saved || defaultWhOf(sid) || '';
        let selectInner;
        if (error) {
          selectInner = `<option value="">加载失败:${esc(String(error).slice(0, 50))}</option>`;
        } else if (list.length === 0) {
          selectInner = '<option value="">无可用仓库</option>';
        } else {
          // 检查 preferred 是否在列表中;不在则默认选第一项
          const inList = preferred && list.some((w) => String(w.warehouse_id ?? w.id ?? '') === String(preferred));
          const finalPreferred = inList ? preferred : String(list[0]?.warehouse_id ?? list[0]?.id ?? '');
          selectInner = list
            .map((w) => {
              const wid = w.warehouse_id ?? w.id ?? '';
              const name = w.name || `仓库 ${wid}`;
              const selected = String(finalPreferred) === String(wid) ? ' selected' : '';
              return `<option value="${esc(String(wid))}"${selected}>${esc(name)} (${esc(String(wid))})</option>`;
            })
            .join('');
        }
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <span style="flex:0 0 160px;font-size:12.5px;color:#0f172a;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(nameOf(sid))}">${esc(nameOf(sid))}</span>
          <select data-warehouse-store-id="${esc(sid)}" class="xy-fs-select" style="flex:1;min-width:200px;">
            ${selectInner}
          </select>
        </div>`;
      })
      .join('');
    multiList.innerHTML = rowsHtml;

    // Wire onChange — 写 _selectedWarehouseByStore map
    multiList.querySelectorAll('select[data-warehouse-store-id]').forEach((sel) => {
      const sid = sel.getAttribute('data-warehouse-store-id');
      // Seed map with default selected option(用户没改动也要落到 map,确保提交时能取到)
      if (sid && sel.value) {
        panel._selectedWarehouseByStore.set(String(sid), String(sel.value));
      }
      sel.addEventListener('change', () => {
        if (sid && sel.value) {
          panel._selectedWarehouseByStore.set(String(sid), String(sel.value));
        }
      });
    });
  }

  // 填充物流仓库下拉框(单店模式):从后端 /ozon/warehouses 拉取该店铺的仓库列表
  // 默认选中店铺配置的 warehouse_id;列表为空或拉取失败时显示占位
  async function populateWarehouseSelect(panel, storeId) {
    const select = panel.querySelector('[data-field="warehouse-id"]');
    if (!select) return;

    const sid = String(storeId || '');
    panel._followSellStoreId = sid || null;
    panel._warehousesByStore = panel._warehousesByStore || new Map();
    panel._selectedWarehouseByStore = panel._selectedWarehouseByStore || new Map();

    if (!sid) {
      select.innerHTML = '<option value="">请先选择店铺</option>';
      return;
    }

    // 优先用 cache
    const cached = panel._warehousesByStore.get(sid);
    if (cached && Array.isArray(cached.options)) {
      renderWarehouseOptions(panel, sid, cached.options);
      return;
    }

    select.innerHTML = '<option value="">加载中...</option>';
    let warehouses = [];
    try {
      const resp = await sendMessage('getWarehouses', { storeId: sid });
      // resp.data 可能是数组(OPI raw [{warehouse_id,...}] 或 fallback [{id,...}])
      warehouses = resp?.data?.warehouses || resp?.data?.result?.warehouses || resp?.data || [];
      if (!Array.isArray(warehouses)) warehouses = [];
      panel._warehousesByStore.set(sid, { options: warehouses });
    } catch (e) {
      console.warn('[FollowSell] 拉取仓库列表失败:', e?.message);
      panel._warehousesByStore.set(sid, { options: [], error: e?.message || String(e) });
      select.innerHTML = `<option value="">加载失败:${esc(String(e?.message || e).slice(0, 60))}</option>`;
      return;
    }

    renderWarehouseOptions(panel, sid, warehouses);
  }

  // 渲染单店仓库 option 列表 + 选中默认值 + 写入 _selectedWarehouseByStore
  function renderWarehouseOptions(panel, storeId, warehouses) {
    const select = panel.querySelector('[data-field="warehouse-id"]');
    if (!select) return;
    const sid = String(storeId || '');

    if (!Array.isArray(warehouses) || warehouses.length === 0) {
      select.innerHTML = '<option value="">无可用仓库</option>';
      return;
    }

    // 读取当前店铺的默认 warehouse_id 用于默认选中
    let defaultWhId = '';
    try {
      const storeList = Array.isArray(panel._followSellStoreList) ? panel._followSellStoreList : [];
      const store = storeList.find((s) => String(s.id) === sid);
      defaultWhId = store?.warehouse_id ? String(store.warehouse_id) : '';
    } catch {}

    const saved = panel._selectedWarehouseByStore?.get(sid);
    const preferred = saved || defaultWhId || '';
    select.innerHTML = warehouses
      .map((w) => {
        const wid = w.warehouse_id ?? w.id ?? '';
        const name = w.name || `仓库 ${wid}`;
        const selected = preferred && String(preferred) === String(wid) ? ' selected' : '';
        return `<option value="${esc(String(wid))}"${selected}>${esc(name)} (${esc(String(wid))})</option>`;
      })
      .join('');

    if (!select.value && select.options.length > 0) select.selectedIndex = 0;
    if (select.value) {
      panel._selectedWarehouseByStore.set(sid, String(select.value));
    }
    // 单店模式下切换仓库 → 写入 map
    select.addEventListener('change', () => {
      if (sid && select.value) {
        panel._selectedWarehouseByStore.set(sid, String(select.value));
      }
    });
    console.log('[FollowSell] 仓库列表已加载:', warehouses.length, '个,选中:', select.value);
  }

  // 货币符号映射(用于价格 label 显示)
  const CURRENCY_SYMBOL = {
    RUB: '₽',
    KZT: '₸',
    USD: '$',
    EUR: '€',
    CNY: '¥',
    UAH: '₴',
    BYN: 'Br',
    UZS: "so'm",
  };

  // 根据 currency_code 返回符号(用于价格展示)
  function currencySymbol(code) {
    return CURRENCY_SYMBOL[String(code || '').toUpperCase()] || code || '';
  }

  // ────────────────────────────────────────────────────────────
  // 创建面板 DOM —— 全屏遮罩 + 居中对话框(对齐原项目 createMultiVariantFollowSellPanel)
  // ────────────────────────────────────────────────────────────
  function createPanel(productData) {
    const existing = document.getElementById('xy-follow-sell-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.className = 'xy-fs-panel';
    panel.id = 'xy-follow-sell-panel';
    const now = Date.now();
    // 面板挂载后异步填充 store 下拉框(对齐 popup 选中的店铺)
    setTimeout(() => populateStoreSelect(panel), 0);
    // 异步填充水印模板下拉框(P3:从 ERP 拉取替换硬编码)
    setTimeout(() => populateWatermarkTemplates(panel), 0);
    panel.innerHTML = `
      <div class="xy-fs-dialog">
        <!-- Header -->
        <div class="xy-fs-header">
          <div class="xy-fs-header-left">
            <div class="xy-fs-header-text">
              <div class="xy-fs-header-title-row">
                <span class="xy-fs-header-title">一键上架到 OZON</span>
                <span class="xy-fs-variant-badge" data-field="variant-badge">${(productData.variantSkus || []).length || 1} 个变体</span>
              </div>
              <span class="xy-fs-header-subtitle">采集竞品,自动填充,一键发布到指定店铺</span>
            </div>
          </div>
          <div class="xy-fs-header-right">
            <label class="xy-fs-toggle-label" data-field="show-all-sku-label">
              <span>显示所有 SKU</span>
              <div class="xy-fs-toggle" data-field="show-all-sku">
                <input type="checkbox" />
                <span class="xy-fs-toggle-slider"></span>
                <span class="xy-fs-toggle-text-yes">是</span>
                <span class="xy-fs-toggle-text-no">否</span>
              </div>
            </label>
            <button class="xy-fs-close" data-action="close" title="关闭">×</button>
          </div>
        </div>

        <!-- 会员条占位 -->
        <div class="xy-fs-membership" data-field="membership-bar" style="display:none;"></div>

        <div class="xy-fs-body">
          <!-- 01 店铺基础卡(对齐 0.13.31.1:仅 目标店铺/品牌/图片顺序/上架货币/合并变体型号) -->
          <div class="xy-fs-card xy-fs-card-shop">
            <div class="xy-fs-card-header">
              <span class="xy-fs-card-bar" style="background:#16A34A"></span>
              <span class="xy-fs-card-no">01</span>
              <span class="xy-fs-card-title">店铺与基础</span>
              <span class="xy-fs-required-pill">必填</span>
            </div>
            <div class="xy-fs-card-body">
              <div class="xy-fs-field-grid">
                <!-- 目标店铺(多选下拉,支持一个或多个;下拉框 absolute 定位不撑开面板) -->
                <div class="xy-fs-field xy-fs-field-vertical">
                  <label class="xy-fs-label">
                    <span class="xy-fs-required">*</span> 目标店铺
                    <em class="xy-fs-label-hint">支持多店铺 · 搜索 / 多选</em>
                  </label>
                  <div class="xy-fs-store-select" data-field="store-wrapper">
                    <div class="xy-fs-store-trigger" data-action="toggle-stores">加载中...</div>
                    <div class="xy-fs-store-dropdown" style="display:none;" data-field="store-dropdown"></div>
                  </div>
                </div>
                <!-- 品牌 -->
                <div class="xy-fs-field xy-fs-field-vertical">
                  <label class="xy-fs-label"><span class="xy-fs-required">*</span> 品牌</label>
                  <select data-field="brand" class="xy-fs-select">
                    <option value="no_brand" selected>无品牌</option>
                    <option value="copy">复制当前品牌</option>
                  </select>
                </div>
                <!-- 图片顺序 -->
                <div class="xy-fs-field xy-fs-field-vertical">
                  <label class="xy-fs-label"><span class="xy-fs-required">*</span> 图片顺序</label>
                  <select data-field="image-order" class="xy-fs-select">
                    <option value="keep">不处理</option>
                    <option value="shuffle">随机打乱</option>
                    <option value="shuffle_keep_first">主图不变,其余打乱</option>
                  </select>
                </div>
                <!-- 上架货币 -->
                <div class="xy-fs-field xy-fs-field-vertical">
                  <label class="xy-fs-label">上架货币</label>
                  <select data-field="currency" class="xy-fs-select">
                    <option value="CNY">[¥] 人民币</option>
                    <option value="USD">[$] 美元</option>
                    <option value="EUR">[€] 欧元</option>
                    <option value="RUB">[₽] 卢布</option>
                  </select>
                </div>
                <!-- 合并变体型号 -->
                <div class="xy-fs-field xy-fs-field-vertical">
                  <label class="xy-fs-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" data-field="merge-enabled" style="margin:0;width:14px;height:14px;cursor:pointer;flex:0 0 auto;">合并成一张卡
                  </label>
                  <input type="text" class="xy-fs-input" data-field="merge-model" placeholder="勾选后自动生成型号名,可改;留空=不合并" title="勾选「合并成一张卡」后整组变体共享同一型号名(attr 9048)→ Ozon 合并为同一张商品卡;留空=每个变体各自独立成卡。" style="margin-top:6px;">
                  <div class="xy-fs-merge-hint" style="font-size:10px;color:#94a3b8;line-height:1.35;margin-top:4px;">⏳ 合并在 Ozon 端最多 24h 才生效;需同品牌·同类目(个别类目不支持)</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 02 AI 增强折叠卡 -->
          <div class="xy-fs-card xy-fs-card-ai">
            <div class="xy-fs-card-header xy-fs-card-header-clickable" data-action="toggle-ai">
              <span class="xy-fs-card-bar" style="background:#0ea5e9"></span>
              <span class="xy-fs-card-no">02</span>
              <span class="xy-fs-card-title">AI 增强</span>
              <span class="xy-fs-optional-pill">可选</span>
              <span class="xy-fs-card-hint">水印 / AI 改图 / AI 重写</span>
              <span class="xy-fs-chevron" data-field="ai-chevron">▼</span>
            </div>
            <div class="xy-fs-card-body xy-fs-ai-grid xy-fs-collapsed" data-field="ai-section">
              <!-- 水印 -->
              <div class="xy-fs-opt-card">
                <div class="xy-fs-opt-header">
                  <label class="xy-fs-opt-toggle">
                    <input type="checkbox" data-field="apply-watermark">
                    <span class="xy-fs-opt-slider"></span>
                  </label>
                  <span class="xy-fs-opt-title">水印</span>
                </div>
                <select data-field="watermark-template-id" class="xy-fs-opt-select">
                  <option value="">不使用水印</option>
                  <option value="tpl-1">默认水印模板</option>
                </select>
              </div>
              <!-- AI 海报 -->
              <div class="xy-fs-opt-card">
                <div class="xy-fs-opt-header">
                  <label class="xy-fs-opt-toggle">
                    <input type="checkbox" data-field="apply-poster">
                    <span class="xy-fs-opt-slider"></span>
                  </label>
                  <span class="xy-fs-opt-title">AI 大模型改图</span>
                  <span class="xy-fs-gemini-badge">Gemini</span>
                </div>
                <label class="xy-fs-opt-sub" style="display:none;" data-field="poster-primary-only-row">
                  <input type="checkbox" data-field="poster-primary-only"> 只改主图
                </label>
              </div>
              <!-- AI 重写 -->
              <div class="xy-fs-opt-card">
                <div class="xy-fs-opt-header">
                  <label class="xy-fs-opt-toggle">
                    <input type="checkbox" data-field="apply-ai-rewrite">
                    <span class="xy-fs-opt-slider"></span>
                  </label>
                  <span class="xy-fs-opt-title">AI 重写</span>
                </div>
                <span class="xy-fs-opt-desc">翻译 + SEO 优化标题 / 描述</span>
              </div>
            </div>
          </div>

          <!-- 物流仓库卡(单店:单选;多店:per-store 列表,对齐 0.13.31.1) -->
          <div class="xy-fs-card xy-fs-card-logistics" style="padding:10px 14px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <span style="font-weight:600;color:#0f172a;font-size:13px;flex-shrink:0;">物流仓库</span>
              <span style="font-size:12px;color:#64748b;flex:1;" data-field="warehouse-picker-hint">库存将写入各店仓库(变体表格设置库存后生效)</span>
            </div>
            <!-- 单店 picker:1 选中店时显示;多选时隐藏,改用下面的 per-store list -->
            <div data-field="warehouse-single-row" style="display:flex;align-items:center;gap:8px;">
              <select data-field="warehouse-id" class="xy-fs-select" style="flex:1;min-width:160px;">
                <option value="">加载中...</option>
              </select>
            </div>
            <!-- 多店 picker:N 行 per-store 仓库选择 -->
            <div data-field="warehouse-multi-list" style="display:none;flex-direction:column;gap:6px;"></div>
          </div>

          <!-- 03 变体定价与规格卡(对齐 0.13.31.1:全字段 + 批量设置按钮) -->
          <div class="xy-fs-card xy-fs-card-table">
            <div class="xy-fs-card-header">
              <span class="xy-fs-card-bar" style="background:#3B82F6"></span>
              <span class="xy-fs-card-no">03</span>
              <span class="xy-fs-card-title">变体定价与规格</span>
              <span class="xy-fs-card-hint">勾选要上架的变体,填入售价/划线价/库存;长宽高/重量留空或 0 = 沿用源商品属性</span>
            </div>
            <div class="xy-fs-phys-hint" style="padding:6px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;margin:6px 0;font-size:11.5px;color:#92400e;display:flex;gap:6px;align-items:center;">
              <span style="background:#f59e0b;color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;flex-shrink:0;">提示</span>
              <span>长宽高、重量 <strong>留空或填写 0</strong> 时,不会覆盖原商品规格;只有输入大于 0 的值才会改写。</span>
            </div>
            <div class="xy-fs-table-wrap">
              <table class="xy-fs-table">
                <thead>
                  <tr>
                    <th style="width:36px;"><input type="checkbox" data-action="select-all" checked></th>
                    <th>主图</th>
                    <th>变体</th>
                    <th>SKU</th>
                    <th style="min-width:160px;">
                      <div>货号</div>
                      <div style="display:flex;align-items:center;gap:4px;margin-top:2px;font-weight:400;font-size:11px;color:#64748b;">
                        <span>前缀</span>
                        <input type="text" data-field="offerid-prefix" placeholder="jz-" maxlength="20" style="width:64px;height:20px;padding:0 4px;border:1px solid #e5e7eb;border-radius:3px;font-size:11px;font-family:inherit;background:#fff;">
                        <span class="xy-fs-th-action" data-action="auto-offerid" style="margin-left:auto;color:#3b82f6;cursor:pointer;">一键生成</span>
                      </div>
                    </th>
                    <th>原售价</th>
                    <th>月销量</th>
                    <th>跟卖数</th>
                    <th>实际售价 <span class="xy-fs-th-action" data-action="batch-price" style="color:#3b82f6;cursor:pointer;">批量设置</span></th>
                    <th title="Ozon 自动调价的下限 — 平台促销时不会低于此价。选填,留空 = 不参与自动调价">最低价 <span style="font-weight:400;font-size:11px;color:#94a3b8;">选填</span> <span class="xy-fs-th-action" data-action="batch-minprice" style="color:#3b82f6;cursor:pointer;">批量设置</span></th>
                    <th>划线价 <span class="xy-fs-th-action" data-action="batch-oldprice" style="color:#3b82f6;cursor:pointer;">批量设置</span></th>
                    <th>库存 <span class="xy-fs-th-action" data-action="batch-stock" style="color:#3b82f6;cursor:pointer;">批量设置</span></th>
                    <th>
                      <span>长 × 宽 × 高</span>
                      <span class="xy-fs-th-action" data-action="batch-dims" style="color:#3b82f6;cursor:pointer;">批量设置</span>
                    </th>
                    <th>
                      <span>重量</span>
                      <span class="xy-fs-th-action" data-action="batch-weight" style="color:#3b82f6;cursor:pointer;">批量设置</span>
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody data-field="variant-tbody">
                  ${renderVariantRows(productData, now)}
                </tbody>
              </table>
            </div>
            <!-- 数据预览区(折叠) -->
            <div class="xy-fs-data-preview">
              <div class="xy-fs-data-preview-header" data-action="toggle-preview">
                <span>数据预览</span>
                <span class="xy-fs-chevron">▼</span>
              </div>
              <div class="xy-fs-data-preview-body xy-fs-collapsed" data-field="data-preview-body">
                <div class="xy-fs-preview-section">
                  <h4>页面数据</h4>
                  <div data-field="page-data-preview">${renderPageData(productData)}</div>
                </div>
                <div class="xy-fs-preview-section">
                  <h4>变体数据</h4>
                  <div data-field="variant-data-preview"><p class="xy-fs-hint">点击「一键上架至OZON」后自动加载</p></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 状态显示区 -->
        <div class="xy-fs-status" data-field="mv-status" style="display:none;"></div>

        <!-- 上架结果固定展示区(Phase 7.5 查询 /v1/product/import/info 后填充,不被覆盖) -->
        <div class="xy-fs-result-panel" data-field="result-panel" style="display:none;">
          <div class="xy-fs-result-header">
            <span class="xy-fs-result-title">上架结果</span>
            <span class="xy-fs-result-summary" data-field="result-summary"></span>
          </div>
          <div class="xy-fs-result-body" data-field="result-body"></div>
        </div>

        <!-- 上架方式 radio(flag 开启才显示) -->
        <!-- 默认 portal(模拟手动上架):灰度开关 ON 时优先走 seller.ozon.ru 门户,绕 OPI 限流 -->
        <div class="xy-fs-upload-mode" data-field="upload-mode-row" style="display:none;">
          <span class="xy-fs-upload-mode-label">上架方式</span>
          <label class="xy-fs-radio-label">
            <input type="radio" name="jz-upload-mode" value="api"> API 上架
          </label>
          <label class="xy-fs-radio-label">
            <input type="radio" name="jz-upload-mode" value="portal" checked> 模拟手动上架
          </label>
          <span class="xy-fs-upload-mode-hint">模拟手动上架仅支持单店,需已登录 seller.ozon.ru</span>
        </div>

        <!-- Footer -->
        <div class="xy-fs-footer">
          <div class="xy-fs-footer-left">
            <div class="xy-fs-footer-stat">
              <span class="xy-fs-footer-meta">提交后将创建</span>
              <span class="xy-fs-footer-count">
                <strong data-field="footer-publish-count">1</strong> 条上架 · <strong data-field="footer-selected-count">1</strong> 变体 × <strong data-field="footer-store-count">1</strong> 店铺
              </span>
            </div>
          </div>
          <div class="xy-fs-footer-right">
            <button class="xy-fs-btn-secondary" data-action="cancel">取消</button>
            <button class="xy-fs-btn-primary" data-action="submit">一键上架至 OZON</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindEvents(panel, productData);
    initPageDataPreview(panel, productData);
    // 异步预取首个变体 sv,刷新变体数据预览区(物理参数已移至变体表格每行,不再面板级预填)
    prefetchFirstVariantPreview(panel, productData);
    // 异步预取每个变体的长宽高/重量并回填到对应行 input
    prefetchVariantRowDims(panel, productData);
    return panel;
  }

  // ────────────────────────────────────────────────────────────
  // 异步预取首个变体 sv,刷新变体数据预览区(对齐原项目 prefillDimensionsFromSvAsync 的预览部分)
  // ────────────────────────────────────────────────────────────
  async function prefetchFirstVariantPreview(panel, productData) {
    try {
      const sku = productData.sku;
      if (!sku) return;
      const resp = await sendMessage('searchVariants', { sku });
      if (!resp?.ok || !resp.data) return;
      const sv = resp.data;
      const variantContainer = panel.querySelector('[data-field="variant-data-preview"]');
      if (variantContainer && sv) variantContainer.innerHTML = renderVariantData(sv);
      console.log('[FollowSell] 首个变体 sv 预览完成');
    } catch (e) {
      console.warn('[FollowSell] 首个变体 sv 预览失败(不影响提交):', e?.message || e);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 预取每个变体的 sourceVariant,把长宽高/重量预填到对应行 input
  // 用户可在面板上直接看到源商品规格,无需等提交时才从 sv 兜底
  // ────────────────────────────────────────────────────────────
  async function prefetchVariantRowDims(panel, productData) {
    const rows = panel.querySelectorAll('tr[data-sku][data-idx]');
    if (!rows.length) return;
    const skus = Array.from(rows)
      .map((tr) => String(tr.getAttribute('data-sku') || ''))
      .filter(Boolean);
    if (!skus.length) return;

    console.log(`[FollowSell] 预取 ${skus.length} 个变体的长宽高/重量...`);
    // 并行预取(并发限制:5 个)
    const CONCURRENCY = 5;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, skus.length) }, async () => {
      while (cursor < skus.length) {
        const i = cursor++;
        const sku = skus[i];
        const tr = rows[i];
        const idx = tr.getAttribute('data-idx') || String(i);
        try {
          const resp = await sendMessage('searchVariants', { sku });
          if (!resp?.ok || !resp.data) continue;
          const sv = resp.data;
          // 物理参数优先级:sv[4497 重量 g] > sv[4383 kg→g] > undefined
          const weight = readSourceInt(sv, '4497') || readSourceWeightKgAsG(sv);
          const depth = readSourceInt(sv, '9454');
          const width = readSourceInt(sv, '9455');
          const height = readSourceInt(sv, '9456');
          if (isFinite(weight) && weight > 0) {
            const el = tr.querySelector(`.xy-fs-weight[data-idx="${idx}"]`);
            if (el && !el.value) el.value = String(weight);
          }
          if (isFinite(depth) && depth > 0) {
            const el = tr.querySelector(`.xy-fs-depth[data-idx="${idx}"]`);
            if (el && !el.value) el.value = String(depth);
          }
          if (isFinite(width) && width > 0) {
            const el = tr.querySelector(`.xy-fs-width[data-idx="${idx}"]`);
            if (el && !el.value) el.value = String(width);
          }
          if (isFinite(height) && height > 0) {
            const el = tr.querySelector(`.xy-fs-height[data-idx="${idx}"]`);
            if (el && !el.value) el.value = String(height);
          }
        } catch (e) {
          console.warn(`[FollowSell] 预取 sv 失败 sku=${sku}:`, e?.message);
        }
      }
    });
    await Promise.all(workers);
    console.log('[FollowSell] 变体长宽高/重量预填完成');
  }

  // ────────────────────────────────────────────────────────────
  // 更新 footer 计数:勾选变体数 × 已选店铺数 = 上架条数(对齐 0.13.31.1 updateFooterCount)
  // ────────────────────────────────────────────────────────────
  function updateFooterCount(panel) {
    // badge:商品总变体数(数据本身,不随勾选/显示变化)
    const totalRows = panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]');
    const badge = panel.querySelector('[data-field="variant-badge"]');
    if (badge) badge.textContent = `${totalRows.length} 个变体`;
    // footer 计数:勾选变体 × 已选店铺
    const checkedCount = panel.querySelectorAll('.xy-fs-check[data-idx]:checked').length;
    const storeIds = getSelectedStoreIds(panel);
    const storeCount = storeIds.length || 1;
    const footerPublish = panel.querySelector('[data-field="footer-publish-count"]');
    const footerSelected = panel.querySelector('[data-field="footer-selected-count"]');
    const footerStore = panel.querySelector('[data-field="footer-store-count"]');
    if (footerSelected) footerSelected.textContent = String(checkedCount);
    if (footerStore) footerStore.textContent = String(storeCount);
    if (footerPublish) footerPublish.textContent = String(checkedCount * storeCount);
  }

  // 旧函数名兼容(内部调用 updateFooterCount)
  function updateVariantCount(panel) {
    updateFooterCount(panel);
  }

  function bindEvents(panel, productData) {
    // 1. 关闭 / 取消
    panel.querySelectorAll('[data-action="close"], [data-action="cancel"]').forEach((btn) => {
      btn.addEventListener('click', () => panel.remove());
    });

    // 2. AI 卡折叠
    const aiHeader = panel.querySelector('[data-action="toggle-ai"]');
    if (aiHeader) {
      aiHeader.addEventListener('click', () => {
        const section = panel.querySelector('[data-field="ai-section"]');
        const chevron = panel.querySelector('[data-field="ai-chevron"]');
        if (section) section.classList.toggle('xy-fs-collapsed');
        if (chevron) chevron.classList.toggle('xy-fs-chevron-open');
      });
    }

    // 3. 数据预览折叠
    const previewHeader = panel.querySelector('[data-action="toggle-preview"]');
    if (previewHeader) {
      previewHeader.addEventListener('click', () => {
        const body = panel.querySelector('[data-field="data-preview-body"]');
        if (body) body.classList.toggle('xy-fs-collapsed');
        const chevron = previewHeader.querySelector('.xy-fs-chevron');
        if (chevron) chevron.classList.toggle('xy-fs-chevron-open');
      });
    }

    // 4. 提交
    const submitBtn = panel.querySelector('[data-action="submit"]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => handleSubmit(panel, productData));
    }

    // 5. 全选 + 勾选变化刷新计数(对齐 0.13 panel change 监听 + updateFooterCount)
    const selectAll = panel.querySelector('[data-action="select-all"]');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        panel.querySelectorAll('.xy-fs-check').forEach((cb) => {
          cb.checked = selectAll.checked;
        });
        updateVariantCount(panel);
      });
    }
    // 勾选/取消勾选时刷新 footer 计数 + 同步全选 checkbox
    panel.addEventListener('change', (e) => {
      if (!(e.target instanceof HTMLInputElement) || !e.target.classList.contains('xy-fs-check')) return;
      updateVariantCount(panel);
      if (selectAll) {
        const checks = panel.querySelectorAll('.xy-fs-check[data-idx]');
        const checkedCount = Array.from(checks).filter((c) => c.checked).length;
        selectAll.checked = checks.length > 0 && checkedCount === checks.length;
      }
    });

    // 6. 删除行
    panel.querySelectorAll('.xy-fs-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tr = btn.closest('tr');
        if (tr) tr.remove();
        updateVariantCount(panel);
      });
    });

    // 7. 「显示所有 SKU / 仅当前变体」切换(对齐 0.13 ozon-product.js:7022-7091)
    //    默认显示开关;单变体(<2)时隐藏
    //    - 是:显示全部变体行
    //    - 否(默认):仅显示当前 URL SKU 对应行,其余隐藏;无匹配时 fallback 第一行
    //    状态持久化到 chrome.storage.local['mv-show-all-sku']
    const showAllLabel = panel.querySelector('[data-field="show-all-sku-label"]');
    const showAllToggle = panel.querySelector('[data-field="show-all-sku"] input[type="checkbox"]');
    const variantRows = panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]');
    console.log('[FollowSell] 开关初始化:', {
      labelFound: !!showAllLabel,
      toggleFound: !!showAllToggle,
      variantRowCount: variantRows.length,
    });
    if (showAllLabel && showAllToggle) {
      if (variantRows.length < 2) {
        // 单变体:隐藏开关
        showAllLabel.style.display = 'none';
      } else {
        // 多变体:确保显示(CSS 默认 flex,这里强制兜底)
        showAllLabel.style.display = 'flex';
        const currentSku = String(productData?.sku || '');
        const STORAGE_KEY = 'mv-show-all-sku';

        const applyShowAll = () => {
          const showAll = showAllToggle.checked;
          let matched = false;
          let firstFallbackRow = null;
          variantRows.forEach((row) => {
            const cb = row.querySelector('.xy-fs-check');
            if (showAll) {
              row.style.display = '';
              if (cb) cb.checked = true; // 显示时恢复勾选
              return;
            }
            const rowSku = row.getAttribute('data-sku');
            if (currentSku && rowSku === currentSku) {
              row.style.display = '';
              if (cb) cb.checked = true;
              matched = true;
            } else {
              row.style.display = 'none';
              if (cb) cb.checked = false;
              if (!firstFallbackRow) firstFallbackRow = row;
            }
          });
          // 无匹配时 fallback 显示第一行
          if (!showAll && !matched && firstFallbackRow) {
            firstFallbackRow.style.display = '';
            const cb = firstFallbackRow.querySelector('.xy-fs-check');
            if (cb) cb.checked = true;
          }
          // 同步全选 checkbox
          const selectAll = panel.querySelector('[data-action="select-all"]');
          if (selectAll) {
            const checks = panel.querySelectorAll('.xy-fs-check[data-idx]');
            const checkedCount = Array.from(checks).filter((c) => c.checked).length;
            selectAll.checked = checks.length > 0 && checkedCount === checks.length;
          }
          updateVariantCount(panel);
        };

        // 恢复持久化偏好(默认 false = 不显示所有,即仅当前变体)
        try {
          chrome.storage.local.get([STORAGE_KEY], (res) => {
            const saved = res?.[STORAGE_KEY];
            // 只有显式存过 true 才显示所有;否则默认 false(仅当前变体)
            showAllToggle.checked = saved === true;
            applyShowAll();
          });
        } catch {
          applyShowAll();
        }

        // 切换时应用 + 持久化
        showAllToggle.addEventListener('change', () => {
          applyShowAll();
          try {
            chrome.storage.local.set({ [STORAGE_KEY]: showAllToggle.checked });
          } catch {}
        });
      }
    }

    // 8. 批量设置按钮 + 一键生成货号(对齐 0.13.31.1 batchRoutes)
    //    点击表头「批量设置」→ 弹输入框 → 应用到所有勾选行
    const batchApply = (selector, value) => {
      panel.querySelectorAll('.xy-fs-check[data-idx]:checked').forEach((cb) => {
        const tr = cb.closest('tr');
        if (!tr) return;
        const input = tr.querySelector(selector);
        if (input) input.value = value;
      });
    };
    const batchHandler = (action, fn) => {
      const el = panel.querySelector(`[data-action="${action}"]`);
      if (el)
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          fn();
        });
    };
    batchHandler('batch-price', () => {
      const v = window.prompt('输入实际售价(应用到所有勾选变体):', '');
      if (v == null) return;
      const n = parseFloat(String(v).replace(',', '.'));
      if (!isFinite(n) || n < 0) return alert('价格无效');
      batchApply('.xy-fs-price', n.toFixed(2));
    });
    batchHandler('batch-minprice', () => {
      const v = window.prompt('输入最低价(留空 = 不参与自动调价,应用到所有勾选变体):', '');
      if (v == null) return;
      if (v.trim() === '') {
        batchApply('.xy-fs-minprice', '');
        return;
      }
      const n = parseFloat(String(v).replace(',', '.'));
      if (!isFinite(n) || n < 0) return alert('价格无效');
      batchApply('.xy-fs-minprice', n.toFixed(2));
    });
    batchHandler('batch-oldprice', () => {
      const v = window.prompt('输入划线价(应用到所有勾选变体):', '');
      if (v == null) return;
      const n = parseFloat(String(v).replace(',', '.'));
      if (!isFinite(n) || n < 0) return alert('价格无效');
      batchApply('.xy-fs-oldprice', n.toFixed(2));
    });
    batchHandler('batch-stock', () => {
      const v = window.prompt('输入库存(应用到所有勾选变体):', '10');
      if (v == null) return;
      const n = parseInt(String(v), 10);
      if (!isFinite(n) || n < 0) return alert('库存无效');
      batchApply('.xy-fs-stock', String(n));
    });
    batchHandler('batch-dims', () => {
      const v = window.prompt('输入长×宽×高(mm,用空格或 × 分隔,留空 = 沿用原值):', '');
      if (v == null) return;
      const parts = String(v)
        .split(/[\s×x*]+/)
        .filter(Boolean);
      if (parts.length === 0) {
        ['.xy-fs-depth', '.xy-fs-width', '.xy-fs-height'].forEach((s) => batchApply(s, ''));
        return;
      }
      if (parts.length !== 3) return alert('请输入 3 个数字,如 "100 50 30"');
      const [d, w, h] = parts.map((p) => parseInt(String(p).replace(',', ''), 10));
      if (![d, w, h].every((n) => isFinite(n) && n >= 0)) return alert('数值无效');
      batchApply('.xy-fs-depth', String(d));
      batchApply('.xy-fs-width', String(w));
      batchApply('.xy-fs-height', String(h));
    });
    batchHandler('batch-weight', () => {
      const v = window.prompt('输入重量(g,留空 = 沿用原值):', '');
      if (v == null) return;
      if (v.trim() === '') {
        batchApply('.xy-fs-weight', '');
        return;
      }
      const n = parseInt(String(v).replace(',', ''), 10);
      if (!isFinite(n) || n < 0) return alert('重量无效');
      batchApply('.xy-fs-weight', String(n));
    });
    batchHandler('auto-offerid', () => {
      const prefixInput = panel.querySelector('[data-field="offerid-prefix"]');
      const prefix = (prefixInput?.value || '').trim();
      const ts = String(Date.now()).slice(-6);
      let i = 0;
      panel.querySelectorAll('.xy-fs-check[data-idx]:checked').forEach((cb) => {
        const tr = cb.closest('tr');
        if (!tr) return;
        const sku = tr.getAttribute('data-sku') || '';
        const input = tr.querySelector('.xy-fs-offerid');
        if (input) input.value = `${prefix}${sku ? sku + '-' : ''}${ts}${i > 0 ? '-' + i : ''}`;
        i++;
      });
    });

    // 9. 灰度 flag 开启时显示上架方式 radio + 恢复持久化偏好
    isPortalImportEnabled()
      .then((on) => {
        if (on) {
          const row = panel.querySelector('[data-field="upload-mode-row"]');
          if (row) row.style.display = '';
          // 恢复持久化的上架方式(对齐 0.13 ozon-product.js:6898-6906)
          try {
            chrome.storage.local.get(['jz-upload-mode'], (res) => {
              const saved = res?.['jz-upload-mode'];
              if (saved === 'api' || saved === 'portal') {
                const el = panel.querySelector(`input[name="jz-upload-mode"][value="${saved}"]`);
                if (el) el.checked = true;
              }
            });
          } catch {}
          // 切换时持久化
          panel.querySelectorAll('input[name="jz-upload-mode"]').forEach((el) => {
            el.addEventListener('change', () => {
              if (el.checked) {
                try {
                  chrome.storage.local.set({ 'jz-upload-mode': el.value });
                } catch {}
              }
            });
          });
        }
      })
      .catch(() => {});
  }

  // ────────────────────────────────────────────────────────────
  // 初始化页面数据预览(即时渲染)
  // ────────────────────────────────────────────────────────────
  function initPageDataPreview(panel, productData) {
    const container = panel.querySelector('[data-field="page-data-preview"]');
    if (container) container.innerHTML = renderPageData(productData);
  }

  // ────────────────────────────────────────────────────────────
  // toggle —— 切换面板显示/隐藏(action-bar / sidebar-card 入口)
  // 集成多变体展开(Phase 0 弹窗补全 + Phase A SSR 多轴展开)
  // ────────────────────────────────────────────────────────────
  async function toggle() {
    const existing = document.getElementById('xy-follow-sell-panel');
    if (existing) {
      existing.remove();
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 流水线 loading 弹窗(对齐 0.13.31.1 toggleFollowSellPanel line 10258)
    // 在数据采集 + 变体展开期间显示,完成后关闭再打开面板
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const loadingDialog = createPipelineLoadingDialog();
    const closeLoading = () => {
      try {
        loadingDialog.close();
      } catch (e) {
        console.warn('[FollowSell] loadingDialog.close 异常:', e?.message);
      }
    };

    try {
      // 关键:先预热 composer-api page json 缓存
      // Ozon 2026 SSR DOM 剥离场景下,页面 [data-state] 没有 aspects 数据,
      // 必须先调 composer-api 拿到完整 widgetStates 缓存,
      // 之后 extractAspectVariants → extractStateData('state-webAspects') 才能从缓存读到。
      // 对齐 0.13 ozon-product.js:10181-10189 toggleFollowSellPanel
      if (self.JZProductExtractor?.ensurePdpState) {
        try {
          console.log('[FollowSell] 预热 composer-api 缓存...');
          await self.JZProductExtractor.ensurePdpState();
          console.log('[FollowSell] 预热完成');
        } catch (e) {
          console.warn('[FollowSell] ensurePdpState 失败(不阻断):', e?.message);
        }
      }

      const pd = self.JZProductExtractor.extractProductData();
      console.log('[FollowSell] extractProductData:', {
        sku: pd.sku,
        title: pd.title?.slice(0, 40),
        variantSkusCount: pd.variantSkus?.length,
        variantSkusSource: pd.variantSkus?.length > 1 ? 'aspects or fallback' : 'single',
      });

      // 多变体展开:Phase 0 弹窗补全 + Phase A SSR 多轴展开
      // 真多轴商品才阻塞展开;单轴/单变体直接开面板(秒开)
      // 对齐 0.13.31.1:Phase A SSR fetch 期间用 loadingDialog.update 报进度
      if (self.JZVariantExpander && Array.isArray(pd.variantSkus) && pd.variantSkus.length > 0) {
        const rawAspects = self.JZVariantExpander.extractRawAspects();
        console.log('[FollowSell] rawAspects:', rawAspects?.length, 'axes');
        const needExpand = rawAspects.length >= 1; // 有 aspects 就尝试弹窗补全
        if (needExpand) {
          try {
            // 进度回调:更新 Phase A 弹窗的 done/total
            const onProgress = (done, total) => {
              if (total > 0) loadingDialog.update(total, done);
            };
            // 最多等 15s,超时则用原 variants 开面板(给 SSR 多页 fetch 留足时间)
            const expanded = await Promise.race([
              self.JZVariantExpander.expandVariants(pd.variantSkus, pd, onProgress),
              new Promise((resolve) => setTimeout(() => resolve(pd.variantSkus), 15000)),
            ]);
            if (Array.isArray(expanded) && expanded.length > (pd.variantSkus?.length || 0)) {
              console.log(`[FollowSell] 变体展开:${pd.variantSkus.length} → ${expanded.length}`);
              pd.variantSkus = expanded;
            } else {
              console.log('[FollowSell] 变体展开未增加(可能已完整或 fetch 失败),用原', pd.variantSkus.length, '个');
            }
          } catch (e) {
            console.warn('[FollowSell] 变体展开失败,用原变体开面板:', e?.message);
          }
        }
      }

      // 关闭 loading 弹窗,打开主面板
      closeLoading();
      createPanel(pd);
    } catch (err) {
      console.error('[FollowSell] toggle 流程异常:', err);
      closeLoading();
      // 异常时也尝试打开面板(用已有数据),避免用户卡死
      try {
        const pd = self.JZProductExtractor.extractProductData();
        createPanel(pd);
      } catch (e2) {
        console.error('[FollowSell] 异常恢复开面板失败:', e2?.message);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // 流水线进度弹窗(对齐原项目 pipeline loading dialog)
  // ────────────────────────────────────────────────────────────
  function createPipelineLoadingDialog() {
    // 注入 keyframes(只一次)
    if (!document.getElementById('xy-fs-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'xy-fs-spinner-style';
      style.textContent =
        '@keyframes xy-fs-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }
    const dialog = document.createElement('div');
    dialog.className = 'xy-fs-pipeline-loading';
    dialog.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div class="xy-fs-spinner"></div>
        <div style="font-size:15px;font-weight:600;color:#0f172a;">正在准备跟卖面板</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div data-progress="phaseA" style="display:none;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#475569;margin-bottom:4px;">
            <span>展开变体</span><span data-text="phaseA">0/0</span>
          </div>
          <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
            <div data-bar="phaseA" style="height:100%;width:0%;background:#3b82f6;transition:width 0.3s;"></div>
          </div>
        </div>
      </div>
      <div style="margin-top:14px;font-size:11.5px;color:#94a3b8;text-align:center;">完成后将自动打开跟卖面板</div>
    `;
    document.body.appendChild(dialog);
    return {
      dialog,
      update(aTotal, aDone) {
        const phaseA = dialog.querySelector('[data-progress="phaseA"]');
        if (aTotal > 0) {
          phaseA.style.display = 'block';
          dialog.querySelector('[data-text="phaseA"]').textContent = `${aDone}/${aTotal}`;
          dialog.querySelector('[data-bar="phaseA"]').style.width = `${(aDone / aTotal) * 100}%`;
        }
      },
      close() {
        dialog.remove();
      },
    };
  }

  // bindTabs —— 旧 API 兼容(content.js 仍调用,事件已在 createPanel 内绑定)
  function bindTabs() {}

  // ────────────────────────────────────────────────────────────
  // 辅助函数:严格数字解析(对齐原项目 parseStrictNumber)
  // ────────────────────────────────────────────────────────────
  function parseStrictNumber(raw) {
    const s = String(raw || '')
      .replace(',', '.')
      .trim();
    return /^-?\d+(?:\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }

  // 从 sv.attributes 读整数 attr(对齐原项目 readSourceInt)
  function readSourceInt(sv, key) {
    if (!sv?.attributes) return NaN;
    const a = sv.attributes.find((x) => String(x?.key) === String(key));
    if (!a) return NaN;
    const v = a.value ?? (Array.isArray(a.collection) ? a.collection[0] : '');
    const n = parseStrictNumber(v);
    return isFinite(n) && n > 0 ? Math.round(n) : NaN;
  }

  // 从 sv.attributes 读 4383(kg 浮点)转 g(对齐原项目 readSourceWeightKgAsG)
  function readSourceWeightKgAsG(sv) {
    const n = readSourceInt(sv, '4383');
    if (!isFinite(n)) return NaN;
    return n < 100 ? Math.round(n * 1000) : n; // <100 视为 kg
  }

  // 中文检测(对齐原项目 _isCN)
  function _isCN(s) {
    return /[\u4e00-\u9fff]/.test(String(s || ''));
  }

  // 图片去重累积器(对齐原项目 pushUrl)
  function makeImageAccumulator() {
    const seen = new Set();
    return {
      push(url, arr) {
        const u = String(url || '')
          .split('?')[0]
          .split('#')[0]
          .toLowerCase();
        if (!u || seen.has(u)) return;
        seen.add(u);
        arr.push(url);
      },
    };
  }

  // pickItemForSku:从 searchVariants items[] 选匹配 SKU 的 item(对齐原项目)
  function pickItemForSku(items, sku) {
    if (!Array.isArray(items) || items.length === 0) return null;
    // attr 9024(Артикул)值以 sku+'-' 或等于 sku 为前缀匹配
    const matchSku = (it) => {
      const attrs = it?.attributes || it?._sourceVariant?.attributes || [];
      const a = attrs.find((x) => String(x?.key) === '9024');
      const v = a?.value || '';
      return v === sku || v.startsWith(sku + '-');
    };
    const matched = items.filter(matchSku);
    if (matched.length === 0) return items[0];
    if (matched.length === 1) return matched[0];
    // 多匹配:按可变特性 collection 大小评分,选最"纯净"的
    const score = (it) => {
      const attrs = it?.attributes || [];
      let s = 0;
      for (const k of ['10096', '22814', '8219']) {
        const a = attrs.find((x) => String(x?.key) === k);
        if (a?.collection) s += a.collection.length;
      }
      return s;
    };
    matched.sort((a, b) => score(a) - score(b));
    return matched[0];
  }

  // 错误文案人性化(对齐 0.13 ozon-product.js:9205-9233)
  function humanizeError(msg) {
    const s = String(msg || '');
    // 限流/配额
    if (/IMPORT_RATE_LIMIT|429|RATE_LIMITED/.test(s)) return 'Ozon 限流,请稍后重试(每分钟最多 30 次)';
    if (/IMPORT_ACTIVE_TASK_LIMIT/.test(s)) return '已有上架任务在处理中,请稍候';
    if (/QUOTA_EXCEEDED|配额|额度/.test(s)) return '会员配额已用尽,请升级套餐或稍后重试';
    // 鉴权/反爬
    if (/AUTH_EXPIRED|AUTH_TOKEN_EXPIRED|401|登录已过期/.test(s)) return '登录已过期,请重新登录';
    if (/AUTH_REQUIRED|sc_company_id/.test(s)) return 'seller.ozon.ru 登录态失效,请刷新页面后重试';
    if (/ANTIBOT_BLOCKED|反爬|challenge|captcha/.test(s)) return '触发反爬挑战,请稍后重试或更换网络';
    if (/PERMISSION_DENIED|NO_SELLER_TAB|未打开 seller/.test(s)) return '请先访问 seller.ozon.ru 并登录店铺';
    // 公司一致性护栏
    if (/公司.*不一致|store_company_id|店铺.*登录/.test(s))
      return '所选店铺与浏览器登录店铺不一致,请切换浏览器登录该店铺后重试';
    // 网络/超时
    if (/TIMEOUT|超时/.test(s)) return '请求超时,请检查网络后重试';
    if (/NETWORK_ERROR|网络/.test(s)) return '网络错误,请检查网络连接后重试';
    // 业务校验
    if (/items.length must be <= 200|单次最多/.test(s)) return '单次最多 200 个商品,请分批提交';
    if (/NOT_FOUND|未.*找到|未在平台/.test(s)) return 'SKU 未在平台找到,请确认 SKU 正确';
    if (/invalid.*image|无效图片|图片.*失败/.test(s)) return '部分图片无效已自动剔除';
    return s.slice(0, 200);
  }

  // ────────────────────────────────────────────────────────────
  // prefetchSourceVariantWithItems —— Gate check + 降级链
  // 对齐原项目 prefetchSourceVariantWithItems(9520-9601)
  // 返回:false(gate 失败) 或 { sv, items }
  // ────────────────────────────────────────────────────────────
  async function prefetchSourceVariantWithItems(sku, showStatus) {
    const attempt = async () => {
      try {
        const resp = await sendMessage('searchVariants', { sku });
        // SW 返回 { ok:true, data: sv } 或 { ok:false, error, code }
        if (resp?.ok && resp.data) return { sv: resp.data, error: null, code: null };
        return { sv: null, error: resp?.error || 'UNKNOWN_ERROR', code: resp?.code || resp?.error };
      } catch (e) {
        return { sv: null, error: e?.message || String(e), code: e?.code || 'UNKNOWN_ERROR' };
      }
    };

    showStatus('info', '正在查询商品变体信息...');
    let result = await attempt();

    // 重试:AUTH_REQUIRED/ANTIBOT_BLOCKED 时 syncSellerCookies 后再试一次
    if (!result.sv && result.code) {
      const isRetryable = ['AUTH_REQUIRED', 'ANTIBOT_BLOCKED', 'NO_SELLER_TAB'].includes(result.code);
      if (isRetryable) {
        showStatus('info', '正在刷新卖家中心登录状态...');
        await sendMessage('syncSellerCookies', {});
        showStatus('info', '正在重新查询商品变体信息...');
        result = await attempt();
      }
      if (!result.sv && result.code && result.code !== 'NOT_FOUND') {
        const hints = {
          NO_SELLER_TAB: '未打开 seller.ozon.ru,请先访问并登录',
          AUTH_REQUIRED: 'seller.ozon.ru 登录态失效,请重新登录',
          ANTIBOT_BLOCKED: 'seller.ozon.ru 反爬拦截,请稍后重试或刷新页面',
          TIMEOUT: '请求超时,请检查网络后重试',
          NETWORK_ERROR: '网络错误,请检查网络后重试',
        };
        showStatus('error', hints[result.code] || humanizeError(result.error));
        return false;
      }
    }

    // sv 没命中(陌生 SKU)→ 降级 /api/v1/search 全平台
    if (!result.sv && result.code === 'NOT_FOUND') {
      try {
        showStatus('info', '正在全平台查询该 SKU...');
        const searchResp = await sendMessage('searchProductBySku', { sku });
        const items = searchResp?.data?.items || [];
        if (items.length > 0) {
          const sv = pickItemForSku(items, sku) || items[0];
          sendMessage('syncSellerCookies', {}).catch(() => {});
          return { sv, items };
        }
      } catch (e) {
        console.warn('[prefetch] searchProductBySku 降级失败:', e?.message || e);
      }
    }

    if (result.sv) {
      sendMessage('syncSellerCookies', {}).catch(() => {});
      return { sv: result.sv, items: [result.sv] };
    }

    // 网络层无错但也没 sv(空 items),上层走类目回退
    return { sv: null, items: [] };
  }

  // ────────────────────────────────────────────────────────────
  // 渲染上架结果固定展示区(Phase 7.5 调 /v1/product/import/info 后填充)
  // items[]: { offer_id, product_id, status: 'imported'|'failed'|'pending'|'skipped', errors[] }
  // ────────────────────────────────────────────────────────────
  function renderResultPanel(panel, items) {
    const resultPanel = panel.querySelector('[data-field="result-panel"]');
    const summaryEl = panel.querySelector('[data-field="result-summary"]');
    const bodyEl = panel.querySelector('[data-field="result-body"]');
    if (!resultPanel || !summaryEl || !bodyEl) return;

    if (!Array.isArray(items) || items.length === 0) {
      resultPanel.style.display = 'none';
      return;
    }

    const imported = items.filter((x) => x.status === 'imported').length;
    const failed = items.filter((x) => x.status === 'failed').length;
    const pending = items.filter((x) => x.status === 'pending' || x.status === 'skipped').length;

    // 摘要
    let summaryClass = 'is-success';
    let summaryText = `成功 ${imported}/${items.length}`;
    if (failed > 0 && imported === 0) {
      summaryClass = 'is-failed';
      summaryText = `失败 ${failed}/${items.length}`;
    } else if (failed > 0 || pending > 0) {
      summaryClass = 'is-pending';
      summaryText = `成功 ${imported} / 失败 ${failed} / 处理中 ${pending} (共 ${items.length})`;
    }
    summaryEl.className = `xy-fs-result-summary ${summaryClass}`;
    summaryEl.textContent = summaryText;

    // 明细行(多店模式下每行带店铺名前缀)
    const statusLabel = { imported: '已创建', failed: '失败', pending: '处理中', skipped: '跳过' };
    bodyEl.innerHTML = items
      .map((it) => {
        const st = String(it.status || 'pending');
        const label = statusLabel[st] || st;
        const errText = (it.errors || [])
          .map(
            (e) =>
              `${e.message || e.description || e.code || ''}${e.field ? ` [${e.field}]` : ''}${e.attribute_name ? ` (${e.attribute_name})` : ''}`
          )
          .filter(Boolean)
          .join('; ');
        const productId = it.product_id ? ` (product_id: ${it.product_id})` : '';
        const storeTag = it._storeName
          ? `<span style="color:#64748b;font-size:11px;">[${esc(it._storeName)}] </span>`
          : '';
        return `
          <div class="xy-fs-result-row">
            <span class="xy-fs-result-row-offer" title="${esc(it.offer_id || '')}">${storeTag}${esc(it.offer_id || '—')}${productId}</span>
            <span class="xy-fs-result-row-status ${esc(st)}">${esc(label)}</span>
            <span class="xy-fs-result-row-err">${errText ? esc(errText) : '<span style="color:#52c41a">无错误</span>'}</span>
          </div>`;
      })
      .join('');

    resultPanel.style.display = 'block';
  }

  // ────────────────────────────────────────────────────────────
  // 提交主流程(对齐原项目 handleMultiVariantFollowSell,7 阶段完整复刻)
  // ────────────────────────────────────────────────────────────
  async function handleSubmit(panel, productData) {
    const statusDiv = panel.querySelector('[data-field="mv-status"]');
    const btn = panel.querySelector('[data-action="submit"]');
    const showStatus = (type, msg) => {
      statusDiv.className = `xy-fs-status xy-fs-status-${type}`;
      statusDiv.textContent = msg;
    };

    // UI 锁定(对齐原项目 _confirmBtn.disabled = true)
    btn.disabled = true;
    const _unlockUI = () => {
      btn.disabled = false;
    };

    try {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 1:校验(对齐原项目 8404-8532)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const portalFlagOn = await isPortalImportEnabled();
      const uploadModeEl = panel.querySelector('input[name="jz-upload-mode"]:checked');
      const viaPortal = portalFlagOn && uploadModeEl?.value === 'portal';
      console.log('[FollowSell] Phase 1 viaPortal 判定:', {
        portalFlagOn,
        uploadModeValue: uploadModeEl?.value,
        uploadModeExists: !!uploadModeEl,
        viaPortal,
      });

      // viaPortal 仅支持单店(Demo 单店,跳过多店校验)
      if (viaPortal) {
        showStatus('info', '灰度开关已开启,走模拟手动上架...');
      } else {
        showStatus('info', '走官方 API 路径...');
      }

      // 收集勾选的变体行(对齐 0.13.31.1 createMultiVariantFollowSellPanel 全字段)
      // 每行读取:sku/price/minprice/oldprice/stock/depth/width/height/weight/offerId
      const cfg = await fetchExtensionConfig();
      const PRICE_MAX = cfg.price_max ?? 9_999_999;
      const STOCK_MAX = cfg.stock_max ?? 1_000_000;
      const OLD_PRICE_RATIO = cfg.old_price_ratio ?? 1.25;
      const DISCOUNT_THRESHOLD = cfg.discount_threshold ?? 0.15;
      const checkedRows = [];
      const rowChecks = panel.querySelectorAll('.xy-fs-check:checked');
      rowChecks.forEach((cb) => {
        const tr = cb.closest('tr');
        if (!tr) return;
        const rowSku = tr.getAttribute('data-sku') || '';
        const idx = cb.getAttribute('data-idx') || '0';
        const priceVal = parseFloat(
          String(tr.querySelector(`.xy-fs-price[data-idx="${idx}"]`)?.value || '').replace(',', '.')
        );
        const minPriceVal = parseFloat(
          String(tr.querySelector(`.xy-fs-minprice[data-idx="${idx}"]`)?.value || '').replace(',', '.')
        );
        const oldPriceVal = parseFloat(
          String(tr.querySelector(`.xy-fs-oldprice[data-idx="${idx}"]`)?.value || '').replace(',', '.')
        );
        const stockVal = parseInt(tr.querySelector(`.xy-fs-stock[data-idx="${idx}"]`)?.value || '0', 10) || 0;
        const offerIdVal = tr.querySelector(`.xy-fs-offerid[data-idx="${idx}"]`)?.value || '';
        // 物理参数:每行独立读取(留空/0 → 提交时回退到 sourceVariant 原值)
        const depthVal = parseStrictNumber(tr.querySelector(`.xy-fs-depth[data-idx="${idx}"]`)?.value);
        const widthVal = parseStrictNumber(tr.querySelector(`.xy-fs-width[data-idx="${idx}"]`)?.value);
        const heightVal = parseStrictNumber(tr.querySelector(`.xy-fs-height[data-idx="${idx}"]`)?.value);
        const weightVal = parseStrictNumber(tr.querySelector(`.xy-fs-weight[data-idx="${idx}"]`)?.value);
        if (!rowSku || !isFinite(priceVal) || priceVal <= 0 || priceVal > PRICE_MAX) return;
        // Ozon 折扣约束:缺省 old_price = price * OLD_PRICE_RATIO,折扣 < 90%
        let oldPrice = isFinite(oldPriceVal) && oldPriceVal > 0 ? oldPriceVal : priceVal * OLD_PRICE_RATIO;
        if (oldPrice <= priceVal) oldPrice = priceVal * OLD_PRICE_RATIO;
        if (oldPrice > 0 && (oldPrice - priceVal) / oldPrice >= 0.9) oldPrice = priceVal / DISCOUNT_THRESHOLD;
        checkedRows.push({
          sku: rowSku,
          price: priceVal,
          minPrice: isFinite(minPriceVal) && minPriceVal > 0 ? minPriceVal : undefined,
          oldPrice,
          stock: stockVal,
          offerId: offerIdVal,
          depth: isFinite(depthVal) && depthVal > 0 ? depthVal : undefined,
          width: isFinite(widthVal) && widthVal > 0 ? widthVal : undefined,
          height: isFinite(heightVal) && heightVal > 0 ? heightVal : undefined,
          weight: isFinite(weightVal) && weightVal > 0 ? weightVal : undefined,
          idx,
        });
      });
      if (checkedRows.length === 0) {
        showStatus('error', '请至少勾选一个有效变体(售价需为正数)');
        return _unlockUI();
      }

      // 目标店铺校验(对齐 0.13.31.1:必须至少选中 1 家店,viaPortal 限制单店)
      const selectedStoreIds = getSelectedStoreIds(panel);
      if (selectedStoreIds.length === 0) {
        showStatus('error', '请选择至少一个目标店铺');
        return _unlockUI();
      }
      if (viaPortal && selectedStoreIds.length > 1) {
        showStatus('error', '模拟手动上架仅支持单店,请只选择一个已登录 seller.ozon.ru 的店铺');
        return _unlockUI();
      }
      const totalStores = selectedStoreIds.length;
      console.log(`[FollowSell] 目标店铺 ${totalStores} 家:`, selectedStoreIds);

      // 会员配额校验(按 勾选变体数 × 店铺数 = 实际上架条数)
      const totalListingCount = checkedRows.length * totalStores;
      const memRes = await sendMessage('getMembershipSummary', {});
      if (memRes?.ok && memRes.data) {
        const quota = evaluateListingQuota(memRes.data, totalListingCount);
        if (quota.blocked) {
          showStatus('error', quota.message);
          return _unlockUI();
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 2:页面数据抓取(对齐原项目 8534-8560、8814-8834)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      showStatus('info', 'Phase 2: 抓取页面数据...');
      const extractor = self.JZProductExtractor;
      const breadcrumbs = extractor.extractBreadcrumbs();
      const pageProduct = extractor.extractProductData();
      const sharedHashtags = extractor.extractKeywords(); // 只保留 # 开头的
      // 页面三维(从 characteristics 解析)
      const chars = extractor.extractCharacteristics();
      const pageScrapedDims = extractor.parseScrapedDimensionsFromCharacteristics(chars);
      // 同步刷新页面数据预览
      initPageDataPreview(panel, pageProduct);

      // 锚点图册与富内容预填(对齐原项目 8547-8560)
      const galleryMap = new Map(); // sku → 图册 URL[]
      const richContentMap = new Map(); // sku → 富内容 11254
      const sku = pageProduct.sku || '000000000';
      if (pageProduct.images?.length > 0) {
        galleryMap.set(sku, [...pageProduct.images]);
      } else if (pageProduct.coverImage) {
        galleryMap.set(sku, [pageProduct.coverImage]);
      }
      // 锚点富内容:fetchVariantGallery 从 entrypoint-api 抓
      showStatus('info', 'Phase 2: 抓取锚点图册与富内容...');
      const anchorSrc = await extractor.fetchVariantGallery(window.location.pathname);
      if (anchorSrc.richContent) richContentMap.set(sku, anchorSrc.richContent);
      if (anchorSrc.images?.length > 0 && !galleryMap.has(sku)) {
        galleryMap.set(sku, anchorSrc.images);
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 3:多变体预取(对齐原项目 8541-8787,loop 所有勾选 SKU)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const sourceMap = new Map(); // sku → sv
      const matched = [];
      const skipped = [];
      let sharedBundleComplex = null;

      for (let i = 0; i < checkedRows.length; i++) {
        const rowSku = checkedRows[i].sku;
        showStatus('info', `Phase 3: 预取变体 ${i + 1}/${checkedRows.length} (SKU ${rowSku})...`);
        const gate = await prefetchSourceVariantWithItems(rowSku, showStatus);
        if (gate === false) {
          skipped.push(rowSku);
          continue;
        }
        if (gate.sv) {
          sourceMap.set(rowSku, gate.sv);
          matched.push(rowSku);
          if (!sharedBundleComplex) sharedBundleComplex = gate.sv._bundleComplexAttrs || null;
        } else {
          skipped.push(rowSku);
        }
      }

      if (matched.length === 0) {
        showStatus('error', '所有变体预取失败,无法上架');
        return _unlockUI();
      }

      // 同步刷新变体数据预览(显示首个匹配的 sv)
      const variantContainer = panel.querySelector('[data-field="variant-data-preview"]');
      const firstSv = sourceMap.get(matched[0]);
      if (firstSv) variantContainer.innerHTML = renderVariantData(firstSv);

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 4:视频转存(对齐原项目 8789-8806 + captureAndTransferPageVideoMedia)
      // ⚠️ 视频转存太耗时(mp4 下载 + multipart 上传,单视频 30-90s),
      //    默认关闭以加速上架。需要时把 ENABLE_VIDEO_TRANSFER 改为 true 即可。
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const ENABLE_VIDEO_TRANSFER = false;
      let sharedVideo = null;
      const srcMp4 = ENABLE_VIDEO_TRANSFER ? extractor.extractVideoUrl() : '';
      const videoCover = ENABLE_VIDEO_TRANSFER ? extractor.extractVideoCover() : null;
      if (srcMp4) {
        showStatus('info', 'Phase 4: 转存视频...');
        try {
          btn.textContent = '转存视频…';
          const vRes = await sendMessage('uploadFollowSellVideo', { srcUrl: srcMp4 });
          if (vRes?.ok && vRes.url) {
            sharedVideo = { url: vRes.url, cover: videoCover || null };
            console.log('[FollowSell] 视频已转存:', vRes.url);
          }
        } catch (e) {
          console.warn('[FollowSell] 视频转存失败,跳过视频:', e?.message || e);
        } finally {
          btn.textContent = '上架中...';
        }
      } else if (!ENABLE_VIDEO_TRANSFER) {
        console.log('[FollowSell] Phase 4 视频转存已关闭(ENABLE_VIDEO_TRANSFER=false),跳过');
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 5:多变体 items[] 组装(对齐原项目 8821-9045,loop 所有匹配变体)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      showStatus('info', `Phase 5: 组装 ${matched.length} 个变体数据...`);
      console.log(`[FollowSell] Phase 5 开始: 组装 ${matched.length} 个变体`);

      // 货币代码:多店扇出时按 per-store currency 覆盖(见 Phase 6),
      // 这里先用面板"上架货币"下拉框的值作为默认(已与店铺联动)。
      const currentStore = await getCurrentStore();
      const currencySelect = panel.querySelector('[data-field="currency"]');
      const defaultCurrencyCode = String(currencySelect?.value || currentStore.currency_code || 'RUB').toUpperCase();
      console.log(`[FollowSell] 默认货币: ${defaultCurrencyCode}(多店扇出时按 per-store 覆盖)`);

      const imageOrder = panel.querySelector('[data-field="image-order"]')?.value || 'keep';

      // 水印配置(P3:读取 UI 开关 + 模板 ID,拉取模板 config)
      const applyWatermarkToggle = !!panel.querySelector('[data-field="apply-watermark"]')?.checked;
      const watermarkTemplateId = panel.querySelector('[data-field="watermark-template-id"]')?.value || '';
      let watermarkTplConfig = null;
      if (applyWatermarkToggle && watermarkTemplateId) {
        const templates = await fetchWatermarkTemplates();
        const tpl = templates.find((t) => String(t.id) === String(watermarkTemplateId));
        watermarkTplConfig = tpl?.config || null;
      }
      const applyWatermarkEnabled = applyWatermarkToggle && !!watermarkTplConfig;

      const customDescription = panel.querySelector('[data-field="custom-description"]')?.value || '';
      const items = [];

      for (const row of checkedRows) {
        const vSku = row.sku;
        const sv = sourceMap.get(vSku) || null;
        if (!sv) continue; // 预取失败的跳过

        // 5.1 物理参数优先级:row(每行 input) > sv[4497] > sv[4383 kg→g] > undefined
        // (对齐 0.13.31.1:物理参数从变体表格每行读取,不再用面板级共享)
        const weight =
          isFinite(row.weight) && row.weight > 0
            ? row.weight
            : readSourceInt(sv, '4497') || readSourceWeightKgAsG(sv) || undefined;
        const depth = isFinite(row.depth) && row.depth > 0 ? row.depth : readSourceInt(sv, '9454') || undefined;
        const width = isFinite(row.width) && row.width > 0 ? row.width : readSourceInt(sv, '9455') || undefined;
        const height = isFinite(row.height) && row.height > 0 ? row.height : readSourceInt(sv, '9456') || undefined;

        // 5.2 富内容注入 sv
        const variantRichContent = richContentMap.get(vSku) || richContentMap.get(sku) || '';
        if (variantRichContent && sv) {
          if (!Array.isArray(sv.attributes)) sv.attributes = [];
          if (!sv.attributes.some((a) => String(a.key) === '11254')) {
            sv.attributes.push({ key: '11254', value: variantRichContent });
          }
        }

        // 5.3 图片选择优先级链:variantGallery > sv[4194+4195] > coverImage
        const acc = makeImageAccumulator();
        const allImages = [];
        let imageSource = 'coverImage';
        const variantGallery = galleryMap.get(vSku) || galleryMap.get(sku) || [];
        if (variantGallery.length > 0) {
          variantGallery.forEach((u) => acc.push(u, allImages));
          imageSource = 'pageState';
        }
        if (allImages.length === 0 && sv?.attributes) {
          const mainImg = sv.attributes.find((a) => String(a.key) === '4194')?.value;
          const galleryAttr = sv.attributes.find((a) => String(a.key) === '4195');
          if (mainImg) acc.push(mainImg, allImages);
          if (galleryAttr?.collection) galleryAttr.collection.forEach((u) => acc.push(u, allImages));
          if (allImages.length > 0) imageSource = 'sourceVariant';
        }
        if (allImages.length === 0 && pageProduct.coverImage) {
          acc.push(pageProduct.coverImage, allImages);
        }
        // imageOrder 应用
        if (allImages.length > 1) {
          if (imageOrder === 'shuffle') {
            for (let i = allImages.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [allImages[i], allImages[j]] = [allImages[j], allImages[i]];
            }
          } else if (imageOrder === 'shuffle_keep_first') {
            const first = allImages.shift();
            for (let i = allImages.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [allImages[i], allImages[j]] = [allImages[j], allImages[i]];
            }
            allImages.unshift(first);
          }
        }
        const productImages = allImages.map((url, i) => ({ file_name: url, default: i === 0 }));

        // P3:水印渲染(开启时逐张 Canvas 打水印,失败则保留原图)
        if (applyWatermarkEnabled) {
          for (const pImg of productImages) {
            try {
              const out = await applyWatermarkToImageUrl(pImg.file_name, watermarkTplConfig);
              if (out) {
                pImg.file_name = out;
                pImg._watermarked = true;
              }
            } catch (e) {
              console.warn('[Watermark] 单图渲染失败,保留原图:', pImg.file_name, e?.message);
            }
          }
        }

        // 5.4 名称取值(翻译检测)
        let variantName = pageProduct.title || 'Demo 商品';
        if (sv?.attributes) {
          const nameAttr = sv.attributes.find((a) => String(a.key) === '4180');
          const sourceName = nameAttr?.value || '';
          if (sourceName) {
            const looksTranslated = _isCN(variantName) && !_isCN(sourceName);
            variantName = looksTranslated ? sourceName : variantName;
          }
        }
        variantName = String(variantName).slice(0, 200);

        // 5.5 描述
        const scrapedDescription = contentCopy?.pickFollowSellDescription
          ? contentCopy.pickFollowSellDescription({
              customDescription,
              sourceVariant: sv,
              richContent: variantRichContent,
              fallbackName: variantName,
              max: 4096,
            })
          : String(customDescription || variantName).slice(0, 4096);

        // 5.6 主题标签注入 sv
        if (sharedHashtags.length > 0 && sv) {
          contentCopy?.mergeSourceHashtagsIntoVariant?.(sv, sharedHashtags);
        }

        // 5.7 bundleComplex(商品级兜底)
        const bundleComplex = sv?._bundleComplexAttrs || sharedBundleComplex || undefined;

        // 5.8 组装 item(对齐 0.13.31.1:含 min_price 字段;currency_code 多店扇出时按 per-store 覆盖)
        items.push({
          offer_id: row.offerId || `SKU${vSku}-${Date.now().toString().slice(-4)}`,
          name: variantName,
          price: row.price.toFixed(2),
          old_price: row.oldPrice.toFixed(2),
          ...(row.minPrice != null ? { min_price: row.minPrice.toFixed(2) } : {}),
          vat: '0',
          currency_code: defaultCurrencyCode,
          images: productImages,
          bundleComplexAttrs: bundleComplex,
          ...(sharedVideo?.url ? { videoUrl: sharedVideo.url } : {}),
          ...(sharedVideo?.cover ? { videoCover: sharedVideo.cover } : {}),
          scraped_breadcrumbs: breadcrumbs,
          scraped_description: scrapedDescription,
          ...(sharedHashtags.length > 0 ? { _aiHashtags: sharedHashtags } : {}),
          scraped_sku: String(vSku),
          scraped_brand: 'no_brand',
          _sourceVariant: sv || undefined,
          weight,
          ...(weight != null ? { weight_unit: 'g' } : {}),
          depth,
          width,
          height,
          ...(depth != null || width != null || height != null ? { dimension_unit: 'mm' } : {}),
          scraped_weight: pageScrapedDims.weight,
          scraped_depth: pageScrapedDims.depth,
          scraped_width: pageScrapedDims.width,
          scraped_height: pageScrapedDims.height,
          _stock: row.stock,
          _imageSource: imageSource,
        });
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 6:多店扇出提交(对齐原项目 9098-9200 Promise.allSettled fan-out)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      showStatus(
        'info',
        totalStores > 1
          ? `Phase 6: 正在向 ${totalStores} 个店铺并行提交 ${items.length} 个商品...`
          : `Phase 6: ${viaPortal ? '模拟手动上架' : '官方 API'}提交...`
      );
      console.log(
        `[FollowSell] Phase 5 完成: items=${items.length} 个,进入 Phase 6 多店扇出 (stores=${totalStores}, viaPortal=${viaPortal})`
      );

      // 店铺元数据查询(per-store currency / name)
      const storeList = Array.isArray(panel._followSellStoreList) ? panel._followSellStoreList : [];
      const storeNameOf = (sid) => {
        const s = storeList.find((x) => String(x.id || x.storeId) === String(sid));
        return s?.name || s?.label || s?.companyName || `店铺 ${String(sid).slice(0, 8)}`;
      };
      const storeCurrencyOf = (sid) => {
        const s = storeList.find((x) => String(x.id || x.storeId) === String(sid));
        return String(s?.currency_code || defaultCurrencyCode).toUpperCase();
      };

      // 埋点(对齐原项目 usageTrack,sw 层去重,失败静默)
      sendMessage('usageTrack', { featureKey: 'follow-sell:submit' }).catch(() => {});

      // 并行扇出:每个店铺独立 followSell 调用,per-store 覆盖 currency/warehouse
      const settledResults = await Promise.allSettled(
        selectedStoreIds.map(async (storeId) => {
          const storeName = storeNameOf(storeId);
          const storeCurrency = storeCurrencyOf(storeId);

          // Per-store items:覆盖 currency_code(各店币种可能不同)
          const perStoreItems = items.map((it) => ({ ...it, currency_code: storeCurrency }));

          // Per-store stocks:从 _selectedWarehouseByStore map 读取该店已选仓库
          // 优先级:map > 单店 UI select(仅当前 store) > 店铺配置 warehouse_id > 仓库列表第一个
          let stocks;
          try {
            const stockEntries = perStoreItems.filter((it) => Number(it._stock) > 0);
            if (stockEntries.length > 0) {
              let warehouseId = panel._selectedWarehouseByStore?.get(String(storeId)) || '';
              if (!warehouseId && String(storeId) === String(panel._followSellStoreId)) {
                warehouseId = panel.querySelector('[data-field="warehouse-id"]')?.value || '';
              }
              if (!warehouseId) {
                const s = storeList.find((x) => String(x.id || x.storeId) === String(storeId));
                warehouseId = s?.warehouse_id ? String(s.warehouse_id) : '';
              }
              if (!warehouseId) {
                const whRes = await sendMessage('getWarehouses', { storeId });
                const warehouses = whRes?.data?.warehouses || whRes?.data?.result?.warehouses || whRes?.data || [];
                warehouseId = Array.isArray(warehouses) ? warehouses[0]?.warehouse_id || warehouses[0]?.id || '' : '';
              }
              if (warehouseId) {
                stocks = stockEntries.map((it) => ({
                  offer_id: it.offer_id,
                  stock: Number(it._stock),
                  warehouse_id: warehouseId,
                }));
              }
            }
          } catch (whErr) {
            console.warn(`[FollowSell] 仓库查找失败 store=${storeName}:`, whErr?.message);
          }

          const fsRes = await sendMessage('followSell', {
            storeId,
            items: perStoreItems,
            ...(stocks?.length > 0 ? { stocks } : {}),
            viaPortal,
            applyWatermark: applyWatermarkEnabled,
            watermarkTemplateId: applyWatermarkEnabled ? watermarkTemplateId : undefined,
            applyAiRewrite: false,
            imageOrder,
          });

          if (!fsRes?.ok) throw new Error(humanizeError(fsRes?.error));
          const importResult = fsRes.data;
          const taskId = importResult?.result?.task_id;
          if (!taskId) throw new Error('未收到任务ID');

          return {
            storeId,
            storeName,
            ok: true,
            taskId,
            importResult,
            _viaPortal: !!importResult?.result?.viaPortal,
            _companyId: importResult?.result?.company_id || null,
            _taskIds: Array.isArray(importResult?.result?.task_ids) ? importResult.result.task_ids : [taskId],
          };
        })
      );

      // 扁平化结果(对齐原项目 9236-9243)
      const storeResults = settledResults.map((r, i) => {
        const storeName = storeNameOf(selectedStoreIds[i]);
        if (r.status === 'fulfilled') return r.value;
        return {
          storeId: selectedStoreIds[i],
          storeName,
          ok: false,
          error: humanizeError(r.reason?.message || r.reason),
        };
      });
      const okStores = storeResults.filter((r) => r.ok);
      const failedStores = storeResults.filter((r) => !r.ok);
      console.log(
        `[FollowSell] Phase 6 完成: 成功 ${okStores.length}/${totalStores} 店,失败 ${failedStores.length} 店`
      );

      if (okStores.length === 0) {
        const errs = failedStores.map((s) => `${s.storeName}: ${s.error}`).join('; ');
        showStatus('error', `所有店铺提交失败: ${errs}`);
        return _unlockUI();
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 7:并行轮询各店上架结果 + 聚合展示(对齐原项目 9248-9332)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      showStatus(
        'info',
        totalStores > 1
          ? `Phase 7: 正在并行确认 ${okStores.length} 个店铺的上架结果...`
          : 'Phase 7: 正在确认上架结果...'
      );

      const aggregateItems = []; // 所有店铺的 import/info items,带 _storeName 标记
      const aggregateStrictSkipped = [];
      const aggregateInvalidImage = [];

      // 并行轮询每个成功店铺
      await Promise.all(
        okStores.map(async (sres) => {
          const { storeName, importResult, _viaPortal, _companyId, _taskIds } = sres;

          // 聚合 strictSkipped / invalidImage(各店独立)
          const ss = importResult?.result?.strictSkipped || [];
          const ii = importResult?.result?.invalidImage || [];
          if (ss.length > 0) aggregateStrictSkipped.push(...ss.map((x) => ({ ...x, _storeName: storeName })));
          if (ii.length > 0) aggregateInvalidImage.push(...ii.map((x) => ({ ...x, _storeName: storeName })));

          if (_viaPortal) {
            // 门户路径:portalImportStatus 内联轮询 16s
            const deadline = Date.now() + 16000;
            for (const tid of _taskIds) {
              let st = null;
              let pollCount = 0;
              while (Date.now() < deadline) {
                pollCount++;
                const stRes = await sendMessage('portalImportStatus', {
                  taskId: String(tid),
                  companyId: _companyId,
                }).catch(() => null);
                console.log(`[FollowSell] Phase 7 门户轮询 #${pollCount} store=${storeName} task=${tid}:`, {
                  ok: stRes?.ok,
                  done: stRes?.data?.done,
                  processed: stRes?.data?.processed,
                  failed: stRes?.data?.failed,
                });
                if (stRes?.ok && stRes.data?.done) {
                  st = stRes.data;
                  break;
                }
                await new Promise((r) => setTimeout(r, 2000));
              }
              // Phase 7.5:OPI /v1/product/import/info 查每个 offer 状态
              const infoRes = await sendMessage('productImportInfo', { taskId: String(tid) }).catch(() => null);
              if (infoRes?.ok && Array.isArray(infoRes.data?.items)) {
                infoRes.data.items.forEach((it) => aggregateItems.push({ ...it, _storeName: storeName }));
              }
            }
          } else {
            // 官方 API 路径:OPI /v1/product/import/info 轮询 30s
            const opiTaskId = importResult?.result?.task_id;
            const localTaskId = importResult?.result?.local_task_id;
            if (!opiTaskId) return;
            const deadline = Date.now() + 30000;
            let storeItems = [];
            let pollCount = 0;
            while (Date.now() < deadline) {
              pollCount++;
              const infoRes = await sendMessage('productImportInfo', {
                taskId: String(opiTaskId),
                localTaskId,
              }).catch(() => null);
              console.log(`[FollowSell] Phase 7 API 轮询 #${pollCount} store=${storeName} task=${opiTaskId}:`, {
                ok: infoRes?.ok,
                itemsLen: infoRes?.data?.items?.length,
              });
              if (infoRes?.ok && Array.isArray(infoRes.data?.items) && infoRes.data.items.length > 0) {
                storeItems = infoRes.data.items;
                const pending = storeItems.filter((x) => x.status === 'pending').length;
                if (pending === 0) break;
              }
              await new Promise((r) => setTimeout(r, 3000));
            }
            storeItems.forEach((it) => aggregateItems.push({ ...it, _storeName: storeName }));
          }
        })
      );

      // 失败店铺也加入展示(以虚拟行形式)
      failedStores.forEach((s) => {
        aggregateItems.push({
          offer_id: `(店铺:${s.storeName})`,
          status: 'failed',
          errors: [{ message: s.error }],
          _storeName: s.storeName,
        });
      });

      // 结果展示
      renderResultPanel(panel, aggregateItems);
      const imported = aggregateItems.filter((x) => x.status === 'imported').length;
      const failed = aggregateItems.filter((x) => x.status === 'failed').length;
      const pending = aggregateItems.filter((x) => x.status === 'pending' || x.status === 'skipped').length;
      const okStoreCount = okStores.length;
      const failStoreCount = failedStores.length;
      const matchInfo = `变体匹配: ${matched.length}/${matched.length + skipped.length}`;
      const skippedInfo = skipped.length > 0 ? ` (SKU ${skipped.join(', ')} 使用类目回退)` : '';
      const storeInfo = failStoreCount > 0 ? ` 店铺失败 ${failStoreCount}/${totalStores}` : '';

      if (aggregateItems.length === 0) {
        showStatus('warn', `已提交 ${okStoreCount} 店,但 OPI 查询未返回商品状态,请稍后在卖家中心查看`);
      } else if (failStoreCount === 0 && failed === 0 && pending === 0) {
        showStatus(
          'success',
          `✓ 全部创建成功: ${imported}/${aggregateItems.length} (${okStoreCount} 店,${matchInfo}${skippedInfo})`
        );
      } else if (imported > 0) {
        showStatus(
          'warn',
          `部分创建成功: imported=${imported} failed=${failed} pending=${pending} (共 ${aggregateItems.length}, ${okStoreCount} 店${storeInfo})`
        );
      } else if (pending > 0 && failed === 0) {
        showStatus('info', `商品仍在处理中: pending=${pending}/${aggregateItems.length},请稍后在卖家中心查看`);
      } else {
        const errSummary = failedStores
          .map((s) => `${s.storeName}: ${s.error}`)
          .slice(0, 3)
          .join('; ');
        showStatus(
          'error',
          `创建失败: failed=${failed}/${aggregateItems.length}${storeInfo}${errSummary ? ' - ' + errSummary : ''}`
        );
      }

      // ── 严格模式跳过项 + 无效图片展示(聚合所有店铺) ──
      if (aggregateStrictSkipped.length > 0 || aggregateInvalidImage.length > 0) {
        const parts = [];
        if (aggregateStrictSkipped.length > 0) {
          parts.push(
            `严格模式跳过 ${aggregateStrictSkipped.length} 个: ${aggregateStrictSkipped
              .slice(0, 5)
              .map((s) => s.offer_id || s.sku || s)
              .join(', ')}${aggregateStrictSkipped.length > 5 ? '...' : ''}`
          );
        }
        if (aggregateInvalidImage.length > 0) {
          parts.push(
            `无效图片剔除 ${aggregateInvalidImage.length} 个: ${aggregateInvalidImage
              .slice(0, 5)
              .map((s) => s.offer_id || s.sku || s)
              .join(', ')}${aggregateInvalidImage.length > 5 ? '...' : ''}`
          );
        }
        console.warn('[FollowSell] 严格模式/无效图片(聚合):', {
          aggregateStrictSkipped,
          aggregateInvalidImage,
        });
        showStatus('warn', parts.join(' | '));
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('[FollowSell] 上架流程未捕获异常:', err);
      showStatus('error', '上架出错:' + (err?.message || err) + ',请刷新页面后重试');
    } finally {
      _unlockUI();
      btn.textContent = '一键上架至OZON';
    }
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.JZFollowSellPanel = {
    createPanel,
    toggle,
    handleSubmit,
    initPageDataPreview,
    createPipelineLoadingDialog,
    bindTabs,
  };
})();
