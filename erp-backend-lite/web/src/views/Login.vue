<script setup>
import { reactive } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useToast } from '../components/useToast.js';

const auth = useAuthStore();
const router = useRouter();
const { show } = useToast();

const form = reactive({
  phoneNumber: auth.phone || '',
  password: '',
  err: '',
  loading: false,
});

const onSubmit = async () => {
  form.err = '';
  form.loading = true;
  try {
    await auth.login({ phoneNumber: form.phoneNumber, password: form.password });
    router.push('/admin');
  } catch (e) {
    form.err = e.message;
    form.password = '';
    show(e.message, 'error');
  } finally {
    form.loading = false;
  }
};
</script>

<template>
  <div class="login-page">
    <aside class="login-brand" aria-hidden="true">
      <div class="login-brand-inner">
        <div class="login-logo">O</div>
        <h2>Ozon ERP</h2>
        <p class="login-slogan">商品 · 上架 · 订单 · 财务，一站式管理你的 Ozon 店铺。</p>
        <ul class="login-features">
          <li>批量采集与图片/库存自动化任务</li>
          <li>成本利润率定价与价格监控</li>
          <li>扫描打单、订单同步、财务统计</li>
        </ul>
      </div>
    </aside>
    <main class="login-main">
      <div class="login-card">
        <h2>登录</h2>
        <p class="muted">个人版单用户登录，账号由 .env 中 USER_PHONE / USER_PASSWORD 配置。</p>
        <form class="form" @submit.prevent="onSubmit">
          <label>
            <span>手机号</span>
            <input
              type="tel"
              inputmode="tel"
              v-model.trim="form.phoneNumber"
              placeholder="13800138000"
              autocomplete="username"
              spellcheck="false"
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              v-model="form.password"
              placeholder="请输入密码…"
              autocomplete="current-password"
              required
            />
          </label>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" :disabled="form.loading">
              <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10m0 0L9 4m4 4l-4 4"/></svg>
              {{ form.loading ? '登录中…' : '登录' }}
            </button>
          </div>
          <p class="error-text" v-show="form.err">{{ form.err }}</p>
        </form>
      </div>
    </main>
  </div>
</template>
