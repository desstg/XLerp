#!/usr/bin/env bash
# 小林进销存 macOS 版构建脚本（在 macOS runner 上跑）
#
# 产物：dist/XLerp-<版本>-macOS-<arch>.dmg
#
# 和 Windows 版结构一致：
#   XLerp.app/Contents/MacOS/
#     XLerp              ← Electron 主程序
#     main.js preload.js icon.png   ← 桌面壳（打进 app.asar）
#     portal.js server.js index.html vendor/ local/   ← 业务文件，和 exe 同目录
#   因为 main.js 里 APP_DIR = path.dirname(process.execPath)，
#   所以业务文件必须和 Electron 可执行文件放在一起（Contents/MacOS/）。
#
# 不签名：Apple 公证需要付费开发者账号。用户首次打开要右键→打开，或
#   xattr -dr com.apple.quarantine /Applications/XLerp.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(grep -oE "const VERSION = '[^']+'" src/server.js | head -1 | sed "s/.*'\(.*\)'.*/\1/")"
if [ -z "$VERSION" ]; then echo "读不到版本号" >&2; exit 1; fi

# 目标架构：CI 里用 TARGET_ARCH 显式指定，本地不传就用当前机器架构
#   arm64 → Apple Silicon（M1/M2/M3/M4）
#   x64   → Intel Mac
if [ -n "${TARGET_ARCH:-}" ]; then
  ELECTRON_ARCH="$TARGET_ARCH"
else
  case "$(uname -m)" in
    arm64)  ELECTRON_ARCH="arm64" ;;
    x86_64) ELECTRON_ARCH="x64" ;;
    *) echo "未知架构 $(uname -m)" >&2; exit 1 ;;
  esac
fi
case "$ELECTRON_ARCH" in
  arm64|x64) ;;
  *) echo "TARGET_ARCH 只能是 arm64 或 x64，收到：$ELECTRON_ARCH" >&2; exit 1 ;;
esac
echo "==> 主机架构 $(uname -m) → 目标架构 $ELECTRON_ARCH"

# 与 src/desktop/package.json 里保持一致
ELECTRON_VER="$(node -p "require('./src/desktop/package.json').electronVersion")"

echo "==> 构建 XLerp $VERSION macOS-$ELECTRON_ARCH (Electron $ELECTRON_VER)"

DIST="$ROOT/dist"
STAGE="$DIST/mac-stage"
APP="$STAGE/XLerp.app"
rm -rf "$STAGE" "$DIST"/XLerp-*-macOS-*.dmg
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ---------- 1. 下载 Electron ----------
CACHE="${HOME}/.cache/xlerp-electron"
mkdir -p "$CACHE"
ZIP="$CACHE/electron-v${ELECTRON_VER}-darwin-${ELECTRON_ARCH}.zip"
if [ ! -f "$ZIP" ]; then
  echo "==> 下载 Electron"
  URLS=(
    "https://npmmirror.com/mirrors/electron/${ELECTRON_VER}/electron-v${ELECTRON_VER}-darwin-${ELECTRON_ARCH}.zip"
    "https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-darwin-${ELECTRON_ARCH}.zip"
  )
  for u in "${URLS[@]}"; do
    echo "   试 $u"
    if curl -fsSL --retry 3 --connect-timeout 20 -o "$ZIP" "$u"; then break; fi
    rm -f "$ZIP"
  done
  [ -f "$ZIP" ] || { echo "Electron 下载失败" >&2; exit 1; }
fi

echo "==> 解压 Electron"
mkdir -p "$STAGE/electron"
unzip -q "$ZIP" -d "$STAGE/electron"

# Electron 发行包解压出来就是 Electron.app
SRC_APP="$STAGE/electron/Electron.app"
[ -d "$SRC_APP" ] || { echo "解压后没找到 Electron.app" >&2; ls -la "$STAGE/electron"; exit 1; }

# ---------- 2. 拷 Electron 运行时 ----------
echo "==> 组装 XLerp.app"
cp -R "$SRC_APP/." "$APP/"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/XLerp"

# ---------- 3. 业务文件（必须和可执行文件同目录，见 main.js 的 APP_DIR）----------
mkdir -p "$APP/Contents/MacOS"
cp src/server.js src/portal.js src/index.html "$APP/Contents/MacOS/"
cp -R src/vendor "$APP/Contents/MacOS/vendor"
# 单机模式模块（浏览器里跑服务端业务逻辑用）
cp -R src/local "$APP/Contents/MacOS/local"

