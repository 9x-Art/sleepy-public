#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-budget-gate-test.js
   —— 「全局真实模型请求预算闸」的零**模型**请求单元测试

   ★ 为什么必须有这个文件（2026-10-05）：
     预算闸（`installFetchBypass` 的 `opts.budget`）是**单轮验收能否成立**的
     唯一控制点 —— 上限 1 就意味着「自动开场 / 重试 / 候选回退 /
     后台模型调用」全都发不出去。
     而它当时**一行测试都没有**：六个既有测试全绿，也不能证明它拦得住。
     ⇒ 「测试全绿」在这里等于「没测过」。

   ---- 硬边界（与其它 f2 测试同口径）----
     · **不启动 Edge / 任何浏览器**
     · **不发任何网络请求**（全部在纯 Node + 假 fetch 上完成）
     · **不碰凭据**：只用一个自造的假串，且它不在本页落盘

   ---- 逐条对应本轮要证明的东西 ----
     ① 第 1 次放行、第 2 次起 reject          → §2
     ② reject 的是**Promise**（不是 throw）     → §2（同步 throw 会炸生产链）
     ③ 被拒的调用**不留下「像是发过」的记录**   → §3
     ④ 本地资源（127.0.0.1 / file:）不算模型请求 → §4
     ⑤ 非当前端点的外站也算（防漏计）           → §4
     ⑥ 计数/清单准确、limit 缺省为 1            → §5
     ⑦ 未启用预算时行为完全不变（既有测试的兼容） → §6
     ⑧ ★ 阳性对照：把闸门拆掉，本测试必须报红   → §7
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '..');
var CAP = require('./lib/f2-body-capture.js');
var ACC = require('./offline-f2-effect-acceptance.js');

var pass = 0, fail = 0, problems = [];
function head(t) { process.stdout.write('\n' + t + '\n'); }
function ok(m) { pass++; process.stdout.write('  ✓ ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  ✗ ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + ' 期望 ' + y + '，实得 ' + x);
}
/* ★★ 必须**串行**（不是并发）：
     本文件所有异步用例都往**同一个** `REAL_HITS` 全局数组里记「到达
     origFetch 的次数」，而它只在 newWin() 里清零。
     并发跑 ⇒ 一个用例的清零会把另一个窗口的计数抹掉，
     断言就会读到别的用例留下的数字（实测报「实得 5」「实得 7」）。
     ⇒ 用例之间共享全局状态，就必须排队，不能 Promise.all。

   ⚠️ 同步用例 t() 也走同一条队列：否则它会在所有异步用例**等待期间**
     同步执行完，而那些用例随后才跑 —— 顺序与书写顺序不一致，
     将来加个依赖前置用例的判据就会踩到。
   ------------------------------------------------------------ */
var queue = [];
function t(name, fn) {
  queue.push({ name: name, fn: fn });
}
function ta(name, fn) {
  queue.push({ name: name, fn: fn, isAsync: true });
}
/* 串行 runner：逐个 await，前一个彻底落地才走下一个 */
function runQueue() {
  var i = 0;
  function step() {
    if (i >= queue.length) return Promise.resolve();
    var item = queue[i++];
    return Promise.resolve()
      .then(item.fn)
      .then(function () { ok(item.name); },
        function (e) { bad(item.name + ' -> ' + (e && e.message ? e.message : e)); })
      .then(step, step);   /* 无论成败都继续下一个（失败已记进 fail） */
  }
  return step();
}

/* ---------- 假 fetch：只记账，绝不联网 ---------- */
var BODY_STR = JSON.stringify({
  model: 'stub-model',
  messages: [{ role: 'user', content: '我到了。' }],
  stream: false, max_tokens: 8192, temperature: 0.85
});
var REAL_HITS = [];   /* 真正「到了 origFetch」的 URL —— 预算闸管的就是这个 */
function stubFetch() {
  return function (input) {
    REAL_HITS.push(String((input && input.url) || input || ''));
    return Promise.resolve({
      status: 200,
      clone: function () {
        return { text: function () {
          return Promise.resolve(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '（桩）' } }]
          }));
        } };
      }
    });
  };
}
function newWin() {
  REAL_HITS.length = 0;
  return { fetch: stubFetch(), Date: Date };
}
var MODEL_URL = 'https://api.example.invalid/v1/chat/completions';
var REJECT_RE = /全局模型请求预算已用尽/;

