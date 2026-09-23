#!/usr/bin/env bash
# 一键上线：打一个**只含运行时**的副本 → 部署到 Cloudflare Pages（sleepy-u17.pages.dev）。
#
# 为什么要剪这一步：`wrangler pages deploy <目录>` 会把目录里**所有**文件原样上传，
# 于是 docs/（45 个设计文档）、_retired/、preview/、scripts/、README/ROADMAP 全都
# 变成公开可访问的 URL（用户 2026-09-23 问起「这些也上线了吗」）。
#
# ❌ 试过 `.assetsignore`（放仓库根、跟着 git archive 进副本）：**不生效** ——
#    那是 Workers 静态资源（wrangler deploy + assets）的机制，`pages deploy` 不认，
#    实测加了之后 /docs/DRAFT.md、/README.md、/scripts/smoke.js 依然 200。
#    那个文件已删掉（留着只会让人以为它挡住了）。
#
# ✅ 做法：`tar -x --exclude`，**提取时就别解出来** —— 而不是先解出来再删。
#    删不掉的坑：这台机器的 `rm -rf` 会被安全删除层接管，路径里出现
#    `C:\Users\…\Temp` 与 cwd 混拼时它直接 FAIL_CLOSED（2026-09-23 踩到）。
#    排除清单写在 tar 参数里，没有删除动作，也就不依赖任何回收站/权限。
#
# ⚠️ 别排除这些（排了页面会坏）：art/（浮岛两张插画，style.css 的 .isl-art 引用）、
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
# MSYS/Git Bash 下 mktemp -d 会给出 /tmp/… （在 Windows 工具眼里会被拼成本地路径），
# 所以这里显式用项目惯用的暂存区，并带 $RANDOM 保证每跑一次都是新目录（不需要清）。
OUT="D:/tmp/sleepy-deploy-$H-$RANDOM"
mkdir -p "$OUT"

git archive HEAD | tar -x -C "$OUT" \
  --exclude='docs' --exclude='docs/*' \
  --exclude='_retired' --exclude='_retired/*' \
  --exclude='preview' --exclude='preview/*' \
  --exclude='scripts' --exclude='scripts/*' \
  --exclude='README.md' --exclude='ROADMAP.md' --exclude='serve.js' \
  --exclude='package.json' --exclude='pnpm-workspace.yaml'

echo "副本：$OUT"
echo "文件数：$(find "$OUT" -type f | wc -l)（文档 / 归档 / 预览稿 / 开发脚本 / 仓库说明都没解出来）"

# 上线上传前先自查：该在的在不在、该没的有没有
for must in index.html sw.js manifest.json style.css art/isle.webp icons/icon-192.png vendor/three.module.js; do
  [ -e "$OUT/$must" ] || { echo "❌ 副本里缺了 $must —— 排除清单写过头了，停。"; exit 1; }
done
for mustnt in docs _retired preview scripts README.md serve.js; do
  [ -e "$OUT/$mustnt" ] && { echo "❌ $mustnt 还在副本里 —— 排除清单没生效，停。"; exit 1; }
done
echo "自查通过：运行时要用的都在，文档/归档/脚本都不在。"

cd "$OUT"
wrangler pages deploy . --project-name sleepy --branch main --commit-hash="$H" --commit-dirty=true
