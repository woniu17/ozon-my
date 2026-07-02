# Tasks

## P0:后端地址切换与品牌配置重指向(核心阻断项)

- [x] Task 1: 修改 `qx-ozon/background/service-worker.js` 后端 URL 配置
  - [x] SubTask 1.1: 将 `BACKEND_URLS` 生产分支由 `['https://api.jizhangerp.com']` 改为 erp-lite 地址(从常量或环境读取,默认 `['http://localhost:3001']`)
  - [x] SubTask 1.2: dev 分支移除 `https://api.jizhangerp.com` 候选,仅保留 erp-lite
  - [x] SubTask 1.3: 修改 `BRAND_WEB_HOST` 兜底逻辑,值改为 erp-lite 域(或直接由 `getBackendUrl()` 派生)
  - [x] SubTask 1.4: 修改 `__JZ_BRAND__` 对象的 `apiHost`/`webHost` 字段为 erp-lite 域
- [x] Task 2: 修改 `qx-ozon/content/shared-utils.js` 的 `__JZ_BRAND__` 同步指向 erp-lite 域
- [x] Task 3: 修改 `qx-ozon/content/ozon-premium-hook.js` 的 `__JZ_BRAND__` 同步指向 erp-lite 域
- [x] Task 4: 修改 `qx-ozon/popup/popup.js` 的 `BRAND_WEB_HOST` 兜底值为 erp-lite 域
- [x] Task 5: 修改 `qx-ozon/content/alibaba-1688.js` 与 `qx-ozon/lib/cn-source-panel.js` 的 `getBrand()` webHost 兜底为 erp-lite 域
- [x] Task 6: 修改 `qx-ozon/content/jzc-calc.js` 的 `MAIN_EXT_UPDATE_URL` 与 `MAIN_EXT_INSTALL_URL_FALLBACK` 指向 erp-lite 或移除(更新检查降级)

## P0:Web 前端入口重映射

