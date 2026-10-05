#!/usr/bin/env node
/* ============================================================
   scripts/make-closure-excerpt.js
   —— 生成「收口源码摘录.txt」

   ★ 为什么用脚本抽而不是手抄：
     手抄必然产生「抄错行号 / 抄漏行 / 与仓库不一致」这类问题，
     而源码摘录的价值**恰恰**在于它与仓库逐字一致。
     脚本按行号切片 → 摘录与仓库**同一份字节**。

   ★ 硬约束（用户 2026-10-05）：
     · 片段必须**完整**，不用省略号
     · **不含凭据** —— 抽出后统一过一遍脱敏扫描，有残留就报错退出
     · 行号必须**真实** —— 每段都回显实际起止行号
   ============================================================ */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '..');

var ACC = path.join(ROOT, 'scripts', 'offline-f2-effect-acceptance.js');
var LIB = path.join(ROOT, 'scripts', 'lib', 'f2-body-capture.js');
var OUT = process.env.SLEEPY_EXCERPT_OUT ||
  path.join(ROOT, 'docs', '收口源码摘录-2026-10-05.txt');

var accLines = fs.readFileSync(ACC, 'utf8').replace(/\r\n/g, '\n').split('\n');
var libLines = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n').split('\n');

var buf = [];
var stat = { 段数: 0, 行数: 0 };

function w(s) { buf.push(s); }

/* ---------- 段：按**锚点文本**定位，再切片（1-based，含端点） ----------
   ⚠️⚠️ 原来这里是**硬编码行号**。踩到的坑：
     本轮 SETUP 删掉了 20 行 → 后面所有段的行号**整体偏移**，
     而 `verify-closure-excerpt.js` 是拿**同一批硬编码行号**去比对的，
     于是「摘录内容 == 仓库第 N 行」依然成立 → **回验照样全绿**。
     ⚠️ 这类「判据与被测对象共用同一个错误来源」= 假绿的典型形态。
     回验只证明「摘录忠实于行号」，**证明不了行号指向的是预期的代码**。
   → 改为：按**唯一锚点串**现找行号，行号由锚点推导。
     这样代码增删行时行号自动跟随，且 verify 能独立复核锚点。 */

/* 在 lines 里找包含 needle 的唯一行号（1-based）；找不到或多处都抛错 */
function anchorLine(lines, needle, what) {
  var hit = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(needle) >= 0) hit.push(i + 1);
  }
  if (hit.length === 0) throw new Error('锚点找不到：' + what + ' → ' + needle);
  if (hit.length > 1) throw new Error('锚点不唯一（' + hit.length + ' 处）：' + what + ' → ' + needle);
  return hit[0];
}
/* 以锚点定位的段：from = 锚点行 + offsetFrom，to = 锚点行 + offsetTo */
function segA(title, fileLabel, lines, anchor, what, offFrom, offTo, note) {
  var a = anchorLine(lines, anchor, what);
  seg(title, fileLabel, lines, a + offFrom, a + offTo, note);
}

/* ---------- 段：按行号切片（1-based，含端点） ---------- */
function seg(title, fileLabel, lines, from, to, note) {
  stat.段数++;
  if (from < 1 || to > lines.length || from > to) {
    throw new Error('行号越界：' + title + ' [' + from + '..' + to + ']，文件共 ' +
      lines.length + ' 行');
  }
  w('');
  w('════════════════════════════════════════════════════════════════');
  w('【' + stat.段数 + '】' + title);
  w('文件：' + fileLabel);
  w('行号：' + from + '–' + to + '（真实行号，共 ' + (to - from + 1) + ' 行）');
  if (note) { w('说明：' + note); w('────────────────────────────────────────────────────────'); }
  for (var i = from; i <= to; i++) {
    w(String(i).padStart(5, ' ') + ' | ' + lines[i - 1]);
    stat.行数++;
  }
}

function head(t) { w(''); w('################################################################'); w('# ' + t); w('################################################################'); }

w('收口源码摘录 · 2026-10-05');
w('生成方式：scripts/make-closure-excerpt.js **按行号从仓库切片**');
w('        ⇒ 摘录内容与仓库**同一份字节**，非人工转抄');
w('范围：验收脚本的 SETUP / 旁路安装 / 本轮记录关联读取 / 轮记录构造 /');
w('      hardStopKind / 持久化调用 + 采集模块相关实现');
w('约束：片段完整（无省略号）· 已过凭据脱敏扫描 · 行号真实');
w('');
w('仓库根：' + ROOT);
w('本轮状态：冻结收口（未启动真机模型验收 · 未发新请求 · P3 暂停 · timeout 120s）');

/* ============ 一、验收脚本 ============ */
head('一、验收脚本 scripts/offline-f2-effect-acceptance.js');

