# ERP 后端服务(轻量级个人版)设计文档

> 基于 `0.13.31.1` 插件项目接口契约,面向**个人单用户单设备**使用场景的精简实现。
>
> 目标:单机部署、零依赖、5 分钟启动、覆盖插件核心功能。

---

## 一、设计目标与原则

### 1.1 设计目标

| 维度 | 目标 |
| --- | --- |
| 部署 | 单机单进程,Docker 一键启动或 PM2 守护 |
| 资源 | 内存 < 200MB,无需独立数据库/缓存服务 |
| 启动 | 5 分钟内完成部署并对接插件 |
| 覆盖 | 插件核心跟卖流程(viaPortal + 官方 API)100% 可用 |
| 维护 | 单文件数据库,备份即拷文件 |

### 1.2 核心原则

- **单用户假设**:无多租户、无分销商、无多设备协同
- **单设备假设**:无分布式锁、无代采派单、无 lease 协调
- **配置优先**:灰度/配额/店铺等通过配置文件管理,不入库
- **透传优先**:AI 重写/水印等高级加工降级为透传,可后续按需接入
- **契约对齐**:保留的端点请求/响应结构与插件严格一致

---

## 二、功能裁剪清单

### 2.1 保留的核心功能(18 个端点)

| 模块 | 端点 | 用途 |
| --- | --- | --- |
| **鉴权** | `POST /auth/login-password` | 密码登录(简化,去掉验证码) |
| | `GET /auth/ozon-stores` | 店铺列表(配置文件返回) |
| **灰度** | `GET /feature-flags/me` | 灰度开关(配置文件) |
| **会员** | `GET /membership/usage-summary` | 配额(配置文件) |
| | `GET /membership/me` | 会员信息(配置文件) |
| | `GET /jidian/balance` | 极点余额(配置文件) |
| | `GET /jidian/pricing` | 极点定价(配置文件) |
| **跟卖** | `POST /ozon/products/prepare-bundle-items` | 门户上架备料 ⭐ |
| | `POST /ozon/products/import` | 官方 API 跟卖 |
| | `POST /ozon/products/import/status` | 任务状态查询 |
| | `GET /ozon/products/import-by-sku/tasks` | 历史任务列表 |
| | `POST /ozon/products/import-by-sku` | 简化跟卖 |
| **采集箱** | `POST /ozon/collect-box` | 加入采集箱 |
| | `PATCH /ozon/collect-box/:id` | 更新条目 |
| | `GET /ozon/collect-box` | 列表查询 |
| | `POST /ozon/favorites` | 加入收藏 |
| **商品数据** | `POST /ozon/product-data/batch` | 批量查询 |
| | `GET /ozon/product-data/:sku` | 单品查询 |
| **辅助** | `GET /ozon/warehouses` | 仓库列表(配置文件) |
| | `GET /ozon/categories/tree` | 类目树(透传 Ozon 或缓存) |
| | `GET /ozon/description-category/:typeId/attributes` | 类目属性 |
| | `GET /health` | 健康检查(选址探活) |

### 2.2 砍掉的功能(个人场景无需)

