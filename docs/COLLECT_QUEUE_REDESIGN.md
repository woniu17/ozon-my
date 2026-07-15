# 采集队列重构设计文档

> 状态:已实施 v3(实施后评审有待修 P0/P1,见 §十七)
> 日期:2026-07-14
> 范围:qx-ozon 扩展自动采集架构重构

## 决策记录(v2 确认)

| # | 决策点 | 最终选择 |
|---|---|---|
| 疑点 1 | chrome.storage.local 写入竞态 | SW 侧加内存锁(`_queueWriteLock`),写入串行化(见 §3.6) |
| 疑点 2 | chrome.storage.local 配额 | **C: 不存 result**,只存状态;result 只写 ERP;配额约 2.5MB/5000 任务,安全 |
| 疑点 3 | ERP ops 轮询延迟 | A: 接受 5 秒延迟 |
| 疑点 4 | alarm 1 分钟空窗 | A: 接受 |
| 疑点 5 | 广播数据量 | **A: 广播发完整数据(见 §8 详解)** |
| 疑点 6 | 中国卖家筛选 | A: 保持现有机制,提取不到不采集 |
| 疑点 7 | 消费速率配置同步 | 新队列架构下只保留 `consumeRateSec`(秒,5-120) 和 `perDayLimit`;popup 已移除买家页/卖家后台间隔配置 |
| 疑点 8 | 过渡策略 | A: 一次性切换,删除旧 `autoCollect` handler |
| 疑点 9 | SW 重启恢复 | SW 启动时扫描所有 running 任务重置为 failed_retry |
| 疑点 10 | 前端去重 | 前端保留 `_autoCollectSeen` + SW 侧权威去重 |

## 一、目标与背景

### 现状问题
- 数据卡填充与采集交织,前端要先 fetch marketStats 才能筛选,采集被阻塞
- 自动翻页等队列空闲,翻页速度被采集速度拖累
- SW 侧无持久化队列,并发风暴靠 burst 限流临时挡
- 筛选依赖 panel DOM 数据,无法在 SKU 提交时做

### 新架构目标
- **前端只做 SKU 收集**:商品卡进视口 → DOM 提取 → 前端筛选 → 提交任务
- **SW 维护持久化队列**:chrome.storage.local 主存储 + ERP MongoDB 镜像
- **翻页与采集完全解耦**:翻页全速收集 SKU,不等采集
- **采集结果双通道回传**:SW 广播(即时) + ERP 查询(兜底)

---

## 二、架构总览

```
[商品卡进视口] → IntersectionObserver
  ↓
前端:DOM 提取(标题/价格/图片URL/评价数) + 前端筛选(价格/中国卖家/有评价)
  ↓
submitTask(sku, sellerSlug, sellerId, domInfo) → sendMessage('submitTask')
  ↓
SW:去重检查(队列 + 已采集集合) → 入队(chrome.storage.local + ERP 双写)
  ↓
SW 队列消费者(每 X 秒消费一个,X 由 popup 配置 5-120 秒) → _doAutoCollect 串行 8 步
  ↓
采集完成:
  ├─ 通道 1:SW 广播(collectDone with full data)→ 前端数据卡即时回填 + 徽章更新
  └─ 通道 2:写 ERP MongoDB(持久化)→ ERP 队列管理页 + 前端异步查询兜底
  ↓ 同时(独立通道)
前端数据卡:进视口时异步从 ERP 查 marketStats(不阻塞采集)
```

### 关键解耦点

| 解耦 | 说明 |
|---|---|
| 翻页 ↔ 采集 | 翻页只收集 SKU 提交任务,不等采集完成 |
| 提交 ↔ 消费 | 前端提交后立即返回,SW 按自己的节奏消费 |
| 数据卡 ↔ 采集 | 数据卡从 ERP 异步查(双触发:进视口 + 收到广播),不阻塞采集流程 |
| 队列存储 ↔ ERP | chrome.storage.local 是主(SW 消费用),ERP 是镜像(管理页查 + 操作回写) |

---

## 三、队列存储设计(详细)

### 3.1 双写策略

```
前端提交任务 → SW
  ↓
SW 双写:
  ├─ ① chrome.storage.local 入队(主存储,消费者直接读)
  └─ ② ERP MongoDB 插入(镜像,ERP 管理页查询用)
  ↓
SW 消费 → 状态变化 → 双写更新:
  ├─ ① chrome.storage.local 更新任务状态
  └─ ② ERP MongoDB 更新任务状态
  ↓
采集完成:
  ├─ ① chrome.storage.local 标记 success
  ├─ ② ERP 写采集结果(完整 8 步数据)
  └─ ③ 广播给前端
```

**谁是主?**
- **chrome.storage.local 是主**:SW 消费者直接读它,低延迟,不依赖网络
- **ERP 是镜像**:只供 ERP 队列管理页查询 + 接收操作指令,SW 不依赖它
- **ERP 写失败不影响采集**:chrome.storage.local 已是真相源,ERP 写失败只记 warn 日志

### 3.2 chrome.storage.local 数据结构

> **v2 变更(疑点 2 决策)**:不存 `result` 字段,只存状态 + 元数据。result 只写 ERP。配额约 2.5MB/5000 任务,安全。

```js
// Key: jz-collect-queue(单 key 存数组)
// 值:任务数组,每个任务结构如下(无 result 字段,大幅缩小体积)
{
  // 标识
  sku: '5030959599',
  sellerSlug: 'youqulin',
  sellerId: '12345',

  // 前端 DOM 提取的基础信息(提交时携带)
  domInfo: {
    title: '...',
    price: 1990,
    imageUrl: 'https://...',
    ratingCount: 42,
  },

  // 状态机
  status: 'pending',        // pending|running|failed_retry|failed_final|failed_partial|success
  attempts: 0,              // 已尝试次数
  maxAttempts: 3,           // 按错误类型动态设置
  nextRetryAt: 0,           // 0=立即可消费,>0=退避到此时间戳

  // 错误信息
  lastError: null,          // { type, message, step, ts }

  // 采集步骤状态(轻量,不含实际数据)
  steps: null,              // { card:'ok', detail:'ok', composer:'fail', ... }

  // 时间戳
  createdAt: Date.now(),
  startedAt: null,
  finishedAt: null,
}
// 注意:无 result 字段!采集结果只写 ERP MongoDB。
// 前端需要数据时,通过 SW 广播(采集完成时)或查 ERP(兜底)获取。

// Key: jz-collect-queue-meta(队列元数据)
{
  consuming: false,              // 是否正在消费
  circuitBreakerUntil: 0,        // 反爬熔断截止时间戳
  consumeRateSec: 15,            // 消费速率(秒/任务,从 popup 配置同步)
  consumePaused: false,          // 手动暂停消费(ERP 操作)
  lastConsumeAt: 0,             // 上次消费时间戳
  todayCount: 0,                // 今日已处理数
  todayDate: '',                // 今日日期(YYYY-MM-DD,跨日重置)
}
```

### 3.3 ERP MongoDB 数据结构

#### 集合 1:collect_queue_tasks(任务镜像)

```js
{
  _id: ObjectId(...),
  // 标识
  sku: '5030959599',
  sellerSlug: 'youqulin',
  sellerId: '12345',

  // DOM 信息
  domInfo: { title, price, imageUrl, ratingCount },

  // 状态(与 chrome.storage.local 同步)
  status: 'pending',
  attempts: 0,
  maxAttempts: 3,
  nextRetryAt: null,

  // 错误
  lastError: null,

  // 采集结果(完成后填)
  result: null,
  steps: null,

  // 时间戳
  createdAt: Date.now(),
  startedAt: null,
  finishedAt: null,

  // ERP 专用
  updatedAt: Date.now(),        // 每次更新刷新
}
// 索引:{ sku: 1 }(唯一),{ status: 1, nextRetryAt: 1 }(消费查询),{ createdAt: -1 }(列表)
```

#### 集合 2:collect_queue_ops(操作指令)

```js
{
  _id: ObjectId(...),
  op: 'retry',                  // retry|delete|pause|resume|clear
  sku: '5030959599',            // 操作目标(retry/delete 用),pause/resume/clear 为 null
  params: {},                   // 附加参数
  ts: Date.now(),               // 操作发起时间
  processed: false,             // SW 是否已处理
  processedAt: null,            // SW 处理时间
}
// 索引:{ processed: 1, ts: 1 }
```

### 3.4 双写一致性保障

**写入流程**(任务入队):
```
1. SW 收到 submitTask 消息
2. 去重检查(查 chrome.storage.local 队列 + 已采集集合)
3. 写 chrome.storage.local(jz-collect-queue 数组 append)
4. 异步写 ERP(collect_queue_tasks insert)
5. 启动消费循环(如未启动)
```

**更新流程**(状态变化):
```
1. SW 消费任务,状态变化(pending → running → success)
2. 更新 chrome.storage.local(找到对应 sku 的任务,更新字段)
3. 异步更新 ERP(collect_queue_tasks update by sku)
4. 采集完成时,额外写采集结果到 ERP
```

**ERP 操作回写 SW**:
```
1. ERP 管理页用户点"重试" → 写 collect_queue_ops { op:'retry', sku, processed:false }
2. SW 每 5 秒轮询 collect_queue_ops(processed=false 的)
3. SW 执行操作:
   - retry: chrome.storage.local 更新任务 status=pending, attempts=0, nextRetryAt=0
   - delete: chrome.storage.local 移除任务
   - pause: chrome.storage.local 更新 meta.consumePaused=true
   - resume: chrome.storage.local 更新 meta.consumePaused=false
   - clear: chrome.storage.local 清空所有 pending 任务
4. SW 标记 op 为 processed=true
```

