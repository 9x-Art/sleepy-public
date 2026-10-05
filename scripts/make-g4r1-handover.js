#!/usr/bin/env node
/* ============================================================
   scripts/make-g4r1-handover.js
   —— 生成「回交-G4轮1-合并.txt」

   ★ 为什么落文件而不是 node -e 内联：
     内联时中文标点 + 括号 + 引号会被 shell 吃掉，
     已经栽过一次（少个右括号直接 SyntaxError）。
     判据类/生成类代码一律落文件。
   ★ 密钥**绝不写入本文件**：只出现脱敏片段。
   ============================================================ */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var D = 'docs/样本-G4轮1-2026-10-05';
var BASE = 'D:\\projects\\sleepy-baseline-2026-10-05-pre9';

var SN = fs.readdirSync(path.join(ROOT, D))
  .filter(function (n) { return n.endsWith('.json'); })[0];
var j = JSON.parse(fs.readFileSync(path.join(ROOT, D, SN), 'utf8'));
var t = j.样本[0].轮次[0];
var b = t.发送瞬间请求体;
var m = j.元信息;
var rq = m.逐请求[0];

var buf = [];
function w(s) { buf.push(s === undefined ? '' : s); }

function shaLines(list, cwd) {
  return cp.execFileSync('sha256sum', list,
    { cwd: cwd || ROOT, encoding: 'utf8' }).trim().split('\n');
}

w('G4 第 1 轮真机验收 · 合并回交（2026-10-05 13:07）');
w('='.repeat(64));

w('');
w('■ 是否真的发送了 1 次模型 HTTP 请求');
w('  ★ **是，恰好 1 次。** 页内预算闸读回：');
w('    ' + JSON.stringify(t.请求预算));
w('  样本口径「总请求数 = ' + m.口径.总请求数 + '」，与预算闸一致。');
w('  放行 URL = https://api.rua.chat/v1/chat/completions');

w('');
w('■ 是否发生重试 / 回退 / 额外后台模型调用');
w('  ★ **没有。** rejectedCount = ' + t.请求预算.rejectedCount +
  ' ⇒ 没有任何第 2 次尝试被打断，');
w('    即没有触发过重试、候选回退或后台模型调用。');
w('  另：本次以 MAX_TURNS=1 只跑 G4 第 1 轮，G7 未启动。');

w('');
w('■ 当前模型与脱敏端点');
w('  模型   : ' + m.模型);
w('  端点   : ' + m.端点 + '（回交与落盘均未出现完整密钥）');
w('  密钥   : sk-5…UW（len 51）—— **不导出、不落盘**');
w('  参数   : temperature ' + m.温度 + ' · max_tokens ' + m.maxTokens +
  ' · contextMessages ' + m.contextMessages);
w('  实际请求体里的五字段 = ' + JSON.stringify({
  model: b.model, stream: b.stream, max_tokens: b.max_tokens, temperature: b.temperature
}));

w('');
w('■ 请求体 / 原始 body 哈希 / 哈希口径');
w('  ★ 客户端真正提交的 request body（init.body 原始字符串）：');
w('    bodySHA256 = ' + b.bodySHA256);
w('    字节数     = ' + b.body字节数);
w('    采集时刻   = ' + b.采集时刻);
w('  哈希口径：' + b.bodySHA256含义);
w('  脱敏改动数 = ' + b.脱敏改动数 + '（空数组 = 未改动；apiKey 只在 headers，不在 body）');
w('  bodyCaptureError = ' + b.bodyCaptureError);

w('');
w('■ messages 原文（客户端提交的 ' + b.messages.length + ' 条）');
b.messages.forEach(function (x, i) {
  var c = String(x.content);
  w('  [' + (i + 1) + '] ' + x.role + '  len=' + c.length + '  ' +
    c.slice(0, 46).replace(/\n/g, '⏎') + (c.length > 46 ? '…' : ''));
});
w('');
w('  ★【当前场景】段（消息 #6）实际内容：');
String(b.messages[5].content).split('\n').forEach(function (l) { w('      ' + l); });

w('');
w('■ 响应与解析结果');
w('  HTTP = ' + rq.http状态 + '   finish_reason = ' + rq.finish_reason);
w('  usage = prompt ' + rq.usage_prompt_tokens + ' / completion ' +
  rq.usage_completion_tokens + ' / total ' + rq.usage_total_tokens);
w('  推理字段：服务端**已提供**（长度 ' + rq.推理长度 + '）');
w('  耗时 = ' + rq.耗时ms + ' ms   落地 = ' + rq.落地);
w('  上游 content 长度 = ' + rq.上游content长度 + '   本轮采到正文长度 = ' + rq.本轮采到正文长度);
w('  解析 = 成功，4 段（prose 139 / dialogue 5 / prose 82 / dialogue 16）');
w('  ★ 费用：**没有账单证据，不编造任何费用数字**。');

w('');
w('■ 响应原始正文');
w('  ' + String(t.原始输出).replace(/\n/g, '\n  '));

w('');
w('■ 诊断关联信息');
w('  requestId = ' + t.诊断.requestId + '   seq = ' + t.诊断.seq +
  '   stage = ' + t.诊断.stage);
w('  诊断 modules = ' + JSON.stringify(t.诊断.modules));
w('  发送停机建议 = ' + JSON.stringify(t.发送停机建议) + '（null = 无异常）');
w('  发送记录错误 = ' + JSON.stringify(t.发送记录错误) + '（空数组 = 采集无故障）');