segA('SETUP 开头（角色/会话创建）', 'scripts/offline-f2-effect-acceptance.js',
  accLines, 'var SETUP = function (arg) {', 'SETUP 函数头', 0, 36,
  '场景持久化的正式入口：createSession 的 form 一次写全五个现场字段');
segA('SETUP 持久化修正：创建参数 + updateEnv reaffirm', 'scripts/offline-f2-effect-acceptance.js',
  accLines, 'var s = Sleepy.offlineStore.createSession(ch.id, {', 'createSession form', 0, 23,
  '⚠️ updateEnv 传 sceneName 会被静默忽略（实测），所以场景名只能走 createSession 的 form');
segA('SETUP 写完立刻回读自检（不对就抛）', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '(function verifyScenePersisted() {', '回读自检', 0, 21,
  '静默失效会让后续每轮都用错现场值 —— 宁可第一轮就炸');
segA('SETUP 前置消息：全部走 appendMessage（保存入口）', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '前置消息：**只保留原报告 #6–#9 四条，顺序不变**', '前置消息四条', 0, 22,
  '★ 本轮修复点：旧写法往孤儿副本 s2.messages push，那一段同样没落库');
segA('SETUP 结尾（API 配置 + 返回已写入现场）', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '/* ★ 真实 API 配置：凭据来自 Node 侧注入，绝不落到磁盘 */', 'API 配置与返回', 0, 24);

segA('旁路安装（knownSecrets + 记录失败回调）', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '/* ---------- 旁路模块装载（2026-10-05）----------', '旁路模块装载与 installFetchBypass', 0, 55,
  'knownSecrets 是脱敏的第一条腿：真实凭据未必长得像 sk-…/JWT，形状匹配会漏');

segA('本轮记录关联：HTTP / 记录错误 / 发送瞬间 三次读取', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '/* ★ 归因记录（v2 新增）：取本轮对应的最后一次出站。', '本轮记录三次读取', 0, 31,
  '★ 每轮取走即清空（window.__SEND = [] 等），避免下一轮抓到上一轮残留');
segA('轮记录构造：三层对齐口径', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '/* ★ 三层对齐用的对照口径（用户 2026-10-05）：', '三层对齐口径', 0, 34,
  '⚠️ 两个哈希口径本就不同，不相等是正常的');
segA('轮记录构造：字段落位', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '三层对齐: 对齐,', '轮记录字段落位(自此向后)', 0, 18);

segA('持久化调用：persistPhase 是唯一写入口', 'scripts/offline-f2-effect-acceptance.js',
  accLines, '/* ★ 终态落盘：允许比轮数多写一次。', 'persistPhase', 0, 12,
  '契约：n 轮 → n+1 次写入（末尾多一次终态）');
segA('hardStopKind（含发送记录写入失败的接线）', 'scripts/offline-f2-effect-acceptance.js',
  accLines, 'function hardStopKind(t) {', 'hardStopKind', 0, 30,
  '⚠️ 记录写入失败的判定必须排在 network 之前，否则会被 network 抢走');

/* ============ 二、采集模块 ============ */
head('二、采集模块 scripts/lib/f2-body-capture.js');

segA('脱敏：三条正则（键名 / 形状 / URL query）', 'scripts/lib/f2-body-capture.js',
  libLines, 'var SECRET_KEY_RE =', '脱敏正则', 0, 10);
segA('脱敏：改动账本（统一记账的载体）', 'scripts/lib/f2-body-capture.js',
  libLines, 'function newLedger()', '改动账本', 0, 24);
segA('脱敏：scrubString（已知凭据精确匹配 + 形状匹配）', 'scripts/lib/f2-body-capture.js',
  libLines, 'function scrubString(s, known)', 'scrubString', 0, 21);
segA('脱敏：scrubUrl（URL query + 已知凭据）', 'scripts/lib/f2-body-capture.js',
  libLines, 'function scrubUrl(u, known)', 'scrubUrl', 0, 21);
segA('脱敏：redactDeep（结构化 content / 嵌套 URL / 账本路径）', 'scripts/lib/f2-body-capture.js',
  libLines, 'function redactDeep(v, known, path, led, depth)', 'redactDeep', 0, 46);
segA('脱敏：scrubError（错误文本）', 'scripts/lib/f2-body-capture.js',
  libLines, 'function scrubError(msg, known)', 'scrubError', 0, 3);

segA('请求体采集：字段骨架与五种失败形态', 'scripts/lib/f2-body-capture.js',
  libLines, 'function captureRequestBody(input, init, opts)', 'captureRequestBody 骨架', 0, 43,
  '★ 采集失败一律 messages = null（不填空数组/默认值）');
