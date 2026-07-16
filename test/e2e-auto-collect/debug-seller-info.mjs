import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXTENSION_PATH = resolve(__dirname, '../../../qx-ozon');
const MOCK_BASE = 'http://localhost:7777';
const CHINA_SHOP_SLUG = 'mock-china-shop';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--no-sandbox',
  ],
});

// Wait for SW to be ready first
console.log('Waiting for SW...');
for (let i = 0; i < 60; i++) {
  const targets = browser.targets();
  const sw = targets.find((t) => t.type() === 'service_worker');
  if (sw) {
    console.log('SW target found');
    break;
  }
  await sleep(500);
}
await sleep(2000);

// Capture console logs
const page = await browser.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('seller-info') || text.includes('panel') || text.includes('jz') || text.includes('extract')) {
    console.log('[page console]', msg.type(), text);
  }
});
page.on('consoleerror', (e) => console.log('[page ERROR]', e.text()));

await page.setViewport({ width: 1280, height: 800 });
console.log('Navigating to mock seller page...');
await page.goto(`${MOCK_BASE}/seller/${CHINA_SHOP_SLUG}`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__MOCK_READY__ === true, { timeout: 5000 });

console.log('Waiting 8s for seller-info-main.js to complete...');
await sleep(8000);

// Check various state
const state = await page.evaluate(() => {
  return {
    nuxtSellerId: window.__NUXT__?.state?.pageInfo?.analyticsInfo?.sellerId,
    nuxtSellerSlug: window.__NUXT__?.state?.pageInfo?.analyticsInfo?.sellerSlug,
    attrSellerInfo: document.documentElement.getAttribute('data-jz-seller-info'),
    attrDebug: document.documentElement.getAttribute('data-jz-seller-info-debug'),
    sellerInfoInstalled: window.__JZ_SELLER_INFO_MAIN_INSTALLED__,
    productInstalled: window.__JZ_PRODUCT_INSTALLED__,
    firstSkuLink: document.querySelector('a[href*="/product/"]')?.href,
    panelCount: document.querySelectorAll('.ozon-helper-data-panel').length,
  };
});
console.log('Page state:', JSON.stringify(state, null, 2));

await browser.close();
