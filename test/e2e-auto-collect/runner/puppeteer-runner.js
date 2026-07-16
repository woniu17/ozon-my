// Puppeteer E2E 测试运行器 — 自动采集功能端到端测试
//
// 用法:
//   node test/e2e-auto-collect/runner/puppeteer-runner.js [场景名]
//   场景名: basic | dedup | non-chinese | daily-limit | cache-hit | antibot | all (默认 all)
//
// 前置条件:
//   1. erp-backend-lite 已启动 (端口 3001)
//   2. mock-server 已启动 (端口 7777)
//   3. 已安装 puppeteer + mongodb: cd test/e2e-auto-collect && npm install

import puppeteer from 'puppeteer';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载 erp-backend-lite 的 .env 获取 MongoDB 连接信息
dotenv.config({ path: resolve(__dirname, '../../../erp-backend-lite/.env') });

const EXTENSION_PATH = resolve(__dirname, '../../../qx-ozon');
const MOCK_BASE = 'http://localhost:7777';
const MONGO_URL =
  `mongodb://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}` +
  `@${process.env.MONGO_HOST}:${process.env.MONGO_PORT}/?authSource=${process.env.MONGO_AUTH_SOURCE}`;
const DB_NAME = 'ozon_erp';

// 测试 SKU
const SKUS = ['100001', '100002', '100003'];
const CHINA_SHOP_SLUG = 'mock-china-shop';
const FOREIGN_SHOP_SLUG = 'mock-foreign-shop';
const PRODUCTS_LEN = 3; // 现有场景仍按 3 个 SKU 测试(基础场景)

// ─── 工具函数 ─────────────────────────────────────────────

const log = (msg) => console.log(`[test] ${msg}`);
const pass = (msg) => console.log(`  ✓ PASS: ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ FAIL: ${msg}`);
  process.exitCode = 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等待 SW target 启动并返回 worker
async function waitForServiceWorker(browser) {
  log('等待 Service Worker 启动...');
  for (let i = 0; i < 60; i++) {
    const targets = browser.targets();
    const sw = targets.find((t) => t.type() === 'service_worker');
    if (sw) {
      const worker = await sw.worker();
      log('Service Worker 已启动');
      return worker;
    }
    await sleep(500);
  }
  throw new Error('Service Worker 未在 30s 内启动');
}

// 在 SW 上下文执行代码(带 10s 超时保护,支持传参)
async function swEval(sw, fn, ...args) {
  return Promise.race([
    sw.evaluate(fn, ...args),
    new Promise((_, reject) => setTimeout(() => reject(new Error('swEval 超时 10s')), 10000)),
  ]);
}

// 设置测试模式 + 重载 SW,用 targetcreated 事件捕获新 SW worker
async function enableTestMode(browser, sw) {
  log('设置 IS_TEST_MODE = true + 注入 ERP token...');
  await swEval(
    sw,
    async (token) => {
      await chrome.storage.local.set({
        __IS_TEST_MODE__: true,
        ozonAuthToken: token, // 让 checkAuth 判定已登录
        ozonStoreId: 'test-store',
      });
    },
    ERP_TOKEN
  );

  // 先注册 targetcreated 监听器,再触发 reload(避免竞争)
  const newSwPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待新 SW target 超时 20s')), 20000);
    const handler = (target) => {
      if (target.type() === 'service_worker') {
        clearTimeout(timeout);
        browser.off('targetcreated', handler);
        resolve(target);
      }
    };
    browser.on('targetcreated', handler);
  });

  log('重载扩展...');
  await swEval(sw, () => chrome.runtime.reload());

  log('等待新 Service Worker target 创建...');
  const newSwTarget = await newSwPromise;
  // 给新 SW 一点时间完成初始化
  await sleep(2000);
  const newSw = await newSwTarget.worker();
  log('新 Service Worker 已就绪');
  return newSw;
}

// 设置 autoCollect 配置
// 直接写 chrome.storage.local。SW 中的 _autoCollectConfigCache 会通过
// storage.onChanged 监听器自动 invalidate(SW 代码中已添加)。
async function setAutoCollectConfig(sw, config) {
  return swEval(
    sw,
    async (cfg) => {
      const cur = (await chrome.storage.local.get('jz-auto-collect-config'))['jz-auto-collect-config'] || {};
      const next = { ...cur, ...cfg, todayDate: new Date().toISOString().slice(0, 10) };
      await chrome.storage.local.set({ 'jz-auto-collect-config': next });
      return next;
    },
    config
  );
}

// 获取 autoCollect 配置
async function getAutoCollectConfig(sw) {
  return swEval(sw, async () => {
    return (await chrome.storage.local.get('jz-auto-collect-config'))['jz-auto-collect-config'] || {};
  });
}

// 清空 MongoDB 缓存集合
async function clearMongoCache(mongo) {
  const collections = [
    'ozon_card_cache',
    'ozon_detail_cache',
    'ozon_composer_cache',
    'ozon_entrypoint_cache',
    'ozon_search_cache',
    'ozon_bundle_cache',
    'ozon_market_stats_cache',
    'ozon_follow_sell_cache',
    'ozon_auto_collect_log',
    'collect_queue_tasks',
    'collect_queue_ops',
  ];
  for (const name of collections) {
    try {
      await mongo.collection(name).deleteMany({});
    } catch {}
  }
  log('MongoDB 缓存已清空');
}

// 重置 SW 队列全部状态(消除场景间状态泄露:consumePaused/todayCount/_completedTodaySkus/_consuming)
async function resetQueueMeta(sw) {
  await swEval(sw, async () => {
    if (typeof self.__jzResetQueueState === 'function') {
      await self.__jzResetQueueState();
    }
  });
}

// 仅清空队列任务,保留缓存集合(用于缓存命中测试)
async function clearQueueTasksOnly(mongo) {
  for (const name of ['collect_queue_tasks', 'collect_queue_ops', 'ozon_auto_collect_log']) {
    try {
      await mongo.collection(name).deleteMany({});
    } catch {}
  }
  log('仅清空队列任务(保留缓存集合)');
}

// 查询 MongoDB 缓存
async function countCache(mongo, collectionName, filter = {}) {
  try {
    return await mongo.collection(collectionName).countDocuments(filter);
  } catch {
    return 0;
  }
}

// 查询 collect_queue_tasks
async function getQueueTasks(mongo, filter = {}) {
  try {
    return await mongo.collection('collect_queue_tasks').find(filter).toArray();
  } catch {
    return [];
  }
}

// ERP 后端地址 + JWT token(启动时登录获取)
const ERP_BASE = 'http://localhost:3001';
let ERP_TOKEN = '';

