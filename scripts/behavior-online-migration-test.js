#!/usr/bin/env node
/* ============================================================
   scripts/behavior-online-migration-test.js
   —— B 批「私聊线上行为迁移」的独立迁移测试

   跑法：node scripts/behavior-online-migration-test.js

   ★ 本脚本不接生产、不调模型、不发网络请求、不读真实用户数据。
   ★ **不创建 v2 基线**、不改冻结正文、不复刻调用方尾部。
   ★ 验证范围 = 已捕获的**装配边界**；不宣称私聊端到端通过。

   ---- 与旧比较器的分工（重要）----
   旧比较器 scripts/behavior-baseline-test.js 与 v1 基线**只读保留、语义不变**。
   迁移后它会报出**预期差异**（online 系列的 shell / f1 / c05 三条 system）——
   那是它该做的事，**不伪装全绿、不改它、不动 v1 基线**。
   本脚本的职责是**解释并验证**这些差异：逐条精确比对新正文，并证明
   除这三条之外的其余 messages、历史、输入、能力说明逐字节未变。
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var H = require('./harness.js');
var CAP = require('./behavior-baseline-capture.js');

var ROOT = H.ROOT;
var V1 = CAP.BASELINE;                       /* 只读引用，绝不写 */
var V1_SHA = H.sha256(require('fs').readFileSync(V1, 'utf8'));

var pass = 0, fail = 0;
var problems = [];

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

/* ============================================================
   0. 夹具与旧正文（全部来自生产/基线，不自造）
   ============================================================ */
var ID_ONLINE = CAP.ID;
var S_ONLINE = CAP.S;

var HIST_ONLINE = [
  { role: 'user', content: S_ONLINE.histUser1 },
  { role: 'assistant', content: S_ONLINE.histChar1 },
  { role: 'user', content: S_ONLINE.histUser2 }
];
var CTX_ONLINE = {
  charId: ID_ONLINE.chMain, userId: ID_ONLINE.umSmall,
  history: HIST_ONLINE, userInput: S_ONLINE.histUser2
};

/* 起一个夹具沙箱（可选带 preset 覆盖/禁用），返回 {h, S} */
function boot(opts) {
  var h = H.boot('mig');
  CAP.buildFixture(h, opts || {});
  return h;
}

/* 直接调装配（装配边界） */
function assemble(h) {
  return h.S.promptEngine.assembleOnline(CTX_ONLINE);
}

/* 旧基线（只读）的 online 记录 */
var V1DOC = JSON.parse(fs.readFileSync(V1, 'utf8'));
var V1_ONLINE = V1DOC.captures.online;

/* 旧默认卡正文（在「不带任何 override」的沙箱里取，就是 CARD_DEFAULTS） */
var PROBE = boot({});
var OLD_SHELL = PROBE.S.promptEngine.cardBody('shell');
var OLD_F1 = PROBE.S.promptEngine.cardBody('f1');
var OLD_C05 = PROBE.S.promptEngine.cardBody('c05');
var NEW_C05 = null;   /* 由被测实现导出时取；见 §2 */

/* 旧三条 system 的**唯一识别锚**（各只在一条里出现） */
var ANCHOR_OLD = {
  shell: '[身份与场景]',
  f1: '【输入确定性】',
  c05: '【输出格式 · 硬约束】'
};
/* 新三条 system 的中段锚（用于定位，不用于判等） */
var ANCHOR_NEW = {
  shell: '以本轮提供的有效资料、明确授权和实际上下文为依据',
  f1: '当前通过消息交流',
  c05: '正文可以包含一个或多个气泡'
};

/* 基线里三条受影响 system 的**位置**（在只读基线上算一次 —— 静态可信） */
var OLD_POS = {};
OLD_POS.shell = locate(V1_ONLINE.messages, ANCHOR_OLD.shell, '基线 shell');
OLD_POS.f1 = locate(V1_ONLINE.messages, ANCHOR_OLD.f1, '基线 f1');
OLD_POS.c05 = locate(V1_ONLINE.messages, ANCHOR_OLD.c05, '基线 c05');

/* 在 messages 里按锚点定位**唯一**一条 system */
function locate(messages, anchor, what) {
  var hits = [];
  (messages || []).forEach(function (m, i) {
    if (m && m.role === 'system' && String(m.content).indexOf(anchor) >= 0) hits.push(i);
  });
  assert(hits.length === 1,
    (what || anchor) + ' 应恰好命中 1 条 system，实得 ' + hits.length +
    '（' + JSON.stringify(hits) + '）');
  return hits[0];
}
function countAnchor(messages, anchor) {
  var n = 0;
  (messages || []).forEach(function (m) {
    if (m && String(m.content).indexOf(anchor) >= 0) n++;
  });
  return n;
}

/* ============================================================
   0b. 重捕比对用的工具（第 9 节用）
   ------------------------------------------------------------
   这里的 `estimateText` 是**生产 estimate()（prompt-engine.js:61）的复刻**，
   只用来算**期望** tokens。它是否可信由自证断言保证：拿旧卡正文跑一遍，
   必须精确复现 v1 基线里 shell / f1 / c05 / pat 四槽的 tokens。
   ============================================================ */

/* 逐字段深比较 → 返回「差异路径」数组（空数组 = 逐字段相等） */
function diffPaths(a, b, p, out) {
  out = out || [];
  if (a === b) return out;
  var ta = Object.prototype.toString.call(a), tb = Object.prototype.toString.call(b);
  if (ta !== tb || (ta !== '[object Array]' && ta !== '[object Object]')) {
    out.push(p || '(root)');
    return out;
  }
  if (ta === '[object Array]') {
    if (a.length !== b.length) out.push((p || '') + ' LEN ' + a.length + '→' + b.length);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      diffPaths(a[i], b[i], (p || '') + '[' + i + ']', out);
    }
    return out;
  }
  var keys = {};
  Object.keys(a || {}).forEach(function (x) { keys[x] = 1; });
  Object.keys(b || {}).forEach(function (x) { keys[x] = 1; });
  Object.keys(keys).forEach(function (x) {
    diffPaths(a ? a[x] : undefined, b ? b[x] : undefined, (p ? p + '.' : '') + x, out);
  });
  return out;
}

/* ============================================================
   2026-10-05 K03e 批：批准的槽位插入（**写死**，不读生产）
   ------------------------------------------------------------
   本批在 ONLINE_SLOTS / OFFLINE_SLOTS 的 taimpact 之后新增 talife
   （K03e 进行中的生活）槽。v1 黄金基线文件**一字不动**（本测试全程只读），
   改为在「期望」一侧按批准的元信息**显式插入**这一个槽。
   ★ 为什么不重捕基线：当前工作区还有本批之外、未验收的场景级漂移
     （proactive / groupOnline 的既有差异），重捕会把它们一起洗进黄金文件。
   ★ 写死的元信息 = 批准值：生产改名 / 挪位 / 元信息变更 / 误注入
     （夹具岛没有任何 ta-life 记录 → 重捕里该槽必须 on:false + tokens:0）
     都会让重建期望与重捕实际对不上 → 红。
   ============================================================ */
var TALIFE_AT = { online: 16, offline: 9 };   /* v1 基线里 taimpact 的下标 */
var TALIFE_SLOT = { id: 'talife', slot: 'K03e', on: false, tokens: 0,
  hidden: false, required: false };

function withTalifeSlot(cap, kind) {
  var out = JSON.parse(JSON.stringify(cap));
  var at = TALIFE_AT[kind];
  assert(typeof at === 'number', 'K03e 批准插入位未定义：' + kind);
  assert(out.slots && out.slots[at] && out.slots[at].id === 'taimpact',
    kind + ' 基线 slots[' + at + '] 应是 taimpact（锚点漂了？）：' +
    JSON.stringify(out.slots && out.slots[at]));
  out.slots = out.slots.slice();
  out.slots.splice(at + 1, 0, JSON.parse(JSON.stringify(TALIFE_SLOT)));
  return out;
}

/* ============================================================
   2026-10-06 批：批准的槽位插入（**写死**，不读生产）
   ------------------------------------------------------------
   本批在 ONLINE_SLOTS 的 time 之后新增 realworld（真实世界感知）槽。
   只挂线上（线下场景的天气是剧情设定，page-offline 自己填）。
   元信息写死 = 批准值：夹具岛没开感知 → 生产该槽必须 on:false + tokens:0，
   生产改名/挪位/误注入都会让重建期望与重捕实际对不上 → 红。
   锚点按 id 找 time 槽（不用固定下标）—— 在 talife 插入之后数组已经
   变长，固定下标会漂。
   ============================================================ */
var REALWORLD_SLOT = { id: 'realworld', slot: 'I02b', on: false, tokens: 0,
  hidden: false, required: false };

function withRealworldSlot(cap) {
  var out = JSON.parse(JSON.stringify(cap));
  var at = -1;
  (out.slots || []).forEach(function (x, i) { if (at < 0 && x.id === 'time') at = i; });
  assert(at >= 0, 'online 基线里找不到 time 槽（锚点漂了？）');
  assert(out.slots[at + 1] && out.slots[at + 1].id === 'lang',
    'time 槽后面应是 lang（锚点漂了？）：' + JSON.stringify(out.slots[at + 1]));
  out.slots = out.slots.slice();
  out.slots.splice(at + 1, 0, JSON.parse(JSON.stringify(REALWORLD_SLOT)));
  return out;
}

/* 本批（2026-10-07）起线上期望统一走这里：K03e 的 talife + 1006 的 realworld
   + 1007 的 forum（群声能力卡，施工卡-群声-v1）。
   ------------------------------------------------------------
   2026-10-07 批：批准的槽位插入（**写死**，不读生产）——
   ONLINE_SLOTS 的 weproposal 之后新增 forum（群声，slot C04）。
   只挂线上；夹具岛没有论坛板块（没开张）→ 生产该槽必须 on:false + tokens:0。
   生产改名/挪位/误注入都会让重建期望与重捕实际对不上 → 红。 */
var FORUM_SLOT = { id: 'forum', slot: 'C04', on: false, tokens: 0,
  hidden: false, required: false };

/* 历史遗留债（2026-10-07 群声批首次跑本测试时暴露并补记）：
   v1 基线捕获后上线了「撤回」与「HTML 小游戏」两批，当时漏回写本期望 ——
   两张都是常开卡（on:true，tokens 随正文走，正文变更属各自批的白名单）。
   元信息按捕获写死，tokens 由结构断言外的 diffs 白名单吸收。 */
var MSGRECALL_SLOT = { id: 'msgrecall', slot: 'C04', on: true, required: false,
  hidden: false };
var HTMLGAME_SLOT = { id: 'htmlgame', slot: 'C04', on: true, required: false,
  hidden: false };

function withForumSlot(cap) {
  var out = JSON.parse(JSON.stringify(cap));
  function at(id) {
    for (var i = 0; i < out.slots.length; i++) {
      if (out.slots[i].id === id) return i;
    }
    assert(false, 'online 基线里找不到锚点槽（锚点漂了？）：' + id);
  }
  /* 本批（2026-10-08）批准插入：weproposal 之后新增 wenote（记一笔，
     char 自己提议把聊到的时刻记进 We 共同记录，[记一笔:标题|一句话|分类]）。
     注入门槛 = We 可用（岛 + weStore），不依赖日程候选；
     夹具岛有 We → on:true，tokens 按首跑实测写死（同 msgrecall/htmlgame 口径，
     正文再变就落 diffs 白名单，本批不吸收）。 */
  var WENOTE_SLOT = { id: 'wenote', slot: 'C04', on: true, tokens: 0,
    hidden: false, required: false };
  /* 先算好三个锚点再从大到小插，避免前面插入把后面的下标推歪 */
  var iwp = at('weproposal'), iimg = at('genimg'), ipat = at('pat');
  /* tokens 按捕获值写死（123 / 412）：这两张卡不归本批管，正文若再变，
     差异会落进下方 diffs 白名单（本批不吸收，照样红）—— 不在此处现算，
     免得期望侧读生产值变成「自己证明自己」。 */
  var mg = JSON.parse(JSON.stringify(MSGRECALL_SLOT));
  mg.tokens = 123;
  var hg = JSON.parse(JSON.stringify(HTMLGAME_SLOT));
  hg.tokens = 412;
  out.slots.splice(iwp + 1, 0, JSON.parse(JSON.stringify(WENOTE_SLOT)));
  out.slots.splice(iimg + 1, 0, hg);
  out.slots.splice(ipat + 1, 0, mg);
  return out;
}

/* 本批（2026-10-06）起线上期望统一走这里：K03e 的 talife + 本批的 realworld */
function withApprovedSlots(cap, kind) {
  var out = withTalifeSlot(cap, kind);
  if (kind === 'online') out = withRealworldSlot(out);
  if (kind === 'online') out = withForumSlot(out);
  return out;
}

/* 复刻生产 estimate()：cjk*1.6 + other*0.3，四舍五入 */
function estimateText(text) {
  var t = String(text || '');
  if (!t) return 0;
  var cjk = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  var other = t.length - cjk;
  return Math.round(cjk * 1.6 + other * 0.3);
}

/* 批准的新正文（来源：冻结模块 + 生产常量源码，测试里不自造） */
function c05OnlineTextFromSource() {
  var src = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  var m = /var BT_C05_ONLINE = \[([\s\S]*?)\]\.join\('\\n'\);/.exec(src);
  assert(m, '找不到 BT_C05_ONLINE 常量定义');
  return m[1].split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return /^'.*'[,\s]*$/.test(l); })
    .map(function (l) { return l.replace(/^'/, '').replace(/',?$/, ''); })
    .join('\n');
}
/* 解析结果自检：空串或明显不是协议正文 → 立刻报错，别让期望悄悄变成空 */
var __c05probe = c05OnlineTextFromSource();
assert(__c05probe.length > 200 && __c05probe.indexOf('[WHISPER]') >= 0,
  'BT_C05_ONLINE 解析结果异常（长度 ' + __c05probe.length + '）');
