#!/usr/bin/env bash
# ============================================================
# setup-android-env.sh
#
# Android 应用开发环境一键安装脚本 (Linux x86_64 / Ubuntu/Debian)
#
# 安装内容（默认全部装在 $HOME/android-dev，不需要 root/sudo）:
#   1. Temurin JDK 17                -> $HOME/android-dev/jdk-17
#   2. Android SDK 命令行工具        -> $HOME/android-dev/sdk/cmdline-tools/latest
#   3. platform-tools (adb)           -> $HOME/android-dev/sdk/platform-tools
#   4. Android SDK Platform 35       -> $HOME/android-dev/sdk/platforms/android-35
#   5. Android Build-Tools 35.0.0    -> $HOME/android-dev/sdk/build-tools/35.0.0
#   6. Gradle 8.11.1 (可选, 默认装)  -> $HOME/android-dev/gradle-8.11.1
#
# 用法:
#   bash setup-android-env.sh                  # 官方源优先, 失败自动切国内镜像
#   bash setup-android-env.sh --cn             # 国内镜像优先
#   bash setup-android-env.sh --no-gradle      # 不安装 Gradle
#   bash setup-android-env.sh --sdk-dir /path  # 自定义 SDK 目录
#
# 安装完成后:
#   source ~/.bashrc
#   cd android-erp && gradle assembleDebug     # 或 ./gradlew assembleDebug
# ============================================================
set -euo pipefail

# ---------------- 配置 ----------------
VERSION_JDK="17.0.13_11"
JDK_RELEASE_TAG="jdk-17.0.13%2B11"
JDK_ARCHIVE="OpenJDK17U-jdk_x64_linux_hotspot_17.0.13_11.tar.gz"

CMDLINE_TOOLS_VERSION="11076708"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"

ANDROID_PLATFORM="android-35"
BUILD_TOOLS_VERSION="35.0.0"
GRADLE_VERSION="8.11.1"

MODE="auto"        # auto | cn | official
INSTALL_GRADLE=1
BASE_DIR="${BASE_DIR:-$HOME/android-dev}"
ANDROID_HOME_DIR="${ANDROID_HOME_DIR:-$BASE_DIR/sdk}"
JAVA_HOME_DIR="$BASE_DIR/jdk-17"
GRADLE_HOME_DIR="$BASE_DIR/gradle-$GRADLE_VERSION"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/android-erp"

# ---------------- 解析参数 ----------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cn) MODE="cn" ;;
    --no-gradle) INSTALL_GRADLE=0 ;;
    --sdk-dir)
      [[ $# -ge 2 ]] || { echo "--sdk-dir 需要路径参数"; exit 1; }
      ANDROID_HOME_DIR="$2"; shift ;;
    -h|--help)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//' | head -40
      exit 0 ;;
    *) echo "未知参数: $1 (用 --help 查看帮助)"; exit 1 ;;
  esac
  shift
done

mkdir -p "$BASE_DIR" "$ANDROID_HOME_DIR"

