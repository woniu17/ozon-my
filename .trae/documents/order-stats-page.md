# 订单统计页面 实施计划

## Context

ERP 系统当前缺少跨店铺、跨时间窗口的订单量级与金额概览。运营侧只能通过飞书单条通知了解当日揽收/签收动态，无法回答"近 7 天各店一共签收多少单、销售金额多少"。本方案在 Web 端侧边栏新增「订单统计」一级菜单，提供 4 个核心指标（新订单 / 揽收 / 签收 / 退货）按事件发生时间计数的店铺维度汇总，配套时间范围预设与店铺多选筛选。

## 用户已确认的设计点

- **指标口径**：按事件发生时间计数（不去重，同一货件可在不同时段分别计入新订单+揽收+签收+退货）
  - 新订单：`op_ozon_order.in_process_at` 落在 [from, to)
  - 揽收：`op_ozon_order.delivering_date` 落在 [from, to)
  - 签收：`op_package.delivered_at` 落在 [from, to)（`is_ignored=0`）
  - 退货：`op_package.return_at` 落在 [from, to)（`is_ignored=0`）
- **金额**：顶部总计卡 + 表格行金额列；统一 `currency='CNY'` 口径；新订单金额拆 `amount`（含取消）+ `validAmount`（剔除取消），其余 3 指标天然不含取消
- **维度**：仅店铺汇总（一行一店铺）
- **筛选**：店铺多选下拉（默认全选）
- **时间预设**：今天 / 昨天 / 近7日 / 近14日 / 近30日 / 本月 / 上月 / 自由选择（最长 365 天）
- **位置**：Web 端侧边栏新增一级菜单「订单统计」（独立页面）

## 后端

### 新建 `src/modules/order-stats.js`

- `Router()` + 单一路由 `GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD&storeIds=a,b,c`
- 时间范围校验：`from < to`、跨度 ≤ 365 天，非法返回 400
- 北京日界 → UTC ISO 转换：复用 `feishu-notify.js#getTodayUtcRange` 思路，扩展为 `localDateToUtcRange(from, to)`（`from T00:00:00+08:00` 起、`to T00:00:00+08:00` 止）
- 店铺筛选：`storeIds` 逗号分隔；空 = 全部；非空用 `IN (?, ?...)` 动态占位
- 店铺元数据：`config.loadStores()` 取 `{id, name}` 映射，0 单店铺也输出行

### SQL 策略：4 条独立查询

不合并为 1 条大 SQL。原因：4 个指标 FROM 表不同（前 2 直接查 `op_ozon_order`，后 2 查 `op_package JOIN op_ozon_order`）；SQLite in-process 无网络成本；可读性高；单指标索引利用最优。

```sql
-- 新订单(含取消金额拆分)
SELECT store_id,
       COUNT(*) AS cnt,
       COALESCE(SUM(CASE WHEN currency='CNY' THEN order_amount END), 0) AS amt,
       COALESCE(SUM(CASE WHEN currency='CNY' AND status NOT IN ('cancelled','cancelled_from_split_pending','not_accepted') THEN order_amount END), 0) AS valid_amt
FROM op_ozon_order
WHERE in_process_at >= ? AND in_process_at < ?
GROUP BY store_id

-- 揽收
SELECT store_id, COUNT(*) AS cnt,
       COALESCE(SUM(CASE WHEN currency='CNY' THEN order_amount END), 0) AS amt
FROM op_ozon_order
WHERE delivering_date IS NOT NULL AND delivering_date >= ? AND delivering_date < ?
GROUP BY store_id

-- 签收
SELECT p.store_id, COUNT(*) AS cnt,
       COALESCE(SUM(CASE WHEN o.currency='CNY' THEN o.order_amount END), 0) AS amt
FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
WHERE p.delivered_at IS NOT NULL AND p.delivered_at >= ? AND p.delivered_at < ? AND p.is_ignored = 0
GROUP BY p.store_id

-- 退货
SELECT p.store_id, COUNT(*) AS cnt,
       COALESCE(SUM(CASE WHEN o.currency='CNY' THEN o.order_amount END), 0) AS amt
FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
WHERE p.return_at IS NOT NULL AND p.return_at >= ? AND p.return_at < ? AND p.is_ignored = 0
GROUP BY p.store_id
```

