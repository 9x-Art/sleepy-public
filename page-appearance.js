/* ============================================================
   page-appearance.js — 外观（桌面外观系统 v2 · 草稿-保存模型）
   ------------------------------------------------------------
   管的是「整部手机长什么样」+「桌面怎么穿衣服」。

   v2（2026-09-19 用户反馈轮）定稿的交互模型：
     · 进页时把当前档快照成 **草稿**；
     · 页面里改任何东西都只改草稿 —— 预览卡实时跟着动，
       但存档、桌面、全 App 的主题**都不动**；
     · 底部「保存外观」按钮 → 一次性写档 + apply() 落 DOM。
     「我改了结果别的动了，预览没动」—— 反过来就对了：预览先动，
     其他等保存。

   其余语义：
     · 应用范围 = 全局默认 / 指定岛屿（**列出全部岛**选着改 ——
       外观是全局性 App，不绑当前激活岛）；岛只存覆盖过的键。
     · 配色/字号是全局的，范围只管桌面穿着（壁纸/图标/大字）。
     · 单 App 覆盖（appearance-app 子页）是独立操作、即时落档，
       不走草稿 —— 「应用名称」本身就是明确的保存动作。
     · 自定义字体 URL：字体文件直链（woff2/ttf/otf），
       @font-face 后挂在 --ff 队首（正文与界面），保存时加载。
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;

  /* 四套配色。chip 是那张色卡的预览渐变；bg 是预览卡的底（近似主题底色，
     预览不能依赖当前激活主题的变量 —— 草稿主题可能和激活主题不同）。 */
  var THEMES = [
    { id: 'grape', name: '纯白', hint: '纯白底 · 暖棕字 · 焦糖点缀',
      chip: 'linear-gradient(140deg,#B08A5E,#FFFFFF)',
      bg: 'linear-gradient(165deg,#FBFAF7 0%,#F1EDE4 100%)', dark: false },
    { id: 'night', name: '夜灯', hint: '深色，晚上看不刺眼',
      chip: 'linear-gradient(140deg,#7FC97A,#252F27)',
      bg: 'linear-gradient(165deg,#232E29 0%,#31403B 100%)', dark: true },
    { id: 'peach', name: '蜜桃', hint: '暖粉，软一点',
      chip: 'linear-gradient(140deg,#E8846B,#FFE6DC)',
      bg: 'linear-gradient(165deg,#F9E9E2 0%,#F4EDE3 100%)', dark: false },
    { id: 'sea', name: '海盐', hint: '冷蓝，安静',
      chip: 'linear-gradient(140deg,#4C86B8,#DCEAF6)',
      bg: 'linear-gradient(165deg,#E6EFF3 0%,#EDF0EA 100%)', dark: false }
  ];

  var FONTS = [
    { v: 0.92, name: '小' },
    { v: 1, name: '标准' },
    { v: 1.14, name: '大' }
  ];

  /* 桌面壁纸。auto = 不铺，用主题底色。dusk 是唯一深款（dark:true → is-dark-wall）。
     id 是存档键，别改。 */
  var WALLS = [
    { id: 'auto', name: '跟随主题', hint: '用主题底色', css: '' },
    { id: 'cream', name: '奶油', hint: '暖沙 · 米白 · 豆绿', css: 'linear-gradient(165deg,#E9DCC6 0%,#F7F2E8 52%,#D9E3D3 100%)' },
    { id: 'bloom', name: '蜜桃', hint: '暖粉，软一点', css: 'linear-gradient(165deg,#F2C9BB 0%,#FAE9DD 52%,#F6EFE6 100%)' },
    { id: 'tide', name: '海盐', hint: '浅冷，安静', css: 'linear-gradient(165deg,#C9DDE6 0%,#E7EEF0 52%,#EFF1EA 100%)' },
    { id: 'dusk', name: '暮色', hint: '深色，配夜灯正好', dark: true, css: 'linear-gradient(168deg,#2C3538 0%,#465857 55%,#8A7458 100%)' }
  ];

  /* App 图标整套风格。glass 是现在的样子（透明玻璃，透壁纸）。
     只换填充，不加光 —— 「不要每个 app 单独加光」是铁律。 */
  var ICONSTYLES = [
    { id: 'glass', name: '玻璃', hint: '透明，透出壁纸' },
    { id: 'line', name: '线框', hint: '描边，最轻' },
    { id: 'paper', name: '纸片', hint: '暖纸实底' },
    { id: 'night', name: '夜色', hint: '深底浅线' }
  ];

  var DEFAULTS = { theme: 'grape', fontScale: 1, motion: 'on', fontUrl: '' };
  var DDEF = { wall: 'auto', wallMediaId: '', icons: 'glass', large: false };

  /* ------------------------ 存档（保存按钮的落点） ------------------------ */

  function get() {
    var a = store.get('appearance') || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = a[k] === undefined || a[k] === null ? DEFAULTS[k] : a[k];
    });
    return out;
  }

  /* 兼容口子（子页 / 外部脚本用）。**主页面不从这里走** ——
     主页面走草稿，保存时 saveDraft() 直接写整档。 */
  function set(patch) {
    /* 直接在存档对象上打补丁 —— 不能用 get() 的输出写回：
       get() 只给缺省视图，照它写回会把 desktop / appOverrides 抹掉。 */
    var a = store.get('appearance') || {};
    Object.keys(patch || {}).forEach(function (k) { a[k] = patch[k]; });
    store.set('appearance', a);
    apply();
    return get();
  }

  /* ------------------------ 草稿 ------------------------ */

  var draft = null;

  function newDraft() {
    var a = store.get('appearance') || {};
    var d = a.desktop || {};
    draft = {
      theme: a.theme || 'grape',
      fontScale: a.fontScale === undefined ? 1 : a.fontScale,
      motion: a.motion || 'on',
      fontUrl: a.fontUrl || '',
      scope: d.scope === 'island' ? 'island' : 'global',
      selIsland: d.selIsland || '',
      desktop: {
        global: JSON.parse(JSON.stringify(d.global || {})),
        islands: JSON.parse(JSON.stringify(d.islands || {}))
      },
      dirty: false
    };
    /* 默认编辑上次选的岛；没选过就当前激活岛 */
    if (draft.scope === 'island' && !draft.selIsland) {
      draft.selIsland = activeIslandId();
    }
  }

  function markDirty() { if (draft) draft.dirty = true; }

  function activeIslandId() {
    try {
      var sb = Sleepy.core && Sleepy.core.activeSandbox();
      return sb ? sb.id : '';
    } catch (e) { return ''; }
  }

  /* 草稿的编辑目标。岛模式下必须已选岛；选的岛被删了回落全局。 */
  function draftTarget() {
    if (draft.scope === 'island' && draft.selIsland) {
      var alive = false;
      try {
        (Sleepy.core.listSandboxes() || []).forEach(function (s) {
          if (s.id === draft.selIsland) alive = true;
        });
      } catch (e) { /* 忽略 */ }
      if (alive) return { scope: 'island', sbId: draft.selIsland };
    }
    return { scope: 'global', sbId: '' };
  }

  function draftCfg(sbId) {
    var out = {};
    Object.keys(DDEF).forEach(function (k) { out[k] = DDEF[k]; });
    var g = draft.desktop.global || {};
    Object.keys(g).forEach(function (k) { if (g[k] !== undefined) out[k] = g[k]; });
    if (sbId) {
      var o = draft.desktop.islands[sbId] || {};
      Object.keys(o).forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; });
    }
    return out;
  }

  /* 草稿里某键是不是本岛覆盖（行注用） */
  function draftSource(key) {
    var t = draftTarget();
    if (t.scope !== 'island') return 'global';
    var o = draft.desktop.islands[t.sbId] || {};
    return o[key] !== undefined ? 'island' : 'global';
  }

  function draftSetDesk(patch) {
    var t = draftTarget();
    if (t.scope === 'island') {
      var o = draft.desktop.islands[t.sbId] = draft.desktop.islands[t.sbId] || {};
      Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
    } else {
      Object.keys(patch).forEach(function (k) { draft.desktop.global[k] = patch[k]; });
    }
    markDirty();
  }

  function draftResetIsland() {
    var t = draftTarget();
    if (t.scope === 'island') delete draft.desktop.islands[t.sbId];
    markDirty();
  }

  /* 保存：草稿 → 存档 → apply 落 DOM。**只有这里碰存档。** */
  function saveDraft() {
    var a = store.get('appearance') || {};
    a.theme = draft.theme;
    a.fontScale = draft.fontScale;
    a.motion = draft.motion;
    a.fontUrl = draft.fontUrl;
    a.desktop = {
      scope: draft.scope,
      selIsland: draft.selIsland,
      global: draft.desktop.global,
      islands: draft.desktop.islands
    };
    store.set('appearance', a);
    apply();
    draft.dirty = false;
  }

  /* ------------------------ 单 App 覆盖（独立操作，即时落档） ------------------------ */

  function overrides() { return (store.get('appearance') || {}).appOverrides || {}; }

  function appOverride(appKey) {
    if (!appKey) return null;
    return overrides()[appKey] || null;
  }

  function setOverride(appKey, patch) {
    var a = store.get('appearance') || {};
    a.appOverrides = a.appOverrides || {};
    if (patch === null) delete a.appOverrides[appKey];
    else {
      var o = a.appOverrides[appKey] = a.appOverrides[appKey] || {};
      Object.keys(patch).forEach(function (k) {
        if (patch[k] === '' || patch[k] === undefined) delete o[k];
        else o[k] = patch[k];
      });
      if (!Object.keys(o).length) delete a.appOverrides[appKey];
    }
    store.set('appearance', a);
    applyDesktop();   /* dock 只在桌面 render 时建一次，覆盖变了要原地刷 */
  }

  /* 桌面上实际有哪些 App（单 App 编辑页的名单） */
  function appList() {
    var out = [], seen = {};
    function push(key, label) {
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({ key: key, label: label || key });
    }
    try {
      var d = Sleepy.desktop ? Sleepy.desktop.getDesktop() : null;
      (d && d.pages || []).forEach(function (cells) {
        (cells || []).forEach(function (c) {
          if (c.type === 'app' && c.app) push(c.app, c.label);
        });
      });
    } catch (e) { /* 桌面数据没就位就只给底栏 */ }
    push('chat-list', '聊天');
    push('worldbook', '世界书');
    push('settings', '设置');
    return out;
  }

  /* ------------------------ 落 DOM ------------------------ */

  function apply() {
    var a = get();
    var phone = document.getElementById('phone');
    if (phone) {
      phone.setAttribute('data-theme', a.theme);
      phone.setAttribute('data-motion', a.motion === 'off' ? 'off' : 'on');
      phone.style.setProperty('--fs-scale', String(a.fontScale));
    }
    applyFont(a.fontUrl);
    applyDesktop();
    return a;
  }

  /* 自定义字体：字体文件直链 → @font-face 挂 --ff 队首。
     保存时才加载（草稿态不动全局）。 */
  function applyFont(url) {
    var old = document.getElementById('lk-custom-font');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!url) return;
    var st = document.createElement('style');
    st.id = 'lk-custom-font';
    st.textContent = "@font-face{font-family:'SleepyCustomFont';src:url('" +
      String(url).replace(/'/g, "%27") + "');font-display:swap;}" +
      "#phone{--ff:'SleepyCustomFont',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}";
    document.head.appendChild(st);
  }

  /* 已保存的桌面穿着 → DOM。page-desktop render 完也会喊一次
     （启动时 apply 跑得比 render 早，那时 .page 还不存在）。 */
  function applyDesktop() {
    var a = store.get('appearance') || {};
    var d = a.desktop || {};
    var sbId = '';
    if (d.scope === 'island') {
      try {
        var sb = Sleepy.core && Sleepy.core.activeSandbox();
        if (sb) sbId = sb.id;
      } catch (e) { /* 忽略 */ }
    }
    var phone = document.getElementById('phone');
    if (phone) {
      phone.setAttribute('data-icstyle', deskCfgOf(d, sbId).icons || 'glass');
    }
    var page = document.querySelector('.page[data-page="home"]');
    if (!page) return;
    var cfg = deskCfgOf(d, sbId);
    var wall = null;
    WALLS.forEach(function (w) { if (w.id === cfg.wall) wall = w; });

    /* dock 的单 App 覆盖：dock 只在桌面 render 时建一次，
       外观页里改了名字/图标就在这里原地刷（网格格子交给 onShow 的 repaint）。 */
    var dockIC = Sleepy.desktop && Sleepy.desktop.ICONS;
    Array.prototype.forEach.call(
      page.querySelectorAll('.dt-dock-btn[data-app]'),
      function (btn) {
        var key = btn.getAttribute('data-app');
        var ov = appOverride(key);
        var nameEl = btn.querySelector('.dt-dock-name');
        if (nameEl) nameEl.textContent = (ov && ov.name) || nameEl.textContent;
        var icEl = btn.querySelector('.dt-dock-ic');
        if (icEl) {
          if (ov && ov.iconMediaId && Sleepy.media) {
            var img = icEl.querySelector('img');
            if (!img) {
              img = h('img', 'w-app-ic-img');
              icEl.innerHTML = '';
              icEl.appendChild(img);
            }
            Sleepy.media.url(ov.iconMediaId).then(function (u) { if (u) img.src = u; });
          } else if (dockIC && dockIC[key]) {
            icEl.innerHTML = dockIC[key];
          }
        }
      });

    page.classList.toggle('is-dark-wall', !!(wall && wall.dark));
    /* 浅色壁纸 × 深色主题（夜灯 + 奶油 = 浅字压浅底）→ 强制深字 */
    page.classList.toggle('is-light-wall', !!(wall && !wall.dark && wall.css));
    page.classList.toggle('dt-large', !!cfg.large);

    if (cfg.wall === 'custom' && cfg.wallMediaId && Sleepy.media) {
      Sleepy.media.url(cfg.wallMediaId).then(function (u) {
        /* 自定义图上叠一层很淡的白纱：字要能读（桌面要「亮」） */
        page.style.backgroundImage = u
          ? 'linear-gradient(rgba(255,255,255,.16),rgba(255,255,255,.06)),url("' + u + '")'
          : '';
        page.style.backgroundSize = 'cover';
        page.style.backgroundPosition = 'center';
      });
    } else if (wall && wall.css) {
      page.style.backgroundImage = wall.css;
      page.style.backgroundSize = '';
      page.style.backgroundPosition = '';
    } else {
      page.style.backgroundImage = '';
      page.style.backgroundSize = '';
      page.style.backgroundPosition = '';
    }
  }

  /* 从存档形状（而非草稿）读桌面配置 —— 消费端（page-desktop）用 */
  function deskCfgOf(d, sbId) {
    var out = {};
    Object.keys(DDEF).forEach(function (k) { out[k] = DDEF[k]; });
    var g = d.global || {};
    Object.keys(g).forEach(function (k) { if (g[k] !== undefined) out[k] = g[k]; });
    if (sbId) {
      var o = (d.islands || {})[sbId] || {};
      Object.keys(o).forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; });
    }
    return out;
  }

  Sleepy.appearance = {
    get: get,
    set: set,
    apply: apply,
    THEMES: THEMES,
    WALLS: WALLS,
    ICONSTYLES: ICONSTYLES,
    applyDesktop: applyDesktop,
    deskCfg: function (sbId) { return deskCfgOf((store.get('appearance') || {}).desktop || {}, sbId); },
    appOverride: appOverride,
    setOverride: setOverride,
    appList: appList
  };

  /* ---------------------------- 屏：外观 ---------------------------- */

  /* 小开关（样式用 set-switch 那套） */
  function toggleRow(label, note, on, onChange) {
    var r = h('button', 'set-row');
    r.type = 'button';
    var main = h('span', 'set-row-main');
    main.appendChild(h('span', 'set-row-label', label));
    if (note) main.appendChild(h('span', 'set-row-hint', note));
    r.appendChild(main);
    var right = h('span', 'set-row-right');
    var lab = h('label', 'set-switch');
    var input = h('input');
    input.type = 'checkbox';
    input.checked = !!on;
    lab.appendChild(input);
    lab.appendChild(h('span', 'set-switch-track'));
    right.appendChild(lab);
    r.appendChild(right);
    lab.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('change', function () { onChange(input.checked); });
    r.style.cssText += 'border:0;';
    return r;
  }

  /* 四选格（壁纸/图标风格共用）。加一张「加号框」（选自定义图）由调用方追加。 */
  function choiceGrid(items, curId, onPick, swatchOf) {
    var grid = h('div', 'look-grid');
    items.forEach(function (it) {
      var b = h('button', 'look-card lk-choice' + (curId === it.id ? ' is-on' : ''));
      b.type = 'button';
      var sw = h('span', 'look-sw lk-swatch');
      sw.style.background = swatchOf(it);
      b.appendChild(sw);
      b.appendChild(h('span', 'look-card-name', it.name));
      b.appendChild(h('span', 'look-card-hint', it.hint || ''));
      b.addEventListener('click', function () { onPick(it); });
      grid.appendChild(b);
    });
    return grid;
  }

  function wallSwatch(w) {
    if (w.id === 'auto') return 'linear-gradient(140deg,#B08A5E33,#FFFFFF)';
    return w.css;
  }
  function iconSwatch(s) {
    return {
      glass: 'linear-gradient(160deg,rgba(255,255,255,.62),rgba(240,235,225,.28))',
      line: 'linear-gradient(160deg,#FFFFFF,#F4EFE7)',
      paper: 'linear-gradient(160deg,#F3EADC,#E9DBC4)',
      night: 'linear-gradient(160deg,#2E3A3C,#3D4B4A)'
    }[s.id] || '#eee';
  }

  /* 桌面缩微预览：**读草稿**，改什么立刻看见（保存模型的核心）。
     底色 = 壁纸 > 草稿主题近似底色（预览不依赖当前激活主题的变量 ——
     草稿主题可能和激活主题不同，字色一律显式给，不走 --g-ink）。 */
  function buildPreview() {
    var t = draftTarget();
    var cfg = draftCfg(t.sbId);
    var theme = null;
    THEMES.forEach(function (x) { if (x.id === draft.theme) theme = x; });
    var wall = null;
    WALLS.forEach(function (w) { if (w.id === cfg.wall) wall = w; });

    var dark = (wall && wall.dark) || (!wall || wall.id === 'auto') && theme && theme.dark;
    var pv = h('div', 'lk-preview' + (dark ? ' is-dark' : ''));
    if (wall && wall.id === 'custom' && cfg.wallMediaId && Sleepy.media) {
      pv.classList.add('has-img');
      Sleepy.media.url(cfg.wallMediaId).then(function (u) {
        if (u) pv.style.backgroundImage =
          'linear-gradient(rgba(255,255,255,.16),rgba(255,255,255,.06)),url("' + u + '")';
      });
    } else if (wall && wall.css) {
      pv.style.background = wall.css;
    } else {
      pv.style.background = (theme && theme.bg) || '#F6F2EA';
    }

    var top = h('div', 'lk-preview-top');
    top.appendChild(h('span', '', '13:41'));
    top.appendChild(h('span', '', 'Sleepy'));
    pv.appendChild(top);

    var hello = h('div', 'lk-preview-hello');
    hello.appendChild(h('b', '', '下午好'));
    hello.appendChild(h('span', '',
      t.scope === 'island' ? '这座岛的桌面' : '所有岛屿的默认桌面'));
    pv.appendChild(hello);

    var apps = h('div', 'lk-preview-apps');
    ['chat', 'moments', 'worldbook', 'settings'].forEach(function (k) {
      var cell = h('div', 'lk-preview-app');
      var icEl = h('span', 'w-app-ic lk-preview-ic');
      icEl.style.setProperty('--tk', '30px');
      var IC = Sleepy.desktop && Sleepy.desktop.ICONS;
      if (IC && IC[k]) icEl.innerHTML = IC[k];
      var ov = appOverride(k === 'chat' ? 'chat-list' : k);
      if (ov && ov.iconMediaId && Sleepy.media) {
        var img = h('img', 'w-app-ic-img');
        Sleepy.media.url(ov.iconMediaId).then(function (u) { if (u) img.src = u; });
        icEl.innerHTML = '';
        icEl.appendChild(img);
      }
      cell.appendChild(icEl);
      apps.appendChild(cell);
    });
    pv.appendChild(apps);

    var scopeText = t.scope === 'island' ? '正在编辑 · 这座岛' : '正在编辑 · 全局默认';
    if (t.scope === 'island') {
      try {
        (Sleepy.core.listSandboxes() || []).forEach(function (s) {
          if (s.id === t.sbId) scopeText = '正在编辑 · ' + (s.name || s.title || '这座岛');
        });
      } catch (e) { /* 忽略 */ }
    }
    pv.appendChild(h('div', 'lk-preview-tag', scopeText));
    return pv;
  }

  Sleepy.register('appearance', {
    title: '外观',
    render: function (ctx) {
      var body = ctx.body;
      newDraft();   /* 进页快照草稿；onShow 的刷新不重置（半截草稿保留） */

      function paint() {
        body.innerHTML = '';
        var t = draftTarget();

        /* ---- 应用范围 ---- */
        var g0 = group('应用范围', '改壁纸、图标、大字时对着谁改。配色和字号始终是全局的。');
        var seg = h('div', 'look-seg');
        [
          { v: 'global', n: '全局默认' },
          { v: 'island', n: '指定岛屿' }
        ].forEach(function (o) {
          var b = h('button', 'look-seg-btn' + (draft.scope === o.v ? ' is-on' : ''), o.n);
          b.type = 'button';
          b.addEventListener('click', function () {
            if (draft.scope === o.v) return;
            draft.scope = o.v;
            if (o.v === 'island' && !draft.selIsland) draft.selIsland = activeIslandId();
            markDirty();
            paint();
          });
          seg.appendChild(b);
        });
        g0.card.appendChild(seg);
        /* 岛列表：**全部岛**都列出来选 —— 外观是全局性 App，不绑当前激活岛 */
        var islandsRow = h('div', 'lk-islands');
        var islandList = [];
        try { islandList = Sleepy.core.listSandboxes() || []; } catch (e) { /* 忽略 */ }
        if (draft.scope === 'island') {
          if (!islandList.length) {
            islandsRow.appendChild(h('p', 'lk-notice', '还没有岛 —— 去浮岛 App 建一座。'));
          }
          islandList.forEach(function (s) {
            var nm = s.name || s.title || '未命名';
            var p = h('button', 'lk-pill' + (draft.selIsland === s.id ? ' on' : ''), nm);
            p.type = 'button';
            p.addEventListener('click', function () {
              draft.selIsland = s.id;
              markDirty();
              paint();
            });
            islandsRow.appendChild(p);
          });
          g0.card.appendChild(islandsRow);
        }
        var notice = h('p', 'lk-notice');
        if (t.scope === 'island') {
          var sbName = '这座岛';
          islandList.forEach(function (s) { if (s.id === t.sbId) sbName = s.name || s.title || sbName; });
          notice.innerHTML = '<b>' + sbName + '</b> 只覆盖本岛改过的项目，其余继续跟随全局。';
        } else {
          notice.innerHTML = '<b>全局默认</b>会被所有没单独设置的岛继承。';
        }
        g0.card.appendChild(notice);
        body.appendChild(g0.wrap);

        /* ---- 桌面预览（草稿实时） ---- */
        var gP = group('桌面预览', '改动先在这里看效果，点下面的「保存外观」才真正生效。');
        gP.card.appendChild(buildPreview());
        body.appendChild(gP.wrap);

        /* ---- 配色（全局） ---- */
        var g1 = group('配色', '换的是整套色板，整部手机的事 —— 不随岛变。');
        var wrap = h('div', 'look-grid');
        THEMES.forEach(function (th) {
          var b = h('button', 'look-card' + (draft.theme === th.id ? ' is-on' : ''));
          b.type = 'button';
          var sw = h('span', 'look-sw');
          sw.style.background = th.chip;
          b.appendChild(sw);
          b.appendChild(h('span', 'look-card-name', th.name));
          b.appendChild(h('span', 'look-card-hint', th.hint));
          b.addEventListener('click', function () {
            draft.theme = th.id;
            markDirty();
            paint();
          });
          wrap.appendChild(b);
        });
        g1.card.appendChild(wrap);
        body.appendChild(g1.wrap);

        /* ---- 桌面壁纸 ---- */
        var g2 = group('桌面壁纸', t.scope === 'island' ? '给这座岛铺一层。' : '全局的桌面壁纸，岛上没单独设就跟着这个。');
        var wallGrid = choiceGrid(WALLS, draftCfg(t.sbId).wall, function (it) {
          draftSetDesk({ wall: it.id });
          paint();
        }, wallSwatch);
        /* 加号框（表情包第一个那种）：贴在暮色旁边，点了选图 */
        var curCfg = draftCfg(t.sbId);
        var add = h('button', 'look-card lk-choice lk-add' + (curCfg.wall === 'custom' ? ' is-on' : ''));
        add.type = 'button';
        var addSw = h('span', 'look-sw lk-swatch lk-add-swatch');
        if (curCfg.wall === 'custom' && curCfg.wallMediaId && Sleepy.media) {
          /* 已选了图：格子里直接给缩略图 */
          var thumb = h('img', 'lk-add-thumb');
          Sleepy.media.url(curCfg.wallMediaId).then(function (u) { if (u) thumb.src = u; });
          addSw.appendChild(thumb);
        } else {
          addSw.appendChild(h('span', 'lk-add-plus', '+'));
        }
        add.appendChild(addSw);
        add.appendChild(h('span', 'look-card-name', '自定义图'));
        add.appendChild(h('span', 'look-card-hint',
          curCfg.wall === 'custom' ? '已设置 · 点按更换' : '从相册选一张'));
        var wfile = h('input');
        wfile.type = 'file';
        wfile.accept = 'image/*';
        wfile.style.display = 'none';
        add.appendChild(wfile);
        add.addEventListener('click', function () { wfile.click(); });
        wfile.addEventListener('change', function () {
          var f = wfile.files && wfile.files[0];
          if (!f || !Sleepy.media) return;
          ctx.toast('正在收进图库…', 'ok');
          Sleepy.media.shrink(f, 1080).then(function (r) {
            return Sleepy.media.put(r.blob, { w: r.w, h: r.h, name: '桌面壁纸' });
          }).then(function (id) {
            /* 图先落图库（图库是资产，不算外观改动），wall 指过去走草稿 */
            draftSetDesk({ wall: 'custom', wallMediaId: id });
            paint();
          }).catch(function (e2) {
            ctx.toast('没换成：' + (e2 && e2.message || '图片处理失败'), 'err');
          });
        });
        wallGrid.appendChild(add);
        if (curCfg.wall === 'custom') {
          var clr = h('button', 'lk-clear-custom', '移除自定义图，回到跟随主题');
          clr.type = 'button';
          clr.addEventListener('click', function () {
            draftSetDesk({ wall: 'auto', wallMediaId: '' });
            paint();
          });
          wallGrid.appendChild(clr);
        }
        g2.card.appendChild(wallGrid);
        body.appendChild(g2.wrap);

        /* ---- App 图标 ---- */
        var g3 = group('App 图标', t.scope === 'island' ? '这套风格只给这座岛。' : '整套换，单独改某个 App 在下面。');
        g3.card.appendChild(choiceGrid(ICONSTYLES, draftCfg(t.sbId).icons, function (it) {
          draftSetDesk({ icons: it.id });
          paint();
        }, iconSwatch));
        var enter = h('button', 'lk-enter');
        enter.type = 'button';
        var enMain = h('span', 'lk-enter-main');
        enMain.appendChild(h('span', 'lk-enter-name', '单独修改 App'));
        enMain.appendChild(h('span', 'lk-enter-sub', '上传图标、改桌面显示名称 · 即时生效'));
        enter.appendChild(enMain);
        enter.appendChild(h('span', 'lk-enter-arrow', '›'));
        enter.addEventListener('click', function () { ctx.open('appearance-app'); });
        g3.card.appendChild(enter);
        body.appendChild(g3.wrap);

        /* ---- 桌面体验 ---- */
        var g4 = group('桌面体验', '只影响桌面，不动 App 里面的字。');
        g4.card.appendChild(toggleRow('较大桌面文字', 'App 名称与桌面组件放大一档',
          draftCfg(t.sbId).large, function (v) {
            draftSetDesk({ large: v });
            paint();
          }));
        var mr = h('div', 'look-seg lk-mt');
        [{ v: 'on', n: '完整动效' }, { v: 'off', n: '减少动效' }].forEach(function (o) {
          var b = h('button', 'look-seg-btn' + (draft.motion === o.v ? ' is-on' : ''), o.n);
          b.type = 'button';
          b.addEventListener('click', function () {
            draft.motion = o.v;
            markDirty();
            paint();
          });
          mr.appendChild(b);
        });
        var motionWrap = h('div', 'lk-motion-row');
        motionWrap.appendChild(h('span', 'set-row-label', '完整桌面动效'));
        motionWrap.appendChild(h('span', 'set-row-hint', '岛屿切换、图标按压与过渡'));
        motionWrap.appendChild(mr);
        g4.card.appendChild(motionWrap);
        body.appendChild(g4.wrap);

        /* ---- 正文字号 · 字体（全局） ---- */
        var g5 = group('正文字号 · 字体', '只动「读的地方」：聊天气泡、朋友圈正文、日记。');
        var fr = h('div', 'look-seg');
        FONTS.forEach(function (f) {
          var b = h('button', 'look-seg-btn' + (draft.fontScale === f.v ? ' is-on' : ''), f.name);
          b.type = 'button';
          b.addEventListener('click', function () {
            draft.fontScale = f.v;
            markDirty();
            paint();
          });
          fr.appendChild(b);
        });
        g5.card.appendChild(fr);
        var demo = h('div', 'look-demo');
        demo.appendChild(h('div', 'look-demo-tag', '预览'));
        var demoText = h('p', 'look-demo-text',
          '她说明天要下雨，让我记得带伞。其实伞一直放在门口那把 —— 她只是想说点什么。');
        demoText.style.fontSize = 'calc(14px * ' + Number(draft.fontScale || 1) + ')';
        demo.appendChild(demoText);
        g5.card.appendChild(demo);
        /* 自定义字体 URL（字体文件直链） */
        g5.card.appendChild(h('label', 'off-field-label lk-field-label',
          '自定义字体（字体文件直链 · .woff2 / .ttf / .otf，留空 = 默认字体）'));
        var fontIn = h('input', 'lk-text-input');
        fontIn.placeholder = 'https://example.com/font.woff2';
        fontIn.value = draft.fontUrl || '';
        fontIn.setAttribute('autocapitalize', 'off');
        fontIn.setAttribute('autocorrect', 'off');
        fontIn.setAttribute('spellcheck', 'false');
        fontIn.addEventListener('change', function () {
          draft.fontUrl = String(fontIn.value || '').trim();
          markDirty();
        });
        g5.card.appendChild(fontIn);
        body.appendChild(g5.wrap);

        /* ---- 恢复本岛（草稿内） ---- */
        if (t.scope === 'island') {
          var hasOv = Object.keys(draft.desktop.islands[t.sbId] || {}).length > 0;
          if (hasOv) {
            var restore = h('button', 'lk-restore', '恢复这座岛并跟随全局');
            restore.type = 'button';
            restore.addEventListener('click', function () {
              draftResetIsland();
              paint();
            });
            body.appendChild(restore);
          }
        }

        /* ---- 保存 ---- */
        var save = h('button', 'lk-save' + (draft.dirty ? ' is-dirty' : ''));
        save.type = 'button';
        save.appendChild(h('span', 'lk-save-main',
          draft.dirty ? '保存外观' : '保存外观（没有改动）'));
        save.appendChild(h('span', 'lk-save-sub',
          draft.dirty ? '预览满意了就保存 —— 存档、桌面、主题一起换' : '现在的设置就是已保存的样子'));
        save.addEventListener('click', function () {
          if (!draft.dirty) { ctx.toast('没有要保存的改动', 'ok'); return; }
          saveDraft();
          paint();
          ctx.toast('外观已保存 · 桌面和主题都换好了', 'ok');
        });
        body.appendChild(save);

        body.appendChild(h('p', 'set-foot',
          '聊天气泡、聊天背景与角色主题仍在聊天设置中管理；' +
          '每间房自己的叙事配色在场景页的设置里；' +
          '单 App 的名称与图标在「单独修改 App」里即时生效，不走这里的保存。'));
      }

      paint();

      /* 从下级页回来重画一次（半截草稿保留 —— 只有重新进页才重置）。 */
      ctx.__lookRefresh = paint;
    },
    onShow: function (ctx) { if (ctx.__lookRefresh) ctx.__lookRefresh(); }
  });

  /* ------------------------ 屏：单独修改 App ------------------------ */

  Sleepy.register('appearance-app', {
    title: '单独修改 App',
    render: function (ctx) {
      var body = ctx.body;
      var selKey = ctx.params.appKey || '';

      function paint() {
        body.innerHTML = '';
        var list = appList();
        var IC = Sleepy.desktop && Sleepy.desktop.ICONS;

        /* ---- 选择要修改的 App ---- */
        var g1 = group('选择要修改的 App', '桌面网格和底栏里的都在这。');
        list.forEach(function (it) {
          var ov = appOverride(it.key);
          var row = h('button', 'lk-app-row' + (selKey === it.key ? ' is-on' : ''));
          row.type = 'button';
          var icEl = h('span', 'w-app-ic lk-app-ic');
          icEl.style.setProperty('--tk', '34px');
          if (ov && ov.iconMediaId && Sleepy.media) {
            var img = h('img', 'w-app-ic-img');
            Sleepy.media.url(ov.iconMediaId).then(function (u) { if (u) img.src = u; });
            icEl.appendChild(img);
          } else if (IC && IC[it.key]) {
            icEl.innerHTML = IC[it.key];
          } else {
            icEl.textContent = (it.label || '?').slice(0, 1);
          }
          row.appendChild(icEl);
          var main = h('span', 'lk-app-main');
          main.appendChild(h('span', 'lk-app-name',
            (ov && ov.name) || it.label));
          main.appendChild(h('span', 'lk-app-sub',
            ov ? '已自定义' : '默认'));
          row.appendChild(main);
          row.addEventListener('click', function () { selKey = it.key; paint(); });
          g1.card.appendChild(row);
        });
        body.appendChild(g1.wrap);

        /* ---- 编辑卡 ---- */
        if (!selKey) {
          body.appendChild(h('p', 'set-foot', '点上面一个 App 开始改。'));
          return;
        }
        var it2 = null;
        list.forEach(function (x) { if (x.key === selKey) it2 = x; });
        var ov2 = appOverride(selKey);

        var g2 = group('当前 App', '单 App 的修改优先于整套图标风格。');
        var hero = h('div', 'lk-editor-hero');
        var big = h('span', 'w-app-ic lk-editor-ic');
        big.style.setProperty('--tk', '56px');
        if (ov2 && ov2.iconMediaId && Sleepy.media) {
          var bimg = h('img', 'w-app-ic-img');
          Sleepy.media.url(ov2.iconMediaId).then(function (u) { if (u) bimg.src = u; });
          big.appendChild(bimg);
        } else if (IC && IC[selKey]) {
          big.innerHTML = IC[selKey];
        } else {
          big.textContent = ((it2 && it2.label) || '?').slice(0, 1);
        }
        hero.appendChild(big);
        var heroMain = h('div', 'lk-editor-main');
        heroMain.appendChild(h('b', '', (ov2 && ov2.name) || (it2 && it2.label) || selKey));
        heroMain.appendChild(h('small', '', ov2 ? '已自定义 · 桌面立即生效' : '跟随默认'));
        hero.appendChild(heroMain);
        g2.card.appendChild(hero);

        /* 名称 */
        g2.card.appendChild(h('label', 'off-field-label lk-field-label', '桌面显示名称'));
        var nameIn = h('input', 'lk-text-input');
        nameIn.maxLength = 8;
        nameIn.placeholder = '输入名称';
        nameIn.value = (ov2 && ov2.name) || '';
        g2.card.appendChild(nameIn);
        var applyName = h('button', 'lk-soft-btn', '应用名称');
        applyName.type = 'button';
        applyName.addEventListener('click', function () {
          setOverride(selKey, { name: String(nameIn.value || '').trim() });
          ctx.toast('名称改好了 · 回桌面就能看到', 'ok');
          paint();
        });
        g2.card.appendChild(applyName);

        /* 图标 */
        var up = h('label', 'lk-upload');
        up.appendChild(h('span', 'lk-upload-main', '上传自定义图标'));
        var ifile = h('input');
        ifile.type = 'file';
        ifile.accept = 'image/*';
        ifile.style.display = 'none';
        up.appendChild(ifile);
        up.addEventListener('click', function (e) { e.preventDefault(); ifile.click(); });
        ifile.addEventListener('change', function () {
          var f = ifile.files && ifile.files[0];
          if (!f || !Sleepy.media) return;
          ctx.toast('正在收进图库…', 'ok');
          Sleepy.media.shrink(f, 240).then(function (r) {
            return Sleepy.media.put(r.blob, { w: r.w, h: r.h, name: '图标 · ' + selKey });
          }).then(function (id) {
            setOverride(selKey, { iconMediaId: id });
            ctx.toast('图标换好了', 'ok');
            paint();
          }).catch(function (e2) {
            ctx.toast('没换成：' + (e2 && e2.message || '图片处理失败'), 'err');
          });
        });
        g2.card.appendChild(up);

        /* 恢复默认 */
        if (ov2) {
          var reset = h('button', 'lk-danger-btn', '恢复默认');
          reset.type = 'button';
          reset.addEventListener('click', function () {
            ui.confirm({
              title: '恢复默认？',
              note: '这个 App 的自定义名称和图标都会清掉，重新跟随整套风格。',
              ok: '恢复',
              danger: true
            }).then(function (yes) {
              if (!yes) return;
              setOverride(selKey, null);
              ctx.toast('已恢复默认', 'ok');
              paint();
            });
          });
          g2.card.appendChild(reset);
        }
        body.appendChild(g2.wrap);

        body.appendChild(h('p', 'set-foot',
          '改的是「这张桌面上怎么显示」，App 里的功能跟名字无关；' +
          '回桌面（或切一次屏）就能看到新名字新图标。'));
      }

      paint();
      ctx.__appRefresh = paint;
    },
    onShow: function (ctx) { if (ctx.__appRefresh) ctx.__appRefresh(); }
  });

  /* 加载完立刻应用一次 —— 不调的话刷新页面会**闪回默认配色**。 */
  apply();

})(window);
