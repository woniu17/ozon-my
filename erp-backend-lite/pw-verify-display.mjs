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
console.log('首次加载完成, URL:', await page.evaluate(() => location.href));

async function inspectSku(sku) {
  // 用全局搜索定位 SKU 对应订单
  const input = page.locator('input.global-kw-input').first();
  await input.fill(String(sku));
  await input.press('Enter');
  await page.waitForTimeout(6000);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.product-sub.pw-product-line')].map((el) => el.innerText.trim().replace(/\n+/g, ' '))
  );
  console.log(`SKU ${sku} 跟卖行(${rows.length}):`, rows.slice(0, 5));
  return rows;
}

const r1 = await inspectSku('5663677464'); // 有跟卖(259 卖家)
const r2 = await inspectSku('5441314196'); // 无跟卖(empty)
const ok1 = r1.some((t) => /跟卖#/.test(t));
const ok2 = r2.some((t) => /无跟卖/.test(t));
console.log('有跟卖订单显示徽标:', ok1, '| 无跟卖订单显示"无跟卖":', ok2);
await page.screenshot({ path: '/tmp/pw-display.png', fullPage: false });
await browser.close();