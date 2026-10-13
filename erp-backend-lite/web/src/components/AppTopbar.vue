<script setup>
import { useAuthStore } from '../stores/auth.js';
import { useRouter } from 'vue-router';

defineProps({
  sidebarCollapsed: {
    type: Boolean,
    default: false,
  },
});
defineEmits(['toggle-sidebar']);

const auth = useAuthStore();
const router = useRouter();

const onLogout = () => {
  auth.logout();
  router.push('/login');
};
</script>

<template>
  <div class="topbar">
    <div class="topbar-left">
      <button
        v-if="auth.isLoggedIn"
        type="button"
        class="sidebar-toggle"
        :aria-expanded="!sidebarCollapsed"
        :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
        title="收起/展开侧边栏"
        @click="$emit('toggle-sidebar')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <h1>ERP 配置后台</h1>
      <span class="subtitle">店铺 / 上架 / 采集 / 商品</span>
    </div>
    <div class="topbar-right">
      <span v-if="auth.isLoggedIn" class="user-badge"><span aria-hidden="true">👤</span> {{ auth.phone }}</span>
      <button v-if="auth.isLoggedIn" class="btn btn-ghost" @click="onLogout">退出登录</button>
    </div>
  </div>
</template>