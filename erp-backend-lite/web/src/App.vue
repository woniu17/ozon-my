<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { RouterLink, RouterView } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import AppTopbar from './components/AppTopbar.vue';
import AppToast from './components/AppToast.vue';
import AppConfirm from './components/AppConfirm.vue';

const auth = useAuthStore();
const route = useRoute();

// 导航分组配置(方案一:左侧分组侧边栏)
const navGroups = [
  {
    id: 'workbench',
    label: '工作台',
    items: [
      { key: '/admin', label: '首页统计' },
      { key: '/order-process', label: '订单处理' },
      { key: '/order-stats', label: '订单统计' },
      { key: '/finance-stats', label: '财务统计' },
      { key: '/scan-ship', label: '扫描发货' },
      { key: '/scan-stock', label: '扫描备货' },
      { key: '/carriage-manage', label: '货运创建/发运管理' },
      { key: '/print-container-label', label: '打印货运标签' },
    ],
  },
  {
    id: 'catalog',
    label: '商品与上架',
    items: [
      { key: '/products', label: '商品列表' },
      { key: '/collect-box-v2', label: '采集箱' },
      { key: '/batch', label: '批量上架' },
      { key: '/materials', label: '素材管理' },
      { key: '/listings', label: '上架记录' },
      { key: '/listing-templates', label: '上架模板' },
      { key: '/watermark-templates', label: '水印模板' },
      { key: '/category-filter', label: '类目过滤' },
    ],
  },
  {
    id: 'price-order',
    label: '价格与订单',
    items: [
      { key: '/price-manage', label: '价格管理' },
      { key: '/price-watch', label: '价格优势' },
      { key: '/miaoshou-orders', label: '妙手订单' },
    ],
  },
  {
    id: 'tasks',
    label: '任务中心',
    items: [
      { key: '/image-refresh-tasks', label: '图片更新任务' },
      { key: '/stock-refresh-tasks', label: '库存更新任务' },
      { key: '/product-update-tasks', label: '商品信息更新' },
      { key: '/product-archive-tasks', label: '商品归档任务' },
      { key: '/export-tasks', label: '导出任务' },
    ],
  },
  {
    id: 'data-logs',
    label: '数据与日志',
    items: [
      { key: '/sku-data', label: 'SKU 数据' },
      { key: '/store-data', label: '店铺数据' },
      { key: '/store-sku', label: '店铺 SKU' },
      { key: '/collect-logs', label: '深度采集日志' },
      { key: '/shallow-collect-logs', label: '浅度采集日志' },
      { key: '/collect-queue', label: '采集队列' },
      { key: '/endpoint-metrics', label: '端点耗时' },
      { key: '/task-logs', label: '定时任务日志' },
      { key: '/print-logs', label: '打印日志' },
    ],
  },
  {
    id: 'settings',
    label: '系统设置',
    items: [
      { key: '/stores', label: '店铺管理' },
      { key: '/audit', label: '操作日志' },
      { key: '/config', label: '配置中心' },
    ],
  },
];

// 拍平全部导航项,供当前页匹配使用
const tabs = navGroups.flatMap((g) => g.items);

