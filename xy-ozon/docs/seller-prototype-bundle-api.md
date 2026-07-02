# seller.ozon.ru 服装类目建品 API（seller-prototype）

> 本文档基于对 Ozon seller-ui 微前端 `app.js`（`release-ctt-5508-c85023d1`）的源码静态分析整理。
> 分析方法：通过 Chrome DevTools MCP 在 `https://seller.ozon.ru/app/products/create` 页面拉取 `app.js`，搜索 `create-bundle` / `update-bundle-items` / `upload-bundle` 三个 URL，追踪 `sellerPrototypeService` 的 wrapper 函数与各 store action 的调用点。
>
> 字段说明：所有请求/响应字段均为 **服务端 proto 的 snake_case**（seller-ui 前端代码用 camelCase，经 axios 请求拦截器转 snake_case 后发到服务端）。

---

## 一、调用入口与触发流程

### 1.1 `app.js` 加载条件

`https://st-21.ozonru.cn/s3/seller-ui-static/products/releases/release-ctt-5508-c85023d1/app.js` 是 products 微前端的主 bundle，**进入 `/app/products*` 系列路由时由 SystemJS 自动拉取**，并非按需触发。

### 1.2 触发链路

```
用户在 /app/products/create 点击「手动 → 一个商品」磁贴
   │
   ▼
进入服装类目（apparel / одежда）创建向导
   │
   ▼
挂载 addEditApparel 表单 → 调用 fetchAllData({productId, bundleId, descriptionCategoryId})
   │
   ├─ 有 bundleId（编辑场景）→ loadBundle({bundleId})
   │     └─ POST /seller-prototype/get-bundle-items
   │
   └─ 无 bundleId（新建场景）→ createBundle({productId})
         └─ POST /seller-prototype/create-bundle      ← 本文档接口 1
              │
              ▼
         拿到 bundleId 存入 store
              │
   ┌──────────┴───────────┐
   │  用户编辑表单(每次变更) │
   │  → syncBundle/syncBundleChunk({products})
   │     └─ POST /seller-prototype/update-bundle-items  ← 本文档接口 2
   │
   │  用户点击「保存/提交」
   │  → uploadBundle()
   │     └─ POST /seller-prototype/upload-bundle         ← 本文档接口 3
   └──────────────────────┘
```

### 1.3 关键判定条件

| 场景                                       | 调用接口                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| 新建服装商品（路由无 `bundleId` 参数）     | `create-bundle` → `update-bundle-items`（多次）→ `upload-bundle`                    |
| 编辑已有服装商品（路由有 `bundleId` 参数） | `get-bundle-items`（不调 `create-bundle`）→ `update-bundle-items` → `upload-bundle` |
| 非服装类目商品                             | 不挂载 `addEditApparel` store，不走本组接口                                         |

错误日志 zone 标记：

- `products.apparel.create-bundle`
- `products.apparel.sync-bundle` / `products.apparel.change-bundle-product`

---

## 二、接口 1：`POST /api/site/seller-prototype/create-bundle`

**作用：** 创建空草稿 bundle，返回 `bundle_id` 供后续 update/upload 使用。

### Request Body

```js
{
  company_id: string,                       // 公司 ID（字符串），来自 company.companyId
  description_category_lvl3_name: string,   // 三级类目名称，来自 addEditApparelCategory.state.descriptionType.value
  source_item_id: string | undefined        // 源商品 ID（复制流程的 productId），新建时为 undefined
}
```

| 字段                             | 类型   | 必填 | 说明                                               |
| -------------------------------- | ------ | ---- | -------------------------------------------------- |
| `company_id`                     | string | ✅   | 公司 ID（字符串化）                                |
| `description_category_lvl3_name` | string | ✅   | 三级类目名称（按名匹配类目，避免类目 ID 跨店错位） |
| `source_item_id`                 | string | ❌   | 复制流程的源商品 ID；新建流程不传                  |

### Response

```js
{
  bundle_id: string; // 新建的 bundle 草稿 ID
}
```

