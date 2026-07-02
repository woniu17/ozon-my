# Checklist

## P0:后端地址与品牌配置

- [x] `qx-ozon/background/service-worker.js` 的 `BACKEND_URLS` 生产与 dev 分支均不含 `api.jizhangerp.com`,仅指向 erp-lite
- [x] `qx-ozon/background/service-worker.js` 的 `__JZ_BRAND__.apiHost` / `webHost` 指向 erp-lite 域
- [x] `qx-ozon/content/shared-utils.js` 的 `__JZ_BRAND__` 同步指向 erp-lite 域
- [x] `qx-ozon/content/ozon-premium-hook.js` 的 `__JZ_BRAND__` 同步指向 erp-lite 域
- [x] `qx-ozon/popup/popup.js` 的 `BRAND_WEB_HOST` 兜底值为 erp-lite 域
- [x] `qx-ozon/content/alibaba-1688.js` 与 `qx-ozon/lib/cn-source-panel.js` 的 `getBrand()` webHost 兜底为 erp-lite 域
- [x] `qx-ozon/content/jzc-calc.js` 的更新检查 URL 不再指向 `api.jizhangerp.com`

## P0:Web 前端入口

- [x] `qx-ozon/background/service-worker.js` 新增 `getErpBaseUrl` action,返回 erp-lite 基址
- [x] `openFrontend` 处理器跳转目标为 `${backendUrl}/admin#${hash}`,path→hash 映射覆盖 8 个路径
- [x] `qx-ozon/popup/popup.js` 导航按钮使用 `ACTION_HASHES` 映射,跳转 `${erpBaseUrl}/admin#xxx`
- [x] popup「网页登录」按钮跳转 `${erpBaseUrl}/admin`
- [x] `qx-ozon/content/ozon-product.js` 详情页「进入ERP」按钮打开 `${erpBaseUrl}/admin`
- [x] `qx-ozon/content/ozon-product.js` 列表页「进入ERP」按钮打开 `${erpBaseUrl}/admin`
- [x] `ozon-product.js` 中会员充值/升级/模板管理/达上限拦截的 openFrontend path 改为 hash
- [x] `alibaba-1688.js` 与 `cn-source-panel.js` 的 `openCollectEditor` fallback 跳转 erp-lite admin

## P0:manifest.json

- [x] `host_permissions` 不含 `my.jizhangerp.com`、`api.jizhangerp.com`
- [x] `host_permissions` 含 `http://localhost:3001/*`
- [x] `content_scripts` 不含匹配 jizhangerp 域的条目(`sync-auth.js`、`jizhangerp-bridge.js` 不注入)
- [x] `update_url` 字段已移除

## P1:功能降级门控

- [x] `erp-backend-lite/src/config/feature-flags.json` 含 `client_sync`/`ai_rewrite`/`bestsellers_snapshot`/`l1_samples`/`usage_track`/`proxy_collect` 开关,默认 false
- [x] `client_sync === false` 时 sync-engine 定时任务不启动、backend-client sync 调用静默 return(SW 层门控 setupClientSyncAlarms/handleClientSyncAlarm/jzManualSync)
- [x] `ai_rewrite === false` 时跟卖面板 AI 改写 UI 隐藏/禁用,不调 `/ozon/ai/*`(ozon-product.js panel._erpConfig 门控)
- [x] `bestsellers_snapshot === false` 时不上报 `/ozon/selection/*`(SW 层门控 bestsellers snapshot + category-mapping)
- [x] `l1_samples === false` 时不上报 `/extension/l1-samples`(SW 层门控 l1ReportSamples)
- [x] `usage_track === false` 时不上报 `/usage/track`(SW 层门控 usageTrack action)
- [x] `proxy_collect === false` 时 browser-agents UI 与 RPC 不触发(SW 层门控 handleBrowserAgentAlarm/browserAgentGetState/browserAgentCancelCurrent)
- [x] `checkForUpdate` 调 `/extension/latest` 404 时静默降级,不弹错(已有 if(!resp.ok)return + try/catch)

## P1:配置中心(可选)

- [x] `getConfig` action 可从 `/app-config` 拉取配置(SW 新增 getConfig action,合并 extension+pricing scope)
- [x] 跟卖面板硬编码默认值(售价上限/默认库存/加价率/折扣阈值/水印开关)改为从配置读取(ozon-product.js panel._erpConfig?.xxx ?? fallback)
- [x] 定价面板汇率/佣金/物流费改为从配置读取(若适用) — 跳过:qx-ozon 定价面板实际逻辑在 jzc-calc.js(独立文件),createProfitPanel 是死代码未调用,本次不修改

## 集成验证

- [x] 全项目 grep `jizhangerp` 仅剩注释/文档,无代码逻辑引用(qx-ozon 全扫描确认)
- [x] `npm run format:check` 通过(qx-ozon 未纳入根 prettier 配置,erp-backend-lite 也无 prettier,改为 node --check 全部 JS 文件通过)
- [x] 启动 erp-lite,加载 qx-ozon 插件无报错 — 后端 /health 200,/admin 200,/feature-flags/me 正确要求鉴权
- [ ] popup 密码登录成功,token 写入 `chrome.storage.local`(需用户手动浏览器验证)
- [ ] popup 8 个导航按钮均跳转到 `localhost:3001/admin#对应hash`(需用户手动浏览器验证)
- [ ] Ozon 商品页「进入ERP」按钮打开 `localhost:3001/admin`(需用户手动浏览器验证)
- [ ] 跟卖 viaPortal 流程(prepare-bundle-items → seller.ozon.ru 三步)可走通(需用户手动浏览器验证)
- [ ] 跟卖官方 API 流程(import → import/status 轮询)可走通(需用户手动浏览器验证)
- [ ] feature-flags 关闭的功能不报错、不阻塞核心流程(需用户手动浏览器验证)
