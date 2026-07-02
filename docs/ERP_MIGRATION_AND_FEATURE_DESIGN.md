# ERP 迁移与功能补全设计文档

> 项目：xy-ozon 插件 + erp-backend-lite
> 版本：v1.0
> 日期：2026-07-02
> 范围：将插件端所有指向 my.jizhangerp.com 的入口改指向本项目 ERP，并补全 ERP 后端缺失功能

---

## 一、现状梳理

### 1.1 插件端指向 my.jizhangerp.com 的位置（共 4 处）

| # | 文件 | 行 | 当前代码 | 用途 |
|---|------|----|---------|------|
| 1 | `src/popup/popup.js` | 121 | `chrome.tabs.create({ url: 'https://my.jizhangerp.com/login' })` | popup「网页登录」按钮 |
| 2 | `src/popup/popup.js` | 168 | `chrome.tabs.create({ url: 'https://my.jizhangerp.com' + ACTION_PATHS[action] })` | popup 导航按钮（7 个路径） |
| 3 | `src/content/action-bar.js` | 293 | `window.open('https://my.jizhangerp.com', '_blank')` | 商品页「进入 ERP」按钮 |
| 4 | `README.md` | 98 | `真实 api.jizhangerp.com` | 文档说明（非代码） |

**重要发现**：这 4 处都是「前端网页跳转」，不是 API 端点。真正的 ERP API 地址走 `erp-client.js` 的 `DEFAULT_BASE_URL = 'http://localhost:3001'`，已通过 `chrome.storage.local.erpBaseUrl` 解耦。

### 1.2 插件端硬编码默认值清单

| 类别 | 文件:行 | 硬编码值 | 说明 |
|------|---------|---------|------|
| AI 改写开关 | `follow-sell-panel.js:1690` | `applyAiRewrite: false` | 提交时硬关闭，UI 开关不生效 |
| 水印开关 | `follow-sell-panel.js:1689` | `applyWatermark: false` | 同上 |
| 视频转存开关 | `follow-sell-panel.js:1481` | `ENABLE_VIDEO_TRANSFER = false` | 源码级硬编码 |
| AI 改写配额 | `erp-client.js:187` | `aiRewrite.unlimited: true` | 绕过后端配额 |
| 默认划线价 | `follow-sell-panel.js:1390` | `priceVal * 1.25` | 加价率硬编码 |
| 折扣约束 | `follow-sell-panel.js:1392` | `priceVal / 0.15` | Ozon 折扣阈值硬编码 |
| 售价上限 | `follow-sell-panel.js:1371` | `9_999_999` | — |
| 库存上限 | `follow-sell-panel.js:1372` | `1_000_000` | — |
| 默认库存 | `follow-sell-panel.js:273,517` | `10` | 多变体/单变体均硬编码 |
| 批量上架默认库存 | `batch-upload/index.html:232` | `10` | — |
| 汇率 | `pricing-panel.js:12` | `RATE_RUB = 11.08` | 固定汇率（mock） |
| 类目佣金率 | `pricing-panel.js:13-19` | `COMMISSION_RATES = {...}` | 5 个类目固定费率 |
| 物流费 | `pricing-panel.js:20-21` | `LOGISTICS_COST / PROFIT_LOGISTICS` | 固定费率表 |
| 水印模板 | `follow-sell-panel.js:570-572` | `tpl-1` 唯一选项 | 模板硬编码 |
| 批量上架店铺 | `batch-upload/index.html:145` | `store-001` | mock 单店 |

### 1.3 ERP 后端现有资产

#### 数据表（6 张）

| 表名 | 用途 | 行数级 |
|------|------|--------|
| `follow_sell_tasks` | 跟卖任务主表 | 百级 |
| `follow_sell_task_items` | 上架明细（每 offer_id） | 千级 |
| `collect_box` | 采集箱 | 千级 |
| `favorites` | 收藏 | 百级 |
| `product_data_cache` | 商品数据缓存（SKU→JSON） | 万级 |
| `async_jobs` | 异步任务 | 百级 |

#### API 端点（49 个，按模块）

