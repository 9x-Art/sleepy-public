/* ============================================================
   page-yr-play.js — 「以身入局」· 入世游玩页（P0 第三刀 A）

   行动循环（方案 §5.1/§5.2）：
   · 一轮 = 一次调用，叙事与 <判定> 回判同往返（parseVerdict 剥离，
     applyVerdict 写回异常度/进度，正文进行动日志）；
   · 在场轮（user 说话，亲自参与/员工）与行动轮（老板纯看，
     「看 TA 走一步」，无 user 输入）共用同一管线；
   · 手动档：每轮点一次走一轮；自动档「让 TA 自己走一段」= 前端同进程
     连跑 N 轮（默认 3，设置可改），随时可停，异常度≥60 / 进度满 / 失败
     自动刹车；离开页面即停（本页循环不是后台任务，文案实话实说）；
   · 悬浮球三件套（方案 §5.3）：按身份换装——
     boss-watch=B套（局印/观测窗/char 背包只读）；boss-join=A套
     （手机/背包/局印）；staff=A套但局印置灰（局印认老板）；
   · 局印干预：不单独调用，传话写进 run.interventions，并入下一轮注入
     （consumeInterventions 在轮成功后标记已用，日志条带局印批注）；
   · 结算封档：分数由状态机按记录算（settleScores），结算叙述是一次
     可选调用；finishRun 落 settlement + 档案盒变「已结案」；
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
      '.yp-deck{flex:0 0 auto;padding:10px 16px 8px;border-bottom:2px solid #1c1a17;',
      'background:#f7f3e8}',
      '.yp-goal{font-family:var(--ff-serif);font-size:13px;font-weight:500;color:var(--wj-text);line-height:1.5}',
      '.yp-meters{display:flex;gap:14px;margin-top:6px;font-size:9.5px;letter-spacing:.14em;color:var(--wj-dimmer)}',
      '.yp-meters b{color:var(--wj-silver);font-weight:500;letter-spacing:.04em}',
      '.yp-meters .hot b{color:var(--wj-wine-lite)}',
      /* ★ v219 场景切换条（多张场景图手动切换） */
      '.yp-scene{position:relative;margin:0 0 8px;border:1px solid var(--wj-line);border-radius:8px;overflow:hidden}',
      '.yp-scene-img{display:block;width:100%;height:110px;object-fit:cover}',
      '.yp-scene-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:14px;',
      'padding:4px 8px;background:rgba(28,26,23,.55)}',
      '.yp-scene-btn{border:0;background:none;color:#f4f0e7;font-size:15px;cursor:pointer;padding:0 6px;font-family:inherit}',
      '.yp-scene-n{font-size:9.5px;letter-spacing:.14em;color:#f4f0e7}',

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
      '.yp-sub{display:block;width:100%;margin-top:6px;padding:8px;border:0;background:transparent;',
      'color:var(--wj-dim);font-size:11px;letter-spacing:.12em;cursor:pointer;text-decoration:underline dotted}',
      '.yp-sub.warn{color:var(--wj-wine-lite)}',

      /* 悬浮球三件套 */
      '.yp-balls{flex:0 0 auto;display:flex;gap:14px;padding:8px 16px 2px;background:rgba(5,10,20,.34)}',
      '.yp-ball{width:44px;height:44px;border-radius:50%;border:1px solid var(--wj-line);',
      'background:rgba(255,255,255,.04);color:var(--wj-text);font-family:var(--ff-serif);',
      'font-size:15px;cursor:pointer;line-height:1;padding:0}',
      '.yp-ball small{display:block;font-size:8px;letter-spacing:.2em;color:var(--wj-dimmer);margin-top:3px}',
      '.yp-ball:active{transform:scale(.93)}',
      '.yp-ball.dim{opacity:.32;cursor:not-allowed}',
      '.yp-ball.badge{border-color:var(--wj-wine-lite);box-shadow:0 0 0 1px var(--wj-wine-lite)}',
      '.yp-sealnote{font-size:10.5px;color:var(--wj-gold,#c8a86b);border-left:2px solid #c8a86b;',
      'padding-left:8px;margin-bottom:7px;line-height:1.6}',

      /* 背包 / 观测窗条目 */
      '.yp-item{display:flex;gap:8px;align-items:baseline;padding:7px 10px;border:1px solid var(--wj-line);',
      'border-radius:8px;margin-top:6px;font-size:12px;color:var(--wj-text)}',
      '.yp-item em{font-style:normal;font-size:9px;letter-spacing:.14em;color:var(--wj-dimmer);border:1px solid var(--wj-line-soft);padding:1px 5px;border-radius:3px}',
      '.yp-item small{color:var(--wj-dimmer);margin-left:auto;font-size:10px}',
      '.yp-row{display:flex;gap:6px;margin-top:8px}',
      '.yp-row input{flex:1;border:1px solid var(--wj-line);border-radius:6px;background:rgba(255,255,255,.04);',
      'color:var(--wj-text);padding:7px 9px;font-size:12px;font-family:inherit}',
      '.yp-row button{border:1px solid var(--wj-line);border-radius:6px;background:rgba(255,255,255,.05);',
      'color:var(--wj-text);padding:7px 12px;font-size:11px;cursor:pointer}',
      '.yp-stat{display:flex;justify-content:space-between;font-size:12px;color:var(--wj-text);padding:7px 2px;border-bottom:1px dashed var(--wj-line-soft)}',
      '.yp-stat b{color:var(--wj-silver);font-weight:500}',
      '.yp-score{font-size:13px;color:var(--wj-text);line-height:2}',

      /* 设置抽屉（2026-10-11 装修：底贴 → **居中卡片**，纸面白瓷） */
      '.yp-sheet{position:fixed;inset:0;z-index:60;background:rgba(28,26,23,.45);display:flex;align-items:center;justify-content:center}',
      '.yp-sheet[hidden]{display:none}',
      '.yp-panel{width:min(340px,88%);background:#f4f0e7;border:1px solid rgba(43,38,32,.4);',
      'border-radius:14px;padding:16px 18px 20px;max-height:72vh;overflow-y:auto;',
      'box-shadow:0 24px 60px rgba(43,38,32,.35)}',
      '.yp-panel h3{margin:0 0 10px;font-family:var(--ff-serif);font-weight:500;font-size:15px;color:#2b2620;letter-spacing:.1em}',
      /* 局内手机：小手机造型壳（宽 280 竖长、圆角壳、顶部听筒条） */
      '.yp-panel.yp-phone{width:min(280px,80%);border-radius:26px;border-width:2px;padding-top:26px;position:relative;}',
      '.yp-phone-notch{position:absolute;top:9px;left:50%;transform:translateX(-50%);width:64px;height:7px;',
      'border-radius:99px;background:rgba(43,38,32,.35);}',
      '.yp-panel.yp-phone h3{margin-top:4px;text-align:center;}',
      '.yp-opt{display:flex;align-items:center;gap:9px;padding:11px 12px;border:0;border-radius:8px;',
      'margin-top:2px;cursor:pointer;color:#2b2620;font-size:12.5px;background:transparent}',
      '.yp-opt.on{background:#1c1a17;color:#f4f0e7}',
      '.yp-opt.on small{color:rgba(244,240,231,.72)}',
      '.yp-opt small{color:#6f675c;margin-left:auto;font-size:10px}',
      '.yp-close{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;',
      'background:transparent;color:#6f675c;font-size:11.5px;cursor:pointer;text-decoration:underline dotted}',

      /* ☰ 右侧栏（2026-10-11：替代悬浮球三件套 —— 点开右侧滑出，套装三项） */
      '.yp-rail{position:fixed;inset:0;z-index:60;background:rgba(28,26,23,.45);display:flex;justify-content:flex-end}',
      '.yp-rail-panel{width:min(300px,84%);height:100%;background:#f4f0e7;border-left:1px solid #1c1a17;',
      'box-shadow:-18px 0 44px rgba(43,38,32,.3);padding:18px 16px;overflow-y:auto;',
      'animation:ypRailIn .18s ease-out}',
      '@keyframes ypRailIn{from{transform:translateX(36%);opacity:.4}to{transform:none;opacity:1}}',
      '.yp-rail-title{font-family:var(--ff-serif);font-size:15px;letter-spacing:.12em;color:#2b2620;',
      'padding-bottom:10px;border-bottom:2px solid #1c1a17;position:relative}',
      '.yp-rail-title:after{content:"";position:absolute;left:0;right:0;bottom:-5px;height:1px;background:#1c1a17}',
      '.yp-rail-item{display:flex;align-items:center;gap:12px;width:100%;padding:13px 12px;margin-top:9px;',
      'border:1px solid rgba(43,38,32,.35);border-radius:10px;background:rgba(255,255,255,.6);',
      'color:#2b2620;font-family:inherit;font-size:13px;cursor:pointer;text-align:left}',
      '.yp-rail-item b{font-family:var(--ff-serif);font-weight:500;font-size:16px;line-height:1}',
      '.yp-rail-item small{margin-left:auto;font-size:9.5px;letter-spacing:.14em;color:#6f675c}',
      '.yp-rail-item:active{background:rgba(28,26,23,.08)}',
      '.yp-rail-item.dim{opacity:.35;cursor:not-allowed}',
      '.yp-rail-item.badge{border-color:#a63b32;box-shadow:0 0 0 1px #a63b32}',
      '.yp-rail-note{font-size:10.5px;color:#948b7d;line-height:1.8;margin-top:12px}'
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

  function openSettings(ctx, sid, boxId, onChange) {
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
        sheet.remove(); openSettings(ctx, sid, boxId, onChange);
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
        sheet.remove(); openSettings(ctx, sid, boxId, onChange);
      });
      panel.appendChild(o);
    });

    panel.appendChild(h('div', 'yr-eyebrow', '自动档连跑轮数'));
    [1, 3, 5].forEach(function (n) {
      var o = h('button', 'yp-opt' + ((s.autoRounds || 3) === n ? ' on' : ''));
      o.appendChild(h('span', null, '让 TA 自己走 ' + n + ' 轮'));
      o.appendChild(h('small', null, n === 3 ? '默认' : ''));
      o.addEventListener('click', function () {
        setSetting(sid, 'autoRounds', n);
        sheet.remove(); openSettings(ctx, sid, boxId, onChange);
      });
      panel.appendChild(o);
    });

    /* v221 手动封禁（方案 v1.2 出口之四）：把这个世界封进第二层书架。
       两次点按确认（第一次只变文字，不弹窗）。 */
    panel.appendChild(h('div', 'yr-eyebrow', '危险区'));
    var sealBtn = h('button', 'yp-opt');
    sealBtn.appendChild(h('span', null, '封存这个世界'));
    sealBtn.appendChild(h('small', null, '本局作废，档案盒盖上「已封存」进第二层'));
    sealBtn.addEventListener('click', function () {
      if (sealBtn.dataset.armed !== '1') {
        sealBtn.dataset.armed = '1';
        sealBtn.querySelector('span').textContent = '再点一次，确认封存';
        return;
      }
      sheet.remove();
      var bx = B().sealBox(boxId, '老板手动封存');
      Sleepy.toast('《' + bx.title + '》已封存，躺在档案架第二层。');
      if (onChange) onChange();
    });
    panel.appendChild(sealBtn);

    var close = h('button', 'yp-close', '收起');
    close.addEventListener('click', function () { sheet.remove(); if (onChange) onChange(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) { sheet.remove(); if (onChange) onChange(); } });
    ctx.body.appendChild(sheet);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  var busy = false;   /* 模块级：onShow rebuild 重画后旧闭包的局部 busy 会丢，双发防线必须活过重建 */
  /* 自动档状态（模块级）：token 让旧循环可停；boxId 区分是哪一局的自动档 */
  var auto = { running: false, token: null, boxId: null, left: 0 };

  function identityName(key) {
    var hit = B().IDENTITIES.filter(function (x) { return x.key === key; })[0];
    return hit ? hit.name : key;
  }

  function renderDeck(root, run, box) {
    var deck = h('div', 'yp-deck');
    /* ★ v219 场景切换（用户：故事是发展的，场景是动态的 —— 本批先给
       手动切换；「剧情自动换景」等世界包批次接）。box.sceneRefs 顺序切换。 */
    var refs = (box && box.sceneRefs) || (box && box.coverRef ? [box.coverRef] : []);
    if (refs.length) {
      var sc = h('div', 'yp-scene');
      var img = h('img', 'yp-scene-img');
      img.alt = '当前场景';
      var idx = 0;
      function paint() {
        Sleepy.media.url(refs[idx]).then(function (u) { img.src = u; }, function () {});
        lab.textContent = (idx + 1) + ' / ' + refs.length;
      }
      var lab = h('span', 'yp-scene-n', '');
      var prevB = h('button', 'yp-scene-btn', '‹');
      var nextB = h('button', 'yp-scene-btn', '›');
      prevB.type = 'button'; nextB.type = 'button';
      prevB.addEventListener('click', function () { idx = (idx - 1 + refs.length) % refs.length; paint(); });
      nextB.addEventListener('click', function () { idx = (idx + 1) % refs.length; paint(); });
      var bar = h('div', 'yp-scene-bar');
      bar.appendChild(prevB); bar.appendChild(lab); bar.appendChild(nextB);
      sc.appendChild(img); sc.appendChild(bar);
      paint();
      deck.appendChild(sc);
    }
    var goalText = (box && box.source === 'txt' && box.commission && box.commission.text)
      ? box.commission.text : B().DRILL_BRIEF.publicGoal;
    deck.appendChild(h('div', 'yp-goal', '明面目标：' + goalText));
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
    if (e.sealNote) el.appendChild(h('div', 'yp-sealnote', '局印 · ' + e.sealNote));
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
    ctx.setActions([
      { label: '局中口袋', svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 7h15M4.5 12h15M4.5 17h15"/></svg>',
        onClick: function () { openRailDrawer(ctx, sid, boxId); } },
      { label: '设置',
        onClick: function () { openSettings(ctx, sid, boxId, function () { render(ctx); }); } }
    ]);
    ctx.body.innerHTML = '';
    ensureStyle();
    if (Sleepy.yrHomeStyle) Sleepy.yrHomeStyle();   /* 纸面撞色皮（yishenruju 同一份） */
    ctx.rebuild = function () { render(ctx); };
    if (!sid || !boxId) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '从建档页开局后才有可玩的世界。'));
      return;
    }
    B().lockSandbox(sid);
    var box = B().getBox(boxId, sid);
    var run = B().getRunByBox(boxId, sid);
    if (!box) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '找不到这个档案盒。'));
      return;
    }
    if (!run) {
      var last = B().getLastRunByBox(boxId, sid);
      if (last && last.status === 'ended') { renderSettled(ctx, last); return; }
      ctx.body.appendChild(h('p', 'ph-entry-lead', '这局还没开。回建档页开局吧。'));
      return;
    }
    var world = B().worldFor(box, run);

    var root = h('div', 'yp-root');
    renderDeck(root, run, box);

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
    var pendingSeal = B().pendingInterventions(run).length;
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

      /* 自动档：前端同进程连跑 N 轮，可停；离开页面即停（实话实说） */
      var n = getSettings(sid).autoRounds || 3;
      var autoBtn = h('button', 'yp-send' + (auto.running && auto.boxId === box.id ? '' : ''),
        auto.running && auto.boxId === box.id ? '停下（自动档在走）' : '让 TA 自己走一段（' + n + ' 轮）');
      autoBtn.style.marginTop = '6px';
      autoBtn.addEventListener('click', function () {
        if (auto.running && auto.boxId === box.id) {
          auto.token.stop = true;
          autoBtn.textContent = '停下……';
          return;
        }
        if (busy) return;
        busy = true;
        startAuto(ctx, box, n);
      });
      act.appendChild(autoBtn);
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

    /* 结算封档入口：进度满高亮，其余时候也允许提前结案（§7.2 撤回口径） */
    var settle = h('button', 'yp-sub' + ((run.progress || 0) >= 100 ? ' warn' : ''),
      (run.progress || 0) >= 100 ? '委托已达成 —— 结算封档' : '提前结案（结算封档）');
    settle.addEventListener('click', function () {
      if (busy) { Sleepy.toast('等这一轮走完再结算。'); return; }
      openSettle(ctx, sid, box);
    });
    act.appendChild(settle);

    if (pendingSeal && run.identity !== 'staff') {
      act.appendChild(h('div', 'yp-sealnote', '局印有 ' + pendingSeal + ' 条传话没送出，会并进下一轮。'));
    }
    root.appendChild(act);
    ctx.body.appendChild(root);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ☰ 右侧栏（2026-10-11 装修：替代悬浮球三件套 —— 用户点名
     「点击三条横线出来右侧栏，三个选项」，面板要居中像真手机）。
     三项仍按身份换装（ballDefs 的 A/B 套），局印徽标/置灰逻辑原样保留。 */
  function openRailDrawer(ctx, sid, boxId) {
    var box = B().getBox(boxId, sid);
    var run = box && B().getRunByBox(box.id, sid);
    if (!box || !run) { Sleepy.toast('这局已经结了。'); return; }
    var rail = h('div', 'yp-rail');
    var panel = h('div', 'yp-rail-panel');
    panel.appendChild(h('div', 'yp-rail-title', '局中口袋'));
    panel.appendChild(h('div', 'yr-eyebrow', identityName(run.identity) + ' 随身三件'));
    ballDefs(run).forEach(function (d) {
      var badge = d.k === 'seal' && !d.dim && B().pendingInterventions(run).length > 0;
      var item = h('button', 'yp-rail-item' + (d.dim ? ' dim' : '') + (badge ? ' badge' : ''));
      item.appendChild(h('b', null, d.glyph));
      item.appendChild(h('span', null, d.label));
      item.appendChild(h('small', null, badge ? '有传话' : (d.readonly ? '只读' : '')));
      item.addEventListener('click', function () {
        if (d.dim) { Sleepy.toast('局印认老板，员工的你只能看着。'); return; }
        rail.remove();
        openBallPanel(ctx, sid, box, d.k, d.readonly);
      });
      panel.appendChild(item);
    });
    panel.appendChild(h('p', 'yp-rail-note',
      '点一项打开居中的面板；写进世界的传话会并进下一轮。'));
    var close = h('button', 'yp-close', '收起');
    close.addEventListener('click', function () { rail.remove(); });
    panel.appendChild(close);
    rail.addEventListener('click', function (e) { if (e.target === rail) rail.remove(); });
    rail.appendChild(panel);
    ctx.body.appendChild(rail);
  }

  function ballDefs(run) {
    if (run.identity === 'boss-watch') {
      /* B 套 · 观测视角：局印（主工具）/ 观测窗 / char 背包只读；手机不出现 */
      return [
        { k: 'seal', glyph: '印', label: '局印' },
        { k: 'observe', glyph: '窗', label: '观测窗' },
        { k: 'bag', glyph: '囊', label: 'TA 的背包', readonly: true }
      ];
    }
    /* A 套 · 在场视角：手机 / 背包 / 局印；staff 局印置灰 */
    return [
      { k: 'phone', glyph: '机', label: '手机' },
      { k: 'bag', glyph: '囊', label: '背包' },
      { k: 'seal', glyph: '印', label: '局印', dim: run.identity === 'staff' }
    ];
  }

  function openBallPanel(ctx, sid, box, kind, readonly) {
    var run = B().getRunByBox(box.id, sid);
    if (!run) { Sleepy.toast('这局已经结了。'); return; }
    var sheet = h('div', 'yp-sheet');
    var panel = h('div', 'yp-panel');
    function refresh() { sheet.remove(); render(ctx); }
    function refreshStay() { sheet.remove(); render(ctx); openBallPanel(ctx, sid, box, kind, readonly); }
    var world = B().worldFor(box, run);

    if (kind === 'phone') {
      /* 局内手机：面板做成小手机样子（2026-10-11 用户：弹一个手机样子的） */
      panel.classList.add('yp-phone');
      panel.appendChild(h('div', 'yp-phone-notch'));
      panel.appendChild(h('h3', null, '手机 · 局内系统'));
      /* v221：导入世界读档案盒上的委托；演练世界照旧读内置委托 */
      var brief = (box.source === 'txt')
        ? {
            requester: (box.commission && box.commission.requester) || '委托者（局外）',
            publicGoal: (box.commission && box.commission.text) || '按档案员预读的建议执行',
            restriction: (box.commission && box.commission.restriction) || '不得向世界角色透露「局」的存在'
          }
        : B().DRILL_BRIEF;
      [['委托人', brief.requester], ['明面目标', brief.publicGoal],
       ['守则', brief.restriction], ['同档', world.npcs.map(function (n) { return n.name; }).join('、')]]
        .forEach(function (p) {
          var s = h('div', 'yp-stat');
          s.appendChild(h('span', null, p[0]));
          s.appendChild(h('b', null, p[1]));
          panel.appendChild(s);
        });
      panel.appendChild(h('p', 'yp-empty', '传话走局印，不走手机——手机只管信息。'));
    }

    if (kind === 'bag') {
      panel.appendChild(h('h3', null, readonly ? 'TA 的背包（只读）' : '背包'));
      var items = run.inventory || [];
      if (!items.length) {
        panel.appendChild(h('p', 'yp-empty', readonly ? 'TA 还没在世界里拿到东西。' : '还空着。收进一样东西试试。'));
      }
      items.forEach(function (it) {
        var el = h('div', 'yp-item');
        el.appendChild(h('em', null, it.state === 'real' ? '实物' : '存档'));
        el.appendChild(h('span', null, it.name));
        if (it.note) el.appendChild(h('small', null, it.note));
        panel.appendChild(el);
      });
      var realN = items.filter(function (i) { return i.state === 'real'; }).length;
      panel.appendChild(h('p', 'yp-empty', '结案折算预览：实物 ' + realN + ' 件 × 2 = ' + (realN * 2) + ' 能量点（存档态不折算）。'));
      if (!readonly) {
        var input = document.createElement('input');
        input.placeholder = '收进一样东西……';
        var row = h('div', 'yp-row');
        row.appendChild(input);
        ['real', 'archived'].forEach(function (st) {
          var btn = h('button', null, st === 'real' ? '收实物' : '收存档');
          btn.addEventListener('click', function () {
            var name = input.value.trim();
            if (!name) { Sleepy.toast('先写物件名。'); return; }
            var live = B().getRunByBox(box.id, sid);
            try { B().addInventoryItem(live, name, st); } catch (e) { Sleepy.toast(String(e.message || e), 'err'); return; }
            persistRun(live); refreshStay();
          });
          row.appendChild(btn);
        });
        panel.appendChild(row);
      } else {
        panel.appendChild(h('p', 'yp-empty', '老板不能替 TA 用东西——发道具走局印。'));
      }
    }

    if (kind === 'observe') {
      panel.appendChild(h('h3', null, '观测窗'));
      [['异常度', (run.anomaly || 0) + ' / 100'], ['任务进度', (run.progress || 0) + '%'],
       ['已走轮数', String((run.logs || []).length)], ['身份', identityName(run.identity)]]
        .forEach(function (p) {
          var s = h('div', 'yp-stat');
          s.appendChild(h('span', null, p[0]));
          s.appendChild(h('b', null, p[1]));
          panel.appendChild(s);
        });
      panel.appendChild(h('div', 'yr-eyebrow', '最近判定'));
      var vs = (run.logs || []).filter(function (l) { return l.verdictText; }).slice(-3);
      if (!vs.length) panel.appendChild(h('p', 'yp-empty', '还没有判定记录。'));
      vs.forEach(function (l) {
        panel.appendChild(h('p', 'yp-empty', '第 ' + l.n + ' 轮：' + (l.verdictText || '').split('\n').join(' · ')));
      });
    }

    if (kind === 'seal') {
      panel.appendChild(h('h3', null, '局印 · 干预传话'));
      panel.appendChild(h('p', 'yp-empty', '传话不单独惊动世界：写好盖印，并入下一轮注入，不计异常度。'));
      var ta = document.createElement('textarea');
      ta.className = 'yp-input';
      ta.rows = 2;
      ta.placeholder = run.identity === 'boss-join'
        ? '以老板的暗手给局里递一句话……'
        : '给 TA 递一句话、一个提醒、一件道具……';
      panel.appendChild(ta);
      var stamp = h('button', 'yp-send', '盖 下 传 话');
      stamp.addEventListener('click', function () {
        var text = ta.value.trim();
        if (!text) { Sleepy.toast('先写传话内容。'); return; }
        var live = B().getRunByBox(box.id, sid);
        B().addIntervention(live, text);
        persistRun(live);
        Sleepy.toast('已盖印。传话并进下一轮。');
        refreshStay();
      });
      panel.appendChild(stamp);
      var pend = B().pendingInterventions(run);
      if (pend.length) {
        panel.appendChild(h('div', 'yr-eyebrow', '待送出的传话'));
        pend.forEach(function (i) {
          var el = h('div', 'yp-item');
          el.appendChild(h('span', null, i.text));
          var tear = h('button', 'yp-sub', '撕掉');
          tear.style.cssText = 'width:auto;margin:0;padding:0 4px';
          tear.addEventListener('click', function () {
            var live = B().getRunByBox(box.id, sid);
            live.interventions = (live.interventions || []).filter(function (x) { return x.id !== i.id; });
            persistRun(live); refreshStay();
          });
          el.appendChild(tear);
          panel.appendChild(el);
        });
      }
    }

    var close = h('button', 'yp-close', '收起');
    close.addEventListener('click', refresh);
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) refresh(); });
    ctx.body.appendChild(sheet);
  }

  /* ------------------------------ 结算封档 ------------------------------ */

  function openSettle(ctx, sid, box) {
    var run = B().getRunByBox(box.id, sid);
    if (!run) { render(ctx); return; }
    var scores = B().settleScores(run);
    var sheet = h('div', 'yp-sheet');
    var panel = h('div', 'yp-panel');
    panel.appendChild(h('h3', null, '结算封档'));
    panel.appendChild(h('p', 'yp-score',
      '完成度 ' + scores.completion + '% · 规则遵守 ' + scores.compliance +
      '\n能量点：基础 30 × 完成度 + 实物折算 = ' + scores.energy +
      '\n（分数由状态机按记录算，模型只写叙述，不许现编数）'));
    panel.appendChild(h('p', 'yp-empty', '封档后这局不再可玩，档案盒变「已结案」。'));

    function settleBtn(label, fn) {
      var b = h('button', 'yp-send', label);
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = '……';
        fn();
      });
      panel.appendChild(b);
      return b;
    }

    settleBtn('请一段结算叙述（一次调用）', function () {
      var settings = getSettings(sid);
      /* v221：导入世界的委托来自档案盒；结算四样口径（方案 v1.2）——
         委托者真愿望满意度 / 世界受益 / char 满意度 / 完成度。 */
      var isTxt = box.source === 'txt';
      var goal = isTxt ? ((box.commission || {}).text || '') : B().DRILL_BRIEF.publicGoal;
      var messages = [
        { role: 'system', content: '你是「以身入局」的叙事者。任务刚结束，写一段结算叙述。' +
          (isTxt ? '这是导入世界：委托者站在世界之外收卷 —— 叙述要覆盖四样：' +
            '委托者的真愿望满足了多少（可以比委托做得更好，那是加分）、这些改变对世界本身是福是祸、' +
            '局内角色（char）自己的感受、以及一句完成度包装。' : '委托者的评价、局内角色的感想、一句评级包装。') +
          '只写叙述，不写判定块，不许编造数字。' },
        { role: 'user', content: '【任务档案】\n明面目标: ' + goal +
          '\n完成度: ' + scores.completion + '%  异常度: ' + (run.anomaly || 0) +
          (isTxt && (run.divergences || []).length
            ? '\n已发生的改变:\n' + run.divergences.map(function (d) { return '- 关于' + d.about + '：' + d.change; }).join('\n')
            : '') +
          '\n共 ' + (run.logs || []).length + ' 轮，老板传话 ' + (run.interventions || []).length + ' 条。\n篇幅 ' + (B().WORDS[settings.words] || B().WORDS.standard) + '。' }
      ];
      callModel(settings, messages, function (text) {
        B().finishRun(box.id, String(text || '').trim());
        Sleepy.toast('已封档，档案盒盖上「已结案」。');
        render(ctx);
      }, function (err) {
        sheet.remove();
        Sleepy.toast('结算叙述没写成：' + ((err && err.error) || '还没有可用的模型连接') + '，可改用直接封档。', 'err');
        openSettle(ctx, sid, box);
      });
    });

    settleBtn('不写叙述，直接封档', function () {
      B().finishRun(box.id, null);
      Sleepy.toast('已封档，档案盒盖上「已结案」。');
      render(ctx);
    });

    var close = h('button', 'yp-close', '先不结');
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    ctx.body.appendChild(sheet);
  }

  function renderSettled(ctx, last) {
    ctx.setTitle('入世 · 已结案');
    var s = last.settlement && last.settlement.scores || {};
    var root = h('div', 'yp-root');
    var log = h('div', 'yp-log');
    log.appendChild(h('div', 'yr-eyebrow', '本局已结案'));
    log.appendChild(h('p', 'yp-score',
      '完成度 ' + (s.completion || 0) + '% · 规则遵守 ' + (s.compliance || 0) +
      ' · 入账 ' + (s.energy || 0) + ' 能量点'));
    if (last.settlement && last.settlement.narrative) {
      log.appendChild(h('div', 'yp-entry-text', last.settlement.narrative));
    } else {
      log.appendChild(h('p', 'yp-empty', '这局没写结算叙述（直接封档）。'));
    }
    log.appendChild(h('p', 'yp-empty', '回档案架看「已结案」的盒子吧。'));
    root.appendChild(log);
    ctx.body.appendChild(root);
  }

  /* ------------------------------ 自动档（前端循环，离开页面即停） ------------------------------ */

  function startAuto(ctx, box, n) {
    var token = { stop: false };
    auto = { running: true, token: token, boxId: box.id, left: n };
    render(ctx);
    function halt(msg) {
      auto = { running: false, token: null, boxId: null, left: 0 };
      busy = false;
      if (msg) Sleepy.toast(msg);
      render(ctx);
    }
    function step() {
      if (token.stop) return halt(null);
      if (auto.left <= 0) return halt('自动档走完 ' + n + ' 轮，停。');
      if (!ctx.body.offsetParent) return halt(null);   /* 离开页面即停（可见性看 offsetParent） */
      var live = B().getRunByBox(box.id, box.sandboxId);
      if (!live) return halt(null);
      if ((live.anomaly || 0) >= 60) return halt('异常度到红线，自动档刹车等老板。');
      if ((live.progress || 0) >= 100) return halt('委托达成，自动档停下等结算。');
      auto.left--;
      round(ctx, box, live, null,
        function () { render(ctx); setTimeout(step, 0); },
        function () { halt(null); });
    }
    step();
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
    var messages = B().buildBookMessages(run, box, B().worldFor(box, run), settings, input);
    var world = B().worldFor(box, run);

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
      /* 本轮注入里带上的传话：成功后标记已用，日志条带局印批注（§六-3） */
      var sealTexts = B().pendingInterventions(live).map(function (i) { return i.text; });
      var entry = B().applyVerdict(live, v, input);
      /* v221 导入世界：改动账本 + NPC 当前态 + 章节推进（进度程序按章算） */
      if (live.world && live.world.indexOf('txt:') === 0) {
        B().applyTxtVerdict(live, v, box);
        var w2 = B().worldFor(box, live);
        live.chapter = w2.chapter;
      }
      if (sealTexts.length) {
        entry.sealNote = sealTexts.join('；');
        B().consumeInterventions(live);
      }
      live.world = live.world || 'drill';
      if (!(live.world && live.world.indexOf('txt:') === 0)) live.chapter = world.chapter;
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
    callModel(getSettings(sid), messages, done, fail);
  }

  /* 单发通道：app 指定连接 > feature 'book' 分配；一轮=一次 fetch，无扇出。
     结算叙述共用此通道（也是单次调用）。 */
  function callModel(settings, messages, done, fail) {
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
