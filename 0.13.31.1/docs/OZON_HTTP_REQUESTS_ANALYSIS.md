# Ozon MY 0.13.31.1 HTTP 请求清单与作用分析

> 本文档基于对 `ozon-my-0.13.31.1/` 三层源码（content / lib / background）的只读检索，列出插件所有出网 HTTP 请求点及其作用，并专项分析"跟卖链路中是否缺失查询类别请求"的问题。

---

## 一、传输层底层封装（非独立业务请求）

以下三个封装函数承载了大多数出网调用，理解它们有助于看懂后续表格：

| 封装 | 定义位置 | 内部 fetch 行号 | 说明 |
|---|---|---|---|
| `apiRequest` | SW:1406 | SW:1416 | 所有 `${backendUrl}/...` 后端请求统一封装，自动注入 `Authorization: Bearer <token>` 与 `x-ozon-store-id`，处理 401 清 token / X-Refreshed-Token 滑动续期 |
| `fetchSellerPortal` | SW:1149 | SW:1191 | seller.ozon.ru 门户请求封装，三路回退：①`fetchSellerViaOzonTab` 跨域快路（SW:1095 POST）→ ②seller-tab `executeScript` 注入 → ③`chrome.tabs.sendMessage` bridge。**恒为 POST** |
| `fetchOzonWwwViaTab` | SW:1338 | SW:1349/1369 | 借 www.ozon.ru tab MAIN world 注入 `fetch`（GET），回退 SW 直 fetch（几乎必 403） |

`content/ozon-seller-bridge.js:166` 是 seller.ozon.ru content script 上下文的同源 fetch 中继，自动带 cookies，绕开 SW CSP。

---

## 二、跟卖链路（follow-sell）相关请求

### 2.1 源数据采集

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:3490 | `https://seller.ozon.ru/api/v1/search` | POST | `company_id, need_total:true, filter.children_nodes...sku.values:[sku], pagination.limit:"50", is_copy_allowed:false` | 按 SKU 在 Ozon 全平台搜 variant，拿 `variant_id` + 基础元数据(品牌/类目/GTIN/图片) | `searchVariants` action（跟卖面板预取源商品变体） |
| SW:509 | `https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id` | POST | `company_id, variant_id, source:"SOURCE_UI_COPY_APPAREL"` | 用 variant_id 拉跟卖源完整后台数据(重量/尺寸/barcode/40-63 个 attributes)，**有副作用：每次创建 draft bundle_id** | `searchVariants` 第二步（`fetchBundleByVariantId`，24h cache） |
| SW:3343 | `https://seller.ozon.ru/api/v1/search` | POST | 同 SW:3490 | search-variant-model 降级路径，按 SKU 精确定位全平台商品拿 `description_category_id + attributes` | `searchProductBySku` action |

### 2.2 视频 / 富内容 / 描述 / 标签

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:832 | `<srcUrl>`（任意 .mp4 直链） | GET | — | 下载源视频二进制（在 seller tab MAIN world 内跨域拉） | `transferVideoToOzon` 内部 |
| SW:841 | `https://seller.ozon.ru/api/media-storage/upload-file` | POST (multipart) | `file_name, tmp:"true", body:<File>` + 头 `x-o3-company-id, x-o3-language` | 把竞品 .mp4 转存成"卖家自有 Ozon 视频"(`ir.ozone.ru/s3`)，主视频槽只认平台链接 | `uploadFollowSellVideo` / `transferVariantVideo` action |
| SW:982 | `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=<path>` + `/api/composer-api.bx/page/json/v2?url=<path>` | GET | — + 头 `x-o3-app-name:dweb_client` | 借买家 tab 抓 PDP page json，抽源 .mp4 直链 + 富内容(11254) + 描述(4191) + 主题标签(23171) | `transferVariantVideo` / `fetchVariantRichContent` action |
| ozon-product.js:8811 | 同上 entrypoint/composer-api page json | GET | — | content 端直连 fetch 变体图册 + 顺带抽源富内容 11254 | `fetchVariantGallery`（跟卖变体图册采集） |
| ozon-product.js:745 | `/api/entrypoint-api.bx/page/json/v2?url=<modalLink>` + `/api/composer-api.bx/page/json/v2?url=<modalLink>` | GET | — | `jzFetchAspectsModalVariants` 拉「Все N цветов」多变体 modal 全量变体 | 单轴多值商品（>6 色）内联 aspects 不够时 |
| ozon-product.js:1357/9607 | `https://www.ozon.ru` + 变体 `u.pathname` | GET (text/html) | — | Phase A 抓取各色变体商品页 SSR HTML，union aspects 进 variantMap | 多轴变体采集 / 跟卖面板 Phase A 预算 |
| shared-utils.js:2049/2563 | `/api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>` | GET | 头 `x-o3-app-name:dweb_client` | `jzFetchPublicFollowSell` 拉**公开跟卖列表 modal endpoint**，解析 webSellerList widget | hero 跟卖卡 hover、PDP 面板、列表页 V2 面板、控制台 `jzDebugFollowSell` |
| shared-utils.js:231（→ SW:2236/1369） | `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=<productPath>` | GET | — | `ensurePdpState` composer-api 缓存预热，SW 拉 PDP widgetStates 返 {fields, widgetStates} | PDP 字段缺失时兜底（多处调用） |

