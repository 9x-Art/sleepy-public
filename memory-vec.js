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
  /* V1 → V2（2026-09-22）：块多了 rootId / userId —— 召回必须照 core 的规矩
     按「同一个大脑 + 同一个身份」隔离（见 blocksOf）。
     V2 → V3（同日）：主键从 rootId 泛化成 **ownerKey** ——
     私聊是 `rootId`，群聊是 `group:<groupId>`（群消息对成员是公开的，
     所以群聊召回**不套身份隔离**，见 blocksOfGroup）。
     V3 → V4（同日）：块多了 **msgIds**（这块覆盖了哪几条消息）——
     删除/编辑/撤回要**精确定位**受影响的块，只靠 fromId/toId 只能判首尾。
     三次都是「老块留着会不对」，而**索引本来就可以重建**，
     所以升级时直接丢掉重来，游标键也跟着换前缀（见 cursorKey）。 */
  var DB_VER = 4;
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
        /* 升级即重建（理由见 DB_VER 那段）：索引可重建，串记忆不可接受 */
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        var os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('ownerKey', 'ownerKey');
        os.createIndex('at', 'at');
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

  function rootOf(charId) {
    return (Sleepy.core && Sleepy.core.rootIdOf)
      ? (Sleepy.core.rootIdOf(charId) || charId) : charId;
  }

  function groupKey(groupId) { return 'group:' + groupId; }

  function scopeNow() {
    return (Sleepy.core && Sleepy.core.scopeId) ? Sleepy.core.scopeId() : null;
  }

  /* 扫「同一个 owner」的全部块。filter 决定要不要再按别的条件剔。 */
  function scanOwner(ownerKey, filter) {
    var out = [];
    return withStore('readonly', function (os) {
      var req = os.index('ownerKey').openCursor(IDBKeyRange.only(ownerKey));
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var b = cur.value;
        var sid = scopeNow();
        if ((!sid || b.sandboxId === sid) && (!filter || filter(b))) out.push(b);
        cur.continue();
      };
    }).then(function () { return out; });
  }

  /* 召回用的块。**隔离规则照抄 core.memoryViewFor**，别自己发明：
       · 有认知屏障（`cognitionOf(...).barrier`）→ 只认「同皮套 + 同马甲」的块。
         那时候角色不知道两个号是同一个人 —— 串了就是
         「它怎么知道我在小号说过的话」。
       · 没屏障 → 整个大脑（大号 + 皮套）都算，这正是「他知道我们是同一个人」。
     岛（sandboxId）两层都要过 —— 孤岛/群岛之间绝不串。 */
  /* 这一块该不该给这个身份看见（纯函数，冒烟直接打表）。
     判据和 core.memoryViewFor 一字不差 —— 那边怎么隔离，这边就怎么隔离。 */
  function visibleTo(b, charId, userId, barrier) {
    if (!b) return false;
    if (!barrier) return true;
    return b.charId === charId && b.userId === userId;
  }

  function blocksOf(charId, userId) {
    var barrier = false;
    if (Sleepy.core && Sleepy.core.cognitionOf) {
      barrier = !!Sleepy.core.cognitionOf(charId, userId).barrier;
    }
    return scanOwner(rootOf(charId), function (b) {
      return visibleTo(b, charId, userId, barrier);
    });
  }

  /* 群聊的块。**刻意不套身份隔离** —— 群消息在群里是公开的，
     所有成员看到的是同一份；套隔离反而会让「他在群里说过的话」
     对他自己不可见。可见性由调用方保证（只召回他所在的群）。 */
  function blocksOfGroup(groupId) {
    return scanOwner(groupKey(groupId), null);
  }

  /* 维护用的块（条数 / 上限裁剪 / 清空）—— 这些**不该**受身份隔离影响，
     否则「大号聊的块」永远不会被裁，能无限涨。 */
  function allOfRoot(charId) { return scanOwner(rootOf(charId), null); }
  function allOfGroup(groupId) { return scanOwner(groupKey(groupId), null); }

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
    return allOfRoot(charId).then(function (l) { return l.length; });
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
    return allOfRoot(charId).then(function (l) {
      return removeBlocks(l.map(function (b) { return b.id; }));
    });
  }

  /* ------------------- 原文变了 → 索引跟着失效（2026-09-22 晚） -------------------
     为什么是「删块」而不是「重切」：
       · 重切要重新 embed（花钱），而且会切出一批和现有块**重叠**的新块 ——
         同一段内容有两个块，召回时会被当成两件事；
       · 用户的删除意图本来就是「忘掉它」；
       · 编辑一般发生在刚说过的话上，那段本来就在近期原文窗口里，
         再远一点由总结层（L2）兜。
     代价（如实记着）：这段内容就**永久离开索引**了。
     理由：索引里的原文是**给模型看的证据** —— 它跟存档对不上就是幻觉源。
     宁可这段召回不到，也不能让 TA 引用一句根本不存在的话。

     filter: { charId } 或 { groupId }（必给一个）
             可选 ids       只失效「覆盖到这些消息」的块（删除/编辑/撤回）
             可选 sourceId  只清某一场会话（删掉一个对话时用） */
  function forget(filter) {
    filter = filter || {};
    var key = filter.groupId ? groupKey(filter.groupId)
            : (filter.charId ? rootOf(filter.charId) : '');
    if (!key) return Promise.resolve(0);
    var ids = (filter.ids && filter.ids.length) ? filter.ids : null;
    return scanOwner(key, null).then(function (list) {
      var hit = list.filter(function (b) {
        if (filter.sourceId && b.sourceId !== filter.sourceId) return false;
        if (!ids) return true;
        return blockHitBy(b, ids);   /* 没 msgIds 的块返回 false —— DB 升级即重建，不会有 */
      });
      return removeBlocks(hit.map(function (b) { return b.id; }));
    })['catch'](function () { return 0; });
  }

  /* 全库概览（设置页用）：按 ownerKey 聚合成一行一行。
     名字不在这里解析 —— 向量层不认识 core 的角色和群。 */
  function overview() {
    var map = {};
    return withStore('readonly', function (os) {
      var req = os.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var b = cur.value || {};
        var k = b.ownerKey;
        if (!k) { cur.continue(); return; }
        var e = map[k];
        if (!e) {
          e = map[k] = { ownerKey: k, kind: b.kind || 'chat',
            charId: b.charId || null, groupId: b.groupId || null,
            sourceIds: {}, blocks: 0, newestAt: 0, oldestAt: 0 };
        }
        e.blocks++;
        if (b.sourceId) e.sourceIds[b.sourceId] = 1;
        var at = b.at || 0;
        if (at > e.newestAt) e.newestAt = at;
        if (!e.oldestAt || (at && at < e.oldestAt)) e.oldestAt = at;
        cur.continue();
      };
    }).then(function () {
      var out = [];
      for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) {
        var e = map[k];
        e.sources = Object.keys(e.sourceIds).length;
        delete e.sourceIds;
        out.push(e);
      }
      out.sort(function (a, b) { return (b.newestAt || 0) - (a.newestAt || 0); });
      return out;
    }, function () { return []; });
  }

  /* 手工试一次召回（设置页「试试召回」用）。**不落缓存、不改任何状态** ——
     它只回答「这句话会捞回哪些块、像不像」，让用户自己判断准不准
     （「真实召回质量」这件事没法在代码里断言，只能给人眼看）。 */
  function probe(filter, query) {
    filter = filter || {};
    if (!enabled()) return Promise.resolve({ ok: false, why: 'off' });
    var q = String(query || '').trim();
    if (!q) return Promise.resolve({ ok: false, why: 'empty' });
    var load = filter.groupId
      ? function () { return blocksOfGroup(filter.groupId); }
      : function () { return blocksOf(filter.charId, filter.userId || null); };
    return available().then(function (ok) {
      if (!ok) return { ok: false, why: 'noidb' };
      return load().then(function (blocks) {
        if (!blocks.length) return { ok: true, blocks: 0, items: [] };
        return embedTexts([q]).then(function (res) {
          if (!res.ok) return { ok: false, why: 'embed', error: res.error };
          var scored = rank(blocks, res.vectors[0]).slice(0, 8);
          return { ok: true, blocks: blocks.length, items: scored.map(function (s) {
            return { text: s.block.text, sim: s.sim, score: s.score,
              at: s.block.at, kind: s.block.kind };
          }) };
        });
      });
    })['catch'](function (e) {
      return { ok: false, why: 'error', error: (e && e.message) || String(e) };
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
  function nextBlock(messages, from, lineOf) {
    var lines = [];
    var msgs = [];
    var chars = 0;
    var i = from;
    while (i < messages.length) {
      var m = messages[i];
      var line = (typeof lineOf === 'function') ? lineOf(m) : msgLine(m, lineOf);
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
      /* 这块覆盖的消息 id（删除/编辑/撤回靠它定位，见 forget） */
      msgIds: msgs.map(function (x) { return x.id; }).filter(Boolean),
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

  /* 这条块要不要因为「这些消息被删/被改/被撤回」而失效（纯函数，冒烟打表）。
     判据是 msgIds 有交集 —— 只靠 fromId/toId 只能判首尾，
     中间那条被删就漏了。 */
  function blockHitBy(b, ids) {
    var mine = (b && b.msgIds) || [];
    if (!mine.length || !ids || !ids.length) return false;
    for (var i = 0; i < ids.length; i++) {
      if (mine.indexOf(ids[i]) >= 0) return true;
    }
    return false;
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

  /* 前缀带 2：V1 → V2 那次升级把老块全丢了（见 DB_VER），
     老游标必须跟着作废，否则它以为自己写过了、新块永远不写。 */
  function cursorKey(chatId) { return 'vecCursor2:' + chatId; }

  /* ---- 连续失败就退避（2026-09-22 晚）----
     原来失败只是「游标不推进 ＝ 下轮重试」—— 接口挂了（key 写错、余额空、
     断网）时，用户每收一条消息就往那个坏接口再打一次，永远打。
     退避是**指数**的、10 分钟封顶；成功一次立刻清零。
     一次失败不算数（网络抖动很常见），要连着来才算「这个接口有问题」。 */
  function backoffKey(cursorId) { return 'vecFail:' + cursorId; }
  function backoffOf(cursorId) {
    var r = store.get(backoffKey(cursorId));
    if (!r || !r.until || Date.now() >= r.until) return 0;
    return r.until - Date.now();
  }
  function bumpFail(cursorId) {
    var r = store.get(backoffKey(cursorId)) || {};
    var n = (r.n || 0) + 1;
    var wait = Math.min(30 * 1000 * Math.pow(2, n - 1), 10 * 60 * 1000);
    store.set(backoffKey(cursorId), { n: n, until: Date.now() + wait });
    return wait;
  }
  function clearFail(cursorId) { store.remove(backoffKey(cursorId)); }

  /* ---- 游标：记「最后切到的那条消息的 id」，不只记下标 ----
     只记下标的话，**删掉一条消息会让后面全部前移**，游标就指到了别处 ——
     紧接着的那条会被永远跳过（2026-09-23 真机抓到：删掉中间的 m2 之后，
     m23 再也没进过索引）。下标仍然存着，当 lastId 找不到时的兜底。 */
  function indexOfId(msgs, id) {
    for (var i = 0; i < msgs.length; i++) if (msgs[i] && msgs[i].id === id) return i;
    return -1;
  }
  function readCursor(ck, msgs) {
    var cur = store.get(ck);
    if (cur && typeof cur === 'object') {
      var i = cur.lastId ? indexOfId(msgs, cur.lastId) : -1;
      if (i >= 0) return i + 1;
      if (typeof cur.index === 'number' && cur.index >= 0 && cur.index <= msgs.length) {
        return cur.index;
      }
      return 0;
    }
    if (typeof cur === 'number' && cur >= 0 && cur <= msgs.length) return cur;
    return 0;
  }
  function writeCursor(ck, msgs, end) {
    var last = msgs[end - 1];
    store.set(ck, { index: end, lastId: (last && last.id) || null });
  }

  /* 把这个对话里「还没进向量库的」消息块补上。异步、失败不影响聊天。
     幂等靠 `vecCursor:<chatId>` 记「已经切到第几条」—— 不靠内容比对。 */
  /* ---- 通用写法：一个「源」→ 若干块 ----
     线上私聊 / 线下私聊 / 群聊（线上线下）都走这里。三个源只差：
       ownerKey  召回主键（私聊 = rootId，群聊 = group:<id>）
       lineOf    一条消息怎么变成一行
       cursorId  游标挂在谁身上 */
  function sweepSource(src) {
    if (!enabled() || !src || !src.ownerKey) return Promise.resolve({ ok: false, why: 'off' });
    var waiting = backoffOf(src.cursorId);
    if (waiting) return Promise.resolve({ ok: false, why: 'backoff', wait: waiting });
    return available().then(function (ok) {
      if (!ok) return { ok: false, why: 'noidb' };
      var msgs = src.messages || [];
      var ck = cursorKey(src.cursorId);
      var from = readCursor(ck, msgs);
      var made = [];
      for (var n = 0; n < SWEEP_MAX; n++) {
        var blk = nextBlock(msgs, from, src.lineOf);
        if (!blk) break;
        made.push(blk);
        from = blk.end;
      }
      if (!made.length) {
        /* 一条都没切出来也可能是「游标落后了」—— 把游标推到已经覆盖的位置，
           不然每次都要从老地方重算。 */
        writeCursor(ck, msgs, from);
        clearFail(src.cursorId);       /* 接口是通的，只是没新内容 */
        return { ok: true, added: 0 };
      }
      return embedTexts(made.map(function (b) { return b.text; })).then(function (res) {
        if (!res.ok) {
          bumpFail(src.cursorId);
          return { ok: false, why: 'embed', error: res.error };
        }
        var sid = scopeNow();
        var recs = made.map(function (b, i) {
          return {
            id: newId(),
            /* ownerKey 是召回主键；charId / userId 只有私聊有（群聊为 null）。
               照 core 记忆那套「四元组可溯源」的规矩，别省。 */
            ownerKey: src.ownerKey,
            kind: src.kind || 'chat',
            charId: src.charId || null,
            userId: src.userId || null,
            groupId: src.groupId || null,
            sourceId: src.sourceId || null,
            sandboxId: sid,
            at: b.at,
            fromId: b.fromId,
            toId: b.toId,
            msgCount: b.msgCount,
            msgIds: b.msgIds || [],
            text: b.text,
            vec: res.vectors[i]
          };
        });
        return Promise.all(recs.map(putBlock)).then(function () {
          clearFail(src.cursorId);
          writeCursor(ck, msgs, from);
          return trim(src.ownerKey).then(function () {
            return { ok: true, added: recs.length };
          });
        });
      });
    })['catch'](function (e) {
      bumpFail(src.cursorId);
      return { ok: false, why: 'error', error: (e && e.message) || String(e) };
    });
  }

  /* 线上私聊（签名不变 —— 调用方已经在用） */
  function sweep(charId, userId, chat) {
    if (!chat || !charId) return Promise.resolve({ ok: false, why: 'off' });
    var name = nameOfChar(charId);
    return sweepSource({
      ownerKey: rootOf(charId), kind: 'chat', cursorId: chat.id,
      messages: chat.messages, charId: charId, userId: userId, sourceId: chat.id,
      lineOf: function (m) { return msgLine(m, name); }
    });
  }

  /* 线下私聊。消息结构和线上不一样（user 走 text、char/scene 走 paras、还有 photo）
     —— 复用页面自己那份 messageText，别在这儿再写一遍。 */
  function sweepOffline(charId, userId, session) {
    if (!session || !charId) return Promise.resolve({ ok: false, why: 'off' });
    var name = nameOfChar(charId);
    var O = Sleepy.offlineStore;
    return sweepSource({
      ownerKey: rootOf(charId), kind: 'offline', cursorId: 'off:' + session.id,
      messages: session.messages, charId: charId, userId: userId, sourceId: session.id,
      lineOf: function (m) {
        return (O && O.messageText) ? O.messageText(m, name) : String(m.text || '');
      }
    });
  }

  /* 群聊。**线上群聊和群线下共用同一个 ownerKey**（都是「这个群的事」），
     但两者的消息表不一样（线上在 groupMessages、群线下在 session.messages），
     所以 cursorId 和 lineOf 由调用方给：
       · 线上群聊：不传 opts，用下面的默认（读 groupMessages 的字段）
       · 群线下：传 { cursorId: 'goff:<sessionId>', lineOf: 它自己那份渲染 } */
  function sweepGroup(groupId, messages, opts) {
    opts = opts || {};
    if (!groupId) return Promise.resolve({ ok: false, why: 'off' });
    var G = Sleepy.groupStore;
    return sweepSource({
      ownerKey: groupKey(groupId), kind: 'group',
      cursorId: opts.cursorId || ('grp:' + groupId),
      messages: messages, groupId: groupId, sourceId: opts.sourceId || groupId,
      lineOf: opts.lineOf || function (m) {
        if (m.type === 'system') return '（系统：' + String(m.content || '') + '）';
        /* 撤回的消息不进文本块 —— 写进索引就等于「撤回也没用，它还记得」。
           原文仍在 groupMessages 里（调度/认知结算要用），丢的只是索引。 */
        if (m.recalledAt) return '';
        var who = '?';
        if (G && G.findMember && G.accountMeta) {
          var mem = G.findMember(groupId, m.senderAccountId);
          if (mem) who = G.accountMeta(mem).name;
        }
        return who + '：' + String(m.content || '');
      }
    });
  }

  /* 上限：超了就丢最老的块。原文还在存档里，丢的只是索引。 */
  function trim(ownerKey) {
    var max = maxBlocks();
    return scanOwner(ownerKey, null).then(function (list) {
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

  /* 缓存键 = **ownerKey**（私聊是 rootId，群聊是 group:<id>）。
     私聊和群聊共用一张缓存表 —— 它们本来就是两条独立的召回线。 */
  var lastRecall = {};

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

  /* 召回内核：给定「怎么取块」，跑一遍 向量 → 重排 → 去重 → 落缓存。
     私聊和群聊只差 loadBlocks 取哪一批。 */
  function prefetchInto(key, loadBlocks, query, opts) {
    opts = opts || {};
    if (!enabled() || !key) {
      lastRecall[key] = { items: [], at: Date.now() };
      return Promise.resolve([]);
    }
    var q = String(query || '').trim();
    if (!q) {
      lastRecall[key] = { items: [], at: Date.now() };
      return Promise.resolve([]);
    }

    var work = loadBlocks().then(function (blocks) {
      if (!blocks || !blocks.length) return [];
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
      lastRecall[key] = { items: items || [], at: Date.now() };
      return items || [];
    });
  }

  /* 私聊（线上 / 线下共用同一条召回线 —— ownerKey 都是 rootId） */
  function prefetch(charId, userId, query, opts) {
    if (!charId) return Promise.resolve([]);
    return prefetchInto(rootOf(charId), function () {
      return blocksOf(charId, userId || null);
    }, query, opts);
  }

  /* 群聊：主键换成 group:<id>，**不过身份隔离**（群消息对成员是公开的）。 */
  function prefetchGroup(groupId, query, opts) {
    if (!groupId) return Promise.resolve([]);
    return prefetchInto(groupKey(groupId), function () {
      return blocksOfGroup(groupId);
    }, query, opts);
  }

  function lastOf(charId) {
    var r = lastRecall[rootOf(charId)];
    return (r && r.items) ? r.items : [];
  }

  function renderRecall(items, headLines) {
    return '[相关的过去]\n' + headLines.join('\n') + '\n' +
      items.map(function (it) {
        return '· ' + String(it.text || '').replace(/\n+/g, ' / ').slice(0, 220);
      }).join('\n');
  }

  /* 注入文本。**不写「你记得」这种口径** —— 召回命中的是原文块，
     它是「你们确实聊过这个」，不是「系统让 TA 想起」。 */
  function text(charId) {
    var items = lastOf(charId);
    if (!items.length) return '';
    return renderRecall(items, [
      '下面是你们以前真的聊过的片段（按和现在这个话题的相关度挑的，时间顺序不一定连贯）。',
      '需要的时候可以自然接上；对不上现在的语境就别硬提。'
    ]);
  }

  /* 群聊那份。装配时群里是**共享 system**，所以一份就够 ——
     但口径要写成「群里的人都经历过」，不能写成「你和某个人聊过」：
     群里说话的是账号，不是一对一的那个身份。 */
  function groupText(groupId) {
    var r = lastRecall[groupKey(groupId)];
    var items = (r && r.items) ? r.items : [];
    if (!items.length) return '';
    return renderRecall(items, [
      '下面这些是这个群里以前真的出现过的对话（按和现在这件事的相关度挑的）。',
      '群里的人都经历过，可以自然接上；对不上现在的语境就别硬提。'
    ]);
  }
  function clearCache() { lastRecall = {}; }

  Sleepy.memoryVec = {
    enabled: enabled,
    available: available,
    /* 写入：三个源各一个入口，内核是同一份 sweepSource（见那边的注释） */
    sweep: sweep,                 /* 线上私聊 */
    sweepOffline: sweepOffline,   /* 线下私聊 */
    sweepGroup: sweepGroup,       /* 群聊（线上 + 群线下共用，消息都在 groupMessages） */
    /* 召回：私聊一条线、群聊一条线 */
    prefetch: prefetch,
    prefetchGroup: prefetchGroup,
    lastOf: lastOf,
    text: text,
    groupText: groupText,
    stats: function (charId) {
      return allOfRoot(charId).then(function (l) {
        return { blocks: l.length, max: maxBlocks() };
      });
    },
    statsGroup: function (groupId) {
      return allOfGroup(groupId).then(function (l) {
        return { blocks: l.length, max: maxBlocks() };
      });
    },
    clear: clearAll,
    total: total,
    /* 原文变了 → 索引失效（删除 / 编辑 / 撤回 / 删对话，见 forget 的注释） */
    forget: forget,
    /* 设置页：看清索引里有什么、能清、能自己试一次召回 */
    overview: overview,
    probe: probe,
    clearCache: clearCache,
    cursorKey: cursorKey,
    /* 纯函数出口 —— 冒烟直接打表，不用起 IDB */
    _pure: {
      nextBlock: nextBlock,
      cosine: cosine,
      rank: rank,
      dropOverlapping: dropOverlapping,
      blockHitBy: blockHitBy,
      buildQuery: buildQuery,
      visibleTo: visibleTo,
      msgLine: msgLine,
      groupKey: groupKey,
      rootOf: rootOf,
      blockHitBy: blockHitBy,
      readCursor: readCursor,
      writeCursor: writeCursor
    },
    MIN_MSGS: MIN_MSGS, MAX_MSGS: MAX_MSGS,
    MIN_CHARS: MIN_CHARS, MAX_CHARS: MAX_CHARS,
    INJECT_MAX: INJECT_MAX,
    PREFETCH_TIMEOUT: PREFETCH_TIMEOUT
  };

})(window);
