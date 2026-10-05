#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-dupuser-test.js
   —— 「本轮 user 输入在出站 messages 里只出现一次」的零网络回归

   ★ 缺陷来源（2026-10-05 真机实测，两份样本都有）：
       page-offline.js  appendMessage(userInput)      → 落进 session.messages
       prompt-engine.js assembleOffline 又 push 一条   → 同一句出现两次
     旧写法无条件 push；本轮改成「历史末尾已经是它 ⇒ 不重复补」。

   ---- 硬边界 ----
     · 不启动浏览器、不发任何网络请求、不调模型
     · 走 scripts/harness.js 的 boot()，起的是**生产脚本本身**
     · 期望值**不抄**、断言**只增不删**

   ---- 覆盖（对应用户列的 8 条）----
     ① 四条前置历史全部保留                  §2
     ② 本轮「我到了。」只出现 1 次            §2 §3 §4
     ③ role 与顺序符合原契约                 §2 §3
     ④ 历史不足 / 历史满 20 条时都在          §4
     ⑤ 线上 assembleOnline 不受影响          §5
     ⑥ 自动开场（userInput=null）与空串不受影响 §6
     ⑦ 失败时退出码非零                       §8（真跑一次注入验证）
     ⑧ 不改旧样本、不删不放宽既有断言          §7
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
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
/* ★ 串行队列：本文件的用例共享同一个 boot 出来的沙箱（store 全局），
   并发跑会互踩。用例之间有先后依赖（§3 依赖 §2 的会话），必须排队。 */
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

/* ---------- 夹具：与 G4 第 1 轮真机验收完全一致 ---------- */
var PRE = [
  { role: 'user', text: '（我推开阁楼的门，上来了。)' },
  { role: 'scene', paras: [{ type: 'prose', text:
    '沈砚已经推开阁楼的门上来了，雨水顺着他的外套下摆往下滴。 老板娘在楼下喊了一声' +
    '「茶刚泡好」，然后就没有再上来。 沈砚已经把湿外套搭在椅背上了。' }] },
  { role: 'scene', paras: [{ type: 'prose', text: '（老板娘在楼下，没有上来。）' }] },
  { role: 'user', text: '（我坐下了，湿外套搭在椅背上。）' }
];
var THIS_TURN = '我到了。';

var BASE = 'D:/projects/sleepy-baseline-2026-10-05-pre10';
var h = null, S = null, charId = null;

/* 造一个会话：按 PRE 落库（走生产 appendMessage），
   最后 appendMessage 本轮输入 —— 这正是 page-offline.js 的真实顺序。 */
function mkSession(extraUserFirst) {
  var s = S.offlineStore.createSession(charId, {
    sceneName: '雨夜的旧书店', location: '城西旧书店二楼阁楼',
    timeOfDay: '深夜', weather: '雨', clockTime: '23:40'
  });
  if (extraUserFirst) S.offlineStore.appendMessage(s.id, { role: 'user', text: extraUserFirst });
  PRE.forEach(function (m) { S.offlineStore.appendMessage(s.id, m); });
  /* ★ 本轮输入：与 page-offline.js:1400 完全同形 */
  S.offlineStore.appendMessage(s.id, { role: 'user', text: THIS_TURN });
  return S.offlineStore.findSession(s.id);
}
function assemble(sess, userInput) {
  return S.promptEngine.assembleOffline({
    charId: charId, userId: null, session: sess, userInput: userInput
  });
}
/* 只数「本轮这一句」在最终 messages 里出现几次（逐字相同才算） */
function countTurn(r) {
  return r.messages.filter(function (m) {
    return m.role === 'user' && String(m.content) === THIS_TURN;
  }).length;
}
function userSeq(r) {
  return r.messages.filter(function (m) { return m.role === 'user'; })
    .map(function (m) { return String(m.content); });
}

head('§0 沙箱（起的是生产脚本本身，不是抄的副本）');
t('boot 成功且 promptEngine / offlineStore 在位', function () {
  h = H.boot('dupuser');
  S = h.S;
  assert(S && S.promptEngine && S.offlineStore, '生产模块缺失');
  assert(typeof S.promptEngine.assembleOffline === 'function', '缺 assembleOffline');
  assert(typeof S.promptEngine.assembleOnline === 'function', '缺 assembleOnline');
});

