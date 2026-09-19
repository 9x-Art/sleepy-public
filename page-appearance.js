/* ============================================================
   page-appearance.js — 外观
   ------------------------------------------------------------
   管的是「整部手机长什么样」：配色 / 字号 / 动效。
   数据在 `appearance` 键里（store.js 里早就留了这个位置，
   但一直没人把它落到 DOM 上 —— 这个文件就是那个落点）。

   设计上的两条规矩：

   1. **只有 apply() 一个出口。** 页面里改完值不自己摸 DOM，
      store 写完调一次 apply()。以后加新的外观项也只在这里改一次 ——
      不然迟早出现「某个地方漏应用」，表现是「改了没反应」。

   2. **变量名不动，只灌新颜色。** 跟 style.css 开头那条注释同一个理由：
      整套样式表几百处引用 var(--g-ink) 之类，重命名等于全表返工。
      换主题 = 在 `#phone` 上覆盖那一组 `--g-*` 变量。
      别名（`--bg:var(--g-base)` 这类）会在**使用处**解析，
      所以覆盖 `--g-base` 会连带把 `--bg` 一起换掉，不用管两遍。
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;

  /* 四套配色。chip 是那张色卡的预览渐变（深→浅，能看出性格）。

     grape 的显示名原先是「米白」，2026-09-17 第二轮之后底已经改成纯白
     （用户：「桌面不要米白色的背景……其他默认白色」），名字跟着改 ——
     色卡上写「米白」而选出来是白的，是最容易让人以为点了没反应的那种错。
     **id 不能动**：它是存档里的键，改了所有人的主题设置会回落默认值。 */
  var THEMES = [
    { id: 'grape', name: '纯白', hint: '纯白底 · 暖棕字 · 焦糖点缀', chip: 'linear-gradient(140deg,#B08A5E,#FFFFFF)' },
    { id: 'night', name: '夜灯', hint: '深色，晚上看不刺眼', chip: 'linear-gradient(140deg,#7FC97A,#252F27)' },
    { id: 'peach', name: '蜜桃', hint: '暖粉，软一点', chip: 'linear-gradient(140deg,#E8846B,#FFE6DC)' },
    { id: 'sea', name: '海盐', hint: '冷蓝，安静', chip: 'linear-gradient(140deg,#4C86B8,#DCEAF6)' }
  ];

  var FONTS = [
    { v: 0.92, name: '小' },
    { v: 1, name: '标准' },
    { v: 1.14, name: '大' }
  ];

  var DEFAULTS = { theme: 'grape', fontScale: 1, motion: 'on' };

  function get() {
    var a = store.get('appearance') || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = a[k] === undefined || a[k] === null ? DEFAULTS[k] : a[k];
    });
    return out;
  }

  function set(patch) {
    var a = get();
    Object.keys(patch || {}).forEach(function (k) { a[k] = patch[k]; });
    store.set('appearance', a);
    apply();
    return a;
  }

  /* 把外观落到 DOM 上 —— **唯一出口**（见文件头注释）。 */
  function apply() {
    var a = get();
    var phone = document.getElementById('phone');
    if (!phone) return a;
    phone.setAttribute('data-theme', a.theme);
    /* 动效：关掉就直接在样式表里一刀切（见 style.css 那段），
       不逐个组件去停——逐个改一定会漏，漏掉那个就是「关不干净」。 */
    phone.setAttribute('data-motion', a.motion === 'off' ? 'off' : 'on');
    phone.style.setProperty('--fs-scale', String(a.fontScale));
    return a;
  }

  Sleepy.appearance = {
    get: get,
    set: set,
    apply: apply,
    THEMES: THEMES
  };

  /* ---------------------------- 屏 ---------------------------- */

  Sleepy.register('appearance', {
    title: '外观',
    render: function (ctx) {
      var body = ctx.body;

      function paint() {
        body.innerHTML = '';
        var cur = get();

        /* ---- 配色 ---- */
        var g1 = group('配色', '换的是整套色板，不是只换一个强调色。');
        var wrap = h('div', 'look-grid');
        THEMES.forEach(function (t) {
          var b = h('button', 'look-card' + (cur.theme === t.id ? ' is-on' : ''));
          b.type = 'button';
          var sw = h('span', 'look-sw');
          sw.style.background = t.chip;
          b.appendChild(sw);
          b.appendChild(h('span', 'look-card-name', t.name));
          b.appendChild(h('span', 'look-card-hint', t.hint));
          b.addEventListener('click', function () {
            set({ theme: t.id });
            paint();
            ctx.toast('换成「' + t.name + '」了', 'ok');
          });
          wrap.appendChild(b);
        });
        g1.card.appendChild(wrap);
        body.appendChild(g1.wrap);

        /* ---- 字号 ---- */
        var g2 = group('正文字号', '只动「读的地方」：聊天气泡、朋友圈正文、日记。');
        var fr = h('div', 'look-seg');
        FONTS.forEach(function (f) {
          var b = h('button', 'look-seg-btn' + (cur.fontScale === f.v ? ' is-on' : ''), f.name);
          b.type = 'button';
          b.addEventListener('click', function () {
            set({ fontScale: f.v });
            paint();
          });
          fr.appendChild(b);
        });
        g2.card.appendChild(fr);
        var demo = h('div', 'look-demo');
        demo.appendChild(h('div', 'look-demo-tag', '预览'));
        demo.appendChild(h('p', 'look-demo-text',
          '她说明天要下雨，让我记得带伞。其实伞一直放在门口那把 —— 她只是想说点什么。'));
        g2.card.appendChild(demo);
        body.appendChild(g2.wrap);

        /* ---- 动效 ---- */
        var g3 = group('动效', '关掉之后所有过渡和动画都不走，省电、也不晃眼。');
        var mr = h('div', 'look-seg');
        [{ v: 'on', n: '完整动效' }, { v: 'off', n: '减少动效' }].forEach(function (o) {
          var b = h('button', 'look-seg-btn' + (cur.motion === o.v ? ' is-on' : ''), o.n);
          b.type = 'button';
          b.addEventListener('click', function () {
            set({ motion: o.v });
            paint();
          });
          mr.appendChild(b);
        });
        g3.card.appendChild(mr);
        body.appendChild(g3.wrap);

        body.appendChild(h('p', 'set-foot',
          '外观是整部手机的事，不随房间变 —— 每间房自己的配色（如果有）' +
          '是沙盒主题，那是后面那一批。'));
      }

      paint();

      /* 从下级页回来（或者切号回来）重画一次，
         免得页面还显示着旧配色。 */
      /* 不用 ctx.rebuild 这个名字 —— 它是壳子的生命周期方法（见 app.js），
         覆盖掉会踩到别人。挂个自己的名字。 */
      ctx.__lookRefresh = paint;
    },
    onShow: function (ctx) { if (ctx.__lookRefresh) ctx.__lookRefresh(); }
  });

  /* 加载完立刻应用一次 —— 这一步不能省：不调的话刷新页面会**闪回默认配色**
     （store 里存的是夜灯，看到的却是青提），得点进外观页才生效。
     此刻 #phone 已经在 DOM 里了（它在 body 里、脚本之前）。 */
  apply();

})(window);
