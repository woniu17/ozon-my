# 平台订单多账号 Profile — 功能设计文档

> 版本：v1.0
> 日期：2026-09-13
> 模块：erp-backend-lite/src/services/platform-orders/（改造）
> 涉及前端：web/src/views/OrderProcess.vue（采购弹框导入区）
> 前置文档：docs/平台订单获取后端化-概要设计.md（M1-M3 已上线）

---

## 1. 背景与目标

### 1.1 现状

platform-orders 服务（M1-M3）当前**单 profile 单例**：三平台（pdd/ali1688/taobao）
共用 `.linqx-profile`，browser-manager 的 ctx/queue/锁/空闲回收全部绑死这一个目录。

### 1.2 需求

采购下单分散在**多个买手账号**：`.chenlin-profile` 登录了另一个 1688 账号（陈林）。
ERP 采购弹框需要能看到所有账号的平台订单，补全搜索也要能跨账号命中。

### 1.3 已确认决策（2026-09-13 与用户对齐）

| 决策点 | 结论 |
|---|---|
| 展示形态 | 前端采购弹框按账号分 tab：`1688·linqx` / `1688·chenlin` |
| 补全搜索 | 跨该平台所有账号依次搜，命中即返回 |
| 扩展模型 | **平台 → 账号列表**配置（未来任意平台可加第二账号，只改 .env） |
| 并发模型 | 各 profile 独立浏览器实例并行（独立队列/锁/空闲回收） |

### 1.4 非目标

- 不做订单去重合并到单一列表（用户选择 tab 区分，非聚合）
- 不改订单数据入库结构（订单行仅透传 account 标注）
- 妙手订单同步（MS_* 链路）不动

---

## 2. 配置设计（.env）

```
# ── 账号别名 → profile 路径映射 ──
PLATFORM_PROFILE_LINQX=C:\root\code\ozon-my\qxqx\.linqx-profile
PLATFORM_PROFILE_CHENLIN=C:\root\code\ozon-my\qxqx\.chenlin-profile

# ── 平台 → 账号列表(逗号分隔,第一个为主账号)──
PLATFORM_ACCOUNTS_PDD=linqx
PLATFORM_ACCOUNTS_ALI1688=linqx,chenlin
PLATFORM_ACCOUNTS_TAOBAO=linqx
```

config/index.js 解析为：

```js
platformProfiles:  { linqx: '...path', chenlin: '...path' },   // 别名→目录
platformAccounts:  { pdd: ['linqx'], ali1688: ['linqx','chenlin'], taobao: ['linqx'] },
```

兼容：`PLATFORM_PROFILE_DIR` 保留为 `linqx` 别名的兜底路径；引用了
`platformAccounts` 中不存在于 `platformProfiles` 的别名时启动即报配置错误。

## 3. 后端改造

### 3.1 browser-manager 工厂化

单例 → `createBrowserManager(profileName, profileDir)` 工厂：

- 每个 manager 独立持有：SerialQueue、ctx、pages、锁文件（`.<name>-profile.platform-orders.lock`
  按目录派生天然独立）、idleTimer、launchPromise、lastActiveAt
- 模块级 `managers: Map<name, manager>` 按需懒创建（首次用到该账号才实例化）
- `withPage(account, platform, entryUrl, originPrefix, fn, opts)`：签名加 account
- `status()` 聚合：`{ browsers: { linqx: {state,pid,...}, chenlin: {...} } }`
- `getCookieState(account, url)`：按账号读 cookie
- `stopPlatformOrders()`：遍历全部 manager 关闭

两个 profile 的浏览器可**真正并行**（不同 userDataDir 互不冲突，队列各自独立）；
单 profile 内存约 250-500MB，双开为可接受代价，空闲 10 分钟各自回收。

### 3.2 adapters 适配

- 三个适配器 `list*({ tab, size, account })`：account 由路由层校验后透传；
  pdd/taobao 当前单账号，走主账号，代码统一
