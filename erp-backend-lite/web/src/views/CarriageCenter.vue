<script setup>
// 发运管理(2026-11-02):顶层两个 tab 改为「待处理 / 全部」,
// 打印货运标签功能完全并入发运清单行内操作(打印机选择栏在清单上方)。
// - 待处理:发运管理(CarriageManage mode=pending,含快递员联系方式配置 + 进行中发运清单(含待创建占位行) + 行内打印/预览)
// - 全部:全部发运(CarriageManage mode=all,进行中(不含待创建占位行) + 已完成历史)
// 旧链接 /print-container-label?tab=print 兼容:打印功能在待处理内,统一落到 pending。
// 2026-10-30:页面标题(发运管理/发运历史 + 副标题 + 刷新)上移到 tab 栏最上方,刷新按钮通过 defineExpose 驱动当前子组件。
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import CarriageManage from './CarriageManage.vue';

const route = useRoute();
// 旧 'done' 链接兼容:统一落到「全部」
const tab = ref(route.query.tab === 'all' || route.query.tab === 'done' ? 'all' : 'pending');

const pendingRef = ref(null); // CarriageManage(mode=pending) 组件实例
const allRef = ref(null);     // CarriageManage(mode=all) 组件实例
const activeComp = computed(() => (tab.value === 'pending' ? pendingRef.value : allRef.value));
const activeLoading = computed(() => activeComp.value?.listLoading ?? false);
function refreshActive() {
  activeComp.value?.refreshCurrent();
}
</script>

<template>
  <div class="carriage-center">
    <!-- 页面标题:置于最上方,tab 栏之下为内容 -->
    <div class="page-head">
      <h2>{{ tab === 'pending' ? '发运管理' : '发运管理 · 全部' }}</h2>
      <span class="page-sub">
        {{ tab === 'pending' ? 'FBS 入库后创建发运 · 查看货件 · 设快递员联系方式 · 确认/取消发运' : '全部发运(进行中 + 已完成)· 查看货件 · 打印货运标签' }}
      </span>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="activeLoading" @click="refreshActive">
        {{ activeLoading ? '加载中…' : '刷新' }}
      </button>
    </div>
    <div class="center-tabs">
      <button type="button" class="center-tab" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
        待处理
      </button>
      <button type="button" class="center-tab" :class="{ active: tab === 'all' }" @click="tab = 'all'">
        全部
      </button>
    </div>
    <!-- 待处理:发运管理(配置 + 进行中清单 + 行内打印货运标签) -->
    <CarriageManage v-show="tab === 'pending'" mode="pending" ref="pendingRef" />
    <!-- 全部:进行中(不含待创建) + 已完成历史 -->
    <CarriageManage v-show="tab === 'all'" mode="all" ref="allRef" />
  </div>
</template>

<style scoped>
.carriage-center {
  /* 子组件自带页面级 padding/max-width,这里仅承载标题栏 + tab 栏 */
}
.page-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  max-width: 1180px;
  margin: 0 auto;
  padding: 16px 24px 0;
}
.page-head h2 {
  margin: 0;
  font-size: 20px;
}
.page-sub {
  flex: 1;
  min-width: 240px;
  font-size: 12.5px;
  color: var(--muted);
}
.center-tabs {
  display: flex;
  gap: 10px;
  padding: 8px 24px 0;
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