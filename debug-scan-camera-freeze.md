# Debug Session: scan-camera-freeze

- 日期: 2026-10-14
- 症状: 扫描发货 H5（安卓 Chrome，https://yochylin.com:17443/miniapp/）摄像头预览运行数分钟后卡顿/冻结。已做三轮修复仍存在：①原生 BarcodeDetector 直连 video；②480x360 小画布检测；③每 2 分钟重启摄像头流（仅换 srcObject）。
- 复现: 手机打开扫码遮罩，放置数分钟，预览画面逐渐卡顿直至冻结。
- 环境: 用户安卓手机 + Chrome（支持 BarcodeDetector，走原生路径）；页面 HTTPS 公网入口。

## 证据通道
- 手机页面为 HTTPS，本地 Debug Server 为 HTTP → 混合内容被拦截，bundled Debug Server 不可达。
- 改用项目自身后端作为日志汇集点（同源免混合内容）:
  `POST /debug/scan-perf`（NDJSON 落盘 `/tmp/scan-cam-freeze.ndjson`，上限 5MB）；`GET /debug/scan-perf`（查看尾部）；`DELETE /debug/scan-perf`（清空）。
- 前端屏上诊断 overlay：三击遮罩内"识别引擎"行开关（localStorage 记忆），冻结现场可直接截图。
- 本地证据目录（如桌面复现使用）: C:\Users\linqx\AppData\Local\Temp\trae-debug\scan-camera-freeze

## 采集指标（每 2s 采样）
t(运行秒) / dt(采样间隔) / vis(后台) / rdy(readyState) / tf+Δ(totalVideoFrames) / df(dropped) / rvfc+Δ(已呈现帧计数, requestVideoFrameCallback) / trk(轨道帧率) / heap(JS堆MB) / det,detMax(detect耗时ms) / rst(重启次数) + track mute/unmute/ended 事件 + 判定文本。

## 假设（可证伪）
| ID | 假设 | 观测点 | 状态 |
|----|------|--------|------|
| H1 | video 元素合成层卡死：MediaStream 仍产帧但元素不再呈现新帧；2 分钟重启只换 srcObject 不重建元素，无法恢复 | rvfcΔ=0 且 tfΔ>0 持续多个样本（跨重启仍冻结） | PENDING |
| H2 | 主线程阻塞/GC 压力：JS 堆持续增长或长任务导致合成饥饿 | heap 单调增长；采样间隔 dt 异常增大；冻结时 overlay 文本也停更 | PENDING |
| H3 | 摄像头轨道退化/热节流：轨道停帧或帧率下降（发热、HAL 异常） | tfΔ=0 且 rvfcΔ=0；trk 帧率下降；track mute 事件；全新 getUserMedia 后恢复 | PENDING |
| H4 | detect 背压/资源累积：detect 耗时随时间上升 | detAvg/detMax 随 t 显著上升 | PENDING |
| H5 | 2 分钟重启机制自身引发冻结（srcObject 置空/复用元素在部分机型进入坏态） | 首次冻结时间与 n×2min 重启点强相关，重启后未恢复 | PENDING |

## 计划
1. 插桩（仅诊断，不改业务逻辑）：2s 采样器 + rVFC 帧计数 + track 事件 + detect 耗时 + 屏上 overlay + 同源上报（每 ~30s 部分上报 + 关闭/隐藏时终报，防页面硬挂丢证据）。
2. 部署生产（后端 git pull + pm2 restart；H5 本地构建 + scp 部署）。
3. 用户手机复现（唯一用户步骤）：三击"识别引擎"开诊断 → 等待冻结 → 截图 overlay → 关闭扫码（自动上报）。
4. SSH 读取 NDJSON，逐条判定 H1–H5。
5. 最小修复 → 复测验证（pre/post 对比）→ 清理全部插桩。

## 进展
- progress_status: fix-deployed（最小修复已实施并部署，等待用户复测验证）
- 2026-10-14: 会话建立，假设确认，开始插桩。
- 2026-10-14: 插桩完成（commit `3a92d7a`）。已部署：后端 git pull + pm2 restart（health OK）；H5 构建 scp 部署（新 chunk `pages-scan-ship-index.Beyay_SD.js`，页面 HTTP 200）。
- 2026-10-14: 端点冒烟：POST 400 样本(44KB) → GET lines=1 校验 → DELETE 清空，全部通过。
- 2026-10-14: 用户复现（小米浏览器 MiuiBrowser/20.29.1031010, Android 16, Chromium 135），服务器收到 6 条上报。证据分析：

## 证据分析（用户设备: 小米浏览器, 非 Chrome）
- 所有会话均走原生路径（事件 `open native`），但 `det=-1` 贯穿始终 → **BarcodeDetector 的 detect() 从未成功**（每次调用抛异常被 catch 吞掉，或实现不可用）。
- 会话 1（最长，33s）：t=23 `track mute` → t=24~28 多次 mute/unmute、droppedFrames 从 1 涨到 6 → t=30 `track ended` → t=31 起 `tf` 停在 118、`trk=0`、`rvfc` 停止增长 → **摄像头轨道被浏览器/系统自动终止，视频冻结**。
- 全程 `dt=2` 正常、`heap=17MB` 稳定 → 主线程未被阻塞。
- `rst=0`（2 分钟重启从未触发，轨道 30 秒就 ended）。

