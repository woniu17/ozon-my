<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { getFeatureFlags, updateFeatureFlag, getConfig, updateConfig } from '../api/config.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';

const { show } = useToast();

// 配置项元信息(参考原 admin.js CONFIG_META):声明每个 key 的展示方式(类型/分组/标签/单位/帮助文案)
// 未在此表中的 key 不渲染,便于扩展新配置而不破坏 UI
const CONFIG_META = {
  // extension scope
  price_max: { scope: 'extension', group: '价格配置', label: '售价上限', type: 'number', unit: '卢布' },
  old_price_ratio: {
    scope: 'extension',
    group: '价格配置',
    label: '默认划线价比例',
    type: 'number',
    step: '0.01',
    help: '划线价 = 售价 × 此比例',
  },
  discount_threshold: {
    scope: 'extension',
    group: '价格配置',
    label: '折扣阈值',
    type: 'number',
    step: '0.01',
    help: '售价 / 划线价 不得低于此值,否则 Ozon 审核失败',
  },
  stock_max: { scope: 'extension', group: '库存配置', label: '库存上限', type: 'number' },
  default_stock: { scope: 'extension', group: '库存配置', label: '默认库存', type: 'number' },
  enable_video_transfer: { scope: 'extension', group: '功能开关', label: '视频转存', type: 'boolean' },
  enable_ai_rewrite: { scope: 'extension', group: '功能开关', label: 'AI 标题改写', type: 'boolean' },
  enable_watermark: { scope: 'extension', group: '功能开关', label: '水印渲染', type: 'boolean' },
  // pricing scope
  rate_rub: { scope: 'pricing', group: '定价配置', label: '人民币兑卢布汇率', type: 'number', step: '0.001' },
  commission_rates: { scope: 'pricing', group: '定价配置', label: '类目佣金率 (JSON)', type: 'json' },
  logistics_cost: { scope: 'pricing', group: '定价配置', label: '物流费表 (JSON)', type: 'json' },
  profit_logistics: { scope: 'pricing', group: '定价配置', label: '利润物流系数 (JSON)', type: 'json' },
};

const state = reactive({
  flags: [],
  flagsLoading: false,
  config: {},
  configLoading: false,
  savingFlag: '',
  savingConfig: false,
});

// 本地编辑态:按 key 存放可编辑值(boolean/字符串/json 文本),与 config.items 同步
const form = reactive({});
// dirty 标记:reactive Set,变更过的 key 进集合,保存时只提交这些
const dirty = reactive(new Set());

const showRaw = ref(false);

// 按 group 分组的配置项(仅渲染在 CONFIG_META 中声明的 key)
const configGroups = computed(() => {
  const items = state.config.items || [];
  const groups = [];
  const index = {};
  for (const it of items) {
    const meta = CONFIG_META[it.key];
    if (!meta) continue;
    if (!index[meta.group]) {
      index[meta.group] = { name: meta.group, fields: [] };
      groups.push(index[meta.group]);
    }
    index[meta.group].fields.push({ ...it, meta });
  }
  return groups;
});

async function loadFlags() {
  state.flagsLoading = true;
  try {
    // 后端原样返回扁平对象 { key: boolean },转为数组便于渲染
    const data = await getFeatureFlags();
    const obj = data && typeof data === 'object' ? data : {};
    state.flags = Object.entries(obj).map(([key, value]) => ({ key, value: !!value }));
  } catch (err) {
    show(err.message || String(err), 'error');
    state.flags = [];
  } finally {
    state.flagsLoading = false;
  }
}

async function loadConfig() {
  state.configLoading = true;
  try {
    // 后端 envelope 解包后返回 { data, items },items 为配置数组
    const data = await getConfig();
    const items = (data && data.items) || [];
    state.config = { items };
    dirty.clear();
    // 初始化本地编辑态
    for (const it of items) {
      const meta = CONFIG_META[it.key];
      if (!meta) continue;
      if (meta.type === 'json') {
        form[it.key] = JSON.stringify(it.value, null, 2);
      } else if (meta.type === 'boolean') {
        form[it.key] = !!it.value;
      } else {
        form[it.key] = it.value ?? '';
      }
    }
  } catch (err) {
    show(err.message || String(err), 'error');
    state.config = {};
  } finally {
    state.configLoading = false;
  }
}

async function toggleFlag(flag) {
  // v-model 已把 flag.value 翻转为新值
  const newValue = flag.value;
  state.savingFlag = flag.key;
  try {
    await updateFeatureFlag(flag.key, newValue);
    show('已更新', 'success');
  } catch (err) {
    // 失败回滚本地状态
    flag.value = !newValue;
    const msg = err.message || String(err);
    // 后端尚未实现写接口,404 时统一提示
    show(/404/.test(msg) ? '该功能暂不支持' : msg, 'error');
  } finally {
    state.savingFlag = '';
  }
}

function onCfgChange(key) {
  dirty.add(key);
}

function refreshAll() {
  loadFlags();
  loadConfig();
}

