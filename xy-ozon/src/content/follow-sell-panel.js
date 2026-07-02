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
  // 渲染变体表格行(多变体:从 productData.variantSkus 生成,每行一个变体)
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
        const offerId = `SKU${sku}-${String(now).slice(-4)}${i > 0 ? '-' + i : ''}`;
        return `
                  <tr data-sku="${esc(sku)}" data-idx="${i}">
                    <td><input type="checkbox" class="xy-fs-check" data-idx="${i}" checked></td>
                    <td><img src="${esc(cover)}" class="xy-fs-thumb" onerror="this.style.display='none'"></td>
                    <td class="xy-fs-variant-cell">${esc(title)}</td>
                    <td><span class="xy-fs-sku">${esc(sku) || '—'}</span></td>
                    <td><input type="text" class="xy-fs-input xy-fs-offerid" data-idx="${i}" value="${esc(offerId)}" size="12"></td>
                    <td><span class="xy-fs-price-original">${esc(rawPrice)}</span></td>
                    <td><input type="number" class="xy-fs-input xy-fs-price" data-idx="${i}" value="${esc(priceNum)}" min="0" step="0.01" size="8"></td>
                    <td><input type="number" class="xy-fs-input xy-fs-oldprice" data-idx="${i}" value="" placeholder="自动" min="0" step="0.01" size="8"></td>
                    <td><input type="number" class="xy-fs-input xy-fs-stock" data-idx="${i}" value="10" min="0" size="5"></td>
                    <td><button class="xy-fs-delete-btn" data-idx="${i}">删除</button></td>
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

  // 填充面板的 store 下拉框,并按当前选中店铺设默认值
  // 缓存为空时主动从后端拉取(不依赖 popup 是否打开过)
  // 监听 change 事件:同步到 chrome.storage + 联动货币下拉框
  async function populateStoreSelect(panel) {
    const select = panel.querySelector('[data-field="store"]');
    const currencySelect = panel.querySelector('[data-field="currency"]');
    if (!select) return;

    let { ozonStores, ozonStoreId } = await chrome.storage.local.get(['ozonStores', 'ozonStoreId']);
    let stores = Array.isArray(ozonStores) ? ozonStores : [];

    // 缓存为空:主动从后端拉取(service-worker getStores → /auth/ozon-stores)
    if (stores.length === 0) {
      try {
        const resp = await sendMessage({ type: 'getStores' });
        if (resp?.ok && Array.isArray(resp.data)) {
          stores = resp.data;
          await chrome.storage.local.set({ ozonStores: stores });
          console.log('[FollowSell] 主动拉取店铺列表:', stores.length, '个');
        }
      } catch (e) {
        console.warn('[FollowSell] 拉取店铺列表失败:', e?.message);
      }
    }

    if (stores.length === 0) return;

    const current = ozonStoreId || stores[0]?.id || '';
    select.innerHTML = stores
      .map((s) => {
        const cur = s.currency_code ? ` (${s.currency_code})` : '';
        const sel = s.id === current ? ' selected' : '';
        return `<option value="${esc(s.id)}"${sel}>${esc(s.name || s.id)}${esc(cur)}</option>`;
      })
      .join('');

    // 初始联动货币下拉框
    syncCurrencySelect(stores, current, currencySelect);

    // 面板内切换 store:同步存储 + 联动货币 + 重新拉取仓库列表
    select.addEventListener('change', () => {
      const val = select.value;
      if (val) {
        chrome.storage.local.set({ ozonStoreId: val });
        syncCurrencySelect(stores, val, currencySelect);
        populateWarehouseSelect(panel, val);
        console.log('[FollowSell] 面板切换店铺:', val);
      }
    });

    // 面板打开时同步拉取当前店铺的仓库列表
    populateWarehouseSelect(panel, current);
  }

  // 填充物流仓库下拉框:从后端 /ozon/warehouses 拉取该店铺的仓库列表
  // 默认选中店铺配置的 warehouse_id;列表为空或拉取失败时显示占位
  async function populateWarehouseSelect(panel, storeId) {
    const select = panel.querySelector('[data-field="warehouse-id"]');
    if (!select) return;

    select.innerHTML = '<option value="">加载中...</option>';

    if (!storeId) {
      select.innerHTML = '<option value="">请先选择店铺</option>';
      return;
    }

    let warehouses = [];
    try {
      const resp = await sendMessage('getWarehouses', { storeId });
      // resp.data 可能是数组(OPI raw [{warehouse_id,...}] 或 fallback [{id,...}])
      warehouses = resp?.data?.warehouses || resp?.data?.result?.warehouses || resp?.data || [];
      if (!Array.isArray(warehouses)) warehouses = [];
    } catch (e) {
      console.warn('[FollowSell] 拉取仓库列表失败:', e?.message);
    }

    if (warehouses.length === 0) {
      select.innerHTML = '<option value="">无可用仓库</option>';
      return;
    }

    // 读取当前店铺的默认 warehouse_id 用于默认选中
    let defaultWhId = '';
    try {
      const { ozonStores } = await chrome.storage.local.get(['ozonStores']);
      const stores = Array.isArray(ozonStores) ? ozonStores : [];
      const store = stores.find((s) => s.id === storeId);
      defaultWhId = store?.warehouse_id ? String(store.warehouse_id) : '';
    } catch {}

    select.innerHTML = warehouses
      .map((w) => {
        const wid = w.warehouse_id ?? w.id ?? '';
        const name = w.name || `仓库 ${wid}`;
        return `<option value="${esc(String(wid))}">${esc(name)}</option>`;
      })
      .join('');

    // 选中默认仓库:店铺配置优先,否则第一个
    const matchId = defaultWhId && warehouses.some((w) => String(w.warehouse_id ?? w.id) === defaultWhId);
    select.value = matchId ? defaultWhId : String(warehouses[0]?.warehouse_id ?? warehouses[0]?.id ?? '');
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

  // 根据店铺的 currency_code 同步货币下拉框 + 价格 label 符号(店铺 → 货币 联动)
  function syncCurrencySelect(stores, storeId, currencySelect) {
    if (!currencySelect) return;
    const store = stores.find((s) => s.id === storeId);
    const cur = store?.currency_code ? String(store.currency_code).toUpperCase() : 'RUB';
    // 下拉框已有该选项则选中,否则新建一个并选中
    let opt = currencySelect.querySelector(`option[value="${cur}"]`);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = cur;
      currencySelect.appendChild(opt);
    }
    currencySelect.value = cur;

    // 同步更新价格 label 的货币符号(避免选 CNY 却显示 ₽)
    const symbol = CURRENCY_SYMBOL[cur] || cur;
    const priceLabel = document.querySelector('[data-field="price-label"]');
    const oldPriceLabel = document.querySelector('[data-field="old-price-label"]');
    if (priceLabel) {
      priceLabel.innerHTML = `<span class="xy-fs-required">*</span> 实际售价 (${symbol})`;
    }
    if (oldPriceLabel) {
      oldPriceLabel.textContent = `划线价 (${symbol},选填)`;
    }
    console.log('[FollowSell] 货币联动:', cur, '符号:', symbol);
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
          <!-- 01 店铺基础卡 -->
          <div class="xy-fs-card xy-fs-card-shop">
            <div class="xy-fs-card-header">
              <span class="xy-fs-card-bar" style="background:#16A34A"></span>
              <span class="xy-fs-card-no">01</span>
              <span class="xy-fs-card-title">店铺与基础</span>
              <span class="xy-fs-required-pill">必填</span>
            </div>
            <div class="xy-fs-card-body">
              <div class="xy-fs-field-grid">
                <!-- 目标店铺 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label"><span class="xy-fs-required">*</span> 目标店铺</label>
                  <select data-field="store" class="xy-fs-select">
                    <option value="store-001">Demo 店铺 001</option>
                  </select>
                </div>
                <!-- 品牌 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label"><span class="xy-fs-required">*</span> 品牌</label>
                  <select data-field="brand" class="xy-fs-select">
                    <option value="no_brand" selected>无品牌</option>
                    <option value="copy">复制当前品牌</option>
                  </select>
                </div>
                <!-- 图片顺序 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label"><span class="xy-fs-required">*</span> 图片顺序</label>
                  <select data-field="image-order" class="xy-fs-select">
                    <option value="keep">不处理</option>
                    <option value="shuffle">随机打乱</option>
                    <option value="shuffle_keep_first" selected>主图不变,其余打乱</option>
                  </select>
                </div>
                <!-- 上架货币 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label">上架货币</label>
                  <select data-field="currency" class="xy-fs-select">
                    <option value="CNY">[¥] 人民币</option>
                    <option value="USD">[$] 美元</option>
                    <option value="EUR">[€] 欧元</option>
                    <option value="RUB" selected>[₽] 卢布</option>
                  </select>
                </div>
                <!-- 价格 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label" data-field="price-label"><span class="xy-fs-required">*</span> 实际售价 (₽)</label>
                  <input type="number" class="xy-fs-input" data-field="price" value="${productData.price || '999'}" min="0" step="0.01">
                </div>
                <!-- 划线价 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label" data-field="old-price-label">划线价 (₽,选填)</label>
                  <input type="number" class="xy-fs-input" data-field="old-price" value="" placeholder="自动=售价×1.25" min="0" step="0.01">
                </div>
                <!-- 库存 -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label">库存</label>
                  <input type="number" class="xy-fs-input" data-field="stock" value="10" min="0">
                </div>
                <!-- offer_id -->
                <div class="xy-fs-field">
                  <label class="xy-fs-label">offer_id</label>
                  <input type="text" class="xy-fs-input" data-field="offer-id" value="demo-${now}">
                </div>
                <!-- 合并模型名 -->
                <div class="xy-fs-field xy-fs-field-full">
                  <label class="xy-fs-label">
                    <input type="checkbox" data-field="merge-enabled"> 合并成一张卡
                  </label>
                  <input type="text" class="xy-fs-input" data-field="merge-model" placeholder="勾选后自动生成型号名,可改;留空=不合并">
                </div>
                <!-- 自定义描述 -->
                <div class="xy-fs-field xy-fs-field-full">
                  <label class="xy-fs-label">自定义描述 (选填,留空取源 4191)</label>
                  <textarea class="xy-fs-input" data-field="custom-description" rows="2" placeholder="留空则取源商品描述"></textarea>
                </div>
                <!-- 物理参数 -->
                <div class="xy-fs-field xy-fs-field-full">
                  <label class="xy-fs-label">物理参数 (选填,留空取源变体)</label>
                  <div class="xy-fs-dims">
                    <input type="text" class="xy-fs-input xy-fs-dim" data-field="weight" placeholder="重量(g)">
                    <input type="text" class="xy-fs-input xy-fs-dim" data-field="depth" placeholder="长(mm)">
                    <input type="text" class="xy-fs-input xy-fs-dim" data-field="width" placeholder="宽(mm)">
                    <input type="text" class="xy-fs-input xy-fs-dim" data-field="height" placeholder="高(mm)">
                  </div>
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

          <!-- 物流仓库卡 -->
          <div class="xy-fs-card xy-fs-card-logistics">
            <div class="xy-fs-card-header">
              <span class="xy-fs-card-bar" style="background:#8B5CF6"></span>
              <span class="xy-fs-card-title">物流仓库</span>
              <span class="xy-fs-card-hint">库存将写入各店仓库</span>
            </div>
            <div class="xy-fs-card-body">
              <select data-field="warehouse-id" class="xy-fs-select">
                <option value="">加载中...</option>
              </select>
            </div>
          </div>

          <!-- 03 变体表格卡 -->
          <div class="xy-fs-card xy-fs-card-table">
            <div class="xy-fs-card-header">
              <span class="xy-fs-card-bar" style="background:#3B82F6"></span>
              <span class="xy-fs-card-no">03</span>
              <span class="xy-fs-card-title">变体定价与规格</span>
              <span class="xy-fs-card-hint">留空或 0 = 沿用源商品属性</span>
            </div>
            <div class="xy-fs-table-wrap">
              <table class="xy-fs-table">
                <thead>
                  <tr>
                    <th style="width:36px;"><input type="checkbox" data-action="select-all" checked></th>
                    <th>主图</th>
                    <th>变体</th>
                    <th>SKU</th>
                    <th>货号</th>
                    <th>原售价</th>
                    <th>售价</th>
                    <th>划线价</th>
                    <th>库存</th>
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
                <strong data-field="footer-publish-count">1</strong> 条上架
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
    // 预填物理参数:页面规格表即时填 + 异步预取 sv 覆盖(源变体优先)
    prefillDimensionsFromPage(panel);
    prefillDimensionsFromSvAsync(panel, productData);
    return panel;
  }

  // ────────────────────────────────────────────────────────────
  // 预填物理参数 —— 页面规格表(即时,无需网络)
  // 从 characteristics 解析 weight/depth/width/height 填入输入框(仅当输入框为空时)
  // ────────────────────────────────────────────────────────────
  function prefillDimensionsFromPage(panel) {
    try {
      const extractor = self.JZProductExtractor;
      const chars = extractor.extractCharacteristics();
      const dims = extractor.parseScrapedDimensionsFromCharacteristics(chars);
      const setVal = (field, val) => {
        if (val == null || !isFinite(val)) return;
        const input = panel.querySelector(`[data-field="${field}"]`);
        if (input && !input.value) input.value = String(val);
      };
      setVal('weight', dims.weight);
      setVal('depth', dims.depth);
      setVal('width', dims.width);
      setVal('height', dims.height);
      if (dims.weight != null || dims.depth != null || dims.width != null || dims.height != null) {
        console.log('[FollowSell] 页面规格表预填尺寸:', dims);
      }
    } catch (e) {
      console.warn('[FollowSell] 页面规格表预填失败:', e?.message || e);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 预填物理参数 —— 异步预取首个变体 sv,用 sv 的 4497/9454-9456 覆盖(源变体优先)
  // 仅当输入框值仍为空或仍等于页面预填值时覆盖(不覆盖用户手输)
  // ────────────────────────────────────────────────────────────
  async function prefillDimensionsFromSvAsync(panel, productData) {
    try {
      const sku = productData.sku;
      if (!sku) return;
      const resp = await sendMessage('searchVariants', { sku });
      if (!resp?.ok || !resp.data) return;
      const sv = resp.data;
      const readSvInt = (key) => {
        const a = (sv?.attributes || []).find((x) => String(x?.key) === String(key));
        if (!a) return NaN;
        const v = a.value ?? (Array.isArray(a.collection) ? a.collection[0] : '');
        const n = parseStrictNumber(v);
        return isFinite(n) && n > 0 ? Math.round(n) : NaN;
      };
      const readSvWeightKgAsG = () => {
        const n = readSvInt('4383');
        return isFinite(n) ? (n < 100 ? Math.round(n * 1000) : n) : NaN;
      };
      const applySvDim = (field, svVal, pageVal) => {
        if (!isFinite(svVal) || svVal <= 0) return;
        const input = panel.querySelector(`[data-field="${field}"]`);
        if (!input) return;
        const cur = input.value;
        // 空或等于页面预填值 → 用 sv 覆盖(源变体优先)
        if (!cur || String(cur) === String(pageVal)) {
          input.value = String(svVal);
        }
      };
      // 页面预填值(用于判断是否可覆盖)
      const extractor = self.JZProductExtractor;
      const chars = extractor.extractCharacteristics();
      const pageDims = extractor.parseScrapedDimensionsFromCharacteristics(chars);
      applySvDim('weight', readSvInt('4497') || readSvWeightKgAsG(), pageDims.weight);
      applySvDim('depth', readSvInt('9454'), pageDims.depth);
      applySvDim('width', readSvInt('9455'), pageDims.width);
      applySvDim('height', readSvInt('9456'), pageDims.height);
      // 同时刷新变体数据预览区
      const variantContainer = panel.querySelector('[data-field="variant-data-preview"]');
      if (variantContainer && sv) variantContainer.innerHTML = renderVariantData(sv);
      console.log('[FollowSell] sv 预填尺寸完成');
    } catch (e) {
      console.warn('[FollowSell] sv 预填尺寸失败(不影响提交):', e?.message || e);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 绑定面板事件(替换旧版 bindTabs)
  // ────────────────────────────────────────────────────────────
  function updateVariantCount(panel) {
    // badge:商品总变体数(数据本身,不随勾选/显示变化)
    const totalRows = panel.querySelectorAll('[data-field="variant-tbody"] tr[data-sku]');
    const badge = panel.querySelector('[data-field="variant-badge"]');
    if (badge) badge.textContent = `${totalRows.length} 个变体`;
    // footer-publish-count:勾选行数(对齐 0.13 ozon-product.js:6920-6931 updateFooterCount)
    // xy-ozon 为单店流程,storeCount=1,故 total = sel
    const checkedCount = panel.querySelectorAll('.xy-fs-check[data-idx]:checked').length;
    const footerCount = panel.querySelector('[data-field="footer-publish-count"]');
    if (footerCount) footerCount.textContent = String(checkedCount);
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

    // 8. 灰度 flag 开启时显示上架方式 radio + 恢复持久化偏好
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
    if (self.JZVariantExpander && Array.isArray(pd.variantSkus) && pd.variantSkus.length > 0) {
      const rawAspects = self.JZVariantExpander.extractRawAspects();
      console.log('[FollowSell] rawAspects:', rawAspects?.length, 'axes');
      const needExpand = rawAspects.length >= 1; // 有 aspects 就尝试弹窗补全
      if (needExpand) {
        try {
          // 最多等 10s,超时则用原 variants 开面板
          const expanded = await Promise.race([
            self.JZVariantExpander.expandVariants(pd.variantSkus, pd),
            new Promise((resolve) => setTimeout(() => resolve(pd.variantSkus), 10000)),
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

    createPanel(pd);
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

    // 明细行
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
        return `
          <div class="xy-fs-result-row">
            <span class="xy-fs-result-row-offer" title="${esc(it.offer_id || '')}">${esc(it.offer_id || '—')}${productId}</span>
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

      // 收集勾选的变体行(多变体:从表格读取每行的 sku/price/stock/offerId)
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
        const oldPriceVal = parseFloat(
          String(tr.querySelector(`.xy-fs-oldprice[data-idx="${idx}"]`)?.value || '').replace(',', '.')
        );
        const stockVal = parseInt(tr.querySelector(`.xy-fs-stock[data-idx="${idx}"]`)?.value || '0', 10) || 0;
        const offerIdVal = tr.querySelector(`.xy-fs-offerid[data-idx="${idx}"]`)?.value || '';
        if (!rowSku || !isFinite(priceVal) || priceVal <= 0 || priceVal > PRICE_MAX) return;
        // Ozon 折扣约束:缺省 old_price = price * OLD_PRICE_RATIO,折扣 < 90%
        let oldPrice = isFinite(oldPriceVal) && oldPriceVal > 0 ? oldPriceVal : priceVal * OLD_PRICE_RATIO;
        if (oldPrice <= priceVal) oldPrice = priceVal * OLD_PRICE_RATIO;
        if (oldPrice > 0 && (oldPrice - priceVal) / oldPrice >= 0.9) oldPrice = priceVal / DISCOUNT_THRESHOLD;
        checkedRows.push({ sku: rowSku, price: priceVal, oldPrice, stock: stockVal, offerId: offerIdVal, idx });
      });
      if (checkedRows.length === 0) {
        showStatus('error', '请至少勾选一个有效变体(售价需为正数)');
        return _unlockUI();
      }

      // 会员配额校验(按勾选变体数)
      const memRes = await sendMessage('getMembershipSummary', {});
      if (memRes?.ok && memRes.data) {
        const quota = evaluateListingQuota(memRes.data, checkedRows.length);
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

      // 货币代码:优先读面板"上架货币"下拉框(已与店铺联动),
      // 回退到 currentStore.currency_code,再回退 RUB
      const currentStore = await getCurrentStore();
      const currencySelect = panel.querySelector('[data-field="currency"]');
      let currencyCode = currencySelect?.value || currentStore.currency_code || 'RUB';
      currencyCode = String(currencyCode).toUpperCase();
      console.log(`[FollowSell] 当前店铺: ${currentStore.id} (${currentStore.name || ''}), 货币: ${currencyCode}`);

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

      // 物理参数:面板级共享(所有变体用同一组 weight/depth/width/height)
      const userWeight = parseStrictNumber(panel.querySelector('[data-field="weight"]')?.value);
      const userDepth = parseStrictNumber(panel.querySelector('[data-field="depth"]')?.value);
      const userWidth = parseStrictNumber(panel.querySelector('[data-field="width"]')?.value);
      const userHeight = parseStrictNumber(panel.querySelector('[data-field="height"]')?.value);

      const customDescription = panel.querySelector('[data-field="custom-description"]')?.value || '';
      const items = [];

      for (const row of checkedRows) {
        const vSku = row.sku;
        const sv = sourceMap.get(vSku) || null;
        if (!sv) continue; // 预取失败的跳过

        // 5.1 物理参数优先级:user > sv[4497] > sv[4383 kg→g] > undefined
        const weight = isFinite(userWeight)
          ? userWeight
          : readSourceInt(sv, '4497') || readSourceWeightKgAsG(sv) || undefined;
        const depth = isFinite(userDepth) ? userDepth : readSourceInt(sv, '9454') || undefined;
        const width = isFinite(userWidth) ? userWidth : readSourceInt(sv, '9455') || undefined;
        const height = isFinite(userHeight) ? userHeight : readSourceInt(sv, '9456') || undefined;

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

        // 5.8 组装 item
        items.push({
          offer_id: row.offerId || `SKU${vSku}-${Date.now().toString().slice(-4)}`,
          name: variantName,
          price: row.price.toFixed(2),
          old_price: row.oldPrice.toFixed(2),
          vat: '0',
          currency_code: currencyCode,
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
      // Phase 6:提交(对齐原项目 9098-9200)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      showStatus('info', `Phase 6: ${viaPortal ? '模拟手动上架' : '官方 API'}提交...`);
      console.log(`[FollowSell] Phase 5 完成: items=${items.length} 个,进入 Phase 6 提交 (viaPortal=${viaPortal})`);

      // 仓库解析(对齐原项目 9122-9160)
      // 多变体:从 items[] 聚合 stocks,每个变体一个 stock 项
      // 优先用面板下拉框选中的仓库,回退到店铺配置,再回退到 getWarehouses 首个
      let stocks = undefined;
      const stockableItems = items.filter((it) => Number(it._stock) > 0);
      if (stockableItems.length > 0) {
        const whSelect = panel.querySelector('[data-field="warehouse-id"]');
        let warehouseId = whSelect?.value || currentStore.warehouse_id || null;
        if (!warehouseId) {
          try {
            const whRes = await sendMessage('getWarehouses', { storeId: currentStore.id });
            const warehouses = whRes?.data?.warehouses || whRes?.data?.result?.warehouses || whRes?.data || [];
            warehouseId = Array.isArray(warehouses) ? warehouses[0]?.warehouse_id || warehouses[0]?.id : null;
          } catch {}
        }
        if (warehouseId) {
          stocks = stockableItems.map((it) => ({
            offer_id: it.offer_id,
            stock: Number(it._stock),
            warehouse_id: warehouseId,
          }));
        }
      }

      // 埋点(对齐原项目 usageTrack)
      sendMessage('usageTrack', { featureKey: 'follow-sell:submit' }).catch(() => {});

      // followSell message(对齐原项目 9162-9185)
      const fsRes = await sendMessage('followSell', {
        storeId: currentStore.id,
        items,
        ...(stocks?.length > 0 ? { stocks } : {}),
        viaPortal,
        applyWatermark: applyWatermarkEnabled,
        watermarkTemplateId: applyWatermarkEnabled ? watermarkTemplateId : undefined,
        applyAiRewrite: false,
        imageOrder,
      });

      if (!fsRes?.ok) {
        showStatus('error', `提交失败: ${humanizeError(fsRes?.error)}`);
        return _unlockUI();
      }

      const importResult = fsRes.data;
      const taskId = importResult?.result?.task_id;
      console.log('[FollowSell] Phase 6 完成: 收到后台响应', {
        taskId,
        viaPortal: importResult?.result?.viaPortal,
        bundleIds: importResult?.result?.bundle_ids,
      });
      if (!taskId) {
        showStatus('error', '未收到任务ID');
        return _unlockUI();
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // Phase 7:结果轮询(对齐原项目 9248-9332)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (viaPortal && importResult?.result?.viaPortal) {
        // 门户上架:内联轮询 16s
        showStatus('info', 'Phase 7: 已提交卖家中心,正在确认上架结果...');
        const taskIds = Array.isArray(importResult.result.task_ids) ? importResult.result.task_ids : [taskId];
        console.log(`[FollowSell] Phase 7 开始: 门户轮询 16s, taskIds=${JSON.stringify(taskIds)}`);
        const companyId = importResult.result.company_id;
        const deadline = Date.now() + 16000;
        let totalCreated = 0;
        let totalFailed = 0;
        const allErrors = [];

        for (const tid of taskIds) {
          let st = null;
          let pollCount = 0;
          while (Date.now() < deadline) {
            pollCount++;
            const stRes = await sendMessage('portalImportStatus', { taskId: String(tid), companyId }).catch(() => null);
            console.log(`[FollowSell] Phase 7 轮询 #${pollCount} task=${tid}:`, {
              ok: stRes?.ok,
              found: stRes?.data?.found,
              status: stRes?.data?.status,
              size: stRes?.data?.size,
              processed: stRes?.data?.processed,
              failed: stRes?.data?.failed,
              warned: stRes?.data?.warned,
              done: stRes?.data?.done,
              error: stRes?.error,
            });
            if (stRes?.ok && stRes.data?.done) {
              st = stRes.data;
              break;
            }
            await new Promise((r) => setTimeout(r, 2000)); // 2s 间隔
          }
          if (st) {
            // _created = processed - failed(processed 含 failed 计数)
            totalCreated += Math.max(0, Number(st.processed || 0) - Number(st.failed || 0));
            totalFailed += Number(st.failed || 0);
            if (Array.isArray(st.errors)) allErrors.push(...st.errors);
          } else {
            console.warn(`[FollowSell] Phase 7 轮询超时(16s) task=${tid},任务可能仍在 seller 后台异步处理中`);
          }
        }

        // 结果展示(对齐原项目三种结果)
        if (totalFailed === 0 && totalCreated > 0) {
          showStatus('success', `门户上架完成！已通过卖家中心创建 ${totalCreated} 个商品`);
          // ── Phase 7.5: 调 OPI /v1/product/import/info 查询商品创建情况 ──
          // 用 task_id 查询每个 offer_id 的 status(imported/failed/pending/skipped)
          // 结果固定展示在 result-panel 区域(不被后续 showStatus 覆盖)
          try {
            console.log(
              `[FollowSell] Phase 7.5 开始: 查询 OPI /v1/product/import/info, taskIds=${JSON.stringify(taskIds)}`
            );
            showStatus('info', `正在查询商品创建情况 (OPI /v1/product/import/info)...`);
            const allItems = [];
            for (const tid of taskIds) {
              const infoRes = await sendMessage('productImportInfo', { taskId: String(tid) }).catch(() => null);
              console.log(`[FollowSell] Phase 7.5 productImportInfo task=${tid}:`, infoRes);
              if (infoRes?.ok && Array.isArray(infoRes.data?.items)) {
                allItems.push(...infoRes.data.items);
              } else {
                console.warn(`[FollowSell] Phase 7.5 task=${tid} 查询失败:`, infoRes?.error || infoRes);
              }
            }
            renderResultPanel(panel, allItems);
            // 同步状态条摘要
            const imported = allItems.filter((x) => x.status === 'imported').length;
            const failed = allItems.filter((x) => x.status === 'failed').length;
            const pending = allItems.filter((x) => x.status === 'pending' || x.status === 'skipped').length;
            if (allItems.length === 0) {
              showStatus('warn', `门户上架完成,但 OPI 查询未返回商品状态(task_id 可能不匹配)`);
            } else if (failed === 0 && pending === 0) {
              showStatus('success', `✓ 全部创建成功: ${imported}/${allItems.length} (imported)`);
            } else if (imported > 0) {
              showStatus(
                'warn',
                `部分创建成功: imported=${imported} failed=${failed} pending=${pending} (共 ${allItems.length})`
              );
            } else if (pending > 0 && failed === 0) {
              showStatus('info', `商品仍在处理中: pending=${pending}/${allItems.length},请稍后在卖家中心查看`);
            } else {
              showStatus('error', `创建失败: failed=${failed}/${allItems.length}`);
            }
          } catch (e) {
            console.warn('[FollowSell] Phase 7.5 异常(不影响上架结果):', e?.message || e);
            showStatus('warn', `门户上架完成,但查询创建详情失败: ${e?.message || e}`);
          }
        } else if (totalCreated > 0) {
          const errMsg =
            allErrors.length > 0
              ? `\n失败明细: ${allErrors
                  .slice(0, 3)
                  .map((e) => e.offer_id + ': ' + (e.errors?.[0]?.message || ''))
                  .join('; ')}`
              : '';
          showStatus('warn', `门户上架部分成功: 成功 ${totalCreated} / 失败 ${totalFailed}${errMsg}`);
        } else {
          const errMsg =
            allErrors.length > 0
              ? `\n失败明细: ${allErrors
                  .slice(0, 3)
                  .map((e) => e.offer_id + ': ' + (e.errors?.[0]?.message || ''))
                  .join('; ')}`
              : '';
          showStatus('error', `门户上架全部失败${errMsg}`);
        }
      } else {
        // 官方 API 路径:提交后轮询 OPI /v1/product/import/info 查询商品创建情况
        // task_id 是 OPI /v3/product/import 返回的,可直接查 /v1/product/import/info
        const matchInfo = `变体匹配: ${matched.length}/${matched.length + skipped.length}`;
        const skippedInfo = skipped.length > 0 ? ` (SKU ${skipped.join(', ')} 使用类目回退)` : '';
        const opiTaskId = importResult?.result?.task_id;
        const localTaskId = importResult?.result?.local_task_id; // ERP 用于持久化上架记录
        if (!opiTaskId) {
          showStatus('warn', `已提交但未返回 task_id,无法查询创建情况 (${matchInfo}${skippedInfo})`);
          return;
        }

        console.log(`[FollowSell] 官方 API 路径:轮询 OPI import/info, task_id=${opiTaskId}, local=${localTaskId}`);
        showStatus('info', `已提交到后台！${items.length} 个商品正在上架 (${matchInfo}${skippedInfo}),查询创建情况...`);
        const deadline = Date.now() + 30000; // 30s(OPI 队列处理比门户慢)
        let allItems = [];
        let pollCount = 0;
        while (Date.now() < deadline) {
          pollCount++;
          const infoRes = await sendMessage('productImportInfo', {
            taskId: String(opiTaskId),
            localTaskId,
          }).catch(() => null);
          console.log(`[FollowSell] 官方 API 轮询 #${pollCount} task=${opiTaskId}:`, {
            ok: infoRes?.ok,
            total: infoRes?.data?.total,
            itemsLen: infoRes?.data?.items?.length,
            error: infoRes?.error,
          });
          if (infoRes?.ok && Array.isArray(infoRes.data?.items) && infoRes.data.items.length > 0) {
            allItems = infoRes.data.items;
            const pending = allItems.filter((x) => x.status === 'pending').length;
            if (pending === 0) break; // 全部处理完毕(imported/failed/skipped 都是终态)
          }
          await new Promise((r) => setTimeout(r, 3000)); // 3s 间隔
        }

        if (allItems.length === 0) {
          showStatus('warn', `已提交到后台,但 OPI 查询未返回商品状态(task_id=${opiTaskId}),请稍后在卖家中心查看`);
        } else {
          renderResultPanel(panel, allItems);
          const imported = allItems.filter((x) => x.status === 'imported').length;
          const failed = allItems.filter((x) => x.status === 'failed').length;
          const pending = allItems.filter((x) => x.status === 'pending' || x.status === 'skipped').length;
          if (failed === 0 && pending === 0) {
            showStatus('success', `✓ 全部创建成功: ${imported}/${allItems.length} (imported)`);
          } else if (imported > 0) {
            showStatus(
              'warn',
              `部分创建成功: imported=${imported} failed=${failed} pending=${pending} (共 ${allItems.length})`
            );
          } else if (pending > 0 && failed === 0) {
            showStatus('info', `商品仍在处理中: pending=${pending}/${allItems.length},请稍后在卖家中心查看`);
          } else {
            const errMsg = allItems
              .filter((x) => x.status === 'failed')
              .slice(0, 3)
              .map((x) => x.offer_id + ': ' + (x.errors?.[0]?.message || x.errors?.[0]?.code || ''))
              .filter(Boolean)
              .join('; ');
            showStatus('error', `创建失败: failed=${failed}/${allItems.length}${errMsg ? ' - ' + errMsg : ''}`);
          }
        }
      }

      // ── 严格模式跳过项 + 无效图片展示(对齐 0.13 strictSkipped/invalidImage 回传) ──
      const strictSkipped = importResult?.result?.strictSkipped || [];
      const invalidImage = importResult?.result?.invalidImage || [];
      if (strictSkipped.length > 0 || invalidImage.length > 0) {
        const parts = [];
        if (strictSkipped.length > 0) {
          parts.push(
            `严格模式跳过 ${strictSkipped.length} 个: ${strictSkipped
              .slice(0, 5)
              .map((s) => s.offer_id || s.sku || s)
              .join(', ')}${strictSkipped.length > 5 ? '...' : ''}`
          );
        }
        if (invalidImage.length > 0) {
          parts.push(
            `无效图片剔除 ${invalidImage.length} 个: ${invalidImage
              .slice(0, 5)
              .map((s) => s.offer_id || s.sku || s)
              .join(', ')}${invalidImage.length > 5 ? '...' : ''}`
          );
        }
        console.warn('[FollowSell] 严格模式/无效图片:', { strictSkipped, invalidImage });
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
