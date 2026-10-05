#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-p3-matrix-test.js
   —— P3 单臂 7 组矩阵的**零网络**结构预检（2026-10-05）

   ★ 硬边界：**不启动浏览器、不发任何网络请求、不调模型**。
     全部在纯 Node 里 require 生产验收脚本，验的是**同一份 GROUPS**。
   ★ 为什么要有：矩阵是**手写的 17 条输入** —— 抄错一个字、轮数写错、
     组序颠倒，**真机跑完才发现就浪费预算**。

   ---- 覆盖（对应用户列的 11 项）----
     ① 七个 GROUPS 都已注册          §1
     ② 每组会话独立                 §2
     ③ 轮数 3/2/2/3/2/3/2           §3
     ④ SETUP 不产生 fetch           §4
     ⑤ 每条输入按正确顺序进入对应会话 §5（逐字 · 码点级）
     ⑥ 修复后 user 输入不重复       §6（真跑装配器）
     ⑦ B/P/L/N/S2 装配完整          §7
     ⑧ G5 判分含「未触发」「证据不足」§8
     ⑨ 修复后重跑标记不混旧样本     §9
     ⑩ 预算闸仍为单次请求计数       §10
     ⑪ 全程真实模型请求数 = 0       §11
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var ROOT = path.resolve(__dirname, '..');
var ACC = require('./offline-f2-effect-acceptance.js');
var H = require('./harness.js');