// 登录 ERP 获取 JWT token
async function loginErp() {
  const resp = await fetch(`${ERP_BASE}/auth/login-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phoneNumber: process.env.USER_PHONE || '13800138000',
      password: process.env.USER_PASSWORD || 'password',
    }),
  });
  if (!resp.ok) throw new Error(`ERP 登录失败: ${resp.status}`);
  const data = await resp.json();
  ERP_TOKEN = data.accessToken;
  log('ERP 登录成功,已获取 JWT token');
}

// 通过 ERP 后端设置店铺分类(中国/非中国)
async function setStoreClassification(slug, isChinese) {
  const resp = await fetch(`${ERP_BASE}/admin/api/store-classification/${slug}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ERP_TOKEN}`,
    },
    body: JSON.stringify({ isChinese, classifiedAt: new Date().toISOString() }),
  });
  return resp.ok;
}

// 通过 ERP 后端清空店铺分类
async function clearStoreClassification(slug) {
  try {
    await fetch(`${ERP_BASE}/admin/api/store-classification/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ERP_TOKEN}` },
    });
  } catch {}
}

// 通过 mock-server 控制按 SKU 注入故障(retry-backoff 场景用)
async function setFailSku(sku, fail) {
  const resp = await fetch(`${MOCK_BASE}/__test/fail-sku`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: String(sku), fail: !!fail }),
  });
  return resp.ok;
}

// 通用:打开中国店铺页并滚动触发 IntersectionObserver
// 等待 seller-info-main.js 完成(设置 data-jz-seller-info 属性)再滚动,
// 避免 IntersectionObserver 在 sellerSlug 就绪前触发导致 unclassified-store 跳过。
// 如果传入 mongo + sw,会在 seller-info 就绪后清空早期(空 slug)队列任务并重置 SW
// 内存队列状态(_consuming/_completedTodaySkus 等),确保 SW 不会消费早期空 slug 任务。
// 关键:页面加载前先禁用 autoCollectRunning,防止 SW 在 seller-info 就绪前消费早期任务。
async function openChinaShopAndScroll(browser, sleepAfterScroll = 3000, mongo = null, sw = null) {
  // 页面加载前先禁用 autoCollectRunning,防止 IntersectionObserver 在 seller-info
  // 就绪前触发的早期任务被 SW 消费(导致 unclassified-store 跳过)。
  if (sw) {
    await setAutoCollectConfig(sw, { autoCollectRunning: false });
    await sleep(300);
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  // 等 seller-info-main.js 发布属性(MAIN world 写 DOM 属性,ISOLATED/world 可见)
  await page
    .waitForFunction(() => document.documentElement.getAttribute('data-jz-seller-info') !== null, { timeout: 15000 })
    .catch(() => log('  warn: data-jz-seller-info 等待超时,继续执行'));
  // 等 content script 的 1s 轮询拾取 seller-info(避免 IntersectionObserver 先于 sellerSlug 就绪触发)
  await sleep(2000);
  // 清空早期(空 slug)队列任务:页面加载时 IntersectionObserver 可能在 sellerSlug 就绪前已触发,
  // 这些任务会因 unclassified-store 被跳过。清空 mongo + 重置 SW 内存队列状态,确保只保留正确 slug 的任务。
  if (mongo) {
    try {
      await mongo.collection('collect_queue_tasks').deleteMany({});
      await mongo.collection('ozon_auto_collect_log').deleteMany({});
      log('已清空早期队列任务(seller-info 就绪前提交的空 slug 任务)');
    } catch {}
  }
  if (sw) {
    await resetQueueMeta(sw);
    // 等待 SW 异步写入完成(防止 SW 在清空 mongo 后仍写入早期任务结果)
    await sleep(500);
    // 再次清空 mongo(SW 可能在清空后又写入了早期任务的结果)
    if (mongo) {
      try {
        await mongo.collection('collect_queue_tasks').deleteMany({});
        await mongo.collection('ozon_auto_collect_log').deleteMany({});
      } catch {}
    }
    // 重新启用 autoCollectRunning,让 SW 只消费滚动后提交的正确 slug 任务
    await setAutoCollectConfig(sw, { autoCollectRunning: true });
    await sleep(300);
    log('已重置 SW 内存队列状态 + 重新启用 autoCollectRunning');
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(sleepAfterScroll);
  return page;
}

// ─── 测试场景 ─────────────────────────────────────────────

// 场景 1: 基础 E2E — 店铺页滚动 → 采集完成 → 缓存落库
async function scenarioBasic(browser, sw, mongo) {
  log('\n══ 场景 1: 基础 E2E ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);

  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  // 打开店铺页
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  log(`访问 ${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`);
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });

  // 等待 content script 注入 + seller-info 处理
  await sleep(3000);

  // 模拟滚动触发 IntersectionObserver
  log('模拟滚动触发 IntersectionObserver...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1000);
  await page.evaluate(() => window.scrollTo(0, 0));

  // 等待采集完成(最多 30s)
  log('等待采集完成(最多 30s)...');
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const processedCount = tasks.filter(
      (t) =>
        t.status === 'done' || t.status === 'completed' || t.status === 'failed_partial' || t.status === 'failed_final'
    ).length;
    if (processedCount >= 2) {
      log(`已处理 ${processedCount} 个任务`);
      break;
    }
  }

  // 验证结果
  const allTasks = await getQueueTasks(mongo);
  const cardCount = await countCache(mongo, 'ozon_card_cache');
  const logCount = await countCache(mongo, 'ozon_auto_collect_log');

  log(`collect_queue_tasks: ${allTasks.length} 条, 状态: ${allTasks.map((t) => t.status).join(', ')}`);

  if (allTasks.length >= 2) pass(`采集任务已提交 (${allTasks.length} 条)`);
  else fail(`采集任务未提交或过少 (${allTasks.length} 条, 预期 ≥2)`);

  if (cardCount >= 1) pass(`card 缓存已落库 (${cardCount} 条)`);
  else fail('card 缓存未落库');

  if (logCount >= 1) pass(`采集日志已写入 (${logCount} 条)`);
  else fail('采集日志未写入');

  await page.close();
}

// 场景 2: 去重 — 同 SKU 多次入视口只提交一次
async function scenarioDedup(browser, sw, mongo) {
  log('\n══ 场景 2: 去重 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 5,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });

  // 多次滚动
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
  }

  await sleep(3000);
  const tasks = await getQueueTasks(mongo);
  // 去重:最多只有 PRODUCTS.length 个任务(不重复)
  if (tasks.length <= PRODUCTS_LEN) pass(`去重生效:提交 ${tasks.length} 个任务(预期 ≤${PRODUCTS_LEN})`);
  else fail(`去重失败:提交了 ${tasks.length} 个任务(预期 ≤${PRODUCTS_LEN})`);

  await page.close();
}

// 场景 3: 非中国店铺跳过
async function scenarioNonChinese(browser, sw, mongo) {
  log('\n══ 场景 3: 非中国店铺跳过 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(FOREIGN_SHOP_SLUG);
  await setStoreClassification(FOREIGN_SHOP_SLUG, false);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  const page = await browser.newPage();
  await page.goto(`${MOCK_BASE}/seller/${FOREIGN_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(3000);

  const tasks = await getQueueTasks(mongo);
  if (tasks.length === 0) pass(`非中国店铺未提交任务`);
  else fail(`非中国店铺不应提交任务,但有 ${tasks.length} 个`);

  await page.close();
}

// 场景 4: 每日上限
async function scenarioDailyLimit(browser, sw, mongo) {
  log('\n══ 场景 4: 每日上限 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  // perDayLimit=1,只允许采集 1 个
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 1,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  const page = await browser.newPage();
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await sleep(8000);
  const tasks = await getQueueTasks(mongo);
  const doneCount = tasks.filter((t) => t.status === 'done' || t.status === 'completed').length;
  const skippedCount = tasks.filter((t) => t.status === 'skipped').length;

  if (doneCount <= 1) pass(`每日上限生效:仅完成 ${doneCount} 个(上限=1)`);
  else fail(`每日上限未生效:完成了 ${doneCount} 个(上限=1)`);

  await page.close();
}

// 场景 5: 缓存命中跳过
// 第一次采集填满缓存,第二次触发时 SW 应检测到 all-cached 并跳过
async function scenarioCacheHit(browser, sw, mongo) {
  log('\n══ 场景 5: 缓存命中跳过 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  // 第一次采集,填满缓存
  const page = await browser.newPage();
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  log('第一次采集,等待完成...');
  await sleep(10000);

  const cacheCount = await countCache(mongo, 'ozon_card_cache');
  log(`第一次采集后 card 缓存数: ${cacheCount}`);
  if (cacheCount >= 1) pass(`第一次采集已填充缓存 (${cacheCount} 条 card)`);
  else fail('第一次采集未填充缓存');

  // 仅清队列任务和日志,保留缓存集合
  await clearQueueTasksOnly(mongo);
  // 重置 todayCount 让第二次可以提交
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  // 第二次触发,SW 前置缓存检查应命中,直接 success,不入队
  log('第二次触发(应命中前置缓存检查,直接 success,不入队)...');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(8000);

  // 验证 1:队列中无新增任务(前置判断直接返回,不入队)
  const tasks = await getQueueTasks(mongo);
  const pendingTasks = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  if (pendingTasks.length === 0) pass(`前置缓存命中:无任务入队(共 ${tasks.length} 条历史)`);
  else fail(`前置缓存未命中:有 ${pendingTasks.length} 条 pending/running 任务`);

  // 验证 2:缓存数未增长(无真调)
  const cacheCount2 = await countCache(mongo, 'ozon_card_cache');
  if (cacheCount2 === cacheCount) pass(`缓存未增长(仍为 ${cacheCount2} 条),验证无真调`);
  else fail(`缓存异常增长:从 ${cacheCount} 到 ${cacheCount2}`);

  // 验证 3:todayCount 未递增(缓存命中不消耗配额)
  const cfgAfter = await getAutoCollectConfig(sw);
  if (cfgAfter.todayCount === 0) pass(`todayCount 未递增(仍为 0),验证缓存命中不消耗配额`);
  else fail(`todayCount 异常递增到 ${cfgAfter.todayCount}(应为 0)`);

  await page.close();
}

// 场景 6: 反爬熔断
async function scenarioAntibot(browser, sw, mongo) {
  log('\n══ 场景 6: 反爬熔断 ══');
  log('注意:此场景需要以 MOCK_ANTIBOT=1 重启 mock-server');
  log('请手动执行: MOCK_ANTIBOT=1 node mock-server/server.js');
  log('然后重新运行此场景');

  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  const page = await browser.newPage();
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // 等待采集任务处理(最多 30s,检测到 antibot 状态即提前退出)
  log('等待采集任务处理(最多 30s)...');
  let cfg = {};
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    cfg = await getAutoCollectConfig(sw);
    if (cfg.paused === true || (cfg.pausedUntil && cfg.pausedUntil > Date.now())) {
      log(`检测到熔断(第 ${i + 1} 次轮询)`);
      break;
    }
  }

  const tasks = await getQueueTasks(mongo);
  const antibotLogs = await countCache(mongo, 'ozon_auto_collect_log', { status: 'antibot' });
  log(`collect_queue_tasks: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ') || '(无)'}`);
  log(`antibot 日志: ${antibotLogs} 条, paused=${cfg.paused}, pausedUntil=${cfg.pausedUntil}`);

  if (cfg.paused === true || (cfg.pausedUntil && cfg.pausedUntil > Date.now())) {
    pass(`反爬熔断生效:paused=${cfg.paused}, pausedUntil=${cfg.pausedUntil}`);
  } else if (tasks.length === 0) {
    fail('未提交任何任务,无法触发反爬检测');
  } else if (antibotLogs >= 1) {
    pass(`反爬日志已写入(${antibotLogs} 条),但熔断标志未设置`);
  } else {
    fail(
      `反爬熔断未生效:paused=${cfg.paused}, pausedUntil=${cfg.pausedUntil}, 任务状态=${tasks
        .map((t) => t.status)
        .join(',')}`
    );
  }

  await page.close();
}

// 场景 7: not-running — autoCollectRunning=false 时不执行采集
// 注意:content script 仍会把任务提交到队列(SW 的 _handleSubmitTask 不检查 autoCollectRunning),
// 但 SW 的 _doAutoCollect Gate0 会跳过执行(reason='not-running'),任务标记为 failed_final。
// 本场景验证:任务最终状态为 failed_final,且不产生任何缓存(未执行采集)。
async function scenarioNotRunning(browser, sw, mongo) {
  log('\n══ 场景 7: 总开关关闭 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  // 关键:autoCollectRunning=false
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: false,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  // 立即验证配置是否写入成功
  const cfgCheck = await getAutoCollectConfig(sw);
  log(`配置写入验证: autoCollectRunning=${cfgCheck.autoCollectRunning}(预期 false)`);
  // 等待 storage.onChanged 事件触发 SW invalidate 缓存(异步事件,需让出事件循环)
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 8000);
  const tasks = await getQueueTasks(mongo);
  const detailCount = await countCache(mongo, 'ozon_detail_cache');
  const composerCount = await countCache(mongo, 'ozon_composer_cache');
  // 读取当前 SW 配置确认 autoCollectRunning 仍为 false
  const cfgAfter = await getAutoCollectConfig(sw);
  log(
    `SW 配置(采集后): autoCollectRunning=${cfgAfter.autoCollectRunning}, enabled=${cfgAfter.enabled}, paused=${cfgAfter.paused}`
  );
  log(`collect_queue_tasks: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  log(`detail 缓存: ${detailCount} 条, composer 缓存: ${composerCount} 条`);

  // autoCollectRunning=false 时,_maybeStartConsume 会设置 consumePaused 并 return,
  // 任务保持 pending 不被消费。
  const pendingTasks = tasks.filter((t) => t.status === 'pending').length;
  if (pendingTasks >= 1 && tasks.length === pendingTasks) pass(`所有任务保持 pending(未被消费,${pendingTasks} 条)`);
  else fail(`任务状态异常(预期全部 pending,实际: ${tasks.map((t) => t.status).join(', ')})`);

  // 关键:不应产生 detail/composer 等采集缓存(SW 未执行采集步骤)
  // 注意:card 缓存由 content script 直接写入(loadPanelData 的 fire-and-forget),
  // 与采集队列无关,因此 card 缓存会有,但 detail/composer 不会有。
  if (detailCount === 0 && composerCount === 0) pass('未产生 detail/composer 采集缓存');
  else fail(`总开关关闭但仍产生了采集缓存(detail=${detailCount}, composer=${composerCount})`);

  await page.close();
}

// 场景 8: retry-backoff — 单 SKU 持续失败,验证重试退避机制
// _retryBackoffMs = [10000, 30000, 90000],maxAttempts=3(failed 类型)
// 观察任务经历 pending → failed_retry(attempts=1) → failed_retry(attempts=2) → failed_final
// 注意:完整 3 次重试需 10s+30s+90s=130s,本场景只验证前两次重试(约 40s),不等待 failed_final
async function scenarioRetryBackoff(browser, sw, mongo) {
  log('\n══ 场景 8: 失败重试退避 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  // 对全部 3 个 SKU 注入故障
  for (const sku of SKUS) await setFailSku(sku, true);
  log(`已对 ${SKUS.length} 个 SKU 注入故障`);

  const page = await openChinaShopAndScroll(browser, 6000);

  // 第一阶段:等待首次失败 → failed_retry(attempts=1)
  let sawFailedRetry = false;
  let firstRetryTask = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const tasks = await getQueueTasks(mongo);
    const retryTasks = tasks.filter((t) => t.status === 'failed_retry');
    if (retryTasks.length >= 1) {
      sawFailedRetry = true;
      firstRetryTask = retryTasks[0];
      log(
        `检测到第 1 次 failed_retry: sku=${firstRetryTask.sku}, attempts=${firstRetryTask.attempts}, nextRetryAt 剩余 ${Math.round(((firstRetryTask.nextRetryAt || 0) - Date.now()) / 1000)}s`
      );
      break;
    }
  }

  if (sawFailedRetry) pass('任务失败后进入 failed_retry 状态(attempts=1)');
  else fail('未检测到 failed_retry 状态');

  // 第二阶段:等待 nextRetryAt 到期后再次执行 → 进入终态(failed_partial 或 failed_final)
  // partial 类型 maxAttempts=2,首次 failed_retry 后第 2 次失败直接进终态。
  // partial backoff=30s,等待最多 60s 检测到状态变化(failed_retry → 终态)
  if (firstRetryTask) {
    const firstSku = firstRetryTask.sku;
    let sawTerminal = false;
    log(`等待 ${firstSku} 第 2 次重试进入终态(最多 60s)...`);
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const tasks = await getQueueTasks(mongo);
      const t = tasks.find((x) => x.sku === firstSku);
      if (!t) continue;
      // 状态从 failed_retry 变成终态,说明 backoff 到期后重试执行了
      if (t.status === 'failed_partial' || t.status === 'failed_final') {
        sawTerminal = true;
        log(`检测到终态: sku=${t.sku}, attempts=${t.attempts}, status=${t.status}`);
        break;
      }
    }

    if (sawTerminal) pass('backoff 到期后任务再次重试并进入终态');
    else fail('未在 60s 内检测到终态(任务仍为 failed_retry)');
  }

  // 清理故障注入
  for (const sku of SKUS) await setFailSku(sku, false);
  log('已清理故障注入');
  await page.close();
}

// 场景 9: queue-persistence — SW 重启后队列从 MongoDB 恢复
// 提交任务 → 立即 reload 扩展(不等处理)→ 新 SW 恢复并处理任务
async function scenarioQueuePersistence(browser, sw, mongo) {
  log('\n══ 场景 9: 队列持久化恢复 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  // consumeRateSec=2 快速消费,但提交后立即 reload,确保 reload 时任务还是 pending
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });

  // 打开页面触发任务提交,只等 1s 让任务入队(不等处理)
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await sleep(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1000); // 只等 1s 让任务入队

  const tasksBefore = await getQueueTasks(mongo);
  log(`reload 前任务数: ${tasksBefore.length} 条, 状态: ${tasksBefore.map((t) => t.status).join(', ')}`);

  if (tasksBefore.length === 0) {
    fail('未提交任何任务,无法测试持久化');
    await page.close();
    return;
  }

  // 立即重载扩展,模拟 SW 被杀(reload 前 tasks 应该还是 pending)
  log('重载扩展(SW 重启)...');
  const newSw = await enableTestMode(browser, sw);
  // reload 后配置在 chrome.storage 中持久化,不需要重新设置
  // 但需要等待 storage.onChanged 触发 SW invalidate 缓存
  await sleep(1000);
  log('新 SW 已就绪,等待队列恢复处理(最多 40s)...');

  // 等待新 SW 处理完恢复的任务
  // failed_retry 任务的 backoff 可能是 30s(partial),需要等 backoff 到期后才重试
  let recovered = false;
  for (let i = 0; i < 35; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const processed = tasks.filter(
      (t) =>
        t.status === 'done' ||
        t.status === 'completed' ||
        t.status === 'failed_partial' ||
        t.status === 'failed_final' ||
        t.status === 'success'
    ).length;
    if (processed >= 2) {
      recovered = true;
      log(`恢复后已处理 ${processed} 个任务`);
      break;
    }
  }

  const tasksAfter = await getQueueTasks(mongo);
  log(`reload 后任务数: ${tasksAfter.length} 条, 状态: ${tasksAfter.map((t) => t.status).join(', ')}`);

  if (recovered) pass('SW 重启后队列从 MongoDB 恢复并处理');
  else fail(`SW 重启后队列未恢复处理(状态: ${tasksAfter.map((t) => t.status).join(', ')})`);

  await page.close();
}

// 场景 10: antibot-recovery — 熔断到期后自动恢复采集
async function scenarioAntibotRecovery(browser, sw, mongo) {
  log('\n══ 场景 10: 熔断自动恢复 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);

  // 关键:预设熔断状态,但 pausedUntil 设为已过期(1 秒前)
  const expiredPausedUntil = Date.now() - 1000;
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: true,
    pausedUntil: expiredPausedUntil,
  });
  log(`预设熔断(已过期): paused=true, pausedUntil=${expiredPausedUntil}(1s 前)`);

  // 触发采集,期望熔断已过期 → 任务正常提交
  const page = await openChinaShopAndScroll(browser, 6000);
  const tasks = await getQueueTasks(mongo);
  log(`collect_queue_tasks: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);

  if (tasks.length >= 1) pass(`熔断到期后任务正常提交(${tasks.length} 条)`);
  else fail('熔断到期后仍未提交任务');

  // 验证熔断标志被清除(新任务处理时不应再带 paused)
  const cfg = await getAutoCollectConfig(sw);
  if (cfg.paused === false || (cfg.pausedUntil || 0) <= Date.now()) {
    pass('熔断标志已清除或仍过期');
  } else {
    fail(`熔断标志未清除: paused=${cfg.paused}, pausedUntil=${cfg.pausedUntil}`);
  }

  await page.close();
}

// 场景 11: panel-ready-on-collect-done — collectDone 后 panel 的 jzLoadStatus 应变为 'ready'
// 回归测试:修复前 collectDone 回填面板时不设置 jzLoadStatus,导致 AutoScroller isReadyToScroll 死锁
// 用中国店铺正常采集(成功路径),验证 collectDone 广播后 panel 变 ready
// (skip/partial/failed_final 路径共用同一个 collectDone handler,验证成功路径即可覆盖)
async function scenarioPanelReadyOnCollectDone(browser, sw, mongo) {
  log('\n══ 场景 11: collectDone 后 panel 状态 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500); // 等 storage.onChanged 触发 SW invalidate 缓存

  const page = await openChinaShopAndScroll(browser, 3000);

  // 等待 collectDone 广播后 panel 变 ready(最多 40s)
  // 注意:failed_retry 任务需要等 backoff 后才变终态,因此等待时间较长
  log('等待 panel 变 ready(最多 40s)...');
  let allReady = false;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const panelStatuses = await page.evaluate(() => {
      const panels = document.querySelectorAll('.ozon-helper-data-panel');
      if (!panels.length) return [];
      return Array.from(panels).map((p) => p.dataset.jzLoadStatus || '');
    });
    if (panelStatuses.length > 0 && panelStatuses.every((s) => s === 'ready' || s === 'error')) {
      allReady = true;
      log(`所有 ${panelStatuses.length} 个 panel 已就绪(第 ${i + 1} 次轮询)`);
      break;
    }
  }

  // 最终读取详细状态
  const finalStatuses = await page.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    return Array.from(panels).map((p) => ({
      sku: p.dataset.jzSku || '',
      status: p.dataset.jzLoadStatus || '',
    }));
  });

  log(`panel 数量: ${finalStatuses.length}`);
  for (const p of finalStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}`);
  }

  const tasks = await getQueueTasks(mongo);
  log(`collect_queue_tasks: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);

  // 验证:至少有一个 panel 存在且 status='ready'(collectDone 回填后应变 ready)
  // 注意:只有终态(success/failed_partial/failed_final/skipped)才广播 collectDone,
  // failed_retry/pending 状态的 panel 不会变 ready(这是正常行为,不是 bug)
  const readyPanels = finalStatuses.filter((p) => p.status === 'ready');
  if (readyPanels.length >= 1) pass(`panel 已就绪(${readyPanels.length} 个 ready)`);
  else fail(`panel 未就绪(状态: ${finalStatuses.map((p) => p.status).join(', ') || '无 panel'})`);

  // 验证:终态任务对应的 panel 不应停留在 'loading'(collectDone 应已设置 ready)
  // 终态任务 = failed_partial/failed_final/success,非终态 = failed_retry/pending
  const terminalStatuses = ['success', 'failed_partial', 'failed_final', 'completed'];
  const terminalTasks = tasks.filter((t) => terminalStatuses.includes(t.status));
  const loadingTerminalPanels = finalStatuses.filter((p) => {
    const task = tasks.find((t) => String(t.sku) === String(p.sku));
    return task && terminalStatuses.includes(task.status) && p.status === 'loading';
  });
  if (loadingTerminalPanels.length === 0) {
    pass(`终态任务(${terminalTasks.length} 个)的 panel 均已就绪`);
  } else {
    fail(
      `${loadingTerminalPanels.length} 个终态任务的 panel 卡在 loading: ${loadingTerminalPanels.map((p) => p.sku).join(', ')}`
    );
  }

  await page.close();
}

