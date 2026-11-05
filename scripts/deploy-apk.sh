#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 一键部署 Android APK 发版脚本
#
# 遵循发版顺序(用户明确要求):
#   1. 先用当前版本号构建 APK 并部署到 miniapp 目录, 验证下载可达
#   2. 确认成功后, 三处版本号 +1 (build.gradle / 根 version.json / miniapp version.json)
#   3. clean 重新构建新版本 APK, 部署 + 更新线上 version.json
#   4. 验证内网/公网下载 MD5 一致
#   5. 提交推送 git(可选)
#
# 用法:
#   ./scripts/deploy-apk.sh                # 完整发版: 构建部署+版本+1+提交推送
#   ./scripts/deploy-apk.sh --no-push      # 提交但不推送
#   ./scripts/deploy-apk.sh --skip-git     # 不提交不推送, 只构建部署+改版本
#   ./scripts/deploy-apk.sh --help         # 帮助
#
# 依赖: gradle(系统), curl, md5sum, git; 环境变量见 ANDROID_BUILD_DEPLOY.md
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# 加载 Android 构建环境(新终端必须先 source ~/.bashrc)
# .bashrc 第 6 行 [ -z "$PS1" ] 在 set -u(nounset) 下会因 $PS1 未设置直接退出整个脚本,
# 因此 source 前临时关闭 nounset, source 完成后恢复。
# shellcheck disable=SC1090
set +u
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi
set -u

# ── 路径 ──
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android-erp"
BUILD_GRADLE="$ANDROID_DIR/app/build.gradle"
ROOT_VERSION_JSON="$ROOT/version.json"
MINIAPP_DIR="$ROOT/erp-backend-lite/src/public/miniapp"
MINIAPP_VERSION_JSON="$MINIAPP_DIR/version.json"
APK_SRC="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
BASE_URL="${BASE_URL:-http://localhost:3001}"
PUBLIC_URL="${PUBLIC_URL:-https://yochylin.com:17443}"

# ── 参数 ──
PUSH=1
SKIP_GIT=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push)  PUSH=0 ;;
    --skip-git) SKIP_GIT=1 ;;
    -h|--help)  usage ;;
    *) echo "未知参数: $1 (使用 --help 查看用法)"; exit 1 ;;
  esac
  shift
done

# ── 工具函数 ──
log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '     \033[1;32m✅\033[0m %s\n' "$*"; }
fail() { printf '     \033[1;31m❌\033[0m %s\n' "$*" >&2; exit 1; }

