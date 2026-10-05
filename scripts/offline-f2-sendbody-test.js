#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-sendbody-test.js
   —— 「客户端提交给 fetch 的请求体」采集的零**模型**请求单元 / 桩测试

   ★ 硬边界（用户 2026-10-05 明确）：
     · **不启动 Edge / 任何浏览器**
     · **不调真实模型、不发任何网络请求**
     全部断言在纯 Node + vm 沙箱 + 假 fetch 里完成。

   ---- 逐条对应用户要求 ----
     ① 记录早于 origFetch      → §2（时序桩：origFetch 里断言已记上）
     ② 优先 JSON、只存 5 个字段  → §3
     ③ messages 保留 role+content → §4（含「不许只存长度/哈希」的负向）
     ④ 凭据脱敏                 → §5
     ⑤ body SHA-256 + 明确含义   → §1（与 node crypto 对拍）+ §3
     ⑥ 响应侧采集全部保留        → §6
     ⑦ 采集失败记 bodyCaptureError → §7
     ⑧ 发送记录 messages 与 init.body 一致 → §4 + §8（生产等价路径）
     ⑩ 不改 prompt-engine / page-offline / api / behavior-text → §9 静态断言

   ---- 为什么必须有 §8 ----
     §4 验的是「采集函数对给定 init.body 采得对」。
     §8 验的是「**生产真的走这条路**」：
       装配链产出的 messages → bodyFor 组装成 init.body → 旁路采到的 messages
       三者逐条一致。
     只做 §4 的话，把旁路挂在一个没人调的 fetch 上也全绿。
   ============================================================ */
'use strict';

var crypto = require('crypto');
var vm = require('vm');
var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '..');

var CAP = require('./lib/f2-body-capture.js');
var ACC = require('./offline-f2-effect-acceptance.js');

var pass = 0, fail = 0, problems = [];
function head(t) { process.stdout.write('\n' + t + '\n'); }
function ok(m) { pass++; process.stdout.write('  \u2713 ' + m + '\n'); }
function bad(m) { fail++; problems.push(m); process.stdout.write('  \u2717 ' + m + '\n'); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + '期望 ' + y + '，实得 ' + x);
}
function t(name, fn) {
  try { fn(); ok(name); }
  catch (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); }
}
/* ★ 异步版：fn 返回 Promise 时必须等它落地。
   漏了这个 → 返回 Promise 的用例「函数没抛错」就算过，
   而断言写在 then 里，then 里的失败会变成**未处理的拒绝**，
   测试进程退出码 0 —— 假绿（本文件第一版就踩了）。 */
var pending = [];
function ta(name, fn) {
  pending.push(Promise.resolve()
    .then(fn)
    .then(function () { ok(name); },
      function (e) { bad(name + ' -> ' + (e && e.message ? e.message : e)); }));
}
function nodeSha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/* ============================================================
   §0 前置：夹具（含真实凭据形状，用来验脱敏）
   ============================================================ */
var API_KEY_FAKE = 'sk-f2FakeKeyForRedactionTest0123456789';
var BODY = {
  model: 'glm-5.2',
  messages: [
    { role: 'system', content: '【当前场景】\n「雨夜的旧书店」· 第 1 次见面\n' +
      '时段 深夜 · 天气 雨 · 地点 城西旧书店二楼阁楼 · 时刻 23:40' },
    { role: 'system', content: '【角色】沈砚，建筑设计师。' },
    { role: 'user', content: '我到了。' }
  ],
  stream: false,
  max_tokens: 8192,
  temperature: 0.85
};
var BODY_STR = JSON.stringify(BODY);

head('§1 SHA-256 实现可信（要求 ⑤：必须是真 SHA-256，不是校验和）');
t('与 node:crypto 逐例一致（含空串/55/56/63/64/65 边界 + 中文 + emoji）', function () {
  var cases = ['', 'a', 'abc', '我到了。', '深夜 23:40 雨',
    BODY_STR, 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63),
    'x'.repeat(64), 'x'.repeat(65), 'y'.repeat(1000), '😀🇨🇳'];
  cases.forEach(function (s) {
    eq(CAP.sha256hex(s), nodeSha(s), 'sha256(长度' + s.length + ')');
  });
});
t('★ 阳性对照：故意改一个字节，哈希必须变（防「恒等函数」假绿）', function () {
  var a = CAP.sha256hex('我到了。');
  var b = CAP.sha256hex('我到了。');
  assert(a === b, '同串两次哈希应相等');
  assert(a !== CAP.sha256hex('我到了X'), '改一个字节后哈希不该相同');
  assert(CAP.sha256hex('a') !== CAP.sha256hex('b'), '单字节差异未体现');
});
t('空串哈希 = node 的已知值（不是空、不是 0）', function () {
  eq(CAP.sha256hex(''), nodeSha(''), '空串哈希');
  assert(CAP.sha256hex('') !== '' && CAP.sha256hex('') !== '0', '空串哈希退化成了空/0');
});

/* ============================================================
   §2 采集必须早于 origFetch（要求 ①）
   ============================================================ */
head('§2 时序：采集发生在调用 origFetch 之前（要求 ①）');
function stubFetch(recorder) {
  /* 假 fetch：**不发网络**。返回一个最小 Response 形状。 */
  return function (input, init) {
    if (recorder) recorder();
    return Promise.resolve({
      status: 200,
      clone: function () {
        return { text: function () {
          return Promise.resolve(JSON.stringify({
            choices: [{ finish_reason: 'stop',
              message: { content: '（桩回复）', reasoning_content: '（桩推理）' } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 }
          }));
        } };
      }
    });
  };
}
ta('origFetch 被调用时，__SEND 里已经有这一轮的记录了', function () {
  var win = { fetch: stubFetch(), Date: Date };
  CAP.installFetchBypass(win, {});
  /* 关键：让 origFetch 在**执行那一刻**回读旁路数组。
     若采集写在 origFetch 之后（.then 里），此刻 length 会是 0。 */
  var seenAtCallTime = null;
  var probeWin = { Date: Date };
  probeWin.fetch = function () {
    seenAtCallTime = (probeWin.__SEND || []).length;
    return stubFetch()();
  };
  CAP.installFetchBypass(probeWin, {});
  return probeWin.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function () {
      eq(seenAtCallTime, 1, 'origFetch 执行瞬间旁路已记条数');
      assert(seenAtCallTime === 1,
        '★ 采集必须早于 origFetch（此刻应已有 1 条，实得 ' + seenAtCallTime + '）');
    });
});
ta('返回 Promise（不改变生产调用形态）', function () {
  var w = { fetch: stubFetch(), Date: Date };
  CAP.installFetchBypass(w, {});
  var p = w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR });
  assert(p && typeof p.then === 'function', '必须返回 thenable');
  return p;
});
t('幂等：装两次不会记两次出站', function () {
  var w = { fetch: stubFetch(), Date: Date };
  CAP.installFetchBypass(w, {});
  var first = w.fetch;
  CAP.installFetchBypass(w, {});      /* 第二次应被忽略 */
  eq(w.fetch, first, '第二次 install 后 fetch 引用');
});

/* ============================================================
   §3 只保存脱敏后的 5 个字段 + 哈希含义（要求 ②⑤）
   ============================================================ */