### 2.3 跟卖提交（viaPortal=false，官方 API 路径）

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:3181 | `${backendUrl}/ozon/products/import` | POST | `message`(items + applyAiImage + applyWatermark + storeId 等) | 跟卖走官方 API 上架：后端入队，AI/水印在 worker 跑 | `followSell` action 且 `viaPortal!=true` |
| SW:3283 | `${backendUrl}/ozon/products/import/status` | POST | `task_id` | 查官方 import 任务状态 | `getImportStatus` action |
| SW:3233 | `${backendUrl}/ozon/products/import-by-sku/tasks?current=&pageSize=` | GET | — | 拉跟卖/按 SKU 上架任务列表 | `listFollowSellTasks` action（弹窗"上架记录"） |
| SW:1868 | `${backendUrl}/ozon/products/import-by-sku/tasks?current=1&pageSize=20` | GET | — | 拉最近跟卖任务，筛 FAILED 且未通知过的，弹桌面通知 | `FOLLOW_SELL_CHECK_ALARM` 定时（`checkFollowSellTasks`） |
| SW:3242 | `${backendUrl}/ozon/products/import-by-sku` | POST | `items:[{sku, offer_id, price, vat, currency_code}]` | 按 SKU 直接上架（区别于跟卖的源商品加工） | `importBySku` action |
| SW:3280 | `${backendUrl}/ozon/stocks/import` | POST | `items:[{offer_id, stock, warehouse_id}]` | 库存批量导入 | `importStock` action |

### 2.4 跟卖提交（viaPortal=true，门户 bundle 接口绕限流）

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:609 | `${backendUrl}/ozon/products/prepare-bundle-items` | POST | `message`(items + applyAiImage + applyWatermark 等) | 后端同步复用全加工流水线，返回分组好的 bundles | `followSell` 且 `viaPortal=true`（`importViaPortal` 第一步） |
| SW:540 | `https://seller.ozon.ru/api/site/seller-prototype/create-bundle` | POST | `company_id` | 门户上架：建空草稿，返回 `bundle_id` | `importViaPortal` 第二步（`createBundle`） |
| SW:552 | `https://seller.ozon.ru/api/site/seller-prototype/update-bundle-items` | POST | `bundle_id, company_id, source, description_category_lvl3_name, items` | 门户上架：写入草稿全部商品数据 | `importViaPortal` 第三步（`updateBundleItems`） |
| SW:566 | `https://seller.ozon.ru/api/site/seller-prototype/upload-bundle` | POST | `bundle_id, company_id, strict:true` | 门户上架：提交发布草稿→真实商品，返回 `upload_task_id` | `importViaPortal` 第四步（`uploadBundle`） |
| SW:578 | `https://seller.ozon.ru/api/site/async-upload/v1/task/get-list` | POST | `company_id, limit:30, page:1` | 轮询门户上架任务进度(processed/failed/warned) | `portalImportStatus` action |
| SW:586 | `https://seller.ozon.ru/api/site/async-upload/v1/task/get-errors` | POST | `company_id, task_id, page:1, page_size:50` | 拉每个 SKU 的失败原因(offer_id + errors[]) | `portalImportStatus` 且 failed>0 |