function btShellText() {
  var bt = PROBE.S.behaviorText;
  return [bt.module('B'), bt.module('P'), bt.module('L')].join('\n\n');
}
function btF1Text() {
  var bt = PROBE.S.behaviorText;
  return [bt.module('E'), bt.module('S1')].join('\n\n');
}

/* 在 messages 里按内容找**唯一**一条（负向对照用；不唯一就报错） */
function uniqueIndexOf(messages, text, what) {
  var hits = [];
  (messages || []).forEach(function (m, i) {
    if (m && String(m.content).indexOf(text) >= 0) hits.push(i);
  });
  assert(hits.length === 1, (what || text) + ' 应恰好命中 1 条，实得 ' + hits.length);
  return hits[0];
}

var V1_CAPS = V1DOC.captures;

/* ============================================================
   1. 新路径：三块正文**精确全文**比对（不是「首句存在」）
   ============================================================ */
head('新路径：三块正文精确比对');

var NEW = null;
t('默认无 override → behavior.used === true', function () {
  var h = boot({});
  var r = assemble(h);
  NEW = r;
  var b = r.behavior;
  assert(b, '返回值没有 behavior 诊断字段');
  eq(b.used, true, 'behavior.used：');
  eq(b.reason, '', 'behavior.reason：');
  eq(b.touched, false, 'behavior.touched：');
  eq(b.VERSION, 'sleepy-behavior-v1-review-01', 'behavior.VERSION：');
  eq(b.modules, ['B', 'P', 'L', 'E', 'S1'], 'behavior.modules：');
  /* 诊断对象里不许有正文 / 异常全文 / 用户内容 */
  var keys = Object.keys(b).sort();
  eq(keys, ['VERSION', 'modules', 'reason', 'touched', 'used'], '诊断字段集合：');
  var dump = JSON.stringify(b);
  [OLD_SHELL.slice(0, 20), OLD_F1.slice(0, 20), S_ONLINE.userPersona, 'Error', 'at ']
    .forEach(function (frag) {
      assert(dump.indexOf(frag) < 0, '诊断里带进了不该有的内容：' + frag.slice(0, 12));
    });
});

t('shell 槽 === B + P + L（逐字节，按 \\n\\n 拼接）', function () {
  var i = locate(NEW.messages, ANCHOR_NEW.shell, '新 shell');
  var bt = PROBE.S.behaviorText;
  var want = [bt.module('B'), bt.module('P'), bt.module('L')].join('\n\n');
  eq(NEW.messages[i].content, want, 'shell 正文：');
  assert(want.length > 1000, 'shell 正文长度异常：' + want.length);
  eq(Buffer.byteLength(want, 'utf8'), 4222, 'shell 正文 UTF-8 字节：');
  /* 旧节标题必须全部消失（去重而不是叠加） */
  ['[身份与场景]', '[角色声音]', '[事实与可见性]', '[主体性与责任]',
    '[工具真实性]', '[主动与节制]', '[输出]'].forEach(function (h2) {
    eq(countAnchor(NEW.messages, h2), 0, '旧外壳节 ' + h2 + ' 残留数：');
  });
});

t('f1 槽 === E + S1（逐字节）', function () {
  var i = locate(NEW.messages, ANCHOR_NEW.f1, '新 f1');
  var bt = PROBE.S.behaviorText;
  var want = [bt.module('E'), bt.module('S1')].join('\n\n');
  eq(NEW.messages[i].content, want, 'f1 正文：');
  /* 被 B/P/L/E/S1 取代的旧节标题必须消失 */
  ['【你怎么跟她相处】', '【情绪响应原则】', '【话题与活人感】', '【user 陈述后的回应】',
    '【关系边界】', '【分歧与行为责任】'].forEach(function (h2) {
    eq(countAnchor(NEW.messages, h2), 0, '旧 F1 节 ' + h2 + ' 残留数：');
  });
  /* B 批是**整卡替换**：F1 的全部旧节（含【调用任务】等）都被 B/P/L/E/S1 取代，
     旧的【输入确定性】反向断言见上一条 —— 这里补齐其余各节。 */
  ['【调用任务】', '【先判断，再回应】', '【真实感细节】', '【主动性档位】',
    '【禁止行为】', '【Deep Talk】', '【字面优先与反伪宠溺】', '【沉默与未回复】']
    .forEach(function (h2) {
      eq(countAnchor(NEW.messages, h2), 0, '旧 F1 节 ' + h2 + ' 残留数：');
    });
  ok('F1 整卡被 E + S1 取代（旧节全部不再出现）');
});

t('c05 槽 === 新协议正文（逐字节）', function () {
  var i = locate(NEW.messages, ANCHOR_NEW.c05, '新 c05');
  var src = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  var m = /var BT_C05_ONLINE = \[([\s\S]*?)\]\.join\('\\n'\);/.exec(src);
  assert(m, '找不到 BT_C05_ONLINE 常量定义');
  var want = m[1].split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return /^'.*'[,\s]*$/.test(l); })
    .map(function (l) { return l.replace(/^'/, '').replace(/',?$/, ''); })
    .join('\n');
  NEW_C05 = want;
  eq(NEW.messages[i].content, want, 'c05 正文：');
});

t('新 c05 保留心声契约、去掉旧表达限制与固定气泡示例', function () {
  var c = NEW_C05;
  /* 保留 */
  ['[WHISPER]', '[/WHISPER]', '不超过 40 字', '必须附带一条完整的'].forEach(function (f) {
    assert(c.indexOf(f) >= 0, '新 c05 缺契约：' + f);
  });
  /* 去掉：固定三泡示例 + 旧表达限制 */
  ['气泡1||气泡2||气泡3', '1-2 句', '不超过 30 字', '2-7 个气泡',
    '不要同时塞转折和追问', '不要把一段完整的段落压缩进一个气泡',
    '不许向 user 请示'].forEach(function (f) {
    assert(c.indexOf(f) < 0, '新 c05 仍带旧限制：' + f);
  });
  /* 单泡合法 + 多泡用分隔符 */
  assert(c.indexOf('||') >= 0, '新 c05 没写分隔符');
  assert(/单个气泡不添加分隔符/.test(c), '新 c05 没写「单泡不加分隔符」');
});

t('旧 CARD_DEFAULTS.c05 一字未改（兼容路径继续用旧协议）', function () {
  eq(PROBE.S.promptEngine.cardBody('c05'), OLD_C05, '默认 c05：');
  ['气泡1||气泡2||气泡3', '- 每条气泡 1-2 句，原则上不超过 30 字',
    '- 每次回复 2-7 个气泡'].forEach(function (f) {
    assert(OLD_C05.indexOf(f) >= 0, '旧 c05 丢了：' + f);
  });
});

/* ============================================================
   2. 白名单外零差异（逐条比对 v1 基线）
   ============================================================ */

/* 常开卡两条（msgrecall / htmlgame）：v1 基线之后上线的批次，漏回写本期望，
   2026-10-07 群声批收口。期望重建 = 在 v1 messages 里按锚点把 NEW 捕获中的
   这两条插回正确位置（pat 之后 / genimg 之后）—— 不复制正文，直接引用
   NEW 里的同一条（逐字节相同，来源单一实现）。 */
function withAlwaysOnMessages(msgs) {
  var out = JSON.parse(JSON.stringify(msgs));
  function idx(frag) {
    for (var i = 0; i < out.length; i++) {
      if (String(out[i].content || '').indexOf(frag) >= 0) return i;
    }
    return -1;
  }
  function pull(frag) {
    for (var i = 0; i < NEW.messages.length; i++) {
      if (String(NEW.messages[i].content || '').indexOf(frag) >= 0) {
        return JSON.parse(JSON.stringify(NEW.messages[i]));
      }
    }
    assert(false, 'NEW 里找不到常开卡锚点：' + frag);
  }
  /* 变体夹具可能禁用某能力（如 onlineDisabledPat 没有拍一拍）——
     锚点缺失 = 该变体本就没有这条卡 → 跳过插入（与生产捕获一致） */
  var ipat = idx('拍一拍');
  if (ipat < 0) ipat = idx('你不是在扮演一个角色');   /* 禁用 pat 的变体：退到 f1 后 */
  if (ipat >= 0) out.splice(ipat + 1, 0, pull('刚说的话可以反悔'));
  var iimg = idx('生图:');
  if (iimg >= 0) out.splice(iimg + 1, 0, pull('亲手做一个能在聊天里直接玩的小游戏'));
  return out;
}
var EXP_ONLINE_MSGS = withAlwaysOnMessages(V1_ONLINE.messages);

head('白名单外零差异（对比 v1 基线，只读）');

t('除 shell / f1 / c05 三条外，其余 messages 逐字节未变（含常开卡批准插入）', function () {
  var oldMsgs = EXP_ONLINE_MSGS;
  var newMsgs = NEW.messages;
  eq(newMsgs.length, oldMsgs.length, 'messages 条数：');
  var switched = [
    locate(oldMsgs, ANCHOR_OLD.shell, '旧 shell'),
    locate(oldMsgs, ANCHOR_OLD.f1, '旧 f1'),
    locate(oldMsgs, ANCHOR_OLD.c05, '旧 c05')
  ].sort(function (a, b) { return a - b; });
  /* c05 位置因两张常开卡插入而 +2（4/5 不受影响 —— 插入点都在其后） */
  eq(switched, [4, 5, 18], '三条受影响 system 的位置：');
  var diffs = [];
  for (var i = 0; i < oldMsgs.length; i++) {
    if (switched.indexOf(i) >= 0) {
      assert(newMsgs[i].content !== oldMsgs[i].content,
        '第 ' + i + ' 条（' + switched.join('/') + ' 之一）竟然没变');
      continue;
    }
    if (JSON.stringify(newMsgs[i]) !== JSON.stringify(oldMsgs[i])) {
      diffs.push(i + '（' + oldMsgs[i].role + '）');
    }
  }
  eq(diffs, [], '白名单外被改动的 messages：');
  ok('白名单外 ' + (oldMsgs.length - switched.length) + ' 条逐字节一致' +
    '（含 3 条历史 + 全部输入/能力说明）');
});

t('slots 表结构未变，只有 shell/f1/c05 的 tokens 变（含 K03e 批准槽位插入）', function () {
  /* 2026-10-05 K03e 批：taimpact 之后插入 talife（K03e）—— 批准的结构变化。
     期望侧用 withTalifeSlot 显式插入（元信息写死），黄金基线文件不动。 */
  var olds = withApprovedSlots(V1_ONLINE, 'online').slots, news = NEW.slots;
  eq(news.length, olds.length, 'slots 条数：');
  var diffs = [];
  for (var i = 0; i < olds.length; i++) {
    var a = olds[i], b = news[i];
    eq([b.id, b.slot, b.on, b.required, b.hidden], [a.id, a.slot, a.on, a.required, a.hidden],
      '第 ' + i + ' 槽（' + a.id + '）的元信息：');
    if (a.tokens !== b.tokens) diffs.push(a.id);
  }
  eq(diffs.sort(), ['c05', 'f1', 'shell'], 'tokens 变化的槽：');
});

/* ============================================================
   3. override：一整条走旧，被覆盖那张 = 用户文本
   ============================================================ */
head('override：整套回退（被覆盖那张 = 用户文本，另两张 = 旧默认）');

/* 期望 = 「v1 基线 + 把被覆盖那张换成用户文本」—— 逐字节重建，不靠锚点猜。
   注意：被覆盖后，该卡的**旧默认正文不再出现**（锚点自然失效），
   所以定位必须用基线位置，不能用旧正文标题。 */
function expectOverride(cardId, userText) {
  var msgs = JSON.parse(JSON.stringify(EXP_ONLINE_MSGS));
  var at = -1;
  var anchor = ANCHOR_OLD[cardId];
  for (var i = 0; i < msgs.length; i++) {
    if (String(msgs[i].content || '').indexOf(anchor.slice(0, 24)) >= 0) { at = i; break; }
  }
  assert(at >= 0, '重建期望里找不到被覆盖卡：' + cardId);
  msgs[at].content = userText;
  return msgs;
}

function overrideCase(name, cardId, userText) {
  t(name, function () {
    var h = boot({ overrides: (function () { var o = {}; o[cardId] = userText; return o; })() });
    var r = assemble(h);
    eq(r.behavior.used, false, 'behavior.used：');
    eq(r.behavior.reason, 'user-override', 'behavior.reason：');
    eq(r.behavior.touched, true, 'behavior.touched：');
    eq(r.behavior.modules, [], 'behavior.modules：');
    /* 整套：被覆盖那张 = 用户文本，另两张 = 旧默认 —— 逐字节比对 */
    eq(r.messages, expectOverride(cardId, userText), '整套 messages：');
    /* 新正文一个字都不许出现 */
    ['以本轮提供的有效资料', '当前通过消息交流', '正文可以包含一个或多个气泡']
      .forEach(function (f) { eq(countAnchor(r.messages, f), 0, '新正文残留 ' + f + '：'); });
    /* 另两张仍是旧默认正文（明确断言，不只是数组相等） */
    var other = ['shell', 'f1', 'c05'].filter(function (x) { return x !== cardId; });
    other.forEach(function (x) {
      /* 常开卡两张插在中间 —— 旧下标不可靠，按旧正文锚点定位 */
      var at = locate(r.messages, ANCHOR_OLD[x], '旧 ' + x);
      eq(r.messages[at].content,
        x === 'shell' ? OLD_SHELL : (x === 'f1' ? OLD_F1 : OLD_C05),
        x + ' 应是旧默认正文：');
    });
  });
}

overrideCase('仅 shell override → 三槽全旧，shell = 用户文本', 'shell', '夹具·覆盖外壳·B批');
overrideCase('仅 f1 override → 三槽全旧，f1 = 用户文本', 'f1', '夹具·覆盖 F1·B批');
overrideCase('仅 c05 override → 三槽全旧，c05 = 用户文本', 'c05', '夹具·覆盖 c05·B批');