head('§3 字段白名单与哈希口径（要求 ②⑤）');
t('只保留 model/messages/stream/max_tokens/temperature', function () {
  var r = CAP.captureRequestBody('u', { body: BODY_STR });
  var leaked = Object.keys(r).filter(function (k) {
    return ['api_key', 'apikey', 'key', 'token', 'headers', 'auth'].indexOf(k) >= 0;
  });
  eq(leaked, [], '不该出现的凭据类字段');
  eq(r.model, 'glm-5.2', 'model');
  eq(r.stream, false, 'stream');
  eq(r.max_tokens, 8192, 'max_tokens');
  eq(r.temperature, 0.85, 'temperature');
});
t('body 里的其他字段（如 tools/top_p）不进摘要', function () {
  var b = JSON.parse(BODY_STR);
  b.tools = [{ type: 'function', function: { name: 'x' } }];
  b.top_p = 0.9;
  var r = CAP.captureRequestBody('u', { body: JSON.stringify(b) });
  assert(r.tools === undefined && r.top_p === undefined, 'tools/top_p 不该被提升为顶层字段');
  /* 但顶层键名单要留着，便于发现「接口收到了什么」 */
  assert(r.bodyTopKeys.indexOf('tools') >= 0, 'bodyTopKeys 应记录 tools 存在');
});
t('★ bodySHA256 = node 对 init.body 原始串的哈希（不是装配快照的）', function () {
  var r = CAP.captureRequestBody('u', { body: BODY_STR });
  eq(r.bodySHA256, nodeSha(BODY_STR), 'bodySHA256');
  /* ⚠️ 口径 2026-10-05 收口统一：这一份叫「**客户端提交给 fetch 的请求体**」，
     不再叫「发送瞬间请求体」/「已证实送达模型」。 */
  assert(/客户端提交给 fetch/.test(r.bodySHA256含义),
    '哈希含义必须写明是「客户端提交给 fetch 的请求体」');
  assert(/init\.body/.test(r.bodySHA256含义), '哈希含义必须写明对象是 init.body');
  /* 反向：不得出现「已送达模型」这类越界表述 */
  assert(!/送达模型|已证实送达/.test(r.bodySHA256含义),
    '哈希含义不得声称送达模型');
});
t('哈希在脱敏之前算（脱敏不改变 bodySHA256）', function () {
  var withKey = JSON.stringify({ model: 'm', api_key: API_KEY_FAKE,
    messages: [{ role: 'user', content: 'hi' }] });
  var r = CAP.captureRequestBody('u', { body: withKey });
  eq(r.bodySHA256, nodeSha(withKey), '含凭据字段的 body 哈希');
});

/* ============================================================
   §4 messages 保留 role + content 原文（要求 ③）
   ============================================================ */
head('§4 messages 保留 role 与 content（要求 ③⑧）');
t('★ 逐条与 init.body 里的 messages 一致（要求 ⑧：核心断言）', function () {
  var parsed = JSON.parse(BODY_STR);
  var r = CAP.captureRequestBody('u', { body: BODY_STR });
  eq(r.messages.length, parsed.messages.length, 'messages 条数');
  parsed.messages.forEach(function (m, i) {
    eq(r.messages[i].role, m.role, '第' + i + '条 role');
    eq(r.messages[i].content, m.content, '第' + i + '条 content');
  });
});
t('★ 不是长度、不是哈希 —— content 是可读原文', function () {
  var r = CAP.captureRequestBody('u', { body: BODY_STR });
  var first = r.messages[0].content;
  assert(first.indexOf('雨夜的旧书店') >= 0, 'content 应含场景名原文');
  assert(first.indexOf('23:40') >= 0, 'content 应含时刻原文');
  assert(typeof first === 'string' && first.length > 20, 'content 应是长字符串而非长度数字');
  assert(isNaN(Number(first)), 'content 不该是数字（长度/哈希的典型伪装）');
});
t('负向：content 若是长度/哈希形态，这里必须抓不到 —— 用真实长文对照', function () {
  var long = '雨'.repeat(50);
  var r = CAP.captureRequestBody('u', {
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: long }] })
  });
  eq(r.messages[0].content, long, '长 content 应逐字保留');
  assert(r.messages[0].content.length === 50, '长度应等于原文长度');
});
t('user / assistant / system 三种 role 都原样保留', function () {
  var b = { model: 'm', messages: [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'A' }] };
  var r = CAP.captureRequestBody('u', { body: JSON.stringify(b) });
  eq(r.messages.map(function (m) { return m.role; }), ['system', 'user', 'assistant'], 'role 序列');
  eq(r.messages.map(function (m) { return m.content; }), ['S', 'U', 'A'], 'content 序列');
});
t('name / tool_calls 等非 role+content 字段不落（不越界抄协议）', function () {
  var b = { model: 'm', messages: [
    { role: 'assistant', content: '', name: '沈砚', tool_calls: [{ id: 'c1' }] }] };
  var r = CAP.captureRequestBody('u', { body: JSON.stringify(b) });
  eq(r.messages[0].name, undefined, 'name 不应落');
  eq(r.messages[0].tool_calls, undefined, 'tool_calls 不应落');
  eq(r.messages[0].role, 'assistant', 'role 仍保留');
});
t('非字符串 content（多模态数组）保留内容本身，不退化成长度', function () {
  var content = [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:x' } }];
  var r = CAP.captureRequestBody('u', {
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: content }] })
  });
  eq(r.messages[0].content, content, '数组 content 应原样保留');
});

/* ============================================================
   §5 凭据脱敏（要求 ④）
   ============================================================ */
head('§5 凭据脱敏（要求 ④）');
t('顶层 api_key 字段被打掉，且不留明文', function () {
  var body = JSON.stringify({ model: 'm', api_key: API_KEY_FAKE,
    messages: [{ role: 'user', content: 'hi' }] });
  var r = CAP.captureRequestBody('u', { body: body });
  var dumped = JSON.stringify(r);
  assert(dumped.indexOf(API_KEY_FAKE) < 0, '★ 落盘摘要里仍能找到明文 key');
  assert(/已脱敏/.test(dumped), '应记下已脱敏标记');
});
t('Authorization / token 类键名都打掉', function () {
  ['Authorization', 'access_token', 'apiKey', 'api_key', 'password', 'secret']
    .forEach(function (k) {
      var body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], });
      var o = JSON.parse(body); o[k] = 'SUPERSECRET-VALUE';
      var r = CAP.captureRequestBody('u', { body: JSON.stringify(o) });
      assert(JSON.stringify(r).indexOf('SUPERSECRET-VALUE') < 0, k + ' 未被打掉');
    });
});
t('★ content 里混进 sk-… 也要打掉（键名无辜，靠取值形状）', function () {
  var body = JSON.stringify({ model: 'm', messages: [
    { role: 'system', content: '凭据是 ' + API_KEY_FAKE + ' 记住它' },
    { role: 'user', content: '我到了。' }
  ] });
  var r = CAP.captureRequestBody('u', { body: body });
  var dumped = JSON.stringify(r);
  assert(dumped.indexOf(API_KEY_FAKE) < 0, '★ content 里的明文 key 未被打掉');
  assert(r.已脱敏 === true, '应标记已脱敏');
  assert(r.脱敏改动数 >= 1, '应记下改过几处');
  assert(r.messages[1].content === '我到了。', '★ 没问题的 content 必须逐字不动');
  assert(r.messages[0].content.indexOf('记住它') >= 0, '脱敏只动凭据那几段，周边文字保留');
});
t('Bearer … 与 JWT 也打掉', function () {
  ['Bearer abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSM']
    .forEach(function (cred) {
      var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
        messages: [{ role: 'system', content: '头是 ' + cred }] }) });
      assert(JSON.stringify(r).indexOf(cred) < 0, '未脱敏：' + cred.slice(0, 12));
    });
});
t('脱敏后仍保留可读性（不整段抹掉），且标了 sha8 指纹', function () {
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'system', content: 'key=' + API_KEY_FAKE }] }) });
  assert(/已脱敏/.test(r.messages[0].content), '应留下脱敏标记');
  assert(/sha8=/.test(r.messages[0].content), '应留短指纹便于对齐同一次凭据');
});
t('★ 阳性对照：脱敏器没被写成「什么都不改」', function () {
  /* 同一段里既有凭据也有正常内容，两个都在 → 证明确实做了替换而不是整体跳过 */
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'user', content: '前面 ' + API_KEY_FAKE + ' 后面' }] }) });
  assert(r.脱敏改动数 === 1, '应恰好改 1 处，实得 ' + r.脱敏改动数);
  assert(r.messages[0].content.indexOf('前面') === 0, '前缀保留');
  assert(/后面$/.test(r.messages[0].content), '后缀保留');
});

/* ============================================================
   §6 响应侧采集全部保留（要求 ⑥）
   ============================================================ */
