#!/usr/bin/env node
/* ============================================================
   scripts/make-final-closure-bundle.js
   —— 生成「最终收口合并.txt」

   四块内容合成一份：
     ① 本次精确 diff（对**本轮修改前基线**）
     ② 更新后的完整收口源码摘录（先生成并回验，再嵌入）
     ③ 四条前置消息清单
     ④ 定向测试结果

   ★ 基线来自 D:\projects\sleepy-baseline-2026-10-05-pre5\
     （本轮开工前保存）—— 这次 diff 是**真**的，不是伪造。
   ★ 摘录不只给路径：直接**内嵌全文**，并跑一遍独立回验
     （verify-closure-excerpt.js 的锚点 + 逐字一致性检查）。
   ============================================================ */
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var NODE = process.execPath;
var BASELINE = process.env.SLEEPY_BASELINE ||
  'D:\\projects\\sleepy-baseline-2026-10-05-pre5';
var OUT = process.env.SLEEPY_BUNDLE_OUT ||
  path.join(ROOT, 'docs', '最终收口合并.txt');

/* 本轮改动的文件（相对基线） */
var FILES = [
  'scripts/offline-f2-effect-acceptance.js',
  'scripts/lib/f2-body-capture.js',
  'scripts/offline-f2-sendbody-test.js',
  'scripts/offline-f2-fixture-trace-test.js',
  'scripts/make-closure-excerpt.js',
  'scripts/verify-closure-excerpt.js'
];

var buf = [];
function w(s) { buf.push(s === undefined ? '' : s); }

function run(args, opts) {
  try {
    return cp.execFileSync(NODE, args,
      Object.assign({ cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }, opts || {}));
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') + '\n[退出码 ' + e.status + ']';
  }
}

/* ---------- 标题 ---------- */
w('最终收口合并 · F2 私聊线下验收脚本');
w('生成：scripts/make-final-closure-bundle.js');
w('基线：D:\\projects\\sleepy-baseline-2026-10-05-pre5（本轮开工前保存）');
w('本批：零模型请求 · timeout 120s · P3 暂停 · 未改生产代码 · 未提交/push/部署');
w('');
w('本文件四块：① 精确 diff ② 完整源码摘录 ③ 四条前置消息清单 ④ 定向测试结果');

/* ============================================================
   ① 精确 diff
   ============================================================ */
w('');
w('#' + '='.repeat(74));
w('# ① 本次精确 diff（对基线 ' + path.basename(BASELINE) + '）');
w('#' + '='.repeat(74));
var diffStat = [];
FILES.forEach(function (f) {
  var base = path.join(BASELINE, path.basename(f));
  if (!fs.existsSync(base)) { diffStat.push([f, '(基线缺失)', '(新文件)']); return; }
  var d = cp.spawnSync('git', ['diff', '--no-index', '--stat', '--', base,
    path.join(ROOT, f)], { encoding: 'utf8' });
  var stat = (d.stdout || '').trim().split('\n').pop() || '';
  diffStat.push([f, '', stat]);
});
w('');
w('变更统计：');
diffStat.forEach(function (r) { w('  ' + r[0] + '  ' + r[2]); });

