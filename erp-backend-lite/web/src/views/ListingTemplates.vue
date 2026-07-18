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
// 价格公式:
//   售价   = 原SKU售价 * salePriceA% + salePriceB   (salePriceA: 50~500, salePriceB: -10~10)
//   划线价 = 售价 * oldPriceA%                       (oldPriceA: 110~200)
//   最低价 = 售价 - minPriceB                        (minPriceB: 0~5)
// 品牌强制 no_brand 不可改;货币取店铺合同货币(currency_code),模板不再存
function defaultConfig() {
  return {
    brand: 'no_brand',
    imageOrder: 'keep',
    mergeEnabled: false,
    uploadMode: 'api',
    applyWatermark: false,
    watermarkTemplateId: '',
    applyPoster: false,
    posterPrimaryOnly: false,
    applyAiRewrite: false,
    defaultStock: 10,
    salePriceA: 130,
    salePriceB: 0,
    oldPriceA: 150,
    minPriceB: 2,
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
});

function resetEditForm() {
  editForm.id = '';
  editForm.name = '';
  editForm.isDefault = false;
  editForm.cfg = defaultConfig();
  editErr.value = '';
}

function openEdit(tpl) {
  if (tpl) {
    editForm.id = tpl.id;
    editForm.name = tpl.name;
    editForm.isDefault = !!tpl.isDefault;
    editForm.cfg = { ...defaultConfig(), ...(tpl.config || {}) };
  } else {
    resetEditForm();
  }
  editErr.value = '';
  editOpen.value = true;
}

// 从表单构造 config 对象
function buildConfig() {
  const c = editForm.cfg;
  const clamp = (v, min, max, def) => {
    const n = Number(v);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  return {
    brand: 'no_brand',
    imageOrder: c.imageOrder === 'shuffle_non_primary' ? 'shuffle_non_primary' : 'keep',
    mergeEnabled: !!c.mergeEnabled,
    uploadMode: c.uploadMode || 'api',
    applyWatermark: !!c.applyWatermark,
    watermarkTemplateId: c.watermarkTemplateId || '',
    applyPoster: !!c.applyPoster,
    posterPrimaryOnly: !!c.posterPrimaryOnly,
    applyAiRewrite: !!c.applyAiRewrite,
    defaultStock: Number(c.defaultStock) || 0,
    salePriceA: clamp(c.salePriceA, 50, 500, 130),
    salePriceB: clamp(c.salePriceB, -10, 10, 0),
    oldPriceA: clamp(c.oldPriceA, 110, 200, 150),
    minPriceB: clamp(c.minPriceB, 0, 5, 2),
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
            <span>品牌:{{ t.config?.brand === 'no_brand' ? '无品牌' : (t.config?.brand || '—') }}</span>
            <span>库存:{{ t.config?.defaultStock ?? '—' }}</span>
            <span>图片:{{ t.config?.imageOrder === 'shuffle_non_primary' ? '主图不变打乱' : '不更改' }}</span>
            <span>售价:{{ t.config?.salePriceA ?? '—' }}% + {{ t.config?.salePriceB ?? 0 }}</span>
            <span>划线价:{{ t.config?.oldPriceA ?? '—' }}%</span>
            <span>最低价:售价 − {{ t.config?.minPriceB ?? '—' }}</span>
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
              <input type="text" :value="editForm.cfg.brand" disabled title="强制无品牌,不可更改" />
              <em class="hint-inline">强制无品牌,不可更改</em>
            </label>
            <label>
              <span>图片排序</span>
              <select v-model="editForm.cfg.imageOrder">
                <option value="keep">不更改</option>
                <option value="shuffle_non_primary">主图不变,其它随机打乱</option>
              </select>
            </label>
            <label>
              <span>上架方式</span>
              <select v-model="editForm.cfg.uploadMode">
                <option value="api">API 上架</option>
                <option value="portal">模拟手动上架</option>
              </select>
            </label>
            <label>
              <span>库存</span>
              <input type="number" v-model.number="editForm.cfg.defaultStock" placeholder="10" />
            </label>
          </div>
          <p class="hint-inline">货币取店铺合同货币(currency_code),无需在模板配置</p>
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
          <legend>价格公式</legend>
          <p class="hint-inline">
            售价 = 原价 × A% + B ｜ 划线价 = 售价 × A% ｜ 最低价 = 售价 − B(强制启用)
          </p>
          <div class="grid2">
            <label>
              <span>售价 A % <em>(50~500)</em></span>
              <input type="number" min="50" max="500" step="1" v-model.number="editForm.cfg.salePriceA" />
            </label>
            <label>
              <span>售价 B <em>(-10~10)</em></span>
              <input type="number" min="-10" max="10" step="0.01" v-model.number="editForm.cfg.salePriceB" />
            </label>
            <label>
              <span>划线价 A % <em>(110~200)</em></span>
              <input type="number" min="110" max="200" step="1" v-model.number="editForm.cfg.oldPriceA" />
            </label>
            <label>
              <span>最低价 B <em>(0~5)</em></span>
              <input type="number" min="0" max="5" step="0.01" v-model.number="editForm.cfg.minPriceB" />
            </label>
          </div>
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
.hint-inline {
  display: block;
  font-size: 11px;
  color: #6b7280;
  font-style: normal;
  margin: 4px 0;
}
</style>
