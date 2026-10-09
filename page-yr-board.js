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

  /* ------------------------------ 样式（本页特有 .yb-） ------------------------------ */
  var STYLE_ID = 'yr-board-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.yb-card{border:1px solid var(--wj-line);background:rgba(255,255,255,.03);border-radius:8px;padding:12px 14px;margin-top:10px}',
      '.yb-card b{font-family:var(--ff-serif);font-weight:500;font-size:14.5px;color:var(--wj-text);display:block;margin-bottom:5px}',
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
      '.yb-cover-acts .yb-back{margin-top:0;flex:1}'
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

  var DRILL_BRIEF = {
    requester: '守灯人 陈婆',
    requesterSecret: '表面愿望是把邮包送上旧宅；真愿望是确认旧宅里还有人等她回信。',
    publicGoal: '三天内把邮包交到旧宅收信人手里。',
    hiddenGoal: '弄清楚陈婆为什么不敢亲自去。',
    restriction: '不得向世界角色透露「局」的存在。',
    reward: '基础 30 能量点（结算批次入账）'
  };

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
      '行动日志从下一刀开始记：每走一步，对白、心理与判定都会写进这局的卷宗。'));
    var back = h('button', 'yb-back', '← 回档案架');
    back.addEventListener('click', function () { Sleepy.nav.open('yishenruju', { sandboxId: sid }); });
    wrap.appendChild(back);
    return wrap;
  }

  function render(ctx) {
    var sid = (ctx.params && ctx.params.sandboxId) || (Sleepy.core.activeSandbox() || {}).id || null;
    var boxId = ctx.params && ctx.params.boxId;
    ctx.setTitle('领局牌');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
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
    if (existing) {
      room.appendChild(renderRunCard(ctx, sid, box, existing));
      root.appendChild(room);
      ctx.body.appendChild(root);
      return;
    }

    /* 分步状态 */
    var st = { step: 1, identity: box.identity || B().getIdentity(sid) || null, seat: null };
    var body = h('div');
    room.appendChild(body);

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

    function renderStep() {
      body.innerHTML = '';

      /* ① 局内身份 */
      body.appendChild(stepBadge(1, '局内身份'));
      body.appendChild(identityCard());
      if (!box.identity) {
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
            renderStep();
          }
        }));
      }

      /* ② 领局牌（c 层占位身份） */
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
          renderStep();
        }
      }));

      /* ③ 建档确认 */
      body.appendChild(stepBadge(3, '建档确认'));

      /* 场景图（可选）：photos.pick 通道（手机相册/file input）→ media 落盘 */
      var cover = h('div', 'yb-card');
      cover.appendChild(h('b', null, '本书场景图'));
      (function renderCover() {
        cover.querySelectorAll('.yb-cover,.yb-cover-acts,.yb-cover-empty').forEach(function (e) { e.remove(); });
        if (!box.coverRef) {
          var empty = h('p', 'yb-cover-empty', '还没贴。贴一张当这本书的门面（可选）。');
          empty.style.margin = '0';
          cover.appendChild(empty);
        } else {
          var img = h('img', 'yb-cover');
          img.alt = '本书场景图';
          Sleepy.media.url(box.coverRef).then(function (u) { img.src = u; }, function () {});
          cover.appendChild(img);
        }
        var acts = h('div', 'yb-cover-acts');
        var pick = h('button', 'yb-back', box.coverRef ? '换一张' : '+ 从相册选一张');
        pick.addEventListener('click', function () {
          Sleepy.photos.pick({ multiple: false, title: '选场景图' }).then(function (recs) {
            if (!recs || !recs.length) return;
            box = B().setCover(boxId, recs[0].mediaId, sid);
            Sleepy.toast('场景图贴好了。');
            renderCover();
          });
        });
        acts.appendChild(pick);
        if (box.coverRef) {
          var tear = h('button', 'yb-back', '撕掉');
          tear.addEventListener('click', function () {
            box = B().setCover(boxId, null, sid);
            renderCover();
          });
          acts.appendChild(tear);
        }
        cover.appendChild(acts);
      })();
      body.appendChild(cover);

      var w = h('div', 'yb-card');
      w.appendChild(h('b', null, box.title));
      w.appendChild(h('p', null, '局内演练 · 档案编号 ' + box.id.slice(-6).toUpperCase()));
      w.appendChild(h('p', null, '委托者：' + DRILL_BRIEF.requester + '。' + DRILL_BRIEF.requesterSecret));
      w.appendChild(h('p', null, '明面目标：' + DRILL_BRIEF.publicGoal));
      w.appendChild(h('p', null, '暗线：' + DRILL_BRIEF.hiddenGoal));
      w.appendChild(h('p', null, '限制：' + DRILL_BRIEF.restriction + ' 报酬：' + DRILL_BRIEF.reward));
      w.appendChild(h('span', 'yb-tag', '局内演练'));
      body.appendChild(w);

      var summary = h('div', 'yb-card');
      summary.appendChild(h('div', 'yb-kv', [h('span', null, '局内身份'), h('b', null, st.identity ? identityName(st.identity) : '还没定')]));
      summary.appendChild(h('div', 'yb-kv', [h('span', null, '穿书占位'), h('b', null, st.seat ? st.seat.name : '还没领牌')]));
      body.appendChild(summary);

      var open = h('button', 'yb-open', '开 局');
      open.addEventListener('click', function () {
        if (!st.identity) { Sleepy.toast('先把第 1 步的局内身份定了。', 'err'); return; }
        if (!st.seat) { Sleepy.toast('先在第 2 步领一枚穿书占位的局牌。', 'err'); return; }
        var r = B().startRun(boxId, st.identity, st.seat);
        Sleepy.toast(r.existed ? '这局早就开着呢，接着走。' : '局开了。卷宗从这一刻开始记。');
        render(ctx);
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
    render: render
  });
})(window);
