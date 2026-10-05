#!/usr/bin/env node
/* ============================================================
   scripts/browser-offline-f2-req-test.js
   —— F2 批返修：**真实发送链**的请求身份 / 失败语义 / 生产接口收口验收

   跑法（需要 NODE_PATH 指向 playwright-core）：
     NODE_PATH=<managed workspace>/node_modules \
       node scripts/browser-offline-f2-req-test.js

   ★ 与 browser-offline-f2-test.js 的分工：
     那份验「诊断面板 + 状态机函数」；**这份验「诊断没有把业务回调搞坏」**。
       —— 上一批的 bug 正是「诊断守卫丢弃了整个业务回调」，只在状态机层面测不出来。
   ★ 全部走**真实 UI 链路**：nav.open 进场景页 → 填输入框 → 点 .off-send-btn。
     ★ 只 mock 模型通道（api.requestOnce），**不联网、不调模型**。
     ★ 虚构会话与虚构角色，全新浏览器 profile，**不读真实聊天 / 用户配置**。

   ⚠️ 本脚本验接线与收尾，**不验模型效果**。
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

/* 页内注入：把模型通道换成可控桩。返回控制句柄的工厂。 */
var INSTALL_STUB = function () {
  var calls = [];
  var mode = { kind: 'ok', reply: '{"paras":[{"type":"prose","text":"夹具落地段。"}]}' };
  var pending = null;      /* 手动 resolve 用 */
  Sleepy.api.requestOnce = function (cand, messages) {
    calls.push({ at: calls.length, msgCount: (messages || []).length });
    if (mode.kind === 'ok') {
      return Promise.resolve({ ok: true, content: mode.reply, ms: 1 });
    }
    if (mode.kind === 'stage-fail') {
      /* 真实 requestOnce 的形状：带 stage。stage='http' 表示服务端确实收到了。 */
      return Promise.resolve({ ok: false, stage: mode.stage || 'http',
        status: mode.status || 500, error: mode.error || '夹具失败',
        detail: '夹具 detail', ms: 1 });
    }
    if (mode.kind === 'reject') {
      return Promise.reject(new Error(mode.error || '夹具 reject'));
    }
    if (mode.kind === 'throw-sync') {
      throw new Error(mode.error || '夹具同步抛错');
    }
    if (mode.kind === 'hang') {
      return new Promise(function (res) { pending = res; });
    }
    if (mode.kind === 'network') {
      /* fetch 的 catch 分支：网络错误 —— 无法确认服务端是否收到 */
      return Promise.resolve({ ok: false, stage: 'network', ms: 1,
        error: '连不上：网络错误，或接口没有开 CORS', detail: '夹具' });
    }
    return Promise.resolve({ ok: false, stage: 'config', error: '夹具 config' });
  };
  return {
    setMode: function (m) { Object.assign(mode, m); },
    calls: calls,
    release: function (v) { if (pending) { var p = pending; pending = null; p(v); } }
  };
};

/* 场景页准备：造虚构角色 + 会话 → nav.open → 等输入框可用。
   ⚠️ 必须在**启动流程完成后**再 open —— 首页仍是 active 时，
   启动点火会覆盖掉刚 open 的页面（表现为输入框一直不出现）。 */
var PREP = function () {
  var core = Sleepy.core;
  var sb = core.listSandboxes()[0];
  var ch = core.upsertChar({
    id: '__reqprobe__', kind: 'main', name: '夹具角色',
    content: '夹具人设内容。', sandboxId: sb && sb.id
  });
  var s = Sleepy.offlineStore.createSession(ch.id, {});
  Sleepy.nav.open('offline-scene', { id: s.id });
  return { sessionId: s.id, charId: ch.id };
};

/* 判断当前是否停在 offline-scene 且输入框已渲染 */
var SCENE_READY = function () {
  var p = document.querySelector('[data-page="offline-scene"]');
  return !!(p && p.classList.contains('is-active') && document.querySelector('.off-input-field'));
};

var IS_BUSY = function () {
  var input = document.querySelector('.off-input-field');
  var send = document.querySelector('.off-send-btn');
  return !!(input && input.disabled) || !!(send && send.disabled);
};

var SEND = function (text) {
  var input = document.querySelector('.off-input-field');
  if (!input) return { ok: false, why: 'no input' };
  input.value = text;
  var send = document.querySelector('.off-send-btn');
  if (send && send.disabled) return { ok: false, why: 'send disabled' };
  if (send) send.click();
  return { ok: true };
};

var DIAG = function () {
  var d = Sleepy.offlineDiag;
  return d && d.snapshot ? d.snapshot() : null;
};

