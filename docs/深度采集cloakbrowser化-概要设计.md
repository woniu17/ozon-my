# 深度采集 cloakbrowser 化 — 概要设计文档

> 版本：v2.0（重大修订：数据通道 SQLite 直写 → ERP API + API Key 鉴权）
> 日期：2026-08-21
> 模块：qxqx/deep-collect.js（无头深度采集）
> 参考实现：qxqx/shallow-collect.js（无头浅度采集）
> 语义基准：qx-ozon/collect/background/collect-tab.js `_doAutoCollect`（插件深度采集编排）

---

## 1. 背景与目标

### 1.1 现状问题

深度采集目前由 qx-ozon 插件 Service Worker 消费 `collect_queue_tasks` 队列完成
（`_doAutoCollect`，collect-tab.js），存在以下限制：

- 依赖人工开着浏览器 + 插件运行，无法无人值守
- SW 生命周期受浏览器管理（休眠/回收），采集吞吐不稳定
- 单设备单浏览器实例，无法脱离用户日常使用的浏览器

浅度采集已于 2026-08 完成 cloakbrowser 化（shallow-collect.js），验证了
"无头浏览器 + 页面上下文注入 fetch + SQLite 直写"模式的可行性。

### 1.2 设计目标

新建 `qxqx/deep-collect.js`，参照 shallow-collect.js 骨架，无人值守消费深度采集队列：

1. **语义对齐**：编排顺序、三门控（市场统计/类目过滤/超轻小件）、数据写入格式
   与插件 `_doAutoCollect` 完全一致，两条消费者可互换
2. **无人值守**：cloakbrowser 无头模式，断点续采、熔断恢复、优雅退出
3. **detail 增强**：买家页本来就要导航到商品详情页（对齐插件 `ensureBuyerTab`），
   顺带提取 detail 数据写 `ozon_dom_cache.detail_data`（插件因无用户交互实际不写 detail，
   本方案补齐该历史缺口）
4. **数据通道 API 化**：所有读写（队列消费/缓存读写/日志）走 ERP HTTP API，
   以**服务专用 API Key** 鉴权（方案 B，见 §3.2）。收益：
   - 解锁跨机部署（脚本无需访问 erp.db 文件，网络可达即可）
   - 消除 SQLite 文件级锁竞争（脚本与 ERP 进程不再共享 db 句柄）
   - 索引聚合由 ERP DAO upsert 自动触发（`indexDao.syncSku`），脚本删除 syncSkuLite 移植
   - 审计可区分机器流量（`req.user.service`）
5. **轻后端改动**：仅 authMiddleware 新增 `x-api-key` 分支（~20 行，对齐
   image-host `x-image-host-token` 服务间鉴权先例），其余端点全部复用现有 API

### 1.3 非目标

- 不修改插件 SW 的深度采集实现（两者共存，claim 原子性保证不重复消费）
- ERP 后端仅新增 API Key 鉴权分支（其余模块不动；stale-reset / 清理任务照常工作）
- 不实现多机分布式消费（单实例锁互斥）
- 不采集 video 转存（transferVideoToOzon 属于跟卖流程，不在采集范围）

---

## 2. 现状基准

### 2.1 插件深度采集链路（语义基准）

| 数据类 | API 端点 | 页面上下文 | 前置依赖 |
|---|---|---|---|
| marketStats | `seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3` | seller 页同源 fetch（需 `x-o3-company-id` 自定义头，无法跨域） | `sc_company_id` cookie |
| search | `seller.ozon.ru/api/v1/search` | seller 页同源 fetch（company_id 放 body） | `sc_company_id` cookie |
| bundle | `seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id` | 同上 | search 返回的 `variant_id` |
| richMedia | `www.ozon.ru/api/entrypoint-api.bx/page/json/v2` → composer 兜底 | **商品详情页**上下文（`ensureBuyerTab` 导航到 `/product/<sku>`） | www 登录态 |
| followSell | `www.ozon.ru/api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers...` | 同上 | www 登录态 |
| detail（本方案新增） | 同 richMedia 的 page json 响应（零增量请求）+ 页面 jsonLd | 同上 | www 登录态 |

### 2.2 编排顺序与门控（对齐插件 2026-08 门控重构）

