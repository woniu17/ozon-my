# Ozon Webhook 接收服务 — 设计文档

> 状态:设计已确认,脚手架阶段
> 创建时间:2026-08-19
> 关联文档:[Ozon 推送通知 API](../ozon-api/16-推送通知.md)

## 1. 概述与目标

接收 Ozon 卖家平台主动推送的事件通知(订单/商品/库存/聊天等),落库并异步处理,确保:

- **5 秒内必返回**给 Ozon(否则触发自动暂停推送)
- 严格符合 [Ozon 响应规范](../ozon-api/16-推送通知.md#4-您服务器的回复)
- 重复推送幂等去重
- 业务失败由本地 Poller 重试,不让 Ozon 感知(避免 24h 持续报错触发暂停)

## 2. 部署形态

**独立服务项目**(进程隔离,端口独立),位于 `c:\root\code\ozon-my\ozon-webhook\`。

- 与 erp-backend-lite **不共享数据库文件**(避免 SQLite 锁竞争)
- 与 erp-backend-lite **共享 OPI 凭据**(同一 seller_id)
- **暂不联动 erp**(首批只把事件落库 + 自维护业务表,后续可通过 HTTP API 联动)

## 3. 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| 运行时 | Node.js ≥22.5.0 | 用 `--experimental-sqlite` 启用内置 SQLite |
| Web 框架 | Koa 2.x + `@koa/router` + `koa-bodyparser` | 遵循项目记忆硬约束,async/await 原生 |
| DB | `node:sqlite`(SQLite,默认) | 可选 MongoDB |
| HTTP 客户端 | undici | 回拉 OPI 详情(`TYPE_NEW_POSTING` 用) |
| 日志 | pino | 与 erp-backend-lite 一致 |
| 鉴权 | 无 JWT,IP 白名单 | Ozon 无法携带 JWT |

## 4. 项目结构

```
ozon-webhook/
├── src/
│   ├── app.js                  # Koa 入口
│   ├── config/index.js         # 配置加载
│   ├── middleware/
│   │   ├── ip-whitelist.js     # Ozon IP 白名单(3 段)
│   │   ├── error.js            # 错误处理(返回 Ozon 错误模板)
│   │   └── log.js              # pino 请求日志
│   ├── modules/webhook.js     # /webhook/ozon 端点
│   ├── handlers/
│   │   ├── index.js            # message_type → handler 分发表
│   │   ├── new-posting.js
│   │   ├── posting-cancelled.js
│   │   ├── state-changed.js
│   │   ├── cutoff-date-changed.js
│   │   ├── delivery-date-changed.js
│   │   ├── create-or-update-item.js
│   │   └── stocks-changed.js
│   ├── services/
│   │   ├── event-poller.js     # 异步消费 raw_events
│   │   └── opi-client.js       # 回拉 OPI 详情
│   ├── db/
│   │   ├── schema.sql
│   │   ├── index.js
│   │   └── dao/event-dao.js
│   └── utils/idempotency.js    # 幂等键生成
├── .env.example
├── .gitignore
└── package.json
```

## 5. 配置(.env.example)

```env
PORT=3002
LOG_LEVEL=info

# DB
DB_DRIVER=sqlite
SQLITE_PATH=./data/ozon-webhook.db
# 可选 Mongo
MONGO_HOST=
MONGO_PORT=27017

# Ozon OPI(回拉订单/商品详情,与 erp-backend-lite 同源)
OZON_OPI_BASE_URL=https://api-seller.ozon.ru
OZON_CLIENT_ID=
OZON_API_KEY=

# 服务身份(TYPE_PING 响应用)
APP_NAME=ozon-webhook
APP_VERSION=1.0.0

# IP 白名单开关(开发时可关闭)
IP_WHITELIST_ENABLED=true

# Poller
POLLER_INTERVAL_MS=2000
POLLER_CONCURRENCY=1
POLLER_MAX_RETRY=5
```

## 6. API 契约

| 方法 | 路径 | 鉴权 | 用途 |
|------|------|------|------|
| POST | `/webhook/ozon` | IP 白名单 | Ozon 推送接收端点 |
| GET | `/health` | 无 | 健康检查(反代/监控用) |
| GET | `/admin/api/events` | (后续可加) | 事件列表,支持 `status/type/page` 过滤 |
| POST | `/admin/api/events/:id/retry` | (后续可加) | 手动重试 dead 事件 |

### 响应模板(严格遵守 Ozon 规范)

```
PING 成功:   200 { "version":"1.0.0", "name":"ozon-webhook", "time":"<UTC ISO>" }
其余成功:   200 { "result": true }
失败:        4xx/5xx { "error": { "code":"ERROR_UNKNOWN", "message":"...", "details":null } }
```

`Content-Type: application/json` 必须设置(Ozon 会校验,见 `INVALID_BODY` 错误码)。

## 7. 数据库 Schema

### 7.1 原始事件表(核心)

```sql
CREATE TABLE IF NOT EXISTS ozon_push_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,             -- 幂等键
  seller_id INTEGER,
  posting_number TEXT,                       -- 订单类冗余,便于查询
  product_id INTEGER,                         -- 商品类冗余
  sku INTEGER,                                -- 库存类冗余
  raw_payload TEXT NOT NULL,                  -- 原始 JSON
  status TEXT NOT NULL DEFAULT 'pending',     -- pending/processing/success/failed/dead
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,                  -- ISO8601 UTC
  processed_at TEXT,
  UNIQUE(idempotency_key)
);

