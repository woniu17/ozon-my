<script setup>
// 上架预览工作台:上半部分(上架参数/预检清单/数据来源),下半部分(左原商品预览 + 右 4 项对比卡)
// 4 项对比卡:图片对比、价格对比、字段概览对比、属性对比,左右双列对比,凸显差异
// 品牌强制:不检测原数据,上架侧一律强制 brand(85)= "无品牌"
import { reactive, ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getSkuProfile, submitPreviewImport } from '../api/collect-box-v2.js';
import { getListingTemplates } from '../api/listingTemplates.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';

const route = useRoute();
const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

const sku = computed(() => String(route.params.sku || ''));

// 品牌强制常量:OPI 字典中 attribute_id=85 = 品牌
// Ozon 系统级"无品牌":dictionary_value_id=126745801(全局通用,与类目无关)
// value="Нет бренда"(俄文"无品牌",通过 /v1/description-category/attribute/values/search 搜 "Без бренда" 命中)
// ⚠️ 提交时 dictionary_value_id 和 value 必须同时传且匹配字典,否则 Ozon 报"请检查数值"
const BRAND_ATTR_ID = 85;
const NO_BRAND_VALUE = 'Нет бренда';
const NO_BRAND_DISPLAY = '无品牌'; // UI 展示用中文
const NO_BRAND_DICTIONARY_VALUE_ID = 126745801;
// 卖家代码(Артикул)= Offer ID;型号名称 = {Offer ID}-merge(用于合并为一张商品卡片)
const SELLER_CODE_ATTR_ID = 9024;
const MODEL_NAME_ATTR_ID = 9048;

// ── 状态 ───────────────────────────────────────────────────
// 记住上一次选中的店铺(localStorage 持久化,跨会话保留)
const STORE_ID_STORAGE_KEY = 'preview:lastStoreId';
const state = reactive({
  loading: true,
  error: '',
  profile: null, // { sources, original, item, portalItem, opiItem, attrDict }
  storeId: localStorage.getItem(STORE_ID_STORAGE_KEY) || '',
  templates: [],
  templateId: '',
  defaultStock: 0, // 模板默认库存快照(任务创建时存,stock-sync 据此设库存)
  // 上架参数(价格公式:售价=原价*A%+B,划线价=售价*A%,最低价=售价-B)
  params: {
    salePriceA: 130, // 50~500
    salePriceB: 0, // -10~10
    oldPriceA: 150, // 110~200
    minPriceB: 2, // 0~5(强制启用)
    imageOrder: 'keep', // keep | shuffle_non_primary
    imageProcess: { watermark: false, poster: false, antiCopy: false, posterPrimaryOnly: true },
    videoMode: 'mp4',
    descriptionMode: 'original',
  },
  submitting: false,
  submitResult: null,
  showOpiJson: false,
});

// ── 加载 profile ───────────────────────────────────────────
async function loadProfile() {
  state.loading = true;
  state.error = '';
  state.profile = null;
  try {
    const data = await getSkuProfile(sku.value, state.storeId || undefined);
    if (data.error) {
      state.error = data.error;
    } else {
      state.profile = data;
    }
  } catch (err) {
    state.error = err.message || String(err);
  } finally {
    state.loading = false;
  }
}

// ── 加载模板列表 ───────────────────────────────────────────
async function loadTemplates() {
  try {
    const list = await getListingTemplates();
    state.templates = Array.isArray(list) ? list : [];
    const def = state.templates.find((t) => t.isDefault) || state.templates[0];
    if (def) applyTemplate(def);
  } catch (err) {
    state.templates = [];
  }
}

function applyTemplate(t) {
  state.templateId = t.id;
  const c = t.config || {};
  if (c.defaultStock != null) state.defaultStock = Number(c.defaultStock) || 0;
  if (c.salePriceA != null) state.params.salePriceA = Number(c.salePriceA);
  if (c.salePriceB != null) state.params.salePriceB = Number(c.salePriceB);
  if (c.oldPriceA != null) state.params.oldPriceA = Number(c.oldPriceA);
  if (c.minPriceB != null) state.params.minPriceB = Number(c.minPriceB);
  if (c.imageOrder) state.params.imageOrder = c.imageOrder;
  if (c.applyWatermark != null) state.params.imageProcess.watermark = !!c.applyWatermark;
  if (c.applyPoster != null) state.params.imageProcess.poster = !!c.applyPoster;
  if (c.posterPrimaryOnly != null) state.params.imageProcess.posterPrimaryOnly = !!c.posterPrimaryOnly;
}

// ── 价格计算引擎(公式:售价=原价*A%+B,划线价=售价*A%,最低价=售价-B)──
const round2 = (n) => Math.round(n * 100) / 100;

const originalPrice = computed(() => Number(state.profile?.original?.price) || 0);
const salePrice = computed(() => {
  if (!originalPrice.value) return null;
  const a = Number(state.params.salePriceA);
  const b = Number(state.params.salePriceB);
  if (isNaN(a) || isNaN(b)) return null;
  return round2(originalPrice.value * (a / 100) + b);
});
const oldPrice = computed(() => {
  if (!salePrice.value) return null;
  const a = Number(state.params.oldPriceA);
  if (isNaN(a)) return null;
  return round2(salePrice.value * (a / 100));
});
const minPrice = computed(() => {
  if (!salePrice.value) return null;
  const b = Number(state.params.minPriceB);
  if (isNaN(b)) return null;
  return round2(salePrice.value - b);
});
const marketP50 = computed(() => state.profile?.original?.marketStats?.priceP50 || null);

// 上架 Offer ID 格式:{SKU}-{mmdd}-qx(mmdd=当日月份+日期,如 0718)
// OPI /v3/product/import 不传 SKU(商品未创建),只传 offer_id
const todayMMdd = computed(() => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
});
const listingOfferId = computed(() => `${sku.value}-${todayMMdd.value}-qx`);
// 上架货币:取店铺合同货币(currency_code),不再硬编码
const listingCurrency = computed(() => storesStore.findStore(state.storeId)?.currency_code || '');
const LISTING_VAT = '0';

const priceLevel = computed(() => {
  if (!salePrice.value || !marketP50.value) return 'unknown';
  if (salePrice.value < marketP50.value * 0.9) return 'low';
  if (salePrice.value > marketP50.value * 1.1) return 'high';
  return 'mid';
});

const salePriceFormula = computed(() => {
  if (!originalPrice.value) return '—';
  return `${originalPrice.value} × ${state.params.salePriceA}% + ${state.params.salePriceB} = ${salePrice.value ?? '—'}`;
});