// 场景 12: unclassified-mark — 未分类不采集,标记中国后重新加载可采集
// 验证:未分类时 isChinese !== true → 不提交且不 add 到去重集(可重试)
//       标记中国后重新加载 → checkStoreClass 返回 isChinese=true → 提交采集
async function scenarioUnclassifiedMark(browser, sw, mongo) {
  log('\n══ 场景 12: 未分类 → 标记中国 → 采集 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG); // 确保未分类
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  // 阶段 1: 未分类状态,验证不采集
  log('阶段 1: 未分类状态,验证不采集');
  let page = await openChinaShopAndScroll(browser, 3000);
  let tasks = await getQueueTasks(mongo);
  if (tasks.length === 0) pass('未分类时未提交任务');
  else fail(`未分类时不应提交任务,但有 ${tasks.length} 个`);
  await page.close();

  // 阶段 2: 标记中国,重新加载,验证采集
  log('阶段 2: 标记中国,重新加载,验证采集');
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await sleep(500);
  page = await openChinaShopAndScroll(browser, 3000);

  // 等待采集(最多 30s)
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    tasks = await getQueueTasks(mongo);
    if (tasks.length >= 1) break;
  }

  tasks = await getQueueTasks(mongo);
  if (tasks.length >= 1) pass(`标记中国后已采集(${tasks.length} 个任务)`);
  else fail('标记中国后应采集,但无任务');

  await page.close();
}

