#!/usr/bin/env bash
# ============================================================
# pack-android.sh — 把 sleepy 运行时灌进安卓壳的 assets（2026-10-25）
#
# 口径与 deploy.sh **完全同一份** tar 排除清单（archive 出什么，
# APK 出厂包就是什么），再补 version.json（出厂包也要能被 OTA
# 识别 build 号 —— Updater 拿线上清单和它比对）。
#
# 用法：bash scripts/pack-android.sh     （需已提交；工作区脏会拒绝）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  工作区有未提交的改动 —— git archive 只打已提交内容，先提交再打包。"
  exit 1
fi

ANDROID="D:/projects/sleepy-android"
WWW="$ANDROID/app/src/main/assets/www"
H=$(git rev-parse --short HEAD)
OUT="D:/tmp/sleepy-apk-pack-$H-$RANDOM"
mkdir -p "$OUT" "$WWW"

git archive HEAD | tar -x -C "$OUT" \
  --exclude='docs' --exclude='docs/*' \
  --exclude='_retired' --exclude='_retired/*' \
  --exclude='preview' --exclude='preview/*' \
  --exclude='scripts' --exclude='scripts/*' \
  --exclude='README.md' --exclude='ROADMAP.md' --exclude='serve.js' \
  --exclude='package.json' --exclude='pnpm-workspace.yaml'

# 同 deploy.sh 的自查：运行时必须齐
for must in index.html sw.js manifest.json style.css art/isle.webp icons/icon-192.png vendor/three.module.js; do
  [ -e "$OUT/$must" ] || { echo "❌ 副本缺 $must，停。"; exit 1; }
done

node scripts/gen-version.js "$OUT"

# 灌 assets：先清 www 再拷（旧文件的残留会让出厂包和清单对不上）
rm -rf "$WWW"
mkdir -p "$WWW"
cp -r "$OUT"/. "$WWW"/

echo "✅ assets 已就绪：$WWW"
echo "   下一步：cd $ANDROID && ./gradlew assembleDebug"
