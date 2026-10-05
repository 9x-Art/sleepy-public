#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-fixture-trace-test.js
   —— 夹具现场值持久化的**逐字段验证**（零模型请求）

   ★ 目的：验「夹具预期的现场值，真的进了 assembleOffline 的请求体 messages」。
     这条链是：`FIXTURE.scene → SETUP → offlineStore → assembleOffline → 请求体`。

   ---- 2026-10-05 重写时修掉的四个自身缺陷（用户点名）----
     ① **先设夹具再跑 SETUP**。上一版先跑 SETUP、后设 `__FIXTURE__`，
        再跑第二遍 —— 两条链并存，第一条链是在 `__FIXTURE__` 为 undefined
        时跑的。现在：**一条主链**，顺序固定，夹具先就位。
     ② **不清空加载失败记录**。上一版 `h2.failed.length = 0`
        把加载失败抹掉了 —— 那是「生产脚本没加载成功」的唯一证据。
        沙箱有失败就该**报出来**，不能清零假装没事。
     ③ **导航做精准替身，不笼统吞异常**。上一版 `try { SETUP } catch {}`
        把 SETUP 的所有异常都吞掉，只在注释里解释「与本测试无关」。
        现在：只对 `nav.open` 打**精准替身**（记录调用），
        SETUP 本身**不设 try/catch** —— 它抛错就是测试失败。
     ④ **运行时 spy 统计保存接口调用**。上一版只比对「值对不对」，
        说不清「到底走的哪条路写进去的」。现在在 `offlineStore` 出口
        装 spy，统计 `createSession` / `updateEnv` / `appendMessage` 的真实调用次数。

   ---- 保留的负向对照 ----
     「直接改 findSession 返回的副本不会保存」——
     这是**根因证据**，不能因为修好了就删掉。
     它证明生产的深拷贝契约是设计如此，要改的是调用方。

   ---- 硬边界 ----
     · 零**模型**请求：不启动浏览器、不调模型、不发任何 API 请求。
     ⚠️ **不再自称「零网络」**：调试期间曾对 example.com 做过一次
        **非模型的公网请求尝试**（详见 §2.6 顶部登记）。本轮起全部探针
        只打本地替身，不会触达公网 —— 但历史那一次确实发生过。
     · **不改生产代码**：本测试只读生产、只跑验收脚本的 SETUP。
     · 最后一环「请求体」用**生产 bodyFor 同构**取，
       并显式标注它**不是** init.body（真实那份要等 fetch 旁路）。
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var H = require('./harness.js');
var ACC = require('./offline-f2-effect-acceptance.js');
var CAP = require('./lib/f2-body-capture.js');
var ROOT = H.ROOT;

var pass = 0, fail = 0, problems = [];
function head(t) { process.stdout.write('\n' + t + '\n'); }
function ok(m) { pass++; process.stdout.write('  \u2713 ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  \u2717 ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + '期望 ' + y + '，实得 ' + x);
}
function t(name, fn) {
  try { fn(); ok(name); }
  catch (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); }
}

var FIELDS = ['location', 'timeOfDay', 'weather', 'clockTime'];
var FIX = ACC.FIXTURE.scene;
/* ⚠️ preActions 在 FIXTURE 顶层，**不在** FIXTURE.scene 里。
   上一版误用 PRE → undefined.join 抛错。 */
var PRE = ACC.FIXTURE.preActions;
var WANT = { sceneName: FIX.sceneName };
FIELDS.forEach(function (f) { WANT[f] = FIX[f]; });

/* ============================================================
   §1 沙箱引导：**一条主链**，顺序固定
   ============================================================ */
head('§1 沙箱引导（夹具先就位，SETUP 后跑）');

/* 岛 + 凭据占位。⚠️ 凭据全是 stub 值，且**不传进 knownSecrets**
   （夹具链路里没有凭据混进 messages 的风险；要验脱敏在 sendbody 测试里做）。 */
function bootSandbox(label) {
  var h = H.boot(label);
  /* ★ 不清 failed —— 加载失败必须暴露（缺陷②的修复点） */
  var sb = h.S.core.createSandbox('archipelago', '追踪夹具岛');
  h.S.core.setActiveSandbox(sb.id);
  h.win.__API_BASE = 'stub://trace';
  h.win.__API_KEY = 'stub-trace-key-not-real';
  h.win.__API_MODEL = 'stub-model';
  h.win.__APPROVED = { temperature: 0.85, maxTokens: 8192,
    contextMessages: 40, stream: false, timeoutSec: 120 };

  /* ---- ④ 运行时 spy：统计保存接口的真实调用次数 ----
     装在 offlineStore 的出口上，**只计数、透传原返回值**，
     不改任何行为（改了就不是「统计真实调用」了）。 */
  var spy = { createSession: 0, updateEnv: 0, appendMessage: 0, navOpen: [], calls: [] };
  var OS = h.S.offlineStore;
  ['createSession', 'updateEnv', 'appendMessage'].forEach(function (fn) {
    var orig = OS[fn];
    assert(typeof orig === 'function', 'offlineStore.' + fn + ' 应是函数');
    OS[fn] = function () {
      spy[fn]++;
      spy.calls.push({ 接口: fn, 参数: H.deepClone(Array.prototype.slice.call(arguments)) });
      return orig.apply(this, arguments);
    };
  });
  h.spy = spy;
  return h;
}

var h = bootSandbox('f2-trace-main');
var S = h.S;

t('生产脚本加载零失败（不清空记录，直接断言）', function () {
  eq(h.failed, [], '加载失败清单');
  assert(S.offlineStore && S.promptEngine, 'offlineStore / promptEngine 应可用');
});

