# 上架记录图片更新 Spec

## Why
上架成功后常出现图片问题（Ozon 抓取失败、审核拒绝图片、本地预检标记无效图等）。当前无闭环工具：无法筛选图片有问题的上架记录，也无法针对已上架商品单独/批量重提图片。

本 spec 在「上架记录页」(Listings.vue) 新增图片更新能力：
1. 筛选出所有图片有问题的上架记录
2. 单条更新图片
3. 批量更新图片
4. 图片更新任务生成记录（可追溯、可重试）

图片更新复用已验证的 OPI 接口 `/v1/product/pictures/import`（提交）+ `/v2/product/pictures/info`（查状态），并复用上架模板的图片加工能力（水印 + 图片顺序）。

## What Changes

### 后端
- **`services/ozon-opi.js`**：新增 `productPicturesImport(store, { product_id, images, color_image?, images360? })` 和 `productPicturesInfo(store, productIds[])` 两个封装。
- **`db/schema.sql`**：新增 `image_refresh_tasks` + `image_refresh_items` 两表（轻量任务模型，不污染 batch_upload 语义）。
- **`modules/admin.js`**：扩展 `GET /admin/api/listing-records` 支持 `?imageIssue=1` 筛选图片问题记录。
- **`modules/image-refresh.js`（新增）**：图片更新任务路由模块（创建/列表/详情/重试）。
- **`services/image-refresh-poller.js`（新增）**：轮询 `image_refresh_tasks`，对每个 item 执行「读源图 → 按模板加工水印 → 调 productPicturesImport → 查 productPicturesInfo 验证 → 更新状态」。
- **`app.js`**：注册 image-refresh 路由 + 启动 image-refresh-poller。

### 前端
- **`views/Listings.vue`**：筛选栏加「图片问题」选项；表格加复选框列；行操作菜单加「更新图片」；选中后顶部出现「批量更新图片」按钮。
- **`components/ImageRefreshDialog.vue`（新增）**：更新图片弹窗（源图预览 + 模板选择 + 提交）。
- **`views/ImageRefreshDetail.vue`（新增）**：图片更新任务详情页（进度 + items 明细 + 每项图片状态）。
- **`api/imageRefresh.js`（新增）**：前端 API 封装。
- **`router/index.js`**：新增路由 `/image-refresh/:localTaskId`。

## Impact
- Affected code:
  - `erp-backend-lite/src/services/ozon-opi.js`（新增 2 个 OPI 封装）
  - `erp-backend-lite/src/db/schema.sql`（新增 2 表）
  - `erp-backend-lite/src/db/index.js`（建表 + 迁移）
  - `erp-backend-lite/src/modules/admin.js`（listing-records 筛选扩展）
  - `erp-backend-lite/src/modules/image-refresh.js`（新增）
  - `erp-backend-lite/src/services/image-refresh-poller.js`（新增）
  - `erp-backend-lite/src/app.js`（注册路由 + 启动 poller）
  - `erp-backend-lite/web/src/views/Listings.vue`（筛选 + 复选框 + 操作入口）
  - `erp-backend-lite/web/src/components/ImageRefreshDialog.vue`（新增）
  - `erp-backend-lite/web/src/views/ImageRefreshDetail.vue`（新增）
  - `erp-backend-lite/web/src/api/imageRefresh.js`（新增）
  - `erp-backend-lite/web/src/router/index.js`（新增路由）
- 不受影响：
  - `batch-upload-*`：图片更新独立调度，不复用 batch_upload 框架（场景不同：图片更新基于已上架商品，非新商品分配）。
  - `prepare-bundle.js` / `listing-builder.js`：仅复用其 `processImageBatch` 加工能力，不改动。

## ADDED Requirements

### Requirement: 图片问题筛选
系统 SHALL 在 `GET /admin/api/listing-records` 支持 `?imageIssue=1` 查询参数，筛选出满足以下任一条件的上架记录：
1. `follow_sell_tasks.invalid_image` 非空且非 `[]`（本地预检标记的无效图）
2. `EXISTS` 子查询：`follow_sell_task_items.has_error = 1` 且 `errors` JSON 含图片相关关键词（`image`/`photo`/`picture`/`图片`/`照片`，不区分大小写）

筛选为快速预筛（基于上架时已存的 OPI 响应），可能遗漏「创建成功但 Ozon 后期抓取失败」的记录。详情页提供「检查图片状态」按钮实时调 `/v2/product/pictures/info` 确认 Ozon 最新图片状态。

### Requirement: 图片更新任务数据模型
系统 SHALL 新增两张表存储图片更新任务：

```sql
CREATE TABLE IF NOT EXISTS image_refresh_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,    -- img-{timestamp}-{rand}
  store_id       TEXT NOT NULL,            -- 目标店铺（图片所属店铺）
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  template_id    INTEGER,                  -- 使用的上架模板（水印/图片顺序），NULL=不加工直接重提
  source_type    TEXT DEFAULT 'manual',   -- manual(单条) / batch(批量)
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_irt_status ON image_refresh_tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS image_refresh_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,          -- 关联 image_refresh_tasks.local_task_id
  source_task_id   TEXT,                   -- 来源上架记录 local_task_id（follow_sell_tasks）
  source_item_offer_id TEXT,              -- 来源上架记录的 offer_id（卖家 SKU）
  product_id       TEXT NOT NULL,          -- Ozon 商品 ID
  store_id         TEXT NOT NULL,
  status           TEXT DEFAULT 'PENDING',  -- PENDING/PROCESSING/SUCCESS/FAILED/SKIPPED
  source_images    TEXT,                   -- JSON: 源图 URL 数组（加工前）
  processed_images TEXT,                   -- JSON: 加工后 URL 数组（水印+图床，提交给 OPI 的）
  opi_result       TEXT,                   -- JSON: /v2/product/pictures/info 返回的图片状态 + errors
  error_message    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_iri_task ON image_refresh_items(task_id);
CREATE INDEX IF NOT EXISTS idx_iri_status ON image_refresh_items(status);
```

