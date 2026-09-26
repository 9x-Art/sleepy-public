/* ============================================================
   scripts/idb-upgrade-test.js — 项目 5 的 IDB 测试（**桩环境行为测试**）
   ------------------------------------------------------------
   ⚠️ 环境层级：本文件是「桩自动化」层 —— IndexedDB 用本文件内手写的
   内存桩，事件契约对齐真 IDB，但**不能替代原生 IndexedDB**。
   原生浏览器验收见 scripts/browser-idb-test.js（playwright + 生产开库路径）。

   为什么单独一个文件：smoke 的桩没有 IndexedDB，而项目 5 的升级信号
   （onupgradeneeded / event.oldVersion）、块写入、forget 过滤必须在
   **真实开库路径**上验，不能只用字符串护栏。

   测试环境（如实注明）：
     · Node 运行；IndexedDB 用本文件内手写的**内存桩**，
       事件契约对齐真 IDB（oldVersion 在 IDBVersionChangeEvent 上，
       request 上没有 —— 恰好用来抓 req.oldVersion 这类写法）；
     · 隔离测试库 = 桩内存里的 'sleepy-vec'，每个场景独立一套桩与
       localStorage 桩 —— **不读不写任何真实设备/浏览器存档**；
     · 被测对象是 production 源码（memory-vec.js / page-memory.js 原文 vm 加载）。
   跑法：node scripts/idb-upgrade-test.js（smoke 会自动拉起它）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

/* ---------------------------- 极简 IDB 内存桩 ----------------------------
   只实现 memory-vec 用到的面：open（含版本升级语义）、
   objectStore 增删建、transaction 的 put/get/delete/clear/count、
   openCursor（含 index 游标）。事件时序用微任务串行。 */
function makeIDB() {
  const dbs = new Map();
  function fire(fn, arg) { if (typeof fn === 'function') queueMicrotask(() => fn(arg)); }
  function makeStore() { return { keyPath: 'id', indexes: new Map(), records: new Map() }; }
  function makeDBHandle(db) {
    return {
      get version() { return db.version; },
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore(n, opts) {
        const st = makeStore();
        if (opts && opts.keyPath) st.keyPath = opts.keyPath;
        db.stores.set(n, st);
        return { createIndex(iname, kp) { st.indexes.set(iname, kp); } };
      },
      deleteObjectStore(n) { db.stores.delete(n); },
      transaction(n /*, mode */) {
        const st = db.stores.get(n);
        if (!st) throw new Error('桩：没有这个 store ' + n);
        const t = { oncomplete: null, onerror: null, onabort: null, _pending: 0 };
        function settle() {
          queueMicrotask(() => { if (t._pending <= 0 && typeof t.oncomplete === 'function') t.oncomplete({ target: t }); });
        }
        function makeReq(impl) {
          const req = { onsuccess: null, onerror: null, result: undefined, error: null };
          t._pending++;
          queueMicrotask(() => {
            try { req.result = impl(); } catch (e) { req.error = e; }
            t._pending--;
            fire(req.onsuccess, { target: req });
            settle();
          });
          return req;
        }
        function makeCursorReq(arr) {
          const req = { onsuccess: null, onerror: null, result: null };
          let pos = 0;
          let done = false;
          function step() {
            if (pos < arr.length) {
              req.result = { value: arr[pos], key: arr[pos].id, continue() { pos++; queueMicrotask(step); } };
            } else { req.result = null; done = true; }
            fire(req.onsuccess, { target: req });
            if (done) { t._pending--; settle(); }   /* 游标耗尽 = 这笔事务完成 */
          }
          t._pending++;
          queueMicrotask(step);
          return req;
        }
        function makeOS() {
          return {
            put(rec) { return makeReq(() => { st.records.set(rec[st.keyPath], JSON.parse(JSON.stringify(rec))); return rec[st.keyPath]; }); },
            get(key) { return makeReq(() => st.records.get(key)); },
            delete(key) { return makeReq(() => { st.records.delete(key); }); },
            clear() { return makeReq(() => { st.records.clear(); }); },
            count() { return makeReq(() => st.records.size); },
            openCursor() { return makeCursorReq([...st.records.values()]); },
            index(name) {
              const kp = st.indexes.get(name);
              if (!kp) throw new Error('桩：没有这个 index ' + name);
              return {
                openCursor(range) {
                  const want = range ? range.value : undefined;
                  return makeCursorReq([...st.records.values()].filter((r) => want === undefined || r[kp] === want));
                }
              };
            }
          };
        }
        t.objectStore = () => makeOS();
        return t;
      }
    };
  }
  return {
    /* 测试直接布置/检查桩库内容用（不走 IDB 接口的直通口） */
    _seed(name, version, storeName, records) {
      const db = { name, version, stores: new Map() };
      const st = makeStore();
      /* 生产建库会建 ownerKey / at 两个索引（见 memory-vec open），桩库里照做 */
      st.indexes.set('ownerKey', 'ownerKey');
      st.indexes.set('at', 'at');
      records.forEach((r) => st.records.set(r.id, JSON.parse(JSON.stringify(r))));
      db.stores.set(storeName, st);
      dbs.set(name, db);
    },
    _records(name, storeName) {
      const db = dbs.get(name);
      if (!db || !db.stores.has(storeName)) return null;
      return [...db.stores.get(storeName).records.values()];
    },
    _version(name) { const db = dbs.get(name); return db ? db.version : null; },
    open(name, version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null, error: null };
      queueMicrotask(() => {
        let db = dbs.get(name);
        if (db && version < db.version) {
          req.error = { name: 'VersionError', message: '提供的版本号比现有库小' };
          fire(req.onerror, { target: req });
          return;
        }
        const oldVersion = db ? db.version : 0;
        if (!db) { db = { name, version: 0, stores: new Map() }; dbs.set(name, db); }
        if (version > db.version) {
          req.result = makeDBHandle(db);
          /* 对齐真 IDB：oldVersion 在**事件**上，request 上没有 */
          fire(req.onupgradeneeded, { oldVersion, newVersion: version, target: req });
          queueMicrotask(() => { db.version = version; fire(req.onsuccess, { target: req }); });
        } else {
          req.result = makeDBHandle(db);
          fire(req.onsuccess, { target: req });
        }
      });
      return req;
    }
  };
}