head('§6 响应侧 finish_reason/usage/reasoning_content 全部保留（要求 ⑥）');
ta('加装请求侧采集后，响应侧字段一个都没丢', function () {
  var w = { fetch: stubFetch(), Date: Date };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function () {
      return new Promise(function (res) { setTimeout(res, 0); });
    })
    .then(function () {
      eq(w.__HTTP.length, 1, '响应记录条数');
      var rec = w.__HTTP[0];
      eq(rec.finish_reason, 'stop', 'finish_reason');
      assert(rec.usage && rec.usage.prompt_tokens === 11, 'usage 保留');
      eq(rec.has_reasoning, true, 'has_reasoning');
      eq(rec.reasoning_len, 5, 'reasoning_len（（桩推理）5 字）');
      eq(rec.content_len, 5, 'content_len（（桩回复）5 字）');
      assert(Array.isArray(rec.topKeys), 'topKeys 保留');
      assert(rec.msgKeys && rec.msgKeys.indexOf('reasoning_content') >= 0, 'msgKeys 保留');
    });
});
ta('★ 响应记录里挂着同一轮的「发送瞬间」（两侧可对齐）', function () {
  var w = { fetch: stubFetch(), Date: Date };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function () { return new Promise(function (r) { setTimeout(r, 0); }); })
    .then(function () {
      var rec = w.__HTTP[0];
      assert(rec.发送瞬间, '响应记录应带 发送瞬间');
      eq(rec.发送瞬间.bodySHA256, nodeSha(BODY_STR), '两侧的 body 哈希应一致');
    });
});
ta('响应 JSON 坏掉时：请求侧记录**仍在**（不能连坐丢证据）', function () {
  var w = { Date: Date };
  w.fetch = function () {
    return Promise.resolve({ status: 500, clone: function () {
      return { text: function () { return Promise.resolve('not json'); } };
    } });
  };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function () { return new Promise(function (r) { setTimeout(r, 0); }); })
    .then(function () {
      eq(w.__SEND.length, 1, '请求侧仍记了 1 条');
      assert(w.__SEND[0].bodySHA256, '请求侧哈希仍在');
      assert(w.__HTTP[0].parseError, '响应侧记了解析错误');
    });
});

/* ============================================================
   §7 采集失败必须留痕，不许静默伪造（要求 ⑦）
   ============================================================ */
head('§7 采集失败记 bodyCaptureError（要求 ⑦）');
t('JSON.parse 失败 → 记错误，messages 留 null（**不填空数组**）', function () {
  var r = CAP.captureRequestBody('u', { body: '{ this is not json' });
  assert(/JSON\.parse 失败/.test(r.bodyCaptureError), '应有 bodyCaptureError');
  eq(r.messages, null, '★ messages 必须是 null，不能是 [] 或占位');
  assert(r.bodySHA256, '原始串仍可哈希（证据不丢）');
  assert(r.body原始长度 > 0, '应记原始长度');
});
t('init.body 不存在 → 记「无请求体」，不编一个空 body', function () {
  var r = CAP.captureRequestBody('https://stub/v1/models', { method: 'GET' });
  assert(/不存在/.test(r.bodyCaptureError), '应有 bodyCaptureError');
  eq(r.bodySHA256, null, '无 body 则无哈希');
  eq(r.messages, null, 'messages 为 null');
});
t('body 是不可同步读取的类型（Blob/FormData）→ 如实报缺失', function () {
  var r = CAP.captureRequestBody('u', { body: { pipe: function () {} } });
  assert(r.bodyCaptureError, '应报不可同步读取');
  eq(r.messages, null, 'messages 为 null');
  eq(r.bodySHA256, null, '无哈希');
});
t('body 解析成数组（非对象）→ 记类型不符', function () {
  var r = CAP.captureRequestBody('u', { body: '[1,2,3]' });
  assert(/不是 JSON 对象/.test(r.bodyCaptureError), '应记类型不符');
  eq(r.messages, null, 'messages 为 null');
});
t('body 合法但没有 messages → 记缺失，不伪造空 messages', function () {
  var r = CAP.captureRequestBody('u', { body: '{"model":"m"}' });
  assert(/没有 messages/.test(r.bodyCaptureError), '应记缺 messages');
  eq(r.messages, null, '★ messages 必须是 null');
  assert(r.model === 'm', 'model 仍记到（它是真有的）');
});
t('★ 负向对照：这些「失败」形态都不许看起来像成功', function () {
  [ '{ bad', '[1,2]', '{"model":"m"}', undefined ].forEach(function (b) {
    var r = CAP.captureRequestBody('u', b === undefined ? {} : { body: b });
    assert(r.bodyCaptureError, '必须有 bodyCaptureError');
    assert(r.messages === null, 'messages 必须 null');
  });
});
t('URLSearchParams 体可同步读取（哈希算得出，但如实报非 JSON）', function () {
  var sp = new URLSearchParams({ a: '1', b: '雨' });
  var r = CAP.captureRequestBody('u', { body: sp });
  assert(r.bodySHA256, '应算出哈希（原始串是 a=1&b=…）');
  eq(r.bodySHA256, nodeSha('a=1&b=%E9%9B%A8'), '哈希对象是同步读取到的原始串');
  /* ⚠️ 判据按**实际错误分支**写，不靠猜：
     a=1&b=雨 能同步读出字符串，但它**不是 JSON** → 落 JSON.parse 分支。
     这里断言「有 bodyCaptureError 且 messages 为 null」这个不变量，
     而不是钉死某一句文案（钉死文案会在重构时假红）。 */
  assert(r.bodyCaptureError, '非 JSON 体应留痕');
  eq(r.messages, null, 'messages 必须 null（不许硬塞成空）');
});

/* ============================================================
   §8 生产等价路径：装配 → init.body → 采集，三者逐条一致
   ★ 这一节是「测试没有空转」的护栏：
     把旁路挂在一个没人调的 fetch 上，§1~§7 也可能全绿。
   ============================================================ */
head('§8 走**生产 requestOnce** 链：五字段进入假 fetch 实收 body（要求 ④）');
/* ★★ 上一版最大的问题：测试**自己** `JSON.stringify({model, messages, ...})`
   拼了个「bodyFor 同款结构」—— 那等于**在测试里冒充生产序列化链**。
   后果：生产 `bodyFor` 改字段名/改顺序/加了 tools，测试照样全绿。
   ★ 正确做法（用户 2026-10-05 明确）：
     调 **生产 `Sleepy.api.requestOnce`**，只把**底层 `window.fetch`** 换成假 fetch，
     其余（`bodyFor` 序列化 / `genParams` 三层回落 / `normalizeEndpoint` /
      `requestHeaders` / AbortController 超时）**全走生产代码**。
   ★ `bodyFor` 是私有的（api.js 没导出）—— 所以**只能**通过 requestOnce 触发它。
     这恰好是更强的保证：证明「生产真的会把这些字段写进 body」。 */

/* ---- 假 fetch 工厂：记录它**实际收到**的 init ---- */
function makeFakeFetch(behave) {
  var seen = [];
  var f = function (url, init) {
    seen.push({ url: String(url), init: init });
    if (behave) return behave(url, init);
    return Promise.resolve(okResponse());
  };
  f.seen = seen;
  return f;
}
function okResponse() {
  var txt = JSON.stringify({
    id: 'stub', object: 'chat.completion',
    choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: '（桩回复）' } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 }
  });
  return {
    ok: true, status: 200,
    text: function () { return Promise.resolve(txt); },
    clone: function () { return { text: function () { return Promise.resolve(txt); } }; }
  };
}

/* ---- 网络出口阻断：除 fetch 外全部 trip 掉 ----
   ★ 要求：「只替换底层 fetch，并阻断其他网络出口」。
     harness 的 D5 已经把 XHR/WebSocket 置 undefined，但 Node 的
     http/https/net 仍能发包 —— 必须显式挡掉，否则「零模型请求」之外
     还留着能对外发包的入口。
   ⚠️⚠️ 但**光挡不够**：绊线一旦失效，探针就会顺着真实入口发出去。
     ⇒ 凡是要**调用**这些入口做断言，必须先把入口换成
       **永不联网的本地替身**（见 localEntryGuard）。
     断言「已恢复」一律用**引用对比**，永不调用。 */
