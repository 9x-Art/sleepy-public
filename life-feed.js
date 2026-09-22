/* ============================================================
   life-feed.js — L1.5 近期生活动态（v5 §L1.5）

   角色近期**实际看见**的跨 App 事件，是一层「近期视野」。
   v5 的原话：它是有上限的近期视野，不是永久常驻记录 ——
   超出窗口后仍然留在证据库（记忆库）和向量库里，只是不再每轮注入了。

   v5 列了五类源（朋友圈 / 日历临近 / Todo 完成延期 / 共同播放收藏照片 /
   角色自己的近期行为）。**v1 只做朋友圈**，原因：
     · 它是唯一一个「发出来就是给人看的」的源 —— 其余几类（日历、待办、日记）
       属于 user 私密内容，v5 §5 明说「默认不对角色开放，需要细分类别授权」，
       那是另一件事，得先有授权概念；
     · 朋友圈的可见性判断**已经存在**（三闸：账号隔离 / 朋友权限 / 可见范围），
       就在 page-moments.js，别再抄第二遍；
     · 体验上它是最能被立刻感觉到的那一条：我发完动态聊两句，TA 会提。

   不做的事（刻意的）：
     · 不注入别的角色/NPC 发的动态 —— 那是他自己世界里的事，模型本来就知道；
     · 不判断「这条是不是已经聊过了」（v5 有这条，但 v1 让模型自己看着办，
       文案里写清楚就行，别为它加一套检测）；
     · 不进向量库（那是 L4 的事，与这里无关）。

   依赖：store.js、core.js、page-moments.js（惰性取 momentsTab）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  /* 窗口：v5 §6.2 建议「最近 10～20 个有效动态包 + 7～14 天上限」，
     取中间偏保守 —— 它每轮都要进 prompt，宁可少而准。
     朋友圈本来就低频（一天几条），10 天 12 条大概能盖住最近几天的生活。 */
  var DAYS = 10;
  var LIMIT = 12;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dayText(at) {
    var d = new Date(typeof at === 'number' ? at : Date.parse(at || ''));
    if (isNaN(d.getTime())) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function momentsOf() {
    return Sleepy.momentsTab || null;
  }

  /* 这个角色近期看见的（按时间倒序，已按窗口裁过）。 */
  function recent(charId, userId, opts) {
    opts = opts || {};
    var M = momentsOf();
    if (!M || !M.listForChar) return [];
    if (!charId) return [];
    return M.listForChar(charId, userId, {
      days: opts.days || DAYS,
      limit: opts.limit || LIMIT
    });
  }

  /* 一条动态 —— 给模型看的是「时间 + 谁 + 说了什么 + 有没有人搭话」。
     互动只带最新一条评论：v5 说动态事件包要保留互动链，但注入层不需要
     整条链（那会把窗口挤没），最新一条足够让角色知道「这条底下热闹过」。 */
  function lineOf(m, charId) {
    var who = m.characterId === charId ? '你自己' : (m.name || '对方');
    var body = String(m.text || '').trim();
    if (!body) body = (m.mediaId || m.url) ? '（只发了一张图）' : '（空）';

    var tail = '';
    var likes = (m.likes || []).length;
    var cmts = m.comments || [];
    if (likes) tail += ' · ' + likes + ' 个赞';
    if (cmts.length) {
      var last = cmts[cmts.length - 1] || {};
      var who2 = String(last.name || '有人');
      var txt = String(last.text || '').trim().slice(0, 30);
      tail += ' · ' + cmts.length + ' 条评论（最新一条来自 ' + who2 +
        (txt ? '：' + txt : '') + '）';
    }
    return '- ' + dayText(m.at) + ' ' + who + '：' + body.slice(0, 60) + tail;
  }

  /* 注入文本。没有可说的就返回空串（槽位整块省略）。
     开头那句**必须**写清「不要逐条汇报 / 已经聊过就别再提」——
     v5 §主动关注原则里「避免追踪感」就是这个：这层信息的价值是让 TA
     不像失忆，不是让他变成行程播报。 */
  function text(charId, userId, opts) {
    var list = recent(charId, userId, opts);
    if (!list.length) return '';
    var lines = list.map(function (m) { return lineOf(m, charId); });
    return '[近期生活动态]\n' +
      '下面这些是你最近确实看到过或自己发过的（朋友圈）。想提的时候可以自然地' +
      '带一句，不必逐条回应，也不用当成刚刚发生 —— 已经聊过的就不用再提。\n' +
      lines.join('\n');
  }

  Sleepy.lifeFeed = {
    recent: recent,
    text: text,
    DAYS: DAYS,
    LIMIT: LIMIT
  };

})(window);