CREATE INDEX idx_events_status ON ozon_push_events(status, received_at);
CREATE INDEX idx_events_type   ON ozon_push_events(message_type);
CREATE INDEX idx_events_posting ON ozon_push_events(posting_number);
```

### 7.2 业务表(Handler 写入)

```sql
-- 订单主表(NEW_POSTING/STATE_CHANGED/CANCELLED/日期变更 都写这里)
CREATE TABLE IF NOT EXISTS ozon_postings (
  posting_number TEXT PRIMARY KEY,
  seller_id INTEGER,
  warehouse_id INTEGER,
  status TEXT,                                -- 推送模型状态
  products_json TEXT,                          -- 商品列表 JSON
  in_process_at TEXT,
  shipment_date TEXT,
  cutoff_date TEXT,
  delivery_date_begin TEXT,
  delivery_date_end TEXT,
  tracking_number TEXT,
  is_express INTEGER,
  tpl_integration_type TEXT,
  cancel_reason_id INTEGER,
  cancel_reason_message TEXT,
  raw_count INTEGER DEFAULT 1,                 -- 收到推送次数(同号多次更新)
  first_received_at TEXT,
  last_received_at TEXT
);

CREATE INDEX idx_postings_status ON ozon_postings(status);
CREATE INDEX idx_postings_seller ON ozon_postings(seller_id);

-- 库存快照(STOCKS_CHANGED 写入,追加式)
CREATE TABLE IF NOT EXISTS ozon_stocks_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER,
  product_id INTEGER,
  sku INTEGER,
  warehouse_id INTEGER,
  present INTEGER,
  reserved INTEGER,
  updated_at TEXT,                             -- 推送中的 updated_at
  received_at TEXT NOT NULL                     -- 服务收到时间
);

CREATE INDEX idx_stocks_sku ON ozon_stocks_snapshot(sku, warehouse_id);
CREATE INDEX idx_stocks_received ON ozon_stocks_snapshot(received_at);

-- 商品待刷新标记(CREATE_OR_UPDATE_ITEM 写入,erp 可扫描消费)
CREATE TABLE IF NOT EXISTS ozon_products_pending_refresh (
  product_id INTEGER PRIMARY KEY,
  seller_id INTEGER,
  offer_id TEXT,
  is_error INTEGER,                            -- 1=创建/更新出错,0=成功
  changed_at TEXT,
  received_at TEXT NOT NULL,
  consumed_at TEXT                              -- erp 拉取后置位
);

