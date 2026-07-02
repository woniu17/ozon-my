# qx-ozon 迁移至 erp-backend-lite 方案 Spec

## Why

`qx-ozon` 插件当前硬编码依赖 `api.jizhangerp.com`(API 后端)与 `my.jizhangerp.com`(Web 前端),分布在 `manifest.json`、`background/service-worker.js`、`content/shared-utils.js`、`popup/popup.js` 等十余处。项目内已有自建的 `erp-backend-lite`(11 张表、~63 个端点、`/admin` 后台 7 个 tab),且已成功承接 `xy-ozon` 插件。本方案将 `qx-ozon` 同样切换到 `erp-backend-lite`,实现后端独立自托管,消除对 jizhangerp 域名的依赖。

qx-ozon 与已迁移的 xy-ozon 架构差异显著(无 `erp-client.js`、有 `__JZ_BRAND__` 品牌配置、含 `sync/` 客户端同步与 `browser-agents` 代采模块),需独立设计而非照搬 xy-ozon 方案。

## What Changes

### 插件端(qx-ozon)

- **后端 URL 切换**:`BACKEND_URLS` 由 `['https://api.jizhangerp.com']` 改为 `['http://localhost:3001']`(可配置部署域名),移除 jizhangerp 候选
- **品牌配置重指向**:`__JZ_BRAND__.apiHost` / `webHost` 在 `service-worker.js`、`shared-utils.js`、`ozon-premium-hook.js`、`popup.js`、`alibaba-1688.js`、`cn-source-panel.js`、`jzc-calc.js` 中改为指向 erp-lite 域
- **Web 前端入口重映射**:popup 的 8 个 `ACTION_PATHS` 导航按钮、「进入ERP」按钮(content/ozon-product.js 两处)、1688/cn-source 的 `openCollectEditor` 跳转,统一改指向 erp-lite `/admin#<hash>` 路由
- **新增 `getErpBaseUrl` service-worker action**:供 popup/content 动态获取后端基址(复用已有 `getBackendUrl()`),替代 `openFrontend` 中对 `BRAND_WEB_HOST` 的依赖
- **`openFrontend` 处理器改造**:跳转目标由 `${BRAND_WEB_HOST}${path}` 改为 `${backendUrl}/admin#${hash}`,token 注入逻辑保留(erplite admin 支持 localStorage token)
- **manifest.json 调整**:`host_permissions` 移除 `my.jizhangerp.com`/`api.jizhangerp.com`,新增 erp-lite 域;`content_scripts` 移除注入到 jizhangerp 域的 `sync-auth.js` 与 `jizhangerp-bridge.js`;移除自托管 `update_url`
- **被 erp-lite 裁剪的功能做降级**:`sync/` 客户端同步、`browser-agents` 代采、AI 类端点(`/ozon/ai/*`、`/ozon/extension/ai-optimize`、`/ozon/extension/translate`)、L1 样本上报、bestsellers 快照、`/usage/track` 埋点 —— 通过 erp-lite `feature-flags` 门控,关闭相关 UI 入口与定时任务,API 404 时静默降级不阻塞核心流程
- **配置中心消费**(可选,P1):`follow-sell-panel` 等价逻辑(qx-ozon 内联在 `ozon-product.js`)从 erp-lite `/app-config` 拉取默认值替换硬编码

### ERP 后端(erp-backend-lite)

- **无需新增端点**:现有 63 个端点已覆盖 qx-ozon 核心流程(鉴权/采集/跟卖/商品数据/配置/批量/审计)。qx-ozon 调用但 erp-lite 未实现的端点(sync/agents/AI/L1/bestsellers/usage/extension-latest)按"裁剪清单"在插件端降级,不在后端补齐
- **`feature-flags` 扩展**:新增 `client_sync`、`proxy_collect`、`ai_rewrite`、`bestsellers_snapshot` 等开关(默认 false),供插件读取后决定是否启用相关 UI
- **`/admin` 页面无新增 tab**:复用现有 7 个 tab(dashboard/stores/listings/collect-box/products/batch/config)。qx-ozon 的 `favorites` 路径并入 `#collect-box`

### **BREAKING**

- qx-ozon 不再能连接 jizhangerp.com 后端(生产构建 `__JZ_PROD_BUILD__=true` 也走 erp-lite)
- jizhangerp.com 域内的 Web↔Extension token 桥(`sync-auth.js`)与 postMessage 桥(`jizhangerp-bridge.js`)失效,需通过 popup 密码登录重新建立登录态
- 自托管扩展更新(`update_url`)移除,改为手动更新

## Impact

- **Affected specs**: 无既有 spec(本次为首份)
- **Affected code**:
  - 插件:`qx-ozon/manifest.json`、`qx-ozon/background/service-worker.js`、`qx-ozon/background/sync/backend-client.js`、`qx-ozon/content/shared-utils.js`、`qx-ozon/content/ozon-premium-hook.js`、`qx-ozon/content/ozon-product.js`、`qx-ozon/content/alibaba-1688.js`、`qx-ozon/content/jzc-calc.js`、`qx-ozon/content/sync-auth.js`(移除注入)、`qx-ozon/content/jizhangerp-bridge.js`(移除注入)、`qx-ozon/popup/popup.js`、`qx-ozon/lib/cn-source-panel.js`
  - 后端:`erp-backend-lite/src/config/feature-flags.json`(新增开关)