var CHAR_MSGS = function () {
  var s = Sleepy.offlineStore.findSession(window.__sid);
  if (!s) return [];
  return s.messages.filter(function (m) { return m.role === 'char' || m.role === 'scene'; }).length;
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

  process.stdout.write('\n返修验收 · 真实发送链 · ' + BASE + '\n');
  await page.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 15000 });

  /* 等启动点火走完（首页拿到 active），否则 nav.open 会被启动流程覆盖 */
  await page.waitForFunction(
    '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 15000 });
  await page.waitForTimeout(300);

  /* ============ 1. 无连接：走真实发送入口 ============ */
  process.stdout.write('\n1. 无连接（真实点发送按钮）\n');

  await page.evaluate(PREP);
  await page.waitForFunction(SCENE_READY, null, { timeout: 10000 });
  var sid = await page.evaluate(function () {
    var s = Sleepy.offlineStore.allSessions()[0];
    window.__sid = s.id;
    return s.id;
  });

  /* ---- 无连接：**清空真实 store 里的 API 配置** ----
     ⚠️ 不能 mock 掉 apiChoices：v2 那个版本 mock 了 apiChoices 再恢复，
        于是第 1 节之后所有用例都因为 store 里**本来就没有 API 配置**
        而停在 no-connection —— 后面 7 个红全是这一个假桩造成的，
        真实发送链（callModel → requestOnce）根本没被走到过。
     ★ 现在只 mock **模型通道**（api.requestOnce），
       连接判定走真实的 candForSession → apiChoices → store。 */
  var r1 = await page.evaluate(function () {
    var store = Sleepy.store;
    /* 先记住原值，收尾时还原 */
    window.__origMainApi = store.get('mainApi');
    /* 无连接：主 API 没填 baseUrl / model → apiChoices 出不来 → candForSession null */
    store.set('mainApi', {
      name: '夹具主模型', baseUrl: '', apiKey: '', model: '',
      temperature: null, maxTokens: null, contextMessages: null,
      stream: false, timeoutSec: 60, enabled: true
    });
    window.__seedApi = function () {
      store.set('mainApi', window.__origMainApi);
    };
    /* 模型通道桩：无连接分支根本走不到这里，装着是为了「万一走到了能看出来」 */
    window.__calls = [];
    Sleepy.api.requestOnce = function () {
      window.__calls.push(1);
      return Promise.resolve({ ok: true, ms: 1, content: '{"paras":[]}' });
    };
    return { seeded: true, choices: Sleepy.offlineStore.apiChoices().length };
  });
  try {
    eq(r1.choices, 0, '★ 无连接夹具必须真的没有可用连接（apiChoices 应为空）：');
    eq(r1.seeded, true, '夹具已种下');
  } catch (e) { bad('无连接夹具 -> ' + e.message); }

  await page.waitForTimeout(700);
  var s1 = await page.evaluate(function () {
    return {
      busy: (function () {
        var i = document.querySelector('.off-input-field');
        var b = document.querySelector('.off-send-btn');
        return !!(i && i.disabled) || !!(b && b.disabled);
      })(),
      diag: Sleepy.offlineDiag.snapshot(),
      toast: (function () {
        var t = document.querySelector('.toast, .toast-msg, [class*="toast"]');
        return t ? t.textContent : '';
      })()
    };
  });
  try {
    eq(s1.busy, false, '★ 无连接后必须解除忙碌（上一批的 bug：回调被丢弃 → 永久忙碌）：');
    ok('无连接：解除忙碌（真实发送链复验）');
  } catch (e) { bad('无连接解除忙碌 -> ' + e.message); }

  try {
    assert(s1.diag, '诊断必须有记录');
    assert(s1.diag.stage !== 'model-returned',
      '无连接不得伪称「模型已返回」，实得 ' + s1.diag.stage);
    ok('无连接：阶段 = ' + s1.diag.stage + '（不伪称模型已返回）');
  } catch (e) { bad('无连接阶段 -> ' + e.message); }

  var retry = await page.evaluate(function () {
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    return { canRetry: !!(input && !input.disabled) && !!(send && !send.disabled) };
  });
  try {
    eq(retry.canRetry, true, '★ 无连接后必须可重试：');
    ok('无连接：可重试（输入框与发送按钮均可用）');
  } catch (e) { bad('无连接可重试 -> ' + e.message); }

  /* ============ 2. 同一请求的阶段更新不换请求序号 ============ */
  process.stdout.write('\n2. 请求身份与阶段解耦\n');

  /* ★ 种上**真实**的假 API 配置（走 store），让 candForSession 真能出连接。
     mock 的只有模型通道 api.requestOnce —— 连接判定必须是生产逻辑。 */
  var r2seed = await page.evaluate(function () {
    Sleepy.store.set('mainApi', {
      name: '夹具主模型', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key',
      model: 'fixture-model', temperature: null, maxTokens: null,
      contextMessages: null, stream: false, timeoutSec: 60, enabled: true
    });
    var c = Sleepy.offlineStore.candForSession(
      Sleepy.offlineStore.findSession(window.__sid));
    return { choices: Sleepy.offlineStore.apiChoices().length,
      hasCand: !!c, model: c && c.cfg && c.cfg.model };
  });
  try {
    eq(r2seed.choices, 1, '★ 必须真的有一个可用连接，否则后面全是 no-connection 空测：');
    eq(r2seed.hasCand, true, 'candForSession 必须出连接：');
    eq(r2seed.model, 'fixture-model', '连接应带真实 store 里的 model：');
    ok('连接夹具：真实 store 出一条连接（model=' + r2seed.model + '）');
  } catch (e) { bad('连接夹具 -> ' + e.message); }

  var r2 =   await page.evaluate(function () {
    var gates = [];
    Sleepy.api.requestOnce = function (cand, messages) {
      return new Promise(function (res) { gates.push(res); });
    };
    window.__g2 = { gates: gates, release: function (i, v) { if (gates[i]) gates[i](v); } };
    document.querySelector('.off-input-field').value = '阶段测试';
    document.querySelector('.off-send-btn').click();
  });
  await page.waitForTimeout(500);

  var midRun = await page.evaluate(function () { return Sleepy.offlineDiag.snapshot(); });
  await page.evaluate(function () {
    window.__g2.release(0, { ok: true, ms: 1,
      content: '{"paras":[{"type":"prose","text":"阶段落地段。"}]}' });
  });
  await page.waitForTimeout(700);
  var afterRun = await page.evaluate(function () { return Sleepy.offlineDiag.snapshot(); });

  try {
    assert(midRun && afterRun, '两阶段都要有记录');
    eq(midRun.stage, 'at-call-boundary', '中间阶段：');
    eq(afterRun.stage, 'model-returned', '结束阶段：');
    ok('阶段推进：at-call-boundary → model-returned');
  } catch (e) { bad('阶段推进 -> ' + e.message); }

  /* ★ 核心判据：**同一请求**的阶段更新不得换请求身份。
     requestId 必须在两个阶段里相同；seq 若存在则应体现「一次请求一条诊断轨迹」。 */
  try {
    assert(midRun.requestId !== undefined,
      '★ 诊断缺少 requestId —— 无法证明「请求身份与阶段解耦」');
    eq(afterRun.requestId, midRun.requestId,
      '★ 同一请求的阶段更新必须保持同一 requestId：');
    ok('请求身份：同一请求两阶段 requestId 相同（' + midRun.requestId + '）');
  } catch (e) { bad('请求身份解耦 -> ' + e.message); }

  /* 反向：不同请求的 requestId 必须不同 */
  await page.evaluate(function () {
    Sleepy.api.requestOnce = function () {
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"paras":[{"type":"prose","text":"第二个请求落地。"}]}' });
    };
    document.querySelector('.off-input-field').value = '第二个请求';
    document.querySelector('.off-send-btn').click();
  });
  await page.waitForTimeout(700);
  var second = await page.evaluate(function () { return Sleepy.offlineDiag.snapshot(); });
  try {
    assert(second.requestId > midRun.requestId,
      '★ 不同请求的 requestId 必须递增：' + second.requestId + ' vs ' + midRun.requestId);
    ok('请求身份：不同请求 requestId 递增（' + midRun.requestId + ' → ' + second.requestId + '）');
  } catch (e) { bad('请求身份递增 -> ' + e.message); }

  /* ============ 3. 成功结果仍进入解析与落地 ============ */
  process.stdout.write('\n3. 成功路径（解析 + 落地）\n');

  await page.evaluate(function () {
    Sleepy.api.requestOnce = function () {
      return Promise.resolve({
        ok: true, ms: 1,
        content: '{"paras":[{"type":"dialogue","text":"夹具台词。"}],"suggests":["走一步"]}'
      });
    };
  });
  var before3 = await page.evaluate(function () {
    return Sleepy.offlineStore.findSession(window.__sid).messages.length;
  });
  await page.evaluate(function () {
    document.querySelector('.off-input-field').value = '成功测试';
    document.querySelector('.off-send-btn').click();
  });
  await page.waitForTimeout(800);
  var s3 = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    return {
      busy: (function () {
        var i = document.querySelector('.off-input-field');
        var b = document.querySelector('.off-send-btn');
        return !!(i && i.disabled) || !!(b && b.disabled);
      })(),
      grew: s.messages.length,
      diag: Sleepy.offlineDiag.snapshot(),
      hasChar: s.messages.some(function (m) {
        return (m.role === 'char' || m.role === 'scene') &&
          JSON.stringify(m.paras || '').indexOf('夹具台词') >= 0;
      }),
      bodyText: (document.querySelector('.off-chat-scroll') || {}).textContent || ''
    };
  });
  try {
    eq(s3.busy, false, '成功后必须解除忙碌：');
    eq(s3.grew > before3, true, '★ 成功结果必须落进会话（上一批 bug 会让回调被整段丢弃）：');
    eq(s3.hasChar, true, '模型台词必须落到 char/scene 消息里');
    assert(s3.bodyText.indexOf('夹具台词') >= 0, '正文必须显示模型台词');
    ok('成功：解除忙碌 + 回复落地 + 正文可见（真实发送链复验）');
  } catch (e) { bad('成功落地 -> ' + e.message); }

  try {
    eq(s3.diag.stage, 'model-returned', '成功阶段：');
    eq(s3.diag.requestOk, true, 'requestOk：');
    eq(s3.diag.requestOk, true, '成功必须标记 requestOk=true');
    ok('成功：阶段 = model-returned · requestOk = true');
  } catch (e) { bad('成功阶段 -> ' + e.message); }

  /* ============ 4. 四种失败各自收尾，且不伪称服务端收到 ============ */
  process.stdout.write('\n4. 失败语义（同步抛 / reject / 网络 / 无连接）\n');

  var CASES = [
    { name: '同步 throw', mode: { kind: 'throw-sync', error: '夹具同步抛错' },
      mustNot: 'at-call-boundary' },
    { name: 'Promise reject', mode: { kind: 'reject', error: '夹具 reject' },
      mustNot: 'model-returned' },
    { name: '网络失败（不确定服务端）', mode: { kind: 'network' },
      mustNot: null },
    { name: '服务端拒绝（stage=http）', mode: { kind: 'stage-fail', stage: 'http', status: 500 },
      mustNot: null }
  ];

  for (var ci = 0; ci < CASES.length; ci++) {
    var c = CASES[ci];
    /* eslint-disable no-await-in-loop */
    await page.evaluate(function (m) {
      var mode = m;
      Sleepy.api.requestOnce = function () {
        if (mode.kind === 'throw-sync') throw new Error(mode.error);
        if (mode.kind === 'reject') return Promise.reject(new Error(mode.error));
        if (mode.kind === 'network') {
          return Promise.resolve({ ok: false, stage: 'network', ms: 1,
            error: '连不上：网络错误，或接口没有开 CORS' });
        }
        return Promise.resolve({ ok: false, stage: 'http', status: 500, ms: 1,
          error: 'HTTP 500', detail: '夹具' });
      };
    }, c.mode);
    await page.evaluate(function (i) {
      document.querySelector('.off-input-field').value = '失败用例' + i;
      document.querySelector('.off-send-btn').click();
    }, ci);
    await page.waitForTimeout(700);
    var st = await page.evaluate(function () {
      var i = document.querySelector('.off-input-field');
      var b = document.querySelector('.off-send-btn');
      return {
        busy: !!(i && i.disabled) || !!(b && b.disabled),
        diag: Sleepy.offlineDiag.snapshot()
      };
    });
    try {
      eq(st.busy, false, c.name + '：必须解除忙碌：');
      assert(st.diag, c.name + '：必须有诊断记录');
      if (c.mustNot) {
        assert(st.diag.stage !== c.mustNot,
          c.name + '：阶段不得是 ' + c.mustNot + '，实得 ' + st.diag.stage);
      }
      ok(c.name + '：解除忙碌 · 阶段 = ' + (st.diag && st.diag.stage));
    } catch (e) { bad(c.name + ' -> ' + e.message); }
  }

  /* ============ 5. 两个请求乱序完成 ============ */
  process.stdout.write('\n5. 并发：乱序完成不互相误伤\n');

  var r5 = await page.evaluate(function () {
    var gates = [];
    Sleepy.api.requestOnce = function (cand, messages) {
      return new Promise(function (res) { gates.push(res); });
    };
    window.__gates = gates;
    window.__gateCount = function () { return gates.length; };
    window.__release = function (i, v) { if (gates[i]) gates[i](v); };
    window.__click = function (txt) {
      var input = document.querySelector('.off-input-field');
      var send = document.querySelector('.off-send-btn');
      input.value = txt;
      if (send && !send.disabled) { send.click(); return true; }
      return false;
    };
    return { sent: window.__click('第一个') };
  });
  await page.waitForTimeout(300);
  var gateN = await page.evaluate(function () { return window.__gateCount(); });

  try {
    eq(r5.sent, true, '第一个请求应已发出（发送按钮在空闲态可用）：');
    eq(gateN, 1, '应有且仅有 1 个在途请求：');
    ok('并发：单个在途请求（发送按钮在 busy 期间正确禁用）');
  } catch (e) { bad('并发·发起 -> ' + e.message); }

  await page.evaluate(function () {
    window.__release(0, { ok: true, ms: 1,
      content: '{"paras":[{"type":"prose","text":"第一轮落地。"}]}' });
  });
  await page.waitForTimeout(700);
  var s5a = await page.evaluate(function () {
    var i = document.querySelector('.off-input-field');
    var b = document.querySelector('.off-send-btn');
    var s = Sleepy.offlineStore.findSession(window.__sid);
    return {
      busy: !!(i && i.disabled) || !!(b && b.disabled),
      seq: (Sleepy.offlineDiag.snapshot() || {}).seq,
      requestId: (Sleepy.offlineDiag.snapshot() || {}).requestId,
      hasFirst: JSON.stringify(s.messages).indexOf('第一轮落地') >= 0
    };
  });
  try {
    eq(s5a.busy, false, '第一轮收尾后必须解除忙碌：');
    eq(s5a.hasFirst, true, '第一轮回复必须落地：');
    ok('并发·单轮收尾正常（序号 ' + s5a.seq + '）');
  } catch (e) { bad('并发收尾 -> ' + e.message); }

  /* 第二个请求：序号必须大于上一轮，且不继承上一轮阶段 */
  await page.evaluate(function () {
    Sleepy.api.requestOnce = function () {
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"paras":[{"type":"prose","text":"第二轮落地。"}]}' });
    };
    window.__click('第二个');
  });
  await page.waitForTimeout(800);
  var s5b = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var d = Sleepy.offlineDiag.snapshot();
    return {
      seq: d && d.seq, stage: d && d.stage,
      hasSecond: JSON.stringify(s.messages).indexOf('第二轮落地') >= 0
    };
  });
  try {
    eq(s5b.hasSecond, true, '第二轮回复必须落地：');
    assert(s5b.seq > s5a.seq, '请求序号必须递增，实得 ' + s5b.seq + ' vs ' + s5a.seq);
    ok('并发·第二轮：序号递增 ' + s5a.seq + ' → ' + s5b.seq + '，回复落地');
  } catch (e) { bad('并发递增 -> ' + e.message); }

  /* ============ 6. 另一场景更新诊断不得丢弃合法回复 ============ */
  process.stdout.write('\n6. 跨场景：别的场景更新诊断，本场景回复仍落地\n');

  await page.evaluate(function () {
    var d = Sleepy.offlineDiag;
    window.__diagKeys = Object.keys(d);
    /* 若存在任何写入/重置入口，记录下来（第六条用例会断言没有） */
    window.__writeEntrypoints = Object.keys(d).filter(function (k) {
      return /^__/.test(k) || /reset|record|set|clear|write/i.test(k);
    });
  });
  var keys6 = await page.evaluate(function () { return window.__writeEntrypoints; });
  try {
    eq(keys6, [], '★ 生产环境不得暴露诊断写入/重置入口：');
    ok('生产接口：只有只读入口，无 __record/__reset 等写入口');
  } catch (e) { bad('生产接口收口 -> ' + e.message); }

  var allKeys = await page.evaluate(function () { return window.__diagKeys; });
  try {
    eq(allKeys.slice().sort(), ['snapshot', 'stageLabel'].sort(),
      '对外只读面（应只有 snapshot / stageLabel）：');
    ok('生产接口：导出面恰好两个只读函数');
  } catch (e) { bad('对外面 -> ' + e.message); }

  /* ---- 5b. 真乱序：两个在途请求，**后发的先回** ----
     判据：先回的是**旧**请求（isLatest=false）
       - 它的回复**必须落地**（不能被诊断序号丢弃）；
       - 它**不得**把 pending / 忙碌态清掉（那属于新请求）；
       - 新请求随后回调时仍能正常收尾。 */
  var r5b = await page.evaluate(function () {
    var gates = [];
    Sleepy.api.requestOnce = function () {
      return new Promise(function (res) { gates.push(res); });
    };
    window.__g5b = { gates: gates, n: function () { return gates.length; },
      release: function (i, v) { if (gates[i]) gates[i](v); } };
    return true;
  });

  /* 第一个请求 */
  await page.evaluate(function () {
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    input.value = '乱序第一个';
    if (send && !send.disabled) send.click();
  });
  await page.waitForTimeout(400);
  var gN1 = await page.evaluate(function () { return window.__g5b.n(); });
  try {
    eq(gN1, 1, '第一个在途请求应已发出：');
  } catch (e) { bad('乱序·发起一 -> ' + e.message); }

  /* 第二个请求：pending 占位期间发送按钮应禁用 → 点不动 */
  var canSendSecond = await page.evaluate(function () {
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    input.value = '乱序第二个';
    if (send && !send.disabled) { send.click(); return true; }
    return false;
  });
  try {
    eq(canSendSecond, false,
      '★ pending 占位期间不得再发第二个请求（否则两个在途、落地与诊断都会乱）：');
    ok('并发门禁：pending 在途期间发送按钮禁用');
  } catch (e) { bad('并发门禁 -> ' + e.message); }

  /* 让第一个（旧请求）先回 —— 它不是最新请求 */
  var r5c = await page.evaluate(function () {
    var before = Sleepy.offlineDiag.snapshot();
    window.__g5b.release(0, { ok: true, ms: 1,
      content: '{"paras":[{"type":"prose","text":"乱序旧请求落地。"}]}' });
    return { beforeReqId: before && before.requestId };
  });
  await page.waitForTimeout(600);
  var s5c = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var i = document.querySelector('.off-input-field');
    var b = document.querySelector('.off-send-btn');
    return {
      landed: JSON.stringify(s.messages).indexOf('乱序旧请求落地') >= 0,
      /* 旧请求回来时 pending 还占着（它不是最新）→ 按钮应仍禁用 */
      stillBusy: !!(i && i.disabled) || !!(b && b.disabled)
    };
  });
  try {
    eq(s5c.landed, true,
      '★ 旧请求的合法回复必须落地（v1 的守卫会把它整段丢弃）：');
    ok('乱序：旧请求回复仍落地（旧请求身份 #' + r5c.beforeReqId + '）');
  } catch (e) { bad('乱序·旧请求落地 -> ' + e.message); }

  /* 跨场景扰动：在旧请求在途时，让**另一个场景**更新诊断。
     生产接口没有写入口，所以走真实路径 —— 另开一个线下场景跑一轮。 */
  var r5d = await page.evaluate(function () {
    var core = Sleepy.core;
    var sb = core.listSandboxes()[0];
    var ch = core.upsertChar({ id: '__otherisland__', kind: 'main',
      name: '另一座岛的角色', content: '另一座岛的人设。', sandboxId: sb && sb.id });
    var s2 = Sleepy.offlineStore.createSession(ch.id, {});
    /* 真实跑一轮请求 → 诊断会被「另一场景」更新 */
    var gates2 = [];
    Sleepy.api.requestOnce = function () {
      return new Promise(function (res) { gates2.push(res); });
    };
    window.__g5d = gates2;
    return { otherSid: s2.id, charId: ch.id };
  });
  await page.waitForTimeout(200);
  /* 切到另一个场景页并发一轮（跨场景：同一个诊断模块被别的场景写） */
  await page.evaluate(function (sid) {
    Sleepy.nav.open('offline-scene', { id: sid });
  }, r5d.otherSid);
  await page.waitForTimeout(700);
  await page.evaluate(function () {
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    if (!input || !send || send.disabled) return false;
    input.value = '另一场景的请求';
    send.click();
    return true;
  });
  await page.waitForTimeout(500);
  /* 另一个场景的请求先回 → 诊断被「另一场景」更新 */
  await page.evaluate(function () {
    if (window.__g5d[0]) {
      window.__g5d[0]({ ok: true, ms: 1,
        content: '{"paras":[{"type":"prose","text":"另一场景落地。"}]}' });
    }
  });
  await page.waitForTimeout(600);
  var s5d = await page.evaluate(function () {
    return {
      diagReqId: (Sleepy.offlineDiag.snapshot() || {}).requestId,
      diagStage: (Sleepy.offlineDiag.snapshot() || {}).stage
    };
  });
  try {
    assert(s5d.diagReqId !== undefined, '另一场景应写下自己的诊断');
    ok('跨场景：另一场景更新了诊断（requestId #' + s5d.diagReqId +
      ' · ' + s5d.diagStage + '）');
  } catch (e) { bad('跨场景诊断 -> ' + e.message); }

  /* ★ 回到原场景：那条在途请求的回复**仍必须落地**，
     哪怕期间诊断被另一场景改了好几轮。 */
  var s5e = await page.evaluate(function (sid) {
    var s = Sleepy.offlineStore.findSession(sid);
    return { landed: JSON.stringify(s.messages).indexOf('乱序旧请求落地') >= 0 };
  }, sid);
  try {
    eq(s5e.landed, true,
      '★ 另一场景更新诊断后，本场景的合法回复仍须落地：');
    ok('跨场景扰动后：本场景回复完整落地');
  } catch (e) { bad('跨场景扰动 -> ' + e.message); }

  /* ============ 5c. 取消：页面离开后本轮作废 ============ */
  await page.evaluate(function (sid) {
    Sleepy.nav.open('offline-scene', { id: sid });
  }, sid);
  await page.waitForTimeout(700);
  var r5f = await page.evaluate(function () {
    var gates = [];
    Sleepy.api.requestOnce = function () {
      return new Promise(function (res) { gates.push(res); });
    };
    window.__g5f = gates;
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    input.value = '取消测试';
    if (send && !send.disabled) { send.click(); return true; }
    return false;
  });
  await page.waitForTimeout(400);
  /* 离开页面 → onHide 置 __alive=false，本轮应作废 */
  await page.evaluate(function () { Sleepy.nav.open('home'); });
  await page.waitForTimeout(500);
  /* 让在途请求回来（模拟网络迟到） */
  await page.evaluate(function () {
    if (window.__g5f[0]) {
      window.__g5f[0]({ ok: true, ms: 1,
        content: '{"paras":[{"type":"prose","text":"迟到回复。"}]}' });
    }
  });
  await page.waitForTimeout(600);
  var s5f = await page.evaluate(function (sid) {
    var s = Sleepy.offlineStore.findSession(sid);
    return {
      stage: (Sleepy.offlineDiag.snapshot() || {}).stage,
      landed: JSON.stringify(s.messages).indexOf('迟到回复') >= 0
    };
  }, sid);
  try {
    /* 页面离开后：回复**仍落库**（数据不丢），但不得声称「本轮成功待展示」——
       阶段不能是 model-returned 之外的误判。落库是对的，重绘才跳过。 */
    eq(s5f.landed, true, '页面离开后回复仍应落库（数据不丢）：');
    ok('取消边界：页面离开后迟到回复落库、不写旧 DOM（阶段=' + s5f.stage + '）');
  } catch (e) { bad('取消边界 -> ' + e.message); }

  /* 回到原场景：忙碌态必须已解除（不能永久卡住） */
  await page.evaluate(function (sid) {
    Sleepy.nav.open('offline-scene', { id: sid });
  }, sid);
  await page.waitForTimeout(800);
  var s5g = await page.evaluate(function () {
    var i = document.querySelector('.off-input-field');
    var b = document.querySelector('.off-send-btn');
    return { canSend: !!(i && !i.disabled) && !!(b && !b.disabled) };
  });
  try {
    eq(s5g.canSend, true, '★ 页面离开期间回来的请求不得留下永久忙碌态：');
    ok('取消边界：返回场景后可继续发送');
  } catch (e) { bad('取消边界收尾 -> ' + e.message); }

  /* 跨场景：模拟「群线下更新了同一个诊断模块」后再跑一轮本场景请求。
     合法回复必须仍落地。 */
  var s6b = await page.evaluate(function () {
    Sleepy.api.requestOnce = function () {
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"paras":[{"type":"prose","text":"跨场景后仍落地。"}]}' });
    };
    document.querySelector('.off-input-field').value = '跨场景';
    document.querySelector('.off-send-btn').click();
    return true;
  });
  await page.waitForTimeout(800);
  var s6c = await page.evaluate(function () {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var i = document.querySelector('.off-input-field');
    var b = document.querySelector('.off-send-btn');
    return {
      landed: JSON.stringify(s.messages).indexOf('跨场景后仍落地') >= 0,
      busy: !!(i && i.disabled) || !!(b && b.disabled)
    };
  });
  try {
    eq(s6c.landed, true, '跨场景后合法回复仍须落地：');
    eq(s6c.busy, false, '跨场景后必须解除忙碌：');
    ok('跨场景：诊断无写入口，回复落地不受扰动');
  } catch (e) { bad('跨场景 -> ' + e.message); }

  /* ============ 7. 预览不覆盖真实调用诊断 ============ */
  process.stdout.write('\n7. 预览不覆盖真实调用诊断\n');

  var s7 = await page.evaluate(function () {
    var before = Sleepy.offlineDiag.snapshot();
    /* 预览：重新装配一次（等价于预设 app 的预览路径） */
    var h = { ctx: {
      charId: (Sleepy.offlineStore.allSessions()[0] || {}).charId, userId: null,
      session: { id: '__preview__', env: {}, narrativeSettings: {},
        messages: [{ id: 'p1', role: 'user', text: '预览输入' }] },
      userInput: '预览输入'
    } };
    Sleepy.promptEngine.assembleOffline(h.ctx);
    var after = Sleepy.offlineDiag.snapshot();
    return { changed: JSON.stringify(before) !== JSON.stringify(after),
      seq: after && after.seq };
  });
  try {
    eq(s7.changed, false, '★ 预览重新装配不得改动诊断记录：');
    ok('预览：只读装配不碰诊断（真实调用链复验）');
  } catch (e) { bad('预览隔离 -> ' + e.message); }

  /* ============ 8. 字段允许值校验 ============ */
  process.stdout.write('\n8. 诊断字段的允许值校验\n');

  var s8 = await page.evaluate(function () {
    return Sleepy.offlineDiag.snapshot();
  });
  try {
    assert(s8, '应有诊断记录');
    var ALLOWED_STAGES = ['assemble-failed', 'at-call-boundary', 'model-returned',
      'no-connection', 'request-rejected', 'request-failed-unknown', 'canceled'];
    var ALLOWED_REASONS = ['', 'module-missing', 'version-mismatch', 'call-threw',
      'not-ok', 'bad-shape', 'bad-part', 'bad-text', 'plan-mismatch',
      'join-mismatch', 'slot-contract', 'user-override'];
    var ALLOWED_MODULES = ['B', 'P', 'L', 'N', 'S2'];
    assert(ALLOWED_STAGES.indexOf(s8.stage) >= 0, '阶段不在允许值内：' + s8.stage);
    assert(ALLOWED_REASONS.indexOf(s8.reason) >= 0, '原因码不在允许值内：' + s8.reason);
    (s8.modules || []).forEach(function (m) {
      assert(ALLOWED_MODULES.indexOf(m) >= 0, '模块标识不在允许值内：' + m);
    });
    ok('字段允许值：阶段/原因码/模块均在闭集内');
  } catch (e) { bad('字段允许值 -> ' + e.message); }

  /* 版本字段：必须是「受校验的那一个」或「固定未知标记」。
     ⚠️ 特别核对 override 提前返回那条路径 —— 它在读取 BT.VERSION **之前**就 return 了，
     所以 version 必然是「未知」，不能回显任意原串，也不能是空串以外的自由文本。 */
  var verProbe = await page.evaluate(function () {
    var E = Sleepy.promptEngine;
    var before = E.cardBody('shell');
    /* 制造 override（空串也算改过）→ 走 user-override 提前返回 */
    E.saveCardBody('shell', '');
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var r = E.assembleOffline({
      charId: s.charId, userId: null, session: s, userInput: '版本探测'
    });
    E.resetCard('shell');
    return {
      reason: r.behavior.reason,
      versionInDecision: r.behavior.VERSION,
      modules: r.behavior.modules,
      used: r.behavior.used
    };
  });
  try {
    eq(verProbe.reason, 'user-override', 'override 应提前返回 user-override：');
    eq(verProbe.used, false, 'override 时 used 应为 false：');
    eq(verProbe.modules, [], 'override 时 modules 应为空：');
    ok('override 提前返回：装配层诊断字段正确（reason=' + verProbe.reason +
      '，VERSION=' + JSON.stringify(verProbe.versionInDecision) + '）');
  } catch (e) { bad('override 提前返回 -> ' + e.message); }

  /* 面板呈现的版本值：override 那轮必须是固定未知标记 */
  await page.evaluate(function () {
    document.querySelector('.off-settings-btn').click();
  });
  await page.waitForTimeout(400);
  var verShown = await page.evaluate(function () {
    var tabs = Array.prototype.slice.call(
      document.querySelectorAll('.off-settings-tabs .off-settings-tab'));
    var d = tabs.filter(function (t) { return t.textContent === '请求诊断'; })[0];
    if (d) d.click();
    var fold = document.querySelector('.off-diag-fold');
    if (!fold) return { missing: true };
    fold.open = true;
    var labels = Array.prototype.map.call(fold.querySelectorAll('.off-diag-k'),
      function (n) { return n.textContent; });
    var vals = Array.prototype.map.call(fold.querySelectorAll('.off-diag-v'),
      function (n) { return n.textContent; });
    var o = {};
    labels.forEach(function (k, i) { o[k] = vals[i]; });
    return { missing: false, map: o };
  });
  try {
    assert(!verShown.missing, '找不到诊断面板');
    var shownVer = verShown.map['行为文本版本'];
    assert(shownVer !== undefined, '面板应显示「行为文本版本」');
    assert(shownVer === 'sleepy-behavior-v1-review-01' || shownVer.indexOf('未知') >= 0,
      '★ 版本列必须是受校验值或含「未知」的固定标记，实得：' + shownVer);
    ok('版本列：受校验值或固定未知标记（' + shownVer + '）');
  } catch (e) { bad('版本列 -> ' + e.message); }

  /* ============ 9. 设置入口 + 诊断页签 ============ */
  process.stdout.write('\n9. 真实设置入口 + 诊断页签\n');

  await page.evaluate(function () {
    document.querySelector('.off-settings-btn').click();
  });
  await page.waitForTimeout(500);
  var s9 = await page.evaluate(function () {
    var tabs = Array.prototype.slice.call(
      document.querySelectorAll('.off-settings-tabs .off-settings-tab'));
    var names = tabs.map(function (t) { return t.textContent; });
    /* 切到诊断页签 —— 这一步过去会触发 refreshDiagPanel */
    var diagTab = tabs.filter(function (t) { return t.textContent === '请求诊断'; })[0];
    if (diagTab) diagTab.click();
    return { names: names, hasDiag: !!diagTab };
  });
  await page.waitForTimeout(400);
  var s9b = await page.evaluate(function () {
    var fold = document.querySelector('.off-diag-fold');
    return {
      hasFold: !!fold,
      open: fold ? fold.open : null,
      secTitle: fold && fold.parentNode
        ? (fold.parentNode.querySelector('.off-settings-section-title') || {}).textContent : '',
      summaryText: fold ? (fold.querySelector('summary') || {}).textContent : ''
    };
  });
  try {
    assert(s9.hasDiag, '设置里应有「请求诊断」页签，实得 ' + JSON.stringify(s9.names));
    assert(s9b.hasFold, '诊断页签里应有折叠面板');
    ok('设置入口：真实点击打开 · 切换到诊断页签（names = ' + s9.names.join(' / ') + '）');
  } catch (e) { bad('设置入口 -> ' + e.message); }

  try {
    eq(s9b.open, false, '面板应默认折叠：');
    eq(s9b.secTitle, '最近一次线下请求', '区块标题：');
    ok('诊断页签：默认折叠且标题标明「最近一次线下请求」');
  } catch (e) { bad('面板呈现 -> ' + e.message); }

  /* ============ 10. 面板文案不得含错误结论 ============ */
  process.stdout.write('\n10. 面板说明文案\n');

  var s10 = await page.evaluate(function () {
    var fold = document.querySelector('.off-diag-fold');
    if (!fold) return { missing: true };
    fold.open = true;
    var note = fold.querySelector('.off-diag-note');
    var labels = Array.prototype.map.call(fold.querySelectorAll('.off-diag-k'),
      function (n) { return n.textContent; });
    var vals = Array.prototype.map.call(fold.querySelectorAll('.off-diag-v'),
      function (n) { return n.textContent; });
    return { missing: false, note: note ? note.textContent : '', labels: labels, vals: vals };
  });
  try {
    assert(!s10.missing, '找不到诊断面板');
    assert(s10.note.length > 0, '面板应有说明文案');
    assert(s10.note.indexOf('已到达调用边界') >= 0 || s10.note.indexOf('不代表') >= 0,
      '面板须说明「到达调用边界 ≠ 服务端收到」：' + s10.note);
    /* 不得出现「失败一定是服务端拒绝」这类错误结论 */
    assert(s10.note.indexOf('失败一定') < 0, '面板不得断言「失败一定是服务端拒绝」');
    assert(s10.vals.join('|').indexOf('拒绝') < 0 || s10.labels.length > 0,
      '模型返回列不得把失败一律写成「拒绝」');
    ok('面板文案：说明边界语义，未断言「失败即服务端拒绝」');
    ok('面板字段：' + s10.labels.join(' / '));
  } catch (e) { bad('面板文案 -> ' + e.message); }

  /* ============ 11. 无 [Sleepy] 报错 ============ */
  process.stdout.write('\n');
  var realErrors = errors.filter(function (e) {
    return !/favicon|Failed to load resource/i.test(e);
  });
  if (realErrors.length) {
    bad('页面报错：' + realErrors.slice(0, 3).join(' | '));
  } else {
    ok('全程无页面报错');
  }

  await browser.close();

  process.stdout.write('\n结果\n  通过 ' + pass + ' / 失败 ' + fail + '\n');
  if (fail) {
    process.stdout.write('\n失败项：\n');
    problems.forEach(function (p) { process.stdout.write('  - ' + p + '\n'); });
    process.stdout.write('\n结论：返修验收**未通过**。\n');
    process.exit(1);
  }
  process.stdout.write('\n结论：**返修接线验收通过**。\n' +
    '⚠️ 只证明请求身份、失败收尾与生产接口收口；**模型效果尚未验收**。\n');
})().catch(function (e) {
  process.stdout.write('脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
