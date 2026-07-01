# XY Ozon 模拟手动跟卖

从原项目（`0.13.31.1`）抽离并**完整复刻**的「模拟手动上架（viaPortal=true）」流程扩展。

- **ERP 后端**：真实对接 `erp-backend-lite`（`src/background/erp-client.js` → `http://localhost:3001`）
- **seller portal 读**：真实 `seller.ozon.ru`（变体预取 / 公司 ID 解析 / 任务轮询）
- **seller portal 写**：默认真实建品（6b/6c/6d），可通过 `MOCK_SELLER_CONFIG.enabled=true` 切换为 mock
- **视频转存**：默认真实 `media-storage/upload-file`（mp4 → ir.ozone.ru/s3），mock 模式返回模拟 URL
- **注入页面**：真实 `www.ozon.ru/product/*`（也可在 ozon.kz 注入）
- **多变体展开**：Phase 0 弹窗补全 + Phase A SSR 多轴展开（`src/content/variant-expander.js`）
- **纯函数库**：`src/lib/content-copy.js`（描述/标签清洗）+ `src/lib/title-quality.js`（标题质量预检）

## 目录结构

```
xy-ozon/
├── manifest.json                  MV3 清单
├── package.json                   依赖与脚本
├── docs/
│   └── follow-sell-portal-flow.md  流程文档(7 阶段 + mock/真实开关)
├── src/
│   ├── background/
│   │   ├── service-worker.js      消息路由 + 全流程编排
│   │   ├── erp-client.js          真实 ERP HTTP 客户端(对接 erp-backend-lite)
│   │   ├── seller-portal-client.js 真实 seller.ozon.ru 客户端(读+写+视频转存)
│   │   ├── mock-seller-portal.js  Mock seller portal(测试桩,默认关闭)
│   │   └── import-via-portal.js   viaPortal 编排核心(6a→6b→6c→6d,mock/真实路由)
│   ├── content/
│   │   ├── content.js             主入口(注入 ⚡ 按钮 + 面板)
│   │   ├── product-extractor.js   页面数据抓取
│   │   ├── variant-expander.js    多变体展开(Phase 0 弹窗 + Phase A SSR)
│   │   ├── follow-sell-panel.js   跟卖面板 UI + 7 阶段编排
│   │   └── panel.css
│   ├── lib/
│   │   ├── content-copy.js        纯函数库(描述/标签清洗)
│   │   └── title-quality.js       标题质量预检(非阻塞 advisory)
│   └── popup/                     状态展示
└── tests/
    └── content-copy.test.js       纯函数库单测
```

## 安装与运行

### 1. 启动 ERP 后端

```bash
cd ../erp-backend-lite
npm install
cp .env.example .env  # 编辑 JWT_SECRET / USER_PHONE / USER_PASSWORD
npm run init-db
npm start             # 启动在 http://localhost:3001
```

### 2. 加载扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `xy-ozon/` 目录

### 3. 体验跟卖流程

1. 打开任意 Ozon 商品页（如 `https://www.ozon.ru/product/xxx-12345678/`）
2. 右上角出现 ⚡ 按钮，点击打开跟卖面板
3. 配置价格/库存/上架方式，点「一键上架至OZON」
4. 观察面板底部状态：Phase 1→2→3→4→5→6→7 逐步推进
5. 最终显示「门户上架完成！已创建 N 个商品」

### 4. 运行单测

```bash
cd xy-ozon
npm install
npm test
```

## Mock / 真实开关

默认所有操作走**真实** seller.ozon.ru + 真实 ERP。需要离线测试或故障注入时，在 `src/background/mock-seller-portal.js` 顶部或控制台设置：

```js
// 切换为 mock 模式(6b/6c/6d + 视频转存走内存模拟,无真实副作用)
self.MOCK_SELLER_CONFIG = { enabled: true };

// mock 模式下可配故障注入
self.MOCK_SELLER_CONFIG = { enabled: true, antibotRate: 1 };      // 模拟反爬
self.MOCK_SELLER_CONFIG = { enabled: true, authFailRate: 1 };     // 模拟鉴权失败
self.MOCK_SELLER_CONFIG = { enabled: true, networkFailRate: 0.5 };// 模拟网络错
```

## 流程文档

完整的 7 阶段流程与 mock/真实开关说明见 [docs/follow-sell-portal-flow.md](docs/follow-sell-portal-flow.md)。

## 与原项目的差异

| 维度          | 原项目                    | 本项目                           |
| ------------- | ------------------------- | -------------------------------- |
| ERP           | 真实 `api.jizhangerp.com` | 真实 `erp-backend-lite`          |
| seller portal 读 | 真实 `seller.ozon.ru`  | 真实（变体预取/公司ID/轮询）     |
| seller portal 写 | 真实建品              | 默认真实，可切换 mock            |
| 变体展开      | 多轴 SSR + 弹窗补全       | ✅ 完整复刻（variant-expander.js）|
| AI 重写/水印  | 后端 worker 执行          | erp-backend-lite feature-flag 可选|
| 视频转存      | 真实 upload-file          | ✅ 默认真实，mock 可选            |
| bundle 缓存   | 24h + 跨店防串 v2         | ✅ 完整复刻                       |
| 严格模式      | strictSkipped 回传        | ✅ 完整复刻 + 前端展示            |
| 类目一致性    | 锚点强制对齐              | ✅ 完整复刻                       |
| 标题质量预检  | lib/title-quality.js      | ✅ 完整复刻                       |
| 错误人性化    | humanizeError             | ✅ 完整复刻（9 类错误码翻译）     |
| 节流闸门      | ✅ 200ms                  | ✅ 保留                           |
| 403 细分      | ✅                        | ✅ 保留                           |
| 公司护栏      | ✅                        | ✅ 保留                           |
| 代采          | 跨设备派单                | 端点契约完整（单机版无真实派单）  |