### 3.5 chrome.storage.local 配额风险

> **v2 更新**:已选"不存 result"方案,配额风险大幅降低。

- chrome.storage.local 默认 10MB(可申请 unlimitedStorage 权限解除)
- **不存 result**:单任务约 500 字节,5000 个任务 ≈ 2.5MB,**安全在配额内**
- **不保留已完成任务过久**:success/failed_final 任务在 chrome.storage.local 中保留最近 500 个(ERP 已持久化),更早的定期清理
- **结论**:无需 `unlimitedStorage` 权限

### 3.6 chrome.storage.local 写入竞态(疑点 1 决策)

**问题澄清**:`chrome.runtime.onMessage` 回调是串行入队的,但回调内部的 `await getStorage()` 会让出执行权,期间下一个 `onMessage` 回调可以开始执行。两个回调都在做 `getStorage → 修改 → setStorage` 时可能交叉,导致后写入覆盖先写入(任务丢失)。

```
回调 A: getStorage([])  → 拿到 queue=[t1]
回调 B: getStorage([])  → 拿到 queue=[t1]  (A 还没 setStorage)
回调 A: setStorage([t1, t2])
回调 B: setStorage([t1, t3])  ← t2 丢了
```

**方案**:SW 侧加内存锁,所有队列写入操作串行化。

```js
let _queueWriteLock = Promise.resolve();

// 所有队列写入操作通过此函数串行化
function _withQueueLock(fn) {
  const prev = _queueWriteLock;
  let release;
  _queueWriteLock = new Promise((r) => { release = r; });
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

// 使用示例:入队
async function _enqueueTask(task) {
  return _withQueueLock(async () => {
    const queue = (await getStorage(['jz-collect-queue']))['jz-collect-queue'] || [];
    queue.push(task);
    await setStorage({ 'jz-collect-queue': queue });
  });
}

// 使用示例:更新任务状态
async function _updateTaskStatus(sku, updates) {
  return _withQueueLock(async () => {
    const queue = (await getStorage(['jz-collect-queue']))['jz-collect-queue'] || [];
    const task = queue.find((t) => t.sku === sku);
    if (task) Object.assign(task, updates);
    await setStorage({ 'jz-collect-queue': queue });
  });
}
```

**保障**:所有队列读写操作(入队/更新/删除/清理)都走 `_withQueueLock`,彻底消除竞态。读取(消费者 `_getNextPending`)无需加锁,因为只有单消费者。

**性能**:锁是串行的 Promise 链,每次操作约 5-10ms(单次 storage 读写),高并发提交时队列等待可接受。

---

## 四、SW 保活机制(详细)

### 4.1 MV3 SW 生命周期问题

```
SW 活跃条件:
  - 有 active message handler 在执行
  - 有 pending setTimeout / setInterval
  - 有 pending fetch / chrome API 调用

SW 被杀条件:
  - 空闲 30 秒(无上述活跃条件)
  - Chrome 110+ 强制 5 分钟上限(即使有 active timer 也会被杀)
  - 浏览器内存压力
```

### 4.2 保活链路设计

```
[任务入队]
  ↓
SW _onTaskSubmitted() → 检查是否正在消费 → 启动 _consumeOne()
  ↓
[消费一个任务]
  - keepAlive 定时器(15s,现有机制,每 15s 重置)
  - _doAutoCollect 串行 8 步(耗时 10-60s)
  ↓
[消费完一个]
  - 更新状态(双写 chrome.storage.local + ERP)
  - setTimeout(_consumeOne, consumeRateSec * 1000)
  - 此时 SW 因 setTimeout pending 而保持活跃
  ↓
[下次消费时间到]
  - _consumeOne() 执行
  - 循环继续...
  ↓
[SW 被杀的几种情况]
  情况 A:队列空了,无 setTimeout,SW 空闲 30 秒被杀
    → 新任务入队时,onMessage 唤醒 SW → _onTaskSubmitted() → 重启消费
    → 或 alarm 唤醒 → _maybeStartConsume() → 发现队列空,不启动

  情况 B:SW 运行超过 5 分钟被 Chrome 强制杀死
    → alarm 触发(最迟 1 分钟后)→ 唤醒 SW → _maybeStartConsume() → 重启消费

  情况 C:浏览器内存压力杀死 SW
    → 同情况 B,alarm 兜底
```

### 4.3 alarm 兜底设计

```js
const COLLECT_QUEUE_ALARM = 'collect-queue-consume';

// 注册 alarm(1 分钟周期)
chrome.alarms.create(COLLECT_QUEUE_ALARM, {
  periodInMinutes: 1,
});

// alarm 监听
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COLLECT_QUEUE_ALARM) {
    _maybeStartConsume();
  }
});

// alarm 唤醒后检查是否需要启动消费
async function _maybeStartConsume() {
  // 防重入
  if (_consuming) return;

  // 检查熔断
  const meta = await _loadQueueMeta();
  if (Date.now() < meta.circuitBreakerUntil) {
    console.log('[Queue] alarm: in circuit breaker, skip');
    return;
  }

  // 检查手动暂停
  if (meta.consumePaused) {
    console.log('[Queue] alarm: paused, skip');
    return;
  }

  // 检查队列是否有可消费任务
  const queue = await _loadQueue();
  const hasPending = queue.some(
    (t) => t.status === 'pending' && (!t.nextRetryAt || t.nextRetryAt <= Date.now())
  );
  if (hasPending) {
    _consumeOne();
  }
}
```

### 4.4 消费循环实现

```js
let _consuming = false;

// 每次只消费一个任务,然后 setTimeout 安排下一个
async function _consumeOne() {
  if (_consuming) return;
  _consuming = true;

  try {
    // 检查熔断
    const meta = await _loadQueueMeta();
    if (Date.now() < meta.circuitBreakerUntil) {
      console.log('[Queue] circuit breaker active, skip');
      return;
    }
    if (meta.consumePaused) {
      console.log('[Queue] paused, skip');
      return;
    }

    // 取下一个可消费任务
    const task = await _getNextPending();
    if (!task) {
      console.log('[Queue] no pending task, stop loop');
      return; // 队列空,不安排下次,等新任务或 alarm 唤醒
    }

    // 消费
    await _processTask(task);

    // 安排下次消费
    const rateSec = (await _loadQueueMeta()).consumeRateSec;
    setTimeout(() => {
      _consuming = false;
      _consumeOne();
    }, rateSec * 1000);
    // 注意:_consuming 保持 true,防止 alarm 期间重入
    // 在 setTimeout 回调中才重置为 false
  } catch (e) {
    console.error('[Queue] consume error:', e);
    _consuming = false;
    // 出错后 10 秒重试
    setTimeout(() => _consumeOne(), 10000);
  }
}
```

### 4.5 消费速率与 SW 生命周期的关系

| 消费速率 | SW 正常保活 | SW 被杀后恢复 |
|---|---|---|
| 5 秒 | setTimeout 5s 保活,持续消费 | alarm 最迟 1 分钟唤醒,空窗 ≤1 分钟 |
| 15 秒 | setTimeout 15s 保活 | alarm 最迟 1 分钟唤醒 |
| 60 秒 | setTimeout 60s 保活 | alarm 1 分钟唤醒,几乎无空窗 |
| 120 秒 | setTimeout 120s 保活,但 SW 可能 30s 空闲被杀 | alarm 1 分钟唤醒,空窗 ≤1 分钟 |

**关键结论**:消费速率 >30 秒时,setTimeout 期间 SW 可能因 30 秒空闲规则被杀,但 alarm 兜底确保最迟 1 分钟恢复。**最坏情况空窗 ≤1 分钟,可接受。**

### 4.6 SW 5 分钟强制杀死处理

Chrome 110+ 对 MV3 SW 有 5 分钟硬性生命周期上限,即使有 active timer 也会被杀。

**影响场景**:单个任务采集耗时 >5 分钟(罕见,通常 10-60 秒)或连续消费累积 >5 分钟。

**处理**:alarm 兜底,SW 被杀后最迟 1 分钟唤醒,检查 `_consuming` 标志(已随 SW 死亡重置),重启消费循环。当前任务的 `startedAt` 可判断是否"卡在 running",超过 5 分钟的任务标记为 `failed_retry`。

```js
// alarm 唤醒时检查是否有"卡死"的 running 任务
async function _checkStaleRunningTasks() {
  const queue = await _loadQueue();
  const now = Date.now();
  for (const task of queue) {
    if (task.status === 'running' && task.startedAt && now - task.startedAt > 5 * 60 * 1000) {
      // 卡死超过 5 分钟,标记为 failed_retry
      task.status = 'failed_retry';
      task.attempts++;
      task.nextRetryAt = now + 30000; // 30s 后重试
      task.lastError = { type: 'timeout', message: 'SW killed, task stale', step: 'unknown', ts: now };
      await _updateQueueTask(task);
    }
  }
}
```

---

## 五、中国卖家筛选机制

### 5.1 筛选流程

```
商品卡进视口 → DOM 提取(sellerSlug + sellerId)
  ↓
前端提交任务前:检查 onlyChineseStores 配置
  ↓ 开启
查中国卖家状态(三层查询):
  L1: chrome.storage.local(jz-store-class-<slug>) — 热缓存
    ↓ 命中(有 isChinese 值)
    通过/拒绝
  L2: ERP MongoDB(/admin/api/store-classification/:slug) — 持久化
    ↓ 命中
    通过/拒绝
  L3: 无缓存,需实时判断
    ↓
    从页面获取 sellerId(MAIN world seller-info-main.js 已提取)
    ↓
    请求第一个 SKU 的商品页(ensureBuyerTab → fetch)
    ↓
    从页面 __NUXT__ 提取店铺信息(country/companyName)
    ↓
    规则引擎判断(country=CN → 中国)
    ↓
    店铺信息缺失(country 为空/页面无数据) → 不采集
    ↓
    写 L1 + L2 缓存
```

