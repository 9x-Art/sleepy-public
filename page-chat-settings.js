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
      ctx.setTitle((chat.name || '对话') + ' · 设置');

      var body = ctx.body;
      var ov = c.overridesOf(chat);
      var def = store.get('chatDefaults') || {};

      /* ---------------------- 跟谁聊 ---------------------- */

      var g0 = group('跟谁聊', '从名片夹里挑一个人。这点决定了它在跟谁说话。');

      function paintChar() {
        g0.card.innerHTML = '';
        g0.card.appendChild(row({
          label: '角色',
          value: charLabel(chat),
          onClick: function () {
            openPicker(ctx, {
              title: '这段对话跟谁聊',
              onPick: function (pageCtx, picked) {
                c.mutate(chatId, function (x) { x.characterId = picked.id; });
                chat = c.getChat(chatId);
                paintChar();
                if (pageCtx) pageCtx.toast('已换成「' + picked.name + '」', 'ok');
              }
            });
          }
        }));
      }
      paintChar();
      body.appendChild(g0.wrap);

      /* ------------------ 这个对话的参数 ------------------ */

      var g1 = group('这个对话的参数',
        '留空就是跟随全局默认（设置 → 聊天默认参数）。填了就以这里为准。');

      var defTemp = (def.temperature != null) ? def.temperature : 0.85;
      var defCtx = (def.contextMessages != null) ? def.contextMessages : 20;

      var f = {};
      f.temp = numField({
        label: '温度',
        hint: '留空跟随全局（现在 ' + defTemp + '）；越高越发散',
        value: ov.temperature,
        min: 0, max: 2, step: 0.05
      });
      g1.card.appendChild(f.temp.el);

      f.context = numField({
        label: '携带上下文条数',
        hint: '留空跟随全局（现在 ' + defCtx + ' 条）；越多越记得住，也越贵',
        value: ov.contextMessages,
        min: 2, max: 200, step: 2
      });
      g1.card.appendChild(f.context.el);

      /* 流式是个开关，但这里需要三态（跟随 / 开 / 关），
         所以拆成「跟随全局」+「流式输出」两个开关，
         前者开着时后者置灰 */
      f.follow = switchField({
        label: '流式跟随全局',
        hint: '关掉之后，下面这个开关才是这段对话专用的',
        value: ov.stream == null
      });
      g1.card.appendChild(f.follow.el);

      f.stream = switchField({
        label: '流式输出',
        hint: '打字机效果，一个字一个字往外蹦',
        value: (ov.stream == null) ? (def.stream !== false) : ov.stream
      });
      g1.card.appendChild(f.stream.el);

      function syncStream() {
        var follow = f.follow.get();
        f.stream.input.disabled = follow;
        f.stream.el.style.opacity = follow ? '.45' : '';
      }
      f.follow.input.addEventListener('change', syncStream);
      syncStream();

      body.appendChild(g1.wrap);

      /* -------------------- 这个对话 -------------------- */

      var g2 = group('这个对话');

      function paintChatRows() {
        g2.card.innerHTML = '';
        var cur = c.getChat(chatId);
        if (!cur) return;

        g2.card.appendChild(row({
          label: '改名字',
          hint: '现在叫「' + cur.name + '」',
          onClick: async function () {
            var name = await ui.prompt({
              title: '给这段对话改个名字',
              value: cur.name || '',
              ok: '保存'
            });
            if (name === null) return;
            var next = String(name).trim();
            if (!next) { ctx.toast('名字不能是空的', 'warn'); return; }
            c.mutate(chatId, function (x) { x.name = next; });
            chat = c.getChat(chatId);
            ctx.setTitle(next + ' · 设置');
            paintChatRows();
            ctx.toast('已改名', 'ok');
          }
        }));

        g2.card.appendChild(row({
          label: '清空聊天记录',
          hint: '对话留着，说过的话清掉',
          onClick: async function () {
            var yes = await ui.confirm({
              title: '清空这段对话的记录？',
              note: '清掉就找不回来了，对话和角色会留着。',
              ok: '清空',
              danger: true
            });
            if (!yes) return;
            c.mutate(chatId, function (x) {
              x.messages = [];
              /* 心声是跟着消息来的，消息没了它也没有存在的理由 */
              x.heartbeats = [];
            });
            chat = c.getChat(chatId);
            ctx.toast('已清空', 'ok');
          }
        }));

        g2.card.appendChild(row({
          label: '导出成文本',
          hint: '存一份 txt，方便留个念或者搬到别处',
          onClick: function () { doExport(); }
        }));

        g2.card.appendChild(row({
          label: '删除这段对话',
          hint: '连人带记录一起从列表里去掉',
          onClick: async function () {
            var yes = await ui.confirm({
              title: '删除「' + cur.name + '」？',
              note: '聊天记录会一起没掉。',
              ok: '删除',
              danger: true
            });
            if (!yes) return;
            c.saveChats(c.getChats().filter(function (x) { return x.id !== chatId; }));
            ctx.toast('已删除', 'ok');
            ctx.back();
          }
        }));
      }
      paintChatRows();
      body.appendChild(g2.wrap);

      body.appendChild(h('p', 'set-foot',
        '这里的参数只影响这一段对话。想改所有对话的默认值，去 设置 → 聊天默认参数。'));

      ctx.setActions([{
        label: '保存',
        kind: 'primary',
        onClick: function () { doSave(); }
      }]);

      function doSave() {
        var ctxVal = f.context.get();
        var next = {
          temperature: f.temp.get(),
          contextMessages: (ctxVal == null) ? null : Math.round(ctxVal),
          stream: f.follow.get() ? null : f.stream.get()
        };

        c.mutate(chatId, function (x) {
          var o = x.overrides || {};
          o.temperature = next.temperature;
          o.contextMessages = next.contextMessages;
          o.stream = next.stream;
          /* maxTokens 这个页面暂时没露出来，但不能在保存时把它抹掉 */
          if (o.maxTokens === undefined) o.maxTokens = null;
          x.overrides = o;
        });

        ctx.toast('已保存', 'ok');
        ctx.back();
      }

      function doExport() {
        var cur = c.getChat(chatId);
        if (!cur) return;
        if (!(cur.messages || []).length) {
          ctx.toast('这段对话还没有内容', 'warn');
          return;
        }
        var safe = String(cur.name || '对话').replace(/[\\/:*?"<>|]/g, '_');
        var ok = ui.downloadText(safe + '.txt', chatToText(cur), 'text/plain');
        if (ok) ctx.toast('已导出', 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
      }
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.chatSettings = {
    openPicker: openPicker,
    closePicker: closePicker,
    chatToText: chatToText
  };

})(window);
