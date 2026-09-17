# ozon-webhook 整合进 erp-backend-lite — 详细设计

> 2026-09-17 · 状态：设计定稿（5 项决策已拍板），待实施

## 1. 背景与目标

`ozon-webhook`（Koa 2.x，3002，pm2 进程名 `msg`）独立接收 Ozon 平台推送，落自己的 SQLite 库（`ozon-webhook/data/ozon-webhook.db`）；`erp-backend-lite`（Express 4，3001）靠三级轮询拉订单落 `erp.db`。现状问题：

- **数据孤岛**：同一 posting 两份拷贝（webhook 的 `ozon_postings` vs erp 的 `op_ozon_order`），schema 不同、互相不可 JOIN；`ozon_products_pending_refresh` 等表注释写"erp 可扫描消费"但 erp 无任何消费代码
- **文件级部署耦合**：webhook 的 `store-loader.js` 直接读 erp 的 `src/config/stores.json`，并靠 `POST /admin/stores/reload` 手工热刷新
- **重复采集**：webhook 侧自带 `unfulfilled-poller`（2 分钟）与 `cancel-scanner`（10 分钟）兜底轮询，与 erp 的 fast/mid 轮询调同一批 Ozon 接口，双份消耗 API 配额
- **已知缺陷**：接收路由 `setImmediate` 异步落库，进程崩溃会丢事件且 Ozon 已收到 200 不重推（`ozon-webhook/src/modules/webhook.js:L48` 注释自述）

**目标**：webhook 整体并入 erp-backend-lite，单进程（3001）、单库（erp.db）；推送事件秒级推进 `op_ozon_order` 状态；轮询只留对账兜底。

## 2. 已拍板决策（2026-09-17）

| # | 决策 | 内容 |
|---|---|---|
| 1 | fast 轮询调整 | 间隔 5 分钟 → **2 分钟**；窗口 cutoff ∈ **[now, now+14d]**（去掉向后 7 天，"ozon 通知可能会失效"由推送+mid 兜底） |
| 2 | 历史数据 | `ozon_postings` 历史货件**导入 erp.db** |
| 3 | 切换方式 | 3002 **直接下线**（改完路由即切，不留双跑期） |
| 4 | 联动优先级 | 先做 **STATE_CHANGED 订单状态推进** |
| 5 | 飞书通知可配置 | 本地 erp 实例**不做通知**；服务器（ssh root@nuc.yochylin.com）实例**做飞书通知**，按环境变量区分 |

## 3. 现状关键事实（调研结论）

### 3.1 部署拓扑（服务器 nuc.yochylin.com）

nginx 监听 17443（SSL，server_name `yochylin.com` / `2.tencent.yochylin.com`）：

```
location /webhook/ozon  → 127.0.0.1:3002   (ozon-webhook, pm2 名 'msg')
location /              → 127.0.0.1:3001   (erp-backend-lite)
```

配置文件：`ozon-webhook/deploy/nginx-ozonerp.conf`、`ozon-webhook/deploy/ecosystem.config.cjs`。

**重要推论**：Ozon 后台配置的 callback URL 是域名级（`https://…:17443/webhook/ozon`），切换只需改 nginx 一行 `proxy_pass`，**无需去 Ozon 卖家后台逐店铺改 URL**。

### 3.2 两服务技术栈完全同构

| 维度 | ozon-webhook | erp-backend-lite |
|---|---|---|
| SQLite 驱动 | node:sqlite（`--experimental-sqlite`） | 相同 |
| Node 要求 | ≥22.5 | 相同 |
| 日志 | pino | pino |
| HTTP client | undici/fetch | undici |
| pm2 | `--node-args="--experimental-sqlite"` | 相同 |

唯一框架差异：Koa vs Express，仅影响 webhook 路由层（~70 行）与 ip-whitelist 中间件（~20 行），handler/poller/dao 均为框架无关纯函数。

### 3.3 webhook 侧代码结构（待搬移清单）

