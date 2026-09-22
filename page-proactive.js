/* ============================================================
   page-proactive.js — 主动消息引擎（第二梯队 4 · 记忆系统 v5 S3 落地）

   数据流：总结引擎产出 attentionInbox / openLoops / charState（store）
     → 这里组成【触发候选队列】
     → 程序资格闸门（免打扰时段 / 每日上限 / 冷却 / 未回复不追问 / 开关）
     → 主动消息卡（prompt-engine 'proactive'，Structured JSON）
     → decision=send 才落聊天页（addMessage），状态可追溯。

   卡里教的规则这里必须先照做：
     · 候选不等于必须发送 —— 闸门先筛，模型再判；
     · user 未回复（最后一条是 assistant）时不追问；
     · 同一候选只发一次（handled 按「内容指纹」记，不怕队列刷新）。

   触发时机：聊天列表 rebuild / 每轮回复后 sweep（自带 2 分钟节流），
   手动入口在角色设置（无视免打扰与冷却，其余闸门照走）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  /* ---------------------------- 设置 ---------------------------- */

  var DEF = { quietStart: '23:00', quietEnd: '08:00', maxPerDay: 2, cooldownMin: 120, deferMin: 90 };

  function settings() {
    var s = store.get('proactiveSettings') || {};
    var out = {};
    for (var k in DEF) out[k] = s[k] !== undefined ? s[k] : DEF[k];
    return out;
  }
  function saveSettings(patch) {
    var s = settings();
    for (var k in patch) s[k] = patch[k];
    store.set('proactiveSettings', s);
  }

  function stateKey(id) { return 'proactiveState:' + id; }
  function stateOf(id) {
    return store.get(stateKey(id)) || { lastAt: 0, day: '', count: 0, handled: [], deferredUntil: 0 };
  }
  function saveState(id, st) { store.set(stateKey(id), st); }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function hhmm() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  /* 免打扰区间支持跨午夜（23:00~08:00） */
  function inQuietHours(st, t) {
    if (!st.quietStart || !st.quietEnd || st.quietStart === st.quietEnd) return false;
    if (st.quietStart < st.quietEnd) return t >= st.quietStart && t < st.quietEnd;
    return t >= st.quietStart || t < st.quietEnd;
  }

  /* ---------------------------- 候选队列 ----------------------------
     来源优先级：attention（关注队列）> openLoops（悬而未决）> unspoken（想说没说）。
     id 用内容指纹 —— 队列刷新后已处理过的不会卷土重来。 */
  function candidatesFor(charId) {
    var out = [], seen = {};
    function push(src, it) {
      var text = typeof it === 'string' ? it : (it && (it.content || it.text || it.title)) || '';
      text = String(text || '').trim();
      if (!text) return;
      var id = src + ':' + text.slice(0, 24);
      if (seen[id]) return;
      seen[id] = 1;
      out.push({ id: id, source: src, text: text.slice(0, 120) });
    }
    var att = store.get('attentionInbox:' + charId);
    ((att && att.items) || []).forEach(function (x) { push('attention', x); });
    var loops = store.get('openLoops:' + charId);
    ((loops && loops.items) || []).forEach(function (x) { push('loop', x); });
    var cs = store.get('charState:' + charId);
    ((cs && cs.unspoken) || []).forEach(function (x) { push('unspoken', x); });
    return out;
  }

  /* ---------------------------- 资格闸门 ----------------------------
     返回 { ok, chat, cands } 或 { ok:false, why }。why 给设置页展示用。 */
  var GATE_WHY = {
    off: '主动消息开关关着', quiet: '免打扰时段', limit: '今天主动的次数用完了',
    cooldown: '还在冷却时间里', defer: '上次选择了暂缓，还没到点',
    nochat: '还没有和 TA 的对话', awaiting: '你在回复前 TA 不会追问',
    empty: '还没聊过天', nocand: '没有待处理的关注候选', noapi: '先去设置 → 主 API 配模型'
  };

  function findChatFor(charId) {
    /* 主动消息也得认准「当前账号 × 这个角色」那一条 —— 否则小号刚认识，
       角色却按大号的老交情开口（这种串法比串气泡更难查）。 */
    if (Sleepy.chatStore && Sleepy.chatStore.chatOf) return Sleepy.chatStore.chatOf(charId);
    var chats = store.get('chats') || [];
    var list = core.scoped ? core.scoped(chats) : chats;
    for (var i = 0; i < list.length; i++) {
      if (list[i].characterId === charId && !list[i].groupId) return list[i];
    }
    return null;
  }

  function gateFor(charId, opts) {
    opts = opts || {};
    var csSet = (Sleepy.chatSettings && Sleepy.chatSettings.charSettings)
      ? Sleepy.chatSettings.charSettings(charId) : null;
    if (csSet && !csSet.proactive) return { ok: false, why: 'off' };
    var st = settings();
    if (!opts.manual && inQuietHours(st, hhmm())) return { ok: false, why: 'quiet' };

    var ps = stateOf(charId);
    if (ps.day !== todayStr()) { ps.day = todayStr(); ps.count = 0; }
    if (ps.count >= st.maxPerDay) return { ok: false, why: 'limit' };
    if (Date.now() - (ps.lastAt || 0) < (opts.manual ? 0 : st.cooldownMin * 60000)) {
      return { ok: false, why: 'cooldown' };
    }
    if (!opts.manual && ps.deferredUntil && Date.now() < ps.deferredUntil) {
      return { ok: false, why: 'defer' };
    }

    var chat = findChatFor(charId);
    if (!chat) return { ok: false, why: 'nochat' };
    var msgs = chat.messages || [];
    if (!msgs.length) return { ok: false, why: 'empty' };
    /* 未回复不追问：最后一条是 TA 自己说的，就等 user 先回 */
    if (!opts.manual && msgs[msgs.length - 1].role === 'assistant') {
      return { ok: false, why: 'awaiting' };
    }

    var handled = ps.handled || [];
    var cands = candidatesFor(charId).filter(function (c) {
      return handled.indexOf(c.id) < 0;
    });
    if (!cands.length) return { ok: false, why: 'nocand' };
    return { ok: true, chat: chat, cands: cands, why: '' };
  }

  /* ---------------------------- 模型 ---------------------------- */

  function candFor() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }

  function parseDecision(raw) {
    var t = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
  }

  /* 主动消息的 system 段。**纯函数**（smoke 直接测）——
     为什么单独抽出来：这一段 2026-09-22 才补上共享外壳 / K01 / I01，
     而「补没补上」用真机跑要 mock 一整圈 gate + API，一眼看不出来。
     以前这里只有 proactive 卡 + content 原文，三样都缺：
       · 没有共享外壳 → [角色声音] 那段根本没进来（v84 写「F1/F2/主动消息
         三类共用」，实际漏了这一路），而**这条路要直接产出发给 user 的那句话**，
         是最需要「像这个人」的地方；
       · 没有 K01 的短字段 → 状态签名 / 说话方式 / 红线全看不见；
       · 没有 I01 → 不知道此刻以哪张脸面对谁（掉马设定下容易串身份）。
     多花约 1.2k tokens，换它别说成客服。 */
  /* L4 召回的查询串：最近两条消息（主动消息没有「当前输入」）。 */
  function recallQueryOf(chat) {
    var lines = [];
    ((chat && chat.messages) || []).slice(-2).forEach(function (m) {
      var t = String((m && m.content) || '').trim();
      if (t) lines.push(t.slice(0, 300));
    });
    var mv = Sleepy.memoryVec;
    return mv && mv._pure ? mv._pure.buildQuery(lines, '') : lines.join(String.fromCharCode(10));
  }

  function buildSystem(charId, userId) {
    var PE = Sleepy.promptEngine;
    var ch = core.findChar(charId);
    var sys = [PE.cardBody('shell'), PE.cardBody('proactive')];
    var k01 = PE.compileCharacter ? PE.compileCharacter(charId) : '';
    if (k01) sys.push(k01);
    else if (ch && ch.content) sys.push('[CHARACTER]\n' + ch.content + '\n[/CHARACTER]');
    var i01 = PE.compileI01 ? PE.compileI01(charId, userId || null) : '';
    if (i01) sys.push(i01);
    /* L1.5 近期生活动态：主动消息的素材本来就该来自「他最近看见的事」——
       少了这一层，TA 只能干等 [TRIGGER_CANDIDATES]，永远提不起你昨天发的那条。 */
    var life = PE.compileLife ? PE.compileLife(charId, userId || null) : '';
    if (life) sys.push(life);
    /* L4 召回（读的是 memoryVec 的缓存 —— 本函数是同步的，预取在上面的
       evaluate 里排掉了，用的是**上一次**的结果）。 */
    var recall = PE.compileRecall ? PE.compileRecall(charId) : '';
    if (recall) sys.push(recall);
    return sys;
  }

  function evaluate(charId, opts) {
    opts = opts || {};
    var g = gateFor(charId, opts);
    if (!g.ok) return Promise.resolve({ ok: false, why: g.why });
    var cand = candFor();
    if (!cand) return Promise.resolve({ ok: false, why: 'noapi' });
    if (evaluating[charId]) return Promise.resolve({ ok: false, why: 'busy' });
    evaluating[charId] = true;
    /* L4 召回（2026-09-22）：这条路**没有「当前输入」**，所以用上一次预取的
       结果（滞后一轮），同时把下一次的排上。主动消息本来就不要求跟当前话题
       精确对齐 —— 「突然想起你以前说过的一件事」正是它最自然的用法。
       不 await：它不该拖慢 TA 开口。 */
    var mv = Sleepy.memoryVec;
    var rq = recallQueryOf(g.chat);
    if (mv && mv.prefetch && rq) {
      mv.prefetch(charId, rq)['catch'](function () { /* 静默 */ });
    }

    var st = settings();
    var ps = stateOf(charId);
    var ch = core.findChar(charId);

    /* 2026-09-22 预设通查：system 段改走 buildSystem（共享外壳 + K01 + I01） */
    var sys = buildSystem(charId, (g.chat && g.chat.userId) || null);

    var user = [];
    user.push('[TRIGGER_CANDIDATES]\n' + g.cands.map(function (c) {
      return '- id=' + c.id + ' 来源=' + c.source + ' 内容：' + c.text;
    }).join('\n'));
    var cst = store.get('charState:' + charId);
    if (cst) {
      var bits = [];
      if ((cst.feelings || []).length) bits.push('当前感受：' + cst.feelings.join('；'));
      if ((cst.readings || []).length) bits.push('对对方的理解：' + cst.readings.join('；'));
      if (bits.length) user.push('[CONTACT_STATE]\n' + bits.join('\n'));
    }
    var recent = (g.chat.messages || []).slice(-10).map(function (m) {
      var who = m.role === 'user' ? '你' : (ch ? ch.name : 'TA');
      return who + '：' + String(m.content || '').slice(0, 80);
    }).join('\n');
    user.push('[RECENT_CHAT]\n' + (recent || '（还没有聊过）'));
    user.push('[NOW]\n' + todayStr() + ' ' + hhmm() +
      '（免打扰区间 ' + st.quietStart + '~' + st.quietEnd +
      '；今天已主动 ' + (ps.count || 0) + '/' + st.maxPerDay + ' 次）');
    user.push('请按输出协议判断这批候选，只返回 JSON。');

    var messages = [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: user.join('\n\n') }
    ];

    function done(r) { evaluating[charId] = false; return r; }

    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (!res.ok) return done({ ok: false, why: 'api', error: Sleepy.api.describeError(res) });
      var d = parseDecision(res.content);
      if (!d) return done({ ok: false, why: 'parse' });

      var ids = (Array.isArray(d.triggerIds) ? d.triggerIds : [])
        .filter(function (x) { return typeof x === 'string'; });
      ps.handled = (ps.handled || []).concat(ids).slice(-40);

      if (d.decision === 'send' && d.message && String(d.message).trim()) {
        var chat = findChatFor(charId);
        if (!chat) return done({ ok: false, why: 'nochat' });
        Sleepy.chatStore.addMessage(chat.id, {
          id: core.newId('ms'),
          role: 'assistant',
          content: String(d.message).trim(),
          timestamp: Date.now(),
          proactive: true,
          triggerIds: ids
        });
        ps.lastAt = Date.now();
        ps.count = (ps.count || 0) + 1;
        saveState(charId, ps);
        notify(charId, chat.id);
        return done({ ok: true, decision: 'send', text: String(d.message).trim() });
      }

      /* skip / defer / blocked：候选记为已处理，别让它每轮卷土重来；
         defer 额外给一段冷却（卡里说「保留后续触发条件」——
         暂缓期时长可在「主动消息安排」里配，默认 90 分钟） */
      if (d.decision === 'defer') {
        ps.deferredUntil = Date.now() + (st.deferMin || 90) * 60000;
      }
      saveState(charId, ps);
      return done({ ok: true, decision: d.decision || 'skip',
        reason: d.reasonCode || '' });
    }, function (e) {
      return done({ ok: false, why: 'api', error: (e && e.message) || '请求失败' });
    });
  }
  var evaluating = {};

  /* 落页 + 提醒 */
  function notify(charId, chatId) {
    var ch = core.findChar(charId);
    var name = ch ? ch.name : 'TA';
    if (Sleepy.toast) Sleepy.toast('「' + name + '」主动发来了消息', 'ok');
    /* 当前开着这个对话就原地刷新；开着聊天 App 就交给它下次 onShow */
    var top = Sleepy.nav && Sleepy.nav.top && Sleepy.nav.top();
    if (top === 'chat-detail' && Sleepy.chatDetailRefresh) Sleepy.chatDetailRefresh();
    else {
      var topCtx = Sleepy.nav && Sleepy.nav.topCtx && Sleepy.nav.topCtx();
      if (topCtx && typeof topCtx.refresh === 'function') {
        try { topCtx.refresh(); } catch (e) { /* 有的页面没有 refresh，忽略 */ }
      }
    }
  }

  /* ---------------------------- 扫描 ----------------------------
     对当前岛的所有主要角色各评估一次。2 分钟节流 ——
     聊天列表 rebuild / 每轮回复都会调到这里，别把 API 打爆。 */
  var lastSweep = 0;
  function sweep(force) {
    if (!force && Date.now() - lastSweep < 120000) return;
    lastSweep = Date.now();
    var sb = core.activeSandbox();
    if (!sb) return;
    core.charsOfSandbox(sb).forEach(function (m) { evaluate(m.id); });
  }

  /* ---------------------------- 对外 ---------------------------- */

  /* 实时闸门文案（给设置行注用）：不发起请求，纯本地判断。
     defer / cooldown 带剩余分钟数，比 GATE_WHY 的静态文案更可读。 */
  function gateWhyText(charId, opts) {
    var g = gateFor(charId, opts);
    if (g.ok) return '现在就有合适的时机';
    if (g.why === 'defer') {
      var ps = stateOf(charId);
      var min = Math.max(1, Math.ceil(((ps.deferredUntil || 0) - Date.now()) / 60000));
      return 'TA 暂缓了，约 ' + min + ' 分钟后再看';
    }
    if (g.why === 'cooldown') {
      var st = settings();
      var ps2 = stateOf(charId);
      var min2 = Math.max(1, Math.ceil(((ps2.lastAt || 0) + st.cooldownMin * 60000 - Date.now()) / 60000));
      return '冷却中，约 ' + min2 + ' 分钟后';
    }
    return GATE_WHY[g.why] || g.why;
  }

  Sleepy.proactiveEngine = {
    sweep: sweep,
    evaluate: evaluate,
    buildSystem: buildSystem,
    gateFor: gateFor,
    gateWhyText: gateWhyText,
    candidatesFor: candidatesFor,
    settings: settings,
    saveSettings: saveSettings,
    GATE_WHY: GATE_WHY
  };

})(window);
