/* ============================================================
   page-yishenruju.js — 「以身入局」App · 档案架大厅（P0）

   《以身入局》：char 是局里员工，user 是老板或亲自入局，
   进入一本已经存在的故事世界执行委托。方案见
   docs/方案-以身入局-v1-P0-P3施工计划.md（§五~§九 已全部拍板）。

   本页：档案架大厅 + 下一局身份选择（环形牌台，照领局牌 Demo v2
   的 coverflow 口径移植：拖拽/箭头/圆点，中央即所选）+
   数据层接线（book-core.js）。演练世界的「领局牌 → 建档 →
   入世游玩」在下一批接——盒子上明写「下一批开放建档」，
   不冒充可用。

   视觉：帷境夜色。页面 chrome（顶栏/底色）走 style.css 的
   .page[data-page="yishenruju"] 换皮组；这里只写 .yr- 部件。
   数据：一律走 Sleepy.book（book-core.js），本文件不做裸 store 读写。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var book = null;          /* 惰性取：文件求值时 book-core 可能还没挂上 */
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

  /* ------------------------------ 样式 ------------------------------ */
  var STYLE_ID = 'yr-book-style';
  function ensureStyle() {    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.yr-root{display:flex;flex-direction:column;height:100%;overflow:hidden;',
      'color:var(--wj-text);font-size:14px}',
      '.yr-root::-webkit-scrollbar{width:0}',

      /* 顶栏 */
      '.yr-top{display:flex;align-items:center;justify-content:space-between;padding:10px 18px 8px;flex:0 0 auto}',
      '.yr-brand{display:flex;align-items:center;gap:9px;font-family:var(--ff-serif);letter-spacing:.2em;font-size:13.5px;color:var(--wj-text)}',
      '.yr-mark{width:17px;height:17px;border:1px solid rgba(232,237,247,.55);border-radius:50%;position:relative;flex:0 0 auto}',
      '.yr-mark:after{content:"";position:absolute;top:3px;bottom:3px;left:7.5px;border-left:1px solid rgba(232,237,247,.7)}',
      '.yr-energy{text-align:right;color:var(--wj-dim)}',
      '.yr-energy small{display:block;font-size:8.5px;letter-spacing:.24em;color:var(--wj-dimmer)}',
      '.yr-energy strong{font-family:var(--ff-serif);font-size:15px;font-weight:500;color:var(--wj-silver)}',

      /* 滚动主体 */
      '.yr-room{flex:1;overflow-y:auto;padding:2px 16px 26px;-webkit-overflow-scrolling:touch}',

      '.yr-eyebrow{font-size:9px;letter-spacing:.3em;color:var(--wj-dimmer);text-transform:uppercase;margin:14px 2px 8px}',

      /* ---- 环形牌台（照领局牌 Demo v2 口径移植） ---- */
      '.yr-stage{position:relative;height:300px;margin:4px 0 0;perspective:1150px;perspective-origin:50% 44%;',
      'touch-action:pan-y;user-select:none;-webkit-user-select:none}',
      '.yr-ring{position:absolute;inset:0;transform-style:preserve-3d}',
      '.yr-card{position:absolute;left:50%;top:10px;width:186px;height:238px;margin-left:-93px;padding:0;overflow:hidden;text-align:center;',
      'border:1px solid rgba(213,202,182,.3);border-radius:3px;color:#e8eef8;cursor:pointer;',
      'background:linear-gradient(158deg,#3d5167 0%,#22364c 52%,#151f30 100%);',
      'box-shadow:0 20px 44px rgba(3,7,16,.5),inset 0 0 0 1px rgba(211,220,238,.06);',
      'transition:transform .42s cubic-bezier(.22,.84,.3,1),opacity .42s,box-shadow .3s;will-change:transform;font-family:inherit}',
      '.yr-dragging .yr-card{transition:none}',
      '.yr-card[data-i="1"]{background:linear-gradient(158deg,#2b4053 0%,#1b2d41 54%,#121c2c 100%)}',
      '.yr-card[data-i="2"]{background:linear-gradient(158deg,#4c3842 0%,#2e2129 56%,#161018 100%)}',
      '.yr-card:before{content:"";position:absolute;inset:9px;pointer-events:none;border:1px solid rgba(213,202,182,.17)}',
      '.yr-card:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;',
      'background:linear-gradient(104deg,transparent 28%,rgba(236,230,218,.14) 47%,transparent 64%)}',
      '.yr-card.center{border-color:rgba(236,230,218,.62);',
      'box-shadow:0 26px 58px rgba(3,7,16,.58),0 0 0 1px rgba(236,230,218,.14),inset 0 0 36px rgba(189,201,222,.07)}',
      '.yr-c-top{position:relative;z-index:2;padding:16px 0 0;font-size:8px;letter-spacing:.3em;color:rgba(170,184,206,.5)}',
      '.yr-glyph{position:relative;z-index:2;display:block;margin:22px 0 0;font-family:var(--ff-serif);font-size:44px;font-weight:500;color:var(--wj-silver);line-height:1}',
      '.yr-glass{position:relative;z-index:2;display:block;margin:16px 26px 0;height:1px;background:linear-gradient(90deg,transparent,rgba(213,202,182,.35),transparent)}',
      '.yr-c-name{position:relative;z-index:2;margin-top:14px;font-family:var(--ff-serif);font-size:16px;font-weight:500;letter-spacing:.12em;color:#e8eef8}',
      '.yr-c-name small{display:block;margin-top:4px;font-size:9.5px;letter-spacing:.1em;color:rgba(170,184,206,.75)}',
      '.yr-c-code{position:absolute;z-index:2;left:0;right:0;bottom:14px;font-size:8px;letter-spacing:.28em;color:rgba(170,184,206,.5)}',

      /* 牌台下：圆点 + 箭头 + 明细 + 定牌 */
      '.yr-stage-nav{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:6px}',
      '.yr-nav-btn{border:1px solid var(--wj-line);background:transparent;color:var(--wj-silver);width:34px;height:26px;border-radius:4px;cursor:pointer;font-size:12px}',
      '.yr-nav-btn[disabled]{opacity:.35;cursor:default}',
      '.yr-dots{display:flex;gap:7px;align-items:center}',
      '.yr-dot{width:6px;height:6px;border-radius:50%;border:0;padding:0;background:rgba(199,210,228,.28);cursor:pointer}',
      '.yr-dot.on{background:var(--wj-silver)}',
      '.yr-motto{margin:12px 2px 0;font-size:12px;line-height:1.75;color:var(--wj-dim);min-height:40px}',
      '.yr-motto b{color:var(--wj-text);font-weight:500}',
      /* 纸皮下按钮/说明文字一律墨色（2026-10-11 用户：白字看不清） */
      yrSel('.yr-take') + '{color:#2b2620;border-color:rgba(43,38,32,.5);background:rgba(255,255,255,.55);}',
      yrSel('.yr-motto') + '{color:#4a4438;}',
      yrSel('.yr-card') + '{color:#2b2620;}',
      yrSel('.yr-card p') + '{color:#4a4438;}',
      /* 全屏页滚动条藏掉（#phone 外的桌面全屏也有） */
      yrSel(' *') + '{scrollbar-width:none;}',
      yrSel(' *::-webkit-scrollbar') + '{width:0;height:0;display:none;}',
      '.yr-take{display:block;width:100%;margin-top:10px;padding:12px;border:1px solid rgba(236,230,218,.4);border-radius:6px;',
      'background:rgba(255,255,255,.05);color:var(--wj-text);font-family:var(--ff-serif);font-size:14px;letter-spacing:.22em;cursor:pointer}',
      '.yr-take:active{background:rgba(255,255,255,.1)}',

      /* 已定身份卡 */
      '.yr-id-now{border:1px solid var(--wj-line);background:rgba(255,255,255,.03);border-radius:8px;padding:12px 14px}',
      '.yr-id-now b{font-family:var(--ff-serif);font-weight:500;font-size:15px;color:var(--wj-text);display:block;margin-bottom:4px}',
      '.yr-id-now p{margin:0;font-size:11.5px;line-height:1.7;color:var(--wj-dim)}',
      '.yr-again{margin-top:8px;width:100%;padding:10px;border:1px dashed var(--wj-line);border-radius:8px;',
      'background:transparent;color:var(--wj-dim);font-size:11.5px;cursor:pointer}',

      /* 档案架 · 第一层（竖书脊书架，照档案架 Demo v3 口径移植） */
      '.yr-shelf{margin-top:18px}',
      '.yr-shelf-note{font-size:9px;letter-spacing:.26em;color:var(--wj-dimmer);padding:0 2px 7px}',
      '.yr-rail{display:flex;align-items:flex-end;gap:7px;overflow-x:auto;padding:20px 2px 0;',
      'background:linear-gradient(180deg,rgba(5,10,20,.34),transparent 40%);scroll-snap-type:x proximity}',
      '.yr-rail::-webkit-scrollbar{height:0}',
      '.yr-board{height:7px;background:linear-gradient(180deg,var(--wj-night-3),#1a2840);box-shadow:inset 0 1px 0 rgba(189,201,222,.2);border-radius:1px}',

      /* 竖档案盒（书脊）：62×218 立在架上，竖排书脊字 + 纸签顶 + 圆扣手 */
      '.yr-box{position:relative;flex:0 0 auto;width:60px;height:214px;padding:7px 4px 0;text-align:center;cursor:pointer;scroll-snap-align:start;',
      'transition:transform .22s ease,box-shadow .22s ease;',
      'box-shadow:2px 0 0 rgba(0,0,0,.2),0 12px 22px rgba(3,7,16,.4);font-family:inherit}',
      '.yr-box:active{transform:translateY(-10px)}',
      '.yr-box[aria-disabled="true"]{opacity:.72;cursor:default}',
      '.yr-box.paper{background:linear-gradient(90deg,#b0a48d 0 4px,#d5cab6 4px 52px,#b0a48d 52px 100%)}',
      '.yr-box.night{background:linear-gradient(90deg,#16233a 0 4px,#2a3d5c 4px 52px,#16233a 52px 100%)}',
      '.yr-box.wine{background:linear-gradient(90deg,#563a43 0 4px,#8a5f6b 4px 52px,#563a43 52px 100%)}',
      '.yr-box-top{height:26px;margin-bottom:6px;padding:4px 2px;overflow:hidden;',
      'background:var(--wj-paper);border:1px solid rgba(40,41,35,.22);',
      'color:#6f6b62;font-size:7px;line-height:1.3;letter-spacing:.04em}',
      '.yr-spine{height:128px;display:grid;place-items:center;background:var(--wj-paper);border:1px solid rgba(40,41,35,.22)}',
      '.yr-spine b{writing-mode:vertical-rl;text-orientation:upright;font-family:var(--ff-serif);',
      'font-size:12.5px;font-weight:500;letter-spacing:.16em;color:var(--wj-ink)}',
      '.yr-hole{width:14px;height:14px;margin:12px auto 0;border-radius:50%;',
      'background:rgba(5,9,18,.52);box-shadow:inset 0 1px 2px rgba(0,0,0,.6)}',
      '.yr-code{position:absolute;left:0;right:0;bottom:4px;font-size:7px;letter-spacing:.1em;color:rgba(40,41,35,.5)}',
      '.yr-seal{position:absolute;left:-7px;right:-7px;top:96px;padding:3px 0;transform:rotate(-7deg);z-index:2;',
      'background:rgba(236,230,218,.94);border:1px dashed var(--wj-wine);',
      'font-size:9px;letter-spacing:.3em;color:var(--wj-wine)}',
      '.yr-box.empty{background:transparent;border:1px dashed rgba(211,220,238,.24);box-shadow:none}',
      '.yr-box.empty .yr-spine{background:transparent;border-style:dashed;border-color:rgba(211,220,238,.2)}',
      '.yr-box.empty .yr-spine b{color:#7f8da3;font-size:11px}',
      '.yr-box.empty .yr-box-top{background:transparent;border-style:dashed;border-color:rgba(211,220,238,.2);color:#6e7b90}',
      '.yr-box.empty .yr-hole{opacity:.3}',
      '.yr-box.empty .yr-code{color:rgba(199,210,228,.5)}',

      '.yr-empty-shelf{font-size:11px;color:var(--wj-dimmer);padding:14px 2px;line-height:1.7}',
      '.yr-foot{padding:16px 4px 4px;font-size:10px;line-height:1.8;color:var(--wj-dimmer)}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ---- 2026-10-10 换装（用户反馈：颜色不太行，想要群声那种
     纸面 + 深色撞色的质感；晚一轮确认「以身入局全部换」）----
     yishenruju / yr-board / yr-play 三页共用这一份纸面撞色皮；
     style.css 的帷境换皮组保留（别的 wj 页还走夜色），这里整体压过去。 */
  var HOME_STYLE_ID = 'yr-home-style';
  var YR_PAGES = '.page[data-page="yishenruju"],' +
    '.page[data-page="yr-board"],.page[data-page="yr-play"]';
  /* ⚠️ 部件规则必须用 yrSel() 拼 —— 直接写 YR_PAGES + ' .yr-top' 是踩过的坑：
     逗号分隔的选择器列表里，后代空格**只粘在最后一个选择器上**，
     拼出来 = `.page[yrA],.page[yrB],.page[yrC] .yr-top` —— 前两页是
     「页面本体直接命中」，报头的 position/bottom/height 会糊到 .page 上，
     inset:0 被干掉 → 整页塌成顶部一条 10px 的小白框（2026-10-11 线上抓到）。 */
  function yrSel(suffix) {
    return YR_PAGES.split(',').map(function (s) { return s + ' ' + suffix; }).join(',');
  }
  function ensureHomeStyle() {
    if (document.getElementById(HOME_STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = HOME_STYLE_ID;
    st.textContent = [
      /* 纸面底 + 墨色文字（群声的报纸底 #f4f0e7 一族）。
         注意：style.css 11841 这一组还把这三页设成帷境夜色（深蓝径向渐变底
         + --bg:#16203a），是 2026-10-10 换纸皮前的旧决定。纸皮要在级联上压住它，
         必须 ① background 用 !important 盖掉那条 radial-gradient；② 玻璃层
         --g-glass/--g-glass-2 也改成正不透明的纸色，否则内层 .app-body/卡片会画成
         半透明白玻璃盖在纸底上（真机实测：rgba(255,255,255,.72) 大片灰白、不是纸）。
         ③ --wj-* 暖板必须定义在**页面级**：yr-play 的根节点是 .yp-root 不是
         .yr-root，只挂 .yr-root 时游玩页整棵树拿不到暖板、仍是夜色近白字，
         压在纸上就是「字体不适配」（2026-10-11 线上抓到）。
         页面自身用深一档纸色当「桌面」，中间 .page-inner 是居中的小手机（下条）。 */
      YR_PAGES + '{background:#e6dfd0 !important;',
      '--bg:#f4f0e7;--text:#2b2620;--text-dim:rgba(43,38,32,.6);--surface-solid:#f4f0e7;',
      '--g-glass:rgba(244,240,231,.92);--g-glass-2:rgba(244,240,231,.96);',
      '--g-glass-line:rgba(43,38,32,.16);--g-glass-edge:rgba(43,38,32,.24);',
      '--wj-night:#efe9db;--wj-night-2:#e5dcc8;--wj-night-3:#d8cdb4;',
      '--wj-line:rgba(43,38,32,.18);--wj-line-soft:rgba(43,38,32,.1);',
      '--wj-text:#2b2620;--wj-dim:#6f675c;--wj-dimmer:#948b7d;',
      '--wj-silver:#3f3a32;--wj-wine:#a63b32;--wj-wine-lite:#c86f66;',
      '--wj-paper:#faf7f0;--wj-paper-2:#ece5d4;--wj-ink:#2b2620;--wj-green:#315d68;}',
      /* 色板已在页级给全树，这里只补 .yr-root 的文字色 */
      yrSel('.yr-root') + '{color:#2b2620;}',
      /* 顶栏：单细线压底（2026-10-11 用户：「有两个黑线」——
         报头双细杠和壳头叠在一起显乱，收敛成一条） */
      yrSel('.yr-top') + '{border-bottom:1px solid rgba(43,38,32,.45);padding-bottom:10px;}',
      /* 报头文字强制墨色（2026-10-11 用户：白字看不清） */
      yrSel('.yr-brand') + '{color:#2b2620;}',
      yrSel('.yr-energy') + '{color:#6f675c;}',
      yrSel('.yr-energy strong') + '{color:#2b2620;}',
      yrSel('.yr-mark') + '{border-color:rgba(43,38,32,.55);}',
      yrSel('.yr-mark:after') + '{border-left-color:rgba(43,38,32,.7);}',
      /* 眉标：黑底反白小条 —— 群声的撞色块 */
      yrSel('.yr-eyebrow') + '{display:inline-block;padding:3px 10px 2px;background:#1c1a17;color:#f4f0e7;border-radius:2px;}',
      yrSel('.yr-shelf-note') + '{display:inline-block;padding:3px 10px 2px;background:#1c1a17;color:#f4f0e7;border-radius:2px;margin-left:2px;}',
      yrSel('.yr-rail') + '{background:linear-gradient(180deg,rgba(43,38,32,.09),transparent 42%);}',
      yrSel('.yr-id-now') + '{background:rgba(255,255,255,.62);}',
      yrSel('.yr-empty-shelf') + '{color:#948b7d;}',
      /* 导入入口行 */
      yrSel('.yr-shelf-head') + '{display:flex;align-items:center;gap:10px;}',
      yrSel('.yr-import-btn') + '{margin-left:auto;border:1px solid #1c1a17;background:transparent;color:#2b2620;',
      'font-size:10px;letter-spacing:.18em;padding:4px 10px;border-radius:2px;cursor:pointer;font-family:inherit;}',
      /* 帷境部件里写死的深色半透明面，在纸面上换成白瓷面 */
      yrSel('.yb-card') + ',' + yrSel('.yp-entry') + ',' + yrSel('.yp-bubble') + '{background:rgba(255,255,255,.6);}',
      yrSel('.yb-open') + '{border-color:#1c1a17;background:rgba(255,255,255,.08);color:#2b2620;}',
      yrSel('.yb-open:active') + '{background:rgba(28,26,23,.12);}',
      /* 游玩页钉底的操作条 / 圆球条：原 rgba(5,10,20,.34) 深纱在纸面上
         会变成「深底配深字」，统一换成白瓷条 + 墨线 */
      yrSel('.yp-act') + ',' + yrSel('.yp-balls') + '{background:rgba(250,247,240,.94);}',
      yrSel('.yp-act') + '{border-top:1px solid rgba(43,38,32,.18);}',
      yrSel('.yp-row input') + ',' + yrSel('.yp-row button') + ',' + yrSel('.yp-ball') + '{background:rgba(255,255,255,.72);}',
      /* 纸面对比度体系（2026-10-11 用户：「字体不适配」）：
         主动作 = 墨底反白（群声撞色），次动作 = 白瓷 + 墨边，弱动作 = 暖灰。
         原来的 rgba(255,255,255,.05) 底在纸上等于透明，浅字全糊。 */
      yrSel('.yp-send') + '{background:#1c1a17;border:0;color:#f4f0e7;}',
      yrSel('.yp-send[disabled]') + '{opacity:.4;}',
      yrSel('.yp-act .yp-send + .yp-send') + '{background:rgba(255,255,255,.72);border:1px solid #1c1a17;color:#2b2620;}',
      yrSel('.yp-sub') + '{color:#6f675c;}',
      yrSel('.yp-input') + '{background:rgba(255,255,255,.72);border-color:rgba(43,38,32,.35);color:#2b2620;}',
      yrSel('.yp-input::placeholder') + '{color:#948b7d;}',
      yrSel('.yp-goal') + '{background:rgba(255,255,255,.62);border:1px solid rgba(43,38,32,.28);',
      'border-left:3px solid #1c1a17;border-radius:8px;color:#2b2620;padding:8px 10px;}',
      yrSel('.yp-sealnote') + '{color:#a63b32;border-left-color:#a63b32;}',
      yrSel('.yp-scene-bar') + '{background:rgba(28,26,23,.62);}'
    ].join('');
    document.head.appendChild(st);
  }
  /* yr-board / yr-play 也调用（同一份 style id，注入一次全局生效） */
  Sleepy.yrHomeStyle = ensureHomeStyle;

  /* ------------------------------ 环形牌台（通用） ------------------------------ */
  /* 照领局牌 Demo v2 口径移植：coverflow 三维透视 + 拖拽/箭头/圆点。
     opts = { cards:[{glyph,name,sub,code,desc}], startIndex, takeText, onTake(i) }
     挂到 Sleepy.yrRing —— 领局牌建档页（page-yr-board.js）复用同一组件。 */

  function yrRing(opts) {
    var seats = opts.cards;
    var active = opts.startIndex || 0;
    var virtual = active;
    var dragging = false;
    var startX = 0;
    var baseAtDrag = 0;
    var justDragged = false;

    var wrap = h('div');

    var stage = h('div', 'yr-stage');
    var ring = h('div', 'yr-ring');
    seats.forEach(function (it, i) {
      var card = h('button', 'yr-card');
      card.setAttribute('data-i', String(i));
      card.setAttribute('aria-label', it.name);
      card.appendChild(h('div', 'yr-c-top', it.top || '以身入局 · 局牌'));
      card.appendChild(h('b', 'yr-glyph', it.glyph || '局'));
      card.appendChild(h('i', 'yr-glass'));
      var name = h('div', 'yr-c-name', it.name);
      name.appendChild(h('small', null, it.sub || ''));
      card.appendChild(name);
      card.appendChild(h('div', 'yr-c-code', it.code || ''));
      ring.appendChild(card);
    });
    stage.appendChild(ring);
    wrap.appendChild(stage);

    var nav = h('div', 'yr-stage-nav');
    var prev = h('button', 'yr-nav-btn', '‹');
    var dots = h('div', 'yr-dots');
    var dotEls = seats.map(function (_, i) {
      var d = h('button', 'yr-dot');
      d.setAttribute('aria-label', '第 ' + (i + 1) + ' 枚');
      d.addEventListener('click', function () { active = i; virtual = i; layout(); renderDetail(); });
      dots.appendChild(d);
      return d;
    });
    var next = h('button', 'yr-nav-btn', '›');
    nav.appendChild(prev); nav.appendChild(dots); nav.appendChild(next);
    wrap.appendChild(nav);

    var motto = h('p', 'yr-motto');
    wrap.appendChild(motto);
    var take = h('button', 'yr-take', opts.takeText || '定下这一枚');
    wrap.appendChild(take);

    var cardEls = [...ring.querySelectorAll('.yr-card')];
    function narrow() { return Math.min(window.innerWidth, 430) < 380; }

    function layout() {
      var gapX = narrow() ? 96 : 118;
      var depth = narrow() ? 110 : 140;
      cardEls.forEach(function (el, i) {
        var off = i - virtual, abs = Math.abs(off);
        el.style.transform =
          'translateX(' + (off * gapX) + 'px) ' +
          'translateZ(' + (-abs * depth) + 'px) ' +
          'rotateY(' + (off * -34) + 'deg) ' +
          'scale(' + (1 - abs * 0.08) + ')';
        el.style.opacity = String(Math.max(0, 1 - abs * 0.3));
        el.style.zIndex = String(100 - Math.round(abs * 10));
        el.classList.toggle('center', abs < 0.5);
        el.style.pointerEvents = abs > 2.4 ? 'none' : '';
      });
    }

    function renderDetail() {
      var it = seats[active];
      motto.innerHTML = '';
      motto.appendChild(h('b', null, it.name + ' —— '));
      motto.appendChild(document.createTextNode(it.desc || ''));
      dotEls.forEach(function (d, i) { d.classList.toggle('on', i === active); });
      prev.disabled = active === 0;
      next.disabled = active === seats.length - 1;
    }

    function snap() {
      virtual = active;
      stage.classList.remove('yr-dragging');
      layout();
      renderDetail();
    }

    prev.addEventListener('click', function () { if (active > 0) { active--; snap(); } });
    next.addEventListener('click', function () { if (active < seats.length - 1) { active++; snap(); } });
    cardEls.forEach(function (el, i) {
      el.addEventListener('click', function () {
        if (justDragged) return;
        /* 非中央的牌点一下 = 把它转到中央（跟 Demo 一致） */
        if (i !== active) { active = i; snap(); }
      });
    });

    stage.addEventListener('pointerdown', function (e) {
      dragging = true; startX = e.clientX; baseAtDrag = active; virtual = active;
      stage.classList.add('yr-dragging');
      if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var step = narrow() ? 96 : 118;
      virtual = Math.max(0, Math.min(seats.length - 1, baseAtDrag - dx / step));
      layout();
    });
    stage.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 10) {
        justDragged = true;
        setTimeout(function () { justDragged = false; }, 0);
      }
      if (Math.abs(dx) > 30) {
        active = Math.max(0, Math.min(seats.length - 1, baseAtDrag + (dx < 0 ? 1 : -1)));
      }
      snap();
    });
    stage.addEventListener('pointercancel', function () { dragging = false; snap(); });

    take.addEventListener('click', function () { opts.onTake(active); });

    layout();
    renderDetail();
    return wrap;
  }

  Sleepy.yrRing = yrRing;

  /* ------------------------------ 渲染 ------------------------------ */

  /* ------------------------------ 渲染 ------------------------------ */

  function boxCard(ctx, sid, box, idx) {
    /* 竖书脊档案盒：恢复原配色轮换（纸/夜/酒）—— 2026-10-11 用户：
       不要按来源改白底，书脊保持原色，演练/TXT 靠「戳」区分就够了。 */
    var el = h('button', 'yr-box' + (box.enterable ? [' night', ' wine', ' paper'][idx % 3] : ' empty'));
    if (!box.enterable) el.setAttribute('aria-disabled', 'true');
    var top = h('div', 'yr-box-top');
    /* 两行签：<br> 必须走 innerHTML —— h() 的第三参是 textContent，
       字符串里的 <br> 会原样显示成文字（真机抓过）。 */
    top.innerHTML = box.enterable ? '以身入局<br>世界档案' : '空位<br>待上架';
    el.appendChild(top);
    el.appendChild(h('div', 'yr-spine', h('b', null, box.title)));
    el.appendChild(h('div', 'yr-hole'));
    if (box.enterable) el.appendChild(h('div', 'yr-code', box.stamp + ' · 局内'));
    if (box.stamp && box.stamp !== '已结案') el.appendChild(h('div', 'yr-seal', box.stamp));
    el.addEventListener('click', function () {
      if (!box.enterable) {
        Sleepy.toast('这一格等世界包定稿再上架。');
        return;
      }
      /* 演练盒（2026-10-11 用户：演练要重走三步）永远先进领局牌页；
         其他已开局的盒直进游玩页，未开局的进建档页。 */
      if (box.status === 'ongoing' && box.source !== 'drill') {
        Sleepy.nav.open('yr-play', { boxId: box.id, sandboxId: sid });
      } else {
        Sleepy.nav.open('yr-board', { boxId: box.id, sandboxId: sid });
      }
    });
    return el;
  }

  /* 2026-10-11 晚定稿：点开直接是**档案架全屏页面**（无门面无手机壳）——
     「手机」是游玩页（yr-play）里的局内手机，点开弹一个小手机样子的面板。 */
  function render(ctx, sid) {
    ctx.setTitle('以身入局');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();
    ensureHomeStyle();

    var root = h('div', 'yr-root');
    var room = h('div', 'yr-room');

    /* 顶栏 */
    var top = h('div', 'yr-top');
    var brand = h('div', 'yr-brand');
    brand.appendChild(h('span', 'yr-mark'));
    brand.appendChild(h('span', null, '以身入局 · 档案架'));
    top.appendChild(brand);
    var energy = h('div', 'yr-energy');
    energy.appendChild(h('small', null, '能量'));
    energy.appendChild(h('strong', null, '—'));
    energy.title = '局账在结算批次开张';
    top.appendChild(energy);
    root.appendChild(top);

    /* 档案架 · 第一层 */
    var boxes = B().ensureBoxes(sid);
    var shelfA = h('section', 'yr-shelf');
    var headRow = h('div', 'yr-shelf-head');
    headRow.appendChild(h('div', 'yr-eyebrow', '第一层 · 已建档世界'));
    /* ★ v219 TXT 导入入口（需求清单 §十：user 导入自己的书上架成新世界） */
    var imp = h('button', 'yr-import-btn', '+ 导入 TXT');
    imp.type = 'button';
    imp.addEventListener('click', function () {
      Sleepy.nav.open('yr-import', { sandboxId: sid });
    });
    headRow.appendChild(imp);
    shelfA.appendChild(headRow);
    var railA = h('div', 'yr-rail');
    boxes.forEach(function (b, i) { railA.appendChild(boxCard(ctx, sid, b, i)); });
    shelfA.appendChild(railA);
    shelfA.appendChild(h('div', 'yr-board'));
    room.appendChild(shelfA);

    /* 档案架 · 第二层（封存）—— 2026-10-10 用户反馈：封存也是一排书架，
       不是一句空话。封存盒（status='sealed' / 已结案戳）立上来，没货摆空位。 */
    var sealed = boxes.filter(function (b) {
      return b.status === 'sealed' || b.stamp === '已结案';
    });
    var shelfB = h('section', 'yr-shelf');
    shelfB.appendChild(h('div', 'yr-eyebrow', '第二层 · 封存'));
    var railB = h('div', 'yr-rail');
    if (!sealed.length) {
      for (var ei = 0; ei < 3; ei++) {
        var empty = h('button', 'yr-box empty');
        empty.type = 'button';
        empty.setAttribute('aria-disabled', 'true');
        var etop = h('div', 'yr-box-top');
        etop.innerHTML = '空位<br>待封存';
        empty.appendChild(etop);
        empty.appendChild(h('div', 'yr-spine', h('b', null, '—')));
        empty.appendChild(h('div', 'yr-hole'));
        empty.addEventListener('click', function () {
          Sleepy.toast('异常度涨到 60 的世界会躺到这一层来。');
        });
        railB.appendChild(empty);
      }
    } else {
      sealed.forEach(function (b, i) { railB.appendChild(boxCard(ctx, sid, b, i)); });
    }
    shelfB.appendChild(railB);
    shelfB.appendChild(h('div', 'yr-board'));
    room.appendChild(shelfB);

    root.appendChild(room);
    ctx.body.appendChild(root);
  }

  /* 入口 wrapper（具名！rebuild 必须指向它——若写 render(ctx) 会解析到
     内层 render(ctx, sid)，sid 形参 undefined → ensureBoxes 直接抛）。 */
  function renderEntry(ctx) {
    var sid = (Sleepy.core.activeSandbox() || {}).id || null;
    if (!sid) {
      ctx.setTitle('以身入局');
      ctx.setActions([]);
      ctx.body.innerHTML = '';
      ensureStyle();
      ensureHomeStyle();   /* 纸皮在无岛占位页也要套（不然夜色底白字看不清） */
      ctx.body.appendChild(h('p', 'ph-entry-lead', '先进入一座岛，局里才有你的档案架。'));
      return;
    }
    B().lockSandbox(sid);
    render(ctx, sid);
  }

  Sleepy.register('yishenruju', {
    title: '以身入局',
    render: function (ctx) {
      /* render 末尾把自己挂成 ctx.rebuild —— onShow 每次都重读 activeSandbox
         重画（页面实例缓存复用，先开页后进岛会拿到旧空态 DOM）。 */
      ctx.rebuild = function () { renderEntry(ctx); };
      renderEntry(ctx);
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });
})(window);
