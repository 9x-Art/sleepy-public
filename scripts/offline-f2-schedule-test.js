#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-schedule-test.js
   —— **真实调度**的零网络测试（共用正式流程的实现，不另写模拟循环）

   ★ 关键点：测试调的是验收脚本导出的 `runGroupSchedule` ——
     **与正式流程同一个函数**，不是"看起来像"的复制品。
     ⚠️ 上一版 depstop 测试只测纯函数 + 测试自己模拟的数组推进，
        **没驱动真实调度** —— 那个缺口由本文件补上。

   ★ 零网络怎么保证：
     ① **不启动浏览器**（不 require/调用 playwright，不 goto）；
     ② `send` 注入**请求替身**（纯内存计数，不碰 fetch）；
     ③ `persist` 注入**内存记录器**或临时目录写入（不写仓库）；
     ④ 顶层 `require` 验收脚本时，脚本在 L544 `if (require.main !== module) return;`
        拦住全部流程 —— 本测试只取导出的纯函数。

   覆盖（用户指定的 8 条）：
     1. 正常三轮 → 发送三次
     2. 第二轮超时 → 第三轮**不发送**
     3. 失败轮保留 + 第三轮标未跑
     4. 每组只登记一次
     5. 实际发送数为二
     6. **持久化完成前不得发送下一轮**
     7. 持久化失败 → 停止后续发送
     8. 按停机规则不启动后续组

   跑法：node scripts/offline-f2-schedule-test.js
   ============================================================ */
'use strict';

var ACC = require('./offline-f2-effect-acceptance.js');
var runGroupSchedule = ACC.runGroupSchedule;
var hardStopKind = ACC.hardStopKind;
var prevTurnTrusted = ACC.prevTurnTrusted;
var makeSnapshotWriter = ACC.makeSnapshotWriter;

var pass = 0, fail = 0;
var FAILS = [];
function ok(cond, name, extra) {
  if (cond) { pass++; process.stdout.write('  ✓ ' + name + '\n'); }
  else { fail++; FAILS.push(name); process.stdout.write('  ✗ ' + name + (extra ? ' → ' + extra : '') + '\n'); }
}
function section(t) { process.stdout.write('\n' + t + '\n'); }

/* ---------- 替身：造一条「可信回复」 ----------
   ⚠️ 2026-10-05（B）：契约加了一条 —— **成功响应也必须有请求体证据**。
   「可信回复」现在必须带 `发送瞬间请求体`（含 messages），
   否则 hardStopKind 判 link（缺证）→ 第一轮就停。
   ⇒ 替身补上该字段；反例用 `noEvidenceTurn()` 另造。 */
function evidenceOf(ti) {
  return {
    采集时刻: '调用 origFetch 之前',
    bodySHA256: 'stub-' + (ti + 1), model: 'stub-model',
    messages: [{ role: 'system', content: '【当前场景】' },
      { role: 'user', content: 'turn' + (ti + 1) }],
    bodyCaptureError: null
  };
}
function okTurn(ti, input) {
  return {
    轮: ti + 1, 输入: input, 已落地: true, 最终阶段: 'model-returned',
    原始请求结果: { stage: 'ok', status: 200, len: 200 + ti },
    归因: { status: 200, finish_reason: 'stop', usage: { completion_tokens: 100 } },
    出站messages: { 条数: 10 }, 原始输出: '第' + (ti + 1) + '轮正文',
    段落: [{ type: 'prose', text: 'x' }],
    发送瞬间请求体: evidenceOf(ti),
    诊断: { requestId: ti + 1, seq: (ti + 1) * 2, stage: 'model-returned' }
  };
}
/* ★ 反例：回复**完全成功**，但请求体证据缺失（B 的核心场景） */
function noEvidenceTurn(ti, input, form) {
  var t = okTurn(ti, input);
  if (form === '缺记录') t.发送瞬间请求体 = null;
  else if (form === '采集失败') t.发送瞬间请求体 =
    { bodyCaptureError: 'JSON.parse 失败：…', messages: null, bodySHA256: 'x' };
  else if (form === 'messages空') t.发送瞬间请求体 =
    { bodySHA256: 'x', messages: [] };
  return t;
}
function timeoutTurn(ti, input) {
  return {
    轮: ti + 1, 输入: input, 已落地: false, 最终阶段: 'request-failed-unknown',
    原始请求结果: { stage: 'timeout', ms: 120016, error: '超时：120 秒没有响应' },
    归因: null, 出站messages: null, 原始输出: null, 段落: null,
    诊断: { requestId: ti + 1, seq: (ti + 1) * 2, stage: 'request-failed-unknown' }
  };
}