CREATE INDEX idx_products_pending ON ozon_products_pending_refresh(consumed_at);
```

## 8. 幂等键规则

Ozon 会因未送达/超时进行退避重试,必须去重:

| message_type | 幂等键 |
|---|---|
| TYPE_PING | 不落库(webhook 层立即返回) |
| TYPE_NEW_POSTING | `TYPE_NEW_POSTING:{posting_number}` |
| TYPE_POSTING_CANCELLED | `TYPE_POSTING_CANCELLED:{posting_number}:{changed_state_date}` |
| TYPE_STATE_CHANGED | `TYPE_STATE_CHANGED:{posting_number}:{new_state}:{changed_state_date}` |
| TYPE_CUTOFF_DATE_CHANGED | `TYPE_CUTOFF_DATE_CHANGED:{posting_number}:{new_cutoff_date}` |
| TYPE_DELIVERY_DATE_CHANGED | `TYPE_DELIVERY_DATE_CHANGED:{posting_number}:{new_delivery_date_begin}` |
| TYPE_CREATE_OR_UPDATE_ITEM | `TYPE_CREATE_OR_UPDATE_ITEM:{product_id}:{changed_at}` |
| TYPE_STOCKS_CHANGED | `TYPE_STOCKS_CHANGED:{sku}:{updated_at}:{warehouse_id}` |

**命中重复**(UNIQUE 冲突):直接返回 200 `{result:true}`,避免 Ozon 重试计数。

## 9. Webhook 中间件链(Koa)

```
bodyparser → requestLog → ipWhitelist → webhookRoute → errorHandler
```

webhookRoute 内部逻辑(均 try/catch,5s 内必返):

1. 解析 `message_type`
2. 若 `TYPE_PING` → 返回 `{version,name,time}`,**不落库**
3. 生成 `idempotency_key`
4. `INSERT OR IGNORE` 写入 `ozon_push_events`(若冲突 → 直接返回 200 `{result:true}`)
5. 返回 200 `{result:true}`(**不等 handler 执行完**)
6. 任何异常 → 走 errorHandler,返回 4xx/5xx + `{error:{...}}`

> **关键策略**:webhook 接收阶段**只对入参错误返回 4xx**(让 Ozon 重试),handler 内部业务失败由 poller 自行重试,**不让 Ozon 知道**(否则 24h 持续报错会触发暂停推送)。

## 10. Poller 异步消费流程

仿 erp-backend-lite 的 `batch-upload-poller.js` 模式:

```
loop (interval=POLLER_INTERVAL_MS):
  BEGIN TX
  SELECT * FROM ozon_push_events
  WHERE status='pending' AND retry_count < POLLER_MAX_RETRY
  ORDER BY received_at ASC LIMIT POLLER_CONCURRENCY
  UPDATE status='processing' WHERE id IN (...)
  COMMIT

  for each event:
    try:
      handler = handlers[event.message_type]
      if (!handler) throw { code:'ERROR_UNKNOWN', message:'unsupported type' }
      await handler(event.raw_payload, ctx)
      UPDATE status='success', processed_at=now
    catch err:
      retry_count++
      new_status = retry_count >= POLLER_MAX_RETRY ? 'dead' : 'pending'
      UPDATE status=new_status, retry_count, last_error=err.message
