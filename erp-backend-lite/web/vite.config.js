import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 后端 Express 运行在 localhost:3001,提供 /admin/api/*、/auth/*、/health 接口
const BACKEND = 'http://localhost:3001';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': { target: BACKEND, changeOrigin: true },
      '/auth': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    // 构建产物直接输出到后端静态目录,Task 14 build 时会覆盖旧 admin.html/js/css
    outDir: '../src/public',
    // 不清空 outDir,避免误删后端其他静态文件
    emptyOutDir: false,
    rollupOptions: {
      // 入口 HTML 命名为 admin.html,匹配后端 app.js 的 /admin → sendFile('admin.html')
      input: {
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
      output: {
        entryFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash].css',
      },
    },
  },
});
