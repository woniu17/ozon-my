import { defineStore } from 'pinia';
import * as request from '../api/request.js';

const TOKEN_KEY = 'erp_admin_token';
const USER_KEY = 'erp_admin_user';
const PHONE_KEY = 'erp_admin_phone';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
    phone: localStorage.getItem(PHONE_KEY) || '',
  }),
  getters: {
    isLoggedIn: (state) => !!state.token,
    phoneLast: (state) => state.phone,
  },
  actions: {
    async login({ phoneNumber, password }) {
      // 后端 /auth/login-password 返回 { accessToken, user }(非 envelope,request 原样返回)
      const data = await request.post('/auth/login-password', { phoneNumber, password });
      this.token = data.accessToken;
      this.user = data.user;
      this.phone = phoneNumber;
      localStorage.setItem(TOKEN_KEY, this.token);
      localStorage.setItem(USER_KEY, JSON.stringify(this.user));
      localStorage.setItem(PHONE_KEY, this.phone);
      return data;
    },
    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      // 保留 phone,方便下次登录预填
    },
    setToken(t) {
      this.token = t;
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    },
  },
});

// 监听全局登出事件(request 遇 401 时触发)
window.addEventListener('auth:logout', () => {
  useAuthStore().logout();
});