/* ---- ③ 精准导航替身：只替换 nav.open，其他一律不动 ----
   为什么这不是「笼统吞异常」：
     · 它**只**代理 nav.open 一个方法，其余 nav 行为原样；
     · 它**记录**每次调用（页码 + 参数），可被断言；
     · SETUP 本体不包 try/catch —— 它抛错会直接让本测试红。 */
var NAV = h.S.nav;
var navOrig = NAV.open;
var navCalls = [];
NAV.open = function (page, arg) {
  navCalls.push({ page: page, arg: H.deepClone(arg === undefined ? null : arg) });
  /* 精准：只对 offline-scene 返回一个「已打开」的假结果；
     其它页码**透传给真实实现**，行为不被改变。 */
  if (page === 'offline-scene') {
    return { __stub: 'offline-scene', id: arg && arg.id };
  }
  return navOrig.apply(this, arguments);
};

/* ★ 夹具**先**就位，再跑 SETUP（缺陷①的修复点） */
h.ctx.__FIXTURE__ = ACC.FIXTURE;

var setupReturned = null;
/* ★ SETUP 不包 try/catch（缺陷③的修复点）：它抛错就是测试红。 */
vm.runInContext('(' + ACC.SETUP_SRC + ')({f: __FIXTURE__})',
  h.ctx, { filename: 'acceptance-SETUP' });
setupReturned = h.ctx.window.__setupResult || null;

t('SETUP 成功执行（未抛错）且拿到 sid', function () {
  assert(h.win.__sid, 'SETUP 未设置 window.__sid');
});
t('导航替身被调用且页码正确', function () {
  eq(navCalls.map(function (c) { return c.page; }), ['offline-scene'], 'nav.open 页码序列');
  eq(navCalls[0].arg, { id: h.win.__sid }, 'nav.open 收到的参数');
});

/* ============================================================
   §2 修复后的逐步核对：存储回读 → findSession 回读 → 场景段
   ============================================================ */
head('§2 修复后：逐字段三步核对');

/* ① 存档直读（绕过 findSession，证明「写没写进 store」） */
function readRaw(sid) {
  var list = S.store.get('offlineSessions') || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === sid) {
      return { sceneName: list[i].sceneName, env: {
        location: list[i].env && list[i].env.location,
        timeOfDay: list[i].env && list[i].env.timeOfDay,
        weather: list[i].env && list[i].env.weather,
        clockTime: list[i].env && list[i].env.clockTime } };
    }
  }
  return null;
}
/* ② findSession 回读（走生产的深拷贝路径） */
function readViaFind(sid) { return readShape(S.offlineStore.findSession(sid)); }
function readShape(s) {
  if (!s) return null;
  return { sceneName: s.sceneName, env: {
    location: s.env && s.env.location, timeOfDay: s.env && s.env.timeOfDay,
    weather: s.env && s.env.weather, clockTime: s.env && s.env.clockTime } };
}
function envOf(v, f) { return v && v.env ? v.env[f] : undefined; }

var SID = h.win.__sid;
var vRaw = readRaw(SID);
var vFind = readViaFind(SID);

head('§2.1 ① 存档直读（store.get("offlineSessions")）');
t('① 五个字段全部等于夹具预期', function () {
  eq(vRaw, { sceneName: WANT.sceneName, env: {
    location: WANT.location, timeOfDay: WANT.timeOfDay,
    weather: WANT.weather, clockTime: WANT.clockTime } }, '存档直读');
});
head('§2.2 ② offlineStore.findSession 回读（生产深拷贝路径）');
t('② 五个字段全部等于夹具预期', function () {
  eq(vFind, vRaw, 'findSession 回读应与存档直读一致');
});
head('§2.3 ③ 运行时 spy：保存接口确实被调用');
t('③ createSession 被调用 1 次（场景名与 env 走正式创建参数）', function () {
  eq(h.spy.createSession, 1, 'createSession 调用次数');
  var args = h.spy.calls.filter(function (c) { return c.接口 === 'createSession'; })[0];
  assert(args, '找不到 createSession 的调用记录');
  var form = args.参数[1];
  eq(form.sceneName, WANT.sceneName, 'createSession form.sceneName');
  eq(form.location, WANT.location, 'createSession form.location');
  eq(form.timeOfDay, WANT.timeOfDay, 'createSession form.timeOfDay');
  eq(form.weather, WANT.weather, 'createSession form.weather');
  eq(form.clockTime, WANT.clockTime, 'createSession form.clockTime');
});
t('③ updateEnv 被调用 1 次且只带 env 四字段（已验证的保存入口）', function () {
  eq(h.spy.updateEnv, 1, 'updateEnv 调用次数');
  var args = h.spy.calls.filter(function (c) { return c.接口 === 'updateEnv'; })[0];
  eq(args.参数[1], { location: WANT.location, timeOfDay: WANT.timeOfDay,
    weather: WANT.weather, clockTime: WANT.clockTime }, 'updateEnv 的 patch');
  /* ⚠️ updateEnv **静默忽略** sceneName（实测：不报错、不生效）。
     所以场景名绝不能靠它 —— 断言它没被指望。 */
  assert(args.参数[1].sceneName === undefined,
    'updateEnv 的 patch 不应含 sceneName（它会被静默忽略）');
});
/* ⚠️ 调用次数只是**辅助**检查 —— 上一版只有这一条：
     「appendMessage 被调用 9 次」。它抓不住「顺序错了 / role 错了 /
     内容错了」，只抓「条数不对」。
   ★ 用户 2026-10-05 要求：调用次数四次**只作辅助**，
     **不能替代内容断言**。所以下面以逐项内容断言为主。 */
