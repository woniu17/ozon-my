# Ozon 端点访问耗时监控 — 概要设计文档

> 版本:v0.1(雏形)
> 日期:2026-08-25
> 模块:qxqx/{deep-collect,shallow-collect,backfill-store-stats}.js + erp-backend-lite
> 语义基准:三脚本现有 Ozon 内部 API 调用(8 端点,见 §2)

---

## 1. 背景与目标

### 1.1 现状问题

三个无头采集脚本直接调用 Ozon 前端内部 API(非官方 API),目前对调用耗时**零观测**:

- CDN 降速、反爬限流(429/403)、出口 IP 被标记等问题**只能靠任务失败率间接推断**
- 无法回答"哪个端点在什么时段、从哪台机器/哪个出口 IP 变慢了"
- 图片下载曾有 Headers Timeout 教训(项目约束:并发 4 + headersTimeout 10s),端点级耗时数据可提前暴露此类劣化

### 1.2 设计目标

1. **全端点覆盖**:三脚本全部 8 个 Ozon 端点调用自动埋点,采集主流程零侵入(监控失败不影响采集)
2. **三维度归因**:`客户端出口 IP` + `脚本运行机器` + `浏览器 profile`,任意组合筛选
3. **时间轴展示**:ERP admin 页面按端点分组的时间轴图 + 分位统计
4. **数据通道 ERP API 化**:与采集数据通道一致(x-api-key 鉴权),不直连 SQLite

非目标(本期不做):
- 请求/响应 body 采集(体积大、含敏感 cookie 语义)
- 插件(qx-ozon)侧埋点(后续可复用同一上报接口)
- 告警/通知

---

## 2. 监控对象:8 个端点清单

埋点统一用**稳定枚举 code**(URL 含动态参数,不做主键):

| code | 域 | 实际 URL | 方法 | 脚本 | 用途 |
|---|---|---|---|---|---|
| `www.entrypoint.product` | www | `/api/entrypoint-api.bx/page/json/v2?url=/product/...` | GET | deep | richMedia/detail 主端点 |
| `www.composer.product` | www | `/api/composer-api.bx/page/json/v2?url=/product/...` | GET | deep | richMedia 备用端点 |
| `www.composer.offers-modal` | www | 同上 `url=/modal/otherOffersFromSellers` | GET | deep | followSell 其他卖家报价 |
| `seller.analytics.v3` | seller | `/api/site/seller-analytics/what_to_sell/data/v3` | POST | deep | marketStats |
| `seller.search` | seller | `/api/v1/search` | POST | deep | search(类目门控B数据源) |
| `seller.create-bundle` | seller | `/api/site/seller-prototype/create-bundle-by-variant-id` | POST | deep | bundle 属性 |
| `www.entrypoint.seller-list` | www | `/api/entrypoint-api.bx/page/json/v2?url=/seller/<id>/...` | GET | shallow | 店铺商品列表翻页 |
| `www.entrypoint.shop-info` | www | 同上 `url=/modal/shop-in-shop-info` | GET | backfill | 店铺统计弹窗 |

---

## 3. 总体架构

```
┌─ 采集机器(每台) ────────────────────────────────────────────┐
│ qxqx 脚本(deep / shallow / backfill)                       │
│                                                              │
│  ┌─ 浏览器上下文(注入函数,自包含铁律) ─────────────────┐   │
│  │  fetch 前后 performance.now() 计时                  │   │
│  │  返回值附带 timing:{startedAt,durationMs,status}    │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         ↓ Node 侧                            │
│  metric 组装:{code, sku, timing, machineId, profileId,     │
│               clientIp, script, ok, errorKind}              │
│                         ↓ 内存缓冲(§5.3)                    │
│  定时/定量/退出 flush ──→ POST /admin/api/endpoint-metrics/batch │
│                                                              │
│  出口 IP 后台探测:启动时 + 每 30min(§5.1)                 │
└──────────────────────────┬───────────────────────────────────┘
                           ↓ x-api-key
┌─ ERP(nuc) ─────────────────────────────────────────────────┐
│  metrics 模块(新) → SQLite ozon_endpoint_metrics(§6)      │
│  定时清理:保留 N 天(默认 30)                              │
│                                                              │
│  admin 前端 EndpointMetrics.vue(§8):筛选 + 时间轴 + 统计表  │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 维度定义

| 维度 | 字段 | 取值方式 |
|---|---|---|
| 客户端 IP | `client_ip` | 脚本侧定时探测公网出口(env `IP_PROBE_URL`,默认 `https://api.ip.sb/ip`,备选 ifconfig.me/ipinfo.io);启动 1 次 + 每 30min 刷新,失败保留上次值,从未成功则为 `unknown` |
| 机器 | `machine_id` | env `MACHINE_ID` 优先,fallback `os.hostname()`(nuc 上即 `nuc`) |
| profile | `profile_id` | profile 目录名(`.chrome-profile` / `.ozon-profile`),或 env `PROFILE_ID` 覆盖 |

