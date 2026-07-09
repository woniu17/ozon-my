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
    <button :disabled="modelValue <= 1" @click="prev">上一页</button>
    <button :disabled="modelValue >= totalPages" @click="next">下一页</button>
    <input
      class="pager-jump"
      type="number"
      min="1"
      :max="totalPages"
      :value="modelValue"
      @change="onJump"
    />
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
}
.pager-jump:focus {
  outline: none;
  border-color: var(--primary);
}
</style>
