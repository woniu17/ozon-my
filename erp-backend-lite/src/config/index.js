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
};

export default config;