t('空 override（shell = ""）→ 三槽全旧 + 如实记录既有缺陷', function () {
  var h = boot({ overrides: { shell: '' } });
  var r = assemble(h);
  eq(r.behavior.used, false, 'behavior.used：');
  eq(r.behavior.reason, 'user-override', 'behavior.reason：');
  /* 另两张仍是旧默认正文 */
  var iF1 = locate(r.messages, ANCHOR_OLD.f1, '旧 f1');
  var iC05 = locate(r.messages, ANCHOR_OLD.c05, '旧 c05');
  eq(r.messages[iF1].content, OLD_F1, 'f1 正文：');
  eq(r.messages[iC05].content, OLD_C05, 'c05 正文：');
  /* shell 是既有缺陷：槽 on=true、正文空、该条不进 messages */
  var slot = r.slots.filter(function (s) { return s.id === 'shell'; })[0];
  assert(slot && slot.on === true, '空 override 的 shell 槽应是 on（既有缺陷）');
  eq(countAnchor(r.messages, ANCHOR_OLD.shell), 0, '空 override 下旧 shell 正文数：');
  eq(r.messages.length, EXP_ONLINE_MSGS.length - 1, 'messages 条数（少一条幽灵槽）：');
  ok('如实标注：空 override → 槽 on 但无正文，**不是**新组合迁移成功');
});

t('空 override（f1 = ""）→ 三槽全旧', function () {
  var h = boot({ overrides: { f1: '' } });
  var r = assemble(h);
  eq([r.behavior.used, r.behavior.reason], [false, 'user-override']);
  eq(countAnchor(r.messages, ANCHOR_OLD.shell), 1, '旧 shell 数：');
  eq(countAnchor(r.messages, ANCHOR_OLD.c05), 1, '旧 c05 数：');
  var slot = r.slots.filter(function (s) { return s.id === 'f1'; })[0];
  assert(slot && slot.on === true, '空 override 的 f1 槽应是 on');
  eq(countAnchor(r.messages, ANCHOR_OLD.f1), 0, '空 override 下旧 f1 正文数：');
});

t('空 override（c05 = ""）→ 三槽全旧', function () {
  var h = boot({ overrides: { c05: '' } });
  var r = assemble(h);
  eq([r.behavior.used, r.behavior.reason], [false, 'user-override']);
  eq(countAnchor(r.messages, ANCHOR_OLD.shell), 1, '旧 shell 数：');
  eq(countAnchor(r.messages, ANCHOR_OLD.f1), 1, '旧 f1 数：');
  var slot = r.slots.filter(function (s) { return s.id === 'c05'; })[0];
  assert(slot && slot.on === true, '空 override 的 c05 槽应是 on');
  eq(countAnchor(r.messages, ANCHOR_OLD.c05), 0, '空 override 下旧 c05 正文数：');
});

/* ============================================================
   4. 失败情形：整套回退（三槽一起）
   ============================================================ */

/* 在沙箱里替换测试桩（不改生产 TEXT / VERSION） */
function withStub(mutator) {
  var h = boot({});
  var bt = h.S.behaviorText;
  mutator(h.S, bt);
  return h;
}

/* 断言「整套回退」：三槽都是旧默认正文，且没有半套新正文 */
function assertFullFallback(h, wantReason, label) {
  var r = assemble(h);
  eq(r.behavior.used, false, label + ' behavior.used：');
  if (wantReason) eq(r.behavior.reason, wantReason, label + ' behavior.reason：');
  var iShell = locate(r.messages, ANCHOR_OLD.shell, label + ' 旧 shell');
  var iF1 = locate(r.messages, ANCHOR_OLD.f1, label + ' 旧 f1');
  var iC05 = locate(r.messages, ANCHOR_OLD.c05, label + ' 旧 c05');
  eq([r.messages[iShell].content, r.messages[iF1].content, r.messages[iC05].content],
    [OLD_SHELL, OLD_F1, OLD_C05], label + ' 三槽正文：');
  ['以本轮提供的有效资料', '当前通过消息交流', '正文可以包含一个或多个气泡']
    .forEach(function (f) { eq(countAnchor(r.messages, f), 0, label + ' 新正文残留：'); });
  return r;
}

head('失败情形：整套回退');

t('模块缺失（删掉 Sleepy.behaviorText）', function () {
  var h = boot({});
  delete h.S.behaviorText;
  assertFullFallback(h, 'module-missing', '模块缺失');
});

t('forScenario 抛错', function () {
  var h = withStub(function (S, bt) {
    S.behaviorText = { VERSION: bt.VERSION, planOf: bt.planOf,
      forScenario: function () { throw new Error('夹具：故意抛错，不把异常文本带出'); } };
  });
  var r = assertFullFallback(h, 'call-threw', '抛错');
  assert(JSON.stringify(r.behavior).indexOf('故意抛错') < 0,
    '异常全文被带进了诊断');
});

t('版本不符', function () {
  var h = withStub(function (S, bt) {
    S.behaviorText = { VERSION: 'sleepy-behavior-v9-not-real', planOf: bt.planOf,
      forScenario: bt.forScenario };
  });
  assertFullFallback(h, 'version-mismatch', '版本不符');
});

t('结果单独缺项（planOf 仍 5 项，结果只 4 项）', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    S.behaviorText = { VERSION: bt.VERSION, planOf: bt.planOf,
      forScenario: function () {
        var parts = real.parts.slice(0, 4);
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: parts.map(function (p) { return p.id; }), parts: parts,
          text: parts.map(function (p) { return p.text; }).join('\n\n') };
      } };
  });
  var r = assertFullFallback(h, null, '结果单独缺项');
  eq(r.behavior.reason, 'plan-mismatch', '结果单独缺项 reason：');
});

t('plan 与结果同时缺项（都少一个）→ 仍整体回退', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    var parts = real.parts.slice(0, 4);
    S.behaviorText = { VERSION: bt.VERSION,
      planOf: function () { return parts.map(function (p) { return p.id; }); },
      forScenario: function () {
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: parts.map(function (p) { return p.id; }), parts: parts,
          text: parts.map(function (p) { return p.text; }).join('\n\n') };
      } };
  });
  var r = assertFullFallback(h, null, '同时缺项');
  eq(r.behavior.reason, 'slot-contract', '同时缺项 reason：');
});

t('plan 与结果同时多项（都多一个）→ 仍整体回退', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    var parts = real.parts.concat([{ id: 'S9', text: '夹具·多余模块正文' }]);
    S.behaviorText = { VERSION: bt.VERSION,
      planOf: function () { return parts.map(function (p) { return p.id; }); },
      forScenario: function () {
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: parts.map(function (p) { return p.id; }), parts: parts,
          text: parts.map(function (p) { return p.text; }).join('\n\n') };
      } };
  });
  var r = assertFullFallback(h, null, '同时多项');
  eq(r.behavior.reason, 'slot-contract', '同时多项 reason：');
  eq(countAnchor(r.messages, '夹具·多余模块正文'), 0, '多余模块正文进了请求：');
});

t('plan 与结果同时重复（B 出现两次）→ 仍整体回退', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    var parts = real.parts.slice();
    parts[1] = { id: 'B', text: parts[0].text };      /* 把 P 换成第二份 B */
    S.behaviorText = { VERSION: bt.VERSION,
      planOf: function () { return parts.map(function (p) { return p.id; }); },
      forScenario: function () {
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: parts.map(function (p) { return p.id; }), parts: parts,
          text: parts.map(function (p) { return p.text; }).join('\n\n') };
      } };
  });
  assertFullFallback(h, null, '同时重复');
});

t('plan 与结果同时错序（E / S1 互换）→ 仍整体回退', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    var parts = real.parts.slice();
    var tmp = parts[3]; parts[3] = parts[4]; parts[4] = tmp;   /* E <-> S1 */
    S.behaviorText = { VERSION: bt.VERSION,
      planOf: function () { return parts.map(function (p) { return p.id; }); },
      forScenario: function () {
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: parts.map(function (p) { return p.id; }), parts: parts,
          text: parts.map(function (p) { return p.text; }).join('\n\n') };
      } };
  });
  var r = assertFullFallback(h, null, '同时错序');
  eq(r.behavior.reason, 'slot-contract', '同时错序 reason：');
});

t('空白正文（某个 part 是纯空白）→ 整体回退', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    var parts = real.parts.map(function (p, i) {
      return i === 1 ? { id: p.id, text: '   \n  ' } : p;
    });
    S.behaviorText = { VERSION: bt.VERSION, planOf: bt.planOf,
      forScenario: function () {
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: parts.map(function (p) { return p.id; }), parts: parts,
          text: parts.map(function (p) { return p.text; }).join('\n\n') };
      } };
  });
  assertFullFallback(h, 'bad-part', '空白正文');
});

t('拼接不一致（text 与 parts 对不上）→ 整体回退', function () {
  var h = withStub(function (S, bt) {
    var real = bt.forScenario('online');
    S.behaviorText = { VERSION: bt.VERSION, planOf: bt.planOf,
      forScenario: function () {
        return { ok: true, scene: 'online', error: null, missing: [],
          modules: real.modules.slice(), parts: real.parts.slice(),
          text: real.text + '\n夹具·偷偷多出来的一行' };
      } };
  });
  assertFullFallback(h, 'join-mismatch', '拼接不一致');
});

t('ok=false（missing 非空）→ 整体回退', function () {
  var h = withStub(function (S, bt) {
    S.behaviorText = { VERSION: bt.VERSION, planOf: bt.planOf,
      forScenario: function () {
        return { ok: false, scene: 'online', error: 'empty-module', missing: ['B'],
          modules: [], parts: [], text: '' };
      } };
  });
  assertFullFallback(h, 'not-ok', 'ok=false');
});

/* ============================================================
   5. forScenario 调用次数（正常路径 1 次；override 路径 0 次）
   ============================================================ */
head('调用次数');

t('正常路径：forScenario 恰好调用 1 次、planOf 恰好 1 次', function () {
  var h = boot({});
  var bt = h.S.behaviorText;
  var nScene = 0, nPlan = 0;
  h.S.behaviorText = {
    VERSION: bt.VERSION,
    planOf: function (s) { nPlan++; return bt.planOf(s); },
    forScenario: function (s) { nScene++; return bt.forScenario(s); }
  };
  var r = assemble(h);
  eq(r.behavior.used, true, 'behavior.used：');
  eq([nPlan, nScene], [1, 1], 'planOf / forScenario 调用次数：');
});

t('override 路径：forScenario 一次都不调', function () {
  var h = boot({ overrides: { f1: '夹具·覆盖 F1·计数' } });
  var bt = h.S.behaviorText;
  var nScene = 0, nPlan = 0;
  h.S.behaviorText = {
    VERSION: bt.VERSION,
    planOf: function (s) { nPlan++; return bt.planOf(s); },
    forScenario: function (s) { nScene++; return bt.forScenario(s); }
  };
  var r = assemble(h);
  eq(r.behavior.reason, 'user-override', 'behavior.reason：');
  eq([nPlan, nScene], [0, 0], 'override 下的调用次数：');
});

/* ============================================================
   6. 其他场景：源码 0 引用（**辅助锁**，不是验证本体）
   ------------------------------------------------------------
   ⚠️ 这一节只证明「四个装配入口没引用本模块」—— 代码级反向锁。
      **真正的验证**是重捕后与 v1 基线逐字段比对（见第 9 节）。
   ============================================================ */
head('其他场景：源码 0 引用（辅助）');

t('四个装配入口源码 0 引用（辅助锁，非验证本体）', function () {
  /* 辅助断言：本批没改这几个文件。重捕比对见第 9 节。 */
  ['proactive', 'groupOnline', 'groupOffline', 'offline'].forEach(function (k) {
    var c = V1DOC.captures[k];
    assert(c, k + ' 在 v1 基线里不存在');
    assert(c.scope === 'assembly' || c.scope === 'transport', k + ' scope 异常');
  });
  /* 代码级反向锁：这四个场景的装配入口不许引用本模块 */
  ['page-proactive.js', 'page-group-ai.js', 'page-group-offline.js', 'page-offline.js']
    .forEach(function (rel) {
      var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert(src.indexOf('behaviorText') < 0, rel + ' 引用了 behaviorText');
    });
  ok('四条装配线 0 引用（配合白名单断言，见 behavior-text-test 第 11 节）');
});

/* 「offline 已迁」的反向断言（原为「本批未迁」）搬到了 §9c 的
   strictOfflineCase() 里 —— 它要用 EXP_OFFLINE 这份**写死的批准预期**，
   而该常量声明在后面（模块顶层 const 有暂时性死区，提前用会抛
   "Cannot read properties of undefined"）。原来那条断言的两条保护
   （c05off 不被接管、退役标记不在）已由 strictOfflineCase 原样保留。 */

/* ============================================================
   7. 加载顺序（单独验证）
   ============================================================ */
head('加载顺序与缓存');

t('index.html 脚本数（82 → 现价 89，历批累计未回写，本批收口），且 behavior-text.js 早于 prompt-engine.js', function () {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var refs = [], re = /<script\s+src="([^"]+)"/g, m;
  while ((m = re.exec(html))) refs.push(m[1]);
  eq(refs.length, 89, '脚本数：');
  var a = refs.indexOf('behavior-text.js'), b = refs.indexOf('prompt-engine.js');
  var c = refs.indexOf('page-chat-settings.js');
  assert(a >= 0, 'behavior-text.js 不在脚本列表');
  assert(a < b, '未早于 prompt-engine.js');
  assert(a < c, '未早于启动点火脚本');
  eq(H.ORDER.length, 89, 'harness 解析到的脚本数：');
  eq(H.ORDER.indexOf('behavior-text.js') < H.ORDER.indexOf('prompt-engine.js'), true,
    'harness 顺序：');
});

