#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-effect-fields-test.js
   —— P0 本地自检：归因字段路径是否真的抓得到（**零付费**）

   ★ 要解决的真问题（用户指出）：
     方案要求落盘 finish_reason / usage / reasoning_content，
     但**真实中转可能返回另一种结构**。若不先验证，
     就会「付费请求发出去才发现落盘字段全是空」——
     钱花了、归因仍然做不了。

     所以本脚本用**本地桩响应**（不联网、不需要凭据）验证三件事：
       ① 抓取层能不能从 HTTP 响应里读出这三个字段；
       ② 字段缺失时是否记成「接口未提供」（null / has_*=false）而**不是 0**；
       ③ 口径 K3≤K2≤K1≤总 的自检会不会在写盘前拦住坏口径。

   ★ 与验收脚本共用**同一套归因代码**（下面 EXTRACT_FN 就是从
     offline-f2-effect-acceptance.js 里逐字取的那段），
     不是重写一份「看起来对」的实现 ——
     否则测的是这份脚本自己，不是真跑时用的那份。

   ⚠️ 本脚本**不联网、不启动浏览器、不需要任何环境变量**。
     跑法：node scripts/offline-f2-effect-fields-test.js
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var ACC = path.join(ROOT, 'scripts', 'offline-f2-effect-acceptance.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; process.stdout.write('  ✓ ' + name + '\n'); }
  else { fail++; process.stdout.write('  ✗ ' + name + (extra ? ' → ' + extra : '') + '\n'); }
}
function section(t) { process.stdout.write('\n' + t + '\n'); }

/* ============================================================
   归因提取逻辑 —— **必须与验收脚本里那段逐字一致**
   （下面会在「源码一致性」一节里断言两边字面相同）
   ============================================================ */
var EXTRACT_SRC = [
  /* ⚠️ 用 win.Date.now 而不是 Date.now ——
     这段代码真实跑在 page.evaluate 里，页内没有宿主 Date。
     桩函数（makeExtract）注入一个 win 形参模拟，两侧字面才能一致。 */
  "var rec = { url: url, ms: win.Date.now() - t0, status: r.status };",  "try {",
  "  var d = JSON.parse(txt);",
  "  var ch = d.choices && d.choices[0];",
  "  var msg = ch && ch.message;",
  "  rec.finish_reason = ch ? (ch.finish_reason === undefined ? null : ch.finish_reason) : null;",
  "  rec.usage = d.usage || null;",
  "  rec.has_reasoning = !!(msg &&",
  "    Object.prototype.hasOwnProperty.call(msg, 'reasoning_content'));",
  "  rec.reasoning_len = (msg && typeof msg.reasoning_content === 'string')",
  "    ? msg.reasoning_content.length : null;",
  "  rec.content_len = (msg && typeof msg.content === 'string')",
  "    ? msg.content.length : null;",
  "  rec.topKeys = Object.keys(d);",
  "  rec.choiceKeys = ch ? Object.keys(ch) : null;",
  "  rec.msgKeys = msg ? Object.keys(msg) : null;",
  "} catch (e) {",
  /* ⚠️ 这里比旧版多一步「错误文本脱敏」：
     `parseError` 会带上原始串片段，那里也可能含凭据
     （用户 2026-10-05 点名要覆盖错误文本）。
     所以这行是 `rec.parseError = pe.text;`（pe 来自 scrubError），
     不是直接 String(e.message) —— 桩跟着对齐。 */
  "  rec.parseError = pe.text;",
  "}"
].join('\n');

/* 把上面那段源码变成可执行函数（只提供它需要的入参）
   ★ 必须提供 win —— 段内用 win.Date.now（页内无宿主 Date）。
   ★ 也必须提供 pe —— 段内 rec.parseError = pe.text，
     pe 是执行体里 scrubError(...) 的产物（错误文本要过脱敏）。
     这里给一个恒等映射，让桩的行为等价于「原文照抄」；
     脱敏本身的正确性由 offline-f2-sendbody-test.js 的 §6b 负责。 */
function makeExtract() {
  /* eslint-disable no-new-func */
  var fn = new Function('win', 'pe', 'url', 't0', 'r', 'txt',
    EXTRACT_SRC + '\nreturn rec;');
  var win = { Date: Date };
  var pe = { text: '' };
  return function (url, status, bodyText) {
    pe.text = '';
    var out = fn(win, pe, url, 0, { status: status }, bodyText);
    return out;
  };
}
var extract = makeExtract();