```
claim 任务(POST /admin/api/collect-queue/claim,ERP 原子抢占)
  → Gate 0.5  中国店铺检查(GET /admin/api/store-classification/:sellerId)
  → Step 1    缓存查询(GET /ozon/cache/*/:sku × 5,命中即跳过对应真调)
  → Step 3    marketStats 真调
  → 门控A     失败(AUTH_REQUIRED/NO_DATA/异常) → partial 回 pending 重试
              无数据(__empty) → skipped(no-market-stats) 终态
  → Step 4    search 真调 → bundle 真调(search 命中但 bundle 缺失时单独补采)
  → 门控B     search 失败 → partial 回 pending
              search 无数据 → skipped(no-search-data)
              类目黑名单命中 → skipped(filtered-category)
  → 门控C     bundle 失败(含上游 search 失败) → partial 回 pending
              非超轻小件(重量≥500g 或三边和≥900mm) → skipped(non-ultra-light)
  → Step 5    买家页采集:buyerPage 导航商品详情页
              → fetchPdpMedia(entrypoint→composer 链 + nextPage 扩散)
              → fetchFollowSellModal(otherOffers modal,并行)
              → detail 提取(page json widgetStates + jsonLd,零增量请求)
  → Step 6    API 写入:缓存(POST /ozon/cache/*/:sku) + 任务终态
              (POST /admin/api/collect-queue/:sku/result) + 深度采集日志
              (POST /admin/api/auto-collect/log);索引聚合由 ERP DAO 自动触发
  → SKU 间隔节流 → 下一个 claim
```

### 2.3 任务状态机（复用现有语义）

```
pending ──claim(原子 UPDATE...RETURNING,attempts+1)──→ running
running ──→ success(终态) | partial(回 pending,createdAt=now 塞队尾) | skipped(终态)
attempts ≥ 10(MAX_TASK_ATTEMPTS) → 不再 claim,stale-reset 时标 skipped
running 超 5 分钟(崩溃残留) → ERP stale-reset 回 pending
```

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────────┐
│                     ERP Backend (erp-backend-lite)              │
│   collect_queue_tasks 队列 · 5 张缓存表 · auto_collect_log      │
│   (claim 原子抢占 · DAO upsert 自动触发索引聚合)                 │
└──────────────▲──────────────────────────────▲─────────────────┘
               │ HTTP + x-api-key(服务鉴权)    │
               ▼                              │(读:claim/缓存查询/黑名单/店铺分类)
┌────────────────────────────────────────────────────────────────┐
│              deep-collect.js(Node 主进程编排)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │Gate 0.5  │→│Step 1    │→│Step 3/4  │→│Step 5/6          │  │
│  │店铺分类API│ │缓存查询API│ │seller侧  │ │buyer侧+API写入    │  │
│  └──────────┘ └──────────┘ │三门控A/B/C│ │                   │  │
└─────────────────────────────┴─────┬────┴─────────┬────────────┘
                                  │              │
                    page.evaluate │              │ page.evaluate
                    (同源注入 fetch)│              │ (详情页上下文)
                                  ▼              ▼
┌────────────────────────────────────────────────────────────────┐
│            cloakbrowser launchPersistentContext                 │
│  ┌──────────────────────────┐  ┌────────────────────────────┐  │
│  │ sellerPage(常驻)         │  │ buyerPage(逐 SKU 导航详情页)│  │
│  │ seller.ozon.ru/app/     │  │ www.ozon.ru/product/<sku>  │  │
│  │ · data/v3(marketStats)  │  │ · entrypoint→composer 链    │  │
│  │ · /search               │  │ · otherOffers modal         │  │
│  │ · create-bundle         │  │ · detail 提取(widgetStates) │  │
│  └──────────────────────────┘  └────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

> 数据流向：deep-collect.js 向上经 HTTP+x-api-key 读写 ERP（claim/缓存/终态/日志），
> 向下经 page.evaluate 驱动 cloakbrowser 双页采集 Ozon 数据。

