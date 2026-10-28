import { chromium } from 'playwright-core';
import jwt from 'jsonwebtoken';
import config from './src/config/index.js';

const token = jwt.sign({ id: 0, phone: 'test' }, config.jwtSecret, { expiresIn: '2h' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript((t) => {
  localStorage.setItem('erp_admin_token', t);
  localStorage.setItem('erp_admin_user', JSON.stringify({ id: 0, phone: 'test', name: 'test' }));
  localStorage.setItem('erp_admin_phone', 'test');
}, token);
const page = await context.newPage();
await page.goto('http://localhost:3001/admin#/order-process', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.locator('input.global-kw-input').fill('0135626632-0983-1');
await page.locator('input.global-kw-input').press('Enter');
await page.waitForTimeout(4000);

const hasBtn = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button.pw-list-fetch')].filter(b => b.innerText.trim() === '获取跟卖');
  return btns.length;
});
console.log('获取跟卖按钮数量:', hasBtn);
if (hasBtn === 0) {
  console.log('无按钮，页面文本:', (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n+/g, ' | '));
  await browser.close();
  process.exit(0);
}
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button.pw-list-fetch')].filter(b => b.innerText.trim() === '获取跟卖');
  btns[0].click();
  return true;
});
console.log('已点击,开始观察...');
for (let i = 0; i < 9; i++) {
  await page.waitForTimeout(10000);
  const state = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button.pw-list-fetch')];
    const tags = [...document.querySelectorAll('.pw-list-tag')];
    return {
      btnText: btns.length ? btns[0].innerText.trim() : '(无按钮)',
      hasTag: tags.length > 0,
      tagTexts: tags.slice(0, 3).map(t => t.innerText.trim()),
    };
  });
  console.log(`[${(i + 1) * 10}s]`, JSON.stringify(state));
}
await browser.close();
