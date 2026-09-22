/* ============================================================
   page-group-ai.js — 群聊调度引擎（实施总纲 v1 · 阶段 D + E）
   依赖：core.js、core-group.js、api.js、prompt-engine.js、page-island.js（关系切片，惰性）

   《实施总纲》第 7 / 8 / 11 / 12 节的落地。核心决定：

   ---- 普通轮次单调用（总纲 11.5 授权）----
     调度 + 发言在同一请求里完成：模型先给每个候选本体出 plans，
     再给 action=group_reply 的本体写 messages。总纲明确普通轮次可以
     「一次模型调用生成本波多人消息」，高风险轮次（掉马/泄密/同本体
     多账号表演）以后拆独立调用 —— 这版先不做风险分级。

   ---- 程序是裁判，模型是演员（总纲 12.3）----
     模型输出后逐条校验：发言账号是否属于 group_reply 的本体、
     是否在群内、消息数是否超预算、能否解析。校验失败重试一次，
     再失败**停波** —— 宁可群里安静一轮，也不把串脑的消息写进世界。

   ---- 自动续聊是波次循环，不是定时器（总纲 8）----
     suggestContinue && rhythm 档位允许 → 排下一波；每波重新装配
     （重新读群状态）、预算递减、user 发新消息立即作废在途的波
     （roundSeq 计数器 —— 非 streaming 请求中断不了，只能在落地前丢弃）。

   ---- 后加入成员的历史边界（总纲 4.4）----
     MVP 用提示注入表达：成员清单里标「TA 是某时刻加入的，不知道更早的群聊」，
     严格的消息级过滤（每人一份可见历史）留给 Receipt 系统。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  function gs() { return Sleepy.groupStore; }
  function island() { return Sleepy.island || null; }
  function arr(v) { return Array.isArray(v) ? v : []; }

  /* ---------------------------- 延迟补回与内心注记 ----------------------------
     总纲 6.3 / 8.5：忙碌者的「待处理」不能混进自动续聊队列。
     MVP 表达：plan.action=defer 的本体落一张 pending 条目（带 TA 当时的念头），
     下一轮装配时注入 [PENDING] 给 TA 一次「回来了」的机会，注入即清。
     同理 plans[].internalUpdate 是本体没说出口的注记，落 [LAST_ROUND_INNER]，
     下一轮还给同一个本体 —— 群里的情绪才有跨波连续性。 */

  function pendKey(groupId) { return 'groupPending:' + groupId; }
  function innerKey(groupId) { return 'groupInner:' + groupId; }

  function saveDefer(groupId, plans) {
    var list = arr(store.get(pendKey(groupId)));
    plans.forEach(function (p) {
      if (!p || p.action !== 'defer' || !entKnown(groupId, p.entityId)) return;
      list.push({
        ownerId: p.entityId,
        intent: String(p.internalUpdate || p.intent || '').slice(0, 120),
        at: Date.now()
      });
    });
    if (list.length) store.set(pendKey(groupId), list.slice(-4));
  }

  function saveInner(groupId, plans) {
    var map = store.get(innerKey(groupId)) || {};
    var dirty = false;
    plans.forEach(function (p) {
      if (!p || !p.internalUpdate) return;
      map[p.entityId] = String(p.internalUpdate).slice(0, 120);
      dirty = true;
    });
    if (dirty) store.set(innerKey(groupId), map);
  }

  function entKnown(groupId, ownerId) {
    return entitiesOf(groupId).some(function (e) { return e.ownerId === ownerId; });
  }

  function pendingText(groupId) {
    var list = arr(store.get(pendKey(groupId)));
    if (!list.length) return '';
    store.set(pendKey(groupId), []);      /* 注入即清：本轮就是 TA 补回的机会 */
    return list.map(function (p) {
      var c = core.findChar(p.ownerId);
      return '- 「' + (c ? c.name : '?') + '」之前在忙没回上，当时的念头：' + (p.intent || '（没记下）') +
        '。TA 现在回来了：重新读一遍相关消息再决定——问题还有效就引用着补答，过期了就自然略过，不要机械补台词。';
    }).join('\n');
  }

  function innerText(groupId, ownerId) {
    var map = store.get(innerKey(groupId)) || {};
    return map[ownerId] || '';
  }

  /* ---------------------------- 节奏参数 ---------------------------- */

  /* rhythm 档位 → 波次上限 / 单波本体上限 / 单波消息上限（总纲 8.2） */
  var RHYTHM = {
    off:    { waves: 0, actors: 0, msgs: 0 },
    light:  { waves: 2, actors: 2, msgs: 5 },
    active: { waves: 4, actors: 3, msgs: 8 }
  };

  /* 每个本体的「连续占据」上限：同一本体在一场对话里最多主导这么多波 */
  var MAX_WAVES_PER_ENTITY = 2;

  /* ---------------------------- 候选与切片 ---------------------------- */

  /* 本体清单：群成员按 ownerId 归并（调度去重的第一步，总纲 1.2）。
     user 本体不进 AI 候选 —— user 自己打字。 */
  function entitiesOf(groupId) {
    var out = [];
    var seen = {};
    gs().membersOf(groupId).forEach(function (m) {
      if (m.kind === 'user') return;
      if (seen[m.ownerId]) { seen[m.ownerId].accounts.push(m); return; }
      var e = {
        ownerId: m.ownerId,
        kind: m.kind,                 /* char / npc（按第一个账号的 kind） */
        accounts: [m]
      };
      seen[m.ownerId] = e;
      out.push(e);
    });
    return out;
  }

  /* 单个本体的知识切片：人设原文（截断）+ 账号名 + 关系切片。
     关系切片借用浮岛已有的数据（群岛三态 + NPC knownBy）——
     逐对关系大系统（总纲 9）在轮 6，这里先用现成的。 */
  function entityKnowledge(e, groupId) {
    var lines = [];
    var isNpc = e.kind === 'npc';
    var rec = core.findChar(isNpc ? e.ownerId : e.ownerId);
    if (!rec) return null;
    lines.push('【' + rec.name + '】本体。TA 在群里的账号：' +
      e.accounts.map(function (m) { return gs().accountMeta(m).name; }).join('、') + '。');
    var persona = String(rec.content || '').trim();
    if (persona) {
      lines.push('人设：' + (persona.length > 1200 ? persona.slice(0, 1200) + '…' : persona));
    } else {
      lines.push('人设：（没写设定，按名字和常识演一个有分寸的普通人）');
    }
    /* 角色卡的短字段（说话方式 / 当前状态 / 身份 / 红线）：走私聊 K01 的
       同一份实现（charMetaLines）。以前这里只给 content，而且 speech 只在
       NPC 分支里给 —— 于是群里的大号全是一个腔调（2026-09-22 预设通查）。 */
    var meta = (Sleepy.promptEngine && Sleepy.promptEngine.charMetaLines)
      ? Sleepy.promptEngine.charMetaLines(rec) : [];
    meta.forEach(function (t) { lines.push(t); });
    if (isNpc) {
      var knownBy = rec.knownBy || null;
      if (knownBy) {
        /* NPC 只把资料给勾了认识 TA 的人 —— 这里切给 TA 自己：TA 认识谁 */
        var names = [];
        knownBy.forEach(function (uid) {
          var u = core.findUser(uid);
          if (u) names.push(u.name);
          else {
            var c = core.findChar(uid);
            if (c) names.push(c.name);
          }
        });
        if (names.length) lines.push('TA 认识群里这些人：' + names.join('、') + '。');
      }
    }
    return lines.join('\n');
  }

  /* char↔char 关系切片（群岛三态）。island 没加载/不是群岛就没有。 */
  function pairRelText(ownerIdA, ownerIdB) {
    var isl = island();
    if (!isl || !isl.getPairRel) return '';
    var rel = isl.getPairRel(ownerIdA, ownerIdB);
    if (!rel) return '';
    if (rel === 'known') return '认识，有来往。';
    if (rel === 'met') return '见过面，但不算熟。';
    if (rel === 'unknown') return '不认识（不要表现得认识对方）。';
    return '';
  }

  /* ---------------------------- 装配 ---------------------------- */

  /* 组装一轮的 prompt。pure 函数（smoke 直接测）。
     opts = { stimulus, budget: {actors, msgs}, wave, wavesLeft, busyEntityIds } */
  function composeRound(groupId, opts) {
    opts = opts || {};
    var g = gs().findGroup(groupId);
    if (!g) return null;
    var members = gs().membersOf(groupId);
    var entities = entitiesOf(groupId);
    if (!entities.length) return null;

    var budget = opts.budget || RHYTHM.light;

    /* ---- system：卡 + 成员/知识/关系 ---- */
    var sys = [];
    sys.push(Sleepy.promptEngine.cardBody('groupRound'));

    /* 成员清单：公开视角（名字 + 身份类型 + 群主标记） */
    var memLines = members.map(function (m) {
      var meta = gs().accountMeta(m);
      var tags = [];
      if (m.kind === 'npc') tags.push('NPC');
      if (m.kind === 'user') tags.push('user 的账号');
      if (m.accountId === g.ownerAccountId) tags.push('群主');
      return '- 账号「' + meta.name + '」（' + (tags.join(' · ') || '角色账号') + '）';
    });
    sys.push('[GROUP]\n群名：' + g.name + '\n' + memLines.join('\n'));

    /* 候选本体与知识切片 */
    var entLines = entities.map(function (e) {
      var k = entityKnowledge(e, groupId) || '';
      var inner = innerText(groupId, e.ownerId);
      if (inner) k += '\n上一轮你没说出口的念头（还热着，可以自然带出来，也可以继续压着）：' + inner;
      var rels = [];
      entities.forEach(function (o) {
        if (o.ownerId === e.ownerId) return;
        var t = pairRelText(e.ownerId, o.ownerId);
        var on = core.findChar(o.ownerId);
        if (t && on) rels.push('对「' + on.name + '」：' + t);
      });
      if (rels.length) k += '\n' + rels.join('\n');
      return '[ENTITY id=' + e.ownerId + ']\n' + k + '\n[/ENTITY]';
    });
    sys.push('[ENTITY_KNOWLEDGE]\n' + entLines.join('\n\n'));
    sys.push('注意：[ENTITY id=…] 是调度用的内部编号，**绝不**出现在消息正文里；群里的人只用账号名相称。');

    /* ---- user：可见历史 + 触发 + 预算 ---- */
    var user = [];

    var msgs = gs().messagesOf(groupId);
    var recent = msgs.slice(-30);
    var histLines = recent.map(function (m) {
      if (m.type === 'system') return '（系统：' + m.content + '）';
      if (m.recalledAt) return null;    /* 撤回的原文不进历史 */
      var m0 = gs().findMember(groupId, m.senderAccountId);
      var who = m0 ? gs().accountMeta(m0).name : '?';
      var quote = '';
      if (m.replyToMessageId) {
        var src = gs().findMessage(groupId, m.replyToMessageId);
        if (src && !src.recalledAt) {
          var s0 = gs().findMember(groupId, src.senderAccountId);
          quote = '（引用 ' + (s0 ? gs().accountMeta(s0).name : '?') + '：' +
            String(src.content || '').slice(0, 24) + '）';
        }
      }
      return who + '：' + quote + String(m.content || '');
    }).filter(Boolean);

    /* 后加入成员的历史边界（MVP：提示级） */
    var lateJoiners = members.filter(function (m) {
      var joined = m.joinedAt || 0;
      var first = recent.length ? recent[0].createdAt : 0;
      return joined > first + 1000;
    });
    if (lateJoiners.length) {
      histLines.push('（注意：' + lateJoiners.map(function (m) {
        return gs().accountMeta(m).name;
      }).join('、') + ' 是后来才加入的，TA 不知道加入之前的群聊内容，不要当着 TA 的面默认 TA 知道旧事。）');
    }

    user.push('[RECENT_GROUP]\n' + (histLines.join('\n') || '（还没有人说话）'));
    var pend = pendingText(groupId);
    if (pend) user.push('[PENDING]\n这些成员之前在忙，现在到了 TA 们补回的时机：\n' + pend);
    user.push('[STIMULUS]\n' + (opts.stimulus || '（user 刚刚发了一条消息，见最后）'));
    user.push('[BUDGET] 本轮最多 ' + budget.actors + ' 个本体行动、'
      + budget.msgs + ' 条消息。这是本场对话的第 ' + (opts.wave || 1) + ' 波'
      + (opts.wavesLeft != null ? ('，最多还能再续 ' + opts.wavesLeft + ' 波') : '')
      + '。' + (opts.busyNote || ''));
    user.push('请按输出协议输出 JSON。');

    var messages = [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: user.join('\n\n') }
    ];
    return { messages: messages, entities: entities, budget: budget };
  }

  /* ---------------------------- 解析与校验（总纲 12.3）---------------------------- */

  function parseRoundJSON(raw) {
    var t = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
  }

  /* 校验模型输出。返回 { ok, messages:[{accountId, content, delayMs}], errors }
     校验不过就整波拒收 —— 半对半错的输出宁可不要（串脑的账不能记一半）。 */
  function validateRound(round, parsed, groupId) {
    var errors = [];
    if (!parsed || typeof parsed !== 'object') return { ok: false, messages: [], errors: ['不可解析'] };
    var plans = Array.isArray(parsed.plans) ? parsed.plans : [];
    var outMsgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    var entById = {};
    (round ? round.entities : entitiesOf(groupId)).forEach(function (e) {
      entById[e.ownerId] = e;
    });

    /* plans → 允许发言的本体集合 + 该本体选定的账号 */
    var allowed = {};       /* ownerId -> accountId */
    plans.forEach(function (p) {
      if (!p || !entById[p.entityId]) return;
      if (p.action !== 'group_reply') return;
      var e = entById[p.entityId];
      var acc = p.accountId && e.accounts.some(function (m) {
        return m.accountId === p.accountId;
      }) ? p.accountId : e.accounts[0].accountId;
      allowed[p.entityId] = acc;
    });

    /* 账号 id → 本体（校验发言归属） */
    var ownerOfAcc = {};
    Object.keys(entById).forEach(function (oid) {
      entById[oid].accounts.forEach(function (m) {
        ownerOfAcc[m.accountId] = oid;
      });
    });

    var budget = round ? round.budget : RHYTHM.light;
    var usedAcc = {};       /* 同一本体只用一个账号（总纲 7.3） */
    var messages = [];
    outMsgs.forEach(function (m) {
      if (messages.length >= budget.msgs) return;
      if (!m || typeof m.content !== 'string' || !m.content.trim()) return;
      var acc = m.senderAccountId;
      var oid = ownerOfAcc[acc];
      if (!oid) { errors.push('发言账号不在候选内：' + acc); return; }
      if (allowed[oid] !== acc) {
        errors.push('本体未获准发言或换用了别的账号：' + acc);
        return;
      }
      if (usedAcc[oid] && usedAcc[oid] !== acc) {
        errors.push('同一本体未经授权用了多个账号');
        return;
      }
      usedAcc[oid] = acc;
      var delay = Number(m.delayMs);
      if (!isFinite(delay)) delay = 800;
      delay = Math.max(300, Math.min(4000, delay));
      messages.push({ accountId: acc, ownerId: oid, content: m.content.trim(), delayMs: delay });
    });

    if (!Object.keys(allowed).length && outMsgs.length) {
      errors.push('没有任何本体获准发言却有消息输出');
    }
    if (!messages.length) errors.push('本波没有可落地的消息');
    return { ok: messages.length > 0 && errors.length === 0, messages: messages, errors: errors };
  }

  /* ---------------------------- 执行一轮 ---------------------------- */

  /* 每个群一把「轮次序号」锁：user 发新消息 / 新一波调度都会 +1，
     在途请求回来发现序号变了就丢弃结果（user 抢占，总纲 5.2）。 */
  var roundSeq = {};
  var busyGroups = {};
  var entityWaves = {};   /* groupId -> { ownerId: 已主导的波数 }（每场对话重置） */

  function seqOf(groupId) {
    if (!roundSeq[groupId]) roundSeq[groupId] = 0;
    return roundSeq[groupId];
  }
  function bumpSeq(groupId) {
    roundSeq[groupId] = seqOf(groupId) + 1;
    return roundSeq[groupId];
  }

  function candFor() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }

  /* 主入口。opts = { stimulus, reason: 'user'|'opening'|'continue' } */
  function runRound(groupId, opts) {
    opts = opts || {};
    var g = gs().findGroup(groupId);
    if (!g) return Promise.resolve({ ok: false, why: 'nogroup' });
    var cand = candFor();
    if (!cand) return Promise.resolve({ ok: false, why: 'noapi' });
    if (busyGroups[groupId]) return Promise.resolve({ ok: false, why: 'busy' });

    var rhythm = (g.settings && g.settings.rhythm) || 'light';
    if (opts.reason === 'continue' && rhythm === 'off') {
      return Promise.resolve({ ok: false, why: 'rhythm-off' });
    }

    var busy = busyGroups[groupId] = true;
    var mySeq = bumpSeq(groupId);
    emit('busy', groupId, true);

    /* 波次状态：continue 时预算递减、上一波的行动者这波降权 */
    var wavesUsed = opts.wavesUsed || 0;
    var rhythmCfg = RHYTHM[rhythm] || RHYTHM.light;
    if (!entityWaves[groupId]) entityWaves[groupId] = {};
    var waveCount = entityWaves[groupId];

    var budget = {
      actors: Math.min(rhythmCfg.actors, 2),
      msgs: rhythmCfg.msgs
    };

    var round = composeRound(groupId, {
      stimulus: opts.stimulus || '',
      budget: budget,
      wave: wavesUsed + 1,
      wavesLeft: rhythmCfg.waves - wavesUsed
    });
    if (!round) { busyGroups[groupId] = false; return Promise.resolve({ ok: false, why: 'nocand' }); }

    function finish(r) {
      if (busyGroups[groupId] === busy) busyGroups[groupId] = false;
      emit('busy', groupId, false);
      return r;
    }

    return Sleepy.api.requestOnce(cand, round.messages, {}).then(function (res) {
      /* user 已发新消息 / 新一轮已开：这波作废（总纲 5.2） */
      if (seqOf(groupId) !== mySeq) return finish({ ok: false, why: 'preempted' });
      if (!res.ok) return finish({ ok: false, why: 'api', error: res.error });

      var parsed = parseRoundJSON(res.content);
      if (!parsed) return finish({ ok: false, why: 'parse' });

      var v = validateRound(round, parsed, groupId);
      if (!v.ok) {
        /* 校验失败重试一次（总纲 12.3：小范围修复优先于停波） */
        return Sleepy.api.requestOnce(cand, round.messages, {}).then(function (res2) {
          if (seqOf(groupId) !== mySeq) return finish({ ok: false, why: 'preempted' });
          if (!res2.ok) return finish({ ok: false, why: 'api', error: res2.error });
          var parsed2 = parseRoundJSON(res2.content);
          var v2 = parsed2 ? validateRound(round, parsed2, groupId) : { ok: false, messages: [], errors: ['不可解析'] };
          if (!v2.ok) return finish({ ok: false, why: 'invalid', errors: v2.errors });
          return deliver(v2, parsed2);
        });
      }
      return deliver(v, parsed);
    });

    /* 落地：逐条延迟写入 + 波次记账 + 续聊判定 */
    function deliver(valid, parsed) {
      /* defer 待办与内心注记先落账（下一轮装配时读回） */
      var plans = Array.isArray(parsed.plans) ? parsed.plans : [];
      saveDefer(groupId, plans);
      saveInner(groupId, plans);

      var written = [];
      var i = 0;
      function step() {
        if (seqOf(groupId) !== mySeq) return finish({ ok: false, why: 'preempted' });
        if (i >= valid.messages.length) return afterWrite();
        var m = valid.messages[i++];
        var msg = gs().addMessage(groupId, {
          senderKind: (function () {
            var mm = gs().findMember(groupId, m.accountId);
            return mm ? mm.kind : 'char';
          })(),
          senderAccountId: m.accountId,
          content: m.content
        });
        if (msg) written.push(msg);
        emit('message', groupId, msg);
        setTimeout(step, m.delayMs);
      }

      function afterWrite() {
        /* 本体记账：主导过一波 +1，累计两波后引擎侧不再让 TA 续（提示级） */
        valid.messages.forEach(function (m) {
          waveCount[m.ownerId] = (waveCount[m.ownerId] || 0) + 1;
        });

        var suggest = !!parsed.suggestContinue;
        var wavesLeft = (RHYTHM[rhythm] || RHYTHM.light).waves - (wavesUsed + 1);
        var someoneOver = valid.messages.some(function (m) {
          return (waveCount[m.ownerId] || 0) >= MAX_WAVES_PER_ENTITY;
        });
        var canContinue = suggest && wavesLeft > 0 && !someoneOver;

        /* 波次落定 = 一次整理时机（引擎自己有阈值 + 节流） */
        if (Sleepy.groupMemory) Sleepy.groupMemory.check(groupId);

        if (canContinue && rhythm !== 'off') {
          var waitMs = 2600 + Math.floor(Math.random() * 1800);
          setTimeout(function () {
            if (seqOf(groupId) !== mySeq) return;   /* 被 user 抢占 */
            runRound(groupId, {
              reason: 'continue',
              stimulus: '（自动续聊：接着上面的群聊自然继续，重新判断谁有接话动机）',
              wavesUsed: wavesUsed + 1
            });
          }, waitMs);
        }
        return finish({ ok: true, written: written.length, suggestContinue: suggest, wavesUsed: wavesUsed + 1 });
      }

      step();
    }
  }

  /* user 发消息 → 抢占 + 开新一轮。
     抢占在先（bumpSeq 让在途的旧请求作废），再发本轮。 */
  function onUserMessage(groupId) {
    bumpSeq(groupId);
    var g = gs().findGroup(groupId);
    if (!g || !candFor()) return;
    /* 每场对话（一轮 user 触发 + 续聊链）从 user 消息重新计数 */
    entityWaves[groupId] = {};
    runRound(groupId, { reason: 'user', stimulus: '（user 刚刚在群里发了消息，见 [RECENT_GROUP] 最后）' });
  }

  /* 建群自然开场（总纲 4.3）：0~2 名有空且有动机的角色可能先说话 */
  function onOpening(groupId) {
    var g = gs().findGroup(groupId);
    if (!g) return;
    if (!g.settings || g.settings.opening !== 'natural') return;
    if (!candFor()) return;
    runRound(groupId, {
      reason: 'opening',
      stimulus: '（群聊刚创建。有空且有动机的成员可以自然开个场 —— 不强制所有人报到，允许没人说话）'
    });
  }

  /* ---------------------------- 活动广播（输入中指示） ---------------------------- */

  var listeners = [];
  function emit(type, groupId, payload) {
    listeners.forEach(function (fn) {
      try { fn(type, groupId, payload); } catch (e) { /* 页面层的事故不带回引擎 */ }
    });
  }
  function onActivity(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.groupAI = {
    RHYTHM: RHYTHM,
    entitiesOf: entitiesOf,
    composeRound: composeRound,
    parseRoundJSON: parseRoundJSON,
    validateRound: validateRound,
    runRound: runRound,
    onUserMessage: onUserMessage,
    onOpening: onOpening,
    onActivity: onActivity,
    bumpSeq: bumpSeq,
    /* 延迟补回 / 内心注记（smoke 和以后的 Receipt 系统用） */
    saveDefer: saveDefer,
    saveInner: saveInner,
    pendingText: pendingText,
    innerText: innerText
  };

})(window);
