#!/usr/bin/env node
/* ============================================================
   scripts/verify-closure-excerpt.js
   —— 回验「收口源码摘录」与仓库**逐字一致**

   ★ 为什么要单独一个回验脚本（而不是生成时顺手断言）：
     生成脚本自己说「我抽的行没问题」没有意义 ——
     必须是**另一个**读回摘录文件、按行号去仓库逐行比的独立程序。
   ★ 上一版把这段逻辑用 `node -e` 内联在 shell 里，
     正则里的 `\$` / `\|` 被 shell 吃掉 → 报出 699 处「不符」，
     实际摘录与仓库**完全一致**。这是误报，不是摘录的问题。
     ⇒ 判据类代码必须落文件跑，别经 shell 转义。
   ============================================================ */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '..');
var EXCERPT = process.env.SLEEPY_EXCERPT_OUT ||
  path.join(ROOT, 'docs', '收口源码摘录-2026-10-05.txt');

var lines = fs.readFileSync(EXCERPT, 'utf8').replace(/\r\n/g, '\n').split('\n');
var srcCache = {};
function srcOf(f) {
  if (!srcCache[f]) {
    srcCache[f] = fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/\r\n/g, '\n').split('\n');
  }
  return srcCache[f];
}

/* ---- 解析摘录结构 ---- */
var segs = [], cur = null;
lines.forEach(function (l) {
  var m = l.match(/^文件：(.+)$/);
  if (m) { if (cur) segs.push(cur); cur = { file: m[1], rows: [] }; return; }
  m = l.match(/^行号：(\d+)–(\d+)/);
  if (m && cur) { cur.from = +m[1]; cur.to = +m[2]; return; }
  m = l.match(/^\s{0,6}(\d+) \| (.*)$/);
  if (m && cur) cur.rows.push({ n: +m[1], text: m[2] });
});
if (cur) segs.push(cur);

/* ---- 关键锚点必须**恰好**出现在摘录里（独立复核）----
   ⚠️ 这一段是为了补一个真实的洞：
     上一版生成器用**硬编码行号**，而本轮 SETUP 删了 20 行 → 行号整体偏移，
     但回验是拿**同一批硬编码行号**去比对的 ⇒「摘录 == 仓库第 N 行」依然成立
     ⇒ **回验全绿，而摘录实际指向了错误的代码**。
     那是「判据与被测对象共用同一个错误来源」的假绿。
     现在生成器按锚点定位；本回验**独立地**检查每个关键锚点
     出现在摘录中 —— 不依赖生成器的行号推导。 */
var ANCHORS = [
  'var SETUP = function (arg) {',
  'Sleepy.offlineStore.createSession(ch.id, {',
  'Sleepy.offlineStore.updateEnv(s.id, {',
  '(function verifyScenePersisted() {',
  '前置消息：**只保留原报告 #6–#9 四条，顺序不变**',
  'F2BodyCapture.installFetchBypass(window, {',
  'async function persistPhase(phase) {',
  'function hardStopKind(t) {',
  'var 对齐 = {',
  'function captureRequestBody(input, init, opts) {',
  'function stopKindForSend(send) {'
];
var missingAnchors = ANCHORS.filter(function (a) {
  return lines.join('\n').indexOf(a) < 0;
});

var bad = [];
segs.forEach(function (s, i) {
  var src = srcCache[s.file] ? srcCache[s.file] : (srcOf(s.file), srcCache[s.file]);
  if (!src) { bad.push('第' + (i + 1) + '段：文件不存在 ' + s.file); return; }
  if (s.rows.length !== s.to - s.from + 1) {
    bad.push('第' + (i + 1) + '段：行数不符 声明 ' + (s.to - s.from + 1) +
      ' 实得 ' + s.rows.length + '（' + s.file + ' ' + s.from + '–' + s.to + '）');
    return;
  }
  s.rows.forEach(function (r) {
    if (r.n < 1 || r.n > src.length) {
      bad.push(s.file + ':' + r.n + ' 行号越界（文件共 ' + src.length + ' 行）');
      return;
    }
    if (r.text !== src[r.n - 1]) {
      bad.push(s.file + ':' + r.n + ' 内容不符\n      摘录：' + r.text +
        '\n      仓库：' + src[r.n - 1]);
    }
  });
});

/* ---- 省略号检查：片段必须完整 ---- */
var ellipsis = [];
lines.forEach(function (l, i) {
  if (/…|\.\.\./.test(l)) ellipsis.push((i + 1) + '：' + l.trim().slice(0, 60));
});

process.stdout.write('回验摘录：' + EXCERPT + '\n');
process.stdout.write('段数 ' + segs.length + ' · 摘录行数 ' +
  segs.reduce(function (a, s) { return a + s.rows.length; }, 0) + '\n');
if (missingAnchors.length) {
  process.stdout.write('✗ 摘录里缺少关键锚点 ' + missingAnchors.length + ' 个' +
    '（说明行号漂移后没重新生成，或生成器锚点失效）：\n');
  missingAnchors.forEach(function (a) { process.stdout.write('  · ' + a + '\n'); });
  process.exit(4);
}
process.stdout.write('✓ ' + ANCHORS.length + ' 个关键锚点全部在摘录内（独立复核）\n');
if (bad.length) {
  process.stdout.write('✗ 内容不符 ' + bad.length + ' 处：\n');
  bad.slice(0, 10).forEach(function (b) { process.stdout.write('  · ' + b + '\n'); });
  process.exit(1);
}
process.stdout.write('✓ 全部与仓库**逐字一致**（含行号）\n');
if (ellipsis.length) {
  process.stdout.write('△ 含省略号 ' + ellipsis.length + ' 行（多为源码注释里的省略号语义）：\n');
  ellipsis.slice(0, 5).forEach(function (e) { process.stdout.write('  · ' + e + '\n'); });
} else {
  process.stdout.write('✓ 无省略号\n');
}
process.exit(0);
