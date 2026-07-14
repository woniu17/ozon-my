# 暂存代码审查 — 店铺 SKU 关联功能

> 审查日期:2026-07-14
> 审查范围:`git diff --cached`(7 文件,+489 / -39)
> 功能概述:新增「店铺 SKU 关联」(ozon_store_sku 集合),打通扩展 → Service Worker → 后端 → Web 前端全链路,实现 SKU 与店铺(sellerId 为主键)的发现上报、采集关联、管理界面。

---

## 一、改动概览

| 层 | 文件 | 功能 |
| --- | --- | --- |
| 后端 | `erp-backend-lite/src/db/mongo.js` | 新增 `ozon_store_sku` 集合 + 索引;store-classification 增加 sellerId unique sparse 索引 |
| 后端 | `erp-backend-lite/src/modules/cache.js` | 新增 store-sku CRUD 端点(GET/POST/DELETE/列表);store-classification 增加 sellerId 字段 |
| 前端 | `erp-backend-lite/web/src/api/cache.js` | 新增 `getStoreSkuList` / `getStoreSku` / `deleteStoreSku` API 封装 |
| 前端 | `erp-backend-lite/web/src/views/Cache.vue` | 新增「店铺 SKU」Tab:列表展示、关键字搜索、分页、删除 |
| 扩展 SW | `qx-ozon/background/service-worker.js` | 新增 `_erpStoreSkuReport` / `reportStoreSku` 消息;全链路透传 sellerId |
| 扩展 CS | `qx-ozon/content/ozon-data-panel.js` | 新增 `reportStoreSkuDiscovery` 发现上报;非店铺商品排除逻辑(`_nonStoreSkus`) |
| 扩展 CS | `qx-ozon/content/shared-utils.js` | `autoCollectOnSkuSeen` / `collectAutoIfMatched` 透传 sellerId |

---

## 二、发现的问题

### 🔴 Bug 1:SKU 列表查询字段名错误(高)

**文件**:`erp-backend-lite/src/modules/cache.js`
**位置**:`GET /admin/api/store-sku` 列表查询

```js
query.$or = [
  { sku: { $regex: keyword, $options: 'i' } },   // ← BUG: 集合中没有 sku 字段
  { sellerSlug: { $regex: keyword, $options: 'i' } },
  { sellerName: { $regex: keyword, $options: 'i' } },
  { sellerId: { $regex: keyword, $options: 'i' } },
];
```

`ozon_store_sku` 集合中 **SKU 存储在 `_id` 字段**,不存在 `sku` 字段。后续代码也印证了这一点:

```js
for (const it of items) {
  it.sku = it.sku || it._id;  // 从 _id 补到 sku,说明 DB 无 sku 字段
}
```

**影响**:按 SKU 关键字搜索永远匹配不到结果(查询条件无效,退化为对其余三个字段的匹配)。

**修复**:

```js
{ _id: { $regex: keyword, $options: 'i' } },
```

---

### 🔴 Bug 2:SW 采集完成上报 sellerName=null 覆盖已有店铺名(高)

**文件**:`qx-ozon/background/service-worker.js` → `_doAutoCollect`
**位置**:采集完成后的 `_erpStoreSkuReport` 调用

```js
_erpStoreSkuReport({
  sku,
  sellerId,
  sellerSlug,
  sellerName: null,        // ← 传 null
  lastCollectAt: new Date().toISOString(),
  lastCollectStatus: status,
  lastCollectResults: results,
});
```

后端 POST 路由对 `sellerName` 的处理:

```js
set.sellerName = body.sellerName != null ? String(body.sellerName) : '';
// null != null → false → sellerName 设为 ''
```

`_doAutoCollect` 函数签名没有 `sellerName` 参数(只有 `sellerSlug`),所以只能传 `null`。

**竞态覆盖时序**:
1. Content script panel 加载时发现 SKU → 上报 `{ sellerName: '店铺A' }`(via `reportStoreSkuDiscovery`)
2. SW 采集完成 → 上报 `{ sellerName: null → '' }`(via `_erpStoreSkuReport`)

第二次上报的 `$set` 会将 `sellerName` **覆盖为空字符串**,导致 Web 列表中店铺名显示为 `—`。

**影响**:所有经过自动采集的 SKU 关联记录,其 sellerName 被清空。

**修复方案 A(后端,推荐)**:只在 sellerName 非空时才更新:

```js
// 只在有值时才更新 sellerName,避免空值覆盖
if (body.sellerName != null && String(body.sellerName) !== '') {
  set.sellerName = String(body.sellerName);
}
```

**修复方案 B(SW)**:从 `_doAutoCollect` 上下文获取实际 sellerName 传入(需修改函数签名增加 sellerName 参数,由调用方提供)。

---

### 🟡 Bug 3:sparse unique index 对空字符串无效(中)

**文件**:`erp-backend-lite/src/db/mongo.js`

