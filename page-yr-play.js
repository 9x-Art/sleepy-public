/* ============================================================
   page-yr-play.js — 「以身入局」· 入世游玩页（P0 第三刀 A）

   行动循环（方案 §5.1/§5.2）：
   · 一轮 = 一次调用，叙事与 <判定> 回判同往返（parseVerdict 剥离，
     applyVerdict 写回异常度/进度，正文进行动日志）；
   · 在场轮（user 说话，亲自参与/员工）与行动轮（老板纯看，
     「看 TA 走一步」，无 user 输入）共用同一管线；
   · 手动档：每轮点一次走一轮；自动连跑是下一批；
   · 顶部常驻委托卡（明面目标 + 异常度 + 进度）——任务感钉子；
   · 右上角设置：每轮字数档 + 模型连接（主/副去重单选，缺省跟随
     全局分配）。调用走 feature 'book'（勾选走副 API，不回落）。

   红线：一轮=一次 fetch，无扇出；判定解析缺块=无变化；
   记忆只落 bookRuns（带岛章），不碰角色记忆通道。
   依赖：book-core.js、page-yishenruju.js（.yr-* 样式）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var book = null;
  function B() { return book || (book = Sleepy.book); }

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) {
      if (text.nodeType) el.appendChild(text);
      else if (Array.isArray(text)) {
        text.forEach(function (t) {
          if (t === undefined || t === null) return;
          el.appendChild(t && t.nodeType ? t : document.createTextNode(String(t)));
        });
      } else el.textContent = String(text);
    }
    return el;
  }

  /* ------------------------------ 样式（本页 .yp-） ------------------------------ */
  var STYLE_ID = 'yr-play-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.yp-root{display:flex;flex-direction:column;height:100%;overflow:hidden;color:var(--wj-text);font-size:14px}',
      '.yp-deck{flex:0 0 auto;padding:10px 16px 8px;border-bottom:1px solid var(--wj-line);',
      'background:rgba(5,10,20,.34)}',
      '.yp-goal{font-family:var(--ff-serif);font-size:13px;font-weight:500;color:var(--wj-text);line-height:1.5}',
      '.yp-meters{display:flex;gap:14px;margin-top:6px;font-size:9.5px;letter-spacing:.14em;color:var(--wj-dimmer)}',
      '.yp-meters b{color:var(--wj-silver);font-weight:500;letter-spacing:.04em}',
      '.yp-meters .hot b{color:var(--wj-wine-lite)}',

      /* 行动日志 */
      '.yp-log{flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch}',
      '.yp-log::-webkit-scrollbar{width:0}',
      '.yp-entry{margin-bottom:14px;border:1px solid var(--wj-line);border-radius:8px;padding:11px 13px;background:rgba(255,255,255,.025)}',
      '.yp-entry-head{display:flex;justify-content:space-between;font-size:9px;letter-spacing:.16em;color:var(--wj-dimmer);margin-bottom:6px}',
      '.yp-entry-input{font-size:11px;color:var(--wj-silver);border-left:2px solid var(--wj-wine);padding-left:8px;margin-bottom:7px;line-height:1.6}',
      '.yp-entry-text{font-size:12.5px;line-height:1.9;color:var(--wj-text)}',
      '.yp-entry-verdict{margin-top:8px;padding-top:7px;border-top:1px dashed var(--wj-line-soft);font-size:10.5px;line-height:1.7;color:var(--wj-dim)}',
      '.yp-entry-verdict b{color:var(--wj-wine-lite);font-weight:500}',
      '.yp-pending{opacity:.5;font-style:normal}',
      '.yp-empty{font-size:11.5px;color:var(--wj-dimmer);line-height:1.9;padding:8px 2px}',

      /* 底部动作区 */
      '.yp-act{flex:0 0 auto;padding:10px 16px 12px;border-top:1px solid var(--wj-line);background:rgba(5,10,20,.34)}',
      '.yp-input{width:100%;box-sizing:border-box;resize:none;rows:2;border:1px solid var(--wj-line);border-radius:8px;',
      'background:rgba(255,255,255,.04);color:var(--wj-text);padding:9px 11px;font-size:13px;line-height:1.6;font-family:inherit}',
      '.yp-input::placeholder{color:var(--wj-dimmer)}',
      '.yp-send{display:block;width:100%;margin-top:8px;padding:11px;border:1px solid rgba(236,230,218,.4);border-radius:6px;',
      'background:rgba(255,255,255,.05);color:var(--wj-text);font-family:var(--ff-serif);font-size:13.5px;letter-spacing:.2em;cursor:pointer}',
      '.yp-send[disabled]{opacity:.45;cursor:default}',

      /* 设置抽屉 */
      '.yp-sheet{position:fixed;inset:0;z-index:60;background:rgba(3,7,14,.62);display:flex;align-items:flex-end;justify-content:center}',
      '.yp-sheet[hidden]{display:none}',
      '.yp-panel{width:100%;max-width:430px;background:#101a30;border:1px solid var(--wj-line);border-bottom:0;',
      'border-radius:14px 14px 0 0;padding:16px 18px 20px;max-height:70vh;overflow-y:auto}',
      '.yp-panel h3{margin:0 0 10px;font-family:var(--ff-serif);font-weight:500;font-size:15px;color:var(--wj-text);letter-spacing:.1em}',
      '.yp-opt{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--wj-line);border-radius:8px;',
      'margin-top:7px;cursor:pointer;color:var(--wj-text);font-size:12.5px;background:rgba(255,255,255,.02)}',
      '.yp-opt.on{border-color:var(--wj-silver)}',
      '.yp-opt small{color:var(--wj-dimmer);margin-left:auto;font-size:10px}',
      '.yp-close{margin-top:12px;width:100%;padding:10px;border:1px dashed var(--wj-line);border-radius:8px;',
      'background:transparent;color:var(--wj-dim);font-size:11.5px;cursor:pointer}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ------------------------------ 设置 ------------------------------ */

  function getSettings(sid) {
    return B().getMap('bookSettingsBySandbox', sid) || {};
  }
  function setSetting(sid, key, val) {
    var s = getSettings(sid);
    s[key] = val;
    B().setMap('bookSettingsBySandbox', sid, s);
  }

  function openSettings(ctx, sid, onChange) {
    var s = getSettings(sid);
    var sheet = h('div', 'yp-sheet');
    var panel = h('div', 'yp-panel');
    panel.appendChild(h('h3', null, '设置'));

    panel.appendChild(h('div', 'yr-eyebrow', '每轮描写字数'));
    var WORD_LABEL = { short: '精炼', standard: '标准', long: '铺陈' };
    Object.keys(B().WORDS).forEach(function (k) {
      var o = h('button', 'yp-opt' + ((s.words || 'standard') === k ? ' on' : ''));
      o.appendChild(h('span', null, WORD_LABEL[k]));
      o.appendChild(h('small', null, B().WORDS[k].replace(/字$/, '')));
      o.addEventListener('click', function () {
        setSetting(sid, 'words', k);
        sheet.remove(); openSettings(ctx, sid, onChange);
      });
      panel.appendChild(o);
    });

    panel.appendChild(h('div', 'yr-eyebrow', '模型连接'));
    var conns = [{ label: null, name: '跟随全局分配', note: '副API功能分配/主链' }];
    try {
      var seen = {};
      (Sleepy.api.candidates() || []).forEach(function (c) {
        if (seen[c.label]) return;
        seen[c.label] = true;
        conns.push({ label: c.label, name: (c.source === 'main' ? '主 · ' : '副 · ') + c.label, note: c.cfg && c.cfg.model || '' });
      });
    } catch (e) { /* candidates 不可用就只有跟随全局 */ }
    conns.forEach(function (c) {
      var o = h('button', 'yp-opt' + ((s.connLabel || null) === c.label ? ' on' : ''));
      o.appendChild(h('span', null, c.name));
      o.appendChild(h('small', null, c.note || ''));
      o.addEventListener('click', function () {
        setSetting(sid, 'connLabel', c.label);
        sheet.remove(); openSettings(ctx, sid, onChange);
      });
      panel.appendChild(o);
    });

    var close = h('button', 'yp-close', '收起');
    close.addEventListener('click', function () { sheet.remove(); if (onChange) onChange(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) { sheet.remove(); if (onChange) onChange(); } });
    ctx.body.appendChild(sheet);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  var busy = false;   /* 模块级：onShow rebuild 重画后旧闭包的局部 busy 会丢，双发防线必须活过重建 */

  function identityName(key) {
    var hit = B().IDENTITIES.filter(function (x) { return x.key === key; })[0];
    return hit ? hit.name : key;
  }

  function renderDeck(root, run) {
    var deck = h('div', 'yp-deck');
    deck.appendChild(h('div', 'yp-goal', '明面目标：' + B().DRILL_BRIEF.publicGoal));
    var meters = h('div', 'yp-meters');
    meters.appendChild(h('span', null, ['异常度 ', h('b', null, String(run.anomaly || 0))]));
    var pm = h('span', null, ['进度 ', h('b', null, (run.progress || 0) + '%')]);
    meters.appendChild(pm);
    var hot = h('span', null, ['身份 ', h('b', null, identityName(run.identity))]);
    if ((run.anomaly || 0) >= 40) hot.className = 'hot';
    meters.appendChild(hot);
    deck.appendChild(meters);
    root.appendChild(deck);
  }

  function renderEntry(e) {
    var el = h('div', 'yp-entry' + (e.pending ? ' yp-pending' : ''));
    var head = h('div', 'yp-entry-head');
    head.appendChild(h('span', null, '第 ' + e.n + ' 轮'));
    head.appendChild(h('span', null, e.at ? e.at.replace('T', ' ').slice(11, 16) : '…'));
    el.appendChild(head);
    if (e.input) el.appendChild(h('div', 'yp-entry-input', e.input));
    el.appendChild(h('div', 'yp-entry-text', e.text || '…'));
    if (e.verdictText || e.anomalyDelta) {
      var v = h('div', 'yp-entry-verdict');
      v.appendChild(h('b', null, '判定 ' + (e.anomaly ? '· 异常度 ' + e.anomaly : '') + (e.progress ? ' · 进度 ' + e.progress + '%' : '')));
      if (e.verdictText) v.appendChild(document.createTextNode('\n' + e.verdictText.split('\n').slice(0, 4).join('\n')));
      el.appendChild(v);
    }
    return el;
  }

  function render(ctx) {
    var sid = (ctx.params && ctx.params.sandboxId) || (Sleepy.core.activeSandbox() || {}).id || null;
    var boxId = ctx.params && ctx.params.boxId;
    ctx.setTitle('入世');
    ctx.setActions([{
      label: '设置',
      onClick: function () { openSettings(ctx, sid, function () { render(ctx); }); }
    }]);
    ctx.body.innerHTML = '';
    ensureStyle();
    ctx.rebuild = function () { render(ctx); };
    if (!sid || !boxId) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '从建档页开局后才有可玩的世界。'));
      return;
    }
    B().lockSandbox(sid);
    var box = B().getBox(boxId, sid);
    var run = B().getRunByBox(boxId, sid);
    if (!box || !run) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '这局还没开。回建档页开局吧。'));
      return;
    }
    var world = B().getWorld(run.world) || B().DRILL_WORLD;

    var root = h('div', 'yp-root');
    renderDeck(root, run);

    /* 行动日志 */
    var logEl = h('div', 'yp-log');
    if (!run.logs || !run.logs.length) {
      logEl.appendChild(h('div', 'yp-empty',
        world.brief + '\n\n第一轮还没开始。' +
        (run.identity === 'boss-watch'
          ? '点下面「看 TA 走一步」，让局里的人先动起来。'
          : '在下面写下你的言行，这个世界会回应你。')));
    } else {
      run.logs.forEach(function (e) { logEl.appendChild(renderEntry(e)); });
    }
    root.appendChild(logEl);

    /* 动作区 */
    var act = h('div', 'yp-act');
    if (run.identity === 'boss-watch') {
      var watch = h('button', 'yp-send', '看 TA 走一步');
      watch.addEventListener('click', function () {
        if (busy) return;
        busy = true; watch.disabled = true; watch.textContent = '世界里…';
        round(ctx, box, run, null, function () {
          busy = false; render(ctx);
        }, function () {
          busy = false; watch.disabled = false; watch.textContent = '看 TA 走一步';
        });
      });
      act.appendChild(watch);
    } else {
      var ta = document.createElement('textarea');
      ta.className = 'yp-input';
      ta.rows = 2;
      ta.placeholder = run.identity === 'staff'
        ? '以「' + (run.seat && run.seat.name || '你的占位') + '」的身份言行……'
        : '以老板身份说一句话、做一个动作……';
      act.appendChild(ta);
      var send = h('button', 'yp-send', '落 进 世 界');
      send.addEventListener('click', function () {
        if (busy) return;
        var text = ta.value.trim();
        if (!text) { Sleepy.toast('先写点什么再落进世界。'); return; }
        busy = true; send.disabled = true;
        round(ctx, box, run, text, function () {
          busy = false; render(ctx);
        }, function () {
          busy = false; send.disabled = false;
        });
      });
      act.appendChild(send);
    }
    root.appendChild(act);
    ctx.body.appendChild(root);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* 一轮：pending 日志 → 调模型 → 剥判定 → 写回落库 → 重渲。
     一轮 = 一次 fetch（feature 'book'；app 设置过连接则用之，仍单候选单次）。 */
  function round(ctx, box, run, input, onOk, onFail) {
    var sid = box.sandboxId;
    /* 关键：render 闭包里的 run 是深拷贝快照 —— 直接在它身上 push 再 persist，
       这条 pending 会永远留在闭包副本里，之后每次点击都把整份陈旧数组整表
       写回 store（实测：每轮净 +1 条幽灵 pending，历史被慢慢污染）。
       一进来重读 store 里的最新记录，done/fail 也各自重读，全程只认 store。 */
    run = B().getRunByBox(box.id, sid) || run;
    var settings = getSettings(sid);
    var messages = B().buildBookMessages(run, box, B().getWorld(run.world), settings, input);
    var world = B().getWorld(run.world) || B().DRILL_WORLD;

    run.logs = run.logs || [];
    run.logs.push({
      n: run.logs.length + 1, at: new Date().toISOString(),
      input: input || null, text: '……', pending: true
    });
    persistRun(run);
    var logEl = ctx.body.querySelector('.yp-log');
    if (logEl) {
      logEl.appendChild(renderEntry(run.logs[run.logs.length - 1]));
      logEl.scrollTop = logEl.scrollHeight;
    }

    function done(text) {
      var v = B().parseVerdict(text);
      var live = B().getRunByBox(box.id, sid);
      live.logs = live.logs || [];
      live.logs.pop();                    /* 摘掉 pending 占位 */
      var entry = B().applyVerdict(live, v, input);
      live.world = live.world || 'drill';
      live.chapter = world.chapter;
      persistRun(live);
      if (live.anomaly >= 60) Sleepy.toast('异常度 ' + live.anomaly + ' —— 世界开始正式查你。', 'err');
      if (onOk) onOk(entry);
    }
    function fail(err) {
      var live = B().getRunByBox(box.id, sid);
      live.logs = live.logs || [];
      live.logs.pop();
      persistRun(live);
      Sleepy.toast('这一轮没走成：' + ((err && err.error) || '还没有可用的模型连接'), 'err');
      if (onFail) onFail(err);
    }

    /* app 内指定连接（settings.connLabel）优先于 feature 分配：
       指定了 → 在该候选上单发（不轮询、不回落，失败如实报）。 */
    var connLabel = settings.connLabel || null;
    if (connLabel) {
      var cand = null;
      try {
        (Sleepy.api.candidates() || []).forEach(function (c) { if (c.label === connLabel) cand = c; });
      } catch (e) { /* 无候选 */ }
      if (!cand) {
        fail({ error: '设置的连接「' + connLabel + '」当前不可用，去设置里换一个。' });
        return;
      }
      Sleepy.api.requestOnce
        ? Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
            res.ok ? done(res.content || '') : fail(res);
          }, function (e) { fail({ error: String((e && e.message) || e) }); })
        : fail({ error: '接口层缺 requestOnce' });
    } else {
      Sleepy.api.runChat(messages, {
        onDone: function (cand2, text) { done(text); },
        onFail: function (c, err) { fail(err || { error: '生成失败' }); }
      }, false, { feature: 'book' });
    }
  }

  function persistRun(run) {
    var all = Sleepy.store.get('bookRuns') || [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === run.id) { all[i] = run; break; }
    }
    Sleepy.store.set('bookRuns', all);
  }

  Sleepy.register('yr-play', {
    title: '入世',
    render: render,
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });
})(window);
