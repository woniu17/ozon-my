<script setup>
import { useToast } from './useToast.js';

const { toast } = useToast();
</script>

<template>
  <div
    class="toast"
    :class="toast.type"
    v-show="toast.visible"
    :role="toast.type === 'error' ? 'alert' : 'status'"
    aria-live="polite"
  >{{ toast.msg }}</div>
</template>