```
ozon-webhook/src/
  modules/webhook.js          Koa 路由:POST /webhook/ozon(PING/幂等/setImmediate落库) + /health + /admin/stores/reload
  middleware/ip-whitelist.js  Ozon 推送源 3 段 CIDR 白名单(Koa,ctx.ip,app.proxy=true)
  services/event-poller.js   每 2s 消费 pending 事件,失败重试 5 次后 dead
  services/unfulfilled-poller.js  每 2 分钟兜底扫 unfulfilled/list(漏推货件)  ★删除
  services/cancel-scanner.js      每 10 分钟兜底扫 fbs/list cancelled(漏推取消) ★删除
  services/store-loader.js    读 erp 的 stores.json 构建 Map<seller_id,store>   ★删除重写
  services/opi-client.js      getPostingDetail(store, postingNumber) OPI 回拉
  services/feishu-notify.js   4 机器人(URL default/cancel/new/pickup),sendFeishuText 空URL自动跳过
  services/status-map.js      API状态⇄推送状态映射 + rank 推进规则(planAdvance)
  handlers/index.js           22 种 message_type 分发表
  handlers/*.js               各事件 handler(纯函数 (payload, ctx)=>{})
  db/dao/event-dao.js         insertEvent(幂等)/claimPendingEvents(事务)/markSuccess/Failed/Dead
  utils/idempotency.js        genIdempotencyKey/extractIndexFields
  db/schema.sql               7 张表定义
```

### 3.4 表清单（7 张，全部并入 erp.db）

| 表 | 写入方 | 用途 |
|---|---|---|
| `ozon_push_events` | 接收路由 | 原始事件队列（幂等键唯一约束，status: pending/processing/success/failed/dead） |
| `ozon_postings` | 订单类/FBO handler | 货件主表（推送模型状态、pickup_at、sale_amount_cny） |
| `ozon_orders` | ORDER 级 handler | 订单级状态 |
| `ozon_stocks_snapshot` | STOCKS_CHANGED | 库存快照（追加式） |
| `ozon_products_pending_refresh` | CREATE_OR_UPDATE_ITEM | 商品待刷新标记 |
| `ozon_chat_messages` | 聊天类 4 种 | 聊天消息 |
| `ozon_category_tree_refresh_log` | 类目树 | 类目树刷新标记 |

### 3.5 erp 侧关键复用点

- **`src/config/index.js:L22-24` `loadStores()`**：每次调用直读 `src/config/stores.json`（无缓存热加载）→ 直接替代 webhook 的 store-loader 文件读取
- **`src/middleware/auth.js:L6-29`**：`PUBLIC_PATHS` 集合 + `PUBLIC_PATH_PREFIXES` 前缀放行机制 → 加 `/webhook/` 前缀即可
- **`src/db/dao/sqlite/order-daos.js:L202` `applyOzonStatus(packageId, ozonStatus, {deliveringDate, shipmentDate})`**：包裹状态联动（只前进不回退；delivering/delivered/driver_pickup→wait_receiver_confirm，cancelled/not_accepted→cancelled；rank0-1 不动）→ **STATE_CHANGED 联动直接复用**，目前未导出需加 export
- **`src/services/order-sync.js:L32-36` `SYNC_LEVELS`**：三级轮询窗口定义
- **`src/db/schema.sql:L889` `op_ozon_order`**：业务订单表，UNIQUE(store_id, posting_number)
- **`src/db/schema.sql:L940` `op_package`**：包裹表，ozon_order_id 关联

### 3.6 状态模型（status-map.js）

- `ozon_postings.status` 存**推送模型**状态（`posting_on_way_to_city` 等），`op_ozon_order.status` 存 **Seller API 模型**状态（`delivering` 等）
- `API_TO_PUSH` 正向映射已有（`status-map.js:L12-27`）；rank 序：0 创建/打包 < 1 待装运 < 2 揽收 < 3 揽收后 < 4 妥投 < 9 吸收态（cancelled/not_accepted，不可退出）
- STATE_CHANGED 联动需要**反向映射（推送→API）**，需新增

## 4. 目标架构

```
Ozon 平台推送 ──POST /webhook/ozon (3001, 免JWT, IP白名单)──▶ 接收路由
    同步落库(修掉setImmediate丢事件风险) + 立即200
        │
        ▼  ozon_push_events(erp.db, 幂等去重)
    event-poller(2s, 重试5次/dead)
        │
        ▼  22 种 Handler
    ├── 订单类: ozon_postings 落库 + ★联动 op_ozon_order/op_package(秒级状态推进)
    ├── 商品/库存/聊天/类目: 落各自表(后续消费)
    └── 飞书通知(FEISHU_* env, 空则跳过 → 本地静默/服务器通知)

Ozon API 轮询(对账兜底,不删):
    fast  2分钟  unfulfilled cutoff [now, now+14d]
    mid   8小时  fbs/list 近90天下单窗口(含已过cutoff在途单/终态)
    slow  24小时 fbs/list 近365天
```