### 调用源码（app.js pos 748579）

```js
async createBundle(t) {
  let { productId: e } = t;
  if (!this.state.bundleId) {
    try {
      const { bundleId: t } = await this.$http.sellerPrototypeService.postSiteSellerPrototypeCreateBundle({
        companyId: String(this.store.$core.store.company.companyId),
        description_category_lvl3_name: this.addEditApparelCategory.state.descriptionType?.value,
        sourceItemId: e || void 0
      });
      if ("undefined" === typeof t) throw new Error("bundle id is undefined");
      this.mutations.setBundleId(t);
    } catch (s) {
      // 日志 zone: products.apparel.create-bundle
      // 错误文案: Ошибка при создании черновика createBundle
      // 失败时跳转到 PRODUCTS 列表页
    }
  }
}
```

---

## 三、接口 2：`POST /api/site/seller-prototype/update-bundle-items`

**作用：** 增量同步草稿商品数据，可反复调用（表单每次变更都会触发节流后的 sync）。

### Request Body

```js
{
  bundle_id: string,          // bundle 草稿 ID（来自 create-bundle 响应）
  company_id: string,         // 公司 ID（字符串化）
  items: BundleItem[],        // 商品项数组
  source: string | undefined  // "SOURCE_UI_COPY_APPAREL"（复制流程时）或 undefined（普通新建）
}
```

| 字段         | 类型         | 必填 | 说明                                                                    |
| ------------ | ------------ | ---- | ----------------------------------------------------------------------- |
| `bundle_id`  | string       | ✅   | bundle 草稿 ID                                                          |
| `company_id` | string       | ✅   | 公司 ID（字符串化）                                                     |
| `items`      | BundleItem[] | ✅   | 商品项数组（见下表）                                                    |
| `source`     | string       | ❌   | 来源标识，复制流程为 `"SOURCE_UI_COPY_APPAREL"`，普通新建为 `undefined` |

> ⚠️ **注意**：本接口**不含** `description_category_lvl3_name` 字段（类目信息在 `create-bundle` 时已固化到 bundle）。每个 item 自身的类目信息通过 `description_category_id` / `new_description_category_id` 字段携带。

### BundleItem 结构（apparel 流程）

由 product→item 映射函数（pos 744907）生成，关键字段：

```js
{
  currency: string,                          // 货币代码（如 "RUB"）
  attributes: Array,                         // 属性数组（含 brand/modelName/media/物理参数等）
  description_category_id: string | undefined,  // item 级类目 ID
  origin_variant_id: ...,
  new_description_category_id: string | undefined,  // 新类目 ID（迁移类目时）
  name: string,                              // 商品名称
  offer_id: string,                          // offer ID（卖家自管 SKU）
  price: number | string,                    // 价格
  old_price: number | string,                // 划线价
  barcode: string,                           // 多个条码用 ";" 分隔（barcodes + newBarcodes 合并 join）
  promotions: ...,
  id: string,                                // 来自 size.key（已去除前缀），item 内部 ID
  item_id: string | undefined,               // 已存在 item 的服务端 ID（新建时为 undefined）
  group_id: string,                          // 颜色组 key（首个 size 的 key）
  sku: string,                               // SKU，缺省 "0"
  vat: number | undefined                    // 增值税率（从 vatsBySku[sku] 或 i.vat[0].id 取）
}
```

> 💡 **物理参数（weight/depth/width/height）在 apparel 流程中作为 `attributes` 数组的元素携带**（attr key：4497=weight, 9454=depth, 9455=width, 9456=height），而非 BundleItem 顶层字段。这区别于 `/v3/product/import` 官方 API schema（v3 中物理参数为顶层必填字段）。

### Response

```js
// 代码中未显式消费响应体（fire-and-forget 的草稿同步）
// 失败时从 error.response.data 取错误详情并记日志
```

### 调用源码（app.js pos 752644, 755277）

