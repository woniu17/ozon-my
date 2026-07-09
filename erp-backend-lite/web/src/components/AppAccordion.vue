<script setup>
import { ref } from 'vue';

const props = defineProps({
  title: { type: String, default: '' },
  badge: { type: String, default: '' },
  defaultOpen: { type: Boolean, default: false },
});

const emit = defineEmits(['update:open']);

const open = ref(props.defaultOpen);

const toggle = () => {
  open.value = !open.value;
  emit('update:open', open.value);
};
</script>

<template>
  <div class="accordion">
    <div class="accordion-head" @click="toggle">
      <span class="accordion-arrow">{{ open ? '▼' : '▶' }}</span>
      <span class="accordion-title">{{ title }}</span>
      <span v-if="badge" class="accordion-badge">{{ badge }}</span>
    </div>
    <div v-show="open" class="accordion-body">
      <slot></slot>
    </div>
  </div>
</template>