t('★ 前置消息恰为 6 条，且逐项 role/正文/顺序全部正确（内容断言）', function () {
  var msgs = S.offlineStore.findSession(SID).messages;
  /* 2026-10-05 裁决：preActions 保留逐条 3 条、删除拼接版，不保留两份 */
  var expect = [
    { role: 'user', text: '（我推开阁楼的门，上来了。)' },
    { role: 'scene', text: PRE[0] },
    { role: 'scene', text: PRE[1] },
    { role: 'scene', text: PRE[2] },
    { role: 'scene', text: '（老板娘在楼下，没有上来。）' },
    { role: 'user', text: '（我坐下了，湿外套搭在椅背上。）' }
  ];
  eq(msgs.length, expect.length, '★ 落库消息条数（user 2 + 逐条 3 + 现场 1）');
  expect.forEach(function (want, i) {
    var got = msgs[i];
    assert(got, '第 ' + (i + 1) + ' 条缺失');
    eq(got.role, want.role, '第 ' + (i + 1) + ' 条 role');
    var body = (got.paras || []).map(function (p) {
      return p.type === 'dialogue' ? '「' + p.text + '」' : p.text;
    }).join('\n');
    if (body === '' && got.text) body = got.text;
    eq(body, want.text, '第 ' + (i + 1) + ' 条正文');
  });
});
t('★ preActions 只保存逐条各一次（拼接版不再进历史）', function () {
  var msgs = S.offlineStore.findSession(SID).messages;
  var joined = PRE.join(' ');
  var joinedCount = 0, perItemCount = 0;
  msgs.forEach(function (m) {
    var b = (m.paras || []).map(function (p) { return p.text; }).join('\n');
    if (b === '' && m.text) b = m.text;
    if (b === joined) joinedCount++;
    PRE.forEach(function (pa) { if (b === pa) perItemCount++; });
  });
  eq(joinedCount, 0, '★ 拼接版应为 0 条（2026-10-05 裁决删除）');
  eq(perItemCount, 3, '★ 逐条版应恰好 3 条（每条各 1 次）');
});
t('★ 整段会话里没有任何逐字重复的消息', function () {
  var msgs = S.offlineStore.findSession(SID).messages;
  var seen = {}, dup = [];
  msgs.forEach(function (m, i) {
    var b = (m.paras || []).map(function (p) { return p.text; }).join('\n');
    if (b === '' && m.text) b = m.text;
    if (seen[b] !== undefined) dup.push({ 重复于: [seen[b] + 1, i + 1], 正文: b.slice(0, 30) });
    seen[b] = i;
  });
  eq(dup, [], '重复消息');
});
t('③ appendMessage 被调用 6 次（user 2 + 逐条 3 + 现场 1；辅助检查，不替代内容断言）', function () {
  eq(h.spy.appendMessage, 6, 'appendMessage 调用次数');
});
t('★ 负向对照：SETUP 里不再有对孤儿副本的直接赋值', function () {
  /*⚠️⚠️ 判据必须**先剥注释**再扫。
     第一次写这条断言时直接扫原文 → 命中了 SETUP 里那段
     「旧写法（静默失效）：var s2 = findSession(s.id); s2.sceneName = …」
     的**说明注释** —— 报了个「SETUP 仍有孤儿赋值」的假红。
     这正是长期约定里「静态护栏扫源码没剥注释 → 把注释里的旧写法判成违规」
     那一条；**自己写护栏时踩了同一条**。
     → 剥掉 // 与 /* *／ 注释、以及字符串字面量后再判。 */
  var code = stripCommentsAndStrings(ACC.SETUP_SRC);
  assert(!/s2\.sceneName\s*=/.test(code),
    'SETUP 仍存在 s2.sceneName = … 的孤儿赋值（已剥注释）');
  assert(!/s2\.env\s*=/.test(code),
    'SETUP 仍存在 s2.env = … 的孤儿赋值（已剥注释）');
  /* 也不能只是把孤儿变量换了个名字 —— 找「findSession 之后直接赋值」的形状。
     自检块里也有 findSession，所以只取**自检之前**的那段。 */
  var fi = code.indexOf('findSession');
  assert(fi >= 0, 'SETUP 应有自检用的 findSession');
  var around = code.slice(Math.max(0, fi - 200), fi);
  assert(!/\b\w+\s*=\s*f\.scene\./.test(around),
    'findSession 之前仍有对 f.scene.* 的直接赋值（已剥注释）');
});

/* 剥掉注释与字符串字面量 —— 让静态判据只看**真正会执行的代码**。
   ⚠️ 这是手写简化版：处理 //、块注释、'...'、"..."、`...`。
      够用于本文件的判据；不追求完整 JS 词法。 */
