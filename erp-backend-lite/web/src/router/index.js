import { createRouter, createWebHashHistory } from 'vue-router';
import Login from '../views/Login.vue';
import Dashboard from '../views/Dashboard.vue';
import Stores from '../views/Stores.vue';
import Listings from '../views/Listings.vue';
import CollectBoxV2 from '../views/CollectBoxV2.vue';
import Preview from '../views/Preview.vue';
import Products from '../views/Products.vue';
import Batch from '../views/Batch.vue';
import Audit from '../views/Audit.vue';
import Config from '../views/Config.vue';
import ListingTemplates from '../views/ListingTemplates.vue';
import Cache from '../views/Cache.vue';
import CollectLogs from '../views/CollectLogs.vue';
import ShallowCollectLogs from '../views/ShallowCollectLogs.vue';
import CollectQueue from '../views/CollectQueue.vue';
import CategoryFilter from '../views/CategoryFilter.vue';
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
    { path: '/batch', name: 'batch', component: Batch },
    { path: '/audit', name: 'audit', component: Audit },
    { path: '/config', name: 'config', component: Config },
    { path: '/listing-templates', name: 'listing-templates', component: ListingTemplates },
    { path: '/cache', name: 'cache', component: Cache },
    { path: '/collect-logs', name: 'collect-logs', component: CollectLogs, meta: { title: '深度采集日志' } },
    { path: '/shallow-collect-logs', name: 'shallow-collect-logs', component: ShallowCollectLogs, meta: { title: '浅度采集日志' } },
    { path: '/collect-queue', name: 'collect-queue', component: CollectQueue, meta: { title: '采集队列' } },
    { path: '/category-filter', name: 'category-filter', component: CategoryFilter, meta: { title: '类目过滤' } },
    { path: '/batch-upload/:batchNo', name: 'batch-upload-detail', component: () => import('../views/BatchUploadDetail.vue'), meta: { title: '批次详情' } },
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
