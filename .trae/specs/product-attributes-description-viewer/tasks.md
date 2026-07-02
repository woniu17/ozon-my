# Tasks

- [x] Task 1: 新增 OPI 调用 `productInfoAttributes` 和 `productInfoDescription`
  - [x] SubTask 1.1: 在 `erp-backend-lite/src/services/ozon-opi.js` 新增 `productInfoAttributes(store, filter)` 调用 `POST /v4/product/info/attributes`,请求体 `{ filter: { offer_id 或 product_id }, limit: 100 }`
  - [x] SubTask 1.2: 在同文件新增 `productInfoDescription(store, body)` 调用 `POST /v1/product/info/description`,请求体 `{ offer_id 或 product_id }`

- [x] Task 2: 新增 `product_attributes_cache` 缓存表
  - [x] SubTask 2.1: 在 `erp-backend-lite/src/db/schema.sql` 新增表 `product_attributes_cache(sku TEXT PRIMARY KEY, attributes_data TEXT, description_data TEXT, fetched_at TEXT DEFAULT (datetime('now')))`
  - [x] SubTask 2.2: 在 `erp-backend-lite/src/db/seed.js` 为新表插入 1-2 条示例数据(可用 demo-001 sku,attributes_data 含 `attributes[]` 和 `complex_attributes[]` 示例,description_data 含 `description` 文本)

- [x] Task 3: 新增管理端端点 `GET /admin/api/products/:sku/attributes`
  - [x] SubTask 3.1: 在 `erp-backend-lite/src/modules/admin.js` 新增端点,接收 `:sku` 参数
  - [x] SubTask 3.2: 三级缓存策略:内存缓存(NodeCache,TTL 3600s)→ DB 缓存(`product_attributes_cache` 表,TTL 1 小时)→ OPI 实时拉取(需从 `product_data_cache` 取 `offer_id` 或 `product_id` 作为 filter)
  - [x] SubTask 3.3: OPI 拉取时并行调用 `productInfoAttributes` 和 `productInfoDescription`,合并写入 `product_attributes_cache`,返回 `{ attributes: <原始JSON>, description: <原始JSON> }`

- [x] Task 4: 改造 admin 商品详情弹窗 HTML 结构
  - [x] SubTask 4.1: 在 `erp-backend-lite/src/public/admin.html` 的 `#productDetailModal .modal-body` 内,替换原 `<pre id="prodDetailJson">` 为 3 个子 Tab 结构:`<div class="sub-tabs">` 含 3 个按钮(基础信息/商品特征描述/商品详情信息)+ 3 个 `<div class="sub-panel">` 各含一个 `<pre>`
  - [x] SubTask 4.2: 默认"基础信息"子 Tab active,其余 hidden

- [x] Task 5: 改造 admin.js 商品详情弹窗 JS 逻辑
  - [x] SubTask 5.1: 修改 `openProductDetail(sku)` 函数:打开弹窗后默认拉取 `GET /admin/api/products/:sku`(基础信息),渲染到"基础信息"子 Tab 的 `<pre>`
  - [x] SubTask 5.2: 新增子 Tab 切换逻辑:点击"商品特征描述"或"商品详情信息"时,若该子 Tab 未加载过,调 `GET /admin/api/products/:sku/attributes`,把 `attributes` 渲染到特征描述子 Tab、`description` 渲染到详情信息子 Tab
  - [x] SubTask 5.3: 子 Tab 切换时显示"加载中..."占位,加载完成后渲染格式化 JSON(`JSON.stringify(data, null, 2)`)

- [x] Task 6: 样式调整与验证
  - [x] SubTask 6.1: 在 `erp-backend-lite/src/public/admin.css` 新增 `.sub-tabs` 和 `.sub-panel` 样式(复用现有 `.tabs` 风格,但更紧凑)
  - [x] SubTask 6.2: 运行 `node --check` 校验所有修改的 JS 文件语法
  - [x] SubTask 6.3: 运行 `npm run format:check` 验证 Prettier 格式

# Task Dependencies
- Task 3 依赖 Task 1 (OPI 调用) 和 Task 2 (缓存表)
- Task 5 依赖 Task 4 (HTML 结构) 和 Task 3 (后端端点)
- Task 6 依赖 Task 4、Task 5
