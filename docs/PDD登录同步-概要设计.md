# PDD 登录同步（插件 popup → ERP 后台）概要设计

> 版本:2026-09-14 · 状态:待确认
> 目标:把拼多多"唯一登录点"移到用户日常浏览器,cloakbrowser 只消费 cookie,消除单点登录互踢。

## 1. 背景与痛点

拼多多仅支持单点登录(新登录踢旧会话)。现状登录点在 cloakbrowser 的 `.chrome-profile-*`:

```
现状(互踢循环):
用户日常浏览器登录 PDD ──踢──▶ cloakbrowser 登录失效
                                    │
              ERP 拉单 AUTH_REQUIRED │ 用户须跑 persistent.js 在
              ◀─────────────────────┘ cloakbrowser 里重登(麻烦,
                                       且下次浏览器登录又被踢)
```

用户日常浏览器本来就要登录 PDD 采购(它是唯一的真实登录场景),因此把登录权威源定为用户浏览器,ERP 侧**永不登录、只消费 cookie**,即可跳出互踢循环。

## 2. 可行性结论(已逐项验证)

| 依赖 | 现状 | 结论 |
|------|------|------|
| 插件读 PDD cookie | manifest 已有 `cookies` 权限 + `https://*.yangkeduo.com/*` host 权限,background 已在用 `cookies.getAll({domain:'yangkeduo.com'})` | ✅ 零 manifest 改动 |
| popup 载体 | `popup.html/js` 已存在(现为质检单设置页),加区块即可 | ✅ |
| cookie 送达 ERP 前端 | erp-bridge.js 已匹配 `http://localhost:3001/admin*`,已有 background→content script→页面 的反向转发先例(MS_ 事件) | ✅ 复用同模式 |
| 后端认证 | ERP 前端调 API 自带 JWT,插件无需持有 API key | ✅ |
| cloakbrowser 注入 | playwright persistent context 原生支持 `context.addCookies()`(合并语义,不破坏 profile 其它 cookie) | ✅ |
| PDD 拉单只靠 cookie | pdd.js 全链路仅依赖 cookie 会话(order_list_v4 / orders.html),无设备指纹硬绑定 | ✅ |

**风险定性**:cookie 从用户浏览器搬到无头 cloakbrowser,设备指纹不同——但这与现状(cloakbrowser 自持登录)风险相同,不会更差;且用户浏览器 cookie 历史更健康,理论上有助于降低风控概率。

## 3. 方案总览

```
用户日常浏览器(Edge,已登录 PDD)
 └─ 妙手助手 popup:显示当前 PDD 登录态(uid/昵称) + 目标账号下拉 + [同步登录到 ERP] 按钮
     └─ background.js:
         1. cookies.getAll({domain:'yangkeduo.com'}) → 校验 PDDAccessToken/pdd_user_id 存在
         2. 查 ERP 标签页登记表(复用 MS_GET_ORDERS 的登记逻辑)
            无 ERP 标签页 → popup 提示"请先打开 ERP 页面"
         3. chrome.tabs.sendMessage(erpTab, {type:'PDD_SYNC_COOKIES', payload})
             └─ erp-bridge.js(content script)→ window.postMessage 转发页面
                 └─ ERP 前端监听 → POST /admin/api/platform-orders/pdd-sync-cookies(JWT)
                     └─ ERP 后端:
                         a. app_config 存 pdd_cookies_<account> {cookies, uid, syncedAt}
                         b. browser-manager.applyCookies(account, cookies)
                            - 浏览器运行中 → ctx.addCookies() 即时生效
                            - 未启动 → 标记,doLaunch 启动后自动注入
                         c. 返回 {ok, account, cookieCount, injected}
                     ◀─ 结果沿原链路回传(sendResponse)→ popup toast 成功/失败
```

## 4. 详细设计

### 4.1 插件 popup(miaoshou-helper/popup.html + popup.js)

新增"拼多多登录同步"区块(现有质检单设置保留):

