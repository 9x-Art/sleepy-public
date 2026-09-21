/* ============================================================
   page-app.js — 聊天 App（4 Tab 容器）

   《聊天 App · 核心架构》：「聊天 App = 当前房屋监视器，前台 4 Tab」——
   消息 / 通讯录 / 朋友圈 / 我。所以它不是一个「聊天列表页」，
   而是一个**装着四屏的壳**。

   三层结构里它属于最里面那层：
     浮岛（造物主层）→ 桌面（降落之后的家）→ 本文件（点开某个 App）

   为什么要有这个壳：文档说要「无需任何身份过滤，直接加载当前沙盒的数据」——
   因为「人在哪间房」在桌面级就定了。四屏共用同一个前提（当前沙盒 + 当前马甲），
   底栏把它们串起来，切马甲之后消息与朋友圈一起刷。

   ---- 三个入口页是**同一个壳** ----
   桌面上的「聊天」「朋友圈」「我的」指向 chat-list / moments / me 三个页面 id，
   但它们渲染的都是这个容器，只是**默认停在哪个 tab** 不同。
   所以不存在两份实现（那样迟早漂移），也没有「点朋友圈进的是另一个地方」的怪事。

   ---- 谁画哪一屏 ----
     消息    → page-chat.js 的 Sleepy.chatApp.mountTab（要用它的私有工具）
     朋友圈  → page-moments.js 的 Sleepy.momentsTab.mountTab
     我      → page-switch.js 的 Sleepy.meTab.mountTab
     通讯录  → 就在本文件（只有它没有历史包袱，干脆就近写）

   依赖：store.js、core.js、ui.js、app.js
        运行时还要 page-chat / page-moments / page-switch 已经加载。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var core = Sleepy.core;

  var h = ui.h;
  var button = ui.button;

  /* 底栏图标：跟项目其它地方一套线性 SVG（**不许混 emoji**） */
  var SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"';

  var ICONS = {
    chat: '<svg ' + SVG + '><path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9.6L5 20v-4.2A3 3 0 0 1 4 13z"/>' +
      '<path d="M8.5 10.5h7"/></svg>',
    contacts: '<svg ' + SVG + '><circle cx="9.2" cy="8.4" r="3.3"/>' +
      '<path d="M3.4 19.8c0-3.1 2.6-5.2 5.8-5.2s5.8 2.1 5.8 5.2"/>' +
      '<path d="M16.2 6.2a3.1 3.1 0 0 1 0 5.8"/><path d="M17.6 15.1c1.9.7 3 2.3 3 4.7"/></svg>',
    moments: '<svg ' + SVG + '><circle cx="12" cy="12" r="8.3"/>' +
      '<circle cx="12" cy="12" r="3"/><path d="M12 3.7v2.3M12 18v2.3M3.7 12h2.3M18 12h2.3"/></svg>',
    me: '<svg ' + SVG + '><circle cx="12" cy="8.4" r="3.6"/>' +
      '<path d="M4.8 20c0-3.6 3.2-5.9 7.2-5.9s7.2 2.3 7.2 5.9"/></svg>'
  };

  var TABS = [
    { id: 'chat', name: '消息', icon: ICONS.chat },
    { id: 'contacts', name: '通讯录', icon: ICONS.contacts },
    { id: 'moments', name: '朋友圈', icon: ICONS.moments },
    { id: 'me', name: '我', icon: ICONS.me }
  ];

  function tabMeta(id) {
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].id === id) return TABS[i];
    }
    return TABS[0];
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function relativeTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 2) return '昨天';
    if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + ' 月 ' + dt.getDate() + ' 日';
  }

  /* ==================== 通讯录（本文件唯一自己画的一屏）====================

     决策 7：**平铺列表，不做树状图**。
     树（谁挂在谁名下）是造物主层的事，归浮岛的配置台；
     这里是「人在房间里抬头能看见谁」，平铺才像通讯录。

     只读：加人 / 改认知 / 建小号都回配置台（这一屏不提供那些入口，
     不然「局中人」和「造物主」两个视角会混在一起）。 */

  function renderContacts(panel, ctx) {
    function build() {
      panel.innerHTML = '';
      var sb = core.activeSandbox();
      if (!sb) {
        panel.appendChild(h('p', 'set-group-note', '还没有进过任何一间房。'));
        return;
      }

      var mains = core.charsOfSandbox(sb.id);

      var g = h('div', 'addr-group');
      g.appendChild(h('p', 'addr-group-title', '这间房里的人'));

      if (!mains.length) {
        g.appendChild(h('p', 'addr-empty',
          '这间房里还没有角色 · 去浮岛的配置台放一个'));
      }

      function personRow(c, badge) {
        var row = h('button', 'addr-row');
        row.type = 'button';

        var av = h('span', 'addr-av' + (c.avatar ? ' has-img' : ''), core.initialOf(c.name));
        if (c.avatar) {
          av.style.backgroundImage = 'url("' + String(c.avatar).replace(/"/g, '%22') + '")';
        }
        row.appendChild(av);

        var body = h('span', 'addr-body');
        var line = h('span', 'addr-name-line');
        line.appendChild(h('span', 'addr-name', c.name || '未命名'));
        line.appendChild(h('span', 'addr-badge', badge));
        body.appendChild(line);
        body.appendChild(h('span', 'addr-sub',
          c.status || (c.content ? String(c.content).split('\n')[0].slice(0, 22) : '还没写人设')));
        row.appendChild(body);

        row.addEventListener('click', function () { openChatWith(ctx, c.id); });
        return row;
      }

      mains.forEach(function (m) {
        g.appendChild(personRow(m, '大号'));
        /* 皮套**平铺**排在这里，带个角标注明身份 —— 缩进就变树了，
           树是配置台的事。NPC 不跟任何人（属于整座岛），在下面单独一组。 */
        var subs = Sleepy.island
          ? Sleepy.island.childrenOf(sb.id, m.id, 'sub', 'char')
          : core.subChars(m.id);
        subs.forEach(function (k) {
          g.appendChild(personRow(k, '皮套'));
        });
      });
      panel.appendChild(g);

      /* 岛内成员：唯一口径 core.npcsOfRoom（sandbox 新语义 + 老数据兜底）。
         以前这里分「角色名下 NPC」和「我这边的人」两组，口径收掉后合并。 */
      var npcs = core.npcsOfRoom ? core.npcsOfRoom(sb) : [];
      if (npcs.length) {
        var g2 = h('div', 'addr-group');
        g2.appendChild(h('p', 'addr-group-title', '岛内成员'));
        npcs.forEach(function (k) { g2.appendChild(personRow(k, 'NPC')); });
        panel.appendChild(g2);
      }

      panel.appendChild(h('p', 'set-group-note',
        '通讯录只是「抬头能看见谁」· 加人、建小号、改认知都在浮岛的配置台里'));
    }

    build();
    return { rebuild: build };
  }

  /* 点一个人 → 进和他的对话。已经聊过就进那条，没聊过就现建一条。
     通讯录的用处就是这个，别的都是次要的。 */
  function openChatWith(ctx, charId) {
    var cs = Sleepy.chatStore;
    if (!cs) { ctx.toast('聊天模块没加载出来', 'err'); return; }
    var list = cs.getChats();
    for (var i = 0; i < list.length; i++) {
      if (list[i].characterId === charId) {
        ctx.open('chat-detail', { chatId: list[i].id });
        return;
      }
    }
    var ch = core.findChar(charId);
    var chat = cs.createChat(ch ? (ch.name || '新对话') : '新对话', charId);
    if (!chat) { ctx.toast('建对话失败', 'err'); return; }
    ctx.open('chat-detail', { chatId: chat.id });
  }

  /* ==================== 容器 ==================== */

  function renderPanel(tabId, panel, ctx) {
    if (tabId === 'chat') {
      return Sleepy.chatApp ? Sleepy.chatApp.mountTab(panel, ctx) : null;
    }
    if (tabId === 'contacts') return renderContacts(panel, ctx);
    if (tabId === 'moments') {
      return Sleepy.momentsTab ? Sleepy.momentsTab.mountTab(panel, ctx) : null;
    }
    if (tabId === 'me') {
      return Sleepy.meTab ? Sleepy.meTab.mountTab(panel, ctx) : null;
    }
    return null;
  }

  function mount(ctx, defaultTab) {
    var inner = ctx.el.querySelector('.page-inner');
    ctx.el.classList.add('has-tabbar');

    var panel = h('div', 'tab-panel');
    ctx.body.appendChild(panel);

    var bar = h('div', 'tab-bar');
    bar.setAttribute('role', 'tablist');
    inner.appendChild(bar);

    var cur = tabMeta(defaultTab).id;
    var child = null;          /* 当前那一屏返回的刷新器 */

    var btnMap = {};
    TABS.forEach(function (t) {
      var b = h('button', 'tab-btn');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.innerHTML = '<span class="tab-ic">' + t.icon + '</span>' +
        '<span class="tab-tx">' + t.name + '</span>';
      b.addEventListener('click', function () { go(t.id); });
      bar.appendChild(b);
      btnMap[t.id] = b;
    });

    function go(id) {
      if (id === cur && child) return;      /* 点当前这个 tab 不做无用重画 */
      cur = id;
      paint();
    }

    function paint() {
      /* 朋友圈是白底（微信式），别的 tab 是玻璃风 —— 按当前 tab 打类。
         状态栏和顶栏的「刷白 + 透明」不在这里做：那是 CSS 用
         :has(.tab-panel.is-moments) 自己看 DOM 判断的（见 style.css）。
         早先试过在这儿给 #phone 打类，会遇到「页面实例被复用」
         或者「点的是当前 tab、paint 提前 return」而漏打的情况。 */
      panel.classList.toggle('is-moments', cur === 'moments');
      TABS.forEach(function (t) {
        var on = t.id === cur;
        btnMap[t.id].classList.toggle('is-on', on);
        btnMap[t.id].setAttribute('aria-selected', on ? 'true' : 'false');
      });
      /* 朋友圈那一屏**不写标题** —— 微信的朋友圈顶上就是封面图本身，
         三个字杵在那儿会把封面切掉一条（用户：「上面不要有『朋友圈』三个字」）。
         tab 名还在 tabMeta 里，底栏那一份不受影响。 */
      ctx.setTitle(cur === 'moments' ? '' : tabMeta(cur).name);
      /* 顶栏右侧先清空 —— 消息那一屏会自己挂「新建对话」，
         别的屏没有动作就是空的，别留上一个 tab 的残影。 */
      ctx.setActions([]);
      panel.innerHTML = '';
      try { panel.scrollTop = 0; } catch (e) { /* 某些环境不允许，忽略 */ }
      child = renderPanel(cur, panel, ctx);
    }

    /* 停在朋友圈 / 我 这两屏时，返回先切回消息 tab（= 聊天列表页），
       已经在消息 tab 就放行，让壳子照常退回桌面。
       右滑返回和左上角返回键都走 app.js 的 requestBack，都会经过这里。
       2026-09-19：原来只挂在 moments 入口上 —— 从「聊天」图标进来
       （chat-list 入口）切到朋友圈再返回，会直接退回桌面
       （用户：「要返回聊天列表页」）。现在三个入口统一挂。 */
    ctx.__backGuard = function () {
      if (cur === 'chat') return false;
      go('chat');
      return true;
    };

    paint();

    /* 回到这一页时刷新当前那一屏。有 rebuild 就用它（保住滚动位置），
       没有就整屏重画。

       刻意**不覆盖 ctx.refresh** —— 那是壳子（app.js）注入的方法，
       它内部负责调本页的 onShow；盖掉它等于把壳子的生命周期拆了。
       挂一个自己的名字，onShow 里再调它（见下面的注册）。 */
    ctx.__appRefresh = function () {
      if (child && child.rebuild) child.rebuild();
      else paint();
    };
  }

  /* ---------------------------- 注册 ----------------------------

     三个入口 id 都指向同一个壳，只是默认停在不同的 tab。
     这样桌面上的「聊天 / 朋友圈 / 我的」三个图标都不用改，
     也不会出现两份实现。 */
  var ENTRY = {
    'chat-list': 'chat',
    'moments': 'moments',
    'me': 'me'
  };

  Object.keys(ENTRY).forEach(function (id) {
    var def = {
      title: tabMeta(ENTRY[id]).name,
      render: function (ctx) { mount(ctx, ENTRY[id]); },
      /* 回到这一页时刷当前那一屏 —— 切完马甲回来、从对话详情返回、
         从配置台改完东西回来，都靠它。 */
      onShow: function (ctx) { if (ctx.__appRefresh) ctx.__appRefresh(); }
    };
    /* 三个入口统一接管返回：非消息 tab 先切回消息 tab（见 mount 里的守卫）。 */
    def.onBack = function (ctx) {
      return ctx.__backGuard ? ctx.__backGuard() : false;
    };
    Sleepy.register(id, def);
  });

  Sleepy.appTabs = {
    TABS: TABS,
    mount: mount,
    tabMeta: tabMeta
  };

})(window);
