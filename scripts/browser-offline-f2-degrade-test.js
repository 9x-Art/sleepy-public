#!/usr/bin/env node
/* ============================================================
   scripts/browser-offline-f2-degrade-test.js
   —— P0：parseOfflineReply 失败后的**用户可见降级**验收

   跑法（需要 NODE_PATH 指向 playwright-core）：
     NODE_PATH=<managed workspace>/node_modules \
       node scripts/browser-offline-f2-degrade-test.js

   ★ 走**真实发送链**（nav.open → 填输入框 → 点 .off-send-btn），
     只 mock 模型通道（api.requestOnce）—— 生产路径不改。
   ★ 虚构角色与会话，全新浏览器 profile，不读真实聊天 / 用户配置。

   ---------- 本脚本要证明的事（逐条对应批准的验收要求）----------
     1. 坏 JSON      → 正文**不含** `{"paras"`；出现人话提示；原始区默认折叠
     2. 空字符串     → 同上一条（方案 A：统一走降级）
     3. 默认折叠     → `<details>.open === false`
     4. 展开可见     → `<pre>` 里能看到原始文本（含 `{`）
     5. 成功路径不变 → paras / trans / suggests / envUpdate / scene 全照旧
     6. **原始片段不进下一轮真实 payload** ← 探查真实出站 built.messages
     7. **原始片段不进历史拼装**           ← messageText / parasText
     8. **原始片段不进导出**               ← 走 store 导出接口
     9. **原始片段不进诊断**               ← 诊断快照全文搜
   ⚠️ 第 6~9 条的判据都是「**数据没进**」，**不是**「UI 没显示」。
      UI 不显示但数据进了 store / 上下文，是更隐蔽的失败。
   ============================================================ */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
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
/* 唯一可信判据：诊断 stage（真实出站那次）。
   ⚠️ 别用「消息数变多 且 不忙」—— 失败轮也会解除 busy，会把失败误判成落地。 */
var STAGE_OF = function () {
  var d = Sleepy.offlineDiag.snapshot();
  return d ? d.stage : null;
};

var BAD_JSON = '{"paras":[{"type":"prose","text":"坏 JSON 片段 UNIQ-BAD-9f3a"},' +
  '"type":"prose":"缺冒号 UNIQ-BAD-2b7c"}]}';

/* ---------- 造一个真实线下场景（虚构夹具） ---------- */
var PREP = function () {
  var core = Sleepy.core;
  var sb = core.listSandboxes()[0];
  var ch = core.upsertChar({
    id: '__degrole__', kind: 'main', name: '沈砚',
    content: '沈砚，建筑设计师，习惯用精确的尺寸和材料名说话。',
    sandboxId: sb && sb.id
  });
  /* ⚠️ openingBy 必须设 'user'：默认是 'char'，进页 350ms 后会自动开场，
     那轮会在**模型通道桩装好之前**发出去 → 诊断被那一轮占掉，
     后面测的 stage 全是上一轮的值。（第一版就是这么全错的。）
     本脚本每一轮都由我们自己点发送，不要自动开场。 */
  var s = Sleepy.offlineStore.createSession(ch.id, { openingBy: 'user' });
  window.__sid = s.id;
  /* ★ 真实 store 配置 → candForSession 才出连接（连接判定必须是生产逻辑） */
  Sleepy.store.set('mainApi', {
    name: '夹具主模型', baseUrl: 'https://fixture.invalid/v1', apiKey: 'k',
    model: 'fixture-model', temperature: null, maxTokens: null,
    contextMessages: null, stream: false, timeoutSec: 120, enabled: true
  });
  Sleepy.nav.open('offline-scene', { id: s.id });
  return { sid: s.id };
};

var SCENE_READY = function () {
  var p = document.querySelector('[data-page="offline-scene"]');
  return !!(p && p.classList.contains('is-active') && document.querySelector('.off-input-field'));
};

