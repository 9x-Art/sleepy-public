/* ============================================================
   page-wj-foyer.js — 帷境 · 门厅
   依赖：wj-data.js（数据）、ui.js（h）
   被依赖：桌面那格「帷境」、以及其它 wj 页面的「返回门厅」

   门厅是帷境的**中枢**，不是装饰首页（总纲 §7.1）。它要承载：
   最近阅读 / 未完成 / 已完成 / 未开帷草稿 / 新建故事。

   ★ 交互关系（Demo 里全是 toast 占位，这里必须接通）：
     新建故事 → wj-create（五步开帷）
     书架卡片 → wj-work（剧本详情）
     继续阅读 → wj-work（T3 接上阅读页后改跳 wj-read）
     右上「文风」→ wj-style（全局雷区与底座，它管所有作品）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;

  var FILTERS = [
    { id: 'recent', name: '最近阅读' },
    { id: 'unfinished', name: '未完成' },
    { id: 'completed', name: '已完成' },
    { id: 'draft', name: '未开帷草稿' }
  ];

  /* 页面内存：只放「当前选了哪个筛选」。视图状态不该进存档。 */
  var view = { filter: 'recent' };

  function statusText(w) {
    if (w.status === 'draft') return '未开帷草稿';
    var r = Sleepy.wj.REALITY_LABEL[w.reality] || '普通故事';
    if (w.status === 'completed') return r + ' · 已完成';
    if (w.status === 'paused') return r + ' · 已暂停';
    if (w.status === 'failed') return r + ' · 生成失败';
    return r + ' · 连载中';
  }

  function statusClass(w) {
    if (w.status === 'draft') return 'is-draft';
    if (w.status === 'completed') return 'is-done';
    if (w.status === 'failed') return 'is-fail';
    return '';
  }

  /* 封面：Demo 里三套渐变（night / paper / fog）。这里按真实性派生 ——
     普通故事用夜色，平行世界用雾，正史候选压一层酒红（它是唯一会
     碰到现实的那一档，视觉上就该不一样）。 */
  function coverEl(work, cls) {
    var box = h('div', 'wj-cover ' + (cls || ''));
    var r = work.reality;
    if (r === 'parallel') box.classList.add('is-fog');
    if (r === 'canon_candidate' || r === 'canonized') box.classList.add('is-wine');
    if (!Sleepy.wj.chapterCount(work)) box.classList.add('is-empty');
    box.appendChild(h('span', 'wj-cover-title', work.title || '未命名剧本'));
    return box;
  }

  function progressLine(w) {
    var p = Sleepy.wj.progressOf(w);
    if (!p.total) return '尚未开帷';
    var chs = Sleepy.wj.chapterCount(w, true);
    if (!chs) return '计划中 · ' + (w.chapters || []).length + ' 章';
    return '已写 ' + chs + ' 章 · 约 ' + Sleepy.wj.charCount(w) + ' 字';
  }

  function paint(ctx) {
    ctx.setTitle('帷境');
    /* setActions 吃的是**描述对象**（app.js 自己建 .head-act 按钮）——
       塞 DOM 元素进去会得到一个没有字的空壳，真机才看得出来。 */
    ctx.setActions([{ label: '文风', onClick: function () {
      Sleepy.nav.open('wj-style', {});
    } }]);

    var body = ctx.body;
    body.innerHTML = '';

    var shell = h('div', 'wj-shell wj-foyer');

    /* -------- 头 -------- */
    var hero = h('div', 'wj-hero');
    var heroText = h('div', 'wj-hero-text');
    heroText.appendChild(h('div', 'wj-eyebrow', 'PRIVATE STORY ARCHIVE'));
    heroText.appendChild(h('h1', 'wj-h1', '今晚，想读哪一种可能？'));
    heroText.appendChild(h('p', 'wj-sub', '未被现实认领的故事，都安静地留在这里。'));
    hero.appendChild(heroText);
    hero.appendChild(btn('新建故事', 'wj-btn wj-btn-solid', function () {
      Sleepy.nav.open('wj-create', {});
    }));
    shell.appendChild(hero);

    /* -------- 最近阅读（只认真有正文的） -------- */
    var recent = Sleepy.wj.recentReadable();
    if (recent) {
      var card = h('div', 'wj-continue');
      card.appendChild(coverEl(recent, 'wj-cover-sm'));
      var info = h('div', 'wj-continue-info');
      info.appendChild(h('div', 'wj-eyebrow', '最近阅读 · ' + (Sleepy.wj.REALITY_LABEL[recent.reality] || '')));
      info.appendChild(h('h2', 'wj-h2', recent.title));
      info.appendChild(h('p', 'wj-sub', recent.desc || '还没有写简介。'));
      var p = Sleepy.wj.progressOf(recent);
      var meter = h('div', 'wj-meter');
      var fill = h('i');
      fill.style.width = Math.max(2, Math.min(100, p.percent)) + '%';
      meter.appendChild(fill);
      info.appendChild(meter);
      info.appendChild(h('div', 'wj-meter-line',
        '已读 ' + p.percent + '% · ' + progressLine(recent)));
      card.appendChild(info);
      card.appendChild(btn('继续阅读', 'wj-btn', function () {
        /* T3 起直接进阅读页：阅读页自己会接已读位置（work.progress），
           没读过就落在第一章。 */
        Sleepy.nav.open('wj-read', { id: recent.id });
      }));
      shell.appendChild(card);
    }

    /* -------- 四档筛选 -------- */
    var filters = h('div', 'wj-filters');
    FILTERS.forEach(function (f) {
      var b = h('button', 'wj-filter' + (view.filter === f.id ? ' is-on' : ''), f.name);
      b.type = 'button';
      b.onclick = function () {
        view.filter = f.id;
        paint(ctx);
      };
      filters.appendChild(b);
    });
    shell.appendChild(filters);

    /* -------- 书架 -------- */
    var list = Sleepy.wj.shelf(view.filter);
    var shelf = h('div', 'wj-shelf');
    if (!list.length) {
      var tips = {
        recent: '这里暂时没有剧本。新的可能开帷以后，会出现在这座书架上。',
        unfinished: '没有写到一半的作品。',
        completed: '还没有完结的剧本。',
        draft: '没有未开帷的草稿。'
      };
      shelf.appendChild(h('div', 'wj-empty', tips[view.filter] || tips.recent));
    } else {
      list.forEach(function (w) {
        var c = h('button', 'wj-work-card');
        c.type = 'button';
        c.appendChild(coverEl(w, 'wj-cover-mini'));
        var wb = h('div', 'wj-work-body');
        wb.appendChild(h('div', 'wj-status ' + statusClass(w), statusText(w)));
        wb.appendChild(h('h3', 'wj-work-title', w.title));
        wb.appendChild(h('p', 'wj-work-line', progressLine(w)));
        if ((w.cast || []).length) {
          wb.appendChild(h('p', 'wj-work-line', w.cast.map(function (x) {
            return x.name;
          }).join(' · ')));
        }
        c.appendChild(wb);
        c.onclick = function () { Sleepy.nav.open('wj-work', { id: w.id }); };
        shelf.appendChild(c);
      });
    }
    shell.appendChild(shelf);

    body.appendChild(shell);
  }

  /* 右上角动作走 ctx.setActions 的描述对象，这里不再需要自建按钮 */

  function btn(text, cls, fn) {
    var b = h('button', cls, text);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  Sleepy.register('wj-foyer', {
    title: '帷境',
    render: function (ctx) {
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) {
      /* 从创建流程 / 详情页回来要看到最新的：新建的草稿、改过的标题、
         刚写完的章节，全都落在这里 —— 但数据版本没变就不必整页重画
         （2026-10-29 用户报「来回切换白屏等一下」）。 */
      wjFreshPaint(ctx);
    }
  });

  /* ------------------------ onShow 防重画 ------------------------
     2026-10-29 用户报手感：帷境各页 onShow 一律整页 innerHTML 重建，
     返回 / 关弹层都要白屏等一下。改成比对 store 写盘版本号：数据没动
     就跳过 paint，页面原样留着（app.js 的页面栈本来就只藏不销毁）。
     数据动了（写作品 / 写同席 session / 改文风）版本必然 +1，照样重画，
     不会漏更新。render 和首次 onShow 之间没有写入，版本相同自然跳过
     —— 顺便把「首次展示画两遍」也省了。 */
  function wjFreshPaint(ctx, tops) {
    if (!ctx || !ctx.__paint) return;
    var v = '';
    if (Sleepy.store && Sleepy.store.ver) {
      (tops || ['wjWorks', 'wjSessions', 'wjTickets', 'wjStyleCfg'])
        .forEach(function (t) { v += t + ':' + Sleepy.store.ver(t) + '|'; });
    }
    if (ctx.__wjVer === v) return;
    ctx.__wjVer = v;
    ctx.__paint();
  }

  /* 别的页面也要用这套小工具，挂出去省得各写一遍 */
  Sleepy.wjUI = { btn: btn, coverEl: coverEl,
    statusText: statusText, progressLine: progressLine,
    freshPaint: wjFreshPaint };

})(window);
