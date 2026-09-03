# Ozon 应计项目同步 — 功能设计文档

> **目标**:订单同步管道在同步完订单后,针对**已完成(妥投)/已取消**的货件自动拉取 Ozon 应计项目(accruals),落库并在**订单管理页**与**妙手订单页**展示;已完成订单的利润计算由 16% 预估佣金升级为**真实应计口径**。
>
> 调研基线:`/v1/finance/accrual/postings`、`/v1/finance/accrual/types` 接口实测(2026-09-03,6 店铺 957 货件全量验证)

***

## 1. 背景与目标

### 1.1 现状

- 订单同步(`order-sync.js`)每 5 分钟增量同步 unfulfilled + list60d 双接口,落 `op_ozon_order` / `op_package`
- 利润计算用**预估口径**:`commission = orderAmount × 0.16`(CNY),标注"估"
- Ozon 真实费用(佣金/物流/罚款)只有妥投或取消后经财务应计接口才可查,本地完全未接入

### 1.2 实测结论(接口调研)

| 结论 | 数据 |
| --- | --- |
| 应计接口形态 | `POST /v1/finance/accrual/postings`,入参 `{ posting_numbers: string[] }`,单批 200 实测可行(~470ms) |
| 应计类型 | 只返回 `type_id`,名称需 `/v1/finance/accrual/types` 字典翻译(共 124 种) |
| 限流 | 秒级限流(429 code=8),需 ~300ms 节流 + 退避重试 |
| 应计滞后 | 妥投后 2-3 周才生成(3 月妥投货件应计日期 4 月中旬),**空应计必须留重试窗口** |
| 币种 | 应计金额为 RUB;`order_amount` 为 CNY,两套口径 |
| 实际类型分布 | 6 店铺 2 月至今:国际配送(67)/销售佣金(69)/代理佣金(66) 占 99.6%,另有逆向物流(59)/星星商品(74)/错误罚款(93)/取消处理(6) |

### 1.3 目标

1. 订单同步管道尾部新增**应计同步阶段**,自动拉取已完成/已取消货件的应计
2. 订单管理页/妙手订单页展示应计合计 + 明细
3. 已有应计的订单,利润改用**真实应计口径**(RUB→CNY 汇率换算);无应计自动回退预估口径

***

## 2. 数据模型

### 2.1 新表 `op_accrual`(应计明细)

```sql
CREATE TABLE IF NOT EXISTS op_accrual (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL,
  posting_number  TEXT NOT NULL,
  package_id      INTEGER REFERENCES op_package(id),
  type_id         INTEGER NOT NULL,      -- 66/67/69...(Ozon 应计类型 ID)
  type_name       TEXT,                 -- 字典翻译冗余(RfbsGlobalAgentFee...)
  amount          REAL DEFAULT 0,       -- 应计金额(负数=扣款,RUB)
  currency        TEXT DEFAULT 'RUB',
  seller_price     REAL,                -- 单价(销售佣金行携带,其余 NULL)
  sku             INTEGER,
  quantity        INTEGER,
  accrual_date    TEXT,                 -- 应计日期(YYYY-MM-DD)
  synced_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_acc_pkg ON op_accrual(package_id);
CREATE INDEX IF NOT EXISTS idx_op_acc_posting ON op_accrual(posting_number);
```

### 2.2 `op_package` 补三列(ensureMigrations 轻量迁移)

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `accrual_total` | REAL | 应计扣款合计(RUB,负数;NULL=拉过但 Ozon 尚未生成应计) |
| `accrual_sale_total` | REAL | 销售收入合计(RUB,`SUM(seller_price × quantity)`) |
| `accrual_synced_at` | TEXT | 最近拉取应计时间 |

### 2.3 写入语义

- 批量拉取返回每个 posting 的**全量应计**,按 posting 在事务内 `DELETE + INSERT`(单货件约 3 行,简单可靠)
- 同事务回写 `op_package` 冗余列:
  - `accrual_total = SUM(amount)`(应计行为 0 时存 NULL,表示"拉过但空")
  - `accrual_sale_total = SUM(seller_price × quantity)`
  - `accrual_synced_at = now`

### 2.4 类型字典缓存

- `app_config` 表存 key=`ozon_accrual_types`(JSON:`[{id,name,description}]`,含 `fetchedAt`)
- 首次应计同步时拉取并缓存,跨重启复用;7 种常见类型 DAO 层中文映射:

| type_id | name | 中文 |
| --- | --- | --- |
| 66 | RfbsGlobalAgentFee | 代理佣金 |
| 67 | RfbsGlobalDelivery | 国际配送 |
| 69 | SaleCommission | 销售佣金 |
| 74 | StarsMembership | 星星商品 |
| 59 | ReturnFlowLogistic | 逆向物流 |
| 93 | DefectFineErrors | 错误罚款 |
| 6 | Cancellation | 取消处理 |

***

## 3. 后端设计

### 3.1 OPI 封装(`ozon-opi.js`,复用 `call()`)

```js
export async function financeAccrualPostings(store, postingNumbers)
// POST /v1/finance/accrual/postings  body: { posting_numbers }
export async function financeAccrualTypes(store)
// POST /v1/finance/accrual/types  body: {}
```

### 3.2 应计同步阶段 `syncAccruals(store)`(嵌入 `syncStore` 尾部,phase='accrual')

**待拉清单 SQL**(每店铺每轮 LIMIT 400 防爆):

