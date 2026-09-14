/* ============================================================
   page-chat.js — 聊天核心 v0
   依赖：store.js、ui.js、app.js（必须在它们之后加载）
   覆盖 ROADMAP：3.1 会话列表 · 3.2 聊天页 UI · 3.3 发文字收文字（首条里程碑）
   页面：chat-list → chat-detail

   数据结构约定：
     chats: [{ id, name, createdAt, updatedAt, messages: [...] }]
     message: { id, role: 'user' | 'assistant', content, timestamp }
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var setRowValue = ui.setRowValue;
  var textField = ui.textField;
  var button = ui.button;
  var fmtBytes = ui.fmtBytes;
  var api = Sleepy.api;

  /* 模块级流式状态：聊天页任何一屏都能中止，离开页面也能收场 */
  var streaming = false;
  var activeHandle = null;

  /* ---------------------------- 数据层 ---------------------------- */

  function getChats() {
    var list = store.get('chats');
    if (!Array.isArray(list)) return [];
    return list;
  }

  function saveChats(chats) {
    store.set('chats', chats);
  }

  function createChat(name) {
    var chats = getChats();
    var chat = {
      id: String(Date.now()),
      name: name || '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    chats.unshift(chat);
    saveChats(chats);
    return chat;
  }

  function getChat(chatId) {
    var chats = getChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === chatId) return chats[i];
    }
    return null;
  }

  function updateChat(chatId, updates) {
    var chats = getChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === chatId) {
        Object.assign(chats[i], updates);
        chats[i].updatedAt = Date.now();
        saveChats(chats);
        return chats[i];
      }
    }
    return null;
  }

  function deleteChat(chatId) {
    var chats = getChats();
    var idx = -1;
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === chatId) { idx = i; break; }
    }
    if (idx >= 0) {
      chats.splice(idx, 1);
      saveChats(chats);
      return true;
    }
    return false;
  }

  function addMessage(chatId, msg) {
    var chats = getChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === chatId) {
        chats[i].messages.push(msg);
        chats[i].updatedAt = Date.now();
        saveChats(chats);   /* 保存全列表；原版 saveChats([chat]) 会把其他对话冲掉 */
        return msg;
      }
    }
    return null;
  }

  /* ---------------------------- 时间格式化 ---------------------------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function timeStr(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dateStr(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function relativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    return dateStr(ts);
  }

  /* ======================= 页面：会话列表 ======================= */

  Sleepy.register('chat-list', {
    title: '字条',
    render: function (ctx) {
      var body = ctx.body;
      var self = this;

      /* 空状态 */
      var emptyWrap = h('div', 'empty');
      emptyWrap.appendChild(h('div', 'empty-paper'));
      emptyWrap.appendChild(h('p', 'empty-text', '还没有写过任何字条'));
      emptyWrap.appendChild(h('p', 'empty-hint', '点击下方 + 新建一个对话'));
      body.appendChild(emptyWrap);

      /* 列表容器 */
      var listWrap = h('div', 'chat-list-wrap');
      body.appendChild(listWrap);

      /* FAB 新建按钮 */
      var fab = h('button', 'fab-btn');
      fab.type = 'button';
      fab.innerHTML = '+';
      fab.addEventListener('click', function () {
        var name = prompt('给新对话起个名字？');
        if (name && name.trim()) {
          var chat = createChat(name.trim());
          ctx.toast('已新建 · ' + chat.name, 'ok');
          ctx.open('chat-detail', { chatId: chat.id });
        }
      });
      body.appendChild(fab);

      ctx.refreshList = function () {
        var chats = getChats();
        listWrap.innerHTML = '';
        emptyWrap.style.display = chats.length ? 'none' : 'flex';

        if (chats.length === 0) return;

        chats.forEach(function (chat) {
          var item = h('div', 'chat-item');
          item.setAttribute('data-id', chat.id);

          var main = h('div', 'chat-item-main');
          var nameEl = h('span', 'chat-item-name');
          nameEl.textContent = chat.name;
          main.appendChild(nameEl);

          var meta = h('div', 'chat-item-meta');
          var timeEl = h('span', 'chat-item-time');
          timeEl.textContent = relativeTime(chat.updatedAt);
          meta.appendChild(timeEl);

          var lastMsg = chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null;
          if (lastMsg) {
            var preview = h('span', 'chat-item-preview');
            preview.textContent = lastMsg.role === 'user' ? '你说：' + lastMsg.content.slice(0, 20) : '她回：' + lastMsg.content.slice(0, 20);
            meta.appendChild(preview);
          } else {
            var preview = h('span', 'chat-item-preview');
            preview.textContent = '空对话';
            meta.appendChild(preview);
          }
          main.appendChild(meta);
          item.appendChild(main);

          /* 左滑删除 */
          var delBtn = h('button', 'chat-item-del');
          delBtn.type = 'button';
          delBtn.textContent = '删';
          delBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (confirm('确定要删除 "' + chat.name + '" 吗？')) {
              deleteChat(chat.id);
              self.refreshList();
              ctx.toast('已删除', 'ok');
            }
          });
          item.appendChild(delBtn);

          item.addEventListener('click', function () {
            ctx.open('chat-detail', { chatId: chat.id });
          });

          listWrap.appendChild(item);
        });
      };

      self.refreshList();
    },
    onShow: function (ctx) {
      if (ctx.refreshList) ctx.refreshList();
    }
  });

  /* ======================= 页面：聊天详情 ======================= */

  Sleepy.register('chat-detail', {
    title: '聊天',
    render: function (ctx) {
      var body = ctx.body;
      /* ======================= 顶部导航栏（MVP） ======================= */
      var navBar = h('div', 'nav-bar');
      
      // 返回按钮
      var backBtn = h('button', 'nav-back', '←');
      backBtn.type = 'button';
      backBtn.addEventListener('click', function () { ctx.back(); });
      
      // 头像（点击跳转朋友圈）
      var avatarImg = h('img', 'nav-avatar');
      avatarImg.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%237A5C4A'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
      avatarImg.alt = '她';
      avatarImg.title = '朋友圈';
      avatarImg.addEventListener('click', function () { ctx.open('moments'); });
      
      // 右侧动作组
      var actions = h('div', 'nav-actions');
      
      // 设置按钮
      var settingsBtn = h('button', 'nav-action', '⚙️');
      settingsBtn.type = 'button';
      settingsBtn.title = '设置';
      settingsBtn.addEventListener('click', function () { ctx.open('settings'); });
      
      // 搜索按钮（精致小标）
      var searchBtn = h('button', 'nav-action');
      searchBtn.type = 'button';
      searchBtn.title = '搜索聊天记录';
      searchBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#7A5C4A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      searchBtn.addEventListener('click', function () {
        // 展开内嵌搜索栏
        var searchWrap = h('div', 'search-bar-wrap');
        searchWrap.style.cssText = 'position:absolute;top:52px;right:12px;left:12px;display:flex;gap:8px;align-items:center;padding:8px;background:rgba(255,255,255,0.95);border-radius:10px;border:1px solid rgba(214,199,172,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.08);z-index:12;';
        
        var searchInput = h('input', 'search-input');
        searchInput.type = 'text';
        searchInput.placeholder = '搜索聊天记录…';
        searchInput.style.cssText = 'flex:1;border:1px solid #D6C7AC;border-radius:6px;padding:6px 10px;font-size:14px;outline:none;';
        searchInput.style.cssText = 'flex:1;border:1px solid #D6C7AC;border-radius:6px;padding:6px 10px;font-size:14px;outline:none;';
        
        // 实时搜索 + 结果渲染
        var resultsWrap = h('div', 'search-results');
        resultsWrap.style.cssText = 'max-height:300px;overflow-y:auto;margin-top:8px;background:white;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.08);display:none;';
        searchWrap.appendChild(resultsWrap);
        
        function highlight(text, keyword) {
          if (!keyword) return text;
          var regex = new RegExp('(' + keyword.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&') + ')', 'gi');
          return text.replace(regex, '<mark>$1</mark>');
        }
        
        function performSearch(keyword) {
          if (!keyword.trim()) {
            resultsWrap.style.display = 'none';
            return;
          }
          
          var matches = [];
          chat.messages.forEach(function (msg, idx) {
            if (msg.content && msg.content.toLowerCase().includes(keyword.toLowerCase())) {
              matches.push({ msg: msg, idx: idx });
            }
          });
          
          resultsWrap.innerHTML = '';
          if (matches.length === 0) {
            resultsWrap.style.display = 'block';
            resultsWrap.innerHTML = '<div class="search-result-empty">没有找到相关消息</div>';
            return;
          }
          
          resultsWrap.style.display = 'block';
          matches.forEach(function (item) {
            var resultItem = h('div', 'search-result-item');
            var preview = h('div', 'search-result-preview');
            preview.innerHTML = highlight(item.msg.content.slice(0, 50), keyword);
            var meta = h('div', 'search-result-meta');
            meta.textContent = timeStr(item.msg.timestamp);
            var jumpBtn = h('button', 'search-result-jump');
            jumpBtn.textContent = '跳转';
            jumpBtn.addEventListener('click', function () {
              var bubbles = msgWrap.querySelectorAll('.msg-bubble');
              if (bubbles[item.idx]) {
                bubbles[item.idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
                bubbles[item.idx].style.backgroundColor = 'rgba(255,255,0,0.2)';
                setTimeout(function () { bubbles[item.idx].style.backgroundColor = ''; }, 1500);
              }
              searchWrap.remove();
            });
            resultItem.appendChild(preview);
            resultItem.appendChild(meta);
            resultItem.appendChild(jumpBtn);
            resultsWrap.appendChild(resultItem);
          });
        }
        
        searchInput.addEventListener('input', function (e) {
          performSearch(e.target.value);
        });
        
        searchInput.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            searchWrap.remove();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            // 回车不关闭，保持结果可见
          }
        });
        
        var closeBtn = h('button', 'search-close');
        closeBtn.type = 'button';
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = 'background:transparent;border:none;font-size:18px;color:#7A5C4A;cursor:pointer;padding:0 4px;';
        closeBtn.addEventListener('click', function () { searchWrap.remove(); });
        
        searchWrap.appendChild(searchInput);
        searchWrap.appendChild(closeBtn);
        body.appendChild(searchWrap);
        searchInput.focus();
      });
      
      actions.appendChild(settingsBtn);
      actions.appendChild(searchBtn);
      
      navBar.appendChild(backBtn);
      navBar.appendChild(avatarImg);
      navBar.appendChild(actions);
      body.insertBefore(navBar, body.firstChild);
      var params = ctx.params;
      var chatId = params.chatId;
      var chat = getChat(chatId);

      if (!chat) {
        ctx.toast('找不到该对话', 'err');
        ctx.back();
        return;
      }

      ctx.setTitle(chat.name);

      /* 消息容器 */
      var msgWrap = h('div', 'msg-wrap');
      body.appendChild(msgWrap);

      /* 输入区域 */
      var inputArea = h('div', 'input-area');
      var textarea = h('textarea', 'chat-input');
      textarea.placeholder = '写下你想说的话…';
      textarea.rows = 3;
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('spellcheck', 'false');

      var sendBtn = h('button', 'send-btn', '发');
      sendBtn.type = 'button';

      inputArea.appendChild(textarea);
      inputArea.appendChild(sendBtn);
      body.appendChild(inputArea);

      /* 渲染状态：pending 是正在等的回复，不落盘，离开即消失 */
      var pendingMsg = null;
      var reqHandle = null;

      /* 统一改数据：拿全列表→改目标对话→落盘。避免再次出现"只存单条" */
      function mutateChat(fn) {
        var chats = getChats();
        var c = null;
        for (var i = 0; i < chats.length; i++) {
          if (chats[i].id === chatId) { c = chats[i]; break; }
        }
        if (!c) return false;
        fn(c);
        saveChats(chats);
        chat = c;
        return true;
      }

      function cancelReq() {
        if (reqHandle) { try { reqHandle.abort(); } catch (e) {} }
        reqHandle = null;
        pendingMsg = null;
        streaming = false;
        renderMessages();
        updateSendUI();
      }

      function renderMessages() {
        msgWrap.innerHTML = '';
        chat.messages.forEach(function (msg, idx) {
          appendBubble(msg, msg.role === 'assistant' ? [regenerateBtn(idx)] : null);
        });
        if (pendingMsg) appendPending();
        msgWrap.scrollTop = msgWrap.scrollHeight;
      }

      function appendBubble(msg, actions) {
        var bubble = h('div', 'msg-bubble ' + (msg.role === 'user' ? 'msg-user' : 'msg-assistant'));
        // 消息复制功能
        bubble.addEventListener('click', function () {
          if (msg.content) {
            navigator.clipboard.writeText(msg.content.slice(0, 120)).then(function () {
              ctx.toast('已复制：' + msg.content.slice(0, 20) + '...', 'ok');
            }, function () {
              ctx.toast('复制失败，请检查浏览器权限', 'err');
            });
          }
        var text = h('div', 'msg-text');
        text.textContent = msg.content || '（空）';
        
        // Char 头像（点击跳转心声）
        if (msg.role === 'assistant') {
          var avatar = h('img', 'msg-avatar');
          avatar.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%237A5C4A'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
          avatar.alt = '她';
          avatar.title = '心声';
          avatar.addEventListener('click', function () { ctx.open('heartbeat'); });
          bubble.insertBefore(avatar, text);
        }
        
        bubble.appendChild(text);
        // 长按菜单升级 v0.2
        var longPressTimer = null;
        var isSelecting = false;
        var selectedMessages = [];

        function updateSelectionUI() {
          if (selectedMessages.length === 0) {
            meta.innerHTML = '';
            meta.appendChild(h('span', 'msg-time', timeStr(msg.timestamp)));
            return;
          }
          var selectBar = h('div', 'msg-select-bar');
          selectBar.innerHTML = '<span>' + selectedMessages.length + ' 条已选</span>' +
            '<button class="msg-act" title="取消选择">×</button>' +
            '<button class="msg-act" title="批量删除">🗑️</button>' +
            '<button class="msg-act" title="批量转发">📤</button>';
          selectBar.querySelector('button[title="取消选择"]').addEventListener('click', function () {
            selectedMessages.forEach(m => m.selected = false);
            selectedMessages = [];
            updateSelectionUI();
            renderMessages();
          });
          selectBar.querySelector('button[title="批量删除"]').addEventListener('click', function () {
            if (confirm('确定要删除这 ' + selectedMessages.length + ' 条消息吗？')) {
              selectedMessages.forEach(m => deleteMessage(chatId, m.id));
              selectedMessages = [];
              renderMessages();
            }
          });
          selectBar.querySelector('button[title="批量转发"]').addEventListener('click', function () {
            ctx.toast('已转发 ' + selectedMessages.length + ' 条消息', 'ok');
            selectedMessages = [];
            updateSelectionUI();
          });
          meta.innerHTML = '';
          meta.appendChild(selectBar);
        }

        // 左滑引用检测
        var startX = 0;
        bubble.addEventListener('touchstart', function (e) {
          startX = e.touches[0].clientX;
          longPressTimer = setTimeout(function () {
            // 长按菜单
            isSelecting = true;
            msg.selected = !msg.selected;
            if (msg.selected && !selectedMessages.includes(msg)) {
              selectedMessages.push(msg);
            } else if (!msg.selected && selectedMessages.includes(msg)) {
              selectedMessages = selectedMessages.filter(m => m !== msg);
            }
            updateSelectionUI();
          }, 500);
        });

        bubble.addEventListener('touchmove', function (e) {

      /* ======================= 转账功能（真实） ======================= */
      function showTransferDialog() {
        var dialog = h('div', 'transfer-dialog');
        dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:20;width:80%;max-width:300px;';
        
        var title = h('h3', 'transfer-title', '转账');
        
        var amountLabel = h('label', 'transfer-label', '金额（元）：');
        var amountInput = h('input', 'transfer-input');
        amountInput.type = 'number';
        amountInput.placeholder = '0.00';
        amountInput.min = '0.01';
        amountInput.step = '0.01';
        
        var noteLabel = h('label', 'transfer-label', '备注（可选）：');
        var noteInput = h('textarea', 'transfer-textarea');
        noteInput.placeholder = '说点什么…';
        noteInput.rows = 2;
        
        var btnWrap = h('div', 'transfer-btns');
        var cancelBtn = h('button', 'transfer-btn transfer-cancel', '取消');
        var confirmBtn = h('button', 'transfer-btn transfer-confirm', '确认转账');
        
        cancelBtn.addEventListener('click', function () { document.body.removeChild(dialog); });
        confirmBtn.addEventListener('click', function () {
          var amount = parseFloat(amountInput.value);
          if (isNaN(amount) || amount < 0.01) {
            ctx.toast('请输入有效金额', 'err');
            return;
          }
          var note = noteInput.value.trim();
          var content = '你向她转账 ' + amount.toFixed(2) + ' 元' + (note ? '（备注：' + note + '）' : '');
          var systemMsg = {
            id: String(Date.now()),
            role: 'system',
            content: content,
            timestamp: Date.now()
          };
          addMessage(chatId, systemMsg);
          renderMessages();
          document.body.removeChild(dialog);
          ctx.toast('转账成功', 'ok');
        });
        
        btnWrap.appendChild(cancelBtn);
        btnWrap.appendChild(confirmBtn);
        
        dialog.appendChild(title);
        dialog.appendChild(amountLabel);
        dialog.appendChild(amountInput);
        dialog.appendChild(noteLabel);
        dialog.appendChild(noteInput);
        dialog.appendChild(btnWrap);
        
        document.body.appendChild(dialog);
        amountInput.focus();
      }
      
      // 注册到加号面板
      panelActions.find(a => a.id === 'transfer').handler = showTransferDialog;
          if (longPressTimer && !isSelecting) {

      /* ======================= 拍一拍功能（真实） ======================= */
      function doPat(customText) {
        var text = customText || '你拍了拍她';
        var systemMsg = {
          id: String(Date.now()),
          role: 'system',
          content: text,
          timestamp: Date.now()
        };
        addMessage(chatId, systemMsg);
        renderMessages();
        ctx.toast('拍一拍发送成功', 'ok');
      }
      
      // 注册双击事件到顶部头像
      avatarImg.addEventListener('dblclick', function () { doPat(); });
      
      // 注册双击事件到气泡头像（需在 appendBubble 中动态绑定）
      // 已在 appendBubble 中通过 onclick 绑定，此处追加 dblclick
      
      // 注册到加号面板
      panelActions.find(a => a.id === 'pat').handler = function () {
        var custom = prompt('自定义拍一拍文案（可选）：', '你拍了拍她的肩膀');
        if (custom !== null) {
          doPat(custom.trim() || '你拍了拍她');
        }
      };
            var dx = e.touches[0].clientX - startX;

      /* ======================= 发文件功能（真实） ======================= */
      function showFilePicker() {
        var input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        input.onchange = function (e) {
          var file = e.target.files[0];
          if (!file) return;
          
          var fileMsg = {
            id: String(Date.now()),
            role: 'user',
            type: 'file',
            name: file.name,
            size: file.size,
            timestamp: Date.now()
          };
          addMessage(chatId, fileMsg);
          renderMessages();
          ctx.toast('文件已发送', 'ok');
        };
        document.body.appendChild(input);
        input.click();
        setTimeout(function () { document.body.removeChild(input); }, 100);
      }
      
      // 注册到加号面板
      panelActions.find(a => a.id === 'file').handler = showFilePicker;
            if (dx < -20) { // 左滑 >20px

      /* ======================= 相册功能（真实） ======================= */
      function showPhotoAlbum() {
        var album = h('div', 'photo-album');
        album.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:25;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
        
        var title = h('h3', 'album-title', '选择照片');
        title.style.cssText = 'color:white;margin-bottom:20px;font-size:18px;';
        
        var grid = h('div', 'album-grid');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3, 1fr);gap:10px;max-width:400px;width:100%;';
        
        // Mock 图片数据
        var mockImages = [
          'https://via.placeholder.com/300/FFB6C1/FFFFFF?text=IMG+1',
          'https://via.placeholder.com/300/98FB98/FFFFFF?text=IMG+2',
          'https://via.placeholder.com/300/87CEFA/FFFFFF?text=IMG+3',
          'https://via.placeholder.com/300/FFD700/FFFFFF?text=IMG+4',
          'https://via.placeholder.com/300/FF6347/FFFFFF?text=IMG+5',
          'https://via.placeholder.com/300/BA55D3/FFFFFF?text=IMG+6',
          'https://via.placeholder.com/300/20B2AA/FFFFFF?text=IMG+7',
          'https://via.placeholder.com/300/FF69B4/FFFFFF?text=IMG+8',
          'https://via.placeholder.com/300/7B68EE/FFFFFF?text=IMG+9'
        ];
        
        mockImages.forEach(function (url) {
          var img = h('img', 'album-item');
          img.src = url;
          img.style.cssText = 'width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;cursor:pointer;';
          img.addEventListener('click', function () {
            var imageMsg = {
              id: String(Date.now()),
              role: 'user',
              type: 'image',
              url: url,
              thumbnail: url.replace('300', '100'),
              timestamp: Date.now()
            };
            addMessage(chatId, imageMsg);
            renderMessages();
            document.body.removeChild(album);
            ctx.toast('图片已发送', 'ok');
          });
          grid.appendChild(img);
        });
        
        var closeBtn = h('button', 'album-close');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'position:absolute;top:20px;right:20px;background:transparent;border:none;color:white;font-size:24px;cursor:pointer;';
        closeBtn.addEventListener('click', function () { document.body.removeChild(album); });
        
        album.appendChild(closeBtn);
        album.appendChild(title);
        album.appendChild(grid);
        document.body.appendChild(album);
      }
      
      // 注册到加号面板
      panelActions.find(a => a.id === 'photo').handler = showPhotoAlbum;
              clearTimeout(longPressTimer);

      /* ======================= 日记功能（定时 + 立即） ======================= */
      function showDiaryDialog() {
        var dialog = h('div', 'diary-dialog');
        dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:20;width:80%;max-width:300px;';
        
        var title = h('h3', 'diary-title', '写日记');
        var textArea = h('textarea', 'diary-input');
        textArea.placeholder = '今天发生了什么…';
        textArea.rows = 4;
        
        var nowBtn = h('button', 'diary-btn diary-now', '现在写');
        var laterBtn = h('button', 'diary-btn diary-later', '定时写');
        var cancelBtn = h('button', 'diary-btn diary-cancel', '取消');
        
        // 处理立即写
        nowBtn.addEventListener('click', function () {
          var content = textArea.value.trim();
          if (content) {
            var diaryMsg = {
              id: String(Date.now()),
              role: 'system',
              type: 'diary',
              content: content,
              timestamp: Date.now(),
              status: 'written'
            };
            addMessage(chatId, diaryMsg);
            renderMessages();
            store.set('diaries', (store.get('diaries') || []).concat(diaryMsg));
            document.body.removeChild(dialog);
            ctx.toast('日记已记录', 'ok');
          } else {
            ctx.toast('日记内容不能为空', 'err');
          }
        });
        
        // 处理定时写
        laterBtn.addEventListener('click', function () {
          var content = textArea.value.trim();
          if (!content) {
            ctx.toast('请先输入日记内容', 'err');
            return;
          }
          
          var times = ['明天早上', '下午茶时间', '晚上睡前'];
          var selectedTime = prompt('选择定时时间：\n' + times.join('\n'), '明天早上');
          if (!selectedTime) return;
          
          var delayMap = {
            '明天早上': 24 * 60 * 60 * 1000, // 24小时后
            '下午茶时间': 12 * 60 * 60 * 1000, // 12小时后
            '晚上睡前': 18 * 60 * 60 * 1000 // 18小时后
          };
          
          var delay = delayMap[selectedTime] || 24 * 60 * 60 * 1000; // 默认24小时
          var diaryMsg = {
            id: String(Date.now()),
            role: 'system',
            type: 'diary',
            content: content,
            timestamp: Date.now() + delay,
            status: 'pending'
          };
          
          store.set('diaries', (store.get('diaries') || []).concat(diaryMsg));
          document.body.removeChild(dialog);
          ctx.toast('日记定时成功：' + selectedTime, 'ok');
          
          setTimeout(function () {
            var reminder = prompt('记得写日记哦：' + diaryMsg.content.slice(0, 20) + '…');
            if (reminder !== null) {
              diaryMsg.status = 'written';
              diaryMsg.timestamp = Date.now(); // 实际写作时间
              store.set('diaries', store.get('diaries').map(function (d) {
                if (d.id === diaryMsg.id) return diaryMsg;
                return d;
              }));
              ctx.toast('日记已补写', 'ok');
            }
          }, delay);
        });
        
        // 取消按钮
        cancelBtn.addEventListener('click', function () { document.body.removeChild(dialog); });
        
        dialog.appendChild(title);
        dialog.appendChild(textArea);
        dialog.appendChild(nowBtn);
        dialog.appendChild(laterBtn);
        dialog.appendChild(cancelBtn);
        document.body.appendChild(dialog);
        textArea.focus();
      }
      
      // 注册到加号面板
          panelActions.find(a => a.id === 'diary').handler = function () { ctx.open('diary'); };
        
              // 引用回复
              var quoteInput = h('input', 'msg-quote-input', '');
              quoteInput.placeholder = '引用回复…';
              quoteInput.style.width = 'calc(100% - 40px)';
              quoteInput.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' && !ev.shiftKey) {
                  ev.preventDefault();
                  var content = quoteInput.value.trim();
                  if (content) {
                    doSend(); // TODO: 实际插入引用前缀
                    ctx.toast('已发送引用回复', 'ok');
                    meta.removeChild(quoteInput);
                  }
                }
              });
              meta.innerHTML = '';
              meta.appendChild(h('span', 'msg-time', timeStr(msg.timestamp)));
              meta.appendChild(quoteInput);
              quoteInput.focus();
            }
          }
        });

        bubble.addEventListener('touchend', function () {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        });

        bubble.addEventListener('click', function () {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          if (isSelecting) return;

          // 单击操作菜单（非多选模式）
          var menu = h('div', 'msg-action-menu');
          menu.innerHTML = '';
          
          // 收藏
          var favBtn = h('button', 'msg-act', '⭐ 收藏');
          favBtn.addEventListener('click', function () {
            ctx.toast('已收藏：' + (msg.content.slice(0, 20) + (msg.content.length > 20 ? '...' : '')), 'ok');
          });
          menu.appendChild(favBtn);

          // 编辑（仅用户消息）
          if (msg.role === 'user') {
            var editBtn = h('button', 'msg-act', '✏️ 编辑');
            editBtn.addEventListener('click', function () {
              var newContent = prompt('编辑这条消息：', msg.content);
              if (newContent !== null && newContent.trim()) {
                msg.content = newContent.trim();
                saveChats(getChats());
                renderMessages();
                ctx.toast('已更新', 'ok');
              }
            });
            menu.appendChild(editBtn);
          }

          // 复制
          var copyBtn = h('button', 'msg-act', '📋 复制');
          copyBtn.addEventListener('click', function () {
            navigator.clipboard.writeText(msg.content).then(function () {
              ctx.toast('已复制', 'ok');
            });
          });
          menu.appendChild(copyBtn);

          // reroll（带说明）
          var rerollBtn = h('button', 'msg-act', '🔄 reroll');
          rerollBtn.addEventListener('click', function () {
            var reason = prompt('reroll 理由（可选）：', '语气更温柔');
            if (reason === null) return;
            ctx.toast('reroll 已提交：' + (reason || '无说明'), 'ok');
          });
          menu.appendChild(rerollBtn);

          meta.innerHTML = '';
          meta.appendChild(menu);
        });
        var meta = h('div', 'msg-meta');
        meta.appendChild(h('span', 'msg-time', timeStr(msg.timestamp)));
        (actions || []).forEach(function (b) { meta.appendChild(b); });
        bubble.appendChild(meta);

        msgWrap.appendChild(bubble);
      }

      function appendPending() {
        var bubble = h('div', 'msg-bubble msg-assistant is-pending');
        var text = h('div', 'msg-text');
        if (pendingMsg.content) {
          text.textContent = pendingMsg.content;
        } else {
          text.appendChild(h('span', 'typing-dots', '···'));
        }
        bubble.appendChild(text);

        var meta = h('div', 'msg-meta');
        meta.appendChild(h('span', 'msg-time', timeStr(pendingMsg.timestamp)));
        var stop = h('button', 'msg-act', '停止');
        stop.type = 'button';
        stop.addEventListener('click', cancelReq);
        meta.appendChild(stop);
        bubble.appendChild(meta);

        msgWrap.appendChild(bubble);
      }

      function regenerateBtn(idx) {
        var b = h('button', 'msg-act', '重新生成');
        b.type = 'button';
        b.addEventListener('click', function () { regenerate(idx); });
        return b;
      }

      renderMessages();

      /* 发送逻辑 */
      function doSend() {
        var content = textarea.value.trim();
        if (!content) {
          // 触发回复（如 reroll 最后一条 assistant 消息）
          triggerReply();
          return;
        }

        /* 用户消息 */
        var userMsg = {
          id: String(Date.now()),
          role: 'user',
          content: content,
          timestamp: Date.now()
        };
        addMessage(chatId, userMsg);
        textarea.value = '';
        textarea.style.height = 'auto';
        renderMessages();

        /* 真实 API 接入：流式请求 */
        var contextMessages = store.get('chatDefaults.contextMessages') || 20;
        var messages = chat.messages.concat(userMsg).slice(-contextMessages);
        streaming = true;
        activeHandle = api.runChat(messages, {
          onDelta: function (delta, more) {
            if (!pendingMsg) {
              pendingMsg = {
                id: 'pending-' + Date.now(),
                role: 'assistant',
                content: '',
                timestamp: Date.now()
              };
              addMessage(chatId, pendingMsg);
            }
            pendingMsg.content += delta;
            renderMessages();
          },
          onDone: function (cand, text, info) {
            streaming = false;
            activeHandle = null;
            if (text && text.trim()) {
              var assistantMsg = {
                id: String(Date.now()),
                role: 'assistant',
                content: text.trim(),
                timestamp: Date.now()
              };
              addMessage(chatId, assistantMsg);
              renderMessages();
            } else {
              ctx.toast('API 返回空内容，请检查模型配置', 'warn');
            }
          },
          onError: function (list, err) {
            streaming = false;
            activeHandle = null;
            var msg = err && err.error ? err.error : '请求失败，请检查网络或 API 配置';
            ctx.toast('❌ ' + msg, 'err');
            // 恢复发送按钮状态（若被禁用）
            sendBtn.disabled = false;
            sendBtn.textContent = '发';
          }
        }, true);
        renderMessages();

        /* 模拟延迟后回复 */
        setTimeout(function () {
          updateChat(chatId, {}); // 触发刷新
          var replyMsg = {
            id: String(Date.now()),
            role: 'assistant',
            content: '这是自动回复测试——你说了"' + content + '"。下一步会接入真实 API。',
            timestamp: Date.now(),
            isTyping: false
          };
          /* 替换 loading 消息 */
          var chats = getChats();
          for (var i = 0; i < chats.length; i++) {
            if (chats[i].id === chatId) {
              var msgs = chats[i].messages;
              for (var j = 0; j < msgs.length; j++) {
                if (msgs[j].isTyping) {
                  msgs[j] = replyMsg;
                  break;
                }
              }
              break;
            }
          }
          saveChats(chats);
          renderMessages();
        }, 1500);
      }

      sendBtn.addEventListener('click', doSend);
      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });

      /* 自适应高度 */
      textarea.addEventListener('input', function () {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      });

      /* 每次回到页面时刷新消息 */
      ctx.onRefresh = function () {
        chat = getChat(chatId);
        if (chat) {
          ctx.setTitle(chat.name);
          renderMessages();
        }
      };
    },
    onShow: function (ctx) {
      if (ctx.onRefresh) ctx.onRefresh();
    }
  });
})(window);
      /* ======================= 加号面板（+）v0.1 ======================= */
      var plusBtn = h('button', 'plus-btn', '+');
      plusBtn.type = 'button';
      plusBtn.title = '更多功能';
      inputArea.appendChild(plusBtn);

      var panel = h('div', 'plus-panel');
      panel.style.display = 'none';
      body.appendChild(panel);

      var panelActions = [
        { id: 'transfer', name: '转账', icon: '💰' },
        { id: 'pat', name: '拍一拍', icon: '👋' },
        { id: 'file', name: '发文件', icon: '📎' },
        { id: 'photo', name: '发照片', icon: '📷' },
        { id: 'genimg', name: '生图发送', icon: '🎨' },
        { id: 'checkin', name: '查岗', icon: '📍' },
        { id: 'diary', name: '日记', icon: '📓' },
        { id: 'sticker', name: '表情包', icon: '😄' }
      ];

      function showPlusPanel() {
        if (panel.style.display === 'flex') {
          panel.style.display = 'none';
          return;
        }

        panel.innerHTML = '';
        panel.style.display = 'flex';

        panelActions.forEach(function (act) {
          var btn = h('button', 'plus-item');
          btn.innerHTML = act.icon + '<span>' + act.name + '</span>';
          btn.title = act.name;
          btn.addEventListener('click', function () {
            ctx.toast('已触发：' + act.name, 'ok');
            panel.style.display = 'none';
            // TODO: 实际动作注册点
          });
          panel.appendChild(btn);
        });
      }

      plusBtn.addEventListener('click', showPlusPanel);

      // 点击其他区域收起面板
      document.addEventListener('click', function (e) {
        if (panel.style.display === 'flex' && 
            !e.target.closest('.plus-btn') && 
            !e.target.closest('.plus-panel')) {
          panel.style.display = 'none';
        }
      });
