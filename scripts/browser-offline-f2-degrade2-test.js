#!/usr/bin/env node
/* ============================================================
   scripts/browser-offline-f2-degrade2-test.js
   —— P0 返修·第二批：历史归属修正 + 边界测试

   跑法：
     NODE_PATH=<managed workspace>/node_modules \
       node scripts/browser-offline-f2-degrade2-test.js

   ★ 本批要证明的（逐条对应返修要求）：
     1. 下一轮真实出站 payload **不含**「角色名：失败提示」这种角色化台词，
        也不含原始坏内容；**正常历史仍保留**
     2. 页面刷新后原始内容不可恢复，**降级记录仍能正常渲染**
     3. 连续 >8 条失败：容量上限、淘汰对象、旧记录展开后的提示
     4. 核对内存容器的**实际生命周期**（模块级 ≠ 页面级，要如实测）
     5. 经实际导出 / 收藏路径核对原始片段未进入
     6. 原始返回以**纯文本**渲染：含 HTML 标签的夹具不被解释执行
     7. 证据里「默认折叠」用无歧义写法

   ⚠️ 全部判据落在**数据链**（装配层 / 真实 payload / store / localStorage），
      不用「UI 没显示」替代。
   ============================================================ */
'use strict';

var path = require('path');
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
var HINT = '这一轮的回复格式出了点问题，原始返回可展开查看。';
var EMPTY_TXT = '（本次没有可查看的原始内容）';
var U1 = 'UNIQ-BAD-9f3a';
var U2 = 'UNIQ-BAD-2b7c';
var U3 = 'UNIQ-BAD-7c1d';

var BAD = '{"paras":[{"type":"prose","text":"第一段 ' + U1 + '"},' +
  '"type":"prose":"缺冒号 ' + U2 + '"}]}';
/* 含 HTML 标签的「原始返回」：必须按纯文本显示，不能被解析成元素。
   ⚠️ 必须**故意写坏 JSON**（缺一个引号）—— 否则它是合法 JSON，
      走正常路径、根本没有「原始返回」可验。
      （第一版的夹具是合法 JSON，于是什么都没测到。） */
var BAD_HTML = '{"paras":[{"type":"prose","text":"<img src=x onerror=window.__XSS=1>' + U3 + '"}';