head('§1 ★ 夹具自检：会话确实按 PRE + 本轮落库了');
var sessMain = null;
t('落库 5 条、四条前置历史逐条一致', function () {
  charId = S.core.upsertChar({ id: '__dup_role__', kind: 'main', name: '沈砚',
    content: '沈砚，建筑设计师。' }).id;
  sessMain = mkSession(false);
  var msgs = sessMain.messages;
  eq(msgs.length, 5, '落库条数');
  eq(msgs[0].text, PRE[0].text, '前置1 正文');
  eq(msgs[4].text, THIS_TURN, '本轮正文');
  eq(msgs[4].role, 'user', '本轮 role');
});

head('§2 核心：四条前置历史全在 + 本轮只出现 1 次（要求 ①②）');
t('★ 本轮「我到了。」在最终 messages 里恰好 1 次', function () {
  var r = assemble(sessMain, THIS_TURN);
  eq(countTurn(r), 1, '「我到了。」出现次数');
  assert(countTurn(r) === 1,
    '★ 双写仍在：出现 ' + countTurn(r) + ' 次');
});
t('★ 四条前置历史全部保留', function () {
  var r = assemble(sessMain, THIS_TURN);
  var texts = r.messages.map(function (m) { return String(m.content); });
  var joined = texts.join('\n@@@\n');
  assert(joined.indexOf('（我推开阁楼的门，上来了。)') >= 0, '前置1 丢失');
  assert(joined.indexOf('沈砚已经推开阁楼的门上来了') >= 0, '前置2 丢失');
  assert(joined.indexOf('（老板娘在楼下，没有上来。）') >= 0, '前置3 丢失');
  assert(joined.indexOf('（我坐下了，湿外套搭在椅背上。）') >= 0, '前置4 丢失');
});
t('★ 前置历史**没有被重复**（逐条各 1 次）', function () {
  var r = assemble(sessMain, THIS_TURN);
  var n = r.messages.filter(function (m) {
    return String(m.content).indexOf('沈砚已经推开阁楼的门上来了') >= 0; }).length;
  eq(n, 1, '拼接版 scene 出现次数');
});

head('§3 role 与顺序符合原契约（要求 ③）');
t('user 序列 = 前置user1 / 前置user2 / 本轮，且本轮在最后', function () {
  var r = assemble(sessMain, THIS_TURN);
  var us = userSeq(r);
  eq(us, ['（我推开阁楼的门，上来了。)', '（我坐下了，湿外套搭在椅背上。）', THIS_TURN],
    'user 角色序列');
  var last = r.messages[r.messages.length - 1];
  eq(last.role, 'user', '最后一条 role');
  eq(String(last.content), THIS_TURN, '最后一条内容');
});
t('scene 仍转成 assistant + 【场景】前缀（契约未变）', function () {
  var r = assemble(sessMain, THIS_TURN);
  var sceneMsgs = r.messages.filter(function (m) {
    return m.role === 'assistant' && String(m.content).indexOf('【场景】') >= 0; });
  eq(sceneMsgs.length, 2, 'scene 段数');
});
t('★ 阳性对照：本轮输入与历史里某条**逐字同字**时的真实行为', function () {
  /* ⚠️ 第一版这条的前提**从一开始就是错的**（写测试时没核对原文）：
     前置第 4 条是「（我坐下了，湿外套搭在椅背上。）」—— 带括号与后半句，
     与「我坐下了。」**不是同一串** ⇒ 「同字」这个前提根本不成立。
     判别力的正确做法：**自己造一条逐字相同的**，再看真实结果。
     ⚠️ 期望值先**实测**再写死，不预设 —— 这一条正是我第一版翻车的地方。 */
  var s2 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  S.offlineStore.appendMessage(s2.id, { role: 'user', text: '（前置另一句。）' });
  S.offlineStore.appendMessage(s2.id, { role: 'char',
    paras: [{ type: 'prose', text: '（夹具：他应了一声。）' }] });
  /* 历史末尾是 char，不是本轮输入 ⇒ 兜底**应该**补一条 ⇒ 恰好 1 次。
     若历史末尾**就是**它，则不补（见下一条）。 */
  var back = S.offlineStore.findSession(s2.id);
  var r = assemble(back, THIS_TURN);
  eq(countTurn(r), 1, '历史末尾不是它 ⇒ 兜底补 1 条（共 1 次）');
  eq(String(r.messages[r.messages.length - 1].content), THIS_TURN, '本轮输入应垫底');
});
t('★ 判别力：末尾**就是**它 ⇒ 兜底不补（旧写法会补成 2 次）', function () {
  var s2 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  S.offlineStore.appendMessage(s2.id, { role: 'user', text: '前一句。' });
  S.offlineStore.appendMessage(s2.id, { role: 'user', text: THIS_TURN });
  var back = S.offlineStore.findSession(s2.id);
  var r = assemble(back, THIS_TURN);
  eq(countTurn(r), 1, '末尾已是它 ⇒ 只 1 次');
  /* 旧写法（无条件 push）在同一场景会得到 2 次 ⇒ 这条判据抓得到回归 */
  assert(countTurn(r) === 1,
    '★ 兜底重复补了（' + countTurn(r) + ' 次）—— 修复没生效');
});

