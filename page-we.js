/* ============================================================
   page-we.js — We（关系沉淀空间，首版最小纵向闭环）

   产品定位（docs/勘察-We前置仓库-2026-09-27.md）：
   We 是当前世界里的关系沉淀空间，不在 We 内切换岛屿。
   当前世界由桌面层决定 —— We 打开时**不自猜岛、不自己存 activeSandboxId**，
   一律走 core 的指针卫兵：
     core.activeSandbox() / core.scopeId()
     core.activeCharOnIsland()   （当前身份必须是本岛名册里的一件）
     core.activeUserOnIsland()   （当前马甲必须是本岛 maskIds 里的一件）
     core.defaultUserOfSandbox() （这座岛「我的大号」，降落归位用它）
     core.findLink(charId, userId, sandboxId) （关系数据，只读）
     core.charsOfSandbox() / core.labelOfUser()

   首页首版只做真实数据（不对 Demo 常量做任何回填）：
     ① 关系标题      = 当前角色名 + 当前 user 名称
     ② 此刻 / 关系事实 = calendar.timeFacts（客观部分）+ 即将到来的纪念日
     ③ 接下来        = calendar.upcoming(charId, 7)
     ④ 最近时光      = lifeFeed.recent(charId, userId)
     ⑤ 收藏展示      = 现有 favorites 的数量（不改造 favorites 语义）
     ⑥ 共同记录      = weEntries（新 store key，scoped 过滤）

   唯一写入动作：用户手动新增一条共同记录（标题 + 一句话 + 日期 + 可选来源）。
   写入走 weStore.add —— tagScope 盖当前 sandboxId，刷新仍在，切岛不串线。

   空态 / 错误态全覆盖，绝不写假数据；空态文案用 We 语境。
   新增样式统一 we- 前缀，与 JS 一起维护（见 style.css 末尾追加段）。

   —— 视觉结构对齐（编辑式排版，参照 We 首页视觉 Demo v1）——
   只改表现层，数据闭环不动。结构语言：
     · 封面 hero：竖排小标 + 衬线大 wordmark，关系空间封面感，不是普通设置页
     · 此刻：当前关系状态区（客观事实 + 纪念日），细线编辑式条目
     · 接下来：票根卡（硬边、日期戳、齿孔感）
     · 最近时光：拍立得式横向滚动内容
     · 收藏展示：关系空间的展示区
     · 共同记录：展台硬边卡
     · 米白纸张 / 细线分区 / 留白分层，页面内自然滚动
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;

  var SVG = 'viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  function ic(body, size) {
    var s = size ? 'viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"' : SVG;
    return '<svg ' + s + '>' + body + '</svg>';
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  /* ============================ weStore（weEntries） ============================
     唯一出口。不复制聊天全文 / 图片本体 —— 只存引用：
     sourceType / sourceId / sourceRef / refCharId / refUserId。
     读写纪律跟项目里其他 scoped 表一致：读 scoped、写 tagScope。 */

  var WE_KEY = 'weEntries';

  /* 收藏馆藏品分类（kind）。首轮七类，'other' 兜底：
     —— 老记录没有 kind 字段时，详情/门厅一律按 'other' 兼容（见 kindOf）。 */
  var WE_KINDS = ['ticket', 'photo', 'letter', 'music', 'gift', 'place', 'other'];

  /* 归一化 kind：白名单外的（含 undefined / 历史遗留）一律落 'other'。 */
  function kindOf(rec) {
    var k = rec && rec.kind;
    return WE_KINDS.indexOf(k) >= 0 ? k : 'other';
  }

  /* 分类中文名（门厅分组标题用）。 */
  var WE_KIND_LABEL = {
    ticket: '票根', photo: '照片', letter: '信件', music: '音乐',
    gift: '礼物', place: '地方', other: '其他'
  };

  function weList() {
    /* 读：按当前房过滤（scoped）。无房时返回全部 —— 与项目其余表同口径。 */
    return core.scoped(arr(store.get(WE_KEY)));
  }

  /* 追加一条共同记录。rec 是用户填的「内容 + 可选来源引用」，
     这里补 id / createdAt / updatedAt / createdBy，并盖当前房章。

     P2（提议确认流）扩展：rec.createdBy 可选（'char'，缺省仍 'user'）、
     rec.confirmedBy / rec.confirmedAt 可选（char 提议经 user 确认的留痕）。
     不传这些字段的既有 user 手动记录行为完全不变（entry 形状与首轮一致）。 */
  function weAdd(rec, sandboxId) {
    var now = Date.now();
    var entry = {
      id: 'we-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      title: String(rec.title || '').trim(),
      note: String(rec.note || '').trim(),
      at: rec.at || null,
      kind: kindOf(rec),           /* 白名单外一律 'other'（老记录兼容） */
      sourceType: rec.sourceType || 'manual',
      sourceId: rec.sourceId || null,
      sourceRef: rec.sourceRef || null,
      refCharId: rec.refCharId || null,
      refUserId: rec.refUserId || null,
      createdBy: rec.createdBy === 'char' ? 'char' : 'user',
      createdAt: now,
      updatedAt: now
    };
    if (rec.confirmedBy) entry.confirmedBy = String(rec.confirmedBy);
    if (rec.confirmedAt) entry.confirmedAt = rec.confirmedAt;
    /* 写入必须带当前 sandboxId —— 由 tagScope 盖章（不手写）。 */
    core.tagScope(entry, sandboxId);

    var list = arr(store.get(WE_KEY));
    list.push(entry);
    store.set(WE_KEY, list);
    return entry;
  }

  /* 新增记录里当前身份可读到的 source 候选：只给「当前角色 + 当前 user」的引用。
     首版不做自动抽取 —— 候选只做「用户主动确认后才落表」的素材，见拍板 §7。 */
  function sourceCandidates() {
    var out = [];
    var charId = (core.activeCharOnIsland() || {}).id;
    var userId = (core.activeUserOnIsland() || {}).id;
    if (!charId || !userId) return out;

    /* 日历里即将到来的事件（当前房、当前角色可见的） */
    var cal = Sleepy.calendar;
    if (cal && cal.upcoming && cal.eventsOf) {
      try {
        arr(cal.upcoming(charId, 14)).forEach(function (r) {
          var e = r.event;
          if (!e || e.status === 'cancelled' || e.status === 'completed') return;
          if (e.eventType === 'char_schedule') return;
          var title = String(e.title || '').trim();
          if (!title) return;
          out.push({
            label: '日历 · ' + title,
            sourceType: 'calendar',
            sourceId: e.id,
            sourceRef: r.date,
            refCharId: charId,
            refUserId: userId
          });
        });
      } catch (e) { /* 日历读失败不该让候选炸掉 */ }
    }

    /* 线下会话（offlineSessions）的总结 —— 只在用户主动确认后可作为来源 */
    var offline = arr(store.get('offlineSessions')).filter(function (s) {
      return s && s.sandboxId === core.scopeId() && s.summary;
    });
    offline.forEach(function (s) {
      out.push({
        label: '线下 · ' + String(s.title || s.name || '一段线下时光').slice(0, 18),
        sourceType: 'offline',
        sourceId: s.id,
        sourceRef: String(s.summary).slice(0, 60),
        refCharId: s.charId || charId,
        refUserId: s.userId || userId
      });
    });

    return out.slice(0, 12);
  }

  /* ============================ 关系事实（只读展示） ============================
     timeFacts 返回的是一段**喂给模型**的多行文本，含元指令行。We 首页要的是
     给 user 看的客观关系事实，所以过滤掉「不要念出来」这类说明行，只留客观行。 */

  function relationFacts(charId) {
    var facts = [];
    var cal = Sleepy.calendar;
    if (!cal || !cal.timeFacts) return facts;

    var raw = '';
    try { raw = String(cal.timeFacts(charId) || ''); } catch (e) { raw = ''; }
    raw.split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      /* 跳过元指令与「user 那边」的时差行 —— 那是给模型的，不是给 user 看的 */
      if (t.indexOf('【') === 0) return;
      if (/^user 那边/.test(t)) return;
      facts.push(t);
    });

    /* 纪念日：从「即将到来」的事件里挑 anniversary（当前房真实事件） */
    try {
      arr(cal.upcoming(charId, 365)).some(function (r) {
        if (r.event.eventType !== 'anniversary') return false;
        if (r.event.status === 'cancelled' || r.event.status === 'completed') return false;
        facts.push('纪念日 · ' + String(r.event.title || '').trim() +
          (r.inDays === 0 ? '（今天）' : r.inDays === 1 ? '（明天）' : '（' + r.inDays + ' 天后）'));
        return true;   /* 首版只展示最近一条纪念日，够表达「关系事实」即可 */
      });
    } catch (e) { /* 忽略 */ }

    return facts.slice(0, 4);
  }

  /* ============================ 收藏展示（不改造 favorites） ============================ */

  function favoritesCount() {
    return arr(store.get('favorites')).filter(function (f) {
      return f && f.sandboxId === core.scopeId();
    }).length;
  }

  /* ============================ 新增记录抽屉 ============================
     首版唯一写入动作。整段抄 openProactiveDrawer 的弹层范式（工作记忆红线：
     新弹层整段抄 openProactiveDrawer），挂 #phone，浮层用 position:absolute。 */

  function openAddDrawer(ctx) {
    var phone = document.getElementById('phone');
    if (!phone) return;
    var drawer = h('div', 'we-drawer');
    drawer.innerHTML =
      '<div class="we-drawer-scrim"></div>' +
      '<div class="we-drawer-sheet">' +
        '<div class="we-drawer-head">' +
          '<span class="we-drawer-title">记一条共同记录</span>' +
          '<button class="we-drawer-close" type="button" aria-label="关闭">&#10005;</button>' +
        '</div>' +
        '<div class="we-drawer-body"></div>' +
      '</div>';
    phone.appendChild(drawer);

    var bodyEl = drawer.querySelector('.we-drawer-body');
    var closeBtn = drawer.querySelector('.we-drawer-close');
    var scrim = drawer.querySelector('.we-drawer-scrim');

    var title = ui.textField({ label: '标题' });
    var note = ui.textArea({ label: '一句话记录', rows: 3 });
    var date = ui.textField({ label: '日期（可选，留空则今天）', placeholder: '如 2026-09-27' });

    bodyEl.appendChild(title.el);
    bodyEl.appendChild(note.el);
    bodyEl.appendChild(date.el);

    /* 藏品分类（kind）：七选一，默认 other。首轮不做智能猜测。 */
    var kindWrap = h('div', 'we-drawer-srcwrap');
    kindWrap.appendChild(h('p', 'we-drawer-label', '把它归进哪一类（可选）'));
    var kindSel = h('select', 'we-drawer-src');
    WE_KINDS.forEach(function (k) {
      var o = h('option', '', WE_KIND_LABEL[k]);
      o.value = k;
      if (k === 'other') o.selected = true;
      kindSel.appendChild(o);
    });
    kindWrap.appendChild(kindSel);
    bodyEl.appendChild(kindWrap);

    /* 来源候选：只在用户主动选择后作为 sourceType/sourceId 落表 */
    var cands = sourceCandidates();
    if (cands.length) {
      var srcLabel = h('p', 'we-drawer-label', '从一段现成的记忆带进来（可选）');
      var sel = h('select', 'we-drawer-src');
      sel.appendChild(h('option', '', '不关联，纯手记'));
      cands.forEach(function (c, i) {
        var o = h('option', '', c.label);
        o.value = String(i);
        sel.appendChild(o);
      });
      var srcWrap = h('div', 'we-drawer-srcwrap');
      srcWrap.appendChild(srcLabel);
      srcWrap.appendChild(sel);
      bodyEl.appendChild(srcWrap);
      bodyEl.__weCands = cands;
    }

    var saveBtn = ui.button('保存到共同记录', 'primary');
    bodyEl.appendChild(saveBtn);

    function close() {
      if (drawer.parentNode) drawer.parentNode.removeChild(drawer);
    }
    closeBtn.addEventListener('click', close);
    scrim.addEventListener('click', close);
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) close();
    });

    saveBtn.addEventListener('click', function () {
      var t = title.get();
      var n = note.get();
      var d = String(date.get() || '').trim();
      /* 标题或一句话至少填一个 */
      if (!t && !n) {
        ctx.toast('标题或一句话至少填一个', 'err');
        return;
      }
      /* 日期校验：留空 = 今天；填了必须能解析 */
      var at;
      if (d) {
        var parsed = parseDate(d);
        if (!parsed) {
          ctx.toast('日期格式不对（试试 2026-09-27）', 'err');
          return;
        }
        at = parsed;
      } else {
        at = Date.now();
      }

      var src = null;
      if (bodyEl.__weCands && sel && sel.value !== '' && bodyEl.__weCands[Number(sel.value)]) {
        src = bodyEl.__weCands[Number(sel.value)];
      }

      var rec = {
        title: t, note: n, at: at,
        kind: kindSel.value,
        sourceType: src ? src.sourceType : 'manual',
        sourceId: src ? src.sourceId : null,
        sourceRef: src ? src.sourceRef : null,
        refCharId: src ? src.refCharId : (core.activeCharOnIsland() || {}).id || null,
        refUserId: src ? src.refUserId : (core.activeUserOnIsland() || {}).id || null
      };
      try {
        weAdd(rec);
        close();
        ctx.toast('已记下', 'ok');
        paint(ctx);
      } catch (e) {
        ctx.toast('保存失败：' + (e && e.message || e), 'err');
      }
    });
  }

  /* 宽松日期解析：2026-09-27 / 2026.9.27 / 9-27 等。返回时间戳，非法返回 null。 */
  function parseDate(s) {
    s = String(s || '').trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
    if (m) {
      var dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!isNaN(dt.getTime())) return dt.getTime();
      return null;
    }
    /* 允许 9-27 这类省略年份的，按今年 */
    var m2 = s.match(/^(\d{1,2})[-/.]([^-/.]\d{1,2})$/);
    if (m2) {
      var y = new Date().getFullYear();
      var d2 = new Date(y, Number(m2[1]) - 1, Number(m2[2]));
      if (!isNaN(d2.getTime())) return d2.getTime();
    }
    return null;
  }

  function fmtDay(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
  }

  /* ============================ 首页渲染（编辑式排版） ============================
     结构对齐 We 首页 Demo v1 的真实视觉语言，数据全部来自真实 core 出口：
       · 封面出血图 + 叠字（kicker / cover-title / cover-sub，渐变色块当图）
       · 三格 facts 计数条（衬线大数字 + 竖线分割，无框）
       · 编号区块（01 此刻 / 02 接下来 / 03 最近时光 / 04 当前陈列）
       · 此刻：左竖线引文 + 倒计时
       · 接下来：票根（直角 + 日期戳 + 斜纹 + 操作行）
       · 最近时光：错位拍立得横向滚动
       · 当前陈列：展台（exhibit 格 + 底部台面线）
    空数据时保留编辑式结构 + We 语境文案，绝不写假数据。 */

  function paint(ctx) {
    var body = ctx.body;
    body.innerHTML = '';
    /* 纸张氛围容器：暖浅米白纸底 + 纸纹，通到屏缘。所有内容铺在纸上。 */
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    /* ---- 关系上下文守卫（指针卫兵，We 不自猜岛） ---- */
    var sb = core.activeSandbox();
    if (!sb) {
      out.appendChild(empty(ctx, '还没有当前世界',
        '先在桌面选一间房，再回来打开 We。'));
      return;
    }
    var sid = sb.id;

    var user = core.activeUserOnIsland();
    var char = core.activeCharOnIsland();
    if (!user || !char) {
      out.appendChild(empty(ctx, '这里还没有确定的关系对象',
        '在这座岛先选好角色和你自己，We 才能开始。'));
      return;
    }

    var charName = String(char.name || '未命名').trim();
    var userName = core.labelOfUser(user, '我');
    var link = core.findLink(char.id, user.id, sid);
    var connected = !!link;
    var kind = sb.kind === 'archipelago' ? '群岛' : '孤岛';

    /* ---- 数据预取（真实出口，全量读一次供多个区块用） ---- */
    var facts = relationFacts(char.id);          /* 此刻引文 */
    var anniv = nextAnniversary(char.id);        /* 纪念日倒计时 */
    var upcoming = nextUpcoming(char.id, 7);     /* 接下来票根 */
    var recent = recentMoments(char.id, user.id);/* 最近时光 */
    var favN = favoritesCount();                 /* 当前陈列 */
    var entries = weList().slice().sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    });                                          /* 共同记录 */

    /* ---- 封面：整幅出血图 + 叠字（渐变色块模拟，无假图） ---- */
    var cover = h('div', 'we-cover');
    cover.appendChild(h('div', 'we-cover-vert', 'OUR SPACE'));

    var ct = h('div', 'we-cover-txt');
    /* kicker：关系时长（用「第 N 个星期」这种编辑式短语，数不出来就退成群岛类型） */
    var weekKicker = weekKickerText(sb, char);
    ct.appendChild(h('div', 'we-cover-kicker', weekKicker));
    var coverTitle = h('div', 'we-cover-title', charName + ' × ' + userName);
    ct.appendChild(coverTitle);
    var coverSub = h('div', 'we-cover-sub', coverSubText(facts, upcoming, anniv));
    ct.appendChild(coverSub);
    cover.appendChild(ct);
    out.appendChild(cover);

    /* ---- 三格 facts 计数条 ---- */
    var factsBar = h('div', 'we-facts');
    factsBar.appendChild(factCell(entries.length, '共 同 记 录'));
    factsBar.appendChild(factCell(favN, '收 藏'));
    factsBar.appendChild(factCell(upcoming.length, '接 下 来'));
    out.appendChild(factsBar);

    /* ---- 01 此刻：左竖线引文 ---- */
    var nowSec = section('此刻', '01');
    if (facts.length) {
      var quote = h('div', 'we-quote');
      var qp = h('p', '', facts[0]);
      quote.appendChild(qp);
      /* 第一条作引文，其余作事实小字 */
      var extra = facts.slice(1);
      extra.forEach(function (f) {
        quote.appendChild(h('small', '', f));
      });
      nowSec.appendChild(quote);
    } else {
      nowSec.appendChild(h('p', 'we-none', '还没有什么特别的，此刻只是静静在。'));
    }
    /* 纪念日倒计时（真实 anniversary） */
    if (anniv) {
      nowSec.appendChild(countdownRow(anniv));
    }
    out.appendChild(nowSec);

    /* ---- 02 接下来：票根 ---- */
    var upSec = section('接下来', '02');
    if (upcoming.length) {
      var stub = ticketEl(upcoming[0]);
      upSec.appendChild(stub);
      /* 其余的折叠成 countdown 式小行 */
      var rest = upcoming.slice(1);
      rest.forEach(function (r) {
        upSec.appendChild(miniRow(r));
      });
    } else {
      upSec.appendChild(h('p', 'we-none', '接下来还没有约定，留一件给以后吧。'));
    }
    out.appendChild(upSec);

    /* ---- 03 最近时光：错位拍立得 ---- */
    var rSec = section('最近时光', '03');
    if (recent.length) {
      var strip = h('div', 'we-polaroid');
      recent.slice(0, 6).forEach(function (it, i) {
        var pl = h('figure', 'we-polaroid-card');
        /* 渐变色块当「照片位」，按序取不同色相（无假图） */
        pl.appendChild(h('i', 'we-polaroid-photo we-ph' + (i % 3)));
        var line = String(it.line || '').trim();
        var em = h('em', '', (fmtDay(it.at) || '此刻') + (line ? ' · ' + line.slice(0, 10) : ''));
        pl.appendChild(em);
        strip.appendChild(pl);
      });
      rSec.appendChild(strip);
    } else {
      rSec.appendChild(h('p', 'we-none', '这里还没有一起经过的片段。'));
    }
    out.appendChild(rSec);

    /* ---- 04 当前陈列：展台 ---- */
    var eSec = section('当前陈列', '04');
    var shelf = h('div', 'we-shelf');
    shelf.appendChild(exhibitCell('共同记录', entries.length));
    shelf.appendChild(exhibitCell('收藏', favN, favN > 0));
    shelf.appendChild(exhibitCell('接下来', upcoming.length));
    eSec.appendChild(shelf);
    eSec.appendChild(h('p', 'we-shelf-note', '有些东西并不贵，只是不能丢。'));
    /* 收藏馆入口行 */
    var favRow = h('div', 'we-fav-row');
    favRow.appendChild(h('span', 'we-fav-txt', favN ? '收藏里存着 ' + favN + ' 条' : '收藏还是空的'));
    var openBtn = h('button', 'we-fav-btn', '去收藏馆 →');
    openBtn.type = 'button';
    openBtn.addEventListener('click', function () {
      if (Sleepy.nav) Sleepy.nav.open('collection');
    });
    favRow.appendChild(openBtn);
    eSec.appendChild(favRow);
    out.appendChild(eSec);

    /* ---- 共同记录（在「此刻」下作为补充，或独立 —— 这里并入当前陈列） ----
       已在上方 facts 计数体现；为不打断 Demo 结构，共同记录列表收敛到
       「当前陈列」区块内以展台形式展示。若一条都没有，给 We 语境空态。 */
    if (entries.length) {
      var eg = h('div', 'we-entry-grid');
      entries.slice(0, 4).forEach(function (en) {
        var card = h('div', 'we-entry');
        var head = h('div', 'we-entry-head');
        head.appendChild(h('span', 'we-entry-title', en.title || '（未命名）'));
        head.appendChild(h('span', 'we-entry-day', fmtDay(en.at)));
        card.appendChild(head);
        if (en.note) card.appendChild(h('p', 'we-entry-note', en.note));
        /* 分类 + 来源两枚小标签（kind 老记录按 other 兼容） */
        var tags = h('div', 'we-entry-tags');
        tags.appendChild(h('span', 'we-entry-tag', WE_KIND_LABEL[kindOf(en)] || '其他'));
        if (en.sourceType && en.sourceType !== 'manual') {
          tags.appendChild(h('span', 'we-entry-tag we-entry-src', '来自 ' + srcLabel(en.sourceType)));
        }
        if (tags.childNodes.length) card.appendChild(tags);
        eg.appendChild(card);
      });
      eSec.appendChild(eg);
    } else {
      eSec.appendChild(h('p', 'we-none we-diy-hint', '先记下一件小事，We 会替你留着。'));
    }
  }

  /* ---- 数据预取辅助 ---- */

  function nextUpcoming(charId, days) {
    var cal = Sleepy.calendar;
    if (!cal || !cal.upcoming) return [];
    try {
      return arr(cal.upcoming(charId, days)).filter(function (r) {
        var e = r.event;
        return e && e.status !== 'cancelled' && e.status !== 'completed' &&
          e.eventType !== 'char_schedule';
      }).slice(0, 5);
    } catch (e) { return []; }
  }

  function nextAnniversary(charId) {
    var cal = Sleepy.calendar;
    if (!cal || !cal.upcoming) return null;
    try {
      var hit = null;
      arr(cal.upcoming(charId, 365)).some(function (r) {
        if (r.event.eventType !== 'anniversary') return false;
        if (r.event.status === 'cancelled' || r.event.status === 'completed') return false;
        hit = { title: String(r.event.title || '某个纪念日').trim(), inDays: r.inDays, date: r.date };
        return true;
      });
      return hit;
    } catch (e) { return null; }
  }

  function recentMoments(charId, userId) {
    var lf = Sleepy.lifeFeed;
    if (!lf || !lf.recent) return [];
    try { return arr(lf.recent(charId, userId)).slice(0, 6); }
    catch (e) { return []; }
  }

  /* ---- 渲染辅助 ---- */

  function weekKickerText(sb, char) {
    var cal = Sleepy.calendar;
    /* 尝试用角色创建时间推「第 N 个星期」；推不出就退成群岛/孤岛语气 */
    try {
      if (char && char.createdAt) {
        var weeks = Math.max(1, Math.round((Date.now() - char.createdAt) / (7 * 86400000)));
        return '第 ' + chnNum(weeks) + ' 个 星 期';
      }
    } catch (e) { /* 忽略 */ }
    return sb.kind === 'archipelago' ? '群 岛 · 关 系 空 间' : '孤 岛 · 关 系 空 间';
  }

  /* 中文化数字（只处理常用的，够 kicker 用） */
  function chnNum(n) {
    var d = '零一二三四五六七八九';
    if (n < 10) return d[n];
    if (n < 100) {
      var t = Math.floor(n / 10), u = n % 10;
      return (t > 1 ? d[t] : '') + '十' + (u ? d[u] : '');
    }
    return String(n);
  }

  function coverSubText(facts, upcoming, anniv) {
    var parts = [];
    /* 上次见面：从「此刻」事实里不好精确推，用最近时光/纪念日兜底语气 */
    var upTxt = upcoming[0] ? upcomingWhen(upcoming[0]) : '待定';
    var annTxt = anniv ? '还有 ' + anniv.inDays + ' 天' : '纪念日 · 待定';
    if (facts.length && facts[0]) parts.push(facts[0]);
    parts.push('下一件约定 · ' + upTxt);
    return parts.slice(0, 2).join('　　');
  }

  function upcomingWhen(r) {
    if (r.inDays === 0) return '今天';
    if (r.inDays === 1) return '明天';
    if (r.inDays === 2) return '后天';
    return String(r.date || '').slice(5) + ' · ' + r.inDays + ' 天后';
  }

  function factCell(n, label) {
    var f = h('div', 'we-fact');
    f.appendChild(h('b', '', String(n)));
    f.appendChild(h('span', '', label));
    return f;
  }

  function section(title, no) {
    var sec = h('section', 'we-sec');
    var head = h('div', 'we-sec-head');
    head.appendChild(h('span', 'we-sec-no', no));
    head.appendChild(h('span', 'we-sec-title', title));
    sec.appendChild(head);
    return sec;
  }

  /* 票根：直角无圆角，日期戳 + 斜纹 + 标题 + 描述 */
  function ticketEl(r) {
    var stub = h('div', 'we-stub');
    var date = h('div', 'we-stub-date');
    var d = new Date(r.date || Date.now());
    if (!isNaN(d.getTime())) {
      date.appendChild(h('b', '', String(d.getDate())));
      date.appendChild(h('span', '', 'WEEK'));  /* 简化：星期占位用 WEEK */
    } else {
      date.appendChild(h('b', '', '…'));
    }
    stub.appendChild(date);

    var sb2 = h('div', 'we-stub-body');
    var e = r.event;
    sb2.appendChild(h('h4', '', String(e.title || '').trim()));
    var meta = [];
    if (e.time) meta.push(String(e.time));
    if (e.place) meta.push(String(e.place));
    meta.push(upcomingWhen(r));
    if (meta.length) sb2.appendChild(h('p', '', meta.join(' · ')));
    stub.appendChild(sb2);
    return stub;
  }

  /* countdown 行：左文字右衬线数字 */
  function countdownRow(anniv) {
    var c = h('div', 'we-countdown');
    c.appendChild(h('span', '', anniv.title));
    var b = h('b', '', anniv.inDays === 0 ? '就是今天' :
      anniv.inDays === 1 ? '明天' : '还有 ' + anniv.inDays + ' 天');
    c.appendChild(b);
    return c;
  }

  /* 次要安排的小行 */
  function miniRow(r) {
    var ln = h('div', 'we-line');
    ln.appendChild(h('span', 'we-line-no', upcomingWhen(r)));
    var main = h('div', 'we-line-main');
    main.appendChild(h('b', '', String(r.event.title || '').trim()));
    ln.appendChild(main);
    return ln;
  }

  /* 展台格子：i 是「实物位」（渐变色块/纸纹），b+span 是标签 */
  function exhibitCell(label, n, tall) {
    var ex = h('div', 'we-exhibit' + (tall ? ' we-exhibit-tall' : ''));
    ex.appendChild(h('i', '', ''));
    ex.appendChild(h('b', '', label));
    ex.appendChild(h('span', '', n ? String(n) : '—'));
    return ex;
  }

  /* 关系副标：保留技术状态（已连/待连），但用 We 可读的语气 */
  function relationSub(sb, char, user) {
    var kind = sb.kind === 'archipelago' ? '群岛' : '孤岛';
    var link = core.findLink(char.id, user.id, sb.id);
    var tag = link ? '已连' : '待连';
    if (link) return kind + ' · 与 ' + char.name + ' 的关系 · ' + tag;
    return kind + ' · 还差一条线就能连上';
  }

  function srcLabel(type) {
    return ({
      manual: '手记',
      chat: '聊天',
      calendar: '日历',
      moments: '朋友圈',
      photo: '照片',
      offline: '线下'
    }[type] || type);
  }

  /* 空态：完整可读，不炸页面。用项目既有 .empty 外壳。 */
  function empty(ctx, title, hint) {
    var box = h('div', 'empty');
    box.appendChild(h('div', 'empty-paper'));
    box.appendChild(h('p', 'empty-text', title));
    box.appendChild(h('p', 'empty-hint', hint));
    return box;
  }

  /* ============================ 注册 ============================ */

  Sleepy.register('we', {
    title: 'We',

    /* render 只跑一次（页面缓存复用）：建好首屏 + 顶栏动作。 */
    render: function (ctx) {
      ctx.setTitle('We');
      ctx.setActions([{
        label: '记一条',
        svg: ic('<path d="M12 6.5v11M6.5 12h11"/>', 18),
        onClick: function () { openAddDrawer(ctx); }
      }]);
      paint(ctx);
    },

    /* onShow 每次进页 / 切岛都会重读数据重画 —— 这就是 page-switch 调
       topCtx().refresh() 时的落点，保证切岛后数据不串线。 */
    onShow: function (ctx) {
      paint(ctx);
    }
  });

  /* 导出 weStore，供冒烟核对「落盘 / 带 sandboxId / 隔离 / kind 兼容」。 */
  Sleepy.weStore = {
    list: weList,
    add: weAdd,
    KEY: WE_KEY,
    KINDS: WE_KINDS,
    kindOf: kindOf,
    KIND_LABEL: WE_KIND_LABEL
  };

})(window);