/* ---------------------------- 被测环境装载 ----------------------------
   每个场景一套全新桩（IDB + localStorage + store），production 源码原文跑。 */
function makeEnv(opts) {
  opts = opts || {};
  const idb = opts.idb || makeIDB();
  const win = {};
  win.localStorage = {
    _d: {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
    key(i) { return Object.keys(this._d)[i] || null; },
    get length() { return Object.keys(this._d).length; }
  };
  win.IDBKeyRange = { only: (v) => ({ value: v }) };
  win.indexedDB = idb;
  const Sleepy = win.Sleepy = {};
  /* store 桩必须**镜像**到 localStorage：生产 store 是 localStorage 背书的，
     而迁移扫源 / hasOldVecData 走的是裸 localStorage —— 不镜像会扫不到源键 */
  const lsBacking = win.localStorage;
  Sleepy.store = {
    NS: 'sleepy.v1.', _d: {},
    get(k) { const v = this._d[k]; return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    set(k, v) { this._d[k] = JSON.parse(JSON.stringify(v)); lsBacking.setItem(this.NS + k, JSON.stringify(v)); return v; },
    remove(k) { delete this._d[k]; lsBacking.removeItem(this.NS + k); }
  };
  if (opts.core) Sleepy.core = opts.core;
  if (opts.singleApi !== null) Sleepy.singleApi = { cfgOf: () => ({ baseUrl: 'http://stub', model: 'emb-test' }) };
  if (opts.api) Sleepy.api = opts.api;
  if (opts.document) win.document = opts.document;
  if (opts.ui) Sleepy.ui = opts.ui;
  Sleepy.register = () => {};
  const ctx = vm.createContext(Object.assign({}, win, {
    window: win, global: win, console, setTimeout, setInterval, clearInterval,
    Date, JSON, Math, Promise, Error, Object, Array, String, Number, Boolean,
    parseInt, parseFloat, isNaN, queueMicrotask, RegExp
  }));
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8'), ctx, { filename: 'memory-vec.js' });
  if (opts.loadPageMemory) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'page-memory.js'), 'utf8'), ctx, { filename: 'page-memory.js' });
  }
  return { win, Sleepy, idb, ctx };
}

/* ---------------------------- 断言小件 ---------------------------- */
const results = [];
function chk(name, cond) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('  ✗ ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms) => {
  const end = Date.now() + (ms || 1500);
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return !!fn();
};

