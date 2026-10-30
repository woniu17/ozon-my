<script setup>
// 发运管理(2026-10-30):合并「发运管理」与「打印货运标签」为单页
// - 发运管理:创建发运、发运清单、货件/联系方式/确认/取消(原 CarriageManage)
// - 打印货运标签:双通道打印、预览、OGL 入仓单号(原 ContainerLabelPrint)
// 旧链接 /print-container-label 重定向到 /carriage-manage?tab=print,直达打印页。
// v-show 保持两个子组件状态(切换 tab 不重新加载列表/打印机组)。
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import CarriageManage from './CarriageManage.vue';
import ContainerLabelPrint from './ContainerLabelPrint.vue';

const route = useRoute();
const tab = ref(route.query.tab === 'print' ? 'print' : 'manage');
</script>

<template>
  <div class="carriage-center">
    <div class="center-tabs">
      <button type="button" class="center-tab" :class="{ active: tab === 'manage' }" @click="tab = 'manage'">
        发运管理
      </button>
      <button type="button" class="center-tab" :class="{ active: tab === 'print' }" @click="tab = 'print'">
        打印货运标签
      </button>
    </div>
    <CarriageManage v-show="tab === 'manage'" />
    <ContainerLabelPrint v-show="tab === 'print'" />
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
</style>