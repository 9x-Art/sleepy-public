/* ============================================================
   page-wj-read.js — 帷境 · 剧本阅读页（T3）
   依赖：wj-data.js、wj-prompt.js、wj-engine.js、page-wj-foyer.js（wjUI）
   被依赖：page-wj-work.js 的「开始阅读」、门厅「继续阅读」

   对应 Demo #3（阅读舞台 → 剧本阅读页）。视觉分层：**空间深、纸本亮**
   （用户拍板）—— 页面本身是帷境深夜色，正文永远是月光纸本。

   守住的几条：
   · 段落锚点（data-anchor）跟着每个段落走 —— 共读/批注/分享将来全
     钉在它身上，渲染层不许换 id；
   · 局部重写走 wj-engine.rewritePara（只换 text，id 不动，留修订）；
   · 已读位置写 work.progress（详情页的进度、门厅的百分比都读它）；
   · 段落类型只是排版标记：prose/dialogue/memory/scene_break 各有样式，
     但读起来必须是一篇连续的叙事。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var wj = function () { return Sleepy.wj; };
  var eng = function () { return Sleepy.wjEngine; };

  var view = { id: null, chId: null, picked: null };

  function btn(text, cls, fn) {
    var b = h('button', cls, text);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  /* ------------------------ 底部弹层（幕布色系） ------------------------ */
  function sheet(ctx, title, buildBody) {
    var mask = h('div', 'wjr-mask');
    var card = h('div', 'wjr-sheet');
    card.appendChild(h('div', 'wjr-handle'));
    card.appendChild(h('div', 'wjr-sheet-title', title));
    var box = h('div', 'wjr-sheet-body');
    card.appendChild(box);
    buildBody(box);
    var cancel = btn('关闭', 'wjr-sheet-cancel', close);
    card.appendChild(cancel);
    mask.appendChild(card);

    function close() {
      mask.classList.remove('show');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
      }, 240);
    }
    mask.addEventListener('click', function (e) {
      if (e.target === mask) close();
    });
    ctx.el.appendChild(mask);
    /* 挂上去下一帧再 show，transition 才动得起来 */
    setTimeout(function () { mask.classList.add('show'); }, 16);
    return { close: close };
  }

  /* --------------------------- 幕布入场 --------------------------- */
  function curtains(ctx) {
    var wrap = h('div', 'wjr-curtains');
    wrap.appendChild(h('i', 'wjr-curtain is-left'));
    wrap.appendChild(h('i', 'wjr-curtain is-right'));
    ctx.el.appendChild(wrap);
    setTimeout(function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }, 1500);
  }

  /* --------------------------- 章节选择 --------------------------- */
  function currentChapter(w) {
    var chs = (w && w.chapters) || [];
    if (!chs.length) return null;
    for (var i = 0; i < chs.length; i++) {
      if (chs[i].id === view.chId) return chs[i];
    }
    /* 没指定或失效：先认已读位置，再认第一章 */
    if (w.progress && w.progress.chapterId) {
      for (var j = 0; j < chs.length; j++) {
        if (chs[j].id === w.progress.chapterId) return chs[j];
      }
    }
    return chs[0];
  }

  function paraIndexOf(ch, anchorId) {
    var paras = (ch.paras || []).filter(function (p) { return p.kind !== 'scene_break'; });
    for (var i = 0; i < paras.length; i++) if (paras[i].id === anchorId) return i;
    return -1;
  }

  /* ------------------------- 段落渲染 ------------------------- */
  function paraEl(ctx, ch, p) {
    if (p.kind === 'scene_break') {
      var br = h('div', 'wjr-break');
      br.appendChild(h('span', null, '· · ·'));
      br.dataset.anchor = p.id;
      return br;
    }
    var cls = 'wjr-para' +
      (p.kind === 'dialogue' ? ' is-dialogue' : '') +
      (p.kind === 'memory' ? ' is-memory' : '') +
      (p.genState === 'rewriting' ? ' is-rewriting' : '') +
      (view.picked === p.id ? ' is-pick' : '');
    var d = h('div', cls, p.text || '');
    d.dataset.anchor = p.id;
    d.onclick = function () {
      /* 选中态直接翻 DOM，不走 repaint —— repaint 会把滚动位置抖掉 */
      var picked = view.picked === p.id ? null : p.id;
      view.picked = picked;
      var host = d.parentNode;
      var list = host ? host.querySelectorAll('.wjr-para.is-pick') : [];
      Array.prototype.forEach.call(list, function (x) {
        x.classList.remove('is-pick');
      });
      if (picked) d.classList.add('is-pick');
      var bar = host ? host.parentNode.querySelector('.wjr-pickbar') : null;
      if (bar) bar.classList.toggle('show', !!picked);
    };
    return d;
  }

  /* ------------------------- 生成与岔路 ------------------------- */
  function genBlock(ctx, w, ch) {
    var box = h('div', 'wjr-gen');
    if (ch.status === 'planned') {
      box.appendChild(h('p', 'wjr-gen-text', '这一章还没有写。'));
      box.appendChild(btn('写下本章', 'wj-btn wj-btn-solid', function () {
        eng().runChapter(w.id, ch.id).then(function () { paint(ctx); })
          ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
        /* 立即转「生成中」—— 不然取消按钮要等生成完才出现 */
        paint(ctx);
      }));
      return box;
    }
    if (ch.status === 'generating') {
      box.appendChild(h('div', 'wjr-gen-dots', [h('i'), h('i'), h('i')]));
      box.appendChild(h('p', 'wjr-gen-text', '正在写「' + ch.title + '」……'));
      box.appendChild(btn('先停一下', 'wj-btn', function () {
        eng().cancelChapter(w.id, ch.id);
        Sleepy.toast('已停下，随时可以继续');
        paint(ctx);
      }));
      return box;
    }
    if (ch.status === 'failed') {
      box.appendChild(h('p', 'wjr-gen-text is-err',
        '这一章没写完：' + (ch.error || '生成失败') +
        '。已经写好的章节都在，重试不会产生重复。'));
      box.appendChild(btn('重试本章', 'wj-btn wj-btn-solid', function () {
        eng().runChapter(w.id, ch.id).then(function () { paint(ctx); })
          ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
        paint(ctx);
      }));
      return box;
    }
    /* ready：章末岔路 + 续写入口 */
    var choices = ch.choices || [];
    if (choices.length) {
      var taken = (w.branches || []).some(function (b) { return b.fromChapterId === ch.id; });
      if (!taken) {
        box.appendChild(h('p', 'wjr-gen-text', '故事在这里出现了岔路：'));
        var cl = h('div', 'wjr-choices');
        choices.forEach(function (c) {
          var b = h('button', 'wjr-choice');
          b.type = 'button';
          b.appendChild(h('b', null, c.label));
          if (c.hint) b.appendChild(h('small', null, c.hint));
          b.onclick = function () {
            eng().chooseBranch(w.id, ch.id, c);
            Sleepy.toast('已记下岔路「' + c.label + '」，下一章沿这条路写');
            paint(ctx);
          };
          cl.appendChild(b);
        });
        box.appendChild(cl);
      }
    }
    if (wj().findChapter(w, ch.id) === (w.chapters || [])[(w.chapters || []).length - 1]) {
      box.appendChild(btn('写下第 ' + ((w.chapters || []).length + 1) + ' 章', 'wj-btn wj-btn-solid',
        function () {
          wj().addChapter(w.id, '第' + ((w.chapters || []).length + 1) + '章');
          var g = wj().get(w.id);
          var nextCh = g.chapters[g.chapters.length - 1];
          view.chId = nextCh.id;
          eng().runChapter(w.id, nextCh.id).then(function () { paint(ctx); })
            ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
          paint(ctx);
        }));
    }
    return box;
  }

  /* --------------------------- 弹层们 --------------------------- */
  function chapterSheet(ctx, w) {
    var sh = sheet(ctx, '章节目录', function (box) {
      var list = h('div', 'wjr-chlist');
      (w.chapters || []).forEach(function (c, i) {
        var on = c.id === view.chId;
        var b = h('button', 'wjr-chrow' + (on ? ' is-on' : ''));
        b.type = 'button';
        var state = c.status === 'ready' ? '已写完'
          : c.status === 'generating' ? '生成中'
          : c.status === 'failed' ? '失败' : '未写';
        b.appendChild(h('b', null, (i + 1) + ' · ' + c.title));
        b.appendChild(h('small', null, state + ' · ' +
          ((c.paras || []).filter(function (p) { return p.kind !== 'scene_break'; }).length) + ' 段'));
        b.onclick = function () {
          view.chId = c.id;
          view.picked = null;
          /* 先拆弹层再换章 —— 否则 mask 留在页面上拦住一切点击 */
          sh.close();
          paint(ctx);
          ctx.el.scrollTop = 0;
        };
        list.appendChild(b);
      });
      box.appendChild(list);
    });
  }

  var REWRITE_CHIPS = ['换一种说法', '更克制', '更有画面', '节奏快一点', '多一点潜台词'];

  function rewriteSheet(ctx, w, ch) {
    var para = null;
    (ch.paras || []).forEach(function (p) { if (p.id === view.picked) para = p; });
    if (!para) { Sleepy.toast('先选一段正文'); return; }
    var sh = sheet(ctx, '重写这一段', function (box) {
      box.appendChild(h('p', 'wjr-sheet-note',
        '只改这一段，段落的锚点不变 —— 以后挂在这段上的批注与分享都不受影响。'));
      var chips = h('div', 'wjr-chips');
      REWRITE_CHIPS.forEach(function (t) {
        var b = h('button', 'wj-chip', t);
        b.type = 'button';
        b.onclick = function () {
          ta.value = ta.value ? (ta.value + '；' + t) : t;
        };
        chips.appendChild(b);
      });
      box.appendChild(chips);
      var ta = h('textarea', 'wj-textarea');
      ta.placeholder = '想怎么改？例如：把告别写得再收着一点。';
      box.appendChild(ta);
      var go = btn('开始重写', 'wj-btn wj-btn-solid wjr-sheet-go', function () {
        go.disabled = true;
        eng().rewritePara(w.id, ch.id, para.id, ta.value.trim())
          .then(function () {
            Sleepy.toast('这一段已经重写（旧版留在修订里）');
            view.picked = null;
            /* 先拆弹层再重画 —— mask 挂在页面上，不拆会一直拦点击 */
            sh.close();
            paint(ctx);
          })
          ['catch'](function (e) {
            Sleepy.toast(e.message || '重写失败');
            go.disabled = false;
          });
      });
      box.appendChild(go);
    });
  }

  function noteSheet(ctx, w, ch) {
    var sh = sheet(ctx, '创作手记 · ' + ch.title, function (box) {
      box.appendChild(h('p', 'wjr-sheet-note',
        '写给下一次生成看：这一章你还想让它做什么。只影响之后的续写与重写，不动已写正文。'));
      var ta = h('textarea', 'wj-textarea');
      ta.value = ch.directorNote || '';
      ta.placeholder = '例如：这一章收在雨停之前，别让两个人把话说透。';
      box.appendChild(ta);
      box.appendChild(btn('保存手记', 'wj-btn wj-btn-solid wjr-sheet-go', function () {
        wj().mutate(w.id, function (x) {
          var c = wj().findChapter(x, ch.id);
          if (c) c.directorNote = ta.value.trim();
          return x;
        });
        Sleepy.toast('手记已存');
        sh.close();
        paint(ctx);
      }));
    });
  }

  /* --------------------------- 已读位置 --------------------------- */
  var scrollTimer = null;

  function trackScroll(ctx, w, ch) {
    var page = ctx.el;
    if (page.__wjrScroll) page.removeEventListener('scroll', page.__wjrScroll);
    page.__wjrScroll = function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        var paras = (ch.paras || []).filter(function (p) { return p.kind !== 'scene_break'; });
        if (!paras.length) return;
        var max = page.scrollHeight - page.clientHeight;
        var pct = max > 0 ? page.scrollTop / max : 0;
        var idx = Math.max(0, Math.min(paras.length - 1,
          Math.round(pct * (paras.length - 1))));
        eng().saveProgress(w.id, ch.id, paras[idx].id);
      }, 700);
    };
    page.addEventListener('scroll', page.__wjrScroll);
  }

  /* ----------------------------- 主绘制 ----------------------------- */
  function paint(ctx) {
    var w = view.id ? wj().get(view.id) : null;
    var body = ctx.body;
    body.innerHTML = '';
    if (!w) {
      ctx.setTitle('剧本阅读页');
      ctx.setActions([]);
      body.appendChild(h('div', 'wj-empty', '这部剧本已经不在门厅里了。'));
      return;
    }
    var ch = currentChapter(w);
    ctx.setTitle('剧本阅读页');
    ctx.setActions([{ label: '手记', onClick: function () {
      if (ch) noteSheet(ctx, w, ch);
    } }]);

    var shell = h('div', 'wj-shell wjr');

    /* ---- 头 ---- */
    var headBox = h('div', 'wjr-head');
    headBox.appendChild(h('div', 'wj-eyebrow', w.title || '未命名剧本'));
    headBox.appendChild(h('h1', 'wj-h1', ch ? ch.title : '还没有章节'));
    if (ch && ch.brief) headBox.appendChild(h('p', 'wj-sub', ch.brief));
    shell.appendChild(headBox);

    if (!ch) {
      shell.appendChild(h('div', 'wj-empty',
        '这部剧本还没有章节。\n回剧本详情页规划章节，或直接写下第一章。'));
      body.appendChild(shell);
      return;
    }

    /* ---- 月光纸本 ---- */
    var paper = h('div', 'wjr-paper');
    var kicker = h('div', 'wjr-kicker');
    kicker.appendChild(h('span', null, '第 ' + ch.seq + ' 章'));
    kicker.appendChild(h('span', null, '月光纸本'));
    paper.appendChild(kicker);

    (ch.paras || []).forEach(function (p) {
      paper.appendChild(paraEl(ctx, ch, p));
    });
    if (!(ch.paras || []).length && ch.status !== 'planned' && ch.status !== 'generating') {
      paper.appendChild(h('div', 'wj-empty', '这一章还没有正文。'));
    }
    shell.appendChild(paper);

    /* ---- 生成 / 岔路 ---- */
    shell.appendChild(genBlock(ctx, w, ch));

    /* ---- 选段操作条（点段落出现） ---- */
    var pickbar = h('div', 'wjr-pickbar' + (view.picked ? ' show' : ''));
    pickbar.appendChild(btn('重写此段', 'wj-btn wjr-pickbtn', function () {
      rewriteSheet(ctx, w, ch);
    }));
    pickbar.appendChild(btn('取消选择', 'wj-quiet', function () {
      view.picked = null;
      var picked = paper.querySelectorAll('.wjr-para.is-pick');
      Array.prototype.forEach.call(picked, function (x) { x.classList.remove('is-pick'); });
      pickbar.classList.remove('show');
    }));
    shell.appendChild(pickbar);

    /* ---- 底部工具 ---- */
    var chs = w.chapters || [];
    var idx = -1;
    chs.forEach(function (c, i) { if (c.id === ch.id) idx = i; });
    var tools = h('div', 'wjr-tools');
    tools.appendChild(btn('‹ 上一章', 'wjr-tool' + (idx > 0 ? '' : ' is-off'), function () {
      if (idx <= 0) return;
      view.chId = chs[idx - 1].id;
      view.picked = null;
      paint(ctx);
      ctx.el.scrollTop = 0;
    }));
    tools.appendChild(btn('章节目录', 'wjr-tool', function () { chapterSheet(ctx, w); }));
    tools.appendChild(btn('下一章 ›', 'wjr-tool' + (idx < chs.length - 1 ? '' : ' is-off'),
      function () {
        if (idx >= chs.length - 1) return;
        view.chId = chs[idx + 1].id;
        view.picked = null;
        paint(ctx);
        ctx.el.scrollTop = 0;
      }));
    shell.appendChild(tools);

    body.appendChild(shell);
    trackScroll(ctx, w, ch);

    /* 打开这一章就把位置记下（滚动追踪随后接管） */
    var paras = (ch.paras || []).filter(function (p) { return p.kind !== 'scene_break'; });
    if (paras.length) {
      eng().saveProgress(w.id, ch.id,
        w.progress && w.progress.chapterId === ch.id && w.progress.anchorId
          ? w.progress.anchorId : paras[0].id);
    }
  }

  Sleepy.register('wj-read', {
    title: '剧本阅读页',
    render: function (ctx) {
      var p = ctx.params || {};
      if (p.id && p.id !== view.id) {
        view.id = p.id;
        view.chId = p.ch || null;
        view.picked = null;
        curtains(ctx);          /* 只在换了一部作品时拉开幕布 */
      } else if (p.ch && p.ch !== view.chId) {
        view.chId = p.ch;
      }
      if (!view.chId) {
        var w = wj().get(view.id);
        if (w && w.progress && w.progress.chapterId) view.chId = w.progress.chapterId;
      }
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    },
    onHide: function (ctx) {
      var page = ctx.el;
      if (page.__wjrScroll) {
        page.removeEventListener('scroll', page.__wjrScroll);
        page.__wjrScroll = null;
      }
    }
  });

})(window);