## 5. 详细设计

### 5.1 决策① fast 轮询调整

文件：`erp-backend-lite/src/services/order-sync.js`

| 位置 | 改动 |
|---|---|
| L26 | `FAST_INTERVAL_MIN` 默认值 `5` → `2`（保留 `ORDER_SYNC_INTERVAL_MIN` env 覆盖） |
| L33 | `fast: { unfulfilledDays: 7, … }` → `{ unfulfilledDays: 0, … }`；label `'5分钟·未完成订单(7天)'` → `'2分钟·未完成订单(cutoff未来14天)'` |
| L244 | 窗口计算 `cutoffFrom = now - 0*86400_000 = now`，`cutoffTo = now + 14d` 保持不变 |

行为变化：已过 cutoff 的未完成在途单不再由 fast 覆盖，改由 **STATE_CHANGED 推送（秒级）+ mid 轮询（8 小时·近 90 天下单窗口，含终态）** 兜底。文件头注释（L11、L236）同步更新。

同步删除：`order-sync.js` 中 `SYNC_LEVELS.fast.unfulfilledDays` 的默认引用（L234 的默认参数取值同步改 0）。

### 5.2 决策③ 部署切换（nginx 层，零 Ozon 侧改动）

服务器 `nginx-ozonerp.conf`（当前在 `/etc/nginx/` 生效，源文件 `ozon-webhook/deploy/nginx-ozonerp.conf`）：

```nginx
# 改动:proxy_pass 3002 → 3001,其余(1m body/超时/头)保留
location /webhook/ozon {
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:3001;   # ← 原 3002
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 10s;
    proxy_send_timeout 10s;
    proxy_read_timeout 10s;
}
```

切换步骤（服务器上）：

```bash
# 1. 备份
cp /root/code/ozon-my/erp-backend-lite/data/erp.db /root/erp.db.bak-webhook-merge-$(date +%m%d)
# 2. 导入历史数据(见 5.4)
# 3. pm2 重启 erp(加载新代码)
pm2 restart <erp进程名>          # 服务器上确认进程名(本地 dev 用 erp-lite)
# 4. nginx 切流
vim /etc/nginx/conf.d/*.conf     # proxy_pass 3002→3001
nginx -t && nginx -s reload
# 5. 下线 webhook 进程
pm2 stop msg && pm2 delete msg && pm2 save
# 6. 验证(见 §7)
```

回滚预案：`proxy_pass` 改回 3002 + `pm2 start`（`ozon-webhook/deploy/ecosystem.config.cjs` 保留不删，webhook 源码目录保留一个版本周期后再清理）。erp.db 中新表不影响旧进程。

### 5.3 模块搬移（目录与文件映射）

目标结构（新增均在 erp-backend-lite 内）：

```
erp-backend-lite/src/
  modules/webhook.js                    ★重写:Express router(见 5.3.1)
  middleware/ip-whitelist.js            ★重写:Express 化(见 5.3.2)
  services/webhook/
    event-poller.js                     ← 原样(改 import 路径)
    opi-client.js                       ← 原样(config 引用改 erp config.ozonOpiBaseUrl)
    feishu-notify.js                    ← 原样(config.feishu 改读 erp config;查表用 erp db)
    status-map.js                       ← 原样 + 新增 pushToApi()(见 5.5)
    store-map.js                        ★重写:基于 config.loadStores() 的 seller_id→store 查找(见 5.3.3)
    idempotency.js                      ← 原样搬
    handlers/index.js + 22 个 handler    ← 原样搬(改 import 路径)
  db/dao/sqlite/event-dao.js            ← 原样(getDb 改 import erp 的 db)
  db/schema.sql                         ★追加 7 张表(见 5.4.1)
删除(不搬):services/unfulfilled-poller.js、services/cancel-scanner.js
         (与 erp fast/mid 轮询同接口重复,双份消耗配额;其兜底职责由
          fast 2min(状态) + STATE_CHANGED 推送(通知)接管)
```

#### 5.3.1 接收路由 Express 化（`modules/webhook.js`）

