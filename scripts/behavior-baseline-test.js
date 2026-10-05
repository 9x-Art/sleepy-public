#!/usr/bin/env node
/* ============================================================
   scripts/behavior-baseline-test.js — 迁移前基线的只读比较

   跑法：node scripts/behavior-baseline-test.js

   ★ 本脚本**不写基线**。这条有两层证据：
       ① 源码检查（辅助）—— 所有写调用都只指向一个 os.tmpdir 里的临时副本，
          绝不指向基线路径；
       ② 指纹核对（主证据）—— 比较前后读回基线文件，sha256 必须一字不变。
   ★ 不接生产、不进 index.html、不调模型、不发网络请求、不读真实用户数据。
   ★ 退出码：一致 = 0，有漂移 = 1。

   ---- 比较范围（§四「对照范围与夹具元信息保留」）----
   比：env + fixture + captures + gaps（= capture 脚本的 comparedPart）
   不比：runLog —— 工具自身每次都会变的运行信息（采集时刻、Node 版本、argv、
         定时器入队条数）。**请求内容里不做任何时间归一化**：不把日期换成
         <TS>、不删不改身份 / 语言 / 历史 —— 冻结时钟已保证稳定，
         归一化等于把「内容真的变了」也一起盖掉。
   ============================================================ */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var H = require('./harness.js');
var CAP = require('./behavior-baseline-capture.js');

var BASELINE = CAP.BASELINE;

var pass = 0, fail = 0;
var problems = [];

function head(t) { process.stdout.write('\n' + t + '\n'); }
function ok(m) { pass++; process.stdout.write('  \u2713 ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  \u2717 ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what ? what : '') + '期望 ' + y + '，实得 ' + x);
}
/* 同步断言；抛错即失败，不抛即通过 */
function t(name, fn) {
  try { fn(); ok(name); }
  catch (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); }
}

/* ============================================================
   1. 差异定位：逐 capture、逐字段比对，报出可定位的位置
   ============================================================ */
function fieldDiff(a, b, p, out, cap) {
  if (out.length >= 60 || a === b) return;
  var ta = Object.prototype.toString.call(a), tb = Object.prototype.toString.call(b);
  if (ta !== tb || (ta !== '[object Array]' && ta !== '[object Object]')) {
    out.push(cap + p + '：期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a));
    return;
  }
  if (ta === '[object Array]') {
    if (a.length !== b.length) out.push(cap + p + ' 长度：期望 ' + b.length + '，实得 ' + a.length);
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) fieldDiff(a[i], b[i], p + '[' + i + ']', out, cap);
    return;
  }
  var keys = {};
  Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
  Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).forEach(function (k) {
    fieldDiff(a ? a[k] : undefined, b ? b[k] : undefined, p + '.' + k, out, cap);
  });
}

/* actual = 本次实捕，expected = 基线。返回差异列表（空 = 一致） */
function compareDoc(actual, expected) {
  var out = [];
  var caps = {};
  Object.keys(actual.captures || {}).forEach(function (k) { caps[k] = 1; });
  Object.keys(expected.captures || {}).forEach(function (k) { caps[k] = 1; });
  Object.keys(caps).forEach(function (k) {
    fieldDiff(actual.captures[k], expected.captures[k], '', out, k + ' ');
  });
  fieldDiff(actual.env, expected.env, '', out, 'env ');
  fieldDiff(actual.fixture, expected.fixture, '', out, 'fixture ');
  fieldDiff(actual.gaps, expected.gaps, '', out, 'gaps ');
  return out;
}
function shortList(list, n) {
  return list.slice(0, n).map(function (x) { return '\n      · ' + x; }).join('') +
    (list.length > n ? '\n      · …… 另有 ' + (list.length - n) + ' 处' : '');
}

/* ============================================================
   2. 基线文件（同步部分）
   ============================================================ */
head('基线文件');

var RAW = fs.readFileSync(BASELINE, 'utf8');
var BASELINE_SHA_BEFORE = H.sha256(RAW);
var BASE = JSON.parse(RAW);
var BASE_COMPARED = CAP.comparedPart(BASE);

t('基线可解析且版本串正确', function () {
  eq(BASE.baselineVersion, CAP.BASELINE_VERSION, 'baselineVersion：');
});