```

退避策略(后续可优化):失败立即重入 `pending`,由下次扫描捡起。若要避免风暴,可在 `next_retry_at` 字段上加 `now + 2^retry_count * 10s`(预留字段,首批不实现)。

## 11. Handler 分发表(首批)

| message_type | 主要动作 | 调 OPI? |
|---|---|---|
| TYPE_NEW_POSTING | 调 `/v3/posting/fbs/get` 补全订单详情,upsert 到 `ozon_postings` | 是 |
| TYPE_POSTING_CANCELLED | 更新 `ozon_postings` 状态为 `posting_canceled`,记录取消原因 | 否 |
| TYPE_STATE_CHANGED | 更新 `ozon_postings.status`(推送模型状态→API 状态映射见 Ozon 文档附录) | 否 |
| TYPE_CUTOFF_DATE_CHANGED | 更新 `ozon_postings.cutoff_date` | 否 |
| TYPE_DELIVERY_DATE_CHANGED | 更新 `ozon_postings.delivery_date_begin/end` | 否 |
| TYPE_CREATE_OR_UPDATE_ITEM | 写入 `ozon_products_pending_refresh` | 否 |
| TYPE_STOCKS_CHANGED | 写入 `ozon_stocks_snapshot` | 否 |

> **TYPE_NEW_POSTING** 的 is_express/tracking_number 字段推送已含,可直接落;`in_process_at` 可能空,需要回拉 OPI 补全。

## 12. 错误响应规范

统一错误中间件:

```js
// middleware/error.js
export const errorHandler = () => async (ctx, next) => {
  try { await next(); }
  catch (err) {
    const status = err.status || 500;
    ctx.status = status;
    ctx.set('Content-Type', 'application/json');
    ctx.body = {
      error: {
        code: err.code || 'ERROR_UNKNOWN',
        message: err.message || '未知错误',
        details: err.details ?? null,
      },
    };
    ctx.app.emit('error', err, ctx);   // 交 pino 记录
  }
};
```

错误码取值(对齐 Ozon):`ERROR_UNKNOWN`、`ERROR_PARAMETER_VALUE_MISSED`、`ERROR_REQUEST_DUPLICATED`。

## 13. 部署清单(给用户)

- [ ] 准备公网 HTTPS URL,反代到内网 3002 端口(如 `https://your-domain.com/webhook/ozon`)
- [ ] 防火墙白名单 3 段 Ozon IP:
  - `195.34.21.0/24`
  - `185.73.192.0/22`
  - `91.223.93.0/24`
- [ ] 配置 `.env`(OPI 凭据、APP_NAME/VERSION)
- [ ] 启动服务,本地 `curl POST /webhook/ozon` 模拟 PING 自测
- [ ] 邮件申请 `sapi-push@ozon.ru`,提供:
  - `seller_id`
  - URL
  - 通知类型清单:TYPE_PING + 上述 7 种业务通知
- [ ] 3 个工作日内收到 TYPE_PING 即接入成功

## 14. 与 erp-backend-lite 协作关系(首批不实现,留接口)

后续可走两条路径:

- **方案 A(推荐)**:ozon-webhook 维护自己的事件库,handler 内 HTTP 调 erp 的内部 API(需新增 `/internal/api/events/notify`)触发刷新
- **方案 B**:ozon-webhook 直连 erp 的 SQLite/Mongo(只写专用 collection,erp 侧 poller 扫描消费)

**首批不实现联动**,仅把事件落库到本服务的业务表(`ozon_postings`/`ozon_stocks_snapshot`/`ozon_products_pending_refresh`),供后续手动查询或联动消费。

## 15. 首批实现范围

| 范围 | 详情 |
|------|------|
| 通知类型 | TYPE_PING + 5 种订单类 + TYPE_STOCKS_CHANGED + TYPE_CREATE_OR_UPDATE_ITEM(共 8 种) |
| 接收端点 | POST /webhook/ozon(支持上述 8 种) |
| 异步处理 | Event Poller + 7 个业务 Handler |
| 业务表 | ozon_push_events + ozon_postings + ozon_stocks_snapshot + ozon_products_pending_refresh |
| 不实现 | 聊天类 4 种、类目树、Admin 列表/重试 UI(后续扩展) |

## 16. 实现阶段划分

按"先脚手架后填充"原则:

1. **脚手架阶段**:package.json/.env.example/.gitignore + 目录骨架 + app.js 启动验证(PING 自测)
2. **DB 层**:schema.sql + db/index.js + event-dao.js
3. **接收链**:webhook.js + ip-whitelist.js + error.js + log.js + idempotency.js
4. **Poller**:event-poller.js + handlers/index.js 分发表
5. **Handler 实现**:7 个 handler 逐个填充(NEW_POSTING 含 OPI 回拉)
6. **OPI Client**:opi-client.js(`/v3/posting/fbs/get` 封装)
7. **自测**:模拟 8 种 payload 走完接收→处理→落库全链路
