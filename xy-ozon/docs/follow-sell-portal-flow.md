# 模拟手动上架（viaPortal=true）完整流程文档

> 本文档描述「模拟手动上架」的完整 7 阶段流程，并说明各步骤的真实/mock 实现策略。
>
> 图例：🔴 依赖 ERP（真实 `erp-backend-lite`）｜🟢 直连 seller.ozon.ru（真实）｜🟡 本地｜⚪ mock（默认关闭）

---

## 一、流程总览

```
用户在 www.ozon.ru/product/* 点击右上角 ⚡ 按钮
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 0：打开跟卖面板 + 多变体展开（弹窗补全 + SSR 多轴）    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 1：配置 + 校验（灰度 flag / 配额 / 仓库 / 店铺）      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 2：页面数据抓取（SKU/标题/价格/图片/品牌/视频）       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 3：变体预取（seller portal /search + bundle-by-id）   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 4：视频转存（mp4 → 卖家自有 Ozon 视频）               │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 5：组装 items[]（描述/标签/图片/物理参数/类目对齐）   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 6：提交（viaPortal=true → importViaPortal）           │
│   ├ 6a. ERP prepare-bundle-items（备料+加工+公司校验）  🔴  │
│   ├ 6b. seller portal create-bundle                🟢/⚪    │
│   ├ 6c. seller portal update-bundle-items          🟢/⚪    │
│   └ 6d. seller portal upload-bundle                🟢/⚪    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 7：门户上架结果轮询（直查 seller portal async-upload） │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
                   显示结果，解锁 UI
```

---

## 二、分阶段详解

### Phase 0：打开跟卖面板 + 多变体展开

| 步骤                         | 实现                                             | 依赖                   |
| ---------------------------- | ------------------------------------------------ | ---------------------- |
| 注入触发按钮 ⚡              | `content.js` `boot()`                            | 🟡 本地                |
| 抓取页面商品数据（预填面板） | `product-extractor.js` `extractProductData()`    | 🟡 本地 DOM            |
| **多变体展开（弹窗补全）**   | `variant-expander.js` `expandVariantsViaModal()` | 🟢 seller（弹窗链接）  |
| **多变体展开（SSR 多轴）**   | `variant-expander.js` `expandVariantsViaSSR()`   | 🟢 seller（色页 HTML） |
| 渲染面板 UI                  | `follow-sell-panel.js` `createPanel()`           | 🟡 本地                |

**文件**：

- [src/content/content.js](../src/content/content.js)
- [src/content/product-extractor.js](../src/content/product-extractor.js)
- [src/content/variant-expander.js](../src/content/variant-expander.js)
- [src/content/follow-sell-panel.js](../src/content/follow-sell-panel.js)

**判定**：面板打开本地；变体展开真实访问 seller.ozon.ru 弹窗链接和色页 SSR HTML（单轴/单变体秒开）。

---

### Phase 1：配置 + 提交前校验

| 步骤                                                                        | 消息                   | 实现                                                        | 依赖   |
| --------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- | ------ |
| 读取 `ozon_portal_import` 灰度 flag（5min 缓存，失败默认关 → 回退官方 API） | `getFeatureFlags`      | `erp-client.js` → `GET /feature-flags/me`                   | 🔴 ERP |
| 会员配额校验（防超限白跑）                                                  | `getMembershipSummary` | `erp-client.js` → `GET /membership/usage-summary`           | 🔴 ERP |
| 仓库列表                                                                    | `getWarehouses`        | `erp-client.js` → `GET /ozon/warehouses`                    | 🔴 ERP |
| 店铺列表                                                                    | `getStores`            | `erp-client.js` → `GET /auth/ozon-stores`                   | 🔴 ERP |
| AI 配额（如启用 AI）                                                        | `getAiQuota`           | `erp-client.js` → `GET /jidian/balance` + `/jidian/pricing` | 🔴 ERP |

**判定**：本阶段强依赖 ERP——灰度开关、配额、仓库、店铺全部来自真实 ERP。

---

### Phase 2：页面数据抓取