/* ============================================================
   §1 夹具前提：限 1 时第 1 次确实能出去
   —— 先证明「桩本身是通的」，否则后面的「拦住」可能只是桩坏了
   ============================================================ */
head('§1 前提：无预算闸时请求畅通（否则「拦住」没有可比性）');
ta('不传 budget → 第 1 次到达 origFetch', function () {
  var w = newWin();
  CAP.installFetchBypass(w, {});
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }).then(function () {
    eq(REAL_HITS.length, 1, '到达 origFetch 次数');
  });
});
t('不传 budget → __BUDGET 为 null（未启用）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, {});
  eq(w.__BUDGET, null, '__BUDGET');
});

/* ============================================================
   §2 核心：上限 1 ⇒ 第 1 次放行、第 2 次起 reject
   ============================================================ */
head('§2 预算闸核心行为（上限 1）');
ta('第 1 次放行并到达 origFetch', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }).then(function () {
    eq(REAL_HITS.length, 1, '第 1 次应到达 origFetch');
    assert(REAL_HITS.length === 1, '★ 第 1 次必须真的出去，否则「只发 1 次」无从谈起');
  });
});
ta('★ 第 2 次被 reject，且**没有**到达 origFetch', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () {
      return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR });
    })
    .then(function () {
      throw new Error('★ 第 2 次本应被拒绝，却 resolve 了（预算闸失效）');
    }, function (e) {
      assert(REJECT_RE.test(String(e && e.message)),
        '第 2 次的拒绝理由应含「预算已用尽」，实得：' + String(e && e.message));
      eq(REAL_HITS.length, 1, '到达 origFetch 次数（第 2 次必须仍是 1）');
      assert(REAL_HITS.length === 1,
        '★ 预算闸没拦住：origFetch 被调了 ' + REAL_HITS.length + ' 次');
    });
});
ta('★ reject 的是 Promise，不是同步 throw', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  var p1 = w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR });
  var threw = null, p2 = null;
  try {
    p2 = w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR });
  } catch (e) { threw = e; }
  assert(threw === null,
    '★ 预算闸同步 throw 了 —— 生产链走的是 .then/.catch，同步抛会炸断调用栈');
  assert(p2 && typeof p2.then === 'function', '第 2 次必须返回 thenable');
  return p1.then(function () { return p2; })
    .then(function () { throw new Error('第 2 次本应被拒'); },
      function () { /* 拒对了 */ });
});
ta('上限 2 ⇒ 前两次放行、第 3 次被拒（不是写死只拦一次）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 2 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
    .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
    .then(function () { throw new Error('★ 第 3 次本应被拒'); },
      function (e) {
        assert(REJECT_RE.test(String(e && e.message)), '拒绝理由：' + String(e && e.message));
        eq(REAL_HITS.length, 2, '到达 origFetch 次数');
      });
});
ta('★ 不同 URL 也计数（重试/回退换端点照样被拦）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () {
      return w.fetch('https://other-relay.example.invalid/v1/chat/completions',
        { method: 'POST', body: BODY_STR });
    })
    .then(function () { throw new Error('★ 换端点后第二次未被拦'); },
      function (e) {
        assert(REJECT_RE.test(String(e && e.message)), '拒绝理由：' + String(e && e.message));
        eq(REAL_HITS.length, 1, '到达 origFetch 次数');
      });
});

/* ============================================================
   §3 被拒的调用不许留下「像是发过」的记录
   ============================================================ */
head('§3 被拒的调用不采集（否则报告会说「发了 N 次」）');
ta('第 2 次被拒后 __SEND 仍只有 1 条', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () {
      return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR });
    })
    .then(function () {}, function () {})
    .then(function () {
      eq((w.__SEND || []).length, 1, '__SEND 条数（被拒那次不许留记录）');
      assert((w.__SEND || []).length === 1,
        '★ 被拒的调用留下了请求体记录 —— 报告会把它算成「发过」');
    });
});
ta('★ 被拒的调用连 __HTTP 都不该有（响应侧同样不记）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () {
      return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR });
    })
    .then(function () {}, function () {})
    .then(function () {
      eq((w.__HTTP || []).length, 1, '__HTTP 条数');
    });
});

