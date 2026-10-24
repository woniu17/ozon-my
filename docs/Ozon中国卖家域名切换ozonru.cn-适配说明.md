# Ozon 中国卖家域名切换 ozonru.cn — 适配说明

> 2026-10，Ozon 官方对中国大陆卖家发布通知：提供加载更快的域名 **ozonru.cn**。
> 使用方法：把地址中的 `ozon.ru` 替换为 `ozonru.cn`，路径其余部分保持不变；切换后需重新登录账户。
> 原 `ozon.ru` 域名继续正常运行并受支持，新地址是中国用户的推荐选项。

## 一、官方域名映射

| 原域名 | 新域名 | 用途 |
|---|---|---|
| `seller.ozon.ru/app` | `seller.ozonru.cn/app` | 卖家后台（店铺管理/订单/商品） |
| `globalcalculator.ozon.ru` | `globalcalculator.ozonru.cn` | 定价计算器 |
| `api-seller.ozon.ru` | `api-seller.ozonru.cn` | 卖家开放 API |
| `docs.ozon.ru` | `docs.ozonru.cn` | 卖家文档 |
| `global-university.ozon.ru` | `global-university.ozonru.cn` | 卖家大学/培训 |
| `tracking.ozon.ru` | `tracking.ozonru.cn` | 物流跟踪 |
| `global-help.ozon.com` | `global-help.ozonru.cn` | 卖家帮助中心 |

> ⚠️ **不在切换列表**：买家市场 `www.ozon.ru`（商品/店铺浏览页）、
> `ozon.ru/context/detail/...`（商品详情短链）。这两类地址保持不变，
> 本项目大部分采集链路仍继续使用，**不受本次切换影响**。

## 二、对本项目的影响面

### 1. qxqx 采集脚本 — 受影响（卖家域）

| 脚本 | 使用域名 | 影响 | 改动点 |
|---|---|---|---|
| `deep-collect.js` | `seller.ozon.ru/app/` 登录态探测 + 页面内相对路径调用卖家 API（`/api/v1/search`、`/api/site/seller-analytics/...`、`/api/site/seller-prototype/...`） | **高** | 导航地址与 `ensureSellerPage` 域名判断需切换到 `seller.ozonru.cn`；页面内相对路径自动跟随新 origin，无需改 |
| `maintain-profile.js` | `seller.ozon.ru/app/dashboard/main` 维护卖家登录态 | 高 | 导航地址 + 注释同步 |
| `state-transfer.js` | 仅 `www.ozon.ru`（买家 origin 提取） | 无 | — |
| `shallow-collect.js` | `www.ozon.ru`（买家店铺页 + entrypoint API） | 无 | — |
| `price-watch-collect.js` | `www.ozon.ru`（买家商品页） | 无 | — |
| `backfill-store-stats.js` | `www.ozon.ru`（买家店铺页） | 无 | — |
| `test-single-store.js` | `www.ozon.ru` | 无 | — |
| `loop-collect.mjs` | 仅错误提示文案引用 `seller.ozon.ru` | 低 | 提示文案同步 |

**建议做法**：给 `deep-collect.js` / `maintain-profile.js` 增加可配置的卖家域基址
（如环境变量 `OZON_SELLER_BASE_URL`，默认 `https://seller.ozon.ru`）。
先保持默认指向旧域，等在新域完成人工登录、回归验证稳定后，再把默认值切换为
`https://seller.ozonru.cn`，降低回滚成本。

### 2. miaoshou-helper 浏览器插件 — 受影响（内容脚本匹配域）

- `manifest.json` 的 content_scripts 目前只匹配 `https://seller.ozon.ru/*`
  （`ozon-seller-nick.js` 店铺昵称徽章）。
