import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 持久化用户数据目录：cookie / localStorage / 登录态会保存在这里
// 复用同一路径再次启动即可恢复状态
const userDataDir = path.join(__dirname, '.ozon-profile');

const ctx = await launchPersistentContext({
  userDataDir,
  args: ['--password-store=basic'],  // 用明文加密,跨平台兼容
  headless: false, // 可见窗口，便于观察；改为 true 则后台运行
});

// 复用已打开的页面，没有则新建
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto('https://www.baidu.com');
console.log('页面标题:', await page.title());

// 关闭上下文，profile 自动落盘
// await ctx.close();
console.log('已关闭，profile 保存在:', userDataDir);