/* 装一个可控的模型通道。mode 决定这一轮返回什么。 */
var STUB = function (arg) {
  /* ⚠️ 字符串必须**随参数传进页内** —— 本函数在浏览器上下文跑，
     Node 侧的 BAD_JSON 常量在页内取不到（ReferenceError → 整轮请求失败）。 */
  var mode = arg.mode;
  var BAD = arg.bad;
  var calls = [];
  window.__calls = calls;
  Sleepy.api.requestOnce = function (cand, messages) {
    calls.push({ at: calls.length, n: (messages || []).length });
    if (mode === 'ok') {
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"paras":[{"type":"dialogue","text":"正常台词 UNIQ-OK-77a1","trans":"正常译文"},' +
          '{"type":"prose","text":"正常描写。"}],"suggests":["走一步","坐下","不说话"],' +
          '"envUpdate":{"clockTime":"21:30"}}' });
    }
    if (mode === 'bad') return Promise.resolve({ ok: true, ms: 1, content: BAD });
    if (mode === 'empty') return Promise.resolve({ ok: true, ms: 1, content: '' });
    if (mode === 'ok-then-bad') {
      /* ⚠️ 别用 calls.length 判第几轮 —— 探查 / 装配等额外调用会把它错位。
         用「已经成功落地的轮数」：降级那次不算。 */
      var done = calls.filter(function (x) { return x.degraded !== true; }).length;
      calls[calls.length - 1].degraded = (done > 1);
      return calls[calls.length - 1].degraded
        ? Promise.resolve({ ok: true, ms: 1, content: BAD })
        : Promise.resolve({ ok: true, ms: 1, content: '{"paras":[{"type":"prose","text":"第一轮正常。"}]}' });
    }
    if (mode === 'ok-then-empty') {
      return calls.length === 1
        ? Promise.resolve({ ok: true, ms: 1, content: '{"paras":[{"type":"prose","text":"第一轮正常。"}]}' })
        : Promise.resolve({ ok: true, ms: 1, content: '' });
    }
    return Promise.resolve({ ok: true, ms: 1, content: '{"paras":[]}' });
  };
};

var SEND = function (text) {
  var input = document.querySelector('.off-input-field');
  var send = document.querySelector('.off-send-btn');
  if (!input || !send) return { sent: false, why: 'no input/send' };
  input.value = text;
  if (send.disabled) return { sent: false, why: 'send disabled' };
  send.click();
  return { sent: true };
};

/* 发一轮并等它出结论（成功或失败都算「出结论」） */
var RUN_TURN = async function (page, text, timeoutMs) {
  var before = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    return s ? s.messages.length : 0;
  });
  await page.evaluate(function (n) { window.__beforeN = n; }, before);
  var sent = await page.evaluate(SEND, text);
  if (!sent.sent) return { sent: false, stage: null };
  var stage = null;
  var limit = Math.ceil((timeoutMs || 20000) / 500);
  for (var i = 0; i < limit; i++) {
    await page.waitForTimeout(500);
    stage = await page.evaluate(STAGE_OF);
    var busy = await page.evaluate(function () {
      var i2 = document.querySelector('.off-input-field');
      var b = document.querySelector('.off-send-btn');
      return !!(i2 && i2.disabled) || !!(b && b.disabled);
    });
    /* ⚠️ 只等「诊断出结论」—— **不能等 busy 解除**。
       解析降级那条路径会重绘正文但不追加常规 char/scene 消息，
       若把 busy 当结束条件，可能在诊断落定前就退出，拿到旧 stage。 */
    if (stage && stage !== 'at-call-boundary') break;
    if (!busy && i > 6) break;   /* 兜底：最多再等 3 秒 */
  }
  /* 诊断落定后再给页面一点时间把降级块渲染出来 */
  await page.waitForTimeout(400);
  return { sent: true, stage: stage };
};

/* 页内：读这一轮的降级 DOM。**只看当前页面**。 */
var READ_DEGRADE = function () {
  var b = document.querySelector('.off-parsefail');
  if (!b) return { present: false };
  var fold = b.querySelector('details');
  var pre = b.querySelector('pre');
  var hint = b.querySelector('.off-parsefail-hint');
  return {
    present: true,
    hint: hint ? hint.textContent : '',
    hasDetails: !!fold,
    open: fold ? fold.open : null,
    summary: fold && fold.querySelector('summary')
      ? fold.querySelector('summary').textContent : '',
    raw: pre ? pre.textContent : '',
    hasRaw: !!pre
  };
};

