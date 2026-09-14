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

  /* 空输入点发送时，替用户说的一句话。F 模块上线后由 F 接管 */
  var PROACTIVE_HINT = '（我这边安静着，没打字，你主动开口说一句吧。）';

  /* ============================ 数据层 ============================ */

  function getChats() {
    var list = store.get('chats');
    return Array.isArray(list) ? list : [];
  }

  function saveChats(list) { store.set('chats', list); }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function createChat(name) {
    var chats = getChats();
    var chat = {
      id: newId(),
      name: name || '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    chats.unshift(chat);
    saveChats(chats);
    return chat;
  }

  function getChat(id) {
    if (!id) return null;
    var chats = getChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === id) return chats[i];
    }
    return null;
  }

  /* 唯一改数据的入口：拿全列表 → 改目标对话 → 整表落盘。
     只写单条对话会把别的对话冲掉（老版本踩过这个坑）。 */
  function mutate(chatId, fn) {
    var chats = getChats();
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
  function attachText(m) {
    if (m.type === 'photo') return '[我发了一张照片：' + (m.name || '未命名') + ']';
    if (m.type === 'file') return '[我发了一个文件：' + (m.name || '未命名') + '（' + fmtBytes(m.size || 0) + '）]';
    return m.content || '';
  }

  function previewOf(msg) {
    if (!msg) return '空对话';
    if (msg.type === 'photo') return '你发了张照片';
    if (msg.type === 'file') return '你发了个文件';
    var t = String(msg.content || '').replace(/\s+/g, ' ').slice(0, 20);
    return (msg.role === 'user' ? '你说：' : '她回：') + t;
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

  /* ======================= 页面：会话列表 ======================= */

  Sleepy.register('chat-list', {
    title: '字条',
    render: function (ctx) {
      var body = ctx.body;

      var emptyWrap = h('div', 'empty');
      emptyWrap.appendChild(h('div', 'empty-paper'));
      emptyWrap.appendChild(h('p', 'empty-text', '还没有写过任何字条'));
      emptyWrap.appendChild(h('p', 'empty-hint', '点右下角的 + 新建一个对话'));
      body.appendChild(emptyWrap);

      var listWrap = h('div', 'chat-list-wrap');
      body.appendChild(listWrap);

      var fab = h('button', 'fab-btn', '+');
      fab.type = 'button';
      fab.title = '新建对话';
      fab.addEventListener('click', function () {
        var name = prompt('给这个对话起个名字？', '新对话');
        if (name === null) return;
        var chat = createChat(String(name).trim() || '新对话');
        ctx.toast('已新建 · ' + chat.name, 'ok');
        ctx.open('chat-detail', { chatId: chat.id });
      });
      body.appendChild(fab);

      function rebuild() {
        var chats = getChats();
        listWrap.innerHTML = '';
        emptyWrap.style.display = chats.length ? 'none' : 'flex';

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
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!confirm('确定删除「' + chat.name + '」？里面的聊天记录会一起没掉。')) return;
            saveChats(getChats().filter(function (c) { return c.id !== chat.id; }));
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

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

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
      ctx.setTitle(getChat(chatId).name);
      ctx.setActions([
        { label: '\u2605', onClick: function () { ctx.open('favorites'); } },
        { label: '\u2699', onClick: function () { ctx.open('settings'); } }
      ]);

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

      /* 加号在左、输入框居中、爪印在右 */
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

        c.messages.forEach(function (m) {
          msgWrap.appendChild(bubbleFor(m, c));
        });
        if (pending && !pending.targetId) msgWrap.appendChild(pendingBubble());

        if (keepScroll) msgWrap.scrollTop = prev;
        else msgWrap.scrollTop = msgWrap.scrollHeight;
      }

      function bubbleFor(msg, c) {
        var role = msg.role === 'user' ? 'user'
                 : (msg.role === 'system' ? 'system' : 'assistant');
        var bubble = h('div', 'msg-bubble msg-' + role);
        bubble.setAttribute('data-id', msg.id);

        var herePending = !!(pending && pending.targetId === msg.id);
        if (herePending) bubble.classList.add('is-pending');
        if (selecting && selected[msg.id]) bubble.classList.add('is-selected');

        if (role === 'assistant') {
          var av = h('img', 'msg-avatar');
          av.src = AVATAR;
          av.alt = '她';
          av.title = '心声';
          av.addEventListener('click', function (e) {
            e.stopPropagation();
            ctx.open('heartbeat');
          });
          bubble.appendChild(av);
        }

        /* 内容列：引用条 / 正文 / 时间都装在这里，头像才能并排在左边 */
        var content = h('div', 'msg-body');

        if (msg.quote) {
          content.appendChild(h('div', 'msg-quote',
            '引用' + (msg.quote.role === 'user' ? '我' : '她') + '：' + msg.quote.content));
        }

        if (msg.type === 'photo' || msg.type === 'file') {
          content.appendChild(attachCard(msg));
        } else {
          var textEl = h('div', 'msg-text');
          var shown = herePending ? pending.text : (msg.content || '（空）');
          if (herePending && !shown) textEl.appendChild(h('span', 'typing-dots', '···'));
          else textEl.textContent = shown;
          content.appendChild(textEl);
        }

        var meta = h('div', 'msg-meta');
        meta.appendChild(h('span', 'msg-time', timeStr(msg.timestamp)));

        var isLast = c.messages[c.messages.length - 1] === msg;
        if (herePending) {
          var stopBtn = h('button', 'msg-act', '停止');
          stopBtn.type = 'button';
          stopBtn.addEventListener('click', function (e) { e.stopPropagation(); stopReply(); });
          meta.appendChild(stopBtn);
        } else if (role === 'assistant' && !msg.type && isLast && !pending) {
          meta.appendChild(rerollBtn(msg));
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

      function attachCard(msg) {
        var card = h('div', 'msg-attach');
        card.appendChild(h('span', 'msg-attach-ic', msg.type === 'photo' ? '📷' : '📎'));
        var main = h('div', 'msg-attach-main');
        main.appendChild(h('span', 'msg-attach-name', msg.name || '未命名'));
        main.appendChild(h('span', 'msg-attach-size', fmtBytes(msg.size || 0)));
        card.appendChild(main);
        return card;
      }

      function pendingBubble() {
        var bubble = h('div', 'msg-bubble msg-assistant is-pending');

        var av = h('img', 'msg-avatar');
        av.src = AVATAR;
        av.alt = '她';
        bubble.appendChild(av);

        var content = h('div', 'msg-body');
        var textEl = h('div', 'msg-text');
        if (pending.text) textEl.textContent = pending.text;
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
           忙碌状态只加 class，靠 CSS 的呼吸动画表达「在等她回话」。 */
        sendBtn.classList[busy ? 'add' : 'remove']('is-busy');
        sendBtn.title = busy ? '还在等她回话' : '发送（输入框留空，就是让她主动开口）';
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
        del.addEventListener('click', function () {
          var ids = selectedIds();
          if (!ids.length) return;
          if (!confirm('删除这 ' + ids.length + ' 条消息？')) return;
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
          '引用' + (quote.role === 'user' ? '我' : '她') + '：' + quote.content));
        var x = h('button', 'msg-quote-x', '\u00d7');
        x.type = 'button';
        x.title = '取消引用';
        x.addEventListener('click', clearQuote);
        quoteBar.appendChild(x);
      }

      function favorite(msg) {
        var list = store.get('favorites');
        if (!Array.isArray(list)) list = [];
        var c = getChat(chatId);
        list.unshift({
          id: newId(),
          chatId: chatId,
          chatName: c ? c.name : '',
          role: msg.role,
          content: (msg.type ? attachText(msg) : (msg.content || '')),
          savedAt: Date.now()
        });
        store.set('favorites', list);
        ctx.toast('已收藏，右上角 ★ 里能查到', 'ok');
      }

      function editMsg(msg) {
        if (msg.type) {
          ctx.toast('附件气泡先不支持编辑', 'warn');
          return;
        }
        var next = prompt('编辑这条消息：', msg.content || '');
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

      function removeMsg(msg) {
        if (!confirm('删掉这条消息？')) return;
        dropMessages(chatId, [msg.id]);
        renderMessages();
        ctx.toast('已删除', 'ok');
      }

      /* ==================== 发送 / 接收 / reroll ==================== */

      function buildMessages(opts) {
        opts = opts || {};
        var c = getChat(chatId);
        if (!c) return [];

        var limit = store.get('chatDefaults.contextMessages') || 20;
        var out = [];

        c.messages.forEach(function (m) {
          if (opts.excludeId && m.id === opts.excludeId) return;
          if (m.role !== 'user' && m.role !== 'assistant') return;

          var text = m.type ? attachText(m) : (m.content || '');
          if (!text) return;
          if (m.quote) {
            text = '（引用' + (m.quote.role === 'user' ? '我自己' : '你') +
                   '刚说的：“' + m.quote.content + '”）\n' + text;
          }
          out.push({ role: m.role, content: text });
        });

        if (limit > 0 && out.length > limit) out = out.slice(-limit);

        if (opts.note) {
          out.push({
            role: 'user',
            content: '（请按这个要求重新说一遍上一条回复：' + opts.note + '）'
          });
        }
        if (opts.proactive) out.push({ role: 'user', content: PROACTIVE_HINT });
        return out;
      }

      function requestReply(opts) {
        opts = opts || {};
        if (pending) { ctx.toast('还在等她回话', 'warn'); return; }

        var msgs = buildMessages(opts);
        if (!msgs.length) { ctx.toast('还没有可以接的话', 'warn'); return; }

        var mySeq = ++reqSeq;
        pending = { text: '', timestamp: Date.now(), targetId: opts.targetId || null };
        renderMessages();
        updateSendUI();

        var useStream = store.get('chatDefaults.stream') !== false;

        handle = api.runChat(msgs, {
          onDelta: function (delta) {
            if (mySeq !== reqSeq) return;
            pending.text += delta;
            renderMessages();
          },
          onDone: function (cand, text) {
            if (mySeq !== reqSeq) return;
            var finalText = String(text || '').trim();
            var target = pending ? pending.targetId : null;
            pending = null;
            handle = null;

            if (!finalText) {
              ctx.toast('她这次没出声，要不再试一次？', 'warn');
              renderMessages();
              updateSendUI();
              return;
            }
            if (target) patchMessage(chatId, target, { content: finalText, timestamp: Date.now() });
            else addMessage(chatId, {
              id: newId(),
              role: 'assistant',
              content: finalText,
              timestamp: Date.now()
            });
            renderMessages();
            updateSendUI();
          },
          /* 注意：runChat 暴露的是 onFail（全部候选都失败 / 一个候选都没有），
             不是 onError。写成 onError 的话没有任何回调会被触发，
             发送键会永久卡在禁用状态。api.js 头部的契约注释里写的就是 onFail。 */
          onFail: function (list, err) {
            if (mySeq !== reqSeq) return;
            pending = null;
            handle = null;
            var why = (err && err.error) ? err.error : '请求失败，检查一下网络或 API 配置';
            ctx.toast('❌ ' + why, 'err');
            renderMessages();
            updateSendUI();
          }
        }, useStream);
      }

      function stopReply() {
        if (!pending) return;
        var partial = String(pending.text || '').trim();
        var target = pending.targetId;

        reqSeq++;                       /* 让在途回调统统失效 */
        if (handle) { try { handle.abort(); } catch (e) { /* 忽略 */ } }
        handle = null;
        pending = null;

        if (partial) {
          if (target) patchMessage(chatId, target, { content: partial, timestamp: Date.now() });
          else addMessage(chatId, {
            id: newId(),
            role: 'assistant',
            content: partial,
            timestamp: Date.now()
          });
        } else if (target) {
          patchMessage(chatId, target, { content: '（这条被停掉了）' });
        }

        renderMessages();
        updateSendUI();
        ctx.toast('已停止', 'ok');
      }

      function startReroll(msg) {
        if (pending) { ctx.toast('还在等她回话', 'warn'); return; }
        var reason = prompt('想让她怎么改？留空就是直接重说一遍。', '');
        if (reason === null) return;
        var note = String(reason).trim();

        patchMessage(chatId, msg.id, { content: '' });
        requestReply({ excludeId: msg.id, targetId: msg.id, note: note });
      }

      function doSend() {
        if (pending) { ctx.toast('还在等她回话', 'warn'); return; }

        var content = textarea.value.trim();

        /* D1：输入框空着点发送 = 让她主动开口说话，而不是发一个空气泡 */
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
          addMessage(chatId, {
            id: newId(),
            role: 'user',
            type: kind,
            name: f.name,
            size: f.size,
            mime: f.type || '',
            content: (kind === 'photo' ? '[照片] ' : '[文件] ') + f.name,
            timestamp: Date.now()
          });
          closePanel();
          renderMessages();
          ctx.toast(kind === 'photo' ? '照片发出去了' : '文件发出去了', 'ok');
        });
        document.body.appendChild(input);
        input.click();
      }

      var PLUS_ITEMS = [
        { id: 'photo', ic: '📷', name: '发照片', run: function () { pickAttachment('image/*', 'photo'); } },
        { id: 'file', ic: '📎', name: '发文件', run: function () { pickAttachment('', 'file'); } },
        { id: 'transfer', ic: '💰', name: '转账' },
        { id: 'pat', ic: '👋', name: '拍一拍' },
        { id: 'genimg', ic: '🎨', name: '生图' },
        { id: 'checkin', ic: '📍', name: '查岗' },
        { id: 'diary', ic: '📓', name: '日记' },
        { id: 'sticker', ic: '😄', name: '表情包' }
      ];

      function buildPanel() {
        panel.innerHTML = '';
        PLUS_ITEMS.forEach(function (it) {
          var b = h('button', 'plus-item' + (it.run ? '' : ' is-soon'));
          b.type = 'button';
          b.setAttribute('data-id', it.id);
          b.appendChild(h('span', 'plus-ic', it.ic));
          b.appendChild(h('span', 'plus-name', it.name));
          b.addEventListener('click', function () {
            if (!it.run) {
              ctx.toast(it.name + ' 留到软装阶段再做', 'warn');
              return;
            }
            it.run();
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
      textarea.addEventListener('input', autoGrow);

      /* ======================== 收尾 ======================== */

      renderQuote();
      updateSendUI();
      autoGrow();
      renderMessages();

      ctx.reload = function () {
        var c = getChat(chatId);
        if (!c) { ctx.back(); return; }
        ctx.setTitle(c.name);
        autoGrow();          /* 这时候才真的挂进文档，高度算得准 */
        renderMessages();
      };
    },
    onShow: function (ctx) { if (ctx.reload) ctx.reload(); },
    onHide: function (ctx) {
      /* 离开页面时把菜单收掉，免得回来还开着 */
      if (ctx.el) {
        var m = ctx.el.querySelector('.msg-menu.is-open');
        var k = ctx.el.querySelector('.msg-menu-mask.is-open');
        if (m) m.classList.remove('is-open');
        if (k) k.classList.remove('is-open');
      }
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
        var list = store.get('favorites');
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

})(window);
