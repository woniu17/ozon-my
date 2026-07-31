<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import {
  getWatermarkTemplates,
  createWatermarkTemplate,
  updateWatermarkTemplate,
  deleteWatermarkTemplate,
} from '../api/watermarkTemplates.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import { useConfirmStore } from '../stores/confirm.js';

const { show } = useToast();
const confirmStore = useConfirmStore();

const list = ref([]);
const loading = ref(false);

// 水印类型选项
const TYPE_OPTIONS = [
  { value: 'text', label: '文字水印' },
  { value: 'border', label: '边框水印' },
  { value: 'image', label: '图片水印' },
];

// 位置选项
const POSITION_OPTIONS = [
  { value: 'top-left', label: '左上' },
  { value: 'top-right', label: '右上' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-right', label: '右下' },
  { value: 'center', label: '居中' },
];

// 默认 config(三种类型各自的默认值)
function defaultConfig(type = 'text') {
  if (type === 'text') {
    return {
      type: 'text',
      text: { content: '', fontSize: 32, color: '#FFFFFF', opacity: 0.6, position: 'bottom-right' },
    };
  }
  if (type === 'border') {
    return {
      type: 'border',
      border: { width: 10, color: '#000000', opacity: 0.5 },
    };
  }
  return {
    type: 'image',
    image: { url: '', scale: 0.2, opacity: 0.5, position: 'bottom-right' },
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

// 当前编辑类型(便于模板分支渲染)
const editType = computed(() => editForm.cfg?.type || 'text');

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
    // 深拷贝 config,避免直接修改列表数据
    editForm.cfg = tpl.config
      ? JSON.parse(JSON.stringify(tpl.config))
      : defaultConfig();
  } else {
    resetEditForm();
  }
  editErr.value = '';
  editOpen.value = true;
}

// 切换水印类型时重置对应默认 config(保留已填的公共字段)
function onTypeChange(newType) {
  const old = editForm.cfg;
  const next = defaultConfig(newType);
  // 保留 position(text/image 都有)
  if ((old.type === 'text' || old.type === 'image') && (newType === 'text' || newType === 'image')) {
    const oldPos = old.text?.position || old.image?.position;
    if (oldPos && next.text) next.text.position = oldPos;
    if (oldPos && next.image) next.image.position = oldPos;
  }
  editForm.cfg = next;
}

// 构造提交的 config 对象(类型转换 + 字段裁剪)
function buildConfig() {
  const c = editForm.cfg;
  const type = c.type;
  if (type === 'text') {
    const t = c.text || {};
    return {
      type: 'text',
      text: {
        content: String(t.content || '').trim(),
        fontSize: Number(t.fontSize) || 32,
        color: t.color || '#FFFFFF',
        opacity: clamp(Number(t.opacity), 0, 1, 0.6),
        position: t.position || 'bottom-right',
      },
    };
  }
  if (type === 'border') {
    const b = c.border || {};
    return {
      type: 'border',
      border: {
        width: Math.max(1, Number(b.width) || 10),
        color: b.color || '#000000',
        opacity: clamp(Number(b.opacity), 0, 1, 0.5),
      },
    };
  }
  // image
  const i = c.image || {};
  return {
    type: 'image',
    image: {
      url: String(i.url || '').trim(),
      scale: clamp(Number(i.scale), 0.01, 1, 0.2),
      opacity: clamp(Number(i.opacity), 0, 1, 0.5),
      position: i.position || 'bottom-right',
    },
  };
}

function clamp(v, min, max, def) {
  if (isNaN(v)) return def;
  return Math.min(max, Math.max(min, v));
}

// 表单校验
function validate() {
  if (!editForm.name.trim()) return '模板名称必填';
  const c = editForm.cfg;
  if (c.type === 'text' && !String(c.text?.content || '').trim()) {
    return '文字水印 content 必填';
  }
  if (c.type === 'image' && !String(c.image?.url || '').trim()) {
    return '图片水印 url 必填';
  }
  return '';
}

async function submitEdit() {
  editErr.value = validate();
  if (editErr.value) return;
  editSaving.value = true;
  const body = {
    name: editForm.name.trim(),
    config: buildConfig(),
    isDefault: editForm.isDefault,
  };
  try {
    if (editForm.id) {
      await updateWatermarkTemplate(editForm.id, body);
      show('模板已更新', 'success');
    } else {
      await createWatermarkTemplate(body);
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
    await updateWatermarkTemplate(tpl.id, { isDefault: true });
    show(`「${tpl.name}」已设为默认`, 'success');
    await load();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function remove(tpl) {
  if (!(await confirmStore.ask({ message: `确认删除水印模板「${tpl.name}」?此操作不可恢复。`, danger: true }))) return;
  try {
    await deleteWatermarkTemplate(tpl.id);
    show('已删除', 'success');
    await load();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// 复制模板的 ID 到剪贴板(便于在上架模板中填入 watermarkTemplateId)
async function copyId(tpl) {
  try {
    await navigator.clipboard.writeText(String(tpl.id));
    show(`已复制 ID: ${tpl.id}`, 'success');
  } catch {
    show('复制失败,请手动选中复制', 'error');
  }
}

// 列表展示用的 config 摘要
function configSummary(cfg) {
  if (!cfg || !cfg.type) return '—';
  if (cfg.type === 'text') {
    const t = cfg.text || {};
    return `文字:"${t.content || ''}" ${t.fontSize || 32}px ${t.color || '#FFF'}`;
  }
  if (cfg.type === 'border') {
    const b = cfg.border || {};
    return `边框:${b.width || 10}px ${b.color || '#000'}`;
  }
  if (cfg.type === 'image') {
    const i = cfg.image || {};
    return `图片:缩放${Math.round((i.scale || 0.2) * 100)}%`;
  }
  return '—';
}

async function load() {
  loading.value = true;
  try {
    const r = await getWatermarkTemplates();
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
      <h2>水印模板</h2>
      <button class="btn btn-primary" @click="openEdit(null)">+ 新增模板</button>
    </div>

    <p class="muted hint">
      水印模板用于图床加工链:上架时自动下载原图 → 按 config 渲染水印 → 落盘到图床目录 → 用公网 URL 替换。
      在「上架模板」中勾选「水印」并填入此处显示的模板 ID 即可启用。
    </p>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!list.length" class="empty">暂无模板,点击「新增模板」创建</div>
    <table v-else class="tpl-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>名称</th>
          <th>类型</th>
          <th>配置摘要</th>
          <th>默认</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in list" :key="t.id">
          <td>
            <code class="tpl-id" @click="copyId(t)" title="点击复制 ID">{{ t.id }}</code>
          </td>
          <td>{{ t.name }}</td>
          <td>
            <span class="badge" :class="`badge-type-${t.config?.type || 'unknown'}`">
              {{ ({ text: '文字', border: '边框', image: '图片' })[t.config?.type] || '未知' }}
            </span>
          </td>
          <td class="cfg-cell">{{ configSummary(t.config) }}</td>
          <td>
            <span v-if="t.isDefault" class="badge badge-success">默认</span>
            <span v-else class="muted">—</span>
          </td>
          <td class="muted">{{ t.updatedAt }}</td>
          <td class="actions">
            <button class="btn btn-sm btn-ghost" @click="copyId(t)" title="复制 ID">复制 ID</button>
            <button v-if="!t.isDefault" class="btn btn-sm btn-ghost" @click="setDefault(t)">设为默认</button>
            <button class="btn btn-sm btn-ghost" @click="openEdit(t)">编辑</button>
            <button class="btn btn-sm btn-danger" @click="remove(t)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 新增/编辑弹窗 -->
    <AppModal
      :open="editOpen"
      :title="editForm.id ? '编辑水印模板' : '新增水印模板'"
      size="lg"
      @update:open="editOpen = $event"
    >
      <form class="form" @submit.prevent="submitEdit">
        <label>
          <span>模板名称 <em>*</em></span>
          <input type="text" v-model.trim="editForm.name" placeholder="如:右下角店铺名" />
        </label>

        <fieldset class="form-group">
          <legend>水印类型</legend>
          <div class="type-radio">
            <label v-for="opt in TYPE_OPTIONS" :key="opt.value" class="radio-item">
              <input
                type="radio"
                :value="opt.value"
                :checked="editType === opt.value"
                @change="onTypeChange(opt.value)"
              />
              {{ opt.label }}
            </label>
          </div>
        </fieldset>

        <!-- 文字水印配置 -->
        <fieldset v-if="editType === 'text'" class="form-group">
          <legend>文字水印配置</legend>
          <label>
            <span>文字内容 <em>*</em></span>
            <input type="text" v-model.trim="editForm.cfg.text.content" placeholder="如:本店原创" />
          </label>
          <div class="grid2">
            <label>
              <span>字号</span>
              <input type="number" min="8" max="200" step="1" v-model.number="editForm.cfg.text.fontSize" />
            </label>
            <label>
              <span>字体颜色</span>
              <input type="color" v-model="editForm.cfg.text.color" />
              <input type="text" class="color-text" v-model.trim="editForm.cfg.text.color" placeholder="#FFFFFF" />
            </label>
            <label>
              <span>透明度 (0-1)</span>
              <input type="number" min="0" max="1" step="0.05" v-model.number="editForm.cfg.text.opacity" />
            </label>
            <label>
              <span>位置</span>
              <select v-model="editForm.cfg.text.position">
                <option v-for="p in POSITION_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
          </div>
        </fieldset>

        <!-- 边框水印配置 -->
        <fieldset v-if="editType === 'border'" class="form-group">
          <legend>边框水印配置</legend>
          <div class="grid2">
            <label>
              <span>边框宽度 (px)</span>
              <input type="number" min="1" max="100" step="1" v-model.number="editForm.cfg.border.width" />
            </label>
            <label>
              <span>边框颜色</span>
              <input type="color" v-model="editForm.cfg.border.color" />
              <input type="text" class="color-text" v-model.trim="editForm.cfg.border.color" placeholder="#000000" />
            </label>
            <label>
              <span>透明度 (0-1)</span>
              <input type="number" min="0" max="1" step="0.05" v-model.number="editForm.cfg.border.opacity" />
            </label>
          </div>
        </fieldset>

        <!-- 图片水印配置 -->
        <fieldset v-if="editType === 'image'" class="form-group">
          <legend>图片水印配置</legend>
          <label>
            <span>水印图 URL <em>*</em></span>
            <input type="text" v-model.trim="editForm.cfg.image.url" placeholder="https://example.com/logo.png" />
          </label>
          <div class="grid2">
            <label>
              <span>缩放比例 (相对原图宽度,0.01-1)</span>
              <input type="number" min="0.01" max="1" step="0.05" v-model.number="editForm.cfg.image.scale" />
            </label>
            <label>
              <span>透明度 (0-1)</span>
              <input type="number" min="0" max="1" step="0.05" v-model.number="editForm.cfg.image.opacity" />
            </label>
            <label>
              <span>位置</span>
              <select v-model="editForm.cfg.image.position">
                <option v-for="p in POSITION_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
          </div>
        </fieldset>

        <label class="check">
          <input type="checkbox" v-model="editForm.isDefault" /> 设为默认模板
        </label>

        <!-- config JSON 预览(便于核对) -->
        <details class="json-preview">
          <summary>查看 config JSON</summary>
          <pre>{{ JSON.stringify(buildConfig(), null, 2) }}</pre>
        </details>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" :disabled="editSaving">
            {{ editSaving ? '保存中…' : '保存' }}
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
.tpl-id {
  cursor: pointer;
  color: #2563eb;
  background: #eff6ff;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}
.tpl-id:hover {
  background: #dbeafe;
}
.cfg-cell {
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
.type-radio {
  display: flex;
  gap: 20px;
}
.radio-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 8px;
}
.grid2 label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.color-text {
  margin-top: 4px;
  font-size: 12px;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  margin: 8px 0;
}
.json-preview {
  margin: 10px 0;
  font-size: 12px;
}
.json-preview summary {
  cursor: pointer;
  color: #6b7280;
}
.json-preview pre {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px;
  margin: 6px 0 0;
  font-size: 11px;
  color: #374151;
  overflow-x: auto;
}
.badge-type-text {
  background: #dbeafe;
  color: #1e40af;
}
.badge-type-border {
  background: #fef3c7;
  color: #92400e;
}
.badge-type-image {
  background: #d1fae5;
  color: #065f46;
}
.badge-type-unknown {
  background: #f3f4f6;
  color: #6b7280;
}
</style>
