# 插件重载安全性审查 — qx-ozon

> 审查日期:2026-07-14
> 审查范围:`qx-ozon/` 全量代码(扩展重载时所有可能触发的代码路径)
> 审查目标:确认插件重载(update/install/dev reload)时是否可能导致浏览器卡死、崩溃或重启

---

## 一、结论摘要

项目中 **没有** 调用 `chrome.runtime.reload()`、`chrome.runtime.restart()` 等直接重启扩展或浏览器的 API,也没有 `while(true)` 无限循环或无限递归等致命模式。

**但存在多个可能导致资源耗尽、浏览器卡死/崩溃的隐患**,在"多标签页 + 扩展重载"的组合场景下,极端情况下可能触发 OS OOM Killer 终结浏览器进程(表现为浏览器"重启")。

| 严重度 | 问题 | 根因 |
| --- | --- | --- |
| 🔴 高 | autoCollect 消息风暴 | 重载后去重状态丢失,N 标签页 × M SKU 同时涌入 SW |
| 🔴 高 | 超大 content script 全量重注入 | 单页 ~886KB × N 标签页同时解析执行 |
| 🟡 中 | `reloadOzonTabs()` 无错开重载 | auth 状态变化时全量同时 reload + 二次重注入 |
| 🟡 中 | `onInstalled` + `reloadSellerTabs` 双重加载 | Chrome 自动重注入 + 代码主动 reload |
| 🟡 中 | `all_frames` 定时器放大 | 每 iframe 1s 定时器 × N 个 frame |
| 🟡 中 | MutationObserver 反馈循环 | `applyToAll()` 修改 DOM → 触发自身 Observer |

**根因总结**:不是某个单独的 bug,而是 **多个标签页 × 大体量 content script × 重量级初始化逻辑** 的组合效应。标签页较少(1-3 个)时无感知;打开 10-20 个 Ozon 页面后重载扩展,资源压力急剧放大。

---

## 二、风险详解

### 🔴 风险 1:autoCollect 消息风暴(最严重)

**涉及文件**:
- `qx-ozon/content/shared-utils.js`(`autoCollectOnSkuSeen`, `collectAutoIfMatched`)
- `qx-ozon/content/ozon-data-panel.js`(`ensureDataPanel`, `loadPanelData`)
- `qx-ozon/background/service-worker.js`(`_doAutoCollect`, keepAlive)

#### 触发链路

```
扩展重载
  → Chrome 向所有匹配标签页重注入 content script
    → 页面级状态全部重置(_autoCollectSeen = new Set(), panelDataCache = new Map())
      → applyToAll() → ensureDataPanel() → loadPanelData()
        → 每个商品卡触发 collectAutoIfMatched()
          → autoCollectRunning = true(默认值)→ 跳过筛选,直接发送
            → _autoCollectSeen 为空 → 全部通过去重
              → sendMessage('autoCollect', ...) × N SKU × M 标签页
```

#### 关键代码

**① 去重状态丢失**(`shared-utils.js:47`)

```js
// 模块级变量,扩展重载(content script 重新注入)时重置为空
const _autoCollectSeen = new Set();  // ← 重载后 = 空 = 全部视为"新发现"
```

**② 默认放行**(`shared-utils.js:52`)

```js
let autoCollectRunning = true;  // ← 默认 true,collectAutoIfMatched 跳过筛选直接发送
```

`collectAutoIfMatched`(`shared-utils.js:3936`):

```js
if (!autoCollectRunning && !options.forceRefresh) {
    return;  // ← autoCollectRunning=true 时永远跳过
}
```

**③ 重量级 handler**(`service-worker.js:3625`)

`_doAutoCollect` 是 8 步编排,单次含多次网络请求,耗时 30-300s。handler 总超时上限 300s:

```js
const HANDLER_TOTAL_TIMEOUT_MS = LONG_HANDLER_ACTIONS.has(message?.action)
  ? 300_000  // autoCollect:300s
  : 50_000;
```

每个请求还创建 keepAlive 定时器(`service-worker.js:7128`):

```js
keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
}, 15_000);  // ← 每请求一个 15s 定时器
```

#### 最坏场景量化

| 维度 | 数值 |
| --- | --- |
| 标签页数 | 20 |
| 每页商品卡 | 30 |
| 同时涌入消息 | **600 个 autoCollect** |
| SW 每请求资源 | 多次 fetch + 15s keepAlive 定时器 + up to 300s handler |
| content 侧超时 | 每 SKU 一个 600s 超时定时器(600 个!) |

