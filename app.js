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
  var sbTime = document.getElementById('sb-time');
  var sbBattery = document.getElementById('sb-battery');

  /* 没注册的 App 落到这里，保证点了不白屏（ROADMAP 1.6） */
  var PLACEHOLDER = {
    chat:     { title: '聊天',   hint: '这里会是你和角色的对话。' },
    moments:  { title: '朋友圈', hint: '角色愿意给你看的东西，会贴在这里。' },
    diary:    { title: '日记', hint: '写给你的日记，一页一天。' },
    memory:   { title: '记忆', hint: '你们聊过的事，会被收进这里。' },
    music:    { title: '音乐',   hint: '一起听点什么。' },
    contacts: { title: '浮岛', hint: '你在这部手机里造的那些世界。' },
    island:   { title: '浮岛', hint: '云海之上，你造的那些世界。' },
    settings: { title: '设置',   hint: 'API 配置、数据备份、聊天参数都在这里。' },
    support:  { title: '反馈',   hint: '有问题随时找我（联系方式待填）。' },
    /* 第 2 屏新换的两个 App（2026-09-19）—— 页面本体还没开工，
       先用占位页接着，等用户发来需求再注册真正的页面。 */
    phonecheck: { title: '查手机', hint: '角色翻看这部手机的地方，页面还没贴好。' },
    workshop:   { title: '工坊',   hint: '做小东西的地方，工具还没摆上来。' }
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

  /* ---- 报错 toast 的第一道闸：**不许出现我们自己的网址** ----
     产品规矩（用户 2026-09-22）：「里面不出现我们未来的网址」。
     原因是那种网址在用户的设备上不一定打得开（还没上线的域名、
     或者本机调试地址），写在报错里只会让人白点一下。
     所以统一在这里抹掉 —— 只在**报错路径**上抹（正常文案里要提线上地址
     的话仍然照写），抹掉之后用一句人话占位，别留空括号。 */
  var OWN_URL = /https?:\/\/[^\s"'<>()]*\b(?:[a-z0-9-]*\.)?sleepy(?:[-a-z0-9]*)?\.(?:pages\.dev|cn|com|app|net|dev|xyz)\b[^\s"'<>()]*/gi;
  var OWN_URL_BARE = /\b[a-z0-9-]*\.?sleepy[uU]?-?\d+\.pages\.dev\b/gi;

  function scrubOwnUrl(s) {
    var t = String(s == null ? '' : s);
    return t.replace(OWN_URL, '（本机地址已省略）').replace(OWN_URL_BARE, '（本机地址已省略）');
  }

  /* 报错卡：标题 + 可复制的正文 + 一个「复制」按钮。
     为什么不用同一颗胶囊：报错正文经常是服务商回的一大段 JSON
     （`model not found` / `invalid api key` 这种真正有用的信息都在里面），
     两颗字挤在一个会自己消失的胶囊里既读不完也复制不了。
     规则：带 detail 的 err 才升级成卡；普通提示（ok / warn / 无 detail 的 err）
     仍然是那颗小胶囊。 */
  function buildToastCard() {
    toastEl.innerHTML = '';
    toastEl.classList.add('is-card');
    var head = document.createElement('div');
    head.className = 'toast-head';
    head.textContent = '出错了';
    var body = document.createElement('div');
    body.className = 'toast-body';
    var acts = document.createElement('div');
    acts.className = 'toast-acts';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'toast-copy';
    copy.textContent = '复制';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = '知道了';
    acts.appendChild(copy);
    acts.appendChild(close);
    toastEl.appendChild(head);
    toastEl.appendChild(body);
    toastEl.appendChild(acts);
    toastEl.__body = body;

    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      var text = body.textContent || '';
      var done = function () {
        copy.textContent = '已复制';
        setTimeout(function () { copy.textContent = '复制'; }, 1400);
      };
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(text).then(done, fallbackCopy);
      } else {
        fallbackCopy();
      }
      /* 老浏览器 / 非安全上下文没有 clipboard API —— 退回选中文本，
         用户按 Ctrl/⌘+C 也能拿走（这就是「可复制」的兜底）。 */
      function fallbackCopy() {
        try {
          var r = document.createRange();
          r.selectNodeContents(body);
          var sel = global.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          done();
        } catch (err) { done(); }
      }
    });
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      hideToast();
    });
  }

  function hideToast() {
    if (!toastEl) return;
    toastEl.className = '';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  function toast(msg, kind, opts) {
    if (!toastEl) {
      if (!phone) return;
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      toastEl.setAttribute('role', 'status');
      phone.appendChild(toastEl);
    }
    opts = opts || {};
    /* 报错一律过一遍网址闸（普通文案不动） */
    var text = (kind === 'err') ? scrubOwnUrl(msg) : String(msg == null ? '' : msg);
    var detail = (kind === 'err' && opts.detail) ? scrubOwnUrl(opts.detail) : '';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    if (kind === 'err' && (detail || opts.copy)) {
      if (!toastEl.__body) buildToastCard();
      toastEl.__body.textContent = text + (detail ? '\n' + detail : '');
      toastEl.className = 'show err is-card';
      /* 报错卡不自己消失 —— 用户得有时间读完、复制 */
      return;
    }

    if (toastEl.__body) { toastEl.innerHTML = ''; toastEl.__body = null; }
    toastEl.classList.remove('is-card');
    toastEl.textContent = text;
    toastEl.className = 'show' + (kind ? ' ' + kind : '');
    /* 报错比普通提示多留一会儿 */
    toastTimer = setTimeout(function () { toastEl.className = ''; }, kind === 'err' ? 4200 : 2400);
  }

  /* 报错的两段式口子：`apiFail(msg, res)` —— 第一行是人话，
     第二行是服务商原文（可复制）。describeError 的返回值就是原文那一行。 */
  function apiFail(human, detail) {
    toast(human || '出错了', 'err', { detail: detail || '', copy: true });
  }

  /* ------------------------- 状态栏 / 问候 ------------------------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function tickTime() {
    if (!sbTime) return;
    var now = new Date();
    sbTime.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  }

  /* 问候语原来贴在首页的 <header class="greet"> 里。
     首页现在整个是桌面（4 屏网格），没有地方放它，
     而且桌面的角色卡已经把「现在是谁、什么状态」表达得更准。
     留着这段逻辑是为了「关于」页以后要用（时段问候），不再往首页画。 */
  function greetingOf(h) {
    if (h < 5)       return { t: '还没睡呀',   s: '灯还亮着' };
    if (h < 11)      return { t: '早上好',     s: '刚醒，还在找眼镜' };
    if (h < 14)      return { t: '中午好',     s: '刚吃完饭' };
    if (h < 18)      return { t: '下午好',     s: '在忙，晚点回你' };
    if (h < 23)      return { t: '晚上好',     s: '刚到家' };
    return { t: '晚安，睡睡', s: '今天的本子已经贴好了' };
  }

  function initBattery() {
    if (!sbBattery) return;
    if (!navigator.getBattery) { sbBattery.textContent = ''; return; }
    navigator.getBattery().then(function (b) {
      function up() { sbBattery.textContent = Math.round(b.level * 100) + '%'; }
      up();
      b.addEventListener('levelchange', up);
    })['catch'](function () { sbBattery.textContent = ''; });
  }

  /* tickTime 会在 setInterval 里被反复调用，状态栏元素缺失时不能每 15 秒
     炸一次。tickTime / initBattery 都改成「查不到元素就安静跳过」，
     这样把 index.html 的状态栏拆掉或者做单页直开时，壳子依然能起来。 */
  tickTime();
  initBattery();
  if (sbTime) setInterval(tickTime, 15000);

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
      apiFail: apiFail,
      setTitle: function (t) { titleEl.textContent = t; },
      setActions: function (list) {
        sideEl.innerHTML = '';
        (list || []).forEach(function (a) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'head-act' +
            (a.kind ? ' head-act-' + a.kind : '') +
            (a.svg ? ' head-act-icon' : '');
          /* 图标按钮：svg 是页面里写死的字符串常量，不走用户输入 */
          if (a.svg) {
            b.innerHTML = a.svg;
            b.setAttribute('aria-label', a.label || '');
            b.title = a.label || '';
          } else {
            b.textContent = a.label;
          }
          if (a.disabled) b.disabled = true;
          /* 长按是**另一个动作**的入口（朋友圈的相机：微信的规矩是
             点击选图、长按发纯文字 —— 用户点名要这个交互）。
             判定跟桌面长按进编辑态同一套：按下起计时，移动超阈值就撤。 */
          if (typeof a.onLongPress === 'function') {
            var lpTimer = null, lpFrom = null;
            b.addEventListener('pointerdown', function (e) {
              if (e.button !== undefined && e.button !== 0) return;
              lpFrom = { x: e.clientX, y: e.clientY };
              lpTimer = setTimeout(function () {
                lpTimer = null;
                /* 长按已触发：紧跟着抬手会补一个 click，吞掉 ——
                   不然「长按发文字」之后又弹一次「选图发布」。 */
                b.__lpFired = true;
                safeCall(a.onLongPress, b);
              }, 480);
            });
            b.addEventListener('pointermove', function (e) {
              if (!lpTimer || !lpFrom) return;
              if (Math.abs(e.clientX - lpFrom.x) > 12 || Math.abs(e.clientY - lpFrom.y) > 12) {
                clearTimeout(lpTimer); lpTimer = null;
              }
            });
            var lpCancel = function () { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
            b.addEventListener('pointerup', lpCancel);
            b.addEventListener('pointercancel', lpCancel);
            b.addEventListener('pointerleave', lpCancel);
          }
          b.addEventListener('click', function (e) {
            if (b.__lpFired) { b.__lpFired = false; e.preventDefault(); return; }
            safeCall(a.onClick, b);
          });
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

  /* 页面实例是缓存复用的（build 只跑一次）。所以「同一个 id 带着不同参数
     再次打开」时必须把 body 重渲染一遍 —— 否则 render 的闭包里还捏着上
     一次的参数。真实后果：先看 A 预设、返回、再看 B，页面上还是 A 的内容，
     这时候点保存就把 A 的内容写进 B 了。
     参数没变就不重渲染（不然会打断正在流式的聊天页）。 */
  function sameParams(a, b) {
    try {
      return JSON.stringify(a || {}) === JSON.stringify(b || {});
    } catch (e) {
      return false;
    }
  }

  function applyParams(entry, params) {
    if (!entry || !entry.ctx) return;
    if (sameParams(entry.params, params)) return;
    entry.params = params || {};
    entry.ctx.params = entry.params;
    var def = entry.def;
    if (!def || typeof def.render !== 'function') return;
    entry.ctx.body.innerHTML = '';
    try {
      def.render(entry.ctx);
    } catch (e) {
      logError(e);
      entry.ctx.body.innerHTML =
        '<div class="empty"><div class="empty-paper"></div>' +
        '<p class="empty-text">这一页出错了</p>' +
        '<p class="empty-hint"></p></div>';
      entry.ctx.body.querySelector('.empty-hint').textContent = (e && e.message) || String(e);
    }
  }

  function open(id, params) {
    if (!id) return;

    /* 桌面是 bootHome 挂的**常驻底层**，不在页面栈里（见 bootHome）。
       所以谁 open('home') 都应该等于「回到桌面」，而不是真的再建一份 ——
       registry 里偏偏又注册着 'home'（page-desktop.js），不拦的话
       会 build 出第二个桌面叠上去，每一格组件都是重影
       （实测过：整屏组件错位叠着，像坏显像管）。 */
    if (id === 'home') {
      closeAll();
      return;
    }

    params = params || {};

    /* 已经在栈里就退回那一层，不重复压栈；但参数变了要先重渲染 */
    for (var i = 0; i < pageStack.length; i++) {
      if (pageStack[i].id !== id) continue;
      applyParams(pageStack[i], params);
      closeTo(i);
      return;
    }

    var entry = built[id];
    if (!entry) {
      entry = build(id, params);
      built[id] = entry;
      stack.appendChild(entry.el);
    } else {
      applyParams(entry, params);
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

  /* 一次清空整叠页面，回到底下的桌面。
     「降落」要用它：从配置台落到某间房，语义上是「整叠页面都不要了」。

     两个细节：
     1. 逐层用 closeTop(true) —— 传 true 跳过 histDrop()。
        否则每层都会 history.back()，而那是**异步**的，popstate 回来时
        又去动一次 pageStack，和这里的同步循环直接打架。
     2. 清完再 replaceState 把历史深度一次性归零。不这么做的话，
        用户按一次手机返回键会沿着一堆已关闭的记录往回走，
        看着像「返回键失灵」。 */
  function closeAll() {
    if (pageStack.length) {
      while (pageStack.length) closeTop(true);
      if (histOK) {
        try {
          global.history.replaceState({ sleepy: 'home', depth: 0 }, '',
            global.location.pathname + global.location.search);
        } catch (e) { histOK = false; }
      }
    }
    relayout();
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
    /* 页面可以自己接管返回（def.onBack 返回 true = 已处理）。
       典型：朋友圈那页停在朋友圈 tab 时，返回先切回消息 tab，
       而不是直接退回桌面（用户：「返回需要默认返回到 chat 的首页」）。
       历史栈不动，所以再按一次返回照常退回桌面，不会出现按不出 App。 */
    var top = current();
    if (top && top.def && typeof top.def.onBack === 'function') {
      try { if (top.def.onBack(top.ctx) === true) return; } catch (e) { /* 接管失败就走默认返回 */ }
    }
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
    /* 已经退到桌面还继续退（手机返回键 / iOS 边缘左滑）＝ 直接退出到浏览器，
       用户不想这样（「返回姿势而不是直接退出浏览器」）。
       补一条基线记录把自己顶住：在桌面上再按返回就停在原地，
       页面里的返回则照常逐层退（上一行的 close 循环先跑）。 */
    if (histOK && pageStack.length === 0) {
      try {
        global.history.pushState({ sleepy: 'home', depth: 0 }, '',
          global.location.hash || '#home');
      } catch (e) { histOK = false; }
    }
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

  /* --------------------- 软键盘避让（真机） ---------------------

     手机键盘弹起时**布局视口不动**，缩的只有 visualViewport；而
     position:fixed 的抽屉锚在布局视口底部 → 原地被键盘盖住。
     用户看到的正是这个：「点击输入框后键盘压住了输入框，要输入几个字
     才会上去」—— 那一下是浏览器等内容撑高之后自己滚的。

     所以自己把键盘高度算出来写进 --kb-inset，抽屉（.iol-drawer 等）
     拿它把自己抬到键盘上沿；聚焦的框再 scrollIntoView 一次，
     落点在弹起的那一帧就对了，不用等打字。

     只认 visualViewport（Chrome 61+ / Safari 13+）。没有这个 API 就
     整个不启用 —— 老浏览器维持原样，不会比现在更差。 */
  (function () {
    var vv = global.visualViewport;
    if (!vv) return;
    var root = document.documentElement;
    var raf = null;

    function sync() {
      raf = null;
      /* offsetTop 也要减：iOS 弹键盘时会把整个可视区往上顶，
         不减的话算出来的高度会少一截（抽屉正好又被盖住一点点）。 */
      var kb = Math.max(0, (global.innerHeight || vv.height) - vv.height - vv.offsetTop);
      /* 80px 以内基本是地址栏伸缩，不是键盘 —— 跟着抖会把界面顶得一跳一跳 */
      if (kb < 80) kb = 0;
      if (kb) root.style.setProperty('--kb-inset', kb + 'px');
      else root.style.removeProperty('--kb-inset');
      root.classList.toggle('kb-open', kb > 0);
    }
    function schedule() {
      if (raf) return;
      raf = global.requestAnimationFrame(sync);
    }
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);

    /* 键盘弹起后把正在编辑的框拉进可视区中间 ——
       抽屉里表单长，不拉的话焦点框可能正好压在键盘下沿。 */
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || !t.tagName) return;
      var tag = t.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      setTimeout(function () {
        if (document.activeElement !== t) return;   /* 已经点到别处了，别抢 */
        try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        catch (err) { /* 老浏览器不认参数对象，忽略 */ }
      }, 260);
    });
  })();

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.register = function (id, def) { registry[id] = def || {}; return def; };

  Sleepy.nav = {
    open: open,
    back: requestBack,
    /* ⚠️ 陷阱：closeTop() 内部会走 history.back()，而那是**异步**的。
       所以「同一个 tick 里先 closeTop() 再 open(别的页)」会被 popstate
       追上来，把刚开的那一页一起弹掉 —— 表现是「脚本点了 A，屏幕上却是 B」。
       要程序化切页请用 closeAll()（同步清栈 + 一次 replaceState），
       或者把两步拆到不同 tick（中间等一次 popstate）。 */
    closeTop: function () { closeTop(); },
    closeTo: closeTo,
    closeAll: closeAll,
    replace: replace,
    top: function () { var t = current(); return t ? t.id : null; },
    /* 栈顶那一页的 ctx。给「切完号要刷新当前页」这类场景用 ——
       页面挂的 ctx.refresh 就是它的 onShow（见上面 ctx 的定义）。
       没有这个出口的话，外面的模块只能靠 document 去猜当前是哪一页。 */
    topCtx: function () { var t = current(); return t ? t.ctx : null; },
    depth: function () { return pageStack.length; }
  };

  Sleepy.toast = toast;
  /* 报错专用（可复制、不过期、自动过网址闸）。页面里给 API 失败用这个，
     比 ctx.toast(describeError(res), 'err') 多出一个可复制的原文块。 */
  Sleepy.apiFail = apiFail;
  Sleepy.scrubOwnUrl = scrubOwnUrl;
  Sleepy.el = { phone: phone, stack: stack, home: home };
  Sleepy.historyOK = function () { return histOK; };

  /* 只读的注册表出口。scripts/smoke.js 靠它核对「哪些页面真的注册上了」——
     没有这个出口，冒烟只能猜注册表叫什么名字，改一次变量名就得改测试。
     registered() 返回一份快照，外面改不动内部状态。 */
  Sleepy.registered = function () {
    var out = {};
    for (var id in registry) {
      if (Object.prototype.hasOwnProperty.call(registry, id)) {
        out[id] = { title: registry[id] && registry[id].title, hasRender: !!(registry[id] && registry[id].render) };
      }
    }
    return out;
  };

  /* ---------------------------- 首页（基底页） ----------------------------

     首页和别的页面不一样：它是**基底**，不占页面栈 —— 其他页面叠上来时
     它靠 is-behind + --shift 往后让位，关闭后自己滑回来（见 relayout）。
     所以它的 <section> 是写在 index.html 里的静态元素，不经过 build()。

     代价是：build() 里那套「建元素 → 造 ctx → 调 render」的流程它享受不到，
     必须在这里单独走一遍。早先漏了这一步，结果是首页 section 永远是空的 ——
     桌面、4 屏网格、全部组件一个都画不出来，而状态栏时钟照常走
     （app.js 活着），所以看起来「像是没加载完」，很难一眼定位。

     为什么做成 Sleepy.bootHome() 而不是在这里直接调：
     本文件加载时 page-desktop.js 还没跑，registry['home'] 是空的。
     所以由最后注册 home 的那个文件（page-desktop.js）在注册完成后回调。 */
  var homeMounted = false;

  Sleepy.bootHome = function () {
    if (homeMounted) return true;
    var def = registry['home'];
    if (!def || !home) return false;

    /* 首页的 body 就是 section 本身（它不需要 .page-inner / .app-head 那套
       标题栏外壳 —— 桌面要占满整屏）。 */
    home.classList.add('is-active');

    var ctx = {
      id: 'home',
      el: home,
      body: home,
      params: {},
      store: Sleepy.store,
      toast: toast,
      apiFail: apiFail,
      setTitle: function () {},          /* 桌面没有标题栏，吞掉 */
      setActions: function () {},
      open: open,
      back: requestBack,
      closeTop: closeTop,
      closeTo: closeTo,
      replace: replace,
      /* 真实的重绘由 page-switch.js 的包装层挂上来（它要保住滚动位置）。
         这里先给个保底实现，避免包装层缺席时调用方炸掉。 */
      repaint: function () { Sleepy.bootHome.force(); }
    };

    try {
      if (typeof def.render === 'function') def.render(ctx);
    } catch (e) {
      logError(e);
      home.innerHTML =
        '<div class="empty"><div class="empty-paper"></div>' +
        '<p class="empty-text">桌面出错了</p>' +
        '<p class="empty-hint"></p></div>';
      var hint = home.querySelector('.empty-hint');
      if (hint) hint.textContent = (e && e.message) || String(e);
      return false;
    }

    homeMounted = true;
    /* 别的文件（page-switch.js）要给首页的 render 包一层，需要拿到 ctx */
    Sleepy.__homeCtx = ctx;
    return true;
  };

  relayout();

  /* 启动补算：到点的自动日记在这里写（page-diary 的 autoCheck 自带
     游标 + 时间比对 + 失败回滚），拖 5 秒等所有模块就位，失败静默。 */
  setTimeout(function () {
    try {
      if (Sleepy.diary && Sleepy.diary.autoCheck) {
        Sleepy.diary.autoCheck().then(function (r) {
          if (r && r.ok) toast('TA 悄悄写了一篇日记，去「日记」看看', 'ok');
        });
      }
    } catch (e) { /* 自动日记失败不影响启动 */ }
  }, 5000);

})(window);
