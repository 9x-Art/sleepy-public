#!/usr/bin/env node
/* scripts/ta-relations-test.js — 关系人账户表单测（期望值硬写） */
'use strict';

globalThis.Sleepy = { store: { _m: {}, get(k) { return this._m[k]; }, set(k, v) { this._m[k] = JSON.parse(JSON.stringify(v)); } } };
globalThis.Sleepy.core = {
  activeSandboxId() { return 'sb1'; },
  rootIdOf(id) { return 'root-' + String(id).split('-')[0]; },
  tagScope(rec, sid) { rec.sandboxId = sid; return rec; }
};
require('../ta-relations.js');
var tr = globalThis.Sleepy.taRelations;

var failures = 0, total = 0;
function eq(name, got, want) {
  total++;
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) process.stdout.write('  \u2713 ' + name + '\n');
  else { failures++; process.stdout.write('  \u2717 ' + name + '\n    期望 ' + w + '\n    实得 ' + g + '\n'); }
}
function ok(n, c, d) { total++; if (c) process.stdout.write('  \u2713 ' + n + '\n'); else { failures++; process.stdout.write('  \u2717 ' + n + (d ? '\n    ' + d : '') + '\n'); } }

var NOW = 1750000000000;

/* 建账户 */
var a1 = tr.upsert('ch1', { name: '阿蓝', relation: '发小', bond: '铁哥们', note: '从小一起长大' });
ok('建账户成功', !!a1 && !!a1.id);
eq('盖岛章', a1.sandboxId, 'sb1');
eq('refCharId 归 root', a1.refCharId, 'root-ch1');
eq('账户列表 1 条', tr.list('ch1').length, 1);
ok('换名被拒（铁律：严禁默默换人）', tr.upsert('ch1', { id: a1.id, name: '别人' }).id === a1.id);

/* 皮套共享：root 相同的另一张皮套看到同一份 */
eq('皮套共享关系网', tr.list('ch1-skin').length, 1);

/* 提及检测 */
var hit = tr.touchMentioned('ch1', 'sb1', '今天和阿蓝吃了饭', NOW);
eq('提及检测命中', hit.length, 1);
eq('lastMentioned 记账', hit[0].lastMentioned, NOW);
eq('没提到的不动', tr.touchMentioned('ch1', 'sb1', '今天在家', NOW + 1).length, 0);

/* 节流：刚被提过的不挑 */
eq('3 天节流：刚提及不挑', tr.pickForAdvance('ch1', 'sb1', NOW + 1000), null);
eq('节流过了能挑', !!tr.pickForAdvance('ch1', 'sb1', NOW + 4 * 86400000), true);

/* 生长落库 */
var got = tr.applyAdvance('ch1', 'sb1', a1.id, {
  currentState: '升了店长，最近排班很满',
  learned: '变得很忙',
  openThread: { title: '约好的旅行还没定', tone: 'good', open: true }
}, NOW + 4 * 86400000);
eq('近况养成了', got.currentState, '升了店长，最近排班很满');
ok('learned 累积', got.learned.indexOf('变得很忙') !== -1);
eq('悬置话题 1 条', got.openThreads.filter(function (t) { return t.open; }).length, 1);
eq('tone good', got.openThreads[0].tone, 'good');

/* 再养一次：learned 追加不覆盖；悬置话题不重复开 */
got = tr.applyAdvance('ch1', 'sb1', a1.id, {
  learned: '嗓门变大了',
  openThread: { title: '约好的旅行还没定', open: true }
}, NOW + 8 * 86400000);
ok('learned 追加', got.learned.indexOf('变得很忙') !== -1 && got.learned.indexOf('嗓门变大了') !== -1);
eq('悬置话题不重复开', got.openThreads.length, 1);

/* 了结 */
got = tr.applyAdvance('ch1', 'sb1', a1.id, { openThread: { title: '约好的旅行还没定', open: false } }, NOW + 9 * 86400000);
eq('了结后开放话题 0', got.openThreads.filter(function (t) { return t.open; }).length, 0);

/* 上限：SOFT_LIMIT=6 */
var made = 0;
for (var i = 0; i < 10; i++) {
  if (tr.upsert('ch1', { name: '路人' + i })) made++;
}
eq('骨架上限 6（已有1+新5）', made, 5);

/* 注入摘要：印象强制「未必属实」 */
var sum = tr.buildSummary('ch1');
ok('摘要含关系人', sum.indexOf('阿蓝') !== -1);
ok('摘要带未必属实兜底', sum.indexOf('未必属实') !== -1);
ok('摘要带悬置事实（已了结不出现）', sum.indexOf('约好的旅行') === -1);
eq('空账户空摘要', tr.buildSummary('ch-nobody'), '');

process.stdout.write('\n关系人账户：' + (total - failures) + '/' + total + ' 通过\n');
if (failures) process.exit(1);
