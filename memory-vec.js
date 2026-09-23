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
   失败把块留在队列里下次再试。每次最多写 2 块，避免一进页面就猛发请求。

   召回时机：发送前 prefetch()（异步，超时就放弃）。装配是同步的，
   所以结果落在 lastOf(charId) 缓存里，槽位同步读。

   ★★ 四种 ownerKey（块的归属，2026-09-23 向量补源时定）：
        rootOf(charId)   角色自己的大脑 —— 对话 / 档案 / 查手机（他脑子里的东西）
        group:<groupId>  一个群 —— 群消息对成员公开
        island:<sandboxId> 岛上的公共内容 —— 朋友圈动态（一条数据全岛共享）
        user:<userId>    **我写的日记** —— 私密内容，按账号隔离
      一次私聊召回会把「角色池 + 本岛池 + 本条账号池」合起来查（见 poolsFor）。

   ★★ 块的 iso（屏障下按什么隔离，§8.3）：
        both（缺省）同皮套 + 同马甲（对话）；none 公开（群）；char 按角色（档案 /
        查手机 / 他写的日记）；user 按账号（动态 / 我写的日记）。
      缺省 both → **老块行为一字不变**。

   ★★ 可见性**不在建块时判**（§8.2）：全量建块，召回时由 visibleTo（隔离）
      + stillVisible（回源复核：这条还在吗、现在还有权吗）两道算。
      这样权限放宽 / 收紧都不用重扫索引 —— 只有源数据被删才需要删块。

   依赖：store.js、api.js、page-singleapi.js、core.js
        （素材源还惰性用 page-moments / page-diary / page-memory / phone）
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
     V4 → V5（同日，外部评审指出）：块多了 **model / dim / at0** ——
     ① 换 embedding 模型后，老块的向量在新模型的语义空间里**没有意义**，
     算出来的相似度是「看着像数字的噪音」（同维度不同模型完全静默）；
     ② 群聊要按「成员都在场之后」过滤，得知道块里**第一条**消息的时间。
     四次都是「老块留着会不对」，而**索引本来就可以重建**，
     所以升级时直接丢掉重来，游标键也跟着换前缀（见 cursorKey）。 */
  var DB_VER = 5;
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

  /* 一条**素材**（日记 / 动态事件包 / 档案 / 手机条目）内部的分片上限。
     为什么素材要允许分片而对话不用：一篇长日记可能远超 embedding 的安全长度，
     超了要么被服务端悄悄截断（我们不知道截在哪）、要么直接报错。
     切点在适配层做（见 segText），**不在 blocker 里** —— blocker 保持「一条一块」。
     片与片**不重叠**（素材是「一件件的事」，重叠会让同一件事被注入两次）。 */
  var SEG_CHARS = 1000;

  function cfg() {
    var c = store.get('vecCfg');
    return (c && typeof c === 'object') ? c : {};
  }

  /* 现在配的是哪台 embedding 模型。块记下它、召回只认同一台 ——
     换了模型之后，老块的向量在新模型的语义空间里没有意义，
     算出来的相似度是「看着像数字的噪音」，而且**不报错**
     （维度不同会被 cosine 挡成 0，同维度不同模型更是完全静默）。
     宁可这轮召回不到，也不能喂一堆错的进去。 */
  function modelNow() {
    var v = Sleepy.singleApi ? Sleepy.singleApi.cfgOf('vector') : null;
    return (v && v.model) || '';
  }
  function sameModel(b) {
    var m = modelNow();
    if (!m) return true;          /* 没配接口时根本不会召回，这条走不到 */
    return ((b && b.model) || '') === m;
  }

  function enabled() {
    var c = cfg();
    if (c.enabled === false) return false;
    /* 没配向量接口 = 没开。不要「悄悄回落主 API」—— 对话模型喂 /embeddings
       只会 404（api.js embed 那边也是这个道理）。 */
    var v = Sleepy.singleApi ? Sleepy.singleApi.cfgOf('vector') : null;
    return !!(v && v.baseUrl && v.model);
  }

  /* 上限（默认 500 / 大脑）—— 但**分两池**淘汰，不一刀切：
     一刀切的话素材（档案 / 日记 / 朋友圈 / 查手机）会被近期对话块挤光，
     而档案恰恰是最该长期留的。用户 2026-09-23 拍板 **对话 300 / 素材 200**（3:2）。
     用户配的 `vecCfg.maxBlocks` 仍当「总量」，按同一个 3:2 分给两池 ——
     这样老存档的配置继续有效，设置页那个输入框的语义也不变。 */
  function maxBlocks() {
    var n = parseInt(cfg().maxBlocks, 10);
    return (n > 0 && n <= 5000) ? n : 500;
  }

  /* 分池的判据：这几个 kind 是「素材」（长期留），其余都算对话。 */
  var MEMO_KINDS = { mem: 1, diary: 1, moment: 1, phone: 1 };
  function poolOf(kind) { return MEMO_KINDS[kind] ? 'memo' : 'chat'; }
  function poolMax(pool) {
    var n = maxBlocks();
    var chat = Math.round(n * 0.6);        /* 500 → 300 */
    return pool === 'memo' ? (n - chat) : chat;
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

  /* 岛级公共池：朋友圈动态这种「一条数据、全岛共享、可见性逐角色判」的内容。
     用户 2026-09-23 拍板：**一条动态只建一个块**（不按角色复制）——
     所以它不能挂 rootOf(charId)（那是「某个角色的大脑」），得有个岛级的主键。
     好处是权限放宽 / 新角色入岛都天然不用补扫（施工卡 §8.2 要的正是这个）。 */
  function islandKey(sandboxId) { return 'island:' + sandboxId; }

  /* 账号级池：**user 自己写的日记**。日记是私密内容（方案 §5-2：
     「日历/待办/日记属于 user 私密内容，默认不对角色开放」），
     它不属于任何角色 —— 挂 user:<账号> 才是「个人内容」在结构上的样子。
     （char 写的日记不走这儿，它天然属于那个角色，挂 rootOf。）
     授权（lifeShare:<charId>.diary）仍作第二道闸，见 stillVisible。 */
  function userKey(userId) { return 'user:' + userId; }

  /* 当前这座岛的公共池主键。没降落（scopeId 为 null）时返回 null ——
     那时候没有「岛」可言，岛级源本轮就不建索引。 */
  function islandKeyNow() {
    var sid = scopeNow();
    return sid ? islandKey(sid) : null;
  }

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

  /* 这一块该不该给这个身份看见（纯函数，冒烟直接打表）。
     无屏障时全放行（他知道我们是同一个人）；有屏障时**按块的 iso 分流**。

     为什么要分 iso 而不是一刀切「同皮套 + 同马甲」（施工卡 §8.3）：
     不同源的隔离口径本来就不同 —— 档案 / 查手机是**他自己脑子里的东西**，
     我换个号它也还是那些（iso='char'）；动态 / 我写的日记是**某个身份做的事**，
     屏障下不该被另一个身份关联到（iso='user'）；群消息对成员公开（iso='none'）。
     一刀切要么把「他自己记得的事」错挡掉，要么把「A 号的事」漏给 B 号。

     iso 缺省 'both' → **老块（对话）行为一字不变**。 */
  function visibleTo(b, charId, userId, barrier) {
    if (!b) return false;
    if (!barrier) return true;
    var iso = b.iso || 'both';
    if (iso === 'none') return true;
    if (iso === 'char') return b.charId === charId;
    if (iso === 'user') return b.userId === userId;
    return b.charId === charId && b.userId === userId;
  }

  /* ------------------- 召回时回源复核（施工卡 §3.2 / §8.7） -------------------

     权限是会变的：用户能改「不让 TA 看我的动态」、能关日记授权、能删档案。
     **写块时可见 ≠ 现在可见**。所以召回前要回源确认「这条还在 + 现在还有权」。

     两条纪律：
       · **不许每块全表扫描**（§8.7）—— 一次召回先建一份按 id 的快照，O(1) 查表；
         快照**跟着这次 prefetch 建一次、用完就丢**，不跨轮缓存（否则权限改动看不见）。
       · **fail closed**（§8.7）—— 读不到 / 定位不到 / kind 不认识 → 一律不召回。
         索引里的原文是**给模型看的证据**，来源不明的东西宁可不用。 */

  /* 建快照。只读 store、纯同步，所以可以在 filter 里放心用。 */
  function buildSnapshot(charId, userId) {
    var snap = { moments: null, diaries: null, mem: null, phone: null };
    var C = Sleepy.core;
    function scope(list) { return (C && C.scoped) ? C.scoped(list) : (list || []); }

    var MT = Sleepy.momentsTab;
    if (MT && MT.all) {
      snap.moments = {};
      scope(MT.all()).forEach(function (m) { if (m && m.id) snap.moments[m.id] = m; });
    }
    var D = Sleepy.diary;
    if (D && D.list) {
      snap.diaries = {};
      (D.list() || []).forEach(function (d) { if (d && d.id) snap.diaries[d.id] = d; });
    }
    var MS = Sleepy.memoryStore;
    if (MS && MS.loadCharMemory && charId) {
      snap.mem = {};
      var f = MS.loadCharMemory(charId);
      ((f && f.memories) || []).forEach(function (m) { if (m && m.id) snap.mem[m.id] = m; });
    }
    var P = Sleepy.phone;
    if (P && P.phoneOf && charId) {
      var ph = null;
      try { ph = P.phoneOf(scopeNow(), charId); } catch (e) { ph = null; }
      if (ph && ph.id) {
        snap.phone = { ids: {} };
        [['note', P.listNotes], ['plan', P.plansOf], ['shop', P.listShop]].forEach(function (pair) {
          if (typeof pair[1] !== 'function') return;
          var arr = [];
          try { arr = pair[1](ph.id) || []; } catch (e) { arr = []; }
          var bucket = snap.phone.ids['phone:' + pair[0]] = {};
          arr.forEach(function (x) { if (x && x.id) bucket[x.id] = 1; });
        });
      }
    }
    return snap;
  }

  /* 这条块现在还要不要。charId / userId 是**当前召回的人**（不是块里的）——
     §8.2 改成「全量建块 + 召回时过滤」之后，可见性判据只能在这儿算。 */
  function stillVisible(b, charId, userId, snap) {
    if (!b || !snap) return false;
    var kind = b.kind || 'chat';
    if (kind === 'moment') {
      if (!snap.moments) return false;
      var m = snap.moments[b.itemId || b.fromId];
      if (!m || m.status === 'deleted') return false;
      /* 只留「他自己发的」和「我发的」—— 别的角色 / NPC 的动态是模型本来就知道的，
         再注一遍只是白烧 token（口径照抄 listForChar，别另发明一套）。 */
      if (m.characterId !== charId && !m.maskId) return false;
      var MT = Sleepy.momentsTab;
      return !!(MT && MT.canCharSee && MT.canCharSee(m, charId, userId));
    }
    if (kind === 'diary') {
      if (!snap.diaries) return false;
      var d = snap.diaries[b.itemId || b.fromId];
      if (!d || !d.content) return false;
      if (d.author === 'char') return d.charId === charId;   /* 他自己写的 */
      var LF = Sleepy.lifeFeed;                             /* 我写的：要授权 */
      return !!(LF && LF.diaryShared && LF.diaryShared(charId));
    }
    if (kind === 'mem') {
      if (!snap.mem) return false;
      var it = snap.mem[(b.msgIds || [])[0]];
      return !!(it && it.status === 'active');
    }
    if (kind === 'phone') {
      if (!snap.phone) return false;
      var bucket = snap.phone.ids[b.sourceId || ''];
      if (!bucket) return false;
      return !!bucket[(b.msgIds || [])[0]];
    }
    /* 只有这三类「可见性已经在别处算过」的源不查；**其余一律 fail closed** ——
       认不出的 kind 说明索引里混进了来源不明的东西，宁可不用（§8.7）。 */
    if (kind === 'chat' || kind === 'offline' || kind === 'group') return true;
    return false;
  }

  /* 一次召回要查哪几个池：**角色自己的大脑 + 本岛公共池 + 本条账号池**。
     角色池放对话 / 档案 / 查手机（它们都挂 rootOf）；
     岛池放朋友圈动态（一条数据全岛共享）；账号池放我写的日记（私密、按账号）。
     三个池合起来才是「这个角色现在能想起的全部」。 */
  function poolsFor(charId, userId) {
    var keys = [rootOf(charId)];
    var ik = islandKeyNow();
    if (ik) keys.push(ik);
    if (userId) keys.push(userKey(userId));
    return keys;
  }

  function blocksOf(charId, userId, snap) {
    var barrier = false;
    if (Sleepy.core && Sleepy.core.cognitionOf) {
      barrier = !!Sleepy.core.cognitionOf(charId, userId).barrier;
    }
    function keep(b) {
      return visibleTo(b, charId, userId, barrier) && sameModel(b) &&
        stillVisible(b, charId, userId, snap);
    }
    return Promise.all(poolsFor(charId, userId).map(function (k) {
      return scanOwner(k, keep);
    })).then(function (lists) {
      var out = [];
      lists.forEach(function (l) { out = out.concat(l); });
      return out;
    });
  }

  var GROUP_JOIN_GRACE = 60 * 1000;

  /* 群里「所有人都已经在场」的时刻 = 最晚入群的那个人的 joinedAt。
     群消息在群里共享，但共享的前提是**大家都在场**：刚被拉进来的人
     不该知道它不在场时聊了什么（现实里也看不到入群前的历史）。
     用最晚的当界是**保守**的（老成员会少看到一点），
     但反过来「让角色知道它不在场的事」是穿帮，宁可少给。 */
  function groupSince(groupId) {
    var G = Sleepy.groupStore;
    if (!G || !G.membersOf) return 0;
    var t = 0;
    (G.membersOf(groupId) || []).forEach(function (m) {
      if ((m.status || 'active') !== 'active') return;
      var j = m.joinedAt || 0;
      if (j > t) t = j;
    });
    return t;
  }

  /* 群聊的块。**刻意不套身份隔离**（群消息对成员是共享的），
     但**不是不做过滤**：只取「当前模型生成的」+「所有人都在场之后」的。
     调用方还要保证只召回他所在的群 —— 两道都要。 */
  function blocksOfGroup(groupId) {
    /* 留一分钟宽限：建群 / 加人和第一批消息常常是**同一串操作**，
       差几十毫秒就被判成「它不在场」太冤（时间戳抖动，不是语义问题）。 */
    var since = groupSince(groupId) - GROUP_JOIN_GRACE;
    return scanOwner(groupKey(groupId), function (b) {
      if (!sameModel(b)) return false;
      if (since > 0 && (b.at0 || b.at || 0) < since) return false;
      return true;
    });
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

  /* 有多少块是「别的模型」做的 —— 它们不参与召回，但占着地方。
     设置页据此提示「有 N 段是旧模型做的，建议清掉」。 */
  function staleCount() {
    var m = modelNow();
    if (!m) return Promise.resolve(0);
    var n = 0;
    return withStore('readonly', function (os) {
      var req = os.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var b = cur.value || {};
        if (((b.model) || '') !== m) n++;
        cur.continue();
      };
    }).then(function () { return n; }, function () { return 0; });
  }

  /* 清掉所有「别的模型」做的块（全库，不按 owner）。 */
  function forgetStale() {
    var m = modelNow();
    var ids = [];
    return withStore('readonly', function (os) {
      var req = os.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var b = cur.value || {};
        if (m && ((b.model) || '') !== m) ids.push(b.id);
        cur.continue();
      };
    }).then(function () {
      /* 块清了但游标还停在末尾 → 那些内容永远不会被重新索引。
         清掉就要退游标，否则「清掉」等于「永久忘掉」。 */
      resetCursors();
      return removeBlocks(ids);
    }, function () { return 0; });
  }

  function clearAll(charId) {
    return allOfRoot(charId).then(function (l) {
      return removeBlocks(l.map(function (b) { return b.id; }));
    });
  }

  /* ------------------- 「清空全部数据」的整库清理（2026-09-23 项目 1） -------------------
     为什么需要它：clearAll(charId) 只清**一个大脑**。清空整个存档时，
     别的 owner 的块会以「原文快照」的形式永久留在设备上 —— 存档里已经
     没有那段原文了，它却还能被召回进 prompt（既是幻觉源，也是隐私残留）。
     备份导入同理：旧块 + 导入回来的存档对不上，召回出来的句子是「不存在的历史」。

     返回值刻意做成**三态**，不是布尔：
       { status:'cleared' }        真清了，并且验证过 total()===0
       { status:'not-applicable' } 这台设备/这个上下文没有 IndexedDB（无痕模式等）
       { status:'failed', why }    blocked（被别的标签页占着）/ open / clear / residual
     why 分开是刻意的：**不许把「本机没有向量库」和「清理失败」混成一类**
     （前者不是失败，后者必须报错），也**不许失败还提示「已清除」**。 */
  function wipeAll() {
    /* 清理期间把召回门关上：块正在被删的时候，任何一次召回都可能
       读到「删了一半」的库。调用方（数据与备份页）会把这个门一直关到 reload。 */
    pauseRecall();
    function done(r) { resumeRecall(); return r; }

    /* 环境压根没有 IDB：不是失败，是「没有对象可清」 */
    if (!supported) return Promise.resolve(done({ status: 'not-applicable', why: 'noidb', total: null }));

    var out = { status: 'failed', why: 'open', total: null };
    return open().then(function () {
      return withStore('readwrite', function (os) { os.clear(); });
    }).then(function () {
      return total();                       /* 清完必须复核，不能「发了 clear 就当成功」 */
    }).then(function (n) {
      out.total = n;
      if (n !== 0) { out.status = 'failed'; out.why = 'residual'; return done(out); }
      /* 块没了，游标和退避记录也必须跟着失效：
         · 游标还停在末尾 = 那些内容**永远不会再被索引**（「清掉」变成「永久忘掉」）；
         · vecFail 还挂着 = 接口明明好了，头几条消息仍会被「上次失败」挡住。 */
      resetCursors();
      out.failsCleared = clearFailures();
      out.status = 'cleared';
      out.epoch = epochNow();
      return done(out);
    }, function (e) {
      var msg = (e && e.message) || String(e);
      out.status = 'failed';
      out.why = /占着/.test(msg) ? 'blocked' : 'clear';
      out.message = msg;
      return done(out);
    })['catch'](function (e) {
      out.status = 'failed';
      out.why = 'clear';
      out.message = (e && e.message) || String(e);
      return done(out);
    });
  }

  /* ---- 召回暂停门（计数式）----
     给「清空 / 导入」用：从清库那一刻到页面 reload 之间，一块都不许召回
     （用户口径：清理完成前不得继续使用旧向量块）。用计数而不是布尔，
     是因为清库自己也要关门，两处叠加时不能互相把门打开。 */
  var pauseDepth = 0;
  function pauseRecall() { pauseDepth++; }
  function resumeRecall() { pauseDepth = Math.max(0, pauseDepth - 1); }
  function recallPaused() { return pauseDepth > 0; }

  /* 全库退避记录（vecFail:*）—— 走 store.remove 是为了**连内存缓存一起清**：
     store 有缓存，绕过它直接删 localStorage 的话，读回来还是老值。 */
  function clearFailures() {
    var n = 0;
    try {
      var ls = global.localStorage;
      var ns = (store && store.NS) || 'sleepy.v1.';
      var doomed = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(ns + 'vecFail:') === 0) doomed.push(k.slice(ns.length));
      }
      for (var j = 0; j < doomed.length; j++) { store.remove(doomed[j]); n++; }
    } catch (e) { /* 读不到 localStorage 就算了，不能因为清退避把清空卡住 */ }
    return n;
  }

  /* ---------------- 向量库快照（导入失败回滚用，2026-09-23 项目 1 复核） ----------------
     为什么快照要放**另一个数据库**（sleepy-vec-snap）：
       · 主库 sleepy-vec 会被 wipeAll 整个清掉 —— 快照放里面就等于连它一起清；
       · 也不该为了让快照有地方放就升主库版本（升级会重建 vec store、清掉全部旧块，
         那是项目 5 的活）。独立库两边都不碰。
     快照**不是长期数据**：导入成功或回滚成功后立刻丢掉（块里含原文）。
     它同时也是「清空全部数据」必须清的一项（见清空页的 restoreArtifacts 步骤）。 */
  var SNAP_DB = 'sleepy-vec-snap';
  var SNAP_VER = 1;
  var SNAP_STORE = 'blocks';
  var snapPromise = null;

  function openSnap() {
    if (!supported) return Promise.reject(new Error('这台设备不支持 IndexedDB'));
    if (snapPromise) return snapPromise;
    snapPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = global.indexedDB.open(SNAP_DB, SNAP_VER); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(SNAP_STORE)) {
          db.createObjectStore(SNAP_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开快照库')); };
      req.onblocked = function () { reject(new Error('快照库被另一个标签页占着')); };
    });
    snapPromise['catch'](function () { snapPromise = null; });
    return snapPromise;
  }

  function withSnap(mode, fn) {
    return openSnap().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = db.transaction(SNAP_STORE, mode); } catch (e) { reject(e); return; }
        var os = t.objectStore(SNAP_STORE);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error || new Error('快照库读写失败')); };
        t.onabort = function () { reject(t.error || new Error('快照库写入被中断')); };
      });
    });
  }

  /* 游标扫全表（withStore / withSnap 的 fn 里同步返回数组，onsuccess 慢慢填） */
  function readAllOf(os) {
    var out = [];
    var req = os.openCursor();
    req.onsuccess = function () {
      var cur = req.result;
      if (!cur) return;
      out.push(cur.value);
      cur.continue();
    };
    return out;
  }

  function snapCount() {
    if (!supported) return Promise.resolve(0);
    var n = 0;
    return withSnap('readonly', function (os) {
      var req = os.openCursor();
      req.onsuccess = function () { var c = req.result; if (!c) return; n++; c.continue(); };
    }).then(function () { return n; }, function () { return 0; });
  }

  /* 把主库全部块搬进快照库（覆盖式），返回 {ok, count} */
  function snapBlocks() {
    if (!supported) return Promise.resolve({ ok: true, count: 0, why: 'noidb' });
    var blocks = null;
    return withStore('readonly', function (os) { blocks = readAllOf(os); })
      .then(function () {
        return withSnap('readwrite', function (os) {
          os.clear();
          blocks.forEach(function (b) { if (b && b.id) os.put(b); });
        });
      })
      .then(function () { return snapCount(); })
      .then(function (n) {
        /* 写完必须复核：数量对不上 = 快照不可信 —— 宁可不回滚，也不能回滚成半个 */
        if (n !== blocks.length) return { ok: false, why: 'count', want: blocks.length, got: n };
        return { ok: true, count: n };
      })['catch'](function (e) {
        return { ok: false, why: 'error', message: (e && e.message) || String(e) };
      });
  }

  /* 把快照库的块写回主库（覆盖式：主库可能被 wipeAll 删了一半，先清干净） */
  function snapRestore() {
    if (!supported) return Promise.resolve({ ok: true, count: 0, why: 'noidb' });
    var blocks = null;
    return withSnap('readonly', function (os) { blocks = readAllOf(os); })
      .then(function () {
        return withStore('readwrite', function (os) {
          os.clear();
          blocks.forEach(function (b) { if (b && b.id) os.put(b); });
        });
      })
      .then(function () { return total(); })
      .then(function (n) {
        if (n !== blocks.length) return { ok: false, why: 'residual', want: blocks.length, got: n };
        return { ok: true, count: n };
      })['catch'](function (e) {
        return { ok: false, why: 'error', message: (e && e.message) || String(e) };
      });
  }

  /* 丢掉快照（导入成功 / 回滚成功之后立刻做） */
  function snapDrop() {
    if (!supported) return Promise.resolve(true);
    return withSnap('readwrite', function (os) { os.clear(); })
      .then(function () { return true; }, function () { return false; });
  }

  /* ---- 索引状态快照：游标 + 退避 + 世代号 ----
     它们住在 localStorage 里，但**不在「存档」的语义里**（只是索引的进度）。
     所以回滚必须单独把它们写回去：只恢复存档、不恢复游标的话，
     旧块回来了、游标却指向新存档的位置 —— 索引会错位，或者那些内容永远不再补。
     游标前缀按 `vecCursor` 匹配、**不绑死版本号**（项目 5 会从 3 换成 4）。 */
  function indexState() {
    var out = { cursors: {}, fails: {}, epoch: epochNow() };
    try {
      var ls = global.localStorage;
      var ns = (store && store.NS) || 'sleepy.v1.';
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(ns) !== 0) continue;
        var top = k.slice(ns.length);
        if (top.indexOf('vecCursor') === 0) out.cursors[top] = store.get(top);
        else if (top.indexOf('vecFail:') === 0) out.fails[top] = store.get(top);
      }
    } catch (e) { /* 读不到就给空的：宁可少恢复，也不能让回滚整个挂掉 */ }
    return out;
  }

  function restoreIndexState(snap) {
    snap = snap || {};
    var n = 0;
    try {
      var doomed = [];
      var ls = global.localStorage;
      var ns = (store && store.NS) || 'sleepy.v1.';
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(ns) !== 0) continue;
        var top = k.slice(ns.length);
        if (top.indexOf('vecCursor') === 0 || top.indexOf('vecFail:') === 0) doomed.push(top);
      }
      /* 先清掉现有的游标/退避，再写快照里的 —— 否则会留下一批「快照里没有」的残留进度 */
      doomed.forEach(function (t) { store.remove(t); });
      Object.keys(snap.cursors || {}).forEach(function (t) { store.set(t, snap.cursors[t]); n++; });
      Object.keys(snap.fails || {}).forEach(function (t) { store.set(t, snap.fails[t]); n++; });
      if (typeof snap.epoch === 'number') store.set('vecEpoch', snap.epoch);
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
    return { ok: true, restored: n, epoch: snap.epoch };
  }

  /* 清掉全部向量游标（清空用）。返回清掉几个。 */
  function clearCursors() {
    var n = 0;
    try {
      var doomed = [];
      var ls = global.localStorage;
      var ns = (store && store.NS) || 'sleepy.v1.';
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(ns) !== 0) continue;
        var top = k.slice(ns.length);
        if (top.indexOf('vecCursor') === 0) doomed.push(top);
      }
      doomed.forEach(function (t) { store.remove(t); n++; });
    } catch (e) { /* 同 clearFailures：清不掉不该把整条清空卡住 */ }
    return n;
  }

  /* 「清空全部数据」的向量侧**敏感过程数据**（游标 / 退避 / 快照库 / 召回缓存）
     刻意**不**做打包入口：清空页要按项目分开报告，某一件失败时必须说得出是哪一件 ——
     所以它按零件调用（clearCursors / clearFailures / clearCache / snapDrop）。 */

  /* ---- 手动把「本岛的聊天」补进索引（设置页那个按钮，2026-09-23）----
     为什么需要它：sweep 是聊天时**后台悄悄跑的**，而且失败全静默
     （why 只可能是 off / backoff / embed / noidb，谁也看不见）——
     用户唯一的反馈就是「聊了半天，一条都没有」，然后不知道该怪谁。
     这个入口一次做三件事：
       ① **清退避**：用户主动重试，不该被上一次的失败挡着（否则点了毫无反应）；
       ② **多轮切块**：一轮最多切 2 块（SWEEP_MAX），聊得多就得跑好几轮；
       ③ **把每一条的结果报出来**：哪一场失败、什么原因、接口说了什么。
     只扫**本岛**会话（块的 sandboxId 用当前岛盖章，扫别岛的会话会把它们的原文盖上本岛的章）。 */
  function sweepIsland(opts) {
    opts = opts || {};
    var out = { ok: false, why: '', chats: 0, added: 0, rounds: 0, failed: [] };
    if (!enabled()) { out.why = 'off'; return Promise.resolve(out); }
    var core = Sleepy.core;
    var sid = scopeNow();
    if (!core || !sid) { out.why = 'noisland'; return Promise.resolve(out); }

    return available().then(function (okAvail) {
      if (!okAvail) { out.why = 'noidb'; return out; }

      var members = {};
      if (core.charsOfSandbox) {
        core.charsOfSandbox(sid).forEach(function (c) { if (c && c.id) members[c.id] = 1; });
      }
      var chats = (store.get('chats') || []).filter(function (c) {
        if (!c || !c.characterId || !((c.messages || []).length)) return false;
        var root = core.rootIdOf ? (core.rootIdOf(c.characterId) || c.characterId) : c.characterId;
        return !!(members[root] || members[c.characterId]);
      });
      out.chats = chats.length;
      if (!chats.length) { out.ok = true; out.why = 'nochat'; return out; }

      clearFailures();                       /* ① 手动重试：先把上次的退避清掉 */

      var ROUNDS = opts.rounds || 8;
      return chats.reduce(function (chain, c) {
        return chain.then(function () {
          var n = 0;
          function round() {
            if (n >= ROUNDS) return Promise.resolve();
            n++;
            out.rounds++;
            return sweep(c.characterId, c.userId, c).then(function (r) {
              if (r && r.ok) {
                out.added += (r.added || 0);
                if (!r.added) return;        /* 切完了（或本来就没新内容）→ 这场不用再跑 */
                return round();              /* ② 还有就接着切 */
              }
              out.failed.push({
                chatId: c.id, name: c.name || '', why: (r && r.why) || 'unknown',
                error: (r && r.error) || ''
              });
            }, function (e) {
              out.failed.push({
                chatId: c.id, name: c.name || '', why: 'throw',
                error: (e && e.message) || String(e)
              });
            });
          }
          return round();
        });
      }, Promise.resolve()).then(function () {
        out.ok = !out.failed.length;
        out.why = out.ok ? (out.added ? 'ok' : 'nothing') : 'partial';
        return out;
      });
    })['catch'](function (e) {
      out.why = 'error';
      out.error = (e && e.message) || String(e);
      return out;
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

     filter: { ownerKey } 或 { charId } 或 { groupId }（必给一个；ownerKey 优先，
             岛级 / 账号级池没有 charId 可推，只能直接给 ownerKey）
             可选 ids       只失效「覆盖到这些消息/条目」的块（删除/编辑/撤回）
             可选 sourceId  只清某一场会话 / 某个子源（删对话 / 删动态时用） */
  function forget(filter) {
    filter = filter || {};
    var key = ownerKeyFor(filter);
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
            sourceIds: {}, kinds: {}, blocks: 0, chatCount: 0, memoCount: 0,
            newestAt: 0, oldestAt: 0 };
        }
        /* 各 kind 的数量 + 两个池的分布（设置页按 kind 分组显示，见 §8.8） */
        var kd = b.kind || 'chat';
        e.kinds[kd] = (e.kinds[kd] || 0) + 1;
        if (poolOf(kd) === 'memo') e.memoCount++; else e.chatCount++;
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
        /* 两池各自的上限（设置页要显示「当前数 / 上限」，§8.8） */
        e.chatMax = poolMax('chat');
        e.memoMax = poolMax('memo');
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
      : function () {
          var uid = filter.userId || null;
          /* 试召回也要回源复核 —— 不然「试试召回」会给出比真实召回更乐观的结果 */
          return blocksOf(filter.charId, uid, buildSnapshot(filter.charId, uid));
        };
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
    if (from >= messages.length) return null;   /* 已经到底 = 真没有 */
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
    /* 一条有效行都没切到（整段都是该跳过的内容）：
       已经到末尾就**把游标推过去** —— 不然下次从同一位置重扫，永远不前进。
       （这不是假设问题：群聊里「整段都是撤回消息」就会走到这里。） */
    if (!lines.length) return { skipTo: i };   /* 跳过了若干空行到底 → 让游标推过去 */
    /* 走到末尾还不够一块 → 先不切（下次有更多消息再说）。
       除非已经攒到 MAX_CHARS —— 那时候它是「一条就很长的消息」，值得单独成块。 */
    if (i >= messages.length && lines.length < MIN_MSGS && chars < MAX_CHARS) return null;
    return {
      text: lines.join('\n'),
      at: (msgs[msgs.length - 1] || {}).timestamp || Date.now(),
      /* 块里**第一条**消息的时间。群聊按「成员都在场之后」过滤要用它 ——
         只看 at（末尾）会放过一块跨越入群时刻的内容。 */
      at0: (msgs[0] || {}).timestamp || 0,
      fromId: (msgs[0] || {}).id || null,
      toId: (msgs[msgs.length - 1] || {}).id || null,
      msgCount: lines.length,
      /* 这块覆盖的消息 id（删除/编辑/撤回靠它定位，见 forget） */
      msgIds: msgs.map(function (x) { return x.id; }).filter(Boolean),
      end: i
    };
  }

  /* 一条一块 —— 非对话源（朋友圈动态包 / 日记篇 / 记忆档案条 / 查手机条目）用这个。
     对话的 nextBlock 会把 8～12 条**合并**成一块，那对素材是串味：三条不相干的
     动态拼成一块，召回来就是四不像。素材天然「一条就是一个完整的事」，一条一块才准。

     返回形状与 nextBlock 对齐；返回 null = 后面没有能进库的了（游标停住）。
     lineOf 返回空串的条目要**跳过而不是成块**（空块会占位、还会污染召回）。 */
  function blockerOne(messages, from, lineOf) {
    if (from >= messages.length) return null;   /* 已经到底 = 真没有（不是「跳过」） */
    var i = from;
    while (i < messages.length) {
      var m = messages[i];
      var line = (typeof lineOf === 'function')
        ? lineOf(m) : String((m && (m.text || m.content)) || '').trim();
      i++;
      if (!line) continue;
      var at = (m && (m.timestamp || m.at)) || Date.now();
      return {
        text: line,
        at: at,
        at0: (m && (m.timestamp || m.at)) || 0,
        fromId: (m && m.id) || null,
        toId: (m && m.id) || null,
        msgCount: 1,
        /* 超长条目的分片共享同一个 itemId —— **删除/整组淘汰都按条目，不按片**
           （游标仍走 m.id：片 id 唯一，indexOfId 不会找错）。 */
        msgIds: (m && (m.itemId || m.id)) ? [m.itemId || m.id] : [],
        /* 块级归属（施工卡 §8.3）：适配层在伪条目上放好，这里原样带出。
           iso 决定屏障下的隔离口径（见 visibleTo），charId/userId 记「这条属于谁」
           —— **不是「谁在看」**。undefined 表示「没指定，用源级的」。 */
        itemId: (m && m.itemId) || null,
        seg: (m && m.seg) || 0,
        segCount: (m && m.segCount) || 1,
        iso: (m && m.iso) || null,
        charId: (m && m.charId !== undefined) ? m.charId : undefined,
        userId: (m && m.userId !== undefined) ? m.userId : undefined,
        end: i
      };
    }
    /* 一路都是空行 → 告诉调用方「from 到末尾都不进库，游标直接推过去」。
       （返回 null 的话游标会停在原地、下次从同一位置重扫 —— 见 sweepSource 的 skipTo 分支。） */
    return { skipTo: messages.length };
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

  /* 前缀的版本号**必须跟着 DB_VER 走**：DB 升级会清掉老块，
     而游标存在 localStorage 里活得好好的 —— 不作废它就会以为自己写过了，
     新块永远不写，索引一直空着（这是最容易漏的一处配套）。 */
  function cursorKey(chatId) { return 'vecCursor3:' + chatId; }

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
      /* 换了 embedding 模型 → 游标作废，从头重建：
         老块的向量在新模型下没有意义（见 sameModel），得重新算一遍。
         不这么做的话，那些内容会永远停在「旧模型」状态。 */
      if ((cur.model || '') !== modelNow()) return 0;
      if ((cur.epoch || 0) !== epochNow()) return 0;   /* 被「清掉索引」作废过 */
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
    store.set(ck, {
      index: end,
      lastId: (last && last.id) || null,
      model: modelNow(),         /* 哪台模型切的（换模型就作废，见 readCursor） */
      epoch: epochNow()          /* 哪个世代（用户清过索引就作废） */
    });
  }

  /* 让**所有**游标作废 → 下次 sweep 从头重建（用户点了「清掉索引」时用）。
     不清游标的话「清掉」等于「永远忘掉」：老块没了、游标又停在末尾。

     做法是一个「世代号」而不是去翻 localStorage 删键 ——
     store 有**内存缓存**，绕过它直接删键的话，读的时候还会命中缓存里的老游标
     （真机上就是这么翻车的：删了、读回来还在）。 */
  function epochNow() { return store.get('vecEpoch') || 0; }
  function resetCursors() {
    var n = epochNow() + 1;
    store.set('vecEpoch', n);
    return n;
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
        /* blocker 默认是对话的 nextBlock（8～12 条合并成一块）；非对话源
           （朋友圈 / 日记 / 档案 / 查手机）传 blockerOne —— 素材一条一块。 */
        var blk = (src.blocker || nextBlock)(msgs, from, src.lineOf);
        if (!blk) break;
        /* 纯跳过：blocker 说「from..skipTo 这些都不进库」。
           没这条协议的话，整段都是空行时游标会**停在原地**、下次重扫同一段
           （群聊里「整段都是撤回消息」就会走到这儿）。 */
        if (blk.skipTo != null) { from = blk.skipTo; continue; }
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
            /* ownerKey 是召回主键；charId / userId 记「这条数据属于谁」。
               照 core 记忆那套「四元组可溯源」的规矩，别省。 */
            ownerKey: src.ownerKey,
            kind: src.kind || 'chat',
            /* 块级优先（施工卡 §8.3）：一个源里不同条目的归属可能不同
               （动态有「角色发的」和「我发的」两种），blocker 带出来就用它。 */
            charId: (b.charId !== undefined ? b.charId : src.charId) || null,
            userId: (b.userId !== undefined ? b.userId : src.userId) || null,
            groupId: src.groupId || null,
            sourceId: src.sourceId || null,
            sandboxId: sid,
            at: b.at,
            at0: b.at0 || b.at || 0,
            /* 哪台模型的产物。换模型后这些块**不再参与召回**（见 sameModel）——
               不同模型的向量空间不可比，比出来的相似度是噪音。 */
            model: modelNow(),
            dim: (res.vectors[i] || []).length,
            fromId: b.fromId,
            toId: b.toId,
            msgCount: b.msgCount,
            msgIds: b.msgIds || [],
            /* 屏障下的隔离口径（缺省 both = 老块行为不变）+ 分片归属（§8.6） */
            iso: b.iso || src.iso || 'both',
            itemId: b.itemId || null,
            seg: b.seg || 0,
            segCount: b.segCount || 1,
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

  /* ------------------- 素材源（2026-09-23 向量补源） -------------------
     四个源都走同一个 sweepSource，只差 ownerKey / lineOf / 归属（iso）。
     共性：
       · **数组必须时间正序**（游标按 lastId 找位置再 +1）—— phone 的 list* 全倒序，
         必须自己 sort；moments / diaries 是追加序，也统一 sort 一次。
       · **一条一块**（blockerOne）—— 三条不相干的动态拼成一块就是串味。
       · **超长条目分片**（segText），片共享 itemId，删除 / 整组淘汰按条目。
       · 写入时机 = **变更时显式喊**（施工卡 §5-3），不做 store.onChange 统一监听。
     */

  /* 当前身份（马甲）。老日记没记账号（历史数据没有这个字段），
     兜底归到「他当前在用的账号」—— 比不建索引好，代价见 §8.2 的说明。 */
  function userIdNow() {
    var C = Sleepy.core;
    var u = (C && C.activeUserOnIsland) ? C.activeUserOnIsland() : null;
    return (u && u.id) || null;
  }

  /* 一条动态 → 一个**事件包**（施工卡 §4.1）：正文 + 点赞行 + 评论行。
     v5 §6.1 就是这么设计的 —— 互动不是独立事件，它是这条动态的一部分。 */
  function momentText(m) {
    var lines = [];
    var who = m.characterId
      ? (nameOfChar(m.characterId) + '（他自己发的）')
      : (m.name || '她');
    var body = String(m.text || '').trim();
    lines.push(who + '发了一条动态：' + (body || '（只配了图）'));
    var likes = m.likes || [];
    if (likes.length) {
      lines.push('点赞：' + likes.map(function (l) {
        return (l && l.name) || '有人';
      }).join('、'));
    }
    (m.comments || []).forEach(function (c) {
      if (!c) return;
      var cn = (c.kind === 'char' && c.refId) ? nameOfChar(c.refId) : (c.name || '我');
      var t = String(c.text || '').trim();
      lines.push(cn + '：' + (t || '（表情）'));
    });
    return lines.join('\n');
  }

  /* 朋友圈：**岛级公共池**（一条动态一个块，不按角色复制 —— 用户 2026-09-23 拍板）。
     可见性**不在这里滤**：全量建块，召回时由 stillVisible 按当前角色 + 身份判
     （§8.2：这样权限放宽 / 新角色入岛都不用补扫）。
     ⚠️ 别用 listForChar —— 它带「10 天 / 12 条」窗口，那是给**实时注入**用的；
        建索引必须全量，否则三个月前的动态永远进不了库。 */
  function sweepMoments() {
    var MT = Sleepy.momentsTab;
    if (!MT || !MT.all) return Promise.resolve({ ok: false, why: 'off' });
    var ik = islandKeyNow();
    if (!ik) return Promise.resolve({ ok: false, why: 'noisland' });
    var C = Sleepy.core;
    var list = ((C && C.scoped) ? C.scoped(MT.all()) : (MT.all() || []))
      .filter(function (m) { return m && m.id && m.status !== 'deleted'; })
      .sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var items = [];
    list.forEach(function (m) {
      segText(momentText(m), SEG_CHARS).forEach(function (t, i, arr) {
        items.push({
          id: m.id + (arr.length > 1 ? '#' + i : ''),
          itemId: m.id, seg: i, segCount: arr.length,
          timestamp: m.at || 0, text: t,
          /* 归属（§8.3）：角色发的记角色（iso='char'），我发的记账号（iso='user'）——
             屏障下「A 号发的动态」不该被 B 号身份关联到。 */
          iso: m.characterId ? 'char' : 'user',
          charId: m.characterId || null,
          userId: m.maskId || null
        });
      });
    });
    return sweepSource({
      ownerKey: ik, kind: 'moment', cursorId: 'moment',
      sourceId: 'moment', messages: items,
      lineOf: function (x) { return x.text; },
      blocker: blockerOne
    });
  }

  /* 日记。两类归属（用户 2026-09-23 拍板 —— 日记是**私密内容**，不是岛上的公共墙）：
       · char 写的 → 挂 rootOf(那个角色)，iso='char'（他自己写的东西）
       · 我写的   → 挂 user:<账号>，iso='user'（**个人内容**，按账号隔离）
     授权（lifeShare:<charId>.diary）不在建块时判，召回时由 stillVisible 判
     —— 这样「关 → 开」不用补扫（§8.2），历史日记当场就能召回。 */
  function sweepDiary() {
    var D = Sleepy.diary;
    if (!D || !D.list) return Promise.resolve({ ok: false, why: 'off' });
    var list = (D.list() || [])
      .filter(function (d) { return d && d.id && String(d.content || '').trim(); })
      .sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
    var jobs = [];
    var byUser = {}, byChar = {};
    list.forEach(function (d) {
      var item = {
        id: d.id, itemId: d.id,
        timestamp: d.timestamp || 0,
        text: String(d.content || '').trim()
      };
      if (d.author === 'char' && d.charId) {
        (byChar[d.charId] = byChar[d.charId] || []).push(item);
      } else {
        var uid = d.userId || userIdNow() || '';
        (byUser[uid] = byUser[uid] || []).push(item);
      }
    });
    Object.keys(byUser).forEach(function (uid) {
      if (!uid) return;   /* 既没记账号、当前也没有身份 → 这轮不建（fail closed） */
      jobs.push(sweepSource({
        ownerKey: userKey(uid), kind: 'diary', cursorId: 'diary:user:' + uid,
        sourceId: 'diary', iso: 'user', messages: byUser[uid],
        lineOf: function (x) { return x.text; },
        blocker: blockerOne
      }));
    });
    Object.keys(byChar).forEach(function (cid) {
      jobs.push(sweepSource({
        ownerKey: rootOf(cid), kind: 'diary', cursorId: 'diary:char:' + cid,
        sourceId: 'diary', charId: cid, iso: 'char', messages: byChar[cid],
        lineOf: function (x) { return x.text; },
        blocker: blockerOne
      }));
    });
    if (!jobs.length) return Promise.resolve({ ok: true, added: 0 });
    return Promise.all(jobs).then(function (rs) {
      var added = 0;
      rs.forEach(function (r) { added += (r && r.added) || 0; });
      return { ok: true, added: added };
    });
  }

  /* 记忆档案：**一条档案一块**，只接 status==='active'
     （pending 未确认、invalid / superseded 已废 —— 都不进，施工卡 §4.3）。
     ownerKey = rootOf(角色) —— 档案天然挂在某个角色下（每角色一份），
     iso='char'（**他自己脑子里的东西**，跨马甲共享）。 */
  function sweepMem(charId) {
    var MS = Sleepy.memoryStore;
    if (!MS || !MS.loadCharMemory || !charId) return Promise.resolve({ ok: false, why: 'off' });
    var file = MS.loadCharMemory(charId) || {};
    var items = (file.memories || [])
      .filter(function (m) {
        return m && m.id && m.status === 'active' && String(m.content || '').trim();
      })
      .sort(function (a, b) {
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      })
      .map(function (m) {
        return {
          id: m.id, itemId: m.id,
          timestamp: Date.parse(m.createdAt) || 0,
          text: (m.isAnchor ? '（他记着的）' : '') + String(m.content || '').trim(),
          iso: 'char', charId: charId, userId: null
        };
      });
    if (!items.length) return Promise.resolve({ ok: true, added: 0 });
    return sweepSource({
      ownerKey: rootOf(charId), kind: 'mem', cursorId: 'mem:' + charId,
      sourceId: 'mem', charId: charId, iso: 'char', messages: items,
      lineOf: function (x) { return x.text; },
      blocker: blockerOne
    });
  }

  /* 查手机（本轮三类）：备忘 / 计划 / 订单 —— 最有叙事价值、最像记忆的三样。
     浏览 / 健康 / 派生会话与草稿**本轮不接**（噪声大，施工卡 §4.4）。
     「user 翻手机的痕迹」（traces / sessions / perms）**永远不进**（方案 §2）。
     ownerKey = rootOf(角色)（他手机里的东西，iso='char'）。 */
  var PHONE_SUBS = [
    { sub: 'note', what: '备忘' },
    { sub: 'plan', what: '计划' },
    { sub: 'shop', what: '订单' }
  ];

  function phoneListOf(P, sub, phoneId) {
    if (sub === 'note') return P.listNotes(phoneId);
    if (sub === 'plan') return P.plansOf(phoneId);
    if (sub === 'shop') return P.listShop(phoneId);
    return [];
  }

  function phoneTextOf(sub, x) {
    if (sub === 'note') {
      return '备忘：' + (x.title ? x.title + ' —— ' : '') + String(x.content || '');
    }
    if (sub === 'plan') {
      return '计划：' + String(x.title || '') + '（' + String(x.status || '') + '）';
    }
    if (sub === 'shop') {
      return '订单：' + String(x.title || '') +
        (x.price ? ' ¥' + x.price : '') +
        (x.purpose ? '（用途：' + x.purpose + '）' : '') +
        ' 状态 ' + String(x.status || '');
    }
    return '';
  }

  function sweepPhone(charId) {
    var P = Sleepy.phone;
    if (!P || !P.phoneOf || !charId) return Promise.resolve({ ok: false, why: 'off' });
    var ph = null;
    try { ph = P.phoneOf(scopeNow(), charId); } catch (e) { ph = null; }
    if (!ph || !ph.id) return Promise.resolve({ ok: false, why: 'nophone' });
    var jobs = PHONE_SUBS.map(function (def) {
      var arr = [];
      try { arr = phoneListOf(P, def.sub, ph.id) || []; } catch (e) { arr = []; }
      /* ⚠️ list* 全是**倒序**（新→旧）→ 自己 sort 正序，否则游标会乱、内容重复索引 */
      var items = arr.slice()
        .sort(function (a, b) {
          return (a.at || a.createdAt || 0) - (b.at || b.createdAt || 0);
        })
        .map(function (x) {
          var t = phoneTextOf(def.sub, x).trim();
          return (x && x.id && t) ? {
            id: x.id, itemId: x.id,
            timestamp: x.at || x.createdAt || 0, text: t,
            iso: 'char', charId: charId, userId: null
          } : null;
        }).filter(Boolean);
      if (!items.length) return Promise.resolve({ ok: true, added: 0 });
      return sweepSource({
        ownerKey: rootOf(charId), kind: 'phone',
        /* ⚠️ sourceId 必须带子类型：phoneNotes 的 m1 和 phoneShop 的 m1 会串源（§8.4） */
        sourceId: 'phone:' + def.sub,
        cursorId: 'phone:' + def.sub + ':' + ph.id,
        charId: charId, iso: 'char', messages: items,
        lineOf: function (x) { return x.text; },
        blocker: blockerOne
      });
    });
    return Promise.all(jobs).then(function (rs) {
      var added = 0;
      rs.forEach(function (r) { added += (r && r.added) || 0; });
      return { ok: true, added: added };
    });
  }

  /* 素材的 ownerKey 推导 —— **调用方不该自己拼**（会拼错：把动态拼到角色池、
     把我写的日记拼到角色池）。sweepMoments / sweepDiary / reindexItem / forget
     用的都是这一套规则，别处再抄一遍迟早漂。 */
  function ownerKeyFor(o) {
    o = o || {};
    if (o.ownerKey) return o.ownerKey;
    if (o.kind === 'moment') return islandKeyNow();
    if (o.kind === 'diary') {
      if (o.charId) return rootOf(o.charId);
      var uid = o.userId || userIdNow();
      return uid ? userKey(uid) : null;
    }
    if (o.kind === 'mem' || o.kind === 'phone') {
      return o.charId ? rootOf(o.charId) : null;
    }
    if (o.groupId) return groupKey(o.groupId);
    if (o.charId) return rootOf(o.charId);
    return null;
  }

  /* ------------------- 素材「改一条」的定向重建入口 -------------------
     调用方只喊一声「这条变了」，**不用自己组装文本** —— 把源变成块的那套规则
     （事件包怎么拼、评论算不算、前缀写什么）只该有一份。别处再写一遍就会漂：
     建索引时和重建时切法不一样，召回出来就是四不像，而且查不出来。
     条目不在了 / 不该在（status 变了 / 文本空了）→ 顺手把旧块清掉。 */

  function refreshMoment(momentId) {
    var MT = Sleepy.momentsTab, C = Sleepy.core;
    if (!MT || !MT.all || !momentId) return Promise.resolve({ ok: false, why: 'off' });
    var m = null;
    ((C && C.scoped) ? C.scoped(MT.all()) : (MT.all() || [])).forEach(function (x) {
      if (x && x.id === momentId) m = x;
    });
    if (!m || m.status === 'deleted') {
      return forget({ kind: 'moment', ids: [momentId] });
    }
    var iso = m.characterId ? 'char' : 'user';
    return reindexItem({
      kind: 'moment', sourceId: 'moment', iso: iso,
      charId: m.characterId || null, userId: m.maskId || null,
      item: {
        id: m.id, timestamp: m.at || 0, text: momentText(m),
        iso: iso, charId: m.characterId || null, userId: m.maskId || null
      },
      lineOf: function (x) { return x.text; }
    });
  }

  function refreshDiary(entry) {
    if (!entry || !entry.id) return Promise.resolve({ ok: false, why: 'noid' });
    var iso = entry.author === 'char' ? 'char' : 'user';
    var uid = (iso === 'user') ? (entry.userId || userIdNow() || null) : null;
    var text = String(entry.content || '').trim();
    if (!text || (iso === 'user' && !uid)) {
      return forget({ kind: 'diary', charId: entry.charId || null, userId: uid, ids: [entry.id] });
    }
    return reindexItem({
      kind: 'diary', sourceId: 'diary', iso: iso,
      charId: entry.charId || null, userId: uid,
      item: {
        id: entry.id, timestamp: entry.timestamp || 0, text: text,
        iso: iso, charId: entry.charId || null, userId: uid
      },
      lineOf: function (x) { return x.text; }
    });
  }

  /* 档案：**状态变了也走这里** —— invalid / 物理删除 → 旧块清掉；
     还是 active → 重切（内容或锚点变了，块里的文本要跟上）。 */
  function refreshMem(charId, memId) {
    var MS = Sleepy.memoryStore;
    if (!MS || !MS.loadCharMemory || !charId || !memId) {
      return Promise.resolve({ ok: false, why: 'off' });
    }
    var m = null;
    (((MS.loadCharMemory(charId) || {}).memories) || []).forEach(function (x) {
      if (x && x.id === memId) m = x;
    });
    if (!m || m.status !== 'active') {
      return forget({ kind: 'mem', charId: charId, sourceId: 'mem', ids: [memId] });
    }
    return reindexItem({
      kind: 'mem', sourceId: 'mem', charId: charId, iso: 'char',
      item: {
        id: m.id, timestamp: Date.parse(m.createdAt) || 0,
        text: (m.isAnchor ? '（他记着的）' : '') + String(m.content || '').trim(),
        iso: 'char', charId: charId, userId: null
      },
      lineOf: function (x) { return x.text; }
    });
  }

  function refreshPhone(charId, sub, id) {
    var P = Sleepy.phone;
    if (!P || !P.phoneOf || !charId || !sub || !id) {
      return Promise.resolve({ ok: false, why: 'off' });
    }
    var ph = null;
    try { ph = P.phoneOf(scopeNow(), charId); } catch (e) { ph = null; }
    if (!ph || !ph.id) return Promise.resolve({ ok: false, why: 'nophone' });
    var gone = function () {
      return forget({ kind: 'phone', charId: charId, sourceId: 'phone:' + sub, ids: [id] });
    };
    var arr = [];
    try { arr = phoneListOf(P, sub, ph.id) || []; } catch (e) { arr = []; }
    var x = null;
    arr.forEach(function (r) { if (r && r.id === id) x = r; });
    if (!x) return gone();
    var t = phoneTextOf(sub, x).trim();
    if (!t) return gone();
    return reindexItem({
      kind: 'phone', sourceId: 'phone:' + sub, charId: charId, iso: 'char',
      item: {
        id: x.id, timestamp: x.at || x.createdAt || 0, text: t,
        iso: 'char', charId: charId, userId: null
      },
      lineOf: function (v) { return v.text; }
    });
  }

  /* 上限：超了就丢最老的块。原文还在存档里，丢的只是索引。
     **分两池各自淘汰**（对话 / 素材）—— 理由见 poolOf / poolMax 的注释。
     **按 itemId 整组淘汰**（施工卡 §8.8）：一篇长日记切成 3 片，若只丢其中 2 片，
     召回出来就是半篇残句 —— 一个事件要么整组留、要么整组走。 */
  function trim(ownerKey) {
    return scanOwner(ownerKey, null).then(function (list) {
      var pools = { chat: [], memo: [] };
      list.forEach(function (b) { pools[poolOf(b.kind)].push(b); });
      var drop = [];
      ['chat', 'memo'].forEach(function (p) {
        var arr = pools[p], cap = poolMax(p);
        if (arr.length <= cap) return;
        /* 分组：有 itemId 的按 itemId 成组（分片共享它），没有的自己一组。
           组内最新的 at 当这组的排序键，组间按它从老到新丢。 */
        var groups = {}, order = [];
        arr.forEach(function (b) {
          var g = b.itemId || b.id;
          if (!groups[g]) { groups[g] = { items: [], newest: 0 }; order.push(g); }
          groups[g].items.push(b);
          var at = b.at || 0;
          if (at > groups[g].newest) groups[g].newest = at;
        });
        order.sort(function (a, b) { return groups[a].newest - groups[b].newest; });
        var remain = arr.length;
        order.forEach(function (g) {
          if (remain <= cap) return;
          drop = drop.concat(groups[g].items.map(function (b) { return b.id; }));
          remain -= groups[g].items.length;
        });
      });
      return drop.length ? removeBlocks(drop) : 0;
    });
  }

  /* 把一个超长文本切成若干片（施工卡 §8.6）。**片与片不重叠** ——
     素材是「一件件的事」，重叠会让同一件事被注入两次。
     切点优先级：段落（\n\n）→ 句号 / 换行 → 硬切。
     做分片只有一个理由：embedding 有安全长度，超了要么被服务端悄悄截断
     （我们不知道截在哪）、要么直接报错。 */
  function segText(text, max) {
    var s = String(text || '').trim();
    if (!s) return [];
    max = max || SEG_CHARS;
    if (s.length <= max) return [s];
    var out = [], rest = s;
    while (rest.length > max) {
      var head = rest.slice(0, max);
      var cut = -1;
      var p = head.lastIndexOf('\n\n');            /* ① 段落 */
      if (p >= max * 0.5) cut = p + 2;
      if (cut < 0) {                                /* ② 句末 / 换行 */
        ['\n', '。', '！', '？', '.', '!', '?'].some(function (ch) {
          var i = head.lastIndexOf(ch);
          if (i >= max * 0.5) { cut = i + 1; return true; }
          return false;
        });
      }
      if (cut <= 0) cut = max;                      /* ③ 硬切 */
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(function (x) { return x; });
  }

  /* ------------------- 定向重建（施工卡 §8.1） -------------------
     改一条**旧**条目（两个月前的日记、一条老档案）不能只删块 ——
     删了就是永久失去：近期窗口兜不住、总结层也未必覆盖。

     流程 = 先按 (ownerKey + sourceId + ids) 精确删掉这条的旧块，
            再用 blockerOne 对**单条**重新切块 + embed + 写入。
     **不是**喊普通 sweep —— 游标早就越过它了，普通 sweep 永远不回头。 */
  function reindexItem(opts) {
    opts = opts || {};
    var item = opts.item;
    var key = ownerKeyFor(opts);
    if (!enabled() || !key || !item) return Promise.resolve({ ok: false, why: 'off' });
    var itemId = item.itemId || item.id;
    if (!itemId) return Promise.resolve({ ok: false, why: 'noid' });
    return available().then(function (ok) {
      if (!ok) return { ok: false, why: 'noidb' };
      /* ① 删旧块（按条目 id 精确命中 —— 分片共享同一个 itemId，一次删干净） */
      return forget({ ownerKey: key, sourceId: opts.sourceId, ids: [itemId] })
        .then(function () {
          /* ② 重新切块。切法必须和建索引时**同一套**，否则两次结果对不上。 */
          var text = String((opts.lineOf ? opts.lineOf(item) : item.text) || '').trim();
          if (!text) return { ok: true, skipped: true };
          var segs = segText(text, SEG_CHARS);
          var blks = segs.map(function (t, i) {
            return {
              text: t, at: item.timestamp || item.at || Date.now(),
              at0: item.timestamp || item.at || 0,
              fromId: item.id, toId: item.id, msgCount: 1,
              msgIds: [itemId],
              itemId: itemId, seg: i, segCount: segs.length,
              iso: item.iso || opts.iso,
              charId: item.charId, userId: item.userId
            };
          });
          return embedTexts(blks.map(function (b) { return b.text; })).then(function (res) {
            if (!res.ok) return { ok: false, why: 'embed', error: res.error };
            var sid = scopeNow();
            var recs = blks.map(function (b, i) {
              return {
                id: newId(), ownerKey: key, kind: opts.kind || 'chat',
                charId: (b.charId !== undefined ? b.charId : opts.charId) || null,
                userId: (b.userId !== undefined ? b.userId : opts.userId) || null,
                groupId: opts.groupId || null,
                sourceId: opts.sourceId || null, sandboxId: sid,
                at: b.at, at0: b.at0 || b.at || 0,
                model: modelNow(), dim: (res.vectors[i] || []).length,
                fromId: b.fromId, toId: b.toId, msgCount: b.msgCount, msgIds: b.msgIds,
                iso: b.iso || 'both', itemId: b.itemId, seg: b.seg, segCount: b.segCount,
                text: b.text, vec: res.vectors[i]
              };
            });
            return Promise.all(recs.map(putBlock)).then(function () {
              return trim(key).then(function () {
                return { ok: true, added: recs.length };
              });
            });
          });
        });
    })['catch'](function (e) {
      return { ok: false, why: 'error', error: (e && e.message) || String(e) };
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
  /* 缓存要记住「这份结果属于谁、哪个世界」。
     主动消息是**滞后一轮**读缓存的（它没有「当前输入」，见 page-proactive），
     中间可能切了角色、换了马甲、或者切了岛 —— 拿错世界的记忆比不拿更糟
     （TA 会提起另一个岛上另一个身份的事）。 */
  var RECALL_TTL = 6 * 3600 * 1000;

  function bindOf(opts) {
    opts = opts || {};
    return {
      charId: opts.charId || null,
      userId: opts.userId || null,
      sandboxId: scopeNow()
    };
  }
  function bindOk(rec, want) {
    if (!rec || !rec.bind) return false;     /* 没有绑定信息（老缓存）→ 当无效 */
    want = want || {};
    if ((rec.bind.sandboxId || null) !== (want.sandboxId || null)) return false;
    if (want.charId && rec.bind.charId !== want.charId) return false;
    if (want.userId && rec.bind.userId !== want.userId) return false;
    return true;
  }
  function freshEnough(rec) {
    return !!rec && (Date.now() - (rec.at || 0)) < RECALL_TTL;
  }
  /* 浅拷一份再补绑定字段 —— 不改调用方传进来的对象 */
  function withBind(opts, charId, userId) {
    var o = {};
    if (opts) for (var k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
    o.charId = charId || null;
    o.userId = userId || null;
    return o;
  }

  function prefetchInto(key, loadBlocks, query, opts) {
    opts = opts || {};
    /* 「清空全部数据 / 导入备份」正在跑：这期间**一块都不召回**。
       窗口从清库那一刻到页面 reload 为止（见 pauseRecall 的注释）。 */
    if (recallPaused()) {
      lastRecall[key] = { items: [], at: Date.now(), bind: bindOf(opts) };
      return Promise.resolve([]);
    }
    if (!enabled() || !key) {
      lastRecall[key] = { items: [], at: Date.now(), bind: bindOf(opts) };
      return Promise.resolve([]);
    }
    var q = String(query || '').trim();
    if (!q) {
      lastRecall[key] = { items: [], at: Date.now(), bind: bindOf(opts) };
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
      lastRecall[key] = { items: items || [], at: Date.now(), bind: bindOf(opts) };
      return items || [];
    });
  }

  /* 私聊（线上 / 线下共用同一条召回线 —— ownerKey 都是 rootId） */
  function prefetch(charId, userId, query, opts) {
    if (!charId) return Promise.resolve([]);
    return prefetchInto(rootOf(charId), function () {
      /* 快照**跟着这次召回建一次**（施工卡 §8.7）：权限随时会变，
         跨轮缓存它会看不见改动。 */
      var snap = buildSnapshot(charId, userId || null);
      return blocksOf(charId, userId || null, snap);
    }, query, withBind(opts, charId, userId));
  }

  /* 群聊：主键换成 group:<id>，**不过身份隔离**（群消息对成员是公开的）。 */
  function prefetchGroup(groupId, query, opts) {
    if (!groupId) return Promise.resolve([]);
    /* 群不校验 charId（群消息对成员共享），但要校验世界 ——
       换岛之后不该拿上一个岛的群结果。 */
    return prefetchInto(groupKey(groupId), function () {
      return blocksOfGroup(groupId);
    }, query, withBind(opts, null, null));
  }

  function lastOf(charId, userId) {
    if (recallPaused()) return [];
    var r = lastRecall[rootOf(charId)];
    if (!r || !r.items || !r.items.length) return [];
    if (!freshEnough(r)) return [];
    /* 校验绑定：世界 / 角色 / 身份有一个对不上就当没有 ——
       「宁可这轮想不起来，也不能想起来的是别人的事」。 */
    if (!bindOk(r, { charId: charId, userId: userId || null, sandboxId: scopeNow() })) return [];
    return r.items;
  }

  function renderRecall(items, headLines) {
    return '[相关的过去]\n' + headLines.join('\n') + '\n' +
      items.map(function (it) {
        return '· ' + String(it.text || '').replace(/\n+/g, ' / ').slice(0, 220);
      }).join('\n');
  }

  /* 注入文本。**不写「你记得」这种口径** —— 召回命中的是原文块，
     它是「你们确实聊过这个」，不是「系统让 TA 想起」。 */
  function text(charId, userId) {
    var items = lastOf(charId, userId);
    if (!items.length) return '';
    /* 措辞是**故意的**：这几条目击是「可能的旧证据」，不是「仍然有效的事实」。
       过去说过「最近不想喝咖啡」，召回后不能被读成「用户永远不喝咖啡」——
       那是把召回当规则用。和规划里那条红线一致：向量只找证据，不定规则。 */
    return renderRecall(items, [
      '下面几条是你们以前真的聊过的片段（按和这件事的相关度挑的，时间顺序不一定连贯）。',
      '它们只是过去的原话，不代表现在仍然如此 —— 和现在的情况对不上时，以现在为准。',
      '需要的时候可以自然接上；对不上现在的语境就别硬提。'
    ]);
  }

  /* 群聊那份。装配时群里是**共享 system**，所以一份就够 ——
     但口径要写成「群里的人都经历过」，不能写成「你和某个人聊过」：
     群里说话的是账号，不是一对一的那个身份。 */
  function groupText(groupId) {
    var r = lastRecall[groupKey(groupId)];
    var items = (r && r.items && freshEnough(r) &&
      bindOk(r, { sandboxId: scopeNow() })) ? r.items : [];
    if (!items.length) return '';
    return renderRecall(items, [
      '下面几条是这个群里以前真的出现过的对话（按和这件事的相关度挑的）。',
      '它们只是过去的原话，不代表现在仍然如此 —— 和现在的情况对不上时，以现在为准。',
      '群里的人都经历过这些，可以自然接上；对不上现在的语境就别硬提。'
    ]);
  }
  function clearCache() { lastRecall = {}; }

  Sleepy.memoryVec = {
    enabled: enabled,
    available: available,
    /* 写入：对话三源 + 素材四源，内核都是同一份 sweepSource（见那边的注释） */
    sweep: sweep,                 /* 线上私聊 */
    /* 手动把本岛聊天补进索引（设置页「现在扫一遍」按钮用）——
       清退避 + 多轮切块 + 逐条报结果，见函数注释 */
    sweepIsland: sweepIsland,
    sweepOffline: sweepOffline,   /* 线下私聊 */
    sweepGroup: sweepGroup,       /* 群聊（线上 + 群线下共用，消息都在 groupMessages） */
    /* 素材四源（2026-09-23 向量补源）—— 一条一块、超长分片 */
    sweepMoments: sweepMoments,   /* 朋友圈（岛级公共池） */
    sweepDiary: sweepDiary,       /* 日记（我写的挂账号、他写的挂角色） */
    sweepMem: sweepMem,           /* 记忆档案（角色私有，只接 active） */
    sweepPhone: sweepPhone,       /* 查手机三类：备忘 / 计划 / 订单 */
    /* 定向重建：改了一条**旧**条目时用它（删旧块 + 单条重切，§8.1） */
    reindexItem: reindexItem,
    /* 素材「改一条」的语义化入口 —— 调用方只喊一声，不用自己组装文本 */
    refreshMoment: refreshMoment,
    refreshDiary: refreshDiary,
    refreshMem: refreshMem,
    refreshPhone: refreshPhone,
    /* 召回：私聊一条线、群聊一条线 */
    prefetch: prefetch,
    prefetchGroup: prefetchGroup,
    lastOf: lastOf,
    text: text,
    groupText: groupText,
    stats: function (charId) {
      return allOfRoot(charId).then(function (l) {
        var pools = { chat: [], memo: [] };
        l.forEach(function (b) { pools[poolOf(b.kind)].push(b); });
        return {
          blocks: l.length, max: maxBlocks(),               /* 向后兼容 */
          chat: pools.chat.length, chatMax: poolMax('chat'),
          memo: pools.memo.length, memoMax: poolMax('memo')
        };
      });
    },
    statsGroup: function (groupId) {
      return allOfGroup(groupId).then(function (l) {
        return { blocks: l.length, max: maxBlocks() };
      });
    },
    clear: clearAll,
    total: total,
    /* 整库清理（清空全部数据 / 导入备份前用）—— 三态返回，见 wipeAll 的注释 */
    wipeAll: wipeAll,
    /* 召回暂停门：清空 / 导入期间关掉召回（计数式，成对调用） */
    pauseRecall: pauseRecall,
    resumeRecall: resumeRecall,
    recallPaused: recallPaused,
    /* 清全库退避记录（vecFail:*）—— 清块之后不退避，否则接口好了也还要等 */
    clearFailures: clearFailures,
    /* 向量库快照（导入失败回滚用）：主库怎么清都不影响这个独立库 */
    snapBlocks: snapBlocks,       /* 旧块 → 快照库（覆盖式，含数量复核） */
    snapRestore: snapRestore,     /* 快照库 → 主库（覆盖式，含数量复核） */
    snapDrop: snapDrop,           /* 丢掉快照 */
    snapCount: snapCount,
    /* 索引状态（游标 / 退避 / 世代号）—— 回滚时和块一起恢复才配套 */
    indexState: indexState,
    restoreIndexState: restoreIndexState,
    /* 清空全部数据时用的零件（清空页逐项报告，所以不打包成一个入口） */
    clearCursors: clearCursors,
    /* 原文变了 → 索引失效（删除 / 编辑 / 撤回 / 删对话，见 forget 的注释） */
    forget: forget,
    /* 设置页：看清索引里有什么、能清、能自己试一次召回 */
    overview: overview,
    probe: probe,
    /* 换 embedding 模型之后：老块不参与召回了，可以一键清掉 */
    stale: staleCount,
    forgetStale: forgetStale,
    resetCursors: resetCursors,
    clearCache: clearCache,
    cursorKey: cursorKey,
    /* 纯函数出口 —— 冒烟直接打表，不用起 IDB */
    _pure: {
      nextBlock: nextBlock,
      blockerOne: blockerOne,
      cosine: cosine,
      rank: rank,
      dropOverlapping: dropOverlapping,
      blockHitBy: blockHitBy,
      buildQuery: buildQuery,
      visibleTo: visibleTo,
      stillVisible: stillVisible,
      buildSnapshot: buildSnapshot,
      segText: segText,
      momentText: momentText,
      phoneTextOf: phoneTextOf,
      poolOf: poolOf,
      ownerKeyFor: ownerKeyFor,
      msgLine: msgLine,
      groupKey: groupKey,
      rootOf: rootOf,
      islandKey: islandKey,
      userKey: userKey,
      sameModel: sameModel,
      bindOk: bindOk,
      readCursor: readCursor,
      writeCursor: writeCursor
    },
    MIN_MSGS: MIN_MSGS, MAX_MSGS: MAX_MSGS,
    MIN_CHARS: MIN_CHARS, MAX_CHARS: MAX_CHARS,
    INJECT_MAX: INJECT_MAX,
    PREFETCH_TIMEOUT: PREFETCH_TIMEOUT
  };

})(window);
