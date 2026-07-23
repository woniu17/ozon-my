# qx-ozon 采集功能架构文档

> 本文档描述 qx-ozon 扩展当前采集功能的完整架构、数据流和实现细节,作为开发维护参考。
> 代码版本对应 `qx-ozon/` 目录,行号引用基于实际源码。

---

## 一、总体架构

### 1.1 两条采集链路

| 链路 | 触发入口 | source | 受 autoCollectRunning 约束 | 用途 |
|---|---|---|---|---|
| **店铺页轻量采集** | content `__jzSubmitCollectTask` | `'shop-page'`(硬编码) | 是 | 店铺页商品卡进入 SW 队列走完整 5 类采集 |
| **采集队列监控** | [collect/pages/queue/index.js](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/queue/index.js) | — | — | 仅监控 SW 队列状态,不提交任务 |

> **重要**:深度采集管理页(collect-manager)和 `source='manual'` 已于 2026-07 移除。两条链路共用同一个 SW 队列(ERP SQLite)、同一套 5 类缓存、同一套限流机制。

### 1.2 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层(popup / collect-queue)                              │
│   ├─ chrome.runtime.sendMessage({action:'submitTask',...}) │
│   ├─ 自适应轮询 getCollectManagerState(2s/5s)               │
│   └─ 1s 倒计时渲染下次执行时间                              │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│  background/service-worker.js  (MV3 SW, IIFE + importScripts)   │
│   ├─ importScripts 加载 6 个采集模块:                          │
│   │   collect-namespace.js / collect-cache.js / collect-config  │
│   │   collect-runner.js / collect-queue.js / collect-tab.js     │
│   ├─ 采集队列:ERP SQLite 持久化(真相源)                       │
│   ├─ 消费循环:_consumeOne 串行调度,consumeRateMin~MaxSec 随机 │
│   ├─ 8 步编排:_doAutoCollect(Gate 0/0.5 + Step 1-7)           │
│   ├─ 5 类缓存:ERP SQLite 单层(无 IDB)                        │
│   ├─ 限流:全局并发 3 + seller portal 闸门 200ms               │
│   └─ 反爬熔断:10 分钟暂停 + 缓存兜底                          │
└──────────────┬──────────────────────────────────────────────────┘
               │ HTTP (JWT 鉴权)
