# ozon-webhook-proxy 设计说明

接收 Ozon 推送、以毫秒级回包保住 200 比例，再把事件可靠地转发给 ERP。
Go 1.22+，只用标准库，无第三方依赖。

## 1. 为什么要这一层

Ozon 推送侧的判定很硬：

- 单条消息 **5 秒内**必须响应；
- **200 比例低于 50%**，或**连续 24 小时报错**，Ozon 直接暂停该店铺的推送（恢复要人工去后台点，且暂停期间的事件不会补发，只能靠 List 接口回捞）。

原来 ERP（NUC 上 `yochylin.com:17443`，家用宽带上游）直接吃 Ozon 推送，问题在于：

| 风险 | 后果 |
| --- | --- |
| 家宽/DDNS 抖动、光猫重启、UPS 切换 | Ozon 侧连续报错 → 推送被暂停 |
| ERP 发版重启、event-poller 抢 CPU | 响应超时 |
| 公网到 nuc 的 TLS 握手慢 | 逼近 5s 判定线 |

把"接收"和"处理"解耦：接收端放在 **2.tencent.yochylin.com**（BGP 机房，和 Ozon 网络质量稳定），
ERP 挂了也不影响 Ozon 看到 200；消息在代理本地落盘，ERP 恢复后自动续投。

代理本身**不做业务**：不解析事件语义、不调 Ozon API、不改消息内容。它只保证
"收得到、存得住、按顺序送到"。

## 2. 目标 / 非目标

目标
- 接收路径 P99 < 50ms，且**不含任何出站网络等待**。
- 崩溃、断电、ERP 长时间不可达都不丢消息（至少一次投递）。
- 同一店铺的消息按接收顺序投递（保序）。
- 单二进制、静态编译、pm2 托管，运维方式和 mydns-go 一致。

非目标
- 不做 exactly-once（去重交给 ERP 的 `idempotency_key` UNIQUE 约束）。
- 不做消息内容转换/富化（业务在 ERP 里）。
- 不做多消费者水平扩展（这个量级用不上，见 §6）。
- 第一阶段不做代理↔ERP 的共享密钥校验（与 ERP 一起改，见 §8）。

## 3. 拓扑

```
Ozon (195.34.21.0/24 / 185.73.192.0/22 / 91.223.93.0/24)
   │  POST https://2.tencent.yochylin.com:17443/webhook/ozon
   ▼
nginx(17443, certbot TLS, proxy_set_header X-Real-IP $remote_addr)
   ▼
webhook-proxy(127.0.0.1:3002)          ← 本组件
   ├─ 落盘 data/spool/pending/<seq>.json（tmp→fsync→rename→fsync dir）
   ├─ 立刻回 200 {"result":true}        ← Ozon 只看到这一步
   └─ 单 worker 按 FIFO 转发
        │  POST https://yochylin.com:17443/webhook/ozon
        │  X-Forwarded-For: <Ozon 真实源 IP>
        ▼
      ERP erp-backend-lite(nginx→3001)  ipWhitelist → insertEvent → 200
```

`/webhook/ozon` 之外还有 `/webhook/health`（探活 + 运行指标）。

Ozon 注册回调按域名走，切 URL 不需要逐店铺改，一封邮件给 `sapi-push@ozon.ru`（约 3 个工作日）。

## 4. 数据流与契约

### 4.1 接收侧（`internal/proxy/server.go`）

只做四件事，全部是内存 + 一次文件写：

1. 读 body（上限 `MAX_BODY_BYTES`，默认 50MB，对齐 ERP 的 `express.json` limit）；
2. `json.Unmarshal` **只取 `message_type` 一个字段**用于分流；
3. `TYPE_PING` 本地应答 `{version,name,time}`（`Content-Type: application/json`，
   否则 Ozon 判 `INVALID_BODY`）；其余消息落盘；
4. 回 `200 {"result":true}`。

响应码策略（这一条决定了 Ozon 会不会暂停推送）：

