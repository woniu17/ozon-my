import { buildLaunchOptions } from 'cloakbrowser';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CDP 端口
const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
// 持久化 profile（独立目录，避免与其他脚本启动的浏览器 profile 锁冲突）
const userDataDir = process.env.CDP_PROFILE || path.join(__dirname, '.chrome-cdp-profile');
// 是否无头（CDP server 通常 headed 便于人工查看；设 CDP_HEADLESS=1 切换）
const headless = process.env.CDP_HEADLESS === '1';
// 可选加载 qx-ozon 扩展（设 CDP_EXTENSION=1 启用）
const loadExtension = process.env.CDP_EXTENSION === '1';
const extensionPath = path.resolve(__dirname, '../qx-ozon');

// 用 cloakbrowser 构建 stealth 启动参数（含指纹/平台等 stealth flags）
const built = await buildLaunchOptions({
  headless,
  extensionPaths: loadExtension ? [extensionPath] : undefined,
});

// 在 stealth args 基础上追加 CDP server 必需参数
const args = [
  ...(built.args || []),
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  // spawn 方式下 headless 需作为命令行参数
  ...(headless ? ['--headless=new'] : []),
  // restore last session
  '--restore-last-session',
];

console.log(`[cdp-server] 启动 stealth Chromium，CDP 端口: ${CDP_PORT}`);
console.log(`[cdp-server] executable: ${built.executablePath}`);
console.log(`[cdp-server] profile:   ${userDataDir}`);
if (loadExtension) console.log(`[cdp-server] 扩展:     ${extensionPath}`);

const proc = spawn(built.executablePath, args, {
  stdio: 'ignore',
  env: { ...process.env, ...(built.env || {}) },
  windowsHide: false,
});

proc.on('exit', (code, signal) => {
  console.log(`[cdp-server] 浏览器进程退出 code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

// 轮询 CDP 端点直到就绪
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function waitForCdp(maxAttempts = 30, intervalMs = 500) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const info = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return info;
    } catch {
      if (proc.exitCode !== null) throw new Error('浏览器进程已退出');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`CDP 端口 ${CDP_PORT} 未就绪`);
}

try {
  const info = await waitForCdp();
  console.log('\n[cdp-server] CDP 已就绪');
  console.log(`  浏览器:      ${info.Browser}`);
  console.log(`  端点:        http://127.0.0.1:${CDP_PORT}`);
  console.log(`  wsDebugger:  ${info.webSocketDebuggerUrl}`);
  console.log('\n外部连接示例:');
  console.log(`  Playwright:  await chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}')`);
  console.log(`  Puppeteer:   await puppeteer.connect({ browserWSEndpoint: '${info.webSocketDebuggerUrl}' })`);
  console.log(`  DevTools:    chrome://inspect → Configure → localhost:${CDP_PORT}`);
  console.log('\n按 Ctrl+C 关闭浏览器并退出。');
} catch (e) {
  console.error('[cdp-server] 启动失败:', e.message);
  proc.kill();
  process.exit(1);
}
