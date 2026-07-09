# Tasks

- [x] Task 1: 搭建 Vue 3 + Vite 工程脚手架
  - [x] SubTask 1.1: 在 `erp-backend-lite/web/` 初始化 Vite + Vue 3 工程（`package.json`、`vite.config.js`、`index.html`）
  - [x] SubTask 1.2: 安装依赖 `vue`、`vue-router`、`pinia`，配置 Vite dev server 代理 `/admin/api`、`/auth`、`/health` 到 `localhost:3001`
  - [x] SubTask 1.3: 配置 `vite.config.js` 的 `build.outDir` 指向 `../src/public`，`build.emptyOutDir: false`（避免误删后端其他静态文件）
  - [x] SubTask 1.4: 创建 `src/main.js`（挂载 Vue + Router + Pinia）、`src/App.vue`（根组件，含 Topbar + RouterView）
  - [x] SubTask 1.5: 移植 `admin.css` 的 CSS 变量与核心类到 `src/styles/global.css`，在 `main.js` 引入

- [x] Task 2: 封装 API 层与 Pinia Store
  - [x] SubTask 2.1: 实现 `src/api/request.js`：统一 fetch 封装（token 注入、401 处理、X-Refreshed-Token 续期、`{ok, data}` 解包、错误抛出）
  - [x] SubTask 2.2: 实现 `src/stores/auth.js`（useAuthStore：token/user 状态、login/logout action、localStorage 持久化）
  - [x] SubTask 2.3: 实现 `src/stores/stores.js`（useStoresStore：店铺列表缓存、load action、getter）
  - [x] SubTask 2.4: 按模块拆分 API 调用文件 `src/api/stores.js`、`listings.js`、`collect-box.js`、`collect-box-v2.js`、`products.js`、`batch.js`、`audit.js`、`config.js`、`dashboard.js`

- [x] Task 3: 实现共享组件库
  - [x] SubTask 3.1: `AppTopbar.vue`（品牌 / 用户徽章 / 退出登录按钮）
  - [x] SubTask 3.2: `AppModal.vue`（`v-model:open` 控制，mask + card + close，点击 mask 关闭）
  - [x] SubTask 3.3: `AppTabs.vue`（`v-model` 双向绑定当前 tab，支持横向 tab 列表）
  - [x] SubTask 3.4: `AppPager.vue`（`v-model:page` + total + pageSize，上一页/下一页/页码）
  - [x] SubTask 3.5: `AppAccordion.vue`（`v-model:open` + title + badge slot，点击标题切换）
  - [x] SubTask 3.6: `SourcedField.vue`（label + value + source 彩色角标 + sourceDetail，支持对象/数组/null 值渲染）
  - [x] SubTask 3.7: `useToast.js` composable + `AppToast.vue`（全局提示，3 秒自动消失）

- [x] Task 4: 实现登录页与路由守卫
  - [x] SubTask 4.1: `views/Login.vue`（手机号 + 密码表单，调 `/auth/login-password`，成功后存 token + 跳首页）
  - [x] 4.2: 路由守卫 `router/index.js`（未登录跳 `/login`，已登录访问 `/login` 跳 `/admin`）
  - [x] SubTask 4.3: `App.vue` 根据 auth 状态显示 Login 或主视图

- [x] Task 5: 实现 Dashboard 首页统计
  - [x] SubTask 5.1: `views/Dashboard.vue`（6 个统计卡片 + 近 7 天趋势柱状图）
  - [x] SubTask 5.2: 调 `/admin/api/dashboard` 获取数据，刷新按钮重新加载

- [x] Task 6: 实现 Stores 店铺管理
  - [x] SubTask 6.1: `views/Stores.vue`（店铺卡片列表，新增/编辑弹窗，测试连接，删除，查看仓库弹窗）
  - [x] SubTask 6.2: 表单字段：name / company_id / warehouse_id / currency_code / clientId / apiKey
  - [x] SubTask 6.3: 测试连接调 `/admin/api/test-connection`，自动回填单仓库

- [x] Task 7: 实现 Listings 上架记录
  - [x] SubTask 7.1: `views/Listings.vue`（筛选栏 + 表格 + 分页）
  - [x] SubTask 7.2: 筛选：店铺 / 关键词 / 状态 / 日期范围
  - [x] SubTask 7.3: 行操作：查看详情弹窗（任务元信息 + 商品级结果列表）

- [x] Task 8: 实现 CollectBox 采集箱（老版）
  - [x] SubTask 8.1: `views/CollectBox.vue`（筛选栏 + 卡片网格 + 分页）
  - [x] SubTask 8.2: 卡片显示 SKU / 名称 / 店铺 / 价格 / 图片 / 采集时间
  - [x] SubTask 8.3: 行操作：编辑（跳转采集编辑页）、删除

- [x] Task 9: 实现 CollectBoxV2 采集箱(全源)
  - [x] SubTask 9.1: `views/CollectBoxV2.vue`（筛选栏 + 卡片网格 + 分页，UNION 新老表，角标区分「全源」/「采集」）
  - [x] SubTask 9.2: 详情弹窗 `CollectBoxV2Detail.vue`：5 个 sub-tab（概览 / DOM 数据源 / Seller Portal / Page-JSON / 合成请求预览）
  - [x] SubTask 9.3: 概览：采集元信息 + 老表记录黄色提示横幅
  - [x] SubTask 9.4: DOM/Seller/Page-JSON sub-tab 用 `AppAccordion` 组件渲染，全部 `defaultOpen: true`
  - [x] SubTask 9.5: 合成请求预览 sub-tab：每字段带 source 彩色角标 + 来源图例

- [x] Task 10: 实现 Products 商品列表
  - [x] SubTask 10.1: `views/Products.vue`（筛选栏 + 表格 + 分页）
  - [x] SubTask 10.2: 列：SKU / 名称 / 店铺 / 状态 / 更新时间
  - [x] SubTask 10.3: 行操作：查看详情弹窗（attributes / 描述 / 图片等缓存数据）

- [x] Task 11: 实现 Batch 批量上架
  - [x] SubTask 11.1: `views/Batch.vue`（任务列表 + 筛选 + 分页）
  - [x] SubTask 11.2: 行操作：查看详情弹窗（任务头信息 + 商品级导入结果）

- [x] Task 12: 实现 Audit 操作日志
  - [x] SubTask 12.1: `views/Audit.vue`（筛选栏 + 表格 + 分页）
  - [x] SubTask 12.2: 列：时间 / 操作 / 操作人 / 详情（截断显示，hover 展开）

- [x] Task 13: 实现 Config 配置中心
  - [x] SubTask 13.1: `views/Config.vue`（feature flags 开关列表 + ERP 配置项编辑）

- [x] Task 14: 构建集成与验证
  - [x] SubTask 14.1: `npm run build` 产物输出到 `src/public/`，验证后端 `node src/app.js` 启动后 `/admin` 正常加载
  - [x] SubTask 14.2: 端到端验证：登录 → 9 个 Tab 切换 → 各 Tab 核心操作（新增店铺 / 上架记录筛选 / 采集箱详情 accordion 展开 / 商品列表分页）
  - [x] SubTask 14.3: 验证采集箱(全源)详情弹窗 accordion 默认展开且可点击折叠/展开

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 1]
- [Task 4] depends on [Task 2]
- [Task 5-13] depend on [Task 2, Task 3, Task 4]（可并行）
- [Task 14] depends on [Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11, Task 12, Task 13]