function stripCommentsAndStrings(src) {
  var s = String(src), out = '', i = 0, n = s.length;
  while (i < n) {
    var c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      var q = c; i++;
      while (i < n && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

head('§2.4 ④ assembleOffline 的【当前场景】段 + 请求体 messages');
/* 装配（零模型请求） */
var built = S.promptEngine.assembleOffline({
  charId: (S.offlineStore.findSession(SID) || {}).charId,
  userId: (S.offlineStore.findSession(SID) || {}).userId,
  session: S.offlineStore.findSession(SID), userInput: '（追踪探查）'
});
var parts = (built && built.messages ? built.messages : [])
  .filter(function (m) { return m && m.role === 'system'; })
  .map(function (m) { return String(m.content || ''); });
var sceneSeg = null;
parts.forEach(function (p) { if (p.indexOf('【当前场景】') >= 0) sceneSeg = p; });

t('④ 装配产物里确有【当前场景】段（否则本节结论作废）', function () {
  assert(sceneSeg, '装配产物里没有【当前场景】段');
  assert(parts.length > 0, 'system 段数为 0');
});
t('④ 场景段里的场景名 = 夹具预期', function () {
  var m = sceneSeg.match(/「([^」]*)」/);
  assert(m, '场景段里没有场景名');
  eq(m[1], WANT.sceneName, '场景段里的场景名');
});
var SEG_LABEL = { timeOfDay: '时段', weather: '天气', location: '地点', clockTime: '时刻' };
t('④ 场景段里四个现场值全部 = 夹具预期', function () {
  FIELDS.forEach(function (f) {
    var m = sceneSeg.match(new RegExp(SEG_LABEL[f] + '\\s*([^·\\n]+)'));
    assert(m, '场景段里没有「' + SEG_LABEL[f] + '」');
    eq(m[1].trim(), WANT[f], '场景段里的' + f);
  });
});

/* ---- 请求体 messages（生产 bodyFor 同构 + 旁路采集）---- */
var bodyStr = JSON.stringify({
  model: 'stub-model', messages: built.messages,
  stream: false, max_tokens: 8192, temperature: 0.85
});
var cap = CAP.captureRequestBody('https://stub/v1/chat/completions', { body: bodyStr });

t('★ 请求体 messages 里【当前场景】段带着全部五个现场值', function () {
  var all = cap.messages.map(function (m) { return String(m.content); }).join('\n');
  assert(all.indexOf('【当前场景】') >= 0, '请求体里应有【当前场景】段');
  assert(all.indexOf(WANT.sceneName) >= 0, '请求体里应有场景名 ' + WANT.sceneName);
  FIELDS.forEach(function (f) {
    assert(all.indexOf(WANT[f]) >= 0,
      '请求体里应有 ' + f + ' = ' + WANT[f]);
  });
});
t('★ 请求体里**不含** createSession 的默认值（证明没被覆盖）', function () {
  var DEF = defaultsFromSource();
  var all = cap.messages.map(function (m) { return String(m.content); }).join('\n');
  var seg = null;
  cap.messages.forEach(function (m) {
    var c = String(m.content);
    if (c.indexOf('【当前场景】') >= 0) seg = c;
  });
  assert(seg, '找不到场景段');
  assert(seg.indexOf('「' + DEF.sceneName + '」') < 0,
    '场景名仍是默认值 ' + DEF.sceneName);
  ['timeOfDay', 'weather', 'location', 'clockTime'].forEach(function (f) {
    var m = seg.match(new RegExp(SEG_LABEL[f] + '\\s*([^·\\n]+)'));
    assert(m && m[1].trim() !== DEF[f],
      f + ' 仍是默认值 ' + DEF[f]);
  });
  void all;
});
t('请求体采集无错误（bodyCaptureError 应为 null）', function () {
eq(cap.bodyCaptureError, null, 'bodyCaptureError');
assert(cap.messages.length === built.messages.length, 'messages 条数应与装配一致');
});

/* ============================================================
   §2.5 沿**生产链**再走一遍：装配 → requestOnce → 假 fetch
   ------------------------------------------------------------
     §2.4 是「装配产物 → 本地旁路采集」，走的是 bodyFor 同构口径。
     这里补一条**真正走生产序列化链**的：调 `Sleepy.api.requestOnce`，
     只换底层 fetch，验证落到**假 fetch 实际收到的 body** 里：
       · 历史没有新增重复（这是本轮修复的重点）
       · 五个现场字段仍然正确（不能因为删了 5 条写入而丢）
   ============================================================ */
head('§2.5 沿生产链（requestOnce → 假 fetch）复核');

var pending = [];
function ta(name, fn) {
  pending.push(Promise.resolve().then(fn).then(function () { ok(name); },
    function (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); }));
}
/* ---------- 串行版：给「会改全局状态」的用例用 ----------
   ⚠️⚠️ 这条是被 §2.6 的红项逼出来的：
     `ta()` 把所有用例**并发**跑（各自 .then(fn) 一次性排上），
     而 §2.6 每个用例都在改**同一份全局网络入口**（http/https/net）。
     ⇒ 一个用例的 `restore()` 会把另一个用例窗口里的阻断**提前解除**，
       断言互相污染 —— 表现是「明明 restore 了却判红」这种看似自相矛盾的红。
     ⚠️ 这类「共享全局 + 各自 cleanup」的测试**必须串行**，
       否则失败原因看着像被测代码坏了，其实是测试之间打架。 */
var serialChain = Promise.resolve();
function tas(name, fn) {
  serialChain = serialChain.then(function () {
    return Promise.resolve().then(fn).then(function () { ok(name); },
      function (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); });
  });
  pending.push(serialChain);
}
function blockOtherNetwork() {
  var net = require('net'), http = require('http'), https = require('https');
  var saved = [];
  function trip(name) {
    return function () { throw new Error('网络已被测试阻断：' + name); };
  }
  [['http', http, ['request', 'get']], ['https', https, ['request', 'get']],
    ['net', net, ['connect', 'createConnection']]].forEach(function (grp) {
    grp[2].forEach(function (m) {
      if (typeof grp[1][m] === 'function') {
        saved.push([grp[1], m, grp[1][m]]);
        grp[1][m] = trip(grp[0] + '.' + m);
      }
    });
  });
  return function restore() {
    saved.forEach(function (x) { x[0][x[1]] = x[2]; });
  };
}
/* ⚠️⚠️ 生命周期修复（2026-10-05 · A）
   原来这里是 `function () { var restore=…; try { … return promise.then(…); } finally { restore(); } }`
   —— **回调不是 async**。`finally` 在 try 块**同步返回那一刻**就执行，
   而真正的断言写在 `.then()` 里，也就是**在 restore 之后**才跑。
   ⇒ 断网保护在「处理中」是**失效**的：断言期间网络已放开。
   → 改成 `async` 回调 + try 内 `await` 完整 requestOnce 与全部断言，
     `finally` 才会等到「处理完」才 restore。 */
tas('生产 requestOnce 落到的 body：四个现场锚点齐全、历史无重复', async function () {
  var restore = blockOtherNetwork();
  try {
    /* 全新沙箱，走完整夹具 → SETUP → 装配 → requestOnce */
    var h2 = H.boot('trace-prod-chain');
    assert(h2.failed.length === 0, '生产脚本加载失败');
    var S2 = h2.S;
    var sb2 = S2.core.createSandbox('archipelago', '追踪生产链岛');
    S2.core.setActiveSandbox(sb2.id);
    h2.win.__API_BASE = 'stub://trace/v1';
    h2.win.__API_KEY = 'stub-trace-key-not-real';
    h2.win.__API_MODEL = 'stub-model';
    h2.win.__APPROVED = { temperature: 0.85, maxTokens: 8192,
      contextMessages: 40, stream: false, timeoutSec: 120 };
    h2.ctx.__FIXTURE__ = ACC.FIXTURE;
    var navO = S2.nav.open;
    S2.nav.open = function (p, a) {
      if (p === 'offline-scene') return { __stub: 1 };
      return navO.apply(this, arguments);
    };
    vm.runInContext('(' + ACC.SETUP_SRC + ')({f: __FIXTURE__})', h2.ctx,
      { filename: 'SETUP' });
    var sid2 = h2.win.__sid;
    assert(sid2, 'SETUP 应产出 sid');

    var sess = S2.offlineStore.findSession(sid2);
    var built2 = S2.promptEngine.assembleOffline({
      charId: sess.charId, userId: sess.userId, session: sess, userInput: '我到了。'
    });
    assert(built2 && built2.messages.length, '装配应产出 messages');

    var seen = [];
    h2.win.AbortController = AbortController;
    h2.win.fetch = function (url, init) {
      seen.push({ url: String(url), init: init });
      var txt = JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: '（桩）' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } });
      return Promise.resolve({ ok: true, status: 200,
        text: function () { return Promise.resolve(txt); },
        clone: function () { return { text: function () { return Promise.resolve(txt); } }; } });
    };
    /* ★ await 在 try 内 —— 保护一直持续到断言跑完 */
    var res = await S2.api.requestOnce({ cfg: {
      baseUrl: 'stub://trace/v1', apiKey: 'stub-trace-key-not-real',
      model: 'stub-model', temperature: 0.85, maxTokens: 8192,
      contextMessages: 40, stream: false, timeoutSec: 120 } },
      built2.messages, null);
    assert(res.ok, '生产链应成功：' + JSON.stringify(res));
    eq(seen.length, 1, '假 fetch 被调用次数');
    var body = JSON.parse(seen[0].init.body);

    /* ---- 五个现场字段仍在 ---- */
    ['雨夜的旧书店', '城西旧书店二楼阁楼', '深夜', '雨', '23:40'].forEach(function (a) {
      assert(JSON.stringify(body.messages).indexOf(a) >= 0,
        '生产 body 里应有现场锚点 ' + a);
    });
    /* ---- 历史无新增重复：逐条版各 1 次、拼接版 0 次（2026-10-05 裁决）----
       ⚠️ scene 消息进 body 时编译成 '【场景】' + paras 拼接（prompt-engine
       history 分支），判据按**装配产物**的真实形状对齐，不猜。 */
    var joined = PRE.join(' ');
    var joinedN = 0, perItemN = 0;
    body.messages.forEach(function (m) {
      var b = String(m.content == null ? '' : m.content);
      if (b.indexOf(joined) >= 0) joinedN++;
      PRE.forEach(function (pa) { if (b === '【场景】' + pa) perItemN++; });
    });
    eq(joinedN, 0, '★ 生产 body 里拼接版应为 0 次');
    eq(perItemN, 3, '★ 生产 body 里逐条版应恰好 3 次（每条各 1 次，带【场景】头）');
    /* ---- 全量逐字重复检测 ---- */
    var seenBody = {}, dup = [];
    body.messages.forEach(function (m, i) {
      var b = String(m.content == null ? '' : m.content);
      if (seenBody[b] !== undefined) dup.push((seenBody[b] + 1) + ' vs ' + (i + 1));
      seenBody[b] = i;
    });
    eq(dup, [], '生产 body 里的重复消息');
    ok('✓ 生产 body：五锚点齐全 · 逐条版各 1 次 · 拼接版 0 次 · 无重复');
  } finally {
    /* ★ 只有到这里（await 全部落地）才解除阻断 */
    restore();
  }
});