var pass = 0, fail = 0, problems = [];
function head(t) { process.stdout.write('\n' + t + '\n'); }
function ok(m) { pass++; process.stdout.write('  ✓ ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  ✗ ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + ' 期望 ' + y + '，实得 ' + x);
}
/* ★ 串行：本文件所有用例共享同一个 boot 出来的沙箱（store 是全局单例） */
var queue = [];
function t(name, fn) { queue.push({ name: name, fn: fn }); }
function runQueue() {
  var i = 0;
  function step() {
    if (i >= queue.length) return Promise.resolve();
    var it = queue[i++];
    return Promise.resolve().then(it.fn).then(
      function () { ok(it.name); },
      function (e) { bad(it.name + ' -> ' + (e && e.message ? e.message : e)); }
    ).then(step, step);
  }
  return step();
}

/* ---------- 期望值：全部来自**用户指令原文**（本文件是唯一出处） ---------- */
var EXPECT = [
  { id: 1, case: 'C1', n: 3, turns: ['我到了。', '嗯。', '你接着说。'] },
  { id: 2, case: 'C2', n: 2, turns: ['这楼上的灯太暗了。', '嗯。'] },
  { id: 3, case: 'C3', n: 2, turns: ['嗯。', '我下周再来。今天先走了。'] },
  { id: 4, case: 'C4', n: 3, turns: ['我到了。', '我坐下了。', '算了，你看着办。'] },
  { id: 5, case: 'C5', n: 2, turns: ['（我把杯子往他那边推了推。）', '我笑了一下，没接话。'.replace(/^/, '（').replace(/$/, '）')] },
  { id: 6, case: 'C6', n: 3, turns: ['我下周再来。', '今天雨停了。', '我走了。'] },
  { id: 7, case: 'C7', n: 2, turns: [
    '你还记得我们第一次见面那天我跟你说过什么吗。我今天有点累。' +
    '能不能帮我把阁楼那扇窗关一下，风一直吹进来。' +
    '算了你随便吧，不关也行。对了你别跟楼下的人提我今天来过。',
    '你刚才说的那个，我再想想。'] }
];
/* ★ 码点级比对：全角/半角括号、句号的差别肉眼看不见但**会污染模型输入**。
   2026-10-05 今天已在预检里栽过两次（全角 ）vs 半角 )、嗯。vs 嗯.）。 */
function codes(s) {
  return String(s).split('').map(function (c) {
    return c.charCodeAt(0).toString(16);
  }).join(' ');
}

var G = ACC.GROUPS;
var h = null, S = null;

head('§1 七个 GROUPS 都已注册');
t('组数 = 7，id 依次 1..7', function () {
  eq(G.length, 7, '组数');
  eq(G.map(function (g) { return g.id; }), [1, 2, 3, 4, 5, 6, 7], '各组 id');
});
t('每组都有 key / case / rule / goal / watch / turns', function () {
  G.forEach(function (g) {
    ['key', 'case', 'rule', 'goal', 'turns'].forEach(function (k) {
      assert(g[k] !== undefined && g[k] !== null && g[k] !== '',
        '组 ' + g.id + ' 缺字段 ' + k);
    });
    assert(Array.isArray(g.turns) && g.turns.length > 0,
      '组 ' + g.id + ' turns 为空');
    assert(Array.isArray(g.watch) && g.watch.length > 0,
      '组 ' + g.id + ' watch 为空');
  });
});
t('GROUPS / C5_JUDGE 已进导出面（预检与真机跑**同一份**）', function () {
  assert(Array.isArray(ACC.GROUPS), 'GROUPS 未导出');
  assert(Array.isArray(ACC.C5_JUDGE_ALL), 'C5_JUDGE_ALL 未导出');
  assert(ACC.C5_JUDGE_RULE, 'C5_JUDGE_RULE 未导出');
  assert(ACC.GROUPS === G, 'GROUPS 引用不一致');
});

head('§2 每组会话独立');
t('★ 主流程换组时 close 旧 page → newPage() → 才 SETUP', function () {
  /* ⚠️ 判据要按**位置**核验顺序，不能在同一段切片里比 indexOf ——
     第一版把切片边界放在 SETUP 之前，结果 newPage 与 SETUP 根本不在同一段，
     报「SETUP 早于 newPage」—— 报的是判据自己取错了范围。 */
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  var gi0 = src.indexOf('for (var gi = 0; gi < groups.length');
  assert(gi0 > 0, '定位不到外层 groups 循环');
  var closeAt = src.indexOf('await page.close()', gi0);
  var newAt = src.indexOf('page = await newPage()', gi0);
  var setupAt = src.indexOf('await page.evaluate(SETUP', gi0);
  assert(closeAt > gi0, '未看到 page.close()');
  assert(newAt > closeAt, 'newPage 必须在 close 之后');
  assert(setupAt > newAt, '★ SETUP 早于 newPage() —— 会话没换就建夹具');
  var guard = src.slice(gi0, closeAt);
  assert(/if \(gi > 0\)/.test(guard), '换页未被 if (gi > 0) 守卫');
});
t('SETUP 在循环内（每组一次）', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  var n = (src.match(/await page\.evaluate\(SETUP/g) || []).length;
  eq(n, 1, 'SETUP 调用点数量（1 = 循环内每组一次）');
});

head('§3 轮数 3/2/2/3/2/3/2 = 17');
t('各组轮数逐项相符', function () {
  eq(G.map(function (g) { return g.turns.length; }), [3, 2, 2, 3, 2, 3, 2],
    '各组轮数');
});
t('正式轮次合计 = 17', function () {
  var sum = G.reduce(function (a, g) { return a + g.turns.length; }, 0);
  eq(sum, 17, '轮次合计');
  assert(sum === 17, '★ 合计 ' + sum + ' ≠ 17，预算会算错');
});

head('§4 SETUP 不产生 fetch');
t('★ SETUP 源码里没有任何出网调用', function () {
  var src = ACC.SETUP_SRC;
  ['fetch(', 'requestOnce', 'callModel', 'XMLHttpRequest', 'sendBeacon']
    .forEach(function (k) {
      assert(src.indexOf(k) < 0, 'SETUP 里出现 ' + k + ' ⇒ 建会话会消耗请求');
    });
});
t('★ 独立复核：在沙箱里真跑一遍 SETUP，fetch 计数 = 0', function () {
  /* ⚠️ SETUP 是**页内函数**，依赖全局 `Sleepy` —— 不能在宿主 Node 里直接调
     （直接 ACC.SETUP({...}) 会报 `Sleepy is not defined`，
     报的是「我调错了地方」，不是 SETUP 的问题）。
     harness 暴露的是 h.ctx（vm 上下文）+ h.win（沙箱 window）。 */
  h = H.boot('p3matrix');
  S = h.S;
  var realFetch = h.win.fetch;
  var calls = 0;
  h.win.fetch = function () { calls++; return realFetch.apply(this, arguments); };
  /* SETUP 会读这些注入值（真实流程由 Node 侧在 evaluate 后注入） */
  h.win.__APPROVED = ACC.APPROVED;
  h.win.__API_BASE = 'https://stub.invalid/v1';
  h.win.__API_KEY = 'STUB-NOT-A-REAL-KEY';
  h.win.__API_MODEL = 'stub-model';
  vm.runInContext('__f3setup = (' + ACC.SETUP_SRC + ');', h.ctx);
  h.ctx.__f3fixture = ACC.FIXTURE;
  vm.runInContext('__f3res = __f3setup({ f: __f3fixture });', h.ctx);
  var after = calls;
  h.win.fetch = realFetch;
  assert(h.ctx.__f3res && h.ctx.__f3res.sid, 'SETUP 未返回 sid（沙箱内执行失败）');
  eq(after, 0, 'SETUP 期间的 fetch 次数');
  ok('  （沙箱内 SETUP 执行完毕，fetch 调用 ' + after + ' 次）');
});

head('§5 每条输入按正确顺序进入对应会话（逐字 · 码点级）');
t('★ 17 条输入逐条逐字相符', function () {
  var i = 0;
  EXPECT.forEach(function (want, gi) {
    var g = G[gi];
    assert(g, '第 ' + (gi + 1) + ' 组不存在');
    eq(g.id, want.id, '第 ' + (gi + 1) + ' 组 id');
    eq(g.case, want.case, '组 ' + want.id + ' 的 case');
    eq(g.turns.length, want.n, '组 ' + want.id + ' 轮数');
    want.turns.forEach(function (wt, ti) {
      var got = g.turns[ti];
      assert(typeof got === 'string' && got.length > 0,
        '组 ' + want.id + ' 轮' + (ti + 1) + ' 输入为空');
      if (got !== wt) {
        throw new Error('组 ' + want.id + ' 轮' + (ti + 1) + ' 输入不符\n'
          + '      期望码点: ' + codes(wt) + '\n'
          + '      实得码点: ' + codes(got));
      }
      i++;
    });
  });
  eq(i, 17, '逐条比对条数');
});
t('★ G5 两轮是**纯动作输入**（全角括号，无情绪词）', function () {
  var g5 = G.filter(function (g) { return g.judge === 'C5'; })[0];
  assert(g5, '找不到 judge=C5 的组');
  /* ⚠️ 情绪词判定第一版写成 `/词表/.test(s) < 0` —— **逻辑反了**
     （test() 为 true 时 <0 恒 false ⇒ 任何输入都报红）。
     正确写法：逐词 indexOf，命中即报出是哪个词。 */
  var MOOD = ['难过', '生气', '开心', '想念', '害怕', '累', '烦', '高兴', '伤心'];
  g5.turns.forEach(function (s, i) {
    assert(s.charAt(0) === '（' && s.charAt(s.length - 1) === '）',
      'G5 轮' + (i + 1) + ' 不是「（动作）」形态：' + s);
    var hitMood = MOOD.filter(function (w) { return s.indexOf(w) >= 0; });
    assert(hitMood.length === 0,
      'G5 轮' + (i + 1) + ' 含情绪词 ' + JSON.stringify(hitMood)
      + ' ⇒ 给了语义锚点，模型不必自己解释');
  });
  ok('  （G5 两轮均为「（…）」纯动作形态：' + g5.turns.join(' / ') + '）');
});
t('★ 轮次标记绝不写进输入（会污染复读判据）', function () {
  G.forEach(function (g) {
    g.turns.forEach(function (s, i) {
      assert(!/第[一二三四五六七八九十\d]+轮/.test(s),
        '组 ' + g.id + ' 轮' + (i + 1) + ' 输入里带轮次标记：' + s);
    });
  });
});

head('§6 修复后 user 输入在最终 body 预览中不重复（真跑装配器）');
t('★ 逐组逐轮：装配结果里该句恰好 1 次且垫底', function () {
  var bad2 = [];
  G.forEach(function (g) {
    /* 每组用**独立会话**（与真机同形）：新建 → 逐轮 appendMessage → 装配 */
    var cid = S.core.upsertChar({ id: '__p3r_' + g.id, kind: 'main', name: '沈砚',
      content: '沈砚，建筑设计师。' }).id;
    var sess = S.offlineStore.createSession(cid, {
      sceneName: '雨夜的旧书店', location: '城西旧书店二楼阁楼',
      timeOfDay: '深夜', weather: '雨', clockTime: '23:40' });
    g.turns.forEach(function (turn) {
      /* ★ 与 page-offline.js:1400/1452 同形：先落库，再传 userInput */
      S.offlineStore.appendMessage(sess.id, { role: 'user', text: turn });
      var back = S.offlineStore.findSession(sess.id);
      var r = S.promptEngine.assembleOffline({
        charId: back.charId, userId: null, session: back, userInput: turn });
      var n = r.messages.filter(function (m) {
        return m.role === 'user' && String(m.content) === turn;
      }).length;
      if (n !== 1) bad2.push('组' + g.id + '「' + turn + '」出现 ' + n + ' 次');
      var last = r.messages[r.messages.length - 1];
      if (!(last.role === 'user' && String(last.content) === turn)) {
        bad2.push('组' + g.id + '「' + turn + '」未垫底（顺序不对）');
      }
    });
  });
  eq(bad2, [], '重复 / 顺序异常清单');
  assert(bad2.length === 0, '★ ' + bad2.join('；'));
});
t('★ 历史满 20 条时本轮输入仍在且只 1 次（不被 slice(-20) 挤掉）', function () {
  var cid = S.core.upsertChar({ id: '__p3full', kind: 'main', name: '沈砚',
    content: '沈砚，建筑设计师。' }).id;
  var s = S.offlineStore.createSession(cid, { sceneName: '雨夜的旧书店' });
  for (var i = 1; i <= 20; i++) {
    S.offlineStore.appendMessage(s.id, { role: 'user', text: ' fillers ' + i });
  }
  var turn = G.filter(function (g) { return g.judge === 'C5'; })[0].turns[0];
  S.offlineStore.appendMessage(s.id, { role: 'user', text: turn });
  var back = S.offlineStore.findSession(s.id);
  var r = S.promptEngine.assembleOffline({
    charId: cid, userId: null, session: back, userInput: turn });
  var n = r.messages.filter(function (m) {
    return m.role === 'user' && String(m.content) === turn; }).length;
  eq(n, 1, '满历史下的出现次数');
  eq(String(r.messages[r.messages.length - 1].content), turn, '满历史时必须垫底');
});

head('§7 B/P/L/N/S2 装配完整');
t('★ 五段整块各命中 1 次（不是只查首句）', function () {
  var cid = S.core.upsertChar({ id: '__p3bt', kind: 'main', name: '沈砚',
    content: ACC.FIXTURE.char.content }).id;
  var s = S.offlineStore.createSession(cid, {
    sceneName: ACC.FIXTURE.scene.sceneName,
    location: ACC.FIXTURE.scene.location,
    timeOfDay: ACC.FIXTURE.scene.timeOfDay,
    weather: ACC.FIXTURE.scene.weather,
    clockTime: ACC.FIXTURE.scene.clockTime });
  var back = S.offlineStore.findSession(s.id);
  var r = S.promptEngine.assembleOffline({
    charId: cid, userId: null, session: back, userInput: '我到了。' });
  var sys = r.messages.filter(function (m) { return m.role === 'system'; })
    .map(function (m) { return String(m.content); }).join('\n');
  var fs2 = S.behaviorText.forScenario('offline');
  assert(fs2 && fs2.ok === true, 'forScenario(offline) 失败');
  var hit = {};
  fs2.parts.forEach(function (p) {
    var n = sys.split(p.text).length - 1;
    hit[p.id] = n;
    assert(n === 1, '段 ' + p.id + ' 整块命中 ' + n + ' 次（应为 1）');
  });
  eq(Object.keys(hit).sort(), ['B', 'L', 'N', 'P', 'S2'], '五段 id');
  assert(sys.indexOf('[角色声音]') < 0, '含旧 shell 卡标记 ⇒ 走的是回退路径');
  ok('  （behaviorText ' + S.behaviorText.VERSION + ' · 五段各命中 1 次 · 无旧 shell 卡标记）');
});

head('§8 G5 判分含「未触发」「证据不足」，不能只用 0/1');
t('★ 五档齐备且互不相同', function () {
  eq(ACC.C5_JUDGE_ALL, ['F1违规', 'F2违规', '合规', '证据不足', '未触发'], '五档');
  eq(ACC.C5_JUDGE_ALL.length, new Set(ACC.C5_JUDGE_ALL).size, '五档互异性');
});
t('★ 「未触发」与「合规」是两个**独立**档，不许合并', function () {
  assert(ACC.C5_JUDGE_ALL.indexOf('未触发') >= 0, '缺「未触发」档');
  assert(ACC.C5_JUDGE_ALL.indexOf('合规') >= 0, '缺「合规」档');
});
t('★ 每档都有判定规则（不许空规则）', function () {
  ACC.C5_JUDGE_ALL.forEach(function (k) {
    var r = ACC.C5_JUDGE_RULE[k];
    assert(typeof r === 'string' && r.length > 5, '档 ' + k + ' 缺判定规则');
  });
});
t('★ 「未触发」规则明写「不等于通过」', function () {
  assert(/不等于通过/.test(ACC.C5_JUDGE_RULE.未触发),
    '「未触发」档的规则必须明写「不等于通过」');
  assert(/分不清/.test(ACC.C5_JUDGE_RULE.证据不足),
    '「证据不足」档的规则必须写明「分不清 ⇒ 不判分」');
});
t('★ G5 判分表结构含五档字段 + 禁判 M 的标记', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  ['F1违规: null', 'F2违规: null', '合规: null', '证据不足: null', '未触发: null']
    .forEach(function (k) {
      assert(src.indexOf(k) >= 0, '判分表缺字段 ' + k);
    });
  assert(/是否判M: null/.test(src), '缺「是否判M」标记（G5 不判 M1-M4）');
  assert(/不重复判定: ''/.test(src), '缺「不重复判定」字段（同句兼涉 ⇒ 归 G6）');
  assert(/g\.judge === 'C5'/.test(src), '判分表未按组切换（C5 专用 / 通用）');
});
t('★ G5 明确禁判 M1/M2/M3/M4，且归属规则写死', function () {
  var g5 = G.filter(function (g) { return g.judge === 'C5'; })[0];
  var w = g5.watch.join('\n');
  assert(/不判 M1\/M2\/M3\/M4/.test(w), 'G5 watch 未写明禁判 M1-M4');
  assert(/归 G6/.test(w), 'G5 watch 未写明兼涉时归 G6');
});

