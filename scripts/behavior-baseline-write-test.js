#!/usr/bin/env node
/* ============================================================
   scripts/behavior-baseline-write-test.js
   —— 基线写入路径的独立测试（**独立范围**，与 B 批迁移分开验收）

   跑法：node scripts/behavior-baseline-write-test.js

   ★ 只在 **os.tmpdir() 下的临时目录** 里做写入实验。
   ★ **正式 v1 基线不写、不删、不覆盖**；测试前后核对它的完整指纹。
   ★ 不为了测权限错误去改真实目录的权限（用文件占位目录名的办法造非 EEXIST 错）。
   ★ 不调模型、不发网络请求、不接生产。
   ============================================================ */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..');
var CAPTURE = path.join(ROOT, 'scripts', 'behavior-baseline-capture.js');
var V1 = path.join(ROOT, 'scripts', 'fixtures', 'behavior-baseline-v1.json');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

var pass = 0, fail = 0;
var problems = [];
function head(t) { process.stdout.write('\n' + t + '\n'); }
function ok(m) { pass++; process.stdout.write('  \u2713 ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  \u2717 ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + '期望 ' + y + '，实得 ' + x);
}
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); } }

/* 正式 v1 基线的开工指纹 —— 全程必须一字不变 */
var V1_SHA_BEFORE = fs.existsSync(V1) ? sha256(fs.readFileSync(V1, 'utf8')) : null;
var V1_STAT_BEFORE = fs.existsSync(V1) ? fs.statSync(V1) : null;

/* 临时根目录（本次测试自己建、用完自己删） */
var TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepy-baseline-write-'));
var created = [];

