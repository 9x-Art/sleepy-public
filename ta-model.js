/* ============================================================
   ta-model.js — ta 专用模型模块（第四批，按需调用，不进常驻提示词）

   三种模式（施工单 §3）：
     candidates  NPC 候选提案   → 输出只落 taNpcDrafts（status=draft，
                                  sourceType='model_proposal'），不调 upsertChar
     review      事项/关注复核  → 输出落 taProposals（item_update /
                                  follow_update / promise_review）
     advance     NPC 生活事件   → 输出落 taProposals（npc_event /
                                  impact_review / contact_candidate）

   ─── 调用边界（施工单 §1，门禁在程序不在模型）──────────────
   · 只有明确入口会走到这里：幕后「生成一轮生活提案 / 复核现有事实」、
     详情页「复核或推进」；页面打开 / 切页 / 切岛 / 聊天每轮**都不会**；
   · advance 需要「自主生活更新」开关开启（review / candidates 不需要）；
   · 模型失败 / 超时 / 非法 JSON → 如实报错，不写任何表，不显示成功；
   · 模型输出经 ta-proposal.validateBatch 白名单收口后才落表；
   · 无变化 = 空提案，合法（不为填数量生成事件）。

   ─── 模型选择 ──────────────────────────────────────────────
   沿用主 API（store 'mainApi'）——总结引擎同款回落策略的最小版；
   本轮不新增 ta 专用模型设置页（如实记录）。

   ─── F1 / F2 / 主动消息（第五批 2026-10-02 已接线）──────────
   本文件仍然**不碰**提示词装配（模型模块只管产提案）。接线在别处：
     · F1/F2：`prompt-engine` 的 `taimpact` 槽（K03d）→ `ta-impact.compile`
       —— 只注入已接受、当前有效、与本轮输入相关的影响，最多 2 条；
       pending 提案永远进不去（它读的是 taEvents，pending 在 taProposals）。
     · 主动消息：接受 `contact_candidate` → attentionInbox（带 taProposalId）
       → 现有闸门与发送机制 → 决策落定后把结果写回提案（ta-impact.noteProactive）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var P = Sleepy.taProposals;

  var PROMPT_VER = 'ta-model-p1';

  function arr(v) { return Array.isArray(v) ? v : []; }
  function rootIdOf(charId) {
    try {
      var r = (core.rootOf && core.rootOf(charId)) || null;
      return (r && r.id) || charId || null;
    } catch (e) { return charId || null; }
  }
  function isoDay(ts) {
    var d = new Date(ts || Date.now());
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* ---------------------------- 模型候选 ---------------------------- */

  function candFor() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { cfg: main, label: main.name || '主 API' };
    }
    return null;
  }

  function callOnce(cand, messages) {
    /* 勾了「TA 自主生活推进走副 API」→ 只轮询副 API（api.js）；没勾走主 API */
    var fr = Sleepy.api.requestForFeature ? Sleepy.api.requestForFeature('talife', messages, {}) : null;
    if (fr) {
      return fr.then(function (r) {
        return r.ok ? { ok: true, text: r.content } : r;
      });
    }
    if (!cand) return Promise.resolve({ ok: false, error: '还没有可用的模型连接 —— 先去设置配主 API' });
    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (res.ok) return { ok: true, text: res.content };
      return { ok: false, error: Sleepy.api.describeError(res) };
    }, function (e) {
      return { ok: false, error: (e && e.message) || '请求失败' };
    });
  }

  /* 模型只吐 JSON：剥 code fence，失败如实报错（不猜、不补） */
  function parseJson(text) {
    var t = String(text || '').trim();
    var m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) t = m[1].trim();
    try {
      return { ok: true, data: JSON.parse(t) };
    } catch (e) {
      return { ok: false, error: '模型输出不是合法 JSON（' + String(e.message || e).slice(0, 80) + '）' };
    }
  }

  /* ---------------------------- 输入装配 ---------------------------- */

  function worldBrief(ctx) {
    var sb = ctx.sandbox;
    return [
      '当前时间：' + isoDay(ctx.now),
      '世界：' + (sb ? (sb.name || '未命名') + '（' + (sb.kind === 'archipelago' ? '群岛' : '孤岛') + '）' : '未知'),
      '角色：' + (ctx.char ? (ctx.char.name || '未命名') : '未知')
    ].join('\n');
  }

  /* 提案 JSON 的格式契约（三种模式共用一份，模式差异在数据段） */
  var FORMAT_RULES = [
    '你只输出一个 JSON 对象，不要输出任何其他文字、注释或 markdown 代码块标记。',
    'JSON 结构：{"proposals": [ ... ]}，没有建议就是 {"proposals": []} —— 空是合法且鼓励的，不要为了凑数编造事件。',
    '每个 proposal 的字段（全部必填除非标注可选）：',
    '  kind: "item_update" | "follow_update" | "promise_review" | "npc_event" | "impact_review" | "contact_candidate"',
    '  operation: "add" | "update" | "resolve" | "flag_review"',
    '  targetRef: 目标对象的 id（item_update/follow_update/promise_review 必填；npc_event=已确认 NPC 的 id；impact_review=事件 id）',
    '  baseVersion: 该对象 updatedAt 的原样拷贝（可选，但给了就必须精确）',
    '  summary: 一句话说清提议了什么（≤100字）',
    '  reason: 依据 —— 只能引用输入数据里确实存在的事实（≤150字）',
    '  extra: 可选对象，只允许这些键：eventText, eventAt, knownCharId, basis, impactText, reviewWhen, targetStatus, targetDetail, targetNextCheck, targetLatest, targetNote, targetPendingWhy, targetEvidence, direction',
    '硬性禁令：',
    '  · 不准提出死亡、重伤、结婚、离婚、怀孕、分手等重大变化（这类一律不要输出）；',
    '  · 不准把事项标成「已完成」除非输入里已有明确证据；',
    '  · 事项完成不等于承诺兑现 —— 永远不要提议兑现承诺；',
    '  · 不准替 user 做决定、接受邀请、答应安排或发送消息；',
    '  · 没有依据就返回空 proposals。'
  ].join('\n');

  function targetBrief(t) {
    return {
      id: t.id, title: t.title || t.target || t.quote || '', status: t.status || '',
      detail: t.detail || '', nextCheck: t.nextCheck || '', latest: t.latest || '',
      updatedAt: t.updatedAt
    };
  }

  /* 角色卡唯一出口（勘察 P1）：三类提案都是模型替 char 推进/复核 TA 的生活，
     不带人设就写不出「这个 TA」的生活。以 system 附块注入 compileCharacter
     产物（分层+红线并集）；编译器不可用时保持纯 FORMAT_RULES 原样。 */
  function personaOf(ctx) {
    try {
      if (Sleepy.promptEngine && Sleepy.promptEngine.compileCharacter && ctx && ctx.charId) {
        return Sleepy.promptEngine.compileCharacter(ctx.charId) || '';
      }
    } catch (e) { /* 编译不可用就不注入 */ }
    return '';
  }
  function sysWith(persona) {
    return persona ? FORMAT_RULES + '\n\n' + persona : FORMAT_RULES;
  }

  function buildReview(ctx) {
    var data = {
      world: worldBrief(ctx),
      items: arr(ctx.targets.items).map(targetBrief),
      follows: arr(ctx.targets.follows).map(targetBrief),
      promises: arr(ctx.targets.promises).map(function (t) {
        return { id: t.id, quote: t.quote, status: t.status, pendingWhy: t.pendingWhy, evidence: t.evidence, updatedAt: t.updatedAt };
      }),
      task: '复核这些事项 / 关注 / 承诺：有进展的提出进展（item_update/follow_update），需要核实的提复核（promise_review，只更新 pendingWhy/evidence），没变化的不要提。'
    };
    return [
      { role: 'system', content: sysWith(personaOf(ctx)) },
      { role: 'user', content: JSON.stringify(data) }
    ];
  }

  function buildAdvance(ctx) {
    var data = {
      world: worldBrief(ctx),
      confirmedNpcs: arr(ctx.targets.npcs).map(function (n) {
        return { id: n.id, name: n.name, kind: n.kind, content: String(n.content || '').slice(0, 200) };
      }),
      establishedEvents: arr(ctx.events).map(function (e) {
        return { id: e.id, npcId: e.npcId, text: e.text, happenedAt: e.happenedAt, knowledge: e.knowledge, impacts: e.impacts };
      }),
      items: arr(ctx.targets.items).map(targetBrief),
      follows: arr(ctx.targets.follows).map(targetBrief),
      autonomous: '玩家已开启自主生活更新（advance 授权）。只允许低风险日常事件；NPC 自己发生的事不等于角色知道；角色知道不等于必然受影响。'
    };
    return [
      { role: 'system', content: sysWith(personaOf(ctx)) },
      { role: 'user', content: JSON.stringify(data) }
    ];
  }

  function buildCandidates(ctx) {
    var data = {
      world: worldBrief(ctx),
      confirmedPeople: arr(ctx.targets.npcs).map(function (n) { return n.name; }),
      keptDrafts: arr(ctx.keptDrafts || []).map(function (d) { return { name: d.name, role: d.role }; }),
      direction: ctx.direction || '贴合当前世界的日常人物，不要戏剧化',
      task: '提出至多 3 个 NPC 候选：{proposals:[{kind:"contact_candidate", operation:"add", summary:"一句话人设", reason:"为什么 ta 的生活里会有这个人", extra:{candidateName:"名字", candidateRole:"身份"}}]}。候选只是草稿，不会自动成为正式人物。'
    };
    return [
      { role: 'system', content: sysWith(personaOf(ctx)) },
      { role: 'user', content: JSON.stringify(data) }
    ];
  }

  /* ---------------------------- 执行 ----------------------------
   * runMode(mode, ctx, opts) → Promise<{ok, saved?, failed?, duplicate?,
   *   error?, requestId?, modelMeta?}>
   * opts.transport：注入请求函数（冒烟 / 测试用，不打真网络），
   *   形如 function(cand, messages) → Promise<{ok, text}>（page-summary callOnce 同款）。 */

  function collectCtx(ctx) {
    var charId = ctx.charId;
    return {
      sandbox: core.activeSandbox(),
      char: core.findChar ? core.findChar(charId) : null,
      charId: charId,
      user: core.activeUserOnIsland ? core.activeUserOnIsland() : null,
      targets: {
        items: taItemsOf(charId),
        follows: taFollowsOf(charId),
        promises: taPromisesOf(charId),
        npcs: core.npcsOfRoom ? core.npcsOfRoom(core.activeSandbox()) : []
      },
      events: P.eventsOf(charId),
      now: Date.now()
    };
  }
  function taItemsOf(charId) { return Sleepy.taLife ? Sleepy.taLife.itemsOf(charId) : []; }
  function taFollowsOf(charId) { return Sleepy.taLife ? Sleepy.taLife.followsOf(charId) : []; }
  function taPromisesOf(charId) {
    return Sleepy.taLife ? Sleepy.taLife.promisesOf(charId, (core.activeUserOnIsland() || {}).id) : [];
  }

  /* 输入指纹 → requestId：同输入重放不重复落提案（§2 局部键幂等） */
  function requestIdOf(mode, ctx, extraKey) {
    var fpSrc = JSON.stringify([mode, ctx.charId, ctx.now, ctx.targets.items.map(function (t) { return t.updatedAt; }),
      ctx.targets.follows.map(function (t) { return t.updatedAt; }), ctx.events.length, extraKey || '']);
    var h = 5381;
    for (var i = 0; i < fpSrc.length; i++) h = ((h << 5) + h + fpSrc.charCodeAt(i)) & 0x7fffffff;
    return 'req' + h.toString(36);
  }

  function existingFps() {
    var sid = core.scopeId ? core.scopeId() : null;
    var map = {};
    if (!sid) return map;
    core.scoped(arr(store.get(P.KEYS.proposals))).forEach(function (p) {
      if (p && p.fp) map[p.fp] = 1;
    });
    return map;
  }

  var MODES = ['candidates', 'review', 'advance'];

  function runMode(mode, ctx, opts) {
    opts = opts || {};
    if (MODES.indexOf(mode) < 0) {
      return Promise.resolve({ ok: false, error: '未知模式：' + mode });
    }
    var C = collectCtx(ctx);
    if (!C.sandbox || !C.charId) {
      return Promise.resolve({ ok: false, error: '先落岛、选好「你」和「TA」' });
    }
    /* 门禁：advance 必须开关开着；review / candidates 不需要 */
    if (mode === 'advance' && !P.autoLifeOf(ctx.charId).enabled) {
      return Promise.resolve({ ok: false, error: '自主生活更新没开（幕后可以打开）', gate: 'auto_off' });
    }
    var cand = opts.cand || null;
    if (!opts.transport) {
      cand = candFor();
      if (!cand) {
        return Promise.resolve({ ok: false, error: '还没有可用的模型连接 —— 先去设置配主 API' });
      }
    }   /* 注入 transport（测试）时跳过 cand 门禁，模型名照实记 */
    var messages = mode === 'review' ? buildReview(C)
      : mode === 'advance' ? buildAdvance(C) : buildCandidates(C);
    var requestId = requestIdOf(mode, C, opts.extraKey);
    var modelMeta = {
      model: (cand && cand.cfg && cand.cfg.model) || 'transport-injected',
      label: (cand && cand.label) || '注入通道',
      promptVer: PROMPT_VER, at: Date.now(),
      requestId: requestId
    };
    var send = opts.transport || callOnce;
    return send(cand, messages).then(function (res) {
      if (!res.ok) return { ok: false, error: res.error || '模型请求失败', requestId: requestId, modelMeta: modelMeta };
      /* 真实调用验收用：最近一次调用的原始输出留在内存里（不落盘、不含 key），
         控制台 Sleepy.taModel.lastCall 可取 —— 只为回报「原始模型输出」。 */
      Sleepy.taModel.lastCall = {
        mode: mode, requestId: requestId,
        model: (cand && cand.cfg && cand.cfg.model) || 'transport-injected',
        promptVer: PROMPT_VER, at: modelMeta.at,
        raw: String(res.text || '').slice(0, 4000)
      };
      var parsed = parseJson(res.text);
      if (!parsed.ok) {
        Sleepy.taModel.lastCall.parseError = parsed.error;
        return { ok: false, error: parsed.error, raw: String(res.text || '').slice(0, 200), requestId: requestId, modelMeta: modelMeta };
      }
      Sleepy.taModel.lastCall.parsed = parsed.data;
      /* NPC 候选：不进提案表 —— 直接落草稿区（sourceType=model_proposal） */
      if (mode === 'candidates') {
        return ingestCandidates(parsed.data, C, modelMeta, requestId);
      }
      var batch = P.validateBatch(mode, parsed.data, {
        sandboxId: C.sandbox ? C.sandbox.id : null,
        targets: C.targets, events: C.events, existingFps: existingFps()
      });
      var saved = P.saveProposals(mode, batch, {
        sandboxId: C.sandbox ? C.sandbox.id : null,
        refCharId: rootIdOf(ctx.charId),
        refUserId: C.user ? C.user.id : null
      }, {
        requestId: requestId, model: modelMeta.model, label: modelMeta.label,
        promptVer: PROMPT_VER, at: modelMeta.at,
        sourceRefs: arr(ctx.sourceRefs)
      });
      if (!saved.ok) return { ok: false, error: saved.why, requestId: requestId };
      return {
        ok: true, saved: saved.saved, failed: saved.failed,
        duplicate: saved.duplicate, requestId: requestId, modelMeta: modelMeta
      };
    });
  }

  /* NPC 候选 → taNpcDrafts（draft，model_proposal 标记，最多 3 条，指纹去重） */
  function ingestCandidates(data, C, modelMeta, requestId) {
    var list = arr(data && data.proposals).filter(function (p) {
      return p && p.kind === 'contact_candidate';
    }).slice(0, 3);
    if (!list.length) return { ok: true, saved: 0, duplicate: 0, requestId: requestId };
    var made = 0, dup = 0;
    list.forEach(function (p) {
      var ex = (p.extra && typeof p.extra === 'object') ? p.extra : {};
      var name = String(ex.candidateName || '').trim().slice(0, 40);
      if (!name) return;
      /* 去重：同岛同名同角色的活草稿已存在就不重建 */
      var dupHit = false;
      Sleepy.taLife.draftsOf(C.charId, ['draft', 'discarded', 'confirmed', 'failed']).forEach(function (d) {
        if (d.name === name && (d.role || '') === String(ex.candidateRole || '').trim()) dupHit = true;
      });
      if (dupHit) { dup++; return; }
      Sleepy.taLife.addDraft({
        name: name,
        role: String(ex.candidateRole || '').trim(),
        personality: String(p.summary || '').slice(0, 200),
        meetingOpportunity: String(p.reason || '').slice(0, 200),
        refCharId: C.charId,
        refUserId: C.user ? C.user.id : null,
        sourceType: 'model_proposal',
        sourceRef: '模型候选（' + modelMeta.label + ' · ' + PROMPT_VER + ' · ' + requestId + '）'
      });
      made++;
    });
    return { ok: true, saved: made, duplicate: dup, requestId: requestId, modelMeta: modelMeta };
  }

  Sleepy.taModel = {
    PROMPT_VER: PROMPT_VER,
    MODES: MODES,
    candFor: candFor,
    parseJson: parseJson,
    buildReview: buildReview,
    buildAdvance: buildAdvance,
    buildCandidates: buildCandidates,
    runMode: runMode
  };

})(window);