/* ============================ 场景 ============================ */

/* A｜升级权威信号：v5 旧库 + 无 localStorage 痕迹 → 升 v6 清库 + 挂重建提示 */
async function caseUpgrade() {
  const idb = makeIDB();
  idb._seed('sleepy-vec', 5, 'vec', [
    { id: 'old1', ownerKey: 'r1', text: '旧块一', vec: [0.1], model: 'old-model' },
    { id: 'old2', ownerKey: 'r1', text: '旧块二', vec: [0.1], model: 'old-model' }
  ]);
  const { Sleepy } = makeEnv({ idb });   /* localStorage 故意留空 —— 漏判场景 */
  await Sleepy.memoryVec.available();
  chk('A1 升级后的库版本不是 6', idb._version('sleepy-vec') === 6);
  const recs = idb._records('sleepy-vec', 'vec');
  chk('A2 旧向量没按设计清空', recs && recs.length === 0);
  const st = Sleepy.memoryVec.rebuildState();
  chk('A3 重建提示没挂上（event.oldVersion 权威信号失效）',
    !!st && st.state === 'needed' && st.via === 'idb' && st.fromVer === 5);
  const total = await Sleepy.memoryVec.total();
  chk('A4 生产 total() 不是 0', total === 0);
  chk('A5 available 不是 true', await Sleepy.memoryVec.available() === true);
}

/* B｜全新建库：oldVersion=0 不得误报旧库重建 */
async function caseFresh() {
  const idb = makeIDB();
  const { Sleepy } = makeEnv({ idb });
  await Sleepy.memoryVec.available();
  chk('B1 全新建库版本不是 6', idb._version('sleepy-vec') === 6);
  chk('B2 全新建库误报了旧库重建', Sleepy.memoryVec.rebuildState() === null);
}

/* C｜重建断点续扫：一部分成功后注入失败 → 重试不重算、剩余补完、提示清除 */
async function caseResume() {
  const idb = makeIDB();
  let allowB = false;
  const embedCount = {};
  const api = {
    embed: (cfg, texts) => {
      /* 失败的调用**不计入**成功计数（否则断言分不清「失败」和「算过」） */
      if (!allowB && texts.some((t) => t.indexOf('B话') >= 0)) {
        return Promise.resolve({ ok: false, error: '模拟注入失败' });
      }
      texts.forEach((t) => { embedCount[t] = (embedCount[t] || 0) + 1; });
      return Promise.resolve({ ok: true, vecs: texts.map(() => [0.1, 0.2]), dim: 2, ms: 1 });
    }
  };
  const mkChat = (id, tag) => ({
    id, characterId: 'c1', userId: 'u1', name: tag,
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: tag + '_' + i, role: i % 2 ? 'user' : 'char',
      content: tag + '话' + i, timestamp: 1000 + i
    }))
  });
  const core = {
    rootIdOf: (id) => id, scopeId: () => 'sb1', scoped: (x) => x,
    charsOfSandbox: () => [{ id: 'c1' }], npcsOfRoom: () => []
  };
  const { Sleepy } = makeEnv({ idb, api, core });
  Sleepy.store.set('chats', [mkChat('chatA', 'A'), mkChat('chatB', 'B')]);
  Sleepy.store.set('vecRebuild', { state: 'needed', at: Date.now() - 1000 });

  const r1 = await Sleepy.memoryVec.rebuildIndex();
  chk('C1 第一轮没有按预期失败（注入失败没被如实上报）', r1.ok === false);
  const st1 = Sleepy.memoryVec.rebuildState();
  chk('C1b 失败状态没保留', !!st1 && st1.state === 'failed');
  const afterRun1 = (idb._records('sleepy-vec', 'vec') || []).length;
  chk('C2 第一轮没写出任何块（A 场的块也没进库）', afterRun1 > 0);
  const aTexts = Array.from({ length: 20 }, (_, i) => 'A话' + i).map((t) => 'A：' + t === t ? t : t);
  /* 行文本由 msgLine 拼（'我：'/'对方：'前缀），按包含关系数 */
  const countFor = (tag) => Object.keys(embedCount).filter((t) => t.indexOf(tag + '话') >= 0)
    .reduce((s, t) => s + embedCount[t], 0);
  chk('C3 第一轮 A 场文本没有嵌入（块没写成）', countFor('A') > 0);
  chk('C4 第一轮 B 场文本被嵌入了（应被失败挡住）', countFor('B') === 0);
  const aCountsRun1 = countFor('A');                   /* A 场已成功的嵌入数快照 */

  allowB = true;                                    /* 用户修好了接口 → 重试 */
  const r2 = await Sleepy.memoryVec.rebuildIndex();
  chk('C5 重试没走完：' + JSON.stringify(r2.failed || []), r2.ok === true);
  chk('C6 重试成功后提示没清掉', Sleepy.memoryVec.rebuildState() === null);
  const finalRecs = (idb._records('sleepy-vec', 'vec') || []).length;
  chk('C7 最终块数不对（A 两块 + B 两块）', finalRecs === afterRun1 + 2);
  chk('C8 已完成的 A 场块被重复计算了（重试重扫了断点之前的内容）',
    countFor('A') === aCountsRun1);
  chk('C9 剩余的 B 场块没补完', countFor('B') > 0);
}

