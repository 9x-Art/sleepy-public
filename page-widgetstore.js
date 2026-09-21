/* ============================================================
   page-widgetstore.js — 组件商城
   ------------------------------------------------------------
   用户要这个 App 的由头是桌面编辑态那排小叉叉：
   「桌面进入编辑模式后，所有的组件都加上一个小叉叉，就是把这个组件删掉的意思，
     因为以后打算做个组件商城~可以自由加不同的组件！」

   所以这一版做的是**「删了能装回来」**：
     · 「你删过的」—— 从 `desktopRemoved` 里读（删的时候记的那一笔）
     · 「组件目录」—— 从默认户型里把所有组件型号收一遍（去重）

   **还不是「下载新组件」那种商城** —— 那份目录现在就是「这 App 里已经有的
   组件类型」，装的是同一个型号。真正的「第三方组件包」要等组件有独立的
   manifest / 沙箱那套，是后面的事。这一点在页面底部写清楚了，
   免得用户以为商城是空的。

   放置规则：从第 0 屏开始找**第一个放得下的空格**，找不到就明说放不下 ——
   不静默失败，也不硬塞到别人身上（重叠的格子会被 CSS Grid 悄悄盖住，
   那是这个项目里最难查的一类问题）。
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

  var REMOVED_MAX = 30;

  function cols() { return (Sleepy.desktop && Sleepy.desktop.COLS) || 4; }
  function rows() { return (Sleepy.desktop && Sleepy.desktop.ROWS) || 6; }

  /* 默认户型里出现过的组件型号，去重。
     用 `type|app|label` 当键：同一个 type 配不同 app（比如各种 App 入口）
     是不同的东西，但同一个 App 在两屏都摆过只算一件。 */
  function catalog() {
    if (!Sleepy.desktop || !Sleepy.desktop.defaultDesktop) return [];
    var seen = {};
    var out = [];
    Sleepy.desktop.defaultDesktop().pages.forEach(function (list) {
      (list || []).forEach(function (c) {
        var key = c.type + '|' + (c.app || '') + '|' + (c.label || '');
        if (seen[key]) return;
        seen[key] = 1;
        out.push({
          key: key, type: c.type, app: c.app || '',
          label: c.label || '', w: c.w, h: c.h
        });
      });
    });
    return out;
  }

  function removed() {
    var list = store.get('desktopRemoved') || [];
    /* 已经回到桌面上的不列 —— 户型**版本升级**会以新户型为骨架补齐组件，
       之前删掉的可能被迁移带了回来（实测：删掉的照片墙升 v5 时回来了），
       这时再列着「装回来」，点了只会「放不下」。 */
    var onDesk = {};
    Sleepy.desktop.getDesktop().pages.forEach(function (l) {
      (l || []).forEach(function (c) {
        onDesk[c.type + '|' + (c.app || '') + '|' + (c.label || '')] = 1;
      });
    });
    var seen = {};
    var out = [];
    list.slice().reverse().forEach(function (r) {
      var key = r.type + '|' + (r.app || '') + '|' + (r.label || '');
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
      if (list[i].type === cell.type && (list[i].app || '') === (cell.app || '') &&
        (list[i].label || '') === (cell.label || '')) { at = i; break; }
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
    d.pages[spot.pi].push(cell);
    /* 走 setDesktop：改的是活动岛的覆盖层还是全局底座，由它路由（岛覆盖 > 全局） */
    Sleepy.desktop.setDesktop(d);
    return { ok: true, cell: cell, page: spot.pi };
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

  /* 对外：冒烟要拿这两个纯函数核对「目录非空」和「放不下时不硬塞」。 */
  Sleepy.widgetStore = {
    catalog: catalog,
    removed: removed,
    findSpot: findSpot,
    addWidget: addWidget,
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

        /* ---- 你删过的 ---- */
        var gone = removed();
        var g1 = group('你删过的',
          gone.length ? '点一下装回桌面（尽量放回原来的位置，被占了就找空位）。'
            : '还没删过东西 —— 长按桌面进编辑态，每个组件角上都有一个小叉叉。');
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

        /* ---- 组件目录 ---- */
        var cat = catalog();
        var g2 = group('组件目录',
          '这 App 里现在有的组件都能摆到桌面上，想摆几份都行。');
        cat.forEach(function (c) {
          g2.card.appendChild(row({
            label: c.label || c.type,
            hint: c.app ? ('App 入口 · ' + c.app) : (c.type + ' 组件'),
            value: (c.w || 1) + '×' + (c.h || 1),
            badge: '',
            onClick: function () {
              var res = addWidget(c);
              if (!res.ok) { ctx.toast(res.message, 'warn'); return; }
              ctx.toast('摆到第 ' + (res.page + 1) + ' 屏了', 'ok');
              paint();
            }
          }));
        });
        body.appendChild(g2.wrap);

        /* ---- 现状 ---- */
        var g3 = group('现在桌面上', '');
        g3.card.appendChild(row({
          label: '组件总数',
          value: countOnDesktop() + ' 个'
        }));
        g3.card.appendChild(row({
          label: '户型版本',
          value: 'v' + (Sleepy.desktop.LAYOUT_VERSION || '?'),
          hint: '版本升级会补齐新组件，保留你摆过的位置'
        }));
        body.appendChild(g3.wrap);

        body.appendChild(h('p', 'set-foot',
          '现在装的都是 App 里已有的组件型号。' +
          '以后接「第三方组件包」（能自己带界面的那种）才是真正的下载商城。'));
      }

      paint();
      ctx.__storeRefresh = paint;
    },
    onShow: function (ctx) { if (ctx.__storeRefresh) ctx.__storeRefresh(); }
  });

})(window);
