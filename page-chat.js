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

    video: '<svg ' + SVG_BODY + '>' +
      '<rect x="3" y="6" width="18" height="13" rx="2.6"/>' +
      '<path d="M10 9.2l5 2.8-5 2.8z"/></svg>',

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
      '<path d="M9.2 9.6h.01M14.8 9.6h.01"/></svg>',

    /* 文字麻将：一张立着的字牌 + 两个点（跟这套线稿同一档粗细） */
    mahjong: '<svg ' + SVG_BODY + '>' +
      '<rect x="7" y="3.4" width="10" height="17.2" rx="2"/>' +
      '<circle cx="12" cy="9" r="1.2"/>' +
      '<circle cx="12" cy="14.6" r="1.2"/></svg>',

    /* 反查手机：一只眼睛（TA 在看你手机） */
    revcheck: '<svg ' + SVG_BODY + '>' +
      '<path d="M2.8 12s3.4-5.6 9.2-5.6S21.2 12 21.2 12s-3.4 5.6-9.2 5.6S2.8 12 2.8 12z"/>' +
      '<circle cx="12" cy="12" r="2.6"/></svg>',

    /* 重说（reroll）：两道循环箭头，经典刷新符号 */
    reroll: '<svg ' + SVG_BODY + '>' +
      '<path d="M19.4 11a7.5 7.5 0 0 0-13.9-2.6"/><path d="M5.3 4.6v4h4"/>' +
      '<path d="M4.6 13a7.5 7.5 0 0 0 13.9 2.6"/><path d="M18.7 19.4v-4h-4"/></svg>',

    /* 停止：圆角方块（国际通用「停」符号） */
    stop: '<svg ' + SVG_BODY + '>' +
      '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4"/></svg>'
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

  /* ==================== 情绪印章（2026-10-06） ====================
     点「我」的头像 → 选一枚隐喻小印章（小花花/小乌云/小枕头…）→
     落进输入框 → 发出去时角色会读到「XX 给自己盖了一枚…的小印章，
     似乎是有点…的情绪」的感知文案。

     印章用**隐喻**而不是表情脸：小花花=开心、小乌云=低落、小枕头=困困、
     小火苗=生气…更像真的「盖了个章」，也更有角色扮演的味道。
     stampSvg 画的是封蜡/印章风：双环 + 隐喻图标，accent 焦糖色，轻微旋转。 */
  var MOOD_STAMPS = [
    { id: 'happy',   icon: 'flower', name: '小花花', feel: '开心' },
    { id: 'sad',     icon: 'cloud',  name: '小乌云', feel: '低落' },
    { id: 'sleepy',  icon: 'pillow', name: '小枕头', feel: '困困' },
    { id: 'angry',   icon: 'flame',  name: '小火苗', feel: '生气' },
    { id: 'wronged', icon: 'drop',   name: '小水珠', feel: '委屈' },
    { id: 'excited', icon: 'star',   name: '小星星', feel: '兴奋' },
    { id: 'calm',    icon: 'moon',   name: '小月亮', feel: '平静' },
    { id: 'miss',    icon: 'heart',  name: '小爱心', feel: '想你' }
  ];

  /* 隐喻图标（48 格，居中，currentColor 取色）。 */
  var MOOD_ICONS = {
    flower: '<g fill="currentColor">' +
      '<circle cx="24" cy="13" r="3"/><circle cx="15.5" cy="18" r="3"/>' +
      '<circle cx="32.5" cy="18" r="3"/><circle cx="18.5" cy="27" r="3"/>' +
      '<circle cx="29.5" cy="27" r="3"/>' +
      '<circle cx="24" cy="22" r="3.4" fill="currentColor" opacity=".55"/></g>',
    cloud: '<path fill="currentColor" d="M16 31a8 8 0 0 1 .8-15.9 10 10 0 0 1 19 3 7 7 0 0 1-1.8 12.9z"/>',
    pillow: '<g fill="currentColor"><rect x="13" y="17" width="22" height="15" rx="6"/>' +
      '<circle cx="13" cy="17" r="2.3"/><circle cx="35" cy="17" r="2.3"/>' +
      '<circle cx="13" cy="32" r="2.3"/><circle cx="35" cy="32" r="2.3"/></g>',
    flame: '<path fill="currentColor" d="M24 11c3.4 5 6.4 7.4 6.4 13a6.4 6.4 0 0 1-12.8 0c0-3 1.5-5 3-7 .6 2 2 3 3.4 4 .3-3-.3-6 .4-10z"/>',
    drop: '<path fill="currentColor" d="M24 11c4.4 6 7 9 7 13a7 7 0 0 1-14 0c0-4 2.6-7 7-13z"/>',
    star: '<path fill="currentColor" d="M24 11l4.3 8.7 9.6 1.4-7 6.8 1.7 9.5L24 33l-8.6 4.4 1.7-9.5-7-6.8 9.6-1.4z"/>',
    /* 月亮（2026-10-26 用户报「没有图案」）：旧 path 内弧 r9 撑不起 22 的弦长，
       被浏览器强制放大成半圆 → 画出来是个实心圆，完全看不出是月亮。
       换标准月牙形（Lucide moon 同构，×2 缩放到 48 格）。 */
    moon: '<path fill="currentColor" d="M24 6a12 12 0 0 0 18 18 18 18 0 1 1-18-18z"/>',
    heart: '<path fill="currentColor" d="M24 34C13 27 11 21 15 17c3-3.2 8-1 9 3.5C25 16 30 13.8 33 17c4 4 2 10-9 17z"/>'
  };

  function stampSvg(iconId, size) {
    size = size || 48;
    var inner = MOOD_ICONS[iconId] || MOOD_ICONS.flower;
    return '<svg viewBox="0 0 48 48" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="24" cy="24" r="18.5" fill="none" stroke="currentColor" stroke-width="1" opacity=".5"/>' +
      inner +
      '</svg>';
  }

  function stampById(id) {
    for (var i = 0; i < MOOD_STAMPS.length; i++) {
      if (MOOD_STAMPS[i].id === id) return MOOD_STAMPS[i];
    }
    return null;
  }

  /* 本地日期（YYYY-MM-DD），用于「当天印章、跨天自动取消」 */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

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
     掉马戏码全靠这两个名字的错位 —— 切号 / 换马甲一换，它跟着变。 */
  function userNameOf(chat) {
    var core = Sleepy.core;
    if (core) {
      var u = core.findUser(chat && chat.userId) || core.activeUser();
      /* 名字留空 → 只剩微信名（core.labelOfUser） */
      if (u) return core.labelOfUser(u);
    }
    return '我';
  }

  /* ==================== 转发（仿微信，待办 2026-10-06 #2） ====================

     微信的两条路都做：
       · 单条：长按气泡 → 转发 → 选聊天 → 直接发（不带来源的裸气泡）
       · 多选：多选条 → 转发 → 逐条转发（裸气泡）/ 合并转发（带昵称的
         「XX的聊天记录」卡片，点开能看原对话）
     逐条/单条发出的消息 role 一律是 user —— 转发是「我说给 TA 听」，
     不是替原说话者传话；模型也按「你说过这些」接。

     不支持转发的（语音 —— 微信也不让转语音；转账/拍一拍/查岗等卡片）
     会跳过并提示条数。照片/表情转过去是**图库里的独立副本**（重新 put
     一份 blob），不共用 mediaId —— 不然删原消息时 dropMessages 的
     「无引用才删本体」只查本对话，会把别的对话还在用的图删掉。 */

  /* 选中集合（[{id, idx}]）→ 有序转发项。正文只从 bubbleText 一条路取。 */
  function collectForwardItems(chatId, pairs) {
    var c = getChat(chatId);
    if (!c) return [];
    var byMsg = {};
    pairs.forEach(function (p) {
      if (!p || !p.id) return;
      byMsg[p.id] = byMsg[p.id] || [];
      if (byMsg[p.id].indexOf(p.idx) < 0) byMsg[p.id].push(p.idx);
    });
    var out = [];
    (c.messages || []).forEach(function (m) {
      if (m.role !== 'user' && m.role !== 'assistant') return;
      if (!byMsg[m.id]) return;
      var uname = (m.role === 'user') ? userNameOf(c) : charNameOf(c);
      var idxs = byMsg[m.id].slice().sort(function (a, b) { return a - b; });
      idxs.forEach(function (idx) {
        /* 收到的合并卡可以原样再转（微信也这样）：整卡带走，标题不动 */
        if (m.type === 'fwd-merged') {
          out.push({ kind: 'merge-card', name: uname, role: m.role,
            title: m.title || '聊天记录', items: Array.isArray(m.items) ? m.items : [],
            t: m.timestamp || 0 });
          return;
        }
        /* 链接卡同样整卡带走（元数据跟着走，不重新抓） */
        if (m.type === 'link-card') {
          out.push({ kind: 'link-card', name: uname, role: m.role,
            link: m.link || { url: m.content, platform: '' },
            t: m.timestamp || 0 });
          return;
        }
        if (m.type === 'photo') {
          out.push({ kind: 'photo', name: uname, role: m.role,
            mediaId: m.mediaId || null, fname: m.name || '图片',
            w: m.w || 0, h: m.h || 0, size: m.size || 0, mime: m.mime || '',
            t: m.timestamp || 0 });
          return;
        }
        if (m.type === 'sticker') {
          out.push({ kind: 'sticker', name: uname, role: m.role,
            mediaId: m.mediaId || null, url: m.url || '',
            fname: m.name || '表情', t: m.timestamp || 0 });
          return;
        }
        /* 其余卡片类（转账/查岗/拍一拍/帷境…）和语音一律不转（微信也不转语音） */
        if (m.type || m.voice) { out.push({ kind: 'skip', why: m.type || 'voice' }); return; }
        out.push({ kind: 'text', name: uname, role: m.role,
          text: bubbleText(m, idx), t: m.timestamp || 0 });
      });
    });
    return out;
  }

  /* 转发项的摘要文本：合并记录里的预览行、给模型看的行都用它 */
  function fwdItemText(it) {
    if (!it) return '';
    if (it.kind === 'photo') return '[图片]';
    if (it.kind === 'sticker') return '[表情]' + (it.fname ? ' ' + it.fname : '');
    if (it.kind === 'merge-card') return '[聊天记录] ' + (it.title || '');
    if (it.kind === 'link-card') {
      return '[' + platformLabel(it.link && it.link.platform) + '链接] ' +
        ((it.link && it.link.title) || (it.link && it.link.url) || '');
    }
    return String(it.text || '').replace(/\s+/g, ' ').trim();
  }

  /* 把一组转发项发给一个目标对话。返回 Promise（全部落库后 resolve）。 */
  function sendForwardTo(targetId, items, mode) {
    var t = getChat(targetId);
    if (!t) return Promise.resolve(false);

    function finish(msgs) {
      msgs.forEach(function (m) {
        addMessage(targetId, m);
        /* 纯文字（没有 type 字段的）才进记忆索引；卡片类只进历史 */
        if (!m.type && m.content) commitMemory(targetId, 'user', m.content);
      });
      return true;
    }

    if (mode === 'merge') {
      /* 合并转发：一条「聊天记录」卡片。标题照微信 = 转发者的名字。
         单独转一张收到的合并卡时（merge-card）保留原标题 —— 卡是「别人
         整理好的记录」，再转也是那张卡。 */
      return Promise.resolve(finish([{
        id: newId(),
        role: 'user',
        type: 'fwd-merged',
        title: items.length === 1 && items[0].kind === 'merge-card'
          ? (items[0].title || '聊天记录')
          : (userNameOf(t) + '的聊天记录'),
        items: (items.length === 1 && items[0].kind === 'merge-card')
          ? (items[0].items || [])
          : items.map(function (it) {
              return { name: it.name || '', role: it.role || 'user',
                       text: fwdItemText(it), t: it.t || 0 };
            }),
        timestamp: Date.now()
      }]));
    }

    /* 逐条：按原顺序发裸气泡。照片/表情先复制出独立副本再落消息。 */
    var seq = [];
    var p = Promise.resolve();
    items.forEach(function (it) {
      p = p.then(function () {
        /* 链接卡整卡带走，不重新抓元数据 —— 卡是「当时看到的样子」 */
        if (it.kind === 'link-card') {
          return Promise.resolve().then(function () { seq.push({ kind: 'link-card', link: it.link || {} }); });
        }
        if (it.kind === 'photo') {
          if (it.mediaId && Sleepy.media && Sleepy.media.get) {
            return Sleepy.media.get(it.mediaId).then(function (rec) {
              if (!rec || !rec.blob) return { kind: 'ghost', text: '[图片]' };
              return Sleepy.media.put(rec.blob, {
                name: rec.name || it.fname, kind: 'photo',
                w: it.w || 0, h: it.h || 0
              }).then(function (mid) {
                return { kind: 'photo', mediaId: mid, fname: it.fname,
                  w: it.w || 0, h: it.h || 0, size: rec.size || 0, mime: rec.type || '' };
              });
            }, function () { return { kind: 'ghost', text: '[图片]' }; });
          }
          return Promise.resolve({ kind: 'ghost', text: '[图片]' });
        }
        if (it.kind === 'sticker') {
          if (it.mediaId && Sleepy.media && Sleepy.media.get) {
            return Sleepy.media.get(it.mediaId).then(function (rec) {
              if (!rec || !rec.blob) return { kind: 'sticker', url: it.url || '', fname: it.fname };
              return Sleepy.media.put(rec.blob, {
                name: rec.name || it.fname, kind: 'sticker'
              }).then(function (mid) {
                return { kind: 'sticker', mediaId: mid, fname: it.fname };
              });
            }, function () { return { kind: 'sticker', url: it.url || '', fname: it.fname }; });
          }
          return Promise.resolve({ kind: 'sticker', url: it.url || '', fname: it.fname });
        }
        return Promise.resolve({ kind: 'text', text: String(it.text || '') });
      }).then(function (r) { seq.push(r); });
    });

    return p.then(function () {
      var base = Date.now();
      var msgs = seq.map(function (r, i) {
        if (r.kind === 'link-card') {
          return { id: newId(), role: 'user', type: 'link-card',
            content: r.link.url || '', link: r.link,
            timestamp: base + i };
        }
        if (r.kind === 'photo') {
          return { id: newId(), role: 'user', type: 'photo',
            mediaId: r.mediaId, name: r.fname, w: r.w, h: r.h,
            size: r.size || 0, mime: r.mime || '',
            content: '[照片] ' + (r.fname || ''),
            timestamp: base + i };
        }
        if (r.kind === 'sticker') {
          var sm = { id: newId(), role: 'user', type: 'sticker',
            name: r.fname || '表情',
            content: '[表情] ' + (r.fname || ''),
            timestamp: base + i };
          if (r.mediaId) sm.mediaId = r.mediaId; else sm.url = r.url || '';
          return sm;
        }
        if (r.kind === 'ghost') {
          /* 图库里的本体已经没了：占位一条文字，顺序不乱 */
          return { id: newId(), role: 'user', content: r.text, timestamp: base + i };
        }
        return { id: newId(), role: 'user', content: r.text, timestamp: base + i };
      });
      return finish(msgs);
    });
  }

  /* ---------------- 转发目标选择（全屏，仿微信「选择聊天」） ----------------

     造型照微信：顶栏 取消 / 选择聊天 / 多选，下面搜索框 + 最近聊天列表。
     单选模式点一行 = 底部弹「发送给：XX」确认；多选模式勾若干行，
     底栏「发送(n)」。选中回调拿到的是目标对话 id 数组。 */
  function pickForwardTargets(ctx, onPicked) {
    var host = document.getElementById('phone') || document.body;
    var mask = h('div', 'msg-menu-mask');
    var panel = h('div', 'fwd-picker');
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('is-open');
      panel.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      }, 240);
    }

    var multi = false;
    var picked = {};      /* chatId -> true */
    var chats = withPinnedFirst(viewChats()).filter(function (c) { return !c.groupId; });

    var btnBack = h('button', 'fwd-head-btn', '取消');
    var headTitle = h('span', 'fwd-head-title', '选择聊天');
    var btnMulti = h('button', 'fwd-head-btn', '多选');
    btnBack.type = 'button'; btnMulti.type = 'button';
    var head = h('div', 'fwd-head');
    head.appendChild(btnBack); head.appendChild(headTitle); head.appendChild(btnMulti);

    var search = h('input', 'fwd-search');
    search.type = 'text';
    search.placeholder = '搜索';
    search.setAttribute('autocapitalize', 'off');

    var list = h('div', 'fwd-list');
    var foot = h('div', 'fwd-foot');
    foot.style.display = 'none';

    function rowOf(chat) {
      var chAv = chat.characterId ? findCharacter(chat.characterId) : null;
      var dispName = chatDisplayName(chat);
      var row = h('div', 'fwd-row');
      var ava = h('span', 'chat-item-ava', Sleepy.core.initialOf(dispName || '?'));
      Sleepy.core.setAvatarBg(ava, chAv);
      row.appendChild(ava);
      row.appendChild(h('span', 'fwd-row-name', dispName));
      var check = h('span', 'fwd-check');
      check.style.visibility = multi ? 'visible' : 'hidden';
      if (picked[chat.id]) check.classList.add('is-on');
      row.appendChild(check);
      row.addEventListener('click', function () {
        if (multi) {
          if (picked[chat.id]) { delete picked[chat.id]; check.classList.remove('is-on'); }
          else { picked[chat.id] = true; check.classList.add('is-on'); }
          paintFoot();
          return;
        }
        /* 单选：底部弹确认（照微信「发送给：」那条） */
        confirmSend(chat);
      });
      return row;
    }

    function paintList() {
      var kw = String(search.value || '').trim().toLowerCase();
      list.innerHTML = '';
      var shown = chats.filter(function (c) {
        if (!kw) return true;
        return String(chatDisplayName(c)).toLowerCase().indexOf(kw) >= 0;
      });
      if (!shown.length) {
        list.appendChild(h('div', 'fwd-empty', '没有匹配的聊天'));
        return;
      }
      shown.forEach(function (c) { list.appendChild(rowOf(c)); });
    }

    var sendBtn;
    function paintFoot() {
      var n = Object.keys(picked).length;
      foot.innerHTML = '';
      if (!multi) { foot.style.display = 'none'; return; }
      foot.style.display = 'flex';
      foot.appendChild(h('span', 'fwd-foot-info', n ? '已选 ' + n + ' 个聊天' : '点聊天勾选，一起发'));
      sendBtn = h('button', 'fwd-send' + (n ? '' : ' is-off'), '发送' + (n ? '(' + n + ')' : ''));
      sendBtn.type = 'button';
      sendBtn.addEventListener('click', function () {
        var ids = Object.keys(picked);
        if (!ids.length) return;
        close();
        onPicked(ids);
      });
      foot.appendChild(sendBtn);
    }

    /* 底部确认条（微信「发送给：XX + 取消/发送」） */
    function confirmSend(chat) {
      var sheet = h('div', 'msg-menu fwd-confirm');
      sheet.appendChild(h('div', 'fwd-confirm-label', '发送给：'));
      var who = h('div', 'fwd-confirm-who');
      var chAv = chat.characterId ? findCharacter(chat.characterId) : null;
      var dispName = chatDisplayName(chat);
      var ava = h('span', 'chat-item-ava', Sleepy.core.initialOf(dispName || '?'));
      Sleepy.core.setAvatarBg(ava, chAv);
      who.appendChild(ava);
      who.appendChild(h('span', 'fwd-row-name', dispName));
      sheet.appendChild(who);
      var acts = h('div', 'fwd-confirm-acts');
      var c1 = h('button', 'msg-menu-item', '取消');
      c1.type = 'button';
      c1.addEventListener('click', function () {
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      });
      var c2 = h('button', 'msg-menu-item is-primary', '发送');
      c2.type = 'button';
      c2.addEventListener('click', function () {
        close();
        onPicked([chat.id]);
      });
      acts.appendChild(c1); acts.appendChild(c2);
      sheet.appendChild(acts);
      panel.appendChild(sheet);
    }

    btnBack.addEventListener('click', close);
    btnMulti.addEventListener('click', function () {
      multi = !multi;
      picked = {};
      btnMulti.textContent = multi ? '单选' : '多选';
      paintList();
      paintFoot();
    });
    search.addEventListener('input', paintList);

    panel.appendChild(head);
    panel.appendChild(search);
    panel.appendChild(list);
    panel.appendChild(foot);
    mask.addEventListener('click', close);
    host.appendChild(mask);
    host.appendChild(panel);
    setTimeout(function () {
      mask.classList.add('is-open');
      panel.classList.add('is-open');
    }, 20);
  }

  /* ==================== 链接识别（微博 / 抖音 / 小红书） ====================

     待办 3 的第一步：整条消息就是一个平台链接时，不发文字气泡，
     改发一张「链接卡」（仿微信分享卡）。

     元数据怎么补（2026-10-06 定稿）：
     ① 微博分享文案（带正文的那种）→ 本地正则剥 正文/作者，零后端零 key；
     ② 裸链接 → apizero 解析接口（浏览器直连，CORS 全开已实测；
        匿名 5 次/天/IP，设置 → 视频解析填 key 提额）；
     ③ apizero 挂了 → 微博退 m 站 JSON、抖音退 <title> 抠取（多半也拦，
        代码留着，接口哪天开了就亮）；
     ④ 全失败 → 「只有链接」的占位卡。**不阻塞发消息、不报错** ——
        链接本身没坏，点开照样能看。
     评论抓取 v1 不做；小红书要登录态，单独讨论。 */

  var LINK_PLATFORMS = { weibo: '微博', douyin: '抖音', xhs: '小红书' };

  function platformLabel(p) { return LINK_PLATFORMS[p] || '链接'; }

  /* 整条消息必须**就是**一个链接才转卡片；文字里夹链接的照发文字
     （微信也只在「分享」时出卡，打字带链接不出卡）。 */
  function detectLink(text) {
    var t = String(text || '').trim();
    if (!/^https?:\/\/\S+$/i.test(t)) return null;
    var host = '';
    try { host = new URL(t).hostname.toLowerCase(); } catch (e) { return null; }
    var out = { url: t, platform: '', id: '' };
    if (/(^|\.)weibo\.(com|cn)$/.test(host)) {
      out.platform = 'weibo';
      /* 取路径最后一段当 id —— weibo.com/<uid>/<bid> 两段都是长数字，
         不能用「第一个长数字」去匹配，那是 uid 不是帖子 id */
      var parts = t.split('?')[0].split('/').filter(Boolean);
      out.id = parts.length ? parts[parts.length - 1] : '';
    } else if (host === 't.cn') {
      /* 短链：末段是短码不是帖子 id，m 站接口要不了；
         原帖 id 要跟跳转才知道，v1 不跟，id 留空。 */
      out.platform = 'weibo';
    } else if (/(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host)) {
      out.platform = 'douyin';
      var mv = t.match(/video\/(\d+)/);
      if (mv) out.id = mv[1];
    } else if (/(^|\.)xiaohongshu\.com$/.test(host) || /(^|\.)xhslink\.com$/.test(host)) {
      out.platform = 'xhs';
    } else {
      return null;
    }
    return out;
  }

  /* 依次试：直连 → 各公共中转。任何一个成功就返回响应文本。 */
  function fetchTextViaRelay(url, timeoutMs) {
    var prefixes = [''].concat([
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?url='
    ]);
    var i = 0;
    function attempt() {
      var target = prefixes[i] ? prefixes[i] + encodeURIComponent(url) : url;
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 9000);
      return fetch(target, ctrl ? { signal: ctrl.signal } : undefined)
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (raw) {
          /* 中转可能把错误页原样转回来：空响应按失败处理，继续换下一家 */
          if (!raw || !raw.length) throw new Error('empty');
          return raw;
        })
        .catch(function (err) {
          clearTimeout(timer);
          i++;
          if (i < prefixes.length) return attempt();
          throw err;
        });
    }
    return attempt();
  }

  /* 微博正文：m 站的 JSON（{ok:1, data:{text,user,pic_urls,reposts_count…}}） */
  function resolveWeibo(link, onPatch) {
    var api = 'https://m.weibo.cn/statuses/show?id=' + encodeURIComponent(link.id || '');
    fetchTextViaRelay(api).then(function (raw) {
      var j = JSON.parse(raw);
      if (!j || !j.ok || !j.data) throw new Error('bad json');
      var d = j.data;
      var txt = String(d.text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      var pics = [];
      (Array.isArray(d.pic_urls) ? d.pic_urls : []).forEach(function (p) {
        var u = (typeof p === 'string') ? p : ((p && p.url) || '');
        if (u) pics.push(u);
      });
      var n = function (v) { return Number(v) || 0; };
      onPatch({
        title: txt.slice(0, 80) || '微博',
        text: txt.slice(0, 200),
        user: (d.user && d.user.screen_name) || '',
        img: pics[0] || '',
        stats: n(d.reposts_count) + ' 转发 · ' + n(d.comments_count) +
               ' 评论 · ' + n(d.attitudes_count) + ' 赞'
      });
    })['catch'](function () { /* 拉不到保持占位卡，链接本身没坏 */ });
  }

  /* 抖音 / 小红书：v1 只试着从分享页 HTML 抠 <title> ——
     抖音的短链要跟一串跳转、小红书要登录态，都留到单独讨论那批。
     （抖音现在有更好的路：resolveLink 里先试 apizero，这里兜底。） */
  function resolveGeneric(link, onPatch) {
    fetchTextViaRelay(link.url).then(function (raw) {
      var mt = raw.match(/<title[^>]*>([^<]{1,120})/i);
      if (mt && mt[1]) onPatch({ title: mt[1].trim() });
    })['catch'](function () { /* 同上 */ });
  }

  /* ==================== 链接卡解析（视频 / 帖子富卡） ====================

     主路：极数本源（apizero.cn）的 video-parse 接口 —— 抖音 / B站 / 快手 /
     微博 / YouTube 等一揽子，出标题 / 作者 / 封面 / 转评赞。
     浏览器**直连**（CORS 全开，2026-10-06 实测反射任意 Origin），
     不用中转不用本地服务；匿名 5 次/天/IP，设置 → 链接解析里填自己的
     key 可提额，也可填自定义接口（优先用）。失败静默降级 ——
     占位卡照样能点开原页。 */
  var VIDEO_PARSE_API = 'https://v1.apizero.cn/api/video-parse';

  function videoParseKey() {
    try {
      var st = Sleepy.store;
      return String((st && st.get('vpKey')) || '').trim();
    } catch (e) { return ''; }
  }

  /* 解析结果缓存（24h，最多 60 条）：同一条链接反复发/反复看聊天，
     不该一遍遍吃掉当天的免费额度 —— 缓存命中直接回填，零请求。 */
  function vpCacheRead(url) {
    try {
      var c = Sleepy.store.get('vpCache') || {};
      var e = c[url];
      if (e && e.patch && (Date.now() - e.ts) < 24 * 3600 * 1000) return e.patch;
    } catch (e2) { /* 缓存坏了当没有 */ }
    return null;
  }

  function vpCacheWrite(url, patch) {
    try {
      var c = Sleepy.store.get('vpCache') || {};
      c[url] = { ts: Date.now(), patch: patch };
      var keys = Object.keys(c);
      if (keys.length > 60) {
        keys.sort(function (a, b) { return (c[a].ts || 0) - (c[b].ts || 0); });
        keys.slice(0, keys.length - 60).forEach(function (k) { delete c[k]; });
      }
      Sleepy.store.set('vpCache', c);
    } catch (e) { /* 写不进就算了 */ }
  }

  /* 自定义解析接口（设置 → 链接解析里填）：URL 模板，{url} / %url% / %s
     占位；不带占位符就默认拼 ?url=。填了就**优先用自定义**，挂了退 apizero。
     返回结构各家不同 ⇒ 宽松扫 JSON 按字段名抠数据，抠不到算失败。 */
  function vpCustomApi() {
    try {
      return String((Sleepy.store && Sleepy.store.get('vpCustomApi')) || '').trim();
    } catch (e) { return ''; }
  }

  function vpCustomRequestUrl(tpl, url) {
    var enc = encodeURIComponent(url);
    var u = tpl.replace(/\{url\}|%url%|%s/g, enc);
    if (u === tpl) u = tpl + (tpl.indexOf('?') >= 0 ? '&' : '?') + 'url=' + enc;
    return u;
  }

  /* 限深递归找第一个命中的字段值（数组也下钻）。 */
  function vpDeepFind(obj, names, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] && typeof obj[k] === 'object') {
        var hit = vpDeepFind(obj[k], names, depth + 1);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  function resolveViaApi(link, onPatch, onFail) {
    var cached = vpCacheRead(link.url);
    if (cached) { onPatch(cached); return; }

    /* 依次试：自定义接口（填了才排上）→ apizero。 */
    var tries = [];
    var custom = vpCustomApi();
    if (custom) tries.push({ url: vpCustomRequestUrl(custom, link.url), custom: true });
    var qs = '?url=' + encodeURIComponent(link.url) + '&flat=1';
    var key = videoParseKey();
    if (key) qs += '&key=' + encodeURIComponent(key);
    tries.push({ url: VIDEO_PARSE_API + qs, custom: false });

    var i = 0;
    function attempt() {
      if (i >= tries.length) { if (onFail) onFail(); return; }
      var t = tries[i++];
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
      fetch(t.url, ctrl ? { signal: ctrl.signal } : undefined)
        .then(function (r) { return r.text(); })
        .then(function (raw) {
          clearTimeout(timer);
          var j = null;
          try { j = JSON.parse(raw); } catch (e) { throw new Error('not json'); }
          return t.custom ? patchFromCustom(j) : patchFromApizero(j);
        })
        .then(function (patch) {
          vpCacheWrite(link.url, patch);
          onPatch(patch);
        })
        ['catch'](function () {
          clearTimeout(timer);
          attempt();
        });
    }
    attempt();
  }

  /* apizero 的结构是定的：{code:0, data:{title,desc,cover_url,stats,…}} */
  function patchFromApizero(j) {
    if (!j || Number(j.code) !== 0 || !j.data) throw new Error('parse fail');
    var d = j.data;
    if (d.data && !d.title) d = d.data;   /* 兼容 flat=0 的两层 data */
    var stats = d.stats || {};
    var source = d.source || {};
    var n = function (v) { return Number(v) || 0; };
    var pics = [];
    (Array.isArray(d.imagelist) ? d.imagelist : []).forEach(function (u) {
      if (typeof u === 'string' && u) pics.push(u);
    });
    var bits = [];
    if (n(stats.play_count)) bits.push(n(stats.play_count) + ' 播放');
    if (n(stats.like_count)) bits.push(n(stats.like_count) + ' 赞');
    if (n(stats.comment_count)) bits.push(n(stats.comment_count) + ' 评论');
    if (n(stats.share_count)) bits.push(n(stats.share_count) + ' 转发');
    else if (n(stats.collect_count)) bits.push(n(stats.collect_count) + ' 收藏');
    var title = String(d.title || '').trim().slice(0, 80);
    var img = String(d.cover_url || '').trim() || pics[0] || '';
    /* 全空的结果不叫成功，别拿它把占位卡的「平台名」洗掉 */
    if (!title && !img && !bits.length && !d.desc) throw new Error('empty');
    return {
      title: title,
      text: String(d.desc || '').slice(0, 200),
      user: String(stats.author_name || source.author_name || ''),
      img: img,
      stats: bits.join(' · ')
    };
  }

  /* 自定义接口：结构未知，宽松扫。 */
  function patchFromCustom(j) {
    if (!j || typeof j !== 'object') throw new Error('not json');
    var title = String(vpDeepFind(j, ['title', '标题', 'name'], 0) || '').trim().slice(0, 80);
    var text = String(vpDeepFind(j, ['desc', 'description', '摘要', 'content', 'intro'], 0) || '').slice(0, 200);
    var img = String(vpDeepFind(j, ['cover', 'cover_url', 'img', 'pic', 'image', 'thumbnail'], 0) || '').trim();
    var user = String(vpDeepFind(j, ['author', 'author_name', 'user', 'uploader', 'nickname'], 0) || '').trim();
    var cnt = function (names) {
      var v = Number(vpDeepFind(j, names, 0));
      return (isFinite(v) && v > 0) ? Math.round(v) : 0;
    };
    var bits = [];
    if (cnt(['play_count', 'play', 'plays'])) bits.push(cnt(['play_count', 'play', 'plays']) + ' 播放');
    if (cnt(['like_count', 'likes', 'digg_count', 'attitudes_count'])) bits.push(cnt(['like_count', 'likes', 'digg_count', 'attitudes_count']) + ' 赞');
    if (cnt(['comment_count', 'comments', 'comment'])) bits.push(cnt(['comment_count', 'comments', 'comment']) + ' 评论');
    if (cnt(['share_count', 'shares', 'reposts_count'])) bits.push(cnt(['share_count', 'shares', 'reposts_count']) + ' 转发');
    else if (cnt(['collect_count', 'collects', 'collect'])) bits.push(cnt(['collect_count', 'collects', 'collect']) + ' 收藏');
    if (!title && !img && !bits.length && !text) throw new Error('empty');
    return { title: title, text: text, user: user, img: img, stats: bits.join(' · ') };
  }

  /* ==================== 微博分享文案（零后端那条路） ====================

     微博 App「分享」出来的文案**自带博文正文**：
     「正文内容 O网页链接」「@作者：正文 https://weibo.com/xxx」「正文 L微博的微博视频」。
     手机上「复制链接」常常只剩裸链接 —— 那种走 detectLink / apizero；
     这里接的是**带正文的整段文案**：就地剥出 正文 / 作者 / 链接 建卡，
     零后端零 key 零配额。剥不出正文和作者的（比如纯「O网页链接」）不硬建。
     评论区拿不到；配图不进卡 —— 想让 TA 看图就截图发聊天走多模态。 */
  function detectWeiboShare(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (!/O网页链接|L微博的|微博视频|网页链接/.test(t)) return null;
    var um = t.match(/https?:\/\/[^\s，,。；;、）)】」"]+/i);
    var url = um ? um[0] : '';
    var am = t.match(/^\s*@([^\s:：@]{1,30})[:：]/);
    var body = t
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/O网页链接|L微博的|微博视频|网页链接/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!body && !am) return null;   /* 剥不出来，别硬建卡 */
    return { platform: 'weibo', url: url, id: '', shareText: body.slice(0, 500),
             author: am ? am[1] : '' };
  }

  function resolveLink(link, onPatch) {
    if (link.platform === 'weibo' && link.id) {
      /* 裸链接带帖子 id：先试 apizero（微博帖也支持），挂了退回 m 站
         JSON（多半被访客系统拦，但代码留着 —— 接口哪天开了就亮），
         再挂了保持占位卡。 */
      resolveViaApi(link, onPatch, function () { resolveWeibo(link, onPatch); });
    } else if (link.platform === 'douyin') {
      /* 抖音：apizero 主路（短链它能自己跟），挂了退 <title> 抠取 */
      resolveViaApi(link, onPatch, function () { resolveGeneric(link, onPatch); });
    } else if (link.platform === 'weibo') {
      /* 分享文案卡 / t.cn 短链：没有帖子 id。分享文案卡的正文作者
         建卡时就写进 link 了，这里只是试着补封面和数据；t.cn 让
         apizero 试，它接得住是赚到，接不住保持原样。 */
      resolveViaApi(link, onPatch);
    } else {
      resolveGeneric(link, onPatch);
    }
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
    /* 分享回执·已回应（v247b）：接收方（char）在这段对话里开口了 →
       给分享者补一条「回应了」回执。咽喉挂一次，所有发消息的路都吃得到；
       forumShare 缺席/出错都不影响消息本身。 */
    if (Sleepy.forumShare && Sleepy.forumShare.onConversationMessage) {
      try { Sleepy.forumShare.onConversationMessage('chat', chatId, msg); } catch (e) { /* 静默 */ }
    }
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
      /* 照片消息（2026-10-06，用户）：删除要**从数据库里真删** ——
         相册里同 mediaId 的记录一并清掉（「不用再出现在相册里」）；
         这轮对话里没有别的消息还引用同一张图时，把图库里的本体也删了。
         生成图当初会顺手收进相册（genAndDeliver），不这样删的话
         消息没了、相册里还躺着一张。 */
      c0.messages.forEach(function (m) {
        if (ids.indexOf(m.id) < 0 || m.type !== 'photo' || !m.mediaId) return;
        try {
          if (Sleepy.photos && Sleepy.photos.removeByMedia) {
            Sleepy.photos.removeByMedia(m.mediaId);
          }
          /* 全局引用判定（2026-10-12 P1-3 修）：以前只查本聊天 —— 相册或
             别的聊天还引着同一张图时 blob 被误删，那边显示「找不到了」。
             现在统一走 photos.mediaReferenced（扫全部聊天 + 相册记录）。 */
          var otherRef = Sleepy.photos && Sleepy.photos.mediaReferenced
            ? Sleepy.photos.mediaReferenced(m.mediaId, { msgId: m.id })
            : c0.messages.some(function (x) {
                return ids.indexOf(x.id) < 0 && x.mediaId === m.mediaId;
              });
          if (!otherRef) {
            var r2 = Sleepy.media.remove(m.mediaId);
            if (r2 && r2['catch']) r2['catch'](function () { /* 删不掉不影响删除本身 */ });
          }
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

  /* 角色撤回的执行（2026-10-06）：[撤回:N|原因] 的 N 按**已发出的纯文字
     消息**从新往旧数（1 = 上一条）。撤回不删原文（口径同群聊 core-group.js）：
     打 recalledAt + recallReason，渲染层原位画灰字，点击可看原文和原因。
     excludeId = 本轮刚落库的这条回复 —— 它还「没发出去」，不算进候选，
     不然 N=1 会数到正在说的这句话（说明书里写的「上一条」就骗人了）。
     数过头了就静默跳过 —— 模型数错了不该炸整个回复。
     每个 hit 都重新 getChat：store.get 是深拷贝，拿着旧快照选候选，
     前一个 hit 刚打上的戳就看不见了（会重复撤到同一条）。 */
  function applyCharRecalls(chatId, hits, excludeId) {
    var done = [];
    (hits || []).forEach(function (hit) {
      var c = getChat(chatId);
      if (!c) return;
      var cands = (c.messages || []).filter(function (m) {
        return m.id !== excludeId &&
               m.role === 'assistant' && !m.type && !m.recalledAt &&
               String(m.content || '').trim();
      });
      var m = cands[cands.length - Math.max(1, hit.n | 0)];
      if (!m) return;
      patchMessage(chatId, m.id, {
        recalledAt: Date.now(),
        recallReason: String(hit.reason || '')
      });
      done.push(m.id);
    });
    return done;
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

  /* 角色引用回复（2026-10-29）：TA 回复里单独一行写 [引用:那句话的关键原文]。
     程序拿这段原文去最近消息里对号（包含匹配），对上了就把引用条挂到
     TA 气泡下面（样式同 user 的引用）。全角半角冒号都认，只收第一个
     标签，其余照剥防泄漏。纯函数。 */
  function extractReplyQuote(raw) {
    var hit = null;
    var text = String(raw == null ? '' : raw)
      .replace(/\[引用[：:]([^\]\n]*)\]/g, function (_, q) {
        if (!hit) {
          var v = String(q || '').trim().slice(0, 140);
          if (v) hit = v;
        }
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, hit: hit };
  }

  /* [引用:...] 原文 → 历史消息对号。从新往旧扫最近 30 条（跳过撤回/事件条）：
     命中规则 = 消息正文包含引用原文，或引用原文包含某个分泡段（模型常
     只抄半句，正着反着都试试）。返回命中的消息，对不上返回 null ——
     调用方把引用记成 user 说的（引用着回多半回的是你那句话）。 */
  function matchQuotedMessage(chatId, quoteText) {
    var c = getChat(chatId);
    var list = (c && c.messages) || [];
    var q = String(quoteText || '').trim();
    if (!q) return null;
    for (var i = list.length - 1, seen = 0; i >= 0 && seen < 30; i--, seen++) {
      var m = list[i];
      if (!m || m.recalledAt) continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (m.type) continue;                       /* 卡片/附件消息不参与对号 */
      var body = String(m.content || '');
      if (!body.trim()) continue;
      if (body.indexOf(q) >= 0) return m;
      var segs = body.split('||');
      for (var s = 0; s < segs.length; s++) {
        var seg = String(segs[s] || '').trim();
        if (seg.length >= 4 && q.indexOf(seg) >= 0) return m;
      }
    }
    return null;
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

  /* TA 自己换头像（2026-10-27）：回复里写 [换头像:名字] = 「我想换成那一
     张」。名字对的是 TA 头像库里某张的 label（库在编辑角色里存，可起名）；
     不写名字 = 让 TA 挑，程序取库里第一张。
     和 [表情:名字] 完全同一套机制 —— 模型只说「想换」，程序去挑图落库。
     ⚠️ 开关（角色记录 allowSelfAvatar）关着时**照剥不执行**：
        标签不能留在正文里泄漏，但也不该让 TA 偷偷换掉头像。 */
  function extractAvatarSwaps(raw) {
    var names = [];
    var text = String(raw == null ? '' : raw)
      .replace(/\[换头像(?:[：:]\s*([^\]\n]*?)\s*)?\]/g, function (_, n) {
        names.push(String(n || '').trim());
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, names: names };
  }

  /* TA 想换头像，但没指名（或名字没对上）→ 让它**真的看一眼图**再挑。
     只在「它自己起意要换」的这一刻才发这一次请求 —— 不占每轮装配的 token，
     也不会因为它看不见图就只能瞎猜一个名字。
     看什么：先是**对方的头像**（TA 多半就是看见它才想换的），再是 TA 库里
     每一张（按名字标好）。让它只回一个名字，程序按名字落库。
     ⚠️ 主 API 不是多模态 / 取图失败 / 回的话对不上 → 退回「挑第一张」，
        不卡住流程，也不假装它看过。 */
  function pickAvatarBySight(chatId, ch, lib, want, done) {
    var fallback = lib[0];
    function finish(item) { done(item || fallback); }
    var cfg = null;
    try { cfg = store.get('mainApi'); } catch (e) { cfg = null; }
    if (!cfg || !cfg.model || !Sleepy.api || !Sleepy.api.requestOnce ||
        !Sleepy.media || !Sleepy.media.dataURL) { finish(null); return; }

    var jobs = [];
    var uMask = null;
    try { uMask = (core.activeUserOnIsland && core.activeUserOnIsland()) || null; } catch (e) { uMask = null; }
    if (uMask && uMask.avatarMedia) {
      jobs.push(Sleepy.media.dataURL(uMask.avatarMedia).then(function (d) {
        return d ? { tag: '对方的头像', data: d } : null;
      }, function () { return null; }));
    }
    lib.forEach(function (it) {
      jobs.push(Sleepy.media.dataURL(it.id).then(function (d) {
        return d ? { tag: String(it.label || ''), data: d } : null;
      }, function () { return null; }));
    });

    Promise.all(jobs).then(function (list) {
      var pics = [];
      list.forEach(function (p) { if (p) pics.push(p); });
      if (!pics.length) { finish(null); return; }
      var labels = [];
      lib.forEach(function (x) {
        var n = String((x && x.label) || '').trim();
        if (n) labels.push(n);
      });
      var content = [{
        type: 'text',
        text: '你想换一张自己的头像。下面第一张是对方的头像，之后是你头像库里的每一张（按名字标好了）。' +
          (want ? '你刚才提到想要「' + want + '」。' : '') +
          '看清楚之后，只回答你要换上的那一张的名字（只能从这几个里选：' +
          (labels.join('、') || '没有名字的那张') + '），不要解释，不要加别的字。'
      }];
      pics.forEach(function (p) { content.push({ type: 'image_url', image_url: { url: p.data } }); });
      return Sleepy.api.requestOnce({ cfg: cfg }, [{ role: 'user', content: content }], { maxTokens: 24 })
        .then(function (res) {
          if (!res || !res.ok) { finish(null); return; }
          var said = String(res.content || '').trim();
          for (var i = 0; i < lib.length; i++) {
            var lb = String(lib[i].label || '').trim();
            if (lb && said.indexOf(lb) >= 0) { finish(lib[i]); return; }
          }
          finish(null);
        }, function () { finish(null); });
    }, function () { finish(null); });
  }

  /* 执行换头像（异步，结果走 done 回调）。三道闸：开关 / 库里要有图 /
     换的那张不能就是当前这张。任何一道没过 → done(null)，静默什么都不做。
     图**只能来自 TA 自己的头像库** —— 不生图。
     指名了（且名字对得上）直接换，省一次调用；没指名或没对上才看图。 */
  function applyCharAvatarSwap(chatId, names, done) {
    done = done || function () {};
    function commit(ch, item) {
      core.upsertChar({ id: ch.id, avatarMedia: item.id, avatar: '' });
      return { name: ch.name || '对方', label: item.label || '新头像' };
    }
    function refuse() { done(null); }
    var c = getChat(chatId);
    var ch = findCharacter(c ? c.characterId : null);
    if (!ch || !ch.allowSelfAvatar) { refuse(); return; }
    var lib = Array.isArray(ch.avatarLib) ? ch.avatarLib : [];
    if (!lib.length) { refuse(); return; }

    var key = String((names && names[0]) || '').trim();
    var want = null;
    if (key) {
      for (var i = 0; i < lib.length; i++) {
        var lb = String(lib[i].label || '');
        if (lb && (lb.indexOf(key) >= 0 || key.indexOf(lb) >= 0)) { want = lib[i]; break; }
      }
    }
    if (want) {
      if (ch.avatarMedia === want.id) { refuse(); return; }  /* 本来就是这张 */
      done(commit(ch, want));
      return;
    }
    /* 没指名 / 名字没对上 → 让 TA 看一眼图再挑 */
    pickAvatarBySight(chatId, ch, lib, key, function (item) {
      if (!item || !item.id) { refuse(); return; }
      if (ch.avatarMedia === item.id) { refuse(); return; }
      done(commit(ch, item));
    });
  }

  /* 换头像的说明书（给模型看的那一行）。
     只在**开关开着 + 库里真有图**时才给它 —— 没开就一个字都不提，
     不然模型照猫画虎，平白多出「我要换头像」这种没由头的动作。
     库里每张的名字都列出来：模型靠名字认图，写 [换头像:名字] 才指得准。 */
  function avatarSwapSpec(chatId) {
    var c = getChat(chatId);
    var ch = findCharacter(c ? c.characterId : null);
    if (!ch || !ch.allowSelfAvatar) return '';
    var lib = Array.isArray(ch.avatarLib) ? ch.avatarLib : [];
    var names = [];
    lib.forEach(function (x) {
      var n = String((x && x.label) || '').trim();
      if (n) names.push(n);
    });
    if (!names.length) return '';
    return '你有一个自己的头像库，里面有：' + names.join('、') + '。' +
      '什么时候想换头像都可以（比如看见对方的头像，想换成跟它一对的那张），' +
      '就单独一行写 [换头像:名字]，如 [换头像:' + names[0] + ']。' +
      '这是你自己的主意，想换才换；不用每条都换，也不用先问对方。' +
      '写完照常说话就行，不用在正文里解释这个标签。';
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

  /* TA 发 HTML 小游戏（2026-10-06）：回复里写一块 [html]…[/html]，
     标签内是完整 HTML（内联 CSS/JS，说明书在 prompt-engine 的 htmlgame 卡）。
     程序剥标签 → 落成 type:'html' 消息 → 沙箱 iframe 渲染（htmlGameCard）。
     · **多行标签**：HTML 里全是换行和方括号，不能用 [html:…] 单行格式
       （同 [译]…[/译] 的多行先例）；大小写都认，防模型随手写 [HTML]。
     · 一次回复最多收 1 块防刷（游戏不是表情包，多出来的直接剥掉不落库）。
     · 尺寸闸 HTMLGAME_MAX：超长**截断保留下半**不整个丢弃 —— 浏览器对
       半截 HTML 很宽容，截断的游戏多半还能玩；整丢则模型白写一轮。
       截断位打标记，卡片上明示「内容超长被截断」。
     · 没闭合的 [html]（有头没尾）不算命中，原文保留不动 —— 半截输出
       多半是流式中断，剥掉反而丢字。 */
  var HTMLGAME_MAX = 20 * 1024;
  function extractHtmlGames(raw) {
    var hit = null;
    var count = 0;
    var text = String(raw == null ? '' : raw)
      .replace(/\[html\]\s*([\s\S]*?)\s*\[\/html\]/gi, function (_, body) {
        count++;
        if (!hit) hit = String(body || '');
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (hit == null) return { text: text, hit: null };
    var truncated = hit.length > HTMLGAME_MAX;
    if (truncated) hit = hit.slice(0, HTMLGAME_MAX);
    return { text: text, hit: hit, truncated: truncated, dropped: Math.max(0, count - 1) };
  }

  /* 收藏提议（We 收藏馆 P2）：回复里写 [收藏提议:事件id|分类|理由]。
     记一笔（We 共同记录）：回复里写 [记一笔:标题|一句话|分类] —— char 自己
     开口提议把聊到的时刻记进收藏馆（2026-10-08）。
     抽取 / 校验 / 去重 / 来源核验 / 落库全部收口在 Sleepy.weProposals
     （唯一出口 page-we-proposal.js）—— 这里只负责剥标签。
     两个标签**都从正文剥干净**（标签文本绝不留在气泡/历史/心声里），
     提议动作只认**先出现的那个**；一分口供都不留给下一个 handler。 */
  function extractProposal(raw) {
    if (Sleepy.weProposals && Sleepy.weProposals.extractTag) {
      /* 先剥收藏提议，再在**剥净后的文本**上剥记一笔 —— 两层串行，
         缺一层标签都会整段漏回气泡里（2026-10-08 实测：第二层跑在原文上
         会把第一层的剥除冲掉）。 */
      var a = Sleepy.weProposals.extractTag(raw);
      var b = (Sleepy.weProposals.extractEntryTag)
        ? Sleepy.weProposals.extractEntryTag(a.text)
        : { text: a.text, hit: null };
      /* 两个都命中时只认先出现的那个（位置在原文上比，互不干扰） */
      var hit;
      if (a.hit && b.hit) {
        var pa = raw.indexOf('[收藏提议');
        var pb = raw.indexOf('[记一笔');
        hit = (pa >= 0 && (pb < 0 || pa <= pb)) ? a.hit : b.hit;
      } else {
        hit = a.hit || b.hit;
      }
      if (hit && !hit.type) hit.type = 'calendar';
      return { text: b.text, hit: hit };
    }
    return { text: String(raw == null ? '' : raw), hit: null };
  }

  /* ---------------------------- 角色撤回（2026-10-06） ----------------------------

     模型在回复里单独一行写 [撤回:第几条|原因]，就是「把我说过的话收回」。
     第几条按**他已发出的纯文字消息**从新往旧数（1 = 上一条）—— 正在打的
     这条还没落库，谈不上「收回」。全角半角冒号、竖线都认，原因可省。
     纯函数，冒烟里单测；执行在 applyCharRecalls（要动存档，不在这里）。 */
  function extractRecalls(raw) {
    var hits = [];
    var text = String(raw == null ? '' : raw)
      .replace(/\[撤回[：:]\s*(\d+)(?:\s*[|｜]\s*([^\]\n]*))?\]/g, function (_, n, why) {
        hits.push({ n: Math.max(1, parseInt(n, 10) || 1), reason: String(why || '').trim() });
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, hits: hits };
  }

  /* 灯牌留言（2026-10-06）：[灯:那句话] / [灯牌:那句话] —— char 随时可以
     往桌面的挂件灯上留一句话（能力卡 lamptag，不绑主动消息）。
     抽取是纯函数（冒烟单测，口径同 extractRecalls：全角半角都认、
     抽完的正文不带标签）；落库走 Sleepy.lampNotes.add（唯一出口
     page-desktop），落库时机在回复管线里。 */
  function extractLampNotes(raw) {
    var hits = [];
    var text = String(raw == null ? '' : raw)
      .replace(/\[灯[牌]?[：:]\s*([^\]\n]{1,80})\]/g, function (_, t) {
        hits.push({ text: String(t).trim() });
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, hits: hits };
  }

  /* 慢递信箱（批4）：[慢递:小时数|信的内容] —— char 写一封延迟送达的信。
     小时数钳在 1~72（prompt 卡同口径）；抽取纯函数（冒烟单测）；
     落库走 commitSlowmail（slowLetters 表，到点前 user 看不到内容）。 */
  function extractSlowmail(raw) {
    var hits = [];
    var text = String(raw == null ? '' : raw)
      .replace(/\[慢递[：:]\s*(\d{1,3})\s*[|｜]\s*([^\]\n]+)\]/g, function (_, n, body) {
        var h = Math.max(1, Math.min(72, parseInt(n, 10) || 1));
        hits.push({ hours: h, body: String(body).trim() });
        return '';
      })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: text, hits: hits };
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

  /* ---------------- HTML 小游戏（2026-10-06） ----------------

     TA 送一个可玩的网页小游戏：落库 type:'html'（html 字段存源码），
     渲染在沙箱 iframe 里（htmlGameCard，见下方 render 段）。
     三段式，各管各的：
       · 落库  commitHtmlGame     —— 回复后处理调用（唯一入口）
       · 结算  gameResultNote     —— 沙箱 postMessage 进来，存待转述痕迹
       · 注入  gameResultPeekMsg  —— 下一轮 buildMessages 垫进上下文（一次性）
     痕迹存 store（键带 chatId）：切岛/切号由 tagScope 盖章隔离，
     跟 slowLetters 同一套纪律。 */

  function commitHtmlGame(chatId, body, truncated) {
    if (!body || !chatId) return null;
    var chat = getChat(chatId);
    if (!chat) return null;
    var t = (String(body).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    return addMessage(chatId, {
      id: newId(),
      role: 'assistant',
      type: 'html',
      content: (t || '').trim().slice(0, 40) || 'TA 做的小玩意',
      html: String(body),
      truncated: !!truncated,
      timestamp: Date.now()
    });
  }

  /* 结算痕迹：key 按会话，latest-wins（游戏可以多局连报，TA 看最新一局）。
     同内容重复上报不覆盖（防止同一局的 report 反复触发重绘）。 */
  function noteGameResult(chatId, msgId, score, text) {
    if (!chatId) return false;
    var prev = store.get('htmlGameResult:' + chatId);
    if (prev && prev.msgId === msgId && prev.score === score &&
        (prev.text || '') === (text || '')) return false;
    store.set('htmlGameResult:' + chatId, {
      msgId: msgId || null,
      title: '',
      score: (typeof score === 'number' && isFinite(score)) ? score : null,
      text: String(text || '').slice(0, 120),
      ts: Date.now()
    });
    return true;
  }

  /* 下一轮把结算垫进上下文（一次性：读出即摘）。写侧盖了岛章的话按
     root 读（口径同 diaryPeekMsg）；没章就是纯 chatId 键。 */
  function gameResultPeekMsg(chatId) {
    if (!chatId) return null;
    var key = 'htmlGameResult:' + chatId;
    var rec = store.get(key);
    if (!rec) return null;
    store.set(key, null);
    var lines = ['[小游戏结算] 你之前发给对方的小游戏，对方刚玩完一局。'];
    if (rec.score != null) lines.push('得分：' + rec.score + '。');
    if (rec.text) lines.push('结果描述：「' + rec.text + '」。');
    if (rec.score == null && !rec.text) return null;
    lines.push('可以自然地接话（调侃、关心、约再来一局），不要复述这段文字。');
    return { role: 'system', content: lines.join('\n') };
  }

  /* 沙箱结算总线：htmlGameCard 每次渲染把自己的 contentWindow 登记进来，
     message 事件只认登记过的窗口（别人页里开的其他 iframe 报不上来）。
     模块级全局只挂一次监听（页面脚本只执行一遍，不会重复绑）。 */
  var gameFrameWins = [];
  var gameFrameMeta = new Map();
  function registerGameFrame(win) {
    if (!win) return;
    if (gameFrameWins.indexOf(win) === -1) gameFrameWins.push(win);
    /* 登记表只增不扫会随重绘缓慢膨胀，顺手清一遍已死的引用：
       窗口已关（closed）或摸不动了（iframe 已摘，跨源访问直接抛）都算死 */
    for (var i = gameFrameWins.length - 1; i >= 0; i--) {
      var dead = true;
      try { dead = !!gameFrameWins[i].closed; } catch (e) { dead = true; }
      if (dead) {
        gameFrameWins.splice(i, 1);
      }
    }
    Array.from(gameFrameMeta.keys()).forEach(function (win) {
      var dead = true;
      try { dead = !!win.closed; } catch (e) { dead = true; }
      if (dead) gameFrameMeta.delete(win);
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('message', function (ev) {
      if (!ev.data || ev.data.__sleepyHtmlResult !== 1) return;
      if (gameFrameWins.indexOf(ev.source) === -1) return;
      var meta = gameFrameMeta.get(ev.source);
      if (!meta) return;
      noteGameResult(meta.chatId, meta.msgId, ev.data.score, ev.data.text);
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
    /* 视频：读懂后 caption 里有「视频内容」，角色据此回应；没读出来就只报发了视频。 */
    if (m.type === 'video') {
      var vt = '[我发了一段视频：' + (m.name || '未命名') + ']';
      if (m.caption) vt += '；视频内容：' + m.caption;
      return vt;
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
    /* 合并转发的聊天记录卡：给模型看摘要（前 6 条，每条截 60 字），
       并说清「这是转发的别人的对话」—— 不然 TA 会把里面的话当成
       你对 TA 说的。 */
    if (m.type === 'fwd-merged') {
      var fits = Array.isArray(m.items) ? m.items : [];
      var flines = [];
      fits.slice(0, 6).forEach(function (it) {
        flines.push((it.name || '') + '：' + String(it.text || '').slice(0, 60));
      });
      if (fits.length > 6) flines.push('…（共 ' + fits.length + ' 条）');
      return '[我转发了一份聊天记录「' + (m.title || '聊天记录') + '」：\n' +
        flines.join('\n') + '\n这是我转来给你看的别人聊过的内容，不是我对你说的话]';
    }
    /* 链接卡：报平台 + 标题 + 链接本体（TA 手上有 API 的话能自己点开看）。
       分享文案卡可能没有 url（没复制到链接），那就只报标题和内容。 */
    if (m.type === 'link-card') {
      var lk = m.link || {};
      var ltxt = '[我分享了一个' + platformLabel(lk.platform) + '链接：' +
        (lk.title || '') + (lk.url ? '（' + lk.url + '）' : '') + ']';
      if (lk.user) ltxt += '，作者是 @' + lk.user;
      if (lk.text) ltxt += '，内容是：「' + String(lk.text).slice(0, 160) + '」';
      return ltxt;
    }
    /* HTML 小游戏：只报「做过、送出去了」。游戏内容本身不进上下文
       （那是一坨 HTML 源码，喂进去纯烧 token）；TA 要知道结果，
       走 gameResultPeekMsg 的结算痕迹，不在这里替模型剧透。 */
    if (m.type === 'html') {
      return '[我做了一个能在聊天里直接玩的小游戏《' + (m.content || '') +
        '》发给了对方，等 TA 玩]';
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
    var peN = Sleepy.promptEngine;
    function np(t) {
      return (peN && peN.narrPlain) ? peN.narrPlain(t) : t;
    }
    var raw = m.content || '';
    if (idx === null || idx === undefined || m.role !== 'assistant') return np(raw);
    var arr = (peN && peN.splitBubbles) ? peN.splitBubbles(raw) : [raw];
    var out = (arr[idx] === null || arr[idx] === undefined) ? raw : arr[idx];
    /* 旁白（2026-10-25）：引用/收藏/编辑/TTS/灯牌这些消费面拿的是纯文本
       —— 括号剥掉、内文保留，半截尾巴也扣掉标记。 */
    return np(out);
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
    if (msg.type === 'we-proposal') {
      var pLabel = msg.sourceType === 'moment' ? '[记一笔]' : '[收藏提议]';
      return pLabel + (msg.title ? ' ' + msg.title : '');
    }
    if (msg.type === 'fwd-merged') return '[聊天记录]';
    if (msg.type === 'html') return '[小游戏]' + (msg.content ? ' ' + msg.content : '');
    if (msg.type === 'link-card') {
      var lp = msg.link || {};
      return '[' + platformLabel(lp.platform) + '链接] ' +
        (lp.title || lp.url || msg.content || '');
    }
    var raw = String(msg.content || '');
    var pe = Sleepy.promptEngine;
    if (pe && pe.splitBubblesT) {
      var b = pe.splitBubblesT(raw).bubbles;
      if (b && b.length) raw = b[b.length - 1] || raw;
    }
    /* 旁白（2026-10-25）：预览也是消费面，剥壳同 bubbleText */
    if (pe && pe.narrPlain) raw = pe.narrPlain(raw);
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

  /* 长按（触摸 480ms / 鼠标按住 480ms / 右键）打开菜单。
     手感（2026-10-07 用户：要微信那种「按住了」的感觉）：
     · 按住期间气泡轻微压暗（.lp-pressing），松手/触发即摘；
     · 触发瞬间 navigator.vibrate(10) 来一下微震动（Android 有效，
       iOS Safari 不支持 vibrate —— 没有替代 API，静默跳过）。 */
  function bindLongPress(el, fn) {
    var timer = null;
    var sx = 0, sy = 0;

    function clear() {
      if (timer) { clearTimeout(timer); timer = null; }
      el.classList.remove('lp-pressing');
    }
    function fire() {
      timer = null;
      el.classList.remove('lp-pressing');
      el.__lpAt = Date.now();
      try { if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(10); } catch (e) {}
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
      el.classList.add('lp-pressing');
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
      el.classList.add('lp-pressing');
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
    /* 每日日程生成器：同样只管喊 —— 模块自己按「自然日 × 岛」节流，
       开了「生成角色日程」开关的角色才排（schedule-gen.js） */
    if (Sleepy.scheduleGen) Sleepy.scheduleGen.maybeRun();
    return { rebuild: rebuild };
  }

  /* ======================= 页面：聊天详情 ======================= */

  Sleepy.register('chat-detail', {
    title: '聊天',
    render: function (ctx) {
      var chatId = ctx.params.chatId;
      /* 本闭包里 myMaskId（表情回应）/ 慢递信落库都裸用 `core` ——
         这里必须声明，否则点表情直接 `core is not defined`（真机 2026-10-07）。
         5543 行的 core2 是当年同一个坑的绕行痕迹，留着不动。 */
      var core = Sleepy.core;

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

      /* ---------------- 搜索聊天记录（顶栏放大镜） ----------------
         2026-10-28 重排（微信口径）：
           · 面板顶部留出状态栏的高度 —— 以前整面 inset:0，搜索条顶到
             手机框最上头，跟状态栏的时间/电量叠在一起；
           · 搜索框 + 「取消」一行，下面「搜索指定内容」分类网格 ——
             空态不再是一整面白，分类按我们自己的消息类型来；
           · 点分类 = 筛那一类，打字 = 全文搜，两态互切。
         面板盖在页面上；点结果跳到那条气泡。（收藏以后是独立的 App。） */
      var searchPanel = null;
      /* 再次打开搜索时的刷新动作（分类条数 / 概览要跟当下数据一致）。
         面板只建一次，所以刷新函数要挂在闭包外能拿到。 */
      var searchRefresh = null;
      var curMode = 'classic';   /* 当前聊天皮肤：classic / wecom / phone */
      /* 分类：跟着自己的消息类型走（图片/视频都是 type:'photo'?'video'，
         语音不是独立 type，是 msg.voice 附件，其余看 type 字段）。 */
      var SEARCH_CATS = [
        { id: 'media',    name: '图片与视频', match: function (m) { return m.type === 'photo' || m.type === 'video'; } },
        { id: 'file',     name: '文件',       match: function (m) { return m.type === 'file'; } },
        { id: 'link',     name: '链接',       match: function (m) { return m.type === 'link-card'; } },
        { id: 'voice',    name: '语音',       match: function (m) { return !!m.voice; } },
        { id: 'transfer', name: '转账',       match: function (m) { return m.type === 'transfer'; } },
        { id: 'sticker',  name: '表情包',     match: function (m) { return m.type === 'sticker'; } },
        { id: 'html',     name: '小游戏',     match: function (m) { return m.type === 'html'; } },
        { id: 'quote',    name: '带引用',     match: function (m) { return !!m.quote; } }
      ];
      function searchHitText(m) {
        /* 搜索结果条上的文字：**给人看的**摘要。
           不复用 attachText —— 那是喂模型的口径（"[你发了一张照片：…]"），
           摆到结果列表里又长又怪。这里按类型给一句人话。
           末尾统一压空白：气泡里可能带换行，列表里要是一行。 */
        var t = '';
        if (m) {
          switch (m.type) {
            case 'photo': t = String(m.caption || m.name || '一张照片'); break;
            case 'video': t = String(m.caption || m.name || '一段视频'); break;
            case 'file': t = String(m.name || '一个文件'); break;
            case 'link-card':
              t = String((m.link && (m.link.title || m.link.user)) || m.content || '一个链接'); break;
            case 'transfer': t = transferText(m); break;
            case 'sticker': t = String(m.name || '一个表情'); break;
            case 'html': t = String(m.content || '一个小游戏'); break;
            case 'pat': t = String(m.content || '拍一拍'); break;
            default:
              /* 语音：正文仍留在 content 里（只是气泡不显示），搜得到原文 */
              t = String(m.content || '');
              if (!t && m.voice) t = '一条语音';
          }
        }
        /* 协议标记必须剥掉（2026-10-28 修）：原文里存着 [旁白:…]，
           直接摆到结果列表里就是「[旁白:她抬起头…」—— 标记漏给用户看。
           markdown 的强调号也化掉，列表里要的是人话不是语法。 */
        t = stripProtocolTags(t);
        t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
             .replace(/\*([^*]+)\*/g, '$1')
             .replace(/`([^`]+)`/g, '$1');
        return String(t || '').replace(/\s+/g, ' ').trim();
      }
      function openSearch() {
        if (searchPanel) {
          searchPanel.classList.add('is-open');
          /* 面板是复用的（只建一次），条数与概览要跟当下的对话对上 */
          if (searchRefresh) searchRefresh();
          return;
        }
        searchPanel = h('div', 'chat-search');
        /* ⚠️ 建完必须立刻 is-open —— 原来漏了这一句（2026-10-28 修）：
           第一次点顶栏放大镜只是把面板建出来，屏幕上看不到任何变化，
           得点第二下才「啪」地弹出来。 */
        searchPanel.classList.add('is-open');

        var bar = h('div', 'chat-search-bar');
        var field = h('div', 'chat-search-field');
        field.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
          'stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
          '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/></svg>';
        var input = h('input', 'chat-search-input');
        input.type = 'text';
        input.placeholder = '搜索';
        field.appendChild(input);
        var closeBtn = h('button', 'chat-search-close', '取消');
        closeBtn.type = 'button';
        bar.appendChild(field);
        bar.appendChild(closeBtn);
        searchPanel.appendChild(bar);

        /* 空态：搜索指定内容的分类网格（微信那种，格子按我们的类型来）。
           每格后面带**条数**（这段对话里那一类有几条）——
           光一排词确实太空（用户 2026-10-28：「感觉整个搜索界面很空」），
           带上数字既填了空又告诉人哪一类值得点。 */
        var home = h('div', 'chat-search-home');
        home.appendChild(h('p', 'chat-search-cap', '搜索指定内容'));
        var grid = h('div', 'chat-search-cats');
        var cntEls = {};
        SEARCH_CATS.forEach(function (cat) {
          var b = h('button', 'chat-search-cat');
          b.type = 'button';
          b.appendChild(h('span', 'chat-search-cat-name', cat.name));
          var n = h('span', 'chat-search-cat-n', '');
          b.appendChild(n);
          cntEls[cat.id] = n;
          b.addEventListener('click', function () { runCatSearch(cat); });
          grid.appendChild(b);
        });
        home.appendChild(grid);
        searchPanel.appendChild(home);

        /* 下半屏：这段对话的概览（微信那一版下半屏是空的，我们填上
           「这段对话里有什么」—— 条数、时间跨度、最近一条）。
           空着确实像没做完（用户原话：「感觉整个搜索界面很空」）。 */
        var stat = h('div', 'chat-search-stat');
        searchPanel.appendChild(stat);
        function refreshStat() {
          var c = getChat(chatId);
          var msgs = (c && c.messages) || [];
          stat.innerHTML = '';
          var rows = [];
          rows.push(['这段对话', msgs.length + ' 条消息']);
          if (msgs.length) {
            var first = msgs[0].timestamp, last = msgs[msgs.length - 1].timestamp;
            var span = first && last ? (new Date(last) - new Date(first)) / 86400000 : 0;
            rows.push(['时间跨度', span >= 1 ? ('约 ' + span.toFixed(1) + ' 天') : '同一天']);
            rows.push(['最近一条', relativeTime(last)]);
          }
          rows.forEach(function (r) {
            var line = h('div', 'chat-search-stat-row');
            line.appendChild(h('span', 'chat-search-stat-k', r[0]));
            line.appendChild(h('span', 'chat-search-stat-v', r[1]));
            stat.appendChild(line);
          });
        }
        refreshStat();
        /* 再次打开搜索时，这两个都要重算（对话在这期间可能又长了） */
        searchRefresh = function () { refreshCounts(); refreshStat(); };

        var results = h('div', 'chat-search-results');
        searchPanel.appendChild(results);

        /* 挂到 #phone 上而不是页面里：页面自身会滚动，
           absolute 的面板要锚在手机框上才不会跟着内容跑 */
        var phone = document.getElementById('phone');
        (phone || ctx.el).appendChild(searchPanel);
        /* 下一帧再聚焦，避免盖面板的过渡吃掉键盘 */
        setTimeout(function () { input.focus(); }, 60);

        function showHome(on) {
          home.style.display = on ? '' : 'none';
        }
        /* 分类条数：每次打开搜索都重算一次（对话在这期间可能又长了） */
        function refreshCounts() {
          var c = getChat(chatId);
          var msgs = (c && c.messages) || [];
          SEARCH_CATS.forEach(function (cat) {
            var n = 0;
            for (var i = 0; i < msgs.length; i++) { if (cat.match(msgs[i])) n++; }
            var el = cntEls[cat.id];
            if (el) el.textContent = n ? String(n) : '';
          });
        }
        refreshCounts();
        function jumpTo(m) {
          searchPanel.classList.remove('is-open');
          var bubble = msgWrap.querySelector('[data-id="' + m.id + '"]');
          if (bubble) {
            bubble.scrollIntoView({ block: 'center' });
            bubble.classList.add('is-flash');
            setTimeout(function () { bubble.classList.remove('is-flash'); }, 1600);
          }
        }
        function pushHit(c, m, snippet) {
          var r = h('button', 'chat-search-hit');
          r.type = 'button';
          r.appendChild(h('span', 'chat-search-role',
            m.role === 'user' ? '我' : (charNameOf(c) || '角色')));
          r.appendChild(h('span', 'chat-search-text', snippet));
          r.addEventListener('click', function () { jumpTo(m); });
          results.appendChild(r);
        }

        /* 分类搜索：不需要关键词，直接筛那一类（最新 50 条） */
        function runCatSearch(cat) {
          var c = getChat(chatId);
          var msgs = (c && c.messages) || [];
          var hits = [];
          for (var i = msgs.length - 1; i >= 0 && hits.length < 50; i--) {
            if (cat.match(msgs[i])) hits.push(msgs[i]);
          }
          showHome(false);
          results.innerHTML = '';
          if (!hits.length) {
            results.appendChild(h('p', 'chat-search-empty', '没有「' + cat.name + '」的记录'));
            return;
          }
          hits.forEach(function (m) {
            var t = searchHitText(m);
            pushHit(c, m, t ? (t.length > 60 ? t.slice(0, 60) + '…' : t) : cat.name);
          });
        }

        closeBtn.addEventListener('click', function () {
          searchPanel.classList.remove('is-open');
        });

        input.addEventListener('input', function () {
          var q = String(input.value || '').trim().toLowerCase();
          results.innerHTML = '';
          if (!q) { showHome(true); return; }
          showHome(false);
          var c = getChat(chatId);
          var msgs = (c && c.messages) || [];
          var hits = [];
          for (var i = 0; i < msgs.length && hits.length < 50; i++) {
            var text = searchHitText(msgs[i]);
            if (text.toLowerCase().indexOf(q) >= 0) hits.push(msgs[i]);
          }
          if (!hits.length) {
            results.appendChild(h('p', 'chat-search-empty', '没找到'));
            return;
          }
          hits.forEach(function (m) {
            var text = searchHitText(m);
            var pos = text.toLowerCase().indexOf(q);
            var start = Math.max(0, pos - 18);
            var snippet = (start > 0 ? '…' : '') + text.slice(start, pos + q.length + 30) +
                          (start + q.length + 30 < text.length ? '…' : '');
            pushHit(c, m, snippet);
          });
        });
      }

      var body = ctx.body;

      /* -------- 只活在这一次拜访里的状态，不落盘 -------- */
      var reqSeq = 0;        /* 请求序号，旧回调一律丢弃 */
      var pending = null;    /* { text, timestamp, targetId } */
      /* 拟真节奏（2026-10-26 用户：「回复啪一下出来，没代入感」）：
         流式文本照常收，但气泡按真人打字的节奏**逐条**上屏 ——
         前一条收完（出现了下一个 || 边界）才排下一条，间隔按
         下一条的字数估打字时长。n = 已上屏的气泡数。 */
      var pendingReveal = { n: 0, timer: null };
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

      /* ---- 表情推荐条 ----
         在输入框里打了字，如果匹配到某张表情的**解释**，就在这儿横着排出来
         （左右可滑，防显示不全）。点一张直接发出去。
         用户：「输入某个文字之后可以匹配上对应的推荐表情包，
         并且推荐的表情包可以左右滑动显示，以防显示不完整」。 */
      var suggestBar = h('div', 'stk-suggest');
      foot.appendChild(suggestBar);

      /* 加号面板（2026-10-28 改微信样式）：挂到输入区**下面** ——
         点加号从输入框底下展开（微信手势），不再盖在输入框上头。
         ⚠️ 挂载顺序：必须在 inputArea 之后 appendChild，否则又跑到上面去了。 */
      var panel = h('div', 'plus-panel');

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

      /* 情绪印章：框内右侧一枚小图标钮（跟表情钮同款位置模式，有章才显示），
         点它开印章浮层 —— 再点同章就取消 */
      var moodBtn = h('button', 'mood-btn');
      moodBtn.type = 'button';
      moodBtn.title = '情绪印章';
      moodBtn.setAttribute('aria-label', '情绪印章');
      moodBtn.style.display = 'none';
      moodBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openMoodPicker(moodBtn);
      });
      inputWrap.appendChild(moodBtn);

      inputArea.appendChild(plusBtn);
      inputArea.appendChild(inputWrap);
      inputArea.appendChild(sendBtn);
      foot.appendChild(inputArea);
      /* 面板挂最后 = 展开在输入框**下方**（微信口径） */
      foot.appendChild(panel);

      /* ---- 情绪印章：点「我」的头像选一枚，章以小图标待在输入框**里面** ----
          （用户 2026-10-06 定稿：不是 chip 条、也不是消息气泡上盖章）
          pendingMoodStamp 是**当天**的章，渲染 / 发送都读它。 */
      var pendingMoodStamp = null;

      /* 跨天自动取消 + 从 session 恢复当天印章：
         印章状态持久化在 chat.moodStamp = { id, date, announcedId }，
         date 不是今天就当没盖过（第二天自动消失）。 */
      function syncMoodStamp() {
        var c = getChat(chatId);
        var st = c && c.moodStamp;
        if (st && st.date === todayStr()) {
          pendingMoodStamp = { id: st.id, date: st.date, announcedId: st.announcedId || null };
        } else {
          pendingMoodStamp = null;
          if (st) { mutate(chatId, function (cc) { cc.moodStamp = null; }); }
        }
        renderMoodChip();
      }

      /* 写印章状态：更新闭包变量 → 落盘 session → 刷新 chip。 */
      function setMoodStamp(obj) {
        pendingMoodStamp = obj;
        mutate(chatId, function (c) {
          c.moodStamp = obj ? { id: obj.id, date: obj.date, announcedId: obj.announcedId || null } : null;
        });
        renderMoodChip();
      }

      syncMoodStamp();

      function renderMoodChip() {
        var s = pendingMoodStamp ? stampById(pendingMoodStamp.id) : null;
        if (!s) {
          moodBtn.style.display = 'none';
          moodBtn.innerHTML = '';
          textarea.classList.remove('has-mood');
          return;
        }
        moodBtn.style.display = '';
        moodBtn.innerHTML = stampSvg(s.icon, 22);
        moodBtn.title = s.name + '（' + s.feel + '），点开可换 / 再点同章取消';
        textarea.classList.add('has-mood');   /* 右侧多让出印章那 30px */
      }

      /* 点头像弹出的印章选择浮层（ui.anchorPopover 贴着头像弹，点外面/ESC 自动收） */
      function openMoodPicker(anchorEl) {
        ui.closePopover();
        var pop = ui.anchorPopover(anchorEl, { className: 'mood-pop', width: '264px' });
        pop.el.appendChild(h('div', 'mood-pop-head', '给自己盖一枚印章'));
        var grid = h('div', 'mood-pop-grid');
        MOOD_STAMPS.forEach(function (s) {
          var item = h('button', 'mood-pop-item');
          item.type = 'button';
          item.title = '盖个「' + s.name + '」（' + s.feel + '）';
          if (pendingMoodStamp && pendingMoodStamp.id === s.id) item.classList.add('is-active');
          var ic = h('span', 'mood-pop-ic');
          ic.innerHTML = stampSvg(s.icon, 34);
          item.appendChild(ic);
          /* 2026-10-26 用户：「有点看不出每种代表什么情绪」—— 名字下面补情绪小字 */
          var lbl = h('span', 'mood-pop-label');
          lbl.appendChild(h('b', null, s.name));
          lbl.appendChild(h('span', 'mood-pop-feel', s.feel));
          item.appendChild(lbl);
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            if (pendingMoodStamp && pendingMoodStamp.id === s.id) {
              setMoodStamp(null);                                   /* 再点同章 → 取消 */
            } else {
              var keep = pendingMoodStamp ? pendingMoodStamp.announcedId : null;
              setMoodStamp({ id: s.id, date: todayStr(), announcedId: keep });  /* 新盖 / 切换 */
            }
            ui.closePopover();
            try { textarea.focus(); } catch (e2) { /* 无头环境忽略 */ }
          });
          grid.appendChild(item);
        });
        pop.el.appendChild(grid);
        pop.place();
      }

      /* 纯盖章（没打字）的消息气泡：一枚印章 + 章名。
         带文字的盖章消息走普通文字气泡（正文用 text，不带感知前缀）。 */
      function moodStampBubble(msg) {
        var wrap = h('div', 'mood-bubble');
        var s = stampById(msg.mood);
        var badge = h('span', 'mood-bubble-stamp');
        badge.innerHTML = stampSvg((s && s.icon) || 'flower', 30);
        if (s) badge.title = s.name + '（' + s.feel + '）';
        wrap.appendChild(badge);
        wrap.appendChild(h('span', 'mood-bubble-label', (s && s.name) || '印章'));
        return wrap;
      }

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
      var lastRenderedTs = 0;
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

      var renderedMsgCount = -1, renderedLastId = null, renderedChatId = null;
      function renderMessages(keepScroll) {
        var prev = msgWrap.scrollTop;
        var c = getChat(chatId);
        if (!c) return;
        /* 切到别的会话：缓存作废，强制全量重画（否则会把新会话末条
           误当成「上一条的增量」append 到旧 DOM 上）。 */
        if (renderedChatId !== chatId) { renderedMsgCount = -1; renderedLastId = null; }

        /* 增量快路径：仅末尾新增了一条、且贴底 —— 只 append 那一条，
           不再把整屏消息重画一遍（长聊每次新消息原来都 O(n) 全量重画）。
           有 pending 残 nodes 时先清掉（流式结束落库瞬间）。 */
        if (!keepScroll && renderedMsgCount >= 0 && renderedChatId === chatId &&
            c.messages.length === renderedMsgCount + 1 &&
            renderedLastId && c.messages[c.messages.length - 1].id !== renderedLastId) {
          var nm = c.messages[c.messages.length - 1];
          if (!pending) {
            var pend = msgWrap.querySelectorAll('.msg-bubble.is-pending');
            for (var pi = 0; pi < pend.length; pi++) pend[pi].remove();
          }
          try {
            curMode = (Sleepy.charAppearance
              ? (Sleepy.charAppearance.resolve(c.characterId).mode || 'classic')
              : 'classic') || 'classic';
          } catch (e) { curMode = 'classic'; }
          renderOneMessage(nm, c);
          if (pending && !pending.targetId) msgWrap.appendChild(pendingBubbles());
          pruneGameCache(c);
          syncBubbleDots();
          renderedMsgCount = c.messages.length;
          renderedLastId = nm.id;
          renderedChatId = chatId;
          stickBottom = true; toBottom();
          return;
        }

        /* 全量重画（结构性变更 / 首屏 / 切会话 / keepScroll） */
        msgWrap.innerHTML = '';
        voiceBars = {};
        try {
          curMode = (Sleepy.charAppearance
            ? (Sleepy.charAppearance.resolve(c.characterId).mode || 'classic')
            : 'classic') || 'classic';
        } catch (e) { curMode = 'classic'; }

        lastRenderedTs = 0;
        c.messages.forEach(function (m) { renderOneMessage(m, c); });
        if (pending && !pending.targetId) msgWrap.appendChild(pendingBubbles());

        pruneGameCache(c);
        syncBubbleDots();
        renderedMsgCount = c.messages.length;
        renderedLastId = c.messages.length ? c.messages[c.messages.length - 1].id : null;
        renderedChatId = chatId;
        if (keepScroll) msgWrap.scrollTop = prev;
        else { stickBottom = true; toBottom(); }   /* 重画＝用户要看新的那条 */
      }

      /* 单条消息渲染（时间分隔线 + 撤回 + 分段气泡），全量/增量共用一套 */
      function renderOneMessage(m, c) {
        var ts = m.timestamp || 0;
        var showSep = !lastRenderedTs || ts - lastRenderedTs >= 5 * 60 * 1000;
        if (showSep) {
          msgWrap.appendChild(h('div', 'msg-time-sep', timeSepLabel(ts)));
        }
        if (ts) lastRenderedTs = ts;
        if (m.recalledAt) { msgWrap.appendChild(recallLine(m)); return; }
        var segs = bubbleSegs(m);
        segs.forEach(function (seg, i) {
          msgWrap.appendChild(bubbleFor(m, c, {
            text: seg.text, trans: seg.trans, idx: i, total: segs.length,
            /* 2026-10-26 用户：分隔线刚标过时间，气泡下面的时间戳就是复读 —— 藏掉 */
            hideTime: showSep
          }));
        });
      }

      /* 游戏卡缓存 prune：只留当前会话里还活着的 type:'html' 消息 */
      function pruneGameCache(c) {
        gameCardCache.forEach(function (_node, mid) {
          var alive = false;
          for (var mi = 0; mi < c.messages.length; mi++) {
            if (c.messages[mi].id === mid && c.messages[mi].type === 'html') { alive = true; break; }
          }
          if (!alive) gameCardCache.delete(mid);
        });
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

      /* 撤回灰字条（2026-10-06）。文案分两个方向：我撤回的 / TA 撤回的。
         点击弹浮层：撤回的内容 + 原因（原因只有角色撤回才写）。
         不挂长按菜单 —— 撤回条不是话，跟拍一拍一个待遇。 */
      function recallLine(m) {
        var ch = findCharacter(curCharId());
        var label = m.role === 'user'
          ? '你撤回了一条消息'
          : '「' + (ch ? ch.name : '对方') + '」撤回了一条消息';
        var line = h('div', 'msg-recall', label);
        line.addEventListener('click', function () {
          if (selecting) return;            /* 多选模式里灰字条不参与选择 */
          if (wasLongPressed(line)) return;
          var pop = ui.anchorPopover(line, { className: 'msg-pop', arrow: true });
          var box = h('div', 'msg-recall-pop');
          box.appendChild(h('p', 'msg-recall-pop-label', '撤回的内容'));
          box.appendChild(h('p', 'msg-recall-pop-text',
            (bubbleText(m) || '（一条消息）').replace(/\s*\|\|\s*/g, '\n')));
          if (m.recallReason) {
            box.appendChild(h('p', 'msg-recall-pop-label', '撤回原因'));
            box.appendChild(h('p', 'msg-recall-pop-text', m.recallReason));
          }
          pop.el.appendChild(box);
          pop.place();
        });
        return line;
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

      /* ===== 受限 markdown 渲染 + 残留协议标签兜底（整体手感 2026-10-06）=====
         只认：粗体 **x** / 斜体 *x* _x_ / 行内代码 `x` / 代码块 ``` / 引用 > /
         有序·无序列表 / 安全链接 [t](http(s)://…)。
         禁止裸 HTML、<script>、内联事件、javascript: —— 文本走 textContent、
         结构走 createElement，天然消毒；XSS 无从下手。
         气泡条数/字数不限制（分段仍由模型 || 控制）。 */
      var REACTION_EMOJIS = ['😊', '❤️', '😂', '😮', '😢', '👍', '🎉', '✨'];

      function myMaskId() {
        var u = (core && core.activeUserOnIsland && core.activeUserOnIsland()) ||
                (core && core.activeUser && core.activeUser());
        return (u && u.id) || 'me';
      }

      /* 把协议中不应出现的标签剥掉，避免字面显示在气泡里
         （[译]…[/译] 由 splitBubblesT 抽译文，这里再兜底一遍）。 */
      function stripProtocolTags(s) {
        var out = String(s || '')
          .replace(/\[(?:html|sticker|whisper|WHISPER|think|reasoning|img|voice|emotion)\b[^\]]*\]/g, '')
          .replace(/\[\/?译\]/g, '')
          .replace(/<\/?(?:think|reasoning)>/gi, '');
        /* 旁白兜底剥壳（2026-10-29 起交回引擎同一份扫描器）：全角括号/
           嵌套方括号/半截尾巴都认 —— 本地不再养第二套旁白正则，
           两套口径漂移就是「时不时漏一个 [旁白: 出来」的源头。 */
        var peS = Sleepy.promptEngine;
        return (peS && peS.narrPlain) ? peS.narrPlain(out) : out;
      }

      /* markdown 渲染走 ui 层的**共用一份**（2026-10-28 提到 ui.js）：
         线上气泡 / 旁白叙事条 / 线下叙事段落同一套语法与同一套消毒规则。
         这里只留两个薄壳，页面内所有调用点不用改。 */
      function mdInline(text, node) { ui.mdInline(text, node); }
      function renderMdText(text, el) { ui.renderMd(text, el); }

      function renderRichText(raw, el) {
        el.innerHTML = '';
        /* 旁白描述（2026-10-25）：有旁白标记时按段拆 —— 旁白段画成叙事条
           （.msg-narr，方案 A），普通段走原 markdown 路径。narrSegments
           不在（老引擎缓存缺失等）时由 stripProtocolTags 兜底剥壳，
           [旁白: 三个字任何情况下都不许出现在气泡上。 */
        var peNarr = Sleepy.promptEngine;
        var segs = (peNarr && peNarr.narrSegments) ? peNarr.narrSegments(raw) : null;
        if (segs && segs.some(function (sg) { return sg.n; })) {
          var narrMade = false;
          segs.forEach(function (sg) {
            var t = stripProtocolTags(sg.text || '').trim();
            if (!t) return;
            if (sg.n) {
              var d = h('div', 'msg-narr');
              /* 走块级渲染而不是 mdInline（2026-10-28 用户报「旁白掉格式」）：
                 旁白常常一口气写好几行，mdInline 只做行内替换，文本节点里的
                 \n 会被 HTML 折叠成空格 —— 换行全没。renderMdText 按行拆段，
                 列表/引用/代码块也一并保得住，叙事条里照样吃 markdown。 */
              renderMdText(t, d);
              el.appendChild(d);
              narrMade = true;
            } else {
              renderMdText(t, el);
            }
          });
          if (narrMade) return;
          /* 一段旁白都没画出来（全是空段）：退回普通路径，别给空气泡 */
          el.innerHTML = '';
        }
        var text = stripProtocolTags(raw);
        if (!text) return;
        renderMdText(text, el);
      }

      /* 长按菜单里点 emoji → 给**这个气泡**贴/取消表情回应（QQ/企微风）。
         2026-10-07 用户：一条回复拆成几段时，只贴被长按的那一段，不是整轮。
         存储 msg.reactions = { segKey: { emoji: [maskId,…] } }，segKey 是段下标
         的字符串（无分段的按 '0'）。旧数据 { emoji: [maskId,…] } 在读取时
         统一归一化到 '0' —— 老的贴纸本来就显示在每一段下面，迁到第一段最接近原意。
         落库走 patchMessage（store.get 深拷贝，不能直接拿对象改字段）。 */
      function normReactions(r) {
        var out = {};
        if (!r) return out;
        for (var k in r) {
          if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
          if (Array.isArray(r[k])) {
            var seg0 = out['0'] || (out['0'] = {});
            seg0[k] = r[k].slice();
          } else if (r[k] && typeof r[k] === 'object') {
            for (var sk in r[k]) {
              if (!Object.prototype.hasOwnProperty.call(r[k], sk)) continue;
              var seg = out[sk] || (out[sk] = {});
              seg[k] = (r[k][sk] || []).slice();
            }
          }
        }
        return out;
      }
      function toggleReaction(msg, emoji, segIdx) {
        if (!msg || !msg.id) return;
        var segKey = String(segIdx == null ? 0 : segIdx);
        var id = myMaskId();
        var next = normReactions(msg.reactions);
        var seg = next[segKey] || (next[segKey] = {});
        var cur = seg[emoji] || [];
        var set = (cur.indexOf(id) >= 0)
          ? cur.filter(function (x) { return x !== id; })
          : cur.concat([id]);
        if (set.length) seg[emoji] = set; else delete seg[emoji];
        if (!Object.keys(seg).length) delete next[segKey];
        patchMessage(chatId, msg.id, { reactions: next });
        renderMessages();
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
           没有头像、没有重答 —— 它是个动作记录，不是话。
           但能删（2026-10-29 用户：系统信息也要能删）—— 长按只给删除。 */
        if (msg.type === 'pat') {
          var patEl = h('div', 'msg-pat', msg.content || '拍了拍');
          patEl.setAttribute('data-id', msg.id);
          bindLongPress(patEl, function () { openSysMenu(msg, patEl); });
          return patEl;
        }
        /* 文字麻将牌桌播报：同拍一拍的居中灰字位 —— 是系统播报，不是话。 */
        if (msg.type === 'wm') {
          return h('div', 'msg-pat msg-wm-line', msg.content || '');
        }
        /* 反查手机播报（2026-10-29 改版）：不再是一坨糊在一起的文字 ——
           一张小卡：谁翻了 + 翻了哪些面 + 他当时的心声。长按可删。 */
        if (msg.type === 'revcheck') {
          var revEl = h('div', 'msg-rev-row');
          revEl.setAttribute('data-id', msg.id);
          revEl.appendChild(revCard(msg));
          bindLongPress(revEl, function () { openSysMenu(msg, revEl); });
          return revEl;
        }
        /* 递手机邀请卡：居中动作卡（user 的动作记录，不是话）。长按可删。 */
        if (msg.type === 'rev-invite') {
          var invEl = h('div', 'msg-pat msg-rev-invite', '📱 ' + (msg.content || '递出了手机'));
          invEl.setAttribute('data-id', msg.id);
          bindLongPress(invEl, function () { openSysMenu(msg, invEl); });
          return invEl;
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
          lens.setAttribute('data-key', lensKey);
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
        /* 多选勾的定位锚：翻勾直接按 data-key 找到这个气泡翻类，
           不整流重画（见 toggleSelect 那段说明） */
        bubble.setAttribute('data-key', myKey);
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
        } else if (msg.type === 'fwd-merged') {
          content.appendChild(fwdCard(msg));
        } else if (msg.type === 'html') {
          content.appendChild(htmlGameCard(msg, chatId));
        } else if (msg.type === 'link-card') {
          content.appendChild(linkCard(msg));
        } else if (msg.type === 'qunsheng-share') {
          content.appendChild(qunshengCard(msg));
        } else if (msg.mood && !((msg.text || '').trim())) {
          /* 纯盖章（没打字）：气泡就是这枚印章本身 */
          content.appendChild(moodStampBubble(msg));
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
            /* 盖章消息的正文用 text（干净原话）—— content 里带感知文案前缀，
               那是给角色读的，不直接摆到气泡上 */
            shown = seg ? (seg.text || '（空）')
              : (msg.mood ? (msg.text || '（空）') : (msg.content || '（空）'));
            renderRichText(shown, textEl);
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

        if (msg.quote && (!seg || seg.idx === 0)) {
          /* 引用条（2026-10-29 用户口径）：挂在**气泡下面**的一行小灰字
             「名字：内容」，字多两行截断。样式见 .msg-quote —— 它不参与
             气泡宽度，长引用不会把一两个字的短气泡撑宽。
             ⚠️ 只挂第一条气泡：一轮回复拆成几段时（a || b || c），
             引用条跟着整条回复走，不该每段气泡下面都复读一遍。 */
          var qName = '对方';
          if (msg.quote.role === 'user') qName = '我';
          else if (msg.quote.name) qName = msg.quote.name;
          else {
            var qc = getChat(chatId);
            var qch = qc && qc.characterId ? findCharacter(qc.characterId) : null;
            if (qch && qch.name) qName = qch.name;
          }
          content.appendChild(h('div', 'msg-quote', qName + '：' + msg.quote.content));
        }

        var meta = h('div', 'msg-meta');
        /* 分隔线刚标过同一时间就不复读（2026-10-26 用户报双时间戳） */
        if (!(seg && seg.hideTime)) {
          meta.appendChild(h('span', 'msg-time', timeStr(msg.timestamp)));
        }

        var isLast = c.messages[c.messages.length - 1] === msg;
        /* 停止按钮已撤（2026-10-28 用户：气泡上不再给停止键，等回复就等）；
           reroll 也挪进加号面板（「重说」），气泡 meta 只剩时间。 */
        if (role === 'assistant' && msg.type === 'photo' && msg.subject && isLast && !pending) {
          /* TA 发的图可以重画：同 subject 重新生成，原地替换 */
          meta.appendChild(redrawBtn(msg));
        }
        content.appendChild(meta);

        /* 表情回应药丸（QQ/企微风长按贴表情）：挂在气泡正文下方。
           只显示**这一段**的回应（normReactions 按段取）。 */
        var segKey0 = String(seg && seg.idx != null ? seg.idx : 0);
        var segReactions = normReactions(msg.reactions)[segKey0] || {};
        var rk = Object.keys(segReactions).filter(function (k) {
          return (segReactions[k] || []).length;
        });
        if (rk.length) {
          var rrow = h('div', 'msg-reactions');
          var mid0 = myMaskId();
          rk.forEach(function (k) {
            var arr = segReactions[k] || [];
            var chip = h('button', 'msg-reaction', k + (arr.length > 1 ? ' ' + arr.length : ''));
            chip.type = 'button';
            if (arr.indexOf(mid0) >= 0) chip.classList.add('is-mine');
            chip.addEventListener('click', function (e) {
              e.stopPropagation();
              toggleReaction(msg, k, seg ? seg.idx : 0);
            });
            rrow.appendChild(chip);
          });
          content.appendChild(rrow);
        }

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

      /* ---------------- HTML 小游戏卡（沙箱 iframe） ----------------

         安全模型（这条别动）：sandbox="allow-scripts" **不给**
         allow-same-origin —— 游戏拿不到 localStorage / cookie /
         父页 DOM，会话数据摸不着；再叠一层 CSP 把出网全堵死
         （default-src 'none'，只放行内联脚本/样式和 data:/blob: 图）。
         也就是说 TA 写的游戏只能玩，不能看也不能说。

         结算：包装时注入一段固定 bridge（把 SleepyGame.report 暴露给
         游戏），report 走 postMessage 出沙箱；父页只认 registerGameFrame
         登记过的窗口 —— 别的页面乱发 postMessage 报不上来。

         全屏是**重开一个新 iframe**（同一个 srcdoc）：iframe 挪窝必重载，
         干脆明 Restart；小游戏丢一局进度不心疼。 */
      function wrapGameDoc(msg) {
        var bridge = '(function(){function r(s,t){try{parent.postMessage(' +
          '{__sleepyHtmlResult:1,score:(typeof s==="number"&&isFinite(s))?s:null,' +
          'text:String(t==null?"":t).slice(0,120)},"*")}catch(e){}}' +
          'window.SleepyGame={report:r};})();';
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<meta http-equiv="Content-Security-Policy" content="' +
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
          "img-src data: blob:; media-src data: blob:; font-src data:;\"></head>" +
          '<body>' + (msg.html || '') +
          '<script>' + bridge + '</script></body></html>';
      }
      function mountGameFrame(container, msg, chatId, cls) {
        var frame = document.createElement('iframe');
        if (cls) frame.className = cls;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('title', msg.content || 'TA 的小游戏');
        frame.srcdoc = wrapGameDoc(msg);
        container.appendChild(frame);
        registerGameFrame(frame.contentWindow);
        gameFrameMeta.set(frame.contentWindow, { chatId: chatId, msgId: msg.id });
        return frame;
      }
      /* 重绘复用：游戏卡按 msgId 缓存同一节点。renderMessages 每次
         msgWrap.innerHTML='' 只是把节点摘下来，同对象重新 appendChild 回去
         不会重载 iframe（跨文档移动 / 摘下再插回都保住 browsing context），
         所以玩到一半来新消息也不会从头来。换房 / 删消息时由 renderMessages
         末尾的 prune 清掉失效条目，避免跨会话串台或内存泄漏。 */
      var gameCardCache = new Map();
      function htmlGameCard(msg, chatId) {
        var cached = gameCardCache.get(msg.id);
        if (cached) return cached;          /* 复用旧节点，游戏状态连续 */
        var card = h('div', 'msg-htmlgame');
        var head = h('div', 'msg-htmlgame-head');
        head.appendChild(h('span', 'msg-htmlgame-title', msg.content || 'TA 做的小玩意'));
        var full = h('button', 'msg-htmlgame-fs', '全屏');
        full.type = 'button';
        full.addEventListener('click', function (e) {
          e.stopPropagation();
          openGameViewer(msg, chatId);
        });
        head.appendChild(full);
        card.appendChild(head);
        mountGameFrame(card, msg, chatId, 'msg-htmlgame-frame');
        if (msg.truncated) {
          card.appendChild(h('div', 'msg-htmlgame-note', '内容超长被截断，可能显示不全'));
        }
        /* 点卡片空白不触发气泡的引用/多选 —— 游戏里有按钮，别抢事件 */
        card.addEventListener('click', function (e) { e.stopPropagation(); });
        gameCardCache.set(msg.id, card);
        return card;
      }
      function openGameViewer(msg, chatId) {
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'gamev-mask');
        var closed = false;
        function close() {
          if (closed) return;
          closed = true;
          mask.classList.remove('is-open');
          setTimeout(function () {
            if (mask.parentNode) mask.parentNode.removeChild(mask);
          }, 200);
        }
        var head = h('div', 'gamev-head');
        head.appendChild(h('span', 'gamev-title', msg.content || 'TA 做的小玩意'));
        var x = h('button', 'gamev-close', '关闭');
        x.type = 'button';
        x.addEventListener('click', close);
        head.appendChild(x);
        mask.appendChild(head);
        var body = h('div', 'gamev-body');
        mountGameFrame(body, msg, chatId, 'gamev-frame');
        mask.appendChild(body);
        host.appendChild(mask);
        requestAnimationFrame(function () { mask.classList.add('is-open'); });
        document.addEventListener('keydown', function onKey(e) {
          if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
        });
        return mask;
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

      /* 合并转发的「聊天记录」卡（仿微信）：标题 + 前几条摘要 + 「聊天记录」脚注。
         点开能看完整原对话（openFwdViewer）。多选模式下点它 = 勾选，
         平时点它 = 看记录 —— 所以把判断交给 selecting。 */
      function fwdCard(msg) {
        var card = h('div', 'msg-fwd');
        card.appendChild(h('div', 'msg-fwd-title', msg.title || '聊天记录'));
        var its = Array.isArray(msg.items) ? msg.items : [];
        its.slice(0, 3).forEach(function (it) {
          card.appendChild(h('div', 'msg-fwd-line',
            (it.name ? it.name + '：' : '') + String(it.text || '').slice(0, 40)));
        });
        if (its.length > 3) card.appendChild(h('div', 'msg-fwd-line is-more', '…'));
        card.appendChild(h('div', 'msg-fwd-foot', '聊天记录'));
        card.addEventListener('click', function (e) {
          if (selecting) return;          /* 多选中：让气泡自己的勾选逻辑接管 */
          e.stopPropagation();
          openFwdViewer(msg);
        });
        return card;
      }

      /* 聊天记录查看器：全屏浮层，按原说话人左右分侧（user 在右）。 */
      function openFwdViewer(msg) {
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'fwd-view-mask');
        var panel = h('div', 'fwd-view');
        var closed = false;
        function close() {
          if (closed) return;
          closed = true;
          mask.classList.remove('is-open');
          panel.classList.remove('is-open');
          setTimeout(function () {
            if (mask.parentNode) mask.parentNode.removeChild(mask);
            if (panel.parentNode) panel.parentNode.removeChild(panel);
          }, 200);
        }

        var head = h('div', 'fwd-view-head');
        head.appendChild(h('span', 'fwd-view-title', msg.title || '聊天记录'));
        var x = h('button', 'fwd-view-close', '关闭');
        x.type = 'button';
        x.addEventListener('click', close);
        head.appendChild(x);

        var body = h('div', 'fwd-view-body');
        var meName = userNameOf(getChat(chatId));
        var prevT = 0;
        (Array.isArray(msg.items) ? msg.items : []).forEach(function (it) {
          var t = it.t || 0;
          if (!prevT || t - prevT >= 5 * 60 * 1000) {
            body.appendChild(h('div', 'msg-time-sep', timeSepLabel(t)));
          }
          if (t) prevT = t;
          var row = h('div', 'fwd-view-row' + (it.role === 'user' ? ' is-me' : ''));
          row.appendChild(h('span', 'fwd-view-name', it.name || (it.role === 'user' ? meName : '')));
          row.appendChild(h('div', 'fwd-view-bubble', String(it.text || '') || '（空）'));
          body.appendChild(row);
        });

        panel.appendChild(head);
        panel.appendChild(body);
        mask.addEventListener('click', close);
        host.appendChild(mask);
        host.appendChild(panel);
        setTimeout(function () { mask.classList.add('is-open'); panel.classList.add('is-open'); }, 20);
      }

      /* 链接卡（仿微信分享卡）：标题两行 + 右侧小缩略图 + 底部来源行。
         元数据没拉到之前是占位（标题=平台名）。点卡片开原链接。
         缩略图必须 referrerpolicy=no-referrer —— 新浪图床有防盗链，
         带 referer 一律 403。 */
      function linkCard(msg) {
        var lk = msg.link || {};
        var card = h('div', 'msg-link is-' + (lk.platform || 'generic'));
        var row = h('div', 'msg-link-row');
        var main = h('div', 'msg-link-main');
        main.appendChild(h('div', 'msg-link-title',
          lk.title || platformLabel(lk.platform) + '链接'));
        if (lk.user) main.appendChild(h('div', 'msg-link-sub', '@' + lk.user));
        if (lk.stats) main.appendChild(h('div', 'msg-link-meta', lk.stats));
        row.appendChild(main);
        if (lk.img) {
          var im = h('img', 'msg-link-thumb');
          im.referrerPolicy = 'no-referrer';
          im.alt = '';
          im.addEventListener('error', function () {
            if (im.parentNode) im.parentNode.removeChild(im);
          });
          im.src = lk.img;
          row.appendChild(im);
        }
        card.appendChild(row);
        card.appendChild(h('div', 'msg-link-src', platformLabel(lk.platform)));
        card.addEventListener('click', function (e) {
          if (selecting) return;
          if (wasLongPressed(card)) return;
          e.stopPropagation();
          /* 分享文案卡可能没有 url（纯「O网页链接」没复制到）——
             这时 content 是整段文案不是链接，别把它塞给 window.open */
          var openTarget = lk.url || '';
          if (!openTarget && /^https?:\/\/\S+$/i.test(String(msg.content || '').trim())) {
            openTarget = String(msg.content).trim();
          }
          if (!openTarget) return;
          try { window.open(openTarget, '_blank'); } catch (err) { /* 弹窗被拦就拦吧 */ }
        });
        return card;
      }

      /* 群声帖子卡（施工卡-群声-v1 Batch C）：payload 与权限复检全在
         Sleepy.forumShare（forum-share.js）—— 这里只渲染 + 点击跳原帖。
         附言（msg.content）按普通文字气泡显示在卡片上方，微信转发那套。
         点卡片显式带 sandboxId + postId 回来源岛（active 停在别的岛也对）。 */
      function qunshengCard(msg) {
        var box = h('div', 'msg-qs-share');
        if (String(msg.content || '').trim()) {
          var note = h('div', 'msg-text');
          note.textContent = msg.content;
          box.appendChild(note);
        }
        box.appendChild(Sleepy.forumShare.cardEl(msg, function (qs) {
          /* 回执（Batch D）：接收方打开了 → 给分享者记一条（只状态不正文） */
          var ch = getChat(chatId);
          var who = ch && ch.characterId && findCharacter(ch.characterId);
          Sleepy.forumShare.markOpened({
            sandboxId: qs.sandboxId, sourcePostId: qs.sourcePostId,
            targetType: 'chat', targetId: chatId,
            openerName: who ? who.name : '对方',
            openerEntityId: who ? who.id : null
          });
          /* char 在聊天里直接回一句（user 2026-10-07 点名）：
             单次模型调用、60s 冷却、失败静默；同时帖子里也可能有回应。 */
          var post0 = Sleepy.forum.getPost(qs.sourcePostId, qs.sandboxId);
          if (who && post0 && Sleepy.forumGen) {
            Sleepy.forumGen.charReactToShare({
              sandboxId: qs.sandboxId, chatId: chatId, charId: who.id,
              postTitle: post0.title, postContent: post0.content,
              attachedText: String(msg.content || '')
            }, function (err2) {
              if (!err2 && Sleepy.nav.top() === 'chat-detail' &&
                  Sleepy.nav.topCtx() && Sleepy.nav.topCtx().params.chatId === chatId) {
                /* 还停在这个会话就刷新一下，别让回复悄悄躺在下面 */
                Sleepy.nav.topCtx().refresh && Sleepy.nav.topCtx().refresh();
              }
            });
            Sleepy.forumGen.queueReplies(qs.sourcePostId, 3000);
          }
          ctx.open('qunsheng-post', { sandboxId: qs.sandboxId, postId: qs.sourcePostId });
        }));
        return box;
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
        if (msg.type === 'video' && msg.mediaId && Sleepy.media) {
          var vbox = h('div', 'msg-video');
          var vv = h('video', 'msg-video-el');
          vv.controls = true; vv.preload = 'metadata';
          vv.setAttribute('playsinline', '');
          Sleepy.media.url(msg.mediaId).then(function (src) {
            if (src) vv.src = src;
          });
          vbox.appendChild(vv);
          if (msg.caption) vbox.appendChild(h('div', 'msg-video-cap', msg.caption));
          return vbox;
        }

        if (msg.type === 'photo' && msg.mediaId && Sleepy.media) {
          /* 拍立得（FlipPolaroid 移植，2026-10-25）：带背面寄语的照片
             渲染成 3D 翻面卡——**点图片区域=放大**（复用 imageViewer），
             **点卡片其他区域=翻面**看背面寄语。没有寄语 = 普通照片。 */
          if (msg.backNote && String(msg.backNote).trim()) {
            return polaroidCard(msg);
          }
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

      /** 拍立得翻面卡。交互分区（用户定稿）：
          · 点**图片** → 放大（ui.imageViewer，和普通照片一个手感）
          · 点**卡片其他区域**（白框/背面） → 翻面看寄语
          结构：.pld（perspective）> .pld-inner（preserve-3d，翻转在这里）
          > .pld-front / .pld-back（backface-visibility 互斥面）。 */
      function polaroidCard(msg) {
        var card = h('button', 'pld');
        card.type = 'button';
        var inner = h('span', 'pld-inner');
        var front = h('span', 'pld-face pld-front');
        var back = h('span', 'pld-face pld-back');
        var img = h('img', 'pld-img');
        img.alt = msg.caption || '照片';
        front.appendChild(img);
        front.appendChild(h('span', 'pld-hint', '✦ 点图片看大图 · 点白边翻面 ✦'));

        back.appendChild(h('span', 'pld-note', String(msg.backNote)));
        var d = new Date(msg.timestamp || Date.now());
        back.appendChild(h('span', 'pld-date',
          '· ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ·'));
        back.appendChild(h('span', 'pld-brand', 'POLAROID'));

        inner.appendChild(front);
        inner.appendChild(back);
        card.appendChild(inner);

        var shown = false;
        Sleepy.media.url(msg.mediaId).then(function (src) {
          if (src) { img.src = src; shown = true; return; }
          card.classList.add('is-missing');
          front.appendChild(h('span', 'msg-photo-miss', '这张图找不到了'));
        }, function () {
          card.classList.add('is-missing');
          front.appendChild(h('span', 'msg-photo-miss', '图库打不开'));
        });

        img.addEventListener('click', function (e) {
          e.stopPropagation();
          if (shown) ui.imageViewer(img.src, { caption: msg.caption || '', alt: img.alt });
        });
        card.addEventListener('click', function () { card.classList.toggle('is-flipped'); });
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
        segs.forEach(function (t, i) {
          /* 拟真节奏：只画「已揭示」的段；后面的泡先给打字点等着 */
          frag.appendChild(pendingOne(i < pendingReveal.n ? t : ''));
        });
        return frag;
      }
      /* ---- 揭示调度（配套 pendingReveal，见状态声明处）---- */
      function revealDelayOf(text) {
        var len = String(text || '').length;
        return Math.max(500, Math.min(2200, 350 + len * 45));
      }
      function revealReset() {
        if (pendingReveal.timer) { clearTimeout(pendingReveal.timer); pendingReveal.timer = null; }
        pendingReveal.n = 0;
      }
      function scheduleReveal(segs) {
        if (pendingReveal.timer || !pending) return;
        if (pendingReveal.n > 0 && pendingReveal.n < segs.length) {
          pendingReveal.timer = setTimeout(revealNext, revealDelayOf(segs[pendingReveal.n]));
        }
      }
      function revealNext() {
        pendingReveal.timer = null;
        if (!pending) return;
        var segs = pendingSegs();
        if (pendingReveal.n <= 0 || pendingReveal.n >= segs.length) return;
        pendingReveal.n += 1;
        /* 新揭示的这泡直接涂文本 —— 气泡和打字点首帧就在身上，不用整页重画 */
        var lives = msgWrap.querySelectorAll('.msg-bubble.is-pending .msg-text');
        if (lives.length === segs.length && lives[pendingReveal.n - 1]) {
          lives[pendingReveal.n - 1].textContent = segs[pendingReveal.n - 1];
        } else {
          renderMessages();
        }
        msgWrap.scrollTop = msgWrap.scrollHeight;
        scheduleReveal(segs);
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
        content.appendChild(meta);
        bubble.appendChild(content);
        return bubble;
      }

      /* reroll 挪进加号面板（2026-10-28 用户：气泡上不再挂 reroll）。
         面板点「重说」= 对**最后一条**助手正文回复发起重说 ——
         和原来挂气泡尾的条件一致（isLast && !type），只是入口变了。 */
      function rerollFromPanel() {
        closePanel();
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }
        var c = getChat(chatId);
        var msgs = (c && c.messages) || [];
        var last = null;
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && !msgs[i].type) { last = msgs[i]; break; }
        }
        if (!last) { ctx.toast('还没有可以重说的回复', 'warn'); return; }
        startReroll(last);
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
        var txt = s.bubbles ? s.bubbles.join('\n') : s.visible;
        /* 旁白（2026-10-25）：流式里也剥壳 —— 完整的留内文，半截的扣标记，
           别让 [旁白: 在打字机里闪出来。落库后渲染层再画成叙事条。 */
        return (Sleepy.promptEngine && Sleepy.promptEngine.narrPlain)
          ? Sleepy.promptEngine.narrPlain(txt) : txt;
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
        /* 勾直接翻在现有 DOM 上，**别整流重画** —— 重画会把照片/表情的
           <img> 整个重新挂载，高度在 scrollTop 恢复之后才长回来，
           眼前这段就上下跳（用户 2026-10-06：多选时点气泡还是会上移/下移）。
           勾是 absolute 定位的 ::after，不占布局，翻类零位移。 */
        var el = msgWrap.querySelector('[data-key="' + key + '"]');
        if (el) el.classList.toggle('is-selected', !!selected[key]);
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

        var fwd = h('button', 'msg-select-act', '转发');
        fwd.type = 'button';
        fwd.addEventListener('click', function () { forwardSelected(); });

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

        selBar.appendChild(fwd);
        selBar.appendChild(del);
        selBar.appendChild(cancel);

        /* 补回条子占掉的那点高度，眼前的内容原封不动（见函数开头那段注释）。
           ⚠️ 这句必须放在**所有**会改 selBar 高度的事情之后（现在是末尾，
           条子里只有一行字，改文案不改高度，但以后加了第二行就靠这句兜住）。 */
        if (msgWrap.clientHeight !== h0) msgWrap.scrollTop += (h0 - msgWrap.clientHeight);
      }

      /* ==================== 转发（入口在长按菜单和多选条） ==================== */

      /* 多选条 → 转发：先按气泡收集，跳过不支持的，再弹「逐条 / 合并」动作表 */
      function forwardSelected() {
        var items = collectForwardItems(chatId, selectedIds().map(parseSelKey));
        var ok = items.filter(function (it) { return it.kind !== 'skip'; });
        if (!ok.length) {
          ctx.toast('选中的消息都不支持转发', 'warn');
          return;
        }
        if (ok.length < items.length) {
          ctx.toast('有 ' + (items.length - ok.length) + ' 条不支持转发，已跳过', 'warn');
        }
        forwardSheet(ok);
      }

      /* 逐条 / 合并 的动作表（照微信那个底部三行） */
      function forwardSheet(items) {
        var host = document.getElementById('phone') || document.body;
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
        function item(name, run) {
          var b = h('button', 'msg-menu-item', name);
          b.type = 'button';
          b.addEventListener('click', function () { close(); run(); });
          sheet.appendChild(b);
        }
        item('逐条转发', function () { forwardFlow(items, 'single'); });
        item('合并转发', function () { forwardFlow(items, 'merge'); });

        var cancel = h('button', 'msg-menu-cancel', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', close);
        sheet.appendChild(cancel);
        mask.addEventListener('click', close);
        host.appendChild(mask);
        host.appendChild(sheet);
        setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
      }

      /* 长按菜单 → 转发：单条直发（不弹逐条/合并，照微信） */
      function forwardOne(msg, idx) {
        var items = collectForwardItems(chatId, [{ id: msg.id, idx: idx || 0 }]);
        var ok = items.filter(function (it) { return it.kind !== 'skip'; });
        if (!ok.length) {
          ctx.toast(items.length && items[0].why === 'voice'
            ? '语音消息转不了（微信也是）'
            : '这种消息还不支持转发', 'warn');
          return;
        }
        forwardFlow(ok, 'single');
      }

      /* 选目标 → 逐个发。发完落一次 toast；发给了当前对话就重画。 */
      function forwardFlow(items, mode) {
        pickForwardTargets(ctx, function (ids) {
          if (!ids || !ids.length) return;
          var chain = Promise.resolve();
          ids.forEach(function (tid) {
            chain = chain.then(function () { return sendForwardTo(tid, items, mode); });
          });
          chain.then(function () {
            if (selecting) exitSelect();
            ctx.toast('已转发给 ' + ids.length + ' 个对话', 'ok');
            if (ids.indexOf(chatId) >= 0) renderMessages();
          }, function () {
            ctx.toast('没转出去，再试一次', 'err');
          });
        });
      }

      /* ======================== 长按菜单 ========================
         菜单是**贴着被长按的那个气泡**弹出的浮层（ui.anchorPopover）。
         以前是自己搭的整宽底部动作表 + 全屏遮罩：必然铺满整屏、把消息
         全挡住，而且根本不贴被长按的那条（用户报的五.12）。
         浮层的关闭交给 anchorPopover（点外面 / ESC / 滚动出视野都收）。 */

      function openMenu(msg, seg, bubbleEl) {
        var idx = (seg && seg.idx !== undefined) ? seg.idx : null;
        var pop = ui.anchorPopover(bubbleEl, { className: 'msg-pop', arrow: true });

        /* 顶部 emoji 回应条（QQ/企微风长按贴表情）；点一下贴/取消 */
        var emojiRow = h('div', 'msg-pop-emoji');
        REACTION_EMOJIS.forEach(function (em) {
          var b = h('button', 'msg-pop-emoji-btn', em);
          b.type = 'button';
          b.addEventListener('click', function () { pop.close(); toggleReaction(msg, em, idx); });
          emojiRow.appendChild(b);
        });
        pop.el.appendChild(emojiRow);

        var list = h('div', 'msg-pop-list');

        var items = [
          { label: '引用', run: function () { startQuote(msg, idx); } },
          { label: '复制', run: function () { copyMsg(msg, idx); } },
          { label: '转发', run: function () { forwardOne(msg, idx); } },
          { label: '收藏', run: function () { favorite(msg, idx); } },
          { label: '编辑', run: function () { editMsg(msg, idx); } },
          /* 多选 / 删除都带上**这个气泡**：一条回复拆成几段时，
             用户在哪个气泡上长按，就该选中 / 删掉哪一个（2026-09-23）。 */
          { label: '多选', run: function () { enterSelect(msg.id, idx); } },
          { label: '删除', kind: 'danger', run: function () { removeMsg(msg, idx); } }
        ];
        /* 撤回（2026-10-06）：只给自己发的**纯文字**消息 —— 表情/转账/
           拍一拍是动作记录，撤回没有意义；照片涉及相册清理，也不开。
           塞在「删除」前面（删都没删，先给个反悔的机会）。 */
        if (msg.role === 'user' && !msg.type && !msg.recalledAt) {
          items.splice(items.length - 1, 0,
            { label: '撤回', run: function () { recallMine(msg); } });
        }
        /* 「留在灯上」（2026-10-06）：纯文字消息，双方向都可以。
           插在「编辑」前面 —— 它是"把这句话送去别处"，跟引用/转发是一路的。
           ★ 2026-10-12：带 idx —— 长按哪个气泡就挂哪个气泡的话，
           不是整条 '||' 原文（用户报「带上分割符了」）。 */
        if (!msg.type && !msg.recalledAt && String(msg.content || '').trim()) {
          items.splice(4, 0,
            { label: '留在灯上', run: function () { leaveOnLamp(msg, idx); } });
        }
        /* 「朗读」（2.15）：只在角色的话、纯文字、且角色开着「长按给朗读」时出现。
           已经在长按的那一条上读了就写成「重读」—— 同一句话偶尔想再听一遍。 */
        if (Sleepy.tts && msg.role === 'assistant' && !msg.type &&
            Sleepy.tts.voiceConfigOf(curCharId()).manualRead) {
          items.splice(5, 0, {
            label: msg.voice ? '重读' : '朗读',
            run: function () { readAloud(msg, seg); }
          });
        }
        /* 「TA 的自察」（方案-预设页分类与自察-v1 C2）：开了自察的轮次
           才有这条 —— 看 TA 汇报本轮用了哪些设定条目、改了什么话。
           没有（关着/旧消息）就不出现，不占菜单位。 */
        if (msg.role === 'assistant' && !msg.type && msg.inspect) {
          items.splice(5, 0, {
            label: 'TA 的自察',
            run: function () {
              ui.confirm({ title: 'TA 的自察', note: String(msg.inspect), ok: '知道了' });
            }
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

      /* 反查收尾卡（2026-10-29 二次口径）：**不复述翻了哪** —— user 全程
         跟着 TA 的视角看，页面清单是复读。卡片只留收尾这一眼的感觉：
         头一行 + 他的心声 + 一句随机的结尾。旧消息没有 rev 字段，
         退回显示原文（照样能删）。 */
      var REV_END_FLAVOR = [
        '屏幕暗下去，装作什么都没发生。',
        '放回去之前，多看了一眼。',
        '他把手机摆回原来的样子 —— 差不多原来的样子。',
        '走出两步，又回头确认了一下。',
        '放回去了，呼吸比刚才轻。'
      ];
      function revCard(msg) {
        var d = msg.rev || null;
        var chat = getChat(chatId);
        var ch = chat && chat.characterId ? findCharacter(chat.characterId) : null;
        var card = h('div', 'msg-revcard');
        var head = h('div', 'msg-revcard-h');
        head.appendChild(h('span', 'msg-revcard-ic', '👀'));
        head.appendChild(h('b', null, (ch ? ch.name : 'TA') + ' 把你的手机放了回去'));
        card.appendChild(head);
        if (d && d.thoughts && d.thoughts.length) {
          var tw = h('div', 'msg-revcard-thinks');
          d.thoughts.forEach(function (t) {
            if (t) tw.appendChild(h('p', null, '「' + t + '」'));
          });
          card.appendChild(tw);
        } else if (!d) {
          card.appendChild(h('div', 'msg-revcard-pages',
            String(msg.content || '').replace(/^🕵️\s*/, '')));
        }
        card.appendChild(h('p', 'msg-revcard-flavor',
          (d && d.end) || REV_END_FLAVOR[Math.floor(Math.random() * REV_END_FLAVOR.length)]));
        if (d && d.learned) {
          card.appendChild(h('p', 'msg-revcard-learned', '他好像把什么悄悄记下了。'));
        }
        return card;
      }

      /* 系统卡的长按菜单（2026-10-29 用户：系统信息也要能删）：
         这些是动作记录/播报，不是话 —— 引用、回复都没有意义，只给删除。 */
      function openSysMenu(msg, anchorEl) {
        var pop = ui.anchorPopover(anchorEl, { className: 'msg-pop', arrow: true });
        var list = h('div', 'msg-pop-list');
        var del = h('button', 'msg-pop-item is-danger', '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          pop.close();
          removeMsg(msg, null);
        });
        list.appendChild(del);
        pop.el.appendChild(list);
        pop.place();
      }

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
        /* 名字口径与气泡上的引用条一致（2026-10-28）：我 / TA 的名字 */
        var qName = '对方';
        if (quote.role === 'user') qName = '我';
        else {
          var qc0 = getChat(chatId);
          var qch0 = qc0 && qc0.characterId ? findCharacter(qc0.characterId) : null;
          if (qch0 && qch0.name) qName = qch0.name;
        }
        quoteBar.appendChild(h('span', 'msg-quote-text', qName + '：' + quote.content));
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
        /* 收藏真相在 favorites（收藏馆读这张表并馆展示），这里只落库 + 说人话 ——
           老「收藏夹」页已退役，别再把人往不存在的 ★ 指了（2026-10-08）。 */
        ctx.toast('已收进 We 收藏馆啦', 'ok');
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

      /* 「留在灯上」（2026-10-06）：把这句话抄近道送上桌面的挂件灯。
         谁说的话署谁的名 —— user 是「我」，assistant 是角色名。
         表情/转账/拍一拍是动作记录，照片要连相册，都算不上「一句话」，不进。
         时间戳用消息自己的（落款显示的是「这句话被说出来的时刻」，
         不是「被挂上去的时刻」）。
         ★ 2026-10-12：必须带 idx —— 一条回复拆成几段气泡时，挂上去的
         要是**长按的这个气泡**，不是整条 '||' 拼起来的原文（用户报：
         「灯上挂的是带分割符的整串，又不是我选的那句话」）。
         bubbleText 是全项目唯一的「第 idx 个气泡正文」出口（见其注释），
         user 消息不参与 || 分段，传 null 时原样返回整条。 */
      function leaveOnLamp(msg, idx) {
        var chat = getChat(chatId);
        var by = msg.role === 'user' ? userNameOf(chat) : charNameOf(chat);
        var rec = Sleepy.lampNotes && Sleepy.lampNotes.add({
          text: bubbleText(msg, idx),
          by: by,
          ts: msg.timestamp || Date.now(),
          src: 'chat'
        });
        ctx.toast(rec ? '已留在灯上' : '这句留不上灯', rec ? 'ok' : 'warn');
      }

      /* user 撤回自己的消息（长按菜单，2026-10-06）。微信式：原位变灰字。
         概率掷骰决定 TA 有没有看到内容（滑条在角色设置，默认 40%）：
         看到 → 下轮上下文带原文；没看到 → TA 只知道你撤回了一条（不知道内容）。
         掷骰结果记在消息上（recallSeen），落定之后不再重掷。
         界面**不剧透**掷骰结果 —— TA 下轮的反应自然会见分晓（同查岗的口径：
         suspense 留给你自己品）。 */
      function recallMine(msg) {
        ui.confirm({
          title: '撤回这条消息？',
          note: 'TA 有一定概率看到内容。',
          ok: '撤回',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          var rate = 0.4;
          var cid = curCharId();
          try {
            if (Sleepy.chatSettings && cid) {
              rate = Number(Sleepy.chatSettings.charSettings(cid).get('recallNotice', 0.4));
            }
          } catch (e) { /* 读不到就用默认 40% */ }
          if (!(rate >= 0)) rate = 0;
          if (rate > 1) rate = 1;
          var seen = Math.random() < rate;
          patchMessage(chatId, msg.id, { recalledAt: Date.now(), recallSeen: seen });
          /* 索引跟着失效（口径同群聊）：撤回的意义就是「当没说过」——
             就算 TA 当时瞟到了，向量检索也不再把它当可引用的原文。 */
          if (cid && Sleepy.memoryVec && Sleepy.memoryVec.forget) {
            Sleepy.memoryVec.forget({ charId: cid, ids: [msg.id] })
              ['catch'](function () { /* 索引清理失败不影响撤回本身 */ });
          }
          renderMessages();
        });
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

      /* ==================== 文字麻将（wm-core.js 接线层） ====================

        状态挂在对话对象上（c.wm = { game, pending, charLastPlay }），按对话
        存档（用户 2026-10-25 定稿）：切对话互不干扰、退到列表再回来牌局还在。
        读写纪律（store 深拷贝红线）：
        · 读走 wmOf(chatId) —— 每次从 store 现取，不缓存整局对象；
        · 写走 wmSave(chatId, fn) —— 进 mutate 拿**全量**列表改完整体落盘。
        c.wm 不在 = 没开桌；buildMessages / 回复标签解析 / 面板都只认这份。 */
      function wmOf(chatId) {
        var c = getChat(chatId);
        if (!c || !c.wm || !c.wm.game) return null;
        return c.wm;
      }

      function wmSave(chatId, fn) {
        return mutate(chatId, function (c) {
          c.wm = c.wm || { game: null, pending: null, charLastPlay: null };
          fn(c.wm);
        });
      }

      /* 反查手机落库（c.rev = { lastAt, off, note, invite, override }）。
         2026-10-26 用户真机抓到 Uncaught ReferenceError：v261 接线时
         5 处调用全写上了，函数本体漏了 —— 一点「反查手机」就炸。
         形状以 page-chat 各调用点 + revcheck-core 的 state 读法为准。 */
      function revSave(chatId, fn) {
        return mutate(chatId, function (c) {
          c.rev = c.rev || {};
          fn(c.rev);
        });
      }

      /** 牌桌播报：落一条 type:'wm' 的居中灰条（同拍一拍的展示位）。
          role 用 'system'——buildMessages 只放 user/assistant 进历史，
          TA 对牌面的认知完全来自每轮注入的牌局上下文，不靠翻播报。 */
      function wmPost(chatId, content) {
        addMessage(chatId, {
          id: newId(),
          role: 'system',
          type: 'wm',
          content: content,
          timestamp: Date.now()
        });
      }

      /** 牌局上下文 system 消息（两处装配路径共用）。没开桌返回 null。 */
      function wmContextMsg(chatId) {
        if (!Sleepy.wm) return null;
        var wm = wmOf(chatId);
        if (!wm) return null;
        var c = getChat(chatId);
        var ctx = Sleepy.wm.buildContext(chatId, wm, {
          user: userNameOf(c) || '我',
          char: charNameOf(c) || 'TA'
        });
        if (!ctx) return null;
        return { role: 'system', content: ctx };
      }

      /* ---------------- 牌桌面板（P2）----------------
        居中弹层（红线：弹层一律页面居中，不贴底），挂 #phone。
        面板只做牌桌：摸牌/选牌拼句/出牌/判 ta/看牌面。出牌=往聊天里
        悬一个待裁决句 + 播报，之后的掰扯全在主聊天自然发生 —— TA 的
        裁决藏在回复标签里（applyWmTags 解析），气泡里永远只有人话。
        重绘纪律：每次 render 都从 wmOf(chatId) 现取（store 深拷贝红线，
        不缓存整局对象），重开面板/聊天重绘都不串。 */

      var WM_TILE_HUE = {
        emotion: 'wm-tile-emotion', verb: 'wm-tile-verb', noun: 'wm-tile-noun',
        adjective: 'wm-tile-adj', adverb: 'wm-tile-adverb', scene: 'wm-tile-scene',
        supplement: 'wm-tile-sup'
      };

      function openWmPanel(ctx) {
        var wm = Sleepy.wm;
        if (!wm) { ctx.toast('牌桌模块没加载上', 'err'); return; }
        var chat = getChat(chatId);
        if (!chat) { ctx.toast('找不到这个对话', 'err'); return; }
        var ch = findCharacter(chat.characterId);
        var charName = ch ? ch.name : '对方';
        var userName = userNameOf(chat) || '我';

        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'wm-mask');
        var card = h('div', 'wm-panel');
        var closed = false;

        function close() {
          if (closed) return;
          closed = true;
          mask.classList.remove('is-open');
          card.classList.remove('is-open');
          setTimeout(function () {
            if (mask.parentNode) mask.parentNode.removeChild(mask);
            if (panelBox && panelBox.parentNode) panelBox.parentNode.removeChild(panelBox);
          }, 180);
        }
        var panelBox = h('div', 'wm-panelbox');
        panelBox.addEventListener('click', function (e) { e.stopPropagation(); });
        mask.addEventListener('click', close);

        /* ---- 动作（全部走 wmSave，播报走 wmPost）---- */
        function startFresh() {
          wmSave(chatId, function (w) {
            w.game = wm.createGame(chatId, charName);
            w.pending = null;
            w.charLastPlay = null;
          });
          render();
        }
        function quitGame() {
          var cur = wmOf(chatId);
          if (cur && cur.game && cur.game.status === 'playing' &&
              !window.confirm('确定退出牌局吗？本局进度不会保留。')) return;
          wmSave(chatId, function (w) { w.game = null; w.pending = null; w.charLastPlay = null; });
          close();
        }
        function reset() {
          wmSave(chatId, function (w) { w.game = null; w.pending = null; w.charLastPlay = null; });
          startFresh();
        }

        /* ---- 渲染 ---- */
        function tileEl(c, picked, onTap) {
          var t = h('button', 'wm-tile ' + (WM_TILE_HUE[c.category] || '') + (picked ? ' is-picked' : ''));
          t.type = 'button';
          t.appendChild(h('span', 'wm-tile-ch', c.char));
          t.appendChild(h('span', 'wm-tile-py', c.pinyin));
          if (onTap) t.addEventListener('click', function () { onTap(c); });
          return t;
        }

        function meldChip(m, cls) {
          return h('span', 'wm-meld ' + cls, m.map(function (c) { return c.char; }).join(''));
        }

        function render() {
          if (closed) return;
          var cur = wmOf(chatId);
          var g = cur ? cur.game : null;
          card.innerHTML = '';

          /* 头部 */
          var head = h('div', 'wm-head');
          var hLeft = h('div', 'wm-head-l');
          hLeft.appendChild(h('div', 'wm-head-t', '文字麻将 · vs ' + charName));
          hLeft.appendChild(h('div', 'wm-head-s', 'WORD MAHJONG'));
          head.appendChild(hLeft);
          var hRight = h('div', 'wm-head-r');
          if (g) {
            var quit = h('button', 'wm-quit', '退出牌局');
            quit.type = 'button';
            quit.addEventListener('click', quitGame);
            hRight.appendChild(quit);
          }
          var x = h('button', 'wm-close', '×');
          x.type = 'button';
          x.addEventListener('click', close);
          hRight.appendChild(x);
          head.appendChild(hRight);
          card.appendChild(head);

          if (!g) {
            /* 开桌页 */
            var intro = h('div', 'wm-intro');
            var av = (ch && ch.avatar)
              ? (function () { var im = document.createElement('img'); im.className = 'wm-ava'; im.src = ch.avatar; im.alt = ''; return im; })()
              : null;
            if (av) intro.appendChild(av);
            intro.appendChild(h('div', 'wm-intro-t', '和 ' + charName + ' 打「文字打马吊」'));
            var desc = h('p', 'wm-intro-d');
            desc.innerHTML = '各 13 张汉字牌。每回合摸 1 张，把手里 ≥3 个字拼成一句短句<b>整句打出</b>清空手牌——先出空的赢。<br>打出后<b>直接在聊天里跟 ta 掰扯</b>，裁决就藏在 ta 的回复里。';
            intro.appendChild(desc);
            var go = h('button', 'wm-go', '和 ' + charName + ' 开桌');
            go.type = 'button';
            go.addEventListener('click', startFresh);
            intro.appendChild(go);
            card.appendChild(intro);
          } else {
            var playing = g.status === 'playing';
            var pending = cur.pending;
            var lastPlay = cur.charLastPlay;
            var myTurn = playing && !pending && !lastPlay;

            /* 状态条 */
            var stat = h('div', 'wm-stat');
            stat.appendChild(h('span', 'wm-stat-c', '牌墙 ' + g.wall.length));
            stat.appendChild(h('span', 'wm-stat-m' + (myTurn ? ' is-hot' : ''),
              playing ? (pending ? '句子悬着：去聊天框跟 ta 掰扯'
                : lastPlay ? '该你当裁判了'
                : '拼一句打出去，组不成就摸牌') : '对局结束'));
            stat.appendChild(h('span', 'wm-stat-c', '你 ' + g.hands[0].length + ' / ta ' + g.hands[1].length));
            card.appendChild(stat);

            /* ta 的手牌背面 + 已出的句子 */
            var foe = h('div', 'wm-foe');
            var foeRow = h('div', 'wm-foe-row');
            foeRow.appendChild(h('span', 'wm-foe-name', charName));
            var backs = h('div', 'wm-backs');
            for (var bi = 0; bi < g.hands[1].length; bi++) backs.appendChild(h('i', 'wm-back'));
            foeRow.appendChild(backs);
            foe.appendChild(foeRow);
            var foeMelds = h('div', 'wm-melds');
            if (!g.melds[1].length) foeMelds.appendChild(h('span', 'wm-none', 'ta 还没出句'));
            for (var fi = 0; fi < g.melds[1].length; fi++) foeMelds.appendChild(meldChip(g.melds[1][fi], 'wm-meld-ta'));
            foe.appendChild(foeMelds);
            card.appendChild(foe);

            /* 我已出的句子 */
            if (g.melds[0].length) {
              var myMelds = h('div', 'wm-melds wm-melds-my');
              for (var mi = 0; mi < g.melds[0].length; mi++) myMelds.appendChild(meldChip(g.melds[0][mi], 'wm-meld-my'));
              card.appendChild(myMelds);
            }

            /* 用户裁判条 */
            if (playing && lastPlay) {
              var judge = h('div', 'wm-judge');
              judge.appendChild(h('span', 'wm-judge-t', 'ta 打出「' + lastPlay.sentence + '」'));
              var jbtns = h('div', 'wm-judge-b');
              var passB = h('button', 'wm-btn wm-btn-ok', '通过');
              passB.type = 'button';
              passB.addEventListener('click', function () { doJudge('pass'); });
              var rejB = h('button', 'wm-btn wm-btn-no', '打回');
              rejB.type = 'button';
              rejB.addEventListener('click', function () { doJudge('reject'); });
              jbtns.appendChild(passB); jbtns.appendChild(rejB);
              judge.appendChild(jbtns);
              card.appendChild(judge);
            }

            /* 终局覆盖 */
            if (g.status === 'finished') {
              var over = h('div', 'wm-over');
              var face = g.winner === 0 ? '🎉' : g.isDraw ? '🀄' : '🍵';
              var verdict = g.winner === 0 ? '你赢啦！' : g.isDraw ? '流局' : charName + ' 先出空了';
              over.appendChild(h('div', 'wm-over-face', face));
              over.appendChild(h('div', 'wm-over-t', verdict));
              if (g.winningSentence) over.appendChild(h('div', 'wm-over-s', '「' + g.winningSentence + '」'));
              var again = h('button', 'wm-go', '再来一局');
              again.type = 'button';
              again.addEventListener('click', reset);
              over.appendChild(again);
              card.appendChild(over);
            }

            /* 操作条 + 我的手牌（对局中） */
            if (playing) {
              var ops = h('div', 'wm-ops');
              var drawB = h('button', 'wm-btn wm-btn-dark' + (myTurn ? '' : ' is-off'), '摸牌');
              drawB.type = 'button';
              drawB.addEventListener('click', function () {
                if (!myTurn) return;
                wmSave(chatId, function (w) { w.game = wm.drawCard(w.game, 0); });
                render();
              });
              ops.appendChild(drawB);
              var sentence = picked.map(function (c) { return c.char; }).join('');
              var playB = h('button', 'wm-btn wm-btn-play' + (picked.length >= 3 && myTurn ? '' : ' is-off'),
                '打出「' + sentence + '」');
              playB.type = 'button';
              playB.addEventListener('click', doPlay);
              ops.appendChild(playB);
              var re = h('button', 'wm-re', '重开');
              re.type = 'button';
              re.addEventListener('click', reset);
              ops.appendChild(re);
              card.appendChild(ops);

              var handBox = h('div', 'wm-hand');
              var handScroll = h('div', 'wm-hand-scroll');
              g.hands[0].forEach(function (c) {
                handScroll.appendChild(tileEl(c, picked.some(function (p) { return p.id === c.id; }),
                  myTurn ? function (card2) { togglePick(card2); } : null));
              });
              handBox.appendChild(handScroll);
              handBox.appendChild(h('div', 'wm-hint',
                picked.length > 0 ? '语序：' + sentence + '（再点取消）'
                  : pending ? '句子悬着——去聊天框跟 ta 掰扯，ta 判完牌自动回来'
                  : '按顺序点牌拼句（≥3 字）；打出后回聊天框跟 ta 聊'));
              card.appendChild(handBox);
            }
          }

          if (!card.parentNode) {
            panelBox.appendChild(card);
            host.appendChild(mask);
            host.appendChild(panelBox);
            setTimeout(function () { mask.classList.add('is-open'); panelBox.classList.add('is-open'); }, 20);
          }
        }

        /* 点选顺序即语序（内存态，不落库） */
        var picked = [];
        function togglePick(c) {
          var cur = wmOf(chatId);
          if (!cur || cur.pending || cur.charLastPlay) return;
          var i = -1;
          for (var k = 0; k < picked.length; k++) if (picked[k].id === c.id) i = k;
          if (i === -1) picked.push(c); else picked.splice(i, 1);
          render();
        }

        /** 打出 = 往聊天里悬一个待裁决句（牌不清），播报 + 收面板回聊天 */
        function doPlay() {
          var cur = wmOf(chatId);
          if (!cur || !cur.game || cur.game.status !== 'playing') return;
          if (cur.pending || cur.charLastPlay || picked.length < 3) return;
          var tiles = picked.slice();
          var sentence = tiles.map(function (c) { return c.char; }).join('');
          picked = [];
          wmSave(chatId, function (w) { w.pending = { sentence: sentence, tiles: tiles }; });
          wmPost(chatId, '🀄 牌桌：' + userName + ' 打出了「' + sentence + '」（' + tiles.length + ' 张），待 ' + charName + ' 裁决');
          close();
          renderMessages();
        }

        /** 用户判 ta 的句子：只结算牌面 + 播报，不额外生成角色台词 */
        function doJudge(verdict) {
          var cur = wmOf(chatId);
          if (!cur || !cur.charLastPlay || !cur.game) return;
          var target = cur.charLastPlay;
          if (verdict === 'pass') {
            wmSave(chatId, function (w) {
              w.game = wm.playPhrase(w.game, 1, target.tiles, target.sentence);
              w.charLastPlay = null;
            });
            wmPost(chatId, '🀄 牌桌：' + userName + ' 判过，' + charName + ' 打出的「' + target.sentence + '」清掉 ' + target.tiles.length + ' 张');
            var after = wmOf(chatId);
            if (after && after.game && after.game.status === 'finished') {
              wmPost(chatId, after.game.isDraw ? '🀄 牌墙摸完，流局～'
                : after.game.winner === 0 ? '🎉 手牌出空——你赢啦！'
                : '🍵 ' + charName + ' 先出空了，ta 赢了');
            }
          } else {
            wmSave(chatId, function (w) { w.charLastPlay = null; });
            wmPost(chatId, '🀄 牌桌：' + userName + ' 把「' + target.sentence + '」打回了');
          }
          render();
        }

        render();
      }

      /* ---------------- 回复标签解析（P3）----------------
        TA 回复里的 [[WM_PASS]] / [[WM_PARTIAL:..]] / [[WM_REJECT]] /
        [[WM_PLAY:字|字|字]] 在这里动牌（解析口径在 wm-core.parseWmTags，
        宽容匹配；正文在返回前剥净，气泡里永远只有人话）。
        荷官原则：系统绝不代判 —— 标签没出现 = ta 还没想好，句子继续悬着。
        无对局时也照剥（防标签泄漏），只是不动牌。 */
      function applyWmTags(chatId, raw) {
        if (!Sleepy.wm) return String(raw || '').trim();
        var parsed = Sleepy.wm.parseWmTags(raw);
        var wm = wmOf(chatId);
        if (!wm) return parsed.text;          /* 没开桌：只防泄漏 */

        /* 这一轮的牌局状态全部现取（下面每步 wmSave 之后都会重读一遍，
           拿着开局快照往下走会用过期手牌配牌 —— 悬句判完牌面已经变了） */
        var chat = getChat(chatId);
        var ch = findCharacter(chat && chat.characterId);
        var charName = ch ? ch.name : '对方';
        var userName = userNameOf(chat) || '我';

        /* ── 1. 裁决用户悬着的句子（pending 每步现取，判完牌面会变） ── */
        var cur = wmOf(chatId);
        var pending = cur ? cur.pending : null;
        if (pending) {
          if (parsed.pass) {
            var pendPass = pending;
            wmSave(chatId, function (w) {
              w.game = Sleepy.wm.playPhrase(w.game, 0, pendPass.tiles, pendPass.sentence);
              w.pending = null;
            });
            wmPost(chatId, '🀄 牌桌：' + charName + ' 判过，' + userName + ' 打出的「' + pendPass.sentence + '」清掉 ' + pendPass.tiles.length + ' 张');
            pending = null;
          } else if (parsed.partial) {
            var words = parsed.partial.words.filter(function (w2) { return pending.sentence.indexOf(w2) !== -1; });
            var resolved = false;
            if (words.length) {
              var hit = Sleepy.wm.tilesForPassWords(pending.tiles, words);
              if (hit.accepted.length >= 2) {
                wmSave(chatId, function (w) {
                  w.game = Sleepy.wm.playPhrase(w.game, 0, hit.accepted, hit.sentence);
                  w.pending = null;
                });
                wmPost(chatId, '🀄 牌桌：' + userName + ' 的句子部分过——「' + hit.sentence + '」清掉 ' + hit.accepted.length + ' 张，其余的字收回');
                pending = null;
                resolved = true;
              }
            }
            if (!resolved && pending) {
              wmPost(chatId, '🀄 牌桌：裁决的词没对上牌，这句先悬着');
            }
          } else if (parsed.reject) {
            var pendRej = pending;
            wmSave(chatId, function (w) { w.pending = null; });
            wmPost(chatId, '🀄 牌桌：整句打回，' + pendRej.tiles.length + ' 张牌收回 ' + userName + ' 手里');
            pending = null;
          } else {
            /* 荷官催标签：ta 嘴上说了裁决但系统没收到，明着催（下一条回复就会补） */
            wmPost(chatId, '🀄 牌桌：没有收到裁决标签，刚才那句不算数——请补一个 [[WM_PASS]] / [[WM_PARTIAL:子串|子串]] / [[WM_REJECT]]');
          }
        }

        /* ── 2. ta 出牌（悬句解决后才允许；状态从 store 现取）──
           ta 上一句还挂在裁判条上（用户没按通过/打回）→ 本轮不摸不打，
           否则同一条句子会被重复落账。 */
        cur = wmOf(chatId);
        var g = cur ? cur.game : null;
        var lastPlay = cur ? cur.charLastPlay : null;
        if (g && g.status === 'playing' && !pending && !lastPlay) {
          if (parsed.play) {
            var chars = parsed.play.chars;
            var tiles = [];
            var used = new Set();
            (chars || []).forEach(function (chr) {
              var found = null;
              for (var i = 0; i < g.hands[1].length; i++) {
                var hd = g.hands[1][i];
                if (hd.char === chr && !used.has(hd.id)) { found = hd; break; }
              }
              if (found) { tiles.push(found); used.add(found.id); }
            });
            if (tiles.length >= 3 && tiles.length === chars.length) {
              var sentence = tiles.map(function (c) { return c.char; }).join('');
              /* 悬案化：不落账（不从手牌移除、不写 melds），等用户在面板判。 */
              wmSave(chatId, function (w) { w.charLastPlay = { tiles: tiles, sentence: sentence }; });
              wmPost(chatId, '🀄 牌桌：' + charName + ' 打出了「' + sentence + '」（' + tiles.length + ' 张），待 ' + userName + ' 裁决');
            } else {
              wmPost(chatId, '🀄 牌桌：' + charName + ' 出的字对手不上号，按过处理');
            }
          } else {
            /* ta 组不出句子 → 摸一张（ta 的「摸牌」选择）；墙空就地结算 */
            var drew = false;
            wmSave(chatId, function (w) {
              if (w.game.status !== 'playing') return;
              if (w.game.wall.length === 0) { w.game = Sleepy.wm.endByWall(w.game); return; }
              w.game = Sleepy.wm.drawCard(w.game, 1);
              drew = true;
            });
            if (drew) wmPost(chatId, '🀄 牌桌：' + charName + ' 组不出句子，摸了一张牌');
          }
          wmSave(chatId, function (w) { if (w.game && w.game.status === 'playing') w.game.turn = 0; });
        }

        /* ── 3. 终局播报 ── */
        var afterWm = wmOf(chatId);
        if (afterWm && afterWm.game && afterWm.game.status === 'finished') {
          wmPost(chatId, afterWm.game.isDraw ? '🀄 牌墙摸完，流局～'
            : afterWm.game.winner === 0 ? '🎉 手牌出空——你赢啦！'
            : '🍵 ' + charName + ' 先出空了，ta 赢了');
        }

        return parsed.text;
      }

      /* ==================== 反查手机（revcheck-core.js 接线层） ====================

        TA 偷看你的手机。执行形态对齐《方案-反查手机-v1.1》主形态：
        不演戏——直接把**真页面**一个个打开（nav.open），对真滚动容器做平滑
        滚动模拟，TA 的内心想法（LLM）以弹幕气泡飘过当前屏；顶部一枚呼吸
        胶囊报状态 + 暂停/结束（手法照 qs reverseTakeoverRunner）。
        数据层：采样器真读本岛数据（岛章红线，跨岛绝不进采样）；
        收尾：summary 落 type:'revcheck' 系统条 + eventNote 注入下一轮 +
        记忆落库（标注来源）。
        冷却/开关挂在 chat.rev = { lastAt, off, note }（走 mutate 落库）。 */

      function revStateOf(chat) {
        return (chat && chat.rev) || {};
      }

      /** 可看清单：按岛现算（岛章红线——只列本岛有的东西） */
      function revAvailable(chat) {
        var core2 = Sleepy.core;
        var sid = chat.sandboxId || null;
        var scopedChats = sid && core2 && core2.scoped
          ? core2.scoped(allChats()).filter(function (c) { return c.sandboxId === sid && !c.groupId; })
          : allChats().filter(function (c) { return !c.groupId; });
        var targets = [];
        /* 私聊：TA 自己的对话放最前，然后是岛内其他对象（滑到谁读谁） */
        scopedChats.forEach(function (c) {
          if (c.id === chat.id) {
            targets.unshift({ id: c.characterId, name: charNameOf(c) || 'ta', chatId: c.id });
            return;
          }
          targets.push({ id: c.characterId, name: chatDisplayName(c), chatId: c.id });
        });
        /* 七个面全列（v287 回滚 v286 的「先数货」）：用户口径 —— TA 打开
           空的日记/相册**发现什么都没有**，这件事本身就该告诉模型
           （「他翻了你的日记，空的，一篇都没写」比「他没看日记」有戏）。
           空面不再是漏报，采样器（revSample）对空面有显式话术，
           收尾摘要（revcheck.buildSummary）按面交代翻到了什么。 */
        return [
          { id: 'chat', targets: targets },
          { id: 'moments', name: '朋友圈' },
          { id: 'photos', name: '相册' },
          { id: 'diary', name: '日记' },
          { id: 'favorites', name: '收藏' },
          { id: 'profile', name: '微信账号' },
          { id: 'forum', name: '群声' }
        ];
      }

      /** 采样器：真读本岛数据 → {detail, learned}。失败回落通用文案，不阻断浏览。 */
      function revSample(step) {
        try {
          var chat = getChat(chatId);
          var sid = chat && chat.sandboxId || null;
          function scoped(key) {
            var list = store.get(key);
            if (!Array.isArray(list)) return [];
            return (sid && Sleepy.core && Sleepy.core.scoped) ? Sleepy.core.scoped(list) : list;
          }
          if (step.page === 'chat' && step.chatId) {
            var tc = getChat(step.chatId);
            var msgs = (tc && Array.isArray(tc.messages)) ? tc.messages : [];
            var lines = [];
            for (var i = msgs.length - 1; i >= 0 && lines.length < 6; i--) {
              var m = msgs[i];
              if (m.role !== 'user' && m.role !== 'assistant') continue;
              if (m.type === 'checkin' || m.type === 'wm') continue;   /* 查岗/牌桌内部条不给看 */
              var text = String(m.content || '').trim();
              if (!text) continue;
              lines.unshift((m.role === 'user' ? '你：' : '对方：') + text.slice(0, 40));
            }
            if (!lines.length) return { detail: '空的，什么都没聊', learned: '' };
            /* learned 只提炼**值得知道**的：短应酬（你好/嗯/在吗）不算
               「TA 知道了什么」（2026-10-29 用户「信息很多但没用」）。 */
            var userSays = lines.filter(function (l) { return l.indexOf('你：') === 0; })
              .map(function (l) { return l.slice(2); })
              .filter(function (t) { return t.length >= 6; })
              .slice(0, 2)
              .map(function (t) { return '「' + t + '」'; });
            return {
              detail: '和「' + step.targetName + '」的聊天：' + lines.slice(0, 4).join(' / '),
              learned: userSays.length ? ('与「' + step.targetName + '」的对话里你说过：' + userSays.join('；')) : ''
            };
          }
          /* v287 采样口径：detail 是**纯事实描述**（不带面名前缀）——
             收尾摘要会拼「面名：detail」喂给模型，心声弹幕也会拼
             「你刚看到（面名）：detail」，前缀重复就是「日记：日记：…」。
             空面有显式话术：模型拿到的就是「什么都没有」，没得脑补。 */
          if (step.page === 'moments') {
            var posts = scoped('moments').filter(function (p) { return p && !p.groupId; }).slice(-4).reverse();
            if (!posts.length) return { detail: '空的，一条动态都没有', learned: '' };
            return {
              detail: posts.length + ' 条动态：' + posts.map(function (p) { return String(p.content || p.text || '').slice(0, 30); }).join(' / '),
              learned: ''
            };
          }
          if (step.page === 'photos') {
            var ph = scoped('photos');
            return { detail: ph.length
              ? ph.length + ' 张照片'
              : '空的，一张照片都没有', learned: '' };
          }
          if (step.page === 'diary') {
            var ds = scoped('diaries').slice(-3).reverse();
            if (!ds.length) return { detail: '空的，一篇都没写', learned: '' };
            return {
              detail: '最近几篇：' + ds.map(function (d) { return String(d.content || '').slice(0, 30); }).join(' / '),
              learned: ''
            };
          }
          if (step.page === 'favorites') {
            var fs = scoped('favorites');
            return { detail: fs.length
              ? fs.length + ' 条收藏'
              : '空的，什么都没收过', learned: '' };
          }
          if (step.page === 'profile') {
            var mask = null;
            var users = store.get('userMasks');
            if (Array.isArray(users) && chat.userId) {
              users.forEach(function (u) { if (u && u.id === chat.userId) mask = u; });
            }
            var wallet = store.get('wallet') || {};
            return {
              detail: '「我」的资料页：' + (mask ? (mask.name || '') : '') +
                (mask && mask.persona ? '（' + String(mask.persona).slice(0, 40) + '）' : '') +
                (wallet.balance !== undefined ? '，余额 ¥' + wallet.balance : ''),
              learned: ''
            };
          }
          if (step.page === 'forum') {
            var fps = scoped('forumPosts').filter(function (p) { return p && p.status !== 'deleted'; }).slice(-4).reverse();
            if (!fps.length) return { detail: '空的，还没有帖子', learned: '' };
            return {
              detail: fps.length + ' 条帖子：' + fps.map(function (p) { return String(p.title || p.content || '').slice(0, 24); }).join(' / '),
              learned: ''
            };
          }
        } catch (e) { /* 采样失败不阻断 */ }
        return { detail: '空的，什么都没有', learned: '' };
      }

      /** 页面切换：nav.open 真页面。页面没注册就跳过这步（返回 false）。 */
      function revOpenPage(step) {
        var map = { moments: 'moments', photos: 'gallery', diary: 'diary', favorites: 'collection', forum: 'qunsheng' };
        var reg = Sleepy.registered ? Sleepy.registered() : {};
        var id;
        if (step.page === 'chat' && step.chatId) {
          id = 'chat-detail';
          if (!reg[id]) return false;
          Sleepy.nav.open(id, { chatId: step.chatId });
          return true;
        }
        if (step.page === 'profile') {
          id = reg['me'] ? 'me' : (reg['wallet'] ? 'wallet' : null);
        } else {
          id = map[step.page] || null;
        }
        if (!id || !reg[id]) return false;
        Sleepy.nav.open(id, {});
        return true;
      }

      /** 找当前页面里最大的可滚动容器（照 qs findScroller 手法） */
      function revFindScroller() {
        var phone = (Sleepy.el && Sleepy.el.phone) || document.getElementById('phone');
        if (!phone) return null;
        var all = phone.querySelectorAll('.msg-wrap, .page-scroll, [class*="scroll"]');
        var best = null, bestH = 0;
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200 && el.clientHeight > bestH) {
            best = el; bestH = el.clientHeight;
          }
        }
        return best;
      }

      /* 模拟手指滚屏：v282 起并入 revScrollTick（每拍随机决定翻/回/停/甩），
         匀速传送带版退役 —— 用户 2026-10-29「不想太机械化」。 */

      /** 内心想法：裸 LLM 一次调用（走主 API 候选首位），失败回 ''（不弹幕不阻断）。
          2026-10-29 用户「弹幕没有他本人的感觉」：以前只喂 400 字人设切片，
          飘出来的自然是没脸没腔的通用句。现在给全人设（compileCharacter：
          本体+皮套分层原文）、TA 的记忆、你们最近的对话 —— 飘过来的那句
          得真的是「他」看到这些东西时会想的话。 */
      function revThought(charName, persona0, view) {
        var api = Sleepy.api;
        if (!api || !api.candidates || !api.requestOnce) return Promise.resolve('');
        var cand = api.candidates()[0];
        if (!cand || !cand.cfg || !cand.cfg.baseUrl || !cand.cfg.apiKey) return Promise.resolve('');
        var chat = getChat(chatId);
        var ch = chat && chat.characterId ? findCharacter(chat.characterId) : null;
        var pe = Sleepy.promptEngine;
        var persona = (pe && pe.compileCharacter && ch)
          ? pe.compileCharacter(ch.id)
          : String(persona0 || '');
        /* 最近的对话（TA 视角：你=对方，我=TA 自己），只做语境不喂全文 */
        var dlg = [];
        ((chat && chat.messages) || []).slice(-10).forEach(function (m) {
          if (m.role !== 'user' && m.role !== 'assistant') return;
          var t = String(m.content || '').replace(/\s+/g, ' ').trim();
          if (!t) return;
          dlg.push((m.role === 'user' ? '你说：' : '我说：') + t.slice(0, 50));
        });
        /* TA 的记忆（标注过来源的那批）—— 他惦记着什么，翻手机时就用什么想 */
        var memLines = [];
        try {
          var rootId = Sleepy.core && Sleepy.core.rootIdOf ? Sleepy.core.rootIdOf(chat.characterId) : null;
          (Sleepy.core.memoriesOfRoot(rootId) || []).slice(-8).forEach(function (mm) {
            if (mm && mm.text) memLines.push(String(mm.text).slice(0, 60));
          });
        } catch (e) { /* 记忆缺位不拦弹幕 */ }
        var sys = '你在扮演「' + charName + '」，正偷看「你」的手机（这是用户手机里的真实数据，不是演出）。' +
          (persona ? '你是这样的人：\n' + String(persona).slice(0, 1600) + '\n' : '') +
          (memLines.length ? '你记着这些事：\n' + memLines.join('\n') + '\n' : '') +
          (dlg.length ? '你们最近说：\n' + dlg.join('\n') + '\n' : '') +
          '你刚看到（' + view.pageName + '）：' + (view.detail || '') +
          (view.learned ? ('\n你注意到：' + view.learned) : '') +
          '\n用一句你这个人此刻真实的内心想法（25 字内，口语，符合你的说话习惯；' +
          '吃醋/好奇/心虚/得意/想装不知道都行，跟人设和你们的关系对上）。只输出想法本身，不要引号。';
        /* 2026-10-29 修（用户报「反查手机的弹窗是固定的话语，不是实时生成」）：
           candidates() 回来的是 {source, label, cfg} —— 配置包在 **cfg** 里，
           以前直接裸读候选对象上的地址和密钥，全是 undefined，
           心声调用**一次都没发出去过**，永远走保底模板（收尾卡里那几条
           「……原来你是这样」就是模板长什么样）。改走 api.requestOnce
           （跟语音导演同一个口）：端点归一、鉴权头、超时都归它管，
           失败照旧静默落保底，不阻断浏览。 */
        return api.requestOnce(cand, [{ role: 'user', content: sys }], {})
          .then(function (r) {
            return (r && r.ok) ? String(r.content || '').trim().slice(0, 40) : '';
          })
          .catch(function () { return ''; });
      }

      /** 心声保底（2026-10-29 用户「没有心声飘过很平淡」）：模型想法没到位
          （没配 API / 超时 / 空回）也要有一条弹幕 —— 只用情绪模板，
          绝不编造「看到了什么」（具体内容只来自采样器的 learned）。 */
      var REV_THOUGHT_FB = [
        '……这条，看过就记住了。',
        '（盯着屏幕看了很久，没出声。）',
        '……原来你是这样。',
        '嗯，这个有点意思。',
        '……不告诉你我看了。',
        '心里轻轻动了一下。'
      ];
      function revFallbackThought() {
        return REV_THOUGHT_FB[Math.floor(Math.random() * REV_THOUGHT_FB.length)];
      }

      /**
       * 接管主流程。consent 已过（或主动触发直接看）。
       * deps 注入便于以后复用；结束回调回聊天页。
       */
      function revRun(charName, persona, chat) {
        var rc = Sleepy.revcheck;
        if (!rc) return;
        if (revRunning) { ctx.toast('TA 已经在看手机了', 'warn'); return; }
        var plan = rc.buildPlan(revAvailable(chat), persona, revStateOf(chat).off);
        if (!plan.length) { ctx.toast('这台手机上没有 TA 能看的东西', 'warn'); return; }

        var host = (Sleepy.el && Sleepy.el.phone) || document.getElementById('phone');
        /* 遮罩层（2026-10-29 用户点名要的）：轻暗化 + 顶部胶囊 + 弹幕都在
           这层「接管感」里，底下的真页面照样看得见、照样在滚 —— 是
           「TA 正在翻」的氛围，不是把手机盖住。pointer-events:none，
           只有胶囊上的按钮可点。 */
        var scrim = h('div', 'rev-scrim');
        var capsule = h('div', 'rev-capsule');
        capsule.innerHTML = '<span class="rev-dot"></span><span class="rev-cap-t">👁 ' + charName + ' 在看你手机</span>';
        var pauseB = h('button', 'rev-cap-btn rev-cap-pause', '⏸');
        var stopB = h('button', 'rev-cap-btn rev-cap-stop', '×');
        var btnRow = h('span', 'rev-cap-btns');
        btnRow.appendChild(pauseB); btnRow.appendChild(stopB);
        /* 反查手机：帮 user 换头像（用户 2026-10-27：TA 翻你手机时顺手帮你换）。
           系统相册选图 → 落图库(kind:'avatar') → 写回当前 user 马甲的 avatarMedia。
           复用 idcard 头像字段那套 media.shrink+put，不另起炉灶。 */
        var avB = h('button', 'rev-cap-btn rev-cap-avatar', '头像');
        avB.title = '让 ' + charName + ' 帮你换头像';
        avB.addEventListener('click', function () {
          var core2 = Sleepy.core, media = Sleepy.media;
          if (!core2 || !media) return;
          var me2 = (core2.activeUserOnIsland || core2.activeUser)();
          if (!me2) { ctx.toast('没有可换头像的账号', 'warn'); return; }
          var fi = h('input');
          fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none';
          capsule.appendChild(fi);
          fi.addEventListener('change', function () {
            var f = fi.files && fi.files[0];
            if (!f) { if (fi.parentNode) fi.parentNode.removeChild(fi); return; }
            ctx.toast('TA 正在帮你挑头像…', 'ok');
            media.shrink(f, 512).then(function (r) {
              return media.put(r.blob, { name: '头像', kind: 'avatar', w: r.w, h: r.h });
            }).then(function (id) {
              core2.upsertUser({ id: me2.id, avatarMedia: id });
              if (fi.parentNode) fi.parentNode.removeChild(fi);
              if (typeof renderMessages === 'function') renderMessages();
              ctx.toast(charName + ' 帮你换好头像啦', 'ok');
            }).catch(function (e) {
              if (fi.parentNode) fi.parentNode.removeChild(fi);
              ctx.toast('换头像失败了：' + ((e && e.message) || e), 'err');
            });
          });
          fi.click();
        });
        btnRow.appendChild(avB);
        capsule.appendChild(btnRow);
        var danmaku = h('div', 'rev-danmaku');
        host.appendChild(scrim);
        host.appendChild(capsule);
        host.appendChild(danmaku);

        var state = { idx: -1, paused: false, timer: null, scrollTimer: null, scroller: null,
          items: [], thoughts: [], done: false, lingerUntil: 0, from: Sleepy.nav.top(),
          inflight: 0, waitUntil: 0 };

        function danmu(text) {
          if (!text) return;
          /* 心声飘过来时他会停一下 —— 像是站在那里想这句（2026-10-29
             用户「不想太机械化」：滚屏节奏有心跳，不是匀速传送带）。 */
          state.lingerUntil = Date.now() + 1500 + Math.random() * 1000;
          var b = h('div', 'rev-bubble', text);
          b.style.left = (8 + Math.random() * 54) + '%';
          b.style.top = (18 + Math.random() * 40) + '%';
          danmaku.appendChild(b);
          setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 4200);
        }
        function stopLoops() {
          if (state.timer) { clearTimeout(state.timer); state.timer = null; }
          if (state.scrollTimer) { clearTimeout(state.scrollTimer); state.scrollTimer = null; }
          /* 打断进行中的 smooth 滚动（qs 的三连补刀：同步赋值 + auto + 下帧再一刀） */
          try {
            var sc = state.scroller;
            if (sc && sc.isConnected) {
              var y = sc.scrollTop;
              sc.scrollTop = y;
              try { sc.scrollTo({ top: y, behavior: 'auto' }); } catch (e) {}
              setTimeout(function () { try { if (sc.isConnected) sc.scrollTop = sc.scrollTop; } catch (e) {} }, 0);
            }
          } catch (e) {}
        }
        function teardown() {
          stopLoops();
          if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
          if (capsule.parentNode) capsule.parentNode.removeChild(capsule);
          if (danmaku.parentNode) danmaku.parentNode.removeChild(danmaku);
          revRunning = false;
        }
        function finish(interrupted) {
          if (state.done) return;
          state.done = true;
          teardown();
          var summary = rc.buildSummary(charName, state.items, state.thoughts);
          var learnedAll = state.items.map(function (it) { return it.learned; }).filter(Boolean).join('；');
          addMessage(chatId, {
            id: newId(), role: 'system', type: 'revcheck',
            content: summary,
            /* 卡片数据（2026-10-29 二次口径）：**不复述翻了哪** —— user
               全程跟着 TA 的视角看，页面清单是复读。卡片只留收尾的氛围：
               心声 + 一句结尾。pages 照旧进 summary（那是给模型接话用的）。 */
            rev: {
              thoughts: state.thoughts.slice(0, 3),
              learned: learnedAll,
              end: REV_END_FLAVOR[Math.floor(Math.random() * REV_END_FLAVOR.length)]
            },
            timestamp: Date.now()
          });
          /* learned 落 TA 记忆（标注来源），TA 下轮起长期记得 */
          if (learnedAll) {
            try { commitMemory(chatId, 'assistant', '（翻看了你的手机）' + learnedAll); }
            catch (e) { /* 记忆失败不影响播报 */ }
          }
          /* eventNote 注入下一轮：TA 主动接住看到的内容 */
          revSave(chatId, function (w) {
            w.lastAt = Date.now();
            w.note = summary;
          });
          /* 收尾还页：接管途中可能切到了朋友圈/群声……看完要把屏幕还给
             user —— nav.open 对已在栈里的 id 是「退回那一层」，顺手把
             浏览途中压上去的页面全弹掉，落回这段聊天本身。 */
          try {
            if (Sleepy.nav && Sleepy.nav.top() !== 'chat-detail') {
              Sleepy.nav.open('chat-detail', { chatId: chatId });
            }
          } catch (e) { /* 还页失败不影响播报 */ }
          renderMessages();
          ctx.toast(interrupted ? 'TA 被你抓个正着' : (charName + ' 看完了你的手机'), 'ok');
          /* 看完要有下文（2026-10-29 用户「查完之后他不说话么」）：
             eventNote 刚挂好，直接让 TA 开口接住这一眼 —— 被打断也一样，
             被抓个正着更要说话。等回复中就让下一轮自然带。 */
          requestReply({ proactive: true });
        }
        /* 模拟手指滚屏 —— 2026-10-29 用户「不想太机械化」：
           旧版是每 1.2s 匀速滚一格的传送带。现在每拍随机决定：
           往下翻一截 / 往回再看看 / 停住不动（在读）/ 甩到底或回顶，
           节奏 700~2200ms 不等；心声飘过来时再停 1.5~2.5s 像在想。 */
        function revScrollTick(scroller) {
          if (!scroller || !scroller.isConnected || state.done || state.paused) return;
          if (Date.now() < state.lingerUntil) {
            /* 发呆中：不动，只等 */
            state.scrollTimer = setTimeout(function () { revScrollTick(scroller); }, 300);
            return;
          }
          var maxTop = scroller.scrollHeight - scroller.clientHeight;
          if (maxTop > 0) {
            var r = Math.random();
            if (r < 0.48) {
              /* 往下翻，翻多少随缘 */
              var step = scroller.clientHeight * (0.4 + Math.random() * 0.45);
              scroller.scrollTo({ top: Math.min(scroller.scrollTop + step, maxTop), behavior: 'smooth' });
            } else if (r < 0.64) {
              /* 往回再看看（有的地方值得读第二遍） */
              var back = scroller.clientHeight * (0.2 + Math.random() * 0.35);
              scroller.scrollTo({ top: Math.max(scroller.scrollTop - back, 0), behavior: 'smooth' });
            } else if (r < 0.86) {
              /* 停住读一会儿 */
              state.lingerUntil = Date.now() + 900 + Math.random() * 1600;
            } else {
              /* 甩到底或拉回顶 */
              scroller.scrollTo({ top: Math.random() < 0.5 ? maxTop : 0, behavior: 'smooth' });
            }
          }
          state.scrollTimer = setTimeout(function () { revScrollTick(scroller); },
            700 + Math.random() * 1500);
        }
        /* 每一步停留时长也随机（3.8~6.4s），别像闹钟一样到点就走 */
        function revStepDwell() { return 3800 + Math.random() * 2600; }
        /* 末步收尾先等在途心声（v288）：真模型的想法有延迟（思维链更慢），
           翻页每步只停几秒 —— 以前 state.done 一落，迟到的想法全被丢，
           用户实测「飘出来的只有一条」（其余都死在了回包路上）。
           翻完翻页先等在途请求落地（上限 20s，防接口挂起拖死收尾），
           等待期间该飘的照飘。手动 × 打断不等 —— 用户要的就是立刻停。 */
        function revFinishSoon(interrupted) {
          if (!state.waitUntil) state.waitUntil = Date.now() + 20000;
          if (state.inflight > 0 && Date.now() < state.waitUntil) {
            state.timer = setTimeout(function () { revFinishSoon(interrupted); }, 400);
            return;
          }
          finish(interrupted);
        }
        function advance() {
          if (state.done || state.paused) return;
          var next = state.idx + 1;
          if (next >= plan.length) { revFinishSoon(false); return; }
          state.idx = next;
          var step = plan[next];
          var opened = revOpenPage(step);
          var item = { pageName: step.pageName, detail: step.detail, learned: '' };
          state.items.push(item);
          state.scroller = null;
          state.lingerUntil = 0;
          state.timer = setTimeout(function () {
            if (state.done || state.paused) return;
            if (opened) {
              state.scroller = revFindScroller();
              revScrollTick(state.scroller);
            }
            var sampled = revSample(step);
            item.detail = sampled.detail; item.learned = sampled.learned;
            state.inflight++;
            revThought(charName, persona, { pageName: step.pageName, detail: sampled.detail, learned: sampled.learned })
              .then(function (t) {
                state.inflight--;
                /* 模型想法没到位就走保底 —— 每一步都保证有一条心声飘过。
                   收尾等待期（done 还没落）迟到的想法照收；暂停期间收进
                   卡片但不再飘（弹幕层还在，只是人按了暂停）。 */
                if (state.done) return;
                if (!t) t = revFallbackThought();
                state.thoughts.push(t);
                if (!state.paused) danmu(t);
              });
            state.timer = setTimeout(advance, revStepDwell());
          }, opened ? 500 + Math.random() * 600 : 200);
        }
        pauseB.addEventListener('click', function () {
          state.paused = !state.paused;
          pauseB.textContent = state.paused ? '▶' : '⏸';
          capsule.classList.toggle('is-paused', state.paused);
          if (state.paused) { stopLoops(); }
          else {
            state.scroller = revFindScroller();
            revScrollTick(state.scroller);
            state.timer = setTimeout(advance, revStepDwell());
          }
        });
        stopB.addEventListener('click', function () { finish(true); });

        revRunning = true;
        ctx.toast(charName + ' 开始查看你的手机…', 'info');
        advance();
      }
      var revRunning = false;

      /** 反查状态/倾向（自动推导 + chat.rev.override 覆盖） */
      function revPersonaOf(ch, chat) {
        var st = revStateOf(chat);
        return st.override || (ch ? ch.content : '') || '';
      }

      /** 反查总开关（对话设置页那块）：关了 = 这条对话不许 TA 翻手机 */
      function revEnabled(chat) {
        return !(chat && chat.rev && chat.rev.off);
      }

      /** 手动入口（加号面板）。2026-10-29 用户口径改版：点格子 = **当场开演** ——
          落递手机卡 + 「TA 接过了手机」，随即启动接管（遮罩 + 真页面切换 +
          心声弹幕）。不再等 TA 下一轮回复夹 [[REV_ACCEPT]] —— 上一版等一轮，
          模型经常不夹标签，user 点完什么都不发生，整个功能就「平淡」掉了。
          TA 的「反应」不丢：翻看中的心声弹幕 + 收尾播报就是 TA 的反应。
          [[REV_PEEK]]（TA 自己起意）路径不受影响。 */
      function revManual(ctx2) {
        var rc = Sleepy.revcheck;
        if (!rc) return;
        var chat = getChat(chatId);
        var ch = findCharacter(chat && chat.characterId);
        if (!chat || !ch) return;
        if (!revEnabled(chat)) { ctx2.toast('这条对话关掉了反查手机（对话设置里可以开回来）', 'warn'); return; }
        addMessage(chatId, {
          id: newId(), role: 'user', type: 'rev-invite',
          content: '你把手机递给了「' + ch.name + '」，屏幕朝上——「想看就看吧」',
          timestamp: Date.now()
        });
        addMessage(chatId, {
          id: newId(), role: 'system', type: 'pat',
          content: '「' + ch.name + '」接过了你的手机', timestamp: Date.now()
        });
        revSave(chatId, function (w) { w.lastAt = Date.now(); });
        renderMessages();
        revRun(ch.name, revPersonaOf(ch, chat), getChat(chatId));
      }

      /** TA 回复里的邀请应答（onDone 链调）：有 [[REV_ACCEPT]] 就当场开翻。
          邀请一次性：无论接没接都清掉。返回剥净正文。 */
      function applyRevInvite(chatId, raw) {
        if (!Sleepy.revcheck) return String(raw || '').trim();
        var parsed = Sleepy.revcheck.parseAcceptTag(raw);
        var chat = getChat(chatId);
        if (!chat || !revStateOf(chat).invite) return parsed.text;   /* 没邀请也照剥防泄漏 */
        revSave(chatId, function (w) { w.invite = null; });
        if (parsed.accept && !revEnabled(chat)) return parsed.text;  /* 开关关了：起意不放行 */
        if (parsed.accept) {
          var ch = findCharacter(chat.characterId);
          var charName = ch ? ch.name : '对方';
          addMessage(chatId, {
            id: newId(), role: 'system', type: 'pat',
            content: '「' + charName + '」接过了你的手机', timestamp: Date.now()
          });
          renderMessages();
          revRun(charName, revPersonaOf(ch, chat), getChat(chatId));
        }
        return parsed.text;
      }

      /** 主动起意（v1.3 剧情驱动）：TA 回复里夹 [[REV_PEEK]] = 剧情上真的想看，
          当场开翻。不掷骰子——频率由剧情控制，冷却只当保险丝（防模型上头）。
          标签一律从正文剥净（没起意也照剥防泄漏）。返回剥净正文。 */
      function applyRevPeek(chatId, raw) {
        if (!Sleepy.revcheck) return String(raw || '').trim();
        var parsed = Sleepy.revcheck.parsePeekTag(raw);
        var chat = getChat(chatId);
        if (!parsed.peek || !chat) return parsed.text;
        if (!revEnabled(chat)) return parsed.text;   /* 开关关了：起意不放行（标签照剥） */
        var ch = findCharacter(chat.characterId);
        var persona = revPersonaOf(ch, chat);
        if (!Sleepy.revcheck.canPeekNow({ persona: persona, lastAt: revStateOf(chat).lastAt || 0 }, Date.now())) {
          return parsed.text;   /* none 档 / 冷却未过：起意也不放行（标签照剥） */
        }
        revSave(chatId, function (w) { w.lastAt = Date.now(); });
        revRun(ch.name, persona, chat);
        return parsed.text;
      }

      /* ==================== 关系人账户（ta-relations.js 接线层） ====================

        活人系统 L1：TA 认识的第三人，自治生长（用户定稿：不走提案确认）。
        · 注入：buildMessages 每轮垫「身边的人」摘要（印象强制「未必属实」）；
        · 生长：每次回复后 fire-and-forget——提及检测（全名精确匹配自动记
          lastMentioned）+ 挑最久没养的账户让 LLM 养一格近况（节流：同账户
          3 天不重复喂、每轮至多 1 个）。LLM 失败静默，绝不阻塞聊天。
        铁律在 ta-relations.js（note 永不覆盖 / learned 未必属实 / 严禁换人）。 */

      function taRelTick(chatId, replyText) {
        var tr = Sleepy.taRelations;
        if (!tr) return;
        var chat = getChat(chatId);
        if (!chat || !chat.characterId) return;
        var now = Date.now();
        tr.touchMentioned(chat.characterId, chat.sandboxId, replyText, now);
        var acc = tr.pickForAdvance(chat.characterId, chat.sandboxId, now);
        if (!acc) return;
        var api = Sleepy.api;
        if (!api || !api.candidates || !api.requestOnce) return;
        /* 2026-10-29 修：配置在 cand.cfg 里（同 revThought），以前裸读候选
           对象上的地址 → 永远 undefined → 关系推进从来没发出去过。改走 requestOnce。 */
        var cand = api.candidates()[0];
        if (!cand || !cand.cfg || !cand.cfg.baseUrl || !cand.cfg.apiKey) return;
        var recent = (chat.messages || []).slice(-6).map(function (m) {
          return (m.role === 'user' ? '你：' : 'TA：') + String(m.content || '').slice(0, 40);
        }).join('\n');
        /* 真机实测（xinxiwang 网关，2026-10-25）：思维链模型一来慢、二来
           reasoning_content 会挤配额 —— requestOnce 的 60s 底线 + 大 maxTokens
           正合适，后台 fire-and-forget 等得起。 */
        api.requestOnce(cand, [{ role: 'user', content: tr.buildAdvancePrompt(acc, recent) }],
          { maxTokens: 2000 })
          .then(function (r) {
            if (!r || !r.ok) return;
            var raw = String(r.content || '').trim();
          var patch = null;
          var m = raw.match(/\{[\s\S]*\}/);
          if (m) { try { patch = JSON.parse(m[0]); } catch (e) { patch = null; } }
          if (!patch) {
            /* 宽容提取：content 被思维链挤截断时，半个 JSON 也把字段捞回来 */
            patch = {};
            var f = function (key) {
              var fm = raw.match(new RegExp('"' + key + '"\s*:\s*"([^"]*)"'));
              return fm ? fm[1] : '';
            };
            patch.currentState = f('currentState');
            patch.learned = f('learned');
            if (!patch.currentState && !patch.learned) return;
          }
          tr.applyAdvance(chat.characterId, chat.sandboxId, acc.id, patch, Date.now());
        }).catch(function () { /* 静默：requestOnce 不 reject，这里只是兜底 */ });
      }

      /** L2 今日块：今天还没有 → 生成一次（一天一次/角色；素材只从账本读；
          生成失败静默，明天再试——绝不阻塞聊天）。 */
      function taTodayTick(chatId) {
        var td = Sleepy.taToday;
        if (!td) return;
        var chat = getChat(chatId);
        if (!chat || !chat.characterId) return;
        if (td.get(chat.characterId, chat.sandboxId)) return;   /* 今天已有 */
        var api = Sleepy.api;
        if (!api || !api.candidates || !api.requestOnce) return;
        /* 2026-10-29 修：同 revThought —— 配置在 cand.cfg 里，以前裸读
           候选对象上的地址 → 永远 undefined → 今日块从来没生成过。 */
        var cand = api.candidates()[0];
        if (!cand || !cand.cfg || !cand.cfg.baseUrl || !cand.cfg.apiKey) return;
        var ch = findCharacter(chat.characterId);
        var material = td.buildMaterial(chat.characterId, chat.sandboxId);
        api.requestOnce(cand, [{ role: 'user', content: td.buildPrompt(ch ? ch.name : 'TA', material) }],
          { maxTokens: 2000 })
          .then(function (r) {
            if (!r || !r.ok) return;
            var raw = String(r.content || '').trim();
            var m = raw.match(/\{[\s\S]*\}/);
            if (!m) return;
            var fields;
            try { fields = JSON.parse(m[0]); } catch (e) { return; }
            td.put(chat.characterId, chat.sandboxId, fields, Date.now());
          }).catch(function () { /* 静默：明天再试 */ });
      }

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

          /* 撤回（2026-10-06）：
             - user 撤回的：TA **永远知道你撤回了一条**（动作藏不住，
               灰字就杵在那），但内容只有掷骰命中（recallSeen）才进上下文；
             - TA 撤回的：话是 TA 说的，TA 自己记得 —— 原文照常进上下文，
               只是屏幕上变灰字（不在这里动，走下面的常规分支）。 */
          if (m.recalledAt && m.role === 'user') {
            var rcLine = m.recallSeen
              ? ((m.content || '') + '\n（随后撤回了这条）')
              : '（撤回了一条消息，你没看到内容）';
            if (rcLine) out.push({ role: 'user', content: rcLine, at: m.timestamp });
            return;
          }

          var text = m.type ? attachText(m) : (m.content || '');
          if (!text) return;
          if (m.quote) {
            /* 口径按说话人换算（2026-10-29）：历史回喂是「这条消息的说话人」
               在讲 —— user 的消息里「我自己」= user；TA 的回复里引用了你，
               「我自己」= TA、「你」= user，两边别写反。 */
            if (m.role === 'user') {
              text = '（引用' + (m.quote.role === 'user' ? '我自己' : '你') +
                     '刚说的：“' + m.quote.content + '”）\n' + text;
            } else {
              text = '（引用' + (m.quote.role === 'user' ? '你' : '我自己') +
                     '刚说的：“' + m.quote.content + '”）\n' + text;
            }
          }
          /* 多模态读图：user 的照片带真图进请求（data URL 备好了才带，
             没备好先文字占位 + 异步补，下一轮就能看见）。 */
          if (m.type === 'photo' && m.role === 'user' && m.mediaId &&
              !visionBroken && !m.quote) {
            var imgData = imgDataCache[m.mediaId];
            if (imgData) {
              out.push({
                role: 'user',
                at: m.timestamp,   /* 历史时间标注（2026-10-15 方案 A）：装配层渲染行内戳 */
                content: [
                  { type: 'text', text: text },
                  { type: 'image_url', image_url: { url: imgData } }
                ]
              });
              return;
            }
            preloadPhotoData(m.mediaId);
          }
          out.push({ role: m.role, at: m.timestamp, content: text });
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
            history: out,
            /* 旁白描述（2026-10-25）：这条对话自己的开关与文风/字数/密度。
               没开 = undefined → narrCard 返回 '' → narr 槽不注入。 */
            narr: c.narration || null,
            /* 线下接续（2026-10-28）：离开线下模式时交接的原文转录，
               没离开过 = undefined → offhandoff 槽不注入。 */
            offlineHandoff: c.offlineHandoff || null
          });
          /* 候选补丁 2026-10-13：引擎开分支走同一套人物/协议诊断
             （built.protocol 是 c05 槽实际生效正文，文本判空）。 */
          var diagNew = chatDiagPersona(c);
          var activeNew = diagNew.flags.concat(
            String(built.protocol || '').trim() ? [] : ['protoBlank']);
          chatDiagCommit(c, activeNew).forEach(function (f) { ctx.toast(f.msg, 'warn'); });
          /* 日记事件垫在历史后面 —— 它是刚发生的事，比历史都新 */
          var peek = diaryPeekMsg(c.characterId);
          if (peek) built.messages.push(peek);
          /* 小游戏结算（同一次性垫法）：对方玩完 TA 送的游戏，下一轮让 TA 知道 */
          var gamePeek = gameResultPeekMsg(chatId);
          if (gamePeek) built.messages.push(gamePeek);
          /* 文字麻将牌局（wm-core.js）：对局进行中每轮垫上下文（规则/手牌/
             待裁决句 + 标签写法）。不是一次性 peek —— 牌局活着就要垫。
             旧组装路径在下面同款 unshift，两处口径一致（都读 c.wm）。 */
          var wmCtx = wmContextMsg(chatId);
          if (wmCtx) built.messages.push(wmCtx);
          /* 反查手机：看完后的「知道了」注入下一轮（note 在回复落库后清） */
          /* 反查手机：总开关关了就什么都不注入（入口/起意/应答全停） */
          if (revEnabled(getChat(chatId))) {
            var revNote = revStateOf(getChat(chatId)).note;
            if (revNote) built.messages.push({ role: 'system', content: '（你刚刚翻看了 ta 的手机，' + revNote + ' 可以自然地把看到的内容化进回复里——接话、吃醋、装不知道都行，按你的性格来。不要复述这条指令。）' });
            /* 递手机邀请挂着：让 TA 自己决定接不接（接 = 夹 [[REV_ACCEPT]]） */
            if (revStateOf(getChat(chatId)).invite) {
              built.messages.push({ role: 'system', content: '（对方刚刚把手机递给你，邀请你翻看——手机里的内容是真实的。想接就在回复末尾夹 [[REV_ACCEPT]]，系统会随即开始翻看；不想接就直接说，别夹标签。接不接、什么态度，按你的性格来。不要复述这条指令。）' });
            } else if (revStateOf(getChat(chatId)).note) {
              /* 刚翻看完的消化轮，不再挂起意说明 */
            } else if (Sleepy.revcheck &&
                       Sleepy.revcheck.canPeekNow({ persona: revPersonaOf(findCharacter(getChat(chatId).characterId), getChat(chatId)), lastAt: revStateOf(getChat(chatId)).lastAt || 0 }, Date.now())) {
              /* 主动起意说明（v1.3 剧情驱动，不掷骰）：只在保险丝闸放行时挂，
                 TA 剧情上真的起意才夹 [[REV_PEEK]] */
              built.messages.push({ role: 'system', content: '（你随时可以翻看 ta 的手机——手机里的内容是真实的。仅当此刻剧情上你真的起意了：吃醋、起疑、八卦到忍不住——才在回复末尾夹 [[REV_PEEK]]，系统会随即开始翻看；程度没到就千万别夹，也不要提这件事。不要复述这条指令。）' });
            }
            /* 关系人账户：每轮垫「身边的人」摘要（印象带「未必属实」兜底） */
            if (Sleepy.taRelations) {
              var relSum = Sleepy.taRelations.buildSummary(c.characterId, c.sandboxId);
              if (relSum) built.messages.push({ role: 'system', content: relSum });
            }
            /* L2 今日状态块：挂最前（SullyOS 口径——今天的底色比一切都新） */
            if (Sleepy.taToday) {
              var tdCtx = Sleepy.taToday.buildContext(c.characterId, c.sandboxId);
              if (tdCtx) built.messages.unshift({ role: 'system', content: tdCtx });
            }
          }
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
          /* L4 向量召回（2026-10-12 P1-1 修）：引擎路径走 compileRecall/K03c 槽，
             旧路径此前整层缺失 —— prefetch 在 requestReply 里不分引擎都跑，
             这里同步读缓存即可；没配向量/没召回返回 ''，不加空段。 */
          var recOld = (Sleepy.memoryVec && Sleepy.memoryVec.text)
            ? (Sleepy.memoryVec.text(c.characterId, c.userId || null) || '') : '';
          if (recOld) out.unshift({ role: 'system', content: recOld });
          if (sys) out.unshift({ role: 'system', content: sys });
        } else if (Sleepy.memoryVec && Sleepy.memoryVec.text) {
          /* switcher 整个不在时也别丢召回（同上，同步读缓存） */
          var recOld2 = Sleepy.memoryVec.text(c.characterId, c.userId || null);
          if (recOld2) out.unshift({ role: 'system', content: recOld2 });
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
        /* 换头像说明书：开关开着 + 库里有图才注入（关着时一个字都不提） */
        var avSpecOld = avatarSwapSpec(chatId);
        if (avSpecOld) out.unshift({ role: 'system', content: avSpecOld });
        /* 线下接续（2026-10-28）：旧组装路径同款注入（走 prompt-engine 的
           唯一实现，别复制第二份）。没离开过线下就不加。 */
        if (Array.isArray(c.offlineHandoff) && c.offlineHandoff.length &&
            Sleepy.promptEngine && Sleepy.promptEngine.compileOfflineHandoff) {
          var offOld = Sleepy.promptEngine.compileOfflineHandoff(c.offlineHandoff);
          if (offOld) out.unshift({ role: 'system', content: offOld });
        }
        /* 小游戏结算：引擎关掉时也照垫（同引擎路径 gameResultPeekMsg） */
        var gamePeekOld = gameResultPeekMsg(chatId);
        if (gamePeekOld) out.push(gamePeekOld);
        /* 文字麻将：引擎关掉时同款垫牌局上下文（口径见引擎路径 wmCtx） */
        var wmCtxOld = wmContextMsg(chatId);
        if (wmCtxOld) out.push(wmCtxOld);
        /* 反查手机：旧组装路径同款注入（总开关关了什么都不注入，口径见引擎路径） */
        if (revEnabled(getChat(chatId))) {
          var revNoteOld = revStateOf(getChat(chatId)).note;
          if (revNoteOld) out.push({ role: 'system', content: '（你刚刚翻看了 ta 的手机，' + revNoteOld + ' 可以自然地把看到的内容化进回复里。不要复述这条指令。）' });
          /* 递手机邀请：旧组装路径同款（口径见引擎路径） */
          if (revStateOf(getChat(chatId)).invite) {
            out.push({ role: 'system', content: '（对方刚刚把手机递给你，邀请你翻看。想接就在回复末尾夹 [[REV_ACCEPT]]；不想接就直接说，别夹标签。按你的性格决定。）' });
          } else if (Sleepy.revcheck &&
                     Sleepy.revcheck.canPeekNow({ persona: revPersonaOf(findCharacter(getChat(chatId).characterId), getChat(chatId)), lastAt: revStateOf(getChat(chatId)).lastAt || 0 }, Date.now())) {
            out.push({ role: 'system', content: '（你随时可以翻看 ta 的手机。仅当剧情上你真的起意了才在回复末尾夹 [[REV_PEEK]]；程度没到就别夹，也不要提这件事。）' });
          }
          /* 关系人账户：旧组装路径同款垫摘要 */
          if (Sleepy.taRelations) {
            var relSumOld = Sleepy.taRelations.buildSummary(c.characterId, c.sandboxId);
            if (relSumOld) out.push({ role: 'system', content: relSumOld });
          }
          /* L2 今日状态块：旧组装路径同款（挂最前） */
          if (Sleepy.taToday) {
            var tdCtxOld = Sleepy.taToday.buildContext(c.characterId, c.sandboxId);
            if (tdCtxOld) out.unshift({ role: 'system', content: tdCtxOld });
          }
        }

        /* 心声跟主回复一起出：往最前面塞一条系统指令，要求模型把
           「没说出口的心里话」用 <心声>…</心声> 包在正文末尾。
           这样一轮聊天只发一次请求（上一版是聊完再补发一次，额度翻倍）。
           放在 slice 之后，所以不会被上下文条数截掉。 */
        /* 拍一拍说明书：一行就够 —— 动作是调味的，写多了模型会刷 */
        out.unshift({ role: 'system', content:
          '偶尔可以「拍一拍」对方：单独一行写 [拍一拍:后缀]（如 [拍一拍:脑袋]，后缀可省）。不要常用。' });

        /* 撤回说明书：同引擎路径的 msgrecall 卡，文案保持一致（口径同上） */
        out.unshift({ role: 'system', content:
          '刚说的话可以反悔：单独一行写 [撤回:第几条|原因]，如 [撤回:1|说得太冲了想收回来]（1=你上一条发出去的消息，2=再往前一条，最多数到 3）。原因用一句话，对方点那条灰字就能看到。不要常用。' });

        /* 引用说明书：同引擎路径的 quotetag 卡，文案保持一致（口径同上） */
        out.unshift({ role: 'system', content:
          '想针对对方刚说的某一句话回应时，可以在回复开头单独一行写 [引用:那句话的关键原文]，如 [引用:今晚不回来吃饭]（截取对方原话里最关键的一截就行，不用全抄）。引用条会显示在你的气泡下面。偶尔用，别每条都带。' });

        /* 灯牌说明书：同引擎路径的 lamptag 卡，文案保持一致（口径同上）。
           这是一个随时可用的能力，不是主动消息的附属 —— 40 字是灯牌卡面
           的实际容量，超了程序侧会截断（page-desktop lampNotes）。 */
        out.unshift({ role: 'system', content:
          '桌上有盏挂件灯，你想留句话就单独一行写 [灯:那句话]，如 [灯:记得多喝水]（40 字内；这句话会挂到灯上展示，气泡里不显示，用不着写在正文里重复一遍）。什么时候想留都可以，不用每条都留。' });

        /* 慢递信箱说明书：同引擎路径的 slowmail 卡，文案保持一致（口径同上）。 */
        out.unshift({ role: 'system', content:
          '你还可以写慢递信：单独一行写 [慢递:小时数|信的内容]，如 [慢递:6|（信的正文，可以长一些）]。信会在 N 小时后送进对方的信箱（1 到 72），到点前对方看不到。适合想说但不必马上被看到的话；偶尔写一封就好。' });

        /* 旁白描述说明书（2026-10-25）：这条对话开了旁白才注入 —— 引擎路径
           走 narr 槽（ctx.narr），这里是旧组装路径的同步注入，同一份文案
           （prompt-engine.narrCard），两处互斥不叠加。 */
        var peNarr = Sleepy.promptEngine;
        var narrTextOld = (peNarr && peNarr.narrCard && c.narration && c.narration.on)
          ? peNarr.narrCard(c.narration) : '';
        if (narrTextOld) out.unshift({ role: 'system', content: narrTextOld });

        /* ---- 候选补丁 2026-10-13 收口版：协议 + 人物，同一可核对片段 ----
           口径：两条正常私聊路径都要完整带分泡+心声；c05 完整时整卡注入
           （去重：不再叠加旧 heartbeat.replySpec），关闭行为引擎不丢它们；
           heartbeatAuto 是遗留字段，只决定「c05 无效时旧心声回退注不注入」，
           不据此拆分/改写 c05。最终 system 顺序（unshift 后进先出）：
             [CHARACTER]人设 → 输出协议 → (旧心声仅回退时) → 慢递 → 灯
             → 撤回 → 拍一拍 → genimg → stickers → 认知 → 召回 → 历史(+尾插)
           （顺序由零网络完整链路断言验证。） */
        var cfgOld = store.get('chatDefaults') || {};
        var hbAutoOld = cfgOld.heartbeatAuto !== false;   /* 遗留字段：见上 */
        var peOld = Sleepy.promptEngine;
        var c05OvrOld = peOld ? peOld.isOverridden('c05') === true : false;
        var c05BodyOld = peOld ? String(peOld.cardBody('c05') || '') : '';
        var c05BlankOld = c05OvrOld && !c05BodyOld.trim();   /* 空串或纯空白覆盖 = 无效 */
        var protoKindOld = 'none';   /* c05-default | c05-custom | heartbeat-only | none */
        var protoTextOld = '';
        if (peOld && !c05BlankOld) {
          /* c05 有效（默认或非空自定义）：整卡原样注入，不拆句、不覆写用户保存值；
             心声要求随卡在 —— 这就是去重，不是取消心声。 */
          protoTextOld = c05BodyOld;
          protoKindOld = c05OvrOld ? 'c05-custom' : 'c05-default';
        } else if (hbAutoOld) {
          /* c05 无效 + 遗留心声开关开着：回退旧心声指令（旧口径，无分泡要求） */
          protoTextOld = Sleepy.heartbeat.replySpec();
          protoKindOld = 'heartbeat-only';
        }
        /* 旧心声指令只在协议未覆盖心声职责时注入 —— 同一请求不出现两套心声要求 */
        if (hbAutoOld && protoKindOld === 'none' && out.length) {
          out.unshift({ role: 'system', content: Sleepy.heartbeat.replySpec() });
        }
        /* 人物诊断与协议诊断共用一套状态机（引擎开/关、普通回复/reroll 全覆盖） */
        var diagOld = chatDiagPersona(c);
        var activeOld = diagOld.flags.concat(chatDiagProtocol(c, { kind: protoKindOld }));
        chatDiagCommit(c, activeOld).forEach(function (f) { ctx.toast(f.msg, 'warn'); });
        /* 注入顺序：先 unshift 协议、再 unshift 人设 ⇒ 人设最终排在协议前面 */
        if (protoTextOld) out.unshift({ role: 'system', content: protoTextOld });
        if (diagOld.personaText) out.unshift({ role: 'system', content: diagOld.personaText });

        /* 历史时间标注（2026-10-15 方案 A，旧路径收尾）：行内戳 + 间隔事实。
           只动带 at 的历史条目（system 块没有 at，不受影响）。引擎开路径
           已在 assembleOnline 内做同样的事 —— 引擎开时上面提前 return，
           走不到这里，两边不会叠加。 */
        var calOld = Sleepy.calendar;
        if (calOld && calOld.histStamp) {
          var tzOld = '';
          try { tzOld = ((calOld.cfgOf(c.characterId) || {}).timezone) || ''; } catch (e) { tzOld = ''; }
          var lastAtOld = 0;
          out.forEach(function (mm) {
            if (!mm.at) return;
            mm.content = (Array.isArray(mm.content))
              ? mm.content.map(function (part) {
                  return (part && part.type === 'text')
                    ? { type: 'text', text: calOld.histStamp(mm.at, { tz: tzOld }) + part.text }
                    : part;
                })
              : calOld.histStamp(mm.at, { tz: tzOld }) + String(mm.content == null ? '' : mm.content);
            if (mm.at > lastAtOld) lastAtOld = mm.at;
          });
          var gOld = (lastAtOld && calOld.gapLine) ? calOld.gapLine(lastAtOld) : '';
          if (gOld) out.push({ role: 'user', content: '（' + gOld + '）' });
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

      /* 装配前的异步预取（装配是同步的，结果只能先落缓存）：
         ① L4 召回 —— memoryVec.prefetch，自带超时；
         ② 真实世界感知 —— core.realworld.poke，把天气/热榜拉进缓存
            （4s 兜底超时），compileRealworld 装配时同步读。
         两件并行，宁可这轮空着也不把聊天卡住。 */
      function requestReply(opts) {
        opts = opts || {};
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }

        var c0 = getChat(chatId);
        var jobs = [];
        var mv = Sleepy.memoryVec;
        if (mv && mv.prefetch && c0 && c0.characterId) {
          jobs.push(mv.prefetch(c0.characterId, c0.userId, recallQuery(c0), { sinceAt: recallFloor(c0) }));
        }
        var rw = (Sleepy.core && Sleepy.core.realworld) ? Sleepy.core.realworld : null;
        if (rw && rw.poke) jobs.push(rw.poke());
        if (jobs.length) Promise.all(jobs).then(function () { runReply(opts); });
        else runReply(opts);
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
        revealReset();
        pending = { raw: '', timestamp: Date.now(), targetId: opts.targetId || null };
        renderMessages();
        updateSendUI();

        /* 流式开关：这个对话自己设了就用它的，否则跟随全局。
           false 是有效值，所以判断必须用 != null，不能 || 兜底 */
        var ovNow = overridesOf(getChat(chatId));
        var useStream = (ovNow.stream != null) ? ovNow.stream
                      : (store.get('chatDefaults.stream') !== false);
        /* 用量统计（2026-10-26）：全局开关（对话设置→Token 用量）。
           开了才在流式请求带 include_usage 换真用量；关着请求体与从前一字不差 */
        ovNow.askUsage = store.get('chatDefaults.usageStats') === true;

        /* MCP 工具（2026-10-06）：对话开了「MCP 工具」且设置里有开着的
           工具时，把 OpenAI tools 清单和执行器塞进 ov，交给 api.runChat ——
           工具循环在那边（强制非流式，见 requestToolLoop 的注释）。
           没配工具的对话 ov 一个多余字段都不带，请求体跟以前一模一样。 */
        var chatNow = getChat(chatId);
        if (chatNow && chatNow.mcpTools && Sleepy.mcp && Sleepy.mcp.enabledToolSpecs) {
          var mcpTools = Sleepy.mcp.enabledToolSpecs();
          if (mcpTools.length) {
            ovNow.tools = mcpTools;
            ovNow.toolCall = function (name, args) {
              return Sleepy.mcp.callToolByName(name, args);
            };
            useStream = false;
          }
        }

        /* 通知中心：这一轮对方开始「正在输入」（离开页面后顶端会常驻横幅） */
        if (Sleepy.msgCenter) Sleepy.msgCenter.typing({
          chatId: chatId,
          charId: (chatNow && chatNow.characterId) || null,
          name: charNameOf(chatNow) || '对方'
        });
        handle = api.runChat(msgs, {
          onDelta: function (delta) {
            if (mySeq !== reqSeq) return;
            pending.raw += delta;
            /* 流式热路径：以前每个 delta 都整页 renderMessages() ——
               innerHTML='' 把全部消息重画一遍，长对话接近 O(n²)。
               2026-09-26 用户再报「整条挤一个气泡、过一会儿才拆开」——
               拆段挪进流式：按 || 渐进拆，段数没变只改各段文本，
               段数变了才整页重画（一条回复顶多重画几次）。
               is-pending 气泡首帧就画好（类名都在身上）。
               2026-10-26 再加拟真节奏：新回复（不挂旧气泡的）不再把
               所有段同时涂上，而是按打字节奏逐条揭示（见 pendingReveal）；
               reroll（挂旧气泡重写）不 staging，走旧热路径。 */
            var segs = pendingSegs();
            if (!segs.length) return;         /* 还在打字点（一段正文都没有）就不动 */
            if (!pending.targetId) {
              if (pendingReveal.n === 0) {
                /* 第一条正文到了：只揭示第一泡，其余的泡给打字点按节奏来 */
                pendingReveal.n = 1;
                renderMessages();
                msgWrap.scrollTop = msgWrap.scrollHeight;
                scheduleReveal(segs);
                return;
              }
              var liveEls = msgWrap.querySelectorAll('.msg-bubble.is-pending .msg-text');
              if (liveEls.length === segs.length) {
                for (var ri = 0; ri < pendingReveal.n && ri < liveEls.length; ri++) {
                  liveEls[ri].textContent = segs[ri];
                }
                msgWrap.scrollTop = msgWrap.scrollHeight;
              } else {
                renderMessages();
              }
              scheduleReveal(segs);
              return;
            }
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
          onDone: function (cand, text, extra) {
            if (mySeq !== reqSeq) return;
            revealReset();   /* 落库即全量上屏，节奏揭示到此为止 */

            /* Token 用量（2026-10-26）：非流式 extra=res（res.data.usage）；
               流式 extra={usage}（对话设置开了「用量统计」才带 include_usage，
               接口不认时 api 层自动降级，拿不到就是 null —— 不阻塞落库） */
            var usageRec = null;
            var u0 = (extra && extra.usage) || (extra && extra.data && extra.data.usage) || null;
            if (u0 && (u0.prompt_tokens != null || u0.total_tokens != null)) {
              usageRec = {
                p: Number(u0.prompt_tokens) || 0,
                c: Number(u0.completion_tokens) || 0,
                t: Number(u0.total_tokens) ||
                   ((Number(u0.prompt_tokens) || 0) + (Number(u0.completion_tokens) || 0))
              };
            }

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
            /* 通知中心：回复落库。正盯着这个会话就不弹；离开后才回来才弹。 */
            if (Sleepy.msgCenter) {
              Sleepy.msgCenter.typingStop({ chatId: chatId });
              Sleepy.msgCenter.incoming({
                chatId: chatId,
                charId: (chatNow && chatNow.characterId) || null,
                name: charNameOf(chatNow) || '对方',
                text: String(text || '').replace(/\[[^\]]*\]/g, '').trim()
              });
            }

            /* 角色也能发表情：先把正文里的 [表情:名字] 抽出来，
               正文里那一段就去掉（不然屏幕上会杵着一个标签）。 */
            var st = extractStickers(finalText);
            finalText = st.text;

            /* 拍一拍标签同样抽掉（[拍一拍] / [拍一拍:后缀]） */
            var pt = extractPats(finalText);
            finalText = pt.text;

            /* [引用:那句话] 同样抽掉 —— TA 想引用着回。拿原文去最近消息里
               对号：对上就取那条消息的 role / id（引用条名字才标得对），
               对不上就默认记成 user 说的（引用着回多半回的是你那句话）。 */
            var rq = extractReplyQuote(finalText);
            finalText = rq.text;
            var replyQuote = null;
            if (rq.hit) {
              var rqSrc = matchQuotedMessage(chatId, rq.hit);
              replyQuote = {
                role: rqSrc ? rqSrc.role : 'user',
                content: rq.hit,
                msgId: rqSrc ? rqSrc.id : null,
                bubbleIndex: null
              };
            }

            /* [生图:描述] 同样抽掉 —— TA 想发照片，正文里不出现标签 */
            var gi = extractGenimgs(finalText);
            finalText = gi.text;

            /* [换头像:名字] 同样抽掉 —— TA 想换头像，正文里不出现标签 */
            var av = extractAvatarSwaps(finalText);
            finalText = av.text;

            /* [html]…[/html] 同样抽掉 —— TA 想送一个小游戏。落成 type:'html'
               的正式消息（沙箱渲染，见 commitHtmlGame / htmlGameCard）。
               心声里出现的话只剥不收：游戏是「送给对方玩」的，塞进
               「没说出口的心里话」语义不通，多半是模型写串了位置。 */
            var hg = extractHtmlGames(finalText);
            finalText = hg.text;
            if (split.whisper) {
              var hgx = extractHtmlGames(split.whisper);
              if (hgx.hit && !hg.hit) hg.hit = null; /* 不从心声收 */
              split.whisper = hgx.text;
            }

            /* 反查手机邀请应答：TA 回复里夹 [[REV_ACCEPT]] = 接过手机当场开翻；
               没夹 = 嘴上拒绝（TA 自己说的）。邀请一次性，无论接没接都清。
               标签从正文剥净（无邀请时也照剥防泄漏）。 */
            finalText = applyRevInvite(chatId, finalText);
            /* 主动起意（v1.3 剧情驱动）：TA 夹 [[REV_PEEK]] = 自己想看，当场开翻；
               不掷骰子——频率由剧情控制，冷却只当保险丝。标签照剥防泄漏。 */
            finalText = applyRevPeek(chatId, finalText);

            /* [撤回:N|原因] 同样抽掉 —— TA 想收回说过的话。抽完先别急着执行：
               执行要等下面落库动作都排完了（撤的是历史消息，跟落库顺序无关，
               但空正文判断要把「只撤回没说话」算进来）。 */
            var rc = extractRecalls(finalText);
            finalText = rc.text;

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
            /* 文字麻将（wm-core.js）：WM 标签解析要在剥正文的最前面做完——
               它要看见原始标签动牌，动完把标签剥干净（气泡/心声里永远只有人话）。
               无对局时它也照剥（防泄漏），只是不动牌。 */
            finalText = applyWmTags(chatId, finalText);
            if (split.whisper) split.whisper = Sleepy.wm ? Sleepy.wm.stripWmTags(split.whisper) : split.whisper;

            var trace = applyPhoneTrace(chatId, finalText);
            finalText = trace.text;
            var pdApplied = trace.applied;
            var granted = trace.granted;

            /* 灯牌留言同样抽掉（[灯:那句话]）—— 落库即上灯，署 char 的名。
               时间戳用现在：这是「TA 此刻留的话」，跟撤回那种引历史不同。 */
            var ln = extractLampNotes(finalText);
            finalText = ln.text;
            if (ln.hits.length && Sleepy.lampNotes) {
              var lampChat = getChat(chatId);
              for (var li = 0; li < ln.hits.length; li++) {
                Sleepy.lampNotes.add({
                  text: ln.hits[li].text,
                  by: charNameOf(lampChat),
                  ts: Date.now(),
                  src: 'lamp-tag'
                });
              }
            }

            /* 慢递信同样抽掉（[慢递:N|内容]）—— 落 slowLetters，到点可拆。
               写信时间就是现在；deliverAt 到点前组件只显示「N 小时后到」。 */
            var sm = extractSlowmail(finalText);
            finalText = sm.text;
            if (sm.hits.length) {
              var smChat = getChat(chatId);
              var smChar = core.findChar ? core.findChar(curCharId()) : null;
              var box = store.get('slowLetters') || [];
              for (var si = 0; si < sm.hits.length; si++) {
                var srec = core.tagScope({
                  id: newId('sl'),
                  charId: curCharId() || '',
                  charName: (smChar && smChar.name) || charNameOf(smChat),
                  body: sm.hits[si].body.slice(0, 600),
                  hours: sm.hits[si].hours,
                  deliverAt: Date.now() + sm.hits[si].hours * 3600000,
                  createdAt: Date.now(),
                  opened: false
                });
                box.push(srec);
              }
              store.set('slowLetters', box);
            }

            if (!finalText && !st.names.length && !pt.patted && !gi.descs.length &&
                !wp.hit && !pdApplied && !rc.hits.length && !ln.hits.length &&
                !sm.hits.length && !hg.hit && !av.names.length) {
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
              /* 自察（方案-预设页分类与自察-v1 C2）：parseReply 剥出来的
                 [自察] 块单独落库，不进 content（content 会回喂下一轮）。
                 只在开关开过时才有值；长按消息可看。 */
              var insp = split.inspect || null;
              if (target) patchMessage(chatId, target, { content: finalText, trans: transArr, timestamp: Date.now(), memoryId: memId, inspect: insp, usage: usageRec, quote: replyQuote });
              else {
                voiceMsgId = newId();
                addMessage(chatId, {
                  id: voiceMsgId,
                  role: 'assistant',
                  content: finalText,
                  trans: transArr,
                  timestamp: Date.now(),
                  memoryId: memId,
                  inspect: insp,
                  usage: usageRec,
                  quote: replyQuote
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
              /* 每日日程生成器（schedule-gen.js）：同上只管喊，
                 自然日 × 岛 节流在模块里；失败静默，不阻塞聊天 */
              if (Sleepy.scheduleGen) Sleepy.scheduleGen.maybeRun();
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
            /* 撤回排在动作类最前面执行：它改的是历史消息，不落新气泡。
               放这（而不是抽标签处）是因为候选要从**已落库**的消息里数，
               等上面 patchMessage/addMessage 都做完再动，口径才稳定。
               本轮回复自己（replyMsgId/target）不算「上一条」。 */
            if (rc.hits.length) applyCharRecalls(chatId, rc.hits, replyMsgId || target);
            /* TA 发的图排在表情后面，一次最多 2 张防刷 */
            gi.descs.slice(0, 2).forEach(function (desc) { charSendPhoto(desc); });
            /* TA 自己换头像排在动作类后面：它改的是角色记录，不落气泡本体，
               只留一句灰字让对方知道「TA 换了一张」（换不成则什么都不留）。 */
            if (av.names.length) {
              /* 异步：可能要先发一次「看图挑」的请求，挑完才落灰字 */
              applyCharAvatarSwap(chatId, av.names, function (sw) {
                if (!sw) return;
                addMessage(chatId, {
                  id: newId(), role: 'assistant', type: 'avatar-swap',
                  content: '「' + sw.name + '」换了一张头像' +
                    (sw.label ? '（' + sw.label + '）' : ''),
                  timestamp: Date.now()
                });
                ctx.toast('TA 换头像了', 'ok');
                renderMessages();
              });
            }
            /* HTML 小游戏排在图后面（同是「作品」类附件，一次一条） */
            if (hg.hit) commitHtmlGame(chatId, hg.hit, hg.truncated);
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
            /* 反查手机：上一轮的「知道了」这轮已消化 → 清 note。
               （v1.3 起主动查走 [[REV_PEEK]] 剧情起意，不再掷骰。） */
            try {
              revSave(chatId, function (w) { w.note = null; });
            } catch (e) { /* 反查失败不影响聊天 */ }
            /* 关系人账户自治生长（fire-and-forget）：提及检测 + 养一格近况。
               素材用剥净后的正文（taRelTick 内部全名精确匹配 + 3 天节流）。 */
            try { taRelTick(chatId, finalText); } catch (e) { /* 生长失败不影响聊天 */ }
            /* L2 今日块：今天还没有就生成一次（一天一次，失败静默明天再试） */
            try { taTodayTick(chatId); } catch (e) { /* 同上 */ }
          },
          /* 注意：runChat 暴露的是 onFail（全部候选都失败 / 一个候选都没有），
             不是 onError。写成 onError 的话没有任何回调会被触发，
             发送键会永久卡在禁用状态。api.js 头部的契约注释里写的就是 onFail。 */
          onFail: function (list, err) {
            if (mySeq !== reqSeq) return;
            if (Sleepy.msgCenter) Sleepy.msgCenter.typingStop({ chatId: chatId });
            /* 多模态熔断：接口看不了图（报错提到 image/vision）就退回文字占位，
               并提示一次 —— 不然每轮都为同一件事报错。会话级，重启恢复。 */
            var detail = String((err && err.detail) || '') + String((err && err.error) || '');
            if (!visionBroken && /image|vision|multimodal|图片|多模态/i.test(detail)) {
              visionBroken = true;
              ctx.toast('这个接口好像看不了图，已退回文字占位', 'warn');
            }
            pending = null;
            handle = null;
            revealReset();
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
        revealReset();                  /* 揭示计时器跟着这轮一起作废 */
        if (Sleepy.msgCenter) Sleepy.msgCenter.typingStop({ chatId: chatId });

        if (partial) {
          /* 半截回复里可能已经带着 [表情:…] 标签了 —— 去掉，但**不补发**
             （用户是主动停的，别再给他弹东西出来）。 */
          var pSt = extractStickers(partial);
          var pText = pSt.text;
          /* 收藏提议标签同样剥掉（P2）。提议动作本身已经完成，照常落库 ——
             收不收由 user 在卡片上决定，与「不补发表情」不冲突。 */
          var pWp = extractProposal(pText);
          pText = pWp.text;
          /* 半截回复里的 WM 标签同样剥干净（不动牌 —— 用户是主动停的） */
          if (Sleepy.wm) pText = Sleepy.wm.stripWmTags(pText);
          /* 反查邀请标签同样剥（半截回复不动接管流程）；[[REV_PEEK]] 同 */
          if (Sleepy.revcheck) pText = Sleepy.revcheck.parseAcceptTag(pText).text;
          if (Sleepy.revcheck) pText = Sleepy.revcheck.parsePeekTag(pText).text;
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
        if (!content && !pendingMoodStamp) {
          requestReply({ proactive: true });
          return;
        }

        /* 情绪印章：盖了章就发一枚带感知文案的消息。
           哪怕没打字也发（不走上面的 proactive），让角色读到
           「XX 给自己盖了一枚…的小印章，似乎是有点…的情绪」。 */
        if (pendingMoodStamp) {
          var ms = pendingMoodStamp;
          /* 防御：理论上 syncMoodStamp 已清掉跨天残留，这里再兜一道 */
          if (ms.date !== todayStr()) {
            setMoodStamp(null);
          } else {
            var sd = stampById(ms.id);
            if (!sd) {
              setMoodStamp(null);
            } else {
              var uname = userNameOf(getChat(chatId));
              /* 当天**第一次**盖这枚章 → 完整感知文案；之后（已盖过）简化，
                 不再每轮都念叨一大段，但角色仍知道你当前状态。 */
              var firstTime = !ms.announcedId || ms.announcedId !== ms.id;
              var note = firstTime
                ? '（' + uname + ' 给自己盖了一枚「' + sd.name + '」的小印章，' +
                  '似乎是有点' + sd.feel + '的情绪／感受）'
                : '（' + uname + ' 仍盖着「' + sd.name + '」）';
              var mmsg = {
                id: newId(),
                role: 'user',
                content: note + (content ? '\n' + content : ''),
                mood: sd.id,
                stampName: sd.name,
                feel: sd.feel,
                text: content,
                timestamp: Date.now()
              };
              if (quote) {
                mmsg.quote = {
                  role: quote.role, content: quote.content,
                  msgId: quote.msgId || null,
                  bubbleIndex: (quote.bubbleIndex === undefined ? null : quote.bubbleIndex)
                };
              }
              addMessage(chatId, mmsg);
              commitMemory(chatId, 'user', content || ('[我给自己盖了一枚「' + sd.name + '」印章]'));
              textarea.value = '';
              autoGrow();
              clearQuote();
              /* 保持当天章，仅把 announcedId 标记为已完整告知，后续发送简化 */
              setMoodStamp({ id: ms.id, date: todayStr(), announcedId: ms.id });
              renderMessages();
              return;
            }
          }
        }

        /* 链接识别（微博/抖音/小红书）：整条消息就是个平台链接 →
           发链接卡（仿微信分享），元数据异步补，补到之前是占位卡。
           微博分享文案（带正文的整段）也走卡 —— 正文作者建卡时就有。 */
        var link = detectLink(content);
        if (!link) {
          var sh = detectWeiboShare(content);
          if (sh) {
            if (sh.shareText) { sh.title = sh.shareText.slice(0, 80); sh.text = sh.shareText; }
            if (sh.author) sh.user = sh.author;
            link = sh;
          }
        }
        if (link) {
          var lmsg = {
            id: newId(),
            role: 'user',
            type: 'link-card',
            content: content,
            link: link,
            timestamp: Date.now()
          };
          addMessage(chatId, lmsg);
          textarea.value = '';
          autoGrow();
          clearQuote();
          renderMessages();
          resolveLink(link, function (patch) {
            var cur = getChat(chatId);
            var found = null;
            if (cur) (cur.messages || []).forEach(function (m) { if (m.id === lmsg.id) found = m; });
            if (!found) return;            /* 消息已被删 */
            var lk = {};
            Object.keys(found.link || {}).forEach(function (k) { lk[k] = found.link[k]; });
            Object.keys(patch).forEach(function (k) { lk[k] = patch[k]; });
            patchMessage(chatId, lmsg.id, { link: lk });
            /* 页面实例是复用的：这段 DOM 可能已经不在文档里（切了别的对话），
               重画前先看 isConnected，别往幽灵节点上画 */
            if (msgWrap.isConnected) renderMessages(true);
          });
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
          if (kind === 'video' && Sleepy.media) {
            /* 视频比图片大得多：设硬上限 + 软提醒，避免把 IndexedDB 撑爆。 */
            if (f.size > 100 * 1024 * 1024) {
              ctx.toast('这个视频超过 100MB，发不了', 'err');
              return;
            }
            if (f.size > 50 * 1024 * 1024) ctx.toast('视频较大，存图库会慢一点', 'warn');
            Sleepy.media.available().then(function (yes) {
              if (!yes) { send(); return; }
              Sleepy.media.put(f, { name: f.name, kind: 'video' }).then(function (id) {
                var m = send({ mediaId: id, size: f.size, mime: f.type || '' });
                /* 读懂层：抽帧送视频理解 API，回的文字写回这条消息，
                   并让角色据此回应。没配 API 时 analyzeAndInject 内部优雅跳过。 */
                if (m && Sleepy.videoUnderstand) {
                  Sleepy.videoUnderstand.analyzeAndInject(chatId, m.id, id, {
                    requestReply: requestReply,
                    patchMessage: patchMessage,
                    toast: ctx.toast
                  });
                }
              });
            }).then(null, function () {
              ctx.toast('视频没能存进图库', 'warn');
              send();
            });
            return;
          }
          send();

          function send(extra) {
            extra = extra || {};
            var m = {
              id: newId(),
              role: 'user',
              type: kind,
              name: f.name,
              size: extra.size || f.size,
              mime: extra.mime || f.type || '',
              mediaId: extra.mediaId || null,
              w: extra.w || 0,
              h: extra.h || 0,
              content: (kind === 'photo' ? '[照片] ' : (kind === 'video' ? '[视频] ' : '[文件] ')) + f.name,
              timestamp: Date.now()
            };
            addMessage(chatId, m);
            closePanel();
            renderMessages();
            ctx.toast(kind === 'photo' ? '照片发出去了' : (kind === 'video' ? '视频发出去了' : '文件发出去了'), 'ok');
            return m;
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
        /* 停止（2026-10-28 随气泡上的停止键一起挪进面板）：
           气泡上不再挂「停止」，但**等回复时得有个地方能掐断** ——
           长回复掐一半这件事用户一直在用，不能凭空消失。
           只在「正在等回复」时出现（when: 有 pending 才显示），
           不占平时面板的位。 */
        { id: 'stop', svg: PLUS_ICON.stop, name: '停止', when: function () { return !!pending; },
          run: function () { closePanel(); stopReply(); } },
        /* 重说（reroll，2026-10-28 从气泡 meta 挪进面板）：对最后一条回复重说 */
        { id: 'reroll', svg: PLUS_ICON.reroll, name: '重说', run: function () { rerollFromPanel(); } },
        { id: 'photo', svg: PLUS_ICON.photo, name: '发照片', run: function () { pickAttachment('image/*', 'photo'); } },
        { id: 'video', svg: PLUS_ICON.video, name: '发视频', run: function () { pickAttachment('video/*', 'video'); } },
        { id: 'file', svg: PLUS_ICON.file, name: '发文件', run: function () { pickAttachment('', 'file'); } },
        { id: 'transfer', svg: PLUS_ICON.transfer, name: '转账', run: openTransfer },
        { id: 'pat', svg: PLUS_ICON.pat, name: '拍一拍', run: function () { patChar(); } },
        { id: 'genimg', svg: PLUS_ICON.genimg, name: '生图', run: function () { openGenSheet(); } },
        { id: 'checkin', svg: PLUS_ICON.checkin, name: '查岗', run: function () { runCheckin(); } },
        /* 文字麻将（wm-core.js）：和当前角色开桌 1v1，牌局在对话里进行 */
        { id: 'mahjong', svg: PLUS_ICON.mahjong, name: '文字麻将', run: function () { closePanel(); openWmPanel(ctx); } },
        /* 反查手机：让 TA 偷看你的手机（同意/拒绝走 TA 的倾向档） */
        { id: 'revcheck', svg: PLUS_ICON.revcheck, name: '反查手机', run: function () { closePanel(); revManual(ctx); } },
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
        /* 人设唯一出口 compileCharacter（分层+红线并集），不再裸 content（勘察 P1） */
        var chBlock = (Sleepy.promptEngine.compileCharacter) ? Sleepy.promptEngine.compileCharacter(ch.id) : '';
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

        /* 勾了「生图想画面走副 API」→ 只轮询副 API（api.js requestForFeature）；
           没勾照旧主 API。两条路的 res 处理共用下面那一段。 */
        var featureP = api.requestForFeature('director', [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ], {});
        var p = featureP
          ? featureP.then(function (r) {
              return r.ok ? { ok: true, content: r.content }
                          : { ok: false, error: r.error };
            })
          : api.requestOnce({ source: 'main', cfg: main }, [
              { role: 'system', content: sys },
              { role: 'user', content: user }
            ], {});
        return p.then(function (res) {
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
            plan: opts.plan || null,
            /* 拍立得背面寄语（可空）：有它这张图才是可翻面的拍立得 */
            backNote: opts.backNote || ''
          };
          if (opts.replaceId) {
            base.timestamp = Date.now();
            patchMessage(chatId, opts.replaceId, base);
            return { ok: true, replaced: true };
          }
          /* 新生成的图顺手收进相册 —— 以前只写了 media（图库），相册里翻不到，
             想再找那张图只能回聊天记录里翻（用户 2026-09-23 报的）。
             重画（replaceId）不算新图，上面已经 return 掉了。
             2026-10-06 相册按账号隔离：归属显式记成这场对话的角色，
             别靠「当前活动角色」猜 —— 群岛里切过号就会归错人。 */
          if (Sleepy.photos && Sleepy.photos.add && r.mediaId) {
            try {
              Sleepy.photos.add([{
                mediaId: r.mediaId,
                caption: opts.caption || '',
                name: opts.name || opts.caption || '照片'
              }], { charId: (getChat(chatId) || {}).characterId || '' });
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
      /** 拆「描述|背面寄语」（拍立得 v1）：按**最后一个** | 切——描述本身
          可能是含 | 的 JSON（subjects 数组没有 |，但万一有也不该被当寄语）；
          寄语为空 = 普通照片不可翻面。 */
      function splitPhotoNote(desc) {
        var s = String(desc || '');
        var i = s.lastIndexOf('|');
        if (i === -1) return { desc: s, backNote: '' };
        var note = s.slice(i + 1).trim();
        var head = s.slice(0, i).trim();
        if (!note || !head) return { desc: s, backNote: '' };
        return { desc: head, backNote: note.slice(0, 60) };
      }

      function charSendPhoto(desc) {
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch || !Sleepy.imggen || !Sleepy.imggen.activeApi()) return;
        var pn = splitPhotoNote(desc);
        desc = pn.desc;
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
          backNote: pn.backNote,
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
          backNote: msg.backNote || '',
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
          /* 条件项（如「停止」）：不满足条件就整格不出现。
             跟 is-soon / is-na 不同 —— 那两个是「在但用不了」，
             这里是「这一刻根本不该有这一格」。 */
          if (it.when && !it.when()) return;
          /* 反查总开关关了：格子隐藏（整格拿掉，点不动都没必要留） */
          if (it.id === 'revcheck' && !revEnabled(getChat(chatId))) return;
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
          /* 开关状态徽章住进格子右上角（2026-10-28 面板改格子布局） */
          if (it.toggle) ic.appendChild(h('span', 'plus-state', on ? '开' : '关'));
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
          /* 每次打开都重建：条件项（停止）要按当下状态决定出不出现，
             开关项（翻译）的状态也可能是别的页面改的。 */
          buildPanel();
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
         捡手机皮肤不要 user 头像 —— 由 CSS（mode-phone）藏。
         2026-10-24：没头像不再回落「首字圆」—— 同步 v255 幽灵头像
         （同步铺幽灵图当占位，有图时 setAvatarImg 异步换掉，不闪空白）。 */
      function userAvatarEl() {
        var c = getChat(chatId);
        var u = (Sleepy.core && Sleepy.core.findUser(c && c.userId))
             || (Sleepy.core && Sleepy.core.activeUser());
        var av = h('img', 'msg-avatar');
        av.src = 'art/avatar-ghost-user.png';
        if (Sleepy.core && Sleepy.core.setAvatarImg) Sleepy.core.setAvatarImg(av, u);
        av.alt = '我';
        av.title = '点一下，给自己盖个情绪印章';
        av.style.cursor = 'pointer';
        av.addEventListener('click', function (e) {
          e.stopPropagation();     /* 别触发气泡本身的长按/点击 */
          openMoodPicker(av);
        });
        return av;
      }

      /* 角色侧头像：**跟账号同步**（用户 2026-09-22：「chat 聊天里气泡旁的
         头像也没同步」）。以前这里写死 `av.src = AVATAR`（一颗灰圆占位），
         不管角色设没设头像都一样 —— 现在本地图 avatarMedia 优先、
         其次网址头像。
         2026-10-24：两样都没有时回落**幽灵头像**（v255），不再是那颗
         棕色实心圆占位 —— 幽灵跟「无头像」的语义对齐，也和消息列表/
         桌面/通讯录等所有走了 setAvatarBg/setAvatarImg 的地方一致。
         setAvatarImg 是**异步**的（本地图要先从 IndexedDB 取 objectURL），
         所以先同步铺幽灵、拿到再换，中间不会闪空白。 */
      function charAvatarEl(c) {
        var av = h('img', 'msg-avatar');
        av.src = 'art/avatar-ghost-char.png';
        var ch = (c && c.characterId) ? findCharacter(c.characterId) : null;
        if (Sleepy.core && Sleepy.core.setAvatarImg) Sleepy.core.setAvatarImg(av, ch);
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
        syncMoodStamp();             /* 跨天自动取消：重进聊天时校验当天印章 */
        armStick();                  /* onHide 摘过，回来看的时候得重新武装 */
        if (Sleepy.charAppearance) Sleepy.charAppearance.applyTo(ctx, chatId);
      };

      /* 离开这一页时把盯消息区高度的探针摘掉：不摘的话每进一次聊天就留下
         一个 ResizeObserver 挂在这个页面的节点上（回调还捏着整页闭包）。
         回来时 ctx.reload → armStick 会重新挂上。 */
      ctx.detachStick = function () {
        if (stickRO) { try { stickRO.disconnect(); } catch (e) { /* 没有就算了 */ } stickRO = null; }
      };
    },
    onShow: function (ctx) {
      if (ctx.reload) ctx.reload();
      /* 通知中心：记下「当前正盯着的会话」，离开后它的横幅 / 弹窗才会显示 */
      Sleepy.__activeChatId = (ctx.params && ctx.params.chatId) || null;
      if (Sleepy.msgCenter) Sleepy.msgCenter.recompute();
    },
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
      /* 通知中心：清掉「当前会话」，让别的会话的横幅 / 弹窗可以露出来 */
      Sleepy.__activeChatId = null;
      if (Sleepy.msgCenter) Sleepy.msgCenter.recompute();
    }
  });

  /* ======================= 页面：收藏夹（已退役 2026-10-08） =======================
     收藏数据仍在 favorites，展示统一收进 We 收藏馆（page-collection 并馆：
     共同记录 + 聊天收藏按岛 + 票根全局，wj-data §5.1 的原设计）。
     老页面连独立入口都没有了，留着一个「能看到但没人指路」的页只会让人迷路 ——
     注册整段摘除；别处引用 toast 已改成「已收进 We 收藏馆啦」。
     冒烟反向断言：registered().favorites 必须为 undefined（scripts/smoke.js）。 */

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
    extractRecalls: extractRecalls,
    extractLampNotes: extractLampNotes,
    extractSlowmail: extractSlowmail,
    extractHtmlGames: extractHtmlGames,
    noteGameResult: noteGameResult,
    gameResultPeekMsg: gameResultPeekMsg,
    HTMLGAME_MAX: HTMLGAME_MAX,
    applyCharRecalls: applyCharRecalls,
    withPinnedFirst: withPinnedFirst
  };

  /* ======== 候选补丁 2026-10-13：人物/协议装配诊断（只读，不落盘） ========
     状态机：条件成立 → 记 key（会话|角色|故障型）；条件转假 → 删 key
     （修复配置后标志自动清除，故障复发会重新提示）。
     去重含角色维度：会话换绑角色后是新的 key，各自独立提示/清除。
     提示只在「新亮起」时由调用方 toast（本层不碰 UI）。 */
  var chatDiagFlags = {};
  var CHAT_DIAG_KINDS = ['noChar', 'personaEmpty', 'maskBroken', 'personaError',
    'protoBlank', 'bubblesOnly', 'protoMissing'];
  var CHAT_DIAG_MSG = {
    noChar: '这个对话还没有绑定角色，本轮请求不会附带人设',
    personaEmpty: function (ch) { return '「' + ((ch && ch.name) || '?') + '」还没有设定原文，TA 只能凭名字聊天'; },
    maskBroken: function (ch) { return '「' + ((ch && ch.name) || '?') + '」的本体映射失效（小号的父角色找不到），只用了这张脸自己的资料'; },
    personaError: '人设编译出错，本轮请求没有附带人设',
    protoBlank: '输出协议正文为空：分泡/心声要求未随本轮请求发出',
    bubblesOnly: '分泡要求未装配：本轮只有旧心声指令（c05 输出协议无效）。心声不受影响',
    protoMissing: '输出协议未装配：本轮请求没有分泡/心声要求'
  };
  /* 返回 true = 本次**新**亮起（调用方据此 toast 一次）；转假即清除，可复发 */
  function chatDiagApply(chatId, charId, kind, on) {
    var key = chatId + '|' + (charId || '-') + '|' + kind;
    var was = !!chatDiagFlags[key];
    if (on) chatDiagFlags[key] = true;
    else delete chatDiagFlags[key];
    return on && !was;
  }
  /* 人物装配评估（引擎开/关、普通回复/reroll 共用）。只读，不改存储。 */
  function chatDiagPersona(chat) {
    var chatId = chat ? chat.id : '';
    var cid = chat ? chat.characterId : '';
    var ch = cid ? Sleepy.core.findChar(cid) : null;
    var res = { chatId: chatId, charId: cid || null, personaText: '', flags: [] };
    if (!ch) { res.flags.push('noChar'); return res; }
    var isSub = (ch.kind || 'main') === 'sub';
    var broken = false;
    if (isSub) {
      var rt = Sleepy.core.rootOf(cid);
      broken = !rt || rt.id === ch.id;    /* rootOf 断链时返回 sub 自己（core.js:699） */
    }
    try {
      res.personaText = (Sleepy.promptEngine && Sleepy.promptEngine.compileCharacter(cid)) || '';
      if (!res.personaText) res.flags.push(broken ? 'maskBroken' : 'personaEmpty');
      else if (broken) res.flags.push('maskBroken');   /* 有资料仍准确报映射失效 */
    } catch (e) {
      res.flags.push('personaError');   /* 编译异常不误报「用户没填人设」 */
    }
    return res;
  }
  /* 协议装配评估：入参是装配方算好的 {kind}。
     kind：'c05-default' | 'c05-custom'（都健康，不告警）
         | 'heartbeat-only'（仅旧心声、缺分泡 —— 不误报缺心声）
         | 'none'（无任何协议）| 'blank'（引擎路 c05 正文为空）。
     收口注记：customMixed 已撤 —— 心声随回复带回、parseReply 拆分，
     自定义 c05 原样注入即可，没有「与心声开关冲突」这回事
     （heartbeatAuto 是遗留字段，不升格为协议规则）。 */
  function chatDiagProtocol(chat, info) {
    var kinds = [];
    if (!info) return kinds;
    if (info.kind === 'heartbeat-only') kinds.push('bubblesOnly');
    else if (info.kind === 'none') kinds.push('protoMissing');
    else if (info.kind === 'blank') kinds.push('protoBlank');
    return kinds;
  }
  /* 统一落状态（两个引擎分支与 reroll 都调它）。
     本层不碰 UI：返回本次**新亮起**的 [{kind, msg}]，由调用方（页面闭包里有
     ctx.toast）负责弹提示。 */
  function chatDiagCommit(chat, activeKinds) {
    var chatId = chat ? chat.id : '';
    var cid = chat ? chat.characterId : '';
    var fresh = [];
    CHAT_DIAG_KINDS.forEach(function (k) {
      if (chatDiagApply(chatId, cid, k, activeKinds.indexOf(k) >= 0)) {
        var m = CHAT_DIAG_MSG[k];
        if (m) fresh.push({ kind: k, msg: typeof m === 'function' ? m(Sleepy.core.findChar(cid)) : m });
      }
    });
    return fresh;
  }

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

  /* 候选补丁：零网络测试观察口（只读；不改任何存储对象） */
  Sleepy.chatDiag = {
    flags: chatDiagFlags,
    personaOf: chatDiagPersona,
    protocolKindsOf: chatDiagProtocol,
    apply: chatDiagApply,
    KINDS: CHAT_DIAG_KINDS,
    MSG: CHAT_DIAG_MSG
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