| 步骤                  | 函数                   | 依赖    |
| --------------------- | ---------------------- | ------- |
| SKU（从 URL 提取）    | `extractSkuFromUrl()`  | 🟡 本地 |
| 标题（og:title / h1） | `extractTitle()`       | 🟡 本地 |
| 价格（多选择器候选）  | `extractPrice()`       | 🟡 本地 |
| 主图（og:image）      | `extractCoverImage()`  | 🟡 本地 |
| 品牌/面包屑           | `extractBreadcrumbs()` | 🟡 本地 |
| 视频（页面 mp4）      | `extractVideoUrl()`    | 🟡 本地 |
| 主题标签              | `extractKeywords()`    | 🟡 本地 |

**文件**：[src/content/product-extractor.js](../src/content/product-extractor.js)

**判定**：不依赖 ERP，全部本地 DOM。

---

### Phase 3：变体预取（seller portal 数据采集）

| 步骤                                 | 消息                     | 实现                                                 | 依赖      |
| ------------------------------------ | ------------------------ | ---------------------------------------------------- | --------- |
| Gate check：预取变体                 | `searchVariants`         | `seller-portal-client.js` `searchVariants()`         | 🟢 seller |
| 拉 bundle 物理属性（4497/9454-9456） | `fetchBundleByVariantId` | `seller-portal-client.js` `fetchBundleByVariantId()` | 🟢 seller |
| **bundle 24h 缓存 + 跨店防串**       | —                        | `seller-portal-client.js`（`jz-sw-bundle-v2:*`）     | 🟡 本地   |
| 全局 200ms 节流闸门                  | `_sellerPortalGate`      | `seller-portal-client.js`                            | 🟡 本地   |
| 403 细分（ANTIBOT/AUTH_REQUIRED）    | `classifyError`          | `seller-portal-client.js`                            | 🟡 本地   |
| 登录态刷新                           | `syncSellerCookies`      | `seller-portal-client.js`                            | 🟢 seller |
| 全平台降级搜索（陌生 SKU）           | `searchProductBySku`     | `seller-portal-client.js`                            | 🟢 seller |

**判定**：主体不依赖 ERP，真实直连 seller.ozon.ru。

---

### Phase 4：视频转存（mp4 → 卖家自有 Ozon 视频）

| 步骤                         | 消息                    | 实现                                              | 依赖      |
| ---------------------------- | ----------------------- | ------------------------------------------------- | --------- |
| 抓页面 mp4                   | `product-extractor.js`  | 🟡 本地                                           |
| 转存请求                     | `uploadFollowSellVideo` | `seller-portal-client.js` `transferVideoToOzon()` | 🟢 seller |
| 返回 ir.ozone.ru/s3 自有 URL | —                       | 🟢                                                |

**判定**：不依赖 ERP，全程 seller.ozon.ru 域。默认真实 `media-storage/upload-file`。

**Mock 模式**：`MOCK_SELLER_CONFIG.enabled=true` 时走 `mock-seller-portal.js` `uploadVideo()`，返回模拟 URL。

---

### Phase 5：组装 items[]

| 步骤                                  | 函数                                                                         | 依赖                |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| 描述抽取                              | `contentCopy.pickFollowSellDescription()`                                    | 🟡 本地（纯函数库） |
| 标签清洗 + 注入                       | `contentCopy.normalizeSourceHashtags()` + `mergeSourceHashtagsIntoVariant()` | 🟡 本地             |
| 图片顺序（keep/shuffle）              | 本地                                                                         | 🟡 本地             |
| 物理参数（weight/depth/width/height） | 本地                                                                         | 🟡 本地             |
| **类目一致性强制对齐**                | `follow-sell-panel.js` Phase 5.9（锚点 desc_cat_id + categories + 8229）     | 🟡 本地             |
| **标题质量预检**                      | `title-quality.js` `checkTitleQuality()`（非阻塞 advisory）                  | 🟡 本地             |
| items.push({...})                     | 本地组装                                                                     | 🟡 本地             |

**文件**：

