/* ============================================================
   msgcenter.js — 消息通知中心（顶部「正在输入」横幅 + 新消息弹窗）

   挂在 #phone 上、独立于页面栈。被两类来源调用：
     · page-chat.js    —— 用户回合（发出后对方在生成 / 回复落库）
     · page-proactive.js —— 角色主动消息（后台生成 / 投递）

   对外接口（Sleepy.msgCenter）：
     typing({chatId, charId, name})   某会话开始「正在输入」
     typingStop({chatId})             结束输入
     incoming({chatId, charId, name, text})  一条新气泡到达
     recompute()                      导航变化后刷新可见性
     openChat(chatId)                 点通知跳进对应会话

   是否真正展示，由「当前是否正盯着这个会话」决定
   （看 Sleepy.__activeChatId + 导航栈顶），盯着的就不弹、不挡。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  var root = null;       /* #msg-center 容器 */
  var bannerEl = null;   /* 顶部「正在输入」横幅 */
  var popWrap = null;    /* 新消息弹窗堆叠容器 */
  var typingMap = {};    /* chatId -> { name, charId, ts } */
  var popups = [];       /* [{ chatId, charId, name, text, el, timer }] */
  var safety = {};       /* chatId -> 输入中保险定时器 */

  function phoneEl() { return document.getElementById('phone'); }

  function ensureRoot() {
    if (root) return root;
    var p = phoneEl();
    if (!p) return null;
    root = document.createElement('div');
    root.id = 'msg-center';
    root.setAttribute('aria-live', 'polite');

    bannerEl = document.createElement('div');
    bannerEl.className = 'mc-banner';
    bannerEl.style.display = 'none';
    bannerEl.addEventListener('click', function () {
      var k = bannerEl.getAttribute('data-chat');
      if (k) openChat(k);
    });

    popWrap = document.createElement('div');
    popWrap.className = 'mc-popwrap';

    root.appendChild(bannerEl);
    root.appendChild(popWrap);
    p.appendChild(root);
    return root;
  }

  /* 当前是否正盯着这个会话：既要是 chat-detail，又要 chatId 对得上。 */
  function isActive(chatId) {
    if (!chatId) return false;
    if (Sleepy.__activeChatId !== chatId) return false;
    var top = Sleepy.nav && Sleepy.nav.top && Sleepy.nav.top();
    return top === 'chat-detail';
  }

  function avatarOf(charId, name) {
    var nm = '';
    var ch = (Sleepy.core && Sleepy.core.findChar) ? Sleepy.core.findChar(charId) : null;
    nm = (ch && ch.name) || name || '';
    var av = document.createElement('div');
    av.className = 'mc-ava';
    av.textContent = nm ? nm.charAt(0) : '·';
    return av;
  }

  function typing(o) {
    o = o || {};
    if (!o.chatId) return;
    ensureRoot();
    typingMap[o.chatId] = {
      name: o.name || '对方',
      charId: o.charId || null,
      ts: Date.now()
    };
    if (safety[o.chatId]) clearTimeout(safety[o.chatId]);
    /* 保险：万一 typingStop 没被调到（异常分支漏了），120s 后自己收尾，
       免得「正在输入」卡死在顶端。 */
    safety[o.chatId] = setTimeout(function () { typingStop({ chatId: o.chatId }); }, 120000);
    renderBanner();
  }

  function typingStop(o) {
    o = o || {};
    if (!o.chatId) return;
    if (typingMap[o.chatId]) delete typingMap[o.chatId];
    if (safety[o.chatId]) { clearTimeout(safety[o.chatId]); delete safety[o.chatId]; }
    renderBanner();
  }

  function incoming(o) {
    o = o || {};
    if (!o.chatId) return;
    if (isActive(o.chatId)) return;   /* 正盯着，消息自己看得到，不弹 */
    ensureRoot();

    /* 同一会话已有的弹窗先撤，避免刷屏 */
    dismissPop(o.chatId, true);

    var el = document.createElement('div');
    el.className = 'mc-pop';
    el.appendChild(avatarOf(o.charId, o.name));

    var mid = document.createElement('div');
    mid.className = 'mc-pop-mid';
    var nm = document.createElement('div');
    nm.className = 'mc-pop-name';
    nm.textContent = o.name || '对方';
    var tx = document.createElement('div');
    tx.className = 'mc-pop-text';
    tx.textContent = String(o.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 48) || '发来了一条消息';
    mid.appendChild(nm);
    mid.appendChild(tx);
    el.appendChild(mid);

    var go = document.createElement('div');
    go.className = 'mc-pop-go';
    go.textContent = '查看';
    el.appendChild(go);

    el.addEventListener('click', function () { openChat(o.chatId); });
    popWrap.appendChild(el);

    requestAnimationFrame(function () { el.classList.add('is-in'); });
    var timer = setTimeout(function () { dismissPopEl(el); }, 5200);
    el.__timer = timer;
    popups.push({
      chatId: o.chatId, charId: o.charId, name: o.name, text: o.text, el: el, timer: timer
    });

    /* 同一时刻最多 3 张，超出把最旧的即时撤掉 */
    while (popups.length > 3) dismissPopEl(popups[0].el, true);
  }

  function dismissPopEl(el, immediate) {
    if (!el) return;
    if (el.__timer) { clearTimeout(el.__timer); el.__timer = null; }
    var still = popups.filter(function (p) { return p.el !== el; });
    popups = still;
    if (!el.parentNode) return;
    if (immediate) {
      el.parentNode.removeChild(el);
      return;
    }
    el.classList.remove('is-in');
    el.classList.add('is-out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
  }

  function dismissPop(chatId, immediate) {
    popups.slice().forEach(function (p) {
      if (p.chatId === chatId) dismissPopEl(p.el, immediate);
    });
  }

  function openChat(chatId) {
    if (!chatId) return;
    /* 立即让这条会话「变活跃」，先把它的横幅 / 弹窗收掉，避免点完还闪一下 */
    if (typingMap[chatId]) delete typingMap[chatId];
    dismissPop(chatId, true);
    renderBanner();
    if (Sleepy.nav && Sleepy.nav.open) Sleepy.nav.open('chat-detail', { chatId: chatId });
  }

  function renderBanner() {
    if (!bannerEl) return;
    var list = [];
    for (var k in typingMap) {
      if (!typingMap.hasOwnProperty(k)) continue;
      if (isActive(k)) continue;             /* 正盯着这个会话，不挡 */
      list.push({ chatId: k, info: typingMap[k] });
    }
    if (!list.length) {
      bannerEl.style.display = 'none';
      bannerEl.removeAttribute('data-chat');
      return;
    }
    list.sort(function (a, b) { return b.info.ts - a.info.ts; });
    var top = list[0];

    bannerEl.innerHTML = '';
    bannerEl.appendChild(avatarOf(top.info.charId, top.info.name));
    var txt = document.createElement('span');
    txt.className = 'mc-banner-text';
    var label = top.info.name + ' 正在输入';
    if (list.length > 1) label += '（还有 ' + (list.length - 1) + ' 位）';
    txt.textContent = label;
    bannerEl.appendChild(txt);

    var dots = document.createElement('span');
    dots.className = 'mc-dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    bannerEl.appendChild(dots);

    bannerEl.setAttribute('data-chat', top.chatId);
    bannerEl.style.display = '';
  }

  function recompute() {
    renderBanner();
    /* 弹窗里若有「现已打开的会话」则撤掉 */
    popups.slice().forEach(function (p) {
      if (isActive(p.chatId)) dismissPopEl(p.el, true);
    });
  }

  Sleepy.msgCenter = {
    typing: typing,
    typingStop: typingStop,
    incoming: incoming,
    recompute: recompute,
    openChat: openChat
  };
})(typeof window !== 'undefined' ? window : this);
