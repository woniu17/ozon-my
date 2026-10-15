# Android 开发环境安装指南

本仓库的 `android-erp` 是一个标准 Android Gradle 工程（Kotlin + AGP 8.9.1），
构建需要以下环境：

| 组件 | 版本 | 用途 |
|------|------|------|
| JDK | 17 | 编译 Java/Kotlin 字节码 |
| Android SDK Platform | 35 (android-35) | 编译目标 SDK |
| Android Build-Tools | 35.0.0 | 打包/签名工具 |
| Android platform-tools | 最新 | adb 等设备工具 |
| Gradle | 8.11.1 | 构建系统（工程自带 gradlew，也可独立安装） |

## 一键安装脚本

直接运行仓库根目录的脚本：

```bash
cd /root/code/ozon-my
bash setup-android-env.sh            # 官方源优先，失败自动切国内镜像
# 或
bash setup-android-env.sh --cn       # 国内镜像优先（腾讯/华为/清华）
```

脚本会把所有东西装到 `$HOME/android-dev/`，**不需要 root/sudo**，也不会改动系统目录：

```
~/android-dev/
├── jdk-17/            # JDK 17（Temurin，或 apt 安装 OpenJDK 后软链接过来，见 FAQ 4）
├── sdk/
│   ├── cmdline-tools/latest/
│   ├── platform-tools/
│   ├── platforms/android-35/
│   └── build-tools/35.0.0/
└── gradle-8.11.1/
```

脚本还会自动：

1. 把 `JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`GRADLE_HOME`、`PATH` 写入 `~/.bashrc`；
2. 生成 `android-erp/local.properties`（`sdk.dir=...`，该文件已被 gitignore，不会污染仓库）。

### 可选参数

| 参数 | 说明 |
|-----|------|
| `--cn` | 优先使用国内镜像下载 |
| `--no-gradle` | 不安装独立 Gradle（仅用工程自带的 gradlew 下载） |
| `--sdk-dir /path` | 自定义 Android SDK 安装目录 |

## 安装后验证

```bash
source ~/.bashrc
java -version                 # 应显示 openjdk version "17.0.x"
adb --version                 # Android Debug Bridge
sdkmanager --version           # Android SDK 命令行工具版本
gradle --version              # Gradle 8.11.1

