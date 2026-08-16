import { launch } from 'cloakbrowser';

// 1. 修改 launch 配置：设置 headless: false
const browser = await launch({
  headless: false,
  // 可选：设置默认视口大小，方便查看
  defaultViewport: { width: 1280, height: 800 }
});

const page = await browser.newPage();
await page.goto('https://www.baidu.com');

// 2. 注释掉关闭浏览器的代码，保持浏览器打开
// await browser.close(); 