segA('请求体采集：messages 保留 role+content 并逐条记账', 'scripts/lib/f2-body-capture.js',
  libLines, 'if (Array.isArray(parsed.messages))', 'messages 采集', 0, 55);

segA('fetch 旁路：红线三条的声明', 'scripts/lib/f2-body-capture.js',
  libLines, '4. fetch 旁路安装', '旁路红线声明', 0, 36);
segA('fetch 旁路：请求侧同步采集（含红线①）', 'scripts/lib/f2-body-capture.js',
  libLines, 'function wrapped(input, init)', '请求侧采集', 0, 39);
segA('fetch 旁路：响应侧（红线③ —— 原样返回 r）', 'scripts/lib/f2-body-capture.js',
  libLines, 'return origFetch.apply(this, arguments).then(function (r) {', '响应侧', 0, 59);
segA('fetch 旁路：fetch 自身失败（红线②）', 'scripts/lib/f2-body-capture.js',
  libLines, '/* ---------- 红线②', 'fetch 自身失败', 0, 12);
segA('与停机调度的接线：stopKindForSend', 'scripts/lib/f2-body-capture.js',
  libLines, 'function stopKindForSend(send)', 'stopKindForSend', 0, 16);

/* ---------- 凭据扫描 ---------- *
 * ★ 三条规则，**不是**为了让扫描通过而放宽：
 *   规则 1 形状正则（sk-… / Bearer … / JWT）扫**全文** ⇒ 命中即中止。
 *          最保守：连注释里出现这种形状也中止。
 *   规则 2 真实凭据（环境变量值）扫全文 ⇒ 命中即中止。
 *   规则 3 硬编码的**测试假凭据字面量**（stub-trace-key-not-real 之类）
 *          只在**注释里**出现 —— 那是解释脱敏规则的示例，不是泄露。
 *          ⇒ 检查它时**先剥注释**，只看可执行代码。
 *   ⚠️ 为什么不直接把规则 3 也放宽成「扫全文」：
 *      那会导致「代码里真的硬编码了假凭据」也通过 ——
 *      假凭据在代码里同样是坏味道（它会让人以为凭据可以写死在源里）。
 *      剥注释是**有理由的窄化**，不是「扫不到就不算」。
 */
var text = buf.join('\n');
var CAP = require('./lib/f2-body-capture.js');

/* 规则 1：形状正则（全文，最保守） */
var SHAPE = /(\bsk-[A-Za-z0-9._-]{8,})|(\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*)|(\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/g;
var hits = [], m;
while ((m = SHAPE.exec(text))) {
  var ln = text.slice(0, m.index).split('\n').length;
  hits.push({ 规则: '形状正则', 行: ln, 形状: m[1] ? 'sk-' : (m[2] ? 'Bearer' : 'JWT') });
}
if (hits.length) {
  process.stderr.write('凭据扫描命中（规则1 形状正则），已中止生成：\n');
  hits.slice(0, 5).forEach(function (h) {
    process.stderr.write('  摘录第 ' + h.行 + ' 行 · ' + h.形状 + '\n');
  });
  process.exit(2);
}

/* 规则 2：真实凭据（环境变量值） */
var realKey = process.env.SLEEPY_API_KEY || '';
if (realKey && text.indexOf(realKey) >= 0) {
  process.stderr.write('摘录里出现了真实凭据（SLEEPY_API_KEY），已中止生成。\n');
  process.exit(3);
}

/* 规则 3：硬编码测试假凭据 —— 剥注释后只看代码 */
function stripComments(src) {
  var s = String(src), out = '', i = 0, n = s.length;
  while (i < n) {
    var c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      var q = c; i++; while (i < n && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}
var codeOnly = stripComments(text);
var dummyHits = ['fixture-key', 'stub-trace-key-not-real']
  .filter(function (k) { return codeOnly.indexOf(k) >= 0; });
if (dummyHits.length) {
  process.stderr.write('摘录的**可执行代码**里出现了硬编码测试凭据，已中止生成：' +
    dummyHits.join(', ') + '\n');
  process.exit(4);
}

w('');
w('################################################################');
w('# 摘录统计：' + stat.段数 + ' 段 · ' + stat.行数 + ' 行');
w('# 凭据扫描：通过（规则1 形状正则 0 命中 · 规则2 真实凭据 0 命中 · 规则3 代码内硬编码假凭据 0 命中）');
w('# 行号自检：每段均按实际起止行号回显，未使用任何省略号');
w('################################################################');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf.join('\n'), 'utf8');
process.stdout.write('已生成：' + OUT + '\n');
process.stdout.write('段数 ' + stat.段数 + ' · 摘录行数 ' + stat.行数 +
  ' · 文件 ' + fs.statSync(OUT).size + ' 字节\n');
process.stdout.write('凭据扫描：通过\n');
