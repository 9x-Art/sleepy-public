#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-edge-test.js
   —— 边界条件的零网络测试（**共用正式调度逻辑 + 请求替身**）

   ★ 覆盖（用户 2026-10-04 指定）：
     ① 中途失败        ② 末轮失败        ③ 单轮失败
     ④ 明确未发出      ⑤ 发送后采集异常   ⑥ 持久化失败
     ⑦ 第二组的发送替身**实际调用次数为零**
   ★ 检查对象：**最终汇总与落盘 JSON**，不只是源码字符串或状态布尔值。
   ★ 网络阻断：**真的阻断**（见下方 BLOCK_NETWORK 实现），不是「保证不调用」。

   ⚠️ 本批不扩做真实请求体采集，**不给旧样本补造发送证据**。
   ============================================================ */
'use strict';

/* ---------- ★ 网络阻断：真的把 fetch 打掉 ---------- */
/* 不是「小心不要调用」，而是**从进程层面让它调不到**：
   覆盖 global.fetch / http.request / https.request / net.connect / dns.lookup，
   任何调用都抛错并记账。测试结束断言「一次都没被调到」。 */
var BLOCK_NET = (function () {
  var hits = [];
  function boom(name) {
    return function () { hits.push(name); throw new Error("网络已被测试阻断：" + name); };
  }
  /* ⚠️ 阻断必须**窄**：第一版把 net/dns/tls 整模块方法都替换，
     结果**进程静默退出**（Node 内部自己也用 net/dns，改坏后事件循环直接停）。
     ⇒ 只挡真正会发包的入口，不动 dns.lookup 等 Node 内部依赖。 */
  var savedFetch = global.fetch;
  var http = require("http"), https = require("https"), net = require("net");
  var saved = {
    "http.request": http.request, "http.get": http.get,
    "https.request": https.request, "https.get": https.get,
    "net.connect": net.connect, "net.createConnection": net.createConnection
  };
  global.fetch = boom("fetch");
  http.request = boom("http.request"); http.get = boom("http.get");
  https.request = boom("https.request"); https.get = boom("https.get");
  net.connect = boom("net.connect"); net.createConnection = boom("net.createConnection");
  return {
    hits: hits,
    restore: function () {
      global.fetch = savedFetch;
      http.request = saved["http.request"]; http.get = saved["http.get"];
      https.request = saved["https.request"]; https.get = saved["https.get"];
      net.connect = saved["net.connect"]; net.createConnection = saved["net.createConnection"];
    }
  };
})();

var ACC = require('./offline-f2-effect-acceptance.js');
var runGroupSchedule = ACC.runGroupSchedule;
var hardStopKind = ACC.hardStopKind;
var makeSnapshotWriter = ACC.makeSnapshotWriter;

var pass = 0, fail = 0, FAILS = [];
function ok(cond, name, extra) {
  if (cond) { pass++; process.stdout.write('  ✓ ' + name + '\n'); }
  else { fail++; FAILS.push(name); process.stdout.write('  ✗ ' + name + (extra ? ' → ' + extra : '') + '\n'); }
}
function section(t) { process.stdout.write('\n' + t + '\n'); }

/* ---------- 造轮次记录 ---------- */
function goodTurn(ti, input) {
  return { 轮: ti + 1, 输入: input, 已落地: true, 最终阶段: 'model-returned',
    原始请求结果: { stage: 'ok', status: 200, len: 200 },
    归因: { status: 200, finish_reason: 'stop', usage: { completion_tokens: 90 } },
    出站messages: { 条数: 10 }, 原始输出: '正文' + ti, 段落: [{ type: 'prose', text: 'x' }],
    /* 2026-10-05（B）：成功响应也必须带请求体证据，否则 hardStopKind 判缺证 */
    发送瞬间请求体: { bodySHA256: 'stub-' + (ti + 1), model: 'stub-model',
      messages: [{ role: 'user', content: 't' + (ti + 1) }], bodyCaptureError: null },
    诊断: { requestId: ti + 1, seq: (ti + 1) * 2, stage: 'model-returned' } };
}
function badTurn(ti, input, stage) {
  return { 轮: ti + 1, 输入: input, 已落地: false, 最终阶段: 'request-failed-unknown',
    原始请求结果: { stage: stage || 'timeout', ms: 120016, error: '超时' },
    归因: null, 出站messages: null, 原始输出: null, 段落: null,
    诊断: { requestId: ti + 1, seq: (ti + 1) * 2, stage: 'request-failed-unknown' } };
}
/* 采集异常：已发出、已落地，但诊断缺失 → 不得记为零请求 */
function collectAnomalyTurn(ti, input) {
  return { 轮: ti + 1, 输入: input, 已落地: true, 最终阶段: 'model-returned',
    原始请求结果: { stage: 'ok', status: 200, len: 180 },
    归因: { status: 200, finish_reason: 'stop' },
    出站messages: { 条数: 10 }, 原始输出: '正文', 段落: [{ type: 'prose', text: 'x' }],
    诊断: null, 采集异常: true };
}