**后果**:SW 事件队列堆积、内存暴涨 → 极端情况下 OS OOM Killer 终结浏览器进程。

#### 已有缓解措施(不足)

| 措施 | 位置 | 不足之处 |
| --- | --- | --- |
| Gate0 日限额 | `service-worker.js:3700` | `todayCount` 自增非原子,并发时多请求读到旧值同时通过 |
| `_autoCollectSeen` 页面去重 | `shared-utils.js:47` | 仅防同一标签页内重复,不防跨标签页 |
| 60s 定时重扫冷却 | `ozon-data-panel.js:362` | 60s 后 partial/failed SKU 再次触发,持续加压 |

#### 修复建议

1. **SW 侧并发限流**:在 `_doAutoCollect` 入口加全局并发计数器,超过阈值(如 3-5)时排队或丢弃
2. **重载检测**:content script 启动时检查 `chrome.runtime.onConnect` 或 `_startTime`,短时间内大量请求时自动退避
3. **Gate0 原子化**:用 MongoDB `findOneAndUpdate` 原子自增 `todayCount`,避免并发窗口

---

### 🔴 风险 2:超大 content script 全量重注入

**涉及文件**: `manifest.json`(content_scripts 配置)+ 全体 content JS

#### 数据

| 注入组 | 最大文件 | 单组总量 | 注入页面 |
| --- | --- | --- | --- |
| 主组(排除搜索/类目) | `ozon-product.js` 560KB | **~886KB** | 所有 ozon.ru/kz 页面(排除搜索/类目) |
| 搜索/类目组 | `ozon-search.js` 25KB | ~218KB | /search/*, /category/* |
| 数据面板组 | `ozon-data-panel.js` 58KB | ~110KB | 所有 ozon.ru/kz(排除搜索/类目) |
| pop 组 | `seller-info-main.js` 14KB | 14KB | /seller/*, /product/* (MAIN world) |

**关键发现**:非搜索/类目页面注入总量约 **886KB**(shared-utils 170KB + jzc-calc 84KB + ozon-product 560KB + 其他 lib 约 72KB)。

扩展重载时 Chrome 向 **所有匹配标签页同时注入**。假设 20 个标签页:

```
20 × 886KB = 17.7MB JavaScript 同时解析/编译/执行
```

每个标签页的渲染进程都要编译这些代码并执行顶层初始化逻辑(fetch PDP state、applyAll、hookHistory 等)。

**重点**:`ozon-product.js` **没有 run-once 守卫**:

```js
// ozon-product.js 开头 — 无防重入检查
(function () {
  'use strict';
  if (window.ensurePdpState) {
    window.ensurePdpState().catch(() => {});  // 立即发起网络请求
  }
  // ... 560KB 代码 ...
})();
```

对比 `ozon-bff-interceptor.js` 有守卫:

```js
if (window.__JZC_BFF_INTERCEPTOR_INSTALLED__) return;
window.__JZC_BFF_INTERCEPTOR_INSTALLED__ = true;
```

**影响**:内存敏感机器上可能触发标签页崩溃(Aw, Snap!)。

---

### 🟡 风险 3:`reloadOzonTabs()` 无错开重载 + 二次重注入

**涉及文件**:`qx-ozon/background/service-worker.js`

#### 代码

```js
// service-worker.js:272 — 全量同时 reload,无逐页错开
function reloadOzonTabs() {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(async () => {
      const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*', '*://*.ozon.kz/*'] });
      for (const tab of tabs) {
        chrome.tabs.reload(tab.id);  // ← 全部同时!无错开!
      }
    }, 300);  // 300ms debounce
}
```

对比 `reloadSellerTabs()` 有 500ms 逐页错开:

```js
// service-worker.js:4564 — 有逐页错开
const reloadSellerTabs = async () => {
    const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    for (let i = 0; i < tabs.length; i++) {
      setTimeout(() => chrome.tabs.reload(tabs[i].id), i * 500);  // ← 500ms 错开
    }
};
```

#### 触发链路

```
扩展重载
  → Chrome 自动向所有标签页重注入 content script(第一轮)
    → content script 中 sync-auth 等 init 完成
      → 向 SW 发 sendAuth 或 syncAuthFromWeb 消息
        → SW 判断 token/storeId 变化
          → reloadOzonTabs() → 全量标签页同时 reload(第二轮重注入)
```

**结果**:同一次扩展重载中 content script 被注入两轮 — Chrome 自动重注入 + `reloadOzonTabs` 触发的页面 reload 重注入。内存和 CPU 峰值叠加。

#### `reloadOzonTabs()` 被调用的 4 处

| 位置 | 触发场景 |
| --- | --- |
| `service-worker.js:5093` | `saveAuth` 保存 token 后 |
| `service-worker.js:5098` | `logout` 登出后 |
| `service-worker.js:5128` | `syncAuthFromWeb` 扩展采纳 Web token |
| `service-worker.js:5133` | `syncAuthFromWeb` 切换 storeId |

重载时 content script 重注入 → 发送 auth 同步消息 → 可能触发 `reloadOzonTabs` → 二次重注入。

---

### 🟡 风险 4:`onInstalled` + `reloadSellerTabs` 双重加载

**涉及文件**:`qx-ozon/background/service-worker.js`

#### 代码

```js
// service-worker.js:4572 — onInstalled handler
chrome.runtime.onInstalled.addListener(() => {
    // ... alarm 注册 ...
    // 异步重负载:错开执行
    setTimeout(() => reloadSellerTabs(), 4_000);  // ← 4 秒后重载所有 seller 标签页
});
```

`onInstalled` 时 Chrome **已经自动**向所有匹配标签页注入了 content script(MV3 行为),然后 4 秒后 `reloadSellerTabs()` 又把 seller.ozon.ru 标签页全部 reload。

**影响**:seller 标签页的 content script 在极短时间内被双重加载。第一轮注入的初始化工作(fetch、定时器、Observer)完全浪费。虽然不会直接崩溃,但增加了启动阶段的资源压力,与风险 2 叠加放大。

---

### 🟡 风险 5:`all_frames: true` 定时器放大

**涉及文件**:`qx-ozon/manifest.json` + `qx-ozon/content/ozon-premium-hook.js`

#### manifest 配置

```json
{
  "matches": ["https://seller.ozon.ru/app/analytics*"],
  "js": ["content/ozon-premium-hook.js"],
  "world": "MAIN",
  "run_at": "document_start",
  "all_frames": true    // ← 每个 iframe 都注入
}
```

#### 定时器代码

```js
// ozon-premium-hook.js:625 — 1 秒间隔,无条件运行
window.setInterval(() => {
    applyAll();       // patchXhr + patchFetch + patchJsonParsers + renderPanel
    checkUrlChange();
}, 1000);
```

`all_frames: true` 意味着 analytics 页中的 **每个 iframe** 都注入一份 hook + 一个 1 秒定时器。如果页面有 N 个 iframe = N 个并行定时器,每秒执行 N 次 `applyAll()`(含 fetch/XHR patch + DOM 渲染)。

扩展重载时所有 frame 同时重新注入,定时器数量瞬间翻倍(旧 frame 未销毁时新 frame 已注入)。

---

### 🟡 风险 6:MutationObserver 反馈循环

**涉及文件**:`qx-ozon/content/ozon-data-panel.js`

#### 代码

```js
// ozon-data-panel.js:915 — 监听 document.body 全树变化
const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
        pending = false;
        applyToAll();   // ← 为每个商品卡插入面板 → 修改 DOM → 触发自身 Observer
    });
});
observer.observe(document.body, { childList: true, subtree: true });
```

`applyToAll()` 为每个商品卡插入数据面板(修改 DOM),这会触发自己的 MutationObserver → `requestAnimationFrame` → `applyToAll()` → 又修改 DOM → 再次触发 Observer。

单实例靠 RAF 节流控制开销不大,但扩展重载后 **所有标签页同时启动这个循环**。配合 Ozon SPA 自身的 DOM 更新(页面懒加载、商品卡翻页),累积 CPU 负载不可忽视。

同样的模式也出现在 `ozon-product.js:3713`:

```js
// Ozon SPA 重新渲染时重建 sidebar card
const cardObserver = new MutationObserver(() => {
    if (document.contains(card)) return;
    cardObserver.disconnect();
    document.querySelectorAll('.ozon-helper-sidebar-card').forEach((el) => el.remove());
    setTimeout(createSidebarDataCard, 500);  // ← 重建 → 修改 DOM
});
cardObserver.observe(observeTarget, { childList: true, subtree: true });
```

---

## 三、修复优先级

| 优先级 | 问题 | 修复文件 | 建议措施 |
| --- | --- | --- | --- |
| P0 | autoCollect 消息风暴 | `service-worker.js`, `shared-utils.js` | SW 侧全局并发限流 + 原子化 Gate0 限额 |
| P0 | 超大 content script 重注入 | `ozon-product.js` | 添加 run-once 守卫;考虑动态注入(按需 `chrome.scripting.executeScript`) |
| P1 | `reloadOzonTabs()` 无错开 | `service-worker.js` | 逐页错开(对齐 `reloadSellerTabs` 的 `i * 500` 模式) |
| P1 | `onInstalled` 双重加载 | `service-worker.js` | 评估是否保留 `reloadSellerTabs`;若需保活,加 "最近重载" 防抖 |
| P2 | `all_frames` 定时器放大 | `ozon-premium-hook.js` | 仅 top frame 注入;iframe 中只做 hook 不做定时轮询 |
| P2 | MutationObserver 反馈循环 | `ozon-data-panel.js`, `ozon-product.js` | Observer 回调中先 disconnect 再操作 DOM,操作完再 observe |

---

## 四、附录:全量定时器/Observer 清单

### Service Worker 定时器

| 位置 | 类型 | 间隔 | 职责 |
| --- | --- | --- | --- |
| `service-worker.js:7128` | `setInterval` | 15s | keepAlive(每请求一个,handler 完成后清除) |
| `service-worker.js:1064` | `chrome.alarms` | 5min | 缓存同步 `syncL2Batch` |
| `service-worker.js:4259` | `chrome.alarms` | 配置 | 更新检查 `checkForUpdate` |
| `service-worker.js:4334` | `chrome.alarms` | 配置 | 跟卖任务检查 |
| `service-worker.js:4341` | `chrome.alarms` | 配置 | 心跳 |
| `service-worker.js:4369` | `chrome.alarms` | 配置 | 汇率刷新 |
| `service-worker.js:4404` | `chrome.alarms` | 配置 | Browser agent |
| `service-worker.js:4443` | `chrome.alarms` | 配置 | Client sync(多种) |

### Content Script 定时器

| 位置 | 类型 | 间隔 | 职责 |
| --- | --- | --- | --- |
| `ozon-data-panel.js:362` | `setInterval` | 60s | 采集重扫(partial/failed SKU) |
| `ozon-data-panel.js:384` | `setInterval` | 1s | UI 刷新(采集状态/倒计时) |
| `ozon-premium-hook.js:625` | `setInterval` | 1s | URL 变化检测 + 面板悬挂(× iframe 数) |
| `popup.js:229` | `setInterval` | 变动 | 短信倒计时 |
| `popup.js:756` | `setInterval` | 5s | 采集器监控 |
| `popup.js:808` | `setInterval` | 3s | Browser agent 状态 |
| `popup.js:948` | `setInterval` | 1s | 采集倒计时 |

### Content Script MutationObserver

| 位置 | 监听目标 | 配置 | 职责 |
| --- | --- | --- | --- |
| `ozon-data-panel.js:915` | `document.body` | childList + subtree | 商品卡变化 → applyToAll |
| `ozon-data-panel.js:1267` | `documentElement` | attributes(filtered) | 跨 world seller-info 读取 |
| `ozon-product.js:3713` | 父容器 | childList + subtree | sidebar card 被移除时重建 |
| `ozon-product.js:11988` | `documentElement` | attributes(filtered) | 跨 world PDP seller-info |
| `ozon-search.js:626` | — | — | 搜索页 DOM 变化 |
| `jzc-calc.js:1776` | — | — | 价格计算面板 |
| `seller-info-main.js:19` | — | — | seller-info 提取 |
| `shared-utils.js:1099` | — | — | — |

---

## 五、附录:`location.reload()` 调用清单

项目中共有 3 处 `location.reload()` 调用(不属于"重启浏览器"风险,仅记录):

| 位置 | 场景 | 影响 |
| --- | --- | --- |
| `service-worker.js:304` | `clearWebAuthTabs` 中 `executeScript` 清 localStorage 后 reload | 仅影响 ERP admin 标签页 |
| `shared-utils.js:1532` | 字段可见性/统计周期切换后 reload | 仅当前页面,用户主动触发 |
| `sync-auth.js:153` | 从扩展恢复 token 后 reload | 仅 ERP admin 标签页,有 sessionStorage 防循环 |

3 处均有合理防循环措施,不会导致 reload 死循环。