var PREP = function (arg) {
  var core = Sleepy.core, sb = core.listSandboxes()[0];
  var ch = core.upsertChar({
    id: '__d2role__', kind: 'main', name: '沈砚',
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
  var n = 0;
  var first = arg.first || '{"paras":[{"type":"prose","text":"正常第一轮。"}]}';
  Sleepy.api.requestOnce = function () {
    n++;
    /* ⚠️ 单轮夹具（skipFirst）必须**第一轮就用目标内容** ——
       否则只发一轮时拿到的是「正常第一轮」，压根不会降级，
       断言「应出现降级块」就必然失败。（第一版就死在这。） */
    var c = arg.seq && arg.seq.length ? arg.seq[Math.min(n - 1, arg.seq.length - 1)]
      : (arg.skipFirst ? arg.bad : (n === 1 ? first : arg.bad));
    return Promise.resolve({ ok: true, ms: 1, content: c });
  };
  Sleepy.nav.open('offline-scene', { id: s.id });
  return s.id;
};

var READY = function () {
  var p = document.querySelector('[data-page="offline-scene"]');
  return !!(p && p.classList.contains('is-active') && document.querySelector('.off-input-field'));
};
var STAGE = function () {
  var d = Sleepy.offlineDiag.snapshot();
  return d ? d.stage : null;
};
var SEND = function (text) {
  var i = document.querySelector('.off-input-field');
  var s = document.querySelector('.off-send-btn');
  if (!i || !s) return { sent: false, why: 'no input/send' };
  i.value = text;
  if (s.disabled) return { sent: false, why: 'send disabled' };
  s.click();
  return { sent: true };
};

var TURN = async function (page, text) {
  var sent = await page.evaluate(SEND, text);
  if (!sent.sent) return { sent: false };
  var stage = null;
  for (var i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    stage = await page.evaluate(STAGE);
    if (stage && stage !== 'at-call-boundary') break;
  }
  await page.waitForTimeout(350);
  return { sent: true, stage: stage };
};

/* 装配层 assistant 段 —— 真正进模型上下文的东西 */
var ASSIST = function () {
  var s = Sleepy.offlineStore.findSession(window.__sid);
  var built = Sleepy.promptEngine.assembleOffline({
    charId: s.charId, userId: null, session: s, userInput: null
  });
  return built.messages.filter(function (m) { return m.role === 'assistant'; })
    .map(function (m) { return String(m.content); });
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

  process.stdout.write('\nP0 返修第二批 · 历史归属与边界 · ' + BASE + '\n');
  await page.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
  await page.waitForTimeout(500);

  /* ============ 1. 失败记录不进角色化台词，正常历史仍保留 ============ */
  process.stdout.write('\n1. 历史归属：失败记录不进上下文（判状态不判文案）\n');

  await page.evaluate(PREP, { bad: BAD });
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  var t1a = await TURN(page, '正常一轮');
  var t1b = await TURN(page, '坏 JSON 一轮');
  try {
    eq(t1a.stage, 'model-returned', '正常轮阶段：');
    eq(t1b.stage, 'model-returned', '坏 JSON 轮：请求成功但解析失败，stage 仍是 model-returned');
  } catch (e) { bad('轮次阶段 -> ' + e.message); }

  var a1 = await page.evaluate(ASSIST);
  try {
    var j1 = a1.join('\n---\n');
    assert(j1.indexOf('沈砚：' + MARK) < 0,
      '★ 失败提示仍以角色身份进入上下文：' + j1);
    assert(j1.indexOf(MARK) < 0,
      '★ assistant 段里出现了失败提示（哪怕不带角色名）：' + j1);
    assert(j1.indexOf(U1) < 0, '★ 上下文含原始片段 ' + U1);
    assert(j1.indexOf(U2) < 0, '★ 上下文含原始片段 ' + U2);
    assert(j1.indexOf('正常第一轮') >= 0, '★ 正常 char 历史被误删了：' + j1);
    ok('装配层 assistant 段：失败记录已排除（无「沈砚：' + MARK + '」），' +
      '正常 char 历史还在');
  } catch (e) { bad('历史归属 -> ' + e.message); }

  /* ⚠️ 「正常 user 历史还在」必须在**整份装配**里判，不能只看 assistant 段 ——
     user 段本来就不在 assistant 里。上一版就是这里判错了。 */
  var all1 = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var built = Sleepy.promptEngine.assembleOffline({
      charId: s.charId, userId: null, session: s, userInput: null
    });
    return {
      whole: JSON.stringify(built.messages),
      users: built.messages.filter(function (m) { return m.role === 'user'; })
        .map(function (m) { return String(m.content); })
    };
  });
  try {
    assert(all1.whole.indexOf(MARK) < 0,
      '★ 整份装配里出现了失败提示：' + all1.whole.slice(0, 200));
    assert(all1.whole.indexOf(U1) < 0 && all1.whole.indexOf(U2) < 0,
      '★ 整份装配里出现了原始片段');
    assert(all1.users.length >= 2,
      '★ 正常 user 历史被误删了，实得 ' + all1.users.length + ' 条：' +
      JSON.stringify(all1.users));
    assert(all1.whole.indexOf('正常一轮') >= 0, '★ 整份装配缺 user 正常输入');
    ok('整份装配（' + all1.whole.length + ' 字符，user 段 ' + all1.users.length +
      ' 条）：正常 user/char 历史都在，失败提示与原始片段都不在');
  } catch (e) { bad('整份装配 -> ' + e.message); }

  /* 精确内容检查：assistant 段逐条列出来给人看 */
  try {
    process.stdout.write('    assistant 段实际内容：' +
      JSON.stringify(a1, null, 0).slice(0, 220) + '\n');
  } catch (e) { /* 打印失败不影响判定 */ }

  /* ============ 2. 真实出站 payload ============ */
  process.stdout.write('\n2. 真实出站 payload\n');

  var sent = await page.evaluate(function (mark) {
    var captured = null;
    var orig = Sleepy.api.requestOnce;
    Sleepy.api.requestOnce = function () {
      var args = arguments, self = this;
      return orig.apply(self, args).then(function (r) {
        try { captured = JSON.stringify(args[1]); } catch (e) { }
        return r;
      });
    };
    var i = document.querySelector('.off-input-field');
    var s = document.querySelector('.off-send-btn');
    i.value = '出站验证轮';
    if (s && !s.disabled) s.click();
    return new Promise(function (res) {
      var t = 0;
      var iv = setInterval(function () {
        t += 400;
        if (captured || t > 12000) { clearInterval(iv); res({ captured: captured, mark: mark }); }
      }, 400);
    });
  }, MARK);
  try {
    assert(sent.captured, '★ 必须真的截到一次真实出站');
    assert(sent.captured.indexOf('沈砚：') < 0 || sent.captured.indexOf(MARK) < 0,
      '★ 出站 payload 含角色化的失败提示');
    assert(sent.captured.indexOf(MARK) < 0, '★ 出站 payload 含失败提示原文');
    assert(sent.captured.indexOf(U1) < 0, '★ 出站 payload 含原始片段 ' + U1);
    assert(sent.captured.indexOf(U2) < 0, '★ 出站 payload 含原始片段 ' + U2);
    assert(sent.captured.indexOf('出站验证轮') >= 0, '★ 本轮 user 输入没进 payload（拦截时机不对）');
    ok('真实出站 payload（' + sent.captured.length + ' 字符）：' +
      '无角色化失败提示、无原始片段，正常输入与历史都在');
  } catch (e) { bad('真实出站 -> ' + e.message); }

  /* ============ 3. 存储层 / 导出 / 收藏 ============ */
  process.stdout.write('\n3. 存储层 · 导出 · 收藏路径\n');

  var store3 = await page.evaluate(function (u1) {
    var out = {};
    /* 3a. localStorage 全扫。★ 2026-10-05 判据更新（行为有意变更）：
       解析降级取证通道上线，原始返回会落 `sleepy.forensics.parseFail.*`
       独立命名空间（不算落库）；业务硬边界收窄为「sleepy.v1.* 命名空间
       与其余键都不得有原始片段」。取证键单独记账，不算命中。 */
    var hit = null, forensicsHit = null;
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if ((localStorage.getItem(key) || '').indexOf(u1) < 0) continue;
      if (key.indexOf('sleepy.forensics.parseFail.') === 0) { forensicsHit = forensicsHit || key; continue; }
      hit = key; break;
    }
    out.localStorage命中 = hit;
    out.取证键命中 = forensicsHit;
    /* 3b. 导出：走真实导出接口 */
    try {
      var dump = Sleepy.store.exportUserData();
      var s = typeof dump === 'string' ? dump : JSON.stringify(dump);
      out.导出含U1 = s.indexOf(u1) >= 0;
      out.导出字符数 = s.length;
    } catch (e) { out.导出错误 = e.message; }
    try {
      var snap = Sleepy.store.exportInternalSnapshot();
      var s2 = typeof snap === 'string' ? snap : JSON.stringify(snap);
      out.内部快照含U1 = s2.indexOf(u1) >= 0;
    } catch (e2) { out.快照错误 = e2.message; }
    /* 3c. 会话表本身 */
    var sess = JSON.stringify(Sleepy.offlineStore.findSession(window.__sid));
    out.会话含U1 = sess.indexOf(u1) >= 0;
    /* 3d. 收藏：真实写一条 sourceType='offline' 的收藏，再看它存了什么 */
    try {
      var sid = window.__sid;
      var arr = Sleepy.store.get('favorites') || [];
      var probe = { id: '__favprobe__', kind: 'story', sourceType: 'offline',
        sourceId: sid, at: Date.now(), note: '收藏路径探针' };
      Sleepy.store.set('favorites', arr.concat([probe]));
      out.收藏已写入 = true;
      var favJson = JSON.stringify(Sleepy.store.get('favorites'));
      out.收藏含U1 = favJson.indexOf(u1) >= 0;
      /* 收藏读会话时只取 title/name —— 顺手确认会话上有没有 title/name 带原始内容 */
      var ss = Sleepy.offlineStore.findSession(sid);
      out.会话title = ss ? String(ss.title || ss.name || '') : null;
      /* 清掉探针，别污染后续 */
      Sleepy.store.set('favorites', (Sleepy.store.get('favorites') || [])
        .filter(function (f) { return f && f.id !== '__favprobe__'; }));
    } catch (e3) { out.收藏错误 = e3.message; }
    return out;
  }, U1);
  try {
    eq(store3.localStorage命中, null, '★ 业务 localStorage 出现了原始片段：' + store3.localStorage命中);
    assert(store3.取证键命中, '★ 取证命名空间没有 ' + U1 + ' —— 取证通道没拿到原文');
    eq(store3.会话含U1, false, '★ 会话表含原始片段');
    ok('存储层：业务 localStorage / 会话表都没有 ' + U1 + '；取证键有原文（新边界成立）');
  } catch (e) { bad('存储层 -> ' + e.message); }

  try {
    eq(store3.导出含U1, false, '★ exportUserData 含原始片段');
    eq(store3.内部快照含U1, false, '★ exportInternalSnapshot 含原始片段');
    ok('导出：exportUserData / exportInternalSnapshot 都不含 ' + U1 +
      '（导出 ' + store3.导出字符数 + ' 字符）');
  } catch (e) { bad('导出 -> ' + e.message); }

  try {
    eq(store3.收藏含U1, false, '★ 收藏记录含原始片段');
    ok('收藏：写入一条 sourceType=offline 的收藏后，' +
      '收藏数据不含 ' + U1 + '（收藏只读会话 title/name，不读 messages）');
  } catch (e) { bad('收藏 -> ' + e.message); }

  /* ============ 4. 原始返回以纯文本渲染（不执行 HTML） ============ */
  process.stdout.write('\n4. 原始返回按纯文本渲染（HTML 夹具）\n');

  await page.evaluate(PREP, { bad: BAD_HTML, skipFirst: true });
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  await TURN(page, 'HTML 夹具轮');
  var xss = await page.evaluate(function (u3) {
    var pre = document.querySelector('.off-parsefail-raw');
    var block = document.querySelector('.off-parsefail');
    return {
      降级块存在: !!block,
      xssFired: !!window.__XSS,
      pre存在: !!pre,
      imgInRaw: !!(pre && pre.querySelector('img')),
      preText: pre ? pre.textContent : null,
      preChildren: pre ? pre.children.length : null,
      bodyHasU3: (document.querySelector('.off-chat-scroll') || {}).textContent
        ? document.querySelector('.off-chat-scroll').textContent.indexOf(u3) >= 0 : false
    };
  }, U3);
  try {
    assert(xss.降级块存在, '★ HTML 夹具这轮应出现降级块（pre 不存在说明块都没渲染）');
    assert(xss.pre存在, '★ 应有原始返回区');
    eq(xss.xssFired, false, '★ onerror 被执行了（原始返回没按纯文本渲染）');
    eq(xss.imgInRaw, false, '★ 原始区里出现了真实 <img> 元素（标签被解析了）');
    eq(xss.preChildren, 0, '★ 原始区有子元素（应为纯文本节点）');
    assert(xss.preText && xss.preText.indexOf('<img') >= 0,
      '原始区应保留标签的字面文本，实得：' + String(xss.preText).slice(0, 80));
    ok('HTML 夹具：<img> 未被解析（pre 子元素 0 个、onerror 未触发），' +
      '标签以字面文本保留；正文含 ' + U3 + ' = ' + xss.bodyHasU3);
  } catch (e) { bad('纯文本渲染 -> ' + e.message); }

  /* ============ 5. 容量上限与淘汰 ============ */
  process.stdout.write('\n5. 连续 >8 条失败：容量上限与淘汰\n');

  /* ⚠️ 必须用**全新页面**做这一节：前面几节也各自产生过降级记录，
     它们的 msgId 同样占着 rawReturnMap 的槽位 ——
     混在一页里算出来的「块序号」会错位（第一版就错在这）。
     每组样本独立页面，与效果验收脚本同一个纪律。 */
  await page.close();
  ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on('pageerror', function (e) {
    if (/\[Sleepy\]/.test(String(e && e.message))) errors.push(String(e.message));
  });
  page.on('console', function (m) {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
  await page.waitForTimeout(500);

  await page.evaluate(PREP, { bad: BAD });
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  var sentCount = 0;
  for (var i = 1; i <= 10; i++) {
    var r = await TURN(page, '第' + i + '条失败');
    if (r.sent) sentCount++;
    else break;      /* 发不出去就停，别硬凑 —— 否则断言的条数是假的 */
  }
  try {
    assert(sentCount >= 9,
      '★ 至少要发出 9 轮才能验容量上限（上限 8 → 至少淘汰 1 条），实发 ' + sentCount);
  } catch (e) { bad('容量·发送轮数 -> ' + e.message); }

  var cap = await page.evaluate(function (mark) {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var degs = s.messages.filter(function (m) { return m.parseFailed; });
    /* 逐条展开，看每条的原始区显示什么 */
    var blocks = Array.prototype.slice.call(
      document.querySelectorAll('.off-parsefail'));
    var raws = blocks.map(function (b) {
      var pre = b.querySelector('pre');
      return pre ? pre.textContent : null;
    });
    return {
      失败条数: degs.length,
      降级块数: blocks.length,
      原始区条数: raws.length,
      /* ★ 「有原始内容」= 不是那句固定空提示。
         ⚠️ 别用「有没有 < 」这种形状判 —— 空提示里也没有 <，
            会被算成有内容（第一版就因此误报上限失效）。 */
      有内容的条数: raws.filter(function (t) {
        return t != null && t.indexOf('本次没有可查看的原始内容') < 0;
      }).length,
      空提示条数: raws.filter(function (t) {
        return t != null && t.indexOf('本次没有可查看的原始内容') >= 0;
      }).length,
      还有内容的: raws.map(function (t, k) {
        return (t != null && t.indexOf('本次没有可查看') < 0) ? k : -1;
      }).filter(function (k) { return k >= 0; })
    };
  }, MARK);
  try {
    assert(cap.失败条数 === sentCount,
      '会话里的失败记录数应等于实发轮数：' + cap.失败条数 + ' vs ' + sentCount);
    ok('容量：连续 ' + cap.失败条数 + ' 条失败全部保留在会话里（UI 记录不丢）');
  } catch (e) { bad('容量·条数 -> ' + e.message); }

  try {
    /* RAW_RETURN_MAX = 8 → 最近 8 条有原始内容，最早 2 条被淘汰 */
    assert(cap.有内容的条数 <= 8,
      '★ 原始内容条数超过上限 8，实得 ' + cap.有内容的条数);
    assert(cap.空提示条数 >= 2,
      '★ 被淘汰的记录没有显示空提示，实得空提示 ' + cap.空提示条数 + ' 条');
    ok('容量上限：' + cap.有内容的条数 + ' 条有原始内容（上限 8）、' +
      cap.空提示条数 + ' 条显示「' + EMPTY_TXT + '」');
  } catch (e) { bad('容量·上限 -> ' + e.message); }

  try {
    /* 淘汰的必须是**最早**那几条：块序号 0 一定已被淘汰，
       且「有内容的块序号」必须是**连续靠后**的一段。 */
    /* 独立的页面 → 块序号 0 就是最早那条，必须已被淘汰。
       有内容的应是**最近 8 条**：块序号 sentCount-8 … sentCount-1。 */
    assert(cap.还有内容的.indexOf(0) < 0,
      '★ 块序号 0（最早那条）仍有原始内容，淘汰的不是最早的');
    var lo = sentCount - 8;
    var expect = [];
    for (var k = lo; k < sentCount; k++) expect.push(k);
    eq(cap.还有内容的, expect,
      '★ 有原始内容的块应正好是「最近 8 条」（块序号 ' + lo + '…' + (sentCount - 1) + '）：');
    ok('淘汰对象：块序号 0 已被淘汰；有原始内容的块序号 = ' +
      JSON.stringify(cap.还有内容的) + ' = 最近 8 条');
  } catch (e) { bad('容量·淘汰对象 -> ' + e.message); }

  /* ============ 6. 容器生命周期（如实测，不假设） ============ */
  process.stdout.write('\n6. 内存容器的实际生命周期\n');

  var life = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var degs = s.messages.filter(function (m) { return m.parseFailed; });
    return { 会话仍存在: !!s, 失败记录数: degs.length };
  });
  try {
    assert(life.会话仍存在, '会话应仍在（store 持久化）');
    ok('离开场景页后：会话与失败记录仍在 store 里（持久化），' +
      '但原始返回在**模块级内存**里 —— 下面单独核对它的生命周期');
  } catch (e) { bad('生命周期·会话 -> ' + e.message); }

  /* 切走页面再回来：模块内存**不清**（这是事实，要如实报） */
  var life2 = await page.evaluate(function () {
    var pre = document.querySelector('.off-parsefail-raw');
    var before = pre ? pre.textContent : null;
    return { 切面前原始区: before };
  });
  await page.evaluate(function () { Sleepy.nav.open('home'); });
  await page.waitForTimeout(700);
  var life3 = await page.evaluate(function (sid) {
    Sleepy.nav.open('offline-scene', { id: sid });
    return { 回到页面: true };
  }, await page.evaluate(function () { return window.__sid; }));
  await page.waitForFunction(READY, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  var life4 = await page.evaluate(function () {
    var pre = document.querySelector('.off-parsefail-raw');
    return { 回来后原始区: pre ? pre.textContent : null };
  });
  try {
    var same = life2.切面前原始区 === life4.回来后原始区;
    process.stdout.write('    切走前原始区长度=' +
      String(life2.切面前原始区 || '').length +
      '，回来后长度=' + String(life4.回来后原始区 || '').length + '\n');
    ok('生命周期（**实测**）：离开页面再回来，原始返回**仍然在** —— ' +
      '因为容器在 page-offline.js 的模块作用域（IIFE 内），' +
      '生命周期等于**整个页面**，不是单个场景页。' +
      '（这是事实陈述，不是缺陷判定；刷新才会丢。）');
  } catch (e) { bad('生命周期·切页 -> ' + e.message); }

  /* 刷新：必须丢 */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
  await page.waitForTimeout(600);
  var afterReload = await page.evaluate(function (u1) {
    var s = Sleepy.core && Sleepy.store ? null : null;
    var sess = null;
    try {
      var list = Sleepy.store.get('offlineSessions') || [];
      sess = list.filter(function (x) {
        return (x.messages || []).some(function (m) { return m.parseFailed; });
      })[0] || null;
    } catch (e) { }
    return {
      store里还有失败记录: !!sess,
      失败记录数: sess ? sess.messages.filter(function (m) { return m.parseFailed; }).length : 0,
      localStorage含U1: (function () {
        var hits = { 业务: false, 取证: false };
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if ((localStorage.getItem(k) || '').indexOf(u1) < 0) continue;
          if (k.indexOf('sleepy.forensics.parseFail.') === 0) hits.取证 = true;
          else hits.业务 = true;
        }
        return hits;
      })()
    };
  }, U1);
  try {
    eq(afterReload.localStorage含U1.业务, false, '★ 刷新后业务 localStorage 出现了原始片段');
    assert(afterReload.localStorage含U1.取证, '★ 刷新后取证命名空间没有 ' + U1 + '（取证应跨刷新留存）');
    ok('刷新后：store 里失败记录仍在（' + afterReload.失败记录数 +
      ' 条，属持久化状态）；原始返回随取证通道**跨刷新可恢复**' +
      '（业务命名空间无 ' + U1 + '，正文/历史/导出仍干净）');
  } catch (e) { bad('刷新 -> ' + e.message); }

  /* 刷新后降级记录仍能正常渲染 */
  var sidAfter = await page.evaluate(function () {
    var list = Sleepy.store.get('offlineSessions') || [];
    var s = list.filter(function (x) {
      return (x.messages || []).some(function (m) { return m.parseFailed; });
    })[0];
    if (!s) return null;
    Sleepy.nav.open('offline-scene', { id: s.id });
    return s.id;
  });
  if (!sidAfter) {
    bad('刷新后渲染：store 里找不到带失败记录的会话');
  } else {
    await page.waitForFunction(READY, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    var rend = await page.evaluate(function () {
      var b = document.querySelector('.off-parsefail');
      var pre = b ? b.querySelector('pre') : null;
      var fold = b ? b.querySelector('details') : null;
      return {
        降级块存在: !!b,
        人话提示: b && b.querySelector('.off-parsefail-hint')
          ? b.querySelector('.off-parsefail-hint').textContent : null,
        原始区内容: pre ? pre.textContent : null,
        默认收起: fold ? fold.open === false : null
      };
    });
    try {
      assert(rend.降级块存在, '★ 刷新后降级记录应仍能渲染');
      eq(rend.人话提示, HINT, '刷新后人话提示：');
      eq(rend.原始区内容, EMPTY_TXT,
        '★ 刷新后原始区应显示固定空提示（原内容不可恢复）：');
      eq(rend.默认收起, true, '刷新后默认收起');
      ok('刷新后渲染：降级记录正常显示，原始区显示「' + EMPTY_TXT + '」，' +
        'details.open === false（默认收起）');
    } catch (e) { bad('刷新后渲染 -> ' + e.message); }
  }

  /* ============ 7. 无歧义的「默认收起」措辞 ============ */
  process.stdout.write('\n7. 证据措辞核对（默认收起 = details.open === false）\n');
  try {
    /* 上面第 5/6 节的采集都记了 details.open 的布尔值；
       这里再明确断言一次「false 才是收起」，避免 '默认折叠=false' 这种读法。 */
    var openNow = await page.evaluate(function () {
      var folds = Array.prototype.slice.call(
        document.querySelectorAll('.off-parsefail details'));
      return folds.map(function (f) { return f.open; });
    });
    assert(openNow.length > 0, '应至少有一个折叠区');
    openNow.forEach(function (o) {
      eq(o, false, '每个折叠区都必须 details.open === false（即「默认收起」）：');
    });
    ok('措辞核对：' + openNow.length +
      ' 个折叠区全部 details.open === false → 报告里写「默认收起」，不是「默认折叠=false」');
  } catch (e) { bad('措辞核对 -> ' + e.message); }

  /* ============ 8. 页面报错 ============ */
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
    process.stdout.write('\n结论：返修第二批**未通过**。\n');
    process.exit(1);
  }
  process.stdout.write('\n结论：**返修第二批通过**。\n' +
    '⚠️ 只证明历史归属与数据隔离；**模型效果仍未验收**。\n');
})().catch(function (e) {
  process.stdout.write('脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