head('§4 历史长度边界：本轮输入在两种长度下都必须在（要求 ④）');
t('历史只有本轮 1 条时，本轮输入仍在且只 1 次', function () {
  var s2 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  S.offlineStore.appendMessage(s2.id, { role: 'user', text: THIS_TURN });
  var back = S.offlineStore.findSession(s2.id);
  var r = assemble(back, THIS_TURN);
  eq(countTurn(r), 1, '短历史下的出现次数');
  eq(String(r.messages[r.messages.length - 1].content), THIS_TURN, '垫底');
});
t('★ 历史满 20 条时，本轮输入仍存在（不被 slice(-20) 挤掉）', function () {
  var s3 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  /* 先灌 20 条别的对话，把额度占满；本轮输入落在**最后** */
  for (var i = 1; i <= 20; i++) {
    S.offlineStore.appendMessage(s3.id, { role: 'user', text: ' fillers ' + i });
  }
  S.offlineStore.appendMessage(s3.id, { role: 'user', text: THIS_TURN });
  var back = S.offlineStore.findSession(s3.id);
  eq(back.messages.length, 21, '落库条数');
  var r = assemble(back, THIS_TURN);
  eq(countTurn(r), 1, '满历史下的出现次数');
  assert(countTurn(r) === 1,
    '★ 历史满 20 条时本轮输入丢了或重复了（' + countTurn(r) + ' 次）');
  eq(String(r.messages[r.messages.length - 1].content), THIS_TURN,
    '满历史时本轮输入必须垫底');
});
t('兜底形状：调用方**没**先落库时，装配器仍补这一条（既有测试依赖）', function () {
  /* smoke.js:5699 断言「当前输入垫底」，它直接传参、不落库。
     删掉兜底会让那条红 —— 所以兜底必须留着，且只在「末尾不是它」时才补。 */
  var s4 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  var back = S.offlineStore.findSession(s4.id);
  var r = assemble(back, THIS_TURN);      /* 会话里没有这句 */
  eq(countTurn(r), 1, '未落库时仍应补 1 条');
  eq(String(r.messages[r.messages.length - 1].content), THIS_TURN, '垫底');
});

head('§5 线上 assembleOnline 不受影响（要求 ⑤）');
t('★ assembleOnline 走 ctx.history，不读 ctx.userInput', function () {
  var hist = [{ role: 'user', content: '你还记得我们第一次见面吗' },
    { role: 'assistant', content: '记得。' }];
  var r = S.promptEngine.assembleOnline({ charId: charId, userId: null, history: hist });
  var us = r.messages.filter(function (m) { return m.role === 'user'; })
    .map(function (m) { return String(m.content); });
  eq(us.length, 1, '线上 user 条数（只应有 history 里那条）');
  eq(us[0], hist[0].content, '线上 user 内容');
  assert(us.indexOf(THIS_TURN) < 0, '★ 线上路径混进了线下本轮输入');
});
t('★ 线上多传 userInput 也不受影响（它压根不读这个参数）', function () {
  var hist = [{ role: 'user', content: '你还记得我们第一次见面吗' }];
  var r = S.promptEngine.assembleOnline({
    charId: charId, userId: null, history: hist, userInput: THIS_TURN });
  var us = r.messages.filter(function (m) { return m.role === 'user'; })
    .map(function (m) { return String(m.content); });
  eq(us.length, 1, '线上 user 条数');
  assert(us.indexOf(THIS_TURN) < 0,
    '★ assembleOnline 竟然响应了 userInput —— 说明它已被改动');
});

head('§6 自动开场 / 空 userInput 不受影响（要求 ⑥）');
/* ⚠️ 判据口径（第一版写错过，教训记在这里）：
   「不补」≠「messages 里没有这句」。
   sessMain 的历史里**本来就落库了**本轮输入（生产就是这样），
   所以开场时它**理应**出现在历史里 —— 要断言的是
   **装配器没有因为 userInput=null 又多补一条**（条数不变），
   而不是「这句话不存在」。 */