```javascript
import { Router } from 'express';
// POST /webhook/ozon —— 行为对齐原 Koa 版,仅两处改进:
//   ① 落库改同步(prepare 同步 API,毫秒级),修掉 setImmediate 崩溃丢事件缺陷
//   ② stores 读取改 config.loadStores()
router.post('/webhook/ozon', (req, res) => {
  const payload = req.body ?? {};
  const messageType = payload.message_type;
  if (!messageType) return res.status(400).json({ /* 同原 ERROR_PARAMETER_VALUE_MISSED */ });
  if (messageType === 'TYPE_PING') {
    return res.json({ version: config.appVersion, name: config.appName, time: new Date().toISOString() });
  }
  const idempotencyKey = genIdempotencyKey(messageType, payload);
  if (idempotencyKey == null) return res.json({ result: true });
  const fields = extractIndexFields(messageType, payload);
  try {
    const result = insertEvent({ /* 同原 */ raw_payload: JSON.stringify(payload), ...fields });
    if (!result.inserted) logger.info({ messageType, idempotencyKey }, '重复推送,幂等返回');
  } catch (err) {
    logger.error({ err, messageType, idempotencyKey }, '落库失败:事件可能丢失');
  }
  res.json({ result: true });
});
router.get('/webhook/health', …);   // 原 /health 换路径避免与 erp 既有 /health 冲突,带 stores meta
```

挂载位置（`src/app.js`）：在 `app.use(authMiddleware)` **之前**（与静态资源同级，鉴权前），并同步改 `auth.js` 的 `PUBLIC_PATH_PREFIXES` 加入 `'/webhook/'`（双保险，防止顺序调整后失效）。

#### 5.3.2 IP 白名单 Express 化（`middleware/ip-whitelist.js`）

保留 CIDR 匹配函数（`ipInCidr/ipv4ToInt` 原样）。改造点：

```javascript
// 不设全局 app.set('trust proxy')(避免影响 erp 其他中间件的 req.ip 语义)
// 中间件内自行解析:X-Forwarded-For 首个 IP,无头时取 socket 地址
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}
export function ipWhitelist(req, res, next) {
  if (req.path === '/webhook/health') return next();   // 探活放行
  if (!config.webhook.ipWhitelistEnabled) return next(); // IP_WHITELIST_ENABLED=false(本地开发)
  const allowed = config.webhook.ozonPushCidrs.some(cidr => ipInCidr(clientIp(req), cidr));
  if (!allowed) return res.status(403).json({ error: { code: 'ERROR_UNKNOWN', message: 'forbidden' } });
  next();
}
```

CIDR 段（Ozon 官方 3 段）随代码常量迁移：`195.34.21.0/24`、`185.73.192.0/22`、`91.223.93.0/24`。

#### 5.3.3 store 查找重写（`services/webhook/store-map.js`）

替代原 `store-loader.js`（文件读取 + reload 端点全部废弃）：

```javascript
import config from '../../config/index.js';
// erp 的 loadStores() 每次直读 stores.json(热加载),无需缓存失效通知
export function getStoreBySellerId(sellerId) {
  if (sellerId == null) return null;
  const n = Number(sellerId);
  return config.loadStores().find(s =>
    s?.sync_credentials?.clientId
    && s.credentials_verified !== false
    && Number(s.company_id) === n
  ) ?? null;
}
export function listStores() { return config.loadStores().filter(/*同上校验*/); }
```

校验规则对齐原 store-loader（缺 sync_credentials / credentials_verified=false / company_id 非法 → 跳过）。原 `POST /admin/stores/reload` 端点删除——同进程读同一文件，天然一致。

#### 5.3.4 config 扩展（`erp-backend-lite/src/config/index.js`）

新增 `webhook` 配置块（env 变量名沿用 ozon-webhook 既有约定，服务器 .env 平移即可）：

```javascript
webhook: {
  ipWhitelistEnabled: String(process.env.IP_WHITELIST_ENABLED ?? 'true') === 'true',
  ozonPushCidrs: ['195.34.21.0/24', '185.73.192.0/22', '91.223.93.0/24'],
  poller: {
    intervalMs: Number(process.env.POLLER_INTERVAL_MS) || 2000,
    concurrency: Number(process.env.POLLER_CONCURRENCY) || 1,
    maxRetry: Number(process.env.POLLER_MAX_RETRY) || 5,
  },
},
feishu: {   // 决策⑤:本地不配 URL → sendFeishuText 已有空URL跳过逻辑(feishu-notify.js:L173-177)
  webhookUrlDefault: process.env.FEISHU_WEBHOOK_URL_DEFAULT || '',
  webhookUrlCancel:  process.env.FEISHU_WEBHOOK_URL_CANCEL  || '',
  webhookUrlNew:    process.env.FEISHU_WEBHOOK_URL_NEW      || '',
  webhookUrlPickup: process.env.FEISHU_WEBHOOK_URL_PICKUP    || '',
},
```

