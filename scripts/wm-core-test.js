#!/usr/bin/env node
/* ============================================================
   scripts/wm-core-test.js — 文字麻将引擎单测（P0）

   红线自查：
   · 期望值硬写字符串，不引被测常量（断言里的期望不许引被测常量）
   · 终局/胜负判据落在装配产物（hands/melds/status）上，不数 log 条数
   跑法：node scripts/wm-core-test.js（pnpm check 全绿之外单独跑）
   ============================================================ */
'use strict';

globalThis.Sleepy = {};
require('../wm-core.js');
var wm = globalThis.Sleepy.wm;

var failures = 0;
var total = 0;
function eq(name, got, want) {
  total++;
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) process.stdout.write('  \u2713 ' + name + '\n');
  else { failures++; process.stdout.write('  \u2717 ' + name + '\n    期望 ' + w + '\n    实得 ' + g + '\n'); }
}
function ok(name, cond) { total++; if (cond) process.stdout.write('  \u2713 ' + name + '\n'); else { failures++; process.stdout.write('  \u2717 ' + name + '\n'); } }

/* ---------------- 牌库 ---------------- */
(function () {
  var deck = wm.buildDeck();
  eq('牌库总数 144', deck.length, 144);
  eq('牌 id 确定性（首张）', deck[0].id, 'emotion-0');
  eq('牌 id 确定性（末张）', deck[deck.length - 1].id, 'supplement-143');

  var dealt = wm.dealForTwo(deck);
  eq('发牌各 13 张', [dealt.hands[0].length, dealt.hands[1].length], [13, 13]);
  eq('牌墙 = 144-26', dealt.wall.length, 118);

  var ids = new Set();
  deck.forEach(function (c) { ids.add(c.id); });
  eq('id 无重复', ids.size, 144);
})();

/* ---------------- 开局与摸牌 ---------------- */
(function () {
  var g = wm.createGame('chat-1', '小眠');
  ok('开局 playing', g.status === 'playing');
  eq('开局各 13 张', [g.hands[0].length, g.hands[1].length], [13, 13]);
  eq('牌墙 118', g.wall.length, 118);

  var g2 = wm.drawCard(g, 0);
  eq('摸牌后手 14', g2.hands[0].length, 14);
  eq('摸牌后墙 117', g2.wall.length, 117);
  ok('摸牌后 drawnThisTurn', g2.drawnThisTurn === true);
  ok('原状态不变（纯函数）', g.hands[0].length === 13 && g.wall.length === 118);
})();

/* ---------------- 出牌与胜负 ---------------- */
(function () {
  var g = wm.createGame('chat-1', '小眠');
  // 用确定性牌组：直接从手里挑 3 张打出（不依赖词库，引擎只管清牌）
  var tiles = g.hands[0].slice(0, 3);
  var sentence = tiles.map(function (c) { return c.char; }).join('');
  var g2 = wm.playPhrase(g, 0, tiles, sentence);
  eq('出牌后手 10', g2.hands[0].length, 10);
  eq('出牌后组合 1 组', g2.melds[0].length, 1);
  eq('组合句子与打出一致', g2.melds[0][0].map(function (c) { return c.char; }).join(''), sentence);
  ok('没赢（还剩 10 张）', g2.status === 'playing');

  // 一口气出空 → 赢。用 cloneState 副本把 10 张全打成一组
  var g3 = wm.cloneState(g2);
  var rest = g3.hands[0].slice();
  var g4 = wm.playPhrase(g3, 0, rest, rest.map(function (c) { return c.char; }).join(''));
  eq('出空后手 0', g4.hands[0].length, 0);
  ok('出空 → finished', g4.status === 'finished');
  ok('user 获胜', g4.winner === 0);
  ok('终局不再受理出牌', wm.playPhrase(g4, 1, g4.hands[1].slice(0, 3), '随便') === g4);
})();

/* ---------------- 牌墙流局 ---------------- */
(function () {
  var g = wm.createGame('chat-1', '小眠');
  // 把墙直接清空（装配产物上做判据，不绕引擎内部）
  var g2 = wm.cloneState(g); g2.wall = [];
  // 手牌张数不同：user 13 vs char 13 → 相等；改成不等验证两向
  g2.hands[1] = g2.hands[1].slice(0, 12);   // char 12 张 < user 13 张
  var g3 = wm.drawCard(g2, 0);              // 墙空触发结算
  ok('墙空且 char 剩少 → char 胜', g3.status === 'finished' && g3.winner === 1);

  var g4 = wm.cloneState(g); g4.wall = [];
  var g5 = wm.drawCard(g4, 0);
  ok('墙空剩牌相等 → 流局', g5.status === 'finished' && g5.isDraw === true && g5.winner === null);
})();

