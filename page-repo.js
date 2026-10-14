/* ============================================================
   page-repo.js — 御膳房 App（原仓库；2026-10-11 改版）
   群声同构四页：repo 首页铺面 / repo-boards 板块 / repo-inbox 消息 /
   repo-me 我的（含暗铺门牌子视图）。壳头藏掉，各页自带报头/crumb，
   五位底栏（首页/板块/开炉/消息/我的）钉底。
   P0 件类型：角色卡、整岛包；明厨/暗铺条目级锁 P1。
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
      /* 御膳房页壳（2026-10-11 照群声口径）：通底报纸色、藏玻璃壳头
         （app 名不许每页都挂 —— 各页自带报刊报头）、关整页滚动，
         只有 .rp-main 滚，报头和底栏钉死。 */
      '.page[data-page^="repo"]{overflow:hidden;background:#f4f0e7;}',
      '.page[data-page^="repo"] .page-inner{height:100%;min-height:0;display:flex;flex-direction:column;',
      'background:#f4f0e7;padding:calc(env(safe-area-inset-top) + 10px) 0 0;}',
      '.page[data-page^="repo"] .app-head{display:none;}',
      '.page[data-page^="repo"] .app-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#f4f0e7;}',
      '.rp-root{--rp-ink:#25231f;--rp-muted:#756f65;--rp-line:#d8d0c2;--rp-red:#a63b32;--rp-blue:#315d68;',
      'flex:1;min-height:0;display:flex;flex-direction:column;font-size:14.5px;color:var(--rp-ink);}',
      '.rp-main{flex:1;min-height:0;overflow-y:auto;padding:14px 18px 22px;-webkit-overflow-scrolling:touch;}',
      /* 报头（群声 qs-top 同款）：utility 行 + 宋体大报名 */
      '.rp-top{padding:10px 18px 0;border-bottom:1px solid var(--rp-line);background:rgba(244,240,231,.96);flex:0 0 auto;}',
      '.rp-masthead{display:flex;align-items:center;gap:9px;padding:10px 0 9px;}',
      '.rp-backbtn{flex:0 0 auto;width:30px;height:30px;border:1px solid var(--rp-line);background:none;color:var(--rp-ink);',
      'border-radius:50%;font-size:18px;line-height:1;cursor:pointer;font-family:inherit;display:grid;place-items:center;}',
      '.rp-backbtn:active{background:rgba(37,35,31,.08);}',
      '.rp-name{flex:1;min-width:0;}',
      '.rp-masthead h1{margin:0;font-family:"Songti SC","STSong",serif;font-size:22px;line-height:1;font-weight:800;letter-spacing:.02em;}',
      '.rp-masthead p{margin:3px 0 0;font-size:10px;color:var(--rp-muted);letter-spacing:.18em;}',
      /* 右上角放大镜：素 icon 钮，无框 */
      '.rp-searchbtn{border:0;background:none;color:var(--rp-ink);padding:8px;cursor:pointer;border-radius:50%;}',
      '.rp-searchbtn:active{background:rgba(37,35,31,.08);}',
      '.rp-crumb{padding:12px 18px 10px;font-size:11px;color:var(--rp-muted);letter-spacing:.08em;',
      'border-bottom:1px solid var(--rp-line);background:rgba(244,240,231,.96);flex:0 0 auto;}',
      /* 底栏（群声 qs-nav 同款）：on=红，中央圆钮墨底字「开炉」 */
      '.rp-nav{flex:0 0 auto;display:flex;justify-content:space-around;align-items:center;',
      'border-top:1px solid var(--rp-line);background:rgba(247,243,235,.97);',
      'padding:9px 18px calc(9px + env(safe-area-inset-bottom));}',
      '.rp-nav button{border:0;background:none;color:var(--rp-muted);font-size:11px;min-width:58px;padding:6px 0;cursor:pointer;font-family:inherit;}',
      '.rp-nav button.on{color:var(--rp-red);font-weight:700;}',
      /* ⚠️ 必须写 .rp-nav .rp-fab：单写 .rp-fab 会被上面 .rp-nav button 的
         min-width:58px/padding 6px 0 以更高优先级盖掉，圆钮变扁条（踩过）。 */
      '.rp-nav .rp-fab{width:44px;height:44px;min-width:44px;border-radius:50%;',
      'background:#25231f;color:#faf7ef;font-size:11px;font-weight:800;line-height:1;',
      'padding:0;cursor:pointer;font-family:inherit;}',
      '.rp-nav .rp-fab:active{transform:scale(.94)}',

      '.rp-card{border:1px solid var(--rp-line);background:rgba(255,255,255,.66);border-radius:10px;padding:12px 13px;margin-top:10px}',
      '.rp-card b{font-size:15px;display:block;margin-bottom:4px}',
      '.rp-card p{margin:2px 0 0;font-size:13px;line-height:1.7;color:#6f675c}',
      '.rp-card button.rp-card{text-align:left;cursor:pointer;margin:10px 0 0;font-family:inherit;width:100%;}',
      '.rp-row{display:flex;gap:8px;align-items:center;margin-top:8px}',
      '.rp-row input,.rp-card input,.rp-card select,.rp-card textarea{flex:1;border:1px solid rgba(43,38,32,.2);border-radius:6px;',
      'background:#fff;color:#2b2620;padding:8px 10px;font-size:12.5px;font-family:inherit;min-width:0}',
      '.rp-btn{border:0;border-radius:7px;background:#25231f;color:#f4f0e7;font-size:13.5px;',
      'padding:9px 16px;cursor:pointer;font-family:inherit}',
      '.rp-btn.ghost{background:none;color:#6f675c;border:1px solid rgba(43,38,32,.24)}',
      '.rp-btn[disabled]{opacity:.45;pointer-events:none}',
      '.rp-item{display:flex;gap:10px;align-items:center;padding:11px 2px;border-bottom:1px solid var(--rp-line);cursor:pointer}',
      '.rp-item:last-child{border-bottom:0}',
      '.rp-av{width:38px;height:38px;flex:0 0 auto;border-radius:9px;border:1px solid rgba(43,38,32,.2);',
      'display:grid;place-items:center;background:#efe9db;font-family:Georgia,serif;font-weight:700;overflow:hidden}',
      '.rp-av img{width:100%;height:100%;object-fit:cover}',
      '.rp-item-m{flex:1;min-width:0}',
      '.rp-item-m b{font-size:14.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rp-item-m small{color:#948b7d;font-size:12px}',
      '.rp-tag{flex:0 0 auto;font-size:9px;letter-spacing:.1em;border:1px solid rgba(43,38,32,.24);border-radius:3px;padding:2px 6px;color:#6f675c}',
      '.rp-hint{font-size:12px;color:#948b7d;line-height:1.75;margin:8px 0 0}',
      '.rp-link{color:var(--rp-blue);text-decoration:underline;word-break:break-all;cursor:pointer}',
      '.rp-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(43,38,32,.24);border-radius:999px;',
      'padding:5px 14px;font-size:12.5px;color:#2b2620;background:none;cursor:pointer;font-family:inherit}',
      '.rp-chip.on{background:#25231f;color:#f4f0e7;border-color:#25231f}',
      '.rp-check{display:flex;gap:9px;align-items:flex-start;padding:9px 2px;border-bottom:1px dashed rgba(43,38,32,.12)}',
      '.rp-check input{width:15px;height:15px;flex:0 0 auto;margin-top:2px}',
      '.rp-check span{flex:1;font-size:12px;line-height:1.6}',
      /* 弹层（2026-10-11 用户约定：**所有 toast/弹层一律页面居中**，不贴底） */
      '.rp-sheet{position:fixed;inset:0;z-index:80;background:rgba(28,26,23,.5);display:flex;align-items:center;justify-content:center}',
      '.rp-panel{width:min(340px,88%);max-height:72%;overflow-y:auto;background:#faf7f0;border-radius:14px;padding:16px 18px;box-sizing:border-box;',
      'box-shadow:0 24px 60px rgba(43,38,32,.35);border:1px solid rgba(43,38,32,.3)}',
      '.rp-panel h3{margin:0 0 8px;font-size:15px;font-family:inherit}',
      '.rp-empty{text-align:center;color:#948b7d;padding:26px 0;font-size:12px}',
      /* 公共铺面：大封面网格卡（封面图上、信息下） */
      '.rp-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 12px;}',
      '.rp-covcard{border:0;background:none;padding:0;cursor:pointer;text-align:left;font-family:inherit;}',
      '.rp-covcard .rp-covimg{width:100%;aspect-ratio:3/4;border-radius:12px;overflow:hidden;position:relative;',
      'background:linear-gradient(165deg,#E9DCC6,#F7F2E8 52%,#D9E3D3);',
      'display:grid;place-items:center;font-family:Georgia,serif;font-weight:700;font-size:34px;color:rgba(43,38,32,.55);',
      'box-shadow:0 8px 20px rgba(43,38,32,.16);}',
      '.rp-covcard .rp-covimg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
      '.rp-covcard .rp-covtag{position:absolute;top:8px;left:8px;z-index:2;font-size:10px;letter-spacing:.08em;',
      'background:rgba(37,35,31,.82);color:#f4f0e7;border-radius:4px;padding:2px 7px;}',
      '.rp-covcard .rp-covtitle{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:18px 9px 7px;',
      'background:linear-gradient(180deg,transparent,rgba(28,26,23,.72));color:#f4f0e7;',
      'font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rp-covcard .rp-covinfo{margin-top:6px;font-size:11.5px;color:#6f675c;line-height:1.6;}',
      '.rp-covcard .rp-covinfo b{display:block;font-size:12.5px;color:#2b2620;font-weight:700;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      /* 公共铺面「层板」：每件骑在一层木板上 */
      '.rp-shelf{border:1px solid var(--rp-line);border-radius:10px;background:rgba(255,255,255,.5);padding:4px 13px;}',
      '.rp-shelf .rp-item{border-bottom:1px solid var(--rp-line);position:relative;}',
      '.rp-shelf .rp-item:after{content:"";position:absolute;left:-13px;right:-13px;bottom:-1px;height:7px;',
      'background:linear-gradient(180deg,#d9cdb2,#cbbd9f);border-radius:0 0 4px 4px;}',
      '.rp-shelf .rp-item:last-child:after{display:none;}',
      '.rp-demo-tag{flex:0 0 auto;font-size:9px;letter-spacing:.1em;border:1px dashed rgba(43,38,32,.4);',
      'border-radius:3px;padding:2px 6px;color:#948b7d;}',
      /* 开炉页：同学录式表单 */
      '.rp-field{display:block;margin-top:14px;}',
      '.rp-field>span{display:block;font-size:11px;color:#948b7d;letter-spacing:.08em;margin-bottom:2px;}',
      '.rp-field input,.rp-field select,.rp-field textarea{width:100%;box-sizing:border-box;border:0;',
      'border-bottom:1.5px solid rgba(43,38,32,.4);background:transparent;border-radius:0;',
      'color:#2b2620;padding:7px 2px;font-size:14px;font-family:inherit;outline:none;}',
      '.rp-field input:focus,.rp-field textarea:focus{border-bottom-color:#25231f;}',
      '.rp-field textarea{border:1.5px solid rgba(43,38,32,.4);border-radius:8px;padding:9px 10px;resize:vertical;}',
      '.rp-cover{width:64px;height:64px;flex:0 0 auto;border-radius:11px;border:1px solid rgba(43,38,32,.2);',
      'overflow:hidden;background:#efe9db;display:grid;place-items:center;font-family:Georgia,serif;',
      'font-weight:700;font-size:22px;}',
      '.rp-cover img{width:100%;height:100%;object-fit:cover;}',
      /* 板块目录（群声板块目录同款：大字号行距） */
      '.rp-board{display:flex;align-items:center;gap:12px;width:100%;padding:16px 4px;border:0;',
      'border-bottom:1px solid var(--rp-line);background:none;cursor:pointer;font-family:inherit;text-align:left}',
      '.rp-board b{font-family:"Songti SC","STSong",serif;font-size:17px;font-weight:800;color:var(--rp-ink);flex:0 0 auto;}',
      '.rp-board span{flex:1;font-size:11px;color:var(--rp-muted);}',
      '.rp-board i{color:var(--rp-muted);font-style:normal;flex:0 0 auto;}',
      /* 「我的」（2026-10-11 照群声 qs-me 装修）：大身份卡 + stats 行 + 红字分组 label */
      '.rp-me-head{display:flex;gap:13px;align-items:center;padding:18px 4px 14px;',
      'border-bottom:1px solid #25231f;background:#faf7ef;margin:0 -18px;padding-left:18px;padding-right:18px;}',
      '.rp-me-head .rp-av{width:52px;height:52px;border-radius:13px;font-size:19px;}',
      '.rp-me-name{font-size:16px;font-weight:800;}',
      '.rp-me-sub{font-size:10.5px;color:#948b7d;margin-top:3px;}',
      '.rp-me-edit{margin-left:auto;border:1px solid rgba(43,38,32,.3);background:none;border-radius:8px;',
      'color:#6f675c;font-size:10px;padding:7px 12px;cursor:pointer;font-family:inherit;flex:0 0 auto;}',
      '.rp-stats{display:flex;gap:26px;padding:12px 4px;border-bottom:1px solid var(--rp-line);font-size:10px;color:#948b7d;}',
      '.rp-stats b{display:block;font-size:17px;color:#25231f;font-family:Georgia,serif;font-weight:500;}',
      '.rp-group{margin:16px 0 4px;color:var(--rp-red);font-size:10.5px;font-weight:800;letter-spacing:.16em;}',
      '.rp-title{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(28,26,23,.35);',
      'border-radius:999px;padding:4px 12px;font-size:11px;color:#2b2620;background:rgba(255,255,255,.7);margin:0 6px 6px 0;}',
      '.rp-title i{width:7px;height:7px;border-radius:50%;background:#a63b32;flex:0 0 auto;}',
      '.rp-title.dim{border-style:dashed;color:#b0a89a;background:none;}',
      '.rp-title.dim i{background:#cfc8ba;}',
      /* 「我的」装修（2026-10-11）：佩戴头衔 / 简介 / 门牌收进我 */
      '.rp-title.worn{background:#1c1a17;color:#f4f0e7;border-color:#1c1a17;}',
      '.rp-title.worn i{background:#f4f0e7;}',
      '.rp-title:not(.dim):not(.worn){cursor:pointer;}',
      '.rp-bio{width:100%;box-sizing:border-box;border:1px solid rgba(43,38,32,.2);border-radius:6px;',
      'background:#fff;color:#2b2620;padding:8px 10px;font-size:12.5px;font-family:inherit;resize:none;margin-top:8px;}',
      '.rp-sec{margin-top:14px;}',
      '.rp-sec>b{display:block;font-size:12px;letter-spacing:.08em;color:#6f675c;margin:0 2px 2px;}'
    ].join('');
    document.head.appendChild(st);
  }

  var TYPE_LABEL = { island: '整岛包', char: '角色卡', worldbook: '世界书',
    preset: '预设', book: '以身入局', theme: '美化' };

  /* 公共铺面只显示服务端真实上架件；无件时不垫底示例，直接显示空态（见 renderShelf）。 */

  /* ------------------------------ 页面 ------------------------------ */

  function get(k, d) { var v = Sleepy.store.get(k); return v === null || v === undefined ? d : v; }
  function set(k, v) { Sleepy.store.set(k, v); }
  var state = { gate: '', shelfItems: null, meSub: '', searchQ: '', boardType: '', pubSort: 'latest' };

  /* 深链：链接带 ?g= 码 → 打开「我的」的门牌子页自动填好待确认 */
  function deepLink() {
    if (state.__linkDone) return;
    state.__linkDone = true;
    var m = String(global.location.search || '').match(/[?&]g=([A-Za-z0-9]{4,12})/);
    if (m) { state.meSub = 'gate'; state.paste = m[1]; Sleepy.nav.open('repo-me'); }
  }

  /* 报头（群声 qs-masthead 同款）：左侧小返回钮 + 宋体报名 + 副题 + 右上角动作 */
  function masthead(headOpts, ctx, backBtn) {
    var top = h('div', 'rp-top');
    var mh = h('div', 'rp-masthead');
    var back = backBtn || (function () {
      var b = h('button', 'rp-backbtn', '‹');
      b.type = 'button';
      b.setAttribute('aria-label', '返回');
      b.addEventListener('click', function () { Sleepy.nav.back(); });
      return b;
    })();
    mh.appendChild(back);
    var name = h('div', 'rp-name');
    name.appendChild(h('h1', null, '御膳房'));
    name.appendChild(h('p', null, headOpts.sub || '明厨暗铺 · 设定打包分享'));
    mh.appendChild(name);
    if (headOpts.action) mh.appendChild(headOpts.action(ctx));
    top.appendChild(mh);
    return top;
  }

  /* 五位底栏（群声 bottomNav 照搬改名）：首页 / 板块 / 开炉(圆钮) / 消息 / 我的 */
  function bottomNav(ctx, active) {
    var nav = h('nav', 'rp-nav');
    [['repo', '首页'], ['repo-boards', '板块']].forEach(function (x) {
      var b = h('button', x[0] === active ? 'on' : '', x[1]);
      b.addEventListener('click', function () { Sleepy.nav.open(x[0]); });
      nav.appendChild(b);
    });
    var pub = h('button', 'rp-fab', '开炉');
    pub.addEventListener('click', function () { openPublish(ctx); });
    nav.appendChild(pub);
    var msg = h('button', 'repo-inbox' === active ? 'on' : '', '消息');
    msg.addEventListener('click', function () { Sleepy.nav.open('repo-inbox'); });
    nav.appendChild(msg);
    var me = h('button', 'repo-me' === active ? 'on' : '', '我的');
    me.addEventListener('click', function () { Sleepy.nav.open('repo-me'); });
    nav.appendChild(me);
    return nav;
  }

  /* 页面骨架：报头/crumb + 滚动主区 + 钉底五栏（群声同构） */
  function mount(ctx, active, buildBody, headOpts) {
    ctx.setTitle('御膳房');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
    ctx.rebuild = function () { mount(ctx, active, buildBody, headOpts); };
    deepLink();
    var root = h('div', 'rp-root');
    /* 报头/crumb 左侧一律带小返回钮（2026-10-11 用户：御膳房左边加个小返回钮；
       二级页退出口只许多不许少——退出条删了，返回钮顶上） */
    var back = h('button', 'rp-backbtn', '‹');
    back.type = 'button';
    back.setAttribute('aria-label', '返回');
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    if (headOpts && headOpts.crumb) {
      var crow = h('div', 'rp-crumb');
      crow.style.cssText = 'display:flex;align-items:center;gap:9px;';
      crow.appendChild(back);
      crow.appendChild(h('span', null, headOpts.crumb));
      root.appendChild(crow);
    } else {
      root.appendChild(masthead(headOpts || {}, ctx, back));
    }
    var main = h('div', 'rp-main');
    if (!RP().base()) {
      /* 服务地址烤在代码里（DEFAULT_BASE）—— 走到这说明还没部署 Worker */
      main.appendChild(h('p', 'rp-empty', '仓库服务还没开通 —— 等下一版更新就好。'));
    }
    buildBody(ctx, main);
    root.appendChild(main);
    root.appendChild(bottomNav(ctx, active));
    ctx.body.appendChild(root);
  }

  /* 右上角 🔎：简版搜索 —— 关键词过滤当前货架的标题/作者；粘 g= 链接直达门牌 */
  function searchSheet(ctx) {
    return function () {
      var sheet = h('div', 'rp-sheet');
      var panel = h('div', 'rp-panel');
      panel.appendChild(h('h3', null, '搜一搜'));
      panel.appendChild(h('p', 'rp-hint', '搜标题、作者、标签（只搜公开的）；粘 ?g= 链接直达门牌。'));
      var row = h('div', 'rp-row');
      var inp = h('input');
      inp.placeholder = '关键词或 ?g= 链接';
      inp.value = state.searchQ || '';
      row.appendChild(inp);
      var go = h('button', 'rp-btn', '找');
      go.type = 'button';
      row.appendChild(go);
      panel.appendChild(row);
      function run() {
        var v = (inp.value || '').trim();
        var m = v.match(/g=([A-Za-z0-9]{4,12})/);
        sheet.remove();
        if (m) { state.meSub = 'gate'; state.paste = m[1]; Sleepy.nav.open('repo-me'); return; }
        state.searchQ = v;
        ctx.rebuild();
      }
      go.addEventListener('click', run);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
      panel.appendChild(h('p', 'rp-hint', '公开铺面与标签检索等 Worker v2 —— 现在先搜已进货架。'));
      sheet.appendChild(panel);
      sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
      document.body.appendChild(sheet);
      inp.focus();
    };
  }

  /* ---------------- 首页（铺面） ---------------- */

  /* 公共铺面卡（Worker v2 /public-shelf）：标题/作者/类型/权限角标/更新时间/领取数 */
  /* 大封面卡：封面图上、信息下（2026-10-11 用户架构：封面/作者·类型/领取·日期） */
  function publicCard(ctx, it) {
    var el = h('button', 'rp-covcard');
    el.type = 'button';
    var cov = h('div', 'rp-covimg');
    if (it.cover) {
      var img = h('img'); img.alt = '';
      img.src = it.cover;
      cov.appendChild(img);
    } else {
      cov.textContent = (it.title || '?').charAt(0);
    }
    var perm = it.access === 'gated' ? '需对暗号' : (it.access === 'sealed' ? '含暗铺件' : '明厨');
    cov.appendChild(h('span', 'rp-covtag', perm));
    cov.appendChild(h('div', 'rp-covtitle', it.title || '未命名'));
    el.appendChild(cov);
    var info = h('div', 'rp-covinfo');
    info.appendChild(h('b', null, (it.author || '无名作者') + ' · ' + (TYPE_LABEL[it.type] || it.type)));
    var when = it.updated_at || it.created_at;
    info.appendChild(document.createTextNode('领取 ' + (it.downloads || 0) +
      (when ? ' · ' + String(when).slice(0, 10) + ' 生产' : '')));
    el.appendChild(info);
    el.addEventListener('click', function () {
      Sleepy.nav.open('repo-item', { id: it.id });
    });
    return el;
  }

  function renderShelf(ctx, root) {
    /* —— 公共铺面（免门牌，Worker v2）—— */
    root.appendChild(h('div', 'rp-group', '公共铺面'));
    var sortRow = h('div', 'rp-row');
    var sort = state.pubSort || 'latest';
    [['latest', '最新'], ['hot', '热门']].forEach(function (x) {
      var c = h('button', 'rp-chip' + (sort === x[0] ? ' on' : ''), x[1]);
      c.type = 'button';
      c.addEventListener('click', function () { state.pubSort = x[0]; ctx.rebuild(); });
      sortRow.appendChild(c);
    });
    if (state.boardType) {
      var bc = h('button', 'rp-chip on', (TYPE_LABEL[state.boardType] || state.boardType) + ' ✕');
      bc.type = 'button';
      bc.addEventListener('click', function () { state.boardType = ''; ctx.rebuild(); });
      sortRow.appendChild(bc);
    }
    if (state.searchQ) {
      var qc = h('button', 'rp-chip on', '搜「' + state.searchQ + '」✕');
      qc.type = 'button';
      qc.addEventListener('click', function () { state.searchQ = ''; ctx.rebuild(); });
      sortRow.appendChild(qc);
    }
    root.appendChild(sortRow);

    var pubWrap = h('div', 'rp-grid');
    var loading = h('p', 'rp-hint', '铺面上货中…');
    pubWrap.appendChild(loading);
    root.appendChild(pubWrap);

    /* —— 暗铺门牌货架（现状保留在下方）—— */
    var gates = RP().gates();
    var gateSec = h('div', 'rp-group', '暗铺门牌货架');
    gateSec.style.marginTop = '16px';
    root.appendChild(gateSec);
    if (!gates.length) {
      root.appendChild(h('p', 'rp-hint', '还没有进任何货架 —— 先到「我的 → 暗铺门牌」用口令或链接进圈。'));
    } else {
      if (!state.gate || gates.indexOf(state.gate) < 0) state.gate = gates[gates.length - 1];
      var chips = h('div', 'rp-row');
      gates.forEach(function (g) {
        var c = h('button', 'rp-chip' + (state.gate === g ? ' on' : ''),
          RP().gateName(g) || g);
        c.type = 'button';
        c.addEventListener('click', function () { state.gate = g; state.shelfItems = null; ctx.rebuild(); });
        chips.appendChild(c);
      });
      root.appendChild(chips);
      if (state.shelfItems) paintFiltered(ctx, root, state.shelfItems);
      else {
        var loading2 = h('p', 'rp-hint', '货架上货中…');
        root.appendChild(loading2);
        RP().shelf(state.gate, function (r) {
          loading2.remove();
          if (!r.ok) { root.appendChild(h('p', 'rp-hint', r.message || '货架没打开')); return; }
          state.shelfItems = r.items || [];
          paintFiltered(ctx, root, state.shelfItems);
        });
      }
    }

    /* 公共铺面拉取（异步，画进自己的卡） */
    RP().publicShelf({ type: state.boardType, q: state.searchQ, sort: sort }, function (r) {
      loading.remove();
      var items = (r.ok && r.items) ? r.items : [];
      if (!items.length) {
        pubWrap.appendChild(h('p', 'rp-empty', '公共铺面还没上货 —— 去「开炉」发一炉试试？'));
        return;
      }
      items.forEach(function (it) { pubWrap.appendChild(publicCard(ctx, it)); });
    });
  }

  /* 搜索词 + 板块类型过滤（门牌货架侧） */
  function paintFiltered(ctx, root, items) {
    var list = items;
    if (state.boardType) {
      list = list.filter(function (it) { return it.type === state.boardType; });
    }
    if (state.boardType) {
      var clear = h('button', 'rp-btn ghost', '清掉筛选');
      clear.type = 'button';
      clear.addEventListener('click', function () {
        state.boardType = ''; ctx.rebuild();
      });
      root.appendChild(clear);
    }
    paintItems(ctx, root, list);
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
    panel.appendChild(h('h3', null, '打包带走：' + (manifest.title || '未命名')));
    var counts = {};
    manifest.items.forEach(function (it) { counts[it.kind] = (counts[it.kind] || 0) + 1; });
    panel.appendChild(h('p', 'rp-hint', Object.keys(counts).map(function (k) {
      return (TYPE_LABEL[k] || k) + ' ×' + counts[k];
    }).join(' · ')));
    if (manifest.summary) {
      var sum = h('div', 'rp-card');
      sum.appendChild(h('b', null, '作者的话'));
      sum.appendChild(h('p', null, manifest.summary));
      panel.appendChild(sum);
    }
    var COND_TXT = { repo: '交一份尝后感', like: '点个赞', comment: '席间说一句' };
    if (manifest.condition && manifest.condition !== 'none') {
      var cond = h('div', 'rp-card');
      cond.appendChild(h('b', null, '领取条件'));
      cond.appendChild(h('p', null, '作者希望领取的人先：' + (COND_TXT[manifest.condition] || manifest.condition) +
        '。（席间开张后会真的卡这道门，现在先记着～）'));
      panel.appendChild(cond);
    }

    /* 暗铺件：对上暗号才解得开；解不开就只带明厨件走 */
    var nLocked = RP().lockedCount(manifest);
    var secretIn = null;
    if (nLocked) {
      panel.appendChild(h('p', 'rp-hint',
        '这件有 ' + nLocked + ' 件在暗铺里 —— 作者给的暗号对上了才带得走；对不上就先带明厨件。'));
      var srow = h('div', 'rp-row');
      secretIn = h('input');
      secretIn.placeholder = '暗号';
      srow.appendChild(secretIn);
      panel.appendChild(srow);
    }

    var choices = { theme: 'mine', worldbook: 'mine' };

    if (manifest.type === 'island') {
      panel.appendChild(h('p', 'rp-hint',
        '这座岛会作为一座**新岛**落进浮岛列表：角色和以身入局档案全部带入；' +
        '聊天记录、朋友圈、照片、马甲、API 配置一律不进包。'));
      var themeItem = manifest.items.filter(function (it) {
        return it.kind === 'theme' && it.data;
      })[0];
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
        if (p[0] === 'theme' && themeItem) {
          var peek = h('button', 'rp-btn ghost', '看 CSS');
          peek.type = 'button';
          peek.addEventListener('click', function () { showCssSheet(ctx, themeItem.data); });
          row.appendChild(peek);
        }
        panel.appendChild(row);
      });
    }

    var go = h('button', 'rp-btn', '打包带走');
    go.type = 'button';
    go.style.marginTop = '12px';
    go.addEventListener('click', function () {
      go.disabled = true; go.textContent = '导入中…';
      if (nLocked) {
        var opened = RP().unlockItems(manifest, (secretIn.value || '').trim());
        if (opened < nLocked) {
          Sleepy.toast('暗号没对上 —— ' + (nLocked - opened) + ' 件还在暗铺，先带明厨件走', 'warn');
        } else {
          Sleepy.toast('暗号对上了，整包带走', 'ok');
        }
      }
      if (manifest.type === 'char') {
        RP().importChar(manifest, function (r) {
          go.disabled = false; go.textContent = '打包带走';
          Sleepy.toast(r.message || (r.ok ? '导好了' : '没导上'), r.ok ? 'ok' : 'err');
          if (r.ok) { sheet.remove(); ctx.rebuild(); }
        });
      } else if (manifest.type === 'worldbook') {
        RP().importWorldbook(manifest, function (r) {
          go.disabled = false; go.textContent = '打包带走';
          Sleepy.toast(r.message || (r.ok ? '导好了' : '没导上'), r.ok ? 'ok' : 'err');
          if (r.ok) { sheet.remove(); ctx.rebuild(); }
        });
      } else {
        RP().importIsland(manifest, choices, function (r) {
          go.disabled = false; go.textContent = '打包带走';
          Sleepy.toast(r.message || (r.ok ? '导好了' : '没导上'), r.ok ? 'ok' : 'err');
          if (r.ok) { sheet.remove(); ctx.rebuild(); }
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

  /* 看 CSS：居中弹层展示美化件的样式内容（发布者自检/领取者预览） */
  function showCssSheet(ctx, themeData) {
    var sheet = h('div', 'rp-sheet');
    var panel = h('div', 'rp-panel');
    panel.appendChild(h('h3', null, '美化 · 样式内容'));
    if (themeData.sealedCss) {
      panel.appendChild(h('p', 'rp-hint', '这位作者把样式藏起来了（暗铺件）—— 不影响使用，但看不到代码。'));
      var c2 = h('button', 'rp-btn', '关了');
      c2.type = 'button';
      c2.style.cssText = 'width:100%;margin-top:10px;';
      c2.addEventListener('click', function () { sheet.remove(); });
      panel.appendChild(c2);
      sheet.appendChild(panel);
      sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
      document.body.appendChild(sheet);
      return;
    }
    var pre = h('pre');
    pre.style.cssText = 'max-height:44vh;overflow:auto;background:#fff;border:1px solid rgba(43,38,32,.2);' +
      'border-radius:8px;padding:10px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:#2b2620;';
    pre.textContent = themeData.css || themeData.bg || JSON.stringify(themeData, null, 2);
    panel.appendChild(pre);
    var close = h('button', 'rp-btn', '关了');
    close.type = 'button';
    close.style.cssText = 'width:100%;margin-top:10px;';
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    document.body.appendChild(sheet);
  }

  /* ---------------- 开炉（打包发布，2026-10-11 改完整页面） ---------------- */

  /* 旧入口兼容：中央圆钮直接跳页 */
  function openPublish() { Sleepy.nav.open('repo-publish'); }

  /* 开炉页：同学录式表单（标签 + 下划线栏）+ 实时发布预览 */
  function renderPublishBody(ctx, root) {
    /* 返回条（2026-10-11 用户：又忘记退出按钮了 —— 二级页必须自带退出） */
    var back = h('button', 'rp-btn ghost', '← 不发了，回铺面');
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    root.appendChild(back);

    var sid = (Sleepy.core.activeSandbox() || {}).id;
    if (!sid) {
      root.appendChild(h('p', 'rp-empty', '先进一座岛，才有东西可打包。'));
      return;
    }

    /* —— ① 这件是什么 —— */
    root.appendChild(h('div', 'rp-group', '① 这件是什么'));
    var card1 = h('div', 'rp-card');
    var f1 = h('label', 'rp-field');
    f1.appendChild(h('span', null, '类型'));
    var typeSel = h('select');
    [['island', '整岛包（这座岛能带走的都带上）'], ['char', '名帖（单选一个角色）'],
     ['worldbook', '食单（单独上传一本世界书）']].forEach(function (o) {
      var op = h('option', null, o[1]); op.value = o[0];
      typeSel.appendChild(op);
    });
    f1.appendChild(typeSel);
    card1.appendChild(f1);
    var f1b = h('label', 'rp-field');
    f1b.appendChild(h('span', null, '选哪个角色 / 世界书'));
    var subSel = h('select');
    var subRow = h('div');
    subRow.appendChild(f1b);
    card1.appendChild(subRow);
    function fillSub() {
      subSel.innerHTML = '';
      if (typeSel.value === 'char') {
        Sleepy.core.charsOfSandbox(sid).forEach(function (c) {
          var op = h('option', null, c.name || '未命名'); op.value = c.id;
          subSel.appendChild(op);
        });
        f1b.style.display = '';
      } else if (typeSel.value === 'worldbook') {
        var wbs = Sleepy.store.get('worldbooks') || [];
        wbs.forEach(function (w) {
          if (!w) return;
          var op = h('option', null, (w.name || '未命名世界书') + (w.scope === 'personal' ? '（个人书）' : ''));
          op.value = w.id;
          subSel.appendChild(op);
        });
        f1b.style.display = '';
        if (!wbs.length) {
          subSel.disabled = true;
          f1b.querySelector('span').textContent = '这台设备还没有世界书';
        } else subSel.disabled = false;
      } else f1b.style.display = 'none';
    }
    fillSub();
    root.appendChild(card1);

    /* —— ② 怎么称呼它 —— */
    root.appendChild(h('div', 'rp-group', '② 怎么称呼它'));
    var card2 = h('div', 'rp-card');
    var covRow = h('div', 'rp-row');
    var cov = h('div', 'rp-cover', '?');
    covRow.appendChild(cov);
    var covBox = h('div');
    covBox.style.flex = '1';
    var f2a = h('label', 'rp-field');
    f2a.appendChild(h('span', null, '封面 URL（可选 · 展示在铺面和详情页）'));
    var coverIn = h('input');
    coverIn.placeholder = 'https://…（留空 = 字母脸）';
    f2a.appendChild(coverIn);
    covBox.appendChild(f2a);
    covRow.appendChild(covBox);
    card2.appendChild(covRow);
    var f2b = h('label', 'rp-field');
    f2b.appendChild(h('span', null, '标题（默认取岛名 / 角色名）'));
    var titleIn = h('input');
    f2b.appendChild(titleIn);
    card2.appendChild(f2b);
    var f2c = h('label', 'rp-field');
    f2c.appendChild(h('span', null, '署名（作者名）'));
    var authorIn = h('input');
    authorIn.value = profile().name || '';
    f2c.appendChild(authorIn);
    card2.appendChild(f2c);
    root.appendChild(card2);
    coverIn.addEventListener('input', function () { paintPreview(); });
    titleIn.addEventListener('input', function () { paintPreview(); });
    authorIn.addEventListener('input', function () { paintPreview(); });

    /* —— ③ 给谁看 —— */
    root.appendChild(h('div', 'rp-group', '③ 给谁看'));
    var card3 = h('div', 'rp-card');
    var permRow = h('div', 'rp-row');
    var access = 'open';
    var openChip = h('button', 'rp-chip on', '明厨铺（全公开）');
    var gatedChip = h('button', 'rp-chip', '暗铺（藏内容）');
    openChip.type = 'button'; gatedChip.type = 'button';
    function paintPerm() {
      openChip.className = 'rp-chip' + (access === 'open' ? ' on' : '');
      gatedChip.className = 'rp-chip' + (access === 'gated' ? ' on' : '');
      secretField.style.display = access === 'gated' ? '' : 'none';
      paintPreview();
    }
    openChip.addEventListener('click', function () { access = 'open'; paintPerm(); });
    gatedChip.addEventListener('click', function () { access = 'gated'; paintPerm(); });
    permRow.appendChild(openChip); permRow.appendChild(gatedChip);
    card3.appendChild(permRow);

    var secretField = h('label', 'rp-field');
    secretField.style.display = 'none';
    secretField.appendChild(h('span', null, '暗号（可空 = 能用但看不到内容；填了 = 对上暗号才能用）'));
    var secretIn = h('input');
    secretIn.placeholder = '例如：夜宵是这个点的暗号';
    secretField.appendChild(secretIn);
    card3.appendChild(secretField);

    /* 领取条件：三选，再点一次取消 = 不设 */
    var condRow = h('div', 'rp-row');
    condRow.style.marginTop = '10px';
    var condition = 'none';
    var CONDS = [['repo', '交一份尝后感'], ['like', '点个赞'], ['comment', '席间说一句']];
    var condChips = [];
    CONDS.forEach(function (c) {
      var chip = h('button', 'rp-chip', c[1]);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        condition = (condition === c[0]) ? 'none' : c[0];   /* 再点一次 = 不设 */
        condChips.forEach(function (x) { x.chip.className = 'rp-chip' + (x.key === condition ? ' on' : ''); });
        paintPreview();
      });
      chip.key = c[0];
      condChips.push({ key: c[0], chip: chip });
      condRow.appendChild(chip);
    });
    card3.appendChild(condRow);
    card3.appendChild(h('p', 'rp-hint', '领取条件 = 作者希望领取的人先做的事，展示在详情页和领取弹层；席间开张后会真的卡门。'));

    var pubChip = h('button', 'rp-chip', '同步到公共铺面（免门牌可领）');
    pubChip.type = 'button';
    pubChip.style.marginTop = '10px';
    pubChip.addEventListener('click', function () { pubChip.classList.toggle('on'); });
    card3.appendChild(pubChip);

    /* 门牌码：可选 + 说清是什么 */
    var f3a = h('label', 'rp-field');
    f3a.style.marginTop = '12px';
    f3a.appendChild(h('span', null, '门牌码（可选）'));
    var gateIn = h('input');
    gateIn.placeholder = '私人小圈子的货架口令 —— 不知道就空着';
    gateIn.value = RP().gates()[0] || '';
    f3a.appendChild(gateIn);
    card3.appendChild(f3a);
    card3.appendChild(h('p', 'rp-hint',
      '这是小厨房的分享码~ 您的作品不会进入公共厨房。'));
    root.appendChild(card3);

    /* —— ④ 包里的件 —— */
    root.appendChild(h('div', 'rp-group', '④ 包里的件 · 每件可选明厨或暗铺'));
    var listCard = h('div', 'rp-card');
    root.appendChild(listCard);
    var lockedSet = {};
    var manifest = null;
    function repack() {
      var opts = { gate: gateIn.value.trim(), author: authorIn.value.trim(),
        avatarUrl: '', title: titleIn.value.trim(), cover: coverIn.value.trim() };
      try {
        manifest = typeSel.value === 'char'
          ? RP().packChar(subSel.value, opts)
          : typeSel.value === 'worldbook'
            ? RP().packWorldbook(subSel.value, opts)
            : RP().packIsland(sid, opts);
      } catch (e) {
        listCard.innerHTML = '';
        listCard.appendChild(h('p', null, String(e.message || e)));
        return;
      }
      lockedSet = {};
      listCard.innerHTML = '';
      manifest.items.forEach(function (it, i) {
        var row = h('div', 'rp-check');
        var name = h('span', null, (it.name || it.kind));
        row.appendChild(name);
        if (it.kind === 'theme' && it.data) {
          var see = h('button', 'rp-btn ghost', '看 CSS');
          see.type = 'button';
          see.style.marginRight = '6px';
          see.addEventListener('click', function () { showCssSheet(ctx, it.data); });
          row.appendChild(see);
        }
        var tog = h('button', 'rp-chip', '明厨');
        tog.type = 'button';
        tog.addEventListener('click', function () {
          var on = lockedSet[i];
          if (on) delete lockedSet[i]; else lockedSet[i] = true;
          tog.textContent = on ? '明厨' : '暗铺';
          tog.className = 'rp-chip' + (on ? '' : ' on');
        });
        row.appendChild(tog);
        listCard.appendChild(row);
      });
    }
    typeSel.addEventListener('change', function () {
      fillSub();
      repack();
      paintPreview();
    });
    subSel.addEventListener('change', repack);
    gateIn.addEventListener('change', repack);

    /* —— ⑤ 作者的话 —— */
    root.appendChild(h('div', 'rp-group', '⑤ 作者的话'));
    var card5 = h('div', 'rp-card');
    var sumIn = h('textarea', 'rp-bio');
    sumIn.rows = 3;
    sumIn.placeholder = '展示在作品页（包外的东西），想写多长写多长。';
    card5.appendChild(sumIn);
    root.appendChild(card5);
    sumIn.addEventListener('input', paintPreview);

    /* —— 发布预览（铺面卡同款样式，实时） —— */
    root.appendChild(h('div', 'rp-group', '⑥ 发布预览 · 铺面上看到的样子'));
    var prevCard = h('div', 'rp-card');
    root.appendChild(prevCard);
    function paintPreview() {
      var selText = (subSel.options[subSel.selectedIndex] || {}).textContent || '';
      var title = titleIn.value.trim() ||
        (typeSel.value === 'island' ? '未命名岛 · 整岛包' : selText.replace(/（.*）$/, '') || '未命名');
      prevCard.innerHTML = '';
      prevCard.appendChild(h('b', null, '预览'));
      var el = h('div', 'rp-item');
      el.style.padding = '12px 2px';
      if (coverIn.value.trim()) {
        var covp = h('div', 'rp-cover');
        var img = h('img'); img.alt = '';
        img.src = coverIn.value.trim();
        img.addEventListener('error', function () { img.remove(); covp.textContent = title.charAt(0); });
        covp.appendChild(img);
        el.appendChild(covp);
      } else {
        el.appendChild(h('div', 'rp-av', title.charAt(0)));
      }
      var m = h('div', 'rp-item-m');
      m.appendChild(h('b', null, title));
      var permTxt = access === 'gated' ? ' · 需对暗号' : '';
      var condTxt = condition !== 'none' ? ' · ' + ({ repo: '要尝后感', like: '要点赞', comment: '要说一句' }[condition]) : '';
      m.appendChild(h('small', null, (authorIn.value.trim() || '无名作者') + ' · ' +
        (TYPE_LABEL[typeSel.value] || typeSel.value) + permTxt + condTxt));
      el.appendChild(m);
      prevCard.appendChild(el);
      if (sumIn.value.trim()) {
        var sp = h('p', null, '作者的话：' + sumIn.value.trim());
        prevCard.appendChild(sp);
      }
    }

    /* —— 发布 —— */
    var msg = h('p', 'rp-hint', '');
    var btn = h('button', 'rp-btn', '开炉 · 发布');
    btn.type = 'button';
    btn.style.cssText = 'width:100%;margin-top:14px;';
    btn.addEventListener('click', function () {
      var gate = gateIn.value.trim();
      if (!gate && !pubChip.classList.contains('on')) {
        msg.textContent = '门牌码和「同步到公共铺面」至少占一个，不然件没地方挂。'; return;
      }
      var secret = secretIn.value.trim();
      var lockedIdx = Object.keys(lockedSet).map(Number);
      if (!lockedIdx.length && access === 'gated') {
        msg.textContent = '暗铺铺面也要有暗铺件 —— 把至少一件拨成暗铺，或者拨回明厨。'; return;
      }
      btn.disabled = true; btn.textContent = '打包上传中…';
      var opts = { gate: gate, author: authorIn.value.trim(),
        avatarUrl: '', title: titleIn.value.trim(), cover: coverIn.value.trim(),
        visible: pubChip.classList.contains('on') };
      try {
        manifest = typeSel.value === 'char'
          ? RP().packChar(subSel.value, opts)
          : typeSel.value === 'worldbook'
            ? RP().packWorldbook(subSel.value, opts)
            : RP().packIsland(sid, opts);
        manifest.summary = (sumIn.value || '').trim();
        RP().applyLocks(manifest, lockedIdx, secret, condition);
        if (access === 'gated') { manifest.access = 'gated'; manifest.lock = 'gated'; }
        if (opts.visible) manifest.visible = true;
      } catch (e) {
        msg.textContent = String(e.message || e); btn.disabled = false;
        btn.textContent = '开炉 · 发布'; return;
      }
      RP().publish(manifest, function (r) {
        btn.disabled = false; btn.textContent = '开炉 · 发布';
        if (r.ok) {
          RP().recordMine({ id: r.id, title: manifest.title, type: manifest.type, at: Date.now() });
          Sleepy.toast('开炉成功，上架了', 'ok');
          Sleepy.nav.open('repo');
        } else {
          msg.textContent = r.message || '没发上去';
        }
      });
    });
    root.appendChild(btn);
    root.appendChild(msg);

    repack();
    paintPreview();
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
        ctx.rebuild();
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

  /* 板块（2026-10-11 御膳房）：按类型分区 —— 六格入口，点进该类清单。
     P0 数据仍走门牌货架（公共货架等 Worker v2），没进门牌就先给空态。 */
  var BOARD_META = [
    { type: 'char', name: '名帖', sub: '角色卡' },
    { type: 'worldbook', name: '食单', sub: '世界书' },
    { type: 'preset', name: '火候', sub: '预设' },
    { type: 'island', name: '满汉全席', sub: '整岛包' },
    { type: 'book', name: '入席', sub: '以身入局' },
    { type: 'theme', name: '摆盘', sub: '美化' }
  ];
  function renderBoards(ctx, root) {
    var head = h('div', 'rp-card');
    head.appendChild(h('b', null, '板块'));
    head.appendChild(h('p', null, '点一行进公共铺面的对应货架 —— 暗铺门牌的件在首页下面那格。'));
    root.appendChild(head);
    /* 群声板块目录同款：大字号行距列表 */
    BOARD_META.forEach(function (m) {
      var row = h('button', 'rp-board');
      row.type = 'button';
      row.appendChild(h('b', null, m.name));
      row.appendChild(h('span', null, m.sub));
      row.appendChild(h('i', null, '›'));
      row.addEventListener('click', function () {
        state.boardType = m.type;
        Sleepy.nav.open('repo');
      });
      root.appendChild(row);
    });
  }

  /* 消息（v2.1 真数据）：我名下件收到的席间评论/尝后感 + 点赞合计。
     未读 = 比上次看的新的条数；「都看过了」记 lastInboxSeen。 */
  function renderInbox(ctx, root) {
    root.appendChild(h('div', 'rp-group', '席间消息'));
    var card = h('div', 'rp-card');
    var loading = h('p', 'rp-hint', '翻席间留言中…');
    card.appendChild(loading);
    root.appendChild(card);

    var seen = get('repoInboxSeen', 0) || 0;
    RP().myInbox(function (r) {
      loading.remove();
      if (!r.ok) {
        card.appendChild(h('p', 'rp-hint', r.message || '席间还没开张（服务端没连上）。'));
        return;
      }
      var cs = r.comments || [];
      var unread = cs.filter(function (c) { return (c.created_at || 0) > seen; }).length;
      card.innerHTML = '';
      if (!cs.length) {
        card.appendChild(h('p', null, '还没有消息 —— 有人在你的件的席间说话、写尝后感，都会到这里报到。'));
        return;
      }
      var head = h('div', 'rp-row');
      head.appendChild(h('span', null, '共 ' + cs.length + ' 条' +
        (r.likesTotal ? ' · 收到 ❤ ' + r.likesTotal : '') +
        (unread ? ' · ' + unread + ' 条没看过' : ' · 都看过了')));
      var mark = h('button', 'rp-btn ghost', '都看过了');
      mark.type = 'button';
      mark.addEventListener('click', function () {
        set('repoInboxSeen', Date.now());
        Sleepy.toast('记下了', 'ok');
        ctx.rebuild();
      });
      head.appendChild(mark);
      card.appendChild(head);
      cs.forEach(function (c) {
        var el = h('div', 'rp-item');
        el.appendChild(h('div', 'rp-item-m', [
          h('b', null, (c.kind === 'repo' ? '尝后感 · ' : '') + (c.name || '无名食客') +
            ' →《' + (c.title || '?') + '》'),
          h('small', null, String(c.created_at || '').slice(0, 16).replace('T', ' ') +
            ((c.created_at || 0) > seen ? ' · 新' : ''))]));
        var bd = h('div', null, c.body);
        bd.style.cssText = 'font-size:12px;line-height:1.7;color:#2b2620;margin-top:2px;';
        el.appendChild(bd);
        card.appendChild(el);
      });
    });
  }

  function renderMe(ctx, root) {
    var p = profile();
    /* 门牌子视图（暗铺门牌收进「我」） */
    if (state.meSub === 'gate') {
      var back = h('button', 'rp-btn ghost', '← 回我的');
      back.type = 'button';
      back.addEventListener('click', function () { state.meSub = ''; ctx.rebuild(); });
      root.appendChild(back);
      renderGate(ctx, root);
      return;
    }
    var mine = myTitles();
    var worn = mine.filter(function (t) { return t.name === p.equippedTitle; })[0];

    /* 大身份卡（群声 qs-me-head 同款）：头像 + 昵称 + 佩戴头衔 + 简介 + 编辑 */
    var head = h('div', 'rp-me-head');
    var av = h('div', 'rp-av');
    if (p.avatarUrl) {
      var img = h('img'); img.alt = '';
      img.src = p.avatarUrl;
      img.addEventListener('error', function () { img.remove(); });
      av.appendChild(img);
    } else {
      av.appendChild(document.createTextNode((p.name || '我').charAt(0)));
    }
    head.appendChild(av);
    var hb = h('div');
    hb.appendChild(h('div', 'rp-me-name', p.name || '无名访客'));
    if (worn) {
      var pill = h('span', 'rp-title worn');
      pill.style.cssText = 'margin:4px 0 0;display:inline-flex;';
      pill.appendChild(h('i'));
      pill.appendChild(document.createTextNode(worn.name));
      hb.appendChild(pill);
    }
    hb.appendChild(h('div', 'rp-me-sub', p.bio || '这个身份只用于御膳房署名'));
    head.appendChild(hb);
    var editBtn = h('button', 'rp-me-edit', '编辑资料');
    editBtn.type = 'button';
    editBtn.addEventListener('click', function () { openProfileEditor(ctx); });
    head.appendChild(editBtn);
    root.appendChild(head);

    /* stats 行（群声 qs-me-stats 同款：Georgia 大数字） */
    var stats = h('div', 'rp-stats');
    [[RP().mine().length, '上架'], [RP().downloads().length, '领取'], [mine.length, '头衔']].forEach(function (x) {
      var s = h('div');
      s.appendChild(h('b', null, String(x[0])));
      s.appendChild(document.createTextNode(x[1]));
      stats.appendChild(s);
    });
    root.appendChild(stats);

    /* 我的头衔（点一枚戴上） */
    var tsec = h('div', 'rp-group', '我的头衔 · 点一枚戴上');
    root.appendChild(tsec);
    var tc = h('div', 'rp-card');
    if (!mine.length) tc.appendChild(h('p', null, '还没有头衔 —— 上架第一件、领取第一件就会点亮。'));
    mine.forEach(function (t) {
      var wornOn = p.equippedTitle === t.name;
      var el = h('span', 'rp-title' + (wornOn ? ' worn' : ''));
      el.appendChild(h('i'));
      el.appendChild(document.createTextNode(t.name + (wornOn ? ' · 佩戴中' : '')));
      el.title = t.desc;
      el.addEventListener('click', function () {
        saveProfile({
          name: (profile().name || ''), avatarUrl: (profile().avatarUrl || ''),
          bio: (profile().bio || ''), equippedTitle: wornOn ? '' : t.name
        });
        Sleepy.toast(wornOn ? '摘下来了' : '戴上了：' + t.name, 'ok');
        ctx.rebuild();
      });
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

    /* 铺子里我的件 */
    var minePub = RP().mine();
    root.appendChild(h('div', 'rp-group', '铺子里我的件'));
    var c1 = h('div', 'rp-card');
    if (!minePub.length) c1.appendChild(h('p', null, '还没有上架的件 —— 点底下的「开炉」把这座岛的好东西端出来。'));
    minePub.slice().reverse().forEach(function (m) {
      var el = h('div', 'rp-item');
      el.appendChild(h('div', 'rp-item-m', [
        h('b', null, m.title), h('small', null, (TYPE_LABEL[m.type] || m.type) + ' · ' + m.id)]));
      var off = h('button', 'rp-btn ghost', '下架');
      off.type = 'button';
      off.addEventListener('click', function () {
        RP().unpublish(m.id, function (r) {
          Sleepy.toast(r.ok ? '下架了' : (r.message || '没下成'), r.ok ? 'ok' : 'err');
          if (r.ok) ctx.rebuild();
        });
      });
      el.appendChild(off);
      c1.appendChild(el);
    });
    root.appendChild(c1);

    /* 我领取的 */
    var dls = RP().downloads();
    root.appendChild(h('div', 'rp-group', '我领取的'));
    var c2 = h('div', 'rp-card');
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

    /* 暗铺门牌入口 */
    root.appendChild(h('div', 'rp-group', '暗铺门牌'));
    var gc = h('div', 'rp-card');
    gc.appendChild(h('p', null, '输门牌进私人小货架 —— 链接里带 ?g= 也能直接进。'));
    var go = h('button', 'rp-btn ghost', '进门牌');
    go.type = 'button';
    go.addEventListener('click', function () { state.meSub = 'gate'; ctx.rebuild(); });
    gc.appendChild(go);
    root.appendChild(gc);
  }

  /* 编辑资料：居中弹层（2026-10-11 用户：行内编辑太简陋）——
     昵称 / 头像 URL（即时预览）/ 一句简介。 */
  function openProfileEditor(ctx) {
    var p = profile();
    var sheet = h('div', 'rp-sheet');
    var panel = h('div', 'rp-panel');
    panel.appendChild(h('h3', null, '编辑资料'));
    var avRow = h('div', 'rp-row');
    var av = h('div', 'rp-av');
    av.style.width = '52px'; av.style.height = '52px'; av.style.fontSize = '19px';
    function paintAv(url) {
      av.innerHTML = '';
      if (url) {
        var img = h('img'); img.alt = '';
        img.src = url;
        img.addEventListener('error', function () { img.remove(); av.textContent = (nameIn.value || '我').charAt(0); });
        av.appendChild(img);
      } else {
        av.appendChild(document.createTextNode((nameIn.value || '我').charAt(0)));
      }
    }
    avRow.appendChild(av);
    var nameIn = h('input');
    nameIn.placeholder = '昵称'; nameIn.maxLength = 16; nameIn.value = p.name || '';
    nameIn.addEventListener('input', function () {
      if (!urlIn.value) paintAv('');
    });
    avRow.appendChild(nameIn);
    panel.appendChild(avRow);
    var urlIn = h('input');
    urlIn.placeholder = '头像 URL（留空 = 字母脸）'; urlIn.value = p.avatarUrl || '';
    urlIn.addEventListener('input', function () { paintAv(urlIn.value.trim()); });
    panel.appendChild(urlIn);
    var bio = h('textarea', 'rp-bio');
    bio.rows = 2; bio.maxLength = 60;
    bio.placeholder = '一句简介（出现在你的作者主页）';
    bio.value = p.bio || '';
    panel.appendChild(bio);
    var save = h('button', 'rp-btn', '保存');
    save.type = 'button';
    save.style.cssText = 'width:100%;margin-top:12px;';
    save.addEventListener('click', function () {
      saveProfile({
        name: nameIn.value.trim().slice(0, 16),
        avatarUrl: urlIn.value.trim(),
        bio: bio.value.trim().slice(0, 60),
        equippedTitle: (profile().equippedTitle || '')
      });
      sheet.remove();
      Sleepy.toast('资料存好了', 'ok');
      ctx.rebuild();
    });
    panel.appendChild(save);
    var close = h('button', 'rp-btn ghost', '先不改');
    close.type = 'button';
    close.style.cssText = 'width:100%;margin-top:8px;';
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    document.body.appendChild(sheet);
    paintAv(p.avatarUrl || '');
  }

  /* 写尝后感/席间：居中弹层 */
  function openWriteSheet(ctx, itemId, kind, title) {
    var sheet = h('div', 'rp-sheet');
    var panel = h('div', 'rp-panel');
    panel.appendChild(h('h3', null, title));
    var ta = h('textarea', 'rp-bio');
    ta.rows = 4;
    ta.placeholder = kind === 'repo' ? '火候、摆盘、回味……写下来给后来的人指路。' : '说点什么……';
    panel.appendChild(ta);
    var send = h('button', 'rp-btn', '发到席间');
    send.type = 'button';
    send.style.cssText = 'width:100%;margin-top:12px;';
    send.addEventListener('click', function () {
      var text = (ta.value || '').trim();
      if (!text) { Sleepy.toast('总得写点什么'); return; }
      send.disabled = true;
      /* ★ 2026-10-12 P0：同步抛错到不了 callback，按钮会永久灰
         （曾经的 cfg() ReferenceError 就是这么把席间入口卡死的）。
         包一层 —— 任何同步异常也恢复按钮，失败可重发。 */
      try {
        RP().postComment(itemId, kind, text, function (r) {
          send.disabled = false;
          if (!r.ok) { Sleepy.toast(r.message || '没发出去', 'err'); return; }
          sheet.remove();
          Sleepy.toast('发到席间了，谢谢投喂~', 'ok');
          ctx.rebuild();
        });
      } catch (e) {
        send.disabled = false;
        Sleepy.toast('没发出去', 'err');
      }
    });
    panel.appendChild(send);
    var close = h('button', 'rp-btn ghost', '先不写');
    close.type = 'button';
    close.style.cssText = 'width:100%;margin-top:8px;';
    close.addEventListener('click', function () { sheet.remove(); });
    panel.appendChild(close);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
    document.body.appendChild(sheet);
    ta.focus();
  }

  /* ---------------- 作品详情页（repo-item，子页：backbar 无底栏） ---------------- */
  function renderItemDetail(ctx) {
    ctx.setTitle('御膳房');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
    ctx.rebuild = function () { renderItemDetail(ctx); };
    var root = h('div', 'rp-root');
    var back = h('button', 'rp-btn ghost', '← 回铺面');
    back.style.margin = '10px 18px 0';
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    root.appendChild(back);
    var main = h('div', 'rp-main');
    main.appendChild(h('p', 'rp-hint', '详情上桌中…'));
    root.appendChild(main);
    ctx.body.appendChild(root);

    var id = ctx.params && ctx.params.id;
    var gate = (ctx.params && ctx.params.gate) || state.gate || '';
    RP().itemMeta(id, gate, function (r) {
      main.innerHTML = '';
      if (!r.ok) { main.appendChild(h('p', 'rp-empty', r.message || '这件不在架上')); return; }
      var it = r.meta || {};
      /* 大头卡 */
      var head = h('div', 'rp-me-head');
      if (it.cover) {
        var covd = h('div', 'rp-cover');
        covd.style.cssText = 'width:64px;height:64px;font-size:24px;';
        var cimg = h('img'); cimg.alt = '';
        cimg.src = it.cover;
        cimg.addEventListener('error', function () { cimg.remove(); covd.textContent = (it.title || '?').charAt(0); });
        covd.appendChild(cimg);
        head.appendChild(covd);
      } else {
        var av = h('div', 'rp-av', (it.title || '?').charAt(0));
        av.style.width = '64px'; av.style.height = '64px'; av.style.fontSize = '24px';
        head.appendChild(av);
      }
      var hb = h('div');
      hb.appendChild(h('div', 'rp-me-name', it.title || '未命名'));
      hb.appendChild(h('div', 'rp-me-sub', (it.author || '无名作者') + ' · ' +
        (TYPE_LABEL[it.type] || it.type) + ' · v' + (it.version || 1)));
      var perm = it.access === 'gated' ? '需对暗号' : (it.access === 'sealed' ? '含暗铺件（能用看不到）' : '明厨（全公开）');
      var tag = h('span', 'rp-title', perm);
      tag.style.margin = '5px 0 0';
      hb.appendChild(tag);
      head.appendChild(hb);
      root.appendChild(head);
      var stats = h('div', 'rp-stats');
      [[it.downloads || 0, '领取'], [it.size ? Math.round(it.size / 1024) : 0, 'KB'], [1, '版本 v' + (it.version || 1)]].forEach(function (x) {
        var st = h('div');
        st.appendChild(h('b', null, String(x[0])));
        st.appendChild(document.createTextNode(x[1]));
        stats.appendChild(st);
      });
      root.appendChild(stats);

      /* 作者的话（包外元数据，不限字数） */
      if (it.summary) {
        root.appendChild(h('div', 'rp-group', '作者的话'));
        var sc = h('div', 'rp-card');
        sc.appendChild(h('p', null, it.summary));
        root.appendChild(sc);
      }
      /* 领取条件（v2.1：真校验——席间完成对应动作就放行） */
      var COND_TXT = { repo: '交一份尝后感', like: '点个赞', comment: '席间说一句' };
      if (it.condition && it.condition !== 'none') {
        root.appendChild(h('div', 'rp-group', '领取条件'));
        var cc = h('div', 'rp-card');
        cc.appendChild(h('p', null, '作者希望领取的人先：' + (COND_TXT[it.condition] || it.condition) + '。'));
        var condState = h('p', 'rp-hint', '条件核对中…');
        cc.appendChild(condState);
        root.appendChild(cc);
        RP().checkCondition(id, function (cr) {
          /* 点赞型（2026-10-12 P1-2 修）：服务端没有账号体系、恒回 met:false，
             「我赞过」本来就是设备本地记的（repoLikedIds）—— 判定也用本地，
             否则「点赞才能领」的件永远领不到。 */
          if (it.condition === 'like') {
            var liked = RP().likedIds().indexOf(id) >= 0;
            conditionMet = liked;
            condState.textContent = liked
              ? '✓ 条件已满足 —— 可以打包带走了'
              : '还没完成：点个赞（上面 ♡ 那个按钮）就能领';
            paintGo();
            return;
          }
          condState.textContent = (cr.ok && cr.met)
            ? '✓ 条件已满足 —— 可以打包带走了'
            : '还没完成：' + (COND_TXT[it.condition] || it.condition) +
              (cr.ok ? '（在下面的席间做完就行）' : '（服务器没连上，先放行——上线后自动卡门）');
          conditionMet = !cr.ok || cr.met;   /* 服务器没连上 → 先放行（上线后自动卡门） */
          paintGo();
        });
      }
      /* 权限说明 */
      root.appendChild(h('div', 'rp-group', '权限说明'));
      var pc = h('div', 'rp-card');
      pc.appendChild(h('p', null, it.access === 'gated'
        ? '这件是暗铺 + 作者设了暗号 —— 领取时对上暗号才带得走。'
        : (it.access === 'sealed'
          ? '这件含暗铺件 —— 能用（世界书照常注入、美化照常生效），但作者藏起来的部分看不到。'
          : '这件是明厨件 —— 内容全公开。')));
      root.appendChild(pc);

      /* 点赞 + 席间 */
      var likeRow = h('div', 'rp-row');
      var likeBtn = h('button', 'rp-btn ghost',
        RP().likedIds().indexOf(id) >= 0 ? '❤ 赞过了' : '♡ 点个赞');
      likeBtn.type = 'button';
      likeBtn.addEventListener('click', function () {
        if (likeBtn.textContent.indexOf('赞过了') >= 0) return;
        RP().likeItem(id, function (r) {
          if (r.ok) { likeBtn.textContent = '❤ 赞过了'; Sleepy.toast('赞到了', 'ok'); }
          else Sleepy.toast(r.message || '没赞上', 'warn');
        });
      });
      var repoBtn = h('button', 'rp-btn ghost', '✎ 交一份尝后感');
      repoBtn.type = 'button';
      repoBtn.addEventListener('click', function () { openWriteSheet(ctx, id, 'repo', '尝后感 —— 这件好吃在哪？'); });
      likeRow.appendChild(likeBtn); likeRow.appendChild(repoBtn);
      likeRow.style.marginTop = '12px';
      root.appendChild(likeRow);

      root.appendChild(h('div', 'rp-group', '席间'));
      var talkCard = h('div', 'rp-card');
      var talkInput = h('textarea', 'rp-bio');
      talkInput.rows = 2; talkInput.placeholder = '席间说一句……（匿名，署你的铺子昵称）';
      talkCard.appendChild(talkInput);
      var talkSend = h('button', 'rp-btn', '说一句');
      talkSend.type = 'button';
      talkSend.style.cssText = 'margin-top:8px;';
      talkSend.addEventListener('click', function () {
        var text = (talkInput.value || '').trim();
        if (!text) { Sleepy.toast('先写点什么'); return; }
        talkSend.disabled = true;
        /* ★ 2026-10-12 P0：同步抛错也恢复按钮（同席间弹层那处），
           失败可重发，不永久灰。 */
        try {
          RP().postComment(id, 'comment', text, function (r) {
            talkSend.disabled = false;
            if (!r.ok) { Sleepy.toast(r.message || '没发出去', 'err'); return; }
            talkInput.value = '';
            Sleepy.toast('说到席间了', 'ok');
            paintTalk();
          });
        } catch (e) {
          talkSend.disabled = false;
          Sleepy.toast('没发出去', 'err');
        }
      });
      talkCard.appendChild(talkSend);
      var talkList = h('div');
      talkCard.appendChild(talkList);
      root.appendChild(talkCard);

      function paintTalk() {
        RP().listComments(id, function (r) {
          talkList.innerHTML = '';
          if (!r.ok) { talkList.appendChild(h('p', 'rp-hint', '席间还没开张（服务端没连上）。')); return; }
          var cs = r.comments || [];
          if (!cs.length) { talkList.appendChild(h('p', 'rp-hint', '席间很安静 —— 说第一句吧。')); return; }
          cs.forEach(function (c) {
            var el = h('div', 'rp-item');
            el.appendChild(h('div', 'rp-item-m', [
              h('b', null, (c.kind === 'repo' ? '尝后感 · ' : '') + (c.name || '无名食客')),
              h('small', null, String(c.created_at || '').slice(0, 10))]));
            var bd = h('div', null, c.body);
            bd.style.cssText = 'font-size:12px;line-height:1.7;color:#2b2620;margin-top:2px;';
            el.appendChild(bd);
            talkList.appendChild(el);
          });
        });
      }
      paintTalk();

      /* 打包带走（条件门） */
      var conditionMet = !(it.condition && it.condition !== 'none');
      var go = h('button', 'rp-btn', '打包带走');
      go.type = 'button';
      go.style.cssText = 'width:100%;margin-top:12px;';
      function paintGo() {
        if (it.condition && it.condition !== 'none' && !conditionMet) {
          go.textContent = '先' + (COND_TXT[it.condition] || '完成条件') + '，再打包带走';
        } else {
          go.textContent = '打包带走';
        }
      }
      paintGo();
      go.addEventListener('click', function () {
        if (!conditionMet) { Sleepy.toast('先在席间把作者的条件完成～', 'warn'); return; }
        go.disabled = true; go.textContent = '打包下载中…';
        RP().downloadItem(id, it.visible ? '' : gate, function (r2) {
          go.disabled = false; go.textContent = '打包带走';
          if (!r2.ok) { Sleepy.toast(r2.message || '没下载下来', 'err'); return; }
          openImportWizard(ctx, r2.manifest);
        });
      });
      root.appendChild(go);
      var close = h('button', 'rp-btn ghost', '先看看别的');
      close.type = 'button';
      close.style.cssText = 'width:100%;margin-top:8px;';
      close.addEventListener('click', function () { Sleepy.nav.back(); });
      root.appendChild(close);
      root.appendChild(main);
    });
  }

  /* 四页注册（群声同构）：每页自带报头/crumb + 五位底栏，壳头整条藏掉 */
  function page(active, buildBody, headOpts) {
    return {
      title: '御膳房',
      render: function (ctx) { mount(ctx, active, buildBody, headOpts); },
      onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
    };
  }
  Sleepy.register('repo', page('repo', renderShelf, {
    sub: '明厨暗铺 · 设定打包分享',
    action: function (ctx) {
      /* 放大镜 icon 素钮（2026-10-11 用户：直接一个放大镜，不要框框） */
      var b = h('button', 'rp-searchbtn');
      b.type = 'button';
      b.setAttribute('aria-label', '搜一搜');
      b.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/></svg>';
      b.addEventListener('click', searchSheet(ctx));
      return b;
    }
  }));
  Sleepy.register('repo-boards', page('repo-boards', renderBoards, { crumb: '御膳房 · 板块' }));
  Sleepy.register('repo-publish', page('repo-publish', renderPublishBody, { crumb: '御膳房 · 开炉' }));
  Sleepy.register('repo-inbox', page('repo-inbox', renderInbox, { crumb: '御膳房 · 消息' }));
  Sleepy.register('repo-me', page('repo-me', renderMe, { crumb: '御膳房 · 我的' }));
  /* 详情页是子页（backbar 无底栏），不走 page() 工厂 */
  Sleepy.register('repo-item', {
    title: '御膳房',
    render: renderItemDetail,
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

})(window);
