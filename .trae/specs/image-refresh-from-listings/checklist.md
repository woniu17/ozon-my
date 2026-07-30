# 图片更新功能 检查清单

## 后端
- [ ] image_refresh_tasks / image_refresh_items 表已建且索引就位
- [ ] ozon-opi.js 的 productPicturesImport 用扁平请求体（product_id: integer, images: string[]）
- [ ] ozon-opi.js 的 productPicturesInfo 的 product_id 是 string 数组（对齐 Swagger schema）
- [ ] listing-records 的 imageIssue 筛选不误伤无图片问题的记录（关键词匹配 errors JSON）
- [ ] image-refresh 路由走 JWT 鉴权（不在 PUBLIC_PATHS）
- [ ] 源图读取降级链：transformed → raw → dom_cache
- [ ] image-refresh-poller 并发≤3，提交后等5s再查 /v2/product/pictures/info
- [ ] 任务状态汇总逻辑：PARTIAL 仅在 success>0 且 failed>0 时

## 前端
- [ ] Listings.vue 复选框不影响现有筛选/翻页
- [ ] ImageRefreshDialog 源图列表可增删改
- [ ] ImageRefreshDetail 轮询在 RUNNING 时启动，离开页面/非 RUNNING 时停止
- [ ] 缩略图加载失败有兜底（broken image 占位）
- [ ] 批量提交仅纳入图片有问题的 item（非图片问题 item 跳过）

## OPI 调用
- [ ] productPicturesImport 第一张图自动为主图（is_primary），无需额外指定
- [ ] productPicturesInfo 返回 errors 为空才算 SUCCESS
- [ ] 提交后 errors 中的 url 字段对齐源图（便于定位哪张图失败）

## 数据一致性
- [ ] image_refresh_items.source_task_id 正确关联 follow_sell_tasks.local_task_id
- [ ] image_refresh_items.product_id 来自 follow_sell_task_items.product_id
- [ ] 任务详情页 items 顺序与创建时一致（按 id ASC）