/* ---------- A 的补测：延迟替身下，阻断在「处理中」仍有效、退出后正确恢复 ---------- */
head('§2.6 断网保护的生命周期（本地替身，零外网）');

/* ⚠️⚠️⚠️ 本节**不接触任何公网地址**。
   历史（已如实登记，见交接文档）：调试期间的探针曾对 example.com 发起过
   **非模型的公网请求尝试**（本机网络已放行，Node 真的建了连，随后
   ECONNRESET）。那不是模型请求，但**确实发生在调试过程里** ——
   所以整批过程**不再自称「零网络」**，只能称「零模型请求」。
   ⇒ 现在的探针做法：
     ① 先把底层入口换成**永不联网的本地替身**（localStub）；
     ② 再叠一层「网络已被测试阻断」的绊线；
     ③ 断言只打这两个本地对象，**即使阻断失效也只会命中本地替身**，
        碰不到任何真实网络。

   ⚠️ 顺序很关键：**先替身后绊线**。反过来的话，绊线一旦失效，
      探针就会顺着真实入口发出去 —— 那正是上一轮出事的原因。 */

/* 本地替身：任何调用都只记账并返回假句柄，**永不建连**。 */
function localStub(tag) {
  var fn = function () {
    fn.calls.push({ tag: tag, argc: arguments.length });
    /* 假句柄：有 on/once/destroy/end 等常见方法，够测试代码安全摆弄 */
    return {
      on: function () { return this; }, once: function () { return this; },
      removeListener: function () { return this; },
      setTimeout: function () { return this; },
      write: function () { return true; }, end: function () { return this; },
      destroy: function () { return this; }, abort: function () { return this; }
    };
  };
  fn.calls = [];
  fn.__localStub = tag;
  return fn;
}
/* 被测的六个网络入口 —— 全部先换成本地替身 */
var ENTRY_MODULES = [
  ['https', 'https', ['request', 'get']],
  ['http', 'http', ['request', 'get']],
  ['net', 'net', ['connect', 'createConnection']]
];
function entryRefs() {
  var out = [];
  ENTRY_MODULES.forEach(function (g) {
    var mod = require(g[1]);
    g[2].forEach(function (m) { out.push([mod, m]); });
  });
  return out;
}
/* ★ 本节的安装器：先本地替身、后绊线；返回还原函数与两侧引用 */
function installLocalThenBlock() {
  var orig = entryRefs().map(function (p) { return p[0][p[1]]; });
  var stubs = entryRefs().map(function (p, i) {
    var s = localStub('entry' + i);
    p[0][p[1]] = s;
    return s;
  });
  /* 现在才叠绊线：即使它失效，探针也只会打到上面的本地替身 */
  var tripped = [];
  entryRefs().forEach(function (p) {
    p[0][p[1]] = function () {
      tripped.push(1);
      throw new Error('网络已被测试阻断');
    };
  });
  return {
    stubs: stubs,
    tripped: tripped,
    /* 还原：先撤绊线，再把本地替身换回原始引用 */
    restore: function () {
      entryRefs().forEach(function (p, i) { p[0][p[1]] = orig[i]; });
    }
  };
}
/* 探针：只打**本地对象**。阻断有效 → 抛「已被阻断」；失效 → 命中本地替身。 */
function probeLocalOnly() {
  var https = require('https');
  try {
    var r = https.request('https://example.invalid/never');
    /* ⚠️ 走到这里说明**绊线失效**了 —— 但它只会命中本地替身 */
    if (r && typeof r.destroy === 'function') r.destroy();
    return { 阻断: false, 命中本地替身: true };
  } catch (e) {
    return { 阻断: /网络已被测试阻断/.test(e.message), 命中本地替身: false };
  }
}
/* 引用对比：**永不调用**，用于验证「已恢复」 */
function entryRefsNow() {
  return entryRefs().map(function (p) { return p[0][p[1]]; });
}
tas('探针本身零外网：即使阻断失效也只命中本地替身', async function () {
  var orig = entryRefsNow();
  var inst = installLocalThenBlock();
  try {
    /* ① 阻断生效时：探针抛「已被阻断」，不触达本地替身 */
    var p1 = probeLocalOnly();
    assert(p1.阻断 === true, '阻断态下探针应抛「已被测试阻断」');
    assert(p1.命中本地替身 === false, '阻断态下不该命中本地替身');
    /* ② 人为撤掉绊线（模拟阻断失效）：此时入口是**本地替身**，
       探针只可能命中它 —— 不可能触达真实网络。 */
    var https = require('https');
    https.request = inst.stubs[0];
    var p2 = probeLocalOnly();
    assert(p2.命中本地替身 === true,
      '★ 阻断失效时探针只命中本地替身（不会触达真实网络）');
    assert(p2.阻断 === false, '撤掉绊线后不该再抛阻断错');
    ok('✓ 阻断失效也只命中本地替身 —— 本节零外网');
  } finally { inst.restore(); }
  entryRefsNow().forEach(function (fn, i) {
    assert(fn === orig[i], '还原后第 ' + (i + 1) + ' 个入口未回到原引用');
  });
});
tas('处理中阻断仍有效：await 期间网络入口仍被挡', async function () {
  var orig = entryRefsNow();
  var inst = installLocalThenBlock();
  try {
    assert(probeLocalOnly().阻断, '开始时就应处于阻断态');
    /* 延迟替身：在 await 期间让出事件循环，模拟真实网络耗时 */
    await new Promise(function (r) { setTimeout(r, 20); });
    assert(probeLocalOnly().阻断, '★ await 之后仍应处于阻断态');
    await new Promise(function (r) { setTimeout(r, 20); });
    assert(probeLocalOnly().阻断, '★ 第二次 await 之后仍应处于阻断态');
  } finally { inst.restore(); }
});
tas('正常完成后恢复：restore 之后函数引用回到原值', async function () {
  var before = entryRefsNow();
  var inst = installLocalThenBlock();
  assert(probeLocalOnly().阻断, '阻断生效');
  await new Promise(function (r) { setTimeout(r, 10); });
  inst.restore();
  /* ★ 只比对引用，**不调用** */
  var after = entryRefsNow();
  eq(after.length, before.length, '入口数量');
  before.forEach(function (fn, i) {
    assert(after[i] === fn, '第 ' + (i + 1) + ' 个网络入口未还原');
  });
  ok('✓ 六个网络入口全部还原为原始引用');
});
tas('异常退出也恢复：try 内抛错时 finally 仍还原', async function () {
  var before = entryRefsNow();
  var inst = installLocalThenBlock();
  var caught = null;
  try {
    await new Promise(function (r) { setTimeout(r, 10); });
    throw new Error('故意抛错，验证 finally');
  } catch (e) { caught = e; }
  finally { inst.restore(); }
  assert(caught && /故意抛错/.test(caught.message), '应捕到预期的错');
  var after = entryRefsNow();
  before.forEach(function (fn, i) {
    assert(after[i] === fn, '★ 异常退出后第 ' + (i + 1) + ' 个网络入口未还原');
  });
});
tas('★ 反向：非 async 回调会让 finally 提前释放（复现原缺陷）', async function () {
  var savedRef = entryRefsNow();
  var inst = installLocalThenBlock();
  try {
    /* 模拟旧写法：非 async 回调 + return promise。
       它的 `finally`（含 restore）**同步执行** —— promise 还没落地。 */
    var p = (function () {
      try { return Promise.resolve('x'); }
      finally { inst.restore(); }      /* ← 非 async：此刻就执行 */
    })();
    /* 同步点：p 未落地，但 restore 已跑过 ⇒ 保护已被提前释放 */
    var releasedEarly = entryRefsNow()[0] === savedRef[0];
    await p;                          /* ★ 显式 await 内部 Promise */
    var releasedAtSettle = entryRefsNow()[0] === savedRef[0];
    assert(releasedEarly,
      '★ 非 async 回调：promise 尚未落地，finally 里的 restore 就已执行');
    assert(releasedAtSettle,
      '★ 等 promise 落地时，保护**早已**被释放（这正是修掉的那个缺陷）');
    ok('✓ 复现确认：非 async 回调的 finally 早于 promise 落地 → 保护失效');
  } finally { inst.restore(); }
});
tas('★ 对照：async 回调的 finally 晚于 await 落地（修好的形态）', async function () {
  var savedRef = entryRefsNow();
  var inst = installLocalThenBlock();
  var stillBlockedAtAwait = null;
  try {
    /* ★ 显式 await 内部 async 函数 —— 不再用「等 40ms 当作完成」 */
    await (async function () {
      try {
        await new Promise(function (r) { setTimeout(r, 15); });
        /* await 落地后、finally 之前 —— 保护应当**仍然生效** */
        stillBlockedAtAwait = entryRefsNow()[0] !== savedRef[0];
      } finally { inst.restore(); }
    })();
    assert(stillBlockedAtAwait,
      '★ async 回调：await 期间保护仍在（与上面那条非 async 的形成对照）');
    assert(entryRefsNow()[0] === savedRef[0],
      '★ 内层 finally 已执行（await 返回即代表它跑完了）');
  } finally { inst.restore(); }
});

