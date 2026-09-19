/* ============================================================
   page-calendar.js — 日历 App（桌面第 3 屏的入口）

   注册三个页面：
     calendar        月历主页（孤岛直达；群岛先过一层选人）
     calendar-new    新建（我的提醒 / 邀请 char）
     calendar-event  日程详情（按类型给不同操作）

   两个底部弹层在 calendar 页内部：**设置** 与 **留痕候选**。
   （照 Demo v1 的分工；Demo 里那个「仅供 DEMO 验收」的世界切换器
   按总纲 §2.3 **不带进正式产品** —— 世界类型直接读 core.activeSandbox().kind。）

   ---- 视觉 ----
   结构照 Demo，配色**不搬**：Demo 是米白底 + 鼠尾草绿 + 大圆角，
   项目是纯白 + 焦糖。所以这里一律走 --g-*，圆角克制、能不留框就不留。

   ---- 红线 ----
   本文件 0 次模型调用（总纲 §13.1）。所有数据走 Sleepy.calendar。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var core = Sleepy.core;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var button = ui.button;

  function C() { return Sleepy.calendar; }
  function DATA() { return Sleepy.calendarData; }

  /* ---------------------------- 文案表 ---------------------------- */

  var TYPE_LABEL = {
    public_holiday: '公共日期',
    cultural_day: '文化节日',
    char_schedule: '角色日程',
    user_reminder: '我的提醒',
    shared_event: '共同事件',
    anniversary: '纪念日'
  };
  var STATUS_LABEL = {
    pending: '待确认', confirmed: '已确定', in_progress: '进行中',
    completed: '已完成', cancelled: '已取消'
  };
  /* 左边那条色带：公共日期金、角色日程焦糖、纪念日玫棕。
     不用蓝（项目审美红线）。 */
  var TYPE_TONE = {
    public_holiday: 'gold',
    cultural_day: 'gold',
    char_schedule: 'sage',
    user_reminder: 'accent',
    shared_event: 'accent',
    anniversary: 'rose'
  };

  var WEEK_HEAD = ['日', '一', '二', '三', '四', '五', '六'];

  /* ---------------------------- 小工具 ---------------------------- */

  function ic(body, size) {
    var s = size || 24;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var IC_BACK = ic('<path d="M15 18l-6-6 6-6"/>', 18);
  var IC_PREV = ic('<path d="M15 5l-7 7 7 7"/>', 16);
  var IC_NEXT = ic('<path d="M9 5l7 7-7 7"/>', 16);
  var IC_PLUS = ic('<path d="M12 5v14M5 12h14"/>', 20);
  var IC_CLOSE = ic('<path d="M6 6l12 12M18 6L6 18"/>', 15);

  function ph(charName) { return (charName || '他'); }

  /* 编辑用的纯文本弹窗走 ui.prompt（项目既有件），
     选日期/时间用原生 date/time input —— 移动端本来就弹原生选择器，
     自己画一套滚轮反而难用。 */
  function textInput(type, value) {
    var el = h('input', 'cal-input');
    el.type = type;
    if (value) el.value = value;
    return el;
  }

  /* ---------------------------- 底弹层 ---------------------------- */

  function openSheet(ctx, title, buildBody) {
    var mask = h('div', 'cal-sheet-mask');
    var sheet = h('div', 'cal-sheet');
    var head = h('div', 'cal-sheet-head');
    head.appendChild(h('b', 'cal-sheet-title', title));
    var close = h('button', 'cal-sheet-close');
    close.type = 'button';
    close.innerHTML = IC_CLOSE;
    close.addEventListener('click', function () { mask.remove(); });
    head.appendChild(close);
    sheet.appendChild(head);
    var body = h('div', 'cal-sheet-body');
    sheet.appendChild(body);
    mask.appendChild(sheet);
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    ctx.el.appendChild(mask);
    /* 下一帧再加 is-open —— 同一帧加类浏览器不会跑过渡，弹层会「闪一下」 */
    setTimeout(function () { mask.classList.add('is-open'); }, 16);
    buildBody(body, function () { mask.remove(); });
    return mask;
  }

  /* ---------------------------- 日事件列表 ---------------------------- */

  /* 公共日期不是「事件」，它是客观背景（总纲 §3.1）—— char 改不了，
     所以这里把它拼成只读行放在最前面，而不是塞进事件表。 */
  function dayItems(charId, iso, cfg) {
    var c = C();
    var info = c.dayInfo(iso, cfg);
    var out = [];
    if (info.legal) {
      out.push({
        readonly: true, type: 'public_holiday', title: info.legal.name,
        desc: '公共日期 · ' + c.regionMeta(cfg.region).label +
          (info.legal.kind === 'workday_adjustment' ? ' · 官方调休上班日' : ''),
        tag: info.legal.tag
      });
    }
    info.festivals.forEach(function (f) {
      if (info.legal && info.legal.name === f.name) return;  /* 春节不重复出两条 */
      out.push({
        readonly: true, type: 'cultural_day', title: f.name,
        desc: '文化日期 · ' + f.group, tag: f.soft ? '纪念日' : '节日'
      });
    });
    c.visibleEventsOn(charId, iso, cfg).forEach(function (e) {
      out.push({ readonly: false, type: e.eventType, ev: e, id: e.id, title: e.title, desc: eventDesc(e), tag: statusTag(e) });
    });
    return out;
  }

  function eventDesc(e) {
    var c = C();
    var t = e.allDay ? '全天' : (c.timeOf(e.startAt) + (e.endAt && c.timeOf(e.endAt) ? '—' + c.timeOf(e.endAt) : ''));
    var who = e.createdBy && e.createdBy.type === 'char' ? '他定的' : '你定的';
    if (e.eventType === 'anniversary') {
      return t + ' · 来自留痕' + (e.meaningType === 'shared_confirmed' ? ' · 双方确认' : ' · 只对他有意义');
    }
    if (e.eventType === 'shared_event') {
      var mine = (e.participantStates && e.participantStates.user) || 'pending';
      return t + ' · 共同事件 · 你' + (mine === 'accepted' ? '已答应' : '还没表态');
    }
    return t + ' · ' + who + (e.repeatRule ? ' · 重复' : '');
  }

  /* 「谁能看到」要说人话，而且要分清这是谁的安排：
     · 我的提醒（private） = 只有你看得到，他不知道
     · 他的日程（private）  = 只有他自己看得到
     把两者都翻成「仅他自己」会读成正好相反的意思。 */
  function visText(e) {
    var mine = !(e.createdBy && e.createdBy.type === 'char');
    if (e.visibility === 'shared_detail') return '双方可见';
    if (e.visibility === 'participants') return '只有参与的人看得到';
    if (e.visibility === 'shared_busy') return '只显示忙不显示内容';
    return mine ? '只有你看得到' : '只有他自己看得到';
  }

  function statusTag(e) {    if (e.eventType === 'anniversary') return '纪念日';
    if (e.eventType === 'shared_event') {
      var s = e.status === 'confirmed' ? '已确认' : (e.status === 'cancelled' ? '已取消' : '待确认');
      return s;
    }
    return STATUS_LABEL[e.status] || '已确定';
  }

  function eventNode(item, onOpen) {
    var el = h(item.readonly ? 'div' : 'button', 'cal-ev');
    if (!item.readonly) el.type = 'button';
    el.appendChild(h('i', 'cal-ev-line is-' + (TYPE_TONE[item.type] || 'accent')));
    var main = h('div', 'cal-ev-main');
    main.appendChild(h('b', 'cal-ev-title', item.title));
    if (item.desc) main.appendChild(h('p', 'cal-ev-desc', item.desc));
    el.appendChild(main);
    el.appendChild(h('span', 'cal-ev-tag' + (item.type === 'anniversary' ? ' is-rose' : ''), item.tag));
    if (!item.readonly && onOpen) el.addEventListener('click', function () { onOpen(item.id); });
    return el;
  }

  /* ---------------------------- 月历主页 ---------------------------- */

  /* 页面级视图状态。页面实例是缓存复用的，所以状态放模块级 ——
     也正因为是缓存复用的，**必须自己盯着「换岛」这件事**：
     render 只跑一次，换岛之后 onShow 只会调 paint，
     不比对 sandboxId 的话，新岛的日历上写的还是上一个 char 的名字
     （真机抓过）。 */
  var view = { sbId: null, charId: null, year: 0, month: 0, selected: '', picked: false };

  function charOf(id) {
    var ch = core.findChar(id);
    return ch || { id: id, name: '他' };
  }

  function sandboxIsArchipelago() {
    var sb = core.activeSandbox();
    return !!(sb && sb.kind === 'archipelago');
  }

  function mainChars() {
    var sb = core.activeSandbox();
    if (!sb) return [];
    return core.charsOfSandbox(sb.id).filter(function (c) {
      return (c.kind || 'main') === 'main';
    });
  }

  function charNote(ch) {
    var c = C();
    var cfg = c.cfgOf(ch.id);
    var region = c.regionMeta(cfg.region);
    var where = c.placeLabel(ch.id, cfg);
    return where + ' · ' + region.label + (cfg.timezone ? ' · ' + cfg.timezone : '');
  }

  /* 换岛 / 换号 → 视图整个重置（当前看谁的、翻到哪个月都不该跟着走） */
  function viewSyncSandbox(mains) {
    var c = C();
    var sb = core.activeSandbox();
    var sid = sb ? sb.id : null;
    if (view.sbId === sid) return false;
    view.sbId = sid;
    view.charId = null;
    view.picked = false;
    var t = c.todayISO();
    view.selected = t;
    view.year = Number(t.slice(0, 4));
    view.month = Number(t.slice(5, 7)) - 1;
    /* 孤岛：只有一个大号，直接给他（总纲 §2.1，不出选人页）。
       群岛：留空 → 走选人页（§2.2）。 */
    if (sid && !sandboxIsArchipelago() && mains.length === 1) {
      view.charId = mains[0].id;
      view.picked = true;
    }
    return true;
  }

  Sleepy.register('calendar', {
    title: '日历',

    render: function (ctx) {
      var p = ctx.params || {};

      function paint() {
        var sb = core.activeSandbox();
        var mains = mainChars();
        var first = viewSyncSandbox(mains);

        /* 带参数进来（别处跳过来 / 指定了日期）就照参数走 ——
           但只在参数真的点名了一个本岛的大号时才认，
           否则老状态里的 char 会在换岛后阴魂不散。 */
        var wantId = p.charId;
        if (wantId && !mains.some(function (m) { return m.id === wantId; })) wantId = null;
        if (wantId && (first || wantId !== view.charId)) {
          view.charId = wantId;
          view.picked = true;
        }
        if (p.date) {
          view.selected = p.date;
          view.year = Number(p.date.slice(0, 4));
          view.month = Number(p.date.slice(5, 7)) - 1;
        }
        if (!view.charId && mains.length) {
          view.charId = mains[0].id;
          if (!sandboxIsArchipelago()) view.picked = true;
        }
        /* 当前看的 char 不属于这座岛了（换了号 / 人被移出去）→ 退回选人 */
        if (view.charId && !mains.some(function (m) { return m.id === view.charId; })) {
          view.charId = mains[0] ? mains[0].id : null;
          view.picked = false;
        }

        if (!sb || !mains.length) {
          ctx.setTitle('日历');
          ctx.setActions([]);
          ctx.body.innerHTML = '';
          if (ctx.__fab) { ctx.__fab.remove(); ctx.__fab = null; }
          ctx.body.appendChild(h('p', 'empty-hint', '这座岛上还没有角色，日历没有可以记的人。'));
          return;
        }
        if (!view.picked && sandboxIsArchipelago()) paintPick(ctx);
        else paintMonth(ctx);
      }

      ctx.__paint = paint;
      paint();
    },

    onShow: function (ctx) {
      /* 重绘：设置里改过地区/文化节日、从新建页返回、**换了一座岛**，
         都要看到最新的（换岛那条由 paint 里的 viewSyncSandbox 兜住）。 */
      if (ctx.__paint) ctx.__paint();
    },

    /* 群岛上「返回」先回选人页，再返回才离开日历（总纲 §2.2）。
       群岛侧栏那个返回键也走这里 —— 用 setActions 换掉。 */
    onBack: function (ctx) {
      if (sandboxIsArchipelago() && view.picked) {
        view.picked = false;
        if (ctx.__paint) ctx.__paint();
        return true;
      }
      return false;
    }
  });

  /* -------- 群岛：选人页 -------- */
  function paintPick(ctx) {
    var c = C();
    ctx.setTitle('选择日历');
    ctx.setActions([]);
    ctx.body.innerHTML = '';

    var hero = h('section', 'cal-hero');
    hero.appendChild(h('span', 'cal-eyebrow', 'Archipelago'));
    hero.appendChild(h('h1', 'cal-hero-title', '想看看谁的这一个月？'));
    hero.appendChild(h('p', 'cal-hero-note', '群岛里每个 char 的日历、地区与生活轨迹各自独立。'));
    ctx.body.appendChild(hero);

    var list = h('div', 'cal-charlist');
    mainChars().forEach(function (ch) {
      var b = h('button', 'cal-charcard');
      b.type = 'button';
      var av = h('span', 'cal-avatar');
      /* 头像一个字 + 由 id 派生的暖色底（不用蓝） */
      av.textContent = String(ch.name || '他').slice(0, 1);
      av.style.background = avatarTone(ch.id);
      b.appendChild(av);
      var info = h('span', 'cal-charinfo');
      info.appendChild(h('b', null, ch.name || '他'));
      info.appendChild(h('span', null, charNote(ch)));
      b.appendChild(info);
      b.appendChild(h('span', 'cal-go', '›'));
      b.addEventListener('click', function () {
        view.charId = ch.id;
        view.picked = true;
        var cfg = c.cfgOf(ch.id);
        var today = c.todayISO();
        view.selected = today;
        view.year = Number(today.slice(0, 4));
        view.month = Number(today.slice(5, 7)) - 1;
        ctx.__paint();
      });
      list.appendChild(b);
    });
    ctx.body.appendChild(list);
  }

  var AVATAR_TONES = ['linear-gradient(145deg,#8C7355,#C0A483)',
    'linear-gradient(145deg,#9A6E62,#C9A091)',
    'linear-gradient(145deg,#7E7A5E,#B3AE8B)',
    'linear-gradient(145deg,#8A6E7C,#BCA0AC)',
    'linear-gradient(145deg,#6F7B6A,#A6B09D)'];
  /* 头像底色由 id 派生（同一个 char 每次进来同一张脸）。
     用 djb2 而不是「把字符码相加」—— 相加对相邻 id 区分度太差，
     两个 char 会分到同一个色调，一排卡片看着像同一个人。 */
  function avatarTone(id) {
    var s = String(id || '');
    var hh = 5381;
    for (var i = 0; i < s.length; i++) hh = ((hh << 5) + hh + s.charCodeAt(i)) >>> 0;
    return AVATAR_TONES[hh % AVATAR_TONES.length];
  }

  /* -------- 月历主页 -------- */
  function paintMonth(ctx) {
    var c = C();
    var ch = charOf(view.charId);
    var cfg = c.cfgOf(ch.id);

    ctx.setTitle(ph(ch.name) + '的日历');
    ctx.setActions([{
      label: '设置',
      onClick: function () { openSettingsSheet(ctx, ch, cfg); }
    }]);
    ctx.body.innerHTML = '';

    /* ---- 月份头 ---- */
    var head = h('div', 'cal-monthhead');
    var title = h('div', 'cal-monthtitle');
    title.appendChild(h('small', null, String(view.year)));
    title.appendChild(h('strong', null, c.monthLabel(view.month)));
    head.appendChild(title);
    var nav = h('div', 'cal-monthnav');
    var prev = h('button', 'cal-navbtn');
    prev.type = 'button';
    prev.innerHTML = IC_PREV;
    prev.addEventListener('click', function () { moveMonth(ctx, -1); });
    var next = h('button', 'cal-navbtn');
    next.type = 'button';
    next.innerHTML = IC_NEXT;
    next.addEventListener('click', function () { moveMonth(ctx, 1); });
    nav.appendChild(prev);
    nav.appendChild(next);
    head.appendChild(nav);
    ctx.body.appendChild(head);

    /* ---- 图例 ---- */
    var legend = h('div', 'cal-legend');
    [['public', '公共日期'], ['schedule', '角色日程'], ['memory', '留痕纪念日']].forEach(function (p) {
      var s = h('span');
      s.appendChild(h('i', 'cal-dot is-' + p[0]));
      s.appendChild(document.createTextNode(p[1]));
      legend.appendChild(s);
    });
    ctx.body.appendChild(legend);

    /* ---- 月历网格 ---- */
    var cal = h('div', 'cal-grid-wrap');
    var week = h('div', 'cal-week');
    WEEK_HEAD.forEach(function (w) { week.appendChild(h('span', null, w)); });
    cal.appendChild(week);

    var days = h('div', 'cal-days');
    var today = c.todayISO();
    c.monthGrid(view.year, view.month).forEach(function (cell) {
      var day = h('button', 'cal-day');
      day.type = 'button';
      if (cell.muted) day.classList.add('is-muted');
      if (cell.date === view.selected) day.classList.add('is-selected');
      if (cell.date === today) day.classList.add('is-today');
      day.appendChild(h('span', 'cal-day-num', String(cell.day)));

      var info = c.dayInfo(cell.date, cfg);
      /* 「休 / 班」徽标 —— 这是公共日期层的客观标记，
         它**不代表 char 一定休息**（总纲 §10）。 */
      if (info.legal && !cell.muted) {
        day.appendChild(h('span', 'cal-day-badge is-' +
          (info.legal.kind === 'workday_adjustment' ? 'work' : 'off'), info.legal.tag));
      }

      var mk = c.marks(ch.id, cell.date, cfg);
      var dots = h('span', 'cal-dots');
      if (mk.public) dots.appendChild(h('i', 'cal-dot is-public'));
      if (mk.schedule) dots.appendChild(h('i', 'cal-dot is-schedule'));
      if (mk.memory) dots.appendChild(h('i', 'cal-dot is-memory'));
      day.appendChild(dots);

      day.addEventListener('click', function () {
        view.selected = cell.date;
        ctx.__paint();
      });
      days.appendChild(day);
    });
    cal.appendChild(days);
    ctx.body.appendChild(cal);

    /* ---- 该年度缺数据的如实说明（§19.1）---- */
    var notes = c.dayInfo(view.selected, cfg).notes || [];
    if (notes.length) {
      ctx.body.appendChild(h('p', 'cal-degrade', notes.join(' · ')));
    }

    /* ---- 选中日 ---- */
    var selHead = h('div', 'cal-selhead');
    selHead.appendChild(h('b', null, selectedTitle(view.selected)));
    var items = dayItems(ch.id, view.selected, cfg);
    selHead.appendChild(h('small', null, items.length + ' 项'));
    ctx.body.appendChild(selHead);

    var listEl = h('div', 'cal-evlist');
    if (!items.length) {
      listEl.appendChild(h('div', 'cal-empty', '这一天还没有被安排。'));
    } else {
      items.forEach(function (it) {
        listEl.appendChild(eventNode(it, function (id) {
          ctx.open('calendar-event', { id: id, charId: ch.id });
        }));
      });
    }
    ctx.body.appendChild(listEl);

    /* ---- 留痕候选：只列**还没保存成纪念日**的那些 ----
       候选一定来自真实留痕（总纲 §10:17），这里不凭空造。 */
    var cands = c.anniversaryCandidates(ch.id).filter(function (x) { return !x.saved; });
    if (cands.length && cfg.anniversaryPerm !== 'off') {
      var t = h('div', 'cal-selhead');
      t.appendChild(h('b', null, '留痕里的候选'));
      t.appendChild(h('small', null, cands.length + ' 条'));
      ctx.body.appendChild(t);
      var wall = h('div', 'cal-candlist');
      cands.slice(0, 3).forEach(function (x) {
        wall.appendChild(candNode(x, function () { openAnniversarySheet(ctx, ch, x); }));
      });
      ctx.body.appendChild(wall);
    } else if (cfg.anniversaryPerm === 'off') {
      ctx.body.appendChild(h('p', 'cal-degrade', '纪念日权限关着呢：他不会再建立新的纪念日，已有的照旧保留。'));
    }

    /* ---- 脚注：说清楚数据边界，别让 user 以为这里连着现实日历 ---- */
    ctx.body.appendChild(h('p', 'cal-foot',
      '公共日期来自内置离线数据包（' + c.regionMeta(cfg.region).label + '），' +
      '打开、翻月、看日程都不联网、不调用模型。'));

    /* ---- 新建入口（复用全局 .fab-btn：fixed 定位在手机屏右下角） ---- */
    var fab = h('button', 'fab-btn cal-fab');
    fab.type = 'button';
    fab.innerHTML = IC_PLUS;
    fab.setAttribute('aria-label', '新建');
    fab.addEventListener('click', function () {
      ctx.open('calendar-new', { charId: ch.id, date: view.selected });
    });
    if (ctx.__fab) ctx.__fab.remove();
    ctx.__fab = fab;
    ctx.el.appendChild(fab);
  }

  function moveMonth(ctx, delta) {
    var c = C();
    var d = new Date(view.year, view.month + delta, 1);
    view.year = d.getFullYear();
    view.month = d.getMonth();
    view.selected = c.isoOf(new Date(view.year, view.month, 1));
    ctx.__paint();
  }

  function selectedTitle(iso) {
    var c = C();
    var info = c.dayInfo(iso, { region: 'NONE', cultures: [] });
    return Number(iso.slice(5, 7)) + ' 月 ' + Number(iso.slice(8, 10)) + ' 日 · ' + info.weekdayText;
  }

  /* 候选卡（照 Demo 那张「来自留痕的候选」的用法，配色换项目自己的） */
  function candNode(x, onOpen) {
    var c = C();
    var mem = x.memory;
    var card = h('div', 'cal-cand');
    card.appendChild(h('small', 'cal-cand-kicker', '来自留痕'));
    card.appendChild(h('b', 'cal-cand-title', mem.content || '（这条留痕没有正文）'));
    var when = c.dateOf(mem.createdAt || '');
    card.appendChild(h('p', 'cal-cand-note',
      (when ? '记于 ' + when.replace(/-/g, '.') + ' · ' : '') +
      '这是他自己的感受，不会自动变成双方已确认的关系事实。'));
    var b = h('button', 'cal-cand-btn', '看看他的选择');
    b.type = 'button';
    b.addEventListener('click', onOpen);
    card.appendChild(b);
    return card;
  }

  /* ---------------------------- 留痕候选弹层 ---------------------------- */

  function openAnniversarySheet(ctx, ch, x) {
    var c = C();
    var cfg = c.cfgOf(ch.id);
    var mem = x.memory;
    var vis = { v: 'private' };
    var repeat = { v: 'yearly' };

    openSheet(ctx, '留痕候选', function (body, close) {
      var card = h('div', 'cal-trace');
      var when = c.dateOf(mem.createdAt || '');
      card.appendChild(h('b', 'cal-trace-date', when ? when.replace(/-/g, '.') : '日期待确认'));
      card.appendChild(h('h3', 'cal-trace-title', mem.content || '（无正文）'));
      card.appendChild(h('p', 'cal-trace-note',
        '来源：这条留痕本身（' + (mem.source || '记录') + '）。' +
        '日期取自留痕的落库时间' + (mem.sourceRef ? '，来源对话 ' + mem.sourceRef : '') + '。'));
      body.appendChild(card);

      if (!when) {
        /* §10.5：日期不明确时不硬猜，直接不给保存入口 */
        body.appendChild(h('p', 'cal-degrade',
          '这条留痕没有可核实的日期，所以不写进日历 —— 不能拿「去年秋天」硬猜成某个日子。'));
        return;
      }

      body.appendChild(h('p', 'cal-formlabel', '谁能看到'));
      var visWrap = h('div', 'cal-visrow');
      [['private', '仅他可见'], ['shared_detail', '双方可见']].forEach(function (p) {
        var b = h('button', 'cal-visbtn' + (vis.v === p[0] ? ' is-on' : ''), p[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          vis.v = p[0];
          var all = visWrap.querySelectorAll('.cal-visbtn');
          for (var i = 0; i < all.length; i++) all[i].classList.remove('is-on');
          b.classList.add('is-on');
        });
        visWrap.appendChild(b);
      });
      body.appendChild(visWrap);

      body.appendChild(h('p', 'cal-formlabel', '以后每年都回来吗'));
      var repWrap = h('div', 'cal-visrow');
      [['yearly', '每年'], [null, '只留这一天']].forEach(function (p) {
        var b = h('button', 'cal-visbtn' + (repeat.v === p[0] ? ' is-on' : ''), p[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          repeat.v = p[0];
          var all = repWrap.querySelectorAll('.cal-visbtn');
          for (var i = 0; i < all.length; i++) all[i].classList.remove('is-on');
          b.classList.add('is-on');
        });
        repWrap.appendChild(b);
      });
      body.appendChild(repWrap);

      body.appendChild(h('p', 'cal-degrade',
        '农历重复先不做：项目里还没有可靠的农历库，硬转会把日子算错。'));

      var save = button('让他记住这一天', 'primary', function () {
        c.saveAnniversary(ch.id, mem, {
          date: when,
          repeatRule: repeat.v,
          visibility: vis.v,
          meaningType: 'char_subjective'
        });
        close();
        ctx.__paint();
        ctx.toast('已写进日历，也和这条留痕互相认住了', 'ok');
      });
      body.appendChild(save);
    });
  }

  /* ---------------------------- 设置弹层 ---------------------------- */

  function openSettingsSheet(ctx, ch, cfg) {
    var c = C();
    openSheet(ctx, '日历设置', function (body, close) {
      function repaint() {
        close();
        openSettingsSheet(ctx, ch, c.cfgOf(ch.id));
        ctx.__paint();
      }

      /* ---- 公共日期 ---- */
      var g1 = group('公共日期', '只描述客观环境，不代表他那天一定休息。');
      /* 这几项的默认值跟着**他的常驻地点**走（角色档案 → 常驻地点）。
         不写清楚的话，用户改完档案发现日历没动，会以为是 bug。 */
      var place = c.placeOf(ch.id);
      var ov = c.overridden(ch.id);
      var follows = !ov.region && !ov.timezone;
      g1.card.appendChild(h('p', 'cal-sheet-note',
        follows
          ? '跟着他的常驻地点：' + c.placeLabel(ch.id, cfg) + '（' + (place.region || 'CN') + '）。要改就去浮岛改他的档案。'
          : '这里已经手动改过了 —— 不再跟他的常驻地点（' + c.placeLabel(ch.id, cfg) + '）走。'));
      var regWrap = h('div', 'cal-chips');
      DATA().REGIONS.forEach(function (r) {
        var b = h('button', 'cal-chip' + (cfg.region === r.id ? ' is-on' : ''), r.label);
        b.type = 'button';
        b.addEventListener('click', function () {
          c.saveCfg(ch.id, { region: r.id, timezone: r.timezone || cfg.timezone });
          c.clearCache();
          repaint();
        });
        regWrap.appendChild(b);
      });
      g1.card.appendChild(regWrap);
      var regMeta = c.regionMeta(cfg.region);
      g1.card.appendChild(h('p', 'cal-sheet-note', regMeta.note));
      /* 手动改过就给一条回头路 —— 否则「跟随常驻地点」这个默认行为
         一旦被覆盖就再也回不去了。 */
      if (!follows) {
        var reset = row({
          label: '恢复跟随他的常驻地点',
          hint: '把地区与时区退回档案里那一份',
          onClick: function () {
            c.resetToPlace(ch.id);
            c.clearCache();
            repaint();
            ctx.toast('已跟随他的常驻地点', 'ok');
          }
        });
        g1.card.appendChild(reset);
      }
      body.appendChild(g1.wrap);

      var g2 = group('文化节日', '可以多选。只提供情境，不要求他一定庆祝。');
      var culWrap = h('div', 'cal-chips');
      DATA().CULTURE_GROUPS.forEach(function (g) {
        var on = cfg.cultures.indexOf(g.id) >= 0;
        var b = h('button', 'cal-chip' + (on ? ' is-on' : ''), g.label);
        b.type = 'button';
        b.addEventListener('click', function () {
          var next = cfg.cultures.slice();
          var i = next.indexOf(g.id);
          if (i >= 0) next.splice(i, 1); else next.push(g.id);
          c.saveCfg(ch.id, { cultures: next });
          c.clearCache();
          repaint();
        });
        culWrap.appendChild(b);
      });
      g2.card.appendChild(culWrap);
      body.appendChild(g2.wrap);

      /* ---- 时区：事件存绝对时间，页面按这里的时区显示（§4.3）---- */
      var g3 = group('常驻时区', '事件按这个时区显示。第一版不处理旅行轨迹。');
      var sel = h('select', 'cal-select');
      DATA().TIMEZONES.forEach(function (tz) {
        var o = document.createElement('option');
        o.value = tz;
        o.textContent = tz;
        if (cfg.timezone === tz) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        c.saveCfg(ch.id, { timezone: sel.value });
        ctx.toast('时区改了', 'ok');
      });
      g3.card.appendChild(sel);
      body.appendChild(g3.wrap);

      /* ---- 角色生活 ---- */
      var g4 = group('角色生活');
      var sw = ui.switchField({
        label: '生成角色日程',
        hint: '开启后，他可以根据人设、聊天里的承诺和生活进展安排自己的日程。关闭只是不再生成新的，已经记下的和纪念日都留着。',
        value: cfg.scheduleOn
      });
      sw.input.addEventListener('change', function () {
        c.saveCfg(ch.id, { scheduleOn: sw.get() });
        ctx.__paint();
        ctx.toast(sw.get() ? '角色日程开了' : '不再生成新日程了，已有的都留着', sw.get() ? 'ok' : '');
      });
      g4.card.appendChild(sw.el);
      var clr = row({
        label: '清除他生成过的日程',
        hint: '只清角色自动排的那些。你的提醒、共同事件、纪念日、公共日期一概不动。',
        onClick: function () {
          ui.confirm({
            title: '清除他生成的日程？',
            note: '会删掉这个 char 由生活系统自动排出来的日程。已经成立的共同安排和纪念日不会被碰。',
            ok: '清除',
            danger: true
          }).then(function (yes) {
            if (!yes) return;
            var n = c.clearGenerated(ch.id);
            repaint();
            ctx.toast(n ? '清掉了 ' + n + ' 条' : '本来就没有他自动排的日程', 'ok');
          });
        }
      });
      g4.card.appendChild(clr);
      body.appendChild(g4.wrap);

      /* ---- 留痕纪念日 ---- */
      var g5 = group('留痕纪念日', '纪念日不随「生成角色日程」关闭，它是另一层。');
      [['off', '关闭', '不再主动建立新的纪念日，已有的不删'],
        ['ask', '保存前询问', '他提出想记住，由你点头才写进日历'],
        ['auto', '允许自主保存', '他可以把自己的私人意义直接写进自己的日历']].forEach(function (p) {
        var b = h('button', 'cal-radio' + (cfg.anniversaryPerm === p[0] ? ' is-on' : ''));
        b.type = 'button';
        b.appendChild(h('b', null, p[1]));
        b.appendChild(h('small', null, p[2]));
        b.addEventListener('click', function () {
          c.saveCfg(ch.id, { anniversaryPerm: p[0] });
          repaint();
        });
        g5.card.appendChild(b);
      });
      body.appendChild(g5.wrap);

      /* ---- 本地提醒 ---- */
      var g6 = group('本地提醒');
      var sw2 = ui.switchField({
        label: '到点提醒我',
        hint: '到期提醒由本地程序调度，不调用模型。',
        value: cfg.remindOn
      });
      sw2.input.addEventListener('change', function () {
        c.saveCfg(ch.id, { remindOn: sw2.get() });
        ctx.toast(sw2.get() ? '会提醒你' : '不提醒了', 'ok');
      });
      g6.card.appendChild(sw2.el);
      body.appendChild(g6.wrap);

      body.appendChild(h('p', 'cal-sheet-note',
        '这些设置只属于「' + ph(ch.name) + '」。换一个 char，地区、节日、开关都是各自独立的。'));
    });
  }

  /* ---------------------------- 日程详情 ---------------------------- */

  Sleepy.register('calendar-event', {
    title: '日程',
    render: function (ctx) {
      var c = C();
      var p = ctx.params || {};
      var ev = c.getEvent(p.id);
      ctx.body.innerHTML = '';

      if (!ev) {
        ctx.setTitle('日程');
        ctx.body.appendChild(h('p', 'empty-hint', '这条日程不在了。'));
        return;
      }
      var ch = charOf(ev.ownerCharId || p.charId);
      var cfg = c.cfgOf(ch.id);
      var info = c.dayInfo(c.dateOf(ev.startAt), cfg);

      ctx.setTitle(TYPE_LABEL[ev.eventType] || '日程');
      ctx.setActions([]);

      var hero = h('div', 'cal-ev-hero');
      hero.appendChild(h('small', 'cal-eyebrow', info.weekdayText + ' · ' + eventDesc(ev)));
      hero.appendChild(h('h1', 'cal-ev-hero-title', ev.title));
      if (ev.desc) hero.appendChild(h('p', 'cal-hero-note', ev.desc));
      ctx.body.appendChild(hero);

      var g = group('这条是什么');
      g.card.appendChild(row({ label: '类型', value: TYPE_LABEL[ev.eventType] || ev.eventType, plain: true }));
      g.card.appendChild(row({ label: '状态', value: STATUS_LABEL[ev.status] || ev.status, plain: true }));
      g.card.appendChild(row({
        label: '时间',
        value: ev.allDay ? c.dateOf(ev.startAt) + ' 全天'
          : (c.dateOf(ev.startAt) + ' ' + c.timeOf(ev.startAt) +
            (c.timeOf(ev.endAt) ? '—' + c.timeOf(ev.endAt) : '')),
        plain: true
      }));
      g.card.appendChild(row({ label: '时区', value: ev.timezone || cfg.timezone || '—', plain: true }));
      g.card.appendChild(row({
        label: '谁定的',
        value: ev.createdBy && ev.createdBy.type === 'char' ? ph(ch.name) : '你',
        plain: true
      }));
      if (ev.repeatRule) {
        g.card.appendChild(row({ label: '重复', value: ev.repeatRule === 'yearly' ? '每年' : (ev.repeatRule === 'weekly' ? '每周' : ev.repeatRule), plain: true }));
      }
      if (ev.visibility) {
        /* 措辞要分「他的东西」和「我的东西」——
           我的提醒写「仅他自己」会读成「只有他看得见」，正好反了。 */
        g.card.appendChild(row({
          label: '谁能看到',
          value: visText(ev),
          plain: true
        }));
      }
      ctx.body.appendChild(g.wrap);

      /* ---- 纪念日：显示它挂在哪条留痕上（§10.7 双向）---- */
      if (ev.eventType === 'anniversary') {
        var g2 = group('为什么记住这一天');
        var memFile = c.memoryFile(ch.id);
        var mem = null;
        (memFile.memories || []).forEach(function (m) { if (m.id === ev.memoryId) mem = m; });
        g2.card.appendChild(row({
          label: mem ? mem.content : '（对应的留痕已经不在了）',
          hint: mem ? '留痕来源：' + (mem.source || '记录') + (mem.sourceRef ? ' · ' + mem.sourceRef : '') : '来源失效的纪念日应该进入待审核，别自动抹掉过去',
          plain: true
        }));
        g2.card.appendChild(row({
          label: '意义',
          value: ev.meaningType === 'shared_confirmed' ? '双方确认过' : '只对他有意义',
          hint: '他的私人纪念日不会自动变成双方的关系事实。',
          plain: true
        }));
        ctx.body.appendChild(g2.wrap);
      }

      /* ---- 操作：按类型给不同的活（总纲 §17.1）---- */
      var acts = h('div', 'cal-acts');

      if (ev.eventType === 'public_holiday' || ev.eventType === 'cultural_day') {
        acts.appendChild(h('p', 'cal-degrade', '公共日期是客观背景，改不了，也不代表他一定休息。'));
      } else if (ev.eventType === 'char_schedule') {
        acts.appendChild(h('p', 'cal-degrade',
          '这是他自己的日程。第一版你没有权限直接改或删 —— ' +
          '你可以去聊天里问他，让他自己改。'));
      } else {
        if (ev.eventType === 'shared_event') {
          if (ev.status === 'pending') {
            acts.appendChild(button('答应这次', 'primary', function () {
              var ps = ev.participantStates || {};
              ps.user = 'accepted';
              var both = ps.user === 'accepted' && ps[ch.id] === 'accepted';
              c.updateEvent(ev.id, { participantStates: ps, status: both ? 'confirmed' : 'pending' });
              ctx.toast(both ? '双方都答应了，这条算定下' : '你答应了，等他表态', 'ok');
              ctx.back();
            }));
          }
          acts.appendChild(button('改个时间', 'ghost', function () {
            editTime(ctx, c, ev, function () {
              ctx.toast('改了，也留了痕', 'ok');
              ctx.back();
            });
          }));
          acts.appendChild(button('取消这次', 'ghost', function () {
            ui.prompt({
              title: '为什么取消',
              note: '取消会保留历史 —— 它还会影响记忆和后面的说法。',
              value: '',
              ok: '取消这次'
            }).then(function (why) {
              if (why === null) return;
              c.cancelEvent(ev.id, why);
              ctx.toast('已取消，事情记下了', 'ok');
              ctx.back();
            });
          }));
        } else {
          acts.appendChild(button('改个时间', 'ghost', function () {
            editTime(ctx, c, ev, function () { ctx.toast('改好了', 'ok'); ctx.back(); });
          }));
          if (ev.status !== 'completed') {
            acts.appendChild(button('做完了', 'ghost', function () {
              c.updateEvent(ev.id, { status: 'completed' });
              ctx.toast('标记完成', 'ok');
              ctx.back();
            }));
          }
          acts.appendChild(button('删掉这条', 'ghost', function () {
            ui.confirm({
              title: '删掉？',
              note: '删除适合「记错了 / 建重了」。如果是本来要发生、后来不发生了，那该用取消 —— 取消会留下历史。',
              ok: '删除',
              danger: true
            }).then(function (yes) {
              if (!yes) return;
              var r = c.removeEvent(ev.id);
              ctx.toast(r.ok ? '删掉了' : r.message, r.ok ? 'ok' : 'err');
              if (r.ok) ctx.back();
            });
          }));
        }
      }
      ctx.body.appendChild(acts);
    }
  });

  /* 改时间。**自己搭底弹层**而不是走 ui.prompt 的多字段模式 ——
     那是因为它的输入框被写死成 type='text'（见 ui.js 的 ensureDialog），
     日期和时间拿不到原生选择器。 */
  function editTime(ctx, c, ev, done) {
    var date = c.dateOf(ev.startAt);
    var st = c.timeOf(ev.startAt) || '09:00';
    var en = c.timeOf(ev.endAt);

    openSheet(ctx, '改个时间', function (body, close) {
      var f1 = h('div', 'cal-field');
      f1.appendChild(h('label', null, '日期'));
      var dateIn = textInput('date', date);
      f1.appendChild(dateIn);
      body.appendChild(f1);

      var f2 = h('div', 'cal-field');
      f2.appendChild(h('label', null, '几点（两格都留空 = 全天）'));
      var timeRow = h('div', 'cal-timerow');
      var startIn = textInput('time', st);
      var endIn = textInput('time', en || '');
      timeRow.appendChild(startIn);
      timeRow.appendChild(h('span', 'cal-tilde', '—'));
      timeRow.appendChild(endIn);
      f2.appendChild(timeRow);
      body.appendChild(f2);

      body.appendChild(button('改好', 'primary', function () {
        var d = dateIn.value || date;
        var s = startIn.value || '';
        var e2 = endIn.value || '';
        c.updateEvent(ev.id, {
          startAt: c.at(d, s),
          endAt: (s && e2) ? c.at(d, e2) : '',
          allDay: !s
        }, 'user 改期');
        close();
        done();
      }));
    });
  }

  /* ---------------------------- 新建 ----------------------------

     第一版只给两种（总纲 §17.1）：
       · 我的提醒 —— 本地写入，不告诉他，不进他的 prompt
       · 邀请他   —— 先 pending，他表态后才成为双方已确认的事实
     **不给「直接替他建私人行程」**（§8.2）。 */
  Sleepy.register('calendar-new', {
    title: '新建',
    render: function (ctx) {
      var c = C();
      var p = ctx.params || {};
      var ch = charOf(p.charId);
      var cfg = c.cfgOf(ch.id);
      var draft = {
        type: 'user_reminder',
        date: p.date || c.todayISO(),
        start: '',
        end: '',
        title: '',
        allDay: false
      };

      ctx.setTitle('新建');
      ctx.setActions([]);
      ctx.body.innerHTML = '';

      var g0 = group('这是谁的安排');
      var typeWrap = h('div', 'cal-typechoice');
      [['user_reminder', '我的提醒', '我自己记着，他不知道'],
        ['shared_event', '邀请他', '发给他，等他答应才算定下']].forEach(function (t) {
        var b = h('button', 'cal-typebtn' + (draft.type === t[0] ? ' is-on' : ''));
        b.type = 'button';
        b.appendChild(h('b', null, t[1]));
        b.appendChild(h('small', null, t[2]));
        b.addEventListener('click', function () {
          draft.type = t[0];
          var all = typeWrap.querySelectorAll('.cal-typebtn');
          for (var i = 0; i < all.length; i++) all[i].classList.remove('is-on');
          b.classList.add('is-on');
        });
        typeWrap.appendChild(b);
      });
      g0.card.appendChild(typeWrap);
      ctx.body.appendChild(g0.wrap);

      var g1 = group('什么时候');
      var f1 = h('div', 'cal-field');
      f1.appendChild(h('label', null, '日期'));
      var dateIn = textInput('date', draft.date);
      f1.appendChild(dateIn);
      g1.card.appendChild(f1);

      var f2 = h('div', 'cal-field');
      f2.appendChild(h('label', null, '几点（留空就是全天）'));
      var timeRow = h('div', 'cal-timerow');
      var startIn = textInput('time', '');
      var endIn = textInput('time', '');
      timeRow.appendChild(startIn);
      timeRow.appendChild(h('span', 'cal-tilde', '—'));
      timeRow.appendChild(endIn);
      f2.appendChild(timeRow);
      g1.card.appendChild(f2);
      ctx.body.appendChild(g1.wrap);

      var g2 = group('什么事');
      var f3 = h('div', 'cal-field');
      f3.appendChild(h('label', null, '标题'));
      var titleIn = textInput('text', '');
      titleIn.placeholder = '例如：一起去旧书店';
      f3.appendChild(titleIn);
      g2.card.appendChild(f3);

      var f4 = h('div', 'cal-field');
      f4.appendChild(h('label', null, '备注（可选）'));
      var descIn = textInput('text', '');
      f4.appendChild(descIn);
      g2.card.appendChild(f4);
      ctx.body.appendChild(g2.wrap);

      /* 重复：第一版只给「不重复 / 每年」。每周是给固定课程、班表留的口子，
         数据层已经支持（repeatRule）。 */
      var g3 = group('重复吗');
      var repWrap = h('div', 'cal-chips');
      [['', '不重复'], ['yearly', '每年'], ['weekly', '每周']].forEach(function (r) {
        var b = h('button', 'cal-chip' + (r[0] === '' ? ' is-on' : ''), r[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          draft.repeat = r[0] || null;
          var all = repWrap.querySelectorAll('.cal-chip');
          for (var i = 0; i < all.length; i++) all[i].classList.remove('is-on');
          b.classList.add('is-on');
        });
        repWrap.appendChild(b);
      });
      g3.card.appendChild(repWrap);
      ctx.body.appendChild(g3.wrap);

      var hint = h('p', 'cal-degrade', '');
      ctx.body.appendChild(hint);

      var save = button('记下来', 'primary', function () {
        var title = String(titleIn.value || '').trim();
        draft.date = dateIn.value || c.todayISO();
        draft.start = startIn.value || '';
        draft.end = endIn.value || '';
        if (!title) { ctx.toast('得写个标题', 'err'); return; }

        var allDay = !draft.start;
        var rec = {
          ownerCharId: ch.id,
          eventType: draft.type,
          title: title,
          desc: String(descIn.value || '').trim(),
          startAt: c.at(draft.date, allDay ? '' : draft.start),
          endAt: (!allDay && draft.end) ? c.at(draft.date, draft.end) : '',
          allDay: allDay,
          timezone: cfg.timezone,
          repeatRule: draft.repeat || null,
          status: draft.type === 'shared_event' ? 'pending' : 'confirmed',
          createdBy: { type: 'user', id: 'user' },
          sourceType: 'manual'
        };
        if (draft.type === 'shared_event') {
          rec.participants = [
            { type: 'user', id: 'user', state: 'accepted' },
            { type: 'char', id: ch.id, state: 'pending' }
          ];
          rec.participantStates = { user: 'accepted' };
          rec.visibility = 'participants';
        } else {
          rec.participants = [];
          /* 我的提醒默认不对他公开（§12.3：不自动让 char 知道） */
          rec.visibility = 'private';
        }

        var clash = c.conflictOf(ch.id, rec);
        if (clash.length) {
          /* §19.5：冲突不自动覆盖旧日程，也不拦死 —— 说清楚让 user 自己决定 */
          ui.confirm({
            title: '这个时间和别的安排撞了',
            note: '撞上了：' + clash.map(function (e) { return e.title; }).join('、') +
              '。要照常记下来吗？（旧的不会被覆盖）',
            ok: '还是记下',
            danger: true
          }).then(function (go) {
            if (!go) return;
            c.addEvent(rec);
            after();
          });
          return;
        }
        c.addEvent(rec);
        after();
      });
      ctx.body.appendChild(save);

      function after() {
        ctx.toast(draft.type === 'shared_event'
          ? '发出去了，等他表态 —— 还没到「已确认」'
          : '记下了，只在你这边', 'ok');
        ctx.back();
      }

      /* 类型切换后把「他不知道 / 等他答应」这句提示换掉 */
      function refreshHint() {
        hint.textContent = draft.type === 'shared_event'
          ? '邀请发出去先是「待确认」。他答应了才算双方确认，不会自己变成已定的事。'
          : '你的提醒只有你看得到，也不会进他的上下文 —— 想让他知道，就在聊天里说。';
      }
      refreshHint();
      typeWrap.addEventListener('click', refreshHint);
    }
  });

  /* 给冒烟用的钩子：视图状态与几个纯函数 */
  Sleepy.calendarPage = {
    view: view,
    dayItems: dayItems,
    TYPE_LABEL: TYPE_LABEL,
    STATUS_LABEL: STATUS_LABEL
  };

})(window);
