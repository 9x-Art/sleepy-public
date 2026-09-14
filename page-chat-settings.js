/* ============================================================
   page-chat-settings.js — 对话设置 + 「挑个人来聊」
   依赖：store.js、ui.js、app.js、page-chat.js（用它的 chatStore）、
         page-contacts.js（用它的 characters.initialOf / summaryOf）
   页面：chat-settings
   暴露：Sleepy.chatSettings.openPicker(ctx, opts)

   为什么聊天页的齿轮不该是全局设置：
     全局设置回答「这个 App 怎么连模型」，
     对话设置回答「这一段关系怎么聊」—— 两层东西。
     混在一起，用的人会以为改的是当前对话（已经绕到过一次）。

   为什么新建对话是「挑个人」而不是「起个名字」：
     对话的名字本来就该是「跟谁聊」。起名字那一步是多余的 ——
     起完名字，这个对话还是不知道在跟谁说话。

   参数是三层回落里最上面那层（见 api.js 的 genParams）：
     对话级覆盖 > 单个接口的配置 > 聊天默认参数。
     这里留空 = null = 往下找，不会把下面的设置堵死。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var numField = ui.numField;
  var switchField = ui.switchField;
  var button = ui.button;

  function cs() { return Sleepy.chatStore; }

  /* ---------------------------- 小工具 ---------------------------- */

  function charLabel(chat) {
    var c = cs();
    var ch = c && chat && c.findCharacter(chat.characterId);
    return ch ? ch.name : '还没选';
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function timeLine(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* 导出成能直接读的纯文本 —— 想留个念或者搬到别处时用得上 */
  function chatToText(chat) {
    var out = ['【' + (chat.name || '对话') + '】', timeLine(chat.createdAt), ''];
    (chat.messages || []).forEach(function (m) {
      var text = m.type ? ('（' + (m.content || '附件') + '）') : (m.content || '');
      if (!text) return;
      out.push((m.role === 'user' ? '我：' : '对方：') + text);
    });
    return out.join('\n') + '\n';
  }

  /* ==================== 「挑个人来聊」浮层 ====================
     全局单例：挂到手机壳上，页面切来切去也不用重建。
     要记住「这次是哪个页面在调我」（pkCtx），因为回调里要用它的
     open / toast / rebuild。 */

  var pkEls = null;
  var pkCtx = null;
  var pkOnPick = null;

  function ensurePicker() {
    if (pkEls) return pkEls;

    var host = document.getElementById('phone') || document.body;

    var mask = h('div', 'pk-mask');
    var panel = h('div', 'pk-panel');

    var head = h('div', 'pk-head');
    var title = h('p', 'pk-title');
    var close = h('button', 'pk-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(title);
    head.appendChild(close);

    var list = h('div', 'pk-list');

    panel.appendChild(head);
    panel.appendChild(list);
    host.appendChild(mask);
    host.appendChild(panel);

    mask.addEventListener('click', closePicker);
    close.addEventListener('click', closePicker);
    document.addEventListener('keydown', function (e) {
      if (pkEls && pkEls.panel.classList.contains('is-open') && e.key === 'Escape') {
        closePicker();
      }
    });

    pkEls = { mask: mask, panel: panel, title: title, list: list };
    return pkEls;
  }

  function closePicker() {
    if (!pkEls) return;
    pkEls.mask.classList.remove('is-open');
    pkEls.panel.classList.remove('is-open');
    pkOnPick = null;
    pkCtx = null;
  }

  function renderPickerList() {
    var els = ensurePicker();
    var people = cs().getCharacters();
    var names = Sleepy.characters || {};
    els.list.innerHTML = '';

    if (!people.length) {
      var empty = h('div', 'pk-empty');
      empty.appendChild(h('p', 'pk-empty-text', '名片夹里还空着'));
      empty.appendChild(h('p', 'pk-empty-hint', '先加一个角色，再回来跟他聊'));
      els.list.appendChild(empty);

      els.list.appendChild(button('去名片夹加一个', 'primary', function () {
        var ctx = pkCtx;
        closePicker();
        if (ctx) ctx.open('contacts');
      }));
      return;
    }

    people.forEach(function (it) {
      var card = h('button', 'contact-card');
      card.type = 'button';

      var initial = names.initialOf
        ? names.initialOf(it.name)
        : String(it.name || '?').charAt(0).toUpperCase();
      card.appendChild(h('span', 'contact-av', initial));

      var main = h('div', 'contact-main');
      main.appendChild(h('div', 'contact-name', it.name || '未命名'));
      main.appendChild(h('div', 'contact-line',
        names.summaryOf ? names.summaryOf(it) : ''));
      card.appendChild(main);

      card.addEventListener('click', function () {
        var fn = pkOnPick;
        var ctx = pkCtx;
        closePicker();
        if (fn) fn(ctx, it);
      });

      els.list.appendChild(card);
    });
  }

  /* opts: { title, onPick(ctx, character) }
     不传 onPick 就是默认行为 —— 新建一个跟这个角色的对话 */
  function openPicker(ctx, opts) {
    opts = opts || {};
    var els = ensurePicker();
    pkCtx = ctx || null;
    pkOnPick = opts.onPick || defaultPick;
    els.title.textContent = opts.title || '挑个人来聊';
    renderPickerList();
    els.mask.classList.add('is-open');
    els.panel.classList.add('is-open');
  }

  function defaultPick(ctx, ch) {
    var chat = cs().createChat(ch.name, ch.id);
    if (!ctx) return;
    /* 列表页就在下面那一层，顺手让它重建，返回时立刻能看到新人 */
    if (ctx.rebuild) ctx.rebuild();
    ctx.toast('已加进列表 · ' + chat.name, 'ok');
    ctx.open('chat-detail', { chatId: chat.id });
  }

  /* ==================== 页面：对话设置 ==================== */

  /* 对话设置页：暂时占位。
     用户反馈这一页的内容不是想要的方向，先清空，等定稿再贴回实现。
     （旧实现存放在 git 历史里，commit 5c5f484 之前都能翻到。）
     注意：这个文件还暴露着 Sleepy.chatSettings.openPicker —— 
     世界书的「挂角色」浮层在用它，不能删。 */
  Sleepy.register('chat-settings', {
    title: '对话设置',
    render: function (ctx) {
      var chatId = ctx.params.chatId;
      var c = cs();
      var chat = c.getChat(chatId);
      if (!chat) {
        ctx.toast('找不到这个对话', 'err');
        ctx.back();
        return;
      }
      ctx.setTitle('对话设置');
      var p = h('p', 'set-foot', '这一页先占个位 —— 要放什么，定了再贴上。');
      p.style.padding = '48px 0';
      ctx.body.appendChild(p);
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.chatSettings = {
    openPicker: openPicker,
    closePicker: closePicker,
    chatToText: chatToText
  };

})(window);
