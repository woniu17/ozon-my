# XY Ozon 模拟手动跟卖 Demo

从原项目（`0.13.31.1`）抽离的「模拟手动上架（viaPortal=true）」完整流程 Demo。

- **ERP 后端**：全部 mock（`src/background/mock-erp.js`），高仿真（延时 + 配额 + 公司护栏 + 可配失败率）
- **seller portal 建品**：全部 mock（`src/background/mock-seller-portal.js`），保留 200ms 节流闸门 + 403 反爬细分 + async-upload 进度
- **注入页面**：真实 `www.ozon.ru/product/*`（也可在 ozon.kz 注入）
- **纯函数库**：`src/lib/content-copy.js` 直接从原项目复制（描述/标签清洗）

## 目录结构

```
xy-ozon-0.13.31.1/
├── manifest.json               MV3 清单
├── package.json                依赖与脚本
├── docs/
│   └── follow-sell-portal-flow.md   流程文档(7 阶段 + ERP 依赖标记)
├── src/
│   ├── background/
│   │   ├── service-worker.js   消息路由 + 全流程编排
│   │   ├── mock-erp.js         🔴 Mock ERP(5 接口 + 公司护栏)
│   │   ├── mock-seller-portal.js 🟢 Mock seller portal(节流 + 403 + 草稿)
│   │   └── import-via-portal.js  viaPortal 编排核心(6a→6b→6c→6d)
│   ├── content/
│   │   ├── content.js          主入口(注入 ⚡ 按钮 + 面板)
│   │   ├── product-extractor.js  页面数据抓取
│   │   ├── follow-sell-panel.js  跟卖面板 UI + 提交
│   │   └── panel.css
│   ├── lib/
│   │   └── content-copy.js     纯函数库(描述/标签清洗)
│   └── popup/                  状态展示
└── tests/
    └── content-copy.test.js    纯函数库单测
```

## 安装与运行

### 1. 加载扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `xy-ozon-0.13.31.1/` 目录

### 2. 体验跟卖流程

1. 打开任意 Ozon 商品页（如 `https://www.ozon.ru/product/xxx-12345678/`）
2. 右上角出现 ⚡ 按钮，点击打开跟卖面板
3. 配置价格/库存/上架方式，点「一键上架至OZON」
4. 观察面板底部状态：Phase 1→2→3→4→5→6→7 逐步推进
5. 最终显示「门户上架完成！已创建 N 个商品」

### 3. 运行单测

```bash
cd xy-ozon-0.13.31.1
npm install
npm test
```

### 4. 格式化代码

```bash
npm run format        # 格式化
npm run format:check  # 仅检查
```

## 测试场景配置

在 `src/background/service-worker.js` 顶部或控制台注入配置：

```js
// 测试灰度回退
self.MOCK_ERP_CONFIG = { portalFlagOn: false };

// 测试公司护栏拦截
self.MOCK_ERP_CONFIG = { mockStoreCompanyId: '9999' };

// 测试反爬挑战
self.MOCK_SELLER_CONFIG = { antibotRate: 1 };

// 测试配额不足
self.MOCK_ERP_CONFIG = { listingUsed: 100 };
```

## 流程文档

完整的 7 阶段流程与 ERP 依赖分析见 [docs/follow-sell-portal-flow.md](docs/follow-sell-portal-flow.md)。

## 与原项目的差异

| 维度          | 原项目                    | 本 Demo                         |
| ------------- | ------------------------- | ------------------------------- |
| ERP           | 真实 `api.jizhangerp.com` | mock（`mock-erp.js`）           |
| seller portal | 真实 `seller.ozon.ru`     | mock（`mock-seller-portal.js`） |
| 变体展开      | 多轴 SSR + 弹窗补全       | 单变体（精简）                  |
| AI 重写/水印  | 后端 worker 执行          | 透传（mock）                    |
| 视频转存      | 真实 upload-file          | mock 返回 URL                   |
| 数据采集      | seller portal + buyer tab | seller portal mock              |
| 节流闸门      | ✅ 200ms                  | ✅ 保留                         |
| 403 细分      | ✅                        | ✅ 保留                         |
| 公司护栏      | ✅                        | ✅ 保留                         |
