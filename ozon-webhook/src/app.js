// Ozon Webhook 服务入口(Koa 2.x)
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import config from './config/index.js';
import { initSchema } from './db/index.js';
import logger from './middleware/log.js';
import { requestLog } from './middleware/log.js';
import { ipWhitelist } from './middleware/ip-whitelist.js';
import { errorHandler } from './middleware/error.js';
import webhookRoutes from './modules/webhook.js';
import { startEventPoller, stopEventPoller } from './services/event-poller.js';
import { loadStores, getStoresMeta } from './services/store-loader.js';

// 初始化 DB schema
await initSchema();

// 加载店铺凭据(从 erp-backend-lite/src/config/stores.json)
const storesResult = loadStores();
if (storesResult.count === 0) {
  logger.warn(
    { path: storesResult.path, error: storesResult.error },
    'stores.json 未加载到任何店铺,TYPE_NEW_POSTING 回拉 OPI 将全部降级用推送原字段',
  );
}

const app = new Koa();

// 前置 nginx 反代:信任 X-Forwarded-For,使 ctx.ip 取真实客户端 IP
app.proxy = true;

// 中间件链(顺序敏感)
// bodyparser → requestLog → errorHandler(放前面捕获后续错误)
// ipWhitelist → webhook 路由
app.use(errorHandler());
app.use(bodyParser());
app.use(requestLog());
app.use(ipWhitelist());
app.use(webhookRoutes.routes());
app.use(webhookRoutes.allowedMethods());

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: process.env.NODE_ENV || 'development' },
    `Ozon Webhook 服务启动: http://localhost:${config.port}`,
  );
  // 启动 Event Poller(异步消费已落库事件)
  startEventPoller();
});

// 优雅退出
function shutdown(signal) {
  logger.info({ signal }, '收到退出信号,正在关闭...');
  stopEventPoller();
  server.close(() => {
    logger.info('已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
