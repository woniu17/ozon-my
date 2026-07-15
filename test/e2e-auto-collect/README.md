# Ozon 自动采集 E2E 测试环境

端到端测试 Ozon 插件自动采集功能,无需在真实 Ozon 页面运行。

## 目录结构

```
test/e2e-auto-collect/
├── mock-server/                # 模拟 www.ozon.ru + seller.ozon.ru
│   ├── products.js             # 测试数据(店铺 + SKU)
│   └── server.js               # 零依赖 http 服务(端口 7777)
├── runner/                     # Puppeteer 测试运行器
│   └── puppeteer-runner.js     # 6 个测试场景 + MongoDB 断言
├── package.json
├── start.sh                    # 一键启动脚本
└── README.md
```

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Puppeteer Runner (test runner)                             │
│  - 启动 Chrome 加载 qx-ozon 扩展                            │
│  - enableTestMode(): 写 chrome.storage.__IS_TEST_MODE__     │
│  - setAutoCollectConfig(): 注入限速/上限配置                │
│  - 滚动触发 → 等待 → 查询 MongoDB 验证                      │
└─────────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────────┐
        ▼                 ▼                     ▼
┌─────────────┐   ┌──────────────┐    ┌──────────────────┐
│ Mock Server │   │ qx-ozon ext  │    │ erp-backend-lite │
│ :7777       │   │ (SW + CS)    │    │ :3001            │
│             │   │              │    │                  │
│ /seller/:s  │◄──┤ IS_TEST_MODE │    │ /admin/api/      │
│ /product/:s │   │ → localhost   │    │  store-          │
│ /app/*      │   │              │    │  classification  │
│ /api/*      │   └──────┬───────┘    │ /:slug           │
└─────────────┘          │            └──────────────────┘
                         ▼
                ┌──────────────────┐
                │ MongoDB          │
                │ (ozon_erp)       │
                │                  │
                │ 缓存集合 ×8      │
                │ + collect_queue_ │
                │   tasks/ops      │
                │ + auto_collect_  │
                │   log            │
                └──────────────────┘
```

## 前置条件

1. **Node.js** >= 22.5.0
2. **MongoDB** 可访问(配置在 `erp-backend-lite/.env`)
3. **Chrome 浏览器**(Puppeteer 会自动下载 Chromium,也可用系统 Chrome)

## 安装

```bash
# 1. 安装测试目录依赖
cd test/e2e-auto-collect
npm install

# 2. 确保 erp-backend-lite 已安装依赖
cd ../../erp-backend-lite
npm install
```

## 使用方式

### 方式 1:一键启动(推荐)

```bash
cd test/e2e-auto-collect

# 全场景运行
./start.sh

# 单场景运行
./start.sh basic
./start.sh dedup
./start.sh non-chinese
./start.sh daily-limit
./start.sh cache-hit

# 反爬场景(自动以 MOCK_ANTIBOT=1 启动 mock-server)
./start.sh antibot
```

`start.sh` 会自动按顺序启动 mock-server(7777) → erp-backend-lite(3001) → puppeteer-runner,退出时自动清理。

### 方式 2:手动分步运行

```bash
# 终端 1:启动 mock-server
cd test/e2e-auto-collect
npm run mock

# 终端 2:启动 erp-backend-lite
cd erp-backend-lite
npm run start

# 终端 3:运行测试
cd test/e2e-auto-collect
npm run test              # 全场景
npm run test:basic        # 单场景
```

### 方式 3:手动浏览器调试(非 Puppeteer)

适用于调试扩展行为,直接用肉眼观察:

1. 启动 mock-server:`npm run mock`
2. 启动 erp-backend-lite:`npm run start`
3. 用 Chrome 打开 `chrome://extensions`,加载 `qx-ozon/` 扩展
4. 打开扩展后台 → Application → Storage → Local,设置:
   ```json
   { "__IS_TEST_MODE__": true }
   ```
5. 点击扩展的 "Service Worker" 链接打开 DevTools
6. 在 SW 控制台执行:
   ```javascript
   chrome.runtime.reload();
   ```
7. 新标签页访问 `http://localhost:7777/seller/mock-china-shop`
8. 滚动页面触发自动采集,在 SW/页面 DevTools 看日志

## 测试场景

| 场景 | 命令 | 验证点 |
|------|------|--------|
| 基础 E2E | `npm run test:basic` | 店铺页滚动 → 采集 → 缓存落库(card/entrypoint/log) |
| 去重 | `npm run test:dedup` | 多次滚动同一 SKU,任务数 ≤ SKU 数 |
| 非中国店铺跳过 | `npm run test:non-chinese` | 外国店铺页不提交任何任务 |
| 每日上限 | `npm run test:daily-limit` | perDayLimit=1,只完成 1 个任务 |
| 缓存命中 | `npm run test:cache-hit` | 第二次触发命中缓存,跳过或日志记 all-cached |
| 反爬熔断 | `npm run test:antibot` | API 返回 403 → SW 设置 paused=true + pausedUntil |

## IS_TEST_MODE 开关说明

扩展改造采用最小侵入方式,通过 `IS_TEST_MODE` 开关切换:

- **Content Script**(`shared-utils.js`):用 `location.origin` 正则检测 `http://localhost:7777`,直接同步读取
- **Service Worker**(`service-worker.js`):无 `location`,异步读 `chrome.storage.local.__IS_TEST_MODE__`,在 IIFE 顶部缓存 Promise,`_doAutoCollect` 开头 `await _testModeReady` 确保已初始化

测试模式下:
- `OZON_WWW_ORIGIN` = `http://localhost:7777`(原 `https://www.ozon.ru`)
- `OZON_SELLER_ORIGIN` = `http://localhost:7777`(原 `https://seller.ozon.ru`)
- `chrome.tabs.query` / `chrome.cookies.getAll` / `fetchSellerViaOzonTab` 全部走 localhost
- `executeScript` 注入函数的 `sellerOrigin` 改为参数传入(避免闭包读取 SW 变量)

## 测试数据

`mock-server/products.js` 定义:

- **CHINA_SHOP**:slug=`mock-china-shop`,sellerId=`12345`,isChinese=true
- **FOREIGN_SHOP**:slug=`mock-foreign-shop`,sellerId=`67890`,isChinese=false
- **3 个 SKU**:100001/100002/100003,均属于 CHINA_SHOP

可在此文件扩展更多测试数据。

## 常见问题

### Q: Puppeteer 启动 Chrome 失败?

A: 首次运行 `npm install` 会自动下载 Chromium。如已安装系统 Chrome,可在 `puppeteer-runner.js` 中指定 `executablePath`:

```javascript
const browser = await puppeteer.launch({
  executablePath: '/path/to/chrome',
  // ...
});
```

### Q: MongoDB 连接失败?

A: 检查 `erp-backend-lite/.env` 中的 MongoDB 配置:

```
MONGO_HOST=2.tencent.yochylin.com
MONGO_PORT=17017
MONGO_USERNAME=admin
MONGO_PASSWORD=...
MONGO_AUTH_SOURCE=admin
```

### Q: erp-backend-lite 启动失败,提示 `--experimental-sqlite`?

A: 需要 Node.js >= 22.5.0。`--experimental-sqlite` 是 Node 22+ 的实验性 API。

### Q: Windows 下 `start.sh` 无法执行?

A: 需要 Git Bash 或 WSL。或者手动分步运行(方式 2)。

### Q: 测试过程中浏览器窗口一直开着?

A: `puppeteer-runner.js` 中 `headless: false` 是为了便于调试。如需后台运行,改为 `headless: 'new'`。

## 扩展改造文件清单

| 文件 | 改动 |
|------|------|
| `qx-ozon/manifest.json` | host_permissions + content_scripts matches 新增 localhost:7777 |
| `qx-ozon/content/shared-utils.js` | IIFE 顶部新增 IS_TEST_MODE 检测,4 处 URL 替换 |
| `qx-ozon/background/service-worker.js` | IIFE 顶部新增 IS_TEST_MODE 异步检测,15+ 处 URL/cookie/tabs 替换 |

## 注意事项

1. **测试会清空 MongoDB 集合**:`puppeteer-runner.js` 中的 `clearMongoCache()` 会清空 11 个集合(8 个缓存 + 3 个队列/日志)。**不要在生产 MongoDB 上运行测试**。
2. **反爬场景需要单独启动 mock**:`./start.sh antibot` 会自动以 `MOCK_ANTIBOT=1` 启动,若已有一个 mock-server 在跑需先停掉。
3. **SW 重载时间**:`enableTestMode()` 后 `chrome.runtime.reload()` + 3s 等待,网络较慢时可增大 sleep。