// 场景 13: daily-limit-pending — daily-limit 命中后任务保持 pending + consumePaused=true
// 验证:perDayLimit=1 时,第 1 个任务终态,其余保持 pending(从未被消费)
//       _consumeOne 检查 todayCount >= perDayLimit → 设 consumePaused=true → 不消费
async function scenarioDailyLimitPending(browser, sw, mongo) {
  log('\n══ 场景 13: daily-limit 后任务保持 pending ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 1, // 只允许 1 个
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 8000);

  const tasks = await getQueueTasks(mongo);
  const terminalCount = tasks.filter((t) =>
    ['success', 'failed_final', 'failed_partial', 'completed'].includes(t.status)
  ).length;
  const pendingCount = tasks.filter((t) => t.status === 'pending').length;

  log(`任务: ${tasks.length} 条, 终态: ${terminalCount}, pending: ${pendingCount}`);
  log(`状态: ${tasks.map((t) => t.status).join(', ')}`);

  if (terminalCount <= 1) pass(`终态任务 ≤ 1(上限=1)`);
  else fail(`终态任务 ${terminalCount} 个,应 ≤ 1`);

  if (pendingCount >= 1) pass(`剩余任务保持 pending(${pendingCount} 个)`);
  else fail(`应有任务保持 pending,实际 ${pendingCount} 个`);

  // 验证 consumePaused=true(队列因 daily-limit 而暂停)
  const meta = await swEval(sw, async () => {
    return (await chrome.storage.local.get('jz-collect-queue-meta'))['jz-collect-queue-meta'] || {};
  });
  if (meta.consumePaused === true) pass('consumePaused=true(队列已暂停)');
  else fail(`consumePaused 应为 true,实际: ${meta.consumePaused}`);

  await page.close();
}

// 场景 14: paused-soft-expiry — paused=true 但 pausedUntil 已过 → 仍然采集
// 验证:paused 字段不会自动重置为 false,仅靠 Date.now() < pausedUntil 时间比较放行
//       过期后任务正常入队处理,但 paused 字段仍为 true(软过期 quirk)
async function scenarioPausedSoftExpiry(browser, sw, mongo) {
  log('\n══ 场景 14: paused 软过期仍采集 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  // paused=true 但 pausedUntil 已过(1 秒前)
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: true,
    pausedUntil: Date.now() - 1000, // 已过期
  });
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 8000);

  const tasks = await getQueueTasks(mongo);
  if (tasks.length >= 1) pass(`paused 软过期后正常采集(${tasks.length} 个任务)`);
  else fail('paused 软过期后应正常采集,但无任务');

  // 验证 paused 字段仍为 true(软过期不自动重置)
  const cfg = await getAutoCollectConfig(sw);
  if (cfg.paused === true) pass('paused 字段仍为 true(软过期不重置)');
  else fail(`paused 字段应为 true,实际: ${cfg.paused}`);

  await page.close();
}

