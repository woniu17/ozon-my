<script setup>
// 类目过滤管理页面(2026-07 新增)
// 维护"过滤类目类型"黑名单,采集箱商品若属于此类目则显示"已过滤"标签,
// 上架预览中"一键提交"按钮置灰。
// 主键 = (descriptionCategoryId, typeId) 组合,两者一起唯一确定一个类目节点
import { ref, reactive, computed, onMounted } from 'vue';
import {
  getFilteredCategories,
  getAvailableCategories,
  addFilteredCategory,
  deleteFilteredCategory,
  getCategoryNamesBatch,
} from '../api/category-filter.js';
import { useToast } from '../components/useToast.js';

const { show } = useToast();

// 已过滤的类目列表
const filteredList = ref([]);
// 可用类目列表(从已采集商品中提取)
const availableList = ref([]);
// 加载状态
const loadingFiltered = ref(false);
const loadingAvailable = ref(false);
// 添加对话框
const addDialogVisible = ref(false);
// 添加表单(手动输入)
const addForm = reactive({
  descriptionCategoryId: '',
  typeId: '',
  categoryName: '',
  typeName: '',
});
// 提交中
const submitting = ref(false);

// ── 中文类目名映射(2026-07 新增) ───────────────────────────
// categoryNameMap: descriptionCategoryId -> categoryName(中文,来自 OPI 类目树 ZH_HANS)
// typeNameMap: typeId -> typeName(中文,来自 OPI 类目树叶子节点 type_id/type_name)
const categoryNameMap = ref({});
const typeNameMap = ref({});

// 取某条记录的中文类目名(优先 OPI 中文名,其次记录自带 categoryName,最后回退 ID)
function displayCategoryName(it) {
  if (!it?.descriptionCategoryId) return '—';
  const cn = categoryNameMap.value[it.descriptionCategoryId];
  if (cn) return cn;
  if (it.categoryName) return it.categoryName;
  return String(it.descriptionCategoryId);
}

// 取某条记录的中文类型名(优先 OPI 中文名,其次记录自带 typeName,最后回退 ID)
function displayTypeName(it) {
  if (!it?.typeId) return '—';
  const tn = typeNameMap.value[Number(it.typeId)];
  if (tn) return tn;
  if (it.typeName) return it.typeName;
  return String(it.typeId);
}

// 批量加载中文类目名 + 类型名(filtered + available 合并查询,减少 HTTP 请求)
async function loadCategoryNames() {
  const descCatIds = new Set();
  const typeIds = new Set();
  for (const it of filteredList.value) {
    if (it.descriptionCategoryId) descCatIds.add(Number(it.descriptionCategoryId));
    if (Number(it.typeId) > 0) typeIds.add(Number(it.typeId));
  }
  for (const it of availableList.value) {
    if (it.descriptionCategoryId) descCatIds.add(Number(it.descriptionCategoryId));
    if (Number(it.typeId) > 0) typeIds.add(Number(it.typeId));
  }
  if (descCatIds.size === 0 && typeIds.size === 0) return;
  try {
    const r = await getCategoryNamesBatch(
      descCatIds.size > 0 ? [...descCatIds] : [],
      typeIds.size > 0 ? [...typeIds] : []
    );
    const catList = r?.items || [];
    const typeList = r?.typeItems || [];
    const catMap = { ...categoryNameMap.value };
    for (const it of catList) {
      if (it.categoryName) catMap[it.descriptionCategoryId] = it.categoryName;
    }
    categoryNameMap.value = catMap;
    if (typeList.length > 0) {
      const tMap = { ...typeNameMap.value };
      for (const it of typeList) {
        if (it.typeName) tMap[it.typeId] = it.typeName;
      }
      typeNameMap.value = tMap;
    }
  } catch (err) {
    // 静默失败:类目显示回退到 ID
    console.warn('[CategoryFilter] loadCategoryNames failed:', err);
  }
}

// ── 数据加载 ───────────────────────────────────────────────
async function loadFiltered() {
  loadingFiltered.value = true;
  try {
    const data = await getFilteredCategories();
    filteredList.value = data?.items || [];
    loadCategoryNames();
  } catch (err) {
    show(err.message || String(err), 'error');
    filteredList.value = [];
  } finally {
    loadingFiltered.value = false;
  }
}

async function loadAvailable() {
  loadingAvailable.value = true;
  try {
    const data = await getAvailableCategories();
    availableList.value = data?.items || [];
    loadCategoryNames();
  } catch (err) {
    show(err.message || String(err), 'error');
    availableList.value = [];
  } finally {
    loadingAvailable.value = false;
  }
}

function refreshAll() {
  loadFiltered();
  loadAvailable();
}

