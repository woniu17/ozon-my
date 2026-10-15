# Android APK 构建与部署指南

> 适用对象：需要发布新版 `android-erp` APK 的开发者或 Agent。
> 环境安装（JDK/Android SDK/Gradle）见 `ANDROID_ENV_SETUP.md`。

## 给 Agent 的一句话指令

按本文档执行：升级三处版本号 → `gradle assembleDebug` 构建 → 拷贝 APK 到
`erp-backend-lite/src/public/miniapp/` → 更新后端 `version.json` → curl 验证 →
提交推送（APK 和部署目录不入库）。

---

## 0. 环境变量（新终端先执行）

```bash
export JAVA_HOME=/root/android-dev/jdk-17
export ANDROID_HOME=/root/android-dev/sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export GRADLE_HOME=/root/android-dev/gradle-8.11.1
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/35.0.0:$GRADLE_HOME/bin:$PATH"
```

交互式终端已写入 `~/.bashrc` 的话，直接 `source ~/.bashrc` 即可。

## 1. 版本号规则

每次发布需在**三处**同步升级版本（示例：v5.6 / versionCode 48）：

| 文件 | 需要改的字段 |
|------|--------------|
| `android-erp/app/build.gradle` | `versionCode`、`versionName` |
| `version.json`（仓库根） | `versionCode`、`versionName`、`downloadPath` |
| `erp-backend-lite/src/public/miniapp/version.json` | 同上（部署后线上生效） |

`downloadPath` 统一为 `scanner-ship-v<版本名>.apk`，例如 `scanner-ship-v5.6.apk`。

## 2. 构建 APK

```bash
cd /root/code/ozon-my/android-erp
gradle assembleDebug          # 或 ./gradlew assembleDebug
```

- 产物路径：`android-erp/app/build/outputs/apk/debug/app-debug.apk`
- 签名：自动读取 `android-erp/keystore.properties`（密钥库
  `android-erp/keystore/release.keystore`）。debug/release 用同一正式签名，
  任意机器构建的 APK 证书一致，可覆盖升级。

验证签名（可选）：

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  android-erp/app/build/outputs/apk/debug/app-debug.apk
# 预期：Signer #1 certificate DN: CN=Ozon ERP, ...
```

## 3. 部署到后端

后端静态目录：`erp-backend-lite/src/public/miniapp/`（已被 gitignore，产物不入库）。

```bash
cd /root/code/ozon-my
cp android-erp/app/build/outputs/apk/debug/app-debug.apk \
   erp-backend-lite/src/public/miniapp/scanner-ship-v5.6.apk
```

更新后端版本配置 `erp-backend-lite/src/public/miniapp/version.json`：

```json
{
  "versionCode": 48,
  "versionName": "5.6",
  "downloadPath": "scanner-ship-v5.6.apk"
}
```

`express.static` 动态读盘，**无需重启后端**。

## 4. 验证部署

```bash
# 版本接口返回最新版本
curl -s http://localhost:3001/miniapp/version.json

# 下载可达性（应 HTTP 200）
curl -sI http://localhost:3001/miniapp/scanner-ship-v5.6.apk | head -3

# 下载文件与本地 APK MD5 一致
curl -s http://localhost:3001/miniapp/scanner-ship-v5.6.apk -o /tmp/dl.apk
md5sum android-erp/app/build/outputs/apk/debug/app-debug.apk /tmp/dl.apk
```

- 内网手机：`http://192.168.1.212:3001/miniapp/version.json`
- 公网：`https://yochylin.com:17443/miniapp/version.json`

## 5. 提交与推送（可选）

```bash
cd /root/code/ozon-my
git add android-erp/app/build.gradle version.json <本次改动的其他文件>
git commit -m "fix(android): 说明本次改动 vX.Y"
git push origin main
```

**注意**：`erp-backend-lite/src/public/` 和 `*.apk` 已被 gitignore，**不要**把 APK
或部署目录下的 `version.json` 提交到 git（它们属于服务器运行时文件）。

## 6. 签名与升级说明

- 密钥库 `android-erp/keystore/release.keystore` 与密码 `android-erp/keystore.properties`
  已提交到私有仓库，所有机器共用同一证书。
- 任意机器编译的 APK 签名一致，可直接覆盖安装升级。
- 从旧机器 debug 签名版本升级到新签名版本的**第一次需卸载**；之后可一直覆盖升级。