| 情况 | 回给 Ozon | 理由 |
| --- | --- | --- |
| 正常接收 | `200 {"result":true}` | 保 200 比例 |
| `message_type` 缺失 / JSON 非法 / body 超限 | `400 ERROR_PARAMETER_VALUE_MISSED` | 本来就不是有效事件 |
| **落盘失败**（磁盘满、只读、IO 错误） | `500 ERROR_UNKNOWN` | 假成功回 200 = 消息永久丢失；回 5xx 让 Ozon 按它自己的策略重投，我们只是延迟暴露故障 |
| 非 POST | `405 ERROR_UNKNOWN` | — |

注意 **ERP 的成败完全不参与给 Ozon 的响应码**：转发失败只进队列重试，绝不回头去骗 Ozon。

### 4.2 落盘格式（`internal/spool`）

一条消息一个文件，`pending/1790819353184160000-000002-TYPE_NEW_POSTING.json`：
纳秒时间戳 + 序号 + message_type，**按文件名排序即接收顺序**。

```json
{"seq":2,"received_ms":1790819353184,"src_ip":"195.34.21.77",
 "message_type":"TYPE_NEW_POSTING","payload":{"原始字节":1812345678901234567}}
```

写路径：`O_EXCL` 临时文件 → `Write` → `File.Sync()` → `Rename` → `fsync` 目录。
rename 是原子的，所以崩溃只会留下 `.tmp` 半截文件（`Pending()` 只认 `.json`，自动忽略），
不会出现"半个消息进队列"。

`payload` 用 `json.RawMessage` 原样存、原样发。**这是本设计最容易踩的坑**：
ERP 的幂等键是 `message_type + 字段明文` 拼接（`services/webhook/idempotency.js`），
而 `product_id`、`sku` 是 19 位整数。一旦代理用 `map[string]any` 中转再序列化，
这些数会走 float64 变成 `1.8123456789012346e+18`，幂等键跟着变，
Ozon 的重投就变成 ERP 里的重复事件。`TestPayloadBigIntByteFidelity` 和
`TestForwardPreservesBytesAndSourceIP` 分别钉住落盘和转发两端的字节保真。

三个目录：
- `pending/` 待转发；
- `dead/` 永久失败（+ 同名 `.reason` 边车文件）；文件仍是完整 envelope，
  `jq .payload xxx.json | curl --data-binary @-` 可直接手工重放；
- 没有 acked 目录——成功即删除。

### 4.3 转发侧（`internal/proxy/forwarder.go`）

单 goroutine，`select` ticker(1s) / wake（新消息入队立即唤醒）：

- 每次扫 `pending`，**遇到队头处于退避窗口就立刻停手**，不许后面的消息插队
  （`TestHeadOfLineBlockingKeepsOrder`）。同一 posting 的
  `TYPE_NEW_POSTING` → `TYPE_POSTING_CHANGED` 乱序进 ERP 会算错订单状态，
  代价是队头卡住会放大延迟——用告警兜底（见 §5）。
- HTTP 结果分流：

| ERP 响应 | 处理 |
| --- | --- |
| 2xx | 删文件，`Forwarded++`，连续失败清零 |
| 传输错误 / 5xx / 429 | 退避重试，最多 `MAX_RETRIES`（默认 200）次后进 `dead` |
| 其他 4xx（403 白名单、400 入参） | 直接进 `dead` + 飞书告警——重试不可能变成功，等着的只会是配置被修好 |

- 退避：`1s · 2^(n-1)`，封顶 `RETRY_MAX`（默认 5m），叠加 ±20% 抖动
  （避免 ERP 恢复瞬间积压消息一起重发把它再打倒一次）。
- 请求头：`Content-Type: application/json`、`X-Forwarded-For: <Ozon 真实源 IP>`、
  可选 `X-Webhook-Proxy: <PROXY_TOKEN>`。
  ERP 的 `ipWhitelist` 取 **XFF 首段**去比对 Ozon 三段 CIDR，所以源 IP 必须透传，
  否则一律 403（而 403 在代理这边是"永久失败"，会误杀全部消息——所以这条有专门测试）。

