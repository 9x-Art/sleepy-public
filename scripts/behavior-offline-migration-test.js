#!/usr/bin/env node
/* ============================================================
   scripts/behavior-offline-migration-test.js
   —— F2 批「私聊线下行为迁移 + 最小实际请求诊断」的独立回归测试

   跑法：node scripts/behavior-offline-migration-test.js

   ★ 不接生产、不调模型、不发网络请求、不读真实用户数据、不读真实聊天。
     全部用夹具（虚构角色/虚构会话/虚构 override）+ 内存 transport stub。
   ★ 不改冻结正文、不改 CARD_DEFAULTS、不动 v1 基线（**只读引用**）。
   ★ 本脚本证明的是**结构**：装配路径、回退语义、诊断来源与并发守卫。
     **不证明模型效果** —— 行为文本的效果必须真机单独验收。

   ---- 与线上那份测试的分工 ----
   scripts/behavior-online-migration-test.js 验线上（shell/f1/c05）。
   本脚本验线下（shell/f2），并**额外**断言：
     · 线上专属的 f1 / c05 override **不得**让线下回退；
     · 线上装配结果不受本批影响（回归）。
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var H = require('./harness.js');
var CAP = require('./behavior-baseline-capture.js');

var ROOT = H.ROOT;
var V1 = CAP.BASELINE;                        /* 只读引用，绝不写 */
var V1_SHA = H.sha256(fs.readFileSync(V1, 'utf8'));

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

var S = CAP.S, P = CAP.P, ID = CAP.ID;

/* ============================================================
   1. 夹具
   ============================================================ */
function boot(opts) {
  var h = H.boot('off:' + Math.random().toString(36).slice(2, 8));
  CAP.buildFixture(h, opts || {});
  return h;
}
function offCtx(h) {
  return {
    charId: ID.chMain, userId: ID.umSmall,
    session: h.offSession, userInput: S.histUser2
  };
}
function assemble(h) { return h.S.promptEngine.assembleOffline(offCtx(h)); }

function texts(r) {
  return r.messages.filter(function (m) { return m.role === 'system'; })
    .map(function (m) { return m.content; });
}
function findText(r, needle) {
  for (var i = 0; i < r.messages.length; i++) {
    if (r.messages[i].role === 'system' &&
        String(r.messages[i].content).indexOf(needle) >= 0) return r.messages[i].content;
  }
  return null;
}
function countIn(r, needle) {
  var n = 0;
  for (var i = 0; i < r.messages.length; i++) {
    if (r.messages[i].role !== 'system') continue;
    if (String(r.messages[i].content).indexOf(needle) >= 0) n++;
  }
  return n;
}
function slotOn(r, id) {
  for (var i = 0; i < r.slots.length; i++) if (r.slots[i].id === id) return r.slots[i].on;
  return null;
}
function slotText(r, id) {
  /* slots 与 messages 顺序一一对应（on 且有正文才 push）——
     这里按 slot 顺序数出前面有多少个 on 的槽来定位。 */
  var idx = -1, seen = 0;
  for (var i = 0; i < r.slots.length; i++) {
    if (!r.slots[i].on) continue;
    if (r.slots[i].id === id) { idx = seen; break; }
    seen++;
  }
  if (idx < 0) return null;
  var sys = r.messages.filter(function (m) { return m.role === 'system'; });
  return sys[idx] ? sys[idx].content : null;
}

/* 冻结模块正文（逐字取，不另写一份） */
var MOD = H.boot('bt').S.behaviorText;
var B_BODY = MOD.module('B'), P_BODY = MOD.module('P'), L_BODY = MOD.module('L');
var N_BODY = MOD.module('N'), S2_BODY = MOD.module('S2');

head('0. 前置');
t('冻结模块 B/P/L/N/S2 齐全（缺一即停）', function () {
  ['B', 'P', 'L', 'N', 'S2'].forEach(function (id) {
    var b = MOD.module(id);
    assert(typeof b === 'string' && b.trim(), '模块 ' + id + ' 正文缺失或空白');
  });
  eq(MOD.VERSION, 'sleepy-behavior-v1-review-01', '冻结版本：');
  eq(MOD.planOf('offline'), ['B', 'P', 'L', 'N', 'S2'], 'offline 计划：');
});

/* ============================================================
   1. 默认路径：五段各一次，无旧卡混入
   ============================================================ */
head('1. 默认路径（私聊线下 B/P/L/N/S2）');

t('behavior.used === true，reason 为空串，modules 恰为五段且各一次', function () {
  var h = boot({});
  var r = assemble(h);
  eq(r.behavior.used, true, 'used：');
  eq(r.behavior.reason, '', 'reason：');
  eq(r.behavior.modules, ['B', 'P', 'L', 'N', 'S2'], 'modules：');
  eq(r.behavior.touched, false, 'touched：');
  eq(r.behavior.VERSION, 'sleepy-behavior-v1-review-01', 'VERSION：');
});

t('shell 槽正文 = B+P+L（逐字，按契约顺序）', function () {
  var h = boot({});
  var got = slotText(assemble(h), 'shell');
  eq(got, [B_BODY, P_BODY, L_BODY].join('\n\n'), 'shell 正文：');
});

t('f2 槽正文 = N+S2（逐字）', function () {
  var h = boot({});
  var got = slotText(assemble(h), 'f2');
  eq(got, [N_BODY, S2_BODY].join('\n\n'), 'f2 正文：');
});