/* ============================================================
   桩响应：三种真实可能的中转结构
   ============================================================ */

/* 桩 A：字段齐全（thinking 开启，content 被推理吃满 → 预算截断形态） */
var STUB_FULL = JSON.stringify({
  id: 'cmb-localstub', object: 'chat.completion', created: 1791096549,
  model: 'glm-5.2',
  choices: [{
    index: 0, finish_reason: 'length',
    message: { role: 'assistant', content: '', reasoning_content: 'x'.repeat(8180) }
  }],
  usage: { prompt_tokens: 2007, completion_tokens: 8192, total_tokens: 10199,
    prompt_tokens_details: { cached_tokens: 1280 } }
});

/* 桩 B：真实中转常见形态 —— 无 reasoning_content（该模型不推理 / 网关剥掉了） */
var STUB_NO_REASONING = JSON.stringify({
  id: 'cmb-localstub2', object: 'chat.completion', model: 'glm-5.2',
  choices: [{
    index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: '{"paras":[{"type":"prose","text":"沈砚看了你一眼。"}]}' }
  }],
  usage: { prompt_tokens: 2007, completion_tokens: 244, total_tokens: 2251 }
});

/* 桩 C：**另一种结构** —— finish_reason 在顶层、usage 用 camelCase、推理字段换名。
   这一条专门用来证「换结构也能抓到 / 抓不到时如实报缺失」。 */
var STUB_ALT = JSON.stringify({
  id: 'cmb-localstub3',
  finish_reason: 'length',
  output: { choices: [{ text: '沈砚嗯了一声。', reasoning: 'y'.repeat(400) }] },
  usageV2: { inputTokens: 1900, outputTokens: 8192 }
});

/* ============================================================
   §1 桩 A：字段齐全
   ============================================================ */
section('§1 桩 A · 字段齐全（finish_reason=length, content 空, reasoning 8180 字）');
var a = extract('http://local/chat/completions', 200, STUB_FULL);
ok(a.finish_reason === 'length', 'finish_reason 抓到 length', String(a.finish_reason));
ok(a.usage && a.usage.completion_tokens === 8192, 'usage.completion_tokens = 8192',
  JSON.stringify(a.usage));
ok(a.usage && a.usage.prompt_tokens === 2007, 'usage.prompt_tokens = 2007');
ok(a.has_reasoning === true, 'has_reasoning = true');
ok(a.reasoning_len === 8180, 'reasoning_len = 8180', String(a.reasoning_len));
ok(a.content_len === 0, 'content_len = 0（空内容，预算截断形态）', String(a.content_len));
ok(Array.isArray(a.topKeys) && a.topKeys.indexOf('usage') >= 0, 'topKeys 含 usage');

/* 归因结论：这轮是「HTTP 200 + finish_reason=length + content 空 + reasoning 有内容」
   → 判定为**推理吃满输出预算**，而不是「客户端没申请到」也不是「假截断」。 */
var isBudgetTrunc = (a.status === 200 && a.finish_reason === 'length' &&
  a.content_len === 0 && a.reasoning_len > 0);
ok(isBudgetTrunc, '★ 可判定为「推理吃满预算」（归因链闭合）');

/* ============================================================
   §2 桩 B：无 reasoning_content —— 必须记「未提供」而不是 0
   ============================================================ */
section('§2 桩 B · 无 reasoning_content（字段缺失 → 必须 null/false，不是 0）');
var b = extract('http://local/chat/completions', 200, STUB_NO_REASONING);
ok(b.finish_reason === 'stop', 'finish_reason 抓到 stop');
ok(b.usage && b.usage.completion_tokens === 244, 'usage 正常抓到');
ok(b.has_reasoning === false, 'has_reasoning = false（接口未提供）');
ok(b.reasoning_len === null, '★ reasoning_len = null（不是 0、不是 undefined）',
  String(b.reasoning_len));
ok(b.reasoning_len !== 0, '★ 断言：reasoning_len 绝不为 0（0 会被误读成「推理了 0 字」）');
ok(b.content_len > 0, 'content_len > 0');
ok(b.msgKeys && b.msgKeys.indexOf('reasoning_content') < 0,
  'msgKeys 里确实没有 reasoning_content（阳性对照：真缺，不是没读到）');

