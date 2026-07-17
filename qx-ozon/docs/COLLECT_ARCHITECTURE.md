# qx-ozon 采集功能架构文档

> 本文档描述 qx-ozon 扩展当前采集功能的完整架构、数据流和实现细节,作为开发维护参考。
> 代码版本对应 `qx-ozon/` 目录,行号引用基于实际源码。

---

## 一、总体架构

### 1.1 三条采集链路

| 链路 | 触发入口 | source | 受 autoCollectRunning 约束 | 用途 |
|---|---|---|---|---|
| **店铺页轻量采集** | content `__jzSubmitCollectTask` | `'shop-page'`(默认) | 是 | 店铺页商品卡进入 SW 队列走完整 8 类采集 |
| **深度采集管理页** | [collect/pages/manager/index.js](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/manager/index.js) `startCollect` | `'manual'` | 否(绕过) | 手动批量采集,复用 SW 队列与限流 |
| **采集队列监控** | [collect/pages/queue/index.js](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/queue/index.js) | — | — | 仅监控 SW 队列状态,不提交任务 |

> **重要**:三条链路共用同一个 SW 队列(`jz-collect-queue`)、同一套 8 类缓存、同一套限流机制,仅 `source` 字段区分。`source='manual'` 任务在 SW `_consumeOne` 中绕过 `autoCollectRunning` 检查并重置 `consumePaused`。

### 1.2 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层(popup / collect-manager / collect-queue)           │
│   ├─ chrome.runtime.sendMessage({action:'submitTask',...}) │
│   ├─ 5s 轮询 getCollectManagerState                         │
│   └─ onMessage 监听 collectDone/taskStatus                  │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  background/service-worker.js  (MV3 SW)                     │
│   ├─ 采集队列:chrome.storage.local 持久化 + ERP 镜像        │
│   ├─ 消费循环:_consumeOne 串行调度,consumeRateSec 间隔     │
│   ├─ 8 步编排:_doAutoCollect(Gate 0/0.5 + Step 1-7)        │
│   ├─ 8 类缓存:IDB(L1) + ERP MongoDB(L2)                   │
│   ├─ 限流:全局并发 3 + seller portal 闸门 200ms            │
│   └─ 反爬熔断:10 分钟暂停 + 缓存兜底                       │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  ERP 后端(MongoDB)                                         │
│   ├─ 采集队列任务镜像                                       │
│   ├─ 8 类缓存 L2 存储                                        │
│   └─ 采集日志持久化                                         │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 数据流图

```
[店铺页/搜索页/详情页]
    │
    │ 1. IntersectionObserver 触发 → extractCardInfo
    │ 2. 写 card_cache(IDB + ERP)
    │ 3. collectGate 就绪后 → __jzSubmitCollectTask
    │    └─ sendMessage('submitTask', {sku, source:'shop-page'})
    ▼
[SW _handleSubmitTask]
    │
    ├─ 去重检查(_isTaskQueuedOrCompletedToday)
    ├─ 8 类缓存前置检查(_checkAllCachesHit)
    │   └─ 全命中 → 直接返回 success,不入队(不消耗 daily-limit)
    └─ 入队 → _maybeStartConsume
                │
                ▼
         [_consumeOne 串行消费]
                │
                ├─ manual 任务绕过 autoCollectRunning
                ├─ 跨日重置 / 熔断检查 / daily-limit 检查
                ├─ _doAutoCollect 8 步采集
                │   ├─ Step1 并行查 8 类缓存
                │   ├─ Step4 买家页(composer+entrypoint+followSell)
                │   ├─ Step5 seller portal(search+bundle)
                │   ├─ Step6 seller portal(marketStats)
                │   └─ Step7 写日志+广播
                ├─ 状态流转(success/partial/failed/antibot)
                └─ setTimeout(consumeRateSec*1000) → 下一个
```

---

## 二、采集队列与任务模型

### 2.1 任务数据结构

入队时由 `_handleSubmitTask` 构造([SW 5327-5342](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L5327)):

```javascript
{
  sku,                // 商品 SKU
  sellerSlug,         // 店铺 slug
  sellerId,           // 店铺 ID
  domInfo,            // content 端提取的 DOM 信息(card 5 字段)
  source,             // 'manual' | 'shop-page'
  status,             // 任务状态(见 2.3)
  attempts,           // 已尝试次数
  maxAttempts,        // 最大重试次数(默认 3)
  nextRetryAt,        // 下次重试时间戳
  lastError,          // 最后一次错误信息
  steps,              // 8 步采集结果 {card:'ok', detail:'ok', ...}
  startedAt,          // 开始采集时间
  finishedAt,         // 完成时间
  createdAt,          // 入队时间
}
```

