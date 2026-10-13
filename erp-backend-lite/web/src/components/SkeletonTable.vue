<template>
  <div class="skeleton-table" role="status" aria-label="数据加载中">
    <div class="skeleton-row" v-for="r in rows" :key="r" :style="{ gridTemplateColumns: colCss }">
      <span v-for="c in cols" :key="c" class="skeleton-cell" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  rows: { type: Number, default: 5 },
  cols: { type: Number, default: 6 },
});

// 骨架列宽(大致模拟真实表头宽度,让视觉更接近最终表格)
const WIDTHS = ['18%', '24%', '14%', '12%', '16%', '16%'];
const colCss = computed(() => {
  const list = [];
  for (let i = 0; i < props.cols; i += 1) {
    list.push(WIDTHS[i % WIDTHS.length]);
  }
  return list.join(' ');
});
</script>

<style scoped>
.skeleton-table {
  display: grid;
  gap: 10px;
  padding: 14px 12px;
  min-height: 120px;
}
.skeleton-row {
  display: grid;
  gap: 12px;
  align-items: center;
}
.skeleton-cell {
  height: 13px;
  border-radius: 4px;
  background: linear-gradient(90deg, #edf0f4 25%, #e2e8f0 37%, #edf0f4 63%);
  background-size: 400% 100%;
  animation: skeleton-shimmer 1.4s ease infinite;
}
.skeleton-cell:first-child {
  height: 16px;
}
@keyframes skeleton-shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-cell {
    animation: none;
  }
}
</style>