### 3.1 核心决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 并发模型 | **串行单 SKU** + 间隔节流(8-15s 随机) | 反爬风险最低，与浅采模式一致；日均处理量约 6-8k 任务 |
| detail 采集 | **Step 5 顺带提取**(零增量请求) | buyerPage 本就要导航详情页(对齐 ensureBuyerTab)；从已获取的 page json widgetStates 提取，补齐插件不写 detail 的历史缺口 |
| 浏览器模型 | 一个 persistent context + 双 page | sellerPage 常驻(避免每 SKU 重登录验证)；buyerPage 逐 SKU 导航(详情页上下文是"真实用户行为"铁律) |
| 数据通道 | **ERP HTTP API**(缓存/队列/日志全走 API) | 解锁跨机部署(无需访问 erp.db 文件)；消除 SQLite 锁竞争；索引聚合由 ERP DAO 自动触发；复用插件同款端点(语义零漂移) |
| ERP 鉴权 | **服务专用 API Key**(`x-api-key` 头) | 永久稳定、零刷新逻辑、审计可区分机器流量；对齐 image-host `x-image-host-token` 服务间鉴权先例(§3.2) |
| 类目黑名单 | **GET /admin/api/filtered-categories**(启动加载一次) | 复用现有端点；黑名单人工维护量级小,重启生效可接受 |
| 任务 claim | **POST /admin/api/collect-queue/claim** | 与插件 SW 完全同款(DAO claimNextPending 原子 UPDATE...RETURNING),多消费者天然互斥 |
| 熔断 | 403/429 → 暂停 10 分钟 → 双页 warmup → 续采 | 对齐插件 `_handleAntibot` |
| partial 回队 | **POST /admin/api/collect-queue**(upsert,status=pending,createdAt=now 塞队尾) | 对齐插件 `_handlePartialTask` → `_erpQueueUpdate`，避免立即重复 claim 同一任务 |

### 3.2 ERP 鉴权设计：服务专用 API Key（方案 B）

**后端改动**（authMiddleware 入口新增分支，~20 行）：

```js
// erp-backend-lite/src/middleware/auth.js — authMiddleware 首行:
if (config.serviceApiKey && req.headers['x-api-key'] === config.serviceApiKey) {
  req.user = { id: 0, service: 'deep-collect' };   // 服务身份,审计可区分机器/人工
  return next();                                    // 跳过 JWT 校验与滑动续期
}
```

- 后端 .env 新增：`SERVICE_API_KEY=<随机 32 字节 hex>`（`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成）
- 脚本 .env 同配：`ERP_BASE_URL=http://127.0.0.1:3001` + `ERP_API_KEY=<同值>`
- 稳定性：**永久有效**——无过期、无刷新、无 401 恢复逻辑；key 变更仅需两侧 .env 同步重启
- 安全边界：key 等同管理员全权（个人版单用户系统可接受）；key 只存在两侧本机 .env，不入库不入 git
- 滑动续期机制对 API Key 流量天然跳过（无 JWT 即无续期），与插件/管理页的人工 JWT 会话互不干扰
- 已评估并放弃的备选：方案 A（密码自动登录 + X-Refreshed-Token 接力，零后端改动但需
  token 缓存文件 + 重登逻辑，且密码明文进 .env）；方案 C（长效服务 JWT，仍需改后端且仍有过期窗口）

### 3.3 与现有系统的共存关系

- 浅采 `shallow-collect.js` 继续入队（不变；浅采自身的 SQLite 直写不在本次改造范围）
- 插件 SW 与 deep-collect.js 是同队列的两个消费者：claim 原子性（同一 DAO）保证不重复消费；
  同时运行时天然分流，仅节奏不同（可接受）
- profile 默认共用 `.ozon-profile`：浅采/深采共享跨脚本锁，互斥运行
  （cloakbrowser 同一 userDataDir 不允许双开，锁文件提前拦截并给出明确报错）
- ERP 后端仅新增 API Key 鉴权分支，插件 SW（JWT）与管理页（JWT）完全不受影响

---

## 4. 数据写入设计

每 SKU 结束按需逐条调用 ERP API（无本地事务——单 SKU 内多条写入间崩溃时，任务停留在
running 由 stale-reset 回 pending，重试按缓存命中跳过已写部分，语义与插件逐步写缓存一致）：