### 5.2 与现有机制的关系

现有 `checkStoreClassification`(service-worker.js:2670)已实现 L1+L2+规则引擎,新架构复用此函数。变化点:

| 现有 | 新架构 |
|---|---|
| 在 `_doAutoCollect` 内部调用(SW 侧) | 在前端提交任务前调用(SW 侧,通过新 action `checkStoreClass`) |
| 查不到返回 null,放行采集(等人工确认) | 查不到**不采集**(用户明确要求) |
| companyInfo 由 seller-info-main.js 提取后传入 | 同上,前端通过 jz-seller-info 事件拿到 sellerId |

### 5.3 前端调用流程

```js
// 前端提交任务前
async function submitTask(sku, card, sellerSlug, sellerId) {
  // 检查 onlyChineseStores
  const config = await _getConfig();
  if (config.onlyChineseStores && sellerSlug) {
    const result = await sendMessage('checkStoreClass', { slug: sellerSlug, sellerId });
    if (result.isChinese === false) {
      console.log('[submit] skip non-chinese store:', sellerSlug);
      return; // 非中国,跳过
    }
    if (result.isChinese === null) {
      // 店铺信息缺失,不采集
      console.log('[submit] skip unknown store (no info):', sellerSlug);
      return;
    }
    // isChinese === true,继续提交
  }

  // DOM 提取
  const domInfo = _extractDomInfo(card);

  // 提交任务
  await sendMessage('submitTask', {
    sku,
    sellerSlug,
    sellerId,
    domInfo,
  });
}
```

---

## 六、前端数据卡回填(双触发)

### 6.1 触发机制

| 触发 | 时机 | 数据来源 |
|---|---|---|
| 触发 1 | 商品卡进视口(IntersectionObserver) | ERP 异步查询(marketStats) |
| 触发 2 | 收到 SW collectDone 广播 | 广播数据(完整 8 步结果) |

### 6.2 触发 1:进视口查 ERP

```js
// 商品卡进视口时(独立于提交任务)
async function loadPanelData(card, panel) {
  const sku = _extractSku(card);
  // 1. 提交采集任务(不等返回)
  submitTask(sku, card, sellerSlug, sellerId);
  // 2. 异步查 ERP 回填数据卡(不阻塞采集)
  try {
    const data = await sendMessage('queryErpMarketStats', { sku });
    if (data) {
      window.jzRenderProductCardPanel(panel, data);
    }
  } catch (e) {
    console.warn('[panel] ERP query failed:', e);
  }
}
```

### 6.3 触发 2:收到广播回填

```js
// 收到 SW 广播
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'collectDone' && msg.sku) {
    const panel = document.querySelector(`[data-jz-sku="${msg.sku}"] .jz-data-panel`);
    if (panel && msg.data) {
      // 用广播的完整数据回填
      window.jzPopulatePanelV2(panel, msg.sku, { preFetched: msg.data });
      // 更新徽章
      _updateBadge(msg.sku, msg.status);
    }
  }
});
```

### 6.4 广播范围(用户决策)

```
只广播给:
  - https://www.ozon.ru/seller/*
  - https://www.ozon.ru/product/*
```

```js
// SW 广播
async function _broadcastCollectDone(sku, status, data) {
  const tabs = await chrome.tabs.query({
    url: ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'],
  });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'collectDone',
      sku,
      status,
      data,
    }).catch(() => {}); // 单 tab 失败不影响
  }
}
```

---

## 七、失败重试机制

### 7.1 错误分类与重试策略

| 错误类型 | 识别特征 | 重试次数 | 退避策略 | 终态 |
|---|---|---|---|---|
| 反爬熔断 `ANTIBOT_BLOCKED` | HTTP 403/429 / `_handleAntibot` | 0 次 | 不重试 | `failed_final` + 全局熔断 10 分钟 |
| 网络抖动 | fetch NetworkError / HTTP 5xx | 3 次 | 10s→30s→90s | `failed_final` |
| 商品不存在 | HTTP 404 / EMPTY_CONTENT | 0 次 | 不重试 | `failed_final` |
| 部分失败 | 8 步中部分成功部分失败 | 2 次 | 固定 30s | `failed_partial` |
| SW 内部错误 | handler crash | 1 次 | 5s | `failed_final` |

### 7.2 重试任务调度

重试任务不立即放回 pending,而是带 `nextRetryAt` 时间戳,消费者跳过未到时间的任务。

```js
// 消费者取下一个可消费任务
async function _getNextPending() {
  const queue = await _loadQueue();
  const now = Date.now();
  return queue.find(
    (t) => t.status === 'pending' && (!t.nextRetryAt || t.nextRetryAt <= now)
  );
}
```

### 7.3 反爬熔断全局影响

```
触发 ANTIBOT_BLOCKED
  ↓
1. 当前任务标记 failed_final(不重试)
2. 设 meta.circuitBreakerUntil = now + 10 * 60 * 1000
3. 消费者循环检查 circuitBreakerUntil,熔断期内跳过所有消费
4. 前端徽章全局显示"反爬熔断"
5. 10 分钟后自动恢复
```

---

## 八、采集结果回传

### 8.1 数据卡需要什么数据(数据流分析)

**前端数据卡渲染函数**(`jzPopulatePanelV2` / `jzRenderProductCardPanel`)需要的 4 路数据:

| 数据源 | SW action | 关键字段 | 用途 |
|---|---|---|---|
| **stats**(后端 product-data) | `getProductStats` | categoryL1/L3, brand, rating, reviewCount, sales30d, revenue30dRub, dailyRevenue, dailySales, priceRub, commission 三档 | 分类/品牌/评分/销量/营收/佣金 |
| **market**(marketStats) | `getMarketStats` | gmvSum(月营收), soldCount(月销量), createDate, weightG, lengthMm/widthMm/heightMm | 月销量/月营收/上架时间/体积重量 |
| **variant**(searchVariants) | `searchVariants` | 变体列表 | 变体信息 |
| **followCount** | `jzFetchPublicFollowSellCount` | followSellCount | 跟卖卖家数 |

**关键发现**:当前 `_doAutoCollect` 返回的 `{ status, results, totalDuration }` 中,`results` 只是 8 步的元数据(hit/error 标志),**不含实际业务数据**。实际数据分散在 SW 的各 cache 和 ERP 后端中。

### 8.2 广播数据精简方案(v2 决策)

**决策**:广播发**完整数据**(前端直接渲染,无需再查 ERP)。

**理由**:
- chrome.storage.local 已不存 result(疑点 2 决策),SW 采集完成后数据只在内存中短暂存在
- 如果广播只发信号,前端需要再发 `getProductStats`/`getMarketStats` 等 4 个查询给 SW,增加消息开销
- 广播发完整数据,前端直接 `jzPopulatePanelV2` 渲染,零额外查询

**广播数据结构**:

```js
{
  type: 'collectDone',
  sku: '5030959599',
  sellerSlug: 'youqulin',
  status: 'success',           // success|failed_partial|failed_final
  // 完整数据(前端 jzPopulatePanelV2 可直接用)
  data: {
    // 对齐 preFetched 结构,前端 jzPopulatePanelV2 的 info.preFetched 路径直接消费
    stats: { status: 'fulfilled', value: { categoryL1, brand, rating, ... } },
    market: { status: 'fulfilled', value: { gmvSum, soldCount, createDate, ... } },
    variant: { status: 'fulfilled', value: { ... } },
    followCount: { status: 'fulfilled', value: { followSellCount: 42 } },
  },
  // 采集元数据
  collectedAt: 1690000000000,
  duration: 8420,              // 总耗时 ms
  steps: { card:'ok', detail:'ok', composer:'fail', ... },
  error: null,                 // 失败时填 { type, message, step }
}
```

**前端接收**(直接走 preFetched 路径):

```js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'collectDone' && msg.sku) {
    const panel = document.querySelector(`[data-jz-sku="${msg.sku}"] .jz-data-panel`);
    if (panel && msg.data) {
      // 直接用广播数据渲染,零 ERP 查询
      window.jzPopulatePanelV2(panel, msg.sku, { preFetched: msg.data });
      _updateBadge(msg.sku, msg.status);
    }
  }
});
```

### 8.3 SW 如何构造广播数据

`_doAutoCollect` 内部已经 fetch 了 4 路数据,在写 cache / ERP 后,顺手构造广播 payload:

```js
// SW 侧,采集完成后(在 _doAutoCollect 的 Step 7 之后)
async function _broadcastCollectDone(sku, sellerSlug, status, collectedData) {
  const payload = {
    type: 'collectDone',
    sku,
    sellerSlug,
    status,
    data: collectedData,     // 4 路数据的 { status, value } SettledResult 格式
    collectedAt: Date.now(),
    duration: totalDuration,
    steps,
    error: hasError ? lastError : null,
  };

  // 广播给 seller/* 和 product/* 页面
  const tabs = await chrome.tabs.query({
    url: ['https://www.ozon.ru/seller/*', 'https://www.ozon.ru/product/*'],
  });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
  }
}
```

### 8.4 数据量评估

单次广播 payload 大小:
- stats:约 1-2KB(category/brand/rating/sales/revenue 等)
- market:约 0.5-1KB(gmvSum/soldCount/createDate/weight)
- variant:约 0.5-2KB(变体列表,取决于变体数)
- followCount:约 0.1KB
- **总计:约 2-5KB/广播**

