# 图床 + 水印加工 Spec

## Why
当前 `prepare-bundle.js` 的水印加工链（`enrichments/watermark.js`）只是"标记模式"——给 `item.images[i]._watermarked = true` 后透传，并未真正下载图片、打水印、替换为可被 Ozon OPI 拉取的公网 URL。导致三个上架入口（按筛选自动上架 / 批量均衡上架 / 上架预览一键上架）实际提交给 OPI 的仍是原 Ozon/第三方图片链接，存在搬运判定风险，且水印模板配置形同虚设。

本 spec 让水印加工链真正生效：下载原图片 → 按 `watermark_templates` 配置用 sharp 渲染水印 → 落盘到 ERP 后端 `public/images/{sku}/{md5(url)}.jpg` → 通过 `IMAGE_HOST_BASE_URL` 拼接公网 URL 替换 `item.images[i].file_name`，使三个上架入口共用同一套图床处理逻辑。

## What Changes
- **改造 `enrichments/watermark.js`**：从"标记模式"升级为"真下载 + sharp 渲染 + 落盘 + URL 替换"模式；保留 `sharp` 未安装时透传的降级。
- **新增配置项 `IMAGE_HOST_BASE_URL`**：ERP 后端公网反代基址（如 `https://2.tencent.yochylin.com:17443`），用于拼接 `public/images/` 下文件的公网访问 URL。
- **新增 `services/image-host.js`**：封装"下载 → 渲染 → 落盘 → 返回公网 URL"核心流程，幂等（基于 `{sku}/{md5(url)}.jpg` 文件名），失败透传原图 URL。
- **约定 `watermark_templates.config` schema**：明确 text / border / image 三种模板的字段结构（`type` + 对应子对象）。
- **改造 `listing-builder.js`**：从 `listing_templates.config_json` 读取 `applyWatermark` + `watermarkTemplateId`，注入到 `message`（供 `prepareBundleItems` 加工链读取）。
- **改造 `prepare-bundle.js`**：将 `message.applyWatermark` 和 `message.watermarkTemplateId` 透传到 `applyWatermark(processed, message)` 调用（已有签名兼容，无需改动调用方）。
- **静态目录挂载**：`app.js` 已挂载 `express.static(PUBLIC_DIR)`，`public/images/` 自动可访问；无需新增路由。
- **`.gitignore`**：将 `erp-backend-lite/src/public/images/` 加入忽略（生成产物不入库）。
- **`package.json`**：将 `sharp` 从 `optionalDependencies` 提升为 `dependencies`（功能依赖 sharp 才能工作；缺失时降级透传，但应安装）。

## Impact
- Affected specs: 无（新功能）
- Affected code:
  - `erp-backend-lite/src/services/enrichments/watermark.js`（核心改造）
  - `erp-backend-lite/src/services/image-host.js`（新增）
  - `erp-backend-lite/src/services/listing-builder.js`（注入 applyWatermark + watermarkTemplateId）
  - `erp-backend-lite/src/config/index.js`（读取 `IMAGE_HOST_BASE_URL`）
  - `erp-backend-lite/.env.example`（新增配置说明）
  - `erp-backend-lite/.gitignore`（忽略 `public/images/`）
  - `erp-backend-lite/package.json`（sharp 升级为 dependency）
  - `erp-backend-lite/src/db/schema.sql`（注释中标注 `watermark_templates.config` 约定 schema）
- 不受影响：
  - `batch-upload.js` / `batch-upload-poller.js` / `Preview.vue` / `products.js`：上游调用方完全无感，所有改动收敛在 `prepareBundleItems` 加工链内。
  - `watermark_templates` 表结构：保持不变，仅约定 `config` JSON schema。

## ADDED Requirements

### Requirement: 图片下载与水印渲染
系统 SHALL 在 `prepareBundleItems` 加工链的 watermark 步骤中，对每个 `item.images[i].file_name` 是 http(s) URL 的图片执行：
1. 下载原图到内存（undici request，超时 30s）
2. 按 `watermarkTemplateId` 加载 `watermark_templates.config`，用 sharp 渲染对应水印（text / border / image 三种类型）
3. 输出为 JPG 落盘到 `erp-backend-lite/src/public/images/{sku}/{md5(originalUrl)}.jpg`
4. 拼接公网 URL `{IMAGE_HOST_BASE_URL}/images/{sku}/{md5(originalUrl)}.jpg` 替换 `item.images[i].file_name`
5. 同 URL 幂等：文件已存在时直接复用，跳过下载与渲染

#### Scenario: 模板 type=text
- **WHEN** `watermark_templates.config` 为 `{type:'text', text:{content, fontSize, color, opacity, position}}`
- **THEN** 用 sharp `composite` 在原图指定位置叠加文字水印（SVG 文本 → buffer → composite）

#### Scenario: 模板 type=border
- **WHEN** `config` 为 `{type:'border', border:{width, color, opacity}}`
- **THEN** 用 sharp `extend` 在四周添加半透明边框

