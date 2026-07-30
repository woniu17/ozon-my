# 图片更新功能 实施任务

## 阶段1:后端基础设施
- [ ] 1.1 `db/schema.sql` 新增 `image_refresh_tasks` + `image_refresh_items` 表定义
- [ ] 1.2 `db/index.js` 建表 + 迁移（IF NOT EXISTS 自动建）
- [ ] 1.3 `services/ozon-opi.js` 新增 `productPicturesImport` 封装（POST /v1/product/pictures/import，扁平请求体）
- [ ] 1.4 `services/ozon-opi.js` 新增 `productPicturesInfo` 封装（POST /v2/product/pictures/info，product_id string 数组）

## 阶段2:图片问题筛选
- [ ] 2.1 `modules/admin.js` 扩展 `GET /admin/api/listing-records` 支持 `?imageIssue=1`：WHERE 加 `invalid_image 非空` OR `EXISTS items.has_error=1 AND errors LIKE 图片关键词`
- [ ] 2.2 图片关键词常量：`image|photo|picture|图片|照片`（不区分大小写）

## 阶段3:图片更新任务路由
- [ ] 3.1 新建 `modules/image-refresh.js`：`POST /admin/api/image-refresh`（创建任务，校验 items + 查源图 + 入库）
- [ ] 3.2 `GET /admin/api/image-refresh`（任务列表，分页）
- [ ] 3.3 `GET /admin/api/image-refresh/:localTaskId`（任务详情 + items）
- [ ] 3.4 `POST /admin/api/image-refresh/:localTaskId/items/:id/retry`（重置 item 为 PENDING）
- [ ] 3.5 `POST /admin/api/products/:productId/pictures-info`（实时查 /v2/product/pictures/info，body: { storeId }）
- [ ] 3.6 `app.js` 注册 image-refresh 路由

## 阶段4:源图读取
- [ ] 4.1 `services/image-refresh-poller.js` 实现 `getSourceImages(sourceTaskId, offerId)`：
  - 优先 `follow_sell_task_payloads.transformed`（读 items[].images / primary_image）
  - 次选 `raw` stage
  - 降级 `ozon_dom_cache.detail_data.images`（通过 offer_id → sku 关联）

## 阶段5:任务调度
- [ ] 5.1 新建 `services/image-refresh-poller.js`：2s 轮询 PENDING/RUNNING 任务
- [ ] 5.2 单 item 处理：标记 PROCESSING → 读源图 → 按模板加工(processImageBatch) → productPicturesImport → 等5s → productPicturesInfo → 更新状态
- [ ] 5.3 并发控制：单次最多 3 个 item 并发
- [ ] 5.4 任务状态汇总：全 SUCCESS→SUCCESS / 全 FAILED→FAILED / 混合→PARTIAL
- [ ] 5.5 `app.js` 启动时拉起 image-refresh-poller

## 阶段6:前端 - 上架记录页
- [ ] 6.1 `views/Listings.vue` 筛选栏加「图片问题」select 选项（value=imageIssue=1）
- [ ] 6.2 表格加复选框列（绑定 selectedIds）
- [ ] 6.3 选中后顶部出现「批量更新图片」按钮
- [ ] 6.4 详情弹窗 items 行加「更新图片」操作按钮
- [ ] 6.5 详情弹窗 items 行加「检查图片状态」按钮（调 /pictures-info 实时查）

## 阶段7:前端 - 更新图片弹窗
- [ ] 7.1 新建 `components/ImageRefreshDialog.vue`：源图预览 + 模板选择 + 图片 URL 编辑
- [ ] 7.2 单条模式：传入 sourceTaskId + offerId，自动带出源图
- [ ] 7.3 批量模式：传入选中记录，展示商品数，统一选模板
- [ ] 7.4 提交 → POST /admin/api/image-refresh → 跳转 /image-refresh/:localTaskId

## 阶段8:前端 - 任务详情页
- [ ] 8.1 新建 `api/imageRefresh.js`：createImageRefresh / getImageRefreshList / getImageRefreshDetail / retryImageRefreshItem
- [ ] 8.2 新建 `views/ImageRefreshDetail.vue`：任务概要 + items 表 + 缩略图 + errors
- [ ] 8.3 3s 自动轮询（RUNNING 时）
- [ ] 8.4 FAILED item 「重试」按钮
- [ ] 8.5 `router/index.js` 新增路由 `/image-refresh/:localTaskId`

## 阶段9:联调验证
- [ ] 9.1 单条更新：选一个图片有问题的记录 → 更新图片 → 确认任务成功 + /v2/product/pictures/info errors 为空
- [ ] 9.2 批量更新：选多条 → 批量更新 → 确认任务进度正确推进
- [ ] 9.3 筛选：imageIssue=1 能筛出已知图片问题记录
- [ ] 9.4 重试：FAILED item 重试后状态正确流转
