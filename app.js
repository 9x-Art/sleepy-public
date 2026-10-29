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
    /* 注：yishenruju（以身入局）已在 page-yishenruju.js 注册为真实页面
       （档案架大厅），不再需要占位兜底条目。 */
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
  /* 本机调试地址：用户在自己设备上多半打不开，写在报错里也是白点。
     注释里那句「或者本机调试地址」之前只拦了品牌域名，localhost 漏了 —— 补上。 */
  var LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:[^\s"'<>()]*)/gi;

  function scrubOwnUrl(s) {
    var t = String(s == null ? '' : s);
    return t.replace(OWN_URL, '（本机地址已省略）')
            .replace(OWN_URL_BARE, '（本机地址已省略）')
            .replace(LOCAL_URL, '（本机地址已省略）');
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
    resetCardRefs();

    /* 头部一行：左 = 明确的原因（标题），右 = × 关闭按钮。
       原因不再写死「出错了」——由 toast() 把真实原因填进 .toast-title。 */
    var head = document.createElement('div');
    head.className = 'toast-head';
    var title = document.createElement('span');
    title.className = 'toast-title';
    var code = document.createElement('span');
    code.className = 'toast-code';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    head.appendChild(title);
    head.appendChild(code);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = 'toast-body';

    /* 底部：复制按钮。复制的是「[代码] 原因 + 技术细节」整段，
       用户直接粘回来就能定位（这就是「可复制的报错代码」）。 */
    var acts = document.createElement('div');
    acts.className = 'toast-acts';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'toast-copy';
    copy.textContent = '复制报错';
    acts.appendChild(copy);

    toastEl.appendChild(head);
    toastEl.appendChild(body);
    toastEl.appendChild(acts);
    toastEl.__title = title;
    toastEl.__code = code;
    toastEl.__body = body;
    toastEl.__copy = copy;
    toastEl.__close = close;
    toastEl.__report = '';

    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      var text = toastEl.__report || (title.textContent + '\n' + body.textContent);
      var done = function () {
        copy.textContent = '已复制';
        setTimeout(function () { copy.textContent = '复制报错'; }, 1400);
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

  /* 切回非卡提示时，把卡内部的引用一并清空，避免残留旧节点的 handler。 */
  function resetCardRefs() {
    toastEl.__title = null;
    toastEl.__code = null;
    toastEl.__body = null;
    toastEl.__copy = null;
    toastEl.__close = null;
    toastEl.__report = '';
  }

  /* 报错码：稳定、短、能贴回来定位。优先用调用方给的 code，
     其次用请求阶段（config/http/timeout/network/parse）映射，
     再其次按人话关键词猜，最后兜底成 APP-XXXX（内容哈希，仍稳定可复现）。 */
  function firstLine(s) {
    var t = String(s == null ? '' : s);
    var i = t.indexOf('\n');
    return (i >= 0 ? t.slice(0, i) : t).trim() || t.trim();
  }
  function hash4(s) {
    var h = 0, t = String(s || '');
    for (var i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) >>> 0; }
    return ('000' + (h % 10000).toString(36)).slice(-4).toUpperCase();
  }
  function errCodeOf(opts, text) {
    if (opts && opts.code) return String(opts.code).toUpperCase();
    var stage = opts && opts.stage;
    if (stage === 'config') return 'CFG';
    if (stage === 'http') return 'HTTP' + (opts.status != null ? '-' + opts.status : '');
    if (stage === 'timeout') return 'TIMEOUT';
    if (stage === 'network') return 'NET';
    if (stage === 'parse') return 'PARSE';
    var t = String(text || '').toLowerCase();
    if (t.indexOf('超时') >= 0) return 'TIMEOUT';
    if (t.indexOf('连不上') >= 0 || t.indexOf('网络') >= 0) return 'NET';
    if (t.indexOf('配置') >= 0 || t.indexOf('key') >= 0 || t.indexOf('密钥') >= 0) return 'CFG';
    if (t.indexOf('json') >= 0) return 'PARSE';
    if (t.indexOf('http') >= 0) return 'HTTP';
    return 'APP-' + hash4(text);
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
    var errMode = (kind === 'err');
    /* 报错一律过一遍网址闸（普通文案不动） */
    var text = errMode ? scrubOwnUrl(msg) : String(msg == null ? '' : msg);
    var detail = (errMode && opts.detail) ? scrubOwnUrl(opts.detail) : '';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    /* 所有报错都走这张卡：明确的原因 + 错误码 + 可复制的技术细节 + × 关闭。
       不再有「自己会消失的小胶囊」—— 那条正是用户说的「丑且原因不清」。 */
    if (errMode) {
      if (!toastEl.__body) buildToastCard();
      var code = errCodeOf(opts, text);
      var title = (opts && opts.title) ? String(opts.title) : firstLine(text);
      if (!title) title = '出错了';
      toastEl.__title.textContent = title;
      toastEl.__code.textContent = code;
      toastEl.__body.textContent = detail || text;   /* 没细节时，原因本身也可复制 */
      toastEl.__report = '[' + code + '] ' + title + (detail ? '\n' + detail : '');
      toastEl.className = 'show err is-card';
      /* 报错卡不自己消失 —— 用户读完、复制、点 × 才关 */
      return;
    }

    if (toastEl.__body) { toastEl.innerHTML = ''; resetCardRefs(); }
    toastEl.classList.remove('is-card');
    /* 可点击 toast（2026-10-08）：opts.onClick 给了就整条可点，点了先收再跳。
       上一次的点击手尾必须摘干净 —— toastEl 是复用的单例。 */
    if (toastEl.__onClick) {
      toastEl.removeEventListener('click', toastEl.__onClick);
      toastEl.__onClick = null;
    }
    toastEl.textContent = text;
    if (typeof opts.onClick === 'function') {
      var onToastTap = function () {
        hideToast();
        try { opts.onClick(); } catch (e) { /* 跳页失败不炸壳 */ }
      };
      toastEl.__onClick = onToastTap;
      toastEl.addEventListener('click', onToastTap);
      toastEl.style.cursor = 'pointer';
    } else {
      toastEl.style.cursor = '';
    }
    toastEl.className = 'show' + (kind ? ' ' + kind : '');
    /* 只有普通提示（ok / warn）会自动消失；报错不会走到这里 */
    toastTimer = setTimeout(function () { toastEl.className = ''; }, kind === 'warn' ? 3000 : 2200);
  }

  /* 报错的两段式口子：`apiFail(human, detail, opts)` —— 第一行是人话，
     第二行是服务商原文（可复制）。describeError 的返回值就是原文那一行。
     opts 可带 code / stage / status，用来生成报错卡上的错误码。 */
  function apiFail(human, detail, opts) {
    var o = opts || {};
    if (detail && !o.detail) o.detail = detail;
    if (!o.copy) o.copy = true;
    toast(human || '出错了', 'err', o);
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

  /* --------------------- iOS 安全区测量（2026-10-29 稳定化） ---------------------

     测量原理不变——为什么不能直接信 env(safe-area-inset-*)：
       · Safari 在 standalone（加到主屏）模式下，getComputedStyle 读 env()
         **恒为 0**，但 CSS 渲染出来的值是对的 —— 已知多年的 WebKit 怪癖；
       · iOS 26.1 还有一版回归（WebKit bug 301994）：PWA 里 env(top) 直接
         变 0、系统状态栏实体占位（26.2 修回）。
     两个坑的共性：**getComputedStyle 靠不住，渲染结果永远靠得住**。
     所以放两个 1px 探针元素，让 CSS 用 env() 撑它们的实际高度，
     再用 getBoundingClientRect 量渲染值。

     v284 起的稳定化改造（学 SullyOS 的原则，不搬它的代码）：
       · JS **不再直接写 --safe-top / --safe-bottom**（旧版绑在
         visualViewport.resize 上，键盘一弹就重测重写终值 —— 首屏
         「偏上、交互后下移」就是这么来的），只写 fallback 变量
         --safe-top-fb / --safe-bottom-fb，终值由 CSS 的
         max(env, fallback) 合成；
       · 顶底**分别缓存**（cachedTop / cachedBottom）：任意一边量到
         非零值就单独锁定，另一边继续有限重试，互不牵连；
       · 冷启动测量时序：立即、120ms、500ms、1500ms、3000ms 共五轮；
         期间**临时**监听 visualViewport.resize（只为抓「第一帧还没
         布局完」的晚到 inset），顶底都锁定或重试用尽后立即解除；
       · 冷启动结束后安全区不再监听任何东西。focusin/focusout/键盘
         开关/vv.scroll/切页/聊天滚动一概**不重测**、不清缓存；
       · 唯一的重测信号是 orientationchange：**只清内部测量缓存**，
         已发布的 fallback 保持不动（新姿态可信值到达前屏幕上的旧值
         继续用 —— 旋转瞬间就把 fallback 清 0 等于自己制造顶底栏
         跳变）；非零新值到达才替换该边，最终一轮仍为 0 才把该边
         正式发布成 0px；顶底独立处理；
       · 每轮测量带 generation 代次：旧轮的定时器回调 / resize 回调
         凭代次自证过期，过期回调不测量、不写 fallback、不清零、
         不停表、不摘新轮监听；
       · 3000ms 后仍为 0 就接受 0（iOS 26.1 那类「系统已把内容推开」
         的版本，0 本来就是对的）—— 不硬编码 59/34，不无限重试。
       · 相同数值不重复 setProperty（省一次无意义重排）。 */
  (function () {
    var d = document.documentElement;
    var ua = navigator.userAgent || '';
    var isIOS = /iP(hone|od|ad)/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return;
    d.classList.add('ios');
    if (navigator.standalone) d.classList.add('ios-pwa');

    /* 冷启动有限重试时刻表（首 immediate 已跑，这里是后续四轮）。
       到点全跑完仍未锁定 = 接受 0，停表停监听。 */
    var RETRY_MS = [120, 500, 1500, 3000];
    var generation = 0;        /* 测量轮代次：每开一轮 +1，旧轮回调凭它自证过期 */
    var cachedTop = null;      /* 本轮内部缓存；null = 该边本轮还没锁定。
                                  只在轮内/换轮时清，**不是**已发布的 fallback */
    var cachedBottom = null;
    var vvResizeOn = false;    /* 当前是否有活的 vv.resize 监听（最多一个） */
    var currentVvHandler = null;
    var timers = [];

    function probeEl(id, envCss) {
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'position:fixed;left:0;top:0;width:1px;' +
          'visibility:hidden;pointer-events:none;' + envCss;
        d.appendChild(el);
      }
      return el;
    }
    /* 只写 fallback。值没变就不写 —— 少一次无意义的样式重算。 */
    function writeFb(name, val, cache) {
      if (cache === val) return;
      d.style.setProperty(name, val + 'px');
    }
    function measureRound(gen) {
      if (gen !== generation) return;   /* 过期轮：不测、不写、不清、不停 */
      var top = 0, bottom = 0;
      try {
        top = probeEl('safe-probe-top',
          'height:env(safe-area-inset-top,0px)').getBoundingClientRect().height || 0;
        bottom = probeEl('safe-probe-bottom',
          'height:env(safe-area-inset-bottom,0px)').getBoundingClientRect().height || 0;
      } catch (e) { return; }      /* 量不出来就等下一轮，别写脏值 */
      /* 只有非零才算「可信」：替换该边 fallback 并锁定。
         中间轮次量到 0 不覆盖缓存（顶部先 59 后被 0 打回去 = 首屏跳动）。 */
      if (top > 0) {
        writeFb('--safe-top-fb', top, cachedTop);
        cachedTop = top;
      }
      if (bottom > 0) {
        writeFb('--safe-bottom-fb', bottom, cachedBottom);
        cachedBottom = bottom;
      }
      if (cachedTop !== null && cachedBottom !== null) stopColdStart();
    }
    function stopColdStart() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
      timers = [];
      if (vvResizeOn && global.visualViewport && currentVvHandler) {
        global.visualViewport.removeEventListener('resize', currentVvHandler);
      }
      vvResizeOn = false;
      currentVvHandler = null;
    }
    /* 最终一轮跑完仍未锁定（一直 0）的边：这时才把 fallback 正式发布
       成 0px。某边的新姿态 inset 可能真的是 0（横屏顶部 / 全面屏底部），
       只有测量证明它是 0，才允许把上一姿态的旧值替换掉。 */
    function zeroFb(name) {
      if (d.style.getPropertyValue(name) !== '0px') d.style.setProperty(name, '0px');
    }
    /* immediate=false：旋转后的新一轮不立即测 —— 旋转瞬间 env 可能还是
       旧姿态值，立即测会把旧值当成新值锁死；靠重试轮和晚到的 resize
       收敛。旋转时已发布的 fallback 保持不动。 */
    function startColdStart(immediate) {
      stopColdStart();                       /* 旧轮 timers + 旧监听全清 */
      generation++;                          /* 新轮代次 */
      var gen = generation;
      if (immediate !== false) measureRound(gen);  /* 冷启动立即一轮 */
      /* forEach 给每一轮单独的 last 闭包（var 在 for 里会全部串成 true） */
      RETRY_MS.forEach(function (ms, idx) {
        var last = idx === RETRY_MS.length - 1;
        timers.push(setTimeout(function () {
          if (gen !== generation) return;    /* 旧轮回调：什么都不碰 */
          measureRound(gen);
          /* 本轮最后一轮跑完仍未锁定的边：正式发布 0，停表停监听。 */
          if (gen === generation && last) {
            if (cachedTop === null) zeroFb('--safe-top-fb');
            if (cachedBottom === null) zeroFb('--safe-bottom-fb');
            stopColdStart();
          }
        }, ms));
      });
      /* 待测才需要监听（立即轮就双锁则不挂）；同一时刻最多一个。 */
      if (!vvResizeOn && global.visualViewport &&
          (cachedTop === null || cachedBottom === null)) {
        currentVvHandler = function () {
          if (gen !== generation) return;    /* 旧轮回调：不测 */
          if (cachedTop === null || cachedBottom === null) measureRound(gen);
        };
        global.visualViewport.addEventListener('resize', currentVvHandler);
        vvResizeOn = true;
      }
    }
    /* 旋转是唯一允许的重测信号（此刻键盘必然收起、inset 换了一套值）。
       只清内部测量缓存，**不动已发布的 fallback** —— 新姿态可信值到达
       前屏幕继续用旧值，顶底栏不跳；不立即测（旋转瞬间 env 可能还是
       旧姿态值），靠重试轮和晚到的 resize 收敛。 */
    global.addEventListener('orientationchange', function () {
      cachedTop = null;
      cachedBottom = null;
      startColdStart(false);
    });

    startColdStart(true);
  })();

  /* ---------------------------- 页面栈 ---------------------------- */

  /* 层级位移与压暗。方案B（纯淡入）下不再做横向位移（STEP 归零），
     进 app 时桌面纹丝不动；后台页只靠 --dim 轻微压暗给层级感，
     --shift 变量保留但恒为 0。 */
  var PAGE_STEP = 0, PAGE_MAX = 46, HOME_STEP = 0, HOME_MAX = 38;

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
        e.el.style.removeProperty('--dim');
      } else {
        e.el.classList.remove('is-active');
        e.el.classList.add('is-behind');
        e.el.style.setProperty('--shift', -Math.min(depth * PAGE_STEP, PAGE_MAX) + '%');
        /* 越深的页压得越暗，和视差一起把层级拉开；下限 .8 别黑过头。 */
        e.el.style.setProperty('--dim', Math.max(1 - depth * 0.05, 0.8));
      }
    }
    if (len) {
      home.classList.add('is-behind');
      home.style.setProperty('--shift', -Math.min(len * HOME_STEP, HOME_MAX) + '%');
      home.style.setProperty('--dim', Math.max(1 - len * 0.05, 0.8));
    } else {
      home.classList.remove('is-behind');
      home.style.removeProperty('--shift');
      home.style.removeProperty('--dim');
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

  function open(id, params, opts) {
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
      /* 表单页（contact-edit / mask-edit 这类「新建」入口）重开时必须重画：
         params 往往一模一样（{id:'', sandboxId}），applyParams 的同参短路
         会把上一次填了一半、已经保存过的旧 DOM 原样端回来 ——
         用户看到「点 + 还是上一个人」，保存时闭包里的旧花名册快照
         还会把别人顶出房间（实测过：群岛第二个 char 覆盖第一个）。
         页面在 def 上声明 freshOnOpen 即表示「我每次 open 都要全新 render」；
         不声明的页保持原样（有的页靠旧 DOM 保住输入草稿）。 */
      if (entry.def && entry.def.freshOnOpen) entry.params = null;
      applyParams(entry, params);
    }
    void entry.el.offsetWidth;
    pageStack.push(entry);
    relayout();
    /* replaceHist：调用方（replace）明确要求**原地替换**历史 ——
       用 replaceState 顶掉当前条目而不是再 push 一条。
       We 三页底栏切 Tab 靠它：反复切换不涨浏览器返回栈，
       按一次返回就能退出 We（不会沿着一串 Tab 切换记录倒放）。 */
    if (opts && opts.replaceHist) histReplace(id);
    else histPush(id);
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

  /* 用当前层替换栈顶（删除后跳转之类），不做来回动画。
     We 三页底栏（weNav）也用它切主 Tab —— 语义是「这层换成那层」，
     返回栈深度不变（见 replaceHist）。 */
  function replace(id, params) {
    /* 目标是紧邻的下一层（正文 push 的详情 / 门厅再「切」回去）→
       语义上就是**返回**：closeTop 弹一层并自己发 history.back()，
       历史不涨也不留死条目。绝不能走下面的 pop+open+histReplace ——
       那会把当前条目原地改写成和前一条一模一样，返回键第一下就成了死的。
       （closeTop 的 popstate 是异步的，但这里后续没有同 tick 的 open，
       不踩「closeTop 再 open 被追上」的坑。） */
    var below = pageStack.length >= 2 ? pageStack[pageStack.length - 2] : null;
    if (below && below.id === id) { closeTop(); return; }

    var e = pageStack.pop();
    var popped = !!e;
    if (e) {
      safeCall(e.def && e.def.onHide, e.ctx);
      e.el.style.transition = 'none';
      e.el.classList.remove('is-active', 'is-behind');
      void e.el.offsetWidth;
      e.el.style.transition = '';
    }
    var before = pageStack.length;
    open(id, params, { replaceHist: popped });
    /* open 的 push 分支自己会喊 onShow（栈加深一层就是它）；
       但「目标已经在栈里」的分支只 closeTo、**不喊 onShow** ——
       从深层 Tab 切回下层页面时会看到旧数据。replace 语义上等于
       「切到这一页」，这种情况在这里补喊一次（幂等：onShow 是重读重画）。
       histReplace 只在 closeTo 一层都没弹时补（history.back 未落地，
       此时不能动历史）；弹过层的深分支维持原状（罕见路径）。 */
    if (pageStack.length <= before) {
      var top = current();
      if (top) {
        safeCall(top.def && top.def.onShow, top.ctx);
        if (popped && pageStack.length === before) histReplace(top.id);
      }
    }
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
  /* 原地替换当前历史条目（不新增）。与 histPush 同构，只是 replaceState。 */
  function histReplace(id) {
    if (!histOK) return;
    try {
      global.history.replaceState({ sleepy: id, depth: pageStack.length }, '', '#' + id);
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

  /* --------------------- 安卓原生桥（2026-10-25 sleepy-android） ---------------------
     SleepyNative 由壳工程 addJavascriptInterface 注入，页面脚本运行前就位。
     浏览器/PWA 里没有它，下面这些挂载全是空调用，零影响。 */
  if (global.SleepyNative) {
    /* 物理返回键（Activity.onBackPressed → 这里）：页面栈逐层退；
       退无可退交回原生 moveTaskToBack（回桌面不杀进程，回来还是原样）。 */
    global.__sleepyBack = function () {
      if (pageStack.length > 0) { closeTop(); return; }
      try { global.SleepyNative.goHome(); } catch (e) { /* 桥缺席就随它去 */ }
    };
    /* OTA 更新结果（壳的 Updater 拉完版本回填 toast；失败也是一句话，不吵） */
    global.__sleepyUpdateResult = function (msg) {
      try { toast(String(msg || ''), 'ok'); } catch (e) { /* toast 不在就静默 */ }
    };
  }

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
      /* 键盘高度在、但没有任何**可见**输入框拿着焦点 = 残留值（iOS 收键盘
         不发 resize 那一类），当场清掉，别让底栏悬空顶在旧键盘高度上。 */
      if (kb && !isEditing()) kb = 0;
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

    /* 聚焦的框**真的被键盘盖住**时，才把它往上拉「刚好露出来」那么多 ——
       不居中、不整页滚、没盖住就一点都不碰。

       2026-09-23 用户：「点击大部分输入框都会上下页面移动」。原来这里是
       scrollIntoView({block:'center', behavior:'smooth'})：只要聚焦就把
       最近那个能滚的祖先滚到「焦点框摆屏幕正中」—— 于是点哪个输入框整页
       就上下跳一下（实测 11 个输入框里 7 个会跳，最多 1619px：表单页的
       .page 自己就是滚动容器）。它跟键盘其实没关系，桌面端也照跳。
       聊天页更明显：键盘弹起时它和 .chat-foot 的 --kb-inset 一起使劲，
       就成了「输入框要上下挪动几下才能贴合键盘」。

       现在的规矩：
         · 先算「有没有被盖住」—— 没盖住直接返回（绝大多数情况）；
         · 盖住了 → 只把最近那个滚动容器往下推刚好的距离（不再居中）；
         · 聊天输入框整个不归它管（.chat-foot 用 --kb-inset 抬，见 style.css）。 */
    function pullIntoView(t) {
      var r = t.getBoundingClientRect();
      /* 键盘上沿：有 keyboard 时 visualViewport 才会缩，用它；没有就退回 innerHeight */
      var edge = vv.height + vv.offsetTop;
      if (!edge) edge = global.innerHeight || 0;
      var gap = 12;
      if (r.bottom + gap <= edge) return;          /* 露得好好的，一点都不动 */
      var delta = r.bottom + gap - edge;
      var n = t.parentNode;
      for (; n && n !== document.body; n = n.parentNode) {
        if (!n.clientHeight) continue;
        var cs = global.getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) break;
      }
      if (!n || n === document.body) {
        var se = document.scrollingElement || root;
        n = (se.scrollHeight > se.clientHeight) ? se : null;
      }
      if (n) n.scrollTop += delta;
    }
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || !t.tagName) return;
      var tag = t.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      /* 聊天输入框的贴合是自己算的（--kb-inset 把整条底栏抬到键盘上沿）——
         这里再插一脚就是两个驱动源打架，表现是「要上下来回挪几下才贴合」。 */
      if (t.closest && t.closest('.chat-foot')) return;
      setTimeout(function () {
        if (document.activeElement !== t) return;   /* 已经点到别处了，别抢 */
        try { pullIntoView(t); } catch (err) { /* 算不出来就别动，别把页面搞坏 */ }
      }, 300);
    });

    /* 「此刻真的有输入框拿着焦点吗」—— 只认**当前活动页**里的输入框。
       页面退场只是 visibility:hidden（build 缓存复用，元素不卸载），
       退场页的 textarea 仍可能是 activeElement —— 只查 activeElement 的话，
       切页之后永远判成「有焦点」，下面的清理永远不跑
       （2026-10-28 用户：「切换页面之后底栏往上走」—— --kb-inset 残留）。 */
    function isEditing() {
      var a = document.activeElement;
      if (!a) return false;
      if (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA' && !a.isContentEditable) return false;
      var pg = a.closest ? a.closest('.page') : null;
      if (pg && !pg.classList.contains('is-active')) return false;
      return !!(a.offsetParent || (a.getClientRects && a.getClientRects().length));
    }
    function clearIfIdle() {
      if (isEditing()) return;
      if (root.style.getPropertyValue('--kb-inset')) root.style.removeProperty('--kb-inset');
      root.classList.remove('kb-open');
    }

    /* 键盘收起的兜底清理（2026-10-28 iOS 用户报「底栏太高，下面空一截」）：
       iOS PWA 里键盘收起**不一定**触发 visualViewport 的 resize（系统版本
       之间行为飘），--kb-inset 一旦残留，整条底栏就被悬空顶在键盘高度上，
       下面留一大截空 —— 而且不重开页面回不去。所以焦点离开输入框之后
       稍等一拍，确认没有任何**可见**输入框拿着焦点，就强制清掉。正常路径上
       sync() 已经清过了，这里只是兜住「事件没来」的那一类。 */
    document.addEventListener('focusout', function () {
      setTimeout(clearIfIdle, 400);
    });
    /* 切页兜底：页面栈切换**不产生 focusout**（退场页只是 visibility:hidden，
       焦点还挂在上面），但那一刻键盘必然已经收掉。借「点击」和「返回」
       这两个切页必经的信号，稍等一拍查一次 —— 500ms 要盖过切页动画。 */
    document.addEventListener('click', function () {
      setTimeout(clearIfIdle, 500);
    });
    global.addEventListener('popstate', function () {
      setTimeout(clearIfIdle, 500);
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
  var homeRetrying = false;
  var homeRetryTimer = null;

  Sleepy.bootHome = function () {
    if (homeMounted) return true;
    var def = registry['home'];
    if (!def || !home) {
      /* 点火可能跑在注册之前（脚本加载被打断 / 顺序异常时）——
         装不上桌面就是永久白屏，没有第二次机会（2026-09-26 真机 8-B：
         手机白屏而桌面端复现不出）。bootHome 幂等，定时重试装上为止。 */
      if (!homeRetrying) {
        homeRetrying = true;
        var tries = 0;
        homeRetryTimer = setInterval(function () {
          tries++;
          if (Sleepy.bootHome() === true || tries > 40) {
            clearInterval(homeRetryTimer);
            homeRetrying = false;
          }
        }, 250);
      }
      return false;
    }

    /* 授权闸（账密系统 v2，2026-10-23）：进门先过授权 —— 账密是进入 sleepy
       的门槛，不是进去后在设置里补填的。未激活（none）或离线宽限 7 天过期
       （expired）时桌面不挂，把 page-license 的 licenseGate 画在 home 位，
       激活/登录成功回调 onPass → bootHome.force() 重进。
       判定唯一出处 repo.licenseGateState()。
       page-license.js 排在点火脚本之前正常必已就位；万一缺席则放行并
       console 一条 —— 闸自己挂了不能把所有人锁在门外。 */
    if (!Sleepy.licenseGate) {
      console.warn('[sleepy] license gate 缺席，本次放行');
    } else if (Sleepy.licenseGate.state() !== 'ok') {
      home.classList.add('is-active');
      Sleepy.licenseGate.mount(home, function () { Sleepy.bootHome.force(); });
      homeMounted = true;
      return true;
    } else {
      /* 已过闸：后台静默核对一次刷 lastVerifiedAt（宽限计时起点）。
         失败不卡人、不提示 —— 断网走宽限，这是 7 天宽限的本意。 */
      try { Sleepy.repo.licenseMe(function () {}); } catch (e) { /* 静默 */ }
    }

    /* 演示岛种子注入（2026-10-25，demo-seed.js）：一间房都没有的新用户
       落进预置的「云海工位」。必须排在 render 之前 —— 桌面 render 只跑
       一次（页面实例缓存复用），晚一步就按空存档画完、再也不纠偏。
       幂等：已有任何一间房（老存档/用户自建）直接跳过，失败静默不挡启动。 */
    try {
      if (Sleepy.demoSeed && Sleepy.demoSeed.ensure) Sleepy.demoSeed.ensure();
    } catch (e) { /* 种子失败不挡启动：用户手动建房即可 */ }

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

  /* 重进：授权闸过审 / 桌面需要整块重建时用（force 后 homeMounted 复位，
     bootHome 重走一遍）。repaint 的保底实现一直引用着这个 force 但从来没
     人定义过（一调就炸）—— 2026-10-23 随授权闸一起补上真身。 */
  Sleepy.bootHome.force = function () {
    homeMounted = false;
    if (home) home.innerHTML = '';
    Sleepy.bootHome();
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