/* ============================================================
   §0 前置
   ============================================================ */
(async function main() {
section('§0 前置 · 网络已阻断 + 实现是共用的');
ok(typeof runGroupSchedule === 'function', 'runGroupSchedule 可用');
var src = runGroupSchedule.toString();
ok(src.indexOf('persist') >= 0, '实现内部调用注入的 persist');
ok(src.indexOf('trust(') >= 0, '实现内部调用依赖判定（可注入）');
ok(/global\.fetch = boom/.test(BLOCK_NET.hits.length ? 'true' : 'true') ||
   (typeof global.fetch === 'function' && /网络已被测试阻断/.test(String(global.fetch))),
  '★ global.fetch 已被替换为阻断版');

/* ============================================================
   §1 中途失败（第 2 轮）
   ============================================================ */
section('§1 中途失败');
var s1 = await runGroupSchedule({ id: 'E1', turns: ['a', 'b', 'c'],
  send: async (ti, i) => (ti === 1 ? badTurn(ti, i) : goodTurn(ti, i)),
  persist: async () => {}, stopKind: hardStopKind });
ok(s1.确认发送数 === 2, '确认发送 2 次', String(s1.确认发送数));
ok(s1.轮次.length === 3, '第三轮补记为未跑（共 3 条）', String(s1.轮次.length));
ok(s1.轮次[2].未跑 === true, '第三轮未跑');
ok(/失败/.test(s1.轮次[2].未跑原因), '未跑原因指向失败', s1.轮次[2].未跑原因);
ok(/网络|超时/.test(s1.停机原因), '停机原因=网络/超时', s1.停机原因);
ok(s1.终态 === s1.停机原因, '★ 终态已记录');

/* ============================================================
   §2 ★ 末轮失败（本轮修掉的那个）
   ============================================================ */
section('§2 ★ 末轮失败（不再依赖「还有下一轮」）');
var s2 = await runGroupSchedule({ id: 'E2', turns: ['a', 'b', 'c'],
  send: async (ti, i) => (ti === 2 ? badTurn(ti, i) : goodTurn(ti, i)),
  persist: async () => {}, stopKind: hardStopKind });
ok(s2.确认发送数 === 3, '三轮都发了', String(s2.确认发送数));
ok(/网络|超时/.test(s2.停机原因 || ''), '★ 末轮失败被抓住并停机', s2.停机原因);
ok(s2.登记 && s2.登记.停机轮 === 3, '登记写明停机在第 3 轮', JSON.stringify(s2.登记));
ok(s2.登记 && s2.登记.正常跑完 === undefined, '★ 没有被误记成「正常跑完」');

/* ============================================================
   §3 单轮组失败
   ============================================================ */
section('§3 单轮组失败');
var s3 = await runGroupSchedule({ id: 'E3', turns: ['唯一一轮'],
  send: async (ti, i) => badTurn(ti, i),
  persist: async () => {}, stopKind: hardStopKind });
ok(s3.确认发送数 === 1, '发了 1 次', String(s3.确认发送数));
ok(/网络|超时/.test(s3.停机原因 || ''), '★ 单轮组失败也停机', s3.停机原因);
ok(s3.轮次.length === 1 && s3.轮次[0].已落地 === false, '失败轮记录保留');

/* ============================================================
   §4 明确未发出 → 不计发送数
   ============================================================ */
section('§4 明确未发出 → 确认发送数不加');
var s4 = await runGroupSchedule({ id: 'E4', turns: ['a', 'b', 'c'],
  send: async (ti, i) => {
    if (ti === 0) return { 轮: 1, 输入: i, 未发出: { sent: false, why: 'send disabled' },
      原始请求结果: null, 归因: null, 出站messages: null, 原始输出: null, 段落: null, 诊断: null };
    return goodTurn(ti, i);
  },
  persist: async () => {}, stopKind: hardStopKind });
ok(s4.确认发送数 === 0, '★ 未发出不计入确认发送数', String(s4.确认发送数));
ok(s4.调度次数 === 1, '调度只走了 1 轮', String(s4.调度次数));
ok(/未发出/.test(s4.停机原因 || ''), '停机原因写明「未发出」', s4.停机原因);
ok(s4.轮次.length === 3, '剩余两轮补记未跑');
ok(s4.轮次[1].未跑 === true && s4.轮次[2].未跑 === true, '两轮都标未跑');

/* ============================================================
   §5 发送后采集异常 → 不得记为零请求
   ============================================================ */
section('§5 发送后采集异常 → 计入未知状态，不记零请求');
var s5 = await runGroupSchedule({ id: 'E5', turns: ['a', 'b'],
  send: async (ti, i) => (ti === 0 ? collectAnomalyTurn(ti, i) : goodTurn(ti, i)),
  persist: async () => {}, stopKind: hardStopKind });
ok(s5.确认发送数 >= 1, '★ 采集异常仍算「已发出」', String(s5.确认发送数));
ok(/采集关联异常/.test(s5.停机原因 || ''), '停机原因=采集关联异常', s5.停机原因);
ok(s5.轮次[0].已落地 === true, '该轮记录为已落地（不是没发）');

/* ============================================================
   §6 持久化失败 → 停止后续轮与后续组
   ============================================================ */
section('§6 持久化失败 → 停止后续轮与后续组');
var sent6 = [], threw6 = null;
try {
  await runGroupSchedule({ id: 'E6', turns: ['a', 'b', 'c'],
    send: async (ti, i) => { sent6.push(i); return goodTurn(ti, i); },
    persist: async (st, phase) => { if (phase === '轮次' && st.确认发送数 >= 2) {
      var e = new Error('模拟写盘失败'); e.code = 'EIO'; throw e; } },
    stopKind: hardStopKind });
} catch (e) { threw6 = e; }
ok(sent6.length === 2, '★ 第二次写盘失败后不再发第 3 轮', '实际 ' + sent6.length);
ok(threw6 && /模拟写盘失败/.test(threw6.message), '★ 错误未被吞且原样传出');
ok(threw6 && threw6.code === 'EIO', '错误码也带出来了');

/* ============================================================
   §7 ★ 第二组的发送替身实际调用次数为零
   ============================================================ */
section('§7 ★ 第一组失败 → 第二组发送替身实际调用次数为 0');
var g1calls = 0, g2calls = 0;
var g1 = await runGroupSchedule({ id: 'G1', turns: ['a', 'b', 'c'],
  send: async (ti, i) => { g1calls++; return ti === 1 ? badTurn(ti, i) : goodTurn(ti, i); },
  persist: async () => {}, stopKind: hardStopKind });
ok(g1.停止整跑 === true, '第一组标记停止整跑');
ok(!!g1.停机原因, '第一组有停机原因', g1.停机原因);

/* ★ 照抄正式流程（main）的判断：只有没停机才开下一组。
   这里**真的去建第二组的替身并统计调用次数** ——
   上一版写成 'if(停机){ if(!停机){...} }' 的空壳，压根没调用替身，测不出任何东西。 */
function openNextGroup(调度态) {
  if (调度态.停机原因) return null;      /* break：不启动后续组 */
  return { id: 'G2', turns: ['x'],
    send: async (ti, i) => { g2calls++; return goodTurn(ti, i); },
    persist: async () => {}, stopKind: hardStopKind };
}
var g2spec = openNextGroup(g1);
ok(g2spec === null, '★ 正式流程判断：不再开第二组');
if (g2spec) { await runGroupSchedule(g2spec); }   /* 若判断错，这里会真的调用 */
ok(g2calls === 0, '★ 第二组发送替身实际调用次数 = 0', String(g2calls));
ok(g1calls === 2, '第一组发送替身调用 2 次', String(g1calls));

/* ============================================================
   §8 落盘 JSON：检查真实文件内容
   ============================================================ */
section('§8 落盘 JSON 的实际内容');
var os = require('os'), path = require('path'), fs = require('fs');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f2edge-'));
var w = makeSnapshotWriter(tmp);
var groups = [];
async function runAndSnap(id, turns, sendFn) {
  var 记录集 = { 样本组: id, 名称: '组' + id, 轮次: null };
  var st = await runGroupSchedule({ id: id, turns: turns,
    send: sendFn,
    persist: async function (s, phase) {
      记录集.轮次 = s.轮次;
      await w(记录集, s, null, []);
    },
    stopKind: hardStopKind });
  记录集.轮次 = st.轮次;
  groups.push(记录集);
  return st;
}
var gA = await runAndSnap(4, ['a', 'b', 'c'], async (ti, i) =>
  (ti === 1 ? badTurn(ti, i) : goodTurn(ti, i)));
var gB = await runAndSnap(7, ['x'], async (ti, i) => goodTurn(ti, i));

var snaps = fs.readdirSync(tmp).filter(function (n) { return /\.json$/.test(n); }).sort();
ok(snaps.length > 0, '快照文件已生成', String(snaps.length));
/* 逐个读回来检查 */
var allSnaps = snaps.map(function (n) { return JSON.parse(fs.readFileSync(path.join(tmp, n), 'utf8')); });
var group4Snaps = allSnaps.filter(function (s) { return s.元信息.样本组 === 4; });
var group7Snaps = allSnaps.filter(function (s) { return s.元信息.样本组 === 7; });
ok(group4Snaps.length > 0, '★ 组号 4 的快照存在（字段名是「样本组」）');
ok(group7Snaps.length > 0, '★ 组号 7 的快照存在');
ok(allSnaps.every(function (s) { return s.元信息.样本组 !== undefined; }),
  '★ 每份快照都有「样本组」字段（契约统一）');
ok(allSnaps.every(function (s) { return s.样本[0].样本组 === s.元信息.样本组; }),
  '★ 元信息与样本体里的组号一致');
/* 终态快照必须含停机原因 */
var last4 = group4Snaps[group4Snaps.length - 1];
ok(last4.元信息.停机原因 && /网络|超时/.test(last4.元信息.停机原因),
  '★ 终态快照保存了停机原因', last4.元信息.停机原因);
ok(last4.元信息.阶段.indexOf('终态') >= 0 || last4.元信息.阶段 === '逐轮快照（运行中，尚未收尾）',
  '阶段字段存在', last4.元信息.阶段);
ok(last4.样本[0].轮次.length === 3, '★ 落盘含 3 轮（含未跑）', String(last4.样本[0].轮次.length));
ok(last4.样本[0].轮次[2].未跑 === true, '★ 落盘里第三轮标着未跑');
ok(last4.样本[0].轮次[2].原始请求结果 === null,
  '★ 未跑轮没有伪造请求结果（不补造历史请求）');
ok(last4.样本[0].轮次[2].出站messages === null,
  '★ 未跑轮没有伪造出站消息');
/* 计数口径 */
ok(last4.元信息.确认发送数 === 2, '落盘里确认发送数 = 2', String(last4.元信息.确认发送数));
ok(last4.元信息.调度次数 === 2, '落盘里调度次数 = 2', String(last4.元信息.调度次数));
fs.rmSync(tmp, { recursive: true, force: true });

/* ============================================================
   §9 网络阻断的有效性
   ============================================================ */
section('§9 ★ 网络阻断确实有效');
var fetchBlocked = false;
try { await global.fetch('http://127.0.0.1:1/'); }
catch (e) { fetchBlocked = /网络已被测试阻断/.test(e.message); }
ok(fetchBlocked, '★ 调 fetch 会抛「网络已被测试阻断」');
ok(BLOCK_NET.hits.length === 1, '阻断计数器记下了这次调用', BLOCK_NET.hits.join(','));
BLOCK_NET.restore();

/* ---------- 收尾 ---------- */
process.stdout.write('\n────────\n');
process.stdout.write('通过 ' + pass + ' / 失败 ' + fail + '\n');
if (fail) process.stdout.write('红项: ' + FAILS.join(' | ') + '\n');
process.stdout.write(fail === 0
  ? '✅ 边界条件已用**零网络**测试锁住（检查落盘 JSON，不是源码字符串）。\n'
  : '❌ 有红项。\n');
})().then(function () {
  /* ★ exit 必须在闭包**内**、且等 main 真正跑完。
     之前它落在闭包外 → main 还没 await 完就退出了 →
     **exit code 却是 0**（看起来成功），实际只跑到 §1。 */
  process.exit(fail === 0 ? 0 : 1);
}).catch(function (e) {
  process.stdout.write("测试脚本异常：" + (e && e.stack ? e.stack : e) + String.fromCharCode(10));
  process.exit(1);
});

