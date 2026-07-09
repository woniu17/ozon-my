import { reactive } from 'vue';

// 单例:模块级 reactive,所有 useToast() 共享同一个 toast 状态
const toast = reactive({ msg: '', type: '', visible: false });
let timer = null;

export function useToast() {
  const show = (msg, type = '') => {
    toast.msg = msg;
    toast.type = type;
    toast.visible = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      toast.visible = false;
    }, 3000);
  };
  return { toast, show };
}