// ── 预检清单(已移除原数据品牌检测,品牌一律强制上架侧) ────
const preflight = computed(() => {
  if (!state.profile?.original) return [];
  const o = state.profile.original;
  const p = portalItem.value;
  const checks = [];

  checks.push({
    key: 'name',
    level: o.name ? 'ok' : 'block',
    msg: o.name ? `名称: ${o.name.slice(0, 30)}` : '名称缺失',
  });

  checks.push({
    key: 'price',
    level: salePrice.value ? 'ok' : 'block',
    msg: salePrice.value ? `售价: ${salePrice.value}` : '售价未计算(原价缺失或策略无效)',
  });

  const w = Number(o.weight);
  checks.push({
    key: 'weight',
    level: w ? 'ok' : 'warn',
    msg: w ? `重量: ${w}g` : '重量缺失(将用默认 100g)',
  });

  const dims = o.dimensions;
  const hasDims = dims && Number(dims.depth) && Number(dims.width) && Number(dims.height);
  checks.push({
    key: 'dims',
    level: hasDims ? 'ok' : 'warn',
    msg: hasDims ? `尺寸: ${dims.depth}×${dims.width}×${dims.height}mm` : '尺寸缺失(将用默认 100mm)',
  });

  checks.push({
    key: 'image',
    level: o.primaryImage ? 'ok' : 'block',
    msg: o.primaryImage ? `主图: ✓ (${o.images.length} 张)` : '主图缺失',
  });

  // 违规 attr 检测(4194/4195/4497/9454/9455/9456)
  const BANNED = ['4194', '4195', '4497', '9454', '9455', '9456'];
  const attrs = p?.attributes || [];
  const bannedFound = attrs.filter((a) => BANNED.includes(String(a.id)));
  checks.push({
    key: 'bannedAttr',
    level: bannedFound.length ? 'block' : 'ok',
    msg: bannedFound.length
      ? `违规属性: ${bannedFound.map((a) => a.id).join(',')}`
      : `属性: ${attrs.length} 个(无违规)`,
  });

  // 品牌:不检测原数据,上架侧一律强制"无品牌"
  checks.push({
    key: 'brand',
    level: 'ok',
    msg: `品牌: 强制无品牌(attribute_id=${BRAND_ATTR_ID})`,
  });

  if (minPrice.value && salePrice.value && salePrice.value < minPrice.value) {
    checks.push({ key: 'minPrice', level: 'block', msg: `售价 ${salePrice.value} < 最低价 ${minPrice.value}` });
  }

  const descLen = (o.description || '').length;
  checks.push({
    key: 'desc',
    level: descLen >= 100 ? 'ok' : 'warn',
    msg: `描述: ${descLen} 字符${descLen < 100 ? ' (建议≥100)' : ''}`,
  });

  // ── OPI 必填字段检查 ──
  const p2 = portalItem.value;
  const requiredFieldChecks = [
    { key: 'offer_id', label: 'Offer ID', ok: !!listingOfferId.value, val: listingOfferId.value },
    { key: 'name', label: '名称', ok: !!(p2.name || o.name), val: (p2.name || o.name || '').slice(0, 30) },
    { key: 'price', label: '售价', ok: !!salePrice.value, val: salePrice.value ? `¥${salePrice.value}` : '' },
    { key: 'vat', label: 'VAT', ok: true, val: LISTING_VAT },
    { key: 'weight', label: '包装重量', ok: !!Number(p2.weight), val: p2.weight ? `${p2.weight}g` : '' },
    { key: 'depth', label: '包装长', ok: !!Number(p2.dimensions?.depth), val: p2.dimensions?.depth ? `${p2.dimensions.depth}mm` : '' },
    { key: 'width', label: '包装宽', ok: !!Number(p2.dimensions?.width), val: p2.dimensions?.width ? `${p2.dimensions.width}mm` : '' },
    { key: 'height', label: '包装高', ok: !!Number(p2.dimensions?.height), val: p2.dimensions?.height ? `${p2.dimensions.height}mm` : '' },
    { key: 'images', label: '图片', ok: processedImages.value.length > 0, val: `${processedImages.value.length} 张` },
    { key: 'description_category_id', label: '类目 ID', ok: !!Number(p2.descriptionCategoryId), val: p2.descriptionCategoryId || '' },
    { key: 'type_id', label: '类型 ID', ok: !!Number(p2.typeId), val: p2.typeId || '' },
    { key: 'currency_code', label: '币种', ok: !!listingCurrency.value, val: listingCurrency.value || '(未选店铺)' },
  ];
  for (const f of requiredFieldChecks) {
    checks.push({
      key: 'req_' + f.key,
      level: f.ok ? 'ok' : 'block',
      msg: `必填·${f.label}: ${f.ok ? f.val : '缺失'}`,
    });
  }

  // ── 必填属性检查(字典 is_required=true,且上架侧无值则阻断)──
  const requiredAttrs = listingAttrs.value.filter((a) => a.isRequired);
  const missingAttrs = requiredAttrs.filter((a) => !a.hasValue);
  if (requiredAttrs.length === 0) {
    checks.push({
      key: 'req_attrs',
      level: 'ok',
      msg: '必填属性: 字典为空,跳过',
    });
  } else if (missingAttrs.length === 0) {
    checks.push({
      key: 'req_attrs',
      level: 'ok',
      msg: `必填属性: ${requiredAttrs.length} 项全部有值`,
    });
  } else {
    const names = missingAttrs.slice(0, 5).map((a) => `#${a.id} ${a.name || ''}`).join('; ');
    checks.push({
      key: 'req_attrs',
      level: 'block',
      msg: `必填属性缺失: ${missingAttrs.length} 项 → ${names}${missingAttrs.length > 5 ? '...' : ''}`,
    });
  }

  return checks;
});

const preflightBlocks = computed(() => preflight.value.filter((c) => c.level === 'block'));
const preflightWarns = computed(() => preflight.value.filter((c) => c.level === 'warn'));
const canSubmit = computed(() => preflightBlocks.value.length === 0 && !state.submitting && !!state.storeId);

// ── portalItem 便捷引用 ────────────────────────────────────
const portalItem = computed(() => state.profile?.portalItem || {});

// ── 属性字典 ──
const attrDict = computed(() => state.profile?.attrDict || {});

function attrName(a) {
  return a.name || `ID ${a.id}`;
}

function attrValues(a) {
  return (a.values || []).map((v) => v.value).filter((v) => v != null && v !== '').join(', ') || '—';
}

// ── 原商品属性(字典为基准,值从缓存填充,不强制品牌) ────────
const originalAttrs = computed(() => {
  const dictKeys = Object.keys(attrDict.value);
  if (dictKeys.length === 0) {
    return (portalItem.value.attributes || []).map((a) => ({
      id: a.id,
      name: '',
      description: '',
      type: '',
      dictionary_id: 0,
      isRequired: false,
      values: a.values || [],
      hasValue: (a.values || []).some((v) => v.value != null && v.value !== ''),
    }));
  }
  const cacheMap = new Map();
  for (const a of portalItem.value.attributes || []) {
    cacheMap.set(String(a.id), a);
  }
  return dictKeys.map((id) => {
    const d = attrDict.value[id];
    const cached = cacheMap.get(id);
    const values = cached?.values || [];
    return {
      id: d.id,
      name: d.name || '',
      description: d.description || '',
      type: d.type || '',
      dictionary_id: d.dictionary_id || 0,
      isRequired: d.is_required === true,
      values,
      hasValue: values.some((v) => v.value != null && v.value !== ''),
    };
  });
});