JS 端按 `store_id` 合并 4 个 Map → byStore 数组。

### 返回 JSON 结构

```json
{
  "totals": {
    "new":     { "count": 123, "amount": 12000.00, "validAmount": 11000.00 },
    "pickup":  { "count": 100, "amount": 9500.00 },
    "delivered": { "count": 80, "amount": 7800.00 },
    "returned": { "count": 5, "amount": 480.00 }
  },
  "byStore": [
    { "storeId": "store-yql03-b6b2b3", "storeName": "YQL03",
      "new": { "count": 20, "amount": 2000, "validAmount": 1900 },
      "pickup": { "count": 15, "amount": 1500 },
      "delivered": { "count": 10, "amount": 980 },
      "returned": { "count": 1, "amount": 100 } }
  ]
}
```

### 模块挂载

- `src/app.js` 在 L160 旁（orderProcessRoutes 挂载处）追加 `app.use(orderStatsRoutes)`，import 加在 L29 旁
- `authMiddleware` 已由 app.js 全局注入，模块内不再加

### 索引补全（`src/db/schema.sql`）

经核查 `op_ozon_order` 现有索引：`idx_opoo_status`、`idx_opoo_store_time(store_id, in_process_at DESC)`、`idx_opoo_parent`；`op_package` 现有索引：`idx_op_pkg_operate`、`idx_op_pkg_order`、`idx_op_pkg_purchase`。

`delivering_date` / `delivered_at` / `return_at` 均**无索引覆盖**。在 schema.sql 末尾（`op_ozon_order` 索引段与 `op_package` 索引段相应位置）追加：

```sql
CREATE INDEX IF NOT EXISTS idx_opoo_delivering ON op_ozon_order(store_id, delivering_date DESC);
CREATE INDEX IF NOT EXISTS idx_op_pkg_delivered ON op_package(store_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_pkg_return   ON op_package(store_id, return_at DESC);
```

幂等可加，下次 `initSchema()` 自动建索引，无需手动 ALTER。

## 前端

### 新建 `web/src/api/order-stats.js`

```js
import * as request from './request.js';
export function getOrderStatsSummary(params) {
  return request.get('/admin/api/order-stats/summary', params);
}
```

### 新建 `web/src/views/OrderStats.vue`

**技术栈约束**：项目无 UI 框架依赖（已核实 OrderProcess.vue / Audit.vue 均用原生 input + 自实现组件）。**不引入 Element Plus**，避免构建体积膨胀 600KB+。

**布局三段**：

1. **顶部工具栏**
   - 时间预设按钮组（8 个）：今天 / 昨天 / 7日 / 14日 / 30日 / 本月 / 上月 / 自定义
   - 两个原生 `<input type="date">`（from/to）：自定义模式可编辑，预设模式只读展示当前选中范围
   - 店铺多选下拉：自实现（参考 OrderProcess.vue 现有 tag 选择面板交互），默认全选；显示"已选 N/全部"

2. **中部总计卡片**（4 张并排）
   - 新订单：单数 + 金额（小字附"剔除取消 ¥X"）
   - 揽收 / 签收 / 退货：单数 + 金额
   - 图标用 inline SVG 或 emoji，无外部图标库

3. **底部店铺表格**（原生 `<table>`）
   - 列：店铺 / 新订单（数+金额） / 揽收（数+金额） / 签收（数+金额） / 退货（数+金额）
   - 底部合计行

