# Tasks

- [x] Task 1: 新增配置项 `IMAGE_HOST_BASE_URL`
  - [x] SubTask 1.1: `erp-backend-lite/src/config/index.js` 增加 `imageHostBaseUrl: process.env.IMAGE_HOST_BASE_URL || ''` 字段
  - [x] SubTask 1.2: `erp-backend-lite/.env.example` 追加 `IMAGE_HOST_BASE_URL` 说明段（注释：图床公网反代基址，不配置则水印功能降级透传）

- [x] Task 2: 新增 `services/image-host.js` 核心模块
  - [x] SubTask 2.1: 实现 `processImage(url, sku, templateConfig)` 函数：下载 → sharp 渲染 → 落盘 → 返回公网 URL；任一步失败抛错由调用方降级
  - [x] SubTask 2.2: 实现 `renderWatermark(buffer, config)` 内部函数：按 `config.type` 分发到 `renderText` / `renderBorder` / `renderImage` 三种渲染器（用 sharp `composite` / `extend`）
  - [x] SubTask 2.3: 实现幂等：目标文件已存在时直接返回公网 URL（跳过下载与渲染）
  - [x] SubTask 2.4: 实现路径计算：`{PUBLIC_DIR}/images/{sku}/{md5(url)}.jpg`，自动 `fs.mkdir` 创建子目录

- [x] Task 3: 改造 `services/enrichments/watermark.js`
  - [x] SubTask 3.1: 删除当前"标记模式"实现（`img._watermarked = true`）
  - [x] SubTask 3.2: 改为读取 `message.watermarkTemplateId` → 查 `watermark_templates` 表 → 拿到 `config` JSON
  - [Task 3.2 依赖 Task 5 的 schema 约定]
  - [x] SubTask 3.3: 对每张图调 `image-host.processImage`，成功则替换 `img.file_name` 为公网 URL，失败则透传原 URL（保留 `img.default` 不变）
  - [x] SubTask 3.4: `IMAGE_HOST_BASE_URL` 未配置 / `sharp` 未安装 / `watermarkTemplateId` 为空 或模板不存在 → 整批透传（不进入 image-host）
  - [x] SubTask 3.5: 处理完成后记录 `logger.info({total, processed, fallback})` 统计

- [x] Task 4: 改造 `services/listing-builder.js` 注入模板字段
  - [x] SubTask 4.1: 在 `buildListingMessage` 中，当 `templateId` 存在时，从 `getTemplateConfig(templateId)` 读取 `applyWatermark` / `watermarkTemplateId`
  - [x] SubTask 4.2: 注入到返回的 `message` 对象：`message.applyWatermark = tplCfg.applyWatermark === true`、`message.watermarkTemplateId = tplCfg.watermarkTemplateId ?? null`

- [x] Task 5: 约定 `watermark_templates.config` schema 并写入 schema.sql 注释
  - [x] SubTask 5.1: 在 `erp-backend-lite/src/db/schema.sql` 的 `watermark_templates` 表注释中追加 `config` JSON schema 约定（type / text / border / image 字段说明 + position 枚举）
  - [x] SubTask 5.2: 在 `enrichments/watermark.js` 顶部 JSDoc 注释中说明 schema

- [x] Task 6: 调整 `prepare-bundle.js` 加工链门控
  - [x] SubTask 6.1: 将 watermark 步骤门控从 `flags.watermark && message.applyWatermark !== false` 改为 `message.applyWatermark === true`（显式开启，解除对 feature-flags.watermark 的依赖）
  - [x] SubTask 6.2: 更新 `prepare-bundle.js` 顶部加工链注释，标注 watermark 步骤的触发条件变更

- [x] Task 7: 更新 `.gitignore` 与 `package.json`
  - [x] SubTask 7.1: `erp-backend-lite/.gitignore` 追加 `src/public/images/`（生成产物不入库）
  - [x] SubTask 7.2: `erp-backend-lite/package.json` 将 `sharp` 从 `optionalDependencies` 移到 `dependencies`（仍保留 try-import 兜底，但默认安装）

- [x] Task 8: 验证三个上架入口的端到端流程
  - [x] SubTask 8.1: 按筛选自动上架：`POST /admin/api/batch-upload/auto-pick` → `batch-upload-poller` → `buildListingMessage` → `prepareBundleItems` → 检查 ` opi_request` payload 中 `images` 是否为图床 URL
  - [x] SubTask 8.2: 批量均衡上架：`POST /admin/api/batch-upload` → 同上验证
  - [x] SubTask 8.3: 上架预览一键上架：Preview.vue 选模板（applyWatermark=true + watermarkTemplateId=N）→ `POST /ozon/products/import` → 同上验证（已修复 executeListing 注入字段）
  - [x] SubTask 8.4: 验证幂等性：同一 SKU 重复触发上架，`public/images/{sku}/` 下不重复生成文件
  - [x] SubTask 8.5: 验证降级：`IMAGE_HOST_BASE_URL` 不配置时，images 全部透传原 URL，上架不中断

# Task Dependencies
- [Task 3] 依赖 [Task 2]（image-host 模块）和 [Task 5]（schema 约定）
- [Task 4] 依赖 [Task 5]（字段名对齐）
- [Task 6] 依赖 [Task 3]（门控调整后由 watermark.js 实际执行）
- [Task 8] 依赖 [Task 1]–[Task 7] 全部完成
- [Task 1]、[Task 2]、[Task 5]、[Task 7] 互相独立，可并行

# 修复记录
- 修复 #22 失败项：在 `executeListing` 函数（listing-builder.js）中新增水印字段注入逻辑（第 343-356 行），与 `buildListingMessage` 行为对齐。Preview.vue → /ozon/products/import → executeListing 路径下水印字段能正确传到 `prepareBundleItems`。