### 2.2 队列 meta 数据结构

默认值([SW 4120-4128](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4120)):

```javascript
{
  consuming: false,            // 是否正在消费(运行时内存标志,非持久化)
  circuitBreakerUntil: 0,      // 反爬熔断到期时间戳(0=未熔断)
  consumeRateSec: 15,          // 串行消费间隔(秒,5-120)
  consumePaused: false,        // 队列是否暂停
  lastConsumeAt: 0,            // 上次消费完成时间戳
  todayCount: 0,               // 今日已完成数(仅终态 +1)
  todayDate: '',               // 今日日期(YYYY-MM-DD,跨日重置)
}
```

存储位置:`chrome.storage.local['jz-collect-queue-meta']`,通过 `_withQueueLock` 串行化写入消除 get-modify-set 竞态([SW 4140-4196](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4140))。

### 2.3 任务状态机

```
pending ──(_consumeOne 取出)──→ running ──(_doAutoCollect 返回)──┐
   ↑                                                              │
   │              ┌───────────────────────────────────────────────┤
   │              ↓           ↓           ↓         ↓              ↓
   │          success     partial     skipped   antibot        failed/异常
   │              │          │          │         │              │
   │              │   attempts<2?       │         │       attempts<maxAttempts?
   │              │     ↓ no            │         │              ↓ no
   │              │  failed_retry       │         │        failed_final
   │              │  (nextRetryAt+30s)  │         │
   │              │     ↓               │         │
   │              └─── 回 pending ──────┘         │
   │                                              │
   └── failed_retry(回 pending)              antibot → failed_final + circuitBreakerUntil
```

**状态说明**:

| 状态 | 含义 | 终态? |
|---|---|---|
| `pending` | 待采集 | 否 |
| `running` | 采集中 | 否 |
| `success` | 8 类全部成功 | 是 |
| `partial` | 部分成功(有错误但非熔断) | 是(若 attempts≥2) |
| `skipped` | 跳过(all-cached/daily-limit/非中国/未分类) | 是(除 daily-limit 回 pending) |
| `antibot` | 触发反爬熔断 | 是(转 failed_final) |
| `failed_retry` | 失败待重试 | 否 |
| `failed_final` | 最终失败(attempts 达上限) | 是 |
| `failed_partial` | partial 达重试上限 | 是 |

**重试退避**:`[10000, 30000, 90000]`(10s/30s/90s,见 [SW 4331](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4331))。

**stale running 兜底**:`running` 超 5 分钟(`COLLECT_QUEUE_STALE_RUNNING_MS`)由 `_checkStaleRunningTasks` 转为 `failed_retry` 或 `failed_final`([SW 5127-5158](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L5127))。

**完成队列清理**:终态任务超过 500 条(`COLLECT_QUEUE_MAX_COMPLETED`)时按 `finishedAt` 升序删除最旧的([SW 4215-4230](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4215))。

### 2.4 8 类深度采集缓存

| 缓存 | IDB store | 写入源 | 用途 | TTL |
|---|---|---|---|---|
| **card** | `card_cache` | content `extractCardInfo()` → SW `cardCacheSet` handler | 商品卡 5 字段(sku/url/name/price/image + ratingCount),全览展示 + OPI 预览 fallback | 永久 |
| **detail** | `detail_cache` | content `extractProductData()` → SW `detailCacheSet` handler | 详情页 DOM 全字段(title/images/videos/characteristics/price/seller/statistics 等) | 永久 |
| **composer** | `composer_cache` | `fetchVariantMediaViaBuyerTab` 内部 | composer-api widgetStates 业务子集 | 永久 |
| **entrypoint** | `entrypoint_cache` | `fetchVariantMediaViaBuyerTab` 内部 | entrypoint-api 蒸馏的 {gallery, richContent, description, hashtags} | 永久 |
| **search** | `search_cache` | `_doAutoCollect` Step5 真调后写 | seller portal `/api/v1/search` 结果(items 数组,含物理 attrs merge) | 永久 |
| **bundle** | `bundle_cache` | `fetchBundleByVariantId` 内部 | seller portal `create-bundle-by-variant-id` 结果(重量/尺寸/条码等物理 attrs) | 永久 |
| **marketStats** | `market_stats_cache` | `_doAutoCollect` Step6 / `getMarketStats` handler | 市场统计(销量/评价/排名) | 24h stale |
| **followSell** | `follow_sell_cache` | `fetchVariantMediaViaBuyerTab` 内部 | 跟卖可用性/竞品数据 | 4h stale |