- `normalize` 给订单对象加 `account` 字段（来源账号标注，导入"已选订单"区可显示）
- `searchAliOrder(orderSn)` **跨账号**：
  ```
  for account of accounts('ali1688'):
    try search(account) → 命中(orders.length>0)即返回
    catch AUTH_REQUIRED/RISK_VALIDATE → 记录该账号错误,继续下一账号
  全部未命中:
    - 所有账号都登录态失败 → 抛 AUTH_REQUIRED(文案列出各账号状态)
    - 否则 → { result: null }  # 单号确实不存在
  ```
- pdd/taobao 的 search 跨账号逻辑同款（当前各只有 1 个账号，逻辑统一为账号循环）

### 3.3 路由（modules/platform-orders.js）

| 接口 | 变更 |
|---|---|
| `GET /:platform?account=chenlin` | 新增 account 查询参数；不传=主账号（列表第一个）；非法值 400 |
| `GET /:platform/search?orderSn=` | 无参数变化；后端内部跨账号（前端零改动） |
| `GET /status` | 响应结构升级：`browsers: { <账号>: {state,pid,profileDir} }` + `platforms: { <平台>: { accounts: { <账号>: {login,cookieNames} } } }`；账号列表来自配置（静态始终返回，login 探测浏览器未运行时为 unknown） |

### 3.4 persistent.js 参数化（qxqx）

`node persistent.js <linqx|chenlin>`：账号别名 → 对应 profile 目录打开有头窗口；
不传参数时打印用法与可选账号列表并退出（避免误开错 profile）。
chenlin 直开 1688 订单列表页（platform-orders 实际取数入口）：登录态/风控
（baxia 滑块）问题在首页不一定暴露，订单页过一次验证即可解除挂起拦截；
linqx 开淘宝首页，1688 需过验证时在同一窗口手动访问订单页。

## 4. 前端改造（OrderProcess.vue 导入区）

三平台平行状态（pddOrders/aliOrders/tbOrders 等）重构为**统一账号 store 模型**：

```js
// tabKey: 'pdd' | 'ali:linqx' | 'ali:chenlin' | 'taobao'
const importStores = reactive({});        // tabKey → { orders, loading, error, tab, selected }
const importAccounts = ref([]);           // 来自 /status 的账号 tab 配置
//   [{ key:'pdd', platform:'pdd', platformVal:'yangkeduo', account:'linqx', label:'拼多多' },
//    { key:'ali:linqx', platform:'ali1688', platformVal:'1688', account:'linqx', label:'1688·linqx' }, ...]
```

- importTab 值改为 tabKey；平台 tab 行动态渲染 importAccounts（/status 到达后展开
  1688 双账号 tab；请求失败退化只显示主账号）
- `loadOrders(tabKey)`：按 platform+account 调 `getPlatformOrders(platform, {tab,size,account})`
- allSelectedOrders / newSelectedOrders：遍历 importStores 所有 key 合并（跨账号保留
  勾选，_platform/_account 标注，已选区每行展示账号徽标）
- 子 tab（全部/待发货/待收货）、loading/error/selected 全部进 store，切账号互不影响
- "已选订单"表格与提交链路：purchaseForm.platform 仍写 `1688`（入库结构不变），
  purchaseSn 按账号分组拼接（多账号各自逗号拼接，跨账号用逗号合并——现状已按逗号
  合并多单，无需改）
- 登录态提示：当前 tabKey 的 account login 为 'no' 时显示"未检测到 xx·账号 登录态"

### 4.1 api/order-process.js

`getPlatformOrders(platform, { tab, size, account })` 增加 account 参数（URLSearchParams
空值跳过，不传 account 时后端默认主账号，行为兼容）。

## 5. 关键流程（多账号列表）