`chrome.tabs.sendMessage` 无明确大小限制(实测 10MB 也能传),5KB 完全无压力。

### 8.5 双通道兜底

```
采集完成
  ├─ 通道 1:SW 广播(collectDone with full data)→ 前端即时回填(主通道,零延迟)
  └─ 通道 2:写 ERP MongoDB(持久化)
      ├─ ERP 队列管理页查询
      └─ 前端异步查询兜底(当广播丢失时,如 tab 刚打开还没注册监听器)
```

**通道 2 触发时机**:商品卡进视口时(IntersectionObserver),前端异步查 ERP marketStats,作为广播的兜底。如果广播已到,数据已渲染,ERP 查询返回的数据会覆盖(幂等)。如果广播未到(如 tab 刚打开),ERP 查询提供首次数据。

---

## 九、ERP 队列管理页

### 9.1 页面结构

```
/collect-queue(ERP 后端新页面)
├── 队列概览卡片(6 个)
├── 任务列表(6 个 tab)
├── 操作工具栏
├── 统计图表
└── 详情弹窗
```

### 9.2 队列概览卡片

| 卡片 | 数据源 |
|---|---|
| 待采集(pending) | collect_queue_tasks where status=pending |
| 采集中(running) | collect_queue_tasks where status=running |
| 重试中(failed_retry) | collect_queue_tasks where status=failed_retry |
| 已完成(success) | collect_queue_tasks where status=success, today |
| 失败(failed_final) | collect_queue_tasks where status=failed_final, today |
| 熔断状态 | 正常 / 熔断中(还剩 X 分钟) |

### 9.3 任务列表 Tab

| Tab | 列 |
|---|---|
| 待采集 | SKU / 卖家 / 创建时间 / 等待时长 |
| 采集中 | SKU / 卖家 / 开始时间 / 已耗时 / 当前步骤 |
| 重试中 | SKU / 卖家 / 尝试次数 / 最后错误 / 下次重试时间 |
| 已完成 | SKU / 卖家 / 完成时间 / 耗时 / 各步状态(8 个 ✓/✗) |
| 失败 | SKU / 卖家 / 失败时间 / 错误类型 / 错误步骤 / 详情按钮 |
| 全部 | 全部任务,带状态筛选 |

### 9.4 操作功能

| 操作 | 说明 | 实现 |
|---|---|---|
| 重试 | 对 failed_final 重置为 pending | 写 collect_queue_ops { op:'retry', sku } |
| 删除 | 从队列删除任务 | 写 collect_queue_ops { op:'delete', sku } |
| 批量重试 | 筛选失败任务批量重置 | 写多个 ops |
| 暂停消费 | 手动暂停 SW 队列消费 | 写 collect_queue_ops { op:'pause' } |
| 恢复消费 | 恢复 SW 队列消费 | 写 collect_queue_ops { op:'resume' } |
| 清空队列 | 清空所有 pending | 写 collect_queue_ops { op:'clear' } |

### 9.5 ERP 接口清单

| 接口 | 方法 | 说明 |
|---|---|---|
| `/admin/api/collect-queue/stats` | GET | 队列统计(各状态数量 + 熔断状态) |
| `/admin/api/collect-queue/list` | GET | 任务列表(分页 + 状态筛选) |
| `/admin/api/collect-queue/:sku` | GET | 单任务详情 |
| `/admin/api/collect-queue/:sku/retry` | POST | 手动重试(写 op) |
| `/admin/api/collect-queue/:sku` | DELETE | 删除任务(写 op) |
| `/admin/api/collect-queue/batch-retry` | POST | 批量重试 |
| `/admin/api/collect-queue/clear` | POST | 清空 pending(写 op) |
| `/admin/api/collect-queue/consume-pause` | POST | 暂停消费(写 op) |
| `/admin/api/collect-queue/consume-resume` | POST | 恢复消费(写 op) |
| `/admin/api/collect-queue/ops/pending` | GET | SW 轮询拉取未处理 ops |

### 9.6 SW 轮询 ERP ops

```js
// SW 每 5 秒轮询 ERP ops
setInterval(async () => {
  try {
    const ops = await _erpGetPendingOps();
    for (const op of ops) {
      await _processOp(op);
      await _erpMarkOpProcessed(op._id);
    }
  } catch (e) {
    console.warn('[Queue] ops poll failed:', e);
  }
}, 5000);
```

**注意**:setInterval 在 SW 被杀后丢失,需 alarm 唤醒后重新启动。与消费循环共用 alarm。

---

## 十、任务状态机完整流转

```
                    ┌──────────────────────────────────────────┐
                    ↓                                          │
pending ──→ running ──→ success(终态)                         │
   ↑           │                                                │
   │           ├──→ failed_retry ──(nextRetryAt 到)──→ pending  │
   │           │                                                │
   │           ├──→ failed_partial(终态,保留部分结果)            │
   │           │                                                │
   │           └──→ failed_final(终态)                          │
   │                                                            │
   └──(ERP 手动重试)────────────────────────────────────────────┘
```

### 状态触发条件

| 转换 | 触发 |
|---|---|
| pending → running | 消费者取到任务,开始 _doAutoCollect |
| running → success | 8 步全部成功 |
| running → failed_retry | 可重试错误(网络/部分失败/内部错误)且 attempts < maxAttempts |
| running → failed_final | 不可重试错误(反爬/404)或重试次数耗尽 |
| running → failed_partial | 部分成功且有 marketStats 数据,重试耗尽 |
| failed_final → pending | ERP 管理页手动重试 |

### 前端徽章对应

| 状态 | 显示 | 颜色 |
|---|---|---|
| pending | 排队中 | 灰色 |
| running | 采集中 | 蓝色旋转 |
| failed_retry | 重试中 1/3 | 黄色闪烁 |
| success | 已采集 | 绿色 |
| failed_partial | 部分采集 | 橙色 |
| failed_final | 失败 | 红色 |
| 熔断 | 反爬熔断 | 橙色警告 |

---

## 十一、与现有代码的关系

### 保留复用

| 现有代码 | 新架构角色 |
|---|---|
| `_doAutoCollect`(8 步编排) | 队列消费者调用,核心采集逻辑不变 |
| `checkStoreClassification` | 前端提交前调用(通过新 action) |
| `fetchVariantMediaViaBuyerTab` | _doAutoCollect 内部调用,不变 |
| `fetchSellerPortal` | _doAutoCollect 内部调用,不变 |
| `_handleAntibot` | 反爬熔断,改为更新队列 meta |
| `keepAlive` 定时器 | 消费期间保活,不变 |
| seller-info-main.js | sellerId/店铺信息提取,不变 |
| `jzRenderProductCardPanel` | 数据卡渲染,改为从广播/ERP 查数据 |

### 移除/替换

| 现有代码 | 处理 |
|---|---|
| `loadPanelData` 中的 marketStats fetch | 移除,改为提交任务 + 异步查 ERP |
| `collectAutoIfMatched` | 替换为 `submitTask` |
| `autoCollectOnSkuSeen` burst 限流 | 移除,SW 队列消费速率替代 |
| `_autoCollectSeen` 去重 | 移到 SW 侧(队列 + 已采集集合) |
| `_autoCollectGate` / `_buyerPageGate` / `_sellerPortalGate` | 移除,统一由队列消费速率控制 |
| 60 秒定时重扫 | 移除,队列内重试机制替代 |
| `autoCollect` action handler | 替换为 `submitTask` + `consumeQueue` |

---

## 十二、疑点清单

### 已确认决策(v2)

| # | 疑点 | 决策 | 详见 |
|---|---|---|---|
| 1 | chrome.storage.local 写入竞态 | SW 侧加 `_withQueueLock` 内存锁,写入串行化 | §3.6 |
| 2 | chrome.storage.local 配额 | 不存 result,只存状态,2.5MB/5000 任务安全 | §3.5 |
| 3 | ERP ops 轮询延迟 | 接受 5 秒延迟 | §9.6 |
| 4 | alarm 1 分钟空窗 | 接受 | §4.5 |
| 5 | 广播数据量 | 广播发完整数据(2-5KB),对齐 preFetched 结构 | §8.2 |
| 6 | 中国卖家筛选 | 保持现有机制,提取不到不采集 | §5 |
| 7 | 消费速率配置同步 | 复用 skuInterval 字段,重命名 consumeRateSec | §7 |
| 8 | 过渡策略 | 一次性切换,删除旧 autoCollect handler | §11 |
| 9 | SW 重启恢复 | SW 启动时扫描 running 任务重置为 failed_retry | §4.6 |
| 10 | 前端去重 | 前端保留 _autoCollectSeen + SW 侧权威去重 | §11 |

### 新疑点(v2 补充)

#### 疑点 11:_doAutoCollect 内部数据如何收集给广播

**问题**:`_doAutoCollect` 当前返回 `{ status, results, totalDuration }`,不含实际业务数据。要构造广播的完整数据,需要在 `_doAutoCollect` 内部收集 4 路数据(stats/market/variant/followCount)。

**当前数据流向**:
- Step 1 (card): 商品卡数据 → 写 SW cache
- Step 2 (detail): 商品详情 → 写 SW cache
- Step 3 (composer): Composer API → 写 SW cache
- Step 4 (entrypoint): Entrypoint API → 写 SW cache
- Step 5 (search): 搜索排名 → 写 SW cache
- Step 6 (marketStats): 市场数据 → 写 SW cache + ERP
- Step 7 (bundle): bundle → 写 SW cache
- Step 8 (followSell): 跟卖 → 写 SW cache

**方案**:在 `_doAutoCollect` 中加一个 `collectedData` 对象,每步执行后将数据引用存入,最后构造广播 payload。

