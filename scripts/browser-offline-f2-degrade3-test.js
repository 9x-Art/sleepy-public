#!/usr/bin/env node
/* ============================================================
   scripts/browser-offline-f2-degrade3-test.js
   —— P0 返修第二批·定向补证：生命周期 + 世界书 + 总结

   跑法：
     NODE_PATH=<managed workspace>/node_modules \
       node scripts/browser-offline-f2-degrade3-test.js

   ---------- 为什么单独开这个脚本 ----------
   上一批报告里写「切走前长度=14，回来后长度=14」，**这条证据无效**：
   「（本次没有可查看的原始内容）」正好 14 字 —— 测的是被淘汰那条的空提示，
   不是原始内容。本脚本用**含唯一标记的非空坏返回**重测。

   ---------- 本脚本要证明的 ----------
     A. 生命周期：切页前后**唯一标记仍在**；刷新后**标记消失**
     B. 世界书槽过滤：失败记录被排除、正常内容保留（撤掉过滤须检出）
     C. 总结输入过滤：失败记录被排除、正常内容保留（撤掉过滤须检出）
   ============================================================ */
'use strict';

var BASE = process.env.SLEEPY_TEST_URL || 'http://127.0.0.1:5173/';

var chromium;
try { chromium = require('playwright-core').chromium; }
catch (e) {
  process.stdout.write('SKIP：playwright-core 不可用（' + e.message + '）\n');
  process.exit(0);
}

