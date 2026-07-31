// 全局确认弹窗 store(2026-07)
// 替代原生 confirm(),提供统一的样式化确认弹窗
// 用法:
//   import { useConfirmStore } from '@/stores/confirm';
//   const confirmStore = useConfirmStore();
//   const ok = await confirmStore.ask({ title: '确认删除', message: '此操作不可恢复', danger: true });
//   if (!ok) return;
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useConfirmStore = defineStore('confirm', () => {
  // 弹窗状态
  const open = ref(false);
  const title = ref('');
  const message = ref('');
  const confirmText = ref('确认');
  const cancelText = ref('取消');
  const danger = ref(false);
  // busy 状态:确认按钮点击后的处理中(用于异步操作时禁用按钮)
  const busy = ref(false);

  // 当前 ask 调用的 resolve 函数(挂起,等待用户操作)
  let pendingResolver = null;

  // 显示确认弹窗,返回 Promise<boolean>
  //   true  → 用户点击确认
  //   false → 用户点击取消 / 关闭弹窗
  // options: { title?, message, confirmText?, cancelText?, danger? }
  function ask(options = {}) {
    // 如果已有弹窗打开,先关闭并返回 false(防止叠加)
    if (pendingResolver) {
      pendingResolver(false);
      pendingResolver = null;
    }
    title.value = options.title || '请确认';
    message.value = options.message || '';
    confirmText.value = options.confirmText || '确认';
    cancelText.value = options.cancelText || '取消';
    danger.value = !!options.danger;
    busy.value = false;
    open.value = true;
    return new Promise((resolve) => {
      pendingResolver = resolve;
    });
  }

  // 用户点击确认
  function resolveConfirm() {
    if (!pendingResolver) return;
    busy.value = false;
    open.value = false;
    pendingResolver(true);
    pendingResolver = null;
  }

  // 用户点击取消 / 关闭弹窗
  function resolveCancel() {
    if (!pendingResolver) return;
    busy.value = false;
    open.value = false;
    pendingResolver(false);
    pendingResolver = null;
  }

  return {
    open,
    title,
    message,
    confirmText,
    cancelText,
    danger,
    busy,
    ask,
    resolveConfirm,
    resolveCancel,
  };
});