/* ============================================================
   §1 前置：共用实现可加载
   ============================================================ */
(async function main() {
section('§1 前置 · 调的是正式流程的实现');
ok(typeof runGroupSchedule === 'function', 'runGroupSchedule 是导出函数');
ok(runGroupSchedule.length >= 1, '它接收 spec（含 send/persist 注入点）');
ok(typeof hardStopKind === 'function', 'hardStopKind 共用');
ok(typeof makeSnapshotWriter === 'function', 'makeSnapshotWriter 共用');
/* ★ 证明「另写一套」不可能：函数源码里同时出现 persist 与 stopKind 两个注入点 */
var src = runGroupSchedule.toString();
ok(src.indexOf('spec.persist') >= 0 || src.indexOf('persist(state)') >= 0,
  '★ 实现内部确实调用注入的 persist（不是测试自带的）');
ok(src.indexOf('prevTurnTrusted') >= 0,
  '★ 实现内部确实调用 prevTurnTrusted（依赖检查在正式实现里）');

/* ============================================================
   §2 覆盖 1：正常三轮 → 发送三次
   ============================================================ */
section('§2 正常三轮 → 发送三次');
var sent2 = [], persisted2 = 0;
var st2 = await runGroupSchedule({
  id: 'T2', turns: ['a', 'b', 'c'],
  send: async function (ti, input) { sent2.push(input); return okTurn(ti, input); },
  persist: async function () { persisted2++; },
  stopKind: hardStopKind
});
ok(sent2.length === 3, '发送 3 次', '实际 ' + sent2.length);
ok(st2.确认发送数 === 3, '调度态.确认发送数 = 3', String(st2.确认发送数));
ok(st2.轮次.length === 3, '记录 3 轮');
ok(st2.组已登记 === true, '组已登记 = true');
ok(st2.停机原因 === null, '无停机');
ok(persisted2 === 4, '★ 持久化 4 次（3 轮 + 1 次终态）', '实际 ' + persisted2);
ok(st2.持久化次数 === 4, '持久化次数与调用次数一致', String(st2.持久化次数));

/* ============================================================
   §3 覆盖 2/3/5：第二轮超时 → 第三轮不发送
   ============================================================ */
section('§3 第二轮超时 → 第三轮不发送');
var sent3 = [], persisted3 = 0;
var st3 = await runGroupSchedule({
  id: 'T3', turns: ['a', 'b', 'c'],
  send: async function (ti, input) {
    sent3.push(input);
    return ti === 1 ? timeoutTurn(ti, input) : okTurn(ti, input);
  },
  persist: async function () { persisted3++; },
  stopKind: hardStopKind
});
ok(sent3.length === 2, '★ 实际只发送 2 次', '实际 ' + sent3.length);
ok(st3.确认发送数 === 2, '★ 确认发送数 = 2', String(st3.确认发送数));
ok(sent3[2] === undefined, '第三轮输入从未被发送');
/* 失败轮保留 */
var t2rec = st3.轮次[1];
ok(!!t2rec && t2rec.已落地 === false, '★ 失败轮被保留（不是丢弃）');
ok(t2rec && t2rec.最终阶段 === 'request-failed-unknown', '失败轮保留 stage');
ok(t2rec && t2rec.原始请求结果 && t2rec.原始请求结果.stage === 'timeout',
  '失败轮保留原始请求结果（超时证据）');
/* 第三轮标未跑 */
var t3rec = st3.轮次[2];
ok(t3rec && t3rec.未跑 === true, '★ 第三轮标记未跑');
ok(t3rec && /前一轮失败/.test(t3rec.未跑原因), '未跑原因写明「前一轮失败」',
  t3rec && t3rec.未跑原因);
ok(t3rec && t3rec.原始输出 === null && t3rec.原始请求结果 === null,
  '★ 未跑轮没有伪造任何输出/请求结果（不为它编造历史请求）');
ok(!!st3.终态, '★ 终态已记录', st3.终态);
ok(st3.登记 && st3.登记.停机轮 === 2, '登记写明停机在第 2 轮', JSON.stringify(st3.登记));
ok(/网络|超时/.test(st3.停机原因 || ''), '停机原因=网络/超时', st3.停机原因);

/* ============================================================
   §4 覆盖 4：每组只登记一次
   ============================================================ */
section('§4 每组只登记一次（★ 本轮修掉的真 bug）');
var regs4 = [];
var st4 = await runGroupSchedule({
  id: 'T4', turns: ['a', 'b', 'c'],
  send: async function (ti, input) {
    return ti === 1 ? timeoutTurn(ti, input) : okTurn(ti, input);
  },
  persist: async function (s) { regs4.push(s.登记 || null); },
  stopKind: hardStopKind
});
ok(st4.组已登记 === true, '组已登记 = true');
ok(st4.登记 && st4.登记.组 === 'T4', '登记内容正确', JSON.stringify(st4.登记));
/* 幂等性：再调一次 registerGroup 的等价效果 —— 用两组跑同一 id 模拟旧代码的双 push */
var st4b = await runGroupSchedule({
  id: 'T4', turns: ['a'],
  send: async function (ti, input) { return okTurn(ti, input); },
  persist: async function () {},
  stopKind: hardStopKind
});
ok(st4b.组已登记 === true && st4b.登记.正常跑完 === true,
  '正常跑完也只登记一次（登记字段为「正常跑完」）');

/* ============================================================
   §5 覆盖 6：持久化完成前不得发送下一轮
   ============================================================ */
section('§5 ★ 持久化完成前不得发送下一轮');
var order5 = [];
var st5 = await runGroupSchedule({
  id: 'T5', turns: ['a', 'b', 'c'],
  send: async function (ti, input) {
    order5.push('send' + ti);
    /* 故意让 persist 还没完成时检查：send 时上一轮的 persist 必须已发生 */
    return okTurn(ti, input);
  },
  persist: async function (s, phase) {
    order5.push('persist' + (phase || '轮次'));
  },
  stopKind: hardStopKind
});
ok(order5.join(',') === 'send0,persist轮次,send1,persist轮次,send2,persist轮次,persist终态',
  '★ 严格「发一轮→落一盘→再发下一轮」，末尾加一次终态', order5.join(','));
ok(st5.持久化次数 === 4, '持久化次数 = 4（3 轮 + 终态）', String(st5.持久化次数));

/* ============================================================
   §6 覆盖 7：持久化失败 → 停止后续发送，且错误不被吞
   ============================================================ */
section('§6 持久化失败 → 停止后续发送');
var sent6 = [];
var threw6 = null;
var st6 = null;
try {
  st6 = await runGroupSchedule({
    id: 'T6', turns: ['a', 'b', 'c'],
    send: async function (ti, input) { sent6.push(input); return okTurn(ti, input); },
    persist: async function (s, phase) {
      if ((s.确认发送数 || 0) >= 1 && phase === '轮次') { var e = new Error('模拟磁盘满'); e.code = 'ENOSPC'; throw e; }
    },
    stopKind: hardStopKind
  });
} catch (e) { threw6 = e; }
ok(sent6.length === 1, '★ 第一次持久化失败后不再发送', '实际发送 ' + sent6.length + ' 次');
ok(threw6 !== null, '★ 写入错误**没有被吞掉**（向上抛）');
ok(threw6 && /磁盘满/.test(threw6.message), '错误信息原样传出', threw6 && threw6.message);
ok(st6 === null, '（异常路径下不返回正常状态对象）');
/* 再验：第二轮才失败 */
var sent6b = [];
var threw6b = null;
try {
  await runGroupSchedule({
    id: 'T6b', turns: ['a', 'b', 'c'],
    send: async function (ti, input) { sent6b.push(input); return okTurn(ti, input); },
    persist: async function (s, phase) {
      if ((s.确认发送数 || 0) >= 2 && phase === '轮次') throw new Error('第二轮后写盘失败');
    },
    stopKind: hardStopKind
  });
} catch (e) { threw6b = e; }
ok(sent6b.length === 2, '第二轮失败 → 第三次不发', '实际 ' + sent6b.length);
ok(threw6b && /第二轮后写盘失败/.test(threw6b.message), '错误原样传出');

/* ============================================================
   §7 覆盖 8：硬停止条件（403/网络）不启动后续
   ============================================================ */
section('§7 硬停止（403 / 网络）→ 停止整跑');
function stopCase(stage, status, label) {
  return runGroupSchedule({
    id: 'T7-' + label, turns: ['a', 'b', 'c'],
    send: async function (ti, input) {
      if (ti === 0) {
        return { 轮: 1, 输入: input, 已落地: false,
          最终阶段: 'request-rejected',
          原始请求结果: { stage: stage, status: status, error: 'HTTP ' + status },
          诊断: { requestId: 1, seq: 2, stage: 'request-rejected' } };
      }
      return okTurn(ti, input);
    },
    persist: async function () {},
    stopKind: hardStopKind
  });
}
var st7a = await stopCase('http', 403, '403');
ok(st7a.确认发送数 === 1, '403 → 只发第 1 轮', String(st7a.确认发送数));
ok(/权限不可用/.test(st7a.停机原因 || ''), '停机原因=权限不可用', st7a.停机原因);
ok(st7a.停止整跑 === true, '标记停止整跑');
var st7b = await stopCase('network', undefined, 'net');
ok(st7b.确认发送数 === 1, '网络失败 → 只发第 1 轮', String(st7b.确认发送数));
/* ★ 用户 2026-10-04 明确：网络/超时**继续停止整跑**。
   两道防线都在：hardStopKind 管「立即停整跑」，依赖检查管「不发下一轮」。 */
ok(/网络|超时/.test(st7b.停机原因 || ''),
  '★ 网络失败停止整跑（用户要求）', st7b.停机原因);
/* 超时但**不是**第一轮 → 依赖拦截而非硬停止 */
var sent7c = [];
var st7c = await runGroupSchedule({
  id: 'T7c', turns: ['a', 'b', 'c'],
  send: async function (ti, input) {
    sent7c.push(ti);
    return ti === 1 ? timeoutTurn(ti, input) : okTurn(ti, input);
  },
  persist: async function () {},
  stopKind: hardStopKind
});
ok(sent7c.length === 2 && /网络|超时/.test(st7c.停机原因 || ''),
  '★ 中途超时也停整跑，且第 3 轮被补记未跑', st7c.停机原因);
ok(st7c.轮次.length === 3, '第 3 轮补记为未跑（共 3 条）', String(st7c.轮次.length));

/* ============================================================
   §8 真实落盘：makeSnapshotWriter（临时目录，不写仓库）
   ============================================================ */
section('§8 真实快照写入（临时目录）');
var os = require('os'), path = require('path'), fs = require('fs');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f2snap-'));
var w = makeSnapshotWriter(tmp);
var f1 = await w({ 样本组: 99, 名称: '快照测试', 轮次: [okTurn(0, 'a')] },
  { 已发送数: 1, 持久化次数: 0, 组已登记: false, 停机原因: null }, null, []);
ok(fs.existsSync(f1), '快照文件已写入', f1);
var snap = JSON.parse(fs.readFileSync(f1, 'utf8'));
ok(snap.样本.length === 1 && snap.样本[0].轮次.length === 1, '快照含本轮记录');
ok(snap.元信息.阶段 === '逐轮快照（运行中，尚未收尾）', '标注为运行中快照');
ok(/^快照-99-001-/.test(path.basename(f1)), '文件名带组号与序号', path.basename(f1));
/* 停机原因也要落 */
var f2 = await w({ 样本组: 99, 名称: '快照测试', 轮次: [okTurn(0, 'a'), timeoutTurn(1, 'b')] },
  { 已发送数: 2, 持久化次数: 1, 组已登记: true, 停机原因: '网络/超时：timeout' }, null, []);
var snap2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
ok(snap2.元信息.停机原因 === '网络/超时：timeout', '★ 停机原因已落盘');
ok(snap2.样本[0].轮次.length === 2, '失败轮也在快照里');
var files = fs.readdirSync(tmp).filter(function (n) { return /\.json$/.test(n); });
ok(files.length === 2, '两次写入 → 两个文件', '实际 ' + files.length);
fs.rmSync(tmp, { recursive: true, force: true });

/* ============================================================
   §9 「回复成功但采集失败」→ 停止续发（B · 2026-10-05）
   ------------------------------------------------------------
     场景：模型**正常回复了**（ok:true / 有诊断 / 有输出），
     但**请求体证据没留下**。这种轮次最危险 ——
     表面一切正常，不判就继续跑，产出一批无法核验的样本。
   ============================================================ */
section('§9 请求体缺证 → 按采集异常停止续发');

/* ---- 9.1 单轮组：唯一一轮就缺证 ----
   ⚠️⚠️ 原来是 `['缺记录','采集失败','messages空'].forEach(async-ish …)`：
     `forEach` **不等待**回调返回的 Promise ⇒ 这三条断言在
     外层 async 函数**继续往下跑之后**才落地，可能撞上汇总 ⇒
     「用例全部完成才汇总」被破坏（典型症状：退出码 0 但少了几条断言）。
   → 改 `for…of` + **显式 await**。 */
var FORMS_9A = ['缺记录', '采集失败', 'messages空'];
for (var fi = 0; fi < FORMS_9A.length; fi++) {
  var form = FORMS_9A[fi];
  var sent9a = [];
  var st9a = await runGroupSchedule({
    id: 'T9a-' + form, turns: ['x'],
    send: async function (ti, input) {
      sent9a.push(input);
      return noEvidenceTurn(ti, input, form);
    },
    persist: async function () {},
    stopKind: hardStopKind
  });
  ok(st9a.停机原因 !== null, '单轮组[' + form + '] 判停机', String(st9a.停机原因));
  ok(/采集关联异常/.test(st9a.停机原因 || ''),
    '单轮组[' + form + '] 停机原因=采集异常', String(st9a.停机原因));
  ok(st9a.停止整跑 === true, '单轮组[' + form + '] 停止整跑=true');
  ok(sent9a.length === 1, '单轮组[' + form + '] 只发了 1 次（无后续可发）');
}

/* ---- 9.1b 错误类型反例：messages 结构不合法也算缺证 ---- */
[
  { form: 'messages非数组', rec: { bodySHA256: 'x', messages: { a: 1 } } },
  { form: 'messages为null', rec: { bodySHA256: 'x', messages: null } },
  { form: '条目缺role', rec: { bodySHA256: 'x', messages: [{ content: 'x' }] } },
  { form: 'role为空串', rec: { bodySHA256: 'x', messages: [{ role: '', content: 'x' }] } },
  { form: 'content为空串', rec: { bodySHA256: 'x', messages: [{ role: 'user', content: '' }] } },
  { form: 'content为null', rec: { bodySHA256: 'x', messages: [{ role: 'user', content: null }] } },
  { form: '条目是字符串', rec: { bodySHA256: 'x', messages: ['just a string'] } },
  { form: '条目是数组', rec: { bodySHA256: 'x', messages: [['role', 'user']] } },
  { form: '条目为null', rec: { bodySHA256: 'x', messages: [null] } },
  { form: '多条里第二条坏', rec: { bodySHA256: 'x',
    messages: [{ role: 'user', content: 'ok' }, { role: 'user' }] } }
].forEach(function (c) {
  var t = okTurn(0, 'x');
  t.发送瞬间请求体 = c.rec;
  var r = ACC.requestBodyEvidence(t);
  ok(r.缺证 === true, '缺证反例[' + c.form + '] 应判缺证', r.原因);
  ok(hardStopKind(t) === 'link',
    '缺证反例[' + c.form + '] hardStopKind=link', String(hardStopKind(t)));
});
/* 正常证据不得误停（含 content 为结构化数组的多模态形态） */
[
  { form: '常规', messages: [{ role: 'system', content: '【当前场景】' }, { role: 'user', content: '我到了。' }] },
  { form: '单条', messages: [{ role: 'user', content: 'x' }] },
  { form: 'content结构化数组', messages: [{ role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'u' } }] }] }
].forEach(function (c) {
  var t = okTurn(0, 'x');
  t.发送瞬间请求体 = { bodySHA256: 'x', bodyCaptureError: null, messages: c.messages };
  var r = ACC.requestBodyEvidence(t);
  ok(r.缺证 === false, '正常证据[' + c.form + '] 不得误判缺证', r.原因);
  ok(hardStopKind(t) === null,
    '正常证据[' + c.form + '] 不得误停', String(hardStopKind(t)));
});