/* ============================================================
   §3 桩 C：换一种结构 —— 如实报缺失，不许瞎猜
   ============================================================ */
section('§3 桩 C · 另一种结构（finish_reason 在顶层 / usage camelCase / 推理换名）');
var c = extract('http://local/chat/completions', 200, STUB_ALT);
ok(c.finish_reason === null, '顶层 finish_reason 不被误认成 choices 里的（=null）',
  String(c.finish_reason));
ok(c.usage === null, 'usageV2 不被误认成 usage（=null）', String(c.usage));
ok(c.has_reasoning === false, 'output[0].reasoning 不被误认成 reasoning_content（=false）');
ok(Array.isArray(c.topKeys) && c.topKeys.indexOf('usageV2') >= 0,
  '★ topKeys 如实保留真实键名 usageV2 —— 人工可据此发现结构差异');
ok(Array.isArray(c.topKeys) && c.topKeys.indexOf('output') >= 0,
  'topKeys 含 output（choices 不在顶层这件事被记录下来）');

/* ============================================================
   §4 口径自检：K3 ≤ K2 ≤ K1 ≤ 总，违反必须在写盘前抛
   ============================================================ */
section('§4 口径自检 · 包含关系与坏口径拦截');
function counts(k1, k2, k3, total) {
  return { K1_有返回: k1, K2_有内容: k2, K3_可评: k3, 总请求数: total };
}
function chainOk(o) {
  return o.K3_可评 <= o.K2_有内容 && o.K2_有内容 <= o.K1_有返回 && o.K1_有返回 <= o.总请求数;
}
/* 正向：预算截断轮 → K1 有返回（HTTP 200）但 K2 无内容 → K3 不可评 */
var trunc = counts(1, 0, 0, 1);
ok(chainOk(trunc), '截断轮 K1=1,K2=0,K3=0 满足包含关系');
/* 正向：全部正常 */
var good = counts(4, 4, 4, 4);
ok(chainOk(good), '全成功 K1=K2=K3=4 满足包含关系');
/* 正向：非空但解析失败 → K1=1,K2=1,K3=0（三者**不必**相等） */
var parseFail = counts(1, 1, 0, 1);
ok(chainOk(parseFail) && !(parseFail.K2_有内容 === parseFail.K3_可评),
  '★ 非空但解析失败 K1=1,K2=1,K3=0 合法（旧口径会把它判成矛盾）');
/* 负向：K2 > K1 应被拦 */
var bad1 = counts(0, 3, 0, 3);
ok(!chainOk(bad1), '负向：K2>K1 被判违规（应当拦住）');
/* 负向：K3 > K2 应被拦 */
var bad2 = counts(3, 1, 2, 3);
ok(!chainOk(bad2), '负向：K3>K2 被判违规');

/* ============================================================
   §5 与生产实现的**源码一致性** —— 防止两份实现漂移
   ============================================================
   ⚠️ 2026-10-05：归因代码从验收脚本**搬进了** scripts/lib/f2-body-capture.js
     （为了让「发送瞬间请求体采集」与「响应侧采集」共用一份实现）。
     所以比对对象必须改成「**真正跑的那份源码**」。
     ⚠️ 若仍拿验收脚本比对，断言会因代码搬走而恒红，
       而那条红**不代表**归因逻辑坏了 —— 这是「断言报红先怀疑判据」的一条新实例。
     ★ 判据不是「放宽到任意文件都算」——
       而是「对准实际执行体」+「额外断言验收脚本确实调了它」。
   ============================================================ */
section('§5 源码一致性 · 归因代码必须与生产实现逐字相同');
var LIB_CAP = path.join(path.dirname(ACC), 'lib', 'f2-body-capture.js');
var accSrc = fs.readFileSync(ACC, 'utf8');
/* ★ 真正执行归因逻辑的那份源码（旁路模块） */
var execSrc = fs.readFileSync(LIB_CAP, 'utf8');
/* ⚠️ 比对方式：**逐行**去首尾空白后比对。
   坑（本次真踩到）：一开始用「整段归一化成一行再 indexOf」，
   结果桩里 2 空格缩进、被测 4 空格缩进 → 空白折叠后空格位置仍不同 → 恒 false。
   这正是「负向/一致性断言报红 → 先怀疑自己的比对方式，别急着改被测代码」。
   ★ 正确做法：两侧都**逐行 trim** 后逐行等值比对（语义一致 = 同一段代码）。 */
