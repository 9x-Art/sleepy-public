/* ============================================================
   page-appearance.js — 外观（桌面外观系统 v1）
   ------------------------------------------------------------
   管的是「整部手机长什么样」+「桌面怎么穿衣服」：
     · 配色主题（全局，四选）—— 跟以前一样，只有 apply() 一个出口；
     · 桌面壁纸 / App 图标风格 / 较大桌面文字 —— 支持「全局默认 +
       岛屿覆盖」：没单独设置的岛继承全局（demo 的 scope 模型）；
     · 单独修改某个 App 的桌面名称和图标（优先于整套风格）；
     · 正文字号 / 动效（原有）。

   设计上的两条老规矩不变：

   1. **只有 apply() 一个出口。** 页面里改完值不自己摸 DOM，
      store 写完调一次 apply()。桌面壁纸额外有 applyDesktop()，
      因为壁纸只能落在 .page[data-page="home"] 上 —— 桌面 render
      完成后也会喊一次它（启动时 .page 还不存在）。

   2. **变量名不动，只灌新颜色。** 主题还是「#phone 上覆盖 --g-*」。
      岛屿覆盖**只覆盖桌面穿着**（壁纸/图标/大字），不碰主题 ——
      主题是整部手机的事，这个语义用户定过，不改。
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;

  /* 四套配色。chip 是那张色卡的预览渐变（深→浅，能看出性格）。
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

  /* 桌面壁纸。auto = 不铺，用主题底色。
     四款都是「薄薄一层」的柔和渐变（亮——用户定过桌面要亮），
     dusk 是唯一的深款，dark:true 会让桌面挂 is-dark-wall 翻字。
     id 是存档键，别改。 */
  var WALLS = [
    { id: 'auto', name: '跟随主题', hint: '用主题底色', css: '' },
    { id: 'cream', name: '奶油', hint: '暖沙 · 米白 · 豆绿', css: 'linear-gradient(165deg,#E9DCC6 0%,#F7F2E8 52%,#D9E3D3 100%)' },
    { id: 'bloom', name: '蜜桃', hint: '暖粉，软一点', css: 'linear-gradient(165deg,#F2C9BB 0%,#FAE9DD 52%,#F6EFE6 100%)' },
    { id: 'tide', name: '海盐', hint: '浅冷，安静', css: 'linear-gradient(165deg,#C9DDE6 0%,#E7EEF0 52%,#EFF1EA 100%)' },
    { id: 'dusk', name: '暮色', hint: '深色，配夜灯正好', dark: true, css: 'linear-gradient(168deg,#2C3538 0%,#465857 55%,#8A7458 100%)' }
  ];

  /* App 图标整套风格。glass 是现在的样子（透明玻璃，透壁纸）。
     其余三款都是**换填充**，不加光 —— 「不要每个 app 单独加光」是铁律。 */
  var ICONSTYLES = [
    { id: 'glass', name: '玻璃', hint: '透明，透出壁纸' },
    { id: 'line', name: '线框', hint: '描边，最轻' },
    { id: 'paper', name: '纸片', hint: '暖纸实底' },
    { id: 'night', name: '夜色', hint: '深底浅线' }
  ];

  var DEFAULTS = { theme: 'grape', fontScale: 1, motion: 'on' };
  var DDEF = { wall: 'auto', wallMediaId: '', icons: 'glass', large: false };

  function get() {
    var a = store.get('appearance') || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = a[k] === undefined || a[k] === null ? DEFAULTS[k] : a[k];
    });
    return out;
  }

  function set(patch) {
    /* 直接在存档对象上打补丁 —— 不能用 get() 的输出写回：
       get() 只给三个老键的缺省视图，照它写回会把 desktop /
       appOverrides 这些后来加的兄弟键整个抹掉（点一次配色就丢桌面设置）。 */
    var a = store.get('appearance') || {};
    Object.keys(patch || {}).forEach(function (k) { a[k] = patch[k]; });
    store.set('appearance', a);
    apply();
    return get();
  }

  /* ------------------------ 桌面外观（范围模型） ------------------------
     appearance.desktop = {
       scope: 'global' | 'island',      编辑器当前对着谁改（会话状态，存档无妨）
       global: { wall, wallMediaId, icons, large },
       islands: { <sbId>: { 只存覆盖过的键 } }
     }
     读取时按岛合并：全局打底，岛的覆盖盖上去。 */

  function deskAll() { return (store.get('appearance') || {}).desktop || {}; }

  function deskScope() { return deskAll().scope === 'island' ? 'island' : 'global'; }

  function setDeskScope(v) {
    var a = store.get('appearance') || {};
    a.desktop = a.desktop || {};
    a.desktop.scope = v === 'island' ? 'island' : 'global';
    store.set('appearance', a);
  }

  function activeIslandId() {
    try {
      var sb = Sleepy.core && Sleepy.core.activeSandbox();
      return sb ? sb.id : '';
    } catch (e) { return ''; }
  }

  function deskCfg(sbId) {
    var d = deskAll();
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

  /* 当前编辑目标（scope + 岛 id）。岛模式下没降落在任何岛 = 只能看全局。 */
  function editTarget() {
    if (deskScope() === 'island') {
      var id = activeIslandId();
      if (id) return { scope: 'island', sbId: id };
    }
    return { scope: 'global', sbId: '' };
  }

  function setDesk(patch) {
    var t = editTarget();
    var a = store.get('appearance') || {};
    a.desktop = a.desktop || {};
    if (t.scope === 'island') {
      a.desktop.islands = a.desktop.islands || {};
      var o = a.desktop.islands[t.sbId] = a.desktop.islands[t.sbId] || {};
      Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
    } else {
      a.desktop.global = a.desktop.global || {};
      Object.keys(patch).forEach(function (k) { a.desktop.global[k] = patch[k]; });
    }
    store.set('appearance', a);
    applyDesktop();
  }

  /* 岛上某键是不是被本岛覆盖了（行注「本岛独立 / 跟随全局」用） */
  function deskSource(key) {
    var t = editTarget();
    if (t.scope !== 'island') return 'global';
    var o = (deskAll().islands || {})[t.sbId] || {};
    return o[key] !== undefined ? 'island' : 'global';
  }

  /* 岛恢复跟随全局：删掉整份覆盖 */
  function resetIsland(sbId) {
    var a = store.get('appearance') || {};
    if (a.desktop && a.desktop.islands) {
      delete a.desktop.islands[sbId];
      store.set('appearance', a);
    }
    applyDesktop();
  }

  /* ------------------------ 单 App 覆盖 ------------------------
     appearance.appOverrides = { <appKey>: { name, iconMediaId } }
     V1 是全局一份（不随岛）—— 桌面户型本来就是全局的。 */

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

  /* 桌面上实际有哪些 App（网格里的 + 底栏三个），单 App 编辑页的名单 */
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

  /* 把外观落到 DOM 上 —— 主题/动效/字号的**唯一出口**（老规矩）。
     壁纸/图标风格/大字单独走 applyDesktop()（见文件头）。 */
  function apply() {
    var a = get();
    var phone = document.getElementById('phone');
    if (phone) {
      phone.setAttribute('data-theme', a.theme);
      phone.setAttribute('data-motion', a.motion === 'off' ? 'off' : 'on');
      phone.style.setProperty('--fs-scale', String(a.fontScale));
    }
    applyDesktop();
    return a;
  }

  function applyDesktop() {
    var phone = document.getElementById('phone');
    if (phone) {
      var ic = deskCfg(deskScope() === 'island' ? activeIslandId() : '').icons;
      phone.setAttribute('data-icstyle', ic || 'glass');
    }
    var page = document.querySelector('.page[data-page="home"]');
    if (!page) return;
    var cfg = deskCfg(editTarget().sbId);
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
        if (nameEl) nameEl.textContent = (ov && ov.name) || btn.__dockName || nameEl.textContent;
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

  Sleepy.appearance = {
    get: get,
    set: set,
    apply: apply,
    THEMES: THEMES,
    WALLS: WALLS,
    ICONSTYLES: ICONSTYLES,
    /* 桌面穿着（page-desktop 消费） */
    applyDesktop: applyDesktop,
    deskCfg: deskCfg,
    appOverride: appOverride,
    setOverride: setOverride,
    appList: appList
  };

  /* ---------------------------- 屏：外观 ---------------------------- */

  /* 小开关（demo 的 toggle；样式用 set-switch 那套，不另起炉灶） */
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

  /* 四选格（壁纸/图标风格共用 demo 的 choice/swatch 结构，走 look-* 主题变量） */
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

  /* 桌面缩微预览：真实类名渲染（w-app-ic / w-hdr-day），
     换什么立刻能看见 —— demo 的 preview 段。 */
  function buildPreview(ctx) {
    var t = editTarget();
    var cfg = deskCfg(t.sbId);
    var theme = get().theme;
    var wall = null;
    WALLS.forEach(function (w) { if (w.id === cfg.wall) wall = w; });

    var pv = h('div', 'lk-preview' + (wall && wall.dark ? ' is-dark' : ''));
    if (wall && wall.css) pv.style.background = wall.css;
    else pv.style.background = 'linear-gradient(165deg,#F6F2EA,#EFE9DE)';

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

    var tag = h('div', 'lk-preview-tag',
      deskScope() === 'island' ? '正在编辑 · 这座岛' : '全局默认');
    pv.appendChild(tag);
    return pv;
  }

  Sleepy.register('appearance', {
    title: '外观',
    render: function (ctx) {
      var body = ctx.body;

      function paint() {
        body.innerHTML = '';
        var cur = get();
        var t = editTarget();
        var cfg = deskCfg(t.sbId);

        /* ---- 应用范围 ---- */
        var g0 = group('应用范围', '改壁纸、图标、大字时对着谁改。配色和字号始终是全局的。');
        var seg = h('div', 'look-seg');
        [
          { v: 'global', n: '全局默认' },
          { v: 'island', n: '这座岛' }
        ].forEach(function (o) {
          var b = h('button', 'look-seg-btn' + (deskScope() === o.v ? ' is-on' : ''), o.n);
          b.type = 'button';
          b.addEventListener('click', function () {
            setDeskScope(o.v);
            if (o.v === 'island' && !activeIslandId()) {
              ctx.toast('你还没降落在任何一座岛上 —— 先去浮岛进一间房', 'warn');
            }
            paint();
          });
          seg.appendChild(b);
        });
        g0.card.appendChild(seg);
        var notice = h('p', 'lk-notice');
        if (t.scope === 'island') {
          var sb = null;
          try {
            (Sleepy.core.listSandboxes() || []).forEach(function (s) { if (s.id === t.sbId) sb = s; });
          } catch (e) { /* 忽略 */ }
          notice.innerHTML = '<b>' + ((sb && (sb.name || sb.title)) || '这座岛') +
            '</b> 只覆盖本岛改过的项目，其余继续跟随全局。';
        } else {
          notice.innerHTML = '<b>全局默认</b>会被所有没单独设置的岛继承。';
        }
        g0.card.appendChild(notice);
        body.appendChild(g0.wrap);

        /* ---- 桌面预览 ---- */
        var gP = group('桌面预览', '穿着效果就地看一眼，不用来回切。');
        gP.card.appendChild(buildPreview(ctx));
        body.appendChild(gP.wrap);

        /* ---- 配色（全局，原有） ---- */
        var g1 = group('配色', '换的是整套色板，整部手机的事 —— 不随岛变。');
        var wrap = h('div', 'look-grid');
        THEMES.forEach(function (th) {
          var b = h('button', 'look-card' + (cur.theme === th.id ? ' is-on' : ''));
          b.type = 'button';
          var sw = h('span', 'look-sw');
          sw.style.background = th.chip;
          b.appendChild(sw);
          b.appendChild(h('span', 'look-card-name', th.name));
          b.appendChild(h('span', 'look-card-hint', th.hint));
          b.addEventListener('click', function () {
            set({ theme: th.id });
            paint();
            ctx.toast('换成「' + th.name + '」了', 'ok');
          });
          wrap.appendChild(b);
        });
        g1.card.appendChild(wrap);
        body.appendChild(g1.wrap);

        /* ---- 桌面壁纸 ---- */
        var g2 = group('桌面壁纸', t.scope === 'island' ? '给这座岛铺一层。' : '全局的桌面壁纸，岛上没单独设就跟着这个。');
        g2.card.appendChild(choiceGrid(WALLS, cfg.wall, function (it) {
          setDesk({ wall: it.id });
          paint();
        }, wallSwatch));
        /* 自定义桌面图 */
        var customSrc = h('span', 'lk-src', cfg.wall === 'custom'
          ? (deskSource('wall') === 'island' ? '本岛自定义图' : '全局自定义图') : '');
        var upRow = h('label', 'lk-upload');
        upRow.appendChild(h('span', 'lk-upload-main', '从相册选择桌面图片'));
        if (cfg.wall === 'custom' && cfg.wallMediaId) {
          var clr = h('span', 'lk-upload-clear', '移除');
          clr.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            setDesk({ wall: 'auto', wallMediaId: '' });
            paint();
          });
          upRow.appendChild(customSrc);
          upRow.appendChild(clr);
        }
        var file = h('input');
        file.type = 'file';
        file.accept = 'image/*';
        file.style.display = 'none';
        upRow.appendChild(file);
        upRow.addEventListener('click', function (e) { e.preventDefault(); file.click(); });
        file.addEventListener('change', function () {
          var f = file.files && file.files[0];
          if (!f || !Sleepy.media) return;
          ctx.toast('正在收进图库…', 'ok');
          Sleepy.media.shrink(f, 1080).then(function (r) {
            return Sleepy.media.put(r.blob, { w: r.w, h: r.h, name: '桌面壁纸' });
          }).then(function (id) {
            setDesk({ wall: 'custom', wallMediaId: id });
            paint();
            ctx.toast('桌面换好了', 'ok');
          }).catch(function (e2) {
            ctx.toast('没换成：' + (e2 && e2.message || '图片处理失败'), 'err');
          });
        });
        g2.card.appendChild(upRow);
        body.appendChild(g2.wrap);

        /* ---- App 图标 ---- */
        var g3 = group('App 图标', t.scope === 'island' ? '这套风格只给这座岛。' : '整套换，单独改某个 App 在下面。');
        g3.card.appendChild(choiceGrid(ICONSTYLES, cfg.icons, function (it) {
          setDesk({ icons: it.id });
          paint();
        }, iconSwatch));
        var enter = h('button', 'lk-enter');
        enter.type = 'button';
        var enMain = h('span', 'lk-enter-main');
        enMain.appendChild(h('span', 'lk-enter-name', '单独修改 App'));
        enMain.appendChild(h('span', 'lk-enter-sub', '上传图标、改桌面显示名称'));
        enter.appendChild(enMain);
        enter.appendChild(h('span', 'lk-enter-arrow', '›'));
        enter.addEventListener('click', function () { ctx.open('appearance-app'); });
        g3.card.appendChild(enter);
        body.appendChild(g3.wrap);

        /* ---- 桌面体验 ---- */
        var g4 = group('桌面体验', '只影响桌面，不动 App 里面的字。');
        g4.card.appendChild(toggleRow('较大桌面文字', 'App 名称与桌面组件放大一档',
          cfg.large, function (v) { setDesk({ large: v }); paint(); }));
        var mr = h('div', 'look-seg lk-mt');
        [{ v: 'on', n: '完整动效' }, { v: 'off', n: '减少动效' }].forEach(function (o) {
          var b = h('button', 'look-seg-btn' + (cur.motion === o.v ? ' is-on' : ''), o.n);
          b.type = 'button';
          b.addEventListener('click', function () {
            set({ motion: o.v });
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

        /* ---- 正文字号（原有） ---- */
        var g5 = group('正文字号', '只动「读的地方」：聊天气泡、朋友圈正文、日记。');
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
        g5.card.appendChild(fr);
        var demo = h('div', 'look-demo');
        demo.appendChild(h('div', 'look-demo-tag', '预览'));
        demo.appendChild(h('p', 'look-demo-text',
          '她说明天要下雨，让我记得带伞。其实伞一直放在门口那把 —— 她只是想说点什么。'));
        g5.card.appendChild(demo);
        body.appendChild(g5.wrap);

        /* ---- 恢复 / 脚注 ---- */
        if (t.scope === 'island') {
          var restore = h('button', 'lk-restore', '恢复这座岛并跟随全局');
          restore.type = 'button';
          restore.addEventListener('click', function () {
            ui.confirm({
              title: '恢复这座岛？',
              note: '本岛改过的壁纸、图标、大字都会清掉，重新跟随全局默认。',
              ok: '恢复'
            }).then(function (yes) {
              if (!yes) return;
              resetIsland(t.sbId);
              paint();
              ctx.toast('已恢复跟随全局', 'ok');
            });
          });
          body.appendChild(restore);
        }
        body.appendChild(h('p', 'set-foot',
          '聊天气泡、聊天背景与角色主题仍在聊天设置中管理；' +
          '每间房自己的叙事配色在场景页的设置里。'));
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

  /* 加载完立刻应用一次 —— 这一步不能省：不调的话刷新页面会**闪回默认配色**
     （store 里存的是夜灯，看到的却是青提），得点进外观页才生效。
     此刻 #phone 已经在 DOM 里了（它在 body 里、脚本之前）。 */
  apply();

})(window);
