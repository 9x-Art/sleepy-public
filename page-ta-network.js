/* ============================================================
   page-ta-network.js — ta 关系网（第一批，只读双视图）

   产品依据：《ta 关系网 v1 · 第一批只读施工单》§1「page-ta-network.js」
            + 产品设计稿 §1 / §2 / §3 / §6。

   ─── 一句话 ──────────────────────────────────────────────
   本文件**不做任何判定** —— 节点、边、权限、近况、`hasImpact` 全部由
   `Sleepy.taNetwork.build()` 产出（ta-network.js，先于本文件加载）。
   图视图和列表视图消费**同一份结果**，所以两个视图不可能说两套话
   （设计稿 §7 原文「页面组件不各自拼人物数据」）。

   ─── 视图 ────────────────────────────────────────────────
     关系图（默认）：手写 SVG + 确定性环形布局。
       中心角色置中 → 有边节点置内环 → 其余节点（含无边 NPC）置外环。
       几何是**纯函数**（`layoutOf`），同输入同坐标，不引任何第三方布局库。
     列表：手机可读的等价回退，信息比图更全（关系标签 / 近况 / 时间 / 依据）。
     切换视图只改 DOM —— 不写 store、不调模型（冒烟有零写入断言）。

   ─── 红线 ────────────────────────────────────────────────
   · 图视图**只画有依据的边**；NPC 可以是无边节点，**不为视觉完整虚构连线**；
   · 触控命中区 ≥44px（节点圆 r=24 + 透明命中圆 r=27，在 331px 宽手机上
     折算 ≈44 / 50px）；
   · SVG 固定 viewBox + `overflow:hidden` + `width:100%`，**不产生文档级
     横向滚动**；节点文字限制在圆内（截断），不遮挡连线与其他节点；
   · 首屏节点超过上限时如实提示「其余在列表里看」，不偷偷少画。

   ─── 页面缓存纪律（page-ta.js 同款）─────────────────────────
   `render` 只跑一次（建壳），`onShow` 才重读数据；每次 paint 全量重读
   selector（没有视图缓存可残留），换岛时把滚动归零。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;
  /* 数据层（ta-network.js 先于本文件加载）。缺失时页面给空态，不炸。 */
  var TN = Sleepy.taNetwork || null;

  var SVGNS = 'http://www.w3.org/2000/svg';
  var LABEL_NONE = (TN && TN.LABEL_NONE) || '关系未注明';
  var KIND_TEXT = { char: '岛上的角色', npc: '岛上的 NPC', user: '当前身份' };

  /* ---- 图视图几何（viewBox 单位；331px 宽手机上 1 单位 ≈ 0.80px）----
     半径是按「节点直径 48 + 标签行 13」反推的：
       R_OUTER=132 → 最下方节点 y=312，标签落在 349 < 360，不裁切；
       R_INNER=82  → 与中心圆（r=30）之间留 28 单位空隙，不压线。
     触控（真机实测反推，别照抄估计值）：
       页面左右各 22px 内边距 → 331px 宽手机上 SVG 只有 **287px**，
       缩放 k = 287/360 ≈ 0.797。命中圆 r=27 时直径 54 单位 → 43.0px，
       **差一点点不到 44**（无头 Edge 331px 实测抓到的）；r=29 → 46.2px 才够。
       所以 R_HIT=29 不是随手写的数，改小它就会掉到 44 以下。 */
  var VB = 360, CX = 180, CY = 180;
  var R_INNER = 82, R_OUTER = 132;
  var R_NODE = 24, R_HIT = 29, R_CENTER = 30;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function clip(s, n) { return TN && TN.clip ? TN.clip(s, n) : String(s == null ? '' : s); }
  function stamp(t) { return TN && TN.stampText ? (TN.stampText(t) || '未知时间') : '未知时间'; }
  function labelOf(n) { return TN && TN.labelOf ? TN.labelOf(n) : (String((n && n.label) || '') || LABEL_NONE); }

  /* ---------------------------- 小骨架（page-ta.js 同款） ---------------------------- */

  function emptyBox(title, hint) {
    var box = h('div', 'empty');
    box.appendChild(h('div', 'empty-paper'));
    box.appendChild(h('p', 'empty-text', title));
    box.appendChild(h('p', 'empty-hint', hint));
    return box;
  }

  function section(title, no) {
    var sec = h('section', 'we-sec');
    var head = h('div', 'we-sec-head');
    head.appendChild(h('span', 'we-sec-no', no));
    head.appendChild(h('span', 'we-sec-title', title));
    sec.appendChild(head);
    return sec;
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  function refText(refs) {
    return arr(refs).map(function (r) {
      if (!r) return '';
      return String(r.kind || '?') + ':' + String(r.id || r.key || '?');
    }).filter(Boolean).join(' / ');
  }

  function nameOfId(res, id) {
    if (res && res.center && res.center.id === id) return res.center.name;
    var hit = '';
    arr(res && res.nodes).forEach(function (n) { if (!hit && n.id === id) hit = n.name; });
    return hit || id;
  }

  /* ---------------------------- 页面 ---------------------------- */

  /* 视图选择：图 / 列表。render 时归位到「关系图」（设计稿 §1 默认视图）。 */
  var view = 'graph';
  /* 换岛要归零滚动（page-ta.js 同款，只盯这个） */
  var lastSb = null;

  Sleepy.register('ta-network', {
    title: '关系网',

    render: function (ctx) {
      ctx.setTitle('关系网');
      view = 'graph';
      paint(ctx);
    },

    onShow: function (ctx) { paint(ctx); }
  });

  function paint(ctx) {
    var body = ctx.body;
    var st = 0;
    try { st = body.scrollTop || 0; } catch (e) { /* 桩环境没有 */ }
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var sb = core.activeSandbox();
    if (!sb) {
      lastSb = null;
      out.appendChild(emptyBox('未落岛 / 未选角色',
        '还没有当前世界 —— 先在桌面选一间房，才有身边的人可看。'));
      return;
    }
    var sid = sb.id;
    var islandChanged = lastSb !== sid;
    lastSb = sid;

    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (!char || !user) {
      out.appendChild(emptyBox('未落岛 / 未选角色',
        '这座岛上还没有确定的「你」和「TA」。先去浮岛降落选人 —— 关系网需要明确的身份。'));
      try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
      return;
    }

    /* 唯一数据出口：显式传 sbId / charId / userId（切岛不串档） */
    var res = TN ? TN.build({ charId: char.id, userId: user.id, sbId: sid }) : null;
    if (!res || !res.ok) {
      out.appendChild(emptyBox('未落岛 / 未选角色',
        '读不到当前身份的关系数据 —— 先确认这座岛上有「你」和「TA」。'));
      try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
      return;
    }

    /* ---- 图 / 列表切换（只改展示方式） ---- */
    var seg = h('div', 'tan-seg iol-seg');
    [['graph', '关系图'], ['list', '列表']].forEach(function (o) {
      var b = h('button', 'iol-seg-btn' + (view === o[0] ? ' is-on' : ''), o[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (view === o[0]) return;
        view = o[0];
        paint(ctx);                 /* 不写、不调模型 */
      });
      seg.appendChild(b);
    });
    out.appendChild(seg);

    /* ---- 空态：无人物 ---- */
    if (!res.nodes.length) {
      out.appendChild(emptyBox('这座岛上暂时只有你们两个人，也挺好。',
        '没有别的人可以放进关系网。加人要去浮岛；想先记个候选，用 ta 首页的「＋ 补充身边的人」。'));
    } else if (view === 'graph') {
      out.appendChild(graphSection(res, ctx));
    } else {
      out.appendChild(listSection(res, ctx));
    }

    out.appendChild(h('p', 'tan-foot',
      '关系网只读：节点与连线都来自已经正式成立的人物和关系记录。' +
      '没有依据的关系不会画出来，也不会补默认的关系词。'));

    try { body.scrollTop = islandChanged ? 0 : st; } catch (e) { /* 桩环境没有 */ }
  }

  /* ---------------------------- 确定性环形布局 ----------------------------
     纯函数：同输入 → 同坐标（没有随机、没有迭代收敛，冒烟可断言）。
     有边的节点优先占内环（最多 6 个），其余（含无边 NPC）落外环；
     总量超过 selector 的上限时**如实计数**，不静默丢弃。 */
  function layoutOf(res) {
    var edgeHit = {};
    arr(res.edges).forEach(function (e) { edgeHit[e.from] = 1; edgeHit[e.to] = 1; });
    var withEdge = [], noEdge = [];
    arr(res.nodes).forEach(function (n) {
      (edgeHit[n.id] ? withEdge : noEdge).push(n);
    });
    var max = (TN && TN.GRAPH_MAX) || 8;
    var innerNodes = withEdge.slice(0, 6);
    var rest = withEdge.slice(6).concat(noEdge);
    if (innerNodes.length > max) innerNodes = innerNodes.slice(0, max);
    var room = Math.max(0, max - innerNodes.length);
    var outerNodes = rest.slice(0, room);
    var inner = place(innerNodes, R_INNER);
    var outer = place(outerNodes, R_OUTER);
    return {
      inner: inner,
      outer: outer,
      shown: inner.length + outer.length,
      total: arr(res.nodes).length
    };
  }

  function place(list, r) {
    var n = list.length;
    var out = [];
    for (var i = 0; i < n; i++) {
      /* 从正上方开始顺时针均分 —— 确定性，与数组顺序一致 */
      var ang = -Math.PI / 2 + (i * 2 * Math.PI / n);
      out.push({
        node: list[i],
        x: CX + r * Math.cos(ang),
        y: CY + r * Math.sin(ang)
      });
    }
    return out;
  }

  /* 把线缩短到圆的边缘，别让线穿进节点文字里 */
  function shorten(x1, y1, x2, y2, r1, r2) {
    var dx = x2 - x1, dy = y2 - y1;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / d, uy = dy / d;
    return { x1: x1 + ux * r1, y1: y1 + uy * r1, x2: x2 - ux * r2, y2: y2 - uy * r2 };
  }

  /* ---------------------------- 关系图视图 ---------------------------- */

  function graphSection(res, ctx) {
    var sec = section('关系图', '01');
    var L = layoutOf(res);

    /* 详情区**直接持引用**，不用 querySelector ——
       无头 DOM 桩不解析 innerHTML，元素级 querySelector 只会「凭空给一个
       元素」，用它取详情容器会让详情渲染进幽灵节点（真实浏览器里没事，
       冒烟里全查不到）。持引用两个环境都稳。 */
    var detail = h('div', 'tan-detail');
    function show(sel) { renderDetail(detail, sel, res, ctx); }

    var box = h('div', 'tan-graph');
    box.appendChild(buildSvg(res, L, show));
    sec.appendChild(box);

    if (L.total > L.shown) {
      sec.appendChild(h('p', 'tan-note',
        '图上只画了前 ' + L.shown + ' 位，另外 ' + (L.total - L.shown) + ' 位在「列表」里看。'));
    }
    if (!res.edges.length) {
      sec.appendChild(h('p', 'tan-note',
        '还没有写下关系依据，所以图上暂时没有连线 —— 没有依据的关系不会被画出来。'));
    }

    sec.appendChild(detail);
    show(null);
    return sec;
  }

  function buildSvg(res, L, onPick) {
    var svg = svgEl('svg', {
      class: 'tan-svg',
      viewBox: '0 0 ' + VB + ' ' + VB,
      role: 'img',
      'aria-label': '关系图'
    });

    var pos = {};
    pos[res.center.id] = { x: CX, y: CY, center: true, node: res.center };
    L.inner.concat(L.outer).forEach(function (p) {
      pos[p.node.id] = { x: p.x, y: p.y, center: false, node: p.node };
    });

    /* ① 先画连线（压在节点下面），每条给一个透明加粗命中区 */
    arr(res.edges).forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;                    /* 端点被首屏上限截掉 → 不画 */
      var s = shorten(a.x, a.y, b.x, b.y,
        a.center ? R_CENTER : R_NODE, b.center ? R_CENTER : R_NODE);
      svg.appendChild(svgEl('line', {
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, class: 'tan-edge'
      }));
      var hit = svgEl('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'tan-edge-hit'
      });
      hit.addEventListener('click', function () { onPick({ kind: 'edge', edge: e }); });
      svg.appendChild(hit);
      /* 刻意**不在边中点贴关系原文** —— v1 是星形（所有边都连着中心），
         而每条边的另一端节点自己就会在圆下显示同一句话（边的 label 和
         节点的 label 出自同一条记录）。两份一起画，文字几乎落在同一个位置
         （真机截图：竖直边的「中点」和节点下方标签只差 4 个单位，直接叠字）。
         关系原文的出口是三处：节点圆下的短标签、点边的详情面板、列表视图。
         哪天出现非星形的边（NPC 关系 / 三人以上），再考虑把中点标签加回来，
         加回来时必须先算它和两端节点标签的碰撞。 */
    });

    /* ② 环上节点 */
    L.inner.concat(L.outer).forEach(function (p) {
      svg.appendChild(nodeGroup(p.node, p.x, p.y, false, onPick));
    });

    /* ③ 中心节点（最后画，压在最上层） */
    svg.appendChild(nodeGroup(res.center, CX, CY, true, onPick));
    return svg;
  }

  function nodeGroup(node, x, y, isCenter, onPick) {
    var r = isCenter ? R_CENTER : R_NODE;
    var g = svgEl('g', { class: 'tan-node-g' + (isCenter ? ' is-center' : '') });
    g.appendChild(svgEl('circle', {
      cx: x, cy: y, r: r, class: isCenter ? 'tan-c-c' : 'tan-n-c'
    }));

    /* 名字在圆内（短截，避免压到连线）。**截断长度要算上省略号**：
       字体 10.5px 时一个中文字 ≈10.7 单位宽，环上圆直径只有 48，
       所以最多只能放 4 个字（含「…」）→ 截断位取 3；中心圆直径 60，
       最多 5 个字 → 截断位取 4。取大了文字会从圆里戳出来（真机实测过）。 */
    var nm = svgEl('text', {
      x: x, y: y + 4, class: 'tan-n-t', 'text-anchor': 'middle'
    });
    nm.textContent = clip(node.name, isCenter ? 4 : 3);
    g.appendChild(nm);

    /* 关系短标签在圆下 —— **只有真有依据才写**。没依据就不写占位，
       免得满屏「关系未注明」；详情与列表里会如实说明（设计稿 §2）。 */
    var label = isCenter ? String(node.relationWithUser || '') : String(node.label || '');
    if (label) {
      var lb = svgEl('text', {
        x: x, y: y + r + 13, class: 'tan-n-lb', 'text-anchor': 'middle'
      });
      lb.textContent = clip(label, 7);
      g.appendChild(lb);
    }

    /* 透明命中区：手机上 ≥44px（施工单 §1 触控要求） */
    var hit = svgEl('circle', {
      cx: x, cy: y, r: isCenter ? R_CENTER + 3 : R_HIT, class: 'tan-hit'
    });
    hit.addEventListener('click', function () { onPick({ kind: 'node', node: node }); });
    g.appendChild(hit);
    return g;
  }

  /* ---------------------------- 选中详情（图视图） ---------------------------- */

  function renderDetail(box, sel, res, ctx) {
    box.innerHTML = '';
    if (!sel) {
      box.appendChild(h('p', 'tan-detail-hint', '点一个节点或一条连线，看它的依据。'));
      return;
    }
    if (sel.kind === 'edge') {
      renderEdgeDetail(box, sel.edge, res);
      return;
    }
    renderNodeDetail(box, sel.node, res, ctx);
  }

  function renderNodeDetail(box, node, res, ctx) {
    var isCenter = node.id === res.center.id;
    var label = isCenter ? String(node.relationWithUser || '') : String(node.label || '');
    var src = isCenter ? String(node.relationWithUserSource || '') : String(node.labelSource || '');
    var kind = isCenter ? '中心角色' : (KIND_TEXT[node.kind || 'char'] || '人物');

    box.appendChild(h('p', 'tan-detail-name', node.name));
    box.appendChild(h('p', 'tan-meta', kind));
    box.appendChild(h('p', 'tan-meta',
      '关系：' + (label || LABEL_NONE) + (label ? '（出处 ' + src + '）' : '')));
    if (node.recent && node.recent.text) {
      box.appendChild(h('p', 'tan-recent',
        '最近可见近况：' + clip(node.recent.text, 60) +
        '（' + stamp(node.recent.at) + '）'));
    } else {
      box.appendChild(h('p', 'tan-meta', '最近可见近况：暂无'));
    }
    box.appendChild(h('p', 'tan-meta', '可用最近时间：' + stamp(node.updatedAt)));
    if (node.hasImpact) {
      box.appendChild(h('p', 'tan-imp-dot', '有已成立影响（具体在人物详情里看）'));
    }
    if (isCenter || node.clickable) {
      var b = h('button', 'tan-go', '查看人物详情');
      b.type = 'button';
      b.addEventListener('click', function () { ctx.open('ta-person', { id: node.id }); });
      box.appendChild(b);
    }
  }

  function renderEdgeDetail(box, e, res) {
    box.appendChild(h('p', 'tan-detail-name', e.label));
    box.appendChild(h('p', 'tan-meta',
      nameOfId(res, e.from) + ' ↔ ' + nameOfId(res, e.to) +
      '（' + (e.kind === 'charRel' ? '角色之间' : '角色与当前身份') + '）'));
    box.appendChild(h('p', 'tan-meta', '数据出处：' + (refText(e.sourceRefs) || '无')));
    box.appendChild(h('p', 'tan-meta', TN ? TN.timeNoteOf(e) : ''));
    box.appendChild(h('p', 'tan-meta', TN ? TN.visibilityNoteOf(e) : ''));
    var target = e.from;
    var b = h('button', 'tan-go', '查看「' + nameOfId(res, target) + '」的人物详情');
    b.type = 'button';
    b.addEventListener('click', function () { ctx.open('ta-person', { id: target }); });
    box.appendChild(b);
  }

  /* ---------------------------- 列表视图（等价回退） ---------------------------- */

  function listSection(res, ctx) {
    var wrap = h('div', 'tan-list');

    /* 中心角色信息 */
    var sec = section('中心角色', '01');
    var c = res.center;
    var card = h('div', 'tan-center-card');
    card.appendChild(h('p', 'tan-center-name', c.name));
    card.appendChild(h('p', 'tan-meta',
      '与当前身份的关系：' + (c.relationWithUser || LABEL_NONE) +
      ' · 可用最近时间：' + stamp(c.updatedAt)));
    if (c.recent && c.recent.text) {
      card.appendChild(h('p', 'tan-recent',
        '最近可见近况：' + clip(c.recent.text, 60) + '（' + stamp(c.recent.at) + '）'));
    }
    sec.appendChild(card);

    /* 人物行：保持 selector 的稳定顺序（名册角色 → 当前身份 → NPC） */
    arr(res.nodes).forEach(function (n) {
      var row = h(n.clickable ? 'button' : 'div',
        'tan-row' + (n.clickable ? ' tan-row-btn' : ''));
      if (n.clickable) row.type = 'button';
      var main = h('div', 'tan-row-main');
      main.appendChild(h('p', 'tan-row-tx', n.name));
      main.appendChild(h('span', 'tan-meta',
        (KIND_TEXT[n.kind || 'char'] || '人物') + ' · 关系：' + labelOf(n) +
        ' · 可用最近时间：' + stamp(n.updatedAt)));
      if (n.recent && n.recent.text) {
        main.appendChild(h('span', 'tan-recent', clip(n.recent.text, 50)));
      }
      row.appendChild(main);
      if (n.label) row.appendChild(h('span', 'tan-row-tag', n.label));
      if (n.hasImpact) row.appendChild(h('span', 'tan-imp-dot', '有已成立影响'));
      if (n.clickable) {
        row.addEventListener('click', function () { ctx.open('ta-person', { id: n.id }); });
      }
      sec.appendChild(row);
    });
    wrap.appendChild(sec);

    /* 关系依据：**如实列出**每条边与它的出处/时间/可见性 */
    var eSec = section('关系依据', '02');
    if (!res.edges.length) {
      eSec.appendChild(h('p', 'we-none',
        '还没有写下关系依据 —— 没有依据的关系不会被画出来，也不会自动补边。'));
    } else {
      arr(res.edges).forEach(function (e) {
        var row = h('div', 'tan-edge-row');
        row.appendChild(h('p', 'tan-edge-lb', e.label));
        row.appendChild(h('p', 'tan-meta',
          nameOfId(res, e.from) + ' ↔ ' + nameOfId(res, e.to) +
          ' · 出处：' + (refText(e.sourceRefs) || '无')));
        row.appendChild(h('p', 'tan-meta', TN ? TN.timeNoteOf(e) : ''));
        row.appendChild(h('p', 'tan-meta', TN ? TN.visibilityNoteOf(e) : ''));
        eSec.appendChild(row);
      });
    }
    wrap.appendChild(eSec);
    return wrap;
  }
})(window);
