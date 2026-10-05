#!/usr/bin/env node
/* ============================================================
   scripts/behavior-text-test.js — 共用行为文本模块的隔离测试
   跑法：node scripts/behavior-text-test.js

   ★ 本测试不接生产、不调模型、不联网、不读真实用户数据。
     它只做两件只读的事：
       1) 把 behavior-text.js 读进一个「隔离桩」沙箱里执行
          （桩上把 document/localStorage/fetch/setTimeout 等全部武装成
            「一碰就抛错」，用来证明本模块没有 DOM/存储/网络/后台任务副作用）
       2) 读仓库内的核版对照表（+ 冻结包，若本机还留着）作为独立核对依据

   覆盖（对应用户本批的测试要求）：
     · 五场景顺序与冻结包 §1 装配清单一致，每个计划内模块只出现一次
     · 正文与独立核对依据（对照表 fenced 正文 + sha256）逐字一致
     · 拼接结果与 parts 顺序一致
     · 无工程说明、卡片引用、幽灵标签、未展开模块引用泄漏
     · 未知输入显式失败（未知场景 / 未知模块 / 空正文不得被标成成功）
     · 返回值外部修改不污染后续调用；重复调用结果稳定
     · 隔离桩验证无禁止副作用（源码关键词检查只作补充）

   退出码：有问题 = 1，全绿 = 0
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');
/* 可用环境变量指到别处的副本（只用于「负向对照」：故意改一个字，测试必须变红） */
var FILE_MODULE = process.env.SLEEPY_BEHAVIOR_MODULE || path.join(ROOT, 'behavior-text.js');
var FILE_TABLE = path.join(ROOT, 'docs', '核版-行为文本模块-正文对照表-2026-10-03.md');
var FILE_PACKAGE = process.env.SLEEPY_BEHAVIOR_PACKAGE ||
  'D:/xwechat_files/wxid_pssvy840knb622_1e4c/temp/RWTemp/2026-10/' +
  '9e20f478899dc29eb19741386f9343c8/Sleepy-·-五场景原创行为文本包-v1｜冻结核版稿.md';

var VERSION = 'sleepy-behavior-v1-review-01';
var MODULE_IDS = ['B', 'P', 'L', 'E', 'N', 'S1', 'S2', 'S3', 'S4', 'S5'];
var SCENES = ['online', 'offline', 'proactive', 'groupOnline', 'groupOffline'];
/* 冻结包 §1 用的中文场景名 → 程序场景 id */
var SCENE_LABEL = {
  '私聊线上': 'online', '私聊线下': 'offline', '主动消息': 'proactive',
  '群线上': 'groupOnline', '群线下': 'groupOffline'
};

var pass = 0, fail = 0, skipped = 0;
var problems = [];

function head(title) { process.stdout.write('\n' + title + '\n'); }
function ok(msg) { pass++; process.stdout.write('  \u2713 ' + msg + '\n'); }
function bad(msg) {
  fail++; problems.push(msg);
  process.stdout.write('  \u2717 ' + msg + '\n');
}
function skip(msg) { skipped++; process.stdout.write('  \u25cb SKIP ' + msg + '\n'); }
function t(name, fn) {
  try { fn(); ok(name); }
  catch (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, what) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what ? what + ' ' : '') + '期望 ' + b + '，实得 ' + a);
}
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/* ============================================================
   0. 隔离桩：两层防守
   ------------------------------------------------------------
   ① 裸全局：沙箱里**根本不存在** document/localStorage/fetch/setTimeout…。
      于是模块一旦引用它们，加载当场 ReferenceError —— 失败得很响。
   ② window.*：装成「一碰就抛错并记账」的陷阱（访问器属性）。
      两条合起来 = DOM/存储/网络/后台任务/Node 互操作 全部封死。
   ============================================================ */

/* ① 裸全局黑名单：沙箱里必须一个都没有（typeof 全为 undefined） */
var ABSENT_GLOBALS = [
  /* DOM */
  'document', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event',
  /* 存储 */
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'openDatabase',
  /* 网络 */
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'importScripts',
  /* 定时与后台任务 */
  'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame',
  'requestIdleCallback', 'queueMicrotask', 'MessageChannel',
  /* Node 互操作 */
  'process', 'require', 'module', 'exports', 'global', 'Buffer',
  /* 窗口导航与事件 */
  'navigator', 'location', 'history', 'screen', 'alert', 'prompt', 'confirm',
  'addEventListener', 'removeEventListener', 'dispatchEvent'
];

/* console 是 vm 上下文自带、删不掉的全局 → 换成「一调用就抛错并记账」的绊线对象 */
var CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir',
  'group', 'groupEnd', 'groupCollapsed', 'time', 'timeEnd', 'timeLog', 'assert', 'count', 'countReset'];

function consoleTripwire(log) {
  var obj = {};
  CONSOLE_METHODS.forEach(function (m) {
    obj[m] = function () {
      log.push('console.' + m);
      throw new Error('禁止调用 console.' + m + '：行为文本模块不应有任何输出');
    };
  });
  return obj;
}

/* ② window.* 陷阱名单（与 ① 同类，只是挂在 window 上） */
var WINDOW_TRAPS = ABSENT_GLOBALS.slice();

function makeSandbox() {
  var log = [];
  var sandbox = {};
  sandbox.window = {};
  /* 非枚举 → 不进 Object.keys，但仍然是上下文里可见的全局 */
  Object.defineProperty(sandbox, 'console', {
    value: consoleTripwire(log), enumerable: false, configurable: true, writable: true
  });
  WINDOW_TRAPS.forEach(function (name) {
    Object.defineProperty(sandbox.window, name, {
      enumerable: false, configurable: true,
      get: function () {
        log.push('window.' + name);
        throw new Error('禁止访问 window.' + name + '：行为文本模块必须是纯函数');
      },
      set: function () {
        log.push('window.' + name);
        throw new Error('禁止写入 window.' + name);
      }
    });
  });
  return { sandbox: sandbox, log: log };
}

var SRC_MODULE = fs.readFileSync(FILE_MODULE, 'utf8');

function loadInto(sandbox) {
  var ctx = vm.createContext(sandbox);
  vm.runInContext(SRC_MODULE, ctx, { filename: 'behavior-text.js' });
  return ctx;
}

function loadFresh() {
  var s = makeSandbox();
  var ctx = loadInto(s.sandbox);
  var ns = s.sandbox.window.Sleepy;
  return { sandbox: s.sandbox, ctx: ctx, log: s.log, ns: ns, bt: ns.behaviorText };
}

var ENV = loadFresh();
var BT = ENV.bt;

/* ============================================================
   1. 隔离加载：只注册约定命名空间，不碰任何危险全局
   ============================================================ */

head('隔离桩加载');

t('沙箱只暴露 window，加载后没有任何额外全局', function () {
  eq(Object.keys(ENV.sandbox), ['window']);
});

t('裸全局一个都不存在（引用即 ReferenceError，加载当场就会红）', function () {
  ABSENT_GLOBALS.forEach(function (name) {
    var kind = vm.runInContext('typeof ' + name, ENV.ctx);
    assert(kind === 'undefined', '沙箱里竟然有 ' + name + '（typeof = ' + kind + '）');
    assert(!Object.prototype.hasOwnProperty.call(ENV.sandbox, name),
      '沙箱对象上挂着 ' + name);
  });
});