/* D｜DOMContentLoaded 链：core 未就绪 → 事件触发 → 同一启动周期迁移完成 */
async function caseBootChain() {
  const listeners = {};
  const doc = { readyState: 'loading', listeners, addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); } };
  const { Sleepy } = makeEnv({ loadPageMemory: true, document: doc, ui: { h: () => ({}) } });
  chk('D1 page-memory 加载时就把迁移做完了（core 未就绪却没跳过）', !Sleepy.store.get('charMemMigrated'));
  Sleepy.core = { rootIdOf: (id) => (id === 'f28' ? 'm28' : id), scopeId: () => null };
  Sleepy.store.set('charMem:f28', { version: '1', charId: 'f28', understandings: [], memories: [{ id: 'd1', content: '待迁', status: 'active' }] });
  /* 按**真实事件链**触发：派发 DOMContentLoaded，不手动喊 bootMigrate */
  (listeners['DOMContentLoaded'] || []).forEach((fn) => { try { fn({}); } catch (e) { /* 与浏览器同义：监听器异常不拦其余 */ } });
  chk('D2 DOMContentLoaded 触发后迁移没完成（链断了）',
    Sleepy.store.get('charMem:f28') == null && !!Sleepy.store.get('charMemMigrated') &&
    (Sleepy.store.get('charMem:m28') || { memories: [] }).memories.length === 1);
}

/* E｜DOMContentLoaded 已错过（readyState 非 loading）→ 有界重试兜底 */
async function caseBootFallback() {
  const doc = { readyState: 'complete', addEventListener() {} };
  const { Sleepy } = makeEnv({ loadPageMemory: true, document: doc, ui: { h: () => ({}) } });
  Sleepy.core = undefined;
  await sleep(30);
  /* 事件已经错过 → 走有界重试；core 迟 200ms 才就绪 */
  Sleepy.core = { rootIdOf: (id) => (id === 'f29' ? 'm29' : id), scopeId: () => null };
  Sleepy.store.set('charMem:f29', { version: '1', charId: 'f29', understandings: [], memories: [{ id: 'e1', content: '待迁', status: 'active' }] });
  const done = await waitUntil(() => !!Sleepy.store.get('charMemMigrated'), 1200);
  chk('E1 readyState 已错过时兜底重试没把迁移跑完', done);
  chk('E2 兜底迁移没归并（源键没删）', Sleepy.store.get('charMem:f29') == null);
}