```sql
SELECT p.id, o.posting_number
FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
WHERE o.store_id = ?
  AND o.status IN ('delivered', 'cancelled', 'not_accepted')
  AND (
    p.accrual_synced_at IS NULL                                        -- 从未拉过
    OR (p.accrual_total IS NULL
        AND p.accrual_synced_at < datetime('now', '-24 hours'))       -- 拉过但空,24h 重试
  )
  AND o.in_process_at > datetime('now', '-90 days')                    -- 窗口外放弃
```

**执行参数**:
- 分批 200 posting/请求,批间 300ms 节流
- 429/网络错:指数退避重试(1.5s × attempt,最多 3 次)
- 单店铺失败 try-catch 记入 `progress.failures`,**不阻塞订单同步主流程**

### 3.3 新 DAO `accrual-dao.js`

- `replaceAccruals(storeId, postingAccruals)` — 事务:删旧插新 + 回写 op_package 冗余
- `findPendingAccrualPostings(storeId, limit)` — 待拉清单
- `getAccrualsByPackageIds(packageIds)` — 批量查明细(列表/详情用)
- `getAccrualTypes(store)` — 字典缓存(缓存未命中时拉取并落 app_config)

### 3.4 路由扩展(`order-process.js`)

| 路由 | 变更 |
| --- | --- |
| `GET detail/:id` | 响应追加 `accruals` 数组 + `accrualTotal` |
| `GET miaoshou-detail/:id` | 同上(经 `local_pkg_id` 关联本地包裹) |
| `GET miaoshou-list` | 行数据 LEFT JOIN `op_package` 带出 `accrual_total` |
| `POST accrual-sync` | 手动触发:`{ sinceDays }` 存量回补 或 `{ packageIds }` 单包裹刷新 |

### 3.5 利润双口径改造(`computeProfit`)

```js
// 真实口径(已完成且有应计):
payoutRub  = accrual_sale_total + accrual_total        // 真实回款(RUB)
payoutCny  = payoutRub * rubCnyRate                     // RUB→CNY 汇率换算
profit     = payoutCny - totalPurchaseAmount
return { ..., estimated: false }                        // 前端显示"实"

// 预估口径(无应计/未妥投,现状不变):
commission = orderAmount * 0.16
return { ..., estimated: true }                         // 前端显示"估"
```

**汇率机制**:
- `app_config` 存 `rub_cny_rate`(`{ rate, updatedAt }`),`.env` 的 `RUB_CNY_RATE` 兜底初始值
- 管理端可手动更新;利润列悬停 tooltip 显示当前汇率与更新时间

### 3.6 汇率管理

- 新增 `GET/POST /admin/api/order-process/rub-rate`(读/写 `app_config.rub_cny_rate`)
- 前端订单管理页工具区提供汇率显示 + 修改入口

***

## 4. 前端设计

### 4.1 订单管理页(OrderProcess.vue)

- **列表新增「应计(RUB)」列**:有值显示合计(红字扣款),`—` 表示未结算;悬停 tooltip 展示前 3 项明细
- **利润列双口径**:「¥12.34 实」/「¥15.20 估」;悬停显示所用汇率与更新时间
- **详情弹窗新增「Ozon 应计明细」区块**:类型(中文)/金额/单价/数量/SKU/应计日期 + 合计行 + 回款换算明细行(`回款 = 销售 + 应计合计 → ×汇率`)
- 已完成、已取消状态的单包裹显示「刷新应计」按钮(调 `accrual-sync { packageIds }`)

### 4.2 妙手订单页(MiaoshouOrders.vue)

- **列表新增「应计(RUB)」列**:LEFT JOIN 本地包裹直出(未关联显示 `—`)
- **详情弹窗**:`local_pkg_id` 存在时显示同款应计区块;未关联显示占位说明

***

## 5. 容错与边界

| 场景 | 处理 |
| --- | --- |
| Ozon 应计延迟 2-3 周 | 空应计 24h 重试,90 天窗口外放弃 |
| 429 限流 | 300ms 节流 + 1.5s×attempt 退避(实测验证) |
| 应计阶段异常 | 单店铺失败仅记 failures,不影响订单数据落库 |
| 历史空单累积 | `in_process_at > 90 天` cutoff;增量 list 窗口 60 天天然衰减 |
| 拉到过数据后新应计(如取消后逆向物流) | 不自动重拉,单包裹「刷新应计」按钮兜底 |
| 汇率未配置 | 回退预估口径 + 提示配置汇率 |

***

## 6. 实施步骤

1. `schema.sql` 新表 `op_accrual` + `ensureMigrations` 补 `op_package` 三列
2. `ozon-opi.js` 新增 `financeAccrualPostings` / `financeAccrualTypes`
3. 新建 `accrual-dao.js`(事务写入/待拉清单/字典缓存/中文映射)
4. `order-sync.js` 接阶段 `syncAccruals`(节流/退避/失败隔离)
5. `order-process.js`:`computeProfit` 双口径 + 汇率读取 + 路由扩展
6. `miaoshou-dao.js` 列表 LEFT JOIN 带出应计合计
7. 前端两页面改造 + 构建
8. 存量回补 `accrual-sync { sinceDays: 210 }`(覆盖 2 月至今 957 货件)

***

## 7. 验收要点

- [ ] 增量同步 5 分钟轮次自动拉取新完成/取消货件应计
- [ ] 订单管理列表「应计(RUB)」列正常显示,tooltip 明细正确
- [ ] 已有应计订单利润显示「实」,悬停可见汇率;无应计显示「估」
- [ ] 详情弹窗应计明细区块完整(类型中文名/金额/合计/换算行)
- [ ] 妙手订单列表应计列 + 详情弹窗应计区块(已关联本地的行)
- [ ] 单包裹「刷新应计」按钮可用
- [ ] 存量回补后 566 个有应计货件数据完整
- [ ] 汇率可配置,利润换算口径透明
