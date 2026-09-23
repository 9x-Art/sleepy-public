#!/usr/bin/env bash
# 一键上线：打一个**只含运行时**的副本 → 部署到 Cloudflare Pages（sleepy-u17.pages.dev）。
#
# 为什么要剪这一步：`wrangler pages deploy <目录>` 会把目录里**所有**文件原样上传，
# 于是 docs/（45 个设计文档）、_retired/、preview/、scripts/、README/ROADMAP 全都
# 变成公开可访问的 URL（用户 2026-09-23 问起「这些也上线了吗」）。
#
# ❌ 试过 `.assetsignore`（放仓库根、跟着 git archive 一起进副本）：**不生效** ——
#    那是 Workers 静态资源（wrangler deploy + assets）的机制，`pages deploy` 不认，
#    实测加了之后 /docs/DRAFT.md、/README.md、/scripts/smoke.js 依然 200。
#    所以只能在这儿真剪。删掉那个文件也是这个原因（免得以后有人往它里面加规则、
#    以为挡住了）。
#
# ⚠️ 别剪掉这些（剪了页面会坏）：art/（浮岛两张插画，style.css 的 .isl-art 引用）、
#    icons/ + manifest.json（PWA 图标）、vendor/（three.js，亚克力挂件灯）。
#
# 用法：bash scripts/deploy.sh        （先确认 wrangler 处于登录状态：wrangler whoami）
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  工作区有未提交的改动 —— git archive 只打**已提交**内容，先提交再部署。"
  exit 1
fi

H=$(git rev-parse --short HEAD)
OUT="$(mktemp -d)/sleepy-deploy"
mkdir -p "$OUT"
git archive HEAD | tar -x -C "$OUT"

rm -rf "$OUT/docs" "$OUT/_retired" "$OUT/preview" "$OUT/scripts"
rm -f "$OUT/README.md" "$OUT/ROADMAP.md" "$OUT/serve.js" "$OUT/package.json" "$OUT/pnpm-workspace.yaml"

echo "副本：$OUT"
echo "文件数：$(find "$OUT" -type f | wc -l)（已剪掉文档 / 归档 / 预览稿 / 开发脚本 / 仓库说明）"
cd "$OUT"
wrangler pages deploy . --project-name sleepy --branch main --commit-hash="$H" --commit-dirty=true