`.env.example` 追加对应注释段（标注"本地留空=不通知，服务器配置=通知"）。

#### 5.3.5 生命周期接入（`src/app.js`）

```javascript
import webhookRoutes from './modules/webhook.js';
import { ipWhitelist } from './middleware/ip-whitelist.js';
import { startEventPoller, stopEventPoller } from './services/webhook/event-poller.js';
// 挂载:静态资源之后、authMiddleware 之前
app.use(ipWhitelist);        // 仅 /webhook/* 生效,内部对其他路径直通
app.use(webhookRoutes);
// listen 回调内:
startEventPoller();
// shutdown() 内:
stopEventPoller();
```

注意：ipWhitelist 中间件对所有路径直通放行（仅 `/webhook/ozon` 校验），或用 `router` 级挂载限定作用域（推荐：白名单逻辑放进 webhook router 内部，只包 POST /webhook/ozon）。

### 5.4 数据迁移（决策②）

#### 5.4.1 表定义并入

`erp-backend-lite/src/db/schema.sql` 末尾追加 7 张表（**建全列版本**，即原 schema.sql + 原 db/index.js runMigrations 补列后的最终形态：`ozon_push_events` 含 chat_id/order_number 列；`ozon_postings` 含 cutoff_date/order_number/uuid/posting_type/creation_date/cancel_date/sale_amount_cny/pickup_at/cancel_initiator 列；全部索引一并声明）。`CREATE TABLE IF NOT EXISTS` 对存量 erp.db 幂等，`initSchema()` 自动生效。

#### 5.4.2 一次性导入脚本

新增 `erp-backend-lite/scripts/migrate-webhook-data.mjs`：

```javascript
// 用法:node --experimental-sqlite scripts/migrate-webhook-data.mjs [源库路径]
// 默认源库:../ozon-webhook/data/ozon-webhook.db
import { DatabaseSync } from 'node:sqlite';
const erp = new DatabaseSync('data/erp.db');
erp.exec(`ATTACH DATABASE '${src}' AS wh`);
// ① 货件主表全量(决策②),冲突忽略(幂等可重跑)
erp.exec(`INSERT OR IGNORE INTO ozon_postings SELECT * FROM wh.ozon_postings`);
// ② 事件表全量(库仅 147KB,审计历史一并保留,未完成事件由 poller 接管消费)
erp.exec(`INSERT OR IGNORE INTO ozon_push_events SELECT * FROM wh.ozon_push_events`);
// ③ 其余 5 张表全量同款 INSERT OR IGNORE
// ④ 校验:各表 count(源) vs count(目标) 打印对账
erp.exec('DETACH DATABASE wh');
```

执行时机：**服务器上、切换 nginx 之前、停两个进程后**（SQLite 写锁安全）。本地开发库可选执行。执行前 `cp erp.db erp.db.bak-*`。

### 5.5 决策④ STATE_CHANGED 联动 op_ozon_order（核心新逻辑）

改造 `services/webhook/handlers/state-changed.js`，在现有 `ozon_postings` 落库与飞书通知之外，追加 ERP 联动（全部 try/catch 包裹，失败只记日志不阻断 handler，留给轮询兜底）：

```
stateChangedHandler(payload):
  1. 现有逻辑:ozon_postings 落库(status/pickup_at) —— 不变
  2. ★新增:linkOzonOrder(payload) —— 见下
  3. 现有逻辑:飞书通知 —— 不变(本地 env 空自动跳过)
```

`linkOzonOrder`（新增于同文件或独立 `services/webhook/order-link.js`）：