/* 跑一次 capture（带参数 / 环境变量），返回 {code, out} */
function runCapture(args, env) {
  var e = Object.assign({}, process.env, env || {});
  var r = spawnSync(process.execPath, [CAPTURE].concat(args), {
    encoding: 'utf8', env: e, cwd: ROOT, maxBuffer: 32 * 1024 * 1024
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function tmpPath(name) {
  var p = path.join(TMP_ROOT, name);
  created.push(p);
  return p;
}

head('参数拒绝（在捕获前完成）');

t('--force 不再支持：显式报错、退出码 1、且不产生任何文件', function () {
  var target = tmpPath('force-should-not-exist.json');
  var r = runCapture(['--force'], { SLEEPY_BASELINE_PATH: target });
  eq(r.code, 1, '退出码：');
  assert(/--force 不再支持/.test(r.out), '没有显式报「不再支持」：' + r.out.slice(0, 200));
  assert(!fs.existsSync(target), '--force 竟然产生了文件');
  /* 必须是**捕获前**拒绝：输出里不该出现捕获报告 */
  assert(r.out.indexOf('用例') < 0, '--force 拒绝发生在捕获之后（输出里有捕获报告）');
  assert(/单独授权/.test(r.out), '报错文案没说清「需单独授权」');
});

t('--write --force 一起给：同样被拒（--force 优先）', function () {
  var target = tmpPath('write-force.json');
  var r = runCapture(['--write', '--force'], { SLEEPY_BASELINE_PATH: target });
  eq(r.code, 1, '退出码：');
  assert(!fs.existsSync(target), '竟然写了文件');
});

t('无参数：只捕获，不写盘', function () {
  var target = tmpPath('no-args.json');
  var r = runCapture([], { SLEEPY_BASELINE_PATH: target });
  eq(r.code, 0, '退出码：');
  assert(/未加 --write/.test(r.out), '没有「未加 --write」提示：' + r.out.slice(-160));
  assert(!fs.existsSync(target), '无参数竟然写了文件');
});

head('创建 / 拒绝覆盖');

t('--write：文件不存在 → 成功创建，内容可解析且指纹自洽', function () {
  var target = tmpPath('create-ok.json');
  var r = runCapture(['--write'], { SLEEPY_BASELINE_PATH: target });
  eq(r.code, 0, '退出码：' + r.out.slice(-300));
  assert(fs.existsSync(target), '文件没被创建');
  var txt = fs.readFileSync(target, 'utf8');
  var doc = JSON.parse(txt);
  eq(doc.baselineVersion, 'behavior-baseline-v1', 'baselineVersion：');
  /* 写入完整：文件里必须有结尾换行 + 合法 JSON（半截 JSON 会解析失败） */
  assert(txt.slice(-1) === '\n', '文件结尾不是换行（可能短写）');
  assert(/\n$/.test(txt) && txt.indexOf('"gaps"') > 0, 'gaps 段缺失（写入不完整）');
});

t('--write：文件已存在 → 拒绝，退出码 1，且原文件一字不改', function () {
  var target = tmpPath('exists.json');
  fs.writeFileSync(target, '{"sentinel":"不要动我"}\n', 'utf8');
  var before = sha256(fs.readFileSync(target, 'utf8'));
  var r = runCapture(['--write'], { SLEEPY_BASELINE_PATH: target });
  eq(r.code, 1, '退出码：');
  assert(/已存在/.test(r.out), '没有报「已存在」：' + r.out.slice(-200));
  assert(!/不再支持/.test(r.out), '把 EEXIST 误报成了 --force 的错');
  var after = sha256(fs.readFileSync(target, 'utf8'));
  eq(after, before, '已存在的文件被改了：');
});

t('排他创建：不存在 TOCTOU 窗口（existsSync 与写入之间没有检查-再写）', function () {
  var src = fs.readFileSync(CAPTURE, 'utf8');
  var E = ['exists', 'Sync'].join('');
  assert(src.indexOf('fs.' + E + '(BASELINE') < 0 && src.indexOf('fs.' + E + '(target') < 0,
    '仍在用「先检查存在再写」的写法');
  var WX = "'wx'";
  assert(src.indexOf(WX) >= 0, '没有用排他创建标志 ' + WX);
});

head('非 EEXIST 错误如实报告');

t('落点父路径被文件占住 → 如实报错，不冒充「已存在」', function () {
  /* 造法：把一个**文件**当成目录用（不改任何真实目录权限） */
  var blocker = tmpPath('blocker-file');
  fs.writeFileSync(blocker, 'x', 'utf8');
  var target = path.join(blocker, 'nested', 'baseline.json');
  var r = runCapture(['--write'], { SLEEPY_BASELINE_PATH: target });
  eq(r.code, 1, '退出码：');
  assert(!/已存在/.test(r.out), '把非 EEXIST 错误冒充成了「已存在」：' + r.out.slice(-200));
  assert(/无法创建目录|创建基线失败|ENOTDIR|EEXIST/.test(r.out),
    '没有如实报告错误：' + r.out.slice(-200));
});

head('正式 v1 基线只读');

t('v1 基线未被写入、未被删除、未被覆盖', function () {
  assert(V1_SHA_BEFORE !== null, 'v1 基线本来就不存在（前置条件不成立）');
  assert(fs.existsSync(V1), 'v1 基线不见了');
  eq(sha256(fs.readFileSync(V1, 'utf8')), V1_SHA_BEFORE, 'v1 基线内容指纹：');
  var st = fs.statSync(V1);
  eq([st.size, st.mtimeMs], [V1_STAT_BEFORE.size, V1_STAT_BEFORE.mtimeMs],
    'v1 基线 size / mtime：');
});

t('本测试的所有写入都落在临时目录内', function () {
  created.forEach(function (p) {
    assert(p.indexOf(TMP_ROOT) === 0, '有产物落在临时目录之外：' + p);
  });
  assert(TMP_ROOT.indexOf(os.tmpdir()) === 0, '临时根不在 os.tmpdir 下：' + TMP_ROOT);
});

head('收尾与来源');

t('capture 脚本的写调用只有「排他创建 + 可靠写入」这一条路径', function () {
  var src = fs.readFileSync(CAPTURE, 'utf8');
  var W = ['write', 'FileSync'].join('');
  var OS = ['open', 'Sync'].join('');
  var WS = ['write', 'Sync'].join('');
  /* 不再有一次性 writeFileSync（那会掩盖短写） */
  assert(src.indexOf('fs.' + W + '(') < 0, '仍在用 writeFileSync（无法处理短写）');
  assert(src.indexOf('fs.' + OS + '(') >= 0, '没有用 openSync 排他创建');
  assert(src.indexOf('fs.' + WS + '(') >= 0, '没有用 writeSync 循环写');
  assert(/fs\.fsyncSync\(/.test(src), '没有 fsync（落盘不可靠）');
  assert(/fs\.closeSync\(fd\)/.test(src), '没有可靠关闭');
});

/* 清理：只删本次自己创建的临时根 */
var cleanupOk = false;
try {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  cleanupOk = !fs.existsSync(TMP_ROOT);
} catch (e) { cleanupOk = false; }

t('临时产物已清理（失败则如实报告路径）', function () {
  assert(cleanupOk, '临时目录清理失败，请人工检查并删除：' + TMP_ROOT);
});

head('证据摘要');
process.stdout.write('  正式 v1 基线    ' + V1 + '\n');
process.stdout.write('  v1 指纹（前后）  ' + String(V1_SHA_BEFORE).slice(0, 32) + '…\n');
process.stdout.write('  临时根          ' + TMP_ROOT + '（已清理：' + cleanupOk + '）\n');
process.stdout.write('\n小手机 · 基线写入路径测试\n\n');
if (fail) {
  process.stdout.write('  ' + fail + ' 项未通过：\n');
  problems.forEach(function (p) { process.stdout.write('    - ' + p + '\n'); });
  process.stdout.write('\n');
  process.exit(1);
}
process.stdout.write('  ' + pass + ' 项通过\n');
process.stdout.write('  范围：仅基线写入路径（独立于 B 批迁移）\n\n');
process.exit(0);