#### Scenario: 模板 type=image
- **WHEN** `config` 为 `{type:'image', image:{url, scale, opacity, position}}`
- **THEN** 下载水印图 → 按 scale 缩放 → 调整 opacity → 在原图指定位置 composite

#### Scenario: 主图保留 default 标记
- **THEN** 替换 URL 时保留 `img.default` 字段不变，确保 `transformItemForPortal` 仍能正确识别主图

### Requirement: 失败降级
系统 SHALL 在以下任一失败场景下透传原 URL，记录 warn 日志，不阻断上架：
- `IMAGE_HOST_BASE_URL` 未配置（功能视为关闭，整批透传）
- `sharp` 模块未安装（功能降级，整批透传）
- `watermarkTemplateId` 为空或对应模板不存在（透传，不渲染水印）
- 下载原图失败（网络错误、404、超时）
- sharp 渲染失败（不支持的图片格式、SVG 合成异常）
- 落盘失败（磁盘满、权限错误）

#### Scenario: 下载超时
- **WHEN** 下载某图片超过 30 秒未返回
- **THEN** 中止该图片下载，记录 warn 日志，`img.file_name` 保留原 URL，继续处理下一张

#### Scenario: 单图失败不影响其他图
- **WHEN** item 有 5 张图，第 3 张下载失败
- **THEN** 第 3 张透传原 URL，其余 4 张正常渲染并替换为图床 URL

### Requirement: 配置项
系统 SHALL 新增环境变量 `IMAGE_HOST_BASE_URL`：
- 不配置时：水印功能降级为透传（即使 listing_templates.applyWatermark=true 也不渲染）
- 配置时：必须是公网可访问的根 URL（如 `https://2.tencent.yochylin.com:17443`），不带尾斜杠
- 拼接规则：`${IMAGE_HOST_BASE_URL}/images/{sku}/{md5(url)}.jpg`

### Requirement: 水印模板配置 schema 约定
`watermark_templates.config` JSON SHALL 遵循以下结构：
```json
{
  "type": "text|border|image",
  "text":    { "content": "string", "fontSize": 32, "color": "#FFFFFF", "opacity": 0.6, "position": "bottom-right" },
  "border":  { "width": 10, "color": "#000000", "opacity": 0.5 },
  "image":   { "url": "https://...", "scale": 0.2, "opacity": 0.5, "position": "bottom-right" }
}
```
- `position` 枚举：`top-left` / `top-right` / `bottom-left` / `bottom-right` / `center`
- `opacity` 范围 0–1
- `type=text` 时 `text` 必填；`type=border` 时 `border` 必填；`type=image` 时 `image` 必填
- 字段缺失时使用默认值（如 fontSize=32, opacity=0.6, position='bottom-right'）

## MODIFIED Requirements

### Requirement: listing-builder.js 模板字段透传
`buildListingMessage` SHALL 从 `listing_templates.config_json` 读取 `applyWatermark` 和 `watermarkTemplateId`，注入到返回的 `message` 对象中：
- `message.applyWatermark = templateConfig.applyWatermark ?? false`
- `message.watermarkTemplateId = templateConfig.watermarkTemplateId ?? null`

#### Scenario: 模板未配置水印字段
- **WHEN** `listing_templates.config_json` 不含 `applyWatermark` / `watermarkTemplateId`
- **THEN** `message.applyWatermark=false`，`message.watermarkTemplateId=null`，加工链跳过水印步骤

#### Scenario: Preview.vue 一键上架
- **WHEN** Preview.vue 调用 `POST /ozon/products/import`，请求体含 `templateId`
- **THEN** `executeListing` → `prepareBundleItems` 加工链按该 templateId 的 `applyWatermark` / `watermarkTemplateId` 决定是否渲染水印

### Requirement: prepare-bundle.js 加工链调用
`prepareBundleItems` SHALL 将 `message.applyWatermark` 和 `message.watermarkTemplateId` 透传给 `applyWatermark(processed, message)`：
- 当前已有 `if (flags.watermark && message.applyWatermark !== false)` 门控，保留
- 但 `feature-flags.watermark` 当前为 `false`：本 spec 不修改 feature-flags 默认值（保持关闭），由用户按需在 `feature-flags.json` 中开启
- **决策**：将门控改为 `message.applyWatermark === true`（显式开启）而非依赖 `flags.watermark`，避免 feature-flags 关闭时即便模板开启也不渲染的问题

#### Scenario: feature-flags.watermark=false 但模板 applyWatermark=true
- **WHEN** 全局 `feature-flags.watermark=false`，但某 listing_template 配置了 `applyWatermark=true` + `watermarkTemplateId=3`
- **THEN** 该批次仍执行水印加工链（由模板显式开启，不受全局 flag 门控）

#### Scenario: IMAGE_HOST_BASE_URL 未配置
- **WHEN** 模板 applyWatermark=true 但 `IMAGE_HOST_BASE_URL` 环境变量为空
- **THEN** 加工链进入 `image-host.js`，检测到 base URL 缺失，直接返回原 URL（透传），记录 warn 日志

## REMOVED Requirements
无（保持向后兼容，未配置水印的批次行为不变）。