```
┌ 拼多多登录同步 ────────────────────┐
│ 当前浏览器登录: PCC01 (7509708455)  │  ← 打开时经 background 探测
│ 同步到 ERP 账号: [linqx ▾]          │  ← 下拉,记忆上次选择(uid→account)
│ [ 同步登录到 ERP ]                  │
│ (提示:请先在浏览器登录 mobile.yangkeduo.com)│
└───────────────────────────────────┘
```

- 打开 popup 时:background 读 cookie 拿 uid;调 `GET apollo/v3/user/me`(host 权限内跨域 fetch,带 AccessToken header)拿昵称——与妙手插件同款做法;失败则只显示 uid
- 账号列表来源:向 ERP 标签页发 `PDD_GET_ACCOUNTS`,由 ERP 前端查后端返回(`['linqx','chenlin']` + uid 绑定记忆);结果缓存到 background storage,ERP 页面未开时用缓存
- 未登录(无 PDDAccessToken):按钮禁用,提示先登录

### 4.2 插件 background.js

新增消息处理(与现有 PDD_GET_ORDERS 并列):

| 消息 | 方向 | 职责 |
|------|------|------|
| `PDD_POPUP_SYNC` | popup→bg | 执行 3. 节同步流程;结果经 sendResponse 回 popup |
| `PDD_GET_ACCOUNTS` | popup→bg | 向 ERP 标签页查询账号列表(转发页面),失败用缓存 |
| `PDD_SYNC_COOKIES` | bg→ERP 标签页 | tabs.sendMessage,带 {account, uid, cookies[]} |
| `PDD_SYNC_COOKIES_RESULT` | 页面→bg(经桥回传) | 同步结果回传 popup |

cookie 全量同步 yangkeduo.com 域(含埋点 cookie,保持会话完整性),必需项校验 `PDDAccessToken` + `pdd_user_id`,缺任一即报"未登录"。

### 4.3 erp-bridge.js(content script)

- 现有 `chrome.runtime.onMessage` 监听增加分支:`PDD_SYNC_COOKIES` → `window.postMessage({source:'erp-pdd', type:'PDD_SYNC_COOKIES', payload})`,并 `return true` 挂起 sendResponse
- 监听页面 `PDD_SYNC_COOKIES_RESULT`(source:'erp-pdd')→ 调挂起的 sendResponse 回 background

### 4.4 ERP 前端(平台订单采购弹窗组件 + 全局监听)

- `window.addEventListener('message')` 处理:
  - `PDD_SYNC_COOKERS` 收到 → POST `/admin/api/platform-orders/pdd-sync-cookies`(JWT)→ 结果 postMessage `PDD_SYNC_COOKIES_RESULT` 回桥 + 页面 toast("linqx 拼多多登录已同步(28 条 cookie)")
  - `PDD_GET_ACCOUNTS` 收到 → 查后端账号列表应答
- AUTH_REQUIRED 场景引导:PDD tab 报登录失效时,提示文案改为"请在常用浏览器登录拼多多后,点击妙手助手插件的『同步登录到 ERP』按钮"

### 4.5 ERP 后端

**新路由** `POST /admin/api/platform-orders/pdd-sync-cookies`:

```jsonc
// 请求(JWT)
{ "account": "linqx", "uid": "7509708455", "cookies": [ /* chrome.cookies 原始结构数组 */ ] }
// 响应
{ "ok": true, "data": { "account": "linqx", "cookieCount": 28, "injected": true, "syncedAt": "..." } }
```

**存储** app_config,key = `pdd_cookies_<account>`:

```jsonc
{
  "uid": "7509708455",
  "syncedAt": "2026-09-14T10:00:00.000Z",
  "cookies": [{ "name": "PDDAccessToken", "value": "...", "domain": ".yangkeduo.com",
                "path": "/", "expires": 1790000000, "httpOnly": true, "secure": true,
                "sameSite": "None" /* chrome.cookies → playwright 枚举已转换 */ }]
}
```