/* ============================================================
   §4 计数口径：本地资源不算；外站（非当前端点）要算
   ============================================================ */
head('§4 计数口径');
ta('本地 127.0.0.1 页面资源不消耗预算', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch('http://127.0.0.1:5173/style.css')
    .then(function () { return w.fetch('http://localhost:5173/index.html'); })
    .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
    .then(function () {
      eq(REAL_HITS.length, 3, '本地两次 + 模型一次都应到达 origFetch');
      eq(w.__BUDGET.used, 1, '预算只被模型请求消耗');
      assert(w.__BUDGET.used === 1,
        '★ 本地资源被算成模型请求了（used=' + w.__BUDGET.used + '）');
    });
});
ta('file: 也不消耗预算', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch('file:///D:/projects/sleepy/calendar-data.json')
    .then(function () {
      eq(w.__BUDGET.used, 0, 'file: 请求不该计数');
    });
});
t('★ 口径不是「只认当前端点」：任意外站都算模型请求', function () {
  /* 这条是**静态**判据 + 行为判据双证：
     行为上 §2 的「换端点也被拦」已覆盖；这里再钉住实现口径，
     防止将来有人「优化」成只匹配 API_BASE。 */
  var src = fs.readFileSync(path.join(__dirname, 'lib', 'f2-body-capture.js'), 'utf8');
  var seg = src.slice(src.indexOf('function budgetAllows'),
    src.indexOf('var origFetch = win.fetch;'));
  assert(seg.length > 0, '定位到 budgetAllows 实现');
  assert(!/API_BASE|apiBase|opts\.base|opts\.endpoint/.test(seg),
    '★ budgetAllows 里出现了具体端点 —— 换个端点的后台调用会漏计');
  assert(/isLocalUrl/.test(seg), 'budgetAllows 应按「是否本地」判断');
  return null;
});

/* ============================================================
   §5 计数与清单
   ============================================================ */
head('§5 计数 / 清单 / 缺省值');
ta('limit 缺省为 1（传 {} 也只放 1 次）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: {} });
  eq(w.__BUDGET.limit, 1, '缺省 limit');
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
    .then(function () { throw new Error('第 2 次本应被拒'); },
      function (e) {
        assert(REJECT_RE.test(String(e && e.message)), '拒绝理由');
        eq(REAL_HITS.length, 1, '到达 origFetch 次数');
      });
});
ta('used / allowed / rejected 三个计数口径一致', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () {
      eq(w.__BUDGET.used, 1, 'used');
      eq(w.__BUDGET.allowed.length, 1, 'allowed 条数');
      eq(w.__BUDGET.rejected.length, 0, 'rejected 条数');
      return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR });
    })
    .then(function () {}, function () {})
    .then(function () {
      eq(w.__BUDGET.used, 1, '★ used 不该因被拒而增加（被拒没发出去）');
      eq(w.__BUDGET.rejected.length, 1, 'rejected 条数');
      eq(w.__BUDGET.allowed[0].第几次, 1, 'allowed 记第几次');
      assert(w.__BUDGET.used === 1,
        '★ used 把被拒的调用也算进去了 —— 报告会虚报请求数');
    });
});
ta('拒绝记录里的 URL 已脱敏（不带凭据）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  return w.fetch('https://x.example.invalid/v1/chat?key=SECRETVALUE123')
    .then(function () {
      return w.fetch('https://x.example.invalid/v1/chat?key=SECRETVALUE123');
    })
    .then(function () {}, function (e) {
      var msg = String(e && e.message);
      assert(msg.indexOf('SECRETVALUE123') < 0,
        '★ 拒绝消息里带着未脱敏的凭据：' + msg);
      assert(/key=\*\*\*/.test(msg), '拒绝消息应含脱敏后的 key=*** ：' + msg);
    });
});
t('幂等：装两次不会把预算重置（否则「全局」就漏了）', function () {
  var w = newWin();
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  var first = w.fetch;
  /* 第二次装：按现有实现应**原样返回**（不重包、不重置计数） */
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  eq(w.fetch, first, '第二次 install 后 fetch 引用（应不变）');
  eq(w.__BUDGET.used, 0, '幂等安装不该凭空产生已用次数');
});

