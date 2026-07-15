<script setup>
import { ref, reactive, onMounted } from 'vue';
import {
  getListingTemplates,
  createListingTemplate,
  updateListingTemplate,
  deleteListingTemplate,
} from '../api/listingTemplates.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';

const { show } = useToast();

const list = ref([]);
const loading = ref(false);

// 默认 config(对齐 mv-listing-config 字段)
function defaultConfig() {
  return {
    brand: 'no_brand',
    imageOrder: 'keep',
    currency: 'CNY',
    mergeEnabled: false,
    uploadMode: 'api',
    applyWatermark: false,
    watermarkTemplateId: '',
    applyPoster: false,
    posterPrimaryOnly: false,
    applyAiRewrite: false,
    defaultStock: 10,
    salePriceStrategy: { type: 'ratio', value: 1 },
    minPriceStrategy: null,
    oldPriceStrategy: { type: 'ratio', value: 2 },
  };
}

// 编辑/新增弹窗
const editOpen = ref(false);
const editSaving = ref(false);
const editErr = ref('');
const editForm = reactive({
  id: '',
  name: '',
  isDefault: false,
  cfg: defaultConfig(),
  // 最低价启用态(因 minPriceStrategy 可为 null)
  minPriceEnabled: false,
  minPriceValue: 1,
});

function resetEditForm() {
  editForm.id = '';
  editForm.name = '';
  editForm.isDefault = false;
  editForm.cfg = defaultConfig();
  editForm.minPriceEnabled = false;
  editForm.minPriceValue = 1;
  editErr.value = '';
}

function openEdit(tpl) {
  if (tpl) {
    editForm.id = tpl.id;
    editForm.name = tpl.name;
    editForm.isDefault = !!tpl.isDefault;
    editForm.cfg = { ...defaultConfig(), ...(tpl.config || {}) };
    // 策略对象兜底
    editForm.cfg.salePriceStrategy = editForm.cfg.salePriceStrategy || { type: 'ratio', value: 1 };
    editForm.cfg.oldPriceStrategy = editForm.cfg.oldPriceStrategy || { type: 'ratio', value: 2 };
    editForm.minPriceEnabled = !!editForm.cfg.minPriceStrategy;
    editForm.minPriceValue = editForm.cfg.minPriceStrategy?.value ?? 1;
  } else {
    resetEditForm();
  }
  editErr.value = '';
  editOpen.value = true;
}

// 从表单构造 config 对象
function buildConfig() {
  const c = editForm.cfg;
  return {
    brand: c.brand || 'no_brand',
    imageOrder: c.imageOrder || 'keep',
    currency: c.currency || 'CNY',
    mergeEnabled: !!c.mergeEnabled,
    uploadMode: c.uploadMode || 'api',
    applyWatermark: !!c.applyWatermark,
    watermarkTemplateId: c.watermarkTemplateId || '',
    applyPoster: !!c.applyPoster,
    posterPrimaryOnly: !!c.posterPrimaryOnly,
    applyAiRewrite: !!c.applyAiRewrite,
    defaultStock: Number(c.defaultStock) || 0,
    salePriceStrategy: { type: 'ratio', value: Number(c.salePriceStrategy?.value) || 1 },
    minPriceStrategy: editForm.minPriceEnabled ? { type: 'ratio', value: Number(editForm.minPriceValue) || 1 } : null,
    oldPriceStrategy: { type: 'ratio', value: Number(c.oldPriceStrategy?.value) || 1 },
  };
}

async function submitEdit() {
  editErr.value = '';
  if (!editForm.name.trim()) {
    editErr.value = '模板名称必填';
    return;
  }
  editSaving.value = true;
  const body = { name: editForm.name.trim(), config: buildConfig(), isDefault: editForm.isDefault };
  try {
    if (editForm.id) {
      await updateListingTemplate(editForm.id, body);
      show('模板已更新', 'success');
    } else {
      await createListingTemplate(body);
      show('模板已新增', 'success');
    }
    editOpen.value = false;
    await load();
  } catch (err) {
    editErr.value = err.message || String(err);
  } finally {
    editSaving.value = false;
  }
}