### Requirement: 源图来源
图片更新时，源图 URL SHALL 按以下优先级获取：
1. **默认**：从 `follow_sell_task_payloads` 读 `transformed` stage（上架时已加工好的图床 URL），可直接重提 OPI，无需重新加工。`template_id` 置 NULL。
2. **重新加工**：用户在弹窗选择上架模板时，从 `raw` stage 读原始采集图，经 `processImageBatch(urls, sku, templateConfig)` 重新走水印加工链，产出新的图床 URL。`template_id` 记录所用模板。

若 `transformed` / `raw` payload 均不存在（如 viaPortal 上架无 payload 备份），降级从 `ozon_dom_cache.detail_data.images` 按 offer_id 关联 sku 读取。

### Requirement: 图片加工复用上架模板
更新图片时若选择上架模板，系统 SHALL 复用 `listing_templates` 配置中的图片相关能力：
- `applyWatermark` + `watermarkTemplateId`：调 `processImageBatch(urls, sku, watermarkTemplateConfig)` 渲染水印并替换为图床 URL。
- `imageOrder`：`keep`（保持原序）/ `shuffle_non_primary`（打乱非主图顺序）。
- 不复用 `ai_rewrite`（改标题，非图片范畴）/ `applyPoster`（依赖 item 上下文，图片更新场景无完整 item）/ 价格库存字段。

### Requirement: OPI 接口封装
`services/ozon-opi.js` SHALL 新增：
- `productPicturesImport(store, { product_id, images, color_image?, images360? })` → `POST /v1/product/pictures/import`（扁平请求体，product_id 为 integer）。
- `productPicturesInfo(store, productIds)` → `POST /v2/product/pictures/info`（product_id 为 string 数组，单次最多 1000），返回 `items[].{product_id, primary_photo[], photo[], color_photo[], photo_360[], errors[]}`。

### Requirement: 单条更新图片
用户 SHALL 能在上架记录详情弹窗的 items 明细中，对单个商品点「更新图片」：
1. 打开 `ImageRefreshDialog`，自动带出该商品的源图（transformed 优先）。
2. 用户可选模板（默认不加工）+ 编辑图片 URL 列表（增删改）。
3. 提交 → 后端创建 `image_refresh_tasks`（total_count=1, source_type=manual）+ 跳转任务详情页。

### Requirement: 批量更新图片
用户 SHALL 能在上架记录列表勾选多条记录后点「批量更新图片」：
1. 打开 `ImageRefreshDialog`，展示选中记录数 + 涉及商品数。
2. 用户选模板（统一应用）。
3. 提交 → 后端为每条记录的每个有图片问题的 item 创建 `image_refresh_items`，归入同一个 `image_refresh_tasks`（source_type=batch）+ 跳转任务详情页。

批量提交时仅纳入「图片有问题」的 item（has_error + 图片关键词 OR 该记录 invalid_image 非空），非图片问题的 item 跳过。

### Requirement: 图片更新任务调度
`services/image-refresh-poller.js` SHALL 以 2s 周期轮询 `image_refresh_tasks`（status=PENDING/RUNNING）：
1. 取任务下 status=PENDING 的 items（单次并发 3）。
2. 每个 item：
   - 标记 PROCESSING
   - 读源图（按 Requirement: 源图来源）
   - 若 template_id 非空：调 `processImageBatch` 加工
   - 调 `productPicturesImport` 提交
   - 调 `productPicturesInfo` 查最新状态 + errors（提交后等 5s 冷却，对齐项目约定）
   - errors 为空 → SUCCESS，否则 FAILED + 记录 errors
3. 汇总任务状态：全 SUCCESS→SUCCESS / 全 FAILED→FAILED / 混合→PARTIAL。

### Requirement: 任务详情页
`views/ImageRefreshDetail.vue` SHALL 展示：
- 任务概要（状态/总数/成功/失败/模板/创建时间）
- items 表格：product_id / offer_id / 状态 / 源图缩略图 / 加工后图缩略图 / OPI 返回的 errors
- 每个 FAILED item 提供「重试」按钮（重置为 PENDING，重新调度）
- 3s 自动轮询（RUNNING 时）

### Requirement: 路由
- `POST /admin/api/image-refresh` — 创建任务（单条/批量，body: { items: [{sourceTaskId, offerId, productId, storeId, sourceImages?}], templateId? }）
- `GET /admin/api/image-refresh` — 任务列表
- `GET /admin/api/image-refresh/:localTaskId` — 任务详情（含 items）
- `POST /admin/api/image-refresh/:localTaskId/items/:id/retry` — 重试单项
- `POST /admin/api/products/:productId/pictures-info` — 实时查单个商品图片状态（详情页「检查图片状态」按钮用）

所有路由走 JWT 鉴权（不在 PUBLIC_PATHS）。
