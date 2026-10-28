// MyAIChat - 基于 cloakbrowser + 千问登录态的简单问答服务
// 用法:
//   node myaichat-server.js                  # 默认 8787 端口
//   PORT=9000 TIMEOUT_MS=30000 node myaichat-server.js
//   HEADLESS=1 node myaichat-server.js       # 后台无头模式(可能影响风控)
// API:
//   POST /ask   {"question":"你的问题"}  -> {"answer":"...","elapsed_ms":123}
//   GET  /health                          -> 服务状态
import { launchPersistentContext } from 'cloakbrowser';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, 'myai-profile');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60000);
const HEADLESS = process.env.HEADLESS === '1';
const MAX_QUESTION_LEN = 2000;

// ── 浏览器状态 ──
let ctx = null;
let page = null;
let browserError = null;
let queueLength = 0;
let totalAnswered = 0;
let totalFailed = 0;
let warmingUp = false;

// ── 确保浏览器已启动并打开千问 ──
async function ensureBrowser() {
  if (ctx && page) return;
  if (warmingUp) {
    // 预热进行中则等待
    while (warmingUp) await new Promise((r) => setTimeout(r, 200));
    if (ctx && page) return;
  }
  warmingUp = true;
  browserError = null;
  try {
    ctx = await launchPersistentContext({
      userDataDir: PROFILE_DIR,
      args: ['--password-store=basic'],
      headless: HEADLESS,
    });
    page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://www.qianwen.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('text=新对话', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const body = (await page.evaluate(() => document.body.innerText)) || '';
    if (/登录/.test(body)) {
      browserError = '千问未登录，请先手动登录 myai-profile 中的千问';
      console.error('[错误]', browserError);
    } else {
      console.log('✅ 千问已登录');
    }
  } catch (e) {
    browserError = e?.message || String(e);
    console.error('[浏览器启动失败]', browserError);
    try { await ctx?.close(); } catch {}
    ctx = null;
    page = null;
    throw e;
  } finally {
    warmingUp = false;
  }
}

// ── 执行一次提问（需在串行队列中调用）──
async function askOnce(question) {
  await ensureBrowser();
  if (browserError) throw new Error(browserError);

  // 新建对话，隔离上下文
  const newBtn = page.locator('text=新对话').first();
  if (await newBtn.count().catch(() => 0)) {
    await newBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  const input = page
    .locator('textarea, [contenteditable="true"], input[type="text"], [placeholder*="向千问提问"]')
    .last();
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.click();
  await input.fill(question);
  await page.keyboard.press('Enter');

  // 等待回答渲染
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    // 取最后一个回答块中的第一个完成段落（避免取到千问的“追问建议”）
    const answer = await page
      .evaluate(() => {
        const wrappers = document.querySelectorAll('[class*="message-select-wrapper-answer"]');
        const last = wrappers[wrappers.length - 1];
        if (!last) return '';
        const span = last.querySelector('span.qk-md-text.complete');
        return span ? span.textContent.trim() : '';
      })
      .catch(() => '');
    if (answer) return answer;
  }
  throw new Error(`获取回答超时(${TIMEOUT_MS / 1000}s)`);
}

// ── 串行队列：保证同一时刻只有一个提问占用浏览器 ──
let queueChain = Promise.resolve();
function ask(question) {
  queueLength++;
  const run = queueChain.then(() => askOnce(question));
  queueChain = run
    .then(
      () => {},
      () => {}
    )
    .finally(() => {
      queueLength--;
    });
  return run;
}

// ── HTTP 服务 ──
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /ask
  if (req.method === 'POST' && req.url === '/ask') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let question = '';
      try {
        question = (JSON.parse(body).question || '').toString().trim();
      } catch {
        question = '';
      }
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 question 字段' }));
        return;
      }
      if (question.length > MAX_QUESTION_LEN) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `问题过长(>${MAX_QUESTION_LEN})` }));
        return;
      }
      const t0 = Date.now();
      try {
        const answer = await ask(question);
        totalAnswered++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer, elapsed_ms: Date.now() - t0 }));
      } catch (e) {
        totalFailed++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e?.message || '内部错误' }));
      }
    });
    return;
  }

  // GET /health
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        browser: ctx ? 'connected' : 'disconnected',
        browser_error: browserError || null,
        queue_length: queueLength,
        total_answered: totalAnswered,
        total_failed: totalFailed,
        profile: PROFILE_DIR,
        timeout_ms: TIMEOUT_MS,
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`MyAIChat 服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`Profile  : ${PROFILE_DIR}`);
  console.log(`Timeout   : ${TIMEOUT_MS}ms`);
  console.log(`Headless  : ${HEADLESS}`);
  // 预热浏览器
  ensureBrowser()
    .then(() => console.log('浏览器已就绪'))
    .catch((e) => console.error('预热失败:', e?.message));
});

// 优雅退出
process.on('SIGINT', async () => {
  console.log('\n收到退出信号，关闭浏览器...');
  try { await ctx?.close(); } catch {}
  process.exit(0);
});