// 设为默认
async function setDefault(tpl) {
  if (tpl.isDefault) return;
  try {
    await updateListingTemplate(tpl.id, { isDefault: true });
    show(`「${tpl.name}」已设为默认`, 'success');
    await load();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function remove(tpl) {
  if (!confirm(`确认删除模板「${tpl.name}」?此操作不可恢复。`)) return;
  try {
    await deleteListingTemplate(tpl.id);
    show('已删除', 'success');
    await load();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function load() {
  loading.value = true;
  try {
    const r = await getListingTemplates();
    // request.js 已对 envelope {ok,data} 解包,此处 r 即模板数组
    list.value = Array.isArray(r) ? r : [];
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>上架模板</h2>
      <button class="btn btn-primary" @click="openEdit(null)">+ 新增模板</button>
    </div>

    <p class="muted hint">
      模板用于预设跟卖面板的人工输入值(品牌、货币、库存、价格倍率等)。内置模板不可编辑/删除,可设其他模板为默认,跟卖面板打开时自动应用默认模板。
    </p>

    <div v-if="loading" class="empty">加载中...</div>
    <div v-else-if="!list.length" class="empty">暂无模板</div>
    <table v-else class="tpl-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>类型</th>
          <th>默认</th>
          <th>关键配置</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in list" :key="t.id">
          <td>{{ t.name }}</td>
          <td>
            <span v-if="t.isBuiltin" class="badge badge-success">内置</span>
            <span v-else class="badge badge-pending">自定义</span>
          </td>
          <td>
            <span v-if="t.isDefault" class="badge badge-success">默认</span>
            <span v-else class="muted">—</span>
          </td>
          <td class="cfg-cell">
            <span>品牌:{{ t.config?.brand || '—' }}</span>
            <span>货币:{{ t.config?.currency || '—' }}</span>
            <span>库存:{{ t.config?.defaultStock ?? '—' }}</span>
            <span>售价倍率:{{ t.config?.salePriceStrategy?.value ?? '—' }}</span>
            <span>划线价倍率:{{ t.config?.oldPriceStrategy?.value ?? '—' }}</span>
          </td>
          <td class="muted">{{ t.updatedAt }}</td>
          <td class="actions">
            <button v-if="!t.isDefault" class="btn btn-sm btn-ghost" @click="setDefault(t)">设为默认</button>
            <button
              class="btn btn-sm btn-ghost"
              :disabled="t.isBuiltin"
              :title="t.isBuiltin ? '内置模板不可编辑' : ''"
              @click="openEdit(t)"
            >
              编辑
            </button>
            <button
              class="btn btn-sm btn-danger"
              :disabled="t.isBuiltin"
              :title="t.isBuiltin ? '内置模板不可删除' : ''"
              @click="remove(t)"
            >
              删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 新增/编辑弹窗 -->
    <AppModal
      :open="editOpen"
      :title="editForm.id ? '编辑模板' : '新增模板'"
      size="lg"
      @update:open="editOpen = $event"
    >
      <form class="form" @submit.prevent="submitEdit">
        <label>
          <span>模板名称 <em>*</em></span>
          <input type="text" v-model.trim="editForm.name" placeholder="如:高利润模板" />
        </label>

        <fieldset class="form-group">
          <legend>基础</legend>
          <div class="grid2">
            <label>
              <span>品牌</span>
              <input type="text" v-model.trim="editForm.cfg.brand" placeholder="no_brand" />
            </label>
            <label>
              <span>货币</span>
              <input type="text" v-model.trim="editForm.cfg.currency" placeholder="CNY" />
            </label>
            <label>
              <span>图片排序</span>
              <input type="text" v-model.trim="editForm.cfg.imageOrder" placeholder="keep" />
            </label>
            <label>
              <span>上架方式</span>
              <select v-model="editForm.cfg.uploadMode">
                <option value="api">API 上架</option>
                <option value="portal">模拟手动上架</option>
              </select>
            </label>
            <label>
              <span>默认库存</span>
              <input type="number" v-model.number="editForm.cfg.defaultStock" placeholder="10" />
            </label>
          </div>
          <div class="checks">
            <label class="check"><input type="checkbox" v-model="editForm.cfg.mergeEnabled" /> 合并</label>
            <label class="check"><input type="checkbox" v-model="editForm.cfg.applyWatermark" /> 水印</label>
            <label class="check"><input type="checkbox" v-model="editForm.cfg.applyPoster" /> 海报</label>
            <label class="check"><input type="checkbox" v-model="editForm.cfg.posterPrimaryOnly" /> 仅主图海报</label>
            <label class="check"><input type="checkbox" v-model="editForm.cfg.applyAiRewrite" /> AI 改写</label>
          </div>
          <label>
            <span>水印模板ID</span>
            <input type="text" v-model.trim="editForm.cfg.watermarkTemplateId" placeholder="留空表示不指定" />
          </label>
        </fieldset>

        <fieldset class="form-group">
          <legend>价格策略(倍率)</legend>
          <div class="grid2">
            <label>
              <span>售价倍率</span>
              <input type="number" step="0.01" v-model.number="editForm.cfg.salePriceStrategy.value" />
            </label>
            <label>
              <span>划线价倍率</span>
              <input type="number" step="0.01" v-model.number="editForm.cfg.oldPriceStrategy.value" />
            </label>
          </div>
          <label class="check"><input type="checkbox" v-model="editForm.minPriceEnabled" /> 启用最低价</label>
          <label v-if="editForm.minPriceEnabled">
            <span>最低价倍率</span>
            <input type="number" step="0.01" v-model.number="editForm.minPriceValue" />
          </label>
        </fieldset>

        <label class="check">
          <input type="checkbox" v-model="editForm.isDefault" /> 设为默认模板(跟卖面板打开时自动应用)
        </label>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" :disabled="editSaving">
            {{ editSaving ? '保存中...' : '保存' }}
          </button>
        </div>
        <p class="error-text" v-show="editErr">{{ editErr }}</p>
      </form>
    </AppModal>
  </div>
</template>

<style scoped>
.hint {
  margin: 4px 0 12px;
  font-size: 12px;
  line-height: 1.6;
}
.tpl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tpl-table th,
.tpl-table td {
  padding: 10px 8px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
  vertical-align: top;
}
.tpl-table th {
  background: #f9fafb;
  color: #6b7280;
  font-weight: 600;
  font-size: 12px;
}
.cfg-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #4b5563;
  font-size: 12px;
}
.actions {
  white-space: nowrap;
}
.actions .btn {
  margin-right: 4px;
}
.form-group {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
}
.form-group legend {
  font-weight: 600;
  font-size: 13px;
  color: #374151;
  padding: 0 6px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 8px 0;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
}
</style>
