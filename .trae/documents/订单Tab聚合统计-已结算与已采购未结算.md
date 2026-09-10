# 订单处理页 Tab 聚合统计:已结算组 + 已采购未结算组

## Context

订单处理页 OrderProcess.vue 当前只展示当前 Tab 的分页列表(20条),用户切 Tab 时无法快速看到该 Tab 下**全集**订单的财务汇总。需求:在局部搜索栏和订单列表之间新增一个聚合面板,按当前 Tab+筛选条件统计两组数据:

- **已结算组**:delivered 且应计同时有 type 66(代理佣金)和 67(国际配送)→ 真实口径
- **已采购未结算组**:已采购(purchase_status != 'none')且不满足已结算条件且非已取消 → 预估口径

两组语义在所有 Tab 下保持一致(用户已确认)。已取消订单排除出两组(利润=−采购、利润率无意义),单独计数但不进组。

## 改动文件清单

### 1. `src/db/dao/sqlite/order-daos.js` — 后端聚合 DAO

**a) 抽取 `buildPackageWhere(filters)` helper(从 listPackages L348-436 机械移动)**
- 签名:`{ where: string[], params: any[], globalSearch: boolean, globalKeyword: string }`
- 涵盖 8 个筛选维度:tab/keyword/storeId/purchaseStatus/arrived/cancelInitiator/globalKeyword/globalMode
- listPackages 改为调用该 helper,COUNT + SELECT 复用 where/params
- **必须 curl 回归 /list 各 Tab + 全局搜索 + keyword + 筛选组合**(memory 约束)

**b) 新增 `aggregatePackages(filters)` 函数(L477 后)**
- 调 `buildPackageWhere` 复用 WHERE
- COUNT(*) 先拿 total 用于 truncated 判断
- SELECT 精简 9 字段(id/operate_status/purchase_status/delivered_at/is_ignored/total_purchase_amount/accrual_total/accrual_sale_total/o.order_amount/o.store_id),不分页
- LIMIT 20000 截断防极端场景
- 返回轻量对象数组(不走 rowToPackage 全字段映射)+ `{ total, truncated, truncatedAt: 20000 }`

**c) 在 `orderPackageDao` 导出对象(L1295-1315 区)追加 `aggregatePackages`**

### 2. `src/modules/order-process.js` — 新增聚合路由

**在 `/list` 路由(L201 闭合)后、`/detail/:id`(L205)前新增:**

```
GET /admin/api/order-process/summary
```

query 参数与 /list 完全一致(除不接 page/pageSize)。流程:
1. `aggregatePackages(q)` 拿精简行
2. `pkgIds = data.map(p => p.id)`
3. `rateInfo = resolveRubCnyRate()` — 复用 L38-45
4. `accrualMap = buildAccrualBreakdown(data, getAccrualTypeSumsByPackageIds(pkgIds), rateInfo?.rate)` — 复用 L57-89
5. 循环每个 pkg:`pkg.accrual = accrualMap.get(id)`、`pkg.profit = computeProfit(pkg, operateStatus === 'cancelled')` — 复用 L96-144
6. 构造 `has66: Set<packageId>`、`has67: Set<packageId>`(从 getAccrualTypeSumsByPackageIds 结果)
7. 分类累加(见下方"分组规则")
8. 返回 JSON(见下方"响应结构")

### 3. `web/src/api/order-process.js` — 前端 API 封装

在 `getOrderList`(L16 区)后新增:
```js
export function getOrderSummary(params) {
  return request.get('/admin/api/order-process/summary', params);
}
```

### 4. `web/src/views/OrderProcess.vue` — 前端展示

**a) import 追加 `getOrderSummary`**(L9-17)

**b) script 新增响应式**(L89 附近,与 loading/rows 同区):
- `const summary = ref(null)`
- `const summaryLoading = ref(false)`
- `const summaryError = ref(null)`
- `let summaryReqId = 0`(自增守卫,防快速切 Tab 旧响应覆盖新响应)
- `const summaryEmpty = computed(() => summary.value && summary.value.totalOrders === 0)`
- `const summaryEmptyHint = computed(() => activeTab.value === 'cancelled' ? '已取消订单不参与利润汇总' : '当前 Tab 无已结算/已采购未结算订单')`
- `async function loadSummary(params)`:reqId 守卫 + 调 API + 更新状态(约 18 行)

