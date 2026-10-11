/* ============================================================
   page-repo.js — 仓库 App（P0，方案-设定仓库-v1）

   三个板块：货架（按门牌看） / 我的（打包发布+下载记录+服务地址） /
   门牌（输入/粘贴识别/链接复制）。
   P0 件类型：角色卡、整岛包；盲盒锁、其余类型 P1。
   依赖：repo-core.js（Sleepy.repo）。数据是设备级，不进岛章。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var R = null;              /* 惰性取 repo-core */
  function RP() { return R || (R = Sleepy.repo); }

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

  /* ------------------------------ 样式 ------------------------------ */
  var STYLE_ID = 'repo-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      /* 底部 tab 布局（2026-10-10 用户点名）：壳头保留，内容滚，tab 钉底 */
      '.page[data-page="repo"]{overflow:hidden;}',
      '.page[data-page="repo"] .page-inner{height:100%;display:flex;flex-direction:column;}',
      '.page[data-page="repo"] .app-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',
      '.rp-root{flex:1;min-height:0;display:flex;flex-direction:column;font-size:13px;color:#2b2620;}',
      '.rp-main{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 20px;-webkit-overflow-scrolling:touch;}',
      '.rp-nav{flex:0 0 auto;display:flex;justify-content:space-around;align-items:center;',
      'border-top:1px solid rgba(43,38,32,.14);background:rgba(250,247,240,.97);',
      'padding:8px 12px calc(8px + env(safe-area-inset-bottom));}',
      '.rp-nav button{border:0;background:none;color:#948b7d;font-size:11px;min-width:56px;padding:5px 0;cursor:pointer;font-family:inherit;}',
      '.rp-nav button.on{color:#1c1a17;font-weight:700;}',
      '.rp-tabs{display:none}',

      '.rp-card{border:1px solid rgba(43,38,32,.16);background:rgba(255,255,255,.66);border-radius:10px;padding:12px 13px;margin-top:10px}',
      '.rp-card b{font-size:13.5px;display:block;margin-bottom:4px}',
      '.rp-card p{margin:2px 0 0;font-size:11.5px;line-height:1.65;color:#6f675c}',
      '.rp-row{display:flex;gap:8px;align-items:center;margin-top:8px}',
      '.rp-row input,.rp-card input,.rp-card select{flex:1;border:1px solid rgba(43,38,32,.2);border-radius:6px;',
      'background:#fff;color:#2b2620;padding:8px 10px;font-size:12.5px;font-family:inherit;min-width:0}',
      '.rp-btn{border:0;border-radius:7px;background:#1c1a17;color:#f4f0e7;font-size:12px;',
      'padding:9px 16px;cursor:pointer;font-family:inherit}',
      '.rp-btn.ghost{background:none;color:#6f675c;border:1px solid rgba(43,38,32,.24)}',
      '.rp-btn[disabled]{opacity:.45;pointer-events:none}',
      '.rp-item{display:flex;gap:10px;align-items:center;padding:11px 2px;border-bottom:1px solid rgba(43,38,32,.1);cursor:pointer}',
      '.rp-item:last-child{border-bottom:0}',
      '.rp-av{width:38px;height:38px;flex:0 0 auto;border-radius:9px;border:1px solid rgba(43,38,32,.2);',
      'display:grid;place-items:center;background:#efe9db;font-family:Georgia,serif;font-weight:700;overflow:hidden}',
      '.rp-av img{width:100%;height:100%;object-fit:cover}',
      '.rp-item-m{flex:1;min-width:0}',
      '.rp-item-m b{font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rp-item-m small{color:#948b7d;font-size:10.5px}',
      '.rp-tag{flex:0 0 auto;font-size:9px;letter-spacing:.1em;border:1px solid rgba(43,38,32,.24);border-radius:3px;padding:2px 6px;color:#6f675c}',
      '.rp-hint{font-size:11px;color:#948b7d;line-height:1.7;margin:8px 0 0}',
      '.rp-link{color:#315d68;text-decoration:underline;word-break:break-all;cursor:pointer}',
      '.rp-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(43,38,32,.24);border-radius:999px;',
      'padding:4px 12px;font-size:11px;color:#2b2620;background:none;cursor:pointer;font-family:inherit}',
      '.rp-chip.on{background:#1c1a17;color:#f4f0e7;border-color:#1c1a17}',
      '.rp-check{display:flex;gap:9px;align-items:flex-start;padding:9px 2px;border-bottom:1px dashed rgba(43,38,32,.12)}',
      '.rp-check input{width:15px;height:15px;flex:0 0 auto;margin-top:2px}',
      '.rp-check span{flex:1;font-size:12px;line-height:1.6}',
      '.rp-sheet{position:fixed;inset:0;z-index:80;background:rgba(28,26,23,.5);display:flex;align-items:flex-end;justify-content:center}',
      '.rp-panel{width:100%;max-height:78%;overflow-y:auto;background:#faf7f0;border-radius:16px 16px 0 0;padding:16px 18px calc(16px + env(safe-area-inset-bottom));box-sizing:border-box}',
      '.rp-panel h3{margin:0 0 8px;font-size:15px;font-family:inherit}',
      '.rp-empty{text-align:center;color:#948b7d;padding:26px 0;font-size:12px}',
      /* 「我」板块：资料卡 + 头衔墙 */
      '.rp-me-head{display:flex;gap:13px;align-items:center;padding:4px 2px;}',
      '.rp-me-head .rp-av{width:56px;height:56px;border-radius:14px;font-size:20px;}',
      '.rp-me-name{font-size:16px;font-weight:700;}',
      '.rp-me-sub{font-size:10.5px;color:#948b7d;margin-top:3px;}',
      '.rp-title{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(28,26,23,.35);',
      'border-radius:999px;padding:4px 12px;font-size:11px;color:#2b2620;background:rgba(255,255,255,.7);margin:0 6px 6px 0;}',
      '.rp-title i{width:7px;height:7px;border-radius:50%;background:#a63b32;flex:0 0 auto;}',
      '.rp-title.dim{border-style:dashed;color:#b0a89a;background:none;}',
      '.rp-title.dim i{background:#cfc8ba;}'
    ].join('');
    document.head.appendChild(st);
  }

  var TYPE_LABEL = { island: '整岛包', char: '角色卡', worldbook: '世界书',
    preset: '预设', book: '以身入局', theme: '美化' };

  /* ------------------------------ 页面 ------------------------------ */

  var state = { tab: 'shelf', gate: '', shelfItems: null };
  var TABS = [['shelf', '货架'], ['mine', '我的'], ['gate', '门牌'], ['me', '我']];

  function render(ctx) {
    ctx.setTitle('仓库');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
    ctx.rebuild = function () { render(ctx); };
    /* 深链：链接带 ?g= 码打开 → 门牌页自动填好待确认 */
    if (!state.__linkDone) {
      state.__linkDone = true;
      var m = String(global.location.search || '').match(/[?&]g=([A-Za-z0-9]{4,12})/);
      if (m) { state.tab = 'gate'; state.paste = m[1]; }
    }

    var root = h('div', 'rp-root');
    var main = h('div', 'rp-main');

    if (!RP().base()) {
      /* 服务地址烤在代码里（DEFAULT_BASE）—— 走到这说明还没部署 Worker */
      main.appendChild(h('p', 'rp-empty', '仓库服务还没开通 —— 等下一版更新就好。'));
    }
    if (state.tab === 'shelf') renderShelf(ctx, main);
    else if (state.tab === 'mine') renderMine(ctx, main);
    else if (state.tab === 'gate') renderGate(ctx, main);
    else renderMe(ctx, main);

    root.appendChild(main);
    var nav = h('div', 'rp-nav');
    TABS.forEach(function (t) {
      var b = h('button', state.tab === t[0] ? 'on' : '', t[1]);
      b.type = 'button';
      b.addEventListener('click', function () { state.tab = t[0]; render(ctx); });
      nav.appendChild(b);
    });
    root.appendChild(nav);

    ctx.body.appendChild(root);
  }

  /* ---------------- 货架 ---------------- */

  function renderShelf(ctx, root) {
    var gates = RP().gates();
    if (!gates.length) {
      root.appendChild(h('p', 'rp-hint', '还没有进任何货架 —— 先去「门牌」用口令或链接进圈。'));
      return;
    }
    if (!state.gate || gates.indexOf(state.gate) < 0) state.gate = gates[gates.length - 1];
    var chips = h('div', 'rp-row');
    gates.forEach(function (g) {
      var c = h('button', 'rp-chip' + (state.gate === g ? ' on' : ''),
        RP().gateName(g) || g);
      c.type = 'button';
      c.addEventListener('click', function () { state.gate = g; state.shelfItems = null; render(ctx); });
      chips.appendChild(c);
    });
    root.appendChild(chips);
    root.appendChild(h('p', 'rp-hint', (RP().gateName(state.gate) || state.gate) + ' · 点一件下载并导入'));

    if (state.shelfItems) {
      paintItems(ctx, root, state.shelfItems);
      return;
    }
    var loading = h('p', 'rp-hint', '货架上货中…');
    root.appendChild(loading);
    RP().shelf(state.gate, function (r) {
      loading.remove();
      if (!r.ok) { root.appendChild(h('p', 'rp-hint', r.message || '货架没打开')); return; }
      state.shelfItems = r.items || [];
      paintItems(ctx, root, state.shelfItems);
    });
  }

  function paintItems(ctx, root, items) {
    if (!items.length) {
      root.appendChild(h('p', 'rp-empty', '这个货架还空着。'));
      return;
    }
    var card = h('div', 'rp-card');
    items.forEach(function (it) {
      var el = h('div', 'rp-item');
      var av = h('div', 'rp-av', (it.title || '?').charAt(0));
      el.appendChild(av);
      var m = h('div', 'rp-item-m');
      m.appendChild(h('b', null, it.title || '未命名'));
      m.appendChild(h('small', null, (it.author || '无名作者') + ' · ' +
        (TYPE_LABEL[it.type] || it.type) + ' · 领取 ' + (it.downloads || 0)));
      el.appendChild(m);
      el.appendChild(h('span', 'rp-tag', it.lock === 'blind' ? '盲盒' : TYPE_LABEL[it.type] || ''));
      el.addEventListener('click', function () { openItem(ctx, it); });
      card.appendChild(el);
    });
    root.appendChild(card);
  }

  function openItem(ctx, it) {
    var sheet = h('div', 'rp-sheet');
    var panel = h('div', 'rp-panel');
    panel.appendChild(h('h3', null, it.title || '未命名'));
    panel.appendChild(h('p', 'rp-hint', (it.author || '无名作者') + ' · ' +
      (TYPE_LABEL[it.type] || it.type) + ' · v' + (it.version || 1) +
      (it.lock === 'blind' ? ' · 盲盒（原文不可见，可游玩）' : '')));
    var msg = h('p', 'rp-hint', '下载后会按类型导入：角色卡进当前岛，整岛包生成一座新岛（可勾美化/世界书带不带）。');
    panel.appendChild(msg);
    var btn = h('button', 'rp-btn', '领取并导入');
    btn.type = 'button';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = '打包下载中…';
      RP().downloadItem(it.id, state.gate, function (r) {
        if (!r.ok) { msg.textContent = r.message; btn.disabled = false; btn.textContent = '领取并导入'; return; }
        sheet.remove();
        openImportWizard(ctx, r.manifest);
      });
    });
    panel.appendChild(btn);
    var close = h('button', 'rp-btn ghost', '先看看别的');
    close.type = 'button';
    close.style.marginLeft = '8px';
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    ctx.body.appendChild(sheet);
  }

  /* ---------------- 导入向导 ---------------- */

  function openImportWizard(ctx, manifest) {
    var sheet = h('div', 'rp-sheet');
    var panel = h('div', 'rp-panel');
    panel.appendChild(h('h3', null, '导入：' + (manifest.title || '未命名')));
    var counts = {};
    manifest.items.forEach(function (it) { counts[it.kind] = (counts[it.kind] || 0) + 1; });
    panel.appendChild(h('p', 'rp-hint', Object.keys(counts).map(function (k) {
      return (TYPE_LABEL[k] || k) + ' ×' + counts[k];
    }).join(' · ')));

    var choices = { theme: 'mine', worldbook: 'mine' };

    if (manifest.type === 'island') {
      panel.appendChild(h('p', 'rp-hint',
        '这座岛会作为一座**新岛**落进浮岛列表：角色和以身入局档案全部带入；' +
        '聊天记录、朋友圈、照片、马甲、API 配置一律不进包。'));
      [['worldbook', '世界书'], ['theme', '美化（主题/壁纸）']].forEach(function (p) {
        var row = h('div', 'rp-row');
        row.appendChild(h('span', null, p[1] + '：'));
        var sel = h('select');
        [['mine', '用我现在的'], ['pack', '带包里的']].forEach(function (o) {
          var op = h('option', null, o[1]); op.value = o[0];
          if (choices[p[0]] === o[0]) op.selected = true;
          sel.appendChild(op);
        });
        sel.addEventListener('change', function () { choices[p[0]] = sel.value; });
        row.appendChild(sel);
        panel.appendChild(row);
      });
    }

    var go = h('button', 'rp-btn', '开始导入');
    go.type = 'button';
    go.style.marginTop = '12px';
    go.addEventListener('click', function () {
      go.disabled = true; go.textContent = '导入中…';
      if (manifest.type === 'char') {
        RP().importChar(manifest, function (r) {
          go.disabled = false; go.textContent = '开始导入';
          Sleepy.toast(r.message || (r.ok ? '导好了' : '没导上'), r.ok ? 'ok' : 'err');
          if (r.ok) { sheet.remove(); render(ctx); }
        });
      } else {
        RP().importIsland(manifest, choices, function (r) {
          go.disabled = false; go.textContent = '开始导入';
          Sleepy.toast(r.message || (r.ok ? '导好了' : '没导上'), r.ok ? 'ok' : 'err');
          if (r.ok) { sheet.remove(); render(ctx); }
        });
      }
    });
    panel.appendChild(go);
    var close = h('button', 'rp-btn ghost', '先不导');
    close.type = 'button';
    close.style.marginLeft = '8px';
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    ctx.body.appendChild(sheet);
  }

  /* ---------------- 我的 ---------------- */

  function renderMine(ctx, root) {
    var pub = h('button', 'rp-btn', '＋ 打包发布（从当前岛挑件）');
    pub.type = 'button';
    pub.style.width = '100%';
    pub.addEventListener('click', function () { openPublish(ctx); });
    root.appendChild(pub);

    var mine = RP().mine();
    var c1 = h('div', 'rp-card');
    c1.appendChild(h('b', null, '我上架的'));
    if (!mine.length) c1.appendChild(h('p', null, '还没有上架的件。'));
    mine.slice().reverse().forEach(function (m) {
      var el = h('div', 'rp-item');
      el.appendChild(h('div', 'rp-item-m', [
        h('b', null, m.title), h('small', null, (TYPE_LABEL[m.type] || m.type) + ' · ' + m.id)]));
      var off = h('button', 'rp-btn ghost', '下架');
      off.type = 'button';
      off.addEventListener('click', function () {
        RP().unpublish(m.id, function (r) {
          Sleepy.toast(r.ok ? '下架了' : (r.message || '没下成'), r.ok ? 'ok' : 'err');
          if (r.ok) render(ctx);
        });
      });
      el.appendChild(off);
      c1.appendChild(el);
    });
    root.appendChild(c1);

    var dls = RP().downloads();
    var c2 = h('div', 'rp-card');
    c2.appendChild(h('b', null, '我领取的'));
    if (!dls.length) c2.appendChild(h('p', null, '还没领取过。'));
    dls.slice().reverse().slice(0, 20).forEach(function (d) {
      var el = h('div', 'rp-item');
      el.appendChild(h('div', 'rp-item-m', [
        h('b', null, d.manifest.title || '未命名'),
        h('small', null, (TYPE_LABEL[d.manifest.type] || d.manifest.type) + ' · 已导入')]));
      var again = h('button', 'rp-btn ghost', '重新导入');
      again.type = 'button';
      again.addEventListener('click', function () { openImportWizard(ctx, d.manifest); });
      el.appendChild(again);
      c2.appendChild(el);
    });
    root.appendChild(c2);
  }

  /* 打包发布向导：类型 → 选件 → 门牌/作者/头像URL → 发布 */
  function openPublish(ctx) {
    var sid = (Sleepy.core.activeSandbox() || {}).id;
    if (!sid) { Sleepy.toast('先进一座岛，才有东西可打包'); return; }
    var sheet = h('div', 'rp-sheet');
    var panel = h('div', 'rp-panel');
    panel.appendChild(h('h3', null, '打包发布'));
    panel.appendChild(h('p', 'rp-hint',
      '照片/聊天记录/朋友圈/马甲/API 一律不进包；头像用 URL 填（留空 = 字母脸）。盲盒锁 P1 上，现在先公开件。'));

    var typeSel = h('select');
    [['island', '整岛包（这座岛能带走的都带上）'], ['char', '角色卡（单选一个）']].forEach(function (o) {
      var op = h('option', null, o[1]); op.value = o[0];
      typeSel.appendChild(op);
    });
    panel.appendChild(typeSel);

    var charRow = h('div', 'rp-row');
    var charSel = h('select');
    Sleepy.core.charsOfSandbox(sid).forEach(function (c) {
      var op = h('option', null, c.name || '未命名'); op.value = c.id;
      charSel.appendChild(op);
    });
    charRow.appendChild(charSel);
    charRow.style.display = 'none';
    panel.appendChild(charRow);
    typeSel.addEventListener('change', function () {
      charRow.style.display = typeSel.value === 'char' ? '' : 'none';
    });

    var titleIn = h('input'); titleIn.placeholder = '标题（默认取岛名/角色名）';
    var authorIn = h('input'); authorIn.placeholder = '署名（作者名）';
    authorIn.value = profile().name || '';
    var urlIn = h('input'); urlIn.placeholder = '头像 URL（可选）';
    urlIn.value = profile().avatarUrl || '';
    var gateIn = h('input'); gateIn.placeholder = '门牌码（发布挂到哪个货架）';
    gateIn.value = RP().gates()[0] || '';
    [titleIn, authorIn, urlIn, gateIn].forEach(function (i) {
      i.style.marginTop = '8px'; panel.appendChild(i);
    });

    var msg = h('p', 'rp-hint', '');
    var btn = h('button', 'rp-btn', '发布到货架');
    btn.type = 'button';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', function () {
      var gate = gateIn.value.trim();
      if (!gate) { msg.textContent = '先填门牌码（没有门牌就先去问圈主）。'; return; }
      btn.disabled = true; btn.textContent = '打包上传中…';
      var opts = { gate: gate, author: authorIn.value.trim(),
        avatarUrl: urlIn.value.trim(), title: titleIn.value.trim() };
      var manifest;
      try {
        manifest = typeSel.value === 'char'
          ? RP().packChar(charSel.value, opts)
          : RP().packIsland(sid, opts);
      } catch (e) {
        msg.textContent = String(e.message || e); btn.disabled = false;
        btn.textContent = '发布到货架'; return;
      }
      RP().publish(manifest, function (r) {
        btn.disabled = false; btn.textContent = '发布到货架';
        if (r.ok) {
          RP().recordMine({ id: r.id, title: manifest.title, type: manifest.type, at: Date.now() });
          msg.textContent = '上架成功：' + r.id + (r.authorToken ? '（作者令牌已存本机）' : '');
          Sleepy.toast('上架成功', 'ok');
          render(ctx);
        } else {
          msg.textContent = r.message || '没发上去';
        }
      });
    });
    panel.appendChild(btn);
    panel.appendChild(msg);

    var close = h('button', 'rp-btn ghost', '收起');
    close.type = 'button';
    close.style.marginTop = '8px';
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    ctx.body.appendChild(sheet);
  }

  /* ---------------- 门牌 ---------------- */

  function renderGate(ctx, root) {
    var c = h('div', 'rp-card');
    c.appendChild(h('b', null, '用门牌进货架'));
    c.appendChild(h('p', null, '口令或链接都行 —— 粘贴进来识别，或者手输口令。'));
    var row = h('div', 'rp-row');
    var inp = h('input');
    inp.placeholder = '口令 / 链接';
    inp.value = state.paste || '';
    state.paste = '';
    var paste = h('button', 'rp-btn ghost', '粘贴识别');
    paste.type = 'button';
    paste.addEventListener('click', function () {
      if (global.navigator.clipboard && global.navigator.clipboard.readText) {
        global.navigator.clipboard.readText().then(function (t) {
          inp.value = RP().parseGateText(t) || t || '';
        }, function () { Sleepy.toast('浏览器不给读剪贴板，手动粘进来吧', 'warn'); });
      } else {
        Sleepy.toast('这个环境不支持一键粘贴，手动粘吧', 'warn');
      }
    });
    var go = h('button', 'rp-btn', '进货架');
    go.type = 'button';
    go.addEventListener('click', function () {
      var code = RP().parseGateText(inp.value) || inp.value.trim();
      if (!code) { Sleepy.toast('先填口令或链接'); return; }
      RP().verifyGate(code, function (r) {
        if (!r.ok) { Sleepy.toast(r.message || '门牌不对', 'err'); return; }
        Sleepy.toast('进了「' + r.name + '」', 'ok');
        state.gate = code; state.tab = 'shelf'; state.shelfItems = null;
        render(ctx);
      });
    });
    row.appendChild(inp); row.appendChild(paste); row.appendChild(go);
    c.appendChild(row);
    root.appendChild(c);

    var gates = RP().gates();
    if (gates.length) {
      var c2 = h('div', 'rp-card');
      c2.appendChild(h('b', null, '我进过的货架'));
      gates.forEach(function (g) {
        var el = h('div', 'rp-item');
        el.appendChild(h('div', 'rp-item-m', [h('b', null, RP().gateName(g) || g), h('small', null, g)]));
        var share = h('button', 'rp-btn ghost', '复制链接');
        share.type = 'button';
        share.addEventListener('click', function () {
          var link = global.location.origin + global.location.pathname + '?g=' + encodeURIComponent(g);
          var text = '【睡岛货架】' + (RP().gateName(g) || g) + ' · 门牌 ' + g + ' · ' + link;
          if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
            global.navigator.clipboard.writeText(text).then(function () {
              Sleepy.toast('链接复制好了，甩群里吧', 'ok');
            }, function () { Sleepy.toast('复制没成，口令是 ' + g, 'warn'); });
          } else {
            Sleepy.toast('口令是 ' + g, 'warn');
          }
        });
        el.appendChild(share);
        c2.appendChild(el);
      });
      root.appendChild(c2);
    }
    root.appendChild(h('p', 'rp-hint',
      '链接长这样：' + (global.location.origin + global.location.pathname + '?g=口令') +
      ' —— 别人点开就能带着门牌进货架。'));
  }

  /* ---------------- 我（资料 + 头衔墙） ---------------- */

  function profile() { return RP().cfg().profile || {}; }
  function saveProfile(p) {
    var c = RP().cfg();
    c.profile = p;
    RP().setCfg(c);
  }

  /* 头衔（方案 §八）：系统头衔从本地数据推导（只升不降）；
     甜度系头衔 P1 上服务端后点亮。 */
  function myTitles() {
    var out = [];
    if (RP().mine().length) out.push({ name: '开炉掌柜', desc: '第一件上架' });
    if (RP().downloads().length) out.push({ name: '尝过一口', desc: '第一次领取' });
    return out;
  }
  var LOCKED_TITLES = [
    { name: '小甜豆', desc: '甜度 5（P1 试吃解锁）' },
    { name: '甜品常客', desc: '甜度 15（P1）' },
    { name: '头号试吃官', desc: '第一份 repo（P1）' },
    { name: '从不放鸽子', desc: 'repo 全按时交（P1）' },
    { name: '回头客最爱', desc: '收到 10 份 repo（创作者，P1）' }
  ];

  function renderMe(ctx, root) {
    var p = profile();
    var head = h('div', 'rp-card');
    var hh = h('div', 'rp-me-head');
    var av = h('div', 'rp-av');
    if (p.avatarUrl) {
      var img = h('img'); img.alt = '';
      img.src = p.avatarUrl;
      img.addEventListener('error', function () { img.remove(); });
      av.appendChild(img);
    } else {
      av.appendChild(document.createTextNode((p.name || '我').charAt(0)));
    }
    hh.appendChild(av);
    var hb = h('div');
    hb.appendChild(h('div', 'rp-me-name', p.name || '无名访客'));
    hb.appendChild(h('div', 'rp-me-sub', '这个身份只用于仓库署名和门牌分享卡'));
    hh.appendChild(hb);
    head.appendChild(hh);
    var row = h('div', 'rp-row');
    var nameIn = h('input'); nameIn.placeholder = '昵称'; nameIn.maxLength = 16; nameIn.value = p.name || '';
    row.appendChild(nameIn);
    head.appendChild(row);
    var row2 = h('div', 'rp-row');
    var urlIn = h('input'); urlIn.placeholder = '头像 URL（留空 = 字母脸）'; urlIn.value = p.avatarUrl || '';
    row2.appendChild(urlIn);
    head.appendChild(row2);
    var save = h('button', 'rp-btn', '保存资料');
    save.type = 'button';
    save.style.marginTop = '10px';
    save.addEventListener('click', function () {
      saveProfile({ name: nameIn.value.trim().slice(0, 16), avatarUrl: urlIn.value.trim() });
      Sleepy.toast('资料存好了', 'ok');
      render(ctx);
    });
    head.appendChild(save);
    root.appendChild(head);

    var tc = h('div', 'rp-card');
    tc.appendChild(h('b', null, '我的头衔'));
    var mine = myTitles();
    if (!mine.length) tc.appendChild(h('p', null, '还没有头衔 —— 上架第一件、领取第一件就会点亮。'));
    mine.forEach(function (t) {
      var el = h('span', 'rp-title');
      el.appendChild(h('i'));
      el.appendChild(document.createTextNode(t.name));
      el.title = t.desc;
      tc.appendChild(el);
    });
    LOCKED_TITLES.forEach(function (t) {
      var el = h('span', 'rp-title dim');
      el.appendChild(h('i'));
      el.appendChild(document.createTextNode(t.name));
      el.title = t.desc;
      tc.appendChild(el);
    });
    tc.appendChild(h('p', 'rp-hint',
      '虚线的是还没点亮的 —— 甜度系头衔等「试吃」批次（P1）接上服务端后自动点亮，只升不降。'));
    root.appendChild(tc);
  }

  Sleepy.register('repo', {
    title: '仓库',
    render: render,
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

})(window);