## 假设判定
| ID | 假设 | 结论 | 依据 |
|----|------|------|------|
| H1 | video 合成层卡死 | REJECTED | 轨道结束前 rvfc 一直跟随 tf 增长，渲染正常；冻结是轨道无帧可渲染 |
| H2 | 主线程阻塞/GC 压力 | REJECTED | dt 恒为 2s，heap 稳定 17MB，采样器持续运行 |
| H3 | 摄像头轨道退化/热节流 | CONFIRMED | t=23 mute → t=30 ended → tf 停增、trk=0，轨道级停帧 |
| H4 | detect 背压/耗时增长 | REJECTED | det 从未成功(-1)，不是耗时增长 |
| H5 | 2 分钟重启机制引发冻结 | REJECTED | rst=0，轨道 30 秒 ended，远早于重启点 |

## 根因
在**小米浏览器**（MiuiBrowser）上：
1. `BarcodeDetector` 属性存在且可实例化，但 `detect()` 实际**持续抛异常/不可用**（det=-1 证实识别从未工作），导致原生扫码路径空转；
2. 摄像头轨道在约 **30 秒后被浏览器/系统自动终止**（`track ended`），视频画面随之冻结——这就是用户看到的"时间久了卡顿"。

## 最小修复方案
1. 启动原生路径时先对**空白小画布**做一次 `detect` 能力探测，抛异常则立即降级到 html5-qrcode（ZXing）。
2. tick 循环中 detect 连续失败 N 次 → 自动降级 ZXing。
3. 监听 `track ended`：会话仍活跃时立即重新 `getUserMedia` 重建流；重建失败/再次 ended → 降级 ZXing。
4. 移除原生路径的 2 分钟定时重启（证据显示轨道 30 秒即 ended，定时器无意义），改为事件驱动恢复。
5. 保留并增强插桩（记录 detect 异常名、降级、重建事件），验证后再整体移除。

## 验证步骤
- 部署后请用户在小米浏览器上复测：打开扫码应能正常识别（自动走 ZXing），长时间放置画面不再冻结。

## 修复实施记录（commit `8f0aed0`，2026-10-14）
1. `probeBarcodeDetector()`：getUserMedia 之前对 64×64 空白画布跑一次 `detect`（800ms 超时防挂起），失败置 `nativeDetectorBroken=true` 并直接走 ZXing，避免开两次摄像头。
2. 原生 tick 内 `detect` 加 2s 超时（Promise.race）；连续失败 ≥5 次自动降级 ZXing（置 `nativeDetectorBroken` 页面级记忆，本次打开不再回原生路径）。
3. `track ended` 事件驱动恢复：会话仍活跃时 `cleanupNativeScanner()` 后完整重建原生流；重建失败 toast 并关闭扫码。移除原生路径 2 分钟定时重启（rst=0 证实无意义）。
4. ZXing 路径同等恢复：`watchZxVideo()` 监听 track ended → 立即 `restartHtml5QrScanner()`（不再等 2 分钟定时器）；restart 入口清旧定时器防双重启。
5. 引擎标签实时显示实际运行引擎（"BarcodeDetector 原生解码" / "ZXing 兼容解码(检测器不可用，已自动降级)"），降级时用户可感知。
6. 插桩保留（`#region debug-point scan-cam-freeze`），dbgState 加 `active` 守卫防重启重置时间线；验证通过后整体清理（前端插桩 + app.js 诊断端点）。

## 验证状态
- [x] SFC 编译校验通过
- [x] 提交推送（`8f0aed0`）
- [x] H5 构建部署到服务器（纯静态，无需 pm2 restart）
- [x] 服务器采集文件已清空（DELETE → ok:true），等待干净的新证据
- [ ] 用户小米浏览器复测：引擎标签显示"ZXing 兼容解码"、扫码可用、放置 >1 分钟画面不冻结
- [ ] 验证通过后清理全部插桩并二次部署

## 补充（2026-10-14）：原生安卓方案验证与实现
- 结论：原生安卓可根治该卡顿。根因是浏览器/系统在约 30s 终止摄像头 MediaStream 轨道（`track ended`）；原生 App 用 CameraX 直接持有摄像头设备（Camera2），不存在浏览器轨道生命周期。
- 已在 `android-scanner-demo/` 实现原生扫描发货 App（Kotlin + CameraX + ML Kit 离线识别 + OkHttp 对接 ERP API）：
  - 登录（与电脑端 admin 同账号，token 本地持久化 + 滑动续期）
  - 扫码/搜索订单（快递单号 / 货件号 / SKU / 采购单号）
  - 订单卡片：产品/采购/利润展示、备货、录入重量提交发货、面单（浏览器打开）、更正重量
  - 今日/昨日发货记录
- APK 已构建部署：`https://yochylin.com:17443/miniapp/scanner-ship.apk`（约 30MB，debug 签名）。
- 独立于 H5 修复流程，H5 插桩清理仍按原计划在小米浏览器复测后进行。
