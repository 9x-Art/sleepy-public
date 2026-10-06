/**
 * 重新导出组件核心：  acrylic-lamp.html  →  acrylic-lamp-core.js
 *
 *   node tools/build-core.cjs
 *
 * 什么时候要跑：改了 `acrylic-lamp.html` 里任何**视觉 / 交互**的东西之后。
 * 页面里的 `import createAcrylicLamp from './acrylic-lamp-core.js'` 不用动。
 *
 * 这个脚本只做一件事：把源文件里「可复用核心」那一段抽出来，
 * 补上 import / export，写回 acrylic-lamp-core.js。
 * 不碰 README、不碰示例、不打 zip —— 那些是手写的产物，不该被覆盖。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'acrylic-lamp.html');
const OUT  = path.join(ROOT, 'acrylic-lamp-core.js');

if (!fs.existsSync(SRC)) {
  console.error('找不到源文件：' + SRC);
  process.exit(1);
}

const html = fs.readFileSync(SRC, 'utf8');

/* ── 1) 定位「可复用核心」那一段（按哨兵，不按行号） ───────────────────── */
const START_MARK = 'const TAU = Math.PI * 2;';
const END_MARK   = '▲▲▲  可复用核心 结束  ▲▲▲';

const startIdx = html.indexOf(START_MARK);
if (startIdx < 0) throw new Error('找不到核心起点「' + START_MARK + '」');

const endMarkerIdx = html.indexOf(END_MARK);
if (endMarkerIdx < 0) throw new Error('找不到核心结束标记「' + END_MARK + '」');

/* 结束标记在一条注释里，往回退到那条注释的 /* 开头 */
const commentStart = html.lastIndexOf('/*', endMarkerIdx);
if (commentStart < 0 || commentStart > endMarkerIdx) {
  throw new Error('找不到结束注释的开头');
}

const coreBody = html.slice(startIdx, commentStart).trimEnd();

/* ── 2) 自检：核心段不该引用页面外壳才有的东西 ─────────────────────────── */
/* 这条很要紧 —— 一旦在核心里写了 getElementById，模块在真实页面里会直接炸 */
for (const bad of ['#boot', '#hint', '#lights', 'document.getElementById']) {
  if (coreBody.includes(bad)) {
    throw new Error('核心段里出现了页面外壳的引用「' + bad + '」，抽出来会跑不起来');
  }
}

/* ── 3) 补头尾，写出 ───────────────────────────────────────────────────── */
const header = `/*!
 * 亚克力挂件灯 · 可复用核心
 * ---------------------------------------------------------------------------
 * 纯代码生成，零素材：骨架、卡片贴图、珠子、光晕、环境反射全部现场画出来，
 * 不含任何图片 / 模型文件。three.js 之外没有第二个依赖。
 *
 * 依赖：three.js（r169 验证通过）
 *   · 用打包器：npm i three
 *   · 不用打包器：在页面里加一条 importmap
 *       <script type="importmap">
 *       { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js" } }
 *       </script>
 *
 * 用法：
 *   import createAcrylicLamp from './acrylic-lamp-core.js';
 *
 *   const lamp = createAcrylicLamp(document.getElementById('stage'), {
 *     cards: [{ text: '好事\\n会发生', art: 'cat', tone: 'pink' }],
 *   });
 *   lamp.setLight('moon');     // 换灯
 *   lamp.dispose();            // 组件卸载时收干净
 *
 * 本文件是从 acrylic-lamp.html 的「可复用核心」段自动抽出的。
 * 请改源文件再重新导出（node tools/build-core.cjs），不要在这里直接改 —— 下次导出会被覆盖。
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';

`;

const core = header + coreBody + '\n\nexport default createAcrylicLamp;\n';
fs.writeFileSync(OUT, core, 'utf8');

/* ── 4) 语法自检：ESM 的 import/export 只有在 .mjs 下才查得出来 ───────── */
const tmp = path.join(os.tmpdir(), 'acrylic-lamp-core.check.mjs');
fs.copyFileSync(OUT, tmp);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('语法检查没过：\n' + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
} finally {
  try { fs.unlinkSync(tmp); } catch (_) {}
}

console.log('导出成功：' + OUT);
console.log('  体积   ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
console.log('  行数   ' + core.split('\n').length);
console.log('  语法   ' + 'OK（import/export 已校验）');