/* F｜三维删除走**生产 forget 路径**（隔离桩库） */
async function caseForget3D() {
  const idb = makeIDB();
  const blk = (id, from, sb, owner) => ({
    id, ownerKey: owner || 'r1', charId: 'r1', fromCharId: from, sandboxId: sb,
    kind: 'chat', msgIds: [id], text: 'x', vec: [0.1], model: 'emb-test'
  });
  idb._seed('sleepy-vec', 6, 'vec', [
    blk('b1', 'fA', 'sb1'),          /* A 脸 + 岛1 → 该删 */
    blk('b2', 'fB', 'sb1'),          /* B 脸 + 岛1 → 必须留 */
    blk('b3', 'fA', 'sb2'),          /* A 脸 + 岛2 → 必须留 */
    blk('b4', 'fA', 'sb1', 'island:sb1') /* 岛池（不同 ownerKey）→ 不归这次删 */
  ]);
  const core = { rootIdOf: (id) => id, scopeId: () => null, scoped: (x) => x };
  const { Sleepy } = makeEnv({ idb, core });
  const names = () => (idb._records('sleepy-vec', 'vec') || []).map((r) => r.id).sort();
  const n0 = names();
  chk('F0 布库不对', JSON.stringify(n0) === JSON.stringify(['b1', 'b2', 'b3', 'b4']));
  const n1 = await Sleepy.memoryVec.forget({ charId: 'r1', fromCharId: 'fA', sandboxId: 'sb1' });
  chk('F1 删 A+岛1 应命中 1 块', n1 === 1);
  chk('F2 B 脸 / 岛2 / 岛池的块没留住：' + JSON.stringify(names()),
    JSON.stringify(names()) === JSON.stringify(['b2', 'b3', 'b4']));
  const n2 = await Sleepy.memoryVec.forget({ charId: 'r1', fromCharId: 'fA', sandboxId: 'sb2' });
  chk('F3 删 A+岛2 应命中 1 块', n2 === 1);
  /* 最后剩：B 脸的块（root 池）+ 岛池的块（ownerKey 不同，本来就不归 charId 维度删） */
  chk('F4 最终存量不对：' + JSON.stringify(names()),
    JSON.stringify(names()) === JSON.stringify(['b2', 'b4']));
}

/* G｜「清掉索引」的恢复路径：wipeAll 清掉块 → 挂重建提示；
   点击前基线挡住旧内容（不静默重扫）；点击后从头顶恢复历史索引 */
async function caseWipeRecover() {
  const idb = makeIDB();
  let allow = true;
  const embedCount = {};
  const api = {
    embed: (cfg, texts) => {
      texts.forEach((t) => { embedCount[t] = (embedCount[t] || 0) + 1; });
      return Promise.resolve({ ok: true, vecs: texts.map(() => [0.1, 0.2]), dim: 2, ms: 1 });
    }
  };
  const core = {
    rootIdOf: (id) => id, scopeId: () => 'sb1', scoped: (x) => x,
    charsOfSandbox: () => [{ id: 'c1' }], npcsOfRoom: () => []
  };
  /* 先布一个 v6 库并塞两块（模拟「索引里已有历史」） */
  idb._seed('sleepy-vec', 6, 'vec', [
    { id: 'keep1', ownerKey: 'c1', charId: 'c1', fromCharId: null, sandboxId: 'sb1', kind: 'chat', msgIds: ['k1'], text: '旧块', vec: [0.1], model: 'emb-test' },
    { id: 'keep2', ownerKey: 'c1', charId: 'c1', fromCharId: null, sandboxId: 'sb1', kind: 'chat', msgIds: ['k2'], text: '旧块2', vec: [0.1], model: 'emb-test' }
  ]);
  const { Sleepy } = makeEnv({ idb, api, core });
  const chat = {
    id: 'chatG', characterId: 'c1', userId: 'u1', name: 'G',
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: 'G_' + i, role: i % 2 ? 'user' : 'char',
      content: 'G话' + i, timestamp: 1000 + i
    }))
  };
  Sleepy.store.set('chats', [chat]);

  /* ① 清掉索引（生产 wipeAll） */
  const w = await Sleepy.memoryVec.wipeAll();
  chk('G1 wipeAll 没报 cleared：' + JSON.stringify(w), w.status === 'cleared');
  const st = Sleepy.memoryVec.rebuildState();
  chk('G2 清空完成后重建提示不可见（恢复路径断了）',
    !!st && st.state === 'needed' && st.via === 'wipe');
  chk('G3 没清掉任何块却挂了提示（clearedBlocks 判据失效）', w.clearedBlocks === 2);

  /* ② 点击前：增量 sweep 不静默重扫旧内容（基线挡住，嵌入数为 0） */
  const s1 = await Sleepy.memoryVec.sweep('c1', 'u1', chat);
  chk('G4 点击前的增量 sweep 没有成功返回', s1.ok === true);
  chk('G5 点击前发生了静默重扫（旧内容被重新嵌入，花了一次钱）',
    Object.keys(embedCount).filter((t) => t.indexOf('G话') >= 0).length === 0);

  /* ③ 点击重建 → 从头顶恢复历史索引 → 提示清除 */
  const r = await Sleepy.memoryVec.rebuildIndex();
  chk('G6 重建没走完：' + JSON.stringify(r.failed || []), r.ok === true);
  chk('G7 重建后提示没清掉', Sleepy.memoryVec.rebuildState() === null);
  const recs = (idb._records('sleepy-vec', 'vec') || []).length;
  chk('G8 重建后块数不对（20 条应切 2 块）', recs === 2);
  chk('G9 历史内容没有被重新嵌入', Object.keys(embedCount)
    .filter((t) => t.indexOf('G话') >= 0).length === 2);
}

