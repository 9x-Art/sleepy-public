/* ============================================================
   page-yishenruju.js — 「以身入局」App · 档案架大厅（P0 第一刀）

   《以身入局》：char 是局里员工，user 是老板或亲自入局，
   进入一本已经存在的故事世界执行委托。方案见
   docs/方案-以身入局-v1-P0-P3施工计划.md（§五~§九 已全部拍板）。

   本批（P0 第一刀）只做：档案架大厅 + 下一局身份选择 +
   数据层接线（book-core.js）。演练世界的「领局牌 → 建档 →
   入世游玩」在下一批接——盒子上明写「下一批开放建档」，
   不冒充可用。

   视觉：帷境夜色（style.css 的 --wj-* 全套变量直接复用），
   档案盒 = 深夜书脊 + 纸签 + 盖戳。
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
  /* 只用 style.css 已有的 --wj-* 变量（帷境夜色），不另造色板。 */
  var STYLE_ID = 'yr-book-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.yr-root{display:flex;flex-direction:column;height:100%;overflow:hidden;',
      'background:radial-gradient(circle at 55% 0,var(--wj-night-3) 0,var(--wj-night-2) 34%,var(--wj-night) 76%);',
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

      /* 身份区 */
      '.yr-eyebrow{font-size:9px;letter-spacing:.3em;color:var(--wj-dimmer);text-transform:uppercase;margin:14px 2px 8px}',
      '.yr-id-now{border:1px solid var(--wj-line);background:rgba(255,255,255,.03);border-radius:8px;padding:12px 14px}',
      '.yr-id-now b{font-family:var(--ff-serif);font-weight:500;font-size:15px;color:var(--wj-text);display:block;margin-bottom:4px}',
      '.yr-id-now p{margin:0;font-size:11.5px;line-height:1.7;color:var(--wj-dim)}',
      '.yr-id-opts{display:flex;flex-direction:column;gap:8px}',
      '.yr-id-opt{text-align:left;border:1px solid var(--wj-line);background:rgba(255,255,255,.02);border-radius:8px;padding:11px 13px;color:var(--wj-text);cursor:pointer;transition:border-color .15s}',
      '.yr-id-opt:active{border-color:var(--wj-silver)}',
      '.yr-id-opt b{display:block;font-family:var(--ff-serif);font-weight:500;font-size:13.5px;margin-bottom:3px}',
      '.yr-id-opt span{font-size:11px;line-height:1.65;color:var(--wj-dim)}',

      /* 档案架 */
      '.yr-shelf{margin-top:16px}',
      '.yr-shelf-note{font-size:9px;letter-spacing:.26em;color:var(--wj-dimmer);padding:0 2px 7px}',
      '.yr-rail{border-top:1px solid var(--wj-line);border-bottom:7px solid rgba(39,57,87,.9);padding:10px 2px 0;display:flex;gap:10px;overflow-x:auto;min-height:118px}',
      '.yr-rail::-webkit-scrollbar{height:0}',

      /* 档案盒 */
      '.yr-box{flex:0 0 auto;width:128px;background:linear-gradient(180deg,var(--wj-night-3),var(--wj-night-2));',
      'border:1px solid var(--wj-line);border-radius:4px 7px 2px 2px;padding:10px 9px 9px;display:flex;flex-direction:column;cursor:pointer;position:relative}',
      '.yr-box:active{border-color:var(--wj-silver)}',
      '.yr-box[aria-disabled="true"]{opacity:.62;cursor:default}',
      '.yr-box-title{font-family:var(--ff-serif);font-size:13px;font-weight:500;color:var(--wj-text);line-height:1.4;flex:1;padding-right:36px}',
      '.yr-box-meta{font-size:9px;color:var(--wj-dimmer);letter-spacing:.08em;margin-top:7px}',
      '.yr-stamp{position:absolute;top:7px;right:7px;font-size:8.5px;letter-spacing:.14em;color:var(--wj-wine-lite);',
      'border:1px solid rgba(138,95,107,.65);border-radius:2px;padding:1px 4px;transform:rotate(-6deg)}',
      '.yr-box-note{font-size:10px;line-height:1.6;color:var(--wj-dim);margin-top:5px}',

      '.yr-empty-shelf{font-size:11px;color:var(--wj-dimmer);padding:14px 2px;line-height:1.7}',

      '.yr-foot{padding:16px 4px 4px;font-size:10px;line-height:1.8;color:var(--wj-dimmer)}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderIdentity(ctx, sid) {
    var wrap = h('section');
    wrap.appendChild(h('div', 'yr-eyebrow', '下一局身份'));
    var cur = B().getIdentity(sid);
    if (cur) {
      var hit = B().IDENTITIES.filter(function (x) { return x.key === cur; })[0];
      var card = h('div', 'yr-id-now');
      card.appendChild(h('b', null, hit ? hit.name : cur));
      card.appendChild(h('p', null, hit ? hit.desc : ''));
      wrap.appendChild(card);
      /* 还没开局，身份可以换；一旦有进行中的任务就锁死（下一批在开局时抄进运行记录）。 */
      var again = h('button', 'yr-id-opt', '');
      again.style.marginTop = '8px';
      again.appendChild(h('span', null, '还没开局，换一个身份'));
      again.addEventListener('click', function () {
        var s = B().getMap('bookSettingsBySandbox', sid) || {};
        delete s.identity;
        B().setMap('bookSettingsBySandbox', sid, s);
        render(ctx, sid);
      });
      wrap.appendChild(again);
    } else {
      var opts = h('div', 'yr-id-opts');
      B().IDENTITIES.forEach(function (it) {
        var b = h('button', 'yr-id-opt');
        b.appendChild(h('b', null, it.name));
        b.appendChild(h('span', null, it.desc));
        b.addEventListener('click', function () {
          B().setIdentity(sid, it.key);
          Sleepy.toast('身份定了：' + it.name + '。进局后不可再换。');
          render(ctx, sid);
        });
        opts.appendChild(b);
      });
      wrap.appendChild(opts);
    }
    return wrap;
  }

  function boxCard(ctx, sid, box) {
    var el = h('div', 'yr-box');
    if (!box.enterable) el.setAttribute('aria-disabled', 'true');
    el.appendChild(h('span', 'yr-stamp', box.stamp));
    el.appendChild(h('div', 'yr-box-title', box.title));
    el.appendChild(h('div', 'yr-box-note', box.note));
    el.appendChild(h('div', 'yr-box-meta',
      box.status === 'empty' ? '空位' : (box.status === 'ongoing' ? '进行中' :
        box.status === 'closed' ? '已结案' : '封存')));
    el.addEventListener('click', function () {
      if (!box.enterable) {
        Sleepy.toast('这一格等世界包定稿再上架。');
        return;
      }
      /* 演练盒：领局牌 → 建档 → 入世在下一批接。这里说实话，不装能进。 */
      Sleepy.toast('「' + box.title + '」的建档与入世在下一批开放。');
    });
    return el;
  }

  function render(ctx, sid) {
    ctx.setTitle('以身入局');
    ctx.setActions([]);
    ctx.body.innerHTML = '';
    ensureStyle();

    var root = h('div', 'yr-root');
    var room = h('div', 'yr-room');

    /* 顶栏 */
    var top = h('div', 'yr-top');
    var brand = h('div', 'yr-brand');
    brand.appendChild(h('span', 'yr-mark'));
    brand.appendChild(h('span', null, '档案架'));
    top.appendChild(brand);
    var energy = h('div', 'yr-energy');
    energy.appendChild(h('small', null, '能量'));
    energy.appendChild(h('strong', null, '—'));
    energy.title = '局账在结算批次开张';
    top.appendChild(energy);
    root.appendChild(top);

    /* 身份 */
    room.appendChild(renderIdentity(ctx, sid));

    /* 档案架 · 第一层 */
    var boxes = B().ensureBoxes(sid);
    var shelfA = h('section', 'yr-shelf');
    shelfA.appendChild(h('div', 'yr-shelf-note', '第一层 · 已建档世界'));
    var railA = h('div', 'yr-rail');
    boxes.forEach(function (b) { railA.appendChild(boxCard(ctx, sid, b)); });
    shelfA.appendChild(railA);
    room.appendChild(shelfA);

    /* 档案架 · 第二层（封存） */
    var shelfB = h('section', 'yr-shelf');
    shelfB.appendChild(h('div', 'yr-shelf-note', '第二层 · 封存'));
    shelfB.appendChild(h('div', 'yr-empty-shelf', '还没有封存的档案。\n异常度涨到 60 的世界会躺到这一层来。'));
    room.appendChild(shelfB);

    room.appendChild(h('div', 'yr-foot',
      '进局前选好身份，开局后不可再换。每一步都会自动写进卷宗，退出再进来接着走。'));
    root.appendChild(room);
    ctx.body.appendChild(root);
  }

  Sleepy.register('yishenruju', {
    title: '以身入局',
    render: function (ctx) {
      var sid = (Sleepy.core.activeSandbox() || {}).id || null;
      if (!sid) {
        ctx.setTitle('以身入局');
        ctx.setActions([]);
        ctx.body.innerHTML = '';
        ctx.body.appendChild(h('p', 'ph-entry-lead', '先进入一座岛，局里才有你的档案架。'));
        return;
      }
      B().lockSandbox(sid);
      render(ctx, sid);
    }
  });
})(window);
