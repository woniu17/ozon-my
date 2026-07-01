# 模拟手动上架（viaPortal）完美复刻方案

> 目标：将 `0.13.31.1` 主项目「模拟手动上架（viaPortal=true）」功能完整复刻到 `xy-ozon`，并同步扩展 `erp-backend-lite` 能力，使 Demo 成为可真实上架商品的功能完整版。
>
> 状态：**已完成**
> 4 阶段全部实施完成，单测通过，语法检查通过。

---

## 一、背景与目标

### 1.1 现状

经对比分析（详见上一轮对话结论），`xy-ozon` 的模拟手动上架功能复刻完整度：

| 维度 | 完整度 | 说明 |
|---|---|---|
| 流程编排骨架 | ~85% | Phase 0-7 主链路完整 |
| 数据采集层（读） | ~95% | seller portal 读操作 + 跨域快路 + 403 细分 + 200ms 闸门全真实复刻 |
| **建品执行层（写）** | **~0%** | 6b/6c/6d 全 mock，**绕官方限流的核心价值未实现** |
| 加工能力 | ~10% | AI/水印/海报/防搬运/严格模式等全降级为透传或缺失 |
| 多变体能力 | **0%** | 仅单变体，缺失 Phase A SSR 展开 + Phase 0 弹窗补全 |
| 缓存与防串 | 0% | bundle 24h cache + 跨店防串 v2 未复刻 |
| 代采/容错 | 0% | proxyCollectVariant / 多店扇出 / humanizeError 未复刻 |

此外，文档与实现严重不一致：README 称「ERP 全 mock + seller portal 全 mock」，实际是 ERP 真实 + seller portal 读真实 + 仅 seller portal 写 mock。

### 1.2 目标

1. **核心补齐**：6b/6c/6d 三步建品 + 视频转存真实化，让 Demo 真正能上架商品到 Ozon
2. **高价值功能补齐**：多变体展开、严格模式、bundle 缓存、错误人性化、标题质量、类目对齐
3. **后端补能力**：erp-backend-lite 以 feature-flag 可选模块方式补 AI/水印/海报/防搬运 + 代采端点契约
4. **mock 开关化**：保留 mock-seller-portal 作测试桩，通过开关在 mock/真实间切换
5. **文档同步**：修正 README/flow 文档与实现的不一致

---

## 二、决策记录

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 交付方式 | **分 4 阶段，每阶段验收** | 控制风险，核心价值优先交付 |
| 2 | 后端高级功能 | **feature-flag 可选模块** | 违背 lite "零依赖、5 分钟启动" 定位，做成可选模块默认关闭 |
| 3 | 代采模块 | **只补端点契约，不做真实派单** | 单机版做真实代采无意义（自派自领假代采） |
| 4 | mock 去留 | **保留作测试桩，开关化** | 便于离线测试和故障注入 |

---

## 三、阶段 1：核心补齐（让 Demo 真正能上架商品）

**目标**：6b/6c/6d 真实调用 seller.ozon.ru，视频转存真实化，mock 开关化。
**改动量**：约 500 行
**验收**：在真实 seller.ozon.ru 登录态下，Demo 跑完 7 阶段后能在 Ozon 后台看到真实创建的商品。

### 3.1 改动点清单

#### 3.1.1 `xy-ozon/src/background/seller-portal-client.js` — 新增写操作