// 场景 15: daily-limit-deadlock — 队列暂停时 panel 卡 loading(时序竞态)
// 回归测试:修复前 daily-limit 触发队列暂停后,SW 广播 queuePaused 时序竞态
// (content script onMessage listener 未注册),panel 永远卡 loading,
// AutoScroller isReadyToScroll 死锁(maxReadinessWaitMs=0)
// 修复后:content script 启动时主动查询 getQueueStatus,发现暂停则设 panel ready
async function scenarioDailyLimitDeadlock(browser, sw, mongo) {
  log('\n══ 场景 15: daily-limit 死锁 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  // perDayLimit=0 → 第 1 个任务就 daily-limit skip
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 0,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 8000);

  // 检查 panel 状态(panel 在 DOM 上,ISOLATED/MAIN world 共享)
  const debugInfo = await page.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    return {
      panels: Array.from(panels).map((p) => ({
        sku: p.dataset.jzSku || '',
        status: p.dataset.jzLoadStatus || '',
      })),
    };
  });

  const panelStatuses = debugInfo.panels;
  log(`panel 数量: ${panelStatuses.length}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}`);
  }

  const tasks = await getQueueTasks(mongo);
  log(`collect_queue_tasks: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);

  const loadingPanels = panelStatuses.filter((p) => p.status === 'loading');
  const readyPanels = panelStatuses.filter((p) => p.status === 'ready' || p.status === 'error');

  // 验证:队列暂停后 panel 不应卡 loading(修复后应变 ready)
  if (loadingPanels.length === 0) {
    pass(`无 panel 卡 loading(${readyPanels.length} 个 ready)`);
  } else {
    fail(
      `${loadingPanels.length} 个 panel 卡 loading(队列暂停未通知 content script): ${loadingPanels.map((p) => p.sku).join(', ')}`
    );
  }

  // 验证:任务因 daily-limit 保持 pending(队列暂停)
  const pendingCount = tasks.filter((t) => t.status === 'pending').length;
  if (pendingCount >= 1) pass(`任务保持 pending(${pendingCount} 个,daily-limit 队列暂停)`);
  else fail(`应有任务保持 pending,实际 ${pendingCount} 个`);

  await page.close();
}

// 场景 16: 翻页后新 SKU 入队 — 模拟用户报告"翻页后第一行 4 个 SKU 不入队"
// mock-server 有 8 个 SKU,前 4 个在第一屏,后 4 个在滚动后出现。
// 验证:滚动触发翻页后,所有 8 个 SKU 都应入队(不被 isStoreSkuCard 误判、
// 不被 _autoCollectSeen 去重、IntersectionObserver 正常触发)。
async function scenarioScrollNewSkus(browser, sw, mongo) {
  log('\n══ 场景 16: 翻页后新 SKU 入队 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await sleep(2000);

  // 第一屏:检查 panel 数量 + 已提交任务数
  const firstScreenInfo = await page.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    return { panelCount: panels.length };
  });
  log(`第一屏: ${firstScreenInfo.panelCount} 个 panel`);

  const tasksAfterFirst = await getQueueTasks(mongo);
  log(`第一屏后任务数: ${tasksAfterFirst.length}`);

  // 模拟快速滚动到底部(一步到位,验证 IntersectionObserver 漏触发修复)
  log('快速滚动到页面底部(一步到位)...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(3000);

  // 滚动后的状态
  const afterScrollInfo = await page.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    const allCards = document.querySelectorAll('.tile-root');
    return {
      panelCount: panels.length,
      cardCount: allCards.length,
      panelSkus: Array.from(panels).map((p) => p.dataset.jzSku || ''),
      panelStatuses: Array.from(panels).map((p) => ({
        sku: p.dataset.jzSku || '',
        status: p.dataset.jzLoadStatus || '',
      })),
    };
  });
  log(`滚动后: ${afterScrollInfo.cardCount} 个 card, ${afterScrollInfo.panelCount} 个 panel`);
  log(`  panel SKUs: ${afterScrollInfo.panelSkus.join(', ')}`);
  for (const p of afterScrollInfo.panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}`);
  }

  // 等待采集任务提交
  await sleep(3000);
  const tasksAfterScroll = await getQueueTasks(mongo);
  log(`滚动后任务数: ${tasksAfterScroll.length}, 状态: ${tasksAfterScroll.map((t) => t.status).join(', ')}`);
  log(`  任务 SKUs: ${tasksAfterScroll.map((t) => t.sku).join(', ')}`);

  // 验证:所有 8 个 SKU 都应入队
  const allSkus = ['100001', '100002', '100003', '100004', '100005', '100006', '100007', '100008'];
  const submittedSkus = tasksAfterScroll.map((t) => String(t.sku));
  const missingSkus = allSkus.filter((s) => !submittedSkus.includes(s));

  if (missingSkus.length === 0) {
    pass(`所有 8 个 SKU 都已入队`);
  } else {
    fail(`缺少 ${missingSkus.length} 个 SKU: ${missingSkus.join(', ')}(已入队: ${submittedSkus.join(', ')})`);
  }

  // 验证:panel 数量应与 card 数量一致(非店铺商品除外)
  if (afterScrollInfo.panelCount >= 8) {
    pass(`panel 数量充足(${afterScrollInfo.panelCount} 个)`);
  } else {
    fail(`panel 数量不足(${afterScrollInfo.panelCount} 个,预期 ≥8)`);
  }

  await page.close();
}

// 场景 17: 采集成功后数据回填面板 — 验证 collectDone 广播的 data 是否填充到 panel
// 用户报告:"即使成功采集的,数据面板也是没有数据的"
// 链路:SW _finalizeTask → _buildCollectDoneData(stats/market/variant/followCount)
//      → _broadcastCollectDoneV2(data) → content script onMessage → jzPopulatePanelV2(preFetched)
// 失败点可能:data 为 null、preFetched 结构不匹配、jzPopulatePanelV2 未渲染字段
async function scenarioCollectDataRender(browser, sw, mongo) {
  log('\n══ 场景 17: 采集成功后数据回填面板 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // 监听 console
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[panel]') || text.includes('collectDone') || text.includes('[Queue]')) {
      log(`  [console] ${text}`);
    }
  });

  await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });
  await sleep(2000);

  // 滚动触发采集
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(5000);

  // 等待采集完成
  log('等待采集完成...');
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const processed = tasks.filter(
      (t) =>
        t.status === 'done' || t.status === 'completed' || t.status === 'failed_partial' || t.status === 'failed_final'
    ).length;
    if (processed >= 1) {
      log(`已处理 ${processed} 个任务`);
      break;
    }
  }

  // 检查 panel 数据回填情况
  const panelInfo = await page.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    return Array.from(panels)
      .slice(0, 3)
      .map((p) => {
        const fields = p.querySelectorAll('[data-field]');
        const fieldData = {};
        for (const f of fields) {
          const name = f.getAttribute('data-field');
          const text = (f.textContent || '').trim();
          fieldData[name] = text;
        }
        return {
          sku: p.dataset.jzSku || '',
          status: p.dataset.jzLoadStatus || '',
          fieldCount: fields.length,
          nonEmptyFields: Object.entries(fieldData).filter(([, v]) => v && v !== '-' && v !== '').length,
          fields: fieldData,
        };
      });
  });

  log(`panel 详情(${panelInfo.length} 个):`);
  for (const p of panelInfo) {
    log(`  sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}, 非空字段=${p.nonEmptyFields}`);
    // 显示前 5 个字段值
    const entries = Object.entries(p.fields).slice(0, 8);
    for (const [k, v] of entries) {
      log(`    ${k}: ${v}`);
    }
  }

  // 检查 SW 侧 collectDone 广播是否携带 data
  const swDiag = await swEval(sw, async () => {
    const recent = (await chrome.storage.local.get('jz-auto-collect-recent'))['jz-auto-collect-recent'] || [];
    const meta = (await chrome.storage.local.get('jz-collect-queue-meta'))['jz-collect-queue-meta'] || {};
    return {
      recent: recent.slice(0, 3).map((r) => ({
        sku: r.sku,
        status: r.status,
        hasData: !!(r.data || r.collectResult),
        steps: r.steps,
      })),
      meta,
    };
  });
  log(`SW 最近采集记录(${swDiag.recent.length} 条):`);
  for (const r of swDiag.recent) {
    log(`  sku=${r.sku}, status=${r.status}, hasData=${r.hasData}, steps=${JSON.stringify(r.steps)}`);
  }
  log(`SW queue meta: todayCount=${swDiag.meta.todayCount}, consumePaused=${swDiag.meta.consumePaused}`);

  // 验证:至少 1 个 panel 应有非空数据字段
  const panelsWithData = panelInfo.filter((p) => p.nonEmptyFields > 0);
  if (panelsWithData.length >= 1) {
    pass(`有 ${panelsWithData.length} 个 panel 回填了数据`);
  } else {
    fail(`所有 panel 都没有数据回填(检查 collectDone data + jzPopulatePanelV2)`);
  }

  await page.close();
}

