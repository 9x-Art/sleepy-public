/* ============================================================
   ta-impact.js — 已成立影响层（第五批，0 模型、0 网络）

   前四批的 ta 是一个**独立账本**：taEvents.impacts 写得进去，聊天里一个字
   都看不见（ta-model.js 头注释原文「本轮未接线」）。本层就是那根线。

   产品依据（第五批施工单，docs/施工-ta首页第五批-2026-10-02.md）：
   > 不是让 ta 再长出新功能，而是让已经确认的生活真正影响角色的表达，
   > 同时不越过知情、权限和证据边界。

   ─── 影响的形状（扩展 taEvents[].impacts[]，老记录缺字段按缺省读，不迁移）──
   { id, eventRef, kind:'mood'|'situation', text, knownCharId, basis,
     strength:1..3, reviewWhen, resolveWhen, expiresAt, status,
     reactedAt, staleNote, acceptedAt, history[] }

   ─── 两条红线（和「事项完成 ≠ 承诺兑现」同构）─────────────────
   1. **过期 ≠ 解决**：refresh() 只会推到 faded / expired，
      代码里没有任何「时间到了 → resolved」的通路。resolved 只能人手点。
   2. **事实变了 ≠ 角色没反应过**：correctEvent() 把影响标 stale，
      但保留 reactedAt 与整份 history，也不删除记录 ——
      角色当时确实有过反应，这段经历不能被更正抹掉。

   ─── 注入只走三道闸（顺序不能换）──────────────────────────
   ① 知情闸（硬边界，fail closed）：knownCharId 必须 === rootIdOf(charId)。
      对不上连统计都不算 —— 这条守住「NPC 的私密事件不会被角色提前知道」。
   ② 有效闸：只取投影后 status === 'active' 的。
      **pending 提案天然进不来** —— 这里读的是 taEvents，pending 在 taProposals，
      两张表之间没有任何通路。
   ③ 相关闸：与本轮输入相关才注入（2-gram 近似分词，见 relevance）。
      上限 2 条、每条 60 字 —— 绝不把 ta 全部历史塞进 Prompt。

   ─── 读只投影、写要显式 ─────────────────────────────────
   compile() 是**只读**的（effectiveOf 投影，不写 store）—— 装配过程必须
   没有副作用（page-presets 也会调 assembleOnline）。
   真正落盘复核的是 refresh()，由幕后页显式调用。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var EVENTS_KEY = 'taEvents';

  /* 闭集：语义不许混（见文件头两条红线） */
  var IMPACT_STATUS = ['active', 'faded', 'expired', 'resolved', 'stale'];
  var IMPACT_KINDS = ['mood', 'situation'];
  /* 合法流转：resolved 只能从任何非 resolved 状态手动到达，且**只能人手** */
  var TRANSITIONS = {
    active: ['faded', 'expired', 'resolved', 'stale'],
    faded: ['resolved'],
    expired: ['resolved'],
    stale: ['resolved'],
    resolved: []
  };

  /* 短期心绪：默认 72h 到期；每 36h 掉 1 点强度（确定性，便于冒烟） */
  var MOOD_TTL_MS = 72 * 3600 * 1000;
  var MOOD_DECAY_MS = 36 * 3600 * 1000;
  var MAX_INJECT = 2;
  var MAX_TEXT = 60;
  var MAX_BASIS = 40;
  var REL_MIN = 0.2;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function nowId() {
    return 'ti' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function ridOf(charId) {
    try {
      if (core.rootIdOf) return core.rootIdOf(charId) || charId || null;
      var r = core.rootOf && core.rootOf(charId);
      return (r && r.id) || charId || null;
    } catch (e) { return charId || null; }
  }
  function P() { return Sleepy.taProposals || null; }
  /* 本房判定（core 没有导出 inScope，按 scoped 的同一把尺子写一份） */
  function inScope(rec) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid) return false;
    return !!rec && rec.sandboxId === sid;
  }
  function clip(s, n) {
    var t = String(s === undefined || s === null ? '' : s).trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* ---------------------------- 归一化（老记录兜底） ---------------------------- */

  function norm(im, ev, idx) {
    var o = im && typeof im === 'object' ? im : {};
    return {
      id: o.id || (String(ev.id || 'ev') + '#' + idx),
      eventRef: o.eventRef || ev.id,
      kind: IMPACT_KINDS.indexOf(o.kind) >= 0 ? o.kind : 'situation',
      text: String(o.text || ''),
      knownCharId: o.knownCharId || null,
      basis: String(o.basis || ''),
      strength: (typeof o.strength === 'number' && o.strength >= 1 && o.strength <= 3)
        ? o.strength : 2,
      reviewWhen: o.reviewWhen || null,
      resolveWhen: o.resolveWhen || null,
      expiresAt: (typeof o.expiresAt === 'number' && o.expiresAt > 0) ? o.expiresAt : null,
      status: IMPACT_STATUS.indexOf(o.status) >= 0 ? o.status : 'active',
      reactedAt: (typeof o.reactedAt === 'number' && o.reactedAt > 0) ? o.reactedAt : null,
      staleNote: o.staleNote || null,
      acceptedAt: (typeof o.acceptedAt === 'number' && o.acceptedAt > 0) ? o.acceptedAt : null,
      history: arr(o.history),
      /* 宿主事件上的只读信息，注入相关性判据要用 */
      _eventText: String(ev.text || ''),
      _eventStatus: ev.status || 'active'
    };
  }

  /* ---------------------------- 读（只读，不写 store） ---------------------------- */

  function eventsInScope() {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid) return [];
    return core.scoped(arr(store.get(EVENTS_KEY)));
  }

  /* 展平：某个角色（root 口径）名下所有影响，带宿主事件 */
  function allImpacts(charId) {
    var rid = ridOf(charId);
    if (!rid) return [];
    var out = [];
    eventsInScope().forEach(function (ev) {
      if (!ev || ev.refCharId !== rid) return;
      arr(ev.impacts).forEach(function (im, idx) {
        out.push(norm(im, ev, idx));
      });
    });
    return out;
  }

  function impactsOf(charId, filterStatus) {
    return allImpacts(charId).filter(function (im) {
      if (!filterStatus) return true;
      return filterStatus.indexOf(im.status) >= 0;
    }).sort(function (a, b) { return (b.acceptedAt || 0) - (a.acceptedAt || 0); });
  }

  /* 人物详情用：某个 NPC 名下的已成立影响（影响挂事件，事件挂 npcId） */
  function impactsForPerson(charId, personId) {
    if (!personId) return [];
    var byEvent = {};
    eventsInScope().forEach(function (ev) {
      if (ev && ev.npcId === personId) byEvent[ev.id] = 1;
    });
    return allImpacts(charId).filter(function (im) { return byEvent[im.eventRef]; });
  }

  /* 定位（幕后/详情页动作要用）：返回 { ev, im, idx } 或 null */
  function locate(impactId) {
    var sid = core.scopeId ? core.scopeId() : null;
    if (!sid || !impactId) return null;
    var hit = null;
    arr(store.get(EVENTS_KEY)).forEach(function (ev) {
      if (hit || !inScope(ev)) return;
      arr(ev.impacts).forEach(function (im, idx) {
        if (hit) return;
        var n = norm(im, ev, idx);
        if (n.id === impactId) hit = { ev: ev, im: im, idx: idx, view: n };
      });
    });
    return hit;
  }

  function locateEvent(eventId) {
    if (!eventId) return null;
    var hit = null;
    arr(store.get(EVENTS_KEY)).forEach(function (ev) {
      if (hit || !ev || ev.id !== eventId) return;
      if (!inScope(ev)) return;
      hit = ev;
    });
    return hit;
  }

  /* ---------------------------- 有效期投影（纯函数，不写） ----------------------------
   * 返回 { status, strength } —— 这是「此刻真正生效的样子」。
   * 注入只看投影；落盘由 refresh() 负责。 */
  function effectiveOf(im, now) {
    now = now || Date.now();
    var st = im.status;
    var strength = im.strength;
    if (st !== 'active') return { status: st, strength: strength };
    var base = im.acceptedAt || now;
    if (im.kind === 'mood') {
      var decay = Math.floor(Math.max(0, now - base) / MOOD_DECAY_MS);
      strength = Math.max(0, strength - decay);
      /* 强度归零 = 淡了；到期也 = 淡了。**都不是 resolved** */
      if (strength <= 0 || (im.expiresAt && now >= im.expiresAt)) {
        return { status: 'faded', strength: 0 };
      }
      return { status: 'active', strength: strength };
    }
    /* 持续处境：不衰减；到期 → 过期（**不是解决**）；
       有 resolveWhen 但条件没成立 → 保持 active（保留到解除条件成立） */
    if (im.expiresAt && now >= im.expiresAt) return { status: 'expired', strength: strength };
    return { status: 'active', strength: strength };
  }

  /* 当前真正生效、且这个人**知情**的影响（注入的候选池，只读） */
  function activeNow(charId, now) {
    var rid = ridOf(charId);
    if (!rid) return [];
    return allImpacts(charId).map(function (im) {
      var e = effectiveOf(im, now);
      return { im: im, eff: e };
    }).filter(function (x) {
      /* ① 知情闸：fail closed —— 不是这个 root 的影响一律不认 */
      if (!x.im.knownCharId || x.im.knownCharId !== rid) return false;
      /* ② 有效闸 */
      if (x.eff.status !== 'active') return false;
      /* 宿主事件被更正 → 依据已失效，不再驱动表达（reactedAt 仍保留） */
      if (x.im._eventStatus === 'corrected') return false;
      if (!String(x.im.text || '').trim()) return false;
      return true;
    }).map(function (x) {
      return {
        id: x.im.id, kind: x.im.kind, text: x.im.text, basis: x.im.basis,
        strength: x.eff.strength, acceptedAt: x.im.acceptedAt || 0,
        eventRef: x.im.eventRef
      };
    });
  }

  /* ---------------------------- 相关闸（2-gram 近似分词） ---------------------------- */

  function grams(s) {
    var t = String(s || '').replace(/[\s，。、！？…,.!?；;：:"'“”‘’（）()\[\]【】<>《》—\-~·]/g, '');
    var out = [];
    for (var i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
    return out;
  }

  /* 相关度 = 查询的二字片段里，有多少出现在 haystack 里。
     中文没有空格，2-gram 是够用且可解释的近似分词。
     命中 0 → 0；否则按 min(查询片段数, hay 片段数) 归一。 */
  function relevance(query, hay) {
    var q = grams(query).slice(0, 80);
    if (!q.length) return 0;
    var set = {};
    grams(hay).forEach(function (g) { set[g] = 1; });
    var hit = 0;
    q.forEach(function (g) { if (set[g]) hit++; });
    if (!hit) return 0;
    var hLen = Math.max(1, Object.keys(set).length);
    return hit / Math.min(q.length, hLen);
  }

  /* 挑出本轮该注入的影响：最多 MAX_INJECT 条 */
  function pick(charId, queryText, now) {
    var pool = activeNow(charId, now);
    if (!pool.length) return [];
    var q = String(queryText || '').trim();
    if (!q) {
      /* 没有「本轮输入」：只放 1 条最强最新的持续处境 —— 它本来就在他身上 */
      return pool.filter(function (x) { return x.kind === 'situation'; })
        .sort(function (a, b) {
          return (b.strength - a.strength) || ((b.acceptedAt || 0) - (a.acceptedAt || 0));
        }).slice(0, 1);
    }
    var scored = pool.map(function (x) {
      /* haystack 含影响正文 + 依据 —— 依据是「为什么他会有这个影响」，
         用户问到同一件事时命中它是合理的（不是放宽边界，是提高召回）。 */
      var hay = x.text + ' ' + (x.basis || '');
      return { x: x, score: relevance(q, hay) };
    }).filter(function (s) { return s.score >= REL_MIN; });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.x.strength !== a.x.strength) return b.x.strength - a.x.strength;
      return (b.x.acceptedAt || 0) - (a.x.acceptedAt || 0);
    });
    return scored.slice(0, MAX_INJECT).map(function (s) { return s.x; });
  }

  /* ---------------------------- 注入文本 ----------------------------
   * 只作为背景：块首块尾把用户的三条约束写成模型看得见的话。
   * 返回 '' = 不注入（槽是 program 类型，空文本自动不上）。 */
  function compile(charId, userId, queryText) {
    try {
      var rid = ridOf(charId);
      if (!rid) return '';
      var now = Date.now();
      var picked = pick(charId, queryText, now);
      if (!picked.length) { lastInject(rid, []); return ''; }
      lastInject(rid, picked.map(function (x) { return x.id; }));

      var lines = ['[TA_IMPACT]', '这是你此刻身上带着的东西，只作为背景。'];
      picked.forEach(function (x) {
        var label = x.kind === 'mood' ? '短期心绪（正在淡）' : '持续处境';
        var tail = x.basis ? '（依据：' + clip(x.basis, MAX_BASIS) + '）' : '';
        lines.push('· ' + label + '：' + clip(x.text, MAX_TEXT) + tail);
      });
      lines.push('这些只是背景，不是这轮要完成的任务 —— 不必每句话都提；' +
        '不要为了它们改变你的性格、说话方式和红线；' +
        '它们未必和对方有关，不要因此对对方冷淡、发火或索取关心。');
      lines.push('[/TA_IMPACT]');
      return lines.join('\n');
    } catch (e) {
      /* ta 出问题绝不影响聊天：装配侧拿到空串，槽位自动不上 */
      return '';
    }
  }

  /* ---------------------------- 反应史（区分「事实变了」与「已反应过」） ---------------------------- */

  var _last = {};   /* rid → { ids, at }，**内存**，不落盘、不含正文 */

  function lastInject(rid, ids) { _last[rid] = { ids: arr(ids), at: Date.now() }; }
  function lastInjected(charId) {
    var r = _last[ridOf(charId)];
    return r ? r.ids.slice() : [];
  }

  /* 聊天**回复成功落地后**调用：这一轮注入过的影响，此刻算「角色已经有过反应」。
     只记第一次（幂等）；没注入过就是空操作。 */
  function noteReply(charId, at) {
    try {
      var rid = ridOf(charId);
      var ids = lastInjected(charId);
      if (!rid || !ids.length) return { marked: 0 };
      var n = markReacted(rid, ids, at || Date.now());
      _last[rid] = { ids: [], at: Date.now() };
      return { marked: n };
    } catch (e) { return { marked: 0 }; }
  }

  function markReacted(charId, impactIds, at) {
    var rid = ridOf(charId);
    var want = arr(impactIds);
    if (!rid || !want.length) return 0;
    var list = arr(store.get(EVENTS_KEY));
    var n = 0;
    var changed = false;
    list.forEach(function (ev) {
      if (!inScope(ev) || ev.refCharId !== rid) return;
      arr(ev.impacts).forEach(function (im, idx) {
        if (!im) return;
        var nid = im.id || (String(ev.id || 'ev') + '#' + idx);
        if (want.indexOf(nid) < 0) return;
        if (typeof im.reactedAt === 'number' && im.reactedAt > 0) return;   /* 只记第一次 */
        im.reactedAt = at || Date.now();
        changed = true;
        n++;
      });
    });
    if (changed) store.set(EVENTS_KEY, list);
    return n;
  }

  /* ---------------------------- 落盘复核（显式写） ----------------------------
   * ⚠️ store.get 是**深拷贝**（store.js:327）—— 改 locate()/findXxxInScope()
   * 返回的对象是改在副本上，随后 store.set 写回去的却是原件（等于没改）。
   * 所以所有写入都必须「拿到即将写回的那份数组 → 在里面改 → 整体 set」。 */

  function pushHistory(im, from, to, note, now) {
    im.history = arr(im.history).concat([{ from: from, to: to, at: now, note: note }]);
  }

  /* 在**即将写回的那份数组**里按 impact id 找并改；fn 返回 false = 拒绝改。 */
  function mutateImpact(impactId, fn) {
    var list = arr(store.get(EVENTS_KEY));
    var hit = false;
    list.forEach(function (ev) {
      if (hit || !inScope(ev)) return;
      arr(ev.impacts).forEach(function (im, idx) {
        if (hit || !im) return;
        var nid = im.id || (String(ev.id || 'ev') + '#' + idx);
        if (nid !== impactId) return;
        if (fn(im, ev) === false) return;
        hit = true;
      });
    });
    if (hit) store.set(EVENTS_KEY, list);
    return hit;
  }

  /* 推进有效期：把投影结果落盘。**只会推到 faded / expired**，
     没有任何「时间到了 → resolved」的通路（红线 1）。 */
  function refresh(charId, now) {
    var rid = ridOf(charId);
    if (!rid) return { faded: 0, expired: 0, changed: 0 };
    now = now || Date.now();
    var list = arr(store.get(EVENTS_KEY));
    var out = { faded: 0, expired: 0, changed: 0 };
    var dirty = false;
    list.forEach(function (ev) {
      if (!inScope(ev) || ev.refCharId !== rid) return;
      arr(ev.impacts).forEach(function (im, idx) {
        if (!im) return;
        /* 已经是终态（faded/expired/resolved/stale）的不再推进 */
        if (im.status && im.status !== 'active') return;
        var view = norm(im, ev, idx);
        var eff = effectiveOf(view, now);
        if (eff.status === view.status) return;
        if (eff.status === 'faded') {
          im.status = 'faded';
          im.strength = 0;
          pushHistory(im, 'active', 'faded', '心绪减弱淡了（不是解决）', now);
          out.faded++;
        } else if (eff.status === 'expired') {
          im.status = 'expired';
          pushHistory(im, 'active', 'expired', '超过复核期（过期不是解决）', now);
          out.expired++;
        }
        dirty = true;
        out.changed++;
      });
    });
    if (dirty) store.set(EVENTS_KEY, list);
    return out;
  }

  /* 手动改状态：只认合法流转，resolved 只能从非 resolved 手动到达 */
  function setStatus(impactId, status, note) {
    if (IMPACT_STATUS.indexOf(status) < 0) return null;
    var cur = locate(impactId);
    if (!cur) return null;
    var from = cur.view.status;
    if (from === status) return cur.view;                     /* 幂等 */
    if (arr(TRANSITIONS[from]).indexOf(status) < 0) return null;
    var now = Date.now();
    var ok = mutateImpact(impactId, function (im) {
      im.status = status;
      if (status === 'resolved' && !im.resolvedAt) im.resolvedAt = now;
      pushHistory(im, from, status, String(note || '').trim() ||
        (status === 'resolved' ? '玩家标记为已解决（只能人手）' : '状态变更'), now);
      return true;
    });
    if (!ok) return null;
    var after = locate(impactId);
    return after ? after.view : null;
  }

  function resolveImpact(impactId, note) {
    return setStatus(impactId, 'resolved', note || '玩家标记为已解决');
  }

  /* 事件被更正：区分「事实变了」和「角色之前已经有过反应」——
     影响标 stale、写明更正说明，但 **reactedAt 与 history 原样保留**，
     记录一条都不删。 */
  function correctEvent(eventId, note) {
    if (!locateEvent(eventId)) return { ok: false, why: '事件不存在（或不在当前岛）' };
    var now = Date.now();
    var noteT = String(note || '').trim() || '玩家更正了这件事';
    var marked = 0;
    var list = arr(store.get(EVENTS_KEY));
    list.forEach(function (ev) {
      if (!inScope(ev) || ev.id !== eventId) return;
      ev.status = 'corrected';
      ev.correctedAt = now;
      ev.correctNote = noteT;
      ev.updatedAt = now;
      arr(ev.impacts).forEach(function (im) {
        if (!im) return;
        var cur = IMPACT_STATUS.indexOf(im.status) >= 0 ? im.status : 'active';
        if (cur === 'stale' || cur === 'resolved') return;
        im.status = 'stale';
        im.staleNote = noteT;
        /* 关键：reactedAt 不动 —— 他当时确实有过反应 */
        pushHistory(im, cur, 'stale', '事实已更正：' + noteT, now);
        marked++;
      });
    });
    store.set(EVENTS_KEY, list);
    return { ok: true, marked: marked, keptReacted: true };
  }

  /* ---------------------------- 主动消息最小闭环（第五批第 3 条） ----------------------------
   * 队列 → 既有闸门 → 既有发送机制；ta 侧只**记结果**，不发送、不改频率。 */

  function contactProposals(charId) {
    var p = P();
    if (!p) return [];
    return p.proposalsOf(charId, ['accepted']).filter(function (x) {
      return x && x.kind === 'contact_candidate';
    });
  }

  /* 已接受但还没有结果的联系候选（幕后展示用） */
  function pendingContact(charId) {
    return contactProposals(charId).filter(function (x) { return !x.outcome; });
  }

  /* 决策落定后写回提案。幂等：已记过 send 就不再覆盖（send 是终态）。
     ⚠️ 同 §落盘复核 的深拷贝纪律：必须在**即将写回的那份数组**里改。 */
  function noteProactive(charId, rec) {
    try {
      var p = P();
      if (!p || !rec || !rec.proposalId) return { ok: false, why: '没有提案 id' };
      var list = arr(store.get(p.KEYS.proposals));
      var hit = null;
      list.forEach(function (x) {
        if (hit || !x || x.id !== rec.proposalId) return;
        if (core.scopeId && core.scopeId() && x.sandboxId !== core.scopeId()) return;
        hit = x;
      });
      if (!hit || hit.kind !== 'contact_candidate') {
        return { ok: false, why: '找不到联系候选提案' };
      }
      var decision = String(rec.decision || 'skip');
      if (hit.outcome && hit.outcome.decision === 'send') {
        return { ok: true, dup: true, decision: 'send' };        /* 终态不覆盖 */
      }
      var now = rec.at || Date.now();
      hit.outcome = {
        decision: decision,
        at: now,
        messageId: rec.messageId || null,
        via: 'proactive'
      };
      hit.updatedAt = now;
      hit.history = arr(hit.history).concat([{
        from: hit.status, to: hit.status, at: now,
        note: '主动消息判断结果：' + decision + (rec.messageId ? '（' + rec.messageId + '）' : '')
      }]);
      store.set(p.KEYS.proposals, list);
      return { ok: true, decision: decision };
    } catch (e) {
      return { ok: false, why: (e && e.message) || '写回失败' };
    }
  }

  /* ---------------------------- 导出 ---------------------------- */
  Sleepy.taImpact = {
    IMPACT_STATUS: IMPACT_STATUS,
    IMPACT_KINDS: IMPACT_KINDS,
    MOOD_TTL_MS: MOOD_TTL_MS,
    MAX_INJECT: MAX_INJECT,
    REL_MIN: REL_MIN,
    allImpacts: allImpacts,
    impactsOf: impactsOf,
    impactsForPerson: impactsForPerson,
    activeNow: activeNow,
    effectiveOf: effectiveOf,
    relevance: relevance,
    pick: pick,
    compile: compile,
    refresh: refresh,
    setStatus: setStatus,
    resolveImpact: resolveImpact,
    correctEvent: correctEvent,
    lastInjected: lastInjected,
    noteReply: noteReply,
    markReacted: markReacted,
    pendingContact: pendingContact,
    contactProposals: contactProposals,
    noteProactive: noteProactive,
    locate: locate,
    locateEvent: locateEvent
  };

})(window);