/* createSession 默认值：从**生产源码**读，不手抄 */
function defaultsFromSource() {
  var src = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');
  function g(re, name) {
    var m = src.match(re);
    if (!m) throw new Error('生产源码里找不到默认值：' + name);
    return m[1];
  }
  return {
    sceneName: g(/sceneName:\s*pending\s*\?\s*'…'\s*:\s*\(String\(form\.sceneName[^)]*\)[^|]*\|\|\s*'([^']+)'/, 'sceneName'),
    timeOfDay: g(/timeOfDay:\s*pending\s*\?\s*'[^']*'\s*:\s*\(form\.timeOfDay\s*\|\|\s*'([^']+)'\)/, 'timeOfDay'),
    weather: g(/weather:\s*pending\s*\?\s*'[^']*'\s*:\s*\(form\.weather\s*\|\|\s*'([^']+)'\)/, 'weather'),
    location: g(/location:\s*pending\s*\?\s*'[^']*'\s*:\s*\(form\.location\s*\|\|\s*'([^']+)'\)/, 'location'),
    clockTime: g(/clockTime:\s*pending\s*\?\s*'[^']*'\s*:\s*\(form\.clockTime\s*\|\|\s*'([^']+)'\)/, 'clockTime')
  };
}

t('能从生产源码读出 createSession 默认值（判据有效）', function () {
  var d = defaultsFromSource();
  eq(d, { sceneName: '未命名场景', timeOfDay: '傍晚', weather: '晴',
    location: '—', clockTime: '16:42' }, '默认值');
});

