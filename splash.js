/* splash.js — 冷启动开屏
   ============================================================
   它是 #phone 里的一层全屏遮罩（z-index:300，连状态栏一起盖住），
   和页面栈无关、不进 registry。跟着 bootHome 之后跑一段动画，
   sleepy 浮现、停一下，然后**自动**把遮罩摘掉，露出下面早就渲染好的
   桌面 —— 所以遮罩消失那一下不会白屏。全程不用点，点任意处只是**提前**结束。

   什么时候不播（两条，都拦在前面）：
     1. ?splash=0            显式关掉
     2. 减少动效             见下
   ?splash=1 可以强制播放（减少动效时也强制，调试用）。
   页面加载＝冷启动，所以不需要任何「已播过」标记。

   **为什么减少动效要自己拦**：style.css 里那条
   #phone[data-motion="off"] * { animation:none !important }
   只能干掉 **CSS 动画**，而本文件用的是 WAAPI（el.animate()）——
   它不受 CSS 的 animation 属性管辖，一刀切切不到。
   同理 prefers-reduced-motion 也要自己看。

   **为什么开头要接管一层预遮罩**：本文件排在 index.html 最后（defer），
   执行前 bootHome 已经把桌面渲染完了 —— 探针实测桌面 742ms 就画出来、
   遮罩 881ms 才插进来，中间那一百多毫秒用户看到的是空桌面，
   像是「先闪了一下主页才开始动画」。所以 index.html 里先写死一层夜色空壳
   （#splash-pre），**第一帧就是夜色**，本文件把它升级成正式遮罩。
   ⚠️ 三条早退路径都必须 bail() 掉它，否则「减少动效」的用户会被黑屏锁住。
   ============================================================ */