t('五段各出现一次（同一 system 段内计数）', function () {
  var h = boot({});
  var all = texts(assemble(h)).join('\n@@@\n');
  [B_BODY, P_BODY, L_BODY, N_BODY, S2_BODY].forEach(function (b) {
    eq(countOcc(all, b), 1, '段出现次数：');
  });
});
function countOcc(hay, needle) {
  var n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

t('完整旧 shell 正文**没有**混进 messages', function () {
  var h = boot({});
  var r = assemble(h);
  var oldShell = h.S.promptEngine.cardBody('shell');
  assert(oldShell && oldShell.length > 40, '拿不到旧 shell 正文做对照');
  /* 旧正文首节 [身份与场景] 是新正文里没有的 */
  eq(findText(r, '[身份与场景]'), null, '旧 shell 首节混入：');
  eq(findText(r, '[主动与节制]'), null, '旧 shell [主动与节制] 混入：');
  eq(countOcc(texts(r).join('\n'), oldShell), 0, '完整旧 shell 混入：');
});

t('完整旧 F2 正文**没有**混进 messages', function () {
  var h = boot({});
  var r = assemble(h);
  var oldF2 = h.S.promptEngine.cardBody('f2');
  assert(oldF2 && oldF2.length > 40, '拿不到旧 F2 正文做对照');
  eq(findText(r, '你不是在扮演一个角色'), null, '旧 F2 开场混入：');
  eq(findText(r, '【Deep Talk】'), null, '旧 F2【Deep Talk】混入：');
  eq(countOcc(texts(r).join('\n'), oldF2), 0, '完整旧 F2 混入：');
});

t('旧行为黑名单**没有**被搬进新路径', function () {
  var h = boot({});
  var all = texts(assemble(h)).join('\n');
  /* 这些是旧 F2 的逐条禁令/模板抑制清单，新路径不应出现 */
  ['【禁止行为】', '默认抑制模板', '眼眸危险', '喉结滚动', '小兽',
    '也就你敢', '就仗着我惯着你', '[STYLE_PRESET]', '[SCENE_STATE]',
    '[PARTICIPANTS]', '[FOCUS_MODE]', '[ADDRESS_STATE]', '[OPENING_MODE]',
    '[NARRATIVE_SETTINGS]', '[PACING]', '[LENGTH_TARGET]'].forEach(function (bad1) {
    eq(all.indexOf(bad1), -1, '旧黑名单/幽灵标签混入：' + bad1);
  });
});

t('forScenario(\'offline\') 每次装配只被调用一次', function () {
  var h = boot({});
  var calls = 0;
  var orig = h.S.behaviorText.forScenario;
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    forScenario: function (sc) { calls++; return orig(sc); }
  });
  h.S.promptEngine.assembleOffline(offCtx(h));
  eq(calls, 1, 'forScenario 调用次数：');
});

/* ============================================================
   2. override：只判 shell / f2
   ============================================================ */
head('2. 用户 override（场景级整体回退）');

function assertFullFallback(h, label) {
  var r = assemble(h);
  eq(r.behavior.used, false, label + ' used：');
  eq(r.behavior.reason, 'user-override', label + ' reason：');
  eq(r.behavior.touched, true, label + ' touched：');
  /* ★ 回退时 modules 必须为空 —— 候选可用不冒充已使用 */
  eq(r.behavior.modules, [], label + ' modules（回退时应为空）：');
  return r;
}

t('shell 被覆盖 → shell + f2 **整体**回退', function () {
  var h = boot({ overrides: { shell: '【用户自定义外壳】\n夹具覆盖文本。' } });
  var r = assertFullFallback(h, 'shell 覆盖');
  var all = texts(r).join('\n');
  eq(all.indexOf('夹具覆盖文本') >= 0, true, '用户 shell 文本未生效：');
  /* f2 必须跟着回退到旧卡，不能一半新一半旧。
     ⚠️ 回退时**应当出现旧卡正文** —— 「不混用」指的是新正文不残留，
        不是旧正文要消失（旧正文是回退路径的合法内容）。 */
  eq(countOcc(all, N_BODY), 0, 'f2 仍用了新 N：');
  eq(findText(r, '你不是在扮演一个角色') !== null, true, 'f2 未回退旧卡：');
});

t('f2 被覆盖 → 整体回退，f2 用用户文本', function () {
  var h = boot({ overrides: { f2: '【用户自定义 F2】\n夹具覆盖 F2。' } });
  var r = assertFullFallback(h, 'f2 覆盖');
  var all = texts(r).join('\n');
  eq(all.indexOf('夹具覆盖 F2') >= 0, true, '用户 f2 文本未生效：');
  eq(findText(r, '[身份与场景]') !== null, true, 'shell 未跟着回退：');
});

t('空串 override 也算改过（保留空串覆盖语义）', function () {
  var h = boot({ overrides: { shell: '' } });
  var r = assemble(h);
  eq(r.behavior.used, false, '空串 shell 覆盖后 used：');
  eq(r.behavior.reason, 'user-override', '空串覆盖 reason：');
  eq(r.behavior.modules, [], '空串覆盖 modules：');
  /* shell 正文为空 → 线下 pushSlot 按 !!text 判 → 该槽不上 */
  eq(slotOn(r, 'shell'), false, '空串 shell 槽应不上：');
  /* f2 仍回退旧卡（整体回退，不因为 shell 空就单独用新的） */
  eq(findText(r, '你不是在扮演一个角色') !== null, true, 'f2 未回退旧卡：');
  eq(countOcc(texts(r).join('\n'), N_BODY), 0, 'f2 混入新正文：');
});

t('f2 空串 override 同样整体回退', function () {
  var h = boot({ overrides: { f2: '' } });
  var r = assemble(h);
  eq(r.behavior.used, false, '空串 f2 覆盖后 used：');
  eq(slotOn(r, 'f2'), false, '空串 f2 槽应不上：');
  eq(findText(r, '[身份与场景]') !== null, true, 'shell 未跟着回退：');
});

t('shell + f2 同时覆盖 → 仍整体回退，两个槽都用用户文本', function () {
  var h = boot({ overrides: { shell: '夹具壳', f2: '夹具F2' } });
  var r = assemble(h);
  eq(r.behavior.used, false, '双覆盖 used：');
  var all = texts(r).join('\n');
  eq(all.indexOf('夹具壳') >= 0, true, '用户 shell 未生效：');
  eq(all.indexOf('夹具F2') >= 0, true, '用户 f2 未生效：');
});

t('★ 仅 f1 / c05 被覆盖 **不影响** 线下', function () {
  var h = boot({ overrides: { f1: '夹具改线上的 f1', c05: '夹具改线上的 c05' } });
  var r = assemble(h);
  eq(r.behavior.used, true, '只改 f1/c05 不应让线下回退：');
  eq(r.behavior.touched, false, 'touched 应为 false：');
  eq(findText(r, '夹具改线上的 f1'), null, '线上 f1 override 漏进线下：');
  eq(findText(r, '夹具改线上的 c05'), null, '线上 c05 override 漏进线下：');
  eq(countOcc(texts(r).join('\n'), N_BODY), 1, 'f2 新正文应仍在：');
});

/* ============================================================
   3. 失败路径：不产生半新半旧
   ============================================================ */
head('3. 覆盖/校验失败 → 整体回退，不混用');