```js
// 整体同步（changeBundleProduct action）
async syncBundle(t) {
  // ...
  await this.$http.sellerPrototypeService.postSiteSellerPrototypeUpdateBundleItems({
    bundleId: this.state.bundleId,
    companyId: String(this.store.$core.store.company.companyId),
    items: i ? t.map(i) : t,
    source: this.addEditApparel.state.isCopyFlow ? "SOURCE_UI_COPY_APPAREL" : void 0
  });
}

// 分块同步（syncBundleChunk action，支持 cancelToken）
async syncBundleChunk(t) {
  let { products: e, retries: i = qi } = t;
  await this.$http.sellerPrototypeService.postSiteSellerPrototypeUpdateBundleItems(
    {
      bundleId: this.state.bundleId,
      companyId: String(this.store.$core.store.company.companyId),
      items: e,
      source: this.addEditApparel.state.isCopyFlow ? "SOURCE_UI_COPY_APPAREL" : void 0
    },
    { axiosConfig: { cancelToken: this.state.syncCancelTokenSource?.token } }
  );
}
```

---

## 四、接口 3：`POST /api/site/seller-prototype/upload-bundle`

**作用：** 提交草稿进入异步审核队列，返回 `upload_task_id` 供轮询任务进度。

### 调用时序

```
uploadBundle() action:
  1. await state.pendingSync       ← 等待所有 in-flight syncBundle 完成
  2. actions.stopSync()             ← 停止节流定时器
  3. actions.syncBundle({products}) ← 最后一次完整同步
  4. POST /seller-prototype/upload-bundle
  5. return uploadTaskId            ← 给上层轮询用
```

### Request Body

```js
{
  bundle_id: string,          // bundle 草稿 ID
  company_id: string,         // 公司 ID（字符串化）
  name: string | undefined    // 类目名称，来自 addEditApparelCategory.state.descriptionType.value
}
```

| 字段         | 类型   | 必填 | 说明                                                                                  |
| ------------ | ------ | ---- | ------------------------------------------------------------------------------------- |
| `bundle_id`  | string | ✅   | bundle 草稿 ID                                                                        |
| `company_id` | string | ✅   | 公司 ID（字符串化）                                                                   |
| `name`       | string | ❌   | 类目名称（与 create-bundle 时传入的 `description_category_lvl3_name` 同源，再次确认） |

### Response

```js
{
  upload_task_id: string; // 异步上传任务 ID
}
```

### 调用源码（app.js pos 755997）

```js
async uploadBundle() {
  try {
    await this.state.pendingSync;
    this.actions.stopSync();
    await this.actions.syncBundle({ products: this.addEditApparel.state.products });
    const { uploadTaskId: e } = await this.$http.sellerPrototypeService.postSiteSellerPrototypeUploadBundle({
      bundleId: this.state.bundleId,
      companyId: String(this.store.$core.store.company.companyId),
      name: this.addEditApparelCategory.state.descriptionType?.value
    });
    return e;
  } catch (e) {
    this.store.$core.notificationLayer.negative(e);
    this.actions.startSync();   // 失败时重启草稿同步
  }
}
```

---

## 五、xy-ozon 中的实现差异（已修正）

通过对比 `xy-ozon/src/background/seller-portal-client.js` 与官方 seller-ui `app.js`，发现以下差异并已修正：

### 5.1 createBundle

| 字段                             | 官方 | xy-ozon 修正前 | xy-ozon 修正后  |
| -------------------------------- | ---- | -------------- | --------------- |
| `company_id`                     | ✅   | ✅             | ✅              |
| `description_category_lvl3_name` | ✅   | ❌ 缺失        | ✅ 新增（可选） |
| `source_item_id`                 | ✅   | ❌ 缺失        | ✅ 新增（可选） |

**修正前问题**：未传类目名称，可能导致服务端按默认类目建草稿，跨店复制时类目错位。

### 5.2 updateBundleItems

