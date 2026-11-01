#!/usr/bin/env node
/* ============================================================
   gen-version.js — 生成 OTA 更新清单 version.json（安卓壳用，2026-10-25）

   用法：node scripts/gen-version.js <运行时副本目录>
   （deploy.sh 在 git archive 解出副本后调它；**只写进部署副本，不进仓库**
     —— 清单跟着站点走，仓库零提交噪音。）

   输出 <目录>/version.json：
   {
     "build": "1ea2fc3-1761…",        // HEAD 短哈希 + 时间戳，唯一标识一次构建
     "head":  "1ea2fc3",
     "generated": 1761…,
     "files": { "index.html": {"hash":"sha256hex","size":123}, … }
   }

   安卓壳（sleepy-android）的 Updater 拉这份清单：
   build 变了 → 逐文件下载 + sha256 校验 → 原子切换 update 目录。
   断网/校验失败 → 内置 assets 兜底，永不变砖。

   口径：**部署副本里有什么就登什么**（deploy.sh 的 tar 排除清单是唯一出处，
   这里不维护第二份排除清单 —— 两份清单必然漂移）。version.json 自身不登。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.argv[2];
if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
  console.error('❌ 用法：node scripts/gen-version.js <运行时副本目录>（目录里要有 index.html）');
  process.exit(1);
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'version.json') continue;   // 自身不登
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    /* functions/ 是唯一特例（2026-11-01 APK「下载失败」事故）：它是 Pages
       专属目录 —— 上传时被编译成 Function，**静态资产里没有真文件**，线上
       访问它拿到的是 index.html 回退页（200 但 sha 必不匹配）。APK 的
       Updater 逐文件 sha256 校验，撞上它整次更新回退 —— 10-29 它进仓库
       起 APK OTA 就一直挂。必须跳过（tar 不能排它：Pages 靠它出 Function）。
       下划线开头是 Pages 保留文件（_redirects/_headers：配置用，**不当
       资产伺服**，线上同样是 index.html 回退页 —— 同日第二撞，用户报
       「未通过啥啥啥」）；点开头文件（.gitignore 等）壳也用不上，一并跳过。 */
    if (rel === 'functions' || rel.startsWith('functions/')) continue;
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out[rel] = {
      hash: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
      size: st.size
    };
  }
  return out;
}

/* PWA 更新检测（2026-10-31 用户点名）：页面得知道自己多老才能跟
   version.json 比。把构建号烙进部署副本的 index.html（<head> 里一枚
   meta），仓库里的 index.html 一个字不动 —— 只有线上页面自带身份。
   ⚠️ 必须在 walk() 算哈希**之前**烙：APK 的 Updater 逐文件校验 sha256，
   烙完再算才是真哈希。head 还没算出来没关系 —— meta 烙的是 build
   （head + 时间戳），build 先拼好再烙。 */
let head = 'unknown';
try { head = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname + '/..' }).toString().trim(); } catch (e) { /* 副本目录外跑也能活 */ }

const BUILD = head + '-' + Date.now().toString(36);
const indexPath = path.join(root, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
if (html.indexOf('x-sleepy-build') < 0) {
  const META = '<meta name="x-sleepy-build" content="' + BUILD + '">';
  html = html.replace(/<head(\s[^>]*)?>/, function (m) { return m + '\n' + META; });
  fs.writeFileSync(indexPath, html);
}

const files = walk(root, root, {});

const manifest = {
  build: BUILD,
  head: head,
  generated: Date.now(),
  files: files
};
fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify(manifest));
console.log('version.json：build=' + manifest.build + '，文件数=' + Object.keys(files).length);
