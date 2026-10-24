// 采集脚本登录 profile 维护(2026-10-13)
// 浅度采集(shallow-collect.js)/深度采集(deep-collect.js)/价格优势监控(price-watch-collect.js)
// 共用 .ozon-profile(靠 browser.lock 跨脚本锁互斥)。
// 本脚本打开持久化可见浏览器窗口,保证 profile 里各站点都有登录态:
//   - https://www.ozon.ru/   买家端:买家/访客 cookie(浅采/价监用,过反爬挑战,有登录态可降 403)
//   - 卖家中心 ozon.ru 与 ozonru.cn 两个域都要登录:卖家登录态 sc_company_id 按站点隔离,
//     深采(默认走 ozonru.cn,旧域 ozon.ru 备用)、miaoshou-helper 徽章插件都可能落在任一域。
//     故无论 OZON_SELLER_BASE_URL 配哪个,脚本都会打开两个卖家域各登录一次。
// 登录态随窗口关闭自动落盘,供三个采集脚本复用。
//
// 用法:
//   node maintain-profile.js
//   PROFILE_DIR=xxx node maintain-profile.js   # 覆盖 profile 目录(与深采/价监读取一致)
//   OZON_SELLER_BASE_URL=https://seller.ozon.ru node maintain-profile.js   # 主域切回旧域(仍会同时维护新域)
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

const userDataDir = path.resolve(__dirname, process.env.PROFILE_DIR || '.ozon-profile');

// 卖家域(2026-10 起默认走中国卖家新域 ozonru.cn,可用 OZON_SELLER_BASE_URL 切回旧域)
const sellerBaseUrl = (process.env.OZON_SELLER_BASE_URL || 'https://seller.ozonru.cn').replace(/\/+$/, '');
// 两个卖家域都要维护(cookie 按站点隔离,深采/插件可能落在任一域)
const SELLER_DOMAINS = [...new Set([sellerBaseUrl, 'https://seller.ozon.ru', 'https://seller.ozonru.cn'])];

// 需保证登录态的站点(依次打开,人工登录;卖家域两个都开)
const TARGETS = [
  {
    name: '买家端',
    url: 'https://www.ozon.ru/',
    desc: 'www.ozon.ru 买家/访客 cookie(浅采/价监用,过反爬挑战)',
  },
  ...SELLER_DOMAINS.map((domain, i) => ({
    name: i === 0 ? '卖家中心(主)' : '卖家中心(兼容域)',
    url: `${domain}/app/dashboard/main`,
    desc: `${domain} 卖家登录态 sc_company_id(深采必需,人工扫码登录;${domain === sellerBaseUrl ? '当前配置主域' : '备用域'})`,
  })),
];

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

// 复用会话恢复的第一个标签页,其余残留页关闭(避免占内存/反爬指纹混乱)
const restored = (() => {
  try { return ctx.pages(); } catch { return []; }
})();
for (const p of restored.slice(1)) await p.close().catch(() => {});
const page1 = restored[0] || (await ctx.newPage());

await page1.goto(TARGETS[0].url, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(`[1/2] ${TARGETS[0].name} · 页面标题:`, await page1.title());
console.log(`      ${TARGETS[0].desc}`);

const page2 = await ctx.newPage();
await page2.goto(TARGETS[1].url, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(`[2/2] ${TARGETS[1].name} · 页面标题:`, await page2.title());
console.log(`      ${TARGETS[1].desc}`);

console.log('\n请在窗口中完成两个站点的登录/过验证;关闭窗口后登录态自动落盘,三个采集脚本即可复用。');
console.log('profile 保存在:', userDataDir);
// 不主动关闭 context:窗口关闭后进程自然退出,登录态落盘