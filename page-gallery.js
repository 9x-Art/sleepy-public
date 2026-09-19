/* ============================================================
   page-gallery.js — 相册（模块 J）

   和负一屏的照片墙是**同一份数据**（Sleepy.photos），
   区别只是：
     · 照片墙 = 取前 4 张，贴成错落的拍立得（装饰性，只读）
     · 相册   = 全部，网格铺开，可点开大图 / 改标题 / 删

   空态是重点：没有照片时**必须能直接点着上传**，
   而不是给一句「等接上 IndexedDB」然后就没下文了。
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

      var list = photos();

      /* 顶栏右侧：加号。无论空不空都留着，空态那个大按钮只是更好按。
         注意 setActions 收的是**描述对象数组**，不是 DOM 节点 ——
         传元素进去会在 (list||[]).forEach 上炸，而且是被 app.js 的
         错误边界吞掉、只显示「这一页出错了」，不太好回溯。 */
      ctx.setActions([{
        label: '加照片',
        svg: ic('<path d="M12 6.5v11M6.5 12h11"/>', 18),
        onClick: function () { doPick(ctx); }
      }]);

      if (!list.length) {
        body.appendChild(emptyState(ctx));
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

      /* 统计 + 占用：让用户对「还剩多少」有个概念。
         占用算**全部存档**的量（diskUsage 是全量），不能只算当前房：
         localStorage 是 5MB 一个池子，只显示本房占用会让人以为还很空，
         然后在另一间房里撞配额。张数仍然是本房的（list 是过滤过的）。

         走了 IndexedDB 之后，占用分两截：图片本体在 IDB（磁盘级配额，
         基本不用担心），老的 dataURL 记录还在 localStorage 那个池子里。
         所以进度条按 **localStorage 那一截**算 —— 那才是会顶到上限的部分。 */
      var legacy = Sleepy.photos ? Sleepy.photos.usedBytes() : 0;
      var limit = (Sleepy.photos && Sleepy.photos.SOFT_LIMIT) || 1;
      var pct = Math.min(100, Math.round(legacy / limit * 100));
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

      /* 上传按钮浮在右下角 */
      var fab = h('button', 'gal-fab');
      fab.type = 'button';
      fab.setAttribute('aria-label', '加照片');
      fab.innerHTML = ic('<path d="M12 6.5v11M6.5 12h11"/>', 20);
      fab.addEventListener('click', function () { doPick(ctx); });
      body.appendChild(fab);
    }
  });

  /* ---------------------------- 空态 ---------------------------- */

  /* 空态做成整块可点的上传区。刻意做得比「一个加号」大很多：
     这是这条流程唯一的入口，用户第一次进来必须一眼看到该点哪儿。 */
  function emptyState(ctx) {
    var box = h('div', 'gal-empty');

    var drop = h('button', 'gal-empty-drop');
    drop.type = 'button';
    drop.appendChild(iconBadge('image'));
    drop.appendChild(h('p', 'gal-empty-title', '还没有照片'));
    drop.appendChild(h('p', 'gal-empty-hint', '点这里，从相册里选几张'));
    drop.addEventListener('click', function () { doPick(ctx); });
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

  function doPick(ctx) {
    if (!Sleepy.photos || !Sleepy.photos.pick) {
      ctx.toast('相册模块没加载出来', 'err');
      return;
    }
    Sleepy.photos.pick({ title: '加照片' }).then(function (added) {
      if (!added || !added.length) return;
      ctx.toast('加了 ' + added.length + ' 张', 'ok');
      if (ctx.repaint) ctx.repaint();
    });
  }

})(window);