t('sw.js CACHE 与 smoke.js 的独立常量一致（本次确认的版本下限 161）', function () {
  var sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  var m = /var CACHE = 'sleepy-v(\d+)'/.exec(sw);
  assert(m, '找不到 CACHE 定义');
  /* ★ 基准**从 smoke.js 源码读出**，不在这里再写一个数字 ——
     smoke.js 的 EXPECTED_SW_CACHE 是**手写常量**，它自己就断言 sw.js 等于它，
     那条才是「本批跳位」的守门人。这里做**两文件一致性**交叉检查：
     防止只改 sw.js 忘改基准、或只改基准忘跳位，任一单边改动都会红。
     ⚠️ 反面教材（不可照做）：从 sw.js 读出 CACHE 再断言它等于自己 —— 永远为真。 */
  var smokeSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke.js'), 'utf8');
  var sm = /const EXPECTED_SW_CACHE = 'sleepy-v(\d+)'/.exec(smokeSrc);
  assert(sm, 'smoke.js 里找不到 EXPECTED_SW_CACHE 独立常量');
  /* 本次确认的版本下限：只覆盖「不低于本次核对时确认的值」这一含义，
     **不是**通用防倒退机制（更早的号是否可用由 smoke.js 的常量负责）。 */
  var CONFIRMED_FLOOR = 161;
  assert(Number(sm[1]) >= CONFIRMED_FLOOR,
    'smoke.js 的 EXPECTED_SW_CACHE 低于本次确认的版本下限 v' + CONFIRMED_FLOOR + '：v' + sm[1]);
  eq(Number(m[1]), Number(sm[1]),
    'CACHE 与 smoke.js 独立常量不一致：sw.js=v' + m[1] + ' / smoke.js=v' + sm[1] +
    '（改了运行时脚本必须两处同跳）');
  assert(Number(m[1]) >= CONFIRMED_FLOOR,
    'CACHE 低于本次确认的版本下限 v' + CONFIRMED_FLOOR + '：实得 v' + m[1]);
});

/* ============================================================
   8. v1 基线未被本测试改动
   ============================================================ */
head('v1 基线只读');

t('本脚本源码里没有对 v1 基线的写调用', function () {
  var src = fs.readFileSync(__filename, 'utf8');
  var W = ['write', 'FileSync'].join('');
  var U = ['unlink', 'Sync'].join('');
  assert(new RegExp('fs\\\\.' + W + '\\(').test(src) === false, '脚本里有写调用');
  assert(new RegExp('fs\\\\.' + U + '\\(').test(src) === false, '脚本里有删调用');
  assert(src.indexOf('CAP.BASELINE') >= 0, '脚本没引用基线路径（检查口径失效）');
});

t('v1 基线文件内容指纹未变（本测试全程只读）', function () {
  var now = H.sha256(fs.readFileSync(V1, 'utf8'));
  eq(now, V1_SHA, 'v1 基线指纹：');
});

/* ============================================================
   9. 重捕比对（隔离沙箱、逐用例独立内存）
   ------------------------------------------------------------
   判据形态（**不是**索引白名单）：
     · 期望 = 「该用例的 v1 基线记录」**整份重建** —— 三条 system 换成本批
       批准的新正文、三个槽的 tokens 换成用复刻公式从新正文算出的值，其余原样；
       然后整条记录逐字段比对，要求差异为空。
     · 另加一条：与基线的**差异集合**必须恰为该用例的 9 条，
       且每条都有确切期望值（不是「允许任意差异」）。
   ★ shellHead / f1Check / shellDefaultBodyInMessages 是**捕获脚本的夹具自检**
     （判断「旧外壳节 / 旧 F1 节是否还出现在文本里」），**不是模型请求正文**：
     线上四例迁移后应为 false；未迁移场景（offline / groupOffline / proactive）仍为 true。
   ============================================================ */

var CAPS = null, CAPDOC = null;
var ONLINE_CASES = ['online', 'onlineDisabledPat', 'onlineDisabledRequired', 'onlineLifeEmpty'];
/* ★ 只留 offlineOverrideEmpty（空串 override 回退后仍与 v1 一致，语义未变）。
   offline / groupOffline / proactive 都已迁移完成，各自由**专用受控检查**接管
   （strictOfflineCase / strictGroupOfflineCase / strictProactiveCase）。 */
var OTHER_CASES = ['offlineOverrideEmpty'];

/* 该用例三条 system 的基线位置：按**该用例**旧基线的唯一锚定位（各命中 1 条） */
function onlinePositions(key) {
  var msgs = withAlwaysOnMessages(V1_CAPS[key].messages);
  return {
    shell: locate(msgs, ANCHOR_OLD.shell, key + ' 基线的旧 shell'),
    f1: locate(msgs, ANCHOR_OLD.f1, key + ' 基线的旧 f1'),
    c05: locate(msgs, ANCHOR_OLD.c05, key + ' 基线的旧 c05')
  };
}

function slotIndexById(slots, id) {
  var hit = -1;
  (slots || []).forEach(function (x, i) { if (hit < 0 && x.id === id) hit = i; });
  assert(hit >= 0, '找不到槽 ' + id);
  return hit;
}

/* 重建该用例的期望记录：只改批准的三处正文 + 三个 tokens + 三个自检字段 */
function rebuildOnline(key) {
  var exp = withApprovedSlots(V1_CAPS[key], 'online');   /* K03e + 1006 + 1007 批准槽位插入 */
  exp.messages = withAlwaysOnMessages(V1_CAPS[key].messages); /* 常开卡两条（1007 收口） */
  var pos = onlinePositions(key);
  var want = { shell: btShellText(), f1: btF1Text(), c05: c05OnlineTextFromSource() };
  exp.messages[pos.shell].content = want.shell;
  exp.messages[pos.f1].content = want.f1;
  exp.messages[pos.c05].content = want.c05;
  ['shell', 'f1', 'c05'].forEach(function (id) {
    var slot = exp.slots[slotIndexById(exp.slots, id)];
    assert(slot.on === true && slot.required === true && slot.hidden === false,
      key + ' 的 ' + id + ' 槽迁移前应为 on + required + 不隐藏：' + JSON.stringify(slot));
    slot.tokens = estimateText(want[id]);            /* 期望值由复刻公式给出 */
  });
  /* 底稿口径自检：迁移前这三个自检字段必须是 true（否则说明底稿口径变了） */
  eq([exp.sentinels['probe.shellHead'], exp.sentinels['probe.f1Check'],
    exp.checks.shellDefaultBodyInMessages], [true, true, true], key + ' 基线自检字段：');
  exp.sentinels['probe.shellHead'] = false;
  exp.sentinels['probe.f1Check'] = false;
  exp.checks.shellDefaultBodyInMessages = false;
  return exp;
}

/* 「与 v1 基线的差异」应恰为这 9 条 */
function expectedDiffSet(key) {
  var pos = onlinePositions(key);
  var base = withApprovedSlots(V1_CAPS[key], 'online');
  base.messages = withAlwaysOnMessages(V1_CAPS[key].messages);
  return [
    'messages[' + pos.shell + '].content',
    'messages[' + pos.f1 + '].content',
    'messages[' + pos.c05 + '].content',
    'slots[' + slotIndexById(base.slots, 'shell') + '].tokens',
    'slots[' + slotIndexById(base.slots, 'f1') + '].tokens',
    'slots[' + slotIndexById(base.slots, 'c05') + '].tokens',
    'sentinels.probe.shellHead',
    'sentinels.probe.f1Check',
    'checks.shellDefaultBodyInMessages'
  ].sort();
}

function strictOnlineCase(key) {
  t('[' + key + '] 与 v1 的差异恰为批准的 9 条 + 批准槽位/常开卡插入（其余一律不变）', function () {
    assert(CAPS[key], key + ' 没捕到');
    var base = withApprovedSlots(V1_CAPS[key], 'online');
    base.messages = withAlwaysOnMessages(V1_CAPS[key].messages);
    eq(diffPaths(base, CAPS[key]).sort(), expectedDiffSet(key),
      key + ' 与 v1 的差异：');
  });
  t('[' + key + '] 「基线 + 三处批准替换」重建后期望 === 实际（整条）', function () {
    eq(diffPaths(rebuildOnline(key), CAPS[key]), [], key + ' 重建期望 vs 重捕实际：');
    eq(CAPS[key].messages.length, withAlwaysOnMessages(V1_CAPS[key].messages).length, key + ' messages 条数：');
  });
}

function strictOtherCase(key) {
  t('[' + key + '] 重捕与 v1 基线逐字段一致（narrative 槽 + K03e 批准槽位插入除外）', function () {
    /* ★ 2026-10-05 七项文风批批准差异：narrative 槽的文风行从旧三套
       （pure_love 系）换成六套正文（回落 nature_life）。
       ★ 2026-10-05 K03e 批批准差异：taimpact 后插入 talife 槽（见 withTalifeSlot）。
       除这两条批准路径外，其余字段仍必须与 v1 逐字段一致。 */
    assert(CAPS[key], key + ' 没捕到');
    var base = withTalifeSlot(V1_CAPS[key], 'offline');
    var approved = narrativeApprovedPaths(base);
    var got = diffPaths(base, CAPS[key]).filter(function (p) {
      return approved.indexOf(p) < 0;
    });
    eq(got, [], key + ' 与 v1 基线的差异（已扣除批准差异）：');
  });
}

/* 七项文风批的两条批准差异路径：narrative 消息 content + 该槽 tokens。 */
function narrativeApprovedPaths(cap) {
  var iN = -1;
  (cap.messages || []).forEach(function (m, i) {
    if (iN < 0 && m && String(m.content || '').indexOf('【叙事设置】') >= 0) iN = i;
  });
  assert(iN >= 0, '基线里找不到【叙事设置】消息（结构变了？）');
  return [
    'messages[' + iN + '].content',
    'slots[' + slotIndexById(cap.slots, 'narrative') + '].tokens'
  ];
}

/* ============================================================
   9b. groupOnline 受控迁移检查（v161 接线批）

   ★ 为什么 groupOnline 不能用 strictOtherCase：它在 v161 批**首次接线**，
     system 里多出冻结行为正文 B/P/L 与 E/S4 —— 「与未接线的 v1 逐字段相同」
     这个判据在接线那一刻就必然失效；更糟的是它**只在失效时报红**，
     接线漏了 B/P/L、或把 groupRound 顶掉，它反而全绿（假绿）。
   ★ 所以改成**受控迁移检查**：先证明新增块**完整、各一次、位置符合批准装配**，
     再按**偏移量**移除新增块连同其装配分隔符，剩余部分与 v1 **逐字**比对。
     移除**不用宽泛正则、不删所有匹配文本、不统一清洗空白** ——
     那三种做法会把真实差异一起抹掉，等于把判据关掉。
   ★ v1 黄金基线**只读**：不重捕、不替换、不覆盖。
   ============================================================ */

/* 批准装配顺序：B/P/L → groupRound → E/S4 → 原有群现场信息。
   期望块由**生产模块**导出（PROBE.S.behaviorText），不是从重捕结果里抠出来的。 */
var GO_SHELL_IDS = ['B', 'P', 'L'];
var GO_SCENE_IDS = ['E', 'S4'];
var GO_TAIL_ANCHOR = '[GROUP]';      /* 原有群现场信息的第一段 */
var GO_SEP = '\n\n';                /* 装配分隔符 */

/* ---- K03f / f493aca 批准新增块（全部从**生产编译器**现算，不从重捕结果抠）----
   ★ 夹具形状：createGroup 会把 owner 账号自动带成 user 成员 ⇒ userMaskId =
     umBig（大号）；umBig 没写 persona ⇒ USER_CORE 缺席（下面有缺席断言），
     但逐本体 I01 **在场**（f493aca 批准块，逐本体 cognition 独立）；
     世界书夹具只有一本挂在 chMain 身上的个人书（always 常驻）⇒ 共享块静默；
     自定义卡夹具没标 group ⇒ 不进群（这正是「不广播」的断言点）。 */
var GO_ENTITIES = PROBE.S.groupAI.entitiesOf(PROBE.groupId).map(function (e) { return e.ownerId; });
var GO_USER = (PROBE.S.groupStore.membersOf(PROBE.groupId).filter(function (m) {
  return m.kind === 'user';
})[0] || {}).accountId || null;
var GO_PE = PROBE.S.promptEngine;
var GO_TIME = GO_PE.compileGroupTimeFacts(GO_ENTITIES);
var GO_LANG = {};
var GO_LIFE = {};
var GO_WB = {};
var GO_I01 = {};
(function () {
  var wbg = GO_PE.compileWorldbookGroup(GO_ENTITIES, '');
  GO_ENTITIES.forEach(function (oid) {
    GO_LANG[oid] = GO_PE.compileLangGroup(oid) || '';
    GO_I01[oid] = (GO_USER && GO_PE.compileI01) ? (GO_PE.compileI01(oid, GO_USER) || '') : '';
    GO_LIFE[oid] = (PROBE.S.lifeFeed && PROBE.S.lifeFeed.text) ? (PROBE.S.lifeFeed.text(oid, GO_USER) || '') : '';
    GO_WB[oid] = (wbg.perEntity && wbg.perEntity[oid]) || '';
  });
})();
/* 从文本里摘掉一个批准块：必须唯一命中，并连带摘掉**一个**相邻装配换行
   （防止残留孤立 \n 破坏逐字比对）。摘了多少字节由调用方记账。 */
function cutApprovedPiece(text, piece, what) {
  assert(piece && piece.length, what + '：批准块产出为空（生产编译器没吐内容？）');
  var n = occurrencesOf(text, piece);
  assert(n === 1, what + ' 应恰好出现 1 次，实得 ' + n + ' 次');
  var cands = [GO_SEP + piece, '\n' + piece, piece + GO_SEP, piece + '\n'];
  for (var i = 0; i < cands.length; i++) {
    var at = text.indexOf(cands[i]);
    if (at >= 0) {
      return {
        text: text.slice(0, at) + text.slice(at + cands[i].length),
        bytes: cands[i].length
      };
    }
  }
  throw new Error(what + '：块唯一命中但找不到可摘的相邻分隔符');
}

