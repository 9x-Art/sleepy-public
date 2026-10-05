/* ============================================================
   ta-proposal.js — ta 提案表 + 已成立 NPC 事件表（第四批数据层，0 模型）

   设计稿红线（第四批施工单 §0/§2/§4）：
   > 模型提出待审核 proposal → 程序校验并保存 → 用户确认或舍弃
   > → 才改变正式生活状态。

   ─── 两张表 ──────────────────────────────────────────────
   taProposals  模型产出的待审核提案。模型输出**只准落这里**，
                status=pending；未审核不改变任何正式表。
   taEvents     已成立的 NPC 事件（提案被用户接受后才写入），
                连同 char 知情记录与影响 —— 下一轮模型输入的「已成立事实」。

   ─── 校验（程序说了算）────────────────────────────────────
   · kind / operation 白名单；字段白名单（extra 只收固定键）；
  · target 必须存在且类型匹配；baseVersion 必须 === target.updatedAt，
    不匹配 → expired（版本过期不得覆盖新状态）；
   · 文本长度 ≤300、单轮数量 ≤8；
   · 高影响关键词（死亡/重伤/结婚/离婚/怀孕/前任/创伤…）→
    extra.highImpact = true：接受时必须二次确认，绝不自动成立；
   · 模型不能写正式 ID、权限、执行结果；不能代替 user 接受邀请、
    完成共同经历或发送消息；
   · requestId 幂等：同一请求重放不产生重复提案。

   ─── 接受落库（applyProposal）─────────────────────────────
   item_update   → patch taItems（白名单字段，history 留痕）
   follow_update → patch taFollows（关注没有完成态，status 永不被提案改）
   promise_review→ 只更新待核实信息（pendingWhy/evidence），不自动兑现
   npc_event     → 写入 taEvents（正式事件）
   impact_review → 往事件的 impacts 里追加（须 eventRef 存在 + 知情依据）
                   第五批：同时落「有效期 + 复核 + 反应史」字段
                   （kind/strength/expiresAt/status/reactedAt/history），
                   其中 kind 由 extra.impactKind 定（mood/situation），
                   status/expiresAt/reactedAt **不由模型决定**。
   contact_candidate → 只追加进主动消息候选队列（attentionInbox），不发送；
                   第五批：条目带 taProposalId，供引擎把决策结果写回提案。

   纪律：DEFAULTS / 删房名单 / tagScope / scoped 全套照旧；本文件 0 网络。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var KEYS = { proposals: 'taProposals', events: 'taEvents' };

  var KINDS = ['item_update', 'follow_update', 'promise_review', 'npc_event', 'impact_review', 'contact_candidate'];
  var OPERATIONS = ['add', 'update', 'resolve', 'flag_review'];
  var STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'failed'];

  /* 高影响关键词：命中 → extra.highImpact，接受需二次确认，不自动成立 */
  var HIGH_IMPACT_RE = /(死|去世|病危|重伤|车祸|结婚|离婚|怀孕|分手|前任|葬礼| crime|暴力|创伤)/;
  var MAX_TEXT = 300;
  var MAX_BATCH = 8;

  /* 提案 extra 白名单：模型能给的就这些，其余一律丢弃 */
  var EXTRA_OK = ['eventText', 'eventAt', 'knownCharId', 'basis', 'impactText', 'reviewWhen', 'targetStatus', 'targetDetail', 'targetNextCheck', 'targetLatest', 'targetNote', 'targetPendingWhy', 'targetEvidence', 'candidateName', 'candidateRole', 'direction',
    /* 第五批补：影响分「短期心绪 / 持续处境」（决定会不会随时间淡掉），
       以及处境的解除条件。模型**只能给这两样** —— status / reactedAt /
       expiresAt 是程序与玩家的事（沿用「模型不能写正式状态」的口径）。 */
    'impactKind', 'resolveWhen'];

  /* 第五批：影响的两种性质（ta-impact.js 的闭集，这里只用于落库时定型） */
  var IMPACT_KINDS = ['mood', 'situation'];
  /* 短期心绪默认 72h 到期（与 ta-impact.js 的 MOOD_TTL_MS 同值 —— 改一处要改两处） */
  var MOOD_TTL_MS = 72 * 3600 * 1000;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function nowId(p) {
    return (p || 'tp') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function rootIdOf(charId) {
    try {
      var r = (core.rootOf && core.rootOf(charId)) || null;
      return (r && r.id) || charId || null;
    } catch (e) { return charId || null; }
  }

  /* ---------------------------- 读 ---------------------------- */

  function listOf(kind, charId, filterStatus) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !charId) return [];
    var rid = rootIdOf(charId);
    return core.scoped(arr(store.get(KEYS[kind]))).filter(function (p) {
      if (!p || p.refCharId !== rid) return false;
      if (filterStatus && filterStatus.indexOf(p.status) < 0) return false;
      return true;
    }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }

  function proposalsOf(charId, filterStatus) { return listOf('proposals', charId, filterStatus); }
  function eventsOf(charId) { return listOf('events', charId); }
  function findProposalInScope(id) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !id) return null;
    var hit = null;
    core.scoped(arr(store.get(KEYS.proposals))).forEach(function (p) {
      if (p && p.id === id) hit = p;
    });
    return hit;
  }
  function findEventInScope(id) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !id) return null;
    var hit = null;
    core.scoped(arr(store.get(KEYS.events))).forEach(function (p) {
      if (p && p.id === id) hit = p;
    });
    return hit;
  }

  /* ---------------------------- 校验（纯函数） ----------------------------
   * ctx = { sandboxId, rootId, targets: {items:[],follows:[],promises:[]},
   *         events: [], existingFps: {}, now }
   * 返回 { ok, why?, highImpact?, fp } —— 不写任何存储。 */

  function fpOf(mode, p) {
    var core0 = JSON.stringify([mode, p.kind, p.operation, p.targetRef, p.summary, p.reason]);
    var h = 5381;
    for (var i = 0; i < core0.length; i++) h = ((h << 5) + h + core0.charCodeAt(i)) & 0x7fffffff;
    return h.toString(36);
  }

  function cleanText(v) {
    return String(v === undefined || v === null ? '' : v).trim().slice(0, MAX_TEXT);
  }

  function validateOne(mode, raw, ctx) {
    if (!raw || typeof raw !== 'object') return { ok: false, why: '不是对象' };
    var p = {
      kind: String(raw.kind || '').trim(),
      operation: String(raw.operation || 'update').trim(),
      targetRef: String(raw.targetRef || '').trim(),
      baseVersion: raw.baseVersion,
      summary: cleanText(raw.summary),
      reason: cleanText(raw.reason)
    };
    if (KINDS.indexOf(p.kind) < 0) return { ok: false, why: '非法 kind：' + p.kind };
    if (OPERATIONS.indexOf(p.operation) < 0) return { ok: false, why: '非法 operation：' + p.operation };
    if (!p.summary) return { ok: false, why: '没有 summary' };
    if (!p.reason) return { ok: false, why: '没有 reason（依据必须说清）' };

    /* extra 白名单收口 */
    var extra = {};
    var rawExtra = (raw.extra && typeof raw.extra === 'object') ? raw.extra : {};
    EXTRA_OK.forEach(function (k) {
      if (rawExtra[k] !== undefined && rawExtra[k] !== null && rawExtra[k] !== '') {
        extra[k] = cleanText(rawExtra[k]);
      }
    });

    var targets = ctx.targets || {};
    var target = null;
    if (p.kind === 'item_update' || p.kind === 'follow_update' || p.kind === 'promise_review') {
      var pool = p.kind === 'item_update' ? (targets.items || []) :
        (p.kind === 'follow_update' ? (targets.follows || []) : (targets.promises || []));
      target = null;
      pool.forEach(function (t) { if (t.id === p.targetRef) target = t; });
      if (!target) return { ok: false, why: 'target 不存在或类型不匹配：' + p.targetRef };
      /* baseVersion：不匹配 → 版本过期，不得覆盖新状态 */
      if (p.baseVersion !== undefined && String(p.baseVersion) !== String(target.updatedAt)) {
        return { ok: false, why: '版本过期（target 已变化）', expired: true };
      }
    }

    if (p.kind === 'npc_event') {
      /* 事件必须是已确认 NPC（在正式名册里）且允许知道这件事的语境由调用方装配 */
      var npcOk = (targets.npcs || []).some(function (n) { return n.id === p.targetRef; });
      if (!npcOk) return { ok: false, why: 'npc_event 的 target 不是已确认 NPC：' + p.targetRef };
      if (!extra.eventText) return { ok: false, why: 'npc_event 缺 extra.eventText' };
    }
    if (p.kind === 'impact_review') {
      var ev = null;
      (ctx.events || []).forEach(function (e) { if (e.id === p.targetRef) ev = e; });
      if (!ev) return { ok: false, why: 'impact_review 的 eventRef 不存在：' + p.targetRef };
      if (!extra.knownCharId || !extra.basis) {
        return { ok: false, why: '影响必须绑定知情依据（knownCharId + basis）' };
      }
    }
    if (p.kind === 'contact_candidate' && !extra.direction) {
      return { ok: false, why: 'contact_candidate 缺联系方向（direction）' };
    }

    /* 高影响：不自动成立，接受时必须二次确认 */
    var hay = [p.summary, p.reason, extra.eventText, extra.impactText].join('|');
    if (HIGH_IMPACT_RE.test(hay)) extra.highImpact = '1';

    p.extra = extra;
    return { ok: true, p: p, fp: fpOf(mode, p) };
  }

  /* 批量校验：modelRaw = { proposals: [...] }（解析后的模型输出） */
  function validateBatch(mode, modelRaw, ctx) {
    ctx = ctx || {};
    var list = arr(modelRaw && modelRaw.proposals);
    var out = { ok: true, accepted: [], failures: [], duplicate: 0, overLimit: 0 };
    if (!list.length) return out;   /* 无变化 = 空提案，合法 */
    if (list.length > MAX_BATCH) {
      list = list.slice(0, MAX_BATCH);
      out.overLimit = list.length;
    }
    var seen = {};
    list.forEach(function (raw) {
      var v = validateOne(mode, raw, ctx);
      if (!v.ok) {
        out.failures.push({ why: v.why, summary: cleanText(raw && raw.summary).slice(0, 60) });
        return;
      }
      if (seen[v.fp] || ctx.existingFps[v.fp]) { out.duplicate++; return; }
      seen[v.fp] = 1;
      out.accepted.push({ p: v.p, fp: v.fp });
    });
    return out;
  }

  /* ---------------------------- 写 ---------------------------- */

  function saveProposals(mode, batch, ctx, meta) {
    var sid = ctx.sandboxId || (core.scopeId ? core.scopeId() : null);
    if (!sid) return { ok: false, why: '没有当前岛' };
    var rid = ctx.refCharId ? rootIdOf(ctx.refCharId) : null;
    var list = arr(store.get(KEYS.proposals));
    var now = Date.now();
    batch.accepted.forEach(function (one) {
      var p = {
        id: nowId('tp'),
        refCharId: rid,
        refUserId: ctx.refUserId || null,
        kind: one.p.kind,
        operation: one.p.operation,
        targetRef: one.p.targetRef || null,
        baseVersion: one.p.baseVersion !== undefined ? one.p.baseVersion : null,
        summary: one.p.summary,
        reason: one.p.reason,
        extra: one.p.extra || {},
        sourceRefs: arr(meta && meta.sourceRefs),
        dependsOn: [],
        mode: mode,
        fp: one.fp,
        requestId: meta ? meta.requestId : null,
        modelMeta: meta ? {
          model: meta.model || '', label: meta.label || '',
          promptVer: meta.promptVer || '', at: meta.at || now
        } : null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        history: [{ from: '', to: 'pending', at: now, note: '模型提案，待审核' }]
      };
      core.tagScope(p, sid);
      list.push(p);
    });
    store.set(KEYS.proposals, list);
    return { ok: true, saved: batch.accepted.length, failed: batch.failures.length, duplicate: batch.duplicate };
  }

  /* requestId 幂等：同请求且同指纹的提案已存在 → 不再落 */
  function hasRequestFp(requestId, fp) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !requestId) return false;
    var hit = false;
    core.scoped(arr(store.get(KEYS.proposals))).forEach(function (p) {
      if (hit || !p) return;
      if (p.requestId === requestId && p.fp === fp) hit = true;
    });
    return hit;
  }

  /* ---------------------------- 审核落库 ---------------------------- */

  function findTarget(kind, targetRef, ctx) {
    var pools = ctx.targets || {};
    var pool = kind === 'item_update' ? pools.items :
      kind === 'follow_update' ? pools.follows : pools.promises;
    var hit = null;
    (pool || []).forEach(function (t) { if (t.id === targetRef) hit = t; });
    return hit;
  }

  /* 接受：按 kind 分发落库。高影响必须 confirmHighImpact=true。
   * 返回 { ok, why?, applied? } —— 失败不改正式表。 */
  function acceptProposal(id, opts) {
    opts = opts || {};
    var p = findProposalInScope(id);
    if (!p) return { ok: false, why: '提案不存在（或不在当前岛）' };
    if (p.status !== 'pending') return { ok: false, why: '提案不在待审核状态（' + p.status + '）' };
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid) return { ok: false, why: '没有当前岛' };
    if (p.extra && p.extra.highImpact === '1' && !opts.confirmHighImpact) {
      return { ok: false, why: '高影响提案需要单独确认', needConfirm: true };
    }
    var ctx = opts.ctx;
    var now = Date.now();

    function patchTarget(kind, fields, note) {
      var t = findTarget(kind, p.targetRef, ctx);
      if (!t) return null;
      /* 双保险：审核期间目标可能又变了 —— baseVersion 对不上就拒，
         绝不用旧版本覆盖新状态（施工单 §2） */
      if (p.baseVersion !== undefined && String(p.baseVersion) !== String(t.updatedAt)) {
        return { stale: true };
      }
      var key = kind === 'item_update' ? 'taItems' :
        kind === 'follow_update' ? 'taFollows' : 'taPromises';
      var list = arr(store.get(key));
      var hit = null;
      list.forEach(function (x) { if (x && x.id === t.id) hit = x; });
      if (!hit) return null;
      Object.keys(fields).forEach(function (k) {
        if (fields[k] !== undefined && fields[k] !== '') hit[k] = fields[k];
      });
      hit.updatedAt = now;
      hit.history = arr(hit.history).concat([{
        from: '', to: '', at: now,
        note: note || '接受提案 ' + p.id + '：' + p.summary.slice(0, 40)
      }]);
      store.set(key, list);
      return hit;
    }

    var applied = '';
    if (p.kind === 'item_update') {
      var ex = p.extra || {};
      var fields = {};
      if (ex.targetDetail !== undefined) fields.detail = ex.targetDetail;
      if (ex.targetNextCheck !== undefined) fields.nextCheck = ex.targetNextCheck;
      if (ex.targetStatus !== undefined && ['进行中', '受阻', '待核实', '暂停', '已完成'].indexOf(ex.targetStatus) >= 0) {
        fields.status = ex.targetStatus;
      }
      var it = patchTarget('item_update', fields, '接受提案：' + p.summary.slice(0, 40));
      if (!it) return { ok: false, why: '目标事项不见了（可能已被删除）' };
      if (it.stale) return { ok: false, why: '版本过期（目标在你审核期间又变了）—— 提案作废重提', expired: true };
      applied = 'taItems:' + it.id;
    } else if (p.kind === 'follow_update') {
      var ex2 = p.extra || {};
      var f = patchTarget('follow_update', {
        latest: ex2.targetLatest, note: ex2.targetNote
      }, '接受提案：' + p.summary.slice(0, 40));
      if (!f) return { ok: false, why: '目标关注不见了' };
      if (f.stale) return { ok: false, why: '版本过期（目标又变了）—— 提案作废重提', expired: true };
      applied = 'taFollows:' + f.id;
      /* 关注没有完成态 —— 提案里的 targetStatus 一律忽略 */
    } else if (p.kind === 'promise_review') {
      var ex3 = p.extra || {};
      var pr = patchTarget('promise_review', {
        pendingWhy: ex3.targetPendingWhy, evidence: ex3.targetEvidence
      }, '接受复核提案：' + p.summary.slice(0, 40));
      if (!pr) return { ok: false, why: '目标承诺不见了' };
      if (pr.stale) return { ok: false, why: '版本过期（目标又变了）—— 提案作废重提', expired: true };
      applied = 'taPromises:' + pr.id;
      /* 只更新待核实信息 —— 状态（待核实/已兑现/未兑现/已解除）永不由提案改 */
    } else if (p.kind === 'npc_event') {
      var ex4 = p.extra || {};
      var evList = arr(store.get(KEYS.events));
      var ev = {
        id: nowId('te'),
        refCharId: p.refCharId,
        refUserId: p.refUserId,
        npcId: p.targetRef,
        text: ex4.eventText || p.summary,
        happenedAt: ex4.eventAt ? (Date.parse(ex4.eventAt) || now) : now,
        sourceType: 'proposal',
        sourceId: p.id,
        knowledge: [],
        impacts: [],
        createdAt: now,
        updatedAt: now
      };
      core.tagScope(ev, sid);
      evList.push(ev);
      store.set(KEYS.events, evList);
      applied = 'taEvents:' + ev.id;
    } else if (p.kind === 'impact_review') {
      var ex5 = p.extra || {};
      var evId = p.targetRef;
      var evList2 = arr(store.get(KEYS.events));
      var evHit = null;
      evList2.forEach(function (e) { if (e && e.id === evId) evHit = e; });
      if (!evHit) return { ok: false, why: '事件不存在（可能已被拆岛清理）' };
      /* 第五批：影响落库时就带齐「有效期 + 复核 + 反应史」所需的字段。
         kind 决定它会不会随时间淡掉；expiresAt / status / reactedAt
         **不由模型决定**（extra 白名单里根本没有这三个键）。 */
      var ikind = IMPACT_KINDS.indexOf(ex5.impactKind) >= 0 ? ex5.impactKind : 'situation';
      evHit.impacts = arr(evHit.impacts).concat([{
        id: nowId('ti'),
        eventRef: evHit.id,
        kind: ikind,
        text: ex5.impactText || p.summary,
        knownCharId: ex5.knownCharId || null,
        basis: ex5.basis || p.reason,
        strength: 2,
        reviewWhen: ex5.reviewWhen || null,
        resolveWhen: ex5.resolveWhen || null,
        expiresAt: ikind === 'mood' ? now + MOOD_TTL_MS : null,
        status: 'active',
        reactedAt: null,
        acceptedAt: now,
        history: [{ from: '', to: 'active', at: now, note: '玩家接受影响提案' }]
      }]);
      evHit.updatedAt = now;
      store.set(KEYS.events, evList2);
      applied = 'taEvents:' + evHit.id + '/impact';
    } else if (p.kind === 'contact_candidate') {
      /* 只进主动消息候选队列，不发送 —— 队列归 root（page-proactive 同键）。
         第五批：条目带上 taProposalId —— 主动消息引擎决策落定后要按它
         把结果写回提案（「只生成候选」和「记录结果」之间的那一环）。 */
      var rid = p.refCharId;
      var aKey = 'attentionInbox:' + rid;
      var a = store.get(aKey) || { items: [], updatedAt: null };
      a.items = arr(a.items).concat([{
        content: p.summary,
        taProposalId: p.id,
        sourceRef: 'ta 提案 ' + p.id + '（' + (p.extra && p.extra.direction || '联系候选）') + '）'
      }]).slice(-4);
      a.updatedAt = new Date().toISOString();
      store.set(aKey, a);
      applied = 'attentionInbox:' + rid;
    }

    /* 回执 */
    var list = arr(store.get(KEYS.proposals));
    var hit = null;
    list.forEach(function (x) { if (x && x.id === id) hit = x; });
    if (hit) {
      hit.status = 'accepted';
      hit.appliedRef = applied;
      hit.updatedAt = now;
      hit.history = arr(hit.history).concat([{ from: 'pending', to: 'accepted', at: now, note: applied }]);
      store.set(KEYS.proposals, list);
    }
    return { ok: true, applied: applied };
  }

  function rejectProposal(id, note) {
    var p = findProposalInScope(id);
    if (!p) return { ok: false, why: '提案不存在' };
    if (p.status !== 'pending') return { ok: false, why: '提案不在待审核状态' };
    var list = arr(store.get(KEYS.proposals));
    var hit = null;
    list.forEach(function (x) { if (x && x.id === id) hit = x; });
    if (hit) {
      hit.status = 'rejected';
      hit.updatedAt = Date.now();
      hit.history = arr(hit.history).concat([{ from: 'pending', to: 'rejected', at: Date.now(), note: String(note || '玩家舍弃') }]);
      store.set(KEYS.proposals, list);
    }
    return { ok: true };
  }

  function rejectAll(charId, note) {
    var pend = proposalsOf(charId, ['pending']);
    var n = 0;
    pend.forEach(function (p) {
      if (rejectProposal(p.id, note || '全部舍弃').ok) n++;
    });
    return { ok: true, rejected: n };
  }

  /* 版本过期：pending 提案的 baseVersion 与目标当前 updatedAt 对不上 → expired */
  function expireStale(charId, ctx) {
    var pend = proposalsOf(charId, ['pending']);
    var n = 0;
    var list = arr(store.get(KEYS.proposals));
    var changed = false;
    pend.forEach(function (p) {
      if (p.kind !== 'item_update' && p.kind !== 'follow_update' && p.kind !== 'promise_review') return;
      var t = findTarget(p.kind, p.targetRef, ctx);
      if (!t) return;
      if (p.baseVersion !== undefined && String(p.baseVersion) !== String(t.updatedAt)) {
        list.forEach(function (x) {
          if (x && x.id === p.id && x.status === 'pending') {
            x.status = 'expired';
            x.updatedAt = Date.now();
            x.history = arr(x.history).concat([{ from: 'pending', to: 'expired', at: Date.now(), note: '版本过期（目标已变化）' }]);
            changed = true;
            n++;
          }
        });
      }
    });
    if (changed) store.set(KEYS.proposals, list);
    return { expired: n };
  }

  function removeProposal(id) {
    var list = arr(store.get(KEYS.proposals));
    var next = list.filter(function (x) { return !x || x.id !== id; });
    if (next.length === list.length) return false;
    store.set(KEYS.proposals, next);
    return true;
  }

  /* ---------------------------- 自主生活更新开关 ----------------------------
   * 键归 root；关闭时不生成 advance 型提案，review 不受影响；
   * 开关变更记录时间与范围；不倒灌关闭期间的生活。 */
  function autoKeyOf(charId) { return 'taAutoLife:' + rootIdOf(charId); }
  function autoLifeOf(charId) {
    var s = store.get(autoKeyOf(charId));
    return { enabled: !!(s && s.enabled), updatedAt: s ? s.updatedAt : null };
  }
  function setAutoLife(charId, enabled) {
    var rec = { enabled: !!enabled, updatedAt: new Date().toISOString(), scope: 'root' };
    store.set(autoKeyOf(charId), rec);
    return rec;
  }

  /* ---------------------------- 导出 ---------------------------- */
  Sleepy.taProposals = {
    KEYS: KEYS,
    KINDS: KINDS,
    OPERATIONS: OPERATIONS,
    STATUSES: STATUSES,
    HIGH_IMPACT_RE: HIGH_IMPACT_RE,
    IMPACT_KINDS: IMPACT_KINDS,
    MOOD_TTL_MS: MOOD_TTL_MS,
    proposalsOf: proposalsOf,
    eventsOf: eventsOf,
    findProposalInScope: findProposalInScope,
    findEventInScope: findEventInScope,
    validateOne: validateOne,
    validateBatch: validateBatch,
    saveProposals: saveProposals,
    hasRequestFp: hasRequestFp,
    acceptProposal: acceptProposal,
    rejectProposal: rejectProposal,
    rejectAll: rejectAll,
    expireStale: expireStale,
    removeProposal: removeProposal,
    autoLifeOf: autoLifeOf,
    setAutoLife: setAutoLife,
    fpOf: fpOf
  };

})(window);