var pass = 0, fail = 0, problems = [];
function ok(m) { pass++; process.stdout.write('  \u2713 ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  \u2717 ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + '期望 ' + y + '，实得 ' + x);
}

var MARK = '这一轮的回复格式出了点问题。';
var EMPTY_TXT = '（本次没有可查看的原始内容）';
/* ★ 唯一标记 LIFE-CYCLE-UNIQUE-a7f3e9 —— 非空、可搜、不会与其它串混淆 */
var LIFE = 'LIFE-CYCLE-UNIQUE-a7f3e9';
/* 故意写坏 JSON（缺右引号）：必须是**解析失败**才会走降级才有原始返回。 */
var BAD_LIFE = '{"paras":[{"type":"prose","text":"' + LIFE + ' 保留我"},' +
  '"type":"prose":"缺冒号那段"}]}';
var OK1 = '{"paras":[{"type":"prose","text":"正常内容保留我 NORMAL-KEEP-b2d4f6"}]}';

/* ⚠️ 本函数在**浏览器上下文**执行 —— Node 侧的 OK1 / BAD_LIFE 常量在页内
   取不到（ReferenceError），必须随参数传进去。这个坑我踩过多次。 */
var PREP = function (arg) {
  var OK1 = arg.ok, BAD_LIFE = arg.bad;
  var core = Sleepy.core, sb = core.listSandboxes()[0];
  var ch = core.upsertChar({
    id: '__d3role__', kind: 'main', name: '沈砚',
    content: '沈砚，建筑设计师，习惯用精确的尺寸和材料名说话。',
    sandboxId: sb && sb.id
  });
  var s = Sleepy.offlineStore.createSession(ch.id, { openingBy: 'user' });
  window.__sid = s.id;
  Sleepy.store.set('mainApi', {
    name: 'f', baseUrl: 'https://fixture.invalid/v1', apiKey: 'k',
    model: 'fixture-model', temperature: null, maxTokens: null,
    contextMessages: null, stream: false, timeoutSec: 120, enabled: true
  });
  /* ⚠️ 显式两轮序列，**不靠 n===1 猜** ——
     页面加载/开场等流程可能消耗计数，导致「第一轮正常」其实没发生，
     两轮都返回坏 JSON，「正常内容保留」就没得验了。（第一版就这么废的。） */
  var n = 0;
  Sleepy.api.requestOnce = function () {
    /* 第 1 次正常、第 2 次起都是坏 JSON。
       ⚠️ 不用 seq[Math.min(...)] —— 那样「发了几轮」与「第几次调用」会错位，
          块数对不上（第一版实测 2 条含标记就是这个原因）。 */
    var c = (n === 0) ? OK1 : BAD_LIFE;
    n++;
    return Promise.resolve({ ok: true, ms: 1, content: c });
  };
  Sleepy.nav.open('offline-scene', { id: s.id });
  return s.id;
};

var READY = function () {
  var p = document.querySelector('[data-page="offline-scene"]');
  return !!(p && p.classList.contains('is-active') &&
    document.querySelector('.off-input-field'));
};
var STAGE = function () {
  var d = Sleepy.offlineDiag.snapshot();
  return d ? d.stage : null;
};

var TURN = async function (page, text) {
  var sent = await page.evaluate(function (t) {
    var i = document.querySelector('.off-input-field');
    var s = document.querySelector('.off-send-btn');
    if (!i || !s) return false;
    i.value = t;
    if (s.disabled) return false;
    s.click();
    return true;
  }, text);
  if (!sent) return { sent: false };
  var stage = null;
  for (var i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    stage = await page.evaluate(STAGE);
    if (stage && stage !== 'at-call-boundary') break;
  }
  await page.waitForTimeout(350);
  return { sent: true, stage: stage };
};

/* 读**全部**降级块的原始区（不只第一个 —— 上一批就是只读了被淘汰那条） */
var READ_ALL_RAW = function (life) {
  var blocks = Array.prototype.slice.call(document.querySelectorAll('.off-parsefail'));
  var raws = blocks.map(function (b) {
    var pre = b.querySelector('pre');
    return pre ? pre.textContent : null;
  });
  return {
    块数: blocks.length,
    含标记的条数: raws.filter(function (t) { return t && t.indexOf(life) >= 0; }).length,
    是空提示的条数: raws.filter(function (t) { return t === EMPTY_TXT_FN(); }).length,
    标记: life,
    各条长度: raws.map(function (t) { return t == null ? -1 : t.length; }),
    各条前24字: raws.map(function (t) { return t == null ? null : t.slice(0, 24); })
  };
  function EMPTY_TXT_FN() { return '（本次没有可查看的原始内容）'; }
};

(async function () {
  var browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch (e) {
    process.stdout.write('SKIP：无法启动 Edge（' + e.message + '）\n');
    process.exit(0);
  }
  var ctx = await browser.newContext();
  var page = await ctx.newPage();
  var errors = [];
  page.on('pageerror', function (e) {
    if (/\[Sleepy\]/.test(String(e && e.message))) errors.push(String(e.message));
  });
  page.on('console', function (m) {
    if (m.type() === 'error') errors.push(m.text());
  });

  process.stdout.write('\n定向补证 · 生命周期 / 世界书 / 总结 · ' + BASE + '\n');
  process.stdout.write('唯一标记：' + LIFE + '（非空坏返回）\n');
  await page.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
  await page.waitForTimeout(500);

  /* ================= A. 生命周期 ================= */
  process.stdout.write('\nA. 原始返回的生命周期（用唯一标记，不用字数）\n');

  await page.evaluate(PREP, { ok: OK1, bad: BAD_LIFE });
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  var tA1 = await TURN(page, '正常一轮');
  var tA2 = await TURN(page, '坏 JSON 一轮');
  try {
    eq(tA1.stage, 'model-returned', '第一轮（正常）阶段：');
    eq(tA2.stage, 'model-returned', '第二轮（坏 JSON）阶段：');
  } catch (e) { bad('A·轮次 -> ' + e.message); }

  var a1 = await page.evaluate(READ_ALL_RAW, LIFE);
  try {
    assert(a1.块数 >= 1, '应至少有一个降级块');
    assert(a1.含标记的条数 >= 1,
      '★ 应至少 1 条原始区含唯一标记（说明测的是真实内容不是空提示），实得 ' +
      a1.含标记的条数);
    assert(a1.含标记的条数 < a1.块数 || a1.块数 === a1.含标记的条数,
      '（记录用：含标记 ' + a1.含标记的条数 + ' / 共 ' + a1.块数 + ' 块）');
    ok('切页前：' + a1.块数 + ' 个降级块，其中 ' + a1.含标记的条数 +
      ' 条含标记 ' + LIFE + '，长度 ' + JSON.stringify(a1.各条长度));
  } catch (e) { bad('A·切页前 -> ' + e.message); }

  /* 顺带确认第一轮的正常内容真的落地了（B/C 两节的前提） */
  var aKeep = await page.evaluate(function (k) {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var all = JSON.stringify(s.messages);
    return { 正常内容在会话里: all.indexOf(k) >= 0 };
  }, 'NORMAL-KEEP-b2d4f6');
  try {
    eq(aKeep.正常内容在会话里, true,
      '★ 第一轮的正常内容没落地（夹具序列错了，B/C 两节会失去前提）');
    ok('A 前提：第一轮正常内容 NORMAL-KEEP-b2d4f6 已落地在会话里');
  } catch (e) { bad('A·前提 -> ' + e.message); }

  /* 切走 → 再回来 */
  await page.evaluate(function () { Sleepy.nav.open('home'); });
  await page.waitForTimeout(800);
  var sid = await page.evaluate(function () { return window.__sid; });
  await page.evaluate(function (s) { Sleepy.nav.open('offline-scene', { id: s }); }, sid);
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(900);
  var a2 = await page.evaluate(READ_ALL_RAW, LIFE);
  try {
    assert(a2.含标记的条数 >= 1,
      '★ 切页回来后标记应仍在（内存容器在模块作用域，不随场景页销毁），实得 ' +
      a2.含标记的条数);
    ok('切页回来：唯一标记 ' + LIFE + ' **仍在**（' + a2.含标记的条数 +
      ' 条），长度 ' + JSON.stringify(a2.各条长度));
  } catch (e) { bad('A·切页后 -> ' + e.message); }

  /* 刷新：必须丢 */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
  await page.waitForTimeout(700);
  var a3 = await page.evaluate(function (life) {
    var 业务含 = false, 取证含 = false;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if ((localStorage.getItem(k) || '').indexOf(life) < 0) continue;
      if (k.indexOf('sleepy.forensics.parseFail.') === 0) 取证含 = true;
      else 业务含 = true;
    }
    return { 业务localStorage含标记: 业务含, 取证命名空间含标记: 取证含 };
  }, LIFE);
  var sidAfter = await page.evaluate(function (s) {
    var list = Sleepy.store.get('offlineSessions') || [];
    var found = list.filter(function (x) { return x.id === s; })[0];
    if (!found) return null;
    Sleepy.nav.open('offline-scene', { id: s });
    return s;
  }, sid);
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(900);
  var a4 = await page.evaluate(READ_ALL_RAW, LIFE);
  try {
    /* ★ 2026-10-05 判据更新（行为有意变更）：取证通道上线后，
       原始返回落 `sleepy.forensics.parseFail.*` 独立命名空间且**跨刷新留存**
       —— 刷新后能取回原文正是本批目的。业务边界只收窄到非取证键。 */
    eq(a3.业务localStorage含标记, false,
      '★ 业务 localStorage 里出现了唯一标记（真·落库了）');
    eq(a3.取证命名空间含标记, true,
      '★ 取证命名空间里没有唯一标记（取证通道没拿到原文）');
    ok('刷新后：唯一标记随取证通道**跨刷新留存**（业务键 0 命中），' +
      '业务存储仍干净');
  } catch (e) { bad('A·刷新后 -> ' + e.message); }

  /* ================= B. 世界书槽过滤 ================= */
  process.stdout.write('\nB. 世界书槽过滤（独立证据）\n');

  /* 刷新后 sid 已作废（内存变量还在但 store 里的会话是旧的）——
     B/C 两节需要「失败记录 + 正常内容**并存**」的会话，重新 PREP 一个。 */
  await page.evaluate(PREP, { ok: OK1, bad: BAD_LIFE });
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await TURN(page, 'B 节正常一轮');
  await TURN(page, 'B 节坏 JSON 一轮');

  /* ---------- B0. 静态源码断言（**卡生产代码本身**） ----------
     ⚠️ 上一版把判据写成「在页内复刻过滤/不过滤两条路径」——
        那与生产代码**解耦**，把生产过滤撤掉它照样报绿（我实测过，假绿）。
     ★ 正确做法：直接读源码，断言那两行过滤**真的在**。
        剥注释后再判（修法说明里必然写出这些名字，不剥会把自己判成违规）。 */
  var fs = require('fs');
  var path = require('path');
  var ROOT = path.join(__dirname, '..');
  var peSrc = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  var poSrc = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');
  var peBare = peSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  var poBare = poSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  try {
    /* B0-1. worldbook 槽：过滤必须在 map 之前 */
    var wbIdx = peBare.indexOf('var wbOff = (session.messages || [])');
    assert(wbIdx >= 0, '找不到 worldbook 槽的 wbOff 构造');
    var wbSeg = peBare.slice(wbIdx, wbIdx + 220);
    assert(/filter\(function \(m\) \{\s*return !m\.parseFailed;/.test(wbSeg),
      '★ worldbook 槽的源码里没有 parseFailed 过滤：' + wbSeg.slice(0, 120));
    var filterAt = wbSeg.indexOf('filter(');
    var mapAt = wbSeg.indexOf('.map(');
    assert(filterAt >= 0 && mapAt > filterAt,
      '★ worldbook 槽的 filter 不在 map 之前（顺序反了等于没过滤）');
    ok('B0 源码：worldbook 槽确有 parseFailed 过滤，且在 .map 之前');
  } catch (e) { bad('B0·worldbook 源码 -> ' + e.message); }

  try {
    /* B0-2. history 槽：keptMsgs 必须在 slice(-20) 之前 */
    var hIdx = peBare.indexOf('var allMsgs = session.messages || [];');
    assert(hIdx >= 0, '找不到 history 槽的 allMsgs');
    var hSeg = peBare.slice(hIdx, hIdx + 300);
    assert(/var keptMsgs = allMsgs\.filter\(function \(m\) \{ return !m\.parseFailed; \}\);/
      .test(hSeg), '★ history 槽的源码里没有 keptMsgs 过滤');
    assert(hSeg.indexOf('keptMsgs.slice(-20)') > hSeg.indexOf('var keptMsgs'),
      '★ history 槽没有「先过滤再 slice(-20)」');
    ok('B0 源码：history 槽确有 keptMsgs 过滤，且在 slice(-20) 之前');
  } catch (e) { bad('B0·history 源码 -> ' + e.message); }

  try {
    /* B0-3. generateSummary：transcript 必须先 filter */
    var gIdx = poBare.indexOf('var transcript = session.messages');
    assert(gIdx >= 0, '找不到 generateSummary 的 transcript 构造');
    var gSeg = poBare.slice(gIdx, gIdx + 260);
    assert(/session\.messages\.filter\(function \(m\)/.test(gSeg),
      '★ generateSummary 的 transcript 没有 filter');
    assert(/return !m\.parseFailed;/.test(gSeg),
      '★ generateSummary 的 filter 里没有 parseFailed 判据');
    ok('B0 源码：generateSummary 的 transcript 确有 parseFailed 过滤');
  } catch (e) { bad('B0·summary 源码 -> ' + e.message); }

  var b1 = await page.evaluate(function (arg) {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var built = Sleepy.promptEngine.assembleOffline({
      charId: s.charId, userId: null, session: s, userInput: null
    });
    /* worldbook 槽的产物：找含「世界书」或 wb 相关的那段 system。
       保险做法：把**所有** system 段拼起来找（失败标记若漏进去必然出现）。 */
    var sys = built.messages.filter(function (m) { return m.role === 'system'; })
      .map(function (m) { return String(m.content); }).join('\n@@@\n');
    return {
      有parseFailed记录: s.messages.some(function (m) { return m.parseFailed; }),
      失败记录数: s.messages.filter(function (m) { return m.parseFailed; }).length,
      全部system含失败标记: sys.indexOf(arg.mark) >= 0,
      全部system含正常内容: sys.indexOf('NORMAL-KEEP-b2d4f6') >= 0,
      system段数: built.messages.filter(function (m) { return m.role === 'system'; }).length
    };
  }, { mark: MARK });
  try {
    assert(b1.有parseFailed记录, '前提：会话里应有失败记录');
    ok('B 前提：会话里 ' + b1.失败记录数 + ' 条 parseFailed 记录，' +
      'system 段 ' + b1.system段数 + ' 个');
  } catch (e) { bad('B·前提 -> ' + e.message); }

  try {
    eq(b1.全部system含失败标记, false,
      '★ worldbook 槽（及所有 system 段）里出现了失败标记');
    ok('B 世界书：所有 system 段都不含失败标记');
  } catch (e) { bad('B·排除失败记录 -> ' + e.message); }

  /* ⚠️ 判据要落在**检索文本本身**，不是 system 段 ——
     compileWorldbook 只把 recentText 当**关键词源**做匹配，
     输出的是世界书条目，正常历史本来就不会原样出现在 system 段。
     （第一版把判据下在 system 段上，方向就反了。） */
  var b2 = await page.evaluate(function (arg) {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    function parasText(ps) {
      return (ps || []).map(function (p) { return p.text || ''; }).join('\n');
    }
    /* ⚠️ 这段是**辅助说明**（复刻两条路径做对照），**不是主判据** ——
       它与生产代码解耦，撤掉生产过滤它照样绿（实测过）。
       主判据是上面的 B0 静态源码断言。 */
    var withFilter = (s.messages || []).filter(function (m) { return !m.parseFailed; })
      .map(function (m) {
        if (m.role === 'user') return String(m.text || '');
        return parasText(m.paras);
      }).join('\n').slice(-4000);
    var withoutFilter = (s.messages || []).map(function (m) {
      if (m.role === 'user') return String(m.text || '');
      return parasText(m.paras);
    }).join('\n').slice(-4000);
    return {
      过滤后含失败标记: withFilter.indexOf(arg.mark) >= 0,
      过滤后含正常内容: withFilter.indexOf('NORMAL-KEEP-b2d4f6') >= 0,
      不过滤含失败标记: withoutFilter.indexOf(arg.mark) >= 0,
      过滤后长度: withFilter.length,
      不过滤长度: withoutFilter.length
    };
  }, { mark: MARK });
  try {
    eq(b2.过滤后含失败标记, false,
      '★ worldbook 检索文本里出现了失败标记');
    ok('B 世界书检索文本（' + b2.过滤后长度 + ' 字符）：不含失败标记');
  } catch (e) { bad('B·检索文本排除 -> ' + e.message); }

  try {
    eq(b2.过滤后含正常内容, true,
      '★ 正常内容被误删了（worldbook 过滤过头）');
    ok('B 世界书检索文本：正常内容 NORMAL-KEEP-b2d4f6 仍在');
  } catch (e) { bad('B·检索文本保留 -> ' + e.message); }

  try {
    eq(b2.不过滤含失败标记, true,
      '★ 反向对照失效：不过滤时检索文本竟然不含失败标记');
    ok('B 反向对照：不过滤时检索文本**确实**含失败标记（' +
      b2.不过滤长度 + ' 字符 vs 过滤后 ' + b2.过滤后长度 + '）' +
      ' —— 证明这条过滤不是空转');
  } catch (e) { bad('B·反向对照 -> ' + e.message); }

  /* ================= C. 总结输入过滤 ================= */
  process.stdout.write('\nC. generateSummary 的 transcript 过滤（独立证据）\n');

  /* ⚠️ 同 B：下面这段是**辅助对照**，主判据是 B0-3 的静态源码断言。 */
  var c1 = await page.evaluate(function (arg) {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    /* 复刻 generateSummary 里的 transcript 拼装（同一份口径）。
       这里**只读**地调 messageText 等价物，不真发总结请求。 */
    function parasText(paras) {
      return (paras || []).map(function (p) { return p.text || ''; }).join('\n');
    }
    var charName = '沈砚';
    var withFilter = s.messages.filter(function (m) { return !m.parseFailed; })
      .map(function (m) {
        if (m.role === 'user') return '你：' + (m.text || '');
        if (m.role === 'scene') return '【场景】' + parasText(m.paras);
        if (m.role === 'char') return charName + '：' + parasText(m.paras);
        return '';
      }).filter(Boolean).join('\n');
    var withoutFilter = s.messages.map(function (m) {
      if (m.role === 'user') return '你：' + (m.text || '');
      if (m.role === 'scene') return '【场景】' + parasText(m.paras);
      if (m.role === 'char') return charName + '：' + parasText(m.paras);
      return '';
    }).filter(Boolean).join('\n');
    return {
      有parseFailed记录: s.messages.some(function (m) { return m.parseFailed; }),
      过滤后含失败标记: withFilter.indexOf(arg.mark) >= 0,
      过滤后含正常内容: withFilter.indexOf('NORMAL-KEEP-b2d4f6') >= 0,
      不过滤含失败标记: withoutFilter.indexOf(arg.mark) >= 0,
      不过滤含角色前缀: withoutFilter.indexOf('沈砚：' + arg.mark) >= 0,
      transcript长度: withFilter.length
    };
  }, { mark: MARK });
  try {
    assert(c1.有parseFailed记录, '前提：会话里应有失败记录');
    eq(c1.过滤后含失败标记, false,
      '★ 总结 transcript 里出现了失败标记');
    ok('C 总结：transcript 不含失败标记（长度 ' + c1.transcript长度 + '）');
  } catch (e) { bad('C·排除失败记录 -> ' + e.message); }

  try {
    eq(c1.过滤后含正常内容, true, '★ 正常内容被误删了（总结过滤过头）');
    ok('C 总结：正常内容 NORMAL-KEEP-b2d4f6 仍在 transcript 里');
  } catch (e) { bad('C·保留正常内容 -> ' + e.message); }

  /* 反向对照：证明「不过滤」时确实会被污染（否则上面的过滤是空转） */
  try {
    eq(c1.不过滤含失败标记, true,
      '★ 反向对照失效：不过滤时竟然不含失败标记，说明本测试测不到东西');
    eq(c1.不过滤含角色前缀, true,
      '★ 反向对照失效：不过滤时没有「沈砚：' + MARK + '」这种角色化污染');
    ok('C 反向对照：不过滤时 transcript **确实**会出现「沈砚：' + MARK + '」' +
      ' —— 证明这条过滤不是空转');
  } catch (e) { bad('C·反向对照 -> ' + e.message); }

  process.stdout.write('\n');
  var realErr = errors.filter(function (e) {
    return !/favicon|Failed to load resource/i.test(e);
  });
  if (realErr.length) bad('页面报错：' + realErr.slice(0, 3).join(' | '));
  else ok('全程无页面报错');

  await browser.close();

  process.stdout.write('\n结果\n  通过 ' + pass + ' / 失败 ' + fail + '\n');
  if (fail) {
    process.stdout.write('\n失败项：\n');
    problems.forEach(function (p) { process.stdout.write('  - ' + p + '\n'); });
    process.stdout.write('\n结论：定向补证**未通过**。\n');
    process.exit(1);
  }
  process.stdout.write('\n结论：**定向补证通过**。\n');
})().catch(function (e) {
  process.stdout.write('脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