// 每个导航分组的 SVG 图标路径(描边风格,与整体设计语言一致)
const groupIcons = {
  workbench: ['M1.5 8L8 2.5 14.5 8V14a.5.5 0 0 1-.5.5H9.5V10h-3v4.5H2a.5.5 0 0 1-.5-.5V8z'],
  catalog: ['M1.5 5L8 1.5 14.5 5V11L8 14.5 1.5 11V5z', 'M1.5 5L8 8l6.5-3', 'M8 8v6.5'],
  'price-order': ['M8.5 1.5L14.5 7.5 7.5 14.5 1.5 8.5 8.5 1.5z', 'M10.2 5.3a1 1 0 1 1-2 0 1 1 0 0 1 2 0z'],
  tasks: ['M2.5 2.5h11v11h-11z', 'M5 8.5l2 2 4-4.5'],
  'data-logs': ['M1.5 3.5C1.5 2.4 4.4 1.5 8 1.5s6.5.9 6.5 2-2.9 2-6.5 2-6.5-.9-6.5-2z', 'M1.5 8c0-1.1 2.9-2 6.5-2s6.5.9 6.5 2', 'M1.5 8v4.5c0 1.1 2.9 2 6.5 2s6.5-.9 6.5-2V8'],
  settings: ['M4 21v-7M4 10V3', 'M12 21V12M12 8V3', 'M20 21v-5M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
};

// 当前激活的导航项(用 route.path 匹配)
const activeTab = computed(() => {
  const p = route.path;
  // 精确匹配优先,否则前缀匹配
  const exact = tabs.find((t) => t.key === p);
  if (exact) return exact.key;
  // 特殊:详情页 /xxx/:id 高亮对应的任务列表项
  if (p.startsWith('/image-refresh/')) return '/image-refresh-tasks';
  if (p.startsWith('/stock-refresh/')) return '/stock-refresh-tasks';
  if (p.startsWith('/product-update/')) return '/product-update-tasks';
  if (p.startsWith('/product-archive/')) return '/product-archive-tasks';
  return tabs.find((t) => p.startsWith(t.key))?.key || '/admin';
});

// 当前激活项所属分组
const activeGroupId = computed(
  () => navGroups.find((g) => g.items.some((t) => t.key === activeTab.value))?.id || navGroups[0].id
);

// 分组展开状态:默认展开"工作台";路由变化时自动展开所属分组
const openGroups = reactive({ workbench: true });
const isGroupOpen = (id) => !!openGroups[id];
const toggleGroup = (id) => {
  openGroups[id] = !openGroups[id];
};

// 侧边栏收起/展开状态(顶栏按钮控制;localStorage 持久化,刷新后保持)
const SIDEBAR_KEY = 'erp_sidebar_collapsed';
let initialCollapsed = false;
try {
  initialCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
} catch (e) { /* 忽略 */ }
const sidebarCollapsed = ref(initialCollapsed);
const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try {
    localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed.value ? '1' : '0');
  } catch (e) { /* 忽略 */ }
};
watch(
  activeGroupId,
  (id) => {
    if (id && !openGroups[id]) openGroups[id] = true;
  },
  { immediate: true }
);
</script>

<template>
  <AppTopbar
    :sidebar-collapsed="sidebarCollapsed"
    @toggle-sidebar="toggleSidebar"
  />
  <AppToast />
  <AppConfirm />
  <a href="#main-content" class="skip-link">跳到主内容</a>
  <div v-if="auth.isLoggedIn" class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <nav class="sidebar" aria-label="主导航">
      <div
        v-for="group in navGroups"
        :key="group.id"
        class="nav-group"
        :class="{ 'is-open': isGroupOpen(group.id) }"
      >
        <button
          type="button"
          class="nav-group-head"
          :aria-expanded="isGroupOpen(group.id)"
          @click="toggleGroup(group.id)"
        >
          <span class="nav-group-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="d in groupIcons[group.id]" :key="d" :d="d" />
            </svg>
          </span>
          <span class="nav-group-label">{{ group.label }}</span>
          <span class="nav-group-caret" aria-hidden="true">›</span>
        </button>
        <ul v-show="isGroupOpen(group.id)" class="nav-group-list">
          <li v-for="item in group.items" :key="item.key">
            <RouterLink
              class="nav-item"
              :class="{ active: activeTab === item.key }"
              :to="item.key"
            >
              {{ item.label }}
            </RouterLink>
          </li>
        </ul>
      </div>
    </nav>
    <main id="main-content" class="app-main">
      <RouterView />
    </main>
  </div>
  <main v-else id="main-content">
    <RouterView />
  </main>
</template>