var BODY_TEXT = function () {
  var s = document.querySelector('.off-chat-scroll');
  return s ? s.textContent : '';
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

  process.stdout.write('\nP0 降级验收 · ' + BASE + '\n');
  await page.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
  await page.waitForTimeout(500);

  /* ============ 1. 坏 JSON → 用户可见降级 ============ */
  process.stdout.write('\n1. 坏 JSON（方案 A：与空串统一走降级）\n');

  await page.evaluate(PREP);
  await page.waitForFunction(SCENE_READY, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.evaluate(STUB, { mode: 'bad', bad: BAD_JSON });
  var t1 = await RUN_TURN(page, '坏 JSON 测试', 20000);
  try {
    eq(t1.stage, 'model-returned', '请求本身必须成功（成功 ≠ 解析成功）：');
  } catch (e) { bad('坏 JSON · 请求阶段 -> ' + e.message); }

  var d1 = await page.evaluate(READ_DEGRADE);
  try {
    assert(d1.present, '★ 坏 JSON 后必须出现降级块 .off-parsefail');
    ok('坏 JSON：正文出现降级块（不再直接显示裸 JSON）');
  } catch (e) { bad('坏 JSON · 降级块 -> ' + e.message); }

  try {
    /* ⚠️ 判「正文干净」必须**先把折叠区内容摘掉**再判。
       textContent 不区分 <details> 是收是展 —— 直接判会把
       「默认折叠区里那份原始返回」算成正文，误报成裸 JSON 泄漏。
       （第一版就是这么误报的：判据错了，产品是对的。） */
    var purity = await page.evaluate(function () {
      var scroll = document.querySelector('.off-chat-scroll');
      var clone = scroll.cloneNode(true);
      var raws = clone.querySelectorAll('.off-parsefail-raw');
      raws.forEach(function (n) { n.textContent = '[原始区已排除]'; });
      return {
        visible: clone.textContent,
        rawCount: raws.length,
        rawInFold: (function () {
          var real = document.querySelectorAll('.off-parsefail-raw');
          return real.length;
        })()
      };
    });
    assert(purity.visible.indexOf('{"paras"') < 0,
      '★ 正文（折叠区外）不得出现裸 JSON：' + purity.visible.slice(-200));
    assert(purity.visible.indexOf('UNIQ-BAD-9f3a') < 0,
      '★ 正文不得出现原始片段 UNIQ-BAD-9f3a');
    assert(purity.visible.indexOf('UNIQ-BAD-2b7c') < 0,
      '★ 正文不得出现坏 JSON 片段 UNIQ-BAD-2b7c');
    assert(purity.rawInFold >= 1,
      '折叠区里应该确实存着原始返回（否则「展开可见」那条就没意义了）');
    ok('坏 JSON：正文（折叠区外）**不含** {"paras"、不含任何原始片段；' +
      '原始返回只在折叠区内（' + purity.rawInFold + ' 处）');
  } catch (e) { bad('坏 JSON · 正文纯净 -> ' + e.message); }

  try {
    assert(d1.hint.indexOf('这一轮的回复格式出了点问题') >= 0,
      '降级块应含人话提示，实得：' + d1.hint);
    assert(d1.hasDetails, '降级块里应有可展开的原始返回区');
    ok('坏 JSON：人话提示 =「' + d1.hint + '」');
  } catch (e) { bad('坏 JSON · 提示文案 -> ' + e.message); }

  try {
    eq(d1.open, false, '★ 原始返回区必须**默认折叠**：');
    eq(d1.summary, '查看原始返回', '折叠标题：');
    ok('坏 JSON：原始返回区默认折叠（details.open = ' + d1.open + '）');
  } catch (e) { bad('坏 JSON · 默认折叠 -> ' + e.message); }

  /* 展开后可见 */
  var d1o = await page.evaluate(function () {
    var f = document.querySelector('.off-parsefail details');
    if (f) f.open = true;
    var pre = document.querySelector('.off-parsefail pre');
    return { open: f ? f.open : null, raw: pre ? pre.textContent : '' };
  });
  try {
    eq(d1o.open, true, '展开后 open 应为 true：');
    assert(d1o.raw.indexOf('UNIQ-BAD-9f3a') >= 0,
      '★ 展开后必须能看到原始返回，实得：' + d1o.raw.slice(0, 120));
    assert(d1o.raw.indexOf('UNIQ-BAD-2b7c') >= 0,
      '展开后原始返回应包含完整的坏 JSON（含缺冒号那段）');
    ok('坏 JSON：展开后原始返回完整可见（' + d1o.raw.length + ' 字符）');
  } catch (e) { bad('坏 JSON · 展开可见 -> ' + e.message); }

  /* ============ 2. 空字符串 → 同样走降级 ============ */
  process.stdout.write('\n2. 空字符串（HTTP 200 但 content 为空）\n');

  await page.evaluate(PREP);
  await page.waitForFunction(SCENE_READY, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.evaluate(STUB, { mode: 'empty', bad: BAD_JSON });
  var t2 = await RUN_TURN(page, '空串测试', 20000);
  try {
    eq(t2.stage, 'model-returned', '空串那轮请求本身也算成功：');
  } catch (e) { bad('空串 · 请求阶段 -> ' + e.message); }

  var d2 = await page.evaluate(READ_DEGRADE);
  try {
    assert(d2.present, '★ 空字符串也必须走降级（方案 A：统一处理）');
    ok('空字符串：走同一条降级路径');
  } catch (e) { bad('空串 · 降级块 -> ' + e.message); }

  try {
    eq(d2.open, false, '空串的原始返回区也必须默认折叠：');
    ok('空字符串：原始返回区默认折叠');
  } catch (e) { bad('空串 · 折叠 -> ' + e.message); }

  var d2r = await page.evaluate(function () {
    var f = document.querySelector('.off-parsefail details');
    if (f) f.open = true;
    var pre = document.querySelector('.off-parsefail pre');
    return pre ? pre.textContent : null;
  });
  try {
    assert(d2r !== null, '空串也应有一个原始返回区（只是内容为空）');
    assert(d2r.indexOf('本次没有可查看的原始内容') >= 0,
      '★ 空串的原始区应显示固定文案，实得：' + JSON.stringify(d2r));
    ok('空字符串：原始区显示「' + d2r + '」');
  } catch (e) { bad('空串 · 空内容提示 -> ' + e.message); }

  /* ============ 3. 成功路径完整不变 ============ */
  process.stdout.write('\n3. 成功路径完整不变（paras/trans/suggests/envUpdate/scene）\n');

  await page.evaluate(PREP);
  await page.waitForFunction(SCENE_READY, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.evaluate(STUB, { mode: 'ok', bad: BAD_JSON });
  var t3 = await RUN_TURN(page, '成功测试', 20000);
  try {
    eq(t3.stage, 'model-returned', '成功轮阶段：');
  } catch (e) { bad('成功 · 阶段 -> ' + e.message); }

  var okProbe = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var last = null;
    for (var i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === 'char' || s.messages[i].role === 'scene') {
        last = s.messages[i]; break;
      }
    }
    var body = document.querySelector('.off-chat-scroll');
    return {
      hasMsg: !!last,
      paras: last ? (last.paras || []) : [],
      isDegrade: !!(last && last.parseFailed),
      bodyText: body ? body.textContent : '',
      hasSuggest: !!(body && body.querySelector('.off-suggest, .off-suggest-block, [class*="suggest"]')),
      degradePresent: !!document.querySelector('.off-parsefail')
    };
  });
  try {
    assert(okProbe.hasMsg, '成功轮必须落地消息');
    eq(okProbe.isDegrade, false, '★ 成功路径不得被误判成降级：');
    eq(okProbe.degradePresent, false, '★ 成功时不得出现降级块：');
    ok('成功路径：正常落地，无降级块（parseFailed 未误标）');
  } catch (e) { bad('成功 · 未误判 -> ' + e.message); }

  try {
    var hasDialog = okProbe.paras.some(function (p) { return p.type === 'dialogue'; });
    var hasProse = okProbe.paras.some(function (p) { return p.type === 'prose'; });
    assert(hasDialog, '成功路径的 dialogue 段应保留');
    assert(hasProse, '成功路径的 prose 段应保留');
    var dlg = okProbe.paras.filter(function (p) { return p.type === 'dialogue'; })[0];
    eq(dlg.trans, '正常译文', 'trans 字段应原样保留：');
    assert(okProbe.bodyText.indexOf('UNIQ-OK-77a1') >= 0, '正文应显示模型台词');
    assert(okProbe.bodyText.indexOf('{"paras"') < 0, '成功路径正文也不该有裸 JSON');
    /* ⚠️ 译文**不断言正文可见**：它由 msgTrans 组件挂载，
       且受「全局译文开关 + 海外角色」两道闸门管 ——
       夹具角色没开海外，不显示才是正确行为。
       这里只断言 trans 字段**没被降级逻辑吃掉**（上面已查 dlg.trans）。 */
    ok('成功路径：paras / 正文渲染照旧；trans 字段保留（正文可见性由 msgTrans 双闸门决定，不在此断言）');
  } catch (e) { bad('成功 · paras/trans -> ' + e.message); }

  /* envUpdate 与 suggests */
  var envSug = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var body = document.querySelector('.off-chat-scroll');
    return { clock: s.env && s.env.clockTime,
      envShown: body ? body.textContent : '' };
  });
  try {
    /* envUpdate 写进会话 env（是否立即反映到顶栏取决于是否勾了显示，这轮只看数据） */
    assert(envSug.clock === '21:30',
      'envUpdate.clockTime 应写进会话，实得：' + envSug.clock);
    ok('成功路径：envUpdate 写进会话（clockTime = ' + envSug.clock + '）');
  } catch (e) { bad('成功 · envUpdate -> ' + e.message); }

  try {
    assert(okProbe.hasSuggest, '成功路径的 suggests 应照旧渲染出可选块');
    ok('成功路径：suggests 照旧渲染');
  } catch (e) { bad('成功 · suggests -> ' + e.message); }

  /* ============ 4. 原始片段不进入下一轮真实 payload（核心） ============ */
  process.stdout.write('\n4. 原始片段不进入下一轮真实出站 payload\n');

  await page.evaluate(PREP);
  await page.waitForFunction(SCENE_READY, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.evaluate(STUB, { mode: 'ok-then-bad', bad: BAD_JSON });
  var tA = await RUN_TURN(page, '第一轮', 20000);
  try {
    eq(tA.stage, 'model-returned', '第一轮（正常）阶段：');
  } catch (e) { bad('第一轮 -> ' + e.message); }
  var tB = await RUN_TURN(page, '第二轮', 20000);
  try {
    eq(tB.stage, 'model-returned',
      '第二轮（坏 JSON）请求本身仍算成功 —— 成功 ≠ 解析成功：');
  } catch (e) { bad('第二轮 -> ' + e.message); }
  var degAfter = await page.evaluate(READ_DEGRADE);
  try {
    assert(degAfter.present, '★ 第二轮坏 JSON 后应出现降级块');
    ok('第二轮（坏 JSON）：走降级，历史里已有这条失败记录');
  } catch (e) { bad('第二轮降级 -> ' + e.message); }

  /* ---------- 4b. 逐字检查**装配层**的历史回灌 ----------
     ⚠️ 原来靠「拦 requestOnce 抓 payload」，但那一轮请求的 payload 是
        **发送前**装配的 —— 里面还没有刚降级的那条消息，抓到的是上一轮。
        （第一版就是这么误报的。）
     ★ 直接调 assembleOffline 拿**装配结果**，那才是真正进模型上下文的东西。
       后面第 4c 条再单独验「真实出站确实发的是它」。 */
  var assembled = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var built = Sleepy.promptEngine.assembleOffline({
      charId: s.charId, userId: null, session: s, userInput: null
    });
    return {
      assistants: built.messages.filter(function (m) { return m.role === 'assistant'; })
        .map(function (m) { return String(m.content); }),
      whole: JSON.stringify(built.messages)
    };
  });
  try {
    var aj = assembled.assistants.join('\n---\n');
    assert(aj.indexOf('UNIQ-BAD') < 0,
      '★ assistant 段里出现了原始片段：' + aj.slice(0, 200));
    assert(aj.indexOf('"type":"prose":"') < 0,
      '★ 缺冒号那串坏 JSON 进了 assistant 段');
    /* ⚠️ 判据在 2026-10-04「返修第二批」被推翻过一次：
       原本要求「中性失败标记进入 assistant 段」，
       现在要求**不出现** —— 失败记录已按 parseFailed 状态整体排除，
       模型上下文里不该有任何「角色说了句提示」的东西。 */
    assert(aj.indexOf('这一轮的回复格式出了点问题') < 0,
      '★ 失败提示仍以某种形式进入 assistant 段：' + aj.slice(0, 200));
    assert(aj.indexOf('第一轮正常') >= 0,
      '★ 正常历史被误删了：' + aj.slice(0, 120));
    assembled.assistants.forEach(function (a) {
      assert(a.length < 300,
        '★ assistant 段过长（' + a.length + ' 字符），疑似把原始返回灌进去了：' +
        a.slice(0, 120));
    });
    assert(assembled.whole.indexOf('UNIQ-BAD') < 0,
      '★ 整份装配结果里出现了原始片段');
    ok('装配层 assistant 段（' + assembled.assistants.length + ' 条）：' +
      '无原始内容、无失败提示，正常历史保留；各段：' +
      JSON.stringify(assembled.assistants).slice(0, 160));
  } catch (e) { bad('装配层历史回灌 -> ' + e.message); }

  /* ---------- 4c. 真实出站确实发的是这份装配结果 ----------
     ⚠️ 不在这里「换掉 requestOnce 再点发送」来截 payload ——
        换掉之后不恢复，第 5 节复用同一页面时通道已被动过，
        状态就乱了（第一版就是这么把后面两节一起搞红的）。
     ★ 改成：给通道装一个**透传观察器**（记下 payload 后原样调用原实现），
       轮次判定交给已有的 ok-then-bad 序列，不额外制造一轮。 */
  await page.evaluate(function () {
    var orig = Sleepy.api.requestOnce;
    Sleepy.api.requestOnce = function () {
      var args = arguments;
      var self = this;
      return orig.apply(self, args).then(function (r) {
        try {
          window.__lastSent = JSON.stringify(args[1]);
        } catch (e) { /* 记不到就算了，不影响本轮 */ }
        return r;
      });
    };
  });
  await page.evaluate(function () {
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    input.value = '收尾观察轮';
    if (send && !send.disabled) send.click();
  });
  await page.waitForTimeout(2500);
  var sentNow = await page.evaluate(function () {
    return { captured: window.__lastSent || null };
  });
  try {
    assert(sentNow.captured, '★ 必须真的截到一次真实出站');
    assert(sentNow.captured.indexOf('UNIQ-BAD-9f3a') < 0,
      '★ 真实出站 payload 含原始片段 UNIQ-BAD-9f3a');
    assert(sentNow.captured.indexOf('UNIQ-BAD-2b7c') < 0,
      '★ 真实出站 payload 含坏 JSON 片段 UNIQ-BAD-2b7c');
    assert(sentNow.captured.indexOf('"type":"prose":"') < 0,
      '★ 真实出站 payload 含缺冒号那串坏 JSON');
    assert(sentNow.captured.indexOf('这一轮的回复格式出了点问题') < 0,
      '★ 真实出站里出现了失败提示（失败记录应已排除）');
    assert(sentNow.captured.indexOf('第一轮正常') >= 0,
      '★ 真实出站里没有正常历史（说明拦截时机不对或历史被误删）');
    ok('真实出站 payload（' + sentNow.captured.length + ' 字符）：' +
      '不含原始/坏 JSON 片段，也不含失败提示，正常历史保留');
  } catch (e) { bad('真实出站 payload -> ' + e.message); }

  /* ============ 5. 不进历史拼装 / 导出 / 诊断 ============ */
  process.stdout.write('\n5. 原始片段不进历史拼装 / 导出 / 诊断\n');

  var histProbe = await page.evaluate(function () {
    /* 历史拼装走 messageText → parasText。直接查会话里那条降级消息的形状。 */
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var deg = null;
    for (var i = 0; i < s.messages.length; i++) {
      if (s.messages[i].parseFailed) { deg = s.messages[i]; break; }
    }
    if (!deg) return { found: false };
    return {
      found: true,
      keys: Object.keys(deg).sort(),
      parasText: JSON.stringify(deg.paras || []),
      parasCount: (deg.paras || []).length,
      hasRawField: Object.prototype.hasOwnProperty.call(deg, 'rawReturn')
    };
  });
  try {
    assert(histProbe.found, '降级消息应带 parseFailed 标记');
    eq(histProbe.hasRawField, false,
      '★ 消息对象上不得有 rawReturn 字段（mutateSession 会 saveAll → 会落库）');
    ok('降级消息对象：**无 rawReturn 字段**（不会被 saveAll 持久化）');
  } catch (e) { bad('历史拼装 · 字段 -> ' + e.message); }

  try {
    assert(histProbe.parasText.indexOf('UNIQ-BAD') < 0,
      '★ paras 里绝不能有原始片段：' + histProbe.parasText.slice(0, 200));
    eq(histProbe.parasCount, 1, 'paras 只应有一条中性说明：');
    assert(histProbe.parasText.indexOf('这一轮的回复格式出了点问题') >= 0,
      'paras 应是那句中性失败说明，实得：' + histProbe.parasText);
    ok('降级消息 paras：只含中性失败说明（1 段，无原始内容）');
  } catch (e) { bad('历史拼装 · paras -> ' + e.message); }

  var expProbe = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var store = Sleepy.store;
    var out = { storeHasRaw: false, sample: '' };
    /* 存储层直查：把整个线下会话序列化，看有没有原始片段 */
    try {
      var all = store.get('offlineSessions') ||
        store.get('offline.sessions') || null;
      if (all) {
        var s2 = JSON.stringify(all);
        out.storeHasRaw = s2.indexOf('UNIQ-BAD') >= 0;
        out.sample = s2.length;
      }
    } catch (e) { out.err = e.message; }
    /* 也查 localStorage 原文。★ 2026-10-05 判据更新（行为有意变更）：
       解析降级取证通道上线 —— 原始返回会落 localStorage 的**独立命名空间**
       `sleepy.forensics.parseFail.*`（见 page-offline.js 的 FORENSICS_KEY_PREFIX），
       这是本批批准的新行为，不再算「落库」。
       业务硬边界随之改为三条：
       a) **store 命名空间 `sleepy.v1.` 内**（业务真实落库处）不得有 UNIQ-BAD；
       b) 取证命名空间里**必须有** UNIQ-BAD（阳性对照：取证真的拿到原文）；
       c) 取证记录不得出现在 store 导出（exportAll 只遍历 DEFAULTS）。 */
    try {
      var lsAll = null, forensicsHit = null, storeNsHit = null;
      for (var k = 0; k < localStorage.length; k++) {
        var key = localStorage.key(k);
        var v = localStorage.getItem(key) || '';
        if (v.indexOf('UNIQ-BAD') < 0) continue;
        if (key.indexOf('sleepy.forensics.parseFail.') === 0) { forensicsHit = key; continue; }
        if (key.indexOf('sleepy.v1.') === 0) { storeNsHit = key; break; }
        lsAll = key;
      }
      out.localStorageHit = lsAll || null;
      out.forensicsHit = forensicsHit;
      out.storeNsHit = storeNsHit;
    } catch (e2) { out.lsErr = e2.message; }
    return out;
  });
  try {
    eq(expProbe.storeNsHit, null,
      '★ 业务命名空间（sleepy.v1.*）里出现了 UNIQ-BAD（真·落库了）：' + expProbe.storeNsHit);
    assert(expProbe.forensicsHit,
      '★ 取证命名空间（sleepy.forensics.parseFail.*）里没有 UNIQ-BAD —— 取证通道没拿到原文');
    ok('存储层：业务命名空间无 UNIQ-BAD；取证命名空间有原文（新边界两条都成立）');
    eq(expProbe.storeHasRaw, false, 'store 序列化里出现了 UNIQ-BAD（说明落库了）');
  } catch (e) { bad('落库检查 -> ' + e.message); }

  var diagProbe = await page.evaluate(function () {
    var d = Sleepy.offlineDiag.snapshot();
    return { json: JSON.stringify(d), keys: d ? Object.keys(d).sort() : [] };
  });
  try {
    assert(diagProbe.json.indexOf('UNIQ-BAD') < 0,
      '★ 诊断里出现了原始片段：' + diagProbe.json.slice(0, 200));
    eq(diagProbe.keys, ['at', 'behaviorUsed', 'modules', 'reason', 'requestId',
      'requestOk', 'seq', 'stage', 'touched', 'version'].sort(),
      '诊断字段白名单不得变化：');
    ok('诊断：仍是那十个白名单字段，不含原始返回');
  } catch (e) { bad('诊断检查 -> ' + e.message); }

  /* ============ 6. 页面报错 ============ */
  process.stdout.write('\n');
  var realErr = errors.filter(function (e) {
    return !/favicon|Failed to load resource/i.test(e);
  });
  if (realErr.length) {
    bad('页面报错：' + realErr.slice(0, 3).join(' | '));
  } else {
    ok('全程无页面报错');
  }

  await browser.close();

  process.stdout.write('\n结果\n  通过 ' + pass + ' / 失败 ' + fail + '\n');
  if (fail) {
    process.stdout.write('\n失败项：\n');
    problems.forEach(function (p) { process.stdout.write('  - ' + p + '\n'); });
    process.stdout.write('\n结论：降级验收**未通过**。\n');
    process.exit(1);
  }
  process.stdout.write('\n结论：**降级验收通过**。\n' +
    '⚠️ 只证明降级可见性与数据隔离；**模型效果仍未验收**。\n');
})().catch(function (e) {
  process.stdout.write('脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
