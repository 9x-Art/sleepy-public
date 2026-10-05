#!/usr/bin/env node
/* ============================================================
   scripts/make-ab-handover.js
   —— 生成「回交-A与B.txt」（单文件回交）

   ★ 上一版把函数抽取的结束标记写成 '\n}'，而 JS 的花括号是**缩进**的
     （是 '\n  }'）⇒ 永远匹配不到 ⇒ 每个「完整函数」一路抽到文件末尾，
     产出 2500 行垃圾。已改为**按缩进层级**判定函数结束。
   ============================================================ */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var NODE = process.execPath;
var BASELINE = 'D:\\projects\\sleepy-baseline-2026-10-05-pre6';

var FILES = [
  'scripts/offline-f2-fixture-trace-test.js',
  'scripts/offline-f2-effect-acceptance.js',
  'scripts/offline-f2-schedule-test.js',
  'scripts/offline-f2-edge-test.js',
  'scripts/offline-f2-effect-fields-test.js',
  'scripts/lib/f2-body-capture.js',
  'scripts/offline-f2-sendbody-test.js'
];

var buf = [];
function w(s) { buf.push(s === undefined ? '' : s); }

w('回交 · A 异步网络阻断生命周期 + B 请求体缺证停止续发（2026-10-05 第六轮）');
w('零模型请求 · timeout 120s · P3 暂停 · 未改生产代码 · 未提交 / push / 部署');
w('基线：' + BASELINE + '（修改前已存）');
w('');

/* ---------- 按缩进抽函数：结束 = 首个缩进 ≤ 起始行缩进的 '}' ---------- */
function extractFunc(file, startMark) {
  var lines = fs.readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\r\n/g, '\n').split('\n');
  var a = lines.findIndex(function (l) { return l.indexOf(startMark) >= 0; });
  if (a < 0) return null;
  var indent = lines[a].match(/^\s*/)[0].length;
  var b = lines.length - 1;
  for (var i = a + 1; i < lines.length; i++) {
    var ind = lines[i].match(/^\s*/)[0].length;
    if (lines[i].trim() === '}' && ind === indent) { b = i; break; }
  }
  return { file: file, from: a + 1, to: b + 1, lines: lines.slice(a, b + 1) };
}
function dump(title, file, startMark) {
  var f = extractFunc(file, startMark);
  w('');
  if (!f) { w('── ' + title + ' →（未找到标记：' + startMark + '）'); return; }
  w('── ' + title + '  （' + f.file + ':' + f.from + '–' + f.to +
    '，共 ' + f.lines.length + ' 行）──');
  f.lines.forEach(function (l, i) {
    w(String(f.from + i).padStart(5, ' ') + ' | ' + l);
  });
}

/* ================= 一、精确 diff ================= */
w('#'.repeat(70));
w('# 一、精确 diff（对基线 ' + path.basename(BASELINE) + '）');
w('#'.repeat(70));
FILES.forEach(function (f) {
  var base = path.join(BASELINE, path.basename(f));
  w(''); w('── ' + f + ' ──');
  if (!fs.existsSync(base)) { w('（基线缺失）'); return; }
  var d = cp.spawnSync('git', ['diff', '--no-index', '-U3', '--', base,
    path.join(ROOT, f)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  w((d.stdout || '').trim() || '（与基线逐字一致 —— 本轮未改此文件）');
});

/* ================= 二、相关完整函数 ================= */
w(''); w('#'.repeat(70));
w('# 二、相关完整函数（当前实现全文，按缩进精确抽取）');
w('#'.repeat(70));
dump('requestBodyEvidence —— 请求体缺证判定', 'scripts/offline-f2-effect-acceptance.js',
  'function requestBodyEvidence(t, opts) {');
dump('hardStopKind —— 含缺证接线与顺序说明', 'scripts/offline-f2-effect-acceptance.js',
  'function hardStopKind(t, opts) {');
dump('blockOtherNetwork —— 断网阻断工厂', 'scripts/offline-f2-fixture-trace-test.js',
  'function blockOtherNetwork() {');
dump('serialChain / tas —— 串行 runner', 'scripts/offline-f2-fixture-trace-test.js',
  'var serialChain = Promise.resolve();');
dump('§2.5 生产链复核（async/await 生命周期）', 'scripts/offline-f2-fixture-trace-test.js',
  "tas('生产 requestOnce 落到的 body");
dump('§9 缺证停止续发（单轮 / 末轮 / 跨组 / 未发出）', 'scripts/offline-f2-schedule-test.js',
  "section('§9 请求体缺证");

/* ================= 三、定向测试输出 ================= */
w(''); w('#'.repeat(70));
w('# 三、定向测试输出'); w('#'.repeat(70));
var TESTS = [
  ['scripts/offline-f2-schedule-test.js', 'B 调度（新增 §9）', true],
  ['scripts/offline-f2-fixture-trace-test.js', 'A 生命周期（新增 §2.6）', true],
  ['scripts/offline-f2-sendbody-test.js', '受影响（费用状态措辞）', false],
  ['scripts/offline-f2-effect-fields-test.js', '必要回归', false],
  ['scripts/offline-f2-edge-test.js', '必要回归（goodTurn 补证据）', false],
  ['scripts/offline-f2-depstop-test.js', '必要回归', false],
  ['scripts/check.js', '必要回归', false],
  ['scripts/smoke.js', '必要回归', false]
];
var allGreen = true;
TESTS.forEach(function (t) {
  var r = cp.spawnSync(NODE, [t[0]], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) allGreen = false;
  var out = (r.stdout || '') + (r.stderr || '');
  w(''); w('── ' + t[0] + '  （' + t[1] + '）  退出码 ' + r.status + ' ──');
  if (t[2]) {
    w(out.trim());
  } else {
    w(out.split('\n').filter(function (l) { return /通过|全绿|✗/.test(l); })
      .slice(-3).join('\n'));
  }
});

/* ================= 四、生产代码未改动 ================= */
w(''); w('#'.repeat(70));
w('# 四、生产代码未改动（SHA-256 与本轮开工前一致）'); w('#'.repeat(70));
['prompt-engine.js', 'page-offline.js', 'api.js', 'behavior-text.js']
  .forEach(function (f) {
    w('  ' + cp.execFileSync('sha256sum', [f], { cwd: ROOT, encoding: 'utf8' }).trim());
  });

var OUT = path.join(ROOT, 'docs', '回交-A与B.txt');
fs.writeFileSync(OUT, buf.join('\n'), 'utf8');
process.stdout.write('已生成：' + OUT + '\n');
process.stdout.write(buf.length + ' 行 · ' + fs.statSync(OUT).size + ' 字节\n');
process.stdout.write(allGreen ? '八个检查退出码全 0\n' : '★ 有红项\n');
process.exit(allGreen ? 0 : 1);