| 字段                             | 官方    | xy-ozon 修正前 | xy-ozon 修正后              |
| -------------------------------- | ------- | -------------- | --------------------------- |
| `bundle_id`                      | ✅      | ✅             | ✅                          |
| `company_id`                     | ✅      | ✅             | ✅                          |
| `items`                          | ✅      | ✅             | ✅                          |
| `source`                         | ✅      | ✅             | ✅                          |
| `description_category_lvl3_name` | ❌ 不传 | ⚠️ 误传        | ✅ 移除（属 create-bundle） |

**修正前问题**：`description_category_lvl3_name` 被错误地放到 update 请求里（应属 create-bundle）。服务端可能容忍但不符合 proto。

### 5.3 uploadBundle

| 字段         | 官方    | xy-ozon 修正前 | xy-ozon 修正后                        |
| ------------ | ------- | -------------- | ------------------------------------- |
| `bundle_id`  | ✅      | ✅             | ✅                                    |
| `company_id` | ✅      | ✅             | ✅                                    |
| `name`       | ✅      | ❌ 缺失        | ✅ 新增（可选）                       |
| `strict`     | ❌ 不传 | ⚠️ 自加 `true` | ✅ 保留（xy-ozon 扩展，启用严格模式） |

**修正前问题**：未传 `name`，可能与 create-bundle 时的类目信息不一致。
**保留 `strict: true`**：xy-ozon 自加的扩展，启用严格模式（无效图片/字段直接报错而非静默跳过），与官方不冲突。

### 5.4 BundleItem 字段差异

| 字段                                                             | 官方 apparel BundleItem                       | xy-ozon v3 风格 |
| ---------------------------------------------------------------- | --------------------------------------------- | --------------- |
| `weight` / `depth` / `width` / `height`                          | 在 `attributes` 数组中（4497/9454/9455/9456） | 顶层字段 ✅     |
| `images` / `primary_image`                                       | 在 `attributes` 数组中（4193/4194/4195）      | 顶层字段 ✅     |
| `id` / `item_id` / `group_id` / `sku`                            | ✅ 顶层                                       | ❌ 不传         |
| `barcode`                                                        | 顶层（`;` 分隔多码）                          | 顶层（单码）    |
| `currency` / `vat` / `name` / `offer_id` / `price` / `old_price` | ✅                                            | ✅              |

> 服务端 proto 同时兼容两种 shape（apparel BundleItem 与 v3 ImportProductsRequestItem）。xy-ozon 选择 v3 风格更通用（支持非服装类目），保留不动。

---

## 六、完整调用时序

```
Phase 6a: ERP prepare-bundle-items         🔴 必经 ERP
   ↓ 返回 bundles[] + store_company_id

Phase 6b: createBundle(companyId, catName, sourceItemId)
   ↓ POST /seller-prototype/create-bundle
   ↓ 返回 bundle_id

Phase 6c: updateBundleItems(bundleId, companyId, items, source)
   ↓ POST /seller-prototype/update-bundle-items  （可反复调）
   ↓ 返回 {} （fire-and-forget）

Phase 6d: uploadBundle(bundleId, companyId, name)
   ↓ POST /seller-prototype/upload-bundle
   ↓ 返回 upload_task_id

Phase 7: 轮询 /async-upload/v1/task/get-list + get-errors
```

---

## 七、参考

- **源码定位**：`https://st-21.ozonru.cn/s3/seller-ui-static/products/releases/release-ctt-5508-c85023d1/app.js`
  - `sellerPrototypeService` wrapper 定义：pos 40519-41600
  - `createBundle` action：pos 748452
  - `syncBundle` / `syncBundleChunk` action：pos 752400, 755000
  - `uploadBundle` action：pos 755700
  - `fetchAllData` 触发点：pos 758390
  - product→BundleItem 映射函数：pos 744800

- **xy-ozon 实现**：[src/background/seller-portal-client.js](../src/background/seller-portal-client.js) 行 902-1062

- **流程总览**：[follow-sell-portal-flow.md](./follow-sell-portal-flow.md) Phase 6