function goBtBlock(ids) {
  var bt = PROBE.S.behaviorText;
  return ids.map(function (id) { return bt.module(id); }).join(GO_SEP);
}
function goShellBlock() { return goBtBlock(GO_SHELL_IDS); }
function goSceneBlock() { return goBtBlock(GO_SCENE_IDS); }

/* ============================================================
   9c. offline / groupOffline / proactive 的受控迁移检查

   ★ 三者都是「**替换旧块 + （可能）新增块**」，与 groupOnline 的「纯新增」不同 ——
     所以**不能**照搬 strictGroupOnlineCase 的「删掉新增块后等于完整 v1」：
     那个判据在这三个场景上恒不成立（旧外壳是被**替换**掉的，不是被删掉的）。

   ★ 两个转换（都已在只读取证里逐字节验证过）：
     offline      —— 两条消息**整条**内容替换（槽位本身就是整段）。
     groupOffline —— 只把 system 开头那段**旧外壳区间**换成 B/P/L，
                     其余现场 / 协议 / 分隔符**逐字保留**（含尾部的 \n\n）。
     proactive    —— 同样先替换旧外壳区间，再在**批准位置**（场景卡之后、
                     第一个 [CHARACTER] 段之前）**插入** E/S3。

   ★ 旧外壳区间的定位证据（v1 原文，两处都成立）：
     偏移 0、长度 746（= 生产 cardBody('shell') 的长度）、
     在 v1 原文里**唯一命中**、其后紧跟恰好一个 GO_SEP。
     定位靠这三个条件 + 唯一性断言，不靠「取前 N 段」这种猜法。
   ============================================================ */

/* ---- 批准预期（**显式写死**，不从生产 BT_SPECS 读）----
   ★ 为什么必须写死：若改成读 BT_SPECS，生产把 injectShell 误改成 false 时
     期望会跟着变，测试**跟着变绿** —— 那就白测了。
     写死之后，生产误改开关 → 期望仍是 true → 立刻红。 */
var EXP_OFFLINE = {
  shellIds: ['B', 'P', 'L'],
  sceneIds: ['N', 'S2'],
  modules: ['B', 'P', 'L', 'N', 'S2'],
  pending: [], partial: false,
  shellMsgIndex: 3, f2MsgIndex: 4, msgCount: 15,
  /* 批准的两个注入开关（写死） */
  injectShell: true, injectScene: true,
  /* 旧 shell / 旧 f2 的标志性正文（退役后必须【不在】） */
  retiredMarks: ['[身份与场景]', '[角色声音]', '你不是在扮演一个角色']
};
var EXP_GROUP_OFFLINE = {
  shellIds: ['B', 'P', 'L'],
  sceneIds: ['N', 'S5'],
  /* ★ 2026-10-05 用户裁决：S5 正式接入（injectScene:true）。
     旧判据「N/S5 不进 system（部分接线核心判据）」随之退役 ——
     接入后改为正向断言：N/S5 整块各恰好 1 次。 */
  notWiredIds: [],
  modules: ['B', 'P', 'L', 'N', 'S5'],
  pending: [], partial: false,
  /* ★ 批准的两个注入开关（写死）。这一条**必须直接问决策层** ——
     只查正文的话，「生产开关被误改」可能对装配产物毫无影响（实测教训）。 */
  injectShell: true, injectScene: true
};
var EXP_PROACTIVE = {
  shellIds: ['B', 'P', 'L'], sceneIds: ['E', 'S3'],
  modules: ['B', 'P', 'L', 'E', 'S3'],
  pending: [], partial: false,
  msgCount: 2,
  /* 批准的两个注入开关（写死） */
  injectShell: true, injectScene: true,
  /* E/S3 的批准插入位：场景卡最后一段之后、[CHARACTER] 段之前 */
  insertBeforeMark: '[CHARACTER]',
  retiredMarks: ['[身份与场景]', '[角色声音]'],
  /* 场景卡协议六件套（顶掉 = 解析器空转） */
  keepMarks: ['【调用任务】', '【候选判断】', '【输出结构】',
    '{"decision":"send|skip|defer|blocked"', '[TRIGGER_CANDIDATES]'],
  /* —— f493aca 世界书补齐批 + K03 关系记忆批 批准新增块（GO_* 同源口径）——
     buildSystem 在 recall 之后依次追加 compileWorldbook(charId, matchText) /
     compileRelation(charId, userId, 0)；两块从**生产编译器现算**（不抄重捕输出）。
     夹具四项哨兵随之翻转（写死批准值；用户 WeChat 名与【记忆】头随关系块进装配）。 */
  approvedBlocks: ['worldbook', 'relation'],
  approvedSentinels: { worldbook: true, userWechat: true, memory: true,
    'probe.memoryHead': true }
};

/* 直接问决策层：「批准的两个注入开关」当前是什么。
   ★ 与写死的 EXP_* 期望比对 —— 生产误改开关时这里立刻红。
     问的是 btDecideScene 的**返回值**（它带 injectShell / injectScene 字段），
     不是去读 BT_SPECS 常量源码（读源码会跟着生产一起变，等于没断言）。 */
function assertInjected(sceneKey, wantShell, wantScene, what) {
  var d = PROBE.S.promptEngine.btDecideScene(sceneKey);
  assert(d, what + '：btDecideScene(' + sceneKey + ') 返回 null');
  eq([d.injectShell, d.injectScene], [wantShell, wantScene],
    what + '：' + sceneKey + ' 的两个注入开关应恰为 [' + wantShell + ', ' + wantScene + ']');
  return d;
}

/* 定位 v1 里的旧外壳区间：三个条件全成立才返回偏移，否则红。
   ★ 不猜、不按段数切、不做任何空白清洗。 */
function locateRetiredShell(sys, what) {
  var card = PROBE.S.promptEngine.cardBody('shell');
  assert(card && card.length, what + '：生产 cardBody(\'shell\') 为空');
  eq(occurrencesOf(sys, card), 1,
    what + '：旧外壳卡正文应**恰好**命中 1 次（实得 ' + occurrencesOf(sys, card) + '）');
  var at = sys.indexOf(card);
  var sep = sys.slice(at + card.length, at + card.length + GO_SEP.length);
  assert(sep === GO_SEP,
    what + '：旧外壳之后应紧跟恰好一个装配分隔符 ' + JSON.stringify(GO_SEP) +
    '，实得 ' + JSON.stringify(sep));
  return { at: at, len: card.length, card: card };
}

/* 在 sys 的段落序列里插入一块（保持分隔符正确） */
function insertBlock(sys, block, beforeMark, what) {
  var paras = sys.split(GO_SEP);
  var idx = -1;
  paras.forEach(function (p, i) { if (idx < 0 && p.indexOf(beforeMark) === 0) idx = i; });
  assert(idx >= 0, what + '：找不到插入锚点段（首段以 ' + beforeMark + ' 开头）');
  return paras.slice(0, idx).concat([block]).concat(paras.slice(idx)).join(GO_SEP);
}


/* 数某个**整块**子串出现次数。整块比较，不是首句 ——
   「只留首句、截断后文」那种看起来接上了的骗不过它。 */
