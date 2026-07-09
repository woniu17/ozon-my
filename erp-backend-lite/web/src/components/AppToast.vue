<script setup>
import { useToast } from './useToast.js';

const { toast } = useToast();
</script>

<template>
  <div class="toast" :class="toast.type" v-show="toast.visible">{{ toast.msg }}</div>
</template>