- **参考文档**:`docs/ERP_BACKEND_LITE_DESIGN.md`(后端设计)、`docs/ERP_MIGRATION_AND_FEATURE_DESIGN.md`(xy-ozon 迁移先例)

## ADDED Requirements

### Requirement: qx-ozon 后端地址切换至 erp-backend-lite

qx-ozon 插件 SHALL 将所有后端 API 调用指向 `erp-backend-lite` 服务(`http://localhost:3001` 或部署域名),不再请求 `api.jizhangerp.com`。

#### Scenario: 后端选址

- **WHEN** service-worker 启动并调用 `getBackendUrl()`
- **THEN** 候选列表仅含 erp-lite 地址,`GET /health` 探活成功后缓存该地址
- **AND** 生产构建与 dev 构建均不走 jizhangerp.com

#### Scenario: 生产构建兜底

- **WHEN** `globalThis.__JZ_PROD_BUILD__ === 'true'`
- **THEN** `BACKEND_URLS` 仍为 erp-lite 地址(从配置或常量读取),不回退 jizhangerp

### Requirement: Web 前端入口统一指向 erp-lite /admin

qx-ozon 的所有「进入 ERP 网页」入口(popup 导航按钮、「进入ERP」按钮、1688/cn-source 跳转)SHALL 跳转到 `${erpBaseUrl}/admin#${hash}`,由 erp-lite admin 页面承接。

#### Scenario: popup 导航

- **WHEN** 用户点击 popup 中 dashboard/products/collect-box/favorites/import-history/reshelf/watermark/stores 任一导航按钮
- **THEN** 新标签页打开 `${erpBaseUrl}/admin#<对应hash>`,token 自动注入 localStorage

#### Scenario: 商品页进入ERP

- **WHEN** 用户在 Ozon 商品页点击「进入ERP」按钮
- **THEN** 新标签页打开 `${erpBaseUrl}/admin`

### Requirement: getErpBaseUrl 消息通道

service-worker SHALL 暴露 `getErpBaseUrl` action,返回当前解析的后端基址,供 popup/content 脚本动态拼接 admin URL。

#### Scenario: 获取基址

- **WHEN** popup/content 调用 `chrome.runtime.sendMessage({ action: 'getErpBaseUrl' })`
- **THEN** 返回 `{ ok: true, baseUrl: 'http://localhost:3001' }`(或部署域名)

### Requirement: 被裁剪功能优雅降级

qx-ozon 中依赖 erp-lite 未实现端点的功能(sync/agents/AI/L1/bestsellers/usage)SHALL 通过 feature-flags 门控,开关关闭时隐藏 UI 入口并停止定时任务,不抛错阻塞核心流程。

#### Scenario: AI 功能关闭

- **WHEN** `feature-flags.ai_rewrite === false`
- **THEN** 跟卖面板的 AI 改写开关隐藏或禁用,提交时不调 `/ozon/ai/*`
- **AND** 不向用户报错

#### Scenario: 客户端同步关闭

- **WHEN** `feature-flags.client_sync === false`
- **THEN** `sync/sync-engine.js` 定时任务不启动,`backend-client.js` 的 sync 调用静默返回

### Requirement: manifest 域名权限更新

manifest.json SHALL 移除 jizhangerp 相关 host_permissions 与 content_scripts 注入,新增 erp-lite 域权限。

#### Scenario: host_permissions

- **WHEN** 检查 manifest.json
- **THEN** 不含 `*://my.jizhangerp.com/*`、`*://*.my.jizhangerp.com/*`、`https://api.jizhangerp.com/*`
- **AND** 含 `http://localhost:3001/*`(及部署域名,若有)

#### Scenario: content_scripts 注入

- **WHEN** 检查 manifest.json content_scripts
- **THEN** 不含匹配 jizhangerp 域的条目(`sync-auth.js`、`jizhangerp-bridge.js` 不再注入)

## MODIFIED Requirements

### Requirement: __JZ_BRAND__ 品牌配置

`__JZ_BRAND__.apiHost` 与 `webHost` 字段 SHALL 指向 erp-lite 域(`localhost:3001` 或部署域名),分销商 build 兜底逻辑保留但兜底值改为 erp-lite 域。

## REMOVED Requirements

### Requirement: 自托管扩展更新(update_url)

**Reason**: erp-lite 不提供 `/extension/updates/my/manifest.xml` 端点,自托管更新链路断裂。
**Migration**: 移除 manifest.json 的 `update_url` 字段,扩展改为手动更新(开发者模式加载或打包分发)。

### Requirement: jizhangerp 域内 Web↔Extension 桥

**Reason**: 迁移后不再访问 jizhangerp 域,`sync-auth.js`(token 双向同步)与 `jizhangerp-bridge.js`(postMessage 桥)失去注入目标。
**Migration**: 从 manifest content_scripts 移除这两脚本注入;脚本文件本身保留(不删源码,避免影响其他 build 目标);登录态改为 popup 密码登录直接写入 `chrome.storage.local`。

### Requirement: 客户端同步与代采(可选启用)

**Reason**: erp-lite 设计明确裁剪 client-sync(lease 锁)与 browser-agents(代采),单设备个人场景无需。
**Migration**: 默认通过 feature-flags 关闭;`sync/` 与 `agent/` 目录代码保留,未来若启用多设备协作可重新打开开关。