head('§9 修复后重跑标记不混旧样本');
t('★ G4/G7 带 rerunAfterFix 标记，其余组不带', function () {
  var marked = G.filter(function (g) { return !!g.rerunAfterFix; })
    .map(function (g) { return g.id; });
  eq(marked, [4, 7], '带重跑标记的组');
  eq(G.filter(function (g) { return g.rerunAfterFix; })[0].rerunAfterFix.轮, 1,
    'G4 重跑轮次');
  eq(G.filter(function (g) { return g.rerunAfterFix; })[1].rerunAfterFix.轮, 1,
    'G7 重跑轮次');
});
t('★ 标记带原因，且明写「修复前」', function () {
  G.filter(function (g) { return g.rerunAfterFix; }).forEach(function (g) {
    var why = g.rerunAfterFix.原因 || '';
    assert(why.length > 5, '组 ' + g.id + ' 重跑原因过短');
    assert(/修复前/.test(why), '组 ' + g.id + ' 原因未提「修复前」');
  });
});
t('★ 落盘字段带溯源与旧样本排除口径', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  ['修复后重跑轮', '修复后重跑原因', '本组数据来源'].forEach(function (k) {
    assert(src.indexOf(k) >= 0, '记录集缺字段 ' + k);
  });
  ['P3矩阵', '正式轮次合计', '旧样本排除口径', '修复后重跑说明']
    .forEach(function (k) {
      assert(src.indexOf(k) >= 0, 'meta 缺字段 ' + k);
    });
  assert(/一律不得并入 P3 正式统计/.test(src), '未写明旧样本「不得并入 P3 正式统计」');
});

