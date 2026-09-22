/* ============================================================
   page-wj-curtain.js — 帷境 · 谢幕与作品去向（T6）
   依赖：wj-data.js、wj-coread.js、page-wj-foyer.js（wjUI）、
        page-chat.js（chatStore，惰性取）、ui.js
   被依赖：page-wj-work.js 的「谢幕」按钮；聊天页惰性取本文件导出的卡片

   对应 Demo #5《谢幕与作品去向 v1》+ #6《三种卡片实物样张 v1》。

   ★ 五路彼此独立，判据是 Demo 底注那一行，**别合并成一颗按钮**：

       收藏 ≠ 分享 ≠ 共读 ≠ 公开 ≠ 定史

   | route   | 标签         | 副作用                                        |
   |---------|--------------|-----------------------------------------------|
   | ticket  | 收藏纪念     | 进收藏馆，不复制正文、不改权限                |
   | share   | 改变知情     | 聊天收作品卡，可读后回应，**不创建共读**       |
   | coread  | 创建邀请     | 需要回应，接受后才真正开始共读                |
   | forum   | 改变公开范围 | 这一版先只做「仅自己可见」占位                |
   | history | 可能改变现实 | 只提取候选事实，进独立审阅（T7，这一版不做）  |

   五路各自**幂等**（方案 §7 红线 10）：连点只产生一个副作用。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var wj = function () { return Sleepy.wj; };
  var CR = function () { return Sleepy.wjCoread; };

  var view = { workId: null };

  function btn(text, cls, fn) {
    var b = h('button', cls || 'wj-btn', text);
    b.type = 'button';
    if (fn) b.onclick = fn;
    return b;
  }

  function dayText(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* 作品卡上的两行元信息：章数 + 字数（两个地方共用，别各写一份） */
  function metaLine(o) {
    var bits = [];
    if (o.chapters) bits.push(o.chapters + ' 章');
    if (o.chars) bits.push('约 ' + o.chars + ' 字');
    return bits.join(' · ') || '尚未开帷';
  }

  /* 票根编号：从**作品**派生（workId + 标题），不是从票根 id ——
     否则谢幕页上的预览和保存后进收藏馆的那张会显示两个不同的号
     （预览拿不到真票根 id，只能编一个）。每部作品的号是稳定的。 */
  function ticketNo(t) {
    var seed = String(t.workId || t.id || '') + '|' + String(t.title || '');
    var n = 0;
    for (var i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
    return String(n % 1000).padStart(3, '0');
  }

  /* ---------------------------- 票根 ----------------------------
     半圆缺口由 CSS 的 :before/:after 做（Demo 的票根形）。
     收藏馆里也用这一张 —— 所以导出给外面（见文件尾）。 */
  function ticketEl(t, opts) {
    opts = opts || {};
    var box = h('div', 'wj-ticket' + (opts.small ? ' is-small' : ''));
    var main = h('div', 'wj-ticket-main');
    main.appendChild(h('div', 'wj-eyebrow', 'TICKET · 收藏纪念'));
    main.appendChild(h('h3', 'wj-ticket-title', t.title || '未命名剧本'));
    main.appendChild(h('p', 'wj-ticket-meta', metaLine(t)));
    main.appendChild(h('p', 'wj-ticket-line',
      (wj().REALITY_LABEL[t.reality] || '普通故事') + ' · 谢幕于 ' + dayText(t.at)));
    box.appendChild(main);
    var stub = h('div', 'wj-ticket-stub');
    stub.appendChild(h('span', 'wj-ticket-stub-tag', 'NO.'));
    stub.appendChild(h('span', 'wj-ticket-stub-no', ticketNo(t)));
    box.appendChild(stub);
    return box;
  }

  /* --------------------------- 作品卡（聊天用） ---------------------------
     Demo #6 的 .share：书封 + 标题 + 字数 + blockquote 附言。
     聊天页惰性取（本文件在 page-chat.js 之后加载），所以这里只负责画。 */
  function shareEl(msg) {
    var box = h('div', 'wj-share');
    var cover = h('div', 'wj-share-cover');
    cover.appendChild(h('span', 'wj-share-cover-t', msg.title || '未命名剧本'));
    box.appendChild(cover);
    var main = h('div', 'wj-share-main');
    main.appendChild(h('div', 'wj-eyebrow', 'SHARED · 收到的作品'));
    main.appendChild(h('h4', 'wj-share-title', msg.title || '未命名剧本'));
    main.appendChild(h('p', 'wj-share-meta', metaLine(msg)));
    if (msg.note) main.appendChild(h('blockquote', 'wj-share-note', msg.note));
    main.appendChild(h('p', 'wj-share-foot',
      '这是一部私人剧本。你读到的是作品，不是发生过的现实。'));
    box.appendChild(main);
    return box;
  }

  /* -------------------------- 邀请卡（聊天用） --------------------------
     Demo #6 的 .invite：深色 + meta 两格 + 四个回答按钮。

     四个按钮**不是给 user 点的** —— 回答的人是 TA（这张卡是 TA 的回应）。
     所以未回应时四个都是空的、下面写「等 TA 回应」；TA 回应之后对应的那一个
     亮起来，并显示 TA 自己那句话。
     做成可点会变成 user 替 TA 决定，那是 OOC 操纵，这个产品不做。 */
  function inviteEl(msg, opts) {
    opts = opts || {};
    var box = h('div', 'wj-invite');
    box.appendChild(h('div', 'wj-eyebrow', 'INVITATION · 同席共读'));
    box.appendChild(h('h4', 'wj-invite-title',
      '一起读《' + (msg.title || '未命名剧本') + '》'));
    var grid = h('div', 'wj-invite-meta');
    var m1 = h('div', 'wj-invite-meta-cell');
    m1.appendChild(h('small', null, '开放范围'));
    m1.appendChild(h('b', null, msg.scopeName || '从第一章开始'));
    var m2 = h('div', 'wj-invite-meta-cell');
    m2.appendChild(h('small', null, '陪读方式'));
    m2.appendChild(h('b', null, msg.modeName || '安静陪读'));
    grid.appendChild(m1);
    grid.appendChild(m2);
    box.appendChild(grid);

    var answers = h('div', 'wj-invite-answers');
    var chosen = msg.answer || '';
    ['accept', 'later', 'share', 'refuse'].forEach(function (id) {
      var def = CR().ACTIONS[id] || { label: id };
      var on = chosen === id;
      var el = h('span', 'wj-invite-ans' + (on ? ' is-on' : '') +
        (chosen && !on ? ' is-off' : ''), def.label);
      answers.appendChild(el);
    });
    box.appendChild(answers);

    if (chosen) {
      if (msg.note) box.appendChild(h('p', 'wj-invite-note', '「' + msg.note + '」'));
      if (chosen === 'accept' && opts.onEnter) {
        box.appendChild(btn('进入同席', 'wj-btn wj-btn-solid wj-invite-go', opts.onEnter));
      } else if (chosen !== 'accept') {
        box.appendChild(h('p', 'wj-invite-foot',
          chosen === 'share' ? 'TA 只收下了作品，没有建立共读。'
            : chosen === 'later' ? 'TA 想稍后再读 —— 改天再邀请一次就好。'
            : 'TA 这次没有答应。作品还在，不代表以后不行。'));
      }
    } else {
      box.appendChild(h('p', 'wj-invite-foot', '等 TA 回应……'));
    }
    return box;
  }

  /* ---------------------------- 弹层 ----------------------------
     挂 #phone 而不是 ctx.el（.page 上有 transform，fixed 会退化成
     相对那个祖先定位）。结构整段抄 page-chat-settings 的 .iol-drawer，
     换成帷境自己的配色（深夜蓝 + 月光纸）。 */
  function openSheet(ctx, opts) {
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.wj-sheet');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = h('div', 'wj-sheet');
    var panel = h('div', 'wj-sheet-panel');
    panel.appendChild(h('h2', 'wj-sheet-title', opts.title));
    if (opts.desc) panel.appendChild(h('p', 'wj-sheet-desc', opts.desc));
    (opts.body || []).forEach(function (el) { panel.appendChild(el); });
    if (opts.preview) {
      panel.appendChild(h('p', 'wj-sheet-cap', '实物预览'));
      panel.appendChild(opts.preview);
    }
    if (opts.actions) panel.appendChild(opts.actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.appendChild(panel);
    host.appendChild(wrap);
    /* 下一帧再加 show，否则 transition 不触发 */
    requestAnimationFrame(function () { wrap.classList.add('show'); });
    return { close: close, panel: panel };
  }

  /* ------------------------- 聊天投递（两路共用） -------------------------
     找「这个角色」的会话；没有就建一条（谢幕是 user 主动发起的动作，
     不该因为还没聊过天就发不出去）。

     ⚠️ 角色**已经不在了**就不发、也不建会话：cast 是建作品时抄下来的名单，
     删岛/删人之后里面的 charId 会变成幽灵，照它新建会得到一条挂在
     不存在的人身上的对话（2026-09-22 衔接审计发现的）。 */
  function chatForChar(charId, charName) {
    var cs = Sleepy.chatStore;
    if (!cs) return null;
    if (Sleepy.core && Sleepy.core.findChar && !Sleepy.core.findChar(charId)) return null;
    var chat = cs.chatOf(charId);
    if (chat) return chat;
    return cs.createChat(charName || '对话', charId);
  }

  function sendCard(charId, charName, patch) {
    var chat = chatForChar(charId, charName);
    if (!chat) return null;
    var msg = {
      id: Sleepy.core.newId('ms'),
      role: 'user',                 /* 是 user 发出去的动作，落在 user 那一侧 */
      timestamp: Date.now()
    };
    for (var k in patch) if (patch.hasOwnProperty(k)) msg[k] = patch[k];
    Sleepy.chatStore.addMessage(chat.id, msg);
    return { chatId: chat.id, msgId: msg.id };
  }

  /* 该角色是不是已经收过这部作品的作品卡 / 邀请卡 —— 幂等的真闸门。
     查数据本身（聊天记录）而不是再存一个布尔：两份记录迟早对不上。 */
  function alreadySent(chatId, workId, type) {
    var chat = Sleepy.chatStore && Sleepy.chatStore.getChat(chatId);
    if (!chat) return false;
    return (chat.messages || []).some(function (m) {
      return m.type === type && m.workId === workId;
    });
  }

  /* ------------------------------ 五路 ------------------------------ */

  var ROUTES = [
    { id: 'ticket', tag: '收藏纪念', name: '保存票根',
      hint: '进收藏馆。不复制正文，也不改任何权限。', col: 1 },
    { id: 'share', tag: '改变知情', name: '分享给一个人',
      hint: 'TA 在聊天里收到作品卡，可以读了回应 —— 但不会创建共读。', col: 1 },
    { id: 'coread', tag: '创建邀请', name: '邀请同席共读',
      hint: 'TA 收到邀请并回应，接受了才真正开始共读。', col: 1 },
    { id: 'forum', tag: '改变公开范围', name: '公开到论坛',
      hint: '决定谁看得见。这一版先只支持「仅自己可见」。', col: 1 },
    { id: 'history', tag: '可能改变现实', name: '进入正史审阅',
      hint: '只提取候选事实，逐条批准、冲突查清之后才可能写进现实。',
      col: 2, wine: true }
  ];

  function routeDone(w, id) {
    if (id === 'ticket') return !!wj().ticketFor(w.id);
    if (id === 'history') return w.status === 'canonized';
    return !!wj().curtainOf(w)[id === 'share' ? 'shared'
      : id === 'coread' ? 'coreadInvited' : 'forumPublished'];
  }

  /* ---- ① 票根 ---- */
  function sheetTicket(ctx, w) {
    var existing = wj().ticketFor(w.id);
    var sh = null;
    var acts = h('div', 'wj-sheet-actions');
    var go = btn(existing ? '已经在收藏馆里了' : '保存票根',
      'wj-btn wj-btn-solid', function () {
        if (!existing) {
          wj().saveTicket(w.id);
          Sleepy.toast('票根收进收藏馆了');
        } else {
          Sleepy.toast('这张票根已经在了');
        }
        if (sh) sh.close();
        paint(ctx);
      });
    if (existing) go.disabled = true;
    acts.appendChild(go);
    acts.appendChild(btn('先不做', 'wj-quiet', function () { if (sh) sh.close(); }));

    sh = openSheet(ctx, {
      title: '保存票根',
      desc: '票根进收藏馆，只记「读过这部作品」，不复制正文、不改任何权限。' +
        '同一部作品只有一张 —— 再点一次不会多出来。',
      preview: ticketEl(existing || {
        workId: w.id, title: w.title, reality: w.reality,
        chapters: wj().chapterCount(w, true), chars: wj().charCount(w), at: wj().nowISO()
      }),
      actions: acts
    });
  }

  /* ---- ② 分享（不创建共读） ---- */
  function sheetShare(ctx, w, idx0) {
    var cast = w.cast || [];
    var idx = typeof idx0 === 'number' ? idx0 : 0;
    var noteEl = Sleepy.ui.textArea({
      label: '附言（可不写）',
      value: '', rows: 3, placeholder: '想跟 TA 说的话，会显示在卡片下面'
    });
    var body = [];
    var sh = null;

    if (!cast.length) {
      body.push(h('p', 'wj-sheet-desc', '这部剧本还没有出场人物，先在开帷流程里安排一位。'));
    } else {
      var chips = h('div', 'wj-sheet-chips');
      cast.forEach(function (c, i) {
        var b = h('button', 'wj-chip' + (i === idx ? ' is-on' : ''), c.name);
        b.type = 'button';
        b.onclick = function () {
          /* 换人重开一次（和共读邀请票同一套做法）——
             附言会丢，但换人本来就该重新想那句话 */
          if (sh) sh.close();
          sheetShare(ctx, w, i);
        };
        chips.appendChild(b);
      });
      var p1 = h('div', 'wj-sheet-block');
      p1.appendChild(h('p', 'wj-sheet-cap', '给谁'));
      p1.appendChild(chips);
      body.push(p1);
      body.push(noteEl.el);
    }

    var acts = h('div', 'wj-sheet-actions');
    var go = btn('发送作品卡', 'wj-btn wj-btn-solid', function () {
      var c = cast[Math.min(idx, cast.length - 1)];
      if (!c) return;
      var chat = chatForChar(c.charId, c.name);
      if (!chat) { Sleepy.toast('这位角色已经不在这座岛上了', 'err'); return; }
      if (alreadySent(chat.id, w.id, 'wj-share')) {
        Sleepy.toast('TA 已经收过这部作品了');
        return;
      }
      sendCard(c.charId, c.name, {
        type: 'wj-share',
        workId: w.id,
        title: w.title,
        chapters: wj().chapterCount(w, true),
        chars: wj().charCount(w),
        note: String(noteEl.get() || '').trim().slice(0, 120)
      });
      wj().markCurtain(w.id, 'shared');
      if (sh) sh.close();
      Sleepy.toast('作品卡发给了' + c.name);
      paint(ctx);
    });
    if (!cast.length) go.disabled = true;
    acts.appendChild(go);
    acts.appendChild(btn('先不做', 'wj-quiet', function () { if (sh) sh.close(); }));

    sh = openSheet(ctx, {
      title: '分享给一个人',
      desc: 'TA 会在聊天里收到这张卡，可以读了再回应。' +
        '「分享不等于共读」—— 这一步不会创建同席。',
      preview: shareEl({
        title: w.title, chapters: wj().chapterCount(w, true), chars: wj().charCount(w),
        note: String((noteEl && noteEl.get && noteEl.get()) || '').trim() ||
          '（你写的附言会显示在这里）'
      }),
      body: body,
      actions: acts
    });
    /* 附言边打边更新预览（Demo 里预览是活的） */
    if (noteEl.input) {
      noteEl.input.addEventListener('input', function () {
        var q = sh.panel.querySelector('.wj-share-note');
        if (q) q.textContent = String(noteEl.get() || '').trim() || '（你写的附言会显示在这里）';
      });
    }
  }

  /* ---- ③ 邀请同席（要先回应） ---- */
  function sheetCoread(ctx, w) {
    var cast = w.cast || [];
    var pick = { idx: 0, scope: 'start', mode: 'quiet' };
    var body = [];
    var sh = null;

    if (!cast.length) {
      body.push(h('p', 'wj-sheet-desc', '这部剧本还没有出场人物，先在开帷流程里安排一位。'));
    } else {
      var chips = h('div', 'wj-sheet-chips');
      cast.forEach(function (c, i) {
        var b = h('button', 'wj-chip' + (i === pick.idx ? ' is-on' : ''), c.name);
        b.type = 'button';
        b.onclick = function () { pick.idx = i; repaint(); };
        chips.appendChild(b);
      });
      var p1 = h('div', 'wj-sheet-block');
      p1.appendChild(h('p', 'wj-sheet-cap', '邀请谁'));
      p1.appendChild(chips);
      body.push(p1);

      var seg = h('div', 'wj-seg');
      CR().SCOPES.forEach(function (sc) {
        var b = h('button', 'wj-seg-btn' + (pick.scope === sc.id ? ' is-on' : ''), sc.name);
        b.type = 'button';
        b.onclick = function () { pick.scope = sc.id; repaint(); };
        seg.appendChild(b);
      });
      var p2 = h('div', 'wj-sheet-block');
      p2.appendChild(h('p', 'wj-sheet-cap', '开放范围'));
      p2.appendChild(seg);
      body.push(p2);

      var modes = h('div', 'wj-sheet-modes');
      CR().MODES.forEach(function (m) {
        var row = h('button', 'wj-perm' + (pick.mode === m.id ? ' is-on' : ''));
        row.type = 'button';
        row.appendChild(h('span', 'wj-radio'));
        var mb = h('span', 'wj-perm-body');
        mb.appendChild(h('b', null, m.name));
        mb.appendChild(h('span', null, m.hint));
        row.appendChild(mb);
        row.onclick = function () { pick.mode = m.id; repaint(); };
        modes.appendChild(row);
      });
      var p3 = h('div', 'wj-sheet-block');
      p3.appendChild(h('p', 'wj-sheet-cap', '陪读方式'));
      p3.appendChild(modes);
      body.push(p3);
    }

    var previewWrap = h('div', 'wj-sheet-preview-hold');
    body.push(previewWrap);

    var acts = h('div', 'wj-sheet-actions');
    var go = btn('发出邀请', 'wj-btn wj-btn-solid', function () {
      var c = cast[Math.min(pick.idx, cast.length - 1)];
      if (!c) return;
      var chat = chatForChar(c.charId, c.name);
      if (!chat) { Sleepy.toast('这位角色已经不在这座岛上了', 'err'); return; }
      /* 幂等：TA 手上**还挂着一份没结果的邀请**才拦。
         「稍后再读」（deferred）和「只收下了作品」（sharing_only）不算 ——
         前者本来就是「改天再邀请一次」（共读页的文案就是这么写的），
         把它们也算成「已有一份」，那条邀请就永久成了僵尸
         （2026-09-22 衔接审计发现的）。 */
      var dup = CR().forWork(w.id).filter(function (s) {
        return s.charId === c.charId &&
          (s.status === 'invited' || s.status === 'active' || s.status === 'paused');
      })[0];
      if (dup) { Sleepy.toast('TA 手上已经有一份邀请了'); return; }

      var s = CR().createInvite({
        workId: w.id, charId: c.charId, charName: c.name,
        mode: pick.mode, scope: pick.scope,
        startAnchorId: (w.progress && w.progress.anchorId) || null
      });
      var sent = sendCard(c.charId, c.name, {
        type: 'wj-invite',
        workId: w.id, sessionId: s.id,
        title: w.title,
        charId: c.charId,
        scopeName: (CR().SCOPES.filter(function (x) { return x.id === pick.scope; })[0] || {}).name,
        modeName: (CR().MODES.filter(function (x) { return x.id === pick.mode; })[0] || {}).name,
        answer: ''
      });
      wj().markCurtain(w.id, 'coreadInvited');
      if (sh) sh.close();
      Sleepy.toast('邀请发出去了，等 TA 回应');
      paint(ctx);

      /* TA 的回应由模型判断（T5 的 judgeInvite，独立职责）——
         回应写回**那条聊天消息**上，聊天里那张卡就会自己变。 */
      CR().judgeInvite(w.id, CR().get(s.id))
        .then(function (r) {
          CR().settle(s.id, r.action, r.note);
          patchCard(sent, { answer: r.action, note: r.note });
        })
        ['catch'](function () {
          /* 判断失败就让卡停在「等 TA 回应」——不编一个回答出来 */
          Sleepy.toast('TA 暂时没有回应');
        });
    });
    if (!cast.length) go.disabled = true;
    acts.appendChild(go);
    acts.appendChild(btn('先不做', 'wj-quiet', function () { if (sh) sh.close(); }));

    function curCast() { return cast[Math.min(pick.idx, cast.length - 1)] || { name: '' }; }

    sh = openSheet(ctx, {
      title: '邀请同席共读',
      desc: '「共读要 TA 自己答应」—— 发出邀请只是问了。' +
        '接受、稍后、只收下作品、婉拒，四种都是体面的回应。',
      body: body,
      actions: acts
    });

    function repaint() {
      /* 只重画弹层里那几块，不整个重开 —— 重开会把输入状态抖掉 */
      if (!sh) return;
      var chipsBox = sh.panel.querySelector('.wj-sheet-chips');
      if (chipsBox) {
        Array.prototype.forEach.call(chipsBox.children, function (b, i) {
          b.classList.toggle('is-on', i === pick.idx);
        });
      }
      var segs = sh.panel.querySelectorAll('.wj-seg-btn');
      CR().SCOPES.forEach(function (sc, i) {
        if (segs[i]) segs[i].classList.toggle('is-on', sc.id === pick.scope);
      });
      var perms = sh.panel.querySelectorAll('.wj-perm');
      CR().MODES.forEach(function (m, i) {
        if (perms[i]) perms[i].classList.toggle('is-on', m.id === pick.mode);
      });
      drawPreview();
    }

    function drawPreview() {
      previewWrap.innerHTML = '';
      previewWrap.appendChild(h('p', 'wj-sheet-cap', '实物预览'));
      previewWrap.appendChild(inviteEl({
        title: w.title,
        scopeName: (CR().SCOPES.filter(function (x) { return x.id === pick.scope; })[0] || {}).name,
        modeName: (CR().MODES.filter(function (x) { return x.id === pick.mode; })[0] || {}).name,
        answer: ''
      }));
      previewWrap.appendChild(h('p', 'wj-sheet-desc',
        '给 ' + curCast().name + ' 的是这一张。'));
    }
    drawPreview();
  }

  /* ---- ④ 论坛（这一版只做占位） ---- */
  function sheetForum(ctx, w) {
    var done = !!wj().curtainOf(w).forumPublished;
    var body = [];
    var opts = h('div', 'wj-sheet-modes');
    [['self', '仅自己可见', '先存在自己的架子上，谁都不给看。', true],
      ['account', '发给某个账号', '（还没做）', false],
      ['board', '贴到某个板块', '（还没做）', false]
    ].forEach(function (x) {
      var row = h('button', 'wj-perm' + (x[3] ? ' is-on' : ' is-todo'));
      row.type = 'button';
      if (!x[3]) row.disabled = true;
      row.appendChild(h('span', 'wj-radio'));
      var mb = h('span', 'wj-perm-body');
      mb.appendChild(h('b', null, x[1]));
      mb.appendChild(h('span', null, x[2]));
      row.appendChild(mb);
      opts.appendChild(row);
    });
    body.push(opts);
    body.push(h('p', 'wj-sheet-desc',
      '公开范围改变的是「谁看得见」，跟知情、共读、定史都不是一回事。' +
      '账号与板块这两档要等论坛本身做出来。'));

    var sh = null;
    var acts = h('div', 'wj-sheet-actions');
    var go = btn(done ? '已经是仅自己可见了' : '存成仅自己可见',
      'wj-btn wj-btn-solid', function () {
        wj().markCurtain(w.id, 'forumPublished');
        if (sh) sh.close();
        Sleepy.toast('先只放在你自己这里');
        paint(ctx);
      });
    if (done) go.disabled = true;
    acts.appendChild(go);
    acts.appendChild(btn('先不做', 'wj-quiet', function () { if (sh) sh.close(); }));

    sh = openSheet(ctx, {
      title: '公开到论坛',
      desc: '作品现在只有你自己看得见。这一版先把「仅自己可见」记下来。',
      body: body, actions: acts
    });
  }

  /* ---- ⑤ 正史审阅（T7） ---- */
  function sheetHistory(ctx, w) {
    var canWrite = (w.reality === 'canon_candidate' || w.reality === 'canonized');
    var body = [
      h('p', 'wj-sheet-desc',
        '这条路可能改变现实，所以它最慢：先提取候选事实，' +
        '再逐条查冲突，最后逐条批准 —— 小说原文一个字都不会被写进现实。')
    ];
    if (!canWrite) {
      body.push(h('div', 'wj-sheet-notice',
        '这部作品的性质是「' + (wj().REALITY_LABEL[w.reality] || '普通故事') + '」——' +
        '它在开帷时就承诺过不进入任何人的现实记忆。要定史，' +
        '得先回开帷流程把它改成「正史候选」。'));
    } else if (w.reality === 'canonized') {
      body.push(h('div', 'wj-sheet-notice',
        '这部作品已经定过史了。再点进去可以补写新的候选 —— ' +
        '但只有重新提取过的候选才会解锁写入。'));
    }

    var sh = null;
    var acts = h('div', 'wj-sheet-actions');
    var go = btn(canWrite ? '打开审阅台' : '知道了',
      canWrite ? 'wj-btn wj-btn-solid' : 'wj-btn', function () {
        if (sh) sh.close();
        if (canWrite) Sleepy.nav.open('wj-canon', { workId: w.id });
      });
    acts.appendChild(go);
    acts.appendChild(btn('先不做', 'wj-quiet', function () { if (sh) sh.close(); }));

    sh = openSheet(ctx, {
      title: '进入正史审阅',
      desc: '定史 = 只写结构化事实，绝不写整篇正文。',
      body: body, actions: acts
    });
  }

  var SHEETS = {
    ticket: sheetTicket, share: sheetShare, coread: sheetCoread,
    forum: sheetForum, history: sheetHistory
  };

  /* ---------------------------- 主绘制 ---------------------------- */

  function paint(ctx) {
    var w = view.workId ? wj().get(view.workId) : null;
    var body = ctx.body;
    body.innerHTML = '';
    ctx.setTitle('谢幕');
    ctx.setActions([]);
    if (!w) {
      body.appendChild(h('div', 'wj-empty', '这部剧本已经不在门厅里了。'));
      return;
    }

    var shell = h('div', 'wj-shell wj-curtain');
    var c = wj().curtainOf(w);

    /* -------- ending 头 -------- */
    var head = h('div', 'wj-head');
    head.appendChild(h('div', 'wj-eyebrow', 'CURTAIN CALL'));
    head.appendChild(h('h1', 'wj-h1', '谢幕'));
    head.appendChild(h('p', 'wj-sub', '《' + (w.title || '') + '》 · ' +
      metaLine({ chapters: wj().chapterCount(w, true), chars: wj().charCount(w) })));
    shell.appendChild(head);

    /* -------- 谢幕本身（在这之前，没有任何地方能把作品标成已完成） --------
       判断用 sealedAt，**不能用 curtain.at** —— 分享/邀请/公开那三路
       也会写 curtain，拿 at 当判据会把「分享过」看成「已经谢幕」。 */
    var sealBox = h('div', 'wj-panel wj-curtain-seal');
    if (wj().isSealed(w)) {
      sealBox.appendChild(h('p', 'wj-sub', '已谢幕 · ' + dayText(c.sealedAt) +
        '。作品仍在门厅里，随时可以回去接着写。'));
    } else {
      sealBox.appendChild(h('p', 'wj-sub',
        '谢幕 = 这部作品写完了。这个动作只把状态改成「已完成」，' +
        '不删除、不改权限、不影响下面这五条路。'));
      sealBox.appendChild(btn('谢幕（标记为已完成）', 'wj-btn wj-btn-solid', function () {
        wj().curtain(w.id);
        Sleepy.toast('谢幕了');
        paint(ctx);
      }));
    }
    shell.appendChild(sealBox);

    /* -------- 票根 -------- */
    var t = wj().ticketFor(w.id);
    var tk = h('div', 'wj-panel');
    tk.appendChild(h('h2', 'wj-h2', '票根'));
    tk.appendChild(h('p', 'wj-sub',
      t ? '已经在收藏馆里了。' : '还没有保存 —— 保存之后会在收藏馆里留一张。'));
    tk.appendChild(ticketEl(t || {
      workId: w.id, title: w.title, reality: w.reality,
      chapters: wj().chapterCount(w, true), chars: wj().charCount(w),
      at: c.sealedAt || wj().nowISO()
    }, { small: true }));
    shell.appendChild(tk);

    /* -------- 五路 -------- */
    var routes = h('div', 'wj-panel');
    routes.appendChild(h('h2', 'wj-h2', '作品去向'));
    routes.appendChild(h('p', 'wj-sub', '五条路彼此独立，做了一条不等于做了另一条。'));
    var grid = h('div', 'wj-routes');
    ROUTES.forEach(function (r) {
      var done = routeDone(w, r.id);
      var card = h('button', 'wj-route' + (r.wine ? ' is-wine' : '') +
        (r.col === 2 ? ' is-wide' : '') + (done ? ' is-done' : ''));
      card.type = 'button';
      card.appendChild(h('span', 'wj-route-tag', r.tag));
      card.appendChild(h('span', 'wj-route-name', r.name));
      card.appendChild(h('span', 'wj-route-hint', r.hint));
      card.appendChild(h('span', 'wj-route-state', done ? '已做' : '未做'));
      card.onclick = function () { SHEETS[r.id](ctx, w); };
      grid.appendChild(card);
    });
    routes.appendChild(grid);
    shell.appendChild(routes);

    /* -------- 底注（Demo 那一行原样保留） -------- */
    shell.appendChild(h('p', 'wj-curtain-warn',
      '收藏不等于分享；分享不等于共读；共读不等于定史。'));

    body.appendChild(shell);
  }

  /* 把 TA 的回应写回那条聊天消息（聊天里那张卡自己会变） */
  function patchCard(sent, patch) {
    if (!sent || !Sleepy.chatStore) return;
    Sleepy.chatStore.mutate(sent.chatId, function (chat) {
      (chat.messages || []).forEach(function (m) {
        if (m.id !== sent.msgId) return;
        for (var k in patch) if (patch.hasOwnProperty(k)) m[k] = patch[k];
      });
      return chat;
    });
    /* 正开着这个对话就原地刷一次 */
    if (Sleepy.chatDetailRefresh) Sleepy.chatDetailRefresh();
  }

  Sleepy.register('wj-curtain', {
    title: '谢幕',
    render: function (ctx) {
      var p = ctx.params || {};
      if (p.id) view.workId = p.id;
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) { if (ctx.__paint) ctx.__paint(); }
  });

  /* 聊天页惰性取这两个（本文件在 page-chat.js 之后加载，加载期取不到）；
     收藏馆复用票根。 */
  Sleepy.wjCurtainUI = {
    ticketEl: ticketEl,
    shareEl: shareEl,
    inviteEl: inviteEl,
    metaLine: metaLine
  };

})(window);