function occurrencesOf(hay, needle) {
  if (!needle) return 0;
  var n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

/* 定位一个块：必须**唯一**命中，且其后紧跟装配分隔符。
   「尾随分隔符」这一条是「按块移除」能成立的前提，不靠事后清洗兜。 */
function locateBlock(sys, block, what) {
  var n = occurrencesOf(sys, block);
  assert(n === 1, what + ' 应**恰好**出现 1 次（整块比对），实得 ' + n + ' 次');
  var at = sys.indexOf(block);
  var sep = sys.slice(at + block.length, at + block.length + GO_SEP.length);
  assert(sep === GO_SEP,
    what + ' 之后应紧跟装配分隔符 ' + JSON.stringify(GO_SEP) +
    '，实得 ' + JSON.stringify(sep));
  return at;
}

function strictGroupOnlineCase() {
  var key = 'groupOnline';
  var sys = function () { return CAPS[key].messages[0].content; };

  t('[' + key + '] 受控迁移：除 system 外每个字段与 v1 逐字一致（批准哨兵翻转除外）', function () {
    assert(CAPS[key], key + ' 没捕到');
    /* 把 messages[0].content 挖掉后，其余**每一个字段**都必须与 v1 逐字相同。
       判据卡在「除 system 外零差异」：接线若顺手改了 user 段、entities、
       budget、sentinels 或 checks，这里必红。 */
    var cur = JSON.parse(JSON.stringify(CAPS[key]));
    var v1 = JSON.parse(JSON.stringify(V1_CAPS[key]));
    cur.messages[0].content = '<SYSTEM>';
    v1.messages[0].content = '<SYSTEM>';
    /* ★ 2026-10-05 K03f 批准哨兵翻转（写死，不放宽判据）：
       群线上接入了 per-entity 世界书（个人书）与近期生活动态 →
       worldbook / moment 两个哨兵在群线上从 v1 的 false 变 true。
       其余哨兵（含 customBody「私聊专属卡不广播」）必须保持 v1 原值。 */
    v1.sentinels.worldbook = true;
    v1.sentinels.moment = true;
    eq(diffPaths(v1, cur), [],
      key + ' 除 messages[0].content 外还有差异（接线溢出了 system）：');
  });

  t('[' + key + '] 新增行为块完整、各仅一次、位置符合批准装配', function () {
    var s = sys(), shell = goShellBlock(), scene = goSceneBlock();
    var card = PROBE.S.promptEngine.cardBody('groupRound');

    /* ① 完整 + ② 各仅一次：整块（join 后的三段 / 两段）唯一命中。
       截断后文、只留首句、重复注入 —— 三种都在这里露馅。 */
    var iShell = locateBlock(s, shell, 'B/P/L 整块');
    var iScene = locateBlock(s, scene, 'E/S4 整块');

    /* ③ 位置：B/P/L 在最前（偏移 0），groupRound 卡居中，E/S4 在后。 */
    eq(iShell, 0, 'B/P/L 整块起始偏移（应为 0 = 行为纪律在最前）：');
    assert(iShell < iScene, 'B/P/L 应在 E/S4 之前（下标 ' + iShell + ' < ' + iScene + '）');
    /* groupRound 卡**完整保留**在两块之间（整块一次） */
    eq(occurrencesOf(s, card), 1, 'groupRound 卡整块出现次数（必须完整且仅一次）：');
    var iCard = s.indexOf(card);
    assert(iCard >= iShell + shell.length && iCard < iScene,
      '顺序快照：B/P/L → groupRound → E/S4（卡偏移 ' + iCard + '）');
    /* 原有群现场信息在 E/S4 之后 */
    var iTail = s.indexOf(GO_TAIL_ANCHOR);
    assert(iTail > iScene, '★ 顺序快照：E/S4 应在 ' + GO_TAIL_ANCHOR + ' 之前');
  });

  t('[' + key + '] K03f 批准块逐本体就位：语言/生活动态/个人世界书各只在本体块内', function () {
    var s = sys();

    function entitySlice(ownerId) {
      var openTag = '[ENTITY id=' + ownerId + ']';
      var i = s.indexOf(openTag);
      assert(i >= 0, '找不到 ' + openTag);
      var j = s.indexOf('[/ENTITY]', i);
      assert(j > i, ownerId + ' 的 [/ENTITY] 缺失');
      return s.slice(i, j);
    }

    /* ① 时间块（f493aca）：共享恰 1 次 */
    assert(GO_TIME && GO_TIME.length, 'GO_TIME 产出为空（生产 compileGroupTimeFacts 没吐内容？）');
    eq(occurrencesOf(s, GO_TIME), 1, '【在场时间】块出现次数：');

    GO_ENTITIES.forEach(function (oid) {
      var mine = entitySlice(oid);
      var others = GO_ENTITIES.filter(function (x) { return x !== oid; })
        .map(entitySlice).join('\n');
      /* ② 语言行：各自块内 0 或 1 次，别人的块里 0 次（逐本体归属） */
      var lang = GO_LANG[oid];
      if (lang) {
        eq(occurrencesOf(mine, lang), 1, oid + ' 块内语言行次数：');
        eq(occurrencesOf(others, lang), 0, oid + ' 的语言行不得出现在别的块：');
      }
      /* ③ 生活动态：同理（lifeFeed 逐角色过滤后各归各的块） */
      var life = GO_LIFE[oid];
      if (life) {
        eq(occurrencesOf(mine, life), 1, oid + ' 块内生活动态次数：');
        eq(occurrencesOf(others, life), 0, oid + ' 的生活动态不得出现在别的块：');
      }
      /* ③b I01（f493aca 批准块）：同理，逐本体 cognition 只归自己 */
      var i01 = GO_I01[oid];
      if (i01) {
        eq(occurrencesOf(mine, i01), 1, oid + ' 块内 I01 次数：');
        eq(occurrencesOf(others, i01), 0, oid + ' 的 I01 不得出现在别的块：');
      }
      /* ④ 个人世界书：同理（编译层按挂靠本体分流） */
      var wbMine = GO_WB[oid];
      if (wbMine) {
        eq(occurrencesOf(mine, wbMine), 1, oid + ' 块内个人世界书次数：');
        eq(occurrencesOf(others, wbMine), 0, oid + ' 的个人世界书不得出现在别的块：');
      }
    });

    /* ⑤ 不广播三连（夹具形状下必须全部缺席）：
       · 共享世界书块（夹具只有个人书）；
       · 私聊专属自定义卡（夹具卡没标 group:true）；
       · USER_CORE（owner user 成员没写 persona，compileUserCore 空串）。 */
    eq(occurrencesOf(s, '【世界书】'), 0, '共享世界书块应缺席（夹具无全局书）：');
    eq(occurrencesOf(s, CAP.S.customBody), 0, '未标记群聊可用的自定义卡不得广播：');
    eq(occurrencesOf(s, '[USER_CORE]'), 0, '夹具 owner 马甲无 persona，USER_CORE 应缺席：');
  });

  t('[' + key + '] 去掉全部批准新增块后，剩余 system 与 v1 逐字一致', function () {
    var s = sys(), shell = goShellBlock(), scene = goSceneBlock();
    var v1sys = V1_CAPS[key].messages[0].content;

    /* 先完成性与位置检查（locateBlock 已断言唯一命中 + 尾随分隔符），
       **确认可以按块移除之后**才切。 */
    var iShell = locateBlock(s, shell, 'B/P/L 整块');
    var iScene = locateBlock(s, scene, 'E/S4 整块');
    assert(iShell < iScene, '移除顺序前提：B/P/L 在 E/S4 之前');
    /* 确实移除过东西（否则下面的比对可能因没注入而空转） */
    assert(s.length > v1sys.length,
      '★ 重捕 system 应比 v1 长（接线后多了批准块），实得 ' + s.length + ' vs v1 ' + v1sys.length);

    /* ★ 移除 = 按**偏移量**切掉 v161 两处「块 + 其后分隔符」，长度由块本身决定。
       不用正则、不删所有匹配文本、不清洗空白。 */
    var rebuilt = s.slice(0, iShell)
      + s.slice(iShell + shell.length + GO_SEP.length, iScene)
      + s.slice(iScene + scene.length + GO_SEP.length);
    var cutBytes = shell.length + scene.length + 2 * GO_SEP.length;

    /* ★ 2026-10-05 起再摘 f493aca + K03f 的批准新增块（时间块 + 逐本体
       I01/语言行/生活动态/个人世界书）。块文本全部来自生产编译器现算（见 GO_*），
       每块先断言唯一命中再摘 —— 「判「某段在不在」必须先断言该段真被找到」。 */
    if (GO_TIME) {
      var rT = cutApprovedPiece(rebuilt, GO_TIME, '【在场时间】块');
      rebuilt = rT.text; cutBytes += rT.bytes;
    }
    GO_ENTITIES.forEach(function (oid) {
      [GO_LANG[oid], GO_I01[oid], GO_LIFE[oid], GO_WB[oid]].forEach(function (piece, k) {
        if (!piece) return;
        var what = oid + ' 批准块#' + k + '（语言/I01/生活动态/个人世界书）';
        var r = cutApprovedPiece(rebuilt, piece, what);
        rebuilt = r.text; cutBytes += r.bytes;
      });
    });

    /* 逐字比对；失败时报首个差异字符位置与上下文 —— 不截断、不归一。 */
    if (rebuilt !== v1sys) {
      var at = 0, n = Math.min(rebuilt.length, v1sys.length);
      while (at < n && rebuilt.charAt(at) === v1sys.charAt(at)) at++;
      throw new Error(key + ' 剩余 system 与 v1 不一致，首个差异在第 ' + at + ' 字符\n' +
        '  实际：' + JSON.stringify(rebuilt.slice(Math.max(0, at - 40), at + 60)) + '\n' +
        '  v1  ：' + JSON.stringify(v1sys.slice(Math.max(0, at - 40), at + 60)));
    }
    /* 长度守恒：原长 − 全部批准块与其分隔符 = v1 长（证明没多切也没少切） */
    eq(rebuilt.length, s.length - cutBytes,
      key + ' 剩余 system 长度（应只少批准块与其分隔符）：');
  });
}

/* ================= offline：两条消息整条替换 + tokens 独立重算 ================= */

function rebuildOffline() {
  var exp = withTalifeSlot(V1_CAPS.offline, 'offline');   /* K03e 批准槽位插入 */
  var iS = EXP_OFFLINE.shellMsgIndex, iF = EXP_OFFLINE.f2MsgIndex;
  var wantShell = goBtBlock(EXP_OFFLINE.shellIds);
  var wantScene = goBtBlock(EXP_OFFLINE.sceneIds);

  /* 替换前**槽位身份与元数据**校验（不校验就替换 = 可能在替错槽位） */
  assert(exp.messages[iS] && exp.messages[iS].content.indexOf('[身份与场景]') >= 0,
    'v1 offline messages[' + iS + '] 应是旧 shell 卡（槽位身份不符）');
  assert(exp.messages[iF] && exp.messages[iF].content.indexOf('你不是在扮演一个角色') >= 0,
    'v1 offline messages[' + iF + '] 应是旧 f2 卡（槽位身份不符）');
  ['shell', 'f2'].forEach(function (id) {
    var s = exp.slots[slotIndexById(exp.slots, id)];
    assert(s.on === true && s.required === true && s.hidden === false,
      'v1 offline 的 ' + id + ' 槽应为 on + required + 不隐藏：' + JSON.stringify(s));
  });
  /* 底稿 tokens 自检：v1 侧必须是旧正文的估算值（证明 estimate 口径没变） */
  eq(exp.slots[slotIndexById(exp.slots, 'shell')].tokens, estimateText(exp.messages[iS].content),
    'v1 offline shell 槽 tokens 应等于旧正文的估算：');
  eq(exp.slots[slotIndexById(exp.slots, 'f2')].tokens, estimateText(exp.messages[iF].content),
    'v1 offline f2 槽 tokens 应等于旧正文的估算：');

  /* 两条消息内容替换 */
  exp.messages[iS].content = wantShell;
  exp.messages[iF].content = wantScene;
  /* tokens **独立重算**（复刻生产 estimate 公式），不从当前 capture 抄 */
  exp.slots[slotIndexById(exp.slots, 'shell')].tokens = estimateText(wantShell);
  exp.slots[slotIndexById(exp.slots, 'f2')].tokens = estimateText(wantScene);

  /* 2026-10-05 七项文风批：narrative 槽文风行 = 第三处批准替换。
     重建方式：锚定【叙事设置】消息，把旧单行「- 整体风格：…」整行
     替换为新两行（风格名 + 六套正文，正文取自生产 STYLE_PRESETS ——
     与 goBtBlock 直接读 behaviorText.module 同一模式：读生产常量，不抄输出）。
     v1 夹具 narrativeSettings.style 为空 → 旧行是「纯爱日常（…）」，
     新装配回落 nature_life。 */
  var iN = narrativeMsgIndex(exp.messages);
  var narOld = exp.messages[iN].content;
  assert(/^- 整体风格：/m.test(narOld), 'v1 offline narrative 缺「- 整体风格：」行');
  var presetN = PROBE.S.promptEngine.stylePresetOf(PROBE.S.promptEngine.styleDefault);
  var narNewLine = '- 整体风格：' + presetN.label + '\n' + presetN.text;
  exp.messages[iN].content = narOld.replace(/^- 整体风格：.*$/m, narNewLine);
  assert(exp.messages[iN].content !== narOld, 'narrative 替换未生效（旧串等于新串）');
  exp.slots[slotIndexById(exp.slots, 'narrative')].tokens =
    estimateText(exp.messages[iN].content);

  /* 正文标记探针：旧外壳/旧 f2 不再出现在输出里 → 由 true 变 false。
     ★ 这三个字段检的是**输出字符串里还有没有那个标记**，
       不是「源码里那段代码还在不在」—— 命名与语义按捕获器实现（:506/:536）。 */
  eq([exp.sentinels['probe.shellHead'], exp.sentinels['probe.f2Bridge'],
    exp.checks.shellDefaultBodyInMessages], [true, true, true],
    'offline v1 底稿的三个正文标记字段必须是 true（底稿自检）：');
  exp.sentinels['probe.shellHead'] = false;
  exp.sentinels['probe.f2Bridge'] = false;
  exp.checks.shellDefaultBodyInMessages = false;
  return exp;
}

function expectedOfflineDiffSet() {
  var base = withTalifeSlot(V1_CAPS.offline, 'offline');   /* K03e 批准槽位插入 */
  return [
    'messages[' + EXP_OFFLINE.shellMsgIndex + '].content',
    'messages[' + EXP_OFFLINE.f2MsgIndex + '].content',
    'slots[' + slotIndexById(base.slots, 'shell') + '].tokens',
    'slots[' + slotIndexById(base.slots, 'f2') + '].tokens',
    /* 2026-10-05 七项文风批批准差异：narrative 槽文风行换六套正文 */
    'slots[' + slotIndexById(base.slots, 'narrative') + '].tokens',
    'messages[' + narrativeMsgIndex(base.messages) + '].content',
    'sentinels.probe.shellHead',
    'sentinels.probe.f2Bridge',
    'checks.shellDefaultBodyInMessages'
  ].sort();
}

/* offline 基线里【叙事设置】消息的下标（锚点定位，不写死）。 */
function narrativeMsgIndex(messages) {
  var hit = -1;
  (messages || []).forEach(function (m, i) {
    if (hit < 0 && m && String(m.content || '').indexOf('【叙事设置】') >= 0) hit = i;
  });
  assert(hit >= 0, 'offline 基线里找不到【叙事设置】消息');
  return hit;
}

function strictOfflineCase() {
  var key = 'offline';
  t('[' + key + '] 与 v1 的差异恰为批准的 7 条 + K03e 批准槽位插入（其余一律不变）', function () {
    assert(CAPS[key], key + ' 没捕到');
    eq(diffPaths(withTalifeSlot(V1_CAPS[key], 'offline'), CAPS[key]).sort(),
      expectedOfflineDiffSet(),
      key + ' 与 v1 的差异（逐条路径，不是只比数量）：');
  });
  t('[' + key + '] 「v1 + 两处批准替换 + tokens 重算」重建 === 实际（整条）', function () {
    eq(diffPaths(rebuildOffline(), CAPS[key]), [], key + ' 重建期望 vs 重捕实际：');
    /* 条数只证明条数不变；**历史内容不变由上面整条对象比对保障** */
    eq(CAPS[key].messages.length, EXP_OFFLINE.msgCount, key + ' messages 条数：');
  });
  t('[' + key + '] 诊断与实际正文分别检查（记账与注入一致）', function () {
    var h = PROBE;
    var r = h.S.promptEngine.assembleOffline({
      charId: ID_ONLINE.chMain, userId: ID_ONLINE.umSmall, session: PROBE.offSession
    });
    var text = r.messages.map(function (m) { return m.content; }).join(GO_SEP);
    /* 实际正文：五段整块各恰好一次 */
    EXP_OFFLINE.shellIds.concat(EXP_OFFLINE.sceneIds).forEach(function (id) {
      eq(occurrencesOf(text, h.S.behaviorText.module(id)), 1,
        key + ' 模块 ' + id + ' 整块应恰好 1 次：');
    });
    /* 旧三处标记都不在（原「线下未迁」断言反号后的退役检查，方向对调） */
    EXP_OFFLINE.retiredMarks.forEach(function (mk) {
      eq(occurrencesOf(text, mk), 0, key + ' 退役标记 ' + mk + ' 不应再出现：');
    });
    /* 诊断：写死的批准预期（不读生产 BT_SPECS） */
    assert(r.behavior !== undefined, key + ' 缺 behavior 诊断字段（未迁？）');
    eq(r.behavior.used, true, key + ' behavior.used：');
    eq(r.behavior.modules, EXP_OFFLINE.modules, key + ' 诊断 modules（写死批准预期）：');
    assert(typeof r.behavior.reason === 'string' && r.behavior.reason === '',
      key + ' 成功路径 reason 应为空串：' + JSON.stringify(r.behavior.reason));
    /* c05off 协议仍由程序槽负责（这条从原断言原样搬来，不许弱化） */
    assert(text.indexOf('【输出协议 · 硬约束】') >= 0, key + ' 的 c05off 不见了');
    /* 迁移只碰两个 system 槽。
       ★ 条数只在 **capture 记录** 上断言（那里含 3 条历史 → 15 条）；
         这里用 PROBE.offSession 直接装配是**另一个调用形状**（无 userInput，
         14 条），拿它比 15 会得到一个与迁移无关的假红。
         「历史内容不变」由上面第 2 条的**整条对象比对**保障，不靠条数。 */
    eq(CAPS[key].messages.length, EXP_OFFLINE.msgCount, key + ' capture messages 条数：');
    /* ★ 批准的两个注入开关：直接问决策层。写死期望，生产误改 → 立刻红。 */
    assertInjected(key, EXP_OFFLINE.injectShell, EXP_OFFLINE.injectScene, key);
  });
}

/* ============ groupOffline：只替换旧外壳区间，其余逐字保留 ============ */

function rebuildGroupOffline() {
  var exp = JSON.parse(JSON.stringify(V1_CAPS.groupOffline));
  var loc = locateRetiredShell(exp.system, 'groupOffline v1 system');
  /* ★ 2026-10-05 两处批准区间变更：
     ① 旧外壳区间替换为 B/P/L（v161 批原样保留）；
     ② f2 卡之后插入 N/S5 块（七项文风批 / S5 接入裁决）。
     f2 卡文本取自生产 CARD_DEFAULTS（本批未改 f2 卡），
     先断言它与 v1 system 里的 f2 卡逐字相同，再定位插入点。 */
  var f2Body = PROBE.S.promptEngine.cardBody('f2');
  var rebuiltShell = exp.system.slice(0, loc.at)
    + goBtBlock(EXP_GROUP_OFFLINE.shellIds)
    + exp.system.slice(loc.at + loc.len);
  var f2At = rebuiltShell.indexOf(f2Body);
  assert(f2At >= 0, 'groupOffline 重建：v1 system 里找不到 f2 卡');
  assert(rebuiltShell.indexOf(f2Body, f2At + 1) < 0, 'groupOffline 重建：f2 卡不唯一');
  var f2End = f2At + f2Body.length;
  exp.system = rebuiltShell.slice(0, f2End)
    + GO_SEP + goBtBlock(EXP_GROUP_OFFLINE.sceneIds)
    + rebuiltShell.slice(f2End);
  /* ③ [PRESENCE RULES] 文风行：v1 夹具 narrativeSettings={} 时旧实现
     （styleHintOf）整行省略；新实现按「无有效设置兜底自然生活」**必出**该行。
     锚点 = 'user 的行动已经给出：' 行（文风行紧跟其后），在该行行尾插入。 */
  var styleLineAnchor = 'user 的行动已经给出：';
  var aIdx = exp.system.indexOf(styleLineAnchor);
  assert(aIdx >= 0, 'groupOffline 重建：找不到 [PRESENCE RULES] 文风锚点');
  var aEnd = exp.system.indexOf('\n', aIdx);
  if (aEnd < 0) aEnd = exp.system.length;
  var spG = PROBE.S.promptEngine.stylePresetOf(PROBE.S.promptEngine.styleDefault);
  var styleLine = '文风：' + spG.label + '\n' + spG.text;
  exp.system = exp.system.slice(0, aEnd) + '\n' + styleLine + exp.system.slice(aEnd);
  exp.sentinels['probe.shellHead'] = false;
  return exp;
}

function strictGroupOfflineCase() {
  var key = 'groupOffline';
  t('[' + key + '] 与 v1 的差异恰为批准的 2 条（system + 正文标记）', function () {
    assert(CAPS[key], key + ' 没捕到');
    eq(diffPaths(V1_CAPS[key], CAPS[key]).sort(),
      ['sentinels.probe.shellHead', 'system'],
      key + ' 与 v1 的差异（逐条路径）：');
  });
  t('[' + key + '] 「v1 + 旧外壳区间替换为 B/P/L」重建 === 实际（其余逐字保留）', function () {
    eq(diffPaths(rebuildGroupOffline(), CAPS[key]), [], key + ' 重建期望 vs 重捕实际：');
    /* messages 仍为 null（只有 system 字段）—— 结构未变 */
    eq(CAPS[key].messages, null, key + ' messages 应仍为 null：');
  });
  t('[' + key + '] 部分接线：B/P/L 已接、N/S5 未接，诊断须如实记账', function () {
    var h = boot({});
    var core = h.S.core, sb = core.listSandboxes()[0];
    var ch = core.upsertChar({ id: '__mig_go__', kind: 'main', name: '乙',
      content: '群里的另一个人。', sandboxId: sb && sb.id });
    /* ★ 夹具带一个常驻国外的角色：[LANGUAGES] 是**条件块**
       （page-group-offline.js:249-265 —— 只有 langOfChar 不同语言的角色在场才注入）。
       不放这个角色 → 该块不出现 → 「现场协议原样保留」就少了这一段没验到。
     ★ 两个字段陷阱（都踩过）：
       - 地区写在**日历配置**里（`calendar.cfgOf` + `saveCfg`），
         `upsertChar({region:'JP'})` 会被**静默忽略**（它不拷贝该字段）；
       - 在场名单读的是 `s.participants`（每项 `{present, away}`），
         **不是** `s.parts` / `inScene`。 */
    var jp = core.upsertChar({ id: '__mig_go_jp__', kind: 'sub', parentId: ch.id,
      name: 'Yuki', content: '东京来的编辑。', sandboxId: sb && sb.id });
    var cal = h.S.calendar, c = cal.cfgOf(jp.id);
    c.region = 'JP'; c.city = '东京'; c.timezone = 'Asia/Tokyo';
    cal.saveCfg(jp.id, c);
    var sess = { id: '__mig_go_sess__', groupId: '__mig_g__', ownerId: ch.id,
      env: { location: '旧书店', timeOfDay: '下午', weather: '晴', clockTime: '15:04' },
      purpose: '等人', inherit: false,
      participants: [
        { ownerId: ch.id, kind: 'char', npc: false, present: true, away: false },
        { ownerId: jp.id, kind: 'char', npc: false, present: true, away: false }
      ],
      narrativeSettings: {} };
    var txt = h.S.groupOfflineStore.buildSystem(sess);
    var note = h.S.groupOfflineStore.behaviorNote();
    /* 已接：五段整块各恰好一次（2026-10-05 起含 N/S5） */
    EXP_GROUP_OFFLINE.shellIds.concat(EXP_GROUP_OFFLINE.sceneIds).forEach(function (id) {
      eq(occurrencesOf(txt, h.S.behaviorText.module(id)), 1,
        key + ' 模块 ' + id + ' 整块应恰好 1 次：');
    });
    /* 退役检查保留：notWiredIds 现为空集（S5 已接入），循环自然空转；
       若未来再出现 pending 模块，把它加回 EXP_GROUP_OFFLINE.notWiredIds 即可。 */
    EXP_GROUP_OFFLINE.notWiredIds.forEach(function (id) {
      eq(occurrencesOf(txt, h.S.behaviorText.module(id)), 0,
        key + ' 模块 ' + id + ' 是 pending，不应出现在 system：');
    });
    /* 旧外壳退役 + 现场协议原样。
       ★ 协议段清单**取自 v1 system 里实际存在的段首**，不写死「七块全在」——
         [LANGUAGES] 是**条件块**（只在在场有外文角色时注入，
         page-group-offline.js:249/265），本夹具只有一个中文角色，
         写死会让断言换一个夹具就假红。基准 = v1 = 事实。 */
    ['[身份与场景]', '[角色声音]'].forEach(function (mk) {
      eq(occurrencesOf(txt, mk), 0, key + ' 退役标记 ' + mk + ' 不应再出现：');
    });
    /* v1 里存在的协议段，逐段要求仍在（v1 没有的条件块自动跳过） */
    var v1sys = V1_CAPS.groupOffline.system;
    var PROTO_MARKS = ['[SCENE]', '[PARTICIPANTS]', '[LANGUAGES]', '[PRESENCE RULES]',
      '[OUTPUT]', '[WRITING]', '"type":"aside"', '"type":"silent"'];
    var checked = 0;
    PROTO_MARKS.forEach(function (mk) {
      if (v1sys.indexOf(mk) < 0) return;          /* v1 没有 → 条件块，跳过 */
      assert(txt.indexOf(mk) >= 0, key + ' 现场/协议段缺失：' + mk);
      checked++;
    });
    assert(checked >= 4, key + '：实际核对的协议段太少（' + checked + '），夹具可能不对');
    /* ★ 「尾部逐字保留」这条**只在 v1 那一次重捕上验**（见 strictGroupOfflineCase
       第 2 条断言：整条 diffPaths 零差异）。这里用的是**另一个夹具**
       （自己的 __mig_go__ 角色与 core.activeUser()），尾部段里含角色名 /
       user 现场身份名 / 篇幅目标等**夹具相关文本**，逐字比对必然不等 ——
       那是夹具差异，不是迁移差异，不该在这里断言。 */
    /* 诊断：写死批准预期 + 必须记 partial */
    eq(note.modules, EXP_GROUP_OFFLINE.modules, key + ' 诊断 modules（写死批准预期）：');
    eq(note.pendingModules, EXP_GROUP_OFFLINE.pending, key + ' 诊断 pendingModules：');
    eq(note.partial, EXP_GROUP_OFFLINE.partial, key + ' 诊断 partial：');
    eq(note.sceneSkippedByOverride, false, key + ' 这是接线缺口，不是 override 跳过：');
    /* ★ 批准的两个注入开关：直接问决策层（负向 N6 证明只查正文抓不到开关被改）。 */
    assertInjected(key, EXP_GROUP_OFFLINE.injectShell, EXP_GROUP_OFFLINE.injectScene, key);
  });
}

/* ============ proactive：替换旧外壳 + 插入 E/S3 + 追加批准新增块 ============ */

/* f493aca/K03 批准差异清单（写死，与 offline 的 expectedOfflineDiffSet 同一口径）：
   messages[0]（壳替换 + E/S3 插入 + 两批准块追加）、旧壳头标记退役、
   世界书 / 记忆 / 微信名 / 【记忆】头 四哨兵翻转。不反推自实际捕获。 */
function expectedProactiveDiffSet() {
  return [
    'messages[0].content',
    'sentinels.probe.shellHead',
    'sentinels.worldbook',
    'sentinels.userWechat',
    'sentinels.memory',
    'sentinels.probe.memoryHead'
  ].sort();
}

function rebuildProactive() {
  var exp = JSON.parse(JSON.stringify(V1_CAPS.proactive));
  var loc = locateRetiredShell(exp.messages[0].content, 'proactive v1 messages[0]');
  var replaced = exp.messages[0].content.slice(0, loc.at)
    + goBtBlock(EXP_PROACTIVE.shellIds)
    + exp.messages[0].content.slice(loc.at + loc.len);
  /* 再在批准位置（场景卡之后、第一个 [CHARACTER] 段之前）**插入** E/S3。
     ★ 不是「删掉 E/S3 后等于 v1」—— 那个判据在这里恒不成立。 */
  var withScene = insertBlock(replaced, goBtBlock(EXP_PROACTIVE.sceneIds),
    EXP_PROACTIVE.insertBeforeMark, 'proactive v1 messages[0]');
  /* —— 批准新增块（GO_* 同源：生产编译器现算，先断言哨兵正文命中）——
     evaluate 的装配顺序在 recall 之后追加 worldbook → relation，
     装配分隔符 GO_SEP。matchText 按生产 evaluate 的口径现算：
     夹具会话最近 6 条 content join('\n')。 */
  var PE = PROBE.S.promptEngine;
  var chat = (PROBE.S.chatStore && PROBE.S.chatStore.chatOf)
    ? PROBE.S.chatStore.chatOf(ID_ONLINE.chMain) : null;
  var matchText = ((chat && chat.messages) || []).slice(-6).map(function (m) {
    return String(m.content || '');
  }).join('\n');
  var wb = EXP_PROACTIVE.approvedBlocks.indexOf('worldbook') >= 0
    ? (PE.compileWorldbook ? (PE.compileWorldbook(ID_ONLINE.chMain, matchText) || '') : '')
    : '';
  var rel = EXP_PROACTIVE.approvedBlocks.indexOf('relation') >= 0
    ? (PE.compileRelation ? (PE.compileRelation(ID_ONLINE.chMain,
        (chat && chat.userId) || null, 0) || '') : '')
    : '';
  assert(wb && wb.indexOf(S_ONLINE.worldbook) >= 0,
    'proactive 批准块现算：世界书块没产出或缺哨兵正文（生产编译器变了？）');
  assert(rel && rel.indexOf(S_ONLINE.memory) >= 0 && rel.indexOf(S_ONLINE.userWechat) >= 0,
    'proactive 批准块现算：关系记忆块没产出或缺哨兵正文');
  exp.messages[0].content = withScene + GO_SEP + wb + GO_SEP + rel;
  exp.sentinels['probe.shellHead'] = false;   /* 旧壳头标记随替换退役（既有批准） */
  Object.keys(EXP_PROACTIVE.approvedSentinels).forEach(function (k) {
    exp.sentinels[k] = EXP_PROACTIVE.approvedSentinels[k];
  });
  return exp;
}

function strictProactiveCase() {
  var key = 'proactive';
  t('[' + key + '] 与 v1 的差异恰为批准的 6 条（messages[0] + 旧壳标记退役 + f493aca/K03 四哨兵翻转）', function () {
    assert(CAPS[key], key + ' 没捕到');
    eq(diffPaths(V1_CAPS[key], CAPS[key]).sort(),
      expectedProactiveDiffSet(),
      key + ' 与 v1 的差异（逐条路径）：');
  });
  t('[' + key + '] 「v1 + 旧外壳替换 + E/S3 插入 + 批准新增块现算拼接」重建 === 实际', function () {
    eq(diffPaths(rebuildProactive(), CAPS[key]), [], key + ' 重建期望 vs 重捕实际：');
    eq(CAPS[key].messages.length, EXP_PROACTIVE.msgCount, key + ' messages 条数：');
  });
  t('[' + key + '] B/P/L/E/S3 完整各一次，旧外壳退役，卡片协议六件套保留', function () {
    /* 用隔离 boot 取**实际装配产物**（不是读 capture 的存档字符串） */
    var h = boot({});
    var core = h.S.core, sb = core.listSandboxes()[0];
    var ch = core.upsertChar({ id: '__mig_pa__', kind: 'main', name: '甲',
      content: '旧书店老板，话少。', sandboxId: sb && sb.id });
    var u = core.activeUser();
    var txt = h.S.proactiveEngine.buildSystem(ch.id, u && u.id).join(GO_SEP);
    var note = h.S.proactiveEngine.behaviorNote();

    EXP_PROACTIVE.shellIds.concat(EXP_PROACTIVE.sceneIds).forEach(function (id) {
      eq(occurrencesOf(txt, h.S.behaviorText.module(id)), 1,
        key + ' 模块 ' + id + ' 整块应恰好 1 次：');
    });
    EXP_PROACTIVE.retiredMarks.forEach(function (mk) {
      eq(occurrencesOf(txt, mk), 0, key + ' 退役标记 ' + mk + ' 不应再出现：');
    });
    EXP_PROACTIVE.keepMarks.forEach(function (mk) {
      assert(txt.indexOf(mk) >= 0, key + ' 场景卡协议段缺失：' + mk);
    });
    eq(note.modules, EXP_PROACTIVE.modules, key + ' 诊断 modules（写死批准预期）：');
    eq(note.pendingModules, EXP_PROACTIVE.pending, key + ' 诊断 pendingModules：');
    eq(note.partial, EXP_PROACTIVE.partial, key + ' 诊断 partial：');
    /* ★ 批准的两个注入开关：直接问决策层 */
    assertInjected(key, EXP_PROACTIVE.injectShell, EXP_PROACTIVE.injectScene, key);
  });
}

/* ============================================================
   10. 负向对照：证明上面的比较不是空转
   ============================================================ */
function mutateCopy(rec) { return JSON.parse(JSON.stringify(rec)); }

/* ============================================================
   汇总
   ============================================================ */
function finish() {
  head('证据摘要');
  process.stdout.write('  v1 基线（只读）  ' + V1 + '\n');
  process.stdout.write('  v1 指纹          ' + V1_SHA.slice(0, 32) + '…\n');
  process.stdout.write('  新 c05 字节      ' + Buffer.byteLength(NEW_C05 || '', 'utf8') + '\n');
  process.stdout.write('  新 shell 字节    ' + (NEW ? Buffer.byteLength(String(
    NEW.messages[locate(NEW.messages, ANCHOR_NEW.shell, 'x')].content), 'utf8') : 0) + '\n');
  process.stdout.write('  新 f1 字节       ' + (NEW ? Buffer.byteLength(String(
    NEW.messages[locate(NEW.messages, ANCHOR_NEW.f1, 'x')].content), 'utf8') : 0) + '\n');
  process.stdout.write('  重捕用例         ' + (ONLINE_CASES.length + OTHER_CASES.length) +
    ' 个（线上 4 = 整条重建比对；其他 5 = 逐字段一致）\n');
  process.stdout.write('  重捕边界         装配边界（proactive 为传输边界）；调用方尾部未覆盖\n');
  process.stdout.write('\n小手机 · 私聊线上行为迁移测试\n\n');
  if (fail) {
    process.stdout.write('  ' + fail + ' 项未通过：\n');
    problems.forEach(function (p) { process.stdout.write('    - ' + p + '\n'); });
    process.stdout.write('\n');
    process.exit(1);
  }
  process.stdout.write('  ' + pass + ' 项通过\n');
  process.stdout.write('  范围：装配边界；调用方尾部 / 端到端仍未覆盖\n\n');
  process.exit(0);
}

head('重捕比对（隔离沙箱，逐用例独立）');
CAP.runAll().then(function (run) {
  CAPDOC = CAP.buildDocument(run);
  CAPS = CAPDOC.captures;

  t('estimate 复刻自证：旧卡正文 → 基线 tokens（shell 945 / f1 4323 / c05 402 / pat 58）', function () {
    var pe = PROBE.S.promptEngine;
    var want = { shell: 945, f1: 4323, c05: 402, pat: 58 };
    Object.keys(want).forEach(function (id) {
      eq(estimateText(pe.cardBody(id)), want[id], id + ' 的 estimate：');
      eq(V1_CAPS.online.slots[slotIndexById(V1_CAPS.online.slots, id)].tokens, want[id],
        'v1 基线里 ' + id + ' 槽的 tokens：');
    });
  });

  ONLINE_CASES.forEach(strictOnlineCase);
  OTHER_CASES.forEach(strictOtherCase);
  strictGroupOnlineCase();
  /* 三个已迁场景：显式调用各自的受控迁移检查 */
  strictOfflineCase();
  strictGroupOfflineCase();
  strictProactiveCase();

  t('各场景 capture scope 与边界与基线一致（不扩大为端到端）', function () {
    eq([CAPS.proactive.scope, CAPS.proactive.transportCalls], ['transport', 1], 'proactive：');
    eq(CAPS.proactive.checks.recorderCalled, true, 'proactive 记录器被调用：');
    ['offline', 'offlineOverrideEmpty', 'groupOnline'].forEach(function (k) {
      eq([CAPS[k].scope, CAPS[k].transportCalls], ['assembly', 0], k + '：');
    });
    ONLINE_CASES.forEach(function (k) {
      eq([CAPS[k].scope, CAPS[k].transportCalls], ['assembly', 0], k + '：');
    });
    eq(CAPS.groupOnline.checks.requestPassedRecorder, false, 'groupOnline 未过记录器：');
    eq(CAPS.groupOnline.entities.length, V1_CAPS.groupOnline.entities.length, 'entities 条数：');
    eq(CAPS.groupOffline.messages, null, 'groupOffline 只有 system：');
    eq(typeof CAPS.groupOffline.system, 'string', 'groupOffline system 类型：');
    /* ★ 原先这里还有一条 `eq(CAPS.groupOffline.system, V1_CAPS.groupOffline.system, …)`，
       已由 strictGroupOfflineCase() 接管（见该函数第 2 条断言：
       「v1 + 旧外壳区间替换为 B/P/L」重建 === 实际）。
       刻意**不在这里再比一次正文** —— 两处各自比会各自漂移。
       上方 scope / transportCalls / entities / recorderCalled 等边界断言全部原样保留。 */
  });

  t('正文标记探针按「旧外壳是否仍出现在输出里」判定（与请求正文证据分开）', function () {
    /* 线上四例：已迁 → 旧外壳标记不再出现，探针为 false（原断言原样保留） */
    ONLINE_CASES.forEach(function (k) {
      eq(CAPS[k].sentinels['probe.shellHead'], false, k + ' probe.shellHead：');
      eq(CAPS[k].sentinels['probe.f1Check'], false, k + ' probe.f1Check：');
      eq(CAPS[k].checks.shellDefaultBodyInMessages, false, k + ' shellDefaultBodyInMessages：');
    });
    /* ★ 这三个场景也已迁 → 标记同样应为 false。方向反转，不是「放宽」。
       ★ 命名更正：这三个字段检的是**输出字符串里还有没有那个标记**
         （behavior-baseline-capture.js:506/:536 用 `text.indexOf(P.shellHead) >= 0`），
         **不是**「源码里那段代码还在不在」—— 之前写成「源码路径探针」是错的。
       ★ 底稿自检：v1 侧必须是 true。这只证明**基线**记录的是 true，
         **不**证明当前捕获器实现未变（那要看 :506/:536 源码，本批未改它）。 */
    ['offline', 'groupOffline', 'proactive'].forEach(function (k) {
      eq(CAPS[k].sentinels['probe.shellHead'], false, k + ' probe.shellHead（旧外壳标记应不再出现）：');
    });
    eq(CAPS.offline.sentinels['probe.f2Bridge'], false, 'offline probe.f2Bridge（旧 f2 标记应不再出现）：');
    eq(CAPS.offline.checks.shellDefaultBodyInMessages, false, 'offline shellDefaultBodyInMessages：');
    /* 底稿自检：v1 侧为 true（证明与基线的差异方向正确） */
    eq([V1_CAPS.offline.sentinels['probe.shellHead'], V1_CAPS.offline.sentinels['probe.f2Bridge'],
      V1_CAPS.offline.checks.shellDefaultBodyInMessages], [true, true, true],
      'v1 底稿的三个正文标记字段必须是 true（底稿自检）：');
    /* 「没这个探针」两条原样保留 */
    eq(CAPS.offline.sentinels['probe.f1Check'], undefined, 'offline 没这个探针：');
    eq(CAPS.groupOffline.sentinels['probe.f1Check'], undefined, 'groupOffline 没这个探针：');
  });

  t('正文标记探针的阳性对照：探针本身必须真的在检输出（防「换成无效标记」空转）', function () {
    /* ★ 上一条断言在「捕获器把 shellHead 换成不存在的标记」时**仍然全绿**
       （实测：负向 N7 只被 fixture 那条抓到，探针断言自己毫无反应）。
       原因：那些断言只检查「探针为 false」，而一个**永远找不到**的标记
       也同样是 false —— 判据对「探针失效」完全不敏感。
       这里补阳性对照：拿**确实含该标记的 v1 原文**过一遍判定，要求必须 true。
       探针一旦被换成无效标记，这条立刻红。 */
    var P_MARK = '[身份与场景]';
    /* ① 阳性：含标记的 v1 原文必须判为 true */
    assert(String(V1_CAPS.offline.messages[3].content).indexOf(P_MARK) >= 0,
      '阳性对照前置：v1 offline messages[3] 应含 ' + P_MARK);
    /* ② 阴性：当前 offline（已迁）必须判为 false */
    eq(CAPS.offline.messages.some(function (m) {
      return String(m.content).indexOf(P_MARK) >= 0;
    }), false, '阴性对照：当前 offline（已迁）不应含 ' + P_MARK);
    /* ③ 探针常量本身没被换掉 —— 直接比对捕获器导出的探针表。
       ★ 这一条才是真正抓 N7 的：把 shellHead 换成 '__不存在的标记__' 时，
       上面 ①② 仍会「通过」（一个找不到的标记也报 false），只有这条会红。 */
    assert(CAP.P && typeof CAP.P.shellHead === 'string',
      '捕获器未导出探针表 P（无法做阳性对照）');
    eq(CAP.P.shellHead, P_MARK,
      '捕获器的 shellHead 探针字面量应仍是 ' + P_MARK + '，实得 ' +
      JSON.stringify(CAP.P.shellHead) + '（探针被换成无效标记会导致探针空转）');
    assert(CAP.PROBE_PLAN && CAP.PROBE_PLAN.offline.indexOf('shellHead') >= 0,
      'offline 探针计划里应仍含 shellHead（防探针被删掉）');
  });

  t('夹具与 gaps 与 v1 基线一致（没为了迎合测试改捕获器）', function () {
    var exp = CAP.comparedPart(V1DOC), act = CAP.comparedPart(CAPDOC);
    eq(act.fixture, exp.fixture, 'fixture：');
    eq(act.gaps, exp.gaps, 'gaps：');
  });

  t('indexHtmlOrder：旧列表 + 历批/本批批准插入 === 当前完整列表', function () {
    var old = V1DOC.env.indexHtmlOrder;
    eq(old.indexOf('behavior-text.js'), -1, '旧列表里不该有 behavior-text.js：');
    /* 批准插入（按锚点，从列表尾往头插避免下标漂）：
       behavior-text 批 → prompt-engine 前；
       msgcenter/mcp（历史批，漏回写本期望，2026-10-07 收口）→ app.js 后 / api.js 后；
       guide + forum 系四件（本批）→ page-stickers 后。 */
    var exp = old.slice();
    var at = exp.indexOf('prompt-engine.js');
    exp.splice(at, 0, 'behavior-text.js');
    var iApp = exp.indexOf('app.js');
    exp.splice(iApp + 1, 0, 'msgcenter.js');
    var iApi = exp.indexOf('api.js');
    exp.splice(iApi + 1, 0, 'mcp.js');
    var iStk = exp.indexOf('page-stickers.js');
    exp.splice(iStk + 1, 0, 'page-guide.js',
      'forum-core.js', 'forum-gen.js', 'forum-share.js', 'page-qunsheng.js');
    eq(CAPDOC.env.indexHtmlOrder, exp, '重捕环境的 indexHtmlOrder：');
    eq(H.ORDER, exp, 'harness 解析的 ORDER：');
    eq(CAPDOC.env.scriptCount, exp.length, 'scriptCount：');
    var refs = [], re = /<script\s+src="([^"]+)"/g, m;
    var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    while ((m = re.exec(html))) refs.push(m[1]);
    eq(refs, exp, 'index.html 的脚本列表：');
    eq(refs.filter(function (r) { return r === 'behavior-text.js'; }).length, 1, '新脚本次数：');
    assert(exp.indexOf('behavior-text.js') < exp.indexOf('prompt-engine.js'), '位置：');
    assert(exp.indexOf('behavior-text.js') < exp.indexOf('page-chat-settings.js'), '早于点火：');
  });

  t('本地装配（第 1 节）与重捕的 online messages 完全一致（两路互证）', function () {
    eq(diffPaths(NEW.messages, CAPS.online.messages), [], '两路捕获的 messages：');
  });

  head('负向对照：补强不是空转');

  t('篡改一条不允许变化的历史消息 → 拒绝（且只报这一处）', function () {
    var got = mutateCopy(CAPS.online);
    var i = uniqueIndexOf(got.messages, S_ONLINE.histUser1, '夹具历史 user 句');
    got.messages[i].content = '夹具·被篡改的历史消息';
    var d = diffPaths(rebuildOnline('online'), got);
    assert(d.indexOf('messages[' + i + '].content') >= 0,
      '没报出被篡改的历史消息，差异 = ' + JSON.stringify(d));
    eq(d, ['messages[' + i + '].content'], '差异集合：');
  });

  t('篡改未迁移场景（groupOffline）的 system → 拒绝', function () {
    var got = mutateCopy(CAPS.groupOffline);
    got.system = String(got.system) + '\n夹具·偷偷多出来的一行';
    var d = diffPaths(V1_CAPS.groupOffline, got);
    assert(d.indexOf('system') >= 0, '没报出 system 被改，差异 = ' + JSON.stringify(d));
  });

  t('篡改未迁移场景（offline）的一条 messages → 拒绝', function () {
    var got = mutateCopy(CAPS.offline);
    got.messages[0].content = '夹具·篡改 offline 首条';
    var d = diffPaths(V1_CAPS.offline, got);
    assert(d.indexOf('messages[0].content') >= 0, '没报出，差异 = ' + JSON.stringify(d));
  });

  t('篡改一个不该变化的槽 tokens（pat）→ 拒绝', function () {
    var got = mutateCopy(CAPS.onlineDisabledPat);
    var i = slotIndexById(got.slots, 'pat');
    got.slots[i].tokens = got.slots[i].tokens + 1;
    var d = diffPaths(rebuildOnline('onlineDisabledPat'), got);
    assert(d.indexOf('slots[' + i + '].tokens') >= 0,
      '没报出 pat 槽 tokens 被改，差异 = ' + JSON.stringify(d));
  });

  t('负向对照之后：正式捕获与 v1 基线指纹仍未变', function () {
    eq(H.sha256(fs.readFileSync(V1, 'utf8')), V1_SHA, 'v1 基线指纹：');
    eq(CAPDOC.captures.online.messages.length, V1_CAPS.online.messages.length + 2, '重捕记录条数（基线 20 + 常开卡 msgrecall/htmlgame）：');
  });

  finish();
}).catch(function (e) {
  bad('重捕/比对阶段抛错 -> ' + ((e && e.message) || e));
  finish();
});