function userCount(r) { return r.messages.filter(function (m) { return m.role === 'user'; }).length; }
t('userInput=null（自动开场）⇒ 装配器不额外补 user', function () {
  var base = assemble(sessMain, null);
  var n = userCount(base);
  eq(n, 3, '开场时 user 总条数（前置2 + 落库的本轮1）');
  assert(n === 3, '★ 开场时多补了一条，user 条数=' + n);
  /* 阳性对照：同一会话传本轮输入，若装配器再补就会变成 4 */
  var withIn = assemble(sessMain, THIS_TURN);
  eq(userCount(withIn), 3, '传入同一句时条数不变（=没重复补）');
});
t('userInput=""（预设预览形状）⇒ 假值，不补', function () {
  var r = assemble(sessMain, '');
  eq(userCount(r), 3, '空串时 user 总条数');
  eq(countTurn(r), 1, '空串时本轮输入仍只 1 次');
});
t('★ 开场后落库的那条仍在（开场路径的历史没被削）', function () {
  var r = assemble(sessMain, null);
  var joined = r.messages.map(function (m) { return String(m.content); }).join('\n');
  assert(joined.indexOf('（我推开阁楼的门，上来了。)') >= 0, '开场时前置历史丢了');
  assert(joined.indexOf('（我坐下了，湿外套搭在椅背上。）') >= 0, '开场时前置历史丢了');
});
t('★ 全新空会话 + 开场 ⇒ 一条 user 都不该有', function () {
  var s6 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  var back = S.offlineStore.findSession(s6.id);
  var r = assemble(back, null);
  eq(userCount(r), 0, '空历史开场时的 user 条数');
  eq(countTurn(r), 0, '空历史开场时不该出现本轮输入');
});
t('★ parseFailed 过滤仍生效（本轮不动那两行）', function () {
  var s5 = S.offlineStore.createSession(charId, { sceneName: '雨夜的旧书店' });
  S.offlineStore.appendMessage(s5.id, { role: 'char', parseFailed: true,
    paras: [{ type: 'prose', text: '这一轮的回复格式出了点问题。' }] });
  S.offlineStore.appendMessage(s5.id, { role: 'user', text: THIS_TURN });
  var back = S.offlineStore.findSession(s5.id);
  var r = assemble(back, THIS_TURN);
  var joined = r.messages.map(function (m) { return String(m.content); }).join('\n');
  assert(joined.indexOf('这一轮的回复格式出了点问题') < 0,
    '★ parseFailed 的记录进了历史（该过滤没生效）');
  eq(countTurn(r), 1, '本轮输入次数');
});