find_aapt() {
  local bt="${ANDROID_HOME:-}/build-tools"
  [ -d "$bt" ] || fail "未找到 build-tools, 请检查 ANDROID_HOME"
  ls -d "$bt"/*/ 2>/dev/null | sort -V | tail -1
}

read_current_version() {
  # 用 grep -m1 替代管道 head -1: pipefail 下 head 提前关闭会让 grep 收到 SIGPIPE(141)
  grep -m1 -oP 'versionCode\s+\K\d+' "$BUILD_GRADLE"
  grep -m1 -oP 'versionName\s+"\K[^"]+' "$BUILD_GRADLE"
}

# 验证 APK 部署后下载 MD5 与本地产物一致
verify_apk() {
  local name="$1" tmp="/tmp/deploy-apk-verify.apk"
  curl -fsS "$BASE_URL/miniapp/$name" -o "$tmp" || fail "下载 $name 失败"
  local a b
  a="$(md5sum "$APK_SRC" | awk '{print $1}')"
  b="$(md5sum "$tmp" | awk '{print $1}')"
  [[ "$a" == "$b" ]] || fail "$name 下载 MD5 不一致($a != $b)"
  ok "$name 下载 MD5 一致 ($a)"
}

# 构建 debug APK(clean)
build_apk() {
  (cd "$ANDROID_DIR" && gradle clean assembleDebug) || fail "构建失败"
}

# ── 第 1 步: 当前版本构建部署验证 ──
mapfile -t CURRENT_VERSION < <(read_current_version)
CUR_CODE="${CURRENT_VERSION[0]}"
CUR_NAME="${CURRENT_VERSION[1]}"
CUR_APK="scanner-ship-v$CUR_NAME.apk"

log "[1/6] 用当前版本 v$CUR_NAME (versionCode $CUR_CODE) 构建 APK"
build_apk
log "[2/6] 部署当前版本到 miniapp 并验证"
cp "$APK_SRC" "$MINIAPP_DIR/$CUR_APK"
verify_apk "$CUR_APK"
ok "v$CUR_NAME 已部署, 可访问 $BASE_URL/miniapp/$CUR_APK"

# ── 第 2 步: 版本号 +1 ──
NEW_CODE=$((CUR_CODE + 1))
MAJOR="${CUR_NAME%%.*}"
MINOR="${CUR_NAME##*.}"
MINOR=$((MINOR + 1))
if (( MINOR > 99 )); then MAJOR=$((MAJOR + 1)); MINOR=0; fi
NEW_NAME="$MAJOR.$MINOR"
NEW_APK="scanner-ship-v$NEW_NAME.apk"

log "[3/6] 版本号 +1: v$CUR_NAME($CUR_CODE) → v$NEW_NAME($NEW_CODE)"
sed -i "s/versionCode .*/versionCode $NEW_CODE/" "$BUILD_GRADLE"
sed -i "s/versionName \".*\"/versionName \"$NEW_NAME\"/" "$BUILD_GRADLE"
for f in "$ROOT_VERSION_JSON" "$MINIAPP_VERSION_JSON"; do
  sed -i "s/\"versionCode\": [0-9]*/\"versionCode\": $NEW_CODE/" "$f"
  sed -i "s/\"versionName\": \"[^\"]*\"/\"versionName\": \"$NEW_NAME\"/" "$f"
  sed -i "s/\"downloadPath\": \"[^\"]*\"/\"downloadPath\": \"$NEW_APK\"/" "$f"
done
ok "三处版本号已更新 (build.gradle / 根 version.json / miniapp version.json)"

# ── 第 3 步: 新版本 clean 构建 + 部署 ──
log "[4/6] 用新版本 v$NEW_NAME 构建 APK (clean)"
build_apk

AAPT="$(find_aapt)/aapt"
BAGGING_OUT="$("$AAPT" dump badging "$APK_SRC" 2>/dev/null || true)"
if ! grep -q "versionCode='$NEW_CODE'" <<<"$BAGGING_OUT"; then
  fail "APK 内版本号不是 $NEW_CODE, 实际: $(echo "$BAGGING_OUT" | sed -n '1p')"
fi
ok "APK 版本号验证通过 (versionCode=$NEW_CODE)"

log "[5/6] 部署新版本并验证"
cp "$APK_SRC" "$MINIAPP_DIR/$NEW_APK"
verify_apk "$NEW_APK"

BODY="$(curl -fsS "$BASE_URL/miniapp/version.json")"
echo "$BODY" | grep -q "\"versionCode\": $NEW_CODE" \
  || fail "线上 version.json 版本号不对: $BODY"
ok "线上 version.json = $(echo "$BODY" | tr -d '\n ')"

HTTP_CODE="$(curl -skI -o /dev/null -w '%{http_code}' "$PUBLIC_URL/miniapp/$NEW_APK" 2>/dev/null || true)"
if [[ "$HTTP_CODE" == "200" ]]; then
  ok "公网下载可达: $PUBLIC_URL/miniapp/$NEW_APK"
else
  echo "     ⚠️ 公网下载未验证通过(HTTP $HTTP_CODE, 内网部署已成功, 可忽略)"
fi

# ── 第 4 步: 提交推送 ──
if [[ "$SKIP_GIT" == "0" ]]; then
  log "[6/6] 提交 git"
  cd "$ROOT"
  git add -u
  git add "$BUILD_GRADLE" "$ROOT_VERSION_JSON"
  git commit -m "chore(release): APK 发版 v$NEW_NAME (versionCode $NEW_CODE)" \
             -m "Co-Authored-By: Claude Code <noreply@anthropic.com>" \
    || echo "     ⚠️ 没有需要提交的改动"
  if [[ "$PUSH" == "1" ]]; then
    git push origin main
    ok "已推送到 origin/main"
  else
    echo "     (--no-push 已跳过推送)"
  fi
else
  echo "     (--skip-git 已跳过 git 操作)"
fi

echo
echo "🎉 发版完成: v$CUR_NAME → v$NEW_NAME (versionCode $NEW_CODE)"
echo "   内网: $BASE_URL/miniapp/$NEW_APK"
echo "   公网: $PUBLIC_URL/miniapp/$NEW_APK"