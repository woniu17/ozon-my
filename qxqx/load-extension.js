import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 持久化 profile：保存登录态 / cookie，下次免登录
const userDataDir = path.join(__dirname, '.chrome-profile');

// qx-ozon 扩展目录（含 manifest.json）
const extensionPath = path.resolve(__dirname, '../qx-ozon');

const ctx = await launchPersistentContext({
  userDataDir,
  headless: false, // 加载扩展必须 headed
  extensionPaths: [extensionPath],
});

// 复用已打开的页面，没有则新建
const page = ctx.pages()[0] || (await ctx.newPage());

// 打开 ozon 卖家后台（扩展主要注入该站点）
// 首次访问需登录，登录态会保存在 userDataDir，下次复用
await page.goto('https://seller.ozon.ru/');
console.log('页面标题:', await page.title());

// 如需查看已加载扩展，可在浏览器中访问 chrome://extensions
// 注意：cloakbrowser 默认隐藏自动化信号，chrome:// 页面可能受限

// 不自动关闭，保留窗口便于操作
// 如需自动关闭，取消下一行注释
// await ctx.close();
