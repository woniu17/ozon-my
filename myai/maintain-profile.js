// myai-profile 登录态维护脚本(2026-10-28)
// 参考 qxqx/maintain-profile.js 编写。
// 问答服务(myaichat-server.js)使用 myai-profile 中的千问登录态。
// 本脚本打开持久化可见浏览器窗口,保证 myai-profile 里千问有登录态:
//   - https://www.qianwen.com/   千问网页版:登录态(人工扫码/验证码登录)
// 登录态随窗口关闭自动落盘,供问答服务复用。
//
// 用法:
//   node maintain-profile.js
//   PROFILE_DIR=xxx node maintain-profile.js   # 覆盖 profile 目录
//
// 注意:问答服务运行期间 profile 被占用,需先停止服务再执行本脚本。
import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载(PROFILE_DIR 可覆盖) ──
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

const userDataDir = path.resolve(__dirname, process.env.PROFILE_DIR || 'myai-profile');

// 需保证登录态的站点(依次打开,人工登录)
const TARGETS = [
  {
    name: '千问',
    url: 'https://www.qianwen.com/',
    desc: 'www.qianwen.com 千问网页版(问答服务用,人工扫码/验证码登录)',
  },
];

// 检查是否有进程正在占用 profile(browser.lock 跨脚本锁)
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
    console.error(`[退出] profile(${userDataDir}) 正被其它进程占用(PID ${pidText},锁文件: ${lockFile})`);
    console.error('请先停止问答服务(node myaichat-server.js),再运行本命令维护登录态。');
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
  // Chromium 单实例互斥:profile 被其它实例占用时子进程立即退出
  if (/Target page|browser has been closed|browser closed|single|in use/i.test(String(e && e.message))) {
    console.error(`启动失败: ${userDataDir}`);
    console.error('被其它 Chromium 实例占用(问答服务运行中,或 ERP 后端空闲浏览器未释放)。');
    console.error('解决: 先停止 myaichat-server,再立即重跑本命令。');
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
console.log(`[1/1] ${TARGETS[0].name} · 页面标题:`, await page1.title());
console.log(`      ${TARGETS[0].desc}`);

console.log('\n请在窗口中完成千问登录/过验证;关闭窗口后登录态自动落盘,问答服务即可复用。');
console.log('profile 保存在:', userDataDir);
// 不主动关闭 context:窗口关闭后进程自然退出,登录态落盘