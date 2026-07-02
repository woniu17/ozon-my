# 从 Ozon 同步商品列表 Spec

## Why

ERP 后台"商品列表" Tab 当前只能展示 `product_data_cache` 中零散缓存的单个商品（由插件按 sku 查询时写入），无法展示店铺在 Ozon 上的完整商品列表。用户需要一键拉取店铺所有商品到后端并分页展示。

## What Changes

### OPI 层 (ozon-opi.js)
- 新增 `productList(store, { filter, lastId, limit })` 调用 `POST /v3/product/list`，游标分页拉取商品标识符列表
- 新增 `productInfoListV3(store, { offerIds?, productIds?, skus? })` 调用 `POST /v3/product/info/list`，批量拉取商品详细信息（v3 版本，区别于现有 v2 的 `productInfoList`）

### 后端端点 (admin.js)
- 新增 `POST /admin/api/products/sync?storeId=xxx` 端点：循环调用 `/v3/product/list`（limit=1000，游标翻页直到无更多）+ `/v3/product/info/list`（每页批量拉详情），将结果写入 `product_data_cache` 表（`INSERT OR REPLACE`），返回 `{ synced, total, durationMs }`

### 前端 (admin)
- 商品列表 Tab toolbar 新增店铺选择下拉框 + "同步商品"按钮
- 点击同步按钮后调用同步端点，按钮显示"同步中..."禁用状态，完成后 toast 提示并刷新列表

### 分页展示
- 复用现有 `GET /admin/api/products` 端点和 `loadProducts()` 前端逻辑，无需改动

## Impact
- Affected specs: 无(新功能)
- Affected code:
  - [erp-backend-lite/src/services/ozon-opi.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/ozon-opi.js) — 新增 2 个 OPI 调用
  - [erp-backend-lite/src/modules/admin.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/modules/admin.js) — 新增 1 个同步端点
  - [erp-backend-lite/src/public/admin.html](file:///c:/root/code/ozon-my/erp-backend-lite/src/public/admin.html) — 商品列表 toolbar 加 store 下拉 + 同步按钮
  - [erp-backend-lite/src/public/admin.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/public/admin.js) — 新增同步逻辑

## ADDED Requirements

### Requirement: 商品列表同步
系统 SHALL 通过 `/v3/product/list` + `/v3/product/info/list` 组合接口，从 Ozon 拉取店铺所有商品并写入 `product_data_cache` 表。

#### Scenario: 同步成功
- **WHEN** 用户选择店铺并点击"同步商品"按钮
- **THEN** 后端循环调用 `/v3/product/list`（limit=1000，游标翻页）获取全部商品标识符，再分批调用 `/v3/product/info/list` 批量拉取详情，写入 `product_data_cache`，返回同步数量

#### Scenario: 商品数量超过 1000
- **WHEN** 店铺商品总数超过 1000
- **THEN** 系统自动翻页（用 `last_id` 游标），循环拉取直到 `items` 为空或已达 `total`，每页拉取后立即批量查详情并写入缓存

### Requirement: 商品列表分页展示
同步完成后，商品列表 SHALL 复用现有 `GET /admin/api/products` 端点分页展示，支持 keyword 搜索。

#### Scenario: 同步后查看列表
- **WHEN** 同步完成
- **THEN** 前端刷新商品列表，用户可分页浏览、搜索、点击详情