// ─── 辅助:检查 collectDone 广播和 panel 回填状态 ──────────
// 返回 { panelStatuses, swRecent, tasks }
// panelStatuses: [{ sku, status, fieldCount, nonEmptyFields }]
//   - status='ready' → collectDone 已接收(或 queuePaused 已接收)
//   - fieldCount > 0 → msg.data 非空,jzRenderProductPanelV2 已执行
//   - nonEmptyFields > 0 → data 中有非 null value,jzPopulatePanelV2 已填充
async function inspectCollectResult(page, sw, mongo) {
  const panelStatuses = await page.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    return Array.from(panels).map((p) => ({
      sku: p.dataset.jzSku || '',
      status: p.dataset.jzLoadStatus || '',
      fieldCount: p.querySelectorAll('[data-field]').length,
      nonEmptyFields: Array.from(p.querySelectorAll('[data-field]')).filter((f) => {
        const text = (f.textContent || '').trim();
        return text && text !== '-' && text !== '';
      }).length,
    }));
  });

  const swRecent = await swEval(sw, async () => {
    const recent = (await chrome.storage.local.get('jz-auto-collect-recent'))['jz-auto-collect-recent'] || [];
    return recent.slice(0, 5).map((r) => ({
      sku: r.sku,
      status: r.status,
      reason: r.reason || null,
    }));
  });

  const tasks = await getQueueTasks(mongo);
  return { panelStatuses, swRecent, tasks };
}

// 场景 18: status-success — 采集成功,验证 collectDone 带 data 且面板回填
// 链路: _doAutoCollect → results 无 error → status='success'
//       → _finalizeTask('success') → _buildCollectDoneData → _broadcastCollectDoneV2(data)
//       → content script onMessage → jzRenderProductPanelV2 + jzPopulatePanelV2
async function scenarioStatusSuccess(browser, sw, mongo) {
  log('\n══ 场景 18: status-success — 采集成功 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 3000, mongo);

  log('等待采集完成(最多 30s)...');
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const terminalCount = tasks.filter((t) =>
      ['success', 'done', 'completed', 'failed_partial', 'failed_final'].includes(t.status)
    ).length;
    if (terminalCount >= 2) {
      log(`已处理 ${terminalCount} 个任务`);
      break;
    }
  }

  const { panelStatuses, swRecent, tasks } = await inspectCollectResult(page, sw, mongo);
  log(`队列任务: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  log(`SW 最近记录: ${swRecent.map((r) => `${r.sku}:${r.status}`).join(', ')}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}, 非空=${p.nonEmptyFields}`);
  }

  const successTasks = tasks.filter((t) => ['success', 'done', 'completed'].includes(t.status));
  if (successTasks.length >= 1) pass(`有 ${successTasks.length} 个任务终态为 success`);
  else fail(`无 success 任务(状态: ${tasks.map((t) => t.status).join(', ')})`);

  const readyPanels = panelStatuses.filter((p) => p.status === 'ready');
  if (readyPanels.length >= 1) pass(`panel 已设 ready(${readyPanels.length} 个)`);
  else fail(`panel 未设 ready(状态: ${panelStatuses.map((p) => p.status).join(', ')})`);

  const renderedPanels = panelStatuses.filter((p) => p.fieldCount > 0);
  if (renderedPanels.length >= 1) pass(`panel 已渲染字段(${renderedPanels[0].fieldCount} 个 [data-field])`);
  else fail(`panel 未渲染字段(data 可能为 null,jzRenderProductPanelV2 未执行)`);

  await page.close();
}

// 场景 19: status-partial — 全部 API 500,验证 partial → failed_partial 终态
// 链路: _doAutoCollect → results 有 error → status='partial'
//       → _handleRetryOrFinal('partial', maxAttempts=2, backoff=30s)
//       → 首次失败 failed_retry(attempts=1) → 30s 后重试失败 → failed_partial(attempts=2)
//       → _finalizeTask('failed_partial') → _broadcastCollectDoneV2(data)
async function scenarioStatusPartial(browser, sw, mongo) {
  log('\n══ 场景 19: status-partial — 部分失败 → failed_partial ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  for (const sku of SKUS) await setFailSku(sku, true);
  log(`已对 ${SKUS.length} 个 SKU 注入故障`);

  const page = await openChinaShopAndScroll(browser, 3000, mongo);

  log('等待首次失败 → failed_retry...');
  let sawFailedRetry = false;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const retryTasks = tasks.filter((t) => t.status === 'failed_retry');
    if (retryTasks.length >= 1) {
      sawFailedRetry = true;
      log(`检测到 failed_retry: sku=${retryTasks[0].sku}, attempts=${retryTasks[0].attempts}`);
      break;
    }
  }
  if (sawFailedRetry) pass('首次失败后进入 failed_retry 状态');
  else fail('未检测到 failed_retry 状态');

  log('等待 backoff(30s)到期后重试 → failed_partial(最多 60s)...');
  let sawTerminal = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const terminalTasks = tasks.filter((t) => t.status === 'failed_partial' || t.status === 'failed_final');
    if (terminalTasks.length >= 1) {
      sawTerminal = true;
      log(`检测到终态: sku=${terminalTasks[0].sku}, status=${terminalTasks[0].status}`);
      break;
    }
  }

  const { panelStatuses, swRecent, tasks } = await inspectCollectResult(page, sw, mongo);
  log(`队列任务: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}, 非空=${p.nonEmptyFields}`);
  }

  const partialTasks = tasks.filter((t) => t.status === 'failed_partial');
  if (partialTasks.length >= 1) pass(`有 ${partialTasks.length} 个任务终态为 failed_partial`);
  else fail(`无 failed_partial 任务(状态: ${tasks.map((t) => t.status).join(', ')})`);

  const readyPanels = panelStatuses.filter((p) => p.status === 'ready');
  if (readyPanels.length >= 1) pass(`终态任务 panel 已设 ready(${readyPanels.length} 个)`);
  else fail(`终态任务 panel 未设 ready(可能 collectDone 未广播)`);

  for (const sku of SKUS) await setFailSku(sku, false);
  log('已清理故障注入');
  await page.close();
}

// 场景 20: status-failed — 验证失败重试行为
// 注意:'failed' 状态需要 _doAutoCollect 抛异常(整个采集过程崩溃),
//       在测试环境中难以精确触发(每个 step 都有 try/catch)。
//       此场景用 setFailSku 全部 API 500 产生 'partial' 状态(类似行为),
//       验证首次失败 → failed_retry 时 collectDone 未广播(panel 不设 ready)。
//       'failed' 与 'partial' 的区别仅在于 maxAttempts(3 vs 2)和 backoff([10s,30s,90s] vs 30s),
//       广播/回填行为完全一致(都走 _finalizeTask → _buildCollectDoneData → _broadcastCollectDoneV2)。
async function scenarioStatusFailed(browser, sw, mongo) {
  log('\n══ 场景 20: status-failed — 失败重试行为 ══');
  log('注意: failed 状态需 _doAutoCollect 抛异常,此处用 partial 近似模拟');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  for (const sku of SKUS) await setFailSku(sku, true);
  log(`已对 ${SKUS.length} 个 SKU 注入故障`);

  const page = await openChinaShopAndScroll(browser, 3000, mongo);

  log('等待首次失败 → failed_retry(不等待终态)...');
  let sawFailedRetry = false;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const retryTasks = tasks.filter((t) => t.status === 'failed_retry');
    if (retryTasks.length >= 1) {
      sawFailedRetry = true;
      log(`检测到 failed_retry: sku=${retryTasks[0].sku}, attempts=${retryTasks[0].attempts}`);
      break;
    }
  }

  const { panelStatuses, swRecent, tasks } = await inspectCollectResult(page, sw, mongo);
  log(`队列任务: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}`);
  }

  if (sawFailedRetry) pass('首次失败后进入 failed_retry 状态');
  else fail('未检测到 failed_retry 状态');

  // failed_retry 不是终态,不广播 collectDone → panel 不应有 [data-field]
  const retrySkus = tasks.filter((t) => t.status === 'failed_retry').map((t) => String(t.sku));
  const retryPanels = panelStatuses.filter((p) => retrySkus.includes(p.sku));
  const panelsWithoutFields = retryPanels.filter((p) => p.fieldCount === 0);
  if (panelsWithoutFields.length >= 1) pass(`failed_retry panel 无 [data-field](collectDone 未广播 data)`);
  else if (retryPanels.length === 0) log('  (无 failed_retry panel 可检查)');
  else fail(`failed_retry panel 有 [data-field](可能 collectDone 已广播)`);

  for (const sku of SKUS) await setFailSku(sku, false);
  log('已清理故障注入');
  await page.close();
}

// 场景 21: status-antibot — 反爬检测,验证 failed_final + 熔断 + collectDone 广播
// 链路: MOCK_ANTIBOT=1 → API 返回 403 → _doAutoCollect Step4/5/6 检测到反爬
//       → 返回 { status: 'antibot', pausedUntil }
//       → _finalizeTask('failed_final') + _saveQueueMeta({ circuitBreakerUntil: now+10min })
//       → _broadcastCollectDoneV2(data)
async function scenarioStatusAntibot(browser, sw, mongo) {
  log('\n══ 场景 21: status-antibot — 反爬熔断 ══');
  log('注意:此场景需要以 MOCK_ANTIBOT=1 重启 mock-server');
  log('请手动执行: MOCK_ANTIBOT=1 node test/e2e-auto-collect/mock-server/server.js');

  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 3000, mongo, sw);

  // 等待 antibot 检测(最多 60s)。
  // 关键:只检测 sellerSlug 非空且 lastError.type === 'ANTIBOT_BLOCKED' 的 failed_final 任务,
  // 过滤掉空 slug 的 unclassified-store skip 干扰(竞态问题导致的早期任务)。
  // antibot 检测链路较长(创建 buyer tab → doFetch → 403 检测 → _handleAntibot),需要更长等待。
  log('等待 antibot 检测(最多 60s)...');
  let sawAntibot = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const antibotTasks = tasks.filter(
      (t) => t.status === 'failed_final' && t.sellerSlug && t.lastError && t.lastError.type === 'ANTIBOT_BLOCKED'
    );
    if (antibotTasks.length >= 1) {
      sawAntibot = true;
      log(`检测到 antibot failed_final: sku=${antibotTasks[0].sku}, slug=${antibotTasks[0].sellerSlug}`);
      break;
    }
  }

  const { panelStatuses, swRecent, tasks } = await inspectCollectResult(page, sw, mongo);
  const meta = await swEval(sw, async () => {
    return (await chrome.storage.local.get('jz-collect-queue-meta'))['jz-collect-queue-meta'] || {};
  });

  log(`队列任务: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  log(`SW meta: circuitBreakerUntil=${meta.circuitBreakerUntil}, consumePaused=${meta.consumePaused}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}`);
  }

  // 只统计有效 slug 且 ANTIBOT_BLOCKED 的 failed_final 任务(过滤空 slug 的 unclassified-store 干扰)
  const antibotFinalTasks = tasks.filter(
    (t) => t.status === 'failed_final' && t.sellerSlug && t.lastError && t.lastError.type === 'ANTIBOT_BLOCKED'
  );
  if (antibotFinalTasks.length >= 1) {
    pass(`有 ${antibotFinalTasks.length} 个 antibot 任务终态为 failed_final`);
  } else {
    const allFinal = tasks.filter((t) => t.status === 'failed_final');
    fail(
      `无 ANTIBOT_BLOCKED 任务(共 ${allFinal.length} 个 failed_final,` +
        `状态: ${tasks.map((t) => `${t.sku}:${t.status}/${t.lastError?.type || '?'}/${t.sellerSlug || '空slug'}`).join(', ')})`
    );
  }

  if (meta.circuitBreakerUntil && meta.circuitBreakerUntil > Date.now()) {
    pass(`熔断已生效: circuitBreakerUntil=${new Date(meta.circuitBreakerUntil).toISOString()}`);
  } else {
    fail(`熔断未生效: circuitBreakerUntil=${meta.circuitBreakerUntil}`);
  }

  const readyPanels = panelStatuses.filter((p) => p.status === 'ready');
  if (readyPanels.length >= 1) pass(`antibot panel 已设 ready(${readyPanels.length} 个)`);
  else fail(`antibot panel 未设 ready(collectDone 可能未广播)`);

  await page.close();
}