/* ============================================================
   §6 未启用预算时，既有行为完全不变（兼容既有测试）
   ============================================================ */
head('§6 未启用预算 = 既有行为');
ta('不传 budget：连发 3 次都放行', function () {
  var w = newWin();
  CAP.installFetchBypass(w, {});
  return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
    .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
    .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
    .then(function () {
      eq(REAL_HITS.length, 3, '三次都应到达 origFetch');
      eq(w.__BUDGET, null, '__BUDGET 仍为 null');
    });
});
t('不传 budget：__SEND / __HTTP 照常记录', function () {
  var w = newWin();
  CAP.installFetchBypass(w, {});
  assert(Array.isArray(w.__SEND) && Array.isArray(w.__HTTP),
    '未启用预算时旁路数组仍要建（既有测试依赖它们）');
});

/* ============================================================
   §7 ★ 阳性对照：把闸门拆掉，本测试必须报红
   —— 判据若与被测对象共用同一错误来源，这里就是唯一出口
   ============================================================ */
head('§7 阳性对照（负向注入 · 仓库外隔离副本）');
/* 在**仓库外**复制一份 capture 模块，把 budgetAllows 短路成恒 true，
   然后用**同一份判据**跑一遍 —— 必须报红。
   ⚠️ 必须在仓库外：注入会改文件，不能污染工作树。 */
var ISO = path.join('D:/projects', 'sleepy-budget-gate-negative-' +
  String(Date.now()));
var ISO_FILE = path.join(ISO, 'f2-body-capture.js');
var injected = null, injectionHits = -1;
try {
  fs.mkdirSync(ISO, { recursive: true });
  var capSrc = fs.readFileSync(path.join(__dirname, 'lib', 'f2-body-capture.js'), 'utf8');
  /* 注入点：把 `if (budget.used >= budget.limit) {` 改成恒假。
     锚点必须**唯一命中**，否则报的是未注入版本（记忆里的老坑）。 */
  var anchor = 'if (budget.used >= budget.limit) {';
  injectionHits = capSrc.split(anchor).length - 1;
  assert(injectionHits === 1,
    '锚点命中 ' + injectionHits + ' 次（应为 1）—— 注入点不唯一，负向对照无效');
  var patched = capSrc.replace(anchor, 'if (false) {');
  assert(patched !== capSrc, '注入未生效（源码未变）');
  fs.writeFileSync(ISO_FILE, patched, 'utf8');
  injected = require(ISO_FILE);
} catch (e) {
  bad('负向隔离副本准备失败 -> ' + (e && e.message ? e.message : e));
}
if (injected) {
  /* ⚠️ 这两条**刻意分成两个用例**，不要合并：
     合并就得在同一段里既测注入版又测生产版，中途必须清两次全局计数器，
     而清零与断言的先后极易排错（第一版就是这么写错的：
     中途 newWin() 清了零，末尾却去断言「注入副本放行 2 次」）。 */
  ta('★ 注入后（闸门恒放行）放行 2 次 —— 判据抓得到回归', function () {
    var w = newWin();                       /* 先清零，全程不再清 */
    injected.installFetchBypass(w, { budget: { limit: 1 } });
    return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
      .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
      .then(function () {
        eq(REAL_HITS.length, 2, '注入副本放行次数');
        assert(REAL_HITS.length === 2,
          '注入后应放行 2 次（实得 ' + REAL_HITS.length + '）—— 注入没生效，负向对照无效');
        eq(w.__BUDGET.rejected.length, 0, '注入后不该有 rejected');
      });
  });
  ta('★ 生产版在同一场景只放行 1 次（与注入版不同 ⇒ 判据有判别力）', function () {
    var w = newWin();
    CAP.installFetchBypass(w, { budget: { limit: 1 } });
    return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR })
      .then(function () { return w.fetch(MODEL_URL, { method: 'POST', body: BODY_STR }); })
      .then(function () { throw new Error('★ 生产版第 2 次本应被拒，却 resolve 了'); },
        function (e) {
          assert(REJECT_RE.test(String(e && e.message)),
            '生产版第 2 次的拒绝理由：' + String(e && e.message));
          eq(REAL_HITS.length, 1, '生产版到达 origFetch 次数');
          eq(w.__BUDGET.rejected.length, 1, '生产版 rejected 条数');
        });
  });
}