t('被比较范围恰为 env / fixture / captures / gaps（runLog 不在内）', function () {
  eq(Object.keys(BASE_COMPARED).sort(), ['captures', 'env', 'fixture', 'gaps']);
  assert(BASE.runLog && BASE.runLog.capturedAtUtc, 'runLog 应存在（工具运行信息）');
  assert(BASE_COMPARED.runLog === undefined, 'runLog 混进了被比较范围');
});

t('基线保留夹具元信息与缺口清单（不只是一堆请求）', function () {
  assert(BASE.fixture && BASE.fixture.sentinels &&
    Object.keys(BASE.fixture.sentinels).length >= 20, '夹具哨兵元信息缺失或过少');
  assert(BASE.fixture && BASE.fixture.probes &&
    Object.keys(BASE.fixture.probes).length >= 10, '静态探针元信息缺失或过少');
  assert(Array.isArray(BASE.gaps) && BASE.gaps.length >= 10, 'gaps 缺失或过少');
  assert(BASE.env && BASE.env.tz && BASE.env.fixedMs && BASE.env.randomSeed, 'env 冻结参数缺失');
  assert(Array.isArray(BASE.env.indexHtmlOrder) && BASE.env.indexHtmlOrder.length > 10,
    'index.html 脚本顺序没记进基线');
});

t('请求内容里没有时间占位符（冻结时钟，不做归一化）', function () {
  ['<TS>', '<ts>', '{{', '${'].forEach(function (mark) {
    assert(RAW.indexOf(mark) < 0, '基线里出现占位符 ' + mark);
  });
  assert(RAW.indexOf(String(BASE.env.fixedMs)) > 0, '冻结时刻没出现在基线里');
});

t('采集时刻只出现在 runLog，没混进被比较的请求内容', function () {
  var at = BASE.runLog.capturedAtUtc;
  assert(RAW.indexOf(at) > 0, 'runLog 里找不到采集时刻');
  assert(JSON.stringify(BASE_COMPARED).indexOf(at) < 0, '采集时刻混进了被比较内容');
  assert(JSON.stringify(BASE_COMPARED).indexOf('"capturedAtUtc"') < 0, 'capturedAtUtc 混进来了');
});

t('缺口清单覆盖五条边界（不是「全部已完成」的口径）', function () {
  var kinds = {};
  BASE.gaps.forEach(function (g) { kinds[g.kind] = (kinds[g.kind] || 0) + 1; });
  ['boundary', 'unreachable', 'dispatch', 'known-behavior'].forEach(function (k) {
    assert(kinds[k] > 0, '缺口清单里没有 ' + k + ' 这一类');
  });
  BASE.gaps.forEach(function (g) {
    assert(g.scenario && g.what && g.detail && g.detail.length > 20,
      '缺口条目信息不完整：' + JSON.stringify(g));
  });
});

/* ============================================================
   3. 顺序流程：重新捕获 → 比较 → 分流断言 → 负向对照 → 纪律核对
   ============================================================ */
var ACTUAL = null;
var TMP = path.join(os.tmpdir(), 'sleepy-baseline-drift-' + process.pid + '.json');

head('重新捕获并比较（每个用例全新沙箱）');

