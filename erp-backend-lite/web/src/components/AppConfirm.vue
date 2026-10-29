<script setup>
// 全局确认弹窗(2026-07)
// 替代原生 confirm(),基于 confirm store + AppModal 同款可访问性能力
//   - role="alertdialog" + aria-modal(语义化确认对话框)
//   - Esc 关闭(等同取消)、Tab 焦点陷阱、关闭后焦点恢复
//   - mask 点击 = 取消
//   - danger=true 时确认按钮使用红色样式
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { useConfirmStore } from '../stores/confirm.js';

const confirmStore = useConfirmStore();

const cardRef = ref(null);
let lastFocused = null;
let openedAt = 0; // 弹窗打开时间戳,用于拦截刚打开时残留的回车连发(2026-10-29)

watch(
  () => confirmStore.open,
  async (isOpen) => {
    if (isOpen) {
      openedAt = Date.now();
      lastFocused = document.activeElement;
      await nextTick();
      const card = cardRef.value;
      if (card) {
        // 初始焦点落到卡片本身而非"取消"按钮:扫码枪/键盘回车连发时,
        // 若焦点在按钮上,残留 Enter 会直接激活取消按钮导致弹窗一闪而过(2026-10-29)
        card.focus();
      }
      document.addEventListener('keydown', onKeydown, true);
    } else {
      document.removeEventListener('keydown', onKeydown, true);
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
    }
  }
);

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    confirmStore.resolveCancel();
    return;
  }
  if (e.key === 'Enter') {
    // 回车 = 确认(键盘流习惯);但弹窗刚打开 300ms 内忽略,
    // 防止重量框的回车连发在弹窗出现瞬间误触发(2026-10-29)
    if (Date.now() - openedAt < 300) return;
    e.preventDefault();
    confirmStore.resolveConfirm();
    return;
  }
  if (e.key === 'Tab' && cardRef.value) {
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

function onConfirm() {
  confirmStore.resolveConfirm();
}

function onCancel() {
  confirmStore.resolveCancel();
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="confirmStore.open"
      class="modal"
      role="alertdialog"
      aria-modal="true"
      :aria-label="confirmStore.title || '确认对话框'"
    >
      <button class="modal-mask" aria-label="关闭对话框" @click="onCancel" tabindex="-1"></button>
      <div class="modal-card modal-confirm" ref="cardRef" tabindex="-1">
        <div class="modal-header">
          <h2>{{ confirmStore.title }}</h2>
        </div>
        <div class="modal-body">
          <p class="confirm-message">{{ confirmStore.message }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="onCancel">{{ confirmStore.cancelText }}</button>
          <button
            class="btn"
            :class="confirmStore.danger ? 'btn-danger' : 'btn-primary'"
            :disabled="confirmStore.busy"
            @click="onConfirm"
          >
            {{ confirmStore.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-confirm {
  width: 420px;
}
.confirm-message {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.6;
  max-height: 60vh;
  overflow-y: auto;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}
</style>
