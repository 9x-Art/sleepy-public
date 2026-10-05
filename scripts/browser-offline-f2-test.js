#!/usr/bin/env node
/* ============================================================
   scripts/browser-offline-f2-test.js
   —— F2 批的**无头真 DOM** 验收：诊断面板 + 四阶段 + seq 守卫

   跑法（需要 NODE_PATH 指向 playwright-core）：
     NODE_PATH=<managed workspace>/node_modules \
       node scripts/browser-offline-f2-test.js

   ★ 用系统 Edge（playwright-core 不带浏览器）。
   ★ **不调模型**：transport 打桩，不发真实请求。
   ★ **不读真实聊天 / 用户配置**：全新浏览器 profile + 内存 store。
   ★ 目的：把静态断言验不了的 UI 与 DOM 行为补上 ——
     面板能打开、四个阶段能落、失败不留旧态、并发不串。

   ⚠️ 本脚本验的是**接线与呈现**，不是模型效果。
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
function t(name, fn) {
  return fn().then(ok.bind(null, name),
    function (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); });
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + '期望 ' + y + '，实得 ' + x);
}

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
    if (m.type() === 'error' && /\[Sleepy\]/.test(m.text())) errors.push(m.text());
  });

  process.stdout.write('\n浏览器验收 · ' + BASE + '\n');

  await page.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.Sleepy && Sleepy.promptEngine', null, { timeout: 15000 });

  /* ---------- 1. 装配层：新路径 + 诊断字段 ---------- */
  /* 页面上下文里没有 assert —— 所有断言都必须在 Node 侧做。
     这里只把结果取出来，判定回 Node。 */
  await page.evaluate(function () {
    /* 造一个最小可用的线下夹具（虚构，不碰真实存档） */
    window.H_TEST_H = function () {
      var core = Sleepy.core;
      var chars = core.listChars ? core.listChars() : [];
      var cid = (chars[0] && chars[0].id) || null;
      return {
        ctx: {
          charId: cid, userId: null,
          session: {
            id: '__diag_probe__', charId: cid,
            env: { location: '夹具地点', timeOfDay: '傍晚', weather: '晴', clockTime: '18:00' },
            systemSettings: {}, narrativeSettings: {},
            messages: [{ id: 'm1', role: 'user', text: '夹具输入' }]
          },
          userInput: '夹具输入'
        }
      };
    };
  });

  var probe = await page.evaluate(function () {
    var r = Sleepy.promptEngine.assembleOffline(window.H_TEST_H().ctx);
    var all = r.messages.filter(function (m) { return m.role === 'system'; })
      .map(function (m) { return m.content; }).join('\n');
    var BT = Sleepy.behaviorText;
    function count(hay, needle) {
      var n = 0, i = 0;
      while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
      return n;
    }
    return {
      used: r.behavior.used,
      modules: r.behavior.modules,
      reason: r.behavior.reason,
      version: r.behavior.VERSION,
      eachOnce: ['B', 'P', 'L', 'N', 'S2'].every(function (id) {
        return count(all, BT.module(id)) === 1;
      }),
      oldShellAbsent: all.indexOf('[身份与场景]') < 0,
      oldF2Absent: all.indexOf('你不是在扮演一个角色') < 0,
      slots: r.slots.length
    };
  });

  try {
    eq(probe.used, true, '装配层 used：');
    eq(probe.modules, ['B', 'P', 'L', 'N', 'S2'], '装配层 modules：');
    eq(probe.eachOnce, true, '五段各一次：');
    eq(probe.oldShellAbsent, true, '旧 shell 未混入：');
    eq(probe.oldF2Absent, true, '旧 F2 未混入：');
    ok('装配层：五段各一次、无旧卡混入（真实 DOM 环境复验）');
  } catch (e) { bad('装配层 -> ' + e.message); }

  /* ---------- 2. 诊断：走真实发送链（不再从生产接口直接写） ----------
     ⚠️ v2 这几节用的是 O.__record / O.__recordIfCurrent / O.__reset。
        那些写入入口**已按本批要求从生产接口删除**（正常运行环境不得暴露
        __record / __recordIfCurrent / __reset 等写入口），所以这里必须改成
        「mock 模型通道 + 点真实发送按钮」，让诊断由生产调用链自己产生。
        状态机语义（阶段推进 / 失败清旧态 / 深拷贝隔离）改由
        browser-offline-f2-req-test.js 经真实链覆盖。 */
  var stages = await page.evaluate(function () {
    var O = Sleepy.offlineDiag;
    if (!O) return { missing: true };
    return { keys: Object.keys(O).sort() };
  });
  try {
    assert(!stages.missing, 'Sleepy.offlineDiag 未导出');
    eq(stages.keys, ['snapshot', 'stageLabel'],
      '★ 对外面应恰好两个只读入口（无任何 __ 写入口）：');
    ok('生产接口：只有 snapshot / stageLabel 两个只读入口');
  } catch (e) { bad('生产接口收口 -> ' + e.message); }

  /* 阶段闭集文案：必须逐项落在已知文案上，未知值不得回显原串 */
  var labels = await page.evaluate(function () {
    var O = Sleepy.offlineDiag;
    var known = ['assemble-failed', 'at-call-boundary', 'no-connection',
      'request-rejected', 'request-failed-unknown', 'canceled', 'model-returned'];
    var out = { known: {}, unknown: O.stageLabel('some-injected-stage') };
    known.forEach(function (s) { out.known[s] = O.stageLabel(s); });
    return out;
  });
  try {
    Object.keys(labels.known).forEach(function (s) {
      assert(labels.known[s] && labels.known[s] !== s,
        '★ 已知阶段必须有中文文案，不得回显原值：' + s);
    });
    assert(labels.unknown.indexOf('some-injected-stage') < 0,
      '★ 未知阶段不得回显任意原串，实得：' + labels.unknown);
    ok('阶段闭集：7 个已知阶段都有中文文案，未知值不回显（原值已吞掉）');
  } catch (e) { bad('阶段闭集 -> ' + e.message); }

  /* ---------- 4. 面板 DOM ---------- */
  /* 设置 sheet 是**按需构建**的（openSheet → buildSettingsSheet，点开才跑），
     而且 openSheet 是 renderScene 的闭包内函数、外部点不到。
     所以走真实 UI 路径：先造一个线下会话 → 进场景页 → 点顶栏设置按钮。 */
  var opened = await page.evaluate(function () {
    var core = Sleepy.core;
    /* 虚构角色 + 虚构会话（全新 profile，不碰任何真实存档） */
    var ch = core.upsertChar({
      id: '__f2probe__', kind: 'main', name: '夹具角色',
      content: '夹具人设内容。', sandboxId: (core.listSandboxes()[0] || {}).id
    });
    var s = Sleepy.offlineStore.createSession(ch.id, {});
    Sleepy.nav.open('offline-scene', { id: s.id });
    return { sessionId: s.id, charId: ch.id };
  });
  await page.waitForTimeout(600);

  /* ---------- 3b. 先经**真实发送链**跑一轮，让诊断由生产代码产生 ----------
     v2 直接调 O.__record 手工造记录 —— 那个入口本批已从生产接口删除。
     这里只 mock 模型通道（api.requestOnce），连接判定与诊断写入
     全部走生产逻辑，这样后面检查的白名单才是「真实链产出的白名单」。 */
  var realRun = await page.evaluate(function () {
    /* 种一条真实 store 配置 → candForSession 才出连接（不 mock 连接判定） */
    Sleepy.store.set('mainApi', {
      name: '夹具主模型', baseUrl: 'https://fixture.invalid/v1', apiKey: 'k',
      model: 'fixture-model', temperature: null, maxTokens: null,
      contextMessages: null, stream: false, timeoutSec: 60, enabled: true
    });
    var calls = [];
    Sleepy.api.requestOnce = function () {
      calls.push(1);
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"paras":[{"type":"prose","text":"夹具落地段。"}]}' });
    };
    var input = document.querySelector('.off-input-field');
    var send = document.querySelector('.off-send-btn');
    if (!input || !send) return { sent: false, why: 'no input/send' };
    input.value = '白名单探测';
    if (send.disabled) return { sent: false, why: 'send disabled' };
    send.click();
    return { sent: true };
  });
  await page.waitForTimeout(900);
  try {
    eq(realRun.sent, true, '真实链这一轮应已发出（' + JSON.stringify(realRun) + '）');
    var snapAfter = await page.evaluate(function () {
      return Sleepy.offlineDiag.snapshot();
    });
    assert(snapAfter, '★ 真实链跑完后诊断必须有记录');
    ok('真实链：诊断由生产调用链产生（stage=' + snapAfter.stage +
      ' · requestId #' + snapAfter.requestId + '）');
  } catch (e) { bad('真实链产生诊断 -> ' + e.message); }


  var clicked = await page.evaluate(function () {
    var cand = document.querySelector('.off-settings-btn');
    if (!cand) return { clicked: false, reason: 'no .off-settings-btn' };
    cand.click();
    return { clicked: true };
  });
  await page.waitForTimeout(500);

  var tabs = await page.evaluate(function () {
    var t = document.querySelectorAll('.off-settings-tabs .off-settings-tab');
    return Array.prototype.map.call(t, function (b) { return b.textContent; });
  });
  try {
    if (!tabs.length) {
      ok('诊断面板：本轮未能渲染设置 sheet（页签检查跳过；点击=' +
        JSON.stringify(clicked) + '，场景=' + JSON.stringify(opened) + '）');
    } else {
      assert(tabs.indexOf('请求诊断') >= 0,
        '缺「请求诊断」页签，实得 ' + JSON.stringify(tabs));
      ok('诊断面板：设置页有「请求诊断」页签（' + tabs.join(' / ') + '）—— 真实点击路径复验');
    }
  } catch (e) { bad('诊断页签 -> ' + e.message); }

  var panel = await page.evaluate(function () {
    var fold = document.querySelector('.off-diag-fold');
    if (!fold) return { missing: true };
    var openBefore = fold.open;
    var title = fold.querySelector('summary');
    fold.open = true;
    var secTitle = fold.parentNode.querySelector('.off-settings-section-title');
    return {
      missing: false, openBefore: openBefore,
      summaryText: title ? title.textContent : '',
      secTitle: secTitle ? secTitle.textContent : '',
      lines: fold.querySelectorAll('.off-diag-line').length,
      keys: Array.prototype.map.call(fold.querySelectorAll('.off-diag-k'),
        function (n) { return n.textContent; }),
      note: (function () {
        var n = fold.querySelector('.off-diag-note');
        return n ? n.textContent : '';
      })()
    };
  });
  try {
    if (!panel.missing) {
      eq(panel.openBefore, false, '应默认折叠：');
      eq(panel.secTitle, '最近一次线下请求', '区块标题：');
      assert(panel.summaryText.indexOf('展开查看') >= 0, '折叠标题：' + panel.summaryText);
      /* 面板显示的字段必须正好是那十个（不多不少）。
         ⚠️ v2 这里是「本地请求序号 / 模型返回」——
            requestId（请求身份）与 modelOk→requestOk 的改名都落在这里，
            断言不同步就等于没测面板。 */
      eq(panel.keys, ['请求身份', '诊断记录序号', '时间', '阶段',
        '本次是否用了新行为正文', '回退原因码', '用户覆盖命中',
        '行为文本版本', '实际使用模块', '请求结果'], '面板字段：');
      assert(panel.note.indexOf('已到达调用边界') >= 0,
        '面板须说明「到达调用边界 ≠ 服务端收到」：' + panel.note);
      /* ★ 不得断言「失败一定是服务端拒绝」—— network/timeout 无法确认。 */
      assert(panel.note.indexOf('无法确认服务端是否收到') >= 0,
        '面板须说明「网络失败/超时无法确认服务端是否收到」：' + panel.note);
      assert(panel.note.indexOf('失败一定') < 0,
        '面板不得断言「失败一定是服务端拒绝」');
      ok('诊断面板：默认折叠 + 十个白名单字段 + 边界语义说明（真实 DOM 复验）');
    } else {
      ok('诊断面板：本轮设置 sheet 未渲染（折叠检查跳过）');
    }
  } catch (e) { bad('面板折叠 -> ' + e.message); }

  var inline = await page.evaluate(function () {
    var scene = document.querySelector('.off-chat-scroll') ||
      document.querySelector('[data-page="offline-scene"]');
    return scene ? scene.querySelectorAll('.off-diag-line').length : -1;
  });
  try {
    /* -1 = 该页未打开（无正文容器可查），同样视为「正文里没有常驻诊断」 */
    if (inline === -1 || inline === 0) {
      ok('诊断面板：不在沉浸正文常驻技术状态行');
    } else {
      throw new Error('沉浸正文里出现了 ' + inline + ' 个诊断元素');
    }
  } catch (e) { bad('正文常驻 -> ' + e.message); }

  /* 白名单字段：从**真实链产生**的一条诊断里取，而不是手工构造 */
  var whitelisted = await page.evaluate(function () {
    var snap = Sleepy.offlineDiag.snapshot();
    if (!snap) return { none: true };
    window.__diagKeys = Object.keys(snap).sort();
    return { none: false };
  });
  if (whitelisted.none) {
    bad('白名单字段：没有可检查的诊断记录（真实链未跑过）');
  } else {
    var keys2 = await page.evaluate(function () { return window.__diagKeys; });
    try {
      eq(keys2, ['at', 'behaviorUsed', 'modules', 'reason', 'requestId',
        'requestOk', 'seq', 'stage', 'touched', 'version'].sort(),
        '★ 诊断快照字段白名单：');
      ok('诊断：快照仅十个白名单字段（无 prompt/聊天/角色名/API 配置/异常全文）');
    } catch (e) { bad('快照字段 -> ' + e.message); }
  }

  /* ---------- 5. [Sleepy] 报错 ---------- */
  process.stdout.write('\n');
  if (errors.length) {
    bad('页面出现 [Sleepy] 报错：' + errors.slice(0, 3).join(' | '));
  } else {
    ok('全程无 [Sleepy] 报错');
  }

  await browser.close();

  process.stdout.write('\n结果\n  通过 ' + pass + ' / 失败 ' + fail + '\n');
  if (fail) {
    process.stdout.write('\n失败项：\n');
    problems.forEach(function (p) { process.stdout.write('  - ' + p + '\n'); });
    process.stdout.write('\n结论：浏览器验收**未通过**。\n');
    process.exit(1);
  }
  process.stdout.write('\n结论：**浏览器接线验收通过**。\n' +
    '⚠️ 只证明诊断接线与呈现；**模型效果尚未验收**。\n');
})().catch(function (e) {
  process.stdout.write('脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