**交互**：
- 默认时间范围：今天
- 切换时间/店铺 300ms 防抖重新加载
- 请求 ID 自增防覆盖（参考 OrderProcess.vue L162-184 `summaryReqId` 模式）
- 加载中用骨架占位；失败显示错误条
- 表格样式复用 OrderProcess.vue 既有 `.table` / `.col-*` 风格

### 修改 `web/src/router/index.js`

L27 后加 `import OrderStats from '../views/OrderStats.vue';`，路由表追加：

```js
{ path: '/order-stats', name: 'order-stats', component: OrderStats, meta: { title: '订单统计' } }
```

### 修改 `web/src/App.vue`

`tabs` 数组（L13-L43）追加 `{ key: '/order-stats', label: '订单统计' }`，紧跟「订单处理」之后。

## 部署

1. 提交代码（schema.sql + 后端模块 + 前端文件）
2. 本地构建：`cd erp-backend-lite && npm run build:web`（具体脚本名以 package.json 为准）
3. rsync 到服务器：`scp -P 16000 src/modules/order-stats.js src/db/schema.sql root@tencent.yochylin.com:/root/code/ozon-my/erp-backend-lite/{对应路径}`
4. rsync web dist 到服务器 `src/public/web/`
5. `pm2 restart erp`，启动时 `initSchema()` 自动建 3 个新索引

## 验证

### curl 测试（替换 $TOKEN）

```bash
# 1. 今天
curl -s "http://localhost:3001/admin/api/order-stats/summary?from=2026-09-21&to=2026-09-22" -H "Authorization: Bearer $TOKEN"

# 2. 近7日+指定店铺
curl -s "http://localhost:3001/admin/api/order-stats/summary?from=2026-09-15&to=2026-09-22&storeIds=store-yql03-b6b2b3,store-yql01-xxx" -H "Authorization: Bearer $TOKEN"

# 3. 上月
curl -s "http://localhost:3001/admin/api/order-stats/summary?from=2026-08-01&to=2026-09-01" -H "Authorization: Bearer $TOKEN"
```

### SQL 自检（今日揽收应与飞书通知当日揽收数一致）

```sql
SELECT COUNT(*) FROM op_ozon_order
WHERE delivering_date >= '2026-09-21T00:00:00+08:00'::timestamptz
  AND delivering_date <  '2026-09-22T00:00:00+08:00'::timestamptz;
```

### 前端验证

浏览器访问 `/order-stats`，加 `?_cb=` 强刷缓存。验证：
- 8 个时间预设按钮切换均能加载
- 自定义日期范围可编辑且生效
- 店铺多选下拉能筛选
- 总计卡数字与表格底部合计行一致
- 今日揽收数与飞书通知当日揽收数一致

## 关键决策

1. **SQL 策略**：4 条独立查询（不合并）。FROM 表不同、字段不同、SQLite in-process 无网络成本、可读性高、单指标索引利用最优。
2. **取消订单**：仅「新订单」拆 `amount`（含取消）与 `validAmount`（剔除取消）；其余 3 指标天然不含取消。
3. **金额 currency**：仅统计 `currency='CNY'`（与 `buildTodaySummaryFromDb` 完全同口径）。
4. **不引入 Element Plus**：项目无 UI 框架依赖，前端用原生 `<input type="date">` + 自实现多选下拉，与 OrderProcess.vue / Audit.vue 风格一致。
5. **索引补全**：3 个新索引幂等可加（`CREATE INDEX IF NOT EXISTS`），老库立即生效，无需 ALTER TABLE。

## 待修改文件清单

- `src/modules/order-stats.js` （新建）
- `src/db/schema.sql` （追加 3 条 CREATE INDEX）
- `src/app.js` （挂载 orderStatsRoutes）
- `web/src/api/order-stats.js` （新建）
- `web/src/views/OrderStats.vue` （新建）
- `web/src/router/index.js` （注册路由）
- `web/src/App.vue` （追加菜单项）