┌──────────────▼──────────────────────────────────────────────────┐
│  ERP 后端(erp-backend-lite,SQLite)                           │
│   ├─ 采集队列(真相源):/admin/api/collect-queue/*             │
│   ├─ 5 类缓存:/ozon/cache/{dom|attribute|richMedia|           │
│   │            marketStats|followSell}/:sku                    │
│   └─ 采集日志 / 浅度采集日志 / 店铺分类 / 店铺-SKU            │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 数据流图

```
[店铺页/搜索页/详情页]
    │
    │ 1. IntersectionObserver 触发 → extractCardInfo
    │ 2. 写 dom 缓存(fire-and-forget HTTP 写 ERP SQLite)
    │ 3. collectGate 就绪后 → __jzSubmitCollectTask
    │    └─ sendMessage('submitTask', {sku, source:'shop-page'})
    ▼
[SW _handleSubmitTask]
    │
    ├─ 去重检查(_isTaskQueuedOrCompletedToday)
    ├─ 5 类缓存前置检查(_checkAllCachesHit)
    │   └─ 全命中 → 直接返回 success,不入队
    └─ 入队(ERP insert) → _maybeStartConsume
                │
                ▼
         [_consumeOne 串行消费]
                │
                ├─ 跨日重置 / 熔断检查 / 暂停检查
                ├─ ERP claim 原子抢占(pending → running)
                ├─ _doAutoCollect 8 步采集
                │   ├─ Step1 并行查 5 类缓存
                │   ├─ Step4 买家页(pdp+followSell)
                │   ├─ Step5 seller portal(search+bundle)
                │   ├─ Step6 seller portal(marketStats)
                │   └─ Step7 写日志+广播 rescan
                ├─ 状态路由(success→终态 / partial→回 pending / skipped→终态)
                └─ setTimeout(随机 5~15s) → 下一个
```

---

## 二、采集队列与任务模型

### 2.1 任务数据结构

入队时由 `_handleSubmitTask` 构造([collect-queue.js L887](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-queue.js#L887)):

```javascript
{
  sku,                // 商品 SKU
  sellerSlug,         // 店铺 slug
  sellerId,           // 店铺 ID
  domInfo,            // content 端提取的 DOM 信息(card 5 字段)
  status,             // 任务状态(见 2.3)
  attempts,           // 已尝试次数(partial 时 +1 累计)
  lastError,          // 上次失败原因 {type, message, step, ts}
  steps,              // 8 步采集结果 {card:'ok', detail:'ok', ...}
  startedAt,          // 开始采集时间
  finishedAt,         // 完成时间
  createdAt,          // 入队时间(partial 回 pending 时刷新为 now,排到队尾)
}
```

> **已移除字段**:`maxAttempts`(无重试上限)、`nextRetryAt`(无退避)、`source`(硬编码 'shop-page')。

### 2.2 队列 meta 数据结构

默认值([collect-queue.js L57](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-queue.js#L57)):

```javascript
{
  circuitBreakerUntil: 0,      // 反爬熔断到期时间戳(0=未熔断)
  consumePaused: false,        // 队列是否暂停
  lastConsumeAt: 0,            // 上次消费完成时间戳
  completedTodaySkus: [],      // 今日已完成 SKU 集合(跨日重置)
  todayDate: '',               // 今日日期(YYYY-MM-DD,跨日重置)
}
```

存储位置:`chrome.storage.local['jz-collect-queue-meta']`,通过 `_withQueueLock` 串行化写入消除 get-modify-set 竞态。

> **已移除字段**:`consumeRateSec`(改为 config 的 `consumeRateMinSec`/`consumeRateMaxSec`)、`todayCount`(改为 `completedTodaySkus` 集合)、`perDayLimit`(每日上限移除)。

### 2.3 任务状态机

```
                         ┌──────────────────────────────────────────┐
                         │              submitTask                  │
                         │   (content script → SW → ERP insert)     │
                         └────────────────┬─────────────────────────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                      ┌────────────│   pending   │◄────────────────┐
                      │            └──────┬──────┘                 │
                      │                   │ ERP claim(原子抢占)    │
                      │                   ▼                        │
                      │            ┌─────────────┐                 │
                      │            │   running   │                 │
                      │            └──────┬──────┘                 │
                      │                   │                        │
                      │     ┌─────────────┼─────────────┐          │
                      │     │             │             │          │
                      │     ▼             ▼             ▼          │
                      │ ┌───────┐   ┌─────────┐   ┌─────────┐     │
                      │ │success│   │ skipped │   │ partial │     │
                      │ │(终态) │   │ (终态)  │   │ (回 pending)  │
                      │ └───────┘   └─────────┘   └────┬────┘     │
                      │                                 │          │
                      │              ┌──────────────────┼────┐     │
                      │              ▼                  ▼    ▼     │
                      │         ┌─────────┐  ┌────────┐ ┌────────┐ │
                      │         │ antibot │  │internal│ │  catch │ │
                      │         │(熔断+回 │  │(回     │ │(回     │ │
                      │         │ pending)│  │pending)│ │pending)│ │
                      │         └────┬────┘  └───┬────┘ └───┬────┘ │
                      │              │          │           │      │
                      │              └──────────┴───────────┘      │
                      │                         │                  │
                      │              _handlePartialTask            │
                      │              (createdAt=now,               │
                      │               status='pending',            │
                      │               attempts+1, lastError)       │
                      │                         │                  │
                      └─────────────────────────┴──────────────────┘
                                          (无限重试,无退避)

  僵尸任务恢复(ERP 定时 stale-reset):
    running (startedAt > 5min) ──► pending (lastError={type:'STALE',...})
```

**状态说明**:

| 状态 | 含义 | 终态? |
|---|---|---|
| `pending` | 待采集 | 否 |
| `running` | 采集中 | 否 |
| `partial` | 部分采集失败(`_doAutoCollect` 返回值,非队列持久状态) | 否(回 pending) |
| `success` | 全部采集成功(含 all-cached 缓存全命中) | 是 |
| `skipped` | 跳过(not-running/paused/non-mainland-china-store/unclassified-store/queue_timeout) | 是 |

> **状态机设计原则**(2026-07 重构):
> - 终态只有 `success` 和 `skipped`
> - 没有全部采集成功且不是 skipped 的任务,失败后回 `pending` 排到队尾,无限重试直到成功
> - 无退避策略(已移除 `nextRetryAt`/`maxAttempts`)
> - `partial` 是 `_doAutoCollect` 的返回值语义,表示"部分缓存命中但没全部采集成功",SW 收到后调 `_handlePartialTask` 回 `pending`
> - **`partial` 从不持久化到 ERP**:SW 的 `_handlePartialTask` 写 `status:'pending'` 而非 `'partial'`,ERP `TASK_STATUSES` 保留 `'partial'` 仅为前端 tab 兼容,实际 `byStatus.partial` 恒为 0
> - `skipped` 携带过滤原因(reason),如 `not-running`/`paused`/`non-mainland-china-store`/`unclassified-store`/`queue_timeout`

**重试机制**:`_handlePartialTask`([collect-queue.js L787](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-queue.js#L787))将任务回 `pending`,`createdAt=now` 排到队尾,`attempts+1` 记录尝试次数,`lastError` 记录上次失败原因(type/message/step/ts)。无退避,无最大重试次数。

**stale running 兜底**:ERP 定时(每 60s)检查 `running` 超 5 分钟的任务,重置为 `pending`(lastError 标记为 `{type:'STALE'}`)。

**终态任务清理**:ERP 定时(每 5 分钟)清理 `success`/`skipped` 终态任务,保留最新 500 条(按 `finishedAt` 降序)。

### 2.4 5 类深度采集缓存(7 项 results)

> `_doAutoCollect` 的 `results` 数组有 **7 项**(card/detail/pdp/search/bundle/marketStats/followSell),
> 对应 **5 类 ERP 缓存路径**(dom 合并 card+detail,attribute 合并 search+bundle)。
> 下表按 ERP 路径合并描述:

| 缓存 | ERP 路径 | type 参数 | 写入源 | 用途 |
|---|---|---|---|---|
| **dom** | `/ozon/cache/dom/:sku` | `card` / `detail` | content `extractCardInfo()` / `extractProductData()` | 商品卡 5 字段 + 详情页 DOM 全字段 |
| **attribute** | `/ozon/cache/attribute/:sku` | `search` / `bundle` | `_doAutoCollect` Step5 真调后写 | seller portal `/search` items + `create-bundle` 物理 attrs(重量/尺寸/条码) |
| **richMedia** | `/ozon/cache/richMedia/:sku` | — | `fetchPdpBundleViaBuyerTab` 内部 | entrypoint-api + composer-api 蒸馏的 {mp4, richContent, description, hashtags, gallery, fields, widgetStates, hitEndpoints} |
| **marketStats** | `/ozon/cache/marketStats/:sku` | — | `_doAutoCollect` Step6 | 市场统计(销量/评价/排名) |
| **followSell** | `/ozon/cache/followSell/:sku` | — | `fetchPdpBundleViaBuyerTab` 内部 | 跟卖可用性/竞品数据 |

**单层缓存架构**(2026-07 重构):取消 L1 IndexedDB 缓存层,所有缓存直接入库 ERP SQLite。原双层架构(L1 IDB + L2 SQLite)简化为单层。理由:SW 休眠后 IDB 连接不稳定、双层同步逻辑复杂、SQLite 已足够快。

**stale 策略**:所有缓存永久有效(已移除 `marketStatsStaleMs`/`followSellStaleMs`)。`attribute` 的 `bundle` 类型有空属性 6h 重验机制(`_ATTRS_EMPTY_REVERIFY_MS`)。

---

## 三、SW 采集队列核心机制

### 3.1 任务提交:`_handleSubmitTask`([collect-queue.js L887](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-queue.js#L887))

```
1. SKU 校验
2. 去重检查(_isTaskQueuedOrCompletedToday)
   └─ 已在队列或今日已完成 → 返回 {alreadyQueued: true}
3. 5 类缓存前置检查(_checkAllCachesHit)
   └─ 全命中 → 直接返回 {cacheHit: true},不入队
4. ERP 入队(_erpQueueInsert,含 skipIfTodaySuccess 去重兜底)
5. 调度消费(_maybeStartConsume)
```

**5 类缓存前置检查** `_checkAllCachesHit`:并行查 5 类缓存(dom 的 card+detail、attribute 的 search+bundle、richMedia、marketStats、followSell)。全命中时直接返回 `success`,避免缓存命中任务占用队列 slot。

### 3.2 消费循环:`_consumeOne`([service-worker.js L1452](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L1452))

```
1. keepAliveTimer(15s 唤醒防 SW 休眠)
2. 跨日重置(todayDate != today → 清 completedTodaySkus + consumePaused=false)
3. 熔断检查(Date.now() < circuitBreakerUntil → return)
4. consumePaused / autoCollectRunning / config.paused 检查
5. ERP peek pending 判断是否有任务
6. 尊重 consumeRateMinSec~MaxSec 间隔
7. ERP claim 原子抢占(pending → running)
8. _processTask → _doAutoCollect
9. 状态路由(success/skipped→终态;partial/antibot/failed/internal→回 pending)
10. setTimeout(随机 consumeRateMin~MaxSec * 1000) → _consumeOne(调度下一个)
```

### 3.3 调度入口:`_maybeStartConsume`([service-worker.js L1525](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L1525))

负责入队/Alarm 唤醒时的入口逻辑:

- **熔断期检查**:熔断中则返回
- **跨日恢复**:`todayDate != today` → 重置 meta(completedTodaySkus + consumePaused)
- **熔断过期恢复**:`Date.now() >= circuitBreakerUntil` 且 `consumePaused=true` → 重置 `consumePaused=false`
- **间隔补足**:SW 被杀后 alarm 唤醒,若距上次消费不足 `consumeRateMinSec` 则 `setTimeout` 等待剩余时间

### 3.4 状态路由:`_processTask`([service-worker.js L1395](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L1395))

```
_doAutoCollect 返回值:
  success  → _finalizeTask(终态,ERP /result 写 status='success')
  skipped  → _handleSkippedTask → _finalizeTask(终态,ERP /result 写 status='skipped')
  partial  → _handlePartialTask(回 pending,attempts+1,lastError 记录失败原因)
  antibot  → 熔断(meta.circuitBreakerUntil=now+10min + config.paused=true)
             + _handlePartialTask(回 pending)
  其他/异常 → _handlePartialTask(回 pending)
```

### 3.5 8 步采集编排:`_doAutoCollect`([collect-tab.js L1743](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-tab.js#L1743))

| 步骤 | 采集内容 | 数据来源 |
|---|---|---|
| **并发 slot 获取** | `_acquireAutoCollectSlot`,超时 60s 丢弃返回 `skipped` | — |
| **Gate 0 基础检查** | autoCollectRunning / paused / queue_timeout | config + meta |
| **Gate 0.5 中国大陆店铺** | `checkStoreClassification`,`onlyMainlandChinaStores` 开启时非中国/未分类店铺返回 `skipped` | ERP |
| **Step 1 并行查 5 类缓存** | `Promise.all` 查 dom(card+detail)/attribute(search+bundle)/richMedia/marketStats/followSell | ERP SQLite |
| **Step 2 计算 pending** | `hasPending=false` → 返回 `success`(reason:`all-cached`) | — |
| **Step 4 买家页采集** | `fetchPdpBundleViaBuyerTab` 取 pdp(richMedia)+followSell | www.ozon.ru tab |
| **Step 5 seller portal 采集** | `/api/v1/search` + `create-bundle-by-variant-id`,merge 物理 attrs 后重写 attribute 缓存 | seller.ozon.ru |
| **Step 6 seller portal marketStats** | `_fetchMarketStatsDirect` | seller.ozon.ru |
| **Step 7 写日志+计数** | `writeAutoCollectLog` + `pushAutoCollectRecent` + `_erpStoreSkuReport` | — |

**关键细节**:
- Step4/5/6 检测到 403/429/HTML 挑战页 → 抛 `ANTIBOT_BLOCKED` → 返回 `{status:'antibot'}`
- Step5 bundle 返回后 merge 物理 attrs(4497/9454-9456/7822)进 items[0] 并重写 attribute 缓存
- Step6 失败不熔断,HTTP 200 即写缓存(含空数据)
- `_doAutoCollect` catch 异常时返回 `{status:'partial'}`(非 `failed`),走 `_handlePartialTask` 回 pending

### 3.6 反爬熔断:`_handleAntibot`([collect-runner.js L368](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-runner.js#L368))

```
1. 设置 config.paused=true, pausedUntil=now+10min
2. 写 ERP 日志
3. 推送 _autoCollectRecent 环形缓冲
4. 返回 {status:'antibot', pausedUntil}
```

**双套熔断字段**(统一时间戳):
- `config.paused/pausedUntil`:配置级熔断,由 `_handleAntibot` 计算 `pausedUntil = Date.now() + 10min`
- `meta.circuitBreakerUntil`:队列级熔断,由 `_processTask` antibot 分支**复用** `_handleAntibot` 返回的 `pausedUntil` 设置(不再单独调 `Date.now()`,消除毫秒级漂移)

---

## 四、限流与反爬机制

### 4.1 限速字段(默认值见 [collect-config.js L27-44](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-config.js#L27))

| 字段 | 默认值 | 含义与现状 |
|---|---|---|
| `consumeRateMinSec` | `5`(秒) | 队列消费间隔下限,每次随机取 [min, max] 之间的值 |
| `consumeRateMaxSec` | `15`(秒) | 队列消费间隔上限 |
| `sellerPortalMinInterval` | `200`(ms) | seller portal API 调用最小间隔。实际闸门用硬编码常量 `SELLER_PORTAL_MIN_INTERVAL_MS=200`,配置项仅用于展示 |
| `buyerPageMinInterval` | `5000`(ms) | 历史遗留字段,代码中无实际限流作用 |
| `skuInterval` | `30000`(ms) | v1 旧字段,已被 `consumeRateMinSec`/`consumeRateMaxSec` 取代,保留兼容 |

> **已移除字段**:`consumeRateSec`(改为 min/max 随机)、`perDayLimit`/`todayCount`(每日上限移除)、`marketStatsStaleMs`/`followSellStaleMs`(stale 策略改为永久)。

### 4.2 全局并发 `_AUTO_COLLECT_MAX_CONCURRENT=3`([collect-tab.js L39](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-tab.js#L39))

- 最多 3 个 SKU 同时采集(`_acquireAutoCollectSlot`)
- 排队超时 60s 丢弃返回 `skipped`
- 计数器在 SW 内存,非持久化(SW 休眠后清零,符合预期:重启=新一轮)
- `_doAutoCollect` 入口 acquire,`finally` 中 release

### 4.3 seller portal 闸门

串行化链式闸门,所有 seller portal 出口(`/search`、`create-bundle-by-variant-id`、marketStats)共用,摊平请求密度防反爬。间隔 200ms。

### 4.4 熔断期缓存兜底

熔断期各 API 行为:

| API | 熔断期行为 |
|---|---|
| `getMarketStats` | 只查 cache,有缓存返回兜底,无缓存返回 `{__antibot:true}` |
| `transferVariantVideo` | 传 `cacheOnly:true` 查缓存,有 mp4 返回 cache 富内容(不执行转存) |
| `fetchVariantRichContent` | 传 `cacheOnly:true` 返回富内容/描述/标签 |
| `searchVariants` | 返回 antibot 错误(Step1 `/search` 无缓存无法跳过) |

---

## 五、采集页面

### 5.1 采集队列监控页(collect-queue)

**文件**:[collect/pages/queue/index.js](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/queue/index.js)

**功能**:
- **自适应轮询** `getCollectManagerState` 展示队列实时状态(running 任务存在时 2s 轮询,否则 5s)
- **1s 倒计时** 独立定时器渲染下次执行时间
- **窗口式滑动展示** 接下来即将被采集的 5 个 SKU,采集中 SKU 保持在中间,左右分别为已完成和即将采集的任务
- **4 类状态徽章** 采集中 / 采集成功 / 采集失败 / 未采集
- **强制清除反爬状态** 调用 SW `clearAntibotState` handler
- **清空已完成** 调用 SW `clearFinishedQueueTasks` handler

> **深度采集管理页(collect-manager)已于 2026-07 移除**,相关文件和 `source='manual'` 逻辑均已删除。

---

## 六、content 端采集逻辑

### 6.1 collectGate 门控机制([ozon-data-panel.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js))

**问题**:IntersectionObserver(≈200ms 触发)与 sellerSlug(≈500ms~15s 就绪)存在竞态。

**方案**:SKU 先入 `_pendingSkus` 队列,等 `collectGate`(sellerInfo + 分类结果)就绪后批量 flush。panel 渲染零阻塞,只有采集提交被 gate 门控。

- 店铺页 `/seller/*`:等 sellerInfo 到达后 resolve gate
- 非店铺页:立即 resolve(放行)
- 5s 超时降级:按空 slug 提交

### 6.2 `__jzSubmitCollectTask`([collect-entry.js](file:///c:/root/code/ozon-my/qx-ozon/collect/content/collect-entry.js))

```
1. _autoCollectSeen 去重(同会话不重复提交)
2. 检查 shallowCollectRunning 开关
3. 读 jz-auto-collect-config,检查 shallowCollectRunning
4. (仅店铺页)checkStoreClass 中国大陆店铺筛选
5. 提取 domInfo → sendMessage('submitTask', {sku, sellerSlug, sellerId, domInfo})
6. 加入 _autoCollectSeen
```

**注意**:content 端 `submitTask` **不传 `source`**,SW `_handleSubmitTask` 中 `source` 硬编码为 `'shop-page'`。

### 6.3 PDP 页面守卫

[ozon-product.js L10-13](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L10) 使用 `window.__JZ_PRODUCT_INSTALLED__` 守卫,防止重载时重复执行顶层 `ensurePdpState()` 网络请求。

### 6.4 浅度采集徽章与计数

> **核心原则**:商品卡角落徽章与 QX 采集器面板的"发现/采集/略过"计数,**均基于浅度采集的 `passesFilter` 判定**,不依赖深度采集队列状态或 ERP 缓存命中。
>
> 这与"采集队列监控页"的 4 类状态徽章(采集中/采集成功/采集失败/未采集,见 5.1)是两套独立 UI——后者描述深度采集任务状态,前者描述浅度采集过滤结果。

#### 文件位置

| 文件 | 职责 |
|---|---|
| [collect-status.js](file:///c:/root/code/ozon-my/qx-ozon/collect/content/collect-status.js) | 维护已发现/已通过过滤 SKU 集合、徽章渲染、计数统计、5 类缓存状态条渲染 |
| [ozon-data-panel.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js) | API/DOM 模式提取卡片 → 调用 `addStoreSku`/`updateStoreSkuPassFilter` → 刷新计数 |

#### 三态徽章定义

| 状态 | 视觉 | 判定依据 | 含义 |
|---|---|---|---|
| 未发现 | 无徽章 | `!_storeCollectedSkus.has(sku)` | 非店铺商品,或还未扫到 |
| 已发现未采集 | 蓝色 `•` | `_storeCollectedSkus.has(sku)` 且 `!_storeCollectedSkusPassed.has(sku)` | 店铺 SKU 已扫到,但未通过过滤条件(价格/评论/评分范围) |
| 已采集 | 绿色 `✓` | `_storeCollectedSkusPassed.has(sku)` | 通过过滤条件(`passesFilter=true`) |

#### "发现/采集/略过"计数定义

QX 采集器面板顶部状态条展示三项计数(由 `getStoreSkuStats()` 返回):

| 计数 | 计算公式 | 含义 |
|---|---|---|
| 发现 | `_storeCollectedSkus.size` | 当前店铺页扫到的所有店铺 SKU |
| 采集 | `_storeCollectedSkusPassed.size` | 通过过滤条件的 SKU 数 |
| 略过 | `发现 - 采集` | 未通过过滤条件的 SKU 数 |

#### 核心数据结构(collect-status.js)

```javascript
// 已发现店铺 SKU 集合(用于计数 + 徽章"已发现"判定)
const _storeCollectedSkus = new Set();

// 通过过滤的店铺 SKU 集合(passesFilter=true)
// 用于"已采集"判定:通过过滤 = 已采集,未通过 = 略过
const _storeCollectedSkusPassed = new Set();

// 5 类缓存命中集合(仅用于状态条展示,不参与徽章/计数判定)
const _skuCacheHitSet = new Set();
```

#### passesFilter 计算时机

**API 直取模式**([ozon-data-panel.js onCardExtracted](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js#L1342)):

卡片提取时即可计算 `passesFilter`(价格/评论/评分范围过滤),直接传入 `addStoreSku(sku, passesFilter)`。无论是否通过过滤都会:
- `reportStoreSkuDiscovery` → 发现计数 +1
- `addStoreSku(sku, passesFilter)` → 加入 `_storeCollectedSkus`,通过则同时加入 `_storeCollectedSkusPassed`
- `shallowCollectLog` → 写浅度采集日志(ERP 后端可见,含 `passesFilter` 字段)

仅 `passesFilter=true` 的 SKU 才会写 dom card 缓存并提交深度采集任务。

**DOM 滚动模式**([ozon-data-panel.js loadPanelData](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js#L579)):

`ensureDataPanel` 创建 panel 时 SKU 详情未查询,先调 `addStoreSku(sku)`(passesFilter 未定)。
`loadPanelData` 查询到 `info`(ratingCount/price/rating)后计算 `passesFilter`,再调 `updateStoreSkuPassFilter(sku, passesFilter)` 更新过滤状态:

```js
const passesFilter = !(onlyWithRating && !info.ratingCount) && _passesRangeFilter(info);
if (window.__jzCollectStatus?.updateStoreSkuPassFilter(productId, passesFilter)) {
  _updateStoreSkuCount();  // 状态有变化时刷新面板计数
}
```

#### 5s 定时器刷新

`_refreshVisiblePanels`([ozon-data-panel.js L229](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js#L229))每 5s 批量查询视口内 panel 的 ERP 数据 + 缓存状态,末尾调用 `_updateStoreSkuCount()` 刷新面板计数。这确保 DOM 模式下 `updateStoreSkuPassFilter` 异步更新后,面板计数能及时刷新。

#### 桥接接口(window.__jzCollectStatus)

| 方法 | 用途 |
|---|---|
| `addStoreSku(sku, passesFilter)` | 添加店铺 SKU,同时记录过滤状态 |
| `updateStoreSkuPassFilter(sku, passesFilter)` | 更新已存在 SKU 的过滤状态(DOM 模式用) |
| `getStoreSkuCount()` | 返回已发现 SKU 总数 |
| `getStoreSkuStats()` | 返回 `{collected, skipped, total}` |
| `updateCollectBadge(card, sku)` | 渲染商品卡角落徽章 |
| `renderCollectStatusBar(panel, sku, cacheStatus)` | 渲染 5 类缓存命中状态条(独立于徽章判定) |

---

## 七、配置与广播

### 7.1 配置项

存储位置:`chrome.storage.local['jz-auto-collect-config']`

```javascript
{
  enabled: true,                  // 总开关
  autoCollectRunning: true,       // 深度采集开关(SW 队列真调 Step4/5/6)
  shallowCollectRunning: true,    // 浅度采集开关(content DOM 写 card/detail + submitTask 入口)
  depth: 'Full',
  paused: false,                  // 熔断暂停标志
  pausedUntil: 0,                 // 熔断到期时间
  buyerPageMinInterval: 5000,     // 历史遗留(无实际作用)
  sellerPortalMinInterval: 200,   // 展示用(实际用硬编码常量)
  skuInterval: 30000,             // v1 旧字段(保留兼容)
  consumeRateMinSec: 5,           // 队列消费间隔下限(5-120 秒)
  consumeRateMaxSec: 15,          // 队列消费间隔上限(5-120 秒)
  onlyMainlandChinaStores: true,        // 仅采集中国大陆店铺
  knownMainlandChinaSlugs: [],          // 已知中国大陆店铺 slug 白名单
  knownNonMainlandChinaSlugs: [],       // 已知非中国大陆店铺 slug 黑名单
}
```

**配置缓存失效**:`autoCollectConfigCache` 内存缓存,`chrome.storage.onChanged` 监听 `jz-auto-collect-config` 变化时自动 invalidate([collect-config.js L96-101](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-config.js#L96))。

### 7.2 广播消息

> **2026-07 重构**:已移除 `collectDone`、`queuePaused`、`queueResumed`、`antibotDetected`、`configChanged` 等广播。当前仅保留 rescan 广播。

| 消息类型 | 发送方 | 接收方 | 用途 |
|---|---|---|---|
| `_broadcastRescan` | SW `_broadcastRescan`([collect-queue.js L256](file:///c:/root/code/ozon-my/qx-ozon/collect/background/collect-queue.js#L256)) | **仅 Ozon tabs**(`https://www.ozon.ru/seller/*` 和 `https://www.ozon.ru/product/*`) | 不刷新页面重新提交所有可见 SKU |

**关键约束**:rescan 广播仅发送给 `seller/*` 和 `product/*` 标签页,不发采集队列监控页。使用 `await Promise.allSettled(sends)` 确保消息投递。

---

## 八、SW action 路由清单(采集相关)

| action | 用途 |
|---|---|
| `submitTask` | 提交采集任务到队列 |
| `getCollectManagerState` | 查询队列状态(running/pending/finished/tasks) |
| `removeQueueTask` | 删除单个队列任务 |
| `clearFinishedQueueTasks` | 清空已完成任务 |
| `clearAntibotState` | 强制清除反爬熔断状态 |
| `cardCacheSet` / `detailCacheSet` | 写 dom 缓存 |
| `autoCollectGetConfig` / `autoCollectSetConfig` | 读/写采集配置 |
| `autoCollectGetRecent` | 读取最近 N 条采集记录(环形缓冲) |
| `autoCollectForceRefreshPage` | 清空当前 tab 去重集合,让已见 SKU 重新触发采集 |
| `getQueueStatus` | content 启动时查询队列状态(防时序竞态) |
| `queryErpProductData` | 查询单 SKU 的 ERP 数据(三级回退) |

> **已移除**:`registerCollectManager`/`unregisterCollectManager`(collect-manager 页删除)。

---

## 九、ERP 后端接口

### 9.1 采集队列接口

| 接口 | 方法 | 用途 |
|---|---|---|
| `/admin/api/collect-queue` | POST | 入队(SW `_handleSubmitTask`) |
| `/admin/api/collect-queue` | GET | 查询任务列表(分页 + 状态筛选) |
| `/admin/api/collect-queue/:sku` | DELETE | 删除单个任务 |
| `/admin/api/collect-queue/:sku/result` | POST | 写入采集结果(SW `_finalizeTask`) |
| `/admin/api/collect-queue/claim` | POST | 原子抢占下一个 pending 任务(SW `_consumeOne`) |
| `/admin/api/collect-queue/stale-reset` | POST | 重置超时 running 任务为 pending |
| `/admin/api/collect-queue/stats` | GET | 队列统计(各状态计数 + 今日完成/部分失败 + 熔断状态) |
| `/admin/api/collect-queue/sync-snapshot` | POST | 同步队列快照 |
| `/admin/api/collect-queue/batch-retry` | POST | 批量重试 |
| `/admin/api/collect-queue/clear-terminal` | POST | 清空所有终态任务(success/skipped) |

### 9.2 缓存接口

| 接口 | 方法 | 用途 |
|---|---|---|
| `/ozon/cache/:type/:sku` | GET | 读取缓存(type: dom/attribute/richMedia/marketStats/followSell) |
| `/ozon/cache/:type/:sku` | POST | 写入缓存 |
| `/ozon/cache/:type/:sku` | DELETE | 删除缓存 |

### 9.3 任务状态合法性

ERP `TASK_STATUSES = ['pending', 'running', 'partial', 'success', 'skipped']`:
- 终态:`success` / `skipped`
- 非终态:`pending` / `running` / `partial`(partial 为 _doAutoCollect 返回值语义,SW 实际写入 ERP 时回 `pending`)

> **已移除**:`failed_retry` / `failed_final` / `failed_partial` 三个状态(2026-07 重构)。

---

## 十、相关文档

- [SELLER_PROTOTYPE_API.md](./SELLER_PROTOTYPE_API.md) — seller.ozon.ru 门户接口使用说明(跟卖流程)
