/* ============================================================
   page-yr-board.js — 「以身入局」· 领局牌与建档（P0 第二刀）

   从档案架大厅点可进入的档案盒进来。流程：
   ① 定 b 层身份（老板纯看/老板亲自参与/员工）——盒子定过就锁死显示；
   ② 领局牌：环形选 c 层占位身份（演练世界内置三枚）；
   ③ 建档确认：世界卡 + 委托卡（演练世界内置数据）→ 开局；
   ④ 开局成功：运行记录落库（bookRuns），档案盒变「进行中」。

   身份口径：**每个世界定一次就锁死**（book-core.startRun 写死
   box.identity），大厅默认身份只影响还没定的新世界。

   游玩页（入世轮 + 判定 A）是下一刀——本页开局后如实说明。
   依赖：book-core.js（Sleepy.book）、page-yishenruju.js（Sleepy.yrRing
   与 .yr-* 样式——本页只能从大厅进入，样式必已注入）。
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

  /* 重点标签：酒红强调（2026-10-11 用户：纸面上重点处要用别的颜色） */
  function keyLine(label, val) {
    var p = h('p');
    p.appendChild(h('b', 'yb-key', label + '：'));
    p.appendChild(document.createTextNode(val));
    return p;
  }

  /* ------------------------------ 样式（本页特有 .yb-） ------------------------------ */
  var STYLE_ID = 'yr-board-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.yb-card{border:1px solid var(--wj-line);background:rgba(255,255,255,.03);border-radius:8px;padding:12px 14px;margin-top:10px}',
      '.yb-card b{font-family:var(--ff-serif);font-weight:500;font-size:14.5px;color:var(--wj-text);display:block;margin-bottom:5px}',
      '.yb-key{color:var(--wj-wine);font-weight:500}',
      '.yb-card p{margin:0 0 6px;font-size:11.5px;line-height:1.75;color:var(--wj-dim)}',
      '.yb-card p:last-child{margin-bottom:0}',
      '.yb-tag{display:inline-block;margin-right:6px;padding:1px 6px;border:1px solid rgba(138,95,107,.6);border-radius:2px;',
      'font-size:8.5px;letter-spacing:.2em;color:var(--wj-wine-lite);transform:rotate(-2deg)}',
      '.yb-locked{border-color:rgba(138,95,107,.6)}',
      '.yb-step{margin:16px 2px 8px}',
      '.yb-open{display:block;width:100%;margin-top:14px;padding:12px;border:1px solid rgba(236,230,218,.4);border-radius:6px;',
      'background:rgba(255,255,255,.05);color:var(--wj-text);font-family:var(--ff-serif);font-size:14px;letter-spacing:.22em;cursor:pointer}',
      '.yb-open:active{background:rgba(255,255,255,.1)}',
      '.yb-back{display:block;width:100%;margin-top:8px;padding:10px;border:1px dashed var(--wj-line);border-radius:8px;',
      'background:transparent;color:var(--wj-dim);font-size:11.5px;cursor:pointer}',
      '.yb-kv{display:flex;justify-content:space-between;font-size:11.5px;line-height:2;color:var(--wj-dim)}',
      '.yb-kv b{color:var(--wj-text);font-weight:500}',
      '.yb-cover{display:block;width:100%;max-height:150px;object-fit:cover;border-radius:6px;border:1px solid var(--wj-line);margin-top:8px}',
      '.yb-cover-acts{display:flex;gap:8px;margin-top:8px}',
      '.yb-cover-acts .yb-back{margin-top:0;flex:1;width:auto;min-width:0}',
      /* ---- 2026-10-10 三步拆独立页：进度点 + 步间导航 + 多张场景 ---- */
      '.yb-dots{display:flex;gap:6px;margin:10px 2px 2px;flex-wrap:wrap}',
      '.yb-dot{font-size:9.5px;letter-spacing:.12em;color:var(--wj-dimmer);padding:3px 9px;border:1px solid var(--wj-line);border-radius:999px}',
      '.yb-dot.on{background:#1c1a17;color:#f4f0e7;border-color:#1c1a17}',
      '.yb-dot.done{color:var(--wj-text)}',
      '.yb-nav{display:flex;gap:8px;margin-top:14px}',
      /* ⚠️ width:auto 必须带上：.yb-back 基础是 width:100%，进 flex 行后
         不缩（shrink:0）→ 占满整行把旁边的钮挤出屏幕右缘（2026-10-11
         真机抓到：右下角「边缘框」= 被挤出的 yb-open 左边框）。 */
      '.yb-nav .yb-back{margin-top:0;flex:0 0 auto;width:auto;padding:12px 16px}',
      '.yb-nav .yb-open{margin-top:0;flex:1;width:auto;min-width:0}',
      '.yb-scenes{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:8px}',
      '.yb-scene{position:relative;border:1px solid var(--wj-line);border-radius:6px;overflow:hidden}',
      '.yb-scene .yb-cover{margin-top:0;border:0;border-radius:0;width:100%;height:96px;object-fit:cover;display:block}',
      '.yb-scene-n{position:absolute;left:6px;bottom:6px;font-size:9px;letter-spacing:.1em;color:#f4f0e7;background:rgba(28,26,23,.72);padding:2px 7px;border-radius:3px}',
      '.yb-scene-del{position:absolute;right:6px;top:6px;border:0;background:rgba(28,26,23,.72);color:#f4f0e7;font-size:9px;padding:3px 7px;border-radius:3px;cursor:pointer;font-family:inherit}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ------------------------------ 演练世界内置数据 ------------------------------ */

  var DRILL_SEATS = [
    { glyph: '旅', name: '借宿的旅人', sub: '知情：镇上公开传闻、旅店往来', code: 'NO.01 · 旅',
      desc: '占位身份。世界只当你是个过路的，打听公开的事不算惹眼。' },
    { glyph: '帮', name: '新来的帮工', sub: '知情：铺子日用、街坊口角', code: 'NO.02 · 帮',
      desc: '占位身份。有正当理由在各家走动，但被人使唤也是真的。' },
    { glyph: '查', name: '外来的调查员', sub: '知情：公开案卷、街面见闻', code: 'NO.03 · 查',
      desc: '占位身份。问话名正言顺，但你问得越深，别人越会问你。' }
  ];


  function identityName(key) {
    var hit = B().IDENTITIES.filter(function (x) { return x.key === key; })[0];
    return hit ? hit.name : key;
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderRunCard(ctx, sid, box, run) {
    var wrap = h('div');
    wrap.appendChild(h('div', 'yr-eyebrow', '本局已开'));
    var c = h('div', 'yb-card yb-locked');
    c.appendChild(h('b', null, box.title + ' · 进行中'));
    c.appendChild(h('div', 'yb-kv', [h('span', null, '局内身份'), h('b', null, identityName(run.identity))]));
    c.appendChild(h('div', 'yb-kv', [h('span', null, '占位身份'), h('b', null, run.seat ? run.seat.name : '—')]));
    c.appendChild(h('div', 'yb-kv', [h('span', null, '开局时间'), h('b', null, (run.startedAt || '').replace('T', ' ').slice(0, 16))]));
    wrap.appendChild(c);
    wrap.appendChild(h('p', 'yr-motto',
      '进世界吧：每走一步，对白、心理与判定都会写进这局的卷宗。'));
    var back = h('button', 'yb-back', '← 回档案架');
    back.addEventListener('click', function () { Sleepy.nav.open('yishenruju', { sandboxId: sid }); });
    wrap.appendChild(back);
    /* 开局后直进世界（游玩页在 page-yr-play.js） */
    var go = h('button', 'yb-open', '进 入 世 界');
    go.addEventListener('click', function () {
      Sleepy.nav.open('yr-play', { boxId: box.id, sandboxId: sid });
    });
    wrap.appendChild(go);
    return wrap;
  }

  /* 换个委托者重提（方案 v1.2）：不重读全书 —— 用存档里的起始章节选，
     一通小调用只重出 suggest，写回 box.summary.suggest。 */
  function reSuggest(box, sid, onDone) {
    var name = window.prompt('换谁来当委托者？（写书里的人物名，留空 = 让档案员自己再挑）', '');
    if (name === null) return;
    var imp = B().getImport(box.importId, sid);
    var startText = '';
    if (imp && imp.chapters) {
      var hit = imp.chapters.filter(function (c) { return c.title === (box.commission || {}).startChapter; })[0];
      startText = ((hit || imp.chapters[0] || {}).text || '').slice(0, 5000);
    }
    Sleepy.toast('档案员回去翻档案了…');
    var messages = [
      { role: 'system', content: '你是穿书局的档案员。只输出一个 JSON 对象：' +
        '{"suggest":{"requester":"委托者名字","publicGoal":"明面目标一句话","hiddenGoal":"TA的真愿望一句话","restriction":"一条限制","why":"为什么是TA，30字内"}}。不要输出别的。' },
      { role: 'user', content: '【书】' + box.title + '\n【开头节选】\n' + startText +
        (name ? '\n【指定委托者】' + name : '\n【要求】重新挑一个委托者，换一个角度。') }
    ];
    Sleepy.api.runChat(messages, {
      onDone: function (_, text) {
        var parsed = null;
        try { parsed = Sleepy.phoneAI ? Sleepy.phoneAI.parseSettlementJson(text) : null; } catch (e) {}
        if (parsed && parsed.suggest) {
          var sum = box.summary || {};
          sum.suggest = parsed.suggest;
          B().patchBox(box.id, { summary: sum }, sid);
          Sleepy.toast('新建议提出来了。', 'ok');
          onDone();
        } else {
          Sleepy.toast('这次没提出来，稍后再试。', 'warn');
        }
      },
      onFail: function () { Sleepy.toast('档案员暂时离席（模型没连上）。', 'err'); }
    }, false, { feature: 'book' });
  }

  function render(ctx) {
    var sid = (ctx.params && ctx.params.sandboxId) || (Sleepy.core.activeSandbox() || {}).id || null;    var boxId = ctx.params && ctx.params.boxId;
    ctx.setTitle('领局牌');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
    if (Sleepy.yrHomeStyle) Sleepy.yrHomeStyle();   /* 纸面撞色皮（yishenruju 同一份） */
    ctx.rebuild = function () { render(ctx); };
    if (!sid || !boxId) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '从档案架的档案盒进来才有局可领。'));
      return;
    }
    B().lockSandbox(sid);

    var box = B().getBox(boxId, sid);
    if (!box) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '档案盒不见了，回档案架再看一眼。'));
      return;
    }

    var root = h('div', 'yr-root');
    var room = h('div', 'yr-room');
    room.appendChild(h('div', 'yr-top', h('div', 'yr-brand', [h('span', 'yr-mark'), h('span', null, box.title)])));

    var existing = B().getRunByBox(boxId, sid);
    /* 演练盒重走三步（2026-10-11 用户：演练每次点都从领局牌开始，
       不吃「本局已开」锁卡）——正式世界维持已开即进。 */
    if (existing && box.source !== 'drill') {
      room.appendChild(renderRunCard(ctx, sid, box, existing));
      root.appendChild(room);
      ctx.body.appendChild(root);
      return;
    }

    /* 分步状态（2026-10-10 用户反馈：三个步骤分开，一屏一步，照建群的走法） */
    var st = { step: 1, identity: box.identity || B().getIdentity(sid) || null, seat: null };
    var body = h('div');
    room.appendChild(body);

    /* 步骤进度点：三步的钉子，一眼看清走到哪了 */
    function stepDots() {
      var d = h('div', 'yb-dots');
      ['局内身份', '领局牌', '委托与场景'].forEach(function (t, i) {
        var n = i + 1;
        d.appendChild(h('span', 'yb-dot' + (st.step === n ? ' on' : (st.step > n ? ' done' : '')),
          st.step > n ? '✓ ' + t : (st.step === n ? n + ' · ' + t : t)));
      });
      return d;
    }

    function navBtns(nextLabel, nextRun, canNext) {
      var bar = h('div', 'yb-nav');
      var prev = h('button', 'yb-back', st.step > 1 ? '← 上一步' : '← 回档案架');
      prev.addEventListener('click', function () {
        if (st.step > 1) { st.step--; renderStep(); }
        else Sleepy.nav.open('yishenruju', { sandboxId: sid });
      });
      bar.appendChild(prev);
      var next = h('button', 'yb-open', nextLabel);
      next.disabled = !canNext;
      next.addEventListener('click', nextRun);
      bar.appendChild(next);
      return bar;
    }

    function stepBadge(n, text) {
      var d = h('div', 'yb-step');
      d.appendChild(h('div', 'yr-eyebrow', '第 ' + n + ' 步 · ' + text));
      return d;
    }

    function identityCard() {
      var c = h('div', 'yb-card' + (box.identity ? ' yb-locked' : ''));
      c.appendChild(h('b', null, identityName(st.identity)));
      c.appendChild(h('p', null, box.identity
        ? '这个世界建档时已定死身份，不可再改。'
        : '只是这个世界的局内身份，定死不影响别的世界。'));
      return c;
    }

    /* 场景图（可选、可多张）：photos.pick 通道（手机相册/file input）→ media 落盘。
       2026-10-10 用户反馈：故事是发展的，场景不止一张 —— box.sceneRefs 按顺序存，
       封面永远同步成第一张（book-core.setScenes）。 */
    function sceneCard() {
      var card = h('div', 'yb-card');
      card.appendChild(h('b', null, '本书场景图（可多张）'));
      var list = h('div', 'yb-scenes');
      (function renderScenes() {
        list.innerHTML = '';
        var refs = box.sceneRefs || (box.coverRef ? [box.coverRef] : []);
        if (!refs.length) {
          list.appendChild(h('p', 'yb-cover-empty', '还没贴。贴几张当这本书的门面和地点（可选）。'));
        }
        refs.forEach(function (mid, i) {
          var item = h('div', 'yb-scene');
          var img = h('img', 'yb-cover');
          img.alt = '场景 ' + (i + 1);
          Sleepy.media.url(mid).then(function (u) { img.src = u; }, function () {});
          item.appendChild(img);
          var lab = h('span', 'yb-scene-n', i === 0 ? '封面 · 场景 1' : '场景 ' + (i + 1));
          item.appendChild(lab);
          var tear = h('button', 'yb-scene-del', '撕掉');
          tear.type = 'button';
          tear.addEventListener('click', function () {
            var next = refs.filter(function (x) { return x !== mid; });
            box = B().setScenes(boxId, next, sid);
            Sleepy.toast('撕掉了。');
            renderScenes();
          });
          item.appendChild(tear);
          list.appendChild(item);
        });
      })();
      card.appendChild(list);
      var acts = h('div', 'yb-cover-acts');
      var pick = h('button', 'yb-back', '+ 从相册加一张');
      pick.addEventListener('click', function () {
        Sleepy.photos.pick({ multiple: true, title: '选场景图' }).then(function (recs) {
          if (!recs || !recs.length) return;
          var refs = (box.sceneRefs || (box.coverRef ? [box.coverRef] : []))
            .concat(recs.map(function (r) { return r.mediaId; }));
          box = B().setScenes(boxId, refs, sid);
          Sleepy.toast('场景贴好了，现在共 ' + refs.length + ' 张。');
          renderScenes();
        });
      });
      acts.appendChild(pick);
      card.appendChild(acts);
      return card;
    }

    function renderStep() {
      body.innerHTML = '';
      body.appendChild(stepDots());

      /* ① 局内身份 —— 一屏一步 */
      if (st.step === 1) {
        body.appendChild(stepBadge(1, '局内身份'));
        body.appendChild(identityCard());
        /* 演练盒重走三步（v229）：即使已刻过身份也出环 —— 换一枚=重开一局；
           正式世界保持「定了就不出环」。 */
        if (!box.identity || box.source === 'drill') {
          body.appendChild(Sleepy.yrRing({
            cards: B().IDENTITIES.map(function (it) {
              var g = { 'boss-watch': '观', 'boss-join': '随', 'staff': '行' }[it.key] || '局';
              var code = { 'boss-watch': 'NO.01 · 观局', 'boss-join': 'NO.02 · 入局', 'staff': 'NO.03 · 当值' }[it.key] || '';
              var sub = it.key === 'staff' ? '局印认老板，不认你' : '局印特权';
              return { glyph: g, name: it.name, sub: sub, code: code, desc: it.desc };
            }),
            startIndex: st.identity ? B().IDENTITIES.map(function (x) { return x.key; }).indexOf(st.identity) : 0,
            takeText: '定这一枚',
            onTake: function (i) {
              st.identity = B().IDENTITIES[i].key;
              Sleepy.toast('这个世界就认它了：' + B().IDENTITIES[i].name);
              st.step = 2;   /* 2026-10-11 用户：选定后直接进下一步页面 */
              renderStep();
            }
          }));
        }
        body.appendChild(navBtns('下一步 · 领局牌', function () {
          st.step = 2; renderStep();
        }, !!st.identity));
        if (!st.identity) {
          body.appendChild(h('p', 'yr-motto', '先在环上定一枚局内身份，才能往下一步走。'));
        }
        return;
      }

      /* ② 领局牌（c 层占位身份）—— 一屏一步 */
      if (st.step === 2) {
        body.appendChild(stepBadge(2, '领局牌 · 穿书占位'));
        body.appendChild(Sleepy.yrRing({
          cards: DRILL_SEATS.map(function (s) {
            return { top: '以身入局 · 穿书占位', glyph: s.glyph, name: s.name, sub: s.sub, code: s.code, desc: s.desc };
          }),
          startIndex: st.seat ? DRILL_SEATS.indexOf(st.seat) : 0,
          takeText: '领这枚牌',
          onTake: function (i) {
            st.seat = DRILL_SEATS[i];
            Sleepy.toast('领牌：' + st.seat.name);
            st.step = 3;   /* 选定后直接进下一步页面 */
            renderStep();
          }
        }));
        body.appendChild(navBtns('下一步 · 委托与场景', function () {
          st.step = 3; renderStep();
        }, !!st.seat));
        if (!st.seat) {
          body.appendChild(h('p', 'yr-motto', '领一枚穿书占位的局牌，才知道你在这本书里以什么脸走路。'));
        }
        return;
      }

      /* ③ 委托与场景 —— 一屏一步 */
      body.appendChild(stepBadge(3, '委托与场景'));
      body.appendChild(sceneCard());

      if (box.source === 'txt') {
        /* ★ v221 导入世界的委托卡 + 建议卡（方案 v1.2：AI 提案，user 拍板）。
           委托者站局外：单子开局前定死，局中不改口。 */
        var tc = h('div', 'yb-card');
        tc.appendChild(h('b', null, '本次委托'));
        tc.appendChild(h('p', null, (box.commission && box.commission.text) || '（没写 —— 建议下面这张卡，或回导入页重导。）'));
        if (box.commission && box.commission.roleNote) {
          tc.appendChild(h('p', null, 'char 的角色：' + box.commission.roleNote));
        }
        tc.appendChild(h('p', null, '从「' + (box.commission && box.commission.startChapter || '起始章') + '」开始走。委托者站世界之外，局中无人知情。'));
        body.appendChild(tc);

        var sug = box.summary && box.summary.suggest;
        if (sug && sug.requester) {
          var sc = h('div', 'yb-card');
          sc.appendChild(h('span', 'yb-tag', '档案员建议'));
          sc.appendChild(h('b', null, '委托者：' + sug.requester));
          sc.appendChild(h('p', null, '明面目标：' + (sug.publicGoal || '')));
          sc.appendChild(h('p', null, 'TA 的真愿望：' + (sug.hiddenGoal || '')));
          if (sug.restriction) sc.appendChild(h('p', null, '限制：' + sug.restriction));
          if (sug.why) sc.appendChild(h('p', null, '为什么是 TA：' + sug.why));
          var acts = h('div', 'yb-cover-acts');
          var adopt = h('button', 'yb-back', '采用这条委托');
          adopt.addEventListener('click', function () {
            box = B().patchBox(boxId, { commission: {
              text: sug.publicGoal || (box.commission && box.commission.text) || '',
              requester: sug.requester,
              hiddenGoal: sug.hiddenGoal || '',
              restriction: sug.restriction || '',
              roleNote: (box.commission && box.commission.roleNote) || '',
              startChapter: (box.commission && box.commission.startChapter) || ''
            } }, sid);
            Sleepy.toast('采用建议卡：委托者 ' + sug.requester + '。');
            render(ctx);
          });
          acts.appendChild(adopt);
          var red = h('button', 'yb-back', '换个委托者重提');
          red.addEventListener('click', function () {
            reSuggest(box, sid, render);
          });
          acts.appendChild(red);
          sc.appendChild(acts);
          body.appendChild(sc);
        }
      } else {
        var w = h('div', 'yb-card');
        w.appendChild(h('b', null, box.title));
        w.appendChild(h('p', null, '局内演练 · 档案编号 ' + box.id.slice(-6).toUpperCase()));
        w.appendChild(keyLine('委托者', B().DRILL_BRIEF.requester + '。' + B().DRILL_BRIEF.requesterSecret));
        w.appendChild(keyLine('明面目标', B().DRILL_BRIEF.publicGoal));
        w.appendChild(keyLine('暗线', B().DRILL_BRIEF.hiddenGoal));
        w.appendChild(keyLine('限制', B().DRILL_BRIEF.restriction + '　报酬：' + B().DRILL_BRIEF.reward));
        w.appendChild(h('span', 'yb-tag', '局内演练'));
        body.appendChild(w);
      }

      var summary = h('div', 'yb-card');
      summary.appendChild(h('div', 'yb-kv', [h('span', null, '局内身份'), h('b', null, st.identity ? identityName(st.identity) : '还没定')]));
      summary.appendChild(h('div', 'yb-kv', [h('span', null, '穿书占位'), h('b', null, st.seat ? st.seat.name : '还没领牌')]));
      body.appendChild(summary);

      var open = h('button', 'yb-open', '开 局');
      open.addEventListener('click', function () {
        if (!st.identity) { Sleepy.toast('先把第 1 步的局内身份定了。', 'err'); return; }
        if (!st.seat) { Sleepy.toast('先在第 2 步领一枚穿书占位的局牌。', 'err'); return; }
        var r = B().startRun(boxId, st.identity, st.seat);
        Sleepy.toast(r.existed ? '这局早开着了，接着走。' : '局开了。卷宗从这一刻开始记。');
        /* 开局即进世界，不再回到领局牌第一步（2026-10-11 用户：点开局又回第一步） */
        Sleepy.nav.open('yr-play', { boxId: box.id, sandboxId: sid });
      });
      body.appendChild(open);

      var back = h('button', 'yb-back', '← 回档案架');
      back.addEventListener('click', function () { Sleepy.nav.open('yishenruju', { sandboxId: sid }); });
      body.appendChild(back);
    }

    renderStep();
    root.appendChild(room);
    ctx.body.appendChild(root);
  }

  Sleepy.register('yr-board', {
    title: '领局牌',
    render: render,
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ============================================================
     TXT 导入（需求清单 §十 · 第一版）：user 导入自己的书 → 编码
     （UTF-8 / GB18030 可切 + 预览）→ 按章节标题切分（无标题按长度兜底）
     → 章节名可改 → 选起始章 → 手动填委托 + char 扮演角色 →
     一次轻量 AI 预读（简介/主要人物/关键地点，失败不阻塞）→ 上架成
     可进的档案盒。原始文本与章节落 bookImports（book-core）。
     第一版不做整本自动分析（§十 白纸黑字）；入世游玩接导入世界是下一批。
     ============================================================ */

  var IMP_STYLE_ID = 'yr-import-style';
  function ensureImpStyle() {
    if (document.getElementById(IMP_STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = IMP_STYLE_ID;
    st.textContent = [
      '.yi-sec{margin:14px 2px 0}',
      '.yi-card{border:1px solid var(--wj-line);background:rgba(255,255,255,.6);border-radius:8px;padding:12px 14px;margin-top:8px}',
      '.yi-card p{margin:0 0 6px;font-size:11.5px;line-height:1.75;color:var(--wj-dim)}',
      '.yi-card input,.yi-card textarea{width:100%;box-sizing:border-box;border:1px solid var(--wj-line);border-radius:6px;',
      'background:#fff;color:#2b2620;padding:8px 10px;font-size:13px;font-family:inherit;margin-top:6px}',
      '.yi-card textarea{min-height:64px;resize:vertical}',
      '.yi-enc{display:flex;gap:8px;margin-top:8px}',
      '.yi-enc button{flex:1;padding:8px;border:1px solid var(--wj-line);border-radius:6px;background:transparent;',
      'color:var(--wj-dim);font-size:12px;cursor:pointer;font-family:inherit}',
      '.yi-enc button.on{background:#1c1a17;color:#f4f0e7;border-color:#1c1a17}',
      '.yi-preview{margin:8px 0 0;padding:9px 10px;background:#faf7f0;border:1px dashed var(--wj-line);border-radius:6px;',
      'font-size:11.5px;line-height:1.7;color:#49453e;white-space:pre-wrap;max-height:150px;overflow-y:auto}',
      '.yi-warn{margin-top:6px;font-size:11px;color:var(--wj-wine)}',
      '.yi-chs{max-height:230px;overflow-y:auto;margin-top:8px;border:1px solid var(--wj-line);border-radius:6px;background:#fff}',
      '.yi-ch{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--wj-line-soft);font-size:12px;color:#2b2620}',
      '.yi-ch:last-child{border-bottom:0}',
      '.yi-ch b{flex:0 0 auto;width:16px;height:16px;border:1px solid var(--wj-line);border-radius:50%;display:grid;place-items:center;font-size:9px;color:transparent;cursor:pointer}',
      '.yi-ch.start b{background:#a63b32;border-color:#a63b32;color:#f4f0e7}',
      '.yi-ch span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.yi-ch input{flex:1;border:1px solid var(--wj-line);border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit}',
      '.yi-ch small{color:var(--wj-dimmer);flex:0 0 auto;font-size:9px}',
      '.yi-ch button{border:0;background:none;color:var(--wj-green);font-size:10px;cursor:pointer;font-family:inherit;flex:0 0 auto}',
      '.yi-btn{display:block;width:100%;margin-top:12px;padding:12px;border:1px solid #1c1a17;border-radius:6px;',
      'background:rgba(255,255,255,.08);color:#2b2620;font-family:var(--ff-serif);font-size:14px;letter-spacing:.22em;cursor:pointer}',
      '.yi-btn:active{background:rgba(28,26,23,.12)}',
      '.yi-btn[disabled]{opacity:.45;pointer-events:none}'
    ].join('');
    document.head.appendChild(st);
  }

  /* 章节切分：优先「第X章/回/卷/节」标题行；切不出两章就按长度兜底。 */
  function splitChapters(text) {
    var RE = /^[ \t]*(第[零一二三四五六七八九十百千万两0-9]{1,8}[章回卷节][^\n]{0,30})[ \t]*$/gm;
    var marks = [], m;
    while ((m = RE.exec(text)) !== null) marks.push({ title: m[1].trim(), at: m.index });
    var out = [];
    if (marks.length >= 2) {
      marks.forEach(function (mk, i) {
        var end = i + 1 < marks.length ? marks[i + 1].at : text.length;
        var body = text.slice(mk.at + mk.title.length, end).trim();
        if (body) out.push({ title: mk.title, text: body });
      });
      /* 序章/楔子这类标题前的散段并进第一章，别弄丢 */
      if (marks[0].at > 400) {
        out.unshift({ title: '开头', text: text.slice(0, marks[0].at).trim() });
      }
      return out;
    }
    /* 无章节标题：按段落边界切 ~1800 字一段 */
    var paras = text.split(/\n\s*\n/);
    var buf = [], n = 1;
    paras.forEach(function (p) {
      buf.push(p);
      if (buf.join('\n\n').length >= 1800) {
        out.push({ title: '片段 ' + n++, text: buf.join('\n\n').trim() });
        buf = [];
      }
    });
    if (buf.join('').trim()) out.push({ title: '片段 ' + n, text: buf.join('\n\n').trim() });
    return out;
  }

  function renderImport(ctx) {
    var sid = (ctx.params && ctx.params.sandboxId) || (Sleepy.core.activeSandbox() || {}).id || null;
    ctx.setTitle('导入 TXT');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
    ensureImpStyle();
    if (Sleepy.yrHomeStyle) Sleepy.yrHomeStyle();
    ctx.rebuild = function () { renderImport(ctx); };
    if (!sid) {
      ctx.body.appendChild(h('p', 'ph-entry-lead', '先进入一座岛，局里才有地方放新档案。'));
      return;
    }
    B().lockSandbox(sid);

    var st = { file: null, encoding: 'utf-8', text: '', chapters: [], startIdx: 0 };
    var root = h('div', 'yr-root');
    var room = h('div', 'yr-room');
    room.appendChild(h('div', 'yr-top', h('div', 'yr-brand', [h('span', 'yr-mark'), h('span', null, '导入一本书')])));
    var body = h('div');
    room.appendChild(body);
    root.appendChild(room);
    ctx.body.appendChild(root);

    var warnEl = h('p', 'yi-warn', '');
    function warn(t) { warnEl.textContent = t || ''; }

    function chapterList() {
      var box = h('div', 'yi-card');
      box.appendChild(h('b', null, '第 2 步 · 章节切分（' + st.chapters.length + ' 章）'));
      box.appendChild(h('p', null, '点「改」改章节名；点前面的圆点选**故事从哪一章开始**。'));
      if (!st.chapters.length) {
        box.appendChild(h('p', null, '还没切出来 —— 先选文件。'));
        return box;
      }
      var list = h('div', 'yi-chs');
      st.chapters.forEach(function (ch, i) {
        var row = h('div', 'yi-ch' + (i === st.startIdx ? ' start' : ''));
        var dot = h('b', null, '✓');
        dot.title = '从这里开始';
        dot.addEventListener('click', function () {
          st.startIdx = i; renderChapters();
        });
        row.appendChild(dot);
        var titleEl = h('span', null, ch.title);
        row.appendChild(titleEl);
        row.appendChild(h('small', null, Math.ceil(ch.text.length / 100) / 10 + 'k'));
        var ren = h('button', null, '改');
        ren.type = 'button';
        ren.addEventListener('click', function () {
          var inp = h('input');
          inp.value = ch.title;
          titleEl.replaceWith(inp);
          inp.focus();
          function save() {
            ch.title = (inp.value || ch.title).trim().slice(0, 30) || ch.title;
            renderChapters();
          }
          inp.addEventListener('blur', save);
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
        });
        row.appendChild(ren);
        list.appendChild(row);
      });
      box.appendChild(list);
      return box;
    }

    function renderChapters() {
      var old = body.querySelector('.yi-step2');
      if (old) old.remove();
      var sec = h('div', 'yi-sec yi-step2');
      sec.appendChild(h('div', 'yr-eyebrow', '切章'));
      sec.appendChild(chapterList());
      var anchor = body.querySelector('.yi-step3');
      anchor ? body.insertBefore(sec, anchor) : body.appendChild(sec);
    }

    function infoCard() {
      var box = h('div', 'yi-card');
      box.appendChild(h('b', null, '第 3 步 · 委托与角色'));
      box.appendChild(h('p', null, '世界名不给就取文件名；委托和扮演角色现在手填，局里的档案员会照着读这本书。'));
      var title = h('input');
      title.placeholder = '世界名（默认用文件名）';
      title.value = st.file ? st.file.name.replace(/\.txt$/i, '').slice(0, 40) : '';
      var commission = h('textarea');
      commission.placeholder = '本次委托：要让 char 在这本书里做什么？（例如：查清第 3 章那场火是谁放的）';
      var role = h('input');
      role.placeholder = 'char 要扮演谁（可空 = 局里按剧情安排一个过路人）';
      box.appendChild(title); box.appendChild(commission); box.appendChild(role);
      box.__fields = function () {
        return {
          title: (title.value || '').trim(),
          commission: (commission.value || '').trim(),
          role: (role.value || '').trim()
        };
      };
      return box;
    }

    var info = null, importBtn = null;

    function afterText() {
      /* 乱码检查（§十：发现乱码允许切换编码） */
      var bad = (st.text.match(/\uFFFD/g) || []).length;
      if (st.text.length > 3000000) {
        warn('这本书超过 300 万字，手机存不下整本 —— 建议先切成几份再导。');
      } else if (bad > st.text.length * 0.005) {
        warn('读出来像是乱码（' + bad + ' 个坏字），试试切到 GB18030 再读一遍。');
      } else {
        warn('');
      }
      st.chapters = splitChapters(st.text);
      st.startIdx = 0;
      if (info) { info.remove(); info = null; }
      if (importBtn) { importBtn.remove(); importBtn = null; }
      renderChapters();
      if (!st.chapters.length) return;
      info = infoCard();
      info.className = 'yi-card yi-step3';
      var sec3 = h('div', 'yi-sec yi-step3');
      sec3.appendChild(h('div', 'yr-eyebrow', '委托'));
      sec3.appendChild(info);
      body.appendChild(sec3);
      importBtn = h('button', 'yi-btn', '交给档案员预读，然后上架');
      importBtn.addEventListener('click', function () { doImport(); });
      body.appendChild(importBtn);
    }

    function readFile() {
      if (!st.file) return;
      var fr = new FileReader();
      fr.onload = function () {
        st.text = String(fr.result || '');
        preview.style.display = '';
        preview.textContent = st.text.slice(0, 400) + (st.text.length > 400 ? '…' : '');
        afterText();
      };
      fr.onerror = function () { warn('这个文件读不出来，换一个试试。'); };
      fr.readAsText(st.file, st.encoding === 'gb18030' ? 'gb18030' : 'utf-8');
    }

  /* 一次轻量 AI 预读（方案 v1.2）：读起始章节选 + 委托，产出
     { brief, npcs:[{name,role,fact}], places, nodes:[{at,event,mutable}], suggest }。
     这是「剧情地图 + NPC 档案 + 委托建议卡」的原料；失败不拦上架。 */
  function aiPreflight(fields, startText, cb) {
    var messages = [
      { role: 'system', content: '你是穿书局的档案员。根据书的开头节选和委托，只输出一个 JSON 对象：' +
        '{"brief":"60字以内的世界简介",' +
        '"npcs":[{"name":"人物名","role":"身份","fact":"原作里TA的既定事实，40字内"}]（最多6个），'+
        '"places":["关键地点，最多3个"],' +
        '"nodes":[{"at":"第X章","event":"关键事件一句话","mutable":true|false}]（原作主线关键节点，最多8个；用户和char进来就是要改变这些，mutable标出哪些是原作铁定不变的骨架），' +
        '"suggest":{"requester":"从人物里挑一个最适合当委托者的名字","publicGoal":"明面目标一句话","hiddenGoal":"TA的真愿望一句话","restriction":"一条限制","why":"为什么是TA，30字内"}}。不要输出别的。' },
      { role: 'user', content: '【书名】' + (fields.title || '未知') +
        '\n【开头节选】\n' + startText +
        '\n【本次委托】' + (fields.commission || '未填 —— 请按书的内容给一个建议。') }
    ];
    Sleepy.api.runChat(messages, {
      onDone: function (_, text) {
        var parsed = null;
        try { parsed = Sleepy.phoneAI ? Sleepy.phoneAI.parseSettlementJson(text) : null; } catch (e) {}
        cb(parsed);
      },
      onFail: function () { cb(null); }
    }, false, { feature: 'book' });
  }

    function doImport() {
      var fields = info.__fields();
      if (!st.chapters.length) { Sleepy.toast('章节还没切出来。', 'err'); return; }
      if (!fields.commission) { Sleepy.toast('委托总得写一句 —— 要 char 在这本书里做什么。', 'err'); return; }
      importBtn.disabled = true;
      importBtn.textContent = '档案员正在预读…';
      var startText = (st.chapters[st.startIdx].text || '').slice(0, 7000);
      aiPreflight(fields, startText, function (sum) {
        var rec = {
          id: 'bi-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          sandboxId: sid,
          fileName: st.file ? st.file.name : '',
          encoding: st.encoding,
          chapterCount: st.chapters.length,
          startChapter: st.chapters[st.startIdx].title,
          chapters: st.chapters,           /* 全文按章存（bookImports，随岛走） */
          createdAt: new Date().toISOString()
        };
        B().putImport(rec);
        var npcNames = sum && sum.npcs ? sum.npcs.map(function (n) {
          return typeof n === 'string' ? n : n.name;
        }) : [];
        var note = sum && sum.brief
          ? sum.brief + (npcNames.length ? '（' + npcNames.slice(0, 3).join('、') + '）' : '')
          : '还没预读出来。进世界后可让档案员再读一遍。';
        var box = B().createBoxFromImport(sid, {
          title: fields.title || (st.file ? st.file.name.replace(/\.txt$/i, '') : '未命名世界'),
          note: note,
          importId: rec.id,
          commission: { text: fields.commission, roleNote: fields.role, startChapter: rec.startChapter },
          summary: sum || null
        });
        Sleepy.toast(sum ? '档案建好了：《' + box.title + '》上架。' :
          '预读没成（不拦上架），档案建好了：《' + box.title + '》。',
          sum ? 'ok' : 'warn');
        Sleepy.nav.open('yishenruju', { sandboxId: sid });
      });
    }

    /* 第 1 步：选文件 + 编码 */
    var sec1 = h('div', 'yi-sec');
    sec1.appendChild(h('div', 'yr-eyebrow', '第 1 步 · 选文件'));
    var card1 = h('div', 'yi-card');
    card1.appendChild(h('p', null, '选一个 .txt 文件。默认按 UTF-8 读；读出乱码就切 GB18030，切换会整本重读。'));
    var enc = h('div', 'yi-enc');
    [['utf-8', 'UTF-8'], ['gb18030', 'GB18030']].forEach(function (p) {
      var b = h('button', st.encoding === p[0] ? 'on' : '', p[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        st.encoding = p[0];
        [...enc.children].forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        if (st.file) readFile();
      });
      enc.appendChild(b);
    });
    card1.appendChild(enc);
    var pickBtn = h('button', 'yi-btn', '+ 选择 TXT 文件');
    pickBtn.type = 'button';
    pickBtn.addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,text/plain';
      input.addEventListener('change', function () {
        var f = (input.files || [])[0];
        if (!f) return;
        st.file = f;
        pickBtn.textContent = '已选：' + f.name.slice(0, 24) + '（重新选）';
        readFile();
      });
      input.click();
    });
    card1.appendChild(pickBtn);
    var preview = h('div', 'yi-preview', '（选完文件这里给开头预览）');
    preview.style.display = 'none';
    card1.appendChild(preview);
    card1.appendChild(warnEl);
    sec1.appendChild(card1);
    body.appendChild(sec1);

    /* readFile 里已经把预览刷出来了 —— 这里不留死代码 */

    var back = h('button', 'yb-back', '← 回档案架');
    back.style.marginTop = '12px';
    back.addEventListener('click', function () { Sleepy.nav.open('yishenruju', { sandboxId: sid }); });
    body.appendChild(back);
  }

  Sleepy.register('yr-import', {
    title: '导入 TXT',
    render: renderImport,
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });
})(window);