# 构建 android-erp 项目（生成 debug APK）
cd /root/code/ozon-my/android-erp
gradle assembleDebug          # 或 ./gradlew assembleDebug
```

构建成功后 APK 位于：

```
android-erp/app/build/outputs/apk/debug/app-debug.apk
```

> 实测：在 Ubuntu 24.04 上按本文档安装后，`java` 17.0.20.1、`adb` 1.0.41、
> `sdkmanager` 12.0、`gradle` 8.11.1，`gradle assembleDebug` 构建成功。

## 国内镜像说明

脚本内置了以下镜像作为备选源：

| 资源 | 官方地址 | 国内镜像 |
|------|----------|----------|
| Temurin JDK 17 | GitHub Releases | 清华 TUNA `mirrors.tuna.tsinghua.edu.cn/Adoptium/` |
| Android cmdline-tools / SDK 组件 | `dl.google.com/android/repository/` | 腾讯 `mirrors.cloud.tencent.com/AndroidSDK/`、华为 `mirrors.huaweicloud.com/android-sdk/` |
| Gradle | `services.gradle.org/distributions/` | 腾讯 `mirrors.cloud.tencent.com/gradle/` |

> 稳定性提示：实测清华 TUNA 的 Adoptium JDK 镜像在部分网络下可能下载到 1MB 左右就
> 停滞不再增长，GitHub 官方源也可能很慢；而腾讯镜像下载 SDK/Gradle 速度很快。
> 如果 JDK 一直下载失败，直接用 FAQ 4 的 apt 方案安装 JDK 即可。

## APK 正式签名（多机器覆盖安装升级）

项目使用**仓库内置的正式签名密钥**，保证在任何机器上编译的 APK 使用同一证书，
可以无缝覆盖安装升级（不会出现“签名不一致，需先卸载”的提示）。

| 文件 | 说明 |
|------|------|
| `android-erp/keystore/release.keystore` | 正式签名密钥库（已提交仓库） |
| `android-erp/keystore.properties` | 密钥库密码配置（已提交仓库） |

`android-erp/app/build.gradle` 会读取 `keystore.properties` 配置签名，
并且 **debug 和 release 构建使用同一把签名**：

```groovy
signingConfigs {
    release {
        storeFile rootProject.file(keystoreProps['storeFile'])
        storePassword keystoreProps['storePassword']
        keyAlias keystoreProps['keyAlias']
        keyPassword keystoreProps['keyPassword']
    }
}
buildTypes {
    release { signingConfig signingConfigs.release }
    debug   { signingConfig signingConfigs.release }
}
```

注意事项：

1. **第一次切换**：旧版本（如 v5.4）是用旧机器各自生成的 debug 证书签名的，
   升级到新签名版本时**仍需卸载一次**；之后所有版本统一签名，可一直覆盖升级。
2. 密钥库密码已按你的要求放在仓库里，**任何能访问仓库的人都可以给 APK 签名**，
   请确保仓库权限受控（当前为私有仓库）。
3. 如需更换密码，用 `keytool -storepasswd -keystore android-erp/keystore/release.keystore`
   修改后同步更新 `keystore.properties`。

## 常见问题

### 1. 构建时 Maven 依赖下载慢 / 超时
工程依赖从 `google()` 和 `mavenCentral()` 拉取。如果太慢，可以在
`android-erp/settings.gradle` 的 `repositories` 中加入阿里云镜像：

```groovy
repositories {
    maven { url 'https://maven.aliyun.com/repository/google' }
    maven { url 'https://maven.aliyun.com/repository/public' }
}
```

注意 `settings.gradle` 开启了 `RepositoriesMode.FAIL_ON_PROJECT_REPOS`，
不要在 `app/build.gradle` 里加 `repositories`。

### 2. gradlew 下载 Gradle 太慢
`android-erp/gradle/wrapper/gradle-wrapper.properties` 里默认从
`services.gradle.org` 下载。可临时把 `distributionUrl` 换成腾讯镜像：

```
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.11.1-bin.zip
```

或直接使用脚本安装的独立 Gradle：`gradle assembleDebug`。

### 3. 需要 Android Studio（IDE）？
命令行环境已可完成编译打包。如需图形化 IDE，可另外到
`https://developer.android.com/studio` 下载 Android Studio，安装后把 SDK 路径
指向 `~/android-dev/sdk` 即可复用本环境。

### 4. JDK 下载慢 / 卡住怎么办？
清华 Adoptium 镜像和 GitHub 官方源在部分网络下都很慢（实测清华镜像下载到约 1MB
即停滞）。推荐改用系统包管理器安装 OpenJDK 17，再软链接到脚本预期路径，
之后照常运行脚本（脚本检测到 `~/android-dev/jdk-17/bin/java` 存在会自动跳过 JDK 下载）：

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y openjdk-17-jdk

mkdir -p ~/android-dev
ln -sfn /usr/lib/jvm/java-17-openjdk-amd64 ~/android-dev/jdk-17

# 然后继续用脚本装 SDK + Gradle（JDK 部分会被跳过）
cd /root/code/ozon-my
bash setup-android-env.sh --cn
```

装完后 `JAVA_HOME=~/android-dev/jdk-17` 依然有效，`gradle` 也能正常使用该 JDK。

### 5. 环境变量在非交互式 shell 里不生效？
Ubuntu 的 `~/.bashrc` 开头有 `[ -z "$PS1" ] && return`，非交互式 shell（脚本、CI）
执行 `source ~/.bashrc` 时会提前退出，导致脚本写入的 `JAVA_HOME`、`ANDROID_HOME`
等不生效。**交互式终端不受影响**。非交互场景需要手动导出：

```bash
export JAVA_HOME=/root/android-dev/jdk-17
export ANDROID_HOME=/root/android-dev/sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export GRADLE_HOME=/root/android-dev/gradle-8.11.1
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/35.0.0:$GRADLE_HOME/bin:$PATH"
```

或改用交互式方式执行命令：

```bash
bash -i -c "cd /root/code/ozon-my/android-erp && gradle assembleDebug"
```