t('剥注释器本身有判别力（阳性对照）', function () {
  /* 不给这判据加阳性对照，它就可能「什么都不扫」而恒绿。 */
  var withComment = '// s2.sceneName = 1;\nvar a = 1;';
  var withCode = 'var s2 = {}; s2.sceneName = 1;';
  assert(stripCommentsAndStrings(withComment).indexOf('sceneName') < 0,
    '注释里的写法应被剥掉');
  assert(stripCommentsAndStrings(withCode).indexOf('sceneName') >= 0,
    '真代码里的写法应保留');
  assert(stripCommentsAndStrings('/* s2.env = 2; */var b=2;').indexOf('env') < 0,
    '块注释里的写法应被剥掉');
  assert(stripCommentsAndStrings('var s = "s2.sceneName = 3";').indexOf('s2.sceneName') < 0,
    '字符串字面量里的写法应被剥掉');
  ok('✓ 剥注释器：注释/字符串里的写法被剥掉，真代码里的保留');
});

/* ============================================================
   §3 保留的负向对照：「直接改副本不会保存」
   ★ 这是**根因证据**，修好了也不能删 ——
     它证明生产深拷贝是设计如此，要改的是调用方。
   ============================================================ */
head('§3 负向对照：直接改 findSession 的副本不会保存（根因证据）');
t('store.get 返回深拷贝 → 改它不影响 store', function () {
  var hh = H.boot('trace-neg-1');
  hh.win.Sleepy.store.set('offlineSessions',
    [{ id: 'x', sceneName: '原值', env: { location: 'L1' }, messages: [] }]);
  var got = hh.win.Sleepy.store.get('offlineSessions');
  got[0].sceneName = '被改';
  eq(hh.win.Sleepy.store.get('offlineSessions')[0].sceneName, '原值', '改动应丢失');
});
t('findSession 返回的也是孤儿副本（旧 SETUP 正是这么用的）', function () {
  var hh = H.boot('trace-neg-2');
  var S2 = hh.win.Sleepy;
  var s = S2.offlineStore.createSession('c1', {});
  var s2 = S2.offlineStore.findSession(s.id);
  s2.sceneName = '想写的场景名';
  s2.env = { location: '想写的 location' };
  eq(S2.offlineStore.findSession(s.id).sceneName, '未命名场景', '场景名应仍是默认');
  eq(S2.offlineStore.findSession(s.id).env.location, '—', 'location 应仍是默认');
});
t('对照：走 mutateSession 路径（updateEnv / createSession form）就能落库', function () {
  var hh = H.boot('trace-neg-3');
  var S2 = hh.win.Sleepy;
  var s = S2.offlineStore.createSession('c1',
    { sceneName: '创建参数写的', location: 'L', timeOfDay: 'T' });
  S2.offlineStore.updateEnv(s.id, { location: 'L2' });
  eq(S2.offlineStore.findSession(s.id).sceneName, '创建参数写的', '场景名走创建参数');
  eq(S2.offlineStore.findSession(s.id).env.location, 'L2', 'env 走 updateEnv');
});
t('⚠️ 已知陷阱：updateEnv 传 sceneName 会被**静默忽略**（不报错）', function () {
  var hh = H.boot('trace-neg-4');
  var S2 = hh.win.Sleepy;
  var s = S2.offlineStore.createSession('c1', { sceneName: '原场景名' });
  S2.offlineStore.updateEnv(s.id, { sceneName: '想改的' });
  eq(S2.offlineStore.findSession(s.id).sceneName, '原场景名',
    'updateEnv 不管 sceneName —— 所以场景名必须走 createSession 的 form');
});