**c) `loadList()`(L207-233)改造**:
- 开头置 `summaryLoading.value = true; summaryError.value = null;`
- 列表请求前调 `loadSummary(params)` 并行触发(不 await,独立 loading/error 态)
- 列表主路径 await 不变

**d) template 新增**(L1838 `.toolbar` 闭合后、L1840 `<!-- 列表 -->` 前):
- `.summary-bar` 两栏并排(settled 左、pendingSettled 右)
- loading/empty/error/truncated 四态
- 复用 `fmtMoney`(L1520)和 `fmtRate`(L1526)
- truncated=true 时顶部加 `.tag-warn` 警告"仅统计前 20000 单(共 X),请缩小筛选"

**e) style 新增(`<style>` 末尾)**:
- `.summary-bar`(flex gap 12px)
- `.summary-card`(flex 1 + 边框 + 圆角)
- `.summary-settled`(`border-left:3px solid #16a34a` 绿)
- `.summary-pending`(`border-left:3px solid #f59e0b` 黄)
- `.summary-head` / `.summary-metrics` / `.metric` / `.metric-label` / `.metric-val`
- `.summary-empty/.summary-error/.summary-loading`(muted 单行)
- profit 颜色复用 `.profit-pos/.profit-neg`,muted 复用 `.muted`,标签复用 `.tag/.tag-ok`

## 分组规则

### 已结算组 settled
进入条件(按数据状态,非 Tab):
- `operateStatus === 'wait_receiver_confirm'`
- `deliveredAt != null`
- `has66.has(id) && has67.has(id)`

累加字段:`orderCount++` / `totalOrderAmount += orderAmount` / `totalPurchaseAmount += totalPurchaseAmount` / `totalProfit += profit.profit`
- `profitRateSale = totalProfit / totalOrderAmount * 100`(保留 2 位)
- `profitRateCost = totalProfit / totalPurchaseAmount * 100`
- `estimated = !rateInfo?.rate || 组内任一 pkg.profit.estimated === true`(汇率未配置时 settled 也会回退 16% 预估,需如实标"估")

### 已采购未结算组 pendingSettled
进入条件:
- `purchaseStatus !== 'none'`(已采购)
- 不满足 settled 组条件
- `operateStatus !== 'cancelled'`(排除已取消)

**包含未妥投的已采购订单**(已发货/交运/待打单/已签收应计不全等)。这是预估口径,符合用户原话"已采购未结算"语义。

累加同 settled,`estimated = true`(组定义就是未结算,即使个别 pkg 带部分应计+汇率走真实路径,组级仍标"估")。

### 已取消订单处理
排除出两组。在"已取消"Tab 下两组均为 0,前端展示空态提示"已取消订单不参与利润汇总"。

### totalOrders
`totalOrders = settled.orderCount + pendingSettled.orderCount + cancelledCount`(cancelledCount 单独计数,= 聚合行中 operateStatus === 'cancelled' 的数量)。

## 响应结构

```json
{
  "ok": true,
  "data": {
    "settled": {
      "orderCount": 120,
      "totalOrderAmount": 45230.55,
      "totalPurchaseAmount": 21000.00,
      "totalProfit": 8120.33,
      "profitRateSale": 17.96,
      "profitRateCost": 38.67,
      "estimated": false
    },
    "pendingSettled": {
      "orderCount": 45,
      "totalOrderAmount": 18200.00,
      "totalPurchaseAmount": 9500.00,
      "totalProfit": 4230.00,
      "profitRateSale": 23.24,
      "profitRateCost": 44.53,
      "estimated": true
    },
    "totalOrders": 165,
    "cancelledCount": 0,
    "truncated": false,
    "truncatedAt": null,
    "totalUnfiltered": null,
    "rubRate": { "rate": 0.085, "updatedAt": "2026-09-01T...", "source": "config" }
  }
}
```

## 性能

- SQLite SELECT 10k 行 × 9 字段:约 20-50ms
- getAccrualTypeSumsByPackageIds 一次 IN GROUP BY:约 10-30ms
- buildAccrualBreakdown + 循环 computeProfit 10k 次:约 30-80ms
- 总计 < 200ms,单次请求可接受
- 50k+ 行场景靠 LIMIT 20000 截断 + 警告兜底
- **本期不加缓存**:典型 < 200ms,加 LRU 增加复杂度且与列表数据可能不同步

## 边界情况

### 全局搜索模式
buildPackageWhere 已处理 globalKeyword(L354-372 跨所有状态检索 7 类单号字段)。summary 复用同一 WHERE,全局搜索下两组聚合覆盖全局命中全集。前端在全局搜索模式下仍展示 summary(与 global-banner 并存)。

