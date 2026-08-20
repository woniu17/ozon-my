// 登录态迁移脚本(独立于浅度采集,不依赖数据库)
// 背景:Windows/Linux 的 profile cookie 加密互不兼容(DPAPI vs keyring),
//      直接拷 profile 目录登录态会丢;导出为纯 JSON(cookie+localStorage)
//      再导入,跨平台迁移可靠且文件极小。
//
// 用法:
//   node state-transfer.js --export [file]    # 导出 cookie+localStorage → JSON(默认 ozon-state.json)
//   node state-transfer.js --import [file]    # 导入 JSON → 当前 profile
//   HEADLESS=0 node state-transfer.js --export  # 有头模式(需要肉眼确认登录态时)
//
// 迁移流程(Windows → Linux):
//   1. Windows: node state-transfer.js --export
//   2. 拷贝 ozon-state.json + 代码 + erp.db(先 wal_checkpoint)到 Linux
//   3. Linux:   npm install && node state-transfer.js --import
//   4. 验证:    STORE_LIMIT=1 DRY_RUN=1 node shallow-collect.js
//
// 关键点:
//   - cookie 的 httpOnly/secure/sameSite 属性原样往返,登录态完整保留
//   - 会话 cookie(expires=-1)导入时延长 30 天,否则浏览器一关就失效
//   - localStorage 是 origin 作用域:导入前必须先导航到同源页面
//   - 导入后 cookie 以新平台自己的加密格式落盘,profile 自此自包含
//   - cookie 会随服务端轮换过期,建议迁移前现导,勿长期囤 JSON

import { launchPersistentContext } from 'cloakbrowser';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载(不覆盖已有 process.env,命令行优先;仅取 profileDir/headless) ──
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

const cfg = {
  // 与 shallow-collect.js 共用同一 profile(登录态所在)
  profileDir: process.env.PROFILE_DIR || path.join(__dirname, '.ozon-profile'),
  headless: process.env.HEADLESS !== '0',
  // 采集实例的锁文件(Chrome profile 单实例,运行中不允许迁移)
  lockFile: path.join(__dirname, '.shallow-collect.lock'),
};

// ── 主流程 ───────────────────────────────────────────────────
async function runStateTransfer(cmd, fileArg) {
  const file = path.resolve(__dirname, fileArg || 'ozon-state.json');
  console.log(cmd === '--export' ? '=== 导出登录态 ===' : '=== 导入登录态 ===');
  console.log(`Profile:   ${cfg.profileDir}`);
  console.log(`状态文件:  ${file}`);
  // 采集实例运行中会占用 profile(Chrome 单实例),先拒绝
  if (existsSync(cfg.lockFile)) {
    console.error('[退出] 采集脚本正在运行(profile 被占用),请先停止再迁移登录态');
    process.exit(1);
  }

  const ctx = await launchPersistentContext({
    userDataDir: cfg.profileDir,
    headless: cfg.headless,
  });
  try {
    const page = await ctx.newPage();

    if (cmd === '--export') {
      console.log('\n[导出] 访问 ozon.ru 提取登录态...');
      await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000); // 反爬挑战 + 页面就绪
      const cookies = await ctx.cookies();
      // localStorage 提取失败不影响 cookie(Ozon 登录态核心在 cookie)
      let localStorageItems = [];
      try {
        localStorageItems = await page.evaluate(() => {
          const items = [];
          for (let i = 0; i < window.localStorage.length; i++) {
            const name = window.localStorage.key(i);
            items.push({ name, value: window.localStorage.getItem(name) });
          }
          return items;
        });
      } catch (e) {
        console.log(`[导出] localStorage 提取失败(不影响 cookie): ${e.message}`);
      }
      writeFileSync(file, JSON.stringify({
        exportedAt: new Date().toISOString(),
        cookies,
        origins: [{ origin: 'https://www.ozon.ru', localStorage: localStorageItems }],
      }, null, 2));
      const authCookies = cookies.filter((c) => /session|auth|token|sc_|user/i.test(c.name));
      console.log(`[导出] 完成: cookie ${cookies.length} 个(疑似登录态 ${authCookies.length} 个),localStorage ${localStorageItems.length} 项`);
      console.log('[导出] 提示: 文件含登录凭证,勿外传/勿提交 git(.gitignore 已忽略)');
    } else {
      if (!existsSync(file)) {
        console.error(`[退出] 状态文件不存在: ${file}`);
        process.exit(1);
      }
      const state = JSON.parse(readFileSync(file, 'utf-8'));
      if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
        console.error('[退出] 状态文件无 cookie,请重新导出');
        process.exit(1);
      }
      // 会话 cookie(expires<=0)延长 30 天
      const nowSec = Math.floor(Date.now() / 1000);
      const cookies = state.cookies.map((c) => ({
        ...c,
        expires: Number.isFinite(c.expires) && c.expires > 0 ? c.expires : nowSec + 30 * 86400,
      }));
      await ctx.addCookies(cookies);
      console.log(`[导入] 已注入 cookie ${cookies.length} 个`);
      // localStorage 是 origin 作用域:先导航到 ozon.ru 再写入
      await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const origin = state.origins?.find((o) => o.origin === 'https://www.ozon.ru');
      if (origin?.localStorage?.length) {
        await page.evaluate((items) => {
          for (const it of items) window.localStorage.setItem(it.name, it.value);
        }, origin.localStorage);
        console.log(`[导入] 已写入 localStorage ${origin.localStorage.length} 项`);
      }
      // 重载复查:确认 cookie 真正落进 profile
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      const after = await ctx.cookies();
      const title = await page.title();
      console.log(`[导入] 复查: cookie ${after.length} 个,页面标题 "${(title || '').slice(0, 50)}"`);
      console.log('[导入] 建议验证: STORE_LIMIT=1 DRY_RUN=1 node shallow-collect.js');
    }
  } finally {
    await ctx.close();
  }
}

// ── CLI 入口 ─────────────────────────────────────────────────
const cmd = process.argv[2];
if (cmd !== '--export' && cmd !== '--import') {
  console.error('用法: node state-transfer.js --export [file] | --import [file]');
  console.error('  --export  导出 cookie+localStorage → JSON(默认 ozon-state.json)');
  console.error('  --import  导入 JSON → 当前 profile');
  process.exit(1);
}
await runStateTransfer(cmd, process.argv[3]);