```js
clsCol.createIndex({ sellerId: 1 }, { unique: true, sparse: true }),
```

后端写入 store-classification 时:

```js
sellerId: body.sellerId != null ? String(body.sellerId) : '',
```

当 sellerId 不存在时写入空字符串 `''`。

**关键差异**:`sparse` index 只跳过字段 **不存在或为 null** 的文档,**不跳过空字符串**。因此多个 `sellerId = ''` 的文档会违反唯一约束,触发 `E11000 duplicate key error`。

**影响**:历史上没有 sellerId 的店铺(或不同来源上报空值时),后续 upsert 会因重复键失败。

**修复**:写入时空值不设置该字段(使用条件赋值):

```js
const update = {
  sellerSlug: slug,
  ...(body.sellerId != null && String(body.sellerId)
    ? { sellerId: String(body.sellerId) }
    : {}),
  sellerName: body.sellerName != null ? String(body.sellerName) : '',
  // ... 其余字段
};
```

> 注:若 store-classification 的 `_id` 已是 `slug`(本身唯一),则 sellerId 上的 unique 索引可能非必要,建议确认其用途后再决定是否保留。

---

### 🟢 观察 4:fire-and-forget 在 MV3 Service Worker 中的丢请求风险(低)

**文件**:`qx-ozon/background/service-worker.js`

`reportStoreSku` 消息处理中:

```js
case 'reportStoreSku': {
  _erpStoreSkuReport(payload);   // 未 await
  return { ok: true };           // 立即返回
}
```

`_doAutoCollect` 中的调用同样未 await:

```js
if (sellerId) {
  _erpStoreSkuReport({ ... });   // 未 await
}
```

**风险**:MV3 Service Worker 在空闲时可能被 Chrome 终止。fire-and-forget 的 HTTP 请求若在 SW 终止前未完成,可能被中断而丢失。

**缓解**:`_erpStoreSkuReport` 内部有 try-catch,不会产生未捕获 rejection。采集流程通常有后续操作,SW 不太会在此刻被终止。实际触发概率低。

**建议(可选)**:若需更高可靠性,可在 `reportStoreSku` case 中改为 `await _erpStoreSkuReport(payload)`(panel 渲染不依赖此返回值,延迟可接受)。

---

### 🟢 观察 5:`_nonStoreSkus` 降级风险(低)

**文件**:`qx-ozon/content/ozon-data-panel.js`

非店铺商品排除逻辑整体设计合理:
- 收到 seller-info 时清空 `_nonStoreSkus` 并重建
- 60s 重扫时跳过 `_nonStoreSkus` 中的 SKU

```js
if (sellerSlug && _nonStoreSkus.has(sku)) continue;
```

**边界情况**:若 `card.querySelector('a[href*="/product/"]')` 返回 null(卡片 DOM 结构变化),SKU 不会被加入 `_nonStoreSkus`,该 SKU 仍可能在重扫时被错误关联到当前店铺。

**影响**:降级风险,不影响正常流程(Ozon DOM 结构稳定时不会触发)。建议在 log 中记录未能提取 SKU 的卡片数量,便于监控。

---

## 三、修复优先级

| 优先级 | 问题 | 修复文件 | 工作量 |
| --- | --- | --- | --- |
| P0 | Bug 1:SKU 搜索字段名 `sku` → `_id` | `cache.js` | 1 行 |
| P0 | Bug 2:sellerName=null 覆盖 | `cache.js`(推荐)或 `service-worker.js` | 3-5 行 |
| P1 | Bug 3:sparse unique index 空字符串 | `mongo.js` + `cache.js` | 5-10 行 |
| P2 | 观察 4:fire-and-forget 丢请求 | `service-worker.js` | 2 行(可选) |
| P2 | 观察 5:`_nonStoreSkus` 降级 | `ozon-data-panel.js` | 日志增强 |

---

## 四、附录:数据模型

### ozon_store_sku 集合

```json
{
  "_id": "152344236",          // SKU(唯一,一一对应)
  "sellerId": "12345678",
  "sellerSlug": "shop-name",
  "sellerName": "店铺名称",
  "firstSeenAt": "2026-07-14T10:00:00Z",   // $setOnInsert
  "lastSeenAt": "2026-07-14T10:30:00Z",
  "lastCollectAt": "2026-07-14T10:05:00Z",
  "lastCollectStatus": "success",
  "lastCollectResults": [...]
}
```

索引:
- `{ sellerId: 1, lastSeenAt: -1 }`
- `{ sellerId: 1, lastCollectAt: -1 }`
- `{ lastCollectAt: -1 }`

### 上报链路

```
Content Script(panel 加载 / 采集触发)
    ↓ sendMessage('reportStoreSku', {...})
Service Worker(_erpStoreSkuReport)
    ↓ POST /admin/api/store-sku
后端(cache.js → upsert → ozon_store_sku)
    ↓
Web 前端(Cache.vue → GET /admin/api/store-sku → 列表展示)
```