# ozon-tasks

把 httpsrv 里两个 Ozon 定时任务从 Node 侧接管过来，用 Go 独立实现：

1. **定时器续期 + 最低价钉死** — Ozon 要求周期性刷新商品定时器，掉档就失去自动调价资格；同时把 `min_price` 钉在 `price-0.01`。
2. **促销活动商品自动撤下** — 把店铺参与的所有官方活动里的商品批量移除，不被活动价拖着走。

存储从 MongoDB 换成单文件 SQLite；配置沿用 httpsrv 那份 `.env`（同一套字段名），两个程序可以共用一份文件。

## 快速开始

```bash
cp example.env .env        # 填真实店铺凭据；.env 已在 .gitignore 里
make build                  # 产物 bin/ozon-tasks

./bin/ozon-tasks check      # 只看解析后的配置和调度单元，不建库、不碰接口
./bin/ozon-tasks once -dry-run   # 影子模式跑一班：照常查询统计，一条写请求都不发
./bin/ozon-tasks status     # 读台账汇报排期、租约、扫描进度、价格统计
./bin/ozon-tasks run        # 常驻，按排期自驱动
```

`make all` = fmt + vet + test + build。给 nuc（linux/amd64）出包用 `make linux`，纯 Go 的 sqlite 驱动所以 `CGO_ENABLED=0` 也能静态编译。

## 子命令

| 命令 | 作用 |
|---|---|
| `run`（默认） | 常驻进程，每个调度单元一条 goroutine 各自按排期走 |
| `once` | 只跑一班就退出，到班判定与租约去重照常生效（适合 systemd timer / 手工补班） |
| `once -force` | 无视到班判定立即执行一班，但仍不越过正在执行的租约 |
| `check` | 打印解析后的配置与调度单元。**故意不打开 SQLite**：「看一眼配置」不该顺手建出库文件 |
| `status` | 读台账打印，默认零接口调用；`-remote` 额外做只读定时器巡检 |
| `version` | 版本号 |

公共选项：`-task all\|timer\|deactivate`、`-group 组名`、`-shop 店名,店名`（与 `-group` 互斥）、`-dry-run`、`-env`、`-db`。

选项是按子命令注册的：`status -dry-run` 这种会直接报错而不是静默忽略——把 `-dry-run` 打错成 `-dryrun` 之后「以为在演练、其实真在写」是最不能接受的一种失败。

## 调度模型

不是照搬 Node 侧的「每轮 sleep 到冷却期结束」，而是：

- **cron 固定时刻**触发（`internal/cronx`，5 段 cron + `@daily/@hourly/@every`）。排期优先级：分组 `schedule` > 全局 `OZON_*_SCHEDULE` > `@every <冷却期>`。没配排期时节拍和 JS 侧完全一致，切换期可以只动冷却期不动排期。
- **数据库租约防重入**（`task_slots`）：抢到才跑，跑的时候按 1/3 TTL 续心跳，进程崩了别人在 TTL 到期后接管。班次以 `planned_at` 做去重键，积压的多个班次只跑最近一班。
- **只有失败才退避**：上一班状态不是 `ok` 时才要求间隔 `OZON_TASK_BACKOFF`，成功过就不参与判定——否则「每 2 小时」会被冷却参数悄悄降成「每 10 小时」。
- **分页扫描 + 断点游标**（`sweep_cursors`）：一轮扫到一半失败，下次从游标续跑而不是重头再提交一遍。游标超过 6 小时没更新就作废（配置可能已经变了）。
- **每店令牌桶限速** + **跨店有限并发**（店内串行）：Ozon 配额按 `client-id` 计，所以桶是每店一个。

## 配置

见 `example.env`，逐项有注释。要点：

- 时长只接受 `1d2h30m15s` 这种人性化写法，写纯毫秒数直接报错拒绝启动（和 JS 版一致，防手滑）。
- cron 只接受 5 段式，4 段/6 段（带秒）一律拒绝——那是「看着配上了但永远不触发」的最常见来源。启动时校验，不等到该跑的时候才发现。
- `OZON_API_RPS=0` 表示不限速（即 JS 侧原有行为）。
- 校验不过 = 拒绝启动并打印原因，绝不带病跑。

## 部署约束

**一台机器管全部店铺。** 去重靠 SQLite，而它的文件锁只在同一个文件系统内有效——两台机器各存一份库等于没有去重，会同时往 Ozon 发同一批写请求。要横向扩就按分组把店铺拆到不同机器上（每台一份库、一组店铺）。

`.env` 里 `MACHINE_NAME` 会写进台账与通知落款，多机排查靠它认来源。

这个二进制**没有 HTTP 监听、没有鉴权**，所有查询都走本地 SQLite。不要为了「远程看状态」给它开端口。

## 目录

```
cmd/ozon-tasks/     CLI：子命令、调度单元展开、status 渲染
internal/config/    .env 方言解析 + 启动校验
internal/cronx/     cron/@every 解析，Next() 从计划时刻续算（不漂移）
internal/durx/      人性化时长解析（config 和 cronx 共用，避免互相依赖）
internal/ledger/    SQLite：价格台账 / 任务槽租约 / 扫描游标
internal/ozon/      手写 Ozon Seller API 客户端：重试退避、令牌桶、分页 sweep
internal/sched/     单个调度单元的到班判定与执行（Loop / Run / Due）
internal/task/      两个业务任务 + 飞书通知文案 + 只读巡检
internal/logx/      带标签的日志（logx.Tag，不再是进程级全局前缀）
internal/feishu/    webhook 发送
```

除 `modernc.org/sqlite` 外零第三方依赖，Ozon 协议是标准库手写的。

## 测试

`make test`；`make race` 单独跑竞态检测。测试里对 Ozon 和飞书都用 `httptest` 桩，不碰真实接口。

关键覆盖：断点续跑（失败后不留重复提交）、游标不前进时在交给 `onPage` **之前**就收手（否则同一页商品被重复改价）、跨店并发有上限、干跑模式零写请求、`.env` 各方言兼容、飞书文案与 JS 逐字对齐、`-shop` 只限定店铺范围而不越权限定任务（`-task deactivate -shop X` 绝不能跑去改价）。

### 真写路径演练

`-dry-run` 只能证明「读到了什么、打算写什么」，证明不了写请求真的按预期发出去。要验这一段就把接口地址挪到本地假服务：

```bash
OZON_API_BASE_URL=http://127.0.0.1:9555 ozon-tasks once -task timer -shop YQL01 -db /tmp/rehearsal.db
```

真实凭据、真实的分页与限速、真实的落库，唯一的区别是所有请求打到 `127.0.0.1`。非官方地址会在启动时打一条醒目警告——不然「演练通过」和「真的改到了价」在日志里长得一模一样。

飞书 webhook 的地址写死在 `open.feishu.cn`，演练时喂一个格式合法的假 UUID 别名（`FEISHU_BOT_LOCAL=00000000-...` + `OZON_FEISHU_WEBHOOK_URL=LOCAL`）即可：发送会失败并记日志，文案照样完整打在 stdout 上。

## 与 Node 侧并存期间

冷却/排期状态各存各的（Mongo vs SQLite），**同一时刻只应该有一侧真正执行写操作**。切流前先用 `once -dry-run` 对照两边的统计量。

注意：httpsrv 的 `GET /api/ozon-prices/*` 读的是 MongoDB。Go 侧接管定时器任务之后，价格页面会失去数据源——要么 JS 继续跑，要么把 SQLite 台账导出/回灌 Mongo。这一条还没定。