function assertFail(h, reasonCode, label) {
  var r = assemble(h);
  eq(r.behavior.used, false, label + ' used：');
  eq(r.behavior.reason, reasonCode, label + ' reason：');
  eq(r.behavior.modules, [], label + ' modules（应为空）：');
  var all = texts(r).join('\n');
  /* ★ 回退时**两槽都应走 cardBody** —— 旧正文出现是回退路径的合法结果。
     「不产生半新半旧」检查的是**新正文一段都不许残留**。 */
  eq(findText(r, '[身份与场景]') !== null, true, label + ' shell 未回退旧卡：');
  eq(findText(r, '你不是在扮演一个角色') !== null, true, label + ' f2 未回退旧卡：');
  [B_BODY, P_BODY, L_BODY, N_BODY, S2_BODY].forEach(function (b) {
    eq(countOcc(all, b), 0, label + ' 残留新正文片段：');
  });
  return r;
}

t('模块缺失 → module-missing，整体回退', function () {
  var h = boot({});
  delete h.S.behaviorText;
  assertFail(h, 'module-missing', '模块缺失');
});

t('版本不符 → version-mismatch，整体回退', function () {
  var h = boot({});
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, { VERSION: 'sleepy-behavior-v9-not-real' });
  assertFail(h, 'version-mismatch', '版本不符');
});

t('planOf 返回错序 → plan-mismatch（plan 与 result 不一致，先在计划覆盖处失败）', function () {
  var h = boot({});
  var orig = h.S.behaviorText.planOf;
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    planOf: function (sc) {
      var p = orig(sc);
      return sc === 'offline' ? ['P', 'B', 'L', 'S2', 'N'] : p;
    }
  });
  assertFail(h, 'plan-mismatch', '计划错序');
});

t('plan 与 result **同时**错序（且内部自洽）→ slot-contract（集合相等但顺序错）', function () {
  var h = boot({});
  var origPlan = h.S.behaviorText.planOf;
  var origFor = h.S.behaviorText.forScenario;
  /* 只把 N/S2 与 B/P/L 两组**整体对调**：
     modules 与 parts 仍一一对应（⑥ 过）、text 拼接仍一致（⑧ 过）、
     plan 与 result 仍完全一致（⑦ 过）——
     所以唯一能抓住它的就是 ⑨ 的逐项槽位契约比对。 */
  var swapped = ['N', 'S2', 'B', 'P', 'L'];
  /* 目标位置 i → 原 parts 索引。
     原序 ['B','P','L','N','S2']，新序第 0 位要 N（原索引 3）、第 1 位要 S2（4）、
     第 2 位要 B（0）、第 3 位要 P（1）、第 4 位要 L（2）。 */
  var srcIdx = [3, 4, 0, 1, 2];
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    planOf: function (sc) { return sc === 'offline' ? swapped.slice() : origPlan(sc); },
    forScenario: function (sc) {
      var r = origFor(sc);
      if (sc !== 'offline') return r;
      var parts = r.parts.slice();
      return Object.assign({}, r, {
        modules: swapped.slice(),
        parts: srcIdx.map(function (i) { return parts[i]; }),
        text: srcIdx.map(function (i) { return parts[i].text; }).join('\n\n')
      });
    }
  });
  assertFail(h, 'slot-contract', '两组整体对调');
});

t('planOf 少一段 → plan-mismatch，整体回退', function () {
  var h = boot({});
  var orig = h.S.behaviorText.planOf;
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    planOf: function (sc) { return sc === 'offline' ? ['B', 'P', 'L', 'N'] : orig(sc); }
  });
  assertFail(h, 'plan-mismatch', '计划缺段');
});

t('forScenario 返回 ok:false → not-ok，整体回退', function () {
  var h = boot({});
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    forScenario: function () {
      return { ok: false, scene: 'offline', error: 'x', missing: ['S2'],
        modules: [], parts: [], text: '' };
    }
  });
  assertFail(h, 'not-ok', 'forScenario not-ok');
});

t('单模块正文被清空 → bad-part，整体回退（不产生半套）', function () {
  var h = boot({});
  var origFor = h.S.behaviorText.forScenario;
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    /* ⚠️ 必须改 forScenario 的返回（parts），不是 module() ——
       module() 只是导出接口，forScenario 内部读的是模块自己的闭包常量。 */
    forScenario: function (sc) {
      var r = origFor(sc);
      if (sc !== 'offline') return r;
      return Object.assign({}, r, {
        parts: r.parts.map(function (p) {
          return p.id === 'N' ? { id: 'N', text: '   ' } : p;
        })
      });
    }
  });
  assertFail(h, 'bad-part', '模块正文空白');
});

t('forScenario 抛异常 → call-threw，整体回退（不崩、不半套）', function () {
  var h = boot({});
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    forScenario: function () { throw new Error('夹具故意抛'); }
  });
  var r = assemble(h);
  eq(r.behavior.used, false, '抛异常后 used：');
  eq(r.behavior.reason, 'call-threw', '抛异常 reason：');
  eq(r.behavior.modules, [], '抛异常 modules：');
  eq(findText(r, '[身份与场景]') !== null, true, '抛异常后 shell 未回退：');
  eq(findText(r, '你不是在扮演一个角色') !== null, true, '抛异常后 f2 未回退：');
});

t('parts 与 modules 不同序 → bad-part，整体回退', function () {
  var h = boot({});
  var orig = h.S.behaviorText.forScenario;
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    forScenario: function (sc) {
      var r = orig(sc);
      if (sc !== 'offline') return r;
      return Object.assign({}, r, { parts: r.parts.slice().reverse() });
    }
  });
  assertFail(h, 'bad-part', 'parts 错序');
});

t('text 与 parts 拼接不一致 → join-mismatch，整体回退', function () {
  var h = boot({});
  var orig = h.S.behaviorText.forScenario;
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    forScenario: function (sc) {
      var r = orig(sc);
      if (sc !== 'offline') return r;
      return Object.assign({}, r, { text: r.text + '\n\n夹具多出来的一段' });
    }
  });
  assertFail(h, 'join-mismatch', '拼接不一致');
});

t('planOf 返回非数组 → plan-mismatch，整体回退', function () {
  var h = boot({});
  h.S.behaviorText = Object.assign({}, h.S.behaviorText, {
    planOf: function (sc) { return sc === 'offline' ? null : MOD.planOf(sc); }
  });
  assertFail(h, 'plan-mismatch', 'planOf 非数组');
});

t('回退时宣称「新模块已使用」= 违规 → modules 必须为空', function () {
  /* 反向对照：used=false 但 modules 非空，就是拿候选冒充已使用 */
  var h = boot({ overrides: { shell: '夹具壳' } });
  var r = assemble(h);
  assert(r.behavior.used === false, '前提：本次应回退');
  assert(r.behavior.modules.length === 0,
    '回退却报告了候选模块：' + JSON.stringify(r.behavior.modules));
});

