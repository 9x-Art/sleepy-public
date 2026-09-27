/* ============================================================
   page-collection.js — We 收藏馆（门厅 + 藏品详情，首轮纵向闭环）
   ------------------------------------------------------------
   定位（docs/勘察-We收藏馆-2026-09-27.md + 拍板 §二/§三）：
   收藏馆不占桌面格，只从 We 首页「去收藏馆 →」进入。
   首轮两层：门厅（馆名 + 关系标题 + 真实 weEntries 按 kind 分组 + 真实计数
   + We 语境空态 + 页面内滚动）；藏品详情（title / note / at / kind / createdBy
   / sourceType / sourceId/sourceRef / refCharId/refUserId / 来源是否仍存在 /
   来源失效时降级文案）。

   数据模型（拍板 §一）：不新增 weCollection 独立表，继续用 weEntries 做主表，
   在其上加可选 kind 字段（ticket/photo/letter/music/gift/place/other）。
   老记录没有 kind → 详情页按 'other' 兼容（复用 Sleepy.weStore.kindOf）。
   不改 favorites 结构；不自动搬任何聊天收藏/照片/票根进馆 ——
   只有用户主动创建/确认的 weEntry 才在馆里。

   隔离与生命周期（拍板 §六）：读一律走
     core.scopeId() / core.activeSandbox() / core.activeCharOnIsland()
     core.activeUserOnIsland() / core.scoped(store.get('weEntries'))
   不自维护 activeSandboxId，We 内不提供切岛入口。
   切岛后 onShow 重读重画 → 当前岛数据刷新；原岛藏品不可见，回岛恢复。
   详情页只打开当前 scoped 列表中的记录，禁止通过 params 跨岛读取任意 id
   —— 详情页按 id 在 scoped 列表里查找，找不到就显示「来源已不在」。

   来源复核（拍板 §四，本轮只复核 + 展示，不做跨 App 回源跳转）：
     sourceType/sourceId 为空        →「手动记录」
     原物存在                        → 来源类型 + 来源标题/摘要
     原物已完成（日历 completed）     →「来源已完成 · …」（有效历史来源，不算失效）
     原物已删除/取消                 → 对应降级文案（原对话已删除 / 该约定已取消
                                      / 原日历记录已删除 / 原图已删除 / 原作品已不在门厅）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;

  function arr(v) { return Array.isArray(v) ? v : []; }

  /* 分类中文名：优先用 weStore 导出的同款映射（老记录兼容逻辑同源），
     页面级兜底一份，避免依赖顺序问题。 */
  var KIND_LABEL = (Sleepy.weStore && Sleepy.weStore.KIND_LABEL) || {
    ticket: '票根', photo: '照片', letter: '信件', music: '音乐',
    gift: '礼物', place: '地方', other: '其他'
  };
  var KIND_ORDER = ['ticket', 'photo', 'letter', 'music', 'gift', 'place', 'other'];

  function kindOf(en) {
    return (Sleepy.weStore && Sleepy.weStore.kindOf) ? Sleepy.weStore.kindOf(en) :
      (KIND_ORDER.indexOf(en && en.kind) >= 0 ? en.kind : 'other');
  }

  /* 来源类型中文名（展示 + 复核用）。 */
  var SRC_LABEL = {
    manual: '手记', chat: '聊天', calendar: '日历', moments: '朋友圈',
    photo: '照片', offline: '线下', ticket: '票根'
  };
  function srcLabel(t) { return SRC_LABEL[t] || t || '未知'; }

  /* ------------------------- 来源复核 -------------------------
     只判断「原物是否还在」，不做跳转。返回 { status, text }：
       manual / gone / done / live
     done＝来源事件已完成，是有效历史来源，**不算失效**（保留原物）；
     复核口径跟随各真实数据源的当前状态，fail closed（拿不准就算 gone）。 */
  function checkSource(en) {
    var st = String(en.sourceType || '').trim();
    var id = en.sourceId || null;
    if (!st || st === 'manual' || !id) {
      return { status: 'manual', text: '手动记录' };
    }
    try {
      if (st === 'calendar') {
        /* 日历四态（语义红线：completed 是有效的历史来源，不算失效）：
           scheduled/pending/tentative/confirmed → live「来源仍在」
           completed                              → done「来源已完成」（保留，不算 gone）
           cancelled                              → gone「该约定已取消」（事件还在，只是取消了）
           事件不存在（真被删掉，只可能是草稿/生成日程）→ gone「原日历记录已删除」 */
        var cal = Sleepy.calendar;
        var ev = cal && cal.getEvent ? cal.getEvent(id) : null;
        if (!ev) {
          return { status: 'gone', text: '原日历记录已删除' };
        }
        if (ev.status === 'cancelled') {
          return { status: 'gone', text: '该约定已取消' };
        }
        if (ev.status === 'completed') {
          return { status: 'done', text: '日历 · ' + String(ev.title || '').trim() };
        }
        return { status: 'live', text: '日历 · ' + String(ev.title || '').trim() };
      }
      if (st === 'offline') {
        var off = Sleepy.offlineStore;
        var s = off && off.findSession ? off.findSession(id) : null;
        if (s) {
          return { status: 'live', text: '线下 · ' + String(s.title || s.name || '一段线下时光').slice(0, 40) };
        }
        return { status: 'gone', text: '那段线下时光已不在' };
      }
      if (st === 'chat') {
        /* 聊天收藏：favorites 里还能找到这条快照即原物仍在 */
        var fav = arr(store.get('favorites')).filter(function (f) {
          return f && (f.id === id || f.savedAt === en.at);
        });
        if (fav.length) return { status: 'live', text: '收藏 · ' + String(fav[0].content || '').slice(0, 40) };
        return { status: 'gone', text: '原对话已删除' };
      }
      if (st === 'photo') {
        var ph = Sleepy.photos;
        var found = ph && ph.all ? arr(ph.all()).some(function (p) { return p && p.id === id; }) : false;
        return found ? { status: 'live', text: '照片' } : { status: 'gone', text: '原图已删除' };
      }
      if (st === 'moments') {
        return { status: 'gone', text: '原作品已不在门厅' };
      }
      if (st === 'ticket') {
        /* 帷境票根：全局 wjTickets。**口径唯一**：weEntries.sourceId 引用的是
           票根**实体自身**的 ticket.id（'tk-' 前缀），不是 workId ——
           workId 指向 wjWorks 里的作品，若哪天要做「作品来源」是另一种
           sourceType 的语义，不许混用（本版没有这个类型，fail closed）。 */
        var ticks = arr(store.get('wjTickets'));
        if (ticks.some(function (t) { return t && t.id === id; })) {
          return { status: 'live', text: '票根' };
        }
        return { status: 'gone', text: '原票根已不在' };
      }
      /* 未知来源类型：不瞎猜，当「原物可能不在了」处理但不报错 */
      return { status: 'gone', text: '来源已不在' };
    } catch (e) {
      return { status: 'gone', text: '来源已不在' };
    }
  }

  /* ------------------------- 日期/身份工具 ------------------------- */
  function fmtDay(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var m = d.getMonth() + 1, dd = d.getDate();
    return (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }
  function fmtFull(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var y = d.getFullYear();
    return y + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* 关系标题：与 We 首页同口径（角色 × 我）。无身份时回退到岛名。 */
  function relationTitle(sid) {
    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (char && user) {
      return String(char.name || '未命名').trim() + ' × ' + core.labelOfUser(user, '我');
    }
    var sb = core.activeSandbox();
    return (sb && sb.name) ? sb.name : '收藏馆';
  }

  /* ------------------------- 读（隔离入口，唯一出口） -------------------------
     只读当前 scoped 的 weEntries，按时间倒序。切岛后 onShow 重读即换批。 */
  function entries() {
    return core.scoped(arr(store.get('weEntries'))).slice().sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    });
  }

  /* 详情页按 id 只在当前 scoped 列表里找 —— 杜绝跨岛任意 id 读取 */
  function findInScope(id) {
    var list = entries();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ------------------------- 门厅 ------------------------- */
  function paintHall(ctx) {
    ctx.setTitle('收藏馆');
    ctx.setActions([]);

    var body = ctx.body;
    body.innerHTML = '';
    var shell = h('div', 'we-page-paper co-page co-hall');

    var sid = core.scopeId();
    var list = entries();

    /* 封面：馆名 + 关系标题 */
    var cover = h('div', 'we-cover co-cover');
    cover.appendChild(h('div', 'we-cover-vert', 'COLLECTION'));
    var ct = h('div', 'we-cover-txt');
    ct.appendChild(h('div', 'we-cover-kicker', 'W E · 收 藏 馆'));
    ct.appendChild(h('div', 'we-cover-title', relationTitle(sid)));
    ct.appendChild(h('div', 'we-cover-sub', '替你们把舍不得的，一件件收好。'));
    cover.appendChild(ct);
    shell.appendChild(cover);

    /* 计数条：馆藏总数 */
    var factsBar = h('div', 'we-facts');
    factsBar.appendChild(factCell(list.length, '馆 藏 总 数'));
    factsBar.appendChild(factCell(countKind(list, 'ticket'), '票 根'));
    factsBar.appendChild(factCell(countKind(list, 'photo'), '照 片'));
    shell.appendChild(factsBar);

    /* 空态：We 语境 */
    if (!list.length) {
      var emptyBox = h('div', 'empty co-empty');
      emptyBox.appendChild(h('div', 'empty-paper'));
      emptyBox.appendChild(h('p', 'empty-text', '这里还空着。'));
      emptyBox.appendChild(h('p', 'empty-hint', '回到 We 首页「记一条」，把值得留下的东西收进来。'));
      shell.appendChild(emptyBox);
      body.appendChild(shell);
      return;
    }

    /* 按 kind 分组（保持 KIND_ORDER 顺序，空组不渲染） */
    var section = h('div', 'co-sections');
    var seen = {};
    list.forEach(function (en) { seen[kindOf(en)] = true; });
    KIND_ORDER.forEach(function (k) {
      if (!seen[k]) return;
      var items = list.filter(function (en) { return kindOf(en) === k; });
      var sec = h('div', 'we-sec');
      var head = h('div', 'we-sec-head');
      head.appendChild(h('span', 'we-sec-no', String(items.length).padStart ? ('0' + items.length).slice(-2) : items.length));
      head.appendChild(h('span', 'we-sec-title', KIND_LABEL[k] || '其他'));
      sec.appendChild(head);

      var grid = h('div', 'co-grid');
      items.forEach(function (en) {
        var card = h('button', 'co-card');
        card.type = 'button';
        var kHead = h('div', 'co-card-head');
        kHead.appendChild(h('span', 'co-card-title', en.title || '（未命名）'));
        kHead.appendChild(h('span', 'co-card-day', fmtDay(en.at)));
        card.appendChild(kHead);
        if (en.note) card.appendChild(h('p', 'co-card-note', en.note));
        var src = checkSource(en);
        var foot = h('div', 'co-card-src' + (src.status === 'gone' ? ' is-gone' : ''));
        foot.appendChild(h('span', '', src.status === 'manual'
          ? '手记'
          : (src.status === 'gone' ? src.text : '来自 ' + srcLabel(en.sourceType))));
        card.appendChild(foot);
        card.onclick = function () {
          if (Sleepy.nav) Sleepy.nav.open('collection-item', { id: en.id });
        };
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      section.appendChild(sec);
    });
    shell.appendChild(section);

    body.appendChild(shell);
  }

  function countKind(list, k) {
    var n = 0;
    list.forEach(function (en) { if (kindOf(en) === k) n++; });
    return n;
  }

  function factCell(n, label) {
    var c = h('div', 'we-fact');
    c.appendChild(h('b', '', String(n)));
    c.appendChild(h('span', '', label));
    return c;
  }

  /* ------------------------- 藏品详情 ------------------------- */
  function paintDetail(ctx, id) {
    ctx.setTitle('藏品');
    ctx.setActions([]);

    var body = ctx.body;
    body.innerHTML = '';
    var shell = h('div', 'we-page-paper co-page co-detail');

    /* 只在当前 scoped 列表里找 —— 跨岛/任意 id 一律按「不在」降级 */
    var en = findInScope(id);
    if (!en) {
      var gone = h('div', 'empty co-empty');
      gone.appendChild(h('div', 'empty-paper'));
      gone.appendChild(h('p', 'empty-text', '这件藏品不在眼前。'));
      gone.appendChild(h('p', 'empty-hint', '它可能属于另一座岛，或已经被移走。'));
      shell.appendChild(gone);
      body.appendChild(shell);
      return;
    }

    var k = kindOf(en);
    var src = checkSource(en);

    /* 详情头：分类章 + 标题 + 日期 */
    var head = h('div', 'co-detail-head');
    head.appendChild(h('div', 'co-detail-kind', (KIND_LABEL[k] || '其他') + ' · ' + srcLabel(en.sourceType)));
    head.appendChild(h('h2', 'co-detail-title', en.title || '（未命名）'));
    if (en.at) head.appendChild(h('p', 'co-detail-date', fmtFull(en.at)));
    shell.appendChild(head);

    /* 正文：note */
    if (en.note) {
      var noteBox = h('div', 'co-detail-note');
      noteBox.appendChild(h('p', '', en.note));
      shell.appendChild(noteBox);
    }

    /* 来源状态 */
    var srcBox = h('div', 'co-src-box');
    if (src.status === 'manual') {
      srcBox.appendChild(h('div', 'co-src-line', '这是一条手动记录，没有来源。'));
    } else if (src.status === 'live') {
      srcBox.appendChild(h('div', 'co-src-line co-src-live', '来源仍在 · ' + src.text));
    } else if (src.status === 'done') {
      /* 已完成的事件是有效历史来源：保留展示，**不显示**「原物已不在」 */
      srcBox.appendChild(h('div', 'co-src-line co-src-live', '来源已完成 · ' + src.text));
    } else {
      srcBox.appendChild(h('div', 'co-src-line co-src-gone', src.text + '（原物已不在）'));
    }
    shell.appendChild(srcBox);

    /* 档案卡：可复制的字段明细 */
    var meta = h('div', 'co-meta');
    meta.appendChild(metaRow('分类', KIND_LABEL[k] || '其他'));
    meta.appendChild(metaRow('来源', srcLabel(en.sourceType) +
      (en.sourceRef ? ' · ' + String(en.sourceRef).slice(0, 40) : '')));
    meta.appendChild(metaRow('创建', en.createdBy === 'user' ? '我' : (en.createdBy || '我')));
    if (en.refCharId || en.refUserId) {
      meta.appendChild(metaRow('归属', charName(en.refCharId) + (userName(en.refUserId) ? ' · ' + userName(en.refUserId) : '')));
    }
    shell.appendChild(meta);

    body.appendChild(shell);
  }

  function metaRow(k, v) {
    var r = h('div', 'co-meta-row');
    r.appendChild(h('span', 'co-meta-k', k));
    r.appendChild(h('span', 'co-meta-v', v || '—'));
    return r;
  }

  function charName(id) {
    if (!id) return '';
    try {
      var c = core.findChar(id);
      return (c && c.name) ? c.name : '';
    } catch (e) { return ''; }
  }
  function userName(id) {
    if (!id) return '';
    try {
      var u = core.findUser(id);
      return (u && u.name) ? u.name : '';
    } catch (e) { return ''; }
  }

  /* ------------------------- 注册 -------------------------
     门厅与藏品详情用两个独立页面 id：
       'collection'        门厅（无 params）
       'collection-item'   藏品详情（params.id）
     拆开的原因：nav.open 对同一 id 是**复用栈内那一条 + applyParams 重渲染**，
     若详情也注册成 'collection'，从详情返回会直接把整个 collection 弹掉（回到桌面），
     而不是回到门厅。参照 wj-foyer → wj-work 的「列表 → 详情」分页惯例。
     详情页仍只在当前 scoped 列表里按 id 查找 —— 跨岛/任意 id 一律按「不在」降级。 */

  function paintHallSafe(ctx) { paintHall(ctx); }
  function paintDetailSafe(ctx) {
    var id = ctx.params && ctx.params.id;
    paintDetail(ctx, id);
  }

  Sleepy.register('collection', {
    title: '收藏馆',
    render: function (ctx) {
      ctx.__paint = function () { paintHallSafe(ctx); };
      paintHallSafe(ctx);
    },
    /* onShow 每次进页 / 切岛都重读重画 —— 保证切岛后不串线、回岛恢复 */
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

  Sleepy.register('collection-item', {
    title: '藏品',
    render: function (ctx) {
      ctx.__paint = function () { paintDetailSafe(ctx); };
      paintDetailSafe(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

  /* 导出供冒烟/真机核对：复核状态、只读当前房、kind 兼容 */
  Sleepy.collectionStore = {
    entries: entries,
    findInScope: findInScope,
    checkSource: checkSource,
    kindOf: kindOf,
    KIND_LABEL: KIND_LABEL
  };

})(window);
