// 配置加载:从 .env + 环境变量读取,启动时校验必填项
import 'dotenv/config';

const config = {
  port: Number(process.env.PORT) || 3002,
  logLevel: process.env.LOG_LEVEL || 'info',

  // 数据库
  dbDriver: process.env.DB_DRIVER || 'sqlite',
  sqlitePath: process.env.SQLITE_PATH || './data/ozon-webhook.db',
  mongo: {
    host: process.env.MONGO_HOST || '',
    port: Number(process.env.MONGO_PORT) || 27017,
  },

  // OPI(回拉订单详情用)
  opiBaseUrl: process.env.OZON_OPI_BASE_URL || 'https://api-seller.ozon.ru',
  // 多店铺凭据:从本地 stores.json 副本加载,按 seller_id 路由
  // 副本从 erp-backend-lite/src/config/stores.json 拷贝而来,保持本地自包含
  // 如需切换为 erp 实时配置,可改为 '../erp-backend-lite/src/config/stores.json'
  storesConfigPath: process.env.STORES_CONFIG_PATH || './src/config/stores.json',

  // 服务身份(PING 响应用)
  appName: process.env.APP_NAME || 'ozon-webhook',
  appVersion: process.env.APP_VERSION || '1.0.0',

  // IP 白名单
  ipWhitelistEnabled: String(process.env.IP_WHITELIST_ENABLED ?? 'true') === 'true',

  // Poller
  poller: {
    intervalMs: Number(process.env.POLLER_INTERVAL_MS) || 2000,
    concurrency: Number(process.env.POLLER_CONCURRENCY) || 1,
    maxRetry: Number(process.env.POLLER_MAX_RETRY) || 5,
  },

  // Ozon 推送源 IP 段(3 段,启动时加载到内存中做 CIDR 匹配)
  ozonPushCidrs: ['195.34.21.0/24', '185.73.192.0/22', '91.223.93.0/24'],
};

// 启动时校验:DB_DRIVER=mongo 时,首批未实现 mongo 分支
if (config.dbDriver === 'mongo') {
  console.error('[config] 首批只实现 sqlite 驱动,请设置 DB_DRIVER=sqlite');
  process.exit(1);
}

export default config;