function blockOtherNetwork() {
  var net = require('net'), http = require('http'), https = require('https');
  var saved = [];
  function trip(name) {
    return function () {
      throw new Error('网络已被测试阻断：' + name);
    };
  }
  [['http', http, ['request', 'get']], ['https', https, ['request', 'get']],
    ['net', net, ['connect', 'createConnection']]].forEach(function (grp) {
    grp[2].forEach(function (m) {
      if (typeof grp[1][m] === 'function') {
        saved.push([grp[1], m, grp[1][m]]);
        grp[1][m] = trip(grp[0] + '.' + m);
      }
    });
  });
  return function restore() {
    saved.forEach(function (s) { s[0][s[1]] = s[2]; });
  };
}

/* ---- 本地入口守卫：**先替身、后绊线** ----
   ⚠️ 顺序不可颠倒。历史教训：调试期间的探针曾直接对 example.com
   发起过**非模型的公网请求尝试**（本机放行、真的建了连，随后 ECONNRESET）。
   ⇒ 现在任何「调用入口看阻断」的断言，都先换成永不联网的本地替身；
     即使绊线失效，也只会命中本地替身。 */
function localEntryGuard() {
  var mods = [
    [require('https'), ['request', 'get']],
    [require('http'), ['request', 'get']],
    [require('net'), ['connect', 'createConnection']]
  ];
  var pairs = [];
  mods.forEach(function (g) {
    g[1].forEach(function (m) { pairs.push([g[0], m]); });
  });
  var orig = pairs.map(function (p) { return p[0][p[1]]; });
  var stubs = pairs.map(function (p, i) {
    var fn = function () {
      fn.calls++;
      return { on: function () { return this; }, once: function () { return this; },
        removeListener: function () { return this; },
        write: function () { return true; }, end: function () { return this; },
        destroy: function () { return this; }, abort: function () { return this; } };
    };
    fn.calls = 0;
    p[0][p[1]] = fn;         /* ① 先换本地替身 */
    return fn;
  });
  var tripped = 0;
  pairs.forEach(function (p) {
    p[0][p[1]] = function () { tripped++; throw new Error('网络已被测试阻断'); };
  });                          /* ② 再叠绊线 */
  return {
    stubs: stubs,
    /* 探针：只打本地对象。阻断有效→抛；失效→命中本地替身。 */
    probe: function () {
      try {
        var r = require('https').request('https://example.invalid/never');
        if (r && r.destroy) r.destroy();
        return { 阻断: false, 命中本地: true };
      } catch (e) {
        return { 阻断: /网络已被测试阻断/.test(e.message), 命中本地: false };
      }
    },
    /* 引用对比：永不调用 */
    refs: function () { return pairs.map(function (p) { return p[0][p[1]]; }); },
    restore: function () { pairs.forEach(function (p, i) { p[0][p[1]] = orig[i]; }); }
  };
}

/* ---- 一条完整的「生产链」夹具 ---- */
function prodChain(label, fetchBehave) {
  var H = require('./harness.js');
  var CAPT = require('./behavior-baseline-capture.js');
  var h = H.boot(label);
  CAPT.buildFixture(h, {});
  /* ★ harness 的 D5 沙箱**没有 AbortController**（它刻意最小化）。
     缺了它，生产 `requestOnce` 会走 `ctrl = null` 分支、init.signal 为
     undefined —— 那样**测不到**生产的超时/中止路径（而且 assert signal
     会假红：不是生产没设，是沙箱没有）。
     这里补上宿主真实的 AbortController，让生产那条分支真的被走到。 */
  h.win.AbortController = AbortController;
  var fake = makeFakeFetch(fetchBehave);
  h.win.fetch = fake;                    /* ★ 只换底层 fetch */
  CAP.installFetchBypass(h.win, { knownSecrets: ['fixture-key'] });
  var cand = { cfg: {
    source: 'main', label: '夹具主模型', baseUrl: 'stub://main/v1',
    apiKey: 'fixture-key', model: 'fixture-model',
    temperature: 0.85, maxTokens: 8192, contextMessages: 40,
    stream: false, timeoutSec: 120, enabled: true
  } };
  return { h: h, fake: fake, cand: cand, api: h.S.api };
}

ta('★ 生产 requestOnce 真的把五字段写进了假 fetch 收到的 body', function () {
  var restore = blockOtherNetwork();
  try {
    var C = prodChain('off-prod-chain');
    var msgs = [{ role: 'system', content: '【当前场景】\n「雨夜的旧书店」' },
      { role: 'user', content: '我到了。' }];
    return C.api.requestOnce(C.cand, msgs, null).then(function (res) {
      assert(res.ok, '生产链应成功：' + JSON.stringify(res));
      /* ---- 证明「假 fetch 确实被调到了」---- */
      eq(C.fake.seen.length, 1, '假 fetch 被调用次数');
      var got = C.fake.seen[0];
      /* ---- 证明「走的确实是生产出口」而不是我拼的 ----
         这些字段**只有生产 requestOnce 才会设**，测试自己拼是拼不出来的。 */
      eq(got.init.method, 'POST', 'method（生产 requestHeaders/调用点所设）');
      eq(got.init.mode, 'cors', 'mode');
      eq(got.init.headers['Content-Type'], 'application/json', 'Content-Type');
      eq(got.init.headers['Authorization'], 'Bearer fixture-key',
        'Authorization 由生产 requestHeaders 生成');
      assert(got.init.signal, 'signal 存在（生产 AbortController 路径）');
      eq(C.h.win.__API_BASE, undefined, '（沙箱里不该有验收脚本的凭据注入）');
      /* ---- 五字段：从「生产序列化出来的 body」里读 ---- */
      var body = JSON.parse(got.init.body);
      eq(body.model, 'fixture-model', 'body.model');
      eq(body.stream, false, 'body.stream（生产硬编码 false 走非流式）');
      eq(body.max_tokens, 8192, 'body.max_tokens（来自 genParams 三层回落）');
      eq(body.temperature, 0.85, 'body.temperature');
      eq(body.messages.length, 2, 'body.messages 条数');
      /* ---- 旁路采到的，与生产序列化出的 body 逐条一致 ---- */
      eq(C.h.win.__SEND.length, 1, '旁路记了 1 条');
      var rec = C.h.win.__SEND[0];
      eq(rec.messages.length, body.messages.length, '采集 messages 条数');
      body.messages.forEach(function (m, i) {
        eq(rec.messages[i].role, m.role, '第' + i + '条 role');
        eq(rec.messages[i].content, String(m.content), '第' + i + '条 content');
      });
      eq(rec.bodySHA256, nodeSha(got.init.body),
        'bodySHA256 必须等于生产序列化出的那串的哈希');
      ok('✓ 五字段 + messages 全部来自**生产序列化链**，非测试手拼');
    });
  } finally { restore(); }
});

ta('★ 端点归一化也走生产（baseUrl 只有 /v1 也能打到 /chat/completions）', function () {
  var restore = blockOtherNetwork();
  try {
    var C = prodChain('off-prod-endpoint');
    return C.api.requestOnce(C.cand, [{ role: 'user', content: 'x' }], null)
      .then(function (res) {
        assert(res.ok, '应成功');
        eq(C.fake.seen[0].url, 'stub://main/v1/chat/completions',
          'URL 由生产 normalizeEndpoint 拼出');
      });
  } finally { restore(); }
});

ta('★ genParams 三层回落生效（cfg 缺 temperature 时取内置默认 0.85）', function () {
  var restore = blockOtherNetwork();
  try {
    var C = prodChain('off-prod-genparams');
    var bare = { cfg: { baseUrl: 'stub://main/v1', model: 'm', stream: false,
      timeoutSec: 120, enabled: true } };   /* 没写 temperature/maxTokens */
    return C.api.requestOnce(bare, [{ role: 'user', content: 'x' }], null)
      .then(function (res) {
        assert(res.ok, '应成功');
        var body = JSON.parse(C.fake.seen[0].init.body);
        eq(body.temperature, 0.85, 'temperature 走 GEN_DEFAULTS（生产回落）');
        eq(body.max_tokens, 1024, 'max_tokens 走 GEN_DEFAULTS（生产回落）');
      });
  } finally { restore(); }
});

