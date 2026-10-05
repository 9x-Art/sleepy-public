/* ============================================================
   ta-life.js — ta 首页三张结构化表的数据层（v1 第二批，0 模型调用）

   产品依据（docs/勘察-ta首页-2026-10-02.md 缺口清单 + 设计稿 §1/§4）：
   第一批的生活窗口只读现成来源，缺的就是设计稿 §4 说的「每个首页对象
   都能回到同源记录」。三张表把缺口补上：

     taItems    事项    { id, sandboxId, refCharId, refUserId,
                          title*, detail(阻碍/说明), status(五态闭集),
                          nextCheck(下一复核条件), sourceType, sourceId,
                          sourceRef, history[], createdAt, updatedAt }
     taPromises 承诺    { id, sandboxId, refCharId, refUserId,
                          quote*(原话), toWhom(对象), condition(条件),
                          standard(完成标准), evidence(当前证据),
                          pendingWhy(待核实原因), status, …同上 }
     taFollows  关注    { id, sandboxId, refCharId, refUserId,
                          target*(对象), reason(缘由), latest(最新已知信息),
                          sourceRef, note, …同上 }

   ─── 纪律（一条都不能少）──────────────────────────────────
   · 键登记：store.js DEFAULTS（taItems/taPromises/taFollows）
     + core.js cleanupSandbox 删房名单 —— 新增带 sandboxId 的键必须进名单，
     漏了拆岛时不清（core.js:336 原文规矩）。
   · 写入：core.tagScope() 盖当前岛章 + **全量数组** set（绝不能 set
     一个 scoped() 的结果 —— core.js:48-58）。
   · 读取：core.scoped() 按当前岛过滤；refCharId 归 root（皮套与大号
     共享同一段生活，与 charState 键归 root 同口径）。
   · 状态只认闭集：事项五态（进行中/受阻/待核实/暂停/已完成）。
     **承诺绝不自动判兑现** —— 设计稿红线「不把维修完成自动判成承诺
     兑现」：状态机里没有「事项完成 → 承诺兑现」的任何通路，
     承诺状态只能人手改，每次改动留 history。
   · 关注没有完成态：关注过期、提醒处理掉 ≠ 事项完成或承诺解除
     （设计稿 §1 红线），只有 note 备注，不设状态机。
   · 0 模型调用：本层不做任何网络请求，模型产出通道（待校验提案）
     留给以后的批次。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var KEYS = { items: 'taItems', promises: 'taPromises', follows: 'taFollows', drafts: 'taNpcDrafts' };

  /* 闭集：第一批施工单 §三 B 给的五态；承诺四态（手动，无自动通路） */
  var ITEM_STATUS = ['进行中', '受阻', '待核实', '暂停', '已完成'];
  var PROMISE_STATUS = ['待核实', '已兑现', '未兑现', '已解除'];

  function arr(v) { return Array.isArray(v) ? v : []; }
  function nowId() {
    return 'ta' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* refCharId 归 root：皮套写下的也是大号的生活（charState 同口径） */
  function rootIdOf(charId) {
    try {
      var r = (core.rootOf && core.rootOf(charId)) || null;
      return (r && r.id) || charId || null;
    } catch (e) { return charId || null; }
  }

  /* ---------------------------- 读 ---------------------------- */

  /* 当前岛 × 当前角色（root 口径）。user 维度只对承诺生效 ——
     事项和关注是「TA 的生活」，不按马甲隔离；承诺是「TA 对这个
     马甲」的，换马甲不串（跟 links 的 (charId × userId) 同理）。 */
  function listOf(kind, charId, userId) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !charId) return [];
    var rid = rootIdOf(charId);
    var list = core.scoped(arr(store.get(KEYS[kind]))).filter(function (it) {
      if (!it || it.refCharId !== rid) return false;
      if (kind === 'promises' && userId && it.refUserId &&
          it.refUserId !== userId) return false;
      return true;
    });
    return list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function itemsOf(charId) { return listOf('items', charId); }
  function promisesOf(charId, userId) { return listOf('promises', charId, userId); }
  function followsOf(charId) { return listOf('follows', charId); }

  /* 按 id 找（详情页用）：只在**当前岛**范围里找 —— 杜绝跨岛任意 id 读取
     （page-collection findInScope 同款纪律）。 */
  function findInScope(kind, id) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !id) return null;
    var hit = null;
    core.scoped(arr(store.get(KEYS[kind]))).forEach(function (it) {
      if (it && it.id === id) hit = it;
    });
    return hit;
  }

  /* ---------------------------- 写 ----------------------------
     全量数组改完整体 set；tagScope 盖章；绝不 set scoped() 的结果。 */

  function add(kind, rec, sandboxId) {
    var sbId = sandboxId || (core.scopeId ? core.scopeId() : null);
    if (!sbId) return null;
    var now = Date.now();
    var item = {
      id: nowId(),
      refCharId: rootIdOf(rec.refCharId),
      refUserId: rec.refUserId || null,
      sourceType: rec.sourceType || 'manual',
      sourceId: rec.sourceId || null,
      sourceRef: rec.sourceRef || null,
      history: [],
      createdAt: now,
      updatedAt: now
    };
    /* 各表的业务字段原样带上（title/quote/target 等由调用方给） */
    var OWN = {
      items: ['title', 'detail', 'status', 'nextCheck'],
      promises: ['quote', 'toWhom', 'condition', 'standard', 'evidence', 'pendingWhy', 'status'],
      follows: ['target', 'reason', 'latest', 'note']
    };
    arr(OWN[kind]).forEach(function (k) {
      if (rec[k] !== undefined) item[k] = rec[k];
    });
    if (kind === 'items' && ITEM_STATUS.indexOf(item.status) < 0) item.status = '进行中';
    if (kind === 'promises' && PROMISE_STATUS.indexOf(item.status) < 0) item.status = '待核实';

    var key = KEYS[kind];
    var list = arr(store.get(key));
    list.push(item);
    core.tagScope(item, sbId);
    store.set(key, list);
    return item;
  }

  function patch(kind, id, fields) {
    var key = KEYS[kind];
    var list = arr(store.get(key));
    var hit = null;
    list.forEach(function (it) { if (it && it.id === id) hit = it; });
    if (!hit) return null;
    Object.keys(fields || {}).forEach(function (k) {
      if (fields[k] !== undefined) hit[k] = fields[k];
    });
    hit.updatedAt = Date.now();
    store.set(key, list);
    return hit;
  }

  /* 状态流转：只认闭集；每次流转留 history（from → to + at + note）。
     注意 promise 返回 null 就是拒绝（非法状态 / 找不到 / 跨岛），调用方
     别拿 undefined 冒充成功。 */
  function setStatus(kind, id, status, note) {
    var set = kind === 'items' ? ITEM_STATUS : PROMISE_STATUS;
    if (set.indexOf(status) < 0) return null;
    var key = KEYS[kind];
    var list = arr(store.get(key));
    var hit = null;
    list.forEach(function (it) { if (it && it.id === id) hit = it; });
    if (!hit) return null;
    if (hit.status === status) return hit;         /* 幂等：同状态不算流转 */
    var from = hit.status || '';
    hit.status = status;
    hit.updatedAt = Date.now();
    hit.history = arr(hit.history).concat([{
      from: from, to: status, at: Date.now(),
      note: String(note || '').trim()
    }]);
    store.set(key, list);
    return hit;
  }

  function remove(kind, id) {
    var key = KEYS[kind];
    var list = arr(store.get(key));
    var next = list.filter(function (it) { return !it || it.id !== id; });
    if (next.length === list.length) return false;
    store.set(key, next);
    return true;
  }

  /* ---------------------------- 一键转正（第三批） ----------------------------
   * 兜底来源（openLoops / attentionInbox / lifeFeed）→ 结构化表。
   * 去重靠 source 指纹：sourceType + sourceId（内容哈希），同一来源
   * 重复转正只命中已有记录，绝不建第二条。原始来源只读不动。
   * ------------------------------------------------------------------ */

  /* djb2：够用的稳定内容指纹（转正去重用，不做安全） */
  function hashText(s) {
    var h = 5381;
    var str = String(s || '');
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) & 0x7fffffff;
    }
    return h.toString(36);
  }

  /* 来源指纹：kind 内按 (sourceType, sourceId) 找已转正的记录 */
  function findBySource(kind, sourceType, sourceId) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !sourceType || !sourceId) return null;
    var hit = null;
    core.scoped(arr(store.get(KEYS[kind]))).forEach(function (it) {
      if (hit || !it) return;
      if (it.sourceType === sourceType && it.sourceId === sourceId) hit = it;
    });
    return hit;
  }

  /* ---------------------------- NPC 草稿（第三批） ----------------------------
   * 设计稿红线：未确认 NPC 只能是草稿 —— 不进正式名册（npcsOfRoom /
   * charsOfSandbox 读的是 characters 表，草稿在独立键上，天然隔离）、
   * 不进聊天召回、不进日程与生活推进。
   * 确认入库 = 调用既有 core.upsertChar（唯一正式通道），成功回执写
   * formalCharId；**重试幂等**：已 confirmed 且有回执的直接返回，
   * 不会再建第二个正式 NPC。创建失败 status=failed、草稿保留。
   * 三个授权是三个独立字段：existsConfirmed / userKnowsInStory /
   * autonomousDevelopmentAllowed —— 互不代替，缺一不自动补。 */

  function draftOwnFields(rec, d) {
    ['name', 'role', 'personality', 'interactionStyle', 'meetingOpportunity',
      'reasonToStayConnected', 'closenessAndBoundary', 'ownLife',
      'currentThreadProposal', 'sourceType', 'sourceRef'].forEach(function (k) {
        if (rec[k] !== undefined) d[k] = rec[k];
      });
    ['existsConfirmed', 'userKnowsInStory', 'autonomousDevelopmentAllowed'].forEach(function (k) {
      if (rec[k] !== undefined) d[k] = !!rec[k];
    });
    return d;
  }

  function addDraft(rec, sandboxId) {
    var sbId = sandboxId || (core.scopeId ? core.scopeId() : null);
    if (!sbId) return null;
    var now = Date.now();
    var d = {
      id: nowId(),
      refCharId: rootIdOf(rec.refCharId),
      refUserId: rec.refUserId || null,
      status: 'draft',
      formalCharId: null,
      history: [{ from: '', to: 'draft', at: now, note: '新建草稿' }],
      sourceType: 'manual',
      createdAt: now,
      updatedAt: now
    };
    draftOwnFields(rec, d);
    var list = arr(store.get(KEYS.drafts));
    list.push(d);
    core.tagScope(d, sbId);
    store.set(KEYS.drafts, list);
    return d;
  }

  function patchDraft(id, fields) { return patch('drafts', id, fields); }

  function findDraftInScope(id) { return findInScope('drafts', id); }

  /* 草稿按 (岛 × root) 读。filterStatus 不传 = 全部（幕后管理要看到
   * confirmed 的回执）；传数组则只列这些状态。 */
  function draftsOf(charId, filterStatus) {
    var rid = rootIdOf(charId);
    return listOf('drafts', charId).filter(function (d) {
      if (!filterStatus) return true;
      return filterStatus.indexOf(d.status) >= 0;
    });
  }

  function setDraftStatus(id, status, note) {
    var OK = ['draft', 'discarded', 'confirmed', 'failed'];
    if (OK.indexOf(status) < 0) return null;
    var key = KEYS.drafts;
    var list = arr(store.get(key));
    var hit = null;
    list.forEach(function (it) { if (it && it.id === id) hit = it; });
    if (!hit) return null;
    if (hit.status === status) return hit;
    hit.history = arr(hit.history).concat([{
      from: hit.status, to: status, at: Date.now(), note: String(note || '').trim()
    }]);
    hit.status = status;
    hit.updatedAt = Date.now();
    store.set(key, list);
    return hit;
  }

  /* 正式人物卡：草稿字段拼成 content 文本（正式人物的 content 就是
   * 人物卡文本，page-idcard 同一落点），不新增人物字段。 */
  function draftContent(d) {
    function sec(title, v) {
      var t = String(v || '').trim();
      return t ? '【' + title + '】' + t : '';
    }
    return [
      sec('身份', d.role),
      sec('性格与相处', d.personality || d.interactionStyle),
      sec('相识来由', d.meetingOpportunity),
      sec('为什么留在身边', d.reasonToStayConnected),
      sec('亲疏与边界', d.closenessAndBoundary),
      sec('他自己的生活', d.ownLife),
      sec('当前线索', d.currentThreadProposal),
      '【来源】ta 候选草稿 ' + d.id + '（玩家确认入库；故事内 ' +
        (d.userKnowsInStory ? 'user 认识他' : 'user 尚不认识他') +
        '；自主发展' + (d.autonomousDevelopmentAllowed ? '允许' : '不允许') + '）'
    ].filter(Boolean).join('\n');
  }

  function confirmDraft(id, flags) {
    var d = findDraftInScope(id);
    if (!d) return { ok: false, why: '找不到草稿（或不在当前岛）' };
    /* 幂等：已确认且有回执 → 原样返回，绝不再建第二个正式 NPC */
    if (d.status === 'confirmed' && d.formalCharId) {
      return { ok: true, formalCharId: d.formalCharId, dup: true };
    }
    if (!flags || !flags.existsConfirmed) {
      return { ok: false, why: '未勾选「确认这个 NPC 存在」' };
    }
    var sb = core.activeSandbox ? core.activeSandbox() : null;
    if (!sb) return { ok: false, why: '没有当前岛' };
    var name = String(d.name || '').trim();
    if (!name) return { ok: false, why: '草稿没有名字' };
    var prevStatus = d.status;   /* history 的 from 要的是确认前的状态 */
    var now = Date.now();
    var ch = null;
    try {
      /* 唯一正式通道：core.upsertChar（NPC 归岛口径，
         parentType='sandbox' + parentId=sb.id，page-idcard doSave 同款） */
      ch = core.upsertChar({
        name: name,
        kind: 'npc',
        parentId: sb.id,
        parentType: 'sandbox',
        content: draftContent(d)
      });
    } catch (e) {
      setDraftStatus(id, 'failed', '创建失败：' + (e && e.message ? e.message : '未知错误'));
      return { ok: false, why: '创建失败（草稿已保留，可重试）' };
    }
    if (!ch || !ch.id) {
      setDraftStatus(id, 'failed', '创建失败：upsertChar 没有返回人物');
      return { ok: false, why: '创建失败（草稿已保留，可重试）' };
    }
    /* 故事内 user 认识他 → 建既有关系（links，认知 aware）；
       不认识 → 不建 link，只记在回执里。没有第三条通路。 */
    var linkMade = false;
    if (flags.userKnowsInStory && d.refUserId && core.addLink) {
      try {
        core.addLink(ch.id, d.refUserId, 'aware', false, sb.id);
        linkMade = true;
      } catch (e) { /* 建链失败不阻断入库，回执里如实记 */ }
    }
    var key = KEYS.drafts;
    var list = arr(store.get(key));
    var hit = null;
    list.forEach(function (it) { if (it && it.id === id) hit = it; });
    if (!hit) return { ok: false, why: '回执写不回去（草稿不见了）' };
    hit.status = 'confirmed';
    hit.formalCharId = ch.id;
    hit.existsConfirmed = true;
    hit.userKnowsInStory = !!flags.userKnowsInStory;
    hit.autonomousDevelopmentAllowed = !!flags.autonomousDevelopmentAllowed;
    hit.linkMade = linkMade;
    hit.confirmedAt = now;
    hit.updatedAt = now;
    hit.history = arr(hit.history).concat([{
      from: prevStatus, to: 'confirmed',
      at: now, note: '正式入库：' + ch.id
    }]);
    store.set(key, list);
    return { ok: true, formalCharId: ch.id };
  }

  function removeDraft(id) { return remove('drafts', id); }

  /* ---------------------------- K03e 进行中的生活（统一编译出口） ----------------------------
   * 三场景（F1 私聊线上 / F2 私聊线下 / 主动消息）共用的**唯一**筛选与格式化
   * 逻辑 —— prompt-engine.compileTaLife 与 page-proactive.buildSystem 都只调这里，
   * 不各自维护第二份文案。
   *
   * · 只读：走 itemsOf / promisesOf / followsOf（同源：当前岛 × root × 适用 user），
   *   零模型调用、零业务状态写入；pending 提案（taProposals，ta-proposal.js）
   *   完全不经过这里 —— 提案不是成立事实。
   * · 无数据返回 ''（program 槽空文本自动不上）。
   * · 筛选按真实状态枚举（不造新状态名）：
   *     items    进行中/受阻/待核实/暂停 = 仍在进行（按真实状态表述）；
   *              已完成 = 终止，不作为当前进行中的生活。
   *     promises 待核实/未兑现 = 仍然有效（原话+条件+完成标准原样保留，
   *              **绝不写成已兑现**）；已兑现/已解除 = 终止，排除。
   *     follows  没有状态机（设计稿 §1 红线），全部按仍有效处理；
   *              没有「新进展」这个字段，latest 是最新已知信息，不补造进展。
   * · 选序稳定可复现：queryText 相关（二字片段重合，只排序、不做阈值闸）
   *   优先 → 状态优先级（进行中 > 待核实 > 受阻 > 暂停）→ updatedAt 新→旧；
   *   每类最多 LIFE_MAX_EACH 条，记录行合计超 LIFE_BUDGET 即止（如实裁剪）。
   * · nextCheck 是「下一复核条件」的**文字**（page-ta 录入口径，不是时间戳）：
   *   原样带上即可，复核不改变任何状态语义，也不由这里推断复核结果。
   * · 表达边界：整块只作为角色内部的生活背景 —— 不指令角色必须提起、
   *   不生成「告诉对方」的许可；自己的打算与缘由说不说，由角色按人设判断。
   * · 为什么不借 ta-impact.relevance：那边 rel<REL_MIN 是**拒绝闸**，
   *   这里只做**选序**且三表消费不该依赖 ta-impact 在场 —— 语义与依赖都不同，
   *   在此独立实现一份最小 scorer（选序用途，两边各自演进互不牵连）。 */
  var LIFE_MAX_EACH = 2;
  var LIFE_BUDGET = 900;   /* 记录行合计字符预算（不含块首块尾） */

  function lifeGrams(s) {
    var t = String(s || '').replace(/\s+/g, '');
    var out = [];
    for (var i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
    return out;
  }
  function lifeRel(query, hay) {
    var q = lifeGrams(query).slice(0, 80);
    if (!q.length) return 0;
    var set = {};
    lifeGrams(hay).forEach(function (g) { set[g] = 1; });
    var hit = 0;
    q.forEach(function (g) { if (set[g]) hit++; });
    return hit ? hit / Math.min(q.length, Math.max(1, Object.keys(set).length)) : 0;
  }
  function lifeClip(s, n) {
    var t = String(s == null ? '' : s).trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function lifeRankPick(list, rankOf, query) {
    return list
      .map(function (it) {
        var hay = [it.title, it.quote, it.target, it.detail, it.latest,
          it.reason, it.condition, it.standard, it.toWhom]
          .map(function (v) { return String(v || ''); }).join(' ');
        return { it: it, rel: lifeRel(query, hay), rank: rankOf(it) };
      })
      .sort(function (a, b) {
        if (b.rel !== a.rel) return b.rel - a.rel;
        if (a.rank !== b.rank) return a.rank - b.rank;
        return (b.it.updatedAt || 0) - (a.it.updatedAt || 0);
      })
      .slice(0, LIFE_MAX_EACH)
      .map(function (x) { return x.it; });
  }

  function compileLivingLife(charId, userId, opts) {
    try {
      opts = opts || {};
      var query = String(opts.queryText || '');

      /* —— 事项：终止（已完成）排除，其余按真实状态准确表达 —— */
      var items = lifeRankPick(
        itemsOf(charId).filter(function (it) { return it && it.status && it.status !== '已完成'; }),
        function (it) {
          var R = { '进行中': 0, '待核实': 1, '受阻': 2, '暂停': 3 };
          return R[it.status] !== undefined ? R[it.status] : 9;
        },
        query);
      /* —— 承诺：终止（已兑现/已解除）排除；按 refUserId 隔离由 promisesOf 保证 —— */
      var promises = lifeRankPick(
        promisesOf(charId, userId).filter(function (p) {
          return p && p.status && p.status !== '已兑现' && p.status !== '已解除';
        }),
        function (p) { return p.status === '待核实' ? 0 : 1; },
        query);
      /* —— 关注：无状态机，全部仍有效 —— */
      var follows = lifeRankPick(followsOf(charId), function () { return 0; }, query);

      if (!items.length && !promises.length && !follows.length) return '';

      var lines = [];
      var used = 0;
      function put(s) {
        if (used + s.length > LIFE_BUDGET) return false;   /* 超预算如实裁剪，顺序稳定 */
        lines.push(s);
        used += s.length;
        return true;
      }
      items.forEach(function (it) {
        var s = '· 事项（' + it.status + '）：' + lifeClip(it.title, 60);
        if (it.detail) s += ' —— ' + lifeClip(it.detail, 80);
        if (it.nextCheck) s += '（下一复核：' + lifeClip(it.nextCheck, 40) + '）';
        put(s);
      });
      promises.forEach(function (p) {
        var s = '· 承诺（' + p.status + '）：「' + lifeClip(p.quote, 80) + '」';
        if (p.toWhom) s += '（对象：' + lifeClip(p.toWhom, 30) + '）';
        if (p.condition) s += '；条件：' + lifeClip(p.condition, 60);
        if (p.standard) s += '；完成标准：' + lifeClip(p.standard, 60);
        if (p.status === '待核实' && p.pendingWhy) s += '（待核实原因：' + lifeClip(p.pendingWhy, 60) + '）';
        put(s);
      });
      follows.forEach(function (f) {
        var s = '· 关注：' + lifeClip(f.target, 60);
        if (f.latest) s += ' —— 最新已知：' + lifeClip(f.latest, 80);
        if (f.reason) s += '（缘由：' + lifeClip(f.reason, 60) + '）';
        put(s);
      });
      if (!lines.length) return '';              /* 全被预算裁掉 = 无可注入 */

      return [
        '[TA_LIFE]',
        '这是你自己正在进行的生活记录（事项 / 承诺 / 关注），只作为背景，帮你想得起自己正在过什么日子。'
      ].concat(lines, [
        '这些只是背景：不必每句话都提，不必因此主动联络对方；属于你自己的打算和缘由，说与不说由你按人设和关系判断。',
        '承诺是否兑现不由你在这轮宣布，照实承认现状就好。',
        '[/TA_LIFE]'
      ]).join('\n');
    } catch (e) {
      return '';                                 /* ta 出问题绝不影响聊天 */
    }
  }

  /* ---------------------------- 导出 ----------------------------
     冒烟核对：闭集 / 隔离 / 拆岛清理 / 承诺无自动通路。 */
  Sleepy.taLife = {
    KEYS: KEYS,
    ITEM_STATUS: ITEM_STATUS,
    PROMISE_STATUS: PROMISE_STATUS,
    itemsOf: itemsOf,
    promisesOf: promisesOf,
    followsOf: followsOf,
    findInScope: findInScope,
    add: add,
    patch: patch,
    setStatus: setStatus,
    remove: remove,
    rootIdOf: rootIdOf,
    /* K03e 进行中的生活（统一编译出口）：三场景共用，见函数头注释 */
    compileLivingLife: compileLivingLife,
    LIFE_MAX_EACH: LIFE_MAX_EACH,
    LIFE_BUDGET: LIFE_BUDGET,
    /* 第三批：一键转正 + NPC 草稿 */
    hashText: hashText,
    findBySource: findBySource,
    addDraft: addDraft,
    patchDraft: patchDraft,
    findDraftInScope: findDraftInScope,
    draftsOf: draftsOf,
    setDraftStatus: setDraftStatus,
    confirmDraft: confirmDraft,
    removeDraft: removeDraft,
    DRAFT_STATUS: ['draft', 'discarded', 'confirmed', 'failed']
  };

})(window);