### 筛选跟随
purchaseStatus / arrived / cancelInitiator 全部进 WHERE,summary 自动跟随当前筛选。例如在"已签收"Tab 叠加"已采购"筛选,pendingSettled 组只统计该 Tab 下已采购的已签收订单。

### 各 Tab 下两组含义(始终同一套语义)

| Tab | settled 组 | pendingSettled 组 |
|-----|-------------|---------------------|
| 全部 | 全局所有已妥投+66+67 | 全局所有已采购未结算未取消 |
| 待处理 | 0(未妥投) | 该 Tab 下已采购订单的预估利润 |
| 待打单发货/交运 | 0 | 已采购订单的预估利润 |
| 已发货 | 少量(妥投且应计全) | 大部分(已妥投应计未生成 + 未妥投已采购) |
| 已签收 | 0(应计缺 66/67) | 全部(已妥投应计不全) |
| 已结算 | 全部 | 0 |
| 已取消 | 0 | 0(显示"已取消订单不参与利润汇总") |
| 已搁置 | 该 Tab 内满足 settled 条件的 | 该 Tab 内已采购未结算的 |
| 全局搜索 | 全局命中已结算的 | 全局命中已采购未结算的 |

## 实施顺序

1. order-daos.js:抽取 `buildPackageWhere` → curl `/list` 各 Tab + 全局搜索 + keyword + 筛选组合回归 → 新增 `aggregatePackages` → 导出
2. order-process.js:新增 `/summary` 路由 → curl `/summary?tab=settled` 和 `?tab=signed` 验证响应结构
3. api/order-process.js:新增 `getOrderSummary`
4. OrderProcess.vue:script 改造(loadSummary + loadList 并行调用 + computed) → template(两栏 + 四态) → style
5. `cd erp-backend-lite/web && npm run build` → `pm2 restart erp` → 浏览器 `?ts=Date.now()` 硬刷新验证

## 验证

1. **后端**:`pm2 restart erp`
2. **前端构建**:`cd erp-backend-lite/web && npm run build`
3. **API 验证**(curl):
   - `GET /admin/api/order-process/summary?tab=settled` — settled 组非 0、pendingSettled=0
   - `GET /admin/api/order-process/summary?tab=signed` — settled=0、pendingSettled 非 0、estimated=true
   - `GET /admin/api/order-process/summary?tab=all` — 两组都有数据
   - `GET /admin/api/order-process/summary?tab=cancelled` — 两组都 0、cancelledCount 非 0
   - `GET /admin/api/order-process/summary?tab=waitProcess&purchaseStatus=purchased` — settled=0、pendingSettled 该 Tab 已采购订单
4. **回归 /list**(抽取 buildPackageWhere 后):
   - 各 Tab 分页列表计数和内容不变
   - 全局搜索命中数不变
   - keyword/purchaseStatus/arrived/cancelInitiator 筛选结果不变
5. **前端浏览器**:
   - 切 Tab 时 summary 面板更新,settled 和 pendingSettled 两组数字与 Tab 计数对应(如已结算 Tab 下 settled.orderCount 应等于该 Tab 计数 580)
   - 切 Tab 快速连切,summary 不出现旧响应覆盖新响应(reqId 守卫生效)
   - 全局搜索模式下 summary 跟随全局命中
   - 已取消 Tab 显示"已取消订单不参与利润汇总"
   - fmtMoney 和 fmtRate 显示正常,profit 正负数颜色正确
   - 汇率按钮改汇率后刷新 summary,settled 组 estimated 应从 true→false(若有真实应计)
6. **极端场景**:模拟 5万+订单(测试库或 SQL 注入) → summary 返回 truncated:true,前端显示"仅统计前 20000 单"警告

## 不需要改动

- schema.sql / 迁移:op_accrual 已有 idx_op_acc_pkg 索引,无新表
- 妙手订单页面 MiaoshouOrders.vue:独立汇总,本次不涉及
- 现有 listPackages/getOrderList/loadList 主路径:只是 loadList 多调一次并行 loadSummary,主路径 await 不变
- 现有 buildAccrualBreakdown/computeProfit/resolveRubCnyRate/getAccrualTypeSumsByPackageIds:全部直接复用,零修改

## 总改动量

约 +230 行,涉及 4 个文件。无新文件、无 schema 迁移、无新依赖。
