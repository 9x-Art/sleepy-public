/* ============================================================
   page-island.js — 浮岛（造物主层）
   依赖：store.js、core.js、ui.js、app.js
   页面：island（云海 + 两座岛，左右滑动）
         → island-saves（某座岛的存档列表 + 新建）
         → island-config（配置台 · 横向关系树）

   ---- 三层，别压成两层 ----
     第一层  island        一屏一座岛，**左右滑动**在孤岛 / 群岛之间游荡。
                           岛上不摆任何存档，点岛才进去。
                           两座岛之间由一条飘带连着，跨过屏幕分界 ——
                           所以滑到中间那一下，能看见带子在两座岛之间绷着。
     第二层  island-saves  这座岛的存档列表 + 新建。
     第三层  island-config 关系树 + 加人设 + 马甲 + 认知锁 + 降落。

   ---- 关系树为什么是横的 ----
   星轨（同心圆）画出来是个竖着堆的形状，一两个角色还行，人一多就堆成塔。
   关系树从左往右长：「我」在左端，每个角色往右排开，NPC 挂在自己那个人
   下面。**连线的中间可以写关系**（青梅竹马、上下级…）—— 这一段文本存在
   links 上（links 本来就是「一对 Char × User 的关系」）。

   ---- 岛上文案是古诗 ----
   孤岛 = 一生一代一双人（纳兰性德《画堂春》）
   群岛 = 乱花渐欲迷人眼（白居易《钱塘湖春行》）
   浮岛 = 霓为衣兮风为马，云之君兮纷纷而来下（李白《梦游天姥吟留别》）

   ---- 房名不是用户填的东西 ----
   一段存档的标题：起名了用名字（2026-09-18 新建时会问一句，可不填），
   没起名就由**房里的人**推出来（见 roomTitle）。
   配置台里也没有「改名」。

   ---- 术语 ----
     大号 = Char 侧（main）；皮套 = Char 的小号（sub）；马甲 = User 侧小号。
     别把「大号」用在 User 身上。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var button = ui.button;

  var SVG = 'viewBox="0 0 24 24" width="20" height="20" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  function ic(body, size) {
    var s = size
      ? 'viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true"'
      : SVG;
    return '<svg ' + s + '>' + body + '</svg>';
  }

  /* 名字是用户输入，拼进 innerHTML 之前必须转义 */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clip(s, n) {
    var t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* 每座岛的性情。poem 是这一层的灵魂 ——
     不要再写「1v1 纯净沙盒 · 两个人，绝对封闭」那种说明书。 */
  var KIND_META = {
    isle: {
      title: '孤岛',
      badge: '1v1',
      poem: '一生一代一双人',
      from: '纳兰性德《画堂春》',
      seed: '在孤岛上写一段',
      empty: '这座岛还空着',
      hint: '一段只属于你们两个人的故事，别人进不来'
    },
    archipelago: {
      title: '群岛',
      badge: '1vN',
      poem: '乱花渐欲迷人眼',
      from: '白居易《钱塘湖春行》',
      seed: '在群岛上写一段',
      empty: '这片群岛还空着',
      hint: '可以拉群、可以查手机，谁也不是谁的唯一'
    }
  };

  /* 云海本身**没有主题句**。曾经在这里挂过一句「霓为衣兮风为马」，
     用户看到就问了「为啥上面是霓为衣兮风为马这个诗句呀」——
     因为它在说别人的事。每座岛各配一句就够了（见 KIND_META 的 poem）。 */

  /* 两座岛之间**不画任何连线**。
     曾经在这里画过一条跨屏的飘带（想把孤岛和群岛串起来），是理解错了：
     需要被连起来的是「我」和角色，不是这两座岛 —— 它们只是两种**可供选择的
     房型**，像货架上并排的两样东西，没有关系可言。
     红线现在只画在配置台的关系树上（我 ↔ 角色）。 */

  function metaOf(kind) { return KIND_META[kind] || KIND_META.isle; }

  /* 这间房还放得进人吗。
     孤岛 = 1 User × 1 Char、绝对封闭（《聊天 App·核心架构》），所以住满一个
     就不能再加 —— 加人的入口和保存那一步都用它把门。
     做成独立纯函数是为了能被冒烟直接断言（UI 里那两处不好测）。 */
  function canAddChar(sb) {
    if (!sb) return true;
    if (sb.kind !== core.KIND_ISLE) return true;
    return core.charsOfSandbox(sb.id).length < 1;
  }

  function relative(at) {
    if (!at) return '还没进去过';
    var d = Date.now() - at;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  /* 一段存档的标题：**手动起的名字优先**（2026-09-18 起新建时会问一句），
     没起名就回落到老规矩 —— 房里的人。
     孤岛就一个名字；群岛两三个并列；再多就「A、B 等 N 人」。
     空房给一句中性的话。 */
  function roomTitle(sb) {
    /* sb 可以是 null：页面实例是缓存复用的（app.js 的 build 只跑一次），
       所以「看过 A 岛的角色档案 → A 岛被删掉 → 再回这一页」时
       findSandbox() 会回 null。原写法第一行 guard 了 sb、第二行就直接读
       sb.kind —— 属于「以为自己防住了但没防完」，会整页崩成「这一页出错了」。
       （2026-09-21 全页渲染冒烟抓的，见 scripts/smoke.js 末尾那一段） */
    if (!sb) return '空着的一座岛';
    if (sb.name) return sb.name;
    var chars = core.charsOfSandbox(sb);
    if (!chars.length) return sb.kind === core.KIND_ISLE ? '空着的一座岛' : '空着的一片群岛';
    if (chars.length === 1) return chars[0].name || '未命名';
    if (chars.length <= 3) {
      return chars.map(function (c) { return c.name || '未命名'; }).join('、');
    }
    return (chars[0].name || '未命名') + '、' + (chars[1].name || '未命名') +
      ' 等 ' + chars.length + ' 人';
  }

  /* 这间房里某个人名下的成员。
     parentType：'char' = 挂在角色名下（皮套）/ 'sandbox' = 属于整座岛（NPC）。
     NPC 的查询**唯一口径在 core.npcsOfRoom**（2026-09-21 收敛，这里不再另查）。
     没打标签的（迁移前的老数据）也带上，免得老存档里的皮套凭空消失。 */
  function childrenOf(roomId, parentId, kind, parentType) {
    var pt = parentType || 'char';
    return core.allChars().filter(function (c) {
      if (c.kind !== kind) return false;
      if (c.parentId !== parentId) return false;
      if ((c.parentType || 'char') !== pt) return false;
      return !c.sandboxId || c.sandboxId === roomId;
    });
  }

  function sky() {
    var box = h('div', 'isl-sky');
    box.appendChild(h('i', 'isl-glow isl-glow-a'));
    box.appendChild(h('i', 'isl-glow isl-glow-b'));
    box.appendChild(h('i', 'isl-glow isl-glow-c'));
    return box;
  }

  /* ==================== 第一层：浮岛（左右滑动的两座岛） ==================== */

  Sleepy.register('island', {
    title: '浮岛',
    render: function (ctx) {
      var body = ctx.body;
      body.appendChild(sky());

      var track = h('div', 'isl-track');
      var dots = h('div', 'isl-dots');

      /* 这里**不放任何标题和诗句**。
         曾经在云海上方挂过一句「霓为衣兮风为马」—— 用户看到的第一反应是
         「为啥上面是霓为衣兮风为马这个诗句呀」。理由很简单：**它在说别人的事**。
         这座云海本身没有主题句，每座岛才有（岛下面各配一句，见 KIND_META）。
         云海就该是空的 —— 留白才是这一层给人的第一印象。 */

      body.appendChild(track);
      body.appendChild(dots);

      var pages = [];

      [core.KIND_ISLE, core.KIND_ARCHI].forEach(function (kind, pi) {
        var page = h('section', 'isl-page');

        var stage = h('div', 'isl-stage isl-stage-' + kind);
        var ground = h('div', 'isl-ground');
        if (kind === core.KIND_ISLE) {
          ground.appendChild(h('i', 'isl-tree isl-tree-a'));
          ground.appendChild(h('i', 'isl-tree isl-tree-b'));
        } else {
          ground.appendChild(h('i', 'isl-shard isl-shard-a'));
          ground.appendChild(h('i', 'isl-shard isl-shard-b'));
          ground.appendChild(h('i', 'isl-shard isl-shard-c'));
          ground.appendChild(h('i', 'isl-shard isl-shard-d'));
        }
        stage.appendChild(ground);
        page.appendChild(stage);

        var meta = metaOf(kind);
        var head = h('div', 'isl-isle-head');
        head.appendChild(h('span', 'isl-isle-name', meta.title));
        head.appendChild(h('span', 'isl-isle-badge', meta.badge));
        page.appendChild(head);
        page.appendChild(h('p', 'isl-poem', meta.poem));
        page.appendChild(h('p', 'isl-poem-from', meta.from));
        page.appendChild(h('p', 'isl-isle-count', ''));

        page.addEventListener('click', function () {
          ctx.open('island-saves', { kind: kind });
        });

        track.appendChild(page);
        pages.push(page);

        var dot = h('span', 'isl-dot' + (pi === 0 ? ' is-on' : ''));
        dot.setAttribute('data-i', String(pi));
        dots.appendChild(dot);
      });

      function rebuild() {
        var all = core.listSandboxes();
        var active = store.get('activeSandboxId');
        pages.forEach(function (page, pi) {
          var kind = pi === 0 ? core.KIND_ISLE : core.KIND_ARCHI;
          var list = all.filter(function (s) { return s.kind === kind; });
          var here = list.some(function (s) { return s.id === active; });
          page.querySelector('.isl-isle-count').textContent = list.length
            ? (list.length + ' 段存档' + (here ? ' · 人在其中一段里' : ''))
            : '还没有存档 · 点进来写第一段';
        });
      }

      function syncDots() {
        var w = track.clientWidth || 1;
        var i = Math.round(track.scrollLeft / w);
        var all = dots.querySelectorAll('.isl-dot');
        for (var k = 0; k < all.length; k++) {
          all[k].classList.toggle('is-on', k === i);
        }
        if (prevBtn) prevBtn.disabled = i <= 0;
        if (nextBtn) nextBtn.disabled = i >= all.length - 1;
      }

      /* ---- 在岛之间切换 ----

         桌面浏览器里 `overflow-x:auto` 的容器**没有「滑动」这回事**：
         鼠标拖不动它，滚轮也只滚纵向。所以两座岛在电脑上根本切不过去 ——
         用户反馈「也没能右滑」。这不是 bug 而是浏览器行为，得自己补通道。
         （手机上触摸是原生支持的，所以只在鼠标路径上插手，别抢触摸。）

         四条通道：鼠标拖拽、两侧箭头、底部页码点、触摸滑动。 */
      var dragging = false, startX = 0, startScroll = 0, moved = 0;

      function goTo(i, instant) {
        var n = pages.length;
        i = Math.max(0, Math.min(n - 1, i));
        var left = i * (track.clientWidth || 1);
        if (instant) track.scrollLeft = left;
        else track.scrollTo({ left: left, behavior: 'smooth' });
      }
      function current() {
        return Math.round(track.scrollLeft / (track.clientWidth || 1));
      }

      track.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch') return;      /* 触摸交给原生滚动 */
        dragging = true; moved = 0;
        startX = e.clientX; startScroll = track.scrollLeft;
        track.classList.add('is-dragging');
      });
      track.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        moved = Math.max(moved, Math.abs(e.clientX - startX));
        track.scrollLeft = startScroll - (e.clientX - startX);
      });
      function endDrag() {
        if (!dragging) return;
        dragging = false;
        track.classList.remove('is-dragging');
        goTo(Math.round(track.scrollLeft / (track.clientWidth || 1)));
      }
      track.addEventListener('pointerup', endDrag);
      track.addEventListener('pointercancel', endDrag);
      track.addEventListener('pointerleave', endDrag);

      /* 拖完紧跟的那次 click 不是「点进这座岛」，丢掉。
         挂在捕获阶段：页面自己的 click 处理器在冒泡阶段，拦得住。 */
      track.addEventListener('click', function (e) {
        if (moved > 8) { e.stopPropagation(); e.preventDefault(); moved = 0; }
      }, true);

      var nav = h('div', 'isl-nav');
      var prevBtn = null, nextBtn = null;
      [['prev', '\u2039', -1], ['next', '\u203a', 1]].forEach(function (a) {
        var b = h('button', 'isl-arrow isl-arrow-' + a[0], a[1]);
        b.type = 'button';
        b.setAttribute('aria-label', a[2] < 0 ? '上一座岛' : '下一座岛');
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          goTo(current() + a[2]);
        });
        nav.appendChild(b);
        if (a[2] < 0) prevBtn = b; else nextBtn = b;
      });
      body.appendChild(nav);

      var raf = null;
      track.addEventListener('scroll', function () {
        if (raf) return;
        raf = global.requestAnimationFrame(function () { raf = null; syncDots(); });
      });
      dots.addEventListener('click', function (e) {
        var t = e.target;
        if (!t.classList || !t.classList.contains('isl-dot')) return;
        goTo(parseInt(t.getAttribute('data-i'), 10) || 0);
      });

      ctx.rebuild = rebuild;
      rebuild();
      syncDots();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 第二层：某座岛的存档列表 ==================== */

  Sleepy.register('island-saves', {
    title: '存档',
    render: function (ctx) {
      var body = ctx.body;
      var kind = ctx.params.kind === core.KIND_ARCHI ? core.KIND_ARCHI : core.KIND_ISLE;
      var meta = metaOf(kind);
      ctx.setTitle(meta.title);

      var head = h('div', 'sav-head');
      head.appendChild(h('p', 'sav-poem', meta.poem));
      head.appendChild(h('p', 'sav-poem-from', meta.from));
      head.appendChild(h('p', 'sav-hint', meta.hint));
      body.appendChild(head);

      var list = h('div', 'sav-list');
      body.appendChild(list);

      var add = h('button', 'sav-new');
      add.type = 'button';
      add.innerHTML = ic('<path d="M12 6.5v11M6.5 12h11"/>', 18);
      add.appendChild(h('span', '', meta.seed));
      add.addEventListener('click', function () { createRoom(ctx, kind); });
      body.appendChild(add);

      function rebuild() {
        list.innerHTML = '';
        var rooms = core.listSandboxes().filter(function (s) { return s.kind === kind; });
        var active = store.get('activeSandboxId');
        if (!rooms.length) {
          list.appendChild(h('p', 'sav-empty', meta.empty + ' · 点下面的按钮写第一段'));
          return;
        }
        rooms.forEach(function (sb) { list.appendChild(saveCard(ctx, sb, sb.id === active)); });
      }

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  function saveCard(ctx, sb, isActive) {
    var wrap = h('div', 'sav-card' + (isActive ? ' is-active' : ''));

    var card = h('button', 'sav-open');
    card.type = 'button';
    var head = h('div', 'sav-open-head');
    head.appendChild(h('span', 'sav-name', roomTitle(sb)));
    if (isActive) head.appendChild(h('span', 'sav-cur', '人在里面'));
    card.appendChild(head);

    var chars = core.charsOfSandbox(sb);
    card.appendChild(h('p', 'sav-line', chars.length
      ? chars.map(function (c) { return core.summaryOf(c); }).join(' ／ ')
      : '还没放角色 · 进去捏一个'));
    card.appendChild(h('p', 'sav-meta',
      core.masksOfSandbox(sb).length + ' 件马甲 · ' + relative(sb.updatedAt)));
    card.addEventListener('click', function () { ctx.open('island-overview', { id: sb.id }); });
    wrap.appendChild(card);

    var tools = h('div', 'sav-tools');
    var del = h('button', 'sav-tool is-danger', '拆掉');
    del.type = 'button';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      removeRoom(ctx, sb);
    });
    tools.appendChild(del);
    wrap.appendChild(tools);
    return wrap;
  }

  /* ---------------------------- 建 / 拆 ---------------------------- */

  /* 2026-09-18：新建时先让用户给岛起名（用户：「加一个新的岛的时候
     加一个给岛屿命名」）。2026-09-19（第三梯队 6）：prompt 换成 v2 抽屉。
     2026-09-21（用户）：从孤岛/群岛列表进来时房型**已经定了**，不再多问一遍；
     也不主动 focus 输入框（以前一进抽屉就弹键盘）。 */
  function createRoom(ctx, kind) {
    var host = ctx.el;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var sel = kind === core.KIND_ARCHI ? core.KIND_ARCHI : core.KIND_ISLE;
    var isArchi = sel === core.KIND_ARCHI;
    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', isArchi ? '新建一片群岛' : '新建一座孤岛'));
    panel.appendChild(h('p', 'iol-drawer-desc', isArchi
      ? '多位彼此未必相识的角色，共用一个我。'
      : '一段核心关系的绝对封闭时空。'));

    var fName = h('div', 'iol-field');
    fName.appendChild(h('label', '', '名字（可选）'));
    var nameInput = h('input');
    nameInput.placeholder = '不起也行，以后用岛上的人叫它';
    fName.appendChild(nameInput);
    panel.appendChild(fName);

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不建');
    var save = h('button', 'iol-drawer-save', '建好这段存档');
    actions.appendChild(cancel);
    actions.appendChild(save);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      var sb = core.createSandbox(sel, String(nameInput.value || '').trim());
      close();
      ctx.toast('建好了 · 先把人放进来', 'ok');
      if (ctx.rebuild) ctx.rebuild();
      ctx.open('island-config', { id: sb.id });
    });

    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
    /* 不主动 focus：用户点输入框再弹键盘（用户 2026-09-21） */
  }

  function removeRoom(ctx, sb) {
    var host = ctx.el;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    /* 列清楚这座岛里有什么 —— 弹窗里让用户看到「没掉的是什么」，
       比一句抽象的「所有数据都会删掉」更有分量。 */
    var counts = [];
    var nChars = core.charsOfSandbox(sb).length;
    if (nChars) counts.push('角色 ' + nChars + ' 位');
    ['chats', 'memories', 'photos', 'diaries', 'todos', 'favorites'].forEach(function (k) {
      var n = (store.get(k) || []).filter(function (r) { return r && r.sandboxId === sb.id; }).length;
      if (n) counts.push(storeLabel(k) + ' ' + n + ' 条');
    });

    /* v2 抽屉（跟「新建存档」同一套壳），不用系统 confirm。
       2026-09-21 拍板：确定 → 全删（岛 + 岛上的人 + 全部岛级数据）；
       取消 → 什么都不动。 */
    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '拆掉「' + roomTitle(sb) + '」？'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '拆掉后，这座岛的一切都会删掉：岛本身、住在岛上的人、所有设置和记录。找不回来。'));

    if (counts.length) {
      var delBox = h('div', 'iol-del-list');
      counts.forEach(function (c) { delBox.appendChild(h('span', 'iol-del-item', c)); });
      panel.appendChild(delBox);
    } else {
      panel.appendChild(h('p', 'iol-drawer-desc', '这座岛还是空的，拆掉不可撤销。'));
    }

    panel.appendChild(h('p', 'iol-drawer-hint',
      '只是想让某个人搬走的话，先别拆 —— 进岛在 TA 的档案页选「移出这座岛」，那个不删岛。'));

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不拆');
    var save = h('button', 'iol-drawer-save is-danger', '全部删掉');
    cancel.type = 'button';
    save.type = 'button';
    actions.appendChild(cancel);
    actions.appendChild(save);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      close();
      var r = core.removeSandbox(sb.id);
      if (!r.ok) { ctx.toast(r.message, 'err'); return; }
      ctx.toast('已拆掉', 'ok');

      if (ctx.id === 'island-config') {
        Sleepy.nav.closeAll();
        Sleepy.nav.open('island');
      } else if (ctx.rebuild) {
        ctx.rebuild();
      }
    });

    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

  function storeLabel(k) {
    return ({ chats: '对话', memories: '记忆', photos: '照片', diaries: '日记',
      todos: '待办', favorites: '收藏' })[k] || k;
  }

  /* ==================== 第三层：配置台（横向关系树） ==================== */

  var LOCKS = [
    { key: 'puzzle', label: '拼图局', cog: 'unaware', barrier: false,
      hint: '不知情。会有一点说不清的熟悉感，得靠自己拼出来' },
    { key: 'flirt', label: '调情局', cog: 'aware', barrier: false,
      hint: '明牌。双方都知道对方有别的身份，不用装' },
    { key: 'deny', label: '死装局', cog: 'unaware', barrier: true,
      hint: '记忆完全隔离。连既视感都没有，装到底' }
  ];

  function lockKeyOf(cog) {
    if (cog.barrier) return 'deny';
    return cog.cognition === 'aware' ? 'flirt' : 'puzzle';
  }

  Sleepy.register('island-config', {
    title: '配置台',
    render: function (ctx) {
      var body = ctx.body;
      var roomId = ctx.params.id || '';
      var sb = core.findSandbox(roomId);

      if (!sb) {
        ctx.toast('找不到这段存档', 'err');
        ctx.back();
        return;
      }

      var meta = metaOf(sb.kind);

      var head = h('div', 'cfg-head');
      head.appendChild(h('p', 'cfg-poem', meta.poem));
      head.appendChild(h('p', 'cfg-poem-from', meta.from));
      body.appendChild(head);

      /* ---- 关系树 ---- */
      var treeWrap = h('div', 'tree-wrap');
      var treeScroll = h('div', 'tree-scroll');
      treeScroll.appendChild(treeWrap);
      body.appendChild(treeScroll);

      var treeHint = h('p', 'tree-hint', '');
      body.appendChild(treeHint);

      /* ---- 岛内成员（NPC）----
         NPC 属于整座岛，不挂在树上的任何人名下（2026-09-21 用户拍板）。
         照群岛总览的样子给一条横排栏：点卡片进档案，＋ 进 island-npc 页。 */
      var npcSec = h('p', 'iol-drawer-sec', '');
      var npcStrip = h('div', 'iol-strip');
      body.appendChild(npcSec);
      body.appendChild(npcStrip);

      function paintNpcs() {
        sb = core.findSandbox(roomId) || sb;
        var npcs = core.npcsOfRoom(sb);
        npcSec.textContent = '岛内成员 · ' + npcs.length + ' 位 NPC（属于这座' +
          metaOf(sb.kind).title + '，不属于任何一方）';
        npcStrip.innerHTML = '';
        if (!npcs.length) {
          npcStrip.appendChild(h('p', 'iol-empty', '还没有 NPC · 点「＋」让第一位住进岛里'));
        }
        npcs.forEach(function (n) {
          var card = h('button', 'iol-member');
          card.type = 'button';
          card.appendChild(h('span', 'iol-member-ava', (n.name || '?').charAt(0)));
          card.appendChild(h('strong', '', n.name));
          card.appendChild(h('small', '', clip(n.content || 'NPC', 18)));
          card.addEventListener('click', function () {
            ctx.open('island-char', { sbId: sb.id, charId: n.id });
          });
          npcStrip.appendChild(card);
        });
        var addNpc = h('button', 'iol-member is-add');
        addNpc.type = 'button';
        addNpc.appendChild(h('span', 'iol-add-mark', '＋'));
        addNpc.appendChild(h('small', '', '添加 NPC'));
        addNpc.addEventListener('click', function () {
          ctx.open('island-npc', { id: sb.id });
        });
        npcStrip.appendChild(addNpc);
      }

      /* 「加人设」这一行随房型变。
         孤岛住满之后**整行换掉**：留着的话那就是个按不动的按钮
         （点了只弹「孤岛只住得下一个人」），用户看到会问「为啥右边还有加人设」
         （原话）。不如直接写清楚为什么加不了。 */
      var addRow = h('div', 'cfg-add-row');
      body.appendChild(addRow);

      function paintAddRow() {
        addRow.innerHTML = '';
        if (!canAddChar(sb)) {
          addRow.appendChild(h('p', 'cfg-empty',
            '孤岛只住得下一个人 · 想再放人，去开一片群岛'));
          return;
        }
        var addBtn = h('button', 'cfg-add-main');
        addBtn.type = 'button';
        addBtn.innerHTML = ic('<path d="M12 6.5v11M6.5 12h11"/>', 18);
        addBtn.appendChild(h('span', '', '加人设'));
        addBtn.addEventListener('click', function () { openChar(ctx, sb, ''); });
        addRow.appendChild(addBtn);
        if (Sleepy.charIO) {
          var impBtn = h('button', 'cfg-add-sub', '导入人设');
          impBtn.type = 'button';
          impBtn.addEventListener('click', function () { Sleepy.charIO.importInto(ctx, sb.id); });
          addRow.appendChild(impBtn);
        }
      }

      /* ---- 我的马甲 ---- */
      var gMask = group('我的马甲',
        '这座岛自己的马甲 —— 别岛的不带过来（岛与岛隔绝往来）。' +
        '想要同一个人设，点「从别的岛复制一件」。新的在「我 → 设置 → 小号」里建。');
      var maskBox = h('div', 'cfg-masks');
      gMask.card.appendChild(maskBox);

      var copyRow = h('button', 'cfg-mask cfg-mask-copy');
      copyRow.type = 'button';
      copyRow.appendChild(h('span', 'cfg-check', ''));
      copyRow.appendChild(h('span', 'cfg-char-body'));
      var copyOpen = false;
      var copyList = null;
      copyRow.addEventListener('click', function () {
        copyOpen = !copyOpen;
        paintCopyList();
      });

      function paintCopyList() {
        if (copyList && copyList.parentNode) copyList.parentNode.removeChild(copyList);
        copyList = null;
        copyRow.classList.toggle('is-on', copyOpen);
        copyRow.querySelector('.cfg-char-body').innerHTML = '';
        copyRow.querySelector('.cfg-char-body').appendChild(
          h('span', 'cfg-char-name', copyOpen ? '收起' : '从别的岛复制一件马甲'));
        if (!copyOpen) return;
        copyList = h('div', 'cfg-masks');
        var found = 0;
        (core.listSandboxes() || []).forEach(function (other) {
          if (other.id === sb.id) return;
          var otherName = other.name || other.title || '未命名岛';
          /* 按**岛章**列，不按名册 —— 新建的马甲打了章还没勾进名册，
             也应该能被复制；反过来名册里挂着但章是别岛的记录不该出现 */
          core.userMasks().forEach(function (u) {
            if (!u || u.sandboxId !== other.id) return;
            found++;
            var line = h('button', 'cfg-mask');
            line.type = 'button';
            line.appendChild(h('span', 'cfg-check', ''));
            var mb = h('div', 'cfg-char-body');
            mb.appendChild(h('span', 'cfg-char-name', u.name));
            mb.appendChild(h('span', 'cfg-char-line', '来自 ' + otherName));
            line.appendChild(mb);
            line.addEventListener('click', function () {
              /* 深拷贝成**本岛的新马甲**（新 id + 本岛章）——
                 不是把别岛那件拉进来，两件从此各长各的 */
              var nu = core.upsertUser({
                name: u.name,
                persona: u.persona || '',
                note: u.note || '',
                city: u.city || '',
                region: u.region || '',
                timezone: u.timezone || '',
                avatar: u.avatar || '',
                /* 头像若存的是图库（IndexedDB），复制时两件马甲共用同一张图 ——
                   mediaId 指向的是图，不是「哪件马甲的专属文件」 */
                avatarMedia: u.avatarMedia || ''
              });
              var next = (sb.maskIds || []).slice();
              if (next.indexOf(nu.id) < 0) next.push(nu.id);
              var r = core.setSandboxMasks(sb.id, next);
              if (!r.ok) { ctx.toast(r.message, 'err'); return; }
              sb = r.sandbox;
              copyOpen = false;
              ctx.toast('已复制「' + nu.name + '」到这座岛', 'ok');
              paintMasks(); paintCopyList(); paintLocks(); paintTree();
            });
            copyList.appendChild(line);
          });
        });
        if (!found) {
          copyList.appendChild(h('p', 'cfg-empty', '别的岛上还没有马甲'));
        }
        maskBox.parentNode.insertBefore(copyList, copyRow.nextSibling);
      }

      function paintMasks() {
        maskBox.innerHTML = '';
        /* 只列**本岛**的马甲（马甲按岛，2026-09-21 拍板）——
           别岛的那件对这座岛不存在，列出来就是诱导跨岛共用一个身份 */
        var sid = sb.id;
        var users = core.userMasks().filter(function (u) {
          return u && u.sandboxId === sid;
        });
        if (!users.length) {
          maskBox.appendChild(h('p', 'cfg-empty',
            '这座岛还没有马甲 · 在「我 → 设置 → 小号」里建，或从别的岛复制一件'));
          paintCopyList();
          return;
        }
        var picked = sb.maskIds || [];
        users.forEach(function (u) {
          var on = picked.indexOf(u.id) >= 0;
          var item = h('button', 'cfg-mask' + (on ? ' is-on' : ''));
          item.type = 'button';
          item.appendChild(h('span', 'cfg-check', on ? '\u2713' : ''));
          var mb = h('div', 'cfg-char-body');
          mb.appendChild(h('span', 'cfg-char-name', u.name));
          mb.appendChild(h('span', 'cfg-char-line', u.persona || '还没写一句话人设'));
          item.appendChild(mb);
          item.addEventListener('click', function () {
            var next = (sb.maskIds || []).slice();
            var i = next.indexOf(u.id);
            if (i >= 0) next.splice(i, 1); else next.push(u.id);
            var r = core.setSandboxMasks(sb.id, next);
            if (!r.ok) { ctx.toast(r.message, 'err'); return; }
            sb = r.sandbox;
            paintMasks(); paintLocks(); paintTree();
          });
          maskBox.appendChild(item);
        });
      }

      /* ---- 初始认知锁 ---- */
      var gLock = group('初始认知锁',
        '定这一段关系的基调。之后在聊天里长按头像还能随时掉马。');
      var lockBox = h('div', 'cfg-locks');
      gLock.card.appendChild(lockBox);

      function paintLocks() {
        lockBox.innerHTML = '';
        var mains = core.charsOfSandbox(sb.id);
        var masks = core.masksOfSandbox(sb);
        if (!mains.length || !masks.length) {
          lockBox.appendChild(h('p', 'cfg-empty', '先把人设和马甲都放进来，这里才有可定的组合'));
          return;
        }
        mains.forEach(function (main) {
          masks.forEach(function (u) {
            var cur = lockKeyOf(core.cognitionOf(main.id, u.id, sb.id));
            var line = h('div', 'cfg-lock');
            line.appendChild(h('span', 'cfg-lock-who', main.name + ' × ' + u.name));
            var seg = h('div', 'seg');
            LOCKS.forEach(function (lk) {
              var b = h('button', 'seg-btn' + (cur === lk.key ? ' is-on' : ''), lk.label);
              b.type = 'button';
              b.title = lk.hint;
              b.addEventListener('click', function () {
                core.setCognition(main.id, u.id, lk.cog, sb.id);
                core.setBarrier(main.id, u.id, lk.barrier, sb.id);
                paintLocks();
                ctx.toast(lk.label + '：' + lk.hint, 'ok');
              });
              seg.appendChild(b);
            });
            line.appendChild(seg);
            lockBox.appendChild(line);
          });
        });
      }

      gMask.card.appendChild(copyRow);
      body.appendChild(gMask.wrap);
      body.appendChild(gLock.wrap);

      paintMasks(); paintCopyList();

      /* ---- 降落 ---- */
      var footer = h('div', 'cfg-footer');
      var land = h('button', 'cfg-land');
      land.type = 'button';
      land.appendChild(h('span', 'cfg-land-title', '降落'));
      land.appendChild(h('span', 'cfg-land-sub', '落到这一段关系的桌面'));
      land.addEventListener('click', function () { landInto(ctx, sb); });
      footer.appendChild(land);
      var danger = h('div', 'btn-row');
      danger.appendChild(button('拆掉这一段', 'danger', function () { removeRoom(ctx, sb); }));
      footer.appendChild(danger);
      body.appendChild(footer);

      /* ==================== 关系树绘制 ====================

         **「我」永远在页面正中**，角色往左右两侧长（右 1、左 1、右 2、左 2…）：
           我 → 角色 的红线，和「皮套挂在角色下面」的绿细线，画法见下面各自的注释。
           NPC **不上树**（属于整座岛）—— 在树下面的「岛内成员」栏里横排。

         为什么是「我」居中而不是像树干一样排在最左：
            用户原话「我需要 user 和 char 的这个在页面中间呀」
            「就算是有多个 char，也应该是 user 在页面中间，可以往左右加 char」。
            这个人看到的第一眼应该是「我」，不是一条从左往右的清单。

         节点点击：
           我        → 管马甲
           角色      → 加人设那一页（改人设）
           皮套      → 同上的简化样式（名字 + 人设，没有身份/城市/状态那些）
           虚线位    → 角色下面加皮套
         红线点击 → 写关系 */

      var R_ME = 30, R_CHAR = 24, R_KID = 17, R_ADD = 15;
      /* STEP_X 是相邻两列的距离。它同时决定了两件事：
         「我」两侧各站得下几列才不用滚动，以及**两边圆之间留得下多长的
         关系文字**（6 个字 ≈ 76px，见下面 clip(rel, 6)）。
         130 是这样凑出来的：130 - R_ME(30) - R_CHAR(24) = 76，正好够 6 个字；
         而「我」两侧各一列时画布要 2×(130+24+24)=356，塞得进 414 宽的手机屏。 */
      var PAD = 24, STEP_X = 130, GAP_Y = 62, ROW_GAP = 80;

      /* 第 i 个角色排在哪一列、哪一侧：偶数往右、奇数往左，左右交替。
         这样两个角色时正好一左一右对称，一个角色时在右边（用户要的「右边是爱人」）。 */
      function sideOf(i) {
        return i % 2 === 0 ? 1 : -1;
      }
      function colOf(i) {
        return Math.floor(i / 2) + 1;
      }
      /* 第 i 个人（或第 i 个空位）相对「我」的横向偏移 */
      function slotOff(i) {
        return sideOf(i) * colOf(i) * STEP_X;
      }

      /* 红线要**向上拱**，不能向下弯：
         节点下方挂着自己的名字，向下弯的那条会正好从前面那个人的名字上
         压过去（第一版就是这样，「顾清和」被压在带子底下）。
         上方是空的，所以只有往上抬才躲得开。

         抬多高**不是写死的** —— 对前面每一个人算出「从 TA 头顶过去至少要多高」，
         取最大值。写死一个数字的话，人一多（弧线拉长、经过第三个人时抬得不够）
         就会撞上，而且换个人名字长短又会变。 */
      function bowFor(x1, x2, targets) {
        var cx = (x1 + x2) / 2;
        var need = 26;                 /* 下限：总得有点弧，不然是根直棍 */
        targets.forEach(function (tx) {
          /* 在这条二次贝塞尔上找 x == tx 的那点，取它的 2t(1-t) ——
             抬升量就是 bow × 2t(1-t)，所以 bow 至少要 (要躲的高度) / 这个系数。
             两侧都要能用，所以按「离起点的距离」扫，不假设 x 递增。 */
          for (var s = 1; s <= 250; s++) {
            var t = s / 500;          /* (0, 0.5] */
            var xt = (1 - t) * (1 - t) * x1 + 2 * t * (1 - t) * cx + t * t * x2;
            if (Math.abs(xt - tx) > 0.6) continue;
            var k = 2 * t * (1 - t);
            if (k > 0.02) need = Math.max(need, (R_CHAR + 6) / k);
            break;
          }
        });
        return need;
      }

      function paintTree() {
        var me = core.masksOfSandbox(sb)[0] || core.activeUser();
        var mains = core.charsOfSandbox(sb.id);
        var canAdd = canAddChar(sb);

        /* ---- 位置：让**整棵树的整体**落在页面正中 ----

           注意不是「我」居中。用户原话：
             「不是指 user 一定要在中间，是整体！不然你不觉得视觉偏了么」
           他说得对：只把「我」摆在正中、角色全在右边的话，重心是往右倒的
           （两个元素时，右边那个人会把视觉重量压到右半边）。

           做法是先算出相对于「我」的**包围盒**（把每个人的半径也算进去），
           再整体平移 (W/2 − 包围盒中点)。于是「我」会自己漂到该在的地方：
             空房 / 一个角色 → 空位在左、人在右，两边对称，「我」≈ 正中
             两个角色       → 一左一右，「我」正好在正中
             三个以上       → 「我」随包围盒偏，「整体」始终居中

           画布至少跟视口一样宽（不然没地方平移），人多了比视口宽就横向滚动，
           滚动位置每次摆正到中间（见 centerScroll）。 */
        var VIEW = (treeScroll.clientWidth ? treeScroll.clientWidth - 12 : 0) ||
          Math.max(300, (window.innerWidth || 375) - 48);

        var offs = [];        /* 每个人相对「我」的横向偏移 */
        var offR = [];        /* 对应的半径 */

        /* 「加人设」那个虚线位排在哪 —— 见下面它出现的地方的注释。
           要先定下来，因为它也算进包围盒（它是看得见的东西，
           不算的话整体居中了它却被挤出屏幕）。两侧第一格都有人时不画。 */
        var slotAt = (canAdd && mains.length < 2) ? mains.length : -1;

        mains.forEach(function (m, i) {
          offs.push(slotOff(i));
          offR.push(R_CHAR);
        });
        if (slotAt >= 0) {
          offs.push(slotOff(slotAt));
          offR.push(R_ADD);
        }
        var lo = -R_ME, hi = R_ME;
        offs.forEach(function (d, k) {
          lo = Math.min(lo, d - offR[k]);
          hi = Math.max(hi, d + offR[k]);
        });

        var W = Math.max(VIEW, (hi - lo) + 2 * PAD);
        var xMe = W / 2 - (lo + hi) / 2;               /* ★ 整体居中，不是「我」居中 */
        var charX = function (i) { return xMe + slotOff(i); };

        /* 先把每条红线的弓高都算出来，才知道画布顶部要留多少 ——
           不然人一多，最长那条弧的顶会被 viewBox 切掉一截。 */
        var bows = [];
        var maxBow = 0;
        mains.forEach(function (m, i) {
          var prevs = [];
          for (var pi = 0; pi < i; pi++) prevs.push(charX(pi));
          var dir = sideOf(i);
          /* 半径要按**背离「我」的方向**取：左边的角色，圆心在「我」左边，
             两个端点也跟着镜像，不然红线会从左边的圆里穿出来。 */
          bows[i] = bowFor(xMe + dir * R_ME, charX(i) - dir * R_CHAR, prevs);
          maxBow = Math.max(maxBow, bows[i]);
        });

        var y0 = Math.max(PAD + R_ME, maxBow / 2 + 10);
        var maxY = y0 + ROW_GAP;

        var lines = '', nodes = '';
        var col = {};      /* 每一列的「下一个空位」y */

        function colNext(x, key) {
          if (col[key] === undefined) col[key] = y0 + ROW_GAP;
          var y = col[key];
          col[key] += GAP_Y;
          return y;
        }

        function line(x1, y1, x2, y2, cls) {
          return '<line class="' + (cls || 'tree-line') + '" x1="' + x1.toFixed(1) +
            '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
        }

        function person(x, y, r, cls, c, act, name) {
          var s = '<g class="tree-node' + (act ? ' tree-click' : '') + '"' +
            (act ? ' data-act="' + esc(act) + '"' : '') + '>';
          s += '<circle class="tree-disc ' + cls + '" cx="' + x.toFixed(1) +
            '" cy="' + y.toFixed(1) + '" r="' + r + '"/>';
          s += '<text class="tree-initial" x="' + x.toFixed(1) + '" y="' +
            (y + 1).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle">' +
            esc(core.initialOf(name)) + '</text>';
          s += '<text class="tree-name" x="' + x.toFixed(1) + '" y="' +
            (y + r + 14).toFixed(1) + '" text-anchor="middle">' + esc(clip(name, 7)) + '</text>';
          s += '</g>';
          return s;
        }

        function addSlot(x, y, label, act) {
          var s = '<g class="tree-node tree-click" data-act="' + esc(act) + '">';
          s += '<circle class="tree-disc tree-plus" cx="' + x.toFixed(1) + '" cy="' +
            y.toFixed(1) + '" r="' + R_ADD + '"/>';
          s += '<text class="tree-glyph" x="' + x.toFixed(1) + '" y="' +
            (y + 1).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle">+</text>';
          s += '<text class="tree-name" x="' + x.toFixed(1) + '" y="' +
            (y + R_ADD + 13).toFixed(1) + '" text-anchor="middle">' + esc(label) + '</text>';
          s += '</g>';
          return s;
        }

        /* 「我」 */
        nodes += person(xMe, y0, R_ME, 'tree-me', me, 'mask-list', '我');

        /* NPC 不再挂树上（2026-09-21 用户拍板）：NPC 属于整座岛，
           不属于 user 或 char 的任何一方 —— 在下面「岛内成员」那一栏里，
           照群岛总览的样子横排。树上的绿细线只表达「皮套属于谁」。 */

        /* 角色 + 关系连线 */
        mains.forEach(function (m, i) {
          var x = charX(i);
          var rel = core.relationOf(m.id, me.id, sb.id);

          /* 「我」和每个角色之间是**红线**（月老那种意象）。
             画法是两条平行的弧 —— 一条丝带的两边，中间留出位置写关系。
             注意这里是**红线**，不属于这个范畴的线不染红：
               我 → 角色        红线（这是「我和你」）
               我 → NPC         淡绿细线（这是「谁属于谁」）
               角色 → 皮套/NPC   淡绿细线
             两种线一眼分得开，才不会把「归属」看成「关系」。

             弧**向上拱**，理由和算法见上面 bowFor 的注释。
             关系文字放在弧的最高点（t=0.5）—— 两个圆之间的正中间。
             底下垫一块和页面同色的矩形把红线截断，省得给文字描边
             （.tree-rel-bg 的 fill 必须跟 .page 的底色一致，换主题时要一起改）。 */
          /* 左侧的角色要**镜像**：圆心在「我」左边，两个端点也跟着往左取，
             不然红线会从左边那个圆里穿出来（端点的内/外侧搞反了）。 */
          var dir = sideOf(i);
          var x1 = xMe + dir * R_ME, x2 = x - dir * R_CHAR;
          var bow = bows[i];
          var cx1 = (x1 + x2) / 2;
          var cy = y0 - bow;

          var tt = 0.5, t1 = 1 - tt;
          var midX = t1 * t1 * x1 + 2 * t1 * tt * cx1 + tt * tt * x2;
          var midY = (t1 * t1 + tt * tt) * y0 + 2 * t1 * tt * cy;

          lines += '<path class="tree-tie' + (rel ? '' : ' tree-tie-dash') +
            '" d="M' + x1.toFixed(1) + ' ' + y0 + ' Q ' + cx1.toFixed(1) + ' ' +
            cy.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y0 + '"/>';
          lines += '<path class="tree-tie tree-tie-b' + (rel ? '' : ' tree-tie-dash') +
            '" d="M' + x1.toFixed(1) + ' ' + (y0 - 3.2) + ' Q ' + cx1.toFixed(1) + ' ' +
            (cy - 3.2).toFixed(1) + ' ' + x2.toFixed(1) + ' ' + (y0 - 3.2) + '"/>';

          /* 关系文字最多显 6 个字：再长就会顶到两边的圆上
             （「我」到第一个角色之间就那么宽）。完整的写在 prompt 里能看。 */
          var label = rel ? clip(rel, 6) : '写关系';
          var lw = label.length * 11 + 10;
          nodes += '<g class="tree-node tree-click" data-act="rel:' + esc(m.id) + '">' +
            '<rect class="tree-rel-bg" x="' + (midX - lw / 2).toFixed(1) + '" y="' +
            (midY - 9).toFixed(1) + '" width="' + lw + '" height="18" rx="9"/>' +
            '<text class="tree-rel' + (rel ? '' : ' tree-rel-empty') +
            '" x="' + midX.toFixed(1) + '" y="' + (midY + 1).toFixed(1) +
            '" text-anchor="middle" dominant-baseline="middle">' + esc(label) + '</text></g>';

          nodes += person(x, y0, R_CHAR, 'tree-char', m, 'char:' + m.id, m.name);

          /* 这个角色名下的皮套。NPC 不在这里（属于整座岛，见「岛内成员」栏） */
          var kids = childrenOf(sb.id, m.id, 'sub', 'char');
          kids.forEach(function (k) {
            var y = colNext(x, m.id);
            lines += line(x, y - GAP_Y + R_KID + 6, x, y - R_KID - 3, 'tree-line tree-line-v');
            nodes += person(x, y, R_KID, 'tree-kid tree-sub', k, 'simple:' + k.id, k.name);
          });
          var ay = colNext(x, m.id);
          lines += line(x, ay - GAP_Y + R_KID + 6, x, ay - R_ADD - 3,
            'tree-line tree-line-v tree-dash');
          nodes += addSlot(x, ay, '加皮套', 'add-sub:' + m.id);
          maxY = Math.max(maxY, ay);
        });

        /* 「加人设」的虚线位 —— 排在**最近的那一格空位上**：
             还没人     → 右边第一格
             有一个了   → 左边第一格（这时两边正好对称）
             两侧第一格都有人 → **不画**（人多时本来就不该再往两边挤，
                                  加人走下面那个大按钮）
           为什么不让它一直往外排（右 2、左 2…）：树会越来越宽、要横向滚动，
           而且虚线位容易被挤出屏幕外 —— 那就又变成「点哪里加呢」。
           它是虚线圆圈 + 一行小字，**不连线**：人数一多，从「我」连过去的线
           必然从别人身上穿过去。空房例外 —— 那时它就在隔壁，一根短短的虚线
           正好把「我」和它连起来（用户认可的那张图的样子）。 */
        if (slotAt >= 0) {
          var ax = charX(slotAt);
          if (!mains.length) {
            lines += line(xMe + R_ME, y0, ax - R_ADD - 4, y0, 'tree-line tree-dash');
          }
          nodes += addSlot(ax, y0, '加人设', 'add-char');
        }

        var H = maxY + R_ADD + 30;
        treeWrap.innerHTML = '<svg class="tree-svg" viewBox="0 0 ' + W + ' ' + H + '" ' +
          'style="width:' + W + 'px;height:' + H + 'px" role="img" ' +
          'aria-label="这间房的关系树"><title>关系树</title>' +
          lines + nodes + '</svg>';

        wireTree();
        centerScroll();
        treeHint.textContent = mains.length
          ? '红线上的字就是你和他的关系 · 点人可以改'
          : '这一段还很空 · 点「加人设」开始捏第一个人';
      }

      /* 画布比视口宽时（人多），把滚动位置摆到正中间 ——
         「我」在画布正中，所以摆正之后它就在**屏幕**正中。
         不摆的话会从最左边开始看，一眼看到的是最边上的角色。 */
      function centerScroll() {
        var over = treeWrap.offsetWidth - treeScroll.clientWidth;
        if (over <= 1) { treeScroll.scrollLeft = 0; return; }
        treeScroll.scrollLeft = over / 2;
      }

      /* SVG 是字符串拼的，点击用一次事件委托接住（节点会整体重画） */
      function wireTree() {
        var svg = treeWrap.querySelector('.tree-svg');
        if (!svg) return;
        svg.addEventListener('click', function (e) {
          var g = e.target.closest ? e.target.closest('[data-act]') : null;
          if (!g) return;
          var act = g.getAttribute('data-act');

          if (act === 'mask-list') { ctx.open('mask-list'); return; }
          if (act === 'add-char') { openChar(ctx, sb, ''); return; }
          if (act.indexOf('char:') === 0) { openChar(ctx, sb, act.slice(5)); return; }
          if (act.indexOf('simple:') === 0) {
            ctx.open('contact-edit', { id: act.slice(7), sandboxId: sb.id, simple: true });
            return;
          }
          if (act.indexOf('add-sub:') === 0) {
            /* 树上角色名下的虚线位现在是「加皮套」—— 皮套才属于某个角色。
               NPC 走「岛内成员」栏的 ＋ 添加（island-npc 页，归岛）。 */
            ctx.open('contact-edit', {
              id: '', kind: 'sub', parentType: 'char', parentId: act.slice(8),
              sandboxId: sb.id, simple: true
            });
            return;
          }
          if (act.indexOf('rel:') === 0) { writeRelation(ctx, sb, act.slice(4)); return; }
        });
      }

      /* 写关系：点连线中间那一小段文字。
         存在 links 上，所以它天然是「我 × 这个角色」这一段关系的注解。 */
      async function writeRelation(ctx, sb, charId) {
        var me = core.masksOfSandbox(sb)[0] || core.activeUser();
        var ch = core.findChar(charId);
        var cur = core.relationOf(charId, me.id, sb.id);
        var next = await ui.prompt({
          title: '你和「' + (ch ? ch.name : '对方') + '」是什么关系？',
          note: '写在线上的那句话。留空就清掉。比如：青梅竹马、上下级、前男友',
          value: cur,
          ok: '写上'
        });
        if (next === null) return;
        var r = core.setRelation(charId, me.id, next, sb.id);
        if (!r.ok) { ctx.toast(r.message, 'err'); return; }
        paintTree();
        ctx.toast(r.relation ? ('写上了：' + r.relation) : '关系清掉了', 'ok');
      }

      /* 点「加人设」或者点某个角色 —— 都走**加人设那一页**（名字 / 头像 / 人设，
         外加一个「有小号吗」的开关），不走那个带三选一身份切换器的大表单。
         大表单是「角色骨架总面板」，从那一页底部的入口才进得去。

         新建时先拦一道：孤岛已满就别让人填完一整张表单才被拒。 */
      function openChar(ctx, sb, id) {
        if (!id && !canAddChar(sb)) {
          ctx.toast('孤岛只住得下一个人 · 想再放人请开一片群岛', 'warn');
          return;
        }
        ctx.open('contact-edit', {
          id: id || '', kind: 'main', sandboxId: sb.id, simple: true
        });
      }

      function redraw() {
        sb = core.findSandbox(roomId) || sb;
        paintTree();
        paintNpcs();
        paintAddRow();
        paintMasks();
        paintLocks();
      }

      redraw();
      ctx.redraw = redraw;
    },
    onShow: function (ctx) { if (ctx.redraw) ctx.redraw(); }
  });

  /* 「降落」：把「人在哪一段」落到这一段，然后清掉整叠页面回桌面。 */
  function landInto(ctx, sb) {
    var r = core.setActiveSandbox(sb.id);
    if (!r.ok) { ctx.toast(r.message, 'err'); return; }

    /* 身份跟着岛走（用户的设计，2026-09-18 补）：降进哪段，
       「对方 / 我」就是那段里的人 —— 孤岛直接是那 1v1；
       群岛多人要先选角（决策 4），这里的 降落 入口不替人选，
       身份留给切号器 / 桌面下拉。 */
    var chars = core.charsOfSandbox(sb);
    if (chars.length && !core.needsCharPick(sb)) {
      var masks = core.masksOfSandbox(sb);
      core.switchTo(chars[0].id, masks.length ? masks[0].id : undefined);
    }

    var list = core.listSandboxes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== sb.id) continue;
      list[i].usedAt = Date.now();
      list[i].updatedAt = Date.now();
    }
    core.saveSandboxes(list);

    Sleepy.nav.closeAll();

    /* 换岛 = 换数据也换视觉：岛的穿着/主题覆盖跟着活动岛重放
       （岛覆盖 > 全局）。不重放的话，新岛还穿着上一座岛的衣服。 */
    if (Sleepy.appearance && Sleepy.appearance.apply) Sleepy.appearance.apply();
    var home = document.querySelector('.page[data-page="home"]');
    if (home && Sleepy.__homeCtx && Sleepy.__homeCtx.repaint) Sleepy.__homeCtx.repaint();

    ctx.toast('降落了', 'ok');
  }

  /* ==================== 浮岛 v2：总览 / 关系认知 / 角色档案 ====================

     三份 Demo（孤岛总览 / 群岛关系与认知 / 角色档案与人设）往现有数据模型里
     落地，**不照搬页面**：孤岛总览接 island-saves → 总览 → 配置台的原链路；
     角色之间的「认识与否」是新数据（charRel:<sbId>），先存先编辑，
     注入接线留给总结引擎那一轮（见最后的「没做」清单）。 */

  /* 角色两两之间的关系：known=认识 / met=见过但不熟 / unknown=不认识 */
  function relKey(sbId) { return 'charRel:' + sbId; }
  function relMap(sbId) { return store.get(relKey(sbId)) || {}; }
  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function getPairRel(sbId, a, b) {
    var v = relMap(sbId)[pairKey(a, b)];
    return v || 'unknown';
  }
  var REL_LABELS = { known: '认识', met: '见过但不熟', unknown: '不认识' };
  function setPairRel(sbId, a, b, v) {
    var map = relMap(sbId);
    map[pairKey(a, b)] = v;
    store.set(relKey(sbId), map);
  }
  /* 认知地图的「身份归属判断」：observer 认为某张马甲是另一个人 / 就是本体 / 未判断 */
  function getJudge(sbId, observerId, maskId) {
    return relMap(sbId)['judge:' + observerId + ':' + maskId] || 'unset';
  }
  function setJudge(sbId, observerId, maskId, v) {
    var map = relMap(sbId);
    map['judge:' + observerId + ':' + maskId] = v;
    store.set(relKey(sbId), map);
  }

  function avatarLetter(c) {
    return (c && c.name ? c.name : '?').charAt(0);
  }
  /* 岛内全体 NPC —— 委托给 core 的唯一口径（本文件不再自己查） */
  function npcsOfRoom(sb) {
    return core.npcsOfRoom(sb);
  }
  /* 孤岛里「我」当前用的马甲名（没选就是「我」） */
  function currentMaskName(sb) {
    var masks = core.masksOfSandbox(sb);
    return masks.length ? masks[0].name : '我';
  }
  function cogLabel(cog) {
    if (cog.barrier) return '记忆壁垒';
    return cog.cognition === 'aware' ? '知道我是谁' : (cog.cognition === 'merged' ? '两套记忆都知道' : '不知道我的马甲');
  }

  /* ---- 总览（两种房型共用，按 sb.kind 分支） ---- */
  Sleepy.register('island-overview', {
    title: '岛屿总览',
    render: function (ctx) {
      var body = ctx.body;
      var sb = core.findSandbox(ctx.params.id || '');
      if (!sb) { ctx.toast('找不到这段存档', 'err'); ctx.back(); return; }
      var isArchi = sb.kind === core.KIND_ARCHI;
      var meta = metaOf(sb.kind);

      function build() {
        sb = core.findSandbox(sb.id) || sb;
        body.innerHTML = '';
        var isActive = store.get('activeSandboxId') === sb.id;

        /* ---- 头 ---- */
        var head = h('div', 'iol-head');
        var hTitle = h('h1', 'iol-title', roomTitle(sb));
        head.appendChild(hTitle);
        if (isActive) head.appendChild(h('span', 'iol-tag', '当前使用'));
        head.appendChild(h('p', 'iol-sub', isArchi
          ? '一个我，和' + core.charsOfSandbox(sb).length + '位彼此未必相识的主要角色'
          : '一座只容纳一段核心关系的孤岛'));
        body.appendChild(head);

        var mains = core.charsOfSandbox(sb);
        var masks = core.masksOfSandbox(sb);
        var npcs = npcsOfRoom(sb);

        /* ---- 核心成员 ---- */
        body.appendChild(secLabel('核心成员', masks.length + ' user · ' + mains.length + ' char'));
        var coreBox = h('div', 'iol-core' + (isArchi ? ' is-archi' : ''));
        if (!isArchi) {
          coreBox.appendChild(personNode({ name: '我', sub: '当前身份：' + currentMaskName(sb) }, 'me'));
          coreBox.appendChild(h('i', 'iol-line'));
          coreBox.appendChild(personNode(mains[0] || { name: '空' }, 'char'));
        } else {
          /* 群岛：我 + 全部主要角色，横排可滑。
             中间**不放连线**（用户 09-19 拍的）：群岛里「我↔char」不是一条
             一对一的关系，画了线反而会被读成「这条线代表某种关系」；
             谁跟谁什么关系，看下面「群岛关系」那一段。 */
          coreBox.appendChild(personNode({ name: '我', sub: masks.length ? masks.length + ' 件马甲' : '我' }, 'me'));
          mains.forEach(function (m) {
            coreBox.appendChild(personNode(m, 'char'));
          });
        }
        body.appendChild(coreBox);

        /* ---- 岛内成员（NPC） ----
           NPC 属于整座岛，不属于 user 或 char 的任何一方（demo 定稿文案）。 */
        body.appendChild(secLabel('岛内成员', 'NPC 属于这座' + meta.title + '，不属于任何一方'));
        var strip = h('div', 'iol-strip');
        if (!npcs.length) strip.appendChild(h('p', 'iol-empty', '还没有 NPC'));
        npcs.forEach(function (n) {
          var card = h('button', 'iol-member');
          card.type = 'button';
          card.appendChild(h('span', 'iol-member-ava', avatarLetter(n)));
          card.appendChild(h('strong', '', n.name));
          card.appendChild(h('small', '', clip(n.content || 'NPC', 18)));
          card.addEventListener('click', function () {
            ctx.open('island-char', { sbId: sb.id, charId: n.id });
          });
          strip.appendChild(card);
        });
        var addNpc = h('button', 'iol-member is-add');
        addNpc.type = 'button';
        addNpc.appendChild(h('span', 'iol-add-mark', '＋'));
        addNpc.appendChild(h('small', '', '添加 NPC'));
        addNpc.addEventListener('click', function () {
          ctx.open('island-npc', { id: sb.id });
        });
        strip.appendChild(addNpc);
        body.appendChild(strip);

        /* ---- 主要角色的档案入口（两张 demo 的「角色档案」挂这里） ---- */
        body.appendChild(secLabel('角色档案', '人设 · 身份 · 认知'));
        var profList = h('div', 'iol-prof-list');
        if (!mains.length) profList.appendChild(h('p', 'iol-empty', '还没有主要角色 · 去「岛屿设置」加一个'));
        mains.forEach(function (m) {
          var row = h('button', 'iol-prof-row');
          row.type = 'button';
          var left = h('span', 'iol-prof-left');
          left.appendChild(h('b', '', m.name));
          var subs = childrenOf(sb.id, m.id, 'sub', 'char');
          left.appendChild(h('small', '', clip((m.content || '').split('\n')[0], 24) ||
            (subs.length ? (subs.length + ' 个身份') : '还没写人设')));
          row.appendChild(left);
          row.appendChild(h('span', 'iol-prof-side', '档案 ›'));
          row.addEventListener('click', function () {
            ctx.open('island-char', { sbId: sb.id, charId: m.id });
          });
          profList.appendChild(row);
        });
        body.appendChild(profList);

        /* ---- 群岛关系（仅群岛）：char↔char 认识与否 ---- */
        if (isArchi && mains.length > 1) {
          body.appendChild(secLabel('群岛关系', '角色之间是否认识'));
          var relBox = h('div', 'iol-rel-box');
          for (var i = 0; i < mains.length; i++) {
            for (var j = i + 1; j < mains.length; j++) {
              relBox.appendChild(relSeg(sb, mains[i], mains[j]));
            }
          }
          body.appendChild(relBox);
          var mapBtn = h('button', 'iol-ghost', '查看认知地图 →');
          mapBtn.type = 'button';
          mapBtn.addEventListener('click', function () {
            ctx.open('island-cognition', { id: sb.id });
          });
          body.appendChild(mapBtn);
        }

        /* ---- 入口 / 底部动作（两种房型都有） ---- */
        body.appendChild(secLabel('这座岛的入口', ''));
        var info = h('div', 'iol-info');
        info.appendChild(infoRow('进入身份', currentMaskName(sb) + (masks.length > 1 ? ' 等 ' + masks.length + ' 件' : ''), function () {
          ctx.open('island-config', { id: sb.id });
        }));
        var cogBits = mains.map(function (m) {
          var mk = masks[0];
          return mk ? (m.name + '：' + cogLabel(core.cognitionOf(m.id, mk.id, sb.id))) : '';
        }).filter(Boolean);
        info.appendChild(infoRow('彼此认知', clip(cogBits.join('；') || '还没定', 20), function () {
          ctx.open('island-config', { id: sb.id });
        }));
        body.appendChild(info);

        var foot = h('div', 'iol-foot');
        var land = h('button', 'iol-primary', '进入这座' + meta.title);
        land.type = 'button';
        land.addEventListener('click', function () { landInto(ctx, sb); });
        foot.appendChild(land);
        var setBtn = h('button', 'iol-ghost', '岛屿设置（关系树 · 马甲 · 认知锁）');
        setBtn.type = 'button';
        setBtn.addEventListener('click', function () {
          ctx.open('island-config', { id: sb.id });
        });
        foot.appendChild(setBtn);
        body.appendChild(foot);
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      function secLabel(t, sub) {
        var s = h('div', 'iol-sec-label');
        s.appendChild(h('b', '', t));
        if (sub) s.appendChild(h('span', '', sub));
        return s;
      }
      function personNode(c, kind) {
        var p = h('div', 'iol-person is-' + kind);
        p.appendChild(h('span', 'iol-ava', avatarLetter(c)));
        p.appendChild(h('b', '', c.name || '未命名'));
        if (c.sub) p.appendChild(h('small', '', c.sub));
        return p;
      }
      function infoRow(label, value, onEdit) {
        var row = h('div', 'iol-info-row');
        row.appendChild(h('span', '', label));
        var right = h('small', '');
        right.appendChild(document.createTextNode(value + '　'));
        var btn = h('button', '', '更改');
        btn.type = 'button';
        btn.addEventListener('click', onEdit);
        right.appendChild(btn);
        row.appendChild(right);
        return row;
      }
      function relSeg(sb, a, b) {
        var row = h('div', 'iol-rel-row');
        row.appendChild(h('span', 'iol-rel-who', a.name + ' ↔ ' + b.name));
        var seg = h('div', 'iol-seg');
        var cur = getPairRel(sb.id, a.id, b.id);
        ['known', 'met', 'unknown'].forEach(function (v) {
          var btn = h('button', 'iol-seg-btn' + (cur === v ? ' is-on' : ''), REL_LABELS[v]);
          btn.type = 'button';
          btn.addEventListener('click', function () {
            setPairRel(sb.id, a.id, b.id, v);
            ctx.toast(a.name + ' ↔ ' + b.name + '：' + REL_LABELS[v], 'ok');
            build();
          });
          seg.appendChild(btn);
        });
        row.appendChild(seg);
        return row;
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---- 认知地图（群岛）：以某角色为观察者，看 TA 知道哪些身份 ---- */
  Sleepy.register('island-cognition', {
    title: '认知地图',
    render: function (ctx) {
      var body = ctx.body;
      var sb = core.findSandbox(ctx.params.id || '');
      if (!sb) { ctx.toast('找不到这段存档', 'err'); ctx.back(); return; }

      var observerIdx = 0;

      function build() {
        body.innerHTML = '';
        var mains = core.charsOfSandbox(sb);
        var masks = core.masksOfSandbox(sb);
        if (!mains.length) { body.appendChild(h('p', 'iol-empty', '先放主要角色')); return; }
        var observer = mains[Math.min(observerIdx, mains.length - 1)];

        /* 观察者切换 */
        var sw = h('div', 'iol-obs-sw');
        mains.forEach(function (m, i) {
          var b = h('button', 'iol-obs-btn' + (i === Math.min(observerIdx, mains.length - 1) ? ' is-on' : ''), m.name);
          b.type = 'button';
          b.addEventListener('click', function () { observerIdx = i; build(); });
          sw.appendChild(b);
        });
        body.appendChild(sw);

        body.appendChild(h('div', 'iol-cog-head', [
          h('p', 'iol-cog-title', observer.name + '眼中的人')
        ]));
        body.appendChild(h('p', 'iol-cog-sub',
          '认知属于观察者 —— 不是问「别人是谁」，而是问「' + observer.name + '知道别人是谁」。'));

        /* 身份矩阵：其他主要角色 + 我的马甲 */
        body.appendChild(secTitle('TA 知道的身份'));
        var matrix = h('div', 'iol-matrix');
        mains.forEach(function (m) {
          if (m.id === observer.id) return;
          matrix.appendChild(matrixRow(m.name, getPairRel(sb.id, observer.id, m.id) === 'known'
            ? '认识这个角色'
            : (getPairRel(sb.id, observer.id, m.id) === 'met' ? '见过，不熟' : '不认识')));
        });
        masks.forEach(function (u) {
          var cog = core.cognitionOf(observer.id, u.id, sb.id);
          matrix.appendChild(matrixRow(u.name, cogLabel(cog)));
        });
        body.appendChild(matrix);

        /* 身份归属判断（对每件马甲） */
        if (masks.length) {
          body.appendChild(secTitle('身份归属判断'));
          masks.forEach(function (u) {
            var cur = getJudge(sb.id, observer.id, u.id);
            var box = h('div', 'iol-judge');
            box.appendChild(h('p', 'iol-judge-q', observer.name + '眼中，「' + u.name + '」是谁？'));
            var seg = h('div', 'iol-seg is-col');
            [
              { v: 'other', label: '另一个人', hint: '可以认识这张脸，但不会和本体合并' },
              { v: 'same', label: '就是本体', hint: '知道马甲归属，可以选择装作不知道' },
              { v: 'unset', label: '尚未判断', hint: '只积累线索，后续可能逐渐察觉' }
            ].forEach(function (o) {
              var b = h('button', 'iol-choice' + (cur === o.v ? ' is-on' : ''));
              b.type = 'button';
              b.appendChild(h('b', '', o.label));
              b.appendChild(h('small', '', o.hint));
              b.addEventListener('click', function () {
                setJudge(sb.id, observer.id, u.id, o.v);
                ctx.toast(observer.name + '：' + o.label, 'ok');
                build();
              });
              seg.appendChild(b);
            });
            box.appendChild(seg);
            body.appendChild(box);
          });
        }

        body.appendChild(h('p', 'iol-note',
          '同一个群岛里，不同角色可以拥有不同版本的真相。归属判断先记录，注入接线在总结引擎那一步。'));
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      function secTitle(t) {
        var s = h('div', 'iol-sec-label');
        s.appendChild(h('b', '', t));
        return s;
      }
      function matrixRow(name, state) {
        var r = h('div', 'iol-matrix-row');
        r.appendChild(h('span', '', name));
        r.appendChild(h('small', '', state));
        return r;
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---- 角色档案（角色档案与人设 Demo，孤岛/群岛各按数据呈现） ---- */
  Sleepy.register('island-char', {
    title: '角色档案',
    render: function (ctx) {
      var body = ctx.body;
      var sbId = ctx.params.sbId || '';
      var charId = ctx.params.charId || '';
      var sb = core.findSandbox(sbId);
      function ch() { return core.findChar(charId); }

      function build() {
        body.innerHTML = '';
        var c = ch();
        if (!c) { ctx.toast('找不到这个角色', 'err'); ctx.back(); return; }
        var isArchi = sb && sb.kind === core.KIND_ARCHI;
        var isNpc = c.kind === 'npc';

        /* hero */
        var hero = h('div', 'ipro-hero');
        hero.appendChild(h('div', 'ipro-ava', avatarLetter(c)));
        var hName = h('h2', '', c.name || '未命名');
        hName.appendChild(h('span', 'ipro-pill', isNpc ? 'NPC' : (c.kind === 'sub' ? '身份' : '主要角色')));
        hero.appendChild(hName);
        hero.appendChild(h('p', '', '当前所在 · ' + roomTitle(sb)));

        /* 常驻地点：一个字段喂三个下游（日历法定地区 / 时区 / 以后的语言档），
           档案页上得看得见 —— 不然用户会以为日历里那个地区是日历自己的设置，
           改完这里发现日历没跟着动。 */
        if (Sleepy.calendar) {
          var cfgP = Sleepy.calendar.cfgOf(charId);
          var placeP = Sleepy.calendar.placeOf(charId);
          var regionP = Sleepy.calendar.regionMeta(cfgP.region);
          if (placeP.city || placeP.region || placeP.timezone) {
            hero.appendChild(h('p', 'ipro-place',
              '常驻 · ' + Sleepy.calendar.placeLabel(charId, cfgP) +
              (regionP ? ' · ' + regionP.label : '') +
              (cfgP.timezone ? ' · ' + cfgP.timezone : '')));
          }
        }
        body.appendChild(hero);

        /* 一句话 */
        var firstLine = clip((c.content || '').split('\n')[0], 40);
        if (firstLine) body.appendChild(h('div', 'ipro-quote', firstLine));

        /* 人设（NPC / 本体 / 身份都有 content） */
        body.appendChild(secHead('角色人设', '注入为完整自由文本'));
        var prev = h('div', 'ipro-preview');
        prev.appendChild(h('p', '', clip(c.content || '还没写人设 —— 点「编辑全文」写一段。', 120)));
        var pf = h('div', 'ipro-preview-foot');
        pf.appendChild(h('span', '', (c.content || '').replace(/\s/g, '').length + ' 字'));
        var editLink = h('button', 'ipro-link', '编辑全文');
        editLink.type = 'button';
        editLink.addEventListener('click', function () {
          ctx.open('island-persona', { sbId: sbId, charId: charId });
        });
        pf.appendChild(editLink);
        prev.appendChild(pf);
        body.appendChild(prev);

        /* 身份与马甲（只有主要角色有） */
        var subs = childrenOf(sbId, charId, 'sub', 'char');
        if (!isNpc) {
          body.appendChild(secHead('身份与马甲', '角色本体 · 对外身份'));
          var strip = h('div', 'ipro-identities');
          strip.appendChild(identityCard(c, '本体 · 当前使用'));
          subs.forEach(function (s) {
            strip.appendChild(identityCard(s, '身份 · 已建立'));
          });
          var add = h('button', 'ipro-identity is-add');
          add.type = 'button';
          add.appendChild(h('span', 'ipro-plus'));
          add.appendChild(h('small', '', '新建身份'));
          add.addEventListener('click', function () {
            /* 第三梯队 6：不再跳 contact-edit 旧表单，走 v2 抽屉 */
            openIdentityDrawer(ctx, sb, c, build);
          });
          strip.appendChild(add);
          body.appendChild(strip);
        }

        /* 在这座岛里 */
        body.appendChild(secHead(isArchi ? '在这座群岛里' : '在这座孤岛里', '只展示，不替关系页做决定'));
        var relWrap = h('div', 'ipro-rel');
        var me = core.activeUser ? core.activeUser() : null;
        var masks = sb ? core.masksOfSandbox(sb) : [];
        if (me && masks.length && !isNpc) {
          masks.forEach(function (u) {
            var cog = core.cognitionOf(charId, u.id, sbId);
            relWrap.appendChild(relRow('关系与认知',
              u.name + '：' + cogLabel(cog), function () {
                ctx.open('island-config', { id: sbId });
              }));
          });
        }
        var others = core.charsOfSandbox(sb).filter(function (x) { return x.id !== charId; });
        others.forEach(function (o) {
          relWrap.appendChild(relRow(o.name,
            REL_LABELS[getPairRel(sbId, charId, o.id)], function () {
              if (isArchi && o.kind === 'main') ctx.open('island-cognition', { id: sbId });
              else ctx.toast('关系详情在配置台的关系树里改', 'warn');
            }));
        });
        if (!relWrap.childNodes.length) relWrap.appendChild(h('p', 'ipro-note', '这座' + (isArchi ? '群岛' : '孤岛') + '里暂时只有 TA 自己。'));
        body.appendChild(relWrap);

        /* ---- 危险操作（第三梯队 6）：把主要角色移出这座岛 ----
           角色本体和留痕档案保留，只解除「在这座岛里」的关系；
           TA 在这座岛里的对话一起清掉，不然聊天列表会出现孤儿。
           2026-09-21 拍板：大号按岛打章 —— 移出时把 TA（连同皮套/NPC）
           的章摘掉，变成无主档案；不然之后拆这座岛会把已移出的 TA
           连带删掉。以后再加进别的岛时会打新章。 */
        if (c.kind === 'main') {
          var dz = h('div', 'ipro-danger-zone');
          var outBtn = h('button', 'ipro-danger-btn',
            '将「' + (c.name || 'TA') + '」移出这座岛');
          outBtn.type = 'button';
          outBtn.addEventListener('click', function () {
            ui.confirm({
              title: '把「' + (c.name || 'TA') + '」移出「' + roomTitle(sb) + '」？',
              note: 'TA 在这座岛里的对话会一起移除；角色本身、皮套和留痕档案都保留。不可撤销。',
              ok: '移出',
              danger: true
            }).then(function (yes) {
              if (!yes) return;
              var rest = core.charsOfSandbox(sb)
                .filter(function (x) { return x.id !== charId; })
                .map(function (x) { return x.id; });
              var r = core.setSandboxChars(sbId, rest);
              if (!r.ok) { ctx.toast(r.message, 'err'); return; }
              store.set('chats', (store.get('chats') || []).filter(function (ct) {
                return !(ct && ct.sandboxId === sbId && ct.characterId === charId);
              }));
              /* 摘章：本体 + 皮套/NPC（挂在 TA 名下的）都不再属于这座岛。
                 岛级 NPC（parentType='sandbox'）不算 TA 的人，留在岛上。 */
              core.universeOf(charId).forEach(function (x) {
                core.upsertChar({ id: x.id, sandboxId: null });
              });
              ctx.toast('已移出这座岛', 'ok');
              ctx.back();
            });
          });
          dz.appendChild(outBtn);
          body.appendChild(dz);
        }

        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      function secHead(t, sub) {
        var s = h('div', 'ipro-sec-head');
        s.appendChild(h('h3', '', t));
        if (sub) s.appendChild(h('small', '', sub));
        return s;
      }
      function identityCard(s, tag) {
        var card = h('button', 'ipro-identity');
        card.type = 'button';
        card.appendChild(h('span', 'ipro-mini', avatarLetter(s)));
        card.appendChild(h('b', '', s.name || '未命名'));
        card.appendChild(h('small', '', tag));
        card.addEventListener('click', function () {
          ctx.open('island-persona', { sbId: sbId, charId: s.id });
        });
        return card;
      }
      function relRow(label, sub, go) {
        var row = h('button', 'ipro-row');
        row.type = 'button';
        var left = h('span', '');
        left.appendChild(h('b', '', label));
        left.appendChild(h('small', '', sub));
        row.appendChild(left);
        row.appendChild(h('span', 'ipro-side', '查看 ›'));
        row.addEventListener('click', go);
        return row;
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---- 人设编辑（自由文本原样注入，字数统计 + 写法指引） ---- */
  Sleepy.register('island-persona', {
    title: '角色人设',
    render: function (ctx) {
      var body = ctx.body;
      var sbId = ctx.params.sbId || '';
      var charId = ctx.params.charId || '';
      var c = core.findChar(charId);
      if (!c) { ctx.toast('找不到这个角色', 'err'); ctx.back(); return; }
      ctx.setTitle((c.name || '角色') + ' 的人设');

      body.appendChild(h('p', 'ipro-lead-sub',
        '这一整段会作为角色底色注入。系统不会把它擅自拆成性格标签。'));

      var editor = h('div', 'ipro-editor');
      var ta = h('textarea');
      ta.value = c.content || '';
      var foot = h('div', 'ipro-editor-foot');
      var count = h('span', '', (c.content || '').replace(/\s/g, '').length + ' 字');
      foot.appendChild(h('span', '', '自由文本原文注入'));
      foot.appendChild(count);
      editor.appendChild(ta);
      editor.appendChild(foot);
      body.appendChild(editor);

      ta.addEventListener('input', function () {
        count.textContent = ta.value.replace(/\s/g, '').length + ' 字';
      });

      var guide = h('div', 'ipro-guide');
      guide.appendChild(h('b', '', '可以怎么写'));
      guide.appendChild(h('p', '',
        '写 TA 是谁、经历过什么、如何说话、怎样面对关系，以及你不希望 TA 变成什么样。不必拆成标签。'));
      body.appendChild(guide);

      var save = h('button', 'ipro-save', '保存人设');
      save.type = 'button';
      save.addEventListener('click', function () {
        var text = String(ta.value || '').trim();
        if (!text) { ctx.toast('人设不能为空', 'warn'); return; }
        core.upsertChar({ id: charId, content: text });
        ctx.toast('人设已保存', 'ok');
        ctx.back();
      });
      body.appendChild(save);
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---- 添加 NPC：全屏页面（09-19 用户定的：不走抽屉，要全屏 + 页面内滑动）。
     结构照「浮岛-v2-·-添加-NPC-Demo」：岛语境 → lead → 人物资料
     （名字/简介/说话与行为方式）→ 谁认识他（勾选，knownBy）→
     岛内可见性（npcVis 三开关）→ 加入这座岛。
     关键语义：NPC 归属**整座岛**（parentType='sandbox'，parentId=sb.id），
     不属于 user 或 char 任何一方。knownBy / npcVis 先记录，注入接线在 K03 二期。---- */
  Sleepy.register('island-npc', {
    title: '添加 NPC',
    render: function (ctx) {
      var body = ctx.body;
      var sb = core.findSandbox(ctx.params.id || '');
      if (!sb) { ctx.toast('找不到这段存档', 'err'); ctx.back(); return; }
      var meta = metaOf(sb.kind);

      function build() {
        sb = core.findSandbox(sb.id) || sb;
        body.innerHTML = '';

        var mains = core.charsOfSandbox(sb);
        var me = core.activeUser ? core.activeUser() : null;

        /* 「谁认识他」候选人：我 + 主要角色，默认全选（demo 初始态） */
        var known = [];
        if (me) known.push({ id: me.id, name: me.name || '我', sub: '当前 user', isMe: true });
        mains.forEach(function (m) {
          known.push({ id: m.id, name: m.name, sub: '主要角色', isMe: false });
        });
        var knownSel = {};
        known.forEach(function (p) { knownSel[p.id] = true; });

        /* 可见性：demo 默认态 —— 聊天联系人/公共场景开、朋友圈关 */
        var vis = { chat: true, group: true, moments: false };

        /* 顶部：这座岛的语境 */
        body.appendChild(h('div', 'iol-npc-context', [
          h('div', 'iol-npc-isle'),
          h('div', 'iol-npc-context-copy', [
            h('b', '', roomTitle(sb)),
            h('small', '', '当前' + meta.title + ' · 添加一位岛内成员')
          ])
        ]));

        body.appendChild(h('div', 'iol-npc-lead', [
          h('h2', '', '让这个人住进岛里'),
          h('p', '', 'NPC 属于整座岛，不属于 user 或 char 的任何一方。\n之后再由关系设置决定谁认识 TA。')
        ]));

        /* ---- 人物资料 ---- */
        body.appendChild(h('p', 'iol-drawer-sec', '人物资料'));
        var fName = h('div', 'iol-field');
        fName.appendChild(h('label', '', '名字'));
        var nameInput = h('input');
        nameInput.placeholder = '聊天记录里出现的名字';
        fName.appendChild(nameInput);
        body.appendChild(fName);

        /* 头像：跟大号/小号同一套入口（网址 + 本地图）——
           以前 NPC 编辑页没有头像位（用户 2026-09-21）。 */
        var fAvatar = Sleepy.avatarFieldLocal ? Sleepy.avatarFieldLocal(null, {
          toast: function (t, k) { ctx.toast(t, k); }
        }) : null;
        if (fAvatar) body.appendChild(fAvatar.el);

        /* 微信名：会话列表里显示的名字（用户 2026-09-21）。 */
        var fWx = h('div', 'iol-field');
        fWx.appendChild(h('label', '', '微信名'));
        var wxInput = h('input');
        wxInput.placeholder = '会话列表里显示的名字 · 留空就用「名字」';
        fWx.appendChild(wxInput);
        body.appendChild(fWx);

        var fBio = h('div', 'iol-field');
        fBio.appendChild(h('label', '', '人物简介'));
        var bio = h('textarea');
        bio.placeholder = 'TA 是谁，平时做什么……';
        fBio.appendChild(bio);
        body.appendChild(fBio);

        var fSay = h('div', 'iol-field');
        fSay.appendChild(h('label', '', '说话与行为方式'));
        var say = h('textarea');
        say.className = 'is-short';
        say.placeholder = 'TA 说话是什么感觉，会怎么做……';
        fSay.appendChild(say);
        body.appendChild(fSay);

        /* ---- 谁认识他 ---- */
        body.appendChild(h('p', 'iol-drawer-sec', '谁认识他'));
        body.appendChild(h('p', 'iol-npc-note',
          '选择已经认识这个 NPC 的人。没有选择的人，不会自动获得 TA 的资料。'));
        if (known.length) {
          var people = h('div', 'iol-people');
          known.forEach(function (p) {
            var row = h('button', 'iol-person-pick is-on');
            row.type = 'button';
            row.appendChild(h('span', 'iol-pick-ava', p.isMe ? '我' : avatarLetter(p)));
            var rowBody = h('span', 'iol-pick-body');
            rowBody.appendChild(h('b', '', p.name));
            rowBody.appendChild(h('small', '', p.sub + ' · 已认识'));
            row.appendChild(rowBody);
            row.appendChild(h('i', 'iol-check'));
            row.addEventListener('click', function () {
              knownSel[p.id] = !knownSel[p.id];
              row.classList.toggle('is-on', !!knownSel[p.id]);
            });
            people.appendChild(row);
          });
          body.appendChild(people);
        } else {
          body.appendChild(h('p', 'iol-npc-note', '这座岛里暂时没有可勾选的人 —— 先加一位主要角色。'));
        }

        /* ---- 岛内可见性 ---- */
        body.appendChild(h('p', 'iol-drawer-sec', '岛内可见性'));
        body.appendChild(h('p', 'iol-npc-note', '之后可以继续调整。'));
        var optBox = h('div', 'iol-opts');
        [
          { k: 'chat', t: '出现在聊天联系人', d: '允许 TA 成为可进入的聊天对象' },
          { k: 'group', t: '参与群聊与公共场景', d: '有相关动力时才会出现，不会强行发言' },
          { k: 'moments', t: '出现在朋友圈', d: '允许 TA 拥有自己的动态与互动' }
        ].forEach(function (o) {
          var row = h('div', 'iol-opt');
          var left = h('span', 'iol-opt-body');
          left.appendChild(h('b', '', o.t));
          left.appendChild(h('small', '', o.d));
          row.appendChild(left);
          var sw = h('button', 'iol-switch' + (vis[o.k] ? ' on' : ''));
          sw.type = 'button';
          sw.setAttribute('aria-label', o.t);
          sw.addEventListener('click', function () {
            vis[o.k] = !vis[o.k];
            sw.classList.toggle('on', vis[o.k]);
          });
          row.appendChild(sw);
          optBox.appendChild(row);
        });
        body.appendChild(optBox);

        /* ---- 底部动作 ---- */
        var foot = h('div', 'iol-foot');
        var save = h('button', 'iol-primary', '加入这座岛');
        save.type = 'button';
        save.addEventListener('click', function () {
          var name = String(nameInput.value || '').trim();
          if (!name) { ctx.toast('名字总得有一个', 'warn'); return; }
          core.upsertChar({
            name: name,
            wechatName: String(wxInput.value || '').trim(),
            avatar: fAvatar ? String(fAvatar.get() || '').trim() : '',
            avatarMedia: fAvatar ? fAvatar.getMedia() : '',
            kind: 'npc',
            parentId: sb.id,
            parentType: 'sandbox',
            sandboxId: sb.id,
            content: String(bio.value || '').trim(),
            speech: String(say.value || '').trim(),
            knownBy: known.filter(function (p) { return knownSel[p.id]; })
              .map(function (p) { return p.id; }),
            npcVis: vis
          });
          ctx.toast(name + ' 住进了这座' + meta.title, 'ok');
          ctx.back();   /* 总览的 onShow 会自己 rebuild，新 NPC 当场可见 */
        });
        foot.appendChild(save);
        foot.appendChild(h('p', 'iol-npc-hint',
          '加入后仍可以在岛屿总览里编辑资料、关系与可见范围。'));
        body.appendChild(foot);
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* 新建身份：v2 抽屉（第三梯队 6）—— 名字 + 一句话人设，
     建完原地刷新档案页。绑定马甲这类进阶配置仍归 contact-edit
     （点那张身份卡进去改）。 */
  function openIdentityDrawer(ctx, sb, mainChar, onDone) {
    var host = ctx.el;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '新建一张身份'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '挂在「' + (mainChar.name || 'TA') + '」名下的对外身份。建好之后点身份卡可以再绑定马甲。'));

    var fName = h('div', 'iol-field');
    fName.appendChild(h('label', '', '名字'));
    var nameInput = h('input');
    nameInput.placeholder = '这张脸被叫什么';
    fName.appendChild(nameInput);
    panel.appendChild(fName);

    var fBio = h('div', 'iol-field');
    fBio.appendChild(h('label', '', '一句话人设（可选）'));
    var bio = h('textarea');
    bio.className = 'is-short';
    bio.placeholder = '对外是什么样的人……';
    fBio.appendChild(bio);
    panel.appendChild(fBio);

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不建');
    var save = h('button', 'iol-drawer-save', '建这张身份');
    actions.appendChild(cancel);
    actions.appendChild(save);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      var name = String(nameInput.value || '').trim();
      if (!name) { ctx.toast('名字总得有一个', 'warn'); return; }
      core.upsertChar({
        name: name,
        kind: 'sub',
        parentId: mainChar.id,
        sandboxId: sb.id,
        content: String(bio.value || '').trim()
      });
      close();
      ctx.toast('「' + name + '」建好了', 'ok');
      if (onDone) onDone();
    });

    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
    /* 不主动 focus：用户点输入框再弹键盘（用户 2026-09-21） */
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.island = {
    KIND_META: KIND_META,
    metaOf: metaOf,
    roomTitle: roomTitle,
    canAddChar: canAddChar,
    childrenOf: childrenOf,
    /* NPC 查询唯一口径在 core.npcsOfRoom；这里保留同名出口给老调用方过渡 */
    /* K03 二期注入侧（page-switch 认知编译）要读的关系数据：
       群岛关系三态、身份归属判断、岛内 NPC（含 knownBy/npcVis）。 */
    REL_LABELS: REL_LABELS,
    getPairRel: getPairRel,
    getJudge: getJudge,
    npcsOfRoom: npcsOfRoom,
    /* 撤离：从任何地方回到云海（上帝视角）。
       P1b 会给它接上「捏合 / 下拉」的手势，现在先作为函数出口存在。 */
    exit: function () { Sleepy.nav.closeAll(); Sleepy.nav.open('island'); }
  };

})(window);