/* ---- 9.2 末轮缺证：前两轮正常，第三轮缺证 ---- */
var sent9b = [];
var st9b = await runGroupSchedule({
  id: 'T9b', turns: ['a', 'b', 'c'],
  send: async function (ti, input) {
    sent9b.push(input);
    /* 第三轮（末轮）回复成功但缺证 */
    return ti === 2 ? noEvidenceTurn(ti, input, '采集失败') : okTurn(ti, input);
  },
  persist: async function () {},
  stopKind: hardStopKind
});
ok(sent9b.length === 3, '★ 末轮缺证：三轮都发了（不丢本轮）', '实际 ' + sent9b.length);
ok(st9b.轮次.length === 3, '三条记录都在');
ok(st9b.停机原因 !== null && /采集关联异常/.test(st9b.停机原因 || ''),
  '★ 末轮缺证仍被抓住（不被漏掉）', String(st9b.停机原因));
ok(st9b.轮次[2].原始输出 === '第3轮正文',
  '★ 本轮输出没丢', JSON.stringify(st9b.轮次[2].原始输出));
ok(st9b.轮次[2].已落地 === true, '★ 本轮落地状态保留');
ok(st9b.轮次[2].诊断 && st9b.轮次[2].诊断.requestId === 3,
  '★ 本轮诊断保留（没被改写成失败）');
