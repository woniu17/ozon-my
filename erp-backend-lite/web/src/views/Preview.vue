<script setup>
// 上架预览工作台:从缓存聚合 SKU 全息画像,Ozon 详情页风格左栏 + 对比右栏
// P2:预览框架 + 价格对比 + 主图对比 + 字段 diff
// P3:上架参数面板(价格公式 ratio/fixed + 主图处理链 UI + 模板持久化)
// P4:预检清单 + 一键提交 /ozon/products/import
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

// ── 状态 ───────────────────────────────────────────────────
const state = reactive({
  loading: true,
  error: '',
  profile: null, // { sources, original, item, portalItem, opiItem }
  storeId: '',
  templates: [],
  templateId: '',
  // 上架参数(P3)
  params: {
    salePriceStrategy: { type: 'ratio', value: 1.3 }, // 售价策略
    minPriceStrategy: { type: 'none', value: '' }, // 最小价策略
    oldPriceStrategy: { type: 'ratio', value: 2 }, // 划线价策略
    imageProcess: { watermark: false, poster: false, antiCopy: false, posterPrimaryOnly: true, shuffle: false },
    videoMode: 'mp4', // mp4 | skip
    descriptionMode: 'original', // original | aiRewrite
  },
  submitting: false,
  submitResult: null,
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
      // 用 original.price 初始化售价策略的 ratio 基准(如果原价为空,默认 1.3)
      if (!state.profile.original?.price) {
        state.params.salePriceStrategy = { type: 'fixed', value: '' };
      }
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
    // 默认选中 isDefault 模板
    const def = state.templates.find((t) => t.isDefault) || state.templates[0];
    if (def) applyTemplate(def);
  } catch (err) {
    state.templates = [];
  }
}

function applyTemplate(t) {
  state.templateId = t.id;
  const c = t.config || {};
  if (c.salePriceStrategy) state.params.salePriceStrategy = { ...c.salePriceStrategy };
  if (c.minPriceStrategy) state.params.minPriceStrategy = { ...c.minPriceStrategy };
  if (c.oldPriceStrategy) state.params.oldPriceStrategy = { ...c.oldPriceStrategy };
  if (c.imageProcess) state.params.imageProcess = { ...c.imageProcess };
  if (c.videoMode) state.params.videoMode = c.videoMode;
  if (c.descriptionMode) state.params.descriptionMode = c.descriptionMode;
}

// ── 价格计算引擎(P3) ─────────────────────────────────────
// 输入原始价,按策略计算售价/最小价/划线价
function calcPrice(originalPrice, strategy) {
  const p = Number(originalPrice);
  if (!p || isNaN(p)) return null;
  if (strategy.type === 'ratio') {
    const r = Number(strategy.value);
    if (!r || isNaN(r)) return null;
    return Math.round(p * r * 100) / 100;
  }
  if (strategy.type === 'fixed') {
    const v = Number(strategy.value);
    if (!v || isNaN(v)) return null;
    return v;
  }
  return null; // none
}

const originalPrice = computed(() => Number(state.profile?.original?.price) || 0);
const salePrice = computed(() => calcPrice(originalPrice.value, state.params.salePriceStrategy));
const minPrice = computed(() => calcPrice(originalPrice.value, state.params.minPriceStrategy));
const oldPrice = computed(() => calcPrice(salePrice.value || originalPrice.value, state.params.oldPriceStrategy));
const marketP50 = computed(() => state.profile?.original?.marketStats?.priceP50 || null);

// 价格分位判定:策略价 vs 市场 P50
const priceLevel = computed(() => {
  if (!salePrice.value || !marketP50.value) return 'unknown';
  if (salePrice.value < marketP50.value * 0.9) return 'low'; // < P50*0.9 红
  if (salePrice.value > marketP50.value * 1.1) return 'high'; // > P50*1.1 绿
  return 'mid'; // 黄
});

// 售价计算过程描述
const salePriceFormula = computed(() => {
  const s = state.params.salePriceStrategy;
  if (s.type === 'ratio') return `${originalPrice.value} × ${s.value} = ${salePrice.value ?? '—'}`;
  if (s.type === 'fixed') return `固定价 ${s.value}`;
  return '—';
});