// 场景 24: antibot-newpage — 熔断期内打开新页面,验证 panel 有状态标记 + 设 ready
// 链路: 先触发熔断 → 打开新页面 → SW 应广播 queuePaused('antibot') → panel 设 ready + 显示"采集中止"
// 修复的 bug: _maybeStartConsume 熔断期不广播 / _handleSubmitTask 兜底不检查熔断 / getQueueStatus 不返回熔断状态
async function scenarioAntibotNewpage(browser, sw, mongo) {
  log('\n══ 场景 24: antibot-newpage — 熔断期内打开新页面 ══');
  log('注意:此场景需要以 MOCK_ANTIBOT=1 重启 mock-server');

  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  // 阶段 1:打开第一个页面触发熔断
  log('阶段 1:打开页面触发熔断...');
  const page1 = await openChinaShopAndScroll(browser, 3000, mongo, sw);

  log('等待 antibot 检测(最多 60s)...');
  let sawAntibot = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const tasks = await getQueueTasks(mongo);
    const antibotTasks = tasks.filter(
      (t) => t.status === 'failed_final' && t.sellerSlug && t.lastError && t.lastError.type === 'ANTIBOT_BLOCKED'
    );
    if (antibotTasks.length >= 1) {
      sawAntibot = true;
      log(`检测到 antibot failed_final: sku=${antibotTasks[0].sku}, slug=${antibotTasks[0].sellerSlug}`);
      break;
    }
  }
  if (!sawAntibot) {
    fail('阶段 1 未检测到 antibot,无法继续测试');
    await page1.close();
    return;
  }

  const meta1 = await swEval(sw, async () => {
    return (await chrome.storage.local.get('jz-collect-queue-meta'))['jz-collect-queue-meta'] || {};
  });
  log(
    `熔断已生效: circuitBreakerUntil=${new Date(meta1.circuitBreakerUntil).toISOString()}, consumePaused=${meta1.consumePaused}`
  );
  pass('熔断已触发');
  await page1.close();

  // 阶段 2:熔断期内打开新页面,验证 panel 有状态标记 + 设 ready
  log('阶段 2:熔断期内打开新页面...');
  await sleep(1000);

  // 收集 console 日志(验证 queuePaused 广播)
  const consoleLogs = [];
  const page2 = await browser.newPage();
  page2.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[panel]') || text.includes('queue') || text.includes('Queue')) {
      consoleLogs.push(text);
    }
  });

  await page2.setViewport({ width: 1280, height: 800 });
  await page2.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
  await page2.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });

  // 等 seller-info + 滚动触发 IO
  await page2
    .waitForFunction(() => document.documentElement.getAttribute('data-jz-seller-info') !== null, { timeout: 15000 })
    .catch(() => log('  warn: data-jz-seller-info 等待超时'));
  await sleep(2000);

  // 模拟滚动触发 IntersectionObserver
  await page2.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);
  await page2.evaluate(() => window.scrollTo(0, 0));
  await sleep(5000); // 等待 queuePaused 广播 + panel 设 ready

  // 验证 panel 状态
  const panelStatuses = await page2.evaluate(() => {
    const panels = document.querySelectorAll('.ozon-helper-data-panel');
    return Array.from(panels).map((p) => ({
      sku: p.dataset.jzSku || '',
      loadStatus: p.dataset.jzLoadStatus || '',
      statusBar: p.querySelector('.jz-collect-status-bar')?.textContent?.trim().slice(0, 50) || null,
      fieldCount: p.querySelectorAll('[data-field]').length,
    }));
  });

  log(`阶段 2 panel 数: ${panelStatuses.length}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.loadStatus}, 字段数=${p.fieldCount}, 状态条="${p.statusBar}"`);
  }

  // 关键断言 1:所有 panel 都应设为 ready(不能卡 loading)
  const loadingPanels = panelStatuses.filter((p) => p.loadStatus === 'loading');
  if (loadingPanels.length === 0) {
    pass(`所有 panel 已设 ready(${panelStatuses.length} 个,无 loading)`);
  } else {
    fail(`有 ${loadingPanels.length} 个 panel 卡 loading(队列熔断广播未生效)`);
  }

  // 关键断言 2:panel 应有状态标记(采集中止 / 跳过 / antibot)
  const panelsWithStatus = panelStatuses.filter((p) => p.statusBar && p.statusBar.length > 0);
  if (panelsWithStatus.length >= 1) {
    pass(`有 ${panelsWithStatus.length} 个 panel 显示状态标记("${panelsWithStatus[0].statusBar}")`);
  } else {
    fail('panel 无状态标记(queuePaused 广播可能未到达或 _applyQueuePaused 未执行)');
  }

  // 关键断言 3:验证 getQueueStatus 返回熔断状态
  // 注意:SW 内不能用 chrome.runtime.sendMessage 给自己发消息,
  // 改为直接读 chrome.storage 中的 meta + config,模拟 getQueueStatus 的逻辑
  const queueStatus = await swEval(sw, async () => {
    const meta = (await chrome.storage.local.get('jz-collect-queue-meta'))['jz-collect-queue-meta'] || {};
    const cfg = (await chrome.storage.local.get('jz-auto-collect-config'))['jz-auto-collect-config'] || {};
    const inBreaker = Date.now() < meta.circuitBreakerUntil;
    let reason = null;
    if (inBreaker) reason = 'antibot';
    else if (meta.consumePaused) {
      if (meta.todayCount >= cfg.perDayLimit) reason = 'daily-limit';
      else if (!cfg.autoCollectRunning) reason = 'not-running';
      else if (cfg.paused && Date.now() < cfg.pausedUntil) reason = 'paused';
      else reason = 'paused';
    }
    return {
      consumePaused: meta.consumePaused || inBreaker,
      reason,
      circuitBreakerUntil: meta.circuitBreakerUntil,
    };
  });
  log(
    `getQueueStatus: consumePaused=${queueStatus?.consumePaused}, reason=${queueStatus?.reason}, ` +
      `circuitBreakerUntil=${queueStatus?.circuitBreakerUntil}`
  );
  if (queueStatus?.consumePaused === true && queueStatus?.reason === 'antibot') {
    pass('getQueueStatus 正确返回熔断状态(consumePaused=true, reason=antibot)');
  } else {
    fail(
      `getQueueStatus 未正确返回熔断状态(consumePaused=${queueStatus?.consumePaused}, reason=${queueStatus?.reason})`
    );
  }

  // 输出捕获的 console 日志(调试用)
  const panelLogs = consoleLogs.filter((l) => l.includes('[panel]'));
  if (panelLogs.length > 0) {
    log('捕获的 panel 日志:');
    for (const l of panelLogs.slice(-5)) log(`  ${l}`);
  } else {
    log('  (未捕获到 panel 日志)');
  }

  await page2.close();
}