**两级缓存**:L1 = IndexedDB(本地),L2 = ERP MongoDB。`l2Synced` 标志驱动定时补写(`_idbScanUnsynced` 每 5 分钟扫描)。

**stale 策略**:`marketStats`/`followSell` stale 时仍返回记录(含 `stale:true`),不触发实际请求。

---

## 三、SW 采集队列核心机制

### 3.1 任务提交:`_handleSubmitTask`([SW 5306-5367](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L5306))

```
1. SKU 校验
2. 去重检查(_isTaskQueuedOrCompletedToday)
   └─ 已在队列或今日已完成 → 返回 {alreadyQueued: true}
3. 8 类缓存前置检查(_checkAllCachesHit)
   └─ 全命中 → 直接返回 success,不入队,不消耗 daily-limit
4. 入队(_enqueueTask)+ ERP 镜像(_erpQueueInsert)
5. 调度消费(_maybeStartConsume)
6. 暂停兜底广播(若队列应暂停 → _broadcastQueuePaused)
```

**8 类缓存前置检查** `_checkAllCachesHit`([SW 5243-5304](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L5243)):并行查 8 类缓存,search 走 L1→L2,bundle 仅 L1,marketStats/followSell 需未 stale。全命中时直接返回 `success` 并广播 `collectDone`,避免缓存命中任务占用 15s 队列 slot。

### 3.2 消费循环:`_consumeOne`([SW 4977-5074](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4977))

```
1. _consuming 防重入
2. keepAliveTimer(15s 唤醒防 SW 休眠)
3. 跨日重置(todayDate != today → 清 todayCount + consumePaused=false)
4. 熔断检查(Date.now() < circuitBreakerUntil → return)
5. 暂停分支:
   ├─ consumePaused=true 时 peek 下一个 pending
   ├─ 若 source='manual' → 重置 consumePaused=false 恢复消费
   └─ 否则广播 queuePaused 并 return
6. autoCollectRunning 检查(非 manual 任务才检查)
7. daily-limit 检查(todayCount >= perDayLimit → 暂停)
8. 取任务 → 更新 status='running' → _processTask
9. 更新 lastConsumeAt + (终态时 todayCount+1)
10. setTimeout(consumeRateSec*1000) → _consumeOne(调度下一个)
```

### 3.3 调度入口:`_maybeStartConsume`([SW 5076-5125](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L5076))

负责入队/Alarm 唤醒时的入口逻辑:

- **熔断期检查**:熔断中则广播 `queuePaused('antibot')` 并返回
- **跨日恢复**:`todayDate != today` → 重置 meta
- **熔断过期恢复**:`Date.now() >= circuitBreakerUntil` 且 `consumePaused=true` → 重置 `consumePaused=false`
- **间隔补足**:SW 被杀后 alarm 唤醒,若距上次消费不足 `consumeRateSec` 则 `setTimeout` 等待剩余时间

### 3.4 8 步采集编排:`_doAutoCollect`([SW 3672-4113](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3672))

| 步骤 | 行号 | 采集内容 | 数据来源 |
|---|---|---|---|
| **并发 slot 获取** | 3687-3700 | `_acquireAutoCollectSlot`,超时 60s 丢弃返回 `skipped` | — |
| **Gate 0 基础检查** | 3703-3733 | 跨日重置 / autoCollectRunning(manual 绕过) / paused / daily-limit | config + meta |
| **Gate 0.5 中国店铺** | 3735-3756 | `checkStoreClassification`,`onlyChineseStores` 开启时非中国店铺返回 `skipped` | ERP |
| **Step 1 并行查 8 类缓存** | 3758-3785 | `Promise.all` 查 card/detail/composer/entrypoint/marketStats/followSell | IDB + ERP |
| **Step 2 计算 pending** | 3787-3815 | `hasPending=false` → 返回 `skipped`(reason:`all-cached`) | — |
| **Step 4 买家页采集** | 3817-3874 | `fetchVariantMediaViaBuyerTab` 取 composer+entrypoint+followSell | www.ozon.ru tab |
| **Step 5 seller portal 采集** | 3876-4016 | `/api/v1/search` + `create-bundle-by-variant-id`,merge 物理 attrs 后重写 search_cache | seller.ozon.ru |
| **Step 6 seller portal marketStats** | 4018-4045 | `_fetchMarketStatsDirect` | seller.ozon.ru |
| **Step 7 写日志+计数** | 4047-4094 | `_pushAutoCollectRecent` + `_writeAutoCollectLog` + `_erpStoreSkuReport` | — |