补充:三个维度**冗余存储到每条记录**(便于直接索引查询,不做关联表)。

---

## 5. 采集脚本侧设计(qxqx)

### 5.1 公共模块 `qxqx/metrics.js`(新建,三脚本共用)

```js
// 职责:
// 1. 出口 IP 探测缓存(startIpProbe: 启动 + setInterval 30min)
// 2. metric 缓冲队列:add(metric) → 满 20 条 / 每 30s / flush 事件触发上报
// 3. 上报:erpFetch('POST', '/admin/api/endpoint-metrics/batch', { items })
//    失败静默丢弃(计数 console.warn),监控数据不影响采集主流程
// 4. 退出钩子:SIGINT/正常结束前 flush(finalizeMetrics)
// machine_id/profile_id 从模块初始化参数取
```

### 5.2 注入函数埋点(浏览器上下文)

**铁律约束**:注入函数自包含(page.evaluate 无闭包),计时逻辑必须写在注入函数内部。

改动点(每处约 +6 行):

| 注入函数 | 脚本 | 埋点 |
|---|---|---|
| `PORTAL_FETCH_FN` | deep | 三个卖家 API 统一在此函数计时,返回值加 `timing` |
| richMedia 端点队列(内联 fetch 循环) | deep | 每个 endpoint fetch 单独计时 |
| `FOLLOW_SELL_MODAL_FN` | deep | 已有 AbortController 计时点,补 duration |
| `FETCH_PAGE_FN` | shallow | 每页 fetch 计时 |
| `EXTRACT_STATS_FN` | backfill | 单次 fetch 计时 |

统一计时语义:

```js
const t0 = performance.now();
// ... fetch + 解析 ...
return { ..., __timing: {
  startedAt: new Date(t0).toISOString(),   // performance.timeOrigin + t0 更精确,雏形用 Date.now() 近似亦可
  durationMs: Math.round(performance.now() - t0),
  status: resp.status,                      // HTTP 状态码
}};
```

### 5.3 缓冲与上报策略

- **触发**:满 20 条 / 每 30s 定时 / 脚本 finalize(退出前必 flush)
- **失败**:静默丢弃 + `console.warn` 计数,不重试不落盘(监控数据允许丢失,换实现简单)
- **顺序**:metric 上报与采集结果上报相互独立,不合并(避免耦合 auto-collect/log 语义)

### 5.4 数据量估算

| 场景 | 每单元请求数 | 估算 |
|---|---|---|
| deep 每 SKU | 3(seller)+ 2~4(richMedia 队列)+ 1(followSell)+ 页面导航不计 | ~6-8 条 |
| shallow 每店铺 | 列表页数(通常 2-5) | ~3 条 |
| backfill 每店铺 | 1 | 1 条 |

日采 5000 SKU + 500 店铺 ≈ **3.5~4.5 万条/天**,单条 ~200B,日增 ~9MB。30 天保留期内 SQLite 轻松承载(现库已 4GB+)。

---

## 6. 存储设计

### 6.1 表结构 `ozon_endpoint_metrics`

```sql
CREATE TABLE IF NOT EXISTS ozon_endpoint_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,            -- ISO8601 请求发起时间(浏览器侧 startedAt)
  endpoint     TEXT NOT NULL,            -- §2 枚举 code,如 'seller.search'
  domain       TEXT NOT NULL,            -- 'www' | 'seller'
  method       TEXT DEFAULT 'GET',
  script       TEXT NOT NULL,            -- 'deep' | 'shallow' | 'backfill'
  sku          TEXT,                     -- deep 部分端点有
  seller_id    TEXT,                     -- shallow/backfill 有
  status_code  INTEGER,                  -- HTTP 状态码(网络失败为 NULL)
  duration_ms  INTEGER NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 1,  -- 业务成功(2xx 且解析出数据)
  error_kind   TEXT,                     -- 'HTTP_403'|'HTTP_429'|'TIMEOUT'|'NET_*'|'PARSE_FAIL'|'ANTIBOT'
  machine_id   TEXT NOT NULL,
  client_ip    TEXT,
  profile_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_epm_ts              ON ozon_endpoint_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_epm_endpoint_ts     ON ozon_endpoint_metrics(endpoint, ts);
CREATE INDEX IF NOT EXISTS idx_epm_machine_ts      ON ozon_endpoint_metrics(machine_id, ts);
```

### 6.2 保留策略

ERP 侧定时任务(复用 index-sync 调度或独立 setInterval):每日 `DELETE WHERE ts < now - N 天`(默认 N=30,env `METRICS_RETENTION_DAYS` 可配)。