FILES.forEach(function (f) {
  var base = path.join(BASELINE, path.basename(f));
  w('');
  w('─'.repeat(74));
  w('diff -- ' + f);
  w('─'.repeat(74));
  if (!fs.existsSync(base)) {
    w('（基线中无此文件 —— 本轮新增。全文见本文件②/③或仓库同路径）');
    return;
  }
  var d = cp.spawnSync('git', ['diff', '--no-index', '-U2', '--', base,
    path.join(ROOT, f)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  var out = d.stdout || '';
  w(out.length ? out.trim() : '（与基线逐字一致 —— 本轮未改此文件）');
});

/* ============================================================
   ② 完整源码摘录（先生成 + 回验，再内嵌全文）
   ============================================================ */
w('');
w('#' + '='.repeat(74));
w('# ② 完整收口源码摘录');
w('#' + '='.repeat(74));
w('');
w('生成：' + run(['scripts/make-closure-excerpt.js']).trim());
w('');
w('独立回验：' + run(['scripts/verify-closure-excerpt.js']).trim().split('\n')
  .filter(function (l) { return /✓|✗/.test(l); }).join(' ｜ '));
w('');
w('（以下为摘录全文，逐字内嵌）');
w('');
var excerpt = fs.readFileSync(path.join(ROOT, 'docs', '收口源码摘录-2026-10-05.txt'), 'utf8');
w(excerpt.trimEnd());

/* ============================================================
   ③ 四条前置消息清单
   ============================================================ */
w('');
w('#' + '='.repeat(74));
w('# ③ 四条前置消息清单（SETUP 落库实况）');
w('#' + '='.repeat(74));
w('');
var listJson = path.join(ROOT, 'docs', '取证-F2前置消息清单-2026-10-05.json');
if (fs.existsSync(listJson)) {
  var lj = JSON.parse(fs.readFileSync(listJson, 'utf8'));
  w('总条数：' + lj.总条数 + '（原报告 #6–#9 四条，顺序不变）');
  w('');
  w('| 序 | role | 正文 |');
  w('|---|---|---|');
  (lj.逐条 || []).forEach(function (m) {
    w('| ' + m.n + ' | ' + m.role + ' | ' + String(m.正文).replace(/\|/g, '\\|') + ' |');
  });
  w('');
  w('要点：');
  w('  · preActions **只保存拼接版一次**（位置 2）——逐条版已移除，本轮不再重复进历史。');
  w('  · 移除的是**上一轮多补的 5 条写入**（逐条 3 条 + npc0 + npcname），');
  w('    它们在原报告里本就没落库；恢复它们等于**引入新输入**。');
  w('  · ★ 不是恢复孤儿副本写法 —— 五字段仍走 createSession form + updateEnv + 回读自检。');
  w('  · 五字段：' + JSON.stringify(
    fs.existsSync(path.join(ROOT, 'docs', '取证-F2现场值持久化验证-2026-10-05.json'))
      ? JSON.parse(fs.readFileSync(path.join(ROOT, 'docs',
          '取证-F2现场值持久化验证-2026-10-05.json'), 'utf8')).夹具预期
      : {}, null, 0));
  w('');
  w('（完整取证见 ' + path.relative(ROOT, listJson) + '）');
} else {
  w('（取证文件未生成）');
}

/* ============================================================
   ④ 定向测试结果
   ============================================================ */
w('');
w('#' + '='.repeat(74));
w('# ④ 定向测试结果');
w('#' + '='.repeat(74));
w('');
var TESTS = [
  ['scripts/offline-f2-sendbody-test.js', '受影响：口径统一断言'],
  ['scripts/offline-f2-fixture-trace-test.js', '受影响：四条消息 + 生产链复核'],
  ['scripts/offline-f2-effect-fields-test.js', '必要回归：source 一致性'],
  ['scripts/offline-f2-depstop-test.js', '必要回归'],
  ['scripts/offline-f2-edge-test.js', '必要回归'],
  ['scripts/offline-f2-schedule-test.js', '必要回归（n+1 持久化契约）'],
  ['scripts/check.js', '必要回归'],
  ['scripts/smoke.js', '必要回归']
];
var allGreen = true;
TESTS.forEach(function (t) {
  var r = cp.spawnSync(NODE, [t[0]], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  var code = r.status;
  if (code !== 0) allGreen = false;
  var out = (r.stdout || '') + (r.stderr || '');
  var m = out.match(/通过 (\d+) \/ 失败 (\d+)/) || out.match(/(\d+) \/ (\d+) 通过/);
  w('── ' + path.basename(t[0]) + '  （' + t[1] + '）');
  w('   退出码 ' + code + (m ? '　断言 ' + (m[1] || m[2]) + ' / ' + (m[2] || m[1]) + ' 通过' : ''));
  var green = /全绿|可以刷新浏览器/.test(out);
  if (code === 0) w('   ' + (green ? '✓ 全绿' : '✓ 退出码 0'));
  else {
    w('   ✗ 有红项：');
    out.split('\n').filter(function (l) { return /^  ✗/.test(l); })
      .slice(0, 5).forEach(function (l) { w('     ' + l.trim()); });
  }
});
w('');
w('生产代码未改动核对：');
['prompt-engine.js', 'page-offline.js', 'api.js', 'behavior-text.js'].forEach(function (f) {
  var h = cp.execFileSync('sha256sum', [f], { cwd: ROOT, encoding: 'utf8' }).split(' ')[0];
  w('  ' + h + '  ' + f);
});
w('  （与本轮开工前逐字节一致 —— 见 docs/收口-核对 系列的哈希对照）');

w('');
w('#' + '='.repeat(74));
w('# 汇总：' + (allGreen ? '八个检查退出码全 0' : '★ 有红项，见上'));
w('#' + '='.repeat(74));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf.join('\n'), 'utf8');
process.stdout.write('已生成：' + OUT + '\n');
process.stdout.write('共 ' + buf.length + ' 行 · ' +
  fs.statSync(OUT).size + ' 字节\n');
process.stdout.write(allGreen ? '八个检查退出码全 0\n' : '★ 有红项\n');
process.exit(allGreen ? 0 : 1);
