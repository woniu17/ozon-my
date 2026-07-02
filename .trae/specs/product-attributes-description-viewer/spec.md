# 商品特征描述与详情信息查看器 Spec

## Why

ERP 后台"商品列表" Tab 当前只能查看 `product_data_cache` 中由 OPI `/v2/product/info` 返回的基础信息(名称/价格/图片/状态/库存等),不包含"商品特征描述"(attributes)和"商品详情信息"(description 文本)。

用户点击商品后,期望看到 Ozon 卖家中心的两个核心数据原始 JSON:
1. **商品特征描述**:来自 `/v4/product/info/attributes`,含 `attributes[]`、`complex_attributes[]`、`description_category_id`、`type_id` 等
2. **商品详情信息**:来自 `/v1/product/info/description`,含 `description` 文本

现有后端未对接这两个 Ozon 端点,需新增拉取+缓存能力,并在 admin 前端展示原始 JSON。

## What Changes

### 后端 (erp-backend-lite)
- **新增 OPI 调用**:在 [ozon-opi.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/ozon-opi.js) 新增 `productInfoAttributes(store, filter)` 调用 `/v4/product/info/attributes`、`productInfoDescription(store, body)` 调用 `/v1/product/info/description`
- **新增缓存表**:在 [schema.sql](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/schema.sql) 新增 `product_attributes_cache` 表(sku 主键 + attributes_data JSON + description_data JSON + fetched_at),并同步更新 seed.js
- **新增管理端端点**:在 [admin.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/modules/admin.js) 新增 `GET /admin/api/products/:sku/attributes` 端点,三级缓存(内存 → DB → OPI 实时拉取),返回 `{ attributes, description }` 原始 JSON

### 前端 (admin)
- **改造商品详情弹窗**:在 [admin.html](file:///c:/root/code/ozon-my/erp-backend-lite/src/public/admin.html) 的 `#productDetailModal` 内,把当前单一"完整 JSON"视图改造为 3 个子 Tab(基础信息 / 商品特征描述 / 商品详情信息),每个 Tab 展示对应原始 JSON
- **JS 联动**:在 [admin.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/public/admin.js) 的 `openProductDetail(sku)` 中,点击"商品特征描述"或"商品详情信息"子 Tab 时,按需调用新端点拉取并渲染

## Impact
- Affected specs: 无(新功能)
- Affected code:
  - [erp-backend-lite/src/services/ozon-opi.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/ozon-opi.js) — 新增 2 个 OPI 调用
  - [erp-backend-lite/src/db/schema.sql](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/schema.sql) — 新增 `product_attributes_cache` 表
  - [erp-backend-lite/src/db/seed.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/seed.js) — 新增表 seed 示例
  - [erp-backend-lite/src/modules/admin.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/modules/admin.js) — 新增 1 个端点
  - [erp-backend-lite/src/public/admin.html](file:///c:/root/code/ozon-my/erp-backend-lite/src/public/admin.html) — 改造商品详情弹窗
  - [erp-backend-lite/src/public/admin.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/public/admin.js) — 新增子 Tab 切换 + 按需拉取逻辑

## ADDED Requirements

### Requirement: 商品特征描述拉取
系统 SHALL 通过 OPI `/v4/product/info/attributes` 按 `offer_id` 或 `product_id` 拉取商品的特征描述(含 `attributes[]`、`complex_attributes[]`、`description_category_id`、`type_id`),并缓存到 `product_attributes_cache` 表。

#### Scenario: 缓存命中
- **WHEN** 管理端请求某 sku 的特征描述,且 `product_attributes_cache` 中存在未过期记录(fetched_at 在 TTL 内)
- **THEN** 系统直接返回缓存的 `attributes_data`,不调用 Ozon API

#### Scenario: 缓存未命中
- **WHEN** 缓存不存在或已过期(TTL 1 小时)
- **THEN** 系统调用 OPI `/v4/product/info/attributes` 拉取,写入 `product_attributes_cache` 表,返回原始 JSON

### Requirement: 商品详情信息拉取
系统 SHALL 通过 OPI `/v1/product/info/description` 按 `offer_id` 或 `product_id` 拉取商品的详情描述文本,缓存到 `product_attributes_cache.description_data` 列。

#### Scenario: 拉取成功
- **WHEN** OPI 返回 `{ description, id, name, offer_id }`
- **THEN** 系统将 `description` 文本连同 attributes 一起缓存,并在前端"商品详情信息"子 Tab 展示原始 JSON

### Requirement: 商品详情弹窗多视图
商品详情弹窗 SHALL 提供 3 个子 Tab(基础信息 / 商品特征描述 / 商品详情信息),用户点击子 Tab 时按需加载数据。

#### Scenario: 默认展示基础信息
- **WHEN** 用户从商品列表点击"详情"
- **THEN** 弹窗打开,默认展示"基础信息"子 Tab(来自 `product_data_cache.data` 的原始 JSON),无需额外请求

#### Scenario: 切换到特征描述
- **WHEN** 用户点击"商品特征描述"子 Tab
- **THEN** 前端调用 `GET /admin/api/products/:sku/attributes`,展示 `attributes` 字段的原始 JSON(格式化缩进)

#### Scenario: 切换到详情信息
- **WHEN** 用户点击"商品详情信息"子 Tab
- **THEN** 前端在同一请求的响应中取 `description` 字段,展示原始 JSON

## MODIFIED Requirements

### Requirement: 商品详情弹窗
原 `#productDetailModal` 仅展示单一完整 JSON。改为 3 个子 Tab 结构,默认显示"基础信息",其余按需加载。