CAP.runAll().then(function (run) {
  ACTUAL = CAP.comparedPart(CAP.buildDocument(run));

  /* --- 3.1 逐字节比较 --- */
  eq(Object.keys(ACTUAL.captures).length, Object.keys(BASE.captures).length, '用例数：');
  var diffs = compareDoc(ACTUAL, BASE_COMPARED);
  if (diffs.length) bad('出站产物与基线逐字节一致' + shortList(diffs, 12));
  else ok('出站产物与基线逐字节一致（' + Object.keys(ACTUAL.captures).length + ' 个用例，' +
    H.sha256(JSON.stringify(ACTUAL)).slice(0, 16) + '…）');

  /* --- 3.2 边界标注诚实性 --- */
  var p = ACTUAL.captures.proactive;
  eq(p.scope, 'transport', '主动消息的边界：');
  eq(p.transportCalls, 1, '主动消息的传输记录器调用次数：');
  ok('主动消息走了传输记录器（transportCalls=' + p.transportCalls +
    '，非零调用才算成功；被 gate 拦下的零调用不会被记成通过）');

  ['online', 'offline', 'groupOnline', 'groupOffline'].forEach(function (k) {
    assert(ACTUAL.captures[k].scope === 'assembly', k + ' 的边界标错了');
    assert(ACTUAL.captures[k].transportCalls === 0, k + ' 不该有传输记录器调用');
  });
  ok('四条装配线标 assembly 且 transportCalls=0（不冒充传输边界）');

  eq(ACTUAL.captures.groupOnline.checks.requestPassedRecorder, false, '群线上 requestPassedRecorder：');
  ok('群线上 messages 完整但明确标「未经传输记录器」');

  eq(ACTUAL.captures.groupOffline.messages, null, '群线下 messages：');
  assert(typeof ACTUAL.captures.groupOffline.system === 'string' &&
    ACTUAL.captures.groupOffline.system.length > 100, '群线下 system 串没抓到');
  ok('群线下只捕到 system 串（user 消息内联在未导出的 renderScene 里，见 gaps）');

  /* --- 3.3 哨兵命中矩阵 --- */
  var regressed = [];
  Object.keys(ACTUAL.captures).forEach(function (k) {
    Object.keys(ACTUAL.captures[k].sentinels).forEach(function (x) {
      if (BASE.captures[k].sentinels[x] && !ACTUAL.captures[k].sentinels[x]) regressed.push(k + ':' + x);
    });
  });
  eq(regressed, [], '相对基线新出现的未命中：');
  ok('哨兵 / 探针命中矩阵与基线一致');

  /* --- 3.4 分流断言（按真实消费路径）--- */
  head('分流断言（§五）');
  function checksOf(k) { return ACTUAL.captures[k].checks || {}; }
  function slotsOf(k) { return ACTUAL.captures[k].slots || []; }
  function slotOn(k, id) {
    var s = slotsOf(k).filter(function (x) { return x.id === id; })[0];
    return s ? !!s.on : null;
  }

  t('有效 override：外壳正文被替换，默认外壳正文消失', function () {
    var c = checksOf('onlineOverride');
    eq([c.shellSlotOn, c.shellDefaultBodyInMessages], [true, false], '有效 override：');
    eq(ACTUAL.captures.onlineOverride.sentinels.overrideShell, true, 'override 文本没进请求：');
  });

  t('空 override：槽仍 on，但 messages 里没有正文（幽灵槽如实记录）', function () {
    var c = checksOf('onlineOverrideEmpty');
    eq([c.shellSlotOn, c.shellDefaultBodyInMessages], [true, false], '空 override：');
    eq(ACTUAL.captures.onlineOverrideEmpty.sentinels.overrideShell, false, '空 override 不该有正文：');
  });

  t('disabled：非 required 卡（pat）真的消失', function () {
    eq(checksOf('onlineDisabledPat').patSlotOn, false, 'pat 槽：');
    eq(ACTUAL.captures.onlineDisabledPat.sentinels['probe.patSpec'], false, 'pat 正文还在：');
  });

  t('required 卡（shell / f1）关不掉 —— 不预设可关闭', function () {
    var c = checksOf('onlineDisabledRequired');
    eq([c.shellSlotOn, c.f1SlotOn, c.shellDefaultBodyInMessages], [true, true, true], 'required 卡：');
    eq(slotsOf('onlineDisabledRequired').filter(function (s) { return s.required && !s.on; }), [],
      '被关掉的 required 槽：');
  });

  t('生活动态非空 / 空：槽 on/off 与正文同步变化', function () {
    eq([checksOf('online').lifeSlotOn, checksOf('online').momentInMessages], [true, true], 'life 非空：');
    eq([checksOf('onlineLifeEmpty').lifeSlotOn, checksOf('onlineLifeEmpty').momentInMessages],
      [false, false], 'life 空：');
  });

  t('召回：本夹具下 recall 槽为 off，且缺口清单里登记了「召回非空未覆盖」', function () {
    ['online', 'offline'].forEach(function (k) {
      assert(slotOn(k, 'recall') === false, k + ' 的 recall 槽不是 off（夹具假设失效）');
    });
    assert(BASE.gaps.some(function (g) { return /召回非空/.test(g.what); }),
      'gaps 里没有登记「召回非空未覆盖」');
  });

  t('线下空 override 与线上语义不同（壳槽整体 off）—— 如实记下，不当成同一回事', function () {
    var c = checksOf('offlineOverrideEmpty');
    eq([c.shellSlotOn, c.shellDefaultBodyInMessages], [false, false], '线下空 override：');
    eq(checksOf('offline').shellSlotOn, true, '线下默认：');
  });

  /* --- 3.5 负向对照：临时副本漂移，不动正式基线 --- */
  head('负向对照（临时副本，不动正式基线）');
  var driftCount = 0;

  t('把副本里的一条请求正文改一个字 → 比较必须失败', function () {
    var copy = JSON.parse(RAW);
    var target = null;
    var keys = Object.keys(copy.captures);
    for (var i = 0; i < keys.length && !target; i++) {
      var msgs = copy.captures[keys[i]].messages;
      if (!msgs) continue;
      for (var j = 0; j < msgs.length; j++) {
        if (typeof msgs[j].content === 'string' && msgs[j].content.indexOf('夹具') >= 0) {
          target = { k: keys[i], j: j };
          break;
        }
      }
    }
    assert(target, '副本里找不到可漂移的请求正文');
    var before = copy.captures[target.k].messages[target.j].content;
    copy.captures[target.k].messages[target.j].content = before.replace('夹具', '夹貝');
    assert(copy.captures[target.k].messages[target.j].content !== before, '漂移没生效');
    fs.writeFileSync(TMP, JSON.stringify(copy), 'utf8');

    var driftDiffs = compareDoc(ACTUAL, CAP.comparedPart(JSON.parse(fs.readFileSync(TMP, 'utf8'))));
    driftCount = driftDiffs.length;
    assert(driftDiffs.length > 0, '副本只差一个字，比较却没失败（比较器是空转的）');
    assert(driftDiffs.some(function (d) { return d.indexOf('夹貝') >= 0; }),
      '差异里看不到漂移的那个字：' + JSON.stringify(driftDiffs.slice(0, 3)));
    process.stdout.write('      · 漂移位置 ' + target.k + '.messages[' + target.j +
      ']（一个汉字）→ 报出 ' + driftDiffs.length + ' 处差异\n');
  });

  t('正式基线没被当基线之外的东西用：实捕仍与基线一致，且漂移副本≠实捕', function () {
    assert(driftCount > 0, '负向对照没有跑起来');
    eq(compareDoc(ACTUAL, BASE_COMPARED), [], '正式基线出现差异：');
    var copy = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    assert(compareDoc(ACTUAL, CAP.comparedPart(copy)).length > 0, '漂移副本竟然与实捕一致');
  });

  try { fs.unlinkSync(TMP); } catch (e) { /* 删不掉不影响结论 */ }

  /* --- 3.6 比较器纪律 --- */
  head('比较器纪律');
  var SRC = fs.readFileSync(__filename, 'utf8');

  t('源码里的写 / 删目标只有临时副本，绝不可能是基线（辅助检查）', function () {
    /* 所有关键词都在运行时拼出来 —— 源码里不出现完整字面量，
       否则 grep 会命中模式串自己（自指误报，这个坑踩过两次）。 */
    var W = ['write', 'FileSync'].join('');
    var R = ['read', 'FileSync'].join('');
    var U = ['unlink', 'Sync'].join('');
    var rx = function (body) { return new RegExp(body, 'g'); };

    var wCount = (SRC.match(rx('fs\\.' + W + '\\(')) || []).length;
    var uCount = (SRC.match(rx('fs\\.' + U + '\\(')) || []).length;
    var rCount = (SRC.match(rx('fs\\.' + R + '\\(')) || []).length;
    eq([wCount, uCount], [1, 1], '写 / 删调用处数：');
    assert(rCount >= 1, '读调用一处都没有（检查口径失效）');

    assert(rx('fs\\.' + W + '\\(' + 'TMP').test(SRC), '唯一的写调用不是写临时副本');
    assert(rx('fs\\.' + U + '\\(' + 'TMP').test(SRC), '唯一的删调用不是删临时副本');
    assert(rx('fs\\.' + R + '\\(' + 'BASELINE').test(SRC), '基线路径没出现在读调用里');

    /* 任何「把基线当写目标」的写法都必须不存在 */
    ['append', 'FileSync'].join('') &&
      [['append', 'FileSync'].join(''), ['create', 'WriteStream'].join(''),
        ['mkdir', 'Sync'].join(''), ['rm', 'Sync'].join(''), ['rmdir', 'Sync'].join(''),
        ['write', 'FileSync', '(', 'BASELINE'].join(''),
        ['write', 'FileSync', '(', 'CAP.BASELINE'].join('')].forEach(function (bad) {
        assert(SRC.indexOf(bad) < 0, '比较器源码里出现 ' + bad);
      });
    ok('fs 调用：写 / 删各 1 处且都指向 os.tmpdir 的临时副本；基线只被读');
  });

  t('比较前后，基线文件内容指纹一字不变（主证据）', function () {
    var after = H.sha256(fs.readFileSync(BASELINE, 'utf8'));
    assert(after === BASELINE_SHA_BEFORE,
      '基线被改了！before=' + BASELINE_SHA_BEFORE + ' after=' + after);
  });

  t('临时副本已被清掉', function () {
    assert(!fs.existsSync(TMP), '临时副本没删：' + TMP);
  });

  t('捕获没有改动宿主全局（Date / Math.random 原样）', function () {
    assert(Date === H.__hostDate, '宿主 Date 被替换过');
    assert(Math.random === H.__hostRandom, '宿主 Math.random 被替换过');
    var probe = Math.random();
    assert(typeof probe === 'number' && probe >= 0 && probe < 1, '宿主 Math.random 坏了');
  });

  t('每个用例都在自己的沙箱里，且加载期没碰被禁资源', function () {
    var ks = Object.keys(BASE.runLog.diagnostics);
    eq(ks.length, Object.keys(BASE.captures).length, '诊断条数与用例数：');
    ks.forEach(function (k) {
      var d = BASE.runLog.diagnostics[k];
      eq(d.scriptsFailed, 0, k + ' 脚本加载失败数：');
      eq(d.forbiddenAccess, [], k + ' 触碰被禁资源：');
      assert(d.scriptsLoaded > 10, k + ' 加载脚本数异常：' + d.scriptsLoaded);
    });
    ok(ks.length + ' 个用例全部 0 失败、0 违禁访问（每个用例独立沙箱）');
  });

  t('改动返回值不会污染后续调用（捕获时即深拷贝）', function () {
    var snap = JSON.stringify(BASE_COMPARED.captures.online.messages);
    var mine = JSON.stringify(ACTUAL.captures.online.messages);
    assert(snap === mine, '实捕与基线本来就该一致');
    ACTUAL.captures.online.messages[0].content = 'HACK';
    eq(JSON.stringify(BASE_COMPARED.captures.online.messages), snap, '基线被外部改动污染：');
    eq(JSON.stringify(CAP.comparedPart(BASE).captures.online.messages), snap, '重新取基线被污染：');
    /* 复原，免得影响后面的摘要指纹 */
    ACTUAL.captures.online.messages[0].content = JSON.parse(snap)[0].content;
    eq(JSON.stringify(ACTUAL.captures.online.messages), snap, '复原失败：');
  });
}, function (e) {
  bad('重新捕获失败：' + ((e && e.stack) || e));
}).then(function () {
  /* ============================================================
     汇总
     ============================================================ */
  head('证据摘要');
  process.stdout.write('  基线文件        ' + BASELINE + '\n');
  process.stdout.write('  基线指纹        ' + BASELINE_SHA_BEFORE.slice(0, 32) + '…\n');
  if (ACTUAL) {
    process.stdout.write('  被比较内容指纹  ' + H.sha256(JSON.stringify(ACTUAL)).slice(0, 32) + '…\n');
  }
  process.stdout.write('  用例            ' + Object.keys(BASE.captures).join(', ') + '\n');
  process.stdout.write('  缺口条数        ' + BASE.gaps.length + '\n');
  process.stdout.write('\n小手机 · 迁移前基线比较\n\n');
  if (fail) {
    process.stdout.write('  ' + fail + ' 项未通过：\n');
    problems.forEach(function (p) { process.stdout.write('    - ' + p + '\n'); });
    process.stdout.write('\n');
    process.exit(1);
  }
  process.stdout.write('  ' + pass + ' 项通过\n');
  process.stdout.write('  结论：装配产物与迁移前基线一致；本批未接生产、未改装配\n\n');
  process.exit(0);
});
