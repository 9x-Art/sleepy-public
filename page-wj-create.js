/* ============================================================
   page-wj-create.js — 帷境 · 开帷创建流程（五步）
   依赖：wj-data.js、core.js（岛与人物）、ui.js
   被依赖：门厅「新建故事」、剧本详情「继续创建 / 修改本篇设置」

   ★ 三条必须守住的东西：
   1. **每一步都实时落草稿**（不是最后才存）—— 中途退出再进来要能
      接着走，草稿在门厅的「未开帷草稿」里等着（总纲 §6.1）。
   2. **user 位置与取材范围是两件事**：前者决定叙事位置，后者决定
      模型能读什么（Demo 原话「这决定叙事位置，不决定记忆读取权限」）。
   3. 第 5 步的文风**不做成一排小按钮** —— 它是「进入文风设置台」的
      入口（用户 2026-09-19 拍板）。文风是一整台控制台，创建流程里
      只显示当前选中了哪一套，点了跳过去改。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var core = function () { return Sleepy.core; };
  var D = function () { return Sleepy.wj; };

  var STEPS = ['取景', '出场人物', '现实', '取材', '试读确认'];
  var CHIPS = ['克制', '旧友', '冬雨', '秘密', '开放结局', '重逢', '离别'];

  var view = { workId: null, step: 0 };

  function btn(text, cls, fn) {
    var b = h('button', cls, text);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  function patch(workId, obj) { D().mutate(workId, function (w) {
    for (var k in obj) if (obj.hasOwnProperty(k)) w[k] = obj[k];
    return w;
  }); }

  function head(title, hint, eyebrow) {
    var d = h('div', 'wj-head');
    if (eyebrow) d.appendChild(h('div', 'wj-eyebrow', eyebrow));
    d.appendChild(h('h1', 'wj-h1', title));
    if (hint) d.appendChild(h('p', 'wj-sub', hint));
    return d;
  }

  function panel(title, sub) {
    var p = h('div', 'wj-panel');
    if (title) p.appendChild(h('h2', 'wj-h2', title));
    if (sub) p.appendChild(h('p', 'wj-sub', sub));
    return p;
  }

  function esc(s) { return String(s == null ? '' : s); }

  /* ---------------------- 第 0 步 · 取景 ---------------------- */
  function stepSource(w, ctx) {
    var d = h('div', 'wj-step-body');
    d.appendChild(head('故事从哪里取景？',
      '这里决定可供选角的范围，不代表范围内所有人都会出场。', 'THE STAGE'));

    var cards = h('div', 'wj-cards');
    [['island', '孤岛', '从一座岛屿里选取 char、岛内 NPC 与既有关系。适合补完某个人的侧面与过去。'],
      ['archipelago', '群岛', '跨岛选择多个 char 与 NPC。本篇关系只在这里成立，不自动改动现实关系网。']]
      .forEach(function (x) {
        var on = (w.source || 'island') === x[0];
        var c = h('button', 'wj-select-card' + (on ? ' is-on' : ''));
        c.type = 'button';
        c.appendChild(h('span', 'wj-seal', '已选择'));
        c.appendChild(h('b', null, x[1]));
        c.appendChild(h('small', null, x[2]));
        c.onclick = function () {
          var patchObj = { source: x[0] };
          /* 切回孤岛时只留第一座，否则存档里会剩下一串不生效的岛 */
          if (x[0] === 'island') patchObj.sandboxIds = (w.sandboxIds || []).slice(0, 1);
          patch(w.id, patchObj);
          paint(ctx);
        };
        cards.appendChild(c);
      });
    d.appendChild(cards);

    var p = panel('可调用范围', '选择来源。下一步仍会逐个安排是否出场。');
    var isles = core().listSandboxes() || [];
    if (!isles.length) {
      p.appendChild(h('p', 'wj-sub', '还没有任何岛屿。先去浮岛建一座吧。'));
    } else {
      isles.forEach(function (sb) {
        var on = (w.sandboxIds || []).indexOf(sb.id) >= 0;
        var row = h('div', 'wj-scope-row');
        row.appendChild(h('div', 'wj-avatar', (sb.name || '岛').slice(0, 1)));
        var info = h('div', 'wj-scope-info');
        var chars = core().charsOfSandbox(sb.id) || [];
        /* 岛上只挂大号（core 的规矩），NPC 和皮套挂在大号名下 ——
           统计要走 universeOf，直接数 charsOfSandbox 会把 NPC 报成 0。 */
        var npcCount = 0;
        chars.forEach(function (c) {
          npcCount += Math.max(0, core().universeOf(c.id).length - 1);
        });
        info.appendChild(h('b', null, sb.name || '未命名岛'));
        info.appendChild(h('small', null,
          chars.length + ' 位 char · ' +
          npcCount + ' 位已建 NPC · ' +
          (sb.kind === 'archipelago' ? '群岛' : '孤岛')));
        row.appendChild(info);
        var sw = h('button', 'wj-switch' + (on ? ' is-on' : ''));
        sw.type = 'button';
        sw.onclick = function () {
          var cur = (w.sandboxIds || []).slice();
          var i = cur.indexOf(sb.id);
          if (i >= 0) {
            if (cur.length === 1) { Sleepy.toast('至少保留一座来源岛'); return; }
            cur.splice(i, 1);
          } else if ((w.source || 'island') === 'island') {
            cur = [sb.id];
          } else {
            cur.push(sb.id);
          }
          patch(w.id, { sandboxIds: cur });
          paint(ctx);
        };
        row.appendChild(sw);
        p.appendChild(row);
      });
    }
    d.appendChild(p);
    return d;
  }

  /* -------------------- 第 1 步 · 出场人物 -------------------- */
  function stepCast(w, ctx) {
    var d = h('div', 'wj-step-body');
    d.appendChild(head('今晚由谁登场？',
      '现实身份提供底色，本篇身份只属于这篇故事。主 char 并不强制出场。', 'CASTING'));

    var p = panel('候选人物', '点人物切换出场；出场后再点右侧标签可换位置。');
    /* 候选池 = 选中岛上的大号 + 每个大号名下的皮套与 NPC。
       岛的 charIds 里**只有大号**（core.validateSandboxChars 只收 main），
       直接拿 charsOfSandbox 当池子会把 NPC 全漏掉。 */
    var pool = [];
    (w.sandboxIds || []).forEach(function (sid) {
      (core().charsOfSandbox(sid) || []).forEach(function (main) {
        (core().universeOf(main.id) || []).forEach(function (c) {
          if (pool.some(function (x) { return x.id === c.id; })) return;
          pool.push(c);
        });
      });
    });
    if (!pool.length) {
      p.appendChild(h('p', 'wj-sub', '选中的来源里还没有人物。回到上一步换个岛，或先去浮岛建人。'));
    }
    var ROLE_NAME = { lead: '主角', support: '配角', extra: '出场' };
    var grid = h('div', 'wj-role-grid');
    pool.forEach(function (c) {
      var idx = (w.cast || []).map(function (x) { return x.charId; }).indexOf(c.id);
      var on = idx >= 0;
      var item = h('button', 'wj-actor' + (on ? ' is-on' : ''));
      item.type = 'button';
      item.appendChild(h('div', 'wj-avatar', (c.name || '？').slice(0, 1)));
      var meta = h('div', 'wj-actor-meta');
      meta.appendChild(h('b', null, c.name + ' · ' +
        ((c.kind || 'main') === 'main' ? 'char' : c.kind === 'npc' ? 'NPC' : '子角色')));
      meta.appendChild(h('small', null, on ? '已安排本篇位置' : '尚未安排本篇身份'));
      item.appendChild(meta);
      var pill = h('span', 'wj-pill', on ? ROLE_NAME[(w.cast[idx] || {}).role || 'support'] : '未出场');
      item.appendChild(pill);
      item.onclick = function () {
        var cast = (w.cast || []).slice();
        var i = cast.map(function (x) { return x.charId; }).indexOf(c.id);
        if (i >= 0) cast.splice(i, 1);
        else cast.push({
          charId: c.id, name: c.name,
          role: cast.length === 0 ? 'lead' : 'support',
          identity: '', isTemp: false
        });
        patch(w.id, { cast: cast });
        paint(ctx);
      };
      /* 点标签换位置：不冒泡，否则会顺手把这个人从名单里去掉了 */
      pill.onclick = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var cast = (w.cast || []).slice();
        var i = cast.map(function (x) { return x.charId; }).indexOf(c.id);
        if (i < 0) { Sleepy.toast('先让他出场'); return; }
        var order = ['lead', 'support', 'extra'];
        cast[i].role = order[(order.indexOf(cast[i].role || 'support') + 1) % 3];
        patch(w.id, { cast: cast });
        paint(ctx);
      };
      grid.appendChild(item);
    });
    p.appendChild(grid);
    p.appendChild(btn('新增仅用于本篇的临时 NPC', 'wj-dashed',
      function () { Sleepy.toast('临时 NPC 会在人物系统接入后开放'); }));
    d.appendChild(p);

    var p2 = panel('user 在哪里？', '这决定叙事位置，不决定记忆读取权限。');
    var pos = h('div', 'wj-seg');
    D().USER_POS.forEach(function (o) {
      var b = h('button', 'wj-seg-btn' + (w.userPos === o.id ? ' is-on' : ''), o.name);
      b.type = 'button';
      b.onclick = function () { patch(w.id, { userPos: o.id }); paint(ctx); };
      pos.appendChild(b);
    });
    p2.appendChild(pos);
    if (w.userPos === 'hidden') {
      p2.appendChild(h('p', 'wj-notice',
        '完全隐去后，系统不会把故事强行绕回 user，也不会把角色的过去写成「为了未来遇见 user」。'));
    }
    d.appendChild(p2);
    return d;
  }

  /* --------------------- 第 2 步 · 现实 --------------------- */
  function stepReality(w, ctx) {
    var d = h('div', 'wj-step-body');
    d.appendChild(head('这场故事离现实多远？',
      '先决定作品性质，再决定时间落点。成为「正史候选」也不等于自动写入正史。', 'REALITY'));

    var cards = h('div', 'wj-cards');
    D().REALITY.forEach(function (r) {
      var on = w.reality === r.id;
      var c = h('button', 'wj-select-card' + (on ? ' is-on' : '') +
        (r.tone === 'wine' ? ' is-wine' : ''));
      c.type = 'button';
      c.appendChild(h('span', 'wj-seal', '已选择'));
      c.appendChild(h('b', null, r.name));
      c.appendChild(h('small', null, r.hint));
      c.onclick = function () { patch(w.id, { reality: r.id }); paint(ctx); };
      cards.appendChild(c);
    });
    d.appendChild(cards);

    /* 平行世界不取现实时间线，所以那一档下时间落点整块收起来
       （用户 2026-09-19：「平行时间线其实就是平行世界」——
       时间落点里不再单列这一档，它由作品性质决定）。 */
    var p = panel('时间落点');
    if (w.reality === 'parallel') {
      p.appendChild(h('p', 'wj-sub', '平行世界不与既有时间线对齐，因此不需要选落点。'));
    } else {
      p.appendChild(h('p', 'wj-sub', '正式版会根据角色时间线动态提供可用空白。'));
      var tl = h('div', 'wj-timeline');
      D().TIME_ANCHOR.forEach(function (t) {
        var b = h('button', 'wj-tl-btn' + (w.timeAnchor === t.id ? ' is-on' : ''));
        b.type = 'button';
        b.appendChild(h('b', null, t.name));
        b.appendChild(h('span', null, t.hint));
        b.onclick = function () { patch(w.id, { timeAnchor: t.id }); paint(ctx); };
        tl.appendChild(b);
      });
      p.appendChild(tl);
    }
    d.appendChild(p);
    return d;
  }

  /* --------------------- 第 3 步 · 取材 --------------------- */
  function stepMaterial(w, ctx) {
    var d = h('div', 'wj-step-body');
    d.appendChild(head('允许故事知道多少？',
      '这里只设置创作取材。读取资料，不等于角色知情，也不等于写回记忆。', 'MATERIAL'));

    var p = panel('记忆取材');
    D().MATERIAL.forEach(function (m) {
      var on = w.materialScope === m.id;
      var row = h('button', 'wj-perm' + (on ? ' is-on' : ''));
      row.type = 'button';
      row.appendChild(h('span', 'wj-radio'));
      var body = h('span', 'wj-perm-body');
      body.appendChild(h('b', null, m.name));
      body.appendChild(h('span', null, m.hint));
      row.appendChild(body);
      row.onclick = function () {
        patch(w.id, { materialScope: m.id, materialRefs: [] });
        paint(ctx);
      };
      p.appendChild(row);
    });
    if (w.materialScope === 'select') {
      p.appendChild(h('p', 'wj-notice',
        '逐条勾选留痕与时间线事实的选择器会在取材系统接入后出现在这里。' +
        '在那之前，「选择性读取」按「只读关系与性格底色」执行。'));
    }
    var castNames = (w.cast || []).map(function (x) { return x.name; }).join('、') || '出场人物';
    p.appendChild(h('p', 'wj-notice', '当前固定边界：' + castNames + '均不知情；作品保持未定；' +
      (w.reality === 'canon_candidate'
        ? '谢幕后仍需逐条审阅才可能写入正史。'
        : '不会写入正史。')));
    d.appendChild(p);

    var p2 = panel('你想看什么？', '一句话就能开场，其余空白由文风与人物逻辑补全。');
    var ta = h('textarea', 'wj-textarea');
    ta.placeholder = '例如：想看他在认识我以前，在北港度过的最后一个冬天。';
    ta.value = w.wish || '';
    ta.oninput = function () { patch(w.id, { wish: ta.value }); };
    p2.appendChild(ta);

    var chips = h('div', 'wj-chips');
    var tags = (w.tags || []).slice();
    CHIPS.forEach(function (t) {
      var on = tags.indexOf(t) >= 0;
      var b = h('button', 'wj-chip' + (on ? ' is-on' : ''), t);
      b.type = 'button';
      b.onclick = function () {
        var i = tags.indexOf(t);
        if (i >= 0) tags.splice(i, 1); else tags.push(t);
        patch(w.id, { tags: tags });
        paint(ctx);
      };
      chips.appendChild(b);
    });
    p2.appendChild(chips);
    d.appendChild(p2);

    var p3 = panel('视角与篇幅');
    p3.appendChild(segRow('叙述视角', D().POV, w.pov, function (v) {
      patch(w.id, { pov: v }); paint(ctx);
    }));
    p3.appendChild(segRow('篇幅', D().LENGTH, w.length, function (v) {
      patch(w.id, { length: v }); paint(ctx);
    }));
    d.appendChild(p3);
    return d;
  }

  function segRow(label, options, cur, onPick) {
    var wrap = h('div', 'wj-field');
    wrap.appendChild(h('label', 'wj-field-label', label));
    var seg = h('div', 'wj-seg');
    options.forEach(function (o) {
      var b = h('button', 'wj-seg-btn' + (cur === o ? ' is-on' : ''), o);
      b.type = 'button';
      b.onclick = function () { onPick(o); };
      seg.appendChild(b);
    });
    wrap.appendChild(seg);
    return wrap;
  }

  /* ------------------ 第 4 步 · 试读 + 确认 ------------------ */
  function stepReview(w, ctx) {
    var d = h('div', 'wj-step-body');
    d.appendChild(head('让文字先试读一小段。',
      '文风不是题材贴纸。切换底座，直接比较叙述距离、节奏与情绪落点。', 'REHEARSAL'));

    /* ★ 文风 = 一个入口，不是一排小按钮（用户拍板） */
    var st = D().styleOf(w);
    var p = panel('本篇文风');
    var entry = h('button', 'wj-style-entry');
    entry.type = 'button';
    var et = h('div', 'wj-style-entry-main');
    et.appendChild(h('b', null, st.name));
    et.appendChild(h('small', null, st.desc || '已按你的滑杆改过'));
    entry.appendChild(et);
    entry.appendChild(h('span', 'wj-style-entry-go', '去文风设置 ›'));
    entry.onclick = function () {
      Sleepy.nav.open('wj-style', { workId: w.id });
    };
    p.appendChild(entry);
    p.appendChild(h('p', 'wj-sub',
      '叙述距离 ' + st.params.distance + ' · 语言密度 ' + st.params.density +
      ' · 叙事节奏 ' + st.params.pace + ' · 对话占比 ' + st.params.dialogue));
    d.appendChild(p);

    /* 试读纸：纸本视觉是产品语言的一部分，所以在；但里面**不放假正文**
       —— 试读片段要模型生成（文风引擎接入后），现在如实说明。 */
    var paper = h('div', 'wj-paper');
    paper.appendChild(h('div', 'wj-paper-kicker', '试读片段'));
    paper.appendChild(h('p', 'wj-paper-note',
      '试读片段会在文风引擎接入后出现在这张纸上。它只用于比较文风，' +
      '不会进入正文，也不能邀请同席。'));
    var meta = h('div', 'wj-paper-foot');
    meta.appendChild(h('span', null, st.name));
    meta.appendChild(h('span', null, '不保存为正文'));
    paper.appendChild(meta);
    d.appendChild(paper);

    /* 开帷前的确认单 */
    var sum = h('div', 'wj-summary');
    var sh = h('div', 'wj-summary-head');
    sh.appendChild(h('small', null, 'READY TO OPEN'));
    sh.appendChild(h('h2', null, w.title || '未命名剧本'));
    sh.appendChild(h('p', null, (w.desc || '一段尚未被现实认领的可能。')));
    sum.appendChild(sh);

    var rows = h('div', 'wj-summary-list');
    var islandNames = (w.sandboxIds || []).map(function (id) {
      var sb = (core().listSandboxes() || []).filter(function (x) { return x.id === id; })[0];
      return sb ? sb.name : '未命名岛';
    });
    rows.appendChild(sumRow('取材世界', islandNames.join(' + ') || '尚未选择'));
    rows.appendChild(sumRow('出场', (w.cast || []).length
      ? (w.cast || []).map(function (x) { return x.name; }).join(' · ') : '尚未选择'));
    rows.appendChild(sumRow('user 位置', D().USER_POS_LABEL[w.userPos] || '—'));
    rows.appendChild(sumRow('作品性质', (D().REALITY_LABEL[w.reality] || '') +
      (w.reality === 'parallel' ? '' : ' · ' + (D().TIME_ANCHOR_LABEL[w.timeAnchor] || ''))));
    rows.appendChild(sumRow('取材范围', D().MATERIAL_LABEL[w.materialScope] || '—'));
    rows.appendChild(sumRow('文风', st.name + ' · ' + w.pov + ' · ' + w.length));
    sum.appendChild(rows);
    sum.appendChild(h('div', 'wj-seal-line',
      w.reality === 'canon_candidate'
        ? '未定故事 · 角色不知情 · 审阅后才可能写入'
        : '未定故事 · 角色不知情 · 不自动写回'));
    d.appendChild(sum);

    var acts = h('div', 'wj-summary-actions');
    acts.appendChild(btn('确认开帷', 'wj-open-curtain', function () {
      if (!(w.cast || []).length) {
        Sleepy.toast('至少选择一位出场人物');
        view.step = 1;
        paint(ctx);
        return;
      }
      if (!(w.sandboxIds || []).length) {
        Sleepy.toast('至少选择一座来源岛');
        view.step = 0;
        paint(ctx);
        return;
      }
      patch(w.id, { status: 'serializing' });
      Sleepy.toast('开帷参数已确认');
      Sleepy.nav.open('wj-work', { id: w.id });
    }));
    acts.appendChild(btn('返回修改选角与边界', 'wj-quiet', function () {
      view.step = 1;
      paint(ctx);
    }));
    d.appendChild(acts);
    return d;
  }

  function sumRow(label, value) {
    var r = h('div', 'wj-sum-row');
    r.appendChild(h('span', null, label));
    r.appendChild(h('span', null, value));
    return r;
  }

  /* ---------------------------- 主绘制 ---------------------------- */
  function paint(ctx) {
    var w = view.workId ? D().get(view.workId) : null;
    if (!w) {
      ctx.body.innerHTML = '';
      ctx.body.appendChild(h('div', 'wj-empty', '这份草稿已经不在门厅里了。'));
      return;
    }
    ctx.setTitle('开帷');
    ctx.setActions([{ label: '存为未开帷', onClick: function () {
      patch(w.id, { status: 'draft' });
      Sleepy.toast('已保存为未开帷草稿');
      Sleepy.nav.open('wj-foyer', {});
    } }]);

    var body = ctx.body;
    body.innerHTML = '';

    var shell = h('div', 'wj-shell wj-create');

    /* 进度条 */
    var prog = h('div', 'wj-progress');
    STEPS.forEach(function (name, i) {
      prog.appendChild(h('i', i < view.step ? 'is-done' : (i === view.step ? 'is-on' : '')));
    });
    prog.appendChild(h('span', 'wj-progress-text',
      String(view.step + 1).padStart(2, '0') + ' / 0' + STEPS.length));
    shell.appendChild(prog);

    /* 当前这一步 */
    if (view.step === 0) shell.appendChild(stepSource(w, ctx));
    else if (view.step === 1) shell.appendChild(stepCast(w, ctx));
    else if (view.step === 2) shell.appendChild(stepReality(w, ctx));
    else if (view.step === 3) shell.appendChild(stepMaterial(w, ctx));
    else shell.appendChild(stepReview(w, ctx));

    /* 底部导航 */
    if (view.step < 4) {
      var nav = h('div', 'wj-nav');
      if (view.step > 0) {
        nav.appendChild(btn('上一步', 'wj-quiet', function () {
          view.step = Math.max(0, view.step - 1);
          paint(ctx);
          body.scrollTop = 0;
        }));
      }
      nav.appendChild(btn(NEXT_LABEL[view.step], 'wj-next', function () {
        if (view.step === 1 && !(w.cast || []).length) {
          Sleepy.toast('至少选择一位出场人物');
          return;
        }
        view.step = Math.min(4, view.step + 1);
        paint(ctx);
        body.scrollTop = 0;
      }));
      shell.appendChild(nav);
    }

    body.appendChild(shell);
  }

  var NEXT_LABEL = ['下一步 · 安排出场人物', '下一步 · 确认现实边界',
    '下一步 · 设置取材', '下一步 · 文风与试读'];

  Sleepy.register('wj-create', {
    title: '开帷',
    render: function (ctx) {
      var p = ctx.params || {};
      if (p.workId) {
        view.workId = p.workId;
        /* 从详情页「修改本篇设置」进来时从头看；从文风页返回不动步子 */
        if (p.step != null) view.step = Number(p.step) || 0;
      } else {
        /* 新建：立刻落一份草稿。**不等最后一步才存** ——
           用户中途退出去看别的，回来还得能接着走。 */
        var w = D().createDraft({});
        view.workId = w.id;
        view.step = 0;
      }
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) {
      /* 从文风设置台返回：文风已经改过了，重画一次把新的名字带回来 */
      if (ctx.__paint) ctx.__paint();
    }
  });

})(window);