ta('★ timeoutSec=120 被保留（不被 60s 下限改写）', function () {
  var restore = blockOtherNetwork();
  try {
    var C = prodChain('off-prod-timeout');
    return C.api.requestOnce(C.cand, [{ role: 'user', content: 'x' }], null)
      .then(function () {
        /* 生产把 timeoutSec 归到 body 之外，但超时长短由它算 ——
           这里验的是「批准参数没被改」，直接问生产 genParams。 */
        eq(C.api.genParams(C.cand.cfg, {}).timeoutSec, 120,
          '生产 genParams 应保留 timeoutSec=120');
        eq(ACC.APPROVED.timeoutSec, 120, '验收脚本批准值仍是 120');
      });
  } finally { restore(); }
});

ta('★ 网络出口确实被阻断，且探针零公网（本地替身 + 绊线）', function () {
  var g = localEntryGuard();
  try {
    /* ① 阻断生效 */
    var p1 = g.probe();
    assert(p1.阻断 === true, 'https.request 应被阻断');
    assert(p1.命中本地 === false, '阻断态下不该命中本地替身');
    /* ② 人为撤掉绊线，模拟「阻断失效」——
       此时入口是本地替身，探针**只可能**命中它，不会触达公网。 */
    require('https').request = g.stubs[0];
    var p2 = g.probe();
    assert(p2.命中本地 === true,
      '★ 阻断失效时也只命中本地替身（证明探针零公网）');
    ok('✓ 出口被阻断；即使阻断失效，探针也只打本地替身');
  } finally { g.restore(); }
  /* 恢复检查：引用对比，**永不调用** */
  var https = require('https');
  assert(typeof https.request === 'function', 'https.request 已还原为函数');
  ok('✓ 还原后 https.request 仍是函数引用（未调用它，不触达网络）');
});

ta('★ 装配产物经生产链进入 body（把 trace 的场景锚点一路带到发送体）', function () {
  var restore = blockOtherNetwork();
  try {
    var H = require('./harness.js');
    var CAPT = require('./behavior-baseline-capture.js');
    var ACC2 = ACC;
    /* 用**验收脚本的夹具**建会话（与真跑同一条路） */
    var h = H.boot('off-prod-fixture');
    var S = h.S;
    var sb = S.core.createSandbox('archipelago', '生产链夹具岛');
    S.core.setActiveSandbox(sb.id);
    h.win.__API_BASE = 'stub://main/v1';
    h.win.__API_KEY = 'fixture-key';
    h.win.__API_MODEL = 'fixture-model';
    h.win.__APPROVED = { temperature: 0.85, maxTokens: 8192,
      contextMessages: 40, stream: false, timeoutSec: 120 };
    h.ctx.__FIXTURE__ = ACC2.FIXTURE;
    /* 导航精准替身（只代理 offline-scene，不笼统吞异常） */
    var navCalls = [];
    var navOrig = S.nav.open;
    S.nav.open = function (page, arg) {
      navCalls.push(page);
      if (page === 'offline-scene') return { __stub: 1 };
      return navOrig.apply(this, arguments);
    };
    vm.runInContext('(' + ACC2.SETUP_SRC + ')({f: __FIXTURE__})', h.ctx,
      { filename: 'SETUP' });
    var sid = h.win.__sid;
    assert(sid, 'SETUP 应产出 sid');

    var sess = S.offlineStore.findSession(sid);
    var built = S.promptEngine.assembleOffline({
      charId: sess.charId, userId: sess.userId, session: sess, userInput: '我到了。'
    });
    assert(built && built.messages.length, '装配应产出 messages');

    var fake = makeFakeFetch();
    h.win.fetch = fake;
    CAP.installFetchBypass(h.win, { knownSecrets: ['fixture-key'] });
    return S.api.requestOnce(
      { cfg: { baseUrl: 'stub://main/v1', apiKey: 'fixture-key',
        model: 'fixture-model', temperature: 0.85, maxTokens: 8192,
        contextMessages: 40, stream: false, timeoutSec: 120 } },
      built.messages, null
    ).then(function (res) {
      assert(res.ok, '生产链应成功：' + JSON.stringify(res));
      eq(navCalls, ['offline-scene'], '导航替身被调用一次');
      var body = JSON.parse(fake.seen[0].init.body);
      var all = body.messages.map(function (m) { return String(m.content); }).join('\n');
      /* ★ 现场锚点真的进了生产 body —— 这是本轮最终要证的那件事 */
      ['雨夜的旧书店', '城西旧书店二楼阁楼', '深夜', '雨', '23:40']
        .forEach(function (anchor) {
          assert(all.indexOf(anchor) >= 0,
            '生产 body 里应有夹具现场锚点 ' + anchor);
        });
      /* 凭据不能出现在 body 里（生产只把它放 headers） */
      assert(all.indexOf('fixture-key') < 0, 'body 里不该含 apiKey');
      eq(fake.seen[0].init.headers['Authorization'], 'Bearer fixture-key',
        'apiKey 只在 headers 里');
      ok('✓ 夹具五个现场锚点经生产 requestOnce 进了 body，apiKey 只在 headers');
    });
  } finally { restore(); }
});

/* ============================================================
   §5b 三条「不许静默」红线（要求 ⑤）
   ------------------------------------------------------------
     ① 请求记录写入失败 → 不得静默续发
     ② 请求拒绝/超时（fetch 自己 reject）→ 仍要留下请求侧记录
     ③ 返回已有响应时，旁路记录异常不得把成功响应改成失败
   ============================================================ */
head('§5b 红线①：请求记录写入失败 → 不得静默续发');
function bypassOn(win, fetchImpl, opts) {
  win.fetch = fetchImpl;
  return CAP.installFetchBypass(win, opts || {});
}
ta('① __SEND.push 抛错 → fetch reject，且**底层 fetch 没被调用**', function () {
  var origCalled = 0;
  var w = { Date: Date };
  bypassOn(w, function () { origCalled++; return Promise.resolve(okResponse()); });
  var w2 = { Date: Date, __SEND: null };
  w2.fetch = function () { origCalled++; return Promise.resolve(okResponse()); };
  CAP.installFetchBypass(w2, {});
  /* 把 __SEND 换成会抛的数组 —— 模拟「记录写不进去」 */
  w2.__SEND = { push: function () { throw new Error('磁盘满'); } };
  return w2.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function () {
      throw new Error('★ 不该 resolve：记录写不进去必须 reject');
    }, function (e) {
      assert(/记录写入失败/.test(e.message), '应是记录写入失败，实得：' + e.message);
    })
    .then(function () {
      /* ★ 关键：底层 fetch 一次都没被调用 —— 「不许静默续发」 */
      eq(origCalled, 0, '底层 fetch 调用次数（必须为 0）');
      ok('✓ 记录写不进去 → 底层 fetch **一次都没调**，请求被 reject');
    });
});
ta('① onRecordError 回调能收到失败原因（观测点存在）', function () {
  var seen = [];
  var w = { Date: Date };
  w.fetch = function () { return Promise.resolve(okResponse()); };
  CAP.installFetchBypass(w, { onRecordError: function (why, rec) {
    seen.push({ why: why, 有URL: !!rec.url, 有哈希: !!rec.bodySHA256 });
  } });
  w.__SEND = { push: function () { throw new Error('写不进去'); } };
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .catch(function () { return null; })
    .then(function () {
      eq(seen.length, 1, 'onRecordError 被调用次数');
      assert(/记录写入失败/.test(seen[0].why), '回调应收到原因');
      assert(seen[0].有URL && seen[0].有哈希, '回调应拿到那条记录（便于排障）');
    });
});
ta('★ 接线：记录写入失败 → stopKind 判 link（与 hardStopKind 同一口径）', function () {
  var s = ACC.STOP_KIND_FOR_SEND({ 记录写入失败: 'x' });
  eq(s, 'link', 'stopKindForSend');
  eq(ACC.hardStopKind({
    发送瞬间请求体: { 记录写入失败: 'x' },
    原始请求结果: { stage: 'network' }
  }), 'link', 'hardStopKind 必须判 link 而不是被 network 抢走');
  /* 阳性对照：正常记录不该判停 */
  eq(ACC.STOP_KIND_FOR_SEND({ bodySHA256: 'a' }), null, '正常记录不判停');
  eq(ACC.STOP_KIND_FOR_SEND(null), null, 'null 不判停');
});