var accLines = accSrc.replace(/\r\n/g, '\n').split('\n').map(function (l) { return l.trim(); });
var execLines = execSrc.replace(/\r\n/g, '\n').split('\n').map(function (l) { return l.trim(); });
var EX_LINES = EXTRACT_SRC.split('\n').map(function (l) { return l.trim(); });
/* ⚠️ 首行用的是 win.Date.now 而不是 Date.now ——
   页内 evaluate 里没有宿主 Date，必须走 window.Date。
   这里跟着生产实现走，别为了「和旧期望一样」把实现改回去。 */
ok(EX_LINES[0] === 'var rec = { url: url, ms: win.Date.now() - t0, status: r.status };',
  '首行写法与生产实现一致（win.Date.now：页内无宿主 Date）', EX_LINES[0]);
/* 逐行在**执行体**中命中（每行独立查，避免整段拼接的空白差异） */
var missLines = [];
EX_LINES.forEach(function (ln, i) {
  if (execLines.indexOf(ln) < 0) missLines.push((i + 1) + ': ' + ln.slice(0, 40));
});
ok(missLines.length === 0,
  '★ EXTRACT_SRC 全部 ' + EX_LINES.length + ' 行都在执行体（f2-body-capture.js）中原样存在',
  missLines.join(' | '));
/* 关键片段单独再断言一次（这几行是归因能力的核心，漂移了要立刻发现） */
[
  "rec.finish_reason = ch ? (ch.finish_reason === undefined ? null : ch.finish_reason) : null;",
  "rec.usage = d.usage || null;",
  "rec.has_reasoning = !!(msg &&",
  "Object.prototype.hasOwnProperty.call(msg, 'reasoning_content'));",
  "rec.reasoning_len = (msg && typeof msg.reasoning_content === 'string')",
  "rec.content_len = (msg && typeof msg.content === 'string')",
  "rec.topKeys = Object.keys(d);",
  "rec.msgKeys = msg ? Object.keys(msg) : null;",
  "} catch (e) {",
  /* ⚠️ 这行 2026-10-05 变成 rec.parseError = pe.text ——
     错误文本先过 scrubError（pe）再落，防止原始片段里的凭据进落盘。 */
  "rec.parseError = pe.text;",
  "}"
].forEach(function (frag, i) {
  ok(execLines.indexOf(frag) >= 0, '核心片段 ' + (i + 1) + ' 逐字命中', frag.slice(0, 46));
});
/* ★ 响应副本的读法：现在多了一层 clone() 抛错的兜底，
   但「读副本、不动生产 body」这条**不能丢** —— 那是我们能同时
   拿到响应元数据又不消费掉生产响应体的唯一办法。
   ⚠️ 判据从 `/r\.clone\(\)\.text\(\)/` 改成两条更准的：
     实现现在是 `cloned = r.clone()` + `return cloned.text()`，
     旧的单条正则已匹配不到（那条红是**判据过时**，不是能力没了）。 */
ok(/cloned\s*=\s*r\.clone\(\)/.test(execSrc),
  '★ 读的是 r.clone() 的副本（不消费生产拿到的响应体）');
ok(/return cloned\.text\(\)/.test(execSrc),
  '★ 副本走 .text() 读取');
/* 反向：确认没有退回「直接读生产响应体」——那会把 body 消费掉。 */
ok(!/return r\.text\(\)/.test(execSrc),
  '★ 没有直接读生产响应体（那会让 page-offline 拿不到 content）');
/* ★ 补上「验收脚本确实用了这份实现」——
   否则「库里有一份对的代码、验收脚本压根没调它」也能全绿。 */
ok(/F2BodyCapture\.installFetchBypass/.test(accSrc),
  '★ 验收脚本确实调用了旁路模块的 installFetchBypass（不是各写一份）');
ok(/f2-body-capture\.js/.test(accSrc),
  '★ 验收脚本读的是同一个模块文件（不是重抄一份实现）');
/* 阳性对照：故意找一个**不存在**的片段，必须报 false ——
   否则「什么都 match」也能全绿，这条断言就没有判别力。 */
ok(execLines.indexOf('rec.__绝对不存在的字段 = 1;') < 0,
  '阳性对照：不存在片段确实查不到（判据对「探针失效」敏感）');
