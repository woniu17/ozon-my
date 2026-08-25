import { createRouter, createWebHashHistory } from 'vue-router';
import Login from '../views/Login.vue';
import Dashboard from '../views/Dashboard.vue';
import Stores from '../views/Stores.vue';
import Listings from '../views/Listings.vue';
import CollectBoxV2 from '../views/CollectBoxV2.vue';
import Preview from '../views/Preview.vue';
import Products from '../views/Products.vue';
import ProductDetailCompare from '../views/ProductDetailCompare.vue';
import Batch from '../views/Batch.vue';
import ImageRefreshList from '../views/ImageRefreshList.vue';
import StockRefreshList from '../views/StockRefreshList.vue';
import ProductUpdateList from '../views/ProductUpdateList.vue';
import ProductArchiveList from '../views/ProductArchiveList.vue';
import ExportTasks from '../views/ExportTasks.vue';
import Audit from '../views/Audit.vue';
import Config from '../views/Config.vue';
import ListingTemplates from '../views/ListingTemplates.vue';
import WatermarkTemplates from '../views/WatermarkTemplates.vue';
import Cache from '../views/Cache.vue';
import CollectLogs from '../views/CollectLogs.vue';
import ShallowCollectLogs from '../views/ShallowCollectLogs.vue';
import CollectQueue from '../views/CollectQueue.vue';
import CategoryFilter from '../views/CategoryFilter.vue';
import EndpointMetrics from '../views/EndpointMetrics.vue';
import { useAuthStore } from '../stores/auth.js';

// 路由配置 + JWT 守卫
const router = createRouter({
  // 后端托管静态文件,hash 路由更稳
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/admin' },
    { path: '/login', component: Login, meta: { public: true } },
    { path: '/admin', component: Dashboard },
    { path: '/stores', name: 'stores', component: Stores },
    { path: '/listings', name: 'listings', component: Listings },
    { path: '/collect-box-v2', name: 'collect-box-v2', component: CollectBoxV2 },
    { path: '/preview/:sku', name: 'preview', component: Preview, meta: { title: '上架预览' } },
    { path: '/products', name: 'products', component: Products },
    { path: '/products/detail/:sku', name: 'product-detail', component: ProductDetailCompare, meta: { title: '商品详情对比' } },
    { path: '/batch', name: 'batch', component: Batch },
    { path: '/image-refresh-tasks', name: 'image-refresh-tasks', component: ImageRefreshList, meta: { title: '图片更新任务' } },
    { path: '/stock-refresh-tasks', name: 'stock-refresh-tasks', component: StockRefreshList, meta: { title: '库存更新任务' } },
    { path: '/product-update-tasks', name: 'product-update-tasks', component: ProductUpdateList, meta: { title: '商品信息更新任务' } },
    { path: '/product-archive-tasks', name: 'product-archive-tasks', component: ProductArchiveList, meta: { title: '商品归档任务' } },
    { path: '/export-tasks', name: 'export-tasks', component: ExportTasks, meta: { title: '导出任务' } },
    { path: '/audit', name: 'audit', component: Audit },
    { path: '/config', name: 'config', component: Config },
    { path: '/listing-templates', name: 'listing-templates', component: ListingTemplates },
    { path: '/watermark-templates', name: 'watermark-templates', component: WatermarkTemplates, meta: { title: '水印模板' } },
    { path: '/cache', redirect: '/sku-data' },
    { path: '/sku-data', name: 'sku-data', component: Cache, meta: { title: 'SKU 数据' } },
    { path: '/store-data', name: 'store-data', component: Cache, meta: { title: '店铺数据' } },
    { path: '/store-sku', name: 'store-sku', component: Cache, meta: { title: '店铺 SKU' } },
    { path: '/collect-logs', name: 'collect-logs', component: CollectLogs, meta: { title: '深度采集日志' } },
    { path: '/shallow-collect-logs', name: 'shallow-collect-logs', component: ShallowCollectLogs, meta: { title: '浅度采集日志' } },
    { path: '/collect-queue', name: 'collect-queue', component: CollectQueue, meta: { title: '采集队列' } },
    { path: '/category-filter', name: 'category-filter', component: CategoryFilter, meta: { title: '类目过滤' } },
    { path: '/endpoint-metrics', name: 'endpoint-metrics', component: EndpointMetrics, meta: { title: '端点耗时' } },
    { path: '/batch-upload/:batchNo', name: 'batch-upload-detail', component: () => import('../views/BatchUploadDetail.vue'), meta: { title: '批次详情' } },
    { path: '/image-refresh/:localTaskId', name: 'image-refresh-detail', component: () => import('../views/ImageRefreshDetail.vue'), meta: { title: '图片更新详情' } },
    { path: '/stock-refresh/:localTaskId', name: 'stock-refresh-detail', component: () => import('../views/StockRefreshDetail.vue'), meta: { title: '库存更新详情' } },
    { path: '/product-update/:localTaskId', name: 'product-update-detail', component: () => import('../views/ProductUpdateDetail.vue'), meta: { title: '商品信息更新详情' } },
    { path: '/product-archive/:localTaskId', name: 'product-archive-detail', component: () => import('../views/ProductArchiveDetail.vue'), meta: { title: '商品归档详情' } },
  ],
});

// 全局前置守卫:public 路由(如 /login)已登录则跳 /admin;其余路由未登录则跳 /login
router.beforeEach((to, from, next) => {
  const auth = useAuthStore();
  if (to.meta.public) {
    if (auth.isLoggedIn) next('/admin');
    else next();
  } else {
    if (auth.isLoggedIn) next();
    else next('/login');
  }
});

export default router;
