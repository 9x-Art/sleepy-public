#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-depstop-test.js
   —— 「失败后不发依赖轮」零网络测试（**不联网、不发任何请求**）

   ★ 要锁住的规则（用户 2026-10-04 明确要求，已不是「已知限制」）：
       客户端**无法预知**会不会超时（服务端行为），
       但**可以在收到失败结果后阻止下一轮** —— 那才是可控的那一半。
       P1 曾把依赖判断放在「轮次结束后」，
       结果 G4-2 超时后 G4-3 **照常发出**，多花一次请求。

   ★ 为什么之前没法测：判定逻辑**内嵌在轮次循环里**，
     只能在真跑时暴露 —— 而真跑一次要花一次钱。
     现在判定已抽成纯函数 `prevTurnTrusted` 并导出，
     **任何分支都能用桩数据零成本验证**。

   ★ 本测试用**真实样本数据**（P1 的 G4-2 超时记录）作对照，
     不是凭空编的 —— 这样测出来的行为与当时实际情况一致。

   跑法：node scripts/offline-f2-depstop-test.js
   ============================================================ */
'use strict';

var ACC = require('./offline-f2-effect-acceptance.js');
var prevTurnTrusted = ACC.prevTurnTrusted;
var APPROVED = ACC.APPROVED;

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; process.stdout.write('  ✓ ' + name + '\n'); }
  else { fail++; process.stdout.write('  ✗ ' + name + (extra ? ' → ' + extra : '') + '\n'); }
}
function section(t) { process.stdout.write('\n' + t + '\n'); }

section('§0 前置 · 纯函数可加载且不联网');
ok(typeof prevTurnTrusted === 'function', 'prevTurnTrusted 是函数');
ok(APPROVED && APPROVED.maxTokens === 8192 && APPROVED.temperature === 0.85,
  'APPROVED 参数已导出（timeout 仍为 120s，符合用户决定）', JSON.stringify(APPROVED));
ok(APPROVED.timeoutSec === 120, '★ timeout 保持 120s（用户 2026-10-04 选择不动）');

/* ============================================================
   §1 正向：只有「可信回复」才允许下一轮发出
   ============================================================ */
section('§1 正向 · 可信回复 → 允许发出下一轮');
var good = {
  已落地: true, 最终阶段: 'model-returned',
  原始请求结果: { stage: 'ok', status: 200, len: 332 },
  原始输出: '沈砚看了对方一眼。', 段落: [{ type: 'prose', text: '沈砚看了对方一眼。' }]
};
var g = prevTurnTrusted(good);
ok(g.ok === true, 'HTTP 200 + 已落地 + 有内容 → 允许下一轮', JSON.stringify(g));
ok(g.why === '', '通过时不带理由');

/* ============================================================
   §2 ★ 核心场景：G4-2 超时 → G4-3 必须被拦截
   下面两条是**真实样本数据**（P1 跑出来的），不是编的。
   ============================================================ */
section('§2 ★ 真实场景复现：G4-2 超时 → G4-3 不得发出');
var realTimeout = {
  轮: 2, 输入: '我坐下了。',
  已落地: false, 最终阶段: 'request-failed-unknown',
  原始请求结果: { stage: 'timeout', ms: 120016, error: '超时：120 秒没有响应' },
  原始输出: null, 段落: null
};
var t2 = prevTurnTrusted(realTimeout);
ok(t2.ok === false, '★ 真实超时记录 → 下一轮被拦截');
ok(/非 model-returned|未落地/.test(t2.why), '给出可读理由：' + t2.why);

/* 模拟脚本行为：拦截后会把剩余轮登记为未跑 */
var group = { turns: ['我到了。', '我坐下了。', '算了，你看着办。'] };
var recs = [{ 轮: 1, 已落地: true, 最终阶段: 'model-returned',
  原始请求结果: { stage: 'ok', status: 200, len: 332 },
  原始输出: '阁楼的窗户半开着。', 段落: [{ type: 'prose', text: '阁楼的窗户半开着。' }] }, realTimeout];
var ti = 2;   /* 现在要发第 3 轮 */
var chk = prevTurnTrusted(recs[ti - 1]);
var blocked = !chk.ok;
ok(blocked === true, '★ 第 3 轮被拦截（不会发出）');
/* 拦截后登记剩余轮为未跑 —— 逐轮核对 */
if (blocked) {
  for (var ri = ti; ri < group.turns.length; ri++) {
    recs.push({ 轮: ri + 1, 输入: group.turns[ri], 未跑: true,
      未跑原因: '依赖轮被拦截：' + chk.why });
  }
}
ok(recs.length === 3, '三轮全部有记录（不丢轮次）：' + recs.length);
ok(recs[2].未跑 === true && recs[2].未跑 === true, '第 3 轮标记未跑');
ok(/依赖轮被拦截/.test(recs[2].未跑原因), '未跑原因写明「依赖轮被拦截」');
var sentCount = recs.filter(function (r) { return !r.未跑; }).length;
ok(sentCount === 2, '★ 实际只发 2 次（第 3 轮未发）', 'sentCount=' + sentCount);

/* ============================================================
   §3 各种失败形态都必须拦住（分支覆盖）
   ============================================================ */