## 5. 失败模式与可观测

`GET /webhook/health` 返回：

```json
{"status":"ok","name":"ozon-erp","version":"2.0.0","role":"webhook-proxy",
 "proxy":{"received":2,"forwarded":1,"dead":0,"queue_depth":1,
          "oldest_age_seconds":3.2,"consecutive_failures":1,
          "erp_reachable":false,"last_forward_ok":"...","last_failure":"...",
          "last_forward_ms":97}}
```

| 故障 | 表现 | 结果 |
| --- | --- | --- |
| ERP 不可达（家宽断、发版） | `queue_depth` 增长、`erp_reachable=false`，退避重试 | Ozon 侧无感，恢复后自动续投 |
| 队头滞留 > `ALERT_STALE_AFTER`(10m) | 飞书 `stale` 告警 | 人工介入，消息不丢 |
| 连续 `ALERT_CONSEC_FAIL`(5) 条失败 | 飞书 `erp-unreachable` 告警（按类别 10min 限频） | — |
| ERP 回 4xx | 进 `dead` + 飞书 `dead` 告警 | 手工修配置后从 `dead` 重放 |
| 磁盘满 / 只读 | 回 5xx，Ozon 重投；日志 `[server] 落盘失败` | 消息在 Ozon 侧，不丢 |
| 代理进程崩溃/重启 | pm2 拉起，`Open()` 重新扫 `pending` | 未转发完的继续投（至少一次） |
| ERP 处理慢导致 Ozon 重投同一事件 | 代理各存一份并各投一次 | ERP 幂等键吸收重复 |

日志走 stderr，由 `start.sh` 的 `2>&1` 交给 pm2 收（和 mydns-go 一致）。

## 6. 容量

6 个店铺、每天几百到几千条，峰值按 10 msg/s 算：单 worker + 8s 超时的转发完全够
（一条 100ms 的话吞吐 10/s，够；不够时积压只体现在 `queue_depth`，不影响接收）。
文件队列在这个量级下 inode 和目录扫描都不是问题，因此**不引入 SQLite/WAL/内存索引**——
换来的收益是崩溃恢复天然正确，以及 `dead/` 目录对运维直接可读。

## 7. 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTEN_ADDR` | `127.0.0.1:3002` | 只绑回环，公网入口是 nginx。3002 是当年独立 webhook 服务 retire 掉的端口 |
| `TARGET_URL` | `https://yochylin.com:17443/webhook/ozon` | ERP 接收端点。**用 apex 域名**：`yochylin.com` 与 `nuc.yochylin.com` 解析到同一台机器，但证书 SAN 只有 `yochylin.com`/`www.yochylin.com`，按 `nuc.` 做 TLS 校验会失败。代码里不提供 `InsecureSkipVerify` 选项——Ozon 事件带订单和买家信息，跳校验不可接受 |
| `SPOOL_DIR` | `./data/spool` | 落盘目录 |
| `APP_NAME` / `APP_VERSION` | `ozon-erp` / `2.0.0` | PING 回包内容，**必须与 ERP 一致**，Ozon 后台展示的就是它 |
| `MAX_BODY_BYTES` | `52428800` | 入站 body 上限 |
| `FORWARD_TIMEOUT` | `8s` | 单次转发超时（异步，不影响 Ozon 侧时延） |
| `MAX_RETRIES` | `200` | 超过进 `dead` |
| `RETRY_MAX` | `5m` | 退避封顶 |
| `DRAIN_TIMEOUT` | `10s` | 退出时等在途转发 |
| `ALERT_CONSEC_FAIL` / `ALERT_STALE_AFTER` | `5` / `10m` | 告警阈值 |
| `FEISHU_BOT_TOKEN` | 空 | 空则只打日志，不发外网 |
| `PROXY_TOKEN` | 空 | 与 ERP 的共享密钥；生产两边均已配置并生效（2026-10-01） |