/* ============================================================
   §4 取证落盘（口径护栏：不许出现「模型收到了…」）
   ============================================================ */
head('§4 取证落盘');
var OUT = process.env.SLEEPY_TRACE_OUT ||
  path.join(ROOT, 'docs', '取证-F2现场值持久化验证-2026-10-05.json');
var payload = {
  生成时间: new Date().toISOString(),
  说明: '本文件登记「夹具预期」与「链路各步实际」。**不含**任何' +
    '「模型当时收到了什么」的结论 —— 响应后装配快照不代表客户端提交给 fetch 的内容' +
    '（真实那一份要等 fetch 旁路记到 init.body）。',
  口径: '本文件提到的「请求体」一律指**客户端提交给 fetch 的请求体**（init.body）。' +
    '它是客户端这一侧提交的**输入**，**不声称**服务端已收到、更不声称模型已消费。',
  结论: '五个现场字段在 SETUP 之后**全部正确落库**，并出现在客户端提交给 fetch 的请求体 messages 里。',
  前置消息: {
    条数: (S.offlineStore.findSession(SID) || { messages: [] }).messages.length,
    说明: 'user 2 条 + preActions 逐条 3 条 + 现场 1 条，顺序固定；拼接版已删（2026-10-05 裁决）',
    逐条: (S.offlineStore.findSession(SID) || { messages: [] }).messages.map(function (m, i) {
      var b = (m.paras || []).map(function (x) { return x.text; }).join('\n');
      if (b === '' && m.text) b = m.text;
      return { 序: i + 1, role: m.role, 正文: b };
    })
  },
  夹具预期: WANT,
  createSession默认值: defaultsFromSource(),
  修复方式: {
    场景名: 'createSession(charId, form) 的 form.sceneName（正式创建参数）',
    环境四字段: 'createSession 的 form + updateEnv（已验证的保存入口）两条都写，自检核对',
    为什么不用findSession: '它内部 store.get 返回**深拷贝** → 孤儿副本，直接赋值静默丢失',
    是否改了生产代码: false
  },
  运行时spy: h.spy,
  各步取值: {
    存档直读: vRaw, findSession回读: vFind,
    场景段: sceneSeg, 请求体条数: cap.messages.length,
    请求体bodySHA256: cap.bodySHA256
  },
  边界: {
    本轮未做: ['未发任何请求', '未启动浏览器', '未调模型', '未取真实 init.body'],
    下一轮: '拿真实 init.body 与本文件的三步取值并排对齐（三层真正对齐）'
  }
};
t('取证 JSON 落盘', function () {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  var back = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  eq(back.夹具预期, WANT, '落盘里的夹具预期');
  assert(fs.statSync(OUT).size > 500, '落盘文件太小');
  ok('✓ ' + OUT + '（' + fs.statSync(OUT).size + ' 字节）');
});
t('口径护栏：取证文件不含「模型收到 / 已送达模型」类越界断言', function () {
  var s = JSON.stringify(JSON.parse(fs.readFileSync(OUT, 'utf8')));
  ['模型收到', '已送达模型', '模型当时看到', '已证实送达'].forEach(function (w) {
    assert(s.indexOf(w) < 0, '取证里出现越界表述：' + w);
  });
});
t('口径护栏：统一用「客户端提交给 fetch 的请求体」', function () {
  var back = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert(/客户端提交给 fetch/.test(JSON.stringify(back)) ||
    /客户端提交给 fetch/.test(back.说明),
  '取证里要点名新口径');
  /* 断言旧口径**不再**作为对外表述出现（字段名兼容不算） */
  var s = JSON.stringify(back);
  assert(s.indexOf('已证实实际发送内容') < 0, '仍有旧口径「已证实实际发送内容」');
});
t('口径护栏：明确标注未取真实 init.body', function () {
  var back = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert(back.边界.本轮未做.indexOf('未取真实 init.body') >= 0,
    '必须写明未取真实 init.body');
  assert(/init\.body/.test(back.说明), '说明里必须点名 init.body');
});

/* ============================================================
   汇总
   ★ 必须等异步用例（§2.5 走生产链那条）落地再统计 ——
     否则退出码先于 then 里的断言跑掉（假绿）。
   ============================================================ */
Promise.all(pending).then(function () {
  var total = pass + fail;
  process.stdout.write('\n' + '─'.repeat(56) + '\n');
  process.stdout.write('夹具现场值持久化验证：' + pass + ' / ' + total + ' 通过\n');
  if (fail) {
    process.stdout.write('✗ 失败 ' + fail + ' 项：\n');
    problems.forEach(function (p) { process.stdout.write('  · ' + p + '\n'); });
    process.exit(1);
  }
  process.stdout.write('✓ 全绿（零**模型**请求 · 未启动浏览器 · 未改生产代码）\n');
  process.exit(0);
});
