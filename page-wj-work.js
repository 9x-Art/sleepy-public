/* ============================================================
   page-wj-work.js — 帷境 · 剧本详情
   依赖：wj-data.js、page-wj-foyer.js（借它的 wjUI 小工具）、ui.js
   被依赖：门厅的书架卡片、谢幕页的「返回剧本」

   详情页有两件东西**必须保留**（它们是这个产品最容易读懂的地方）：
     1. facts 四格 = 当前进度 / 作品性质 / user 位置 / 最近修改；
     2. 概览页的三层权限三卡 = 创作取材 / 人物知情 / 现实写回，
        每张都配一句「它不等于什么」（总纲 §4，方案 §1.3）。

   三层权限在数据、UI、写入三处都要分开 —— 这里是 UI 那一处。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var D = function () { return Sleepy.wj; };
  var wjData = D;

  var TABS = [
    { id: 'overview', name: '作品概览' },
    { id: 'chapters', name: '章节' },
    { id: 'branches', name: '故事分支' },
    { id: 'versions', name: '版本' },
    { id: 'check', name: '成稿检查' }
  ];

  var view = { id: null, tab: 'overview' };

  function btn(text, cls, fn) {
    var b = h('button', cls, text);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  function timeText(iso) {
    if (!iso) return '—';
    var t = new Date(iso);
    if (isNaN(t.getTime())) return '—';
    var d = new Date();
    var sameDay = t.toDateString() === d.toDateString();
    var hh = String(t.getHours()).padStart(2, '0');
    var mm = String(t.getMinutes()).padStart(2, '0');
    if (sameDay) return '今天 ' + hh + ':' + mm;
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 ' + hh + ':' + mm;
  }

  /* ---------- 三层权限：概览页那三张卡 ---------- */
  function boundaryCards(w) {
    var real = D().realityOf(w);

    var writeBack, writeBackHint;
    if (w.reality === 'canon_candidate') {
      writeBack = '不会自动写入';
      writeBackHint = '它是正史候选：谢幕后要逐条审阅、检查时间线冲突，批准后才写入结构化事实。';
    } else if (w.reality === 'canonized') {
      writeBack = '已定史（只读）';
      writeBackHint = '批准过的结构化事实已经写入现实系统；小说原文仍完整保留在帷境。';
    } else {
      writeBack = '不会写入现实';
      writeBackHint = real.id === 'parallel'
        ? '平行世界永不写入现实正史，可以自由改变身份与命运。'
        : '普通故事只是作品。它不会进入任何人的现实记忆。';
    }

    var known = knownText(w);
    var wrap = h('div', 'wj-boundary');
    wrap.appendChild(boundaryCard('创作取材',
      D().MATERIAL_LABEL[w.materialScope] || '不读取',
      '这些资料只用于创作，不代表人物知道剧本存在。'));
    wrap.appendChild(boundaryCard('人物知情', known.text, known.hint));
    wrap.appendChild(boundaryCard('现实写回', writeBack, writeBackHint, true));
    return wrap;
  }

  function boundaryCard(label, value, hint, accent) {
    var c = h('div', 'wj-bcard' + (accent ? ' is-accent' : ''));
    c.appendChild(h('small', 'wj-bcard-label', label));
    c.appendChild(h('b', 'wj-bcard-value', value));
    c.appendChild(h('p', 'wj-bcard-hint', hint));
    return c;
  }

  /* 「人物知情」现在是诚实的空集：分享 / 同席 / 论坛三条路都还没接通
     （T5/T6），所以这里如实说「目前无人知情」。等那三路上线，
     这个函数改成读作品的知情名单，别的地方不用动。 */
  function knownText(w) {
    if (w.status === 'draft') {
      return { text: '尚未开帷', hint: '草稿还没有变成作品，也还没有人可以知道它。' };
    }
    return {
      text: '当前无人知情',
      hint: '只有把作品分享给他、或邀请他同席并被他接受，他才知道这篇存在。'
    };
  }

  /* ---------- 四个 tab 的正文 ---------- */
  function paneOverview(w) {
    var box = h('div', 'wj-pane');
    box.appendChild(sectionTitle('认知边界', '这三件事彼此独立，任意两件被合在一起都是错的。'));
    box.appendChild(boundaryCards(w));

    var box2 = h('div', 'wj-pane-gap');
    box2.appendChild(sectionTitle('本篇设置', '改这些不会动已经写下的正文。'));
    var rows = h('div', 'wj-rows');
    rows.appendChild(rowLine('作品性质', (D().REALITY_LABEL[w.reality] || '') +
      ' · ' + (D().TIME_ANCHOR_LABEL[w.timeAnchor] || '')));
    rows.appendChild(rowLine('user 位置', D().USER_POS_LABEL[w.userPos] || '—'));
    rows.appendChild(rowLine('取材范围', D().MATERIAL_LABEL[w.materialScope] || '—'));
    rows.appendChild(rowLine('文风', D().styleOf(w).name));
    rows.appendChild(rowLine('视角 / 篇幅', w.pov + ' · ' + w.length));
    if ((w.workRules || []).length) {
      rows.appendChild(rowLine('本篇雷区', w.workRules.length + ' 条'));
    }
    box2.appendChild(rows);
    box2.appendChild(btn('修改本篇设置', 'wj-btn wj-btn-ghost', function () {
      Sleepy.nav.open('wj-create', { workId: w.id, step: 0 });
    }));
    box.appendChild(box2);
    return box;
  }

  function paneChapters(w, ctx) {
    var box = h('div', 'wj-pane');
    var chs = w.chapters || [];
    if (!chs.length) {
      box.appendChild(h('div', 'wj-empty',
        w.status === 'draft'
          ? '草稿尚未开帷，因此还没有可阅读章节。'
          : '这部剧本还没有章节。先规划一份章节计划，或直接写下第一章。'));
      var boot = h('div', 'wj-pane-gap');
      boot.appendChild(btn('规划章节', 'wj-btn wj-btn-solid wj-btn-ghost', function () {
        Sleepy.toast('正在规划章节……');
        Sleepy.wjEngine.planChapters(w.id).then(function (n) {
          Sleepy.toast('规划好了 ' + n + ' 章');
          paint(ctx);
        })['catch'](function (e) {
          Sleepy.toast(e.message || '规划失败');
          paint(ctx);
        });
      }));
      boot.appendChild(btn('直接写第一章', 'wj-btn wj-btn-ghost', function () {
        wjData().addChapter(w.id, '第一章');
        var g = wjData().get(w.id);
        Sleepy.wjEngine.runChapter(w.id, g.chapters[0].id)
          .then(function () { Sleepy.toast('第一章写完了'); paint(ctx); })
          ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
      }));
      box.appendChild(boot);
      return box;
    }
    var list = h('div', 'wj-rows');
    chs.forEach(function (ch, i) {
      var n = (ch.paras || []).length;
      var state = ch.status === 'ready' ? '已写完 · ' + n + ' 段'
        : ch.status === 'generating' ? '生成中'
          : ch.status === 'failed' ? '生成失败' : '尚未生成';
      var r = h('div', 'wj-row wj-row-link');
      var main = h('div', 'wj-row-main');
      main.appendChild(h('b', 'wj-row-title', ch.title || ('第' + (i + 1) + '章')));
      main.appendChild(h('span', 'wj-row-hint', i === 0 ? '稳定版本 · 可阅读' : '作品目录'));
      r.appendChild(main);
      r.appendChild(h('em', 'wj-row-tail', state));
      r.onclick = function () {
        Sleepy.nav.open('wj-read', { id: w.id, ch: ch.id });
      };
      list.appendChild(r);
    });
    box.appendChild(list);

    /* 续写入口：最后一章写完了才给「下一章」；有 planned 的章先补它 */
    var last = chs[chs.length - 1];
    var pending = null;
    chs.forEach(function (c) { if (!pending && c.status !== 'ready') pending = c; });
    var more = h('div', 'wj-pane-gap');
    if (last.status === 'ready' && !pending) {
      more.appendChild(btn('写下第 ' + (chs.length + 1) + ' 章', 'wj-btn wj-btn-solid wj-btn-ghost',
        function () {
          wjData().addChapter(w.id, '第' + (chs.length + 1) + '章');
          var g = wjData().get(w.id);
          Sleepy.wjEngine.runChapter(w.id, g.chapters[g.chapters.length - 1].id)
            .then(function () { paint(ctx); })
            ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
        }));
    } else if (pending && pending.status === 'planned') {
      more.appendChild(btn('写下「' + pending.title + '」', 'wj-btn wj-btn-solid wj-btn-ghost',
        function () {
          Sleepy.wjEngine.runChapter(w.id, pending.id)
            .then(function () { paint(ctx); })
            ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
        }));
    } else if (pending && pending.status === 'failed') {
      more.appendChild(btn('重试「' + pending.title + '」', 'wj-btn wj-btn-solid wj-btn-ghost',
        function () {
          Sleepy.wjEngine.runChapter(w.id, pending.id)
            .then(function () { paint(ctx); })
            ['catch'](function (e) { Sleepy.toast(e.message || '生成失败'); paint(ctx); });
        }));
    }
    box.appendChild(more);
    return box;
  }

  /* 分支与版本：T3 起吃**真实数据** —— 章末岔路的选择记在
     work.branches，第一份稳定版本记在 work.versions。没数据时仍
     如实说「还没有」，不许拿假数据撑页面。 */
  function paneBranches(w) {
    var box = h('div', 'wj-pane');
    var list = w.branches || [];
    if (!list.length) {
      box.appendChild(h('div', 'wj-empty',
        w.status === 'draft'
          ? '草稿还没有开帷，暂时没有分支可以看。'
          : '还没有产生故事分支。\n章末出现岔路时在这里选，选择会决定下一章往哪边写。'));
      return box;
    }
    var rows = h('div', 'wj-rows');
    list.forEach(function (b) {
      var r = h('div', 'wj-row');
      var main = h('div', 'wj-row-main');
      main.appendChild(h('b', 'wj-row-title', '选了「' + b.label + '」'));
      main.appendChild(h('span', 'wj-row-hint',
        (b.hint ? b.hint + ' · ' : '') + '挂靠 ' + (b.fromAnchorId || '章末')));
      r.appendChild(main);
      r.appendChild(h('em', 'wj-row-tail', timeText(b.chosenAt)));
      rows.appendChild(r);
    });
    if (w.nextBranch && w.nextBranch.label) {
      var r2 = h('div', 'wj-row');
      var m2 = h('div', 'wj-row-main');
      m2.appendChild(h('b', 'wj-row-title', '下一章将沿「' + w.nextBranch.label + '」写'));
      m2.appendChild(h('span', 'wj-row-hint', '写下下一章时自动生效。'));
      r2.appendChild(m2);
      rows.appendChild(r2);
    }
    box.appendChild(rows);
    return box;
  }

  function paneVersions(w) {
    var box = h('div', 'wj-pane');
    var list = w.versions || [];
    if (!list.length) {
      box.appendChild(h('div', 'wj-empty',
        w.status === 'draft'
          ? '草稿还没有开帷，暂时没有版本记录。'
          : '还没有版本记录。\n第一章生成完成时，会留下第一份稳定版本。'));
      return box;
    }
    var rows = h('div', 'wj-rows');
    list.forEach(function (v) {
      var r = h('div', 'wj-row');
      var main = h('div', 'wj-row-main');
      main.appendChild(h('b', 'wj-row-title', v.label));
      main.appendChild(h('span', 'wj-row-hint', v.paras + ' 段正文'));
      r.appendChild(main);
      r.appendChild(h('em', 'wj-row-tail', timeText(v.createdAt)));
      rows.appendChild(r);
    });
    box.appendChild(rows);
    return box;
  }

  /* ---------- 成稿检查（T4）：五层八股 + 漂移 + 人物声音 ----------
     检查在 wj-check.js（0 API，本地）。这里只负责两件事：
     把报告摊开给人看、把「重写此段」接到 engine 的重写管线上 ——
     **检查无权静默重写全文**（总纲 §14），每一次重写都是用户点的。 */
  function paneCheck(w, ctx) {
    var box = h('div', 'wj-pane');
    var hasReady = (w.chapters || []).some(function (c) { return c.status === 'ready'; });
    if (!hasReady) {
      box.appendChild(h('div', 'wj-empty',
        w.status === 'draft'
          ? '草稿还没有开帷，没有成稿可检查。'
          : '还没有写完的章节。生成完成后再来这里看检查报告。'));
      return box;
    }

    var r = Sleepy.wjCheck.all(w);

    /* ---- 问题段 ---- */
    box.appendChild(sectionTitle('问题段 · 只重写被点名的',
      '检查只报告，不动正文。点「重写此段」才会重写 —— 且只动那一段，锚点不变。'));
    if (!r.issues.length) {
      box.appendChild(h('div', 'wj-empty', '五层检查都干净。\n干净不等于没有问题 —— 逻辑与声音最终要靠你自己读。'));
    } else {
      var list = h('div', 'wj-rows wjc-list');
      r.issues.forEach(function (it) {
        var layerMeta = Sleepy.wjCheck.LAYERS.filter(function (x) { return x.id === it.layer; })[0];
        var row = h('div', 'wj-row wjc-row');
        var main = h('div', 'wj-row-main');
        var head = h('div', 'wjc-head');
        head.appendChild(h('span', 'wjc-layer is-' + it.layer,
          (layerMeta ? layerMeta.name : it.layer) +
          (layerMeta && layerMeta.id === 'logic' ? ' · 代理检查' : '')));
        head.appendChild(h('b', 'wjc-rule', it.rule));
        main.appendChild(head);
        main.appendChild(h('span', 'wjc-excerpt', '「' + it.excerpt + '」'));
        main.appendChild(h('span', 'wjc-hint', it.hint));
        main.appendChild(h('span', 'wjc-loc',
          '《' + it.chapterTitle + '》第 ' + it.paraNo + ' 段'));
        row.appendChild(main);
        row.appendChild(h('em', 'wj-row-tail', ''));
        var fix = btn('重写此段', 'wjc-fix', function () {
          fix.disabled = true;
          fix.textContent = '重写中…';
          Sleepy.wjEngine.rewritePara(w.id, it.chapterId, it.paraId,
            '成稿检查（' + it.rule + '）：' + it.hint)
            .then(function () {
              Sleepy.toast('已重写，检查报告已刷新');
              paint(ctx);
            })
            ['catch'](function (e) {
              Sleepy.toast(e.message || '重写失败');
              fix.disabled = false;
              fix.textContent = '重写此段';
            });
        });
        row.appendChild(fix);
        list.appendChild(row);
      });
      box.appendChild(list);
    }

    /* ---- 跨章风格漂移 ---- */
    var box2 = h('div', 'wj-pane-gap');
    box2.appendChild(sectionTitle('跨章风格漂移',
      '只给数字与突变，判断权在你。文风台的口径是基准。'));
    var dRows = h('div', 'wj-rows');
    if (!r.drift.rows.length) {
      dRows.appendChild(h('p', 'wj-sub', '还没有可对比的章节。'));
    } else {
      r.drift.rows.forEach(function (row) {
        var el = h('div', 'wj-row');
        var main = h('div', 'wj-row-main');
        main.appendChild(h('b', 'wj-row-title', row.title));
        main.appendChild(h('span', 'wj-row-hint',
          row.paras + ' 段 · 平均 ' + row.avgLen + ' 字/段 · 对白 ' + row.dialogueRatio + '%'));
        el.appendChild(main);
        dRows.appendChild(el);
      });
      (r.drift.notes || []).forEach(function (n) {
        var el = h('div', 'wj-notice', n);
        dRows.appendChild(el);
      });
      if (!(r.drift.notes || []).length && r.drift.rows.length > 1) {
        dRows.appendChild(h('p', 'wj-notice is-ok', '相邻章节的口径没有突变。'));
      }
    }
    box2.appendChild(dRows);
    box.appendChild(box2);

    /* ---- 人物声音 ---- */
    var box3 = h('div', 'wj-pane-gap');
    box3.appendChild(sectionTitle('人物声音差异',
      '同一个人跨章是同一种声音；不同人物不共用一种腔调。这里是统计与提醒，不是评分。'));
    var vRows = h('div', 'wj-rows');
    if (!r.voices.length) {
      vRows.appendChild(h('p', 'wj-sub', '还没有可统计的台词。'));
    } else {
      r.voices.forEach(function (v) {
        var el = h('div', 'wj-row');
        var main = h('div', 'wj-row-main');
        main.appendChild(h('b', 'wj-row-title', v.name));
        main.appendChild(h('span', 'wj-row-hint', v.lines
          ? v.lines + ' 句台词 · 平均 ' + v.avgLen + ' 字'
          : '还没有认出 TA 的台词（对白段开头写说话人才能认出）'));
        el.appendChild(main);
        vRows.appendChild(el);
        if (v.remind) vRows.appendChild(h('div', 'wj-notice', v.remind));
      });
    }
    box3.appendChild(vRows);
    box.appendChild(box3);
    return box;
  }

  function sectionTitle(t, hint) {
    var s = h('div', 'wj-section-head');
    s.appendChild(h('h3', 'wj-h3', t));
    if (hint) s.appendChild(h('p', 'wj-sub', hint));
    return s;
  }

  /* facts 四格的一格。四格是「一眼看清这部作品站在哪」的地方 ——
     进度、性质、user 位置、最后动过的时间。 */
  function fact(label, value) {
    var f = h('div', 'wj-fact');
    f.appendChild(h('small', 'wj-fact-label', label));
    f.appendChild(h('b', 'wj-fact-value', value));
    return f;
  }

  function rowLine(label, value) {
    var r = h('div', 'wj-row');
    var main = h('div', 'wj-row-main');
    main.appendChild(h('span', 'wj-row-label', label));
    r.appendChild(main);
    r.appendChild(h('em', 'wj-row-tail', value || '—'));
    return r;
  }

  function paint(ctx) {
    var id = (ctx.params && ctx.params.id) || view.id;
    view.id = id;
    var w = id ? D().get(id) : null;

    var body = ctx.body;
    body.innerHTML = '';

    if (!w) {
      ctx.setTitle('剧本详情');
      ctx.setActions([]);
      body.appendChild(h('div', 'wj-shell'));
      body.lastChild.appendChild(h('div', 'wj-empty', '这部剧本已经不在了。'));
      return;
    }

    ctx.setTitle(w.title || '剧本详情');
    var acts = [{
      label: '删除',
      kind: 'danger',
      onClick: function () {
        /* 用 ui.confirm（返回 Promise）而不是原生 confirm ——
           它是这个项目统一的弹层样式，也是唯一带 danger 语义的。 */
        Sleepy.ui.confirm({
          title: '删除《' + w.title + '》？',
          note: '这部作品的全部章节与正文会一起消失，不能恢复。' +
            '它的共读记录与审阅记录也会一起收掉（收藏馆里的票根留着）。',
          ok: '删除',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          D().remove(w.id);
          /* 附属数据跟着走（2026-09-22 衔接审计：以前只删 wjWorks，
             留下的 session / canon 成了孤儿）。票根**不动** ——
             那是「我读过」的凭证，收藏馆里点它会说「已经不在门厅里了」。 */
          if (Sleepy.wjCoread && Sleepy.wjCoread.removeForWork) {
            Sleepy.wjCoread.removeForWork(w.id);
          }
          if (Sleepy.wjCanon && Sleepy.wjCanon.remove) {
            Sleepy.wjCanon.remove(w.id);
          }
          Sleepy.toast('剧本已删除');
          Sleepy.nav.back();
        });
      }
    }];
    /* 暂停连载：取消在跑的生成 + 作品转 paused（一等状态，不是异常）。
       paused 的作品从「继续连载」回到 serializing。 */
    if (w.status === 'serializing') {
      acts.unshift({
        label: '暂停连载',
        onClick: function () {
          Sleepy.wjEngine.pauseWork(w.id);
          Sleepy.toast('已暂停，随时可以继续写');
          paint(ctx);
        }
      });
    } else if (w.status === 'paused') {
      acts.unshift({
        label: '继续连载',
        onClick: function () {
          D().mutate(w.id, function (x) { x.status = 'serializing'; return x; });
          Sleepy.toast('继续连载');
          paint(ctx);
        }
      });
    }
    ctx.setActions(acts);

    var shell = h('div', 'wj-shell wj-detail');

    /* -------- 头 -------- */
    var hero = h('div', 'wj-detail-hero');
    hero.appendChild(Sleepy.wjUI.coverEl(w, 'wj-cover-hero'));
    var copy = h('div', 'wj-detail-copy');
    copy.appendChild(h('div', 'wj-tag', Sleepy.wjUI.statusText(w)));
    copy.appendChild(h('h1', 'wj-h1', w.title));
    copy.appendChild(h('p', 'wj-sub', w.desc || '还没有写简介。这部作品想讲什么？'));
    if ((w.cast || []).length) {
      var cast = h('div', 'wj-cast');
      w.cast.forEach(function (x) {
        var role = x.role === 'lead' ? '主角' : x.role === 'support' ? '配角' : '出场';
        cast.appendChild(h('span', 'wj-cast-item', x.name + ' · ' + role));
      });
      copy.appendChild(cast);
    }
    var acts = h('div', 'wj-main-actions');
    if (w.status === 'draft') {
      acts.appendChild(btn('继续创建', 'wj-btn wj-btn-solid', function () {
        Sleepy.nav.open('wj-create', { workId: w.id, step: 0 });
      }));
    } else {
      acts.appendChild(btn('开始阅读', 'wj-btn wj-btn-solid', function () {
        /* 跳阅读页：不指定章就让它自己接已读位置（progress） */
        Sleepy.nav.open('wj-read', { id: w.id });
      }));
      acts.appendChild(btn('邀请同席', 'wj-btn', function () {
        Sleepy.nav.open('wj-coread', { workId: w.id });
      }));
      /* 谢幕（T6）：作品去向的五条路都挂在那儿。
         它是**唯一**能把作品标成「已完成」的入口 —— 在这之前，
         门厅的「已完成」那一档一直是空的。 */
      acts.appendChild(btn('谢幕', 'wj-btn', function () {
        Sleepy.nav.open('wj-curtain', { id: w.id });
      }));
    }
    copy.appendChild(acts);
    hero.appendChild(copy);
    shell.appendChild(hero);

    /* -------- facts 四格 -------- */
    var p = D().progressOf(w);
    var facts = h('div', 'wj-facts');
    facts.appendChild(fact('当前进度', (w.chapters && w.chapters.length)
      ? ('第 ' + w.chapters.length + ' 章 · ' + p.percent + '%')
      : '尚未开帷'));
    facts.appendChild(fact('作品性质', D().REALITY_LABEL[w.reality] || '—'));
    facts.appendChild(fact('user 位置', D().USER_POS_LABEL[w.userPos] || '—'));
    facts.appendChild(fact('最近修改', timeText(w.updatedAt)));
    shell.appendChild(facts);

    /* -------- tabs -------- */
    var tabs = h('div', 'wj-tabs');
    TABS.forEach(function (t) {
      var b = h('button', 'wj-tab' + (view.tab === t.id ? ' is-on' : ''), t.name);
      b.type = 'button';
      b.onclick = function () {
        view.tab = t.id;
        paint(ctx);
      };
      tabs.appendChild(b);
    });
    shell.appendChild(tabs);

    if (view.tab === 'overview') shell.appendChild(paneOverview(w));
    else if (view.tab === 'chapters') shell.appendChild(paneChapters(w, ctx));
    else if (view.tab === 'branches') shell.appendChild(paneBranches(w));
    else if (view.tab === 'check') shell.appendChild(paneCheck(w, ctx));
    else shell.appendChild(paneVersions(w));

    body.appendChild(shell);
  }

  Sleepy.register('wj-work', {
    title: '剧本详情',
    render: function (ctx) {
      /* 同 id 不同 params 复用同一个页面实例 —— 换了一部作品就必须换 tab，
         否则会带着上一部的 tab 状态串档（项目里踩过的坑）。 */
      var id = ctx.params && ctx.params.id;
      if (id && id !== view.id) view.tab = 'overview';
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

})(window);
