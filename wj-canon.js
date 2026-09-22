/* ============================================================
   wj-canon.js — 帷境 · 正史审阅与写入（T7）
   依赖：wj-data.js（作品）、store.js、page-memory.js（memoryStore，惰性）、
        calendar.js（惰性）、api.js（真机 transport）
   被依赖：page-wj-canon.js（审阅页）、page-wj-curtain.js（history 路）

   ★ 这是帷境里**唯一**会把作品内容写进现实的地方，所以它最慢：
     候选事实 → 冲突确认 → 人物认知 → 最终写入，四步，每步都要人过一遍。

   ★ 三条红线（方案 §7 第 5/6/10 条）：
     · 定史只写**逐条批准的结构化事实**，绝不写整篇正文；
     · 冲突没处理完不许进下一步（`!fixed` 是硬闸门，不是提示）；
     · 重复确认不许重复写入（幂等，`written` 一置就不再写）。

   ★ 「只报告不重写」：冲突检查只给证据与风险，改不改是作者的事 ——
     所以 conflict 是一段**说明**，fixed 是一个**由人打上的勾**，
     模型无权替他把冲突「解决」掉。

   ★ 候选从哪来：模型提取（Demo 缺口），transport 可注入，
     与 wj-engine / wj-coread 同一套约定。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var wj = function () { return Sleepy.wj; };

  /* 全局不 scoped（方案 §5.1）：审阅可能跨多个人物、跨岛，
     跟 wjWorks 同一个理由。 */
  var KEY = 'wjCanon';

  /* 候选四类（Demo #7） */
  var KINDS = [
    { id: 'place_time', name: '时间与地点' },
    { id: 'shared_event', name: '共同事件' },
    { id: 'relation', name: '人物关系' },
    { id: 'fragment', name: '片段记忆' }
  ];

  var DECISIONS = [
    { id: 'keep', name: '写入', hint: '这条批准了，会写进相关人物的现实记忆' },
    { id: 'hold', name: '暂缓', hint: '先放着，以后再决定 —— 这次不写' },
    { id: 'reject', name: '不写', hint: '这条永远留在小说里' }
  ];

  /* 六档认知（Demo 原样）。前四档会写进那个人的记忆，后两档只记录不写 ——
     「本人未知」的意思是**这件事存在但他不知道**，写进他的记忆就自相矛盾了。 */
  var KNOWLEDGE = [
    { id: '清晰记忆', hint: '清楚地记得这件事' },
    { id: '片段记忆', hint: '只记得一些片段' },
    { id: '情绪残留', hint: '记不清具体，只留下一点情绪' },
    { id: '角色隐瞒', hint: '记得，但不打算说出来' },
    { id: '本人未知', hint: '这件事发生了，但他本人还不知道' },
    { id: '完全不知情', hint: '这件事与他无关' }
  ];
  var KNOWLEDGE_WRITTEN = ['清晰记忆', '片段记忆', '情绪残留', '角色隐瞒'];

  /* 候选 kind → 记忆库的 kind（两套词表，映射只在这一处） */
  var KIND_TO_MEM = {
    place_time: 'user_fact',
    shared_event: 'shared_event',
    relation: 'relationship_fact',
    fragment: 'custom'
  };

  /* 四步 */
  var STEPS = [
    { id: 0, name: '候选事实', hint: '从作品里挑出可能成为现实的东西' },
    { id: 1, name: '冲突确认', hint: '有冲突的先处理掉，没处理完不能往下走' },
    { id: 2, name: '人物认知', hint: '这件事谁记得、谁不知道' },
    { id: 3, name: '最终写入', hint: '只写入批准且冲突已处理的结构化历史' }
  ];

  /* ---------------------------- 存取 ---------------------------- */

  function read() {
    var list = Sleepy.store.get(KEY, []);
    return Array.isArray(list) ? list : [];
  }
  function save(list) {
    Sleepy.store.set(KEY, list || []);
    if (Sleepy.wjCanon && Sleepy.wjCanon.onChange) Sleepy.wjCanon.onChange();
  }
  function all() { return read(); }
  function get(workId) {
    var list = read();
    for (var i = 0; i < list.length; i++) if (list[i].workId === workId) return list[i];
    return null;
  }
  function mutate(workId, fn) {
    var list = read();
    for (var i = 0; i < list.length; i++) {
      if (list[i].workId !== workId) continue;
      var next = fn(list[i]) || list[i];
      list[i] = next;
      save(list);
      return next;
    }
    return null;
  }

  /* 开一份审阅记录（已存在就返回既有的 —— 幂等） */
  function open(workId) {
    var hit = get(workId);
    if (hit) return hit;
    var rec = {
      workId: workId,
      step: 0,
      candidates: [],
      knowledge: {},
      written: false,
      extractedAt: null,
      writtenAt: null,
      createdAt: wj().nowISO()
    };
    var list = read();
    list.unshift(rec);
    save(list);
    return rec;
  }

  function remove(workId) {
    save(read().filter(function (r) { return r.workId !== workId; }));
    return true;
  }

  /* ---------------------------- 候选 ---------------------------- */

  function setCandidates(workId, list) {
    open(workId);
    return mutate(workId, function (r) {
      r.candidates = (list || []).map(function (c, i) {
        return {
          id: c.id || wj().uid('cd'),
          kind: KIND_TO_MEM[c.kind] ? c.kind : 'fragment',
          text: String(c.text || '').trim().slice(0, 120),
          note: String(c.note || '').trim().slice(0, 120),
          /* 冲突是**模型给的说明**，fixed 是**人打的勾** —— 两者分开存 */
          conflict: String(c.conflict || '').trim().slice(0, 200),
          fixed: false,
          fixedText: '',
          date: String(c.date || '').trim().slice(0, 10),
          sourceAnchorId: c.sourceAnchorId || null,
          decision: 'hold',        /* 默认暂缓：不点就不写，这是安全的方向 */
          seq: i + 1
        };
      });
      r.extractedAt = wj().nowISO();
      /* 重跑提取要把「已写入」清掉，否则新的候选永远写不进去；
         但**只在新候选真的变了**的时候清（同一个 workId 重跑同一份结果不该解锁）。 */
      var sig = r.candidates.map(function (c) { return c.text; }).join('|');
      if (r.sig !== sig) { r.written = false; r.writtenAt = null; r.sig = sig; }
      return r;
    });
  }

  function decide(workId, candId, decision) {
    var ok = DECISIONS.some(function (d) { return d.id === decision; });
    if (!ok) return null;
    return mutate(workId, function (r) {
      r.candidates.forEach(function (c) { if (c.id === candId) c.decision = decision; });
      return r;
    });
  }

  /* 处理冲突：写一句「为什么这样处理」就算处理过了。
     这是人打的勾，不是模型说「我处理好了」。 */
  function fixConflict(workId, candId, text) {
    return mutate(workId, function (r) {
      r.candidates.forEach(function (c) {
        if (c.id !== candId) return;
        c.fixedText = String(text || '').trim().slice(0, 200);
        c.fixed = true;
      });
      return r;
    });
  }
  function reopenConflict(workId, candId) {
    return mutate(workId, function (r) {
      r.candidates.forEach(function (c) {
        if (c.id !== candId) return;
        c.fixed = false;
        c.fixedText = '';
      });
      return r;
    });
  }

  /* ---------------------------- 认知 ---------------------------- */

  function kkey(charId, candId) { return charId + '-' + candId; }

  function knowledgeOf(rec, charId, candId) {
    var v = (rec && rec.knowledge) || {};
    return v[kkey(charId, candId)] || '完全不知情';
  }

  function setKnowledge(workId, charId, candId, level) {
    var ok = false;
    KNOWLEDGE.forEach(function (k) { if (k.id === level) ok = true; });
    if (!ok) return null;
    return mutate(workId, function (r) {
      r.knowledge = r.knowledge || {};
      r.knowledge[kkey(charId, candId)] = level;
      return r;
    });
  }

  /* ---------------------------- 硬闸门 ---------------------------- */

  /* 进下一步的条件。**冲突没处理完不许往下走** —— 这是方案 §7 第 6 条的
     硬闸门，不是提示；调用方（页面）拿它决定按钮能不能点。 */
  function blockers(rec) {
    if (!rec) return ['还没有开始审阅'];
    var kept = rec.candidates.filter(function (c) { return c.decision === 'keep'; });
    if (rec.step === 0) {
      return rec.candidates.length ? [] : ['还没有候选事实'];
    }
    if (rec.step === 1) {
      var open_ = kept.filter(function (c) { return c.conflict && !c.fixed; });
      var out = [];
      if (!kept.length) out.push('一条都还没批准 —— 至少挑一条要写的，或者直接「不写」收工');
      open_.forEach(function (c) { out.push('第 ' + c.seq + ' 条的冲突还没处理'); });
      return out;
    }
    if (rec.step === 2) {
      /* 每条要写的都得给在场的人定过认知（默认「完全不知情」也算定过，
         所以这里只要求**至少动过一次**，防止整片默认值被当成「都想过了」）。 */
      if (!Object.keys(rec.knowledge || {}).length) {
        return ['人物认知一个都没定 —— 默认是「完全不知情」，也就是谁都不会记得'];
      }
      return [];
    }
    return [];
  }

  function canAdvance(rec) { return blockers(rec).length === 0; }

  function setStep(workId, step) {
    var s = Math.max(0, Math.min(3, Number(step) || 0));
    return mutate(workId, function (r) { r.step = s; return r; });
  }

  /* 前进一步（过闸门才走） */
  function advance(workId) {
    var rec = get(workId);
    if (!rec) return { ok: false, why: ['还没有开始审阅'] };
    var b = blockers(rec);
    if (b.length) return { ok: false, why: b };
    if (rec.step >= 3) return { ok: false, why: ['已经在最后一步了'] };
    setStep(workId, rec.step + 1);
    return { ok: true, step: rec.step + 1 };
  }

  function back(workId) {
    var rec = get(workId);
    if (!rec) return null;
    return setStep(workId, Math.max(0, rec.step - 1));
  }

  /* ---------------------------- 写出的一句话 ---------------------------- */

  /* 记忆库没有「认知档」这个字段，所以档位写进正文 ——
     「清楚记得」和「只记得片段」对人物来说是完全不同的两件事。 */
  function memoryLine(c, level, work) {
    var head = {
      '清晰记忆': '他清楚地记得：',
      '片段记忆': '他只记得一些片段：',
      '情绪残留': '这件事他记不清了，只留下一点情绪：',
      '角色隐瞒': '这件事他记得，但不打算说出来：'
    }[level] || '';
    return head + c.text + '（来自《' + ((work && work.title) || '一部私人剧本') + '）';
  }

  /* ---------------------------- 写入（幂等） ---------------------------- */

  function keptOf(rec) {
    return (rec && rec.candidates || []).filter(function (c) { return c.decision === 'keep'; });
  }

  /* 谁会被写：出场名单里、认知档位属于「会写」的那四个人。
     ⚠️ 名单里的角色**可能已经被删了**（删岛/删人不会清 cast —— 那是全局数据，
     core 那边不该知道帷境有这张表）。名字是建 cast 时冗余存的，所以界面上
     还看得见，但绝不能再往一个不存在的角色名下写记忆（幽灵记忆）。
     2026-09-22 衔接审计发现的。 */
  function writersOf(rec, work, candId) {
    return ((work && work.cast) || []).filter(function (p) {
      if (!Sleepy.core || !Sleepy.core.findChar(p.charId)) return false;
      return KNOWLEDGE_WRITTEN.indexOf(knowledgeOf(rec, p.charId, candId)) >= 0;
    });
  }

  /* 预览：会写几条、给谁、落哪。**不写盘** —— 第四步的确认页要用它。 */
  function plan(workId) {
    var rec = get(workId);
    var w = wj().get(workId);
    if (!rec || !w) return { items: [], count: 0 };
    var items = [];
    keptOf(rec).forEach(function (c) {
      writersOf(rec, w, c.id).forEach(function (p) {
        items.push({
          charId: p.charId, charName: p.name, candId: c.id, seq: c.seq,
          level: knowledgeOf(rec, p.charId, c.id),
          kind: c.kind,
          line: memoryLine(c, knowledgeOf(rec, p.charId, c.id), w),
          date: c.date || ''
        });
      });
    });
    return { items: items, count: items.length };
  }

  function write(workId) {
    var rec = get(workId);
    if (!rec) return { ok: false, why: 'no-record' };
    if (rec.written) return { ok: false, why: 'already-written' };   /* 幂等 */
    var b = blockers(rec);
    if (b.length) return { ok: false, why: 'blocked', blockers: b };
    var w = wj().get(workId);
    if (!w) return { ok: false, why: 'no-work' };

    var p = plan(workId);
    if (!p.count) return { ok: false, why: 'nothing' };

    var memOk = !!(Sleepy.memoryStore && Sleepy.memoryStore.writeMemoryItems);
    if (!memOk) return { ok: false, why: 'no-memory-store' };

    var n = 0;
    p.items.forEach(function (it) {
      var c = null;
      rec.candidates.forEach(function (x) { if (x.id === it.candId) c = x; });
      if (!c) return;
      Sleepy.memoryStore.writeMemoryItems(it.charId, [{
        kind: KIND_TO_MEM[c.kind] || 'custom',
        content: it.line,
        /* 「其他 App」就是字面意思：这件事是从帷境那条线过来的 */
        source: 'other_app',
        sourceRef: '帷境《' + (w.title || '') + '》',
        /* 作者在审阅台逐条批过，所以是「明确发生的事件」而不是「无法确认」 */
        evidenceType: 'confirmed_event',
        /* 批准即生效（审阅台本身就是确认台）；到记忆页还能再改 */
        status: 'active'
      }]);
      n++;
    });

    /* 带日期的候选额外落一条日历事件（方案 §5.1：定史落 memoryStore / calendar）。
       只有时间与地点、共同事件这两类才可能带日期。 */
    var evN = 0;
    if (Sleepy.calendar && Sleepy.calendar.addEvent) {
      keptOf(rec).forEach(function (c) {
        if (!c.date) return;
        if (c.kind !== 'place_time' && c.kind !== 'shared_event') return;
        var writers = writersOf(rec, w, c.id);
        writers.forEach(function (p) {
          Sleepy.calendar.addEvent({
            ownerCharId: p.charId,
            eventType: c.kind === 'place_time' ? 'shared_event' : 'shared_event',
            title: c.text.slice(0, 40),
            desc: '来自《' + (w.title || '') + '》的定史记录',
            startAt: c.date,
            allDay: true,
            sourceType: 'other_app',
            memoryId: null,
            createdBy: { type: 'user', id: 'user' }
          });
          evN++;
        });
      });
    }

    mutate(workId, function (r) {
      r.written = true;
      r.writtenAt = wj().nowISO();
      r.writtenCount = n;
      return r;
    });
    /* 作品性质跟着走一档：已经有内容进了现实，就不再是「候」了。
       只影响显示与门厅标签，不改任何权限。 */
    if (n) {
      wj().mutate(workId, function (x) {
        if (x.reality === 'canon_candidate') x.reality = 'canonized';
        return x;
      });
    }
    return { ok: true, count: n, events: evN };
  }

  /* ------------------------- 候选提取（模型） ------------------------- */

  function apiTransport(messages, ov) {
    return new Promise(function (resolve, reject) {
      var h = Sleepy.api.runChat(messages, {
        onDone: function (cand, text) { resolve(text); },
        onFail: function (list, lastErr) {
          reject(new Error((lastErr && lastErr.error) || '模型没有返回'));
        }
      }, false, ov || { maxTokens: 1500 });
      if (!h) reject(new Error('还没有可用的模型连接，去 设置 → 模型连接 填 API'));
    });
  }

  function transport(opts) {
    return (opts && opts.transport) || Sleepy.wjCanon._transport || apiTransport;
  }

  function bodyOf(w, limit) {
    var out = [];
    var n = 0;
    (w.chapters || []).forEach(function (ch) {
      if (ch.status !== 'ready') return;
      out.push('【第 ' + ch.seq + ' 章 ' + (ch.title || '') + '】');
      (ch.paras || []).forEach(function (p) {
        if (p.kind === 'scene_break') return;
        var t = String(p.text || '').trim();
        if (!t || n > (limit || 6000)) return;
        n += t.length;
        out.push(t);
      });
    });
    return out.join('\n');
  }

  function buildExtract(w) {
    var cast = (w.cast || []).map(function (p) { return p.name; }).join('、') || '（没有登记出场人物）';
    var sys = [
      '你在帮作者把一部私人剧本里**可能成为现实**的部分挑出来。',
      '剧本是虚构的。只有作者在审阅台逐条批准的事实，才会写进人物的现实记忆 —— ' +
        '所以你的活是「提候选」，不是「改小说」。',
      '【作品】《' + (w.title || '未命名') + '》' +
        (wj().REALITY_LABEL[w.reality] ? '（' + wj().REALITY_LABEL[w.reality] + '）' : ''),
      '【出场人物】' + cast,
      '',
      '【正文】',
      bodyOf(w),
      '',
      '【要挑什么】只挑**结构化的事实**，分四类：',
      '- place_time：时间与地点（某年某月他在哪、发生过什么有时有地的事）',
      '- shared_event：共同事件（两个人之间真实发生过的事）',
      '- relation：人物关系（谁对谁是什么关系、关系怎么变的）',
      '- fragment：片段记忆（一个具体的小片段，值得被记住的那种）',
      '',
      '【不要什么】不要剧情梗概、不要文学描写、不要成段的原文、不要心理活动的转述。',
      '每条一句话、不超过 40 字，写成「谁 + 做了什么/是什么」的事实句。',
      '宁可少提几条真的，也不要凑数 —— 没有可提取的就返回空数组，那是完全正常的结果。',
      '',
      '【冲突】如果这条与「已经存在的现实」明显对不上（时间对不上、关系对不上、' +
        '同一件事有两种说法），在 conflict 里写清楚哪里对不上。**只报告，不要改**。',
      '【日期】能确定日期就写 date（YYYY-MM-DD，可以只精确到月就写 YYYY-MM-01），不能确定就留空。',
      '',
      '【输出】只输出一个 JSON：',
      '{"candidates":[{"kind":"place_time","text":"…","note":"…","conflict":"","date":""}]}'
    ].join('\n');
    return [{ role: 'system', content: sys }];
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

  /* 提取候选事实。**独立职责**：只读作品门面与正文，
     不读聊天、不读记忆正文（避免把别的 app 的内容当素材）。 */
  function extract(workId, opts) {
    var w = wj().get(workId);
    if (!w) return Promise.reject(new Error('作品不存在'));
    var t = transport(opts);
    return t(buildExtract(w), { maxTokens: 1500 }).then(function (raw) {
      var obj = parseJSON(raw);
      if (!obj || !Array.isArray(obj.candidates)) throw new Error('候选没有解析成功，可以重试');
      var list = obj.candidates
        .filter(function (c) { return c && String(c.text || '').trim(); })
        .slice(0, 24)
        .map(function (c) {
          return {
            kind: c.kind, text: c.text, note: c.note,
            conflict: c.conflict, date: c.date
          };
        });
      setCandidates(workId, list);
      return list;
    });
  }

  /* ---------------------------- 出口 ---------------------------- */

  Sleepy.wjCanon = {
    KEY: KEY,
    KINDS: KINDS, DECISIONS: DECISIONS, KNOWLEDGE: KNOWLEDGE,
    KNOWLEDGE_WRITTEN: KNOWLEDGE_WRITTEN,
    KIND_TO_MEM: KIND_TO_MEM, STEPS: STEPS,

    _transport: null,
    onChange: null,

    all: all, get: get, mutate: mutate, open: open, remove: remove,
    setCandidates: setCandidates, decide: decide,
    fixConflict: fixConflict, reopenConflict: reopenConflict,
    kkey: kkey, knowledgeOf: knowledgeOf, setKnowledge: setKnowledge,
    blockers: blockers, canAdvance: canAdvance, advance: advance, back: back, setStep: setStep,
    memoryLine: memoryLine, plan: plan, write: write,
    keptOf: keptOf, writersOf: writersOf,
    buildExtract: buildExtract, extract: extract
  };

})(window);