| 目标 | ERP API | 请求体 | 触发条件 |
|---|---|---|---|
| marketStats 缓存 | `POST /ozon/cache/marketStats/:sku` | `{ data: normalizeMarketItem(...) }`（HTTP 200 即写，含 `__empty`） | Step 3 真调成功 |
| search 缓存 | `POST /ozon/cache/attribute/:sku` | `{ type: 'search', data: { items: 原始 variants } }` | Step 4 真调成功 |
| bundle 缓存 | `POST /ozon/cache/attribute/:sku` | `{ type: 'bundle', data, bundleId }`（空属性时 DAO 附 attrs_empty_verified_at） | Step 4 真调成功 |
| richMedia 缓存 | `POST /ozon/cache/richMedia/:sku` | `{ data: { mp4, richContent, description, hashtags, gallery, fields, widgetStates, hitEndpoints } }` | Step 5 anyOk(HTTP 200) |
| followSell 缓存 | `POST /ozon/cache/followSell/:sku` | `{ data: { count, sellers[], source } }`（仅 HTTP 200 写入） | Step 5 modal 成功 |
| detail 缓存 | `POST /ozon/cache/dom/:sku` | `{ type: 'detail', data: 19 字段对象 }` | Step 5 详情页加载成功 |
| 任务终态 | `POST /admin/api/collect-queue/:sku/result` | `{ status, result, lastError?, duration, finishedAt, attempts? }` | 每个 SKU 结束(success/skipped) |
| partial 回队 | `POST /admin/api/collect-queue` | `{ sku, status:'pending', attempts, lastError, steps, createdAt: now }` | partial 路径 |
| 深度采集日志 | `POST /admin/api/auto-collect/log` | `{ sku, source:'headless-deep', sellerId, status, reason, results, totalDuration }` | 每个 SKU 结束(含 partial/skipped) |

> 缓存写入的附带收益：ERP DAO upsert 自动触发 `indexDao.syncSku`（索引聚合 + FTS 同步），
> 脚本无需移植浅采的 syncSkuLite。

**读取端点**（Step 1 缓存查询与配置加载）：

| 用途 | ERP API | 说明 |
|---|---|---|
| dom 缓存(card/detail) | `GET /ozon/cache/dom/:sku` | 返回 card_data/detail_data 独立字段 |
| attribute 缓存 | `GET /ozon/cache/attribute/:sku` | 返回 searchData/bundleData/bundleId/attrsEmptyVerifiedAt/stale(空属性>6h) |
| marketStats 缓存 | `GET /ozon/cache/marketStats/:sku` | 返回 data/fetchedAt/stale(24h) |
| followSell 缓存 | `GET /ozon/cache/followSell/:sku` | 返回 data/fetchedAt/stale(4h) |
| richMedia 缓存 | `GET /ozon/cache/richMedia/:sku` | 返回 data/fetchedAt |
| 店铺分类 | `GET /admin/api/store-classification/:sellerId` | Gate 0.5 中国店铺判定 |
| 类目黑名单 | `GET /admin/api/filtered-categories` | 启动加载一次,内存 Map |
| 任务 claim | `POST /admin/api/collect-queue/claim` | 返回 task 或 null |

---

## 5. 错误分类与熔断

| 分类 | 判定 | 处理 |
|---|---|---|
| AUTH_REQUIRED | sellerPage 无 `sc_company_id` / 401 重定向 | 等待 SELLER_AUTH_WAIT_MS(默认 10 分钟)重试探测；连续 AUTH_RETRY_MAX 次仍失败则退出并提示人工登录 |
| ANTIBOT | 403/429/挑战页 HTML | 熔断暂停 10 分钟 → 双页 warmup 刷 cookie → 续采（当前任务 partial 回队） |
| ERP_API_FAILED | ERP 请求超时/网络错误/5xx | 请求级重试 1 次(2s 退避,对齐插件 _erpQueueUpdate)；连续 ERP_FAIL_MAX 次失败 → 暂停主循环,每 30s 探测 /health(public 路径)恢复后续采 |
| ERP_KEY_INVALID | 401 且非 JWT 场景(API Key 未配/不匹配) | 启动时探活失败直接报错退出(提示两侧 .env 配置)；运行中极少发生 |
| 永久性 | 404 / 门控无数据(__empty/no variants/非超轻) | skipped 终态 |
| 临时性 | 超时/网络/5xx/evaluate 异常 | partial 回 pending，由 attempts 上限(10)兜底 |
| Ctrl+C | SIGINT | 当前 running 任务回 pending（attempts 保留，createdAt=now 塞队尾），优雅退出 |
| 崩溃残留 | running 超 5 分钟 | ERP stale-reset 兜底回收（现有机制，无需脚本处理） |

