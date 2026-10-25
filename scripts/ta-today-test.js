#!/usr/bin/env node
/* scripts/ta-today-test.js — L2 今日状态块单测（期望值硬写） */
'use strict';

globalThis.Sleepy = { store: { _m: {}, get(k) { return this._m[k]; }, set(k, v) { this._m[k] = JSON.parse(JSON.stringify(v)); } } };
globalThis.Sleepy.core = {
  activeSandboxId() { return 'sb1'; },
  rootIdOf(id) { return 'root-' + String(id).split('-')[0]; },
  tagScope(rec, sid) { rec.sandboxId = sid; return rec; }
};
require('../ta-today.js');
var td = globalThis.Sleepy.taToday;

var failures = 0, total = 0;
function eq(name, got, want) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(want)) process.stdout.write('  \u2713 ' + name + '\n');
  else { failures++; process.stdout.write('  \u2717 ' + name + '\n    期望 ' + JSON.stringify(want) + '\n    实得 ' + JSON.stringify(got) + '\n'); }
}
function ok(n, c) { total++; if (c) process.stdout.write('  \u2713 ' + n + '\n'); else { failures++; process.stdout.write('  \u2717 ' + n + '\n'); } }

var MORNING = new Date('2026-10-25T09:00:00').getTime();
var NIGHT = new Date('2026-10-25T23:00:00').getTime();
var TOMORROW = new Date('2026-10-26T09:00:00').getTime();

ok('空块 → null', td.get('ch1', 'sb1', MORNING) === null);

var b = td.put('ch1', 'sb1', { mood: '有点闷', occupation: '赶店里的盘点', towardYou: '想你了', smallThing: '想问你周末有空吗' }, MORNING);
ok('落块成功', !!b);
eq('date 是今天', b.date, '2026-10-25');
eq('盖岛章', b.sandboxId, 'sb1');
eq('归 root', b.refCharId, 'root-ch1');

var g = td.get('ch1', 'sb1', NIGHT);
ok('同一天还在（一天一次）', !!g && g.mood === '有点闷');

ok('隔天作废（重算起点）', td.get('ch1', 'sb1', TOMORROW) === null);

/* 注入块：四段全空不给，有货才给 */
eq('全空不给', td.put('ch2', 'sb1', {}, MORNING) && td.buildContext('ch2', 'sb1', MORNING), '');
var ctx = td.buildContext('ch1', 'sb1', NIGHT);
ok('注入含四段', ctx.indexOf('心情：有点闷') !== -1 && ctx.indexOf('想你了') !== -1 && ctx.indexOf('周末有空吗') !== -1);
ok('注入带不复述指令', ctx.indexOf('别复述') !== -1);

/* buildPrompt：素材进 prompt */
var prompt = td.buildPrompt('小满', '【身边的人】\n- 阿蓝（发小）');
ok('prompt 带素材', prompt.indexOf('阿蓝') !== -1 && prompt.indexOf('小满') !== -1);

/* 皮套共享：root 相同的另一张皮套读到同一块 */
ok('皮套共享今日块', !!td.get('ch1-skin', 'sb1', NIGHT));

process.stdout.write('\n今日状态块：' + (total - failures) + '/' + total + ' 通过\n');
if (failures) process.exit(1);
