/* ============================================================
   page-heartbeat.js — 模块 E：心声
   依赖：store.js、ui.js、api.js；数据层用 Sleepy.chatStore（page-chat.js 暴露）
   对应施工卡：
     E1 头像「未读心声」状态位 + 呼吸光点动画
     E2 心声内容独立渲染层（点头像弹出，不与普通消息气泡共用组件）

   心声怎么来的（v2：跟着主回复一起出，不额外占一次生成）
     不再「回复落地后再发一次请求」，而是在同一个请求里加一条系统指令，
     要求模型把心声用 <心声>…</心声> 包在回复末尾。前端在流式过程中就把
     这段切出来：正文进气泡，心声进心声池。
     好处：生成额度不翻倍、延迟不增加、心声和这一轮回复必然对应。
     代价：依赖模型听话。所以 splitReply() 对「半个标签」做了保护，
           拿不到标签也只是没有新心声，绝不影响正文。

   为什么是「弹出层」而不是一个页面：
     施工卡写的是「点头像弹出」，验收要求「弹出的展示层与普通聊天气泡在
     视觉上明显区分」。做成独立页面的话，点一下要经历整页切换动画，
     和「瞥一眼她没说出口的话」这个动作不搭。

   为什么挂「顶部头像」来显示未读：
     气泡头像会随消息列表滚走，未读光点经常看不见。顶部头像固定可见。
     气泡头像仍可点（同样打开浮层），只是不挂光点，避免一屏两个跳动的小点。

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

  /* 标记用中文尖括号而不是 <!-- 之类，模型照抄的意愿更高，也不容易和
     正常对话里的英文尖括号撞车 */
  var OPEN = '<心声>';
  var CLOSE = '</心声>';

  /* 手动按钮那一路会按对话 id 去重，避免连点堆请求 */
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
      visible = (rest.replace(CLOSE, '')).trim();
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
    return out.slice(0, n || 4);
  }

  /* 把一段心声原文入库。返回收了几条 */
  function commit(chatId, rawBeat) {
    var cs = chatStore();
    if (!cs || !chatId) return 0;
    var cfg = store.get('chatDefaults') || {};
    var n = Math.max(1, Math.min(4, cfg.heartbeatCount || 2));
    var items = parseLines(rawBeat, n);
    if (!items.length) return 0;

    cs.mutate(chatId, function (c) {
      if (!Array.isArray(c.heartbeats)) c.heartbeats = [];
      items.forEach(function (t) {
        c.heartbeats.push({ id: newId(), text: t, at: Date.now(), read: false });
      });
    });
    syncDots(chatId);
    return items.length;
  }

  /* 给 buildMessages 用的系统指令。放在消息数组最前面。
     写得尽量短——它是每次请求都要付钱的输入 token。 */
  function replySpec(count) {
    return [
      '【输出格式】正文写完后，另起一行，用 ' + OPEN + ' 和 ' + CLOSE +
        ' 包住她没说出口的心里话。',
      '心声写 1~' + count + ' 行，每行不超过 25 字；只写她此刻的内心活动和感受，',
      '不是对别人说话、不出现称呼，不复述正文，不提问，不讲道理。',
      '实在没有就整段省略。',
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
    img.alt = '她';
    img.title = '看她没说出口的话';

    slot.appendChild(img);
    slot.appendChild(h('span', 'hb-dot'));

    slot.addEventListener('click', function (e) {
      e.stopPropagation();
      openOverlay(ctx, chatId);
    });

    setTimeout(function () { syncDots(chatId); }, 0);
    return slot;
  }

  /* ------------------------ E2 独立渲染层 ------------------------ */
  /* 挂在 ctx 上复用，一个页面只建一次 */
  function ensureOverlay(ctx) {
    if (ctx.__hb) return ctx.__hb;

    var mask = h('div', 'hb-mask');
    var sheet = h('div', 'hb-panel');

    var head = h('div', 'hb-head');
    var titles = h('div', 'hb-titles');
    var title = h('p', 'hb-title', '心声');
    var sub = h('p', 'hb-sub', '');
    titles.appendChild(title);
    titles.appendChild(sub);
    var close = h('button', 'hb-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(titles);
    head.appendChild(close);

    var list = h('div', 'hb-list');

    var foot = h('div', 'hb-foot');
    var ask = button('现在想一条', 'ghost', function () {
      ask.disabled = true;
      ask.textContent = '她正在想…';
      var cid = ctx.params && ctx.params.chatId;
      generate(cid, {
        onSettled: function () {
          ask.disabled = false;
          ask.textContent = '现在想一条';
        },
        onNew: function () {
          /* 用户正盯着面板看，新生成的就直接算已读，
             否则关掉面板会发现光点又亮了，很奇怪 */
          markRead(cid);
          syncDots(cid);
          render(ctx, cid);
        }
      });
    });

    var autoToggle = h('label', 'hb-auto');
    var autoBox = h('input');
    autoBox.type = 'checkbox';
    autoToggle.title = '让模型在每次回复末尾顺带写一段心声（不额外消耗一次请求）';
    autoToggle.appendChild(autoBox);
    autoToggle.appendChild(h('span', 'hb-auto-text', '回复时附带'));
    autoBox.addEventListener('change', function () {
      store.set('chatDefaults.heartbeatAuto', autoBox.checked);
    });

    foot.appendChild(ask);
    foot.appendChild(autoToggle);

    sheet.appendChild(head);
    sheet.appendChild(list);
    sheet.appendChild(foot);
    ctx.body.appendChild(mask);
    ctx.body.appendChild(sheet);

    mask.addEventListener('click', function () { closeOverlay(ctx); });
    close.addEventListener('click', function () { closeOverlay(ctx); });

    ctx.__hb = {
      mask: mask,
      sheet: sheet,
      sub: sub,
      list: list,
      autoBox: autoBox
    };
    return ctx.__hb;
  }

  function render(ctx, chatId) {
    var cs = chatStore();
    if (!cs) return;
    var box = ensureOverlay(ctx);
    var chat = cs.getChat(chatId);
    var items = listOf(chat).slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });

    box.list.innerHTML = '';

    if (!items.length) {
      var empty = h('div', 'hb-empty');
      empty.appendChild(h('p', 'hb-empty-text', '她还没在心里留下什么'));
      empty.appendChild(h('p', 'hb-empty-hint', '再聊几句就有了'));
      box.list.appendChild(empty);
    } else {
      items.forEach(function (item) {
        var note = h('div', 'hb-note');
        note.appendChild(h('p', 'hb-note-text', item.text));
        note.appendChild(h('p', 'hb-note-time', relativeTime(item.at)));
        box.list.appendChild(note);
      });
    }

    var cfg = store.get('chatDefaults') || {};
    box.sub.textContent = items.length ? ('一共 ' + items.length + ' 条') : '她没说出口的话';
    box.autoBox.checked = cfg.heartbeatAuto !== false;
  }

  function openOverlay(ctx, chatId) {
    var box = ensureOverlay(ctx);
    render(ctx, chatId);
    /* 看过就算读过 —— 光点在这里消失 */
    markRead(chatId);
    syncDots(chatId);
    box.mask.classList.add('is-open');
    box.sheet.classList.add('is-open');
  }

  function closeOverlay(ctx) {
    if (!ctx.__hb) return;
    ctx.__hb.mask.classList.remove('is-open');
    ctx.__hb.sheet.classList.remove('is-open');
  }

  /* ============ 手动补一条（自带一次小请求，跟主回复无关） ============ */

  function manualPrompt(n) {
    return [
      '你在为角色生成「心声」——她没说出口的心里话。',
      '',
      '要求：',
      '1. 只写她此刻的内心活动和感受；不是在对别人说话，不要出现任何称呼。',
      '2. 每条不超过 25 个字，写 ' + n + ' 条，一行一条。',
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

    var cfg = store.get('chatDefaults') || {};
    var n = Math.max(1, Math.min(4, cfg.heartbeatCount || 2));
    var limit = cfg.contextMessages || 20;

    var context = [];
    (chat.messages || []).forEach(function (m) {
      if (m.role !== 'user' && m.role !== 'assistant') return;
      var t = String(m.content || '').trim();
      if (t) context.push({ role: m.role, content: t });
    });

    var msgs = [{ role: 'system', content: manualPrompt(n) }].concat(context);
    if (msgs.length < 2) { if (opts.onSettled) opts.onSettled(0); return; }

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
    }, false);
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.heartbeat = {
    OPEN: OPEN,
    CLOSE: CLOSE,
    unreadCount: unreadCount,
    markRead: markRead,
    syncDots: syncDots,
    mountAvatar: mountAvatar,
    openOverlay: openOverlay,
    closeOverlay: closeOverlay,
    splitReply: splitReply,
    replySpec: replySpec,
    commit: commit,
    generate: generate
  };

})(window);