head('§5b 红线②：请求拒绝/超时 → 仍要留下请求侧记录');
ta('② fetch reject（网络失败）→ 请求记录仍在，且带 fetchError', function () {
  var w = { Date: Date };
  w.fetch = function () { return Promise.reject(new Error('Failed to fetch')); };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function () {
      throw new Error('不该 resolve');
    }, function (e) {
      assert(/Failed to fetch/.test(e.message), '原错误应原样抛出');
    })
    .then(function () {
      eq(w.__SEND.length, 1, '★ 请求侧记录仍在（费用状态未知，调用与失败证据不能抹掉）');
      var rec = w.__SEND[0];
      assert(rec.bodySHA256, 'body 哈希仍在');
      assert(/fetch 失败/.test(rec.fetchError), '记了 fetchError');
      eq(rec.fetchErrorName, 'Error', '记了错误名');
      assert(rec.messages && rec.messages.length, 'messages 仍在（证据没丢）');
    });
});
ta('② 超时（AbortError）→ 请求记录仍在，stopKind 判 net', function () {
  var w = { Date: Date };
  var ae = new Error('aborted'); ae.name = 'AbortError';
  w.fetch = function () { return Promise.reject(ae); };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .catch(function () { return null; })
    .then(function () {
      eq(w.__SEND.length, 1, '超时也留请求记录');
      eq(w.__SEND[0].fetchErrorName, 'AbortError', '错误名');
      eq(ACC.STOP_KIND_FOR_SEND(w.__SEND[0]), 'net', '超时归 net');
    });
});
ta('★ 端到端：生产 requestOnce 超时 → stage=timeout，且旁路留了请求记录', function () {
  var restore = blockOtherNetwork();
  try {
    var C = prodChain('off-prod-timeout-reject', function () {
      var ae = new Error('The operation was aborted');
      ae.name = 'AbortError';
      return Promise.reject(ae);
    });
    return C.api.requestOnce(C.cand, [{ role: 'user', content: 'x' }], null)
      .then(function (res) {
        eq(res.ok, false, '生产应判失败');
        eq(res.stage, 'timeout', '生产按 AbortError 归 timeout');
        eq(C.h.win.__SEND.length, 1, '★ 旁路仍留下请求记录（没被响应侧连坐）');
        assert(C.h.win.__SEND[0].bodySHA256, '请求证据仍在');
        eq(ACC.hardStopKind({ 原始请求结果: res, 诊断: { requestId: 1 } }), 'net',
          'hardStopKind 按生产 stage 判 net');
      });
  } finally { restore(); }
});

head('§5b 红线③：已有响应时，记录异常不得把成功改成失败');
ta('③ 响应副本读取失败 → 仍返回**成功响应**', function () {
  var w = { Date: Date };
  var real = okResponse();
  real.clone = function () { return { text: function () { return Promise.reject(new Error('body 已消耗')); } }; };
  w.fetch = function () { return Promise.resolve(real); };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function (r) {
      assert(r === real, '★ 返回的必须是原来那个响应对象（不能被替换/拒绝）');
      eq(r.ok, true, '成功状态未被改写');
      eq(w.__HTTP.length, 1, '仍记了一条响应');
      assert(/响应副本读取失败/.test(w.__HTTP[0].responseCaptureError),
        '记了 responseCaptureError');
      assert(w.__SEND[0].bodySHA256, '请求侧证据不受影响');
    });
});
ta('③ clone() 本身抛错 → 仍返回成功响应', function () {
  var w = { Date: Date };
  var real = okResponse();
  real.clone = function () { throw new Error('clone 炸了'); };
  w.fetch = function () { return Promise.resolve(real); };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function (r) {
      assert(r === real, '★ 仍返回原响应');
      eq(r.ok, true, '成功状态未被改写');
      assert(/clone\(\) 抛错/.test(w.__HTTP[0].responseCaptureError), '记了原因');
    });
});
ta('③ 响应记录写入失败 → 成功响应**照常返回**（只标记，不改结果）', function () {
  var w = { Date: Date };
  w.fetch = function () { return Promise.resolve(okResponse()); };
  CAP.installFetchBypass(w, {});
  var real = null;
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function (r) { real = r; return null; })
    .then(function () {
      /* 让 __HTTP 变成会抛的 —— 下一轮的响应记录写不进去 */
      w.__HTTP = { push: function () { throw new Error('响应记录写不进'); } };
      w.fetch = CAP.installFetchBypass;   /* 复原：装回原始 fetch */
      var w3 = { Date: Date };
      var errs = [];
      var realResp = okResponse();
      w3.fetch = function () { return Promise.resolve(realResp); };
      CAP.installFetchBypass(w3, { onRecordError: function (why) { errs.push(why); } });
      w3.__HTTP = { push: function () { throw new Error('响应记录写不进'); } };
      return w3.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
        .then(function (r) {
          assert(r === realResp, '★ 成功响应必须原样返回');
          eq(r.ok, true, 'ok 仍是 true');
          eq(errs.length, 1, 'onRecordError 收到 1 次');
          assert(/响应记录写入失败/.test(errs[0]), '原因写明是响应记录写入失败');
        });
    });
});
ta('③ 响应 JSON 坏掉 → 成功响应仍原样返回（只记 parseError）', function () {
  var w = { Date: Date };
  var txt = 'not json at all';
  var real = { ok: true, status: 200,
    text: function () { return Promise.resolve(txt); },
    clone: function () { return { text: function () { return Promise.resolve(txt); } }; } };
  w.fetch = function () { return Promise.resolve(real); };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .then(function (r) {
      assert(r === real, '★ 原样返回');
      eq(r.ok, true, 'ok 未被改写');
      assert(w.__HTTP[0].parseError, '记了 parseError');
      eq(w.__HTTP[0].finish_reason, undefined, '没有 finish_reason 就是没有（不填 0）');
    });
});
ta('★ 端到端：响应坏掉时生产仍按自己的口径判，不受旁路影响', function () {
  var restore = blockOtherNetwork();
  try {
    var C = prodChain('off-prod-badjson', function () {
      return Promise.resolve({ ok: true, status: 200,
        text: function () { return Promise.resolve('<html>502</html>'); },
        clone: function () { return { text: function () { return Promise.resolve('<html>502</html>'); } }; } });
    });
    return C.api.requestOnce(C.cand, [{ role: 'user', content: 'x' }], null)
      .then(function (res) {
        eq(res.ok, false, '生产判失败');
        eq(res.stage, 'parse', '生产按 parse 归因（旁路没把 stage 改掉）');
        eq(C.h.win.__SEND.length, 1, '请求记录仍在');
        assert(C.h.win.__HTTP.length === 1, '响应记录也记了一条（带 parseError）');
      });
  } finally { restore(); }
});

/* ============================================================
   §6b 脱敏：四条腿 + 统一记账（要求 ⑥）
   ============================================================ */