## 8. 第二阶段（2026-10-01 已在生产启用）

1. **共享密钥**（代理发、ERP 验，两侧 `ipWhitelist` 判定已上线）：
   ERP 配了 `PROXY_TOKEN` 后**只认 `X-Webhook-Proxy` 头**，不再看 `X-Forwarded-For` 的
   Ozon CIDR——那个头谁都能自造，冒充 `195.34.21.0/24` 并不困难。比对用
   `crypto.timingSafeEqual`（定长缓冲）。**没配 `PROXY_TOKEN` 时行为与原来完全一致**（只按 CIDR）。
   启用/改值的顺序**必须先重启代理、再重启 ERP**：反过来的窗口里，代理发的请求还没带上（新）密钥，
   ERP 已经只认头 → 403，而代理把 4xx 判成永久失败进 `dead/`，Ozon 那边早已拿到 200 不再重投，消息就丢了。
   前提是 Ozon 的回调 URL 已指向本代理——直推 ERP 的流量会被全部 403。
   更彻底的做法是 ERP 侧 nginx 限制 17443 来源为 tencent 出口 IP，可与之并存。
2. **`processing` 状态回收**（ERP 侧）：`claimPendingEvents` 现在写 `claimed_at`；
   poller 启动时把残留 `processing` 全部放回 pending（此刻本进程不可能有在途 handler），
   运行期每 60s 扫一次，`claimed_at` 超过 `POLLER_STALE_RECLAIM_MS`（默认 10min）的放回 pending
   并 `retry_count+1`，所以有毒事件仍按 `POLLER_MAX_RETRY` 收敛到 dead，不会无限循环。
   代价：真正跑超 10 分钟的 handler 会被重复处理一次——对秒级完成的 Ozon API 调用足够宽。
   新列由 `initSchema()` 里的 `PRAGMA table_info` + `ALTER TABLE` 补，存量 `processing` 回填 `received_at`。
3. **投递指标**：`/webhook/health` 已经吐了 `queue_depth`/`oldest_age_seconds`，
   可以接监控（现在只有飞书告警）。

ERP 侧改动由 `erp-backend-lite/test/webhook-phase2.e2e.js` 验证（跑在 `ERP_DATA_DIR` 指的一次性空库里，
不碰开发库事件）。

## 9. 测试覆盖

| 测试 | 钉住的行为 |
| --- | --- |
| `TestAckReturnsResultTrue` | 回 200 时**只落盘、未转发**（响应时延与 ERP 无关） |
| `TestPingAnsweredLocally` | PING 不进队列、`application/json`、version/name/time |
| `TestBadRequestsGetOzonErrorTemplate` | 400/405 用 Ozon 的错误模板 |
| `TestOversizedBodyRejected` | 超限 body 不入队 |
| `TestPayloadBigIntByteFidelity` | 19 位整数落盘后仍是原始字面量 |
| `TestForwardPreservesBytesAndSourceIP` | 转发字节一致 + XFF 单值 + 密钥头 |
| `TestClientIPFromRealIPOrRemoteAddr` | nginx 只给 X-Real-IP 时也能取到源 IP |
| `TestHeadOfLineBlockingKeepsOrder` | 队头失败时后面的不许先投 |
| `TestServerErrorRetriesForeverThenSucceeds` | 5xx 保留消息、恢复后投出 |
| `TestTransportFailureKeepsEventForRetry` | 连不上不丢、退避期间不重试 |
| `TestClientErrorGoesToDead` / `TestMaxRetriesSendsToDead` | 4xx 与超限进 dead |
| `TestUnreadableSpoolFileGoesToDead` | 坏文件不阻塞队列 |
| `TestBackoffGrowsAndCaps` | 退避增长、封顶、抖动区间 |
| `TestReopenKeepsPending` | 重启后 pending 顺序不变 |

`go test -race ./...`。