| 模块 | 端点数 | 状态 |
|------|--------|------|
| auth | 7（login/ozon-stores/captcha/send-code/sms/verify/heartbeat） | ✅ |
| admin | 10（stores CRUD + warehouses + test-connection + listing-records） | ✅ |
| products | 8（prepare/import/import-info/import-status/import-by-sku/info/listing-records/report） | ✅ |
| collect-box | 4（CRUD + batch + favorites） | ✅ |
| product-data | 2（batch + get by sku） | ✅ |
| misc | 9（health/warehouses/categories/attributes/cache/extension/usage） | ✅ |
| feature-flags | 1 | ✅ |
| membership | 4 | ✅ |
| agents | 3（browser-agents collection-jobs） | ✅ |

#### Admin 前端页面（1 个）

- `/admin` → `admin.html`：店铺管理 + 上架记录 两个 tab

---

## 二、改造目标

1. **插件端**：所有 ERP 入口改指向本项目 `erp-backend-lite`，消除 jizhangerp 硬编码
2. **ERP 后端**：补全 admin 前端页面，覆盖插件用到的所有功能
3. **配置中心**：将插件硬编码默认值迁移到后端可配置
4. **批量上架**：接入真实 ERP，持久化任务状态

---

## 三、插件端改造方案

### 3.1 统一 ERP 入口地址

#### 3.1.1 新增 service-worker action：`getErpBaseUrl`

```js
// service-worker.js 新增 case
case 'getErpBaseUrl': {
  const baseUrl = await self.ErpClient.getBaseUrl();
  return sendResponse({ ok: true, baseUrl });
}
```

```js
// erp-client.js 暴露 getBaseUrl（已有内部方法，改为公开）
async getBaseUrl() {
  return getBaseUrl();
}
```

#### 3.1.2 popup.js 改造

**「网页登录」按钮**（line 121）：

```js
// 改造前
chrome.tabs.create({ url: 'https://my.jizhangerp.com/login' });

// 改造后
const { baseUrl } = await sendMessage({ type: 'getErpBaseUrl' });
chrome.tabs.create({ url: baseUrl + '/admin' });  // 本 ERP 无独立登录页,admin 自带登录视图
```

**导航按钮跳转**（line 147-168）：

```js
// 改造前
const ACTION_PATHS = {
  dashboard: '/ozon/dashboard',
  products: '/ozon/products/list',
  'collect-box': '/ozon/products/collect',
  'import-history': '/ozon/products/import-history',
  reshelf: '/ozon/products/reshelf',
  watermark: '/ozon/tools/watermark',
  stores: '/ozon/settings/stores',
};
chrome.tabs.create({ url: 'https://my.jizhangerp.com' + ACTION_PATHS[action] });

// 改造后:路径映射到本 ERP admin 页面的 hash 路由
const ACTION_HASHES = {
  dashboard: '#dashboard',           // 首页统计(新)
  products: '#products',             // 商品列表(新,查 product_data_cache)
  'collect-box': '#collect-box',    // 采集箱(新)
  'import-history': '#listings',    // 上架记录(已有)
  reshelf: '#listings',              // 重新上架(暂并入上架记录)
  watermark: '#config',              // 水印配置并入配置中心(新)
  stores: '#stores',                 // 店铺管理(已有)
};
const { baseUrl } = await sendMessage({ type: 'getErpBaseUrl' });
chrome.tabs.create({ url: baseUrl + '/admin' + ACTION_HASHES[action] });
```

#### 3.1.3 action-bar.js 改造

```js
// 改造前 (line 293)
function onErp() {
  window.open('https://my.jizhangerp.com', '_blank');
}

// 改造后
async function onErp() {
  const { baseUrl } = await chrome.runtime.sendMessage({ type: 'getErpBaseUrl' });
  window.open(baseUrl + '/admin', '_blank');
}
```

#### 3.1.4 manifest.json 调整

当前 `host_permissions` 仅含 `localhost:3001` 和 `127.0.0.1:3001`。若未来部署到服务器，需补充：

```json
"host_permissions": [
  "http://localhost:3001/*",
  "http://127.0.0.1:3001/*",
  "https://your-erp-domain.com/*"
]
```

### 3.2 配置中心拉取

插件启动时从 ERP 拉取配置，替换硬编码默认值。

#### 3.2.1 新增 service-worker action：`getConfig`

```js
case 'getConfig': {
  const resp = await self.ErpClient.get('/app-config', { scope: 'extension' });
  return sendResponse({ ok: true, data: resp });
}
```

#### 3.2.2 follow-sell-panel.js 消费配置