/* H｜重建首轮先清库（2026-09-26 真机第 3 步前补口）：
   升级 → 点重建之间**增量建过**的块（口径 A 第②段），重扫会再生成一份
   （块 id 是新随机数、旧块不会被覆盖）→ 不先清就是同一段内容两块、
   白花一份 embedding 钱。首轮必须先清库再从头扫。 */
async function caseRebuildDedup() {
  const idb = makeIDB();
  const embedTexts = [];
  const api = {
    embed: (cfg, texts) => {
      texts.forEach((t) => embedTexts.push(t));
      return Promise.resolve({ ok: true, vecs: texts.map(() => [0.1, 0.2]), dim: 2, ms: 1 });
    }
  };
  const core = {
    rootIdOf: (id) => id, scopeId: () => 'sb1', scoped: (x) => x,
    charsOfSandbox: () => [{ id: 'c1' }], npcsOfRoom: () => []
  };
  /* 模拟真机第 2 步之后的状态：升级清了旧块，但增量已把新消息建了 1 块 */
  idb._seed('sleepy-vec', 6, 'vec', [
    { id: 'incr1', ownerKey: 'c1', charId: 'c1', fromCharId: 'c1', sandboxId: 'sb1', kind: 'chat',
      msgIds: ['H_16', 'H_17', 'H_18', 'H_19'], text: '我：新话（第 2 步增量建的块）', vec: [0.1], model: 'emb-test' }
  ]);
  const { Sleepy } = makeEnv({ idb, api, core });
  Sleepy.store.set('chats', [{
    id: 'chatH', characterId: 'c1', userId: 'u1', name: 'H',
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: 'H_' + i, role: i % 2 ? 'user' : 'char',
      content: 'H话' + i, timestamp: 1000 + i
    }))
  }]);
  Sleepy.store.set('vecRebuild', { state: 'needed', at: Date.now() - 1000 });

  const r = await Sleepy.memoryVec.rebuildIndex();
  chk('H1 重建没走完：' + JSON.stringify(r.failed || []), r.ok === true);
  const recs = idb._records('sleepy-vec', 'vec') || [];
  chk('H2 重建后块数不对（20 条切 2 块；不清库会留下增量旧块 = 3）：' + recs.length,
    recs.length === 2);
  chk('H3 第 2 步的增量旧块没被清掉（同段内容双份）',
    recs.every((b) => b.id !== 'incr1'));
  chk('H4 重扫嵌入数不对（2 块 = 2 条文本；旧块文本不该再算一遍）',
    embedTexts.filter((t) => t.indexOf('H话') >= 0 || t.indexOf('新话') >= 0).length === 2);
}

/* ---------------------------- 主流程 ---------------------------- */
(async () => {
  const cases = [
    ['A 升级权威信号', caseUpgrade],
    ['B 全新建库不误报', caseFresh],
    ['C 重建断点续扫', caseResume],
    ['D DOMContentLoaded 链', caseBootChain],
    ['E readyState 已错过兜底', caseBootFallback],
    ['F 生产 forget 三维删除', caseForget3D],
    ['G 清索引恢复路径', caseWipeRecover],
    ['H 重建先清库不重复', caseRebuildDedup]
  ];
  for (const [name, fn] of cases) {
    const before = results.length;
    try { await fn(); } catch (e) {
      results.push({ name: name + '（抛异常）', ok: false, error: (e && e.message) || String(e) });
      console.error('  ✗ ' + name + ' 抛异常：' + ((e && e.message) || e));
    }
    const failed = results.slice(before).filter((r) => !r.ok).length;
    console.log((failed ? '✗' : '✓') + ' ' + name + '：' + (results.slice(before).length - failed) + ' 过 / ' + failed + ' 败');
  }
  const fail = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ pass: results.length - fail.length, fail: fail.length,
    failed: fail.map((f) => f.name) }));
  process.exit(fail.length ? 1 : 0);
})();
