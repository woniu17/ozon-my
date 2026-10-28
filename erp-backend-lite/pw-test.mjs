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

// 搜索有快照的订单 SKU 5663677464
await page.locator('input.global-kw-input').fill('5663677464');
await page.locator('input.global-kw-input').press('Enter');
await page.waitForTimeout(5000);

const bodyText = await page.evaluate(() => document.body.innerText);
console.log('包含"产品单价":', bodyText.includes('产品单价'));
console.log('包含"跟卖#":', /跟卖#/.test(bodyText));
console.log('包含"获取跟卖":', bodyText.includes('获取跟卖'));
const gi = bodyText.indexOf('跟卖');
console.log('跟卖上下文:', gi >= 0 ? bodyText.slice(Math.max(0, gi - 200), gi + 250).replace(/\n+/g, ' | ') : '(无)');
await page.screenshot({ path: '/tmp/pw-product.png', fullPage: false });
await browser.close();
