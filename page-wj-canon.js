/* ============================================================
   page-wj-canon.js — 帷境 · 正史审阅台（T7）
   依赖：wj-data.js、wj-canon.js、page-wj-foyer.js（wjUI）、ui.js
   被依赖：page-wj-curtain.js 的「进入正史审阅」那一张卡

   四步（Demo #7）：候选事实 → 冲突确认 → 人物认知 → 最终写入。
   页面上只做三件事：显示、让人点、把闸门的结果如实说出来。
   判断全在 wj-canon.js 里（那层是纯数据 + 硬闸门，冒烟直接测）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var wj = function () { return Sleepy.wj; };
  var CAN = function () { return Sleepy.wjCanon; };

  var view = { workId: null };

  function btn(text, cls, fn) {
    var b = h('button', cls || 'wj-btn', text);
    b.type = 'button';
    if (fn) b.onclick = fn;
    return b;
  }

  function kindName(id) {
    var hit = CAN().KINDS.filter(function (k) { return k.id === id; })[0];
    return hit ? hit.name : id;
  }

  /* 闸门必须**实时**算：页面上的 rec 是 paint 那一刻的快照（store.get 是
     深拷贝），认知页改完档位不重画的话，快照永远是旧的 —— 表现就是
     「明明都选了，底部还说一个人都没定」。 */
  function liveRec(rec) { return CAN().get(rec.workId) || rec; }

  /* 只刷新闸门那两处（按钮 + 提示），不重画整页 ——
     认知页通常要连着改好几个人，重画会把滚动位置抖回顶部。 */
  function refreshGate(rec) {
    var why = CAN().blockers(liveRec(rec));
    var pg = document.querySelector('.page[data-page="wj-canon"]');
    if (!pg) return;
    var next = pg.querySelector('.wjc-next');
    if (next) next.disabled = why.length > 0;
    var note = pg.querySelector('.wjc-blocked');
    if (note) note.textContent = why.length ? ('还差：' + why.join('；')) : '';
  }

  /* --------------------------- 步进条 --------------------------- */
  function stepsBar(ctx, rec) {
    var box = h('div', 'wjc-steps');
    CAN().STEPS.forEach(function (s) {
      var on = rec.step === s.id;
      var done = rec.step > s.id;
      var b = h('button', 'wjc-step' + (on ? ' is-on' : '') + (done ? ' is-done' : ''),
        (s.id + 1) + ' ' + s.name);
      b.type = 'button';
      b.onclick = function () {
        if (s.id <= rec.step) { CAN().setStep(rec.workId, s.id); paint(ctx); return; }
        /* 往前走必须过闸门 —— 原因照实说，别只弹一句「不能」 */
        var why = CAN().blockers(liveRec(rec));
        if (why.length) { Sleepy.toast(why[0]); return; }
        CAN().setStep(rec.workId, s.id);
        paint(ctx);
      };
      box.appendChild(b);
    });
    return box;
  }

  /* 下一步 / 上一步 —— 两个 pane 共用 */
  function navRow(ctx, rec, extra) {
    var row = h('div', 'wjc-nav');
    if (rec.step > 0) {
      row.appendChild(btn('上一步', 'wj-btn', function () {
        CAN().setStep(rec.workId, rec.step - 1);
        paint(ctx);
      }));
    }
    (extra || []).forEach(function (x) { row.appendChild(x); });
    if (rec.step < 3) {
      var next = btn('下一步 · ' + CAN().STEPS[rec.step + 1].name,
        'wj-btn wj-btn-solid wjc-next', function () {
          var r = CAN().advance(rec.workId);
          if (!r.ok) { Sleepy.toast((r.why || [])[0] || '还不能往下走'); return; }
          paint(ctx);
        });
      var why = CAN().blockers(liveRec(rec));
      if (why.length) next.disabled = true;
      row.appendChild(next);
      /* 提示节点**总是**渲染（空文本什么都不显示）—— 认知页改完档位要
         就地更新它，节点不存在就没法更新。 */
      row.appendChild(h('p', 'wjc-blocked', why.length ? ('还差：' + why.join('；')) : ''));
    }
    return row;
  }

  /* --------------------------- ① 候选 --------------------------- */
  function paneCandidates(ctx, w, rec) {
    var box = h('div', 'wj-panel');
    box.appendChild(h('h2', 'wj-h2', '候选事实'));
    box.appendChild(h('p', 'wj-sub',
      '从正文里挑出来的、可能成为现实的东西。逐条决定：写入 / 暂缓 / 不写。' +
      '默认是暂缓 —— 不点就不会写。'));

    if (!rec.candidates.length) {
      box.appendChild(h('div', 'wj-empty',
        '还没有候选。点下面那颗按钮，让模型把这部作品里像事实的部分挑一遍。'));
      var go = btn('提取候选事实', 'wj-btn wj-btn-solid', function () {
        go.disabled = true;
        go.textContent = '正在读这部作品……';
        CAN().extract(w.id)
          .then(function (list) {
            Sleepy.toast(list.length ? ('挑出 ' + list.length + ' 条候选') : '没有可提取的候选，这也是正常结果');
            paint(ctx);
          })
          ['catch'](function (e) {
            Sleepy.toast(e.message || '提取失败');
            paint(ctx);
          });
      });
      box.appendChild(go);
      return box;
    }

    var list = h('div', 'wjc-list');
    rec.candidates.forEach(function (c) {
      var card = h('div', 'wjc-cand' + (c.decision === 'keep' ? ' is-keep'
        : c.decision === 'reject' ? ' is-reject' : ''));
      var head = h('div', 'wjc-cand-head');
      head.appendChild(h('span', 'wjc-cand-kind', kindName(c.kind)));
      head.appendChild(h('span', 'wjc-cand-seq', '#' + c.seq));
      if (c.conflict) head.appendChild(h('span', 'wjc-cand-warn', '有冲突'));
      card.appendChild(head);
      card.appendChild(h('p', 'wjc-cand-text', c.text));
      if (c.note) card.appendChild(h('p', 'wjc-cand-note', c.note));
      if (c.date) card.appendChild(h('p', 'wjc-cand-date', '日期：' + c.date));

      var dec = h('div', 'wjc-cand-decs');
      CAN().DECISIONS.forEach(function (d) {
        var on = c.decision === d.id;
        var b = h('button', 'wjc-dec' + (on ? ' is-on' : ''), d.name);
        b.type = 'button';
        b.title = d.hint;
        b.onclick = function () {
          CAN().decide(w.id, c.id, d.id);
          paint(ctx);
        };
        dec.appendChild(b);
      });
      card.appendChild(dec);
      list.appendChild(card);
    });
    box.appendChild(list);

    box.appendChild(btn('重新提取（会覆盖现在的候选与决定）', 'wj-quiet', function () {
      CAN().extract(w.id)
        .then(function () { Sleepy.toast('重新提取好了'); paint(ctx); })
        ['catch'](function (e) { Sleepy.toast(e.message || '提取失败'); });
    }));
    return box;
  }

  /* --------------------------- ② 冲突 --------------------------- */
  function paneConflict(ctx, w, rec) {
    var box = h('div', 'wj-panel');
    box.appendChild(h('h2', 'wj-h2', '冲突确认'));
    box.appendChild(h('p', 'wj-sub',
      '模型只负责报告哪里对不上；怎么处理是你的事。' +
      '写一句处理方式就算处理过了 —— 没处理完不能往下走。'));

    var kept = CAN().keptOf(rec);
    var withConflict = kept.filter(function (c) { return !!c.conflict; });

    if (!kept.length) {
      box.appendChild(h('div', 'wj-empty', '还没有批准任何一条 —— 回上一步挑几条要写的。'));
      return box;
    }
    if (!withConflict.length) {
      box.appendChild(h('p', 'wj-notice is-ok', '要写的这几条都没有冲突。可以直接往下走。'));
      return box;
    }

    var list = h('div', 'wjc-list');
    withConflict.forEach(function (c) {
      var card = h('div', 'wjc-cand' + (c.fixed ? ' is-fixed' : ''));
      var head = h('div', 'wjc-cand-head');
      head.appendChild(h('span', 'wjc-cand-seq', '#' + c.seq));
      head.appendChild(h('span', 'wjc-cand-kind',
        c.fixed ? '已处理' : '待处理'));
      card.appendChild(head);
      card.appendChild(h('p', 'wjc-cand-text', c.text));
      card.appendChild(h('p', 'wjc-cand-conflict', '冲突：' + c.conflict));

      if (c.fixed) {
        card.appendChild(h('p', 'wjc-cand-fixed', '你的处理：' + (c.fixedText || '（没写说明）')));
        card.appendChild(btn('重新打开', 'wj-quiet', function () {
          CAN().reopenConflict(w.id, c.id);
          paint(ctx);
        }));
      } else {
        var ta = h('textarea', 'wjc-fix-input');
        ta.rows = 2;
        ta.placeholder = '比如：以时间线为准，这条改成「那年冬天」；或者：保留小说原样，这条不写';
        ta.value = c.fixedText || '';
        card.appendChild(ta);
        card.appendChild(btn('标记已处理', 'wj-btn', function () {
          var t = String(ta.value || '').trim();
          if (!t) { Sleepy.toast('写一句处理方式，别留空'); return; }
          CAN().fixConflict(w.id, c.id, t);
          paint(ctx);
        }));
      }
      card.appendChild(h('p', 'wjc-cand-note', c.note || ''));
      list.appendChild(card);
    });
    box.appendChild(list);
    return box;
  }

  /* --------------------------- ③ 认知 --------------------------- */
  function paneKnowledge(ctx, w, rec) {
    var box = h('div', 'wj-panel');
    box.appendChild(h('h2', 'wj-h2', '人物认知'));
    box.appendChild(h('p', 'wj-sub',
      '这件事谁记得、谁不知道。默认「完全不知情」—— 不写进任何人的记忆。' +
      '「本人未知」和「完全不知情」不一样：前者是这件事存在、只是他还不知道，' +
      '两条都不会写进他的记忆，但含义不同。'));

    var kept = CAN().keptOf(rec);
    var cast = w.cast || [];
    if (!kept.length) {
      box.appendChild(h('div', 'wj-empty', '还没有批准任何一条。'));
      return box;
    }
    if (!cast.length) {
      box.appendChild(h('div', 'wj-empty', '这部作品没有登记出场人物，没法分配认知。'));
      return box;
    }

    var list = h('div', 'wjc-list');
    kept.forEach(function (c) {
      var card = h('div', 'wjc-cand');
      var head = h('div', 'wjc-cand-head');
      head.appendChild(h('span', 'wjc-cand-seq', '#' + c.seq));
      head.appendChild(h('span', 'wjc-cand-kind', kindName(c.kind)));
      card.appendChild(head);
      card.appendChild(h('p', 'wjc-cand-text', c.text));

      cast.forEach(function (p) {
        var row = h('div', 'wjc-know-row');
        row.appendChild(h('span', 'wjc-know-name', p.name));
        var sel = h('select', 'wjc-know-sel');
        CAN().KNOWLEDGE.forEach(function (k) {
          var op = h('option', '', k.id);
          op.value = k.id;
          sel.appendChild(op);
        });
        sel.value = CAN().knowledgeOf(rec, p.charId, c.id);
        sel.onchange = function () {
          CAN().setKnowledge(w.id, p.charId, c.id, sel.value);
          /* 不重画整页：重画会把滚动位置抖掉，而这里通常要连着改好几个人的。
             但**闸门要立刻重算** —— 否则改完档位底部还说着「一个都没定」。 */
          var hint = row.querySelector('.wjc-know-hint');
          if (hint) hint.textContent = knowHint(sel.value);
          refreshGate(rec);
        };
        row.appendChild(sel);
        row.appendChild(h('span', 'wjc-know-hint', knowHint(sel.value)));
        card.appendChild(row);
      });
      list.appendChild(card);
    });
    box.appendChild(list);
    return box;
  }

  function knowHint(level) {
    var hit = CAN().KNOWLEDGE.filter(function (k) { return k.id === level; })[0];
    return hit ? hit.hint : '';
  }

  /* --------------------------- ④ 写入 --------------------------- */
  function paneWrite(ctx, w, rec) {
    var box = h('div', 'wj-panel');
    box.appendChild(h('h2', 'wj-h2', '最终写入'));
    box.appendChild(h('p', 'wj-sub', '只写入批准且冲突已处理的结构化历史。'));

    if (rec.written) {
      var refs = rec.eventRefs || [];
      var extra = refs.length
        ? '，另记了 ' + refs.length + ' 条日历'
        : '';
      box.appendChild(h('p', 'wj-notice is-ok',
        '已经写过了（' + (rec.writtenCount || 0) + ' 条' + extra + '，' + whenText(rec.writtenAt) + '）。' +
        '再点也不会写第二遍 —— 要去记忆里改，去留痕页改那一条。'));
      box.appendChild(btn('回留痕页看看', 'wj-btn', function () {
        Sleepy.nav.open('memory', {});
      }));
      return box;
    }

    /* ⚠️ **半完成态要说出来**（第三轮施工单 §2/§4）：
       留痕写进去了，但有候选的日历事件没落成 —— 这时不能显示「已经写过了」，
       那是谎报（用户会以为全写完了）。要如实说清哪几条没落上，并给重跑入口。
       重跑是安全的：留痕按内容去重、日历按 requestKey 幂等。 */
    if (rec.writtenPending) {
      var cf = rec.calendarFailed || [];
      box.appendChild(h('p', 'wj-notice is-warn',
        '留痕已经写进去了，但有 ' + cf.length + ' 条日历没记上' +
        (rec.writtenAt ? '（' + whenText(rec.writtenAt) + '）' : '') + '。' +
        '正史本身没丢，可以再点一次补 —— 已经写好的不会重复写。'));
      if (cf.length) {
        var flist = h('div', 'wjc-plan');
        cf.forEach(function (f) {
          var row = h('div', 'wjc-plan-row');
          row.appendChild(h('p', 'wjc-plan-line',
            '没落上的候选：' + String(f.cand || '') + '（' + (f.err || 'unknown') + '）'));
          flist.appendChild(row);
        });
        box.appendChild(flist);
      }
    }

    var p = CAN().plan(w.id);
    if (!p.count) {
      box.appendChild(h('div', 'wj-empty',
        '按现在的决定和认知，一条都不会写 —— 要么回前面挑几条要写的，要么回每一步改认知档位。'));
      return box;
    }

    box.appendChild(h('p', 'wj-sub', '会写 ' + p.count + ' 条：'));
    var list = h('div', 'wjc-plan');
    p.items.forEach(function (it) {
      var row = h('div', 'wjc-plan-row');
      var head = h('div', 'wjc-plan-head');
      head.appendChild(h('b', null, it.charName));
      head.appendChild(h('span', 'wjc-plan-level', it.level));
      row.appendChild(head);
      row.appendChild(h('p', 'wjc-plan-line', it.line));
      if (it.date) row.appendChild(h('p', 'wjc-cand-date', '另记一条日历（' + it.date + '）'));
      list.appendChild(row);
    });
    box.appendChild(list);

    var go = btn('写入现实（' + p.count + ' 条）', 'wj-btn wj-btn-solid', function () {
      var r = CAN().write(w.id);
      if (!r.ok) { Sleepy.toast('没写成：' + (r.blockers ? r.blockers[0] : r.why)); return; }
      /* 如实说：日历有失败就不许只报「写好了」（那是谎报）。
         半完成时明说还差几条，并指向刚加的补跑入口。 */
      if (r.writtenPending || (r.evFailed && r.evFailed.length)) {
        Sleepy.toast('留痕写好了，但有 ' + r.evFailed.length + ' 条日历没记上 —— 可以再点一次补');
      } else {
        Sleepy.toast('写好了 ' + r.count + ' 条' + (r.events ? '，另记 ' + r.events + ' 条日历' : ''));
      }
      paint(ctx);
    });
    var why = CAN().blockers(rec);
    if (why.length) {
      go.disabled = true;
      box.appendChild(h('p', 'wjc-blocked', '还差：' + why.join('；')));
    }
    box.appendChild(go);

    var seal = h('div', 'wjc-seal');
    seal.appendChild(h('p', null, '小说仍保留原文与所有文学加工。'));
    seal.appendChild(h('p', null,
      '写进去的只有上面这几条事实 —— 正文一个字都不会成为谁的经历。'));
    box.appendChild(seal);
    return box;
  }

  function whenText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* --------------------------- 主绘制 --------------------------- */

  function paint(ctx) {
    var w = view.workId ? wj().get(view.workId) : null;
    var body = ctx.body;
    body.innerHTML = '';
    ctx.setTitle('正史审阅');
    ctx.setActions([]);
    if (!w) {
      body.appendChild(h('div', 'wj-empty', '这部剧本已经不在门厅里了。'));
      return;
    }

    var shell = h('div', 'wj-shell');
    var head = h('div', 'wj-head');
    head.appendChild(h('div', 'wj-eyebrow', 'CANON REVIEW'));
    head.appendChild(h('h1', 'wj-h1', '正史审阅'));
    head.appendChild(h('p', 'wj-sub', '《' + (w.title || '') + '》 · ' +
      (wj().REALITY_LABEL[w.reality] || '普通故事')));
    shell.appendChild(head);

    /* 只有「正史候选」这一档该走到这里 —— 别的性质写进去会跟创建时的
       承诺打架（普通故事/平行世界明说了「不进入任何人的现实记忆」）。 */
    if (w.reality !== 'canon_candidate' && w.reality !== 'canonized') {
      shell.appendChild(h('div', 'wj-notice',
        '这部作品的性质是「' + (wj().REALITY_LABEL[w.reality] || '普通故事') + '」——' +
        '它在创建时就承诺过不进入任何人的现实记忆。要定史，得先回开帷流程把它改成「正史候选」。'));
      body.appendChild(shell);
      return;
    }

    var rec = CAN().open(w.id);
    shell.appendChild(stepsBar(ctx, rec));
    shell.appendChild(h('p', 'wj-sub', CAN().STEPS[rec.step].hint));

    if (rec.step === 0) shell.appendChild(paneCandidates(ctx, w, rec));
    else if (rec.step === 1) shell.appendChild(paneConflict(ctx, w, rec));
    else if (rec.step === 2) shell.appendChild(paneKnowledge(ctx, w, rec));
    else shell.appendChild(paneWrite(ctx, w, rec));

    shell.appendChild(navRow(ctx, rec));
    body.appendChild(shell);
  }

  Sleepy.register('wj-canon', {
    title: '正史审阅',
    render: function (ctx) {
      var p = ctx.params || {};
      if (p.workId || p.id) view.workId = p.workId || p.id;
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) { /* 数据版本没变就不整页重画（手感批 2026-10-29，见 page-wj-foyer.wjUI.freshPaint） */
 if (Sleepy.wjUI && Sleepy.wjUI.freshPaint) Sleepy.wjUI.freshPaint(ctx);
 else if (ctx.__paint) ctx.__paint(); }
  });

})(window);