---

## 三、商品数据 / 采集箱相关请求

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:2810 | `${backendUrl}/sources/{sourceId}/collect` | POST | `raw, storeId?, resetDraft?` | 多源统一采集入库（sourceId=ozon/1688/pdd/taobao），带 24h 去重 + in-flight 合并 + 失败指数退避 | `pushSourceCollect` action |
| SW:2882 | `${backendUrl}/sources/{sourceId}/collect/batch` | POST | `items:[{raw},...]` | 多源批量采集 | `pushSourceCollectBatch` action |
| SW:2730 | `${backendUrl}/ozon/collect-box` | POST | `message.product` | 单条采集入库（旧路径） | `collectProduct` action |
| SW:2855 | `${backendUrl}/ozon/collect-box/batch` | POST | `items, mode:"update"` | 旧批量采集（向后兼容） | `collectBatch` action |
| SW:2866 | `${backendUrl}/ozon/collect-box/batch` | POST | `items, mode:"update"\|"skip"` | 批量推送采集箱 | `pushToCollectBox` action |
| SW:2736 | `${backendUrl}/ozon/collect-box/{cbId}` | PATCH | `message.body`（标题/属性等） | 更新采集箱条目 | `updateCollectBoxItem` action |
| SW:3293 | `${backendUrl}/ozon/collect-box/{id}/ai-listing-draft` | POST | `message.body` | AI 上架草稿创建（重写+类目智选+改图+定价） | `aiListingDraftCreate` action |
| SW:3298 | `${backendUrl}/ozon/collect-box/{id}/ai-listing-draft/confirm` | POST | `message.body` | AI 草稿确认 | `aiListingDraftConfirm` action |
| SW:3303 | `${backendUrl}/ozon/collect-box/{id}/ai-listing-draft/publish` | POST | `message.body` | AI 草稿发布上架 | `aiListingDraftPublish` action |
| SW:1619 | `${backendUrl}/ozon/product-data/batch` | POST | `skus:[...]` | 搜索页多卡合批取商品数据（debounce 100ms / 硬上限 300ms / 满 50 立发） | `getProductStats` action（搜索页卡，无 catIds） |
| SW:1632 | `${backendUrl}/ozon/product-data/{sku}?skipMarket=1` | GET | — | batch 不可用时逐 SKU 兜底 | `flushProductStatsBatch` 失败回退 |
| SW:2956 | `${backendUrl}/ozon/product-data/{sku}?skipMarket=1&catIds=...` | GET | — | PDP 单卡带买家类目 id 直连取数据（佣金按类目精确分档） | `getProductStats` action 且带 catIds |
| SW:3942 | `${backendUrl}/ozon/products/cache?currentPage=1&pageSize=20&sortBy=&sortOrder=desc` | GET | — | 拉推荐商品缓存（hot/blue 两种 sortBy） | `getRecommendations` action |
| SW:3949 | `${backendUrl}/ozon/products/cache/status-counts` | GET | — | 商品状态计数 | `getProductStatusCounts` action |
| SW:3946 | `${backendUrl}/ozon/collect-box?currentPage=1&pageSize=1` | GET | — | 采集箱总数（badge） | `getCollectCount` action |
| SW:2936 | `${backendUrl}/ozon/favorites` | POST | `message.product` | 加收藏 | `addFavorite` action |
| SW:3952 | `${backendUrl}/ozon/favorites?currentPage=1&pageSize=1` | GET | — | 收藏总数（badge） | `getFavCount` action |
| SW:3035/3610 | `https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3` | POST | `filter:{stock:"any_stock", period, sku\|categories}, sort:{key:sortKey}` + 头 `x-o3-company-id` | 在 seller tab 内注入 fetch 直打 data/v3，按 SKU 取月/周销量等市场数据 / 按 categories 拉类目 Bestsellers | `getMarketStats` / `fetchBestsellers` action |
| SW:3626 | `${backendUrl}/ozon/selection/bestsellers/snapshot` | POST | `period, items` | 把 Bestsellers 结果同步到后端按日存档 | `fetchBestsellers` 成功后自动同步 |
| SW:3671 | `/api/entrypoint-api.bx/page/json/v2?url=/product/{sku}` + `/api/composer-api.bx/page/json/v2?url=...` | GET | 头 `x-o3-app-name:dweb_client` | 按 SKU 抓 ozon.ru 公开商品页，炼 pageProduct(name/images/breadcrumbs/brand/weight/dims) | `fetchOzonPublicProduct` action |
| SW:3831 | `<message.url>`（ozon CDN 图片） | GET | — | 代为 fetch ozon CDN 图片返 base64，避开 1688 页面 CORS | `proxyImageFetch` action |
| ozon-product.js:1984 | `mainImage`（ir.ozone.ru CDN） | GET | — | 下载商品主图为 blob，喂给 Ozon 图搜上传入口 | 用户点「以图搜图」按钮 |
| ozon-product.js:7456 | `${backendUrl}/ozon/templates?pageSize=100` | GET | — | 拉后端模板列表 | 多变体面板「加载模板」按钮 |
| ozon-product.js:7560 | `${backendUrl}/ozon/templates/{templateId}/apply` | POST | `productData + variables` | 应用模板到多变体面板 | 多变体面板选模板后应用 |