/* ============================================================
   §8 接线：验收脚本必须真的把上限注入进去
   —— 闸门本身对，但没接线 = 验收时等于没有
   ============================================================ */
head('§8 验收脚本接线（闸门 + 只跑一轮）');
t('★ 存在全局预算上限的环境变量入口', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/SLEEPY_EFFECT_BUDGET/.test(src), '应读 SLEEPY_EFFECT_BUDGET');
  assert(/SLEEPY_EFFECT_MAX_TURNS/.test(src), '应读 SLEEPY_EFFECT_MAX_TURNS（只跑前 N 轮）');
});
t('★ 预算闸真的传给了 installFetchBypass（不是只声明了变量）', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  var seg = src.slice(src.indexOf('installFetchBypass(window'), src.indexOf('});', src.indexOf('installFetchBypass(window')));
  assert(/budget:/.test(seg), 'installFetchBypass 的参数里必须有 budget');
  assert(/__BUDGET_LIMIT/.test(seg), 'budget 上限应来自 __BUDGET_LIMIT');
});
t('★ 预算上限随配置注入页内（Node → 页面链路完整）', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/window\.__BUDGET_LIMIT\s*=/.test(src), '应把上限挂到 window.__BUDGET_LIMIT');
  assert(/budgetLimit:\s*BUDGET_LIMIT/.test(src), '应在 evaluate 的参数里传 budgetLimit');
});
t('★ 轮记录带上累计预算状态（报告能核对）', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/请求预算:\s*budgetState/.test(src), '轮记录应有「请求预算」字段');
  assert(/window\.__BUDGET/.test(src), '应从 window.__BUDGET 读回累计计数');
});
t('★ MAX_TURNS 真的切掉了 turns（只跑前 N 轮）', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/turns:\s*MAX_TURNS\s*>\s*0\s*\?\s*g\.turns\.slice\(0,\s*MAX_TURNS\)/.test(src),
    'MAX_TURNS 应切 turns');
});
t('★ 超预算被拒会硬停（不会静默继续下一轮）', function () {
  /* 被拒 ⇒ fetch reject ⇒ 生产按 network 失败 ⇒ hardStopKind 判 'net' 硬停。
     另有独立一道：预算闸被触发这件事本身也可判停。 */
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/raw\.stage\s*===\s*'network'\s*\|\|\s*raw\.stage\s*===\s*'timeout'/.test(src)
    || /return 'net'/.test(src), 'hardStopKind 应把网络失败判为硬停');
});

/* ---------- 汇总 ---------- */
runQueue().then(function () {
  head('────────');
  process.stdout.write('通过 ' + pass + ' / 失败 ' + fail + '\n');
  if (injected) {
    process.stdout.write('负向隔离副本（仓库外，未污染工作树）：' + ISO_FILE + '\n');
    process.stdout.write('实际注入：把 budgetAllows 里 `if (budget.used >= budget.limit) {` ' +
      '换成 `if (false) {`（锚点唯一命中）\n');
  }
  if (fail) {
    process.stdout.write('❌ 红项：\n' + problems.map(function (p) { return '   - ' + p; }).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('✅ 全绿（本测试**不启动浏览器、不发任何网络请求**）\n');
  process.stdout.write('★ 结论：预算闸在**纯 Node 层面**可证 —— 上限 1 时第 2 次起被 reject、' +
    '被拒的调用不留记录、本地资源不计数。\n');
  process.stdout.write('⚠️ 未覆盖：**页内真实链路**上生产代码是否真的只调一次 fetch' +
    '（那要靠真机跑 + __BUDGET 读回证明，本测试证明不了）。\n');
});
