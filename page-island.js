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
      poem: '一生一代一双人',
      from: '纳兰性德《画堂春》',
      seed: '在孤岛上写一段',
      empty: '这座岛还空着',
    },
    archipelago: {
      title: '群岛',
      poem: '乱花渐欲迷人眼',
      from: '白居易《钱塘湖春行》',
      seed: '在群岛上写一段',
      empty: '这片群岛还空着',
      /* 原文案是「可以拉群、可以查手机，谁也不是谁的唯一」——
         用户 2026-09-22 指出两句都站不住：「查手机/拉群到后面都会都能做」，
         而且「谁也不是谁的唯一」是在替 user 假设一段**非独占**的关系，
         玩群像（家人、朋友那种情感）的人看到会觉得被定义。
         群岛的特点其实只是**结构**：住得下不止一个人。就只说这个。 */
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

  /* 选岛页的底图。
     两张都是生成插画（1264x1856）：岛宽约 55%、云海一直铺到画面最底边。
     纵横比（0.68）比手机（≈0.46）宽，所以 cover 只会裁左右、不会裁上下 ——
     上方留给状态栏的那片天空和下方那片云海都完整保得住。
     构图铁律与生图提示词见 D:/tmp/isl-redesign/浮岛-生图提示词.txt。
     （图在 art/ 下，由 CSS 的 .isl-art[data-kind] 引用。） */

  /* ==================== 第一层：浮岛（左右滑动的两座岛） ==================== */

  Sleepy.register('island', {
    title: '浮岛',
    render: function (ctx) {
      var body = ctx.body;

      var track = h('div', 'isl-track');
      var dots = h('div', 'isl-dots');

      /* 云海上方**不放任何标题和诗句**。
         曾经挂过一句「霓为衣兮风为马」—— 用户看到的第一反应是
         「为啥上面是霓为衣兮风为马这个诗句呀」。理由很简单：**它在说别人的事**。
         每座岛各有自己的名字和诗（压在下方云雾带里，见下面的 .isl-word）。 */

      body.appendChild(track);
      body.appendChild(dots);

      var pages = [];

      [core.KIND_ISLE, core.KIND_ARCHI].forEach(function (kind, pi) {
        var page = h('section', 'isl-page');
        /* 页面也打上房型标识：两张底图的**岩尖不在同一高度**
           （实测屏幕 y：孤岛 505 / 群岛 483），一个固定的 top 必然有一个贴不住
           —— 用户就是说「群岛看会更明显」。文案块的 top 按房型各写一份
           （见 style.css 里的 .isl-word）。 */
        page.setAttribute('data-kind', kind);

        /* 底图：一整幅生成插画铺满，岛和云海都在图里 ——
           不再用 CSS 画岛（那版是扁平淡绿的椭圆 + 棒棒糖树，
           用户 09-21 反馈「配色不好看，那两个岛屿也不是很美观」）。 */
        var art = h('div', 'isl-art');
        art.setAttribute('data-kind', kind);
        page.appendChild(art);

        /* 文字压在下方云雾带里（用户 09-21：「文案整体可以靠近岛屿一点，
           就是可以在云雾那里」）。岛的名字**单独居中**，不再挂 1v1 小徽章
           （用户：「1v1 那个小框可以没有」）。 */
        var meta = metaOf(kind);
        var word = h('div', 'isl-word');
        word.appendChild(h('h1', 'isl-isle-name', meta.title));
        word.appendChild(h('p', 'isl-poem', meta.poem));
        word.appendChild(h('p', 'isl-poem-from', meta.from));
        word.appendChild(h('p', 'isl-isle-count', ''));
        page.appendChild(word);

        /* 「进岛」按钮。
           以前是**点整页**就进存档列表 —— 用户 09-21 拍板改成留一个明确的按钮，
           整页不再当点击区（左右滑动换岛照旧）。 */
        var foot = h('div', 'isl-foot');
        var enter = h('button', 'isl-enter', '进 ' + meta.title);
        enter.type = 'button';
        enter.addEventListener('click', function () {
          ctx.open('island-saves', { kind: kind });
        });
        foot.appendChild(enter);
        page.appendChild(foot);

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
      if (meta.hint) head.appendChild(h('p', 'sav-hint', meta.hint));
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
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
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
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
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

      /* ---- 人物（2026-09-21 重做，原来是「关系树」）----
         放射树结构上只装得下两个角色（左一右一），第三个没地方放 ——
         改成和下面「岛内成员」同款的横排条。见 paintPeople。 */
      var peopleSec = h('p', 'iol-drawer-sec', '');
      var peopleStrip = h('div', 'iol-strip cfg-people');
      body.appendChild(peopleSec);
      body.appendChild(peopleStrip);

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
        npcSec.textContent = '岛内成员 · ' + npcs.length + ' 位 NPC';
        npcStrip.innerHTML = '';
        if (!npcs.length) {
          npcStrip.appendChild(h('p', 'iol-empty', '还没有 NPC'));
        }
        npcs.forEach(function (n) {
          var card = h('button', 'iol-member');
          card.type = 'button';
          var nAva = h('span', 'iol-member-ava', (n.name || '?').charAt(0));
          card.appendChild(nAva);
          core.setAvatarBg(nAva, n);
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

      /* 「加人设 / 导入人设」原来在这里占一整行大按钮（孤岛住满时整行换成
         一句说明）—— 那两件事已经并进上面**人物条末尾**的 ＋ / ↓，
         不用占两处版面。 */

      /* ---- 我的马甲 ---- */
      var gMask = group('我的马甲',
        '这座岛自己的马甲 · 同一个人设可以从别的岛复制，或直接新建。');
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
                avatarMedia: u.avatarMedia || '',
                /* 显式盖本岛章：人在 A 岛配置台复制 B 岛的马甲时，
                   不能靠「当前房」兜底（那会盖成 A 以外的岛）。 */
                sandboxId: sb.id
              });
              var next = (sb.maskIds || []).slice();
              if (next.indexOf(nu.id) < 0) next.push(nu.id);
              var r = core.setSandboxMasks(sb.id, next);
              if (!r.ok) { ctx.toast(r.message, 'err'); return; }
              sb = r.sandbox;
              copyOpen = false;
              ctx.toast('已复制「' + nu.name + '」到这座岛', 'ok');
              paintMasks(); paintCopyList(); paintLocks(); paintPeople();
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
            '这座岛还没有马甲 · 下面可以新建一件，或从别的岛复制'));
        }
        var picked = sb.maskIds || [];
        users.forEach(function (u) {
          var on = picked.indexOf(u.id) >= 0;
          var item = h('button', 'cfg-mask' + (on ? ' is-on' : ''));
          item.type = 'button';
          var uAva = h('span', 'cfg-ava', core.initialOf(u.name));
          item.appendChild(uAva);
          core.setAvatarBg(uAva, u);
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
            paintMasks(); paintLocks(); paintPeople();
          });
          maskBox.appendChild(item);
        });

        /* 就在本岛建马甲（用户 2026-09-21：配置台那句「去『我 → 设置 → 小号』里建」
           不 ok —— 全局路径和按岛矛盾，而且得多跳一页）。
           显式带上 sandboxId，免得盖错章。 */
        var addMask = h('button', 'cfg-mask cfg-mask-add');
        addMask.type = 'button';
        addMask.appendChild(h('span', 'cfg-check', ''));
        addMask.appendChild(h('span', 'cfg-char-name', '＋ 新建一件马甲'));
        addMask.addEventListener('click', function () {
          ctx.open('mask-edit', { id: '', sandboxId: sb.id });
        });
        maskBox.appendChild(addMask);
      }

      /* ---- 初始认知锁 ---- */
      var gLock = group('初始认知锁',
        '定这一段关系的基调。');
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

      /* ==================== 人物（2026-09-21 重做）====================

         **原来是「我」居中、角色左右交替长出去的放射树** —— 结构上只装得下
         两个角色（左一右一），第三个就没地方了（用户原话：「user 但凡想要
         三个 char，都没地方放了」）。
         现在是和下面「岛内成员」同款的横排条：一件一张卡，横排、宽了就横滑，
         **想加几个加几个**。NPC 不进这条（属于整座岛，在下面那一栏）。

         卡上各处的点击：
           我        → 管马甲（mask-list）
           角色      → 档案（island-char）
           角色小字  → 写关系（link.relation，「青梅竹马」那句）
           皮套      → 档案，小字标它挂在谁名下
           末尾 ＋   → 加人设；末尾 ↓ 导入人设
         红线不再画：「谁认识谁」那套在总览的「群岛关系」里已经完整，
         这里只留「我 × 角色」那一句注解 —— 它原本只有树上那条红线能点，
         换条之后挪到卡上的小字，功能不丢。 */
      function paintPeople() {
        peopleStrip.innerHTML = '';
        var me = core.defaultUserOfSandbox(sb) || core.activeUser();
        var masks = core.masksOfSandbox(sb);
        var mains = core.charsOfSandbox(sb.id);
        var subs = [];
        mains.forEach(function (m) {
          core.subChars(m.id).forEach(function (s) {
            if (s.sandboxId && s.sandboxId !== sb.id) return;
            subs.push({ c: s, parent: m });
          });
        });

        /* 一张卡。o.sub 是小字那行；给了 onSub 就整行可点（用来写关系）。 */
        function cardFor(o) {
          var card = h('button', 'iol-member cfg-p' + (o.me ? ' is-me' : ''));
          card.type = 'button';
          var ava = h('span', 'iol-member-ava', (o.name || '?').charAt(0));
          card.appendChild(ava);
          if (o.avatarOf) core.setAvatarBg(ava, o.avatarOf);
          card.appendChild(h('strong', '', o.name || '未命名'));
          var sub = h('small', '', o.sub);
          if (o.subIsHint) sub.classList.add('is-hint');
          if (o.onSub) {
            sub.classList.add('cfg-p-rel');
            sub.addEventListener('click', function (ev) {
              ev.stopPropagation();
              o.onSub();
            });
          }
          card.appendChild(sub);
          card.addEventListener('click', o.onTap);
          return card;
        }

        peopleSec.textContent = '人物 · 我 + ' + mains.length + ' 位角色' +
          (subs.length ? '（含 ' + subs.length + ' 个小号）' : '');

        /* 「我」 */
        peopleStrip.appendChild(cardFor({
          me: true,
          name: me ? me.name : '我',
          avatarOf: me,
          sub: masks.length ? (masks.length + ' 件马甲 ›') : '还没有马甲 ›',
          subIsHint: !masks.length,
          onTap: function () { ctx.open('mask-list'); }
        }));

        /* 大号：小字那行是「我 × TA」的关系，点一下写 / 改 */
        mains.forEach(function (c) {
          var rel = me ? core.relationOf(c.id, me.id, sb.id) : '';
          peopleStrip.appendChild(cardFor({
            name: c.name,
            avatarOf: c,
            sub: rel || (me ? '写关系' : '大号'),
            subIsHint: !rel,
            onSub: me ? function () { writeRelation(ctx, sb, c.id); } : null,
            onTap: function () { ctx.open('island-char', { sbId: sb.id, charId: c.id }); }
          }));
        });

        /* 皮套：挂在某个大号名下，小字标出来 */
        subs.forEach(function (it) {
          peopleStrip.appendChild(cardFor({
            name: it.c.name,
            avatarOf: it.c,
            sub: '小号 · ' + (it.parent.name || ''),
            onTap: function () {
              ctx.open('island-char', { sbId: sb.id, charId: it.c.id });
            }
          }));
        });

        /* 末尾：加人设 / 导入人设 —— 原来那整行大按钮并进这里（同样两件事，
           不占两处版面）。孤岛住满时不给这个位，跟 canAddChar 判定一致，
           免得点了只弹一句「住不下」。 */
        if (canAddChar(sb)) {
          var addBtn = h('button', 'iol-member is-add');
          addBtn.type = 'button';
          addBtn.appendChild(h('span', 'iol-add-mark', '＋'));
          addBtn.appendChild(h('small', '', '加人设'));
          addBtn.addEventListener('click', function () { openChar(ctx, sb, ''); });
          peopleStrip.appendChild(addBtn);

          if (Sleepy.charIO) {
            var impBtn = h('button', 'iol-member is-add');
            impBtn.type = 'button';
            impBtn.appendChild(h('span', 'iol-add-mark', '↓'));
            impBtn.appendChild(h('small', '', '导入人设'));
            impBtn.addEventListener('click', function () {
              Sleepy.charIO.importInto(ctx, sb.id);
            });
            peopleStrip.appendChild(impBtn);
          }
        }
      }

      /* 写关系：原本点树上的红线，现在点角色卡的小字。
         存在 links 上，所以它天然是「我 × 这个角色」这一段关系的注解。 */
      async function writeRelation(ctx, sb, charId) {
        /* 「我 × TA」的注解写到**这间房的大号**身上（跟卡上那个「我」同一件，
           否则写出来的关系跟看到的人对不上）。 */
        var me = core.defaultUserOfSandbox(sb) || core.activeUser();
        var ch = core.findChar(charId);
        var cur = core.relationOf(charId, me.id, sb.id);
        var next = await ui.prompt({
          title: '你和「' + (ch ? ch.name : '对方') + '」是什么关系？',
          note: '写一句话。留空就清掉。比如：青梅竹马、上下级、前男友',
          value: cur,
          ok: '写上'
        });
        if (next === null) return;
        var r = core.setRelation(charId, me.id, next, sb.id);
        if (!r.ok) { ctx.toast(r.message, 'err'); return; }
        paintPeople();
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
        paintPeople();
        paintNpcs();
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
       群岛多人要先选角（决策 4），这里的 降落 入口不替人选「对方」，
       留给切号器 / 桌面下拉。

       但「我」必须当场归位（用户 2026-09-21）：用哪件马甲不是「扮演谁」的
       问题，孤岛和桌面下拉本来就自动定 —— 不归位的话 activeUserId 还停在
       上一座岛的人身上，聊天列表（按 activeUser 过滤）、朋友圈的「我」、
       新建会话都会串到上一座岛去。取的是本岛的**大号**（isDefault），
       没有大号（名册为空）就不动，读侧有 activeUserOnIsland 兜着。 */
    var chars = core.charsOfSandbox(sb);
    var bigMe = core.defaultUserOfSandbox ? core.defaultUserOfSandbox(sb) : null;
    if (chars.length && !core.needsCharPick(sb)) {
      core.switchTo(chars[0].id, bigMe ? bigMe.id : undefined);
    } else if (bigMe) {
      core.switchTo(undefined, bigMe.id);
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
          var nAva = h('span', 'iol-member-ava', avatarLetter(n));
          card.appendChild(nAva);
          core.setAvatarBg(nAva, n);
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
        /* 总览即配置台（用户 2026-09-21 拍板）：点人物头像直接进编辑 ——
           char 进档案、我 进配置台（马甲/认知锁在那边）。以前是纯 div，
           点了没反应，用户以为编辑入口坏了。 */
        var p = h('button', 'iol-person is-' + kind);
        p.type = 'button';
        var ava = h('span', 'iol-ava', avatarLetter(c));
        p.appendChild(ava);
        p.appendChild(h('b', '', c.name || '未命名'));
        if (c.sub) p.appendChild(h('small', '', c.sub));
        core.setAvatarBg(ava, c);   /* 图库头像（avatarMedia）+ 网址头像都走这里 */
        p.addEventListener('click', function () {
          /* 总览即入口（用户 2026-09-22：「我需要点击岛屿总览就可以直接点上面的
             char 和 user 头像进行编辑，这是最顺畅最正常的思路」）——
             char **直接进编辑页**（以前落到档案页，还得再点一次「编辑全文」）；
             我 **直接进马甲编辑**（以前落到配置台，还得自己往下找「我的马甲」）。
             想看全貌走配置台的人物条：那边点卡片进档案，两边各司其职。 */
          if (kind === 'char' && c.id) {
            ctx.open('contact-edit', { id: c.id, sandboxId: sb.id, simple: true });
            return;
          }
          var meU = core.defaultUserOfSandbox(sb) || core.activeUser();
          if (meU) ctx.open('mask-edit', { id: meU.id });
          else ctx.open('island-config', { id: sb.id });
        });
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
        var heroAva = h('div', 'ipro-ava', avatarLetter(c));
        hero.appendChild(heroAva);
        core.setAvatarBg(heroAva, c);
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

        /* 国籍（2026-09-22）**另起一行**，不并进上面那条 ——
           上面那行的「法定地区」是他**住在哪个国家**（管节假日计算），
           国籍是他**是哪国人**（只显示）。两者经常不一样：
           常住东京的中国人 = 上面写日本、这里写中国。
           没填就不显示这行，不占版面。 */
        if (c.nationality) {
          hero.appendChild(h('p', 'ipro-place ipro-nation', '国籍 · ' + c.nationality));
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
              note: 'TA 在这座岛里的对话会一起移除；角色本身、小号和留痕档案都保留。不可撤销。',
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
        var mini = h('span', 'ipro-mini', avatarLetter(s));
        card.appendChild(mini);
        core.setAvatarBg(mini, s);
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
        /* 候选人里的「我」= 这间房的**大号** —— 用全局指针的话，
           群岛落岛残留下，别座岛的人会混进「谁认识他」的名单里。 */
        var me = (core.defaultUserOfSandbox && core.defaultUserOfSandbox(sb))
          || (core.activeUser ? core.activeUser() : null);

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

        /* ---- 人物资料（同学录排版，跟角色 / 马甲编辑页同一套）----
           用户：「所有的加人设 char、user、npc 大号小号都这样」。 */
        body.appendChild(h('p', 'iol-drawer-sec', '人物资料'));
        var form = h('div', 'simple-form');
        var top = h('div', 'face-row');

        /* 头像：跟大号/小号同一套入口（点框选本地图 / 框下贴网址）——
           以前 NPC 编辑页没有头像位（用户 2026-09-21）。 */
        var fAvatar = Sleepy.faceField ? Sleepy.faceField(null, {
          empty: '＋',
          toast: function (t, k) { ctx.toast(t, k); }
        }) : null;
        if (fAvatar) top.appendChild(fAvatar.el);

        var cols = h('div', 'face-cols');
        var fName = h('div', 'iol-field');
        fName.appendChild(h('label', '', '名字'));
        var nameInput = h('input');
        nameInput.placeholder = '聊天记录里出现的名字';
        nameInput.addEventListener('input', function () {
          if (fAvatar) fAvatar.setName(nameInput.value);
        });
        fName.appendChild(nameInput);
        cols.appendChild(fName);

        /* 微信名：会话列表里显示的名字（用户 2026-09-21）。 */
        var fWx = h('div', 'iol-field');
        fWx.appendChild(h('label', '', '微信名'));
        var wxInput = h('input');
        wxInput.placeholder = '会话列表里显示的名字（留空就用名字）';
        fWx.appendChild(wxInput);
        cols.appendChild(fWx);
        top.appendChild(cols);
        form.appendChild(top);

        var fBio = h('div', 'iol-field');
        fBio.appendChild(h('label', '', '人物简介'));
        var bio = h('textarea');
        bio.placeholder = 'TA 是谁，平时做什么……';
        fBio.appendChild(bio);
        form.appendChild(fBio);

        var fSay = h('div', 'iol-field');
        fSay.appendChild(h('label', '', '说话与行为方式'));
        var say = h('textarea');
        say.className = 'is-short';
        say.placeholder = 'TA 说话是什么感觉，会怎么做……';
        fSay.appendChild(say);
        form.appendChild(fSay);

        body.appendChild(form);

        /* ---- 谁认识他 ---- */
        body.appendChild(h('p', 'iol-drawer-sec', '谁认识他'));
        body.appendChild(h('p', 'iol-npc-note',
          '选择已经认识这个 NPC 的人。没有选择的人，不会自动获得 TA 的资料。'));
        if (known.length) {
          var people = h('div', 'iol-people');
          known.forEach(function (p) {
            var row = h('button', 'iol-person-pick is-on');
            row.type = 'button';
            var ava = h('span', 'iol-pick-ava', p.isMe ? '我' : avatarLetter(p));
            core.setAvatarBg(ava, p);
            row.appendChild(ava);
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
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
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