async function saveConfig() {
  const dirtyKeys = Array.from(dirty);
  if (dirtyKeys.length === 0) {
    show('没有修改需要保存', '');
    return;
  }
  const items = [];
  for (const key of dirtyKeys) {
    const meta = CONFIG_META[key];
    const original = (state.config.items || []).find((x) => x.key === key);
    let value;
    if (meta.type === 'boolean') {
      value = !!form[key];
    } else if (meta.type === 'json') {
      try {
        value = JSON.parse(form[key]);
      } catch (e) {
        show(`${key} 不是合法 JSON: ${e.message}`, 'error');
        return;
      }
    } else if (meta.type === 'number') {
      value = Number(form[key]);
      if (Number.isNaN(value)) {
        show(`${key} 必须是数字`, 'error');
        return;
      }
    } else {
      value = form[key];
    }
    items.push({ key, value, scope: original?.scope || meta.scope });
  }
  state.savingConfig = true;
  try {
    await updateConfig({ items });
    show(`已保存 ${items.length} 项配置`, 'success');
    await loadConfig();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    state.savingConfig = false;
  }
}

onMounted(() => {
  loadFlags();
  loadConfig();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>配置中心</h2>
      <button class="btn btn-ghost" :disabled="state.flagsLoading || state.configLoading" @click="refreshAll">
        {{ state.flagsLoading || state.configLoading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <!-- Feature Flags 区域 -->
    <div class="config-form">
      <div class="cfg-group">
        <h3>Feature Flags(灰度开关)</h3>
        <div class="cfg-fields">
          <div v-if="state.flagsLoading" class="muted" style="padding: 24px; text-align: center; grid-column: 1 / -1">
            加载中...
          </div>
          <div v-else-if="!state.flags.length" class="empty" style="grid-column: 1 / -1">暂无 feature flags</div>
          <div v-for="flag in state.flags" :key="flag.key" class="cfg-field">
            <span class="cfg-label">
              <code class="cfg-key">{{ flag.key }}</code>
            </span>
            <label class="cfg-switch">
              <input
                type="checkbox"
                v-model="flag.value"
                :disabled="state.savingFlag === flag.key"
                @change="toggleFlag(flag)"
              />
              <span>{{ flag.value ? '已启用' : '已禁用' }}</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- ERP 配置项区域 -->
    <div class="config-form">
      <div v-if="state.configLoading" class="muted" style="padding: 24px; text-align: center">加载中...</div>
      <div v-else-if="!configGroups.length" class="empty">暂无配置项</div>
      <template v-else>
        <div v-for="grp in configGroups" :key="grp.name" class="cfg-group">
          <h3>{{ grp.name }}</h3>
          <div class="cfg-fields">
            <div v-for="c in grp.fields" :key="c.key" class="cfg-field">
              <label class="cfg-label">
                {{ c.meta.label }} <code class="cfg-key">{{ c.key }}</code>
              </label>
              <!-- boolean -->
              <label v-if="c.meta.type === 'boolean'" class="cfg-switch">
                <input
                  type="checkbox"
                  v-model="form[c.key]"
                  :class="{ 'cfg-dirty': dirty.has(c.key) }"
                  @change="onCfgChange(c.key)"
                />
                <span>{{ form[c.key] ? '已启用' : '已禁用' }}</span>
              </label>
              <!-- json -->
              <textarea
                v-else-if="c.meta.type === 'json'"
                class="cfg-textarea"
                :class="{ 'cfg-dirty': dirty.has(c.key) }"
                rows="3"
                v-model="form[c.key]"
                @input="onCfgChange(c.key)"
              ></textarea>
              <!-- number / string -->
              <div v-else class="cfg-input-wrap">
                <input
                  :type="c.meta.type"
                  v-model="form[c.key]"
                  :step="c.meta.step"
                  :class="{ 'cfg-dirty': dirty.has(c.key) }"
                  @input="onCfgChange(c.key)"
                />
                <span v-if="c.meta.unit" class="cfg-unit">{{ c.meta.unit }}</span>
              </div>
              <div v-if="c.meta.help || c.description" class="cfg-help-row">
                {{ c.meta.help || c.description }}
              </div>
            </div>
          </div>
        </div>
        <div class="form-actions" style="padding: 8px 0 0">
          <button class="btn btn-primary" :disabled="state.savingConfig || !dirty.size" @click="saveConfig">
            {{ state.savingConfig ? '保存中...' : '保存配置' }}
          </button>
          <button class="btn btn-ghost" @click="showRaw = true">查看原始 JSON</button>
          <span v-if="dirty.size" class="muted small">{{ dirty.size }} 项已修改</span>
        </div>
      </template>
    </div>

    <!-- 原始 JSON 预览 -->
    <AppModal title="原始配置 JSON" size="lg" :open="showRaw" @update:open="showRaw = $event">
      <pre class="json-pre">{{ JSON.stringify(state.config, null, 2) }}</pre>
    </AppModal>
  </div>
</template>
