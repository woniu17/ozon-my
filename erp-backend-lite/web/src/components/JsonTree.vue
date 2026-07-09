<script setup>
import { ref, computed, provide, inject } from 'vue';

// 可折叠的 JSON 树组件 —— 递归渲染任意 JSON，支持折叠/展开整个节点与内部任意层级
// 根节点提供「全部展开 / 全部折叠」工具栏，通过 provide/inject 传递全局模式
defineOptions({ name: 'JsonTree' });

const props = defineProps({
  data: { type: null, default: undefined }, // 任意 JSON 值
  label: { type: String, default: '' }, // 当前节点的 key 或数组索引
  level: { type: Number, default: 0 }, // 当前层级(根=0)
  defaultExpandLevel: { type: Number, default: 1 }, // 默认展开到第几层
  rootKey: { type: String, default: '' }, // 根节点的自定义标题(仅根节点用)
  isArrayItem: { type: Boolean, default: false }, // 当前节点是否为数组元素(决定 label 是否加引号)
});

// ── 全局展开模式:根节点 provide,子节点 inject ──
// 'normal' = 各节点用自身 localExpanded; 'expanded' = 全部展开; 'collapsed' = 全部折叠
const isRoot = computed(() => props.level === 0);
const globalMode = isRoot.value ? ref('normal') : inject('jsonTreeGlobalMode', ref('normal'));
if (isRoot.value) {
  provide('jsonTreeGlobalMode', globalMode);
}

const valueType = computed(() => {
  if (props.data === null) return 'null';
  if (Array.isArray(props.data)) return 'array';
  return typeof props.data;
});

const isContainer = computed(() => valueType.value === 'array' || valueType.value === 'object');

const entries = computed(() => {
  if (valueType.value === 'array') {
    return props.data.map((v, i) => ({ key: String(i), val: v }));
  }
  if (valueType.value === 'object') {
    return Object.keys(props.data).map((k) => ({ key: k, val: props.data[k] }));
  }
  return [];
});

const childCount = computed(() => entries.value.length);

// 各节点自身展开状态(默认:层级 < defaultExpandLevel 或空容器)
const localExpanded = ref(props.level < props.defaultExpandLevel || childCount.value === 0);

// 实际展开状态:全局模式优先，否则用 localExpanded
const expanded = computed(() => {
  if (globalMode.value === 'expanded') return true;
  if (globalMode.value === 'collapsed') return false;
  return localExpanded.value;
});

const toggle = (e) => {
  e.stopPropagation();
  // 手动切换时回到 normal 模式，恢复各节点独立控制
  if (globalMode.value !== 'normal') globalMode.value = 'normal';
  localExpanded.value = !localExpanded.value;
};

// 工具栏:全部展开 / 全部折叠 (仅根节点)
const expandAll = () => {
  globalMode.value = 'expanded';
};
const collapseAll = () => {
  globalMode.value = 'collapsed';
};

// 叶子节点的显示文本
const leafText = computed(() => {
  if (valueType.value === 'string') return JSON.stringify(props.data); // 带引号
  if (valueType.value === 'null') return 'null';
  return String(props.data);
});

// 折叠时的摘要(Redoc 风格:显示前几项预览 + 子节点计数)
const collapsedSummary = computed(() => {
  if (valueType.value === 'array') {
    const n = childCount.value;
    if (n === 0) return '';
    // 基本类型数组:显示前 2 个值缩略(长字符串截断),避免折叠后看不出内容
    const firstTwo = props.data
      .slice(0, 2)
      .map((v) => {
        if (v === null) return 'null';
        if (typeof v === 'string') {
          const s = v.length > 40 ? v.slice(0, 40) + '…' : v;
          return `"${s}"`;
        }
        if (typeof v === 'object') return Array.isArray(v) ? '[…]' : '{…}';
        return String(v);
      })
      .join(', ');
    const more = n > 2 ? `, +${n - 2}` : '';
    return `${firstTwo}${more}`;
  }
  return `${childCount.value} keys`;
});
</script>