当前文件只做「读」，新增 4 个写函数，复用现有 `fetchSellerPortal`（[行 379](file:///d:/code/ozon-my/xy-ozon/src/background/seller-portal-client.js#L379)）。

新增内容（追加到文件末尾 export 前）：

```javascript
// ── 门户建品写操作（对齐 0.13 service-worker.js:567-627）──
const _bundlePortalOpts = (preferTabId, timeoutMs = 30000) => ({
  urlPrefix: '/api/site',
  pageType: 'products',
  timeoutMs,
  allowOzonTab: true,
  preferTabId,
});

// 6b. 建空草稿 → bundle_id
async function createBundle(companyId, preferTabId) {
  const resp = await fetchSellerPortal(
    '/seller-prototype/create-bundle',
    { company_id: String(companyId) },
    _bundlePortalOpts(preferTabId)
  );
  const bundleId = resp?.bundle_id;
  if (!bundleId) throw new Error('create-bundle 未返回 bundle_id');
  return String(bundleId);
}

// 6c. 写入商品数据
async function updateBundleItems(bundleId, companyId, items, source, catName, preferTabId) {
  return fetchSellerPortal(
    '/seller-prototype/update-bundle-items',
    {
      bundle_id: String(bundleId),
      company_id: String(companyId),
      source: source || 'SOURCE_MERGED',
      description_category_lvl3_name: catName || '',
      items,
    },
    _bundlePortalOpts(preferTabId)
  );
}

// 6d. 提交发布 → upload_task_id（strict:true 对齐 0.13）
async function uploadBundle(bundleId, companyId, preferTabId) {
  const resp = await fetchSellerPortal(
    '/seller-prototype/upload-bundle',
    { bundle_id: String(bundleId), company_id: String(companyId), strict: true },
    _bundlePortalOpts(preferTabId)
  );
  const taskId = resp?.upload_task_id;
  if (!taskId) throw new Error('upload-bundle 未返回 upload_task_id');
  return String(taskId);
}

// 视频转存：mp4 → ir.ozone.ru/s3（对齐 0.13 service-worker.js:863-931）
// 走独立 executeScript 路径（multipart，不经 fetchSellerPortal JSON 通道）
async function transferVideoToOzon(srcUrl) {
  if (!srcUrl) return { ok: false, error: 'srcUrl required' };
  const targetTab = await ensureSellerTab();
  const companyId = await resolveSellerCompanyId();
  if (!companyId) return { ok: false, error: 'AUTH_REQUIRED', message: 'sc_company_id cookie 未找到' };

  const doUpload = async (src, xCompanyId, timeout) => {
    // ...（完整移植 0.13 service-worker.js:872-915 的 doUpload）
  };

  const results = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: doUpload,
      args: [srcUrl, companyId, 90000],
      world: 'MAIN',
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 95000)),
  ]);
  const r = results?.[0]?.result;
  if (!r?.ok || !r.url) return { ok: false, error: r?.error || '上传未返回 url' };
  return { ok: true, url: r.url };
}
```

在 `self.SellerPortalClient = { ... }` 中导出这 5 个函数。

#### 3.1.2 `xy-ozon/src/background/import-via-portal.js` — 改路由

将 6b/6c/6d 从 MockSellerPortal 改为真实 SellerPortalClient，加 mock 开关。

改动点（[当前 import-via-portal.js:51-73](file:///d:/code/ozon-my/xy-ozon/src/background/import-via-portal.js#L51)）：

```javascript
// mock 开关：self.MOCK_SELLER_CONFIG.enabled 或 chrome.storage.local.useMockSeller
const useMock = self.MOCK_SELLER_CONFIG?.enabled === true;

// 6b/6c/6d 路由
for (const b of bundles) {
  try {
    let bundleId, taskId;
    if (useMock) {
      bundleId = await self.MockSellerPortal.createBundle(companyId);
      await self.MockSellerPortal.updateBundleItems(bundleId, companyId, b.items, b.source, b.description_category_lvl3_name);
      taskId = await self.MockSellerPortal.uploadBundle(bundleId, companyId);
    } else {
      const preferTabId = self.__lastSenderTabId || null; // 由 SW 注入
      bundleId = await self.SellerPortalClient.createBundle(companyId, preferTabId);
      await self.SellerPortalClient.updateBundleItems(bundleId, companyId, b.items, b.source, b.description_category_lvl3_name, preferTabId);
      taskId = await self.SellerPortalClient.uploadBundle(bundleId, companyId, preferTabId);
    }
    bundleIds.push(bundleId);
    taskIds.push(taskId);
  } catch (e) {
    // ...（保持现有失败聚合）
  }
}
```

**preferTabId 传递**：SW case 'followSell' 需把 `sender.tab.id` 透传给 importViaPortal。修改 [service-worker.js:132-144](file:///d:/code/ozon-my/xy-ozon/src/background/service-worker.js#L132) 调用签名，加 `preferTabId` 参数。

#### 3.1.3 `xy-ozon/src/background/service-worker.js` — 视频转存真实化

改动 [service-worker.js:126-129](file:///d:/code/ozon-my/xy-ozon/src/background/service-worker.js#L126)：

```javascript
case 'uploadFollowSellVideo': {
  const useMock = self.MOCK_SELLER_CONFIG?.enabled === true;
  try {
    const r = useMock
      ? await self.MockSellerPortal.uploadVideo(message.srcUrl)
      : await self.SellerPortalClient.transferVideoToOzon(message.srcUrl);
    if (!r.ok) return { ok: false, error: r.error, message: r.message };
    return { ok: true, data: { url: r.url } };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
```

#### 3.1.4 `xy-ozon/src/background/mock-seller-portal.js` — 配置开关

DEFAULTS 增加 `enabled: false`（[mock-seller-portal.js:22-28](file:///d:/code/ozon-my/xy-ozon/src/background/mock-seller-portal.js#L22)）：

```javascript
const DEFAULTS = {
  enabled: false, // ⬅️ 新增：默认走真实 seller portal
  antibotRate: 0,
  // ...（其余不变）
};
```

#### 3.1.5 manifest.json — 确认权限

[seller-portal-client.js](file:///d:/code/ozon-my/xy-ozon/src/background/seller-portal-client.js) 已用 `chrome.cookies` / `chrome.scripting`，确认 [manifest.json](file:///d:/code/ozon-my/xy-ozon/manifest.json#L6) permissions 含 `cookies`/`scripting`（已含 ✓）。host_permissions 含 `https://seller.ozon.ru/*`（已含 ✓）。**无需改 manifest**。

### 3.2 阶段 1 验收标准

- [ ] 默认配置下（enabled=false），6b/6c/6d 真实调用 seller.ozon.ru，能在 Ozon 后台看到创建的商品
- [ ] 视频转存真实化为 ir.ozone.ru/s3 URL
- [ ] 设置 `self.MOCK_SELLER_CONFIG = { enabled: true }` 时回退到 mock 行为
- [ ] 公司一致性护栏仍生效（store_company_id vs sc_company_id）
- [ ] 200ms 节流闸门对写操作生效（复用 fetchSellerPortal 自动节流）
- [ ] Phase 7 轮询真实任务进度（已有，回归验证）
- [ ] 单测通过（`npm test`）

---

## 四、阶段 2：高价值功能补齐

**目标**：复刻 0.13 的高价值独有功能，提升实战可用性。
**改动量**：约 1500 行
**依赖**：阶段 1 完成

### 4.1 改动点清单

#### 4.1.1 多变体展开（Phase A SSR + Phase 0 弹窗补全）

**新增文件**：`xy-ozon/src/content/variant-expander.js`

复刻 0.13 [ozon-product.js:819-846](file:///d:/code/ozon-my/0.13.31.1/content/ozon-product.js#L819)（jzExpandVariantsViaModal 38色弹窗）+ [:10200-10245](file:///d:/code/ozon-my/0.13.31.1/content/ozon-product.js#L10200)（Phase A 多轴 SSR 展开）：

- `expandVariantsViaModal(productData)` — 38 色单轴弹窗补全
- `expandVariantsViaSSR(anchorSku, variantMap)` — fetch 非当前色页 SSR HTML，DOMParser 提 `[data-state].aspects` union 进 variantMap
- `pickItemForSku(variantMap, sku)` — 评分选最「纯净」变体（对齐 0.13 [:8565-8586](file:///d:/code/ozon-my/0.13.31.1/content/ozon-product.js#L8565)）

**改动**：[follow-sell-panel.js](file:///d:/code/ozon-my/xy-ozon/src/content/follow-sell-panel.js) handleSubmit 增加变体展开阶段，manifest content_scripts 增加该文件。

#### 4.1.2 严格模式 + 无效图片剔除展示

**改动**：[follow-sell-panel.js](file:///d:/code/ozon-my/xy-ozon/src/content/follow-sell-panel.js) 结果回显部分，展示 `strictSkipped[]` 和 `invalidImage[]`（阶段 1 后端已返回，前端未展示）。

**改动**：[import-via-portal.js](file:///d:/code/ozon-my/xy-ozon/src/background/import-via-portal.js) 返回结构已含 strictSkipped/invalidImage（[行 87-88](file:///d:/code/ozon-my/xy-ozon/src/background/import-via-portal.js#L87)），前端需消费。

#### 4.1.3 bundle 24h 缓存 + 跨店防串

**改动**：[seller-portal-client.js](file:///d:/code/ozon-my/xy-ozon/src/background/seller-portal-client.js) fetchBundleByVariantId（[行 513](file:///d:/code/ozon-my/xy-ozon/src/background/seller-portal-client.js#L513)）增加 chrome.storage.local 缓存：

- cache key：`jz-sw-bundle-v2:${companyId}:${variantId}`
- TTL：24h
- forceRefresh 跳过
- SW 启动清理 v1 key（对齐 0.13 [:474-483](file:///d:/code/ozon-my/0.13.31.1/background/service-worker.js#L474)）

#### 4.1.4 错误人性化 humanizeError

**新增**：[follow-sell-panel.js](file:///d:/code/ozon-my/xy-ozon/src/content/follow-sell-panel.js) 增强 `humanizeError`（当前 [行 851](file:///d:/code/ozon-my/xy-ozon/src/content/follow-sell-panel.js#L851) 已有简版），补全 0.13 [:9205-9233](file:///d:/code/ozon-my/0.13.31.1/content/ozon-product.js#L9205) 的错误片段翻译：

- IMPORT_RATE_LIMIT → "Ozon 限流，请稍后重试"
- AUTH_EXPIRED → "登录已过期，请重新登录"
- sc_company_id 相关 → "请切换浏览器登录店铺"
- ANTIBOT_BLOCKED → "触发反爬挑战，请稍后或更换网络"

#### 4.1.5 标题质量预检

**新增文件**：`xy-ozon/src/lib/title-quality.js`

复刻 0.13 [lib/title-quality.js](file:///d:/code/ozon-my/0.13.31.1/lib/title-quality.js)，检测偏短/疑似无意义标题，非阻塞 advisory。

**改动**：[follow-sell-panel.js](file:///d:/code/ozon-my/xy-ozon/src/content/follow-sell-panel.js) Phase 5 组装后调用预检，展示 warning。

#### 4.1.6 类目一致性强制对齐

**改动**：[follow-sell-panel.js](file:///d:/code/ozon-my/xy-ozon/src/content/follow-sell-panel.js) Phase 5 增加锚点对齐逻辑（对齐 0.13 [:8731-8765](file:///d:/code/ozon-my/0.13.31.1/content/ozon-product.js#L8731)）：

- 锚点变体的 `description_category_id` + `categories` + `attributes[8229]` 强制覆盖所有变体
- `independentProducts` 模式跳过

### 4.2 阶段 2 验收标准

- [ ] 多变体商品能在面板展开全部变体并批量预取
- [ ] 严格模式跳过项和无效图片在结果中展示
- [ ] bundle 缓存命中时不再请求 seller.ozon.ru，跨店不串数据
- [ ] 常见错误码有人性化提示
- [ ] 标题偏短时有 warning（非阻断）
- [ ] 类目不一致时强制对齐
- [ ] 单测通过

---

## 五、阶段 3：后端补能力（feature-flag 可选模块）

**目标**：erp-backend-lite 以可选模块方式补 AI/水印/海报/防搬运 + 代采端点契约。
**改动量**：约 1000 行 + 新依赖（可选）
**依赖**：阶段 2 完成
**原则**：所有新能力默认关闭，开启需配置环境变量 + 安装可选依赖

### 5.1 feature-flags 扩展

[config/feature-flags.json](file:///d:/code/ozon-my/erp-backend-lite/src/config/feature-flags.json) 扩展：

```json
{
  "ozon_portal_import": true,
  "ai_rewrite": false,
  "ai_poster": false,
  "watermark": false,
  "copy_ban_solution": false,
  "proxy_collect": false
}
```

### 5.2 prepare-bundle.js 加工链路扩展

[services/prepare-bundle.js](file:///d:/code/ozon-my/erp-backend-lite/src/services/prepare-bundle.js) 当前透传，改为可插拔加工链：

```javascript
export async function prepareBundleItems(message, storeId, store) {
  const items = parseItems(message);
  const flags = getFeatureFlags();

  // 1. 类目分组（不变）
  const groups = groupByCategory(items);

  // 2. 可选加工链（按 flag 顺序执行）
  let processed = items;
  if (flags.ai_rewrite) processed = await applyAiRewrite(processed, message);
  if (flags.watermark) processed = await applyWatermark(processed, message);
  if (flags.ai_poster) processed = await applyPoster(processed, message);
  if (flags.copy_ban_solution) processed = await applyCopyBan(processed, message);

  // 3. 严格模式 + 无效图片（对齐 0.13）
  const { valid, strictSkipped, invalidImage } = filterStrictMode(processed, message);

  // 4. 分组打包
  const bundles = buildBundles(valid, groups);

  return { bundles, store_company_id: store.company_id, strictSkipped, invalidImage };
}
```

### 5.3 可选加工模块（新增 `src/services/enrichments/`）

| 文件 | flag | 依赖 | 关闭时行为 |
|---|---|---|---|
| `ai-rewrite.js` | `ai_rewrite` | `openai`（可选）+ `OPENAI_API_KEY` | 透传 |
| `watermark.js` | `watermark` | `sharp`（可选原生编译） | 透传 |
| `poster.js` | `ai_poster` | SD API（可选）+ `SD_API_URL` | 透传 |
| `copy-ban.js` | `copy_ban_solution` | 无 | 透传 |

每个模块导出 `async function apply(items, message)`，flag 关闭时 prepare-bundle 不调用。

**依赖隔离**：可选依赖不写入 `dependencies`，写入 `optionalDependencies`，并在模块顶部 try-catch import：

```javascript
// services/enrichments/watermark.js
let sharp;
try { sharp = (await import('sharp')).default; } catch { sharp = null; }

export async function apply(items, message) {
  if (!sharp) {
    logger.warn('sharp 未安装，水印降级为透传');
    return items;
  }
  // ...真实水印逻辑
}
```

### 5.4 代采端点契约（新增 `src/modules/agents.js`）

只补端点契约，不做真实派单（单机版自派自领无意义）。对齐 0.13 的 browser-agents 接口：

```javascript
// modules/agents.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import logger from '../middleware/log.js';

const router = Router();

// POST /browser-agents/collection-jobs — 派单（单机版：直接返回本机处理）
router.post('/browser-agents/collection-jobs', authMiddleware, async (req, res) => {
  logger.info({ body: req.body }, 'collection-jobs (单机版直接返回 PENDING，无跨设备派单)');
  res.json({ jobId: `local-${Date.now()}`, status: 'PENDING', message: '单机版不支持跨设备代采' });
});

// GET /browser-agents/collection-jobs/:id — 查询
router.get('/browser-agents/collection-jobs/:id', authMiddleware, (req, res) => {
  res.json({ jobId: req.params.id, status: 'NOT_FOUND', message: '单机版无代采任务' });
});

// POST /browser-agents/collection-jobs/:id/report — 上报
router.post('/browser-agents/collection-jobs/:id/report', authMiddleware, (req, res) => {
  res.json({ ok: true, message: '单机版代采上报已接收（不做处理）' });
});

export default router;
```

在 [app.js](file:///d:/code/ozon-my/erp-backend-lite/src/app.js) 挂载（仅当 `feature-flags.proxy_collect` 为 true 时）。

### 5.5 阶段 3 验收标准

- [ ] 默认配置（所有新 flag=false）下，prepare-bundle 行为与阶段 2 完全一致（透传）
- [ ] 开启 ai_rewrite + 安装 openai + 配置 OPENAI_API_KEY 后，标题/描述被重写
- [ ] 开启 watermark + 安装 sharp 后，图片被打水印
- [ ] strictSkipped / invalidImage 真实计算并回传
- [ ] 代采端点可访问，返回契约一致的结构
- [ ] 不安装可选依赖时，模块降级为透传且不报错
- [ ] `npm start` 仍能在 5 分钟内启动（默认 flag 关闭）

---

## 六、阶段 4：文档更新

**目标**：修正文档与实现的不一致，反映完整复刻后的真实状态。
**改动量**：3 个文档文件

### 6.1 `xy-ozon/README.md`

修正点：
- 删除「ERP 全 mock」描述，改为「ERP 真实（对接 erp-backend-lite）」
- 删除「seller portal 全 mock」描述，改为「seller portal 读真实 + 写可选 mock」
- 补充 mock 开关说明：`self.MOCK_SELLER_CONFIG = { enabled: true }`
- 更新「与原项目的差异」表格，反映已复刻的功能
- 补充阶段 2/3 新增能力的使用说明

### 6.2 `xy-ozon/docs/follow-sell-portal-flow.md`

修正点：
- 修正 Phase 1/6a/7 的 🔴/🟢 标注（ERP 已真实，非 mock）
- 修正 Phase 3 标注（seller portal 已真实，非 mock）
- 修正 Phase 6b-6d 标注（默认真实，mock 为可选）
- 更新「Mock 配置」章节为「mock/真实开关」
- 更新「一句话总结」反映真实化

### 6.3 `erp-backend-lite/README.md`

修正点：
- 补充阶段 3 新增的可选能力（AI/水印/海报/防搬运/代采）
- 补充 feature-flags 配置说明
- 补充可选依赖安装说明（openai/sharp 等）
- 更新「与插件对接」中的 BACKEND_URLS 说明

### 6.4 阶段 4 验收标准

- [ ] README 描述与实际代码一致
- [ ] flow 文档的 🔴/🟢 标注准确
- [ ] erp-backend-lite README 含新能力说明
- [ ] 无过时的 mock-erp.js 引用

---

## 七、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| seller.ozon.ru 改版导致写接口失效 | 阶段 1 核心功能不可用 | mock 开关保留，可降级测试；接口契约对齐 0.13 已验证版本 |
| 多变体 SSR 展开强耦合 DOM | 阶段 2 功能失效 | Ozon 改版会失效，加 try-catch 降级为单变体 |
| sharp 原生编译失败 | 阶段 3 水印不可用 | optionalDependencies + 运行时降级透传 |
| OpenAI key 泄露 | 阶段 3 安全风险 | 走环境变量，不入库不入日志 |
| 代采端点契约与 0.13 不一致 | 插件调用失败 | 严格对齐 0.13 SW 的 proxyCollectVariant 调用点 |
| 单机 SQLite 并发写入 | 阶段 3 代采上报失败 | 单用户场景无并发，加 WAL 模式即可 |

---

## 八、总体验收（4 阶段全部完成后）

### 8.1 功能完整度对照

| 维度 | 复刻前 | 复刻后目标 |
|---|---|---|
| 流程编排骨架 | ~85% | 100% |
| 数据采集层（读） | ~95% | 100% |
| 建品执行层（写） | ~0% | 100% |
| 加工能力 | ~10% | ~90%（AI/水印/海报/防搬运可选） |
| 多变体能力 | 0% | 100% |
| 缓存与防串 | 0% | 100% |
| 代采/容错 | 0% | ~70%（端点契约完整，无真实派单） |

### 8.2 端到端验收用例

1. **正常上架**：真实 seller.ozon.ru 登录 → 打开商品页 → 配置 → 一键上架 → Ozon 后台看到商品 ✓
2. **mock 回退**：`MOCK_SELLER_CONFIG.enabled=true` → 全流程 mock，无真实副作用 ✓
3. **多变体**：多变体商品页 → 弹窗补全/SSR 展开 → 批量预取 → 批量上架 ✓
4. **公司护栏**：ERP 返回 store_company_id 与 cookie 不一致 → 拦截并提示 ✓
5. **视频跟卖**：含视频商品页 → 转存为 ir.ozone.ru/s3 → 上架含视频 ✓
6. **严格模式**：strictSkipped 非空 → 结果展示跳过项 ✓
7. **缓存命中**：同变体二次预取 → 不请求 seller.ozon.ru ✓
8. **AI 重写**（阶段 3）：开启 flag → 标题/描述被重写 ✓
9. **降级**：不装可选依赖 → 透传，不报错 ✓

---

## 九、实施顺序与里程碑

| 阶段 | 内容 | 验收后状态 |
|---|---|---|
| **阶段 1** | 核心补齐 | Demo 能真实上架商品 |
| **阶段 2** | 高价值功能 | 实战可用 |
| **阶段 3** | 后端补能力 | 功能完整 |
| **阶段 4** | 文档更新 | 文档与实现一致 |

每阶段完成后通知验收，验收通过再进入下一阶段。

---

## 十、附录：0.13 关键实现位置索引

| 功能 | 0.13 文件:行号 |
|---|---|
| importViaPortal 编排 | `0.13.31.1/background/service-worker.js:644-698` |
| createBundle/updateBundleItems/uploadBundle | `0.13.31.1/background/service-worker.js:576-611` |
| transferVideoToOzon | `0.13.31.1/background/service-worker.js:863-931` |
| 公司一致性护栏 | `0.13.31.1/background/service-worker.js:658-666` |
| 200ms 闸门 | `0.13.31.1/background/service-worker.js:1160-1182` |
| 403 细分 classifyError | `0.13.31.1/background/service-worker.js:3770-3817` |
| bundle 24h cache | `0.13.31.1/background/service-worker.js:464-516` |
| 多变体 SSR 展开 | `0.13.31.1/content/ozon-product.js:10200-10245` |
| 弹窗补全 | `0.13.31.1/content/ozon-product.js:819-846` |
| 类目一致性对齐 | `0.13.31.1/content/ozon-product.js:8731-8765` |
| humanizeError | `0.13.31.1/content/ozon-product.js:9205-9233` |
| proxyCollectVariant | `0.13.31.1/background/service-worker.js:1645-1692` |
| Phase 7 轮询 | `0.13.31.1/content/ozon-product.js:9248-9275` |
