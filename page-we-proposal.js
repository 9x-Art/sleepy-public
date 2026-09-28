/* ============================================================
   page-we-proposal.js — We 收藏馆 P2 · char 提议 → user 确认入馆
   ------------------------------------------------------------
   定位（docs/勘察-We收藏馆P2-提议入馆-2026-09-27.md + 拍板）：
   char 可以**提议**把一件日历约定收进收藏馆，但 char 不能直接写
   正式馆藏 —— weEntries 只收 user 确认过的记录。

   数据边界（拍板 §一）：
   · 独立 scoped store `weProposals`，pending **绝不**进 weEntries；
   · accepted 后经 Sleepy.weStore.add（weAdd）复制生成正式记录
     （createdBy:'char' + confirmedBy:'user' + confirmedAt）；
   · declined 只留状态做去重，不生成 weEntries。

   模型标签协议（拍板 §二，复用单聊搭载标签协议）：
     [收藏提议:calendarEventId|kind|理由]
   模型只许带这三个字段；sandboxId / refCharId / refUserId / title /
   at / sourceRef / originMessageId / dedupeKey 全部由程序按当前 chat
   与真实日历事件生成，模型自报值一律不采信。
   格式非法 / 字段缺失 / 理由超长 / kind 不在白名单 → 静默丢弃，不影响聊天。

   来源核验（拍板 §三，fail closed）：
   · sourceType 只允许 'calendar'（本轮不开放其他来源）；
   · 事件必须真实存在（否则 deleted）、未取消（cancelled 拒绝）、
     eventType === 'char_schedule'、ownerCharId === chat.characterId、
     事件的 sandboxId === chat.sandboxId（跨岛 / 跨角色全拒）；
   · completed 是**有效历史来源**（语义同 collectionStore.checkSource），
     可以提议、可以入馆；
   · title / at / sourceRef 一律取真实事件字段。

   作用域与身份（拍板 §四）：
   · sandboxId 取 chat 记录自身的 sandboxId（tagScope 显式盖章），
     **不读**可能漂移的全局 active 指针；
   · refCharId/refUserId 取 chat.characterId / chat.userId；
   · originChatId / originMessageId 记录提议来源，用于去重与定位。

   去重（拍板 §五，唯一出口在本文件）：
   · dedupeKey = sandboxId|refCharId|sourceType|sourceId；
   · 同 originMessageId / 已有 pending / 已 accepted / declined 冷却期内
     （DECLINE_COOLDOWN_MS）/ 同 char pending 超上限（1 条）→ 全部拒建。

   accept 幂等（拍板 §六）：
   · 只吃 status==='pending'；已 accepted（有 acceptedEntryId）重复点击
     不再生成第二条 weEntries；
   · 确认前重新核验来源 —— 已取消/已删除的事件**不能入馆**：
     proposal 保持 pending，把 why 交还给 UI 给 user 明确提示。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var KEY = 'weProposals';
  var SOURCE_TYPE = 'calendar';          /* 本轮只开放日历一种来源 */
  var REASON_MAX = 60;                   /* 理由上限（超出 → 静默丢弃） */
  var DECLINE_COOLDOWN_MS = 7 * 86400000; /* declined 冷却：7 天内同源不再提 */
  var MAX_PENDING_PER_CHAR = 1;          /* 同一 char 在途 pending 上限 */

  function arr(v) { return Array.isArray(v) ? v : []; }

  /* ------------------------- 标签抽取（纯函数） -------------------------
     [收藏提议:calendarEventId|kind|理由]
     全角半角冒号都认；一条回复最多认第一个；抽出的标签从正文里剥掉。
     字段留空 / 缺失 → hit 置 null（提议整个丢弃），但**正文照样剥干净**
     —— 标签文本绝不允许留在气泡、历史或心声里。 */
  var TAG_RE = /\[收藏提议[：:]\s*([^|\]\n]*)\s*\|\s*([^|\]\n]*)\s*\|\s*([^\]\n]*)\s*\]/g;

  function extractTag(raw) {
    var hit = null;
    var text = String(raw == null ? '' : raw).replace(TAG_RE, function (_, id, kind, reason) {
      if (!hit) {
        hit = {
          sourceId: String(id || '').trim(),
          kind: String(kind || '').trim(),
          reason: String(reason || '').trim()
        };
      }
      return '';
    })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (hit && (!hit.sourceId || !hit.kind)) hit = null;
    return { text: text, hit: hit };
  }

  /* ------------------------- 去重键（唯一出口） ------------------------- */
  function dedupeKey(sandboxId, refCharId, sourceType, sourceId) {
    return [sandboxId, refCharId, sourceType, sourceId].join('|');
  }

  /* ------------------------- 存取 ------------------------- */
  function allRaw() { return arr(store.get(KEY)); }
  function saveRaw(list) { store.set(KEY, list); }
  function findRaw(id) {
    var list = allRaw();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function patchRaw(id, patch) {
    var list = allRaw();
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || list[i].id !== id) continue;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
      }
      saveRaw(list);
      return list[i];
    }
    return null;
  }

  /* 读侧一律 scoped（当前岛）——与 weEntries 同口径 */
  function scopedList() {
    return (core.scoped ? core.scoped(allRaw()) : allRaw());
  }
  function listPending() {
    return scopedList().filter(function (p) { return p && p.status === 'pending'; });
  }
  function countPending() { return listPending().length; }
  function findInScope(id) {
    var list = scopedList();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /* ------------------------- 来源核验（fail closed） -------------------------
     chat 只需要 { characterId, sandboxId }（accept 时用 proposal 自身字段拼）。
     completed 是有效历史来源 → 放行；cancelled / 不存在 / 跨角色 / 跨岛 → 拒。 */
  function validateSource(chat, sourceId) {
    var cal = Sleepy.calendar;
    if (!cal || !cal.getEvent) return { ok: false, why: 'no-calendar' };
    var ev = cal.getEvent(sourceId);
    if (!ev) return { ok: false, why: 'deleted' };
    if (ev.status === 'cancelled') return { ok: false, why: 'cancelled' };
    if (ev.eventType !== 'char_schedule') return { ok: false, why: 'type' };
    if (!chat || !chat.characterId || ev.ownerCharId !== chat.characterId) {
      return { ok: false, why: 'char' };
    }
    if (!chat.sandboxId || ev.sandboxId !== chat.sandboxId) {
      return { ok: false, why: 'scope' };
    }
    return { ok: true, event: ev };
  }

  /* 可提议候选（prompt-engine 说明书槽 + 调试用）：
     当前 char 在当前岛、char_schedule、未取消（completed 也算）。
     上限 5 条 —— 清单是闭集，模型只能从里面挑 id。 */
  function candidatesOf(charId) {
    var cal = Sleepy.calendar;
    var sid = null;
    try { sid = core.scopeId(); } catch (e) { return []; }
    if (!cal || !cal.eventsOf || !sid || !charId) return [];
    return arr(cal.eventsOf(charId)).filter(function (e) {
      return e && e.eventType === 'char_schedule' &&
        e.status !== 'cancelled' && e.sandboxId === sid;
    }).slice(0, 5);
  }

  /* ------------------------- 创建提议（唯一写入口） -------------------------
     chat：真实 chat 记录（getChat 的返回）；originMessageId：产生提议的
     assistant 消息 id；tag：extractTag 的 hit。五道去重闸 + fail closed。 */
  function createFromReply(chat, originMessageId, tag) {
    tag = tag || {};
    if (!tag.sourceId || !tag.kind) return { ok: false, why: 'bad-tag' };
    var kinds = (Sleepy.weStore && Sleepy.weStore.KINDS) ||
      ['ticket', 'photo', 'letter', 'music', 'gift', 'place', 'other'];
    if (kinds.indexOf(tag.kind) < 0) return { ok: false, why: 'kind' };
    if (!tag.reason || tag.reason.length > REASON_MAX) return { ok: false, why: 'reason' };
    /* 身份四要素缺一不可 —— 老会话没有 sandboxId 的直接拒（fail closed） */
    if (!chat || !chat.id || !chat.sandboxId || !chat.characterId || !chat.userId) {
      return { ok: false, why: 'scope' };
    }

    var list = allRaw();
    /* 闸 1：同一 originMessageId 只允许提议一次（reroll 复用同 msg.id 也拦） */
    for (var i = 0; i < list.length; i++) {
      if (list[i] && originMessageId && list[i].originMessageId === originMessageId) {
        return { ok: false, why: 'dup-message' };
      }
    }
    var key = dedupeKey(chat.sandboxId, chat.characterId, SOURCE_TYPE, tag.sourceId);
    var now = Date.now();
    var sameKey = list.filter(function (p) { return p && p.dedupeKey === key; });
    /* 闸 2/3/4：同源已有 pending / 已 accepted / declined 冷却期内 */
    for (var j = 0; j < sameKey.length; j++) {
      var p0 = sameKey[j];
      if (!p0) continue;
      if (p0.status === 'pending') return { ok: false, why: 'dup-pending' };
      if (p0.status === 'accepted') return { ok: false, why: 'dup-accepted' };
      if (p0.status === 'declined' &&
          (now - (p0.resolvedAt || 0)) < DECLINE_COOLDOWN_MS) {
        return { ok: false, why: 'cooldown' };
      }
    }
    /* 闸 5：同一 char 在途 pending 上限 */
    var myPending = list.filter(function (p) {
      return p && p.status === 'pending' &&
        p.sandboxId === chat.sandboxId && p.refCharId === chat.characterId;
    });
    if (myPending.length >= MAX_PENDING_PER_CHAR) return { ok: false, why: 'pending-limit' };

    /* 来源核验：title/at/sourceRef 全部取真实事件，模型自报值不采信 */
    var v = validateSource(chat, tag.sourceId);
    if (!v.ok) return { ok: false, why: v.why };
    var ev = v.event;

    var p = {
      id: 'wep-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      sandboxId: chat.sandboxId,       /* 显式盖 chat 自带的岛章，不走全局指针 */
      refCharId: chat.characterId,
      refUserId: chat.userId,
      status: 'pending',
      title: String(ev.title || '').trim() || '（未命名）',
      note: String(tag.reason || '').trim(),
      kind: tag.kind,
      at: ev.startAt || null,
      sourceType: SOURCE_TYPE,
      sourceId: ev.id,
      sourceRef: String(ev.startAt || '').slice(0, 10) || null,
      proposedBy: 'char',
      proposedAt: now,
      originMessageId: originMessageId || null,
      originChatId: chat.id,
      dedupeKey: key,
      resolvedBy: null,
      resolvedAt: null,
      acceptedEntryId: null
    };
    list.push(p);
    saveRaw(list);
    return { ok: true, proposal: p };
  }

  /* ------------------------- accept（幂等 + 复核） -------------------------
     已取消/已删除 → 拒绝入馆、**保留 pending**，why 交回 UI 提示 user。 */
  function accept(id) {
    var p = findRaw(id);
    if (!p) return { ok: false, why: 'not-found' };
    if (p.status === 'accepted' || p.acceptedEntryId) {
      return { ok: false, why: 'already-accepted', entryId: p.acceptedEntryId };
    }
    if (p.status !== 'pending') return { ok: false, why: 'not-pending' };

    /* 确认前重新核验来源（事件可能在提议后被人取消 / 清掉） */
    var v = validateSource(
      { characterId: p.refCharId, sandboxId: p.sandboxId, userId: p.refUserId },
      p.sourceId
    );
    if (!v.ok) return { ok: false, why: v.why, proposal: p };

    if (!Sleepy.weStore || !Sleepy.weStore.add) return { ok: false, why: 'no-westore' };
    var entry = Sleepy.weStore.add({
      title: p.title,
      note: p.note,
      at: p.at,
      kind: p.kind,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      sourceRef: p.sourceRef,
      refCharId: p.refCharId,
      refUserId: p.refUserId,
      createdBy: 'char',        /* 正式记录：他提议，我确认 */
      confirmedBy: 'user',
      confirmedAt: Date.now()
    }, p.sandboxId);
    if (!entry) return { ok: false, why: 'write-failed' };

    patchRaw(p.id, {
      status: 'accepted',
      resolvedBy: 'user',
      resolvedAt: Date.now(),
      acceptedEntryId: entry.id
    });
    return { ok: true, entry: entry, proposal: findRaw(id) };
  }

  /* ------------------------- decline（不生成 weEntries） ------------------------- */
  function decline(id) {
    var p = findRaw(id);
    if (!p || p.status !== 'pending') return { ok: false, why: 'not-pending' };
    patchRaw(p.id, { status: 'declined', resolvedBy: 'user', resolvedAt: Date.now() });
    return { ok: true, proposal: findRaw(id) };
  }

  /* ------------------------- 对外 ------------------------- */
  Sleepy.weProposals = {
    KEY: KEY,
    SOURCE_TYPE: SOURCE_TYPE,
    REASON_MAX: REASON_MAX,
    DECLINE_COOLDOWN_MS: DECLINE_COOLDOWN_MS,
    MAX_PENDING_PER_CHAR: MAX_PENDING_PER_CHAR,
    /* 纯函数（冒烟/真机共用同一实现） */
    extractTag: extractTag,
    dedupeKey: dedupeKey,
    validateSource: validateSource,
    candidatesOf: candidatesOf,
    /* 数据层唯一出口 */
    createFromReply: createFromReply,
    listPending: listPending,
    countPending: countPending,
    findInScope: findInScope,
    accept: accept,
    decline: decline
  };

})(window);
