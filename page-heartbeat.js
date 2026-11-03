/* ============================================================
   page-heartbeat.js — 模块 E：心声
   依赖：store.js、ui.js、api.js；数据层用 Sleepy.chatStore（page-chat.js 暴露）
   对应施工卡：
     E1 头像「未读心声」状态位 + 呼吸光点动画
     E2 心声内容独立渲染层（点头像弹出，不与普通消息气泡共用组件）

   心声怎么来的（跟着主回复一起出，不额外占一次生成额度）
     不是「回复落地后再发一次请求」，而是在同一个请求里加一条系统指令，
     要求模型把心声用 <心声>…</心声> 包在回复末尾。前端在流式过程中就把
     这段切出来：正文进气泡，心声进心声池。
     好处：生成额度不翻倍、延迟不增加、心声和这一轮回复必然对应。
     代价：依赖模型听话。splitReply() 对「半个标签」做了保护，
           拿不到标签也只是没有新心声，绝不影响正文。
     **一轮永远只有一条** —— 不做「每次几条」的配置；多写了只取第一句。

   面板为什么居中、为什么分两页
     - 居中：底部抽屉和「长按菜单 / 加号面板」是同一种姿势，放一起会混；
       心声是独立的小世界，居中浮起来更像「翻开一页心里的东西」。
     - 分页：默认只看**最新一条**（这是你刚聊完最想知道的），
       想看前面的点「看前面的 N 条」翻到历史，历史页再点「回到最新」。
       全堆成一长串的话，最新那条反而被埋在下面。

   为什么挂「顶部头像」来显示未读：
     气泡头像会随消息列表滚走，未读光点经常看不见。顶部头像固定可见。
     气泡头像仍可点（同样打开面板），只是不挂光点，避免一屏两个跳动的小点。

   数据挂在对话上：chat.heartbeats = [{ id, text, at, read }]
     —— 挂 chats 里就能被 store.exportAll() 一起导出，不用再登记新键。

   依赖方向提醒：本文件必须先于 page-chat.js 加载。但数据层的取用一律写成
   惰性访问 `chatStore()`，不在这里提前缓存，加载顺序变了也不会炸。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var button = ui.button;
  var relativeTime = ui.relativeTime;

  var AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%237A5C4A'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z'/%3E%3C/svg%3E";

  /* 标记用中文尖括号，模型照抄的意愿更高，也不容易和对话里的英文尖括号撞车 */
  var OPEN = '<心声>';
  var CLOSE = '</心声>';

  /* 手动按钮那一路按对话 id 去重，避免连点堆请求 */
  var generating = {};

  /* ---------------------------- 依赖访问 ---------------------------- */

  function chatStore() {
    var cs = Sleepy.chatStore;
    if (!cs) {
      if (global.console && global.console.warn) {
        global.console.warn('[Sleepy] 心声需要 page-chat.js 暴露的 Sleepy.chatStore');
      }
      return null;
    }
    return cs;
  }

  function newId() {
    return 'hb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ================= 跟主回复一起输出的心声：切分 ================= */

  /* s 的后缀里，最长的「OPEN 前缀」长度。
     流式渲染时必须把这种半截标签扣住，否则用户会看到 "<心" 闪一下。 */
  function heldTail(s) {
    var max = Math.min(s.length, OPEN.length - 1);
    for (var len = max; len > 0; len--) {
      if (s.slice(s.length - len) === OPEN.slice(0, len)) return len;
    }
    return 0;
  }

  /* 返回 { visible, heartbeat, closed }
       visible   正文：进聊天气泡的那部分
       heartbeat 心声原文（可能还没接收完，也可能是 null）
       closed    结束标签到了没有
     没有开标签时 heartbeat 为 null —— 说明这次模型没吐心声，正常。 */
  function splitReply(raw) {
    var text = String(raw || '');
    var i = text.indexOf(OPEN);

    if (i < 0) {
      var hold = heldTail(text);
      return {
        visible: hold ? text.slice(0, text.length - hold) : text,
        heartbeat: null,
        closed: false
      };
    }

    var visible = text.slice(0, i);
    var rest = text.slice(i + OPEN.length);
    var j = rest.indexOf(CLOSE);
    var beat = j >= 0 ? rest.slice(0, j) : rest;

    /* 兜底：模型把标签写在了最前面，正文就空了。
       这种情况宁可把正文还回来，也不要给用户一个空气泡。 */
    if (!visible.trim() && beat.trim()) {
      visible = rest.replace(CLOSE, '').trim();
      beat = '';
    }

    return { visible: visible, heartbeat: beat, closed: j >= 0 };
  }

  /* 模型常带编号、引号、项目符号回来，统一削掉 */
  function parseLines(text, n) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var t = line
        .replace(/^\s*[-*\u00b7\u2022]\s*/, '')
        .replace(/^\s*\d+\s*[.、)]\s*/, '')
        .replace(/^[「『"'\u201c\u2018（(]+/, '')
        .replace(/[」』"'\u201d\u2019）)]+$/, '')
        .trim();
      if (t.length < 2 || t.length > 60) return;
      out.push(t);
    });
    return out.slice(0, n || 1);
  }

  /* 把一段心声原文入库。一轮只收第一条。
     模型不听话写了好几行时，取第一句 —— 那是它最想说的。
     返回刚入库的那条记录（调用方要把 id 挂到消息上，reroll 时好按它删）。 */
  function commit(chatId, rawBeat) {
    var cs = chatStore();
    if (!cs || !chatId) return null;
    var items = parseLines(rawBeat, 1);
    if (!items.length) return null;

    var rec = { id: newId(), text: items[0], at: Date.now(), read: false };
    cs.mutate(chatId, function (c) {
      if (!Array.isArray(c.heartbeats)) c.heartbeats = [];
      c.heartbeats.push(rec);
    });
    syncDots(chatId);
    return rec;
  }

  /* 按 id 删一条心声。reroll 用：这条回复被重说了，它带的那句心声也该跟着走。 */
  function drop(chatId, hbId) {
    if (!chatId || !hbId) return 0;
    var cs = chatStore();
    if (!cs) return 0;
    var n = 0;
    cs.mutate(chatId, function (c) {
      if (!Array.isArray(c.heartbeats)) return;
      var before = c.heartbeats.length;
      c.heartbeats = c.heartbeats.filter(function (x) { return x.id !== hbId; });
      n = before - c.heartbeats.length;
    });
    if (n) syncDots(chatId);
    return n;
  }

  /* 老消息身上没记 hbId 时的退路：删掉 at >= ts 的那一条。
     被 reroll 的必然是最后一条助手消息，所以最多命中一条，删它是安全的。 */
  function dropLastAfter(chatId, ts) {
    if (!chatId || !ts) return 0;
    var cs = chatStore();
    if (!cs) return 0;
    var hit = null;
    cs.mutate(chatId, function (c) {
      if (!Array.isArray(c.heartbeats)) return;
      for (var i = c.heartbeats.length - 1; i >= 0; i--) {
        if (c.heartbeats[i].at >= ts) { hit = c.heartbeats[i].id; break; }
      }
      if (hit) c.heartbeats = c.heartbeats.filter(function (x) { return x.id !== hit; });
    });
    if (hit) syncDots(chatId);
    return hit ? 1 : 0;
  }

  /* 给 buildMessages 用的系统指令，放在消息数组最前面。
     写得尽量短 —— 它是每次请求都要付钱的输入 token。 */
  function replySpec() {
    return [
      '【输出格式】正文写完后，另起一行，用 ' + OPEN + ' 和 ' + CLOSE +
        ' 包住角色这一轮没说出口的那一句心里话。',
      '只写一句，不超过 25 字，不要写成多行。',
      '只写角色此刻的内心活动：不是对别人说话、不出现称呼，不复述正文，',
      '不提问，不讲道理。实在没有就整段省略。',
      '',
      '例：',
      '那我先睡了。',
      '',
      OPEN,
      '其实还想再聊一会儿，但没说出口',
      CLOSE
    ].join('\n');
  }

  /* ---------------------------- E1 未读 ---------------------------- */

  function listOf(chat) {
    if (!chat || !Array.isArray(chat.heartbeats)) return [];
    return chat.heartbeats;
  }

  function unreadCount(chat) {
    var n = 0;
    listOf(chat).forEach(function (x) { if (!x.read) n++; });
    return n;
  }

  function markRead(chatId) {
    var cs = chatStore();
    if (!cs) return;
    cs.mutate(chatId, function (c) {
      if (!Array.isArray(c.heartbeats)) return;
      c.heartbeats.forEach(function (x) { x.read = true; });
    });
  }

  /* 光点只认一个 class，显示/隐藏交给 CSS */
  function syncDots(chatId) {
    var cs = chatStore();
    if (!cs) return;
    var has = unreadCount(cs.getChat(chatId)) > 0;
    var slots = document.querySelectorAll('.avatar-slot[data-hb-chat="' + chatId + '"]');
    for (var i = 0; i < slots.length; i++) {
      slots[i].classList[has ? 'add' : 'remove']('has-unread');
    }
  }

  /* 顶部头像 + 未读光点。返回可以直接插进 DOM 的槽位 */
  function mountAvatar(ctx, chatId) {
    var slot = h('span', 'avatar-slot');
    slot.setAttribute('data-hb-chat', chatId);

    var img = h('img', 'head-avatar');
    img.src = AVATAR;
    img.alt = '角色';
    img.title = '看没说出口的话';

    slot.appendChild(img);
    slot.appendChild(h('span', 'hb-dot'));

    slot.addEventListener('click', function (e) {
      e.stopPropagation();
      openOverlay(ctx, chatId);
    });

    setTimeout(function () { syncDots(chatId); }, 0);
    return slot;
  }

  /* 顶栏中间的**名字**（用户定的：三版 UI 顶栏都不放头像）。
     点名字直接去朋友圈（少点一下）。未读光点不在顶栏 ——
     需求：「要放在 char 在聊天气泡旁边的头像右上角」，
     那边由 page-chat 的 msg-ava-wrap 管，这里不带光点。 */
  function mountName(ctx, chatId, name) {
    var slot = h('button', 'avatar-slot head-name-slot');
    slot.type = 'button';
    slot.setAttribute('data-hb-chat', chatId);
    slot.title = '去朋友圈';

    slot.appendChild(h('span', 'head-char-name', name || '对方'));

    slot.addEventListener('click', function (e) {
      e.stopPropagation();
      if (Sleepy.nav) Sleepy.nav.open('moments');
    });

    return slot;
  }

  /* ------------------------ E2 独立渲染层 ------------------------ */

  function sortedChat(chatId) {
    var cs = chatStore();
    if (!cs) return [];
    return listOf(cs.getChat(chatId)).slice().sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    });
  }

  /* 挂在 ctx 上复用，一个页面只建一次 */
  function ensureOverlay(ctx) {
    if (ctx.__hb) return ctx.__hb;

    var mask = h('div', 'hb-mask');
    var panel = h('div', 'hb-panel');

    var head = h('div', 'hb-head');
    var titles = h('div', 'hb-titles');
    var sub = h('p', 'hb-sub', '');
    titles.appendChild(h('p', 'hb-title', '心声'));
    titles.appendChild(sub);
    var close = h('button', 'hb-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(titles);
    head.appendChild(close);

    var body = h('div', 'hb-body');

    var foot = h('div', 'hb-foot');
    var ask = button('现在想一条', 'ghost', function () {
      ask.disabled = true;
      ask.textContent = '在想…';
      var cid = ctx.params && ctx.params.chatId;
      generate(cid, {
        onSettled: function () {
          ask.disabled = false;
          ask.textContent = '现在想一条';
        },
        onNew: function () {
          /* 用户正盯着面板看，新生成的直接算已读（否则关掉会发现光点又亮了），
             并且翻回「最新」页让他看到那条新的 */
          markRead(cid);
          syncDots(cid);
          render(ctx, cid, 'latest');
        }
      });
    });

    var autoToggle = h('label', 'hb-auto');
    var autoBox = h('input');
    autoBox.type = 'checkbox';
    autoToggle.title = '让模型在每次回复末尾顺带写一句心声（不额外消耗一次请求）';
    autoToggle.appendChild(autoBox);
    autoToggle.appendChild(h('span', 'hb-auto-text', '回复时附带'));
    autoBox.addEventListener('change', function () {
      store.set('chatDefaults.heartbeatAuto', autoBox.checked);
    });

    foot.appendChild(ask);
    foot.appendChild(autoToggle);

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    ctx.body.appendChild(mask);
    ctx.body.appendChild(panel);

    mask.addEventListener('click', function () { closeOverlay(ctx); });
    close.addEventListener('click', function () { closeOverlay(ctx); });

    ctx.__hb = {
      mask: mask,
      panel: panel,
      sub: sub,
      body: body,
      autoBox: autoBox,
      view: 'latest'
    };
    return ctx.__hb;
  }

  function noteEl(item, extra) {
    var note = h('div', 'hb-note' + (extra ? ' ' + extra : ''));
    note.appendChild(h('p', 'hb-note-text', item.text));
    note.appendChild(h('p', 'hb-note-time', relativeTime(item.at)));
    return note;
  }

  function render(ctx, chatId, view) {
    var box = ensureOverlay(ctx);
    if (view) box.view = view;

    var items = sortedChat(chatId);
    box.body.innerHTML = '';

    var cfg = store.get('chatDefaults') || {};
    box.autoBox.checked = cfg.heartbeatAuto !== false;

    if (!items.length) {
      box.sub.textContent = '没说出口的话';
      var empty = h('div', 'hb-empty');
      empty.appendChild(h('p', 'hb-empty-text', '心里还没留下什么'));
      empty.appendChild(h('p', 'hb-empty-hint', '再聊几句就有了'));
      box.body.appendChild(empty);
      return;
    }

    if (box.view === 'history') {
      var rest = items.slice(1);
      box.sub.textContent = '前面的 ' + rest.length + ' 条';

      var back = h('button', 'hb-more', '← 回到最新');
      back.type = 'button';
      back.addEventListener('click', function () { render(ctx, chatId, 'latest'); });
      box.body.appendChild(back);

      if (!rest.length) {
        var none = h('div', 'hb-empty');
        none.appendChild(h('p', 'hb-empty-text', '前面没有了'));
        none.appendChild(h('p', 'hb-empty-hint', '这是第一条心声'));
        box.body.appendChild(none);
      } else {
        var list = h('div', 'hb-list');
        rest.forEach(function (item) { list.appendChild(noteEl(item)); });
        box.body.appendChild(list);
      }
      return;
    }

    /* 最新页：只放一条，看得清 */
    box.sub.textContent = items.length > 1
      ? ('最新 · 一共 ' + items.length + ' 条')
      : '第一条';
    box.body.appendChild(noteEl(items[0], 'is-latest'));

    var more = items.length - 1;
    if (more > 0) {
      var btn = h('button', 'hb-more', '看前面的 ' + more + ' 条');
      btn.type = 'button';
      btn.addEventListener('click', function () { render(ctx, chatId, 'history'); });
      box.body.appendChild(btn);
    }
  }

  function openOverlay(ctx, chatId) {
    var box = ensureOverlay(ctx);
    render(ctx, chatId, 'latest');
    /* 看过就算读过 —— 光点在这里消失 */
    markRead(chatId);
    syncDots(chatId);
    box.mask.classList.add('is-open');
    box.panel.classList.add('is-open');
  }

  function closeOverlay(ctx) {
    if (!ctx.__hb) return;
    ctx.__hb.mask.classList.remove('is-open');
    ctx.__hb.panel.classList.remove('is-open');
  }

  /* ============ 手动补一条（自带一次小请求，跟主回复无关） ============ */

  function manualPrompt() {
    return [
      '你在为角色生成「心声」——角色没说出口的心里话。',
      '',
      '要求：',
      '1. 只写角色此刻的内心活动和感受；不是在对别人说话，不要出现任何称呼。',
      '2. 只写一句，不超过 25 个字。',
      '3. 只输出正文。不要编号、引号、书名号、括号备注、表情符号。',
      '4. 不要复述对方说过的内容，不要提问，不要讲道理，不要描写动作。'
    ].join('\n');
  }

  function generate(chatId, opts) {
    opts = opts || {};
    var cs = chatStore();
    if (!cs || !chatId) { if (opts.onSettled) opts.onSettled(0); return; }
    if (generating[chatId]) { if (opts.onSettled) opts.onSettled(0); return; }

    var chat = cs.getChat(chatId);
    if (!chat) { if (opts.onSettled) opts.onSettled(0); return; }

    /* 心声读到多少历史，跟着那个对话自己的设置走 —— 和真聊天用同一份
       回落规则（以前这里只看全局，会话级改过条数的话心声看到的历史
       会和聊天对不上）。 */
    var limit = Sleepy.api.contextLimit(chat);

    var context = [];
    (chat.messages || []).forEach(function (m) {
      if (m.role !== 'user' && m.role !== 'assistant') return;
      var t = String(m.content || '').trim();
      if (t) context.push({ role: m.role, content: t });
    });

    var msgs = [{ role: 'system', content: manualPrompt() }].concat(context);
    if (msgs.length < 2) { if (opts.onSettled) opts.onSettled(0); return; }
    if (msgs.length > limit + 1) msgs = [msgs[0]].concat(msgs.slice(-limit));

    generating[chatId] = true;

    var finish = function (count) {
      generating[chatId] = false;
      if (opts.onSettled) opts.onSettled(count);
    };

    Sleepy.api.runChat(msgs, {
      onDone: function (cand, text) {
        var count = commit(chatId, text);
        finish(count);
        if (count && opts.onNew) opts.onNew(count);
      },
      /* 心声是附加功能，失败就静默收场——绝不能弹错打断聊天 */
      onFail: function () { finish(0); }
    }, false, { feature: 'heartbeat' });
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.heartbeat = {
    OPEN: OPEN,
    CLOSE: CLOSE,
    unreadCount: unreadCount,
    markRead: markRead,
    syncDots: syncDots,
    mountAvatar: mountAvatar,
    mountName: mountName,
    openOverlay: openOverlay,
    closeOverlay: closeOverlay,
    splitReply: splitReply,
    replySpec: replySpec,
    commit: commit,
    drop: drop,
    dropLastAfter: dropLastAfter,
    generate: generate
  };

})(window);