# ---------------- 工具函数 ----------------
say()  { echo -e "\n\033[1;32m[setup] $*\033[0m"; }
warn() { echo -e "\n\033[1;33m[setup] 警告: $*\033[0m"; }
die()  { echo -e "\n\033[1;31m[setup] 错误: $*\033[0m" >&2; exit 1; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# 依次尝试多个 URL 下载到目标文件，全部失败则返回非 0
download() {
  local dest="$1"; shift
  local url
  for url in "$@"; do
    echo "    -> $url"
    if have_cmd curl; then
      if curl -fL --retry 2 --connect-timeout 15 -o "$dest" "$url" 2>/dev/null; then
        return 0
      fi
    elif have_cmd wget; then
      if wget -q --tries=3 --timeout=15 -O "$dest" "$url" 2>/dev/null; then
        return 0
      fi
    else
      die "需要 curl 或 wget，请先安装: sudo apt install curl wget"
    fi
    rm -f "$dest"
  done
  return 1
}

# ---------------- JDK ----------------
install_jdk() {
  if [[ -x "$JAVA_HOME_DIR/bin/java" ]]; then
    say "JDK 已存在，跳过安装: $JAVA_HOME_DIR"
    return 0
  fi
  say "下载 Temurin JDK 17 ($JDK_ARCHIVE) ..."
  local tmp="$BASE_DIR/jdk.tar.gz"
  if [[ "$MODE" == "cn" ]]; then
    download "$tmp" \
      "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/linux/$JDK_ARCHIVE" \
      "https://github.com/adoptium/temurin17-binaries/releases/download/$JDK_RELEASE_TAG/$JDK_ARCHIVE"
  else
    download "$tmp" \
      "https://github.com/adoptium/temurin17-binaries/releases/download/$JDK_RELEASE_TAG/$JDK_ARCHIVE" \
      "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/linux/$JDK_ARCHIVE"
  fi || die "JDK 下载失败，请检查网络后重试"
  say "解压 JDK 到 $JAVA_HOME_DIR ..."
  mkdir -p "$JAVA_HOME_DIR"
  tar -xzf "$tmp" -C "$JAVA_HOME_DIR" --strip-components=1
  rm -f "$tmp"
  "$JAVA_HOME_DIR/bin/java" -version 2>&1 | head -1 || die "JDK 安装失败"
  say "JDK 安装完成"
}

# ---------------- Android SDK 命令行工具 ----------------
install_cmdline_tools() {
  local sdkmanager="$ANDROID_HOME_DIR/cmdline-tools/latest/bin/sdkmanager"
  if [[ -x "$sdkmanager" ]]; then
    say "Android 命令行工具已存在，跳过安装"
    return 0
  fi
  say "下载 Android SDK 命令行工具 ($CMDLINE_TOOLS_ZIP) ..."
  local tmp="$BASE_DIR/cmdline-tools.zip"
  if [[ "$MODE" == "cn" ]]; then
    download "$tmp" \
      "https://mirrors.cloud.tencent.com/AndroidSDK/$CMDLINE_TOOLS_ZIP" \
      "https://mirrors.huaweicloud.com/android-sdk/$CMDLINE_TOOLS_ZIP" \
      "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
  else
    download "$tmp" \
      "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP" \
      "https://mirrors.cloud.tencent.com/AndroidSDK/$CMDLINE_TOOLS_ZIP" \
      "https://mirrors.huaweicloud.com/android-sdk/$CMDLINE_TOOLS_ZIP"
  fi || die "命令行工具下载失败，请检查网络后重试"
  say "安装命令行工具到 $ANDROID_HOME_DIR/cmdline-tools/latest ..."
  mkdir -p "$ANDROID_HOME_DIR/cmdline-tools"
  unzip -oq "$tmp" -d "$ANDROID_HOME_DIR/cmdline-tools"
  rm -f "$tmp"
  if [[ -d "$ANDROID_HOME_DIR/cmdline-tools/cmdline-tools" ]]; then
    rm -rf "$ANDROID_HOME_DIR/cmdline-tools/latest"
    mv "$ANDROID_HOME_DIR/cmdline-tools/cmdline-tools" "$ANDROID_HOME_DIR/cmdline-tools/latest"
  else
    die "cmdline-tools 解压结构不符合预期"
  fi
  "$sdkmanager" --version >/dev/null 2>&1 || die "命令行工具不可用"
  say "Android 命令行工具安装完成"
}

# ---------------- SDK 组件（sdkmanager 优先） ----------------
install_sdk_packages() {
  local sdkmanager="$ANDROID_HOME_DIR/cmdline-tools/latest/bin/sdkmanager"
  if [[ -d "$ANDROID_HOME_DIR/platforms/$ANDROID_PLATFORM" && -d "$ANDROID_HOME_DIR/build-tools/$BUILD_TOOLS_VERSION" && -x "$ANDROID_HOME_DIR/platform-tools/adb" ]]; then
    say "SDK 组件已存在，跳过安装"
    return 0
  fi
  say "接受 SDK 许可协议 ..."
  yes | "$sdkmanager" --sdk_root="$ANDROID_HOME_DIR" --licenses >/dev/null 2>&1 || true
  say "通过 sdkmanager 安装 platform-tools / platforms;$ANDROID_PLATFORM / build-tools;$BUILD_TOOLS_VERSION ..."
  if ! "$sdkmanager" --sdk_root="$ANDROID_HOME_DIR" \
        "platform-tools" "platforms;$ANDROID_PLATFORM" "build-tools;$BUILD_TOOLS_VERSION"; then
    warn "sdkmanager 安装失败，改用国内镜像直接下载 SDK 组件"
    install_sdk_packages_mirror
  fi
  [[ -x "$ANDROID_HOME_DIR/platform-tools/adb" ]] || die "platform-tools 安装失败"
  [[ -d "$ANDROID_HOME_DIR/platforms/$ANDROID_PLATFORM" ]] || die "platforms;$ANDROID_PLATFORM 安装失败"
  [[ -d "$ANDROID_HOME_DIR/build-tools/$BUILD_TOOLS_VERSION" ]] || die "build-tools;$BUILD_TOOLS_VERSION 安装失败"
  say "SDK 组件安装完成"
}

# ---------------- SDK 组件（国内镜像直装，sdkmanager 失败时兜底） ----------------
install_sdk_packages_mirror() {
  local mirror_base="https://mirrors.cloud.tencent.com/AndroidSDK"
  say "从镜像 $mirror_base 下载 SDK 组件 ..."

  # platform-tools
  if [[ ! -x "$ANDROID_HOME_DIR/platform-tools/adb" ]]; then
    download "$BASE_DIR/platform-tools.zip" \
      "$mirror_base/platform-tools_r35.0.3-linux.zip" \
      "$mirror_base/platform-tools_r34.0.5-linux.zip" \
      "$mirror_base/platform-tools_r34.0.4-linux.zip" \
      || die "platform-tools 镜像下载失败"
    unzip -oq "$BASE_DIR/platform-tools.zip" -d "$ANDROID_HOME_DIR"
    rm -f "$BASE_DIR/platform-tools.zip"
  fi

  # platforms;android-35
  if [[ ! -d "$ANDROID_HOME_DIR/platforms/$ANDROID_PLATFORM" ]]; then
    download "$BASE_DIR/platform.zip" \
      "$mirror_base/platform-35_r01.zip" \
      "$mirror_base/platform-35_r02.zip" \
      || die "platform 镜像下载失败"
    local tmpd="$BASE_DIR/platform-extract"
    rm -rf "$tmpd"; mkdir -p "$tmpd"
    unzip -oq "$BASE_DIR/platform.zip" -d "$tmpd"
    rm -f "$BASE_DIR/platform.zip"
    local dir
    dir="$(find "$tmpd" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [[ -n "$dir" ]] || die "platform 解压失败"
    rm -rf "$ANDROID_HOME_DIR/platforms/$ANDROID_PLATFORM"
    mv "$dir" "$ANDROID_HOME_DIR/platforms/$ANDROID_PLATFORM"
    rm -rf "$tmpd"
  fi

  # build-tools;35.0.0
  if [[ ! -d "$ANDROID_HOME_DIR/build-tools/$BUILD_TOOLS_VERSION" ]]; then
    download "$BASE_DIR/build-tools.zip" \
      "$mirror_base/build-tools_r35.0.0-linux.zip" \
      || die "build-tools 镜像下载失败"
    local tmpd="$BASE_DIR/build-tools-extract"
    rm -rf "$tmpd"; mkdir -p "$tmpd"
    unzip -oq "$BASE_DIR/build-tools.zip" -d "$tmpd"
    rm -f "$BASE_DIR/build-tools.zip"
    local dir
    dir="$(find "$tmpd" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [[ -n "$dir" ]] || die "build-tools 解压失败"
    rm -rf "$ANDROID_HOME_DIR/build-tools/$BUILD_TOOLS_VERSION"
    mv "$dir" "$ANDROID_HOME_DIR/build-tools/$BUILD_TOOLS_VERSION"
    rm -rf "$tmpd"
  fi
}

# ---------------- Gradle ----------------
install_gradle() {
  [[ $INSTALL_GRADLE -eq 1 ]] || return 0
  if [[ -x "$GRADLE_HOME_DIR/bin/gradle" ]]; then
    say "Gradle 已存在，跳过安装: $GRADLE_HOME_DIR"
    return 0
  fi
  say "下载 Gradle $GRADLE_VERSION ..."
  local tmp="$BASE_DIR/gradle.zip"
  if [[ "$MODE" == "cn" ]]; then
    download "$tmp" \
      "https://mirrors.cloud.tencent.com/gradle/gradle-$GRADLE_VERSION-bin.zip" \
      "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  else
    download "$tmp" \
      "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" \
      "https://mirrors.cloud.tencent.com/gradle/gradle-$GRADLE_VERSION-bin.zip"
  fi || die "Gradle 下载失败，请检查网络后重试"
  unzip -oq "$tmp" -d "$BASE_DIR"
  rm -f "$tmp"
  "$GRADLE_HOME_DIR/bin/gradle" --version >/dev/null 2>&1 || die "Gradle 安装失败"
  say "Gradle 安装完成: $GRADLE_HOME_DIR"
}

# ---------------- 环境变量 ----------------
setup_env() {
  local rc="${SHELL_RC:-$HOME/.bashrc}"
  touch "$rc"
  if grep -q "ANDROID_HOME=$ANDROID_HOME_DIR" "$rc" 2>/dev/null; then
    say "环境变量已写入过 $rc，跳过"
    return 0
  fi
  cat >> "$rc" <<EOF

# ===== Android 开发环境 (由 setup-android-env.sh 写入) =====
export JAVA_HOME="$JAVA_HOME_DIR"
export ANDROID_HOME="$ANDROID_HOME_DIR"
export ANDROID_SDK_ROOT="$ANDROID_HOME_DIR"
EOF
  local gradle_path=""
  if [[ $INSTALL_GRADLE -eq 1 ]]; then
    cat >> "$rc" <<EOF
export GRADLE_HOME="$GRADLE_HOME_DIR"
EOF
    gradle_path=':$GRADLE_HOME/bin'
  fi
  cat >> "$rc" <<EOF
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION$gradle_path:\$PATH"
EOF
  say "环境变量已写入 $rc，请执行 source $rc 使其生效"
}

# ---------------- 项目本地配置 ----------------
write_local_properties() {
  if [[ -f "$PROJECT_DIR/settings.gradle" ]]; then
    cat > "$PROJECT_DIR/local.properties" <<EOF
sdk.dir=$ANDROID_HOME_DIR
EOF
    say "已生成 $PROJECT_DIR/local.properties (sdk.dir=$ANDROID_HOME_DIR)"
  fi
}

# ---------------- 验证 ----------------
verify() {
  say "验证安装结果 ..."
  echo "  JDK      : $("$JAVA_HOME_DIR/bin/java" -version 2>&1 | head -1)"
  echo "  sdkmanager: $("$ANDROID_HOME_DIR/cmdline-tools/latest/bin/sdkmanager" --version 2>&1 | tail -1)"
  echo "  adb      : $("$ANDROID_HOME_DIR/platform-tools/adb" --version 2>&1 | head -1)"
  if [[ $INSTALL_GRADLE -eq 1 ]]; then
    echo "  Gradle   : $("$GRADLE_HOME_DIR/bin/gradle" --version 2>/dev/null | grep -i gradle | head -1 || echo "未安装")"
  fi
}

# ---------------- 汇总 ----------------
print_summary() {
  cat <<EOF

============================================================
  Android 开发环境安装完成！

  JDK 17        : $JAVA_HOME_DIR
  Android SDK   : $ANDROID_HOME_DIR
  Gradle $GRADLE_VERSION : $GRADLE_HOME_DIR

  下一步:
  1. 让环境变量生效:  source ~/.bashrc
  2. 构建项目:
       cd $PROJECT_DIR
       gradle assembleDebug          # 或 ./gradlew assembleDebug
  3. APK 输出:
       $PROJECT_DIR/app/build/outputs/apk/debug/app-debug.apk

  如果构建时 Maven 依赖下载慢，可在 android-erp/settings.gradle
  的 repositories 中加入阿里云镜像:
       maven { url 'https://maven.aliyun.com/repository/google' }
       maven { url 'https://maven.aliyun.com/repository/public' }
============================================================
EOF
}

# ---------------- 主流程 ----------------
main() {
  have_cmd curl || have_cmd wget || die "请先安装 curl 或 wget: sudo apt install curl wget"
  have_cmd unzip || die "请先安装 unzip: sudo apt install unzip"
  have_cmd tar || die "请先安装 tar: sudo apt install tar"

  install_jdk
  export JAVA_HOME="$JAVA_HOME_DIR"
  export PATH="$JAVA_HOME_DIR/bin:$PATH"

  export ANDROID_HOME="$ANDROID_HOME_DIR"
  export ANDROID_SDK_ROOT="$ANDROID_HOME_DIR"

  install_cmdline_tools
  install_sdk_packages
  install_gradle
  setup_env
  write_local_properties
  verify
  print_summary
}

main