/* ★ 阳性对照 2：对**执行体**的判据也要有判别力 ——
   拿一段只存在于验收脚本、库里没有的代码去查，必须查不到。 */
ok(execLines.indexOf('window.__RAW = [];') < 0,
  '阳性对照2：只存在于验收脚本的行在执行体里确实查不到');

/* ============================================================
   §5b 装配指纹判据 —— **必须拼全部 system 段**（P0 补齐项）
   ============================================================ */
section('§5b 装配指纹 · system 段拼接方式（这里真犯过一个错）');
ok(/filter\(function \(m\) \{ return m && m\.role === 'system'; \}\)/
    .test(accSrc.replace(/\r\n/g, '\n')),
  '★ 验收脚本按 role===\'system\' **filter**（不是取 messages[0]）');
ok(!/for \(var i = 0; i < msgs\.length; i\+\+\) \{[\s\S]{0,120}role === 'system'\) \{ sys = String\(msgs\[i\]/
    .test(accSrc),
  '★ 确认已弃用「只取第一条 system」的写法');
ok(/system段数 = parts\.length/.test(accSrc),
  '落盘记录 system段数（便于事后核对是不是拼全了）');
/* 判据本身的判别力：单段 vs 多段拼接，命中数完全不同 —— */
var oneSeg = '[CHARACTER]\n说话与行为方式：句子短。\n[/CHARACTER]';
var manySeg = oneSeg + '\n' + 'B正文占位' + '\n' + 'P正文占位';
ok(manySeg.split('B正文占位').length - 1 === 1,
  '拼接后单段命中 1 次');
ok(oneSeg.split('B正文占位').length - 1 === 0,
  '★ 只取单段则命中 0 次 —— 这正是那个 bug 的形态（阴性对照）');

/* ============================================================
   §6 关键护栏：字段缺失绝不被写成 0
   ============================================================ */
section('§6 护栏 · 「未提供」与「值为 0」必须可区分');
ok(a.reasoning_len === 8180 && b.reasoning_len === null && c.reasoning_len === null,
  '有推理→长度数字；无推理/异构→null（三态可区分）');
ok(JSON.stringify(b.reasoning_len) === 'null',
  '★ 落盘后是 JSON null，**不是 0、不是空串、不是 undefined**');
ok(typeof b.reasoning_len !== 'string' && typeof b.reasoning_len !== 'undefined',
  '类型既不是 string 也不是 undefined');

/* ============================================================
   §7 计数器声明一致性（v3 新增）
   ============================================================ */
section('§7 计数器 · 声明与自增必须配对（防 undefined++ → NaN）');
var acc2 = accSrc;
/* 取口径对象的声明块与自增块 */
var declMatch = acc2.match(/var 口径 = \{[\s\S]*?\n  \};/);
ok(!!declMatch, '找到口径声明块');
if (declMatch) {
  var decl = declMatch[0];
  var incs = acc2.match(/口径\.[A-Za-z_一-龥]+\+\+/g) || [];
  var undeclared = [];
  incs.forEach(function (m) {
    var key = m.replace('口径.', '').replace('++', '');
    if (decl.indexOf(key) < 0) undeclared.push(key);
  });
  ok(undeclared.length === 0,
    '★ 所有 ++ 的计数器都在口径对象里声明过（否则 undefined++ = NaN）',
    undeclared.join(','));
  /* v2 遗留的三个旧别名必须已删 —— 它们是「同一个布尔量」的根源 */
  ['解析成功数', '可用角色回复数', '请求成功数', '非空内容数'].forEach(function (k) {
    ok(acc2.indexOf(k) < 0, '旧别名「' + k + '」已彻底移除（不再有恒等计数器）');
  });
}
/* 错误等式必须已删：K1-K3 = 解析失败+空内容+超时+网络失败
   这个判据连着修错了两次，都是剥除规则不完整：
     1) 只剥注释，误伤注释里对这条错误等式的引用（注释写着「v2 写的是错的」）；
     2) 剥注释加剥字符串，仍误伤块注释中段 ——
        块注释里以中文正文开头的行不以星号开头，行首锚定规则匹配不到。
   正确做法：先把整块注释区段整体抹掉（按注释起止标记配对），
   再剥字符串字面量，最后搜。
   注：本段刻意不写注释起止标记的字面量，避免提前闭合自身。 */
var noBlock = acc2.replace(/\/\*[\s\S]*?\*\//g, function (s) {
  /* 保留行数结构，让行号不错位 */
  return s.replace(/[^\n]/g, ' ');
});
var codeOnly2 = noBlock.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
ok(!/K1\s*-\s*K3\s*=/.test(codeOnly2) && !/K1_有返回\s*-\s*K3_可评\s*=/.test(codeOnly2),
  '★ 错误等式「K1-K3=…」在**可执行代码**里已删除（块注释/字符串均已剥除）');
ok(/K1\s*-\s*K3\s*=/.test(acc2),
  '阳性对照：注释里确实还引用着这条等式 → 说明上面那条不是空转');
ok(/K1-K3 对账/.test(acc2),
  '阳性对照2：代码字符串里那句提示语存在 → 证明确实需要剥字符串才能判对');
ok(/\/\*[\s\S]*?\*\//.test(acc2) && /\/\*[\s\S]*?\*\//.test(noBlock) === false,
  '阳性对照3：块注释确实被整体抹除（抹除规则本身有效）');
ok(/失败分类.*不相加|不相加、不对账|不做对账/.test(acc2),
  '失败分类被声明为独立维度（不相加、不对账）');
/* 逐请求汇总必须存在，且缺失字段记 null */
ok(/meta\.逐请求 = \[\]/.test(acc2), '落盘含「逐请求」汇总');
ok(/finish_reason === undefined \? null/.test(acc2),
  '★ finish_reason 缺失记 null');
ok(/推理长度: h\.reasoning_len === undefined \? null : h\.reasoning_len/.test(acc2),
  '★ 推理长度缺失记 null（不推定为 0）');
/* 停机与未跑登记 */
ok(/meta\.未跑项/.test(acc2), '落盘含「未跑项」登记');
ok(/meta\.实际HTTP请求数/.test(acc2), '落盘含「实际HTTP请求数」（区别于函数调用数）');
ok(/meta_stop/.test(acc2), '有停机机制（不凑满次数）');
/* 出站原文 + SHA-256（校验和不能替代原文） */
ok(/出站messages/.test(acc2) && /SHA256: sha256hex\(obText\)/.test(acc2),
  '★ 出站 messages 原文与 SHA-256 一起落盘');
ok(/LEAK_GUARD/.test(acc2), '有凭据泄露哨兵（发现真实资料混入即停）');
ok(/PARAM_CHECK/.test(acc2), '有发出前参数核对（防环境变量覆盖默认值）');

/* ============================================================
   §8 页内/Node 作用域分离（P1 首次执行时的真崩点）
   ============================================================ */
section('§8 页内函数不得引用 Node 侧作用域（P1 首发即崩过一次）');
var stripComment = function (s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\*+.*$/gm, ' ');
};
['FINGERPRINT', 'OUTBOUND', 'LEAK_GUARD', 'PARAM_CHECK', 'SETUP', 'SEND']
  .forEach(function (fnName) {
    var m = acc2.match(new RegExp('var ' + fnName + ' = function[\\s\\S]*?\\n\\};'));
    if (!m) { ok(false, '找到页内函数 ' + fnName); return; }
    var code = stripComment(m[0]);
    /* 页内不可用的 Node 侧符号：checksum / sha256hex / require */
    ok(code.indexOf('checksum(') < 0, fnName + ' 内不调用 Node 侧 checksum(');
    ok(code.indexOf('sha256hex(') < 0, fnName + ' 内不调用 Node 侧 sha256hex(');
    ok(!/\brequire\s*\(/.test(code), fnName + ' 内不调用 require（浏览器里没有）');
  });
/* FINGERPRINT 必须把原文回传（页内算不了指纹，要交给 Node 侧） */
var fpm = acc2.match(/var FINGERPRINT = function[\s\S]*?\n\};/);
ok(!!fpm && /_原文/.test(fpm[0]),
  'FINGERPRINT 把 system 原文回传（页内算不了指纹）');
