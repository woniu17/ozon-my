// ERP 后端服务(轻量级个人版)入口
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from './config/index.js';
import { initSchema } from './db/index.js';
import { authMiddleware, tokenRefreshInjector } from './middleware/auth.js';
import { requestLog } from './middleware/request-log.js';
import { cdnBuster } from './middleware/cdn-buster.js';
import { notFound, errorHandler } from './middleware/error.js';
import logger from './middleware/log.js';

import authRoutes from './modules/auth.js';
import featureFlagsRoutes from './modules/feature-flags.js';
import membershipRoutes from './modules/membership.js';
import productsRoutes from './modules/products.js';
import collectBoxRoutes from './modules/collect-box.js';
import productDataRoutes from './modules/product-data.js';
import miscRoutes from './modules/misc.js';
import adminRoutes from './modules/admin.js';
import configRoutes from './modules/config.js';
import batchRoutes from './modules/batch.js';
import cacheRoutes from './modules/cache.js';
import { auditLog } from './middleware/audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

// 初始化数据库 schema
initSchema();

const app = express();

// 基础中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cdnBuster);
app.use(requestLog);

// CORS + Private Network Access (PNA)
// 插件 content script 运行在 https://www.ozon.ru 页面里,直接 fetch http://localhost:3001
// 会被 Chrome 的 PNA 策略拦截 ("Permission was denied for this request to access the
// loopback address space")。这里下发 PNA 头让浏览器放行。
// 必须放在 authMiddleware 之前,否则 OPTIONS 预检会被 401 拦截。
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ozon-store-id, x-o3-app-name');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// 静态资源(管理后台页面 HTML/JS/CSS,无需鉴权即可访问;敏感数据由 API 鉴权保护)
app.use(express.static(PUBLIC_DIR));
// /admin 便捷入口 → admin.html
app.get('/admin', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'admin.html')));

// 鉴权(放行 /health、/auth/login-password 等)
app.use(authMiddleware);
app.use(tokenRefreshInjector);
// 审计日志(记录关键写操作,需在鉴权之后以获取 operator)
app.use(auditLog);

// 业务路由
app.use(authRoutes);
app.use(featureFlagsRoutes);
app.use(membershipRoutes);
app.use(productsRoutes);
app.use(collectBoxRoutes);
app.use(productDataRoutes);
app.use(miscRoutes);
app.use(adminRoutes);
app.use(configRoutes);
app.use(batchRoutes);
app.use(cacheRoutes);

// 代采端点(feature-flag 门控:仅 proxy_collect=true 时挂载)
if (config.featureFlags?.proxy_collect) {
  app.use(agentsRoutes);
  logger.info('代采端点已挂载(proxy_collect=true)');
}

// 404 + 错误处理
app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: process.env.NODE_ENV || 'development' },
    `🚀 ERP 后端(轻量级)启动: http://localhost:${config.port}`
  );
});

// 优雅退出
function shutdown(signal) {
  logger.info({ signal }, '收到退出信号,正在关闭...');
  server.close(() => {
    logger.info('已关闭');
    process.exit(0);
  });
  // 5s 强制退出
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