/* ============================================================
   4. 协议与消费者：与当前基线逐条比，预期外变化 = 0
   ============================================================ */
head('4. 协议 / 译文 / 建议 / 时间 / 开场 / 解析 / 历史回填');

t('c05off 输出协议槽正文与旧基线逐字节一致（未改协议生成器）', function () {
  var h = boot({});
  var now = slotText(assemble(h), 'c05off');
  var v1 = JSON.parse(fs.readFileSync(V1, 'utf8'));
  var oldMsg = v1.captures.offline.messages;
  var old = null;
  for (var i = 0; i < oldMsg.length; i++) {
    if (oldMsg[i].role === 'system' &&
        String(oldMsg[i].content).indexOf('【输出协议 · 硬约束】') >= 0) { old = oldMsg[i].content; break; }
  }
  assert(old !== null, 'v1 基线里找不到线下输出协议段');
  eq(now, old, '输出协议段：');
});

t('叙事设置槽（文风/字数/视角）不受本批影响', function () {
  var h = boot({});
  var now = slotText(assemble(h), 'narrative');
  assert(now && now.indexOf('【叙事设置】') >= 0, '叙事设置段缺失');
  ['整体风格', '回复字数', '描写 Char 内心', 'NPC 出现频率', '建议选项', '场景时间推进']
    .forEach(function (k) {
      eq(now.indexOf(k) >= 0, true, '叙事设置缺项：' + k);
    });
});

t('存量旧文风值（pure_love 等）不再炸装配，风格行仍存在（2026-10-05 起回落 nature_life）', function () {
  ['pure_love', 'literary', 'casual'].forEach(function (v) {
    var h = boot({});
    h.offSession.narrativeSettings = { style: v };
    var got = slotText(assemble(h), 'narrative');
    assert(got && got.indexOf('整体风格') >= 0, v + ' 风格行缺失');
  });
});

t('未知文风值回落 nature_life（2026-10-05 七项文风批批准变更）', function () {
  /* ★ 判据更新：旧判据是「回落 pure_love」。本批文风从三套换成六套
     （《文风预设引擎新稿 v2》），回落档改为 nature_life（自然生活）；
     存量旧 style 值（pure_love 等）在 STYLE_PRESETS 查不到 → 同样走默认档。 */
  var h = boot({});
  h.offSession.narrativeSettings = { style: 'v2_unknown_value' };
  var got = slotText(assemble(h), 'narrative');
  assert(got.indexOf('自然生活') >= 0 && got.indexOf('风格锚点：') >= 0,
    '未知值未回落 nature_life');
});

t('自定义 styleWords 仍优先（本批不动该行为）', function () {
  var h = boot({});
  h.offSession.narrativeSettings = { style: 'custom', styleWords: '夹具自定义文风词' };
  var got = slotText(assemble(h), 'narrative');
  eq(got.indexOf('夹具自定义文风词') >= 0, true, '自定义文风词未生效');
});

t('历史回灌格式不变（parasText 按换行拼）', function () {
  var h = boot({});
  var r = assemble(h);
  var hist = r.messages.filter(function (m) { return m.role === 'assistant' || m.role === 'user'; });
  assert(hist.length >= 1, '历史段缺失');
  var lastChar = null;
  r.messages.forEach(function (m) { if (m.role === 'assistant') lastChar = m; });
  assert(lastChar && String(lastChar.content).indexOf('夹具·纪言：') >= 0, '角色名块前缀丢失');
});

t('开场 user 句由调用方追加，装配本身不产出（结构未变）', function () {
  var h = boot({});
  var r = assemble(h);
  var hasOpen = texts(r).some(function (s) { return s.indexOf('（开场。') >= 0; });
  eq(hasOpen, false, '装配层不应自带开场句：');
});

t('parseOfflineReply 行为不变（围栏 / 前后废话 / 降级 / trans）', function () {
  var h = boot({});
  var E = h.S.promptEngine;
  var a = E.parseOfflineReply('```json\n{"paras":[{"type":"dialogue","text":"夹具台词","trans":"译文"}]}\n```');
  eq(a.ok, true, '围栏解析 ok：');
  eq(a.paras[0].trans, '译文', 'dialogue trans：');
  var b = E.parseOfflineReply('这是前言 {"paras":[{"type":"prose","text":"夹具描写","trans":"不该收"}]} 尾巴');
  eq(b.ok, true, '前后废话解析 ok：');
  eq(b.paras[0].trans, null, 'prose 不该收 trans：');
  var c = E.parseOfflineReply('完全不是 JSON 的一段话');
  eq(c.ok, false, '降级 ok 标记：');
  eq(c.paras.length, 1, '降级段数：');
  eq(c.paras[0].type, 'prose', '降级类型：');
  var d = E.parseOfflineReply('{"paras":[],"suggests":["一","二","三","四"]}');
  eq(d.suggests.length, 3, 'suggests 硬截 3 条：');
});

t('v1 基线文件未被本批改动', function () {
  eq(H.sha256(fs.readFileSync(V1, 'utf8')), V1_SHA, 'v1 基线 sha256：');
});

/* ============================================================
   5. 线上回归：本批不得影响线上
   ============================================================ */
head('5. 线上装配回归');

t('线上默认仍走新路径（B/P/L + E/S1）', function () {
  var h = boot({});
  var r = h.S.promptEngine.assembleOnline({
    charId: ID.chMain, userId: ID.umSmall,
    history: [{ role: 'user', content: S.histUser1 },
              { role: 'assistant', content: S.histChar1 }],
    userInput: S.histUser2
  });
  eq(r.behavior.used, true, '线上 used：');
  eq(r.behavior.modules, ['B', 'P', 'L', 'E', 'S1'], '线上 modules：');
});

t('线上 shell = B/P/L（与线下同源，各自一次）', function () {
  var h = boot({});
  var r = h.S.promptEngine.assembleOnline({
    charId: ID.chMain, userId: ID.umSmall,
    history: [{ role: 'user', content: S.histUser1 }], userInput: S.histUser2
  });
  eq(slotText(r, 'shell'), [B_BODY, P_BODY, L_BODY].join('\n\n'), '线上 shell：');
});

