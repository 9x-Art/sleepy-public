/* ============================================================
   wj-coread.js — 帷境 · 同席共读（T5）：session 数据层 + 状态机
   依赖：wj-data.js（作品数据）、page-memory.js（memoryStore，惰性）
   被依赖：page-wj-coread.js（邀请/等待/台账）、page-wj-read.js（会话态阅读）

   对应 Demo #4《同席共读 v2》。四条铁律（改之前先读）：

   1. **共读不是「边滚动边自动评论」**（总纲 §10.1）—— 本模块没有任何
      由滚动/定时触发的模型调用；所有反应都由用户点出来，且「沉默」
      （stay_silent）是完全合法的输出；
   2. **共读事件可以是真的，共读的故事仍然是假的** —— 结束时只产出
      **一条**现实候选：「user 与某人物共同读过《某作品》，结束于某锚点」，
      绝不带任何剧情；候选进 memoryStore 的 pending，user 确认才成为现实；
   3. **挂靠在 anchorId 上** —— 批注、反应、结束位置全部记锚点，
      不做全文匹配（锚点不可变，T3 已保证）；
   4. **模型判断的 transport 可注入**（与 wj-engine 同一套约定：
      按调用 {transport} 优先于全局 _transport）——邀请回应与「此刻反应」
      是独立职责（总纲 §14 第 8 项），无权读创作手记与隐藏素材。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var wj = function () { return Sleepy.wj; };

  var KEY = 'wjSessions';   /* 全局不 scoped（方案 §5.1，与 wjWorks 同理） */

  /* 陪读三模式：真的改变行为，不是三个装饰按钮 */
  var MODES = [
    { id: 'quiet', name: '安静陪读', hint: 'TA 安静地读。你想听想法时，用「询问反应」去问。' },
    { id: 'occasional', name: '偶尔回应', hint: '到你标出的重要节点，TA 才说说想法。' },
    { id: 'free', name: '自由畅聊', hint: '你随时可以发起此刻反应，TA 也可能多聊两句。' }
  ];

  /* 开放范围三档 */
  var SCOPES = [
    { id: 'start', name: '从第一章开始' },
    { id: 'chapter', name: '从某一章开始' },
    { id: 'current', name: '从当前段落开始' }
  ];

  /* 邀请四回应（Demo 的分寸：拒绝不是不想看） */
  var ACTIONS = {
    accept: { label: '接受了' },
    later: { label: '想稍后再读', note: '今天不太适合读这个。不是不想看，改天再说。' },
    share: { label: '只收下了作品', note: '先把作品收下了，共读改天再说。' },
    refuse: { label: '婉拒了', note: '今天不太适合读这个。不是不想看，改天再说。' }
  };

  /* 「此刻反应」的频率闸门：冷却 3 分钟（总纲 §7 红线：有频率上限与冷却） */
  var REACT_COOLDOWN_MS = 3 * 60 * 1000;

  /* ---------------------------- 存取 ---------------------------- */

  function read() {
    var list = Sleepy.store.get(KEY, []);
    return Array.isArray(list) ? list : [];
  }
  function write(list) {
    Sleepy.store.set(KEY, list || []);
    if (Sleepy.wjCoread && Sleepy.wjCoread.onChange) Sleepy.wjCoread.onChange();
  }
  function all() { return read(); }
  function get(id) {
    var list = read();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function mutate(id, fn) {
    var list = read();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var next = fn(list[i]) || list[i];
      list[i] = next;
      write(list);
      return next;
    }
    return null;
  }
  function forWork(workId) {
    return read().filter(function (s) { return s.workId === workId; })
      .sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
  }

  /* 作品被删掉时把它的会话一起收掉（2026-09-22 衔接审计：以前删作品只删
     wjWorks，留下的 session 成了孤儿 —— 门厅里看不见、数据里一直躺着）。 */
  function removeForWork(workId) {
    write(read().filter(function (s) { return s.workId !== workId; }));
    return true;
  }
  /* 一部作品同一时刻最多一个进行中的同席 */
  function activeFor(workId) {
    return forWork(workId).filter(function (s) {
      return s.status === 'active' || s.status === 'paused';
    })[0] || null;
  }

  /* ------------------------- 邀请与状态机 ------------------------- */

  function createInvite(patch) {
    var list = read();
    var s = {
      id: wj().uid('cr'),
      workId: patch.workId,
      charId: patch.charId,
      charName: patch.charName || '',
      mode: patch.mode || 'quiet',
      scope: patch.scope || 'start',
      startAnchorId: patch.startAnchorId || null,
      status: 'invited',          /* invited → active/paused → ended；
                                     invited 也可以 → deferred/sharing_only/refused */
      currentAnchorId: patch.startAnchorId || null,
      transcript: [],             /* {action, anchorId, text, at} */
      memorySaved: false,
      createdAt: wj().nowISO(),
      endedAt: null, endAnchorId: null
    };
    list.unshift(s);
    write(list);
    return s;
  }

  function settle(id, action, note) {
    var def = ACTIONS[action];
    if (!def) return null;
    return mutate(id, function (s) {
      s.status = action === 'accept' ? 'active'
        : action === 'later' ? 'deferred'
        : action === 'share' ? 'sharing_only' : 'refused';
      s.respondedAt = wj().nowISO();
      s.responseNote = note || def.note || '';
      if (action === 'accept') s.startedAt = wj().nowISO();
      s.transcript.push({ action: 'invite_' + action, text: s.responseNote,
        at: wj().nowISO() });
      return s;
    });
  }

  function pause(id) {
    return mutate(id, function (s) {
      if (s.status === 'active') s.status = 'paused';
      return s;
    });
  }
  function resume(id) {
    return mutate(id, function (s) {
      if (s.status === 'paused') s.status = 'active';
      return s;
    });
  }
  function end(id) {
    return mutate(id, function (s) {
      s.status = 'ended';
      s.endedAt = wj().nowISO();
      s.endAnchorId = s.currentAnchorId || s.startAnchorId || null;
      return s;
    });
  }

  /* 阅读位置：读到哪里，同席就跟到哪里 */
  function touchAnchor(id, anchorId) {
    return mutate(id, function (s) {
      if (s.status === 'active') s.currentAnchorId = anchorId;
      return s;
    });
  }

  /* 批注：用户写的，不经过模型，直接挂锚点 */
  function annotate(id, anchorId, text) {
    var t = String(text || '').trim();
    if (!t) return null;
    return mutate(id, function (s) {
      s.transcript.push({ action: 'annotate', anchorId: anchorId, text: t,
        at: wj().nowISO() });
      return s;
    });
  }

  function log(id, entry) {
    return mutate(id, function (s) {
      s.transcript.push({
        action: entry.action, anchorId: entry.anchorId || null,
        text: entry.text || '', at: wj().nowISO()
      });
      return s;
    });
  }

  /* --------------------- 现实候选（唯一出口） --------------------- */
  /* 结束后只产出一条候选：共同读过。绝不带剧情 —— 这是「共读事件真、
     故事假」在数据层的落点。写进 memoryStore 的 pending，user 确认才算数。 */

  function candidateFor(id) {
    var s = get(id);
    if (!s || s.status !== 'ended' || !s.endAnchorId) return null;
    var w = wj().get(s.workId);
    return {
      charId: s.charId,
      content: 'user 与' + (s.charName || '对方') + '共同读过《' +
        (w ? w.title : '未命名剧本') + '》，读到 ' + s.endAnchorId +
        '（' + (s.mode === 'quiet' ? '安静陪读' :
          s.mode === 'occasional' ? '偶尔回应' : '自由畅聊') + '）。',
      sourceRef: '同席共读'
    };
  }

  function markMemorySaved(id) {
    return mutate(id, function (s) { s.memorySaved = true; return s; });
  }

  /* ------------------------- 模式的能力表 ------------------------- */
  /* Demo：quiet → 暂停讨论 disabled、重要节点隐藏、此刻反应改叫「询问反应」；
     occasional → 重要节点触发；free → 随时。 */
  function canMilestone(mode) { return mode === 'occasional' || mode === 'free'; }
  function canPauseDiscussion(mode) { return mode !== 'quiet'; }
  function reactLabel(mode) { return mode === 'quiet' ? '询问反应' : '此刻反应'; }

  function reactCoolingDown(id, now) {
    var s = get(id);
    if (!s) return false;
    now = now || Date.now();
    return now - (s.lastReactAt || 0) < REACT_COOLDOWN_MS;
  }

  /* ------------------------- 模型判断（可注入） ------------------------- */

  /* 真机 transport（与 wj-engine 同一套约定）。
     ⚠️ 2026-09-22 补上这个兜底：在这之前 wjCoread 只有 `_transport` 注入点，
     生产环境里 judgeInvite / react **永远**以「没有可用的模型连接」失败 ——
     邀请发出去以后 TA 永远不回应（T6 的邀请卡就停在「等 TA 回应」）。
     非流式：一次拿到整个 JSON 才好解析。 */
  function apiTransport(messages, ov) {
    return new Promise(function (resolve, reject) {
      var h = Sleepy.api.runChat(messages, {
        onDone: function (cand, text) { resolve(text); },
        onFail: function (list, lastErr) {
          reject(new Error((lastErr && lastErr.error) || '模型没有返回'));
        }
      }, false, ov || { maxTokens: 300 });
      if (!h) reject(new Error('还没有可用的模型连接，去 设置 → 模型连接 填 API'));
    });
  }

  function transport(opts) {
    return (opts && opts.transport) || Sleepy.wjCoread._transport || apiTransport;
  }

  function charCard(charId) {
    try {
      var c = Sleepy.core.findChar(charId);
      return String((c && c.content) || '').trim().slice(0, 600);
    } catch (e) { return ''; }
  }

  /* 邀请回应判断（独立职责，总纲 §14 第 8 项）。
     输入只有：人物卡、作品门面（标题/简介/性质）、开放范围与陪读方式
     —— **无权读创作手记与隐藏素材**。 */
  function judgeInvite(workId, session, opts) {
    var w = wj().get(workId);
    if (!w) return Promise.reject(new Error('作品不存在'));
    var sys = [
      '你在判断一位出场人物收到「同席共读」邀请后会怎么回应。',
      '同席共读 = user 邀请 TA 一起读一部私人剧本（边读边聊）。' +
        '剧本不是现实，接受邀请不等于剧本成为事实。',
      charCard(session.charId) ? '【TA 是谁】' + charCard(session.charId) : '',
      '【作品门面】《' + (w.title || '未命名') + '》' +
        (w.desc ? '：' + w.desc : '') +
        '（' + (wj().REALITY_LABEL[w.reality] || '普通故事') + '）',
      '【开放范围】' + (SCOPES.filter(function (x) { return x.id === session.scope; })[0] || {}).name,
      '【陪读方式】' + (MODES.filter(function (x) { return x.id === session.mode; })[0] || {}).name,
      '【分寸】接受与否都自然。拒绝不是不想看 —— 今天不太适合读这个、' +
        '改天再说，都是完全体面的回应；只收下作品不共读也可以。',
      '【输出】只输出一个 JSON：{"action":"accept|later|share|refuse","note":"一句话，TA 自己的口气"}'
    ].filter(Boolean).join('\n\n');
    var t = transport(opts);
    if (!t) return Promise.reject(new Error('没有可用的模型连接'));
    return t([{ role: 'system', content: sys }], { maxTokens: 300 })
      .then(function (raw) {
        var obj = parseJSON(raw);
        var action = obj && ACTIONS[obj.action] ? obj.action : '';
        if (!action) throw new Error('回应没有解析成功');
        return { action: action,
          note: typeof obj.note === 'string' ? obj.note.trim().slice(0, 80) : '' };
      });
  }

  /* 此刻反应：TA 作为**读者**对这一段的想法，不是剧情台词。
     沉默（stay_silent）是合法输出。 */
  function react(sessionId, anchorId, paraText, opts) {
    var s = get(sessionId);
    if (!s || s.status !== 'active') {
      return Promise.reject(new Error('同席没有在进行'));
    }
    if (reactCoolingDown(sessionId)) {
      return Promise.reject(new Error('刚回应过，让 TA 再读一会儿'));
    }
    var w = wj().get(s.workId);
    var sys = [
      '你在一同读一部私人剧本。user 读到了某一段，想听这位出场人物作为**读者**的想法。',
      '反应是「TA 作为一个读者对这段文字的感受」，不是剧情里的台词，' +
        '不是 TA 在演剧本 —— TA 和 user 一样拿着同一份文本。',
      charCard(s.charId) ? '【TA 是谁】' + charCard(s.charId) : '',
      '【正读到的段落】\n' + String(paraText || '').slice(0, 300),
      w ? '【作品】《' + (w.title || '') + '》' : '',
      '【分寸】一两句话，符合 TA 的说话方式；不想说就沉默 —— ' +
        '沉默是完全合法的输出，不要硬凑感想。',
      '【输出】只输出一个 JSON：{"action":"react|stay_silent","text":"一两句话（沉默时留空）"}'
    ].filter(Boolean).join('\n\n');
    var t = transport(opts);
    if (!t) return Promise.reject(new Error('没有可用的模型连接'));
    return t([{ role: 'system', content: sys }], { maxTokens: 300 })
      .then(function (raw) {
        var obj = parseJSON(raw);
        var action = obj && (obj.action === 'stay_silent' || obj.action === 'react')
          ? obj.action : '';
        if (!action) throw new Error('反应没有解析成功');
        var text = obj && typeof obj.text === 'string' ? obj.text.trim().slice(0, 120) : '';
        mutate(sessionId, function (x) {
          x.lastReactAt = Date.now();
          x.transcript.push({ action: action, anchorId: anchorId, text: text,
            at: wj().nowISO() });
          return x;
        });
        return { action: action, text: text };
      });
  }

  function parseJSON(raw) {
    var text = String(raw || '').trim();
    var m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (m) text = m[1].trim();
    var i = text.indexOf('{');
    var j = text.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; }
  }

  /* ---------------------------- 出口 ---------------------------- */

  Sleepy.wjCoread = {
    KEY: KEY,
    MODES: MODES, SCOPES: SCOPES, ACTIONS: ACTIONS,
    REACT_COOLDOWN_MS: REACT_COOLDOWN_MS,

    _transport: null,
    onChange: null,

    all: all, get: get, mutate: mutate, forWork: forWork, activeFor: activeFor,
    removeForWork: removeForWork,
    createInvite: createInvite, settle: settle,
    pause: pause, resume: resume, end: end,
    touchAnchor: touchAnchor, annotate: annotate, log: log,
    candidateFor: candidateFor, markMemorySaved: markMemorySaved,
    canMilestone: canMilestone, canPauseDiscussion: canPauseDiscussion,
    reactLabel: reactLabel, reactCoolingDown: reactCoolingDown,
    judgeInvite: judgeInvite, react: react
  };

})(window);