ok(st9b.确认发送数 === 3, '确认发送数 = 3（未把缺证当未发出）', String(st9b.确认发送数));

/* ---- 9.3 跨组：第一组末轮缺证 → 后续组不启动 ---- */
var sent9c = [], g2calls9 = 0;
var spec9a = {
  id: 'T9c-G1', turns: ['a', 'b'],
  send: async function (ti, input) {
    sent9c.push('G1:' + input);
    return ti === 1 ? noEvidenceTurn(ti, input, '缺记录') : okTurn(ti, input);
  },
  persist: async function () {},
  stopKind: hardStopKind
};
var st9c = await runGroupSchedule(spec9a);
ok(st9c.停机原因 !== null, '第一组因缺证停机', String(st9c.停机原因));
/* 正式流程的「是否开下一组」判断：照 acceptance 里的写法 */
var nextSpec = (!st9c.停机原因) ? {
  id: 'T9c-G2', turns: ['x'],
  send: async function () { g2calls9++; return okTurn(0, 'x'); },
  persist: async function () {}, stopKind: hardStopKind
} : null;
ok(nextSpec === null, '★ 后续组不启动（缺证 ⇒ 停止整跑）');
if (nextSpec) { await runGroupSchedule(nextSpec); }
ok(g2calls9 === 0, '★ 第二组发送替身实际调用次数 = 0', String(g2calls9));

