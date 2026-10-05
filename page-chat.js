/* ============================================================
   page-chat.js — 聊天核心（施工卡模块 D）
   依赖：store.js、ui.js、app.js、api.js（必须在它们之后加载）
   覆盖：D1 消息发送/接收 · D2 气泡长按菜单 · D3 reroll · D4 加号面板
   页面：chat-list → chat-detail → favorites

   数据结构：
     chats: [{ id, name, createdAt, updatedAt, messages: [...] }]
     message: { id, role:'user'|'assistant'|'system', type?, content, timestamp, quote? }
       type 缺省 = 文字气泡；'file' / 'photo' = 附件气泡

   两个刻意的取舍，别当成 bug：
   1) 附件只存元数据（文件名 / 大小 / 类型）+ **mediaId**，不存 base64。
      图片本体在 IndexedDB 图库里（media.js），进存档的只有 mediaId ——
      objectURL 活不过刷新，别把它写进存档。
      （这段原来写的是「存储只等接 IndexedDB 再说」，早就接上了，2026-09-21 更正）
   2) 「空输入点发送」给模型塞的是一句用户口吻的指令。这是临时办法，
      等 F 模块（提示词引擎）做出来就该由 F 统一组装。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var api = Sleepy.api;

  var h = ui.h;
  var fmtBytes = ui.fmtBytes;
  var timeStr = ui.timeStr;
  var relativeTime = ui.relativeTime;

  var AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%237A5C4A'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z'/%3E%3C/svg%3E";

  /* 顶栏那排图标。原来用的是 ★ / ⚙ 这种文字符号 —— 不同系统字体长得不一样，
     大小和基线也飘，看着就不像一套。这里统一换成和加号面板同一套线性 SVG。 */
  var SVG_HEAD = 'viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  var ICON_PLUS = '<svg ' + SVG_HEAD + '><path d="M12 5.5v13"/><path d="M5.5 12h13"/></svg>';

  var ICON_SEARCH = '<svg ' + SVG_HEAD +
    '><circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/></svg>';

  /* 门：进入线下模式的入口（线上聊天的旁边「推门进去」） */
  var ICON_DOOR = '<svg ' + SVG_HEAD +
    '><path d="M6.5 20.5v-12a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v12"/>' +
    '<path d="M3.5 20.5h17"/><path d="M14 12h.01"/></svg>';

  var ICON_GEAR = '<svg ' + SVG_HEAD +
    '><circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M12 3.4v2.3M12 18.3v2.3M20.6 12h-2.3M5.7 12H3.4"/>' +
    '<path d="M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6M18.1 18.1l-1.6-1.6M7.5 7.5L5.9 5.9"/></svg>';

  /* 加号面板的图标。原来是 emoji —— 每个系统渲染得都不一样，
     大小、颜色、粗细全看各自字体，摆成一排像拼的。
     这里统一换成线性 SVG：同样 24 格、同样线宽、同样圆角。 */
  var SVG_BODY = 'viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  var PLUS_ICON = {
    photo: '<svg ' + SVG_BODY + '>' +
      '<rect x="3.4" y="5" width="17.2" height="14" rx="2.6"/>' +
      '<circle cx="9" cy="10" r="1.5"/>' +
      '<path d="M4.6 16.6l4.4-3.9 3.4 3 3-2.5 4 3.4"/></svg>',

    file: '<svg ' + SVG_BODY + '>' +
      '<path d="M6.2 3.6h6.3l5.3 5.3v10.5a1.2 1.2 0 0 1-1.2 1.2H6.2A1.2 1.2 0 0 1 5 19.4V4.8a1.2 1.2 0 0 1 1.2-1.2z"/>' +
      '<path d="M12.4 3.6v5.3h5.4"/></svg>',

    transfer: '<svg ' + SVG_BODY + '>' +
      '<rect x="2.8" y="6.6" width="18.4" height="10.8" rx="2.2"/>' +
      '<circle cx="12" cy="12" r="2.5"/>' +
      '<path d="M6.2 9.8v4.4M17.8 9.8v4.4"/></svg>',

    /* 翻译：文 + A + 箭头（经典翻译符号），跟这套线稿同一档粗细 */
    translate: '<svg ' + SVG_BODY + '>' +
      '<path d="M4.4 6h7.4M8.1 6V4.4M5.2 10.4c1.7-3.3 3.4-5 5.9-6.2"/>' +
      '<path d="M9.4 10.2l3.1 3.6"/>' +
      '<path d="M19.8 20l-3.5-8.6L12.8 20M14.2 17.2h4.2"/></svg>',

    pat: '<svg ' + SVG_BODY + '>' +
      '<path d="M10 12V6.3a1.5 1.5 0 0 1 3 0V12"/>' +
      '<path d="M13 11.6V5a1.5 1.5 0 0 1 3 0v7"/>' +
      '<path d="M16 12V8a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1.6a5 5 0 0 1-3.5-1.4l-2.6-2.6a1.5 1.5 0 0 1 2.1-2.1L10 16"/></svg>',

    genimg: '<svg ' + SVG_BODY + '>' +
      '<path d="M4.6 19.4l8.6-8.6"/>' +
      '<path d="M15.6 4.4l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/>' +
      '<path d="M6 4.8l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L4 6.8l1.4-.6z"/></svg>',

    checkin: '<svg ' + SVG_BODY + '>' +
      '<path d="M12 20.8s6.4-5.6 6.4-10.4a6.4 6.4 0 1 0-12.8 0c0 4.8 6.4 10.4 6.4 10.4z"/>' +
      '<circle cx="12" cy="10.4" r="2.4"/></svg>',

    diary: '<svg ' + SVG_BODY + '>' +
      '<rect x="5" y="3.6" width="14" height="16.8" rx="2.2"/>' +
      '<path d="M9.2 3.6v16.8"/>' +
      '<path d="M12.4 8.4h4M12.4 11.8h4"/></svg>',

    sticker: '<svg ' + SVG_BODY + '>' +
      '<circle cx="12" cy="12" r="8.6"/>' +
      '<path d="M8.8 14.2a4.2 4.2 0 0 0 6.4 0"/>' +
      '<path d="M9.2 9.6h.01M14.8 9.6h.01"/></svg>'
  };

  /* 空输入点发送时，替用户说的一句话。F 模块上线后由 F 接管。
     2026-09-26 用户真机报：几乎每轮都拿「我继续说的话…」当开场 ——
     光说「主动开口」模型会拿请示式开场白糊弄，禁令要写进提示本身。 */
  var PROACTIVE_HINT = '（我这边安静着，没打字。你直接说内容——你自己的事、或你想到的话，' +
    '不要说「我继续说」「那我说了」这类开场白，也不要问我要不要继续。）';
  /* 同样的「空发送」，但如果**上面最后一句就是我说的**（典型场景：
     我想分气泡连发三条，发完才让他开口），提示词不能再说「我没打字」——
     那会让模型以为我一句话都没说，回一句跟我刚说的完全无关的东西。
     这种情况换成「我说完了」。 */
  var PROACTIVE_HINT_REPLY = '（我说完了，你说吧。）';

  /* 空发送到底该用哪一句，看这轮对话里**最后一条有效消息是谁发的** */
  function proactiveHintFor(chat) {
    var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (!m) continue;
      if (m.role === 'user' || m.role === 'assistant') {
        return m.role === 'user' ? PROACTIVE_HINT_REPLY : PROACTIVE_HINT;
      }
    }
    /* 空对话（或者只有 system 事件条）：让他先开口 */
    return PROACTIVE_HINT;
  }

  /* ============================ 数据层 ============================ */

  /* ---- 对话数据的两个口子，**不要混用** ----

     allChats()  全量。**只有写入方用**。
       写入方必须先拿全量、改完再整表落盘（见 mutate 的注释）。
       如果写入方误用 getChats()，set 回去的就是一份被沙盒过滤过的列表，
       别的存档的对话会被整批抹掉 —— 而且不报错，等发现时早就没了。

     getChats()  当前沙盒可见的。**读取方用**。
       scopeId() 为 null（迁移前 / 还没分房）时原样返回全部。 */
  function allChats() {
    var list = store.get('chats');
    return Array.isArray(list) ? list : [];
  }

  function getChats() {
    var core = Sleepy.core;
    return (core && core.scoped) ? core.scoped(allChats()) : allChats();
  }

  /* 消息列表要用的那一份：**当前沙盒 + 当前马甲**。

     文档一：「『我』是马甲切换中枢，切完之后 Chat 列表和朋友圈无缝刷新为
     当前马甲视角」—— 所以列表要按「我此刻是谁」过滤：用小号聊过的对话，
     切回大号就该看不见（这正是查岗／修罗场要的效果）。

     ⚠️ 这是**只读视图**。写入方（mutate / 删除 / 清空）一律走 allChats()：
     拿过滤过的列表回写，会把别的马甲和别的存档的对话整批抹掉，
     而且全程不报错 —— 这个坑在 S4a 已经踩过一次。

     `!c.userId` 的老对话（没绑任何马甲的）算「没指定是谁的」，
     对每一张脸都可见，不然升级老存档之后那些对话会凭空消失。 */
  function viewChats() {
    var list = getChats();
    var core = Sleepy.core;
    /* 「我」过岛卫兵（activeUserOnIsland，2026-09-21）：群岛落岛时全局指针
       可能还停在**上一座岛**的马甲上，照它过滤会把本岛的会话全滤掉 ——
       表现就是「落岛后进聊天列表是空的」。卫兵不过关 = 这座岛还没定我是谁，
       那就不过滤（本岛会话都看得见），空白比串岛更不可接受。 */
    var u = (core && core.activeUserOnIsland) ? core.activeUserOnIsland() : null;
    if (!u) return list;
    return list.filter(function (c) { return !c.userId || c.userId === u.id; });
  }

  /* 列表顺序：**置顶的搬到最前**，其余原样跟在后头（2026-09-22 用户五.6）。

     只搬置顶项，非置顶项之间一个都不动 —— 「最近说话的排前面」是另一件事
     （现在也没有：新会话 unshift 到最前，之后收消息不重排），
     顺手改掉会让用户看见整个列表自己跳，不属于这次要的东西。

     置顶时间新的排更上（口径同新建会话：unshift 到最前）。 */
  function withPinnedFirst(list) {
    var pin = [];
    var rest = [];
    for (var i = 0; i < list.length; i++) {
      (list[i].pinned ? pin : rest).push(list[i]);
    }
    pin.sort(function (a, b) { return (b.pinnedAt || 0) - (a.pinnedAt || 0); });
    return pin.concat(rest);
  }

  /* 找「这个账号 × 这个角色」的那一条私聊。

     **必须是 (characterId, userId) 双匹配。** 同一个角色被大号和小号分别
     加过时，那是**两条各自独立的会话** —— 用户 2026-09-22 报的：
     「如果在不同账号加了 char 的同一账号，聊天的历史记录不能同步
     （不是说记忆，是说聊过的在对话框里的确切气泡）」。

     列表（viewChats）本来就按当前账号过滤，所以**看得见**的部分一直是对的；
     错的是「点进去时找哪一条」—— 以前只比对 characterId，于是小号点进
     通讯录会直接掉进大号那条对话，看到前一个身份聊过的内容。
     通讯录、朋友圈、日记、回忆、主动消息五处都踩过这个坑。

     userId 不传 = 用「当前岛上的当前账号」（过岛卫兵，口径同 viewChats）。
     老对话没有 userId 的，在精确匹配落空时退回它（升级老存档的兜底）。 */
  function chatOf(charId, userId) {
    if (!charId) return null;
    var core = Sleepy.core;
    var u = userId;
    if (u === undefined) u = (core && core.activeUserOnIsland) ? core.activeUserOnIsland() : null;
    var uid = (u && u.id) || (typeof u === 'string' ? u : '');
    var list = getChats();
    var loose = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.characterId !== charId || c.groupId) continue;
      if (uid && c.userId === uid) return c;
      if (!c.userId && !loose) loose = c;
    }
    return loose;
  }

  function saveChats(list) { store.set('chats', list); }

  /* 姓名读取一律走这里。characterId 现在指的是「哪张皮套」，
     名字要取皮套自己的名字（对外展示的那张脸），不是大号的。 */
  function getCharacters() {
    var list = store.get('characters');
    return Array.isArray(list) ? list : [];
  }

  function findCharacter(id) {
    if (!id) return null;
    var list = getCharacters();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* 会话显示名（2026-09-21 用户）：我给这个对话起的**备注** > 角色的
     **微信名** > 建对话时的快照名。列表/头像首字都走这里。 */
  function chatDisplayName(chat) {
    if (!chat) return '';
    if (chat.alias) return chat.alias;
    var c = chat.characterId ? findCharacter(chat.characterId) : null;
    if (c && c.wechatName) return c.wechatName;
    return chat.name || '对话';
  }

  /* 会话长按菜单：改备注 / 删除（2026-09-21 用户：「长按对话框改备注」）。
     复用朋友圈那套 .msg-menu 浮层样式。 */
  function openChatMenu(ctx, chat, rebuild) {
    var host = document.getElementById('phone') || ctx.el;
    var mask = h('div', 'msg-menu-mask');
    var sheet = h('div', 'msg-menu');
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('is-open');
      sheet.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }, 240);
    }
    function item(name, run, cls) {
      var b = h('button', 'msg-menu-item' + (cls ? ' ' + cls : ''), name);
      b.type = 'button';
      b.addEventListener('click', function () { close(); run(); });
      sheet.appendChild(b);
    }

    item(chat.alias ? '改备注 · ' + chat.alias : '设个备注', function () {
      ui.prompt({
        title: '备注名',
        placeholder: chatDisplayName(chat),
        value: chat.alias || '',
        ok: '保存'
      }).then(function (v) {
        if (v === null) return;
        var t = String(v).trim();
        var all = allChats();
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === chat.id) all[i].alias = t;
        }
        saveChats(all);
        rebuild();
        ctx.toast(t ? '备注好了' : '备注清掉了', 'ok');
      });
    });

    /* 置顶（2026-09-22 用户五.6）。备注/删除之外菜单里的第三项。
       置顶**不动 updatedAt** —— 那是「这条对话什么时候有动静」，
       跟「我想把它钉在上面」是两回事（所以不走 mutate，它末尾会刷时间）。 */
    var willPin = !chat.pinned;
    item(willPin ? '置顶该聊天' : '取消置顶', function () {
      var all = allChats();
      var now = Date.now();
      for (var i = 0; i < all.length; i++) {
        if (all[i].id !== chat.id) continue;
        all[i].pinned = willPin;
        all[i].pinnedAt = willPin ? now : 0;
      }
      saveChats(all);
      rebuild();
      ctx.toast(willPin ? '置顶好了' : '取消置顶了', 'ok');
    });

    item('删除对话', function () {
      ui.confirm({
        title: '删除「' + chatDisplayName(chat) + '」？',
        note: '里面的聊天记录会一起没掉。',
        ok: '删除',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        saveChats(allChats().filter(function (c) { return c.id !== chat.id; }));
        /* 整个对话没了 → 这一场的索引也清掉（别的对话/线下的索引留着） */
        if (chat.characterId && Sleepy.memoryVec && Sleepy.memoryVec.forget) {
          Sleepy.memoryVec.forget({ charId: chat.characterId, sourceId: chat.id })
            ['catch'](function () { /* 同上 */ });
        }
        rebuild();
        ctx.toast('已删除', 'ok');
      });
    }, 'is-danger');

    var cancel = h('button', 'msg-menu-cancel', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    sheet.appendChild(cancel);

    mask.addEventListener('click', close);
    host.appendChild(mask);
    host.appendChild(sheet);
    setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
  }

  /* 对话里显示的「对面是谁」：优先皮套名，兜底到大号名 */
  function charNameOf(chat) {
    var c = findCharacter(chat && chat.characterId);
    if (c) return c.name || '角色';
    if (chat && chat.name) return chat.name;
    return '角色';
  }

  /* 「你是谁」：当前这件 User 马甲的名字。
     掉马戏码全靠这两个名字的错位 —— 面具轮盘一换，它跟着变。 */
  function userNameOf(chat) {
    var core = Sleepy.core;
    if (core) {
      var u = core.findUser(chat && chat.userId) || core.activeUser();
      /* 名字留空 → 只剩微信名（core.labelOfUser） */
      if (u) return core.labelOfUser(u);
    }
    return '我';
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* 新建对话＝把名片夹里的某个角色拉进聊天列表。
     characterId = 哪张皮套，userId = 哪件马甲 —— 一条对话就是这个组合。
     这个组合是后面掉马矩阵、记忆四元组标签的坐标原点，缺一不可。
     overrides 是这个对话专属的生成参数，null 一律表示「跟随全局默认」。 */
  function createChat(name, characterId) {
    var chats = allChats();          /* 写入方：必须是全量 */
    var core = Sleepy.core;
    /* 「我」过岛卫兵：指针停在上一座岛的马甲上时，宁可不记 userId
       （viewChats 把 userId 空的对话对**每张脸**都放行，不会看不见），
       也不能把新对话挂到别座岛的人名下 —— 那是写进存档的脏数据。 */
    var activeUser = (core && core.activeUserOnIsland) ? core.activeUserOnIsland() : null;

    /* 皮套绑定了自己的 User 马甲就用它 —— 这才是 1:1 对称的意思。
       没绑就退回当前选中的马甲。 */
    var char = findCharacter(characterId);
    var userId = (char && char.boundUserId) || (activeUser ? activeUser.id : null);

    var chat = {
      id: newId(),
      name: name || '新对话',
      characterId: characterId || '',
      userId: userId,
      overrides: { temperature: null, maxTokens: null, contextMessages: null, stream: null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    /* 盖上当前房的章。漏盖 = 这条对话在任何房里都看不见（静默丢数据） */
    if (core && core.tagScope) core.tagScope(chat);
    chats.unshift(chat);
    saveChats(chats);
    return chat;
  }

  /* 老对话没有 overrides 字段，读的时候统一兜一层，
     免得每个调用点都写 `chat.overrides && chat.overrides.temperature` */
  function overridesOf(chat) {
    return (chat && chat.overrides) || {};
  }

  function getChat(id) {
    if (!id) return null;
    var chats = getChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === id) return chats[i];
    }
    return null;
  }

  /* 唯一改数据的入口：拿**全量**列表 → 改目标对话 → 整表落盘。
     只写单条对话会把别的对话冲掉（老版本踩过这个坑）；
     这里用 allChats() 而不是 getChats() 是同一个坑的新版本：
     沙盒过滤之后，后者会把别的存档的对话整批抹掉。 */
  function mutate(chatId, fn) {
    var chats = allChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id !== chatId) continue;
      fn(chats[i]);
      chats[i].updatedAt = Date.now();
      saveChats(chats);
      return chats[i];
    }
    return null;
  }

  function addMessage(chatId, msg) {
    mutate(chatId, function (c) { c.messages.push(msg); });
    return msg;
  }

  function dropMessages(chatId, ids) {
    var c0 = getChat(chatId);
    /* 语音（2.15）：消息删了，它那条音频也该从图库清掉 ——
       不清的话图库和存储占用里会留一堆「已经没有任何消息在引用」的音频。 */
    if (c0 && Array.isArray(c0.messages) && Sleepy.media && Sleepy.media.remove) {
      c0.messages.forEach(function (m) {
        if (ids.indexOf(m.id) < 0 || !m.voice || !m.voice.mediaId) return;
        try {
          var r = Sleepy.media.remove(m.voice.mediaId);
          if (r && r['catch']) r['catch'](function () { /* 清不掉不影响删除本身 */ });
        } catch (e) { /* 同上 */ }
      });
    }
    mutate(chatId, function (c) {
      c.messages = c.messages.filter(function (m) { return ids.indexOf(m.id) < 0; });
    });
    /* 索引里的原文是**给模型看的证据** —— 消息删了它就得跟着失效，
       否则 TA 以后还会引用一句根本不在聊天记录里的话（见 memoryVec.forget）。 */
    if (c0 && c0.characterId && Sleepy.memoryVec && Sleepy.memoryVec.forget) {
      Sleepy.memoryVec.forget({ charId: c0.characterId, ids: ids })
        ['catch'](function () { /* 索引清理失败不该让删除本身失败 */ });
    }
  }

  function patchMessage(chatId, id, patch) {
    var c0 = getChat(chatId);
    mutate(chatId, function (c) {
      for (var i = 0; i < c.messages.length; i++) {
        if (c.messages[i].id !== id) continue;
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) c.messages[i][k] = patch[k];
        }
        return;
      }
    });
    /* 改的如果**不是正文**（比如补个译文、翻个标记）就不用动索引 ——
       只有正文变了，索引里存的那份原文才和存档对不上。 */
    var touchedText = patch && Object.prototype.hasOwnProperty.call(patch, 'content');
    if (touchedText && c0 && c0.characterId && Sleepy.memoryVec && Sleepy.memoryVec.forget) {
      Sleepy.memoryVec.forget({ charId: c0.characterId, ids: [id] })
        ['catch'](function () { /* 同上 */ });
    }
  }

  /* ============================ 小工具 ============================ */

  /* 附件的可读文本。存进上下文时用它代替二进制 */
  /* ---------------------------- 角色发的表情 ----------------------------

     模型在回复里单独一行写 [表情:名字] 就是「我想发这个表情」。
     抽出来交给聊天去发一张真的表情图，正文里那段去掉。

     为什么用标签而不是让模型直接输出图片：它不知道也不该知道 URL ——
     表情是**用户自己收的**，模型只该说「想发哪个意思」（名字就是解释）。

     全角半角冒号都认；一行里写多个也认。纯函数，冒烟里单测。 */
  function extractStickers(raw) {
    var names = [];
    var text = String(raw == null ? '' : raw)
      .replace(/\[表情[：:]\s*([^\]\n]+?)\s*\]/g, function (_, nm) {
        var v = String(nm || '').trim();
        if (v) names.push(v);
        return '';
      })
      /* 抽掉标签后常见的残留：行尾空格、连续空行 */
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, names: names };
  }

  /* 角色拍一拍：回复里单独一行写 [拍一拍] 或 [拍一拍:后缀]。
     和 [表情:名字] 同一套机制 —— 模型只说「想做这个动作」，
     落成什么样的消息由这里管。全角半角冒号都认，纯函数。 */
  function extractPats(raw) {
    var suffix = null;
    var hit = false;
    var text = String(raw == null ? '' : raw)
      .replace(/\[拍一拍(?:[：:]([^\]\n]*))?\]/g, function (_, suf) {
        hit = true;
        var v = String(suf || '').trim();
        if (v) suffix = v;
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, patted: hit, suffix: suffix };
  }

  /* TA 主动发图：回复里写 [生图:一句话中文描述]（说明书在 imggen.replySpec，
     注入逻辑同表情包）。程序抽标签 → 生图 → 落成 assistant 图片消息。
     全角半角冒号都认；一次回复多张也认（发送时最多取 2 张防刷）。 */
  function extractGenimgs(raw) {
    var descs = [];
    var text = String(raw == null ? '' : raw)
      .replace(/\[生图[：:]\s*([^\]\n]+?)\s*\]/g, function (_, d) {
        var v = String(d || '').trim();
        if (v) descs.push(v);
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, descs: descs };
  }

  /* 收藏提议（We 收藏馆 P2）：回复里写 [收藏提议:事件id|分类|理由]。
     抽取 / 校验 / 去重 / 来源核验 / 落库全部收口在 Sleepy.weProposals
     （唯一出口 page-we-proposal.js）—— 这里只负责剥标签，正文里
     不出现任何标签文本。引擎缺席时退化为「只剥标签不创建提议」。 */
  function extractProposal(raw) {
    if (Sleepy.weProposals && Sleepy.weProposals.extractTag) {
      return Sleepy.weProposals.extractTag(raw);
    }
    return { text: String(raw == null ? '' : raw), hit: null };
  }

  /* 提议落库 + 落一张 we-proposal 卡片消息（卡片渲染见页面内 weProposalCard）。
     失败（格式非法 / 去重命中 / 来源 fail closed）**静默**——聊天正文照常。
     返回卡片消息或 null。 */
  function commitProposal(chatId, originMessageId, hit) {
    if (!Sleepy.weProposals || !hit) return null;
    var chat = getChat(chatId);
    if (!chat) return null;
    var r = Sleepy.weProposals.createFromReply(chat, originMessageId || null, hit);
    if (!r || !r.ok) return null;
    return addMessage(chatId, {
      id: newId(),
      role: 'assistant',
      type: 'we-proposal',
      proposalId: r.proposal.id,
      title: r.proposal.title,      /* 真实事件标题（程序侧复核过的） */
      note: r.proposal.note,        /* char 的提议理由 */
      sourceType: r.proposal.sourceType,
      sourceId: r.proposal.sourceId,
      content: '',
      timestamp: Date.now()
    });
  }

  /* 手机痕迹（查手机第 2 批）：把回复里的 [手机] 行抽出、校验、落库。
     搭载在本次回复上，0 新增调用（架构 v1 §5.1）；手机壳不存在就顺手建
     （幂等、0 API）。返回抽干净的正文 + 落库条数 + 授权卡负载。

     ⚠️ 归属只能从 chatId **现查**：调用方 runReply 的作用域里没有 chat 变量。
     这里曾经直接写 `chat.characterId`，'use strict' 下抛 ReferenceError，
     又被外层的 catch 吞掉 —— 手机痕迹一条都没落过库，且全程不报错
     （2026-09-23 审计 P0）。别再把调用方作用域里的名字抄进来。 */
  function applyPhoneTrace(chatId, text) {
    var out = { text: text, applied: 0, granted: null };
    if (!Sleepy.phone || !Sleepy.core) return out;
    try {
      var SC = Sleepy.core;
      var phScope = SC.scopeId();
      if (!phScope) return out;
      var rec = getChat(chatId);
      var charId = rec && rec.characterId;
      if (!charId) return out;
      /* 痕迹挂角色的**大脑**（皮套归大号），口径同记忆 */
      var phRec = Sleepy.phone.ensurePhone(phScope, SC.rootIdOf(charId) || charId);
      var pd = Sleepy.phone.extractPhoneDeltas(out.text);
      out.text = pd.text;
      pd.list.slice(0, 3).forEach(function (d) {
        var v = Sleepy.phone.validateDelta(d);
        if (!v) return;
        var res = Sleepy.phone.applyDelta(phRec, v, 'delta_' + Date.now().toString(36));
        if (res) {
          out.applied++;
          /* 授权类 delta：他主动递手机 —— 正文提交后再落邀请卡 */
          if (v.app === 'permission') out.granted = v.data;
        }
      });
    } catch (e) { /* 手机痕迹失败不影响这条回复 */ }
    return out;
  }

  /* ---------------- 多模态读图（方案-生图 v2 第 2 节） ----------------
     user 发的照片以真图进上下文（OpenAI vision 的 content 数组）。
     buildMessages 是同步的，所以 data URL 要提前备好：
     图片落库时顺手读一份进缓存；没赶上的异步补，下一轮生效。
     接口报「不支持 image」类错误时 visionBroken 熔断，退回文字占位。 */
  var imgDataCache = {};
  var imgDataPending = {};
  var visionBroken = false;

  function cachePhotoData(mediaId, blob) {
    if (!mediaId || !blob || imgDataCache[mediaId]) return;
    try {
      var fr = new FileReader();
      fr.onload = function () {
        if (fr.result) imgDataCache[mediaId] = String(fr.result);
      };
      fr.readAsDataURL(blob);
    } catch (e) { /* 读不出就维持文字占位 */ }
  }
  function preloadPhotoData(mediaId) {
    if (!mediaId || imgDataCache[mediaId] || imgDataPending[mediaId]) return;
    if (!(Sleepy.media && Sleepy.media.get)) return;
    imgDataPending[mediaId] = true;
    Sleepy.media.get(mediaId).then(function (rec) {
      delete imgDataPending[mediaId];
      if (rec && rec.blob) cachePhotoData(mediaId, rec.blob);
    }, function () { delete imgDataPending[mediaId]; });
  }

  /* 给别的模块喂缓存用（日记的生成配图在落地时先备好一份，
     TA 当轮「偷看日记」就能看见图，不用等下一轮） */
  Sleepy.chatVision = {
    preloadPhotoData: preloadPhotoData,
    cachePhotoData: cachePhotoData
  };

  function attachText(m) {
    /* assistant 的照片（TA 发的图）和 user 的照片在上下文里方向相反 */
    if (m.type === 'photo') {
      return m.role === 'assistant'
        ? '[你发了一张照片：' + (m.caption || m.name || '一张照片') + ']'
        : '[我发了一张照片：' + (m.name || '未命名') + ']';
    }
    if (m.type === 'file') return '[我发了一个文件：' + (m.name || '未命名') + '（' + fmtBytes(m.size || 0) + '）]';
    if (m.type === 'transfer') return transferText(m);
    /* 表情也要进上下文 —— 角色得知道「你刚发了个什么表情」 */
    if (m.type === 'sticker') return '[我发了一个表情：' + (m.name || '表情') + ']';
    /* 拍一拍进上下文：角色得知道自己被拍了 / 自己拍过人 */
    if (m.type === 'pat') return '[' + (m.content || '拍一拍') + ']';
    /* 查岗：没被察觉的查岗消息在 buildMessages 里整条过滤（TA 不该知道），
       能走到 attachText 的都是被察觉的 —— TA 得知道有人看了自己 */
    if (m.type === 'checkin') return '[对方刚刚「查岗」看了你一眼，你察觉到了视线：' + (m.caption || '看到了你的样子') + ']';
    /* 帷境的两种卡片（T6）：TA 得知道自己收到了什么 ——
       作品卡是「可以读了回应」，邀请卡是「等 TA 回应」。
       只报事实（标题 + 附言），**剧本正文一个字都不进来**：
       分享不等于 TA 读过了，更不等于那是 TA 的经历。 */
    if (m.type === 'wj-share') {
      return '[我分享了一部私人剧本：《' + (m.title || '未命名') + '》' +
        (m.note ? '，附言：' + m.note : '') + '；这是作品，不是发生过的事]';
    }
    if (m.type === 'wj-invite') {
      return '[我邀请你一起同席共读《' + (m.title || '未命名') + '》' +
        (m.answer ? '；你已经回应了' : '；还没有回应') + ']';
    }
    /* 收藏提议卡（We 收藏馆 P2）：只报事实，标签一个字都不进历史 ——
       对方只需要知道「有过这么个提议」，收不收是 user 的事。 */
    if (m.type === 'we-proposal') {
      return '[你想把「' + (m.title || '一件东西') + '」收进你们的收藏馆，' +
        '对方还没有回应]';
    }
    return m.content || '';
  }

  /* 取「一条消息里第 idx 个气泡」的纯文本。idx 不传 = 整条。
     ⚠️ 以后**只准从这里取正文**。一次模型输出在存档里是 '||' 拼起来的一整串
     （见 prompt-engine 的 splitBubblesT），而引用 / 编辑 / 复制 / 收藏 / 回喂模型
     过去各自抄了一遍 `m.type ? attachText(m) : m.content` —— 一共五份，
     全都取到了整串。用户报的「引用的是『消息1||消息2』这种分层结构，
     而不是我引用的那个气泡」就是这么来的（2026-09-21 修）。 */
  function bubbleText(m, idx) {
    if (!m) return '';
    if (m.type) return attachText(m) || '';
    var raw = m.content || '';
    if (idx === null || idx === undefined || m.role !== 'assistant') return raw;
    var arr = (Sleepy.promptEngine && Sleepy.promptEngine.splitBubbles)
      ? Sleepy.promptEngine.splitBubbles(raw) : [raw];
    return (arr[idx] === null || arr[idx] === undefined) ? raw : arr[idx];
  }

  /* 日记事件：user 写了新日记 → 下一轮 TA 会知道「写了」，但看不看是 TA 的事
     （偷看 / 尊重隐私 / 直接问，模型按人设自己选）。一次性：注入后摘旗。
     日记带配图（生图插画 / 相册贴图）时把真图一起带上 —— 偷看才看得到内容，
     尊重隐私的话模型自己会无视它。图没备进缓存就先文字占位 + 预载（下轮生效）。 */
  function diaryPeekMsg(charId) {
    if (!charId) return null;
    /* 项目 5 S6：读取侧归 root —— 写侧（page-diary）按 root 递字条，
       这里原来按脸读，皮套聊天时永远读不到（写 root 读脸的现存 bug）。 */
    var peekFrom = (Sleepy.core && Sleepy.core.rootIdOf)
      ? (Sleepy.core.rootIdOf(charId) || charId) : charId;
    var flag = store.get('diaryPeek:' + peekFrom);
    if (!flag || !flag.entryId) return null;
    store.set('diaryPeek:' + peekFrom, null);
    var entry = null;
    var list = store.get('diaries') || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === flag.entryId) { entry = list[i]; break; }
    }
    if (!entry || !entry.content) return null;

    var note = '[日记事件] 对方刚刚写了一篇新日记（TA 的私密日记，你平时看不到内容）。\n' +
      '你可以选择：① 偷看——内容和配图附在下面，可以自然地引用偷看到的细节；' +
      '② 尊重隐私——不看内容，当作只知道「TA 写了日记」；' +
      '③ 直接问对方能不能给你看。\n' +
      '按人设和你们当下的关系自然处理，不要表演式地宣告你选了哪个。\n' +
      '日记内容：「' + entry.content + '」';

    if (entry.mediaId) {
      var d = imgDataCache[entry.mediaId];
      if (d) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: note + '\n（配图见下）' },
            { type: 'image_url', image_url: { url: d } }
          ]
        };
      }
      preloadPhotoData(entry.mediaId);
    }
    return { role: 'system', content: note };
  }

  /* 会话列表的预览。三条规矩（用户 2026-09-21 拍板，照微信来）：
     1) **不带「你说：/对方回：」这种前缀** —— 名字和时间已经把「谁」交代
        清楚了，前缀只是噪音；这也是微信的样子。
     2) **只给最后一个气泡**。一次模型输出在存档里是用 '||' 把多个气泡拼成
        一整串（见 prompt-engine 的 splitBubblesT），直接 slice 就会把
        `消息1||消息2` 原样显示出来 —— 那是协议分隔符，不该给用户看见。
        用 splitBubblesT 而不是 splitBubbles：前者会把 [译]…[/译] 标签剥掉，
        否则最后一句带译文时，预览里会冒出「[译]…」。
     3) **不在 JS 里截断**，长了交给 CSS 的 ellipsis（.chat-item-preview）。
        JS 截 20 个字在不同字号/宽度下要么留白要么还是溢出。

     附件类不写「你发了…」：一来微信是方括号占位，二来老实现不管角色是谁
     都写「你」——TA 发来的图会被说成「你发的张照片」。 */
  function previewOf(msg) {
    if (!msg) return '空对话';
    if (msg.type === 'photo') return '[图片]';
    if (msg.type === 'file') return '[文件]' + (msg.name ? ' ' + msg.name : '');
    if (msg.type === 'transfer') return '[转账] ¥' + (Number(msg.amount) || 0).toFixed(2);
    if (msg.type === 'sticker') return '[表情]' + (msg.name ? ' ' + msg.name : '');
    if (msg.type === 'pat') return (msg.content || '拍了拍');
    if (msg.type === 'checkin') return '[查岗]' + (msg.caption ? ' ' + msg.caption : '');
    if (msg.type === 'phone-invite') return '[手机邀请]' + (msg.content ? ' ' + msg.content : '');
    if (msg.type === 'wj-share') return '[作品]《' + (msg.title || '未命名') + '》';
    if (msg.type === 'wj-invite') return '[同席邀请]《' + (msg.title || '未命名') + '》';
    if (msg.type === 'we-proposal') return '[收藏提议]' + (msg.title ? ' ' + msg.title : '');
    var raw = String(msg.content || '');
    var pe = Sleepy.promptEngine;
    if (pe && pe.splitBubblesT) {
      var b = pe.splitBubblesT(raw).bubbles;
      if (b && b.length) raw = b[b.length - 1] || raw;
    }
    return raw.replace(/\s+/g, ' ').trim();
  }

  /* 会话列表右上角的时间。照微信：今天给钟点（上午 10:23）、昨天给「昨天」、
     一周内给星期几、今年更早给「9月12日」、跨年给「2025年9月」。
     和 ui.relativeTime（「3 天前」）不是一回事，所以单独一个 ——
     那个是给收藏夹那种「多久以前」的场景用的，别混着改。 */
  function chatListTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var days = Math.round((day0 - t0) / 86400000);
    if (days <= 0) {
      var hh = d.getHours();
      var ap = hh < 6 ? '凌晨' : hh < 12 ? '上午' : hh < 18 ? '下午' : '晚上';
      var h12 = hh % 12;
      if (h12 === 0) h12 = 12;
      return ap + ' ' + h12 + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    }
    if (days === 1) return '昨天';
    if (days < 7) return '周' + '日一二三四五六'.charAt(d.getDay());
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
  }

  function copyText(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text);
    }
    /* file:// 下有些浏览器不给 clipboard，退回老办法 */
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error('浏览器不允许复制'));
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ======================== 转账 ========================

     docs/DRAFT.md 对它的「重做要求」写得挺具体，照着来：
       · 走 Sleepy.ui 的组件（老版自己拼 DOM，还把函数体塞进了
         `bubble.addEventListener('touchmove', ...)` 里）
       · **金额要校验上限**
       · 转账是**有明确语义的消息类型**（`type:'transfer'`），
         不要再伪装成 `role:'system'` 的文字消息 ——
         老版就是 push 一句「你向她转账 68.00 元」，模型那边只能靠猜

     输入只要一次：`68 买奶茶`。分开问「先金额再备注」要点两遍确认，
     太啰嗦；一次问完、按第一个空格切开就够，反正备注本来就常常不写。 */

  var TRANSFER_MAX = 99999;

  /* 解析「金额 + 备注」。纯函数 —— 冒烟里直接打表验，不用起浏览器。 */
  function parseTransfer(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, message: '金额不能是空的' };
    /* 金额后面必须是**空白或结束** —— 不然「68.999」会被拆成 68.99 + 备注「9」，
       小数被偷偷吃了还看不出来（冒烟里就是这么抓到的）。 */
    var m = s.match(/^([0-9]+(?:\.[0-9]{1,2})?)(?:\s+(.*))?$/);
    if (!m) return { ok: false, message: '第一个词得是金额，比如：68 买奶茶' };
    var amount = parseFloat(m[1]);
    if (!isFinite(amount) || amount <= 0) return { ok: false, message: '金额要大于 0' };
    if (amount > TRANSFER_MAX) {
      return { ok: false, message: '太多了 · 一次最多 ' + TRANSFER_MAX + ' 元' };
    }
    return {
      ok: true,
      amount: Math.round(amount * 100) / 100,
      /* 没写备注时这个分组是 undefined —— 上面那个正则把「有没有备注」
         变成了可选组，这里得兜一层 */
      note: (m[2] || '').trim().slice(0, 30)
    };
  }

  /* 一条转账消息的正文（给模型看的、给复制/收藏用的，都是它）。
     写成一句话而不是丢个 JSON：模型对「你转给顾清和 68.00 元」这种
     自然语言解读得最好，而 note 里的备注照原样带上。 */
  function transferText(msg) {
    var amt = '¥' + (Number(msg.amount) || 0).toFixed(2);
    return '[转账] ' + amt + (msg.note ? '（备注：' + msg.note + '）' : '');
  }

  /* 记忆入库。全量存进该 Char 的唯一大脑（rootId），
     并强制带上 (皮套, 马甲) 坐标 —— 这是掉马时对得上号的唯一依据。

     为什么不在 addMessage 里顺手做：
     心声、系统事件、附件不应该进记忆库；只有真正的对话才值得记。
     所以这里是显式调用，不是钩子。

     ⚠️ chatId 由调用方传入：本函数在模块层，而 chatId 是 chat-detail
     闭包里的变量 —— 早先写成直接引用闭包变量，一调用就 ReferenceError，
     发送从此断在半路（用户消息入了库、回复永远不来）。 */
  function commitMemory(cId, role, text) {
    var core = Sleepy.core;
    if (!core) return null;
    var c = getChat(cId);
    if (!c || !c.characterId || !text) return null;
    var rootId = core.rootIdOf(c.characterId);
    if (!rootId) return null;
    /* 返回刚落的这条记录（带 id）—— 调用方把 id 挂到消息上，
       reroll 时才能把它从记忆库精确删掉，否则模型读到自己上一版
       会顺着往下讲（用户报的「像是继续说」）。 */
    return core.addMemory({
      rootId: rootId,
      fromCharId: c.characterId,
      toUserId: c.userId || null,
      role: role,
      text: String(text).trim().slice(0, 600)
    });
  }

  /* 长按（触摸 480ms / 鼠标按住 480ms / 右键）打开菜单 */
  function bindLongPress(el, fn) {
    var timer = null;
    var sx = 0, sy = 0;

    function clear() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    function fire() {
      timer = null;
      el.__lpAt = Date.now();
      fn();
    }
    function move(x, y) {
      if (!timer) return;
      if (Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10) clear();
    }

    el.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      clear();
      timer = setTimeout(fire, 480);
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener('touchend', clear);
    el.addEventListener('touchcancel', clear);

    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(fire, 480);
    });
    el.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
    el.addEventListener('mouseup', clear);
    el.addEventListener('mouseleave', clear);

    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      clear();
      fire();
    });
  }

  /* 刚长按完紧接着的那次 click 要忽略，否则会连点两次 */
  function wasLongPressed(el) {
    return Date.now() - (el.__lpAt || 0) < 700;
  }

  /* 左滑这个气泡 = 引用它（微信的手感；用户报的五.14「左滑引用没做好」）。
     三条要点，缺一条就废：
       · 竖向位移一旦超过横向就撒手 —— 那是在滚消息，不是在滑气泡
       · 要过阈值才算，免得手抖就引用
       · 气泡上必须有 touch-action:pan-y（在 CSS 里），否则浏览器先把横滑
         手势吃掉，touchmove 根本不派发过来 */
  function bindSwipeQuote(el, fn) {
    var x0 = 0, y0 = 0, dx = 0, armed = false, alive = false;
    var THRESHOLD = 44;      /* 往左滑多少算数 */

    function reset() {
      alive = false; armed = false; dx = 0;
      el.style.transform = '';
      el.classList.remove('is-swiping');
    }

    el.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) return;
      x0 = t.clientX; y0 = t.clientY;
      dx = 0; alive = true; armed = false;
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!alive) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      var mx = t.clientX - x0;
      if (!armed) {
        if (Math.abs(t.clientY - y0) > Math.abs(mx)) { alive = false; return; }
        if (mx > -10) return;                    /* 只认左滑 */
        armed = true;
        el.classList.add('is-swiping');
      }
      dx = Math.max(mx, -76);
      el.style.transform = 'translateX(' + Math.round(dx) + 'px)';
    }, { passive: true });

    el.addEventListener('touchend', function () {
      var fire = armed && dx <= -THRESHOLD;
      if (fire) el.__swipeAt = Date.now();
      reset();
      if (fire) fn();
    });
    el.addEventListener('touchcancel', reset);
  }

  /* 刚左滑过紧接着的那次 click 也要忽略（同 wasLongPressed） */
  function swipedRecently(el) {
    return Date.now() - (el.__swipeAt || 0) < 700;
  }

  /* 打开「挑个人来聊」的浮层。面板本身在 page-chat-settings.js ——
     它要读名片夹、还要建对话，跟「对话设置」共用一套角色读取。 */
  function pickCharacter(ctx) {
    var cs = Sleepy.chatSettings;
    if (!cs || !cs.openPicker) {
      ctx.toast('选角色的面板没加载出来，刷新一下试试', 'err');
      return;
    }
    cs.openPicker(ctx);
  }

  /* ================= 聊天 App · 「消息」Tab 的内容 =================

     容器在 page-app.js —— 它管底栏和四个 tab 的切换，这里只画「消息」这一屏。
     返回 { rebuild }，容器在切回来 / onShow 的时候会调。

     为什么把列表拆出去而不是让容器自己画：这一屏要用本文件的
     getChats / previewOf / relativeTime / pickCharacter，
     全是模块私有的。搬出去就得再导一遍，反而更容易漂移。 */

  /* 顶栏的 + ：微信那个 + 是**一个菜单**（发起群聊 / 新的对话），
     不是直接把人丢进挑人面板。
     复用 `.msg-menu` 那套浮层样式与类名 —— 为两项东西另写一个浮层，
     只会多一份没人维护的 DOM 和 CSS。用完自己摘掉，不留在页面里。 */
  function openPlusSheet(ctx, items) {
    var host = document.getElementById('phone') || ctx.el;
    var mask = h('div', 'msg-menu-mask');
    var sheet = h('div', 'msg-menu');
    var list = h('div', 'msg-menu-list');
    var cancel = h('button', 'msg-menu-cancel', '取消');
    cancel.type = 'button';
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('is-open');
      sheet.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }, 240);
    }

    items.forEach(function (it) {
      var b = h('button', 'msg-menu-item', it.label);
      b.type = 'button';
      b.addEventListener('click', function () { close(); it.run(); });
      list.appendChild(b);
    });
    cancel.addEventListener('click', close);
    mask.addEventListener('click', close);

    sheet.appendChild(list);
    sheet.appendChild(cancel);
    host.appendChild(mask);
    host.appendChild(sheet);
    /* 等一帧再加 is-open：display:none → flex 那个过渡才吃得到 */
    setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
  }

  function mountChatTab(panel, ctx) {
    var body = panel;

    var emptyWrap = h('div', 'empty');
    emptyWrap.appendChild(h('div', 'empty-paper'));
    emptyWrap.appendChild(h('p', 'empty-text', '还没有任何对话'));
    var emptyHint = h('p', 'empty-hint', '');
    emptyWrap.appendChild(emptyHint);
    body.appendChild(emptyWrap);

    var listWrap = h('div', 'chat-list-wrap');
    body.appendChild(listWrap);

    /* 新建的入口放在右上角。它本质是「拉个人进来说话」，
       但 **+ 得是个菜单**（微信就是这么干的）：发起群聊 / 新的对话。
       直接进挑人面板的话，群聊那个入口就永远没人找得到。 */
    ctx.setActions([
      {
        label: '新建', svg: ICON_PLUS, onClick: function () {
          openPlusSheet(ctx, [
            { label: '发起群聊', run: function () { ctx.open('group-create'); } },
            { label: '新的对话', run: function () { pickCharacter(ctx); } }
          ]);
        }
      }
    ]);

    function rebuild() {
      /* 置顶项先搬上来（withPinnedFirst 只搬置顶，别的不动） */
      var chats = withPinnedFirst(viewChats());
      var people = getCharacters();
      var inRoom = getChats();          /* 全屋的（不分马甲），只用来写空态文案 */
      listWrap.innerHTML = '';
      var groups = Sleepy.groupStore ? Sleepy.groupStore.listGroups() : [];
      emptyWrap.style.display = (chats.length || groups.length) ? 'none' : 'flex';
      emptyHint.textContent = !(inRoom.length || groups.length)
        ? (people.length
          ? '点右上角的 + 从这间房里挑一个角色'
          : '这间房里还没有角色 · 先去浮岛的配置台放一个')
        /* 屋里明明有对话、这一屏是空的 —— 只能是「换了张脸」。
           不说清楚的话看着就像聊天记录丢了。 */
        : '换张脸试试 · 或者点右上角的 + 找个人聊';

      /* ---- 群聊区（线上群聊 v1）：拼图头像 + 群名 + 最新一条 ----
         在私聊列表之上。解散走二次确认；群里的人不受影响（成员只是退群）。 */
      if (groups.length && Sleepy.groupUI) {
        var gHead = h('p', 'chat-list-sect', '群聊');
        listWrap.appendChild(gHead);
        groups.forEach(function (g) {
          var item = h('div', 'chat-item chat-item-group');
          item.appendChild(Sleepy.groupUI.collageEl(g.id, 'list'));

          var main = h('div', 'chat-item-main');
          var gtop = h('div', 'chat-item-top');
          gtop.appendChild(h('span', 'chat-item-name', g.name));
          gtop.appendChild(h('span', 'chat-item-time', chatListTime(g.updatedAt)));
          main.appendChild(gtop);
          var last = Sleepy.groupStore.lastMessage(g.id);
          var preview = '';
          if (last) {
            if (last.type === 'system') preview = last.content;
            else if (last.recalledAt) preview = '撤回了一条消息';
            else {
              /* 群里保留「谁：说了什么」—— 这是微信群聊的样子，也确实有用
                 （私聊才需要去掉前缀，因为只有两个人，名字已经写在上面了）。 */
              var lm = Sleepy.groupStore.findMember(g.id, last.senderAccountId);
              preview = (lm ? Sleepy.groupStore.accountMeta(lm).name : '?') +
                '：' + String(last.content || '').replace(/\s+/g, ' ').trim();
            }
          }
          main.appendChild(h('span', 'chat-item-preview', preview));
          item.appendChild(main);

          /* 同私聊：删除走长按，不再挂一个容易误触的「删」按钮 */
          bindLongPress(item, function () {
            ui.confirm({
              title: '解散「' + g.name + '」？',
              note: '群的聊天记录和成员记录会一起没掉，角色那边不会收到任何通知。',
              ok: '解散',
              danger: true
            }).then(function (yes) {
              if (!yes) return;
              /* purgeGroup 是异步不可逆物理删：只有向量明确清空后才动主表；
                 失败 → {ok:false}，主表保留可重试，且**不 toast「已解散」**。 */
              Sleepy.groupStore.purgeGroup(g.id).then(function (res) {
                if (res && res.ok) {
                  rebuild();
                  ctx.toast('已解散', 'ok');
                } else {
                  ctx.toast((res && res.message) || (res && res.why) || '解散失败', 'err');
                }
              });
            });
          });

          item.addEventListener('click', function () {
            if (wasLongPressed(item)) return;   /* 同私聊：长按后别顺带进群 */
            ctx.open('group-chat', { groupId: g.id });
          });
          listWrap.appendChild(item);
        });

        listWrap.appendChild(h('p', 'chat-list-sect', '私聊'));
      }

      chats.forEach(function (chat) {
        /* is-pinned 铺一层极淡的底 —— 微信那种「置顶项看得见但不着色」
           （色板里的浅驼，不是灰：用户明确不要灰底）。 */
        var item = h('div', 'chat-item' + (chat.pinned ? ' is-pinned' : ''));

        /* 头像：以前私聊项只有名字和时间，头像位空着（.chat-item 的 gap:14
           留出一道白），看着像漏画了东西。沿用通讯录那套首字圆头像；
           char 有头像图就用图（本地图 avatarMedia 优先，走 core.setAvatarBg，
           has-img 由它异步加 —— .chat-item-ava.has-img 见 style.css）。 */
        var chAv = chat.characterId ? findCharacter(chat.characterId) : null;
        var dispName = chatDisplayName(chat);
        var ava = h('span', 'chat-item-ava', Sleepy.core.initialOf(dispName || '?'));
        Sleepy.core.setAvatarBg(ava, chAv);
        item.appendChild(ava);

        var main = h('div', 'chat-item-main');
        /* 名字在左、时间在右上角（微信那种），预览另起一行占满整宽 */
        var top = h('div', 'chat-item-top');
        top.appendChild(h('span', 'chat-item-name', dispName));
        top.appendChild(h('span', 'chat-item-time', chatListTime(chat.updatedAt)));
        main.appendChild(top);
        var msgs = Array.isArray(chat.messages) ? chat.messages : [];
        main.appendChild(h('span', 'chat-item-preview', previewOf(msgs[msgs.length - 1])));
        item.appendChild(main);

        /* 长按条目弹菜单：改备注 / 删除（2026-09-21 用户要「长按对话框改备注」，
           从原来的「直接二次确认删除」改成先弹菜单）。
           桌面端右键走同一条路（bindLongPress 里已经接了 contextmenu）。 */
        bindLongPress(item, function () {
          openChatMenu(ctx, chat, rebuild);
        });
        item.addEventListener('click', function () {
          /* 长按刚触发过（480ms 计时器 fire 之后就抬手）会补一次 click，
             不挡掉的话「长按删除」会顺手把对话也打开 */
          if (wasLongPressed(item)) return;
          ctx.open('chat-detail', { chatId: chat.id });
        });
        listWrap.appendChild(item);
      });
    }

    rebuild();
    /* 主动消息引擎：回到聊天列表就是一次扫描时机
       （引擎自己有 2 分钟节流 + 资格闸门，这里只管喊） */
    if (Sleepy.proactiveEngine) Sleepy.proactiveEngine.sweep();
    return { rebuild: rebuild };
  }

  /* ======================= 页面：聊天详情 ======================= */

  Sleepy.register('chat-detail', {
    title: '聊天',
    render: function (ctx) {
      var chatId = ctx.params.chatId;

      if (!getChat(chatId)) {
        ctx.toast('找不到这个对话', 'err');
        ctx.back();
        return;
      }
      /* 顶栏：头像居中、不出现名字。点头像＝心声（用户定的交互） */
      ctx.setTitle('');
      ctx.setActions([
        { label: '线下模式', svg: ICON_DOOR, onClick: function () {
            var c = getChat(chatId);
            if (!c || !c.characterId) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
            /* 点门直接弹「新的 / 继续上次」，选完就进线下页面 */
            if (Sleepy.offlineUI && Sleepy.offlineUI.openDoorSheet) {
              Sleepy.offlineUI.openDoorSheet(ctx, c.characterId, c.userId);
            } else {
              ctx.open('offline', { charId: c.characterId, chatId: chatId });
            }
          } },
        { label: '搜索聊天记录', svg: ICON_SEARCH, onClick: function () { openSearch(); } },
        { label: '对话设置', svg: ICON_GEAR, onClick: function () { ctx.open('chat-settings', { chatId: chatId }); } }
      ]);

      /* 顶栏正中是**名字**（用户定的：三版 UI 都不放头像），
         点名字直接跳朋友圈，少点一下。未读光点跟着名字走。 */
      function ensureHeadAvatar() {
        var headEl = ctx.el.querySelector('.app-head');
        if (!headEl) return;
        var c = getChat(chatId) || {};
        var ch = findCharacter(c.characterId);
        /* 页面实例是复用的（app.js applyParams 换参数只重画 body）——
           顶栏是 body 外面共享的那条，旧会话的名字槽还挂在上面。
           会话没变就留用；变了必须摘掉重挂，不然换了对话、
           顶栏还挂着上一场人的名字（2026-09-26 用户真机抓到：
           列表里是「皮套5号」，点进去顶栏是「验收员」）。 */
        var old = headEl.querySelector('.avatar-slot');
        if (old) {
          if (old.getAttribute('data-hb-chat') === chatId) return;
          /* setActions 可能把头清过一轮：槽可能已经是脱挂状态，别硬摘 */
          if (old.parentNode) old.parentNode.removeChild(old);
        }
        headEl.classList.add('head-ava-mode');
        var slot = Sleepy.heartbeat.mountName(ctx, chatId, ch ? ch.name : '对方');
        slot.classList.add('head-ava-center');
        headEl.appendChild(slot);
      }
      ensureHeadAvatar();

      /* ---------------- 搜索聊天记录（顶栏放大镜） ---------------- */
      /* 面板盖在页面上，输入即筛当前对话的消息；点结果跳到那条气泡。
         （收藏以后是独立的 App，这里只管找。） */
      var searchPanel = null;
      var curMode = 'classic';   /* 当前聊天皮肤：classic / wecom / phone */
      function openSearch() {
        if (searchPanel) { searchPanel.classList.add('is-open'); return; }
        searchPanel = h('div', 'chat-search');
        var bar = h('div', 'chat-search-bar');
        var input = h('input', 'chat-search-input');
        input.type = 'text';
        input.placeholder = '搜聊天记录';
        var closeBtn = h('button', 'chat-search-close', '完成');
        closeBtn.type = 'button';
        bar.appendChild(input);
        bar.appendChild(closeBtn);
        var results = h('div', 'chat-search-results');
        searchPanel.appendChild(bar);
        searchPanel.appendChild(results);
        /* 挂到 #phone 上而不是页面里：页面自身会滚动，
           absolute 的面板要锚在手机框上才不会跟着内容跑 */
        var phone = document.getElementById('phone');
        (phone || ctx.el).appendChild(searchPanel);
        /* 下一帧再聚焦，避免盖面板的过渡吃掉键盘 */
        setTimeout(function () { input.focus(); }, 60);

        closeBtn.addEventListener('click', function () {
          searchPanel.classList.remove('is-open');
        });

        input.addEventListener('input', function () {
          var q = String(input.value || '').trim().toLowerCase();
          results.innerHTML = '';
          if (!q) return;
          var c = getChat(chatId);
          var msgs = (c && c.messages) || [];
          var hits = [];
          for (var i = 0; i < msgs.length && hits.length < 50; i++) {
            var text = String(msgs[i].content || '');
            if (text.toLowerCase().indexOf(q) >= 0) hits.push(msgs[i]);
          }
          if (!hits.length) {
            results.appendChild(h('p', 'chat-search-empty', '没找到'));
            return;
          }
          hits.forEach(function (m) {
            var r = h('button', 'chat-search-hit');
            r.type = 'button';
            var text = String(m.content || '');
            var pos = text.toLowerCase().indexOf(q);
            var start = Math.max(0, pos - 18);
            var snippet = (start > 0 ? '…' : '') + text.slice(start, pos + q.length + 30) +
                          (start + q.length + 30 < text.length ? '…' : '');
            r.appendChild(h('span', 'chat-search-role', m.role === 'user' ? '我' : (c.name || '角色')));
            r.appendChild(h('span', 'chat-search-text', snippet));
            r.addEventListener('click', function () {
              searchPanel.classList.remove('is-open');
              var bubble = msgWrap.querySelector('[data-id="' + m.id + '"]');
              if (bubble) {
                bubble.scrollIntoView({ block: 'center' });
                bubble.classList.add('is-flash');
                setTimeout(function () { bubble.classList.remove('is-flash'); }, 1600);
              }
            });
            results.appendChild(r);
          });
        });
      }

      var body = ctx.body;

      /* -------- 只活在这一次拜访里的状态，不落盘 -------- */
      var reqSeq = 0;        /* 请求序号，旧回调一律丢弃 */
      var pending = null;    /* { text, timestamp, targetId } */
      var handle = null;     /* api.runChat 的句柄，用于停止 */
      var quote = null;      /* { role, content } */
      var selecting = false;
      var selected = {};     /* id -> true */
      var voiceBars = {};    /* msgId -> { el, play }：语音条，重画时整批作废 */

      /* 这一页里「当前对话」的唯一取法。⚠️ 别写成裸 `chat` —— 这个作用域里
         没有那个变量（mount 的入参是 ctx），'use strict' 下会直接
         ReferenceError，而它发生在**气泡渲染里**，整条对话会白屏。 */
      function curCharId() {
        var c = getChat(chatId);
        return c ? c.characterId : null;
      }

      /* ------------------------ 多选条 ------------------------ */

      var selBar = h('div', 'msg-select-bar');
      selBar.style.display = 'none';
      body.appendChild(selBar);

      /* ------------------------ 消息区 ------------------------ */

      var msgWrap = h('div', 'msg-wrap');
      body.appendChild(msgWrap);

      /* ------------------------ 底部 ------------------------ */

      var foot = h('div', 'chat-foot');

      var quoteBar = h('div', 'msg-quote-bar');
      quoteBar.style.display = 'none';
      foot.appendChild(quoteBar);

      var panel = h('div', 'plus-panel');
      foot.appendChild(panel);

      /* ---- 表情推荐条 ----
         在输入框里打了字，如果匹配到某张表情的**解释**，就在这儿横着排出来
         （左右可滑，防显示不全）。点一张直接发出去。
         用户：「输入某个文字之后可以匹配上对应的推荐表情包，
         并且推荐的表情包可以左右滑动显示，以防显示不完整」。 */
      var suggestBar = h('div', 'stk-suggest');
      foot.appendChild(suggestBar);

      var inputArea = h('div', 'input-area');
      var textarea = h('textarea', 'chat-input');
      textarea.placeholder = '写下你想说的话…';
      textarea.rows = 1;
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('spellcheck', 'false');

      /* 发送键是个图形（小猫爪），所以文字要放在 aria-label / title 里，
         否则读屏软件只能念出一个按钮。爪印用 currentColor 取色，
         底色换了它自己会跟着变。 */
      var PAW_SVG =
        '<svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true">' +
          '<ellipse cx="12" cy="15.9" rx="5.8" ry="4.5"/>' +
          '<ellipse cx="4.7" cy="11.7" rx="2.1" ry="2.7"/>' +
          '<ellipse cx="9.3" cy="6.7" rx="2.2" ry="2.9"/>' +
          '<ellipse cx="14.7" cy="6.7" rx="2.2" ry="2.9"/>' +
          '<ellipse cx="19.3" cy="11.7" rx="2.1" ry="2.7"/>' +
        '</svg>';

      var sendBtn = h('button', 'send-btn');
      sendBtn.type = 'button';
      sendBtn.innerHTML = PAW_SVG;
      sendBtn.setAttribute('aria-label', '发送');

      /* 加号用真的 SVG 而不是文字「+」——
         文字加号在不同字体下粗细/居中都不一样，而且偏细，看着像个小符号，
         跟旁边那枚笑脸挤在一起分不出主次（用户五.2）。
         描边 2px 的几何加号在任何字号下都是同一个形状。 */
      var plusBtn = h('button', 'plus-btn');
      plusBtn.type = 'button';
      plusBtn.title = '更多';
      plusBtn.setAttribute('aria-label', '更多');
      plusBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M12 5.2v13.6M5.2 12h13.6"/></svg>';

      /* ---- 表情包：挪进输入框**里面**（用户五.2 要的新布局）----
         以前是「笑脸 + 加号」两个 40px 圆钮并排在输入框左边：一行里塞了
         两个同尺寸的大圆坨，既挤又分不清哪个是哪个，还白白吃掉 88px 宽度。
         现在是 —— **最左加号、中间输入框、最右发送**，表情包做成框内右侧
         一枚 30px 的纯图标小钮：不占行上的宽度，又离手最近。
         放右侧而不是左侧：打字是从左往右长的，右边才是「还没用到的空间」。
         （切换账号不在聊天页做了，去「我」那一页。） */
      var inputWrap = h('div', 'chat-input-wrap');
      var emoBtn = h('button', 'emo-btn');
      emoBtn.type = 'button';
      emoBtn.title = '表情包';
      emoBtn.setAttribute('aria-label', '表情包');
      emoBtn.innerHTML = PLUS_ICON.sticker;
      emoBtn.addEventListener('click', openStickerPanel);
      inputWrap.appendChild(textarea);
      inputWrap.appendChild(emoBtn);

      inputArea.appendChild(plusBtn);
      inputArea.appendChild(inputWrap);
      inputArea.appendChild(sendBtn);
      foot.appendChild(inputArea);
      body.appendChild(foot);

      /* 长按菜单现在是一个**贴着被长按气泡的浮层**（ui.anchorPopover），
         不再是自己搭的整宽底部动作表 —— 以前那个必然铺满整屏、把消息全挡住，
         而且不贴被长按的那条（用户报的五.12）。DOM 也就不用在这里预先建了，
         由 openMenu 现开现收。 */

      /* ======================== 渲染 ======================== */

      function autoGrow() {
        textarea.style.height = 'auto';
        /* 注意：render 阶段元素还没挂进文档，scrollHeight 是 0，
           所以下限必须给足，并且进入页面时要再算一次（见 ctx.reload）。 */
        textarea.style.height = Math.max(42, Math.min(textarea.scrollHeight, 120)) + 'px';
      }

      /* ------------------------ 贴着底部 ------------------------
         用户 2026-09-23：「输入完一句回车发出去，看不到自己发的，要把输入框
         点掉才看得到」。

         根因不是「消息没渲染」，是**消息区被压矮之后没有人重新贴底**：
         键盘弹起时 .chat-foot 靠 --kb-inset 把自己抬起来（对），消息区随之
         矮掉 300px 上下（对），但 `scrollTop` 是**按旧高度算的底部**，浏览器
         不会替你把它夹到新的最大值 —— 底下正好是刚发出去那条所在的那一截，
         它就掉到可视区外面（也就是键盘那一边），于是「看不到自己发的」。
         把键盘一关，消息区涨回去、scrollTop 被夹回最大值 —— 又看得见了。
         这就是「点掉输入框才看得到」的全部原因（不是焦点问题，也不是没渲染）。

         所以：**只要上一次是「跟着底部走」的，尺寸一变就重新贴底**。
         用 ResizeObserver 盯 .msg-wrap 自己的盒子高度（键盘收放、输入框长高、
         加号面板展开、多选条出现，都会让它变高变矮），比去猜「谁改了高度」稳。
         用户自己往上翻看老消息时 stickBottom 会关掉，不会再把他拽回来。 */
      var stickBottom = true;
      var stickRO = null;
      function atBottom(slack) {
        return msgWrap.scrollTop >=
          msgWrap.scrollHeight - msgWrap.clientHeight - (slack || 0);
      }
      function toBottom() { msgWrap.scrollTop = msgWrap.scrollHeight; }
      /* 容差 40px：手指抖一下、橡皮筋回弹不算「翻走了」 */
      msgWrap.addEventListener('scroll', function () { stickBottom = atBottom(40); });
      /* 每次进页面都要重新武装（onHide 里会摘掉，见页面注册的 onHide） */
      function armStick() {
        if (stickRO) { try { stickRO.disconnect(); } catch (e) { /* 没有就算了 */ } }
        stickRO = null;
        if (!global.ResizeObserver) return;   /* 老浏览器：退回「只在重画时贴底」 */
        stickRO = new global.ResizeObserver(function () {
          if (!stickBottom) return;
          /* 同步贴一次不够 —— 键盘动画那几帧里 scrollHeight 可能还是旧值，
             下一帧再确认一次（用户看到的「少了一截」就是这几帧）。 */
          toBottom();
          if (global.requestAnimationFrame) global.requestAnimationFrame(toBottom);
        });
        try { stickRO.observe(msgWrap); } catch (e) { stickRO = null; }
      }

      function renderMessages(keepScroll) {
        var prev = msgWrap.scrollTop;
        msgWrap.innerHTML = '';
        /* 语音条是按 id 注册的，重画之后整批作废（旧节点已经不在文档里） */
        voiceBars = {};

        var c = getChat(chatId);
        if (!c) return;

        /* 当前皮肤模式：捡手机要多渲染昵称标，企微/捡手机不显示气泡下时间 */
        try {
          curMode = (Sleepy.charAppearance
            ? (Sleepy.charAppearance.resolve(c.characterId).mode || 'classic')
            : 'classic') || 'classic';
        } catch (e) { curMode = 'classic'; }

        var prevTs = 0;
        c.messages.forEach(function (m) {
          /* 时间分隔线：和上一条隔了 5 分钟以上就插一条居中的时间 */
          var ts = m.timestamp || 0;
          if (!prevTs || ts - prevTs >= 5 * 60 * 1000) {
            msgWrap.appendChild(h('div', 'msg-time-sep', timeSepLabel(ts)));
          }
          if (ts) prevTs = ts;

          /* 输出协议（预设注入系统）：assistant 正文里的 || 是气泡分隔符，
             一条存档消息按协议渲染成多条气泡。分段只在最后一段挂 reroll，
             长按菜单每段都能唤起（操作对象还是整条消息）。 */
          var segs = bubbleSegs(m);
          segs.forEach(function (seg, i) {
            msgWrap.appendChild(bubbleFor(m, c, {
              text: seg.text, trans: seg.trans, idx: i, total: segs.length
            }));
          });
        });
        if (pending && !pending.targetId) msgWrap.appendChild(pendingBubbles());

        syncBubbleDots();
        if (keepScroll) msgWrap.scrollTop = prev;
        else { stickBottom = true; toBottom(); }   /* 重画＝用户要看新的那条 */
      }

      /* 未读心声光点：只挂在**最后一条** char 气泡的头像上（多了会花）。
         有未读 = 光点呼吸；点进去看完（或收到新消息标已读）就灭。 */
      function syncBubbleDots() {
        var has = false;
        try { has = Sleepy.heartbeat.unreadCount(getChat(chatId)) > 0; } catch (e) { has = false; }
        var wraps = msgWrap.querySelectorAll('.msg-assistant .msg-ava-wrap');
        for (var i = 0; i < wraps.length; i++) {
          wraps[i].classList[has && i === wraps.length - 1 ? 'add' : 'remove']('has-unread');
        }
      }

      /* 分隔线的时间文案：今天只有时刻，昨天带「昨天」，再往前带日期 */
      function timeSepLabel(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var now = new Date();
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        var day = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - midnight) / 86400000);
        if (day === 0) return hm;
        if (day === 1) return '昨天 ' + hm;
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
      }

      function pad2(n) { return n < 10 ? '0' + n : '' + n; }

      /* 气泡分段。只有 assistant 的纯文字消息参与：正文里的 || 按输出协议
         切开；其他类型（表情 / 转账 / 拍一拍 / 引用外的附件）原样一段。 */
      function bubbleSegs(m) {
        if (m.role === 'assistant' && !m.type && Sleepy.promptEngine) {
          /* 正文按 || 切开；译文在落库时就抽好了（msg.trans），**按索引配对**，
             这里不再重解析正文 —— 一处解析、一处对齐，谁也不用猜。 */
          var list = Sleepy.promptEngine.splitBubbles(m.content);
          var tr = Array.isArray(m.trans) ? m.trans : [];
          return list.map(function (t, i) {
            return { text: t, trans: tr[i] || null };
          });
        }
        return [{ text: m.content || '', trans: null }];
      }

      /* ---------------- 译文块（组件：msg-trans） ----------------

         实现在 msg-trans.js（**线上线下共用一份**：线上私聊 / 线下私聊 /
         群线下三种摆法都走它）。这里只留薄薄一层门面：

           · needsTrans(c) —— 他说的话跟 user 是不是同一种语言
             （中文角色的气泡永远不长译文块，哪怕模型手滑写了 [译]）
           · attachTrans —— 两道闸门都过（开关开 + 语言不同）才挂上去

         摆法细节与为什么这么摆，见 msg-trans.js 与 style.css。 */
      function needsTrans(c) {
        return Sleepy.msgTrans.needs(c && c.characterId);
      }

      /* ==================== 语音（TTS 2.15） ====================

         数据：音频本体在 media（IndexedDB，kind:'audio'），消息上只挂
         `msg.voice = { mediaId, segIdx, seconds, provider, model, emotion, plan }`。
         **原文一个字都不动** —— 标签只存在于送给服务商的那份临时合成文本里
         （见 tts.js 的三层文本边界）。三条铁律：
           ① 播放失败不影响这条消息本身；
           ② 语音条是**点击播放**，自动播放被系统拦住也照样能点（契约 §9.12）；
           ③ 没有音频的消息长得和以前一模一样（不占位、不留白）。 */

      /* 这一轮距上次发语音隔了几条角色消息（冷却判据）。
         直接从**消息本身**数出来 —— 不另存「上次读的时间」那种指针，
         删除/编辑/撤回之后指针必然错位（项目里踩过）。 */
      function turnsSinceVoice() {
        var cc = getChat(chatId);
        var msgs = (cc && cc.messages) || [];
        var n = 0;
        for (var i = msgs.length - 1; i >= 0; i--) {
          var m = msgs[i];
          if (m.voice) return n;
          if (m.role === 'assistant' && !m.type) n++;
        }
        return Infinity;   /* 从来没读过：不构成冷却 */
      }

      /* 自动播放：角色设置里 auto / 跟随全局（全局默认在设置页里选） */
      function shouldAutoPlay(cfg) {
        if (!cfg) return false;
        if (cfg.autoplay === 'auto') return true;
        if (cfg.autoplay !== 'global') return false;
        return Sleepy.tts.settings().autoPlay === 'auto';
      }

      /* 一条语音条。注册进 voiceBars（生成完要立刻播一次时靠它找 DOM）。 */
      function voiceBarFor(msg) {
        var v = msg.voice || {};
        var bar = h('button', 'msg-voice');
        bar.type = 'button';
        var icon = h('span', 'msg-voice-icon', '▶');
        bar.appendChild(icon);
        bar.appendChild(h('span', 'msg-voice-wave'));   /* 装饰性小波形 */
        bar.appendChild(h('span', 'msg-voice-secs', (v.seconds || 0) + '″'));
        var audio = null;
        var playing = false;

        function reset() { playing = false; icon.textContent = '▶'; bar.classList.remove('is-playing'); }
        function ensure() {
          if (audio) return Promise.resolve(audio);
          return Sleepy.media.url(v.mediaId).then(function (u) {
            if (!u) return null;
            audio = new global.Audio(u);
            audio.addEventListener('ended', reset);
            audio.addEventListener('pause', reset);
            return audio;
          });
        }
        function play() {
          ensure().then(function (a) {
            if (!a) { ctx.toast('这条语音找不到了（图库里的音频被清过）', 'err'); return; }
            var p = a.play();
            if (p && p.catch) {
              p.catch(function () {
                reset();
                ctx.toast(Sleepy.tts.normalizedError('AUTOPLAY_BLOCKED').userText, 'warn');
              });
            }
            playing = true; icon.textContent = '❚❚'; bar.classList.add('is-playing');
          });
        }
        bar.addEventListener('click', function (e) {
          e.stopPropagation();   /* 别顺带触发「多选」 */
          if (playing && audio) { audio.pause(); reset(); return; }
          play();
        });
        voiceBars[msg.id] = { el: bar, play: play };
        return bar;
      }

      /* 语音条旁边那枚「文」小钮（微信那种：语音条是主形态）。
         文字稿默认显不显跟角色的 keepTranscript 走（渲染时已经据此挂了
         .tts-no-text），点这里手动翻一下 —— 翻过就记进 textShowOverride，
         重绘也保得住。正文一个字都不动，只改显示。 */
      function voiceTextToggle(bubble, msg) {
        var b = h('button', 'msg-voice-text', '文');
        b.type = 'button';
        b.title = '显示 / 隐藏文字稿';
        function sync() {
          var shown = !bubble.classList.contains('tts-no-text');
          b.classList[shown ? 'add' : 'remove']('is-on');
          b.setAttribute('aria-pressed', shown ? 'true' : 'false');
        }
        b.addEventListener('click', function (e) {
          e.stopPropagation();       /* 别顺带触发「多选」 */
          var shown = !bubble.classList.contains('tts-no-text');
          textShowOverride[msg.id] = !shown;
          bubble.classList.toggle('tts-no-text');
          sync();
        });
        sync();
        return b;
      }

      /* 把一段音频挂到某条消息上（朗读与自动读共用） */
      function attachVoice(msgId, charId, text, res) {
        return Sleepy.media.put(res.blob, { name: '语音', kind: 'audio' }).then(function (mid) {
          patchMessage(chatId, msgId, {
            voice: {
              mediaId: mid,
              seconds: res.seconds || 0,
              provider: res.provider,
              model: res.model,
              emotion: (res.plan && res.plan.emotion) || 'neutral',
              plan: res.plan || null,
              at: Date.now()
            }
          });
          /* keepTranscript=false → 气泡只留语音条（搜索/记忆仍然留着原文） */
          renderMessages();
          return { mediaId: mid };
        });
      }

      /* 手动朗读（长按菜单里那一项）。不受主动频率限制，但仍受长度限制。 */
      function readAloud(msg, seg) {
        if (!Sleepy.tts) return;
        var text = bubbleText(msg, seg ? seg.idx : null);
        if (!String(text || '').trim()) { ctx.toast('这一句没有可读的文字', 'warn'); return; }
        if (!Sleepy.tts.settings().enabled) {
          ctx.toast('语音总开关还关着 —— 去「设置 → 语音 TTS」打开', 'warn');
          return;
        }
        var cfg = Sleepy.tts.voiceConfigOf(curCharId());
        if (!cfg.voiceId) { ctx.toast('这件角色还没填音色 ID', 'warn'); return; }
        ctx.toast('正在生成语音…');
        /* 计划先过导演（模型版开着才真问模型；失败静默退回规则版）——
           上下文给最近两句，够模型判「这句该怎么念」了。 */
        var cid = curCharId();
        var r = Sleepy.tts.resolveVoice(cid);
        var cc = getChat(chatId);
        var recent = (((cc && cc.messages) || []).slice(-3, -1)).map(function (m) {
          return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content || '' };
        });
        var planOf = Sleepy.ttsDirector
          ? Sleepy.ttsDirector.planFor(text, cfg, {
            manual: true,
            context: recent,
            features: r.ok ? Sleepy.tts.featuresOf(r.provider, r.model) : null
          })
          : Promise.resolve(Sleepy.tts.speechPlanOf(text, cfg, { manual: true }));
        planOf.then(function (plan) {
          return Sleepy.tts.generate({
            charId: cid,
            text: text,
            manual: true,
            plan: plan
          });
        }).then(function (res) {
          if (!res.ok) {
            ctx.toast((res.error && res.error.userText) || '语音生成失败', 'err');
            return;
          }
          attachVoice(msg.id, curCharId(), text, res).then(function () {
            var vb = voiceBars[msg.id];
            if (vb) vb.play();   /* 用户点的 → 一定试着播 */
          });
        });
      }

      /* 角色回复落地后：按角色的语音设置决定要不要自动读一句。
         失败静默（只在控制台留一行）—— 语音挂了不该弹一堆红字打扰聊天。 */
      function maybeAutoVoice(msgId, text) {
        if (!Sleepy.tts || !msgId || !String(text || '').trim()) return;
        var charId = curCharId();
        if (!charId || !Sleepy.tts.settings().enabled) return;
        var cfg = Sleepy.tts.voiceConfigOf(charId);
        if (!cfg.enabled || !cfg.voiceId) return;
        /* 只读**第一段**（一轮里最多一条语音）—— 一条回复被拆成好几段，
           每段都读会变成连播三条，听着像卡带。 */
        var segs = (Sleepy.promptEngine && Sleepy.promptEngine.splitBubbles)
          ? Sleepy.promptEngine.splitBubbles(text) : [text];
        var first = String(segs[0] || text || '').trim();
        if (!first) return;
        var plan = Sleepy.tts.speechPlanOf(first, cfg, { turnsSinceVoice: turnsSinceVoice() });
        if (!plan.shouldGenerate) return;      /* 门禁不通过就别去问模型（省一次调用） */
        var rv = Sleepy.tts.resolveVoice(charId);
        var cc = getChat(chatId);
        var recent = (((cc && cc.messages) || []).slice(-3, -1)).map(function (m) {
          return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content || '' };
        });
        var planOf = Sleepy.ttsDirector
          ? Sleepy.ttsDirector.planFor(first, cfg, {
            turnsSinceVoice: turnsSinceVoice(),
            context: recent,
            features: rv.ok ? Sleepy.tts.featuresOf(rv.provider, rv.model) : null
          })
          : Promise.resolve(plan);
        planOf.then(function (ready) {
          return Sleepy.tts.generate({ charId: charId, text: first, plan: ready });
        }).then(function (res) {
          if (!res.ok) return;   /* 静默：自动语音失败不打扰 */
          attachVoice(msgId, charId, first, res).then(function () {
            if (shouldAutoPlay(cfg)) {
              var vb = voiceBars[msgId];
              if (vb) vb.play();
            }
          });
        });
      }

      /* 文字稿的手动翻看状态：msgId -> true(强制显示) / false(强制隐藏)。
         缺省（没记过）＝跟角色的 keepTranscript 走。
         只活在内存里（不落库）—— 重绘要保住用户刚翻的那一下，
         切走聊天时这个闭包没了，自然清干净。 */
      var textShowOverride = {};

      function bubbleFor(msg, c, seg) {
        seg = seg || null;
        var role = msg.role === 'user' ? 'user'
                 : (msg.role === 'system' ? 'system' : 'assistant');
        /* 拍一拍：微信那种居中灰字，不是气泡。
           没有头像、没有长按菜单、没有重答 —— 它是个动作记录，不是话。 */
        if (msg.type === 'pat') {
          return h('div', 'msg-pat', msg.content || '拍了拍');
        }
        /* 查岗：居中「系统镜头」卡（用户 2026-09-29 定稿）—— 这张图不是
           任何人拍的（线上功能的窥视镜头），挂在 user 气泡里会读成
           「我发了张 TA 的照片」。只换渲染载体：
           存储仍是 role:'user'（noticed 隔离闸门 / 上下文装配 / plan 不动），
           sender 语义照旧与真实归属一致。长按菜单照旧从卡上唤起；
           左滑引用对系统卡无意义，不挂。 */
        if (msg.type === 'checkin') {
          var lens = h('div', 'msg-checkin-row');
          lens.setAttribute('data-id', msg.id);
          var lensKey = selKey(msg.id, 0);
          if (selecting && selected[lensKey]) lens.classList.add('is-selected');
          lens.appendChild(checkinCard(msg));
          bindLongPress(lens, function () { openMenu(msg, null, lens); });
          lens.addEventListener('click', function () {
            if (wasLongPressed(lens)) return;
            if (selecting) toggleSelect(lensKey);
          });
          return lens;
        }
        var bubble = h('div', 'msg-bubble msg-' + role);
        bubble.setAttribute('data-id', msg.id);

        /* 语音（2.15）：语音条是主形态，正文默认显不显跟角色的 keepTranscript
           走；用户点过语音条旁边那枚「文」钮就听他的（textShowOverride）。
           正文本身一个字都不动 —— 搜索、记忆、导出照旧用 msg.content。 */
        if (msg.voice && Sleepy.tts) {
          var textOv = textShowOverride[msg.id];
          var wantText = (textOv === undefined)
            ? !!Sleepy.tts.voiceConfigOf(c && c.characterId).keepTranscript
            : !!textOv;
          if (!wantText) bubble.classList.add('tts-no-text');
        }

        var herePending = !!(pending && pending.targetId === msg.id);
        if (herePending) bubble.classList.add('is-pending');
        var myKey = selKey(msg.id, seg ? seg.idx : 0);
        if (selecting && selected[myKey]) {
          /* 选中态**一个气泡一份**：勾就挂在这个气泡自己身上（用户 2026-09-23
             报的是「点第二个气泡就退出多选」—— 以前按整条算，勾也只标在
             第一个气泡上，第二个气泡根本点不着、点了反而是取消）。
             CSS 见 .msg-bubble.is-selected::after。 */
          bubble.classList.add('is-selected');
        }

        if (role === 'assistant') {
          /* 头像包一层：未读心声光点挂这里（用户定的位置 —— 不在顶栏），
             点头像还是看没说出口的话 */
          var avWrap = h('span', 'msg-ava-wrap');
          var av = charAvatarEl(c);
          av.alt = '角色';
          av.title = '看没说出口的话';
          avWrap.appendChild(av);
          avWrap.appendChild(h('span', 'hb-dot'));
          avWrap.addEventListener('click', function (e) {
            e.stopPropagation();
            Sleepy.heartbeat.openOverlay(ctx, chatId);
          });
          bubble.appendChild(avWrap);
        }

        /* user 也带头像（企微参考图两边都有；捡手机模式下由 CSS 藏掉） */
        if (role === 'user') {
          bubble.appendChild(userAvatarEl());
        }

        /* 内容列：引用条 / 正文 / 时间都装在这里，头像才能并排在左边 */
        var content = h('div', 'msg-body');

        if (msg.quote) {
          content.appendChild(h('div', 'msg-quote',
            '引用' + (msg.quote.role === 'user' ? '我' : '对方') + '：' + msg.quote.content));
        }

        /* 捡手机皮肤：头像旁的小昵称标（参考图里 avatar 边上那个小字） */
        if (role === 'assistant' && curMode === 'phone') {
          var nick = c && c.characterId ? findCharacter(c.characterId) : null;
          content.appendChild(h('div', 'msg-nick', nick ? nick.name : ''));
        }

        if (msg.type === 'sticker') {
          content.appendChild(stickerBubble(msg));
        } else if (msg.type === 'transfer') {
          content.appendChild(transferCard(msg));
        } else if (msg.type === 'photo' || msg.type === 'file') {
          content.appendChild(attachCard(msg));
        } else if (msg.type === 'wj-share' || msg.type === 'wj-invite') {
          content.appendChild(wjCard(msg));
        } else if (msg.type === 'we-proposal') {
          content.appendChild(weProposalCard(msg));
        } else {
          var textEl = h('div', 'msg-text');
          var shown;
          if (herePending) {
            /* 流式中：整条回复先挤在一个气泡里（按行显示），落库后再拆段 */
            shown = pendingVisible();
            if (!shown) {
              textEl.appendChild(h('span', 'typing-dots', '···'));
              content.appendChild(textEl);
            } else {
              textEl.textContent = shown;
              content.appendChild(textEl);
            }
          } else {
            shown = seg ? (seg.text || '（空）') : (msg.content || '（空）');
            textEl.textContent = shown;
            content.appendChild(textEl);
            /* 译文（组件 msg-trans）：只在 assistant 的气泡上出现，
               而且只在翻译开关开着的时候挂 —— 关掉就是干干净净一句原文。
               两道闸门写在 attach 里，这里不自己判开关。 */
            if (seg && seg.trans && role === 'assistant') {
              Sleepy.msgTrans.attach(content, msg.id + ':' + seg.idx, seg.trans, c && c.characterId);
            }
            /* 语音条：只挂在**第一段**气泡上（一轮一条语音），
               没有音频的消息一点痕迹都不留。
               旁边跟一枚「文」钮 —— 语音条是主形态，文字稿可手动翻。 */
            if (role === 'assistant' && msg.voice && (!seg || seg.idx === 0)) {
              var vRow = h('div', 'msg-voice-row');
              vRow.appendChild(voiceBarFor(msg));
              vRow.appendChild(voiceTextToggle(bubble, msg));
              content.appendChild(vRow);
            }
          }
        }

        var meta = h('div', 'msg-meta');
        meta.appendChild(h('span', 'msg-time', timeStr(msg.timestamp)));

        var isLast = c.messages[c.messages.length - 1] === msg;
        if (herePending) {
          var stopBtn = h('button', 'msg-act', '停止');
          stopBtn.type = 'button';
          stopBtn.addEventListener('click', function (e) { e.stopPropagation(); stopReply(); });
          meta.appendChild(stopBtn);
        } else if (role === 'assistant' && !msg.type && isLast && !pending &&
                   (!seg || seg.idx === seg.total - 1)) {
          /* reroll 只挂分段消息的最后一段 —— 挂在每段上会连着出现好几个 */
          meta.appendChild(rerollBtn(msg));
        } else if (role === 'assistant' && msg.type === 'photo' && msg.subject && isLast && !pending) {
          /* TA 发的图可以重画：同 subject 重新生成，原地替换 */
          meta.appendChild(redrawBtn(msg));
        }
        content.appendChild(meta);
        bubble.appendChild(content);

        if (role !== 'system') {
          /* 长按菜单**贴着这个气泡**弹，所以要把气泡元素和它的下标一起带上
             —— 引用 / 编辑 / 复制 / 收藏都只作用于这一句，不是整轮
             （用户报的五.14~16；以前菜单里带的只有整条 msg）。 */
          bindLongPress(bubble, function () { openMenu(msg, seg, bubble); });
          /* 左滑引用：同样带上下标 */
          bindSwipeQuote(bubble, function () {
            startQuote(msg, seg ? seg.idx : null);
          });
          bubble.addEventListener('click', function () {
            if (wasLongPressed(bubble)) return;
            if (swipedRecently(bubble)) return;
            if (selecting) toggleSelect(myKey);
          });
        }
        return bubble;
      }

      /* 转账气泡。橙金色，跟照片/文件那种灰卡片区分开 ——
         钱是这一屏里最该被一眼认出来的东西。
         点一下能看完整备注（备注最多 30 字，卡片里放不下就截断）。 */
      function transferCard(msg) {
        var card = h('div', 'msg-transfer');
        var ic = h('span', 'msg-transfer-ic');
        ic.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" ' +
          'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6v8.8"/>' +
          '<path d="M14.8 9.6a2.8 2.8 0 0 0-2.6-1.3c-1.5 0-2.5.9-2.5 2s1 1.8 2.5 1.8' +
          ' 2.6.7 2.6 1.9-1.1 2-2.6 2a2.9 2.9 0 0 1-2.7-1.4"/></svg>';
        card.appendChild(ic);

        var main = h('div', 'msg-transfer-main');
        main.appendChild(h('span', 'msg-transfer-amt',
          '¥' + (Number(msg.amount) || 0).toFixed(2)));
        main.appendChild(h('span', 'msg-transfer-sub', msg.note || '转账'));
        card.appendChild(main);
        return card;
      }

      /* 表情消息：贴图本身，**没有气泡框**（微信就这样）。
         图取不到（图库清过、老记录）就写一句，别留个破图。 */
      function stickerBubble(msg) {
        var box = h('div', 'msg-sticker');
        var img = h('img', 'msg-sticker-img');
        img.alt = msg.name || '表情';

        function missing(why) {
          box.classList.add('is-missing');
          if (img.parentNode) img.parentNode.removeChild(img);
          box.appendChild(h('span', 'msg-sticker-miss', why));
        }

        /* 外链表情最常见的坏法：图挂了（域名没了 / 403 / 图床把图删了）。
           不兜的话气泡里就是一个破图加一行 alt 文字，很难看。 */
        img.addEventListener('error', function () { missing('表情包丢失了qwq'); });
        box.appendChild(img);

        var p = (msg.mediaId && Sleepy.media)
          ? Sleepy.media.url(msg.mediaId)
          : Promise.resolve(msg.url || '');
        p.then(function (u) {
          if (u) { img.src = u; return; }
          missing('表情包丢失了qwq');
        });
        return box;
      }

      /* 查岗卡片：图 + 一句「你看到了什么」。
         被察觉时才标「TA 发现了」——没察觉的不标，悬念留给你自己品。 */
      function checkinCard(msg) {
        var box = h('div', 'msg-checkin');
        /* 居中系统卡的抬头（用户 2026-09-29）：点明这是窥视镜头，
           不是任何人发的消息 —— caption 也不再带「你悄悄看了一眼」前缀。 */
        box.appendChild(h('div', 'msg-checkin-head', '偷看了一眼'));
        var img = h('img', 'msg-photo-img');
        img.alt = msg.caption || '查岗';
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.removeChild(img);
          box.appendChild(h('span', 'msg-photo-miss', '这张图找不到了'));
        });
        box.appendChild(img);
        var p = (msg.mediaId && Sleepy.media)
          ? Sleepy.media.url(msg.mediaId)
          : Promise.resolve(msg.url || '');
        p.then(function (u) { if (u) img.src = u; });
        box.appendChild(h('div', 'msg-checkin-cap', msg.caption || '…'));
        if (msg.noticed) box.appendChild(h('span', 'msg-checkin-tag', 'TA 发现了'));
        return box;
      }

      /* 帷境那两种卡片（T6）：作品卡 / 同席邀请卡。
         渲染在 page-wj-curtain.js 里（**本文件先加载**，所以只能惰性取 ——
         加载期读 Sleepy.wjCurtainUI 会拿到 undefined）。
         卡片不是「说了什么」，所以不带时间/长按菜单之外的任何聊天气泡装饰。 */
      function wjCard(msg) {
        var UI = Sleepy.wjCurtainUI;
        if (!UI) return h('div', 'msg-text', '（帷境还没准备好）');
        if (msg.type === 'wj-share') return UI.shareEl(msg);
        return UI.inviteEl(msg, {
          onEnter: function () {
            ctx.open('wj-read', { id: msg.workId, session: msg.sessionId });
          }
        });
      }

      /* 收藏提议卡（We 收藏馆 P2）：char 提议 → user 确认的确认流入口。
         数据与动作唯一出口是 Sleepy.weProposals（page-we-proposal.js）——
         这里只渲染 + 转发按钮点击，**accept/decline 不是模型动作**。
         来源状态实时复核（completed 有效 / cancelled 失效都照实显示）。 */
      function weProposalCard(msg) {
        var card = h('div', 'msg-wep');
        var box = h('div', 'msg-wep-card');
        box.appendChild(h('div', 'msg-wep-k', '收 藏 提 议'));
        box.appendChild(h('div', 'msg-wep-title', msg.title || '（未命名）'));
        if (msg.note) box.appendChild(h('p', 'msg-wep-note', msg.note));

        var p = (Sleepy.weProposals && Sleepy.weProposals.findInScope)
          ? Sleepy.weProposals.findInScope(msg.proposalId) : null;
        var src = (Sleepy.collectionStore && Sleepy.collectionStore.checkSource)
          ? Sleepy.collectionStore.checkSource(
              { sourceType: msg.sourceType, sourceId: msg.sourceId })
          : { status: 'live', text: '' };

        var foot = h('div', 'msg-wep-foot');
        if (!p) {
          foot.appendChild(h('span', 'msg-wep-state', '这条提议已不存在'));
        } else if (p.status === 'accepted') {
          foot.appendChild(h('span', 'msg-wep-state is-ok', '已收进馆里'));
        } else if (p.status === 'declined') {
          foot.appendChild(h('span', 'msg-wep-state', '暂时没有收下'));
        } else {
          /* pending：来源状态照实显示 —— 已取消/已删除的约定先告诉 user
             不能收（user 点收下时 accept 还会再复核一次，双保险） */
          var stateText = (src.status === 'gone')
            ? src.text : '待你确认';
          var st = h('span', 'msg-wep-state' + (src.status === 'gone' ? ' is-warn' : ''), stateText);
          foot.appendChild(st);
          var acts = h('div', 'msg-wep-acts');
          var okBtn = h('button', 'msg-wep-btn is-primary', '收进馆里');
          okBtn.type = 'button';
          okBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var r = Sleepy.weProposals ? Sleepy.weProposals.accept(msg.proposalId) : { ok: false };
            if (r.ok) {
              ctx.toast('已收进馆里', 'ok');
            } else if (r.why === 'cancelled' || r.why === 'deleted') {
              /* 来源确认前失效：保留 pending + 明确提示，绝不静默入馆 */
              ctx.toast('这条约定已经不在了，提议先留着', 'warn');
            } else if (r.why === 'already-accepted') {
              ctx.toast('已经在馆里了', 'ok');
            } else {
              ctx.toast('暂时收不进来，稍后再试', 'warn');
            }
            renderMessages();
          });
          var noBtn = h('button', 'msg-wep-btn', '暂时不留');
          noBtn.type = 'button';
          noBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (Sleepy.weProposals) Sleepy.weProposals.decline(msg.proposalId);
            ctx.toast('先不留', 'ok');
            renderMessages();
          });
          acts.appendChild(okBtn);
          acts.appendChild(noBtn);
          foot.appendChild(acts);
        }
        box.appendChild(foot);
        card.appendChild(box);
        return card;
      }

      function attachCard(msg) {
        /* 照片：本体在 IndexedDB 里，现取一个 objectURL 贴上。
           取不到（老消息只存了文件名、或者图库被清过）就退回文件名卡片 ——
           宁可显示「这张图找不到了」，也别留一个破图。 */
        if (msg.type === 'photo' && msg.mediaId && Sleepy.media) {
          var box = h('div', 'msg-photo');
          var img = h('img', 'msg-photo-img');
          var fullSrc = '';        /* 取到 objectURL 后存这儿，点开大图要用 */
          img.alt = msg.caption || msg.name || '照片';
          box.appendChild(img);
          Sleepy.media.url(msg.mediaId).then(function (src) {
            if (src) { fullSrc = src; img.src = src; return; }
            box.classList.add('is-missing');
            box.appendChild(h('span', 'msg-photo-miss', '这张图找不到了'));
          }, function () {
            box.classList.add('is-missing');
            box.appendChild(h('span', 'msg-photo-miss', '图库打不开'));
          });
          /* 点一下看整张。图注只在**放大态**里出现 —— 铺在气泡里会把
             「一张照片」变成「一张配了解释的卡片」（用户 2026-09-23 报的）。 */
          box.addEventListener('click', function () {
            if (!fullSrc) return;
            ui.imageViewer(fullSrc, { caption: msg.caption || '', alt: img.alt });
          });
          return box;
        }

        var card = h('div', 'msg-attach');
        card.appendChild(h('span', 'msg-attach-ic', msg.type === 'photo' ? '📷' : '📎'));
        var main = h('div', 'msg-attach-main');
        main.appendChild(h('span', 'msg-attach-name', msg.name || '未命名'));
        main.appendChild(h('span', 'msg-attach-size', fmtBytes(msg.size || 0)));
        card.appendChild(main);
        return card;
      }

      /* 重画按钮（TA 发的图）：同 subject 重新生成，原地替换 */
      function redrawBtn(msg) {
        var b = h('button', 'msg-act', '重画');
        b.type = 'button';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          redrawPhoto(msg);
        });
        return b;
      }

      /* 流式期间就按气泡协议**渐进拆段**（2026-09-26 用户：
         「完整的气泡显示所有内容，过一会儿才拆开」—— 以前整条挤一个
         气泡、落库才拆，观感差）。段数没变只改文本，段数变了才整页重画
         （onDelta 那边配合，见热路径注释）。 */
      function pendingSegs() {
        if (!pending) return [];
        var s = splitReplyOf(pending.raw);
        return (s.bubbles && s.bubbles.length) ? s.bubbles : (s.visible ? [s.visible] : []);
      }
      function pendingBubbles() {
        var frag = document.createDocumentFragment();
        var segs = pendingSegs();
        if (!segs.length) { frag.appendChild(pendingOne('')); return frag; }
        segs.forEach(function (t) { frag.appendChild(pendingOne(t)); });
        return frag;
      }
      function pendingOne(text) {
        var bubble = h('div', 'msg-bubble msg-assistant is-pending');

        var av = charAvatarEl(getChat(chatId));
        av.alt = '角色';
        bubble.appendChild(av);

        var content = h('div', 'msg-body');
        var textEl = h('div', 'msg-text');
        if (text) textEl.textContent = text;
        else textEl.appendChild(h('span', 'typing-dots', '···'));
        content.appendChild(textEl);

        var meta = h('div', 'msg-meta');
        meta.appendChild(h('span', 'msg-time', timeStr(pending.timestamp)));
        var stopBtn = h('button', 'msg-act', '停止');
        stopBtn.type = 'button';
        stopBtn.addEventListener('click', function () { stopReply(); });
        meta.appendChild(stopBtn);
        content.appendChild(meta);
        bubble.appendChild(content);
        return bubble;
      }

      function rerollBtn(msg) {
        var b = h('button', 'msg-act', 'reroll');
        b.type = 'button';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          startReroll(msg);
        });
        return b;
      }

      function updateSendUI() {
        var busy = !!pending;
        sendBtn.disabled = busy;
        /* 别用 textContent 改发送键——那会把爪印 SVG 抹掉。
           忙碌状态只加 class，靠 CSS 的呼吸动画表达「在等回复」。 */
        sendBtn.classList[busy ? 'add' : 'remove']('is-busy');
        sendBtn.title = busy ? '还在等回复'
          : '发送 · 输入框里有字就发出去，空着点就是让 TA 开口';
      }

      /* 流式过程中，心声标签之后的内容不能进气泡。
         统一从这里取正文，别再直接读 pending.raw。

         解析走 prompt-engine 的 parseReply：它同时认新的 [WHISPER] 标签
         （预设注入引擎的输出协议）和旧的 <心声> 标签（老存档、切回旧引擎
         时的输出），半截标签的扣尾逻辑也在这层做完。 */
      function splitReplyOf(raw) {
        if (Sleepy.promptEngine) return Sleepy.promptEngine.parseReply(raw);
        return Sleepy.heartbeat.splitReply(raw);   /* 引擎缺席的保底 */
      }
      function pendingVisible() {
        if (!pending) return '';
        var s = splitReplyOf(pending.raw);
        /* 流式期间多个气泡先挤在一个气泡里按行显示，落库后渲染层再拆 */
        return s.bubbles ? s.bubbles.join('\n') : s.visible;
      }

      /* ======================== 多选 ========================
         ⚠️ 选择是**按气泡**算的，不是按整条消息（2026-09-23 用户：
         「多选气泡的时候，点击第二个气泡就会退出多选」）。
         以前 selected 的键是 msg.id，而一条回复会被 || 拆成好几个气泡 ——
         点同一条的第二个气泡就是「取消同一条」，选中集合当场变空、直接
         退出多选；删除也只能整轮删（见 removeBubbles 那段说明）。
         所以键改成 `msgId#idx`：一条消息的每个气泡各算一份。 */

      function selKey(msgId, idx) {
        return msgId + '#' + ((idx === undefined || idx === null) ? 0 : idx);
      }
      function parseSelKey(k) {
        var i = String(k).lastIndexOf('#');
        return { id: String(k).slice(0, i), idx: Number(String(k).slice(i + 1)) || 0 };
      }

      function selectedIds() { return Object.keys(selected); }

      function enterSelect(msgId, idx) {
        selecting = true;
        selected = {};
        if (msgId) selected[selKey(msgId, idx)] = true;
        renderSelection();
        renderMessages(true);
      }

      function exitSelect() {
        selecting = false;
        selected = {};
        renderSelection();
        renderMessages(true);
      }

      function toggleSelect(key) {
        if (selected[key]) delete selected[key];
        else selected[key] = true;
        if (!selectedIds().length) { exitSelect(); return; }
        renderSelection();
        renderMessages(true);
      }

      /* 按气泡删。文案 / 译文 / 语音 / 索引的收口都在 store 那两个函数里
         （dropMessages / patchMessage），这里只负责「算该摘哪几段」：
           · 一条话有多个气泡 → 把选中的下标从正文里摘掉，用 ' || ' 重拼
             （正文的存储格式就是 `a || b || c`，见 prompt-engine.splitBubbles）
           · 摘空了 / 本来就只有一段 / 不是分段消息（附件、表情、转账、
             用户自己的话）→ 交给 dropMessages 把整条删掉（它连语音和图库
             里的音频一起清）。 */
      function removeBubbles(pairs) {
        var byMsg = {};
        pairs.forEach(function (p) {
          if (!p || !p.id) return;
          byMsg[p.id] = byMsg[p.id] || [];
          if (byMsg[p.id].indexOf(p.idx) < 0) byMsg[p.id].push(p.idx);
        });
        Object.keys(byMsg).forEach(function (id) {
          var c = getChat(chatId);
          var msg = null;
          ((c && c.messages) || []).forEach(function (m) { if (m.id === id) msg = m; });
          if (!msg) return;
          var idxs = byMsg[id];
          if (msg.role !== 'assistant' || msg.type) { dropMessages(chatId, [id]); return; }
          var arr = Sleepy.promptEngine
            ? Sleepy.promptEngine.splitBubbles(msg.content || '') : [msg.content || ''];
          if (arr.length <= 1) { dropMessages(chatId, [id]); return; }
          var keep = [], keepTr = [];
          arr.forEach(function (t, i) {
            if (idxs.indexOf(i) >= 0) return;
            keep.push(t);
            keepTr.push(Array.isArray(msg.trans) ? (msg.trans[i] || null) : null);
          });
          if (!keep.length) { dropMessages(chatId, [id]); return; }
          var patch = { content: keep.join(' || ') };
          /* 译文是按**下标**对齐的（msg.trans[i] ↔ 第 i 个气泡）：
             少了一段就得整份重排，不能只删自己那格。 */
          if (Array.isArray(msg.trans)) patch.trans = keepTr;
          patchMessage(chatId, id, patch);
        });
      }

      /* 条子是从**上面**插进流里的（它 append 在 .msg-wrap 之前），所以它一露面，
         消息区就矮一条子那么高、顶边也被推下去同样多 —— 结果是**用户眼前的
         这段对话整体往下滑 47px**（用户 2026-09-23：「聊天里面的多选，我点一个
         气泡之后页面就会下滑」；量过：进多选前 wrap.top=100，进了之后 147，
         参照气泡的屏幕坐标 109 → 156。**点气泡本身不动**，动的是这一下露面）。

         规矩：不管条子露不露面，眼前的内容都不许挪位。
         做法 = 拿高度差补 scrollTop —— 补完气泡的屏幕坐标原封不动；
         贴底时会被浏览器夹回新的最大值，也就是「仍然贴着底」，正是要的。 */
      function renderSelection() {
        var h0 = msgWrap.clientHeight;
        selBar.innerHTML = '';
        if (!selecting) {
          selBar.style.display = 'none';
          if (msgWrap.clientHeight !== h0) msgWrap.scrollTop += (h0 - msgWrap.clientHeight);
          return;
        }
        selBar.style.display = 'flex';
        /* 数的是**气泡**（选什么删什么，选中的每一条都挂着勾，数得出对应关系） */
        selBar.appendChild(h('span', 'msg-select-info', '已选 ' + selectedIds().length + ' 条'));

        var del = h('button', 'msg-select-act is-danger', '删除');
        del.type = 'button';
        del.addEventListener('click', async function () {
          var keys = selectedIds();
          if (!keys.length) return;
          var yes = await ui.confirm({
            title: '删除选中的 ' + keys.length + ' 条？',
            ok: '删除',
            danger: true
          });
          if (!yes) return;
          removeBubbles(keys.map(parseSelKey));
          exitSelect();
          ctx.toast('已删除 ' + keys.length + ' 条', 'ok');
        });

        var cancel = h('button', 'msg-select-act', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', exitSelect);

        selBar.appendChild(del);
        selBar.appendChild(cancel);

        /* 补回条子占掉的那点高度，眼前的内容原封不动（见函数开头那段注释）。
           ⚠️ 这句必须放在**所有**会改 selBar 高度的事情之后（现在是末尾，
           条子里只有一行字，改文案不改高度，但以后加了第二行就靠这句兜住）。 */
        if (msgWrap.clientHeight !== h0) msgWrap.scrollTop += (h0 - msgWrap.clientHeight);
      }

      /* ======================== 长按菜单 ========================
         菜单是**贴着被长按的那个气泡**弹出的浮层（ui.anchorPopover）。
         以前是自己搭的整宽底部动作表 + 全屏遮罩：必然铺满整屏、把消息
         全挡住，而且根本不贴被长按的那条（用户报的五.12）。
         浮层的关闭交给 anchorPopover（点外面 / ESC / 滚动出视野都收）。 */

      function openMenu(msg, seg, bubbleEl) {
        var idx = (seg && seg.idx !== undefined) ? seg.idx : null;
        var pop = ui.anchorPopover(bubbleEl, { className: 'msg-pop' });
        var list = h('div', 'msg-pop-list');

        var items = [
          { label: '引用', run: function () { startQuote(msg, idx); } },
          { label: '复制', run: function () { copyMsg(msg, idx); } },
          { label: '收藏', run: function () { favorite(msg, idx); } },
          { label: '编辑', run: function () { editMsg(msg, idx); } },
          /* 多选 / 删除都带上**这个气泡**：一条回复拆成几段时，
             用户在哪个气泡上长按，就该选中 / 删掉哪一个（2026-09-23）。 */
          { label: '多选', run: function () { enterSelect(msg.id, idx); } },
          { label: '删除', kind: 'danger', run: function () { removeMsg(msg, idx); } }
        ];
        /* 「朗读」（2.15）：只在角色的话、纯文字、且角色开着「长按给朗读」时出现。
           已经在长按的那一条上读了就写成「重读」—— 同一句话偶尔想再听一遍。 */
        if (Sleepy.tts && msg.role === 'assistant' && !msg.type &&
            Sleepy.tts.voiceConfigOf(curCharId()).manualRead) {
          items.splice(4, 0, {
            label: msg.voice ? '重读' : '朗读',
            run: function () { readAloud(msg, seg); }
          });
        }
        items.forEach(function (it) {
          var b = h('button', 'msg-pop-item' + (it.kind ? ' is-' + it.kind : ''), it.label);
          b.type = 'button';
          b.addEventListener('click', function () {
            pop.close();               /* 先收菜单再动作，免得弹层叠弹层 */
            it.run();
          });
          list.appendChild(b);
        });
        pop.el.appendChild(list);
        pop.place();
      }

      function closeMenu() { ui.closePopover(); }

      function startQuote(msg, idx) {
        var text = bubbleText(msg, idx);
        quote = {
          role: msg.role,
          content: text.slice(0, 140),
          /* 存下来源，方便以后「点引用条跳回原气泡」——
             以前只存 role + 正文，引用回喂给模型时也看不出引的是哪一句。 */
          msgId: msg.id,
          bubbleIndex: (idx === undefined) ? null : idx
        };
        renderQuote();
        textarea.focus();
        /* 这里原来弹一句「已引用这一句 · 输入框空着点发送就是让 TA 回这句」。
           2026-09-23 用户：「引用不要弹出 toast」—— 引用条本身就杵在输入框上方
           写着引了哪一句，再弹一个居中浮层纯属打扰（引用是高频动作）。 */
      }

      function clearQuote() {
        quote = null;
        renderQuote();
      }

      function renderQuote() {
        quoteBar.innerHTML = '';
        if (!quote) {
          quoteBar.style.display = 'none';
          return;
        }
        quoteBar.style.display = 'flex';
        quoteBar.appendChild(h('span', 'msg-quote-text',
          '引用' + (quote.role === 'user' ? '我' : '对方') + '：' + quote.content));
        var x = h('button', 'msg-quote-x', '\u00d7');
        x.type = 'button';
        x.title = '取消引用';
        x.addEventListener('click', clearQuote);
        quoteBar.appendChild(x);
      }

      function favorite(msg, idx) {
        /* 写入方：拿全量 → 改 → 整表落盘（不能拿过滤过的列表） */
        var list = store.get('favorites');
        if (!Array.isArray(list)) list = [];
        var c = getChat(chatId);
        var fav = {
          id: newId(),
          chatId: chatId,
          chatName: c ? c.name : '',
          role: msg.role,
          /* 收的是被点中的**那一个气泡**，不是整轮（同引用/复制） */
          content: bubbleText(msg, idx),
          savedAt: Date.now()
        };
        if (Sleepy.core && Sleepy.core.tagScope) Sleepy.core.tagScope(fav);
        list.unshift(fav);
        store.set('favorites', list);
        ctx.toast('已收藏，右上角 ★ 里能查到', 'ok');
      }

      async function editMsg(msg, idx) {
        if (msg.type) {
          ctx.toast('附件气泡先不支持编辑', 'warn');
          return;
        }
        var single = (idx !== null && idx !== undefined && msg.role === 'assistant');
        /* 用**多行**弹层编辑（以前是单行 input，长句子根本看不清 —— 用户五.15）。
           fields + multiline 是新加的支持，见 ui.js openDialog。 */
        var out = await ui.prompt({
          title: single ? '编辑这一句' : '编辑这条消息',
          ok: '保存',
          wide: true,
          fields: [{
            key: 'text', value: bubbleText(msg, idx),
            multiline: true, rows: 5, placeholder: '改这一句…'
          }]
        });
        if (out === null) return;
        var next = String((out && out.text) || '').trim();
        if (!next) {
          ctx.toast('内容不能为空', 'err');
          return;
        }

        if (!single) {
          patchMessage(chatId, msg.id, { content: next });
        } else {
          /* 只改被点中的那一段，再用 '||' 拼回去 —— 正文的存储格式就是
             `a || b || c`（见 prompt-engine 的 splitBubblesT）。
             以前是整条一起改，所以用户「编辑这一句」时看到的是整轮的分层结构。 */
          var arr = Sleepy.promptEngine.splitBubbles(msg.content || '');
          arr[idx] = next;
          var patch = { content: arr.join(' || ') };
          /* ⚠️ 译文是按**下标**对齐的（msg.trans[i] ↔ 第 i 个气泡），
             被改的那段译文已经对不上了，清掉它（别的段保留）。 */
          if (Array.isArray(msg.trans)) {
            var tr = msg.trans.slice();
            tr[idx] = null;
            patch.trans = tr;
          }
          patchMessage(chatId, msg.id, patch);
        }
        renderMessages();
        ctx.toast('已更新', 'ok');
      }

      function copyMsg(msg, idx) {
        var text = bubbleText(msg, idx);
        if (!text) return;
        copyText(text).then(
          function () { ctx.toast('已复制', 'ok'); },
          function () { ctx.toast('复制失败，浏览器没给权限', 'err'); }
        );
      }

      async function removeMsg(msg, idx) {
        /* 删的是**被长按的那一个气泡**，不是整条消息（用户 2026-09-23：
           「删除按钮是一次性删除了本次所有对话气泡而不是某个气泡」）。
           一条回复会被 || 拆成好几段，以前这里 dropMessages 整条 → 一次
           全没了。现在只在多气泡时才问「这一句」，一段话的附件气泡照旧
           问「这条消息」。删掉最后一段才真删消息（见 removeBubbles）。 */
        var many = msg.role === 'assistant' && !msg.type && bubbleSegs(msg).length > 1;
        var yes = await ui.confirm({
          title: many ? '删掉这一句？' : '删掉这条消息？',
          ok: '删除',
          danger: true
        });
        if (!yes) return;
        removeBubbles([{ id: msg.id, idx: (idx === undefined || idx === null) ? 0 : idx }]);
        renderMessages();
        ctx.toast('已删除', 'ok');
      }

      /* ==================== 发送 / 接收 / reroll ==================== */

      function buildMessages(opts) {
        opts = opts || {};
        var c = getChat(chatId);
        if (!c) return [];

        /* 上下文条数：这个对话自己设了就用它的，否则跟随全局。
           回落规则统一在 Sleepy.api.contextLimit 里（预演页、心声共用同一份）。 */
        var limit = Sleepy.api.contextLimit(c);
        var out = [];

        c.messages.forEach(function (m) {
          if (opts.excludeId && m.id === opts.excludeId) return;
          /* system 消息是「换面具」这类事件条，不进常规历史 ——
             它们由 page-switch 的记忆认知层统一注入，混进历史会重复。
             掉马事件例外，它就是要被模型看见的那一条。 */
          if (m.role !== 'user' && m.role !== 'assistant') return;
          /* 没被察觉的查岗：TA 什么都不知道，连「有这么条消息」都不能看见 */
          if (m.type === 'checkin' && !m.noticed) return;

          var text = m.type ? attachText(m) : (m.content || '');
          if (!text) return;
          if (m.quote) {
            text = '（引用' + (m.quote.role === 'user' ? '我自己' : '你') +
                   '刚说的：“' + m.quote.content + '”）\n' + text;
          }
          /* 多模态读图：user 的照片带真图进请求（data URL 备好了才带，
             没备好先文字占位 + 异步补，下一轮就能看见）。 */
          if (m.type === 'photo' && m.role === 'user' && m.mediaId &&
              !visionBroken && !m.quote) {
            var imgData = imgDataCache[m.mediaId];
            if (imgData) {
              out.push({
                role: 'user',
                content: [
                  { type: 'text', text: text },
                  { type: 'image_url', image_url: { url: imgData } }
                ]
              });
              return;
            }
            preloadPhotoData(m.mediaId);
          }
          out.push({ role: m.role, content: text });
        });

        if (limit > 0 && out.length > limit) out = out.slice(-limit);

        /* ---- 预设注入引擎（第一轮，见 prompt-engine.js）----
           开关开着就整段交给引擎装配：I01 / 共享外壳 / F1 / 记忆认知层 /
           输出协议等 system 槽按矩阵顺序排好，历史原文垫底。
           opts.note（reroll 指令）和 opts.proactive 仍拼在最末 —— 它们
           语义上属于 U01 当前输入。引擎出问题时设置里可切回旧组装。 */
        if (Sleepy.promptEngine && Sleepy.promptEngine.isEngineOn()) {
          var built = Sleepy.promptEngine.assembleOnline({
            charId: c.characterId,
            userId: c.userId,
            history: out
          });
          /* 日记事件垫在历史后面 —— 它是刚发生的事，比历史都新 */
          var peek = diaryPeekMsg(c.characterId);
          if (peek) built.messages.push(peek);
          if (opts.note) {
            built.messages.push({
              role: 'user',
              content: '（请按这个要求重新说一遍上一条回复：' + opts.note + '）'
            });
          }
          /* 事件注（查岗被察觉等）：不是 reroll，是「刚发生了这件事，接住它」 */
          if (opts.eventNote) {
            built.messages.push({
              role: 'user',
              content: '（刚刚发生的事：' + opts.eventNote + '。请以 char 的身份自然地回应这件事。）'
            });
          }
          if (opts.proactive) built.messages.push({ role: 'user', content: proactiveHintFor(c) });
          return built.messages;
        }

        /* ---- 以下全部是旧组装路径（useEngine 关掉时的兜底，保持原样） ----
           顺序有意如此：
             1. 身份与认知边界（你现在是谁、知道多少）
             2. 掉马事件（刚刚发生了什么 —— 优先级最高，必须压在最前面）
             3. 记忆（带 [U → C] 四元组标签）
           都放在 slice 之后，所以不会被上下文条数截掉。 */
        if (Sleepy.switcher && Sleepy.switcher.compileSystemContext) {
          var sys = Sleepy.switcher.compileSystemContext(c.characterId, c.userId, limit);
          if (sys) out.unshift({ role: 'system', content: sys });
        }
        /* 表情包说明书：手上有哪些表情、想发的时候怎么写（[表情:名字]）。
           没有表情时不加这一段 —— 别平白多一段指令，模型容易照猫画虎瞎编。 */
        if (Sleepy.stickers && Sleepy.stickers.replySpec) {
          var spec = Sleepy.stickers.replySpec(stickerCtx());
          if (spec) out.unshift({ role: 'system', content: spec });
        }
        /* 发图说明：生图接口可用才注入（引擎路径走 genimg 槽，这里同步） */
        if (Sleepy.imggen && Sleepy.imggen.replySpec) {
          var gspec = Sleepy.imggen.replySpec();
          if (gspec) out.unshift({ role: 'system', content: gspec });
        }

        /* 心声跟主回复一起出：往最前面塞一条系统指令，要求模型把
           「没说出口的心里话」用 <心声>…</心声> 包在正文末尾。
           这样一轮聊天只发一次请求（上一版是聊完再补发一次，额度翻倍）。
           放在 slice 之后，所以不会被上下文条数截掉。 */
        /* 拍一拍说明书：一行就够 —— 动作是调味的，写多了模型会刷 */
        out.unshift({ role: 'system', content:
          '偶尔可以「拍一拍」对方：单独一行写 [拍一拍:后缀]（如 [拍一拍:脑袋]，后缀可省）。不要常用。' });

        var cfg = store.get('chatDefaults') || {};
        if (cfg.heartbeatAuto !== false && out.length) {
          out.unshift({ role: 'system', content: Sleepy.heartbeat.replySpec() });
        }

        if (opts.note) {
          out.push({
            role: 'user',
            content: '（请按这个要求重新说一遍上一条回复：' + opts.note + '）'
          });
        }
        var peekOld = diaryPeekMsg(c.characterId);
        if (peekOld) out.push(peekOld);
        if (opts.eventNote) {
          out.push({
            role: 'user',
            content: '（刚刚发生的事：' + opts.eventNote + '。请以 char 的身份自然地回应这件事。）'
          });
        }
        if (opts.proactive) out.push({ role: 'user', content: proactiveHintFor(c) });
        return out;
      }

      /* L4 召回先跑一步：装配（buildMessages）是同步的，所以召回结果只能先
         落进 memoryVec 的缓存里再装配。prefetch 自带超时 ——
         宁可这轮不召回，也不能把聊天卡住。 */
      function requestReply(opts) {
        opts = opts || {};
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }

        var c0 = getChat(chatId);
        var mv = Sleepy.memoryVec;
        if (mv && mv.prefetch && c0 && c0.characterId) {
          mv.prefetch(c0.characterId, c0.userId, recallQuery(c0), { sinceAt: recallFloor(c0) })
            .then(function () { runReply(opts); });
          return;
        }
        runReply(opts);
      }

      /* 最近两条（可能含刚发的这条）+ 当前输入 —— v5 §9.1 的查询构造，
         本地规则抽，不调模型。 */
      function recallQuery(c) {
        var lines = [];
        (c.messages || []).slice(-2).forEach(function (m) {
          if (m.role !== 'user' && m.role !== 'assistant') return;
          var t = String(m.content || '').trim();
          if (t) lines.push(t.slice(0, 300));
        });
        return Sleepy.memoryVec._pure.buildQuery(lines, '');
      }

      /* 近期原文窗口第一条的时间：比它更早的块才值得召回 ——
         窗口里的原文本来就在 prompt 里，再召回一遍会让模型当成两件事。 */
      function recallFloor(c) {
        var limit = Sleepy.api.contextLimit(c);
        var list = (c.messages || []).filter(function (m) { return m.content; });
        var start = list.slice(-limit)[0];
        return start ? (start.timestamp || 0) : 0;
      }

      /* L4 写入：把还没进向量库的消息块补上。**后台跑、不 await** ——
         它要调 embedding，绝不能挡着聊天；失败就留到下次再说
         （游标没推进，下一轮自然重试同一批）。 */
      function kickSweep() {
        var mv = Sleepy.memoryVec;
        if (!mv || !mv.sweep) return;
        setTimeout(function () {
          var c = getChat(chatId);
          if (!c || !c.characterId) return;
          mv.sweep(c.characterId, c.userId, c)['catch'](function () { /* 静默 */ });
        }, 0);
      }

      function runReply(opts) {
        var msgs = buildMessages(opts);
        if (!msgs.length) { ctx.toast('还没有可以接的话', 'warn'); return; }

        var mySeq = ++reqSeq;
        /* raw 是模型吐的全部内容（含心声标签）；信封正文一律走 pendingVisible() */
        pending = { raw: '', timestamp: Date.now(), targetId: opts.targetId || null };
        renderMessages();
        updateSendUI();

        /* 流式开关：这个对话自己设了就用它的，否则跟随全局。
           false 是有效值，所以判断必须用 != null，不能 || 兜底 */
        var ovNow = overridesOf(getChat(chatId));
        var useStream = (ovNow.stream != null) ? ovNow.stream
                      : (store.get('chatDefaults.stream') !== false);

        handle = api.runChat(msgs, {
          onDelta: function (delta) {
            if (mySeq !== reqSeq) return;
            pending.raw += delta;
            /* 流式热路径：以前每个 delta 都整页 renderMessages() ——
               innerHTML='' 把全部消息重画一遍，长对话接近 O(n²)。
               2026-09-26 用户再报「整条挤一个气泡、过一会儿才拆开」——
               拆段挪进流式：按 || 渐进拆，段数没变只改各段文本，
               段数变了才整页重画（一条回复顶多重画几次）。
               is-pending 气泡首帧就画好（类名、停止键都在身上）。 */
            var segs = pendingSegs();
            var lives = msgWrap.querySelectorAll('.msg-bubble.is-pending .msg-text');
            if (lives.length === (segs.length || 1)) {
              if (segs.length) {
                for (var pi = 0; pi < segs.length; pi++) lives[pi].textContent = segs[pi];
                msgWrap.scrollTop = msgWrap.scrollHeight;
              }
              /* 还在打字点（一段正文都没有）就不动 */
            } else {
              renderMessages();
            }
          },
          onDone: function (cand, text) {
            if (mySeq !== reqSeq) return;

            /* 这条回复最终挂在哪个气泡上 —— 它自带的心声要挂到同一处，
               reroll 时才知道该删哪条（见下面 commit 那段）。 */
            var replyMsgId = null;

            /* 正文和心声在同一次输出里，这里一刀切开
               （parseReply 同时认 [WHISPER] 与旧 <心声>，见 splitReplyOf） */
            var split = splitReplyOf(text);
            var finalText = split.visible.trim();
            /* 译文：解析时已经从气泡里抽出来了（按索引对齐 bubbles）。
               它**不进 content** —— 正文只留原文，回给模型的上下文才是干净的。 */
            var transArr = Array.isArray(split.trans) ? split.trans : [];
            var target = pending ? pending.targetId : null;
            pending = null;
            handle = null;

            /* 角色也能发表情：先把正文里的 [表情:名字] 抽出来，
               正文里那一段就去掉（不然屏幕上会杵着一个标签）。 */
            var st = extractStickers(finalText);
            finalText = st.text;

            /* 拍一拍标签同样抽掉（[拍一拍] / [拍一拍:后缀]） */
            var pt = extractPats(finalText);
            finalText = pt.text;

            /* [生图:描述] 同样抽掉 —— TA 想发照片，正文里不出现标签 */
            var gi = extractGenimgs(finalText);
            finalText = gi.text;

            /* 收藏提议标签同样抽掉（[收藏提议:id|kind|理由]，We 收藏馆 P2）——
               落成 weProposals 待确认 + 一张卡片消息，正文/心声里不出现标签 */
            var wp = extractProposal(finalText);
            finalText = wp.text;
            /* 协议只许把提议写在正文；模型真塞进心声里的话，从心声剥掉
               （标签不得留在心声里），并并入提议（正文没有提议时才生效） */
            if (split.whisper) {
              var wpx = extractProposal(split.whisper);
              if (wpx.hit && !wp.hit) wp = wpx;
              split.whisper = wpx.text;
            }

            /* 手机痕迹（查手机第 2 批）：抽出 [手机] 行、校验、落库。
               实现在 applyPhoneTrace 里（导出给冒烟走真实路径）——
               别把这段逻辑挪回这里：这里的作用域没有 chat 变量，
               曾经因此静默丢掉全部痕迹（见该函数注释）。 */
            var trace = applyPhoneTrace(chatId, finalText);
            finalText = trace.text;
            var pdApplied = trace.applied;
            var granted = trace.granted;

            if (!finalText && !st.names.length && !pt.patted && !gi.descs.length &&
                !wp.hit && !pdApplied) {
              ctx.toast('这次没出声，要不再试一次？', 'warn');
              renderMessages();
              updateSendUI();
              return;
            }

            if (finalText) {
              /* 先记住这条消息的 id —— 语音（2.15）要挂在它身上 */
              var voiceMsgId = target;
              /* memoryId 挂在消息上：reroll 时按它把这条回复从记忆库删掉 */
              var memRec = commitMemory(chatId, 'assistant', finalText);
              var memId = memRec ? memRec.id : null;
              if (target) patchMessage(chatId, target, { content: finalText, trans: transArr, timestamp: Date.now(), memoryId: memId });
              else {
                voiceMsgId = newId();
                addMessage(chatId, {
                  id: voiceMsgId,
                  role: 'assistant',
                  content: finalText,
                  trans: transArr,
                  timestamp: Date.now(),
                  memoryId: memId
                });
              }
              replyMsgId = voiceMsgId;
              /* 语音（2.15）：按这件角色的语音设置决定要不要自动读一句。
                 放在和总结/查手机/主动消息**同一位置** —— 都不阻塞聊天，
                 失败静默（自动语音失败绝不该弹红字打扰聊天）。 */
              if (Sleepy.tts) maybeAutoVoice(voiceMsgId, finalText);
              /* 总结引擎（v5 10.1）：回复落地后检查累计阈值，
                 够了就后台整理，不阻塞聊天（失败静默，游标不动下轮再试） */
              if (Sleepy.summaryEngine) Sleepy.summaryEngine.onChatTurn(chatId);
              /* 离屏生活结算（查手机第 2 批）：闸门（自主生活档位 + 最短间隔）
                 通过才后台跑，失败静默 —— 同总结引擎的规矩 */
              if (Sleepy.phoneAI) Sleepy.phoneAI.onChatTurn(chatId);
              /* 主动消息引擎：回复落地后扫一遍当前岛的其他角色
                 （引擎自带节流和资格闸门，这里只管喊一声） */
              if (Sleepy.proactiveEngine) Sleepy.proactiveEngine.sweep();
              /* ta 已成立的影响（第五批）：这一轮**注入过**的影响，到此刻才算
                 「角色已经有过反应」（只记第一次，幂等）。放在和总结/主动消息
                 同一位置 —— 都不阻塞聊天；失败静默：ta 出问题不影响聊天。 */
              if (Sleepy.taImpact) {
                try {
                  var tiChat = getChat(chatId);
                  if (tiChat && tiChat.characterId) Sleepy.taImpact.noteReply(tiChat.characterId);
                } catch (e) { /* 静默 */ }
              }
            } else if (target) {
              /* 正文被表情吃光了，而屏幕上已经有一条占位消息 ——
                 把它删掉，只留表情（不然会剩下一个空气泡）。 */
              dropMessages(chatId, [target]);
            }

            /* 表情排在正文后面（它多半是「说完话顺手甩一张」） */
            st.names.forEach(function (nm) { charSendSticker(nm); });
            if (pt.patted) charSendPat(pt.suffix);
            /* TA 发的图排在表情后面，一次最多 2 张防刷 */
            gi.descs.slice(0, 2).forEach(function (desc) { charSendPhoto(desc); });
            /* 收藏提议排在图后面（We 收藏馆 P2）：创建 proposal（校验/去重/
               来源核验都在 weProposals 里，失败静默）+ 落一张待确认卡片。
               originMessageId 挂这条回复 —— reroll 复用同一 msg.id，天然防重。 */
            if (wp.hit) commitProposal(chatId, replyMsgId || target, wp.hit);
            /* 他主动递手机的邀请卡排在最后 —— 权限已落 phonePerms，
               「查手机」入口会显示「已向你开放」（分流定案 §二·B） */
            if (granted) {
              addMessage(chatId, {
                id: newId(), role: 'assistant', type: 'phone-invite',
                content: granted.note || '他把手机递到了你手里。',
                permScope: granted.scope, permMode: granted.mode,
                timestamp: Date.now()
              });
            }
            renderMessages();
            updateSendUI();

            /* 心声是这条回复自带的，入库即可 —— 不需要再发一次请求。
               模型没写标签就什么都不发生，属于正常情况。
               hbId 挂在同一口气泡上，reroll 时才删得掉这条心声。 */
            if (split.whisper && split.whisper.trim()) {
              var hbRec = Sleepy.heartbeat.commit(chatId, split.whisper);
              if (hbRec && hbRec.id && replyMsgId) {
                patchMessage(chatId, replyMsgId, { hbId: hbRec.id });
              }
            }
            /* 这一轮聊完了 → 后台把它索引进向量库（L4，不挡聊天） */
            kickSweep();
          },
          /* 注意：runChat 暴露的是 onFail（全部候选都失败 / 一个候选都没有），
             不是 onError。写成 onError 的话没有任何回调会被触发，
             发送键会永久卡在禁用状态。api.js 头部的契约注释里写的就是 onFail。 */
          onFail: function (list, err) {
            if (mySeq !== reqSeq) return;
            /* 多模态熔断：接口看不了图（报错提到 image/vision）就退回文字占位，
               并提示一次 —— 不然每轮都为同一件事报错。会话级，重启恢复。 */
            var detail = String((err && err.detail) || '') + String((err && err.error) || '');
            if (!visionBroken && /image|vision|multimodal|图片|多模态/i.test(detail)) {
              visionBroken = true;
              ctx.toast('这个接口好像看不了图，已退回文字占位', 'warn');
            }
            pending = null;
            handle = null;
            var why = (err && err.error) ? err.error : '请求失败，检查一下网络或 API 配置';
            ctx.toast('❌ ' + why, 'err');
            renderMessages();
            updateSendUI();
          }
        }, useStream, ovNow);
      }

      function stopReply() {
        if (!pending) return;

        /* 手动停止时只保留正文；心声标签里的内容可能是半截的，
           只有整段标签已经闭合（模型写完了）才收下。 */
        var split = splitReplyOf(pending.raw);
        var partial = split.visible.trim();
        var beat = (split.closed && split.whisper) ? split.whisper : '';
        var target = pending.targetId;
        var stoppedMsgId = target;      /* 半截回复挂在哪个气泡上，心声就跟到哪 */

        reqSeq++;                       /* 让在途回调统统失效 */
        if (handle) { try { handle.abort(); } catch (e) { /* 忽略 */ } }
        handle = null;
        pending = null;

        if (partial) {
          /* 半截回复里可能已经带着 [表情:…] 标签了 —— 去掉，但**不补发**
             （用户是主动停的，别再给他弹东西出来）。 */
          var pSt = extractStickers(partial);
          var pText = pSt.text;
          /* 收藏提议标签同样剥掉（P2）。提议动作本身已经完成，照常落库 ——
             收不收由 user 在卡片上决定，与「不补发表情」不冲突。 */
          var pWp = extractProposal(pText);
          pText = pWp.text;
          var memRec = commitMemory(chatId, 'assistant', pText);
          var memId = memRec ? memRec.id : null;
          if (target) patchMessage(chatId, target, { content: pText, timestamp: Date.now(), memoryId: memId });
          else {
            stoppedMsgId = newId();
            addMessage(chatId, {
              id: stoppedMsgId,
              role: 'assistant',
              content: pText,
              timestamp: Date.now(),
              memoryId: memId
            });
          }
        } else if (target) {
          patchMessage(chatId, target, { content: '（这条被停掉了）' });
        }

        /* 手动停止时提议也照常落库（剥标签已在上面做完）——
           卡片挂在这条（半截）回复上，收不收仍由 user 决定 */
        if (pWp && pWp.hit) {
          commitProposal(chatId, stoppedMsgId || target || null, pWp.hit);
        }

        if (beat.trim()) {
          var hbRec = Sleepy.heartbeat.commit(chatId, beat);
          if (hbRec && hbRec.id && stoppedMsgId) {
            patchMessage(chatId, stoppedMsgId, { hbId: hbRec.id });
          }
        }

        renderMessages();
        updateSendUI();
        ctx.toast('已停止', 'ok');
      }

      async function startReroll(msg) {
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }
        var reason = await ui.prompt({
          title: '想怎么改？',
          note: '留空就是直接重说一遍。',
          value: '',
          ok: '重说'
        });
        if (reason === null) return;
        var note = String(reason).trim();

        /* 「重说」要真的重说：buildMessages 已经用 excludeId 把这条原文
           剔出历史了，但**记忆库**里那条还在 —— 模型读到自己上一版的答案，
           就会顺着往下讲（用户报的「像是继续说」）。
           落库时把 memoryId / hbId 挂在消息上（见 onDone / stopReply），
           这里按 id 精确删掉。
           老消息身上没记 hbId 的退路：被 reroll 的必然是最后一条助手消息，
           所以删「at >= 它的那条心声」是安全的。 */
        if (msg.memoryId && Sleepy.core && Sleepy.core.dropMemories) {
          Sleepy.core.dropMemories(function (m) { return m.id === msg.memoryId; });
        }
        if (Sleepy.heartbeat) {
          if (msg.hbId && Sleepy.heartbeat.drop) {
            Sleepy.heartbeat.drop(chatId, msg.hbId);
          } else if (msg.timestamp && Sleepy.heartbeat.dropLastAfter) {
            Sleepy.heartbeat.dropLastAfter(chatId, msg.timestamp);
          }
        }

        patchMessage(chatId, msg.id, { content: '', memoryId: null, hbId: null });
        requestReply({ excludeId: msg.id, targetId: msg.id, note: note });
      }

      function doSend() {
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }

        var content = textarea.value.trim();

        /* 发送键是**两义**的（D1 + 2026-09-21 修订）：
           空着点 = 让角色开口说话（不是发一个空气泡）；
           有字点 = 只把这条发出去，**不**触发回复。
           这样才可能「分气泡连发几条」—— 见下面正文那段末尾的说明。 */
        if (!content) {
          requestReply({ proactive: true });
          return;
        }

        var msg = {
          id: newId(),
          role: 'user',
          content: content,
          timestamp: Date.now()
        };
        if (quote) {
          /* 连带来源一起记（msgId + 气泡下标）—— 以前只存 role + 正文，
             整轮拼起来的那一串进来之后就分不清引的是哪一句了 */
          msg.quote = {
            role: quote.role, content: quote.content,
            msgId: quote.msgId || null, bubbleIndex: (quote.bubbleIndex === undefined ? null : quote.bubbleIndex)
          };
        }

        addMessage(chatId, msg);
        commitMemory(chatId, 'user', content);
        textarea.value = '';
        autoGrow();
        clearQuote();
        renderMessages();
        /* ⚠️ 这里**故意不请求回复**（2026-09-21 改）。
           发送键是两义的：有字 = 只发送一条，空着点 = 让角色开口。
           以前这里直接 requestReply({})，于是「我说一句他立刻回一句」——
           想分气泡连发几条根本做不到（第一条发出去回复就开始跑，
           后面几条只能等他回完）。用户要的是：想说几句就说几句，
           说完了把输入框清空再点一次发送，才让他开口。 */
      }

      /* ======================== 加号面板 ======================== */

      function pickAttachment(accept, kind) {
        var input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.style.display = 'none';
        input.addEventListener('change', function () {
          var f = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (!f) return;

          /* 照片要**先把本体存进图库**再落消息 ——
             只存个文件名的话，这条消息就永远只是一行字（以前就是这样）。
             压缩 + 入库是异步的，期间先别关面板，免得用户以为没反应。 */
          if (kind === 'photo' && Sleepy.media) {
            Sleepy.media.available().then(function (yes) {
              if (!yes) { send(); return; }
              Sleepy.media.shrink(f).then(function (r) {
                return Sleepy.media.put(r.blob, {
                  name: f.name, kind: 'photo', w: r.w, h: r.h
                }).then(function (id) {
                  /* 真图提前备进多模态缓存：下一轮 TA 就能「看见」这张照片 */
                  cachePhotoData(id, r.blob);
                  send({ mediaId: id, w: r.w, h: r.h, size: r.blob.size, mime: r.blob.type });
                });
              }).then(null, function () {
                /* 存不进图库（配额满 / 解码失败）→ 退成只记名字的附件，
                   至少消息本身别丢 */
                ctx.toast('这张图没能存进图库', 'warn');
                send();
              });
            });
            return;
          }
          send();

          function send(extra) {
            extra = extra || {};
            addMessage(chatId, {
              id: newId(),
              role: 'user',
              type: kind,
              name: f.name,
              size: extra.size || f.size,
              mime: extra.mime || f.type || '',
              mediaId: extra.mediaId || null,
              w: extra.w || 0,
              h: extra.h || 0,
              content: (kind === 'photo' ? '[照片] ' : '[文件] ') + f.name,
              timestamp: Date.now()
            });
            closePanel();
            renderMessages();
            ctx.toast(kind === 'photo' ? '照片发出去了' : '文件发出去了', 'ok');
          }
        });
        document.body.appendChild(input);
        input.click();
      }

      /* ---- 拍一拍（两个方向） ----

        user 拍角色：+ 面板点一下，落一条 type:'pat' 的灰字。
        角色下一轮会从上下文里看到自己被拍了（attachText），自然接得住。

        角色拍 user：模型在回复里单独写 [拍一拍:后缀]（说明书见 buildCtx），
        onDone 里抽出来落成灰字 —— 和 [表情:名字] 完全同一套机制。 */
      function patChar() {
        var c = getChat(chatId);
        var ch = findCharacter(c ? c.characterId : null);
        var nm = ch ? ch.name : '对方';
        addMessage(chatId, {
          id: newId(),
          role: 'user',
          type: 'pat',
          content: '你拍了拍「' + nm + '」',
          timestamp: Date.now()
        });
        closePanel();
        renderMessages();
      }

      function charSendPat(suffix) {
        var c = getChat(chatId);
        var ch = findCharacter(c ? c.characterId : null);
        var nm = ch ? ch.name : '对方';
        addMessage(chatId, {
          id: newId(),
          role: 'assistant',
          type: 'pat',
          content: '「' + nm + '」拍了拍你' + (suffix ? '的' + suffix : ''),
          timestamp: Date.now()
        });
        renderMessages();
      }

      /* 转账。一次 prompt 收「金额 + 备注」（见 parseTransfer 的注释）。
         结果落成一条 `type:'transfer'` 的正式消息，不是伪装成 system 的文字。 */
      function openTransfer() {
        var cur = getChat(chatId) || {};
        var ch = findCharacter(cur.characterId);
        var who = ch ? ch.name : '对方';
        /* 备注单独一个框（用户 00:19 批的）：挤在一个输入里写「68 买奶茶」
           太费劲 —— 备注是正经内容，该有自己的格子。
           金额照旧走 parseTransfer 校验，输入框里只写数字。 */
        ui.prompt({
          title: '转给「' + who + '」',
          note: '一次最多 ' + TRANSFER_MAX + ' 元',
          ok: '转过去',
          fields: [
            { key: 'amount', label: '金额', placeholder: '68' },
            { key: 'note', label: '备注（可不填）', placeholder: '买奶茶' }
          ]
        }).then(function (v) {
          if (!v) return;
          var p = parseTransfer(v.amount);
          if (!p.ok) { ctx.toast(p.message, 'err'); return; }
          var note = String(v.note || '').trim().slice(0, 30);
          addMessage(chatId, {
            id: newId(),
            role: 'user',
            type: 'transfer',
            amount: p.amount,
            note: note,
            content: transferText({ amount: p.amount, note: note }),
            timestamp: Date.now()
          });
          closePanel();
          renderMessages();
          ctx.toast('转了 ¥' + p.amount.toFixed(2), 'ok');
        });
      }

      var PLUS_ITEMS = [
        { id: 'photo', svg: PLUS_ICON.photo, name: '发照片', run: function () { pickAttachment('image/*', 'photo'); } },
        { id: 'file', svg: PLUS_ICON.file, name: '发文件', run: function () { pickAttachment('', 'file'); } },
        { id: 'transfer', svg: PLUS_ICON.transfer, name: '转账', run: openTransfer },
        { id: 'pat', svg: PLUS_ICON.pat, name: '拍一拍', run: function () { patChar(); } },
        { id: 'genimg', svg: PLUS_ICON.genimg, name: '生图', run: function () { openGenSheet(); } },
        { id: 'checkin', svg: PLUS_ICON.checkin, name: '查岗', run: function () { runCheckin(); } },
        { id: 'diary', svg: PLUS_ICON.diary, name: '日记', run: function () { closePanel(); ctx.open('diary', {}); } },
        /* 翻译开关（用户 2026-09-19：「翻译开关放在加号面板吧」）。
           它是 **toggle**，不关面板 —— 想边看译文边点其他的很正常。
           开关只决定「要不要看译文」；他说不说外语由常驻地点决定。 */
        { id: 'translate', svg: PLUS_ICON.translate, name: '翻译',
          toggle: true,
          get: function () { return !!(Sleepy.calendar && Sleepy.calendar.translateOn()); },
          /* 他说中文时这一项用不上（语言由常驻地点推，见 calendar.langOf） */
          naCheck: function () {
            var cur = getChat(chatId);
            return !needsTrans(cur);
          },
          run: function () {
            var on = !(Sleepy.calendar && Sleepy.calendar.translateOn());
            if (Sleepy.calendar) Sleepy.calendar.setTranslateOn(on);
            ctx.toast(on ? '译文打开了' : '不看译文了', on ? 'ok' : '');
            renderMessages();
          } }
        /* 表情包挪到了输入框左下角的笑脸 —— 不在加号面板里了 */
      ];

      /* ======================== 查岗 ========================

         偷偷看一眼 TA 现在在做什么：
           ① 主 API 依「人设 + 日程感 + 近期上下文 + 现在时间」出一个画面
             （JSON：subject 是生图 tag，caption 是一句中文）
           ② imggen 把画面画出来（锁脸走 char.faceLock）
           ③ 图落成 user 侧的 checkin 消息
           ④ 程序掷骰 40%：被察觉 → 上下文保留这条消息（attachText 告诉 TA
             有人看了），并自动触发一次回应；没察觉 → 这条消息整条从
             上下文里过滤掉，TA 永远不知道（ suspense 留给你自己品） */
      function runCheckin() {
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
        if (!Sleepy.imggen || !Sleepy.imggen.activeApi()) {
          ctx.toast('先去 设置 → 生图 配一个生图接口', 'warn');
          return;
        }
        closePanel();
        ctx.toast('正在悄悄看一眼…', 'ok');

        directorAsk('checkin', ch, c, '').then(function (d) {
          if (!d.ok) { ctx.toast(d.error || '想画面的时候出错了', 'err'); return; }

          /* 40% 被察觉 —— 程序掷骰，不问模型（模型会说谎式讨好） */
          var noticed = Math.random() < 0.4;

          /* B0：查岗画的是「TA 此刻在做什么」—— 主体是 char 还是纯场景
             由导演的 subjects 决定，不再默认锁 char（TA 可能不在镜头里）。
             导演没按新格式答 → legacyFallback，走老路（锁 char + scene 组）。 */
          var plan = planFromDirector(d, ch, c, 'user');
          var genReq = plan ? { plan: plan }
            : { subject: d.subject, faceText: Sleepy.imggen.faceTextFor(ch, 'scene'), gender: ch };

          return Sleepy.imggen.generate(genReq).then(function (r) {
            if (!r.ok) {
              ctx.toast(r.error.message || '生图失败了', 'err');
              return;
            }
            cachePhotoData(r.mediaId, r.blob);
            addMessage(chatId, {
              id: newId(),
              role: 'user',
              type: 'checkin',
              mediaId: r.mediaId || '',
              url: r.url || '',
              subject: plan ? plan.description : d.subject,
              caption: d.caption,
              plan: plan || null,
              noticed: noticed,
              content: d.caption,
              timestamp: Date.now()
            });
            renderMessages();
            if (noticed) {
              ctx.toast('……TA 好像察觉到了', 'warn');
              requestReply({
                eventNote: '有人「查岗」——刚刚偷偷看了一眼你此刻在做什么，还看见了：' + d.caption +
                  '。你察觉到了那道视线。请按人设自然地回应被看见这件事（害羞/得意/心虚/坦荡都可以）。'
              });
            }
          });
        });
      }

      /* ======================== 生图（方案-生图 v2） ========================

         导演请求（三种共用一个出口）：
           checkin   TA 不知道被看，画面 = TA 此刻在做什么
           charPhoto TA 发图：可拒绝（refuse = TA 的原话，只落文字）
           userTag   把 user 的中文意图转成英文 tag（我发一张） */
      function directorAsk(kind, ch, c, intent) {
        var main = store.get('mainApi');
        if (!(main && main.enabled && main.baseUrl && main.model)) {
          return Promise.resolve({ ok: false, error: '生图需要主 API 来想画面' });
        }
        var now = new Date();
        var nowLine = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
          ('0' + now.getDate()).slice(-2) + ' ' + ('0' + now.getHours()).slice(-2) + ':' +
          ('0' + now.getMinutes()).slice(-2);
        var recent = (c.messages || []).slice(-10).map(function (m) {
          if (m.type === 'checkin' && !m.noticed) return '';
          var who = m.role === 'user' ? '你' : ch.name;
          return who + '：' + String(m.type ? attachText(m) : (m.content || '')).slice(0, 80);
        }).filter(Boolean).join('\n');
        var chBlock = ch.content ? '[CHARACTER]\n' + ch.content + '\n[/CHARACTER]' : '';
        var ctxLine = '[现在时间] ' + nowLine + '\n[近期聊天]\n' + (recent || '（今天还没聊过）');

        var sys, user;
        if (kind === 'checkin') {
          sys = [
            '你是画面导演，为一次「查岗」决定画面内容。',
            '「查岗」= user 偷偷看一眼 char 此刻正在做什么（char 不知道被看）。',
            chBlock,
            '【任务】结合角色设定（身份/作息/生活半径）、下面的近期聊天、和现在的时间，想象 char 此刻正在做什么，输出一个静态画面。',
            '画面只属于 char 自己的生活场景（在家/在工作/在买东西/在路上……），不要出现 user，不要出现对话框或手机屏幕。',
            '【输出】只返回一个 JSON：{"description":"画面内容，英文 Danbooru 风格 tag，包含角色特征、服装、动作、场景、时间氛围","contentType":"scene|object|person|mixed","shot":"auto|selfie|portrait|full|candid|group|scene","subjects":["char"],"caption":"一句不超过 20 字的中文，说明你看到了什么"}',
            '【subjects 规则】只写画面里真实出现的人：TA 在镜头里写 ["char"]；TA 不在（只拍到房间/桌面/窗外）就 []。',
            '只输出 JSON 本体，不要解释。'
          ].filter(Boolean).join('\n\n');
          user = ctxLine;
        } else if (kind === 'charPhoto') {
          sys = [
            '你现在是「' + ch.name + '」本人，准备给对方发一张照片。',
            chBlock,
            '【任务】对方想让你发一张照片' + (intent ? '，意图：' + intent : '，没说具体想看什么——发一张你自己此刻愿意分享的') +
              '。结合你的人设、此刻状态和近期聊天，决定拍什么（自拍/给对方拍一张/眼前的食物、宠物、景物都可以）。',
            '【你也可以拒绝】按人设，如果你不爱自拍、正在忙、或不愿意发，可以拒绝——refuse 填你拒绝的原话（口语，符合人设），其余字段留空字符串或空数组。',
            '【输出】只返回一个 JSON：{"description":"画面内容，英文 Danbooru 风格 tag（1girl/1boy + 服装 + 动作 + 场景；自拍要带 selfie）","contentType":"scene|object|person|mixed","shot":"auto|selfie|portrait|full|candid|group|scene","subjects":["user","char"],"caption":"发图时配的一句话，口语","refuse":""}',
            '【subjects 规则】画面里真实出现谁就写谁：你自己出镜写 "char"，镜头对准对方写 "user"，合影写 ["user","char"]，食物/宠物/路景就 []——发什么由你定，不一定是自拍。',
            '只输出 JSON 本体，不要解释。'
          ].filter(Boolean).join('\n\n');
          user = ctxLine;
        } else {
          sys = [
            '你是画面导演：把 user 的一句中文画面意图，转成一张图的英文 Danbooru 风格 tag 描述。',
            '保留原意的主体、动作、场景、氛围；补齐画面需要的要素（视角/光线/构图）。',
            '【输出】只返回一个 JSON：{"description":"英文 Danbooru 风格 tag 画面描述","contentType":"scene|object|person|mixed","shot":"auto|selfie|portrait|full|candid|group|scene","subjects":["user","char"],"caption":"一句不超过 15 字的中文图注"}',
            '【subjects 规则】画面里真实出现谁就写谁："user"=发图的我，"char"=' + ch.name + '；两个都在就都写；纯风景/物品/宠物就 []。',
            '只输出 JSON 本体，不要解释。'
          ].join('\n');
          user = '[画面意图] ' + (intent || '');
        }

        return api.requestOnce({ source: 'main', cfg: main }, [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ], {}).then(function (res) {
          if (!res.ok) return { ok: false, error: api.describeError(res) };
          /* B0：导演改吐结构化结果（description/contentType/shot/subjects）。
             模型没按新格式来（还是裸 subject）→ legacyFallback=true，
             调用方回退旧 subject 逻辑，页面不报错不中断。 */
          var out = { ok: true, subject: '', caption: '', refuse: '',
            description: '', contentType: '', shot: '', subjects: [],
            legacyFallback: true };
          try {
            var t = String(res.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
            var i = t.indexOf('{'), j = t.lastIndexOf('}');
            if (i >= 0 && j > i) {
              var obj = JSON.parse(t.slice(i, j + 1));
              out.subject = String((obj && obj.subject) || '').trim().slice(0, 400);
              out.caption = String((obj && obj.caption) || '').trim().slice(0, 40);
              out.refuse = String((obj && obj.refuse) || '').trim().slice(0, 120);
              out.description = String((obj && obj.description) || '').trim().slice(0, 400);
              if (obj && ['scene', 'object', 'person', 'mixed'].indexOf(obj.contentType) >= 0) {
                out.contentType = obj.contentType;
              }
              if (obj && ['auto', 'selfie', 'portrait', 'full', 'candid', 'group', 'scene'].indexOf(obj.shot) >= 0) {
                out.shot = obj.shot;
              }
              if (obj && Array.isArray(obj.subjects)) {
                /* subjectsDeclared：白名单过滤**之前**的原始声明数 ——
                   正式拼接器拿它严格对账，非法引用也算「解析不了的人」 */
                out.subjectsDeclared = obj.subjects.length;
                out.subjects = obj.subjects.filter(function (x, idx) {
                  return (x === 'user' || x === 'char') && out.subjects.indexOf(x) < 0;
                });
              }
              out.legacyFallback = !(out.description || out.subjects.length);
            }
          } catch (e) { /* 解析不动走兜底 */ }
          if (!out.subject && !out.description && !out.subjects.length && !out.refuse) {
            if (kind === 'checkin') {
              out.subject = ch.name + ', casual daily life, indoor';
              out.caption = '看到了 TA 的日常一幕';
            } else if (kind === 'userTag') {
              out.subject = String(intent || '').trim();
              out.caption = String(intent || '').trim().slice(0, 15);
            } else {
              return { ok: false, error: '这次没想出画面' };
            }
          }
          return out;
        }, function () {
          return { ok: false, error: '想画面的时候出错了' };
        });
      }

      /* 导演结果 → ImagePlan（B0）。subjects 里的 'char'/'user' 字符串
         映射成真实实体（带 id / 锁脸 / 性别）；sender 由调用方按业务填 ——
         发送者和画面主体在这里正式分家。legacyFallback（模型没按新格式答）
         返回 null，调用方走旧 subject 逻辑。 */
      function planFromDirector(out, ch, c, sender) {
        if (!out || out.legacyFallback || out.refuse) return null;
        var shot = out.shot || 'auto';
        var KC = Sleepy.core;
        var subUser = (c && c.userId && KC && KC.findUser ? KC.findUser(c.userId) : null) ||
          (KC && KC.activeUser ? KC.activeUser() : null);
        var subs = [];
        (out.subjects || []).forEach(function (k) {
          if (k === 'char' && ch) subs.push(Sleepy.imggen.subjectForChar(ch, shot));
          else if (k === 'user' && subUser) subs.push(Sleepy.imggen.subjectForUser(subUser, shot));
        });
        return {
          sender: sender,
          contentType: out.contentType || (subs.length ? 'person' : 'scene'),
          shot: shot,
          subjects: subs,
          description: out.description || out.subject || '',
          /* 正式接入（2026-10-01）：模型**解析前**声明的主体数随 plan 对账 ——
             声明与解析数不等（少人 / 多人 / 非法引用）都明确报错零请求，
             不静默换人、减员或降级成无人图（返修单 v2 §5：严格相等）。
             未声明（legacyFallback 等）→ undefined，不做人数对账。 */
          expectedSubjectCount: (out.subjectsDeclared != null)
            ? out.subjectsDeclared : undefined
        };
      }

      /* 生成 + 落消息（生图弹层 / TA 主动发图 / 重画 共用）。
         opts: { plan?, subject, shot, caption, as: 'user'|'assistant', replaceId?, name?, preset? }
         plan = ImagePlan（B0）：带 plan 时按 plan 生成，as 只管落谁的气泡；
         preset = 已生成好的一张 {mediaId, blob, url, plan?}（弹层「发送」用，
         不再花一次生成费）。plan 存进消息，重画时不用重猜画面主体。 */
      function genAndDeliver(ch, opts) {
        var genP = opts.preset
          ? Promise.resolve({ ok: true, mediaId: opts.preset.mediaId, blob: opts.preset.blob, url: opts.preset.url })
          : (opts.plan
            ? Sleepy.imggen.generate({ plan: opts.plan })
            : Sleepy.imggen.generate({
                subject: opts.subject,
                faceText: opts.as === 'assistant'
                  ? Sleepy.imggen.faceTextFor(ch, opts.shot) : '',
                gender: opts.as === 'assistant' ? ch : null
              }));
        return genP.then(function (r) {
          if (!r.ok) return r;
          cachePhotoData(r.mediaId, r.blob);
          var base = {
            mediaId: r.mediaId || '',
            url: r.url || '',
            subject: opts.subject,
            shot: opts.shot || '',
            plan: opts.plan || null
          };
          if (opts.replaceId) {
            base.timestamp = Date.now();
            patchMessage(chatId, opts.replaceId, base);
            return { ok: true, replaced: true };
          }
          /* 新生成的图顺手收进相册 —— 以前只写了 media（图库），相册里翻不到，
             想再找那张图只能回聊天记录里翻（用户 2026-09-23 报的）。
             重画（replaceId）不算新图，上面已经 return 掉了。 */
          if (Sleepy.photos && Sleepy.photos.add && r.mediaId) {
            try {
              Sleepy.photos.add([{
                mediaId: r.mediaId,
                caption: opts.caption || '',
                name: opts.name || opts.caption || '照片'
              }]);
            } catch (e) { /* 相册记不上不该拦这张图发出去 */ }
          }
          if (opts.as === 'assistant') {
            base.caption = opts.caption || '发给你一张照片';
            base.content = base.caption;
            base.id = newId();
            base.role = 'assistant';
            base.type = 'photo';
            base.timestamp = Date.now();
            addMessage(chatId, base);
          } else {
            base.id = newId();
            base.role = 'user';
            base.type = 'photo';
            base.name = opts.caption || opts.name || '照片';
            base.content = '[照片] ' + (opts.caption || opts.name || '照片');
            base.timestamp = Date.now();
            addMessage(chatId, base);
          }
          renderMessages();
          return { ok: true };
        });
      }

      /* TA 主动发图（回复里的 [生图:描述] 到这里落地）。
         B0：描述可以是一句话，也可以是结构化 JSON
         （{"description":…,"contentType":…,"shot":…,"subjects":["user","char"]}）——
         有 JSON 就按 plan 走（画面主体由 subjects 决定，TA 可以只发食物/路景）；
         还是一句话 → legacy：按旧正则猜 shot、默认锁 char。 */
      function charSendPhoto(desc) {
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch || !Sleepy.imggen || !Sleepy.imggen.activeApi()) return;
        var parsed = Sleepy.imggen.parsePlanJson(desc);
        var plan = null;
        if (parsed) {
          var KC = Sleepy.core;
          var subUser = (c.userId && KC && KC.findUser ? KC.findUser(c.userId) : null) ||
            (KC && KC.activeUser ? KC.activeUser() : null);
          var subs = [];
          parsed.subjects.forEach(function (k) {
            if (k === 'char') subs.push(Sleepy.imggen.subjectForChar(ch, parsed.shot));
            else if (k === 'user' && subUser) subs.push(Sleepy.imggen.subjectForUser(subUser, parsed.shot));
          });
          plan = {
            sender: 'char',
            contentType: parsed.contentType,
            shot: parsed.shot,
            subjects: subs,
            description: parsed.description,
            /* 正式接入：解析前声明数（含被白名单滤掉的非法引用）随 plan 对账 */
            expectedSubjectCount: (parsed.subjectsDeclared != null)
              ? parsed.subjectsDeclared : undefined
          };
        }
        genAndDeliver(ch, {
          plan: plan,
          subject: plan ? plan.description : desc,
          shot: plan ? '' : (/selfie|自拍/i.test(desc) ? 'selfie' : ''),
          caption: (plan ? plan.description : desc).slice(0, 30),
          as: 'assistant'
        }).then(function (r) {
          if (!r.ok) ctx.toast((r.error && r.error.message) || 'TA 想发图但没发出来', 'warn');
        });
      }

      /* 重画：同 subject 重新生成，原地替换（caption 不变）。
         B0：新消息上存了 plan → 按 plan 重画（主体不变）；老消息没 plan
         → legacy 老路（不迁移历史数据）。 */
      function redrawPhoto(msg) {
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch || !Sleepy.imggen || !Sleepy.imggen.activeApi()) return;
        ctx.toast('重画中…', 'ok');
        genAndDeliver(ch, {
          plan: msg.plan || null,
          subject: msg.subject,
          shot: msg.plan ? '' : (msg.shot || ''),
          caption: msg.caption || '',
          as: msg.role === 'assistant' ? 'assistant' : 'checkin',
          replaceId: msg.id
        }).then(function (r) {
          if (!r.ok) ctx.toast((r.error && r.error.message) || '重画失败了', 'err');
          else { ctx.toast('重画好了', 'ok'); renderMessages(); }
        });
      }

      /* ---- 生图弹层：我发一张 / 让 TA 发一张，先预览再发 ---- */
      function openGenSheet() {
        closePanel();
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
        if (!Sleepy.imggen || !Sleepy.imggen.activeApi()) {
          ctx.toast('先去 设置 → 生图 配一个生图接口', 'warn');
          return;
        }

        var mask = h('div', 'gen-sheet-mask');
        var card = h('div', 'gen-sheet');
        var tabs = h('div', 'gen-tabs');
        var bMe = h('button', 'gen-tab active', '我发一张');
        var bChar = h('button', 'gen-tab', '让 TA 发一张');
        bMe.type = bChar.type = 'button';
        tabs.appendChild(bMe);
        tabs.appendChild(bChar);

        var intent = h('textarea', 'gen-intent');
        intent.rows = 2;
        intent.placeholder = '想画什么，一句话就行（比如：便利店的深夜窗边）';

        /* B2 图片锁脸（2026-10-02 施工单 §2）：逐人开关，user 发起不等于自拍。
           底层就是「我」「TA」两个独立布尔；谁在画面里谁的有效（不在画面里的
           开关不产生参考图）。默认勾选状态读各自已保存的授权
           （faceLockImageOn），本次勾选只覆盖本次请求，不改资料。 */
        var core2 = Sleepy.core;
        var meMask = (c.userId && core2.findUser) ? core2.findUser(c.userId) : null;
        var meHasImg = !!(meMask && (meMask.faceLockImageMedia || meMask.faceLockImage));
        var chHasImg = !!(ch && (ch.faceLockImageMedia || ch.faceLockImage));
        var lockRow = h('div', 'gen-locks');
        lockRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;margin:2px 0 6px;';
        function lockToggle(label, rec) {
          var lb = h('label');
          lb.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;';
          var cb = h('input');
          cb.type = 'checkbox';
          cb.checked = !!(rec && rec.faceLockImageOn);
          lb.appendChild(cb);
          lb.appendChild(h('span', '', label));
          var hint = h('span', '', (!rec || !(rec.faceLockImageMedia || rec.faceLockImage))
            ? '（未设置参考图）' : '');
          hint.style.cssText = 'opacity:.55;';
          lb.appendChild(hint);
          lockRow.appendChild(lb);
          return cb;
        }
        var cbMe = lockToggle('用我的图片锁脸', meHasImg ? meMask : null);
        var cbChar = lockToggle('用TA的图片锁脸', chHasImg ? ch : null);
        var lockHint = h('p', 'gen-status', '');
        lockHint.style.cssText = 'font-size:11px;opacity:.6;margin:0 0 6px;';
        lockHint.textContent = '勾选后参考图会随生图请求发给接口「'
          + (Sleepy.imggen.activeApi() ? (Sleepy.imggen.activeApi().name || '') : '')
          + '」；接口需在设置里开启「参考图支持」。';

        var preview = h('div', 'gen-preview');
        preview.appendChild(h('p', 'gen-preview-empty', '生成后会在这里预览'));

        var status = h('p', 'gen-status', '');
        var row = h('div', 'gen-btns');
        var bGen = ui.button('生成预览', 'primary', function () { doGen(); });
        var bRedo = ui.button('重画', '', function () { doGen(true); });
        var bSend = ui.button('发送', 'primary', function () { doSend(); });
        var bCancel = ui.button('收起', '', function () { close(); });
        bRedo.style.display = 'none';
        bSend.style.display = 'none';
        row.appendChild(bCancel);
        row.appendChild(bRedo);
        row.appendChild(bSend);
        row.appendChild(bGen);

        card.appendChild(tabs);
        card.appendChild(intent);
        card.appendChild(lockRow);
        card.appendChild(lockHint);
        card.appendChild(preview);
        card.appendChild(status);
        card.appendChild(row);
        mask.appendChild(card);
        document.body.appendChild(mask);

        var mode = 'user';          /* user | char */
        var cur = null;             /* 预览中的 {subject, caption, url, blob, mediaId} */
        var busy = false;
        var objectUrl = '';

        function setMode(m) {
          mode = m;
          bMe.classList.toggle('active', m === 'user');
          bChar.classList.toggle('active', m === 'char');
          intent.placeholder = m === 'user'
            ? '想画什么，一句话就行（比如：便利店的深夜窗边）'
            : '想让 TA 发什么（可留空 = TA 自己决定）';
          dropPreview();
        }
        bMe.addEventListener('click', function () { setMode('user'); });
        bChar.addEventListener('click', function () { setMode('char'); });

        function dropPreview() {
          cur = null;
          bRedo.style.display = 'none';
          bSend.style.display = 'none';
          bGen.disabled = false;
          preview.innerHTML = '';
          preview.appendChild(h('p', 'gen-preview-empty', '生成后会在这里预览'));
          if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) { /* 忽略 */ } objectUrl = ''; }
        }
        function close() {
          dropPreview();
          if (mask.parentNode) mask.parentNode.removeChild(mask);
          document.removeEventListener('keydown', onKey);
        }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

        function paint(url) {
          preview.innerHTML = '';
          var img = h('img', 'gen-preview-img');
          img.src = url;
          preview.appendChild(img);
          if (cur && cur.caption) {
            preview.appendChild(h('p', 'gen-preview-cap', cur.caption));
          }
          bRedo.style.display = '';
          bSend.style.display = '';
        }

        function doGen(again) {
          if (busy) return;
          var text = String(intent.value || '').trim();
          if (mode === 'user' && !again && !text) {
            ctx.toast('先写一句想画什么', 'warn');
            return;
          }
          busy = true;
          bGen.disabled = true;
          status.textContent = again ? '重画中…' : '正在生成…';
          dropPreview();
          bRedo.style.display = 'none';
          bSend.style.display = 'none';

          var ask;
          if (mode === 'char') {
            ask = directorAsk('charPhoto', ch, c, text).then(function (d) {
              if (!d.ok) return d;
              if (d.refuse) {
                close();
                addMessage(chatId, {
                  id: newId(), role: 'assistant',
                  content: d.refuse, timestamp: Date.now()
                });
                renderMessages();
                return { ok: false, refused: true };
              }
              return d;
            });
          } else {
            ask = directorAsk('userTag', ch, c, text).then(function (d) {
              if (!d.ok) return d;
              if (!d.caption) d.caption = text.slice(0, 15);
              return d;
            });
          }

          ask.then(function (d) {
            if (!d.ok) {
              busy = false;
              bGen.disabled = false;
              status.textContent = d.refused ? '' : (d.error || '没生成出来');
              return;
            }
            /* B0：画面主体看导演给的 subjects（user/char/合影/纯场景都行），
               不再默认「user 模式=锁 char 反之」；解析失败走 legacy 老路。 */
            var plan = planFromDirector(d, ch, c, mode === 'char' ? 'char' : 'user');
            var shot = /selfie/i.test(d.subject || '') ? 'selfie' : '';
            var genReq = plan ? { plan: plan } : {
              subject: d.subject,
              faceText: mode === 'char' ? Sleepy.imggen.faceTextFor(ch, shot) : '',
              gender: mode === 'char' ? ch : null
            };
            /* B2：本次勾选作为逐人覆盖传下去 —— 不在画面里的主体，
               开关不产生参考图（解析器按 subjects 求交集）。 */
            if (plan) {
              var locks = {};
              if (meMask) locks['user:' + meMask.id] = !!cbMe.checked;
              if (ch) locks['char:' + ch.id] = !!cbChar.checked;
              genReq.imageLocks = locks;
            }
            return Sleepy.imggen.generate(genReq).then(function (r) {
              busy = false;
              bGen.disabled = false;
              if (!r.ok) {
                status.textContent = r.error.message || '生图失败了';
                return;
              }
              cur = {
                subject: plan ? plan.description : d.subject, caption: d.caption,
                blob: r.blob, mediaId: r.mediaId, url: r.url || '',
                plan: plan
              };
              objectUrl = r.url || URL.createObjectURL(r.blob);
              status.textContent = '';
              paint(objectUrl);
            });
          });
        }

        function doSend() {
          if (!cur || busy) return;
          var keep = cur;
          keep.url = objectUrl;
          genAndDeliver(ch, {
            subject: keep.subject,
            shot: keep.plan ? '' : (/selfie/i.test(keep.subject) ? 'selfie' : ''),
            caption: keep.caption,
            name: keep.caption,
            as: mode === 'char' ? 'assistant' : 'user',
            plan: keep.plan || null,
            /* 已生成过的直接复用，不再花一次生成费 */
            preset: keep
          }).then(function (r) {
            if (!r.ok) { ctx.toast((r.error && r.error.message) || '没发出去', 'err'); return; }
            close();
            renderMessages();
            ctx.toast(mode === 'char' ? 'TA 把照片发过来了' : '照片发出去了', 'ok');
          });
        }
      }

      function buildPanel() {
        panel.innerHTML = '';
        PLUS_ITEMS.forEach(function (it) {
          var on = it.toggle && it.get ? !!it.get() : false;
          /* 他说中文 → 这一项用不上。**不隐藏**：面板每屏的条目数量应该稳定，
             藏一个会让别的项跳舞；改成灰掉 + 点一下给一句解释。 */
          var na = !!(it.toggle && it.naCheck && it.naCheck());
          var b = h('button', 'plus-item' + (it.run ? '' : ' is-soon') +
            (it.toggle ? ' is-toggle' : '') + (on ? ' is-on' : '') + (na ? ' is-na' : ''));
          b.type = 'button';
          b.setAttribute('data-id', it.id);
          if (it.toggle) {
            b.setAttribute('role', 'switch');
            b.setAttribute('aria-checked', on ? 'true' : 'false');
            b.title = it.name + (on ? '：开' : '：关');
          }
          var ic = h('span', 'plus-ic');
          ic.innerHTML = it.svg;
          b.appendChild(ic);
          b.appendChild(h('span', 'plus-name', it.name));
          if (it.toggle) b.appendChild(h('span', 'plus-state', on ? '开' : '关'));
          b.addEventListener('click', function () {
            if (!it.run) {
              ctx.toast(it.name + ' 留到软装阶段再做', 'warn');
              return;
            }
            if (na) {
              ctx.toast('他跟你说的是一种语言，用不上翻译', 'warn');
              return;
            }
            it.run();
            /* toggle 类就地刷新它自己的状态，**不关面板** */
            if (it.toggle) {
              var nowOn = it.get ? !!it.get() : false;
              b.classList.toggle('is-on', nowOn);
              b.setAttribute('aria-checked', nowOn ? 'true' : 'false');
              var st = b.querySelector('.plus-state');
              if (st) st.textContent = nowOn ? '开' : '关';
            }
          });
          panel.appendChild(b);
        });
      }

      function togglePanel() {
        if (panel.classList.contains('is-open')) closePanel();
        else {
          panel.classList.add('is-open');
          renderMessages();
        }
      }

      function closePanel() { panel.classList.remove('is-open'); }

      buildPanel();

      /* ======================== 事件绑定 ======================== */

      sendBtn.addEventListener('click', doSend);
      plusBtn.addEventListener('click', togglePanel);

      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });
      textarea.addEventListener('input', function () {
        autoGrow();
        refreshSuggest();
      });

      /* ======================== 表情包 ========================

         三件事：
           ① 输入框里打字 → 匹配到表情，就在输入框上面推荐一排（可左右滑）
           ② 加号面板的「表情包」→ 打开按组分的面板，点一张就发
           ③ 发出去的是 type:'sticker' 的正式消息（不是拿文字冒充的）

         匹配用的是每张表情的**解释**（name）—— 所以「url 要对应文字解释」
         那件事不只是给人看的，也是给这里用的。 */

      /* C2 贴纸工坊（2026-10-02）：池子带 chat 上下文走统一可见性出口 ——
         char 单人贴纸只在与该 char 的会话出现、双人贴纸只在你们俩的会话、
         user 单人贴纸按马甲命中；老表情照旧（global + 本房）。 */
      function stickerCtx() {
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        return {
          scope: 'chat',
          charId: ch ? ch.id : null,
          maskId: (c && c.userId) || null
        };
      }
      function stickerPool() {
        if (Sleepy.stickers && Sleepy.stickers.getVisibleStickers) {
          return Sleepy.stickers.getVisibleStickers(stickerCtx());
        }
        return (Sleepy.stickers && Sleepy.stickers.visible) ? Sleepy.stickers.visible() : [];
      }

      /* user 侧头像：和输入区那个「我」同一套取图逻辑。
         捡手机皮肤不要 user 头像 —— 由 CSS（mode-phone）藏。 */
      function userAvatarEl() {
        var c = getChat(chatId);
        var u = (Sleepy.core && Sleepy.core.findUser(c && c.userId))
             || (Sleepy.core && Sleepy.core.activeUser());
        var av;
        if (u && (u.avatar || u.avatarMedia)) {
          av = h('img', 'msg-avatar');
          Sleepy.core.setAvatarImg(av, u);
        } else {
          av = h('span', 'msg-avatar msg-avatar-initial');
          var n = Sleepy.core.labelOfUser(u);
          av.textContent = n.charAt(0).toUpperCase();
        }
        av.alt = '我';
        return av;
      }

      /* 角色侧头像：**跟账号同步**（用户 2026-09-22：「chat 聊天里气泡旁的
         头像也没同步」）。以前这里写死 `av.src = AVATAR`（一颗灰圆占位），
         不管角色设没设头像都一样 —— 现在本地图 avatarMedia 优先、
         其次网址头像，两样都没有才回落到那颗占位图。
         setAvatarImg 是**异步**的（本地图要先从 IndexedDB 取 objectURL），
         所以先挂占位、拿到再换，中间不会闪空白。 */
      function charAvatarEl(c) {
        var av = h('img', 'msg-avatar');
        var ch = (c && c.characterId) ? findCharacter(c.characterId) : null;
        if (ch && (ch.avatar || ch.avatarMedia)) {
          Sleepy.core.setAvatarImg(av, ch);
        } else {
          av.src = AVATAR;
        }
        return av;
      }

      function stickerSrc(s) {
        if (s.mediaId && Sleepy.media) return Sleepy.media.url(s.mediaId);
        return Promise.resolve(s.url || '');
      }

      function sendSticker(s) {
        if (!s) return;
        var msg = {
          id: newId(),
          role: 'user',
          type: 'sticker',
          name: s.name || '表情',
          content: '[表情] ' + (s.name || ''),
          timestamp: Date.now()
        };
        if (s.mediaId) msg.mediaId = s.mediaId;
        else msg.url = s.url;

        addMessage(chatId, msg);
        /* 发完就把输入框清空 —— 用户：「先做那种发完就清空吧」。
           那几个字本来就是拿去**搜表情**的，表情发出去了它就完成使命了；
           留着只会让人以为还没发出去。 */
        textarea.value = '';
        autoGrow();
        clearSuggest();
        renderMessages();
      }

      function clearSuggest() {
        suggestBar.innerHTML = '';
        suggestBar.classList.remove('is-on');
      }

      /* 角色发一张表情：模型给的是**名字**，这里按名字找图。
         先精确匹配，再退一步「谁包含谁」—— 模型把名字记岔一点点也能中。 */
      function charSendSticker(name) {
        var q = String(name || '').trim().toLowerCase();
        if (!q) return null;
        var pool = stickerPool();
        /* 施工单 §七：优先 matchKey → 再按名字唯一命中；同名多个候选不猜
           （不跨角色、不随机挑），无匹配保持「当它没发」。 */
        var hits = pool.filter(function (s) {
          return String(s.matchKey || '').trim().toLowerCase() === q;
        });
        if (hits.length !== 1) {
          hits = pool.filter(function (s) {
            return String(s.name || '').trim().toLowerCase() === q;
          });
        }
        if (hits.length !== 1) {
          hits = pool.filter(function (s) {
            var n = String(s.name || '').trim().toLowerCase();
            return n && (n.indexOf(q) >= 0 || q.indexOf(n) >= 0);
          });
        }
        if (hits.length !== 1) return null;   /* 0 个或多个候选都不发 */
        var hit = hits[0];

        var msg = {
          id: newId(),
          role: 'assistant',
          type: 'sticker',
          name: hit.name || '表情',
          content: '[表情] ' + (hit.name || ''),
          timestamp: Date.now()
        };
        if (hit.mediaId) msg.mediaId = hit.mediaId;
        else msg.url = hit.url;
        addMessage(chatId, msg);
        commitMemory(chatId, 'assistant', '[表情] ' + (hit.name || ''));
        return msg;
      }

      /* 输入变化时刷推荐条 */
      function refreshSuggest() {
        var q = String(textarea.value || '').trim();
        suggestBar.innerHTML = '';
        if (!q || !Sleepy.stickers || !Sleepy.stickers.match) {
          suggestBar.classList.remove('is-on');
          return;
        }
        var hits = Sleepy.stickers.match(q, 14, stickerCtx());
        if (!hits.length) { suggestBar.classList.remove('is-on'); return; }

        suggestBar.classList.add('is-on');
        hits.forEach(function (s) {
          var cell = h('button', 'stk-sg-cell');
          cell.type = 'button';
          cell.title = (s.name || '表情') + ' · 点一下发出去';
          stickerSrc(s).then(function (u) {
            if (u) cell.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
          });
          cell.addEventListener('click', function () { sendSticker(s); });
          suggestBar.appendChild(cell);
        });
      }

      /* 加号面板里的「表情包」：底部弹一层，按组切，点一张就发 */
      function openStickerPanel() {
        closePanel();
        var pool = stickerPool();
        if (!pool.length) {
          ctx.toast('还没有表情 · 去「我 → 表情包」导入一批', 'warn');
          return;
        }

        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'stk-panel-mask');
        var box = h('div', 'stk-panel');
        var tabs = h('div', 'stk-panel-tabs');
        var grid = h('div', 'stk-panel-grid');

        var groups = Sleepy.stickers.groupsOf(pool);
        var cur = groups[0];

        function paint() {
          tabs.innerHTML = '';
          groups.forEach(function (gn) {
            var on = gn === cur;
            var chip = h('button', 'stk-panel-chip' + (on ? ' is-on' : ''), gn);
            chip.type = 'button';
            chip.addEventListener('click', function () { cur = gn; paint(); });
            tabs.appendChild(chip);
          });
          grid.innerHTML = '';
          pool.filter(function (s) { return Sleepy.stickers.groupOf(s) === cur; })
            .forEach(function (s) {
              var cell = h('button', 'stk-panel-cell');
              cell.type = 'button';
              cell.title = s.name || '表情';
              stickerSrc(s).then(function (u) {
                if (u) cell.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
              });
              cell.addEventListener('click', function () { close(); sendSticker(s); });
              grid.appendChild(cell);
            });
        }
        paint();

        /* 面板底部留一个去管理页的口子 —— 不然想加两张表情还得退出去绕「我 → 表情包」。 */
        var pfoot = h('div', 'stk-panel-foot');
        var mgr = h('button', 'stk-panel-mgr', '管理表情包 ›');
        mgr.type = 'button';
        mgr.addEventListener('click', function () { close(); ctx.open('stickers'); });
        pfoot.appendChild(mgr);

        box.appendChild(tabs);
        box.appendChild(grid);
        box.appendChild(pfoot);
        mask.appendChild(box);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); }, 20);

        function close() {
          mask.classList.remove('is-open');
          setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
        }
      }

      /* ======================== 收尾 ======================== */

      renderQuote();
      updateSendUI();
      autoGrow();
      renderMessages();
      armStick();          /* 盯住消息区高度：键盘收放时要重新贴底（见上面那段） */

      /* 从留痕「查看原文」跳进来：定位到那条气泡并短暂高亮（第三梯队 5）。
         render 阶段元素还没进文档，所以滚位放在下一个宏任务。 */
      var focusMsgId = ctx.params.focusMsgId || '';
      if (focusMsgId) {
        setTimeout(function () {
          try {
            var el = msgWrap.querySelector('[data-id="' + focusMsgId + '"]');
            if (!el) return;
            if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
            el.classList.add('msg-flash');
            setTimeout(function () { el.classList.remove('msg-flash'); }, 2400);
          } catch (e) { /* 无头桩没有 querySelector 实现，忽略 */ }
        }, 80);
      }

      /* 角色聊天外观（demo 版外观编辑页产出的配置）：
         生成的 CSS 作用域是 .msg-wrap.ap-on，rebuild / onShow 重进重套 */
      if (Sleepy.charAppearance) Sleepy.charAppearance.applyTo(ctx, chatId);

      ctx.reload = function () {
        var c = getChat(chatId);
        if (!c) { ctx.back(); return; }
        ctx.setTitle('');
        ensureHeadAvatar();          /* 顶栏头像被 setActions 清掉时补回来 */
        Sleepy.heartbeat.syncDots(chatId);
        autoGrow();                  /* 这时候才真的挂进文档，高度算得准 */
        renderMessages();
        armStick();                  /* onHide 摘过，回来看的时候得重新武装 */
        if (Sleepy.charAppearance) Sleepy.charAppearance.applyTo(ctx, chatId);
      };

      /* 换面具之后要重画：左侧头像、气泡里的「我」、以及上下文里的身份。
         面具轮盘在 page-switch.js 里，它换完会回调这里。 */
      Sleepy.chatDetailRefresh = function () {
        if (ctx.reload) ctx.reload();
      };

      /* 离开这一页时把盯消息区高度的探针摘掉：不摘的话每进一次聊天就留下
         一个 ResizeObserver 挂在这个页面的节点上（回调还捏着整页闭包）。
         回来时 ctx.reload → armStick 会重新挂上。 */
      ctx.detachStick = function () {
        if (stickRO) { try { stickRO.disconnect(); } catch (e) { /* 没有就算了 */ } stickRO = null; }
      };
    },
    onShow: function (ctx) { if (ctx.reload) ctx.reload(); },
    onHide: function (ctx) {
      /* 离开页面时把菜单和心声浮层收掉，免得回来还开着。
         长按菜单现在是挂在 #phone 上的浮层（不在 ctx.el 里），所以要显式收。 */
      ui.closePopover();
      if (ctx.detachStick) ctx.detachStick();
      if (ctx.el) {
        var m = ctx.el.querySelector('.msg-menu.is-open');
        var k = ctx.el.querySelector('.msg-menu-mask.is-open');
        if (m) m.classList.remove('is-open');
        if (k) k.classList.remove('is-open');
      }
      Sleepy.heartbeat.closeOverlay(ctx);
    }
  });

  /* ======================= 页面：收藏夹 ======================= */
  Sleepy.register('favorites', {
    title: '收藏夹',
    render: function (ctx) {
      var body = ctx.body;

      var listWrap = h('div', 'fav-list');
      var emptyWrap = h('div', 'empty');
      emptyWrap.appendChild(h('div', 'empty-paper'));
      emptyWrap.appendChild(h('p', 'empty-text', '还没有收藏过任何一条'));
      emptyWrap.appendChild(h('p', 'empty-hint',
        '长按一条消息，选「收藏」；帷境的作品在谢幕时可以存一张票根'));
      body.appendChild(emptyWrap);
      body.appendChild(listWrap);

      function rebuild() {
        /* 读取方：只列当前房里的收藏 */
        var list = Sleepy.core.scoped(store.get('favorites'));
        if (!Array.isArray(list)) list = [];
        /* 票根（帷境 T6）：**全局不 scoped**（群岛作品不归属单岛），
           所以跟聊天收藏分两段列 —— 换一座岛，票根不该跟着消失。 */
        var tk = (Sleepy.wj && Sleepy.wj.tickets) ? Sleepy.wj.tickets() : [];
        listWrap.innerHTML = '';
        emptyWrap.style.display = (list.length || tk.length) ? 'none' : 'flex';

        if (tk.length && Sleepy.wjCurtainUI) {
          listWrap.appendChild(h('p', 'chat-list-sect', '票根'));
          tk.forEach(function (t) {
            var tItem = h('div', 'fav-item');
            tItem.appendChild(Sleepy.wjCurtainUI.ticketEl(t, { small: true }));

            var tMeta = h('div', 'fav-meta');
            var when = new Date(t.at || 0).getTime();
            tMeta.appendChild(h('span', 'fav-src',
              '帷境 · ' + (when ? relativeTime(when) : '—')));

            var tJump = h('button', 'fav-btn', '去看看');
            tJump.type = 'button';
            tJump.addEventListener('click', function () {
              if (!Sleepy.wj || !Sleepy.wj.get(t.workId)) {
                ctx.toast('这部剧本已经不在门厅里了', 'err');
                return;
              }
              ctx.open('wj-work', { id: t.workId });
            });

            var tDel = h('button', 'fav-btn is-danger', '移除');
            tDel.type = 'button';
            tDel.addEventListener('click', function () {
              /* 只收票根，作品一个字都不动 ——「收藏纪念」是这个意思 */
              Sleepy.wj.removeTicket(t.id);
              rebuild();
              ctx.toast('票根收起来了', 'ok');
            });

            tMeta.appendChild(tJump);
            tMeta.appendChild(tDel);
            tItem.appendChild(tMeta);
            listWrap.appendChild(tItem);
          });
          if (list.length) listWrap.appendChild(h('p', 'chat-list-sect', '聊天收藏'));
        }

        list.forEach(function (f) {
          var item = h('div', 'fav-item');
          item.appendChild(h('div', 'fav-text', f.content || '（空）'));

          var meta = h('div', 'fav-meta');
          meta.appendChild(h('span', 'fav-src',
            (f.chatName || '聊天') + ' · ' + relativeTime(f.savedAt)));

          var jump = h('button', 'fav-btn', '去看看');
          jump.type = 'button';
          jump.addEventListener('click', function () {
            if (!getChat(f.chatId)) { ctx.toast('原来的对话已经删掉了', 'err'); return; }
            ctx.open('chat-detail', { chatId: f.chatId });
          });

          var del = h('button', 'fav-btn is-danger', '移除');
          del.type = 'button';
          del.addEventListener('click', function () {
            var cur = store.get('favorites');
            var next = [];
            (Array.isArray(cur) ? cur : []).forEach(function (x) {
              if (x.id !== f.id) next.push(x);
            });
            store.set('favorites', next);
            rebuild();
            ctx.toast('已移除', 'ok');
          });

          meta.appendChild(jump);
          meta.appendChild(del);
          item.appendChild(meta);
          listWrap.appendChild(item);
        });
      }

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* =================== 对外的数据层（给模块 E 用） ===================
     chats 的数据模型归本文件管，模块 E（心声）要把 heartbeats 挂到对话上，
     与其让 E 自己再写一份「读全表 → 改 → 整表落盘」，不如从这里暴露。
     两份实现迟早会漂移，而这类漂移的典型后果就是「只存单条，把别的对话冲掉」。

     page-heartbeat.js 是在本文件之前加载的，所以它必须惰性取用
     （运行时才读 Sleepy.chatStore），不能在加载期缓存。 */
  /* 给冒烟单测用的小工具（页面逻辑不依赖它） */
  Sleepy.chatUtil = {
    extractStickers: extractStickers,
    extractPats: extractPats,
    withPinnedFirst: withPinnedFirst
  };

  Sleepy.chatStore = {
    getChats: getChats,
    viewChats: viewChats,
    saveChats: saveChats,
    getChat: getChat,
    /* 找「当前账号 × 这个角色」的私聊 —— 各处找会话一律走它，
       别自己写 `characterId ===` 的循环（那会跨账号串气泡）。 */
    chatOf: chatOf,
    createChat: createChat,
    mutate: mutate,
    addMessage: addMessage,
    /* 删/改消息的规范入口（2026-09-22 导出）—— 它们不只改存档，
       还会让**向量索引里对应的块失效**（见 memoryVec.forget 的注释）。
       别在别处直接 filter 消息数组：那样索引就悄悄和存档对不上了。 */
    dropMessages: dropMessages,
    patchMessage: patchMessage,
    overridesOf: overridesOf,
    getCharacters: getCharacters,
    findCharacter: findCharacter,
    newId: newId
  };

  /* 聊天 App 容器（page-app.js）从这里取「消息」那一屏的实现。
     createChat 已经在 chatStore 里导出了 —— 通讯录点一个人就能直接开聊。
     parseTransfer 一起导出去：它是纯函数，冒烟里直接打表验金额校验。 */
  Sleepy.chatApp = {
    mountTab: mountChatTab,
    parseTransfer: parseTransfer,
    transferText: transferText,
    TRANSFER_MAX: TRANSFER_MAX,
    /* 纯函数，导出是为了冒烟能直接打表验：
       「空发送」到底该说「我没打字」还是「我说完了」，
       取决于上一条是谁发的 —— 搞错会让模型无视我刚连发的那几条。 */
    proactiveHintFor: proactiveHintFor,
    PROACTIVE_HINT: PROACTIVE_HINT,
    PROACTIVE_HINT_REPLY: PROACTIVE_HINT_REPLY,
    /* 会话列表的两个纯函数，同样导出给冒烟打表：
       previewOf 不许再冒出「对方回：」前缀、不许漏出 '||' 和 [译]…[/译] 标签；
       chatListTime 是照微信那套（今天给钟点、一周内给星期几）。 */
    previewOf: previewOf,
    chatListTime: chatListTime,
    /* 手机痕迹的落库入口。导出是为了让冒烟能走**真实函数**验它
       （回复后处理调的就是这一个）—— 别在别处另写一份实现。 */
    applyPhoneTrace: applyPhoneTrace
  };

})(window);