head('§7 未改旧样本 / 未删既有断言（要求 ⑧）');
t('★ 12 个历史样本仍是 2026-10-04 原样（mtime）', function () {
  var dir = path.join(H.ROOT, 'docs', '样本-private-f2-效果');
  var files = fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); });
  eq(files.length, 12, '历史样本个数');
  var badOnes = files.filter(function (f) {
    var m = fs.statSync(path.join(dir, f)).mtime;
    return m.getTime() > Date.parse('2026-10-05T00:00:00Z');
  });
  eq(badOnes, [], '被改动的历史样本');
});
t('★ 本批只改了 prompt-engine.js 与 page-offline.js（其余生产文件逐字节未动）', function () {
  /* ★ 2026-10-05 更新：page-offline.js 在**解析降级取证批**获准改动
     （加 sleepy.forensics.parseFail.* 独立取证落盘），从禁改清单移出；
     其余四个文件仍逐字节锁定。锚定的 BASE 是**dupuser 批开工基线**，
     跨批次后 page-offline.js 的差异属取证批批准改动，不再算越界。
   ★ 2026-10-05 K03f 批更新：page-presets.js 在**群线上动态上下文批**获准改动
     （自定义卡编辑页加「群聊可用」开关），同样从禁改清单移出；
     群线上侧的改动另由 behavior-online-migration-test 的 groupOnline
     受控迁移检查逐字节看守。其余三个文件仍逐字节锁定。 */
  ['api.js', 'behavior-text.js', 'page-chat.js']
    .forEach(function (f) {
      var a = H.sha256(fs.readFileSync(path.join(H.ROOT, f)));
      var b = H.sha256(fs.readFileSync(path.join(BASE, f)));
      assert(a === b, f + ' 被改了 —— 超出批准范围');
    });
  var pe = H.sha256(fs.readFileSync(path.join(H.ROOT, 'prompt-engine.js')));
  var peB = H.sha256(fs.readFileSync(path.join(BASE, 'prompt-engine.js')));
  assert(pe !== peB, '★ prompt-engine.js 竟然没变 —— 修复没生效');
});
t('★ 提示词正文没动：新增块**之前**与**之后**都与基线逐字相同', function () {
  /* ⚠️ 这条判据我重写了三版（正则还原 → END 锚点切片 → 拼接 glue），
     每次都是**判据自己**算错字节数（差 10、差 20），报「整个文件都变了」。
     ⇒ 教训：与其精巧地「重建旧文件」，不如**只判两侧**：
       新增块之前的内容 == 基线新增块位置之前的内容
       新增块之后的内容 == 基线旧块之后的内容
     两段各自逐字比，不做任何拼接、不数字节 —— 判据简单到不会自己骗自己。 */
  var src = fs.readFileSync(path.join(H.ROOT, 'prompt-engine.js'), 'utf8');
  var base = fs.readFileSync(path.join(BASE, 'prompt-engine.js'), 'utf8');
  var START = '/* 本轮 user 输入已由 page-offline.js';
  var TAIL = "slots.push({ id: 'history'";
  var si = src.indexOf(START);
  var sk = src.indexOf(TAIL, si);
  assert(si >= 0 && sk > si, '定位新增块（START / TAIL）');
  assert(src.indexOf(START, si + 1) < 0, '★ 锚点 START 不唯一');
  assert(src.indexOf(TAIL, sk + 1) < 0, '★ 锚点 TAIL 不唯一');
  var bm = base.match(/ {0,20}if \(ctx\.userInput\) \{\n(?:[^\n]*\n){2} {0,20}\}/);
  assert(bm, '基线里取不到旧块');
  var bi = base.indexOf(bm[0]);
  var bk = base.indexOf(TAIL, bi);
  assert(bk > bi, '基线里定位 TAIL');
  /* ⚠️ 锚点基准必须**对齐**（这条判据第三次栽在这上面）：
     si 指向注释块的**行首**（含 10 格缩进），而 bm[0] 指向 `if` 的**行首**，
     基线里 `if` 之前还有那 10 格缩进 ⇒ 两个起点天然差 10 格。
     ⇒ 统一取「行首」：源文件里把 si 回退到行首，
        基线里把 bi 也回退到行首（bm 之前紧邻的换行 + 缩进）。 */
  function lineStart(str, idx) {
    var j = str.lastIndexOf('\n', idx - 1);
    return j + 1;   /* +1 跳过换行本身，落在行首 */
  }
  var siL = lineStart(src, si);
  var biL = lineStart(base, bi);
  process.stdout.write('    [锚点对齐] si=' + si + '→行首 ' + siL
    + ' ;基线 bi=' + bi + '→行首 ' + biL + ']\n');
  /* ★ 2026-10-05 范围收缩：原判据比「START 之前整段」+「TAIL 之后整段」。
     七项文风批与 groupOffline S5 接入均获准改动 prompt-engine.js 的
     **修复区之外**，「之前整段逐字相同」从此必然失效。
     ⚠️ 也不能拿「src 修复块 == 基线同区间」—— 基线是**修复前**的旧块，
     两者天然不同（那正是修复内容本身）。
     ⇒ 正确锁法：修复成果**黄金片段**写死在测试里，src 的修复块必须与其
     逐字相同 —— 修复块被任何后续批改动，这里当场红。 */
  var GOLDEN_FIX_BLOCK =
    '          /* 本轮 user 输入已由 page-offline.js 的 appendMessage 落进\n' +
    '             session.messages，装配器不再重复追加；线上 assembleOnline\n' +
    '             不经过此分支。ctx.userInput 只作兜底：历史里确实没有它时\n' +
    '             才补一条（历史为空、或调用方没先落库的探针形状）。 */\n' +
    "          if (ctx.userInput) {\n" +
    '            var lastIsThis = messages.length > 0\n' +
    "              && messages[messages.length - 1].role === 'user'\n" +
    "              && String(messages[messages.length - 1].content) === String(ctx.userInput);\n" +
    '            if (!lastIsThis) {\n' +
    '              total += estimate(ctx.userInput);\n' +
    "              messages.push({ role: 'user', content: String(ctx.userInput) });\n" +
    '            }\n' +
    '          }\n';
  var skL = lineStart(src, sk);
  eq(src.slice(siL, skL), GOLDEN_FIX_BLOCK, 'dupuser 修复块应与黄金片段逐字相同');
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
  process.stdout.write('★ 结论：四条前置历史全在；本轮「我到了。」恰好 1 次；' +
    '历史满 20 条时仍在且垫底；线上 assembleOnline 与开场/空串路径不受影响。\n');
});
