// 用 cloakbrowser 加载 myai-profile 登录态，向千问提问测试
// 用法: node test-qianwen.js [问题]
import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.join(__dirname, 'myai-profile');

const QUESTION = process.argv[2] || '请用一句话回答：中国的首都是哪里？';

let ctx;
try {
  ctx = await launchPersistentContext({
    userDataDir,
    args: ['--password-store=basic'],
    headless: false,
  });
} catch (e) {
  console.error('[启动失败]', e?.message || e);
  process.exit(1);
}

const page = ctx.pages()[0] || (await ctx.newPage());

try {
  console.log('→ 打开千问...');
  await page.goto('https://www.qianwen.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('text=新对话', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const bodyText = (await page.evaluate(() => document.body.innerText)) || '';
  console.log('登录状态:', /登录/.test(bodyText) ? '❌ 未登录' : '✅ 已登录');

  const newBtn = page.locator('text=新对话').first();
  if (await newBtn.count().catch(() => 0)) {
    await newBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  const input = page
    .locator('textarea, [contenteditable="true"], input[type="text"], [placeholder*="向千问提问"]')
    .last();
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.click();
  await input.fill(QUESTION);
  await page.keyboard.press('Enter');

  console.log('→ 已提问:', QUESTION);
  const deadline = Date.now() + 60000;
  let answer = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    answer = await page
      .evaluate(() => {
        const wrappers = document.querySelectorAll('[class*="message-select-wrapper-answer"]');
        const last = wrappers[wrappers.length - 1];
        if (!last) return '';
        const span = last.querySelector('span.qk-md-text.complete');
        return span ? span.textContent.trim() : '';
      })
      .catch(() => '');
    if (answer) break;
  }
  console.log('回答:', answer || '(未获取到回答)');
} catch (e) {
  console.error('[运行错误]', e?.message || e);
} finally {
  console.log('→ 关闭浏览器(profile 自动落盘)...');
  await ctx.close().catch(() => {});
}