<script setup>
// 发运管理(2026-11-01):顶层两个 tab 改为「待处理 / 已完成」,
// 打印货运标签功能并入「待处理」页(与发运清单同页,便于打完标签直接确认/取消发运)。
// - 待处理:发运管理(配置 + 进行中清单,CarriageManage mode=pending)+ 打印货运标签(ContainerLabelPrint)
// - 已完成:发运历史(本地持久化,CarriageManage mode=done)
// 旧链接 /print-container-label?tab=print 兼容:打印功能在待处理内,统一落到 pending。
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import CarriageManage from './CarriageManage.vue';
import ContainerLabelPrint from './ContainerLabelPrint.vue';

const route = useRoute();
const tab = ref(route.query.tab === 'done' ? 'done' : 'pending');
</script>

<template>
  <div class="carriage-center">
    <div class="center-tabs">
      <button type="button" class="center-tab" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
        待处理
      </button>
      <button type="button" class="center-tab" :class="{ active: tab === 'done' }" @click="tab = 'done'">
        已完成
      </button>
    </div>
    <!-- 待处理:发运管理(配置 + 进行中清单)+ 打印货运标签 -->
    <CarriageManage v-show="tab === 'pending'" mode="pending" />
    <ContainerLabelPrint v-show="tab === 'pending'" class="print-panel" />
    <!-- 已完成:发运历史 -->
    <CarriageManage v-show="tab === 'done'" mode="done" />
  </div>
</template>

<style scoped>
.carriage-center {
  /* 子组件自带页面级 padding/max-width,这里仅承载 tab 栏 */
}
.center-tabs {
  display: flex;
  gap: 10px;
  padding: 16px 24px 0;
  max-width: 1180px;
  margin: 0 auto;
}
.center-tab {
  padding: 7px 18px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--muted);
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.center-tab:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.center-tab.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
/* 打印货运标签并入待处理页(2026-11-01) */
.print-panel {
  border-top: 1px solid var(--border);
}
</style>