// ── 预检清单(P4) ─────────────────────────────────────────
const preflight = computed(() => {
  if (!state.profile?.original) return [];
  const o = state.profile.original;
  const p = state.portalItem;
  const checks = [];

  // 必填:name
  checks.push({
    key: 'name',
    level: o.name ? 'ok' : 'block',
    msg: o.name ? `名称: ${o.name.slice(0, 30)}` : '名称缺失',
  });

  // 必填:price(策略价)
  checks.push({
    key: 'price',
    level: salePrice.value ? 'ok' : 'block',
    msg: salePrice.value ? `售价: ${salePrice.value}` : '售价未计算(原价缺失或策略无效)',
  });

  // 必填:weight
  const w = Number(o.weight);
  checks.push({
    key: 'weight',
    level: w ? 'ok' : 'warn',
    msg: w ? `重量: ${w}g` : '重量缺失(将用默认 100g)',
  });

  // 必填:dimensions
  const dims = o.dimensions;
  const hasDims = dims && Number(dims.depth) && Number(dims.width) && Number(dims.height);
  checks.push({
    key: 'dims',
    level: hasDims ? 'ok' : 'warn',
    msg: hasDims ? `尺寸: ${dims.depth}×${dims.width}×${dims.height}mm` : '尺寸缺失(将用默认 100mm)',
  });

  // 必填:primaryImage
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

  // 品牌(4192)强制"无品牌"确认
  const brandAttr = attrs.find((a) => String(a.id) === '4192');
  const brandVal = brandAttr?.values?.[0]?.value || '';
  checks.push({
    key: 'brand',
    level: brandVal === '无品牌' ? 'ok' : 'block',
    msg: brandVal === '无品牌' ? '品牌: 无品牌(强制 ✓)' : `品牌异常: 期望"无品牌",实际"${brandVal || '缺失'}"`,
  });

  // 价格合理性:售价 < minPrice
  if (minPrice.value && salePrice.value && salePrice.value < minPrice.value) {
    checks.push({ key: 'minPrice', level: 'block', msg: `售价 ${salePrice.value} < 最低价 ${minPrice.value}` });
  }

  // 描述长度
  const descLen = (o.description || '').length;
  checks.push({
    key: 'desc',
    level: descLen >= 100 ? 'ok' : 'warn',
    msg: `描述: ${descLen} 字符${descLen < 100 ? ' (建议≥100)' : ''}`,
  });

  // 视频
  if (o.videoUrl) {
    checks.push({
      key: 'video',
      level: o.videoUrl.endsWith('.mp4') ? 'ok' : 'warn',
      msg: o.videoUrl.endsWith('.mp4')
        ? '视频: .mp4 ✓'
        : `视频: 非 mp4(${state.params.videoMode === 'skip' ? '已跳过' : '将提交'})`,
    });
  }

  return checks;
});

const preflightBlocks = computed(() => preflight.value.filter((c) => c.level === 'block'));
const preflightWarns = computed(() => preflight.value.filter((c) => c.level === 'warn'));
const canSubmit = computed(() => preflightBlocks.value.length === 0 && !state.submitting && !!state.storeId);

// ── portalItem 便捷引用 ────────────────────────────────────
const portalItem = computed(() => state.profile?.portalItem || {});

// ── 属性字典(从 profile 接口返回,id -> {name, description, type, dictionary_id}) ──
const attrDict = computed(() => state.profile?.attrDict || {});

// 取属性的可读名称(displayAttrs 已基于字典构建 name,直接用)
function attrName(a) {
  return a.name || `ID ${a.id}`;
}

// 取属性的可读值:字典属性(有 dictionary_id)若值是数字 id 形式且字典未做映射,保留原值
// 此处仅做基础展示;复杂字典值转换后续可扩展
function attrValues(a) {
  return (a.values || []).map((v) => v.value).filter((v) => v != null && v !== '').join(', ') || '—';
}

