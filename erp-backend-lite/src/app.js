// ERP 后端服务(轻量级个人版)入口
import express from 'express';
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

// 初始化数据库 schema
initSchema();

const app = express();

// 基础中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cdnBuster);
app.use(requestLog);

// 鉴权(放行 /health、/auth/login-password 等)
app.use(authMiddleware);
app.use(tokenRefreshInjector);

// 业务路由
app.use(authRoutes);
app.use(featureFlagsRoutes);
app.use(membershipRoutes);
app.use(productsRoutes);
app.use(collectBoxRoutes);
app.use(productDataRoutes);
app.use(miscRoutes);

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