w('');
w('■ 三层对照（固定夹具预期 / 客户端提交 body / 响应后快照）');
var FIX = {
  sceneName: '雨夜的旧书店', location: '城西旧书店二楼阁楼',
  timeOfDay: '深夜', weather: '雨', clockTime: '23:40'
};
var all = b.messages.map(function (x) { return String(x.content); }).join('\n');
Object.keys(FIX).forEach(function (k) {
  w('  ' + k.padEnd(12) + String(FIX[k]).padEnd(22) +
    (all.indexOf(FIX[k]) >= 0 ? '✓ 存在' : '✗ 缺失'));
});
w('  四条前置历史  全部在 body 里（#8~#11，顺序一致）✓');
w('  响应后快照    ' + t.出站messages.条数 + ' 条');
w('    角色序列 = ' + JSON.stringify(t.出站messages.角色序列));
w('    —— 允许包含本轮回复与探针（末尾 assistant + user:「(原文核验)」）');
w('  两个哈希口径不同（init.body 整段 JSON 串 vs role\\ncontent 拼接）⇒ 不相等是正常的：');
w('    发送瞬间 ' + t.三层对齐.发送瞬间bodySHA256);
w('    响应后   ' + t.三层对齐.响应后装配SHA256);

w('');
w('■ ★ 本次发现的一个问题（如实登记，未修）');
w('  客户端提交的 messages 里，**user 输入「我到了。」出现 2 次**（#12 与 #13，逐字相同）。');
w('  响应后快照里同样是 2 次 ⇒ 说明**发送前就已重复**，不是采集或解析造成的。');
w('  影响：模型这一轮看到了同一句输入两遍。');
w('  ⚠️ 本次预算已用完（1/1），按要求**立即停止**，因此**未补跑、未修**。');
w('  定位方向（下一轮，零网络可查）：发送路径里 user 输入既被写进会话、');
w('  又被 assemble 追加了一次。');

w('');
w('■ 证据文件位置与完整哈希');
var files = [D + '/' + SN];
fs.readdirSync(path.join(ROOT, D, '逐轮快照')).sort()
  .forEach(function (n) { files.push(D + '/逐轮快照/' + n); });
files.push('scripts/offline-f2-effect-acceptance.js', 'scripts/lib/f2-body-capture.js');
shaLines(files).forEach(function (l) { w('  ' + l); });
w('');
w('  本次基线（发送前保存，仓库外）：' + BASE);
shaLines(fs.readdirSync(BASE).map(function (n) { return path.join(BASE, n); }), null)
  .forEach(function (l) { w('  ' + l); });
w('');
w('  生产四文件（本次未改）：');
shaLines(['prompt-engine.js', 'page-offline.js', 'api.js', 'behavior-text.js'])
  .forEach(function (l) { w('  ' + l); });

w('');
w('■ 必要 diff（相对基线）');
['scripts/offline-f2-effect-acceptance.js', 'scripts/lib/f2-body-capture.js']
  .forEach(function (f) {
    w('');
    w('── ' + f + ' ──');
    var d = cp.spawnSync('git', ['diff', '--no-index', '-U2', '--',
      path.join(BASE, path.basename(f)), path.join(ROOT, f)],
      { encoding: 'utf8', maxBuffer: 1 << 28 });
    w((d.stdout || '').trim() || '（与基线逐字一致）');
  });
w('');
w('  改动仅两项验收层能力：');
w('    ① f2-body-capture：installFetchBypass 新增 **opt-in** 预算闸（默认关闭；');
w('       计数口径 = 除本地页面来源外的一切出站；超限直接 reject 且不留发送记录）；');
w('    ② acceptance：注入 budgetLimit、新增 MAX_TURNS 切轮、轮记录带回请求预算。');
w('  **未改任何生产代码 / 提示词 / 其他场景逻辑。**');

w('');
w('■ 是否因异常停止');
w('  否。请求成功（HTTP 200 / finish_reason=stop / 解析成功 4 段 / 落地 true）。');
w('  停止原因是**预算用尽**（1/1）—— 按要求即使成功也立即停止，不补跑。');

w('');
w('■ 本次验收结论与剩余边界');
w('  结论：**这一次链路与取证成立。** 具体证明了：');
w('    · 客户端提交给 fetch 的请求体可被完整采集（含原文 messages 与原始哈希）；');
w('    · 五个现场字段确实进入了发送体；四条前置历史顺序正确、无额外历史；');
w('    · 响应元数据、usage、推理字段、解析结果均可取到并与诊断关联上；');
w('    · 全局 1 次预算闸有效，重试 / 回退 / 后台调用一条没发生。');
w('  ★ **剩余边界**：');
w('    · user 输入重复 2 次的问题**未修、未补跑**（预算已尽）；');
w('    · 只跑了 1 轮，G4 后两轮与 G7 **完全未跑**；');
w('    · 本次**仅 1 次样本**，不构成任何统计结论；');
w('    · **不得**据此宣告整体文风、人物效果或 D3 通过 ——');
w('      本次只证明链路与取证机制，模型输出未做质量评估。');
w('');
w('  历史证据未改写：docs/样本-private-f2-效果/ 下 12 个文件仍为 2026-10-04 原样；');
w('  本次输出写入**新目录** docs/样本-G4轮1-2026-10-05/，未覆盖任何历史样本。');

var OUT = path.join(ROOT, 'docs', '回交-G4轮1-合并.txt');
fs.writeFileSync(OUT, buf.join('\n'), 'utf8');
process.stdout.write('已生成 ' + OUT + '：' + buf.length + ' 行 · ' +
  fs.statSync(OUT).size + ' 字节\n');

/* 自检：文件里绝不能出现完整密钥 */
var text = buf.join('\n');
var leaked = (process.env.SLEEPY_API_KEY || '').length >= 8 &&
  text.indexOf(process.env.SLEEPY_API_KEY) >= 0;
process.stdout.write(leaked ? '✗ 密钥泄漏！\n' : '✓ 密钥未出现在回交中\n');
process.exit(leaked ? 1 : 0);
