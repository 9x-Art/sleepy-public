#!/usr/bin/env node
/* ============================================================
   scripts/revcheck-core-test.js — 反查手机核心单测（P0）

   期望值硬写；rand 注入保证判定可复现。
   跑法：node scripts/revcheck-core-test.js
   ============================================================ */
'use strict';

globalThis.Sleepy = {};
require('../revcheck-core.js');
var rv = globalThis.Sleepy.revcheck;

var failures = 0, total = 0;
function ok(name, cond, detail) {
  total++;
  if (cond) process.stdout.write('  \u2713 ' + name + '\n');
  else { failures++; process.stdout.write('  \u2717 ' + name + (detail ? '\n    ' + detail : '') + '\n'); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    '期望 ' + JSON.stringify(want) + ' / 实得 ' + JSON.stringify(got));
}

/* ---------------- 倾向推导 ---------------- */
eq('占有欲人设 → high', rv.deriveProclivity('她对小明占有欲极强，见不得他和别人说话'), 'high');
eq('尊重隐私人设 → low', rv.deriveProclivity('她很注重边界感，尊重隐私，从不过问他的事'), 'low');
eq('毫不在意 → none', rv.deriveProclivity('她对谁在做什么毫不在意，无所谓'), 'none');
eq('普通人设 → medium', rv.deriveProclivity('她是个便利店店员，喜欢猫'), 'medium');
eq('档位透传', rv.normalizeLevel('high'), 'high');
eq('非法档位回落推导', rv.normalizeLevel('随便'), 'medium');

/* ---------------- 触发闸 ---------------- */
var NOW = 1750000000000;
ok('概率 0（none）永不触发', rv.shouldAutoTrigger({ persona: '无所谓', lastAt: 0 }, 10, NOW, 0.001) === false);
ok('轮数不足不触发', rv.shouldAutoTrigger({ persona: 'high', lastAt: 0 }, 2, NOW, 0.001) === false);
ok('冷却未过不触发',
  rv.shouldAutoTrigger({ persona: 'high', lastAt: NOW - 5 * 60 * 1000 }, 10, NOW, 0.001) === false);
ok('冷却已过 + 命中概率 → 触发',
  rv.shouldAutoTrigger({ persona: 'high', lastAt: NOW - 21 * 60 * 1000 }, 5, NOW, 0.19) === true);
ok('冷却已过 + 未命中概率 → 不触发',
  rv.shouldAutoTrigger({ persona: 'high', lastAt: NOW - 21 * 60 * 1000 }, 5, NOW, 0.21) === false);
ok('low 要 rand < 0.05 才触发',
  rv.shouldAutoTrigger({ persona: 'low', lastAt: 0 }, 5, NOW, 0.04) === true &&
  rv.shouldAutoTrigger({ persona: 'low', lastAt: 0 }, 5, NOW, 0.06) === false);

/* ---------------- 用户意图 + 同意/拒绝 ---------------- */
ok('「你查一下我手机」命中', rv.isUserAsking('要不你查一下我手机呗'));
ok('「我的手机给你看」命中', rv.isUserAsking('我的手机给你看吧'));
ok('普通话不命中', rv.isUserAsking('今天天气不错') === false);
eq('high 基本同意', rv.consentOf('占有欲强', 0.5), 'agree');
eq('none 基本拒绝', rv.consentOf('无所谓', 0.5), 'decline');
ok('拒绝文案带傲娇（high）', rv.declineText('小满', '占有欲强').indexOf('小满') !== -1);
ok('拒绝文案尊重隐私（low）', rv.declineText('小满', '尊重隐私').indexOf('隐私') !== -1);
ok('同意文案（high）', rv.agreeText('占有欲强').indexOf('那我看了') !== -1);

/* ---------------- 权限面 ---------------- */
ok('缺省全开', rv.isPageAllowed('chat', {}) === true);
ok('显式关掉', rv.isPageAllowed('moments', { moments: false }) === false);
eq('页面中文名', rv.pageName('profile'), '微信账号');
eq('页面中文名（群声）', rv.pageName('forum'), '群声');

/* ---------------- 浏览计划 ---------------- */
var available = [
  { id: 'chat', targets: [
    { id: 'ch-1', name: '小满', chatId: 'ct-1' },
    { id: 'ch-2', name: '阿蓝', chatId: 'ct-2' }
  ] },
  { id: 'moments', name: '朋友圈' },
  { id: 'photos', name: '相册' },
  { id: 'diary', name: '日记' },
  { id: 'favorites', name: '收藏' },
  { id: 'profile', name: '微信账号' },
  { id: 'forum', name: '群声' }
];

