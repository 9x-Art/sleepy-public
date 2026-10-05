/* ============================================================
   ta-network.js — ta 关系网只读 selector（第一批，0 模型 0 网络 0 写入）

   产品依据：
     · 《Sleepy · ta 关系网 v1 · 产品与第一批施工设计稿》§2/§3/§4/§7
     · 《ta 关系网 v1 · 第一批只读施工单》§0 已锁定决策 / §1
     · docs/勘察-ta关系网-2026-10-02.md（只读勘察，七问逐条 + P1–P4）

   ─── 它是什么 ──────────────────────────────────────────────
   把「当前角色身边的人」投影成一份**只读**结果：
     { ok, why, sbId, center, nodes, edges, visibility, updatedAt }
   图视图与列表视图**必须消费同一份结果** —— 页面组件不许自己拼人物数据
   （设计稿 §7 原文）。`page-ta.js` 的「04 身边的人」也改读这里，
   所以「人物节点集合」的**唯一出口就是本文件**（施工单 §2 原文）。

   ─── 数据来源：全部是既有出口（不新写查询、不新增 store 键）──────
     中心 / 正式角色  core.charsOfSandbox(sb)             core.js:460
     岛内 NPC        core.npcsOfRoom(sb)                 core.js:542（全仓唯一口径）
     char × user     core.findLink(charId,userId,sbId)   core.js:1077（深拷贝，只读）
     char × char     Sleepy.island.getPairRel(sbId,a,b)  page-island.js:658（导出 :1698）
     近况            Sleepy.momentsTab.canSee            page-moments.js:99
     已成立影响       Sleepy.taImpact.activeNow            ta-impact.js（三道闸已内置）

   ─── 三条红线（一条都不能松）─────────────────────────────
   1. **只有有依据的关系才画边**（设计稿 §3）。
      · char×user：link 存在 **且 `relation` 有文本** —— 施工单 §0 原文
        「仅有记录不等于可显示」。光有一条 link 记录不画边。
      · char×char：charRel 是 `known` / `met`；`unknown` **不画**。
        原因：`getPairRel` 无法区分「显式设成不认识」和「压根没记录」
        （都返回 'unknown'），所以一律当「无依据」处理 —— 宁可少画，
        也不把「没记录」说成「不认识」。
      · NPC 与任何人：**本仓库没有任何 NPC 关系记录**（勘察 §6.3）→
        NPC 只有节点、没有边。**绝不为视觉完整虚构连线**。
   2. **读取阶段就过滤**，不是隐藏详情（设计稿 §4）。节点集合、边、近况、
      `hasImpact` 全在这里过闸；视图层根本拿不到被过滤掉的东西。
   3. **不写、不调模型、不发网络**（施工单 §1 末条 + 静态冒烟护栏）。
      `store.get` 是深拷贝，本文件只读它。

   ─── NPC knownBy 显示闸（**fail 方向和注入侧刻意相反**）──────────
     · 字段缺失 / 空数组 / 非数组 → **fail open**（显示）。
       显示层理由：`page-ta.js` 的 04 现在就显示这些老 NPC，
       突然不显示才是设计稿 §4 说的「数量变化泄露」。
     · 字段有值但不含中心角色（root 或本身 id）→ **fail closed**（不显示）。
     ⚠️ 注入侧（page-switch.js:544-546 `compileIslandKB`）是 **fail closed**：
       空数组 = 不注入。那是**角色认知层**，这是**玩家显示层** ——
       两者 fail 方向本来就该相反。**不要「统一」它们**（施工单 §0 明写）。

   ─── P1：关系文本没有更新时间 ────────────────────────────
     `links` 只有 `createdAt`；`setRelation()` 改 relation 文本时
     **不写任何时间戳**（core.js:1156-1167）。所以：
       · 节点/边的 `updatedAt` = **可用最近时间**，不是关系变更时间；
       · `relationTimeKnown` 恒为 `false`，页面必须如实说
         「关系文本的修改时间不可知」，不许编一个「更新于」。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;

  /* 没有依据时的关系标签（设计稿 §2：不补写「朋友/亲密/家人」这类默认词） */
  var LABEL_NONE = '关系未注明';
  /* labelSource 闭集（施工单 §1 原文）：只有这三种取值 */
  var LABEL_SOURCES = ['link.relation', 'charRel', ''];
  /* charRel 三态原文 —— 与 page-island.js:662 的 REL_LABELS 同口径，
     只做「原文搬运」，**不扩成朋友/家人等语义**（施工单 §4 明写不做）。 */
  var PAIR_TEXT = { known: '认识', met: '见过但不熟', unknown: '不认识' };
  /* 图视图首屏节点上限（不含中心）。超出的在列表里看全 —— 施工单 §1 要求
     「节点数量较多时优先保证可读性」，所以上限放在 selector 里当常量导出。 */
  var GRAPH_MAX = 8;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clip(s, n) {
    var t = String(s === undefined || s === null ? '' : s).trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }
  function nameOf(c) { return String((c && c.name) || '').trim() || '未命名'; }
  function num(v) { return (typeof v === 'number' && v > 0) ? v : 0; }

  function rootIdOf(charId) {
    try {
      if (core.rootIdOf) return core.rootIdOf(charId) || charId || null;
      var r = core.rootOf && core.rootOf(charId);
      return (r && r.id) || charId || null;
    } catch (e) { return charId || null; }
  }

  /* 岛：显式传就用传的（切岛后必须按新的岛重读），否则取当前岛 */
  function sbOf(sbId) {
    try {
      if (sbId && core.findSandbox) return core.findSandbox(sbId);
      return core.activeSandbox ? core.activeSandbox() : null;
    } catch (e) { return null; }
  }

  /* ---------------------------- 近况（唯一实现） ----------------------------
     从 page-ta.js:146-161 **原样搬过来**（语义不变）——
     关系网和首页 04、人物详情三处必须是同一份实现，所以本文件是它的家，
     `page-ta.js` 改成引用这里（第一批施工单 §2 要求 04 与关系网同源）。

     只取 TA **本人发的**、当前账号**能看见**的最新一条朋友圈：
       · `m.maskId` 非空 = 马甲发的 → 跳过；
       · `momentsTab.canSee(m, userId)` = user 视角三道闸（账号隔离 /
         朋友权限四开关 / 动态可见范围），**方向别写反** —— 那是 canCharSee
         的事，写反就成了「角色偷看你设了私密的东西」。 */
  function latestVisibleMoment(charId, userId) {
    try {
      var M = Sleepy.momentsTab;
      if (!M || !M.all || !M.canSee || !charId || !userId) return null;
      var best = null;
      core.scoped(M.all()).forEach(function (m) {
        if (!m || m.status === 'deleted' || m.maskId) return;   /* 只看 TA 本人发的 */
        if (m.characterId !== charId) return;
        if (!M.canSee(m, userId)) return;
        var at = typeof m.at === 'number' ? m.at : Date.parse(String(m.at || '')) || 0;
        var text = String(m.text || '').trim() || '（只发了一张图）';
        if (!best || at > best.at) best = { at: at, text: text };
      });
      return best;
    } catch (e) { return null; }
  }

  /* ---------------------------- 权限闸 ---------------------------- */

  /* NPC 显示闸：见文件头「fail 方向和注入侧刻意相反」。
     返回 true = 可以进节点集合。 */
  function npcPassesKnownBy(npc, centerId, centerRoot) {
    if (!npc || !npc.id) return false;
    if (!has(npc, 'knownBy')) return true;                    /* 缺字段 → fail open */
    var kb = npc.knownBy;
    if (!Array.isArray(kb) || !kb.length) return true;        /* 空 / 非数组 → fail open */
    if (centerId && kb.indexOf(centerId) >= 0) return true;
    if (centerRoot && kb.indexOf(centerRoot) >= 0) return true;
    return false;                                             /* 有值但不含中心 → fail closed */
  }

  /* charRel 三态（只读；拿不到岛模块就按「无依据」处理，不编关系） */
  function pairOf(sbId, a, b) {
    try {
      var isl = Sleepy.island;
      if (!isl || !isl.getPairRel) return 'unknown';
      return isl.getPairRel(sbId, a, b) || 'unknown';
    } catch (e) { return 'unknown'; }
  }

  /* char × user 的 link：**必须显式带 sbId** ——
     同一对 (char × user) 在两间房里各有一条，不传就会串档
     （core.js:1072-1076 / 1094-1097 原文）。返回深拷贝，只读。 */
  function linkOf(charId, userId, sbId) {
    try {
      if (!core.findLink || !charId || !userId || !sbId) return null;
      return core.findLink(charId, userId, sbId);
    } catch (e) { return null; }
  }

  /* link 的可见性语义（照 core.js:1176-1184 的四开关原文，不自己另判） */
  function linkPerms(link) {
    if (!link) return null;
    return {
      cognition: link.cognition || 'unaware',
      barrier: !!link.barrier,
      iHideChar: !!link.iHideChar,
      iHideFromChar: !!link.iHideFromChar,
      charHidesMe: !!link.charHidesMe,
      charHidesFromMe: !!link.charHidesFromMe
    };
  }

  /* 已成立影响 → 宿主事件的 npcId 集合（**只出 id，绝不带正文上屏**）。
     三道闸复用 `taImpact.activeNow`：知情 fail closed × 有效 × 事件未被更正。
     于是 pending 提案（在 taProposals 另一张表）/ 未成立事件 /
     已淡 / 已过期 / 私密（别人知情的）影响天然进不来（设计稿 §5 逐条）。 */
  function impactPersonsOf(centerCharId) {
    var out = {};
    try {
      var ti = Sleepy.taImpact;
      if (!ti || !ti.activeNow || !centerCharId) return out;
      arr(ti.activeNow(centerCharId)).forEach(function (x) {
        if (!x || !x.eventRef || !ti.locateEvent) return;
        var ev = ti.locateEvent(x.eventRef);
        if (ev && ev.npcId) out[ev.npcId] = 1;
      });
    } catch (e) { /* 影响层没就绪 / 抛错 → 一律不显示，但不阻断关系网 */ }
    return out;
  }

  /* ---------------------------- 主入口 ---------------------------- */

  /* build({ charId, userId, sbId }) —— 全部参数可选：
       不传 charId → 当前角色（指针卫兵 core.activeCharOnIsland）；
       不传 userId → 当前身份；不传 sbId → 当前岛。
     显式传的值**必须在本岛名册里**才算数（否则按 no-char 处理），
     这样切岛时拿旧 id 也读不出旧数据。 */
  function build(input) {
    var inp = (input && typeof input === 'object') ? input : {};
    var out = {
      ok: false,
      why: '',                       /* '' | 'no-island' | 'no-char' */
      sbId: '',
      center: null,
      nodes: [],
      edges: [],
      visibility: {
        knownByGate: 'center-root',  /* 显示闸口径，写死给冒烟断言看 */
        dropped: 0,                  /* 被 knownBy 闸挡掉的 NPC 数（**不上屏**） */
        hasUser: false,
        graphMax: GRAPH_MAX
      },
      updatedAt: 0
    };

    var sb = sbOf(inp.sbId);
    if (!sb) { out.why = 'no-island'; return out; }
    out.sbId = sb.id;

    /* ---- ① 中心角色：必须在本岛正式名册里（main 口径）---- */
    var roster = arr(core.charsOfSandbox ? core.charsOfSandbox(sb) : []).filter(function (c) {
      return c && c.id && (c.kind || 'main') === 'main';
    });
    var center = null;
    var wantChar = String(inp.charId || '').trim();
    if (wantChar) {
      roster.forEach(function (c) { if (!center && c.id === wantChar) center = c; });
    } else {
      var ac = null;
      try { ac = core.activeCharOnIsland ? core.activeCharOnIsland() : null; } catch (e) { ac = null; }
      if (ac) roster.forEach(function (c) { if (!center && c.id === ac.id) center = c; });
    }
    if (!center) { out.why = 'no-char'; return out; }
    var centerRoot = rootIdOf(center.id) || center.id;

    /* ---- ② 当前身份（我）----
       **不在本岛名册就没有 user 节点，这不是错误** ——
       施工单 §1 要的四种空态（未落岛 / 无角色 / 无人物 / 无关系边）里
       没有「无身份」这一种，所以不设 why。 */
    var masks = arr(core.masksOfSandbox ? core.masksOfSandbox(sb) : []);
    var user = null;
    var wantUser = String(inp.userId || '').trim();
    if (wantUser) {
      masks.forEach(function (u) { if (!user && u.id === wantUser) user = u; });
    } else {
      var au = null;
      try { au = core.activeUserOnIsland ? core.activeUserOnIsland() : null; } catch (e) { au = null; }
      if (au) masks.forEach(function (u) { if (!user && u.id === au.id) user = u; });
    }
    var userId = user ? user.id : '';
    out.visibility.hasUser = !!user;

    var impactPersons = impactPersonsOf(center.id);

    /* ---- ③ 节点集合 ---- */
    var nodes = [];
    var byId = {};
    function pushNode(n) {
      if (!n || !n.id || byId[n.id]) return null;
      byId[n.id] = n;
      nodes.push(n);
      return n;
    }
    /* 「可用最近时间」：近况时间优先，其次记录自己的 updatedAt / createdAt。
       ⚠️ 这不是关系变更时间（P1，见文件头）。 */
    function stampOf(rec, recent) {
      var cands = [];
      if (recent && num(recent.at)) cands.push(recent.at);
      if (rec) {
        if (num(rec.updatedAt)) cands.push(rec.updatedAt);
        else if (num(rec.createdAt)) cands.push(rec.createdAt);
      }
      return cands.length ? Math.max.apply(null, cands) : 0;
    }
    function recentOf(id) { return userId ? latestVisibleMoment(id, userId) : null; }

    /* ① 当前身份（我）：只有在本岛名册里才有这个节点 */
    var linkCU = null;
    if (user) {
      linkCU = linkOf(center.id, user.id, sb.id);
      var relU = linkCU ? String(linkCU.relation || '').trim() : '';
      pushNode({
        id: user.id,
        kind: 'user',
        name: core.labelOfUser ? core.labelOfUser(user) : '我',
        label: relU,
        labelSource: relU ? 'link.relation' : '',
        recent: null,                       /* 「我」没有可展示的近况 */
        hasImpact: false,                   /* hasImpact 语义 = 「与这个人的已成立影响」 */
        updatedAt: linkCU ? num(linkCU.createdAt) : 0,
        sourceRefs: linkCU ? [{ kind: 'link', id: linkCU.id }] : [{ kind: 'user', id: user.id }],
        /* ta-person 只认 char / npc，user 节点不给详情入口，避免跳到空详情 */
        clickable: false
      });
    }

    /* ② 岛名册里的其他正式角色（排除中心自己） */
    roster.forEach(function (c) {
      if (!c || c.id === center.id) return;
      var rel = pairOf(sb.id, center.id, c.id);
      var lbl = (rel === 'known' || rel === 'met') ? (PAIR_TEXT[rel] || '') : '';
      var rc = recentOf(c.id);
      /* 这个角色与**当前身份**的正式关系（links 那条），和上面的
         charRel（与中心角色的三态）不是一回事，两个都如实带出去，
         由页面决定说哪个 —— selector 只负责投影，不做取舍。
         ⚠️ `user` 可能是 null（这座岛还没定我是谁）—— 上面注释里写了
         「不在本岛名册就没有 user 节点，这不是错误」，所以这里必须先判空，
         否则「未选身份」的岛一打开关系网就 TypeError（冒烟抓到过）。 */
      var lcu = user ? linkOf(c.id, user.id, sb.id) : null;
      var relU = lcu ? String(lcu.relation || '').trim() : '';
      pushNode({
        id: c.id,
        kind: 'char',
        name: nameOf(c),
        label: lbl,
        labelSource: lbl ? 'charRel' : '',
        relationWithUser: relU,
        relationWithUserSource: relU ? 'link.relation' : '',
        recent: rc,
        hasImpact: !!impactPersons[c.id],
        updatedAt: stampOf(c, rc),
        sourceRefs: [{ kind: 'char', id: c.id }],
        clickable: true
      });
    });

    /* ③ 岛内 NPC：正式口径 + knownBy 显示闸。
       草稿永远进不来 —— `taNpcDrafts` 是独立键、不进 characters 表，
       本文件**一次都没有读它**（施工单 §1「绝不读取 taNpcDrafts」）。 */
    var dropped = 0;
    arr(core.npcsOfRoom ? core.npcsOfRoom(sb) : []).forEach(function (n) {
      if (!n || !n.id || n.id === center.id) return;
      if (!npcPassesKnownBy(n, center.id, centerRoot)) { dropped++; return; }
      var rn = recentOf(n.id);
      pushNode({
        id: n.id,
        kind: 'npc',
        name: nameOf(n),
        /* NPC 与任何人都没有关系记录 → 没有依据 → 标签留给页面显示「关系未注明」 */
        label: '',
        labelSource: '',
        recent: rn,
        hasImpact: !!impactPersons[n.id],
        updatedAt: stampOf(n, rn),
        sourceRefs: [{ kind: 'npc', id: n.id }],
        clickable: true
      });
    });
    out.visibility.dropped = dropped;

    /* ---- ④ 边：只来自真实记录，节点集合内两两检查 ---- */
    var inSet = {};
    inSet[center.id] = 1;
    nodes.forEach(function (n) { inSet[n.id] = 1; });
    var edges = [];
    var edgeSeen = {};

    function pushEdge(e) {
      if (!e || !e.from || !e.to || e.from === e.to) return;
      var key = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
      if (edgeSeen[key]) return;
      edgeSeen[key] = 1;
      edges.push(e);
    }

    /* ① char × user：**必须有 relation 文本**才算依据（施工单 §0
       「仅有记录不等于可显示」+ 设计稿 §3「有明确 relation 才画关系边」） */
    if (user) {
      var charIds = [center.id];
      nodes.forEach(function (n) { if (n.kind === 'char') charIds.push(n.id); });
      charIds.forEach(function (cid) {
        var l = (cid === center.id) ? linkCU : linkOf(cid, user.id, sb.id);
        if (!l) return;
        var txt = String(l.relation || '').trim();
        if (!txt) return;                       /* 有记录、没写关系 → 不画边 */
        pushEdge({
          id: 'e:lk:' + l.id,
          from: cid,
          to: user.id,
          kind: 'link',
          label: txt,
          labelSource: 'link.relation',
          sourceRefs: [{ kind: 'link', id: l.id }],
          updatedAt: num(l.createdAt),
          timeKnown: !!num(l.createdAt),
          /* P1：links 没有 updatedAt —— 关系文本的修改时间本仓库不存在 */
          relationTimeKnown: false,
          perms: linkPerms(l)
        });
      });
    }

    /* ② char × char：charRel 三态，只有 known / met 画边 */
    var charNodes = [center.id];
    nodes.forEach(function (n) { if (n.kind === 'char') charNodes.push(n.id); });
    for (var i = 0; i < charNodes.length; i++) {
      for (var j = i + 1; j < charNodes.length; j++) {
        var a = charNodes[i], b = charNodes[j];
        var pr = pairOf(sb.id, a, b);
        if (pr !== 'known' && pr !== 'met') continue;   /* unknown → 不画 */
        pushEdge({
          id: 'e:cr:' + (a < b ? a + '|' + b : b + '|' + a),
          from: a,
          to: b,
          kind: 'charRel',
          label: PAIR_TEXT[pr] || '',
          labelSource: 'charRel',
          sourceRefs: [{ kind: 'charRel', key: (a < b ? a + '|' + b : b + '|' + a) }],
          updatedAt: 0,
          /* charRel 的值就是裸字符串，**没有任何时间戳** */
          timeKnown: false,
          relationTimeKnown: false,
          perms: null
        });
      }
    }
    /* ③ NPC 的边：本仓库不存在任何 NPC 关系记录 → 一条都不产生。
       这里刻意什么都不做 —— 「不为视觉完整虚构连线」（施工单 §1 末条）。 */

    out.nodes = nodes;
    out.edges = edges;

    /* ---- ⑤ 中心节点 ---- */
    var centerRecent = recentOf(center.id);
    var relCU = linkCU ? String(linkCU.relation || '').trim() : '';
    out.center = {
      id: center.id,
      kind: 'char',
      name: nameOf(center),
      rootId: centerRoot,
      /* 中心 × 我 的正式关系原文（空 = 没写，页面显示「关系未注明」） */
      relationWithUser: relCU,
      relationWithUserSource: relCU ? 'link.relation' : '',
      /* 有没有那条 link（**有没有记录**和**有没有写关系**是两件事，
         首页 04 的「已建立联系」用这个，别用 relationWithUser 空串猜） */
      hasLinkWithUser: !!linkCU,
      recent: centerRecent,
      updatedAt: stampOf(center, centerRecent),
      sourceRefs: [{ kind: 'char', id: center.id }]
    };

    /* 整份结果的「可用最近时间」= 所有节点里最新的那个（不是 now） */
    var stamps = [out.center.updatedAt];
    nodes.forEach(function (n) { stamps.push(num(n.updatedAt)); });
    out.updatedAt = stamps.length ? Math.max.apply(null, stamps) : 0;

    out.ok = true;
    return out;
  }

  /* ---------------------------- 小工具（给页面用） ----------------------------
     标签与时间都是**展示口径**，放在这里保证图视图和列表视图说同一句话。 */

  /* 节点的关系短标签：没有依据就「关系未注明」，**绝不补默认关系词**。 */
  function labelOf(node) {
    if (!node) return LABEL_NONE;
    var t = String(node.label || '').trim();
    return t || LABEL_NONE;
  }

  /* 关系记录的时间说明（P1）：如实区分「有建立时间」与「修改时间不可知」。 */
  function timeNoteOf(edge) {
    if (!edge) return '';
    if (edge.kind === 'charRel') {
      return '这条三态关系记录没有时间戳（charRel 的值就是裸字符串）';
    }
    if (!edge.timeKnown) return '这条关系记录没有可用的时间';
    return '建立于 ' + stampText(edge.updatedAt) + '；关系文本的修改时间不可知';
  }

  /* 边的可见性说明：只讲**玩家自己的**配置（认知 / 记忆壁垒），
     不复述对方设的朋友圈开关 —— 那是 canSee 的活，不在文案里展开。 */
  var COG_TEXT = { aware: '知道我是谁', unaware: '不知道我的马甲', single: '没有别的号' };
  function visibilityNoteOf(edge) {
    if (!edge) return '';
    if (edge.kind === 'charRel') {
      return '群岛角色之间的三态关系记录（认识 / 见过但不熟）；' +
        '它只表示「认识与否」，不代表关系内容。';
    }
    var p = edge.perms;
    if (!p) return '当前岛的正式关系记录。';
    var bits = ['这是当前身份与 TA 在这座岛上的正式关系记录。'];
    if (p.barrier) bits.push('记忆壁垒：开着 —— 大号小号的记忆绝对隔离。');
    else bits.push('记忆壁垒：没有开。');
    bits.push('认知：' + (COG_TEXT[p.cognition] || p.cognition) + '。');
    bits.push('朋友圈可见性另有四个开关，不影响这条关系本身。');
    return bits.join('');
  }

  function stampText(t) {
    var ms = num(t);
    if (!ms) return '';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  Sleepy.taNetwork = {
    LABEL_NONE: LABEL_NONE,
    LABEL_SOURCES: LABEL_SOURCES,
    PAIR_TEXT: PAIR_TEXT,
    GRAPH_MAX: GRAPH_MAX,

    build: build,

    /* 近况的唯一实现（page-ta.js 也引用这里，别再各写一份） */
    latestVisibleMoment: latestVisibleMoment,

    /* 展示口径 */
    labelOf: labelOf,
    timeNoteOf: timeNoteOf,
    visibilityNoteOf: visibilityNoteOf,
    stampText: stampText,

    /* 给冒烟用的纯函数（不导出内部状态） */
    npcPassesKnownBy: npcPassesKnownBy,
    clip: clip
  };
})(window);