---

## 6. 登录态与 Profile

- profile 默认共用浅采的 `.ozon-profile`（`PROFILE_DIR` 可配置切换独立 profile）
- **新增依赖**：需人工在该 profile 登录过一次 `seller.ozon.ru`（`sc_company_id` 持久化）；
  脚本启动时探测，缺失则告警退出
- 可用 `state-transfer.js --export/--import` 跨机迁移登录态
- 启动 warmup：buyerPage 访问 www 首页过反爬挑战；sellerPage 访问 seller 首页确认登录态

---

## 7. 配置设计（.env 新增，默认对齐插件当前生效值）

```
# ERP 连接与鉴权
ERP_BASE_URL=http://127.0.0.1:3001  # ERP 地址(跨机部署改远程地址)
ERP_API_KEY=<与后端 SERVICE_API_KEY 同值>
# 采集
PROFILE_DIR=.ozon-profile          # 默认与浅采共用(跨脚本锁互斥)
SKU_INTERVAL_MIN_MS=8000           # SKU 间隔(默认 8-15s 随机)
SKU_INTERVAL_MAX_MS=15000
ENABLE_MARKET_STATS_GATE=1         # 门控A
ENABLE_CATEGORY_FILTER_GATE=1      # 门控B
ENABLE_ULTRA_LIGHT_GATE=1          # 门控C
ONLY_MAINLAND_CHINA=1              # Gate 0.5
TASK_LIMIT=0                       # 本批任务上限(小批量测试用)
ANTIBOT_WAIT_MS=600000             # 反爬熔断等待(默认 10 分钟)
SELLER_AUTH_WAIT_MS=600000         # 登录失效等待重试间隔
AUTH_RETRY_MAX=3                   # 登录失效重试上限,超过退出
ERP_FAIL_MAX=5                     # ERP 连续失败上限,超过暂停等待恢复
CLAIM_EMPTY_WAIT_MS=60000          # claim 持续为空的等待窗口,超过退出
DRY_RUN=0                          # 干跑:claim 但不写任何数据(任务回 pending)
LOG_SKU=0                          # SKU 逐条日志
```

> 后端 .env 同步新增：`SERVICE_API_KEY=<同值>`（见 §3.2）。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| seller 登录态过期（sc_company_id 失效） | 启动探测 + 运行中 AUTH_REQUIRED 分类等待重试 + 超限退出告警 |
| Ozon 反爬升级（403 概率上升） | 串行 + 随机节流 + 熔断退避；与插件消费分流降低单通道压力 |
| ERP 服务不可用 | 请求级重试 + 连续失败暂停 + /health 探测恢复；任务由 stale-reset 兜底不丢失 |
| API Key 泄漏 | key 仅存两侧本机 .env（不入 git）；泄漏时两侧同步换 key 即可（个人版无多租户连带风险） |
| ERP API 语义与插件 SW 漂移 | 两消费者走完全相同的端点与 DAO，语义由 ERP 单点保证，天然零漂移 |
| detail 提取字段与插件 DOM 解析口径不一致 | 以 widgetStates 为准（插件 2026 SSR 剥离修复后同样依赖 page json），jsonLd 兜底 |
| 与插件 SW 同时运行导致节奏冲突 | 可接受（claim 原子）；如需独占可先停插件深度采集开关 |
| page.json 结构变更（widget 前缀漂移） | 前缀匹配(webGallery/webPrice/...)与插件同口径，随插件同步维护 |

---

## 9. 后续工作

1. 详细设计（见《深度采集cloakbrowser化-详细设计》）：模块分解、ERP API Client 规格、
   注入函数规格、detail 字段映射表、测试计划
2. 后端先行改动：authMiddleware 增加 `x-api-key` 分支 + `.env.example` 补 SERVICE_API_KEY
3. 实现 `qxqx/deep-collect.js` + `.env.example` 更新
4. 测试：TASK_LIMIT=1 DRY_RUN 干跑 → TASK_LIMIT=10 小批量验证 → 全量
