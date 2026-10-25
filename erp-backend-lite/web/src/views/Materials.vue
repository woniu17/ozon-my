<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { parseUtcDate } from '../utils/time.js';
import { getStores } from '../api/stores.js';
import { getListingTemplates } from '../api/listingTemplates.js';
import {
  getMaterials,
  getMaterial,
  generateMaterials,
  approveMaterial,
  publishMaterial,
  batchPublishMaterials,
  getMaterialVersions,
  getMaterialPublishes,
  deleteMaterial,
} from '../api/listing-materials.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppModal from '../components/AppModal.vue';

const { show } = useToast();
const confirmStore = useConfirmStore();

const list = ref([]);
const loading = ref(false);
const stores = ref([]);
const templates = ref([]);

// ── 筛选 ──────────────────────────────────────────────
const filters = reactive({ sourceSku: '', status: '' });

async function load() {
  loading.value = true;
  try {
    const params = {};
    if (filters.sourceSku.trim()) params.sourceSku = filters.sourceSku.trim();
    if (filters.status) params.status = filters.status;
    const r = await getMaterials(params);
    list.value = Array.isArray(r.items) ? r.items : [];
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    loading.value = false;
  }
}

// ── 生成素材 ──────────────────────────────────────────
const genOpen = ref(false);
const genSaving = ref(false);
const genErr = ref('');
const genForm = reactive({
  sourceSku: '',
  sourceType: 'product',
  count: 3,
  aiRewrite: false,
  aiStyles: ['marketing', 'simple', 'seo'],
  titleTemplates: '',
  imageMode: 'shuffle',
  templateId: '',
  defaultStock: 10,
  sourceStoreId: '',
});

function resetGenForm() {
  genForm.sourceSku = '';
  genForm.sourceType = 'product';
  genForm.count = 3;
  genForm.aiRewrite = false;
  genForm.aiStyles = ['marketing', 'simple', 'seo'];
  genForm.titleTemplates = '';
  genForm.imageMode = 'shuffle';
  genForm.templateId = '';
  genForm.defaultStock = 10;
  genForm.sourceStoreId = '';
  genErr.value = '';
}

function openGenerate() {
  resetGenForm();
  genOpen.value = true;
}

async function submitGenerate() {
  genErr.value = '';
  if (!genForm.sourceSku.trim()) {
    genErr.value = '源 SKU 必填';
    return;
  }
  const styleList = genForm.aiStyles
    .map((s) => s.trim())
    .filter(Boolean);
  const titleTemplates = genForm.titleTemplates
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.includes('{name}'));
  genSaving.value = true;
  try {
    const body = {
      sourceSku: genForm.sourceSku.trim(),
      sourceType: genForm.sourceType,
      count: Math.max(1, Math.min(5, Math.floor(Number(genForm.count) || 1))),
      aiRewrite: genForm.aiRewrite,
      aiStyles: styleList,
      imageMode: genForm.imageMode,
      templateId: genForm.templateId ? Number(genForm.templateId) : undefined,
      defaultStock: Number(genForm.defaultStock) || 0,
      sourceStoreId: genForm.sourceStoreId || undefined,
    };
    if (titleTemplates.length) body.titleTemplates = titleTemplates;
    const r = await generateMaterials(body);
    show(`已生成 ${r.count || 0} 份素材`, 'success');
    genOpen.value = false;
    await load();
  } catch (err) {
    genErr.value = err.message || String(err);
  } finally {
    genSaving.value = false;
  }
}

// ── 详情 ──────────────────────────────────────────────
const detailOpen = ref(false);
const detail = ref(null);
const detailTab = ref('overview');
const versions = ref([]);
const publishes = ref([]);

const detailImages = computed(() => {
  if (!detail.value) return [];
  try {
    return JSON.parse(detail.value.images || '[]');
  } catch {
    return [];
  }
});
const detailAttrs = computed(() => {
  if (!detail.value) return [];
  try {
    return JSON.parse(detail.value.attributes || '[]');
  } catch {
    return [];
  }
});
const detailPrice = computed(() => {
  if (!detail.value) return {};
  try {
    return JSON.parse(detail.value.price_config || '{}');
  } catch {
    return {};
  }
});

