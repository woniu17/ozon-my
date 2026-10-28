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
await page.goto('http://localhost:3001/admin#/order-process', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(4000);
await page.locator('input.global-kw-input').first().fill('5441314196');
await page.locator('input.global-kw-input').first().press('Enter');
await page.waitForTimeout(6000);

const bodyText = await page.evaluate(() => document.body.innerText);
console.log('搜索结果含 SKU:', bodyText.includes('5441314196'));
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('.product-sub.pw-product-line')].map((el) => el.innerText.trim().replace(/\n+/g, ' '))
);
console.log('跟卖行:', JSON.stringify(rows, null, 2));
const hasEmpty = rows.some((t) => /无跟卖/.test(t));
console.log('无跟卖显示:', hasEmpty);
await page.screenshot({ path: '/tmp/pw-empty.png', fullPage: false });
await browser.close();