<script setup>
import { computed } from 'vue';
import JsonTree from './JsonTree.vue';

const props = defineProps({
  label: { type: String, default: '' },
  field: { type: Object, default: () => ({}) },
});

const value = computed(() => props.field?.value);
const source = computed(() => props.field?.source || '');
const sourceDetail = computed(() => props.field?.sourceDetail || '');

const isNull = computed(() => value.value == null);
const isBool = computed(() => typeof value.value === 'boolean');
const isArray = computed(() => Array.isArray(value.value));
const isObject = computed(() => !isNull.value && !isArray.value && typeof value.value === 'object');
const isPlain = computed(() => !isNull.value && !isBool.value && !isArray.value && !isObject.value);

const boolText = computed(() => (isBool.value ? (value.value ? '是' : '否') : ''));
const plainText = computed(() => (isPlain.value ? String(value.value) : ''));

const sourceClass = computed(() => {
  const map = {
    'seller-portal': 'sf-source-tag--blue',
    'page-json': 'sf-source-tag--purple',
    dom: 'sf-source-tag--green',
    form: 'sf-source-tag--orange',
    legacy: 'sf-source-tag--gray',
  };
  return map[source.value] || 'sf-source-tag--gray';
});
</script>

<template>
  <div class="sf">
    <span class="sf-label">{{ label }}</span>
    <span class="sf-value-wrap">
      <span v-if="isNull" class="sf-value sf-null">-</span>
      <span v-else-if="isBool" class="sf-value">{{ boolText }}</span>
      <JsonTree v-else-if="isArray" :data="value" />
      <JsonTree v-else-if="isObject" :data="value" />
      <span v-else class="sf-value">{{ plainText }}</span>
    </span>
    <span class="sf-source">
      <span class="sf-source-tag" :class="sourceClass">{{ source || '-' }}</span>
      <span v-if="sourceDetail" class="sf-detail" :title="sourceDetail">{{ sourceDetail }}</span>
    </span>
  </div>
</template>

<style scoped>
/* .sf 容器 (global.css 无此类) */
.sf {
  display: grid;
  grid-template-columns: 140px 1fr auto;
  gap: 8px;
  align-items: start;
  padding: 6px 0;
  border-bottom: 1px solid #f3f4f6;
}
/* .sf-source 在 global.css 中是单色角标,这里改作容器 (scoped 优先级更高) */
.sf-source {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  color: inherit;
  padding: 0;
  border-radius: 0;
  height: auto;
  white-space: normal;
  font-size: inherit;
}
/* .sf-source-tag 彩色角标 (global.css 无此类) */
.sf-source-tag {
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  height: fit-content;
}
.sf-source-tag--blue {
  background: #2563eb;
}
.sf-source-tag--purple {
  background: #8b5cf6;
}
.sf-source-tag--green {
  background: #16a34a;
}
.sf-source-tag--orange {
  background: #ea580c;
}
.sf-source-tag--gray {
  background: #6b7280;
}
</style>
