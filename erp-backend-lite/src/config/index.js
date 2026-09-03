// 配置加载:环境变量 + JSON 静态配置
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = __dirname;

function loadJson(name) {
  try {
    return JSON.parse(readFileSync(join(CONFIG_DIR, name), 'utf-8'));
  } catch (e) {
    console.warn(`[config] ${name} 加载失败,使用默认空配置:`, e.message);
    return {};
  }
}

// 热加载配置文件(每次请求读最新,便于运行时修改 stores.json 后立即生效)
function loadStores() {
  return loadJson('stores.json');
}

const membershipConfig = loadJson('membership.json');
const featureFlagsConfig = loadJson('feature-flags.json');

const config = {
  port: Number(process.env.PORT) || 3001,
  jwtSecret: process.env.JWT_SECRET || 'default-insecure-secret-change-me',
  userPhone: process.env.USER_PHONE || '13800138000',
  userPassword: process.env.USER_PASSWORD || '', // bcrypt hash
  ozonOpiBaseUrl: process.env.OZON_OPI_BASE_URL || 'https://api-seller.ozon.ru',
  logLevel: process.env.LOG_LEVEL || 'info',
  jwtExpiresIn: '7d',
  // 滑动续期:剩余有效期小于总有效期的 50% 时重签
  refreshThresholdRatio: 0.5,
  // 商品数据缓存 TTL(ms)
  productDataCacheTtlMs: 60 * 60 * 1000,
  // 静态配置
  membership: membershipConfig,
  featureFlags: featureFlagsConfig,
  loadStores,
  imageHostBaseUrl: process.env.IMAGE_HOST_BASE_URL || '',
  // 图片处理代理(2026-07):local=本地处理,remote=转发远程 ERP
  imageHostMode: process.env.IMAGE_HOST_MODE || 'local',
  remoteImageHostUrl: (process.env.REMOTE_IMAGE_HOST_URL || '').replace(/\/$/, ''),
  remoteImageHostToken: process.env.REMOTE_IMAGE_HOST_TOKEN || '',
  // 服务间 API Key(2026-08):无头采集脚本(deep-collect.js)等服务调用方
  // 经 x-api-key 头鉴权(非 JWT,永久有效);未配置时不启用该通道
  serviceApiKey: process.env.SERVICE_API_KEY || '',
  // RUB→CNY 汇率兜底(2026-09,应计利润换算);app_config.rub_cny_rate 优先
  rubCnyRateFallback: Number(process.env.RUB_CNY_RATE) || 0,
};

export default config;
