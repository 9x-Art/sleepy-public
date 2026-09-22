/* ============================================================
   life-feed.js — L1.5 近期生活动态（v5 §L1.5）

   角色近期**实际看见 / 实际发生**的跨 App 事件，是一层「近期视野」。
   v5 的原话：它是有上限的近期视野，不是永久常驻记录 ——
   超出窗口后仍然留在证据库（记忆库）和向量库里，只是不再每轮注入了。

   ─── 三个源，三层过滤（这是「授权」落地的地方）─────────────────

   ① 朋友圈     看得见谁 = 三道闸（账号隔离 / 朋友权限 / 可见范围），
                实现在 page-moments.js 的 canCharSee + listForChar。
   ② 日历       **每条事件自己就带可见性**（visibility 四档 + createdBy），
                这是项目里本来就有的设计，不用另造一套授权：
                  · createdBy 是 TA 自己         → 全知道（他自己的安排）
                  · shared_detail                → 全知道
                  · shared_busy                  → **只知道那个时段有事**
                  · participants 且 TA 在名单里   → 全知道
                  · private 且是 user 建的        → 不知道
                作息表（char_schedule）不收：那是日常背景，不是「临近事项」，
                I02 时间事实已经给了作息感，再注一遍只会占位。
   ③ 日记       author='char' 且是这个角色 → 天然可见（他自己的行为）；
                author='user'（我写的）      → **要我授权**，默认关。
                授权读写：store['lifeShare:<charId>'] = { diary: true }

   ★ 一句话记住这条红线：**「我能看到」不等于「TA 能看到」。**
     日历页是上帝视角（user 能看见全部，靠 visText 标注），L1.5 是 TA 的视角。
     两边共用一个 eventsOf 会串味 —— 所以这里自己判，判据是 visibility/createdBy。

   ─── 不做的（刻意的）───────────────────────────────────────
   · 别的角色/NPC 发的朋友圈 —— 那是他自己世界里的事，模型本来就知道；
   · 判断「这事是不是已经聊过了」（v5 有这条，让模型自己看着办，别为它加检测）；
   · 进向量库（那是 L4 的事，与这里无关）。

   依赖：store.js、core.js、page-moments.js、calendar.js、page-diary.js
        （前两个必须，后三个惰性取 —— 排在本文件之后加载也能用）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  /* 窗口：v5 §6.2 建议「最近 10～20 个有效动态包 + 7～14 天上限」，
     每类取偏保守 —— 它每轮都要进 prompt，宁可少而准。 */
  var DAYS = 10;        /* 朋友圈回溯天数 */
  var LIMIT = 8;        /* 朋友圈最多几条 */
  var CAL_DAYS = 7;     /* 日历往前后看几天 */
  var CAL_LIMIT = 4;    /* 日历最多几条（接下来的事，太多了会变成行程表） */
  var DIARY_DAYS = 10;  /* 日记回溯天数 */
  var DIARY_LIMIT = 3;

  var SHARE_KEY = 'lifeShare:';   /* + charId → { diary: true } */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dayTextOf(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* 未来的日子要说人话（「明天」比「09-23」更容易让模型自然用上）。 */
  function whenText(iso, inDays) {
    if (inDays === 0) return '今天';
    if (inDays === 1) return '明天';
    if (inDays === 2) return '后天';
    if (inDays > 2) return String(iso).slice(5) + '（' + inDays + ' 天后）';
    return String(iso).slice(5);
  }

  /* ---------------------------- ① 朋友圈 ---------------------------- */

  function momentsItems(charId, userId, opts) {
    var M = Sleepy.momentsTab;
    if (!M || !M.listForChar || !charId) return [];
    var list = M.listForChar(charId, userId, {
      days: opts.days || DAYS,
      limit: opts.momentLimit || LIMIT
    });
    return list.map(function (m) {
      /* 给模型看的是「时间 + 谁 + 说了什么 + 有没有人搭话」。
         互动只带最新一条评论：v5 说动态事件包要保留互动链，但注入层
         不需要整条链（那会把窗口挤没），最新一条足够让 TA 知道「底下热闹过」。 */
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
      return {
        at: typeof m.at === 'number' ? m.at : Date.parse(m.at || '') || 0,
        line: '- ' + dayTextOf(m.at) + ' ' + who + '：' + body.slice(0, 60) + tail
      };
    });
  }

  /* ---------------------------- ② 日历 ---------------------------- */

  /* 这条日历事件，**这个角色**能看到多少？返回 'detail' | 'busy' | ''（看不到）。
     判据只用 createdBy + visibility —— 刻意不看 ownerCharId：
     用户建一条挂在他名下的「提醒：给他买礼物」也是 ownerCharId=char，
     但那显然不该让他知道。 */
  function charViewOf(e, charId) {
    if (!e) return '';
    var by = e.createdBy || {};
    if (by.type === 'char' && by.id === charId) return 'detail';   /* 他自己安排的 */
    var v = e.visibility || 'private';
    if (v === 'shared_detail') return 'detail';
    if (v === 'shared_busy') return 'busy';                        /* 只知道那会儿有事 */
    if (v === 'participants') {
      var hit = (e.participants || []).some(function (p) {
        return p && p.type === 'char' && p.id === charId;
      });
      return hit ? 'detail' : '';
    }
    return '';   /* private 且不是我建的 → 他不知道 */
  }

  function calendarItems(charId, opts) {
    var cal = Sleepy.calendar;
    if (!cal || !cal.upcoming || !charId) return [];
    var days = opts.calDays || CAL_DAYS;
    var out = [];
    cal.upcoming(charId, days).forEach(function (r) {
      var e = r.event;
      if (!e || e.status === 'cancelled' || e.status === 'completed') return;
      /* 作息表不收：那是日常背景，不是「临近事项」 */
      if (e.eventType === 'char_schedule') return;
      var view = charViewOf(e, charId);
      if (!view) return;
      var when = whenText(r.date, r.inDays);
      var time = cal.timeOf ? (cal.timeOf(e.startAt) || '') : '';
      var head = '- ' + when + (time ? ' ' + time : '') + ' ';
      var line;
      if (view === 'busy') {
        /* 这一档是项目里**本来就有**的「只显示忙不显示内容」——
           必须把「不知道是什么」说出来，否则模型会自己编一个内容填上。 */
        line = head + '你有一段时间被占住了（只显示忙，你并不知道具体是什么事）';
      } else {
        var title = String(e.title || '').trim();
        if (!title) return;
        line = head + title;
        var desc = String(e.desc || '').trim();
        if (desc) line += '（' + desc.slice(0, 30) + '）';
      }
      out.push({ at: Date.now() + (r.inDays || 0) * 86400000, line: line });
    });
    return out.slice(0, opts.calLimit || CAL_LIMIT);
  }

  /* ---------------------------- ③ 日记 ---------------------------- */

  function diaryShared(charId) {
    var s = store.get(SHARE_KEY + charId);
    return !!(s && s.diary);
  }

  function setDiaryShared(charId, on) {
    var cur = store.get(SHARE_KEY + charId) || {};
    var next = {};
    for (var k in cur) {
      if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k];
    }
    next.diary = !!on;
    return store.set(SHARE_KEY + charId, next);
  }

  function diaryItems(charId, opts) {
    var D = Sleepy.diary;
    if (!D || !D.list || !charId) return [];
    var granted = diaryShared(charId);
    var floor = Date.now() - (opts.diaryDays || DIARY_DAYS) * 86400000;
    var out = [];
    D.list().forEach(function (it) {
      if (!it || !it.content) return;
      if (typeof it.timestamp === 'number' && it.timestamp < floor) return;
      var isChar = it.author === 'char';
      if (isChar) {
        /* 他自己写的日记 —— 只有挂在他名下那几篇才算他的 */
        if (it.charId !== charId) return;
      } else if (!granted) {
        return;   /* 我写的：默认关，要我授权 */
      }
      var who = isChar ? '你自己写的一篇' : '她写的一篇';
      out.push({
        at: it.timestamp || 0,
        line: '- ' + dayTextOf(it.timestamp) + ' ' + who + '：' +
          String(it.content).replace(/\s+/g, ' ').trim().slice(0, 60)
      });
    });
    return out.sort(function (a, b) { return b.at - a.at; })
      .slice(0, opts.diaryLimit || DIARY_LIMIT);
  }

  /* ---------------------------- 组装 ---------------------------- */

  function collect(charId, userId, opts) {
    opts = opts || {};
    var groups = [
      { title: '你最近看到的', items: momentsItems(charId, userId, opts) },
      { title: '你接下来的安排', items: calendarItems(charId, opts) },
      { title: '你写下的', items: diaryItems(charId, opts) }
    ];
    return groups.filter(function (g) { return g.items.length; });
  }

  function recent(charId, userId, opts) {
    return collect(charId, userId, opts).reduce(function (acc, g) {
      return acc.concat(g.items);
    }, []);
  }

  /* 注入文本。一个源都没有就返回空串（槽位整块省略）。
     开头那句**必须**写清「不要逐条汇报 / 已经聊过就别再提」——
     v5 §主动关注原则里「避免追踪感」就是这个：这层信息的价值是让 TA
     不像失忆，不是让他变成行程播报。 */
  function text(charId, userId, opts) {
    var groups = collect(charId, userId, opts);
    if (!groups.length) return '';
    var blocks = ['[近期生活动态]',
      '下面这些是你最近确实看到过、或你自己生活里将要发生的。想提的时候可以自然地' +
      '带一句，不必逐条回应，也不用当成刚刚发生 —— 已经聊过的就不用再提。'];
    groups.forEach(function (g) {
      blocks.push('');
      blocks.push('[' + g.title + ']');
      g.items.forEach(function (it) { blocks.push(it.line); });
    });
    return blocks.join('\n');
  }

  Sleepy.lifeFeed = {
    text: text,
    recent: recent,
    diaryShared: diaryShared,
    setDiaryShared: setDiaryShared,
    charViewOf: charViewOf,
    DAYS: DAYS,
    LIMIT: LIMIT,
    CAL_DAYS: CAL_DAYS,
    DIARY_LIMIT: DIARY_LIMIT
  };

})(window);