// 属性展示列表:以 OPI 字典(attrDict)为基准,展示该类目所有标准属性;
// 值从缓存(portalItem.attributes)中查找匹配;缓存未命中则显示空
// 字典为空时(未选店铺或 type_id 缺失)降级为原逻辑:只展示 portalItem.attributes
const displayAttrs = computed(() => {
  const dictKeys = Object.keys(attrDict.value);
  if (dictKeys.length === 0) {
    // 降级:字典为空,直接展示 portalItem.attributes(用 ID 作名称)
    return (portalItem.value.attributes || []).map((a) => ({
      id: a.id,
      name: '',
      description: '',
      type: '',
      dictionary_id: 0,
      values: a.values || [],
      hasValue: (a.values || []).some((v) => v.value != null && v.value !== ''),
    }));
  }
  // 以字典顺序为基准
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
      values,
      hasValue: values.some((v) => v.value != null && v.value !== ''),
    };
  });
});

// 已填值属性数量(仅统计有值的)
const filledAttrCount = computed(() => displayAttrs.value.filter((a) => a.hasValue).length);

// 所有图片列表(原图侧用于按顺序对比)
const allImages = computed(() => state.profile?.original?.images || []);
const hasImages = computed(() => allImages.value.length > 0);

// 顺序处理:打乱后的图片索引顺序(主图 0 不变,其他随机打乱)
const shuffledOrder = ref([]);

// 处理后图片列表(根据"顺序处理"选项决定顺序)
const processedImages = computed(() => {
  const imgs = allImages.value;
  if (!imgs.length) return [];
  if (
    state.params.imageProcess.shuffle &&
    shuffledOrder.value.length === imgs.length
  ) {
    return shuffledOrder.value.map((i) => imgs[i]).filter(Boolean);
  }
  return imgs;
});

// 重新打乱:主图(索引 0)不变,其他 Fisher-Yates 随机打乱
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

// 勾选"顺序处理"时若未打乱过则自动打乱一次
watch(
  () => state.params.imageProcess.shuffle,
  (v) => {
    if (v && !shuffledOrder.value.length) reshuffle();
  }
);