**影响**:`_doAutoCollect` 需要小幅改造,在各 step 完成时把数据存到 `collectedData` 而不仅是写 cache。

#### 疑点 12:广播数据对齐 preFetched 结构的兼容性

**问题**:前端 `jzPopulatePanelV2` 的 `info.preFetched` 路径期望 `{ stats, market, variant, followCount }` 四个 SettledResult。但广播数据中如果某步采集失败,该字段会是 `{ status: 'rejected', reason: '...' }` 而非 `{ status: 'fulfilled', value: null }`。

**影响**:前端渲染时可能因结构不一致而报错。

**方案**:SW 构造广播 payload 时,失败的步骤统一填 `{ status: 'fulfilled', value: null }`,让前端按"无数据"处理,不抛错。

#### 疑点 13:广播时 tab 可能尚未注册监听器

**问题**:新打开的 tab,content script 刚注入,可能还没注册 `chrome.runtime.onMessage` 监听器,广播就会丢失。

**影响**:新 tab 的数据卡无数据(直到触发兜底的 ERP 查询)。

**方案**:可接受。触发 1(进视口查 ERP)作为兜底,确保即使广播丢失,数据卡也能从 ERP 获取数据。如果 ERP 也无数据(首次采集),用户刷新页面后可触发 ERP 查询获取。

#### 疑点 14:消费速率配置字段重命名的影响

**问题**:决策 7 将 `skuInterval` 重命名为 `consumeRateSec`,但现有 `jz-auto-collect-config` 中的数据可能已有 `skuInterval` 字段。

**影响**:已存储的配置会丢失消费速率设置,回退到默认值。

**方案**:`_loadAutoCollectConfig` 中做兼容读取,优先 `consumeRateSec`,fallback `skuInterval`,并在读取后写回新字段名。

```js
const consumeRateSec = config.consumeRateSec ?? config.skuInterval ?? 15;
```

#### 疑点 15:ERP 队列管理页的 ops 处理失败重试

**问题**:SW 处理 ERP op(如 retry)时,如果 SW 执行 op 失败(如 chrome.storage.local 写入失败),op 仍标记为 processed=true,用户操作丢失。

**方案**:SW 处理 op 时,成功才标记 processed=true,失败保持 processed=false 等下次轮询重试。加 `attempts` 字段限制最大重试次数(如 3 次),超过后标记 `failed`。

#### 疑点 16:多个标签页同时提交相同 SKU

**问题**:用户在两个 tab 看同一商品,两个 tab 的 IntersectionObserver 都触发,同时提交相同 SKU 任务。

**现状**:疑点 10 决策"前端保留 _autoCollectSeen",但每个 tab 的 _autoCollectSeen 是独立的,无法跨 tab 去重。

**方案**:SW 侧权威去重(查队列 + 已采集集合)兜底。两个 tab 的提交都会到达 SW,SW 发现队列中已有该 SKU,直接返回"已入队",不重复添加。

#### 疑点 17:已完成任务的清理时机

**问题**:决策 2 不存 result,但已完成任务(status=success/failed_final)仍会在 chrome.storage.local 中累积。500 个保留上限,何时清理?

**方案**:每次入队新任务时,顺便检查已完成任务数量,超过 500 个时删除最早的(按 finishedAt 排序)。在 `_withQueueLock` 内执行,确保原子性。

#### 疑点 18:消费速率与 todayCount 的关系

**问题**:现有 `perDayLimit` 限制每日采集数量。新架构下,如果队列消费速率快,可能很快达到 perDayLimit,队列剩余任务怎么处理?

**方案**:消费者在消费前检查 todayCount,达到 perDayLimit 后暂停消费(设 meta.consumePaused=true,原因=daily_limit),第二天 0 点自动恢复(检查 todayDate,跨日重置 todayCount + 恢复消费)。

#### 疑点 19:采集日志与队列任务的关系

**问题**:现有 `_writeAutoCollectLog` 写采集日志到 ERP。新架构下,队列任务本身也在 ERP 有记录(collect_queue_tasks),采集日志与队列任务的关系?

**方案**:
- collect_queue_tasks:任务级记录(状态/重试/时间),生命周期为 pending → running → 终态
- auto_collect_log(现有):采集结果日志(8 步详情/错误),终态后写一次
- 关联:collect_queue_tasks 的 `sku` 关联 auto_collect_log 的 `sku`,通过 sku 查询完整链路
- **不合并**:保持两表分离,职责清晰(队列管理 vs 采集日志)

#### 疑点 20:前端筛选条件与店铺页 URL 的关系

**问题**:前端筛选(价格/中国卖家/有评价)在店铺页执行。但用户可能在非店铺页(如搜索页)也开启自动采集。非店铺页没有 sellerSlug,中国卖家筛选无法执行。

**方案**:
- 店铺页(`https://www.ozon.ru/seller/*`):正常执行前端筛选 + 提交任务
- 非店铺页(如搜索页):跳过中国卖家筛选(无 sellerSlug),只执行价格/评价筛选,提交任务时 sellerSlug 为空
- SW 侧:无 sellerSlug 的任务,跳过中国卖家检查,直接入队

---

## 十三、实施阶段建议

### Phase 1:队列基础设施
- chrome.storage.local 队列结构 + meta
- SW 侧 submitTask handler + 去重 + 入队
- SW 侧消费循环 + alarm 兜底
- SW 启动时恢复消费 + stale 检查

### Phase 2:采集执行对接
- 消费循环调用现有 _doAutoCollect
- 采集结果双写(chrome.storage.local + ERP)
- 采集结果广播
- 失败重试机制

### Phase 3:前端改造
- submitTask 替换 collectAutoIfMatched
- 数据卡双触发回填
- 徽章状态更新
- 前端去重保留

### Phase 4:ERP 管理页
- collect_queue_tasks 集合 + 索引
- collect_queue_ops 集合 + 索引
- 10 个 API 接口
- Vue 管理页(stats + 列表 + 操作 + 详情)
- SW 轮询 ops

### Phase 5:清理
- 移除旧 autoCollect handler
- 移除 burst 限流
- 移除 60 秒定时重扫
- 移除三个 gate(buyerPage/sellerPortal/skuInterval)

---

## 十四、文件改动清单(预估)

| 文件 | 改动类型 | 说明 |
|---|---|---|
| qx-ozon/background/service-worker.js | 重构 | 队列管理 + 消费循环 + alarm + 广播 |
| qx-ozon/content/shared-utils.js | 重构 | submitTask + 去重 + 广播监听 + 徽章 |
| qx-ozon/content/ozon-data-panel.js | 修改 | loadPanelData 改为双触发 + 提交任务 |
| qx-ozon/content/qx-collector/panel.js | 修改 | 队列状态展示 |
| qx-ozon/manifest.json | 修改 | 加 unlimitedStorage 权限(如需) |
| qx-ozon/popup/popup.html | 修改 | 消费速率配置(已有) |
| erp-backend-lite/src/modules/collect-queue.js | 新增 | ERP 后端队列接口 |
| erp-backend-lite/src/db/mongo.js | 修改 | 加 collect_queue_tasks / ops 集合索引 |
| erp-backend-lite/web/src/views/CollectQueue.vue | 新增 | ERP 队列管理页 |
| erp-backend-lite/web/src/router/index.js | 修改 | 加路由 |
| erp-backend-lite/web/src/api/cache.js | 修改 | 加队列 API 封装 |

---

## 十五、代码评审意见(2026-07-15)

> 评审基础:通读全文(1100 行 / 40KB)+ 对照现有代码(`service-worker.js` / `shared-utils.js` / `ozon-data-panel.js` / `task-queue.js` / `auto-scroller.js`)验证关键假设。
> 总体评价:架构解耦设计精准、疑点分析透彻、双写主从方案合理。存在 **2 个 P0 致命 bug**、**2 个 P1 性能瓶颈**、**4 个 P2 设计遗漏**，需在实施前解决。

### 评审总结表

| 优先级 | 问题 | 章节 | 影响 |
|---|---|---|---|
| 🔴 P0 | `failed_retry` 任务永远不会被消费 | §7.2 / §10 / §4.6 | 重试机制完全失效 |
| 🔴 P0 | `skuInterval` 毫秒/秒单位不匹配 | §疑点 14 | 默认消费速率变成 ~8 小时一个 |
| 🟡 P1 | 单 Key 全量数组的读改写开销 | §3.2 / §3.6 | 高并发入队阻塞 6-15 秒 |
| 🟡 P1 | ops 轮询 setInterval 在 SW 重启后无恢复机制 | §9.6 | ops 延迟从 5s → 60s |
| 🟡 P2 | ERP 双写分歧后无对账机制 | §3.1 | 网络断开后 ERP 数据空洞 |
| 🟡 P2 | 消费速率 >30s 时实际行为与配置不一致 | §4.5 | 用户配置被忽略 |
| 🟢 P3 | 入队时清理已完成任务的叠加开销 | §疑点 17 | 高频入队时延迟叠加 |
| 🟢 P3 | `_doAutoCollect` 改造工作量被低估 | §疑点 11 | 实施估算偏低 |

---

### 🔴 P0-1:`failed_retry` 任务永远不会被消费

**位置**:§7.2 `_getNextPending` + §10 状态机 + §4.6 stale 检查

**问题**:

§7.2 的消费者取任务逻辑只匹配 `status === 'pending'`:

```js
async function _getNextPending() {
  const queue = await _loadQueue();
  const now = Date.now();
  return queue.find(
    (t) => t.status === 'pending' && (!t.nextRetryAt || t.nextRetryAt <= now)
  );
}
```

但 §10 状态机和 §4.6 的 stale 检查都把失败任务设为 `failed_retry`:

```js
// §4.6 — SW 被杀后
task.status = 'failed_retry';
task.nextRetryAt = now + 30000;

// §10 状态机 — 可重试错误
running → failed_retry (可重试错误 and attempts < maxAttempts)
```

`failed_retry` 状态的任务**永远不会被 `_getNextPending` 匹配到**，因为它只查 `pending`。所有可重试的失败任务将永久滞留在队列中。

**影响**:网络抖动、SW 被杀等可重试场景下，任务永久卡在 `failed_retry`，重试机制形同虚设。

**修复方案(二选一)**:

**方案 A** — `_getNextPending` 同时匹配两种状态:

```js
return queue.find(
  (t) => (t.status === 'pending' || t.status === 'failed_retry')
       && (!t.nextRetryAt || t.nextRetryAt <= now)
);
```

**方案 B(推荐)** — `failed_retry` 退化为纯展示态:

retryable 失败时直接设回 `pending` + `nextRetryAt`:

```js
task.status = 'pending';        // 不用 failed_retry
task.nextRetryAt = now + backoff;
```

`failed_retry` 变成 ERP 镜像端的展示状态(ERP 中可以保留 `failed_retry` 标签)，chrome.storage.local 中始终用 `pending` + `nextRetryAt` 区分可消费/退避中。文档中所有提到 `failed_retry` 的地方需标注此语义。

---

### 🔴 P0-2:`skuInterval` 毫秒/秒单位不匹配

**位置**:§疑点 14

**问题**:

文档中的兼容读取:

```js
const consumeRateSec = config.consumeRateSec ?? config.skuInterval ?? 15;
```

但现有代码(`service-worker.js:2543`)中 `skuInterval` 默认值是 **30000(毫秒)**:

```js
skuInterval: 30000,  // 毫秒
```

新代码期望的是**秒数**。直接复用 `skuInterval` 会得到 30000 **秒**（约 8.3 小时采一个），完全不可用。

**修复**:

```js
// skuInterval 是毫秒,consumeRateSec 是秒
const consumeRateSec = config.consumeRateSec
  ?? Math.round((config.skuInterval || 30000) / 1000)  // 毫秒 → 秒
  ?? 15;
```

同时需在 `_loadAutoCollectConfig` 中做迁移:首次读到旧 `skuInterval` 后，写回 `consumeRateSec` 新字段，避免每次都做转换。

---

### 🟡 P1-1:单 Key 全量数组的读改写开销

**位置**:§3.2 / §3.6

**问题**:

`jz-collect-queue` 单 Key 存整个任务数组。每次入队/更新状态都需 `getStorage → 改 → setStorage`，且通过 `_withQueueLock` 串行化:

```
5000 任务 × ~500 字节 = 2.5MB
每次操作:读 2.5MB → JSON.parse → 改 → JSON.stringify → 写 2.5MB
叠加 _withQueueLock 串行化:所有写操作排大队
```

**量化影响**(估算):

| 场景 | 计算 | 总耗时 |
|---|---|---|
| 单次 chrome.storage.local 读+写(2.5MB) | ~20-50ms | 30ms |
| 10 标签页 × 30 SKU 并发提交 = 300 次 enqueue | 300 × 30ms(串行) | **6-15 秒** |
| 消费者每轮 `_loadQueue()` 读全量 | ~15ms/次 | 持续开销 |

**修复建议**:改为分 Key 存储:

```
jz-collect-queue:task:<sku>       → 单任务 JSON (~500B)
jz-collect-queue:meta             → 队列元数据 (consumePaused / circuitBreaker / counters)
jz-collect-queue:index:pending    → ["sku1", "sku2", ...] (轻量 SKU 索引数组)
jz-collect-queue:index:completed  → ["skuN", ...] (最近 500 个)
```

- 入队:写 1 个新 Key(~500B) + append 到 pending 索引(轻量数组)
- 更新状态:改单个任务 Key(~500B) + 移动索引项
- 消费者:读 pending 索引(轻量) → 按需读单任务 Key

如果担心 Key 数量膨胀(5000 Key)，可折中为按状态分组:

```
jz-collect-queue:pending    → [task1, task2, ...]    (活跃任务)
jz-collect-queue:completed  → [taskN, ...]           (最近 500 个)
jz-collect-queue:meta       → {...}
```

活跃队列通常远小于 5000(消费后即移走)，单次 I/O 量大幅降低。

---

### 🟡 P1-2:ops 轮询 setInterval 在 SW 重启后无恢复机制

**位置**:§9.6

**问题**:

§9.6 的 ops 轮询用 `setInterval`:

```js
setInterval(async () => {
  const ops = await _erpGetPendingOps();
  for (const op of ops) {
    await _processOp(op);
    await _erpMarkOpProcessed(op._id);
  }
}, 5000);
```

文档说"setInterval 在 SW 被杀后丢失,需 alarm 唤醒后重新启动"，但:
- `_maybeStartConsume()`（alarm handler 调用）只负责消费循环,不负责启动 ops 轮询
- 没有任何代码在 alarm 唤醒时重新启动 ops setInterval
- 结果:SW 第一次被杀后,ops 轮询**永久停转**，ERP 管理页的 retry/delete/pause 操作永远不被执行

**修复建议**:

方案 A — ops 轮询合并到 alarm 周期:

```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COLLECT_QUEUE_ALARM) {
    _maybeStartConsume();
    _pollOpsOnce();  // alarm 每分钟拉一次 ops
  }
});
```

文档需标注:ops 延迟从 5 秒(alive 时)变为最迟 1 分钟(SW 被杀后靠 alarm)。

方案 B — SW 空闲时也用 setInterval(5s)，被杀后靠 alarm(1min)兜底:

```js
// SW 启动时启动 ops 轮询
function _startOpsPolling() {
  if (_opsPollTimer) return;
  _opsPollTimer = setInterval(_pollOpsOnce, 5000);
}

// alarm 唤醒时也拉一次
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COLLECT_QUEUE_ALARM) {
    _maybeStartConsume();
    _pollOpsOnce();       // 兜底
    _startOpsPolling();   // 重启 setInterval
  }
});

// SW 启动(SW 模块顶层)也要启动
_startOpsPolling();
```

---

### 🟡 P2-1:ERP 双写分歧后无对账机制

**位置**:§3.1

**问题**:

文档说"ERP 写失败不影响采集，只记 warn 日志"。但如果 ERP 持续写失败(网络断开)，积累后:
- chrome.storage.local 有 5000 个任务(完整)
- ERP MongoDB 几乎是空的(写不进去)
- 恢复连接后，ERP 管理页看到空列表，无法管理这些任务

没有对账机制意味着用户在 ERP 管理页看到的与实际队列完全脱节。

**修复建议**:

增加轻量对账 — SW 定期(如每 alarm 触发)统计 chrome.storage.local 中各状态任务数，写一个 `_erpSyncQueueSnapshot` 端点:

```js
// alarm 触发时
async function _syncQueueSnapshot() {
  const queue = await _loadQueue();
  const snapshot = {
    pending: queue.filter(t => t.status === 'pending').length,
    running: queue.filter(t => t.status === 'running').length,
    success: queue.filter(t => t.status === 'success').length,
    failed: queue.filter(t => t.status.startsWith('failed')).length,
    syncedAt: new Date(),
  };
  await apiRequest('POST', `${backendUrl}/admin/api/collect-queue/sync-snapshot`, snapshot, token);
}
```

ERP 管理页加一个"队列健康"指示器，对比 ERP 本地任务数与 SW snapshot，差异大时提示"数据可能不同步"。

如需完整修复，可在网络恢复后做一次全量同步(遍历 chrome.storage.local 任务批量 upsert 到 ERP)。但考虑到个人单设备场景，snapshot 指示器 + 手动触发同步可能已足够。

---

### 🟡 P2-2:消费速率 >30s 时实际行为与配置不一致

**位置**:§4.5

**问题**:

§4.5 表格标注 120 秒时"setTimeout 120s 保活，但 SW 可能 30s 空闲被杀 → alarm 1 分钟唤醒"，但未说明实际消费速率的变化。

执行流分析:

```
_consumeOne() → 消费 → setTimeout(_consumeOne, 120000)
SW 30s 空闲被杀 → _consuming 随 SW 死亡重置为 false
alarm 1 分钟后唤醒 → _maybeStartConsume() → _consuming=false → _consumeOne()
→ 立即消费下一个(不等 120s！)
```

**实际效果**:120 秒配置在 SW 被 Kill 后变成**约 1 分钟一次**。用户配置的"每 120 秒一个"实际变成"每 60 秒一个"。

**修复建议(二选一)**:

方案 A — alarm handler 中检查距上次消费的时间:

```js
async function _maybeStartConsume() {
  if (_consuming) return;
  const meta = await _loadQueueMeta();
  const elapsed = Date.now() - (meta.lastConsumeAt || 0);
  if (elapsed < meta.consumeRateSec * 1000) {
    // 不足配置间隔，重设 setTimeout 等剩余时间
    const wait = meta.consumeRateSec * 1000 - elapsed;
    setTimeout(() => _consumeOne(), wait);
    return;
  }
  _consumeOne();
}
```

方案 B — 文档明确标注约束:

> 消费速率 >30s 时，若 SW 因 30 秒空闲规则被杀，alarm 兜底唤醒后实际消费间隔约为 1 分钟(alarm 周期)。用户配置的间隔仅作为下限，不保证精确执行。建议消费速率配置 ≤30 秒以保持 SW 持续活跃。

---

### 🟢 P3-1:入队时清理已完成任务的叠加开销

**位置**:§疑点 17

**问题**:

§疑点 17 提出在入队时顺便清理已完成任务。在 `_withQueueLock` 内对 5000 任务的数组做 `filter` + `sort`(O(n log n))，叠加在每次入队的锁持有时间内，进一步拖慢入队吞吐。

**修复建议**:

改为懒清理 — 只在 `_withQueueLock` 内维护一个 completed 计数器，超过阈值时才清理，且每 N 次 enqueue 才检查一次:

```js
let _enqueueSinceLastCleanup = 0;
async function _enqueueTask(task) {
  return _withQueueLock(async () => {
    // ... 入队逻辑 ...
    _enqueueSinceLastCleanup++;
    if (_enqueueSinceLastCleanup < 50) return; // 每 50 次入队才检查
    _enqueueSinceLastCleanup = 0;
    // 此处才做 filter + sort + 截断
  });
}
```

---

### 🟢 P3-2:`_doAutoCollect` 改造工作量被低估

**位置**:§疑点 11

**问题**:

§8.3 说"_doAutoCollect 内部已经 fetch 了 4 路数据，顺手构造广播 payload"。但 §8.1 也明确指出 `_doAutoCollect` 返回的 `results` 只是 hit/error 元数据，**不含实际业务数据**。实际数据分散在 SW 各 cache 中(cardCache、detailCache、composerCache 等)。

§疑点 11 承认需要改造，但将其归类为"小幅改造"。实际上:
- 8 步每步的数据结构不同(card / detail / composer / entrypoint / search / marketStats / bundle / followSell)
- 需要逐步适配为 SettledResult 格式 `{ status: 'fulfilled', value: {...} }` / `{ status: 'rejected', reason: '...' }`
- 失败步骤需要统一填 `{ status: 'fulfilled', value: null }`(§疑点 12)，需逐步处理
- 变体列表等数据可能很大，需考虑序列化开销

**建议**:

在实施计划 Phase 2 中将此项标注为**中等风险改造**，预计需要逐 step 审查数据流并适配，而非"顺手"处理。建议先对 `_doAutoCollect` 8 步的数据结构做一次详细审计(类似 §8.1 的表，但展开到每步的具体字段)，再开始改造。

---

### 🟢 值得肯定的设计点

| 设计 | 评价 |
|---|---|
| **`_withQueueLock` 内存锁** | Promise 链串行化方案简洁有效，单 SW 实例天然安全 |
| **双写容错策略** | "ERP 写失败不影响采集"的降级思路对个人单机场景完全正确 |
| **stale running 检测 + alarm 兜底** | SW 5 分钟 Kill 场景下最迟 1 分钟恢复 + `startedAt` 判断卡死，兜底完善 |
| **错误分类 5 档** | 与现有 `_handleAntibot`(`service-worker.js:3582`)无缝衔接，反爬熔断 10 分钟机制复用 |
| **一次性切换策略** | 虽激进但适合个人单设备场景，避免双路径维护负担 |
| **疑点 19 两表分离** | collect_queue_tasks(队列管理) vs auto_collect_log(采集日志)，职责清晰 |
| 双通道回传 | 广播发完整数据(2-5KB)直接渲染 + ERP 兜底，零额外消息开销 |

---

## 十六、实施完成记录

### 实施状态

- **状态**:已完成(2026-07-15)
- **Prettier 校验**:通过(修复根目录 `package.json` 中历史遗留的 `0.13.31.1` 路径 bug,改为 `qx-ozon`、`erp-backend-lite/src`、`erp-backend-lite/web/src`、`docs`)
- **Node 语法检查**:通过
- **测试状态**:待手动验证

### 主要实施文件

| 文件 | 说明 |
|---|---|
| `qx-ozon/background/service-worker.js` | 队列基础设施、消费循环、失败重试、ERP 双写、广播、alarm 兜底 |
| `qx-ozon/content/ozon-data-panel.js` | DOM 提取补评论数、任务提交、数据卡双触发回填、移除定时重扫 |
| `qx-ozon/content/shared-utils.js` | `__jzSubmitCollectTask`、广播监听、清理旧 autoCollect 函数 |
| `qx-ozon/content/ozon-product.js` | 移除 PDP 自动采集入口 |
| `qx-ozon/popup/popup.html` | 限速配置改为队列间隔(秒)+每日上限 |
| `qx-ozon/popup/popup.js` | 限速配置字段改为 `consumeRateSec` |
| `erp-backend-lite/src/db/mongo.js` | 新增 `collect_queue_tasks`/`collect_queue_ops` 集合和索引 |
| `erp-backend-lite/src/modules/collect-queue.js` | 13 个队列管理 API |
| `erp-backend-lite/src/app.js` | 挂载队列路由 |
| `erp-backend-lite/web/src/api/collectQueue.js` | 前端 API 封装 |
| `erp-backend-lite/web/src/views/CollectQueue.vue` | ERP 队列管理页 |
| `erp-backend-lite/web/src/router/index.js` | `/collect-queue` 路由 |
| `erp-backend-lite/web/src/App.vue` | 导航入口 |

### 关键修复(相对于 v2 评审意见)

| 评审问题 | 修复状态 | 修复方式 |
|---|---|---|
| `failed_retry` 任务不会被消费 | ✅ 已修复 | `_getNextPending` 同时匹配 `pending` 和 `failed_retry` |
| `skuInterval` 毫秒/秒单位不匹配 | ✅ 已修复 | 从 raw 字段判断旧 `skuInterval` 并除以 1000 转换为秒 |
| ops 轮询 SW 重启后丢失 | ✅ 已修复 | alarm handler 中重启 ops 轮询并立即执行一次 |
| 消费速率 >30s 被 alarm 缩短 | ✅ 已修复 | `_maybeStartConsume` 检查 `lastConsumeAt`,不足间隔则 setTimeout 等待 |
| 并发入队去重竞态 | ✅ 已修复 | `_enqueueTask` 在锁内二次检查队列和今日完成集合 |
| 前端 `checkStoreClass` 与 SW `checkStoreClassification` action 不匹配 | ✅ 已修复 | SW handler 同时注册 `case 'checkStoreClass'` 别名 |

### 验证步骤

1. 重载 QX 扩展
2. 打开 Ozon 店铺页,确认商品卡出现"排队中"或"采集中"徽章
3. 打开 popup → 限速配置,确认显示"队列间隔"(默认 15s)和"每日上限"
4. 修改队列间隔为 20 秒,关闭 popup 再打开,确认值已保存
5. 打开 ERP 后台 → 采集队列页,确认任务列表、统计卡片、状态 tab 正常显示
6. 等待队列消费,确认 SKU 状态从 pending → running → success 流转
7. 验证数据卡被回填(成功后有销量/转化数据显示)
8. 人为触发网络断开,验证失败任务进入重试,并在 3 次后标记失败终态

---

## 十七、实施后代码评审(2026-07-15)

> 评审基础:对照本文档 §三–§十一 + 通读实现代码
> (`service-worker.js` 队列段 / `shared-utils.js` / `ozon-data-panel.js` /
> `collect-queue.js` / `CollectQueue.vue` / `mongo.js`)。
>
> 总体评价:**核心队列骨架(入队 / `_withQueueLock` / 消费循环 / `failed_retry` 匹配 /
> 速率兼容 / alarm 间隔)已到位,§十六列出的 v2 P0 大多已修。但 SW↔ERP 契约与前端对接
> 存在多处硬断裂,ERP 管理页操作与数据卡 ERP 兜底目前基本不可用,需先修 P0 再联调。**

### 评审总结表

| 优先级 | 问题 | 位置 | 影响 |
|---|---|---|---|
| 🔴 P0 | ERP ops 轮询因路由抢占 + 解包错误永不执行 | `collect-queue.js` 路由顺序;`_pollOpsPending` | 管理页 retry/delete/pause/resume/clear 全部无效 |
| 🔴 P0 | `_erpQueueUpdate` POST 到不存在的路由 | SW `_erpQueueUpdate`;ERP 无 `POST /:sku` | ERP 镜像看不到 running / failed_retry 等状态 |
| 🔴 P0 | 前端调 `queryErpProductData`,SW 无 handler | `ozon-data-panel.js`;SW message switch | 广播丢失时数据卡永挂骨架,§6.2 兜底失效 |
| 🔴 P0 | popup 关自动采集会写死 `consumePaused`,再开无法恢复 | `_consumeOne` + popup `autoCollectRunning` | 关开一次自动采集后队列永久卡住(ops 又坏则彻底锁死) |
| 🟡 P1 | 状态广播类型 `collectStatus` ≠ 前端听 `taskStatus` | `_broadcastQueueStatus`;`shared-utils.js` | pending/running 徽章不亮,只靠终态 `collectDone` |
| 🟡 P1 | SW 重启只重置 >5min 的 running,非「全部重置」 | `_checkStaleRunningTasks` vs 决策 9 / §4.6 | 正常 Kill 后任务变僵尸 running,最长卡住 ~5 分钟 |
| 🟡 P1 | result 字段名 SW 传 `data`,后端写 `body.result` | `_finalizeTask` / `POST /:sku/result` | ERP 详情页 `detail.result` 为空 |
| 🟡 P1 | delete/clear 只写 op,不清 Mongo 任务行 | ERP DELETE/clear;`_processQueueOp` | 管理页列表与本地队列长期不一致 |
| 🟢 P2 | 广播 `variant` 是单 item,前端期望 `{ items: [] }` | `_buildCollectDoneData`;`jzPopulatePanelV2` | 重量/尺寸/类目兜底在 collectDone 回填时跳过 |
| 🟢 P2 | 强制刷新被 `_completedTodaySkus` 静默挡住 | `_handleSubmitTask`;`__jzAutoCollectResetSeen` | 同日「强制刷新」表面上提交成功、实际不入队 |
| 🟢 P2 | `meta.todayCount` 与 `config.todayCount` 双计数器 | `_consumeOne`;`_doAutoCollect` | 日限到点后 popup 显示与队列暂停状态不一致 |