head('§9bis 口径 A：18 次预算（元数据修正后 · 2026-10-05 用户确认）');
t('★ 正式矩阵轮次仍为 17', function () {
  var sum = G.reduce(function (a, g) { return a + g.turns.length; }, 0);
  eq(sum, 17, '正式矩阵轮次');
});
t('★ G4/G7 轮 1 **没有**被额外追加成第 18/19 轮', function () {
  var marked = G.filter(function (g) { return !!g.rerunAfterFix; });
  eq(marked.length, 2, '带重跑标记的组数');
  marked.forEach(function (g) {
    eq(g.rerunAfterFix.轮, 1, '组 ' + g.id + ' 重跑轮次');
    /* ★ 关键：显式 false，表示「已在 17 轮内、不额外追加」 */
    eq(g.rerunAfterFix.是否额外追加, false,
      '组 ' + g.id + ' 是否额外追加必须为 false');
    /* 该轮必须仍计入本组 turns（没被搬到矩阵外） */
    assert(g.turns.length >= 1, '组 ' + g.id + ' turns 为空');
  });
  /* 17 + 1（健康探测）= 18；18/19 轮不存在 */
  var sum = G.reduce(function (a, g) { return a + g.turns.length; }, 0);
  eq(sum + 1, 18, '总上限');
});
t('★ 健康探测单独计为第 18 次（矩阵 17 轮不含它）', function () {
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/预算口径: \{/.test(src), 'meta 缺 预算口径 段');
  assert(/总上限: 18/.test(src), '未写明总上限 18');
  assert(/正式矩阵轮次: GROUPS\.reduce/.test(src),
    '预算口径里的正式矩阵轮数应从 GROUPS **实算**，不许写死');
  assert(/健康探测: 1/.test(src), '未写明健康探测 1');
  assert(/额外追加: 0/.test(src), '未写明额外追加 0');
});
t('★ 旧样本处置措辞按用户指定原文', function () {
  var want = 'P1 修复前旧样本：排除，不计入 P3 统计；'
    + '本轮修复后重新发送样本：计入 P3 正式统计。';
  G.filter(function (g) { return !!g.rerunAfterFix; }).forEach(function (g) {
    eq(g.rerunAfterFix.旧样本处置, want, '组 ' + g.id + ' 旧样本处置措辞');
  });
});
t('★ P1 两份修复前样本不会被装入 P3 统计（断「无读取路径」，不靠文本缺席）', function () {
  /* ⚠️ 第一版断的是「脚本里不出现旧样本目录名」——**又栽在自指判据上**：
     那两个目录名恰恰写在 meta 的**排除声明**里（`旧样本排除口径`），
     声明「这两个目录不得并入」本身就得写出目录名。
     ⇒ 判据要断的是**行为**（有没有读盘合并的路径），不是**文本**。
     结构性判据：脚本只往 OUT_DIR 写；统计只来自 results（本次跑出来的）；
                 没有任何 readFileSync 指向样本目录。 */
  var src = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  /* ① 统计只来自 results（本次跑出来的），不合并任何历史样本 */
  assert(/results\.forEach/.test(src), '统计应来自 results');
  /* ② 唯一读盘入口是 CAPTURE_SRC（旁路模块源码），不是样本目录 */
  var reads = src.match(/readFileSync\([^)]*\)/g) || [];
  reads.forEach(function (r) {
    assert(!/样本/.test(r), '★ 存在读样本目录的调用：' + r);
  });
  ok('  （readFileSync 共 ' + reads.length
    + ' 处，均不指向样本目录；统计只来自 results）');
  /* ③ 排除声明确实写进了 meta（含「不得并入」与「仅保留为历史证据」） */
  assert(/一律不得并入 P3 正式统计/.test(src), '未写明「不得并入 P3 正式统计」');
  assert(/仅保留为历史证据/.test(src), '未写明「仅保留为历史证据」');
  /* ④ 落盘只写 OUT_DIR 一个目录 */
  var writes = src.match(/writeFileSync\([^)]*\)/g) || [];
  writes.forEach(function (w) {
    assert(!/样本-G4/.test(w), '★ 存在写旧样本目录的调用：' + w);
  });
  ok('  （writeFileSync 共 ' + writes.length + ' 处，均不指向旧样本目录）');
});
t('★ 预计第一批 G1 的实际请求数 = 3（独立会话，不受其它组影响）', function () {
  var g1 = G.filter(function (g) { return g.id === 1; })[0];
  assert(g1, '找不到 G1');
  eq(g1.turns.length, 3, 'G1 轮数');
  /* 无扇出：线下 callModel → requestOnce 一次调用 = 一次 fetch */
  var off = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');
  var seg = off.slice(off.indexOf('function callModel'),
    off.indexOf('function callModel') + 900);
  assert(/api\.requestOnce\(cand, messages/.test(seg),
    'callModel 未直接调 requestOnce（无扇出的前提变了）');
  assert(!/runChat/.test(seg), 'callModel 里出现 runChat ⇒ 可能有 retryN 扇出');
  var api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  var ro = api.slice(api.indexOf('function requestOnce'),
    api.indexOf('function streamOnce'));
  assert(!/for\s*\(/.test(ro) && !/while\s*\(/.test(ro),
    'requestOnce 内部出现循环 ⇒ 一次轮可能发多次');
  ok('  （G1 = 3 轮 ⇒ 3 次请求；callModel 无扇出、requestOnce 无循环）');
});

head('§10 预算闸仍为单次请求计数');
t('★ 预算闸仍 opt-in，且上限可注入', function () {
  var cap = fs.readFileSync(path.join(__dirname, 'lib', 'f2-body-capture.js'), 'utf8');
  assert(/opts\.budget/.test(cap), '预算闸实现被移除');
  assert(/budget\.limit = budget\.limit == null \? 1 : budget\.limit/.test(cap),
    '预算闸缺省上限不再是 1');
  var acc = fs.readFileSync(path.join(__dirname,
    'offline-f2-effect-acceptance.js'), 'utf8');
  assert(/SLEEPY_EFFECT_BUDGET/.test(acc), '缺 SLEEPY_EFFECT_BUDGET 入口');
  assert(/budget: window\.__BUDGET_LIMIT \? \{ limit: window\.__BUDGET_LIMIT \} : null/
    .test(acc), '预算闸未接进 installFetchBypass');
  assert(/请求预算: budgetState/.test(acc), '轮记录缺「请求预算」读回');
});
t('★ 限 1 时第 2 次被拒（纯 Node，不联网）', function () {
  var CAP = require('./lib/f2-body-capture.js');
  var hits = [];
  var w = {
    fetch: function (u) {
      hits.push(String(u));
      return Promise.resolve({ status: 200, clone: function () {
        return { text: function () { return Promise.resolve('{}'); } };
      } });
    },
    Date: Date
  };
  CAP.installFetchBypass(w, { budget: { limit: 1 } });
  var post = { method: 'POST', body: '{}' };
  return w.fetch('https://x.example.invalid/v1/chat', post)
    .then(function () { return w.fetch('https://x.example.invalid/v1/chat', post); })
    .then(function () { throw new Error('★ 第 2 次未被拒'); },
      function (e) {
        assert(/预算已用尽/.test(String(e && e.message)), '拒绝理由不对');
        eq(hits.length, 1, '到达 origFetch 次数');
        eq(w.__BUDGET.used, 1, 'used');
        eq(w.__BUDGET.rejected.length, 1, 'rejected 条数');
      });
});

head('§11 全程真实模型请求数 = 0');
t('★ 结构性证明：本测试不读真凭据、不启浏览器、沙箱内 fetch = 0', function () {
  /* ⚠️ 这里**不能扫全文关键词** —— 扫了四次都在扫到「判据自己」：
       ① 词只在注释里              → 剥注释即可
       ② 词在 require 过滤正则里    → 改查 require 的**模块名**
       ③ 词在 §4 那条**正当的**检查里（它要确认 SETUP 不含 XHR）
       ④ 词在 §4 注入的 `__API_KEY` 变量名里（本条断言自己要断的就是它）
     ⇒ 全文扫描永远过不了自己的判据。**别再试。**
     ⇒ 唯一靠得住的是**结构性判据**：
       (a) require 的模块里没有浏览器/网络驱动
       (b) 进程环境里没有真凭据
       (c) 沙箱注入值是明示的 stub
       (d) 沙箱是纯 Node vm，无真实 document
       (e) §4 已实测 SETUP 期间 fetch = 0 */
  var src = fs.readFileSync(__filename, 'utf8');
  var mods = (src.match(/require\(\s*'([^']+)'\s*\)/g) || [])
    .map(function (x) { return x.replace(/require\(\s*'| '\s*\)/g, ''); });
  var netMods = mods.filter(function (m) {
    return /playwright|puppeteer|chromium|selenium|^ws$|^http$/i.test(m);
  });
  eq(netMods, [], '本测试不得 require 任何浏览器/网络驱动模块');
  assert(!process.env.SLEEPY_API_KEY, '★ 环境中存在真 SLEEPY_API_KEY');
  assert(!process.env.SLEEPY_API_BASE, '★ 环境中存在真 SLEEPY_API_BASE');
  var injected = h && h.win && h.win.__API_KEY;
  if (injected) {
    assert(/STUB/.test(injected), '注入的凭据必须是明示的 stub');
    assert(!/^sk-[0-9A-Za-z]{20,}$/.test(injected),
      '注入值形态像真 key ⇒ 判定不可靠');
  }
  var w = h && h.win;
  assert(w, '未拿到沙箱 window（harness 未 boot？）');
  assert(typeof w.document === 'undefined' || !w.document.createEvent,
    '★ 沙箱里出现真实 document ⇒ 本测试可能真的在跑浏览器');
  ok('  （无浏览器驱动模块 · 环境无凭据 · 注入为 stub · 沙箱无真实 document）');
});
t('★ 生产四文件与本轮基线逐字节一致（本测试只读、不改生产）', function () {
  var BASE = 'D:/projects/sleepy-baseline-2026-10-05-pre13';
  /* ★ 2026-10-05 更新：page-offline.js（取证批）与 prompt-engine.js
     （七项文风批 + groupOffline S5 接入）先后获准改动，移出本清单；
     锚定的 pre13 是上上批基线，两者的差异均属批准改动。
     prompt-engine 的接线完整性由在线迁移测试（重建等式）继续锁定。 */
  ['api.js', 'behavior-text.js']
    .forEach(function (f) {
      var a = H.sha256(fs.readFileSync(path.join(ROOT, f)));
      var b = H.sha256(fs.readFileSync(path.join(BASE, f)));
      assert(a === b, f + ' 与本轮基线不一致 ⇒ 本测试不该改它');
    });
});

/* ---------- 汇总 ---------- */
runQueue().then(function () {
  head('────────');
  process.stdout.write('通过 ' + pass + ' / 失败 ' + fail + '\n');
  if (fail) {
    process.stdout.write('❌ 红项：\n' + problems.map(function (p) {
      return '   - ' + p; }).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('✅ 全绿（本测试**不启动浏览器、不发任何网络请求、不调模型**）\n');
  process.stdout.write('★ 真实模型请求数 = 0（结构性证明见 §11；SETUP 期间 fetch 实测 0）\n');
  var sum = G.reduce(function (a, g) { return a + g.turns.length; }, 0);
  process.stdout.write('★ 矩阵：7 组 / ' + sum + ' 轮（G4/G7 各含 1 轮「修复后重跑」）\n');
  process.stdout.write('★ 预计真实请求 —— 口径 A（设计上限）：'
    + (sum + 1) + ' = ' + sum + ' 轮 + 健康探测 1\n');
  process.stdout.write('★ 预计真实请求 —— 口径 B（G4/G7 第 1 轮均重发）：'
    + (sum + 1 + 2) + ' = ' + sum + ' + 健康探测 1 + 2 轮重发\n');
});