---

## 四、类目（category）相关请求 — 专项

> **本节是用户重点关注对象**

### 4.1 类目相关请求清单

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:3252 | `${backendUrl}/ozon/categories/tree?language=<lang>` | GET | — | **获取 Ozon 完整类目树** | `getCategoryTree` action |
| SW:3259 | `${backendUrl}/ozon/description-category/{typeId}/attributes` | GET | — | **按 description_category_id 查询类目属性 schema**（含 is_required/dictionary_id；只要 typeId，后端内部反查 description_category_id） | `getCategoryAttributes` action |
| SW:3270 | `${backendUrl}/ozon/ai/suggest-category` | POST | `message.body`（1688 标题+属性） | **AI 类目建议**：LLM 输出末级类目中文名 | `suggestCategory` action |
| SW:3275 | `${backendUrl}/ozon/ai/verify-category` | POST | `message.body` | **叶子类目复核**：LLM 确认是否适合该商品 | `verifyCategory` action |
| SW:3035/3610 | `https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3` | POST | `filter:{..., categories:[...]}` | **按类目查 Bestsellers**（categories 在 filter 内） | `fetchBestsellers` action |
| SW:3856 | `${backendUrl}/ozon/selection/category-mapping` | POST | `name, leafIds[], source` | 上报"一级类目名→leaf IDs[]"映射（由 bestsellers-hook 在 seller.ozon.ru 学到） | `reportCategoryMapping` action |
| SW:3937 | `${backendUrl}/ozon/extension/ai-optimize` | POST | `title, description, category, keywords` | AI 优化标题/描述（含 category 字段，间接类目上下文） | `aiOptimize` action |
| SW:2956 | `${backendUrl}/ozon/product-data/{sku}?skipMarket=1&catIds=...` | GET | — | 商品数据查询时**带买家类目 id**（佣金按类目精确分档） | `getProductStats` action 且带 catIds |

### 4.2 调用方分布

| 调用方文件 | 调用的类目 action |
|---|---|
| `content/1688-ai-wizard.js:544` | `getCategoryTree`（language: ZH_HANS） |
| `content/1688-ai-wizard.js:649` | `getCategoryAttributes`（typeId + storeId） |
| `content/1688-ai-wizard.js`（间接） | `suggestCategory` / `verifyCategory` |
| `content/ozon-bestsellers-hook.js` | 被动监听 Ozon bestsellers 页自身的 fetch 学习类目映射 → `reportCategoryMapping` |
| `content/ozon-product.js:3125` | `getProductStats`（带 catIds）— **不是类目查询，是商品查询附带类目 id** |

### 4.3 关键发现：跟卖链路没有查询类别的请求

**经过全文件交叉检索，跟卖链路相关文件（content / lib 全部跟卖相关文件）中从未主动调用任何"查询类别"的请求**：