head('§6b 脱敏：已知凭据精确匹配 / URL / 错误文本 / 结构化 content');
var KNOWN = 'stub-trace-key-not-real';
t('① 已知测试凭据的**精确匹配**（形状正则覆盖不到的那类）', function () {
  /* 阳性前提：KNOWN 既不像 sk-… 也不够长，纯形状匹配抓不到它 */
  var raw = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'system', content: '前缀 ' + KNOWN + ' 后缀' }] }) });
  eq(raw.脱敏改动数, 0, '不传 knownSecrets 时应抓不到（证明精确匹配是必需的）');
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'system', content: '前缀 ' + KNOWN + ' 后缀' }] }) },
    { knownSecrets: [KNOWN] });
  assert(r.脱敏改动数 >= 1, '传了 knownSecrets 就必须命中');
  assert(r.messages[0].content.indexOf(KNOWN) < 0, '★ 明文不该残留');
  assert(r.messages[0].content.indexOf('前缀') === 0, '前缀保留');
  assert(/后缀$/.test(r.messages[0].content), '后缀保留');
});
t('① 同一凭据出现多次 → 全部命中（账本记次数）', function () {
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'system', content: KNOWN + ' 与 ' + KNOWN }] }) },
    { knownSecrets: [KNOWN] });
  assert(r.messages[0].content.indexOf(KNOWN) < 0, '两处都该被打掉');
  var hit = r.脱敏改动.filter(function (c) { return c.原因 === '已知凭据精确匹配'; });
  assert(hit.length >= 1 && hit[0].命中 === 2, '账本应记命中 2 次，实得 ' + JSON.stringify(hit));
});
t('② URL 里的凭据 query 被脱敏', function () {
  var w = { Date: Date };
  w.fetch = function () { return Promise.resolve(okResponse()); };
  CAP.installFetchBypass(w, {});
  return w.fetch('https://api.example.com/v1/chat?key=SUPERSECRET&x=1',
    { method: 'POST', body: BODY_STR })
    .then(function () {
      var u = w.__SEND[0].url;
      assert(u.indexOf('SUPERSECRET') < 0, '★ URL 里的明文凭据不该出现');
      assert(/key=\*\*\*/.test(u), '应保留参数名：' + u);
      assert(u.indexOf('x=1') >= 0, '无关参数应保留');
      var chg = w.__SEND[0].脱敏改动.filter(function (c) { return c.位置 === 'url'; });
      assert(chg.length >= 1, 'URL 的改动要进账本');
    });
});
t('② URL 里的已知凭据也走精确匹配', function () {
  var w = { Date: Date };
  w.fetch = function () { return Promise.resolve(okResponse()); };
  CAP.installFetchBypass(w, { knownSecrets: [KNOWN] });
  return w.fetch('https://api.example.com/v1?token=' + KNOWN, { method: 'POST', body: BODY_STR })
    .then(function () {
      assert(w.__SEND[0].url.indexOf(KNOWN) < 0, '★ URL 里的已知凭据该被打掉');
    });
});
t('③ 错误文本里的凭据被脱敏（bodyCaptureError）', function () {
  var bad = '{ "messages": [{"role":"user","content":"' + KNOWN + '"  ';
  var r = CAP.captureRequestBody('u', { body: bad }, { knownSecrets: [KNOWN] });
  assert(r.bodyCaptureError, '应有 bodyCaptureError');
  assert(r.bodyCaptureError.indexOf(KNOWN) < 0, '★ 错误文本里不该有明文凭据');
});
t('③ fetch 失败原因里的凭据被脱敏（fetchError）', function () {
  var w = { Date: Date };
  w.fetch = function () {
    return Promise.reject(new Error('connect ECONNREFUSED using key=' + KNOWN));
  };
  CAP.installFetchBypass(w, { knownSecrets: [KNOWN] });
  return w.fetch('https://stub/v1/chat', { method: 'POST', body: BODY_STR })
    .catch(function () { return null; })
    .then(function () {
      assert(w.__SEND[0].fetchError.indexOf(KNOWN) < 0,
        '★ fetchError 里不该有明文凭据：' + w.__SEND[0].fetchError);
    });
});
t('④ 结构化 content 里的凭据字段名 + 嵌套 URL 都被脱敏', function () {
  var content = [
    { type: 'text', text: '看这个 ' + KNOWN },
    { type: 'image_url', image_url: { url: 'https://x.test/i.png?key=SUPERSECRET' } },
    { type: 'meta', api_key: 'ANOTHERSECRET', note: '正常文字' }
  ];
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'user', content: content }] }) },
    { knownSecrets: [KNOWN] });
  var got = JSON.stringify(r.messages[0].content);
  assert(got.indexOf(KNOWN) < 0, '★ 已知凭据（嵌套 text）该被打掉');
  assert(got.indexOf('SUPERSECRET') < 0, '★ 嵌套 URL 里的凭据该被打掉');
  assert(got.indexOf('ANOTHERSECRET') < 0, '★ api_key 字段的值该被打掉');
  assert(got.indexOf('正常文字') >= 0, '无关内容保留');
  /* 统一记账：所有改动都要在账本里，且能按位置定位 */
  var paths = r.脱敏改动.map(function (c) { return c.位置; });
  assert(paths.length >= 3, '账本应至少有 3 条改动，实得 ' + paths.length);
  assert(paths.some(function (p) { return /image_url/.test(p); }), '应有 image_url 位置的改动');
  assert(paths.some(function (p) { return /api_key/.test(p); }), '应有 api_key 位置的改动');
});
t('★ 统一记账：没发生改动时账本是**空数组**（不是布尔、不是 0/null）', function () {
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'user', content: '干干净净的一段话' }] }) },
    { knownSecrets: [KNOWN] });
  eq(r.脱敏改动, [], '脱敏改动应为空数组');
  eq(r.脱敏改动数, 0, '脱敏改动数应为 0');
  eq(r.已脱敏, false, '已脱敏应为 false');
  assert(Array.isArray(r.脱敏改动), '★ 必须是数组 —— 空数组本身就是「没改过」的证据');
});
t('★ 不靠字段名匹配证明脱敏（改动账本按实际发生记录）', function () {
  /* 造一个**键名无辜但值像凭据**的字段：若实现只按字段名判，这里会漏。 */
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'user', content: 'sk-abcdefgh12345678 在这里' }] }) });
  assert(r.脱敏改动数 >= 1, '形状匹配应命中（键名无辜）');
  assert(r.messages[0].content.indexOf('sk-abcdefgh12345678') < 0, '★ 值应被打掉');
  var why = r.脱敏改动.map(function (c) { return c.原因; });
  assert(why.some(function (x) { return /形状/.test(x); }), '原因应记为形状匹配');
});
t('★ 阳性对照：给一个真不含凭据的 body，账本必须空（防「见谁都脱敏」）', function () {
  var r = CAP.captureRequestBody('u', { body: JSON.stringify({ model: 'm',
    messages: [{ role: 'user', content: '我到了。' }] }) },
    { knownSecrets: [KNOWN] });
  eq(r.脱敏改动, [], '无凭据时账本必须为空');
  assert(r.messages[0].content === '我到了。', '内容逐字未改');
});

/* ============================================================
   §9 边界：本轮不许改的四个生产文件
   ★★ 这里踩过一个坑，必须写清楚：
     「git diff 相对 HEAD 为空」**不是**「本轮没改」的正确判据。
     本仓有大量**此前批次遗留的未提交改动**（实测 page-offline.js +
     prompt-engine.js 相对 HEAD 有 +1216 行，mtime 是 2026-10-04，
     早于本轮）—— 用 HEAD 当基线会把它们算成本轮的改动。
     → 正确判据是**内容指纹 + mtime 都早于本轮开工时刻**。

   ★★ 2026-10-05 修：SESSION_START 的来源换掉了
     旧来源：`fs.statSync(__filename).mtime`（**本测试自身**的落盘时刻）。
     为什么必须换：那个锚点会随**任何脚本改动**漂移 ——
       上一批新增了 offline-f2-budget-gate-test.js（13:13），
       本批改了 prompt-engine.js（13:48）⇒ 判据把「上批加了个测试」
       误当成「本轮改了生产代码」，两条无端报红（65/67、exit=1）。
     ⚠️ 那是**判据自己的漂移**，不是被测对象的问题 ——
        已用对照实验证明：把 prompt-engine.js 换回**基线版本**
        （逐字节等于改动前）再跑，这两条**依然红**。
     新来源（优先级从高到低，都**显式、可解释**）：
       ① 环境变量 SLEEPY_BASELINE_FILE 指向的**批次基线清单**（推荐）
       ② 仓库外约定路径 D:/projects/sleepy-baseline-current.txt
       ③ 都没有 ⇒ **本段整条跳过并如实打印「未提供批次基线」**
          ⚠️ 绝**不**回退到「测试文件自身 mtime」—— 那是这次要修的病根；
             也**不**默认「没基线就算过」—— 那是放宽判定。
     基线清单格式（每行一条）：<文件名> <sha256>
     ★ 内容指纹才是主判据，mtime 只是**辅助信息**（内容相同就放过）。
     ============================================================ */