- 用户切换到 `seller.ozonru.cn` 后，徽章脚本不再注入。
- **改动**：content_scripts `matches` 新增 `https://seller.ozonru.cn/*`。
- 注意：`sc_company_id` cookie 按站点隔离，新域名需重新登录后才会种 cookie；
  脚本逻辑本身用 `document.cookie` 读取，cookie 名预计不变，无需改 JS 逻辑。
  （详见《miaoshou-helper 适配清单》）

### 3. ERP 后端 — 基本不受影响

| 文件 | 引用 | 是否受影响 |
|---|---|---|
| `erp-backend-lite/src/services/order-image-cache.js` | 域名白名单含 `ozon.ru` | 如图片/外链来自卖家域需复核，预计不影响 |
| `erp-backend-lite/src/services/prepare-bundle.js` | 注释提及 seller.ozon.ru proto 格式 | 仅注释 |
| `erp-backend-lite/src/modules/products.js` | 注释提及插件直连 seller.ozon.ru | 仅注释 |
| `erp-backend-lite/src/app.js` | 注释提及 www.ozon.ru | 仅注释 |
| `erp-backend-lite/src/modules/cache.js` | `www.ozon.ru` 商品 URL 兜底 | 买家域，不变 |
| `erp-backend-lite/src/db/seed.js`、`order-daos.js`、`webhook/feishu-notify.js` | `ozon.ru` / `www.ozon.ru` 商品链接 | 买家域，不变 |

## 三、切换注意事项

1. **登录态不互通**：`ozon.ru` 与 `ozonru.cn` 是不同站点，cookie / localStorage 相互独立。
   切换后必须在 `.ozon-profile` 里人工登录一次新域名的卖家账户（扫码），
   深采的 `sc_company_id` 才会在新域种下。
2. **浅采不受影响**：浅度采集走 `www.ozon.ru`，浏览器 profile 中的买家 cookie 继续有效。
3. **深采回归清单**：新域登录后需跑一轮深采验证：
   - seller 登录态探测通过（不再 AUTH_REQUIRED）；
   - `search` / `bundle` / `marketStats` 三个门户接口返回正常；
   - 店铺昵称徽章插件（如已加新域匹配）在新域后台正常显示。
4. **API 域名**：当前脚本没有直连 `api-seller.ozon.ru`（卖家 API 全部走 seller 域页面内
   相对路径）。若未来新增直连后端 API 的代码，应使用 `api-seller.ozonru.cn`。

## 四、实施清单（TODO）

- [x] qxqx：`deep-collect.js` 卖家域基址可配置（`OZON_SELLER_BASE_URL`），
      导航 + `ensureSellerPage` 域名判断 + 报错文案同步（已改，默认 `https://seller.ozon.ru`）
- [x] qxqx：`maintain-profile.js` / `load-extension.js` 卖家域可配置 + `.env.example` 说明（已改）
- [x] qxqx：`loop-collect.mjs` 错误提示文案同步（已改）
- [x] erp-backend-lite：`scripts/check-upload-quota.mjs` 卖家 API 域可配置（复用 `OZON_OPI_BASE_URL`，默认已切 `api-seller.ozonru.cn`，已改）
- [x] erp-backend-lite：`order-image-cache.js` 图片域名白名单追加 `ozonru.cn`（已改）
- [x] ozon-tasks：`DefaultAPIBaseURL` 默认切到 `https://api-seller.ozonru.cn` + 测试 fixture 同步（已改，需在 Go 环境跑 `go test ./...`）
- [x] android-erp：`BuildConfig.OZON_SELLER_BASE_URL` 可配置（已改，默认 `https://seller.ozon.ru`）
- [x] miaoshou-helper：`manifest.json` content_scripts 新增 `https://seller.ozonru.cn/*`（v1.5.1，已改）
- [ ] miaoshou-helper：人工登录新域后实测 `sc_company_id` cookie 名与徽章选择器是否兼容
- [ ] 运维：在 `.ozon-profile` 人工登录 `seller.ozonru.cn` 一次，随后回归深采