```
输入:payload{ posting_number, new_state(推送模型), changed_state_date, seller_id }
步骤:
① pushToApi(new_state) → apiStatus;null(未知状态)则 return
② store = getStoreBySellerId(payload.seller_id);无匹配 return
③ row = SELECT id, status FROM op_ozon_order WHERE store_id=? AND posting_number=?
   无行 return(轮询会建,或 NEW_POSTING 联动后续版本再补)
④ 状态保护后 UPDATE op_ozon_order(只推进,语义对齐 applyOzonStatus):
   - rank(apiStatus) > rank(现 status) → 允许更新
   - 吸收态(cancelled/not_accepted) → 任意现状态均可进入
   - 吸收态/妥投后的回退推送 → 跳过
   SET status=?, delivering_date=COALESCE(delivering_date, changed_state_date 仅揽收级),
       last_synced_at=now, gmt_modified=now
⑤ packageId = SELECT id FROM op_package WHERE ozon_order_id=? AND is_ignored=0
⑥ applyOzonStatus(packageId, apiStatus, { deliveringDate: changed_state_date })
   (order-daos.js:L202,需新增 export;其内部 rank 保护与 ④ 一致,双保险)
```

**新增反向映射 `pushToApi()`**（加入 `services/webhook/status-map.js`，从 `API_TO_PUSH` 反转，歧义项取保守代表值）：

```javascript
// 推送模型 → Seller API 模型(rank0-1 的代表值对 applyOzonStatus 无影响:其明确不动 rank<2)
const PUSH_TO_API = {
  posting_created: 'awaiting_packaging',            // ← awaiting_verification/approve/packaging/registration 的代表
  posting_packing: 'awaiting_packaging',
  posting_acceptance_in_progress: 'acceptance_in_progress',
  posting_awaiting_registration: 'awaiting_registration',
  posting_transferring_to_delivery: 'awaiting_deliver',
  posting_not_in_carriage: 'awaiting_deliver',
  posting_in_carriage: 'delivering',
  posting_on_way_to_city: 'delivering',             // 揽收
  posting_driver_pick_up: 'driver_pickup',
  posting_transferred_to_courier_service: 'delivering',
  posting_in_courier_service: 'delivering',
  posting_on_way_to_pickup_point: 'delivering',
  posting_in_pickup_point: 'delivering',
  posting_conditionally_delivered: 'delivering',
  posting_in_arbitration: 'arbitration',
  posting_in_client_arbitration: 'client_arbitration',
  posting_delivered: 'delivered',
  posting_received: 'delivered',
  posting_canceled: 'cancelled',                    // 吸收态
  posting_not_in_sort_center: 'not_accepted',       // 吸收态
};
export function pushToApi(pushStatus) { return pushStatus == null ? null : PUSH_TO_API[pushStatus] ?? null; }
```

**双写边界（事件 vs 轮询）**：
- 事件只推进 `op_ozon_order` 的 `status / delivering_date / last_synced_at / gmt_modified` 四个字段（增量）
- 轮询 `upsertOrder`（order-daos.js:L59）ON CONFLICT 全字段覆盖，是唯一权威（金额/买家/产品行等）
- 乱序推送由 rank/吸收态规则吸收；残余不一致由 fast/mid 对账自愈

### 5.6 删除项汇总（不搬移）

| 组件 | 原因 |
|---|---|
| `services/unfulfilled-poller.js` | 每 2 分钟调 unfulfilled/list 与 erp fast 轮询完全重复（用户已把 fast 调到同为 2 分钟）；其"漏推货件通知"职责由 STATE_CHANGED/NEW_POSTING 推送通知承担 |
| `services/cancel-scanner.js` | 每 10 分钟调 fbs/list 与 erp mid 轮询重复；取消状态由 TYPE_POSTING_CANCELLED 推送 + mid 对账承担 |
| `store-loader.js` + `/admin/stores/reload` | 同进程直读 stores.json，热加载天然生效 |
| Koa 相关依赖 | erp-lite 无需新增任何 npm 依赖（全部能力已有） |

行为变化须知：webhook 侧的兜底通知（"unfulfilled-poller 发现的新货件(兜底通知)"格式）消失；仅剩推送触发型通知。可接受——决策①已用 2 分钟 fast 补偿通知失效风险。

## 6. 实施步骤（建议顺序）