### ✅ 已对齐设计(相对 §十六)

| 项 | 状态 |
|---|---|
| `_getNextPending` 同时匹配 `pending` + `failed_retry` | ✅ |
| `skuInterval`(ms) → `consumeRateSec`(秒) 兼容换算 | ✅ |
| `_withQueueLock` + 锁内二次去重 | ✅ |
| alarm 尊重 `lastConsumeAt`,不足间隔则等待 | ✅ |
| alarm / 冷启动重启 ops 轮询的意图 | ✅(实现因 P0-1 仍无效) |
| `checkStoreClass` 别名 | ✅ |
| 不存 local `result`;popup 消费速率 UI | ✅ |

---

### 🔴 P0-1:ERP ops 轮询永不执行

**问题 A — Express 路由抢占**

`GET /admin/api/collect-queue/:sku` 注册在 `GET .../ops/pending` **之前**。请求
`/ops/pending` 会被当成 `sku="ops"` → `findOne({ sku:'ops' })` → 404。

静态路径(`stats` / `list` / `ops/*` / `batch-retry` / `clear` / `consume-*`)必须全部排在
`/:sku` 之前。

**问题 B — 响应解包错误**

即使路由修好,`apiRequest` 返回整包 `{ ok:true, data:{ items, count } }`,而:

```js
const ops = await _erpGetPendingOps();
if (!Array.isArray(ops) || ops.length === 0) return; // 永远 early-return
```

**修复**:

1. 调整 `collect-queue.js` 路由顺序:所有字面量路径 → 再挂 `/:sku*`
2. `_erpGetPendingOps` / `_pollOpsPending` 解包为:

```js
const res = await apiRequest(...);
const items = res?.data?.items ?? (Array.isArray(res?.data) ? res.data : []);
return items;
```

---

### 🔴 P0-2:`_erpQueueUpdate` 打到不存在的路由

**现状**:SW `POST /admin/api/collect-queue/:sku` 传整任务;后端该路径只有 GET / DELETE,
另有 `POST /:sku/result` 与 upsert `POST /admin/api/collect-queue`(无 sku)。

运行中 / 重试中的状态变化全部 404,被 `catch` 吞掉只打 warn → ERP 管理页几乎只看得到
初次 insert 的 pending。

**修复(二选一)**:

- **推荐**:`_erpQueueUpdate` 改为复用已有 upsert `POST /admin/api/collect-queue`(与 insert 同路径)
- 或新增 `PATCH/POST /admin/api/collect-queue/:sku` 专门做状态更新

---

### 🔴 P0-3:`queryErpProductData` 无 SW handler

**现状**:`ozon-data-panel.js` 进视口兜底调用 `sendMessage('queryErpProductData')`,SW
message switch 无对应 case → 未知消息类型。

§6.2 / §8.5 设计的「广播丢失 → ERP 查询兜底」整条通道断掉。卡片只能等 `collectDone`;
新开 tab / 监听器未就绪时永久骨架。

**修复**:

- SW 注册 `queryErpProductData`,返回对齐 `preFetched` 的结构(可复用 `_buildCollectDoneData`
  同源拼装);或
- 前端改调已有 `getProductStats` / `getMarketStats` 等 action 自行组装

---

### 🔴 P0-4:`autoCollectRunning` 与 `consumePaused` 死锁

**现状**:`_consumeOne` 发现 `!config.autoCollectRunning`(或 antibot pause / 日限)时写:

```js
await _saveQueueMeta({ consumePaused: true });
```

popup / 面板把 `autoCollectRunning` 重新打开时,**不会**清 `consumePaused`。此后:

1. 入队 → `_maybeStartConsume` → 见 `consumePaused` → return
2. 用户只能靠 ERP「恢复消费」清标志
3. 而 P0-1 下 ERP resume op 也不执行 → **队列永久停转**

**修复**:

- `autoCollectSetConfig` / popup 将 `autoCollectRunning` 置为 `true` 时同步
  `_saveQueueMeta({ consumePaused: false })` 并 `_maybeStartConsume()`
- 日限触发的 pause 与「用户关掉自动采集」要区分原因字段(如 `pauseReason:
  'daily_limit' | 'manual' | 'user_switch'`),跨日重置 / 开关恢复各自只清自己的原因

---

### 🟡 P1-1:状态广播类型不匹配

SW:

```js
{ type: 'collectStatus', sku, sellerSlug, status }
```

前端 `shared-utils.js`:

```js
if (message.type === 'taskStatus' && message.sku) { ... }
```

pending / running 进不了 `__jzCollectingSkus`,徽章缺少「排队中 / 采集中」中间态。

**修复**:两端统一为 `taskStatus`(或统一改 `collectStatus`),建议跟前端现有监听对齐改 SW。

---

### 🟡 P1-2:SW 重启未按决策 9 重置全部 running

决策 9 / §4.6:**SW 启动时扫描所有 running → failed_retry**。

实现 `_checkStaleRunningTasks` 仅当 `now - startedAt > 5 * 60 * 1000` 才重置。正常
MV3 Kill(采集中途,耗时 <5min)任务残留 `running`,`_getNextPending` 跳过,直到 stale
超时或人工介入。

**修复**:

```js
// 冷启动 / alarm 唤醒:所有 running 一律 failed_retry + nextRetryAt
if (task.status === 'running') { ... }
```

5 分钟阈值可保留作「消费循环仍存活时」的二次兜底,与冷启动全量重置分开。

---

### 🟡 P1-3:采集结果字段名错误

`_finalizeTask` → `_erpQueueResult` 传:

```js
{ status, duration, steps, error, data: collectResult }
```

后端 `POST /:sku/result` 只落 `body.result`。详情弹窗读 `detail.result` → 空树。

**修复**:SW 改为 `{ result: <payload>, steps, status, ... }`,与路由注释对齐;或后端同时接受
`data`/`result`(短期兼容)。

---

### 🟡 P1-4:delete / clear 不同步 Mongo

- ERP `DELETE /:sku` / `POST /clear` **只 insert op**,不改 `collect_queue_tasks`
- SW `_processQueueOp` 只改 `chrome.storage.local`

结果:本地队列已删/已清,ERP 列表仍显示旧 pending/failed。

**修复**:

- SW 处理 delete/clear **成功后**,再调 ERP 删除/批量更新任务行;或
- ERP 写 op 时同步改任务表(delete → 删文档;clear → 删/标记 pending),SW 只负责本地真相源
- 推荐:本地成功后再回写 ERP(与「local 是主」一致),避免 SW 未消费时 ERP 已空

---

### 🟢 P2-1:广播 variant 结构不对齐 preFetched

`_getSearchVariantForBroadcast` 返回 `items[0]`(单条),`_buildCollectDoneData` 塞进
`variant.value`。`jzPopulatePanelV2` 期望 `value.items`(或 `value.data.items`)数组。

重量 / 尺寸 / 品牌兜底在 collectDone 路径被跳过(stats/market 主路径仍可用)。

**修复**:

```js
variant: items?.length
  ? { status: 'fulfilled', value: { items } }
  : { status: 'fulfilled', value: null };
```

---

### 🟢 P2-2:强制刷新被今日完成集挡住

`__jzAutoCollectResetSeen` 只清前端 `_autoCollectSeen`;`_handleSubmitTask` /
`_isTaskQueuedOrCompletedToday` 仍因 `_completedTodaySkus` 返回 `alreadyQueued`。

同日强制重采静默失败。

**修复**:强制刷新消息携带 `force:true` 时,SW 从 `_completedTodaySkus` 删除该 sku,并允许
覆盖终态任务为新 pending;或提供独立 `resubmitTask` action。

---

### 🟢 P2-3:双 todayCount

| 计数器 | 递增时机 | 用途 |
|---|---|---|
| `meta.todayCount` | 每次 `_consumeOne` 处理完(含失败) | 队列 `perDayLimit` |
| `config.todayCount` | `_doAutoCollect` 成功路径 | popup 展示 / Gate0 |

两者不同步 → 队列已 pause,popup 仍显示额度;或反向。

**修复**:统一以一处为准(推荐 `meta.todayCount` =「今日已处理」;popup 读 meta 或同步写回
config),并明确「失败是否计入日限」。

---

### 建议修复顺序

1. **P0-1** 路由顺序 + ops 解包 → 管理页操作通路打通
2. **P0-2** + **P1-3** ERP 状态/结果写入对齐 → 镜像可用
3. **P0-4** 开关与 `consumePaused` 联动 → 避免用户锁死队列
4. **P0-3** + **P1-1** 数据卡兜底与徽章中间态
5. **P1-2** / **P1-4** 重启重置与 delete/clear 双写
6. **P2-*** 结构与强制刷新 / 日限计数

### 修复后补充验证

- [ ] ERP 点「暂停/恢复/重试/删除/清空」,SW 控制台有 `[Queue] process op` 且本地队列变化
- [ ] 任务 pending→running→success 时 ERP 列表状态同步变化,详情有 `result`
- [ ] popup 关闭再打开自动采集,队列继续消费(无需 ERP resume)
- [ ] 人为延迟 content script 注入,进视口仍能靠 ERP 查询填卡
- [ ] 徽章出现「排队中/采集中」,结束后变「已采集」
- [ ] 强制刷新同日已成功 SKU 能重新入队
- [ ] SW 重载后,采集中途的 running 任务进入重试而非永久卡住