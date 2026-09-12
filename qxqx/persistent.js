// 持久化浏览器登录窗口(买手账号 profile 维护)
// 用法: node persistent.js <账号别名>   (别名须与 erp-backend-lite/.env 的
//       PLATFORM_PROFILE_<别名> / PLATFORM_ACCOUNTS_* 配置一致)
//   node persistent.js linqx     → .linqx-profile(主账号)
//   node persistent.js chenlin   → .chenlin-profile
// 不带参数时打印用法并退出,避免误开错 profile。
import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACCOUNTS = {
  // linqx 主平台淘宝;1688 被风控时在同一窗口手动访问下方 1688 订单页过验证
  linqx: { dir: path.join(__dirname, '.linqx-profile'), home: 'https://www.taobao.com/' },
  // chenlin 直开 1688 订单列表页:登录态/风控(baxia 滑块)问题在首页不一定暴露,
  // 订单页才是 platform-orders 实际取数入口,过一次验证即可解除挂起拦截
  chenlin: {
    dir: path.join(__dirname, '.chenlin-profile'),
    home: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?page=1&pageSize=10',
  },
};

const account = process.argv[2];
const conf = ACCOUNTS[account];
if (!conf) {
  console.error(`用法: node persistent.js <账号别名>`);
  console.error(`可用账号: ${Object.keys(ACCOUNTS).join(', ')}`);
  console.error('(新增账号需同步在 erp-backend-lite/.env 增加 PLATFORM_PROFILE_<别名> 并把别名加进对应平台的 PLATFORM_ACCOUNTS_*)');
  process.exit(1);
}

// 持久化用户数据目录：cookie / localStorage / 登录态会保存在这里
// 复用同一路径再次启动即可恢复状态
const userDataDir = conf.dir;

let ctx;
try {
  ctx = await launchPersistentContext({
    userDataDir,
    args: ['--password-store=basic'],  // 用明文加密,跨平台兼容
    headless: false, // 可见窗口，便于观察；改为 true 则后台运行
  });
} catch (e) {
  // Chromium 单实例互斥:profile 被其它实例占用时子进程立即退出,
  // Playwright 报 "Target page, context or browser has been closed"
  if (/Target page|browser has been closed|browser closed|single|in use/i.test(String(e && e.message))) {
    console.error(`启动失败: ${userDataDir}`);
    console.error(`被其它 Chromium 实例占用(最常见: ERP 后端空闲浏览器,10分钟无请求才自动回收)。`);
    console.error(`解决: 先执行  pm2 restart erp  释放 profile,再立即重跑本命令。`);
    process.exit(1);
  }
  throw e;
}

// 复用已打开的页面，没有则新建
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(conf.home);
console.log(`账号 ${account} · 页面标题:`, await page.title());

// 关闭上下文，profile 自动落盘
// await ctx.close();
console.log('profile 保存在:', userDataDir);