| # | 任务 | 涉及文件 | 可独立部署 |
|---|---|---|---|
| 1 | fast 轮询调整（决策①） | order-sync.js | 是（先行上线无依赖） |
| 2 | schema 追加 7 张表 + .env.example/config 扩展 | schema.sql、config/index.js | 是 |
| 3 | 搬移 handlers/poller/dao/services（行为 1:1） | §5.3 目标结构 | 否（与 2 同批） |
| 4 | Express 路由 + IP 白名单 + auth 放行 + 生命周期 | modules/webhook.js、middleware/ip-whitelist.js、middleware/auth.js、app.js | 否（同批） |
| 5 | STATE_CHANGED 联动（决策④） | handlers/state-changed.js、status-map.js、order-daos.js(export) | 否（同批） |
| 6 | 数据迁移脚本 | scripts/migrate-webhook-data.mjs | 是 |
| 7 | 本地端到端验证（§7.1） | — | — |
| 8 | 服务器切换（§5.2 顺序：备份→导数据→pm2 restart→nginx→pm2 delete msg） | — | — |
| 9 | 观察 1 周（dead 队列/重复推送/状态推进）后清理 ozon-webhook 源码目录与 ecosystem 配置 | — | — |

## 7. 验证方案

### 7.1 本地（切换前）

```bash
# .env 设 IP_WHITELIST_ENABLED=false
# 1. PING 心跳
curl -s -X POST localhost:3001/webhook/ozon -H 'content-type: application/json' \
  -d '{"message_type":"TYPE_PING"}'
# 期望:{version,name,time}

# 2. 幂等:同一 STATE_CHANGED 发两次,第二次日志出现"重复推送,幂等返回"

# 3. 状态联动:对已存在的 op_ozon_order(取一个 delivering 前的 posting_number)
curl -s -X POST localhost:3001/webhook/ozon -H 'content-type: application/json' \
  -d '{"message_type":"TYPE_STATE_CHANGED","posting_number":"XXXX","seller_id":<company_id>,
       "new_state":"posting_on_way_to_city","changed_state_date":"2026-09-17T10:00:00Z"}'
# 期望:ozon_postings.status 更新;op_ozon_order.status→delivering;关联 op_package.operate_status→wait_receiver_confirm
# 乱序验证:再发 posting_created → 两个表状态不回退

# 4. 飞书静默:本地无 FEISHU_* → 日志"未配置 webhook URL,跳过推送",无报错

# 5. fast 轮询:观察日志 fast 轮 2 分钟一次,unfulfilled 请求 cutoff 窗口 [now, now+14d]
```

### 7.2 服务器（切换后）

1. `pm2 logs <erp进程名>` 观察 webhook 模块日志（Ozon 真实推送开始到达）
2. `sqlite3 data/erp.db "SELECT status,count(*) FROM ozon_push_events GROUP BY status"` — pending 应被消费到 0，dead 为 0 或仅历史遗留
3. 找一笔真实 STATE_CHANGED，核对 `op_ozon_order.status` 秒级变化（订单处理页 Ctrl+F5 可见）
4. 飞书通知到达（新订单/揽收/取消三类各一笔）
5. 观察 fast 轮询日志节奏与配额消耗变化（unfulfilled-poller/cancel-scanner 删除后应降一半）

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| erp 重启/卡死期间推送丢失（故障域合并） | 接收路径"同步落库+返回"毫秒级；erp 重活全在异步 poller，事件循环阻塞罕见；观察期监控 dead 队列 |
| 双写 op_ozon_order 冲突 | 事件只写 4 个增量字段 + rank 保护；轮询全量对账为权威（§5.5 边界） |
| 推送乱序/重复 | 幂等键去重 + rank/吸收态规则（既有逻辑复用） |
| 已过 cutoff 在途单失去 fast 覆盖（决策①） | STATE_CHANGED 秒级 + mid 8h（90 天窗口含终态）双兜底；用户已接受 |
| 切换窗口丢推送 | nginx reload 秒级生效；幂等键保证 Ozon 重推安全；切换选业务低峰 |
| 状态映射错误污染 op_ozon_order | pushToApi 未知状态返回 null 直接跳过；联动失败不阻断 handler；轮询对账自愈 |
| SQLite 写竞争 | WAL 模式既有；事件落库为短事务；ozon_push_events 建议后续加周清理（success 超 30 天删） |

## 9. 后续迭代（本期不做）

- `TYPE_NEW_POSTING` 秒级建单（upsertOrder 全链路）+ 自动建包裹
- `TYPE_POSTING_CANCELLED` 在途采购拦截提醒
- `ozon_products_pending_refresh` 消费（触发商品重采集）
- `ozon_chat_messages` 接入飞书/客服待办
- fast 轮询进一步降频评估（事件联动稳定后）
- `ozon_push_events` 定期清理任务