(function (global) {
  'use strict';

  var el = document.getElementById('splash-pre');
  /* 摘掉预遮罩。只在三条早退路径上调用（正常路径里它会被升级成 #splash）。 */
  function bail() { if (el && el.parentNode) el.parentNode.removeChild(el); }

  var Q = /[?&]splash=([01])/.exec(global.location.search);
  var FORCE = Q ? Q[1] : null;
  if (FORCE === '0') { bail(); return; }

  var phone = document.getElementById('phone');
  if (!phone) { bail(); return; }

  var motionOff = phone.getAttribute('data-motion') === 'off';
  var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (FORCE !== '1' && (motionOff || reduce)) { bail(); return; }

  /* **不写任何「已播过」标记**：
     本文件只在页面加载时执行一次，而页面加载就等于「冷启动」——
     站内切页走的是页面栈，永远不会重载，所以天然不会重播。
     再加一层 sessionStorage 只会带来副作用：刷新不播（调试时看不到第二遍）。
     真要关掉给 ?splash=0。 */

  /* ---------------- 节奏参数（要调就调这里） ---------------- */

  var CFG = {
    lead: 400,          /* 开场留白：只有夜色 */
    gapStart: 290,      /* 第 1→2 句的间隔（慢，读得清） */
    gapEnd: 105,        /* 最后两句之间的间隔（快，像潮水涌上来） */
    dur: 820,           /* 单句入场 */
    holdAfter: 220,     /* 十六句铺满后停一下 */
    out: 420,           /* 句子集体退场 */
    quiet: 220,         /* 「爱」出现前的静默 —— 这半秒才是"睡" */
    sloganIn: 780,      /* 「爱」入场 */
    sloganHold: 620,    /* 「爱」停住 */
    sloganOut: 470,     /* 「爱」在夜色里退场（不跟着天亮变色） */
    dawn: 580,          /* 天亮 */
    logoIn: 840,        /* sleepy 浮现 */
    logoLead: 150,      /* sleepy 在天亮**结束前** 150ms 就开始浮现（两件事咬在一起） */
    logoHold: 850,      /* sleepy 浮现完**停住**这一段 —— 然后自动收尾进桌面 */
    outFade: 420        /* 自动收尾的淡出：比点击跳过的 0.22s 长，夜色要化开而不是被切掉 */
  };

  /* 句子间隔是**递减**的：一开始 290ms（从容），最后 105ms（涌上来）。
     全程约 8.2 秒；sleepy 落定在 8.24s，再停 logoHold、淡出 outFade，
     约 9.5 秒进桌面。要再短只能减句子 —— 缩间隔会回到"看不清"的老问题上。 */

  /* ---------------- 十六句 ---------------- */
  /* x / y 是百分比锚点；o 是不透明度（做前后层次）；
     sm = 小一号；vert = 竖排；\n = 手工断行（断在哪，节奏就在哪） */

  var LINES = [
    { t: '前不见古人，后不见来者', x: 30, y: 9, sm: 1, o: .66 },
    { t: '乡音无改鬓毛衰', x: 80, y: 13, vert: 1, o: .72 },
    { t: '人生得一知己足矣', x: 22, y: 22, o: .80 },
    { t: '我们站着，不说话\n就十分美好', x: 54, y: 25, sm: 1, o: .68 },
    { t: 'When you are old\nand grey and full of sleep', x: 70, y: 31, sm: 1, o: .58 },
    { t: '近乡情更怯，\n不敢问来人', x: 52, y: 40, sm: 1, o: .62 },
    { t: '哀哀父母，生我劬劳', x: 21, y: 42, vert: 1, o: .80 },
    { t: "l'amor che move il sole\ne l'altre stelle", x: 60, y: 54, sm: 1, o: .56 },
    { t: '劝君更尽一杯酒，\n西出阳关无故人', x: 24, y: 56, sm: 1, o: .62 },
    { t: '执手相看泪眼，竟无语凝噎', x: 90, y: 64, vert: 1, o: .66 },
    { t: 'Your children are not\nyour children', x: 61, y: 67, sm: 1, o: .58 },
    { t: '在天愿作比翼鸟，\n在地愿为连理枝', x: 22, y: 71, sm: 1, o: .68 },
    { t: '海内存知己，天涯若比邻', x: 20, y: 82, sm: 1, o: .60 },
    { t: 'nox est perpetua\nuna dormienda', x: 58, y: 86, sm: 1, o: .56 },
    { t: '年年岁岁花相似，\n岁岁年年人不同', x: 80, y: 88, sm: 1, o: .64 },
    { t: 'Ognuno sta solo\nsul cuor della terra', x: 28, y: 94, sm: 1, o: .56 }
  ];

  var SLOGAN = '爱';
  var ECHO = 'love · amour · amore · amor';

  /* ---------------- 动画小工具 ---------------- */

  var EASE = 'cubic-bezier(.22,.61,.36,1)';
  var timers = [];
  var dead = false;

  function T(fn, ms) {
    timers.push(global.setTimeout(function () { if (!dead) fn(); }, ms));
  }
  function anim(node, frames, opts) {
    var o = { easing: EASE, fill: 'forwards' };
    for (var k in opts) o[k] = opts[k];
    return node.animate(frames, o);
  }

  /* ---------------- 接管预遮罩 ---------------- */

  if (el) {
    /* 换 id，往后所有样子由 style.css 的 #splash 说了算；
       内联那点样式（position/inset/z-index/背景）是给"第一帧"用的，这里一并摘掉 ——
       **不留两份样式**，改配色只改 CSS 一处。 */
    el.id = 'splash';
    el.removeAttribute('style');
  } else {
    /* 预遮罩缺席（有人删了 index.html 那一行）→ 自己建一个：
       只是会闪那一下桌面，功能不受影响。 */
    el = document.createElement('div');
    el.id = 'splash';
    phone.appendChild(el);
  }
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="sp-stage"></div><div class="sp-spot"></div><div class="sp-glow"></div>';

  var stage = el.querySelector('.sp-stage');
  var spot = el.querySelector('.sp-spot');
  var glow = el.querySelector('.sp-glow');

  /* 主题联动：天亮亮到**当前主题的底色**，sleepy 用**当前主题的强调色**。
     这样不管用户选的是青提玻璃、海盐还是夜灯，接回主界面都不会跳色。 */
  var cs = global.getComputedStyle(phone);
  function token(name, fallback) {
    var s = (cs.getPropertyValue(name) || '').trim();
    return s || fallback;
  }
  var NIGHT = '#0B1220';
  var BASE = token('--g-base', '#FFFFFF');
  var ACCENT = token('--g-accent', '#B08A5E');

  /* ---------------- 跳过 / 摘遮罩 ---------------- */

  function kill() {
    dead = true;
    timers.forEach(global.clearTimeout);
    timers = [];
    if (el.getAnimations) {
      el.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); });
    }
  }

  /* fade 是淡出时长（毫秒）。两条路走两个值：
     点击跳过用短的（要跟手），自动收尾用 CFG.outFade（要柔 —— 夜色化开，不是切掉）。 */
  function finish(fade) {
    if (!el.parentNode) return;
    kill();
    var ms = typeof fade === 'number' ? fade : 220;   /* 缺省 0.22s，和全站浮层退场同一档 */
    el.style.transition = 'opacity ' + ms + 'ms ' + EASE;
    el.style.opacity = '0';
    global.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, ms + 20);
  }

  /* 点任意处＝**提前**结束（不是唯一出口：logo 那一段还有自动收尾）。
     这里包一层而不是直接把 finish 当监听器 —— pointerdown 的实参是事件对象，
     会被当成 fade 传进去。 */
  el.addEventListener('pointerdown', function () { finish(); });

  /* ---------------- 十六句入场 ---------------- */

  var W = phone.clientWidth || 375;
  var H = phone.clientHeight || 700;
  var items = [];

  LINES.forEach(function (B) {
    var slot = document.createElement('div');
    slot.className = 'sp-slot';
    slot.style.left = B.x + '%';
    slot.style.top = B.y + '%';
    var w = document.createElement('span');
    w.className = 'sp-w' + (B.sm ? ' sm' : '') + (B.vert ? ' vert' : '');
    w.textContent = B.t;
    slot.appendChild(w);
    el.appendChild(slot);
    items.push({ w: w, B: B });
  });

  var n = items.length;
  var at = CFG.lead;    /* 每一句的出现时刻，逐句累加（间隔递减） */
  var lastAt = at;

  items.forEach(function (it, i) {
    var dx = (50 - it.B.x) / 100 * W;   /* 起点＝屏幕中心 → 从"深处"浮出来 */
    var dy = (50 - it.B.y) / 100 * H;
    T(function () {
      anim(it.w, [
        { opacity: 0, transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.42)', filter: 'blur(9px)' },
        { opacity: it.B.o, transform: 'translate(0,0) scale(1)', filter: 'blur(0)' }
      ], { duration: CFG.dur });
    }, at);
    lastAt = at;
    if (i < n - 1) {
      var k = n > 2 ? i / (n - 2) : 0;   /* 0→1：间隔从 gapStart 线性收到 gapEnd */
      at += CFG.gapStart + (CFG.gapEnd - CFG.gapStart) * k;
    }
  });

  var end = lastAt + CFG.dur + CFG.holdAfter;

  T(function () {
    items.forEach(function (it) {
      anim(it.w, [
        { opacity: it.B.o, transform: 'translate(0,0) scale(1)', filter: 'blur(0)' },
        { opacity: 0, transform: 'translate(0,0) scale(.58)', filter: 'blur(8px)' }
      ], { duration: CFG.out });
    });
  }, end);

  /* ---------------- 收尾：爱 → 天亮 → sleepy ----------------
     四拍，谁都不碰谁：
       1「爱」在夜色里退场（不跟着天亮变色，否则会像两个字叠着）
       2 天亮
       3 空一拍
       4 sleepy 才在光心里出现                                        */

  T(function () {
    T(function () {

      var slogan = document.createElement('div');
      slogan.className = 'sp-slogan';
      slogan.textContent = SLOGAN;
      el.appendChild(slogan);
      anim(slogan, [
        { opacity: 0, transform: 'translateY(-50%) scale(.93)', filter: 'blur(12px)' },
        { opacity: 1, transform: 'translateY(-50%) scale(1)', filter: 'blur(0)' }
      ], { duration: CFG.sloganIn });

      var echo = document.createElement('div');
      echo.className = 'sp-echo';
      echo.textContent = ECHO;
      el.appendChild(echo);
      T(function () {
        anim(echo, [{ opacity: 0 }, { opacity: .6 }], { duration: 900 });
      }, 700);

      T(function () {
        /* 第 1 拍 */
        anim(slogan, [
          { opacity: 1, transform: 'translateY(-50%) scale(1)' },
          { opacity: 0, transform: 'translateY(-50%) scale(.95)' }
        ], { duration: CFG.sloganOut });
        anim(echo, [{ opacity: .6 }, { opacity: 0 }], { duration: CFG.sloganOut });

        T(function () {
          /* 第 2 拍 */
          anim(el, [{ backgroundColor: NIGHT }, { backgroundColor: BASE }],
            { duration: CFG.dawn, easing: 'ease-in-out' });
          anim(stage, [{ opacity: 1 }, { opacity: 0 }], { duration: CFG.dawn });
          anim(glow, [{ opacity: 1 }, { opacity: 0 }], { duration: CFG.dawn });
          anim(spot, [
            { transform: 'translate(-50%,-50%) scale(1.5)', opacity: .8 },
            { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 }
          ], { duration: CFG.dawn });

          T(function () {
            /* 第 4 拍：sleepy 在天亮**还没结束**时就开始浮现（提前 logoLead）——
               让"天亮"和"名字出现"咬在一起，省掉那一段干等。 */
            var logo = document.createElement('div');
            logo.className = 'sp-logo';
            logo.textContent = 'sleepy';
            el.appendChild(logo);
            anim(logo, [
              { opacity: 0, transform: 'translateY(10px)', color: ACCENT },
              { opacity: 1, transform: 'translateY(0)', color: ACCENT }
            ], { duration: CFG.logoIn });

            /* 第 5 拍：**自动收尾**。等名字浮现完、停住 logoHold 那一下，
               自己摘遮罩进桌面 —— 整段动画不需要用户动任何手指。
               （没有这一步，遮罩会永久停在 sleepy 上，只能点一下才进得去。）
               放在这个回调里计时，所以它是"相对 logo 出现那一刻"算的，
               上面那条嵌套链怎么调都不会让这一步跑偏。 */
            T(function () { finish(CFG.outFade); }, CFG.logoIn + CFG.logoHold);
          }, CFG.dawn - CFG.logoLead);

        }, CFG.sloganOut + 60);

      }, CFG.sloganIn + CFG.sloganHold);

    }, CFG.quiet);
  }, end + CFG.out);

})(window);