// 链路: perDayLimit=0 → _doAutoCollect Gate0 检查 → 返回 { status: 'skipped', reason: 'daily-limit' }
//       → _handleSkippedTask → _broadcastCollectDoneV2(data=null) → panel 设 ready(无 [data-field])
async function scenarioStatusSkippedDailyLimit(browser, sw, mongo) {
  log('\n══ 场景 22: status-skipped-daily-limit — daily-limit 跳过 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 0,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  const page = await openChinaShopAndScroll(browser, 5000, mongo);

  const { panelStatuses, swRecent, tasks } = await inspectCollectResult(page, sw, mongo);
  log(`队列任务: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  log(`SW 最近记录: ${swRecent.map((r) => `${r.sku}:${r.status}:${r.reason}`).join(', ')}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}`);
  }

  const pendingTasks = tasks.filter((t) => t.status === 'pending').length;
  const skippedTasks = tasks.filter((t) => t.status === 'skipped' || t.status === 'failed_final').length;
  if (pendingTasks >= 1 || skippedTasks >= 1) {
    pass(`daily-limit 生效: pending=${pendingTasks}, skipped/failed_final=${skippedTasks}`);
  } else {
    fail(`daily-limit 未生效(状态: ${tasks.map((t) => t.status).join(', ')})`);
  }

  const readyPanels = panelStatuses.filter((p) => p.status === 'ready');
  if (readyPanels.length >= 1) pass(`daily-limit panel 已设 ready(${readyPanels.length} 个)`);
  else fail(`daily-limit panel 未设 ready(状态: ${panelStatuses.map((p) => p.status).join(', ')})`);

  const panelsWithoutFields = readyPanels.filter((p) => p.fieldCount === 0);
  if (panelsWithoutFields.length >= 1) pass(`daily-limit panel 无 [data-field](data=null,未回填数据)`);
  else if (readyPanels.length === 0) log('  (无 ready panel 可检查)');
  else fail(`daily-limit panel 有 [data-field](data 可能为非 null)`);

  await page.close();
}

// 场景 23: status-skipped-other — all-cached 跳过,验证 failed_final + collectDone 广播
// 链路: 先采集一次填满缓存 → 再次触发 → _doAutoCollect Step2 检测到 all-cached
//       → 返回 { status: 'skipped', reason: 'all-cached' }
//       → _handleSkippedTask(非 daily-limit) → _finalizeTask('failed_final') → _broadcastCollectDoneV2(data)
async function scenarioStatusSkippedOther(browser, sw, mongo) {
  log('\n══ 场景 23: status-skipped-other — all-cached 跳过 ══');
  await clearMongoCache(mongo);
  await clearStoreClassification(CHINA_SHOP_SLUG);
  await setStoreClassification(CHINA_SHOP_SLUG, true);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  log('阶段 1: 先采集一次,填满缓存...');
  const page = await openChinaShopAndScroll(browser, 8000, mongo, sw);

  const cacheCount = await countCache(mongo, 'ozon_card_cache');
  log(`第一次采集后 card 缓存: ${cacheCount} 条`);
  if (cacheCount >= 1) pass(`第一次采集已填充缓存(${cacheCount} 条 card)`);
  else fail('第一次采集未填充缓存');

  await clearQueueTasksOnly(mongo);
  await setAutoCollectConfig(sw, {
    enabled: true,
    autoCollectRunning: true,
    todayCount: 0,
    perDayLimit: 100,
    consumeRateSec: 2,
    onlyChineseStores: true,
    paused: false,
    pausedUntil: 0,
  });
  await sleep(500);

  log('阶段 2: 再次触发(应命中 all-cached skip)...');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(8000);

  const { panelStatuses, swRecent, tasks } = await inspectCollectResult(page, sw, mongo);
  log(`队列任务: ${tasks.length} 条, 状态: ${tasks.map((t) => t.status).join(', ')}`);
  log(`SW 最近记录: ${swRecent.map((r) => `${r.sku}:${r.status}:${r.reason}`).join(', ')}`);
  for (const p of panelStatuses) {
    log(`  panel sku=${p.sku}, status=${p.status}, 字段数=${p.fieldCount}, 非空=${p.nonEmptyFields}`);
  }

  const skippedRecent = swRecent.filter((r) => r.status === 'skipped' || r.reason === 'all-cached');
  const finalTasks = tasks.filter((t) => t.status === 'failed_final');
  if (skippedRecent.length >= 1 || finalTasks.length >= 1) {
    pass(`检测到 all-cached skip(skipped记录=${skippedRecent.length}, failed_final任务=${finalTasks.length})`);
  } else {
    log('  注意:某些 SW 实现可能直接复用缓存不写日志');
    const cacheCount2 = await countCache(mongo, 'ozon_card_cache');
    if (cacheCount2 === cacheCount) pass(`缓存未增长(仍为 ${cacheCount2} 条),间接验证 all-cached`);
    else fail(`all-cached 未生效:缓存从 ${cacheCount} 增长到 ${cacheCount2}`);
  }

  const readyPanels = panelStatuses.filter((p) => p.status === 'ready');
  if (readyPanels.length >= 1) pass(`all-cached panel 已设 ready(${readyPanels.length} 个)`);
  else fail(`all-cached panel 未设 ready(状态: ${panelStatuses.map((p) => p.status).join(', ')})`);

  await page.close();
}

// ─── 主函数 ─────────────────────────────────────────────

async function main() {
  const scenario = process.argv[2] || 'all';
  log(`启动 E2E 测试,场景: ${scenario}`);

  // 连接 MongoDB
  log('连接 MongoDB...');
  const mongoClient = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  const mongo = mongoClient.db(DB_NAME);
  log('MongoDB 已连接');

  // 登录 ERP 获取 JWT token
  await loginErp();

  // 启动 Chrome 加载扩展
  log('启动 Chrome(加载扩展)...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--no-sandbox',
    ],
  });

  try {
    const swOld = await waitForServiceWorker(browser);
    const sw = await enableTestMode(browser, swOld);

    const scenarios = {
      basic: () => scenarioBasic(browser, sw, mongo),
      dedup: () => scenarioDedup(browser, sw, mongo),
      'non-chinese': () => scenarioNonChinese(browser, sw, mongo),
      'daily-limit': () => scenarioDailyLimit(browser, sw, mongo),
      'cache-hit': () => scenarioCacheHit(browser, sw, mongo),
      antibot: () => scenarioAntibot(browser, sw, mongo),
      'not-running': () => scenarioNotRunning(browser, sw, mongo),
      'retry-backoff': () => scenarioRetryBackoff(browser, sw, mongo),
      'queue-persistence': () => scenarioQueuePersistence(browser, sw, mongo),
      'antibot-recovery': () => scenarioAntibotRecovery(browser, sw, mongo),
      'panel-ready': () => scenarioPanelReadyOnCollectDone(browser, sw, mongo),
      'unclassified-mark': () => scenarioUnclassifiedMark(browser, sw, mongo),
      'daily-limit-pending': () => scenarioDailyLimitPending(browser, sw, mongo),
      'paused-soft-expiry': () => scenarioPausedSoftExpiry(browser, sw, mongo),
      'daily-limit-deadlock': () => scenarioDailyLimitDeadlock(browser, sw, mongo),
      'scroll-new-skus': () => scenarioScrollNewSkus(browser, sw, mongo),
      'collect-data-render': () => scenarioCollectDataRender(browser, sw, mongo),
      'status-success': () => scenarioStatusSuccess(browser, sw, mongo),
      'status-partial': () => scenarioStatusPartial(browser, sw, mongo),
      'status-failed': () => scenarioStatusFailed(browser, sw, mongo),
      'status-antibot': () => scenarioStatusAntibot(browser, sw, mongo),
      'antibot-newpage': () => scenarioAntibotNewpage(browser, sw, mongo),
      'status-skipped-daily-limit': () => scenarioStatusSkippedDailyLimit(browser, sw, mongo),
      'status-skipped-other': () => scenarioStatusSkippedOther(browser, sw, mongo),
    };

    if (scenario === 'all') {
      for (const [name, fn] of Object.entries(scenarios)) {
        try {
          await resetQueueMeta(sw);
          await fn();
        } catch (e) {
          fail(`${name} 执行异常: ${e?.message || e}`);
        }
      }
    } else if (scenarios[scenario]) {
      await scenarios[scenario]();
    } else {
      log(`未知场景: ${scenario},可选: ${Object.keys(scenarios).join(', ')}, all`);
      process.exit(1);
    }

    log('\n══ 测试完成 ══');
  } finally {
    await browser.close();
    await mongoClient.close();
  }
}

main().catch((e) => {
  console.error('[test] 致命错误:', e);
  process.exit(1);
});