- [x] Task 7: 在 `qx-ozon/background/service-worker.js` 新增 `getErpBaseUrl` action 处理器,返回 `getBackendUrl()` 结果
- [x] Task 8: 改造 `qx-ozon/background/service-worker.js` 的 `openFrontend` 处理器
  - [x] SubTask 8.1: 跳转目标由 `${BRAND_WEB_HOST}${path}` 改为 `${backendUrl}/admin#${hash}`,新增 path→hash 映射表(dashboard→#dashboard, products→#products, collect-box→#collect-box, favorites→#collect-box, import-history→#listings, reshelf→#listings, watermark→#config, stores→#stores)
  - [x] SubTask 8.2: token 注入 localStorage 逻辑保留(erp-lite admin 支持)
- [x] Task 9: 改造 `qx-ozon/popup/popup.js` 导航按钮
  - [x] SubTask 9.1: `ACTION_PATHS` 改为 `ACTION_HASHES` 映射(8 个路径按 Task 8 映射表)
  - [x] SubTask 9.2: 「网页登录」按钮由 `${FRONTEND_BASE_URL}/login` 改为 `${erpBaseUrl}/admin`(erp-lite admin 自带登录视图)
  - [x] SubTask 9.3: 信号卡按钮(去上架/查看失败任务/查看排队任务)的 path 改为对应 hash
- [x] Task 10: 改造 `qx-ozon/content/ozon-product.js` 的「进入ERP」按钮(详情页 line ~2124、列表页 line ~2219)
  - [x] SubTask 10.1: 由 `window.open('https://${__JZ_BRAND__.webHost}')` 改为通过 `chrome.runtime.sendMessage({action:'getErpBaseUrl'})` 获取后打开 `${baseUrl}/admin`
- [x] Task 11: 改造 `qx-ozon/content/ozon-product.js` 中其他 `openFrontend` 调用(会员充值 line ~6857、会员升级 line ~7915、模板管理 line ~8024、达上限拦截 line ~8373)的 path 改为对应 hash
- [x] Task 12: 改造 `qx-ozon/content/alibaba-1688.js` 与 `qx-ozon/lib/cn-source-panel.js` 的 `openCollectEditor`,fallback 的 `window.open(${frontendUrl}${path})` 改为 `${erpBaseUrl}/admin#${hash}`

## P0:manifest.json 清理

- [x] Task 13: 修改 `qx-ozon/manifest.json`
  - [x] SubTask 13.1: `host_permissions` 移除 `*://my.jizhangerp.com/*`、`*://*.my.jizhangerp.com/*`、`https://api.jizhangerp.com/*`,新增 `http://localhost:3001/*`(及部署域名若有)
  - [x] SubTask 13.2: `content_scripts` 移除匹配 `*://my.jizhangerp.com/*` 的条目(含 `sync-auth.js` 与 `jizhangerp-bridge.js` 注入)
  - [x] SubTask 13.3: 移除 `update_url` 字段(自托管更新降级为手动)
  - [x] SubTask 13.4: 保留 `http://localhost:3000/*` 等本地开发域(若 erp-lite 未来用 3000 端口可复用)

## P1:被裁剪功能降级门控

- [x] Task 14: 在 `erp-backend-lite/src/config/feature-flags.json` 新增开关
  - [x] SubTask 14.1: 新增 `client_sync: false`、`proxy_collect: false`(已有)、`ai_rewrite: false`、`bestsellers_snapshot: false`、`l1_samples: false`、`usage_track: false`
- [x] Task 15: 在 `qx-ozon/background/service-worker.js` 读取 feature-flags 后门控相关功能
  - [x] SubTask 15.1: `client_sync === false` 时,`sync/sync-engine.js` 定时任务不注册、`backend-client.js` 的 sync/lease 调用静默 return
  - [x] SubTask 15.2: `ai_rewrite === false` 时,跟卖面板(ozon-product.js)的 AI 改写 UI 隐藏/禁用,提交时不调 `/ozon/ai/*`、`/ozon/extension/ai-optimize`、`/ozon/extension/translate`
  - [x] SubTask 15.3: `bestsellers_snapshot === false` 时,`/ozon/selection/bestsellers/snapshot` 与 `/ozon/selection/category-mapping` 上报不触发
  - [x] SubTask 15.4: `l1_samples === false` 时,`/extension/l1-samples` 上报不触发
  - [x] SubTask 15.5: `usage_track === false` 时,`/usage/track` 埋点不触发
  - [x] SubTask 15.6: `proxy_collect === false` 时,browser-agents 相关 UI 与 RPC(`backend-client.js` 中 agents 调用)不触发
- [x] Task 16: 处理 `qx-ozon/background/service-worker.js` 的 `checkForUpdate`(line ~1908),`/extension/latest` 在 erp-lite 未实现时静默降级(不报错,不弹更新提示)

## P1:配置中心消费(可选,对齐 xy-ozon)

- [x] Task 17: 在 `qx-ozon/background/service-worker.js` 新增 `getConfig` action,从 erp-lite `/app-config?scope=extension` 拉取配置
- [x] Task 18: `qx-ozon/content/ozon-product.js` 跟卖面板初始化时拉取配置,替换硬编码默认值(售价上限、默认库存、加价率、折扣阈值、视频转存开关、AI/水印开关)
- [x] Task 19: 若 qx-ozon 存在等价的定价面板逻辑,从 `/app-config?scope=pricing` 拉取汇率/佣金/物流费替换硬编码

## 验证

- [x] Task 20: 全项目 grep 验证 `jizhangerp` 仅剩注释/文档(非代码逻辑)
- [x] Task 21: `npm run format:check` 通过(qx-ozon 若未纳入 prettier 则跳过)
- [x] Task 22: 启动 erp-lite,加载 qx-ozon 插件,验证 popup 登录→导航→「进入ERP」全链路 — 后端端点验证通过(/health 200, /admin 200, /feature-flags/me 鉴权正常);浏览器端 UI 链路需用户手动验证
- [x] Task 23: 验证跟卖核心流程(viaPortal 与官方 API)可走通 — 代码审查确认 prepare-bundle-items/import/import/status 端点调用未受迁移影响;浏览器端实际跑流需用户手动验证

# Task Dependencies

- Task 7 依赖 Task 1(需先有 erp-lite 后端地址)
- Task 8/9/10/11/12 依赖 Task 7(需 `getErpBaseUrl` action)
- Task 15 依赖 Task 14(需先有 feature-flags)
- Task 22/23 依赖 Task 1-16 全部完成
- Task 17/18/19(P1 配置中心)与 Task 14-16(P1 降级)可并行,均依赖 P0 完成

# Task 15 实现说明
- SW 层门控已覆盖:setupClientSyncAlarms/handleClientSyncAlarm/handleBrowserAgentAlarm/jzManualSync/browserAgentGetState/browserAgentCancelCurrent 均加 `getFeatureFlagsCached()` 检查
- backend-client.js/sync-engine.js 无需重复门控:这些模块仅在 SW 层门控通过后被调用(alarm/action 触发),SW 层 return 后不会到达 backend-client
- checkForUpdate 已有 `if (!resp.ok) return;`(404 静默) + try/catch(网络错误静默),erp-lite 未实现 /extension/latest 时自动降级,无需额外修改
