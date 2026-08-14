<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { RouterLink, RouterView } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import AppTopbar from './components/AppTopbar.vue';
import AppToast from './components/AppToast.vue';
import AppConfirm from './components/AppConfirm.vue';

const auth = useAuthStore();
const route = useRoute();

// 导航 Tab 列表
const tabs = [
  { key: '/admin', label: '首页统计' },
  { key: '/stores', label: '店铺管理' },
  { key: '/listings', label: '上架记录' },
  { key: '/collect-box-v2', label: '采集箱' },
  { key: '/products', label: '商品列表' },
  { key: '/batch', label: '批量上架' },
  { key: '/image-refresh-tasks', label: '图片更新任务' },
  { key: '/stock-refresh-tasks', label: '库存更新任务' },
  { key: '/product-update-tasks', label: '商品信息更新' },
  { key: '/product-archive-tasks', label: '商品归档任务' },
  { key: '/audit', label: '操作日志' },
  { key: '/config', label: '配置中心' },
  { key: '/listing-templates', label: '上架模板' },
  { key: '/watermark-templates', label: '水印模板' },
  { key: '/sku-data', label: 'SKU 数据' },
  { key: '/store-data', label: '店铺数据' },
  { key: '/store-sku', label: '店铺 SKU' },
  { key: '/collect-logs', label: '深度采集日志' },
  { key: '/shallow-collect-logs', label: '浅度采集日志' },
  { key: '/collect-queue', label: '采集队列' },
  { key: '/category-filter', label: '类目过滤' },
];

// 当前激活的 Tab(用 route.path 匹配)
const activeTab = computed(() => {
  const p = route.path;
  // 精确匹配优先,否则前缀匹配
  const exact = tabs.find((t) => t.key === p);
  if (exact) return exact.key;
  // 特殊:图片更新详情页 /image-refresh/:id 高亮"图片更新任务" tab
  if (p.startsWith('/image-refresh/')) return '/image-refresh-tasks';
  // 特殊:库存更新详情页 /stock-refresh/:id 高亮"库存更新任务" tab
  if (p.startsWith('/stock-refresh/')) return '/stock-refresh-tasks';
  // 特殊:商品信息更新详情页 /product-update/:id 高亮"商品信息更新" tab
  if (p.startsWith('/product-update/')) return '/product-update-tasks';
  // 特殊:商品归档详情页 /product-archive/:id 高亮"商品归档任务" tab
  if (p.startsWith('/product-archive/')) return '/product-archive-tasks';
  return tabs.find((t) => p.startsWith(t.key))?.key || '/admin';
});
</script>

<template>
  <AppTopbar />
  <AppToast />
  <AppConfirm />
  <a href="#main-content" class="skip-link">跳到主内容</a>
  <nav v-if="auth.isLoggedIn" class="tabs" aria-label="主导航">
    <RouterLink
      v-for="t in tabs"
      :key="t.key"
      class="tab"
      :class="{ active: activeTab === t.key }"
      :to="t.key"
    >
      {{ t.label }}
    </RouterLink>
  </nav>
  <main id="main-content">
    <RouterView />
  </main>
</template>
