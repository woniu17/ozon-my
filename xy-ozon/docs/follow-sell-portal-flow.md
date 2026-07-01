# 模拟手动上架（viaPortal=true）完整流程文档

> 本文档描述从原项目抽离的「模拟手动上架」流程，并说明 Demo 中各步骤的 ERP 依赖与 mock 实现策略。
>
> 图例：🔴 依赖 ERP（Demo 用 `mock-erp.js` 替代）｜🟢 直连 seller.ozon.ru（Demo 用 `mock-seller-portal.js` 替代）｜🟡 视情况

---

## 一、流程总览

```
用户在 www.ozon.ru/product/* 点击右上角 ⚡ 按钮
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 0：打开跟卖面板（前置 UI）                            │
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
│  Phase 5：组装 items[]（描述/标签/图片/物理参数）            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 6：提交（viaPortal=true → importViaPortal）           │
│   ├ 6a. ERP prepare-bundle-items（备料+加工）   🔴          │
│   ├ 6b. seller portal create-bundle             🟢          │
│   ├ 6c. seller portal update-bundle-items       🟢          │
│   └ 6d. seller portal upload-bundle             🟢          │
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

### Phase 0：打开跟卖面板

| 步骤                         | 实现                                          | 依赖        |
| ---------------------------- | --------------------------------------------- | ----------- |
| 注入触发按钮 ⚡              | `content.js` `injectTrigger()`                | 🟢 本地     |
| 抓取页面商品数据（预填面板） | `product-extractor.js` `extractProductData()` | 🟢 本地 DOM |
| 渲染面板 UI                  | `follow-sell-panel.js` `createPanel()`        | 🟢 本地     |

**文件**：

- [src/content/content.js](../src/content/content.js)
- [src/content/product-extractor.js](../src/content/product-extractor.js)
- [src/content/follow-sell-panel.js](../src/content/follow-sell-panel.js)

**判定**：不依赖 ERP，全部本地。

---

### Phase 1：配置 + 提交前校验

用户配置上架方式/价格/库存/图片顺序后点「一键上架至OZON」。

| 步骤                                                                        | 消息                   | 实现                                   | 依赖   |
| --------------------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------ |
| 读取 `ozon_portal_import` 灰度 flag（5min 缓存，失败默认关 → 回退官方 API） | `getFeatureFlags`      | `mock-erp.js` `getFeatureFlags()`      | 🔴 ERP |
| 会员配额校验（防超限白跑）                                                  | `getMembershipSummary` | `mock-erp.js` `getMembershipSummary()` | 🔴 ERP |
| 仓库列表                                                                    | `getWarehouses`        | `mock-erp.js` `getWarehouses()`        | 🔴 ERP |
| 店铺列表                                                                    | `getStores`            | `mock-erp.js` `getStores()`            | 🔴 ERP |
| AI 配额（如启用 AI）                                                        | `getAiQuota`           | `mock-erp.js` `getAiQuota()`           | 🔴 ERP |

**判定**：本阶段强依赖 ERP——灰度开关、配额、仓库、店铺全部来自 ERP。

**Mock 实现**（[mock-erp.js](../src/background/mock-erp.js)）：

- `getFeatureFlags()` 返回 `{ ozon_portal_import: true }`（可通过 `MOCK_ERP_CONFIG.portalFlagOn = false` 测试回退）
- `getMembershipSummary()` 返回 `{ caps: { listing: 100 }, usage: { listing: 12 } }`
- 所有接口带延时（120-180ms）+ token/storeId 校验 + 可配 `failureRate`

---

### Phase 2：页面数据抓取

| 步骤                  | 函数                   | 依赖    |
| --------------------- | ---------------------- | ------- |
| SKU（从 URL 提取）    | `extractSkuFromUrl()`  | 🟢 本地 |
| 标题（og:title / h1） | `extractTitle()`       | 🟢 本地 |
| 价格（多选择器候选）  | `extractPrice()`       | 🟢 本地 |
| 主图（og:image）      | `extractCoverImage()`  | 🟢 本地 |
| 品牌/面包屑           | `extractBreadcrumbs()` | 🟢 本地 |
| 视频（页面 mp4）      | `extractVideoUrl()`    | 🟢 本地 |
| 主题标签              | `extractKeywords()`    | 🟢 本地 |

**文件**：[src/content/product-extractor.js](../src/content/product-extractor.js)

**判定**：不依赖 ERP，全部本地 DOM。

---

### Phase 3：变体预取（seller portal 数据采集）

| 步骤                                 | 消息                     | 实现                                               | 依赖      |
| ------------------------------------ | ------------------------ | -------------------------------------------------- | --------- |
| Gate check：预取变体                 | `searchVariants`         | `mock-seller-portal.js` `searchVariants()`         | 🟢 seller |
| 拉 bundle 物理属性（4497/9454-9456） | `fetchBundleByVariantId` | `mock-seller-portal.js` `fetchBundleByVariantId()` | 🟢 seller |
| 全局 200ms 节流闸门                  | `_sellerPortalGate`      | `mock-seller-portal.js`                            | 🟢 本地   |
| 403 细分（ANTIBOT/AUTH_REQUIRED）    | `_maybeThrowError`       | `mock-seller-portal.js`                            | 🟢 本地   |

**判定**：主体不依赖 ERP，直连 seller.ozon.ru。

**Mock 实现**（[mock-seller-portal.js](../src/background/mock-seller-portal.js)）：

- `searchVariants(sku)` 返回归一化 sourceVariant（含 4180/4194/4195/8229/85/7822/4191 等 attr）
- `fetchBundleByVariantId()` 返回物理属性（4497/9454/9455/9456）
- 保留 200ms 全局节流闸门（`_sellerPortalGate`）
- 可配 `antibotRate` / `authFailRate` / `networkFailRate` 模拟 403 反爬细分

---

### Phase 4：视频转存（mp4 → 卖家自有 Ozon 视频）

| 步骤                         | 消息                    | 实现                                    | 依赖      |
| ---------------------------- | ----------------------- | --------------------------------------- | --------- |
| 抓页面 mp4                   | `product-extractor.js`  | 🟢 本地                                 |
| 转存请求                     | `uploadFollowSellVideo` | `mock-seller-portal.js` `uploadVideo()` | 🟢 seller |
| 返回 ir.ozone.ru/s3 自有 URL | —                       | 🟢                                      |

**判定**：不依赖 ERP，全程 seller.ozon.ru 域。

**Mock 实现**：`uploadVideo(srcUrl)` 返回 `{ ok: true, url: 'https://ir.ozone.ru/s3/mock-video/xxx.mp4' }`

---

### Phase 5：组装 items[]

| 步骤                                  | 函数                                                                         | 依赖                |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| 描述抽取                              | `contentCopy.pickFollowSellDescription()`                                    | 🟢 本地（纯函数库） |
| 标签清洗 + 注入                       | `contentCopy.normalizeSourceHashtags()` + `mergeSourceHashtagsIntoVariant()` | 🟢 本地             |
| 图片顺序（keep/shuffle）              | 本地                                                                         | 🟢 本地             |
| 物理参数（weight/depth/width/height） | 本地                                                                         | 🟢 本地             |
| items.push({...})                     | 本地组装                                                                     | 🟢 本地             |

**文件**：[src/lib/content-copy.js](../src/lib/content-copy.js)

**判定**：不依赖 ERP，纯本地数据组装（content-copy.js 是纯函数库）。

---

### Phase 6：提交（viaPortal=true 核心阶段）

**入口**：`follow-sell-panel.js` `handleSubmit()` → SW `case 'followSell'`（viaPortal=true）→ `importViaPortal()`

#### 6a. ERP prepare-bundle-items（🔴 必经 ERP）

```
importViaPortal() 调用 MockERP.prepareBundleItems(message, token, targetStoreId)
  → 返回 { bundles[], store_company_id, strictSkipped, invalidImage }