```js
// 面板初始化时拉取配置
const configResp = await sendMessage({ type: 'getConfig' });
const cfg = configResp?.data || {};

// 替换硬编码
const PRICE_MAX = cfg.price_max ?? 9_999_999;
const STOCK_MAX = cfg.stock_max ?? 1_000_000;
const DEFAULT_STOCK = cfg.default_stock ?? 10;
const OLD_PRICE_RATIO = cfg.old_price_ratio ?? 1.25;
const DISCOUNT_THRESHOLD = cfg.discount_threshold ?? 0.15;
const ENABLE_VIDEO_TRANSFER = cfg.enable_video_transfer ?? false;
```

#### 3.2.3 pricing-panel.js 消费配置

```js
const cfg = await sendMessage({ type: 'getConfig' });
const RATE_RUB = cfg.rate_rub ?? 11.08;
const COMMISSION_RATES = cfg.commission_rates ?? { beauty_mid: 0.15, ... };
const LOGISTICS_COST = cfg.logistics_cost ?? { xs: 8, ... };
```

### 3.3 batch-upload 接入 ERP

当前 batch-upload 是纯 mock（`submitMock()`），需改造为真实调用。

#### 3.3.1 店铺/仓库下拉填充

```js
// batch-upload/index.js 新增
async function initStores() {
  const { data: stores } = await chrome.runtime.sendMessage({ type: 'getStores' });
  const storeSelect = document.getElementById('cfg-store');
  storeSelect.innerHTML = stores.map(s =>
    `<option value="${s.id}">${s.name} (${s.currency_code || 'RUB'})</option>`
  ).join('');
  // 联动仓库
  storeSelect.addEventListener('change', async () => {
    const { data } = await chrome.runtime.sendMessage({ type: 'getWarehouses', storeId: storeSelect.value });
    // 填充仓库下拉
  });
}
```

#### 3.3.2 提交逻辑改造

```js
// 改造前: submitMock()
// 改造后: 逐条调 followSell,汇总结果
async function submitReal() {
  const items = collectFormItems();
  const { baseUrl } = await chrome.runtime.sendMessage({ type: 'getErpBaseUrl' });
  // 调用 followSell action 逐条上架,实时更新 UI 进度
  for (const item of items) {
    const res = await chrome.runtime.sendMessage({ type: 'followSell', ...item });
    updateProgress(item, res);
  }
}
```

---

## 四、ERP 后端功能补全方案

### 4.1 Admin 前端页面扩展

#### 4.1.1 Tab 结构（7 个）

```
/admin
├── #dashboard      首页统计(新)
├── #stores         店铺管理(已有)
├── #listings       上架记录(已有)
├── #collect-box    采集箱(新)
├── #products       商品列表(新)
├── #batch          批量上架任务(新)
└── #config         配置中心(新)
```

#### 4.1.2 各 Tab 功能详述

**① #dashboard 首页统计**

数据来源：现有表聚合查询，无需新表。

```sql
-- 今日上架数/成功率
SELECT status, COUNT(*) FROM follow_sell_tasks
WHERE date(created_at) = date('now') GROUP BY status;

-- 采集箱数量
SELECT COUNT(*) FROM collect_box WHERE published = 0;

-- 近 7 天上架趋势
SELECT date(created_at) d, COUNT(*) n FROM follow_sell_tasks
WHERE created_at > datetime('now', '-7 days') GROUP BY d;
```

UI：4 个统计卡片 + 1 个折线图（近 7 天上架趋势）。

**② #stores 店铺管理**（已有，无需改动）

**③ #listings 上架记录**（已有，无需改动）

**④ #collect-box 采集箱**（新）

后端 API 已有：`GET/POST /ozon/collect-box`、`POST /ozon/collect-box/batch`、`POST /ozon/favorites`。

UI：
- 列表：卡片式展示，每张卡显示商品图、标题、来源、采集时间、状态
- 操作：加入收藏、删除、一键上架（跳转到商品页激活面板）
- 筛选：按店铺/状态(未发布/已发布)筛选

**⑤ #products 商品列表**（新）

后端 API 已有：`GET /ozon/products/cache`、`GET /ozon/products/cache/status-counts`。

数据来源：`product_data_cache` 表。

UI：
- 列表：表格展示 SKU、标题、价格、采集时间
- 搜索：按 SKU/标题模糊搜索
- 详情：点击行展开 JSON 完整数据

**⑥ #batch 批量上架任务**（新）

需新增数据表和 API（见 4.2）。