section('§3 分支覆盖 · 六种失败形态全部被拦');
var cases = [
  ['超时', { 已落地: false, 最终阶段: 'request-failed-unknown',
    原始请求结果: { stage: 'timeout' } }],
  ['网络失败', { 已落地: false, 最终阶段: 'request-failed-unknown',
    原始请求结果: { stage: 'network' } }],
  ['HTTP 403', { 已落地: false, 最终阶段: 'request-rejected',
    原始请求结果: { stage: 'http', status: 403 } }],
  ['HTTP 200 但内容空（预算截断）', { 已落地: false, 最终阶段: 'model-returned',
    原始请求结果: { stage: 'ok', status: 200, len: 0 } }],
  ['落地了但没有原始请求结果', { 已落地: true, 最终阶段: 'model-returned',
    原始请求结果: null }],
  ['解析失败降级（有内容但无段落）', { 已落地: true, 最终阶段: 'model-returned',
    原始请求结果: { stage: 'ok', status: 200, len: 165 } }],
  ['上一轮未发出', { 未发出: { sent: false, why: 'send disabled' } }],
  ['上一轮未跑', { 未跑: true }]
];
cases.forEach(function (c) {
  var r = prevTurnTrusted(c[1]);
  ok(r.ok === false, '拦：' + c[0], r.ok ? '竟然放行了' : r.why);
});
/* 反向：解析失败降级那类**有内容**，但已落地为 false，仍应拦住 ——
   上一条已覆盖，这里再确认「不会因为有 len 就放行」 */
ok(prevTurnTrusted({ 已落地: false, 最终阶段: 'model-returned',
  原始请求结果: { stage: 'ok', status: 200, len: 165 } }).ok === false,
  '★ 已落地=false 时，即使有内容也拦住（内容不算「可信回复」）');

section("§3b 降级轮必须拦住（解析器把失败标记当正文）");
/* 降级轮的真实形态：HTTP 200 + 有内容 + 「落地」了，但正文是失败标记 */
[["PARSE_FAIL_MARK", "这一轮的回复格式出了点问题。"],
 ["PARSE_FAIL_HINT", "这一轮的回复格式出了点问题，原始返回可展开查看。"],
 ["PARSE_FAIL_EMPTY", "（本次没有可查看的原始内容）"]].forEach(function (c) {
  var r = prevTurnTrusted({
    已落地: true, 最终阶段: "model-returned",
    原始请求结果: { stage: "ok", status: 200, len: 165 },
    原始输出: c[1],
    段落: [{ type: "prose", text: c[1] }]
  });
  ok(r.ok === false, "拦降级：" + c[0], r.ok ? "竟然放行了" : r.why);
});
/* ⚠️ 长度接近的**正常**正文不得被误伤 */
["他已经把湿外套搭在椅背上了。", "对方的外套在滴水，椅背下面积了一小摊。"].forEach(function (txt) {
  ok(prevTurnTrusted({
    已落地: true, 最终阶段: "model-returned",
    原始请求结果: { stage: "ok", status: 200, len: txt.length },
    原始输出: txt, 段落: [{ type: "prose", text: txt }]
  }).ok === true, "不误伤正常正文：" + txt.slice(0, 12) + "…");
});
/* 无段落一律拦（曾写成「且正文非空才拦」→ 两者都缺时放行，是个洞） */
ok(prevTurnTrusted({ 已落地: true, 最终阶段: "model-returned",
  原始请求结果: { stage: "ok", status: 200, len: 165 } }).ok === false,
  "★ 无段落一律拦（不要求正文同时非空）");
ok(prevTurnTrusted({ 已落地: true, 最终阶段: "model-returned",
  原始请求结果: { stage: "ok", status: 200, len: 165 },
  原始输出: "有正文但没段落", 段落: [] }).ok === false,
  "★ 空段落数组也拦");

section('§4 缺记录 / 空输入');
ok(prevTurnTrusted(null).ok === false, '上一轮为 null → 拦住');
ok(prevTurnTrusted(undefined).ok === false, '上一轮为 undefined → 拦住');
ok(prevTurnTrusted({}).ok === false, '上一轮是空对象 → 拦住');

section('§5 阳性对照 · 合法路径确实放行（防「全都拦」的空转）');
ok(prevTurnTrusted({ 已落地: true, 最终阶段: 'model-returned',
  原始请求结果: { stage: 'ok', status: 200, len: 1 },
  原始输出: '短', 段落: [{ type: 'prose', text: '短' }] }).ok === true,
  '内容长度 1 也算可信（不是靠长度阈值卡的）');
ok(prevTurnTrusted({ 已落地: true, 最终阶段: 'model-returned',
  原始请求结果: { stage: 'ok', status: 200, len: 99999 },
  原始输出: '长', 段落: [{ type: 'prose', text: '长' }] }).ok === true,
  '长内容也放行');
/* 阴性对照：改一个关键字段就应变 —— 证明判据真的有判别力 */
var mutate = function (base, k, v) { var c = Object.assign({}, base); c[k] = v; return c; };
ok(prevTurnTrusted(mutate(good, '最终阶段', 'request-rejected')).ok === false,
  '把阶段改成 request-rejected → 立即拦住（判据对该字段敏感）');
ok(prevTurnTrusted(mutate(good, '已落地', false)).ok === false,
  '把已落地改成 false → 立即拦住（判据对该字段敏感）');
var g2 = Object.assign({}, good);
g2.原始请求结果 = { stage: 'ok', status: 200, len: 0 };
ok(prevTurnTrusted(g2).ok === false,
  '把 len 改成 0 → 立即拦住（判据对内容长度敏感）');

/* ---------- 收尾 ---------- */
process.stdout.write('\n────────\n');
process.stdout.write('通过 ' + pass + ' / 失败 ' + fail + '\n');
process.stdout.write(fail === 0
  ? '✅ 「失败后不发依赖轮」已用**零网络**测试锁住。\n'
  : '❌ 有红项：规则没锁住，别发付费请求。\n');
process.exit(fail === 0 ? 0 : 1);