| 跟卖链路文件 | 是否调用类目查询 action |
|---|---|
| content/ozon-product.js（PDP 主入口） | **否** — 只调 `getProductStats` 时附带 catIds |
| content/shared-utils.js | 否 |
| content/ozon-search.js | 否 |
| content/ozon-data-panel.js | 否 |
| content/ozon-seller-bridge.js | 否（仅 fetch 中继） |
| lib/sku-collect.js | 否 |
| lib/v3-payload.js | 否 |
| lib/follow-sell-content-copy.js | 否 |
| lib/ozon-video-extract.js | 否 |
| lib/cn-source-scraper.js | 否（且 PLATFORM_CONFIGS 不含 Ozon） |

### 4.4 跟卖链路如何获得类目信息

跟卖链路**不主动查询类目**，而是从 seller portal `/api/v1/search` 响应中直接读取源商品的类目信息：

| 字段 | 来源 | 用途 |
|---|---|---|
| `sv.description_category_id` | `/api/v1/search` 响应 `variants[].description_type_dict_value`，经 `normalizeSearchVariantToSv` 归一 | 提交时透传 `_sourceVariant.description_category_id`，后端据此识别叶子类目 |
| `sv.categories[]` | `/api/v1/search` 响应 | `{id, level, name, title}` → `jzExtractCatalogFromSv` 拼 "L1 / 最深" 路径 |
| `sv.attributes[8229]` | `/api/v1/search` 响应 `description_type_name` | Тип 类型名，多变体跟卖时锚点变体的 8229 强制覆盖所有变体 |
| 买家页 `catIds` | PDP DOM `a[href*="/category/"]` 中 `/category/.*-(\d+)/` | `getProductStats` 请求时附带，用于后端按类目精确分档佣金 |

### 4.5 为什么跟卖链路不需要查询类别

跟卖的本质是"复制源商品到自己店铺"，类目信息天然继承自源商品：

1. **源类目已知**：seller portal `/api/v1/search` 返回的 `variants[].description_category_id` 直接是源商品的叶子类目 id，跟卖时透传即可，无需重新查询。
2. **类目树查询是"反向映射"场景**：1688 AI 上架向导需要 `getCategoryTree` 是因为 1688 商品没有 Ozon 类目 id，需要 AI 推荐 + fuzzyMatch 把中文类目名映射到 Ozon 叶子类目。跟卖场景下源商品已在 Ozon 类目体系内。
3. **后端负责类目属性 schema 解析**：跟卖提交时只透传 `description_category_id + type_id`，后端 worker 在执行 Ozon `/v3/product/import` 时按 id 反查所需属性 schema，前端不参与。
4. **门户 viaPortal 模式特殊**：`update-bundle-items` 请求体里有一个 `description_category_lvl3_name` 字段（SW:552），是从源 `sv.categories` 提取的**类目名**（不是 id），用于门户 bundle 接口的"按名匹配"机制——这也不是查询请求，是字段透传。

### 4.6 潜在风险点

| 风险 | 说明 |
|---|---|
| 源类目字段缺失 | 如果 `/api/v1/search` 响应中 `description_type_dict_value` 为空（部分类目未配置），跟卖提交时会落到后端默认类目，可能匹配不准 |
| 跨店类目差异 | 不同 Ozon 店铺可能开通不同类目权限。跟卖时透传源类目 id，但目标店可能无该类目权限，导致 Ozon 拒收。前端无校验 |
| 类目树版本漂移 | Ozon 类目树会定期更新，`getCategoryTree` 仅 1688 向导用且无强缓存。跟卖走源类目 id 路径，若 Ozon 下线了某类目 id，会失败 |
| 缺少校验环节 | 跟卖链路没有 `verifyCategory` 复核步骤（1688 向导有），源类目直接落到提交 payload |

---

