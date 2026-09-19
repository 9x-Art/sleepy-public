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
   1) 附件只存元数据（文件名 / 大小 / 类型），不存 base64。
      localStorage 只有 5MB 左右，塞两张原图就把配额撑爆，store 会直接
      写失败（QuotaExceededError）。真要存图，等接 IndexedDB 再说。
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

  /* 空输入点发送时，替用户说的一句话。F 模块上线后由 F 接管 */
  var PROACTIVE_HINT = '（我这边安静着，没打字，你主动开口说一句吧。）';

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
    var u = core && core.activeUser && core.activeUser();
    if (!u) return list;
    return list.filter(function (c) { return !c.userId || c.userId === u.id; });
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
      if (u) return u.name;
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
    var activeUser = core ? core.activeUser() : null;

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
    mutate(chatId, function (c) {
      c.messages = c.messages.filter(function (m) { return ids.indexOf(m.id) < 0; });
    });
  }

  function patchMessage(chatId, id, patch) {
    mutate(chatId, function (c) {
      for (var i = 0; i < c.messages.length; i++) {
        if (c.messages[i].id !== id) continue;
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) c.messages[i][k] = patch[k];
        }
        return;
      }
    });
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
    return m.content || '';
  }

  /* 日记事件：user 写了新日记 → 下一轮 TA 会知道「写了」，但看不看是 TA 的事
     （偷看 / 尊重隐私 / 直接问，模型按人设自己选）。一次性：注入后摘旗。
     日记带配图（生图插画 / 相册贴图）时把真图一起带上 —— 偷看才看得到内容，
     尊重隐私的话模型自己会无视它。图没备进缓存就先文字占位 + 预载（下轮生效）。 */
  function diaryPeekMsg(charId) {
    if (!charId) return null;
    var flag = store.get('diaryPeek:' + charId);
    if (!flag || !flag.entryId) return null;
    store.set('diaryPeek:' + charId, null);
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

  function previewOf(msg) {
    if (!msg) return '空对话';
    if (msg.type === 'photo') return '你发了张照片';
    if (msg.type === 'file') return '你发了个文件';
    if (msg.type === 'transfer') return '你转了 ¥' + (Number(msg.amount) || 0).toFixed(2);
    if (msg.type === 'sticker') return '你发了个表情' + (msg.name ? '「' + msg.name + '」' : '');
    if (msg.type === 'pat') return (msg.content || '拍一拍');
    var t = String(msg.content || '').replace(/\s+/g, ' ').slice(0, 20);
    return (msg.role === 'user' ? '你说：' : '对方回：') + t;
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
    if (!core) return;
    var c = getChat(cId);
    if (!c || !c.characterId || !text) return;
    var rootId = core.rootIdOf(c.characterId);
    if (!rootId) return;
    core.addMemory({
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
      var chats = viewChats();
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
          main.appendChild(h('span', 'chat-item-name', g.name));
          var meta = h('div', 'chat-item-meta');
          meta.appendChild(h('span', 'chat-item-time', relativeTime(g.updatedAt)));
          var last = Sleepy.groupStore.lastMessage(g.id);
          var preview = '';
          if (last) {
            if (last.type === 'system') preview = last.content;
            else if (last.recalledAt) preview = '撤回了一条消息';
            else {
              var lm = Sleepy.groupStore.findMember(g.id, last.senderAccountId);
              preview = (lm ? Sleepy.groupStore.accountMeta(lm).name : '?') +
                '：' + String(last.content || '').slice(0, 24);
            }
          }
          meta.appendChild(h('span', 'chat-item-preview', preview));
          main.appendChild(meta);
          item.appendChild(main);

          var del = h('button', 'chat-item-del', '删');
          del.type = 'button';
          del.title = '解散并删除这个群';
          del.addEventListener('click', async function (e) {
            e.stopPropagation();
            var yes = await ui.confirm({
              title: '解散「' + g.name + '」？',
              note: '群的聊天记录和成员记录会一起没掉，角色那边不会收到任何通知。',
              ok: '解散',
              danger: true
            });
            if (!yes) return;
            Sleepy.groupStore.removeGroup(g.id);
            rebuild();
            ctx.toast('已解散', 'ok');
          });
          item.appendChild(del);

          item.addEventListener('click', function () {
            ctx.open('group-chat', { groupId: g.id });
          });
          listWrap.appendChild(item);
        });

        listWrap.appendChild(h('p', 'chat-list-sect', '私聊'));
      }

      chats.forEach(function (chat) {
        var item = h('div', 'chat-item');

        var main = h('div', 'chat-item-main');
        main.appendChild(h('span', 'chat-item-name', chat.name));

        var meta = h('div', 'chat-item-meta');
        meta.appendChild(h('span', 'chat-item-time', relativeTime(chat.updatedAt)));
        var msgs = Array.isArray(chat.messages) ? chat.messages : [];
        meta.appendChild(h('span', 'chat-item-preview', previewOf(msgs[msgs.length - 1])));
        main.appendChild(meta);
        item.appendChild(main);

        var del = h('button', 'chat-item-del', '删');
        del.type = 'button';
        del.title = '删除这个对话';
        del.addEventListener('click', async function (e) {
          e.stopPropagation();
          var yes = await ui.confirm({
            title: '删除「' + chat.name + '」？',
            note: '里面的聊天记录会一起没掉。',
            ok: '删除',
            danger: true
          });
          if (!yes) return;
          saveChats(allChats().filter(function (c) { return c.id !== chat.id; }));
          rebuild();
          ctx.toast('已删除', 'ok');
        });
        item.appendChild(del);

        item.addEventListener('click', function () {
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
        if (!headEl || headEl.querySelector('.avatar-slot')) return;
        headEl.classList.add('head-ava-mode');
        var c = getChat(chatId) || {};
        var ch = findCharacter(c.characterId);
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

      var plusBtn = h('button', 'plus-btn', '+');
      plusBtn.type = 'button';
      plusBtn.title = '更多';

      /* ---- 输入框左下角：表情笑脸（用户定的）----
         表情包入口从加号面板挪到这里；切换账号不在聊天页做了，
         去「我」那一页。 */
      var emoBtn = h('button', 'plus-btn emo-btn');
      emoBtn.type = 'button';
      emoBtn.title = '表情包';
      emoBtn.innerHTML = PLUS_ICON.sticker;
      emoBtn.addEventListener('click', openStickerPanel);
      /* 笑脸在左下角、加号次之、输入框居中、爪印在右。 */
      inputArea.appendChild(emoBtn);
      inputArea.appendChild(plusBtn);
      inputArea.appendChild(textarea);
      inputArea.appendChild(sendBtn);
      foot.appendChild(inputArea);
      body.appendChild(foot);

      /* 长按菜单：底部弹出的动作表 */
      var menuMask = h('div', 'msg-menu-mask');
      var menu = h('div', 'msg-menu');
      var menuList = h('div', 'msg-menu-list');
      var menuCancel = h('button', 'msg-menu-cancel', '取消');
      menuCancel.type = 'button';
      menu.appendChild(menuList);
      menu.appendChild(menuCancel);
      body.appendChild(menuMask);
      body.appendChild(menu);

      /* ======================== 渲染 ======================== */

      function autoGrow() {
        textarea.style.height = 'auto';
        /* 注意：render 阶段元素还没挂进文档，scrollHeight 是 0，
           所以下限必须给足，并且进入页面时要再算一次（见 ctx.reload）。 */
        textarea.style.height = Math.max(42, Math.min(textarea.scrollHeight, 120)) + 'px';
      }

      function renderMessages(keepScroll) {
        var prev = msgWrap.scrollTop;
        msgWrap.innerHTML = '';

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
        if (pending && !pending.targetId) msgWrap.appendChild(pendingBubble());

        syncBubbleDots();
        if (keepScroll) msgWrap.scrollTop = prev;
        else msgWrap.scrollTop = msgWrap.scrollHeight;
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

      function bubbleFor(msg, c, seg) {
        seg = seg || null;
        var role = msg.role === 'user' ? 'user'
                 : (msg.role === 'system' ? 'system' : 'assistant');
        /* 拍一拍：微信那种居中灰字，不是气泡。
           没有头像、没有长按菜单、没有重答 —— 它是个动作记录，不是话。 */
        if (msg.type === 'pat') {
          return h('div', 'msg-pat', msg.content || '拍了拍');
        }
        var bubble = h('div', 'msg-bubble msg-' + role);
        bubble.setAttribute('data-id', msg.id);

        var herePending = !!(pending && pending.targetId === msg.id);
        if (herePending) bubble.classList.add('is-pending');
        if (selecting && selected[msg.id]) bubble.classList.add('is-selected');

        if (role === 'assistant') {
          /* 头像包一层：未读心声光点挂这里（用户定的位置 —— 不在顶栏），
             点头像还是看没说出口的话 */
          var avWrap = h('span', 'msg-ava-wrap');
          var av = h('img', 'msg-avatar');
          av.src = AVATAR;
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
        } else if (msg.type === 'checkin') {
          content.appendChild(checkinCard(msg));
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
          bindLongPress(bubble, function () { openMenu(msg); });
          bubble.addEventListener('click', function () {
            if (wasLongPressed(bubble)) return;
            if (selecting) toggleSelect(msg.id);
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
        box.appendChild(h('div', 'msg-checkin-cap', '你悄悄看了一眼：' + (msg.caption || '…')));
        if (msg.noticed) box.appendChild(h('span', 'msg-checkin-tag', 'TA 发现了'));
        return box;
      }

      function attachCard(msg) {
        /* 照片：本体在 IndexedDB 里，现取一个 objectURL 贴上。
           取不到（老消息只存了文件名、或者图库被清过）就退回文件名卡片 ——
           宁可显示「这张图找不到了」，也别留一个破图。 */
        if (msg.type === 'photo' && msg.mediaId && Sleepy.media) {
          var box = h('div', 'msg-photo');
          var img = h('img', 'msg-photo-img');
          img.alt = msg.caption || msg.name || '照片';
          box.appendChild(img);
          Sleepy.media.url(msg.mediaId).then(function (src) {
            if (src) { img.src = src; return; }
            box.classList.add('is-missing');
            box.appendChild(h('span', 'msg-photo-miss', '这张图找不到了'));
          }, function () {
            box.classList.add('is-missing');
            box.appendChild(h('span', 'msg-photo-miss', '图库打不开'));
          });
          /* TA 发的图带图注（[生图:描述] / 让 TA 发的那张） */
          if (msg.caption && msg.role === 'assistant') {
            box.appendChild(h('div', 'msg-photo-cap', msg.caption));
          }
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

      function pendingBubble() {
        var bubble = h('div', 'msg-bubble msg-assistant is-pending');

        var av = h('img', 'msg-avatar');
        av.src = AVATAR;
        av.alt = '角色';
        bubble.appendChild(av);

        var content = h('div', 'msg-body');
        var textEl = h('div', 'msg-text');
        var shown = pendingVisible();
        if (shown) textEl.textContent = shown;
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
        sendBtn.title = busy ? '还在等回复' : '发送（输入框留空，就是让角色主动开口）';
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

      /* ======================== 多选 ======================== */

      function selectedIds() { return Object.keys(selected); }

      function enterSelect(id) {
        selecting = true;
        selected = {};
        if (id) selected[id] = true;
        renderSelection();
        renderMessages(true);
      }

      function exitSelect() {
        selecting = false;
        selected = {};
        renderSelection();
        renderMessages(true);
      }

      function toggleSelect(id) {
        if (selected[id]) delete selected[id];
        else selected[id] = true;
        if (!selectedIds().length) { exitSelect(); return; }
        renderSelection();
        renderMessages(true);
      }

      function renderSelection() {
        selBar.innerHTML = '';
        if (!selecting) {
          selBar.style.display = 'none';
          return;
        }
        selBar.style.display = 'flex';
        selBar.appendChild(h('span', 'msg-select-info', '已选 ' + selectedIds().length + ' 条'));

        var del = h('button', 'msg-select-act is-danger', '删除');
        del.type = 'button';
        del.addEventListener('click', async function () {
          var ids = selectedIds();
          if (!ids.length) return;
          var yes = await ui.confirm({
            title: '删除选中的 ' + ids.length + ' 条？',
            ok: '删除',
            danger: true
          });
          if (!yes) return;
          dropMessages(chatId, ids);
          exitSelect();
          ctx.toast('已删除 ' + ids.length + ' 条', 'ok');
        });

        var cancel = h('button', 'msg-select-act', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', exitSelect);

        selBar.appendChild(del);
        selBar.appendChild(cancel);
      }

      /* ======================== 长按菜单 ======================== */

      function openMenu(msg) {
        menuList.innerHTML = '';

        var items = [
          { label: '引用回复', run: function () { startQuote(msg); } },
          { label: '多选', run: function () { enterSelect(msg.id); } },
          { label: '收藏', run: function () { favorite(msg); } },
          { label: '编辑', run: function () { editMsg(msg); } },
          { label: '复制', run: function () { copyMsg(msg); } },
          { label: '删除', kind: 'danger', run: function () { removeMsg(msg); } }
        ];

        items.forEach(function (it) {
          var b = h('button', 'msg-menu-item' + (it.kind ? ' is-' + it.kind : ''), it.label);
          b.type = 'button';
          b.addEventListener('click', function () {
            closeMenu();
            it.run();
          });
          menuList.appendChild(b);
        });

        menu.classList.add('is-open');
        menuMask.classList.add('is-open');
      }

      function closeMenu() {
        menu.classList.remove('is-open');
        menuMask.classList.remove('is-open');
      }

      menuMask.addEventListener('click', closeMenu);
      menuCancel.addEventListener('click', closeMenu);

      function startQuote(msg) {
        quote = {
          role: msg.role,
          content: (msg.type ? attachText(msg) : (msg.content || '')).slice(0, 140)
        };
        renderQuote();
        textarea.focus();
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

      function favorite(msg) {
        /* 写入方：拿全量 → 改 → 整表落盘（不能拿过滤过的列表） */
        var list = store.get('favorites');
        if (!Array.isArray(list)) list = [];
        var c = getChat(chatId);
        var fav = {
          id: newId(),
          chatId: chatId,
          chatName: c ? c.name : '',
          role: msg.role,
          content: (msg.type ? attachText(msg) : (msg.content || '')),
          savedAt: Date.now()
        };
        if (Sleepy.core && Sleepy.core.tagScope) Sleepy.core.tagScope(fav);
        list.unshift(fav);
        store.set('favorites', list);
        ctx.toast('已收藏，右上角 ★ 里能查到', 'ok');
      }

      async function editMsg(msg) {
        if (msg.type) {
          ctx.toast('附件气泡先不支持编辑', 'warn');
          return;
        }
        var next = await ui.prompt({
          title: '编辑这条消息',
          value: msg.content || '',
          ok: '保存'
        });
        if (next === null) return;
        next = String(next).trim();
        if (!next) {
          ctx.toast('内容不能为空', 'err');
          return;
        }
        patchMessage(chatId, msg.id, { content: next });
        renderMessages();
        ctx.toast('已更新', 'ok');
      }

      function copyMsg(msg) {
        var text = msg.type ? attachText(msg) : (msg.content || '');
        if (!text) return;
        copyText(text).then(
          function () { ctx.toast('已复制', 'ok'); },
          function () { ctx.toast('复制失败，浏览器没给权限', 'err'); }
        );
      }

      async function removeMsg(msg) {
        var yes = await ui.confirm({
          title: '删掉这条消息？',
          ok: '删除',
          danger: true
        });
        if (!yes) return;
        dropMessages(chatId, [msg.id]);
        renderMessages();
        ctx.toast('已删除', 'ok');
      }

      /* ==================== 发送 / 接收 / reroll ==================== */

      function buildMessages(opts) {
        opts = opts || {};
        var c = getChat(chatId);
        if (!c) return [];

        /* 上下文条数：这个对话自己设了就用它的，否则跟随全局 */
        var ov = overridesOf(c);
        var limit = (ov.contextMessages != null) ? ov.contextMessages
                  : (store.get('chatDefaults.contextMessages') || 20);
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
          if (opts.proactive) built.messages.push({ role: 'user', content: PROACTIVE_HINT });
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
          var spec = Sleepy.stickers.replySpec();
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
        if (opts.proactive) out.push({ role: 'user', content: PROACTIVE_HINT });
        return out;
      }

      function requestReply(opts) {
        opts = opts || {};
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }

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
            renderMessages();
          },
          onDone: function (cand, text) {
            if (mySeq !== reqSeq) return;

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

            /* 手机痕迹（查手机第 2 批）：[手机] 行抽出、校验、落库 ——
               搭载在本次回复上，0 新增调用（架构 v1 §5.1）。
               手机壳不存在就顺手建（幂等、0 API）。失败不拦聊天。 */
            var pdApplied = 0;
            if (Sleepy.phone && Sleepy.core) {
              try {
                var SC = Sleepy.core;
                var phScope = SC.scopeId();
                if (phScope) {
                  var phOwner = SC.rootIdOf(chat.characterId) || chat.characterId;
                  var phRec = Sleepy.phone.ensurePhone(phScope, phOwner);
                  var pd = Sleepy.phone.extractPhoneDeltas(finalText);
                  finalText = pd.text;
                  var granted = null;
                  pd.list.slice(0, 3).forEach(function (d) {
                    var v = Sleepy.phone.validateDelta(d);
                    if (!v) return;
                    var res = Sleepy.phone.applyDelta(phRec, v, 'delta_' + Date.now().toString(36));
                    if (res) {
                      pdApplied++;
                      /* 授权类 delta：他主动递手机 —— 正文提交后再落邀请卡 */
                      if (v.app === 'permission') granted = v.data;
                    }
                  });
                }
              } catch (e) { /* 手机痕迹失败不影响这条回复 */ }
            }

            if (!finalText && !st.names.length && !pt.patted && !gi.descs.length && !pdApplied) {
              ctx.toast('这次没出声，要不再试一次？', 'warn');
              renderMessages();
              updateSendUI();
              return;
            }

            if (finalText) {
              if (target) patchMessage(chatId, target, { content: finalText, trans: transArr, timestamp: Date.now() });
              else addMessage(chatId, {
                id: newId(),
                role: 'assistant',
                content: finalText,
                trans: transArr,
                timestamp: Date.now()
              });
              commitMemory(chatId, 'assistant', finalText);
              /* 总结引擎（v5 10.1）：回复落地后检查累计阈值，
                 够了就后台整理，不阻塞聊天（失败静默，游标不动下轮再试） */
              if (Sleepy.summaryEngine) Sleepy.summaryEngine.onChatTurn(chatId);
              /* 离屏生活结算（查手机第 2 批）：闸门（自主生活档位 + 最短间隔）
                 通过才后台跑，失败静默 —— 同总结引擎的规矩 */
              if (Sleepy.phoneAI) Sleepy.phoneAI.onChatTurn(chatId);
              /* 主动消息引擎：回复落地后扫一遍当前岛的其他角色
                 （引擎自带节流和资格闸门，这里只管喊一声） */
              if (Sleepy.proactiveEngine) Sleepy.proactiveEngine.sweep();
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
               模型没写标签就什么都不发生，属于正常情况。 */
            if (split.whisper && split.whisper.trim()) {
              Sleepy.heartbeat.commit(chatId, split.whisper);
            }
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

        reqSeq++;                       /* 让在途回调统统失效 */
        if (handle) { try { handle.abort(); } catch (e) { /* 忽略 */ } }
        handle = null;
        pending = null;

        if (partial) {
          /* 半截回复里可能已经带着 [表情:…] 标签了 —— 去掉，但**不补发**
             （用户是主动停的，别再给他弹东西出来）。 */
          var pSt = extractStickers(partial);
          var pText = pSt.text;
          if (target) patchMessage(chatId, target, { content: pText, timestamp: Date.now() });
          else addMessage(chatId, {
            id: newId(),
            role: 'assistant',
            content: pText,
            timestamp: Date.now()
          });
          commitMemory(chatId, 'assistant', pText);
        } else if (target) {
          patchMessage(chatId, target, { content: '（这条被停掉了）' });
        }

        if (beat.trim()) Sleepy.heartbeat.commit(chatId, beat);

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

        patchMessage(chatId, msg.id, { content: '' });
        requestReply({ excludeId: msg.id, targetId: msg.id, note: note });
      }

      function doSend() {
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }

        var content = textarea.value.trim();

        /* D1：输入框空着点发送 = 让角色主动开口说话，而不是发一个空气泡 */
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
        if (quote) msg.quote = { role: quote.role, content: quote.content };

        addMessage(chatId, msg);
        commitMemory(chatId, 'user', content);
        textarea.value = '';
        autoGrow();
        clearQuote();
        renderMessages();
        requestReply({});
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

          return Sleepy.imggen.generate({
            subject: d.subject,
            faceText: Sleepy.imggen.faceTextFor(ch, 'scene'),
            gender: ch
          }).then(function (r) {
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
              subject: d.subject,
              caption: d.caption,
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
            '【输出】只返回一个 JSON：{"subject":"画面内容，英文 Danbooru 风格 tag，包含 1girl/1boy 或角色特征、服装、动作、场景、时间氛围","caption":"一句不超过 20 字的中文，说明你看到了什么"}',
            '只输出 JSON 本体，不要解释。'
          ].filter(Boolean).join('\n\n');
          user = ctxLine;
        } else if (kind === 'charPhoto') {
          sys = [
            '你现在是「' + ch.name + '」本人，准备给对方发一张照片。',
            chBlock,
            '【任务】对方想让你发一张照片' + (intent ? '，意图：' + intent : '，没说具体想看什么——发一张你自己此刻愿意分享的') +
              '。结合你的人设、此刻状态和近期聊天，决定拍什么（自拍/眼前的景物/在忙的东西都可以）。',
            '【你也可以拒绝】按人设，如果你不爱自拍、正在忙、或不愿意发，可以拒绝——refuse 填你拒绝的原话（口语，符合人设），subject 和 caption 留空字符串。',
            '【输出】只返回一个 JSON：{"subject":"画面内容，英文 Danbooru 风格 tag（1girl/1boy + 服装 + 动作 + 场景；自拍要带 selfie）","caption":"发图时配的一句话，口语","refuse":""}',
            '只输出 JSON 本体，不要解释。'
          ].filter(Boolean).join('\n\n');
          user = ctxLine;
        } else {
          sys = [
            '你是画面导演：把 user 的一句中文画面意图，转成一张图的英文 Danbooru 风格 tag 描述。',
            '保留原意的主体、动作、场景、氛围；补齐画面需要的要素（视角/光线/构图）。',
            '【输出】只返回一个 JSON：{"subject":"英文 tag","caption":"一句不超过 15 字的中文图注"}',
            '只输出 JSON 本体，不要解释。'
          ].join('\n');
          user = '[画面意图] ' + (intent || '');
        }

        return api.requestOnce({ source: 'main', cfg: main }, [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ], {}).then(function (res) {
          if (!res.ok) return { ok: false, error: res.message || '想画面的时候出错了' };
          var out = { ok: true, subject: '', caption: '', refuse: '' };
          try {
            var t = String(res.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
            var i = t.indexOf('{'), j = t.lastIndexOf('}');
            if (i >= 0 && j > i) {
              var obj = JSON.parse(t.slice(i, j + 1));
              out.subject = String((obj && obj.subject) || '').trim().slice(0, 400);
              out.caption = String((obj && obj.caption) || '').trim().slice(0, 40);
              out.refuse = String((obj && obj.refuse) || '').trim().slice(0, 120);
            }
          } catch (e) { /* 解析不动走兜底 */ }
          if (!out.subject && !out.refuse) {
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

      /* 生成 + 落消息（生图弹层 / TA 主动发图 / 重画 共用）。
         opts: { subject, shot, caption, as: 'user'|'assistant', replaceId?, name?, preset? }
         preset = 已生成好的一张 {mediaId, blob, url}（弹层「发送」用，不再花一次生成费） */
      function genAndDeliver(ch, opts) {
        var genP = opts.preset
          ? Promise.resolve({ ok: true, mediaId: opts.preset.mediaId, blob: opts.preset.blob, url: opts.preset.url })
          : Sleepy.imggen.generate({
              subject: opts.subject,
              faceText: opts.as === 'assistant'
                ? Sleepy.imggen.faceTextFor(ch, opts.shot) : '',
              gender: opts.as === 'assistant' ? ch : null
            });
        return genP.then(function (r) {
          if (!r.ok) return r;
          cachePhotoData(r.mediaId, r.blob);
          var base = {
            mediaId: r.mediaId || '',
            url: r.url || '',
            subject: opts.subject,
            shot: opts.shot || ''
          };
          if (opts.replaceId) {
            base.timestamp = Date.now();
            patchMessage(chatId, opts.replaceId, base);
            return { ok: true, replaced: true };
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

      /* TA 主动发图（回复里的 [生图:描述] 到这里落地） */
      function charSendPhoto(desc) {
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch || !Sleepy.imggen || !Sleepy.imggen.activeApi()) return;
        var shot = /selfie|自拍/i.test(desc) ? 'selfie' : '';
        genAndDeliver(ch, {
          subject: desc,
          shot: shot,
          caption: desc.slice(0, 30),
          as: 'assistant'
        }).then(function (r) {
          if (!r.ok) ctx.toast((r.error && r.error.message) || 'TA 想发图但没发出来', 'warn');
        });
      }

      /* 重画：同 subject 重新生成，原地替换（caption 不变） */
      function redrawPhoto(msg) {
        if (pending) { ctx.toast('还在等回复', 'warn'); return; }
        var c = getChat(chatId);
        var ch = c && c.characterId ? findCharacter(c.characterId) : null;
        if (!ch || !Sleepy.imggen || !Sleepy.imggen.activeApi()) return;
        ctx.toast('重画中…', 'ok');
        genAndDeliver(ch, {
          subject: msg.subject,
          shot: msg.shot || '',
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
            var shot = /selfie/i.test(d.subject) ? 'selfie' : '';
            return Sleepy.imggen.generate({
              subject: d.subject,
              faceText: mode === 'char' ? Sleepy.imggen.faceTextFor(ch, shot) : '',
              gender: mode === 'char' ? ch : null
            }).then(function (r) {
              busy = false;
              bGen.disabled = false;
              if (!r.ok) {
                status.textContent = r.error.message || '生图失败了';
                return;
              }
              cur = {
                subject: d.subject, caption: d.caption,
                blob: r.blob, mediaId: r.mediaId, url: r.url || ''
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
            shot: /selfie/i.test(keep.subject) ? 'selfie' : '',
            caption: keep.caption,
            name: keep.caption,
            as: mode === 'char' ? 'assistant' : 'user',
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

      function stickerPool() {
        return (Sleepy.stickers && Sleepy.stickers.visible) ? Sleepy.stickers.visible() : [];
      }

      /* user 侧头像：和输入区那个「我」同一套取图逻辑。
         捡手机皮肤不要 user 头像 —— 由 CSS（mode-phone）藏。 */
      function userAvatarEl() {
        var c = getChat(chatId);
        var u = (Sleepy.core && Sleepy.core.findUser(c && c.userId))
             || (Sleepy.core && Sleepy.core.activeUser());
        var av;
        if (u && u.avatar) {
          av = h('img', 'msg-avatar');
          av.src = u.avatar;
        } else {
          av = h('span', 'msg-avatar msg-avatar-initial');
          var n = String((u && u.name) || '我').trim();
          av.textContent = n ? n.charAt(0).toUpperCase() : '我';
        }
        av.alt = '我';
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
        var hit = null;
        pool.forEach(function (s) {
          if (hit) return;
          if (String(s.name || '').trim().toLowerCase() === q) hit = s;
        });
        if (!hit) {
          pool.forEach(function (s) {
            if (hit) return;
            var n = String(s.name || '').trim().toLowerCase();
            if (n && (n.indexOf(q) >= 0 || q.indexOf(n) >= 0)) hit = s;
          });
        }
        if (!hit) return null;      /* 名字对不上就当它没发，不猜 */

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
        var hits = Sleepy.stickers.match(q, 14);
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
        if (Sleepy.charAppearance) Sleepy.charAppearance.applyTo(ctx, chatId);
      };

      /* 换面具之后要重画：左侧头像、气泡里的「我」、以及上下文里的身份。
         面具轮盘在 page-switch.js 里，它换完会回调这里。 */
      Sleepy.chatDetailRefresh = function () {
        if (ctx.reload) ctx.reload();
      };
    },
    onShow: function (ctx) { if (ctx.reload) ctx.reload(); },
    onHide: function (ctx) {
      /* 离开页面时把菜单和心声浮层收掉，免得回来还开着 */
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
      emptyWrap.appendChild(h('p', 'empty-hint', '长按一条消息，选「收藏」'));
      body.appendChild(emptyWrap);
      body.appendChild(listWrap);

      function rebuild() {
        /* 读取方：只列当前房里的收藏 */
        var list = Sleepy.core.scoped(store.get('favorites'));
        if (!Array.isArray(list)) list = [];
        listWrap.innerHTML = '';
        emptyWrap.style.display = list.length ? 'none' : 'flex';

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
    extractPats: extractPats
  };

  Sleepy.chatStore = {
    getChats: getChats,
    viewChats: viewChats,
    saveChats: saveChats,
    getChat: getChat,
    createChat: createChat,
    mutate: mutate,
    addMessage: addMessage,
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
    TRANSFER_MAX: TRANSFER_MAX
  };

})(window);
