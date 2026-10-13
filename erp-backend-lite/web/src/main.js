import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import SkeletonTable from './components/SkeletonTable.vue';
import './styles/global.css';

const app = createApp(App);
app.use(router);
app.use(createPinia());
app.component('SkeletonTable', SkeletonTable); // P2:全局骨架屏组件
app.mount('#app');