async function openDetail(m) {
  detail.value = m;
  detailTab.value = 'overview';
  versions.value = [];
  publishes.value = [];
  detailOpen.value = true;
  try {
    const [v, p] = await Promise.all([
      getMaterialVersions(m.id).catch(() => ({ items: [] })),
      getMaterialPublishes(m.id).catch(() => ({ items: [] })),
    ]);
    versions.value = Array.isArray(v.items) ? v.items : [];
    publishes.value = Array.isArray(p.items) ? p.items : [];
  } catch {
    /* 详情非关键路径,失败不阻断 */
  }
}

// ── 审核通过 ─────────────────────────────────────────
async function doApprove(m) {
  try {
    await approveMaterial(m.id);
    show(`素材 #${m.id} 已审核通过`, 'success');
    await load();
    if (detail.value?.id === m.id) detail.value = await getMaterial(m.id).catch(() => detail.value);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 发布(单素材) ──────────────────────────────────────
const pubOpen = ref(false);
const pubSaving = ref(false);
const pubErr = ref('');
const pubForm = reactive({ storeId: '', defaultStock: 10 });
let pubMaterialId = null;

function openPublish(m) {
  pubMaterialId = m.id;
  pubForm.storeId = '';
  pubForm.defaultStock = Number(m.default_stock) || 10;
  pubErr.value = '';
  pubOpen.value = true;
}

async function submitPublish() {
  pubErr.value = '';
  if (!pubForm.storeId) {
    pubErr.value = '请选择目标店铺';
    return;
  }
  pubSaving.value = true;
  try {
    const r = await publishMaterial(pubMaterialId, {
      storeId: pubForm.storeId,
      defaultStock: Number(pubForm.defaultStock) || 10,
    });
    show(r.error ? `发布失败:${r.error}` : `已提交上架(任务 ${r.localTaskId || ''})`, r.error ? 'error' : 'success');
    pubOpen.value = false;
    await load();
    if (detail.value?.id === pubMaterialId) {
      const p = await getMaterialPublishes(pubMaterialId).catch(() => ({ items: [] }));
      publishes.value = Array.isArray(p.items) ? p.items : [];
    }
  } catch (err) {
    pubErr.value = err.message || String(err);
  } finally {
    pubSaving.value = false;
  }
}

// ── 批量发布 ──────────────────────────────────────────
const batchOpen = ref(false);
const batchSaving = ref(false);
const batchErr = ref('');
const batchForm = reactive({ storeIds: [], defaultStock: 10 });
const selectedIds = ref([]);

const selectedMaterials = computed(() => {
  const set = new Set(selectedIds.value.map(Number));
  return list.value.filter((m) => set.has(Number(m.id)));
});

function toggleSelect(m) {
  const id = Number(m.id);
  const idx = selectedIds.value.indexOf(id);
  if (idx >= 0) selectedIds.value.splice(idx, 1);
  else selectedIds.value.push(id);
}

function openBatch() {
  batchErr.value = '';
  batchForm.storeIds = [];
  batchForm.defaultStock = 10;
  batchOpen.value = true;
}

async function submitBatch() {
  batchErr.value = '';
  if (selectedMaterials.value.length === 0) {
    batchErr.value = '请先勾选素材';
    return;
  }
  if (batchForm.storeIds.length === 0) {
    batchErr.value = '请至少选择一个目标店铺';
    return;
  }
  batchSaving.value = true;
  try {
    const assignments = [];
    for (const m of selectedMaterials.value) {
      for (const storeId of batchForm.storeIds) {
        assignments.push({ materialId: m.id, targetStoreId: storeId, defaultStock: Number(batchForm.defaultStock) || 10 });
      }
    }
    const r = await batchPublishMaterials({ name: '素材批量发布', assignments });
    show(`已创建批次 ${r.batchNo || ''},共 ${r.validCount || 0} 条`, 'success');
    batchOpen.value = false;
    selectedIds.value = [];
    await load();
  } catch (err) {
    batchErr.value = err.message || String(err);
  } finally {
    batchSaving.value = false;
  }
}

// ── 归档删除 ──────────────────────────────────────────
async function doArchive(m) {
  if (!(await confirmStore.ask({ message: `确认归档素材 #${m.id}「${m.name}」?`, danger: true }))) return;
  try {
    await deleteMaterial(m.id);
    show('已归档', 'success');
    await load();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 工具 ──────────────────────────────────────────────
function fmtTime(t) {
  const d = parseUtcDate(t);
  if (!d) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusBadge(status) {
  return (
    {
      draft: '草稿',
      ready: '待发布',
      published: '已发布',
      archived: '已归档',
    }[status] || status
  );
}
function statusClass(status) {
  return (
    {
      draft: 'badge badge-pending',
      ready: 'badge badge-success',
      published: 'badge badge-info',
      archived: 'badge badge-muted',
    }[status] || 'badge'
  );
}

function storeName(id) {
  return stores.value.find((s) => s.id === id)?.name || id;
}
function templateName(id) {
  const n = Number(id);
  return templates.value.find((t) => Number(t.id) === n)?.name || (id ? `#${id}` : '默认');
}

onMounted(async () => {
  await Promise.all([
    load(),
    getStores().then((r) => (stores.value = Array.isArray(r) ? r : [])).catch(() => {}),
    getListingTemplates().then((r) => (templates.value = Array.isArray(r) ? r : [])).catch(() => {}),
  ]);
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>素材管理</h2>
      <div class="toolbar-actions">
        <button class="btn btn-primary" :disabled="selectedMaterials.length === 0" @click="openBatch">
          批量发布({{ selectedMaterials.length }})
        </button>
        <button class="btn btn-primary" @click="openGenerate">+ 生成素材</button>
      </div>
    </div>

    <p class="muted hint">
      基于同一商品生成一份或多份可上架素材(差异化标题/描述/图片/型号名称),审核通过后可发布到其它店铺。AI 重写需配置 OPENAI_API_KEY,未配置时自动回退模板标题。
    </p>

    <!-- 筛选 -->
    <div class="filter-bar">
      <input class="input" v-model.trim="filters.sourceSku" placeholder="源 SKU" @keyup.enter="load" />
      <select class="input" v-model="filters.status">
        <option value="">全部状态</option>
        <option value="draft">草稿</option>
        <option value="ready">待发布</option>
        <option value="published">已发布</option>
        <option value="archived">已归档</option>
      </select>
      <button class="btn" @click="load">查询</button>
      <button class="btn btn-ghost" @click="filters.sourceSku = ''; filters.status = ''; load()">清空</button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!list.length" class="empty">暂无素材,点击「生成素材」创建</div>
    <table v-else class="mat-table">
      <thead>
        <tr>
          <th class="col-check"><input type="checkbox" :checked="selectedMaterials.length === list.length" @change="selectedIds = selectedMaterials.length === list.length ? [] : list.map((m) => Number(m.id))" /></th>
          <th>ID</th>
          <th>源 SKU</th>
          <th>标题</th>
          <th>型号</th>
          <th>图片</th>
          <th>属性</th>
          <th>状态</th>
          <th>创建时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in list" :key="m.id">
          <td class="col-check">
            <input type="checkbox" :checked="selectedIds.includes(Number(m.id))" @change="toggleSelect(m)" />
          </td>
          <td class="muted">{{ m.id }}</td>
          <td>{{ m.source_sku }}</td>
          <td class="title-cell" :title="m.name">{{ m.name }}</td>
          <td class="muted">{{ m.model_name || '—' }}</td>
          <td class="muted">{{ Array.isArray(JSON.parse(m.images || '[]')) ? JSON.parse(m.images).length : 0 }}</td>
          <td class="muted">{{ Array.isArray(JSON.parse(m.attributes || '[]')) ? JSON.parse(m.attributes).length : 0 }}</td>
          <td><span :class="statusClass(m.status)">{{ statusBadge(m.status) }}</span></td>
          <td class="muted">{{ fmtTime(m.created_at) }}</td>
          <td class="actions">
            <button class="btn btn-sm btn-ghost" @click="openDetail(m)">详情</button>
            <button v-if="m.status === 'draft'" class="btn btn-sm btn-ghost" @click="doApprove(m)">审核通过</button>
            <button v-if="m.status !== 'archived'" class="btn btn-sm btn-primary" @click="openPublish(m)">发布</button>
            <button class="btn btn-sm btn-danger" @click="doArchive(m)">归档</button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 生成素材弹窗 -->
    <AppModal :open="genOpen" title="生成素材" size="lg" @update:open="genOpen = $event">
      <form class="form" @submit.prevent="submitGenerate">
        <div class="grid2">
          <label>
            <span>源 SKU <em>*</em></span>
            <input type="text" v-model.trim="genForm.sourceSku" placeholder="如 5389811474" />
          </label>
          <label>
            <span>数据源</span>
            <select v-model="genForm.sourceType">
              <option value="product">Ozon 商品数据(product_data_cache)</option>
              <option value="collect">采集箱(collect cache)</option>
            </select>
          </label>
          <label>
            <span>生成份数(1~5)</span>
            <input type="number" v-model.number="genForm.count" min="1" max="5" />
          </label>
          <label>
            <span>价格模板</span>
            <select v-model="genForm.templateId">
              <option value="">不使用</option>
              <option v-for="t in templates" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
            </select>
          </label>
          <label>
            <span>图片处理</span>
            <select v-model="genForm.imageMode">
              <option value="shuffle">打乱非主图顺序</option>
              <option value="keep">保持原序</option>
            </select>
          </label>
          <label>
            <span>默认库存</span>
            <input type="number" v-model.number="genForm.defaultStock" min="0" />
          </label>
        </div>

        <fieldset class="form-group">
          <legend>AI 多风格重写(可选)</legend>
          <div class="checkbox-row">
            <label class="check">
              <input type="checkbox" v-model="genForm.aiRewrite" />
              <span>开启 AI 重写标题/描述(需 OPENAI_API_KEY)</span>
            </label>
          </div>
          <label>
            <span>风格(逗号分隔,按份数依次取)</span>
            <input
              type="text"
              :value="genForm.aiStyles.join(', ')"
              @input="genForm.aiStyles = $event.target.value.split(',').map((s) => s.trim()).filter(Boolean)"
              placeholder="marketing, simple, seo, default"
            />
          </label>
          <div class="chip-row">
            <button type="button" class="btn btn-sm btn-ghost" @click="genForm.aiStyles = ['marketing']">营销风</button>
            <button type="button" class="btn btn-sm btn-ghost" @click="genForm.aiStyles = ['simple']">简洁风</button>
            <button type="button" class="btn btn-sm btn-ghost" @click="genForm.aiStyles = ['seo']">SEO风</button>
            <button type="button" class="btn btn-sm btn-ghost" @click="genForm.aiStyles = ['marketing', 'simple', 'seo']">全部</button>
          </div>
        </fieldset>

        <label>
          <span>标题模板(每行一个,含 {name}/{typeName}/{modelName},可留空)</span>
          <textarea v-model="genForm.titleTemplates" rows="3" placeholder="{name}&#10;{name} {typeName}&#10;{name} — {modelName}"></textarea>
        </label>

        <p v-if="genErr" class="error">{{ genErr }}</p>
        <div class="form-actions">
          <button type="button" class="btn" @click="genOpen = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="genSaving">{{ genSaving ? '生成中…' : '生成' }}</button>
        </div>
      </form>
    </AppModal>

    <!-- 素材详情弹窗 -->
    <AppModal :open="detailOpen" :title="detail ? `素材 #${detail.id} · ${detail.name}` : '素材详情'" size="xl" @update:open="detailOpen = $event">
      <template v-if="detail">
        <div class="tabs">
          <button :class="['tab-btn', { active: detailTab === 'overview' }]" @click="detailTab = 'overview'">概览</button>
          <button :class="['tab-btn', { active: detailTab === 'images' }]" @click="detailTab = 'images'">图片({{ detailImages.length }})</button>
          <button :class="['tab-btn', { active: detailTab === 'attrs' }]" @click="detailTab = 'attrs'">属性({{ detailAttrs.length }})</button>
          <button :class="['tab-btn', { active: detailTab === 'versions' }]" @click="detailTab = 'versions'">版本({{ versions.length }})</button>
          <button :class="['tab-btn', { active: detailTab === 'publishes' }]" @click="detailTab = 'publishes'">发布记录({{ publishes.length }})</button>
        </div>

        <div v-if="detailTab === 'overview'" class="detail-overview">
          <dl class="kv">
            <dt>源 SKU</dt><dd>{{ detail.source_sku }}</dd>
            <dt>型号名称</dt><dd>{{ detail.model_name || '—' }}</dd>
            <dt>类目/类型 ID</dt><dd>{{ detail.description_category_id }} / {{ detail.type_id }}</dd>
            <dt>状态</dt><dd><span :class="statusClass(detail.status)">{{ statusBadge(detail.status) }}</span></dd>
            <dt>价格配置</dt><dd>{{ detailPrice.templateId ? templateName(detailPrice.templateId) : '无模板' }} / 源价 {{ detailPrice.sourcePrice ?? '—' }}</dd>
            <dt>默认库存</dt><dd>{{ detail.default_stock }}</dd>
            <dt>创建时间</dt><dd>{{ fmtTime(detail.created_at) }}</dd>
            <dt>描述</dt><dd class="desc-text">{{ detail.description || '—' }}</dd>
          </dl>
        </div>

        <div v-else-if="detailTab === 'images'" class="img-grid">
          <div v-for="(img, i) in detailImages" :key="i" class="img-item">
            <img :src="img.file_name || img.url" :alt="`图${i + 1}`" loading="lazy" />
            <span class="img-tag" :class="{ primary: img.default }">{{ img.default ? '主图' : `图${i + 1}` }}</span>
          </div>
          <div v-if="!detailImages.length" class="empty">无图片</div>
        </div>

        <div v-else-if="detailTab === 'attrs'" class="attr-table-wrap">
          <table class="mat-table compact">
            <thead><tr><th>ID</th><th>属性名</th><th>值</th></tr></thead>
            <tbody>
              <tr v-for="(a, i) in detailAttrs" :key="i">
                <td class="muted">{{ a.id }}</td>
                <td>{{ a.name || `#${a.id}` }}</td>
                <td>{{ (a.values || []).map((v) => v.value ?? v.dictionary_value_id).join(', ') }}</td>
              </tr>
              <tr v-if="!detailAttrs.length"><td colspan="3" class="empty">无属性</td></tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="detailTab === 'versions'" class="scroll-list">
          <div v-for="v in versions" :key="v.id" class="list-row">
            <span class="badge badge-info">v{{ v.version }}</span>
            <span class="muted">{{ fmtTime(v.created_at) }}</span>
            <span>{{ v.change_note || '—' }}</span>
          </div>
          <div v-if="!versions.length" class="empty">暂无版本记录</div>
        </div>

        <div v-else-if="detailTab === 'publishes'" class="scroll-list">
          <div v-for="p in publishes" :key="p.id" class="list-row">
            <span :class="statusClass(p.status)">{{ statusBadge(p.status) }}</span>
            <span>{{ storeName(p.store_id) }}</span>
            <span class="muted">任务 {{ p.local_task_id || '—' }}</span>
            <span class="muted">{{ p.error_message ? p.error_message.slice(0, 60) : '' }}</span>
          </div>
          <div v-if="!publishes.length" class="empty">暂无发布记录</div>
        </div>
      </template>
    </AppModal>

    <!-- 单素材发布弹窗 -->
    <AppModal :open="pubOpen" title="发布素材" @update:open="pubOpen = $event">
      <form class="form" @submit.prevent="submitPublish">
        <label>
          <span>目标店铺 <em>*</em></span>
          <select v-model="pubForm.storeId">
            <option value="">请选择店铺</option>
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }} ({{ s.id }})</option>
          </select>
        </label>
        <label>
          <span>默认库存</span>
          <input type="number" v-model.number="pubForm.defaultStock" min="0" />
        </label>
        <p v-if="pubErr" class="error">{{ pubErr }}</p>
        <div class="form-actions">
          <button type="button" class="btn" @click="pubOpen = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="pubSaving">{{ pubSaving ? '发布中…' : '发布' }}</button>
        </div>
      </form>
    </AppModal>

    <!-- 批量发布弹窗 -->
    <AppModal :open="batchOpen" title="批量发布素材" size="md" @update:open="batchOpen = $event">
      <form class="form" @submit.prevent="submitBatch">
        <p class="muted">
          已选 {{ selectedMaterials.length }} 份素材:{{ selectedMaterials.map((m) => `#${m.id}`).join(', ') || '—' }}
        </p>
        <label>
          <span>目标店铺(可多选) <em>*</em></span>
          <div class="store-check-list">
            <label v-for="s in stores" :key="s.id" class="check">
              <input type="checkbox" :value="s.id" v-model="batchForm.storeIds" />
              <span>{{ s.name }} ({{ s.id }})</span>
            </label>
          </div>
        </label>
        <label>
          <span>默认库存(所有分配)</span>
          <input type="number" v-model.number="batchForm.defaultStock" min="0" />
        </label>
        <p v-if="batchErr" class="error">{{ batchErr }}</p>
        <div class="form-actions">
          <button type="button" class="btn" @click="batchOpen = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="batchSaving">{{ batchSaving ? '创建批次中…' : '创建批量任务' }}</button>
        </div>
      </form>
    </AppModal>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  gap: 8px;
  margin: 12px 0;
  flex-wrap: wrap;
}
.filter-bar .input {
  width: 220px;
}
.toolbar-actions {
  display: flex;
  gap: 8px;
}
.mat-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: var(--card-bg, #fff);
}
.mat-table th,
.mat-table td {
  border: 1px solid var(--border-color, #eee);
  padding: 8px 10px;
  text-align: left;
  vertical-align: middle;
}
.mat-table th {
  background: var(--bg-muted, #f8f9fa);
  font-weight: 600;
  white-space: nowrap;
}
.mat-table.compact th,
.mat-table.compact td {
  padding: 5px 8px;
}
.col-check {
  width: 32px;
  text-align: center;
}
.title-cell {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  white-space: nowrap;
}
.actions .btn {
  margin-right: 4px;
}
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-color, #eee);
  margin-bottom: 12px;
  padding-bottom: 8px;
  flex-wrap: wrap;
}
.tab-btn {
  border: none;
  background: transparent;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-muted, #666);
}
.tab-btn.active {
  background: var(--primary, #2563eb);
  color: #fff;
}
.detail-overview .kv {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 6px 12px;
  font-size: 13px;
}
.detail-overview .kv dt {
  color: var(--text-muted, #666);
  font-weight: 600;
}
.detail-overview .kv dd {
  margin: 0;
  word-break: break-word;
}
.desc-text {
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}
.img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 10px;
  max-height: 420px;
  overflow: auto;
}
.img-item {
  position: relative;
  border: 1px solid var(--border-color, #eee);
  border-radius: 8px;
  overflow: hidden;
  aspect-ratio: 1;
  background: #f6f6f6;
}
.img-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.img-tag {
  position: absolute;
  left: 4px;
  bottom: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}
.img-tag.primary {
  background: #2563eb;
}
.attr-table-wrap {
  max-height: 420px;
  overflow: auto;
}
.scroll-list {
  max-height: 420px;
  overflow: auto;
}
.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px;
  border-bottom: 1px dashed var(--border-color, #eee);
  font-size: 13px;
}
.store-check-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px;
  max-height: 220px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--border-color, #eee);
  border-radius: 8px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.checkbox-row {
  margin: 6px 0;
}
.chip-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.badge-muted {
  background: #f0f0f0;
  color: #888;
}
.badge-info {
  background: #e0f2fe;
  color: #0369a1;
}
.error {
  color: #dc2626;
  font-size: 13px;
  margin: 8px 0;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>