```
① 前端弹框打开 → importTab='pdd' 默认加载；/status 异步返回账号配置 → 展开双 1688 tab
② 用户切到 1688·chenlin → GET /ali1688?account=chenlin
   → 路由校验 account ∈ config.platformAccounts.ali1688
   → manager(chenlin) 懒实例化(锁检查→launch→导航订单页)→ mtop 取数 → {orders, account:'chenlin'}
③ 勾选订单 → 已选区跨账号合并展示(带账号徽标) → 提交入库(platform='1688')
④ 补全搜索 → 后端 for 账号 in [linqx, chenlin] 依次搜 → 命中返回
```

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 双浏览器内存翻倍 | 低 | 空闲 10 分钟各自回收；按需懒启动（不用 chenlin 就不占内存） |
| persistent.js 与服务抢同一 profile | 低 | 锁文件按 profile 独立，PROFILE_LOCKED 精确到账号 |
| 某账号登录失效阻塞补全 | 中 | 跨账号搜索不中断（记错误继续）；全部失效才报 AUTH_REQUIRED 并列出各账号状态 |
| 前端 importTab 重构引入回归 | 中 | 保持 {ok,...} 响应形状与入库字段不变；浏览器端到端回归三平台 tab/勾选/导入 |
| 1688 baxia 风控（**验证期实际发生**） | 中 | 挂起式拦截原会烧满 60s 任务超时并整浏览器回收；已加页面内 fetch 25s AbortController 超时（page-fetch.js/pdd.js fetchInPage），快速失败为 BROWSER_ERROR 带人工过验证指引；FAIL_SYS_USER_VALIDATE 快速路径返回 RISK_VALIDATE(409)。解除方式：persistent.js 有头打开 1688 订单页人工过滑块（风控标记按 IP/账号持久，跨浏览器重启保留，人工过验证即清） |
| 任务超时错误语义 | 低 | withPage 超时改抛 ApiError TIMEOUT(408)（原为 500 INTERNAL_ERROR），前端可按 code 区分"偶发慢"与"系统性挂起" |

## 7. 任务分解

| 步骤 | 内容 | 验证 |
|---|---|---|
| S1 配置 | .env/.env.example + config 解析 platformProfiles/platformAccounts | ✅ 启动无配置报错 |
| S2 browser-manager 工厂化 | createBrowserManager + managers Map + stop/status/getCookieState 聚合 | ✅ node --check + 单账号回归 |
| S3 adapters + 路由 | account 透传 / search 跨账号 / status 新结构 / account 校验 | ✅ curl 双账号列表 + 跨账号搜索（双账号各自独立浏览器实例、独立锁文件） |
| S4 前端 | importStores 统一模型 + 动态账号 tab + 登录态/已选区账号徽标 | ✅ 构建产物含多账号逻辑（22:42 admin-CTCf9CXv.js，tab 由 /status 动态展开）；浏览器端到端见下方验证记录 |
| S5 persistent.js 参数化 | 别名参数 + 用法提示 | ✅ 手动跑 linqx/chenlin 各开一次 |
| S6 文档 + 加固 | 本文档状态更新；页面内 fetch 25s 超时（防 baxia 挂起）；TIMEOUT(408) 错误码 | ✅ 见验证记录 |

依赖链：S1 → S2 → S3 → S4；S5 独立。

## 8. 验证记录（2026-09-13）

- ✅ curl 双账号列表：chenlin / linqx 各自冷启动独立浏览器（~2-3s），路由、锁文件、
  订单行 account 标注正确；跨账号搜索正常
- ✅ PDD 回归：2s 返回真实订单（fetchInPage 加超时后无回归）
- ✅ /status 新结构：browsers 按账号 + platforms×accounts 登录探测，双 1688 账号
  login=yes（cookie 存在；baxia 属于独立拦截，见风险表）
- ⚠️ 1688 双账号被 baxia 风控拦截（RISK_VALIDATE 快速失败 3-4s，替代原 60s 挂死）：
  **遗留人工步骤** —— 运行 `node persistent.js chenlin`（直开订单页）人工过滑块，
  linqx 需在其窗口手动访问 1688 订单页过验证；过完关窗，ERP 前端硬刷新后即可加载订单
- 前端加载超时的原排查结论"冷启动慢需延 120s 超时"**已证伪**：冷启动仅 2-3s，
  根因是 baxia；PLATFORM_ORDER_TIMEOUT_MS=60s 维持不变