ok(/async function fingerprintOf/.test(acc2),
  '有 Node 侧 fingerprintOf 负责补算校验和');
ok(/if \(meta\.装配指纹\) delete meta\.装配指纹\._原文/.test(acc2),
  '★ 落盘前删掉 _原文（体积大且与逐轮出站原文重复）');
/* 阳性对照：Node 侧符号确实存在，确保上面几条不是空转 */
ok(/function checksum\(s\)/.test(acc2), '阳性对照：Node 侧 checksum 确实存在');

/* ============================================================
   §9 批准参数单一出处（P1 首发时崩过两次：漏传参 / 参数散落多处）
   ============================================================ */
section('§9 批准参数单一出处 · 页内函数必须带参调用');
ok(/var APPROVED = \{[\s\S]*?\};/.test(acc2), '存在 APPROVED 常量块（批准参数唯一出处）');
/* 页内注入必须全读 __APPROVED，不许再有硬编码数字 */
var injectM = acc2.match(/Sleepy\.store\.set\('mainApi'[\s\S]*?\}\);/);
ok(!!injectM, '找到 mainApi 注入块');
if (injectM) {
  var inj = injectM[0];
  ok(!/temperature:\s*0\.85/.test(inj), '注入块不再硬编码 temperature');
  ok(!/maxTokens:\s*\d/.test(inj), '注入块不再硬编码 maxTokens');
  ok(!/contextMessages:\s*\d/.test(inj), '注入块不再硬编码 contextMessages');
  ok(!/stream:\s*(false|true)/.test(inj), '注入块不再硬编码 stream');
  ok(!/timeoutSec:\s*\d/.test(inj), '注入块不再硬编码 timeoutSec');
  ok(/__APPROVED\.temperature/.test(inj) && /__APPROVED\.maxTokens/.test(inj) &&
     /__APPROVED\.contextMessages/.test(inj) && /__APPROVED\.stream/.test(inj) &&
     /__APPROVED\.timeoutSec/.test(inj),
    '★ 注入块五个参数全部读 __APPROVED');
}
/* PARAM_CHECK 必须带参调用（不传 → 页内读 want.temperature 抛错） */
ok(/page\.evaluate\(PARAM_CHECK,\s*\{/.test(acc2),
  '★ PARAM_CHECK 带参调用（曾因漏传参在首轮发出前崩）');
ok(/page\.evaluate\(PARAM_CHECK\)/.test(acc2) === false,
  '确认没有裸调用 PARAM_CHECK 的写法');
/* 元信息里的参数也必须读 APPROVED，不能另写一份 */
ok(/温度: APPROVED\.temperature/.test(acc2) &&
   /maxTokens: APPROVED\.maxTokens/.test(acc2) &&
   /contextMessages: APPROVED\.contextMessages/.test(acc2),
  '元信息参数同样读 APPROVED（不另写一份）');

/* ============================================================
   §10 停机不得丢已取证轮次（P1 首次执行的真 bug）
   ============================================================ */
section('§10 停机时已跑轮次必须保留（P1 曾丢过 3 轮）');
/* ★ 这两条断言在「共用调度器」落地后**已过时**（不再是「两处 push 谁先谁后」的问题）。
   正确的不变量现在是：
     ① 组登记由 `runGroupSchedule` 内部的 `registerGroup` 幂等保证；
     ② 正式流程里**只有一处** `results.push`。
   保留旧断言会 falsely 报红 —— 它检查的写法已经不存在了。 */
var pushCount = (acc2.match(/results\.push\(/g) || []).length;
ok(pushCount === 1,
  '★ 正式流程里只有一处 results.push（重复登记已从结构上消除）', '实际 ' + pushCount + ' 处');
ok(/function registerGroup\(meta\)/.test(acc2) && /if \(state\.组已登记\) return false;/.test(acc2),
  '★ 组登记由 registerGroup 幂等保证（第二次调用无效）');
ok(/runGroupSchedule: runGroupSchedule,/.test(acc2),
  '调度器已导出（测试可直接复用同一实现）');
/* 实际HTTP请求数必须按有原始结果的轮次统计（不能再报 0） */
ok(/确认发送数/.test(acc2) && /未知状态数/.test(acc2) && /未发出数/.test(acc2),
  '★ 三个请求计数分列（确认/未知/未发出），不混用一个数');
ok(/整组未开/.test(acc2) && /组内未跑/.test(acc2),
  '未跑项区分「组内未跑」与「整组未开」');

section('§11 硬停止与依赖拦截的职责边界（本轮修掉的顺序 bug）');
/* 超时/网络**不属于**硬停止 —— 否则当轮就 return，依赖检查没机会跑 */
var hsk = acc2.match(/function hardStopKind\(t, opts\) \{[\s\S]*?\n\}/);
ok(!!hsk, '定位到 hardStopKind');
if (hsk) {
  var h = hsk[0];
  ok(/raw\.stage === 'network'/.test(h) && /raw\.stage === 'timeout'/.test(h),
    '★ 网络/超时**恢复**为硬停止（用户 2026-10-04 明确：继续停止整跑）');
  ok(/t\.未发出/.test(h),
    '「未发出」不算硬停止（它根本没到网络）');
  ok(/raw\.status === 403/.test(h), '403 仍是硬停止');
  ok(/requestId === undefined/.test(h), '采集关联异常仍是硬停止');
}
/* 阳性对照：确实还能判出硬停止（不是全都 return null） */
ok(/return 'perm'/.test(acc2) && /return 'link'/.test(acc2),
  '阳性对照：perm/link 两个硬停止码仍存在');
/* ---- 持久化次数契约：**n 轮 → n+1 次写入**（末尾多一次终态）----
   ⚠️⚠️ 这一段 2026-10-05 重写。原断言是：
       ok(!/registerGroup\(...\);\s*\n\s*await persist\(state\);/.test(acc2),
          '正常跑完时不再多调一次 persist（n 轮 → n 次写入）');
   两个毛病：
     ① **标题过时且与实现相反** —— 写的是「n 轮 → n 次写入」，
        而契约（用户 2026-10-04 明确）是 **n+1**：末尾必须多写一次终态。
        上一轮把「n 轮只能写 n 次」当通过条件，**正是末轮失败被漏掉的原因**。
     ② **断言本身过时且无判别力** —— 它断言「不存在某个旧形状」，
        而当前实现压根不是那个形状。实测：把末尾的
        `await persistPhase("终态")` **整行删掉**（模拟回归），
        这条断言**照样通过** —— 它守的不是「终态必须被保存」这个契约。
   → 改为**断言「存在」**：正常跑完分支必须写终态。
     缺失即红，这才与契约对齐。 */
var doneBranch = acc2.match(
  /registerGroup\(\{ 组: spec\.id, 正常跑完: true \}\);[\s\S]{0,200}?return state;/);
ok(!!doneBranch, '定位到「正常跑完」分支');
if (doneBranch) {
  ok(/await persistPhase\("终态"\)/.test(doneBranch[0]),
    '★ 正常跑完分支**必须**写一次终态（契约：n 轮 → n+1 次写入）');
  ok(/state\.终态\s*=\s*"正常跑完"/.test(doneBranch[0]),
    '★ 终态字段在落盘**之前**被赋值（先算终态再写盘）');
}
/* 阴性对照：把上面那条判据的锚点抽出来，验证它**抓得到**回归。 */
ok(!/registerGroup\(\{ 组: spec\.id, 正常跑完: true \}\);[\s\S]{0,200}?await persistPhase\("终态"\)/.test(
    acc2.replace(/await persistPhase\("终态"\);\s*return state;\s*\}\)\(\);/, 'return state; })();')),
  '阳性对照：抽掉末尾那次终态落盘后，上述判据确实会判红（不是恒真）');
/* 唯一写入口：persistPhase 是唯一出口，循环里不得有裸 persist(state) */
var loopSeg = acc2.slice(acc2.indexOf('function runGroupSchedule'),
  acc2.indexOf('function makeSnapshotWriter'));
ok(/await persist\(state, phase\)/.test(loopSeg) &&
  (loopSeg.match(/await persist\(state\)/g) || []).length === 0,
  'persistPhase 是唯一写入口（无裸 await persist(state) 绕过计数）');
/* 每轮都要落盘 */
ok(/makeSnapshotWriter/.test(acc2) && /fs\.fsyncSync/.test(acc2),
  '逐轮快照写入器存在且 fsync（返回成功=确已落盘）');

process.stdout.write('\n────────\n');
process.stdout.write('通过 ' + pass + ' / 失败 ' + fail + '\n');
process.stdout.write(fail === 0
  ? '✅ P0 归因字段自检全绿：**字段路径可用，缺失如实记 null。**\n'
  : '❌ 有红项：**先修脚本，不发付费请求。**\n');
process.exit(fail === 0 ? 0 : 1);