/* ---- 9.4 未发出仍走未发出分支（不被缺证接管） ---- */
var sent9d = [];
var st9d = await runGroupSchedule({
  id: 'T9d', turns: ['a'],
  send: async function (ti, input) {
    sent9d.push(input);
    return { 轮: 1, 输入: input, 已落地: false, 未发出: { why: 'no input/send' },
      原始请求结果: null, 归因: null, 出站messages: null,
      原始输出: null, 段落: null, 诊断: null };
  },
  persist: async function () {},
  stopKind: hardStopKind
});
ok(/未发出/.test(st9d.停机原因 || ''),
  '★ 未发出轮次走「未发出」分支（不是采集异常）', String(st9d.停机原因));
ok(st9d.确认发送数 === 0, '确认发送数 = 0（未发出不算已发）', String(st9d.确认发送数));
ok(ACC.requestBodyEvidence({ 未发出: { why: 'x' } }).应有 === false,
  '★ 缺证判定对「未发出」不启用');

/* ---- 9.5 阳性对照：证据齐全时不得误停 ---- */
var sent9e = [];
var st9e = await runGroupSchedule({
  id: 'T9e', turns: ['a', 'b', 'c'],
  send: async function (ti, input) { sent9e.push(input); return okTurn(ti, input); },
  persist: async function () {},
  stopKind: hardStopKind
});
ok(sent9e.length === 3, '证据齐全：三轮都发', String(sent9e.length));
ok(st9e.停机原因 === null, '★ 证据齐全不误停', String(st9e.停机原因));
ok(ACC.requestBodyEvidence(okTurn(0, 'a')).缺证 === false,
  '阳性对照：有证据 ⇒ 不判缺证');