UI：
- 列表：任务 ID、店铺、商品数、进度、状态、时间
- 详情：每个商品的上架结果（复用 listing-records 详情组件）
- 操作：删除、重试失败项

**⑦ #config 配置中心**（新）

需新增数据表和 API（见 4.3）。

UI：表单分组：
- 价格配置：售价上限、默认加价率、折扣阈值
- 库存配置：默认库存、库存上限
- 功能开关：视频转存、AI 改写、水印
- 定价配置：汇率、类目佣金率、物流费
- 水印模板：模板列表（增删改）

### 4.2 批量上架任务管理

#### 4.2.1 新增数据表

```sql
-- 批量上架任务
CREATE TABLE IF NOT EXISTS batch_upload_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,
  store_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  config         TEXT,  -- JSON: 水印/AI/库存等配置快照
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_but_store_created ON batch_upload_tasks(store_id, created_at DESC);

-- 批量上架任务明细(每个商品一行,关联 follow_sell_task_items)
CREATE TABLE IF NOT EXISTS batch_upload_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_task_id   TEXT NOT NULL,
  source_sku      TEXT,
  source_url      TEXT,
  follow_task_id  TEXT,  -- 关联 follow_sell_tasks.local_task_id
  status          TEXT DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bui_batch ON batch_upload_items(batch_task_id);
```

#### 4.2.2 新增 API

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/ozon/products/batch-import` | 创建批量上架任务 |
| GET | `/ozon/products/batch-import` | 批量任务列表(分页) |
| GET | `/ozon/products/batch-import/:localTaskId` | 批量任务详情(含明细) |
| DELETE | `/ozon/products/batch-import/:localTaskId` | 删除批量任务 |
| POST | `/ozon/products/batch-import/:localTaskId/retry` | 重试失败项 |

#### 4.2.3 批量上架流程

```
插件 batch-upload 提交
  ↓
POST /ozon/products/batch-import (创建任务 + N 个 items)
  ↓
ERP 逐条调 /ozon/products/import (复用现有单条上架逻辑)
  ↓
每条完成后更新 batch_upload_items.status
  ↓
全部完成后汇总 batch_upload_tasks.status
  ↓
插件轮询 GET /ozon/products/batch-import/:id 查进度
```

### 4.3 配置中心

#### 4.3.1 新增数据表

```sql
-- 应用配置(key-value)
CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,     -- JSON 值
  scope       TEXT DEFAULT 'extension',  -- extension/pricing/watermark
  description TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- 水印模板
CREATE TABLE IF NOT EXISTS watermark_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,  -- JSON: 文字/位置/透明度/字体等
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
```

#### 4.3.2 新增 API

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/app-config` | 获取配置(query: scope) |
| PUT | `/app-config` | 更新配置 |
| GET | `/watermark-templates` | 水印模板列表 |
| POST | `/watermark-templates` | 新建水印模板 |
| PUT | `/watermark-templates/:id` | 更新水印模板 |
| DELETE | `/watermark-templates/:id` | 删除水印模板 |

#### 4.3.3 默认配置项

```js
// app_config 默认数据(seed)
{
  // extension scope
  'price_max': 9999999,
  'stock_max': 1000000,
  'default_stock': 10,
  'old_price_ratio': 1.25,
  'discount_threshold': 0.15,
  'enable_video_transfer': false,
  'enable_ai_rewrite': false,
  'enable_watermark': false,

  // pricing scope
  'rate_rub': 11.08,
  'commission_rates': { beauty_mid: 0.15, beauty_high: 0.17, electronics: 0.13, apparel: 0.14, home: 0.12 },
  'logistics_cost': { xs: 8, budget: 12, small: 18, big: 35 },
  'profit_logistics': { guoo: 0.06, cel: 0.055, xy: 0.05, zto: 0.065 },
}
```

### 4.4 操作日志（审计）

#### 4.4.1 新增数据表

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,    -- store.create/store.delete/listing.import/...
  target     TEXT,             -- 操作对象 ID
  store_id   TEXT,
  operator   TEXT,             -- 用户标识(个人版固定)
  detail     TEXT,             -- JSON 详情
  ip         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
```

#### 4.4.2 新增 API

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/admin/api/audit-logs` | 操作日志列表(分页+筛选) |

#### 4.4.3 记录点

在以下操作后自动写入 audit_logs：
- 店铺增删改
- 上架提交（import/report）
- 采集箱增删
- 配置变更
- 批量上架创建/删除

### 4.5 重新上架（reshelf）