t('线上 f1 = E/S1（线下用 N/S2，互不串）', function () {
  var h = boot({});
  var r = h.S.promptEngine.assembleOnline({
    charId: ID.chMain, userId: ID.umSmall,
    history: [{ role: 'user', content: S.histUser1 }], userInput: S.histUser2
  });
  eq(slotText(r, 'f1'), [MOD.module('E'), MOD.module('S1')].join('\n\n'), '线上 f1：');
  eq(countOcc(slotText(r, 'f1'), N_BODY), 0, '线上 f1 混入了 N：');
});

t('线上 c05 仍用 BT_C05_ONLINE（线下 c05off 不受影响）', function () {
  var h = boot({});
  var r = h.S.promptEngine.assembleOnline({
    charId: ID.chMain, userId: ID.umSmall,
    history: [{ role: 'user', content: S.histUser1 }], userInput: S.histUser2
  });
  var c05 = slotText(r, 'c05');
  assert(c05.indexOf('正文之后必须附带一条完整的 [WHISPER]') >= 0, '线上 c05 协议不对');
  /* 线下的 c05off 仍应是 JSON 协议，两者不能串 */
  var off = slotText(assemble(h), 'c05off');
  assert(off.indexOf('"paras"') >= 0, '线下 c05off 被换掉了');
  assert(off.indexOf('[WHISPER]') < 0, '线下 c05off 混进了线上协议');
});

t('线上对 f1 override 回退，线下不受牵连', function () {
  var h = boot({ overrides: { f1: '夹具改 f1' } });
  var on = h.S.promptEngine.assembleOnline({
    charId: ID.chMain, userId: ID.umSmall,
    history: [{ role: 'user', content: S.histUser1 }], userInput: S.histUser2
  });
  eq(on.behavior.used, false, '线上应因 f1 覆盖回退：');
  var off = assemble(h);
  eq(off.behavior.used, true, '★ 线上回退不得牵连线下：');
  eq(countOcc(texts(off).join('\n'), N_BODY), 1, '线下 f2 应仍用新正文：');
});

t('OFFLINE_SLOTS 结构未变（含 2026-10-05 K03e 批在 taimpact 后插入 talife）', function () {
  var h = boot({});
  eq((h.S.promptEngine.offlineSlots || []).map(function (s) { return s.id; }),
    ['character', 'usercore', 'i01', 'lang', 'shell', 'f2', 'relation',
     'life', 'recall', 'taimpact', 'talife', 'worldbook', 'custom', 'narrative',
     'scene', 'c05off', 'history'],
    'OFFLINE_SLOTS：');
});

/* ============================================================
   6. 诊断：来源、阶段、失败、并发、旧状态
   ============================================================ */
head('6. 最小实际请求诊断');

/* 诊断逻辑在 page-offline.js 里（浏览器环境）。这里用**源码静态 + 行为仿真**
   两条腿验：静态保证「不采敏感字段 / 不入库」，仿真保证阶段与并发语义。
   —— 不加载 page-offline.js（它依赖 DOM 与大量 UI 模块）。 */
var SRC_OFFLINE = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');