t('window.* 上的陷阱确实武装了（探针：读会抛错、写也会抛错）', function () {
  var ctx = vm.createContext(makeSandbox().sandbox);
  var readThrew = false, writeThrew = false;
  try { vm.runInContext('window.fetch', ctx); } catch (e) { readThrew = /禁止访问/.test(e.message); }
  try { vm.runInContext('window.localStorage = 1', ctx); } catch (e) { writeThrew = /禁止写入/.test(e.message); }
  assert(readThrew, '读 window.fetch 没抛错');
  assert(writeThrew, '写 window.localStorage 没抛错');
});

t('console 已换成绊线（调用即抛错）', function () {
  var ctx = vm.createContext(makeSandbox().sandbox);
  var threw = false;
  try { vm.runInContext('console.log(1)', ctx); } catch (e) { threw = /禁止调用/.test(e.message); }
  assert(threw, 'console.log 竟然没抛错（绊线没装上）');
});

t('加载后 window 上只多出 Sleepy 一个键', function () {
  eq(Object.keys(ENV.sandbox.window), ['Sleepy']);
});

t('Sleepy 下只注册 behaviorText 一个命名空间', function () {
  eq(Object.keys(ENV.ns), ['behaviorText']);
});

t('加载期间 0 次触碰被禁全局', function () {
  eq(ENV.log, [], '触碰记录：');
});

t('接口键恰为 VERSION/module/planOf/forScenario（未定义用途的 opts 已删）', function () {
  eq(Object.keys(BT), ['VERSION', 'module', 'planOf', 'forScenario']);
  eq([BT.module.length, BT.planOf.length, BT.forScenario.length], [1, 1, 1], '形参个数：');
});

t('VERSION 与冻结包版本串一致', function () {
  assert(BT.VERSION === VERSION, 'VERSION = ' + JSON.stringify(BT.VERSION));
});

t('接口对象整体冻结（调用方改不动）', function () {
  assert(Object.isFrozen(BT), 'behaviorText 未冻结');
});

t('同一上下文里重复加载会报错，不静默覆盖', function () {
  var s = makeSandbox();
  var ctx = loadInto(s.sandbox);
  var threw = false, msg = '';
  try { vm.runInContext(SRC_MODULE, ctx, { filename: 'behavior-text.js' }); }
  catch (e) { threw = true; msg = e.message; }
  assert(threw, '第二次加载没有报错');
  assert(/behaviorText/.test(msg) && /已存在/.test(msg), '报错信息不明确：' + msg);
  assert(typeof s.sandbox.window.Sleepy.behaviorText.forScenario === 'function',
    '报错之后原实现被破坏了');
});

t('已有同名实现时报错且原对象一个字节都没被改', function () {
  var s = makeSandbox();
  var sentinel = { VERSION: '别人家的', forScenario: function () { return 'sentinel'; } };
  s.sandbox.window.Sleepy = { behaviorText: sentinel };
  var ctx = vm.createContext(s.sandbox);
  var threw = false, msg = '';
  try { vm.runInContext(SRC_MODULE, ctx, { filename: 'behavior-text.js' }); }
  catch (e) { threw = true; msg = e.message; }
  assert(threw, '撞名却没有报错');
  assert(/拒绝覆盖/.test(msg), '报错信息不明确：' + msg);
  assert(s.sandbox.window.Sleepy.behaviorText === sentinel, '原实现被替换了');
  assert(s.sandbox.window.Sleepy.behaviorText.forScenario() === 'sentinel', '原实现被改坏了');
});

t('只在既有 Sleepy 命名空间上追加，不重建整个 Sleepy', function () {
  var s = makeSandbox();
  s.sandbox.window.Sleepy = { somethingElse: 1 };
  var ctx = vm.createContext(s.sandbox);
  vm.runInContext(SRC_MODULE, ctx, { filename: 'behavior-text.js' });
  eq(Object.keys(s.sandbox.window.Sleepy).sort(), ['behaviorText', 'somethingElse']);
  assert(s.sandbox.window.Sleepy.somethingElse === 1, '既有字段被动了');
});

/* ============================================================
   2. 独立核对依据：核版对照表 +（若在）冻结包
   ============================================================ */

head('独立核对依据');