var planHigh = rv.buildPlan(available, '占有欲强', {});
eq('high 全看（chat 展开 2 步 + 其余 6 = 8）', planHigh.length, 8);
eq('chat 展开成每对象一步', [planHigh[0].targetName, planHigh[1].targetName], ['小满', '阿蓝']);
eq('滑到谁读谁带 chatId', planHigh[0].chatId, 'ct-1');
eq('第二步是朋友圈', planHigh[2].page, 'moments');

var planMed = rv.buildPlan(available, '店员', {});
eq('medium 裁到 4 步', planMed.length, 4);

var planLow = rv.buildPlan(available, '尊重隐私', {});
eq('low 裁到 2 步', planLow.length, 2);

var planNone = rv.buildPlan(available, '无所谓', {});
eq('none 只看 1 步', planNone.length, 1);

/* 权限关掉 moments：计划里消失，后面补位 */
var planOff = rv.buildPlan(available, '店员', { moments: false });
ok('关掉的朋友圈不进计划', planOff.every(function (s) { return s.page !== 'moments'; }));

/* 孤岛：chat 没有其他对象 → 只有与 TA 自己的一步或不展开 */
var isleAvail = [
  { id: 'chat', targets: [{ id: 'ch-1', name: '小满', chatId: 'ct-1' }] },
  { id: 'moments', name: '朋友圈' },
  { id: 'profile', name: '微信账号' }
];
var planIsle = rv.buildPlan(isleAvail, '店员', {});
eq('孤岛 medium：chat 1 步 + moments + profile = 3', planIsle.length, 3);
eq('孤岛 chat 步对象是 TA 自己', planIsle[0].targetName, '小满');

/* 空岛：什么都没有 → 空计划 */
eq('空岛 → 空计划', rv.buildPlan([], '店员', {}).length, 0);

/* ---------------- 汇总文案 ---------------- */
var s1 = rv.buildSummary('小满',
  [{ pageName: '私聊（小满）', learned: '你和小蓝约了周末' }, { pageName: '朋友圈' }],
  ['他最近怎么总提小蓝']);
ok('汇总带想法', s1.indexOf('内心想着') !== -1 && s1.indexOf('小蓝约了周末') !== -1);
var s2 = rv.buildSummary('小满', [{ pageName: '朋友圈' }], []);
ok('无想法回落明细', s2.indexOf('记住了') !== -1 || s2.indexOf('知道了') !== -1);

/* ---------------- 邀请应答标签（v1.2 递手机） ---------------- */
var r1 = rv.parseAcceptTag('那我就不客气啦[[REV_ACCEPT]]');
eq('ACCEPT 识别', r1.accept, true);
eq('ACCEPT 剥净正文', r1.text, '那我就不客气啦');
eq('拒绝（无标签）', rv.parseAcceptTag('谁要看你手机啊').accept, false);
eq('拒绝也剥不存在的标签', rv.parseAcceptTag('谁要看你手机啊').text, '谁要看你手机啊');
eq('全角变体识别', rv.parseAcceptTag('【REV_ACCEPT】嘿嘿').accept, true);
eq('全角变体剥净', rv.parseAcceptTag('【REV_ACCEPT】嘿嘿').text, '嘿嘿');

/* ---------------- 主动起意（v1.3 剧情驱动，不掷骰） ---------------- */
var pk1 = rv.parsePeekTag('不行我必须看看你手机[[REV_PEEK]]');
eq('PEEK 识别', pk1.peek, true);
eq('PEEK 剥净正文', pk1.text, '不行我必须看看你手机');
eq('没起意', rv.parsePeekTag('今天天气不错').peek, false);
ok('保险丝：none 档拦', rv.canPeekNow({ persona: '毫不在意', lastAt: 0 }, NOW) === false);
ok('保险丝：冷却未过拦', rv.canPeekNow({ persona: '店员', lastAt: NOW - 5 * 60 * 1000 }, NOW) === false);
ok('保险丝：冷却已过放行', rv.canPeekNow({ persona: '店员', lastAt: NOW - 21 * 60 * 1000 }, NOW) === true);

process.stdout.write('\n反查核心：' + (total - failures) + '/' + total + ' 通过\n');
if (failures) process.exit(1);
