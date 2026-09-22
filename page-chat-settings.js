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
    var people = scopeToRoom(cs().getCharacters());
    var names = Sleepy.characters || {};
    els.list.innerHTML = '';

    if (!people.length) {
      var empty = h('div', 'pk-empty');
      empty.appendChild(h('p', 'pk-empty-text', '这间房里还空着'));
      empty.appendChild(h('p', 'pk-empty-hint', '先加一个角色，再回来跟他聊'));
      els.list.appendChild(empty);

      els.list.appendChild(button('去浮岛放一个', 'primary', function () {
        var ctx = pkCtx;
        closePicker();
        if (ctx) ctx.open('island');
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

  /* 选人面板按岛隔离（2026-09-19 用户抓的 bug：别的孤岛的角色混了进来）。
     在某间房里时只给：房内大号 + 皮套 / 岛内全体 NPC（唯一口径
     core.npcsOfRoom：sandbox 新语义 + 挂 char/user 名下的老数据兜底）。
     没进任何房才回落全量（老存档兼容）。 */
  function scopeToRoom(list) {
    var core = Sleepy.core;
    if (!core || !core.scopeId || !core.scopeId()) return list;
    var sid = core.scopeId();
    var ok = {};
    core.charsOfSandbox(sid).forEach(function (c) {
      ok[c.id] = true;
      var subs = (Sleepy.island ? Sleepy.island.childrenOf(sid, c.id, 'sub', 'char') : []);
      subs.forEach(function (k) { ok[k.id] = true; });
    });
    if (core.npcsOfRoom) core.npcsOfRoom(sid).forEach(function (n) { ok[n.id] = true; });
    return list.filter(function (c) { return ok[c.id]; });
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
  /* 角色级小设置（主动消息 / 角色记忆开关）。默认都开。 */
  function charSettings(charId) {
    var all = store.get('charSettings') || { byChar: {} };
    var mine = (charId && all.byChar && all.byChar[charId]) || {};
    return {
      get proactive() { return mine.proactive !== false; },
      get memory() { return mine.memory !== false; },
      set: function (k, v) {
        all.byChar = all.byChar || {};
        all.byChar[charId] = all.byChar[charId] || {};
        all.byChar[charId][k] = v;
        store.set('charSettings', all);
      }
    };
  }

  /* demo 的行结构：标签 + 一行小注，右边箭头 / 开关 */
  function demoRow(o) {
    var r = h('button', 'set-row cs-row' + (o.danger ? ' cs-danger' : ''));
    r.type = 'button';
    var main = h('span', 'set-row-main');
    main.appendChild(h('span', 'set-row-label', o.label));
    if (o.note) main.appendChild(h('span', 'set-row-hint', o.note));
    r.appendChild(main);
    var right = h('span', 'set-row-right');
    if (o.switched !== undefined) {
      var lab = h('label', 'set-switch cs-inline-switch');
      var input = h('input');
      input.type = 'checkbox';
      input.checked = !!o.switched;
      lab.appendChild(input);
      lab.appendChild(h('span', 'set-switch-track'));
      right.appendChild(lab);
      input.addEventListener('change', function () { o.onSwitch(input.checked); });
      /* 开关在行里：点行不触发别的（本来也没有 onClick），阻止冒泡即可 */
      lab.addEventListener('click', function (e) { e.stopPropagation(); });
    } else if (o.onClick) {
      right.appendChild(h('span', 'set-row-arrow', '›'));
      r.addEventListener('click', o.onClick);
    } else {
      r.disabled = true;
      r.classList.add('is-soon');
    }
    r.appendChild(right);
    return r;
  }

  function sectionOf(body, title) {
    var sec = h('div', 'cs-section');
    sec.appendChild(h('p', 'cs-sec-label', title));
    body.appendChild(sec);
    return sec;
  }

  /* 主动消息节奏抽屉（全局设置，iol-drawer 复用浮岛那套样式）。
     onSaved 里拿不到行内 note（demoRow 自己画的），改完就靠 toast 告知，
     重进本页会显示新值。 */
  /* 朋友权限（用户 2026-09-22：「和微信一样哇」）——
     看到某个人的朋友圈要三件事都成立：① 你加了她（在这座岛上）
     ② 她开放给你看 ③ 你也开了看她的。

     这个抽屉管的是**你能决定的两个**（③ 和「让不让她看我的」）；
     ② 属于 TA 那边 —— 存在同一条 link 上（core 的 charHidesMe / charHidesFromMe），
     由剧情或引擎写，这里只**显示状态**，不给玩家直接改。 */
  function friendPermNote(chat) {
    var core = Sleepy.core;
    if (!chat || !chat.characterId) return '先给这个对话选一个角色';
    var meId = chat.userId || ((core && core.activeUserOnIsland && core.activeUserOnIsland()) || {}).id || '';
    if (!meId) return '这个对话还没绑定身份';
    var pr = core.feedPermOf(chat.characterId, meId);
    if (pr.iHideChar && pr.iHideFromChar) return '两个都关了 · 互相都看不见';
    if (pr.iHideChar) return '你关了「看 TA 的」· 你看不到 TA 的动态';
    if (pr.iHideFromChar) return '你关了「让 TA 看」· TA 看不到你的动态';
    if (pr.charHidesMe) return 'TA 现在没让你看 TA 的朋友圈';
    if (pr.charHidesFromMe) return 'TA 现在不看你的朋友圈';
    return '互相都开着 · 都能看见';
  }

  function openFriendPermDrawer(ctx, chat) {
    var core = Sleepy.core;
    if (!chat || !chat.characterId) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
    var meId = chat.userId || ((core && core.activeUserOnIsland && core.activeUserOnIsland()) || {}).id || '';
    if (!meId) { ctx.toast('这个对话还没绑定身份', 'warn'); return; }

    /* 挂到 #phone 而不是 ctx.el（.page 上有 transform，fixed 会失效） */
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var chName = charLabel(chat);
    var pr = core.feedPermOf(chat.characterId, meId);

    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '朋友权限'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '看到 TA 的朋友圈要三件事都成立：你加了她、她开放给你看、你也开了看她的。' +
      '这两个开关是你能决定的。'));

    var fHide = switchField({
      label: '不看 ' + chName + ' 的朋友圈',
      hint: '开了之后，TA 发的动态在你这儿就不显示了',
      value: pr.iHideChar
    });
    panel.appendChild(fHide.el);

    var fMine = switchField({
      label: '不让 ' + chName + ' 看我的朋友圈',
      hint: '开了之后，你发的动态 TA 看不见',
      value: pr.iHideFromChar
    });
    panel.appendChild(fMine.el);

    /* TA 那边的状态：只读 —— 那是剧情里会自己变的东西 */
    if (pr.charHidesMe || pr.charHidesFromMe) {
      panel.appendChild(h('p', 'iol-drawer-desc',
        pr.charHidesMe
          ? '另外：' + chName + ' 现在没让你看 TA 的朋友圈（这条在 TA 那边，剧情里会变）。'
          : '另外：' + chName + ' 现在不看你的朋友圈（同上）。'));
    }

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不改');
    var save = h('button', 'iol-drawer-save', '保存');
    actions.appendChild(cancel);
    actions.appendChild(save);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      core.setFeedPerm(chat.characterId, meId, 'iHideChar', fHide.get());
      core.setFeedPerm(chat.characterId, meId, 'iHideFromChar', fMine.get());
      close();
      ctx.toast('记下来了', 'ok');
      if (ctx.rebuild) ctx.rebuild();
    });

    wrap.appendChild(panel);
    host.appendChild(wrap);
    /* 下一帧再加 show，否则 transition 不触发（跟同文件其他抽屉一致） */
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

  function openProactiveDrawer(ctx) {
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var st = Sleepy.proactiveEngine ? Sleepy.proactiveEngine.settings()
      : { quietStart: '23:00', quietEnd: '08:00', maxPerDay: 2, cooldownMin: 120, deferMin: 90 };

    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '主动消息安排'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '这是全局节奏，每个角色自己的开关在上面那行。免打扰时段里 TA 不会来找你。'));

    function field(label, value, ph) {
      var f = h('div', 'iol-field');
      f.appendChild(h('label', '', label));
      var inp = h('input');
      inp.value = value;
      inp.placeholder = ph;
      f.appendChild(inp);
      panel.appendChild(f);
      return inp;
    }
    var qs = field('免打扰开始（HH:MM）', st.quietStart, '23:00');
    var qe = field('免打扰结束（HH:MM）', st.quietEnd, '08:00');
    var mx = field('每天最多主动几次', String(st.maxPerDay), '2');
    var cd = field('两次主动之间的冷却（分钟）', String(st.cooldownMin), '120');
    var df = field('TA 暂缓后再开口的间隔（分钟）', String(st.deferMin !== undefined ? st.deferMin : 90), '90');

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不改');
    var save = h('button', 'iol-drawer-save', '保存');
    actions.appendChild(cancel);
    actions.appendChild(save);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      if (Sleepy.proactiveEngine) {
        var mm = function (v, d) {
          v = String(v || '').trim();
          return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v)
            ? (('0' + parseInt(v, 10)).slice(-2) + v.slice(v.indexOf(':')))
            : d;
        };
        var num = function (v, d, lo, hi) {
          v = parseInt(v, 10);
          if (isNaN(v)) return d;
          return Math.max(lo, Math.min(hi, v));
        };
        Sleepy.proactiveEngine.saveSettings({
          quietStart: mm(qs.value, '23:00'),
          quietEnd: mm(qe.value, '08:00'),
          maxPerDay: num(mx.value, 2, 0, 12),
          cooldownMin: num(cd.value, 120, 5, 1440),
          deferMin: num(df.value, 90, 5, 1440)
        });
        ctx.toast('主动消息节奏已更新', 'ok');
      }
      close();
    });

    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

  /* 记忆模型选择抽屉（v5 12.1）：总结/整理走哪个模型。
     候选 = 跟随主 API + 主/副 API 里已启用的（复用线下的 apiChoices）。 */
  function openMemoryApiDrawer(ctx) {
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var cfg = store.get('memoryApiCfg') || { mode: 'main' };
    var choices = (Sleepy.offlineStore && Sleepy.offlineStore.apiChoices)
      ? Sleepy.offlineStore.apiChoices() : [];

    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '记忆整理用的模型'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '总结引擎和群记忆结算用的模型。没指定或指定的模型被删掉时，回落主 API。'));

    function optionRow(label, desc, active, onPick) {
      var r = h('button', 'iol-drawer-cancel' + (active ? ' is-active' : ''));
      r.type = 'button';
      r.style.cssText += 'display:block;width:100%;text-align:left;margin-top:8px;';
      r.appendChild(h('span', '', label));
      if (desc) r.appendChild(h('small', '', '　' + desc));
      r.addEventListener('click', onPick);
      panel.appendChild(r);
      return r;
    }

    optionRow('跟随主 API', '', cfg.mode !== 'pick', function () {
      store.set('memoryApiCfg', { mode: 'main' });
      ctx.toast('记忆整理将使用主 API', 'ok');
      close();
      ctx.rebuild();
    });
    choices.forEach(function (c) {
      optionRow(c.label, c.desc, cfg.mode === 'pick' && cfg.label === c.label, function () {
        store.set('memoryApiCfg', { mode: 'pick', label: c.label });
        ctx.toast('记忆整理将使用「' + c.label + '」', 'ok');
        close();
        ctx.rebuild();
      });
    });
    if (!choices.length) {
      panel.appendChild(h('p', 'iol-drawer-desc', '还没有可用的模型连接 —— 先去 设置 → 主 API 填一个。'));
    }

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不改');
    actions.appendChild(cancel);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);

    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

  /* 通用选项抽屉（查手机 · 自主生活档位等）：一列单选，选中即落档并关闭。 */
  function openPickDrawer(ctx, o) {
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', o.title));
    if (o.desc) panel.appendChild(h('p', 'iol-drawer-desc', o.desc));

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }

    (o.options || []).forEach(function (op) {
      var r = h('button', 'iol-drawer-cancel' + (op.v === o.current ? ' is-active' : ''));
      r.type = 'button';
      r.style.cssText += 'display:block;width:100%;text-align:left;margin-top:8px;';
      r.appendChild(h('span', '', op.label));
      if (op.desc) r.appendChild(h('small', '', '　' + op.desc));
      r.addEventListener('click', function () {
        if (o.onPick) o.onPick(op.v);
        ctx.toast('已更新', 'ok');
        close();
        ctx.rebuild();
      });
      panel.appendChild(r);
    });

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不改');
    actions.appendChild(cancel);
    panel.appendChild(actions);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);

    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

  /* 查手机生成用的模型抽屉：语义与记忆模型一致（memoryApiCfg 模式），
     存 phoneApiCfg，被删回落主 API。 */
  function openPhoneApiDrawer(ctx) {
    var cfg = (Sleepy.phone && Sleepy.phone.apiCfg) ? Sleepy.phone.apiCfg() : { mode: 'main' };
    var choices = (Sleepy.offlineStore && Sleepy.offlineStore.apiChoices)
      ? Sleepy.offlineStore.apiChoices() : [];
    openPickDrawer(ctx, {
      title: '查手机用的模型',
      desc: '生活结算和初始底片用的模型。没指定或指定的模型被删掉时，回落主 API。',
      options: [{ v: 'main', label: '跟随主 API', desc: '' }].concat(choices.map(function (c) {
        return { v: c.label, label: c.label, desc: c.desc || '' };
      })),
      current: cfg.mode === 'pick' ? cfg.label : 'main',
      onPick: function (v) {
        if (!Sleepy.phone) return;
        if (v === 'main') Sleepy.phone.setApiCfg({ mode: 'main' });
        else Sleepy.phone.setApiCfg({ mode: 'pick', label: v });
      }
    });
  }

  Sleepy.register('chat-settings', {
    title: '对话设置',
    render: function chatSettingsRender(ctx) {
      var chatId = ctx.params.chatId;
      var c = cs();
      var chat = c.getChat(chatId);
      if (!chat) {
        ctx.toast('找不到这个对话', 'err');
        ctx.back();
        return;
      }
      var ch = chat.characterId ? c.findCharacter(chat.characterId) : null;
      var chName = ch ? ch.name : '未绑定角色';
      /* ⚠️ 这个渲染函数必须自己拿 charId 和 core。
         文件里唯一的 `var core` 在 :166 那个**同级**函数里，不是外层作用域；
         而 charId 从来只作为 charSettings() 的形参出现过。
         漏掉就是整页 ReferenceError —— 'use strict' 不会替我们兜，
         app.js 的错误边界会把这页整个换成「这一页出错了」（2026-09-21 修）。 */
      var charId = chat.characterId || '';
      var coreRef = Sleepy.core;
      var csRow = charSettings(chat.characterId);
      /* 防御：SW 的 stale-while-revalidate 会先给一屏旧 index.html，
         那一屏里 page-char-appearance.js 还没挂上 —— 别让整页崩掉。 */
      var AP = Sleepy.charAppearance || null;
      var appearanceCfg = (AP && chat.characterId) ? AP.resolve(chat.characterId) : null;

      ctx.setTitle('角色设置');
      var body = ctx.body;
      body.innerHTML = '';

      /* 头部：头像圈 + 名字 */
      var head = h('div', 'cs-head');
      var ava = h('div', 'cs-ava');
      ava.textContent = (chName || '?').slice(0, 1);
      head.appendChild(ava);
      var headMain = h('div', 'cs-head-main');
      headMain.appendChild(h('p', 'cs-head-name', chName));
      headMain.appendChild(h('p', 'cs-head-sub', ch ? '线上模式 · 日常相处' : '先给这个对话选一个角色'));
      head.appendChild(headMain);
      body.appendChild(head);

      /* ---- 聊天 ---- */
      var secChat = sectionOf(body, '聊天');
      secChat.appendChild(demoRow({
        label: '线上聊天预设', note: '注入内容在「预设」App 里管理',
        onClick: function () { ctx.open('presets'); }
      }));
      secChat.appendChild(demoRow({
        label: '用户身份', note: '以哪个身份和 ' + chName + ' 相处'
        /* 身份系统还没接进聊天 —— 先不给箭头（灰行占位） */
      }));
      secChat.appendChild(demoRow({
        label: '主动消息', note: '允许他在合适的时候来找你',
        switched: csRow.proactive,
        onSwitch: function (v) { csRow.set('proactive', v); }
      }));
      /* 主动消息引擎（第二梯队 4）：节奏设置 + 手动评估入口 */
      var st = Sleepy.proactiveEngine ? Sleepy.proactiveEngine.settings()
        : { quietStart: '23:00', quietEnd: '08:00', maxPerDay: 2, cooldownMin: 120, deferMin: 90 };
      /* GATE_WHY 实时行注：本地判断不发请求，defer / 冷却带剩余分钟 */
      var gateNow = (Sleepy.proactiveEngine && Sleepy.proactiveEngine.gateWhyText && chat.characterId)
        ? Sleepy.proactiveEngine.gateWhyText(chat.characterId, {}) : '';
      secChat.appendChild(demoRow({
        label: '主动消息安排',
        note: '免打扰 ' + st.quietStart + '~' + st.quietEnd +
          ' · 每天最多 ' + st.maxPerDay + ' 次 · 冷却 ' + st.cooldownMin + ' 分钟' +
          ' · 暂缓 ' + (st.deferMin !== undefined ? st.deferMin : 90) + ' 分钟',
        onClick: function () { openProactiveDrawer(ctx); }
      }));
      secChat.appendChild(demoRow({
        label: '现在评估一次',
        note: gateNow
          ? '现在：' + gateNow + '（手动评估会忽略免打扰和冷却）'
          : '忽略免打扰和冷却，让 TA 想想有没有要说的',
        onClick: function () {
          if (!Sleepy.proactiveEngine || !chat.characterId) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
          ctx.toast('正在问 ' + chName + '…', 'ok');
          Sleepy.proactiveEngine.evaluate(chat.characterId, { manual: true }).then(function (r) {
            if (!r.ok) {
              var whyMap = Sleepy.proactiveEngine.GATE_WHY || {};
              ctx.toast(r.why === 'noapi' ? '先去 设置 → 主 API 配一个模型'
                : r.why === 'nocand' ? chName + '目前没有想主动提起的事'
                : r.why === 'parse' ? 'TA 走神了（解析失败），再试一次'
                : '这次没发：' + (whyMap[r.why] || r.why || '没有合适的时机'), 'ok');
              return;
            }
            if (r.decision === 'send') {
              ctx.toast('「' + chName + '」主动发来了消息，去聊天里看', 'ok');
            } else {
              ctx.toast(chName + '想了想，决定先不说话（' + (r.decision || 'skip') +
                (r.reason ? ' · ' + r.reason : '') + '）', 'ok');
            }
          });
        }
      }));

      /* ---- 记忆 ---- */
      /* ---- 朋友权限（用户 2026-09-22：「和微信一样」）---- */
      var secFriend = sectionOf(body, '朋友权限');
      secFriend.appendChild(demoRow({
        label: '朋友圈权限',
        note: friendPermNote(chat),
        onClick: chat.characterId ? function () { openFriendPermDrawer(ctx, chat); } : null
      }));

      var secMem = sectionOf(body, '记忆');
      secMem.appendChild(demoRow({
        label: '角色记忆', note: '自动整理聊天中值得留下的内容',
        switched: csRow.memory,
        onSwitch: function (v) { csRow.set('memory', v); }
      }));
      /* 记忆模型（v5 12.1）：总结/整理可以走独立模型，默认跟随主 API */
      var memCfg = store.get('memoryApiCfg') || { mode: 'main' };
      secMem.appendChild(demoRow({
        label: '记忆整理用的模型',
        note: memCfg.mode === 'pick' ? (memCfg.label || '指定模型') + '（没配置会回落主 API）' : '跟随主 API',
        onClick: function () { openMemoryApiDrawer(ctx); }
      }));
      secMem.appendChild(demoRow({
        label: '整理聊天记忆', note: '把上次整理之后的新内容过一遍总结',
        onClick: function () {
          if (!Sleepy.summaryEngine) { ctx.toast('总结引擎没加载', 'err'); return; }
          ctx.toast('正在整理…', 'ok');
          Sleepy.summaryEngine.runNow(chatId).then(function (r) {
            if (r.ok && r.stat) {
              ctx.toast(r.stat.added
                ? '整理出 ' + r.stat.added + ' 条记忆，去「留痕」确认'
                : '这段时间没有值得留的新东西', 'ok');
              ctx.rebuild();
            } else if (r.error === 'noapi') {
              ctx.toast('先去 设置 → 主 API 配一个模型', 'warn');
            } else if (r.error !== 'empty') {
              ctx.toast('✗ ' + (r.error || '整理失败'), 'err');
            }
          });
        }
      }));
      /* sumRawFail 重试入口：上次解析失败时给出真按钮，成功后自动消失 */
      var sumFail = store.get('sumRawFail:' + chatId);
      if (sumFail && sumFail.at) {
        var ft = new Date(sumFail.at);
        var ftText = ('0' + ft.getHours()).slice(-2) + ':' + ('0' + ft.getMinutes()).slice(-2);
        secMem.appendChild(demoRow({
          label: '上次整理没解析成功（' + ftText + '）',
          note: '原文已存下来 · 点按再整理一次',
          onClick: function () {
            if (!Sleepy.summaryEngine) { ctx.toast('总结引擎没加载', 'err'); return; }
            ctx.toast('正在重试…', 'ok');
            Sleepy.summaryEngine.runNow(chatId).then(function (r) {
              if (r.ok && r.stat) {
                ctx.toast(r.stat.added
                  ? '重试成功，整理出 ' + r.stat.added + ' 条记忆'
                  : '重试成功（这次没有新条目）', 'ok');
                ctx.rebuild();
              } else if (r.error === 'noapi') {
                ctx.toast('先去 设置 → 主 API 配一个模型', 'warn');
              } else if (r.error !== 'empty') {
                ctx.toast('✗ ' + (r.error || '还是没成'), 'err');
              }
            });
          }
        }));
      }
      secMem.appendChild(demoRow({
        label: '前往留痕', note: '查看属于 ' + chName + ' 的记忆',
        onClick: function () {
          if (!charId) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
          ctx.open('memory', { charId: charId });
        }
      }));

      /* ---- 他的手机（查手机系统 · 施工卡-查手机-v1） ---- */
      var secPh = sectionOf(body, '他的手机');
      var LIFE_LABEL = { off: '关 · 他只在你们互动时生活', low: '低 · 偶尔留下一点痕迹',
        mid: '中 · 像普通人一样过日子', high: '高 · 日子过得很满' };
      var lifeLevel = (charId && Sleepy.phone && Sleepy.phone.autoLifeOf)
        ? Sleepy.phone.autoLifeOf(charId) : 'off';
      secPh.appendChild(demoRow({
        label: '自主生活', note: LIFE_LABEL[lifeLevel] || LIFE_LABEL.off,
        onClick: function () {
          openPickDrawer(ctx, {
            title: '他离屏幕后的生活',
            desc: '决定他不在你眼前时，会不会继续过日子、在手机里留下痕迹。生成走下面选的模型，一次结算批量写入。',
            options: [
              { v: 'off', label: '关', desc: '只在你们互动时生活' },
              { v: 'low', label: '低', desc: '偶尔留下一点痕迹' },
              { v: 'mid', label: '中', desc: '像普通人一样过日子' },
              { v: 'high', label: '高', desc: '日子过得很满（调用更频繁）' }
            ],
            current: lifeLevel,
            onPick: function (v) {
              if (Sleepy.phone && charId) Sleepy.phone.setAutoLife(charId, v);
            }
          });
        }
      }));
      var phCfg = (Sleepy.phone && Sleepy.phone.apiCfg) ? Sleepy.phone.apiCfg() : { mode: 'main' };
      secPh.appendChild(demoRow({
        label: '查手机用的模型',
        note: phCfg.mode === 'pick' ? (phCfg.label || '指定模型') + '（没配置会回落主 API）' : '跟随主 API',
        onClick: function () { openPhoneApiDrawer(ctx); }
      }));
      /* 「他给过你密码」是 user 声明的关系事实（分流定案 §二·C）：
         知道密码 ≠ 获得允许 —— 打开后查手机多一个「使用你记得的密码」入口，
         但没被允许时照样算未经允许查看。
         ⚠️ 但这一条**得排在他「设没设密码」后面**：他没设密码的话，
         「知不知道密码」根本无从谈起（用户六.2 报的「角色没设密码却要他
         输密码」，缺的就是上面那个开关这一层状态）。 */
      if (Sleepy.phone && coreRef && coreRef.scopeId && coreRef.scopeId() && charId) {
        var phRec = Sleepy.phone.ensurePhone(
          coreRef.scopeId(),
          (coreRef.rootIdOf ? coreRef.rootIdOf(charId) : '') || charId
        );
        /* 密码**不在这里明文写出来** —— 查手机里那套「试试你们的日子」
           是个玩法（定案 §E），写在这儿就白玩了。
           密码叙事化（2026-09-21 拍板）：他也会在剧情里自己设锁/改密码
           （[手机] lock/set → phone.applyLock），这个开关是 OOC 手动兜底，
           两边写的是同一个 lock.enabled。 */
        var phLocked = Sleepy.phone.lockEnabled(phRec);
        secPh.appendChild(demoRow({
          label: '锁屏密码',
          note: phLocked
            ? '设了 —— 查手机之前要先过四位数字（可以猜，也可能他早告诉过你）'
            : '没设 —— 查手机不用输密码，直接翻开（剧情里他也可能自己设）',
          switched: phLocked,
          onSwitch: function (v) {
            Sleepy.phone.setLockEnabled(phRec, v);
            /* 下面「他给过你密码」那一行的显隐跟着变，所以整页重画 */
            if (ctx.rebuild) ctx.rebuild();
          }
        }));
        /* 叙事留痕：他在剧情里亲手设过/改过密码的话，这里把事实亮出来 ——
           「旧密码作废了」本身可玩，user 至少得知道有这么回事（OOC 视角）。
           pin 不明文出现，只给说法和次数。 */
        if (phRec.lock && (phRec.lock.pinNote || (phRec.lock.pinHistory || []).length)) {
          var narrParts = [];
          if (phRec.lock.pinNote) narrParts.push('他的说法：' + phRec.lock.pinNote);
          if ((phRec.lock.pinHistory || []).length) {
            narrParts.push('之前换过 ' + phRec.lock.pinHistory.length + ' 次密码');
          }
          secPh.appendChild(demoRow({
            label: '剧情里他自己设的',
            note: narrParts.join(' · ')
          }));
        }
        if (phLocked) {
          secPh.appendChild(demoRow({
            label: '他给过你密码',
            note: phRec.knownPin ? '告诉过你 —— 查手机时可以「使用你记得的密码」' : '还没给过（可以试着猜猜看）',
            switched: !!phRec.knownPin,
            onSwitch: function (v) {
              phRec.knownPin = !!v;
              Sleepy.phone.savePhone(phRec);
            }
          }));
        }
        /* 上次生成没解析成功 —— 原文存下来了却没有任何重试入口
           （审查报告六.1 第 3 条：`phoneRawFail:` 只写不读，
           跟 `sumRawFail:` 那套不对称）。这里补齐，位置也跟总结那条对齐。 */
        var rawFail = store.get('phoneRawFail:' + phRec.charId);
        if (rawFail && rawFail.at) {
          var pft = new Date(rawFail.at);
          var pftText = ('0' + pft.getHours()).slice(-2) + ':' + ('0' + pft.getMinutes()).slice(-2);
          secPh.appendChild(demoRow({
            label: '上次生成没解析成功（' + pftText + '）',
            note: '原文已存下来 · 点按再来一次',
            onClick: function () {
              if (!Sleepy.phoneAI) { ctx.toast('生成链还没加载', 'err'); return; }
              ctx.toast('正在重试…', 'ok');
              var run = rawFail.mode === 'bootstrap'
                ? Sleepy.phoneAI.bootstrapPhone(coreRef.scopeId(), phRec.charId, rawFail.level || 'light')
                : Sleepy.phoneAI.settle(coreRef.scopeId(), phRec.charId, {});
              run.then(function (r) {
                if (r.ok) {
                  ctx.toast('重试成功', 'ok');
                  ctx.rebuild();
                } else if (r.error === 'noapi') {
                  ctx.toast((r.reason || '还没有可用的模型') + ' · 去 设置 → 主 API 配一个', 'warn');
                } else {
                  ctx.toast('✗ ' + (r.error || '还是没成'), 'err');
                }
              })['catch'](function (e) {
                ctx.toast('✗ 出错了：' + ((e && e.message) || '未知错误'), 'err');
              });
            }
          }));
        }
      }
      secPh.appendChild(demoRow({
        label: '去翻他的手机', note: '第 2 屏「查手机」也可以进',
        onClick: function () { ctx.open('phonecheck'); }
      }));

      /* ---- 个性化 ---- */
      var secPer = sectionOf(body, '个性化');
      var apNote = '默认 · 雾青';
      if (appearanceCfg && AP) {
        var col = (AP.COLORS[appearanceCfg.color] || {}).name || '雾青';
        var modeName = { wecom: '企微', phone: '捡手机' }[appearanceCfg.mode];
        apNote = modeName ? (modeName + ' · 整套皮肤')
                          : ('默认 · ' + col + (appearanceCfg.__scope === 'global' ? ' · 全局' : ''));
      }
      secPer.appendChild(demoRow({
        label: '聊天外观', note: apNote,
        onClick: function () { ctx.open('char-appearance', { chatId: chatId }); }
      }));
      secPer.appendChild(demoRow({ label: '语音', note: '未设置' }));
      /* 「模型与生成」以前是个**死行**：写了 note「跟随全局」，但没绑 onClick，
         点了没反应 —— 用户说的「模型没接上个性选择」就是这个。
         现在能给**这篇对话**单独指定走哪条模型连接，存 chat.overrides.pickLabel，
         api.runChat 读它；选的连接被删掉时自动回落全局。 */
      var chatOv = (chat && chat.overrides) || {};
      secPer.appendChild(demoRow({
        label: '模型与生成',
        note: chatOv.pickLabel ? (chatOv.pickLabel + ' · 这篇专用') : '跟随全局',
        onClick: function () {
          var list = (Sleepy.api && Sleepy.api.candidates) ? Sleepy.api.candidates() : [];
          if (!list.length) {
            ctx.toast('还没有可用的模型连接 · 去 设置 → 模型连接 配一个', 'warn');
            return;
          }
          var opts = [{ v: '', label: '跟随全局', desc: '用设置里那套候选顺序' }];
          list.forEach(function (c) {
            opts.push({ v: c.label, label: c.label, desc: (c.cfg && c.cfg.model) || '' });
          });
          openPickDrawer(ctx, {
            title: '这篇对话用哪个模型',
            desc: '只对这条对话生效。选的连接被删掉时，自动回落全局候选。',
            options: opts,
            current: chatOv.pickLabel || '',
            onPick: function (v) {
              cs().mutate(chatId, function (c2) {
                c2.overrides = c2.overrides || {};
                if (v) c2.overrides.pickLabel = v;
                else delete c2.overrides.pickLabel;
              });
            }
          });
        }
      }));

      /* ---- 数据管理 ---- */
      var secData = sectionOf(body, '数据管理');
      secData.appendChild(demoRow({
        label: '导出对话', note: '存成纯文本，留个念想',
        onClick: function () {
          var text = chatToText(chat);
          var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (chat.name || '对话') + '.txt';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
          ctx.toast('已导出', 'ok');
        }
      }));
      secData.appendChild(demoRow({
        label: '删除角色', danger: true,
        note: ch ? '连同设置一起，从通讯录移除' : '',
        onClick: function () {
          if (!ch) { ctx.toast('这个对话还没绑定角色', 'warn'); return; }
          ui.confirm({
            title: '删除 ' + ch.name + '？',
            note: '角色档案会从通讯录移除，对话记录保留。',
            danger: true, ok: '删除'
          }).then(function (v) {
            if (!v) return;   /* confirm 取消 = false */
            Sleepy.core.removeChar(ch.id);
            ctx.toast('已删除', 'ok');
            ctx.back();
          });
        }
      }));

      /* 从外观页改完回来要刷新「聊天外观」的注记 —— 整页重建 */
      ctx.rebuild = function () { chatSettingsRender(ctx); };
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.chatSettings = {
    openPicker: openPicker,
    closePicker: closePicker,
    chatToText: chatToText,
    charSettings: charSettings   /* 主动消息引擎要读这个开关 */
  };

  /* ---------------------------- 点火 ----------------------------

     首页（桌面）是基底页，不占页面栈，它的 render 必须有人主动调一次，
     否则 index.html 里那个空的 <section data-page="home"> 会一直空着，
     整块桌面一个组件都画不出来（见 app.js 的 Sleepy.bootHome）。

     为什么偏偏放在这个文件、且放在最末尾：
       app.js      定义 bootHome，此时 home 还没注册 → 调了也没用
       page-desktop.js       注册 home 的 render
       page-switch.js        给 home 的 render 包一层（存 ctx + 整机重绘）
       其他 page-*.js        陆续注册
       page-chat-settings.js  ← 最后一个，所有包装都已完成，在这里点火最稳
     本文件由 index.html 保证排在最后（见那里的注释）。
     改脚本顺序时，这一行要跟着一起看。 */
  if (typeof Sleepy.bootHome === 'function') Sleepy.bootHome();

})(window);
