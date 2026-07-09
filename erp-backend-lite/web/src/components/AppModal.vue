<script setup>
defineProps({
  title: { type: String, default: '' },
  size: { type: String, default: 'md' },
  open: { type: Boolean, default: false },
});

const emit = defineEmits(['update:open']);

const close = () => emit('update:open', false);
</script>

<template>
  <div class="modal" :hidden="!open">
    <div class="modal-mask" @click="close"></div>
    <div class="modal-card" :class="{ 'modal-lg': size === 'lg' }">
      <div class="modal-header">
        <h2>{{ title }}</h2>
        <button class="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <slot></slot>
      </div>
    </div>
  </div>
</template>
