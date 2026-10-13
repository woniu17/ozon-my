// 采集脚本登录 profile 维护(2026-10-13,参考 persistent.js)
// 浅度采集(shallow-collect.js)/深度采集(deep-collect.js)/价格优势监控(price-watch-collect.js)
// 共用 .ozon-profile(靠 browser.lock 跨脚本锁互斥)。本脚本打开持久化可见浏览器窗口,
// 用于人工登录/过验证,登录态随窗口关闭自动落盘,供对应采集脚本复用。
//
// 三种模式(登录态需求不同):
//   - shallow     → www.ozon.ru(买家/访客 cookie,过反爬挑战即可,无需登录)
//   - deep        → seller.ozon.ru(卖家登录态 sc_company_id 持久化,必须人工扫码登录)
//   - price-watch → www.ozon.ru(买家 cookie,有登录态可降低 403 概率)
//
// 用法:
//   node maintain-profile.js <shallow|deep|price-watch>
//   PROFILE_DIR=xxx node maintain-profile.js deep   # 覆盖 profile 目录(与深采/价监读取一致)
//
// 注意:采集脚本运行期间 profile 被占用,需先停止对应采集进程(或 pm2 restart erp 释放
// ERP 空闲浏览器)再执行本脚本。
import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载(PROFILE_DIR 可覆盖,与 deep/price-watch 读取一致) ──
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const BASE_PROFILE = path.resolve(__dirname, process.env.PROFILE_DIR || '.ozon-profile');

const PROFILES = {
  shallow: {
    dir: BASE_PROFILE,
    home: 'https://www.ozon.ru/',
    desc: '浅度采集:www.ozon.ru 买家/访客 cookie(过反爬挑战即可,无需登录)',
  },
  deep: {
    dir: BASE_PROFILE,
    home: 'https://seller.ozon.ru/',
    desc: '深度采集:seller.ozon.ru 卖家登录态(sc_company_id 持久化,必须人工扫码登录)',
  },
  'price-watch': {
    dir: BASE_PROFILE,
    home: 'https://www.ozon.ru/',
    desc: '价格优势监控:www.ozon.ru 买家 cookie(有登录态可降低 403 概率)',
  },
};

const key = process.argv[2];
const conf = PROFILES[key];
if (!conf) {
  console.error('用法: node maintain-profile.js <shallow|deep|price-watch>');
  console.error('维护浅度采集/深度采集/价格优势监控采集脚本共用的 .ozon-profile 登录态');
  console.error('可用模式:');
  for (const [k, v] of Object.entries(PROFILES)) {
    console.error(`  ${k.padEnd(12)} → ${v.desc}`);
  }
  console.error('(可用 PROFILE_DIR 环境变量覆盖 profile 目录)');
  process.exit(1);
}

const userDataDir = conf.dir;

// 检查采集脚本是否正在占用 profile(browser.lock 跨脚本锁)
const lockFile = path.join(userDataDir, 'browser.lock');
if (existsSync(lockFile)) {
  let alive = false;
  let pidText = '';
  try {
    pidText = readFileSync(lockFile, 'utf-8').trim();
    const pid = Number(pidText);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch { /* 进程已死,视为残留锁 */ }
    }
  } catch { /* 读取失败忽略 */ }
  if (alive) {
    console.error(`[退出] profile(${userDataDir}) 正被采集进程占用(PID ${pidText},锁文件: ${lockFile})`);
    console.error('请先停止对应采集脚本(浅采/深采/价监),再运行本命令维护登录态。');
    process.exit(1);
  }
  console.log(`[锁] 发现残留 browser.lock(进程已死),忽略`);
}

let ctx;
try {
  ctx = await launchPersistentContext({
    userDataDir,
    args: ['--password-store=basic'], // 用明文加密,跨平台兼容
    headless: false, // 必须可见窗口,便于人工登录/过验证
  });
} catch (e) {
  // Chromium 单实例互斥:profile 被其它实例占用时子进程立即退出,
  // Playwright 报 "Target page, context or browser has been closed"
  if (/Target page|browser has been closed|browser closed|single|in use/i.test(String(e && e.message))) {
    console.error(`启动失败: ${userDataDir}`);
    console.error('被其它 Chromium 实例占用(采集脚本运行中,或 ERP 后端空闲浏览器,10分钟无请求才自动回收)。');
    console.error('解决: 先停止采集脚本/执行 pm2 restart erp 释放 profile,再立即重跑本命令。');
    process.exit(1);
  }
  throw e;
}

// 复用已打开的页面,没有则新建
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(conf.home, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(`模式 ${key} · 页面标题:`, await page.title());
console.log(`说明: ${conf.desc}`);
console.log('请在打开的窗口中完成登录/过验证;关闭窗口后登录态自动落盘。');
console.log('profile 保存在:', userDataDir);
// 不主动关闭 context:窗口关闭后进程自然退出,登录态落盘