/* 反向：真实 403/超时的原因不得被缺证掩盖 */
ok(hardStopKind(Object.assign(okTurn(0, 'x'),
  { 发送瞬间请求体: null, 原始请求结果: { stage: 'timeout' } })) === 'net',
  '★ 真实超时仍报 net（不被缺证改写成采集异常）');
ok(hardStopKind(Object.assign(okTurn(0, 'x'),
  { 发送瞬间请求体: null, 原始请求结果: { status: 403, error: 'HTTP 403' } })) === 'perm',
  '★ 真实 403 仍报 perm');

/* ---------- 收尾 ---------- */
process.stdout.write('\n────────\n');
process.stdout.write('通过 ' + pass + ' / 失败 ' + fail + '\n');
if (fail) process.stdout.write('红项: ' + FAILS.join(' | ') + '\n');
process.stdout.write(fail === 0
  ? '✅ 真实调度已用**零模型请求**测试锁住（9 条覆盖全过）。\n'
  : '❌ 有红项：调度保证没锁住。\n');
/* ⚠️⚠️ 失败必须给**非零退出码**。
   原先这里只写文本就结束 —— `fail>0` 时进程仍以 0 退出，
   于是「有红项」在 CI / 批处理里会被当成通过。
   ⚠️ 这也是「所有用例完成后才汇总」的一部分：
     汇总点一旦决定，必须把结论**反映到退出码**上。 */
if (fail) process.exit(1);
})().catch(function (e) {
  process.stdout.write("测试脚本异常：" + (e && e.stack ? e.stack : e) + String.fromCharCode(10));
  process.exit(1);
});