var TABLE = null;
t('对照表可解析：10 个模块、字段齐全', function () {
  assert(fs.existsSync(FILE_TABLE), '对照表不存在：' + FILE_TABLE);
  var md = fs.readFileSync(FILE_TABLE, 'utf8');

  var meta = {}, order = [], usage = {}, body = {}, range = {};
  var rowRe = /^\|\s*([A-Z][0-9]?)\s*\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|\s*`([0-9a-f]{64})`\s*\|\s*$/gm;
  var m;
  while ((m = rowRe.exec(md))) {
    order.push(m[1]);
    meta[m[1]] = {
      source: m[2].trim(), range: m[3].trim(),
      paras: parseInt(m[4].trim(), 10), chars: parseInt(m[5].trim(), 10),
      bytes: parseInt(m[6].trim(), 10), sha: m[7]
    };
  }
  eq(order.slice().sort(), MODULE_IDS.slice().sort(), '总表模块：');

  MODULE_IDS.forEach(function (id) {
    var at = md.indexOf('\n## 模块 ' + id + '\n');
    assert(at >= 0, '找不到「## 模块 ' + id + '」小节');
    var rest = md.slice(at + 1);
    var next = rest.slice(1).search(/\n## /);
    var sec = next < 0 ? rest : rest.slice(0, next + 1);

    var um = sec.match(/- 使用场景：([^\n]+)/);
    var rm = sec.match(/- 正文行区间：(\d+)\s*[\u2013\u2014-]\s*(\d+)/);
    var pm = sec.match(/共 (\d+) 段/);
    var cm = sec.match(/- 字符数：(\d+)\s*｜\s*UTF-8 字节：(\d+)/);
    var sm = sec.match(/- sha256：`([0-9a-f]{64})`/);
    var fm = sec.match(/```text\r?\n([\s\S]*?)\r?\n```/);
    assert(um && rm && pm && cm && sm && fm, '模块 ' + id + ' 小节字段不齐');

    usage[id] = /全部/.test(um[1]) ? SCENES.slice()
      : um[1].split('/').map(function (s) { return s.trim(); }).filter(Boolean);
    usage[id].forEach(function (s) {
      assert(SCENES.indexOf(s) >= 0, '模块 ' + id + ' 的使用场景写了未知场景「' + s + '」');
    });
    range[id] = [parseInt(rm[1], 10), parseInt(rm[2], 10)];
    body[id] = fm[1];
    /* 小节里的数字必须和总表一致，否则表自己就自相矛盾 */
    eq([parseInt(pm[1], 10), parseInt(cm[1], 10), parseInt(cm[2], 10), sm[1]],
      [meta[id].paras, meta[id].chars, meta[id].bytes, meta[id].sha],
      '模块 ' + id + ' 小节与总表：');
  });

  TABLE = { order: order, meta: meta, usage: usage, body: body, range: range, md: md };
});

t('对照表自洽：fenced 正文的 sha256/字符/字节/段数 与表里声明一致', function () {
  assert(TABLE, '对照表未解析成功');
  MODULE_IDS.forEach(function (id) {
    var text = TABLE.body[id];
    eq([sha256(text), text.length, Buffer.byteLength(text, 'utf8'), text.split('\n').length],
      [TABLE.meta[id].sha, TABLE.meta[id].chars, TABLE.meta[id].bytes, TABLE.meta[id].paras],
      '模块 ' + id + '：');
  });
});

var PACKAGE = null;
if (fs.existsSync(FILE_PACKAGE)) {
  try {
    PACKAGE = { md: fs.readFileSync(FILE_PACKAGE, 'utf8'), file: FILE_PACKAGE };
  } catch (e) { PACKAGE = null; }
}

/* 从冻结包机械复提取：定位 `## <id>. ` → `### 正文` → 下一个标题前的非空行 */
function extractFromPackage(md) {
  var lines = md.split('\n');
  var out = {};
  MODULE_IDS.forEach(function (id) {
    var headAt = -1, bodyAt = -1, endAt = lines.length;
    for (var i = 0; i < lines.length; i++) {
      if (new RegExp('^## ' + id + '\\. ').test(lines[i])) { headAt = i; break; }
    }
    assert(headAt >= 0, '冻结包里找不到「## ' + id + '. 」');
    for (var j = headAt; j < lines.length; j++) {
      if (/^### 正文\s*$/.test(lines[j])) { bodyAt = j + 1; break; }
    }
    assert(bodyAt >= 0, '冻结包里「' + id + '」没有 ### 正文');
    for (var k = bodyAt; k < lines.length; k++) {
      if (/^#{2,3} /.test(lines[k])) { endAt = k; break; }
    }
    var rows = [];
    for (var x = bodyAt; x < endAt; x++) if (lines[x].trim() !== '') rows.push(lines[x]);
    out[id] = {
      headLine: headAt + 1, bodyHeadLine: bodyAt,
      first: bodyAt + 1, last: bodyAt + rows.length,
      text: rows.join('\n')
    };
  });
  return out;
}

if (PACKAGE) {
  t('冻结包版本串与模块 VERSION 一致', function () {
    assert(PACKAGE.md.indexOf(VERSION) >= 0, '冻结包里没有 ' + VERSION);
  });
} else {
  skip('冻结包不在本机（' + FILE_PACKAGE + '）→ 跳过基于源包的复提取核对');
}

/* ============================================================
   3. 五场景顺序
   ============================================================ */

head('五场景顺序');

var EXPECTED = {};

if (PACKAGE) {
  t('五场景顺序与冻结包 §1 装配清单逐字一致', function () {
    var md = PACKAGE.md;
    var at = md.indexOf('\n## 1. 装配清单');
    assert(at >= 0, '冻结包里找不到 §1 装配清单');
    var rest = md.slice(at + 1);
    var next = rest.slice(1).search(/\n## /);
    var sec = next < 0 ? rest : rest.slice(0, next + 1);

    var re = /^-\s*([^：:\n]+)：\s*([A-Z][0-9]?(?:\s*\+\s*[A-Z][0-9]?)*)\s*[。.]\s*$/gm;
    var m, found = {};
    while ((m = re.exec(sec))) {
      var scene = SCENE_LABEL[m[1].trim()];
      if (!scene) continue;
      found[scene] = m[2].split('+').map(function (s) { return s.trim(); });
    }
    eq(Object.keys(found).sort(), SCENES.slice().sort(), '清单覆盖的场景：');
    SCENES.forEach(function (scene) {
      var plan = BT.planOf(scene);
      eq(plan, found[scene], scene + '：');
    });
    EXPECTED = found;
  });
} else {
  skip('冻结包不在本机 → 改用对照表「使用场景」推导（下方仍需通过）');
}

t('planOf 与对照表「使用场景」推导出的顺序一致', function () {
  assert(TABLE, '对照表未解析成功');
  var derived = {};
  SCENES.forEach(function (scene) {
    derived[scene] = TABLE.order.filter(function (id) {
      return TABLE.usage[id].indexOf(scene) >= 0;
    });
  });
  SCENES.forEach(function (scene) {
    eq(BT.planOf(scene), derived[scene], scene + '：');
  });
  if (Object.keys(EXPECTED).length) {
    SCENES.forEach(function (scene) { eq(derived[scene], EXPECTED[scene], scene + ' 两依据：'); });
  }
});

t('每个场景恰好 5 个模块、无重复、都有正文', function () {
  SCENES.forEach(function (scene) {
    var plan = BT.planOf(scene);
    assert(plan.length === 5, scene + ' 计划长度 = ' + plan.length);
    eq(new Set(plan).size, plan.length, scene + ' 有重复模块：');
    plan.forEach(function (id) {
      assert(MODULE_IDS.indexOf(id) >= 0, scene + ' 出现未知模块 ' + id);
      assert(typeof BT.module(id) === 'string' && BT.module(id), scene + ' 的 ' + id + ' 正文为空');
    });
  });
});

t('对照表「使用场景」与计划互为反函数（无模块被漏用/多用）', function () {
  assert(TABLE, '对照表未解析成功');
  MODULE_IDS.forEach(function (id) {
    var fromPlans = SCENES.filter(function (s) { return BT.planOf(s).indexOf(id) >= 0; });
    eq(fromPlans.slice().sort(), TABLE.usage[id].slice().sort(), '模块 ' + id + ' 使用场景：');
    assert(fromPlans.length > 0, '模块 ' + id + ' 没有被任何场景使用');
  });
});

t('planOf 每次返回新数组，改它不影响内部常量', function () {
  var a = BT.planOf('online');
  var pristine = BT.planOf('online');
  assert(!Object.isFrozen(a), 'planOf 的返回值是内部常量本身（不应冻结内部数组后直接外发）');
  a.push('HACK');
  a[0] = 'HACK';
  eq(BT.planOf('online'), pristine, 'planOf 内部常量被外部改坏了：');
  eq(BT.planOf('online'), ['B', 'P', 'L', 'E', 'S1']);
});

/* ============================================================
   4. 正文一致
   ============================================================ */

head('正文一致（对照表 = 独立核对依据）');

t('每个模块正文与对照表 fenced 正文逐字一致', function () {
  assert(TABLE, '对照表未解析成功');
  MODULE_IDS.forEach(function (id) {
    var got = BT.module(id);
    if (got !== TABLE.body[id]) {
      var i = 0;
      while (i < got.length && i < TABLE.body[id].length && got[i] === TABLE.body[id][i]) i++;
      throw new Error('模块 ' + id + ' 第 ' + i + ' 个字符起不一致：模块 ' +
        JSON.stringify(got.slice(i, i + 20)) + ' vs 对照表 ' + JSON.stringify(TABLE.body[id].slice(i, i + 20)));
    }
  });
});

t('每个模块 sha256 与对照表一致', function () {
  assert(TABLE, '对照表未解析成功');
  MODULE_IDS.forEach(function (id) {
    eq(sha256(BT.module(id)), TABLE.meta[id].sha, '模块 ' + id + '：');
  });
});

t('每个模块 字符数/字节数/段数 与对照表一致', function () {
  assert(TABLE, '对照表未解析成功');
  MODULE_IDS.forEach(function (id) {
    var text = BT.module(id);
    eq([text.length, Buffer.byteLength(text, 'utf8'), text.split('\n').length],
      [TABLE.meta[id].chars, TABLE.meta[id].bytes, TABLE.meta[id].paras], '模块 ' + id + '：');
  });
});

if (PACKAGE) {
  t('冻结包复提取：正文、sha256、行区间、来源节 与对照表全对得上', function () {
    var pkg = extractFromPackage(PACKAGE.md);
    MODULE_IDS.forEach(function (id) {
      eq(pkg[id].text, TABLE.body[id], '模块 ' + id + ' 复提取正文：');
      eq(sha256(pkg[id].text), TABLE.meta[id].sha, '模块 ' + id + ' 复提取 sha256：');
      eq([pkg[id].first, pkg[id].last], TABLE.range[id], '模块 ' + id + ' 行区间：');
      assert(TABLE.meta[id].source.indexOf('## ' + id + '. ') >= 0,
        '模块 ' + id + ' 来源节没写对：' + TABLE.meta[id].source);
      assert(PACKAGE.md.split('\n')[pkg[id].headLine - 1].indexOf('## ' + id + '. ') === 0,
        '模块 ' + id + ' 标题行号 ' + pkg[id].headLine + ' 对不上');
      assert(/^### 正文/.test(PACKAGE.md.split('\n')[pkg[id].bodyHeadLine - 1]),
        '模块 ' + id + ' 「### 正文」行号 ' + pkg[id].bodyHeadLine + ' 对不上');
    });
  });
} else {
  skip('冻结包不在本机 → 跳过「复提取正文/行区间」核对');
}

t('正文没有 CR、没有行尾空白、没有空段', function () {
  MODULE_IDS.forEach(function (id) {
    var text = BT.module(id);
    assert(text.indexOf('\r') < 0, '模块 ' + id + ' 含 CR');
    assert(text === text.trim(), '模块 ' + id + ' 首尾有空白');
    text.split('\n').forEach(function (line, i) {
      assert(line.trim() !== '', '模块 ' + id + ' 第 ' + (i + 1) + ' 段是空段');
      assert(line === line.trim(), '模块 ' + id + ' 第 ' + (i + 1) + ' 段有行首/行尾空白');
    });
  });
});

/* ============================================================
   5. 拼接
   ============================================================ */

head('拼接一致');

t('每个场景 text === parts 按序以空行拼接', function () {
  SCENES.forEach(function (scene) {
    var r = BT.forScenario(scene);
    assert(r.ok === true, scene + ' 竟然失败：' + r.error);
    eq(r.text, r.parts.map(function (p) { return p.text; }).join('\n\n'), scene + '：');
  });
});

t('parts 的 id 顺序 === modules === planOf，且每段只出现一次', function () {
  SCENES.forEach(function (scene) {
    var r = BT.forScenario(scene);
    var plan = BT.planOf(scene);
    eq(r.modules, plan, scene + ' modules：');
    eq(r.parts.map(function (p) { return p.id; }), plan, scene + ' parts id：');
    eq(new Set(r.modules).size, 5, scene + ' modules 有重复：');
  });
});

t('拼接文本按序包含各段（位置单调递增）', function () {
  SCENES.forEach(function (scene) {
    var r = BT.forScenario(scene);
    var last = -1;
    r.parts.forEach(function (p) {
      var at = r.text.indexOf(p.text);
      assert(at > last, scene + ' 的 ' + p.id + ' 不在预期位置（at=' + at + '，last=' + last + '）');
      last = at;
    });
    eq(r.text.length, r.parts.reduce(function (n, p) { return n + p.text.length; }, 0) +
      (r.parts.length - 1) * 2, scene + ' 拼接长度对不上（可能少了/多了分隔）：');
  });
});

t('parts 里的正文与 module() 逐字相同', function () {
  SCENES.forEach(function (scene) {
    BT.forScenario(scene).parts.forEach(function (p) {
      eq(p.text, BT.module(p.id), scene + '/' + p.id + '：');
    });
  });
});

/* ============================================================
   6. 泄漏检查
   ============================================================ */

head('泄漏检查');

var PUNCT_OK = { '\u3001': 1, '\u3002': 1, '\uff1b': 1, '\uff0c': 1, '\uff1a': 1 };

/* 正文里唯一允许出现的拉丁字母是 user / NPC（人名占位），且只允许紧随一个半角空格 */
function latinLeaks(text) {
  var stripped = text.replace(/ ?(user|NPC) ?/g, '');
  var out = [];
  for (var i = 0; i < stripped.length; i++) {
    var c = stripped[i];
    if (c === '\n') continue;
    if (c.charCodeAt(0) < 128) out.push(JSON.stringify(c) + '@' + i);
  }
  return out;
}
function punctLeaks(text) {
  var out = [];
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    var code = c.charCodeAt(0);
    if (code < 128) continue;
    if (code >= 0x4e00 && code <= 0x9fff) continue;
    if (PUNCT_OK[c]) continue;
    out.push(c + '@' + i);
  }
  return out;
}

t('正文只含汉字 + 、。；，： + user/NPC，没有其他 ASCII 或标点', function () {
  MODULE_IDS.forEach(function (id) {
    var text = BT.module(id);
    var lat = latinLeaks(text), pun = punctLeaks(text);
    assert(lat.length === 0, '模块 ' + id + ' 出现计划外 ASCII：' + lat.slice(0, 6).join(', '));
    assert(pun.length === 0, '模块 ' + id + ' 出现计划外标点：' + pun.slice(0, 6).join(', '));
  });
});

t('无幽灵标签（11 个已知标签名 + 任意大写方括号标签）', function () {
  var GHOSTS = ['[INITIATIVE_PROFILE]', '[AVAILABLE_ACTIONS]', '[RELATION_COMPASS]',
    '[USER_PREFERENCES]', '[ADDRESS_STATE]', '[NARRATIVE_SETTINGS]', '[STYLE_PRESET]',
    '[LENGTH_TARGET]', '[SCENE_STATE]', '[OPENING_MODE]', '[FOCUS_MODE]'];
  var ANY_TAG = /\[[A-Za-z][A-Za-z0-9_\- ]*\]/;
  SCENES.forEach(function (scene) {
    var text = BT.forScenario(scene).text;
    GHOSTS.forEach(function (g) {
      assert(text.indexOf(g) < 0, scene + ' 泄漏幽灵标签 ' + g);
    });
    var m = text.match(ANY_TAG);
    assert(!m, scene + ' 泄漏方括号标签 ' + (m && m[0]));
  });
});

t('无工程说明 / 版本串 / 编号引用 / 卡片引用', function () {
  var FORBIDDEN = [
    'sleepy-behavior-v1-review-01', 'review-01', '冻结包', '核版', '对照表', '冻结',
    '### ', '## ', '§', '```', '|---', '说明：', '来源：', '验收', '阻碍', '待补', 'TODO', 'FIXME',
    'CARD', 'cardId', 'card-', 'groupRound', 'promptEngine', 'assembleOnline', 'assembleOffline',
    'charMetaLines', 'override', 'opts', 'CARD_DEFAULTS', 'PARA_TYPES', 'splitBubbles'
  ];
  MODULE_IDS.forEach(function (id) {
    var text = BT.module(id);
    FORBIDDEN.forEach(function (f) {
      assert(text.indexOf(f) < 0, '模块 ' + id + ' 泄漏「' + f + '」：' +
        JSON.stringify(text.slice(Math.max(0, text.indexOf(f) - 10), text.indexOf(f) + f.length + 10)));
    });
  });
});

t('无未展开模块引用（B/P/L/E/N/S# 配「节/模块/部分」或「见」）', function () {
  var REF = /(?:[（(【\[]?\s*(?:B|P|L|E|N|S[1-5])\s*[）)】\]]?\s*(?:节|模块|部分|章))|(?:见\s*(?:B|P|L|E|N|S[1-5])\b)/;
  MODULE_IDS.forEach(function (id) {
    var text = BT.module(id);
    var m = text.match(REF);
    assert(!m, '模块 ' + id + ' 出现未展开模块引用：' + (m && m[0]));
  });
  SCENES.forEach(function (scene) {
    var text = BT.forScenario(scene).text;
    var m = text.match(REF);
    assert(!m, scene + ' 出现未展开模块引用：' + (m && m[0]));
  });
});

t('拼接文本里每个模块正文只出现一次（没有重复注入）', function () {
  SCENES.forEach(function (scene) {
    var r = BT.forScenario(scene);
    r.parts.forEach(function (p) {
      var first = r.text.indexOf(p.text);
      eq(r.text.indexOf(p.text, first + 1), -1, scene + ' 的 ' + p.id + ' 出现了两次：');
    });
  });
});

/* ============================================================
   7. 未知输入显式失败
   ============================================================ */

head('未知输入');

var UNKNOWN_SCENES = ['nope', '', 'Online', 'online ', ' online', 'online2', 'group', 'S1',
  undefined, null, 0, 1, true, {}, [], ['online'], function () {}];

t('planOf 对未知场景一律返回 null', function () {
  UNKNOWN_SCENES.forEach(function (s) {
    assert(BT.planOf(s) === null, 'planOf(' + JSON.stringify(s) + ') = ' + JSON.stringify(BT.planOf(s)));
  });
});

t('module 对未知 id 返回 null，不回退到其他模块', function () {
  ['X', 's1', 'S6', 'S0', 'b', '', 'B ', ' B', 'modules', undefined, null, 0, {}, []]
    .forEach(function (id) {
      assert(BT.module(id) === null, 'module(' + JSON.stringify(id) + ') = ' + JSON.stringify(BT.module(id)));
    });
});

t('forScenario 对未知输入显式 ok:false 且不抛错', function () {
  UNKNOWN_SCENES.forEach(function (s) {
    var r;
    try { r = BT.forScenario(s); }
    catch (e) { throw new Error('forScenario(' + JSON.stringify(s) + ') 抛错了：' + e.message); }
    assert(r && r.ok === false, 'forScenario(' + JSON.stringify(s) + ') 没显式失败：' + JSON.stringify(r));
    assert(r.error === 'unknown-scene', 'error = ' + JSON.stringify(r.error));
  });
});

t('失败对象形状固定：modules/parts 为空、text 为空、missing 为空数组', function () {
  var r = BT.forScenario('nope');
  eq(Object.keys(r).sort(), ['error', 'missing', 'modules', 'ok', 'parts', 'scene', 'text']);
  eq([r.modules, r.parts, r.missing, r.text], [[], [], [], '']);
  assert(r.scene === 'nope', 'scene 没有原样带回');
  assert(BT.forScenario(undefined).scene === null, '非字符串场景的 scene 应为 null');
  assert(BT.forScenario(123).scene === null, '非字符串场景的 scene 应为 null');
  assert(Object.isFrozen(r), '失败对象没冻结');
  assert(Object.isFrozen(r.modules) && Object.isFrozen(r.parts) && Object.isFrozen(r.missing),
    '失败对象的数组没冻结');
});

t('合法场景与失败对象互不污染（连续调用 5 场景 + 5 未知）', function () {
  SCENES.forEach(function (s) { assert(BT.forScenario(s).ok === true, s + ' 失败'); });
  ['nope', 'x'].forEach(function (s) { assert(BT.forScenario(s).ok === false, s + ' 没失败'); });
  SCENES.forEach(function (s) { assert(BT.forScenario(s).ok === true, s + ' 被污染'); });
});

/* ============================================================
   8. 空正文不得被标成成功（变体源，不改真实文件）
   ============================================================ */

head('空正文与变体');

/* 把某个模块的字符串字面量替换成空串，其余不动 —— 用来验证「空正文不得被标成成功」。
   正文里不含半角双引号，所以非贪婪匹配到的一定是该字面量的收尾引号。 */
function blankModule(src, id) {
  var re = new RegExp('(\\n\\s*' + id + ': )"[\\s\\S]*?"');
  assert(re.test(src), '变体构造失败：找不到 ' + id + ' 的字面量');
  return src.replace(re, '$1""');
}

function loadVariant(src) {
  var s = makeSandbox();
  var ctx = vm.createContext(s.sandbox);
  vm.runInContext(src, ctx, { filename: 'behavior-text-variant.js' });
  return s.sandbox.window.Sleepy.behaviorText;
}

t('变体：B 置空 → 用到 B 的场景全部显式失败 empty-module，不标成功', function () {
  var v = loadVariant(blankModule(SRC_MODULE, 'B'));
  assert(v.module('B') === '', '变体的 B 不是空串');
  SCENES.forEach(function (scene) {
    var r = v.forScenario(scene);
    assert(r.ok === false, scene + ' 在 B 为空时仍被标成成功');
    assert(r.error === 'empty-module', scene + ' error = ' + JSON.stringify(r.error));
    eq(r.missing, ['B'], scene + ' missing：');
    eq([r.modules, r.parts, r.text], [[], [], ''], scene + ' 失败时不该带回半截内容：');
  });
});

t('变体：S2 置空 → 只有 offline 失败，其他场景不受牵连', function () {
  var v = loadVariant(blankModule(SRC_MODULE, 'S2'));
  assert(v.forScenario('offline').ok === false, 'offline 没失败');
  eq(v.forScenario('offline').missing, ['S2']);
  ['online', 'proactive', 'groupOnline', 'groupOffline'].forEach(function (scene) {
    assert(v.forScenario(scene).ok === true, scene + ' 被 S2 牵连失败');
    eq(v.forScenario(scene).modules.indexOf('S2'), -1, scene + ' 不该有 S2：');
  });
});

t('变体：未受影响的场景正文与正式模块逐字一致', function () {
  var v = loadVariant(blankModule(SRC_MODULE, 'S5'));
  ['online', 'offline', 'proactive', 'groupOnline'].forEach(function (scene) {
    eq(v.forScenario(scene).text, BT.forScenario(scene).text, scene + '：');
  });
});

/* ============================================================
   9. 返回值不可被外部修改 / 重复调用稳定
   ============================================================ */

head('不可变性与稳定性');

t('forScenario 返回值及其数组、元素全部冻结', function () {
  SCENES.forEach(function (scene) {
    var r = BT.forScenario(scene);
    assert(Object.isFrozen(r), scene + ' 返回对象没冻结');
    assert(Object.isFrozen(r.modules), scene + ' modules 没冻结');
    assert(Object.isFrozen(r.parts), scene + ' parts 没冻结');
    assert(Object.isFrozen(r.missing), scene + ' missing 没冻结');
    r.parts.forEach(function (p) { assert(Object.isFrozen(p), scene + ' parts 元素没冻结'); });
  });
});

t('尝试 push / 赋值 / delete 之后，后续调用结果一字不变', function () {
  var before = {};
  SCENES.forEach(function (s) { before[s] = JSON.stringify(BT.forScenario(s)); });
  var frozenBefore = MODULE_IDS.map(function (id) { return BT.module(id); });

  var attacks = 0;
  SCENES.forEach(function (scene) {
    var r = BT.forScenario(scene);
    var jobs = [
      function () { r.modules.push('HACK'); },
      function () { r.modules[0] = 'HACK'; },
      function () { delete r.modules[0]; },
      function () { r.parts.push({ id: 'HACK', text: 'HACK' }); },
      function () { r.parts[0].text = 'HACK'; },
      function () { r.parts[0].id = 'HACK'; },
      function () { r.missing.push('HACK'); },
      function () { r.text = 'HACK'; },
      function () { r.ok = false; },
      function () { r.error = 'HACK'; }
    ];
    jobs.forEach(function (job) {
      attacks++;
      try { job(); } catch (e) { /* 冻结对象在严格模式下会抛错，这正是期望 */ }
    });
  });
  assert(attacks === 50, '攻击次数 = ' + attacks);

  SCENES.forEach(function (s) {
    eq(JSON.stringify(BT.forScenario(s)), before[s], s + ' 被外部改动污染：');
  });
  eq(MODULE_IDS.map(function (id) { return BT.module(id); }), frozenBefore, 'module() 被污染：');
  eq(BT.module('B'), TABLE.body.B, 'B 正文被污染：');
});

t('重复调用结果稳定（每场景 10 次 JSON 全等）', function () {
  SCENES.forEach(function (scene) {
    var first = JSON.stringify(BT.forScenario(scene));
    for (var i = 0; i < 10; i++) {
      eq(JSON.stringify(BT.forScenario(scene)), first, scene + ' 第 ' + (i + 2) + ' 次：');
    }
  });
});

t('整轮调用后仍未新增全局、未触碰被禁全局', function () {
  eq(Object.keys(ENV.sandbox), ['window']);
  eq(Object.keys(ENV.sandbox.window), ['Sleepy']);
  eq(ENV.log, [], '触碰记录：');
});

/* ============================================================
   10. 源码关键词（补充，不当作全部证明）
   ============================================================ */

head('源码关键词（补充）');

t('源码无网络/存储/DOM/定时器/Node 互操作关键词', function () {
  var FORBIDDEN = ['document', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch(',
    'XMLHttpRequest', 'WebSocket', 'navigator', 'setTimeout', 'setInterval',
    'requestAnimationFrame', 'queueMicrotask', 'process.', 'require(', 'import ',
    'console.', 'Math.random', 'Date.now', 'new Date', 'fs.'];
  var src = SRC_MODULE;
  FORBIDDEN.forEach(function (f) {
    assert(src.indexOf(f) < 0, '源码出现「' + f + '」');
  });
  /* 只允许唯一一处主动抛错：命名空间撞名守卫 */
  eq((src.match(/throw new Error/g) || []).length, 1, '主动抛错处数：');
});

t('源码未出现 opts（未定义用途的形参已删干净）', function () {
  assert(SRC_MODULE.indexOf('opts') < 0, '源码仍出现 opts');
});

t('源码只注册 behaviorText 一个命名空间', function () {
  eq((SRC_MODULE.match(/NS\.\w+\s*=/g) || []).length, 1, '命名空间赋值处数：');
  assert(/NS\.behaviorText\s*=/.test(SRC_MODULE), '没有注册 behaviorText');
});

/* ============================================================
   11. 生产接入范围（B 批：私聊线上已接入，其余未接）
   ------------------------------------------------------------
   ⚠️ A0 阶段的「未接生产」反向断言已随 B 批迁移作废：
      本文件现在只保留**正文一致性**与**加载期副作用**两部分的测试，
      生产接入范围改为下面这组**正向 + 反向**断言：
        · index.html 必须引用本文件（否则线上拿不到模块）；
        · 引用位置必须早于 prompt-engine.js（唯一消费者的定义处）；
        · 运行时代码里只有 prompt-engine.js 提到它（其余文件 0 命中）；
        · 其他四个场景的装配入口不许出现本模块（本批只迁私聊线上）。
   本条只调整「阶段断言」，不动任何正文断言与副作用测试。
   ============================================================ */

head('生产接入范围');

var CODE_FILES = [];
fs.readdirSync(ROOT).forEach(function (f) {
  if (/\.(js|json|css|html)$/.test(f)) CODE_FILES.push(f);
});
if (fs.existsSync(path.join(ROOT, 'scripts'))) {
  fs.readdirSync(path.join(ROOT, 'scripts')).forEach(function (f) {
    if (/\.(js|json|sh)$/.test(f)) CODE_FILES.push('scripts/' + f);
  });
}

function hitsIn(rel) {
  var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  var hits = [];
  if (src.indexOf('behavior-text') >= 0) hits.push('behavior-text');
  if (src.indexOf('behaviorText') >= 0) hits.push('behaviorText');
  return hits;
}

/* 本批允许「提到 behavior-text.js」的文件白名单：模块自身 + 生产装配点 + 测试/验收脚本。
   ★ 逐个具名追加，**不允许**「整个 scripts/ 目录」豁免 ——
     目录豁免会把这条枚举式白名单降级成目录放行，将来任何新脚本
     （含误引入生产代码的）都自动合法，恰好丢掉本条断言的意图。
     追加的 5 个全部是测试/验收脚本，无一生产装配点；生产侧边界由下方
     「生产装配点只有 prompt-engine.js」独立守着。
     依据：docs/分类-既有测试红项-2026-10-04.md（逐个核实过引用位置与用途）。 */
var BT_ALLOWED = ['behavior-text.js', 'scripts/behavior-text-test.js',
  'scripts/behavior-baseline-capture.js', 'scripts/behavior-baseline-test.js',
  'scripts/behavior-online-migration-test.js', 'prompt-engine.js', 'index.html',
  /* ↓ 本批追加的 5 个测试/验收脚本 */
  'scripts/behavior-offline-migration-test.js',   // F2 线下迁移回归：读模块正文做期望值 + 替换 forScenario 测回退分支
  'scripts/browser-behavior-decision-test.js',   // 决策层验收：故意摘掉模块验证整条回退
  'scripts/browser-offline-f2-test.js',          // F2 无头真 DOM 验收：数五段出现次数
  'scripts/offline-f2-effect-acceptance.js',     // F2 效果真机验收：只取 VERSION 记进报告做溯源
  'scripts/smoke.js',                            // 全量冒烟：模块存在性门禁 + btDecideScene 导出检查
  /* ↓ 2026-10-05 追加的 6 个（逐个核实过引用位置与用途，无一生产装配点） */
  'scripts/make-ab-handover.js',        // A/B 交接材料包：只作文件名进取证清单
  'scripts/make-final-closure-bundle.js',// 收口材料包：只作文件名进取证清单
  'scripts/make-g4r1-handover.js',      // G4R1 交接单：只作文件名进 SHA 清单
  'scripts/offline-f2-dupuser-test.js',  // 重复 user 输入回归：只作文件名进「不许改」清单
  'scripts/offline-f2-p3-matrix-test.js',// P3 矩阵：真调 forScenario('offline') 核五段在位 + VERSION 溯源
  'scripts/offline-f2-sendbody-test.js'];// 出站 body 验收：只作文件名进 §9 静态断言清单

function scriptRefs() {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var refs = [];
  var re = /<script\s+src="([^"]+)"/g, m;
  while ((m = re.exec(html))) refs.push(m[1]);
  return refs;
}

t('index.html 已引用 behavior-text.js（脚本列表已变）', function () {
  assert(scriptRefs().indexOf('behavior-text.js') >= 0, '脚本列表里没有 behavior-text.js');
});

t('引用位置早于 prompt-engine.js（唯一消费者的定义处）', function () {
  var refs = scriptRefs();
  var a = refs.indexOf('behavior-text.js');
  var b = refs.indexOf('prompt-engine.js');
  assert(a >= 0 && b >= 0, '两个文件都要在脚本列表里');
  assert(a < b, 'behavior-text.js 排在 prompt-engine.js 之后（索引 ' + a + ' vs ' + b + '）');
});

t('引用位置早于启动点火所在的脚本（page-chat-settings.js）', function () {
  var refs = scriptRefs();
  var a = refs.indexOf('behavior-text.js');
  var b = refs.indexOf('page-chat-settings.js');
  assert(a >= 0 && b >= 0, '两个文件都要在脚本列表里');
  assert(a < b, 'behavior-text.js 排在点火脚本之后（索引 ' + a + ' vs ' + b + '）');
});

t('连 index.html 在内，全仓只有白名单文件提到本模块', function () {
  var offenders = [];
  CODE_FILES.forEach(function (rel) {
    if (BT_ALLOWED.indexOf(rel) >= 0) return;
    if (hitsIn(rel).length) offenders.push(rel);
  });
  eq(offenders, [], '白名单外被引用的文件：');
});

t('生产装配点只有 prompt-engine.js（其余运行时代码 0 命中）', function () {
  var offenders = [];
  CODE_FILES.forEach(function (rel) {
    if (/^scripts\//.test(rel) || rel === 'behavior-text.js' || rel === 'index.html') return;
    if (hitsIn(rel).length) offenders.push(rel);
  });
  eq(offenders, ['prompt-engine.js'], '引用本模块的运行时代码：');
});

t('其他四个场景的装配入口不许引用本模块（本批只迁私聊线上）', function () {
  ['page-proactive.js', 'page-group-ai.js', 'page-group-offline.js',
    'page-chat.js', 'page-offline.js'].forEach(function (rel) {
    var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert(src.indexOf('behaviorText') < 0, rel + ' 引用了 behaviorText');
    assert(src.indexOf('behavior-text') < 0, rel + ' 引用了 behavior-text');
  });
});

t('sw.js 未引用本模块（它只跳 CACHE 版本号）', function () {
  eq(hitsIn('sw.js'), [], 'sw.js：');
  var sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  var m = /var CACHE = 'sleepy-v(\d+)'/.exec(sw);
  assert(m && Number(m[1]) >= 152, 'CACHE 版本没跳到位：' + (m && m[0]));
});

/* ============================================================
   12. 既有命令安全性（补充说明）
   ============================================================ */

head('既有命令安全性（补充）');

t('check.js / smoke.js 不会发起真实网络请求', function () {
  ['scripts/check.js', 'scripts/smoke.js'].forEach(function (rel) {
    var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert(src.indexOf("require('http") < 0 && src.indexOf('require("http') < 0, rel + ' 引入了 http');
    assert(src.indexOf("require('https") < 0 && src.indexOf('require("https') < 0, rel + ' 引入了 https');
    /* fetch( 只允许出现在「否定断言」的正则字面量里：/fetch\(/ 或 /fetch\(|…/ */
    var real = (src.match(/(?<!\/)fetch\(/g) || []).length;
    var inRegex = (src.match(/\/[^\n]*fetch\\\([^\n]*\//g) || []).length;
    assert(real <= inRegex, rel + ' 里 fetch( 真实调用 ' + real + ' 处、正则里 ' + inRegex + ' 处');
  });
});

t('smoke.js 不给沙箱注入 fetch（只临时换成假 fetch 再还原）', function () {
  var src = fs.readFileSync(path.join(ROOT, 'scripts/smoke.js'), 'utf8');
  assert(/const realFetch = win\.fetch;/.test(src), '找不到「先存后换」的写法');
  assert(/finally \{ win\.fetch = realFetch; \}/.test(src), '假 fetch 没有在 finally 里还原');
  assert(src.indexOf('ctx.fetch') < 0 && src.indexOf('globalThis.fetch') < 0,
    'smoke 把真实 fetch 注进了沙箱');
});

/* ============================================================
   13. 虚构模块的加载期副作用（负向）
   ------------------------------------------------------------
   A0 的隔离桩有两条防线（见第 0 节）：
     ① 裸全局缺失 → 引用即 ReferenceError
     ② window.* 访问器陷阱 → 一碰就抛错并记账
   这一节不测本模块（那是第 1–12 节的事），而是拿五个**虚构模块**去撞这两条
   防线，证明它们真的拦得住 —— 且拦下时的失败是「预期的禁止访问」，
   不是语法错误、也不是别的无关错误。

   ★ 五个模块都只是字符串常量；它们引用的标识要么在沙箱里不存在、
     要么命中访问器陷阱 —— 物理上碰不到任何真实 DOM / 存储 / 网络 / 定时器。
   ★ 另有两个对照组（纯计算 / 真语法错），用来证明「拦住了」这个结论不是
     因为沙箱「什么都炸」、也不是因为断言分不清语法错。

   ⚠️ 判定错误类型一律按 `e.name`，**不能用 `instanceof`**：沙箱里抛出的
     ReferenceError / SyntaxError 来自**另一个 vm 上下文**的构造器，
     与宿主进程的 ReferenceError / SyntaxError 不是同一个函数 ——
     `e instanceof ReferenceError` 会莫名变 false（这个坑本轮踩到了）。
     唯一例外是 `new vm.Script(...)`：它在宿主侧构造，抛的才是宿主错误。
   ============================================================ */

head('虚构模块的加载期副作用（负向）');

/* 五个虚构副作用模块：四个撞「裸全局缺失」，一个撞「window 访问器陷阱」 */
var SIDE_EFFECT_MODULES = [
  { name: 'DOM：document.createElement',
    src: 'document.createElement("div");', kind: 'absent', token: 'document' },
  { name: '存储：localStorage.setItem',
    src: 'localStorage.setItem("fixture-key", "fixture-value");', kind: 'absent', token: 'localStorage' },
  { name: '网络：fetch',
    src: 'fetch("http://127.0.0.1:9/never-sent");', kind: 'absent', token: 'fetch' },
  { name: '定时与后台：setTimeout',
    src: 'setTimeout(function () { return 1; }, 0);', kind: 'absent', token: 'setTimeout' },
  { name: 'window 访问器：window.indexedDB',
    src: 'window.indexedDB.open("fixture-db");', kind: 'trap', token: 'indexedDB' }
];

/* 每个虚构模块都在**自己的新沙箱**里加载（§二「独立沙箱」） */
function loadFictional(src) {
  var s = makeSandbox();
  var ctx = vm.createContext(s.sandbox);
  var threw = null;
  try { vm.runInContext(src, ctx, { filename: 'fictional-side-effect.js' }); }
  catch (e) { threw = e; }
  return { sandbox: s.sandbox, log: s.log, threw: threw };
}

t('五个虚构模块都是合法 JS（失败不能靠语法错蒙过去）', function () {
  SIDE_EFFECT_MODULES.forEach(function (m) {
    var syntax = null;
    try { new vm.Script(m.src, { filename: 'fictional-side-effect.js' }); }
    catch (e) { syntax = e; }
    assert(!syntax || syntax.name !== 'SyntaxError',
      m.name + ' 连语法都不合法：' + (syntax && syntax.message));
  });
  eq(SIDE_EFFECT_MODULES.length, 5, '模块数：');
});

t('裸全局缺失：四个模块当场 ReferenceError（不是语法错、不是别的错）', function () {
  SIDE_EFFECT_MODULES.filter(function (m) { return m.kind === 'absent'; })
    .forEach(function (m) {
      var r = loadFictional(m.src);
      assert(r.threw, m.name + ' 竟然加载成功了（防线没拦住）');
      assert(r.threw.name !== 'SyntaxError',
        m.name + ' 报的却是语法错：' + r.threw.message);
      assert(r.threw.name === 'ReferenceError',
        m.name + ' 报的不是 ReferenceError：' + (r.threw && r.threw.name));
      assert(/is not defined/.test(r.threw.message),
        m.name + ' 的报错措辞不是「未定义」：' + r.threw.message);
      assert(r.threw.message.indexOf(m.token) >= 0,
        m.name + ' 的报错里没提到 ' + m.token + '：' + r.threw.message);
    });
  eq(SIDE_EFFECT_MODULES.filter(function (m) { return m.kind === 'absent'; }).length, 4, '缺失类模块数：');
});

t('裸全局缺失这一路：不产生任何陷阱日志（没被走到就不该有记录）', function () {
  SIDE_EFFECT_MODULES.filter(function (m) { return m.kind === 'absent'; })
    .forEach(function (m) {
      var r = loadFictional(m.src);
      eq(r.log, [], m.name + ' 的触碰记录：');
    });
});

t('window 访问器拦截：报「禁止访问」并记账（与「缺失」用不同断言）', function () {
  var m = SIDE_EFFECT_MODULES.filter(function (x) { return x.kind === 'trap'; })[0];
  var r = loadFictional(m.src);
  assert(r.threw, m.name + ' 竟然加载成功了');
  assert(r.threw.name !== 'SyntaxError', m.name + ' 报的却是语法错：' + r.threw.message);
  assert(r.threw.name !== 'ReferenceError',
    m.name + ' 报成了 ReferenceError（那是「缺失」那一路的断言，不该混）');
  assert(/禁止访问/.test(r.threw.message), m.name + ' 报的不是陷阱措辞：' + r.threw.message);
  assert(r.threw.message.indexOf('window.' + m.token) >= 0,
    m.name + ' 的报错里没点名 window.' + m.token + '：' + r.threw.message);
  eq(r.log, ['window.' + m.token], m.name + ' 的触碰记录：');
});

t('陷阱同时管读与写，且账本逐次累积（不是只拦第一次）', function () {
  var r1 = loadFictional('window.fetch;');
  assert(r1.threw && /禁止访问/.test(r1.threw.message), '读 window.fetch 没被拦');
  eq(r1.log, ['window.fetch']);
  var r2 = loadFictional('window.localStorage = 1;');
  assert(r2.threw && /禁止写入/.test(r2.threw.message), '写 window.localStorage 没被拦');
  eq(r2.log, ['window.localStorage']);
  var r3 = loadFictional('window.indexedDB; window.caches; window.WebSocket;');
  assert(r3.threw, '连续访问没被拦');
  eq(r3.log, ['window.indexedDB'], '第一次访问就该中断，账本不该有后续项：');
});

t('对照组 A：同款沙箱里纯计算模块能正常加载（不是「什么都被拦」）', function () {
  var r = loadFictional('var n = 0; for (var i = 1; i <= 9; i++) { n += i; } window.__fixtureSum = n;');
  assert(!r.threw, '纯计算模块竟然也失败：' + (r.threw && r.threw.message));
  eq(r.log, [], '纯计算模块的触碰记录：');
  eq(r.sandbox.window.__fixtureSum, 45);
});

t('对照组 B：真语法错报 SyntaxError（说明上面「不是语法错」那条有牙）', function () {
  var r = loadFictional('var = ;');
  assert(r.threw, '坏语法竟然没抛错');
  assert(r.threw.name === 'SyntaxError', '坏语法报的不是 SyntaxError：' + (r.threw && r.threw.name));
});

t('五个模块引用的标识全部落在黑名单内（没有别的意外依赖）', function () {
  SIDE_EFFECT_MODULES.forEach(function (m) {
    assert(ABSENT_GLOBALS.indexOf(m.token) >= 0,
      m.token + ' 不在沙箱黑名单 ABSENT_GLOBALS 里（夹具假设失效）');
  });
  /* 模块源码里除 window 之外，不得引用任何宿主对象 */
  var HOST_NAMES = ['globalThis', 'self', 'top', 'parent', 'process', 'require',
    'module', 'exports', 'Buffer', 'global'];
  SIDE_EFFECT_MODULES.forEach(function (m) {
    HOST_NAMES.forEach(function (h) {
      assert(m.src.indexOf(h) < 0, m.name + ' 的源码里出现了宿主标识 ' + h);
    });
  });
});

t('加载这些模块不会在沙箱上新增任何全局', function () {
  SIDE_EFFECT_MODULES.forEach(function (m) {
    var r = loadFictional(m.src);
    eq(Object.keys(r.sandbox), ['window'], m.name + ' 加载后沙箱全局：');
  });
});

t('测试进程本身没有 DOM / 存储 / window（想碰真实资源也碰不到）', function () {
  /* 用 globalThis[n] 而不是 eval(n)：eval 一个不存在的裸标识会直接抛
     ReferenceError，把「检查」变成「自己踩雷」。
     navigator 不在此列 —— Node 21+ 自带一个只读的 navigator（只有 userAgent
     之类），它既不是 DOM 也不给沙箱用（沙箱里 navigator 由第 1 节的
     ABSENT_GLOBALS 断言为不存在，这里不重复背那个结论）。 */
  ['document', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'window']
    .forEach(function (n) {
      assert(typeof globalThis[n] === 'undefined', '测试进程里竟然有 ' + n);
    });
  /* 宿主确实有 fetch（Node 18+），所以「不发网络」不能靠「宿主没有 fetch」
     来证明 —— 靠的是沙箱里没有 fetch（第 1 节）+ 本节四个 ReferenceError。 */
  eq(typeof globalThis.fetch, 'function');
});

/* ============================================================
   汇总
   ============================================================ */

head('证据摘要');
process.stdout.write('  VERSION  ' + BT.VERSION + '\n');
process.stdout.write('  场景     模块顺序\n');
SCENES.forEach(function (scene) {
  process.stdout.write('  ' + (scene + '          ').slice(0, 14) + BT.planOf(scene).join(' + ') + '\n');
});
process.stdout.write('\n  模块  段  字符   字节   sha256(前 16)\n');
MODULE_IDS.forEach(function (id) {
  var text = BT.module(id);
  process.stdout.write('  ' + (id + '    ').slice(0, 5) +
    (text.split('\n').length + '    ').slice(0, 3) +
    (text.length + '     ').slice(0, 6) +
    (Buffer.byteLength(text, 'utf8') + '     ').slice(0, 7) +
    sha256(text).slice(0, 16) + '\n');
});
var total = MODULE_IDS.reduce(function (n, id) { return n + Buffer.byteLength(BT.module(id), 'utf8'); }, 0);
process.stdout.write('  正文合计 ' + total + ' 字节（10 个模块）\n');

process.stdout.write('\n小手机 · 行为文本模块隔离测试\n');
process.stdout.write('\n');
if (fail) {
  process.stdout.write('  ' + fail + ' 项未通过：\n');
  problems.forEach(function (p) { process.stdout.write('    - ' + p + '\n'); });
  process.stdout.write('\n');
  process.exit(1);
}
process.stdout.write('  ' + pass + ' 项通过' + (skipped ? '，' + skipped + ' 项跳过（冻结包不在本机）' : '') + '\n');
process.stdout.write('  生产接入：已接入 index.html；唯一装配点是 prompt-engine.js 的 assembleOnline（私聊线上）\n');
process.stdout.write('  未接入：线下 / 主动消息 / 群线上 / 群线下（本批范围外）\n\n');
process.exit(0);