## 五、鉴权 / 店铺 / 会员 / 计费相关请求

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:3958 | `${backendUrl}/auth/captcha` | GET | — | 拉图形验证码 | `getCaptcha` action（登录前） |
| SW:3961 | `${backendUrl}/auth/send-code` | POST | `phoneNumber, captchaId, captchaCode` | 发送短信验证码 | `sendSmsCode` action |
| SW:3996 | `${backendUrl}/auth/sms/verify` | POST | `phoneNumber, code, deviceFingerprint, platform:"extension", portalHost` | 短信验证码登录 | `loginSms` action |
| SW:4000 | `${backendUrl}/auth/login-password` | POST | `phoneNumber, password, captchaId, captchaCode, deviceFingerprint, platform, portalHost` | 账号密码登录（带图形验证码） | `loginPassword` action |
| SW:4004 | `${backendUrl}/auth/login-password` | POST | `phone, password, deviceFingerprint, platform, portalHost` | 账号密码登录（旧 `login` action 兼容） | `login` action |
| SW:2104 | `${backendUrl}/auth/device/heartbeat` | PUT | `deviceFingerprint, platform:"extension"` | 设备心跳（保活/活跃统计） | `HEARTBEAT_ALARM` 定时（`sendHeartbeat`） |
| SW:3955 | `${backendUrl}/auth/ozon-stores` | GET | — | 拉当前账号绑定的 Ozon 店铺列表 | `getStores` action |
| SW:3909 | `${backendUrl}/auth/ozon-stores/{storeId}` | PATCH | `cookieAuth:{cookies, sc_company_id, userAgent}` | 把 seller.ozon.ru cookie 同步到后端 | `syncSellerCookies` action |
| SW:3248 | `${backendUrl}/ozon/warehouses` | GET | — | 拉店铺仓库列表（backend 已做 shape 归一化 + cache fallback） | `getWarehouses` action |
| SW:3109 | `${backendUrl}/membership/usage-summary` | GET | — | 会员用量摘要 | `getMembershipSummary` action |
| SW:3121 | `${backendUrl}/membership/me` | GET | — | 当前会员信息（tier/planName/daysLeft） | `getAiQuota` action |
| SW:3122 | `${backendUrl}/jidian/balance` | GET | — | 极点余额 | `getAiQuota` action |
| SW:3124 | `${backendUrl}/jidian/pricing` | GET | — | 极点单价（AI_IMAGE 单价） | `getAiQuota` action |
| SW:3265 | `${backendUrl}/ozon/ai/optimize-for-rating` | POST | `message.body`(modules + currentAttrs) | AI 满分体检/必填属性填充 | `aiOptimizeForRating` action（1688 向导） |
| SW:3934 | `${backendUrl}/ozon/extension/translate` | POST | `texts, from:"ru", to:"zh"` | 关键词翻译 | `translateKeywords` action |
| SW:3328 | `${backendUrl}/feature-flags/me` | GET | — | 拉当前用户灰度开关 map（决定 viaPortal 等新功能是否显示） | `getFeatureFlags` action |
| SW:2557 | `${backendUrl}/usage/track` | POST | `featureKey, client, version` | 功能埋点（当天每组合去重一次） | `usageTrack` action |
| SW:2381 | `${backendUrl}/extension/l1-samples` | POST | `samples[], sentAt` | L1 采样数据上报 | L1 采样内部消息 |
| SW:2012 | `${backendUrl}/ozon/sync/client-intervals` | GET | — | 拉各类型同步频率（24h cache） | `setupClientSyncAlarms`（SW 启动/onInstalled） |

---

## 六、插件自更新 / 汇率 / 探活 / 后端 OPI 同步

| 行号 | endpoint | method | 关键 body | 作用 | 触发场景 |
|---|---|---|---|---|---|
| SW:322 | `${url}/health` | GET | — | dev 双候选 backend 探活（生产单候选跳过） | `detectBackendUrl`（SW 启动 / `refreshBackend` action） |
| SW:1759 | `${backendUrl}/extension/latest?client=extension&brand=<brand>` | GET | — | 拉插件最新版本元数据(version/downloadUrl/sha256) | `UPDATE_CHECK_ALARM` 定时（`checkForUpdate`） |
| SW:1718 | `<downloadUrl>`（zip） | GET | — | 重新下载 zip 校验 SHA-256 | `verifyExtensionHash`（checkForUpdate 内） |
| SW:1939 | `https://open.er-api.com/v6/latest/CNY` | GET | — | 拉 CNY→RUB 实时汇率（极掌算价 + 1688 向导定价） | `FX_ALARM` 定时 / `getFxRate` action |

OPI 同步引擎的 HTTP 请求在 `background/sync/backend-client.js` 和 `opi-client.js` 中实现，由 `JzSyncEngine.runOneType` 与 `JzBrowserAgentRuntime` 触发，不在 service-worker.js 主体内。

