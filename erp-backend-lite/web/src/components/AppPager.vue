<script setup>
import { computed } from 'vue';

const props = defineProps({
  total: { type: Number, default: 0 },
  pageSize: { type: Number, default: 20 },
  modelValue: { type: Number, default: 1 },
});

const emit = defineEmits(['update:modelValue']);

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

const prev = () => {
  if (props.modelValue > 1) emit('update:modelValue', props.modelValue - 1);
};

const next = () => {
  if (props.modelValue < totalPages.value) emit('update:modelValue', props.modelValue + 1);
};

const onJump = (e) => {
  const n = parseInt(e.target.value, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= totalPages.value) {
    emit('update:modelValue', n);
  }
};
</script>

<template>
  <div class="pager">
    <span class="pager-info">共 {{ total }} 条 / 第 {{ modelValue }}/{{ totalPages }} 页</span>
    <button :disabled="modelValue <= 1" aria-label="上一页" @click="prev">上一页</button>
    <button :disabled="modelValue >= totalPages" aria-label="下一页" @click="next">下一页</button>
    <label class="pager-jump-label">
      <span class="sr-only">跳转到页码</span>
      <input
        class="pager-jump"
        type="number"
        min="1"
        :max="totalPages"
        :value="modelValue"
        @change="onJump"
        aria-label="跳转到页码"
      />
    </label>
  </div>
</template>

<style scoped>
.pager-jump {
  width: 56px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* 2026-07:用 focus-visible 替代 outline:none,键盘聚焦时显示 ring */
.pager-jump:focus {
  outline: none;
}
.pager-jump:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
/* 屏幕阅读器专用文本(视觉隐藏) */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.pager-jump-label {
  margin: 0;
}
</style>