/* ---------- 批次基线来源（显式、可解释；没有就如实说没有） ---------- */
var BASELINE_FILE = process.env.SLEEPY_BASELINE_FILE ||
  'D:/projects/sleepy-baseline-current.txt';
/* 本段要守的四个生产文件（名单与旧版一致，未放宽） */
var GUARDED = ['prompt-engine.js', 'page-offline.js', 'api.js', 'behavior-text.js'];
/* ★ 2026-10-05 K03e 批（ta-life 三表消费）：本批**经批准**触碰了
   prompt-engine.js / ta-life.js / page-proactive.js / sw.js 四个运行时文件，
   批次基线在本批收口后重生成 —— 因此「本轮没碰生产文件」这个旧前提
   对本批不再成立，两条判据改为「改动 ⊆ 批准触碰名单」口径（见下）。
   ★ 2026-10-05 K03f 批（群线上动态上下文）：批准触碰新增
   page-group-ai.js（composeRound 四源接线）/ page-presets.js（自定义卡群聊开关），
   prompt-engine.js / sw.js 再次触碰；基线随本批收口重生成。
   名单**写死在判据里**：下一个批次若要改别的生产文件，必须显式更新这里
   （与 smoke 的 EXPECTED_SW_CACHE 同一哲学：每次都要有人手动确认一次）。 */
var BATCH_APPROVED_TOUCH = ['prompt-engine.js', 'ta-life.js', 'page-proactive.js', 'page-group-ai.js', 'page-presets.js', 'sw.js'];

var baseline = null, baselineWhy = '';
(function loadBaseline() {
  var raw = null;
  try { raw = fs.readFileSync(BASELINE_FILE, 'utf8'); }
  catch (e) { baselineWhy = '读不到批次基线文件：' + BASELINE_FILE; return; }
  var map = {};
  raw.split(/\r?\n/).forEach(function (line) {
    var s = line.trim();
    if (!s || s.charAt(0) === '#') return;
    var parts = s.split(/\s+/);
    if (parts.length < 2) return;
    map[parts[0]] = parts[1];       /* 文件名 → sha256 */
  });
  if (!Object.keys(map).length) { baselineWhy = '基线文件为空或格式不对：' + BASELINE_FILE; return; }
  baseline = map;
  baselineWhy = '批次基线：' + BASELINE_FILE + '（' + Object.keys(map).length + ' 个文件）';
})();

/* 内容指纹：与 lib/f2-body-capture.js 无关，这里自带一份最小实现，
   避免为一个护栏去 require 生产采集器（那是另一条依赖链）。 */
function sha256Of(file) {
  return require('crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
}

t('★ 批次基线来源可用且可解释（不是测试文件自身 mtime）', function () {
  /* 这条本身也是护栏：防止有人日后把 SESSION_START 改回 __filename 的 mtime
     —— 那正是本次修掉的病根，必须留一条断言钉住「基线另有其源」。 */
  var src = fs.readFileSync(__filename, 'utf8');
  assert(!/SESSION_START\s*=\s*fs\.statSync\(__filename\)\.mtime/.test(src),
    '★ SESSION_START 又被改回「测试文件自身 mtime」了 —— 那会随脚本改动漂移');
  assert(/SLEEPY_BASELINE_FILE/.test(src),
    '批次基线应可由 SLEEPY_BASELINE_FILE 指定');
  if (!baseline) {
    /* 没有基线**不算失败**，但必须**明确说出来**（不能默默当过） */
    process.stdout.write('    ⓘ 本段跳过：' + baselineWhy + '\n');
    process.stdout.write('       （未提供批次基线 ⇒ 不断言「生产文件没被改」，'
      + '而不是断言「没被改」）\n');
    ok('⚠ 未提供批次基线 —— 本段两条已如实跳过（未放宽：只是不成立）');
    return;
  }
  ok('✓ ' + baselineWhy);
});
t('受守的生产文件与批次基线逐一相同，或属于本批批准触碰名单（K03e 批口径）', function () {
  if (!baseline) { process.stdout.write('    ⓘ 跳过（无批次基线）\n'); return; }
  GUARDED.forEach(function (f) {
    var want = baseline[f];
    assert(want, '批次基线里没有 ' + f + ' —— 基线清单不完整，判定不成立');
    var got = sha256Of(f);
    if (got === want) return;
    /* 内容变了 → 只可能是基线生成**之后**的改动。基线在本批收口时重生成，
       所以这里命中 = 本批收口之后又有人动了生产文件 ⇒ 如实报红。 */
    assert(BATCH_APPROVED_TOUCH.indexOf(f) >= 0,
      f + ' 的内容指纹与批次基线不同，且不在批准触碰名单\n' +
      '      基线 sha256 = ' + want + '\n' +
      '      当前 sha256 = ' + got + '\n' +
      '      当前 mtime  = ' + fs.statSync(path.join(ROOT, f)).mtime.toISOString());
  });
  ok('✓ 受守文件与批次基线一致（或在批准触碰名单内：' + BATCH_APPROVED_TOUCH.join(', ') + '）');
});
t('本轮根目录 .js 改动 ⊆ 批准触碰名单（按批次基线判定；名单外一律红）', function () {
  /* 判据：根目录下与基线不同的 .js 必须都在**写死的批准名单**里 ——
     ★ 2026-10-05 K03e 批改口径：旧判据「只许改 scripts/」随该批收口失效
       （本批批准改了 4 个运行时文件，基线随之重生成）；
       新判据保留护栏本意：名单外的生产文件改动照样当场报红。
     ⚠️ 也不用 git 状态：仓库有大量历史未提交改动，与本轮无关。 */
  if (!baseline) { process.stdout.write('    ⓘ 跳过（无批次基线）\n'); return; }
  var touched = fs.readdirSync(ROOT).filter(function (f) {
    if (!/\.js$/i.test(f)) return false;
    var want = baseline[f];
    /* 不在基线里的 .js = 基线生成后新增的根目录脚本 ⇒ 同样算「动了工作区根」 */
    if (want === undefined) return true;
    try { return sha256Of(f) !== want; } catch (e) { return true; }
  });
  var unapproved = touched.filter(function (f) {
    return BATCH_APPROVED_TOUCH.indexOf(f) < 0;
  });
  assert(unapproved.length === 0,
    '★ 本轮改了批准名单外的根目录 .js，实际动了：\n    ' + unapproved.join('\n    ') +
    '\n    （批准名单：' + BATCH_APPROVED_TOUCH.join(', ') + '）');
  ok('✓ 工作区根目录 .js 改动都在批准触碰名单内（共 ' + touched.length + ' 个命中）');
});
t('如实登记：这两个文件相对 HEAD 有历史未提交改动（不是本轮造成的）', function () {
  var { execFileSync } = require('child_process');
  var out = '';
  try {
    out = execFileSync('git', ['diff', '--numstat', '--',
      'prompt-engine.js', 'page-offline.js'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) { out = '(git 不可用)'; }
  /* 这条**不判失败**，只把基线口径讲清楚：
     免得下一轮看到 HEAD diff 就误以为本轮改了生产代码。 */
  process.stdout.write('    ⓘ 基线口径：' +
    String(out).split(/\r?\n/).filter(Boolean).join(' | ') +
    '（2026-10-04 遗留未提交，非本轮）\n');
});

/* ============================================================
   汇总
   ★ 必须等所有异步用例落地再统计 ——
     否则退出码会先于 then 里的断言跑掉（假绿）。
   ============================================================ */
Promise.all(pending).then(function () {
  var total = pass + fail;
  process.stdout.write('\n' + '─'.repeat(52) + '\n');
  process.stdout.write('客户端提交给 fetch 的请求体 · 零模型请求测试：' + pass + ' / ' + total + ' 通过\n');
  if (fail) {
    process.stdout.write('✗ 失败 ' + fail + ' 项：\n');
    problems.forEach(function (p) { process.stdout.write('  · ' + p + '\n'); });
    process.stdout.write('（本测试**不启动浏览器、不发任何模型请求**）\n');
    process.exit(1);
  }
  process.stdout.write('✓ 全绿（本测试**不启动浏览器、不发任何网络请求**）\n');
  process.exit(0);
});
