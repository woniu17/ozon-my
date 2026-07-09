# Admin 后台 Vue 重构 Spec

## Why
当前 ERP 后台 `erp-backend-lite/src/public/` 是纯原生 JS + HTML + CSS 单体页面（admin.js 85KB / admin.html 23KB / admin.css 22KB），DOM 操作手写、事件委托易丢失、状态散落在全局变量、弹窗/Tab/分页逻辑高度重复（如采集箱详情 accordion 点击失效 bug 就是 outerHTML 转换丢失事件监听器所致）。用 Vue 重构可显著降低维护成本、提升可读性，并消除一类手动 DOM 管理的 bug。

## What Changes
- **新增 Vue 3 前端工程**：在 `erp-backend-lite/` 下新增 `web/` 目录，基于 Vite + Vue 3 + Vue Router 构建（不引入 UI 组件库，保持轻量，沿用现有 CSS 变量体系）。
- **组件化拆分**：按现有 9 个 Tab 拆成路由级组件（Dashboard / Stores / Listings / CollectBox / CollectBoxV2 / Products / Batch / Audit / Config），公共部分（Topbar / Login / Modal / Tabs / Pager / Accordion / SourcedField / Toast）抽成共享组件。
- **API 层封装**：新增 `src/api/` 目录，统一封装 fetch（带 token、401 处理、滑动续期、`{ok, data}` 解包），替代各页面散落的 `api()` 调用。
- **Pinia 状态管理**：用 Pinia 管理 auth（token/user 持久化到 localStorage）和 stores 缓存（多 Tab 共享店铺列表），替代当前全局变量。
- **开发与构建**：`web/` 目录独立 `package.json`，`npm run dev` 启动 Vite dev server（代理 `/admin/api`、`/auth`、`/health` 到 `localhost:3001`），`npm run build` 产物输出到 `erp-backend-lite/src/public/`（覆盖现有 admin.html / admin.js / admin.css），后端继续用 `express.static` 托管，无需改后端路由。
- **后端零改动**：所有 `/admin/api/*`、`/auth/*` 接口契约保持不变，仅静态资源文件被替换。
- **保留现有 CSS 视觉风格**：移植 `admin.css` 的 CSS 变量与核心类（`.btn` / `.modal` / `.tabs` / `.data-table` 等）到 Vue 工程的全局样式，确保重构后视觉一致。
- **BREAKING**：旧 `admin.html` / `admin.js` / `admin.css` 将被构建产物覆盖。重构期间若需回退，可通过 git 恢复。

## Impact
- Affected specs: 无（首个前端重构 spec）
- Affected code:
  - 新增：`erp-backend-lite/web/`（Vite + Vue 3 工程根目录）
  - 覆盖：`erp-backend-lite/src/public/admin.html`、`admin.js`、`admin.css`（由 build 产物替换）
  - 不变：`erp-backend-lite/src/app.js`（静态托管逻辑不变）、所有 `src/modules/*.js`（API 路由不变）、`src/middleware/*.js`、`src/db/*`

## ADDED Requirements

### Requirement: Vue 3 工程脚手架
系统 SHALL 在 `erp-backend-lite/web/` 下提供独立的 Vite + Vue 3 工程，包含 `package.json`、`vite.config.js`、`index.html`、`src/main.js`、`src/App.vue`、`src/router/index.js`。

#### Scenario: 开发模式启动
- **WHEN** 开发者在 `web/` 目录执行 `npm install && npm run dev`
- **THEN** Vite dev server 在 `localhost:5173` 启动，页面可正常访问，API 请求被代理到 `localhost:3001`

#### Scenario: 生产构建
- **WHEN** 开发者在 `web/` 目录执行 `npm run build`
- **THEN** 构建产物输出到 `erp-backend-lite/src/public/`（覆盖旧 admin.html / admin.js / admin.css），后端 `node src/app.js` 启动后访问 `/admin` 加载新版 Vue 页面

### Requirement: 路由级页面组件
系统 SHALL 按 9 个 Tab 拆分路由级组件：Dashboard / Stores / Listings / CollectBox / CollectBoxV2 / Products / Batch / Audit / Config，每个组件对应一个路由（`/admin` 默认重定向到 Dashboard）。

#### Scenario: Tab 切换
- **WHEN** 用户点击顶栏 Tab
- **THEN** 路由切换到对应页面组件，URL hash 变化（如 `#/collect-box-v2`），页面内容更新

### Requirement: 共享组件库
系统 SHALL 提供以下共享组件：
- `AppTopbar`：顶栏（品牌 / 用户徽章 / 退出登录）
- `AppModal`：通用弹窗（mask + card + close，用 `v-model:open` 控制，无需手动 hidden 操作）
- `AppTabs`：Tab 容器（支持 `v-model` 双向绑定当前 tab）
- `AppPager`：分页器（`v-model:page` + total + pageSize）
- `AppAccordion`：折叠面板（`v-model:open`，无事件委托问题）
- `SourcedField`：带来源标记的字段展示（label + value + source 角标）
- `AppToast`：全局提示（composable `useToast()` 触发）

#### Scenario: Accordion 展开/折叠
- **WHEN** 用户点击 `AppAccordion` 标题
- **THEN** 面板展开/折叠，状态由 Vue 响应式管理，不依赖 DOM 事件委托

### Requirement: API 封装层
系统 SHALL 在 `web/src/api/` 下提供统一 API 客户端 `request(path, options)`，自动：
- 注入 `Authorization: Bearer <token>` 头
- 处理 401（清除 token + 跳登录）
- 读取 `X-Refreshed-Token` 响应头做滑动续期
- 解包 `{ok, data}` 响应体，直接返回 `data`
- 业务错误抛 `Error(message)`

#### Scenario: Token 过期
- **WHEN** API 返回 401
- **THEN** 清除 localStorage token，路由跳转到登录页，显示"登录已过期"

### Requirement: Pinia 状态管理
系统 SHALL 用 Pinia 管理：
- `useAuthStore`：token / user / 登录 / 登出，持久化到 localStorage
- `useStoresStore`：店铺列表缓存（多 Tab 共享，避免重复请求）

#### Scenario: 跨 Tab 共享店铺列表
- **WHEN** 用户从 Stores Tab 切到 Listings Tab
- **THEN** Listings Tab 的店铺筛选下拉直接读取 `useStoresStore` 缓存，不重复请求 `/admin/api/stores`

## MODIFIED Requirements

### Requirement: 采集箱(全源)详情弹窗
原实现用 `createAccordion` 返回 DOM 元素，经 `.outerHTML` 拼接后事件监听器丢失，导致 accordion 点击展开失效。

重构后 SHALL 用 `AppAccordion` 组件（`v-model:open` 响应式控制展开状态），Seller Portal / Page-JSON / DOM 三个 sub-tab 的所有 accordion 默认展开（`defaultOpen: true`）。

#### Scenario: 详情弹窗 accordion 交互
- **WHEN** 用户打开采集箱(全源)详情弹窗，切到 Seller Portal sub-tab
- **THEN** 「SKU xxx」「完整 sv 对象」「/search 响应」三个 accordion 默认展开，点击标题可折叠/展开

## REMOVED Requirements

### Requirement: 纯原生 JS 实现的 admin 页面
**Reason**: 用 Vue 重构替代，降低 DOM 管理复杂度。
**Migration**: 旧 `admin.html` / `admin.js` / `admin.css` 由 Vue 构建产物覆盖；可通过 git 历史回退。