---

## 七、统计汇总

### 7.1 按请求域名分类

| 域名 | 端点数 | 主要用途 |
|---|---|---|
| `seller.ozon.ru` | 9 | seller portal API（搜索 / bundle / 视频上传 / Bestsellers / 任务查询） |
| `www.ozon.ru` / `*.ozon.ru` | 3 | 买家页 page json（富内容 / 视频 / 公开跟卖列表 / 多变体 modal） |
| `ir.ozone.ru` (CDN) | 1 | 图片 / 视频二进制下载 |
| `${backendUrl}` (jizhangerp) | 30+ | 业务后端（采集 / 上架 / 类目 / 鉴权 / 会员 / 埋点 / 模板） |
| `open.er-api.com` | 1 | 汇率 |
| `api.jizhangerp.com` | 1 | 插件更新 |

### 7.2 按业务模块分类

| 模块 | 端点数 | 关键 action |
|---|---|---|
| 跟卖链路 | 15+ | searchVariants / fetchBundleByVariantId / transferVideoToOzon / fetchVariantMediaViaBuyerTab / followSell / portalImportStatus / pushSourceCollect |
| 采集箱 / 商品数据 | 12+ | pushSourceCollect / collectBatch / getProductStats / getMarketStats / fetchBestsellers |
| 类目查询 | 7 | getCategoryTree / getCategoryAttributes / suggestCategory / verifyCategory / reportCategoryMapping |
| 鉴权 / 店铺 / 会员 | 14 | loginSms / loginPassword / syncSellerCookies / getStores / getWarehouses / getAiQuota |
| 自更新 / 汇率 / 埋点 | 5 | checkForUpdate / refreshExchangeRate / usageTrack / setupClientSyncAlarms |

### 7.3 跟卖链路请求密度

| 阶段 | 请求数 | 备注 |
|---|---|---|
| 源数据采集（每 SKU） | 2 | `/api/v1/search` + `create-bundle-by-variant-id` |
| 视频转存（每 SKU） | 2-3 | `fetch page json` + `download mp4` + `upload-file` |
| 富内容独立通道（每 SKU） | 1 | `fetch page json` |
| 公开跟卖列表（每 PDP） | 1 | modal endpoint |
| 多变体 modal 展开（每 PDP） | 1 | modal endpoint |
| 跟卖提交 | 1-6 | viaPortal=false: 1 个 import；viaPortal=true: prepare-bundle + create-bundle + update-bundle-items + upload-bundle + 多次 get-list/get-errors 轮询 |

**典型多变体跟卖（10 个变体）请求数估算**：
- 源采集：10×2 = 20
- 视频转存：1×3 = 3（listing 共享一个视频）
- 富内容：10×1 = 10
- 公开跟卖列表：1
- viaPortal 提交：1+1+1+1+5（轮询）= 9
- **合计约 43 个请求**，节流 BATCH_SIZE=3 + 400ms 间隔

---

## 八、关键文件路径汇总

- [background/service-worker.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/service-worker.js) — SW 主体，所有 action 路由 + 大部分出网点
- [background/sync/backend-client.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/sync/backend-client.js) — OPI 同步后端客户端
- [background/sync/opi-client.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/sync/opi-client.js) — Ozon Seller API 客户端
- [content/ozon-seller-bridge.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-seller-bridge.js) — seller portal fetch 中继
- [content/ozon-product.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-product.js) — PDP 主入口，含 `fetchVariantGallery` L8811 / `jzFetchAspectsModalVariants` L745 / Phase A SSR L1357,L9607 / 图搜 L1984 / 模板 L7456,L7560
- [content/shared-utils.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/shared-utils.js) — `jzFetchPublicFollowSell` L2049 / `jzDebugFollowSell` L2563 / `ensurePdpState` L231
- [content/1688-ai-wizard.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/1688-ai-wizard.js) — **唯一调用 `getCategoryTree` L544 + `getCategoryAttributes` L649 的文件**
- [content/ozon-bestsellers-hook.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-bestsellers-hook.js) — 被动学习类目映射 → `reportCategoryMapping`
