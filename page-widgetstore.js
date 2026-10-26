/* ============================================================
   page-widgetstore.js — 组件商城（橱窗形态，2026-10-06 橱窗批重排）
   ------------------------------------------------------------
   用户要这个 App 的由头是桌面编辑态那排小叉叉：
   「桌面进入编辑模式后，所有的组件都加上一个小叉叉，就是把这个组件删掉的意思，
     因为以后打算做个组件商城~可以自由加不同的组件！」

   2026-10-06 橱窗批（docs/施工卡-组件商城-v1.md 批1）：
     · 「组件目录」从列表行升级成**橱窗预览卡**——每件一张小样卡
       （CSS 手绘的 mini mock，hover 微浮起，触屏不粘 hover），
       卡上直接「加到桌面 / 移除」，不用再进编辑态找叉叉。
     · 「移除」从商城页也能做：走 page-desktop 刚导出的 rememberRemoved
       记同一笔账（x/y/pi 全带），「你删过的」照旧能原位装回。
     · App 入口不是组件，单独一个分组保留列表形态（它们的移除
       仍然是编辑态长按的事）。

   放置规则不变：从第 0 屏开始找**第一个放得下的空格**，找不到就明说放不下
   —— 不静默失败，也不硬塞到别人身上（重叠的格子会被 CSS Grid 悄悄盖住，
   那是这个项目里最难查的一类问题）。

   施工单里批 3~5 的新组件（简单砖/拍立得/信箱/华容道/今日一签/自定义）
   落地后往 EXTRA_DEFS / MOCKS 里各加一项就上架，橱窗结构不用动。
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;

  function cols() { return (Sleepy.desktop && Sleepy.desktop.COLS) || 4; }
  function rows() { return (Sleepy.desktop && Sleepy.desktop.ROWS) || 6; }
  function keyOf(c) { return c.type + '|' + (c.app || '') + '|' + (c.label || ''); }

  /* 上架、但**不在默认户型里**的型号（2026-09-22 用户「人1」）。

     默认户型收不出它们：用户点名把角色卡从主屏拿掉了（v6 那条版本记录，
     见 page-desktop.js 顶部）。但「主屏不摆」不等于「这功能不要了」——
     所以放进商城目录，谁想摆谁自己装回来。

     角色卡（`char`）的渲染函数一直在（page-desktop.js 的 WIDGETS.char），
     第二行现在恒为「在线」（状态签名 2026-09-29 全量下线，
     角色卡展示等组件商城重做时再议）。

     尺寸是 1×1：默认户型 4 屏**一个 1×2 的空位都没有**（实测：
     装 1×2 直接「桌上放不下了」），上架了却装不上等于没上架。
     1×1 的格子只有 ~98px 见方，所以 .w-char 那一组样式跟着瘦了一档。 */
  var EXTRA_DEFS = [
    { type: 'char', app: '', label: '角色卡', w: 1, h: 1,
      note: '当前角色的头像 + 名字' },
    /* ---- 批3 · 简单砖组 + 拍立得（2026-10-06 施工卡）---- */
    { type: 'countdown', app: '', label: '倒数日方', w: 2, h: 1,
      note: '大数字倒数 · 点组件设日子' },
    { type: 'weatherbrick', app: '', label: '天气小方', w: 1, h: 1,
      note: '天气感知的温度小砖' },
    { type: 'dateclock', app: '', label: '日期时钟方', w: 1, h: 1,
      note: '日期 + 时间 + 星期' },
    { type: 'polaroid', app: '', label: '拍立得墙', w: 2, h: 2,
      note: '手选相册照片 · 白边斜贴' },
    /* ---- 批4 · 慢递信箱 ---- */
    { type: 'slowmail', app: '', label: '慢递信箱', w: 2, h: 2,
      note: 'ta 写的慢递信 · 到点才能拆' },
    /* ---- 心声星瓶（2026-10-26 用户拍板）----
       TA 的每条心声是瓶里的一颗星，点一下飘一颗出来。
       尺寸 1×1 是**算出来的**，不是随手定的：默认户型四屏里，第 1/2/3 屏
       只剩第 6 行那一排空格，第 5 行全是满的 —— 任何 h=2 的格子
       （1×2 / 2×2）findSpot 都找不到落点，上架了也装不上。
       （同「角色卡」那条注释的教训。） */
    { type: 'starbottle', app: '', label: '心声星瓶', w: 1, h: 1,
      note: 'TA 的心声 · 点一下飘一颗星' }
  ];

  /* 自定义模板组件（批4）：不在 EXTRA_DEFS 里 —— 它是**动态货架**，
     目录 = store customWidgets（按岛隔离），每件单独渲染成橱窗卡。 */
  function customTpls() {
    var list = [];
    try {
      list = (core.scoped ? core.scoped(store.get('customWidgets') || []) : (store.get('customWidgets') || []));
    } catch (e) {}
    return list.filter(function (t) { return t && t.id; });
  }

  /* mini 小样：每个 type 一个 CSS 手绘的缩样（不真渲染组件本体——
     有些组件渲染要懒加载/要数据，橱窗里只求一眼认出长相反而要轻）。 */
  var MOCKS = {
    lamp: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--lamp',
        h('div', 'ws-mock--lamp-ring'),
        h('div', 'ws-mock--lamp-card'),
        h('div', 'ws-mock--lamp-card ws-mock--lamp-card--b')));
    },
    clock: function (el) { el.appendChild(mockClock()); },
    worldclock: function (el) {
      el.appendChild(mockClock());
      el.appendChild(mockClock('ws-mock--clock--alt'));
    },
    battery: function (el) {
      var b = h('div', 'ws-mock ws-mock--batt', h('i'));
      el.appendChild(b);
    },
    player: function (el) { el.appendChild(mockDisc()); },
    music: function (el) { el.appendChild(mockDisc()); },
    calendar: function (el) {
      var g = h('div', 'ws-mock ws-mock--cal');
      for (var i = 0; i < 9; i++) g.appendChild(h('i'));
      el.appendChild(g);
    },
    todo: function (el) {
      var g = h('div', 'ws-mock ws-mock--todo');
      g.appendChild(h('i', 'is-done'));
      g.appendChild(h('i'));
      g.appendChild(h('i'));
      el.appendChild(g);
    },
    wall: function (el) {
      var g = h('div', 'ws-mock ws-mock--wall');
      for (var i = 0; i < 4; i++) g.appendChild(h('i'));
      el.appendChild(g);
    },
    mood: function (el) {
      var s = h('div', 'ws-mock ws-mock--stamp', '印');
      el.appendChild(s);
    },
    char: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--char',
        h('span', 'ws-mock--ava'),
        h('span', 'ws-mock--bar')));
    },
    hdr: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--hdr',
        h('b', null, '10月6日'),
        h('span', null, '16:34')));
    },
    wj: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--wj'));
    },
    mode: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--mode', '线下'));
    },
    blank: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--blank'));
    },
    /* ---- 批3 新件的 mini mock ---- */
    countdown: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--cdown',
        h('b', null, '14'),
        h('span', null, '天')));
    },
    weatherbrick: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--wbrick',
        h('b', null, '12°'),
        h('span', null, '多云')));
    },
    dateclock: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--dclock',
        h('b', null, '10月6日'),
        h('span', null, '16:50')));
    },
    polaroid: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--pola'));
      el.appendChild(h('div', 'ws-mock ws-mock--pola is-alt'));
    },
    slowmail: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--smail',
        h('b', null, '✉'),
        h('span', null, '2 封')));
    },
    starbottle: function (el) {
      el.appendChild(h('div', 'ws-mock ws-mock--bottle',
        h('i', 'ws-mock--bottle-cork'),
        h('i', 'ws-mock--bottle-star')));
    }
  };
  function mockClock(alt) {
    return h('div', 'ws-mock ws-mock--clock' + (alt ? ' ' + alt : ''),
      h('i', 'ws-mock--hand'),
      h('i', 'ws-mock--hand ws-mock--hand--m'));
  }
  function mockDisc() {
    return h('div', 'ws-mock ws-mock--disc', h('i'));
  }
  function mockOf(type) {
    return function (el) {
      if (MOCKS[type]) { MOCKS[type](el); return; }
      /* 没画小样的型号：首字母砖兜底，新组件落地前也有的看 */
      el.appendChild(h('div', 'ws-mock ws-mock--fallback',
        (type || '?').slice(0, 1).toUpperCase()));
    };
  }

  /* 默认户型里出现过的组件型号 + EXTRA 上架清单，去重，按 app 与否分两堆。
     用 `type|app|label` 当键：同一个 type 配不同 app（比如各种 App 入口）
     是不同的东西，但同一个 App 在两屏都摆过只算一件。 */
  function catalog() {
    var seen = {};
    var out = [];
    function push(c) {
      var key = keyOf(c);
      if (seen[key]) return;
      seen[key] = 1;
      out.push({
        key: key, type: c.type, app: c.app || '',
        label: c.label || '', w: c.w, h: c.h, note: c.note || ''
      });
    }
    if (Sleepy.desktop && Sleepy.desktop.defaultDesktop) {
      Sleepy.desktop.defaultDesktop().pages.forEach(function (list) {
        (list || []).forEach(push);
      });
    }
    EXTRA_DEFS.forEach(push);
    return out;
  }

  function removed() {
    var list = store.get('desktopRemoved') || [];
    /* 已经回到桌面上的不列 —— 户型**版本升级**会以新户型为骨架补齐组件，
       之前删掉的可能被迁移带了回来（实测：删掉的照片墙升 v5 时回来了），
       这时再列着「装回来」，点了只会「放不下」。 */
    var onDesk = {};
    Sleepy.desktop.getDesktop().pages.forEach(function (l) {
      (l || []).forEach(function (c) { onDesk[keyOf(c)] = 1; });
    });
    var seen = {};
    var out = [];
    list.slice().reverse().forEach(function (r) {
      var key = keyOf(r);
      if (seen[key] || onDesk[key]) return;
      seen[key] = 1;
      out.push(r);
    });
    return out.slice(0, 12);
  }

  function dropRemoved(cell) {
    var list = store.get('desktopRemoved') || [];
    var at = -1;
    for (var i = list.length - 1; i >= 0; i--) {
      if (keyOf(list[i]) === keyOf(cell)) { at = i; break; }
    }
    if (at >= 0) list.splice(at, 1);
    store.set('desktopRemoved', list);
  }

  function overlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  /* 找第一个放得下的空格。从第 0 屏（负一屏）开始 ——
     那儿通常最空，也最不容易把用户精心摆过的主屏挤乱。 */
  function findSpot(pages, w, h) {
    var C = cols(), R = rows();
    for (var pi = 0; pi < pages.length; pi++) {
      var list = pages[pi] || [];
      for (var y = 1; y + h - 1 <= R; y++) {
        for (var x = 1; x + w - 1 <= C; x++) {
          var probe = { x: x, y: y, w: w, h: h };
          var hit = false;
          for (var i = 0; i < list.length; i++) {
            if (overlap(probe, list[i])) { hit = true; break; }
          }
          if (!hit) return { pi: pi, x: x, y: y };
        }
      }
    }
    return null;
  }

  function addWidget(def) {
    var d = Sleepy.desktop.getDesktop();
    var w = Math.min(def.w || 1, cols());
    var hh = Math.min(def.h || 1, rows());
    var spot = findSpot(d.pages, w, hh);
    if (!spot) {
      /* 提示里带上**尺寸**：只说「放不下」用户不知道要腾多大地方。 */
      return {
        ok: false,
        message: '桌上放不下了 · 这个要 ' + w + '×' + hh + ' 的位置，先去编辑态腾一腾'
      };
    }
    var cell = {
      i: core.newId('w'),
      type: def.type,
      x: spot.x, y: spot.y, w: w, h: hh,
      label: def.label || ''
    };
    if (def.app) cell.app = def.app;
    /* 自定义模板组件（批4）：cell 带上模板 id，RENDER.custom 按 it 取模板 */
    if (def.tplId) cell.tplId = def.tplId;
    d.pages[spot.pi].push(cell);
    /* 走 setDesktop：改的是活动岛的覆盖层还是全局底座，由它路由（岛覆盖 > 全局） */
    Sleepy.desktop.setDesktop(d);
    return { ok: true, cell: cell, page: spot.pi };
  }

  /* 商城页的「移除」：从**最后一屏**往前找这个型号的格子（后摆的先拆，
     别动用户最早上手摆的那件），拿掉后走 page-desktop 的 rememberRemoved
     记同一笔账 —— 「你删过的」才接得上原位装回。 */
  function removeWidget(c) {
    var d = Sleepy.desktop.getDesktop();
    for (var pi = d.pages.length - 1; pi >= 0; pi--) {
      var list = d.pages[pi] || [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (keyOf(list[i]) === c.key) {
          var cell = list[i];
          list.splice(i, 1);
          Sleepy.desktop.setDesktop(d);
          if (Sleepy.desktop.rememberRemoved) Sleepy.desktop.rememberRemoved(cell, pi);
          return { ok: true, page: pi };
        }
      }
    }
    return { ok: false, message: '这件不在桌上' };
  }

  /* 同型号在桌上有几件 —— 橱窗卡上的「在桌上 ×N」 */
  function countOf(key) {
    var n = 0;
    Sleepy.desktop.getDesktop().pages.forEach(function (l) {
      (l || []).forEach(function (c) { if (keyOf(c) === key) n++; });
    });
    return n;
  }

  /* 装回删掉的组件：**原位优先** —— 记录里带了 x/y/pi（page-desktop 记的），
     当初从哪拿掉的就放回哪；位置被人占了或户型改了放不下，才退回找空位。
     直接 addWidget 的话永远落在第一块空位，用户摆好的桌面就乱了。 */
  function restoreWidget(r) {
    var d = Sleepy.desktop.getDesktop();
    var w = Math.min(r.w || 1, cols());
    var hh = Math.min(r.h || 1, rows());
    if (typeof r.pi === 'number' && r.pi >= 0 && d.pages[r.pi] &&
      typeof r.x === 'number' && typeof r.y === 'number') {
      var probe = { x: r.x, y: r.y, w: w, h: hh };
      var hit = false;
      (d.pages[r.pi] || []).forEach(function (c) {
        if (overlap(probe, c)) hit = true;
      });
      if (!hit && r.x + w - 1 <= cols() && r.y + hh - 1 <= rows()) {
        var cell = {
          i: core.newId('w'),
          type: r.type,
          x: r.x, y: r.y, w: w, h: hh,
          label: r.label || ''
        };
        if (r.app) cell.app = r.app;
        d.pages[r.pi].push(cell);
        Sleepy.desktop.setDesktop(d);
        return { ok: true, cell: cell, page: r.pi, home: true };
      }
    }
    return addWidget(r);
  }

  function countOnDesktop() {
    var d = Sleepy.desktop.getDesktop();
    var n = 0;
    d.pages.forEach(function (l) { n += (l || []).length; });
    return n;
  }

  /* ------------------------ 灯设置面板（批2） ------------------------
     灯光四档 / 灯牌字体 URL / 留言管理。只走 Sleepy.lampCtl（page-desktop
     导出的唯一写入口）—— 这里不直接碰 lampState / lampNotes 存档。 */
  var LAMP_LIGHTS = [
    ['warm', '暖灯'], ['moon', '月光'], ['day', '自然光'], ['candle', '烛光']
  ];
  function fmtNoteTs(ts) {
    var d = new Date(ts || Date.now());
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
  }
  function openLampPanel(anchorBtn, ctx, repaintRack) {
    var lamp = Sleepy.lampCtl;
    if (!lamp) { ctx.toast('灯模块还没加载好', 'warn'); return; }
    var pop = ui.anchorPopover(anchorBtn, { className: 'ws-lamp-pop', width: '248px' });
    var el = pop.el;

    el.appendChild(h('div', 'ws-lamp-pop-sec',
      h('b', null, '灯光')));
    var lg = h('div', 'ws-lamp-pop-grid');
    var cur = lamp.lightGet();
    LAMP_LIGHTS.forEach(function (it) {
      var b = h('button', 'ws-lamp-opt' + (cur === it[0] ? ' is-on' : ''), it[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        lamp.lightSet(it[0]);
        lg.querySelectorAll('.ws-lamp-opt').forEach(function (x) {
          x.classList.remove('is-on');
        });
        b.classList.add('is-on');
        ctx.toast('换了 · ' + it[1], 'ok');
      });
      lg.appendChild(b);
    });
    el.appendChild(lg);

    el.appendChild(h('div', 'ws-lamp-pop-sec',
      h('b', null, '灯牌字体')));
    var fin = h('input');
    fin.type = 'text';
    fin.placeholder = '字体文件直链（留空用外观字体）';
    fin.value = lamp.fontGet();
    var frow = h('div', 'ws-lamp-pop-font');
    frow.appendChild(fin);
    var fsave = h('button', 'ws-lamp-opt ws-lamp-font-save', '存');
    frow.appendChild(fsave);
    el.appendChild(frow);
    fsave.addEventListener('click', function () {
      var fam = lamp.fontSet(fin.value);
      ctx.toast(fam ? ('字体已换 · ' + fam) : '清掉了 · 回到楷体栈', 'ok');
    });

    el.appendChild(h('div', 'ws-lamp-pop-sec',
      h('b', null, '灯上的留言')));
    var notes = (Sleepy.lampNotes && Sleepy.lampNotes.list()) || [];
    if (!notes.length) {
      el.appendChild(h('div', 'ws-lamp-pop-note ws-lamp-pop-note--empty',
        '还没有留言 —— 长按聊天里的话，或者等 ta 自己留。'));
    }
    notes.slice().reverse().forEach(function (nt) {
      var line = h('div', 'ws-lamp-pop-note');
      line.appendChild(h('span', 'ws-lamp-pop-note-text',
        nt.text + ' —— ' + (nt.by || '我') + ' · ' + fmtNoteTs(nt.ts)));
      var del = h('button', 'ws-lamp-pop-del', '删');
      del.type = 'button';
      del.addEventListener('click', function () {
        Sleepy.lampNotes.remove(nt.id);
        line.parentNode.removeChild(line);
        if (repaintRack) repaintRack();
        ctx.toast('从灯上拿掉了', 'ok');
      });
      line.appendChild(del);
      el.appendChild(line);
    });

    pop.place();
  }

  /* 对外：冒烟要拿这两个纯函数核对「目录非空」和「放不下时不硬塞」。 */
  Sleepy.widgetStore = {
    catalog: catalog,
    removed: removed,
    findSpot: findSpot,
    addWidget: addWidget,
    removeWidget: removeWidget,
    countOf: countOf,
    restoreWidget: restoreWidget,
    countOnDesktop: countOnDesktop
  };

  /* ---------------------------- 屏 ---------------------------- */

  Sleepy.register('widgetstore', {
    title: '组件商城',
    render: function (ctx) {
      var body = ctx.body;

      function paint() {
        body.innerHTML = '';

        /* ---- 组件橱窗 ----
           一件一张小样卡：CSS 手绘的 mini mock + 名字 + 尺寸 +
           「加到桌面 / 在桌上 ×N（可移除）」。hover 微浮起只给
           有鼠标的设备（触屏不粘 hover）。 */
        var cat = catalog().filter(function (c) { return c.type !== 'app'; });
        var g2 = group('组件橱窗',
          '点「加到桌面」就从第一块空位摆上；「移除」会记进「你删过的」，装回来时优先回原位。');
        var rack = h('div', 'ws-rack');
        cat.forEach(function (c) {
          var card = h('div', 'ws-card');
          var demo = h('div', 'ws-card-demo');
          mockOf(c.type)(demo);
          card.appendChild(demo);

          var meta = h('div', 'ws-card-meta');
          meta.appendChild(h('b', null, c.label || c.type));
          meta.appendChild(h('i', null, c.note ||
            (c.type + ' · ' + c.w + '×' + c.h)));
          card.appendChild(meta);

          var n = countOf(c.key);
          var btnRow = h('div', 'ws-card-btns');
          var btn = h('button', 'ws-card-btn' + (n ? ' is-on' : ''),
            n ? ('在桌上 ×' + n) : '加到桌面');
          btn.type = 'button';
          btn.addEventListener('click', function () {
            if (!n) {
              var res = addWidget(c);
              if (!res.ok) { ctx.toast(res.message, 'warn'); return; }
              ctx.toast('摆到第 ' + (res.page + 1) + ' 屏了', 'ok');
            } else {
              var rm = removeWidget(c);
              if (!rm.ok) { ctx.toast(rm.message, 'warn'); return; }
              ctx.toast('拿掉了 · 第 ' + (rm.page + 1) + ' 屏', 'ok');
            }
            paint();
          });
          btnRow.appendChild(btn);
          /* 灯卡专属：设置面板（批2）。别的组件以后有自己的设置也走这条路。 */
          if (c.type === 'lamp') {
            var gear = h('button', 'ws-card-btn ws-card-btn--ghost', '设置');
            gear.type = 'button';
            gear.addEventListener('click', function () { openLampPanel(gear, ctx, paint); });
            btnRow.appendChild(gear);
          }
          card.appendChild(btnRow);
          /* 已摆件再给一个小「再摆一件」——有人就想要两块时钟 */
          if (n) {
            var more = h('button', 'ws-card-btn ws-card-btn--ghost', '再摆一件');
            more.type = 'button';
            more.addEventListener('click', function () {
              var res = addWidget(c);
              if (!res.ok) { ctx.toast(res.message, 'warn'); return; }
              ctx.toast('摆到第 ' + (res.page + 1) + ' 屏了', 'ok');
              paint();
            });
            card.appendChild(more);
          }
          rack.appendChild(card);
        });
        g2.card.appendChild(rack);
        body.appendChild(g2.wrap);

        /* ---- 自制组件（批4）----
           模板 = HTML/CSS + {{变量}}，形状大小自由；只做变量替换不执行脚本
           （入库过 sanitizeTpl）。编辑器是独立页（widgetmake）。 */
        var tpls = customTpls();
        var g5 = group('自制组件', '写一小段模板就能上桌 —— 形状大小随你定，变量会换成真数据。');
        var mkRow = h('div', 'ws-make-row');
        var mkBtn = h('button', 'ws-card-btn ws-make-btn', '+ 自制一块');
        mkBtn.type = 'button';
        mkBtn.addEventListener('click', function () {
          makeId = null;                 /* 新建 */
          ctx.open('widgetmake');
        });
        mkRow.appendChild(mkBtn);
        g5.card.appendChild(mkRow);
        tpls.forEach(function (t) {
          g5.card.appendChild(row({
            label: t.name || '未命名',
            hint: (t.w || 1) + '×' + (t.h || 1) + ' · 自定义模板',
            value: '摆上桌',
            onClick: function () {
              var res = addWidget({
                type: 'custom', app: '', label: t.name || '自定义',
                w: t.w || 1, h: t.h || 1, tplId: t.id
              });
              if (!res.ok) { ctx.toast(res.message, 'warn'); return; }
              ctx.toast('摆到第 ' + (res.page + 1) + ' 屏了', 'ok');
              paint();
            }
          }));
          var er = h('div', 'ws-make-editrow');
          var eb = h('button', 'ws-make-mini', '编辑');
          eb.type = 'button';
          eb.addEventListener('click', function () {
            makeId = t.id;
            ctx.open('widgetmake');
          });
          var db = h('button', 'ws-make-mini is-danger', '删模板');
          db.type = 'button';
          db.addEventListener('click', function () {
            var all = store.get('customWidgets') || [];
            var out = all.filter(function (x) { return !x || x.id !== t.id; });
            store.set('customWidgets', out);
            ctx.toast('模板删了（已摆出去的格子会显示「模板不见了」）', 'ok');
            paint();
          });
          er.appendChild(eb);
          er.appendChild(db);
          g5.card.appendChild(er);
        });
        body.appendChild(g5.wrap);

        /* ---- 你删过的 ---- */
        var gone = removed();
        var g1 = group('你删过的',
          gone.length ? '点一下装回桌面（尽量放回原来的位置，被占了就找空位）。'
            : '还没删过东西 —— 商城卡的「移除」或编辑态的小叉叉都会记到这里。');
        if (gone.length) {
          gone.forEach(function (r) {
            g1.card.appendChild(row({
              label: r.label || '组件',
              hint: (r.w || 1) + '×' + (r.h || 1) + ' · 从桌面上拿掉的',
              value: '装回来',
              onClick: function () {
                var res = restoreWidget(r);
                if (!res.ok) { ctx.toast(res.message, 'warn'); return; }
                dropRemoved(r);
                ctx.toast('装回桌面了 · 第 ' + (res.page + 1) + ' 屏', 'ok');
                paint();
              }
            }));
          });
        }
        body.appendChild(g1.wrap);

        /* ---- App 入口组 / 「现在桌面上」现状块已删（2026-10-23 用户点名）----
           外观页已经能「加到桌面 / 移除」，商城的 App 入口组只有加没有
           移除，跟外观两处账；组件总数 / 户型版本是纯展示。两块连同
           施工单页脚一起删，商城只留组件货架（g1 及以下）+ 自制组件。 */
      }

      paint();
      ctx.__storeRefresh = paint;
    },
    onShow: function (ctx) { if (ctx.__storeRefresh) ctx.__storeRefresh(); }
  });

  /* ---------------------------- 自制组件编辑器（批4） ----------------------------
     左模板右预览：HTML/CSS 两个 textarea + 实时预览 + 尺寸。保存时消毒
     （sanitizeTpl 剥 <script>/on*=，page-desktop 唯一实现，这里只调用）。
     makeId 由商城页在 ctx.open 之前放好（null = 新建）。 */
  var makeId = null;
  var STARTER_HTML = '<div class="card">\n  <div class="hello">{{charName}} 的桌面</div>\n  <div class="big">{{time}}</div>\n  <div class="sub">{{date}} · {{weekday}} · 待办 {{todoCount}}</div>\n</div>';
  var STARTER_CSS = '.card{height:100%;display:flex;flex-direction:column;justify-content:center;gap:4px;padding:10px 14px;}\n.hello{font-size:11px;opacity:.7;}\n.big{font-size:24px;font-weight:500;}\n.sub{font-size:10px;opacity:.65;}';
  /* 可用变量一览（写死在页脚提示）：与 page-desktop widgetVars 的白名单一致 */
  var VAR_HINT = '{{time}} {{date}} {{weekday}} {{weather}} {{weatherCity}} {{photo}} {{lampNote}} {{charName}} {{todoCount}} {{countdown:2027-01-01}}';

  function findMakeTpl(id) {
    var all = store.get('customWidgets') || [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === id) return { tpl: all[i], all: all };
    }
    return { tpl: null, all: all };
  }

  Sleepy.register('widgetmake', {
    title: '自制组件',
    render: function (ctx) {
      var body = ctx.body;
      var found = makeId ? findMakeTpl(makeId) : { tpl: null };
      var tpl = found.tpl;
      var cur = {
        name: tpl ? (tpl.name || '') : '',
        w: tpl ? (tpl.w || 2) : 2,
        h: tpl ? (tpl.h || 1) : 1,
        html: tpl ? (tpl.html || '') : STARTER_HTML,
        css: tpl ? (tpl.css || '') : STARTER_CSS
      };

      var nameIn = h('input', 'wm-input');
      nameIn.type = 'text';
      nameIn.value = cur.name;
      nameIn.placeholder = '组件名字';
      var wIn = h('input', 'wm-input wm-num');
      wIn.type = 'number'; wIn.min = '1'; wIn.max = '4'; wIn.value = String(cur.w);
      var hIn = h('input', 'wm-input wm-num');
      hIn.type = 'number'; hIn.min = '1'; hIn.max = '6'; hIn.value = String(cur.h);
      var htmlIn = h('textarea', 'wm-area');
      htmlIn.rows = 7; htmlIn.value = cur.html; htmlIn.spellcheck = false;
      var cssIn = h('textarea', 'wm-area');
      cssIn.rows = 7; cssIn.value = cur.css; cssIn.spellcheck = false;

      var head = h('div', 'wm-head');
      head.appendChild(nameIn);
      var sizeBox = h('div', 'wm-size');
      sizeBox.appendChild(wIn);
      sizeBox.appendChild(h('span', null, '×'));
      sizeBox.appendChild(hIn);
      head.appendChild(sizeBox);
      body.appendChild(head);

      body.appendChild(h('div', 'wm-label', 'HTML（可用变量见页脚）'));
      body.appendChild(htmlIn);
      body.appendChild(h('div', 'wm-label', 'CSS（会钉在这个组件自己的作用域里）'));
      body.appendChild(cssIn);

      var pvWrap = h('div', 'wm-pv');
      var pv = h('div', 'wm-pv-box cust-makepv');
      pvWrap.appendChild(pv);
      body.appendChild(h('div', 'wm-label', '实时预览'));
      body.appendChild(pvWrap);

      var sanitize = (Sleepy.desktop && Sleepy.desktop.customTpl) || null;
      function paintPv() {
        if (!sanitize) return;
        var w = Math.max(1, Math.min(4, parseInt(wIn.value, 10) || 2));
        var hh = Math.max(1, Math.min(6, parseInt(hIn.value, 10) || 1));
        pv.className = 'wm-pv-box cust-makepv';
        pv.style.aspectRatio = (w * 2) + ' / ' + hh;
        pv.innerHTML = '';
        var styleEl = h('style');
        styleEl.textContent = sanitize.scope(sanitize.sanitize(cssIn.value), '.cust-makepv');
        pv.appendChild(styleEl);
        var inner = h('div', 'w-custom-body');
        inner.innerHTML = sanitize.substitute(sanitize.sanitize(htmlIn.value), 'makepv');
        pv.appendChild(inner);
      }
      htmlIn.addEventListener('input', paintPv);
      cssIn.addEventListener('input', paintPv);
      wIn.addEventListener('input', paintPv);
      hIn.addEventListener('input', paintPv);
      paintPv();

      var save = h('button', 'wm-save', tpl ? '保存修改' : '做好上架');
      save.type = 'button';
      save.addEventListener('click', function () {
        if (!sanitize) { ctx.toast('消毒模块没加载出来', 'err'); return; }
        var name = String(nameIn.value || '').trim().slice(0, 12) || '自定义';
        var w = Math.max(1, Math.min(4, parseInt(wIn.value, 10) || 2));
        var hh = Math.max(1, Math.min(6, parseInt(hIn.value, 10) || 1));
        var all = store.get('customWidgets') || [];
        var rec = {
          id: tpl ? tpl.id : core.newId('cw'),
          name: name, w: w, h: hh,
          html: sanitize.sanitize(htmlIn.value),
          css: sanitize.sanitize(cssIn.value),
          createdAt: Date.now()
        };
        if (core.tagScope) core.tagScope(rec);
        if (tpl) {
          for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].id === tpl.id) { all[i] = rec; break; }
          }
        } else {
          all.push(rec);
          makeId = rec.id;
        }
        store.set('customWidgets', all);
        ctx.toast(tpl ? '改好了' : '上架了 · 回商城摆上桌', 'ok');
        ctx.back();
      });
      body.appendChild(save);

      if (tpl) {
        var del = h('button', 'wm-del', '删掉这个模板');
        del.type = 'button';
        del.addEventListener('click', function () {
          var all = store.get('customWidgets') || [];
          store.set('customWidgets', all.filter(function (x) { return !x || x.id !== tpl.id; }));
          ctx.toast('模板删了', 'ok');
          ctx.back();
        });
        body.appendChild(del);
      }

      body.appendChild(h('p', 'set-foot', '可用变量：' + VAR_HINT));
    }
  });

})(window);
