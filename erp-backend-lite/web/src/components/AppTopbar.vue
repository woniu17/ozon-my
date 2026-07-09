<script setup>
import { useAuthStore } from '../stores/auth.js';
import { useRouter } from 'vue-router';

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
      <h1>ERP 配置后台</h1>
      <span class="subtitle">店铺 / 上架 / 采集 / 商品</span>
    </div>
    <div class="topbar-right">
      <span v-if="auth.isLoggedIn" class="user-badge">👤 {{ auth.phone }}</span>
      <button v-if="auth.isLoggedIn" class="btn btn-ghost" @click="onLogout">退出登录</button>
    </div>
  </div>
</template>
