<script>
// 模块级弹窗打开栈:嵌套弹窗场景下,Esc 只关闭栈顶(最后打开)的弹窗。
// 注意必须放普通 <script> 块(script setup 每个实例都会执行,数组会退化为实例级)
const openStack = [];
let modalSeq = 0;
</script>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';

const props = defineProps({
  title: { type: String, default: '' },
  size: { type: String, default: 'md' },
  open: { type: Boolean, default: false },
});

const emit = defineEmits(['update:open']);

const cardRef = ref(null);
// 打开前记录触发元素,关闭后恢复焦点
let lastFocused = null;

const myId = ++modalSeq;

const close = () => emit('update:open', false);

// focus trap + Esc 关闭 + 焦点恢复(2026-07 可访问性修复)
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      openStack.push(myId);
      lastFocused = document.activeElement;
      await nextTick();
      // 聚焦到卡片内首个可聚焦元素(优先关闭按钮)
      const card = cardRef.value;
      if (card) {
        const focusable = card.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        (focusable || card).focus();
      }
      document.addEventListener('keydown', onKeydown, true);
    } else {
      const idx = openStack.indexOf(myId);
      if (idx >= 0) openStack.splice(idx, 1);
      document.removeEventListener('keydown', onKeydown, true);
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
    }
  }
);

function onKeydown(e) {
  if (e.key === 'Escape') {
    // 非栈顶弹窗不响应(嵌套场景:仅关闭最上层的弹窗)
    if (openStack[openStack.length - 1] !== myId) return;
    e.preventDefault();
    close();
    return;
  }
  if (e.key === 'Tab' && cardRef.value) {
    // 循环焦点在卡片内
    const focusable = cardRef.value.querySelectorAll(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div class="modal" :hidden="!open" role="dialog" aria-modal="true" :aria-label="title || '对话框'">
    <button class="modal-mask" aria-label="关闭对话框" @click="close" tabindex="-1"></button>
    <div
      class="modal-card"
      :class="{ 'modal-lg': size === 'lg' }"
      ref="cardRef"
      tabindex="-1"
    >
      <div class="modal-header">
        <h2>{{ title }}</h2>
        <button class="modal-close" aria-label="关闭" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <slot></slot>
      </div>
    </div>
  </div>
</template>