**cookie 字段映射**(chrome.cookies → playwright addCookies,后端做):

| chrome.cookies | playwright | 转换规则 |
|------|------|------|
| name/value/domain/path | 同名 | 透传(hostOnly cookie 保持原 domain) |
| expirationDate | expires | 无(session cookie)→ -1 |
| sameSite | sameSite | `no_restriction`→`None`(须 secure)/`lax`→`Lax`/`strict`→`Strict`/其余→`Unspecified` |
| secure/httpOnly | 同名 | 透传 |

**browser-manager.js 注入**:

- `applyCookies(account, cookies)` 导出:ctx 运行中 → `ctx.addCookies(mapped)`;未运行 → 无操作(启动时统一注入)
- `doLaunch()` 成功后:读 `app_config pdd_cookies_<profileName>` → 有则 addCookies(冷启动自愈)
- cookie 是 context 级,pages 缓存的 PDD 载体页无需重建

**pdd.js / status 调整**:

- AUTH_REQUIRED 文案:`拼多多登录态失效,请在常用浏览器登录 mobile.yangkeduo.com 后,点击妙手助手插件的『同步登录到 ERP』按钮`
- `GET /status` pdd 分支:浏览器未启动时返回 `{ running:false, cookieSyncedAt:<time>, uid:<uid> }`(从 app_config 读),前端显示"已同步(时间)"
- (可选优化)`fetchPddNickname` 改走 `apollo/v3/user/me` 同源 fetch,替代 personal.html 解析

## 5. 边界与风险

| 场景 | 行为 |
|------|------|
| 用户浏览器未登录 PDD | popup 按钮禁用 + 提示登录 |
| ERP 页面未打开 | popup 提示"请先打开 ERP 页面"(同步链路依赖页面桥,与妙手同步同约束) |
| 用户浏览器重新登录 PDD(单点踢旧 token) | cloakbrowser 旧 cookie 失效 → AUTH_REQUIRED → 用户再点同步即自愈(这是设计内的自愈路径) |
| cloakbrowser 内触发 psnl_verification 风控滑块 | 无头无人值守无法过 → 保持现有人工处理路径不变(persistent 过滑块);已知限制,本方案不恶化 |
| addCookies 合并语义 | 只覆盖同名同域 cookie,profile 内其它 cookie 不受影响 |
| cookie 明文存 app_config | 本机 SQLite,与 OPI key 等现有凭据同级安全 |
| 双本地账号(linqx/chenlin) | 每次同步只覆盖所选账号;两账号是不同 PDD 账号时各自在浏览器登录后分别同步 |

## 6. 实施拆解

| 里程碑 | 内容 | 依赖 |
|------|------|------|
| M1 后端 | pdd-sync-cookies 路由 + app_config 存储 + browser-manager 注入(即时/冷启动) + pdd.js 文案 + /status 增强 | 无 |
| M2 插件 | popup 区块(登录态显示+账号下拉+按钮) + background 消息链路 + erp-bridge 双向转发 | M1(需 API 就位) |
| M3 前端 | PDD_SYNC_COOKIES/PDD_GET_ACCOUNTS 页面处理 + toast + AUTH_FAILED 引导文案 | M1/M2 |
| M4 验证 | 见下 | 全部 |

## 7. 验证方案

1. **主链路**:浏览器登录 PDD(linqx)→ popup 显示昵称/uid → 选 linqx → 同步 → ERP 采购弹窗 PDD tab 拉单成功
2. **冷启动注入**:`pm2 restart erp` → 直接拉单(doLaunch 注入路径)成功
3. **踢号自愈**:浏览器重新登录 PDD → 拉单 AUTH_REQUIRED(新文案指引)→ 再点同步 → 恢复
4. **双账号**:浏览器切换登录 chenlin → popup 选 chenlin 同步 → 两账号 tab 均可拉单
5. **未登录/未开 ERP**:分别给出正确提示,无 JS 报错