- [src/lib/content-copy.js](../src/lib/content-copy.js)
- [src/lib/title-quality.js](../src/lib/title-quality.js)

**判定**：不依赖 ERP，纯本地数据组装。

---

### Phase 6：提交（viaPortal=true 核心阶段）

**入口**：`follow-sell-panel.js` `handleSubmit()` → SW `case 'followSell'`（viaPortal=true）→ `importViaPortal()`

#### 6a. ERP prepare-bundle-items（🔴 必经 ERP）

```
importViaPortal() 调用 ErpClient.prepareBundleItems(message, token, targetStoreId)
  → POST /ozon/products/prepare-bundle-items (timeout 120s)
  → 返回 { bundles[], store_company_id, strictSkipped, invalidImage }
```

**ERP 在这一步做的事**：

- 可选加工链（AI 重写/水印/海报/防搬运，feature-flag 门控，默认关闭透传）
- 类目对齐 + bundle 分组
- 严格模式跳过（strictSkipped）
- 无效图片剔除（invalidImage）
- 返回目标店铺 `store_company_id`（用于公司一致性护栏）

#### 公司一致性护栏

```js
const companyId = await SellerPortalClient.resolveSellerCompanyId(); // sc_company_id
if (storeCompanyId !== String(companyId)) {
  throw new Error('所选店铺与当前 seller.ozon.ru 登录店铺不一致...');
}
```

#### 6b-6d. seller portal bundle 三步（🟢 默认真实，⚪ mock 可选）

| 步骤            | 函数                                                                 | seller.ozon.ru 接口                     | Request 关键字段                                                  | 返回             |
| --------------- | -------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| 6b 建空草稿     | `createBundle(companyId, preferTabId, {catName, sourceItemId})`      | `/seller-prototype/create-bundle`       | `company_id`, `description_category_lvl3_name`, `source_item_id?` | `bundle_id`      |
| 6c 写入商品数据 | `updateBundleItems(bundleId, companyId, items, source, preferTabId)` | `/seller-prototype/update-bundle-items` | `bundle_id`, `company_id`, `items`, `source`                      | `{}`             |
| 6d 提交发布     | `uploadBundle(bundleId, companyId, preferTabId, {name})`             | `/seller-prototype/upload-bundle`       | `bundle_id`, `company_id`, `name`, `strict:true`(xy-ozon 扩展)    | `upload_task_id` |

> 📖 **接口详细字段结构** 见 [seller-prototype-bundle-api.md](./seller-prototype-bundle-api.md)
>
> ⚠️ **字段位置修正**（2026-07-02 基于 seller-ui `app.js` 静态分析）：
>
> - `description_category_lvl3_name` 从 `update-bundle-items` 移到 `create-bundle`（类目在创建草稿时固化）
> - `upload-bundle` 新增 `name` 字段（与 create 时的 catName 同源，再次确认类目）
> - `create-bundle` 新增 `source_item_id` 字段（复制流程的源商品 ID）
> - `upload-bundle` 保留 xy-ozon 扩展的 `strict: true`（启用严格模式，与官方不冲突）

**这三步全部走 `fetchSellerPortal`**（默认真实，`MOCK_SELLER_CONFIG.enabled=true` 时走 `MockSellerPortal`）：

- 受全局 200ms 闸门节流
- 复用用户真实 cookie/UA/fingerprint
- **绕开了 Ozon 官方 `/v3/product/import` 限流** —— 这是「模拟手动上架」的核心价值

**判定**：6a 强依赖 ERP，6b-6d 默认真实 seller.ozon.ru（mock 可选）。

---

### Phase 7：门户上架结果轮询

**入口**：`follow-sell-panel.js` 轮询 `portalImportStatus`，16s 内查询结果。

| 步骤                           | 消息                 | 实现                                              | 依赖      |
| ------------------------------ | -------------------- | ------------------------------------------------- | --------- |
| 拉任务列表                     | `portalImportStatus` | `seller-portal-client.js` `getUploadTaskList()`   | 🟢 seller |
| 拉失败明细（failed>0 时）      | —                    | `seller-portal-client.js` `getUploadTaskErrors()` | 🟢 seller |
| 判定 done（processed >= size） | 本地                 | 🟡 本地                                           |
| 回显「成功 N / 失败 N」        | 本地                 | 🟡 本地                                           |
| **严格模式/无效图片展示**      | 本地                 | 🟡 本地                                           |