// ── 添加过滤类目 ───────────────────────────────────────────
function openAddDialog() {
  addForm.descriptionCategoryId = '';
  addForm.typeId = '';
  addForm.categoryName = '';
  addForm.typeName = '';
  addDialogVisible.value = true;
}

// 从可用列表快速添加
async function quickAdd(item) {
  submitting.value = true;
  try {
    await addFilteredCategory({
      descriptionCategoryId: item.descriptionCategoryId,
      typeId: Number(item.typeId) || 0,
      categoryName: displayCategoryName(item) || item.categoryName || '',
      typeName: item.typeName || '',
    });
    show('已加入类型过滤名单', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    submitting.value = false;
  }
}

// 手动输入添加
// 注:typeId 可留空(数据缺失时占位为 0),按 descCatId 单维度过滤
async function submitAdd() {
  const dci = Number(addForm.descriptionCategoryId);
  if (!Number.isFinite(dci) || dci <= 0) {
    show('请输入有效的描述类目 ID(正整数)', 'error');
    return;
  }
  const tiRaw = Number(addForm.typeId);
  const ti = Number.isFinite(tiRaw) && tiRaw > 0 ? tiRaw : 0;
  submitting.value = true;
  try {
    await addFilteredCategory({
      descriptionCategoryId: dci,
      typeId: ti,
      categoryName: addForm.categoryName.trim(),
      typeName: addForm.typeName.trim(),
    });
    show('已加入类型过滤名单', 'success');
    addDialogVisible.value = false;
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    submitting.value = false;
  }
}

// ── 删除过滤类目 ───────────────────────────────────────────
async function removeItem(item) {
  if (!confirm(`确认移出类型过滤名单?\n类目: ${displayCategoryName(item)}\n类型: ${item.typeName || (Number(item.typeId) || 0)}`)) {
    return;
  }
  try {
    await deleteFilteredCategory(item.descriptionCategoryId, Number(item.typeId) || 0);
    show('已移出类型过滤名单', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 工具函数 ───────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 判断某类目是否已在过滤名单中(供可用列表显示状态)
// 注:typeId 用 0 占位,与 CollectBoxV2/Preview 的 filterKey 保持一致
const filteredSet = computed(() => {
  const s = new Set();
  for (const it of filteredList.value) {
    s.add(`${it.descriptionCategoryId}:${Number(it.typeId) || 0}`);
  }
  return s;
});

function isFiltered(item) {
  return filteredSet.value.has(`${item.descriptionCategoryId}:${Number(item.typeId) || 0}`);
}

// ── 生命周期 ───────────────────────────────────────────────
onMounted(() => {
  refreshAll();
});
</script>

<template>
  <div class="category-filter-page">
    <div class="page-header">
      <h2 class="page-title">类目过滤管理</h2>
      <p class="page-desc">
        维护"过滤类目类型"黑名单。采集箱中此类目下的商品会显示"已过滤"标签,
        上架预览中"一键提交"按钮会被禁用。主键 = (描述类目 ID + 商品类型 ID) 组合。
      </p>
    </div>

    <div class="actions-bar">
      <button class="btn btn-primary" @click="openAddDialog">+ 手动添加</button>
      <button class="btn btn-ghost" @click="refreshAll" :disabled="loadingFiltered || loadingAvailable">
        {{ loadingFiltered || loadingAvailable ? '加载中...' : '刷新' }}
      </button>
    </div>

    <div class="grid-wrap">
      <!-- 左侧:已过滤的类目列表 -->
      <div class="card">
        <div class="card-header">
          <h3>已过滤类目 ({{ filteredList.length }})</h3>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>描述类目 ID</th>
                <th>商品类型 ID</th>
                <th>类目名称</th>
                <th>类型名称</th>
                <th>添加时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!filteredList.length">
                <td colspan="6" class="empty">{{ loadingFiltered ? '加载中...' : '暂无过滤类目' }}</td>
              </tr>
              <tr v-for="it in filteredList" :key="`${it.descriptionCategoryId}-${it.typeId}`">
                <td class="mono">{{ it.descriptionCategoryId }}</td>
                <td class="mono">{{ it.typeId }}</td>
                <td>{{ displayCategoryName(it) }}</td>
                <td>{{ displayTypeName(it) }}</td>
                <td class="col-time">{{ fmtTime(it.createdAt) }}</td>
                <td>
                  <button class="btn btn-danger btn-sm" @click="removeItem(it)">移出</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 右侧:可用类目列表(从已采集商品中提取) -->
      <div class="card">
        <div class="card-header">
          <h3>已采集商品的类目 ({{ availableList.length }})</h3>
          <p class="card-sub">点击"类型过滤"快速添加到左侧黑名单</p>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>描述类目 ID</th>
                <th>商品类型 ID</th>
                <th>类目名称</th>
                <th>类型名称</th>
                <th>SKU 数</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!availableList.length">
                <td colspan="7" class="empty">{{ loadingAvailable ? '加载中...' : '暂无已采集类目数据' }}</td>
              </tr>
              <tr v-for="it in availableList" :key="`${it.descriptionCategoryId}-${it.typeId}`">
                <td class="mono">{{ it.descriptionCategoryId }}</td>
                <td class="mono">{{ it.typeId }}</td>
                <td>{{ displayCategoryName(it) }}</td>
                <td>{{ displayTypeName(it) }}</td>
                <td>{{ it.skuCount ?? 0 }}</td>
                <td>
                  <span :class="isFiltered(it) ? 'tag tag-err' : 'tag tag-mute'">
                    {{ isFiltered(it) ? '已过滤' : '未过滤' }}
                  </span>
                </td>
                <td>
                  <button
                    v-if="!isFiltered(it)"
                    class="btn btn-primary btn-sm"
                    :disabled="submitting"
                    @click="quickAdd(it)"
                  >
                    类型过滤
                  </button>
                  <span v-else class="muted-text">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 手动添加对话框 -->
    <div v-if="addDialogVisible" class="modal-mask" @click.self="addDialogVisible = false">
      <div class="modal">
        <div class="modal-header">
          <h3>手动添加过滤类目</h3>
          <button class="modal-close" @click="addDialogVisible = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>描述类目 ID <span class="required">*</span></label>
            <input
              v-model.trim="addForm.descriptionCategoryId"
              type="number"
              placeholder="如 90476217"
              class="form-input"
            />
          </div>
          <div class="form-row">
            <label>商品类型 ID <span class="optional">(可选,留空按描述类目 ID 单维度过滤)</span></label>
            <input
              v-model.trim="addForm.typeId"
              type="number"
              placeholder="如 90476218,无 type_id 时留空"
              class="form-input"
            />
          </div>
          <div class="form-row">
            <label>类目名称(可选)</label>
            <input
              v-model.trim="addForm.categoryName"
              type="text"
              placeholder="显示用,可留空"
              class="form-input"
            />
          </div>
          <div class="form-row">
            <label>类型名称(可选)</label>
            <input
              v-model.trim="addForm.typeName"
              type="text"
              placeholder="显示用,可留空"
              class="form-input"
            />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="addDialogVisible = false">取消</button>
          <button class="btn btn-primary" :disabled="submitting" @click="submitAdd">
            {{ submitting ? '提交中...' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.category-filter-page {
  padding: 16px;
  max-width: 1600px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 16px;
}

.page-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 6px 0;
  color: var(--text-primary, #111827);
}

.page-desc {
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  margin: 0;
  line-height: 1.5;
}

.actions-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.grid-wrap {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 1100px) {
  .grid-wrap {
    grid-template-columns: 1fr;
  }
}

.card {
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
}

.card-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #e5e7eb);
}

.card-header h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary, #111827);
}

.card-sub {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  margin: 4px 0 0 0;
}

.table-wrap {
  max-height: 600px;
  overflow: auto;
}

.data-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border, #f3f4f6);
  white-space: nowrap;
}

.data-table th {
  background: var(--bg-muted, #f9fafb);
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
  position: sticky;
  top: 0;
  z-index: 1;
}

.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.col-time {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.empty {
  text-align: center;
  padding: 32px 0;
  color: var(--text-secondary, #9ca3af);
}

.muted-text {
  color: var(--text-secondary, #9ca3af);
  font-size: 12px;
}

.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.tag-err {
  background: #fee2e2;
  color: #ef4444;
}

.tag-mute {
  background: #f3f4f6;
  color: #6b7280;
}

/* 按钮 */
.btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn-primary {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}

.btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.btn-ghost {
  background: transparent;
  color: var(--text-primary, #374151);
  border-color: var(--border, #d1d5db);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-muted, #f9fafb);
}

.btn-danger {
  background: #fee2e2;
  color: #ef4444;
  border-color: #fecaca;
}

.btn-danger:hover:not(:disabled) {
  background: #fecaca;
}

.btn-sm {
  padding: 3px 10px;
  font-size: 12px;
}

/* 对话框 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: #fff;
  border-radius: 8px;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
}

.modal-header {
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  color: #6b7280;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.modal-close:hover {
  color: #111827;
}

.modal-body {
  padding: 16px;
}

.form-row {
  margin-bottom: 12px;
}

.form-row label {
  display: block;
  font-size: 13px;
  color: #374151;
  margin-bottom: 4px;
}

.required {
  color: #ef4444;
}

.optional {
  color: #9ca3af;
  font-weight: normal;
  font-size: 12px;
}

.form-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  box-sizing: border-box;
}

.modal-footer {
  padding: 12px 16px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
