/* ============================================================
   app.js — Sleepy 壳子
   职责：状态栏 / 问候语 / 页面注册表 / 页面栈 / 返回手势 / toast
   依赖：无（store.js 可选）
   被依赖：page-*.js（通过 Sleepy.register 注册）

   为什么不用 ES Module：D9 要求「双击就能开」，file:// 下
   <script type="module"> 会被 CORS 拦死。所以统一挂 window.Sleepy，
   靠 index.html 里的 script 顺序保证依赖。改顺序前先看这里。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  var phone = document.getElementById('phone');
  var stack = document.getElementById('stack');
  var home = document.querySelector('.page[data-page="home"]');
  var edgeHint = document.getElementById('edge-hint');
  var sbTime = document.getElementById('sb-time');
  var sbBattery = document.getElementById('sb-battery');
  var greetTitle = document.querySelector('.greet-title');
  var greetSub = document.querySelector('.greet-sub');

  /* 没注册的 App 落到这里，保证点了不白屏（ROADMAP 1.6） */
  var PLACEHOLDER = {
    chat:     { title: '字条',   hint: '这里会是你和她的对话。' },
    moments:  { title: '拼贴墙', hint: '她愿意给你看的东西，会贴在这里。' },
    diary:    { title: '手账本', hint: '她写给你的日记，一页一天。' },
    memory:   { title: '回忆页', hint: '你们聊过的事，会被收进这里。' },
    music:    { title: '磁带',   hint: '一起听点什么。' },
    contacts: { title: '名片夹', hint: '你在这部手机里认识的人。' },
    settings: { title: '设置',   hint: 'API 配置、数据备份、人设预设都在这里。' },
    support:  { title: '反馈',   hint: '有问题随时找我（联系方式待填）。' }
  };

  var registry = {};
  var built = {};
  var pageStack = [];

  function logError(e) {
    if (global.console && global.console.error) global.console.error('[Sleepy]', e);
  }
  function safeCall(fn, arg) {
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (e) { logError(e); }
  }

  /* ---------------------------- toast ---------------------------- */

  var toastEl = null;
  var toastTimer = null;

  function toast(msg, kind) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      toastEl.setAttribute('role', 'status');
      phone.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 2400);
  }

  /* ------------------------- 状态栏 / 问候 ------------------------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function tickTime() {
    var now = new Date();
    sbTime.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  }

  function applyGreeting() {
    var h = new Date().getHours();
    var t, s;
    if (h < 5)       { t = '还没睡呀';   s = '她也在熬夜'; }
    else if (h < 11) { t = '早上好';     s = '她刚醒，还在找眼镜'; }
    else if (h < 14) { t = '中午好';     s = '她刚吃完饭'; }
    else if (h < 18) { t = '下午好';     s = '她在忙，晚点回你'; }
    else if (h < 23) { t = '晚上好';     s = '她刚到家'; }
    else             { t = '晚安，睡睡'; s = '她在本子上贴好了今天'; }
    greetTitle.textContent = t;
    greetSub.textContent = s;
  }

  function initBattery() {
    if (!navigator.getBattery) { sbBattery.textContent = ''; return; }
    navigator.getBattery().then(function (b) {
      function up() { sbBattery.textContent = Math.round(b.level * 100) + '%'; }
      up();
      b.addEventListener('levelchange', up);
    })['catch'](function () { sbBattery.textContent = ''; });
  }

  tickTime();
  applyGreeting();
  initBattery();
  setInterval(tickTime, 15000);
  setInterval(applyGreeting, 60000);

  /* ---------------------------- 页面栈 ---------------------------- */

  var PAGE_STEP = 9, PAGE_MAX = 27, HOME_STEP = 8, HOME_MAX = 24;

  function current() { return pageStack.length ? pageStack[pageStack.length - 1] : null; }

  function relayout() {
    var len = pageStack.length;
    for (var i = 0; i < len; i++) {
      var e = pageStack[i];
      var depth = len - 1 - i;
      e.el.style.zIndex = String(10 + i);
      if (depth === 0) {
        e.el.classList.add('is-active');
        e.el.classList.remove('is-behind');
        e.el.style.removeProperty('--shift');
      } else {
        e.el.classList.remove('is-active');
        e.el.classList.add('is-behind');
        e.el.style.setProperty('--shift', -Math.min(depth * PAGE_STEP, PAGE_MAX) + '%');
      }
    }
    if (len) {
      home.classList.add('is-behind');
      home.style.setProperty('--shift', -Math.min(len * HOME_STEP, HOME_MAX) + '%');
    } else {
      home.classList.remove('is-behind');
      home.style.removeProperty('--shift');
    }
    if (edgeHint) edgeHint.classList[len ? 'add' : 'remove']('show');
  }

  function build(id, params) {
    var def = registry[id] || null;
    var meta = PLACEHOLDER[id] || { title: id, hint: '这一页还没贴好。' };

    var el = document.createElement('section');
    el.className = 'page';
    el.setAttribute('data-page', id);
    el.innerHTML =
      '<div class="page-inner">' +
        '<div class="app-head">' +
          '<button class="back-btn" data-back type="button" aria-label="返回">&#8249;</button>' +
          '<h2 class="app-title"></h2>' +
          '<div class="app-head-side"></div>' +
        '</div>' +
        '<div class="app-body"></div>' +
      '</div>';

    var titleEl = el.querySelector('.app-title');
    var sideEl = el.querySelector('.app-head-side');
    var bodyEl = el.querySelector('.app-body');
    titleEl.textContent = (def && def.title) ? def.title : meta.title;

    var entry = { id: id, el: el, def: def, params: params || {} };

    var ctx = {
      id: id,
      el: el,
      body: bodyEl,
      params: entry.params,
      store: Sleepy.store,
      toast: toast,
      setTitle: function (t) { titleEl.textContent = t; },
      setActions: function (list) {
        sideEl.innerHTML = '';
        (list || []).forEach(function (a) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'head-act' + (a.kind ? ' head-act-' + a.kind : '');
          b.textContent = a.label;
          if (a.disabled) b.disabled = true;
          b.addEventListener('click', function () { safeCall(a.onClick, b); });
          sideEl.appendChild(b);
        });
      },
      open: open,
      back: requestBack,
      refresh: function () { safeCall(def && def.onShow, ctx); }
    };
    entry.ctx = ctx;

    el.querySelector('[data-back]').addEventListener('click', requestBack);

    if (!def) {
      bodyEl.innerHTML =
        '<div class="empty">' +
          '<div class="empty-paper"></div>' +
          '<p class="empty-text"></p>' +
          '<p class="empty-hint">这一页还没贴好 · 敬请期待</p>' +
        '</div>';
      bodyEl.querySelector('.empty-text').textContent = meta.hint;
      return entry;
    }

    /* 单个页面渲染炸了不能带走整个壳子 */
    try {
      if (typeof def.render === 'function') def.render(ctx);
    } catch (e) {
      logError(e);
      bodyEl.innerHTML =
        '<div class="empty"><div class="empty-paper"></div>' +
        '<p class="empty-text">这一页出错了</p>' +
        '<p class="empty-hint"></p></div>';
      bodyEl.querySelector('.empty-hint').textContent = (e && e.message) || String(e);
    }
    return entry;
  }

  function open(id, params) {
    if (!id) return;
    /* 已经在栈里就退回那一层，不重复压栈 */
    for (var i = 0; i < pageStack.length; i++) {
      if (pageStack[i].id === id) { closeTo(i); return; }
    }
    var entry = built[id];
    if (!entry) {
      entry = build(id, params);
      built[id] = entry;
      stack.appendChild(entry.el);
    } else {
      entry.params = params || entry.params;
      entry.ctx.params = entry.params;
    }
    void entry.el.offsetWidth;
    pageStack.push(entry);
    relayout();
    histPush(id);
    safeCall(entry.def && entry.def.onShow, entry.ctx);
  }

  function closeTop(fromPop) {
    var e = pageStack.pop();
    if (!e) return false;
    safeCall(e.def && e.def.onHide, e.ctx);
    e.el.classList.remove('is-active', 'is-behind');
    e.el.style.transform = '';
    relayout();
    if (!fromPop) histDrop();
    var top = current();
    if (top) safeCall(top.def && top.def.onShow, top.ctx);
    return true;
  }

  function closeTo(index) {
    while (pageStack.length - 1 > index) closeTop();
  }

  /* 用当前层替换栈顶（删除后跳转之类），不做来回动画 */
  function replace(id, params) {
    var e = pageStack.pop();
    if (e) {
      safeCall(e.def && e.def.onHide, e.ctx);
      e.el.style.transition = 'none';
      e.el.classList.remove('is-active', 'is-behind');
      void e.el.offsetWidth;
      e.el.style.transition = '';
    }
    open(id, params);
  }

  /* history.back() 是异步的：popstate 回来之前 pageStack 不会变。
     所以这里必须挡住重入 —— 否则快速连点两次返回会连着调两次 back()，
     一路退过 replaceState 留下的那条基线记录，把**整个页面**带出 App
     （file:// 下就是一页空白）。实机表现为：手抖连点返回，App 直接没了。 */
  var backPending = false;
  var backTimer = null;

  function clearBackPending() {
    backPending = false;
    if (backTimer) { clearTimeout(backTimer); backTimer = null; }
  }

  function requestBack() {
    if (!pageStack.length) return;
    if (backPending) return;              /* 上一次返回还没落地，忽略这次 */
    if (histOK) {
      backPending = true;
      /* 兜底：万一 popstate 没来（例如已经退到基线），别把返回永久锁死 */
      backTimer = setTimeout(clearBackPending, 700);
      try { global.history.back(); return; } catch (e) { clearBackPending(); histOK = false; }
    }
    closeTop();
  }

  /* --------------------- 安卓物理返回键 / 手势 --------------------- */

  var histOK = true;
  try {
    global.history.replaceState({ sleepy: 'home', depth: 0 }, '', global.location.hash || '');
  } catch (e) { histOK = false; }   /* file:// 下可能被拦，降级为纯内存栈 */

  function histPush(id) {
    if (!histOK) return;
    try {
      global.history.pushState({ sleepy: id, depth: pageStack.length }, '', '#' + id);
    } catch (e) { histOK = false; }
  }
  function histDrop() {
    if (!histOK) return;
    try { global.history.back(); } catch (e) { histOK = false; }
  }

  global.addEventListener('popstate', function (ev) {
    clearBackPending();          /* 这次返回已经落地，可以再接下一次了 */
    var st = ev.state;
    var target = (st && typeof st.depth === 'number') ? st.depth : 0;
    var guard = 0;
    while (pageStack.length > target && guard++ < 32) closeTop(true);
    relayout();
  });

  /* 边缘右滑返回。落在可交互元素上的不接管，否则会和按钮点击打架 */
  var dragging = null;
  var EDGE = 46;
  var CLOSE_AT = 72;

  function isInteractive(el) {
    return !!(el && el.closest &&
      el.closest('button,input,textarea,select,a,label,[data-no-drag]'));
  }

  function startDrag(x, y, target) {
    var top = current();
    if (!top || x > EDGE || isInteractive(target)) return;
    dragging = { x0: x, y0: y, x: x, page: top.el, t0: Date.now(), locked: false };
    top.el.classList.add('is-dragging');
  }

  function moveDrag(x, y) {
    if (!dragging) return;
    dragging.x = x;
    var dx = x - dragging.x0;
    var dy = y - dragging.y0;

    if (!dragging.locked) {
      /* 竖向滚动优先，别抢列表的滚动 */
      if (Math.abs(dy) > Math.abs(dx) + 8) { cancelDrag(); return; }
      if (dx > 8) dragging.locked = true;
    }
    if (dx > 0) dragging.page.style.transform = 'translateX(' + dx + 'px)';
  }

  function cancelDrag() {
    if (!dragging) return;
    var d = dragging;
    dragging = null;
    d.page.classList.remove('is-dragging');
    d.page.style.transform = '';
  }

  function endDrag() {
    if (!dragging) return;
    var d = dragging;
    dragging = null;
    var dx = d.x - d.x0;
    var dt = Date.now() - d.t0;
    d.page.classList.remove('is-dragging');
    d.page.style.transform = '';
    if (dx > CLOSE_AT || (dx > 40 && dt < 260)) requestBack();
  }

  document.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    startDrag(t.clientX, t.clientY, e.target);
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (dragging && dragging.locked && e.cancelable) e.preventDefault();
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });

  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);

  document.addEventListener('mousedown', function (e) { startDrag(e.clientX, e.clientY, e.target); });
  document.addEventListener('mousemove', function (e) { if (dragging) moveDrag(e.clientX, e.clientY); });
  document.addEventListener('mouseup', endDrag);

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-app]') : null;
    if (el) open(el.getAttribute('data-app'));
  });

  document.addEventListener('contextmenu', function (e) {
    if (e.target.closest && (e.target.closest('[data-app]') || e.target.closest('.page'))) {
      e.preventDefault();
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.register = function (id, def) { registry[id] = def || {}; return def; };

  Sleepy.nav = {
    open: open,
    back: requestBack,
    closeTop: function () { closeTop(); },
    closeTo: closeTo,
    replace: replace,
    top: function () { var t = current(); return t ? t.id : null; },
    depth: function () { return pageStack.length; }
  };

  Sleepy.toast = toast;
  Sleepy.el = { phone: phone, stack: stack, home: home };
  Sleepy.historyOK = function () { return histOK; };

  relayout();

})(window);
