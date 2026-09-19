/* ============================================================
   page-summary.js — 总结引擎（记忆系统 v5 第 10/11 节的落地）

   线上累计总结（10.1）：不按每 N 轮机械总结，按「累计活跃量结算」——
     自上次整理以来满足任一条件就后台跑一次：
       · 累计消息 ≥ 30 条（≈15 轮，阈值后续可在设置里调）
       · 待整理原文 ≥ 6000 字
       · 跨了 3 个活跃日
     一次整理多个活跃日，不为几句话付一次总结费。
   线下大总结（11.2）：page-offline 的大总结调用已产出协议 JSON，
     这里的 ingest() 负责把 changes 校验入库（来源=offline）。

   模型：MVP 跟随主 API（v5 12.1 的「指定独立记忆模型」留到设置轮）。
   输出协议：prompt-engine 的 summary 卡（Structured Outputs → JSON Mode
     → 围栏 → 裸 JSON 的降级顺序已在卡里教了，解析这边照单全收）。

   入库规则（user 主权优先）：
     · op=add 且证据是「你亲口说的/明确发生」且 confirm≠true → active
     · op=observe、confirm=true、其他证据类型 → pending（等 user 在留痕确认）
     · replaces 指到的旧记忆 → superseded（记 supersededBy）
     · kind/evidence 非法 → 映射到合法值，不丢弃
     · charState / openLoops 存 store，attention 只暂存（主动消息引擎接）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  var KIND_OK = ['user_fact', 'preference_like', 'preference_dislike', 'boundary',
    'shared_event', 'promise', 'relationship_fact', 'correction', 'habit',
    'character_inference', 'custom'];
  var EVID_OK = ['user_explicit', 'confirmed_event', 'character_feeling',
    'character_inference', 'behavior_signal', 'uncertain'];

  function nowIso() { return new Date().toISOString(); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---------------------------- 解析 ----------------------------
     卡里的降级顺序最后一步是「裸 JSON / 缺字段用空结构」。
     解析失败返回 null（调用方存原文，可重试）。 */
  function parseSummaryJson(raw) {
    var t = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
  }

  /* ---------------------------- 入库 ----------------------------
     meta = { source:'online'|'offline', ref:'见面 #07' 等 } */
  function ingest(charId, parsed, meta) {
    meta = meta || {};
    if (!parsed || !Array.isArray(parsed.changes) || !parsed.changes.length) {
      return { added: 0, superseded: 0 };
    }
    var M = Sleepy.memoryStore;
    var file = M.loadCharMemory(charId);
    var ref = meta.ref || (meta.source === 'offline' ? '线下见面' : '线上累计 ' +
      pad2(new Date().getMonth() + 1) + '-' + pad2(new Date().getDate()));

    var added = 0, superseded = 0;

    parsed.changes.forEach(function (c) {
      if (!c || typeof c.text !== 'string' || !c.text.trim()) return;

      var kind = KIND_OK.indexOf(c.kind) >= 0 ? c.kind
        : (c.kind === 'interaction_preference' ? 'habit' : 'custom');
      var evidence = EVID_OK.indexOf(c.evidence) >= 0 ? c.evidence : 'uncertain';
      var op = ['add', 'update', 'observe', 'invalidate', 'supersede']
        .indexOf(c.op) >= 0 ? c.op : 'add';

      /* 被取代/失效的旧记忆：replaces 里给的 id 必须真实存在才处理 */
      var replaces = (Array.isArray(c.replaces) ? c.replaces : [])
        .filter(function (id) {
          return file.memories.some(function (m) { return m.id === id; });
        });

      if (op === 'invalidate') {
        replaces.forEach(function (id) {
          file.memories.forEach(function (m) {
            if (m.id === id && m.status !== 'invalid') {
              m.status = 'invalid';
              m.updatedAt = nowIso();
              superseded++;
            }
          });
        });
        return;
      }

      /* 来源引用：模型给了 sourceIds 就带上（MVP 的 sourceIds 是序号，
         不强行对应消息 id），否则用整理时间。 */
      var sourceRef = meta.ref || '';
      if (!sourceRef) {
        sourceRef = Array.isArray(c.sourceIds) && c.sourceIds.length
          ? '来源块 #' + c.sourceIds.slice(0, 4).join(',')
          : (meta.source === 'offline' ? '线下大总结' : '线上累计 ' +
             pad2(new Date().getMonth() + 1) + '-' + pad2(new Date().getDate()));
      }

      /* user 主权：亲口说的/明确发生 且没被要求确认 → 直接生效；
         观察、要求确认、其他证据 → pending，等 user 在留痕里点头。 */
      var status;
      if (op === 'observe') status = 'pending';
      else if (c.confirm === true) status = 'pending';
      else if (evidence === 'user_explicit' || evidence === 'confirmed_event') status = 'active';
      else status = 'pending';

      var item = {
        id: 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        charId: charId,
        kind: kind,
        content: c.text.trim(),
        source: meta.source === 'offline' ? 'offline' : 'ai_summary',
        sourceRef: sourceRef,
        evidenceType: evidence,
        status: status,
        isAnchor: false,
        isUserEdited: false,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      if (replaces.length) item.supersededBy = replaces[0];
      /* 第三梯队 5「查看原文定位到气泡」：sourceIds 是整理范围内的序号
         （1 起），transcript 是按消息顺序拼的，所以能反查回真实消息 id。
         离线总结没有消息 id，不回填。 */
      if (meta.idMap && Array.isArray(c.sourceIds) && c.sourceIds.length) {
        var n = parseInt(c.sourceIds[0], 10);
        if (n > 0 && meta.idMap[n]) {
          item.sourceMessageId = meta.idMap[n];
          item.sourceChatId = meta.chatId || '';
        }
      }
      file.memories.unshift(item);
      added++;

      replaces.forEach(function (id) {
        file.memories.forEach(function (m) {
          if (m.id === id && m.status === 'active') {
            m.status = 'superseded';
            m.supersededBy = item.id;
            m.updatedAt = nowIso();
            superseded++;
          }
        });
      });
    });

    if (added || superseded) {
      file.updatedAt = nowIso();
      store.set('charMem:' + charId, file);
    }

    /* 心绪 / 悬而未决：存下来给心绪面板和主动消息引擎接（先落库） */
    if (parsed.charState && typeof parsed.charState === 'object') {
      store.set('charState:' + charId, {
        feelings: parsed.charState.feelings || [],
        readings: parsed.charState.readings || [],
        unspoken: parsed.charState.unspoken || [],
        updatedAt: nowIso()
      });
    }
    if (Array.isArray(parsed.openLoops) && parsed.openLoops.length) {
      store.set('openLoops:' + charId, { items: parsed.openLoops.slice(0, 6), updatedAt: nowIso() });
    }
    if (Array.isArray(parsed.attention) && parsed.attention.length) {
      store.set('attentionInbox:' + charId, { items: parsed.attention.slice(0, 4), updatedAt: nowIso() });
    }

    return { added: added, superseded: superseded };
  }

  /* ---------------------------- 模型 ----------------------------
     MVP 跟随主 API（v5 12.1 的独立记忆模型留给设置轮）。 */
  function candFor() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }

  function callOnce(cand, messages) {
    if (!cand) return Promise.resolve({ ok: false, error: '还没有可用的模型连接' });
    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (res.ok) return { ok: true, text: res.content };
      return { ok: false, error: res.message || '请求失败' };
    }, function (e) {
      return { ok: false, error: (e && e.message) || '请求失败' };
    });
  }

  /* ---------------------------- 线上累计 ---------------------------- */

  function cursorKey(chatId) { return 'sumCursor:' + chatId; }
  function getCursor(chatId, msgs) {
    return store.get(cursorKey(chatId)) || { startIdx: 0, at: 0 };
  }

  /* 触发条件（v5 10.1 累计整理）：任一满足即整理 */
  function shouldRun(chatId, msgs) {
    var cur = getCursor(chatId);
    var pending = msgs.slice(cur.startIdx || 0);
    if (!pending.length) return false;
    var chars = 0, days = {};
    pending.forEach(function (m) {
      chars += String(m.content || '').length;
      if (m.timestamp) {
        var d = new Date(m.timestamp);
        days[d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())] = 1;
      }
    });
    return pending.length >= 30 || chars >= 6000 || Object.keys(days).length >= 3;
  }

  /* 原文块：role → 「你 / 角色名」，特殊类型括号标注 */
  function transcriptOf(chat, msgs, fromIdx) {
    var ch = chat.characterId ? Sleepy.core.findChar(chat.characterId) : null;
    var chName = ch ? ch.name : '角色';
    return msgs.slice(fromIdx).map(function (m) {
      var who = m.role === 'user' ? '你' : chName;
      if (m.type === 'sticker') return who + '：（发了一个表情：' + (m.name || '') + '）';
      if (m.type === 'transfer') return who + '：（转账 ' + (m.amount || '') + ' 元，' + (m.note || '') + '）';
      if (m.type === 'pat') return who + '：（拍了拍对方）';
      if (m.type === 'photo' || m.type === 'file') return who + '：（发了一个' + (m.type === 'photo' ? '照片' : '文件') + '附件）';
      return who + '：' + String(m.content || '');
    }).filter(Boolean).join('\n');
  }

  function summarizeOnline(chat, opts) {
    opts = opts || {};
    var chatId = chat.id;
    var charId = chat.characterId;
    if (!charId) return Promise.resolve({ ok: false, error: '这个对话还没绑定角色' });
    var cand = candFor();
    if (!cand) return Promise.resolve({ ok: false, error: 'noapi' });

    var msgs = chat.messages || [];
    var cur = getCursor(chatId);
    var startIdx = Math.min(cur.startIdx || 0, msgs.length);
    /* 上限保护：一次最多整理最近 120 条，更早的留给下一次（游标不推进会重复，
       所以这里直接把游标提到 max(0, len-120)） */
    if (msgs.length - startIdx > 120) startIdx = msgs.length - 120;

    var body = transcriptOf(chat, msgs, startIdx);
    if (!body.trim()) {
      store.set(cursorKey(chatId), { startIdx: msgs.length, at: Date.now() });
      return Promise.resolve({ ok: false, error: 'empty' });
    }

    var M = Sleepy.memoryStore;
    var file = M.loadCharMemory(charId);
    var existing = file.memories.filter(function (m) {
      return m.status === 'active' || m.status === 'pending';
    }).slice(0, 40).map(function (m) {
      return m.id + ' [' + m.kind + '] ' + m.content;
    }).join('\n');

    var sysParts = [Sleepy.promptEngine.cardBody('summary')];
    var ch = Sleepy.core.findChar(charId);
    if (ch && ch.content) sysParts.push('[CHARACTER]\n' + ch.content + '\n[/CHARACTER]');

    var userParts = [];
    userParts.push('[SOURCE_RANGE]\n下面是自上次整理以来的新聊天记录（'
      + startIdx + ' 到 ' + msgs.length + ' 条），只整理这个范围：\n\n' + body);
    if (existing) {
      userParts.push('[EXISTING_MEMORIES]\n已有的记忆条目（update/invalidate/supersede 的 replaces 字段引用这里的 id）：\n' + existing);
    }
    userParts.push('请按输出协议整理这次范围（type=online_period）。');

    var messages = [
      { role: 'system', content: sysParts.join('\n\n') },
      { role: 'user', content: userParts.join('\n\n') }
    ];

    return callOnce(cand, messages).then(function (r) {
      if (!r.ok) return r;
      var parsed = parseSummaryJson(r.text);
      if (!parsed) {
        store.set('sumRawFail:' + chatId, { at: Date.now(), raw: String(r.text || '').slice(0, 4000) });
        return { ok: false, error: '解析失败（原文已存，可重试）' };
      }
      var stat = ingest(charId, parsed, {
        source: 'online',
        chatId: chatId,
        /* 序号 → 消息 id 对照表：transcript 第 n 行 = msgs[startIdx + n - 1] */
        idMap: (function () {
          var map = {};
          for (var k = 0; k < msgs.length - startIdx; k++) map[k + 1] = msgs[startIdx + k].id;
          return map;
        })()
      });
      store.set(cursorKey(chatId), { startIdx: msgs.length, at: Date.now() });
      return { ok: true, stat: stat };
    });
  }

  /* sendReply 成功后调：达到阈值就后台整理，不阻塞聊天 */
  function onChatTurn(chatId) {
    var cs = Sleepy.chatStore;
    var chat = cs && cs.getChat(chatId);
    if (!chat || !chat.characterId) return;
    if (running[chatId]) return;
    if (!shouldRun(chatId, chat.messages || [])) return;
    running[chatId] = true;
    summarizeOnline(chat).then(function (r) {
      running[chatId] = false;
      if (r.ok && r.stat && r.stat.added) {
        if (Sleepy.toast) Sleepy.toast('悄悄整理了 ' + r.stat.added + ' 条新记忆，去「留痕」看看', 'ok');
      }
      /* 失败静默：下一轮再试（游标没动，不会漏） */
    });
  }
  var running = {};

  /* 手动整理：无视阈值立刻跑（游标推进逻辑相同） */
  function runNow(chatId) {
    var cs = Sleepy.chatStore;
    var chat = cs && cs.getChat(chatId);
    if (!chat) return Promise.resolve({ ok: false, error: '找不到对话' });
    if (running[chatId]) return Promise.resolve({ ok: false, error: '正在整理中' });
    running[chatId] = true;
    return summarizeOnline(chat).then(function (r) {
      running[chatId] = false;
      return r;
    });
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.summaryEngine = {
    ingest: ingest,
    parseSummaryJson: parseSummaryJson,
    summarizeOnline: summarizeOnline,
    onChatTurn: onChatTurn,
    runNow: runNow
  };

})(window);