// ── 一键提交(P4) ─────────────────────────────────────────
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
    // 构造提交 item:用 profile 返回的合成 item,覆盖 price
    const item = JSON.parse(JSON.stringify(state.profile.item));
    if (salePrice.value) item.price = String(salePrice.value);
    if (oldPrice.value) item.old_price = String(oldPrice.value);
    // 视频处理
    if (state.params.videoMode === 'skip') item.videoUrl = '';

    const r = await submitPreviewImport([item], state.storeId);
    state.submitResult = r?.result || {};
    if (r?.result?.error) {
      show(`提交失败:${r.result.error}`, 'error');
    } else {
      show(`提交成功,任务ID:${r.result.local_task_id || r.result.task_id}`, 'success');
      // 跳转上架记录页
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

// 店铺变更时重新加载 profile(传 storeId 做字典过滤)
watch(
  () => state.storeId,
  (v) => {
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
        <button class="btn btn-primary" :disabled="!canSubmit" @click="onSubmit">
          {{ state.submitting ? '提交中...' : '一键提交' }}
        </button>
      </div>
    </div>

    <!-- 加载/错误态 -->
    <p v-if="state.loading" class="pv-loading">加载中...</p>
    <p v-else-if="state.error" class="pv-error">⚠ {{ state.error }}</p>

    <div v-else-if="state.profile" class="pv-body">
      <!-- 左栏:Ozon 详情页风格 -->
      <div class="pv-left">
        <!-- 图片画廊 -->
        <div class="pv-gallery">
          <img
            v-if="state.profile.original.primaryImage"
            :src="state.profile.original.primaryImage"
            class="pv-gallery-main"
            alt=""
            @error="$event.target.style.display = 'none'"
          />
          <div v-else class="pv-no-img">无主图</div>
          <div v-if="state.profile.original.images.length > 1" class="pv-gallery-thumbs">
            <img
              v-for="(img, i) in state.profile.original.images.slice(0, 8)"
              :key="i"
              :src="img"
              class="pv-thumb"
              :class="{ active: i === 0 }"
              alt=""
              loading="lazy"
              @error="$event.target.style.display = 'none'"
            />
          </div>
        </div>

        <!-- 价格区(Ozon 风格) -->
        <div class="pv-price-block">
          <div class="pv-price-main">¥{{ salePrice || state.profile.original.price || '—' }}</div>
          <div v-if="oldPrice" class="pv-price-old">¥{{ oldPrice }}</div>
          <div v-if="state.profile.original.competitorCount != null" class="pv-price-meta">
            跟卖竞争:{{ state.profile.original.competitorCount }} 家
          </div>
        </div>

        <!-- 名称 -->
        <h3 class="pv-name">{{ state.profile.original.name || '(未命名)' }}</h3>

        <!-- 属性表:以 OPI 字典为基准展示该类目所有标准属性,值从缓存填充 -->
        <div v-if="displayAttrs.length" class="pv-attrs">
          <h4>
            属性 (已填 {{ filledAttrCount }}/{{ displayAttrs.length }})
            <span v-if="!Object.keys(attrDict).length" class="muted" style="font-size: 11px; font-weight: normal">
              · 字典未命中,仅显示缓存属性
            </span>
          </h4>
          <div class="pv-attr-scroll">
            <table class="pv-attr-table">
              <thead>
                <tr>
                  <th class="pv-attr-no-h">#</th>
                  <th class="pv-attr-name-h">属性名</th>
                  <th class="pv-attr-val-h">属性值</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(a, idx) in displayAttrs"
                  :key="a.id"
                  :class="{ 'pv-attr-empty': !a.hasValue, 'pv-attr-forced': String(a.id) === '4192' }"
                  :title="a.description || ''"
                >
                  <td class="pv-attr-no">{{ idx + 1 }}</td>
                  <td class="pv-attr-name">
                    {{ attrName(a) }}
                    <span class="pv-attr-id-tag">#{{ a.id }}</span>
                    <span v-if="a.dictionary_id" class="pv-attr-dict-tag" :title="`字典属性 #${a.dictionary_id}`">字典</span>
                  </td>
                  <td class="pv-attr-val">{{ a.hasValue ? attrValues(a) : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 描述 -->
        <div v-if="state.profile.original.description" class="pv-desc">
          <h4>描述</h4>
          <div class="pv-desc-text">
            {{ state.profile.original.description.slice(0, 500)
            }}{{ state.profile.original.description.length > 500 ? '...' : '' }}
          </div>
        </div>

        <!-- 视频 -->
        <div v-if="state.profile.original.videoUrl" class="pv-video">
          <h4>视频</h4>
          <video
            v-if="state.profile.original.videoUrl.endsWith('.mp4')"
            :src="state.profile.original.videoUrl"
            controls
            style="max-width: 100%; max-height: 300px"
          ></video>
          <p v-else class="muted">非 mp4 格式({{ state.profile.original.videoUrl }})</p>
        </div>
      </div>

      <!-- 右栏:对比 + 参数 + 预检 -->
      <div class="pv-right">
        <!-- 缓存命中指示器 -->
        <div class="pv-card">
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
        </div>

        <!-- 价格对比卡(P2) -->
        <div class="pv-card">
          <div class="pv-card-title">价格对比</div>
          <div class="pv-price-compare">
            <div class="pv-pc-col">
              <div class="pv-pc-label">源价</div>
              <div class="pv-pc-val">¥{{ originalPrice || '—' }}</div>
            </div>
            <div class="pv-pc-arrow">→</div>
            <div class="pv-pc-col">
              <div class="pv-pc-label">策略价</div>
              <div class="pv-pc-val" :class="'level-' + priceLevel">¥{{ salePrice || '—' }}</div>
              <div class="pv-pc-formula">{{ salePriceFormula }}</div>
            </div>
            <div v-if="marketP50" class="pv-pc-col">
              <div class="pv-pc-label">市场 P50</div>
              <div class="pv-pc-val">¥{{ marketP50 }}</div>
            </div>
          </div>
          <div v-if="minPrice" class="pv-pc-min">
            最低价: ¥{{ minPrice }}
            <span v-if="salePrice && salePrice < minPrice" class="pv-pc-warn">⚠ 售价低于最低价!</span>
          </div>
        </div>

        <!-- 图片对比卡(左右分栏:左=处理前所有原图,右=处理后所有图) -->
        <div class="pv-card">
          <div class="pv-card-title">
            图片对比 · 共 {{ allImages.length }} 张
            <span class="pv-ic-tags">{{ state.params.imageProcess.watermark ? '[水]' : '' }}{{ state.params.imageProcess.poster ? '[海]' : '' }}{{ state.params.imageProcess.antiCopy ? '[防盗]' : '' }}{{ state.params.imageProcess.shuffle ? '[顺序]' : '' }}</span>
          </div>
          <div v-if="!hasImages" class="pv-no-img-sm">无图片</div>
          <div v-else class="pv-img-compare-cols">
            <!-- 左:处理前 -->
            <div class="pv-img-col-block">
              <div class="pv-img-row-label">处理前 · {{ allImages.length }} 张</div>
              <div class="pv-img-grid">
                <div v-for="(img, i) in allImages" :key="'o' + i" class="pv-img-cell">
                  <div class="pv-img-cell-idx">#{{ i + 1 }}{{ i === 0 ? ' 主图' : '' }}</div>
                  <img
                    :src="img"
                    class="pv-ic-img"
                    alt=""
                    loading="lazy"
                    @error="$event.target.style.opacity = 0.2"
                  />
                </div>
              </div>
            </div>
            <!-- 右:处理后 -->
            <div class="pv-img-col-block">
              <div class="pv-img-row-label">
                处理后 · {{ processedImages.length }} 张
                <span v-if="state.params.imageProcess.shuffle" class="pv-ic-tags">[顺序已打乱]</span>
              </div>
              <div class="pv-img-grid">
                <div v-for="(img, i) in processedImages" :key="'p' + i" class="pv-img-cell">
                  <div class="pv-img-cell-idx">#{{ i + 1 }}{{ i === 0 ? ' 主图' : '' }}</div>
                  <img
                    :src="img"
                    class="pv-ic-img"
                    alt=""
                    loading="lazy"
                    @error="$event.target.style.opacity = 0.2"
                  />
                </div>
              </div>
            </div>
          </div>
          <p class="muted pv-ic-note">主图处理待接入后端(当前处理后展示原图,顺序处理可调整顺序)</p>
        </div>

        <!-- 上架参数面板(P3) -->
        <div class="pv-card">
          <div class="pv-card-title">上架参数</div>

          <!-- 价格公式 -->
          <fieldset class="pv-fieldset">
            <legend>价格策略</legend>
            <div class="pv-param-row">
              <label>售价</label>
              <select class="filter-select" v-model="state.params.salePriceStrategy.type">
                <option value="ratio">倍率</option>
                <option value="fixed">固定价</option>
              </select>
              <input
                class="filter-input"
                type="number"
                step="0.01"
                v-model.number="state.params.salePriceStrategy.value"
                :placeholder="state.params.salePriceStrategy.type === 'ratio' ? '如 1.3' : '如 1600'"
              />
              <span class="pv-param-result">= ¥{{ salePrice || '—' }}</span>
            </div>
            <div class="pv-param-row">
              <label>最低价</label>
              <select class="filter-select" v-model="state.params.minPriceStrategy.type">
                <option value="none">不设</option>
                <option value="ratio">倍率</option>
                <option value="fixed">固定价</option>
              </select>
              <input
                v-if="state.params.minPriceStrategy.type !== 'none'"
                class="filter-input"
                type="number"
                step="0.01"
                v-model.number="state.params.minPriceStrategy.value"
              />
              <span v-if="minPrice" class="pv-param-result">= ¥{{ minPrice }}</span>
            </div>
            <div class="pv-param-row">
              <label>划线价</label>
              <select class="filter-select" v-model="state.params.oldPriceStrategy.type">
                <option value="none">不设</option>
                <option value="ratio">倍率</option>
              </select>
              <input
                v-if="state.params.oldPriceStrategy.type !== 'none'"
                class="filter-input"
                type="number"
                step="0.01"
                v-model.number="state.params.oldPriceStrategy.value"
              />
              <span v-if="oldPrice" class="pv-param-result">= ¥{{ oldPrice }}</span>
            </div>
          </fieldset>

          <!-- 主图处理链 -->
          <fieldset class="pv-fieldset">
            <legend>主图处理</legend>
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
              <label class="pv-chain-item">
                <input type="checkbox" v-model="state.params.imageProcess.shuffle" />
                顺序处理
              </label>
              <button
                v-if="state.params.imageProcess.shuffle"
                class="btn btn-ghost pv-reshuffle-btn"
                type="button"
                @click="reshuffle"
                title="主图不变,其他图片重新随机打乱"
              >
                🎲 重新打乱
              </button>
            </div>
            <p class="muted pv-chain-note">
              顺序处理:主图保持第 1 张不变,其他图片随机打乱顺序 · 其他处理链待接入后端
            </p>
          </fieldset>

          <!-- 其他参数 -->
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
        </div>

        <!-- 预检清单(P4) -->
        <div class="pv-card">
          <div class="pv-card-title">预检清单</div>
          <ul class="pv-preflight">
            <li v-for="c in preflight" :key="c.key" :class="'pf-' + c.level">
              <span class="pf-icon">{{ c.level === 'ok' ? '✓' : c.level === 'warn' ? '⚠' : '✗' }}</span>
              {{ c.msg }}
            </li>
          </ul>
        </div>

        <!-- 字段 diff(简化版) -->
        <div class="pv-card">
          <div class="pv-card-title">字段概览</div>
          <table class="pv-diff-table">
            <tr>
              <td>名称</td>
              <td>{{ state.profile.original.name || '—' }}</td>
            </tr>
            <tr>
              <td>SKU</td>
              <td>{{ sku }}</td>
            </tr>
            <tr>
              <td>Offer ID</td>
              <td>{{ state.profile.original.offerId }}</td>
            </tr>
            <tr>
              <td>条码</td>
              <td>{{ state.profile.original.barcode || '—' }}</td>
            </tr>
            <tr>
              <td>重量</td>
              <td>{{ state.profile.original.weight || '—' }}g</td>
            </tr>
            <tr>
              <td>尺寸</td>
              <td>
                {{
                  state.profile.original.dimensions
                    ? `${state.profile.original.dimensions.depth}×${state.profile.original.dimensions.width}×${state.profile.original.dimensions.height}mm`
                    : '—'
                }}
              </td>
            </tr>
            <tr>
              <td>图片数</td>
              <td>{{ state.profile.original.images.length }}</td>
            </tr>
            <tr>
              <td>属性数</td>
              <td>{{ filledAttrCount }}/{{ displayAttrs.length }}</td>
            </tr>
            <tr>
              <td>品牌</td>
              <td>
                <span class="pv-brand-forced">无品牌(强制)</span>
              </td>
            </tr>
            <tr>
              <td>复杂属性</td>
              <td>{{ portalItem.complexAttributes?.length || 0 }}</td>
            </tr>
            <tr>
              <td>类目 ID</td>
              <td>{{ portalItem.descriptionCategoryId || '—' }}</td>
            </tr>
            <tr>
              <td>类型 ID</td>
              <td>{{ portalItem.typeId || '—' }}</td>
            </tr>
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
.pv-body {
  display: flex;
  gap: 16px;
  padding: 16px;
  overflow: auto;
  flex: 1;
}
.pv-left {
  width: 40%;
  min-width: 360px;
  max-width: 520px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  overflow-y: auto;
}
.pv-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 400px;
}
.pv-gallery {
  margin-bottom: 16px;
}
.pv-gallery-main {
  width: 100%;
  max-height: 400px;
  object-fit: contain;
  border-radius: 6px;
  background: #f9fafb;
}
.pv-no-img {
  width: 100%;
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f3f4f6;
  color: #9ca3af;
  border-radius: 6px;
}
.pv-gallery-thumbs {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
}
.pv-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
  border: 2px solid transparent;
  cursor: pointer;
}
.pv-thumb.active {
  border-color: var(--primary, #2563eb);
}
.pv-price-block {
  margin-bottom: 16px;
}
.pv-price-main {
  font-size: 28px;
  font-weight: 700;
  color: #1f2937;
}
.pv-price-old {
  font-size: 16px;
  color: #9ca3af;
  text-decoration: line-through;
}
.pv-price-meta {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}
.pv-name {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 16px;
  line-height: 1.4;
}
.pv-attrs,
.pv-desc,
.pv-video {
  margin-bottom: 16px;
}
.pv-attrs h4,
.pv-desc h4,
.pv-video h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px;
  color: #374151;
}
.pv-attr-scroll {
  max-height: 480px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
}
.pv-attr-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}
.pv-attr-table thead th {
  text-align: left;
  padding: 4px 8px;
  background: #f9fafb;
  color: #6b7280;
  font-weight: 600;
  border-bottom: 1px solid #e5e7eb;
  font-size: 11px;
  position: sticky;
  top: 0;
  z-index: 1;
}
.pv-attr-table td {
  padding: 5px 8px;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
}
.pv-attr-no {
  width: 32px;
  color: #9ca3af;
  font-family: monospace;
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
}
.pv-attr-name {
  width: 40%;
  color: #374151;
  font-weight: 500;
  word-break: break-word;
}
.pv-attr-val {
  color: #111827;
  word-break: break-word;
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
.pv-attr-forced {
  background: #fef3c7;
}
.pv-attr-empty {
  color: #9ca3af;
}
.pv-attr-empty .pv-attr-val {
  color: #d1d5db;
}
.pv-attr-dict-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  color: #6366f1;
  background: #eef2ff;
  border-radius: 3px;
}
.pv-attr-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: #92400e;
  background: #fde68a;
  border-radius: 3px;
}
.pv-brand-forced {
  display: inline-block;
  padding: 1px 8px;
  font-size: 12px;
  font-weight: 600;
  color: #92400e;
  background: #fde68a;
  border-radius: 3px;
}
.pv-desc-text {
  font-size: 13px;
  color: #4b5563;
  line-height: 1.5;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}
.pv-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
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
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
  color: #374151;
}
.pv-dots {
  display: flex;
  gap: 4px;
}
.pv-price-compare {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pv-pc-col {
  flex: 1;
  text-align: center;
}
.pv-pc-label {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 4px;
}
.pv-pc-val {
  font-size: 20px;
  font-weight: 700;
}
.pv-pc-val.level-low {
  color: #dc2626;
}
.pv-pc-val.level-mid {
  color: #d97706;
}
.pv-pc-val.level-high {
  color: #059669;
}
.pv-pc-formula {
  font-size: 10px;
  color: #9ca3af;
  margin-top: 2px;
}
.pv-pc-arrow {
  font-size: 20px;
  color: #9ca3af;
}
.pv-pc-min {
  font-size: 12px;
  color: #6b7280;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f3f4f6;
}
.pv-pc-warn {
  color: #dc2626;
  font-weight: 600;
  margin-left: 8px;
}
.pv-img-compare-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.pv-img-col-block {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px;
  background: #fafafa;
}
.pv-img-row-label {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
}
.pv-img-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pv-img-cell {
  flex: 1 1 120px;
  max-width: 200px;
  text-align: center;
  min-width: 100px;
}
.pv-img-cell-idx {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 4px;
}
.pv-ic-col {
  flex: 1;
  text-align: center;
  min-width: 0;
}
.pv-ic-label {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 4px;
}
.pv-ic-tags {
  color: #2563eb;
  font-size: 10px;
  margin-left: 6px;
}
.pv-ic-img {
  width: 100%;
  max-height: 160px;
  object-fit: contain;
  border-radius: 4px;
  background: #f9fafb;
}
.pv-no-img-sm {
  height: 100px;
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
.pv-fieldset {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
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
  margin-bottom: 8px;
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
.pv-process-chain {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
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
.pv-preflight {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 13px;
}
.pv-preflight li {
  padding: 4px 0;
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
.pv-diff-table {
  width: 100%;
  font-size: 12px;
}
.pv-diff-table td {
  padding: 4px 8px;
  border-bottom: 1px solid #f3f4f6;
}
.pv-diff-table td:first-child {
  color: #6b7280;
  width: 90px;
}
.pv-error-text {
  color: #dc2626;
  font-weight: 600;
}
</style>
