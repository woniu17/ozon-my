<script setup>
import { useToast } from './useToast.js';

const { toast } = useToast();
</script>

<template>
  <Transition name="toast">
    <div
      v-if="toast.visible"
      class="toast"
      :class="toast.type"
      :role="toast.type === 'error' ? 'alert' : 'status'"
      aria-live="polite"
    >{{ toast.msg }}</div>
  </Transition>
</template>