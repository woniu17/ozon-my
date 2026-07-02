# Tasks

- [x] Task 1: 新增 OPI 调用 `productList` 和 `productInfoListV3`
  - [x] SubTask 1.1: 在 `erp-backend-lite/src/services/ozon-opi.js` 新增 `productList(store, { filter, lastId, limit })` 调用 `POST /v3/product/list`，请求体 `{ filter: { visibility: 'ALL' }, last_id: lastId || '', limit: limit || 1000 }`
  - [x] SubTask 1.2: 在同文件新增 `productInfoListV3(store, { offerIds, productIds, skus })` 调用 `POST /v3/product/info/list`，请求体 `{ offer_id, product_id, sku }`（三选一，过滤掉 undefined 的）

- [x] Task 2: 新增同步端点 `POST /admin/api/products/sync`
  - [x] SubTask 2.1: 在 `erp-backend-lite/src/modules/admin.js` 新增端点，接收 `?storeId=xxx` 参数（从 `readStores()` 查 store 凭据，缺失返回 400）
  - [x] SubTask 2.2: 循环调用 `productList(store, { lastId, limit: 1000 })`，每次取 `items[].product_id` 收集标识符，更新 `lastId`，直到 `items` 为空
  - [x] SubTask 2.3: 每收集到一批 product_id（最多 1000 个），立即调用 `productInfoListV3(store, { productIds })` 批量拉详情，将每个 item `INSERT OR REPLACE` 到 `product_data_cache`（sku 用 item.sku，data 用 JSON.stringify(item)）
  - [x] SubTask 2.4: 返回 `ok({ synced, total, durationMs })`，synced 为写入数量，total 为 `/v3/product/list` 返回的 total

- [x] Task 3: 前端商品列表 Tab 加店铺选择 + 同步按钮
  - [x] SubTask 3.1: 在 `erp-backend-lite/src/public/admin.html` 的 `#tabProducts` toolbar 内，新增店铺下拉 `<select id="prodFilterStore">` + "同步商品"按钮 `<button id="prodSyncBtn">`
  - [x] SubTask 3.2: 在 `erp-backend-lite/src/public/admin.js` 的 `loadProducts()` 中，若 `#prodFilterStore` 有值则追加 `storeId` 到查询参数（可选，便于后续过滤）
  - [x] SubTask 3.3: 新增 `syncProducts()` 函数：从 `#prodFilterStore` 取 storeId（缺失用 `storesCache[0]?.id`），调 `POST /admin/api/products/sync?storeId=xxx`，按钮显示"同步中..."禁用，完成后 toast 提示"同步完成: N 个商品"并刷新列表
  - [x] SubTask 3.4: 在 `loadStores()`（或店铺列表加载逻辑）完成后时，同步填充 `#prodFilterStore` 下拉选项

- [x] Task 4: 验证
  - [x] SubTask 4.1: 运行 `node --check` 校验所有修改的 JS 文件语法
  - [x] SubTask 4.2: 运行 `npm run format:check` 验证 Prettier 格式

# Task Dependencies
- Task 2 依赖 Task 1 (OPI 调用)
- Task 3 依赖 Task 2 (后端端点)
- Task 4 依赖 Task 2、Task 3
