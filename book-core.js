/* ============================================================
   book-core.js — 「以身入局」数据层（P0 第一刀）

   职责：档案盒 / 任务运行 / 岛级设置的读写，全部按岛章隔离。
   镜像 forum-core.js 的 scoping 口径：
   · 读 scoped(key, sid) —— 只返回该岛的记录；
   · 写 tagScope 盖章 + 对全量数组改完整体 set 回去；
   · 映射键 getMap/setMap（键名 bookSettingsBySandbox，值按 sbId 切）。

   红线（方案 §8.3）：以身入局的记忆只存本文件的键——
   不写进 char 的角色记忆、不进 memory-vec、不进聊天上下文。

   档案盒 status：empty（未开工）/ ongoing（进行中）/ closed（已结案）/ sealed（封存）。
   身份 identity：boss-watch（老板·纯看）/ boss-join（老板·亲自参与）/ staff（员工）。
   进局即锁死（§8.1），所以 identity 存在任务运行上，大厅选的是「下一局身份」。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;
  var store = Sleepy.store;

  var BOOK_KEYS = ['bookBoxes', 'bookRuns'];
  var BOOK_MAP_KEYS = ['bookSettingsBySandbox'];

  var lockedSandboxId = null;
  function lockSandbox(sid) { lockedSandboxId = sid || null; }

  function scoped(key, sandboxId) {
    if (BOOK_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的键 ' + key);
    var all = store.get(key) || [];
    var sid = sandboxId || lockedSandboxId;
    if (!sid) return all;
    return all.filter(function (r) { return r && r.sandboxId === sid; });
  }

  function put(key, allRecords) {
    if (BOOK_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的键 ' + key);
    store.set(key, allRecords);
  }

  function tagScope(rec, sandboxId) {
    return core.tagScope(rec, sandboxId || lockedSandboxId || undefined);
  }

  function getMap(key, sandboxId) {
    if (BOOK_MAP_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的映射键 ' + key);
    var map = store.get(key) || {};
    var sid = sandboxId || lockedSandboxId;
    return sid ? (map[sid] || null) : null;
  }

  function setMap(key, sandboxId, value) {
    if (BOOK_MAP_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的映射键 ' + key);
    if (!sandboxId) throw new Error('book: setMap 必须带 sandboxId');
    var map = store.get(key) || {};
    map[sandboxId] = JSON.parse(JSON.stringify(value));
    store.set(key, map);
  }

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 档案盒 ---------- */

  /* P0 口径（方案 §7.2）：正式架不放内容——留一个「待上架」占位盒；
     另给一个「局内演练」盒（演练戳、可进、可删）专供联调与验收。 */
  var DRILL_BOX_ID = 'book-box-drill';

  function ensureBoxes(sandboxId) {
    if (!sandboxId) throw new Error('book: ensureBoxes 必须带 sandboxId');
    var all = store.get('bookBoxes') || [];
    var mine = all.filter(function (r) { return r && r.sandboxId === sandboxId; });
    var dirty = false;
    var now = new Date().toISOString();

    function addBox(rec) {
      var exists = mine.some(function (b) { return b.stamp === rec.stamp && b.title === rec.title; });
      if (exists) return;
      all.push(tagScope(rec, sandboxId));
      mine.push(rec);
      dirty = true;
    }

    addBox({
      id: uid('book-box'),
      title: '待上架的世界',
      source: 'builtin', status: 'empty', stamp: '待上架', enterable: false,
      note: '世界包定稿后上架。', coverRef: null,
      createdAt: now, updatedAt: now
    });
    addBox({
      id: DRILL_BOX_ID,
      title: '局内演练',
      source: 'drill', status: 'empty', stamp: '演练', enterable: true,
      note: '专供联调与验收，随时可撤架。', coverRef: null,
      createdAt: now, updatedAt: now
    });

    if (dirty) store.set('bookBoxes', all);
    return scoped('bookBoxes', sandboxId);
  }

  function getBox(boxId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return scoped('bookBoxes', sid).filter(function (b) { return b.id === boxId; })[0] || null;
  }

  /* ---------- 运行（任务） ---------- */

  /* 身份口径（用户 2026-10-09 晚）：**每个世界定一次身份就锁死**——
     建档时把 identity 刻进档案盒，之后这个世界的所有运行都用它；
     大厅的「下一局身份」只是默认值，别的世界建档时仍可换。 */
  function startRun(boxId, identity, seat) {
    if (!lockedSandboxId) throw new Error('book: startRun 必须先 lockSandbox');
    var all = store.get('bookBoxes') || [];
    var box = null;
    all.forEach(function (b) {
      if (b && b.sandboxId === lockedSandboxId && b.id === boxId) box = b;
    });
    if (!box) throw new Error('book: 找不到档案盒 ' + boxId);
    if (!box.enterable) throw new Error('book: 不可进入的盒子');
    var hit = IDENTITIES.filter(function (x) { return x.key === identity; })[0];
    if (!hit) throw new Error('book: 未知身份 ' + identity);
    if (box.identity && box.identity !== identity) {
      throw new Error('book: 这个世界已定过身份（' + box.identity + '），不可再改');
    }
    if (box.status === 'ongoing') {
      var running = scoped('bookRuns', lockedSandboxId)
        .filter(function (r) { return r.boxId === boxId && r.status === 'ongoing'; })[0];
      if (running) return { run: running, existed: true };
    }

    var now = new Date().toISOString();
    box.identity = identity;          /* 刻死 */
    box.status = 'ongoing';
    box.updatedAt = now;
    store.set('bookBoxes', all);

    var runs = store.get('bookRuns') || [];
    var run = tagScope({
      id: uid('book-run'),
      boxId: boxId,
      identity: identity,             /* b 层：员工/老板（锁死） */
      seat: seat || null,             /* c 层：穿书占位身份 */
      status: 'ongoing',
      logs: [],                       /* 行动日志（第三刀接） */
      volume: { chapters: [], notes: [] },  /* 卷宗（分栏，§9.3） */
      startedAt: now, endedAt: null
    }, lockedSandboxId);
    runs.push(run);
    store.set('bookRuns', runs);
    return { run: run, existed: false };
  }

  function getRunByBox(boxId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    var runs = scoped('bookRuns', sid)
      .filter(function (r) { return r.boxId === boxId && r.status === 'ongoing'; });
    return runs.length ? runs[runs.length - 1] : null;
  }

  /* 场景图（封面）：建档时贴，随时可换/可撕。mediaId 走 photos.pick 通道。 */
  function setCover(boxId, mediaId, sandboxId) {
    if (!lockedSandboxId && !sandboxId) throw new Error('book: setCover 必须带 sandboxId 或先 lockSandbox');
    var sid = sandboxId || lockedSandboxId;
    var all = store.get('bookBoxes') || [];
    var hit = false;
    all.forEach(function (b) {
      if (b && b.sandboxId === sid && b.id === boxId) {
        b.coverRef = mediaId || null;
        b.updatedAt = new Date().toISOString();
        hit = true;
      }
    });
    if (!hit) throw new Error('book: 找不到档案盒 ' + boxId);
    store.set('bookBoxes', all);
    return getBox(boxId, sid);
  }

  /* ---------- 身份（下一局身份；进局建档时抄到运行记录上锁死） ---------- */

  var IDENTITIES = [
    { key: 'boss-watch', name: '老板 · 纯看', desc: '派 char 进世界执行委托，你在局外看 TA 的对白与心理，用局印干预。' },
    { key: 'boss-join', name: '老板 · 亲自参与', desc: '局印特权在手，亲自入局陪同 char 完成委托。' },
    { key: 'staff', name: '员工', desc: '你自己入局执行任务，char 按局内关系同行或留守。局印认老板，不认你。' }
  ];

  function getIdentity(sandboxId) {
    var s = getMap('bookSettingsBySandbox', sandboxId) || {};
    return s.identity || null;
  }

  function setIdentity(sandboxId, key) {
    var hit = IDENTITIES.filter(function (x) { return x.key === key; })[0];
    if (!hit) throw new Error('book: 未知身份 ' + key);
    var s = getMap('bookSettingsBySandbox', sandboxId) || {};
    s.identity = key;
    setMap('bookSettingsBySandbox', sandboxId, s);
  }

  /* ---------- 对外 ---------- */

  Sleepy.book = {
    lockSandbox: lockSandbox,
    scoped: scoped,
    put: put,
    tagScope: tagScope,
    getMap: getMap,
    setMap: setMap,
    uid: uid,
    ensureBoxes: ensureBoxes,
    getBox: getBox,
    startRun: startRun,
    getRunByBox: getRunByBox,
    setCover: setCover,
    DRILL_BOX_ID: DRILL_BOX_ID,
    IDENTITIES: IDENTITIES,
    getIdentity: getIdentity,
    setIdentity: setIdentity
  };
})(window);