t('诊断只从实际 built 对象采集（与出站同一份）', function () {
  assert(SRC_OFFLINE.indexOf('var behavior = built.behavior || null;') >= 0,
    '未从 built 取诊断');
  /* 装配在 try 里，赋值没有 var（前面已声明） */
  assert(/built = E\.assembleOffline\(\{/.test(SRC_OFFLINE), '装配调用点缺失');
  /* callModel 必须拿的就是 built.messages */
  assert(/callModel\(cand, built\.messages\)/.test(SRC_OFFLINE), '出站未用 built.messages');
  /* 装配失败分支不得继续出站 */
  assert(SRC_OFFLINE.indexOf('DIAG_STAGE.ASSEMBLE_FAILED') >= 0, '缺装配失败阶段');
});

t('阶段闭集齐备且四个取值都在源码里出现', function () {
  ['assemble-failed', 'at-call-boundary', 'model-returned', 'no-connection']
    .forEach(function (s) {
      assert(SRC_OFFLINE.indexOf("'" + s + "'") >= 0, '阶段未定义：' + s);
    });
});

/* ---------- 以下四条断言锚定的是 v1 的旧契约，F2 迁移后已过时 ----------
   v1 签名：diagRecord(stage, behavior, extra) —— 单参、无 requestId
   v1 字段：modelOk（现已改名 requestOk）
   v1 守卫：diagRecordIfCurrent(seq, ...) + `if (diagSeq !== seq) return;`
            （拿诊断记录序号当请求身份，正是本批要修的错）
   v3 签名：diagRecord(requestId, stage, behavior, extra) —— 请求身份独立
   v3 守卫：**已删除**。守卫只管共享 UI 状态（isLatest），不丢弃业务回调。
   ⚠️ 断言强度不降：改为卡「请求身份与诊断序号是两个计数器」
     「回调里不得有丢弃式 return」「modelOk 已不存在」——
     这些正是能抓住本批 bug 的判据。 */

/* ---------- 以下断言原锚 v1 旧契约，F2 迁移后已过时（授权更新，强度不降）----------
   v1 签名：diagRecord(stage, behavior, extra) —— 单参、无 requestId
   v1 字段：modelOk（现已改名 requestOk）
   v1 守卫：diagRecordIfCurrent(seq, ...) + 「拿 diagSeq 比一下就 return」
            —— 那正是把诊断记录序号当请求身份，本批要修的错
   v3 签名：diagRecord(requestId, stage, behavior, extra) —— 请求身份独立
   v3 守卫：只判断「要不要动共享 UI 状态」（isLatest），**不丢弃业务回调**。 */

t('「到达调用边界」与「模型返回」分开记（不等价），且都带请求身份', function () {
  var iBoundary = SRC_OFFLINE.indexOf('diagRecord(reqId, DIAG_STAGE.AT_CALL_BOUNDARY');
  assert(iBoundary >= 0, '缺「已到达调用边界」记录点（v3 签名必须带 reqId）');
  assert(SRC_OFFLINE.indexOf('DIAG_STAGE.MODEL_RETURNED') >= 0, '缺「模型已返回」阶段');
  /* 无连接时不得停留在「已到达调用边界」 */
  assert(SRC_OFFLINE.indexOf('diagRecord(reqId, DIAG_STAGE.NO_CONNECTION') >= 0,
    '无连接记录未带请求身份');
});

t('失败语义按「服务端是否真的收到」分级（不再一律记服务端拒绝）', function () {
  /* 装配失败与出网失败都要写新记录 */
  assert(/diagRecord\(reqId, DIAG_STAGE\.ASSEMBLE_FAILED/.test(SRC_OFFLINE),
    '装配失败未落记录');
  assert(/diagRecord\(reqId, DIAG_STAGE\.REQUEST_FAILED_UNKNOWN/.test(SRC_OFFLINE),
    '失败未落 request-failed-unknown 记录');
  /* ★ config=没出网 / network+timeout=无法确认 / http+parse=确实收到并拒绝 */
  assert(SRC_OFFLINE.indexOf("'config': DIAG_STAGE.NO_CONNECTION") >= 0,
    '无连接（没出网）必须独立于服务端拒绝');
  assert(SRC_OFFLINE.indexOf("'network': DIAG_STAGE.REQUEST_FAILED_UNKNOWN") >= 0,
    '网络失败不得记成服务端拒绝（无法确认是否送达）');
  assert(SRC_OFFLINE.indexOf("'timeout': DIAG_STAGE.REQUEST_FAILED_UNKNOWN") >= 0,
    '超时不���记成服务端拒绝');
  assert(SRC_OFFLINE.indexOf("'http': DIAG_STAGE.REQUEST_REJECTED") >= 0,
    'http 应记为「服务端已收到并拒绝」');
  assert(SRC_OFFLINE.indexOf("'parse': DIAG_STAGE.REQUEST_REJECTED") >= 0,
    'parse 应记为「服务端已收到并拒绝」');
  /* ★ modelOk 已改名 requestOk：含义是「本轮有没有结论」，不是「模型返没返回」 */
  assert(SRC_OFFLINE.indexOf('requestOk:') >= 0, '缺 requestOk 字段');
  assert(SRC_OFFLINE.indexOf('modelOk') < 0, 'modelOk 旧字段名仍在（应已改名 requestOk）');
});

t('请求身份与诊断序号是两个计数器（不再拿 diagSeq 当请求身份）', function () {
  assert(SRC_OFFLINE.indexOf('var requestSeq = 0;') >= 0, '缺请求身份计数器 requestSeq');
  assert(SRC_OFFLINE.indexOf('var diagSeq = 0;') >= 0, '缺诊断记录计数器 diagSeq');
  assert(SRC_OFFLINE.indexOf('function diagNewRequest()') >= 0, '缺 diagNewRequest');
  var fn = SRC_OFFLINE.slice(SRC_OFFLINE.indexOf('function diagNewRequest()'),
    SRC_OFFLINE.indexOf('function diagNewRequest()') + 220);
  assert(/requestSeq \+= 1;/.test(fn), 'diagNewRequest 未自增 requestSeq');
  assert(fn.indexOf('diagSeq') < 0,
    '★ diagNewRequest 里不得碰 diagSeq（那正是把序号当身份的地方）');
  /* 旧守卫函数必须已删除（它本来就是不存在的函数引用）。
     ⚠️ 必须**剥注释**再判：修法说明里必然要写出这个名字，
        不剥会把自己注释判成违规 → 假红。 */
  var bareOff = SRC_OFFLINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(bareOff.indexOf('diagRecordIfCurrent') < 0,
    '★ diagRecordIfCurrent 仍在代码里（剥注释后判）');
  assert(SRC_OFFLINE.indexOf('function diagRecordIfCurrent') < 0,
    '★ diagRecordIfCurrent 的函数声明仍在');
  /* 请求身份在 requestTurn 入口分配（预取阶段就占位），不是在 go() 里 */
  var rt = SRC_OFFLINE.slice(SRC_OFFLINE.indexOf('function requestTurn(userInput)'));
  assert(rt.indexOf('var reqId = diagNewRequest();') >= 0,
    '请求身份未在 requestTurn 入口分配（预取期间可重复发送）');
  assert(/function go\(reqId, userInput\)/.test(SRC_OFFLINE),
    'go() 未接请求身份（会在内部重新分配）');
});

/* ---- 独立的语义护栏：then 回调里不得有「拿诊断序号比一下就整段 return」 ----
   ⚠️ 这条最易假绿：v2 卡的是字面量 `if (diagSeq !== seq) return;`，
     换个变量名就漏 —— 我自己就踩过（注入 `diagSeq !== reqId` 照样报绿）。
   ★ 正则刻意**不锚变量名**：只要「if ( ... diagSeq ... ) return」就判违规。
     diagRecord 内部的 `diagSeq += 1` 是赋值不是比较，不受影响。 */
t('then 回调里没有丢弃式守卫（不拿诊断序号整段 return）', function () {
  var i = SRC_OFFLINE.indexOf('p.then(function (r) {');
  assert(i >= 0, '找不到 callModel 的 then 回调');
  var bail = SRC_OFFLINE.slice(i).match(/if\s*\([^)]*diagSeq[^)]*\)\s*return\b/);
  assert(!bail, 'then 回调里有丢弃式守卫（' + (bail && bail[0]) +
    '）→ 会整段丢掉业务回调，pending 永久占位、按钮不解禁、无错误提示');
  /* 反向：诊断写入内部仍应自增 diagSeq（那是它的本职，给面板排序） */
  var j = SRC_OFFLINE.indexOf('function diagRecord(requestId');
  assert(j >= 0, 'diagRecord 签名不对（应是四参、requestId 在首）');
  assert(/diagSeq \+= 1;/.test(SRC_OFFLINE.slice(j, j + 220)),
    'diagRecord 内部应照常自增 diagSeq');
  return { 丢弃式守卫: '无', 诊断写入: '仍自增 diagSeq' };
});

t('业务守卫只管共享 UI 状态，且收尾带身份核对', function () {
  assert(SRC_OFFLINE.indexOf('var isLatest = (reqId === requestSeq);') >= 0,
    '缺 isLatest 身份判定（业务守卫应比请求身份，不是诊断序号）');
  assert(SRC_OFFLINE.indexOf('function finishTurn(ownId)') >= 0,
    'finishTurn 未接请求身份（旧请求会误关新请求的忙碌态）');
  var f = SRC_OFFLINE.slice(SRC_OFFLINE.indexOf('function finishTurn(ownId)'),
    SRC_OFFLINE.indexOf('function finishTurn(ownId)') + 420);
  assert(f.indexOf('ownId !== requestSeq') >= 0, 'finishTurn 里没有身份核对');
  /* 回调不得因为「不是最新请求」就整段 return —— 回复必须落地 */
  var cb = SRC_OFFLINE.slice(SRC_OFFLINE.indexOf('p.then(function (r) {'));
  assert(cb.indexOf('if (!ok)') >= 0, '回调缺失败分支（失败必须收尾）');
});

t('诊断记录字段白名单（含 requestId / requestOk，不含敏感内容）', function () {
  var b = SRC_OFFLINE.indexOf('function diagRecord(requestId, stage, behavior, extra)');
  assert(b >= 0, 'diagRecord 签名不对（应是四参、requestId 在首）');
  var block = SRC_OFFLINE.slice(b, b + 1200);
  ['requestId:', 'seq:', 'at:', 'stage:', 'behaviorUsed:', 'reason:',
   'touched:', 'version:', 'modules:', 'requestOk:'].forEach(function (k) {
    assert(block.indexOf(k) >= 0, '缺字段：' + k);
  });
  /* ★ 不采集：prompt 正文 / 聊天 / 角色名 / override 内容 / 异常全文 / API 配置 */
  ['messages', 'content:', 'prompt', 'charName', 'baseUrl', 'apiKey']
    .forEach(function (f) {
      assert(block.indexOf(f) < 0, '诊断记录里出现敏感字段：' + f);
    });
});

t('生产接口只读：导出面没有写入/重置入口', function () {
  var i = SRC_OFFLINE.indexOf('Sleepy.offlineDiag = {');
  assert(i >= 0, '找不到 Sleepy.offlineDiag 导出');
  var face = SRC_OFFLINE.slice(i, SRC_OFFLINE.indexOf('};', i));
  /* 剥注释：修法说明里必然写出 __record 这些名字，不剥会把自己判成违规 */
  var bare = face.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ['__record', '__recordIfCurrent', '__reset', '__snapshot', 'diagRecord:']
    .forEach(function (k) {
      assert(bare.indexOf(k) < 0, '★ 导出面暴露了写入口：' + k);
    });
  assert(bare.indexOf('snapshot: diagSnapshot') >= 0, '导出面缺只读 snapshot');
  assert(bare.indexOf('stageLabel') >= 0, '导出面缺只读 stageLabel');
});

t('预览不覆盖实际请求记录（诊断只在 go() 的调用链里写）', function () {
  /* 预览走 assembleOffline 后直接读返回值，不经过 diagRecord */
  var callers = SRC_OFFLINE.match(/diagRecord\(/g) || [];
  assert(callers.length >= 3, 'diagRecord 调用点过少：' + callers.length);
  /* buildDiagPanel 只读 diagSnapshot，不写 */
  var panel = SRC_OFFLINE.slice(SRC_OFFLINE.indexOf('function buildDiagPanel'),
                                SRC_OFFLINE.indexOf('function buildDiagPanel') + 800);
  assert(panel.indexOf('diagSnapshot()') >= 0, '面板应只读快照');
  assert(panel.indexOf('diagRecord(') < 0, '面板不应写诊断');
});

t('查看入口标注「最近一次线下请求」且默认折叠', function () {
  assert(SRC_OFFLINE.indexOf('最近一次线下请求') >= 0, '入口未标注');
  assert(/h\('details'/.test(SRC_OFFLINE), '未用 details 折叠');
  assert(SRC_OFFLINE.indexOf("h('summary', 'off-diag-summary', '展开查看')") >= 0, '折叠标题不对');
  /* 刻意不在沉浸正文常驻状态行 */
  assert(SRC_OFFLINE.indexOf('off-diag-line') >= 0, '缺诊断行样式类');
});

t('CSS：四个变量都已存在（不引入未定义变量）', function () {
  var css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  var seg = css.slice(css.indexOf('.off-diag-fold{'), css.indexOf('.off-diag-note{'));
  ['var(--border)', 'var(--text-dim)', 'var(--text-faint)', 'var(--text)']
    .forEach(function (v) {
      assert(seg.indexOf(v) >= 0, '诊断样式缺 ' + v);
    });
  ['--bg-card', '--font-mono', '--text-main'].forEach(function (v) {
    assert(seg.indexOf(v) < 0, '引入了不存在的变量：' + v);
  });
});

/* ---- 6b. 阶段与并发的行为仿真（不加载 DOM，直接验语义） ---- */

/* 复刻 page-offline.js 的诊断状态机，逐条验阶段迁移。
   ⚠️ 这是**语义仿真**，不是跑生产代码 —— 目的是把四阶段与 seq 守卫
      的正确性钉死；生产代码本身的静态断言在上面。 */
function makeDiagSim() {
  var st = { seq: 0, last: null };
  function record(stage, behavior, extra) {
    st.seq += 1;
    var b = behavior || {};
    st.last = {
      seq: st.seq, stage: stage,
      behaviorUsed: b.used === true,
      reason: typeof b.reason === 'string' ? b.reason : '',
      modules: Array.isArray(b.modules) ? b.modules.slice() : [],
      modelOk: extra && typeof extra.modelOk === 'boolean' ? extra.modelOk : null
    };
    return st.last;
  }
  return {
    state: st,
    record: record,
    recordIfCurrent: function (seq, stage, behavior, extra) {
      if (st.seq !== seq) return null;
      return record(stage, behavior, extra);
    }
  };
}

t('仿真·正常一次：新路径 → 边界 → 返回成功', function () {
  var d = makeDiagSim();
  var b = { used: true, reason: '', modules: ['B', 'P', 'L', 'N', 'S2'] };
  eq(d.record('at-call-boundary', b).stage, 'at-call-boundary', '边界阶段：');
  var seq = d.state.seq;
  var fin = d.recordIfCurrent(seq, 'model-returned', b, { modelOk: true });
  eq(fin.stage, 'model-returned', '返回阶段：');
  eq(fin.modelOk, true, 'modelOk：');
  eq(fin.behaviorUsed, true, 'used：');
  eq(fin.modules, ['B', 'P', 'L', 'N', 'S2'], '成功时应记实际模块：');
});

t('仿真·回退一次：不宣称已用新模块（modules 空）', function () {
  var d = makeDiagSim();
  var b = { used: false, reason: 'user-override', touched: true, modules: [] };
  var seq = d.record('at-call-boundary', b).seq;
  var fin = d.recordIfCurrent(seq, 'model-returned', b, { modelOk: true });
  eq(fin.behaviorUsed, false, 'used：');
  eq(fin.reason, 'user-override', 'reason：');
  eq(fin.modules, [], '回退时 modules 必须为空：');
});

t('仿真·装配失败：不留上一轮成功态', function () {
  var d = makeDiagSim();
  d.recordIfCurrent(d.record('model-returned', { used: true, modules: ['B'] }, { modelOk: true }).seq,
    'model-returned', { used: true, modules: ['B'] }, { modelOk: true });
  eq(d.state.last.modelOk, true, '前置：上一轮成功');
  var f = d.record('assemble-failed', null, { modelOk: null });
  eq(f.stage, 'assemble-failed', '失败阶段：');
  eq(f.modelOk, null, '装配失败不该有 modelOk：');
  eq(f.behaviorUsed, false, '装配失败不应宣称用了新正文：');
});

t('仿真·无连接：改记 no-connection，不停在「已到达调用边界」', function () {
  var d = makeDiagSim();
  var b = { used: true, modules: ['B'] };
  var seq = d.record('at-call-boundary', b).seq;
  var f = d.recordIfCurrent(seq, 'no-connection', b, { modelOk: false });
  eq(f.stage, 'no-connection', '阶段：');
  eq(f.modelOk, false, 'modelOk：');
});

t('仿真·并发：旧请求的迟到结果不覆盖较新请求', function () {
  var d = makeDiagSim();
  var seqOld = d.record('at-call-boundary', { used: true, modules: ['B'] }).seq;
  /* 新请求插进来 */
  var seqNew = d.record('assemble-failed', null, { modelOk: null }).seq;
  eq(d.state.last.stage, 'assemble-failed', '新请求状态：');
  /* 旧请求的迟到结果 —— 必须被丢弃 */
  var late = d.recordIfCurrent(seqOld, 'model-returned', { used: true, modules: ['B'] }, { modelOk: true });
  eq(late, null, '迟到结果应被丢弃：');
  eq(d.state.seq, seqNew, 'seq 不应被迟到结果推进：');
  eq(d.state.last.stage, 'assemble-failed', '状态应仍是新请求的：');
});

/* ============================================================
   7. 源码护栏：本批不该出现的东西
   ============================================================ */
head('7. 源码护栏');

t('未改 CARD_DEFAULTS.shell / f2 正文', function () {
  var src = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  var s = src.indexOf('    shell: {');
  var f = src.indexOf('    f2: {');
  assert(s > 0 && f > 0, '找不到卡定义');
  assert(src.indexOf('[身份与场景]', s) > 0, '旧 shell 首节被删了');
  assert(src.slice(f, f + 4000).indexOf('【Deep Talk】') > 0, '旧 F2 Deep Talk 被删了');
  assert(src.indexOf('[主动与节制]', s) > 0 && src.indexOf('[主动与节制]', s) < f,
    '旧 shell [主动与节制] 被删了');
});

t('未改 offlineOutProto / parseOfflineReply（协议与解析）', function () {
  var src = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  var i = src.indexOf('function offlineOutProto');
  assert(i > 0, 'offlineOutProto 不见了');
  var seg = src.slice(i, src.indexOf('function assembleOffline', i));
  assert(seg.indexOf('"paras"') >= 0, '协议 JSON 形状被改');
  assert(seg.indexOf('trans') >= 0, 'trans 契约被改');
  assert(seg.indexOf('suggests') >= 0, 'suggests 被改');
  assert(seg.indexOf('envUpdate') >= 0, 'envUpdate 被改');
});

t('未在 prompt-engine.js 里新增线下输出协议常量（不该有 BT_C05_OFFLINE）', function () {
  var src = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  assert(src.indexOf('BT_C05_OFFLINE') < 0, '出现了平行协议常量 —— 本批不该有');
  assert(src.indexOf('BT_C05_ONLINE') >= 0, '线上协议常量应仍在');
});

t('未改冻结正文与版本', function () {
  var src = fs.readFileSync(path.join(ROOT, 'behavior-text.js'), 'utf8');
  eq(src.indexOf("var VERSION = 'sleepy-behavior-v1-review-01'") >= 0, true, '版本被改');
  eq(MOD.VERSION, 'sleepy-behavior-v1-review-01', '运行时版本：');
});

t('未改引擎开关语义（isEngineOn 消费点仍是原来那 3 处、分布不变）', function () {
  /* 基线：page-chat 一处（线上条件）+ page-presets 两处（展示与切换）= 3。
     本批**不得**给线下加第四处。 */
  var per = {
    'page-chat.js': 1, 'page-presets.js': 2,
    'page-offline.js': 0, 'page-proactive.js': 0
  };
  Object.keys(per).forEach(function (f) {
    var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    var n = (src.match(/isEngineOn\(\)/g) || []).length;
    eq(n, per[f], f + ' isEngineOn() 次数：');
  });
  assert(fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8')
    .indexOf('function setEngine(on)') >= 0, 'setEngine 实现被挪了或改了');
});

t('未新增线下旧装配器', function () {
  var src = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');
  assert(src.indexOf('function assembleOfflineOld') < 0, '出现了线下旧装配器');
  /* go() 仍直接调 E.assembleOffline（现在包在 try 里） */
  assert(/built = E\.assembleOffline\(\{/.test(src), '线下装配入口被改');
});

t('未改主动消息 / 群场景', function () {
  ['page-proactive.js', 'page-group-ai.js', 'page-group-offline.js'].forEach(function (f) {
    var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert(src.indexOf('btOfflineDecision') < 0, f + ' 引用了线下决策');
    assert(src.indexOf('diagRecord') < 0, f + ' 引用了线下诊断');
  });
});

t('未新增六个文风 UI 选项（文风另批）', function () {
  var src = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');
  ['v2_natural', 'v2_immersive', 'v2_restrained', 'v2_lively', 'v2_cold', 'v2_cinematic']
    .forEach(function (v) {
      assert(src.indexOf(v) < 0, '本批不应出现文风新值：' + v);
    });
  var pe = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  assert(pe.indexOf('v2_natural') < 0, '本批不应在 STYLE_HINTS 加新值');
});

/* ============================================================
   汇总
   ============================================================ */
head('结果');
process.stdout.write('  通过 ' + pass + ' / 失败 ' + fail + '\n');
if (fail) {
  process.stdout.write('\n失败项：\n');
  problems.forEach(function (p) { process.stdout.write('  - ' + p + '\n'); });
  process.stdout.write('\n结论：结构回归**未通过**。\n');
  process.exit(1);
}
process.stdout.write(
  '\n结论：**结构测试通过**。\n' +
  '⚠️ 这只证明装配路径、回退语义、诊断来源与并发守卫符合预期；\n' +
  '   **模型效果尚未验收** —— 线下行为文本的实际表现必须真机单独验。\n'
);