**关键细节**:
- Step4/5/6 检测到 403/429/HTML 挑战页 → 抛 `ANTIBOT_BLOCKED` → 走 `_handleAntibot`
- Step5 bundle 返回后 merge 物理 attrs(4497/9454-9456/7822)进 items[0] 并**重写 search_cache**(修复 stale 数据 bug)
- Step6 失败不熔断(4043 注释),HTTP 200 即写缓存(含空数据)

### 3.5 反爬熔断:`_handleAntibot`([SW 3601-3624](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3601))

```
1. 设置 config.paused=true, pausedUntil=now+10min
2. 广播 antibotDetected 给 popup
3. 写 ERP 日志
4. 推送 _autoCollectRecent 环形缓冲
5. 返回 {status:'antibot', pausedUntil}
```

**注意**:`_handleAntibot` 只写 `config.paused/pausedUntil`;队列级 `circuitBreakerUntil` 由 `_processTask` 在 antibot 分支额外设置([SW 4948](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4948))。

---

## 四、限流与反爬机制

### 4.1 限速字段(默认值见 [SW 2620-2638](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L2620))

| 字段 | 默认值 | 含义与现状 |
|---|---|---|
| `buyerPageMinInterval` | `5000`(ms) | **历史遗留字段**,Phase 5 已移除 `_buyerPageGate` 显式调用,现仅保留兼容,无实际限流作用 |
| `sellerPortalMinInterval` | `200`(ms) | seller portal API 调用最小间隔。**注意**:实际闸门用硬编码常量 `SELLER_PORTAL_MIN_INTERVAL_MS=200`,配置项仅用于展示 |
| `consumeRateSec` | `15`(秒) | **核心限速字段**,队列串行消费间隔,范围 5-120 |
| `perDayLimit` | `2000` | 每日采集上限,`todayCount >= perDayLimit` 时暂停队列,跨日重置 |

> `skuInterval`(30000ms)为 v1 旧字段,已被 `consumeRateSec` 取代,迁移逻辑见 [SW 2649-2657](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L2649)。

### 4.2 全局并发 `_AUTO_COLLECT_MAX_CONCURRENT=3`([SW 3640-3670](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3640))

- 最多 3 个 SKU 同时采集(`_acquireAutoCollectSlot`)
- 排队超时 60s 丢弃返回 `skipped`
- 计数器在 SW 内存,非持久化(SW 休眠后清零,符合预期:重启=新一轮)
- `_doAutoCollect` 入口 acquire,`finally` 中 release

### 4.3 seller portal 闸门 `_sellerPortalGate`([SW 2599-2613](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L2599))

串行化链式闸门,所有 seller portal 出口(`/search`、`create-bundle-by-variant-id`、marketStats)共用,摊平请求密度防反爬。间隔 200ms。

### 4.4 熔断期缓存兜底

熔断期(`_isCircuitBreakerActive` 返回 `active:true`)各 API 行为:

| API | 熔断期行为 |
|---|---|
| `getMarketStats` | 只查 cache,有 stale 缓存返回 stale 兜底,无缓存返回 `{__antibot:true, __reason:'CIRCUIT_BREAKER'}` |
| `transferVariantVideo` | 传 `cacheOnly:true` 查缓存,有 mp4 返回 cache 富内容 + `url:null`(不执行转存) |
| `fetchVariantRichContent` | 传 `cacheOnly:true` 返回富内容/描述/标签 |
| `searchVariants` | 返回 antibot 错误(Step1 `/search` 无缓存无法跳过) |
| `transferVideoToOzon` | 返回失败(已被 `transferVariantVideo` 提前拦截) |

---

## 五、采集页面