# ---------- 4. 桌面壳：打成 app.asar，放进 Resources ----------
echo "==> 打包桌面壳 app.asar"
rm -rf "$DIST/mac-asar"; mkdir -p "$DIST/mac-asar"
cp src/desktop/main.js src/desktop/preload.js src/desktop/icon.png src/desktop/package.json "$DIST/mac-asar/"
# icon.ico 只有 Windows 用得到，macOS 不要
# @electron/asar 装在临时目录，不污染项目依赖
ASAR_DIR="$DIST/.asar-tool"
if [ ! -f "$ASAR_DIR/node_modules/@electron/asar/package.json" ]; then
  rm -rf "$ASAR_DIR"; mkdir -p "$ASAR_DIR"
  ( cd "$ASAR_DIR" && npm init -y >/dev/null 2>&1 && npm i --silent @electron/asar >/dev/null 2>&1 ) || true
fi
if [ -f "$ASAR_DIR/node_modules/@electron/asar/package.json" ]; then
  node -e "
    const asar = require('$ASAR_DIR/node_modules/@electron/asar');
    asar.createPackage('$DIST/mac-asar', '$APP/Contents/Resources/app.asar')
      .then(() => console.log('   app.asar 已生成'))
      .catch(e => { console.error(e); process.exit(1); });
  "
else
  # 实在装不上：不用 asar，直接把壳文件放进 Resources/app（Electron 也认）
  echo "   ⚠ @electron/asar 不可用，改用 Resources/app 目录模式"
  mkdir -p "$APP/Contents/Resources/app"
  cp "$DIST/mac-asar"/* "$APP/Contents/Resources/app/"
fi

# ---------- 5. 图标 ----------
echo "==> 生成 App 图标"
ICONSET="$DIST/XLerp.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
# 用 sips 从 1024 的 PNG 生成各尺寸；src/desktop/icon.png 本身是 512，先放大
BASE="$DIST/icon-1024.png"
sips -z 1024 1024 src/desktop/icon.png --out "$BASE" >/dev/null 2>&1 || cp src/desktop/icon.png "$BASE"
for s in 16 32 64 128 256 512; do
  sips -z $s $s "$BASE" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
  d=$((s*2))
  sips -z $d $d "$BASE" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/XLerp.icns"
rm -rf "$ICONSET" "$BASE"

# ---------- 6. Info.plist ----------
echo "==> 写 Info.plist"
PLIST="$APP/Contents/Info.plist"
# 用 PlistBuddy 改关键字段（比手写 XML 稳）
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleName XLerp" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleName string XLerp" "$PLIST"
$PB -c "Set :CFBundleDisplayName 小林进销存" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string 小林进销存" "$PLIST"
$PB -c "Set :CFBundleIdentifier com.xerp.mac" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleIdentifier string com.xerp.mac" "$PLIST"
$PB -c "Set :CFBundleExecutable XLerp" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleExecutable string XLerp" "$PLIST"
$PB -c "Set :CFBundleShortVersionString $VERSION" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleShortVersionString string $VERSION" "$PLIST"
$PB -c "Set :CFBundleVersion $VERSION" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleVersion string $VERSION" "$PLIST"
$PB -c "Set :CFBundleIconFile XLerp" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleIconFile string XLerp" "$PLIST"
# 允许局域网（手机连本机服务时要弹权限）
$PB -c "Delete :NSLocalNetworkUsageDescription" "$PLIST" 2>/dev/null || true
$PB -c "Add :NSLocalNetworkUsageDescription string 局域网内其他设备（手机、其他电脑）需要访问本机的记账服务。" "$PLIST"

# ---------- 7. 去掉 quarantine / 改权限 ----------
chmod +x "$APP/Contents/MacOS/XLerp"
find "$APP/Contents/MacOS" -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true

# ---------- 8. 打 dmg ----------
echo "==> 生成 DMG"
DMG="$DIST/XLerp-${VERSION}-macOS-${ELECTRON_ARCH}.dmg"
hdiutil create -volname "小林进销存 $VERSION" -srcfolder "$STAGE/XLerp.app" \
  -ov -format UDZO "$DMG" >/dev/null

SIZE=$(du -m "$DMG" | cut -f1)
echo "==> 完成: $DMG (${SIZE} MB)"

# 顺手在 CI 里留个校验
shasum -a 256 "$DMG" | tee "$DMG.sha256"
