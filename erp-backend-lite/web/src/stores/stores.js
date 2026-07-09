import { defineStore } from 'pinia';
import * as request from '../api/request.js';

export const useStoresStore = defineStore('stores', {
  state: () => ({
    list: [],
    loaded: false,
  }),
  getters: {
    findStore: (state) => (id) => state.list.find((s) => s.id === id),
  },
  actions: {
    async load(force = false) {
      if (this.loaded && !force) return;
      const resp = await request.get('/admin/api/stores');
      // 后端返回 { ok, data: [...] },request 解包后 resp 即店铺数组;
      // 同时兼容 { data: [...] } 形态
      this.list = Array.isArray(resp) ? resp : resp?.data || [];
      this.loaded = true;
      return this.list;
    },
    reset() {
      this.list = [];
      this.loaded = false;
    },
  },
});