**判定**：不依赖 ERP，真实直查 seller.ozon.ru 的 async-upload 任务系统。

---

## 三、ERP 依赖汇总

| Phase | 阶段          | ERP 依赖                     | 实现                                        |
| ----- | ------------- | ---------------------------- | ------------------------------------------- |
| 0     | 打开面板+展开 | ❌ 无(seller portal 读)      | `seller-portal-client.js`                   |
| 1     | 配置+校验     | 🔴 **强依赖**                | `erp-client.js`                             |
| 2     | 页面数据抓取  | ❌ 无                        | —                                           |
| 3     | 变体预取      | ❌ 无                        | `seller-portal-client.js`                   |
| 4     | 视频转存      | ❌ 无                        | `seller-portal-client.js`                   |
| 5     | items 组装    | ❌ 无                        | —                                           |
| 6     | 提交          | 🔴 **6a 必经**；6b-6d 不依赖 | `erp-client.js` + `seller-portal-client.js` |
| 7     | 结果轮询      | ❌ 无                        | `seller-portal-client.js`                   |

### 必经 ERP 的关键调用点（共 5 个）

1. `getFeatureFlags` —— `ozon_portal_import` 灰度开关
2. `getMembershipSummary` —— 会员配额校验
3. `getWarehouses` —— 仓库列表
4. `getStores` —— 店铺列表
5. `prepareBundleItems` —— 备料+加工+公司校验 ⭐ **核心必经**

> 所有 ERP 调用都带 `token` + `targetStoreId` 鉴权 + JWT 滑动续期。

---

## 四、Mock / 真实开关配置

### Mock Seller Portal 配置（`mock-seller-portal.js`）

默认 `enabled: false`（走真实 seller.ozon.ru）。需要离线测试时设为 true：

```js
// 切换为 mock 模式(6b/6c/6d + 视频转存走内存模拟)
self.MOCK_SELLER_CONFIG = { enabled: true };

// mock 模式下可配故障注入
self.MOCK_SELLER_CONFIG = {
  enabled: true,
  antibotRate: 0, // 403 反爬概率
  authFailRate: 0, // 权限错概率
  networkFailRate: 0, // 网络错概率
  taskProcessMs: 600, // async-upload 任务处理间隔
  companyId: '3891653', // 当前登录 sc_company_id
};
```

### 测试场景示例

| 场景         | 配置                                                | 预期                                   |
| ------------ | --------------------------------------------------- | -------------------------------------- |
| 正常上架     | 全默认                                              | 6a→6b→6c→6d→7 全成功（真实建品）       |
| mock 模式    | `MOCK_SELLER_CONFIG={enabled:true}`                 | 全流程 mock，无真实副作用              |
| 灰度关闭回退 | ERP `feature-flags.json` `ozon_portal_import=false` | 走官方 API 路径                        |
| 公司护栏拦截 | ERP `stores.json` company_id 改为不一致值           | 6a 后抛「店铺不一致」                  |
| 反爬挑战     | `MOCK_SELLER_CONFIG={enabled:true,antibotRate:1}`   | seller portal 调用抛 `ANTIBOT_BLOCKED` |
| 配额不足     | ERP `membership.json` listingUsed=listingCap        | Phase 1 拦截「配额不足」               |

---

## 五、一句话总结

> **模拟手动上架（viaPortal=true）= ERP 备料加工（6a） + 浏览器三步建品（6b-6d）绕限流 + seller portal 轮询结果（7）**。
>
> 默认全真实：6b-6d 走 `seller.ozon.ru/seller-prototype/*` 真实建品，视频走 `media-storage/upload-file` 真实转存。mock 模式仅用于离线测试。ERP 不可用时，`isPortalImportEnabled()` 会因 flag 读取失败默认回退到官方 API 路径。