<template>
  <div class="jt-node">
    <!-- 根节点工具栏 -->
    <div v-if="isRoot && isContainer" class="jt-toolbar">
      <button class="jt-btn" @click="expandAll">全部展开</button>
      <button class="jt-btn" @click="collapseAll">全部折叠</button>
    </div>
    <!-- 容器节点(object/array) -->
    <div v-if="isContainer" class="jt-row jt-container" :class="{ 'jt-collapsed-row': !expanded }">
      <!-- 折叠按钮:展开时显示 -，折叠时显示 + (Redoc 风格) -->
      <button class="jt-collapser" @click="toggle" :aria-label="expanded ? 'collapse' : 'expand'">
        {{ expanded ? '−' : '+' }}
      </button>
      <!-- label 显示规则:rootKey 作为标题不加引号;对象 key 加引号;数组索引不加引号 -->
      <span v-if="rootKey && isRoot" class="jt-key jt-title" @click="toggle">
        {{ rootKey }}<span class="jt-colon">: </span>
      </span>
      <span v-else-if="label && !isArrayItem" class="jt-key" @click="toggle">
        "{{ label }}"<span class="jt-colon">: </span>
      </span>
      <span v-else-if="label && isArrayItem" class="jt-key jt-index" @click="toggle">
        {{ label }}<span class="jt-colon">: </span>
      </span>
      <span class="jt-bracket">{{ valueType === 'array' ? '[' : '{' }}</span>
      <span v-if="!expanded" class="jt-collapsed" @click="toggle">
        <span class="jt-summary">{{ collapsedSummary }}</span>
        <span class="jt-ellipsis"> … </span>
        <span class="jt-bracket">{{ valueType === 'array' ? ']' : '}' }}</span>
      </span>
    </div>
    <!-- 容器子节点(展开时) -->
    <div v-if="isContainer && expanded" class="jt-children">
      <JsonTree
        v-for="item in entries"
        :key="item.key"
        :data="item.val"
        :label="item.key"
        :level="level + 1"
        :default-expand-level="defaultExpandLevel"
        :is-array-item="valueType === 'array'"
      />
      <div class="jt-row jt-close-bracket">
        <span class="jt-bracket">{{ valueType === 'array' ? ']' : '}' }}</span>
      </div>
    </div>
    <!-- 叶子节点(string/number/boolean/null) -->
    <div v-if="!isContainer" class="jt-row jt-leaf">
      <span class="jt-collapser jt-collapser-placeholder"></span>
      <span v-if="rootKey && isRoot" class="jt-key jt-title"> {{ rootKey }}<span class="jt-colon">: </span> </span>
      <span v-else-if="label && !isArrayItem" class="jt-key">"{{ label }}"<span class="jt-colon">: </span></span>
      <span v-else-if="label && isArrayItem" class="jt-key jt-index">{{ label }}<span class="jt-colon">: </span></span>
      <span class="jt-value" :class="'jt-val-' + valueType">{{ leafText }}</span>
    </div>
  </div>
</template>

<style scoped>
.jt-node {
  font-family: 'JetBrains Mono', ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 14px;
  line-height: 1.7;
  color: #333;
}
.jt-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.jt-btn {
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid #e4e8ee;
  border-radius: 4px;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
}
.jt-btn:hover {
  background: #f3f4f6;
  color: #333;
}
.jt-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  position: relative;
}
/* 折叠按钮:Redoc 风格的 +/- 方块 */
.jt-collapser {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 4px;
  flex-shrink: 0;
  padding: 0;
  background: transparent;
  border: 0;
  color: #333;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  line-height: 1;
}
.jt-collapser:hover {
  color: #005bff;
}
.jt-collapser-placeholder {
  cursor: default;
  visibility: hidden;
}
.jt-collapser:focus {
  outline: #000 dotted 1px;
  outline-offset: 1px;
}
.jt-children {
  /* Redoc 风格:仅用 margin 缩进，无左侧虚线 */
  margin-left: 20px;
}
.jt-container {
  cursor: default;
}
.jt-key {
  color: #000;
  cursor: pointer;
  user-select: none;
}
/* 根节点标题(rootKey):作为可读标题，加粗显示 */
.jt-title {
  font-weight: 600;
}
/* 数组索引:不加引号，用钢蓝色区分 */
.jt-index {
  color: #4a8bb3;
}
.jt-colon {
  color: #333;
  opacity: 0.7;
}
.jt-bracket {
  color: #333;
  opacity: 0.7;
}
.jt-collapsed {
  cursor: pointer;
}
.jt-summary {
  color: #6b7280;
  font-style: italic;
  margin: 0 4px;
  font-size: 12px;
}
.jt-ellipsis {
  color: #333;
}
.jt-close-bracket {
  padding-left: 0;
}
.jt-value {
  word-break: break-all;
}
/* Redoc / PrismJS token 配色 */
.jt-val-string {
  color: #9acd32; /* YellowGreen */
}
.jt-val-number {
  color: #4a8bb3; /* 钢蓝 */
}
.jt-val-boolean {
  color: #e64441; /* 红 */
}
.jt-val-null {
  color: #6b7280;
}
/* 叶子行 hover 高亮 (Redoc .hoverable 风格) */
.jt-leaf,
.jt-container {
  padding: 1px 2px;
  border-radius: 2px;
  transition: background-color 0.1s;
}
.jt-leaf:hover,
.jt-container:hover {
  background-color: rgba(0, 91, 255, 0.06);
}
</style>
