<script setup>
// 图片放大预览组件(Lightbox)
// 用法:
//   <ImageLightbox v-model:open="state.open" :url="state.url" :list="state.list" :title="state.title" />
// 或命令式(通过 ref):
//   const lb = ref();
//   lb.value.open(url, list, title);
//   lb.value.close();
//
// 键盘:Esc 关闭,← → 翻页(仅 list 长度 > 1 时)
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  url: { type: String, default: '' },
  list: { type: Array, default: () => [] },
  title: { type: String, default: '' },
});

const emit = defineEmits(['update:open']);

const index = ref(0);
const curUrl = ref('');
const curTitle = ref('');

const multi = computed(() => (props.list?.length || 0) > 1);

// 同步外部 props 到内部状态(支持 v-model:open + 命令式两种用法)
watch(
  () => props.open,
  (v) => {
    if (v) {
      const list = props.list || [];
      const idx = props.url ? list.indexOf(props.url) : -1;
      index.value = idx >= 0 ? idx : 0;
      curUrl.value = props.url || list[0] || '';
      curTitle.value = props.title || '';
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }
);

watch(
  () => props.url,
  (v) => {
    if (props.open && v) {
      const list = props.list || [];
      const idx = list.indexOf(v);
      if (idx >= 0) index.value = idx;
      curUrl.value = v;
    }
  }
);

function close() {
  emit('update:open', false);
  document.body.style.overflow = '';
}

function prev() {
  if (!multi.value) return;
  const n = props.list.length;
  index.value = (index.value - 1 + n) % n;
  curUrl.value = props.list[index.value];
}

function next() {
  if (!multi.value) return;
  const n = props.list.length;
  index.value = (index.value + 1) % n;
  curUrl.value = props.list[index.value];
}

function onKey(e) {
  if (!props.open) return;
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (props.open) document.body.style.overflow = '';
});
</script>

<template>
  <div v-if="open" class="img-lb" @click.self="close">
    <button class="img-lb-close" type="button" title="关闭 (Esc)" @click="close">×</button>
    <button
      v-if="multi"
      class="img-lb-nav img-lb-prev"
      type="button"
      title="上一张 (←)"
      @click.stop="prev"
    >‹</button>
    <div class="img-lb-img-wrap" @click.self="close">
      <img v-if="curUrl" :src="curUrl" class="img-lb-img" alt="" />
      <div v-if="curTitle" class="img-lb-title">{{ curTitle }}</div>
      <div v-if="multi" class="img-lb-counter">
        {{ index + 1 }} / {{ list.length }}
      </div>
    </div>
    <button
      v-if="multi"
      class="img-lb-nav img-lb-next"
      type="button"
      title="下一张 (→)"
      @click.stop="next"
    >›</button>
  </div>
</template>

<style scoped>
.img-lb {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.88);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}
.img-lb-img-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  max-height: 100%;
  cursor: zoom-out;
}
.img-lb-img {
  max-width: 90vw;
  max-height: 80vh;
  object-fit: contain;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  cursor: zoom-out;
}
.img-lb-title {
  color: #fff;
  font-size: 13px;
  margin-top: 12px;
  text-align: center;
  opacity: 0.9;
}
.img-lb-counter {
  color: #fff;
  font-size: 12px;
  margin-top: 6px;
  opacity: 0.7;
}
.img-lb-close {
  position: absolute;
  top: 16px;
  right: 20px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  z-index: 10000;
}
.img-lb-close:hover {
  background: rgba(255, 255, 255, 0.3);
}
.img-lb-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 64px;
  border: none;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 32px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  z-index: 10000;
}
.img-lb-nav:hover {
  background: rgba(255, 255, 255, 0.25);
}
.img-lb-prev {
  left: 20px;
}
.img-lb-next {
  right: 20px;
}
</style>