// ── 上架属性:在原商品属性基础上,强制 brand(85)= "无品牌" ──
const listingAttrs = computed(() => {
  const list = originalAttrs.value.map((a) => ({ ...a, forced: false }));
  // 强制注入:品牌(85)=无品牌、卖家代码(9024)=Offer ID、型号名称(9048)={Offer ID}-merge
  const forcedEntries = [
    { id: BRAND_ATTR_ID, value: NO_BRAND_VALUE },
    { id: SELLER_CODE_ATTR_ID, value: listingOfferId.value },
    { id: MODEL_NAME_ATTR_ID, value: `${listingOfferId.value}-merge` },
  ];
  for (const fe of forcedEntries) {
    const dict = attrDict.value[String(fe.id)];
    // 品牌(85)用全局常量 126745801,其它属性(卖家代码/型号名称)是普通字符串属性,用 0
    const dictValueId = fe.id === BRAND_ATTR_ID ? NO_BRAND_DICTIONARY_VALUE_ID : 0;
    const entry = {
      id: fe.id,
      name: dict?.name || (fe.id === BRAND_ATTR_ID ? '品牌' : fe.id === SELLER_CODE_ATTR_ID ? '卖家代码' : '型号名称'),
      description: dict?.description || '',
      type: dict?.type || '',
      dictionary_id: dict?.dictionary_id || 0,
      isRequired: dict?.is_required === true,
      // 品牌 value 是俄文"Нет бренда"(Ozon 字典标准写法),UI 展示用 NO_BRAND_DISPLAY 中文
      values: [{ dictionary_value_id: dictValueId, value: fe.value }],
      hasValue: true,
      forced: true,
    };
    const idx = list.findIndex((a) => Number(a.id) === fe.id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
  }
  return list;
});

const originalFilledCount = computed(() => originalAttrs.value.filter((a) => a.hasValue).length);
const listingFilledCount = computed(() => listingAttrs.value.filter((a) => a.hasValue).length);

// ── 属性对比 diff(原 vs 上架,凸显增/改/删) ───────────────
const attrDiff = computed(() => {
  const origMap = new Map();
  for (const a of originalAttrs.value) origMap.set(String(a.id), a);
  const listMap = new Map();
  for (const a of listingAttrs.value) listMap.set(String(a.id), a);

  const allIds = new Set([...origMap.keys(), ...listMap.keys()]);
  return Array.from(allIds).map((id) => {
    const o = origMap.get(id);
    const l = listMap.get(id);
    const oVal = o?.hasValue ? attrValues(o) : '';
    const lVal = l?.hasValue ? attrValues(l) : '';
    const changed = oVal !== lVal;
    return {
      id,
      name: l?.name || o?.name || `ID ${id}`,
      originalValue: oVal || '—',
      listingValue: lVal || '—',
      added: (!o || !o.hasValue) && (l?.hasValue),
      removed: (o?.hasValue) && (!l || !l.hasValue),
      changed,
      forced: l?.forced === true,
      // 必填属性:字典里 is_required=true,标红 *
      required: l?.isRequired === true || o?.isRequired === true,
    };
  });
});

const attrDiffChangedCount = computed(() => attrDiff.value.filter((d) => d.changed).length);

// ── 字段对比 diff(按 OPI /v3/product/import 字段)──────────────
// 不含 SKU(商品未创建,OPI 不上传 SKU)
// required=true 的字段为 OPI 必填项(标红 *)
const OPI_REQUIRED_FIELDS = new Set([
  'offer_id', 'name', 'price', 'vat', 'weight', 'depth', 'width', 'height',
  'dimension_unit', 'weight_unit', 'description_category_id', 'type_id', 'images', 'attributes',
]);
const fieldDiff = computed(() => {
  if (!state.profile?.original) return [];
  const o = state.profile.original;
  const p = portalItem.value;
  // 后端 portalPreview 用 camelCase:descriptionCategoryId / typeId
  const origCatId = p.descriptionCategoryId || '—';
  const origTypeId = p.typeId || '—';
  const rows = [
    // ── OPI 核心字段 ──
    { key: 'offer_id', label: 'Offer ID', original: '—', listing: listingOfferId.value },
    { key: 'name', label: '名称', original: o.name || '—', listing: p.name || '—' },
    { key: 'barcode', label: '条码', original: o.barcode || '—', listing: p.barcode || '—' },
    // price=售价,old_price=划线价,min_price=最低价
    { key: 'price', label: '售价 (price)', original: o.price ? `¥${o.price}` : '—', listing: salePrice.value ? `¥${salePrice.value}` : '—' },
    { key: 'old_price', label: '划线价 (old_price)', original: o.oldPrice ? `¥${o.oldPrice}` : '—', listing: oldPrice.value ? `¥${oldPrice.value}` : '—' },
    { key: 'min_price', label: '最低价 (min_price)', original: '—', listing: minPrice.value ? `¥${minPrice.value}` : '—' },
    { key: 'currency_code', label: '币种 (currency_code)', original: '—', listing: listingCurrency.value || '(未选店铺)' },
    { key: 'vat', label: 'VAT', original: '—', listing: LISTING_VAT },
    // ── 物流字段(均为包装尺寸/重量)──
    {
      key: 'weight',
      label: '包装重量 (weight)',
      original: o.weight ? `${o.weight}g` : '—',
      listing: p.weight ? `${p.weight}g` : '—',
    },
    {
      key: 'depth',
      label: '包装长 (depth)',
      original: o.dimensions?.depth ? `${o.dimensions.depth}mm` : '—',
      listing: p.dimensions?.depth ? `${p.dimensions.depth}mm` : '—',
    },
    {
      key: 'width',
      label: '包装宽 (width)',
      original: o.dimensions?.width ? `${o.dimensions.width}mm` : '—',
      listing: p.dimensions?.width ? `${p.dimensions.width}mm` : '—',
    },
    {
      key: 'height',
      label: '包装高 (height)',
      original: o.dimensions?.height ? `${o.dimensions.height}mm` : '—',
      listing: p.dimensions?.height ? `${p.dimensions.height}mm` : '—',
    },
    // ── 媒体字段 ──
    { key: 'primary_image', label: '主图 (primary_image)', original: o.primaryImage ? '✓' : '—', listing: processedImages.value[0] ? '✓' : '—' },
    { key: 'images', label: '图片数 (images)', original: o.images?.length || 0, listing: processedImages.value.length },
    { key: 'video_url', label: '视频 (video_url)', original: o.videoUrl ? '✓' : '—', listing: state.params.videoMode === 'skip' ? '跳过' : (o.videoUrl ? '✓' : '—') },
    // ── 类目字段 ──
    { key: 'description_category_id', label: '类目 ID (description_category_id)', original: origCatId, listing: p.descriptionCategoryId || '—' },
    { key: 'type_id', label: '类型 ID (type_id)', original: origTypeId, listing: p.typeId || '—' },
    // ── 属性汇总 ──
    {
      key: 'attributes',
      label: '属性数 (attributes)',
      original: `${originalFilledCount.value}/${originalAttrs.value.length}`,
      listing: `${listingFilledCount.value}/${listingAttrs.value.length}`,
    },
    {
      key: 'complex_attributes',
      label: '复杂属性 (complex_attributes)',
      original: o.complexAttributes?.length || 0,
      listing: p.complexAttributes?.length || 0,
    },
    { key: 'attr_85', label: '品牌 (attr 85)', original: '—', listing: '无品牌(强制)' },
    { key: 'attr_9024', label: '卖家代码 (attr 9024)', original: '—', listing: listingOfferId.value },
    { key: 'attr_9048', label: '型号名称 (attr 9048)', original: '—', listing: `${listingOfferId.value}-merge` },
  ];
  return rows.map((f) => ({
    ...f,
    required: OPI_REQUIRED_FIELDS.has(f.key),
    changed: String(f.original) !== String(f.listing),
  }));
});

const fieldDiffChangedCount = computed(() => fieldDiff.value.filter((f) => f.changed).length);

// ── 图片处理 ──────────────────────────────────────────────
const allImages = computed(() => state.profile?.original?.images || []);
const hasImages = computed(() => allImages.value.length > 0);

const shuffledOrder = ref([]);
const shuffleEnabled = computed(() => state.params.imageOrder === 'shuffle_non_primary');

const processedImages = computed(() => {
  const imgs = allImages.value;
  if (!imgs.length) return [];
  if (shuffleEnabled.value && shuffledOrder.value.length === imgs.length) {
    return shuffledOrder.value.map((i) => imgs[i]).filter(Boolean);
  }
  return imgs;
});

// 图片差异信息:数量、顺序
const imageDiff = computed(() => {
  const origCount = allImages.value.length;
  const listCount = processedImages.value.length;
  const orderChanged =
    shuffleEnabled.value &&
    shuffledOrder.value.length === origCount &&
    shuffledOrder.value.some((idx, i) => idx !== i);
  return {
    countChanged: origCount !== listCount,
    orderChanged,
    origCount,
    listCount,
  };
});

function reshuffle() {
  const n = allImages.value.length;
  if (n <= 2) {
    shuffledOrder.value = allImages.value.map((_, i) => i);
    return;
  }
  const rest = [];
  for (let i = 1; i < n; i++) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  shuffledOrder.value = [0, ...rest];
}

watch(
  shuffleEnabled,
  (v) => {
    if (v && !shuffledOrder.value.length) reshuffle();
  },
  { immediate: true }
);

// 图片加载后或启用时,若顺序未生成则补一次
watch(
  [allImages, shuffleEnabled],
  () => {
    if (shuffleEnabled.value && allImages.value.length > 0 && shuffledOrder.value.length !== allImages.value.length) {
      reshuffle();
    }
  },
  { immediate: true }
);

// ── 价格差异 ──────────────────────────────────────────────
const priceDiff = computed(() => {
  const orig = originalPrice.value;
  const list = salePrice.value;
  if (!orig || !list) return { changed: false, delta: 0, ratio: 0 };
  const delta = Math.round((list - orig) * 100) / 100;
  const ratio = orig > 0 ? Math.round((list / orig) * 100) / 100 : 0;
  return { changed: delta !== 0, delta, ratio };
});

// ── OPI /v3/product/import 请求 JSON 预览 ─────────────────
// 构造提交时的完整请求体(与 onSubmit 提交内容保持一致)
const opiJsonPayload = computed(() => {
  if (!state.profile?.item) return null;
  const p = portalItem.value;
  const item = {
    offer_id: listingOfferId.value,
    name: p.name || '',
    barcode: p.barcode || '',
    price: salePrice.value ? String(salePrice.value) : '',
    old_price: oldPrice.value ? String(oldPrice.value) : '',
    min_price: minPrice.value ? String(minPrice.value) : '',
    currency_code: listingCurrency.value || '',
    vat: LISTING_VAT,
    weight: Number(p.weight) || 100,
    weight_unit: 'g',
    depth: Number(p.dimensions?.depth) || 100,
    width: Number(p.dimensions?.width) || 100,
    height: Number(p.dimensions?.height) || 100,
    dimension_unit: 'mm',
    description_category_id: Number(p.descriptionCategoryId) || 0,
    type_id: Number(p.typeId) || 0,
    images: processedImages.value.slice(),
    primary_image: processedImages.value[0] || '',
    attributes: listingAttrs.value
      .filter((a) => a.hasValue)
      .map((a) => ({
        complex_id: Number(a.complex_id) || 0,
        id: Number(a.id),
        values: a.values.map((v) => ({ dictionary_value_id: v.dictionary_value_id ?? 0, value: v.value })),
      })),
    complex_attributes: (p.complexAttributes || []).map((g) => ({
      attributes: (g.attributes || []).map((a) => ({
        complex_id: Number(a.complex_id) || 0,
        id: Number(a.id),
        values: (a.values || []).map((v) => ({ dictionary_value_id: v.dictionary_value_id ?? 0, value: v.value })),
      })),
    })),
  };
  // video_url 暂不填(后续接入后再开)
  // if (state.params.videoMode !== 'skip' && state.profile.original?.videoUrl) {
  //   item.video_url = state.profile.original.videoUrl;
  // }
  return {
    endpoint: 'POST /v3/product/import',
    store_id: state.storeId || '(未选)',
    body: { items: [item] },
  };
});

const opiJsonText = computed(() => JSON.stringify(opiJsonPayload.value, null, 2));

async function copyOpiJson() {
  try {
    await navigator.clipboard.writeText(opiJsonText.value);
    show('OPI JSON 已复制', 'success');
  } catch {
    show('复制失败,请手动选择', 'error');
  }
}

// ── 一键提交:强制添加品牌(85)= "无品牌" ─────────────────
async function onSubmit() {
  if (!state.storeId) {
    show('请先选择店铺', 'error');
    return;
  }
  if (preflightBlocks.value.length) {
    show(`预检失败:${preflightBlocks.value[0].msg}`, 'error');
    return;
  }
  if (preflightWarns.value.length) {
    if (!confirm(`有 ${preflightWarns.value.length} 项警告,确认继续提交?`)) return;
  }

  state.submitting = true;
  state.submitResult = null;
  try {
    const item = JSON.parse(JSON.stringify(state.profile.item));
    if (salePrice.value) item.price = String(salePrice.value);
    if (oldPrice.value) item.old_price = String(oldPrice.value);
    if (minPrice.value) item.min_price = String(minPrice.value);
    // OPI 强制字段:offer_id(格式 {SKU}-{mmdd}-qx)、currency_code=CNY、vat=0
    item.offer_id = listingOfferId.value;
    item.currency_code = listingCurrency.value || '';
    item.vat = LISTING_VAT;
    if (state.params.videoMode === 'skip') item.videoUrl = '';

    // 强制注入:品牌(85)=无品牌(常量 126745801)、卖家代码(9024)=Offer ID、型号名称(9048)={Offer ID}-merge
    // 品牌 dictionary_value_id=126745801 是 Ozon 全局"无品牌"占位,value="Нет бренда" 与字典匹配
    // 卖家代码/型号名称是普通字符串属性,dictionary_value_id=0 即可
    // ⚠️ 后端 transformItemForPortal 会从 _bundleItem/sv 重新提取 attributes,
    // 直接改 item.attributes 会被覆盖。改用 _forcedAttributes 传递,
    // 后端在 5.2d 步骤会按 id 强制覆盖到最终 attributes 数组中。
    const forcedAttrValues = [
      { id: BRAND_ATTR_ID, value: NO_BRAND_VALUE, dictionaryValueId: NO_BRAND_DICTIONARY_VALUE_ID },
      { id: SELLER_CODE_ATTR_ID, value: listingOfferId.value, dictionaryValueId: 0 },
      { id: MODEL_NAME_ATTR_ID, value: `${listingOfferId.value}-merge`, dictionaryValueId: 0 },
    ];
    item._forcedAttributes = forcedAttrValues.map((fe) => ({
      complex_id: 0,
      id: fe.id,
      values: [{ dictionary_value_id: fe.dictionaryValueId, value: fe.value }],
    }));
    // item.attributes 也同步覆盖(用于"查看 OPI JSON"展示 + 后端备份的 raw payload)
    if (Array.isArray(item.attributes)) {
      for (const fe of forcedAttrValues) {
        const idx = item.attributes.findIndex((a) => Number(a.id) === fe.id);
        const entry = { complex_id: 0, id: fe.id, values: [{ dictionary_value_id: fe.dictionaryValueId, value: fe.value }] };
        if (idx >= 0) item.attributes[idx] = entry;
        else item.attributes.push(entry);
      }
    }

    const r = await submitPreviewImport([item], state.storeId, {
      templateId: state.templateId,
      defaultStock: state.defaultStock,
    });
    state.submitResult = r?.result || {};
    if (r?.result?.error) {
      show(`提交失败:${r.result.error}`, 'error');
    } else {
      show(`提交成功,任务ID:${r.result.local_task_id || r.result.task_id}`, 'success');
      setTimeout(() => router.push('/listings'), 1500);
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    state.submitting = false;
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
const CACHE_KEYS = [
  { key: 'search', label: 'S' },
  { key: 'bundle', label: 'B' },
  { key: 'card', label: 'C' },
  { key: 'richMedia', label: 'R' },
  { key: 'detail', label: 'D' },
  { key: 'marketStats', label: 'M' },
  { key: 'followSell', label: 'F' },
];

function goBack() {
  router.push('/collect-box-v2');
}

watch(
  () => state.storeId,
  (v) => {
    // 持久化店铺选择,下次进入页面自动恢复
    if (v) localStorage.setItem(STORE_ID_STORAGE_KEY, v);
    if (v && sku.value) loadProfile();
  }
);

onMounted(() => {
  storesStore.load();
  loadTemplates();
  loadProfile();
});
</script>

<template>
  <div class="preview-page">
    <!-- 顶栏 -->
    <div class="pv-toolbar">
      <button class="btn btn-ghost" @click="goBack">← 返回采集箱</button>
      <h2 class="pv-title">上架预览 · SKU {{ sku }}</h2>
      <div class="pv-toolbar-right">
        <select class="filter-select" v-model="state.storeId" title="选择目标店铺(必选,影响属性字典过滤 + 提交)">
          <option value="">选择店铺...</option>
          <option v-for="s in storesStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <select
          class="filter-select"
          v-model="state.templateId"
          @change="
            () => {
              const t = state.templates.find((x) => x.id === state.templateId);
              if (t) applyTemplate(t);
            }
          "
          title="应用上架模板"
        >
          <option value="">无模板</option>
          <option v-for="t in state.templates" :key="t.id" :value="t.id">
            {{ t.name }}{{ t.isDefault ? ' (默认)' : '' }}
          </option>
        </select>
        <span
          class="pv-preflight-badge"
          :class="{ ok: !preflightBlocks.length, block: preflightBlocks.length }"
          :title="`通过 ${preflight.length - preflightBlocks.length - preflightWarns.length}/${preflight.length} · 警告 ${preflightWarns.length} · 阻断 ${preflightBlocks.length}`"
        >
          预检 {{ preflight.length - preflightBlocks.length }}/{{ preflight.length }}
        </span>
        <button class="btn btn-ghost" @click="state.showOpiJson = true">查看 OPI JSON</button>
        <button class="btn btn-primary" :disabled="!canSubmit" @click="onSubmit">
          {{ state.submitting ? '提交中...' : '一键提交' }}
        </button>
      </div>
    </div>

    <!-- 加载/错误态 -->
    <p v-if="state.loading" class="pv-loading">加载中...</p>
    <p v-else-if="state.error" class="pv-error">⚠ {{ state.error }}</p>

    <div v-else-if="state.profile" class="pv-body">
      <!-- ════════════ 上半部分:上架参数 / 预检清单 / 数据来源 ════════════ -->
      <div class="pv-top">
        <!-- 上架参数 -->
        <div class="pv-card pv-top-card">
          <div class="pv-card-title">上架参数</div>

          <fieldset class="pv-fieldset">
            <legend>价格公式</legend>
            <p class="muted pv-chain-note">售价 = 原价 × A% + B ｜ 划线价 = 售价 × A% ｜ 最低价 = 售价 − B</p>
            <div class="pv-param-row">
              <label>售价 A%</label>
              <input
                class="filter-input"
                type="number"
                min="50"
                max="500"
                step="1"
                v-model.number="state.params.salePriceA"
                placeholder="50~500"
              />
              <span class="pv-param-range">50~500</span>
            </div>
            <div class="pv-param-row">
              <label>售价 B</label>
              <input
                class="filter-input"
                type="number"
                min="-10"
                max="10"
                step="0.01"
                v-model.number="state.params.salePriceB"
                placeholder="-10~10"
              />
              <span class="pv-param-result">= ¥{{ salePrice || '—' }}</span>
            </div>
            <div class="pv-param-row">
              <label>划线价 A%</label>
              <input
                class="filter-input"
                type="number"
                min="110"
                max="200"
                step="1"
                v-model.number="state.params.oldPriceA"
                placeholder="110~200"
              />
              <span class="pv-param-result">= ¥{{ oldPrice || '—' }}</span>
            </div>
            <div class="pv-param-row">
              <label>最低价 B</label>
              <input
                class="filter-input"
                type="number"
                min="0"
                max="5"
                step="0.01"
                v-model.number="state.params.minPriceB"
                placeholder="0~5"
              />
              <span class="pv-param-result">= ¥{{ minPrice || '—' }}</span>
            </div>
          </fieldset>

          <fieldset class="pv-fieldset">
            <legend>图片排序</legend>
            <div class="pv-param-row">
              <label>排序方式</label>
              <select class="filter-select" v-model="state.params.imageOrder">
                <option value="keep">不更改</option>
                <option value="shuffle_non_primary">主图不变,其它随机打乱</option>
              </select>
              <button
                v-if="state.params.imageOrder === 'shuffle_non_primary'"
                class="btn btn-ghost pv-reshuffle-btn"
                type="button"
                @click="reshuffle"
                title="主图不变,其他图片重新随机打乱"
              >
                🎲 重新打乱
              </button>
            </div>
            <div class="pv-process-chain">
              <label class="pv-chain-item">
                <input type="checkbox" v-model="state.params.imageProcess.watermark" />
                水印
              </label>
              <label class="pv-chain-item">
                <input type="checkbox" v-model="state.params.imageProcess.poster" />
                海报
              </label>
              <label class="pv-chain-item" v-if="state.params.imageProcess.poster">
                <input type="checkbox" v-model="state.params.imageProcess.posterPrimaryOnly" />
                仅主图
              </label>
              <label class="pv-chain-item">
                <input type="checkbox" v-model="state.params.imageProcess.antiCopy" />
                防盗图
              </label>
            </div>
            <p class="muted pv-chain-note">水印/海报/防盗待接入后端</p>
          </fieldset>

          <fieldset class="pv-fieldset">
            <legend>其他</legend>
            <div class="pv-param-row">
              <label>视频</label>
              <select class="filter-select" v-model="state.params.videoMode">
                <option value="mp4">带 .mp4 视频</option>
                <option value="skip">跳过视频</option>
              </select>
            </div>
            <div class="pv-param-row">
              <label>描述</label>
              <select class="filter-select" v-model="state.params.descriptionMode">
                <option value="original">原描述</option>
                <option value="aiRewrite">AI 改写(待接入)</option>
              </select>
            </div>
          </fieldset>

          <!-- 品牌强制说明 -->
          <div class="pv-brand-notice">
            <strong>品牌:</strong> 强制 <span class="pv-brand-tag">无品牌</span>(attribute_id={{ BRAND_ATTR_ID }},不检测原数据)
          </div>
        </div>

        <!-- 预检清单 -->
        <div class="pv-card pv-top-card">
          <div class="pv-card-title">
            预检清单
            <span class="pv-card-title-meta">
              通过 {{ preflight.length - preflightBlocks.length - preflightWarns.length }} · 警告 {{ preflightWarns.length }} · 阻断 {{ preflightBlocks.length }}
            </span>
          </div>
          <ul class="pv-preflight">
            <li v-for="c in preflight" :key="c.key" :class="'pf-' + c.level">
              <span class="pf-icon">{{ c.level === 'ok' ? '✓' : c.level === 'warn' ? '⚠' : '✗' }}</span>
              {{ c.msg }}
            </li>
          </ul>
        </div>

        <!-- 数据来源 -->
        <div class="pv-card pv-top-card">
          <div class="pv-card-title">数据来源 (7 类缓存)</div>
          <div class="pv-dots">
            <span
              v-for="ck in CACHE_KEYS"
              :key="ck.key"
              class="cb-dot"
              :class="{ hit: state.profile.sources[ck.key] }"
              :title="ck.key + (state.profile.sources[ck.key] ? ' ✓' : ' ✗')"
              >{{ ck.label }}</span
            >
          </div>
          <div class="pv-source-list">
            <div v-for="ck in CACHE_KEYS" :key="ck.key" class="pv-source-row">
              <span class="pv-source-label">{{ ck.key }}</span>
              <span class="pv-source-status" :class="{ hit: state.profile.sources[ck.key] }">
                {{ state.profile.sources[ck.key] ? '✓ 命中' : '✗ 未命中' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- ════════════ 下半部分:4 项对比卡 ════════════ -->
      <div class="pv-bottom">
        <div class="pv-listing">
          <div class="pv-listing-title">上架商品预览 · 对比</div>

          <!-- ① 图片对比 -->
          <div class="pv-card">
            <div class="pv-card-title">
              图片对比
              <span class="pv-card-title-meta">
                原 {{ imageDiff.origCount }} 张 · 上架 {{ imageDiff.listCount }} 张
                <span v-if="imageDiff.orderChanged" class="pv-diff-tag">顺序已变</span>
                <span v-if="imageDiff.countChanged" class="pv-diff-tag">数量已变</span>
              </span>
            </div>
            <div v-if="!hasImages" class="pv-no-img-sm">无图片</div>
            <div v-else class="pv-cmp-2col">
              <div class="pv-cmp-col">
                <div class="pv-cmp-col-label">原商品 · {{ imageDiff.origCount }} 张</div>
                <div class="pv-img-grid">
                  <div v-for="(img, i) in allImages" :key="'o' + i" class="pv-img-cell">
                    <div class="pv-img-cell-idx">#{{ i + 1 }}{{ i === 0 ? ' 主图' : '' }}</div>
                    <img :src="img" class="pv-ic-img" alt="" loading="lazy" @error="$event.target.style.opacity = 0.2" />
                  </div>
                </div>
              </div>
              <div class="pv-cmp-col">
                <div class="pv-cmp-col-label">
                  上架 · {{ imageDiff.listCount }} 张
                  <span v-if="shuffleEnabled" class="pv-ic-tags">[顺序已打乱]</span>
                  <span v-if="state.params.imageProcess.watermark" class="pv-ic-tags">[水]</span>
                  <span v-if="state.params.imageProcess.poster" class="pv-ic-tags">[海]</span>
                  <span v-if="state.params.imageProcess.antiCopy" class="pv-ic-tags">[防盗]</span>
                </div>
                <div class="pv-img-grid">
                  <div
                    v-for="(img, i) in processedImages"
                    :key="'p' + i"
                    class="pv-img-cell"
                    :class="{ 'pv-img-changed': shuffleEnabled && shuffledOrder[i] !== i }"
                  >
                    <div class="pv-img-cell-idx">
                      #{{ i + 1 }}{{ i === 0 ? ' 主图' : '' }}
                      <span v-if="shuffleEnabled && shuffledOrder[i] !== i" class="pv-img-reorder-tag">
                        ← #{{ (shuffledOrder[i] ?? i) + 1 }}
                      </span>
                    </div>
                    <img :src="img" class="pv-ic-img" alt="" loading="lazy" @error="$event.target.style.opacity = 0.2" />
                  </div>
                </div>
              </div>
            </div>
            <p class="muted pv-ic-note">主图处理(水印/海报/防盗)待接入后端,当前展示原图,顺序处理可调整顺序</p>
          </div>

          <!-- ② 价格对比 -->
          <div class="pv-card">
            <div class="pv-card-title">
              价格对比
              <span class="pv-card-title-meta">
                <span v-if="priceDiff.changed" class="pv-diff-tag">
                  ¥{{ priceDiff.delta > 0 ? '+' : '' }}{{ priceDiff.delta }}(×{{ priceDiff.ratio }})
                </span>
              </span>
            </div>
            <div class="pv-cmp-2col">
              <div class="pv-cmp-col">
                <div class="pv-cmp-col-label">原商品</div>
                <div class="pv-cmp-row">
                  <span class="pv-cmp-key">原售价</span>
                  <span class="pv-cmp-val">¥{{ originalPrice || '—' }}</span>
                </div>
                <div v-if="state.profile.original.oldPrice" class="pv-cmp-row">
                  <span class="pv-cmp-key">原划线价</span>
                  <span class="pv-cmp-val">¥{{ state.profile.original.oldPrice }}</span>
                </div>
                <div class="pv-cmp-row">
                  <span class="pv-cmp-key">原最低价</span>
                  <span class="pv-cmp-val">¥{{ state.profile.original.minPrice || '—' }}</span>
                </div>
                <div v-if="marketP50" class="pv-cmp-row">
                  <span class="pv-cmp-key">市场 P50</span>
                  <span class="pv-cmp-val">¥{{ marketP50 }}</span>
                </div>
              </div>
              <div class="pv-cmp-col">
                <div class="pv-cmp-col-label">上架</div>
                <div class="pv-cmp-row" :class="{ 'pv-cmp-changed': priceDiff.changed }">
                  <span class="pv-cmp-key">售价</span>
                  <span class="pv-cmp-val" :class="'level-' + priceLevel">¥{{ salePrice || '—' }}</span>
                  <span class="pv-cmp-formula">{{ salePriceFormula }}</span>
                </div>
                <div v-if="oldPrice" class="pv-cmp-row" :class="{ 'pv-cmp-changed': String(state.profile.original.oldPrice || '') !== String(oldPrice) }">
                  <span class="pv-cmp-key">划线价</span>
                  <span class="pv-cmp-val">¥{{ oldPrice }}</span>
                </div>
                <div v-if="minPrice" class="pv-cmp-row">
                  <span class="pv-cmp-key">最低价</span>
                  <span class="pv-cmp-val" :class="{ 'pv-cmp-warn': salePrice && salePrice < minPrice }">¥{{ minPrice }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- ③ 字段概览对比 -->
          <div class="pv-card">
            <div class="pv-card-title">
              字段概览对比
              <span class="pv-card-title-meta">
                共 {{ fieldDiff.length }} 项 · 差异 <strong class="pv-diff-count">{{ fieldDiffChangedCount }}</strong> 项 · 必填 <span class="pv-required-star">*</span>
              </span>
            </div>
            <table class="pv-cmp-table">
              <thead>
                <tr>
                  <th class="pv-cmp-th-key">字段</th>
                  <th class="pv-cmp-th">原商品</th>
                  <th class="pv-cmp-th">上架</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in fieldDiff" :key="f.label" :class="{ 'pv-cmp-row-changed': f.changed }">
                  <td class="pv-cmp-key">
                    <span v-if="f.required" class="pv-required-star">*</span>{{ f.label }}
                  </td>
                  <td class="pv-cmp-cell">{{ f.original }}</td>
                  <td class="pv-cmp-cell" :class="{ 'pv-cmp-cell-changed': f.changed }">
                    {{ f.listing }}
                    <span v-if="f.changed" class="pv-cmp-arrow">←</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- ④ 属性对比 -->
          <div class="pv-card">
            <div class="pv-card-title">
              属性对比
              <span class="pv-card-title-meta">
                共 {{ attrDiff.length }} 项 · 差异 <strong class="pv-diff-count">{{ attrDiffChangedCount }}</strong> 项 · 必填 <span class="pv-required-star">*</span>
                <span class="pv-diff-tag">含强制品牌(#{{ BRAND_ATTR_ID }}=无品牌)</span>
              </span>
            </div>
            <table class="pv-cmp-table">
              <thead>
                <tr>
                  <th class="pv-cmp-th-key">属性名</th>
                  <th class="pv-cmp-th">原商品</th>
                  <th class="pv-cmp-th">上架</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="a in attrDiff"
                  :key="a.id"
                  :class="{
                    'pv-cmp-row-added': a.added,
                    'pv-cmp-row-removed': a.removed,
                    'pv-cmp-row-changed': a.changed && !a.added && !a.removed,
                  }"
                >
                  <td class="pv-cmp-key">
                    <span v-if="a.required" class="pv-required-star">*</span>{{ a.name }}
                    <span class="pv-attr-id-tag">#{{ a.id }}</span>
                    <span v-if="a.forced" class="pv-attr-forced-tag">强制</span>
                  </td>
                  <td class="pv-cmp-cell">{{ a.originalValue }}</td>
                  <td class="pv-cmp-cell" :class="{ 'pv-cmp-cell-changed': a.changed }">
                    {{ a.listingValue }}
                    <span v-if="a.added" class="pv-cmp-flag pv-cmp-flag-add">增</span>
                    <span v-else-if="a.removed" class="pv-cmp-flag pv-cmp-flag-del">删</span>
                    <span v-else-if="a.changed" class="pv-cmp-flag pv-cmp-flag-mod">改</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 提交结果 -->
          <div
            v-if="state.submitResult"
            class="pv-card"
            :class="{ 'pv-card-success': !state.submitResult.error, 'pv-card-error': state.submitResult.error }"
          >
            <div class="pv-card-title">提交结果</div>
            <p v-if="state.submitResult.task_id">Ozon 任务 ID: {{ state.submitResult.task_id }}</p>
            <p v-if="state.submitResult.local_task_id">本地任务 ID: {{ state.submitResult.local_task_id }}</p>
            <p v-if="state.submitResult.error" class="pv-error-text">{{ state.submitResult.error }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- OPI JSON 预览弹窗 -->
    <div v-if="state.showOpiJson" class="pv-json-mask" @click.self="state.showOpiJson = false">
      <div class="pv-json-modal">
        <div class="pv-json-header">
          <h3>OPI /v3/product/import 请求数据</h3>
          <div class="pv-json-actions">
            <button class="btn btn-ghost pv-json-btn" @click="copyOpiJson">📋 复制</button>
            <button class="btn btn-ghost pv-json-btn" @click="state.showOpiJson = false">✕ 关闭</button>
          </div>
        </div>
        <div class="pv-json-meta">
          <span>店铺: {{ opiJsonPayload?.store_id || '—' }}</span>
          <span>接口: {{ opiJsonPayload?.endpoint || '—' }}</span>
          <span>品牌: <span class="pv-json-tag ok">Нет бренда (id={{ NO_BRAND_DICTIONARY_VALUE_ID }})</span></span>
        </div>
        <pre class="pv-json-body">{{ opiJsonText }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.pv-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.pv-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  flex: 1;
}
.pv-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pv-preflight-badge {
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}
.pv-preflight-badge.ok {
  background: #d1fae5;
  color: #065f46;
}
.pv-preflight-badge.block {
  background: #fee2e2;
  color: #991b1b;
}
.pv-loading,
.pv-error {
  padding: 40px;
  text-align: center;
  color: #6b7280;
}
.pv-error {
  color: #dc2626;
}

/* ════════════ 整体布局:上半 + 下半 ════════════ */
.pv-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow: auto;
  flex: 1;
}

/* 上半部分:3 卡片横排 */
.pv-top {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  gap: 12px;
  flex-shrink: 0;
}
.pv-top-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  max-height: 360px;
  overflow-y: auto;
}

/* 下半部分:4 项对比卡(整宽) */
.pv-bottom {
  display: flex;
  flex: 1;
  min-height: 0;
}
.pv-listing-title {
  font-size: 13px;
  font-weight: 700;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #e5e7eb;
}
.pv-listing {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  overflow-y: auto;
  flex: 1;
}
.pv-attr-id-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  color: #9ca3af;
  font-family: monospace;
  font-weight: 400;
}
.pv-attr-forced-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
  color: #92400e;
  background: #fde68a;
  border-radius: 3px;
}

/* 卡片通用 */
.pv-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.pv-card-success {
  border-color: #10b981;
  background: #ecfdf5;
}
.pv-card-error {
  border-color: #ef4444;
  background: #fef2f2;
}
.pv-card-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pv-card-title-meta {
  font-size: 11px;
  font-weight: 400;
  color: #6b7280;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pv-diff-tag {
  display: inline-block;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: #b45309;
  background: #fef3c7;
  border-radius: 3px;
  margin-left: 4px;
}
.pv-diff-count {
  color: #b45309;
  font-weight: 700;
}

/* 数据来源 */
.pv-dots {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.pv-source-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.pv-source-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px dashed #f3f4f6;
}
.pv-source-label {
  color: #6b7280;
}
.pv-source-status {
  font-weight: 600;
  color: #dc2626;
}
.pv-source-status.hit {
  color: #059669;
}

/* 上架参数 */
.pv-brand-notice {
  margin-top: 8px;
  padding: 6px 10px;
  font-size: 12px;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 4px;
  color: #92400e;
}
.pv-brand-tag {
  display: inline-block;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  color: #92400e;
  background: #fde68a;
  border-radius: 3px;
  margin: 0 2px;
}

/* 预检清单 */
.pv-preflight {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 13px;
}
.pv-preflight li {
  padding: 3px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pf-ok {
  color: #059669;
}
.pf-warn {
  color: #d97706;
}
.pf-block {
  color: #dc2626;
  font-weight: 600;
}
.pf-icon {
  width: 16px;
  text-align: center;
}

/* 上架参数内部 */
.pv-fieldset {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
}
.pv-fieldset legend {
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
  padding: 0 6px;
}
.pv-param-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
}
.pv-param-row label {
  width: 60px;
  flex-shrink: 0;
  color: #4b5563;
}
.pv-param-row .filter-select,
.pv-param-row .filter-input {
  flex: 1;
  min-width: 0;
}
.pv-param-result {
  font-size: 12px;
  font-weight: 600;
  color: #059669;
  white-space: nowrap;
}
.pv-param-range {
  font-size: 11px;
  color: #9ca3af;
  white-space: nowrap;
}
.pv-process-chain {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
}
.pv-chain-item {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.pv-chain-note {
  font-size: 10px;
  margin-top: 6px;
}
.pv-reshuffle-btn {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.pv-reshuffle-btn:hover {
  background: #f3f4f6;
}

/* ════════════ 对比卡通用样式 ════════════ */
.pv-cmp-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: start;
}
.pv-cmp-col {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px;
  background: #fafafa;
  min-width: 0;
}
.pv-cmp-col-label {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.pv-cmp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px dashed #f3f4f6;
}
.pv-cmp-row:last-child {
  border-bottom: none;
}
.pv-cmp-key {
  color: #6b7280;
  width: 60px;
  flex-shrink: 0;
}
.pv-cmp-val {
  font-weight: 600;
  color: #111827;
}
.pv-cmp-formula {
  font-size: 10px;
  color: #9ca3af;
  margin-left: auto;
}
.pv-cmp-val.level-low {
  color: #dc2626;
}
.pv-cmp-val.level-mid {
  color: #d97706;
}
.pv-cmp-val.level-high {
  color: #059669;
}
.pv-cmp-warn {
  color: #dc2626 !important;
}
.pv-cmp-changed {
  background: #fef3c7;
  border-radius: 3px;
  padding: 3px 4px;
}

/* 图片对比 */
.pv-img-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pv-img-cell {
  flex: 1 1 100px;
  max-width: 160px;
  text-align: center;
  min-width: 80px;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px;
}
.pv-img-cell.pv-img-changed {
  border-color: #f59e0b;
  background: #fffbeb;
}
.pv-img-cell-idx {
  font-size: 10px;
  color: #6b7280;
  margin-bottom: 3px;
}
.pv-img-reorder-tag {
  display: inline-block;
  margin-left: 3px;
  padding: 0 4px;
  font-size: 9px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 2px;
}
.pv-ic-img {
  width: 100%;
  max-height: 120px;
  object-fit: contain;
  border-radius: 4px;
  background: #f9fafb;
}
.pv-ic-tags {
  color: #2563eb;
  font-size: 10px;
  margin-left: 4px;
}
.pv-no-img-sm {
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f3f4f6;
  color: #9ca3af;
  border-radius: 4px;
  font-size: 12px;
}
.pv-ic-note {
  font-size: 10px;
  margin-top: 6px;
  text-align: center;
}

/* 字段/属性对比表 */
.pv-cmp-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}
.pv-cmp-table thead th {
  text-align: left;
  padding: 5px 8px;
  background: #f9fafb;
  color: #6b7280;
  font-weight: 600;
  border-bottom: 1px solid #e5e7eb;
  font-size: 11px;
  position: sticky;
  top: 0;
  z-index: 1;
}
.pv-cmp-th-key {
  width: 230px;
}
.pv-cmp-th {
  width: auto;
}
.pv-cmp-table td {
  padding: 4px 8px;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
  word-break: break-word;
}
.pv-cmp-table .pv-cmp-key {
  color: #6b7280;
  width: 230px;
  min-width: 230px;
  flex-shrink: 0;
  font-weight: 500;
  white-space: nowrap;
}
/* 必填项红色星号 */
.pv-required-star {
  color: #dc2626;
  font-weight: 700;
  margin-right: 2px;
}
.pv-cmp-cell {
  color: #111827;
}
.pv-cmp-cell-changed {
  background: #fef3c7;
  color: #92400e;
  font-weight: 600;
}
.pv-cmp-arrow {
  color: #b45309;
  margin-left: 4px;
  font-size: 10px;
}
.pv-cmp-row-changed {
  background: #fffbeb;
}
.pv-cmp-row-added {
  background: #ecfdf5;
}
.pv-cmp-row-removed {
  background: #fef2f2;
}
.pv-cmp-flag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 700;
  border-radius: 3px;
}
.pv-cmp-flag-add {
  color: #065f46;
  background: #d1fae5;
}
.pv-cmp-flag-del {
  color: #991b1b;
  background: #fee2e2;
}
.pv-cmp-flag-mod {
  color: #92400e;
  background: #fde68a;
}

.pv-error-text {
  color: #dc2626;
  font-weight: 600;
}

/* OPI JSON 弹窗 */
.pv-json-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.pv-json-modal {
  background: #fff;
  border-radius: 8px;
  width: min(900px, 96vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.pv-json-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.pv-json-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #111827;
}
.pv-json-actions {
  display: flex;
  gap: 8px;
}
.pv-json-btn {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.pv-json-btn:hover {
  background: #f3f4f6;
}
.pv-json-meta {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  font-size: 12px;
  color: #6b7280;
  flex-wrap: wrap;
  align-items: center;
}
.pv-json-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 3px;
  font-weight: 600;
  margin: 0 4px;
}
.pv-json-tag.ok {
  background: #d1fae5;
  color: #065f46;
}
.pv-json-tag.err {
  background: #fee2e2;
  color: #991b1b;
}
.pv-json-body {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #1f2937;
  background: #fafafa;
  white-space: pre;
  flex: 1;
}
</style>