```

**ERP 在这一步做的事**（Mock 模拟）：

- 复用全加工流水线（AI 重写/水印/防搬运）—— Demo 简化为透传
- 类目对齐 + bundle 分组（Demo 一对一）
- 严格模式跳过（strictSkipped）
- 无效图片剔除（invalidImage）
- 返回目标店铺 `store_company_id`（用于公司一致性护栏）

**Mock 实现**（[mock-erp.js](../src/background/mock-erp.js) `prepareBundleItems()`）：

- 延时 800ms 模拟加工
- 返回 bundles（一对一映射）+ `store_company_id`
- 可配 `antibotRate` 模拟 403 反爬挑战

#### 公司一致性护栏

```js
const companyId = await MockSellerPortal.resolveSellerCompanyId(); // sc_company_id
if (storeCompanyId !== String(companyId)) {
  throw new Error('所选店铺与当前 seller.ozon.ru 登录店铺不一致...');
}
```

**测试方法**：设置 `MOCK_ERP_CONFIG.mockStoreCompanyId = '9999'`（与 `MOCK_SELLER_CONFIG.companyId='3891653'` 不一致）即可触发拦截。

#### 6b-6d. seller portal bundle 三步（🟢 不依赖 ERP）

| 步骤            | 函数                                      | seller.ozon.ru 接口                     | 返回             |
| --------------- | ----------------------------------------- | --------------------------------------- | ---------------- |
| 6b 建空草稿     | `createBundle(companyId)`                 | `/seller-prototype/create-bundle`       | `bundle_id`      |
| 6c 写入商品数据 | `updateBundleItems(bundleId, items, ...)` | `/seller-prototype/update-bundle-items` | `{}`             |
| 6d 提交发布     | `uploadBundle(bundleId, companyId)`       | `/seller-prototype/upload-bundle`       | `upload_task_id` |

**这三步全部走 `fetchSellerPortal`**（Demo 用 `MockSellerPortal`）：

- 受全局 200ms 闸门节流
- 复用用户真实 cookie/UA/fingerprint（Demo 模拟）
- **绕开了 Ozon 官方 `/v3/product/import` 限流** —— 这是「模拟手动上架」的核心价值

**判定**：6a 强依赖 ERP，6b-6d 不依赖 ERP。

---

### Phase 7：门户上架结果轮询

**入口**：`follow-sell-panel.js` 轮询 `portalImportStatus`，16s 内查询结果。

| 步骤                           | 消息                 | 实现                                            | 依赖      |
| ------------------------------ | -------------------- | ----------------------------------------------- | --------- |
| 拉任务列表                     | `portalImportStatus` | `mock-seller-portal.js` `getUploadTaskList()`   | 🟢 seller |
| 拉失败明细（failed>0 时）      | —                    | `mock-seller-portal.js` `getUploadTaskErrors()` | 🟢 seller |
| 判定 done（processed >= size） | 本地                 | 🟢 本地                                         |
| 回显「成功 N / 失败 N」        | 本地                 | 🟢 本地                                         |

**判定**：不依赖 ERP，直查 seller.ozon.ru 的 async-upload 任务系统。

**Mock 实现**：任务进度异步递增（每 `taskProcessMs` 默认 600ms 处理一个），直到 `processed >= size` 标记 `done`。

---

## 三、ERP 依赖汇总

| Phase | 阶段         | ERP 依赖                     | Mock 文件                               |
| ----- | ------------ | ---------------------------- | --------------------------------------- |
| 0     | 打开面板     | ❌ 无                        | —                                       |
| 1     | 配置+校验    | 🔴 **强依赖**                | `mock-erp.js`                           |
| 2     | 页面数据抓取 | ❌ 无                        | —                                       |
| 3     | 变体预取     | ❌ 无（Demo 不实现代采兜底） | `mock-seller-portal.js`                 |
| 4     | 视频转存     | ❌ 无                        | `mock-seller-portal.js`                 |
| 5     | items 组装   | ❌ 无                        | —                                       |
| 6     | 提交         | 🔴 **6a 必经**；6b-6d 不依赖 | `mock-erp.js` + `mock-seller-portal.js` |
| 7     | 结果轮询     | ❌ 无                        | `mock-seller-portal.js`                 |

### 必经 ERP 的关键调用点（共 5 个）

1. `getFeatureFlags` —— `ozon_portal_import` 灰度开关
2. `getMembershipSummary` —— 会员配额校验
3. `getWarehouses` —— 仓库列表
4. `getStores` —— 店铺列表
5. `prepareBundleItems` —— 备料+全加工+公司校验 ⭐ **核心必经**

> 所有 ERP 调用都带 `token` + `targetStoreId` 鉴权（Demo 用 `demo-token` / `store-001`）。

---

## 四、Mock 配置

### Mock ERP 配置（`mock-erp.js`）

通过 `self.MOCK_ERP_CONFIG` 覆盖默认值（在 SW 启动前设置）：

```js
self.MOCK_ERP_CONFIG = {
  portalFlagOn: true, // 灰度开关(设 false 测试回退官方 API)
  prepareDelayMs: 800, // prepare-bundle-items 延时
  failureRate: 0, // 随机失败率
  antibotRate: 0, // 403 反爬概率
  listingCap: 100, // 会员配额上限
  listingUsed: 12, // 已用配额
  mockCompanyId: '3891653', // 浏览器登录的 company_id
  mockStoreCompanyId: '3891653', // 目标店铺 company_id(改不同值触发公司护栏)
};
```

### Mock Seller Portal 配置（`mock-seller-portal.js`）

```js
self.MOCK_SELLER_CONFIG = {
  antibotRate: 0, // 403 反爬挑战概率
  authFailRate: 0, // 403 权限错概率
  networkFailRate: 0, // 网络错概率
  taskProcessMs: 600, // async-upload 任务处理间隔
  companyId: '3891653', // 当前登录 sc_company_id
};
```

### 测试场景示例

| 场景         | 配置                                        | 预期                                   |
| ------------ | ------------------------------------------- | -------------------------------------- |
| 正常上架     | 全默认                                      | 6a→6b→6c→6d→7 全成功                   |
| 灰度关闭回退 | `MOCK_ERP_CONFIG.portalFlagOn=false`        | 走官方 API 路径                        |
| 公司护栏拦截 | `MOCK_ERP_CONFIG.mockStoreCompanyId='9999'` | 6a 后抛「店铺不一致」                  |
| 反爬挑战     | `MOCK_SELLER_CONFIG.antibotRate=1`          | seller portal 调用抛 `ANTIBOT_BLOCKED` |
| 配额不足     | `MOCK_ERP_CONFIG.listingUsed=100`           | Phase 1 拦截「配额不足」               |

---

## 五、一句话总结

> **模拟手动上架（viaPortal=true）= ERP 备料加工（6a） + 浏览器三步建品（6b-6d）绕限流 + seller portal 轮询结果（7）**。
>
> 真正「绕官方限流」的只有 6b-6d 这三步 seller portal bundle 接口调用；前面的灰度 flag/配额/仓库/店铺校验（Phase 1）和 6a 备料加工**绕不掉 ERP**。ERP 不可用时，`isPortalImportEnabled()` 会因 flag 读取失败默认回退到官方 API 路径。