#### 4.5.1 实现方式

复用现有 `/ozon/products/import` 接口，传入已下架商品的 offer_id 和原数据。

#### 4.5.2 UI

在上架记录详情页，对状态为 `failed` 的 item 增加「重试」按钮，调用 `POST /ozon/products/import` 重新提交单条。

### 4.6 水印工具

#### 4.6.1 实现方式

水印模板存后端 `watermark_templates` 表，渲染在插件 content script 端完成（用 Canvas API）。

#### 4.6.2 流程

```
插件采集图片 → 拉取水印模板配置 → Canvas 渲染水印 → 上传到 Ozon
```

ERP 后端只负责模板 CRUD，不参与图片处理。

---

## 五、实施计划

### 5.1 优先级与任务拆解

| 优先级 | 任务 | 涉及文件 | 说明 |
|--------|------|---------|------|
| **P0** | 插件端跳转改指向本 ERP | popup.js / action-bar.js / service-worker.js / erp-client.js | 消除 4 处 jizhangerp 硬编码 |
| **P0** | admin 加采集箱 tab | admin.html / admin.js / admin.css | 后端 API 已有,只差页面 |
| **P0** | admin 加商品列表 tab | admin.html / admin.js / admin.css | 后端 API 已有,只差页面 |
| **P1** | 配置中心(表+API+页面) | schema.sql / modules/config.js / admin.html / admin.js | 替代插件硬编码 |
| **P1** | 插件端消费配置中心 | follow-sell-panel.js / pricing-panel.js / service-worker.js | 拉取配置替换硬编码 |
| **P1** | admin 加首页统计 tab | admin.html / admin.js | 聚合现有表查询 |
| **P2** | 批量上架任务管理 | schema.sql / modules/batch.js / admin.html / admin.js | 新表+新 API+新页面 |
| **P2** | batch-upload 接入 ERP | batch-upload/index.js / index.html | 替换 mock,真实上架 |
| **P2** | 操作日志 | schema.sql / middleware/audit.js / admin.html | 审计记录 |
| **P3** | 重新上架(失败重试) | admin.js / products.js | 上架记录详情加重试按钮 |
| **P3** | 水印工具 | modules/config.js / follow-sell-panel.js | 模板 CRUD + Canvas 渲染 |

### 5.2 文件变更清单

#### 插件端（xy-ozon）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/background/erp-client.js` | 改 | 暴露 `getBaseUrl()` |
| `src/background/service-worker.js` | 改 | 新增 `getErpBaseUrl`/`getConfig` action |
| `src/popup/popup.js` | 改 | 跳转改用 baseUrl + ACTION_HASHES |
| `src/content/action-bar.js` | 改 | onErp 改用 baseUrl |
| `src/content/follow-sell-panel.js` | 改 | 消费配置中心,替换硬编码 |
| `src/content/pricing-panel.js` | 改 | 消费配置中心,替换硬编码 |
| `src/batch-upload/index.js` | 改 | 接入 ERP,替换 mock |
| `src/batch-upload/index.html` | 改 | 店铺下拉动态填充 |
| `README.md` | 改 | 更新文档 |

#### ERP 后端（erp-backend-lite）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/db/schema.sql` | 改 | 新增 4 张表(app_config/watermark_templates/batch_upload_tasks/batch_upload_items/audit_logs) |
| `src/db/seed.js` | 改 | 新增配置中心默认数据 |
| `src/modules/config.js` | 新建 | 配置中心 + 水印模板路由 |
| `src/modules/batch.js` | 新建 | 批量上架任务路由 |
| `src/modules/admin.js` | 改 | 新增采集箱/商品列表/首页统计/批量任务/配置中心/操作日志的 admin API |
| `src/middleware/audit.js` | 新建 | 审计日志中间件 |
| `src/app.js` | 改 | 注册新路由 |
| `src/public/admin.html` | 改 | 新增 5 个 tab |
| `src/public/admin.js` | 改 | 新增 5 个 tab 的前端逻辑 |
| `src/public/admin.css` | 改 | 新增样式 |

---

## 六、数据模型汇总

### 6.1 新增表（5 张）

