/* ============================================================
   page-wj-coread.js — 帷境 · 同席共读（T5）：邀请 / 等待 / 台账
   依赖：wj-data.js、wj-coread.js、page-wj-foyer.js（wjUI）、ui.js
   被依赖：page-wj-work.js 的「邀请同席」

   三个视图（照 Demo #4）：
     setup   邀请票 —— 选人物 / 开放范围 / 陪读方式 / 边界说明；
     waiting 四回应 —— accept / later / share / refuse，
               只有 accept 才出现「进入同席」；
     ledger  结束台账 —— real 共读事件 vs story 剧本内容两张卡并置，
               结束只产出一条「共同读过」的现实候选。

   阅读现场不在本页 —— 会话态挂在剧本阅读页上（同一份月光纸本）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var wj = function () { return Sleepy.wj; };
  var CR = function () { return Sleepy.wjCoread; };

  var view = { workId: null, sessionId: null, phase: 'setup' };

  function btn(text, cls, fn) {
    var b = h('button', cls, text);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  var ACTION_LABEL = {
    invite_accept: '接受了邀请', invite_later: '想稍后再读',
    invite_share: '只收下了作品', invite_refuse: '婉拒了',
    annotate: '写了批注', react: '说了想法', stay_silent: '沉默了一会儿',
    discuss: '标了重要节点'
  };

  function timeText(iso) {
    if (!iso) return '—';
    var t = new Date(iso);
    if (isNaN(t.getTime())) return '—';
    var hh = String(t.getHours()).padStart(2, '0');
    var mm = String(t.getMinutes()).padStart(2, '0');
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 ' + hh + ':' + mm;
  }

  /* setup 时可选的起始锚点（按开放范围） */
  function firstAnchorOf(w, chapterId) {
    var chs = (w.chapters || []).filter(function (c) { return c.status === 'ready'; });
    var ch = chapterId
      ? chs.filter(function (c) { return c.id === chapterId; })[0] || chs[0]
      : chs[0];
    if (!ch) return null;
    var paras = (ch.paras || []).filter(function (p) { return p.kind !== 'scene_break'; });
    return paras.length ? paras[0].id : null;
  }

  var pick = { charIdx: 0, scope: 'start', mode: 'quiet', chapterId: null };

  /* ------------------------------ setup ------------------------------ */
  function paneSetup(ctx, w) {
    var box = h('div', 'wj-shell wjk');
    var active = CR().activeFor(w.id);

    /* 同席进行中 → 先给回去的路 */
    if (active) {
      var going = h('div', 'wjk-going');
      going.appendChild(h('div', 'wj-eyebrow', 'READING TOGETHER'));
      going.appendChild(h('h2', 'wj-h2',
        (active.charName || 'TA') + ' 正在同席（' + timeText(active.startedAt) + '）'));
      going.appendChild(h('p', 'wj-sub', '会话还开着，随时可以回去接着一起读。'));
      var ga = h('div', 'wjk-going-actions');
      ga.appendChild(btn('回到同席现场', 'wj-btn wj-btn-solid', function () {
        Sleepy.nav.open('wj-read', { id: w.id, session: active.id });
      }));
      if (active.status === 'active') {
        ga.appendChild(btn('暂停讨论', 'wj-btn', function () {
          CR().pause(active.id);
          Sleepy.toast('已暂停');
          paint(ctx);
        }));
      } else {
        ga.appendChild(btn('继续讨论', 'wj-btn', function () {
          CR().resume(active.id);
          Sleepy.toast('继续同席');
          paint(ctx);
        }));
      }
      ga.appendChild(btn('结束同席', 'wj-quiet', function () {
        CR().end(active.id);
        Sleepy.toast('同席已结束，去台账看看');
        paint(ctx);
      }));
      going.appendChild(ga);
      box.appendChild(going);
    }

    var head = h('div', 'wj-head');
    head.appendChild(h('div', 'wj-eyebrow', 'INVITATION'));
    head.appendChild(h('h1', 'wj-h1', '邀请谁同席？'));
    head.appendChild(h('p', 'wj-sub',
      '同席 = 邀请 TA 一起读这部剧本。剧本不是现实；接受邀请也不会让它成为事实。'));
    box.appendChild(head);

    var hasText = (w.chapters || []).some(function (c) {
      return c.status === 'ready' && (c.paras || []).some(function (p) {
        return p.kind !== 'scene_break';
      });
    });

    /* 人物（出场名单里选） */
    var p1 = h('div', 'wj-panel');
    p1.appendChild(h('h2', 'wj-h2', '同席的人'));
    var chips = h('div', 'wjk-chips');
    (w.cast || []).forEach(function (c, i) {
      var b = h('button', 'wj-chip' + (i === pick.charIdx ? ' is-on' : ''), c.name);
      b.type = 'button';
      b.onclick = function () { pick.charIdx = i; paint(ctx); };
      chips.appendChild(b);
    });
    if (!(w.cast || []).length) {
      p1.appendChild(h('p', 'wj-sub', '这部剧本还没有出场人物。'));
    }
    p1.appendChild(chips);
    box.appendChild(p1);

    /* 开放范围 */
    var p2 = h('div', 'wj-panel');
    p2.appendChild(h('h2', 'wj-h2', '开放范围'));
    p2.appendChild(h('p', 'wj-sub', 'TA 只能读你开放的部分。'));
    var scopeSeg = h('div', 'wj-seg');
    CR().SCOPES.forEach(function (sc) {
      var on = pick.scope === sc.id;
      var b = h('button', 'wj-seg-btn' + (on ? ' is-on' : ''), sc.name);
      b.type = 'button';
      b.onclick = function () { pick.scope = sc.id; paint(ctx); };
      scopeSeg.appendChild(b);
    });
    p2.appendChild(scopeSeg);
    if (pick.scope === 'chapter') {
      var chChips = h('div', 'wjk-chips');
      (w.chapters || []).filter(function (c) { return c.status === 'ready'; })
        .forEach(function (c) {
          var on = pick.chapterId === c.id;
          var b = h('button', 'wj-chip' + (on ? ' is-on' : ''), c.title);
          b.type = 'button';
          b.onclick = function () { pick.chapterId = c.id; paint(ctx); };
          chChips.appendChild(b);
        });
      p2.appendChild(chChips);
    }
    box.appendChild(p2);

    /* 陪读方式 */
    var p3 = h('div', 'wj-panel');
    p3.appendChild(h('h2', 'wj-h2', '陪读方式'));
    p3.appendChild(h('p', 'wj-sub', '方式真的会改变行为：安静陪读时 TA 不会主动开口。'));
    CR().MODES.forEach(function (m) {
      var on = pick.mode === m.id;
      var row = h('button', 'wj-perm' + (on ? ' is-on' : ''));
      row.type = 'button';
      row.appendChild(h('span', 'wj-radio'));
      var body = h('span', 'wj-perm-body');
      body.appendChild(h('b', null, m.name));
      body.appendChild(h('span', null, m.hint));
      row.appendChild(body);
      row.onclick = function () { pick.mode = m.id; paint(ctx); };
      p3.appendChild(row);
    });
    box.appendChild(p3);

    /* 边界：对方将获得的权限 */
    var p4 = h('div', 'wj-panel');
    p4.appendChild(h('h2', 'wj-h2', 'TA 将获得什么？'));
    var perms = h('div', 'wjk-perms');
    [
      ['能读到', '你开放的章节与段落（只此范围，不多一页）'],
      ['能留下', 'TA 的反应与批注只进共读记录，不进剧情，也不进 TA 的记忆'],
      ['结束时', '只产出一条「共同读过」的现实候选 —— 要你确认才生效'],
      ['不会', '剧本内容不会成为 TA 的经历；共读事件是真的，故事仍是假的']
    ].forEach(function (x) {
      var r = h('div', 'wjk-perm-row');
      r.appendChild(h('b', null, x[0]));
      r.appendChild(h('span', null, x[1]));
      perms.appendChild(r);
    });
    p4.appendChild(perms);
    box.appendChild(p4);

    var acts = h('div', 'wjk-actions');
    var cast = (w.cast || []);
    var go = btn('发出邀请', 'wj-btn wj-btn-solid wjk-go', function () {
      if (!cast.length) { Sleepy.toast('先在开帷流程里安排出场人物'); return; }
      if (!hasText) { Sleepy.toast('还没有可读的正文，先写下第一章'); return; }
      var c = cast[Math.min(pick.charIdx, cast.length - 1)];
      var anchor = firstAnchorOf(w, pick.scope === 'chapter' ? pick.chapterId : null);
      if (pick.scope === 'current' && w.progress && w.progress.anchorId) {
        anchor = w.progress.anchorId;
      }
      var s = CR().createInvite({
        workId: w.id, charId: c.charId, charName: c.name,
        mode: pick.mode, scope: pick.scope, startAnchorId: anchor
      });
      view.sessionId = s.id;
      view.phase = 'waiting';
      Sleepy.toast('邀请已发出，等 TA 回应……');
      CR().judgeInvite(w.id, CR().get(s.id))
        .then(function (r) {
          CR().settle(s.id, r.action, r.note);
          paint(ctx);
        })
        ['catch'](function (e) {
          Sleepy.toast(e.message || '回应判断失败');
          paint(ctx);
        });
    });
    if (!hasText) go.disabled = true;
    acts.appendChild(go);
    acts.appendChild(btn('先不邀请', 'wj-quiet', function () { Sleepy.nav.back(); }));
    box.appendChild(acts);
    return box;
  }

  /* ----------------------------- waiting ----------------------------- */
  function paneWaiting(ctx, w, s) {
    var box = h('div', 'wj-shell wjk');
    var st = s.status;
    var label = st === 'invited' ? '还没有回应……'
      : (CR().ACTIONS[st === 'active' ? 'accept' : st === 'deferred' ? 'later'
        : st === 'sharing_only' ? 'share' : 'refuse'].label);
    var head = h('div', 'wj-head');
    head.appendChild(h('div', 'wj-eyebrow', 'RESPONSE'));
    head.appendChild(h('h1', 'wj-h1', (s.charName || 'TA') + ' ' + label));
    if (s.responseNote) head.appendChild(h('p', 'wjk-note', '「' + s.responseNote + '」'));
    box.appendChild(head);

    var card = h('div', 'wj-panel');
    card.appendChild(h('p', 'wj-sub', '《' + (w.title || '') + '》 · ' +
      (CR().SCOPES.filter(function (x) { return x.id === s.scope; })[0] || {}).name +
      ' · ' + (CR().MODES.filter(function (x) { return x.id === s.mode; })[0] || {}).name));
    box.appendChild(card);

    var acts = h('div', 'wjk-actions');
    if (st === 'active') {
      acts.appendChild(btn('进入同席', 'wj-btn wj-btn-solid wjk-go', function () {
        Sleepy.nav.open('wj-read', { id: w.id, session: s.id });
      }));
      acts.appendChild(h('p', 'wj-sub', '阅读现场就在剧本阅读页 —— 同一份月光纸本。'));
    } else {
      acts.appendChild(h('p', 'wj-sub',
        st === 'deferred' ? 'TA 想稍后再读。改天再邀请一次就好，草稿与邀请都会留着。'
        : st === 'sharing_only' ? 'TA 只收下了作品，没有建立共读。'
        : '没关系，作品还在门厅里。'));
      acts.appendChild(btn('返回', 'wj-btn', function () {
        view.phase = 'setup';
        paint(ctx);
      }));
    }
    box.appendChild(acts);
    return box;
  }

  /* ------------------------------ ledger ------------------------------ */
  function paneLedger(ctx, w, s) {
    var box = h('div', 'wj-shell wjk');
    var head = h('div', 'wj-head');
    head.appendChild(h('div', 'wj-eyebrow', 'AFTER READING'));
    head.appendChild(h('h1', 'wj-h1', '同席台账'));
    head.appendChild(h('p', 'wj-sub',
      (s.charName || 'TA') + ' · ' + timeText(s.startedAt) + ' — ' + timeText(s.endedAt)));
    box.appendChild(head);

    /* —— 两张并置的卡：real vs story（这个产品的灵魂 UI，别合并） —— */
    var ledger = h('div', 'wjk-ledger');
    var real = h('div', 'wjk-ledger-card is-real');
    real.appendChild(h('small', 'wjk-ledger-tag', 'REAL · 共读事件（可以成为现实）'));
    var realLines = h('div', 'wjk-ledger-body');
    realLines.appendChild(h('p', null, '谁邀请：user'));
    realLines.appendChild(h('p', null, '和谁：' + (s.charName || '对方')));
    realLines.appendChild(h('p', null, '读到哪：' + (s.endAnchorId || s.startAnchorId || '—')));
    realLines.appendChild(h('p', null, '何时离席：' + timeText(s.endedAt)));
    var reacts = (s.transcript || []).filter(function (t) {
      return t.action === 'react' || t.action === 'annotate' || t.action === 'stay_silent';
    });
    realLines.appendChild(h('p', null, '说了什么：' +
      (reacts.length ? reacts.length + ' 条反应与批注' : '一路安静地读完了')));
    real.appendChild(realLines);
    ledger.appendChild(real);

    var story = h('div', 'wjk-ledger-card is-story');
    story.appendChild(h('small', 'wjk-ledger-tag', 'STORY · 剧本内容（不会成为现实）'));
    story.appendChild(h('div', 'wjk-ledger-body', [
      h('p', null, '《' + (w.title || '') + '》的正文与剧情'),
      h('p', null, 'TA 读过的段落不等于 TA 的经历'),
      h('p', null, '批注与反应是「读后感」，不是「亲历」')
    ]));
    ledger.appendChild(story);
    box.appendChild(ledger);

    /* —— 过程记录 —— */
    var tl = h('div', 'wj-panel');
    tl.appendChild(h('h2', 'wj-h2', '过程记录'));
    var list = h('div', 'wjk-timeline');
    (s.transcript || []).forEach(function (t) {
      var r = h('div', 'wjk-tl-row');
      r.appendChild(h('small', 'wjk-tl-time', timeText(t.at)));
      var main = h('div', 'wjk-tl-main');
      main.appendChild(h('b', null, ACTION_LABEL[t.action] || t.action));
      if (t.anchorId) main.appendChild(h('span', 'wjk-tl-anchor', '挂靠 ' + t.anchorId));
      if (t.text) main.appendChild(h('p', 'wjk-tl-text', t.text));
      r.appendChild(main);
      list.appendChild(r);
    });
    if (!(s.transcript || []).length) list.appendChild(h('p', 'wj-sub', '一路安静。'));
    tl.appendChild(list);
    box.appendChild(tl);

    /* —— 唯一的现实候选 —— */
    var cand = CR().candidateFor(s.id);
    var pCand = h('div', 'wj-panel');
    pCand.appendChild(h('h2', 'wj-h2', '现实候选（仅此一条）'));
    pCand.appendChild(h('p', 'wj-sub',
      '共读事件可以成为现实；剧本内容永远留在纸上。'));
    if (cand) {
      pCand.appendChild(h('div', 'wjk-candidate', cand.content));
      if (!s.memorySaved) {
        pCand.appendChild(btn('存入留痕（待确认）', 'wj-btn wj-btn-solid', function () {
          Sleepy.memoryStore.writeMemoryItems(cand.charId, [{
            kind: 'custom', content: cand.content,
            source: 'wj_coread', sourceRef: cand.sourceRef, status: 'pending'
          }]);
          CR().markMemorySaved(s.id);
          Sleepy.toast('已存入留痕候选，等你在记忆里确认');
          paint(ctx);
        }));
      } else {
        pCand.appendChild(h('p', 'wj-notice is-ok', '已存入留痕候选，待确认。'));
      }
    }
    box.appendChild(pCand);

    var acts = h('div', 'wjk-actions');
    acts.appendChild(btn('返回', 'wj-btn', function () {
      view.phase = 'setup';
      view.sessionId = null;
      paint(ctx);
    }));
    box.appendChild(acts);
    return box;
  }

  /* ------------------------------ 主绘制 ------------------------------ */
  function paint(ctx) {
    var w = view.workId ? wj().get(view.workId) : null;
    var body = ctx.body;
    body.innerHTML = '';
    if (!w) {
      ctx.setTitle('同席共读');
      ctx.setActions([]);
      body.appendChild(h('div', 'wj-empty', '这部剧本已经不在门厅里了。'));
      return;
    }
    ctx.setTitle('同席共读');
    ctx.setActions([]);

    var s = view.sessionId ? CR().get(view.sessionId) : null;
    if (s && s.status === 'ended') view.phase = 'ledger';
    else if (s && s.status !== 'invited') view.phase = 'waiting';
    else if (s && s.status === 'invited') view.phase = 'waiting';
    else view.phase = 'setup';

    if (view.phase === 'setup') body.appendChild(paneSetup(ctx, w));
    else if (view.phase === 'ledger') body.appendChild(paneLedger(ctx, w, s));
    else body.appendChild(paneWaiting(ctx, w, s));
  }

  Sleepy.register('wj-coread', {
    title: '同席共读',
    render: function (ctx) {
      var p = ctx.params || {};
      view.workId = p.workId || view.workId;
      view.sessionId = p.session || null;
      view.phase = p.session ? 'waiting' : 'setup';
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) {
      /* 数据版本没变就不整页重画（手感批 2026-10-29，见 page-wj-foyer.wjUI.freshPaint） */
      if (Sleepy.wjUI && Sleepy.wjUI.freshPaint) Sleepy.wjUI.freshPaint(ctx);
      else if (ctx.__paint) ctx.__paint();
    }
  });

})(window);
