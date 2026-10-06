/* ============================================================
   page-gallery.js — 相册（模块 J）

   和负一屏的照片墙是**同一份数据**（Sleepy.photos），
   区别只是：
     · 照片墙 = 取前 4 张，贴成错落的拍立得（装饰性，只读）
     · 相册   = 全部，网格铺开，可点开大图 / 改标题 / 删

   空态是重点：没有照片时**必须能直接点着上传**，
   而不是给一句「以后支持」然后就没下文了。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;

  var SVG = 'viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  function ic(body, size) {
    var s = size ? 'viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"' : SVG;
    return '<svg ' + s + '>' + body + '</svg>';
  }

  function photos() {
    return Sleepy.photos ? Sleepy.photos.all() : [];
  }

  function fmtDate(at) {
    var d = new Date(at || Date.now());
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
  }

  Sleepy.register('gallery', {
    title: '相册',

    render: function (ctx) {
      var body = ctx.body;
      body.innerHTML = '';

      /* ---- 群岛选人（2026-10-06，用户：「相册要选人 · 按账号隔离」）----
         群岛（多个角色）进相册先选人：每本相册只属于一个角色，
         不混 —— 以后 char 发朋友圈从相册拿图才不会拿到别人的。
         孤岛只有一个角色，不选，直接整本。 */
      var coreRef = Sleepy.core;
      var sb = (coreRef && coreRef.activeSandbox) ? coreRef.activeSandbox() : null;
      var needPick = !!(coreRef && coreRef.needsCharPick && coreRef.needsCharPick(sb));
      var pickedId = ctx.params.charId || '';
      var pickedChar = pickedId ? (coreRef && coreRef.findChar ? coreRef.findChar(pickedId) : null) : null;
      if (needPick && (!pickedId || !pickedChar)) {
        ctx.setTitle('相册');
        ctx.setActions([]);
        body.appendChild(pickScreen(ctx, sb));
        return;
      }
      if (pickedChar) ctx.setTitle('相册 · ' + (pickedChar.name || '?'));
      else ctx.setTitle('相册');

      var owner = pickedChar ? { charId: pickedChar.id } : null;

      /* 顶栏右侧：加号。无论空不空都留着，空态那个大按钮只是更好按。
         注意 setActions 收的是**描述对象数组**，不是 DOM 节点 ——
         传元素进去会在 (list||[]).forEach 上炸，而且是被 app.js 的
         错误边界吞掉、只显示「这一页出错了」，不太好回溯。 */
      ctx.setActions([{
        label: '加照片',
        svg: ic('<path d="M12 6.5v11M6.5 12h11"/>', 18),
        onClick: function () { doPick(ctx, owner); }
      }]);

      var all = photos();
      /* 本主人的照片；群岛里还要把「没记归属的老照片」单独摆一截，
         不混进任何人的相册（归属这个字段是 2026-10-06 才开始记的）。 */
      var list = needPick
        ? all.filter(function (p) { return p.ownerCharId === pickedId; })
        : all;
      var legacy = needPick
        ? all.filter(function (p) { return !p.ownerCharId; })
        : [];

      if (!list.length && !(needPick && legacy.length)) {
        body.appendChild(emptyState(ctx, owner));
        return;
      }

      /* ---- 有照片：分组的网格 ----
         按「天」分组，每组一个小标题 + 九宫格。照片少的时候
         一屏就是一块，多了之后有日期分割才找得到东西。 */
      var groups = groupByDay(list);
      var wrap = h('div', 'gal-wrap');

      Object.keys(groups).forEach(function (day) {
        var sec = h('section', 'gal-day');
        var head = h('div', 'gal-day-head');
        head.appendChild(h('span', 'gal-day-name', day));
        head.appendChild(h('span', 'gal-day-n', groups[day].length + ' 张'));
        sec.appendChild(head);

        var grid = h('div', 'gal-grid');
        groups[day].forEach(function (p) {
          grid.appendChild(thumb(ctx, p));
        });
        sec.appendChild(grid);
        wrap.appendChild(sec);
      });

      /* 没记归属的老照片：单独一截放在页尾，谁的眼里都看得到，
         但不冒充是这个人拍的（要动它们去照片墙删，或等以后做「改归属」）。 */
      if (needPick && legacy.length) {
        var secOld = h('section', 'gal-day');
        var headOld = h('div', 'gal-day-head');
        headOld.appendChild(h('span', 'gal-day-name', '早期 · 没记归属'));
        headOld.appendChild(h('span', 'gal-day-n', legacy.length + ' 张'));
        secOld.appendChild(headOld);
        var gridOld = h('div', 'gal-grid');
        var groupsOld = groupByDay(legacy);
        Object.keys(groupsOld).forEach(function (day) {
          groupsOld[day].forEach(function (p) { gridOld.appendChild(thumb(ctx, p)); });
        });
        secOld.appendChild(gridOld);
        wrap.appendChild(secOld);
      }

      /* 统计 + 占用：让用户对「还剩多少」有个概念。
         占用算**全部存档**的量（diskUsage 是全量），不能只算当前房：
         localStorage 是 5MB 一个池子，只显示本房占用会让人以为还很空，
         然后在另一间房里撞配额。张数仍然是本房的（list 是过滤过的）。

         走了 IndexedDB 之后，占用分两截：图片本体在 IDB（磁盘级配额，
         基本不用担心），老的 dataURL 记录还在 localStorage 那个池子里。
         所以进度条按 **localStorage 那一截**算 —— 那才是会顶到上限的部分。 */
      var legacyBytes = Sleepy.photos ? Sleepy.photos.usedBytes() : 0;
      var limit = (Sleepy.photos && Sleepy.photos.SOFT_LIMIT) || 1;
      var pct = Math.min(100, Math.round(legacyBytes / limit * 100));
      var bar = h('div', 'gal-foot-bar');
      var fill = h('i', 'gal-foot-fill');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      var foot = h('div', 'gal-foot');
      foot.appendChild(bar);
      var footText = h('p', 'gal-foot-text',
        '共 ' + list.length + ' 张 · 约占 ' + pct + '%');
      foot.appendChild(footText);
      /* 图库总账是异步的，拿到了再补一句（写在这里而不是 setInterval） */
      if (Sleepy.photos && Sleepy.photos.diskUsage) {
        Sleepy.photos.diskUsage().then(function (u) {
          if (!u || !u.idb) return;
          footText.textContent = '共 ' + list.length + ' 张 · 图库 ' +
            (Sleepy.media ? Sleepy.media.fmtBytes(u.bytes) : u.bytes);
        });
      }
      wrap.appendChild(foot);

      body.appendChild(wrap);

      /* 右下角的悬浮加号（gal-fab）删掉了（2026-10-06，用户：「这个没用喔」）——
         顶栏右侧本来就有「加照片」，空态还有整块可点的上传区，三重入口太挤。 */
    }
  });

  /* ---------------------------- 空态 / 选人 ---------------------------- */

  /* 群岛选人页：每个角色一本相册，点进去看谁的。
     行样式直接借设置页的 group/row —— 同一个语气，零新 CSS。 */
  function pickScreen(ctx, sb) {
    var g = ui.group('看谁的相册',
      '群岛里每个角色一本，互不混用；早期没记归属的照片在每个人页尾单独一截。');
    var all = photos();
    ((sb && sb.charIds) || []).forEach(function (id) {
      var c = (Sleepy.core && Sleepy.core.findChar) ? Sleepy.core.findChar(id) : null;
      if (!c) return;
      var n = all.filter(function (p) { return p.ownerCharId === id; }).length;
      g.card.appendChild(ui.row({
        label: c.name || '未命名',
        hint: n + ' 张',
        onClick: function () { ctx.open('gallery', { charId: id }); }
      }));
    });
    return g.wrap;
  }

  /* 空态做成整块可点的上传区。刻意做得比「一个加号」大很多：
     这是这条流程唯一的入口，用户第一次进来必须一眼看到该点哪儿。 */
  function emptyState(ctx, owner) {
    var box = h('div', 'gal-empty');

    var drop = h('button', 'gal-empty-drop');
    drop.type = 'button';
    drop.appendChild(iconBadge('image'));
    drop.appendChild(h('p', 'gal-empty-title', '还没有照片'));
    drop.appendChild(h('p', 'gal-empty-hint', '点这里，从相册里选几张'));
    drop.addEventListener('click', function () { doPick(ctx, owner); });
    box.appendChild(drop);

    var tips = h('ul', 'gal-empty-tips');
    [
      '图片会自动压到 1280px 再存，不会把手机撑爆',
      '存在这台设备本地，不上传到任何地方',
      '传完之后，负一屏的照片墙也会跟着有'
    ].forEach(function (t) {
      var li = h('li', 'gal-empty-tip');
      li.appendChild(h('span', 'gal-empty-dot'));
      li.appendChild(h('span', '', t));
      tips.appendChild(li);
    });
    box.appendChild(tips);

    return box;
  }

  function iconBadge(kind) {
    var b = h('span', 'gal-empty-badge');
    if (kind === 'image') {
      b.innerHTML = ic('<rect x="3.5" y="5" width="17" height="14" rx="2.4"/>' +
        '<circle cx="9" cy="10" r="1.5"/>' +
        '<path d="M4.6 16.6l4.4-3.9 3.4 3 3-2.5 4 3.4"/>', 30);
    }
    return b;
  }

  /* ---------------------------- 缩略图 ---------------------------- */

  function thumb(ctx, p) {
    var b = h('button', 'gal-cell');
    b.type = 'button';
    /* 地址是**异步**拿的：新照片的本体在 IndexedDB 里，要现取一个 objectURL；
       老记录（dataURL）会立刻返回。所以先留空，拿到了再贴上。 */
    Sleepy.photos.srcOf(p).then(function (src) {
      if (src) b.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
    });
    if (p.caption) {
      var cap = h('span', 'gal-cell-cap', p.caption);
      b.appendChild(cap);
    }
    b.addEventListener('click', function () { openViewer(ctx, p); });
    return b;
  }

  /* ---------------------------- 大图 ---------------------------- */

  function openViewer(ctx, p) {
    var host = document.getElementById('phone') || document.body;

    var mask = h('div', 'pv-mask');
    var wrap = h('div', 'pv-wrap');

    var img = h('img', 'pv-img');
    img.alt = p.caption || '';
    Sleepy.photos.srcOf(p).then(function (src) { if (src) img.src = src; });
    wrap.appendChild(img);

    var meta = h('div', 'pv-meta');
    meta.appendChild(h('div', 'pv-cap', p.caption || '（没有说明）'));
    meta.appendChild(h('div', 'pv-date', fmtDate(p.at)));
    wrap.appendChild(meta);

    var bar = h('div', 'pv-bar');

    var edit = ui.button('改说明', 'ghost', function () {
      ui.prompt({
        title: '给这张图写点什么',
        value: p.caption || '',
        placeholder: '那天的天气、他说的话…'
      }).then(function (v) {
        if (v === null) return;
        Sleepy.photos.update(p.id, { caption: String(v).trim() });
        close();
        if (ctx.repaint) ctx.repaint();
      });
    });
    bar.appendChild(edit);

    var del = ui.button('删掉', 'danger', function () {
      ui.confirm({
        title: '删掉这张？',
        text: '删了就找不回来了。',
        ok: '删掉'
      }).then(function (yes) {
        if (!yes) return;
        Sleepy.photos.remove(p.id);
        close();
        ctx.toast('删掉了', 'ok');
        if (ctx.repaint) ctx.repaint();
      });
    });
    bar.appendChild(del);

    wrap.appendChild(bar);

    var closeBtn = h('button', 'pv-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = ic('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 18);
    closeBtn.addEventListener('click', close);
    wrap.appendChild(closeBtn);

    host.appendChild(mask);
    host.appendChild(wrap);
    setTimeout(function () {
      mask.classList.add('is-open');
      wrap.classList.add('is-open');
    }, 10);
    mask.addEventListener('click', close);

    function close() {
      mask.classList.remove('is-open');
      wrap.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
  }

  /* ---------------------------- 工具 ---------------------------- */

  function groupByDay(list) {
    var out = {};
    /* 新的排前面 */
    list.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); })
      .forEach(function (p) {
        var d = fmtDate(p.at);
        if (!out[d]) out[d] = [];
        out[d].push(p);
      });
    return out;
  }

  function doPick(ctx, owner) {
    if (!Sleepy.photos || !Sleepy.photos.pick) {
      ctx.toast('相册模块没加载出来', 'err');
      return;
    }
    /* owner：群岛选人视图里显式归被选中的那个人；孤岛不传，
       photos.add 自己按当前活动角色盖章。 */
    Sleepy.photos.pick({ title: '加照片', owner: owner }).then(function (added) {
      if (!added || !added.length) return;
      ctx.toast('加了 ' + added.length + ' 张', 'ok');
      if (ctx.repaint) ctx.repaint();
    });
  }

})(window);
