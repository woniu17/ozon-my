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
  <section class="card center-card">
    <h2>登录</h2>
    <p class="muted">个人版单用户登录,账号由 .env 中 USER_PHONE / USER_PASSWORD 配置。</p>
    <form class="form" @submit.prevent="onSubmit">
      <label>
        <span>手机号</span>
        <input type="text" v-model.trim="form.phoneNumber" placeholder="13800138000" autocomplete="username" required />
      </label>
      <label>
        <span>密码</span>
        <input
          type="password"
          v-model="form.password"
          placeholder="请输入密码"
          autocomplete="current-password"
          required
        />
      </label>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" :disabled="form.loading">
          {{ form.loading ? '登录中...' : '登录' }}
        </button>
      </div>
      <p class="error-text" v-show="form.err">{{ form.err }}</p>
    </form>
  </section>
</template>