/* ---------------- partial 摘牌 ---------------- */
(function () {
  var deck = wm.buildDeck();
  // 找「你真狗」：你的 emotion-2/3 + 真 adjective + 狗 noun —— 直接从牌库里点名气
  var byChar = function (deck, ch) { return deck.filter(function (c) { return c.char === ch; }); };
  var played = [byChar(deck, '你')[0], byChar(deck, '真')[0], byChar(deck, '狗')[0]];
  var r = wm.tilesForPassWords(played, ['真狗']);
  eq('partial 摘出 2 张', r.accepted.length, 2);
  eq('partial 句子', r.sentence, '真狗');

  var r2 = wm.tilesForPassWords(played, ['不存在的词']);
  eq('partial 摘不到 → 空', r2.accepted.length, 0);
})();

/* ---------------- 兜底判词 ---------------- */
(function () {
  ok('整句命中词库 → ok', wm.judgePhrase('我想你').ok === true);
  ok('含词库词 → ok', wm.judgePhrase('真的好吃吗').ok === true);
  ok('胡说八道 → 不 ok', wm.judgePhrase('桌飞北喜').ok === false);
  ok('太短 → 不 ok', wm.judgePhrase('好吃').ok === false);
  ok('兜底选牌能出句或null', (function () {
    var g = wm.createGame('c', 'x');
    var pick = wm.charHeuristicPick(g.hands[1]);
    return pick === null || (pick.tiles.length >= 3 && wm.judgePhrase(pick.sentence).ok);
  })());
})();

/* ---------------- 标签解析（P3 口径，宽容匹配） ---------------- */
(function () {
  var r1 = wm.parseWmTags('你真狗吗哈哈哈哈[[WM_PASS]]');
  ok('PASS 识别', r1.pass === true && !r1.reject && !r1.partial);
  eq('PASS 剥净正文', r1.text, '你真狗吗哈哈哈哈');

  var r2 = wm.parseWmTags('【WM_PARTIAL:真狗｜好狗】别的都不认！');
  eq('PARTIAL 词组', r2.partial.words, ['真狗', '好狗']);
  eq('PARTIAL 剥净正文', r2.text, '别的都不认！');

  var r3 = wm.parseWmTags('这什么鬼东西[[WM_REJECT]]');
  ok('REJECT 识别', r3.reject === true);

  var r4 = wm.parseWmTags('看我的！[[WM_PLAY:钱|少|了]]');
  eq('PLAY 字序列', r4.play.chars, ['钱', '少', '了']);
  eq('PLAY 剥净正文', r4.text, '看我的！');

  // 全角分隔符、全角冒号
  var r5 = wm.parseWmTags('吃我这个[[WM_PLAY：牛｜肉｜面]]');
  eq('PLAY 全角变体', r5.play.chars, ['牛', '肉', '面']);

  // 无标签 → 原样（无标签剥不动）
  eq('无标签原样', wm.parseWmTags('今天天气不错').text, '今天天气不错');

  // stripWmTags 独立剥（无对局时防泄漏）
  eq('strip 独立', wm.stripWmTags('aaa[[wm_play:a|b|c]]bbb'), 'aaabbb');
})();

/* ---------------- 上下文注入块 ---------------- */
(function () {
  var g = wm.createGame('chat-1', '小眠');
  var wmState = { game: g, pending: null, charLastPlay: null };
  var ctx = wm.buildContext('chat-1', wmState, { user: '阿宝', char: '小眠' });
  ok('注入块非空', ctx.length > 100);
  ok('含 TA 手牌（有字的序列）', ctx.indexOf('【你手里的字】') !== -1);
  ok('含牌墙张数 118', ctx.indexOf('剩 118 张') !== -1);
  ok('含出牌机会分支', ctx.indexOf('[[WM_PLAY') !== -1);
  ok('不属于本对话 → 空', wm.buildContext('chat-2', wmState, {}) === '');

  var wmP = { game: g, pending: { sentence: '你真狗', tiles: [] }, charLastPlay: null };
  ok('pending 分支提醒当裁判', wm.buildContext('chat-1', wmP, {}).indexOf('待你裁决') !== -1);
  var wmC = { game: g, pending: null, charLastPlay: { sentence: '我想你', tiles: [] } };
  ok('charLastPlay 分支等裁决', wm.buildContext('chat-1', wmC, {}).indexOf('等 ta 裁决') !== -1);

  var gEnd = wm.cloneState(g); gEnd.status = 'finished';
  ok('终局不注入', wm.buildContext('chat-1', { game: gEnd }, {}) === '');
})();

process.stdout.write('\n文字麻将引擎：' + (total - failures) + '/' + total + ' 通过\n');
if (failures) { process.exit(1); }
