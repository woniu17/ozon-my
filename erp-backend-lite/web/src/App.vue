<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import AppTopbar from './components/AppTopbar.vue';
import AppToast from './components/AppToast.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// 导航 Tab 列表
const tabs = [
  { key: '/admin', label: '首页统计' },
  { key: '/stores', label: '店铺管理' },
  { key: '/listings', label: '上架记录' },
  { key: '/collect-box-v2', label: '采集箱' },
  { key: '/products', label: '商品列表' },
  { key: '/batch', label: '批量上架' },
  { key: '/audit', label: '操作日志' },
  { key: '/config', label: '配置中心' },
  { key: '/listing-templates', label: '上架模板' },
  { key: '/cache', label: '缓存管理' },
  { key: '/collect-logs', label: '采集日志' },
  { key: '/collect-queue', label: '采集队列' },
];

// 当前激活的 Tab(用 route.path 匹配)
const activeTab = computed(() => {
  const p = route.path;
  // 精确匹配优先,否则前缀匹配
  const exact = tabs.find((t) => t.key === p);
  if (exact) return exact.key;
  return tabs.find((t) => p.startsWith(t.key))?.key || '/admin';
});

const onTabClick = (key) => {
  router.push(key);
};
</script>

<template>
  <AppTopbar />
  <AppToast />
  <nav v-if="auth.isLoggedIn" class="tabs">
    <button
      v-for="t in tabs"
      :key="t.key"
      class="tab"
      :class="{ active: activeTab === t.key }"
      @click="onTabClick(t.key)"
    >
      {{ t.label }}
    </button>
  </nav>
  <RouterView />
</template>
