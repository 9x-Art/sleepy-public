/* ============================================================
   memory-vec.js — L4 动态检索层（向量记忆 v1）

   定位（v5 §L4 原话）：**向量只是候选生成器**，最终还要经过实体、权限、
   时间、状态和重要度重排。所以这个文件里没有「向量分排序取前几」这种写法 ——
   召回走 rank()，将来要加权重只动那一处（方案 §3.5 留的钩子）。

   存哪：**IndexedDB，不是 localStorage**。1536 维 float32 一条就 6KB，
   本地存档那点配额几百条就爆（方案 §3 原话）。照 media.js 那套写。

   ★ 块里**存一份文本**（`text`）。方案里写过「向量是索引不是副本」，
     这里刻意例外，两个理由：
       · 召回必须回填**原文块**才准（只给摘要的「准」是假的）；
       · 消息会被删、会被编辑、线下会话会被清 —— 只存 id 的话召回时可能
         什么都取不回来。多存 600 字的代价远小于「索引指向空气」。
     它同时也是 v5 说的「证据库」：超出近期窗口后原文仍留着。

   写入时机：**绝不阻塞聊天**。聊天收完一条回复后喊一声 sweep()，它异步跑，
   失败把块留在队列里下次再试。每次最多写 1 块，避免一进页面就猛发请求。

   召回时机：发送前 prefetch()（异步，超时就放弃）。装配是同步的，
   所以结果落在 lastOf(charId) 缓存里，槽位同步读。

   依赖：store.js、api.js、page-singleapi.js、core.js
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  var DB_NAME = 'sleepy-vec';
  var DB_VER = 1;
  var STORE = 'vec';

  /* 切块（方案 §3 / v5 §8.2 照抄）：线上 4～6 轮。一轮 = 你我各一条，
     所以 8～12 条，同时用字数兜底（很长的消息一条就够一块）。 */
  var MIN_MSGS = 8;
  var MAX_MSGS = 12;
  var MIN_CHARS = 600;
  var MAX_CHARS = 1000;

  var RECALL_TOPK = 12;     /* 向量候选先取这么多，再重排 */
  var INJECT_MAX = 4;       /* 最终注入几条 */
  var CAND_DAYS = 0.8;      /* 重排里「语义相似」的权重（时间占 0.2） */
  var PREFETCH_TIMEOUT = 1500;   /* 召回超时（毫秒）—— 宁可这轮不召回，别卡住聊天 */

  function cfg() {
    var c = store.get('vecCfg');
    return (c && typeof c === 'object') ? c : {};
  }

  function enabled() {
    var c = cfg();
    if (c.enabled === false) return false;
    /* 没配向量接口 = 没开。不要「悄悄回落主 API」—— 对话模型喂 /embeddings
       只会 404（api.js embed 那边也是这个道理）。 */
    var v = Sleepy.singleApi ? Sleepy.singleApi.cfgOf('vector') : null;
    return !!(v && v.baseUrl && v.model);
  }

  function maxBlocks() {
    var n = parseInt(cfg().maxBlocks, 10);
    return (n > 0 && n <= 5000) ? n : 500;
  }

  /* ---------------------------- IndexedDB ---------------------------- */

  var supported = !!global.indexedDB;
  var dbPromise = null;

  function open() {
    if (!supported) return Promise.reject(new Error('这台设备不支持 IndexedDB'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = global.indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('charId', 'charId');
          os.createIndex('at', 'at');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开向量库')); };
      req.onblocked = function () { reject(new Error('向量库被另一个标签页占着')); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function withStore(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
        var os = t.objectStore(STORE);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error || new Error('向量库读写失败')); };
        t.onabort = function () { reject(t.error || new Error('向量库写入被中断')); };
      });
    });
  }

  function available() {
    if (!supported) return Promise.resolve(false);
    return open().then(function () { return true; }, function () { return false; });
  }

  function newId() {
    return 'vb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* 某个角色、当前岛的全部块（召回时一次读进来，几百条量级用游标很快） */
  function blocksOf(charId) {
    var out = [];
    return withStore('readonly', function (os) {
      var idx = os.index('charId');
      var req = idx.openCursor(IDBKeyRange.only(charId));
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var sid = Sleepy.core && Sleepy.core.scopeId ? Sleepy.core.scopeId() : null;
        if (!sid || cur.value.sandboxId === sid) out.push(cur.value);
        cur.continue();
      };
    }).then(function () { return out; });
  }

  function putBlock(rec) {
    return withStore('readwrite', function (os) { os.put(rec); }).then(function () {
      return rec.id;
    });
  }

  function removeBlocks(ids) {
    if (!ids || !ids.length) return Promise.resolve(0);
    return withStore('readwrite', function (os) {
      ids.forEach(function (id) { os.delete(id); });
    }).then(function () { return ids.length; });
  }

  function countOf(charId) {
    return blocksOf(charId).then(function (l) { return l.length; });
  }

  /* 全库条数（设置页显示「有没有在干活」用 —— 那边没有角色上下文） */
  function total() {
    var n = 0;
    return withStore('readonly', function (os) {
      var req = os.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        n++;
        cur.continue();
      };
    }).then(function () { return n; }, function () { return 0; });
  }

  function clearAll(charId) {
    return blocksOf(charId).then(function (l) {
      return removeBlocks(l.map(function (b) { return b.id; }));
    });
  }

  /* ---------------------------- 纯函数（冒烟直接打表） ---------------------------- */

  /* 一条消息 → 块里的一行。type 消息（转账/表情包…）也带上，别丢。 */
  function msgLine(m, nameOf) {
    var text = String((m && m.content) || '').trim();
    if (!text) return '';
    var who = m.role === 'user' ? '我' : (nameOf || '对方');
    return who + '：' + text;
  }

  /* 从 messages[from] 起切一块。返回 { msgs, text, at, end } 或 null
     （null = 剩下的还不够一块，等更多消息再来）。
     两个上限同时管：条数（8～12）和字数（忙起来会写很长）。 */
  function nextBlock(messages, from, nameOf) {
    var lines = [];
    var msgs = [];
    var chars = 0;
    var i = from;
    while (i < messages.length) {
      var m = messages[i];
      var line = msgLine(m, nameOf);
      i++;
      if (!line) continue;
      lines.push(line);
      msgs.push(m);
      chars += line.length;
      if (lines.length >= MAX_MSGS || chars >= MAX_CHARS) break;
      if (lines.length >= MIN_MSGS && chars >= MIN_CHARS) break;
    }
    /* 走到末尾还不够一块 → 先不切（下次有更多消息再说）。
       除非已经攒到 MAX_CHARS —— 那时候它是「一条就很长的消息」，值得单独成块。 */
    if (i >= messages.length && lines.length < MIN_MSGS && chars < MAX_CHARS) return null;
    if (!lines.length) return null;
    return {
      text: lines.join('\n'),
      at: (msgs[msgs.length - 1] || {}).timestamp || Date.now(),
      fromId: (msgs[0] || {}).id || null,
      toId: (msgs[msgs.length - 1] || {}).id || null,
      msgCount: lines.length,
      end: i
    };
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return 0;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /* 重排：v5 那六个权重表在这里砍成「语义 + 时间」两条（方案 §3 的取舍）。
     ★ 将来要补实体/未完成承诺/关注队列那几路，**只动这一个函数**。 */
  function rank(blocks, qvec, now) {
    now = now || Date.now();
    var scored = blocks.map(function (b) {
      var sim = cosine(b.vec, qvec);
      var days = Math.max(0, (now - (b.at || 0)) / 86400000);
      var recency = 1 / (1 + days / 7);          /* 一周内衰减一半左右 */
      return {
        block: b,
        sim: sim,
        score: CAND_DAYS * sim + (1 - CAND_DAYS) * recency
      };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  /* 硬过滤：权限/岛/状态靠 blocksOf 那只取本岛本人的块完成；
     这里再排掉「本来就在近期原文窗口里的那些」——
     重复注入会让模型以为是两件事。 */
  function dropOverlapping(scored, sinceAt) {
    if (!sinceAt) return scored;
    return scored.filter(function (s) { return (s.block.at || 0) < sinceAt; });
  }

  /* ---------------------------- 写入 ---------------------------- */

  /* 一次 sweep 最多写这么多个块（多了会一次发好几个 embedding 请求） */
  var SWEEP_MAX = 2;

  function cursorKey(chatId) { return 'vecCursor:' + chatId; }

  /* 把这个对话里「还没进向量库的」消息块补上。异步、失败不影响聊天。
     幂等靠 `vecCursor:<chatId>` 记「已经切到第几条」—— 不靠内容比对。 */
  function sweep(charId, userId, chat) {
    if (!enabled() || !chat || !charId) return Promise.resolve({ ok: false, why: 'off' });
    return available().then(function (ok) {
      if (!ok) return { ok: false, why: 'noidb' };
      var msgs = (chat.messages || []);
      var cur = parseInt(store.get(cursorKey(chat.id)), 10);
      var from = (cur >= 0 && cur <= msgs.length) ? cur : 0;
      var nameOf = nameOfChar(charId);
      var made = [];
      for (var n = 0; n < SWEEP_MAX; n++) {
        var blk = nextBlock(msgs, from, nameOf);
        if (!blk) break;
        made.push(blk);
        from = blk.end;
      }
      if (!made.length) {
        /* 一条都没切出来也可能是「游标落后了」—— 把游标推到已经覆盖的位置，
           不然每次都要从老地方重算。 */
        if (from !== cur) store.set(cursorKey(chat.id), from);
        return { ok: true, added: 0 };
      }
      return embedTexts(made.map(function (b) { return b.text; })).then(function (res) {
        if (!res.ok) return { ok: false, why: 'embed', error: res.error };
        var sid = Sleepy.core && Sleepy.core.scopeId ? Sleepy.core.scopeId() : null;
        var recs = [];
        made.forEach(function (b, i) {
          recs.push({
            id: newId(),
            charId: charId,
            sandboxId: sid,
            chatId: chat.id,
            kind: 'chat',
            at: b.at,
            fromId: b.fromId,
            toId: b.toId,
            msgCount: b.msgCount,
            text: b.text,
            vec: res.vectors[i]
          });
        });
        return Promise.all(recs.map(putBlock)).then(function () {
          store.set(cursorKey(chat.id), from);
          return trim(charId).then(function () {
            return { ok: true, added: recs.length };
          });
        });
      });
    })['catch'](function (e) {
      return { ok: false, why: 'error', error: (e && e.message) || String(e) };
    });
  }

  /* 上限：超了就丢最老的块。原文还在存档里，丢的只是索引。 */
  function trim(charId) {
    var max = maxBlocks();
    return blocksOf(charId).then(function (list) {
      if (list.length <= max) return 0;
      var sorted = list.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
      var drop = sorted.slice(0, list.length - max).map(function (b) { return b.id; });
      return removeBlocks(drop);
    });
  }

  function embedTexts(texts) {
    var v = Sleepy.singleApi ? Sleepy.singleApi.cfgOf('vector') : null;
    if (!v) return Promise.resolve({ ok: false, error: '没配向量接口' });
    return Sleepy.api.embed(v, texts).then(function (r) {
      if (!r.ok) return { ok: false, error: r.error };
      /* 服务端有时返回单个对象、有时返回数组，api.js 那边已经归一 */
      var vecs = r.vectors || r.embeddings || [];
      if (!Array.isArray(vecs) || !vecs.length) return { ok: false, error: '返回里没有向量' };
      return { ok: true, vectors: vecs };
    });
  }

  function nameOfChar(charId) {
    var c = Sleepy.core && Sleepy.core.findChar ? Sleepy.core.findChar(charId) : null;
    return (c && c.name) || '对方';
  }

  /* ---------------------------- 召回 ---------------------------- */

  var lastRecall = {};   /* charId → { items: [...], at: 时间戳 } */

  /* v5 §9.1：查询 = 最近 1～2 轮原文 + 当前输入（本地规则抽，不调模型）。
     场景/人名 v1 不抽（那是锦上添花，先看最朴素的能不能用）。 */
  function buildQuery(recentLines, input) {
    var parts = [];
    (recentLines || []).forEach(function (t) {
      var s = String(t || '').trim();
      if (s) parts.push(s);
    });
    var q = String(input || '').trim();
    if (q) parts.push(q);
    return parts.join('\n').slice(-1200);
  }

  function prefetch(charId, query, opts) {
    opts = opts || {};
    if (!enabled() || !charId) { lastRecall[charId] = { items: [], at: Date.now() }; return Promise.resolve([]); }
    var q = String(query || '').trim();
    if (!q) { lastRecall[charId] = { items: [], at: Date.now() }; return Promise.resolve([]); }

    var work = blocksOf(charId).then(function (blocks) {
      if (!blocks.length) return [];
      return embedTexts([q]).then(function (res) {
        if (!res.ok) return [];
        var scored = rank(blocks, res.vectors[0]);
        scored = dropOverlapping(scored, opts.sinceAt);
        return scored.slice(0, INJECT_MAX).map(function (s) {
          return { text: s.block.text, at: s.block.at, score: s.score, sim: s.sim };
        });
      });
    })['catch'](function () { return []; });

    /* 超时保护：宁可这轮不召回，也不能把聊天卡住 */
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve([]); }, opts.timeout || PREFETCH_TIMEOUT);
    });

    return Promise.race([work, timeout]).then(function (items) {
      lastRecall[charId] = { items: items || [], at: Date.now() };
      return items || [];
    });
  }

  function lastOf(charId) {
    var r = lastRecall[charId];
    return (r && r.items) ? r.items : [];
  }

  /* 注入文本。**不写「你记得」这种口径** —— 召回命中的是原文块，
     它是「你们确实聊过这个」，不是「系统让 TA 想起」。 */
  function text(charId) {
    var items = lastOf(charId);
    if (!items.length) return '';
    var lines = items.map(function (it) {
      return '· ' + String(it.text || '').replace(/\n+/g, ' / ').slice(0, 220);
    });
    return '[相关的过去]\n' +
      '下面是你们以前真的聊过的片段（按和现在这个话题的相关度挑的，时间顺序不一定连贯）。' +
      '需要的时候可以自然接上；对不上现在的语境就别硬提。\n' +
      lines.join('\n');
  }

  function clearCache() { lastRecall = {}; }

  Sleepy.memoryVec = {
    enabled: enabled,
    available: available,
    sweep: sweep,
    prefetch: prefetch,
    lastOf: lastOf,
    text: text,
    stats: function (charId) {
      return blocksOf(charId).then(function (l) {
        return { blocks: l.length, max: maxBlocks() };
      });
    },
    clear: clearAll,
    total: total,
    clearCache: clearCache,
    cursorKey: cursorKey,
    /* 纯函数出口 —— 冒烟直接打表，不用起 IDB */
    _pure: {
      nextBlock: nextBlock,
      cosine: cosine,
      rank: rank,
      dropOverlapping: dropOverlapping,
      buildQuery: buildQuery,
      msgLine: msgLine
    },
    MIN_MSGS: MIN_MSGS, MAX_MSGS: MAX_MSGS,
    MIN_CHARS: MIN_CHARS, MAX_CHARS: MAX_CHARS,
    INJECT_MAX: INJECT_MAX,
    PREFETCH_TIMEOUT: PREFETCH_TIMEOUT
  };

})(window);