---

## 7. ERP 接口设计(新模块 `src/modules/endpoint-metrics.js`)

| 路由 | 方法 | 说明 |
|---|---|---|
| `/admin/api/endpoint-metrics/batch` | POST | 批量写入,body `{items:[...]}`;单批上限 200 条;字段白名单 + 校验(脚本枚举校验 endpoint code);返回 `{ok:true,data:{inserted:n}}`(**注意 ok() 包装,吸取 collect-runner.js resp?.items 教训**) |
| `/admin/api/endpoint-metrics/query` | GET | 时间轴查询,参数见下 |
| `/admin/api/endpoint-metrics/dims` | GET | 返回各维度可用值(供筛选下拉) |

### 7.1 query 参数

```
from, to          ISO8601(必填,to-from ≤ 7 天)
endpoints         逗号分隔 code(空=全部)
machines          逗号分隔
profiles          逗号分隔
ips               逗号分隔
scripts           逗号分隔
bucket            聚合桶:1m|5m|1h(默认 5m;按 bucket+endpoint+维度聚合)
```

### 7.2 query 返回

```json
{
  "ok": true,
  "data": {
    "series": [
      { "endpoint": "seller.search", "bucketTs": "2026-08-25T06:50:00Z",
        "count": 42, "p50": 812, "p95": 2100, "avg": 940, "errCount": 3 }
    ],
    "stats": [
      { "endpoint": "seller.search", "total": 12000, "p50": 800, "p95": 2000,
        "avg": 920, "errRate": 0.021 }
    ]
  }
}
```

分位数:SQLite 无内置 percentile,雏形用 `GROUP BY bucket` 拉原始 duration 到 Node 侧计算(7 天窗口内单端点桶数据量可控),后续可换扩展。

---

## 8. 前端页面 `web/src/views/EndpointMetrics.vue`

- **路由**:`/endpoint-metrics`,菜单"端点耗时"(管理区)
- **筛选栏**:时间范围(默认近 1h,快捷 1h/6h/24h/7d)+ 端点/机器/profile/IP/脚本 多选(dims 接口填充)
- **主视图**:时间轴图——X=时间(按 bucket),Y=耗时 ms,每个端点一条序列(可勾选显隐),默认展示 p95 折线 + p50 淡色带;悬浮显示 count/errCount
- **辅助视图**:分端点统计表(§7.2 stats:总量/p50/p95/avg/错误率,按当前筛选)
- **图表实现决策点**:见 §9-D1

---

## 9. 决策点(需确认)

| # | 决策 | 选项 | 倾向 |
|---|---|---|---|
| D1 | 时间轴图表库 | a) 引入 ECharts(~1MB,功能全) b) 纯 SVG 自绘折线(零依赖,雏形够用) | b(先跑通,后续要交互再升级 a) |
| D2 | IP 探测服务 | api.ip.sb / ifconfig.me / ipinfo.io(env 可切) | api.ip.sb,失败自动标记 unknown |
| D3 | 上报失败兜底 | a) 静默丢弃(本设计) b) 落盘 pending 文件下次启动补报 | a(简单,监控允许丢) |
| D4 | 保留期 | 30 / 60 / 90 天 | 30 |
| D5 | 范围 | 仅 qxqx 三脚本(本设计) / 连 qx-ozon 插件一起 | 先 qxqx,插件复用 batch 接口留扩展 |

---

## 10. 实施拆解(依赖序)

| 步骤 | 内容 | 依赖 |
|---|---|---|
| P1 | ERP:建表(schema.sql)+ endpoint-metrics.js 模块(3 路由)+ 保留期清理 | 无 |
| P2 | qxqx/metrics.js 公共模块(缓冲/上报/IP 探测) | P1 |
| P3 | deep-collect.js 五处注入函数埋点 + 接入 metrics.js | P2 |
| P4 | shallow/backfill 埋点 + 接入 | P2 |
| P5 | 前端 EndpointMetrics.vue(筛选 + SVG 时间轴 + 统计表)+ 路由菜单 | P1 |
| P6 | nuc 部署验证:小批量(LIMIT=10)→ 观察数据 → 全量 | P1-P5 |

---

## 11. 风险与约束

- **注入函数自包含**:计时代码必须内联,禁止闭包引用 metrics 模块(通过返回值带出)
- **性能开销**:performance.now() 计时 + 返回值多一个字段,开销可忽略;缓冲 flush 与采集请求错峰(定时器 30s 与 SKU 间隔天然错开)
- **ok() 包装**:所有新接口响应 `{ok:true,data}` 与前端 api 封装对齐(2026-08-25 collect-runner resp?.items 教训)
- **Ozon 改端点**:code 枚举与 URL 解耦,URL 变更只需改映射注释,历史数据 code 不变