### 5.1 深度采集管理页(collect-manager)

**文件**:[collect/pages/manager/index.js](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/manager/index.js)

**提交流程** `startCollect`([L376-418](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/manager/index.js#L376)):
1. `applyFilters(allSkus)` 获取筛选后所有 SKU
2. 串行 `await sendMessage('submitTask', {source:'manual'})` 逐个提交
3. `source='manual'` 让 SW Gate 0 绕过 `autoCollectRunning` 检查

**进度统计** `updateProgress`([L421-494](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/manager/index.js#L421)):
- 分子:遍历 `submittedSkus` 统计本次提交中终态任务数
- 分母:`submittedSkus.size`(本次提交总数)
- 5s 轮询 `getCollectManagerState` 获取队列状态

**广播处理**:完全忽略 `queuePaused`/`queueResumed`/`antibotDetected` 广播(避免批量提交时 N 次广播风暴),暂停状态统一由 5s 轮询获取。

### 5.2 采集队列监控页(collect-queue)

**文件**:[collect/pages/queue/index.js](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/queue/index.js)

**功能**:
- **5s 轮询** `getCollectManagerState` 展示队列实时状态
- **1s 倒计时** 独立定时器渲染下次执行时间([L271-293](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/queue/index.js#L271))
- **强制清除反爬状态** 调用 SW `clearAntibotState` handler
- **清空已完成** 调用 SW `clearFinishedQueueTasks` handler

**倒计时规则**([L250-267](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/queue/index.js#L250)):
- 熔断中 → 倒计时到 `circuitBreakerUntil`
- 有 pending 且未暂停/未达上限 → 倒计时到 `lastConsumeAt + consumeRateSec*1000`
- 已过预计时间 → 显示"即将执行"
- 暂停/达上限/无 pending → 显示"—"

---

## 六、content 端采集逻辑

### 6.1 collectGate 门控机制([ozon-data-panel.js L48-108](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js#L48))

**问题**:IntersectionObserver(≈200ms 触发)与 sellerSlug(≈500ms~15s 就绪)存在竞态。

**方案**:SKU 先入 `_pendingSkus` 队列,等 `collectGate`(sellerInfo + 分类结果)就绪后批量 flush。panel 渲染零阻塞,只有采集提交被 gate 门控。

- 店铺页 `/seller/*`:等 sellerInfo 到达后 resolve gate
- 非店铺页:立即 resolve(放行)
- 5s 超时降级:按空 slug 提交

### 6.2 `__jzSubmitCollectTask`([shared-utils.js L3961-4017](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L3961))

```
1. _autoCollectSeen 去重(同会话不重复提交)
2. 检查 autoCollectRunning 总开关
3. onlyChineseStores 开启时检查店铺分类(非中国永久跳过,未分类本次跳过)
4. 提取 domInfo → sendMessage('submitTask', {sku, sellerSlug, sellerId, domInfo})
5. 加入 _autoCollectSeen
```

**注意**:content 端 `submitTask` **不传 `source`**,SW `_handleSubmitTask` 中 `source` 为 undefined 时默认 `'shop-page'`,故店铺页/搜索页/详情页任务均为 `shop-page` 类型。

### 6.3 店铺页轻量采集落地情况

> **决策未落地**:原计划"详情页/搜索页自动采集改为仅上传 card 缓存,深度采集统一由专门页面处理",但实际代码中店铺页/搜索页/详情页仍通过 `__jzSubmitCollectTask` 提交完整 8 类采集任务到 SW 队列。

当前行为(以 [ozon-data-panel.js L813-839](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js#L813) 为例):
1. **写 card 缓存**:`sendMessage('cardCacheSet', {...})`,fire-and-forget
2. **仍提交完整采集任务**:`__jzSubmitCollectTask` → `submitTask`(默认 `source='shop-page'`)

card 缓存写入是采集流程的额外补充(供数据面板/OPI 预览 fallback),并非替代深度采集。

---

## 七、配置与广播

### 7.1 配置项

存储位置:`chrome.storage.local['jz-auto-collect-config']`

```javascript
{
  autoCollectRunning: true,        // 总开关
  onlyChineseStores: false,        // 仅采集中国店铺
  buyerPageMinInterval: 5000,      // 历史遗留(无实际作用)
  sellerPortalMinInterval: 200,    // 展示用(实际用硬编码常量)
  consumeRateSec: 15,              // 核心限速(5-120 秒)
  perDayLimit: 2000,               // 每日上限
  marketStatsStaleMs: 86400000,    // marketStats stale 阈值(24h)
  followSellStaleMs: 14400000,     // followSell stale 阈值(4h)
  paused: false,                   // 熔断暂停标志
  pausedUntil: 0,                  // 熔断到期时间
}
```

**配置缓存失效**:`_autoCollectConfigCache` 内存缓存,`chrome.storage.onChanged` 监听 `jz-auto-collect-config` 变化时自动 invalidate([SW 2672-2677](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L2672))。

### 7.2 广播消息

| 消息类型 | 发送方 | 接收方 | 用途 |
|---|---|---|---|
| `collectDone` | SW `_broadcastCollectDoneV2` | Ozon tabs + collect-manager tabs | 单 SKU 采集完成 |
| `taskStatus` | SW `_broadcastTaskStatus` | Ozon tabs + collect-manager tabs | 任务中间态(pending/running/failed_retry) |
| `queuePaused` | SW `_broadcastQueuePaused` | **仅 Ozon tabs**(不发 collect-manager) | 队列暂停,防 AutoScroller 死锁 |
| `queueResumed` | SW `_broadcastQueueResumed` | **仅 Ozon tabs**(不发 collect-manager) | 队列恢复 |
| `antibotDetected` | SW `_handleAntibot` | popup | 熔断触发,重渲状态 |
| `configChanged` | SW `autoCollectSetConfig` | popup | 配置变化 |
| `__jzAutoCollectResetSeen` | SW | content tabs | 清空去重集合(rescan 时) |

**关键约束**:`queuePaused`/`queueResumed` 不发给 collect-manager(无 AutoScroller 不会死锁,且批量提交时 N 次广播会风暴)。collect-manager 的暂停状态完全由 5s 轮询 `getCollectManagerState` 获取。

---

## 八、SW action 路由清单(采集相关)

| action | 用途 |
|---|---|
| `submitTask` | 提交采集任务到队列 |
| `getCollectManagerState` | 查询队列状态(running/pending/finished/tasks) |
| `removeQueueTask` | 删除单个队列任务 |
| `clearFinishedQueueTasks` | 清空已完成任务 |
| `clearAntibotState` | 强制清除反爬熔断状态 |
| `registerCollectManager` / `unregisterCollectManager` | 注册/注销 collect-manager tab |
| `cardCacheSet` / `detailCacheSet` | 写 card/detail 缓存 |
| `autoCollectGetConfig` / `autoCollectSetConfig` | 读/写采集配置 |
| `autoCollectGetRecent` | 读取最近 N 条采集记录(环形缓冲) |
| `autoCollectForceRefreshPage` | 强制刷新页面(rescan) |
| `getQueueStatus` | content 启动时查询队列状态(防时序竞态) |
| `queryErpProductData` | 查询单 SKU 的 ERP 数据(三级回退) |

---

## 九、已知决策未落地项

以下决策已记录但代码中尚未落地,开发时请注意:

1. **决策 A:详情页/搜索页改为仅上传 card 缓存**
   - 现状:店铺页/搜索页/详情页仍通过 `__jzSubmitCollectTask` 提交完整 8 类采集任务
   - 影响:[ozon-search.js L245-248](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L245)、[ozon-data-panel.js L836-839](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js#L836)
   - 落地方式:移除 `__jzSubmitCollectTask` 调用,保留 `cardCacheSet`

2. **决策 B:深度采集店铺列表仅限中国店铺,筛选条件简化为评论数范围 + 价格范围**
   - 现状:[collect/pages/manager/index.html L132-162](file:///c:/root/code/ozon-my/qx-ozon/collect/pages/manager/index.html#L132) 仍保留重量筛选和采集状态筛选
   - 落地方式:移除 `f-weight-min/max`、`f-status` 相关 HTML 和 JS 引用

3. **`skuInterval` 旧字段清理**
   - 现状:defaults 中仍保留 `skuInterval: 30000`,迁移逻辑仍在
   - 落地方式:确认无旧版本用户数据需迁移后,删除字段和迁移代码

---

## 十、相关文档

- [SELLER_PROTOTYPE_API.md](./SELLER_PROTOTYPE_API.md) — seller.ozon.ru 门户接口使用说明(跟卖流程)
