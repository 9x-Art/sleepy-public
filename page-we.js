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

   —— 三页导航（weNav，2026-09-28 实施单）——
   We 空间三个主页面：首页('we') / 时光('we-time') / 收藏馆('collection')，
   三处挂同一条 .we-tabbar（本文件导出 Sleepy.weNav.mount，幂等）。
   切 Tab 走 Sleepy.nav.replace：栈深不变、浏览器历史用 replaceState 原地替换
   （见 app.js），反复切换不涨返回栈，按一次返回就退出 We。
   二级页（collection-item / collection-proposal）不挂底栏，返回回实际来源页。
   新增「＋」是动作不是第四页：复用 openAddDrawer（可访问名称「记一条共同记录」）。

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

  /* ============================ 三页共享底栏（weNav） ============================
     We 空间三个主页面（首页 'we' / 时光 'we-time' / 收藏馆 'collection'）
     挂同一条 .we-tabbar：同一风格、同一行为、当前项高亮。
     布局借 .page.has-tabbar 的通用机制（style.css）：滚动交给 .app-body，
     底栏是 .page-inner 里的文档流兄弟（flex:none 常驻）——
     不 fixed 到 #phone，也不碰宿主浏览器底部。
     二级页（collection-item / collection-proposal）不挂它，返回回实际来源页。 */

  var WE_TABS = [
    { id: 'we', name: '首页' },
    { id: 'we-time', name: '时光' },
    { id: 'collection', name: '收藏馆' }
  ];

  /* 挂底栏（幂等）：render 可能因 applyParams 重跑，条已挂过就只更新高亮。
     onShow / 切岛重画只清 ctx.body，不会把 bar 删掉，也不会长出第二份。 */
  function mountBar(ctx, activeId) {
    var inner = ctx.el.querySelector('.page-inner');
    if (!inner) return;
    ctx.el.classList.add('has-tabbar');
    var bar = inner.querySelector('.we-tabbar');
    if (!bar) {
      bar = h('nav', 'we-tabbar');
      bar.setAttribute('aria-label', 'We 导航');
      WE_TABS.forEach(function (t) {
        var b = h('button', 'we-tab');
        b.type = 'button';
        b.appendChild(h('span', 'we-tab-tx', t.name));
        b.appendChild(h('i', 'we-tab-line'));       /* 选中项砖红短下划线 */
        b.__weTabId = t.id;
        b.addEventListener('click', function () { goTab(t.id); });
        bar.appendChild(b);
      });
      /* ＋ 是动作不是第四个 Tab：复用同一个新增抽屉和保存出口 */
      var add = h('button', 'we-tab-add');
      add.type = 'button';
      add.setAttribute('aria-label', '记一条共同记录');
      add.title = '记一条共同记录';
      add.innerHTML = ic('<path d="M12 6v12M6 12h12"/>', 20);
      add.addEventListener('click', function () { openAddDrawer(ctx); });
      bar.appendChild(add);
      inner.appendChild(bar);
    }
    Array.prototype.forEach.call(bar.querySelectorAll('.we-tab'), function (b) {
      var on = b.__weTabId === activeId;
      b.classList.toggle('is-on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      /* 提议角标：只挂收藏馆 tab —— char 提议了而 user 还没处理时，
         不进收藏馆也能在底栏看见。countPending 是 scoped 口径（本岛 pending）。 */
      if (b.__weTabId === 'collection') {
        var n = 0;
        try {
          n = (Sleepy.weProposals && Sleepy.weProposals.countPending)
            ? Sleepy.weProposals.countPending() : 0;
        } catch (e) { /* 提议模块没就绪不当回事 */ }
        var dot = b.querySelector('.we-tab-badge');
        if (n > 0) {
          if (!dot) { dot = h('i', 'we-tab-badge'); b.appendChild(dot); }
          dot.textContent = String(Math.min(n, 9) + (n > 9 ? '+' : ''));
          dot.setAttribute('aria-label', n + ' 条待确认提议');
        } else if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      }
    });
  }

  /* 主 Tab 切换：点当前页自己 = 无事发生（不重挂、不加历史、不触发写入）。
     其余一律 nav.replace：栈深不变；浏览器历史由 app.js 的 replaceHist
     原地替换（replaceState）—— 反复切换不涨返回栈，按一次返回就退出 We，
     进入 We 之前的返回目标原样保留。目标已在栈里时（正文入口推进来的
     深层场景）open 自己会退回那一层，app.js 的 replace 会补喊 onShow。 */
  function goTab(id) {
    var nav = Sleepy.nav;
    if (!nav || nav.top() === id) return;
    nav.replace(id);
  }

  /* 重画时保留滚动位置：切 Tab / 切岛都会整页重画（onShow 重读重画），
     ctx.body（.app-body，has-tabbar 下的滚动容器）的 scrollTop 在
     innerHTML 清空时会被钳到 0 —— 先存后还，普通切换不丢位置。 */
  function paintKeepingScroll(ctx, build) {
    var st = 0;
    try { st = ctx.body.scrollTop || 0; } catch (e) { /* 桩环境没有 */ }
    build();
    try { ctx.body.scrollTop = st; } catch (e) { /* 同上 */ }
  }

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
    /* C1 藏品实物化：照片类藏品带「未显影」出厂态 —— 详情页拍立得组件
       首次长按显影后再存 developed:true（page-collection.js 写回）。
       老记录没有 developed 字段 → 详情按「已显影」兼容（不打扰存量藏品）。 */
    if (kindOf(rec) === 'photo') entry.developed = rec.developed === true;
    /* 写入必须带当前 sandboxId —— 由 tagScope 盖章（不手写）。 */
    core.tagScope(entry, sandboxId);

    var list = arr(store.get(WE_KEY));
    list.push(entry);
    store.set(WE_KEY, list);
    return entry;
  }

  /* C1：就地补写一条共同记录的少量展示字段（白名单）。
     用于票根背面留言补齐（memoUser / memoChar）与拍立得显影标记（developed）；
     C2 贴纸工坊后续写 stickers 也走这里。
     纪律：**只允许当前房 scoped 可见的 id**（跟详情页 findInScope 同口径，
     杜绝跨岛改数据）；白名单外字段一律丢弃；命中即盖 updatedAt。 */
  var WE_PATCH_FIELDS = ['memoUser', 'memoChar', 'developed', 'stickers'];
  function wePatch(id, fields) {
    if (!id || !fields || typeof fields !== 'object') return { ok: false, why: 'bad-args' };
    var list = arr(store.get(WE_KEY));
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || list[i].id !== id) continue;
      /* 范围卫兵：当前房读不到 = 不属于这里，绝不改 */
      if (core.scoped([list[i]]).length !== 1) return { ok: false, why: 'out-of-scope' };
      WE_PATCH_FIELDS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) list[i][k] = fields[k];
      });
      list[i].updatedAt = Date.now();
      store.set(WE_KEY, list);
      return { ok: true };
    }
    return { ok: false, why: 'not-found' };
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
        /* 刷新交给宿主页自己的 onShow（ctx.refresh）—— 底栏把抽屉带到了
           三个主页面，谁打开的谁刷自己（首页 paint / 时光重聚合 / 门厅重读）。
           挂 ctx.body 之外的抽屉不依赖页面 DOM，重画不影响它（已 close）。 */
        if (typeof ctx.refresh === 'function') ctx.refresh();
        else paint(ctx);
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

  /* ============================ 群岛选人闸（2026-10-02） ============================
   群岛从浮岛降落时**有意不替人选身份**（landInto，身份留给切号器/桌面下拉），
   老版 We 这时候进来是个死胡同空态（「这里还没有确定的关系对象」没有下一步）。
   这里补一道闸，对齐日历 viewSyncSandbox 的群岛纪律：
     · 身份已齐（char + user 都在本岛名册）→ 直接放行；
     · 孤岛 / 群岛单大号 → 自动归位（降落纪律：大号 + isDefault 马甲）；
     · 群岛多人 → We 语境选人页，点选 = **进入身份**（switchTo 全局生效，
       与切号器同语义）—— 不是 We 私有视图状态，否则 We 显示 A、
       聊天列表却是 B，精神分裂。选完顺手重放岛视觉 + 重画常驻桌面。
   时光 / 收藏馆经 Sleepy.weGate 共用同一道闸。 */
  var weGateView = { sbId: null };

  function weGateMains() {
    var sb = core.activeSandbox();
    if (!sb || !core.charsOfSandbox) return [];
    return core.charsOfSandbox(sb.id).filter(function (c) {
      return (c.kind || 'main') === 'main';
    });
  }

  /* 头像底色：id 派生暖调（与日历选人页同思路，同一人永远同一张脸）；
     core.setAvatarBg 异步挂真头像（有图时盖上去）。 */
  var WE_PICK_TONES = ['linear-gradient(145deg,#8C7355,#C0A483)',
    'linear-gradient(145deg,#9A6E62,#C9A091)',
    'linear-gradient(145deg,#7E7A5E,#B3AE8B)',
    'linear-gradient(145deg,#8A6E7C,#BCA0AC)',
    'linear-gradient(145deg,#87745A,#BCA98B)'];
  function wePickTone(id) {
    var s = String(id || ''); var hh = 5381;
    for (var i = 0; i < s.length; i++) hh = ((hh << 5) + hh + s.charCodeAt(i)) >>> 0;
    return WE_PICK_TONES[hh % WE_PICK_TONES.length];
  }

  function weGatePaint(ctx, host, mains, bigMe, repaint) {
    host.appendChild(h('div', 'we-pick-hero-kicker', 'ARCHIPELAGO'));
    host.appendChild(h('h2', 'we-pick-hero-title', '想和谁一起翻开 We？'));
    host.appendChild(h('p', 'we-pick-hero-note',
      '群岛上每个人有各自的时光与收藏。选一位，We 就为你们两个打开。'));
    var list = h('div', 'we-pick-list');
    mains.forEach(function (ch) {
      var name = String(ch.name || '').trim() || '他';
      var b = h('button', 'we-pick-card');
      b.type = 'button';
      var av = h('span', 'we-pick-avatar');
      av.textContent = name.slice(0, 1);
      av.style.background = wePickTone(ch.id);
      if (core.setAvatarBg) { try { core.setAvatarBg(av, ch); } catch (e) { /* 桩没有 */ } }
      b.appendChild(av);
      var info = h('span', 'we-pick-info');
      info.appendChild(h('b', '', name));
      info.appendChild(h('span', '', '进入 TA 的 We'));
      b.appendChild(info);
      b.appendChild(h('span', 'we-pick-go', '›'));
      b.onclick = function () {
        core.switchTo(ch.id, bigMe ? bigMe.id : undefined);
        /* 换身份 = 换视觉（岛覆盖 > 全局）；桌面是常驻底层，一并重画 */
        if (Sleepy.appearance && Sleepy.appearance.apply) {
          try { Sleepy.appearance.apply(); } catch (e) { /* 桩没有 */ }
        }
        if (Sleepy.__homeCtx && Sleepy.__homeCtx.repaint) {
          try { Sleepy.__homeCtx.repaint(); } catch (e) { /* 桩没有 */ }
        }
        if (ctx.toast) ctx.toast('和「' + name + '」打开 We', 'ok');
        /* we / we-time 的 render 不设 ctx.__paint —— 重画必须走调用方
           显式传进来的 repaint（'collection' 系页才有 ctx.__paint） */
        if (repaint) repaint();
      };
      list.appendChild(b);
    });
    host.appendChild(list);
  }

  /* 返回 true = 已接管渲染（调用方把容器挂进 DOM 后直接 return）。
     repaint：身份选完后的重绘回调（当前页自己的 paint 闭包）。 */
  function weGateApply(ctx, host, repaint) {
    var sb = core.activeSandbox();
    if (!sb) return false;
    if (weGateView.sbId !== sb.id) weGateView.sbId = sb.id;   /* 换岛：预留重置位 */
    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (char && user) return false;
    var mains = weGateMains();
    if (!mains.length) return false;                          /* 空岛 → 原空态兜 */
    var bigMe = core.defaultUserOfSandbox ? core.defaultUserOfSandbox(sb) : null;
    if (!core.needsCharPick(sb)) {
      /* 孤岛 / 单大号：归位不出选人页（对齐日历 §2.1） */
      core.switchTo(mains[0].id, bigMe ? bigMe.id : undefined);
      return false;
    }
    var hero = h('div', 'we-pick-hero');
    weGatePaint(ctx, hero, mains, bigMe, repaint);
    host.appendChild(hero);
    return true;
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
    var __st = 0;
    try { __st = body.scrollTop || 0; } catch (e) { /* 桩环境没有 */ }
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

    /* 群岛选人闸：身份没定时先选人（孤岛/单大号在这里自动归位） */
    if (weGateApply(ctx, out, function () { paint(ctx); })) return;

    var user = core.activeUserOnIsland();
    var char = core.activeCharOnIsland();
    if (!user || !char) {
      out.appendChild(empty(ctx, '这座岛还没有可以一起记事的人',
        '先给岛上添一位角色，We 才能开始。'));
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
    /* 馆藏戳记：右下角一枚透印章，像手账扉页上的收藏印 */
    cover.appendChild(h('span', 'we-cover-stamp', '共 同 留 存'));

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

    /* ---- 03 最近时光：错位拍立得（真实照片，无图退纸纹底） ---- */
    var rSec = section('最近时光', '03');
    if (recent.length) {
      var strip = h('div', 'we-polaroid');
      recent.slice(0, 6).forEach(function (it, i) {
        var pl = h('figure', 'we-polaroid-card');
        var ph = h('i', 'we-polaroid-photo we-ph' + (i % 3));
        pl.appendChild(ph);
        var line = String(it.line || '').trim();
        var em = h('em', '', (fmtDay(it.at) || '此刻') + (line ? ' · ' + line.slice(0, 10) : ''));
        pl.appendChild(em);
        strip.appendChild(pl);
        /* strip 已在 DOM 里（out 先 insert 进 body 再建内容），
           这里才能按「挂进 DOM 后才加载」的纪律铺真图 */
        fillThumb(ph, it.mediaId);
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
    /* 重画不丢滚动位置（切 Tab / 切岛 onShow 重画是常态） */
    try { body.scrollTop = __st; } catch (e) { /* 桩环境没有 */ }
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

  /* ============================ 时光（v1） ============================
     定位：按时间浏览当前关系内**真实发生过**的共同经历。
       · 首页「最近时光」是摘要（lifeFeed.recent，TA 视角、有窗口上限）
       · 时光页是可继续浏览的列表（user 视角、全量回溯、分批渲染）
       · 收藏馆是主动选择留下的藏品
     三个来源（全部是已接入的真实读取出口，只读聚合，不建新仓库）：
       ① 朋友圈   momentsTab.all() + core.scoped，关系内（TA 发的 +
                  当前号我发的），**user 视角三道闸 canSee(m, user.id,'user')**
                  —— 红线：「user 能看到的」≠「char 能看到的」。这里给
                  user 看，方向必须用 canSee，不能用 canCharSee。
       ② 日记     diary.list()（scoped）：TA 写的挂他名下；我写的按号隔离
                  （缺 userId 的旧数据 **fail closed** —— 拿不准归属的私密
                  内容不进时光，与记忆可见性同纪律；日记页全量显示不受影响）；
                  待补（status='pending'）还没发生，不冒充经历，排除。
       ③ 共同记录 weStore.list()（scoped）：已入馆的记录。P2 的 pending
                  提议在 weProposals 表里，天然混不进来。
     不收日历：lifeFeed 只接入「即将到来」（未来约定留在首页「接下来」）；
     已发生事件的 user 可见性口径（TA 的 private 事件不能泄进来）需要
     单独拍板，v1 不擅自扩 —— 见回交「尚未覆盖的来源」。
     排序：真实发生时间倒序；缺时间的排最后、显示「时间不详」，不编日期。
     去重：type + id（真实稳定来源标识），不靠标题合并。
     分页：三张表都是本机小表，全量读、按 TIME_BATCH 分批渲染，
     「加载更多」真实可继续 —— 不只给最近几条就冒充全量。 */

  var TIME_BATCH = 30;

  /* at 归一：number 直用；日期字符串（char 提议入馆的 startAt、
     个别日记字符串时间戳）走 Date.parse；解析不出一律 0 →「时间不详」，
     绝不产生纪元日期。排序 / 分组 / 展示全部吃这个出口，不各算各的。
     时区：本地 Date = user 设备系统时区 —— 这正是运行时时区唯一出口
     （calendar.runtimeTzOf）在「未选择时区」档的语义，两边天然一致；
     char 显式时区只影响「他那边」的注入行（timeFacts），不改写 user
     浏览自己经历的分组（历史条目原始时间语义不动）。 */
  function atNum(v) {
    if (typeof v === 'number') return isNaN(v) ? 0 : v;
    if (!v) return 0;
    var n = new Date(v).getTime();
    return isNaN(n) ? 0 : n;
  }

  /* ---- 来源可见性判据（唯一出口）----
     列表读取（timeItems）与点击复核（jumpToSource → sourceStatus）
     共用同一组判据，改一处两边同步。上下文（角色/号）缺失、权限接口
     缺失一律 fail closed。 */

  /* 这条朋友圈在当前关系（char × user）下 user 能不能看 */
  function momentVisibleToUser(m, char, user) {
    if (!m || m.status === 'deleted') return false;
    if (!char || !user) return false;
    if (!(m.characterId === char.id || m.maskId === user.id)) return false;  /* 关系内 */
    var M = Sleepy.momentsTab;
    return !!(M && M.canSee && M.canSee(m, user.id, 'user'));
  }

  /* 这篇日记在当前关系（char × user）下 user 能不能看 */
  function diaryVisibleToUser(d, char, user) {
    if (!d || !d.content || d.status === 'pending') return false;  /* 待补 ≠ 已发生 */
    if (!char || !user) return false;
    if ((d.author || 'user') === 'char') {
      return d.charId === char.id;        /* TA 写的：挂他名下才收（归属即权限） */
    }
    /* 我写的按号隔离。缺 userId 的旧数据 fail closed（见文件头注释）。 */
    return !!d.userId && d.userId === user.id;
  }

  /* 点击复核用：按 src+id 实时回源，返回 'ok' | 'gone' | 'denied'。
     gone = 记录本身没了；denied = 还在但当前上下文 / 权限看不到。 */
  function sourceStatus(src, id) {
    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (!char || !user) return 'denied';                    /* 上下文缺失 fail closed */
    if (src === 'moments') {
      var M = Sleepy.momentsTab;
      if (!M || !M.byId || !M.canSee) return 'denied';      /* 权限接口缺失 fail closed */
      var m = M.byId(id);
      if (!m || m.status === 'deleted') return 'gone';
      if (m.sandboxId && core.scopeId() && m.sandboxId !== core.scopeId()) return 'gone';
      return momentVisibleToUser(m, char, user) ? 'ok' : 'denied';
    }
    if (src === 'diary') {
      var D = Sleepy.diary;
      if (!D || !D.list) return 'denied';
      var d = findDiary(id);
      if (!d) return 'gone';
      if (d.sandboxId && core.scopeId() && d.sandboxId !== core.scopeId()) return 'gone';
      return diaryVisibleToUser(d, char, user) ? 'ok' : 'denied';
    }
    if (src === 'we') {
      var cs = Sleepy.collectionStore;
      if (!cs || !cs.findInScope) return 'denied';
      return cs.findInScope(id) ? 'ok' : 'gone';
    }
    return 'denied';
  }

  /* 时光聚合。char / user 显式传入（指针卫兵在 paintTime 解析一次），
     纯读、无副作用 —— 冒烟直接调它做隔离断言。可见性判据与点击复核
     共用（见上），不另写一份。 */
  function timeItems(char, user) {
    var out = [];
    var seen = {};

    /* ① 朋友圈（user 视角三道闸，判据共用） */
    var M = Sleepy.momentsTab;
    if (M && M.all && M.canSee && char && user) {
      core.scoped(arr(M.all())).forEach(function (m) {
        if (!momentVisibleToUser(m, char, user)) return;
        if (seen['moments:' + m.id]) return;
        seen['moments:' + m.id] = true;
        var mine = !!m.maskId && m.maskId === user.id;
        out.push({
          src: 'moments', id: m.id, at: atNum(m.at),
          title: String(m.text || '').trim() || (m.mediaId ? '（发了一张图）' : '（无文字）'),
          note: '', mediaId: m.mediaId || null, mine: mine
        });
      });
    }

    /* ② 日记（user 视角，判据共用） */
    var D = Sleepy.diary;
    if (D && D.list && char && user) {
      D.list().forEach(function (d) {
        if (!diaryVisibleToUser(d, char, user)) return;
        if (seen['diary:' + d.id]) return;
        seen['diary:' + d.id] = true;
        out.push({
          src: 'diary', id: d.id, at: atNum(d.timestamp),
          title: String(d.content).replace(/\s+/g, ' ').trim().slice(0, 60),
          note: '', mediaId: d.mediaId || null,
          mine: (d.author || 'user') !== 'char'
        });
      });
    }

    /* ③ 共同记录。边界 = 岛（scoped）：同岛多角色 / 多账号共享全部记录，
       refCharId / refUserId 只是归属档案不是 ACL —— 这是产品既定口径
       （weEntries 主表 scoped 过滤），不擅自收紧成关系过滤。 */
    if (Sleepy.weStore && Sleepy.weStore.list) {
      Sleepy.weStore.list().forEach(function (en) {
        if (!en || !en.id) return;
        if (seen['we:' + en.id]) return;
        seen['we:' + en.id] = true;
        out.push({
          src: 'we', id: en.id, at: atNum(en.at),
          title: en.title || '（未命名）',
          note: en.note || '',
          kind: kindOf(en), createdBy: en.createdBy || 'user',
          mine: en.createdBy !== 'char'
        });
      });
    }

    /* at 已全部归一为数字（无效 = 0），排序不会出 NaN */
    return out.sort(function (a, b) { return b.at - a.at; });
  }

  function timeSrcLabel(it) {
    if (it.src === 'moments') return '朋友圈';
    if (it.src === 'diary') return it.mine ? '日记 · 我写的' : '日记 · TA 写的';
    return it.kind && it.kind !== 'other'
      ? '共同记录 · ' + (WE_KIND_LABEL[it.kind] || '其他')
      : '共同记录';
  }

  function dayKeyOf(at) {
    if (!at) return '';
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function dayLabelOf(at) {
    if (!at) return '时间不详';           /* 0 / 缺失 → 时间不详，绝不出纪元日期 */
    var d = new Date(at);
    if (isNaN(d.getTime())) return '时间不详';
    var y = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '年';
    return y + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' +
      '日一二三四五六'.charAt(d.getDay());
  }

  /* 缩略图只铺真实可用的图（mediaId → objectURL），挂不上就留纸纹底。
     **必须在卡片挂进 DOM 之后才启动加载**（appendBatch 里调）——
     构建期 isConnected 必为假，提前调等于永远不发请求。
     异步回来检查 isConnected：重画 / 切岛 / 切上下文后旧节点已摘除，
     旧响应改不到新视图；图不在了保持纸纹占位。 */
  function fillThumb(img, mediaId) {
    if (!mediaId || !img.isConnected || !Sleepy.media || !Sleepy.media.url) return;
    Sleepy.media.url(mediaId).then(function (u) {
      if (u && img.isConnected) {
        img.style.backgroundImage = 'url(' + u + ')';
        img.classList.add('has-img');
      }
    })['catch'](function () { /* 图不在了就保持纸纹位 */ });
  }

  function timeItemEl(ctx, it) {
    var card = h('button', 'co-card we-time-item');
    card.type = 'button';
    var head = h('div', 'co-card-head');
    head.appendChild(h('span', 'co-card-title', it.title || '（无标题）'));
    head.appendChild(h('span', 'co-card-day', it.at ? fmtDay(it.at) : '时间不详'));
    card.appendChild(head);
    if (it.note) card.appendChild(h('p', 'co-card-note', it.note));
    var foot = h('div', 'co-card-src');
    foot.appendChild(h('span', '', timeSrcLabel(it)));
    card.appendChild(foot);
    if (it.mediaId) card.appendChild(h('i', 'we-time-thumb'));
    /* 点击：先复核来源还在 / 还可看（删除 / 失效 / 无权都在这里拦下，
       明确反馈不跳页），再打开对应页面**定位到那条记录**，不是只把
       来源 App 首页打开。 */
    card.addEventListener('click', function () { jumpToSource(ctx, it); });
    return card;
  }

  /* 时光 → 来源定位。momentCard / diary 列表条目带 data-id（表现层挂钩）。
     点击时按 sourceStatus 实时复核当前岛 / 角色 / 号 / 状态 / 权限：
       gone   → 「已经不在了」类反馈；
       denied → 「当前身份看不到」类反馈；
     都停在原地不跳页。通过才打开对应页面并定位到那条记录。 */
  function jumpToSource(ctx, it) {
    var nav = Sleepy.nav;
    if (!nav) return;
    var st = sourceStatus(it.src, it.id);
    if (st !== 'ok') {
      ctx.toast(st === 'gone' ? sourceGoneText(it.src) : '现在这个身份看不到它了', 'warn');
      return;
    }
    if (it.src === 'moments') {
      nav.open('moments', { tab: 'moments', jump: it.id });
      /* 这次「来源浏览」给朋友圈页打标记：返回守卫放行一次，
         返回键 / 浏览器返回直接回时光；桌面进入的聊天语义不变。 */
      var tc = nav.topCtx();
      if (tc) tc.__weSourceJump = true;
      revealInPage(ctx, 'moments', it.id);
    } else if (it.src === 'diary') {
      nav.open('diary');
      revealInPage(ctx, 'diary', it.id);
    } else {
      nav.open('collection-item', { id: it.id });
    }
  }

  function sourceGoneText(src) {
    return src === 'moments' ? '这条动态已经不在了'
      : src === 'diary' ? '这一篇已经撕掉了'
      : '这件记录已经不在馆里';
  }

  function findDiary(id) {
    var D = Sleepy.diary;
    if (!D || !D.list) return null;
    var hit = null;
    D.list().forEach(function (d) { if (d && d.id === id) hit = d; });
    return hit;
  }

  /* 在目标页里定位那条记录：手动算滚动容器内偏移（工作记忆红线：
     scrollIntoView 居中会把整个 .page 搬走），滚动后短高亮。
     目标还没渲染（页面实例是旧的、列表还是上一份 DOM）→ 借目标页
     现有的 rebuild / refresh 重画一次再找；两次都找不到**明确反馈**，
     不静默失败。 */
  function revealInPage(ctx, pageId, id, retried) {
    var page = document.querySelector('.page[data-page="' + pageId + '"]');
    var el = page && page.querySelector('[data-id="' + id + '"]');
    if (!el && !retried) {
      var tc = Sleepy.nav.topCtx();
      var fn = tc && (tc.rebuild || tc.refresh);
      if (fn) { try { fn.call(tc); } catch (e) { /* 重画失败按找不到处理 */ } }
      return revealInPage(ctx, pageId, id, true);
    }
    if (!el) {
      ctx.toast('没定位到那条，它可能刚被移走', 'warn');
      return;
    }
    var c = el.parentNode;
    while (c && c !== document.body) {
      var cs = null;
      try { cs = getComputedStyle(c); } catch (e) { /* 桩环境 */ }
      if (cs && /(auto|scroll)/.test(cs.overflowY) &&
          c.scrollHeight > c.clientHeight && c.clientHeight > 0) break;
      c = c.parentNode;
    }
    if (c && c !== document.body) {
      try {
        var delta = el.getBoundingClientRect().top -
          c.getBoundingClientRect().top - 90;
        c.scrollTop += delta;
      } catch (e) { /* 桩环境没有 */ }
    }
    el.classList.add('we-jump-flash');
    setTimeout(function () { el.classList.remove('we-jump-flash'); }, 1600);
  }

  function paintTime(ctx) {
    ctx.setTitle('时光');
    ctx.setActions([]);

    var body = ctx.body;
    var __st = 0;
    try { __st = body.scrollTop || 0; } catch (e) { /* 桩环境没有 */ }
    body.innerHTML = '';
    var paper = h('div', 'we-page-paper we-time-page');
    body.appendChild(paper);

    /* 关系上下文守卫（与首页同款：We 不自猜岛） */
    var sb = core.activeSandbox();
    if (!sb) {
      paper.appendChild(empty(ctx, '还没有当前世界',
        '先在桌面选一间房，再回来看时光。'));
      return;
    }
    /* 群岛选人闸（与首页同一道） */
    if (weGateApply(ctx, paper, function () { paintTime(ctx); })) return;
    var user = core.activeUserOnIsland();
    var char = core.activeCharOnIsland();
    if (!user || !char) {
      paper.appendChild(empty(ctx, '这座岛还没有可以一起回看的人',
        '先给岛上添一位角色，时光才会开始。'));
      return;
    }

    /* 批次展开状态带「岛|角色|号」签名。**先重置再画**：换岛 / 换角色 /
       换号（哪怕目标上下文是空态）一律不继承上一个上下文的展开进度。 */
    var memo = ctx.__weTimeMemo;
    var sig = sb.id + '|' + char.id + '|' + user.id;
    if (!memo || memo.sig !== sig) memo = ctx.__weTimeMemo = { sig: sig, shown: TIME_BATCH };

    /* 聚合失败 ≠ 空数据：给重试，不把失败当空态 */
    var items;
    try {
      items = timeItems(char, user);
    } catch (e) {
      var errBox = h('div', 'empty co-empty');
      errBox.appendChild(h('div', 'empty-paper'));
      errBox.appendChild(h('p', 'empty-text', '时光暂时读不出来'));
      var retry = ui.button('重试', 'primary');
      retry.type = 'button';
      retry.addEventListener('click', function () { paintTime(ctx); });
      errBox.appendChild(retry);
      paper.appendChild(errBox);
      return;
    }

    /* 封面：与首页 / 门厅同一套视觉语言 */
    var cover = h('div', 'we-cover we-time-cover');
    cover.appendChild(h('div', 'we-cover-vert', 'OUR TIME'));
    var ct = h('div', 'we-cover-txt');
    ct.appendChild(h('div', 'we-cover-kicker', 'W E · 时 光'));
    ct.appendChild(h('div', 'we-cover-title',
      String(char.name || '未命名').trim() + ' × ' + core.labelOfUser(user, '我')));
    ct.appendChild(h('div', 'we-cover-sub', '一起经过的，都替你们记着。'));
    cover.appendChild(ct);
    paper.appendChild(cover);

    if (!items.length) {
      var box = h('div', 'empty co-empty');
      box.appendChild(h('div', 'empty-paper'));
      box.appendChild(h('p', 'empty-text', '这里还没有一起经过的片段。'));
      var addBtn = ui.button('记一条', 'primary');
      addBtn.type = 'button';
      addBtn.addEventListener('click', function () { openAddDrawer(ctx); });
      box.appendChild(addBtn);
      paper.appendChild(box);
      return;
    }

    /* 按日分组 + 分批渲染：target 取 memo 记住的展开条数（数据减少时
       钳位到现有条数），先把足够条目铺出来，最后再恢复滚动位置 ——
       位置才有东西可落。 */
    var target = Math.min(Math.max(memo.shown, TIME_BATCH), items.length);

    var listEl = h('div', 'we-time-list');
    paper.appendChild(listEl);
    var shown = 0;
    var lastDay = null;

    function appendBatch() {
      var end = Math.min(shown + TIME_BATCH, items.length);
      for (var i = shown; i < end; i++) {
        var it = items[i];
        var dk = dayKeyOf(it.at);
        if (dk !== lastDay) {
          listEl.appendChild(h('div', 'we-time-day', dayLabelOf(it.at)));
          lastDay = dk;
        }
        var card = timeItemEl(ctx, it);
        listEl.appendChild(card);
        /* 缩略图在卡片**挂进 DOM 之后**才启动加载（见 fillThumb 注释） */
        var th = card.querySelector('.we-time-thumb');
        if (th) fillThumb(th, it.mediaId);
      }
      shown = end;
      memo.shown = shown;
      var oldMore = listEl.querySelector('.we-time-more');
      if (oldMore && oldMore.parentNode) oldMore.parentNode.removeChild(oldMore);
      if (shown < items.length) {
        var moreBtn = h('button', 'we-time-more', '还有更早的 · 加载更多');
        moreBtn.type = 'button';
        moreBtn.addEventListener('click', appendBatch);
        listEl.appendChild(moreBtn);
      }
    }
    while (shown < target) appendBatch();

    try { body.scrollTop = __st; } catch (e) { /* 桩环境没有 */ }
  }

  /* ============================ 注册 ============================ */

  Sleepy.register('we', {
    title: 'We',

    /* render 只跑一次（页面缓存复用）：建好首屏 + 顶栏动作 + 三页底栏。 */
    render: function (ctx) {
      ctx.setTitle('We');
      ctx.setActions([{
        label: '记一条',
        svg: ic('<path d="M12 6.5v11M6.5 12h11"/>', 18),
        onClick: function () { openAddDrawer(ctx); }
      }]);
      mountBar(ctx, 'we');
      paint(ctx);
    },

    /* onShow 每次进页 / 切岛都会重读数据重画 —— 这就是 page-switch 调
       topCtx().refresh() 时的落点，保证切岛后数据不串线。 */
    onShow: function (ctx) {
      paint(ctx);
    }
  });

  /* 时光（v1）：user 视角的已发生共同经历，只读聚合三个真实来源 */
  Sleepy.register('we-time', {
    title: '时光',
    render: function (ctx) {
      mountBar(ctx, 'we-time');
      paintTime(ctx);
    },
    onShow: function (ctx) {
      paintTime(ctx);
    }
  });

  /* 导出 weStore，供冒烟核对「落盘 / 带 sandboxId / 隔离 / kind 兼容」。 */
  Sleepy.weStore = {
    list: weList,
    add: weAdd,
    patch: wePatch,
    KEY: WE_KEY,
    KINDS: WE_KINDS,
    kindOf: kindOf,
    KIND_LABEL: WE_KIND_LABEL
  };

  /* 三页共享底栏 + 新增抽屉的对外出口：'collection' 门厅（page-collection.js）
     也挂这条 bar；冒烟核对 TABS / 幂等挂载。openAdd = 同一个新增抽屉。 */
  Sleepy.weNav = {
    mount: mountBar,
    openAdd: openAddDrawer,
    TABS: WE_TABS
  };

  /* 时光聚合的只读出口（冒烟做隔离 / 排序 / 排除断言用，不承担写入）。
     sourceStatus / dayLabel 一并导出：点击复核状态机与时间展示的测试锚点。 */
  Sleepy.weTime = {
    collect: timeItems,
    BATCH: TIME_BATCH,
    sourceStatus: sourceStatus,
    dayLabel: dayLabelOf,
    atNum: atNum
  };

})(window);
