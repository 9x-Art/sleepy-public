/* ============================================================
   page-switch.js — 系统级切号 + 面具轮盘 + 记忆认知层
   依赖：store.js、core.js、ui.js、app.js

   三块东西，都跟《终极架构总纲》第 3 节「核心交互链路」对得上：

   ---- 一、系统级切号（时空切换器）----
   总纲原文：「不限定为特定图标，而是系统级的一个『切换菜单/入口』。
   效果：选定角色后，整个 OS 的视觉氛围、组件数据瞬间无缝切换。」
   所以它不是一个 App，是一个能从任何地方呼起的浮层。
   入口有三条：桌面角色卡、长按桌面空白、我→切号。

   ---- 二、宇宙内切皮套（面具交互）----
   总纲原文：「在聊天界面的输入框左侧，长按当前的 User 头像，
   呼出【面具轮盘】，滑动秒切马甲，实现同一对话内的双重身份横跳。」
   所以它挂在**输入框左侧**，不是顶栏。两处都实现了，但左侧那个
   是总纲指定的位置，也是主入口。

   ---- 三、记忆认知层 ----
   把 core.memoryViewFor 的结果编译成给模型看的系统提示词。
   这一层是「防粉红大象」的落点：不知情时不是把记忆删掉，
   而是明确告诉模型那些记忆属于另一个人。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;

  var h = ui.h;
  var button = ui.button;
  /* 下面两个是「我」那一屏要用的。
     **原来缺了这两个 import** —— 老版的 me 页第一句就是 group('当前身份')，
     于是一点进去就抛 ReferenceError，整页空白（只留个 toast）。
     也就是说桌面上的「我的」图标一直是坏的，直到这次做 4 Tab 才发现。 */
  var group = ui.group;
  var row = ui.row;

  /* ================= 一、系统级切号 ================= */

  /* 全局单例：桌面、聊天页、浮岛都能呼起同一个浮层。
     每个页面各建一份会堆出好几个遮罩（ui.js 里踩过这个坑）。 */
  var switchEls = null;
  var switchCtx = null;

  function ensureSwitcher(ctx) {
    if (switchEls) return switchEls;

    var host = document.getElementById('phone') || document.body;

    var mask = h('div', 'sw-mask');
    var panel = h('div', 'sw-panel');

    var head = h('div', 'sw-head');
    head.appendChild(h('p', 'sw-title', '切换角色'));
    var close = h('button', 'sw-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(close);

    var sub = h('p', 'sw-sub', '选定之后，整个 OS 的视觉和数据跟着换');
    var body = h('div', 'sw-body');

    panel.appendChild(head);
    panel.appendChild(sub);
    panel.appendChild(body);
    host.appendChild(mask);
    host.appendChild(panel);

    mask.addEventListener('click', function () { closeSwitcher(); });
    close.addEventListener('click', function () { closeSwitcher(); });

    switchEls = { mask: mask, panel: panel, body: body, sub: sub };
    return switchEls;
  }

  /* 岛名兜底：roomTitle 在 page-island.js 里（加载顺序在本文件之后），
     运行时才取所以拿得到，但多一层 try/catch 防手滑。 */
  function roomTitleOf(sb) {
    try { if (Sleepy.island) return Sleepy.island.roomTitle(sb); } catch (e) { /* 忽略 */ }
    return sb.name || '未命名';
  }

  /* 画一屏：两层切换，语义严格分开（用户 09-19 定稿的核心）：
     ① 切换岛屿 —— 换 sandboxes 存档，**数据和视觉整体换**
        （桌面氛围、聊天、朋友圈全都换成那座岛的）；
     ② 这座岛里的身份 —— 只换 activeCharId / activeUserId，
        即聊天里「对面是谁、我是谁」，不动岛、不动桌面。 */
  function renderSwitcher() {
    if (!switchEls) return;
    var body = switchEls.body;
    body.innerHTML = '';

    var activeSbId = store.get('activeSandboxId');
    var rooms = core.listSandboxes();
    var activeChar = store.get('activeCharId');
    var activeUser = core.activeUser();
    var sb = core.activeSandbox();

    /* ---- ① 切换岛屿 ---- */
    var iRow = h('div', 'sw-section');
    iRow.appendChild(h('p', 'sw-section-title', '切换岛屿'));
    iRow.appendChild(h('p', 'sw-section-sub',
      '换岛 = 数据和视觉整体换，桌面、聊天、朋友圈都跟着换'));
    if (!rooms.length) {
      iRow.appendChild(h('p', 'sw-empty-text', '还没有岛 · 去浮岛捏一座'));
    }
    rooms.forEach(function (r) {
      var isCur = r.id === activeSbId;
      var item = h('button', 'sw-main' + (isCur ? ' is-on' : ''));
      item.type = 'button';
      item.appendChild(h('span', 'sw-av', '岛'));
      var tb = h('span', 'sw-main-body');
      tb.appendChild(h('span', 'sw-main-name', roomTitleOf(r)));
      tb.appendChild(h('span', 'sw-main-sub',
        (r.kind === core.KIND_ARCHI ? '群岛' : '孤岛') + ' · ' +
        core.charsOfSandbox(r).length + ' 位角色'));
      item.appendChild(tb);
      if (isCur) item.appendChild(h('span', 'sw-cur', '当前'));
      item.addEventListener('click', function () { pickIsland(r); });
      iRow.appendChild(item);
    });
    body.appendChild(iRow);

    /* ---- ② 这座岛里的身份 ----
       范围 = 当前岛的 masksOfSandbox / charsOfSandbox（决策 8：按房分组）。
       换身份只动 activeCharId / activeUserId —— 聊天列表、对话、朋友圈
       的视角跟着换，但岛没换，桌面差异那些都不动。 */
    var cRow = h('div', 'sw-section');
    cRow.appendChild(h('p', 'sw-section-title', '这座岛里的身份'));
    cRow.appendChild(h('p', 'sw-section-sub',
      '只换聊天里的「对面」和「我」这张脸 —— 不换岛，桌面不动'));
    if (!sb) {
      cRow.appendChild(h('p', 'sw-empty-text', '还没降落在任何一座岛上'));
    } else {
      /* 我这张脸（本房马甲） */
      var uList = h('div', 'sw-chips');
      var masks = core.masksOfSandbox(sb);
      if (!masks.length) {
        cRow.appendChild(h('p', 'sw-empty-text', '这间房里「我」还没声明马甲'));
      }
      masks.forEach(function (u) {
        var chip = h('button', 'sw-chip' + (u.id === activeUser.id ? ' is-on' : ''));
        chip.type = 'button';
        chip.appendChild(h('span', 'sw-chip-av', core.initialOf(u.name)));
        chip.appendChild(h('span', 'sw-chip-name', u.name));
        chip.addEventListener('click', function () {
          core.switchTo(undefined, u.id);
          applySwitch('已换成「' + u.name + '」');
        });
        uList.appendChild(chip);
      });
      var addU = h('button', 'sw-chip sw-chip-add');
      addU.type = 'button';
      addU.appendChild(h('span', 'sw-chip-av', '+'));
      addU.appendChild(h('span', 'sw-chip-name', '新增'));
      addU.addEventListener('click', function () {
        closeSwitcher();
        if (switchCtx) switchCtx.open('mask-edit', { id: '' });
      });
      uList.appendChild(addU);
      cRow.appendChild(uList);

      /* 对面的人（本房角色：大号 + 皮套） */
      core.charsOfSandbox(sb).forEach(function (m) {
        var grp = h('div', 'sw-group');
        var top = h('button', 'sw-main' + (m.id === activeChar ? ' is-on' : ''));
        top.type = 'button';
        top.appendChild(h('span', 'sw-av', core.initialOf(m.name)));
        var tb = h('span', 'sw-main-body');
        tb.appendChild(h('span', 'sw-main-name', m.name || '未命名'));
        var boundUser = m.boundUserId ? core.findUser(m.boundUserId) : null;
        tb.appendChild(h('span', 'sw-main-sub',
          '大号' + (boundUser ? ' · 绑定 ' + boundUser.name : ' · 未绑定马甲')));
        top.appendChild(tb);
        if (m.id === activeChar) top.appendChild(h('span', 'sw-cur', '进行中'));
        top.addEventListener('click', function () { pick(m.id, m.boundUserId, m.name); });
        grp.appendChild(top);

        core.subChars(m.id).forEach(function (s) {
          if (s.sandboxId && s.sandboxId !== sb.id) return;   /* 只列本房的皮套 */
          var sub = h('button', 'sw-sub-item' + (s.id === activeChar ? ' is-on' : ''));
          sub.type = 'button';
          sub.appendChild(h('span', 'sw-av sw-av-sub', core.initialOf(s.name)));
          var sbBody = h('span', 'sw-main-body');
          sbBody.appendChild(h('span', 'sw-main-name', s.name || '未命名'));
          var bu = s.boundUserId ? core.findUser(s.boundUserId) : null;
          sbBody.appendChild(h('span', 'sw-main-sub',
            '小号' + (bu ? ' · 绑定 ' + bu.name : ' · 未绑定马甲')));
          sub.appendChild(sbBody);
          if (s.id === activeChar) sub.appendChild(h('span', 'sw-cur', '进行中'));
          sub.addEventListener('click', function () {
            /* 切到皮套时，绑定的马甲一起切 —— 1:1 对称 */
            pick(s.id, s.boundUserId, s.name);
          });
          grp.appendChild(sub);
        });

        cRow.appendChild(grp);
      });
    }
    body.appendChild(cRow);

    body.appendChild(h('p', 'sw-note',
      '换岛在上面那层：数据和视觉整体换。换身份在下面这层：' +
      '只决定聊天里「对面是谁、我是谁」，岛和桌面都不动。'));
  }

  /* 降落一座岛：activeSandboxId 换过去，数据和视觉整体换。
     身份跟着岛走（09-18 的设计）：孤岛直接锁定那 1v1；
     群岛多人不替人选（决策 4），身份留给下层自己挑。 */
  function pickIsland(sb) {
    var r = core.setActiveSandbox(sb.id);
    if (!r.ok) { if (Sleepy.toast) Sleepy.toast(r.message, 'err'); return; }
    var chars = core.charsOfSandbox(sb);
    if (chars.length && !core.needsCharPick(sb)) {
      var masks = core.masksOfSandbox(sb);
      core.switchTo(chars[0].id, masks.length ? masks[0].id : undefined);
    }
    var list = core.listSandboxes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === sb.id) {
        list[i].usedAt = Date.now();
        list[i].updatedAt = Date.now();
      }
    }
    core.saveSandboxes(list);
    applySwitch('已降落到「' + roomTitleOf(sb) + '」');
  }

  function pick(charId, userId, name) {
    var patch = {};
    var root = core.rootOf(charId);
    /* 桌面氛围跟大号走（皮套只是「这张脸」，宇宙还是那个宇宙） */
    core.switchTo(root ? root.id : charId, userId || undefined);
    applySwitch('已切换到「' + (name || '角色') + '」');
  }

  function applySwitch(msg) {
    closeSwitcher();
    if (Sleepy.toast) Sleepy.toast(msg, 'ok');
    /* 整机重绘：桌面的角色卡/印章/电量、聊天列表的默认身份都要跟着换 */
    var home = document.querySelector('.page[data-page="home"]');
    if (home && Sleepy.__homeCtx && Sleepy.__homeCtx.repaint) {
      Sleepy.__homeCtx.repaint();
    }
    var top = Sleepy.nav && Sleepy.nav.top && Sleepy.nav.top();
    if (top === 'chat-detail' && Sleepy.chatDetailRefresh) Sleepy.chatDetailRefresh();

    /* 当前这一页也要跟着刷 —— 文档一：「『我』是马甲切换中枢，切完之后
       Chat 列表和朋友圈无缝刷新为当前马甲视角」。
       挂在栈顶的那一页只要自己实现了 ctx.refresh（= 它的 onShow），就调它。
       聊天 App 容器就挂了：切完马甲，消息列表和「我」那一屏一起换视角。 */
    var topCtx = Sleepy.nav && Sleepy.nav.topCtx && Sleepy.nav.topCtx();
    if (topCtx && typeof topCtx.refresh === 'function' && top !== 'chat-detail') {
      topCtx.refresh();
    }
  }

  function openSwitcher(ctx) {
    switchCtx = ctx || switchCtx;
    ensureSwitcher(ctx);
    renderSwitcher();
    switchEls.mask.classList.add('is-open');
    switchEls.panel.classList.add('is-open');
  }

  function closeSwitcher() {
    if (!switchEls) return;
    switchEls.mask.classList.remove('is-open');
    switchEls.panel.classList.remove('is-open');
  }

  /* ================= 二、面具轮盘（宇宙内切皮套） ================= */

  /* 挂在聊天输入框左侧的 User 头像上。长按呼出，滑动秒切。
     总纲写的是「滑动秒切」—— 但真正的滑动选择在手机上很难做准
     （手指挡着看不见选中的是哪个），所以这里做成：
     长按呼出 → 点击即切。滑动切换作为可选的加分项没做，
     因为「点一下就切」比「滑到正确的那一格再松手」更快也更准。 */
  function openWheel(ctx, chatId) {
    var chat = getChatSafe(chatId);
    var charId = chat ? chat.characterId : store.get('activeCharId');
    var root = core.rootOf(charId);
    if (!root) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }

    /* 可切的身份：这个角色宇宙里，所有绑了马甲的皮套 + 大号 */
    var options = [];
    var bound = root.boundUserId;
    options.push({ charId: root.id, userId: bound || null, name: root.name, label: '大号' });
    core.subChars(root.id).forEach(function (s) {
      options.push({ charId: s.id, userId: s.boundUserId || null, name: s.name, label: '小号' });
    });

    var withMask = options.filter(function (o) { return o.userId; });
    if (withMask.length < 2) {
      ctx.toast('这个角色还没有多个绑好马甲的小号', 'warn');
      return;
    }

    buildWheel(ctx, chat, withMask);
  }

  /* 读取方：只看当前房里的对话（别的存档的对话不在这个视野内）。
     注意同文件的 switchMask() 是**写入方**，它必须拿全量再整表落盘 ——
     两处不能互换。 */
  function getChatSafe(chatId) {
    var chats = store.get('chats');
    if (!Array.isArray(chats)) return null;
    var list = (core && core.scoped) ? core.scoped(chats) : chats;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === chatId) return list[i];
    }
    return null;
  }

  function buildWheel(ctx, chat, options) {
    var host = document.getElementById('phone') || document.body;

    var mask = h('div', 'wh-mask');
    var panel = h('div', 'wh-panel');

    panel.appendChild(h('p', 'wh-title', '面具'));
    panel.appendChild(h('p', 'wh-sub', '选一张脸，继续说这句话'));

    var list = h('div', 'wh-list');
    var curUserId = chat.userId || store.get('activeUserId');

    options.forEach(function (o) {
      var item = h('button', 'wh-item' + (o.userId === curUserId ? ' is-on' : ''));
      item.type = 'button';
      item.appendChild(h('span', 'wh-av', core.initialOf(o.name)));
      var b = h('span', 'wh-body');
      b.appendChild(h('span', 'wh-name', o.name));
      b.appendChild(h('span', 'wh-desc', o.label +
        (o.userId ? ' · 对应马甲 ' + (core.findUser(o.userId) || {}).name : '')));
      item.appendChild(b);
      if (o.userId === curUserId) item.appendChild(h('span', 'wh-cur', '戴着'));

      item.addEventListener('click', function () {
        switchMask(ctx, chat, o);
        closeWheel();
      });
      list.appendChild(item);
    });

    panel.appendChild(list);

    var cancel = button('取消', 'ghost', function () { closeWheel(); });
    panel.appendChild(cancel);

    host.appendChild(mask);
    host.appendChild(panel);
    setTimeout(function () {
      mask.classList.add('is-open');
      panel.classList.add('is-open');
    }, 10);

    mask.addEventListener('click', closeWheel);

    function closeWheel() {
      mask.classList.remove('is-open');
      panel.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      }, 260);
    }
  }

  /* 秒切马甲。同一个对话里换身份要继续说下去，
     所以必须往消息流里插一条「换了张脸」的系统事件 ——
     否则模型下一轮不知道自己面对的是谁。 */
  function switchMask(ctx, chat, o) {
    var chats = store.get('chats');
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id !== chat.id) continue;
      chats[i].userId = o.userId;
      /* 皮套换了，charId 也一起换 —— 这才是「同一对话内的双重身份横跳」 */
      chats[i].characterId = o.charId;
      if (!Array.isArray(chats[i].messages)) chats[i].messages = [];
      chats[i].messages.push({
        id: core.newId('ms'),
        role: 'system',
        content: '（你换了一副面具，现在以「' + o.name + '」的身份继续这段对话。）',
        timestamp: Date.now()
      });
      chats[i].updatedAt = Date.now();
      break;
    }
    store.set('chats', chats);
    core.switchTo(undefined, o.userId);
    ctx.toast('已换成「' + o.name + '」', 'ok');
    if (Sleepy.chatDetailRefresh) Sleepy.chatDetailRefresh();
  }

  /* ================= 三、记忆认知层（Prompt 编译） ================= */

  /* 把记忆编译成系统提示词。两种情况：
       isolated（物理隔离）→ 只给同组合的记忆，不解释
       full + unaware      → 给全量，但加一段「界限说明」防粉红大象
       full + aware        → 给全量，不加说明（明牌局，随便你）

     为什么记忆要带 [U → C] 标签：
      掉马之后模型同时读到两份反差极大的记忆，没有标签它分不清
      哪句话是谁对谁说的，修罗场会变成胡言乱语。 */
  function compileMemory(charId, userId, limit) {
    /* 留痕的记忆库（memoryStore）优先：有数据且该角色开着记忆系统，
       就用它组织过的注入块（锚定 > 边界 > 纠正 > 近期，含推测标注）；
       没有数据再回落到 core 的原始对话记忆。认知模式（isolated/unaware）
       的「界限说明」仍然保留 —— 那是防粉红大象的，跟记忆来源无关。 */
    var injected = '';
    try {
      if (Sleepy.memoryStore && Sleepy.memoryStore.getMemoryInjection) {
        injected = Sleepy.memoryStore.getMemoryInjection(charId) || '';
      }
    } catch (e) { injected = ''; }

    var view = core.memoryViewFor(charId, userId);
    var items = view.items;

    if (limit > 0 && items.length > limit) items = items.slice(-limit);
    if (!injected && !items.length && !view.note) return '';

    var lines = [];

    if (injected) {
      lines.push('【记忆】');
      lines.push(injected);
    } else if (view.mode === 'isolated') {
      lines.push('【记忆】只检索到这个身份组合下发生过的事。');
    } else {
      lines.push('【记忆】以下是这个角色记得的全部事情，按 [说话对象 → 你的身份] 归档。');
      items.forEach(function (m) {
        lines.push('- ' + core.tagOf(m) + ' ' +
          (m.role === 'user' ? '对方说：' : '你说：') + m.text);
      });
    }

    if (view.note) {
      lines.push('');
      lines.push(view.note);
    }

    return lines.join('\n');
  }

  /* 掉马事件编译。没看过的掉马事件要作为系统事件强行注入 ——
     总纲原文：「强行注入系统事件（连带头像/昵称的反差一起暴露）」。 */
  function compileDrop(rootId) {
    var evs = core.pendingDropEvents(rootId);
    if (!evs.length) return '';

    var lines = ['【刚刚发生的事】'];
    evs.forEach(function (e) {
      lines.push(e.text);
    });
    lines.push('');
    lines.push('从这一刻起，你不再需要掩饰。你可以自然地表现出两段记忆同时存在的错乱感。');

    core.markDropEventsSeen(evs.map(function (e) { return e.id; }));
    return lines.join('\n');
  }

  /* 认知状态编译：告诉模型「你现在知道多少」 */
  function compileCognition(charId, userId) {
    var cog = core.cognitionOf(charId, userId);
    var root = core.rootOf(charId);
    var c = core.findChar(charId);
    var u = core.findUser(userId);

    var lines = [];
    lines.push('【你的身份】你此刻以「' + (c ? c.name : '?') + '」这张脸，面对「' +
      (u ? u.name : '对方') + '」。');

    if (cog.barrier) {
      lines.push('这一对大小号之间的记忆完全隔离，你没有任何渠道知道另一边的存在。');
    } else if (cog.cognition === 'unaware') {
      lines.push('你以为对方只有这一个身份。如果记忆里出现不属于眼前这个人的片段，');
      lines.push('把它当成别人的事 —— 顶多有一点说不清的熟悉感。');
    } else {
      var subs = root ? core.subChars(root.id) : [];
      if (subs.length) {
        lines.push('你知道对方看穿了你的双重身份，也知道自己有几张脸：' +
          subs.map(function (s) { return s.name; }).join('、') + '。');
        lines.push('不需要再掩饰，可以自如切换。');
      }
    }
    return lines.join('\n');
  }

  /* K03 注入接线二期（09-19）：群岛关系 + 身份归属判断 + 岛内 NPC 资料。
     数据源都在浮岛那边（charRel:<sbId> 三态、judge:<obs>:<mask>、
     NPC 的 knownBy/npcVis/speech），这里只读不写。
     没有岛、或没什么可说的时候就返回空串，不给 prompt 添噪音。 */
  function compileIslandKB(charId) {
    if (!Sleepy.island || !Sleepy.island.getPairRel) return '';
    var sb = core.activeSandbox();
    if (!sb) return '';
    var self = core.findChar(charId);
    if (!self) return '';
    var selfRoot = core.rootOf(charId) || self;   /* 皮套说话时按大号查关系 */

    var isArchi = sb.kind === core.KIND_ARCHI;
    var mains = core.charsOfSandbox(sb);
    var lines = [];

    /* ① 群岛关系：char↔char 认识与否（仅群岛、≥2 位主要角色才有意义）。
        「不认识」也要说 —— 这是防角色之间越界认亲的。 */
    if (isArchi && mains.length > 1) {
      mains.forEach(function (m) {
        if (m.id === selfRoot.id) return;
        var rel = Sleepy.island.getPairRel(sb.id, selfRoot.id, m.id);
        if (rel === 'known') {
          lines.push('- 你和「' + m.name + '」认识。');
        } else if (rel === 'met') {
          lines.push('- 你和「' + m.name + '」见过面但不熟：知道有这么个人，仅此而已。');
        } else {
          lines.push('- 你和「' + m.name + '」不认识：没打过交道，' +
            '除非这场对话里真的遇上了，否则不要表现得认识 TA。');
        }
      });
    }

    /* ② 身份归属判断：这位角色眼中，某张马甲是不是同一个人。
        「林澈以为阿乐是另一个人」就是这条在防 ——
        不知情时明确告诉模型 TA 信的版本，而不是让它读到两份记忆自己瞎猜。 */
    core.masksOfSandbox(sb).forEach(function (u) {
      var judge = Sleepy.island.getJudge(sb.id, selfRoot.id, u.id);
      if (judge === 'other') {
        lines.push('- 在你眼里，「' + u.name + '」是另一个人，' +
          '跟其他身份没有任何关系。');
      } else if (judge === 'same') {
        lines.push('- 你知道「' + u.name + '」是同一个人的另一张脸。');
      }
      /* unset = 用户还没判断，不注入，别替用户表态 */
    });

    /* ③ 岛内 NPC：只把「认识 TA」的人的资料发给这位角色（demo 规则：
       没勾选的人不会自动获得 NPC 的资料）。 */
    (core.npcsOfRoom(sb) || []).forEach(function (n) {
      var knownBy = Array.isArray(n.knownBy) ? n.knownBy : [];
      if (knownBy.indexOf(selfRoot.id) < 0 && knownBy.indexOf(charId) < 0) return;
      var desc = (n.content || '').trim();
      if (desc.length > 80) desc = desc.slice(0, 80) + '…';
      var speech = (n.speech || '').trim();
      if (speech.length > 60) speech = speech.slice(0, 60) + '…';
      var one = '- 你认识岛内的「' + (n.name || '某人') + '」' +
        (desc ? '：' + desc : '');
      if (speech) one += '（说话与行为：' + speech + '）';
      lines.push(one + '。');
    });

    if (!lines.length) return '';
    lines.unshift('【这座岛里的人际】');
    return lines.join('\n');
  }

  /* 一次性给全：聊天页组装 system prompt 时调这个 */
  function compileSystemContext(charId, userId, limit) {
    var parts = [];
    var cog = compileCognition(charId, userId);
    if (cog) parts.push(cog);

    var kb = compileIslandKB(charId);
    if (kb) parts.push(kb);

    var root = core.rootOf(charId);
    var drop = compileDrop(root ? root.id : null);
    if (drop) parts.push(drop);

    var mem = compileMemory(charId, userId, limit);
    if (mem) parts.push(mem);

    return parts.join('\n\n');
  }

  /* ================ 我（聊天 App 的第 4 屏 · 马甲切换中枢）================

     文档一：「『我』是马甲切换中枢 —— 切完之后 Chat 列表和朋友圈无缝刷新」。
     所以这一屏顶部第一件事必须是「我现在是谁」+ 一键切。

     09-22 用户拍板改成**仿微信平铺**：
       hero（当前账号：头像 + 名字 + 微信号，点整块进个人资料）→ 一行小字
       （本岛大号/小号 · 在不在当前岛）→ 平铺入口
       （个人资料 / 切换账号 / 钱包 / 表情包 / 拍一拍）+ 设置 → 脚注。
     三件事说清楚：
       · **「我的身份库」整块删掉** —— 那是全局身份 + 跨岛切，
         用户原话「这个组件是直接取消」；切换账号只列**当前岛**的账号。
       · 每一项都属于**当前账号**：大号和小号各有各的钱包 / 拍一拍 / 资料，
         只有表情包能「同步到所有账号」。
       · 收藏不在这一页 —— 以后那个 we app 做。
     折叠抽屉（mePhoneOpen /「我的小手机」）一起撤了，不再需要。

     容器在 page-app.js。这一屏返回 { rebuild } 给它。 */

  function mountMeTab(panel, ctx) {
    function build() {
    panel.innerHTML = '';

    var sb = core.activeSandbox();
    /* 「当前是谁」必须问 core.activeUser()，**不能取列表第一项** ——
       账号列表里第一件只是「最早建的」，跟此刻戴着哪张脸无关。 */
    var u = core.activeUser();
    if (!u) {
      panel.appendChild(h('p', 'set-group-note', '还没有任何账号 · 先去浮岛配置台建一个'));
      return;
    }
    var mates = core.masksOfSandbox(sb);
    var dft = sb ? core.defaultUserOfSandbox(sb) : null;
    var inRoom = mates.some(function (x) { return x.id === u.id; });
    var roomName = '';
    try { if (sb && Sleepy.island) roomName = Sleepy.island.roomTitle(sb); } catch (e) { roomName = ''; }

    /* ---- hero：当前账号（仿微信「我」页顶部）----
       点整块进个人资料。用户 2026-09-22：「个人资料就做那种可以在里面
       直接改当前账号设定和头像以及微信名的那种」。 */
    var hero = h('div', 'mtb-hero');
    hero.appendChild(h('div', 'mtb-label', 'CURRENT ACCOUNT'));
    var line = h('div', 'mtb-current is-tap');
    var av = h('span', 'me-av', core.initialOf(u.name));
    core.setAvatarBg(av, u);
    line.appendChild(av);
    var hb = h('div', 'mtb-copy');
    hb.appendChild(h('b', '', u.name));
    hb.appendChild(h('small', '', u.wechatName ? ('微信号 ' + u.wechatName) : '还没填微信号'));
    line.appendChild(hb);
    line.appendChild(h('span', 'mtb-arrow', '›'));
    line.addEventListener('click', function () { ctx.open('me-profile'); });
    hero.appendChild(line);

    /* 「这间房里的我」原来独占一节，现在压成一行 ——
       微信「我」页没有说明块，但「在不在当前岛」得让人一眼看见。 */
    hero.appendChild(h('p', 'mtb-note' + (inRoom ? '' : ' is-warn'),
      (dft && dft.id === u.id ? '本岛大号' : '本岛小号') +
      (roomName ? ' · 在「' + roomName + '」' : '') +
      (inRoom ? ' · 已进入当前岛' : ' · 还没进入当前岛')));
    panel.appendChild(hero);

    /* ---- 平铺入口（一行一个，微信那种）----
       每一项都属于**当前这个账号**：换个账号，看到的是它的那一份
       （用户 2026-09-22：「就是当前账号的设置…我打开每个小号也会有
       不同的设置，我里面只有表情包是直接可以同步所有的」）。 */
    var tools = h('div', 'mtb-tools');
    tools.appendChild(toolRow('个人资料', '头像 · 名字 · 微信号 · 人设',
      function () { ctx.open('me-profile'); }));
    tools.appendChild(toolRow('切换账号',
      '当前：' + u.name + '（' + (dft && dft.id === u.id ? '大号' : '小号') + '）· 只列这座岛的',
      function () { openAccountSwitcher(ctx, build); }));
    tools.appendChild(toolRow('钱包', '零钱与转账记录', function () { ctx.open('wallet'); }));
    tools.appendChild(toolRow('表情包', '可同步到所有岛 · 所有账号', function () { ctx.open('stickers'); }));
    tools.appendChild(patRow(u, ctx));
    panel.appendChild(tools);

    /* 设置单独一组 —— 跟上面「我的东西」分开 */
    var tools2 = h('div', 'mtb-tools');
    tools2.appendChild(toolRow('设置', '模型 · 生图 · 备份', function () { ctx.open('settings'); }));
    panel.appendChild(tools2);

    panel.appendChild(h('p', 'set-foot',
      '这一页的每一项都属于「' + u.name + '」这个账号。哪张账号能进入哪座岛，由浮岛配置台决定。'));
  }


    function toolRow(label, hint, go) {
      var rowEl = h('button', 'mtb-tool');
      rowEl.type = 'button';
      var left = h('span', '');
      left.appendChild(h('b', '', label));
      left.appendChild(h('small', '', hint));
      rowEl.appendChild(left);
      rowEl.appendChild(h('span', 'mtb-arrow', '›'));
      rowEl.addEventListener('click', go);
      return rowEl;
    }

    /* 拍一拍：后缀存在**这个账号**上（换账号各有各的） */
    function patRow(u, ctx) {
      var rowEl = h('button', 'mtb-tool');
      rowEl.type = 'button';
      var left = h('span', '');
      left.appendChild(h('b', '', '拍一拍'));
      var hint = h('small', '', '被拍时显示的后缀 · 现在是「' + (u.patSuffix || '肩膀') + '」');
      left.appendChild(hint);
      rowEl.appendChild(left);
      rowEl.appendChild(h('span', 'mtb-arrow', '›'));
      rowEl.addEventListener('click', function () {
        ui.prompt({
          title: '拍一拍后缀',
          note: '别人拍你时会显示「我拍了拍你的 ×××」，只写后半句',
          value: u.patSuffix || '肩膀',
          ok: '记下来'
        }).then(function (v) {
          if (v === null) return;
          var s2 = String(v).trim().slice(0, 20);
          core.upsertUser({ id: u.id, patSuffix: s2 });
          hint.textContent = '被拍时显示的后缀 · 现在是「' + (s2 || '肩膀') + '」';
          ctx.toast('记下来了', 'ok');
        });
      });
      return rowEl;
    }

    build();
    return { rebuild: build };
  }

  /* 切换账号：**只列当前这座岛上的账号**（大号 + 小号）。

     用户 2026-09-22：「切换账号会显示所有这个岛屿里 user 的大号小号」。
     原来那个「我的身份库」列的是全局所有身份、还能跨岛切 —— 那个组件
     **直接取消**（岛与岛之间隔绝往来，不在这儿开口子）。
     注意只换账号、**不换角色**：聊天里换的是「我戴哪张脸」，
     角色归「切换角色」那个面板管，两件事别混。 */
  function openAccountSwitcher(ctx, rebuild) {
    var sb = core.activeSandbox();
    if (!sb) { ctx.toast('先进一座岛', 'warn'); return; }
    var mates = core.masksOfSandbox(sb);
    if (!mates.length) { ctx.toast('这座岛上还没有账号', 'warn'); return; }
    var cur = core.activeUser();
    var dft = core.defaultUserOfSandbox(sb);

    /* 挂 #phone —— 祖先带 transform 时 fixed 会退化成相对该祖先定位 */
    var host = document.getElementById('phone') || document.body;
    var mask = h('div', 'sw-mask');
    var panel2 = h('div', 'sw-panel');

    var head = h('div', 'sw-head');
    head.appendChild(h('p', 'sw-title', '切换账号'));
    var close = h('button', 'sw-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(close);
    panel2.appendChild(head);
    panel2.appendChild(h('p', 'sw-sub', '只列这座岛上的账号 · 选中后聊天和朋友圈跟着换'));

    var body = h('div', 'sw-body');
    var wrap = h('div', 'mtb-idents');
    mates.forEach(function (m) {
      var isCur = !!(cur && m.id === cur.id);
      var isDft = !!(dft && m.id === dft.id);
      var rowEl = h('button', 'mtb-ident' + (isCur ? ' is-current' : ''));
      rowEl.type = 'button';
      var mini = h('span', 'mtb-mini', core.initialOf(m.name));
      core.setAvatarBg(mini, m);
      rowEl.appendChild(mini);
      var copy = h('span', 'mtb-ident-copy');
      copy.appendChild(h('b', '', m.name));
      copy.appendChild(h('small', '', (isDft ? '大号' : '小号') +
        (m.wechatName ? ' · ' + m.wechatName : '')));
      rowEl.appendChild(copy);
      rowEl.appendChild(h('span', 'mtb-side', isCur ? '正在用' : ''));
      rowEl.addEventListener('click', function () {
        if (isCur) { closeFn(); return; }
        /* 角色保持不变：只换账号。
           charId 只在能拿到「本岛当前角色」时才传 —— 指针停在别座岛的人
           身上时宁可不传（switchTo(undefined, id) 只写 activeUserId），
           也不要把别岛的角色 id 写成当前角色。 */
        var cc = (core.activeCharOnIsland ? core.activeCharOnIsland() : core.activeChar()) || null;
        if (cc && cc.id) core.switchTo(cc.id, m.id);
        else core.switchTo(undefined, m.id);
        closeFn();
        if (rebuild) rebuild();
        ctx.toast('换成了「' + m.name + '」', 'ok');
      });
      wrap.appendChild(rowEl);
    });
    body.appendChild(wrap);
    panel2.appendChild(body);
    host.appendChild(mask);
    host.appendChild(panel2);

    function closeFn() {
      mask.classList.remove('is-open');
      panel2.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (panel2.parentNode) panel2.parentNode.removeChild(panel2);
      }, 240);
    }
    close.addEventListener('click', closeFn);
    mask.addEventListener('click', closeFn);
    /* 下一帧再加 is-open，否则 transition 不触发 */
    setTimeout(function () {
      mask.classList.add('is-open');
      panel2.classList.add('is-open');
    }, 16);
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.switcher = {
    open: openSwitcher,
    close: closeSwitcher,
    wheel: openWheel,
    compileSystemContext: compileSystemContext,
    compileIslandKB: compileIslandKB,
    compileMemory: compileMemory,
    compileCognition: compileCognition,
    compileDrop: compileDrop
  };

  /* 聊天 App 容器（page-app.js）从这里取「我」那一屏 */
  Sleepy.meTab = {
    mountTab: mountMeTab
  };

  /* 桌面的 render 跑完之后，把 ctx 存一份，
     这样切号时 applySwitch 不用去重新找页面实例。 */
  var _register = Sleepy.register;
  Sleepy.register = function (id, def) {
    var wrapped = def;
    if (id === 'home') {
      var origRender = def.render;
      wrapped = {};
      for (var k in def) {
        if (Object.prototype.hasOwnProperty.call(def, k)) wrapped[k] = def[k];
      }
      wrapped.render = function (ctx) {
        Sleepy.__homeCtx = ctx;
        return origRender(ctx);
      };
    }
    return _register(id, wrapped);
  };

})(window);