| 模块 | 砍掉原因 |
| --- | --- |
| **代采 browser-agents**(8 端点) | 单设备无需跨设备协作 |
| **Sync lease 锁**(3 端点) | 单设备无并发冲突 |
| **Sync client-report / cache-import** | 个人直接在插件端调 OPI |
| **短信验证码 /auth/send-code、/auth/sms/verify** | 改密码登录 |
| **图形验证码 /auth/captcha** | 个人无需防爆破 |
| **设备心跳 /auth/device/heartbeat** | 单设备无需 |
| **店铺 cookie 推送 PATCH /auth/ozon-stores/:id** | 单设备本地持有 |
| **扩展版本检查 /extension/latest** | 手动更新 |
| **L1 样本上报 /extension/l1-samples** | 调试用,个人无需 |
| **埋点 /usage/track** | 个人无需数据分析 |
| **AI 优化 /ozon/ai/***(4 端点) | 降级为透传,后续按需接入 |
| **多变体模板 /ozon/templates** | 非核心,后续按需 |
| **bestsellers 快照 /ozon/selection/** | 非核心,后续按需 |

---

## 三、技术栈

### 3.1 技术选型

| 层级 | 选型 | 理由 |
| --- | --- | --- |
| **运行时** | Node.js 20 LTS | 与插件同语言,类型可共享 |
| **框架** | Express 4 | 最轻量,中间件生态成熟,启动 < 1s |
| **数据库** | better-sqlite3 | 同步 API,零配置,单文件,性能足够 |
| **缓存** | node-cache(内存) | 替代 Redis,进程内缓存,无需独立服务 |
| **队列** | 简单 setTimeout + 内存 Map | 替代 BullMQ,个人任务量小 |
| **鉴权** | jsonwebtoken | JWT 无状态,无需 session 存储 |
| **日志** | pino | 性能最高的 Node.js logger |
| **配置** | dotenv + JSON 配置文件 | 环境变量 + 静态配置分离 |
| **HTTP 客户端** | undici | Node 内置,性能好,支持超时 |
| **部署** | Docker(可选)/ PM2 | 单容器或单进程 |

### 3.2 依赖清单(package.json)

```json
{
  "name": "erp-backend-lite",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/app.js",
    "dev": "node --watch src/app.js",
    "pm2": "pm2 start src/app.js --name erp-lite"
  },
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^11.0.0",
    "jsonwebtoken": "^9.0.2",
    "node-cache": "^5.1.2",
    "pino": "^9.1.0",
    "undici": "^6.19.0",
    "dotenv": "^16.4.5"
  }
}
```

**总依赖数:7 个,无原生编译依赖(better-sqlite3 有预编译二进制)**。

---

## 四、项目结构

```
erp-backend-lite/
├── src/
│   ├── app.js                    # 入口,Express app 装配
│   ├── config/
│   │   ├── index.js              # 环境变量加载
│   │   ├── stores.json           # 店铺配置(替代 ozon-stores 表)
│   │   ├── membership.json       # 会员/配额配置
│   │   └── feature-flags.json    # 灰度开关配置
│   ├── db/
│   │   ├── index.js              # better-sqlite3 初始化
│   │   └── schema.sql            # 建表脚本
│   ├── middleware/
│   │   ├── auth.js               # JWT 校验
│   │   ├── store.js              # x-ozon-store-id 解析
│   │   ├── error.js              # 统一错误处理
│   │   └── cdn-buster.js         # 容忍 ?_t= 查询参数
│   ├── modules/
│   │   ├── auth.js               # 鉴权路由
│   │   ├── feature-flags.js      # 灰度路由
│   │   ├── membership.js         # 会员路由
│   │   ├── products.js           # 跟卖核心路由
│   │   ├── collect-box.js        # 采集箱路由
│   │   ├── product-data.js       # 商品数据路由
│   │   └── misc.js               # 仓库/类目等辅助路由
│   ├── services/
│   │   ├── prepare-bundle.js     # prepare-bundle-items 加工逻辑
│   │   ├── ozon-opi.js           # Ozon OPI 客户端(api-seller.ozon.ru)
│   │   └── task-queue.js         # 简单内存任务队列
│   └── utils/
│       ├── response.js           # 统一响应封装
│       └── error-codes.js        # 错误码定义
├── data/
│   └── erp.db                    # SQLite 数据库文件(运行时生成)
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## 五、数据模型(SQLite)

### 5.1 表结构

```sql
-- 跟卖任务(对齐 /ozon/products/import 与 import-by-sku)
CREATE TABLE IF NOT EXISTS follow_sell_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id TEXT UNIQUE NOT NULL,          -- 客户端 jobId
  via_portal    INTEGER DEFAULT 0,             -- 0=官方API, 1=门户上架
  store_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|PROCESSING|SUCCESS|FAILED
  items_count   INTEGER DEFAULT 0,
  items_preview TEXT,                          -- JSON: 前 N 条摘要
  ozon_task_id  TEXT,                          -- 官方 API 返回的 task_id
  bundle_ids    TEXT,                          -- JSON: 门户上架 bundle_id 列表
  error_message TEXT,
  strict_skipped TEXT,                         -- JSON
  invalid_image  TEXT,                         -- JSON
  created_at    TEXT DEFAULT (datetime('now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_fst_status_created ON follow_sell_tasks(status, created_at DESC);

-- 采集箱
CREATE TABLE IF NOT EXISTS collect_box (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT,
  product     TEXT NOT NULL,                   -- JSON: 完整商品快照
  source      TEXT DEFAULT 'ozon',
  ai_draft    TEXT,                            -- JSON
  published   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cb_created ON collect_box(created_at DESC);

-- 收藏
CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product    TEXT NOT NULL,                    -- JSON
  sku        TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sku)
);

-- 商品数据缓存(对齐 /ozon/product-data/batch)
CREATE TABLE IF NOT EXISTS product_data_cache (
  sku        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,                    -- JSON: ProductData
  fetched_at TEXT DEFAULT (datetime('now'))
);

-- 异步任务状态(prepare-bundle-items 等长任务)
CREATE TABLE IF NOT EXISTS async_jobs (
  id         TEXT PRIMARY KEY,                 -- UUID
  type       TEXT NOT NULL,                    -- prepare-bundle|import
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  payload    TEXT,                             -- JSON: 入参
  result     TEXT,                             -- JSON: 结果
  error      TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 5.2 配置文件(替代数据库表)

**config/stores.json**(替代 `ozon_stores` 表):
```json
[
  {
    "id": "store-001",
    "name": "我的店铺",
    "company_id": "3891653",
    "warehouse_id": "wh-001",
    "sync_credentials": {
      "clientId": "your-client-id",
      "apiKey": "your-api-key"
    }
  }
]
```

**config/membership.json**(替代 `memberships` + `jidian_balance` 表):
```json
{
  "tier": "pro",
  "planName": "个人版",
  "daysLeft": 365,
  "caps": { "listing": 1000 },
  "usage": { "listing": 12 },
  "canUse": { "AI_EDIT": true },
  "jidianBalance": 500,
  "jidianPricing": { "AI_IMAGE": { "price": 50 } }
}
```

**config/feature-flags.json**(替代 `feature_flags` 表):
```json
{
  "ozon_portal_import": true
}
```

---

## 六、核心 API 设计

### 6.1 统一规范

**鉴权头**:
```
Authorization: Bearer ${jwt}
x-ozon-store-id: ${storeId}
Content-Type: application/json
```

**统一错误响应**(对齐插件 `apiRequest` 解析):
```json
{
  "code": "AUTH_EXPIRED",
  "message": "token 已过期"
}
```

**滑动续期**:JWT 有效期过半时,响应头返回 `X-Refreshed-Token`。

**CDN 防污染**:所有 GET 端点容忍 `?_t=${timestamp}`。

### 6.2 鉴权模块

```yaml
POST /auth/login-password
Body: { phoneNumber, password }
Response: {
  accessToken: "eyJhbGci...",
  user: { id: 1, phone: "13800138000" }
}
```

**实现**:校验 `.env` 中配置的 `USER_PHONE` + `USER_PASSWORD`(bcrypt hash),签发 7 天有效期的 JWT。无验证码、无短信、无多身份。

```yaml
GET /auth/ozon-stores
Headers: Authorization
Response: config/stores.json 内容
```

### 6.3 跟卖核心模块

#### `POST /ozon/products/prepare-bundle-items` ⭐

**这是门户上架(viaPortal=true)的核心端点**,对齐插件 `service-worker.js:645-652`。

```yaml
Headers: Authorization + x-ozon-store-id
Timeout: 120s
Body:
  items: [{
    offer_id, name, price, old_price,
    images: [url],
    _sourceVariant: { attributes: [{key, value}] },
    videoUrl, scraped_description,
    weight, depth, width, height, _stock
  }]
  applyAiImage: boolean
  applyWatermark: boolean
  storeId: string
  viaPortal: true

Response:
  result:
    bundles: [{
      items: [...],
      source: 'SOURCE_MERGED',
      description_category_lvl3_name: '类目名'
    }]
    store_company_id: "3891653"
    strictSkipped: []
    invalidImage: []
```

**实现逻辑**(services/prepare-bundle.js):

```javascript
async function prepareBundleItems(message, storeId) {
  const store = config.stores.find(s => s.id === storeId);
  const items = message.items || [];

  // 1. 类目分组(简化:按 description_category_lvl3_name 分组,无则归一类)
  const groups = {};
  for (const item of items) {
    const cat = item._sourceVariant?.description_category_id || 'default';
    (groups[cat] = groups[cat] || []).push(item);
  }

  // 2. 加工(个人版:透传,不做 AI 重写/水印)
  const bundles = Object.entries(groups).map(([cat, groupItems]) => ({
    items: groupItems.map(item => ({
      ...item,
      // 透传源变体属性(4497/9454-9456/7822/11254/4191/23171)
      _sourceVariant: item._sourceVariant,
    })),
    source: 'SOURCE_MERGED',
    description_category_lvl3_name: cat,
  }));

  // 3. 严格模式 + 无效图片(个人版:空数组,不校验)
  return {
    bundles,
    store_company_id: store.company_id,  // ⚠️ 护栏关键字段
    strictSkipped: [],
    invalidImage: [],
  };
}
```

#### `POST /ozon/products/import`

**官方 API 跟卖(viaPortal=false)**,对齐插件 `service-worker.js:3367-3374`。

```yaml
Body: 同 prepare-bundle-items(无需 viaPortal)
Response: { result: { task_id: "task-xxx" } }
```

**实现**:入库 `follow_sell_tasks`(status=PENDING)→ 调 Ozon OPI `/v3/product/import` → 更新状态 + ozon_task_id。

#### `POST /ozon/products/import/status`

```yaml
Body: { task_id }
Response: { status, processed, failed, size, done }
```

**实现**:查库 → 若未完成,调 Ozon OPI `/v1/product/import/info` 拉最新状态 → 返回。

#### `GET /ozon/products/import-by-sku/tasks`

```yaml
Query: current=1&pageSize=20
Response: { items: [{ localTaskId, status, createdAt, errorMessage, itemsPreview }] }
```

**实现**:直接查 `follow_sell_tasks` 表,按 created_at 倒序。

#### `POST /ozon/products/import-by-sku`

```yaml
Body: { items: [{ sku, offer_id, price, vat, currency_code }] }
Response: 任务对象
```

**实现**:入库 → 调 OPI → 返回。

### 6.4 采集箱模块

```yaml
POST /ozon/collect-box
Body: { product: {...} }
Response: { id, ... }

PATCH /ozon/collect-box/:id
Body: { ...更新字段 }
Response: 更新后条目

GET /ozon/collect-box?currentPage=1&pageSize=20
Response: { items: [...], total: N }

GET /ozon/collect-box?currentPage=1&pageSize=1   # popup 红点用,只取 total
```

**实现**:直接 CRUD `collect_box` 表。

### 6.5 商品数据模块

```yaml
POST /ozon/product-data/batch
Body: { skus: ["sku1", "sku2", ...] }
Response: { data: { "sku1": {...}, "sku2": {...} } }

GET /ozon/product-data/:sku?skipMarket=1
Response: { data: ProductData }
```

**实现**:
1. 先查 `product_data_cache` 表
2. 未命中 → 调 Ozon OPI `/v2/product/info` → 写缓存 → 返回
3. 缓存 TTL:1 小时(个人版可调)

### 6.6 配置类端点(直接返回配置文件)

```yaml
GET /feature-flags/me           → config/feature-flags.json
GET /membership/usage-summary   → config/membership.json 的 caps/usage
GET /membership/me              → config/membership.json 的 tier/daysLeft
GET /jidian/balance             → { balance: membership.jidianBalance }
GET /jidian/pricing             → { AI_IMAGE: {...}, _meta: {...} }
GET /ozon/warehouses            → 基于 config/stores.json 派生
GET /health                     → { ok: true, version: "1.0.0" }
```

---

## 七、关键业务流程

### 7.1 跟卖 viaPortal 完整流程

```
插件 content script
    │ 发 followSell 消息(viaPortal:true, items, 加工参数)
    ▼
插件 service-worker → POST /ozon/products/prepare-bundle-items
    │
    ▼
ERP 后端(本服务):
    1. 读取 config/stores.json 拿 store.company_id
    2. 类目分组 + 透传加工(个人版不做 AI/水印)
    3. 返回 { bundles, store_company_id }
    │
    ▼
插件 service-worker:
    4. 读 sc_company_id cookie
    5. 公司一致性护栏(store_company_id === sc_company_id?)
    6. 逐 bundle 调 seller.ozon.ru 门户三步:
       - /seller-prototype/create-bundle
       - /seller-prototype/update-bundle-items
       - /seller-prototype/upload-bundle
    7. 返回 { task_ids, bundle_ids }
    │
    ▼
插件轮询 seller.ozon.ru /async-upload/v1/task/get-list
    (不经过 ERP,直查 Ozon)
```

**关键**:本服务只负责第 1-3 步(备料),6-7 步由插件直连 seller.ozon.ru 完成,**绕开 Ozon 官方限流的核心价值保留**。

### 7.2 跟卖官方 API 流程(viaPortal=false)

```
插件 → POST /ozon/products/import
    │
    ▼
ERP 后端:
    1. 入库 follow_sell_tasks(status=PENDING)
    2. 调 Ozon OPI POST /v3/product/import
    3. 更新 ozon_task_id + status=PROCESSING
    4. 返回 { result: { task_id } }
    │
    ▼
插件轮询 POST /ozon/products/import/status
    │
    ▼
ERP 后端:
    1. 查库
    2. 若未完成 → 调 Ozon OPI /v1/product/import/info
    3. 更新状态 → 返回
```

### 7.3 滑动续期实现

```javascript
// middleware/auth.js
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;

    // 滑动续期:剩余有效期 < 50% 时重签
    const remaining = payload.exp - Math.floor(Date.now() / 1000);
    const total = payload.exp - payload.iat;
    if (remaining < total / 2) {
      const newToken = jwt.sign({ id: payload.id, phone: payload.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.setHeader('X-Refreshed-Token', newToken);
    }
    next();
  } catch (e) {
    res.status(401).json({ code: 'AUTH_EXPIRED', message: 'token 已过期' });
  }
}
```

---

## 八、错误码契约

对齐插件 `service-worker.js` 的 `classifyError` 逻辑:

| code | HTTP | 插件处理 | 说明 |
| --- | --- | --- | --- |
| `AUTH_EXPIRED` | 401 | 清 token + 弹登录 | token 失效 |
| `AUTH_REQUIRED` | 403 | 不重试 | 权限不足 |
| `ResourceNotFound` | 404 | 不重试,降级空结果 | 资源不存在 |
| `VALIDATION_ERROR` | 422 | 不重试 | 参数校验失败 |
| `QUOTA_EXCEEDED` | 429 | 不重试 | 配额超限 |
| `TIMEOUT` | 408 | 重试 2 次 | 请求超时 |
| `RATE_LIMITED` | 429 | 指数退避重试 | 限流 |
| `NETWORK_ERROR` | 503 | 重试 2 次 | 服务异常 |
| `INTERNAL_ERROR` | 500 | 重试 2 次 | 内部错误 |

---

## 九、部署方案

### 9.1 方案 A:Docker 单容器(推荐)

**Dockerfile**:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
VOLUME /app/data
VOLUME /app/config
EXPOSE 3001
CMD ["node", "src/app.js"]
```

**docker-compose.yml**:
```yaml
version: '3.8'
services:
  erp-lite:
    build: .
    ports:
      - "3001:3001"
    volumes:
      - ./data:/app/data          # SQLite 持久化
      - ./config:/app/config      # 配置文件
    environment:
      - JWT_SECRET=your-secret-here
      - USER_PHONE=13800138000
      - USER_PASSWORD=$2b$10$xxx  # bcrypt hash
      - PORT=3001
    restart: unless-stopped
```

**启动**:
```bash
docker compose up -d
```

### 9.2 方案 B:PM2 直部署

```bash
# 安装
npm install

# 配置 .env
cp .env.example .env
# 编辑 .env 填入 JWT_SECRET / USER_PHONE / USER_PASSWORD

# 初始化数据库
node src/db/index.js

# 启动(PM2 守护)
npm run pm2
pm2 save
pm2 startup
```

### 9.3 .env.example

```env
# 服务端口
PORT=3001

# JWT 密钥(必填,随机长字符串)
JWT_SECRET=change-this-to-a-random-long-string

# 单用户账号(必填)
USER_PHONE=13800138000
USER_PASSWORD=$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy  # bcrypt hash of "password"

# Ozon OPI(官方 API 跟卖用,可选)
OZON_OPI_BASE_URL=https://api-seller.ozon.ru

# 日志级别
LOG_LEVEL=info
```

---

## 十、与插件对接

### 10.1 插件端配置

修改插件 `service-worker.js` 的 `BACKEND_URLS`:

```javascript
// 开发环境(本服务)
BACKEND_URLS = ['http://localhost:3001', 'https://api.jizhangerp.com'];

// 或生产环境(部署到服务器)
BACKEND_URLS = ['https://your-domain.com:3001'];
```

插件启动时会调 `GET /health` 选址,本服务提供该端点即可被选中。

### 10.2 manifest.json host_permissions

若部署到 HTTPS 域名,需在插件 `manifest.json` 的 `host_permissions` 添加:
```json
"https://your-domain.com:3001/*"
```

若本地 localhost,Chrome 默认允许。

### 10.3 登录流程

1. 插件 popup 输入手机号 + 密码
2. 调 `POST /auth/login-password` 获取 `accessToken`
3. 存入 `chrome.storage.local.ozonAuthToken`
4. 后续所有请求自动带 `Authorization: Bearer ${token}`

---

## 十一、可观测性(简化)

### 11.1 日志(pino)

```javascript
// 统一请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      userId: req.user?.id,
      storeId: req.headers['x-ozon-store-id'],
    });
  });
  next();
});
```

日志输出到 `stdout`,Docker 自动收集。个人使用可直接 `docker logs -f erp-lite`。

### 11.2 简单健康检查

```yaml
GET /health
Response: { ok: true, version: "1.0.0", uptime: 3600 }
```

PM2 或 Docker 健康检查:
```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:3001/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

---

## 十二、备份与恢复

### 12.1 备份

**SQLite 文件备份**(在线备份,不阻塞写入):
```bash
# 方式 1:直接拷文件(需停服或用 .backup 命令)
sqlite3 data/erp.db ".backup data/erp-backup-$(date +%Y%m%d).db"

# 方式 2:Docker 卷快照
docker run --rm -v erp-lite_data:/data alpine tar czf - /data > backup.tar.gz
```

**配置文件备份**:`config/` 目录直接拷贝。

### 12.2 恢复

```bash
# 停服 → 替换 data/erp.db → 启动
docker compose down
cp erp-backup-20260701.db data/erp.db
docker compose up -d
```

### 12.3 定时备份(crontab)

```bash
# 每日凌晨 3 点备份
0 3 * * * sqlite3 /app/data/erp.db ".backup /backup/erp-$(date +\%Y\%m\%d).db"
```

---

## 十三、后续扩展方向

个人版优先满足核心流程,以下功能预留接口,按需渐进接入:

| 扩展 | 触发条件 | 实现方式 |
| --- | --- | --- |
| **AI 重写/水印** | 需要提升商品差异化 | 接入 OpenAI / Stable Diffusion API,在 prepare-bundle 加工链路增加步骤 |
| **Redis 缓存** | 商品数据查询量大 | 将 node-cache 替换为 Redis,不影响业务代码 |
| **多店铺** | 经营多个 Ozon 店铺 | `config/stores.json` 增加条目,`x-ozon-store-id` 路由 |
| **代采** | 需跨设备协作 | 启用 browser-agents 模块(参考完整版设计) |
| **Sync 同步** | 需要商品/订单本地缓存 | 启用 sync 模块 + lease 锁(参考完整版设计) |
| **PostgreSQL 迁移** | 数据量超 10GB | better-sqlite3 → pg,SQL 语句兼容,改连接层即可 |

---

## 十四、总结

| 维度 | 轻量版 | 完整版(企业) |
| --- | --- | --- |
| 端点数 | 18 个 | 78 个 |
| 依赖服务 | 无(SQLite + 内存) | PostgreSQL + Redis + BullMQ |
| 部署 | 单容器 / PM2 | K8s 多副本 |
| 内存占用 | < 200MB | 数 GB |
| 启动时间 | < 1s | 数十秒 |
| 覆盖功能 | 跟卖核心 + 采集 + 商品数据 | 全功能 |
| 维护成本 | 极低 | 需专人运维 |

**一句话**:本设计以最小成本覆盖插件跟卖核心流程,单文件数据库 + 配置文件驱动,5 分钟 Docker 启动,个人使用足够;后续随业务增长可平滑升级到完整版。