```sql
-- 1. 应用配置
CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  scope       TEXT DEFAULT 'extension',
  description TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- 2. 水印模板
CREATE TABLE IF NOT EXISTS watermark_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- 3. 批量上架任务
CREATE TABLE IF NOT EXISTS batch_upload_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,
  store_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  config         TEXT,
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);

-- 4. 批量上架明细
CREATE TABLE IF NOT EXISTS batch_upload_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_task_id   TEXT NOT NULL,
  source_sku      TEXT,
  source_url      TEXT,
  follow_task_id  TEXT,
  status          TEXT DEFAULT 'PENDING',
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- 5. 操作日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  target     TEXT,
  store_id   TEXT,
  operator   TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 6.2 现有表（6 张，无变更）

- `follow_sell_tasks`
- `follow_sell_task_items`
- `collect_box`
- `favorites`
- `product_data_cache`
- `async_jobs`

---

## 七、API 端点汇总

### 7.1 新增端点（14 个）

| 方法 | 路径 | 模块 | 说明 |
|------|------|------|------|
| GET | `/app-config` | config | 获取配置 |
| PUT | `/app-config` | config | 更新配置 |
| GET | `/watermark-templates` | config | 水印模板列表 |
| POST | `/watermark-templates` | config | 新建水印模板 |
| PUT | `/watermark-templates/:id` | config | 更新水印模板 |
| DELETE | `/watermark-templates/:id` | config | 删除水印模板 |
| POST | `/ozon/products/batch-import` | batch | 创建批量上架任务 |
| GET | `/ozon/products/batch-import` | batch | 批量任务列表 |
| GET | `/ozon/products/batch-import/:localTaskId` | batch | 批量任务详情 |
| DELETE | `/ozon/products/batch-import/:localTaskId` | batch | 删除批量任务 |
| POST | `/ozon/products/batch-import/:localTaskId/retry` | batch | 重试失败项 |
| GET | `/admin/api/audit-logs` | admin | 操作日志列表 |
| GET | `/admin/api/dashboard-stats` | admin | 首页统计数据 |
| GET | `/admin/api/collect-box` | admin | 采集箱列表(admin 用) |

### 7.2 现有端点（49 个，无变更）

详见 1.3 节。

---

## 八、验证清单

### 8.1 插件端验证

- [ ] popup 所有导航按钮跳转到 `localhost:3001/admin#xxx`
- [ ] action-bar「进入 ERP」按钮跳转到 `localhost:3001/admin`
- [ ] popup「网页登录」按钮跳转到 `localhost:3001/admin`(自带登录视图)
- [ ] 全项目 grep `jizhangerp` 仅剩 README 文档说明
- [ ] follow-sell-panel 硬编码默认值改为从配置中心读取
- [ ] pricing-panel 汇率/佣金/物流费改为从配置中心读取
- [ ] batch-upload 店铺下拉动态填充
- [ ] batch-upload 提交真实调用 ERP 接口

### 8.2 ERP 后端验证

- [ ] `npm run seed` 初始化新表 + 默认配置数据
- [ ] `npm start` 启动无报错
- [ ] `/admin` 页面 7 个 tab 都可访问
- [ ] 配置中心 GET/PUT 接口正常
- [ ] 水印模板 CRUD 接口正常
- [ ] 批量上架任务 CRUD 接口正常
- [ ] 操作日志自动记录关键操作
- [ ] 首页统计数据正确聚合

### 8.3 集成验证

- [ ] 插件上架时 currency_code 从配置中心读取
- [ ] 插件上架记录在 admin「上架记录」tab 可见
- [ ] 批量上架任务在 admin「批量上架」tab 可见
- [ ] 配置中心修改默认库存后,插件面板默认值同步变化

---

## 九、风险与注意事项

1. **manifest host_permissions**：若 ERP 部署到非 localhost 域名,需同步更新 manifest.json 的 host_permissions,否则 fetch 会被 CORS 拦截。

2. **配置缓存**：插件每次拉取配置会有网络开销,建议在 service-worker 内存缓存 5 分钟,避免频繁请求。

3. **批量上架并发控制**：批量上架逐条调 `/ozon/products/import`,需控制并发(建议 1 条/次,串行),避免触发 Ozon API 限流。

4. **配置变更生效**：配置中心修改后,已打开的面板不会自动刷新,需用户重新打开面板。可加 `chrome.storage.onChanged` 监听实现实时同步(可选)。

5. **数据迁移**：新增 5 张表不影响现有数据,`schema.sql` 用 `CREATE TABLE IF NOT EXISTS`,可直接重启服务自动建表。

6. **Prettier 格式**：所有代码变更需通过 `npm run format:check` 校验。
