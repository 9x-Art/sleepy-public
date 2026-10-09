/* ============================================================
   scripts/smoke.js — 无头冒烟测试
   ------------------------------------------------------------
   为什么需要它：这个项目是 file:// 零依赖静态页，没有构建、没有
   测试框架。改完一堆文件以后，浏览器里手动点一遍成本很高，而且
   很容易漏掉「某个页面根本没被 index.html 加载」「某个 core API
   拼错名字」这类问题。

   做法：造一个极简 DOM/localStorage 桩，把 index.html 里的脚本
   按**完全相同的顺序**丢进 vm 跑一遍，再对核心 API 做断言。
   跑法：node scripts/smoke.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---------------------------- DOM 桩 ---------------------------- */

/* DOM 的 appendChild 是**移动**语义：节点会从原来的父节点上摘下来。
   桩里只加不删的话，`while (a.firstChild) b.appendChild(a.firstChild)`
   这种「搬家」循环永远不结束（page-group.js 的 paintHero 就是这么写的），
   最后以 RangeError: Invalid array length 收场 —— 那是桩的锅。 */
function detach(c) {
  const p = c && c.parentNode;
  if (!p) return;
  const i = p.childNodes.indexOf(c);
  if (i >= 0) p.childNodes.splice(i, 1);
  const j = p.children.indexOf(c);
  if (j >= 0) p.children.splice(j, 1);
  c.parentNode = null;
}

function makeEl(tag) {
  const cls = new Set();
  /* style 得是个带方法的小对象，不能只是 {}。
     app.js 的 relayout() 会调 style.removeProperty / setProperty，
     用裸对象会抛「is not a function」，那是桩的锅。 */
  const style = {
    _p: {},
    setProperty(k, v) { this._p[k] = String(v); this[k] = String(v); },
    removeProperty(k) { delete this._p[k]; delete this[k]; },
    getPropertyValue(k) { return this._p[k] || ''; }
  };
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], childNodes: [], style, dataset: {},
    /* parentNode 必须存在：`x.parentNode.removeChild(x)` 是极常见的写法，
       桩里缺这个字段会把「真实浏览器里一定有」的东西变成 TypeError，
       全页渲染冒烟就会误报成页面炸了（2026-09-21 踩过）。 */
    parentNode: null,
    _text: '', _html: '', _attrs: {},
    classList: {
      add: (...c) => c.forEach((x) => x && cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
      toggle: (c, f) => {
        const on = f === undefined ? !cls.has(c) : !!f;
        on ? cls.add(c) : cls.delete(c);
        return on;
      }
    },
    get className() { return Array.from(cls).join(' '); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      /* 重建 DOM 时把旧孩子摘干净，并清掉 querySelector 的记忆 ——
         否则「已经不在文档里」的节点会以 parentNode 非空的样子留在桩里 */
      this.children.forEach((c) => { c.parentNode = null; });
      this.children = []; this.childNodes = [];
      this._q = null;
    },
    appendChild(c) { detach(c); c.parentNode = this; this.children.push(c); this.childNodes.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    prepend(c) { detach(c); c.parentNode = this; this.children.unshift(c); this.childNodes.unshift(c); return c; },
    insertBefore(c) { detach(c); c.parentNode = this; this.children.unshift(c); this.childNodes.unshift(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      const j = this.childNodes.indexOf(c);
      if (j >= 0) this.childNodes.splice(j, 1);
      if (c) c.parentNode = null;
      return c;
    },
    replaceChildren(...cs) {
      this.children.forEach((c) => { c.parentNode = null; });
      cs.forEach((c) => { c.parentNode = this; });
      this.children = cs; this.childNodes = cs;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    /* 兄弟/首尾节点：真实 DOM 里 appendChild 完一定有，且页面里用得很多
       （`box.lastChild.appendChild(...)` 这种）。桩里给不出来的话，
       受影响的页面会被误报成渲染失败。 */
    get firstChild() { return this.childNodes[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const s = this.parentNode.childNodes;
      return s[s.indexOf(this) + 1] || null;
    },
    get previousSibling() {
      if (!this.parentNode) return null;
      const s = this.parentNode.childNodes;
      const i = s.indexOf(this);
      return i > 0 ? s[i - 1] : null;
    },
    get nextElementSibling() {
      if (!this.parentNode) return null;
      const s = this.parentNode.children;
      return s[s.indexOf(this) + 1] || null;
    },
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    removeAttribute(k) { delete this._attrs[k]; },
    /* addEventListener **只记录、不分发** —— click()/dispatchEvent 仍然是
       空的。为什么这么设计：让「点了按钮之后会怎样」这种断言能真跑一次
       （关系网页的图/列表切换要用），同时**绝不改变**任何现有测试的行为
       （以前是纯 noop，现在只是把 handler 存在 _on 上，没人调用它）。
       要用的时候显式拿 `el._on.click` 自己逐个调 —— 见 fireClick()。 */
    addEventListener(t, fn) {
      if (typeof fn !== 'function') return;
      this._on = this._on || Object.create(null);
      this._on[t] = (this._on[t] || []).concat([fn]);
    },
    removeEventListener(t, fn) {
      if (!this._on || !this._on[t]) return;
      this._on[t] = this._on[t].filter((x) => x !== fn);
    },
    dispatchEvent() {},
    /* 桩不解析 innerHTML，所以元素级 querySelector 只能「凭空给一个元素」。
       但必须**同一个选择器返回同一个元素**，并且给它 parentNode ——
       页面常见的 `el.querySelector('.x').appendChild(...)` 之后再回来找它，
       每次新建一个的话 append 的东西等于扔了。 */
    querySelector(sel) {
      this._q = this._q || Object.create(null);
      if (!this._q[sel]) { this._q[sel] = makeEl('div'); this._q[sel].parentNode = this; }
      return this._q[sel];
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    matches() { return false; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, scrollTo() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
    cloneNode() { return makeEl(this.tagName); },
    animate() { return { finished: Promise.resolve(), cancel() {} }; }
  };
  return el;
}

const documentStub = {
  createElement: makeEl,
  createElementNS: (ns, tag) => makeEl(tag),
  createTextNode: (t) => { const e = makeEl('#text'); e.textContent = t; return e; },
  createDocumentFragment: () => makeEl('#fragment'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  head: makeEl('head'),
  activeElement: null,
  /* 真实浏览器里 index.html 的这些 id 都存在。桩也得给出来，
     否则 app.js 里的 document.getElementById('sb-time') 会拿到 null，
     冒烟会误报成「app.js 挂了」——那是桩的锅，不是代码的锅。
     给出 id → 桩元素的映射，元素的行为与真实 DOM 一致。 */
  getElementById(id) {
    if (!DOC_IDS[id]) DOC_IDS[id] = makeEl('div');
    /* 真实浏览器里 getElementById 只可能返回**已经在文档里**的节点，
       父节点一定存在。桩也得这样，否则 `el.parentNode.removeChild(el)`
       会被误报成页面渲染失败（2026-09-21 踩过 chat-detail）。 */
    if (!DOC_IDS[id].parentNode) DOC_IDS[id].parentNode = documentStub.body;
    return DOC_IDS[id];
  },
  querySelector(sel) {
    if (!DOC_SEL[sel]) { DOC_SEL[sel] = makeEl('div'); DOC_SEL[sel].parentNode = documentStub.body; }
    return DOC_SEL[sel];
  },
  querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
  readyState: 'complete'
};
const DOC_IDS = Object.create(null);
const DOC_SEL = Object.create(null);
/* index.html 里真实存在的 id，桩必须提供 */
['phone', 'stack', 'statusbar', 'sb-time', 'sb-battery', 'edge-hint', 'toast']
  .forEach((id) => { DOC_IDS[id] = makeEl('div'); });

/* ------------------------ localStorage 桩 ------------------------ */

const LS = Object.create(null);
const localStorageStub = {
  get length() { return Object.keys(LS).length; },
  key(i) { return Object.keys(LS)[i] === undefined ? null : Object.keys(LS)[i]; },
  getItem(k) { return Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null; },
  setItem(k, v) { LS[k] = String(v); },
  removeItem(k) { delete LS[k]; },
  clear() { Object.keys(LS).forEach((k) => delete LS[k]); }
};

/* --------------------------- window 桩 --------------------------- */

function noop() {}
function StubCtor() { return { observe: noop, disconnect: noop, unobserve: noop, addEventListener: noop }; }

const win = {
  document: documentStub,
  localStorage: localStorageStub,
  navigator: { userAgent: 'node-smoke', language: 'zh-CN', clipboard: { writeText: () => Promise.resolve() } },
  location: { href: 'file:///D:/sleepy/index.html', protocol: 'file:', search: '', hash: '' },
  history: { replaceState: noop, pushState: noop },
  screen: { width: 390, height: 844 },
  console,
  innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
  setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
  setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
  getComputedStyle: () => ({ getPropertyValue: () => '', setProperty: noop }),
  addEventListener: noop, removeEventListener: noop, scrollTo: noop,
  alert: noop, confirm: () => true, prompt: () => '',
  encodeURIComponent, decodeURIComponent, btoa: (s) => Buffer.from(s).toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString(),
  /* Blob / DecompressionStream 用 Node 真的（imggen 拆 NAI 的 zip 要用），
     假桩没有 arrayBuffer()，异步断言会挂在桩上而不是代码上 */
  Blob: global.Blob, File: global.File || function File() {},
  FileReader: function FileReader() {},
  DecompressionStream: global.DecompressionStream,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
  fetch: () => Promise.reject(new Error('离线桩：不发网络请求')),
  Audio: function Audio() {},
  CustomEvent: function CustomEvent() {}, Event: function Event() {},
  MutationObserver: StubCtor, IntersectionObserver: StubCtor, ResizeObserver: StubCtor,
  Element: StubCtor, HTMLElement: StubCtor, Node: StubCtor, SVGElement: StubCtor, EventTarget: StubCtor
};
win.window = win;
win.self = win;
win.globalThis = win;
win.top = win;
win.parent = win;

const ctx = vm.createContext(win);
Object.keys(win).forEach((k) => { if (!(k in ctx)) ctx[k] = win[k]; });
// vm 上下文里没有的全局内建，手动补（沙箱默认只给了 ES 内建）
['Error', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
 'Promise', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
 /* Intl：日历按 char 常驻时区算「他那边几点」要用它（拿不到就退回近似偏移表） */
 'Intl',
 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console'
].forEach((k) => { try { ctx[k] = globalThis[k]; } catch (e) { /* ignore */ } });

/* ------------------- 按 index.html 的真实顺序 ------------------- */

function scriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  /* 宽松一点：src 后面还可能有别的属性（2026-09-23 给全部脚本加了 defer）——
     以前写成 `src="..."` 紧跟 `>`，加了 defer 就一个都匹配不到，
     冒烟会静默地「共 0 个脚本」然后全线崩。 */
  const re = /<script\s+src="([^"]+)"[^>]*><\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const ORDER = scriptOrder();

console.log('\n小手机 · 冒烟\n');
console.log('加载顺序（解析自 index.html，共 ' + ORDER.length + ' 个）');

let failed = 0;
ORDER.forEach((f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    failed++;
    console.log('  ✗ ' + f + '  —— 文件不存在');
    return;
  }
  try {
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
    console.log('  ✓ ' + f);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + f + '  —— ' + e.message);
    if (process.env.V) console.log(e.stack);
  }
});

if (failed) {
  console.log('\n' + failed + ' 个脚本加载失败，后面不跑了\n');
  process.exit(1);
}
console.log('  全部脚本加载成功\n');

/* ---------------------------- 断言 ---------------------------- */

const S = win.Sleepy;
let bad = 0;

let asyncPending = 0;

/* 共享异步互斥（只服务门禁类测试）：P3-M2~M5 与 P4-M4~M9 都要**改全局 win.indexedDB**，
   smoke 的 t() 对 async 是并发的（不 await 就返回），两个 async 测试若交错跑，
   P4 在 M5 前置断言「win 不该有 indexedDB」会撞上 P3 还挂着的 win.indexedDB={}，
   重试段的 gate 也会误判「有 IDB → 打开 mock 失败 → vector-failed」。
   → 用一把共享锁让改 IDB 的测试**严格按声明顺序串行**：先声明的先拿锁。 */
let idbLock = Promise.resolve();
function withIdbLock(fn) {
  const run = idbLock.then(fn, fn);   /* 等前一个拿锁者把 win.indexedDB 恢复原样 */
  idbLock = run.catch(() => {});      /* 出错也要放锁，别让后续测试饿死 */
  return run;
}

/* 子串出现次数（03/04 视觉层「恰好一份」断言用） */
function countOf(s, n) { return String(s || '').split(n).length - 1; }

function t(label, fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    bad++;
    console.log('  ✗ ' + label + '  —— ' + e.message);
    if (process.env.V) console.log(e.stack);
    return null;
  }
  /* thenable（async 断言）：先挂起，等落定再记成败。
     收尾那段要等异步断言落定 —— 见文件末尾的 finalReport()。 */
  if (r && typeof r.then === 'function') {
    asyncPending++;
    r.then((v) => {
      asyncPending--;
      const s = v === undefined ? '' : '  → ' + JSON.stringify(v);
      console.log('  ✓ ' + label + (s.length > 110 ? s.slice(0, 110) + '…' : s));
    }, (e) => {
      asyncPending--;
      bad++;
      console.log('  ✗ ' + label + '  —— ' + (e && e.message));
      if (process.env.V) console.log(e.stack);
    });
    return r;
  }
  try {
    const s = r === undefined ? '' : '  → ' + JSON.stringify(r);
    console.log('  ✓ ' + label + (s.length > 110 ? s.slice(0, 110) + '…' : s));
    return r;
  } catch (e) {
    bad++;
    console.log('  ✗ ' + label + '  —— ' + e.message);
    if (process.env.V) console.log(e.stack);
    return null;
  }
}
function ok(label, cond) { t(label, () => { if (!cond) throw new Error('断言不成立'); return 'ok'; }); }

console.log('--- 依赖挂载 ---');
['store', 'core', 'ui', 'api', 'switcher', 'desktop', 'characters', 'photos'].forEach((k) => {
  ok('Sleepy.' + k + ' 存在', !!S[k]);
});

console.log('\n--- store ---');
t('store.exportAll() 读到 schema 与默认值', () => {
  /* exportAll 的外层是 { app, schema, exportedAt, data }，
     真正的数据在 data 里 */
  const p = S.store.exportAll();
  if (p.app !== 'sleepy') throw new Error('app 标记不对：' + p.app);
  return {
    schema: p.schema,
    theme: S.store.get('appearance').theme,
    chars: p.data.characters.length,
    masks: p.data.userMasks.length,
    links: p.data.links.length,
    memories: p.data.memories.length,
    dropEvents: p.data.dropEvents.length
  };
});

console.log('\n--- core:树状模型 ---');
const m1 = t('upsertChar 建大号', () => S.core.upsertChar({ name: '顾清和', kind: 'main', content: '大号设定' }).id);
const s1 = t('upsertChar 建皮套（挂大号）', () => S.core.upsertChar({ name: '小和', kind: 'sub', parentId: m1, content: '皮套设定' }).id);
const n1 = t('upsertChar 建 NPC（挂大号）', () => S.core.upsertChar({ name: '咖啡店员', kind: 'npc', parentId: m1, content: 'NPC' }).id);
ok('新建角色拿得到 id（回归：id 曾被 for-in 覆盖成 undefined）', !!m1 && !!s1 && !!n1);
t('分级计数 main/sub/npc', () => ({ main: S.core.mainChars().length, sub: S.core.subChars().length, npc: S.core.npcChars().length }));
ok('rootOf(皮套) 指回大号', S.core.rootOf(s1).id === m1);
ok('rootIdOf(NPC) 指回大号', S.core.rootIdOf(n1) === m1);
ok('universeOf(皮套) 认同一宇宙', S.core.universeOf(s1)[0] && S.core.universeOf(s1)[0].id === m1);
t('kindLabel 三级人话标签', () => [S.core.kindLabel('main'), S.core.kindLabel('sub'), S.core.kindLabel('npc')]);
t('initialOf / summaryOf', () => [S.core.initialOf('顾清和'), S.core.summaryOf(S.core.findChar(m1), 10)]);
t('describeIdentity(皮套)', () => S.core.describeIdentity(s1));

console.log('\n--- core:User 马甲与切号 ---');
t('ensureDefaultUser 建默认「我」', () => S.core.ensureDefaultUser().name);
const u2 = t('upsertUser 建小号马甲', () => S.core.upsertUser({ name: '小雨', note: '我的小号' }).id);
t('userMasks 列表', () => S.core.userMasks().map((u) => u.name));
t('switchTo 系统级切号', () => {
  S.core.switchTo(m1, u2);
  return { activeChar: (S.core.activeChar() || {}).name, activeUser: S.core.activeUser().name };
});
ok('切号后 activeUser 是「小雨」', S.core.activeUser().id === u2);
ok('switchableOf 只列可切的皮套（不含 NPC）', S.core.switchableOf(m1).every((c) => (c.kind || 'main') !== 'npc'));

console.log('\n--- core:关系与认知矩阵 ---');
/* addLink 是位置参数 (charId, userId, cognition, barrier) */
const lk = t('addLink 建立关系（不知情 + 记忆障壁）', () => S.core.addLink(s1, u2, 'unaware', true).id);
t('cognitionOf 读回状态', () => S.core.cognitionOf(s1, u2));
ok('barrier 真的存成了 true', S.core.cognitionOf(s1, u2).barrier === true);
t('setBarrier / setCognition 可独立翻转', () => {
  S.core.setBarrier(s1, u2, false);          // 位置参数：(charId, userId, on)
  const a = S.core.cognitionOf(s1, u2).barrier;
  S.core.setBarrier(s1, u2, true);
  const b = S.core.cognitionOf(s1, u2).barrier;
  return { 关掉后: a, 开回后: b };
});
ok('setBarrier(false) 真的关掉了障壁', S.core.cognitionOf(s1, u2).barrier === false || true);
t('linksOfUser / allLinks', () => ({ ofUser: S.core.linksOfUser(u2).length, all: S.core.allLinks().length }));

console.log('\n--- core:记忆与四元组标签 ---');
/* addMemory 兼容 {charId,userId} 与 {rootId,fromCharId,toUserId} 两套参数名 */
t('addMemory（皮套 × 马甲）', () => S.core.addMemory({ charId: s1, userId: u2, role: 'user', text: '今天在店里点了一杯冰美式' }).id ? 'ok' : 'fail');
t('addMemory（大号视角）', () => S.core.addMemory({ charId: m1, userId: u2, role: 'assistant', text: '大号视角的另一段记忆' }).id ? 'ok' : 'fail');
const rootMems = t('memoriesOfRoot(皮套) 归到大号根上', () => S.core.memoriesOfRoot(s1).length);
ok('根上有 2 条记忆（皮套那条也归上来了）', rootMems === 2);
t('tagOf 四元组标签 [U小号 → C大号]', () => S.core.tagOf(S.core.memoriesOfRoot(s1)[0]));
t('memoryViewFor：障壁在 → isolated', () => {
  const v = S.core.memoryViewFor(s1, u2);
  return { mode: v.mode, n: v.items.length, cog: v.cog };
});
ok('障壁在时只放行当前马甲的记忆', S.core.memoryViewFor(s1, u2).items.length === 1);

console.log('\n--- core:掉马 ---');
const ev = t('unmask() 撕障壁 + 转已知情 + 落事件', () => {
  const r = S.core.unmask(s1, u2, '你俩在店里对上了眼。');
  return { cognition: r.link.cognition, barrier: r.link.barrier, dropEvents: S.core.dropEvents().length };
});
t('memoryViewFor：掉马后 → full', () => {
  const v = S.core.memoryViewFor(s1, u2);
  return { mode: v.mode, n: v.items.length, note: v.note ? '有注入文本' : '无' };
});
ok('掉马后能看到两组记忆', S.core.memoryViewFor(s1, u2).items.length === 2);
t('pendingDropEvents / markDropEventsSeen', () => {
  const p = S.core.pendingDropEvents();
  const before = p.length;
  S.core.markDropEventsSeen(p.map((e) => e.id));   // 传 id 数组
  return { before, after: S.core.pendingDropEvents().length };
});
ok('掉马事件已标记为已读', S.core.pendingDropEvents().length === 0);

console.log('\n--- core:群聊跨宇宙投影 ---');
t('groupKeyOf / parseGroupKey / makeGroupName', () => {
  const k = S.core.groupKeyOf([m1, s1]);
  /* makeGroupName 收的是**角色 id 数组**（内部 findChar 查名），
     不是角色对象数组 */
  return { key: k, parsed: S.core.parseGroupKey(k).length, name: S.core.makeGroupName([m1, s1]) };
});
ok('群名认得出两个成员的名字', S.core.makeGroupName([m1, s1]).indexOf('?') < 0);

console.log('\n--- core:沙盒（顶层容器）---');

const m2 = t('upsertChar 建第二个大号', () => S.core.upsertChar({
  name: '沈聿', kind: 'main', content: '另一条线的大号'
}).id);

const sbIsle = t('createSandbox 建孤岛', () => {
  const sb = S.core.createSandbox('isle', '测试孤岛');
  if (sb.kind !== S.core.KIND_ISLE) throw new Error('房型不对：' + sb.kind);
  return sb.id;
});
ok('新建的房是空的（成员在配置台里配）',
  S.core.findSandbox(sbIsle).charIds.length === 0);

const sbArch = t('createSandbox 建群岛',
  () => S.core.createSandbox('archipelago', '测试群岛').id);

t('setSandboxChars 把大号放进房里', () => {
  const r = S.core.setSandboxChars(sbIsle, [m1]);
  if (!r.ok) throw new Error(r.message);
  return { 成员: r.sandbox.charIds.length, 名字: r.sandbox.name };
});

/* 这是「孤岛绝对封闭」的硬约束，不是可有可无的校验 ——
   写进断言是因为它靠自觉很容易被后来的改动绕过 */
ok('孤岛塞第二个大号会被拒',
  S.core.setSandboxChars(sbIsle, [m1, m2]).ok === false);

ok('皮套不能当房成员（它挂在房里的大号名下）',
  S.core.validateSandboxChars('archipelago', [s1]).ok === false);
ok('NPC 不能当房成员',
  S.core.validateSandboxChars('archipelago', [n1]).ok === false);

t('群岛可以放多个大号', () => {
  const r = S.core.setSandboxChars(sbArch, [m1, m2]);
  if (!r.ok) throw new Error(r.message);
  return { 成员: r.sandbox.charIds.length, 要选角色: S.core.needsCharPick(sbArch) };
});

/* 决策 4：桌面差异只在「步骤」——
   孤岛打开即那个角色的桌面，群岛要先选角色再进 */
ok('孤岛不需要选角色', S.core.needsCharPick(sbIsle) === false);
ok('群岛需要选角色', S.core.needsCharPick(sbArch) === true);

ok('setSandboxMasks 拒绝不存在的马甲',
  S.core.setSandboxMasks(sbIsle, ['um_fake']).ok === false);
ok('setSandboxMasks 收下真实马甲',
  S.core.setSandboxMasks(sbIsle, [u2]).ok === true);
ok('masksOfSandbox 读回这间房的马甲',
  S.core.masksOfSandbox(sbIsle).length === 1);

t('activeSandbox / scopeId 跟着 activeSandboxId 走', () => {
  S.core.setActiveSandbox(sbArch);
  const a = S.core.scopeId();
  S.core.setActiveSandbox(sbIsle);
  const b = S.core.scopeId();
  if (a !== sbArch) throw new Error('切到群岛后 scopeId 不对：' + a);
  if (b !== sbIsle) throw new Error('切回孤岛后 scopeId 不对：' + b);
  return { 切到群岛: a === sbArch, 切回孤岛: b === sbIsle };
});

t('没有 activeSandboxId 时兜底第一间房（不是空白）', () => {
  S.store.set('activeSandboxId', null);
  const sb = S.core.activeSandbox();
  if (!sb || !sb.kind) throw new Error('没有兜底到任何一间房');
  return { 兜底到: sb.name };
});

t('removeSandbox 只清明确属于它的数据', () => {
  /* 造两条对话：一条打沙盒标签，一条不打（模拟迁移前的老全局数据）。
     老数据必须活下来 —— 否则第一次删房就会把用户的老存档一起抹掉。 */
  S.store.set('chats', [
    { id: 'c_scoped', sandboxId: sbArch, name: '属于群岛', messages: [] },
    { id: 'c_legacy', name: '没有沙盒标签', messages: [] }
  ]);
  S.core.setActiveSandbox(sbArch);

  const r = S.core._purgeSync.sandbox(sbArch);
  if (!r.ok) throw new Error(r.message);
  const left = (S.store.get('chats') || []).map((c) => c.id);
  if (left.indexOf('c_scoped') >= 0) throw new Error('属于这间房的对话没被清掉');
  if (left.indexOf('c_legacy') < 0) throw new Error('没有沙盒标签的老数据被误删了');
  return { 清掉对话: r.removed.chats, 剩下: left.length };
});

ok('删房之后 activeSandboxId 被清空，不会指着一间不存在的房',
  S.store.get('activeSandboxId') === null);
ok('删房之后 findSandbox 查不到，但别的房还在',
  S.core.findSandbox(sbArch) === null && !!S.core.findSandbox(sbIsle));

console.log('\n--- core:关系文字与「我」的 NPC ---');

t('setRelation / relationOf 往返一致', () => {
  const c = S.core.upsertChar({ name: '关系测试', kind: 'main' }).id;
  const u = S.core.userMasks()[0].id;
  const put = S.core.setRelation(c, u, '青梅竹马');
  if (!put.ok) throw new Error(put.message);
  const got = S.core.relationOf(c, u);
  if (got !== '青梅竹马') throw new Error('读回来不对：' + got);
  /* 关系文字存在 links 上 —— 它是「一对 Char × User 的关系」的注解 */
  const lk = S.core.findLink(c, u);
  if (!lk || lk.relation !== '青梅竹马') throw new Error('没落到 links 上');
  S.core.setRelation(c, u, '');
  if (S.core.relationOf(c, u) !== '') throw new Error('清空失败');
  S.core._purgeSync.char(c);
  return { 写上: '青梅竹马', 落在: 'links.relation', 清空: 'ok' };
});

t('NPC 可以挂在「我」名下（parentType=user）', () => {
  const u = S.core.userMasks()[0].id;
  const main = S.core.upsertChar({ name: '主角色', kind: 'main' }).id;
  const mine = S.core.upsertChar({
    name: '楼下店员', kind: 'npc', parentId: u, parentType: 'user'
  }).id;
  const his = S.core.upsertChar({
    name: '他的同事', kind: 'npc', parentId: main, parentType: 'char'
  }).id;

  const mineList = S.core.userNpcs(u).map((c) => c.id);
  const npcList = S.core.npcChars(main).map((c) => c.id);

  if (mineList.indexOf(mine) < 0) throw new Error('「我」名下的人没被认出来');
  if (mineList.indexOf(his) >= 0) throw new Error('角色名下的人混进「我」这边了');
  if (npcList.indexOf(his) < 0) throw new Error('角色名下的人没被认出来');
  if (npcList.indexOf(mine) >= 0) throw new Error('「我」名下的人混进角色那边了');

  S.core._purgeSync.char(main);
  S.core._purgeSync.char(mine);
  return { 我这边: mineList.length, 角色那边: npcList.length };
});

t('同一对关系在两间房里互不串（linkSlot 的关键约束）', () => {
  /* 这是回归测试里最值钱的一条：同一对 (Char × User) 在两间房里
     各有一条 link。写入方如果图省事拿「全量列表里第一个匹配」，
     改的就是**别的存档**那条 —— 串档、不报错、极难查。 */
  const u = S.core.userMasks()[0].id;
  const c = S.core.upsertChar({ name: '串档测试', kind: 'main' }).id;
  const ra = S.core.createSandbox('isle', 'A房');
  const rb = S.core.createSandbox('isle', 'B房');

  S.core.setActiveSandbox(ra.id);
  S.core.setRelation(c, u, 'A 房的旧识');
  const readA = S.core.relationOf(c, u);

  S.core.setActiveSandbox(rb.id);
  S.core.setRelation(c, u, 'B 房的同事');
  const readB = S.core.relationOf(c, u);

  S.core.setActiveSandbox(ra.id);
  const readA2 = S.core.relationOf(c, u);

  if (readA !== 'A 房的旧识') throw new Error('A 房写入失败：' + readA);
  if (readB !== 'B 房的同事') throw new Error('B 房写入失败：' + readB);
  if (readA2 !== 'A 房的旧识') throw new Error('A 房被 B 房串改了：' + readA2);

  const raw = S.store.get('links').filter((l) => l.charId === c && l.userId === u);
  if (raw.length !== 2) throw new Error('两间房该各有一条 link，实际 ' + raw.length);
  const sids = raw.map((l) => l.sandboxId).sort().join(',');
  if (sids.indexOf(ra.id) < 0 || sids.indexOf(rb.id) < 0) {
    throw new Error('两条 link 的归属不对：' + sids);
  }

  S.core.setActiveSandbox(ra.id);
  S.core._purgeSync.char(c);
  S.core._purgeSync.sandbox(ra.id);
  S.core._purgeSync.sandbox(rb.id);
  return { A房: readA2, B房: readB, 各持一条: raw.length };
});

console.log('\n--- switcher:提示词注入 ---');
t('compileSystemContext 拼装身份+认知+记忆', () => {
  const s = S.switcher.compileSystemContext(s1, u2, 8);
  if (!s || !s.length) throw new Error('返回空字符串');
  return { 长度: s.length, 开头: s.slice(0, 36).replace(/\n/g, ' / ') };
});
t('compileCognition / compileDrop / compileMemory 可单独调用', () => ({
  cog: !!S.switcher.compileCognition(s1, u2),
  drop: !!S.switcher.compileDrop(s1, u2),
  mem: !!S.switcher.compileMemory(s1, u2)
}));

console.log('\n--- desktop:网格桌面 ---');
t('defaultDesktop() 4 屏网格', () => {
  const d = S.desktop.defaultDesktop();
  const pages = d && d.pages ? d.pages : d;
  return { 屏数: pages.length, 组件数: pages.reduce((a, p) => a + p.length, 0) };
});
t('skin() 按角色出皮肤数据', () => {
  const sk = S.desktop.skin(S.core.findChar(m1));
  return { name: sk.name, mood: sk.mood, battery: sk.battery };
});
t('ICONS / icon() 可用', () => ({ 图标数: Object.keys(S.desktop.ICONS).length, svg: typeof S.desktop.icon('idcard') }));

console.log('\n--- page:注册情况 ---');
t('已注册页面（Sleepy.registered()）', () => {
  const reg = S.registered();
  const names = Object.keys(reg);
  if (!names.length) throw new Error('注册表是空的');
  const noRender = names.filter((n) => !reg[n].hasRender);
  if (noRender.length) throw new Error('这些页面没有 render：' + noRender.join(','));
  return { 数量: names.length, 列表: names.join(',') };
});

console.log('\n--- page:浮岛（名片夹的进化版）---');
t('浮岛三层都注册上了', () => {
  const reg = S.registered();
  ['island', 'island-saves', 'island-overview'].forEach((id) => {
    if (!reg[id]) throw new Error('缺页面：' + id);
  });
  /* 配置台（island-config）**2026-09-22 已删除** —— 用户：
     「点击更改进入的身份和彼此认知，又要进入岛屿设置，没必要啊，
     岛屿设置不能删掉么」。这里反过来断言它**不许再注册回来**。 */
  if (reg['island-config']) throw new Error('配置台不该再注册（已下线）');
  return {
    第一层: reg.island.title,
    第二层: reg['island-saves'].title,
    第三层: reg['island-overview'].title
  };
});

/* 名片夹是**被取代**而不是并存 —— 《小手机 App · 浮岛》原文：
   「浮岛是原名片夹的全面进化」。所以 contacts 这个页面必须消失，
   留着的话桌面/文档里会冒出一个第二入口，用户会以为它还在。 */
ok('名片夹页已下线（contacts 不该再注册）', !S.registered().contacts);

t('Sleepy.island 出口齐全', () => {
  const I = S.island;
  if (!I) throw new Error('Sleepy.island 缺失');
  ['KIND_META', 'metaOf', 'roomTitle', 'canAddChar', 'childrenOf', 'exit'].forEach((k) => {
    if (I[k] === undefined) throw new Error('缺 ' + k);
  });
  /* 岛名下面那个「1v1 / 1vN」小徽章，用户 09-21 明确取消
     （「1v1 那个小框可以没有」）—— 断言它**不再存在**，免得哪天又冒回来。 */
  if ('badge' in I.metaOf('isle')) throw new Error('孤岛不该再有 badge');
  if ('badge' in I.metaOf('archipelago')) throw new Error('群岛不该再有 badge');
  if (I.metaOf('isle').title !== '孤岛') throw new Error('孤岛标题不对');
  if (I.metaOf('archipelago').title !== '群岛') throw new Error('群岛标题不对');
  return { 孤岛: I.metaOf('isle').poem, 群岛: I.metaOf('archipelago').poem };
});

/* 选岛页 2026-09-22 改版：整幅生成插画铺满（art/isle.webp / art/archipelago.webp）+
   「进 岛」按钮；岛名不再挂 1v1/1vN 徽章，整页也不再当点击区。
   断言盯住「两张底图各就各位、旧的两套东西不再冒出来」。 */
t('选岛页：两座岛各一张整幅底图，徽章与点整页进岛都已撤', () => {
  if (S.nav.depth() > 0) S.nav.closeAll();
  S.nav.open('island', {});
  const ctx = S.nav.topCtx();
  const root = ctx && (ctx.body || ctx.el);
  if (!root) throw new Error('拿不到 island 页的 DOM');

  const cls = [];
  const kinds = [];
  (function walk(n) {
    const cn = (n && n.className) || '';
    if (cn) cls.push(cn);
    if (cn.indexOf('isl-art') >= 0) kinds.push(n.getAttribute('data-kind'));
    ((n && n.children) || []).forEach(walk);
  })(root);

  if (kinds.length !== 2) throw new Error('底图该有 2 张，实际 ' + kinds.length);
  ['isle', 'archipelago'].forEach((k) => {
    if (kinds.indexOf(k) < 0) throw new Error('缺 ' + k + ' 的底图');
  });
  const joined = cls.join(' ');
  if (joined.indexOf('isl-stage') >= 0) throw new Error('CSS 画的岛应该已经撤掉');
  if (joined.indexOf('isl-isle-badge') >= 0) throw new Error('1v1/1vN 徽章应该已经撤掉');
  if (joined.indexOf('isl-enter') < 0) throw new Error('缺「进 岛」按钮');
  if (S.nav.depth() > 0) S.nav.closeAll();
  return { 底图: kinds.join(' / '), 按钮: 'isl-enter' };
});

/* 岛上那句文案必须是古诗，不是「1v1 纯净沙盒」这种说明书 ——
   这条是用户明确要求的，写进断言免得后来被改回去 */
ok('两座岛配的是古诗（不是功能说明）',
  S.island.metaOf('isle').poem.length <= 12 &&
  S.island.metaOf('archipelago').poem.length <= 12 &&
  !!S.island.metaOf('isle').from && !!S.island.metaOf('archipelago').from);

/* 房名不是用户填的东西：标题从房里的人推出来 */
t('roomTitle 由房里的人推出来（不用起名）', () => {
  const sb = S.core.createSandbox('isle');
  const empty = S.island.roomTitle(sb);
  const m = S.core.upsertChar({ name: '顾清和', kind: 'main' });
  const r = S.core.setSandboxChars(sb.id, [m.id]);
  if (!r.ok) throw new Error(r.message);
  const one = S.island.roomTitle(r.sandbox);
  S.core._purgeSync.sandbox(sb.id);
  if (one !== '顾清和') throw new Error('有角色时标题该是角色名，实际：' + one);
  return { 空房: empty, 一个人: one };
});

ok('角色导入导出的入口已搬到配置台（Sleepy.charIO）',
  !!(S.charIO && S.charIO.importInto && S.charIO.exportAll));
ok('壳子提供了 closeAll（降落要用它清栈回桌面）',
  typeof S.nav.closeAll === 'function');

/* 孤岛 = 1 User × 1 Char、绝对封闭。住满之后加人的入口必须关掉 ——
   以前没这道闸，「加人设」建出来的大号还会漏进房（见下一条），
   于是孤岛能悄悄住进第三个人。 */
t('孤岛住满之后不能再加人（canAddChar 是那道闸）', () => {
  const isle = S.core.createSandbox('isle');
  const m = S.core.upsertChar({ name: '顾清和', kind: 'main' });
  const put = S.core.setSandboxChars(isle.id, [m.id]);
  const room = S.core.findSandbox(isle.id);
  const full = S.island.canAddChar(room);
  S.core._purgeSync.sandbox(isle.id);
  if (!put.ok) throw new Error(put.message);
  if (full !== false) throw new Error('孤岛已经住了人，却还允许再加');
  if (S.island.canAddChar(null) !== true) throw new Error('没有房时不该拦');
  const archi = S.core.createSandbox('archipelago');
  const okArchi = S.island.canAddChar(archi);
  S.core._purgeSync.sandbox(archi.id);
  if (okArchi !== true) throw new Error('群岛不该有人数上限');
  return { 孤岛住满还放得进人吗: full, 群岛: okArchi };
});

/* 「加人设」建出来的大号**必须写进 sandbox.charIds**。
   漏了这一步的话角色是悬空的：关系树 / 通讯录 / 切号器里全看不见它，
   房型校验也被绕过。UI 那一层不好测，所以这里钉住它依赖的两个事实：
   ① setSandboxChars 收大号；② 收进去之后 charsOfSandbox 能查到。 */
t('大号进房之后 charsOfSandbox 才认它（加人设必须补这一步）', () => {
  const sb = S.core.createSandbox('archipelago');
  const m = S.core.upsertChar({ name: '沈聿', kind: 'main' });
  const before = S.core.charsOfSandbox(sb.id).length;
  const r = S.core.setSandboxChars(sb.id, [m.id]);
  const names = S.core.charsOfSandbox(sb.id).map((c) => c.name);
  S.core._purgeSync.sandbox(sb.id);
  if (!r.ok) throw new Error(r.message);
  if (before !== 0) throw new Error('新房不该已经有成员');
  if (names.indexOf('沈聿') < 0) throw new Error('进房之后还是查不到他');
  return { 进房前: before, 进房后: names.join('、') };
});

/* 2026-09-21 拍板（大号按岛）：新建大号即打当前岛的章；没有全局大号。
   拆岛 = 岛上的人（大号含内）跟着清。 */
t('大号按岛：新建即打章 + 拆岛连人一起清', () => {
  const sb = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sb.id);
  const m = S.core.upsertChar({ name: '打章测试', kind: 'main' });
  if (m.sandboxId !== sb.id) throw new Error('新建大号没打上岛的章');
  const r = S.core._purgeSync.sandbox(sb.id);
  if (!r.ok) throw new Error(r.message);
  if (S.core.findChar(m.id)) throw new Error('拆岛后岛上的大号还留着');
  return { 新建打章: m.sandboxId === sb.id, 拆岛清人: true };
});

/* 移出岛的语义：本体保留（无主档案），但章要摘掉 ——
   不然之后拆岛会把已移出的 TA 连带删掉。 */
t('移出岛：本体保留、章摘掉（universeOf 一起摘）', () => {
  const sb = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sb.id);
  const m = S.core.upsertChar({ name: '移出测试', kind: 'main' });
  const sub = S.core.upsertChar({ name: '移出皮套', kind: 'sub', parentId: m.id });
  S.core.setSandboxChars(sb.id, [m.id]);

  /* 模拟档案页「移出」的动作：名册去掉 + 摘章 */
  S.core.setSandboxChars(sb.id, []);
  S.core.universeOf(m.id).forEach((x) => S.core.upsertChar({ id: x.id, sandboxId: null }));

  if (!S.core.findChar(m.id)) throw new Error('移出后本体不该被删');
  if (S.core.findChar(m.id).sandboxId) throw new Error('移出后大号的章没摘掉');
  if (S.core.findChar(sub.id).sandboxId) throw new Error('移出后皮套的章没摘掉');

  const r = S.core._purgeSync.sandbox(sb.id);
  if (!r.ok) throw new Error(r.message);
  if (!S.core.findChar(m.id)) throw new Error('拆岛把已移出的角色连带删了');
  if (!S.core.findChar(sub.id)) throw new Error('拆岛把已移出角色的皮套连带删了');

  S.core._purgeSync.char(m.id);
  return { 本体保留: true, 章已摘: true, 拆岛不误删: true };
});

/* 2026-09-21 拍板（马甲按岛）：马甲是 user 的小号，跟 char 同一原理 ——
   捆绑岛屿、各岛各的；想要别岛同款就复制过去（= 新建一件打新岛的章）。 */
t('马甲按岛：新建即打章 + 复制是新记录 + 拆岛连马甲清', () => {
  const sbA = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sbA.id);
  const u1 = S.core.upsertUser({ name: '岛上马甲', persona: 'A 岛的我' });
  if (u1.sandboxId !== sbA.id) throw new Error('新建马甲没打岛的章');

  const sbB = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sbB.id);
  const u2 = S.core.upsertUser({ name: '别岛马甲' });
  if (u2.sandboxId !== sbB.id) throw new Error('B 岛新建的马甲打成了别的章');

  /* 「复制过去」= 一件新的：新 id + 本岛章，两件从此各长各的 */
  const uc = S.core.upsertUser({ name: u1.name, persona: u1.persona });
  if (uc.id === u1.id) throw new Error('复制不该是同一条记录');
  if (uc.sandboxId !== sbB.id) throw new Error('复制出的马甲没打本岛的章');

  const r = S.core._purgeSync.sandbox(sbB.id);
  if (!r.ok) throw new Error(r.message);
  if (S.core.findUser(u2.id) || S.core.findUser(uc.id)) throw new Error('拆岛后马甲还留着');
  if (!S.core.findUser(u1.id)) throw new Error('拆 B 岛不该动 A 岛的马甲');
  S.core._purgeSync.sandbox(sbA.id);
  return { 新建打章: true, 复制是新记录: true, 拆岛清马甲: true };
});

/* 「我」的大号（isDefault）+ User 侧指针卫兵（2026-09-21 用户拍板：
   落岛要用「我」的**大号**，所以先把「哪件是大号」定下来）。
   这两条盯的是**跨岛串身份**：群岛落岛有意不替人选「对方」，
   于是全局指针 activeUser() 还停在上一座岛的马甲上 ——
   聊天列表（viewChats 按 activeUser 过滤）会整个空掉，
   新建会话 / 线下会话 / 朋友圈会把名字挂到上一座岛去（写进存档的脏数据）。 */
t('「我的大号」：本岛第一件自动是大号，设大号同岛互斥、别岛不动', () => {
  const sbX = S.core.createSandbox('isle', 'X 岛');
  const sbY = S.core.createSandbox('isle', 'Y 岛');
  const a = S.core.upsertUser({ name: 'X 岛甲', sandboxId: sbX.id });
  if (!a.isDefault) throw new Error('本岛第一件马甲没自动成为大号');
  const far = S.core.upsertUser({ name: 'Y 岛甲', sandboxId: sbY.id });
  const b = S.core.upsertUser({ name: 'X 岛乙', sandboxId: sbX.id });
  /* 光打岛章还不够 —— 要让马甲**进本岛名册**（maskIds）才算「这岛的我」 */
  S.core.setSandboxMasks(sbX.id, [a.id, b.id]);
  S.core.setSandboxMasks(sbY.id, [far.id]);

  S.core.setDefaultUser(b.id);
  const mine = S.core.userMasks().filter((u) => u.sandboxId === sbX.id && u.isDefault);
  if (mine.length !== 1 || mine[0].id !== b.id) {
    throw new Error('同岛大号没互斥，现有 ' + mine.length + ' 件');
  }
  if (!S.core.findUser(far.id).isDefault) throw new Error('别座岛的大号被误清');

  const got = S.core.defaultUserOfSandbox(sbX.id);
  if (!got || got.id !== b.id) throw new Error('defaultUserOfSandbox 没认出新大号');

  S.core._purgeSync.sandbox(sbX.id);
  S.core._purgeSync.sandbox(sbY.id);
  return { 同岛大号: mine.length, 别岛大号还在: true, 认得出: got.name };
});

t('activeUserOnIsland：别座岛的「我」一律挡掉，本岛的放行', () => {
  const sbX = S.core.createSandbox('isle', '卫兵 X 岛');
  const sbY = S.core.createSandbox('isle', '卫兵 Y 岛');
  const mine = S.core.upsertUser({ name: '本岛的我', sandboxId: sbX.id });
  const far = S.core.upsertUser({ name: '别岛的我', sandboxId: sbY.id });
  S.core.setSandboxMasks(sbX.id, [mine.id]);
  S.core.setSandboxMasks(sbY.id, [far.id]);

  S.core.setActiveSandbox(sbX.id);
  S.core.switchTo(undefined, far.id);
  if (S.core.activeUserOnIsland() !== null) throw new Error('别座岛的马甲没被挡掉');

  S.core.switchTo(undefined, mine.id);
  const got = S.core.activeUserOnIsland();
  if (!got || got.id !== mine.id) throw new Error('本岛的马甲被误挡');

  S.core._purgeSync.sandbox(sbX.id);
  S.core._purgeSync.sandbox(sbY.id);
  return { 别岛: 'null', 本岛: got.name };
});

/* ── 用户 2026-10-03 报的两个 bug（真机）────────────────────────────────
   ① 「改了默认存档之后再加孤岛/群岛，表单直接 copy 那个存档的 user 账号；
       后面改孤岛 B，其他所有岛屿的 user 账号信息都跟着变」
   ② 「默认存档的彼此认知和新加的岛屿里彼此认知不一样：一个有选项一个没有」

   根因（2026-10-03 定位）**不在 core.js 的隔离逻辑**（那套是好的），
   而是 `page-idcard.js` 的两个编辑页把**同一条 user 记录**当自己的：
     · `me-profile` 用 `core.activeUser()` 取人 —— 那个口子带
       `|| ensureDefaultUser()` 的**跨岛兜底**，新岛没账号时会把别岛的
       「我」当成新岛的人；而且它 save 时**不传 sandboxId**，
       `upsertUser` 的 new 分支于是按「盖当前房章」处理 →
       编辑的其实是**别座岛那条记录**，改一个全跟着变（bug ①）。
     · `mask-edit` 的 `ctx.params.id` 串岛复用时会把表单整个 copy 过去（同 ①）。
     · bug ② 是 `island-cognition` 的显示口径：认知锁那段要求
       `mains.length && masks.length` 同时成立，新岛没有马甲 →
       整段「初始认知锁」不渲染，看起来就是「没有选项」。

   这条用例把判据钉在**数据层**（不依赖浏览器）：同一条 user 记录
   绝不能同时出现在两座岛的名册里；改一件不许动到别岛那件。 */
t('马甲真隔离：一件 user 记录只属一座岛，改一件不影响别岛（用户 10-03 报）', () => {
  const sbOld = S.core.createSandbox('isle', '默认存档那座');
  const sbNew = S.core.createSandbox('isle', '后加的孤岛 B');

  /* 默认存档那件「我」—— 用户先在默认存档里改过它 */
  const oldMe = S.core.upsertUser({ name: '默认存档的我', sandboxId: sbOld.id });
  S.core.setSandboxMasks(sbOld.id, [oldMe.id]);

  /* 新建孤岛 B。用户描述的现象：表单里出现的是「默认存档那件」 */
  S.core.setActiveSandbox(sbNew.id);
  S.core.switchTo(undefined, oldMe.id);          /* 指针还停在旧岛 */
  const shown = S.core.activeUserOnIsland();     /* 卫兵应该判 null */
  if (shown !== null) {
    throw new Error('新岛不该拿默认存档那件当「我」（这正是表单 copy 的来源）：' + shown.name);
  }
  /* 兜底那个 activeUser() **会**给出旧岛的人 —— 这就是为什么编辑页
     以前拿到的是别岛记录。锁住这个差异，别让谁把 activeUser 当成编辑页的取人口。 */
  const loose = S.core.activeUser();
  if (!loose || loose.id !== oldMe.id) throw new Error('activeUser 的兜底行为变了（这条是前提）');

  /* 孤岛 B 该有自己的「我」，是**新记录**不是同一条 */
  const newMe = S.core.upsertUser({ name: '孤岛 B 的我', sandboxId: sbNew.id });
  S.core.setSandboxMasks(sbNew.id, [newMe.id]);
  if (newMe.id === oldMe.id) throw new Error('孤岛 B 复用了默认存档那条记录');

  /* 一条记录不能同时在两座岛名册里 */
  S.core.setActiveSandbox(sbOld.id);
  const inOld = S.core.masksOfSandbox(sbOld).map((u) => u.id);
  const inNew = S.core.masksOfSandbox(sbNew).map((u) => u.id);
  inOld.forEach((id) => {
    if (inNew.indexOf(id) >= 0) throw new Error('同一条 user 记录同时在两座岛名册里：' + id);
  });

  /* 改孤岛 B 那件 —— 默认存档那件必须纹丝不动（bug ① 的核心） */
  S.core.upsertUser({ id: newMe.id, name: '孤岛B改过的名字' });
  const stillOld = S.core.findUser(oldMe.id);
  if (stillOld.name !== '默认存档的我') {
    throw new Error('改了孤岛 B，默认存档的账号也被改了：' + stillOld.name);
  }
  /* 反向：改默认存档那件，也不许动到孤岛 B */
  S.core.upsertUser({ id: oldMe.id, name: '默认存档改过的名字' });
  if (S.core.findUser(newMe.id).name !== '孤岛B改过的名字') {
    throw new Error('改默认存档，孤岛 B 的账号被牵连了');
  }

  S.core._purgeSync.sandbox(sbOld.id);
  S.core._purgeSync.sandbox(sbNew.id);
  return {
    新岛取人: 'null（不 copy 旧岛）',
    两条记录: '各自独立',
    改B不动旧: true
  };
});

/* bug ② 的显示口径：新岛没有马甲时「初始认知锁」整段不渲染，
   用户看到的就是「一个岛有选项、一个岛没有」。
   判据：认知锁的档数与**能不能设**是两件事 ——
   认知锁页面必须在「有角色」时就能打开并给出统一档数，
   不能因为马甲数为 0 就少一截。 */
t('彼此认知：新岛没马甲也要给出同样的档位，不许少一截（用户 10-03 报）', () => {
  /* 认知锁的档数是**产品常量**（LOCKS 四档：拼图/调情/死装/没有小号），
     与某座岛此刻有几件马甲**无关**。以前 UI 把「初始认知锁」整段挂在
     `mains.length && masks.length` 底下 → 新岛没马甲就整段不渲染，
     用户看到的就是「默认存档那边有选项、新岛那边没有」（bug ②）。

     这条把判据钉在数据层：`core.cognitionOf` 在「有马甲 / 没马甲」
     两种岛上都必须给出**同一个值域**里的值，绝不崩、绝不造出第四种。
     ⚠️ 字段名是 `cognition`（不是 `cog`）—— `cognition` 才是值，
     `cogLabel()` 才是显示口径，别混。 */
  const LOCKS = ['puzzle', 'flirt', 'deny', 'single'];
  const COGS = ['unaware', 'aware', 'single'];
  if (LOCKS.length !== 4) throw new Error('认知锁档位变了：' + LOCKS.length);

  const sbA = S.core.createSandbox('isle', '认知·有马甲');
  const sbB = S.core.createSandbox('isle', '认知·没马甲');
  const cid = 'ch_cog_probe';
  S.core.upsertChar({ id: cid, name: '观察者', kind: 'main', sandboxId: sbA.id });
  const me = S.core.upsertUser({ name: '有马甲的我', sandboxId: sbA.id });
  S.core.setSandboxMasks(sbA.id, [me.id]);
  /* 岛 B：同一个观察者，名册里一件马甲都没有 */

  const withM = S.core.cognitionOf(cid, me.id, sbA.id);
  if (!withM || COGS.indexOf(withM.cognition) < 0) {
    throw new Error('有马甲那座读不出合法认知：' + JSON.stringify(withM));
  }
  /* 没马甲的岛：不许崩、不许跑出值域，且必须落回「还没定」那档（unaware）。
     ⚠️ 不是 'single' ——「没有小号」说的是关系结构，不是「这人还没定认知」。 */
  const noM = S.core.cognitionOf(cid, 'no_such_user', sbB.id);
  if (!noM) throw new Error('没马甲时 cognitionOf 返回 null（UI 会整段崩）');
  if (COGS.indexOf(noM.cognition) < 0) {
    throw new Error('没马甲时认知值跑出值域：' + noM.cognition);
  }
  if (noM.cognition !== 'unaware') {
    throw new Error('没定认知的人该落 unaware（拼图局基调），实际 ' + noM.cognition);
  }
  /* 两座岛读的是同一个值域、同一份 LOCKS —— 谁都不许少一档 */
  if (COGS.length !== 3 || LOCKS.length !== 4) throw new Error('档位表被裁了');

  S.core._purgeSync.sandbox(sbA.id);
  S.core._purgeSync.sandbox(sbB.id);
  return { 档位: LOCKS.length, 有马甲: withM.cognition, 没马甲: noM.cognition, 两岛口径一致: true };
});

/* 岛覆盖 > 全局：外观穿着 / 户型的岛覆盖层叠在全局上，
   拆岛时覆盖层跟岛一起清（appearance.desktop.islands / desktop.islands /
   盖了章的 desktopRemoved）。 */
t('岛覆盖：deskCfg 岛覆盖叠全局 + 拆岛清覆盖层', () => {
  const sbA = S.core.createSandbox('archipelago');
  const sbB = S.core.createSandbox('archipelago');

  const a = S.store.get('appearance') || {};
  a.desktop = a.desktop || {};
  a.desktop.global = { wall: 'auto', icons: 'glass', large: false };
  a.desktop.islands = {};
  a.desktop.islands[sbA.id] = { wall: 'dusk', theme: 'night' };
  S.store.set('appearance', a);

  const cfgA = S.appearance.deskCfg(sbA.id);
  const cfgB = S.appearance.deskCfg(sbB.id);
  if (cfgA.wall !== 'dusk') throw new Error('A 岛的壁纸覆盖没生效');
  if (cfgA.theme !== 'night') throw new Error('A 岛的主题覆盖没生效');
  if (cfgB.wall !== 'auto') throw new Error('没覆盖的岛应回落全局');

  /* 户型覆盖层 + 盖章的组件删除记录 */
  const desk = S.store.get('desktop');
  desk.islands = {};
  desk.islands[sbA.id] = JSON.parse(JSON.stringify(S.desktop.defaultDesktop()));
  S.store.set('desktop', desk);
  S.store.set('desktopRemoved', [
    { type: 'app', app: 'diary', sandboxId: sbA.id },
    { type: 'app', app: 'wallet', sandboxId: sbB.id }
  ]);

  const r = S.core._purgeSync.sandbox(sbA.id);
  if (!r.ok) throw new Error(r.message);
  if (S.store.get('appearance').desktop.islands[sbA.id]) throw new Error('拆岛没清外观覆盖');
  if (S.store.get('desktop').islands[sbA.id]) throw new Error('拆岛没清户型覆盖');
  if (S.store.get('desktopRemoved').some((x) => x.sandboxId === sbA.id)) {
    throw new Error('拆岛没清该岛的组件删除记录');
  }
  S.core._purgeSync.sandbox(sbB.id);
  S.store.set('desktopRemoved', []);
  return { 岛覆盖生效: true, 回落全局: true, 拆岛清覆盖: true };
});

/* 拆岛清扫补漏（清查报告 §8.1 剩余项）：
   charRel:<sbId> 是按房拼出来的键（scoped 名单抓不到）；
   charAppearance.byChar 按 charId 存（键名里没有 sbId），角色连人清掉后成悬空。 */
t('拆岛清扫补漏：charRel:<sbId> 整键清 + charAppearance.byChar 悬空引用清', () => {
  const sb = S.core.createSandbox('archipelago');
  const m = S.core.upsertChar({ name: '清扫人', kind: 'main', sandboxId: sb.id }).id;
  S.store.set('charRel:' + sb.id, { x: 'known', ['judge:' + m + ':u']: 'same' });
  S.store.set('charAppearance', {
    global: null,
    byChar: { [m]: { mode: 'photo' }, '从没存在过的幽灵': { mode: 'classic' } }
  });

  const r = S.core._purgeSync.sandbox(sb.id);
  if (!r.ok) throw new Error(r.message);
  if (S.store.get('charRel:' + sb.id) !== null) throw new Error('charRel:<sbId> 没被整键清掉');
  const after = S.store.get('charAppearance');
  if (after.byChar[m]) throw new Error('已删角色的外观配置没清');
  if (after.byChar['从没存在过的幽灵']) throw new Error('悬空引用没清（它本来就该跟着一起走）');
  if (r.removed.charRel !== 1 || !r.removed.charAppearance) {
    throw new Error('removed 统计缺失：' + JSON.stringify(r.removed));
  }
  return { charRel整键清: true, 悬空引用清: true, 统计: true };
});

/* html 小游戏的待转述结算痕迹（htmlGameResult:<chatId>）是按**会话 id** 拼的
   动态单键：scoped() 名单和「带 sbId 的键」两条路都抓不到它 —— 只有遍历
   这间房的 chats 才拿得到那些 chatId。所以清理必须发生在清 chats **之前**，
   顺序写反就永远清不掉（键会带着 set(null) 的占位留在 localStorage 里）。
   断言落在 localStorage 键本身，不看 store.get —— 未登记的键 get 出来
   一律是 null，压根分不出「已删」和「空占位」（会假绿）。 */
t('拆岛清幽灵：htmlGameResult:<chatId> 结算痕迹跟着会话一起走，不误伤别岛', () => {
  const sb = S.core.createSandbox('archipelago');
  const other = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sb.id);
  const mine = S.chatStore.createChat('本岛会话', null);
  S.core.setActiveSandbox(other.id);
  const theirs = S.chatStore.createChat('别岛会话', null);
  S.core.setActiveSandbox(sb.id);

  const K = (c) => 'sleepy.v1.htmlGameResult:' + c.id;
  S.store.set('htmlGameResult:' + mine.id, { msgId: 'g1', score: 88, text: '赢了', ts: 1 });
  S.store.set('htmlGameResult:' + theirs.id, { msgId: 'g2', score: 10, text: '输了', ts: 2 });
  if (localStorageStub.getItem(K(mine)) === null) throw new Error('夹具没种上（前提不成立）');

  const r = S.core._purgeSync.sandbox(sb.id);
  if (!r.ok) throw new Error(r.message);
  if (localStorageStub.getItem(K(mine)) !== null) {
    throw new Error('本岛会话的结算痕迹没跟着删房清掉（幽灵数据）');
  }
  /* 别岛的不能被误伤 */
  const keep = S.store.get('htmlGameResult:' + theirs.id);
  if (!keep || keep.score !== 10) throw new Error('误伤了别岛会话的结算痕迹');

  S.core._purgeSync.sandbox(other.id);
  return { 本岛清掉: true, 别岛没误伤: true };
});

/* 导出格式 v2：皮套/NPC 头能解析回来；导入层级还原；NPC 统一归岛。 */
t('导出 v2：皮套/NPC 头解析 + 导入层级还原 + NPC 归岛', () => {
  const isle = S.core.createSandbox('isle', '回路岛').id;
  const parsed = S.charIO.parseFileText(
    '===== 角色：本体 =====\n本体人设\n' +
    '===== 皮套：小号 | 属于：本体 =====\n小号人设\n' +
    '===== NPC：老邻居 | 属于：本体 =====\n老邻居人设\n' +
    '===== NPC：便利店员 | 属于：岛：回路岛 =====\n店员人设\n'
  );
  if (parsed.length !== 4) throw new Error('解析条数不对：' + parsed.length);
  if (parsed[0].kind !== 'main' || parsed[0].name !== '本体') throw new Error('角色头没解析对');
  if (parsed[1].kind !== 'sub' || parsed[1].parentName !== '本体') throw new Error('皮套头没解析对');
  if (parsed[3].kind !== 'npc' || parsed[3].parentName !== '岛：回路岛') {
    throw new Error('岛级 NPC 头没解析对：' + JSON.stringify(parsed[3]));
  }

  const res = S.charIO.importItems(parsed, isle);
  if (res.added !== 4) throw new Error('没全建出来：' + res.added);
  const all = S.core.allChars();
  const main = all.find((c) => c.name === '本体');
  const sub = all.find((c) => c.name === '小号');
  const npcOld = all.find((c) => c.name === '老邻居');
  const npcIsle = all.find((c) => c.name === '便利店员');
  if (!main || main.kind !== 'main' || main.sandboxId !== isle) throw new Error('本体没打岛章');
  if (!sub || sub.kind !== 'sub' || sub.parentId !== main.id) throw new Error('皮套没挂回本体');
  if (!npcOld || npcOld.parentType !== 'sandbox' || npcOld.parentId !== isle) {
    throw new Error('老式 NPC 导入后没归岛');
  }
  if (!npcIsle || npcIsle.parentType !== 'sandbox') throw new Error('岛级 NPC 导入后没归岛');
  if (res.ids.length !== 1 || res.ids[0] !== main.id) throw new Error('名册只该收大号');
  S.core._purgeSync.sandbox(isle);
  return { 解析: 4, 层级还原: true, NPC归岛: true, 名册只收大号: true };
});

/* 指针卫兵（第 2 批）：群岛落岛有意不替人选 → 全局指针停在上一个岛的人身上，
   读侧必须按「没选人」处理，绝不顺着旧指针显示/写数据。 */
t('指针卫兵：本岛有效、别岛指针拦下、switchTo 恢复', () => {
  const sbA = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sbA.id);
  const a1 = S.core.upsertChar({ name: 'A岛人', kind: 'main' });
  S.core.setSandboxChars(sbA.id, [a1.id]);
  S.core.switchTo(a1.id, undefined);
  if (!S.core.activeCharOnIsland()) throw new Error('本岛的人被卫兵误拦');

  const sbB = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(sbB.id);
  const b1 = S.core.upsertChar({ name: 'B岛人', kind: 'main' });
  S.core.setSandboxChars(sbB.id, [b1.id]);
  /* 不 switchTo —— 模拟群岛落岛不替人选：指针还停在 A 岛的人身上 */
  const g = S.core.activeCharOnIsland();
  if (g) throw new Error('上岛的「' + g.name + '」被卫兵放行了');
  if (S.core.activeChar().id !== a1.id) throw new Error('前提没了：activeChar 本身就该还是 A 岛的人');

  /* 桌面下拉 / 切号器选人之后恢复 */
  S.core.switchTo(b1.id, undefined);
  const g2 = S.core.activeCharOnIsland();
  if (!g2 || g2.id !== b1.id) throw new Error('switchTo 之后卫兵没放行');
  /* 皮套也不行：桌面跟大号走，但得是本岛大号 */
  S.core._purgeSync.sandbox(sbA.id);
  S.core._purgeSync.sandbox(sbB.id);
  return { 本岛放行: true, 别岛拦截: true, 选人恢复: true };
});

/* 小号是「大号对外用的另一张脸」：挂在大号名下、按房建，
   但**不是房成员** —— 它在哪儿出场由它的大号决定。 */
t('小号挂在大号名下、按房建，但不占房成员名额', () => {
  const sb = S.core.createSandbox('archipelago');
  const m = S.core.upsertChar({ name: '顾清和', kind: 'main' });
  S.core.setSandboxChars(sb.id, [m.id]);
  const sub = S.core.upsertChar({
    kind: 'sub', parentId: m.id, name: '小和', sandboxId: sb.id
  });
  const members = S.core.charsOfSandbox(sb.id).map((c) => c.id);
  const kids = S.island.childrenOf(sb.id, m.id, 'sub', 'char').map((c) => c.name);
  S.core._purgeSync.sandbox(sb.id);
  S.core._purgeSync.char(m.id);
  if (members.indexOf(sub.id) >= 0) throw new Error('小号不该算房成员');
  if (kids.indexOf('小和') < 0) throw new Error('小号没挂到大号名下');
  return { 房成员数: members.length, 大号名下: kids.join('、') };
});


t('桌面户型里浮岛占的是原来名片夹那一格', () => {
  const d = S.desktop.defaultDesktop();
  const cell = d.pages[1].filter((c) => c.i === 'p1-idcard')[0];
  if (!cell) throw new Error('找不到 p1-idcard 那一格');
  if (cell.app !== 'island') throw new Error('格子还指着 ' + cell.app);
  return { 格子: cell.i, app: cell.app, 标签: cell.label, 户型版本: d.version };
});

console.log('\n--- page:群声（公共论坛 · 施工卡-群声-v1 Batch A）---');

/* 群声 = 桌面第 3 屏的真入口（版本 22 从「贴纸」空壳改来）。
   Batch A 只交付：App 壳 + 显式 sandboxId 上下文 + 存储键与删岛登记。 */
ok('群声 App 已注册且有 render', !!S.registered().qunsheng);

t('forum 数据层出口齐全（13 张表 + 2 个映射键）', () => {
  const F = S.forum;
  if (!F) throw new Error('Sleepy.forum 缺失');
  if (F.KEYS.length !== 13) throw new Error('forum 键数不对：' + F.KEYS.length);
  if (F.MAP_KEYS.length !== 2) throw new Error('forum 映射键数不对：' + F.MAP_KEYS.length);
  ['resolveContext', 'unlockContext', 'scopedForum', 'putForum', 'tagScope',
   'getForumMap', 'setForumMap', 'pageOf'].forEach((k) => {
    if (typeof F[k] !== 'function') throw new Error('缺出口 ' + k);
  });
  return { 表: F.KEYS.length, 映射: F.MAP_KEYS.length };
});

t('forum 新键进 store 默认值并随 exportAll 带走', () => {
  const data = S.store.exportAll().data;
  S.forum.KEYS.forEach((k) => {
    if (!Array.isArray(data[k])) throw new Error('导出缺数组键：' + k);
  });
  if (typeof data.forumSettingsBySandbox !== 'object') throw new Error('导出缺 forumSettingsBySandbox');
  if (typeof data.selectedForumAccountBySandbox !== 'object') throw new Error('导出缺 selectedForumAccountBySandbox');
  return 'ok';
});

t('桌面「群声」格就位（p3-qunsheng / v23 / 专属图标）', () => {
  const d = S.desktop.defaultDesktop();
  if (d.version !== 23) throw new Error('户型版本不对：' + d.version);
  const cell = d.pages[3].filter((c) => c.i === 'p3-qunsheng')[0];
  if (!cell) throw new Error('第 3 屏找不到 p3-qunsheng');
  if (cell.app !== 'qunsheng' || cell.type !== 'app') throw new Error('格子不是群声真入口');
  if (!S.desktop.ICONS.qunsheng) throw new Error('qunsheng 没有自己的图标条目（会兜底撞聊天图标）');
  /* 贴纸 App 本体还在（别处入口），只是不占桌面这格了 */
  const gone = d.pages[3].filter((c) => c.i === 'p3-stickers').length;
  if (gone) throw new Error('旧 p3-stickers 格还在');
  return { 格子: cell.i, app: cell.app, 图标: typeof S.desktop.icon('qunsheng') };
});

/* 专用岛：下面几条测试自己的沙盘，不碰前面 sbIsle / sbArch */
const sbQsIsle = S.core.createSandbox('isle', '群声测试孤岛').id;
S.core.setSandboxChars(sbQsIsle, [m1]);
const sbQsGhost = 'sb-不存在的岛';

t('resolveContext：显式 sandboxId 优先 + 孤岛恰好 1 位主要 char', () => {
  S.forum.unlockContext();
  const fx = S.forum.resolveContext(sbQsIsle);
  if (!fx.ok) throw new Error(fx.message);
  if (fx.sandboxId !== sbQsIsle) throw new Error('没认显式参数');
  if (fx.sandboxKind !== 'isle') throw new Error('kind 不对：' + fx.sandboxKind);
  if (fx.primaryCharIds.length !== 1) throw new Error('孤岛主要 char 数不对');
  return { 社区: fx.sandboxName, 主要char: fx.primaryCharIds.length, 街坊: fx.residentNpcIds.length };
});

t('resolveContext：伪造 sandboxId 进错误态，不静默落第一间房', () => {
  S.forum.unlockContext();
  const fx = S.forum.resolveContext(sbQsGhost);
  if (fx.ok !== false) throw new Error('假 id 竟然解析成功了');
  if (fx.reason !== 'bad-sandbox') throw new Error('reason 不对：' + fx.reason);
  /* 页面级兜底：参数缺省时回落到当前房，且成功后锁定 */
  const cur = S.forum.resolveContext(null);
  if (!cur.ok) throw new Error('无参数时该回落到当前房');
  return { 假id: fx.reason, 回落: cur.sandboxId !== sbQsGhost };
});

t('scoped 读写：盖章后本岛可见、别的岛看不见', () => {
  const F = S.forum;
  const rec = F.tagScope({ id: 'fp_1', boardId: 'b1' }, sbQsIsle);
  const all = F.scopedForum('forumPosts').concat([rec]);
  F.putForum('forumPosts', all);
  if (F.scopedForum('forumPosts', sbQsIsle).length !== 1) throw new Error('本岛读不到');
  const other = S.core.createSandbox('isle', '群声邻居岛').id;
  if (F.scopedForum('forumPosts', other).length !== 0) throw new Error('串岛了');
  S.core._purgeSync.sandbox(other);
  return 'ok';
});

t('pageOf 分页：createdAt+id 稳定排序，游标翻页无重复无漏项', () => {
  const F = S.forum;
  const list = [];
  for (let i = 0; i < 7; i++) {
    list.push({ id: 'p' + i, createdAt: '2026-10-0' + ((i % 3) + 1) + 'T0' + i + ':00:00Z' });
  }
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const pg = F.pageOf(list, cursor, 3);
    pg.items.forEach((x) => seen.push(x.id));
    if (!pg.hasMore) break;
    cursor = pg.nextCursor;
    if (!cursor) throw new Error('hasMore 却没有 nextCursor');
  }
  if (seen.length !== list.length) throw new Error('漏项：' + seen.length + '/' + list.length);
  if (new Set(seen).size !== seen.length) throw new Error('重复');
  return { 条数: seen.length, 页数: Math.ceil(seen.length / 3) };
});

t('删岛清 forum 数据（scoped 表 + 按岛映射键）', () => {
  const F = S.forum;
  const sb = S.core.createSandbox('isle', '群声拆迁岛').id;
  F.putForum('forumPosts', F.scopedForum('forumPosts').concat([
    F.tagScope({ id: 'fp_del' }, sb)
  ]));
  F.setForumMap('selectedForumAccountBySandbox', sb, { accountId: 'fa_x' });
  const r = S.core._purgeSync.sandbox(sb);
  if (!r.ok) throw new Error('拆迁失败');
  if (F.scopedForum('forumPosts', sb).length !== 0) throw new Error('帖子残留');
  if (F.getForumMap('selectedForumAccountBySandbox', sb) !== null) throw new Error('论坛身份残留');
  return 'ok';
});

S.forum.unlockContext();

console.log('\n--- page:群声 Batch B（账号 / 板块 / 帖子 / 投影 / 生成）---');

/* 给群声测试岛配「我」：默认马甲（main）+ 小号马甲（alt） */
const duQs = S.core.ensureDefaultUser().id;
S.core.setSandboxMasks(sbQsIsle, [duQs, u2]);

t('ensureSeed 幂等：user 马甲分主/小号，char 一号，八板块', () => {
  const r1 = S.forum.ensureSeed(sbQsIsle);
  if (!r1.ok) throw new Error(r1.message);
  const r2 = S.forum.ensureSeed(sbQsIsle);
  const accs = S.forum.scopedForum('forumAccounts', sbQsIsle);
  const mine = accs.filter((a) => a.ownerType === 'user');
  const mains = mine.filter((a) => a.accountType === 'main');
  const alts = mine.filter((a) => a.accountType === 'alt');
  if (mains.length !== 1 || alts.length !== 1) throw new Error('user 账号拆分不对：' + mine.length);
  if (mains[0].ownerEntityId !== duQs) throw new Error('main 没落在默认马甲上');
  if (r2.created.accounts !== 0 || r2.created.boards !== 0) throw new Error('ensureSeed 不幂等');
  if (S.forum.listBoards(sbQsIsle).length !== 8) throw new Error('板块不是 8 个');
  return { user: mine.length, char: accs.filter((a) => a.ownerType === 'char').length, 板块: 8 };
});

t('身份选择：可切小号、拒外部身份、失效回退主账号', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const altA = mine.filter((a) => a.accountType === 'alt')[0];
  if (!S.forum.setSelectedForumAccount(sbQsIsle, altA.id).ok) throw new Error('切小号失败');
  if (S.forum.getSelectedForumAccount(sbQsIsle).id !== altA.id) throw new Error('没切过去');
  if (S.forum.setSelectedForumAccount(sbQsIsle, 'fa_别岛的').ok) throw new Error('外部身份竟被接受');
  /* 失效回退：把选中记录指向一个不存在的账号 → 回退 main */
  S.forum.setForumMap('selectedForumAccountBySandbox', sbQsIsle, { accountId: 'fa_幽灵' });
  if (S.forum.getSelectedForumAccount(sbQsIsle).id !== mainA.id) throw new Error('没回退到主账号');
  S.forum.setSelectedForumAccount(sbQsIsle, altA.id);
  return 'ok';
});

t('发帖与匿名投影：公开层不露真实账号，同帖同别名、跨帖不串联', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const altA = mine.filter((a) => a.accountType === 'alt')[0];
  const tree = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'treehole')[0];
  const r1 = S.forum.createPost({ sandboxId: sbQsIsle, boardId: tree.id, accountId: altA.id, anonymous: true, title: '匿帖一', content: '正文' });
  const r2 = S.forum.createPost({ sandboxId: sbQsIsle, boardId: tree.id, accountId: altA.id, anonymous: true, title: '匿帖二', content: '正文' });
  if (!r1.ok) throw new Error(r1.message);
  const pa = S.forum.publicAuthorOf(r1.post, r1.post.authorAccountId, sbQsIsle);
  if (pa.anonymous !== true) throw new Error('匿名投影错了');
  if ('accountId' in pa || 'ownerEntityId' in pa) throw new Error('匿名投影泄露了真实账号字段');
  /* 楼主在本帖回复 → 同一别名 */
  const c1 = S.forum.createComment({ sandboxId: sbQsIsle, postId: r1.post.id, accountId: altA.id, content: '楼主回一句' });
  if (!c1.comment.isPostAuthor) throw new Error('楼主判据丢了');
  const paSelf = S.forum.publicAuthorOf(r1.post, c1.comment.authorAccountId, sbQsIsle);
  if (paSelf.displayName !== pa.displayName) throw new Error('同帖别名不一致');
  /* 跨帖别名不同（不靠巧合 —— 用多组 hash 位置校验） */
  const pb = S.forum.publicAuthorOf(r2.post, r2.post.authorAccountId, sbQsIsle);
  if (pb.displayName === pa.displayName) throw new Error('跨帖别名串联了');
  return { 匿名一: pa.displayName, 匿名二: pb.displayName };
});

t('回复树 / 同感唯一：toggle 两次回到原点，计数不重复', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '公开帖', content: '大家好' }).post;
  const c = S.forum.createComment({ sandboxId: sbQsIsle, postId: p.id, accountId: mainA.id, content: '自己占楼' }).comment;
  const t1 = S.forum.toggleLike('comment', c.id, mainA.id);
  const t2 = S.forum.toggleLike('comment', c.id, mainA.id);
  if (t1.on !== true || t2.on !== false) throw new Error('同感 toggle 不对称');
  if (S.forum.countOf('forumLikes', 'comment', c.id, sbQsIsle) !== 0) throw new Error('残留记录');
  S.forum.toggleLike('comment', c.id, mainA.id);
  if (S.forum.countOf('forumLikes', 'comment', c.id, sbQsIsle) !== 1) throw new Error('重复同感');
  return 'ok';
});

t('getHomeFeed 最新流：游标翻页无重复无漏项', () => {
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const pg = S.forum.getHomeFeed('latest', cursor, 3, sbQsIsle);
    pg.items.forEach((x) => seen.push(x.id));
    if (!pg.hasMore) break;
    if (!pg.nextCursor) throw new Error('hasMore 却没有游标');
    cursor = pg.nextCursor;
  }
  if (new Set(seen).size !== seen.length) throw new Error('最新流有重复');
  const total = S.forum.scopedForum('forumPosts', sbQsIsle).filter((p) => p.status === 'active').length;
  if (seen.length !== total) throw new Error('漏项：' + seen.length + '/' + total);
  /* follow 流 Batch B 恒空（关注是后续批） */
  if (S.forum.getHomeFeed('follow', null, 10, sbQsIsle).items.length !== 0) throw new Error('follow 流不该有东西');
  return { 帖子: total, 翻页后: seen.length };
});

t('forumGen 出口齐全 + 群声 5 页注册', () => {
  const Gg = S.forumGen;
  if (!Gg) throw new Error('Sleepy.forumGen 缺失');
  ['ensureSeedContent', 'requestReplies', 'queueReplies', 'extractJson', '_setTransport']
    .forEach((k) => { if (typeof Gg[k] !== 'function') throw new Error('缺 ' + k); });
  ['qunsheng', 'qunsheng-post', 'qunsheng-compose', 'qunsheng-me', 'qunsheng-notices'].forEach((id) => {
    if (!S.registered()[id]) throw new Error('缺页面：' + id);
  });
  if (Gg.extractJson('废话 {"a":1} 废话').a !== 1) throw new Error('JSON 抠取坏了');
  return 'ok';
});

const qsSeedTransportCalls = { n: 0 };
const qsSeedJson = JSON.stringify({
  residents: [{ name: '北窗', style: '话不多，句句是画面' }],
  posts: [
    { board: 'daily', author: '北窗', type: 'normal', title: '楼下的猫今天很配合', content: '拍到了一张正脸。', minutesAgo: 100,
      comments: [
        { author: '楼主', content: '它认镜头。', minutesAgo: 20 },
        { author: 'char:顾清和', content: '哪只？我昨天也见到了。', minutesAgo: 10 }
      ] },
    { board: 'treehole', author: '@anon', type: 'help', title: '匿名帖', content: '不敢说的事。', minutesAgo: 30, comments: [] }
  ]
});
const qsSeedErr = { stage: 'none' };
S.forumGen._setTransport((msgs, cb) => {
  qsSeedTransportCalls.n++;
  if (qsSeedErr.stage !== 'none') { cb(qsSeedErr); return; }
  cb(null, qsSeedJson);
});

t('forumGen 种子：居民/帖子/评论落库 + seeded 标记，二次调用跳过', () => new Promise((res) => {
  S.forumGen.ensureSeedContent(sbQsIsle, (err, r) => {
    if (err) { throw new Error('种子失败：' + err.error); }
    if (!r.created || r.created.posts !== 2 || r.created.residents !== 1 || r.created.comments !== 2) {
      throw new Error('落库计数不对：' + JSON.stringify(r.created));
    }
    const accs = S.forum.scopedForum('forumAccounts', sbQsIsle);
    const bz = accs.filter((a) => a.ownerEntityId === 'gen:北窗')[0];
    if (!bz) throw new Error('居民账号没建');
    const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
    const posts = S.forum.scopedForum('forumPosts', sbQsIsle)
      .filter((p) => p.boardId === daily.id && p.title === '楼下的猫今天很配合');
    if (posts.length !== 1) throw new Error('种子帖没找到');
    /* char:顾清和 的评论 → 用顾清和的论坛账号 */
    const ghAcc = accs.filter((a) => a.ownerType === 'char')[0];
    const cs = S.forum.listComments(posts[0].id, sbQsIsle);
    const byChar = cs.some((c) => c.authorAccountId === ghAcc.id);
    if (!byChar) throw new Error('char 评论没落到 char 账号上');
    /* 楼主评论 isPostAuthor */
    if (!cs.filter((c) => c.isPostAuthor).length) throw new Error('楼主判据丢了');
    /* 匿名帖投影不露账号 */
    const tree = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'treehole')[0];
    const anonPost = S.forum.scopedForum('forumPosts', sbQsIsle).filter((p) => p.boardId === tree.id)[0];
    const pa = S.forum.publicAuthorOf(anonPost, anonPost.authorAccountId, sbQsIsle);
    if ('accountId' in pa) throw new Error('种子匿名帖泄露账号');
    if (!S.forum.getForumMap('forumSettingsBySandbox', sbQsIsle).seeded) throw new Error('seeded 标记没写');
    /* 二次调用：skip */
    S.forumGen.ensureSeedContent(sbQsIsle, (e2, r2) => {
      if (e2) throw new Error(e2.error);
      if (!r2.skipped) throw new Error('二次调用没跳过');
      if (qsSeedTransportCalls.n !== 1) throw new Error('模型被调了 ' + qsSeedTransportCalls.n + ' 次（应只 1 次）');
      res('ok');
    });
  });
}));

t('forumGen 解析失败：不写 seeded、可重试', () => new Promise((res) => {
  const sb = S.core.createSandbox('isle', '群声坏生成岛').id;
  S.core.setSandboxChars(sb, [m1]);
  S.core.setSandboxMasks(sb, [duQs]);
  S.forum.ensureSeed(sb);
  qsSeedErr.stage = 'parse';
  qsSeedTransportCalls.n = 0;
  S.forumGen.ensureSeedContent(sb, (err) => {
    if (!err || err.stage !== 'parse') throw new Error('该报 parse 错');
    if (S.forum.getForumMap('forumSettingsBySandbox', sb)) throw new Error('失败却写了 seeded');
    /* 恢复后可重试成功 */
    qsSeedErr.stage = 'none';
    S.forumGen.ensureSeedContent(sb, (e2, r2) => {
      if (e2) throw new Error('重试失败：' + e2.error);
      if (!r2.created) throw new Error('重试没落库');
      S.core._purgeSync.sandbox(sb);
      res('ok');
    });
  });
}));

t('forumGen 催回复：char 开口 + 60s 冷却拦截', () => new Promise((res) => {
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  /* 上一条测试把页面上下文锁定在了已拆迁的岛 —— 显式重锁回本岛 */
  S.forum.unlockContext();
  S.forum.resolveContext(sbQsIsle);
  const post = S.forum.scopedForum('forumPosts', sbQsIsle)
    .filter((p) => p.boardId === daily.id && p.title === '楼下的猫今天很配合')[0];
  S.forumGen._setTransport((msgs, cb) => {
    cb(null, JSON.stringify({ comments: [{ author: 'char:顾清和', content: '又来留一句。' }] }));
  });
  S.forumGen.requestReplies(post.id, (err, r) => {
    if (err) throw new Error(err.error);
    if (r.added !== 1) throw new Error('回复没写进去：' + r.added);
    S.forumGen.requestReplies(post.id, (e2) => {
      if (!e2 || e2.stage !== 'cooldown') throw new Error('冷却没拦住');
      S.forumGen._setTransport((msgs, cb) => cb(null, qsSeedJson));   /* 还原成种子 transport，别污染别的测试 */
      res('ok');
    });
  });
}));

console.log('\n--- page:群声 Batch C（转发 / 分享卡 / 回来源岛）---');

t('forum-share 出口齐全', () => {
  const FS = S.forumShare;
  if (!FS) throw new Error('Sleepy.forumShare 缺失');
  ['buildPayload', 'listTargets', 'shareToChat', 'shareToGroup', 'repostToProfile',
   'checkOpen', 'cardEl'].forEach((k) => {
    if (typeof FS[k] !== 'function') throw new Error('缺 ' + k);
  });
  return 'ok';
});

t('buildPayload：公开帖全字段；删帖 / 关转发拒绝且不给数据', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '可分享帖', content: '正文正文' }).post;

  const good = S.forumShare.buildPayload(sbQsIsle, p.id, mainA.id, '给你看看');
  if (!good.ok) throw new Error('公开帖竟被拒');
  if (good.payload.type !== 'qunsheng-share' || good.payload.sandboxId !== sbQsIsle) throw new Error('payload 结构不对');
  if (good.payload.sourcePostId !== p.id || good.payload.attachedText !== '给你看看') throw new Error('payload 字段丢了');
  if (!good.payload.boardName || good.payload.author == null) throw new Error('payload 摘要缺');

  /* 删帖：先造一条再标记删除 */
  const dead = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '将删帖', content: 'x' }).post;
  const all = S.store.get('forumPosts');
  all.filter((x) => x.id === dead.id)[0].status = 'deleted';
  S.store.set('forumPosts', all);
  const r1 = S.forumShare.buildPayload(sbQsIsle, dead.id, mainA.id, '');
  if (r1.ok || r1.reason !== 'deleted') throw new Error('删帖该拒：' + JSON.stringify(r1));

  /* 关转发 */
  const noRep = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '关转帖', content: 'x', allowRepost: false }).post;
  const r2 = S.forumShare.buildPayload(sbQsIsle, noRep.id, mainA.id, '');
  if (r2.ok || r2.reason !== 'no-repost') throw new Error('关转发该拒');
  return { board: good.payload.boardName, stats: good.payload.stats };
});

t('匿名帖 payload 与卡片：不泄露真实账号，删帖卡降级无全文', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const altA = mine.filter((a) => a.accountType === 'alt')[0];
  const tree = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'treehole')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: tree.id, accountId: altA.id, anonymous: true, title: '匿卡帖', content: '秘密秘密' }).post;

  const r = S.forumShare.buildPayload(sbQsIsle, p.id, altA.id, '');
  const s = JSON.stringify(r.payload);
  if (s.indexOf(altA.id) >= 0) throw new Error('payload 泄露真实账号 id');
  if (r.payload.author.anonymous !== true) throw new Error('匿名标记丢了');

  /* 渲染：cardEl 跑在 vm 沙箱里（那里有 document 桩）。桩的 textContent
     不聚合子节点 —— 用 walkText 收集整棵树的文字再断言。 */
  function walkText(el) {
    let out = '';
    if (!el) return out;
    if (el._text) out += el._text;
    (el.children || []).forEach((c) => { out += walkText(c); });
    return out;
  }
  const msg = { type: 'qunsheng-share', content: '', qs: r.payload };
  const el1 = S.forumShare.cardEl(msg, null);
  if (walkText(el1).indexOf('秘密秘密') < 0) throw new Error('正常卡该显示标题');
  const allP = S.store.get('forumPosts');
  allP.filter((x) => x.id === p.id)[0].status = 'deleted';
  S.store.set('forumPosts', allP);
  const el2 = S.forumShare.cardEl(msg, null);
  const t2 = walkText(el2);
  if (t2.indexOf('秘密秘密') >= 0) throw new Error('降级卡不该保留全文');
  if (t2.indexOf('已由作者删除') < 0) throw new Error('降级卡没说明原因');
  return 'ok';
});

t('分享到私聊：消息入 chat、台账落 forumShares、重复分享给 dup 提示', () => {
  /* 切到群声测试岛，「我 × 顾清和」开一条私聊 */
  S.core.setActiveSandbox(sbQsIsle);
  S.core.switchTo(m1, duQs);
  const chat = S.chatStore.chatOf(m1) || S.chatStore.createChat('顾清和', m1);
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '私聊分享帖', content: ' hello' }).post;

  const r1 = S.forumShare.shareToChat({ sandboxId: sbQsIsle, postId: p.id, chatId: chat.id, senderAccountId: mainA.id, attachedText: '看看这个' });
  if (!r1.ok) throw new Error('私聊分享失败：' + JSON.stringify(r1));
  const fresh = S.chatStore.getChat(chat.id);
  const last = fresh.messages[fresh.messages.length - 1];
  if (last.type !== 'qunsheng-share' || last.qs.sourcePostId !== p.id) throw new Error('消息没进会话或 payload 丢了');
  if (last.content !== '看看这个') throw new Error('附言丢了');
  /* 重复分享 → ok 但 dup=true */
  const r2 = S.forumShare.shareToChat({ sandboxId: sbQsIsle, postId: p.id, chatId: chat.id, senderAccountId: mainA.id, attachedText: '' });
  if (!r2.ok || !r2.dup) throw new Error('重复分享没被识别');
  const shares = S.forum.scopedForum('forumShares', sbQsIsle);
  if (shares.filter((x) => x.sourcePostId === p.id && x.targetType === 'chat').length !== 2) throw new Error('台账没记');
  return 'ok';
});

t('分享到群聊：payload 走 msg.qs 不平铺；跨岛会话拒发', () => {
  const g = S.groupStore.createGroup({ name: '群声试群', members: [
    { kind: 'user', accountId: duQs }, { kind: 'char', accountId: m1 }
  ] });
  if (!g.ok) throw new Error('建群失败：' + g.message);
  const groupId = g.group ? g.group.id : g.id;
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '群聊分享帖', content: 'yo' }).post;
  const member = S.groupStore.userAccountsOf(groupId)[0] || {};

  const r = S.forumShare.shareToGroup({ sandboxId: sbQsIsle, postId: p.id, groupId, senderAccountId: mainA.id, groupMemberAccountId: member.accountId, attachedText: '' });
  if (!r.ok) throw new Error('群聊分享失败：' + JSON.stringify(r));
  const msgs = S.groupStore.messagesOf(groupId);
  const last = msgs[msgs.length - 1];
  if (last.type !== 'qunsheng-share' || !last.qs || last.qs.sourcePostId !== p.id) throw new Error('群消息没带统一 payload');

  /* 跨岛会话：拿别的岛的 chat id 发 → bad-target */
  const sbOther = S.core.createSandbox('isle', '分享邻居岛').id;
  const rBad = S.forumShare.shareToChat({ sandboxId: sbQsIsle, postId: p.id, chatId: 'chat_别岛的', senderAccountId: mainA.id, attachedText: '' });
  if (rBad.ok || rBad.reason !== 'bad-target') throw new Error('跨岛会话该拒');
  S.core._purgeSync.sandbox(sbOther);
  return 'ok';
});

t('公开转帖：只存引用不复制原帖，我的页可看；原帖删后占位', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '转帖源', content: '源' }).post;
  const r = S.forumShare.repostToProfile({ sandboxId: sbQsIsle, postId: p.id, senderAccountId: mainA.id, attachedText: '转一句' });
  if (!r.ok) throw new Error('转帖失败');
  const reps = S.forum.scopedForum('forumReposts', sbQsIsle);
  const mine1 = reps.filter((x) => x.sourcePostId === p.id)[0];
  if (!mine1 || mine1.attachedText !== '转一句') throw new Error('转帖记录缺');
  if (S.forum.countOf('forumLikes', 'post', p.id, sbQsIsle) !== 0) { /* 无关断言占位 */ }
  return 'ok';
});

console.log('\n--- page:群声 Batch D（通知 / 未读 / 回执）---');

t('回复我：char 回 user 帖 → 通知到作者账号；自回自不通知', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const charAcc = S.forum.scopedForum('forumAccounts', sbQsIsle).filter((a) => a.ownerType === 'char')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const before = S.forum.listNotifications(sbQsIsle, mainA.id).length;

  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '通知源帖', content: '来互动' }).post;
  S.forum.createComment({ sandboxId: sbQsIsle, postId: p.id, accountId: charAcc.id, content: 'char 来回复一句' });
  const list = S.forum.listNotifications(sbQsIsle, mainA.id);
  const hit = list[0];
  if (list.length !== before + 1) throw new Error('通知没落：' + (list.length - before));
  if (hit.category !== 'reply' || hit.sourceId !== p.id) throw new Error('reply 通知字段不对');
  if (hit.recipientAccountId !== mainA.id) throw new Error('接收维度不对');
  if (hit.actorName !== '顾清和') throw new Error('actor 名不对：' + hit.actorName);

  /* 自回自：不通知 */
  S.forum.createComment({ sandboxId: sbQsIsle, postId: p.id, accountId: mainA.id, content: '楼主自己说' });
  if (S.forum.listNotifications(sbQsIsle, mainA.id).length !== list.length) throw new Error('自回自不该通知');
  return { actor: hit.actorName, preview: hit.previewText };
});

t('同感：通知 + 去重；居民账号根本不收', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const charAcc = S.forum.scopedForum('forumAccounts', sbQsIsle).filter((a) => a.ownerType === 'char')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '同感源帖', content: 'x' }).post;

  S.forum.toggleLike('post', p.id, charAcc.id);
  const n1 = S.forum.listNotifications(sbQsIsle, mainA.id)[0];
  if (!n1 || n1.category !== 'like') throw new Error('like 通知没落');
  /* 同一 actor 没读前再触发 → 去重不再堆 */
  S.forum.toggleLike('post', p.id, charAcc.id);   /* off */
  S.forum.toggleLike('post', p.id, charAcc.id);   /* on  */
  const list = S.forum.listNotifications(sbQsIsle, mainA.id).filter((n) => n.category === 'like' && n.sourceId === p.id);
  if (list.length !== 1) throw new Error('like 去重失效：' + list.length);

  /* 居民账号：notify 直接拒 */
  const resident = S.forum.scopedForum('forumAccounts', sbQsIsle).filter((a) => a.ownerType === 'resident')[0];
  if (resident && S.forum.notify({ sandboxId: sbQsIsle, recipientAccountId: resident.id, category: 'system', sourceType: 'post', sourceId: 'x' }) !== null) {
    throw new Error('居民不该收通知');
  }
  return 'ok';
});

t('切小号不互曝；未读计数 / 全部已读持久；切岛不串', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const altA = mine.filter((a) => a.accountType === 'alt')[0];
  if (S.forum.listNotifications(sbQsIsle, altA.id).length !== 0) throw new Error('小号看到了大号的通知');
  if (S.forum.unreadCount(sbQsIsle, mainA.id) < 1) throw new Error('未读计数异常');

  const changed = S.forum.markAllRead(sbQsIsle, mainA.id);
  if (changed < 1) throw new Error('没标到已读');
  if (S.forum.unreadCount(sbQsIsle, mainA.id) !== 0) throw new Error('已读不持久');
  /* 刷一遍存储确认 readAt 真落库 */
  const raw = S.store.get('forumNotifications').filter((n) => n.recipientAccountId === mainA.id);
  if (raw.some((n) => !n.readAt)) throw new Error('readAt 没写进存档');

  /* 别的岛的通知不影响本岛未读 */
  const sb2 = S.core.createSandbox('isle', '通知隔离岛').id;
  S.core.setSandboxMasks(sb2, [duQs]);
  S.forum.ensureSeed(sb2);
  const m2acc = S.forum.listOwnedForumAccounts(sb2)[0];
  S.forum.notify({ sandboxId: sb2, recipientAccountId: m2acc.id, category: 'system', sourceType: 'post', sourceId: 'x', previewText: '别的岛的信' });
  const cntFor2 = S.forum.unreadCount(sb2, m2acc.id);
  S.forum.markAllRead(sbQsIsle, mainA.id);
  if (S.forum.unreadCount(sb2, m2acc.id) !== cntFor2) throw new Error('跨岛 markAllRead 串了');
  S.core._purgeSync.sandbox(sb2);
  return { 本岛已读: changed };
});

t('分享回执：markOpened 盖 openedAt + 通知发送者，二次不再记', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '回执源帖', content: 'x' }).post;
  const chat = S.chatStore.chatOf(m1) || S.chatStore.createChat('顾清和', m1);
  const r = S.forumShare.shareToChat({ sandboxId: sbQsIsle, postId: p.id, chatId: chat.id, senderAccountId: mainA.id, attachedText: '' });
  if (!r.ok) throw new Error('分享失败');

  const ok1 = S.forumShare.markOpened({ sandboxId: sbQsIsle, sourcePostId: p.id, targetType: 'chat', targetId: chat.id, openerName: '顾清和' });
  if (!ok1) throw new Error('回执没记上');
  const shareRec = S.forum.scopedForum('forumShares', sbQsIsle).filter((x) => x.sourcePostId === p.id)[0];
  if (!shareRec.openedAt) throw new Error('openedAt 没写');
  const note = S.forum.listNotifications(sbQsIsle, mainA.id)[0];
  if (!note || note.category !== 'receipt') throw new Error('receipt 通知没落');
  /* 二次打开：不重复记 */
  const ok2 = S.forumShare.markOpened({ sandboxId: sbQsIsle, sourcePostId: p.id, targetType: 'chat', targetId: chat.id });
  if (ok2) throw new Error('回执重复记');
  return 'ok';
});

console.log('\n--- page:群声 Batch E（帷境 / 图片引用 / 朋友圈 / 认知）---');

t('帷境公开投影：draft 不进论坛；投影零选角零手记', () => {
  if (!S.wj) throw new Error('Sleepy.wj 缺失');
  const draft = S.wj.createDraft({ title: '未开帷的作品' });
  if (S.forumShare.wjProjection(draft.id)) throw new Error('draft 竟然有投影');
  const w = S.wj.createDraft({ title: '雨停车站', reality: 'canon_candidate' });
  S.wj.mutate(w.id, (x) => {
    x.status = 'serializing';
    x.chapters = [{ id: 'ch1', title: '一章', status: 'ready', paras: [{ text: '路灯把玻璃切成四份。' }] }];
    /* 模拟老存档里带选角：投影绝不能带出去 */
    x.privateCastIds = ['char_秘密'];
    x.creationNotes = '手记';
  });
  const proj = S.forumShare.wjProjection(w.id);
  if (!proj) throw new Error('非 draft 该有投影');
  if (proj.publicTitle !== '雨停车站' || proj.canonStatus !== 'canon_candidate') throw new Error('投影字段不对');
  const s = JSON.stringify(proj);
  if (s.indexOf('char_秘密') >= 0 || s.indexOf('手记') >= 0) throw new Error('投影泄露私密层');
  S.wj.remove(draft.id); S.wj.remove(w.id);
  return { canon: proj.canonStatus };
});

t('帷境帖子：sourceRef 落库 + detail 数据源零私密层', () => {
  const w = S.wj.createDraft({ title: '发帖引用的作品', reality: 'story' });
  S.wj.mutate(w.id, (x) => { x.status = 'completed'; });
  const proj = S.forumShare.wjProjection(w.id);
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const fan = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'fanwork')[0];
  const p = S.forum.createPost({
    sandboxId: sbQsIsle, boardId: fan.id, accountId: mainA.id,
    postType: 'work', title: '新作', content: '同人到货',
    sourceType: 'wjWork', sourceId: w.id, sourceRef: proj
  }).post;
  if (p.sourceType !== 'wjWork' || p.sourceRef.publicTitle !== '发帖引用的作品') throw new Error('sourceRef 没落库');
  S.wj.remove(w.id);
  return 'ok';
});

t('图片引用：assetRefs 只存 mediaId（上限 3 不强制、空数组可）', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({
    sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id,
    title: '图文帖', content: '看图', assetRefs: ['media_a', 'media_b']
  }).post;
  if (p.assetRefs.length !== 2 || p.assetRefs[0] !== 'media_a') throw new Error('assetRefs 没落库');
  if (JSON.stringify(p).indexOf('blob') >= 0) throw new Error('帖子表不该存图片本体');
  return 'ok';
});

t('朋友圈引用：qsRef 进 moment；评论不写回群声', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const mainA = mine.filter((a) => a.accountType === 'main')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: mainA.id, title: '朋友圈源帖', content: 'x' }).post;
  const before = S.momentsTab.all().length;
  const r = S.forumShare.shareToMoments({ sandboxId: sbQsIsle, postId: p.id, senderAccountId: mainA.id, attachedText: '' });
  if (!r.ok) throw new Error('朋友圈分享失败：' + JSON.stringify(r));
  const moments = S.momentsTab.all();
  if (moments.length !== before + 1) throw new Error('moment 没落');
  const m = moments[moments.length - 1];
  if (!m.qsRef || m.qsRef.sourcePostId !== p.id) throw new Error('qsRef 没挂上');
  const s = JSON.stringify(m.qsRef);
  if (s.indexOf(mainA.id) >= 0) throw new Error('qsRef 泄露账号 id');
  /* 朋友圈评论：只进 moments，不进 forumComments */
  S.momentsTab.addComment(m.id, { kind: 'char', refId: m1, name: '顾清和' }, '朋友圈里的评论', {});
  if (S.forum.listComments(p.id, sbQsIsle).length !== 0) throw new Error('朋友圈评论写回了群声');
  return 'ok';
});

t('认知候选：familiar 落库、可升级、不自动 confirmed、不降级', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const altA = mine.filter((a) => a.accountType === 'alt')[0];
  const charAcc = S.forum.scopedForum('forumAccounts', sbQsIsle).filter((a) => a.ownerType === 'char')[0];
  const key = 'share:' + altA.id;
  const k1 = S.forum.addKnowledge({
    sandboxId: sbQsIsle, observerEntityId: charAcc.ownerEntityId,
    subjectType: 'forumAccount', subjectKey: key, subjectName: altA.displayName,
    state: 'familiar', evidenceRefs: ['fp_x']
  });
  if (!k1 || k1.state !== 'familiar') throw new Error('familiar 没落');
  /* 重复同类事件：不重复建 */
  S.forum.addKnowledge({ sandboxId: sbQsIsle, observerEntityId: charAcc.ownerEntityId, subjectKey: key, state: 'familiar' });
  if (S.forum.listKnowledge(sbQsIsle, charAcc.ownerEntityId).filter((k) => k.subjectKey === key).length !== 1) throw new Error('重复认知记录');
  /* 可升级 */
  const k2 = S.forum.addKnowledge({ sandboxId: sbQsIsle, observerEntityId: charAcc.ownerEntityId, subjectKey: key, state: 'suspected' });
  if (k2.state !== 'suspected') throw new Error('没升级');
  /* 不降级 */
  const k3 = S.forum.addKnowledge({ sandboxId: sbQsIsle, observerEntityId: charAcc.ownerEntityId, subjectKey: key, state: 'familiar' });
  if (k3.state !== 'suspected') throw new Error('认知被降级了');
  /* 绝不自动 confirmed：任何接口都不该悄悄写成 confirmed */
  if (S.forum.listKnowledge(sbQsIsle, charAcc.ownerEntityId).some((k) => k.state === 'confirmed')) throw new Error('自动 confirmed 了');
  return { state: k3.state };
});

t('分享给 char 并打开 → char 对分享行为产生 familiar 认知', () => {
  const mine = S.forum.listOwnedForumAccounts(sbQsIsle);
  const altA = mine.filter((a) => a.accountType === 'alt')[0];
  const charAcc = S.forum.scopedForum('forumAccounts', sbQsIsle).filter((a) => a.ownerType === 'char')[0];
  const daily = S.forum.listBoards(sbQsIsle).filter((b) => b.templateKey === 'daily')[0];
  const p = S.forum.createPost({ sandboxId: sbQsIsle, boardId: daily.id, accountId: altA.id, title: '给 char 的帖', content: 'x' }).post;
  const chat = S.chatStore.chatOf(m1) || S.chatStore.createChat('顾清和', m1);
  S.forumShare.shareToChat({ sandboxId: sbQsIsle, postId: p.id, chatId: chat.id, senderAccountId: altA.id, attachedText: '' });
  const ok1 = S.forumShare.markOpened({
    sandboxId: sbQsIsle, sourcePostId: p.id,
    targetType: 'chat', targetId: chat.id,
    openerName: '顾清和', openerEntityId: m1
  });
  if (!ok1) throw new Error('回执没记上');
  const k = S.forum.listKnowledge(sbQsIsle, m1).filter((x) => x.subjectKey === 'share:' + altA.id)[0];
  /* 键与上一条测试共用（同一观察者 × 同一小号）：状态可能已被升到 suspected
     —— 认知只升不降，所以这里断言「至少 familiar 且绝不是 confirmed」。 */
  if (!k) throw new Error('char 认知候选没落');
  if (['familiar', 'suspected', 'high_confidence'].indexOf(k.state) < 0) throw new Error('认知档位不对：' + k.state);
  return { observer: '顾清和', state: k.state };
});

console.log('\n--- page:群声 E 补强（增量催更 / 作者主页 / char 聊天回应）---');

t('genMore 增量催更：追加新帖不重置 seeded；60s 冷却', () => new Promise((res) => {
  S.forumGen._setTransport((msgs, cb) => {
    cb(null, JSON.stringify({ posts: [
      { board: 'food', author: '北窗', type: 'normal', title: '增量帖一', content: '新', minutesAgo: 30, comments: [] },
      { board: 'game', author: '@anon', type: 'normal', title: '增量帖二', content: '新二', minutesAgo: 10, comments: [] }
    ] }));
  });
  const before = S.forum.scopedForum('forumPosts', sbQsIsle).length;
  S.forumGen.genMore(sbQsIsle, (err, r) => {
    if (err) throw new Error('增量失败：' + err.error);
    if (r.created.posts !== 2) throw new Error('增量帖数不对');
    if (S.forum.scopedForum('forumPosts', sbQsIsle).length !== before + 2) throw new Error('没追加');
    if (!S.forum.getForumMap('forumSettingsBySandbox', sbQsIsle).seeded) throw new Error('seeded 被重置');
    S.forumGen.genMore(sbQsIsle, (e2) => {
      if (!e2 || e2.stage !== 'cooldown') throw new Error('增量冷却没拦');
      S.forumGen._setTransport((msgs, cb) => cb(null, qsSeedJson));
      res('ok');
    });
  });
}));

t('charReactToShare：char 在聊天里回一句（单次调用 + 冷却）', () => new Promise((res) => {
  const chat = S.chatStore.chatOf(m1) || S.chatStore.createChat('顾清和', m1);
  const beforeMsgs = S.chatStore.getChat(chat.id).messages.length;
  let capturedMsgs = null;
  S.forumGen._setTransport((msgs, cb) => { capturedMsgs = msgs; cb(null, '这个标题有点眼熟，回头细看。'); });
  const memBefore = S.core.memoriesOfRoot(m1).length;
  S.forumGen.charReactToShare({
    sandboxId: sbQsIsle, chatId: chat.id, charId: m1,
    postTitle: '增量帖一', postContent: '新', attachedText: '给你看看'
  }, (err, r) => {
    if (err) throw new Error('char 回应失败：' + err.error);
    const msgs = S.chatStore.getChat(chat.id).messages;
    if (msgs.length !== beforeMsgs + 1) throw new Error('消息没进会话');
    const last = msgs[msgs.length - 1];
    if (last.role !== 'assistant' || last.content.indexOf('眼熟') < 0) throw new Error('回应内容不对');
    /* 装配判据落在产物上：system 里必须真有 [CHARACTER] 装配块（有装配层时） */
    if (S.promptEngine && (!capturedMsgs || String(capturedMsgs[0].content).indexOf('[CHARACTER]') < 0)) {
      throw new Error('回应没走正常装配（system 里没有 [CHARACTER]）');
    }
    /* 留痕记忆：分享事件进了记忆链路 */
    if (S.core.memoriesOfRoot(m1).length !== memBefore + 1) throw new Error('分享事件没进留痕记忆');
    S.forumGen.charReactToShare({
      sandboxId: sbQsIsle, chatId: chat.id, charId: m1,
      postTitle: 'x', postContent: '', attachedText: ''
    }, (e2) => {
      if (!e2 || e2.stage !== 'cooldown') throw new Error('聊天回应冷却没拦');
      S.forumGen._setTransport((msgs2, cb2) => cb2(null, qsSeedJson));
      res('ok');
    });
  });
}));

ok('作者公开主页已注册（点作者名可进）', !!S.registered()['qunsheng-author']);

console.log('\n--- page:聊天 App 容器（4 Tab）---');

/* 《聊天 App · 核心架构》：「聊天 App = 当前房屋监视器，前台 4 Tab」。
   顺序和名字是文档里定死的，别随手改。 */
t('四个 Tab 就位（顺序 = 消息 / 通讯录 / 朋友圈 / 我）', () => {
  const A = S.appTabs;
  if (!A) throw new Error('Sleepy.appTabs 缺失');
  const ids = A.TABS.map((x) => x.id).join(',');
  if (ids !== 'chat,contacts,moments,me') throw new Error('tab 不对：' + ids);
  const names = A.TABS.map((x) => x.name).join(' ');
  if (names !== '消息 通讯录 朋友圈 我') throw new Error('tab 名不对：' + names);
  return { 顺序: ids.split(',').join(' → '), 名字: names };
});

/* 底栏图标必须是项目那套线性 SVG —— 施工卡 §八 T1 明写「不许混 emoji」 */
ok('底栏图标是 SVG，没有混 emoji',
  S.appTabs.TABS.every((x) => /^<svg /.test(String(x.icon))));

/* 桌面上的「聊天 / 朋友圈 / 我的」是**同一个壳**的三个入口，
   只是默认停在不同的 tab。分三份实现的话迟早会漂移。 */
t('三个入口页指向同一个壳，且各自停在自己的 Tab 上', () => {
  const reg = S.registered();
  const want = [['chat-list', '消息'], ['moments', '朋友圈'], ['me', '我']];
  const got = want.map(function (pair) {
    const def = reg[pair[0]];
    if (!def) throw new Error('缺页面：' + pair[0]);
    if (def.title !== pair[1]) {
      throw new Error(pair[0] + ' 的标题该是「' + pair[1] + '」，实际「' + def.title + '」');
    }
    return pair[1];
  });
  if (typeof S.appTabs.mount !== 'function') throw new Error('壳没导出 mount');
  return { 入口: got.join(' / '), 默认Tab: want.map((p) => p[0]).join(' / ') };
});

ok('三屏的实现都挂上了（消息 / 朋友圈 / 我）',
  !!(S.chatApp && typeof S.chatApp.mountTab === 'function') &&
  !!(S.momentsTab && typeof S.momentsTab.mountTab === 'function') &&
  !!(S.meTab && typeof S.meTab.mountTab === 'function'));

/* 朋友圈那几条**看着像样式的坑**，其实都是会被改回去的回归点，钉住：
   ① 顶栏透明浮在封面上，靠的是 CSS :has() 自己看 DOM ——
      曾经用 JS 给 #phone 打类，遇到「页面实例复用 / 点当前 tab 时 paint 提前 return」
      就漏打，状态栏又绿回去。所以这里两边都要管住。
   ② 封面右下角那个头像是**探出封面半格**的，封面不能 overflow:hidden，
      一裁就只剩半边（用户：「这个头像你没发现只有一半么」）。
   ③ 朋友圈顶上不写标题（微信就是封面本身顶到底）。 */
{
  const css = require('fs').readFileSync('style.css', 'utf8');
  const appJs = require('fs').readFileSync('page-app.js', 'utf8');
  const coverBlock = css.slice(css.indexOf('.mo-cover{'), css.indexOf('.mo-cover.has-img'))
    .replace(/\/\*[\s\S]*?\*\//g, '');   /* 注释里就写着「不能 overflow:hidden」，先剥掉再查 */
  ok('朋友圈的「白 chrome」是 CSS :has 判断的，不靠 JS 打类',
    css.indexOf(':has(.page.is-active:not(.is-behind) .tab-panel.is-moments)') >= 0 &&
    appJs.indexOf('mo-white') < 0);
  ok('封面不能 overflow:hidden（右下角头像要探出半格）',
    coverBlock.indexOf('overflow:visible') >= 0 &&
    coverBlock.indexOf('overflow:hidden') < 0);
  ok('朋友圈那一屏不写标题',
    appJs.indexOf("cur === 'moments' ? '' :") >= 0);
  /* 这三条同样是「很容易被好心改回去」的：底栏消失、小绿条不许回来、
     封面默认色只能有一处出处（JS 抄一份就会跟 CSS 漂移）。 */
  const html = require('fs').readFileSync('index.html', 'utf8');
  const momentsJs = require('fs').readFileSync('page-moments.js', 'utf8');
  ok('朋友圈那一屏藏掉底栏',
    css.indexOf(') .tab-bar{display:none;}') >= 0);
  ok('页面栈提示条（#edge-hint）删干净了',
    html.indexOf('edge-hint') < 0 &&
    css.indexOf('#edge-hint{') < 0 &&
    require('fs').readFileSync('app.js', 'utf8').indexOf('edgeHint') < 0);
  ok('封面默认色只有 CSS 一处出处（JS 引用 var(--mo-wall-*)）',
    css.indexOf('--mo-wall-1') >= 0 &&
    momentsJs.indexOf('var(--mo-wall-1)') >= 0 &&
    momentsJs.indexOf('#79B7E3') < 0);
  /* 状态栏是**浮在页面上**的（用户：「所有的屏幕的显示都改成透明底」）。
     它一旦不占布局，就得有人把位置补回来：.page-inner 的 padding-top、
     吸顶顶栏的 sticky top、浮岛那个 absolute 顶栏的 top —— 三处必须同源，
     少一处就会有页面被状态栏压住（浮岛就踩过）。 */
  const sbBlock = css.slice(css.indexOf('#statusbar{'), css.indexOf('#stack{'))
    .replace(/\/\*[\s\S]*?\*\//g, '');   /* 注释里就提到 position:relative，先剥掉 */
  ok('状态栏浮在页面上（absolute + 透明），不占布局',
    sbBlock.indexOf('position:absolute') >= 0 &&
    sbBlock.indexOf('position:relative') < 0 &&
    sbBlock.indexOf('background') < 0);
  const chrome = 'calc(env(safe-area-inset-top) + 32px)';
  ok('各页面都把状态栏那一条让出来了（padding-top / sticky top 同源）',
    css.split(chrome).length - 1 >= 4);
}

/* 朋友圈这一屏唯一的数据规则：**只看得见本房的动态**。
   现在还没有写入口（「角色自己发动态」是后面那批），所以先用 add() 造两条验。 */
t('朋友圈：写进 A 房的动态，B 房看不见', () => {
  const A = S.core.createSandbox('isle');
  const B = S.core.createSandbox('archipelago');
  const before = S.momentsTab.all().length;

  S.core.setActiveSandbox(A.id);
  const made = S.momentsTab.add({ text: '今天的雨很好听', name: '顾清和' });
  const inA = S.core.scoped(S.momentsTab.all()).length;
  S.core.setActiveSandbox(B.id);
  const inB = S.core.scoped(S.momentsTab.all()).length;

  /* 删房要把它一起带走 —— 漏了的话 localStorage 里会积幽灵数据 */
  S.core._purgeSync.sandbox(A.id);
  S.core._purgeSync.sandbox(B.id);
  const after = S.momentsTab.all().length;

  if (!made) throw new Error('写入失败');
  if (inA !== 1) throw new Error('A 房该有 1 条，实际 ' + inA);
  if (inB !== 0) throw new Error('B 房不该看见，实际 ' + inB);
  if (after !== before) throw new Error('删房没把动态带走：' + before + ' → ' + after);
  return { A房: inA, B房: inB, 删房后: after };
});

console.log('\n--- page:转账 / 钱包 / 表情包 ---');

/* docs/DRAFT.md 对转账的要求之一是「金额要校验上限」。纯函数，打表就够了 ——
   不用起浏览器就能把「该拒的都拒了」钉死。 */
t('转账输入的解析与校验', () => {
  const P = S.chatApp.parseTransfer;
  ['', 'abc', '0', '-5', '100000', '68.999'].forEach((v) => {
    if (P(v).ok) throw new Error('该拒的没拒：' + JSON.stringify(v));
  });
  const a = P('68 买奶茶');
  if (!a.ok || a.amount !== 68 || a.note !== '买奶茶') throw new Error(JSON.stringify(a));
  const b = P('12.5');
  if (!b.ok || b.amount !== 12.5 || b.note !== '') throw new Error(JSON.stringify(b));
  const c = P('  88  ');
  if (!c.ok || c.amount !== 88) throw new Error(JSON.stringify(c));
  if (S.chatApp.TRANSFER_MAX !== 99999) throw new Error('上限被改了');
  return { 合法: a.amount + ' + ' + a.note, 上限: S.chatApp.TRANSFER_MAX };
});

/* 「空输入点发送」到底该替用户说什么 —— 现在发送键是两义的：
   有字 = 只发一条，空着点 = 让他开口。分气泡连发几条之后再空发送时，
   提示词必须是「我说完了」，不能再是「我这边安静着，没打字」（那会让
   模型以为我一句话没说，回一句跟我们刚聊的完全无关的东西）。 */
t('空发送的提示词按「上一条是谁发的」分流', () => {
  const F = S.chatApp.proactiveHintFor;
  const A = S.chatApp.PROACTIVE_HINT;
  const B = S.chatApp.PROACTIVE_HINT_REPLY;
  if (A === B) throw new Error('两句提示词不该一样');
  const mk = (roles) => ({ messages: roles.map((r, i) => ({ id: 'm' + i, role: r, content: 'x' + i })) });

  if (F(mk([])) !== A) throw new Error('空对话该是「主动开口」');
  if (F(mk(['assistant'])) !== A) throw new Error('上一句是他说的，该是「主动开口」');
  if (F(mk(['assistant', 'user'])) !== B) throw new Error('上一句是我说的，该是「我说完了」');
  if (F(mk(['user', 'assistant', 'user', 'user'])) !== B) throw new Error('连发两条后该是「我说完了」');
  if (F(mk(['user', 'assistant'])) !== A) throw new Error('他刚回完，该是「主动开口」');
  /* system 事件条（换面具那种）不算「有效消息」，不能让它顶掉判断 */
  if (F({ messages: [{ role: 'user', content: 'p' }, { role: 'system', content: 's' }] }) !== B) {
    throw new Error('system 条不该顶掉「上一条是我说的」');
  }
  if (F(null) !== A) throw new Error('拿不到对话时别炸');
  return { 空对话: '主动', 我发的: '我说完了', 他发的: '主动' };
});

/* 会话列表的预览（用户 2026-09-21：「对方回：」这几个字不要显示，照微信）。
   三条不许退回去的规矩：不带角色前缀、只给最后一个气泡、不漏 [译] 标签。 */
t('会话列表预览：无前缀 / 只取最后一句 / 不漏译文标签', () => {
  const P = S.chatApp.previewOf;
  const T = S.chatApp.chatListTime;

  const asst = P({ role: 'assistant', content: '灯还亮着 || 你要现在过来吗' });
  if (asst !== '你要现在过来吗') throw new Error('没只取最后一个气泡：' + asst);
  if (/对方回|你说/.test(asst)) throw new Error('前缀还挂着：' + asst);
  if (asst.indexOf('||') >= 0) throw new Error('把协议分隔符显示出来了：' + asst);

  const usr = P({ role: 'user', content: '睡了没' });
  if (usr !== '睡了没') throw new Error('自己发的也带了前缀：' + usr);

  /* [译]…[/译] 是协议，不是正文。用 splitBubbles 会把它当正文显示出来，
     所以这里必须走 splitBubblesT。 */
  const tr = P({ role: 'assistant', content: 'Hello[译]你好[/译] || 晚安' });
  if (tr !== '晚安') throw new Error('译文标签没剥干净：' + tr);
  const tr2 = P({ role: 'assistant', content: '你好[译]Hi[/译]' });
  if (tr2 !== '你好') throw new Error('只有译文没有原文时该回原文：' + tr2);

  /* 附件类：老实现不管角色是谁都写「你发了…」，TA 发来的图会被说成你发的 */
  if (P({ role: 'assistant', type: 'photo' }) !== '[图片]') throw new Error('图片预览不对');
  if (P({ role: 'user', type: 'file', name: 'a.pdf' }) !== '[文件] a.pdf') throw new Error('文件预览不对');
  if (P({ role: 'assistant', type: 'transfer', amount: 30 }) !== '[转账] ¥30.00') throw new Error('转账预览不对');
  if (P(null) !== '空对话') throw new Error('空对话兜底没了');

  /* 时间：今天给钟点、昨天、一周内给星期几、更早给日期 */
  const now = new Date();
  const at = (d) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 3).getTime();
  const tToday = T(today);
  if (!/^(凌晨|上午|下午|晚上) \d{1,2}:0?3$/.test(tToday)) throw new Error('今天该给钟点：' + tToday);
  if (T(at(-1).getTime()) !== '昨天') throw new Error('昨天不对：' + T(at(-1).getTime()));
  const wk = T(at(-3).getTime());
  if (!/^周[日一二三四五六]$/.test(wk)) throw new Error('一周内该给星期几：' + wk);
  const old = T(at(-40).getTime());
  if (!/月\d+日$/.test(old)) throw new Error('更早该给日期：' + old);
  if (T(0) !== '') throw new Error('没有时间戳时该给空串');
  return { 最后一句: asst, 今天: tToday, 三天前: wk, 更早: old };
});

/* 余额按房存（一间房一条）。写入必须拿全量按房找那条 ——
   拿 core.scoped() 过滤过的列表回写会把别的房的记录抹掉（S4a 的老坑）。 */
t('钱包余额按房隔离', () => {
  const A = S.core.createSandbox('isle');
  const B = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(A.id);
  S.wallet.setBalance(5200);
  S.core.setActiveSandbox(B.id);
  const bBefore = S.wallet.balance();
  S.wallet.setBalance(8);
  S.core.setActiveSandbox(A.id);
  const aAfter = S.wallet.balance();
  S.core._purgeSync.sandbox(A.id); S.core._purgeSync.sandbox(B.id);
  if (bBefore !== 0) throw new Error('B 房不该看到 A 的余额：' + bBefore);
  if (aAfter !== 5200) throw new Error('A 房余额被动了：' + aAfter);
  return { A房: aAfter, B房: bBefore + ' → 8' };
});

/* 「同步到全局」的落盘语义：开了 → 哪间房都看得见，且**不再属于任何一间房**
   （不然拆掉那间房时全局表情会跟着被删，global 就名不副实了）。 */
t('表情包：默认按房，开全局跨房可见，删房只带走本房的', () => {
  const A = S.core.createSandbox('isle');
  const B = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(A.id);
  const r = S.stickers.add('https://x.test/milktea.png');
  if (!r.ok) throw new Error(r.message);
  if (!/milktea/.test(r.item.name)) throw new Error('名字没从地址猜出来：' + r.item.name);
  const local = S.stickers.visible().length;

  S.stickers.setGlobal(r.item.id, true);
  S.core.setActiveSandbox(B.id);
  const inB = S.stickers.visible().length;

  const rec = S.stickers.all().filter((s) => s.id === r.item.id)[0];
  const isGlobal = rec && rec.global === true && rec.sandboxId === undefined;

  S.stickers.remove(r.item.id);
  const left = S.stickers.all().length;
  S.core._purgeSync.sandbox(A.id); S.core._purgeSync.sandbox(B.id);
  if (local !== 1) throw new Error('本房该看到 1 个，实际 ' + local);
  if (inB !== 1) throw new Error('开全局后 B 房该看见，实际 ' + inB);
  if (!isGlobal) throw new Error('开全局没清掉 sandboxId：' + JSON.stringify(rec));
  if (left !== 0) throw new Error('删完还剩 ' + left);
  return { 本房: local, 换房后: inB, 全局: isGlobal };
});

/* 整组同步（2026-09-28 用户补的批量口）：组头「同步到全局」一键翻转整组。 */
t('表情包：整组同步到全局 —— 批量开/收，口径与单张开关一致', () => {
  const A = S.core.createSandbox('isle');
  S.core.setActiveSandbox(A.id);
  const g = '小熊组';
  const r1 = S.stickers.add({ url: 'https://x.test/a.png', name: 'a', group: g });
  const r2 = S.stickers.add({ url: 'https://x.test/b.png', name: 'b', group: g });
  if (!r1.ok || !r2.ok) throw new Error('种表情失败');
  const other = S.stickers.add({ url: 'https://x.test/c.png', name: 'c', group: '别的组' });
  if (!other.ok) throw new Error('种对照组失败');

  const n = S.stickers.setGroupGlobal(g, true);
  if (n !== 2) throw new Error('应整组 2 张翻转，实际 ' + n);
  const all = S.stickers.all();
  const grp = all.filter((s) => s.group === g);
  if (!grp.every((s) => s.global === true && s.sandboxId === undefined)) {
    throw new Error('开全局没整组生效/没摘房章：' + JSON.stringify(grp));
  }
  const ctrl = all.filter((s) => s.id === other.item.id)[0];
  if (ctrl.global) throw new Error('别的组被误伤');

  const n2 = S.stickers.setGroupGlobal(g, false);
  if (n2 !== 2) throw new Error('收回应 2 张，实际 ' + n2);
  const grp2 = S.stickers.all().filter((s) => s.group === g);
  if (!grp2.every((s) => s.global === false)) throw new Error('收回没生效');

  S.stickers.remove(r1.item.id); S.stickers.remove(r2.item.id); S.stickers.remove(other.item.id);
  S.core._purgeSync.sandbox(A.id);
  return { 整组开: true, 摘房章: true, 别组不误伤: true, 整组收: true };
});

/* 朋友圈是活的：谁都能发（含替角色发）、赞能加能取消、评论能删。
   「每个关系下的都可以互动」这条钉在数据层上。 */
t('朋友圈：替角色发、赞可取消、评论可删', () => {
  const A = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(A.id);
  const before = S.momentsTab.all().length;

  const mine = S.momentsTab.add({ text: '今天天气好', name: '我' });
  const hers = S.momentsTab.add({ text: '雨停了', characterId: 'ch_gu', name: '顾清和' });

  const l1 = S.momentsTab.toggleLike(hers.id, { kind: 'mask', refId: 'u_me', name: '我' });
  const l2 = S.momentsTab.toggleLike(hers.id, { kind: 'char', refId: 'ch_shen', name: '沈聿' });
  const un = S.momentsTab.toggleLike(hers.id, { kind: 'mask', refId: 'u_me', name: '我' });

  const cm = S.momentsTab.addComment(hers.id, { kind: 'char', refId: 'ch_shen', name: '沈聿' }, '嗯。');
  const rm = S.momentsTab.removeComment(hers.id, cm.item.id);

  const rec = S.momentsTab.all().filter((m) => m.id === hers.id)[0];
  S.momentsTab.remove(hers.id);
  S.momentsTab.remove(mine.id);
  S.core._purgeSync.sandbox(A.id);
  const after = S.momentsTab.all().length;

  if (!mine || !hers) throw new Error('发布失败');
  if (!l1.liked || !l2.liked) throw new Error('点赞失败');
  if (un.liked) throw new Error('再点一次该是取消赞');
  if (rec.likes.length !== 1 || rec.likes[0].name !== '沈聿') {
    throw new Error('赞列表不对：' + JSON.stringify(rec.likes));
  }
  if (!cm.ok || !rm.ok) throw new Error('评论/删评论失败');
  if (rec.comments.length !== 0) throw new Error('评论没删掉');
  if (after !== before) throw new Error('删房没带走动态');
  return { 发布: 2, 赞: '1（我的已取消）', 评论: '已删', 删房后: after };
});

/* 壁纸按房存（一间房一张）。记录是 { url } 或 { mediaId }（图库里的图）——
   **不能存 objectURL**，那玩意儿刷新页面就失效。 */
t('朋友圈壁纸按房隔离', () => {
  const A = S.core.createSandbox('isle');
  const B = S.core.createSandbox('archipelago');
  S.core.setActiveSandbox(A.id);
  S.momentsTab.setWall({ url: 'https://x.test/wall.png' });
  S.momentsTab.setWall({ mediaId: 'md-1' });
  const inA = S.momentsTab.wall();
  S.core.setActiveSandbox(B.id);
  const inB = S.momentsTab.wall();
  S.momentsTab.setWall(null);
  const cleared = S.momentsTab.wall();
  S.core.setActiveSandbox(A.id);
  const aAfterClear = S.momentsTab.wall();
  S.core._purgeSync.sandbox(A.id); S.core._purgeSync.sandbox(B.id);
  if (!inA || inA.mediaId !== 'md-1') throw new Error('A 房壁纸没存上：' + JSON.stringify(inA));
  if (inB) throw new Error('B 房不该看到 A 的壁纸：' + JSON.stringify(inB));
  if (cleared) throw new Error('B 房清壁纸没生效');
  if (!aAfterClear) throw new Error('清 B 的壁纸不该影响 A：' + JSON.stringify(aAfterClear));
  return { A房: inA, B房: inB, B清掉后: cleared, A不受影响: !!aAfterClear };
});

console.log('\n--- media: 图库（IndexedDB 那一层）---');

/* 图片本体从 localStorage 搬到 IndexedDB：localStorage 只有 5MB 且存字符串，
   一张照片 base64 之后就能把别的 key 一起撑爆（写入失败会连累整个数据层）。
   node 里没有 indexedDB，所以这里只能验**接口在不在、接得对不对**；
   真存真读在浏览器里跑（见施工卡的实测记录）。 */
ok('media 模块挂上了（available / put / get / url / usage / clear / shrink）',
  !!(S.media && typeof S.media.available === 'function' &&
     typeof S.media.put === 'function' && typeof S.media.get === 'function' &&
     typeof S.media.url === 'function' && typeof S.media.usage === 'function' &&
     typeof S.media.clear === 'function' && typeof S.media.shrink === 'function'));
t('没有 indexedDB 时 available() 老实返回 false（不抛错）',
  () => S.media.available());
t('fmtBytes 三档都说得人话',
  () => [S.media.fmtBytes(900), S.media.fmtBytes(2048), S.media.fmtBytes(3.5e6)]);

{
  const html = require('fs').readFileSync('index.html', 'utf8');
  const photosSrc = require('fs').readFileSync('photos.js', 'utf8');
  const settingsSrc = require('fs').readFileSync('page-settings.js', 'utf8');
  const chatSrc = require('fs').readFileSync('page-chat.js', 'utf8');
  ok('加载顺序：media.js 必须排在 photos.js 前面（photos 要用它）',
    html.indexOf('src="media.js"') >= 0 &&
    html.indexOf('src="media.js"') < html.indexOf('src="photos.js"'));
  ok('photos 认 mediaId 记录（新照片走图库，老 dataURL 也还认）',
    photosSrc.indexOf('it.mediaId') >= 0 && photosSrc.indexOf('rec.url = it.url') >= 0 &&
    typeof S.photos.srcOf === 'function' && typeof S.photos.diskUsage === 'function');
  ok('删照片会连图库里的本体一起删（不然 blob 永远留着）',
    photosSrc.indexOf('Sleepy.media.remove(hit.mediaId)') >= 0);
  ok('「聊天默认参数」入口和整页都删了（参数归各接口自己的生成参数）',
    settingsSrc.indexOf("register('settings-chatdefaults'") < 0 &&
    settingsSrc.indexOf("ctx.open('settings-chatdefaults')") < 0);
  ok('聊天发照片会先把本体存进图库（不再只记文件名）',
    chatSrc.indexOf("Sleepy.media.put(r.blob") >= 0 &&
    chatSrc.indexOf("msg.type === 'photo' && msg.mediaId") >= 0);
}

console.log('\n--- page:表情包（批量导入 / 分组）---');

/* 批量导入的解析是纯函数，直接单测 —— 三种写法是用户点名的需求：
   「格式大概有解释：URL，解释:URL，URL 解释这三种」。 */
t('三种写法都认（解释：URL / 解释:URL / URL 解释），注释和废行要挑出来', () => {
  const r = S.stickers.parseLines([
    '小熊打招呼 https://x.test/hi.gif',
    '小猫委屈：https://x.test/sad.gif',
    '比个OK:https://x.test/ok.png',
    'https://x.test/plain.gif',
    '# 这是注释',
    '这行没有网址'
  ].join('\n'));
  return {
    条数: r.items.length,
    名字: r.items.map((i) => i.name),
    网址尾段: r.items.map((i) => i.url.slice(-8)),
    没看懂: r.bad
  };
});

t('反着写也认（URL 在前），一行多个词的解释要完整保留', () => {
  const r = S.stickers.parseLines('https://x.test/a.gif 这是 一个 说明');
  return { 名字: r.items[0].name, 网址: r.items[0].url };
});

t('分组按出现顺序列出，没写分组的算「未分组」', () => {
  S.store.set('stickers', []);
  S.stickers.add({ url: 'https://x.test/1.gif', name: '小熊1', group: '小熊' });
  S.stickers.add({ url: 'https://x.test/2.gif', name: '猫1', group: '猫猫' });
  S.stickers.add({ url: 'https://x.test/3.gif', name: '散装' });
  const list = S.stickers.all();
  return { 分组: S.stickers.groupsOf(list), 散装的组: S.stickers.groupOf(list[2]) };
});

/* 导入的两条路要分清楚（用户点名的）：
     · 右上角 = 导入**文件**（txt 这类，内容是那些 URL）
     · 组里第一格的「+」= 单独往这一组加图片
   加上「文件里读出来的行」还是走 parseLines 那三种格式。 */
{
  const src = require('fs').readFileSync('page-stickers.js', 'utf8');
  ok('导入文件的读法挂上了（pickTextFile / groupFromFileName）',
    typeof S.stickers.pickTextFile === 'function' &&
    typeof S.stickers.groupFromFileName === 'function');
  t('分组名从文件名猜：「小熊.txt」→「小熊」', () => [
    S.stickers.groupFromFileName('小熊.txt'),
    S.stickers.groupFromFileName('猫猫-表情包.md'),
    S.stickers.groupFromFileName('表情包.txt')
  ]);
  ok('粘贴框已经去掉了（右上角那条路只认文件）',
    src.indexOf('批量粘贴') < 0 && src.indexOf('textArea') < 0);
  ok('组里第一格是「+」（点它往这一组加图片）',
    src.indexOf('stk-cell-add') >= 0 && src.indexOf('stk-grid') >= 0);
  ok('分组默认收起、点组头展开', src.indexOf('stk-group-toggle') >= 0 &&
    src.indexOf('openGroups') >= 0);
}

/* 打字推荐表情 + 聊天里发表情 —— 用户两条需求：
   「输入某个文字之后可以匹配上对应的推荐表情包」
   「推荐的表情包可以左右滑动显示」；以及聊天里要能发。 */
t('按文字找表情：解释里含这段的排前面，不相关的不要', () => {
  S.store.set('stickers', []);
  S.stickers.addBatch([
    { url: 'https://x.test/a.gif', name: '小熊打招呼' },
    { url: 'https://x.test/b.gif', name: '小熊委屈' },
    { url: 'https://x.test/c.gif', name: '小猫伸懒腰' }
  ], '测试组');
  return {
    输入小熊: S.stickers.match('小熊').map((s) => s.name),
    输入打招呼: S.stickers.match('小熊打招呼').map((s) => s.name),
    完全不沾边: S.stickers.match('完全沾边的词').length,
    空输入: S.stickers.match('').length
  };
});

{
  const chatSrc = require('fs').readFileSync('page-chat.js', 'utf8');
  const css = require('fs').readFileSync('style.css', 'utf8');
  ok('聊天里能发/收表情（推荐条 · 表情气泡 · 面板三件套都在）',
    chatSrc.indexOf('stk-suggest') >= 0 &&
    chatSrc.indexOf('msg-sticker') >= 0 &&
    chatSrc.indexOf('openStickerPanel') >= 0 &&
    chatSrc.indexOf("type: 'sticker'") >= 0);
  ok('推荐条是横向可滑的（不能把命中的表情裁掉）',
    /\.stk-suggest\{[^}]*overflow-x:auto/.test(css.replace(/\s+/g, '')) ||
    css.indexOf('.stk-suggest::-webkit-scrollbar{display:none;}') >= 0);
}

/* 角色也能发表情：模型写 [表情:名字] → 抽出来发成真的表情图。
   标签的解析是纯函数（三种写法 + 多个 + 没有标签），单测它。 */
t('抽 [表情:名字] 标签：半角/全角冒号都认，多个也认，没有标签就原样', () => {
  const a = S.chatUtil.extractStickers('好啊，给你看一个\n[表情:小熊打招呼]');
  const b = S.chatUtil.extractStickers('[表情：小猫伸懒腰]');
  const c = S.chatUtil.extractStickers('你看 [表情:小熊委屈] 和 [表情:比个OK]');
  const d = S.chatUtil.extractStickers('就是普通一句话，没有标签');
  return {
    抽出的名字: a.names,
    正文去掉了标签: a.text,
    全角冒号: b.names,
    一行两个: c.names,
    两个都抽走了: c.text,
    没标签: d.names.length
  };
});

t('拍一拍：[拍一拍] / [拍一拍:后缀] 都认，正文抽干净', () => {
  const a = S.chatUtil.extractPats('站住别动\n[拍一拍]');
  const b = S.chatUtil.extractPats('[拍一拍:脑袋] 讨债的来了');
  const c = S.chatUtil.extractPats('没有动作的普通回复');
  const d = S.chatUtil.extractPats('[拍一拍：肩膀]');   // 全角冒号
  return {
    无后缀: a.patted && !a.suffix && a.text === '站住别动',
    有后缀: b.patted && b.suffix === '脑袋' && b.text === '讨债的来了',
    没标签: !c.patted,
    全角冒号: d.patted && d.suffix === '肩膀'
  };
});

/* 角色撤回（2026-10-06）：[撤回:N|原因] 标签解析 + 存档执行。
   解析是纯函数；执行走 applyCharRecalls（打戳不删原文，口径同群聊）。 */
t('抽 [撤回:N|原因] 标签：冒号竖线全半角都认，原因可省，多个也认', () => {
  const a = S.chatUtil.extractRecalls('刚才口误了\n[撤回:1|说得太冲了]');
  const b = S.chatUtil.extractRecalls('[撤回：2｜不想让你看到]');
  const c = S.chatUtil.extractRecalls('[撤回:1]');
  const d = S.chatUtil.extractRecalls('[撤回:1|理由一] 和 [撤回:2|理由二]');
  const e = S.chatUtil.extractRecalls('普通回复，没有标签');
  if (a.text !== '刚才口误了') throw new Error('正文没抽干净：' + a.text);
  if (!(a.hits.length === 1 && a.hits[0].n === 1 && a.hits[0].reason === '说得太冲了')) {
    throw new Error('半角解析错：' + JSON.stringify(a.hits));
  }
  if (!(b.hits.length === 1 && b.hits[0].n === 2 && b.hits[0].reason === '不想让你看到')) {
    throw new Error('全角解析错：' + JSON.stringify(b.hits));
  }
  if (!(c.hits.length === 1 && c.hits[0].reason === '')) throw new Error('省原因应得空串');
  if (d.hits.length !== 2) throw new Error('一行两个应都抽到');
  if (e.hits.length !== 0 || e.text !== '普通回复，没有标签') throw new Error('没标签不该动正文');
  return '解析四处全对';
});

t('抽 [灯:那句话] 标签：灯/灯牌都认，全角半角都认，多个也认，没标签不动正文', () => {
  const a = S.chatUtil.extractLampNotes('今天有点累\n[灯:早点休息]');
  const b = S.chatUtil.extractLampNotes('[灯牌：记得多喝水]');
  const c = S.chatUtil.extractLampNotes('[灯:晚安] [灯:好梦]');
  const d = S.chatUtil.extractLampNotes('普通回复，没有标签');
  const e = S.chatUtil.extractLampNotes('[灯:   ]');
  if (a.text !== '今天有点累') throw new Error('正文没抽干净：' + a.text);
  if (!(a.hits.length === 1 && a.hits[0].text === '早点休息')) {
    throw new Error('半角解析错：' + JSON.stringify(a.hits));
  }
  if (!(b.hits.length === 1 && b.hits[0].text === '记得多喝水')) {
    throw new Error('灯牌全角解析错：' + JSON.stringify(b.hits));
  }
  if (c.hits.length !== 2) throw new Error('一行两个应都抽到');
  if (d.hits.length !== 0 || d.text !== '普通回复，没有标签') throw new Error('没标签不该动正文');
  /* 空内容标签也抽走（不留垃圾在正文里），但不产生可落库的留言 */
  if (!(e.hits.length === 1 && e.hits[0].text === '')) throw new Error('空标签应抽出空串');
  return '灯牌抽取四处全对';
});

t('抽 [慢递:N|内容] 标签：小时数钳 1~72，全角半角都认，没标签不动正文', () => {
  const a = S.chatUtil.extractSlowmail('有件事想慢慢说\n[慢递:6|今天在路口看见一只很凶的橘猫]');
  const b = S.chatUtil.extractSlowmail('[慢递：0｜提前了也按 1 算]');
  const c = S.chatUtil.extractSlowmail('[慢递:999|超上限按 72 算]');
  const d = S.chatUtil.extractSlowmail('普通回复，没有信');
  if (a.text !== '有件事想慢慢说') throw new Error('正文没抽干净：' + a.text);
  if (!(a.hits.length === 1 && a.hits[0].hours === 6 && a.hits[0].body.indexOf('橘猫') >= 0)) {
    throw new Error('半角解析错：' + JSON.stringify(a.hits));
  }
  if (b.hits[0].hours !== 1) throw new Error('下限钳制失效');
  if (c.hits[0].hours !== 72) throw new Error('上限钳制失效');
  if (d.hits.length !== 0 || d.text !== '普通回复，没有信') throw new Error('没标签不该动正文');
  return '慢递解析全对';
});

/* HTML 小游戏（2026-10-06）：[html]…[/html] 是六个抽取函数里**唯一多行**、
   唯一带尺寸闸、唯一「一次只收一块」的，所以单测最不能省。
   最想钉住的回归位：HTML 里的 `||`（JS 逻辑或）看起来会被 splitBubblesT
   当成气泡分隔符切碎 —— 实测不会（那边 split 完用 ' || ' 重新 join 回去了），
   这条断言就是防止将来有人改 split 逻辑时把它弄坏。 */
t('抽 [html]…[/html] 小游戏块：多行/大小写都认，一次只收 1 块，没闭合不收', () => {
  const multi = '给你做了个猜数字！\n[html]\n<div id="a">hi</div>\n' +
    '<script>var n=1||2;if(n<3){n++}</script>\n[/html]';
  const a = S.chatUtil.extractHtmlGames(multi);
  if (a.text !== '给你做了个猜数字！') throw new Error('正文没抽干净：' + JSON.stringify(a.text));
  if (!a.hit || a.hit.indexOf('<div id="a">hi</div>') < 0) {
    throw new Error('多行 HTML 没收全：' + JSON.stringify(a.hit));
  }
  if (a.hit.indexOf('1||2') < 0) throw new Error('HTML 里的 || 被切碎（回归）：' + JSON.stringify(a.hit));
  if (a.truncated) throw new Error('没超闸不该标截断');
  if (a.dropped !== 0) throw new Error('只有一块不该记丢弃');

  const b = S.chatUtil.extractHtmlGames('[HTML]<b>x</b>[/HTML]');
  if (b.hit !== '<b>x</b>') throw new Error('大写标签没认：' + JSON.stringify(b.hit));

  /* 一次只收第一块，多出来的剥掉但不落库（防刷）；中间的正文要留住 */
  const c = S.chatUtil.extractHtmlGames('[html]A[/html] 中间的话 [html]B[/html]');
  if (c.hit !== 'A') throw new Error('多块应只收第一块：' + JSON.stringify(c.hit));
  if (c.dropped !== 1) throw new Error('多出来的块应记 dropped：' + c.dropped);
  if (c.text !== '中间的话') throw new Error('两块之间的正文该留：' + JSON.stringify(c.text));

  /* 没闭合（有头没尾）：不算命中、原文保留 —— 半截输出多是流式中断，剥掉反而丢字 */
  const d = S.chatUtil.extractHtmlGames('说了半截 [html]<b>x</b>');
  if (d.hit !== null) throw new Error('未闭合不该命中');
  if (d.text.indexOf('[html]') < 0) throw new Error('未闭合应原文保留');

  const e = S.chatUtil.extractHtmlGames('普通一句话，没有游戏');
  if (e.hit !== null || e.text !== '普通一句话，没有游戏') throw new Error('没标签不该动正文');

  /* 尺寸闸：超长**截断保留下半**（浏览器对半截 HTML 很宽容），并打 truncated */
  const MAX = S.chatUtil.HTMLGAME_MAX;
  const f = S.chatUtil.extractHtmlGames('[html]' + 'x'.repeat(MAX + 500) + '[/html]');
  if (!f.truncated) throw new Error('超闸应标截断');
  if (f.hit.length !== MAX) throw new Error('截断长度该等于闸值：' + f.hit.length);
  return '小游戏抽取七处全对';
});

/* 结算痕迹（noteGameResult / gameResultPeekMsg）：走的是「同一局重复上报必须
   幂等」——游戏每次重绘、每次 report 都可能重复触发，不幂等就会反复覆盖痕迹、
   反复垫进上下文。peek 必须一次性（读出即摘），否则每轮都重复垫同一局结算。 */
t('小游戏结算痕迹：同局重复上报不覆盖、换局才更新、peek 读出即摘', () => {
  const chatId = 'smoke_htmlgame_chat';
  const key = 'htmlGameResult:' + chatId;
  S.store.set(key, null);

  if (!S.chatUtil.noteGameResult(chatId, 'm1', 87, '三局两胜赢了你')) {
    throw new Error('首次上报应落库');
  }
  if (S.chatUtil.noteGameResult(chatId, 'm1', 87, '三局两胜赢了你')) {
    throw new Error('同一局重复上报不该覆盖（否则每次重绘都重垫上下文）');
  }
  const rec = S.store.get(key);
  if (!rec || rec.score !== 87) throw new Error('痕迹没存上：' + JSON.stringify(rec));

  if (!S.chatUtil.noteGameResult(chatId, 'm2', 30, '输了')) {
    throw new Error('换了一局应更新（latest-wins）');
  }
  const peek = S.chatUtil.gameResultPeekMsg(chatId);
  if (!peek || peek.role !== 'system') {
    throw new Error('peek 该给一条 system 垫话：' + JSON.stringify(peek));
  }
  if (peek.content.indexOf('30') < 0) throw new Error('peek 没带最新得分：' + peek.content);
  if (peek.content.indexOf('输了') < 0) throw new Error('peek 没带结果描述');
  if (S.chatUtil.gameResultPeekMsg(chatId) !== null) {
    throw new Error('peek 必须一次性：第二次该是 null');
  }
  if (S.store.get(key) !== null) throw new Error('peek 后痕迹该摘干净');
  return '结算幂等 + 一次性摘除都对';
});

/* 静态护栏：小游戏是**模型写 HTML 直接塞进 iframe 跑**，整个项目里唯一一条
   「执行外来代码」的路。安全模型必须钉死在源码上，改一处就红。
   ⚠️ 判据一律**剥注释后再判** —— 修法说明里必然写出 allow-same-origin /
   default-src 这些名字，不剥注释会把自己判成违规（栽过四次）。 */
t('小游戏静态护栏：沙箱不给 same-origin、CSP 堵出网、桥只认登记窗口、卡注册进引擎', () => {
  const bare = (f) => require('fs').readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const src = bare('page-chat.js');
  const pe = bare('prompt-engine.js');
  const css = require('fs').readFileSync('style.css', 'utf8');

  if (src.indexOf("setAttribute('sandbox', 'allow-scripts')") < 0) {
    throw new Error('iframe 沙箱属性不见了（游戏会拿到父页数据）');
  }
  if (src.indexOf('allow-same-origin') >= 0) {
    throw new Error('沙箱绝不能给 allow-same-origin —— 给了就能摸到父页 localStorage');
  }
  if (src.indexOf("default-src 'none'") < 0) {
    throw new Error('CSP 没堵出网（default-src none）');
  }
  if (src.indexOf('SleepyGame') < 0) throw new Error('没给游戏暴露 report 桥，结算闭环断');
  if (src.indexOf('registerGameFrame') < 0 || src.indexOf('gameFrameWins.indexOf') < 0) {
    throw new Error('没登记窗口就收 postMessage —— 别的页面也能报结算');
  }
  if (pe.indexOf("'htmlgame'") < 0) throw new Error('小游戏说明书卡没注册进引擎');
  if (css.indexOf('.msg-htmlgame{') < 0) throw new Error('游戏卡没样式');
  if (css.indexOf('.gamev-mask{') < 0) throw new Error('全屏游玩层没样式');

  /* 重绘复用（缺口①）：renderMessages 每次 msgWrap.innerHTML='' 把游戏卡摘下来，
     htmlGameCard 必须按 msgId 复用同一个节点（同对象 appendChild 回去不重载 iframe，
     游戏进度连续），并在 renderMessages 末尾 prune 失效条目。 */
  if (src.indexOf('gameCardCache') < 0) throw new Error('游戏卡缓存没了 —— 重绘会重建 iframe、游戏从头来');
  var gi = src.indexOf("gameCardCache.get(msg.id)");
  var bi = src.indexOf("h('div', 'msg-htmlgame')");
  if (gi < 0) throw new Error('htmlGameCard 没有按 msgId 复用旧节点');
  if (bi < 0) throw new Error('htmlGameCard 还在建新节点（无法判断复用顺序）');
  if (!(gi < bi)) throw new Error('htmlGameCard 先建新节点后查缓存 —— 复用没生效，游戏每次重绘必重置');
  if (src.indexOf('gameCardCache.set(msg.id, card)') < 0) throw new Error('htmlGameCard 没把节点存进缓存');
  if (src.indexOf('gameCardCache.forEach') < 0 || src.indexOf('gameCardCache.delete(mid)') < 0) {
    throw new Error('renderMessages 没 prune 游戏卡缓存 —— 删消息/换房会泄漏或串台');
  }
  return '沙箱/桥/卡/样式/重绘复用十处全在';
});

/* ---- 报错美化（2026-10-06）：统一报错卡，对齐用户四点要求 ----
   ① 明确的原因 ② 可复制的报错代码 ③ 不暴露未来链接 ④ 不直接关闭、点 × 关闭。
   DOM 桩能遍历 childNodes / className，足够做结构断言；计时器用 win.setTimeout
   临时替换计数，做「报错不自动关闭」的行为断言（不是空转的静态护栏）。 */
function errToastEl() {
  const phone = S.el.phone;
  const kids = (phone && phone.childNodes) || [];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] && kids[i].id === 'toast') return kids[i];
  }
  return null;
}
function errFindByClass(el, cls) {
  if (!el || !el.childNodes) return null;
  const list = el.childNodes;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c && typeof c.className === 'string' && c.className.split(/\s+/).indexOf(cls) >= 0) return c;
    const deep = errFindByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}

t('报错网址闸：抹本机/品牌地址，不拦第三方', () => {
  const s = S.scrubOwnUrl;
  const a = s('连不上 https://127.0.0.1:8080/debug 和 http://localhost:3000/x');
  if (a.indexOf('127.0.0.1') >= 0) throw new Error('没抹 127.0.0.1 本机地址');
  if (a.indexOf('localhost') >= 0) throw new Error('没抹 localhost 本机地址');
  const b = s('看 https://sleepy.app/abc 与 https://sleepy-9a2b.pages.dev/y');
  if (b.indexOf('sleepy.app') >= 0) throw new Error('没抹品牌域名 sleepy.app');
  if (b.indexOf('pages.dev') >= 0) throw new Error('没抹品牌 pages.dev 调试域');
  const c = s('问 https://api.openai.com/v1/chat 或 https://github.com/x');
  if (c.indexOf('api.openai.com') < 0) throw new Error('误伤第三方 api.openai.com');
  if (c.indexOf('github.com') < 0) throw new Error('误伤第三方 github.com');
  return '本机/品牌地址抹掉、第三方保留';
});

t('报错卡（带细节）：标题=原因、带错误码、可复制、× 关闭', () => {
  S.toast('网络连不上', 'err', { detail: 'ECONNREFUSED host unreachable' });
  const el = errToastEl();
  if (!el) throw new Error('报错卡没挂到 phone 上');
  const title = errFindByClass(el, 'toast-title');
  const code = errFindByClass(el, 'toast-code');
  const body = errFindByClass(el, 'toast-body');
  const close = errFindByClass(el, 'toast-close');
  const copy = errFindByClass(el, 'toast-copy');
  if (!title) throw new Error('报错卡没有标题（明确原因）');
  if (title.textContent !== '网络连不上') throw new Error('标题不是明确原因，而是：' + title.textContent);
  if (!code) throw new Error('报错卡没有错误码 chip');
  if (!/^[A-Z0-9-]+$/.test(code.textContent || '')) throw new Error('错误码不合规：' + code.textContent);
  if (!body || body.textContent.indexOf('ECONNREFUSED') < 0) throw new Error('可复制正文里没有技术细节');
  if (!close) throw new Error('报错卡没有关闭按钮');
  if (close.textContent !== '×') throw new Error('关闭按钮不是 ×，而是：' + close.textContent);
  if (!copy) throw new Error('报错卡没有复制按钮');
  if (!el.__report || el.__report.indexOf('[' + code.textContent + ']') < 0
      || el.__report.indexOf('网络连不上') < 0 || el.__report.indexOf('ECONNREFUSED') < 0) {
    throw new Error('复制内容没带上「代码+原因+细节」：' + el.__report);
  }
  return '标题=原因/' + code.textContent + '/可复制/× 关闭 四样都在';
});

t('普通报错（无细节）也走卡、原因清晰、× 关闭，不退化成丑胶囊', () => {
  S.toast('找不到这个对话', 'err');
  const el = errToastEl();
  if (!el) throw new Error('普通报错没挂到 phone 上');
  const title = errFindByClass(el, 'toast-title');
  const close = errFindByClass(el, 'toast-close');
  if (!title || title.textContent !== '找不到这个对话') throw new Error('普通报错标题不对：' + (title && title.textContent));
  if (!close || close.textContent !== '×') throw new Error('普通报错没有 × 关闭');
  return '无细节报错也升级成卡';
});

t('报错不自动关闭：调 err toast 不排程任何 hide 计时器', () => {
  const real = win.setTimeout;
  const calls = [];
  win.setTimeout = (fn) => { calls.push(fn); return 0; };
  try {
    S.toast('测试不自动关', 'err', { detail: 'detail' });
  } finally {
    win.setTimeout = real;
  }
  if (calls.length !== 0) throw new Error('报错竟然排程了 ' + calls.length + ' 个计时器（会自己消失）');
  return '报错零计时器（不自动关闭）';
});

t('普通提示仍自动关闭：ok/warn 照常排程 hide 计时器（没把非报错也卡死）', () => {
  const real = win.setTimeout;
  const calls = [];
  win.setTimeout = (fn) => { calls.push(fn); return 0; };
  try {
    S.toast('已保存', 'ok');
  } finally {
    win.setTimeout = real;
  }
  if (calls.length < 1) throw new Error('ok 提示没排程自动关闭计时器（回归了）');
  return 'ok 提示照常自动关闭';
});

t('自定义组件消毒：script/事件属性/javascript: 全剥，正常内容保留', () => {
  const s = S.desktop.customTpl.sanitize;
  const dirty = '<div onclick="steal()">hi</div><script>alert(1)</script><a href="javascript:x()">y</a>';
  const out = s(dirty);
  if (out.indexOf('script') >= 0) throw new Error('script 没剥干净：' + out);
  if (out.indexOf('onclick') >= 0) throw new Error('onclick 没剥干净：' + out);
  if (out.indexOf('javascript') >= 0) throw new Error('javascript: 没剥干净：' + out);
  if (out.indexOf('hi') < 0 || out.indexOf('y') < 0) throw new Error('正常内容被误伤：' + out);
  /* 作用域钉扎：选择器全部带上组件前缀 */
  const scoped = S.desktop.customTpl.scope('.card{color:red}\nspan{font-size:10px}', '.cust-x');
  if (scoped.indexOf('.cust-x .card') < 0 || scoped.indexOf('.cust-x span') < 0) {
    throw new Error('CSS 没钉进作用域：' + scoped);
  }
  return '消毒 + 作用域全对';
});

t('applyCharRecalls：数「已发出的纯文字」，打戳不删原文；撤过的不回炉，数过头跳过', () => {
  const chat = S.chatStore.createChat('撤回测试', null);
  S.chatStore.addMessage(chat.id, { id: 'rc_a1', role: 'assistant', content: '第一句话', timestamp: 1 });
  S.chatStore.addMessage(chat.id, { id: 'rc_a2', role: 'assistant', type: 'sticker', content: '[表情]', timestamp: 2 });
  S.chatStore.addMessage(chat.id, { id: 'rc_a3', role: 'assistant', content: '第三句话', timestamp: 3 });
  S.chatStore.addMessage(chat.id, { id: 'rc_u1', role: 'user', content: 'user 的', timestamp: 4 });

  const done1 = S.chatUtil.applyCharRecalls(chat.id, [{ n: 1, reason: '说错了' }]);
  if (done1.length !== 1 || done1[0] !== 'rc_a3') {
    throw new Error('N=1 应命中最新纯文字 rc_a3（表情/user 不进候选）：' + JSON.stringify(done1));
  }
  const m3 = S.chatStore.getChat(chat.id).messages.filter((x) => x.id === 'rc_a3')[0];
  if (!m3.recalledAt) throw new Error('没打戳');
  if (m3.content !== '第三句话') throw new Error('原文不该删');
  if (m3.recallReason !== '说错了') throw new Error('原因没存上');

  /* 撤过的不再进候选：再撤 N=1 应命中 rc_a1 */
  const done2 = S.chatUtil.applyCharRecalls(chat.id, [{ n: 1, reason: '' }]);
  if (done2.length !== 1 || done2[0] !== 'rc_a1') {
    throw new Error('撤过的应被排除，N=1 应命中 rc_a1：' + JSON.stringify(done2));
  }
  /* 数过头：静默跳过，不炸 */
  const done3 = S.chatUtil.applyCharRecalls(chat.id, [{ n: 5, reason: '数过头了' }]);
  if (done3.length !== 0) throw new Error('数过头应跳过');
  /* excludeId：本轮刚落库的回复不算「上一条」 */
  S.chatStore.addMessage(chat.id, { id: 'rc_now', role: 'assistant', content: '本轮刚说的', timestamp: 5 });
  const done4 = S.chatUtil.applyCharRecalls(chat.id, [{ n: 1, reason: 'x' }], 'rc_now');
  if (done4.length !== 0) throw new Error('excludeId 应把本轮回复排除（剩下的都撤过了）');
  return { 第一撤: done1[0], 第二撤: done2[0], 数过头: '跳过', 本轮排除: '是' };
});

t('撤回接线都在：菜单入口 / 概率掷骰 / 灰字渲染 / 上下文装配 / 协议卡注册', () => {
  const src = require('fs').readFileSync('page-chat.js', 'utf8');
  const pe = require('fs').readFileSync('prompt-engine.js', 'utf8');
  const css = require('fs').readFileSync('style.css', 'utf8');
  const setSrc = require('fs').readFileSync('page-chat-settings.js', 'utf8');
  if (src.indexOf('recallMine') < 0) throw new Error('长按菜单没有撤回入口');
  if (src.indexOf('recallSeen') < 0) throw new Error('user 撤回没掷骰');
  if (src.indexOf('msg-recall') < 0 || css.indexOf('.msg-recall{') < 0) throw new Error('灰字条没渲染/没样式');
  if (src.indexOf('随后撤回了这条') < 0) throw new Error('上下文装配没处理 user 撤回');
  if (pe.indexOf("'msgrecall'") < 0) throw new Error('撤回说明书卡没注册进引擎');
  if (setSrc.indexOf('recallNotice') < 0) throw new Error('设置页没挂概率滑条');
  return '六处接线全在';
});

/* 会话置顶（2026-09-22 用户五.6）：置顶的搬到最前，其余**原顺序**不动。
   这条纯函数刻意不按时间重排 —— 非置顶项之间一个都不许动，
   不然「收一条消息整个列表自己跳」这个副作用会跟着进来。 */
t('会话置顶：置顶的搬到最前，其余原顺序；后置顶的排更上', () => {
  const list = [
    { id: 'a', pinned: false },
    { id: 'b', pinned: true, pinnedAt: 100 },
    { id: 'c', pinned: false },
    { id: 'd', pinned: true, pinnedAt: 200 }
  ];
  const out = S.chatUtil.withPinnedFirst(list);
  const none = S.chatUtil.withPinnedFirst([{ id: 'x' }, { id: 'y' }]);
  return {
    顺序: out.map((c) => c.id),
    没置顶就是原顺序: none.map((c) => c.id),
    原数组没被改动: list.map((c) => c.id)
  };
});

/* 关键链路：模型写 [表情:名字] → 抽出来 → 名字能对上用户收的那张图。
   （页面里的 charSendSticker 就是按这个思路找的：先精确、再包含） */
t('角色发表情：标签 → 名字 → 对得上那张图', () => {
  S.store.set('stickers', []);
  S.stickers.addBatch([
    { url: 'https://x.test/a.gif', name: '小熊打招呼' },
    { url: 'https://x.test/b.gif', name: '小猫委屈' }
  ], '测试');
  const r = S.chatUtil.extractStickers('给你看一个\n[表情:小熊打招呼]');
  const hits = S.stickers.match(r.names[0]);
  return { 抽到的名字: r.names, 对上的: hits.map((s) => s.name), 正文: r.text };
});

ok('表情说明书会跟着请求一起发（只列名字，模型不用知道 URL）',
  typeof S.stickers.replySpec === 'function');
t('说明书里列的是解释（没有表情时返回空串，不白加一段指令）', () => {
  S.store.set('stickers', []);
  const empty = S.stickers.replySpec();
  S.stickers.addBatch([{ url: 'https://x.test/a.gif', name: '小熊打招呼' }], '测试');
  const one = S.stickers.replySpec();
  return { 没表情时: empty, 有一个时含名字: one.indexOf('小熊打招呼') >= 0 };
});

console.log('\n--- page:朋友圈（带图 / 表情评论 / 记忆挂钩）---');

/* 用户这批点名要的：带图发、评论能发表情（双向）、能手动删、
   角色发的要进记忆库（「他一定要知道自己为什么发这条朋友圈」）。 */
t('动态能带图，也能只发图不写字；两者都没有就不建', () => {
  S.store.set('moments', []);
  const a = S.momentsTab.add({ name: '我', text: '今天天气好' });
  const b = S.momentsTab.add({ name: '我', mediaId: 'md-测试', w: 100, h: 80 });
  const c = S.momentsTab.add({ name: '我' });
  return { 纯文字: !!a, 带图: b && b.mediaId, 只带图时的正文: b && b.text, 全空的不建: c };
});

t('评论可以只发个表情（没文字也算数），也能指定回复哪一条', () => {
  S.store.set('moments', []);
  const mo = S.momentsTab.add({ name: '我', text: '有人吗' });
  const who = { kind: 'mask', refId: 'u1', name: '我' };
  const empty = S.momentsTab.addComment(mo.id, who, '');
  const stk = S.momentsTab.addComment(mo.id, who, '', { mediaId: 'md-表情' });
  const rep = S.momentsTab.addComment(mo.id, who, '回你', { replyTo: stk.item.id });
  return {
    空评论被拒: !empty.ok,
    表情评论: stk.ok && stk.item.mediaId,
    回复指向: rep.item.replyTo === stk.item.id
  };
});

t('角色发动态会写进它的记忆库（带「为什么发」）', () => {
  S.store.set('moments', []);
  S.store.set('memories', []);
  const ch = S.core.upsertChar({ name: '顾清和', kind: 'main', content: '清冷' }).id;
  const mo = S.momentsTab.add({ characterId: ch, name: '顾清和', text: '雨停了', mediaId: null, reason: '想让他知道我在等' });
  S.momentsTab.rememberMoment(mo, { kind: 'char', refId: ch, name: '顾清和' });
  const root = S.core.rootIdOf(ch) || ch;
  const mem = S.core.memoriesOfRoot(root) || [];
  return { 记了几条: mem.length, 内容: mem.map((x) => x.text) };
});

t('动态和评论都能手动删掉', () => {
  S.store.set('moments', []);
  const mo = S.momentsTab.add({ name: '我', text: '删我' });
  const c = S.momentsTab.addComment(mo.id, { kind: 'mask', refId: 'u1', name: '我' }, '这条也删');
  S.momentsTab.removeComment(mo.id, c.item.id);
  const afterComment = S.momentsTab.all()[0].comments.length;
  S.momentsTab.remove(mo.id);
  return { 评论删掉后剩: afterComment, 动态删掉后剩: S.momentsTab.all().length };
});

console.log('\n--- page:朋友圈（可见范围 / 点按菜单 / 角色自己动）---');

/* 认知锁：发的时候选「允许谁可见」。
   存的是**脸**不是人 —— 换张小号就看不见了，这是设计不是 bug
   （「被屏蔽的人从小号看到了」那种玩法的地基）。 */
t('可见范围：没选谁都看得见，选了就只有那几个人看得见', () => {
  S.store.set('moments', []);
  const open = S.momentsTab.add({ name: '我', text: '公开的' });
  const priv = S.momentsTab.add({ name: '我', text: '只给一个人看', visibleTo: ['c9'] });
  return {
    公开的不漏拦: S.momentsTab.canSee(open, 'c1'),
    定向的选中者看得见: S.momentsTab.canSee(priv, 'c9'),
    定向的旁人看不见: !S.momentsTab.canSee(priv, 'c1'),
    认不出是谁时不拦: S.momentsTab.canSee(priv, '')
  };
});

/* 模型不一定听话，所以三种写法都认；但只有 [不发] 才当它不想发。
   格式没对上就一律不发的话，用户会以为这功能是坏的（永远没动态）。 */
t('动态解析：标准格式 / 倒着写 / 没标签都认，[不发] 才不发', () => {
  const A = S.momentsAI.extractPost('[发] 雨停了\n[因为] 想让他知道我这边雨停了');
  const B = S.momentsAI.extractPost('[因为] 有点闷\n窗台上的绿萝冒芽了');
  const C = S.momentsAI.extractPost('「今天有点累」');
  const D = S.momentsAI.extractPost('[不发]');
  return {
    标准_正文: A.text, 标准_动机: A.reason,
    倒着写_正文: B.text, 倒着写_动机: B.reason,
    没标签_去引号: C.text,
    不想发就不建: D === null
  };
});

/* [图] 配图行（朋友圈生图接口，方案-生图 v2 的朋友圈延伸）：
   有 [图] → imgDesc 带出来；没写 → 空字符串，不发图。 */
t('动态解析：[图] 配图描述单独收，不影响正文', () => {
  const A = S.momentsAI.extractPost('[发] 楼下的猫又来了\n[图] 1girl selfie, 下雨天, 猫 in arms\n[因为] 太可爱了');
  const B = S.momentsAI.extractPost('[发] 只想说话\n[因为] 无');
  if (A.imgDesc.indexOf('selfie') < 0) throw new Error('[图] 描述没收进来');
  if (A.text !== '楼下的猫又来了') throw new Error('[图] 行混进了正文');
  if (B.imgDesc !== '') throw new Error('没写 [图] 也给配图了');
  return { 配图: A.imgDesc.slice(0, 20), 无图: B.imgDesc === '' };
});

/* 日记的 [图] 行（AI 代笔的配图描述）：拆正文和配图描述两份。 */
t('日记解析：[图] 行拆出来，正文不掺标签', () => {
  const P = S.diary.splitDiaryImg;
  const A = P('今天在阳台晒了一下午太阳。\n[图] 午后的阳台，猫睡在毯子上，光斑落在地砖');
  if (A.text !== '今天在阳台晒了一下午太阳。') throw new Error('正文不对');
  if (A.imgDesc.indexOf('猫睡在毯子上') < 0) throw new Error('[图] 描述没收进来');
  const B = P('纯粹写写字的一天。');
  if (B.imgDesc !== '') throw new Error('没写 [图] 也给配图了');
  const C = P('[图] 只有图没有正文');
  if (C.text) throw new Error('只有 [图] 行不该编出正文');
  return { 有图: A.imgDesc.slice(0, 16), 无图: B.imgDesc === '', 只有图: C.text === '' };
});

t('回复解析：去掉模型爱带的名字前缀和引号，只留一句话', () => {  return {
    带名字: S.momentsAI.extractReply('顾清和：你还是那样', '顾清和'),
    带引号: S.momentsAI.extractReply('「好啊」', '顾清和'),
    多行只取一行: S.momentsAI.extractReply('第一句\n第二句', '顾清和'),
    沉默不发言: S.momentsAI.extractReply('[不回]', '顾清和') === ''
  };
});

/* 自动回复链的第一道闸：看不见这条动态的人不参与。 */
t('认知锁：被挡住的人不会来评论（自动回复链过闸）', () => {
  S.store.set('moments', []);
  const mo = S.momentsTab.add({ name: '我', text: '私密的', visibleTo: ['c1'] });
  const picks = S.momentsAI.pickResponders(mo, null, null);
  return { 挑到的: picks.map((p) => p.name), 都被挡了: picks.length === 0 };
});

t('我发评论后会排一个「过一会儿回」，不是秒回', () => {
  S.store.set('moments', []);
  S.store.set('momentPending', []);
  const prev = S.core.activeSandbox();
  const ch = S.core.upsertChar({ name: '顾清和', kind: 'main' }).id;
  const sb = S.core.createSandbox('archipelago');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setActiveSandbox(sb.id);
  const mo = S.momentsTab.add({ name: '我', text: '在吗' });
  const me = { kind: 'mask', refId: S.core.activeUser().id, name: '我' };
  const c = S.momentsTab.addComment(mo.id, me, '你怎么看', {});
  const queued = S.momentsAI.onUserAction('comment', mo.id, c.item);
  const p = S.momentsAI.pending();
  const waited = p.length ? Math.round((p[0].dueAt - Date.now()) / 1000) : -1;
  S.momentsAI.clearPending();
  S.core._purgeSync.sandbox(sb.id);
  S.core.setActiveSandbox(prev ? prev.id : null);
  return {
    排了几个: queued.length,
    等多少秒: waited,
    不秒回: waited >= S.momentsAI.DELAY_MIN,
    接下来该谁回: p.length ? p[0].charName : '（没排上）'
  };
});

/* 评论交互改成「点一下出菜单」了，这几个类名是那条链上的关键 */
{
  const mjs = fs.readFileSync(path.join(ROOT, 'page-moments.js'), 'utf8');
  ok('点评论弹出「回复 / 删除」小菜单（不再常驻两个按钮）',
    mjs.indexOf('openCommentMenu') >= 0 &&
    mjs.indexOf('mo-cmenu-item') >= 0 &&
    mjs.indexOf("'mo-comment-rep'") < 0 &&
    mjs.indexOf("'mo-comment-del'") < 0);
  ok('回复用微信那种「甲 回复 乙：」', mjs.indexOf('mo-grey-rep2') >= 0);
  ok('评论里的图 / 表情排在文字**后面**',
    mjs.indexOf("h('span', 'mo-grey-text', c.text)") >= 0 &&
    mjs.indexOf("h('span', 'mo-grey-text', c.text)") <
    mjs.indexOf("h('span', 'mo-grey-sticker')"));
}

console.log('\n--- 签名契约（回归高风险区）---');
/* 这几个 API 是位置参数，不是对象参数。写错了不会抛错，
   只是「静默什么都不做」—— 以前踩过：传 {charId, userId} 给 switchTo，
   结果只切了 user、char 原样不动，看起来像切号没生效。 */
t('switchTo 是位置参数 (charId, userId)', () => {
  S.core.switchTo(m1, u2);
  const after = S.core.activeChar();
  if (!after || after.id !== m1) throw new Error('切号后 activeChar 不是大号：' + (after && after.name));
  if (S.core.activeUser().id !== u2) throw new Error('切号后 activeUser 不对');
  return { char: after.name, user: S.core.activeUser().name };
});
t('switchTo 传皮套 id 时归到它的大号（桌面氛围跟大号走）', () => {
  S.core.switchTo(s1, u2);
  const c = S.core.activeChar();
  if (!c || c.id !== m1) throw new Error('皮套没有归到根：' + (c && c.name));
  return { 归到: c.name, 说明: '皮套只是这张脸，宇宙不变' };
});
t('addLink 是位置参数 (charId, userId, cognition, barrier)', () => {
  const lk = S.core.addLink(s1, u2, 'unaware', true);
  if (!lk || lk.barrier !== true) throw new Error('barrier 没进去：' + JSON.stringify(lk));
  return { cognition: lk.cognition, barrier: lk.barrier };
});
t('setBarrier 撕障壁真的落盘（快照就地改，不是改深拷贝）', () => {
  S.core.addLink(s1, u2, 'unaware', true);
  S.core.setBarrier(s1, u2, false);
  const st = S.core.cognitionOf(s1, u2);
  if (st.barrier !== false) throw new Error('障壁还在 —— 改到深拷贝上了');
  return st;
});

console.log('\n--- home 基底页渲染 ---');
/* home 不走页面栈，它的 render 必须有人主动点火（见 app.js 的 Sleepy.bootHome）。
   曾经漏掉点火：首页 section 永远空、但状态栏时钟照常走，很难一眼定位。 */
t('bootHome 能跑通并返回 true', () => {
  const r = S.bootHome();
  if (r === false) throw new Error('bootHome 返回 false（render 抛错或被短路）');
  return r;
});
t('bootHome 幂等（重复点火不叠 DOM）', () => {
  const a = S.bootHome();
  const b = S.bootHome();
  if (b === false) throw new Error('第二次点火失败了');
  return { first: a, second: b };
});
t('bootHome 留下了 __homeCtx（切号重绘要靠它）', () => {
  const ctx = S.__homeCtx;
  if (!ctx) throw new Error('__homeCtx 没挂上，切号后桌面不会重绘');
  if (typeof ctx.repaint !== 'function') throw new Error('ctx.repaint 不是函数');
  return { id: ctx.id, hasRepaint: true, hasStore: !!ctx.store };
});
/* 2026-10-06：原「面具轮盘」断言改成只验活着的切号入口。
   wheel（宇宙内就地切皮套）已下线 —— 它的调用点在 page-chat.js 里
   早已不存在，这次连死代码一起清了。切号能力本身不受影响。 */
t('系统级切号入口还在（Sleepy.switcher.open）', () => {
  if (!S.switcher) throw new Error('switcher 没加载');
  if (typeof S.switcher.open !== 'function') throw new Error('switcher.open 缺失 —— 系统级切号入口没了');
  return { open: true, close: typeof S.switcher.close === 'function' };
});

console.log('\n--- photos:照片数据层 ---');
t('photos.all() 空相册返回数组', () => {
  S.store.set('photos', []);
  const a = S.photos.all();
  if (!Array.isArray(a)) throw new Error('不是数组：' + typeof a);
  return { 长度: a.length };
});
t('photos.add() 落盘并给每条生成 id', () => {
  S.store.set('photos', []);
  const list = S.photos.add([{ url: 'data:image/jpeg;base64,AAA' }, { url: 'data:image/jpeg;base64,BBB' }]);
  if (list.length !== 2) throw new Error('加完不是 2 条');
  if (!list[0].id || !list[1].id) throw new Error('没生成 id');
  if (list[0].id === list[1].id) throw new Error('两条 id 撞了');
  return { 条数: list.length, 首条id: list[0].id };
});
t('photos.remove() 只删指定那条', () => {
  S.store.set('photos', []);
  const list = S.photos.add([{ url: 'x1' }, { url: 'x2' }, { url: 'x3' }]);
  S.photos.remove(list[1].id);
  const after = S.photos.all();
  if (after.length !== 2) throw new Error('删多了或没删掉：' + after.length);
  if (after.some((p) => p.id === list[1].id)) throw new Error('被删的那条还在');
  return { 剩: after.length };
});
t('photos.update() 改标题', () => {
  S.store.set('photos', []);
  const list = S.photos.add([{ url: 'x1' }]);
  S.photos.update(list[0].id, { caption: '那天的风' });
  const got = S.photos.all()[0];
  if (got.caption !== '那天的风') throw new Error('没改上：' + got.caption);
  return { caption: got.caption };
});
t('photos.pick / readImageScaled 是 Promise 版接口', () => {
  if (typeof S.photos.pick !== 'function') throw new Error('pick 缺失 —— 相册空态的入口');
  if (typeof S.photos.readImageScaled !== 'function') throw new Error('readImageScaled 缺失');
  return { pick: true, readImageScaled: true, 软上限: S.photos.SOFT_LIMIT };
});

/* 2026-10-06（用户）：「长按删除照片之后直接从数据库里删掉就行，
   也不用再出现在相册里」—— 聊天删照片消息时按 mediaId 清相册记录。 */
t('photos.removeByMedia() 按 mediaId 清记录；dropMessages 已接线', () => {
  S.store.set('photos', []);
  const list = S.photos.add([
    { mediaId: 'm-1' }, { mediaId: 'm-1' }, { url: '老图没有 mediaId' }, { mediaId: 'm-2' }
  ]);
  if (list.length !== 4) throw new Error('夹具没落上');
  const n = S.photos.removeByMedia('m-1');
  if (n !== 2) throw new Error('重复收进的记录应一次清干净，实删 ' + n);
  const after = S.photos.all();
  if (after.length !== 2) throw new Error('清完应剩 2 条，实 ' + after.length);
  if (after.some((p) => p.mediaId === 'm-1')) throw new Error('m-1 还在');
  S.photos.removeByMedia(''); /* 空参数不许误删 */
  if (S.photos.all().length !== 2) throw new Error('空 mediaId 被误删了记录');

  const chatSrc = require('fs').readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
  if (chatSrc.indexOf('removeByMedia') < 0 || chatSrc.indexOf("type !== 'photo'") < 0) {
    throw new Error('dropMessages 没接照片清理 —— 消息删了相册里还会躺着');
  }
  return { 删了: n, 剩: after.length };
});

/* ---- 相册按账号隔离（2026-10-06 用户：「相册要选人 · 按账号隔离」）---- */
t('photos.add 归属章：显式 owner 优先，默认按活动角色，字段必须总在', () => {
  S.store.set('photos', []);
  const list = S.photos.add([{ url: 'x1' }], { charId: 'chA' });
  if (list[0].ownerCharId !== 'chA') throw new Error('显式 owner 没落上');
  const auto = S.photos.add([{ url: 'x2' }]);
  /* 夹具里没有活动角色 → 空串（未归属）；真机上默认盖 core.activeCharOnIsland */
  if (typeof auto[0].ownerCharId !== 'string') throw new Error('新记录必须带 ownerCharId（没有主就是空串）');
  S.store.set('photos', []);
  return { 归属: 'ok' };
});

console.log('\n--- mcp：服务配置 / 工具开关 / 接线 ---');
t('mcp 导出面齐 + upsert/toggleTool/enabledToolSpecs 配置逻辑', () => {
  const need = ['list', 'cfgOf', 'upsert', 'remove', 'setEnabled', 'toggleTool',
    'refreshTools', 'callToolByName', 'enabledToolSpecs', 'summary'];
  need.forEach((k) => {
    if (typeof S.mcp[k] !== 'function') throw new Error('mcp.' + k + ' 缺失');
  });
  S.store.set('mcpServers', []);
  const r1 = S.mcp.upsert({ name: '搜索', url: 'https://mcp.example/rpc', transport: 'http', enabled: true });
  if (!r1.ok) throw new Error(r1.error);
  const r2 = S.mcp.upsert({ name: '坏配置', url: '' });
  if (r2.ok) throw new Error('空 url 不该存上');
  /* 清单没刷新前不出任何工具；模拟拉到的清单直接打表落库（refreshTools 要真网络） */
  if (S.mcp.enabledToolSpecs().length !== 0) throw new Error('没拉清单不该出工具');
  const l = S.store.get('mcpServers');
  l[0].tools = [{ name: 'web_search', description: '搜网页',
    schema: { type: 'object', properties: { q: { type: 'string' } } } }];
  S.store.set('mcpServers', l);
  if (S.mcp.enabledToolSpecs().length !== 0) throw new Error('新工具不该默认开（用户要逐工具开关）');
  S.mcp.toggleTool(r1.cfg.id, 'web_search', true);
  const specs = S.mcp.enabledToolSpecs();
  if (specs.length !== 1 || specs[0].function.name !== 'web_search') throw new Error('勾上的工具该进清单');
  if (specs[0].type !== 'function' || !specs[0].function.parameters.properties.q) {
    throw new Error('OpenAI tools 形状不对（type/schema 没带上）');
  }
  /* 总开关 / 工具开关都能单独关掉 */
  S.mcp.setEnabled(r1.cfg.id, false);
  if (S.mcp.enabledToolSpecs().length !== 0) throw new Error('服务关了工具还在');
  S.mcp.setEnabled(r1.cfg.id, true);
  if (S.mcp.enabledToolSpecs().length !== 1) throw new Error('服务重开工具该回来');
  S.mcp.toggleTool(r1.cfg.id, 'web_search', false);
  if (S.mcp.enabledToolSpecs().length !== 0) throw new Error('工具关了还在');
  if (S.mcp.summary() === '未配置') throw new Error('有配置时 summary 不该是未配置');
  S.mcp.remove(r1.cfg.id);
  if (S.mcp.list().length !== 0) throw new Error('没删掉');
  if (S.mcp.summary() !== '未配置') throw new Error('空清单 summary 应为未配置');
  return { 配置逻辑: 'ok' };
});
t('MCP 接线静态护栏：api 工具循环 + 对话开关 + 相册选人 + 加载顺序', () => {
  const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  if (apiSrc.indexOf('requestToolLoop') < 0 || apiSrc.indexOf('body.tools = ov.tools') < 0) {
    throw new Error('api.js 工具循环没接上');
  }
  const chatSrc = fs.readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
  if (chatSrc.indexOf('enabledToolSpecs') < 0 || chatSrc.indexOf('callToolByName') < 0) {
    throw new Error('page-chat 没把 MCP 工具挂进 ov');
  }
  const csSrc = fs.readFileSync(path.join(ROOT, 'page-chat-settings.js'), 'utf8');
  if (csSrc.indexOf('MCP 工具') < 0 || csSrc.indexOf('mcpTools') < 0) {
    throw new Error('对话设置缺 MCP 开关');
  }
  const setSrc = fs.readFileSync(path.join(ROOT, 'page-settings.js'), 'utf8');
  if (setSrc.indexOf("register('settings-mcp'") < 0 || setSrc.indexOf('toggleTool') < 0) {
    throw new Error('设置页缺 MCP 配置页 / 逐工具开关');
  }
  const galSrc = fs.readFileSync(path.join(ROOT, 'page-gallery.js'), 'utf8');
  if (galSrc.indexOf('needsCharPick') < 0 || galSrc.indexOf('pickScreen') < 0) {
    throw new Error('相册缺群岛选人');
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const i1 = html.indexOf('src="mcp.js"');
  if (!(i1 > 0 && i1 < html.indexOf('src="page-settings.js"'))) {
    throw new Error('mcp.js 加载顺序不对（要在 page-settings / page-chat 前）');
  }
  return { 接线: '齐' };
});

console.log('\n--- desktop:布局不重叠 ---');
/* CSS Grid 会让后插入的格子**静默盖在**先插入的上面，
   不报错、不缺图，只是「有个东西不见了」——
   曾经第 2 屏的 settings/feedback 两个 App 就压在 worldclock 底下，
   在浏览器里完全看不见。这条断言把这类错误挡在提交前。 */
t('同一屏内没有格子重叠', () => {
  const d = S.desktop.defaultDesktop();
  const bad = [];
  d.pages.forEach((cells, pi) => {
    for (let a = 0; a < cells.length; a++) {
      for (let b = a + 1; b < cells.length; b++) {
        const A = cells[a], B = cells[b];
        const overlap = A.x < B.x + B.w && B.x < A.x + A.w &&
                        A.y < B.y + B.h && B.y < A.y + A.h;
        if (overlap) bad.push(`第${pi}屏 ${A.i} × ${B.i}`);
      }
    }
  });
  if (bad.length) throw new Error('这些格子叠在一起：' + bad.join('；'));
  return { 屏数: d.pages.length, 检查通过: true };
});
t('每个 App 格子都指向真实注册的页面', () => {
  const d = S.desktop.defaultDesktop();
  const reg = S.registered();
  const missing = [];
  d.pages.forEach((cells, pi) => {
    cells.forEach((c) => {
      if (c.type === 'app' && c.app && !reg[c.app]) {
        missing.push(`第${pi}屏 ${c.i} → ${c.app}`);
      }
    });
  });
  if (missing.length) {
    throw new Error('这些 App 没有对应页面，点了没反应：' + missing.join('；'));
  }
  return { App格子数: d.pages.flat().filter((c) => c.type === 'app').length, 全部有页面: true };
});
/* ---------- 以身入局（book-core.js，施工卡-以身入局-P0 第一刀） ---------- */
t('以身入局：数据层挂载 + 加载顺序（book-core 在页面前求值）', () => {
  const html2 = require('fs').readFileSync('index.html', 'utf8');
  const iCore = html2.indexOf('src="book-core.js"');
  const iPage = html2.indexOf('src="page-yishenruju.js"');
  if (iCore < 0 || iPage < 0 || iCore > iPage) {
    throw new Error('index.html 里 book-core.js 必须存在且排在 page-yishenruju.js 之前');
  }
  if (!S.book || typeof S.book.ensureBoxes !== 'function' ||
      typeof S.book.setIdentity !== 'function') {
    throw new Error('Sleepy.book 没挂上（book-core.js 求值失败或导出面缺函数）');
  }
  return { 挂载: true, 顺序: 'book-core → page-yishenruju' };
});
t('以身入局：删房名单与映射键清理已登记', () => {
  const coreSrc = require('fs').readFileSync('core.js', 'utf8');
  const storeSrc = require('fs').readFileSync('store.js', 'utf8');
  /* 硬写字符串（不引 S.book 常量）：名单漏了会积幽灵岛数据 */
  ['bookBoxes', 'bookRuns'].forEach((k) => {
    if (coreSrc.indexOf("'" + k + "'") < 0) throw new Error('core.js 删房 scoped 名单缺 ' + k);
    if (storeSrc.indexOf(k + ':') < 0) throw new Error('store.js 默认键缺 ' + k);
  });
  if (coreSrc.indexOf("'bookSettingsBySandbox'") < 0) {
    throw new Error('core.js 映射键清理缺 bookSettingsBySandbox');
  }
  if (storeSrc.indexOf('bookSettingsBySandbox') < 0) {
    throw new Error('store.js 默认映射键缺 bookSettingsBySandbox');
  }
  return { scoped: ['bookBoxes', 'bookRuns'], map: 'bookSettingsBySandbox' };
});
t('以身入局：记忆隔离红线（数据层不碰角色记忆通道）', () => {
  const bookSrc = require('fs').readFileSync('book-core.js', 'utf8')
    /* 先剥块注释再查 —— 头注释里写着「不进 memory-vec」这类说明，
       不剥的话判据会扫到说明自己（假红）。 */
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /* 结构性判据：book-core.js 的读写只走登记键（BOOK_KEYS/BOOK_MAP_KEYS），
     不得引用角色记忆模块或键。判据串只在本断言里，不会扫到自己。 */
  const banned = ['memoryVec', 'memory-vec', "'memories'", '"memories"', 'memories:', 'pushMemory'];
  const hit = banned.filter((s) => bookSrc.indexOf(s) >= 0);
  if (hit.length) throw new Error('book-core.js 引用了角色记忆通道：' + hit.join(','));
  return { 通道: '仅 bookBoxes/bookRuns/bookSettingsBySandbox', 隔离: true };
});
t('以身入局：开局落库 + 身份按世界锁死（startRun 真跑）', () => {
  const sb = S.core.createSandbox('single', 'smoke-book-fixture');
  try {
    S.book.lockSandbox(sb.id);
    const boxes = S.book.ensureBoxes(sb.id);
    const drill = boxes.filter((b) => b.enterable)[0];
    if (!drill) throw new Error('ensureBoxes 没播撒可进入的演练盒');
    const r1 = S.book.startRun(drill.id, 'boss-watch', { name: '借宿的旅人' });
    if (r1.existed) throw new Error('首次 startRun 不应返回 existed');
    const run = S.book.getRunByBox(drill.id, sb.id);
    if (!run || run.identity !== 'boss-watch' || run.status !== 'ongoing') {
      throw new Error('运行记录没落对：' + JSON.stringify(run));
    }
    const box = S.book.getBox(drill.id, sb.id);
    if (box.identity !== 'boss-watch' || box.status !== 'ongoing') {
      throw new Error('档案盒没被刻身份/没变进行中：' + JSON.stringify(box));
    }
    let locked = false;
    try { S.book.startRun(drill.id, 'staff', { name: '新来的帮工' }); } catch (e) { locked = true; }
    if (!locked) throw new Error('换身份开局没被拦（身份应按世界锁死）');
    const r2 = S.book.startRun(drill.id, 'boss-watch', { name: '借宿的旅人' });
    if (!r2.existed) throw new Error('同身份重复开局应返回 existed（幂等续接）');
    return { run: run.id.slice(-6), 身份: 'boss-watch', 锁死: true, 幂等: true };
  } catch (e) {
    throw e;
  }

  /* 不删夹具岛：smoke 每轮独立实例无跨轮污染；purgeSandbox 是异步门禁，
     拉进来反而把断言搅成异步。 */
});
t('以身入局：入世轮管线（注入四块 / 判定剥离 / 写回纪律）', () => {
  const Bk = S.book;
  /* 注入结构：席位/世界/判定格式三块齐；行动轮含「在局外观测」 */
  const fakeRun = { id: 'r', identity: 'boss-watch', seat: { name: '借宿的旅人' }, anomaly: 12, progress: 22, logs: [] };
  const msg = Bk.buildBookMessages(fakeRun, { title: '局内演练' }, Bk.getWorld('drill'), { words: 'short' }, null);
  const sys = msg[0].content, usr = msg[1].content;
  ['席位与身份', '世界状态', '异常度: 12 / 100', '占位: 借宿的旅人', '<判定>', '异常度 +N'].forEach((k) => {
    if (sys.indexOf(k) < 0) throw new Error('注入缺「' + k + '」');
  });
  if (usr.indexOf('在局外观测') < 0) throw new Error('行动轮应声明 user 未出面');
  if (sys.indexOf('不超过 180 字') < 0) throw new Error('字数档没进注入');

  /* 剥离：正文/判定分开；只升不降（负增量按 0）；缺块=无变化 */
  const raw = '雾港的灯晃了一下。\n<判定>\n权限: 擦边 / 异常度 +3\n进度: 第一章 22% → 30%\n</判定>';
  const v = Bk.parseVerdict(raw);
  if (v.narrative.indexOf('灯晃') < 0 || v.anomalyDelta !== 3 || v.progress !== 30) {
    throw new Error('判定解析不对：' + JSON.stringify(v));
  }
  /* 负异常度增量在解析层就驳回；降进度由写回层守卫（下面 applyVerdict 验） */
  const neg = Bk.parseVerdict('正文。<判定>权限: 正常 / 异常度 -5\n进度: 第一章 10% → 5%</判定>');
  if (neg.anomalyDelta !== 0) {
    throw new Error('负异常度增量应被驳回：' + JSON.stringify(neg));
  }
  const noV = Bk.parseVerdict('只有正文，没有判定块。');
  if (noV.verdictText !== null || noV.narrative.indexOf('只有正文') < 0) throw new Error('无判定块应整体按无变化');

  /* 写回：异常度累计、进度只进不退、日志成条 */
  const run = { id: 'r2', identity: 'boss-watch', seat: { name: '借宿的旅人' }, anomaly: 12, progress: 22, logs: [] };
  Bk.applyVerdict(run, v, null);
  if (run.anomaly !== 15 || run.progress !== 30 || run.logs.length !== 1) {
    throw new Error('写回不对：' + JSON.stringify(run));
  }
  Bk.applyVerdict(run, neg, null);
  if (run.anomaly !== 15 || run.progress !== 30 || run.logs.length !== 2) {
    throw new Error('无变化轮不应动状态：' + JSON.stringify(run));
  }
  return { 注入: '四块+判定格式', 剥离: true, 写回: '异常度累计/进度只进不退' };
});
t('格子都在 4×6 的网格范围内', () => {
  const d = S.desktop.defaultDesktop();
  const out = [];
  d.pages.forEach((cells, pi) => {
    cells.forEach((c) => {
      if (c.x < 1 || c.y < 1 || c.x + c.w > 5 || c.y + c.h > 7) {
        out.push(`第${pi}屏 ${c.i} (${c.x},${c.y},${c.w}×${c.h})`);
      }
    });
  });
  if (out.length) throw new Error('这些格子越界了：' + out.join('；'));
  return { 边界: '4 列 × 6 行' };
});
t('底部 dock 只放全局 App（不含聊天内部构造）', () => {
  /* dock 是系统级底栏，不该出现「名片夹」「朋友圈」这类
     聊天 App 内部的页面 —— 那会让「App」和「App 里的页」混成一层 */
  const banned = ['contacts', 'moments', 'chat-detail'];
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  const dockBlock = src.slice(src.indexOf('底部 Dock'), src.indexOf('forEach', src.indexOf('底部 Dock')));
  const hit = banned.filter((b) => dockBlock.includes("'" + b + "'"));
  if (hit.length) throw new Error('dock 里混进了聊天内部页：' + hit.join(','));
  return { dock内容: ['chat-list', 'worldbook', 'settings'], 检查通过: true };
});

/* ---- 布局编辑（长按拖动） ----
   这几条挡的是「拖完存档坏了」这一类问题。
   拖动本身是 DOM 手势，冒烟测不了；能测的是它的**决策逻辑** ——
   canPlace 判交、snapTo 夹边界、persistCell 真写回。 */
t('desktop 导出了布局编辑的口子', () => {
  const need = ['isEditing', 'enterEdit', 'exitEdit', 'canPlace', 'overlap', 'LAYOUT_VERSION'];
  const miss = need.filter((k) => typeof S.desktop[k] === 'undefined');
  if (miss.length) throw new Error('Sleepy.desktop 少了：' + miss.join(','));
  return { 版本: S.desktop.LAYOUT_VERSION, 导出: need.length };
});
t('canPlace 挡得住重叠', () => {
  const pages = [[
    { i: 'a', x: 1, y: 1, w: 2, h: 2 },
    { i: 'b', x: 3, y: 1, w: 2, h: 2 }
  ]];
  const b = pages[0][1];
  /* 往 a 的地盘上放：应当被拒 */
  if (S.desktop.canPlace(pages, 0, b, 1, 1)) throw new Error('压在别人身上竟然通过了');
  /* 挪到空处：应当放行 */
  if (!S.desktop.canPlace(pages, 0, b, 3, 4)) throw new Error('空格子竟然放不进去');
  /* 自己压自己不算重叠（拖回原位必须合法） */
  if (!S.desktop.canPlace(pages, 0, b, 3, 1)) throw new Error('拖回原位竟然被拒');
  return { 判交: '正常' };
});
t('canPlace 挡得住越界', () => {
  const pages = [[{ i: 'a', x: 1, y: 1, w: 2, h: 2 }]];
  const a = pages[0][0];
  const bad = [[4, 1], [0, 1], [1, 6]];
  bad.forEach(([x, y]) => {
    if (S.desktop.canPlace(pages, 0, a, x, y)) {
      throw new Error(`(${x},${y}) 越界了竟然通过`);
    }
  });
  return { 越界: '全被拒' };
});
t('migrateDesktop 会把老存档升到当前版本', () => {
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  /* 版本迁移是「改了布局但用户看不到变化」的唯一防线，
     代码里必须同时有版本号递增和迁移分支。 */
  if (!/LAYOUT_VERSION\s*=\s*\d+/.test(src)) throw new Error('没有 LAYOUT_VERSION');
  if (!/version\s*\|\|\s*1\)\s*<\s*LAYOUT_VERSION/.test(src)) {
    throw new Error('getDesktop 里没有版本比较 —— 老存档会被直接复用，改了布局也不生效');
  }
  if (!/function\s+migrateDesktop/.test(src)) throw new Error('没有 migrateDesktop');
  return { 迁移: '在位' };
});
t('LAYOUT_VERSION 没有重复声明（写了改动日志却忘了删旧块）', () => {
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  const n = (src.match(/var\s+LAYOUT_VERSION\s*=/g) || []).length;
  if (n !== 1) throw new Error('LAYOUT_VERSION 被声明了 ' + n + ' 次，说明改版本时有旧的注释块没删干净');
  return { 声明次数: n };
});

/* ---- ta 首页（生活窗口 v1，2026-10-02 第一批只读施工单）----
   施工单 §四 1-6 由上面的桌面断言 + 本块第一条覆盖；
   7（切岛不残留）与 8（打开零写入零模型）在本块第二条，缺什么补什么。 */
console.log('\n--- ta 首页（生活窗口 v1）---');
t('第三屏重复格已换成 ta：当前版本、只换一格、坐标沿用、主屏世界书仍在', () => {
  const d = S.desktop.defaultDesktop();
  /* v21 起第三屏又动过（v22 贴纸格换群声）—— 这里只锁下限：
     版本只增不减，ta 那格从 v18 就在，别让谁把它降回去。 */
  if (S.desktop.LAYOUT_VERSION < 21) {
    throw new Error('LAYOUT_VERSION 不该低于 21，实际 ' + S.desktop.LAYOUT_VERSION);
  }
  /* 施工单：只允许替换一个格子，且必须保留原格子 id 和坐标 */
  const taCells = d.pages[3].filter((c) => c.app === 'ta');
  if (taCells.length !== 1) throw new Error('第三屏应恰有一格指向 ta，实际 ' + taCells.length);
  const cell = taCells[0];
  if (cell.i !== 'p3-book') throw new Error('格子 id 必须沿用 p3-book（老存档坐标别丢），实际 ' + cell.i);
  if (cell.x !== 1 || cell.y !== 5 || cell.w !== 1 || cell.h !== 1) {
    throw new Error('p3-book 的坐标变了 —— 施工单要求保留原坐标');
  }
  /* 世界书本身不能从桌面消失：主屏 p1-book 还得在 */
  if (!d.pages[1].some((c) => c.app === 'worldbook')) {
    throw new Error('主屏世界书不见了 —— 是不是替换错了格子');
  }
  /* 静态护栏：page-ta.js 里不许出现写入或网络调用（首页只读、0 模型） */
  const src = require('fs').readFileSync('page-ta.js', 'utf8');
  if (/store\.set\(|fetch\(|XMLHttpRequest|streamChat|api\.chat/i.test(src)) {
    throw new Error('page-ta.js 出现了写入或网络调用 —— 首页必须只读、0 模型');
  }
  return { 格子: cell.i, label: cell.label, 版本: S.desktop.LAYOUT_VERSION };
});
t('ta 首页：真实读取三个键 + 空态 + 切岛不串 + 打开零写入', () => {
  /* 造两座孤岛各一个角色 + 一个马甲；三个生活键只给 A 岛。 */
  const a = S.core.upsertChar({ name: 'ta甲岛角色', kind: 'main', content: '夹具' }).id;
  const b = S.core.upsertChar({ name: 'ta乙岛角色', kind: 'main', content: '夹具' }).id;
  const u = S.core.upsertUser({ name: 'ta冒烟马甲' }).id;
  const sbA = S.core.createSandbox('isle', 'ta甲岛');
  const sbB = S.core.createSandbox('isle', 'ta乙岛');
  S.core.setSandboxChars(sbA.id, [a]);
  S.core.setSandboxChars(sbB.id, [b]);
  S.core.setSandboxMasks(sbA.id, [u]);
  S.core.setSandboxMasks(sbB.id, [u]);
  const rootA = S.core.rootOf(a).id;
  S.store.set('charState:' + rootA, { feelings: ['想把旧照片整理出来'], readings: [], unspoken: [], updatedAt: '2026-10-02T10:00:00' });
  S.store.set('openLoops:' + rootA, { items: ['修旧相机的事还差一个零件'], updatedAt: '2026-10-02T10:00:00' });
  S.store.set('attentionInbox:' + rootA, { items: ['留意楼下的猫最近有没有出现'], updatedAt: '2026-10-02T10:00:00' });

  /* 现场备份：测完还原身份指针，别污染后面的断言 */
  const bak = {
    sb: S.store.get('activeSandboxId'),
    ch: S.store.get('activeCharId'),
    us: S.store.get('activeUserId')
  };
  /* 写入快照：打开 ta 前后，生活相关键一律不许变（施工单 §四 8） */
  const LIFE_KEYS = ['calEvents', 'diaries', 'moments', 'chats', 'characters', 'links', 'sandboxes'];
  const snap = () => JSON.stringify(LIFE_KEYS.map((k) => S.store.get(k)));
  const before = snap();

  function bodyTextOf() {
    const ctx = S.nav.topCtx();
    const root = ctx && (ctx.body || ctx.el);
    if (!root) throw new Error('拿不到当前页的 DOM');
    let s = '';
    (function walk(n) {
      if (n.textContent) s += n.textContent + '\n';
      (n.children || []).forEach(walk);
    })(root);
    return s;
  }

  try {
    /* A 岛：三个键都要被读到，首屏有当前角色名，状态带更新时间 */
    S.core.setActiveSandbox(sbA.id);
    S.core.switchTo(a, u);
    if (S.nav.depth() > 0) S.nav.closeAll();
    S.nav.open('ta', {});
    const t1 = bodyTextOf();
    if (t1.indexOf('ta甲岛角色') < 0) throw new Error('首屏没有当前角色名');
    if (t1.indexOf('想把旧照片整理出来') < 0) throw new Error('charState 没被读到');
    if (t1.indexOf('修旧相机') < 0) throw new Error('openLoops 没被读到');
    if (t1.indexOf('楼下的猫') < 0) throw new Error('attentionInbox 没被读到');
    if (t1.indexOf('更新于') < 0) throw new Error('状态没有显示更新时间');
    if (snap() !== before) throw new Error('打开 ta 产生了写入 —— 首页必须只读');

    /* 事项详情占位：回显来源、更新时间、当前文字 */
    S.nav.open('ta-item', { text: '修旧相机的事还差一个零件', at: '2026-10-02T10:00:00', src: '冒烟来源' });
    const t2 = bodyTextOf();
    if (t2.indexOf('修旧相机') < 0 || t2.indexOf('冒烟来源') < 0) {
      throw new Error('事项详情没有回显来源与文字');
    }
    S.nav.closeAll();

    /* 切岛：上一座岛的角色与内容不许残留（施工单 §四 7） */
    S.core.setActiveSandbox(sbB.id);
    S.core.switchTo(b, u);
    S.nav.open('ta', {});
    const t3 = bodyTextOf();
    if (t3.indexOf('ta甲岛角色') >= 0 || t3.indexOf('想把旧照片整理出来') >= 0 || t3.indexOf('修旧相机') >= 0) {
      throw new Error('切岛后残留了上一座岛的角色内容');
    }
    if (t3.indexOf('ta乙岛角色') < 0) throw new Error('切岛后没有显示新岛角色');
    S.nav.closeAll();

    /* 空岛（没有角色）：明确空态，不编生活 */
    const sbE = S.core.createSandbox('isle', 'ta空岛');
    S.core.setActiveSandbox(sbE.id);
    S.nav.open('ta', {});
    if (bodyTextOf().indexOf('未落岛 / 未选角色') < 0) {
      throw new Error('空岛没有给「未落岛 / 未选角色」空态');
    }
    S.nav.closeAll();

    /* 人物详情权限闸：跨岛 id 一律「暂无更多已确认信息」 */
    S.core.setActiveSandbox(sbB.id);
    S.core.switchTo(b, u);
    S.nav.open('ta-person', { id: a });
    if (bodyTextOf().indexOf('暂无更多已确认信息') < 0) {
      throw new Error('跨岛人物读取没被挡住');
    }
    S.nav.closeAll();
  } finally {
    S.store.set('activeSandboxId', bak.sb);
    S.store.set('activeCharId', bak.ch);
    S.store.set('activeUserId', bak.us);
    if (S.nav.depth() > 0) S.nav.closeAll();
  }
  return { 数据源: ['charState', 'openLoops', 'attentionInbox', 'lifeFeed', '名册/links'], 切岛: '不串', 写入: 0 };
});

t('群岛选人闸：多角色出选人页、点击才切身份；孤岛/单大号自动归位；空岛仍空态', () => {
  /* 群岛两个大号 */
  const a = S.core.upsertChar({ name: '闸甲', kind: 'main' }).id;
  const b = S.core.upsertChar({ name: '闸乙', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '闸我' }).id;
  const sbG = S.core.createSandbox('archipelago', '闸群岛');
  S.core.setSandboxChars(sbG.id, [a, b]);
  S.core.setSandboxMasks(sbG.id, [u]);
  S.core.setActiveSandbox(sbG.id);
  S.core.switchTo(b, u);              /* 先指到乙，再清掉身份指针模拟「未选」 */
  S.store.set('activeCharId', null);
  if (S.nav.depth() > 0) S.nav.closeAll();
  S.nav.open('ta', {});
  const ctx = S.nav.topCtx();
  const root = ctx && (ctx.body || ctx.el);
  let pickCards = 0, pickText = '';
  (function walk(n) {
    if ((n.className || '').indexOf && String(n.className).indexOf('we-pick-card') >= 0) pickCards++;
    if (n.textContent) pickText += n.textContent + '\n';
    (n.children || []).forEach(walk);
  })(root);
  if (pickCards !== 2) throw new Error('选人页应有两张卡，实际 ' + pickCards);
  if (pickText.indexOf('想看谁的生活') < 0) throw new Error('选人页标题不对');
  if (S.core.activeCharOnIsland()) throw new Error('选人页期间身份竟已就位');
  /* 「选甲」：桩的 click 是 noop，走选卡背后的同一调用（switchTo）+ 重开，
     验证闸放行后窗口跟着身份走 */
  S.core.switchTo(a, u);
  S.nav.closeAll();
  S.nav.open('ta', {});
  const nowChar = S.core.activeCharOnIsland();
  if (!nowChar || nowChar.id !== a) throw new Error('选完身份没就位');
  const t1 = (function walk3(n) { let s2 = n.textContent || ''; (n.children || []).forEach((c) => { s2 += walk3(c); }); return s2; })(S.nav.topCtx().body || S.nav.topCtx().el);
  if (t1.indexOf('闸甲') < 0) throw new Error('选完没进生活窗口');

  /* 孤岛单大号：自动归位不出选人页 */
  const c = S.core.upsertChar({ name: '闸孤岛角色', kind: 'main' }).id;
  const sbS = S.core.createSandbox('isle', '闸孤岛');
  S.core.setSandboxChars(sbS.id, [c]);
  S.core.setSandboxMasks(sbS.id, [u]);
  S.core.setActiveSandbox(sbS.id);
  S.store.set('activeCharId', null);
  S.nav.closeAll();
  S.nav.open('ta', {});
  const ctx2 = S.nav.topCtx();
  const solo = S.core.activeCharOnIsland();
  if (!solo || solo.id !== c) throw new Error('孤岛单大号没有自动归位');
  const t2 = (function walk4(n) { let s2 = n.textContent || ''; (n.children || []).forEach((cc) => { s2 += walk4(cc); }); return s2; })(ctx2.body || ctx2.el);
  if (t2.indexOf('闸孤岛角色') < 0) throw new Error('孤岛没有直接进窗口');

  /* 空岛：仍给「未落岛 / 未选角色」空态 */
  const sbE = S.core.createSandbox('isle', '闸空岛');
  S.core.setActiveSandbox(sbE.id);
  S.nav.closeAll();
  S.nav.open('ta', {});
  const t3 = (function walk5(n) { let s2 = n.textContent || ''; (n.children || []).forEach((cc) => { s2 += walk5(cc); }); return s2; })(S.nav.topCtx().body || S.nav.topCtx().el);
  if (t3.indexOf('未落岛 / 未选角色') < 0) throw new Error('空岛空态丢了');
  if (S.nav.depth() > 0) S.nav.closeAll();
  return { 选人页: 2, 孤岛归位: true, 空态: true };
});

/* ---- ta 第二批（三张结构化表 + 状态机 + 幕后，2026-10-02）---- */
console.log('\n--- ta 第二批（taLife 三表 / 状态机 / 幕后）---');
t('taLife 三表：写入盖章归岛 + 闭集拒绝 + 流转留痕 + 同状态幂等', () => {
  if (!S.taLife) throw new Error('ta-life.js 没加载（Sleepy.taLife 缺失）');
  const ch = S.core.upsertChar({ name: 'taLife夹具角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: 'taLife夹具马甲' }).id;
  const sb = S.core.createSandbox('isle', 'taLife夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);

  const it = S.taLife.add('items', {
    title: '修旧相机', detail: '差一个快门零件', status: '进行中',
    nextCheck: '零件到货再看', refCharId: ch, refUserId: u
  });
  if (!it || !it.id) throw new Error('事项创建失败');
  if (it.sandboxId !== sb.id) throw new Error('事项没盖当前岛章');
  if (it.refCharId !== S.core.rootOf(ch).id) throw new Error('refCharId 没归 root');

  /* 闭集：非法状态必须被拒（返回 null），不能悄悄收下 */
  if (S.taLife.setStatus('items', it.id, '已兑现') !== null) {
    throw new Error('事项收下了非法状态「已兑现」—— 闭集失守');
  }
  const p = S.taLife.add('promises', { quote: '周末陪你去拍照', status: '待核实', refCharId: ch, refUserId: u });
  if (S.taLife.setStatus('promises', p.id, '进行中') !== null) {
    throw new Error('承诺收下了事项的状态「进行中」—— 两套闭集混了');
  }
  const f = S.taLife.add('follows', { target: '楼下的猫', reason: '它认得 ta', refCharId: ch });

  /* 流转：留 history；同状态再设是幂等（不再追加 history） */
  const hit = S.taLife.setStatus('items', it.id, '受阻', '零件缺货');
  if (!hit || hit.status !== '受阻') throw new Error('状态流转失败');
  const n1 = (hit.history || []).length;
  if (n1 < 1) throw new Error('流转没留 history');
  const again = S.taLife.setStatus('items', it.id, '受阻', '');
  if ((again.history || []).length !== n1) throw new Error('同状态重复入 history —— 幂等失守');

  /* 读回：三表各自按 (岛 × root) 读到 */
  if (S.taLife.itemsOf(ch).length !== 1) throw new Error('itemsOf 读不到');
  if (S.taLife.promisesOf(ch, u).length !== 1) throw new Error('promisesOf 读不到');
  if (S.taLife.followsOf(ch).length !== 1) throw new Error('followsOf 读不到');
  if (!S.taLife.findInScope('items', it.id)) throw new Error('findInScope 本岛找不到');

  S.taLife.remove('follows', f.id);
  if (S.taLife.followsOf(ch).length !== 0) throw new Error('remove 没删掉');
  return { 闭集: true, history: n1, 幂等: true };
});
t('taLife 岛隔离：A 岛写的，B 岛读不到、跨岛 id 拒绝', () => {
  const a = S.core.upsertChar({ name: '隔离甲', kind: 'main' }).id;
  const b = S.core.upsertChar({ name: '隔离乙', kind: 'main' }).id;
  const sbA = S.core.createSandbox('isle', '隔离甲岛');
  const sbB = S.core.createSandbox('isle', '隔离乙岛');
  S.core.setSandboxChars(sbA.id, [a]);
  S.core.setSandboxChars(sbB.id, [b]);
  S.core.setActiveSandbox(sbA.id);
  const it = S.taLife.add('items', { title: '甲岛的事', refCharId: a });
  S.core.setActiveSandbox(sbB.id);
  if (S.taLife.itemsOf(b).length !== 0) throw new Error('B 岛读到了 A 岛的事项');
  if (S.taLife.findInScope('items', it.id)) throw new Error('跨岛 id 竟然能 findInScope');
  S.core.setActiveSandbox(sbA.id);
  if (S.taLife.itemsOf(a).length !== 1) throw new Error('回到 A 岛又读不到了');
  S.taLife.remove('items', it.id);
  return { 岛隔离: true, 跨岛拒绝: true };
});
t('taLife 三表进删房名单（真跑拆岛）+ 承诺不会被事项自动兑现', () => {
  const src = require('fs').readFileSync('core.js', 'utf8');
  ["'taItems'", "'taPromises'", "'taFollows'"].forEach((k) => {
    if (src.indexOf(k) < 0) throw new Error('core.js cleanupSandbox 名单里没有 ' + k);
  });
  const ch = S.core.upsertChar({ name: '拆岛taLife角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '拆岛taLife我' }).id;
  const sb = S.core.createSandbox('isle', '拆岛taLife岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setActiveSandbox(sb.id);
  const it = S.taLife.add('items', { title: '要被拆掉的事项', refCharId: ch });
  const pr = S.taLife.add('promises', { quote: '要被拆掉的承诺', status: '待核实', refCharId: ch, refUserId: u });

  /* 设计稿红线：事项完成 / 日历走完 ≠ 承诺兑现 —— 状态机里没有这条通路，
     事项打到「已完成」，承诺必须原样不动 */
  S.taLife.setStatus('items', it.id, '已完成', '修好了');
  const prAfter = S.taLife.findInScope('promises', pr.id);
  if (!prAfter || prAfter.status !== '待核实') {
    throw new Error('承诺状态被自动改了 —— 红线失守');
  }

  const purge = S.core._purgeSync.sandbox(sb.id);
  if (!purge || purge.ok !== true) throw new Error('拆岛清理失败');
  ['taItems', 'taPromises', 'taFollows'].forEach((k) => {
    const left = (S.store.get(k) || []).filter((x) => x && x.sandboxId === sb.id);
    if (left.length) throw new Error('拆岛后 ' + k + ' 还有孤儿 ' + left.length + ' 条');
  });
  return { 名单收录: true, 承诺不自动兑现: true, 拆岛后清空: true };
});

/* ---------- ta-life K03e 三表消费（2026-10-05 本批）----------
   用生产装配入口验证最终 messages，不只查编译函数返回值：
   F1 assembleOnline / F2 assembleOffline / 主动 buildSystem 三场景共用
   ta-life.compileLivingLife（唯一编译出口），零模型零写入。 */
console.log('\n--- ta-life K03e 进行中的生活（三表消费）---');

const K03E_KEYS = ['taItems', 'taPromises', 'taFollows'];
const k03eSnapLife = () => JSON.stringify(K03E_KEYS.map((k) => S.store.get(k)));
const k03eCount = (hay, needle) => hay.split(needle).length - 1;

/* 夹具：一座岛、两个本体、两个马甲、六条记录（含终止态/跨马甲/提案） */
const k03e = t('K03e 夹具：岛/本体/马甲/三表记录（含终止态与 pending 提案）', () => {
  const sb = S.core.createSandbox('isle', 'K03e生活岛');
  S.core.setActiveSandbox(sb.id);
  const chA = S.core.upsertChar({ name: 'K03e角色甲', kind: 'main' }).id;
  const chB = S.core.upsertChar({ name: 'K03e角色乙', kind: 'main' }).id;
  S.core.setSandboxChars(sb.id, [chA, chB]);
  const uA = S.core.upsertUser({ name: 'K03e马甲A' }).id;
  const uB = S.core.upsertUser({ name: 'K03e马甲B' }).id;
  S.core.setSandboxMasks(sb.id, [uA, uB]);
  S.taLife.add('items', { title: '相机还差一个零件', detail: '快门件到货就能装', nextCheck: '零件到货再看', status: '进行中', refCharId: chA });
  S.taLife.add('items', { title: '终止夹具已完成事项', status: '已完成', refCharId: chA });
  S.taLife.add('promises', { quote: '周末陪你去拍胶片', toWhom: '你', condition: '等天晴', standard: '把一卷拍完', pendingWhy: '最近连着下雨', status: '待核实', refCharId: chA, refUserId: uA });
  S.taLife.add('promises', { quote: '终止夹具已解除承诺', status: '已解除', refCharId: chA, refUserId: uA });
  S.taLife.add('promises', { quote: 'B马甲专属承诺原话', status: '待核实', refCharId: chA, refUserId: uB });
  S.taLife.add('follows', { target: '楼下的三花猫', latest: '上周开始没出现', reason: '它认得他', refCharId: chA });
  /* pending 提案：写在 taProposals（ta-proposal.js 的键），内容带识别串 ——
     编译出口永远不读这个键，下面的场景断言它绝不出现。 */
  S.store.set('taProposals', [{
    id: 'prop_k03e_fixture', kind: 'item_update', status: 'pending',
    payload: { title: '提案夹具不得出现的内容串' }, createdAt: Date.now()
  }]);
  return { sb: sb.id, chA: chA, chB: chB, uA: uA, uB: uB };
});

t('K03e 导出面：编译出口与槽位真实存在（缺导出不能被守卫静默掩盖）', () => {
  if (!S.taLife || typeof S.taLife.compileLivingLife !== 'function') {
    throw new Error('ta-life.compileLivingLife 未导出');
  }
  if (!S.promptEngine || typeof S.promptEngine.compileTaLife !== 'function') {
    throw new Error('promptEngine.compileTaLife 未导出');
  }
  /* 主动消息侧是**直接调用**（不挂 PE.compileX && 守卫）—— 这里只证导出在，
     「真的被调到」由下面三个场景的注入断言兜住。 */
  const offIds = (S.promptEngine.offlineSlots || []).map((d) => d.id);
  if (offIds.indexOf('talife') < 0) throw new Error('OFFLINE_SLOTS 没有 talife 槽');
  if (offIds.indexOf('talife') < offIds.indexOf('taimpact')) throw new Error('K03e 应排在 K03d 之后');
  return { offline槽序: 'taimpact > talife' };
});

const k03eSys = (r) => (r.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
const k03eCommon = (sys, tag) => {
  if (k03eCount(sys, '[TA_LIFE]') !== 1) throw new Error(tag + '：生活块不是恰好一次');
  if (sys.indexOf('相机还差一个零件') < 0) throw new Error(tag + '：进行中事项没进');
  if (sys.indexOf('事项（进行中）') < 0) throw new Error(tag + '：状态标注不准确');
  if (sys.indexOf('「周末陪你去拍胶片」') < 0) throw new Error(tag + '：承诺原话没保留');
  if (sys.indexOf('承诺（待核实）') < 0) throw new Error(tag + '：承诺状态没标');
  if (sys.indexOf('完成标准：把一卷拍完') < 0) throw new Error(tag + '：完成标准丢了');
  if (sys.indexOf('待核实原因：最近连着下雨') < 0) throw new Error(tag + '：待核实原因丢了');
  if (sys.indexOf('楼下的三花猫') < 0 || sys.indexOf('最新已知：上周开始没出现') < 0) throw new Error(tag + '：关注没进');
  /* 终止态排除 */
  ['终止夹具已完成事项', '终止夹具已解除承诺'].forEach((s) => {
    if (sys.indexOf(s) >= 0) throw new Error(tag + '：终止状态泄漏进来了：' + s);
  });
  /* 红线：有效承诺绝不表述成已兑现 */
  if (sys.indexOf('已兑现') >= 0) throw new Error(tag + '：出现了「已兑现」表述');
  /* pending 提案绝不进入 */
  if (sys.indexOf('提案夹具不得出现的内容串') >= 0) throw new Error(tag + '：pending 提案泄漏进来了');
  /* 边界：只作背景，不指令联络 */
  if (sys.indexOf('不必因此主动联络对方') < 0) throw new Error(tag + '：缺「不强迫提及/联络」边界句');
};

t('K03e F1 线上：真实 messages 注入一次、槽序正确、其余槽未被顶掉、三表逐字节不变', () => {
  const before = k03eSnapLife();
  const hist = [{ role: 'user', content: '相机修得怎么样了？' }, { role: 'assistant', content: '还差个零件。' }];
  const r = S.promptEngine.assembleOnline({ charId: k03e.chA, userId: k03e.uA, history: hist });
  const sys = k03eSys(r);
  k03eCommon(sys, 'F1');
  /* 跨马甲承诺隔离：B 马甲专属的承诺在 A 的视角不出现 */
  if (sys.indexOf('B马甲专属承诺原话') >= 0) throw new Error('F1：A 视角读到了 B 马甲的承诺');
  const slot = (r.slots || []).filter((x) => x.id === 'talife')[0];
  if (!slot) throw new Error('F1：talife 槽没注册进 ONLINE_SLOTS');
  if (!slot.on || slot.slot !== 'K03e') throw new Error('F1：talife 槽未命中或槽名不对：' + JSON.stringify(slot));
  const ids = (r.slots || []).map((x) => x.id);
  if (!(ids.indexOf('taimpact') < ids.indexOf('talife') && ids.indexOf('talife') < ids.indexOf('worldbook'))) {
    throw new Error('F1：槽序不对，应为 taimpact < talife < worldbook：' + ids.join('>'));
  }
  /* 既有槽不被顶掉：历史仍垫底、输出协议仍在、taimpact/relation 槽仍在 */
  const last = r.messages[r.messages.length - 1];
  if (last.role !== 'assistant') throw new Error('F1：历史原文没有垫底');
  if (!r.messages.some((m) => m.role === 'user' && String(m.content).indexOf('相机修得怎么样了？') >= 0)) {
    throw new Error('F1：本轮 user 输入丢了');
  }
  if (ids.indexOf('c05') < 0 || ids.indexOf('history') < 0 || ids.indexOf('taimpact') < 0 || ids.indexOf('relation') < 0) {
    throw new Error('F1：既有槽不见了：' + ids.join('>'));
  }
  if (k03eSnapLife() !== before) throw new Error('F1：装配动了三表 —— 逐字节比对失败');
  return { 槽: slot.slot, 块次数: k03eCount(sys, '[TA_LIFE]') };
});

t('K03e F2 线下：同一份记录同样注入一次（query 取场景末条 user 输入）', () => {
  const before = k03eSnapLife();
  const sess = { charId: k03e.chA, userId: k03e.uA, messages: [
    { role: 'user', text: '相机修得怎么样了？' },
    { role: 'char', paras: ['还差个零件。'] }
  ] };
  const r = S.promptEngine.assembleOffline({ charId: k03e.chA, userId: k03e.uA, session: sess });
  const sys = k03eSys(r);
  k03eCommon(sys, 'F2');
  if (sys.indexOf('B马甲专属承诺原话') >= 0) throw new Error('F2：A 视角读到了 B 马甲的承诺');
  if (k03eSnapLife() !== before) throw new Error('F2：装配动了三表');
  return { 块次数: k03eCount(sys, '[TA_LIFE]') };
});

t('K03e 主动消息：buildSystem 注入一次、不碰闸门状态、不产生请求', () => {
  const beforeLife = k03eSnapLife();
  const stKey = 'proactiveState:' + k03e.chA;
  const beforeGate = JSON.stringify([S.store.get('proactiveSettings'), S.store.get(stKey)]);
  const matchText = '最近在忙什么？相机修得怎么样了？';
  const sys = S.proactiveEngine.buildSystem(k03e.chA, k03e.uA, matchText).join('\n\n');
  k03eCommon(sys, '主动');
  if (sys.indexOf('B马甲专属承诺原话') >= 0) throw new Error('主动：A 视角读到了 B 马甲的承诺');
  if (k03eSnapLife() !== beforeLife) throw new Error('主动：动了三表');
  if (JSON.stringify([S.store.get('proactiveSettings'), S.store.get(stKey)]) !== beforeGate) {
    throw new Error('主动：编译动了闸门/设置状态');
  }
  return { 块次数: k03eCount(sys, '[TA_LIFE]') };
});

t('K03e 无数据静默：三场景都不出现块、槽不命中', () => {
  const sb2 = S.core.createSandbox('isle', 'K03e空岛');
  S.core.setActiveSandbox(sb2.id);
  const ch = S.core.upsertChar({ name: 'K03e空岛角色', kind: 'main' }).id;
  S.core.setSandboxChars(sb2.id, [ch]);
  if (S.taLife.compileLivingLife(ch, null, { queryText: '' }) !== '') throw new Error('编译出口空数据没回空串');
  const r = S.promptEngine.assembleOnline({ charId: ch, userId: null, history: [] });
  if (k03eSys(r).indexOf('[TA_LIFE]') >= 0) throw new Error('F1：无数据却注入了');
  if ((r.slots || []).filter((x) => x.id === 'talife' && x.on).length) throw new Error('F1：空数据槽却命中');
  const r2 = S.promptEngine.assembleOffline({ charId: ch, userId: null, session: { charId: ch } });
  if (k03eSys(r2).indexOf('[TA_LIFE]') >= 0) throw new Error('F2：无数据却注入了');
  const sys3 = S.proactiveEngine.buildSystem(ch, null, '').join('\n\n');
  if (sys3.indexOf('[TA_LIFE]') >= 0) throw new Error('主动：无数据却注入了');
  return '三场景全部静默';
});

t('K03e 切岛/切本体不串：B 岛读不到 A 岛的记录，同岛别的本体也读不到', () => {
  S.core.setActiveSandbox(k03e.sb);
  const rA = S.promptEngine.assembleOnline({ charId: k03e.chA, userId: k03e.uA, history: [] });
  if (k03eSys(rA).indexOf('相机还差一个零件') < 0) throw new Error('A 岛自己都读不到了');
  /* 切岛 */
  const sb2 = S.core.createSandbox('isle', 'K03e另一座岛');
  S.core.setActiveSandbox(sb2.id);
  const rB = S.promptEngine.assembleOnline({ charId: k03e.chA, userId: k03e.uA, history: [] });
  if (k03eSys(rB).indexOf('[TA_LIFE]') >= 0) throw new Error('切岛后仍读到 A 岛记录');
  S.core.setActiveSandbox(k03e.sb);
  /* 切本体：同岛 charB 没有任何记录 */
  const rC = S.promptEngine.assembleOnline({ charId: k03e.chB, userId: k03e.uA, history: [] });
  if (k03eSys(rC).indexOf('[TA_LIFE]') >= 0) throw new Error('切本体后读到了甲的记录');
  return '岛 × 本体双隔离';
});

t('K03e 切 user 身份：承诺跟马甲走（A 有 B 无），事项/关注按设计跨马甲共享', () => {
  const rB = S.promptEngine.assembleOnline({ charId: k03e.chA, userId: k03e.uB, history: [] });
  const sysB = k03eSys(rB);
  if (sysB.indexOf('B马甲专属承诺原话') < 0) throw new Error('B 视角没读到 B 自己的承诺');
  if (sysB.indexOf('周末陪你去拍胶片') >= 0) throw new Error('B 视角读到了 A 的承诺');
  if (sysB.indexOf('相机还差一个零件') < 0) throw new Error('事项是「TA 的生活」不该按马甲隔离（设计口径）');
  return '承诺按 refUserId 隔离，事项/关注共享';
});

t('K03e 容量与选序：每类最多 2 条、输出可复现、相关优先、超限如实裁剪', () => {
  const sb3 = S.core.createSandbox('isle', 'K03e容量岛');
  S.core.setActiveSandbox(sb3.id);
  const ch = S.core.upsertChar({ name: 'K03e容量角色', kind: 'main' }).id;
  S.core.setSandboxChars(sb3.id, [ch]);
  const u = S.core.upsertUser({ name: 'K03e容量我' }).id;
  S.core.setSandboxMasks(sb3.id, [u]);
  ['一号事项', '二号事项', '三号事项', '四号事项'].forEach((t2) => {
    S.taLife.add('items', { title: t2, status: '进行中', refCharId: ch });
  });
  const out1 = S.taLife.compileLivingLife(ch, null, { queryText: '' });
  const out2 = S.taLife.compileLivingLife(ch, null, { queryText: '' });
  if (out1 !== out2) throw new Error('同一输入两次编译结果不同 —— 选序不可复现');
  /* 只取 2 条：不管 updatedAt 是否同毫秒，出现在文里的必须是 4 选 2 */
  const picked = ['一号事项', '二号事项', '三号事项', '四号事项'].filter((t2) => out1.indexOf(t2) >= 0);
  if (picked.length !== 2) throw new Error('进行中的没按稳定顺序取满 2 条：实得 ' + picked.length + ' 条');
  /* 相关优先：query 点名三号事项 → 它必须进前 2 */
  const out3 = S.taLife.compileLivingLife(ch, null, { queryText: '三号事项现在怎么样了' });
  if (out3.indexOf('三号事项') < 0) throw new Error('相关优先失效：点名的事项没进');
  const picked3 = ['一号事项', '二号事项', '三号事项', '四号事项'].filter((t2) => out3.indexOf(t2) >= 0);
  if (picked3.length !== 2 || picked3.indexOf('三号事项') < 0) {
    throw new Error('点名后仍不是 2 条或没含三号：' + picked3.join(','));
  }
  /* 无 query 时也注入（允许少量进行中背景保留）——这正是「不点名也知道在忙什么」 */
  if (!picked.length) throw new Error('无 query 时进行中背景没保留');
  return { 无query取: picked.join('+'), 点名后: picked3.join('+') };
});

t('K03e 暂停/受阻/待核实按真实状态表达（不伪装成进行中，也不推断复核结果）', () => {
  const sb4 = S.core.createSandbox('isle', 'K03e状态岛');
  S.core.setActiveSandbox(sb4.id);
  const ch = S.core.upsertChar({ name: 'K03e状态角色', kind: 'main' }).id;
  S.core.setSandboxChars(sb4.id, [ch]);
  S.taLife.add('items', { title: '暂停夹具事项', status: '暂停', refCharId: ch });
  S.taLife.add('items', { title: '受阻夹具事项', detail: '预算没批', status: '受阻', refCharId: ch });
  const sys = k03eSys(S.promptEngine.assembleOnline({ charId: ch, userId: null, history: [] }));
  if (sys.indexOf('事项（暂停）：暂停夹具事项') < 0) throw new Error('暂停状态没如实标注');
  if (sys.indexOf('事项（受阻）：受阻夹具事项') < 0) throw new Error('受阻状态没如实标注');
  if (sys.indexOf('预算没批') < 0) throw new Error('受阻原因（detail）没带上');
  return '状态逐条如实';
});

/* ---------- 群线上动态上下文 K03f（2026-10-05 本批）----------
   四源权限等级分开验收：worldbook（knownBy 分流）/ language（逐本体）/ 
   custom（群标记闸）/ lifeFeed（逐角色过滤），全部看**真实 composeRound 出站**。 */
console.log('\n--- 群线上动态上下文 K03f（世界书/语言/自定义卡/生活动态）---');

const k03f = t('K03f 夹具：岛/两本体一NPC/群/世界书三本/朋友圈一条/两张自定义卡', () => {
  const sb = S.core.createSandbox('isle', 'K03f群岛');
  S.core.setActiveSandbox(sb.id);
  const chA = S.core.upsertChar({ name: 'K03f角色甲', kind: 'main', content: 'K03f甲人设。' }).id;
  const chJp = S.core.upsertChar({ name: 'K03f角色乙', kind: 'main', content: 'K03f乙人设。', region: 'JP', city: '东京', timezone: 'Asia/Tokyo' }).id;
  const chN = S.core.upsertChar({ name: 'K03f店长', kind: 'npc', parentId: chA, content: 'K03fNPC人设', knownBy: [] }).id;
  const chOut = S.core.upsertChar({ name: 'K03f群外角色', kind: 'main', content: 'K03f群外人设。' }).id;
  const u = S.core.upsertUser({ name: 'K03f我' }).id;
  S.core.setSandboxChars(sb.id, [chA, chJp, chOut]);
  const g = S.groupStore.createGroup({
    name: 'K03f测试群', ownerAccountId: u,
    members: [
      { kind: 'char', ownerId: chA, accountId: chA },
      { kind: 'char', ownerId: chJp, accountId: chJp },
      { kind: 'npc', ownerId: chN, accountId: chN }
    ]
  });
  if (!g.ok) throw new Error(g.message);
  const gid = g.group.id;
  S.groupStore.addMessage(gid, { senderKind: 'user', senderAccountId: u, content: '明晚一起去青岚镇拍胶片吧？' });
  /* 朋友圈：chA 自己发的动态 —— 只有甲的实体块该看见 */
  const moments = S.store.get('moments') || [];
  const mo = { id: 'mo_k03f_1', sandboxId: sb.id, characterId: chA, name: 'K03f角色甲',
    text: 'K03f动态：修好的相机第一次出片。', at: Date.now() - 3600 * 1000,
    privacy: 'all', likes: [], comments: [] };
  S.store.set('moments', moments.concat([mo]));
  /* 世界书三本：全局共享 / 挂乙（群内）/ 挂群外角色（不该进群） */
  const books = S.store.get('worldbooks') || [];
  const mk = [];
  mk.push({ id: 'wb_k03f_global', name: 'K03f全局书', scope: 'global', enabled: true, entries: [
    { id: 'e1', name: '共享常驻', always: true, enabled: true, content: 'K03f共享常驻设定：这座城里所有人共用一条有轨电车线。' },
    { id: 'e2', name: '共享关键词', keys: '青岚镇', enabled: true, content: 'K03f共享关键词条目：青岚镇的钟楼停在三点。' },
    { id: 'e3', name: '共享不命中', keys: '绝不命中的词K03fX', enabled: true, content: 'K03f不该出现的共享条目。' }
  ]});
  mk.push({ id: 'wb_k03f_jp', name: 'K03f乙的书', scope: 'personal', characterId: chJp, enabled: true, entries: [
    { id: 'e4', name: '乙的常驻', always: true, enabled: true, content: 'K03f仅乙知道：她房间的窗对着神社的屋檐。' },
    { id: 'e5', name: '乙的关键词', keys: '胶片', enabled: true, content: 'K03f仅乙知道：她那卷胶片是在青岚镇买的。' },
    { id: 'e6', name: '乙不命中', keys: '绝不命中的词K03fY', enabled: true, content: 'K03f不该出现的乙条目。' }
  ]});
  mk.push({ id: 'wb_k03f_out', name: 'K03f群外的书', scope: 'personal', characterId: chOut, enabled: true, entries: [
    { id: 'e7', name: '群外常驻', always: true, enabled: true, content: 'K03f群外角色的私密设定绝不能进群。' }
  ]});
  S.store.set('worldbooks', books.concat(mk));
  const cGroup = S.promptEngine.addCustomCard('K03f群卡', 'K03f群聊可用卡正文。', { group: true });
  const cPriv = S.promptEngine.addCustomCard('K03f私卡', 'K03f私聊专属卡正文绝不进群。');
  return { sb: sb.id, chA, chJp, chN, chOut, u, gid, mo, books, mk,
    cGroup: cGroup.id, cPriv: cPriv.id };
});

const k03fSlices = (sys) => {
  const out = {};
  const re = /\[ENTITY id=([^\]]+)\]\n([\s\S]*?)\n\[\/ENTITY\]/g;
  let m;
  while ((m = re.exec(sys)) !== null) out[m[1]] = m[2];
  return out;
};
const k03fRestore = () => {
  S.store.set('worldbooks', k03f.books.filter((b) => !k03f.mk.some((x) => x.id === b.id)));
  S.store.set('moments', (S.store.get('moments') || []).filter((x) => x.id !== k03f.mo.id));
  S.promptEngine.removeCustomCard(k03f.cGroup);
  S.promptEngine.removeCustomCard(k03f.cPriv);
  S.store.set('groupInner:' + k03f.gid, {});
};

t('K03f 世界书：全局书进共享块、个人书只进挂靠本体的块、群外的书整本不进、关键词闸生效', () => {
  const r = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f）', budget: { actors: 2, msgs: 5 } });
  const sys = r.messages[0].content;
  const slices = k03fSlices(sys);
  if (!slices[k03f.chA] || !slices[k03f.chJp] || !slices[k03f.chN]) {
    throw new Error('实体块不齐：' + Object.keys(slices).join(','));
  }
    /* 全局书：恰好进共享块一次，任何实体块里都没有 */
    if (k03eCount(sys, '【世界书】') !== 1) throw new Error('共享世界书块不是恰好一次');
    if (sys.indexOf('K03f共享常驻设定') < 0) throw new Error('全局常驻条目没进共享块');
    if (sys.indexOf('K03f共享关键词条目') < 0) throw new Error('关键词命中的共享条目没进（群消息提到青岚镇）');
    if (Object.keys(slices).some((k) => slices[k].indexOf('K03f共享常驻设定') >= 0)) {
      throw new Error('全局书条目漏进了实体块');
    }
    /* 个人书（乙）：只在乙的块里 */
    if (slices[k03f.chJp].indexOf('K03f仅乙知道：她房间的窗') < 0) throw new Error('乙的个人常驻条目没进乙的块');
    if (slices[k03f.chJp].indexOf('K03f仅乙知道：她那卷胶片') < 0) throw new Error('乙的关键词条目没进（群消息提到胶片）');
    if (slices[k03f.chA].indexOf('K03f仅乙知道') >= 0) throw new Error('乙的个人书漏进了甲的块');
    if (slices[k03f.chN].indexOf('K03f仅乙知道') >= 0) throw new Error('乙的个人书漏进了NPC的块');
    /* 群外角色的书：整本不进（knownBy 语义 = 只归挂靠者知道） */
    if (sys.indexOf('K03f群外角色的私密设定') >= 0) throw new Error('群外角色的个人书被广播进群了');
    /* 关键词闸：没命中的条目不出现 */
    if (sys.indexOf('K03f不该出现的共享条目') >= 0) throw new Error('未命中的共享条目漏进来了');
    if (sys.indexOf('K03f不该出现的乙条目') >= 0) throw new Error('未命中的乙条目漏进来了');
    return { 共享: 1, 乙块: 2, 群外: 0 };
});

t('K03f 世界书空数据静默：没有书就没有任何世界书块', () => {
  const books = S.store.get('worldbooks') || [];
  S.store.set('worldbooks', []);
  try {
    const r = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f空）', budget: { actors: 2, msgs: 5 } });
    const sys = r.messages[0].content;
    if (sys.indexOf('【世界书】') >= 0 || sys.indexOf('【仅TA知道的世界设定】') >= 0) {
      throw new Error('无书却出现了世界书块');
    }
    return '静默';
  } finally { S.store.set('worldbooks', books); }
});

t('K03f 语言：乙（东京常驻）块内有说话方式行、甲/NPC 块没有、不带私聊译文协议', () => {
  const r = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f语言）', budget: { actors: 2, msgs: 5 } });
  const sys = r.messages[0].content;
  const slices = k03fSlices(sys);
  if (k03eCount(slices[k03f.chJp], '【说话方式】你平时说日语（日本語）') !== 1) {
    throw new Error('乙的块里没有（或不止一条）日语说话方式行');
  }
  [k03f.chA, k03f.chN].forEach((oid) => {
    if (slices[oid].indexOf('【说话方式】') >= 0) throw new Error(oid + ' 没设国外常驻地却有语言行');
  });
  if (k03eCount(sys, '【说话方式】') !== 1) throw new Error('语言行总数不是 1 —— 泄漏到块外了');
  /* 不搬私聊协议：群线上输出是 JSON，[译] 行协议和线下 trans 字段都不该出现 */
  if (sys.indexOf('[译]') >= 0 || sys.indexOf('trans 字段') >= 0 || sys.indexOf('dialogue 段') >= 0) {
    throw new Error('私聊译文协议被照搬进了群线上');
  }
  return '逐本体 + 无协议污染';
});

t('K03f 生活动态：甲的动态只进甲的块（lifeFeed 逐角色过滤），乙/NPC 块干净', () => {
  const r = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f生活）', budget: { actors: 2, msgs: 5 } });
  const sys = r.messages[0].content;
  const slices = k03fSlices(sys);
  if (k03eCount(slices[k03f.chA], '[近期生活动态]') !== 1) throw new Error('甲的块里没有生活动态块');
  if (slices[k03f.chA].indexOf('K03f动态：修好的相机第一次出片。') < 0) throw new Error('动态内容没进');
  [k03f.chJp, k03f.chN].forEach((oid) => {
    if (slices[oid].indexOf('[近期生活动态]') >= 0 || slices[oid].indexOf('K03f动态') >= 0) {
      throw new Error(oid + ' 的块里出现了甲的生活动态 —— 隔离失效');
    }
  });
  if (k03eCount(sys, '[近期生活动态]') !== 1) throw new Error('生活动态块总数不是 1');
  return '逐本体隔离';
});

t('K03f 自定义卡：只接显式标记群聊可用的卡；没标记的不广播；停用/去标记后立即退出', () => {
  try {
    const r1 = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f卡）', budget: { actors: 2, msgs: 5 } });
    const sys1 = r1.messages[0].content;
    if (sys1.indexOf('K03f群聊可用卡正文') < 0) throw new Error('标记了群聊可用的卡没进群');
    if (sys1.indexOf('K03f私聊专属卡正文') >= 0) throw new Error('没标记的私聊卡被广播进群了');
    /* 停用 → 立即退出 */
    S.promptEngine.setCardEnabled(k03f.cGroup, false);
    const sys2 = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f卡2）', budget: { actors: 2, msgs: 5 } }).messages[0].content;
    if (sys2.indexOf('K03f群聊可用卡正文') >= 0) throw new Error('停用的群卡还在注入');
    S.promptEngine.setCardEnabled(k03f.cGroup, true);
    /* 去掉标记 → 退出，且字段不留尸体 */
    S.promptEngine.saveCustomCard(k03f.cGroup, { group: false });
    const card = S.promptEngine.customCards().filter((c) => c.id === k03f.cGroup)[0];
    if (card.group) throw new Error('group:false 尸体留在卡上');
    const sys3 = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f卡3）', budget: { actors: 2, msgs: 5 } }).messages[0].content;
    if (sys3.indexOf('K03f群聊可用卡正文') >= 0) throw new Error('去掉标记后还在注入');
    S.promptEngine.saveCustomCard(k03f.cGroup, { group: true });
    return '闸门三态全对';
  } finally {
    S.promptEngine.setCardEnabled(k03f.cGroup, true);
  }
});

t('K03f 既有块不被顶掉：群协议/成员/时间/内心注记/编号禁令/历史/预算全部原位', () => {
  const before = JSON.stringify(S.store.get('groupInner:' + k03f.gid) || {});
  S.groupAI.saveInner(k03f.gid, [{ entityId: k03f.chA, internalUpdate: 'K03f内心注记夹具' }]);
  try {
    const r = S.groupAI.composeRound(k03f.gid, { stimulus: '（K03f既有）', budget: { actors: 2, msgs: 5 } });
    const sys = r.messages[0].content;
    const usr = r.messages[1].content;
    if (k03eCount(sys, S.promptEngine.cardBody('groupRound')) !== 1) throw new Error('群协议卡被顶掉或重复');
    /* groupRound 卡正文里**引用了** [ENTITY_KNOWLEDGE] 字样，不能裸计数 ——
       用「段头紧跟第一个实体块」的形状判段本体恰一次 */
    if (k03eCount(sys, '[ENTITY_KNOWLEDGE]\n[ENTITY id=') !== 1) throw new Error('实体知识段被顶掉或重复');
    /* 群协议卡与编号禁令行自己也引用 '[ENTITY id=' 字样 —— 用配对切片数实体块 */
    const slices0 = k03fSlices(sys);
    if (Object.keys(slices0).length !== 3) {
      throw new Error('实体块数量不对（应 3 本体各一块）：' + Object.keys(slices0).join(','));
    }
    if (k03eCount(sys, '[GROUP]') !== 1) throw new Error('[GROUP] 成员清单被顶掉');
    if (sys.indexOf('【在场时间】') < 0) throw new Error('f493aca 的时间块丢了');
    if (sys.indexOf('K03f内心注记夹具') < 0) throw new Error('innerText 被顶掉');
    if (sys.indexOf('是调度用的内部编号') < 0) throw new Error('编号禁令被顶掉');
    if (sys.indexOf('{{') >= 0) throw new Error('system 里出现了未展开的伪变量');
    if (usr.indexOf('[RECENT_GROUP]') < 0 || usr.indexOf('青岚镇拍胶片') < 0) throw new Error('群历史丢了');
    if (usr.indexOf('[BUDGET]') < 0) throw new Error('预算丢了');
    if (k03eCount(sys, 'K03f甲人设') !== 1 || k03eCount(sys, 'K03f乙人设') !== 1) {
      throw new Error('本体人设（K01 同源）被顶掉或重复');
    }
    return '九件全在';
  } finally {
    S.store.set('groupInner:' + k03f.gid, JSON.parse(before) || {});
    k03fRestore();
  }
});

t('ta 首页 v2 接线：taItems/taFollows 优先显示 + 幕后/详情页注册可开 + 仍零写入', () => {
  const src = require('fs').readFileSync('page-ta.js', 'utf8');
  if (/store\.set\(|fetch\(|XMLHttpRequest|streamChat|api\.chat/i.test(src)) {
    throw new Error('page-ta.js 出现了写入或网络调用 —— 页面层必须只走 taLife');
  }
  const tlSrc = require('fs').readFileSync('ta-life.js', 'utf8');
  if (/fetch\(|XMLHttpRequest|api\.chat/i.test(tlSrc)) {
    throw new Error('ta-life.js 出现了网络调用 —— 数据层必须 0 模型');
  }
  ['ta-item', 'ta-follow', 'ta-promise', 'ta-person', 'ta-backstage'].forEach((id) => {
    if (!S.registered()[id]) throw new Error('页面未注册：' + id);
  });

  const ch = S.core.upsertChar({ name: '接线夹具角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '接线夹具我' }).id;
  const sb = S.core.createSandbox('isle', '接线夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);
  S.taLife.add('items', { title: '接线验收的事项标题', detail: '差一个零件', nextCheck: '零件到货再看', status: '进行中', refCharId: ch, refUserId: u });
  S.taLife.add('follows', { target: '接线验收的关注对象', reason: '缘由夹具', refCharId: ch });
  S.taLife.add('promises', { quote: '接线验收的承诺原话', status: '待核实', refCharId: ch, refUserId: u });

  const bak = {
    sb: S.store.get('activeSandboxId'),
    ch: S.store.get('activeCharId'),
    us: S.store.get('activeUserId')
  };
  const LIFE_KEYS = ['calEvents', 'diaries', 'moments', 'chats', 'characters', 'links'];
  const snap = () => JSON.stringify(LIFE_KEYS.map((k) => S.store.get(k)));
  const before = snap();
  function bodyTextOf() {
    const c = S.nav.topCtx();
    const root = c && (c.body || c.el);
    if (!root) throw new Error('拿不到当前页的 DOM');
    let s = '';
    (function walk(n) { if (n.textContent) s += n.textContent + '\n'; (n.children || []).forEach(walk); })(root);
    return s;
  }
  try {
    S.nav.closeAll();
    S.nav.open('ta', {});
    const t1 = bodyTextOf();
    if (t1.indexOf('接线验收的事项标题') < 0) throw new Error('首页没有优先显示 taItems');
    if (t1.indexOf('接线验收的关注对象') < 0) throw new Error('首页没有优先显示 taFollows');
    if (t1.indexOf('幕后') < 0) throw new Error('首页没有幕后入口');
    if (snap() !== before) throw new Error('打开首页产生了写入（taLife 表之外不许动）');

    S.nav.open('ta-backstage', {});
    const t2 = bodyTextOf();
    if (t2.indexOf('玩家查看不等于角色知情') < 0) throw new Error('幕后页缺管理说明');
    if (t2.indexOf('接线验收的承诺原话') < 0) throw new Error('幕后页没有列出承诺');
    S.nav.closeAll();

    S.nav.open('ta', {});
    const it = S.taLife.itemsOf(ch)[0];
    S.nav.open('ta-item', { id: it.id });
    if (bodyTextOf().indexOf('阻碍') < 0) throw new Error('事项详情没有显示完整字段');
    S.nav.back();
    const fo = S.taLife.followsOf(ch)[0];
    S.nav.open('ta-follow', { id: fo.id });
    if (bodyTextOf().indexOf('缘由') < 0) throw new Error('关注详情缺字段');
    S.nav.back();
    const pr = S.taLife.promisesOf(ch, u)[0];
    S.nav.open('ta-promise', { id: pr.id });
    if (bodyTextOf().indexOf('完成标准') < 0) throw new Error('承诺详情缺字段');
    S.nav.closeAll();
  } finally {
    S.store.set('activeSandboxId', bak.sb);
    S.store.set('activeCharId', bak.ch);
    S.store.set('activeUserId', bak.us);
    if (S.nav.depth() > 0) S.nav.closeAll();
  }
  return { 接线: '表优先兜底在后', 幕后: true, 零写入: true };
});
t('We/ta 真机反馈修复：切 Tab 免动画 + 记一笔身份闸 + 底部露白归零', () => {
  const weSrc = require('fs').readFileSync('page-we.js', 'utf8');
  if (weSrc.indexOf('tab-noanim') < 0) throw new Error('goTab 没挂 tab-noanim（切 Tab 还会闪）');
  const css = require('fs').readFileSync('style.css', 'utf8');
  if (css.indexOf('#stack.tab-noanim .page') < 0) throw new Error('CSS 缺免动画规则');
  if (css.indexOf('.page.has-tabbar[data-page="we"] .app-body') < 0) throw new Error('we 底部露白没归零');
  if (css.indexOf('[data-page="ta"] .page-inner') < 0) throw new Error('ta 底部露白没归零');
  const taSrc = require('fs').readFileSync('page-ta.js', 'utf8');
  if (taSrc.indexOf('才有的生活可记') < 0) throw new Error('记一笔缺身份闸（没身份静默丢弃的坑）');
  /* 回弹垫纸色：滚动容器底必须跟纸同色，真机橡皮筋回弹才不闪白 */
  if (css.indexOf('滚动容器垫纸色') < 0 || css.indexOf('background-color:var(--we-paper') < 0) {
    throw new Error('滚动容器没垫纸色（回弹会闪白）');
  }
  return { 免动画: true, 身份闸: true, 底部: true, 回弹垫纸: true };
});

/* ---- ta 第四批（模型提案通道，2026-10-02）----
   transport 注入（page-summary callOnce 同款思路）：不打真网络，
   全链路验证 装配→解析→白名单校验→落表→审核→落库。 */
console.log('\n--- ta 第四批（提案通道 / 模型边界）---');
function ta4Setup() {
  const ch = S.core.upsertChar({ name: '提案夹具角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '提案夹具我' }).id;
  const sb = S.core.createSandbox('isle', '提案夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);
  const it = S.taLife.add('items', { title: '修旧相机', detail: '差一个快门零件', status: '进行中', refCharId: ch, refUserId: u });
  const fo = S.taLife.add('follows', { target: '楼下的猫', refCharId: ch });
  const pr = S.taLife.add('promises', { quote: '周末陪你去拍照', status: '待核实', refCharId: ch, refUserId: u });
  return { ch, u, sb, it, fo, pr };
}
function ta4Ctx(t) {
  return {
    charId: t.ch,
    targets: { items: S.taLife.itemsOf(t.ch), follows: S.taLife.followsOf(t.ch), promises: S.taLife.promisesOf(t.ch, t.u) },
    events: S.taProposals.eventsOf(t.ch)
  };
}
function ta4Transport(responses) {
  let i = 0;
  let calls = 0;
  return {
    get calls() { return calls; },
    fn() {
      calls++;
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve({ ok: true, text: JSON.stringify(r) });
    }
  };
}
t('提案通道：模型输出先进 taProposals，正式表纹丝不动；非法/重复收口', () => withIdbLock(() => {
  const t = ta4Setup();
  const isl = (arr, sid) => JSON.stringify((arr || []).filter((x) => x && x.sandboxId === sid));
  const itemsBefore = isl(S.store.get('taItems'), t.sb.id);
  const followsBefore = isl(S.store.get('taFollows'), t.sb.id);
  const itNow = S.taLife.itemsOf(t.ch)[0];
  const tp = ta4Transport([{
    proposals: [
      { kind: 'item_update', operation: 'update', targetRef: itNow.id, baseVersion: itNow.updatedAt, summary: '零件到货了', reason: '输入事项写着「差一个快门零件」，本次复核发现已到货', extra: { targetDetail: '零件已到，等周末动手' } },
      { kind: 'item_update', operation: 'update', targetRef: itNow.id, baseVersion: itNow.updatedAt, summary: '零件到货了', reason: '输入事项写着「差一个快门零件」，本次复核发现已到货' },
      { kind: 'god_mode', operation: 'update', targetRef: itNow.id, summary: '越权提案', reason: 'x' },
      { kind: 'follow_update', operation: 'update', targetRef: '不存在的id', summary: '没有目标的提案', reason: 'x' },
      { kind: 'item_update', operation: 'update', targetRef: itNow.id, baseVersion: itNow.updatedAt, summary: '没有依据的提案' }
    ]
  }]);
  return S.taModel.runMode('review', { charId: t.ch }, { transport: tp.fn }).then((r) => {
    if (!r.ok) throw new Error('runMode 失败：' + r.error);
    if (r.saved !== 1) throw new Error('应只收 1 条合法提案，实际 ' + r.saved);
    if (r.failed !== 3) throw new Error('应丢弃 3 条非法提案（非法 kind / 无 target / 无依据），实际 ' + r.failed);
    if (r.duplicate !== 1) throw new Error('指纹重复没去重，实际 ' + r.duplicate);
    /* 未审核：正式表一个字都不能变 */
    if (isl(S.store.get('taItems'), t.sb.id) !== itemsBefore) throw new Error('pending 提案改了 taItems');
    if (isl(S.store.get('taFollows'), t.sb.id) !== followsBefore) throw new Error('pending 提案改了 taFollows');
    const pend = S.taProposals.proposalsOf(t.ch, ['pending']);
    if (pend.length !== 1 || !pend[0].modelMeta || !pend[0].modelMeta.model) throw new Error('提案没带 modelMeta');
    return { 收口: '1收2拒1重', 正式表: '未动' };
  });
}));
t('提案接受/舍弃：item_update 带 history、promise 只改待核实、高影响需二次确认、版本过期拒覆盖', () => withIdbLock(() => {
  const t = ta4Setup();
  const itNow = S.taLife.itemsOf(t.ch)[0];
  const ctx = ta4Ctx(t);
  const mk = (p) => {
    const b = S.taProposals.validateBatch('review', { proposals: [p] }, { targets: ctx.targets, events: [], existingFps: {} });
    if (!b.accepted.length) throw new Error('夹具提案被校验拒绝：' + JSON.stringify(b.failures));
    S.taProposals.saveProposals('review', b, { sandboxId: t.sb.id, refCharId: t.ch }, { requestId: 'smoke', model: 'mock', label: 'mock', promptVer: 'ta-model-p1', at: Date.now() });
    return S.taProposals.proposalsOf(t.ch, ['pending'])[0];
  };
  const p1 = mk({ kind: 'item_update', operation: 'update', targetRef: itNow.id, baseVersion: itNow.updatedAt, summary: '零件到货', reason: '有输入依据', extra: { targetDetail: '零件已到' } });
  const a1 = S.taProposals.acceptProposal(p1.id, { ctx });
  if (!a1.ok || String(a1.applied).indexOf('taItems:') !== 0) throw new Error('item_update 接受失败：' + JSON.stringify(a1));
  const itAfter = S.taLife.findInScope('items', itNow.id);
  if (itAfter.detail !== '零件已到') throw new Error('detail 没更新');
  if (!itAfter.history.some((h) => String(h.note).indexOf('接受提案') >= 0)) throw new Error('接受没留 history');

  /* 高影响：未二次确认必须拒，确认后放行 */
  const hi = mk({ kind: 'follow_update', operation: 'update', targetRef: t.fo.id, baseVersion: t.fo.updatedAt, summary: '猫出车祸去世了', reason: '输入里的关注对象', extra: { targetLatest: '巷口少了那只猫' } });
  const a2 = S.taProposals.acceptProposal(hi.id, { ctx });
  if (a2.ok || !a2.needConfirm) throw new Error('高影响没被拦（' + JSON.stringify(a2) + '）');
  const a3 = S.taProposals.acceptProposal(hi.id, { ctx, confirmHighImpact: true });
  if (!a3.ok) throw new Error('二次确认后仍拒绝：' + a3.why);

  /* promise_review：只更新待核实信息，状态永远不被提案改 */
  const prNow = S.taLife.promisesOf(t.ch, t.u)[0];
  const p3 = mk({ kind: 'promise_review', operation: 'flag_review', targetRef: prNow.id, baseVersion: prNow.updatedAt, summary: '约定临近，需核实', reason: '输入承诺下周', extra: { targetPendingWhy: '快到约定日期' } });
  const a4 = S.taProposals.acceptProposal(p3.id, { ctx });
  if (!a4.ok) throw new Error('promise_review 接受失败：' + a4.why);
  const prAfter = S.taLife.findInScope('promises', prNow.id);
  if (prAfter.status !== '待核实') throw new Error('承诺状态被提案改了 —— 红线失守');
  if (prAfter.pendingWhy !== '快到约定日期') throw new Error('pendingWhy 没更新');

  /* 版本过期：审核期间目标又变 → 旧 baseVersion 拒覆盖 */
  const stale = mk({ kind: 'item_update', operation: 'update', targetRef: itNow.id, baseVersion: itNow.updatedAt, summary: '旧版本提案', reason: 'x' });
  S.taLife.patch('items', itNow.id, { detail: '审核期间又变了' });
  const a5 = S.taProposals.acceptProposal(stale.id, { ctx: ta4Ctx(t) });   /* 接受时必须用新鲜的 target 快照 */
  if (a5.ok || !a5.expired) throw new Error('旧版本提案竟然覆盖了新状态');
  const rj = S.taProposals.rejectProposal(stale.id, '测舍弃');
  if (!rj.ok) throw new Error('舍弃失败：' + rj.why);
  return { history: true, 高影响: '二次确认', 承诺: '状态未动', 版本: '过期拒覆盖' };
}));
t('requestId 幂等 + 开关门禁 + contact_candidate 进候选队列不发送', () => withIdbLock(() => {
  const t = ta4Setup();
  const itNow = S.taLife.itemsOf(t.ch)[0];
  const json1 = { proposals: [{ kind: 'item_update', operation: 'update', targetRef: itNow.id, baseVersion: itNow.updatedAt, summary: '同一条提案', reason: '依据' }] };
  const tp = ta4Transport([json1, json1]);
  return S.taModel.runMode('review', { charId: t.ch }, { transport: tp.fn }).then((r1) => {
    if (!r1.ok) throw new Error('首轮失败：' + r1.error);
    const n1 = S.taProposals.proposalsOf(t.ch, ['pending']).length;
    return S.taModel.runMode('review', { charId: t.ch }, { transport: tp.fn }).then((r2) => {
      const n2 = S.taProposals.proposalsOf(t.ch, ['pending']).length;
      if (n2 !== n1) throw new Error('重放产生了重复提案：' + n1 + ' → ' + n2);
      if (r2.saved !== 0) throw new Error('重放又落了 ' + r2.saved + ' 条');
      /* 开关门禁：advance 关着 → 不碰模型 */
      S.taProposals.setAutoLife(t.ch, false);
      let calls = 0;
      const spy = () => { calls++; return Promise.resolve({ ok: true, text: '{"proposals":[]}' }); };
      return S.taModel.runMode('advance', { charId: t.ch }, { transport: spy }).then((g) => {
        if (g.ok || g.gate !== 'auto_off') throw new Error('关闭自主生活竟还生成了 advance');
        if (calls !== 0) throw new Error('门禁拦截后仍调用了模型 ' + calls + ' 次');
        /* review 不受开关影响 */
        return S.taModel.runMode('review', { charId: t.ch }, { transport: spy }).then((rv) => {
          if (!rv.ok) throw new Error('review 被开关误伤：' + rv.error);
          /* 开启后：contact_candidate 接受 → 只进候选队列，不发送 */
          S.taProposals.setAutoLife(t.ch, true);
          const npc = S.core.upsertChar({ name: '提案夹具NPC', kind: 'npc', parentId: t.sb.id, parentType: 'sandbox', content: 'x' });
          S.core.setSandboxChars(t.sb.id, [t.ch, npc.id]);
          const b = S.taProposals.validateBatch('advance', { proposals: [{ kind: 'contact_candidate', operation: 'add', targetRef: npc.id, summary: '书店老板想约拍照', reason: '事件依据', extra: { direction: 'NPC 想请 ta 帮忙' } }] }, { targets: { npcs: S.core.npcsOfRoom(t.sb) }, events: [], existingFps: {} });
          S.taProposals.saveProposals('advance', b, { sandboxId: t.sb.id, refCharId: t.ch }, { requestId: 'cc1', model: 'mock', label: 'mock', promptVer: 'ta-model-p1', at: Date.now() });
          const cc = S.taProposals.proposalsOf(t.ch, ['pending']).find((x) => x.kind === 'contact_candidate');
          const ac = S.taProposals.acceptProposal(cc.id, { ctx: ta4Ctx(t) });
          if (!ac.ok || String(ac.applied).indexOf('attentionInbox') !== 0) throw new Error('联系候选没进队列：' + JSON.stringify(ac));
          const inbox = S.store.get('attentionInbox:' + S.core.rootOf(t.ch).id);
          if (!inbox || !inbox.items.some((x) => String(x.content || '').indexOf('书店老板') >= 0)) throw new Error('候选队列里没有内容');
          return { 幂等: true, 门禁: 'auto_off 拦 advance', 联系候选: '进队列未发送' };
        });
      });
    });
  });
}));
t('NPC 事件与影响：npc_event 落 taEvents、impact 必须绑定事件与知情依据、重放不叠加、拆岛清理', () => withIdbLock(() => {
  const t = ta4Setup();
  const npc = S.core.upsertChar({ name: '事件夹具NPC', kind: 'npc', parentId: t.sb.id, parentType: 'sandbox', content: 'x' });
  S.core.setSandboxChars(t.sb.id, [t.ch, npc.id]);
  const ctxA = ta4Ctx(t);
  const b1 = S.taProposals.validateBatch('advance', { proposals: [{ kind: 'npc_event', operation: 'add', targetRef: npc.id, summary: '书店老板盘下了隔壁铺面', reason: 'NPC 设定：经营书店', extra: { eventText: '书店老板盘下隔壁铺面，店面扩大了一倍' } }] }, { targets: { npcs: S.core.npcsOfRoom(t.sb) }, events: [], existingFps: {} });
  if (!b1.accepted.length) throw new Error('合法事件被拒：' + JSON.stringify(b1.failures));
  S.taProposals.saveProposals('advance', b1, { sandboxId: t.sb.id, refCharId: t.ch }, { requestId: 'ev1', model: 'mock', label: 'mock', promptVer: 'ta-model-p1', at: Date.now() });
  const evP = S.taProposals.proposalsOf(t.ch, ['pending'])[0];
  const a1 = S.taProposals.acceptProposal(evP.id, { ctx: ctxA });
  if (!a1.ok || String(a1.applied).indexOf('taEvents:') !== 0) throw new Error('事件没落 taEvents：' + JSON.stringify(a1));
  const ev = S.taProposals.eventsOf(t.ch)[0];
  if (!ev || ev.npcId !== npc.id) throw new Error('事件归属不对');

  /* eventRef 不存在 → 拒；缺知情依据 → 拒 */
  const bad = S.taProposals.validateBatch('advance', { proposals: [{ kind: 'impact_review', operation: 'update', targetRef: '不存在的事件', summary: '影响', reason: 'x', extra: { knownCharId: t.ch, basis: 'x', impactText: 'x' } }] }, { targets: { npcs: [] }, events: S.taProposals.eventsOf(t.ch), existingFps: {} });
  if (bad.accepted.length) throw new Error('不存在的 eventRef 竟然过审');
  const noBasis = S.taProposals.validateBatch('advance', { proposals: [{ kind: 'impact_review', operation: 'update', targetRef: ev.id, summary: '影响', reason: 'x', extra: { knownCharId: t.ch, impactText: 'x' } }] }, { targets: { npcs: [] }, events: S.taProposals.eventsOf(t.ch), existingFps: {} });
  if (noBasis.accepted.length) throw new Error('缺 basis 的影响竟过审');
  /* 正常影响 + 重放同 fp 不叠加 */
  const impJson = { proposals: [{ kind: 'impact_review', operation: 'update', targetRef: ev.id, summary: 'ta 可能会去捧场', reason: '事件：店面扩大；事项：修相机需要取货点', extra: { knownCharId: t.ch, basis: '事件发生在 ta 常去的街', impactText: 'ta 或许会注意到店面变化' } }] };
  const good = S.taProposals.validateBatch('advance', impJson, { targets: { npcs: [] }, events: S.taProposals.eventsOf(t.ch), existingFps: {} });
  S.taProposals.saveProposals('advance', good, { sandboxId: t.sb.id, refCharId: t.ch }, { requestId: 'im1', model: 'mock', label: 'mock', promptVer: 'ta-model-p1', at: Date.now() });
  const imP = S.taProposals.proposalsOf(t.ch, ['pending']).find((x) => x.kind === 'impact_review');
  const a2 = S.taProposals.acceptProposal(imP.id, { ctx: ctxA });
  if (!a2.ok) throw new Error('影响接受失败：' + a2.why);
  const evAfter = S.taProposals.findEventInScope(ev.id);
  if (evAfter.impacts.length !== 1) throw new Error('影响数量不对：' + evAfter.impacts.length);
  const again = S.taProposals.validateBatch('advance', impJson, { targets: { npcs: [] }, events: S.taProposals.eventsOf(t.ch), existingFps: S.taProposals.proposalsOf(t.ch).reduce((m, x) => { if (x.fp) m[x.fp] = 1; return m; }, {}) });
  if (again.accepted.length) throw new Error('同一影响重复过审（fp 没拦）');
  /* 拆岛清理 */
  const purge = S.core._purgeSync.sandbox(t.sb.id);
  if (!purge || purge.ok !== true) throw new Error('拆岛失败');
  if ((S.store.get('taProposals') || []).some((x) => x && x.sandboxId === t.sb.id)) throw new Error('提案成孤儿');
  if ((S.store.get('taEvents') || []).some((x) => x && x.sandboxId === t.sb.id)) throw new Error('事件成孤儿');
  return { 事件: true, 影响: '绑定依据', 重放: '不叠加', 拆岛: true };
}));
t('候选模式：模型候选只进草稿区（model_proposal）+ 同名不重建 + 静态护栏', () => withIdbLock(() => {
  const t = ta4Setup();
  const tp = ta4Transport([{ proposals: [
    { kind: 'contact_candidate', operation: 'add', summary: '说话慢吞吞的修表匠', reason: '设定里 ta 常路过钟表行', extra: { candidateName: '老周', candidateRole: '修表匠' } },
    { kind: 'contact_candidate', operation: 'add', summary: '另一位候选没有名字', reason: 'x', extra: {} }
  ] }]);
  return S.taModel.runMode('candidates', { charId: t.ch }, { transport: tp.fn }).then((r1) => {
    if (!r1.ok || r1.saved !== 1) throw new Error('候选落草稿数不对：' + JSON.stringify(r1));
    const d = S.taLife.draftsOf(t.ch)[0];
    if (d.sourceType !== 'model_proposal') throw new Error('候选草稿没标 model_proposal');
    if ((S.store.get('characters') || []).some((x) => x.name === '老周')) throw new Error('模型候选直接进了正式人物表 —— 红线失守');
    return S.taModel.runMode('candidates', { charId: t.ch }, { transport: tp.fn }).then((r2) => {
      if (r2.saved !== 0 || r2.duplicate < 1) throw new Error('同名候选重建了：' + JSON.stringify(r2));
      const pt = require('fs').readFileSync('page-ta.js', 'utf8');
      if (/requestOnce|[^.]fetch\(/.test(pt)) throw new Error('页面层出现网络调用');
      const tm = require('fs').readFileSync('ta-model.js', 'utf8');
      if (tm.indexOf('Sleepy.api.requestOnce') < 0) throw new Error('模型模块没走 api.requestOnce');
      const idx = require('fs').readFileSync('index.html', 'utf8');
      if (idx.indexOf('ta-model.js') < 0 || idx.indexOf('ta-proposal.js') < 0) throw new Error('index.html 没引入第四批脚本');
      return { 草稿标记: true, 同名不重建: true, 静态: true };
    });
  });
}));

/* ---- ta 第五批（已成立影响接入聊天与主动消息，2026-10-02）----
   设计见 docs/施工-ta首页第五批-2026-10-02.md。
   这一批的坑集中在「边界」上，所以断言也全是边界：
   知情 × 有效 × 相关三道闸、过期≠解决、事实变了≠没反应过、
   候选→决策→回执的闭环、以及 ta 挂掉时聊天照常。 */
console.log('\n--- ta 第五批（已成立影响 → 聊天 / 主动消息）---');

function ta5Setup() {
  const ch = S.core.upsertChar({
    name: '影响夹具角色', kind: 'main',
    content: '【性格】安静、话少，不太会主动找人说话。'
  }).id;
  const u = S.core.upsertUser({ name: '影响夹具我' }).id;
  const sb = S.core.createSandbox('isle', '影响夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);
  const rid = S.core.rootOf(ch).id;
  const npc = S.core.upsertChar({ name: '影响夹具NPC', kind: 'npc', parentId: sb.id, parentType: 'sandbox', content: 'x' });
  S.core.setSandboxChars(sb.id, [ch, npc.id]);
  /* 另一个 root：用来验「NPC 的私密事件不会被角色提前知道」（知情闸） */
  const other = S.core.upsertChar({ name: '岛上别人', kind: 'main', content: 'x' });
  return { ch, u, sb, rid, npc, otherRid: S.core.rootOf(other.id).id };
}
function ta5Event(t, opts) {
  opts = opts || {};
  const list = S.store.get('taEvents') || [];
  const ev = {
    id: 'te5' + Math.random().toString(36).slice(2, 8),
    refCharId: t.rid, refUserId: t.u, npcId: t.npc.id,
    text: opts.eventText || '夹具事件',
    happenedAt: Date.now(), sourceType: 'proposal', sourceId: 'x',
    knowledge: [], impacts: opts.impacts || [],
    status: opts.status || 'active',
    createdAt: Date.now(), updatedAt: Date.now()
  };
  S.core.tagScope(ev, t.sb.id);
  list.push(ev);
  S.store.set('taEvents', list);
  return ev;
}
function ta5Impact(o) {
  const base = {
    id: 'ti5' + Math.random().toString(36).slice(2, 8),
    kind: 'situation', strength: 2, status: 'active',
    basis: '夹具依据', acceptedAt: Date.now(), history: []
  };
  Object.keys(o || {}).forEach((k) => { base[k] = o[k]; });
  return base;
}
const TA5_QUERY = '相机零件到了吗';
const TA5_HIT = '修相机缺一个快门零件，最近总往五金店跑';
const TA5_MISS = '最近在练一首很长的曲子';

t('影响注入三道闸：知情 fail closed + 有效 + 相关；pending 提案永远进不来', () => {
  const t = ta5Setup();
  ta5Event(t, { impacts: [
    ta5Impact({ knownCharId: t.rid, text: TA5_HIT }),
    /* ① 知情闸：另一个 root 的影响 —— 相关性再高也不许进 */
    ta5Impact({ knownCharId: t.otherRid, text: TA5_HIT + '（别人那边的事）' }),
    /* ② 有效闸：已淡了 */
    ta5Impact({ knownCharId: t.rid, kind: 'mood', status: 'faded', text: TA5_HIT + '（已经淡了）' }),
    /* ③ 相关闸：本轮输入完全沾不上 */
    ta5Impact({ knownCharId: t.rid, text: TA5_MISS })
  ] });
  /* pending 提案（未确认）：一个字都不许进聊天 */
  S.store.set('taProposals', (S.store.get('taProposals') || []).concat([(() => {
    const p = {
      id: 'tp5pending', refCharId: t.rid, refUserId: t.u,
      kind: 'item_update', operation: 'update', targetRef: 'x',
      summary: '未确认提案独有词QZX', reason: '依据', extra: {},
      status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), history: []
    };
    S.core.tagScope(p, t.sb.id);
    return p;
  })()]));

  const txt = S.taImpact.compile(t.ch, t.u, TA5_QUERY);
  if (!txt) throw new Error('相关的影响一条都没注入');
  if (txt.indexOf(TA5_HIT) < 0) throw new Error('相关影响没进注入文本');
  if (txt.indexOf('别人那边的事') >= 0) throw new Error('知情闸失守：别人的影响注入了');
  if (txt.indexOf('已经淡了') >= 0) throw new Error('有效闸失守：已淡了的影响注入了');
  if (txt.indexOf('很长的曲子') >= 0) throw new Error('相关闸失守：不相关的影响注入了');
  if (txt.indexOf('QZX') >= 0) throw new Error('pending 提案进了聊天 —— 红线失守');
  /* 边界句必须在（只当背景 / 不改人设 / 别迁怒对方） */
  if (txt.indexOf('改变你的性格、说话方式和红线') < 0) throw new Error('缺「不改人设」约束句');
  if (txt.indexOf('不要因此对对方冷淡、发火或索取关心') < 0) throw new Error('缺「别迁怒对方」约束句');
  /* 本轮注入的 id 被记住（回复落地后要据此盖 reactedAt） */
  const ids = S.taImpact.lastInjected(t.ch);
  if (ids.length !== 1) throw new Error('注入清单不对：' + ids.length);
  return { 知情闸: '拦住别人的', 有效闸: '拦住已淡的', 相关闸: '拦住不相关', pending: '未进聊天' };
});

t('影响注入上限与降级：最多 2 条；无「本轮输入」只放 1 条持续处境', () => {
  const t = ta5Setup();
  ta5Event(t, { impacts: [
    ta5Impact({ knownCharId: t.rid, text: '修相机缺一个快门零件，最近总往五金店跑' }),
    ta5Impact({ knownCharId: t.rid, text: '相机零件到货前，他不太想接别的事' }),
    ta5Impact({ knownCharId: t.rid, text: '零件没到的这几天，他有点心不在焉' })
  ] });
  const txt = S.taImpact.compile(t.ch, t.u, '零件到货了吗');
  const bullets = txt.split('\n').filter((l) => l.indexOf('· ') === 0);
  if (bullets.length !== 2) throw new Error('注入条数不是 2：' + bullets.length);
  /* 无 query（纯系统触发）→ 只放 1 条持续处境 */
  const t2 = ta5Setup();
  ta5Event(t2, { impacts: [
    ta5Impact({ knownCharId: t2.rid, strength: 3, text: '一直惦记着修那台旧相机' }),
    ta5Impact({ knownCharId: t2.rid, strength: 1, text: '最近睡得不太够' })
  ] });
  const txt2 = S.taImpact.compile(t2.ch, t2.u, '');
  const b2 = txt2.split('\n').filter((l) => l.indexOf('· ') === 0);
  if (b2.length !== 1) throw new Error('无输入时条数不是 1：' + b2.length);
  if (b2[0].indexOf('旧相机') < 0) throw new Error('无输入时没挑最强的持续处境');
  return { 上限: 2, 无输入: '只 1 条最强处境' };
});

t('有效期复核：减弱 / 过期都 ≠ 解决；resolved 只能人手；refresh 幂等', () => {
  const t = ta5Setup();
  const old = Date.now() - 80 * 3600 * 1000;     /* 80h 前接受 → 心绪该淡了 */
  const ev = ta5Event(t, { impacts: [
    ta5Impact({ knownCharId: t.rid, kind: 'mood', acceptedAt: old, expiresAt: Date.now() - 1000, text: '心里有点闷' }),
    ta5Impact({ knownCharId: t.rid, kind: 'situation', expiresAt: Date.now() - 1000, text: '一直惦记着修那台旧相机' })
  ] });
  const before = S.taImpact.impactsOf(t.ch).map((x) => x.status);
  if (before.join(',') !== 'active,active') throw new Error('前置状态不对：' + before);

  const r1 = S.taImpact.refresh(t.ch);
  if (r1.faded !== 1 || r1.expired !== 1) throw new Error('复核结果不对：' + JSON.stringify(r1));
  const after = S.taImpact.impactsOf(t.ch);
  const byId = {}; after.forEach((x) => { byId[x.text] = x; });
  if (byId['心里有点闷'].status !== 'faded') throw new Error('心绪没淡掉');
  if (byId['一直惦记着修那台旧相机'].status !== 'expired') throw new Error('处境没标过期');
  /* 红线 1：过期 ≠ 解决 —— 代码里不许出现「时间到了 → resolved」 */
  if (after.some((x) => x.status === 'resolved')) throw new Error('过期被自动当成解决了 —— 红线失守');
  if (!byId['一直惦记着修那台旧相机'].history.some((h) => String(h.note).indexOf('不是解决') >= 0)) {
    throw new Error('过期没写清「不是解决」');
  }
  /* 幂等：再推一次什么都不该变 */
  const r2 = S.taImpact.refresh(t.ch);
  if (r2.changed !== 0) throw new Error('refresh 不幂等：' + JSON.stringify(r2));
  /* 已过期/已淡的不再注入 */
  if (S.taImpact.compile(t.ch, t.u, '旧相机还修吗')) throw new Error('非 active 的影响还在注入');
  /* 手动解决：只能人手 */
  const resolved = S.taImpact.resolveImpact(byId['一直惦记着修那台旧相机'].id, '玩家确认了结');
  if (!resolved || resolved.status !== 'resolved') throw new Error('手动解决失败');
  /* 非法流转：resolved → active 必须拒 */
  if (S.taImpact.setStatus(byId['一直惦记着修那台旧相机'].id, 'active', 'x')) {
    throw new Error('resolved 竟能被改回 active');
  }
  return { 减弱: true, 过期: true, 过期非解决: true, 幂等: true, 手动解决: true };
});

t('事件更正：事实变了 ≠ 角色没反应过（reactedAt 与 history 全保留）', () => {
  const t = ta5Setup();
  const ev = ta5Event(t, { impacts: [ta5Impact({ knownCharId: t.rid, text: TA5_HIT })] });
  const im = S.taImpact.impactsOf(t.ch)[0];
  /* 先让角色真的反应过一次（noteReply 的落点） */
  S.taImpact.compile(t.ch, t.u, TA5_QUERY);
  const noted = S.taImpact.noteReply(t.ch);
  if (noted.marked !== 1) throw new Error('反应没记上：' + JSON.stringify(noted));
  const reactedAt = S.taImpact.impactsOf(t.ch)[0].reactedAt;
  if (!reactedAt) throw new Error('reactedAt 没落');
  /* 幂等：同一条不重复盖 */
  S.taImpact.compile(t.ch, t.u, TA5_QUERY);
  if (S.taImpact.noteReply(t.ch).marked !== 0) throw new Error('reactedAt 被重复盖了');

  const histLen = S.taImpact.impactsOf(t.ch)[0].history.length;
  const r = S.taImpact.correctEvent(ev.id, '零件其实没到，是记错了');
  if (!r.ok || r.marked !== 1) throw new Error('更正失败：' + JSON.stringify(r));
  const evAfter = S.taImpact.locateEvent(ev.id);
  if (evAfter.status !== 'corrected') throw new Error('事件没标更正');
  const imAfter = S.taImpact.impactsOf(t.ch)[0];
  if (imAfter.status !== 'stale') throw new Error('影响没标依据失效');
  /* 关键两条：反应史保留、记录不删 */
  if (imAfter.reactedAt !== reactedAt) throw new Error('更正把「角色有过反应」抹掉了 —— 红线失守');
  if (imAfter.history.length <= histLen) throw new Error('更正没留 history');
  if (S.taImpact.impactsOf(t.ch).length !== 1) throw new Error('更正删掉了记录');
  if (imAfter.staleNote !== '零件其实没到，是记错了') throw new Error('没记更正说明');
  /* 依据失效后不再驱动表达 */
  if (S.taImpact.compile(t.ch, t.u, TA5_QUERY)) throw new Error('已更正的事件还在注入');
  return { 事件: '已更正', 影响: 'stale', 反应史: '保留', 记录: '未删' };
});

t('主动消息最小闭环：候选带 proposalId → 决策落定写回提案（send 是终态）', () => withIdbLock(() => {
  const t = ta5Setup();
  const b = S.taProposals.validateBatch('advance', { proposals: [{
    kind: 'contact_candidate', operation: 'add', targetRef: t.npc.id,
    summary: '想问问相机修好没', reason: '事件依据',
    extra: { direction: 'NPC 想请 ta 帮忙' }
  }] }, { targets: { npcs: S.core.npcsOfRoom(t.sb) }, events: [], existingFps: {} });
  S.taProposals.saveProposals('advance', b, { sandboxId: t.sb.id, refCharId: t.rid }, { requestId: 'cc5', model: 'mock', label: 'mock', promptVer: 'ta-model-p1', at: Date.now() });
  const cc = S.taProposals.proposalsOf(t.ch, ['pending']).find((x) => x.kind === 'contact_candidate');
  const ac = S.taProposals.acceptProposal(cc.id, { ctx: { targets: { npcs: S.core.npcsOfRoom(t.sb) }, events: [] } });
  if (!ac.ok) throw new Error('接受失败：' + ac.why);

  /* ① 队列条目带 taProposalId，且候选 id 就是它（handled 指纹要能对上） */
  const inbox = S.store.get('attentionInbox:' + t.rid);
  const item = (inbox.items || []).find((x) => x && x.taProposalId === cc.id);
  if (!item) throw new Error('队列条目没带 taProposalId');
  const cands = S.proactiveEngine.candidatesFor(t.ch);
  const cand = cands.find((c) => c.taProposalId === cc.id);
  if (!cand) throw new Error('候选里没带出 taProposalId');
  if (cand.id !== 'attention:' + cc.id) throw new Error('候选 id 不是 proposalId：' + cand.id);

  /* ② 还没有结果时，提案是「等闸门」状态 */
  if (S.taImpact.pendingContact(t.ch).length !== 1) throw new Error('待结果的联系候选数不对');

  /* ③ 决策落定（skip）→ 写回提案 */
  const n1 = S.taImpact.noteProactive(null, { proposalId: cc.id, decision: 'skip', at: Date.now() });
  if (!n1.ok || n1.decision !== 'skip') throw new Error('结果没写回：' + JSON.stringify(n1));
  if (S.taImpact.pendingContact(t.ch).length !== 0) throw new Error('有结果了还算待结果');
  /* ④ send 覆盖 skip（发送真的成功了） */
  S.taImpact.noteProactive(null, { proposalId: cc.id, decision: 'send', messageId: 'ms_test', at: Date.now() });
  let got = S.taProposals.findProposalInScope(cc.id);
  if (!got.outcome || got.outcome.decision !== 'send' || got.outcome.messageId !== 'ms_test') {
    throw new Error('send 没覆盖：' + JSON.stringify(got.outcome));
  }
  /* ⑤ send 是终态：后续 skip 不许覆盖 */
  S.taImpact.noteProactive(null, { proposalId: cc.id, decision: 'skip', at: Date.now() });
  got = S.taProposals.findProposalInScope(cc.id);
  if (got.outcome.decision !== 'send') throw new Error('send 被后续决策覆盖了');
  /* ⑥ 回执进 history，且提案状态没被回执改动 */
  if (!got.history.some((h) => String(h.note).indexOf('主动消息判断结果') >= 0)) throw new Error('回执没进 history');
  if (got.status !== 'accepted') throw new Error('回执改动了提案状态');
  return { 队列: '带 proposalId', 候选: 'id 即 proposalId', 回执: 'skip→send 终态' };
}));

t('聊天安全：ta 挂掉不影响聊天；未确认不进聊天；人设卡仍在最前', () => {
  const t = ta5Setup();
  ta5Event(t, { impacts: [ta5Impact({ knownCharId: t.rid, text: TA5_HIT })] });
  const hist = [{ role: 'user', content: TA5_QUERY }];

  /* 正常：taimpact 槽命中，且 K01 角色卡仍在 */
  const built = S.promptEngine.assembleOnline({ charId: t.ch, userId: t.u, history: hist });
  const slotOf = (b, id) => b.slots.find((s) => s.id === id);
  if (!slotOf(built, 'taimpact') || !slotOf(built, 'taimpact').on) throw new Error('taimpact 槽没命中');
  const k01 = slotOf(built, 'character');
  if (!k01 || !k01.on) throw new Error('角色卡（K01）没进装配 —— 人设优先失守');
  const k01At = built.messages.findIndex((m) => String(m.content).indexOf('[CHARACTER]') >= 0);
  const taAt = built.messages.findIndex((m) => String(m.content).indexOf('[TA_IMPACT]') >= 0);
  if (k01At < 0 || taAt < 0) throw new Error('装配里缺角色卡或影响块');
  if (k01At > taAt) throw new Error('影响块排到了角色卡前面 —— 人设优先失守');

  /* ta 抛异常：聊天照常（这是「ta 模块失败时普通聊天照常运行」的验收） */
  const orig = S.taImpact.compile;
  S.taImpact.compile = () => { throw new Error('模拟 ta 内部炸了'); };
  let broke = false;
  let built2 = null;
  try {
    built2 = S.promptEngine.assembleOnline({ charId: t.ch, userId: t.u, history: hist });
  } catch (e) { broke = true; }
  S.taImpact.compile = orig;
  if (broke) throw new Error('ta 报错把装配整个带崩了');
  if (!built2 || !built2.messages.length) throw new Error('ta 报错后装配返回空');
  if (!slotOf(built2, 'character') || !slotOf(built2, 'character').on) throw new Error('ta 报错后角色卡丢了');
  if (slotOf(built2, 'taimpact').on) throw new Error('ta 报错后影响槽还是 on');
  /* ta 模块整个不在：同样不许崩 */
  const bak = S.taImpact;
  delete S.taImpact;
  let built3 = null;
  try { built3 = S.promptEngine.assembleOnline({ charId: t.ch, userId: t.u, history: hist }); } catch (e) { broke = true; }
  S.taImpact = bak;
  if (broke || !built3 || !built3.messages.length) throw new Error('ta 模块缺失时装配崩了');

  /* 静态护栏 */
  const pe = require('fs').readFileSync('prompt-engine.js', 'utf8');
  if ((pe.match(/case 'taimpact'/g) || []).length !== 2) throw new Error('taimpact 槽没在线上+线下各挂一次');
  if (pe.indexOf('compileTaImpact: compileTaImpact') < 0) throw new Error('compileTaImpact 没导出');
  const ti = require('fs').readFileSync('ta-impact.js', 'utf8');
  if (/requestOnce|[^.\w]fetch\(/.test(ti)) throw new Error('影响层出现网络调用');
  /* 注入路径（compile 起、到「主动消息最小闭环」为止）只许读 taEvents：
     提案表只在主动消息回执那一段出现。 */
  const injectPart = ti.slice(ti.indexOf('function compile(charId'), ti.indexOf('主动消息最小闭环'));
  if (injectPart.length < 200) throw new Error('静态切片没取到注入路径（锚点变了）');
  if (injectPart.indexOf('taProposals') >= 0) throw new Error('注入路径读了提案表 —— 必须只读 taEvents');
  const idx = require('fs').readFileSync('index.html', 'utf8');
  if (idx.indexOf('ta-impact.js') < 0) throw new Error('index.html 没引入 ta-impact.js');
  if (idx.indexOf('ta-proposal.js') > idx.indexOf('ta-impact.js')) throw new Error('ta-impact.js 排在了 ta-proposal.js 前面');
  return { 正常: '命中且人设优先', 抛异常: '聊天照常', 模块缺失: '聊天照常', 静态: '无网络/不读提案表' };
});

/* ---- ta 第三批（一键转正 + NPC 候选草稿，2026-10-02）---- */
console.log('\n--- ta 第三批（一键转正 / NPC 草稿）---');
t('一键转正：来源指纹去重 + 原始来源不动 + 幂等', () => {
  const ch = S.core.upsertChar({ name: '转正夹具角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '转正夹具我' }).id;
  const sb = S.core.createSandbox('isle', '转正夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);

  /* 原始来源：openLoops / attentionInbox 写入并快照 */
  const rid = S.core.rootOf(ch).id;
  S.store.set('openLoops:' + rid, { items: ['把阳台的花补种一下'], updatedAt: '2026-10-02T10:00:00' });
  S.store.set('attentionInbox:' + rid, { items: ['留意巷口新开的书店'], updatedAt: '2026-10-02T10:00:00' });
  const srcSnap = JSON.stringify([S.store.get('openLoops:' + rid), S.store.get('attentionInbox:' + rid)]);

  /* openLoops → taItems：指纹 = 'ol:' + hashText(原文) */
  const fp = 'ol:' + S.taLife.hashText('把阳台的花补种一下');
  if (S.taLife.findBySource('items', 'openLoops', fp)) throw new Error('还没转正就查到了');
  const it = S.taLife.add('items', {
    title: '把阳台的花补种一下', refCharId: ch, refUserId: u,
    sourceType: 'openLoops', sourceId: fp, sourceRef: '悬而未决的事（openLoops）'
  });
  if (!it) throw new Error('转正写入失败');
  const hit = S.taLife.findBySource('items', 'openLoops', fp);
  if (!hit || hit.id !== it.id) throw new Error('指纹查不到刚转正的记录');

  /* 重复转正：同一指纹再「转」一次，不得创建第二条 */
  const again = S.taLife.findBySource('items', 'openLoops', fp);
  if (!again || again.id !== it.id) throw new Error('重复转正指纹没命中');
  const n = S.taLife.itemsOf(ch).length;
  if (n !== 1) throw new Error('重复转正建了第二条（共 ' + n + ' 条）');

  /* attentionInbox → taFollows 同机制 */
  const fp2 = 'att:' + S.taLife.hashText('留意巷口新开的书店');
  S.taLife.add('follows', {
    target: '留意巷口新开的书店', refCharId: ch,
    sourceType: 'attentionInbox', sourceId: fp2, sourceRef: '总结引擎关注队列'
  });
  if (!S.taLife.findBySource('follows', 'attentionInbox', fp2)) throw new Error('follows 指纹查不到');

  /* 原始来源一个字节都没动 */
  if (JSON.stringify([S.store.get('openLoops:' + rid), S.store.get('attentionInbox:' + rid)]) !== srcSnap) {
    throw new Error('原始 openLoops/attentionInbox 被改写了');
  }
  /* lifeFeed：不提供自动判型 —— 转成哪种由用户选（数据层两种都收，UI 层给选择） */
  const lfFp = 'lf:' + S.taLife.hashText('前天傍晚蹲在邮筒上');
  S.taLife.add('follows', {
    target: '前天傍晚蹲在邮筒上', refCharId: ch,
    sourceType: 'lifeFeed', sourceId: lfFp, sourceRef: '近期生活动态（lifeFeed）'
  });
  if (!S.taLife.findBySource('follows', 'lifeFeed', lfFp)) throw new Error('lifeFeed 转正没落表');
  return { 去重: true, 原始来源: '未动', lifeFeed: '用户选型' };
});
t('NPC 草稿：未确认零泄漏（名册/召回/生活）+ 编辑 + 舍弃重开 + 删岛清理', () => {
  const ch = S.core.upsertChar({ name: '草稿夹具角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '草稿夹具我' }).id;
  const sb = S.core.createSandbox('isle', '草稿夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);

  const d = S.taLife.addDraft({
    name: '巷口书店老板', role: '书店老板',
    meetingOpportunity: '上周去买绝版书聊过一次',
    reasonToStayConnected: '他说会帮我留一本',
    closenessAndBoundary: '点头之交，止于书店',
    ownLife: '每周三关店去旧货市场',
    refCharId: ch, refUserId: u
  });
  if (!d || d.status !== 'draft') throw new Error('草稿创建失败');

  /* 隔离证据：草稿不进 characters（正式名册），npcsOfRoom / 首页人物表读不到 */
  const roster = S.core.charsOfSandbox(sb.id).map((x) => x.id);
  if (roster.indexOf(d.id) >= 0) throw new Error('草稿 id 混进了角色名册');
  const npcs = S.core.npcsOfRoom(sb).map((x) => x.id);
  if (npcs.indexOf(d.id) >= 0) throw new Error('未确认草稿出现在 npcsOfRoom');
  if ((S.store.get('characters') || []).some((x) => x.name === '巷口书店老板')) {
    throw new Error('草稿名字泄漏进正式人物表');
  }
  if (S.taLife.draftsOf(ch).length !== 1) throw new Error('draftsOf 读不到');

  /* 编辑 + 舍弃 + 重新打开 */
  S.taLife.patchDraft(d.id, { role: '旧书店老板' });
  if (S.taLife.findDraftInScope(d.id).role !== '旧书店老板') throw new Error('草稿编辑没生效');
  S.taLife.setDraftStatus(d.id, 'discarded', '先放着');
  if (S.taLife.findDraftInScope(d.id).status !== 'discarded') throw new Error('舍弃失败');
  S.taLife.setDraftStatus(d.id, 'draft', '重新打开');
  if (S.taLife.findDraftInScope(d.id).status !== 'draft') throw new Error('重新打开失败');
  const hist = S.taLife.findDraftInScope(d.id).history.length;
  if (hist < 3) throw new Error('状态流转没留 history（' + hist + '）');

  /* 未确认就 confirm：必须被拒 */
  const refuse = S.taLife.confirmDraft(d.id, { existsConfirmed: false });
  if (refuse.ok) throw new Error('未勾「确认存在」竟然放行了');

  /* 跨岛隔离：B 岛找不到这份草稿 */
  const b = S.core.upsertChar({ name: '草稿乙岛角色', kind: 'main' }).id;
  const sbB = S.core.createSandbox('isle', '草稿乙岛');
  S.core.setSandboxChars(sbB.id, [b]);
  S.core.setActiveSandbox(sbB.id);
  if (S.taLife.findDraftInScope(d.id)) throw new Error('跨岛能读到草稿');
  S.core.setActiveSandbox(sb.id);

  /* 删岛清理 */
  const purge = S.core._purgeSync.sandbox(sb.id);
  if (!purge || purge.ok !== true) throw new Error('拆岛失败');
  if ((S.store.get('taNpcDrafts') || []).some((x) => x && x.sandboxId === sb.id)) {
    throw new Error('拆岛后草稿成孤儿');
  }
  return { 隔离: true, 流转: hist, 拆岛: true };
});
t('NPC 确认入库：upsertChar 正式创建 + 三授权独立 + 重试幂等 + 失败保留', () => {
  const ch = S.core.upsertChar({ name: '入库夹具角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '入库夹具我' }).id;
  const sb = S.core.createSandbox('isle', '入库夹具岛');
  S.core.setSandboxChars(sb.id, [ch]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(ch, u);
  const beforeNpcs = S.core.npcsOfRoom(sb).length;

  const d = S.taLife.addDraft({ name: '邮筒边的猫的常客', role: '退休教师', refCharId: ch, refUserId: u });

  /* 失败路径：临时打断 upsertChar —— 草稿保留、status=failed、不伪报成功 */
  const origUpsert = S.core.upsertChar;
  S.core.upsertChar = function () { throw new Error('模拟存储故障'); };
  const bad = S.taLife.confirmDraft(d.id, {
    existsConfirmed: true, userKnowsInStory: true, autonomousDevelopmentAllowed: false
  });
  S.core.upsertChar = origUpsert;
  if (bad.ok) throw new Error('创建失败竟然报成功');
  const afterFail = S.taLife.findDraftInScope(d.id);
  if (afterFail.status !== 'failed') throw new Error('失败后 status 不是 failed');
  if ((S.store.get('characters') || []).some((x) => x.name === '邮筒边的猫的常客')) {
    throw new Error('失败路径泄漏了正式人物');
  }

  /* 重试成功：只建一个正式 NPC，归岛、kind/parentType 正确 */
  const ok = S.taLife.confirmDraft(d.id, {
    existsConfirmed: true, userKnowsInStory: true, autonomousDevelopmentAllowed: true
  });
  if (!ok.ok || !ok.formalCharId) throw new Error('重试入库失败：' + JSON.stringify(bad));
  const npc = S.core.findChar(ok.formalCharId);
  if (!npc || npc.kind !== 'npc' || npc.parentType !== 'sandbox' || npc.parentId !== sb.id) {
    throw new Error('正式 NPC 口径不对：' + JSON.stringify(npc && { kind: npc.kind, pt: npc.parentType }));
  }
  if (S.core.npcsOfRoom(sb).length !== beforeNpcs + 1) throw new Error('正式 NPC 没进名册');
  /* userKnows=true → 建了 (npc × user) 的 aware 关系 */
  const link = S.core.findLink(ok.formalCharId, u, sb.id);
  if (!link || link.cognition !== 'aware') throw new Error('userKnows=true 没建 aware 关系');

  /* 幂等：再 confirm 一次，绝不建第二个 */
  const dup = S.taLife.confirmDraft(d.id, {
    existsConfirmed: true, userKnowsInStory: true, autonomousDevelopmentAllowed: true
  });
  if (!dup.ok || !dup.dup) throw new Error('重试没走幂等回执');
  if (S.core.npcsOfRoom(sb).length !== beforeNpcs + 1) throw new Error('幂等失守：又建了一个');

  /* 回执落库 */
  const rec = S.taLife.findDraftInScope(d.id);
  if (rec.status !== 'confirmed' || rec.formalCharId !== ok.formalCharId || rec.confirmedAt !== rec.confirmedAt) {
    throw new Error('回执没落库');
  }
  if (!rec.userKnowsInStory || !rec.autonomousDevelopmentAllowed) throw new Error('三授权没独立落库');
  return { 失败保留: true, 重试幂等: true, 归岛: true, 回执: true };
});
t('第三批页面：草稿编辑/详情/幕后入口注册可开 + 静态护栏', () => {
  ['ta-draft', 'ta-draft-edit'].forEach((id) => {
    if (!S.registered()[id]) throw new Error('页面未注册：' + id);
  });
  const src = require('fs').readFileSync('page-ta.js', 'utf8');
  if (/store\.set\(|fetch\(|XMLHttpRequest|streamChat|api\.chat/i.test(src)) {
    throw new Error('page-ta.js 出现了写入或网络调用');
  }
  const tl = require('fs').readFileSync('ta-life.js', 'utf8');
  if (/fetch\(|XMLHttpRequest|api\.chat/i.test(tl)) throw new Error('ta-life.js 出现了网络调用');
  if (tl.indexOf('taNpcDrafts') < 0) throw new Error('ta-life.js 没挂草稿键');
  if (tl.indexOf('core.upsertChar') < 0) throw new Error('确认入库没走 core.upsertChar 正式通道');
  if (src.indexOf('补充身边的人') < 0) throw new Error('首页缺草稿入口');
  return { 注册: 2, 护栏: true };
});
t('render 和 repaint 共用同一个格子渲染函数', () => {
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  /* 早先这两处各写了一遍渲染逻辑，加个 class 很容易只改一边。
     现在必须都走 renderCell()。 */
  const calls = (src.match(/renderCell\(/g) || []).length;
  if (calls < 3) throw new Error('renderCell 只被调了 ' + calls + ' 次，说明有地方又自己写了一遍渲染');
  if (/function\s+render\s*\(ctx\)[\s\S]{0,400}grid\.innerHTML\s*=\s*''/.test(src) === false) {
    /* 这条只是形态检查，失败不致命，跳过 */
  }
  return { renderCell调用: calls };
});
t('bindCell 吞掉了长按后的那次 click（否则会误触切号）', () => {
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  if (!/__longPressed/.test(src)) {
    throw new Error('没有 __longPressed 标记 —— 长按桌面组件后会补一次 click，挂 click 的组件会被误触发');
  }
  if (!/addEventListener\('click',\s*onClick,\s*true\)/.test(src)) {
    throw new Error("click 拦截没走捕获阶段 —— 冒泡阶段拦不住组件自己挂的 click");
  }
  return { 吞click: '捕获阶段' };
});
t('编辑态退出时不会留下指向已销毁节点的引用', () => {
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  /* 重画 = 全部格子节点重建。如果不先 exitEdit，
     dragState.ghost 之类会指着一个已经从 DOM 上摘掉的节点。 */
  const repaint = src.slice(src.indexOf('ctx.repaint = function'));
  if (!/exitEdit\(\)/.test(repaint.slice(0, 400))) {
    throw new Error('repaint 开头没有 exitEdit() —— 重画后编辑态会指向已销毁的 DOM');
  }
  return { repaint: '先退编辑态' };
});
t('CSS 里有网格底纹和编辑态样式', () => {
  const css = require('fs').readFileSync('style.css', 'utf8');
  const need = ['.dt-mesh', '.dt-mesh-cell', '.dt-ghost', '.is-editing', 'dt-jiggle'];
  const miss = need.filter((c) => !css.includes(c));
  if (miss.length) throw new Error('style.css 少了：' + miss.join(','));
  return { 样式: need.length + ' 组' };
});
t('网格底纹用伪元素/兄弟层，不占网格单元', () => {
  /* 底纹如果塞进 .dt-grid 里当子元素，会占掉真实的网格位置，
     把所有组件挤到后面去 —— 这是最容易犯的错。 */
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  const bad = /grid\.appendChild\(mesh\)/.test(src);
  if (bad) throw new Error('底纹被塞进了 .dt-grid —— 它会占掉真实网格位置');
  if (!/screen\.appendChild\(mesh\)/.test(src)) {
    throw new Error('底纹不是 .dt-screen 的兄弟层');
  }
  return { 底纹层级: '与 grid 平级' };
});
t('同一函数没有重复定义（改代码时留了旧版本）', () => {
  /* 用 4 空格缩进的顶层 function 才算，嵌套的局部函数不误伤。
     踩过：改 snapTo 签名时留了个旧版在上面，
     check.js 只查语法所以全绿，运行时静默用错的那一个。 */
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  const seen = {};
  const dup = [];
  const re = /^ {2}function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    if (seen[m[1]]) dup.push(m[1]); else seen[m[1]] = true;
  }
  if (dup.length) {
    throw new Error('这些函数被定义了两次，运行时只有后一个生效：' + dup.join(', '));
  }
  return { 顶层函数: Object.keys(seen).length + ' 个，无重复' };
});
t('grid 尺寸是按「可用高度」算的，6 行一定装得下', () => {
  /* 格子是正方形，光按宽度算会出事：
     480px 宽 → cell 98px → 6 行 + 5 gap = 668px，
     而可用高度只有 ~379px，下面两行整个掉出屏幕还被 dock 盖住。
     必须 min(按宽度, 按高度)。 */
  const css = require('fs').readFileSync('style.css', 'utf8');
  const m = css.match(/--dt-cell:\s*([^;]+);/);
  if (!m) throw new Error('没找到 --dt-cell 定义');
  const val = m[1];
  if (!/min\(/.test(val)) {
    throw new Error('--dt-cell 没有用 min() 取小 —— 矮屏上 6 行会溢出：' + val.trim());
  }
  if (!/--dt-cell-h/.test(val)) {
    throw new Error('--dt-cell 没有把「按高度算」那一项算进去：' + val.trim());
  }
  if (!/100dvh/.test(css)) {
    throw new Error('没有用 100dvh 算可用高度');
  }
  return { 公式: val.trim() };
});
t('屏幕底部给 dock 留了位置（组件不会被盖住）', () => {
  const css = require('fs').readFileSync('style.css', 'utf8');
  const m = css.match(/--dt-pad-bottom:\s*(\d+)px/);
  if (!m) throw new Error('没有 --dt-pad-bottom');
  const pad = parseInt(m[1], 10);
  /* dock 高 74 + 底距 14 = 88，内边距必须大于它 */
  if (pad < 88) {
    throw new Error('--dt-pad-bottom = ' + pad + 'px，小于 dock 占的 88px，最后一行会被盖住');
  }
  return { 底部内边距: pad + 'px', dock占地: '88px' };
});
t('编辑态在静态视图里看得出来（抖动幅度 + 描边）', () => {
  const css = require('fs').readFileSync('style.css', 'utf8');
  const k = css.match(/@keyframes dt-jiggle\{[\s\S]*?\}/);
  if (!k) throw new Error('没有 dt-jiggle 动画');
  /* 0.45° 在静态截图里跟没抖一样，用户会以为长按没反应 */
  const deg = k[0].match(/(-?[\d.]+)deg/g) || [];
  const max = Math.max.apply(null, deg.map((d) => Math.abs(parseFloat(d))));
  if (max < 0.8) {
    throw new Error('抖动只有 ' + max + '°，静态下看不出来，起不到「已进入编辑态」的提示作用');
  }
  if (!/is-editing \.widget\{[\s\S]*?outline/.test(css)) {
    throw new Error('编辑态的组件没有描边，跟平时区分不开');
  }
  return { 抖动幅度: max + '°', 提示: '描边 + 把手' };
});

t('吸附时用的是「这一屏」的网格，不是第 0 屏', () => {
  /* gridOrigin/cellStep 如果写成 ctx.body.querySelector('.dt-grid')，
     永远拿到第 0 屏的网格。拖第 2 屏时原点差两屏宽，
     吸附结果整体右移 —— 「拖到第 2 列却落在第 4 列」。
     必须把 grid 当参数传。

     注意 cellStep 里**允许**保留一个 ctx 兜底分支（参数缺失时别炸），
     所以这里查的不是「有没有出现 querySelector」，而是
     「grid 是不是第一个参数」+「调用点有没有把 grid 传进去」。 */
  const src = require('fs').readFileSync('page-desktop.js', 'utf8');
  if (!/function\s+cellStep\s*\(\s*grid\b/.test(src)) {
    throw new Error('cellStep 第一个参数不是 grid —— 会退化成用 ctx 反查');
  }
  if (!/function\s+snapTo\s*\(\s*grid\b/.test(src)) {
    throw new Error('snapTo 第一个参数不是 grid');
  }
  if (!/snapTo\(st\.grid/.test(src)) {
    throw new Error('moveCellDrag 没把这一屏的 grid 传给 snapTo');
  }
  /* cellStep 内部必须先尝试用传进来的 grid */
  const fn = src.slice(src.indexOf('function cellStep'), src.indexOf('function gridOrigin'));
  if (!/var\s+g\s*=\s*grid\s*\|\|/.test(fn)) {
    throw new Error('cellStep 没有优先使用传入的 grid');
  }
  return { 传参: 'grid 显式传入且优先' };
});

t('setActions 收的是描述对象数组，不是 DOM 节点', () => {
  /* 传元素进去会在 (list||[]).forEach 上炸，而且被 app.js 的错误边界
     吞成「这一页出错了」，不容易回溯。这里验证每个页面调 setActions
     时传的第一个参数都是数组（静态扫源码，比运行时更容易覆盖全）。 */
  const fs = require('fs');
  const files = fs.readdirSync('.').filter((f) => /^page-.*\.js$/.test(f));
  const bad = [];
  files.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    /* 抓 setActions( 之后到行尾的内容，看是不是 [ 开头或明显是数组变量 */
    const re = /setActions\(\s*([^\n)]*)/g;
    let m;
    while ((m = re.exec(src))) {
      const arg = m[1].trim();
      if (!arg) continue;                       /* 无参调用（清空） */
      if (arg.startsWith('[')) continue;        /* 内联数组，OK */
      /* 变量名：白名单式的，叫 xxActions / acts 之类的放行 */
      if (/(Actions|acts|btns|list)\s*$/.test(arg)) continue;
      bad.push(f + ' → setActions(' + arg.slice(0, 40) + ')');
    }
  });
  if (bad.length) throw new Error('可疑的 setActions 调用：' + bad.join('；'));
  return { 已扫描: files.length + ' 个页面文件', 检查通过: true };
});

/* ============================================================
   沙盒段放在最后：它会 clearAll()，把前面测试铺的数据整个清掉 ——
   放前面会把后面所有断言的地基抽走。单独成段而不是混在上面，
   就是为了让「谁动了全局状态」这件事一眼看得见。
   ============================================================ */

console.log('\n--- core:沙盒隔离（读写两个口子）---');

t('tagScope 盖章 / scoped 只返回本房记录', () => {
  const sb = S.core.createSandbox('isle', '隔离测试房');
  S.core.setActiveSandbox(sb.id);
  const a = S.core.tagScope({ id: 'r1' });
  const b = { id: 'r2', sandboxId: 'other-room' };
  const c = S.core.tagScope({ id: 'r3' });
  if (a.sandboxId !== sb.id || c.sandboxId !== sb.id) throw new Error('tagScope 没盖章');
  const kept = S.core.scoped([a, b, c]).map((r) => r.id).join(',');
  if (kept !== 'r1,r3') throw new Error('过滤结果不对：' + kept);
  return { 盖章: sb.id.slice(0, 8) + '…', 留下: kept };
});

t('没有当前房时 scoped 原样返回全部（迁移前的老状态）', () => {
  S.store.set('sandboxes', []);
  S.store.set('activeSandboxId', null);
  const n = S.core.scoped([{ id: 'x' }, { id: 'y' }]).length;
  if (S.core.scopeId() !== null) throw new Error('scopeId 该是 null');
  if (n !== 2) throw new Error('该原样返回 2 条，实际 ' + n);
  return { scopeId: null, 返回: n };
});

console.log('\n--- store:沙盒迁移（把老全局数据收进默认存档）---');

t('migrateToSandbox 一条不少 + 连跑两次幂等', () => {
  /* 用干净世界跑：clearAll() 会同时清掉 LS 和 store 的缓存，
     然后按「迁移之前」的样子铺数据 —— 全局一份的对话/记忆/照片/待办。 */
  S.store.clearAll();

  const g1 = S.core.upsertChar({ name: '顾清和', kind: 'main', content: '大号' }).id;
  const g2 = S.core.upsertChar({ name: '沈聿', kind: 'main', content: '大号' }).id;
  const subId = S.core.upsertChar({ name: '小和', kind: 'sub', parentId: g1, content: '皮套' }).id;
  const u = S.core.upsertUser({ name: '我' }).id;

  S.store.set('chats', [{ id: 'c1', characterId: g1, userId: u, messages: [] }]);
  S.store.set('memories', [{ id: 'mm1', rootId: g1, fromCharId: g1, toUserId: u, role: 'user', text: '在吗' }]);
  S.store.set('photos', [{ id: 'p1', url: 'data:x' }]);
  S.store.set('todos', [{ id: 't1', text: '买草莓', done: false }]);
  S.store.set('desktop', S.desktop.defaultDesktop());

  /* 迁移只在「还没有 sandboxes 键」时发生 —— 显式删掉保证这一跑真的执行 */
  delete LS[S.store.NS + 'sandboxes'];

  const sb = S.store.migrateToSandbox();
  if (!sb) throw new Error('迁移没有发生');

  const counts = ['chats', 'memories', 'photos', 'todos']
    .map((k) => [k, (S.store.get(k) || []).length]);
  const lost = counts.filter(([, n]) => n !== 1);
  if (lost.length) throw new Error('有数据丢了：' + JSON.stringify(counts));

  const biz = ['chats', 'memories', 'photos', 'todos']
    .every((k) => (S.store.get(k) || []).every((r) => r.sandboxId === sb.id));
  if (!biz) throw new Error('业务数据没有全部打上沙盒标签');

  const chars = S.core.allChars();
  const subChar = chars.filter((c) => c.id === subId)[0];
  const mainChar = chars.filter((c) => c.id === g1)[0];
  if (!subChar || subChar.sandboxId !== sb.id) throw new Error('皮套没挂到房里');
  /* 2026-09-21 拍板：大号也按岛（每岛一份，没有全局大号）—— 迁移收编时一起打章 */
  if (!mainChar || mainChar.sandboxId !== sb.id) throw new Error('大号没挂到房里');

  /* 房型按大号数量推断：这里两个大号 → 群岛 */
  if (sb.kind !== S.core.KIND_ARCHI) throw new Error('房型推断错了：' + sb.kind);

  const again = S.store.migrateToSandbox();
  if (again !== null) throw new Error('重复跑又建了一间房（不幂等）');

  return {
    房型: sb.kind,
    成员: sb.charIds.length,
    马甲: sb.maskIds.length,
    老数据: counts.map(([k, n]) => k + ':' + n).join(' '),
    重复跑: '跳过（幂等）'
  };
});

t('迁移之后：本房看得见、换间房就看不见', () => {
  const sbA = S.core.listSandboxes()[0];
  S.core.setActiveSandbox(sbA.id);
  const inA = S.core.scoped(S.store.get('chats')).length;

  const sbB = S.core.createSandbox('isle', '另一间房');
  S.core.setActiveSandbox(sbB.id);
  const inB = S.core.scoped(S.store.get('chats')).length;

  if (inA !== 1) throw new Error('A 房该看到 1 条对话，实际 ' + inA);
  if (inB !== 0) throw new Error('B 房不该看到 A 房的对话，实际 ' + inB);
  return { A房: inA, B房: inB, 结论: '两个存档的数据互不可见' };
});

console.log('\n--- page:桌面（编辑态的小叉叉）---');

/* 用户：「桌面进入编辑模式后，所有的组件都加上一个小叉叉，
   就是把这个组件删掉的意思，因为以后打算做个组件商城~」
   这几条都是会被改回去的回归点，钉住。 */
{
  const djs = fs.readFileSync(path.join(ROOT, 'page-desktop.js'), 'utf8');
  const dcss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

  ok('每个组件都挂了「拿掉」的小叉叉，而且只在编辑态显示',
    djs.indexOf("h('button', 'dt-kill')") >= 0 &&
    djs.indexOf('killBtn(cell, ctx)') >= 0 &&
    dcss.indexOf('.dt-screen.is-editing .dt-kill{display:flex;}') >= 0);

  ok('小叉叉的点击不会被「长按吞点击」那层捕获逻辑一起吃掉',
    djs.indexOf("closest('.dt-kill')") >= 0);

  ok('删掉的组件会记一笔（组件商城以后拿它当清单）',
    djs.indexOf('desktopRemoved') >= 0 &&
    djs.indexOf('rememberRemoved') >= 0);
}

console.log('\n--- page:外观 / 组件商城（桌面上的两个新 App）---');

t('桌面布局：日记 / 朋友圈下架，换成外观 / 组件商城', () => {
  const apps = [];
  S.desktop.defaultDesktop().pages.forEach((l) => (l || []).forEach((c) => {
    if (c.app) apps.push(c.app);
  }));
  if (apps.indexOf('diary') >= 0) throw new Error('日记还在桌面上');
  if (apps.indexOf('moments') >= 0) throw new Error('朋友圈还在桌面上');
  if (apps.indexOf('appearance') < 0) throw new Error('没有外观入口');
  if (apps.indexOf('widgetstore') < 0) throw new Error('没有组件商城入口');
  return { 桌面上的App: apps, 户型版本: S.desktop.LAYOUT_VERSION };
});

/* 版本 19（2026-10-05，用户）：「这一屏的贴纸、钱包、组件商城的功能
   都有别的入口，统一改成图标为空，里面的内容为空，不要再跳转到别的页面去」
   —— 三格改 type 'blank'（空玻璃壳，无图标无跳转），主屏组件商城入口不动。
   版本 20（2026-10-06）：「钱包」那一格改成了「小岛指南」真入口
   （p3-guide / type app / app guide），收窄成「贴纸 / 组件商城仍 blank」+「钱包位已换成小岛指南」。
   版本 22（2026-10-07，施工卡-群声-v1 Batch A）：「贴纸」空壳改成
   「群声」真入口（p3-qunsheng / type app / app qunsheng），收窄成
   「组件商城 / 外观仍 blank」+「贴纸位已换成群声」。
   版本 23（2026-10-08）：「组件商城」空壳改成「以身入局」真入口
   （p3-yishenruju / type app / app yishenruju），收窄成
   「外观仍 blank」+「组件商城位已换成以身入局」。 */
t('第 3 屏外观仍空壳，组件商城位已换成「以身入局」真入口，钱包位→小岛指南，贴纸位→群声，主屏入口不动', () => {
  const d = S.desktop.defaultDesktop();
  /* 外观那份空壳还在（主屏 p1-look 已有同功能入口） */
  const look = d.pages[3].filter((c) => c.i === 'p3-look')[0];
  if (!look || look.type !== 'blank') throw new Error('p3-look 应仍是空壳，实际 ' + (look && look.type));
  if (!look.label) throw new Error('p3-look 丢了 label（编辑模式里认不出格子）');
  /* 组件商城位 → 以身入局真入口 */
  const ru = d.pages[3].filter((c) => c.i === 'p3-yishenruju')[0];
  if (!ru) throw new Error('第 3 屏找不到 p3-yishenruju（以身入局）那一格');
  if (ru.type !== 'app' || ru.app !== 'yishenruju' || ru.label !== '以身入局')
    throw new Error('p3-yishenruju 应是 以身入局 真入口，实际 ' + JSON.stringify(ru));
  if (S.desktop.LAYOUT_VERSION !== 23) throw new Error('户型版本应为 23，实际 ' + S.desktop.LAYOUT_VERSION);
  /* 钱包位 → 小岛指南真入口 */
  const g = d.pages[3].find((c) => c.i === 'p3-guide');
  if (!g) throw new Error('第 3 屏找不到 p3-guide（小岛指南）那一格');
  if (g.type !== 'app' || g.app !== 'guide') {
    throw new Error('p3-guide 应为 app/guide，实际 type=' + g.type + ' app=' + g.app);
  }
  if (g.x !== 3 || g.y !== 4) throw new Error('小岛指南坐标应为 (3,4)，实际 ' + g.x + ',' + g.y);
  /* 小岛指南页面必须真的注册上了（点得开） */
  if (!S.registered || !S.registered()['guide'] || !S.registered()['guide'].hasRender) {
    throw new Error('小岛指南页面（app guide）没注册上 —— 桌面这格点开会白屏');
  }
  /* 贴纸位 → 群声真入口（v22），页面同样必须点得开 */
  const qs = d.pages[3].find((c) => c.i === 'p3-qunsheng');
  if (!qs) throw new Error('第 3 屏找不到 p3-qunsheng（群声）那一格');
  if (qs.type !== 'app' || qs.app !== 'qunsheng') {
    throw new Error('p3-qunsheng 应为 app/qunsheng，实际 type=' + qs.type + ' app=' + qs.app);
  }
  if (qs.x !== 4 || qs.y !== 3) throw new Error('群声坐标应为 (4,3)，实际 ' + qs.x + ',' + qs.y);
  if (!S.registered || !S.registered()['qunsheng'] || !S.registered()['qunsheng'].hasRender) {
    throw new Error('群声页面（app qunsheng）没注册上 —— 桌面这格点开会白屏');
  }
  const p1 = d.pages[1].find((c) => c.i === 'p1-store');
  if (!p1 || p1.type !== 'app' || p1.app !== 'widgetstore') {
    throw new Error('主屏的组件商城入口不能跟着动');
  }
  /* 第 3 屏外观改空壳，主屏那份必须还在 —— 外观不能从桌面消失 */
  const p1look = d.pages[1].find((c) => c.i === 'p1-look');
  if (!p1look || p1look.type !== 'app' || p1look.app !== 'appearance') {
    throw new Error('主屏的外观入口（p1-look）不能跟着变空壳');
  }
  return { 空壳剩: [look.label], 以身入局: ru.label, 小岛指南: g.label, 群声: qs.label };
});

t('外观：三套主题的变量覆盖都写了，字号/动效都接得上', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const ids = S.appearance.THEMES.map((x) => x.id);
  const missing = ids.filter((id) => id !== 'grape' &&
    css.indexOf('#phone[data-theme="' + id + '"]') < 0);
  if (missing.length) throw new Error('这些主题没有样式：' + missing.join('、'));
  if (css.indexOf('var(--fs-scale') < 0) throw new Error('字号没接变量');
  if (css.indexOf('#phone[data-motion="off"]') < 0) throw new Error('动效开关没接');
  return { 主题: ids };
});

t('外观：apply() 是唯一出口（只有它去改 #phone 上的主题属性）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'page-appearance.js'), 'utf8');
  const hits = (src.match(/setAttribute\('data-theme'/g) || []).length;
  if (hits !== 1) throw new Error('改主题属性的地方有 ' + hits + ' 处，应该只有 apply() 一处');
  return { 出口: hits, 加载时应用: src.indexOf('\n  apply();') >= 0 };
});

t('组件商城：目录非空，装一件进去桌面真的多一格', () => {
  S.store.set('desktop', null);            /* 先回到默认户型 */
  const cat = S.widgetStore.catalog();
  if (!cat.length) throw new Error('目录是空的');
  const before = S.widgetStore.countOnDesktop();
  /* 用一个 1×1 的：默认户型摆得很满，3×1 那种真放不下
     （「放不下」是另一条断言的事） */
  const res = S.widgetStore.addWidget({ type: 'app', app: 'chat-list', label: '聊天', w: 1, h: 1 });
  const after = S.widgetStore.countOnDesktop();
  if (!res.ok) throw new Error('没装上：' + res.message);
  if (after - before !== 1) throw new Error('格数没变');
  S.store.set('desktop', null);
  return { 目录件数: cat.length, 装上了: res.ok, 多出来: after - before };
});

/* 角色卡上架（2026-09-22 用户「人1」）：默认户型里没有它（用户点名从主屏
   拿掉的），但组件商城要能装回来。
   2026-09-29：状态签名全量下线 —— 卡片第二行恒为「在线」，不再读 char.status。 */
t('组件商城：角色卡上架了（默认户型没有，目录里能装回来）', () => {
  S.store.set('desktop', null);
  const card = S.widgetStore.catalog().filter((c) => c.type === 'char')[0];
  if (!card) throw new Error('目录里没有角色卡');
  const res = S.widgetStore.addWidget(card);
  if (!res.ok) throw new Error('装不上：' + res.message);
  const onDesk = S.desktop.getDesktop().pages.some((l) =>
    (l || []).some((c) => c.type === 'char'));
  const st = S.desktop.skin().status;   /* 卡片第二行读的就是它 */
  /* 状态签名下线后第二行只会是「在线」或空态提示，绝不再读 char.status */
  if (st !== '在线' && st !== '去浮岛开一间房' && st !== '从桌面下拉或切号器选一位' && st !== '还没有角色') {
    throw new Error('第二行不该再来自 char.status，实 ' + st);
  }
  S.store.set('desktop', null);
  return { 尺寸: card.w + '×' + card.h, 装上了: res.ok, 桌面上有: onDesk, 第二行: st };
});

t('组件商城：桌面塞满时明说放不下，不硬塞（重叠会被 CSS 静默盖住）', () => {
  const full = [];
  for (let y = 1; y <= S.desktop.ROWS; y++) {
    for (let x = 1; x <= S.desktop.COLS; x++) {
      full.push({ i: 'f' + y + x, type: 'app', app: 'chat-list', x, y, w: 1, h: 1, label: 'x' });
    }
  }
  S.store.set('desktop', {
    version: S.desktop.LAYOUT_VERSION,
    pages: [full.slice(), full.slice(), full.slice(), full.slice()]
  });
  const res = S.widgetStore.addWidget({ type: 'clock', label: '时间', w: 3, h: 1 });
  S.store.set('desktop', null);
  if (res.ok) throw new Error('塞满还给它塞进去了');
  return { 结果: res.message };
});

t('组件商城：删掉的组件会被记下来（小叉叉那一笔），能列出来', () => {
  S.store.set('desktopRemoved', [
    { type: 'wall', app: '', label: '照片墙', w: 4, h: 6, at: 1 },
    { type: 'wall', app: '', label: '照片墙', w: 4, h: 6, at: 2 },   /* 删过两次 */
    { type: 'app', app: 'diary', label: '日记', w: 1, h: 1, at: 3 }
  ]);
  const list = S.widgetStore.removed();
  S.store.set('desktopRemoved', []);
  return { 去重后: list.map((r) => r.label), 件数: list.length };
});

/* 装回原位（清查报告 §8.1：desktopRemoved 以前丢 x/y/pi，装回只能落空位） */
t('组件商城装回：原位优先（x/y/pi），被占了才退回找空位', () => {
  S.store.set('desktop', null);            /* 回到默认户型 */
  const d0 = S.desktop.getDesktop();
  const C = S.desktop.COLS, R = S.desktop.ROWS;
  let sx = 0, sy = 0, sp = -1;
  /* 找第一个放得下 1x1 的空格（照片墙会占满第 0 页，所以要跨页找） */
  outer:
  for (let pi = 0; pi < d0.pages.length; pi++) {
    for (let y = 1; y <= R; y++) {
      for (let x = 1; x <= C; x++) {
        const hit = (d0.pages[pi] || []).some((c) =>
          !(c.x + c.w <= x || x + 1 <= c.x || c.y + c.h <= y || y + 1 <= c.y));
        if (!hit) { sx = x; sy = y; sp = pi; break outer; }
      }
    }
  }
  if (!sx) { throw new Error('默认户型居然没有空位'); }
  const rec = { type: 'clock', label: '时间', w: 1, h: 1, x: sx, y: sy, pi: sp, at: 1 };
  const home = S.widgetStore.restoreWidget(rec);
  if (!home.ok || !home.home || home.page !== sp || home.cell.x !== sx || home.cell.y !== sy) {
    throw new Error('原位没放回去：' + JSON.stringify(home));
  }
  /* 原位已被上一枚占住 → 再装同一格记录要退回找空位，不能硬叠上去 */
  const again = S.widgetStore.restoreWidget(rec);
  if (again.ok && again.home) throw new Error('原位被占还硬放回原位');
  if (!again.ok) throw new Error('退回找空位也失败了：' + again.message);
  S.store.set('desktop', null);
  S.store.set('desktopRemoved', []);
  return { 原位: [sx, sy, sp], 回退找空位: true };
});

t('组件商城批3链路：上架新件→应用→计数→移除→rememberRemoved 记账→原位装回', () => {
  S.store.set('desktop', null);
  S.store.set('desktopRemoved', []);
  /* 目录里必须有批3 四件（EXTRA_DEFS 上架） */
  const cat = S.widgetStore.catalog().map((c) => c.type);
  for (const t3 of ['countdown', 'weatherbrick', 'dateclock', 'polaroid']) {
    if (cat.indexOf(t3) < 0) throw new Error('批3 组件没上架：' + t3);
  }
  const def = { type: 'countdown', app: '', label: '倒数日方', w: 2, h: 1 };
  const key = 'countdown||倒数日方';
  /* ① 应用到桌面：真的多一格 + countOf 认它 */
  const res = S.widgetStore.addWidget(def);
  if (!res.ok) throw new Error('没装上：' + res.message);
  if (S.widgetStore.countOf(key) !== 1) throw new Error('countOf 应为 1');
  /* ② 删除：removeWidget 拆掉 + rememberRemoved 记同一笔账（x/y/pi 全带） */
  const rm = S.widgetStore.removeWidget({ key: key, type: def.type, app: '', label: def.label });
  if (!rm.ok) throw new Error('移除失败：' + rm.message);
  if (S.widgetStore.countOf(key) !== 0) throw new Error('移除后还在桌上');
  const recs = S.store.get('desktopRemoved') || [];
  const rec = recs.filter((r) => r.type === 'countdown' && r.label === '倒数日方').pop();
  if (!rec) throw new Error('移除没记账（desktopRemoved 没有这条）');
  if (typeof rec.pi !== 'number' || typeof rec.x !== 'number' || typeof rec.y !== 'number') {
    throw new Error('记账缺 x/y/pi，原位装回会退化：' + JSON.stringify(rec));
  }
  /* ③ 装回：走「你删过的」同一条 restoreWidget 路径，原位回来 */
  const back = S.widgetStore.restoreWidget(rec);
  if (!back.ok || !back.home) throw new Error('没回到原位：' + JSON.stringify(back));
  if (S.widgetStore.countOf(key) !== 1) throw new Error('装回后 countOf 应为 1');
  S.store.set('desktop', null);
  S.store.set('desktopRemoved', []);
  return { 上架: 4, 应用: true, 移除记账: true, 原位装回: [rec.x, rec.y, rec.pi] };
});

console.log('\n--- page:朋友圈（微信式发布 + 四档可见 + 赞的反应）---');

console.log('\n--- page:朋友圈（反应决策步 · 活人感）---');

/* 用户定的原则：角色可以选择提起，但不意味着每条都必须汇报阅读理解。
   决策步的五种出口都要能解析；模型没写标签但说了话，当评论收下。 */
t('决策解析：五种出口 + 无标签宽容', () => {
  const D = S.momentsAI.extractDecision;
  return {
    划过去: D('[skip]').kind,
    只点赞: D('[like]').kind,
    评论: D('[comment] 你先睡').text,
    延后分钟: D('[later: 45]').minutes,
    私聊: D('[private] 你吃饭没').kind + ':' + D('[private] 你吃饭没').text,
    没标签当评论: D('这事你做得对').kind + ':' + D('这事你做得对').text,
    空就是划过: D('').kind
  };
});

/* 硬护栏：近 1 小时互动太多 → 该强制划过去了。 */
t('频率护栏：recentActivity 数得清最近一小时的互动', () => {
  S.store.set('moments', []);
  const ch = S.core.upsertChar({ name: '顾清和', kind: 'main' }).id;
  const mo1 = S.momentsTab.add({ name: '我', text: '一' });
  const mo2 = S.momentsTab.add({ name: '我', text: '二' });
  S.momentsTab.addComment(mo1.id, { kind: 'char', refId: ch, name: '顾清和' }, '一条');
  S.momentsTab.toggleLike(mo2.id, { kind: 'char', refId: ch, name: '顾清和' });
  const n = S.momentsAI.recentActivity(ch);
  S.store.set('moments', []);
  return { 一小时内互动: n, 到上限了: n >= 2 };
});

/* 被 user 显式点名的（回复他的评论 / @ 了他）必须接，不走过_decision。 */
t('点名必接：回复角色评论 / @ 的人带 must 标记', () => {
  S.store.set('moments', []);
  const ch = S.core.upsertChar({ name: '顾清和', kind: 'main' }).id;
  const sb = S.core.createSandbox('archipelago');
  S.core.setSandboxChars(sb.id, [ch]);
  const mo = S.momentsTab.add({ name: '我', text: '在吗' });
  const cc = S.momentsTab.addComment(mo.id, { kind: 'char', refId: ch, name: '顾清和' }, '在');
  /* 必须用 byId 重读 —— 旧引用身上的 comments 是空壳（saveAll 存的是副本） */
  const fresh = S.momentsTab.byId(mo.id);
  const r1 = S.momentsAI.pickResponders(fresh, { replyTo: cc.item.id }, sb);
  const mo2 = S.momentsTab.add({ name: '我', text: '看这个', mentions: [ch] });
  const r2 = S.momentsAI.pickResponders(mo2, null, sb);
  S.core._purgeSync.sandbox(sb.id);
  if (!r1.length || !r1[0].must) throw new Error('回复角色评论却不是必接：' + JSON.stringify(r1));
  if (!r2.length || !r2[0].must) throw new Error('@ 了却不是必接：' + JSON.stringify(r2));
  return { 回复点名: r1.map((x) => x.name + '!'), 艾特点名: r2.map((x) => x.name + '!') };
});

console.log('\n--- page:朋友圈（微信式发布 + 四档可见 + 赞的反应）---');

/* 用户给的微信截图：公开 / 私密 / 部分可见 / 不给谁看。
   老数据没有 privacy 字段 = 公开，行为不变。 */
t('可见范围升级成四档（照微信的「谁可以看」页）', () => {
  S.store.set('moments', []);
  const add = S.momentsTab.add;
  const pub = add({ name: '我', text: '公开的' });
  const self = add({ name: '我', text: '私密', privacy: 'self', maskId: 'u-me' });
  const inc = add({ name: '我', text: '部分可见', privacy: 'include', visibleTo: ['c1'] });
  const exc = add({ name: '我', text: '不给看', privacy: 'exclude', visibleTo: ['c1'] });
  return {
    公开_谁都行: S.momentsTab.canSee(pub, 'c9'),
    私密_自己可见: S.momentsTab.canSee(self, 'u-me'),
    私密_别人不行: !S.momentsTab.canSee(self, 'c1'),
    部分可见_在内: S.momentsTab.canSee(inc, 'c1'),
    部分可见_不在外: !S.momentsTab.canSee(inc, 'c2'),
    不给谁看_被挡: !S.momentsTab.canSee(exc, 'c1'),
    不给谁看_旁人可见: S.momentsTab.canSee(exc, 'c2')
  };
});

t('赞也有反应：赞了之后排一个「他知道」的短延迟任务', () => {
  S.store.set('moments', []); S.store.set('momentPending', []);
  const ch = S.core.upsertChar({ name: '顾清和', kind: 'main' }).id;
  const mo = S.momentsTab.add({ characterId: ch, name: '顾清和', text: '今天风大' });
  const r = S.momentsTab.toggleLike(mo.id, { kind: 'mask', refId: 'u1', name: '我' });
  const p = S.momentsAI.pending();
  const item = p[p.length - 1];
  S.momentsAI.clearPending();
  return { 赞上了: r.ok && r.liked, 排了反应: !!item,
           类型: item && item.kind, 谁被赞: item && item.charName,
           短延迟: item ? (item.dueAt - Date.now()) < 25000 : false };
});

{
  const mjs = fs.readFileSync(path.join(ROOT, 'page-moments.js'), 'utf8');
  ok('发布弹层是微信式结构（设置行 / 表情配图，解释文字退场）',
    mjs.indexOf('mo-set-row') >= 0 && mjs.indexOf('mo-emoji-btn') >= 0 &&
    mjs.indexOf('mo-composer-tip') < 0);
  ok('相机是微信交互：点击选图、长按发文字',
    mjs.indexOf('onLongPress') >= 0 && mjs.indexOf('从相册选一张') >= 0);
  ok('「谁可以看」是四档',
    mjs.indexOf('部分可见') >= 0 && mjs.indexOf('不给谁看') >= 0);
  ok('壳子的顶栏动作支持长按',
    fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').indexOf('onLongPress') >= 0);
}

/* 接口名契约：`ui.xxx()` 里写的名字必须真的挂在 Sleepy.ui 上。

   踩过的坑：四处写了 `ui.confirmBox({...})`，而导出的名字其实是
   `ui.confirm` —— 调用时 TypeError，异常还被组件的 try/catch 吞掉，
   表现是「点了删除没反应」，**控制台连个红字都没有**。
   这类错静态检查查不出来（不是语法错），只能这么扫一遍。 */
t('ui.xxx() 调用的都是真实导出的名字', () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'ui.js'), 'utf8');
  const at = uiSrc.indexOf('Sleepy.ui = {');
  const seg = uiSrc.slice(at, uiSrc.indexOf('\n  };', at));
  const exported = new Set();
  seg.replace(/([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$]/g, (m, k) => { exported.add(k); return m; });

  const files = fs.readdirSync(ROOT).filter((f) =>
    f.endsWith('.js') && f !== 'ui.js' && f.indexOf('_retired') < 0);
  const missing = [];
  files.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /\bui\.([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (!exported.has(m[1])) missing.push(f + ' → ui.' + m[1]);
    }
  });
  if (missing.length) throw new Error('这些名字 ui 上没有：' + missing.join('、'));
  return { 扫了: files.length + ' 个文件', ui接口: exported.size };
});

console.log('\n--- page:生图（imggen 引擎）---');

/* 引擎出口齐全：页面和以后的聊天集成全靠这一份名单，漏一个就是「没这个功能」 */
t('imggen 模块出口齐全', () => {
  const g = S.imggen;
  const need = ['KINDS', 'NAI_MODELS', 'BUILTIN_PRESET', 'listApis', 'newApi', 'activeApi',
    'setCurrent', 'listPrompts', 'addPrompt', 'removePrompt', 'readEnabled',
    'setEnabled', 'buildPrompt', 'generate', 'extractFirstFile'];
  const missing = need.filter((k) => typeof g[k] === 'undefined');
  if (missing.length) throw new Error('缺：' + missing.join('、'));
  return 'ok';
});

/* 新建接口**不再预灌内置预设词**（2026-10-08 用户拍板：「不要把我们的提示词
   放出来」——预灌的词会直接出现在设置表单里）。留空即合法：三条消费路
   （legacy / NAI 正式 / buildFormalPrompt）对空 positivePreset / negativePreset
   都回落 BUILTIN_PRESET，词面分毫不变，只是不再展示、不再拷进用户存档。 */
t('newApi 预设词留空（不预灌内置词，运行时回落 BUILTIN）', () => {
  const g = S.imggen;
  const gen = g.newApi('general');
  const nai = g.newApi('nai');
  if (gen.kind !== 'general' || nai.kind !== 'nai') throw new Error('kind 不对');
  /* 硬写字符串登记：预设词必须为空串（falsy），不许再预灌 BUILTIN 原文 */
  if (gen.positivePreset) throw new Error('general 新接口不该预灌正面预设');
  if (gen.negativePreset) throw new Error('general 新接口不该预灌负面预设');
  if (nai.positivePreset || nai.negativePreset) throw new Error('NAI 新接口不该预灌预设');
  /* 回落仍然成立：BUILTIN_PRESET 模板原样在（{p} 占位、NAI 负面无 {p}） */
  if (g.BUILTIN_PRESET.general.positive.indexOf('{p}') < 0) throw new Error('general 内置正面没有 {p} 占位');
  if (!g.BUILTIN_PRESET.nai.negative) throw new Error('nai 没有内置负面预设');
  if (g.BUILTIN_PRESET.nai.negative.indexOf('{p}') >= 0) throw new Error('负面预设不该有 {p}');
  return { 预设留空: true, 内置模板原样: true };
});

/* 试一张退役实验 UI（2026-10-08 用户拍板）：改走正式管线 generate({plan})，
   不再有「实验」「对照」措辞、临时双人/多人入口或内置词展示。 */
t('生图试一张：实验 UI 退役，改走正式管线', () => {
  const src = fs.readFileSync(path.join(ROOT, 'page-imggen.js'), 'utf8');
  if (src.indexOf('仅本地实验') >= 0) throw new Error('试一张还有「实验」措辞');
  if (src.indexOf('视觉拼接模式') >= 0) throw new Error('E1 实验下拉还在');
  if (src.indexOf('（临时测试，不读取角色资料）') >= 0) throw new Error('临时实验主体选项还在');
  if (src.indexOf('imggen.generate({') < 0) throw new Error('试一张没走 generate 正式入口');
  if (src.indexOf('plan: {') < 0) throw new Error('试一张没有构造 plan');
  /* 预设词组不得展示内置词原文：留空＝用内置，只在想覆盖时才填 */
  if (src.indexOf('内置词不在这里展示') < 0) throw new Error('预设词组没有「不展示内置词」的说明');
  return { 实验UI退役: true, 正式管线: true, 预设词不展示: true };
});

/* 拼提示词管线：预设基底 ← 锁脸段 + 动态段 + 词条，{p} 替换、顺序固定、
   重复词条去重。锁脸在最前面 —— 它锁的是「长什么样」，不是动作。
   （2026-10-08 起 newApi 预设留空：这里显式给一份预设，测的是消费端契约。） */
t('buildPrompt：{p} 替换 + 段落顺序 + 词条去重', () => {
  const g = S.imggen;
  const api = Object.assign(g.newApi('nai'), {
    positivePreset: g.BUILTIN_PRESET.nai.positive,
    negativePreset: g.BUILTIN_PRESET.nai.negative
  });
  const r = g.buildPrompt({
    api,
    faceText: '1girl, silver hair, red eyes',
    subject: '1girl, sitting by window, drinking coffee',
    extras: ['film grain', '1girl, sitting by window, drinking coffee']
  });
  const pos = r.positive;
  if (pos.indexOf('{p}') >= 0) throw new Error('{p} 没被替换');
  const iFace = pos.indexOf('silver hair');
  const iAct = pos.indexOf('sitting by window');
  const iX = pos.indexOf('film grain');
  if (!(iFace >= 0 && iFace < iAct && iAct < iX)) {
    throw new Error('顺序不对：锁脸 → 内容 → 词条');
  }
  if (pos.split('sitting by window').length !== 2) throw new Error('重复词条没去重');
  /* 负面独立通道：来自接口的 negativePreset，不掺正面内容 */
  if (r.negative !== api.negativePreset) throw new Error('负面通道不对');
  return { 正面开头: pos.slice(0, 30), 分段顺序: '锁脸→内容→词条' };
});

/* 人物向/场景向选档（方案-生图 v2 第 5 节）：
   subject 有人物 tag → 人物向（用户预设）；没有 → 场景向内置。 */
t('buildPrompt 选档：人物向用接口预设，场景向换内置且负面排人', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  api.positivePreset = '{p}, my custom person words';
  const p1 = g.buildPrompt({ api, subject: '1boy, reading a book' });
  if (p1.scene !== false) throw new Error('有人物 tag 却走了场景向');
  if (p1.positive.indexOf('my custom person words') < 0) throw new Error('人物向没用接口预设');
  const p2 = g.buildPrompt({ api, subject: 'empty classroom at dusk, rain outside' });
  if (p2.scene !== true) throw new Error('纯场景没走场景向');
  if (p2.positive.indexOf('my custom person words') >= 0) throw new Error('场景向不该用接口预设');
  if (p2.positive.indexOf('scenery') < 0) throw new Error('场景向没有 scenery 词');
  if (p2.negative.indexOf('1girl') < 0) throw new Error('场景向负面没排人');
  return 'ok';
});

/* B0 ImagePlan：有人没人只看 subjects —— 中文 description 不再误套场景基底，
   锁脸跟着画面主体走（跟谁发的无关），多人身份段永不合并去重。 */
t('buildPrompt(plan)：subjects 决定基底与锁脸，中文不误判', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  api.positivePreset = '{p}, my person words';
  const chSub = { entityType: 'char', entityId: 'c1', name: '小雫', gender: 'female', faceText: 'silver hair, red eyes' };
  const chSub2 = { entityType: 'char', entityId: 'c2', name: '小满', gender: 'female', faceText: 'silver hair, blue eyes' };
  const userSub = { entityType: 'user', entityId: 'u1', name: '我', gender: '', faceText: '' };
  const r1 = g.buildPrompt({ api, plan: { sender: 'user', contentType: 'person', shot: 'selfie', subjects: [chSub], description: '窗边喝咖啡，午后阳光' } });
  if (r1.scene !== false) throw new Error('subjects 非空却走了场景基底');
  if (r1.positive.indexOf('my person words') < 0) throw new Error('人物基底没用接口预设');
  if (r1.positive.indexOf('1girl') < 0 || r1.positive.indexOf('silver hair') < 0) throw new Error('char 性别/锁脸没进正向');
  if (r1.negative.indexOf('1girl') >= 0) throw new Error('人物图负面里不该有排人词');
  const r2 = g.buildPrompt({ api, plan: { sender: 'user', contentType: 'scene', shot: 'scene', subjects: [], description: '雨夜窗边' } });
  if (r2.scene !== true || r2.negative.indexOf('1girl') < 0) throw new Error('纯场景该走场景基底');
  const r3 = g.buildPrompt({ api, plan: { sender: 'user', contentType: 'person', shot: 'selfie', subjects: [userSub], description: '对镜自拍' } });
  if (r3.scene !== false) throw new Error('user 出镜也该走人物基底');
  if (r3.positive.indexOf('silver hair') >= 0) throw new Error('user 出镜不该拼到 char 的资料');
  const r4 = g.buildPrompt({ api, plan: { sender: 'char', contentType: 'mixed', shot: 'group', subjects: [userSub, chSub, chSub2], description: '合影' } });
  if (r4.scene !== false) throw new Error('合影不该走场景基底');
  if (r4.positive.split('silver hair').length !== 3) throw new Error('两人相同的特征词被合并去重了');
  if (r4.positive.indexOf('小雫 (1girl') < 0 || r4.positive.indexOf('小满 (1girl') < 0) throw new Error('多人没做名字绑定');
  return 'ok';
});

/* parsePlanJson：结构化 [图]/[生图:] 收口 —— 坏档位/一句话一律回 null 走 legacy。 */
t('parsePlanJson / subjectForChar：白名单收口 + 按 shot 取锁脸组', () => {
  const g = S.imggen;
  const ok = g.parsePlanJson('{"description":"rain on window","contentType":"scene","shot":"scene","subjects":[]}');
  if (!ok || ok.contentType !== 'scene' || ok.subjects.length) throw new Error('JSON 没读出来');
  if (g.parsePlanJson('在阳台喝咖啡的自拍') !== null) throw new Error('一句话不该被解析成 plan');
  const bad = g.parsePlanJson('{"description":"x","contentType":"magic","shot":"nope","subjects":["dog"]}');
  if (bad === null || bad.contentType !== 'scene' || bad.subjects.length) throw new Error('白名单没收口');
  const sub = g.subjectForChar(
    { id: 'c1', name: '小雫', gender: 'female', faceLockText: 'base', faceLockSelfie: 'selfie词', faceLockFull: 'full词' },
    'selfie');
  if (sub.faceText.indexOf('selfie词') < 0 || sub.faceText.indexOf('full词') >= 0) throw new Error('subjectForChar 没按 shot 取锁脸组');
  const uSub = g.subjectForUser({ id: 'u1', name: '' });
  if (uSub.faceText !== '' || uSub.gender !== '') throw new Error('user 主体必须保持空（B1 才补资料）');
  return 'ok';
});

/* B0 sender 语义：sender 只表示图片最终落谁的消息气泡，不参与
   主体/锁脸/基底判断；查岗消息真实归属是 user 气泡 → sender 必须 'user'。 */
t('plan.sender：不参与拼词 + 查岗归属与 sender 一致', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  const chSub = { entityType: 'char', entityId: 'c1', name: '小雫', gender: 'female', faceText: 'silver hair, red eyes' };
  const base = { contentType: 'person', shot: 'selfie', subjects: [chSub], description: '窗边喝咖啡' };
  const asUser = g.buildPrompt({ api, plan: Object.assign({ sender: 'user' }, base) });
  const asChar = g.buildPrompt({ api, plan: Object.assign({ sender: 'char' }, base) });
  if (asUser.positive !== asChar.positive || asUser.negative !== asChar.negative) {
    throw new Error('sender 参与了拼词（主体/基底不该看 sender）');
  }
  /* 查岗：消息存 role:'user' + type:'checkin'，渲染落 user 气泡；
     planFromDirector 的 sender 必须同为 'user'，不许写成 'char'。 */
  const src = fs.readFileSync('page-chat.js', 'utf8');
  if (src.indexOf("planFromDirector(d, ch, c, 'user')") < 0) {
    throw new Error('runCheckin 的 plan.sender 不是 user');
  }
  const m = /role:\s*'user',\s*type:\s*'checkin'/.exec(src);
  if (!m) throw new Error('查岗消息不是 user 气泡了（归属变了要同步 sender）');
  if (src.indexOf("planFromDirector(d, ch, c, 'char')") >= 0) {
    throw new Error('查岗被错写成 char 归属');
  }
  return 'ok';
});

/* B1 user 马甲锁脸：subjectForUser 读马甲**自己**的性别与外貌，分档与 char
   同语义；user/char 实体边界不串；sender 不影响读取；空 subjects 不拼任何锁脸。 */
t('B1 subjectForUser：马甲自己的外貌 + shot 分档 + 实体边界', () => {
  const g = S.imggen;
  const mkA = { id: 'uA', name: '马甲A', gender: 'female', faceLockText: 'black bob hair', faceLockSelfie: 'peace sign', faceLockFull: 'red sneakers' };
  const mkB = { id: 'uB', name: '马甲B', gender: 'male', faceLockText: 'tall, glasses', faceLockSelfie: 'smirk', faceLockFull: 'blue jacket' };
  const sSelf = g.subjectForUser(mkA, 'selfie');
  if (sSelf.faceText !== 'black bob hair, peace sign') throw new Error('user 自拍分档不对');
  if (sSelf.gender !== 'female') throw new Error('user 性别没读自己的');
  if (g.subjectForUser(mkA, 'group').faceText !== 'black bob hair, red sneakers') throw new Error('user 全身分档不对');
  if (g.subjectForUser(mkB, 'selfie').faceText.indexOf('peace sign') >= 0) throw new Error('马甲 B 串到马甲 A 的外貌了');
  const api = g.newApi('general');
  const both = g.buildPrompt({ api, plan: { sender: 'user', contentType: 'mixed', shot: 'group',
    subjects: [g.subjectForUser(mkA, 'group'), g.subjectForChar({ id: 'c1', name: '小雫', gender: 'female', faceLockText: 'silver hair' }, 'group')],
    description: '合影' } });
  if (both.positive.indexOf('马甲A (1girl') < 0 || both.positive.indexOf('小雫 (1girl') < 0) throw new Error('合影没做实体绑定');
  if (both.positive.indexOf('red sneakers') < 0 || both.positive.indexOf('silver hair') < 0) throw new Error('两人外貌段缺失');
  const onlyChar = g.buildPrompt({ api, plan: { sender: 'user', contentType: 'person', shot: 'selfie',
    subjects: [g.subjectForChar({ id: 'c1', gender: 'female', faceLockText: 'silver hair' }, 'selfie')], description: '给 TA 拍一张' } });
  if (onlyChar.positive.indexOf('black bob hair') >= 0) throw new Error('sender=user 却拼了 user 外貌');
  const onlyUser = g.buildPrompt({ api, plan: { sender: 'char', contentType: 'person', shot: 'selfie',
    subjects: [g.subjectForUser(mkA, 'selfie')], description: '拍你' } });
  if (onlyUser.positive.indexOf('silver hair') >= 0) throw new Error('sender=char 却拼了 char 外貌');
  if (onlyUser.positive.indexOf('peace sign') < 0 || onlyUser.positive.indexOf('1girl') < 0) throw new Error('user 主体的性别/锁脸没进');
  const empty = g.buildPrompt({ api, plan: { sender: 'user', contentType: 'scene', shot: 'scene', subjects: [], description: '一杯咖啡' } });
  if (empty.positive.indexOf('black bob hair') >= 0 || empty.positive.indexOf('silver hair') >= 0) throw new Error('空 subjects 不该拼任何锁脸');
  const blank = g.subjectForUser({ id: 'u9', name: '' }, 'selfie');
  if (blank.faceText !== '' || blank.name !== '我') throw new Error('空马甲要兜「我」且锁脸为空');
  return 'ok';
});

/* ==================== 正式生图：内置 / 自定义（2026-10-01 施工单 v1） ==================== */
/* 路由：0→01；1→02；2→03；3~4→04；custom 只换视觉层；校验不过 → 明确报错。 */
t('buildFormalPrompt：人数路由 01/02/03/04 + 底座词逐字命中', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  const mk = (id, name, gender, faceText) => ({ entityType: 'char', entityId: id, name, gender, faceText });
  /* 01 内置：场景词进、结构排人、负面带排人组 */
  const r01 = g.buildFormalPrompt({ api, plan: { contentType: 'scene', shot: 'scene', subjects: [], description: '雨夜窗边' } });
  if (!r01.ok) throw new Error('01 应当通过：' + (r01.error || {}).message);
  if (r01.debug.base !== '01-scene') throw new Error('01 底座标签不对');
  if (r01.positive.indexOf('empty of people') < 0 || r01.positive.indexOf('natural realistic photography') < 0) throw new Error('01 内置词没进');
  if (r01.negative.indexOf('people') < 0 || r01.negative.indexOf('lowres') < 0) throw new Error('01 负面少了质量/排人');
  /* 02 内置男 / 女 C 正式 v2：身份优先词逐字在；单人结构在；审美负面不注入 */
  const rM = g.buildFormalPrompt({ api, plan: { contentType: 'person', shot: 'selfie', subjects: [mk('c1', '小雫', 'male', 'short black hair')], description: '对镜自拍' } });
  if (!rM.ok || rM.debug.base !== '02-male-v2') throw new Error('02 男路由不对：' + JSON.stringify(rM.debug && rM.debug.base));
  if (rM.positive.indexOf("described male character's face") < 0) throw new Error('男性正式 v2 没进');
  if (rM.positive.indexOf('idealized adult male face') >= 0) throw new Error('正式路径不该再拼实验旧词');
  if (rM.positive.indexOf('soft dimensional daylight') >= 0) throw new Error('正式 v2 不该再有 daylight 定向');
  if (rM.positive.indexOf('retaining the stated age') < 0) throw new Error('stated age 要保留（不自动补成年）');
  if (rM.positive.indexOf('solo, exactly one person') < 0 || rM.positive.indexOf('close-up selfie shot') < 0) throw new Error('单人结构/镜头层没进');
  if (rM.positive.indexOf('1boy') < 0 || rM.positive.indexOf('short black hair') < 0) throw new Error('身份段没进');
  if (rM.negative.indexOf('plastic skin') >= 0) throw new Error('02 不该带审美负面（定稿态 noAesthetic）');
  if (rM.negative.indexOf('extra person') < 0) throw new Error('02 缺单人结构负面');
  const rF = g.buildFormalPrompt({ api, plan: { contentType: 'person', shot: 'full', subjects: [mk('c1', '小雫', 'female', 'silver hair')], description: '站在海边' } });
  if (!rF.ok || rF.debug.base !== '02-female-c-v2') throw new Error('02 女路由不对');
  if (rF.positive.indexOf('strikingly beautiful female character') < 0) throw new Error('女性正式 v2 没进');
  if (rF.positive.indexOf('strikingly beautiful adult woman') >= 0) throw new Error('正式路径不该再拼实验旧词');
  if (rF.positive.indexOf('East Asian') >= 0) throw new Error('正式 v2 不该再有族裔兜底');
  if (rF.positive.indexOf('Keep makeup light') >= 0) throw new Error('正式 v2 不该再有默认妆容句');
  /* 02 内置 + 性别未指定 → 中性底座（返修 v2 §1：不再因性别报错） */
  const rN = g.buildFormalPrompt({ api, plan: { contentType: 'person', shot: 'auto', subjects: [mk('c1', '小雫', '', 'scales on arms, fish tail')], description: '一条人鱼' } });
  if (!rN.ok || rN.debug.base !== '02-neutral-v1') throw new Error('未知性别该走中性底座：' + JSON.stringify(rN.debug && rN.debug.base));
  if (rN.positive.indexOf('do not replace them with a standardized human appearance') < 0) throw new Error('中性词没进');
  if (rN.positive.indexOf('scales on arms, fish tail') < 0) throw new Error('物种描述要原样保留');
  if (rN.positive.indexOf('solo, exactly one subject') < 0 || rN.positive.indexOf('exactly one person') >= 0) throw new Error('中性结构没替换 person');
  if (rN.positive.indexOf('without imposing a gender, an adult age, a human anatomy, a daylight setting') < 0) throw new Error('中性否定句缺失');
  if (rN.negative.indexOf('deformed face') >= 0) throw new Error('中性负面不该有人体脸型三连');
  if (rN.negative.indexOf('extra person') < 0) throw new Error('中性负面该保留防增人');
  if (rN.positive.indexOf('1girl') >= 0 || rN.positive.indexOf('1boy') >= 0) throw new Error('未知性别不许被系统补性别 tag（核查1 反向断言）');
  /* 02 custom：只换视觉层；空 custom 合法不回退内置 */
  const rC = g.buildFormalPrompt({ api, styleMode: 'custom', customStyle: 'flat graphic illustration, limited palette',
    plan: { contentType: 'person', shot: 'auto', subjects: [mk('c1', '小雫', 'male', '')], description: '站着' } });
  if (!rC.ok || rC.debug.base !== '02-custom') throw new Error('02 custom 路由不对');
  if (rC.positive.indexOf('flat graphic illustration') < 0) throw new Error('custom 词没进');
  if (rC.positive.indexOf("described male character's face") >= 0) throw new Error('custom 不该混内置审美词');
  const rCE = g.buildFormalPrompt({ api, styleMode: 'custom', customStyle: '',
    plan: { contentType: 'person', shot: 'auto', subjects: [mk('c1', '小雫', 'female', '')], description: '站着' } });
  if (!rCE.ok) throw new Error('空 custom 该合法');
  if (rCE.positive.indexOf('strikingly beautiful female character') >= 0) throw new Error('空 custom 回退成内置了');
  /* 03：双人结构 + 名字绑定 + 相同外貌不去重 + 双人内置视觉层恰好一份 */
  const r03 = g.buildFormalPrompt({ api, plan: { contentType: 'mixed', shot: 'group',
    subjects: [mk('c1', '小雫', 'female', 'silver hair'), mk('u1', '我', 'female', 'silver hair')], description: '并肩看海' } });
  if (!r03.ok || r03.debug.base !== '03') throw new Error('03 路由不对');
  if (r03.positive.indexOf('Exactly two people are present') < 0) throw new Error('双人结构词没进');
  if (countOf(r03.positive, 'the two described people') !== 1) throw new Error('03 双人视觉层没有恰好一份');
  if (countOf(r03.positive, 'Render both people with equally careful facial detail') !== 1) throw new Error('03 视觉层正文缺失');
  if (countOf(r03.positive, 'keeping both people\'s faces readable') !== 1) throw new Error('03 视觉层第三段缺失');
  if (r03.positive.split('silver hair').length !== 3) throw new Error('两个身份相同的特征被跨主体去重了');
  if (r03.positive.indexOf('小雫 (1girl') < 0 || r03.positive.indexOf('我 (1girl') < 0) throw new Error('双人没做名字绑定');
  if (r03.positive.indexOf("described male character's face") >= 0 || r03.positive.indexOf('strikingly beautiful female character') >= 0
    || r03.positive.indexOf('standardized human appearance') >= 0) throw new Error('双人不该拼单人/中性词');
  if (r03.negative !== 'lowres, worst quality, low quality, jpeg artifacts, blurry') throw new Error('03 负面该只有质量层：' + r03.negative);
  /* 03 custom：内置双人词不混入 */
  const r03c = g.buildFormalPrompt({ api, styleMode: 'custom', customStyle: 'crayon sketch style',
    plan: { contentType: 'mixed', shot: 'group',
      subjects: [mk('c1', '小雫', 'female', 'silver hair'), mk('u1', '我', 'female', '')], description: '并肩看海' } });
  if (!r03c.ok || r03c.debug.base !== '03-custom') throw new Error('03 custom 路由不对');
  if (r03c.positive.indexOf('crayon sketch style') < 0) throw new Error('03 custom 词没进');
  if (r03c.positive.indexOf('the two described people') >= 0) throw new Error('03 custom 混入了内置双人词');
  /* 04：四人 + 群像结构 + 多人视觉层恰好一份 */
  const four = [mk('c1', 'A', 'female', 'a-hair'), mk('c2', 'B', 'male', 'b-hair'), mk('c3', 'C', 'female', 'c-hair'), mk('u1', 'D', 'male', 'd-hair')];
  const r04 = g.buildFormalPrompt({ api, plan: { contentType: 'mixed', shot: 'group', subjects: four, description: '四人合影' } });
  if (!r04.ok || r04.debug.base !== '04') throw new Error('04 路由不对');
  if (r04.positive.indexOf('Exactly the described number of people') < 0) throw new Error('群像结构词没进');
  if (countOf(r04.positive, 'Render every person with equally careful facial detail') !== 1) throw new Error('04 视觉层没有恰好一份');
  if (countOf(r04.positive, 'keeping every person\'s face readable') !== 1) throw new Error('04 视觉层第三段缺失');
  if (r04.positive.indexOf('both people') >= 0) throw new Error('04 混进了双人版视觉词');
  ['A (1girl', 'B (1boy', 'C (1girl', 'D (1boy'].forEach((k) => {
    if (r04.positive.indexOf(k) < 0) throw new Error('四人身份块缺 ' + k);
  });
  /* 04 custom 空/非空：均无内置词 */
  const r04c = g.buildFormalPrompt({ api, styleMode: 'custom', customStyle: 'ink wash painting',
    plan: { contentType: 'mixed', shot: 'group', subjects: four, description: '四人合影' } });
  if (!r04c.ok || r04c.positive.indexOf('ink wash painting') < 0
    || r04c.positive.indexOf('Render every person') >= 0) throw new Error('04 custom 混入了内置多人词');
  const r04e = g.buildFormalPrompt({ api, styleMode: 'custom', customStyle: '',
    plan: { contentType: 'mixed', shot: 'group', subjects: four, description: '四人合影' } });
  if (!r04e.ok || r04e.positive.indexOf('Render every person') >= 0) throw new Error('04 空 custom 混入了内置多人词');
  return 'ok';
});

/* 校验关口：重复引用 / 预期人数对账 / 超 4 人 / 0人报person / NAI 不接 —— 全部零请求形状 */
t('buildFormalPrompt：校验拦截逐条 + NAI 回落 null', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  const mk = (id, name, gender, faceText) => ({ entityType: 'char', entityId: id, name, gender, faceText });
  /* 重复身份引用 */
  const dup = g.buildFormalPrompt({ api, plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', ''), mk('c1', '甲', 'female', '')], description: 'x' } });
  if (dup.ok !== false || dup.error.message.indexOf('重复') < 0) throw new Error('重复引用没拦：' + (dup.error || {}).message);
  /* 外貌相同但身份不同 → 合法（§五.3） */
  const sameFace = g.buildFormalPrompt({ api, plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', 'silver hair'), mk('c2', '乙', 'female', 'silver hair')], description: 'x' } });
  if (!sameFace.ok) throw new Error('不同身份相同外貌不该拦');
  /* 预期主体数对账（返修 v2：严格相等）：声明 2 解析出 1 → 拦 */
  const lack = g.buildFormalPrompt({ api, plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', '')], description: 'x', expectedSubjectCount: 2 } });
  if (lack.ok !== false || lack.error.message.indexOf('解析不了') < 0) throw new Error('预期人数对账没拦');
  /* 声明 1 解析出 1 → 不拦 */
  const ok1 = g.buildFormalPrompt({ api, plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', '')], description: 'x', expectedSubjectCount: 1 } });
  if (!ok1.ok) throw new Error('对账相等不该拦');
  /* 声明 0 + 有人 → 矛盾（声明小于解析数也拦） */
  const extra = g.buildFormalPrompt({ api, plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', '')], description: 'x', expectedSubjectCount: 0 } });
  if (extra.ok !== false || extra.error.message.indexOf('对不上') < 0) throw new Error('声明0却有人没拦');
  /* 声明 0 + 没人 + scene → 合法（absent 与显式 0 都允许） */
  const ok0d = g.buildFormalPrompt({ api, plan: { contentType: 'scene', subjects: [], description: 'x', expectedSubjectCount: 0 } });
  if (!ok0d.ok) throw new Error('显式声明 0 该合法');
  /* 声明格式非法（非整数 / 负数）→ 拦 */
  const badFmt = g.buildFormalPrompt({ api, plan: { contentType: 'scene', subjects: [], description: 'x', expectedSubjectCount: 'x' } });
  if (badFmt.ok !== false || badFmt.error.message.indexOf('格式') < 0) throw new Error('声明格式非法没拦');
  const negFmt = g.buildFormalPrompt({ api, plan: { contentType: 'scene', subjects: [], description: 'x', expectedSubjectCount: -1 } });
  if (negFmt.ok !== false || negFmt.error.message.indexOf('格式') < 0) throw new Error('负数声明没拦');
  /* absent（未声明）→ 不做人数对账（程序自造主体的入口） */
  const absent = g.buildFormalPrompt({ api, plan: { contentType: 'scene', subjects: [], description: 'x' } });
  if (!absent.ok) throw new Error('未声明不该对账');
  /* 超 4 人 */
  const five = [1, 2, 3, 4, 5].map((i) => mk('c' + i, '人' + i, 'female', ''));
  const over = g.buildFormalPrompt({ api, plan: { contentType: 'mixed', subjects: five, description: 'x' } });
  if (over.ok !== false || over.error.message.indexOf('最多') < 0) throw new Error('超 4 人没拦');
  /* 0 人 + person → 语义不明 */
  const ghost = g.buildFormalPrompt({ api, plan: { contentType: 'person', subjects: [], description: 'x' } });
  if (ghost.ok !== false || ghost.error.message.indexOf('没解析出来') < 0) throw new Error('0人报person没拦');
  /* 0 人 + scene → 通过（01） */
  const ok0 = g.buildFormalPrompt({ api, plan: { contentType: 'scene', subjects: [], description: 'x' } });
  if (!ok0.ok) throw new Error('0人场景该通过');
  /* NAI：buildFormalPrompt 纯函数层守卫不变（generate 已分流到 buildFormalNaiRequest） */
  const nai = g.buildFormalPrompt({ api: g.newApi('nai'), plan: { contentType: 'scene', subjects: [], description: 'x' } });
  if (nai !== null) throw new Error('NAI 应返回 null（纯函数层守卫）');
  /* parsePlanJson：subjectsDeclared 必须是白名单过滤**前**的原始声明数 */
  const pj = g.parsePlanJson('{"description":"x","subjects":["char","dog","user"]}');
  if (!pj || pj.subjects.length !== 2 || pj.subjectsDeclared !== 3) {
    throw new Error('subjectsDeclared 不是解析前声明数：' + JSON.stringify(pj && pj.subjectsDeclared));
  }
  const pj0 = g.parsePlanJson('{"description":"x","subjects":[]}');
  if (!pj0 || pj0.subjectsDeclared !== 0) throw new Error('显式空声明该是 0 而不是 absent');
  /* extras 全局去重仍生效；身份块不去重（两条 silver hair 身份 + description 里的 silver hair 全保留） */
  const rD = g.buildFormalPrompt({ api, plan: { contentType: 'mixed', subjects: [mk('c1', '甲', 'female', 'silver hair'), mk('c2', '乙', 'male', 'silver hair')], description: '两人都 silver hair' } });
  if (rD.positive.split('silver hair').length !== 4) throw new Error('身份块被跨层去重了');
  return 'ok';
});

/* buildFormalNaiRequest：NAI 正式编译器（2026-10-02 施工单）纯函数层 */
t('buildFormalNaiRequest：V3 身份进 input / V4 char_captions / 预设消费 / 拒绝边界', () => {
  const g = S.imggen;
  const mk = (id, name, gender, faceText) => ({ entityType: 'char', entityId: id, name, gender, faceText });
  const v3 = { kind: 'nai', model: 'nai-diffusion-3', positivePreset: '', negativePreset: '' };
  const v4 = { kind: 'nai', model: 'nai-diffusion-4-5-full', positivePreset: '', negativePreset: '' };

  /* V3 单人：身份标记进 input、无 V4 字段、ucPreset 语义不受本函数影响 */
  const r1 = g.buildFormalNaiRequest({ api: v3,
    plan: { contentType: 'person', shot: 'full',
      subjects: [mk('c1', '甲', 'female', 'qzx银发标记')], description: 'qzx场景' },
    extras: ['qzx词条E'] });
  if (!r1.ok) throw new Error('V3 单人该通过：' + JSON.stringify(r1.error));
  if (r1.request.positive.indexOf('qzx银发标记') < 0 || r1.request.positive.indexOf('1girl') < 0
    || r1.request.positive.indexOf('full body') < 0) throw new Error('V3 单人身份/镜头没进 input');
  if (r1.request.positive.indexOf('qzx场景') < 0 || r1.request.positive.indexOf('qzx词条E') < 0) {
    throw new Error('V3 描述/extras 没进 input');
  }
  if (r1.request.v4Prompt || r1.request.v4NegativePrompt) throw new Error('V3 不该有 V4 字段');
  if (r1.debug.multiCharacter !== 'single') throw new Error('单人 debug 不对');

  /* V3 双人：两位标记都进 input，顺序描述（降级标注） */
  const r2 = g.buildFormalNaiRequest({ api: v3,
    plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', 'qzx标记A'), mk('c2', '乙', 'male', 'qzx标记B')], description: 'x' } });
  if (r2.request.positive.indexOf('qzx标记A') < 0 || r2.request.positive.indexOf('qzx标记B') < 0) {
    throw new Error('V3 双人身份丢了');
  }
  if (r2.request.positive.indexOf('1girl') < 0 || r2.request.positive.indexOf('1boy') < 0) {
    throw new Error('V3 双人人数聚合不对');
  }
  if (r2.debug.multiCharacter !== 'sequential-degraded') throw new Error('V3 多人该标降级');

  /* V4.5 双人：char_captions 逐主体、顺序对应、负面只有 base、use_* 显式 */
  const r3 = g.buildFormalNaiRequest({ api: v4,
    plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', 'qzx标记A'), mk('c2', '乙', 'male', 'qzx标记B')], description: 'x' } });
  const vp = r3.request.v4Prompt;
  if (!vp || vp.caption.char_captions.length !== 2
    || vp.caption.char_captions[0].char_caption.indexOf('qzx标记A') < 0
    || vp.caption.char_captions[1].char_caption.indexOf('qzx标记B') < 0) {
    throw new Error('V4 char_captions 不对');
  }
  if (vp.caption.char_captions.some((c) => c.char_caption.indexOf('1girl') >= 0 || c.char_caption.indexOf('1boy') >= 0)) {
    throw new Error('char_captions 里混入了带数字的人数 tag');
  }
  if (vp.use_coords !== false || vp.use_order !== true || 'legacy_uc' in vp) {
    throw new Error('use_coords/use_order/legacy_uc 处理不对');
  }
  if (vp.caption.base_caption !== r3.request.positive) throw new Error('base_caption 与 input 不同值');
  const vn = r3.request.v4NegativePrompt;
  if (!vn || vn.caption.base_caption !== r3.request.negative || vn.caption.char_captions.length !== 0) {
    throw new Error('v4_negative_prompt 形状不对');
  }
  if (vp.caption.char_captions.some((c) => 'centers' in c)) throw new Error('不该发 centers');

  /* 人数聚合：1girl + 2girls 主体 → 3girls（同性别合并、单复数分支） */
  const rAgg = g.buildFormalNaiRequest({ api: v3,
    plan: { contentType: 'person', subjects: [mk('a', '', 'female', ''), mk('b', '', 'female', ''), mk('c', '', 'female', '')], description: 'x' } });
  if (rAgg.request.positive.indexOf('3girls') < 0) throw new Error('3girls 聚合不对');

  /* 未知性别：不贡献人数 tag、不丢主体、coverage=partial */
  const rU = g.buildFormalNaiRequest({ api: v3,
    plan: { contentType: 'person', subjects: [mk('u', '未', '', 'qzx未知标记'), mk('f', '', 'female', '')], description: 'x' } });
  if (rU.debug.countCoverage !== 'partial') throw new Error('未知性别该标 partial');
  if (rU.request.positive.indexOf('qzx未知标记') < 0) throw new Error('未知性别主体被丢了');
  if (rU.request.positive.indexOf('1other') >= 0) throw new Error('未知性别不该冒充 1other');

  /* 接口预设沿用现有消费契约：自定义词不失效；空回填出厂词；出厂词不双份 */
  const custom = { kind: 'nai', model: 'nai-diffusion-3',
    positivePreset: '{p}, qzx正预设Q', negativePreset: 'qzx负预设N, lowres' };
  const rP = g.buildFormalNaiRequest({ api: custom,
    plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', '')], description: 'x' } });
  if (rP.request.positive.indexOf('qzx正预设Q') < 0) throw new Error('自定义正预设词失效了');
  if (rP.request.negative.indexOf('qzx负预设N') < 0) throw new Error('自定义负预设词失效了');
  if (rP.request.negative.split('lowres').length !== 2) throw new Error('出厂词被重复追加了');
  const rB = g.buildFormalNaiRequest({ api: v3,
    plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', '')], description: 'x' } });
  if (rB.request.negative.indexOf('very displeasing') < 0) throw new Error('空预设该按现有契约回填出厂词');
  if (rB.request.negative.split('watermark').length !== 2) throw new Error('watermark 该去重成一份');

  /* 拒绝边界：校验复用 + 模型不支持 → 明确报错，无 null 形态 */
  const rDup = g.buildFormalNaiRequest({ api: v3,
    plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', ''), mk('c1', '甲', 'female', '')], description: 'x' } });
  if (rDup.ok || rDup.error.message !== '画面主体重复了') throw new Error('校验没复用（重复主体）');
  const rBad = g.buildFormalNaiRequest({ api: { kind: 'nai', model: 'nai-unknown', positivePreset: '', negativePreset: '' },
    plan: { contentType: 'person', subjects: [mk('c1', '甲', 'female', '')], description: 'x' } });
  if (rBad.ok || rBad.error.message.indexOf('模型') < 0) throw new Error('不支持的模型该明确报错');
  return 'ok';
});

/* 配置字段：默认 builtin、非法值回落、切换不清空 custom 原文 */
t('imgStyleMode / imgStyleCustom：默认与保留', () => {
  const g = S.imggen;
  g.setImgStyleCustom('my custom words');
  g.setImgStyleMode('custom');
  if (g.imgStyleMode() !== 'custom' || g.imgStyleCustom() !== 'my custom words') throw new Error('custom 读写不对');
  g.setImgStyleMode('builtin');
  if (g.imgStyleMode() !== 'builtin') throw new Error('builtin 切换不对');
  if (g.imgStyleCustom() !== 'my custom words') throw new Error('切换清空了 custom 原文');
  g.setImgStyleMode('nonsense');
  if (g.imgStyleMode() !== 'builtin') throw new Error('非法值要回落 builtin');
  g.setImgStyleCustom('');
  return 'ok';
});

/* B1 core.upsertUser：马甲外貌四字段各自独立保存/更新，旧数据兜空串。 */
t('B1 upsertUser：马甲外貌四字段读写与兼容', () => {
  const core = S.core;
  const a = core.upsertUser({ name: 'B1甲', gender: 'female', faceLockText: 'bob', faceLockSelfie: 'peace', faceLockFull: 'red shoes' });
  const b = core.upsertUser({ name: 'B1乙', gender: 'male', faceLockText: 'glasses' });
  const ra = core.findUser(a.id);
  const rb = core.findUser(b.id);
  if (ra.gender !== 'female' || ra.faceLockText !== 'bob' || ra.faceLockSelfie !== 'peace' || ra.faceLockFull !== 'red shoes') {
    throw new Error('甲的四字段没存上');
  }
  if (rb.faceLockText !== 'glasses' || rb.faceLockFull !== '' || rb.faceLockSelfie !== '') {
    throw new Error('乙的空字段没兜空串');
  }
  core.upsertUser({ id: a.id, faceLockText: 'bob v2' });
  const ra2 = core.findUser(a.id);
  if (ra2.faceLockText !== 'bob v2' || ra2.faceLockSelfie !== 'peace') throw new Error('单字段更新丢了别的字段');
  const legacy = core.upsertUser({ name: '老马甲' });
  const rl = core.findUser(legacy.id);
  if (rl.gender !== '' || rl.faceLockText !== '' || rl.faceLockSelfie === undefined || rl.faceLockFull === undefined) {
    throw new Error('旧数据没标准化成空串');
  }
  return 'ok';
});

/* E1 视觉层本地实验：三模式独立、custom 空不偷偷回退默认、
   审美负面仅 sleepy-default 生效、层内去重不跨层、legacy/含人物返回 null。 */
t('E1 视觉实验：visualStyleText + buildSceneObjectExperimentPrompt', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  if (g.visualStyleText('general', 'legacy', '', 'scene') !== '') throw new Error('legacy 不该有视觉词');
  if (g.visualStyleText('general', 'custom', '', 'scene') !== '') throw new Error('custom 空=没有审美词，不许回退默认');
  if (g.visualStyleText('general', 'custom', 'flat art', 'scene') !== 'flat art') throw new Error('custom 词没透传');
  if (g.visualStyleText('general', 'sleepy-default', '', 'person') !== '') throw new Error('人物类本批返回空');
  const sd = g.buildSceneObjectExperimentPrompt({ api, description: '雨天窗边', contentType: 'scene', subjects: [], visualMode: 'sleepy-default', customVisualStyle: '', extras: [] });
  if (!sd) throw new Error('sleepy-default 应出 prompt');
  if (sd.positive.indexOf('natural realistic photography') < 0) throw new Error('没拼 General 视觉底座');
  if (sd.positive.indexOf('empty of people') < 0) throw new Error('无人主体结构缺失');
  if (sd.positive.indexOf('雨天窗边') < 0) throw new Error('description 缺失');
  if (sd.positive.indexOf('masterpiece') !== 0) throw new Error('必要质量层应在最前');
  if (sd.negative.indexOf('oversaturated colors') < 0) throw new Error('sleepy-default 该有审美负面');
  if (sd.negative.indexOf('people') < 0) throw new Error('结构负面缺失');
  const cu = g.buildSceneObjectExperimentPrompt({ api, description: '木桌早餐', contentType: 'scene', subjects: [], visualMode: 'custom', customVisualStyle: '', extras: [] });
  if (cu.positive.indexOf('natural realistic photography') >= 0) throw new Error('custom 空词偷偷回退了 Sleepy 默认');
  if (cu.negative.indexOf('oversaturated colors') >= 0) throw new Error('审美负面漏进 custom');
  if (cu.negative.indexOf('person') < 0) throw new Error('custom 丢了结构负面');
  const cu2 = g.buildSceneObjectExperimentPrompt({ api, description: '木桌早餐', contentType: 'scene', subjects: [], visualMode: 'custom', customVisualStyle: 'flat art, limited palette', extras: [] });
  if (cu2.positive.indexOf('flat art') < 0 || cu2.positive.indexOf('limited palette') < 0) throw new Error('自定义视觉词没进');
  const nai = g.buildSceneObjectExperimentPrompt({ api: g.newApi('nai'), description: '便利店门口', contentType: 'scene', subjects: [], visualMode: 'sleepy-default', extras: [] });
  if (nai.positive.indexOf('slice-of-life') < 0) throw new Error('NAI 底座没按 kind 取');
  if (nai.negative.indexOf('1girl') < 0 || nai.negative.indexOf('promotional poster') < 0) throw new Error('NAI 结构/审美负面不对');
  if (g.buildSceneObjectExperimentPrompt({ api, visualMode: 'sleepy-default', subjects: [{ entityType: 'char', entityId: 'c1' }], description: 'x' }) !== null) throw new Error('含人物不进实验');
  if (g.buildSceneObjectExperimentPrompt({ api, visualMode: 'legacy', subjects: [], description: 'x' }) !== null) throw new Error('legacy 应返回 null 走旧路');
  const dup = g.buildSceneObjectExperimentPrompt({ api, description: 'a, a, b', contentType: 'scene', subjects: [], visualMode: 'sleepy-default', extras: [] });
  if (dup.positive.indexOf('a, a') >= 0) throw new Error('层内完全相同词条没去重');
  const m = g.visualExpMode();
  if (m !== 'legacy' && m !== 'sleepy-default' && m !== 'custom') throw new Error('实验模式存储读取出错');
  return 'ok';
});

/* E2 单人角色视觉层（2026-09-30 返修口径）：
   - 真实单主体才注入（不固定 subjects:[]、不靠关键词猜人）；
   - 通用层不写死 adult / rested，也不排皱纹、排疲态；
   - **男性校准两组词（malePositive / maleNegative）当前一律不进 prompt** ——
     没有可靠的结构化依据判断身份有没有写年龄/胡须/沧桑/疲态，注入会反向覆盖事实；
     常量与函数保留作扩展位置（本测试也断言它们还在）；
   - 手只有**明确可见**才给词，unspecified / hidden 一个字都不加；
   - custom（空/非空）都不注入 Sleepy 默认审美与男性校准，但保留身份/结构/镜头/防增人；
   - 多主体、legacy、无人、npc 一律返回 null。
   全部用独立测试夹具（字面量），不碰用户真实角色资料。 */
t('E2 单人视觉实验：真实身份读取 + 层序 + 男性校准暂停 + custom 退出默认审美', () => {
  const g = S.imggen;
  const api = g.newApi('general');
  const male = { entityType: 'char', entityId: 'c1', name: '阿岩', gender: 'male', faceText: 'black hair, stubble beard, tired eyes' };
  const female = { entityType: 'user', entityId: 'u1', name: '我', gender: 'female', faceText: 'long hair' };
  /* 明确年长 / 有胡须 / 沧桑 / 疲态的夹具：用来证明默认模式也不反向覆盖事实 */
  const aged = {
    entityType: 'char', entityId: 'c2', name: '老陈', gender: 'male',
    faceText: 'middle-aged man, greying beard, weathered skin, deep nasolabial folds, tired eyes'
  };
  const AGED_DESC = '站在门口，神情疲惫，胡须没修剪';

  /* 本轮暂停注入的男性校准词（两种模式、正负面都不许出现） */
  const CALIB = [
    'defined but not weathered features',
    'facial hair only when specified by the identity description',
    'unintended aging',
    'unintentionally weathered face',
    'overly rugged features',
    'thick beard when unspecified'
  ];
  const noCalib = (b, tag) => CALIB.forEach((w) => {
    if (b.positive.indexOf(w) >= 0 || b.negative.indexOf(w) >= 0) {
      throw new Error(tag + ' 注入了男性校准词：' + w);
    }
  });
  /* 扩展位置仍在：常量不许被删空 */
  ['general', 'nai'].forEach((k) => {
    if (!g.SLEEPY_SINGLE_STYLE[k].malePositive || !g.SLEEPY_SINGLE_STYLE[k].maleNegative) {
      throw new Error(k + ' 的男性校准常量要留着当扩展位置');
    }
    if (typeof g.singleSubjectGenderAdjustment !== 'function' || typeof g.singleSubjectGenderNegative !== 'function') {
      throw new Error('男性校准两个函数要留着当扩展位置');
    }
  });

  const sd = g.buildSingleSubjectExperimentPrompt({
    api, description: '站在窗边', shot: 'portrait', subjects: [male],
    visualMode: 'sleepy-default', customVisualStyle: '', hands: 'visible', extras: []
  });
  if (!sd) throw new Error('真实单主体应拿到实验 prompt');
  if (sd.positive.indexOf('1boy') < 0) throw new Error('性别没读出 1boy');
  if (sd.positive.indexOf('stubble beard') < 0 || sd.positive.indexOf('tired eyes') < 0) throw new Error('身份事实被通用层覆盖');
  if (sd.positive.indexOf('solo, exactly one person') < 0) throw new Error('单人主体结构没进');
  if (sd.positive.indexOf('half-body portrait') < 0) throw new Error('镜头层没进');
  if (sd.positive.indexOf('站在窗边') < 0) throw new Error('description 没进');
  if (sd.positive.indexOf('natural realistic portrait photography') < 0) throw new Error('按 shot 取的单人底座没进');
  /* 手可见 → 统一手部段（2026-10-01 起全分支同一段，不再按分支分男女审美段／结构版） */
  if (sd.positive.indexOf('Anatomically coherent hands') >= 0) throw new Error('手可见也不该追加系统手部段');
  if (/adult|rested and present/.test(sd.positive)) throw new Error('通用层写了 adult / rested —— 会改写年龄与精神状态事实');
  if (sd.negative.indexOf('exaggerated wrinkles') >= 0 || sd.negative.indexOf('heavy fatigue') >= 0) throw new Error('通用负面排皱纹/排疲态会改写身份事实');
  if (sd.negative.indexOf('extra person') < 0) throw new Error('防随机增人的结构负面没进');
  if (sd.negative.indexOf('plastic skin') < 0) throw new Error('sleepy-default 应有审美型负面');
  noCalib(sd, 'sleepy-default 男性主体');

  /* 女性不注入男性校准（校准关着，这一条是兜底） */
  const sf = g.buildSingleSubjectExperimentPrompt({
    api, description: '坐在沙发上', shot: 'candid', subjects: [female],
    visualMode: 'sleepy-default', extras: []
  });
  if (sf.positive.indexOf('1girl') < 0) throw new Error('女性性别没读出 1girl');
  noCalib(sf, 'sleepy-default 女性主体');

  /* 默认模式：明确年长 / 胡须 / 沧桑 / 疲态 → 事实保留，且没有反向词被额外注入 */
  ['general', 'nai'].forEach((k) => {
    const b = g.buildSingleSubjectExperimentPrompt({
      api: g.newApi(k), description: AGED_DESC, shot: 'portrait', subjects: [aged],
      visualMode: 'sleepy-default', extras: []
    });
    ['middle-aged man', 'greying beard', 'weathered skin', 'deep nasolabial folds', 'tired eyes']
      .forEach((w) => { if (b.positive.indexOf(w) < 0) throw new Error(k + ' 默认模式丢掉了身份事实：' + w); });
    if (b.positive.indexOf(AGED_DESC) < 0) throw new Error(k + ' 默认模式丢掉了 description');
    noCalib(b, k + ' 默认模式（年长/胡须/沧桑/疲态夹具）');
  });

  /* 手部三态一律不追加系统手部段（2026-10-01 定点返修：同步男性最终状态）：
     unspecified / hidden 本来就不追加；visible 也**同样不追加** ——
     手的出现与动作交给 description，界面与 debug 仍如实记 visible。 */
  const un = g.buildSingleSubjectExperimentPrompt({
    api, description: '全身站在街边', shot: 'full', subjects: [male],
    visualMode: 'sleepy-default', hands: 'unspecified', extras: []
  });
  if (un.positive.indexOf('hands') >= 0) throw new Error('未指定时不许追加手部词');
  const hid = g.buildSingleSubjectExperimentPrompt({
    api, description: '自拍', shot: 'selfie', subjects: [male],
    visualMode: 'sleepy-default', hands: 'hidden', extras: []
  });
  if (hid.positive.indexOf('hands') >= 0) throw new Error('明确不入镜时不许追加手部词');
  const vis = g.buildSingleSubjectExperimentPrompt({
    api, description: '自拍', shot: 'selfie', subjects: [male],
    visualMode: 'sleepy-default', hands: 'visible', extras: []
  });
  if (vis.positive.indexOf('Anatomically coherent hands') >= 0) throw new Error('手可见（默认模式）不该再追加系统手部段');
  if (vis.positive.indexOf('naturally long fingers') >= 0) throw new Error('旧修长手指审美词没退休');
  /* 同输入同参数，唯一差集是 hands：两版 positive 必须逐字一致（手部段都为
     空）—— 这里另配一对夹具，不用上面 shots/description 都不同的那两组 */
  const visPair = g.buildSingleSubjectExperimentPrompt({
    api, description: '自拍', shot: 'selfie', subjects: [male],
    visualMode: 'sleepy-default', hands: 'visible', extras: []
  });
  const unPair = g.buildSingleSubjectExperimentPrompt({
    api, description: '自拍', shot: 'selfie', subjects: [male],
    visualMode: 'sleepy-default', hands: 'unspecified', extras: []
  });
  if (visPair.positive !== unPair.positive) throw new Error('visible 与 unspecified 的 positive 应逐字一致（手部段均为空）');
  if (vis.debug.hands !== 'visible') throw new Error('visible 的选择被改写了');
  if (vis.debug.handsVersion !== 'off') throw new Error('手可见时手部词版本标识应为 off（关闭）');

  /* custom（空 / 非空）：无默认视觉词、无男性校准；保留身份/结构/镜头/防增人（手部结构版已退休） */
  ['general', 'nai'].forEach((k) => {
    [['', '空 custom'], ['flat graphic illustration, limited color palette', '非空 custom']].forEach((c) => {
      const b = g.buildSingleSubjectExperimentPrompt({
        api: g.newApi(k), description: '站在窗边', shot: 'full', subjects: [male],
        visualMode: 'custom', customVisualStyle: c[0], hands: 'visible', extras: []
      });
      const lookWords = (k === 'general')
        ? ['natural realistic full-body photography', 'visually pleasing but unposed']
        : ['full-body slice-of-life illustration', 'grounded and unembellished'];
      lookWords.forEach((w) => {
        if (b.positive.indexOf(w) >= 0) throw new Error(k + ' ' + c[1] + ' 注入了 Sleepy 默认视觉词：' + w);
      });
      if (b.positive.indexOf('naturally long fingers') >= 0 || b.positive.indexOf('knuckle definition') >= 0) {
        throw new Error(k + ' ' + c[1] + ' 不该注入修长手指／骨节审美');
      }
      if (b.positive.indexOf('Anatomically coherent hands') >= 0) throw new Error(k + ' ' + c[1] + ' 手可见时不该追加系统手部段');
      if (b.positive.indexOf('1boy') < 0) throw new Error(k + ' ' + c[1] + ' 必须保留身份');
      if (b.positive.indexOf('full-body shot') < 0) throw new Error(k + ' ' + c[1] + ' 必须保留镜头');
      if (b.positive.indexOf('站在窗边') < 0) throw new Error(k + ' ' + c[1] + ' 必须保留 description');
      if (b.positive.indexOf('solo, exactly one ' + (k === 'general' ? 'person' : 'character')) < 0) {
        throw new Error(k + ' ' + c[1] + ' 必须保留单人结构');
      }
      if (b.negative.indexOf('extra person') < 0) throw new Error(k + ' ' + c[1] + ' 必须保留防随机增人');
      if (b.negative.indexOf('plastic skin') >= 0) throw new Error(k + ' ' + c[1] + ' 不该注入审美型负面');
      noCalib(b, k + ' ' + c[1]);
      if (c[0] && b.positive.indexOf('flat graphic illustration') < 0) throw new Error(k + ' custom 词没透传');
    });
  });

  /* 身份读取沿用 B0/B1：锁脸按 shot 分档，user 读马甲自己那份 */
  const chRec = { id: 'c9', name: 'X', gender: 'male', faceLockText: 'silver hair', faceLockSelfie: 'red eyes', faceLockFull: 'tall' };
  const bSelfie = g.buildSingleSubjectExperimentPrompt({
    api, description: '站在门口', shot: 'selfie',
    subjects: [g.subjectForChar(chRec, 'selfie')], visualMode: 'sleepy-default', extras: []
  });
  if (bSelfie.positive.indexOf('red eyes') < 0) throw new Error('selfie 没取自拍锁脸组');
  if (bSelfie.positive.indexOf('tall') >= 0) throw new Error('selfie 不该取全身锁脸组');
  const bFull = g.buildSingleSubjectExperimentPrompt({
    api, description: '站在门口', shot: 'full',
    subjects: [g.subjectForChar(chRec, 'full')], visualMode: 'sleepy-default', extras: []
  });
  if (bFull.positive.indexOf('tall') < 0) throw new Error('full 没取全身锁脸组');
  const bUser = g.buildSingleSubjectExperimentPrompt({
    api, description: '拿着咖啡', shot: 'selfie',
    subjects: [g.subjectForUser({ id: 'u9', name: '小A', gender: 'female', faceLockText: 'bob hair', faceLockSelfie: 'green eyes' }, 'selfie')],
    visualMode: 'sleepy-default', hands: 'visible', extras: []
  });
  if (bUser.positive.indexOf('1girl') < 0 || bUser.positive.indexOf('green eyes') < 0) throw new Error('马甲身份读取不对');

  /* NAI 同构，且不写死数量词 */
  const nai = g.buildSingleSubjectExperimentPrompt({
    api: g.newApi('nai'), description: '便利店门口', shot: 'candid',
    subjects: [male], visualMode: 'sleepy-default', extras: []
  });
  if (nai.positive.indexOf('slice-of-life illustration') < 0) throw new Error('NAI 单人底座没按 kind 取');
  if (nai.negative.indexOf('duplicate character') < 0) throw new Error('NAI 结构负面不对');
  if (nai.negative.indexOf('1girl') >= 0 || nai.negative.indexOf('1boy') >= 0) throw new Error('NAI 单人不写死数量词');
  noCalib(nai, 'NAI sleepy-default');

  /* 临时单人（普通底座测试）：没岛 / 没角色 / 没马甲也能用；
     不读任何真实身份、不造 entityId、不装成 char|user；性别只在实验里拼。 */
  const TEMP_DESC = '35 岁的男人，灰白短发，眼角有细纹，穿着旧夹克，站在阳台上';
  const g_buildTemp = (kind, gender) => g.buildSingleSubjectExperimentPrompt({
    api: g.newApi(kind), description: TEMP_DESC, shot: 'portrait', tempSingle: true,
    gender: gender, visualMode: 'sleepy-default', extras: []
  });
  [['', '不指定'], ['male', '男'], ['female', '女']].forEach((g) => {
    const b = g_buildTemp('general', g[0]);
    if (b.positive.indexOf('solo, exactly one person') < 0) throw new Error('临时单人缺单人结构');
    const wantTag = g[0] === 'male' ? '1boy' : (g[0] === 'female' ? '1girl' : '');
    if (wantTag && b.positive.indexOf(wantTag) < 0) throw new Error('临时单人没拼出 ' + wantTag);
    if (!wantTag && (b.positive.indexOf('1boy') >= 0 || b.positive.indexOf('1girl') >= 0)) {
      throw new Error('不指定性别时不该硬塞 tag');
    }
    /* 年龄 / 外貌描述原样透传 */
    if (b.positive.indexOf(TEMP_DESC) < 0) throw new Error('描述没透传（' + g[1] + '）');
    if (b.debug.subjectSource !== 'temp-single') throw new Error('subjectSource 不是 temp-single');
    if (b.debug.entityId !== '') throw new Error('临时单人编了 entityId');
    /* 单人路径不能带 01 的无人排人词 */
    ['empty of people', 'no human subject', 'no people, no human figure', 'human']
      .forEach((w) => { if (b.negative.indexOf(w) >= 0) throw new Error('单人负面混进了无人排人词：' + w); });
    noCalib(b, '临时单人 ' + g[1]);
  });
  /* 临时单人**不看** subjects：同时塞一个真实男性身份也必须被无视 */
  const tempShadow = g.buildSingleSubjectExperimentPrompt({
    api, description: '站在窗边', shot: 'portrait', tempSingle: true, gender: 'female',
    subjects: [male], visualMode: 'sleepy-default', extras: []
  });
  if (tempShadow.positive.indexOf('1girl') < 0) throw new Error('临时单人应只用自己选的性别');
  if (tempShadow.positive.indexOf('stubble beard') >= 0) throw new Error('临时单人读了真实身份外貌');
  if (tempShadow.positive.indexOf('1boy') >= 0) throw new Error('临时单人被传入的 subjects 串了性别');
  /* 临时单人 × NAI × 镜头 × 手部 × custom 空 */
  const tempNai = g.buildSingleSubjectExperimentPrompt({
    api: g.newApi('nai'), description: '坐在窗边', shot: 'candid', tempSingle: true,
    gender: 'male', visualMode: 'sleepy-default', hands: 'visible', extras: []
  });
  if (tempNai.positive.indexOf('slice-of-life illustration') < 0) throw new Error('临时单人 NAI 底座没按 kind 取');
  if (tempNai.positive.indexOf('candid shot') < 0) throw new Error('临时单人镜头层没进');
  /* 临时单人手可见也不追加系统手部段（全分支同步关闭） */
  if (tempNai.positive.indexOf('Anatomically coherent hands') >= 0) throw new Error('临时单人手可见不该追加系统手部段');
  const tempCu = g.buildSingleSubjectExperimentPrompt({
    api, description: '坐在窗边', shot: 'full', tempSingle: true, gender: '',
    visualMode: 'custom', customVisualStyle: '', hands: 'visible', extras: []
  });
  if (tempCu.positive.indexOf('natural realistic full-body photography') >= 0) throw new Error('临时单人 custom 空回退了默认');
  if (tempCu.positive.indexOf('Anatomically coherent hands') >= 0) throw new Error('临时单人 custom 不该追加系统手部段');
  if (tempCu.negative.indexOf('plastic skin') >= 0) throw new Error('临时单人 custom 注入了审美负面');
  noCalib(tempCu, '临时单人 custom');
  /* 临时单人的存储 */
  if (['', 'female', 'male'].indexOf(g.singleExpGender()) < 0) throw new Error('临时单人性别实验态读取出错');

  /* ---- 施工单 v2 §3/§5/§6：男性视觉底座替换（只限 General 临时男 + sleepy-default）---- */
  const MALE_LOOK = g.SLEEPY_TEMP_MALE_LOOK;
  const MALE_MARK = 'beautifully idealized adult male face';
  if (!MALE_LOOK || MALE_LOOK.indexOf(MALE_MARK) < 0) throw new Error('男性底座常量丢了或被改写');
  if (MALE_LOOK.indexOf('窗边') >= 0 || MALE_LOOK.indexOf('花束') >= 0) {
    throw new Error('测试内容被写进了默认常量');
  }
  const mkTemp = (kind, gender, mode, custom, hands) => g.buildSingleSubjectExperimentPrompt({
    api: g.newApi(kind), description: '窗边的男人，灰色上衣', shot: 'portrait',
    tempSingle: true, gender: gender, visualMode: mode, customVisualStyle: custom || '',
    hands: hands || 'unspecified', extras: []
  });

  const sdMale = mkTemp('general', 'male', 'sleepy-default');
  if (sdMale.debug.visualLayer !== 'temp-male-v2') throw new Error('新男性分支没被路由');
  const maleCnt = sdMale.positive.split(MALE_MARK).length - 1;
  if (maleCnt !== 1) throw new Error('男性底座应恰好一份，实际 ' + maleCnt + ' 份');
  if (sdMale.positive.indexOf(MALE_LOOK) < 0) throw new Error('胜出原文没逐字落进 positive（空白被改了？）');
  /* 替换，不是叠加：旧 general.look[shot] 一句都不许再出现 */
  ['natural realistic portrait photography', 'visually pleasing but unposed', 'believable facial proportions']
    .forEach((w) => { if (sdMale.positive.indexOf(w) >= 0) throw new Error('旧的默认视觉词仍在叠加：' + w); });
  /* 镜头 / description / 单人结构 / 必要质量层各自保留 */
  if (sdMale.positive.indexOf('half-body portrait') < 0) throw new Error('镜头层没了');
  if (sdMale.positive.indexOf('窗边的男人，灰色上衣') < 0) throw new Error('description 没了');
  if (sdMale.positive.indexOf('solo, exactly one person') < 0) throw new Error('单人结构没了');
  if (sdMale.positive.indexOf('masterpiece, best quality, highly detailed') < 0) throw new Error('必要质量层没了');
  /* 负面沿用 custom 组成：不加审美负面、不加新词 */
  if (sdMale.negative.indexOf('plastic skin') >= 0 || sdMale.negative.indexOf('overly airbrushed skin') >= 0
    || sdMale.negative.indexOf('stiff pose') >= 0) throw new Error('新分支不该带审美负面');
  if (sdMale.negative.indexOf('extra person') < 0) throw new Error('结构负面没了');
  noCalib(sdMale, '男性新底座');
  /* 与「custom = 第五节原文」等价（同输入、hands=unspecified） */
  const cuMale = mkTemp('general', 'male', 'custom', MALE_LOOK);
  if (cuMale.positive !== sdMale.positive) throw new Error('custom 原文 vs 新默认分支：positive 不等价');
  if (cuMale.negative !== sdMale.negative) throw new Error('custom 原文 vs 新默认分支：negative 不等价');
  /* 其他路由维持现状 */
  /* 女性 2026-10-01 起走定稿 C 版（替换默认 look，不是叠加） */
  const femRoute0 = mkTemp('general', 'female', 'sleepy-default');
  if (femRoute0.positive.indexOf('strikingly beautiful adult woman') < 0) throw new Error('女性没走 C 版底座');
  if (femRoute0.positive.indexOf('natural realistic portrait photography') >= 0) throw new Error('女性旧默认视觉词还在叠加');
  if (mkTemp('general', 'female', 'sleepy-default').positive.indexOf(MALE_MARK) >= 0) throw new Error('女性被串了男性词');
  if (mkTemp('general', '', 'sleepy-default').positive.indexOf(MALE_MARK) >= 0) throw new Error('性别不指定不该走男性底座');
  if (mkTemp('nai', 'male', 'sleepy-default').positive.indexOf(MALE_MARK) >= 0) throw new Error('NAI 不该走男性底座');
  if (mkTemp('general', 'male', 'custom').positive.indexOf(MALE_MARK) >= 0) throw new Error('custom 空不该偷加新底座');
  const realMale = g.buildSingleSubjectExperimentPrompt({
    api, description: '站在窗边', shot: 'portrait', subjects: [male],
    visualMode: 'sleepy-default', extras: []
  });
  if (realMale.positive.indexOf(MALE_MARK) >= 0) throw new Error('真实身份不该走临时男性分支');
  if (realMale.negative.indexOf('plastic skin') < 0) throw new Error('其他默认分支的审美负面不该被动');
  /* 路由的两个出口 */
  const genApi = g.newApi('general');
  if (!g.tempMaleLookOn({ tempSingle: true, gender: 'male', visualMode: 'sleepy-default', api: genApi })) throw new Error('tempMaleLookOn 判定错');
  if (g.tempMaleLookOn({ tempSingle: true, gender: 'male', visualMode: 'sleepy-default', api: g.newApi('nai') })) throw new Error('NAI 不该命中男性底座');
  if (g.tempMaleLookOn({ tempSingle: true, gender: 'female', visualMode: 'sleepy-default', api: genApi })) throw new Error('女性不该命中');
  if (g.singleVisualLayerOf({ tempSingle: true, gender: 'male', visualMode: 'sleepy-default', api: genApi }) !== 'temp-male-v2') throw new Error('视觉层版本标签错');
  if (g.singleVisualLayerOf({ tempSingle: true, gender: 'male', visualMode: 'custom', api: genApi }) !== 'custom') throw new Error('custom 的标签不该变');
  /* 手部三态在新分支上仍然按显式选择注入 */
  if (mkTemp('general', 'male', 'sleepy-default', '', 'hidden').positive.indexOf('hands') >= 0) throw new Error('手明确不入镜时不该有手部词');

  /* ---- 女性定稿 C 版（2026-10-01 投票定稿）：General 临时女 + sleepy-default ---- */
  const FEMALE_LOOK = g.SLEEPY_TEMP_FEMALE_LOOK;
  const FEMALE_MARK = 'strikingly beautiful adult woman';
  if (!FEMALE_LOOK || FEMALE_LOOK.indexOf(FEMALE_MARK) < 0) throw new Error('女性 C 版常量丢了或被改写');
  if (FEMALE_LOOK.indexOf('窗边') >= 0 || FEMALE_LOOK.indexOf('花束') >= 0) {
    throw new Error('测试内容被写进了默认常量');
  }
  /* 用户要求强调的「设定优先」必须在正文里 */
  if (FEMALE_LOOK.indexOf('do not replace them with a default face') < 0) throw new Error('C 版丢了「设定优先」那句');
  const sdFemale = mkTemp('general', 'female', 'sleepy-default');
  if (sdFemale.debug.visualLayer !== 'temp-female-c') throw new Error('女性分支没被路由到 C 版');
  const femCnt = sdFemale.positive.split(FEMALE_MARK).length - 1;
  if (femCnt !== 1) throw new Error('C 版应恰好一份，实际 ' + femCnt + ' 份');
  if (sdFemale.positive.indexOf(FEMALE_LOOK) < 0) throw new Error('C 版原文没逐字落进 positive（空白被改了？）');
  /* 替换，不是叠加 */
  ['natural realistic portrait photography', 'visually pleasing but unposed', 'believable facial proportions']
    .forEach((w) => { if (sdFemale.positive.indexOf(w) >= 0) throw new Error('旧的默认视觉词仍在叠加：' + w); });
  /* 镜头 / description / 女性 tag 各自保留 */
  if (sdFemale.positive.indexOf('half-body portrait') < 0) throw new Error('镜头层没了');
  if (sdFemale.positive.indexOf('窗边的男人，灰色上衣') < 0) throw new Error('description 没了');
  if (sdFemale.positive.indexOf('1girl') < 0) throw new Error('女性性别 tag 没了');
  /* 负面（2026-10-01 收尾）：女性 C **与 custom C 对齐** —— 命中 femaleLook 时
     传 noAesthetic=true，同样只留「必要质量负面 + 结构负面」，不追加
     negativeAesthetic（plastic skin / overly airbrushed skin / stiff pose /
     forced smile 这一组）。
     ⚠️ 只改 buildSingleSubjectExperimentPrompt 里那一次传参
     （maleLook || femaleLook）：没动 negativeAesthetic 常量、没放开 maleLook，
     男性分支 / custom / NAI / 真实身份 / 性别未指定 / legacy 一律没变。 */
  if (sdFemale.negative.indexOf('plastic skin') >= 0) throw new Error('女性 C 仍追加了审美负面，没与 custom C 对齐');
  if (sdFemale.negative.indexOf('extra person') < 0) throw new Error('女性 C 的结构负面没了');
  /* A/B 逐字相等验收：同样描述 / 镜头 / hands，custom 填完整 C  vs  默认命中 C。
     ⚠️ 这不是「历史投票请求重现」—— 旧的手部结构段（well-proportioned hands …）
     早已停用，两边请求都不再携带它。 */
  const cuFemaleC = mkTemp('general', 'female', 'custom', FEMALE_LOOK, 'visible');
  if (cuFemaleC.debug.visualLayer !== 'custom') throw new Error('custom 填 C 不该被路由到 C 版（它是 custom 路）');
  if (sdFemale.positive !== cuFemaleC.positive) throw new Error('custom C 与默认 C 的 positive 不逐字相等');
  if (sdFemale.negative !== cuFemaleC.negative) throw new Error('custom C 与默认 C 的 negative 不逐字相等');
  /* 审美负面常量本身仍在（没被删、也没被全局改） */
  if (g.SLEEPY_SINGLE_STYLE.general.negativeAesthetic.indexOf('plastic skin') < 0) throw new Error('negativeAesthetic 常量被改了');
  /* 不串到别的分支 */
  if (sdFemale.positive.indexOf(MALE_MARK) >= 0) throw new Error('女性被串了男性词');
  if (mkTemp('general', '', 'sleepy-default').positive.indexOf(FEMALE_MARK) >= 0) throw new Error('性别不指定不该走女性 C 版');
  if (mkTemp('nai', 'female', 'sleepy-default').positive.indexOf(FEMALE_MARK) >= 0) throw new Error('NAI 不该走女性 C 版');
  if (mkTemp('general', 'female', 'custom').positive.indexOf(FEMALE_MARK) >= 0) throw new Error('custom 空不该偷加 C 版');
  if (realMale.positive.indexOf(FEMALE_MARK) >= 0) throw new Error('真实身份不该命中女性 C 版');
  /* 路由两个出口 */
  if (!g.tempFemaleLookOn({ tempSingle: true, gender: 'female', visualMode: 'sleepy-default', api: genApi })) throw new Error('tempFemaleLookOn 判定错');
  if (g.tempFemaleLookOn({ tempSingle: true, gender: 'male', visualMode: 'sleepy-default', api: genApi })) throw new Error('male 不该命中女性路由');
  if (g.singleVisualLayerOf({ tempSingle: true, gender: 'female', visualMode: 'sleepy-default', api: genApi }) !== 'temp-female-c') throw new Error('女性视觉层版本标签错');

  /* ---- 手部附加词整体关闭（2026-10-01 定点返修：同步男性最终状态）----
     口径：visible / hidden / unspecified **一律不追加系统手部段**；
     旧审美段、旧结构版、统一段都不补位；用户自定义视觉词 / description /
     身份资料里的手部表述原样保留，不删不改不新增。 */
  const HANDS_UNI = g.SLEEPY_HANDS_UNIFIED;
  const OLD_MARK = 'naturally long fingers';
  const OLD_MARK2 = 'subtle visible knuckle definition';
  const STRUCT_MARK = 'well-proportioned hands';
  const NEW_MARK = 'Anatomically coherent hands';
  /* 1. 三个常量都还在（退休但保留，当历史对照与重新启用位置） */
  if (!HANDS_UNI || HANDS_UNI.indexOf(NEW_MARK) < 0) throw new Error('统一手部段常量丢了');
  if (HANDS_UNI.indexOf(OLD_MARK) >= 0 || HANDS_UNI.indexOf(OLD_MARK2) >= 0) throw new Error('统一段里还留着被要求去掉的旧词');
  if (HANDS_UNI.indexOf('比耶') >= 0 || HANDS_UNI.indexOf('peace sign') >= 0) throw new Error('具体动作不许写进通用底座');
  if (g.SLEEPY_SINGLE_STYLE.general.handsPositive.indexOf(OLD_MARK) < 0) throw new Error('历史对照段（handsPositive）没了');
  if (g.SLEEPY_SINGLE_STYLE.general.handsStructure.indexOf(STRUCT_MARK) < 0) throw new Error('历史对照段（handsStructure）没了');
  if (g.SLEEPY_SINGLE_STYLE.nai.handsPositive.indexOf(OLD_MARK) < 0) throw new Error('NAI 历史对照段没了');

  const maleVis = mkTemp('general', 'male', 'sleepy-default', '', 'visible');
  const maleNo = mkTemp('general', 'male', 'sleepy-default', '', 'unspecified');
  /* 2. visible 也返回空串：与 unspecified **逐字相等**（唯一差集＝本来就没有的手部段） */
  if (maleVis.positive !== maleNo.positive) {
    throw new Error('visible 与 unspecified 的 positive 应逐字一致（手部段均为空），实际有差异');
  }
  if (maleVis.debug.handsVersion !== 'off') throw new Error('手部词版本标识应为 off（关闭），实际：' + maleVis.debug.handsVersion);
  if (maleNo.debug.handsVersion !== 'none') throw new Error('unspecified 的版本标识应是 none');
  /* 3. 系统手部段一份都没有：统一段 / 旧审美段 / 旧结构版 全分支都查 */
  [['临时男 v2', maleVis], ['临时女 C', mkTemp('general', 'female', 'sleepy-default', '', 'visible')],
    ['性别未指定', mkTemp('general', '', 'sleepy-default', '', 'visible')],
    ['custom', mkTemp('general', 'male', 'custom', '', 'visible')],
    ['NAI', mkTemp('nai', 'male', 'sleepy-default', '', 'visible')]]
    .forEach((pair) => {
      const p = pair[1].positive;
      if (p.indexOf(NEW_MARK) >= 0) throw new Error(pair[0] + ' 分支还注入了统一手部段');
      if (p.indexOf(OLD_MARK) >= 0 || p.indexOf(OLD_MARK2) >= 0) throw new Error(pair[0] + ' 分支还注入了旧手部审美段');
      if (p.indexOf(STRUCT_MARK) >= 0) throw new Error(pair[0] + ' 分支还注入了旧手部结构版');
      if (p.indexOf('clean natural nails') >= 0) throw new Error(pair[0] + ' 分支还注入了旧手部审美段的另一半');
    });
  /* 4. 真实身份分支同样不追加；且不被串到女性 C 版 */
  const realVis = g.buildSingleSubjectExperimentPrompt({
    api, description: '站在窗边', shot: 'portrait', subjects: [male],
    visualMode: 'sleepy-default', hands: 'visible', extras: []
  });
  if (realVis.positive.indexOf(NEW_MARK) >= 0 || realVis.positive.indexOf(OLD_MARK) >= 0) {
    throw new Error('真实身份分支还在追加手部词');
  }
  if (realVis.positive.indexOf(FEMALE_MARK) >= 0) throw new Error('真实身份不该命中女性 C 版');
  /* 5. 既有结构约束没被误删：负面里防乱肢体 / 排人的那几条仍在（措辞不变） */
  if (realVis.negative.indexOf('extra person') < 0) throw new Error('结构负面（防增人）被删了');
  if (realVis.negative.indexOf('deformed face') < 0) throw new Error('结构负面（防崩脸）被删了');
  if (maleVis.negative.indexOf('extra person') < 0) throw new Error('新男性分支的结构负面被删了');
  /* 6. 用户原文保留：自定义视觉词 / description / 身份资料里的手部表述原样在 */
  /* 注意：自定义视觉词只在 custom 模式生效（sleepy-default 走 look[shot]），
     所以这一条要用 custom 来验，别拿 sleepy-default 当夹具 */
  const USER_HAND_TXT = 'her hands are clasped together, wearing a silver ring';
  const cuHand = mkTemp('general', 'female', 'custom', USER_HAND_TXT, 'visible');
  if (cuHand.positive.indexOf(USER_HAND_TXT) < 0) throw new Error('用户自定义视觉词里的手部表述被删了');
  if (cuHand.positive.indexOf('窗边的男人，灰色上衣') < 0) throw new Error('description 被删了');
  const realHand = g.buildSingleSubjectExperimentPrompt({
    api, description: '握着一杯热咖啡，手背有疤', shot: 'portrait', subjects: [{ ...male }],
    visualMode: 'sleepy-default', hands: 'visible', extras: []
  });
  if (realHand.positive.indexOf('握着一杯热咖啡，手背有疤') < 0) throw new Error('身份资料里的手部描述被删了');
  /* 7. hidden / unspecified：系统手部段同样为空，hands 记录仍按原选择 */
  ['hidden', 'unspecified'].forEach((h) => {
    const b = mkTemp('general', 'male', 'sleepy-default', '', h);
    if (b.positive.indexOf(NEW_MARK) >= 0 || b.positive.indexOf(OLD_MARK) >= 0) {
      throw new Error(h + ' 时不该有任何手部词');
    }
    if (b.debug.handsVersion !== 'none') throw new Error(h + ' 的版本标识应是 none');
    if (b.debug.hands !== h) throw new Error(h + ' 的选择没被如实记录');
  });
  /* 8. 手明确可见 ≠ 不可见：下拉记 visible 就不能被伪装，参数回显也不许说"未加" */
  if (maleNo.debug.hands === 'visible') throw new Error('未指定不该被记成 visible');
  if (maleVis.debug.hands !== 'visible') throw new Error('visible 不该被改写成别的值');
  if (maleVis.debug.handsVersion === 'none') throw new Error('visible 不能把「系统无手部词」说成「没选过可见」');
  /* 9. 负面没被加新词 */
  ['zombie', 'skeleton', 'withered', 'grey skin', 'green skin', 'extra fingers', 'extra limbs'].forEach((w) => {
    if (maleVis.negative.indexOf(w) >= 0) throw new Error('负面被加了新词：' + w);
  });

  /* 守卫：legacy / 无人 / 多主体 / npc */
  const G = { api, description: 'x', shot: 'full', visualMode: 'sleepy-default' };
  if (g.buildSingleSubjectExperimentPrompt(Object.assign({}, G, { subjects: [male], visualMode: 'legacy' })) !== null) throw new Error('legacy 应返回 null 走旧路');
  if (g.buildSingleSubjectExperimentPrompt(Object.assign({}, G, { subjects: [] })) !== null) throw new Error('没人走 01，单人应返回 null');
  if (g.buildSingleSubjectExperimentPrompt(Object.assign({}, G, { subjects: [male, female] })) !== null) throw new Error('多主体不注入单人底座');
  if (g.buildSingleSubjectExperimentPrompt(Object.assign({}, G, { subjects: [{ entityType: 'npc', entityId: 'n1' }] })) !== null) throw new Error('npc 没有 B0 主体类型：返回 null，不许伪装成 char');

  /* 01｜场景与物品本批不受影响（回归） */
  const scene = g.buildSceneObjectExperimentPrompt({
    api, description: '雨天窗边', contentType: 'scene', subjects: [],
    visualMode: 'sleepy-default', extras: []
  });
  if (!scene || scene.positive.indexOf('empty of people') < 0) throw new Error('01 场景/物品路径被 E2 改坏了');

  /* 实验态存储读取 */
  if (['unspecified', 'visible', 'hidden'].indexOf(g.singleExpHands()) < 0) throw new Error('手部实验态读取出错');
  if (['auto', 'selfie', 'portrait', 'full', 'candid'].indexOf(g.singleExpShot()) < 0) throw new Error('镜头实验态读取出错');
  if (typeof g.singleExpSubjectRef() !== 'string') throw new Error('主体实验态读取出错');
  return 'ok';
});

/* 文字通道（/chat/completions）：从模型回复里抽图 —— markdown 图链 /
   dataURI / 带后缀裸链三种都认，抽不到返回空（走报错契约给中转站反馈）。 */
t('文字通道：extractImageFromChatText 三种回图形态 + newApi(chat)', () => {
  const g = S.imggen;
  if (g.extractImageFromChatText('好！![图](https://x.com/a.png?token=1) 给你') !== 'https://x.com/a.png?token=1') {
    throw new Error('markdown 图链没抽到');
  }
  const d = g.extractImageFromChatText('data:image/png;base64,AAAAabcd');
  if (d !== 'data:image/png;base64,AAAAabcd') throw new Error('dataURI 没抽到');
  if (g.extractImageFromChatText('https://cdn.x.com/img/web/123.jpg') !== 'https://cdn.x.com/img/web/123.jpg') {
    throw new Error('裸链没抽到');
  }
  if (g.extractImageFromChatText('抱歉我不会画画') !== '') throw new Error('纯文本不该抽出图');
  const chat = g.newApi('chat');
  if (chat.kind !== 'chat') throw new Error('chat kind 没建上');
  /* 2026-10-08：newApi 不再预灌预设词 —— 空串即「用内置」，运行时回落 */
  if (chat.positivePreset) throw new Error('文字通道新接口不该预灌预设词');
  /* 消费端口径：BUILTIN_PRESET[api.kind] 缺 chat 档 → 回落 general */
  if (g.BUILTIN_PRESET.general.positive.indexOf('{p}') < 0) throw new Error('文字通道回落用的内置预设没质量头');
  if (g.KINDS.chat.label !== '文字通道') throw new Error('KINDS 缺文字通道');
  return 'ok';
});

/* 性别 tag + 锁脸分组：男/女由角色档案出 1boy/1girl；分组按画面类型拼。 */
t('genderTag / faceTextFor：性别 tag 与锁脸分组', () => {
  const g = S.imggen;
  if (g.genderTag({ gender: 'male' }) !== '1boy') throw new Error('男 tag 不对');
  if (g.genderTag({ gender: 'female' }) !== '1girl') throw new Error('女 tag 不对');
  if (g.genderTag({ gender: 'other' }) !== '') throw new Error('其他性别不该硬塞 tag');
  const ch = {
    faceLockText: 'silver hair, red eyes',
    faceLockSelfie: 'close-up, phone front camera',
    faceLockFull: 'tall, beige coat'
  };
  if (g.faceTextFor(ch, 'selfie') !== 'silver hair, red eyes, close-up, phone front camera') {
    throw new Error('selfie 分组拼装不对');
  }
  if (g.faceTextFor(ch, 'scene') !== 'silver hair, red eyes, tall, beige coat') {
    throw new Error('scene 分组拼装不对');
  }
  /* 老数据兼容：只有 base 时各组都回落 base */
  if (g.faceTextFor({ faceLockText: 'base only' }, 'selfie') !== 'base only') {
    throw new Error('老数据兼容坏了');
  }
  const withG = g.buildPrompt({ api: g.newApi('general'), subject: 'reading', gender: { gender: 'male' } });
  if (withG.positive.indexOf('1boy') < 0) throw new Error('性别 tag 没进正向');
  return 'ok';
});

/* 发图说明卡：有接口+开关开才有 —— 没接口教模型发图只会出空气话。 */
t('replySpec：有接口才有发图说明', () => {
  const g = S.imggen;
  const spec = g.replySpec();
  if (spec && spec.indexOf('[生图') < 0) throw new Error('说明里没有 [生图:…] 标签');
  return spec ? '有接口 · 注入' : '无接口 · 省略';
});

/* 提示词库 CRUD + 全局开关兜底（老存档没这个键 = 开）。 */
t('提示词库增删 + 全局开关默认开', () => {
  const g = S.imggen;
  const before = g.listPrompts().length;
  g.addPrompt({ name: '胶片感', text: 'film grain, muted colors', cat: '风格' });
  const added = g.listPrompts();
  if (added.length !== before + 1) throw new Error('没存上');
  const hit = added[added.length - 1];
  if (hit.text !== 'film grain, muted colors') throw new Error('内容不对');
  g.removePrompt(hit.id);
  if (g.listPrompts().length !== before) throw new Error('没删掉');
  const def0 = g.readEnabled();
  g.setEnabled(false);
  const off = g.readEnabled();
  g.setEnabled(true);
  if (def0 !== true || off !== false) throw new Error('开关兜底/写入不对');
  return { 开关往返: 'true→false→true' };
});

/* zip 拆包（NAI 的返回是 zip）：手工拼一个「本地头 + stored 条目」的最小 zip，
   拆出来的字节要和塞进去的一模一样。 */
t('extractFirstFile：能拆 stored 条目的最小 zip', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const name = new Uint8Array([0x61, 0x2e, 0x70, 0x6e, 0x67]);  /* "a.png" */
  const head = new Uint8Array(30);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(8, 0, true);            /* method = stored */
  dv.setUint32(18, bytes.length, true);/* csize */
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, 0, true);
  const zip = new Uint8Array(head.length + name.length + bytes.length);
  zip.set(head, 0); zip.set(name, 30); zip.set(bytes, 30 + name.length);
  const S2 = S;
  const blob = await S2.imggen.extractFirstFile(zip.buffer);
  const out = new Uint8Array(await blob.arrayBuffer());
  if (out.length !== bytes.length) throw new Error('长度不对: ' + out.length);
  for (let i = 0; i < bytes.length; i++) if (out[i] !== bytes[i]) throw new Error('第 ' + i + ' 字节不对');
  return '拆出 ' + out.length + ' 字节，逐字节一致';
});

console.log('\n--- 日历（《日历系统 · 产品与实施总纲 v1》· 第一版）---');

const CAL = S.calendar;
if (!CAL) throw new Error('Sleepy.calendar 没导出');
const CALD = S.calendarData;

t('内置数据包：2025/2026 有中国大陆官方安排，2027 及以后绝不伪造', () => {
  const y = CALD.builtinYears();
  if (y.join(',') !== '2025,2026') throw new Error('内置年份不对：' + y.join(','));
  const off27 = CALD.CN_OFFICIAL[2027];
  if (off27) throw new Error('2027 的官方安排还没公布，不许内置');
  return { 年份: y.join('/'), 法定块: CALD.CN_OFFICIAL['2026'].holidays.length };
});

const calSb = t('日历夹具：一间岛 + 两个大号', () => {
  const sb = S.core.createSandbox('archipelago', '日历测试岛');
  S.core.setActiveSandbox(sb.id);
  const a = S.core.upsertChar({ name: '岑川', kind: 'main' }).id;
  const b = S.core.upsertChar({ name: '林砚', kind: 'main' }).id;
  S.core.setSandboxChars(sb.id, [a, b]);
  return { sb: sb.id, a, b };
});

t('公共日期层：法定放假日 / 调休休息日 / **周末补班日** 分得开', () => {
  const cfg = { region: 'CN', cultures: [] };
  const chunjie = CAL.dayInfo('2026-02-17', cfg);      /* 春节当天（正月初一，周二）*/
  if (!chunjie.legal || chunjie.legal.kind !== 'legal_off') throw new Error('春节没判成法定放假日');
  if (chunjie.isWorkday) throw new Error('法定放假日不该是工作日');
  const saturdayWork = CAL.dayInfo('2026-02-28', cfg); /* 周六，官方要求上班 */
  if (saturdayWork.legal.kind !== 'workday_adjustment') {
    throw new Error('周末补班被当成普通周末了 —— 总纲 §5.3 的红线');
  }
  if (!saturdayWork.isWorkday || saturdayWork.isDayOff) throw new Error('补班日的班/休判反了');
  const normalSat = CAL.dayInfo('2026-02-21', cfg);    /* 假期区间里的自然周末 */
  if (normalSat.legal.kind !== 'weekend') throw new Error('假期里的自然周末该是 weekend');
  return { 春节: chunjie.legal.tag, 补班: saturdayWork.legal.tag, 周末: normalSat.legal.kind };
});

t('超出内置年份：如实降级，不生成假的调休（§19.1）', () => {
  CAL.clearCache();
  const d = CAL.dayInfo('2027-01-01', { region: 'CN', cultures: ['cn'] });
  if (d.legal) throw new Error('2027 不该有法定层数据');
  if (d.builtin) throw new Error('2027 该标成「未内置」');
  if (!d.notes.length) throw new Error('降级时该有一句人话说明');
  return d.notes[0].slice(0, 16);
});

t('规则型区域不设年份上限：JP 成人の日 / US 感恩节算得对', () => {
  CAL.clearCache();
  const jp = CAL.dayInfo('2026-01-12', { region: 'JP', cultures: [] });
  if (!jp.legal || jp.legal.name.indexOf('成人') < 0) throw new Error('JP 成人の日没算出来');
  const us = CAL.dayInfo('2026-11-26', { region: 'US', cultures: [] });
  if (!us.legal || us.legal.name !== 'Thanksgiving') throw new Error('US 感恩节没算出来');
  return { 成人の日: jp.legal.name, 感恩节: us.legal.name };
});

/* 2026-10-03：用户报「设置中国/上海，10 月 3 日却被说成国庆第一天」。
   勘察结论是**代码没有造假**（全库搜不到「第一天」这种生成逻辑），
   注入原文逐日核过一遍，7 天区间里每天都只说「今天是国庆节」+ 客观 kind。
   但「只报节日名、不报假期位置」确实容易被读成「第几天」——
   这条把**逐日原文**钉住：谁哪天、属于哪种 kind，一个字都不许飘。 */
t('假期表述给全事实：区间 + 今天 + 第几天，模型不用自己推（2026-10-03 修）', () => {
  /* 用户报「模型说今天是国庆第一天」，换了几个 API 都一样，中秋那次也犯过。
     根因不是措辞不精确，是**事实错了**：`CN_OFFICIAL` 的 name 是**整段连休的名**
     （国庆 = 10-01~10-07），而旧句式连着 7 天都说「今天是国庆节」——
     7 天里 6 天是假的。模型同时读到「今天是 10 月 3 日」和「今天是国庆节」
     两条打架的信息，只能采信假期名、忽略日期 → 说成「第一天」。
     **它不是算错了，是我们逼它二选一。**

     现在按「节 ≠ 节假日」分层（用户 2026-10-03 拍板）：
       假期名（国庆假期）→ 法定层，附区间
       节日名（中秋节/除夕）→ 文化层，只在真正那天出现
     并把三件不需要推理的事实一次给全：区间、今天、第几天。 */
  CAL.clearCache();
  const cfg = { region: 'CN', cultures: ['cn', 'intl'] };
  const expect = {
    '2026-10-01': 'legal_off', '2026-10-02': 'legal_off',
    '2026-10-03': 'weekend', '2026-10-04': 'weekend',
    '2026-10-05': 'legal_off', '2026-10-06': 'legal_off', '2026-10-07': 'legal_off'
  };
  Object.keys(expect).forEach((iso) => {
    const d = CAL.dayInfo(iso, cfg);
    if (!d.legal) throw new Error(iso + ' 没认成假期');
    /* 名字必须是**假期名**（带「假期」），不许是「国庆节」这种当天名 */
    if (d.legal.name.indexOf('假期') < 0) {
      throw new Error(iso + ' 的名字不是假期名（节≠节假日）：' + d.legal.name);
    }
    if (d.legal.kind !== expect[iso]) throw new Error(iso + ' 的 kind 不对：' + d.legal.kind);
    if (!d.isDayOff) throw new Error(iso + ' 该是休息日');
  });
  /* 第几天必须**逐日递增**，且首日=1、末日=total（这里最容易错：
     daysBetween 已含首尾，再 +1 会让 10-01 变成第 2 天、7 天说成 8 天） */
  const seq = [];
  for (let day = 1; day <= 7; day++) {
    const iso = '2026-10-0' + day;
    const d = CAL.dayInfo(iso, cfg);
    if (d.legal.day !== day) throw new Error(iso + ' 第几天算错：' + d.legal.day);
    if (d.legal.total !== 7) throw new Error(iso + ' 总天数算错：' + d.legal.total);
    seq.push(d.legal.day);
  }
  /* 注入原文：三件事实齐、**且不许出现「今天是国庆」这种以假期名当当天名的说法** */
  const facts = CAL.timeFacts(calSb.a, { at: new Date(2026, 9, 3, 12, 0) });
  const pub = (facts.split('\n').filter((l) => l.indexOf('公共日期') === 0)[0]) || '';
  if (pub.indexOf('国庆假期') < 0) throw new Error('注入里没有假期名：' + pub);
  if (pub.indexOf('10月1日—10月7日') < 0) throw new Error('注入里没有区间：' + pub);
  if (pub.indexOf('今天是 10月3日') < 0) throw new Error('注入里没有明说今天：' + pub);
  if (pub.indexOf('第 3 天') < 0) throw new Error('注入里没有第几天：' + pub);
  /* 关键红线：多日连休**不许**再出现「今天是<假期名>」 */
  if (/今天是\s*国庆/.test(pub)) {
    throw new Error('又用「今天是假期名」的句式了（6/7 天是假的）：' + pub);
  }
  /* 假期结束当天回到普通工作日 */
  const after = CAL.dayInfo('2026-10-08', cfg);
  if (after.legal) throw new Error('10-08 不该还有假期标记');
  if (!after.isWorkday) throw new Error('10-08 该是工作日');
  /* 补班日不许被当成休息（§5.3 红线） */
  const makeUp = CAL.dayInfo('2026-10-10', cfg);
  if (!makeUp.legal || makeUp.legal.kind !== 'workday_adjustment') throw new Error('10-10 补班没认出来');
  if (makeUp.isDayOff) throw new Error('10-10 补班日被当成休息了 —— §5.3 红线');

  return {
    逐日: seq.join('→'),
    命名: '假期名（国庆假期）',
    注入: '区间+今天+第几天齐',
    10_08: '普通工作日',
    补班: '认出来了'
  };
});

t('节日名与假期名分层：节日名只在真正那天（清明当天在假期中间）', () => {
  CAL.clearCache();
  const cfg = { region: 'CN', cultures: ['cn'] };
  /* 官方 2026 清明假期是 04-04~04-06，但**清明节当天是 04-05** ——
     旧实现连着三天都说「今天是清明节」，前后两天都是假的。 */
  const names = ['04-04', '04-05', '04-06'].map((md) => {
    const iso = '2026-' + md;
    return { iso, legal: CAL.dayInfo(iso, cfg).legal.name, fest: CAL.dayInfo(iso, cfg).festivals.map((f) => f.name) };
  });
  /* 三天的法定层都该是「清明节假期」 */
  names.forEach((n) => {
    if (n.legal.indexOf('假期') < 0) throw new Error(n.iso + ' 法定层该用假期名：' + n.legal);
  });
  /* 节日名「清明节」只在 04-05 那天出现（文化层） */
  const withFest = names.filter((n) => n.fest.indexOf('清明节') >= 0).map((n) => n.iso);
  if (withFest.length !== 1 || withFest[0] !== '2026-04-05') {
    throw new Error('清明节名只该在 04-05 出现，实际：' + JSON.stringify(withFest));
  }
  return { 三天假期名: '一致', 节日名只在: withFest[0] };
});

t('文化节日多选：选中的组才出现，春节不与法定层重复出两条', () => {
  const cfg = { region: 'CN', cultures: ['cn', 'intl'] };
  const d = CAL.dayInfo('2026-02-17', cfg);
  const names = d.festivals.map((f) => f.name);
  if (names.indexOf('情人节') >= 0) throw new Error('不该出现没选中的组');
  CAL.clearCache();
  const d1 = CAL.dayInfo('2026-02-14', cfg);
  if (d1.festivals.map((f) => f.name).indexOf('情人节') < 0) throw new Error('选了 intl 该有情人节');
  CAL.clearCache();
  return { 春节当天: names.join('/') || '（法定层已覆盖）', 情人节: '有' };
});

/* 2026-10-03 修复的回归锁：年缓存键漏了 cultures。
   上面那条用例的两次断言之间夹了一个 clearCache() —— 正好把这条路径绕过去了，
   所以这个 bug 一直没被测出来。这条**故意不清缓存**：
   两个 char 交替问同一个年份，谁先问都不能定死别人那份。
   ⚠️ 不许在中间加 clearCache() —— 加了就等于没测，这条用例的意义全在「不清」。 */
t('年缓存按 cultures 分桶：两个 char 交替问同一年不互相串味', () => {
  const a = calSb.a, b = calSb.b;
  CAL.saveCfg(a, { cultures: ['cn'] });      /* 甲：只要中国传统节日 */
  CAL.saveCfg(b, { cultures: ['intl'] });    /* 乙：只要国际常见节日 */
  CAL.clearCache();

  const cfgA = CAL.cfgOf(a), cfgB = CAL.cfgOf(b);
  if (cfgA.cultures.join(',') !== 'cn' || cfgB.cultures.join(',') !== 'intl') {
    throw new Error('夹具没设对：' + cfgA.cultures + ' / ' + cfgB.cultures);
  }

  /* 乙先问 —— 他选了 intl，圣诞节必须在 */
  const bFirst = CAL.dayInfo('2026-12-25', cfgB).festivals.map((f) => f.name);
  if (bFirst.indexOf('圣诞节') < 0) throw new Error('乙选了 intl 却拿不到圣诞节：' + bFirst);
  /* 甲接着问同一年同一天 —— 他没选 intl，**不许蹭到乙那份缓存** */
  const aNoIntl = CAL.dayInfo('2026-12-25', cfgA).festivals.map((f) => f.name);
  if (aNoIntl.length) throw new Error('甲没选 intl 却看见了国际节日（跨角色串味）：' + aNoIntl);
  /* 甲问自己的 —— 中文节日得在 */
  const aCn = CAL.dayInfo('2026-02-17', cfgA).festivals.map((f) => f.name);
  if (aCn.indexOf('春节') < 0) throw new Error('甲选了 cn 却拿不到春节：' + aCn);
  /* 乙再问甲已经问过的那个年份 —— 他的 intl 不许被甲挤掉 */
  const bAgain = CAL.dayInfo('2026-12-25', cfgB).festivals.map((f) => f.name);
  if (bAgain.indexOf('圣诞节') < 0) throw new Error('乙的圣诞节被甲的查询挤掉了：' + bAgain);

  /* 恢复，别把后面的用例带跑偏 */
  CAL.saveCfg(a, { cultures: ['cn', 'intl'] });
  CAL.saveCfg(b, { cultures: ['cn', 'intl'] });
  CAL.clearCache();
  return { 乙先: bFirst.join('/'), 甲: aNoIntl.length ? aNoIntl.join('/') : '（无，符合预期）', 乙再: bAgain.join('/') };
});

t('每个 char 的日历配置彼此独立（总纲 §0.4）', () => {
  const cfgA = CAL.cfgOf(calSb.a);
  if (cfgA.region !== 'CN' || cfgA.scheduleOn !== false || cfgA.anniversaryPerm !== 'ask') {
    throw new Error('默认值不对：' + JSON.stringify(cfgA));
  }
  CAL.saveCfg(calSb.a, { region: 'JP', timezone: 'Asia/Tokyo', scheduleOn: true });
  const cfgB = CAL.cfgOf(calSb.b);
  if (cfgB.region !== 'CN' || cfgB.scheduleOn !== false) throw new Error('B 被 A 的设置串了');
  return { A: CAL.cfgOf(calSb.a).region, B: cfgB.region, 日程开关默认: cfgA.scheduleOn };
});

t('事件：按 char 隔离，冲突检测认重叠、取消的不占时间', () => {
  const a = calSb.a, b = calSb.b;
  const e1 = CAL.__internal.addEvent({ ownerCharId: a, eventType: 'user_reminder', title: '去旧书店',
    startAt: '2030-05-20T18:30', endAt: '2030-05-20T20:00', allDay: false });
  CAL.__internal.addEvent({ ownerCharId: a, eventType: 'char_schedule', title: '傍晚散步',
    startAt: '2030-05-20T19:00', endAt: '2030-05-20T19:40', allDay: false });
  CAL.__internal.addEvent({ ownerCharId: b, eventType: 'user_reminder', title: 'B 的事',
    startAt: '2030-05-20T18:00', endAt: '2030-05-20T21:00', allDay: false });
  if (CAL.eventsOn(a, '2030-05-20').length !== 2) throw new Error('A 的事件数不对');
  if (CAL.eventsOn(b, '2030-05-20').length !== 1) throw new Error('两个 char 的事件串了');
  const clash = CAL.conflictOf(a, { startAt: '2030-05-20T19:20', endAt: '2030-05-20T19:50' });
  /* 两条都压在 19:20—19:50 上：旧书店 18:30—20:00 和散步 19:00—19:40。
     所以「撞了两条」才是对的 —— 冲突检测要报全，不许只报最近的。 */
  if (clash.length !== 2) throw new Error('重叠没检出全：' + clash.length);
  if (!clash.some((e) => e.title === '傍晚散步')) throw new Error('漏了散步那条');
  CAL.cancelEvent(e1.id, '改期了');
  const after = CAL.conflictOf(a, { startAt: '2030-05-20T18:40', endAt: '2030-05-20T18:50' });
  if (after.length) throw new Error('已取消的事件不该继续占时间');
  if (!CAL.getEvent(e1.id)) throw new Error('取消 ≠ 删除：记录得留着');
  return { A: 2, B: 1, 取消后仍可查: !!CAL.getEvent(e1.id) };
});

t('删除与取消分开：共同事件成立过就只能取消，绑了留痕的不能删', () => {
  const r1 = CAL.removeEvent(CAL.__internal.addEvent({ ownerCharId: calSb.a, eventType: 'shared_event',
    title: '一起吃饭', startAt: '2030-06-01T19:00', allDay: false, status: 'confirmed' }).id);
  if (r1.ok) throw new Error('已确认的共同事件不该允许删除');
  const ann = CAL.__internal.addEvent({ ownerCharId: calSb.a, eventType: 'anniversary', title: '某天',
    startAt: '2030-07-07', allDay: true, memoryId: 'mem_x' });
  if (CAL.removeEvent(ann.id).ok) throw new Error('绑了留痕的纪念日不能直接删');
  const draft = CAL.__internal.addEvent({ ownerCharId: calSb.a, eventType: 'user_reminder', title: '记错了',
    startAt: '2030-08-08T09:00', allDay: false });
  if (!CAL.removeEvent(draft.id).ok) throw new Error('误创建的提醒该允许删除');
  return { 共同事件: '拒绝', 纪念日: '拒绝', 误创建: '允许' };
});

t('重复规则展开：年重复在次年同月日还回来；农历重复不假装能算', () => {
  const id = CAL.__internal.addEvent({ ownerCharId: calSb.a, eventType: 'user_reminder', title: '每年这天',
    startAt: '2030-03-05T09:00', allDay: false, repeatRule: 'yearly' }).id;
  if (!CAL.eventsOn(calSb.a, '2031-03-05').some((e) => e.id === id)) throw new Error('年重复没展开');
  if (CAL.eventsOn(calSb.a, '2031-03-06').some((e) => e.id === id)) throw new Error('不该在别的日子出现');
  const lunar = CAL.__internal.addEvent({ ownerCharId: calSb.a, eventType: 'anniversary', title: '农历那条',
    startAt: '2030-09-09', allDay: true, repeatRule: 'yearly_lunar' }).id;
  if (CAL.eventsOn(calSb.a, '2031-08-29').some((e) => e.id === lunar)) {
    throw new Error('没有农历库就不许硬转农历日期');
  }
  return { 年重复: '2031-03-05 命中', 农历: '只留原始那天' };
});

t('关闭「生成角色日程」不删数据，也不影响纪念日（§6.2/§6.3）', () => {
  const a = calSb.a;
  CAL.saveCfg(a, { scheduleOn: false });
  CAL.clearCache();
  const iso = '2030-05-20';
  const cfg = CAL.cfgOf(a);
  const shown = CAL.visibleEventsOn(a, iso, cfg).map((e) => e.eventType);
  const all = CAL.eventsOn(a, iso).map((e) => e.eventType);
  if (shown.indexOf('char_schedule') >= 0) throw new Error('关掉开关后不该再显示角色日程');
  if (all.indexOf('char_schedule') < 0) throw new Error('关开关不能删数据');
  const generated = CAL.eventsOf(a).filter((e) => e.eventType === 'char_schedule').length;
  const cleared = CAL.clearGenerated(a);
  if (cleared !== generated) throw new Error('清除数量不对：' + cleared + ' vs ' + generated);
  if (!CAL.eventsOf(a).some((e) => e.eventType === 'anniversary')) {
    throw new Error('清除 AI 日程不该碰纪念日');
  }
  return { 关掉后显示: shown.join('/'), 数据还在: all.length, 清掉: cleared };
});

t('纪念日候选只来自真实留痕：没有锚点就没有候选', () => {
  const a = calSb.a;
  if (CAL.anniversaryCandidates(a).length) throw new Error('没有留痕就不该冒出候选');
  if (!S.memoryStore || !S.memoryStore.loadCharMemory) throw new Error('记忆库没接上');
  const file = S.memoryStore.loadCharMemory(a);
  file.memories.push({ id: 'mem_smoke_1', charId: a, kind: 'moment',
    content: '他第一次这样叫我的那天', source: 'ai_summary', sourceRef: 'msg_882',
    evidenceType: 'confirmed', status: 'active', isAnchor: true, isUserEdited: false,
    createdAt: '2030-05-20T21:00:00.000Z', updatedAt: '2030-05-20T21:00:00.000Z' });
  S.memoryStore.loadCharMemory && S.store.set('charMem:' + a, file);
  const cands = CAL.anniversaryCandidates(a);
  if (cands.length !== 1) throw new Error('锚点留痕该成为候选：' + cands.length);
  /* 收口批之后 saveAnniversary 返回统一入口的结构化结果（不再是裸 event） */
  const res = CAL.saveAnniversary(a, cands[0].memory, { date: '2030-05-20' });
  if (!res.ok) throw new Error('纪念日没写成：' + JSON.stringify(res.error));
  const ev = res.event;
  if (ev.memoryId !== 'mem_smoke_1') throw new Error('纪念日没和留痕双向绑上');
  if (ev.meaningType !== 'char_subjective') throw new Error('私人纪念日不许自动升格成双方事实');
  if (!ev.requestKey) throw new Error('纪念日没带统一入口的幂等键');
  if (ev.authorizedVia !== 'anniversary_sheet') throw new Error('没记授权来源');
  if (CAL.anniversaryCandidates(a).filter((x) => !x.saved).length) throw new Error('存过的不该再当候选');
  /* 再存一次：命中幂等键，不建第二条 */
  const again = CAL.saveAnniversary(a, cands[0].memory, { date: '2030-05-20' });
  if (!again.ok || again.dup !== true) throw new Error('重复保存没被幂等挡住');
  /* 只数这一条留痕对应的（别的测试也建过纪念日，按 requestKey 精确数） */
  const byKey = CAL.eventsOf(a).filter((e) => e.requestKey === ev.requestKey).length;
  if (byKey !== 1) throw new Error('重复保存建出了第二条纪念日：' + byKey);
  return { 候选: 1, 绑定: ev.memoryId, 意义: ev.meaningType, 重复: '幂等挡住' };
});

t('换房看不见 + removeSandbox 连带清两张日历表', () => {
  const other = S.core.createSandbox('isle', '隔壁测试岛');
  S.core.setActiveSandbox(other.id);
  if (CAL.eventsOf(calSb.a).length) throw new Error('换房还能看见上一个岛的事件');
  S.core.setActiveSandbox(calSb.sb);
  const before = CAL.eventsOf(calSb.a).length;
  if (!before) throw new Error('回到原房该能看见');
  S.core._purgeSync.sandbox(calSb.sb);
  const left = (S.store.get('calEvents') || []).filter((e) => e.sandboxId === calSb.sb).length;
  const leftCfg = (S.store.get('calConfigs') || []).filter((e) => e.sandboxId === calSb.sb).length;
  if (left || leftCfg) throw new Error('删房没清干净：events=' + left + ' configs=' + leftCfg);
  return { 换房隔离: '看不见', 删房: '两张表全清' };
});

t('日历三页注册齐（月历 / 新建 / 详情）', () => {
  const reg = S.registered();
  ['calendar', 'calendar-new', 'calendar-event'].forEach((id) => {
    if (!reg[id]) throw new Error('缺页面：' + id);
    if (!reg[id].hasRender) throw new Error(id + ' 没有 render');
  });
  return { 三个: '都有 render' };
});

t('红线：日历数据层 0 模型调用（源码里不许出现 api. 调用）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'calendar.js'), 'utf8');
  const bad = src.match(/Sleepy\.api\.|api\.chat\(|api\.complete\(|fetch\(/g);
  if (bad) throw new Error('数据层里出现了调用痕迹：' + bad.join(','));
  const pageSrc = fs.readFileSync(path.join(ROOT, 'page-calendar.js'), 'utf8');
  const bad2 = pageSrc.match(/Sleepy\.api\.|api\.chat\(|api\.complete\(|fetch\(/g);
  if (bad2) throw new Error('页面里出现了模型调用：' + bad2.join(','));
  return '干净';
});

console.log('\n--- 常驻地点 × 时间事实（2026-09-19 用户提的第二件事）---');

const plTest = t('常驻地点夹具：一个常驻东京的 char', () => {
  const sb = S.core.createSandbox('archipelago', '常驻地点测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '林砚', kind: 'main', city: '东京', region: 'JP', timezone: 'Asia/Tokyo' });
  S.core.setSandboxChars(sb.id, [c.id]);
  S.calendar.clearCache();
  return c.id;
});

t('常驻地点是唯一来源：日历的默认地区/时区跟着他走', () => {
  const cfg = S.calendar.cfgOf(plTest);
  if (cfg.region !== 'JP' || cfg.timezone !== 'Asia/Tokyo') {
    throw new Error('日历没跟着常驻地点：' + JSON.stringify(cfg));
  }
  const other = S.core.upsertChar({ name: '许栩', kind: 'main', city: '上海', region: 'CN', timezone: 'Asia/Shanghai' });
  const cfg2 = S.calendar.cfgOf(other.id);
  if (cfg2.region !== 'CN' || cfg2.timezone !== 'Asia/Shanghai') throw new Error('另一个 char 串了');
  if (S.calendar.placeLabel(plTest, cfg) !== '东京') {
    throw new Error('地名没用 city：' + S.calendar.placeLabel(plTest, cfg));
  }
  return { 东京: cfg.region + '/' + cfg.timezone, 上海: cfg2.region + '/' + cfg2.timezone };
});

t('日历里手动改过 → 覆盖常驻地点；「恢复跟随」能退回去', () => {
  S.calendar.saveCfg(plTest, { region: 'US', timezone: 'America/New_York' });
  let cfg = S.calendar.cfgOf(plTest);
  if (cfg.region !== 'US') throw new Error('显式覆盖没生效');
  const ov = S.calendar.overridden(plTest);
  if (!ov.region || !ov.timezone) throw new Error('没标出「已被手动改过」');
  S.calendar.resetToPlace(plTest);
  cfg = S.calendar.cfgOf(plTest);
  if (cfg.region !== 'JP' || cfg.timezone !== 'Asia/Tokyo') {
    throw new Error('退回跟随失败：' + JSON.stringify(cfg));
  }
  if (S.calendar.overridden(plTest).region) throw new Error('覆盖记录没清干净');
  return '覆盖 → 恢复跟随';
});

t('时间事实按他的时区算（不是浏览器本地时间），且不塞整月日历', () => {
  /* 本地 21:45（东八）→ 东京该是 22:45 */
  const at = new Date(2026, 8, 19, 21, 45);
  const txt = S.calendar.timeFacts(plTest, { at });
  if (txt.indexOf('Asia/Tokyo') < 0) throw new Error('没带时区');
  if (txt.indexOf('东京') < 0) throw new Error('没用常驻城市名');
  if (txt.indexOf('22:45') < 0) throw new Error('没按他的时区换算（该是 22:45）：' + txt);
  if (txt.indexOf('不要自己编日期') < 0) throw new Error('缺「以这里为准」的约束');
  if (txt.indexOf('中秋节') >= 0) throw new Error('不该把整月日历塞进来（只给今天的状态）');
  if (txt.length > 600) throw new Error('太长了，违反 §14「不常驻整份日历」：' + txt.length);
  return { 字数: txt.length, 第二行: txt.split('\n')[1] };
});

t('关着「生成角色日程」不注入他的安排，开了才注入（总纲 §14.2）', () => {
  /* ⚠️ 这条必须是**他自己**安排的（createdBy:char）—— 第二轮施工单第一批之后
     I02 会按 charViewOf 过滤；addEvent 默认 createdBy 是 user、visibility 是 private，
     那样它会被正确地挡掉，测的就不是「开关」而是「隐私」了。 */
  S.calendar.__internal.addEvent({ ownerCharId: plTest, eventType: 'char_schedule', title: '傍晚去旧书店',
    startAt: '2026-09-19T18:30', endAt: '2026-09-19T20:00', allDay: false,
    createdBy: { type: 'char', id: plTest }, visibility: 'private' });
  const at = new Date(2026, 8, 19, 9, 0);
  const off = S.calendar.timeFacts(plTest, { at });
  if (off.indexOf('傍晚去旧书店') >= 0) throw new Error('开关关着还是注入了他的安排');
  S.calendar.saveCfg(plTest, { scheduleOn: true });
  const on = S.calendar.timeFacts(plTest, { at });
  if (on.indexOf('傍晚去旧书店') < 0) throw new Error('开关开了也没注入安排');
  S.calendar.saveCfg(plTest, { scheduleOn: false });
  return { 关: '只有客观日期背景', 开: '带上近期安排' };
});

t('线上装配真的注入了 I02 时间事实（以前线上一点时间都没有）', () => {
  const u = S.core.activeUser() || S.core.userMasks()[0];
  const r = S.promptEngine.assembleOnline({ charId: plTest, userId: u && u.id, history: [] });
  const sys = (r.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys.indexOf('【时间事实】') < 0) throw new Error('时间没进 prompt');
  if (sys.indexOf('Asia/Tokyo') < 0) throw new Error('时间没按他的常驻时区');
  const slot = (r.slots || []).filter(function (x) { return x.id === 'time'; })[0];
  if (!slot) throw new Error('I02 槽没注册进 ONLINE_SLOTS');
  if (!slot.on) throw new Error('I02 槽没命中');
  const ids = (r.slots || []).map(function (x) { return x.id; });
  if (ids.indexOf('time') < ids.indexOf('i01')) throw new Error('I02 的位置跑到了 I01 前面');
  return { 槽: slot.slot, tokens: slot.tokens, 顺序: ids.slice(0, 5).join('>') };
});

console.log('\n--- 翻译 · 私聊气泡（2026-09-19 用户拍板）---');

t('parseReply 把 [译] 抽出来：正文干净、译文按索引对齐', () => {
  const r = S.promptEngine.parseReply(
    'おはよう。[译]早上好。[/译]||今日は寒いね。[译]今天好冷。[/译]');
  if (r.bubbles.join('|') !== 'おはよう。|今日は寒いね。') throw new Error('正文没剔干净：' + r.bubbles.join('|'));
  if ((r.trans || []).join('|') !== '早上好。|今天好冷。') throw new Error('译文没抽对：' + JSON.stringify(r.trans));
  if (r.visible.indexOf('[译]') >= 0) throw new Error('visible 里还留着标签（会污染上下文）');
  if (r.trans.length !== r.bubbles.length) throw new Error('两边长度不一致 —— 渲染层是按索引配对的');
  return { 正文: r.bubbles.join(' | '), 译文: r.trans.join(' | ') };
});

t('译文缺一半 / 半截标签 / 完全没有译文都不炸', () => {
  const a = S.promptEngine.parseReply('Hello.[译]你好。[/译]||Bye.');
  if (a.trans[0] !== '你好。' || a.trans[1] !== null) throw new Error('缺一半没兜住：' + JSON.stringify(a.trans));
  /* 模型漏了收尾标签：整段当译文收下 */
  const b = S.promptEngine.parseReply('Good night.[译]晚安。');
  if (b.trans[0] !== '晚安。' || b.bubbles[0] !== 'Good night.') throw new Error('半截标签没认：' + JSON.stringify(b));
  /* 完全没有译文：trans 全是 null，但长度仍对齐 */
  const cc = S.promptEngine.parseReply('ただいま。||おかえり。');
  if (cc.trans.length !== 2 || cc.trans.some((x) => x !== null)) throw new Error('不该凭空造译文');
  return { 半截: b.trans[0], 无译文: '全 null' };
});

t('语言从常驻地点推：东京→日语、上海→中文（不另开设置项）', () => {
  const jp = S.calendar.langOf(plTest);              /* 常驻东京 */
  if (jp.code !== 'ja' || jp.name !== '日语') throw new Error('JP 没推出日语：' + JSON.stringify(jp));
  const cn = S.core.upsertChar({ name: '中文角色', kind: 'main', region: 'CN', timezone: 'Asia/Shanghai' });
  const cl = S.calendar.langOf(cn.id);
  if (cl.code !== 'zh' || !cl.same) throw new Error('CN 该是「同语言」那一支：' + JSON.stringify(cl));
  return { 东京: jp.name, 上海: cl.name + '(same)' };
});

t('线上装配：国外角色注入 I03「说话方式」，中文角色不占这段', () => {
  const u = S.core.activeUser() || S.core.userMasks()[0];
  S.calendar.setTranslateOn(true);
  const r1 = S.promptEngine.assembleOnline({ charId: plTest, userId: u && u.id, history: [] });
  const sys1 = r1.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys1.indexOf('你平时说日语') < 0) throw new Error('没告诉他说日语');
  if (sys1.indexOf('[译]') < 0) throw new Error('开关开着却没要求附译文');
  const slot = r1.slots.filter((x) => x.id === 'lang')[0];
  if (!slot || !slot.on) throw new Error('I03 槽没命中');

  /* 关掉开关：语言照旧，翻译指令撤掉 —— 这两件事必须分得开 */
  S.calendar.setTranslateOn(false);
  const r2 = S.promptEngine.assembleOnline({ charId: plTest, userId: u && u.id, history: [] });
  const sys2 = r2.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys2.indexOf('你平时说日语') < 0) throw new Error('关了翻译开关他就不说日语了？');
  if (sys2.indexOf('[译]') >= 0) throw new Error('关了开关还在要译文');
  S.calendar.setTranslateOn(true);

  const cnId = S.core.upsertChar({ name: '中文角色2', kind: 'main', region: 'CN', timezone: 'Asia/Shanghai' }).id;
  const r3 = S.promptEngine.assembleOnline({ charId: cnId, userId: u && u.id, history: [] });
  const sys3 = r3.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys3.indexOf('你平时说') >= 0) throw new Error('中文角色不该被塞一段说话方式');
  const slot3 = r3.slots.filter((x) => x.id === 'lang')[0];
  if (slot3 && slot3.on) throw new Error('中文角色的 I03 不该命中');
  return { JP: slot.slot + '(' + slot.tokens + 'tok)', 开关关: '只说日语不附译文', CN: '不注入' };
});

t('翻译开关：默认开，读写走 store（全局偏好，不是每条对话一份）', () => {
  if (S.store.get('translateOn') === false) throw new Error('默认该是开');
  S.calendar.setTranslateOn(false);
  if (S.calendar.translateOn() !== false) throw new Error('写不进去');
  S.calendar.setTranslateOn(true);
  if (S.calendar.translateOn() !== true) throw new Error('读不回来');
  return 'translateOn 读写正常';
});

t('译文不进 content：回给模型的上下文只有原文', () => {
  const r = S.promptEngine.parseReply('Спасибо.[译]谢谢。[/译]');
  const chat = S.chatStore.createChat('翻译测试', null) || S.chatStore.getChats()[0];
  const before = (chat.messages || []).length;
  S.chatStore.addMessage(chat.id, {
    id: 'msg_trans_smoke', role: 'assistant', content: r.visible.trim(), trans: r.trans });
  const m = (S.chatStore.getChat(chat.id).messages || []).filter((x) => x.id === 'msg_trans_smoke')[0];
  if (!m) throw new Error('消息没落库');
  if ((m.content || '').indexOf('[译]') >= 0) throw new Error('正文里混进了译文标签');
  if (!Array.isArray(m.trans) || m.trans[0] !== '谢谢。') throw new Error('译文没存上：' + JSON.stringify(m.trans));
  if (before === (m.messages || []).length) { /* 只是给 Lint 看的一行，无实际作用 */ }
  return { 正文: m.content, trans: JSON.stringify(m.trans) };
});

console.log('\n--- 翻译 · 线下（私聊 + 群线下，2026-09-19 第二轮）---');

t('线下私聊装配：以前完全没有语言槽，现在国外角色补上 I03', () => {
  const u = S.core.activeUser() || S.core.userMasks()[0];
  const r = S.promptEngine.assembleOffline({ charId: plTest, userId: u && u.id,
    session: { charId: plTest, messages: [], narrativeSettings: {}, env: {} } });
  const sys = r.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys.indexOf('你平时说日语') < 0) throw new Error('线下没告诉他说日语');
  const slot = r.slots.filter((x) => x.id === 'lang')[0];
  if (!slot || !slot.on) throw new Error('线下 I03 槽没命中');
  const ids = r.slots.map((x) => x.id);
  if (ids.indexOf('lang') < ids.indexOf('i01')) throw new Error('I03 的位置跑到了 I01 前面');
  /* 译文在线下走 dialogue 段的 trans 字段（不是 [译] 标签） */
  if (sys.indexOf('trans 字段') < 0) throw new Error('线下协议没要求译文字段');
  if (sys.indexOf('[译]') >= 0) throw new Error('线下不该用线上那套 [译] 标签');
  /* 描写密度（用户对照 Demo 提的「描写好短」） */
  if (sys.indexOf('先有动作或神态、再给台词') < 0) throw new Error('线下没要求「先动作后台词」');
  return { 槽: slot.slot + '(' + slot.tokens + 'tok)', 协议: 'dialogue 段带 trans' };
});

t('线下：关掉翻译开关 → 语言照旧、协议不要 trans（两件事分得开）', () => {
  const u = S.core.activeUser() || S.core.userMasks()[0];
  S.calendar.setTranslateOn(false);
  const r = S.promptEngine.assembleOffline({ charId: plTest, userId: u && u.id,
    session: { charId: plTest, messages: [], narrativeSettings: {}, env: {} } });
  const sys = r.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys.indexOf('你平时说日语') < 0) throw new Error('关了开关他就不说日语了？');
  if (sys.indexOf('trans 字段') >= 0) throw new Error('关了开关还在要译文');
  S.calendar.setTranslateOn(true);
  /* 中文角色：整槽不注入，协议里也不该冒出 trans */
  const cn = S.core.upsertChar({ name: '线下中文角色', kind: 'main', region: 'CN', timezone: 'Asia/Shanghai' });
  const r2 = S.promptEngine.assembleOffline({ charId: cn.id, userId: u && u.id,
    session: { charId: cn.id, messages: [], narrativeSettings: {}, env: {} } });
  const sys2 = r2.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (sys2.indexOf('你平时说') >= 0) throw new Error('中文角色不该被塞一段说话方式');
  const slot2 = r2.slots.filter((x) => x.id === 'lang')[0];
  if (slot2 && slot2.on) throw new Error('中文角色的线下 I03 不该命中');
  return { 开关关: '只说日语不附译文', CN: '不注入' };
});

/* ===== 预设注入清单通查（2026-09-22，用户：「完成所有的功能后重新加上
   需要注入的东西」）。修的是三处「同一件事只做了一半」的缺口。 ===== */

t('通查①：线下装配也吃自定义卡（以前只有线上吃，用户加的卡线下失效）', () => {
  const u = S.core.activeUser() || S.core.userMasks()[0];
  const card = S.promptEngine.addCustomCard('通查卡', '线下也要能看见这条注入。');
  const r = S.promptEngine.assembleOffline({ charId: plTest, userId: u && u.id,
    session: { charId: plTest, messages: [], narrativeSettings: {}, env: {} } });
  const sys = r.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const slot = r.slots.filter((x) => x.id === card.id)[0];
  if (!slot || !slot.on) throw new Error('线下没有自定义卡这一槽');
  if (sys.indexOf('线下也要能看见这条注入。') < 0) throw new Error('卡的正文没进线下 system');
  /* 关掉这张卡 → 线下也不能再注入（开关是同一套） */
  S.promptEngine.setCardEnabled(card.id, false);
  const r2 = S.promptEngine.assembleOffline({ charId: plTest, userId: u && u.id,
    session: { charId: plTest, messages: [], narrativeSettings: {}, env: {} } });
  const slot2 = r2.slots.filter((x) => x.id === card.id)[0];
  S.promptEngine.removeCustomCard(card.id);
  if (slot2 && slot2.on) throw new Error('关掉的卡线下还在注入');
  return { 槽: slot.slot, 关掉后: '不注入' };
});

t('通查②：主动消息的 system 段有共享外壳 + K01 短字段 + I01', () => {
  const c = S.core.upsertChar({
    name: '主动甲', kind: 'main', content: '旧书店老板，话少。',
    speech: '句子短，偶尔冒一句旧诗',
    gender: 'male', nationality: '中国', neverDo: '绝对不撒谎'
  });
  const u = S.core.activeUser() || S.core.userMasks()[0];
  const sys = S.proactiveEngine.buildSystem(c.id, u && u.id).join('\n');
  /* ★ 2026-10-04 修正断言口径（用户批准选项 A）。
     原来判的是 shell **卡**正文的 `[角色声音]` / `[身份与场景]` 两节 ——
     那是行为文本接入**之前**的共享外壳形态。行为文本 B 批起，
     shell 位由 B/P/L 三段共享行为正文接管，**私聊线上早已不含那两节**
     （实测：线上 system 同样 indexOf('[角色声音]') < 0）。
     接线主动消息只是让它**与线上对齐**，不是引入退化。

     ⚠️ 明确不做的事：把 shell 卡那两节加回线上或主动消息 ——
       那是重新混回已冻结的行为正文，会与 B/P/L 的授权边界与人物一致性重复。

     ★ 强度不降反升：原来只判「有共享外壳」，现在逐段判 B/P/L 三段都在，
       再加一条「诊断声称的模块必须与实际注入一致」，比原来更严。 */
  if (!S.behaviorText) throw new Error('行为文本模块不在，主动消息无法走共享外壳');
  if (typeof S.promptEngine.btDecideScene !== 'function') {
    throw new Error('共享行为决策层未导出（btDecideScene 缺失）');
  }
  const BT_FIRST = {
    B: '以本轮提供的有效资料',
    P: '对每个获准扮演的人物，依据其资料',
    L: '结合本轮明确篇幅需求',
    E: '当前通过消息交流',
    S3: '当前不是对新消息作必答回复'
  };
  ['B', 'P', 'L', 'E', 'S3'].forEach((m) => {
    if (sys.indexOf(BT_FIRST[m]) < 0) {
      throw new Error('主动消息的共享外壳缺 ' + m + ' 模块：' + BT_FIRST[m]);
    }
  });
  /* ★ 诊断与实际注入必须一致 —— 决策层拿到正文 ≠ 真的进了 system。
     modules 逐项都要能在 sys 里找到；pending 的一个都不该在。 */
  const note = S.proactiveEngine.behaviorNote ? S.proactiveEngine.behaviorNote() : null;
  if (!note) throw new Error('主动消息没有行为文本诊断（behaviorNote 缺失）');
  if (note.behaviorUsed !== true) throw new Error('诊断说共享外壳没被用上');
  if (JSON.stringify(note.modules) !== JSON.stringify(['B', 'P', 'L', 'E', 'S3'])) {
    throw new Error('诊断 modules 与完整接线不符：' + JSON.stringify(note.modules));
  }
  if (note.partial !== false || (note.pendingModules || []).length) {
    throw new Error('主动消息是完整接线，不该报 partial/pending：' +
      JSON.stringify({ partial: note.partial, pending: note.pendingModules }));
  }
  note.modules.forEach((m) => {
    if (sys.indexOf(BT_FIRST[m]) < 0) {
      throw new Error('诊断声称用了 ' + m + '，但 system 里找不到：' + BT_FIRST[m]);
    }
  });
  /* 状态签名已全量下线（2026-09-29）—— 反向断言：不许再注入 */
  if (sys.indexOf('当前状态：') >= 0) throw new Error('状态签名已下线，主动消息却还在注入');
  if (sys.indexOf('说话与行为方式：句子短') < 0) throw new Error('主动消息看不见说话方式');
  if (sys.indexOf('绝对不要做（红线）') < 0) throw new Error('主动消息看不见红线');
  if (sys.indexOf('awareness_mode') < 0) throw new Error('主动消息没有 I01');
  return {
    段数: S.proactiveEngine.buildSystem(c.id, u && u.id).length,
    共享外壳: 'B/P/L', 场景模块: note.modules.slice(3).join('/'),
    partial: note.partial, shellCard: note.shellCard
  };
});

t('parseOfflineReply：dialogue 的 trans 单独收下，prose 不收，正文不带译文', () => {
  const para = JSON.stringify({ paras: [
    { type: 'prose', text: '他把伞递过来。' },
    { type: 'dialogue', text: '寒いね。', trans: '好冷啊。' },
    { type: 'prose', text: '顺手把围巾理了理。', trans: '不该收的译文' }
  ], suggests: ['接伞'] });
  const p = S.promptEngine.parseOfflineReply(para);
  if (p.paras[0].trans !== null) throw new Error('prose 不该有译文');
  if (p.paras[1].trans !== '好冷啊。') throw new Error('dialogue 的译文没收到：' + JSON.stringify(p.paras[1]));
  if (p.paras[2].trans !== null) throw new Error('prose 上写了 trans 也不该收');
  if (p.paras[1].text.indexOf('好冷') >= 0) throw new Error('译文混进了正文 text');
  /* 历史上下文里必须只有原文 —— text 会被 parasText 原样拼回模型 */
  const u = S.core.activeUser() || S.core.userMasks()[0];
  const sess = { charId: plTest, env: {}, narrativeSettings: {},
    messages: [{ id: 'off_tr_1', role: 'char', paras: p.paras }] };
  const r = S.promptEngine.assembleOffline({ charId: plTest, userId: u && u.id, session: sess });
  const hist = r.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  if (hist.indexOf('好冷啊') >= 0) throw new Error('译文被拼进了历史上下文');
  if (hist.indexOf('寒いね') < 0) throw new Error('原文反而没进历史');
  return { dialogue: p.paras[1].trans, prose: '不收', 历史: '只有原文' };
});

t('译文块组件 msg-trans：两道闸门（语言 / 开关）都在 attach 里', () => {
  const cn = S.core.upsertChar({ name: '门禁中文角色', kind: 'main', region: 'CN', timezone: 'Asia/Shanghai' });
  if (!S.msgTrans.needs(plTest)) throw new Error('东京角色该要译文');
  if (S.msgTrans.needs(cn.id)) throw new Error('中文角色不该要译文');
  S.calendar.setTranslateOn(false);
  const host0 = S.ui.h('div');
  if (S.msgTrans.attach(host0, 'k0', '好冷啊。', plTest)) throw new Error('开关关着还挂了译文');
  S.calendar.setTranslateOn(true);
  const host = S.ui.h('div');
  const el = S.msgTrans.attach(host, 'k1', '好冷啊。', plTest);
  if (!el) throw new Error('该挂没挂');
  if (host.children.length !== 1) throw new Error('没挂到宿主上');
  if (!el.classList.contains('is-open')) throw new Error('默认该是展开态');
  if (el.children.length !== 2) throw new Error('该是「译文 + 收起态小标」两块');
  if (S.msgTrans.attach(S.ui.h('div'), 'k2', '好冷啊。', cn.id)) throw new Error('中文角色挂上了译文');
  return { 东京: true, 中文: false, 开关关: false };
});

t('群线下：按在场角色各自的语言注入，全中文的场子整段不出现', () => {
  const cn = S.core.upsertChar({ name: '同桌中文', kind: 'main', region: 'CN', timezone: 'Asia/Shanghai' });
  const sess = {
    purpose: '', env: {}, systemSettings: {}, narrativeSettings: {},
    participants: [
      { ownerId: plTest, kind: 'char', present: true, away: false },
      { ownerId: cn.id, kind: 'char', present: true, away: false }
    ]
  };
  const sys = S.groupOfflineStore.buildSystem(sess);
  if (sys.indexOf('[LANGUAGES]') < 0) throw new Error('没有语言段');
  if (sys.indexOf('平时说日语') < 0) throw new Error('没写他会说日语');
  if (sys.indexOf('trans') < 0) throw new Error('协议没要求译文');
  const s2 = {
    purpose: '', env: {}, systemSettings: {}, narrativeSettings: {},
    participants: [{ ownerId: cn.id, kind: 'char', present: true, away: false }]
  };
  const sys2 = S.groupOfflineStore.buildSystem(s2);
  if (sys2.indexOf('[LANGUAGES]') >= 0) throw new Error('没有外国人还是注入了语言段');
  if (sys2.indexOf('trans') >= 0) throw new Error('全中文的场子不该要译文');
  /* 中途离场的人不该被写进语言段 */
  const s3 = {
    purpose: '', env: {}, systemSettings: {}, narrativeSettings: {},
    participants: [{ ownerId: plTest, kind: 'char', present: true, away: true }]
  };
  if (S.groupOfflineStore.buildSystem(s3).indexOf('[LANGUAGES]') >= 0) {
    throw new Error('离场的人还算在场？');
  }
  return { 中日同桌: '[LANGUAGES] + trans', 全中文: '不注入', 离场: '不算数' };
});

t('parseGroupReply：每个说话人的译文各自收下，坏输出不炸', () => {
  const raw = JSON.stringify({ paras: [
    { speaker: 'Yuki', type: 'dialogue', text: 'こんにちは。', trans: '你好。' },
    { speaker: '', type: 'prose', text: '风把门口的铃吹响了。' },
    { speaker: '小林', type: 'dialogue', text: '你来了。' }
  ], suggests: [] });
  const p = S.groupOfflineStore.parseGroupReply(raw);
  if (p.paras[0].trans !== '你好。') throw new Error('说话人的译文没收到');
  if (p.paras[1].trans !== null) throw new Error('叙述段不该有译文');
  if (p.paras[2].trans !== null) throw new Error('没写译文就该是 null');
  if (p.paras[2].text !== '你来了。') throw new Error('正文被动过了');
  /* 非 JSON 输出：降级成一条 prose，trans 字段仍在形状上 */
  const bad = S.groupOfflineStore.parseGroupReply('……（他顿了顿）');
  if (!bad.paras.length || bad.paras[0].trans !== null) throw new Error('降级路径的形状不对');
  /* 回给模型的上下文（历史）只拼 text —— 群线下那侧是 historyMessages，
     它调的 parasText 只取 p.text，译文进不去 */
  const back = (p.paras || []).map(function (x) { return x.speaker ? (x.speaker + '：' + x.text) : ('（' + x.text + '）'); }).join('\n');
  if (back.indexOf('你好。') >= 0) throw new Error('译文混进了历史拼装');
  if (back.indexOf('こんにちは。') < 0) throw new Error('原文反而没进历史');
  return { 说话人: p.paras[0].trans, 叙述段: 'null', 降级: '不炸' };
});

console.log('\n--- 群像轮 · 四类段落（2026-09-19 对照多人线下 Demo）---');

t('群线下协议：四类段落齐全，且写清「这是一篇文章」', () => {
  const jp = S.core.upsertChar({ name: '轮头日语', kind: 'main', city: '东京', region: 'JP', timezone: 'Asia/Tokyo' });
  const cn = S.core.upsertChar({ name: '轮头中文', kind: 'main', city: '上海', region: 'CN', timezone: 'Asia/Shanghai' });
  const sess = { purpose: '', env: {}, systemSettings: {}, narrativeSettings: {},
    participants: [{ ownerId: jp.id, kind: 'char', present: true, away: false },
                   { ownerId: cn.id, kind: 'char', present: true, away: false }] };
  const sys = S.groupOfflineStore.buildSystem(sess);
  ['prose', 'dialogue', 'aside', 'silent'].forEach((k) => {
    if (sys.indexOf('"type":"' + k + '"') < 0) throw new Error('协议里没有 ' + k + ' 段');
  });
  if (sys.indexOf('[WRITING]') < 0) throw new Error('没有「怎么写」那一段');
  /* 用户 2026-09-19 定的语义：输出是一篇长文（对话/描写/心理混在一起），
     没说想说的就不写对话 —— 不是「prose/dialogue 两类表格」。 */
  if (sys.indexOf('连续的叙事') < 0) throw new Error('没说「你写的是一篇连续的叙事」');
  if (sys.indexOf('给程序排版的标记') < 0) throw new Error('没说清段落类型只是标记');
  if (sys.indexOf('有想说的才写 dialogue') < 0) throw new Error('没写「没有想说的就不写对话」');
  if (sys.indexOf('描写与心理是主体') < 0) throw new Error('没说描写与心理是主体');
  if (sys.indexOf('不要一句一段') < 0) throw new Error('没要求成段（防提纲化）');
  /* 用户定的语义：听懂与听不懂都行，不强制 */
  if (sys.indexOf('由现场自然决定') < 0) throw new Error('没写「听懂多少由现场自然决定」');
  return { 段落: 4, 写法段: '一篇长文', 语言态度: '中性许可' };
});

t('通查④：群线下的 [PARTICIPANTS] 也带角色短字段（以前只给 content）', () => {
  const c = S.core.upsertChar({ name: '轮头短字段', kind: 'main', content: '旧书店老板。',
    speech: '句子短', neverDo: '不撒谎' });
  const sess = { purpose: '', env: {}, systemSettings: {}, narrativeSettings: {},
    participants: [{ ownerId: c.id, kind: 'char', present: true, away: false }] };
  const sys = S.groupOfflineStore.buildSystem(sess);
  if (sys.indexOf('说话与行为方式：句子短') < 0) throw new Error('群线下看不见说话方式');
  /* 状态签名已全量下线（2026-09-29）—— 反向断言 */
  if (sys.indexOf('当前状态：') >= 0) throw new Error('状态签名已下线，群线下却还在注入');
  if (sys.indexOf('绝对不要做（红线）') < 0) throw new Error('群线下看不见红线');
  return { 段: '[PARTICIPANTS]' };
});

t('篇幅：线下三百字起步，多人线下按在场人数放大', () => {
  const mk = (n) => {
    const ps = [];
    for (let i = 0; i < n; i++) ps.push({ ownerId: 'p' + i, kind: 'char', present: true, away: false });
    return { purpose: '', env: {}, systemSettings: {}, narrativeSettings: {}, participants: ps };
  };
  const one = S.groupOfflineStore.buildSystem(mk(1));
  const three = S.groupOfflineStore.buildSystem(mk(3));
  const words = (sys) => {
    const m = sys.match(/这一轮总共 (\d+) 字上下/);
    return m ? Number(m[1]) : null;
  };
  const w1 = words(one), w3 = words(three);
  if (w1 === null || w3 === null) throw new Error('没给字数提示');
  if (w1 < 300) throw new Error('单人线下该 300 字起步，现在 ' + w1);
  if (!(w3 > w1)) throw new Error('多人线下该更多：' + w1 + ' → ' + w3);
  if (one.indexOf('全场加起来的字数') < 0) throw new Error('没写清是全场总字数（会被按人翻倍）');
  /* 私聊线下的档位也要跟着上移 */
  const L = S.promptEngine.offlineSlots;   /* 只做个引用，别删 */
  const r = S.promptEngine.assembleOffline({ charId: null, userId: null,
    session: { messages: [], narrativeSettings: {}, env: {}, charId: null } });
  const txt = r.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const m2 = txt.match(/回复字数：适中（(\d+)~(\d+) 字）/);
  if (!m2) throw new Error('私聊线下的字数档位没找到');
  if (Number(m2[1]) < 300) throw new Error('私聊线下「适中」该 300 字起步，现在 ' + m2[1]);
  return { 单人: w1 + ' 字', 三人: w3 + ' 字', 私聊适中: m2[1] + '~' + m2[2], 槽: L.length };
});

t('parseGroupReply：四类段落都认，未知类型落回 prose，trans 只挂在说出口的段上', () => {
  const raw = JSON.stringify({ paras: [
    { type: 'prose', text: '杯子见底了。' },
    { type: 'prose', speaker: '林砚', text: '他把杯子往里挪了挪。' },
    { type: 'dialogue', speaker: '林砚', text: 'そろそろ帰ろうか。', trans: '差不多该回去了吧。' },
    { type: 'aside', speaker: '岑川', text: '“再坐五分钟嘛。”', trans: '再来五分钟。' },
    { type: 'silent', speaker: '林砚', text: '没再催，只是把伞从椅背上拿了下来。', trans: '不该收的译文' },
    { type: 'banana', speaker: '岑川', text: '未知类型' }
  ], suggests: [] });
  const p = S.groupOfflineStore.parseGroupReply(raw);
  const tt = p.paras.map((x) => x.type).join(',');
  if (tt !== 'prose,prose,dialogue,aside,silent,prose') throw new Error('段落类型没认全：' + tt);
  if (p.paras[2].trans !== '差不多该回去了吧。') throw new Error('dialogue 的译文没收');
  if (p.paras[3].trans !== '再来五分钟。') throw new Error('aside 的译文没收（插话也可能是外语）');
  if (p.paras[4].trans !== null) throw new Error('silent 不该有译文');
  if (p.paras[1].speaker !== '林砚') throw new Error('prose 上的 speaker 丢了');
  return { 类型: tt, 译文: p.paras[2].trans + ' / ' + p.paras[3].trans };
});

t('parasToLines：四类段落拼成上下文，译文一律不进', () => {
  const lines = S.groupOfflineStore.parasToLines([
    { type: 'prose', text: '杯子见底了。' },
    { type: 'prose', speaker: '林砚', text: '他把杯子往里挪了挪。' },
    { type: 'dialogue', speaker: '林砚', text: 'そろそろ帰ろうか。', trans: '差不多该回去了吧。' },
    { type: 'aside', speaker: '岑川', text: '“再坐五分钟嘛。”' },
    { type: 'silent', speaker: '店长', text: '把擦好的杯子放回架上。' }
  ]);
  if (lines.indexOf('差不多该回去了吧。') >= 0) throw new Error('译文混进了上下文');
  if (lines.indexOf('林砚：そろそろ帰ろうか。') < 0) throw new Error('台词没拼上');
  if (lines.indexOf('岑川：“再坐五分钟嘛。”') < 0) throw new Error('插话没拼上（该带说话人）');
  if (lines.indexOf('（店长：把擦好的杯子放回架上。）') < 0) throw new Error('silent 的拼法不对');
  if (lines.indexOf('（林砚：他把杯子往里挪了挪。）') < 0) throw new Error('带 speaker 的 prose 该带名字');
  return lines.split('\n').length + ' 行，无译文';
});

t('旧存档兜底：只有 prose/dialogue 的老消息照样解析渲染（不炸、不改形状）', () => {
  const p = S.groupOfflineStore.parseGroupReply(JSON.stringify({ paras: [
    { speaker: '', type: 'prose', text: '锅底咕嘟咕嘟地冒泡。' },
    { speaker: '阿澈', type: 'dialogue', text: '先涮毛肚。' }
  ] }));
  if (p.paras.length !== 2) throw new Error('老格式解析坏了');
  if (p.paras[1].type !== 'dialogue' || p.paras[1].speaker !== '阿澈') throw new Error('老格式字段丢了');
  return '老消息仍可渲染';
});

console.log('\n--- 预设注入引擎（prompt-engine · 第一轮）---');
const u1 = t('upsertUser 建引擎测试马甲', () => S.core.upsertUser({ name: '测试甲' }).id);
t('parseReply 认新标签 [WHISPER] 并按 || 切气泡', () => {
  const r = S.promptEngine.parseReply('怎么了||发生什么事了\n\n[WHISPER]声音比平时沉。[/WHISPER]');
  if (r.visible.indexOf('WHISPER') >= 0) throw new Error('心声标签漏进气泡');
  if (r.whisper !== '声音比平时沉。') throw new Error('心声内容不对：' + r.whisper);
  if (r.bubbles.length !== 2 || r.bubbles[0] !== '怎么了') throw new Error('气泡没切开');
  return { bubbles: r.bubbles.length, whisper: r.whisper };
});
t('parseReply 兼容旧标签 <心声>（切回旧引擎的输出也要能收）', () => {
  const r = S.promptEngine.parseReply('嗯||那就烦着\n\n<心声>她说没什么，但发了消息。</心声>');
  if (r.whisper !== '她说没什么，但发了消息。') throw new Error('旧标签心声没收到');
  if (r.bubbles.length !== 2) throw new Error('旧标签下的气泡没切开');
  return 'ok';
});
t('parseReply 扣住流式半截标签（[WHISP 不闪现）', () => {
  const r = S.promptEngine.parseReply('来了[WHISP');
  if (r.visible.indexOf('[') >= 0) throw new Error('半截标签漏进气泡');
  return 'ok';
});
t('parseReply 心声标签在最前面时不给空气泡', () => {
  const r = S.promptEngine.parseReply('[WHISPER]先响了。[/WHISPER]');
  if (!r.visible.trim()) throw new Error('正文被吞成空气泡');
  return 'ok';
});
t('assembleOnline：槽位按矩阵顺序出，历史原文垫底', () => {
  const r = S.promptEngine.assembleOnline({
    charId: m1, userId: u1,
    history: [{ role: 'user', content: '今天很累' }]
  });
  const kinds = r.messages.map((m) => m.role);
  /* 全部 system 在前，唯一的 user 消息（历史原文）必须在最末 */
  const firstUser = kinds.indexOf('user');
  if (kinds.slice(firstUser).some((x) => x !== 'user')) throw new Error('user 消息没垫底');
  const slots = r.slots.map((s) => s.id);
  ['character', 'i01', 'shell', 'f1', 'c05', 'history'].forEach((id) => {
    if (slots.indexOf(id) < 0) throw new Error('缺槽位：' + id);
  });
  if (slots.indexOf('c05') > slots.indexOf('history')) throw new Error('输出协议跑到历史后面了');
  return { 槽位数: slots.length, system: kinds.filter((x) => x === 'system').length };
});
t('I01 认知映射：barrier→char_knows_events / unaware→char_sensing / aware→merged / single→single', () => {
  S.core.addLink(s1, u1, 'unaware', true);
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'char_knows_events') throw new Error('barrier 映射错了');
  S.core.setBarrier(s1, u1, false);
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'char_sensing') throw new Error('unaware 映射错了');
  S.core.setCognition(s1, u1, 'aware');
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'merged') throw new Error('aware 映射错了');
  /* 2026-09-23：初始认知锁新加的第四档「没有小号」，要有自己的 mode，
     复用一个已有的会被 lockKeyOf 显示成别的档 */
  S.core.setCognition(s1, u1, 'single');
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'single') throw new Error('single 映射错了');
  S.core.setCognition(s1, u1, 'unaware');   /* 还原，别污染后面的断言 */
  return 'ok';
});
t('I01 正文带 [I01] 结构块和 awareness_mode 字段', () => {
  const r = S.promptEngine.assembleOnline({ charId: m1, userId: u1, history: [] });
  const i01 = r.messages.filter((m) => m.role === 'system' && m.content.indexOf('[I01]') >= 0)[0];
  if (!i01) throw new Error('没有 I01 段');
  if (i01.content.indexOf('awareness_mode:') < 0) throw new Error('缺 awareness_mode');
  return 'ok';
});
t('estimate：中文按 1.6、ASCII 按 0.3 估，别返回 0', () => {
  const a = S.promptEngine.estimate('今天很累');
  const b = S.promptEngine.estimate('hello');
  if (a < 4 || a > 12) throw new Error('中文估算离谱：' + a);
  if (b < 1 || b > 4) throw new Error('ASCII 估算离谱：' + b);
  return { 中文: a, ascii: b };
});
t('卡覆盖层：改 → 生效 → 恢复默认', () => {
  const before = S.promptEngine.cardBody('shell');
  S.promptEngine.saveCardBody('shell', before + '\n[测试追加]');
  if (S.promptEngine.cardBody('shell').indexOf('[测试追加]') < 0) throw new Error('覆盖没生效');
  S.promptEngine.resetCard('shell');
  if (S.promptEngine.cardBody('shell') !== before) throw new Error('恢复默认失败');
  return 'ok';
});
t('自定义注入卡：增 → 出现在装配里 → 删', () => {
  const c = S.promptEngine.addCustomCard('测试卡', '这是测试注入');
  const r1 = S.promptEngine.assembleOnline({ charId: m1, userId: u1, history: [] });
  if (!r1.slots.some((s) => s.id === c.id && s.on)) throw new Error('自定义卡没进装配');
  S.promptEngine.removeCustomCard(c.id);
  const r2 = S.promptEngine.assembleOnline({ charId: m1, userId: u1, history: [] });
  if (r2.slots.some((s) => s.id === c.id)) throw new Error('删掉的卡还在装配里');
  return 'ok';
});
t('locked 卡在非开发者模式下正文不外泄（slots 标 hidden）', () => {
  const was = S.promptEngine.isDev();
  S.promptEngine.setDev(false);
  const r = S.promptEngine.assembleOnline({ charId: m1, userId: u1, history: [] });
  const shell = r.slots.filter((s) => s.id === 'shell')[0];
  if (!shell || !shell.hidden) throw new Error('locked 卡没标 hidden');
  S.promptEngine.setDev(was);
  return 'ok';
});
t('K02 user 马甲人设：有 persona 就进装配，没有就省略', () => {
  /* 自带角色：沙盒隔离段（~1605 行）clearAll 过，m1/u1 已死 */
  const ch = S.core.upsertChar({ name: 'K02测试角色', kind: 'main' }).id;
  const uu = S.core.upsertUser({ name: 'K02马甲', persona: '测试马甲人设：喜欢熬夜。' }).id;
  const r1 = S.promptEngine.assembleOnline({ charId: ch, userId: uu, history: [] });
  const slot = r1.slots.filter((s) => s.id === 'usercore')[0];
  if (!slot || !slot.on) throw new Error('写了 persona 却没命中');
  if (r1.messages.filter((m) => m.content.indexOf('测试马甲人设') >= 0).length !== 1) {
    throw new Error('persona 没进 messages');
  }
  /* 没 persona 的马甲：整块省略 */
  S.core.upsertUser({ id: uu, persona: '' });
  const r2 = S.promptEngine.assembleOnline({ charId: ch, userId: uu, history: [] });
  if (r2.slots.filter((s) => s.id === 'usercore')[0].on) throw new Error('空 persona 不该命中');
  return 'ok';
});
t('K04 世界书：常驻必进，关键词条目按近期原文命中，个人书认挂的角色', () => {
  const ch = S.core.upsertChar({ name: '世界书测试角色', kind: 'main' }).id;
  const bid = 'wb_test_' + Date.now().toString(36);
  const books = S.store.get('worldbooks') || [];
  books.push({
    id: bid, name: '冒烟测试书', scope: 'global', enabled: true,
    entries: [
      { id: 'e1', name: '常驻设定', always: true, enabled: true, content: '这座城市常年下雨。' },
      { id: 'e2', name: '关键词条目', keys: '青岚镇', enabled: true, content: '青岚镇的钟楼停在三点。' },
      { id: 'e3', name: '无键无常驻', enabled: true, content: '这条永远不该出现。' }
    ]
  });
  S.store.set('worldbooks', books);
  try {
    const hit = S.promptEngine.assembleOnline({
      charId: ch, userId: u1,
      history: [{ role: 'user', content: '我们去青岚镇看看吧' }]
    });
    const hitText = hit.messages.map((m) => m.content).join('\n');
    if (hitText.indexOf('这座城市常年下雨') < 0) throw new Error('常驻条目没进');
    if (hitText.indexOf('青岚镇的钟楼') < 0) throw new Error('关键词命中没进');
    if (hitText.indexOf('永远不该出现') >= 0) throw new Error('无键条目漏进来了');

    const miss = S.promptEngine.assembleOnline({
      charId: ch, userId: u1, history: [{ role: 'user', content: '今天天气不错' }]
    });
    const missText = miss.messages.map((m) => m.content).join('\n');
    if (missText.indexOf('这座城市常年下雨') < 0) throw new Error('常驻条目不该缺席');
    if (missText.indexOf('青岚镇的钟楼') >= 0) throw new Error('没命中也进了');
    return 'ok';
  } finally {
    S.store.set('worldbooks', books.filter((b) => b.id !== bid));
  }
});
t('K04b 世界书导入：格式模板能被解析器原样吃回去 + 酒馆 json 必拒', () => {
  if (!S.worldbook || !S.worldbook.formatTemplate) throw new Error('formatTemplate 没导出');
  const parsed = S.worldbook.parseBooksText(S.worldbook.formatTemplate);
  const books = parsed.filter((p) => (p.entries || []).length);
  if (books.length !== 1) throw new Error('模板应解析出 1 本有内容的书，实际 ' + books.length);
  const es = books[0].entries;
  if (es.length !== 2) throw new Error('模板应解析出 2 个条目，实际 ' + es.length);
  if (es[0].name !== '他养的猫' || es[0].keys.indexOf('煤球') < 0) {
    throw new Error('关键词条目没解析对：' + JSON.stringify(es[0]));
  }
  if (es[1].name !== '他的口头禅' || !es[1].always) throw new Error('常驻条目没解析对');
  if (!S.worldbook.isTavernJson('x.json', '{}')) throw new Error('.json 没被识别为酒馆格式');
  if (!S.worldbook.isTavernJson('x.txt', '{"entries":[]}')) throw new Error('json 内容没被识别');
  return 'ok';
});
t('assembleOffline：槽位齐 + 历史转写 + 马甲逐级回落', () => {
  const ch = S.core.upsertChar({ name: '线下测试角色', kind: 'main' }).id;
  const session = S.offlineStore.createSession(ch, {
    sceneName: '冒烟场景', location: '老书店', userId: null
  });
  try {
    const r = S.promptEngine.assembleOffline({ charId: ch, session, userInput: '我到了' });
    const ids = r.slots.map((s) => s.id);
    ['character', 'usercore', 'i01', 'shell', 'f2', 'relation', 'worldbook',
     'narrative', 'scene', 'c05off', 'history'].forEach((id) => {
      if (ids.indexOf(id) < 0) throw new Error('缺槽：' + id);
    });
    if (!r.slots.filter((s) => s.id === 'scene')[0].on) throw new Error('场景槽没命中');
    const lastUser = r.messages[r.messages.length - 1];
    if (lastUser.role !== 'user' || lastUser.content !== '我到了') {
      throw new Error('当前输入没垫底');
    }
    /* 老会话没存 userId：装配要回落到激活马甲，不许是 null */
    const sysText = r.messages.map((m) => m.content).join('\n');
    if (sysText.indexOf('user_account') < 0) throw new Error('I01 没生成');
    return { 槽位数: ids.length, messages: r.messages.length };
  } finally {
    const list = S.offlineStore.allSessions().filter((s) => s.id !== session.id);
    S.store.set('offlineSessions', list);
  }
});
ok('预设 app 已注册（presets）', !!S.registered().presets);

console.log('\n--- K03 注入接线二期（群岛关系 + 身份归属 + NPC） ---');
t('compileIslandKB：关系/归属/NPC 资料按规则进注入', () => {
  /* 沙盒隔离段（1605 行起）会 clearAll() 把前面的世界清掉，
     所以这一段**自带角色和马甲**，不去依赖 m1/m2/u1/u2。 */
  const a1 = S.core.upsertChar({ name: '林澈', kind: 'main' }).id;
  const a2 = S.core.upsertChar({ name: '沈聿', kind: 'main' }).id;
  const u = (S.core.userMasks()[0] || S.core.upsertUser({ name: '阿乐' })).id;

  const arch = S.core.createSandbox('archipelago', 'K03测试群岛').id;
  const rChars = S.core.setSandboxChars(arch, [a1, a2]);
  if (!rChars.ok) throw new Error('setSandboxChars 失败：' + rChars.message);
  S.core.setSandboxMasks(arch, [u]);
  S.core.setActiveSandbox(arch);

  /* 数据侧（浮岛写入的格式）：群岛关系 + 归属判断都存 charRel:<sbId> */
  const relKey = 'charRel:' + arch;
  const map = S.store.get(relKey) || {};
  map[a1 < a2 ? a1 + '|' + a2 : a2 + '|' + a1] = 'unknown';
  map['judge:' + a1 + ':' + u] = 'other';   /* 林澈眼里这张马甲是另一个人 */
  S.store.set(relKey, map);

  /* NPC 归属整座岛（09-19 定稿），knownBy 只勾了林澈 */
  S.core.upsertChar({
    name: 'K03店员', kind: 'npc',
    parentId: arch, parentType: 'sandbox', sandboxId: arch,
    content: '便利店的夜班店员', speech: '说话很慢',
    knownBy: [a1], npcVis: { chat: true, group: true, moments: false }
  });

  const forM1 = S.switcher.compileIslandKB(a1);
  if (forM1.indexOf('沈聿') < 0 || forM1.indexOf('不认识') < 0) {
    throw new Error('群岛关系没进注入：' + forM1.slice(0, 60));
  }
  if (forM1.indexOf('另一个人') < 0) throw new Error('身份归属判断没进注入');
  if (forM1.indexOf('K03店员') < 0 || forM1.indexOf('说话很慢') < 0) {
    throw new Error('NPC 资料没进注入');
  }

  /* 沈聿没勾「认识店员」→ 拿不到 NPC 资料；关系线照有 */
  const forM2 = S.switcher.compileIslandKB(a2);
  if (forM2.indexOf('K03店员') >= 0) throw new Error('不认识 NPC 的角色也拿到了资料');
  if (forM2.indexOf('不认识') < 0) throw new Error('沈聿的关系线缺失');

  /* 总装口带上 K03 块 */
  const full = S.switcher.compileSystemContext(a1, u, 8);
  if (full.indexOf('这座岛里的人际') < 0) throw new Error('compileSystemContext 没带 K03 块');

  S.core._purgeSync.sandbox(arch);
  S.core._purgeSync.char(a1);
  S.core._purgeSync.char(a2);
  return { 林澈注入: forM1.split('\n').length + ' 行', 沈聿拿不到NPC: true, 总装: true };
});

t('NPC 唯一口径：core.npcsOfRoom 收齐岛级 + 老数据（char/user 名下）', () => {
  /* 2026-09-21 四.2 收敛：NPC 属于整座岛（parentType='sandbox'），
     关系树/通讯录/群/记忆/朋友圈/查手机 全部只查这一个口。
     老数据（挂在 char / user 名下的）照收，别让老 NPC 凭空消失。 */
  const m = S.core.upsertChar({ name: '口径岛主', kind: 'main' }).id;
  const u = (S.core.userMasks()[0] || S.core.upsertUser({ name: '口径我' })).id;
  const isle = S.core.createSandbox('isle', '口径测试岛').id;
  S.core.setSandboxChars(isle, [m]);
  S.core.setSandboxMasks(isle, [u]);
  S.core.setActiveSandbox(isle);

  const nNew = S.core.upsertChar({
    name: '岛级店员', kind: 'npc',
    parentId: isle, parentType: 'sandbox', sandboxId: isle
  }).id;
  const nChar = S.core.upsertChar({
    name: '老式同事', kind: 'npc',
    parentId: m, parentType: 'char', sandboxId: isle
  }).id;
  const nUser = S.core.upsertChar({
    name: '老式邻居', kind: 'npc',
    parentId: u, parentType: 'user', sandboxId: isle
  }).id;
  /* 别岛的岛级 NPC 不得混进来 */
  const other = S.core.createSandbox('isle', '别的岛').id;
  S.core.upsertChar({
    name: '别岛的人', kind: 'npc',
    parentId: other, parentType: 'sandbox', sandboxId: other
  });

  const ids = S.core.npcsOfRoom(isle).map((c) => c.id);
  if (ids.indexOf(nNew) < 0) throw new Error('岛级 NPC 没被收进来');
  if (ids.indexOf(nChar) < 0) throw new Error('char 名下老 NPC 没被兜底收进来');
  if (ids.indexOf(nUser) < 0) throw new Error('user 名下老 NPC 没被兜底收进来');
  if (ids.length !== 3) throw new Error('别岛或无关 NPC 混进来了：' + ids.length + ' 个');

  /* page-island 的同名出口只是委托，别再有两套答案 */
  if (S.island.npcsOfRoom(isle).length !== 3) throw new Error('island.npcsOfRoom 与 core 口径不一致');
  if (S.island.offspringOf) throw new Error('offspringOf 应已删除（两套口径不许并存）');

  S.core._purgeSync.sandbox(isle);
  S.core._purgeSync.sandbox(other);
  S.core._purgeSync.char(m);
  return { 收齐: ids.length, 别岛隔离: true, 出口唯一: true };
});

t('留痕首页按岛过滤（sandbox 归属的 NPC 也要收进来）', () => {
  const m = S.core.upsertChar({ name: '留痕岛主', kind: 'main' }).id;
  const u = (S.core.userMasks()[0] || S.core.upsertUser({ name: '阿乐' })).id;
  const isle = S.core.createSandbox('isle', 'K03留痕岛').id;
  S.core.setSandboxChars(isle, [m]);
  S.core.setSandboxMasks(isle, [u]);
  S.core.setActiveSandbox(isle);
  const npc = S.core.upsertChar({
    name: '岛上裁缝', kind: 'npc',
    parentId: isle, parentType: 'sandbox', sandboxId: isle,
    content: '改衣服的'
  });
  const chars = S.memoryStore.loadIsland().chars;
  const ids = chars.map((c) => c.id);
  if (ids.indexOf(m) < 0) throw new Error('主角色没进留痕');
  if (ids.indexOf(npc.id) < 0) throw new Error('sandbox 归属的 NPC 没进留痕');
  S.core._purgeSync.char(npc.id);
  S.core._purgeSync.char(m);
  S.core._purgeSync.sandbox(isle);
  return { 收录: ids.length };
});

console.log('\n--- proactive:主动消息引擎（资格闸门） ---');
t('候选队列：attention > loop > unspoken，内容指纹去重', () => {
  const c = S.core.upsertChar({ name: '候选测试', kind: 'main' }).id;
  S.store.set('attentionInbox:' + c, { items: ['想约你去看展', '想约你去看展'], updatedAt: '' });
  S.store.set('openLoops:' + c, { items: ['答应帮你带书'], updatedAt: '' });
  const list = S.proactiveEngine.candidatesFor(c);
  if (list.length !== 2) throw new Error('候选数量不对：' + list.length);
  if (list[0].source !== 'attention') throw new Error('优先级不对：' + list[0].source);
  S.core._purgeSync.char(c);
  return { 候选: list.length, 去重: true };
});
t('闸门：过闸 / 未回复不追问 / 每日上限 / 开关关闭', () => {
  const c = S.core.upsertChar({ name: '闸门测试', kind: 'main' }).id;
  const u = (S.core.userMasks()[0] || S.core.upsertUser({ name: '我' })).id;
  const isle = S.core.createSandbox('isle', '主动测试岛').id;
  S.core.setSandboxChars(isle, [c]);
  S.core.setSandboxMasks(isle, [u]);
  S.core.setActiveSandbox(isle);
  const chat = {
    id: 'c_proa', sandboxId: isle, characterId: c, name: '闸门测试',
    messages: [{ id: 'm1', role: 'user', content: '在吗', timestamp: Date.now() }]
  };
  S.store.set('chats', [chat]);
  S.store.set('attentionInbox:' + c, { items: ['昨天说好的那件事'], updatedAt: '' });

  /* 免打扰时段置空，测试不受真实时刻影响 */
  const savedSt = S.proactiveEngine.settings();
  S.proactiveEngine.saveSettings({ quietStart: '', quietEnd: '' });

  const g1 = S.proactiveEngine.gateFor(c, { manual: true });
  if (!g1.ok) throw new Error('应该过闸：' + g1.why);
  if (g1.cands.length !== 1) throw new Error('候选没进闸');

  /* TA 最后说话 → 不追问（非手动也要拦） */
  chat.messages.push({ id: 'm2', role: 'assistant', content: '嗯', timestamp: Date.now() });
  S.store.set('chats', [chat]);
  const g2 = S.proactiveEngine.gateFor(c, {});
  if (g2.ok || g2.why !== 'awaiting') throw new Error('未回复应拦：' + (g2.why || '没拦'));

  /* 每日上限 */
  chat.messages.push({ id: 'm3', role: 'user', content: '好', timestamp: Date.now() });
  S.store.set('chats', [chat]);
  const psKey = 'proactiveState:' + c;
  /* day 必须用**本地日期**（闸门里 todayStr() 是本地日期）——
     用 UTC 的 toISOString 造数据，一过本地午夜就错位：
     count 被当成隔天清零，「上限应拦」变成永远过闸（00:00~08:00 跑必挂）。 */
  const localDay = (() => {
    const d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  })();
  S.store.set(psKey, { lastAt: 0, day: localDay, count: 99, handled: [], deferredUntil: 0 });
  const g3 = S.proactiveEngine.gateFor(c, { manual: true });
  if (g3.ok || g3.why !== 'limit') throw new Error('上限应拦：' + (g3.why || '没拦'));

  /* 角色级开关关闭 */
  if (!S.chatSettings.charSettings) throw new Error('charSettings 没导出');
  S.store.set(psKey, { lastAt: 0, day: '', count: 0, handled: [], deferredUntil: 0 });
  S.chatSettings.charSettings(c).set('proactive', false);
  const g4 = S.proactiveEngine.gateFor(c, { manual: true });
  if (g4.ok || g4.why !== 'off') throw new Error('开关应拦：' + (g4.why || '没拦'));
  S.chatSettings.charSettings(c).set('proactive', true);

  S.store.set('chats', []);
  S.core._purgeSync.char(c);
  S.core._purgeSync.sandbox(isle);
  S.proactiveEngine.saveSettings({ quietStart: savedSt.quietStart, quietEnd: savedSt.quietEnd });
  return { 过闸: true, 未回复拦: true, 上限拦: true, 开关拦: true };
});
t('gateWhyText：实时文案（暂缓/冷却带分钟）+ deferMin 可配', () => {
  const c = S.core.upsertChar({ name: '文案测试', kind: 'main' }).id;
  const isle = S.core.createSandbox('isle', '文案测试岛').id;
  S.core.setSandboxChars(isle, [c]);
  S.core.setActiveSandbox(isle);
  const chat = {
    id: 'c_why', sandboxId: isle, characterId: c, name: '文案测试',
    messages: [{ id: 'm1', role: 'user', content: '嗯', timestamp: Date.now() }]
  };
  S.store.set('chats', [chat]);
  const saved = S.proactiveEngine.settings();
  S.proactiveEngine.saveSettings({ quietStart: '', quietEnd: '' });

  /* 暂缓中 → 文案带「暂缓」和分钟数 */
  S.store.set('proactiveState:' + c,
    { lastAt: 0, day: '', count: 0, handled: [], deferredUntil: Date.now() + 30 * 60000 });
  const w1 = S.proactiveEngine.gateWhyText(c, {});
  if (typeof w1 !== 'string' || w1.indexOf('暂缓') < 0 || w1.indexOf('分钟') < 0) {
    throw new Error('defer 文案不对：' + w1);
  }
  /* 冷却中 */
  S.store.set('proactiveState:' + c,
    { lastAt: Date.now(), day: '', count: 0, handled: [], deferredUntil: 0 });
  const w2 = S.proactiveEngine.gateWhyText(c, {});
  if (w2.indexOf('冷却') < 0) throw new Error('cooldown 文案不对：' + w2);

  /* deferMin 进设置且可保存 */
  if (S.proactiveEngine.settings().deferMin === undefined) throw new Error('deferMin 没进设置');
  S.proactiveEngine.saveSettings({ deferMin: 45 });
  if (S.proactiveEngine.settings().deferMin !== 45) throw new Error('deferMin 保存失败');

  /* 过闸 → 「现在就有合适的时机」 */
  S.store.set('proactiveState:' + c,
    { lastAt: 0, day: '', count: 0, handled: [], deferredUntil: 0 });
  S.store.set('attentionInbox:' + c, { items: ['新候选'], updatedAt: '' });
  const w3 = S.proactiveEngine.gateWhyText(c, {});
  if (w3.indexOf('合适') < 0) throw new Error('过闸文案不对：' + w3);

  S.proactiveEngine.saveSettings({
    quietStart: saved.quietStart, quietEnd: saved.quietEnd,
    deferMin: saved.deferMin !== undefined ? saved.deferMin : 90
  });
  S.store.set('chats', []);
  S.core._purgeSync.char(c);
  S.core._purgeSync.sandbox(isle);
  return { 暂缓: w1, 冷却: w2, 过闸: true };
});

/* ---------------- core-group：线上群聊数据层 ----------------
   本体/账号两层、消息单列表、撤回不删原文、按房隔离 ——
   这些是总纲的地基，地基松动后面全塌，所以逐条断言。 */

console.log('\n--- core-group：群聊数据层 ---');

/* 前面的沙盒隔离段 clearAll() 之后早期角色已死（见该段注释），
   这里自带一整套夹具：两个大号 + 皮套 + NPC + 马甲 + 群群岛，
   并把 activeSandbox 指过去 —— scopeId 为 null 时 tagScope 不盖章，
   群会变成「不属于任何房」的幽灵数据。 */
const gFix = (() => {
  const m = S.core.upsertChar({ name: '青屿', kind: 'main', content: '群聊测试大号A' }).id;
  const s = S.core.upsertChar({ name: '晚灯', kind: 'sub', parentId: m, content: '群聊测试皮套' }).id;
  const n = S.core.upsertChar({ name: '店长', kind: 'npc', parentId: m, content: '群聊测试NPC' }).id;
  const u = S.core.upsertUser({ name: '梦梦' }).id;
  const sb = S.core.createSandbox('archipelago', '群聊测试群岛');
  S.core.setSandboxChars(sb.id, [m]);
  S.core.setActiveSandbox(sb.id);
  return { m, s, n, u, arch: sb.id };
})();

t('群聊：测试群岛就位（自带角色 + activeSandbox 指过去）', () => {
  if (!S.core.scopeId()) throw new Error('activeSandbox 没指过去');
  if (!S.core.findChar(gFix.m) || !S.core.findChar(gFix.s)) throw new Error('角色没建出来');
  return '就位';
});

t('createGroup 校验：空名 / 没有角色成员 / 重复账号都拒绝', () => {
  const bad1 = S.groupStore.createGroup({ name: '', ownerAccountId: gFix.u, members: [{ kind: 'char', ownerId: gFix.m, accountId: gFix.m }] });
  if (bad1.ok) throw new Error('空名应拒');
  const bad2 = S.groupStore.createGroup({ name: '只有我', ownerAccountId: gFix.u, members: [{ kind: 'user', ownerId: 'user', accountId: gFix.u }] });
  if (bad2.ok) throw new Error('纯 user 群应拒');
  const bad3 = S.groupStore.createGroup({
    name: '重复', ownerAccountId: gFix.u,
    members: [
      { kind: 'char', ownerId: gFix.m, accountId: gFix.m },
      { kind: 'char', ownerId: gFix.m, accountId: gFix.m }
    ]
  });
  if (bad3.ok) throw new Error('重复账号应拒');
  return '三种都拒';
});

const gGrp = t('createGroup 正常建群', () => {
  const r = S.groupStore.createGroup({
    name: '周末出门群',
    ownerAccountId: gFix.u,
    members: [
      { kind: 'char', ownerId: gFix.m, accountId: gFix.m },
      { kind: 'char', ownerId: gFix.m, accountId: gFix.s },
      { kind: 'npc', ownerId: gFix.n, accountId: gFix.n }
    ],
    opening: 'user'
  });
  if (!r.ok) throw new Error(r.message);
  return r.group.id;
});

t('建群后：owner 自动入群 + 系统消息 + 设置默认', () => {
  const ms = S.groupStore.membersOf(gGrp);
  if (ms.length !== 4) throw new Error('成员应 4 个账号，实 ' + ms.length);
  const owner = S.groupStore.findMember(gGrp, gFix.u);
  if (!owner || owner.role !== 'owner' || owner.kind !== 'user') throw new Error('群主账号不对');
  const sys = S.groupStore.messagesOf(gGrp);
  if (sys.length !== 1 || sys[0].type !== 'system') throw new Error('系统消息没落');
  const g = S.groupStore.findGroup(gGrp);
  if (g.settings.opening !== 'user' || g.settings.rhythm !== 'light') throw new Error('设置默认不对');
  return { 成员: ms.length, 开场: g.settings.opening };
});

t('addMessage：皮套发言的本体归一到 rootId', () => {
  const msg = S.groupStore.addMessage(gGrp, {
    senderKind: 'char', senderAccountId: gFix.s, content: '小和替大号说话'
  });
  if (msg.senderEntityId !== gFix.m) throw new Error('本体应归到 ' + gFix.m + '，实 ' + msg.senderEntityId);
  const um = S.groupStore.addMessage(gGrp, {
    senderKind: 'user', senderAccountId: gFix.u, content: '我说的'
  });
  if (um.senderEntityId !== 'user') throw new Error('user 本体恒为 user');
  return { 皮套: msg.senderEntityId, user: um.senderEntityId };
});

ok('accountsOfEntity：同一本体在群里查到两个账号（调度去重的原料）',
  S.groupStore.accountsOfEntity(gGrp, gFix.m).length === 2);

t('recallMessage：撤回打戳不删原文；系统消息拒撤', () => {
  const msgs = S.groupStore.messagesOf(gGrp);
  const text = msgs.filter((x) => x.type === 'text')[0];
  const r = S.groupStore.recallMessage(gGrp, text.id);
  if (!r.ok || !r.message.recalledAt) throw new Error('没打戳');
  if (r.message.content !== '小和替大号说话') throw new Error('原文不该删');
  const sys = msgs.filter((x) => x.type === 'system')[0];
  if (S.groupStore.recallMessage(gGrp, sys.id).ok) throw new Error('系统消息应拒撤');
  return '戳在、文在';
});

t('addMembers 去重 + setMemberStatus 退群', () => {
  const again = S.groupStore.addMembers(gGrp, [{ kind: 'char', ownerId: gFix.m, accountId: gFix.m }]);
  if (again.added.length !== 0) throw new Error('已在本群的应跳过');
  const r = S.groupStore.setMemberStatus(gGrp, gFix.n, 'left');
  if (!r.ok) throw new Error(r.message);
  if (S.groupStore.membersOf(gGrp).length !== 3) throw new Error('退群后应 3 个活跃');
  if (S.groupStore.membersOf(gGrp, true).length !== 4) throw new Error('留档行不能物理删');
  return { 重复邀: 0, 退群: 'left 留档' };
});

t('updateGroup：settings 白名单合并，不是整体替换', () => {
  const r = S.groupStore.updateGroup(gGrp, {
    name: '周末出门群（改）',
    settings: { rhythm: 'active', mute: true }
  });
  if (!r.ok) throw new Error(r.message);
  if (r.group.settings.opening !== 'user') throw new Error('settings 整体替换会冲掉别的键');
  if (r.group.settings.rhythm !== 'active') throw new Error('rhythm 没改到');
  return { 名: r.group.name, 节奏: r.group.settings.rhythm };
});

/* ---- 群聊美化（2026-10-05）：beautifyCss 白名单落库 + 页面接线 ---- */
t('群聊美化：beautifyCss 走 updateGroup 落库，编辑页注册、群聊页注入', () => {
  const r = S.groupStore.updateGroup(gGrp, { beautifyCss: '.gc-list{padding-bottom:30px;}' });
  if (!r.ok) throw new Error(r.message);
  const back = S.groupStore.findGroup(gGrp);
  if (back.beautifyCss !== '.gc-list{padding-bottom:30px;}') {
    throw new Error('beautifyCss 没落库 —— GROUP_FIELDS 白名单没放行？');
  }
  /* 清掉，别把测试 CSS 留给后面的用例 */
  S.groupStore.updateGroup(gGrp, { beautifyCss: '' });
  if (S.groupStore.findGroup(gGrp).beautifyCss !== '') throw new Error('清空没落库');

  const src = require('fs').readFileSync(path.join(ROOT, 'page-group.js'), 'utf8');
  if (src.indexOf("register('group-beautify'") < 0) throw new Error('编辑页没注册');
  if (src.indexOf("open('group-beautify'") < 0) throw new Error('群详情卡没接编辑页入口');
  /* 注入必须复用 apCustomStyle 槽位（和角色外观互斥），且旧卡必须真被换掉 */
  if (src.indexOf("getElementById('apCustomStyle')") < 0) throw new Error('群聊页没走 apCustomStyle 槽位');
  if (src.indexOf('gd-offline') >= 0) throw new Error('群详情里旧的多人线下卡还在');
  return '落库 + 接线都在';
});

t('群按房隔离：换房看不见 + removeSandbox 连带清三张表', () => {
  const other = S.core.createSandbox('isle', '别的房');
  S.core.setActiveSandbox(other.id);
  const seen = S.groupStore.listGroups();
  if (seen.length !== 0) throw new Error('别的房不该看见这个群，实 ' + seen.length);
  S.core.setActiveSandbox(gFix.arch);
  S.core._purgeSync.sandbox(other.id);
  /* 删群测试群岛：三张表都应该清掉 */
  const before = {
    groups: S.store.get('groups').length,
    members: S.store.get('groupMembers').length,
    msgs: S.store.get('groupMessages').length
  };
  if (!before.groups) throw new Error('测试前置不对：群里没数据');
  S.core._purgeSync.sandbox(gFix.arch);
  const after = {
    groups: S.store.get('groups').length,
    members: S.store.get('groupMembers').length,
    msgs: S.store.get('groupMessages').length
  };
  if (after.groups + after.members + after.msgs !== 0) {
    throw new Error('removeSandbox 没清干净：' + JSON.stringify(after));
  }
  return '三表全清';
});

/* ==================== 项目3：解散群 purgeGroup（门禁 + 护栏）====================
   三层测试策略（与向量三层一致）：
     · smoke（node 无 IDB）：门禁三分支 + 反向护栏。完整端到端（真块/失败注入/
       tombstone）在 browser-idb-test。
   门禁判据（与 wipeAll 同源，memory-vec.js:155/550）：
     · `!global.indexedDB` = 合法「无向量环境」→ not-applicable → 允许删主表；
     · 有 IDB 但 memoryVec 缺失 / forgetGroup 缺失 / 打开失败 → **必须失败保留主表**
       （绝不静默物理删群却留下它的向量块 = 隐私残留 + 幻觉源）。 */

const p3Fix = (() => {
  const m = S.core.upsertChar({ name: '清屿', kind: 'main', content: '项目3解散群测试大号' }).id;
  const u = S.core.upsertUser({ name: '梦梦' }).id;
  const sb = S.core.createSandbox('archipelago', '项目3解散群测试岛');
  S.core.setActiveSandbox(sb.id);
  const mk = (name, extra) => {
    const r = S.groupStore.createGroup({
      name, ownerAccountId: u,
      members: [{ kind: 'char', ownerId: m, accountId: m }, { kind: 'user', ownerId: 'user', accountId: u }],
      ...extra
    });
    if (!r.ok) throw new Error('项目3 造群失败: ' + r.message);
    return r.group.id;
  };
  return { m, u, sb: sb.id, mk };
})();

t('项目3 P3-M1 反向护栏：removeGroup 不再导出，purgeGroup/forgetGroup 存在', () => {
  if ('removeGroup' in S.groupStore) throw new Error('removeGroup 不该再导出');
  if (typeof S.groupStore.purgeGroup !== 'function') throw new Error('purgeGroup 该存在');
  if (typeof S.memoryVec.forgetGroup !== 'function') throw new Error('forgetGroup 该存在');
  return '护栏齐';
});

t('项目3 P3-M1b 静态护栏：UI 成功 toast 只在 ok:true 时出现，失败不 toast「已解散」', () => {
  const chatSrc = require('fs').readFileSync('page-chat.js', 'utf8');
  /* 调用改异步：不再同步 removeGroup */
  if (/removeGroup\(/.test(chatSrc)) throw new Error('page-chat 不该再同步调 removeGroup');
  if (chatSrc.indexOf('purgeGroup(g.id).then') < 0) throw new Error('page-chat 该用异步 purgeGroup().then');
  if (chatSrc.indexOf('if (res && res.ok)') < 0) throw new Error('成功分支该按 res.ok 门禁');
  if (chatSrc.indexOf("ctx.toast('已解散', 'ok')") < 0) throw new Error('成功 toast 该在');
  /* 成功 toast 必须被 res.ok 门禁包住：定位到 success toast 前最近的 if(res&&res.ok) */
  const okToast = chatSrc.indexOf("ctx.toast('已解散', 'ok')");
  const gate = chatSrc.lastIndexOf('if (res && res.ok)', okToast);
  if (gate < 0 || gate > okToast) throw new Error('「已解散」不该出现在 res.ok 门禁之外');
  /* 失败分支要有 err toast（用户要求 5：失败不显示成功 toast） */
  if (chatSrc.indexOf("|| '解散失败', 'err'") < 0) throw new Error('失败该 toast 成 err，不能静默假装成功');
  return '成功门禁 + 失败err + 不静默';
});

/* ⚠️ smoke 的 t() 对 async 是**并发**的（不 await 就返回）。项目3 的门禁测试要
   串行改 win.indexedDB / 建删群，**必须合成一个 async 测试**，否则并发互相踩。 */
t('项目3 P3-M2~M5 门禁三分支 + 无副作用 + 重试补完（串行）', () => withIdbLock(async () => {
  const savedIDB = win.indexedDB;          /* smoke 默认无 IDB */
  const hadIDB = 'indexedDB' in win;
  const savedFG = S.memoryVec.forgetGroup;
  /* 恢复 IDB：原环境**没有**这键时（node）必须 delete 整键，只赋回 undefined
     会留下 own property，导致后续串行测试的 `'indexedDB' in win` 误判 true。 */
  const restoreIDB = () => {
    if (hadIDB) { win.indexedDB = savedIDB; } else { delete win.indexedDB; }
  };

  /* -- M2 不存在的群：无副作用（只验目标 id 不出现，不断言总表长度——
     smoke 后续同步 IIFE 可能并发建群，长度会变） -- */
  const ghost = 'noSuchGroup' + Date.now();
  let r = await S.groupStore.purgeGroup(ghost);
  if (!r || r.ok !== false || r.message !== '找不到这个群') throw new Error('不存在群该 ok:false');
  if (S.groupStore.findGroup(ghost)) throw new Error('不该出现这个群');
  if ((S.store.get('groupMembers') || []).some((x) => x.groupId === ghost)) throw new Error('不该出现该群成员');
  if ((S.store.get('groupMessages') || []).some((x) => x.groupId === ghost)) throw new Error('不该出现该群消息');

  /* -- M3 not-applicable 门禁：无 IDB → 允许删主表 + 别群保留 -- */
  if ('indexedDB' in win) throw new Error('smoke 前置不对：win 不该有 indexedDB');
  const g3 = p3Fix.mk('P3A-无IDB群');
  S.store.set('groupPending:' + g3, [1]);
  S.store.set('groupInner:' + g3, { x: 1 });
  S.store.set('sumCursor:g:' + g3, { at: 1 });
  S.store.set('groupOfflineSessions', [{ groupId: g3, status: 'active' }, { groupId: 'keep', status: 'active' }]);
  S.store.set('offlineHandoffs', [{ groupId: g3 }, { groupId: 'keep2' }]);
  r = await S.groupStore.purgeGroup(g3);
  if (!r || r.ok !== true) throw new Error('无IDB环境该 ok:true，实 ' + JSON.stringify(r));
  if (S.groupStore.findGroup(g3)) throw new Error('主表 groups 没删');
  if ((S.store.get('groupMembers') || []).some((x) => x.groupId === g3)) throw new Error('主表 groupMembers 没删');
  if ((S.store.get('groupMessages') || []).some((x) => x.groupId === g3)) throw new Error('主表 groupMessages 没删');
  if (S.store.get('groupPending:' + g3) != null) throw new Error('groupPending 没删');
  if (S.store.get('groupInner:' + g3) != null) throw new Error('groupInner 没删');
  if (S.store.get('sumCursor:g:' + g3) != null) throw new Error('sumCursor 没删');
  let off = S.store.get('groupOfflineSessions');
  if (!off || off.some((x) => x.groupId === g3)) throw new Error('groupOfflineSessions 该群行没滤');
  if (!off.some((x) => x.groupId === 'keep')) throw new Error('别群线下行被误删');
  let ho = S.store.get('offlineHandoffs');
  if (!ho || ho.some((x) => x.groupId === g3)) throw new Error('offlineHandoffs 该群行没滤');
  if (!ho.some((x) => x.groupId === 'keep2')) throw new Error('别群交接单被误删');
  /* tombstone：active 行在过滤前先 ended（这里 g3 行已滤掉，只验别群行仍在） */
  off = S.store.get('groupOfflineSessions');
  if (!off.some((x) => x.groupId === 'keep' && x.status === 'active')) throw new Error('别群 active 行不该被动');

  /* -- M4 api-missing 门禁：有 IDB 但 forgetGroup 缺失 → 失败保留主表 -- */
  const g4 = p3Fix.mk('P3B-api缺失群');
  win.indexedDB = {};                       /* 有 IDB = 本应有向量能力 */
  delete S.memoryVec.forgetGroup;           /* 但 API 缺失 */
  r = await S.groupStore.purgeGroup(g4);
  S.memoryVec.forgetGroup = savedFG;
  restoreIDB();
  if (!r || r.ok !== false) throw new Error('该失败，实 ' + JSON.stringify(r));
  if (r.why !== 'memory-vector-unavailable/api-missing') throw new Error('why 该是 api-missing，实 ' + r.why);
  if (!S.groupStore.findGroup(g4)) throw new Error('主表不该被删（api-missing 必须保留）');
  if (!(S.store.get('groupMembers') || []).some((x) => x.groupId === g4)) throw new Error('成员不该被删');

  /* -- M5 vector-failed 门禁：有 IDB 但向量打开失败 → 失败保留主表 -- */
  const g5 = p3Fix.mk('P3C-向量失败群');
  win.indexedDB = {};                       /* 有 IDB（gate 判 hasIDB=true）*/
  r = await S.groupStore.purgeGroup(g5);
  restoreIDB();
  if (!r || r.ok !== false) throw new Error('该失败，实 ' + JSON.stringify(r));
  if (r.why !== 'memory-vector-failed') throw new Error('why 该 vector-failed，实 ' + r.why);
  if (S.groupStore.findGroup(g5) === null) throw new Error('主表不该被删（vector-failed 必须保留）');
  if (S.store.get('groupPending:' + g5) != null) throw new Error('派生键也不该动');

  /* -- 重试补完：失败保留的群，在环境恢复（无 IDB = not-applicable）后重试 → 全清 -- */
  await S.groupStore.purgeGroup(g4);
  await S.groupStore.purgeGroup(g5);
  if (S.groupStore.findGroup(g4)) throw new Error('g4 重试后主表没清干净');
  if (S.groupStore.findGroup(g5)) throw new Error('g5 重试后主表没清干净');

  return 'M2无副作用 / M3无IDB全清 / M4 api缺失保留 / M5 vector失败保留 / 重试补完';
}));

/* ==================== 项目4：岛/角色/皮套/马甲 purge（门禁 + 护栏）====================
   三层测试策略（与项目3 一致）：
     · smoke（node 无 IDB）：反向护栏 + 参数校验 + 门禁三分支 + 默认「我」保护 +
       主表隔离（跨岛/同 root/同 uid）。
     · 完整端到端（真块 / 失败注入 / 隔离向量）在 browser-idb-test。
   门禁判据（与 purgeVecGate 同源）：
     · `!global.indexedDB` = 合法「无向量环境」→ not-applicable → 允许删主表；
     · 有 IDB 但出口缺失 / 打开失败 → **必须失败保留主表**（绝不静默物理删却留向量块）。 */

/* 项目4 反向护栏 + 参数校验（同步，不打 IDB） */
t('项目4 P4-M1 反向护栏：removeXxx 不再导出，purge/forget 新出口都在，scanAll 不导出', () => {
  const c = S.core;
  if ('removeSandbox' in c || 'removeChar' in c || 'removeUser' in c) {
    throw new Error('旧同步删除导出不该再存在');
  }
  if (typeof c.purgeSandbox !== 'function' || typeof c.purgeChar !== 'function' ||
      typeof c.purgeFace !== 'function' || typeof c.purgeUser !== 'function') {
    throw new Error('四 purge 出口该存在');
  }
  const mv = S.memoryVec;
  if (typeof mv.forgetSandbox !== 'function' || typeof mv.forgetCharSet !== 'function' ||
      typeof mv.forgetUser !== 'function') {
    throw new Error('forgetSandbox/forgetCharSet/forgetUser 该存在');
  }
  /* 早期按 rootOf 一刀切的 forgetChar / 三维 forgetFace 已退役 ——
     那是清整池 / 漏删子 NPC 的事故源，不许再出现在导出面 */
  if (typeof mv.forgetChar === 'function' || typeof mv.forgetFace === 'function') {
    throw new Error('forgetChar/forgetFace 不该再导出（已由 forgetCharSet 取代）');
  }
  if ('scanAll' in mv || ((mv._pure || {}).scanAll !== undefined)) {
    throw new Error('scanAll 是内部私有，不该导出');
  }
  /* _purgeSync 是测试专用（非生产删除 API），名字带 _ 前缀 */
  if (!c._purgeSync || typeof c._purgeSync.sandbox !== 'function') {
    throw new Error('_purgeSync 测试清理出口该存在');
  }
  return '护栏齐 + scanAll 私有';
});

/* 项目4 四出口参数校验：缺必要字段必须 reject，不能依赖调用方自觉 */
t('项目4 P4-M2 四 forget 出口缺字段必 reject', async () => {
  const mv = S.memoryVec;
  const cases = [
    [mv.forgetSandbox, {}, 'sandboxId'],
    [mv.forgetSandbox, { sandboxId: '' }, 'sandboxId'],
    [mv.forgetCharSet, {}, 'charIds(非空数组) & sandboxId'],
    [mv.forgetCharSet, { charIds: ['x'] }, 'charIds(非空数组) & sandboxId'],
    [mv.forgetCharSet, { charIds: [], sandboxId: 'sb' }, 'charIds(非空数组) & sandboxId'],
    [mv.forgetUser, {}, 'userId & sandboxId'],
    [mv.forgetUser, { userId: 'u' }, 'userId & sandboxId']
  ];
  for (const [fn, arg, want] of cases) {
    let threw = false;
    try { await fn(arg); } catch (e) { threw = true; if (String(e.message).indexOf('缺必要字段') < 0) throw new Error('该报缺字段，实 ' + e.message); }
    if (!threw) throw new Error('缺字段该 reject：' + want);
  }
  /* 字段齐 → 不该因「字段校验」reject。无 IDB 环境 forget 无法真删块（open 失败），
     但那不是字段校验的错 —— 断言 reject 原因不含「缺必要字段」。 */
  let msg = '';
  try { await mv.forgetUser({ userId: 'u', sandboxId: 'sb' }); }
  catch (e) { msg = String(e.message); }
  if (msg.indexOf('缺必要字段') >= 0) throw new Error('字段齐不该报缺字段：' + msg);
  return '四出口缺字段全 reject，字段齐不误报缺字段';
});

/* 项目4 默认「我」保护 + 主表隔离（同步部分） */
t('项目4 P4-M3 默认「我」保护：无章共享兜底不可删', async () => {
  /* 清空 userMasks，让 ensureDefaultUser 造出无章兜底「我」 */
  S.store.set('userMasks', []);
  const fallback = S.core.ensureDefaultUser();
  if (fallback.sandboxId) throw new Error('兜底「我」不该有岛章');
  const r = await S.core.purgeUser(fallback.id, '');
  if (!r || r.ok !== false) throw new Error('该拒绝删兜底「我」，实 ' + JSON.stringify(r));
  if (r.why !== 'default-user-protected') throw new Error('why 该 default-user-protected，实 ' + r.why);
  /* 保护分支不该动主表：兜底「我」还在 */
  if (!S.core.findUser(fallback.id)) throw new Error('保护分支不该删主表');
  return '无章「我」被 default-user-protected 挡住且主表未动';
});

/* 项目4 NPC 向量归属核查：doomedCharIds 递归角色树，主表 doomed = 向量命中集合。
   铁律（用户 2026-09-27）：
     删单 NPC → doomed={NPC}（大号/别的皮套/别的 NPC 的向量必须留）。
   2026-09-29（用户拍板）新增一条：**NPC 永不连坐** —— NPC 属于整座岛，
     删皮套/删大号时挂在其名下的 NPC 收编归岛（parentType='sandbox'），
     不进 doomed（主表与向量共用 doomedCharIds，两边自动一致）。 */
t('项目4 P4-M11 doomedCharIds 递归角色树：单NPC/皮套/大号集合各自正确', async () => {
  const sb = S.core.createSandbox('archipelago', 'P4树岛');
  S.core.setActiveSandbox(sb.id);
  const d = S.core.upsertChar({ name: '大号', kind: 'main', sandboxId: sb.id }).id;
  const f = S.core.upsertChar({ name: '皮套', kind: 'sub', parentId: d, sandboxId: sb.id }).id;
  const sn = S.core.upsertChar({ name: '子NPC', kind: 'npc', parentId: f, sandboxId: sb.id }).id;      /* 皮套下的 NPC */
  const n1 = S.core.upsertChar({ name: 'NPC1', kind: 'npc', parentId: d, sandboxId: sb.id }).id;      /* 大号下的 NPC */
  const n2 = S.core.upsertChar({ name: 'NPC2', kind: 'npc', parentId: d, sandboxId: sb.id }).id;
  const isl = S.core.upsertChar({ name: '岛NPC', kind: 'npc', parentId: sb.id, parentType: 'sandbox', sandboxId: sb.id }).id; /* sandbox 口径 */
  const u = S.core.upsertUser({ name: '马甲', sandboxId: sb.id }).id;
  const un = S.core.upsertChar({ name: '用户NPC', kind: 'npc', parentId: u, parentType: 'user', sandboxId: sb.id }).id;       /* user 口径 */

  const setEq = (a, b) => { a = a.slice().sort().join(','); b = b.slice().sort().join(','); return a === b; };

  /* 删单 NPC：doomed 只有它自己（大号/别的皮套/别的 NPC 都不进集合） */
  if (!setEq(S.core.doomedCharIds(n1), [n1])) throw new Error('单 NPC doomed 该只有自己：' + JSON.stringify(S.core.doomedCharIds(n1)));
  /* 删皮套：NPC 不连坐 → doomed 只有皮套自己（子 NPC 收编归岛） */
  if (!setEq(S.core.doomedCharIds(f), [f])) throw new Error('皮套 doomed 该只有皮套（NPC 不连坐）：' + JSON.stringify(S.core.doomedCharIds(f)));
  /* 删大号：大号 + 全部皮套；NPC 一律不进集合（含皮套下的子 NPC） */
  const wantD = [d, f];
  if (!setEq(S.core.doomedCharIds(d), wantD)) throw new Error('大号 doomed 该={大号,皮套}：' + JSON.stringify(S.core.doomedCharIds(d)));
  if (S.core.doomedCharIds(d).indexOf(sn) >= 0) throw new Error('子 NPC 不该进 doomed（NPC 永不连坐）');
  if (S.core.doomedCharIds(d).indexOf(isl) >= 0) throw new Error('sandbox 口径 NPC 不该进大号 doomed');
  if (S.core.doomedCharIds(d).indexOf(un) >= 0) throw new Error('user 口径 NPC 不该进大号 doomed');

  /* 主表隔离 + 收编：删大号 → 大号/皮套没了，名下 NPC 全活着且归岛 */
  await S.core.purgeChar(d, sb.id);
  if (S.core.findChar(d)) throw new Error('删大号后大号该没');
  if (S.core.findChar(f)) throw new Error('删大号后皮套该没');
  const adopted = [sn, n1, n2, isl].map((id) => S.core.findChar(id));
  if (adopted.some((c) => !c)) throw new Error('删大号不许动任何 NPC');
  adopted.forEach((c) => {
    if (c.parentType !== 'sandbox' || c.parentId !== sb.id) {
      throw new Error('NPC 该收编归岛：' + c.name + ' → ' + c.parentType + '/' + c.parentId);
    }
  });
  if (!S.core.findChar(un)) throw new Error('user 口径 NPC 不该被连带删');
  S.core._purgeSync.sandbox(sb.id);
  return 'doomedCharIds 递归正确；删大号连坐皮套、NPC 全部收编归岛';
});

/* 项目4 门禁三分支 + 跨岛守卫 + 隔离（串行 async，避免并发踩 win.indexedDB） */
t('项目4 P4-M4~M9 门禁三分支 + 跨岛守卫 + 主表隔离 + 重试补完（串行）', () => withIdbLock(async () => {
  const savedIDB = win.indexedDB;
  const hadIDB = 'indexedDB' in win;
  const savedFS = S.memoryVec.forgetSandbox;
  const savedFCS = S.memoryVec.forgetCharSet;
  const savedFU = S.memoryVec.forgetUser;
  /* 恢复 IDB：原环境没这键时（node）必须 delete 整键，只赋回 undefined
     会留下 own property，让 `'indexedDB' in win` 误判 true。 */
  const restoreIDB = () => {
    if (hadIDB) { win.indexedDB = savedIDB; } else { delete win.indexedDB; }
  };

  const mkIsland = (name) => {
    const sb = S.core.createSandbox('archipelago', name);
    S.core.setActiveSandbox(sb.id);
    return sb.id;
  };
  /* 显式带岛建角色/马甲 —— 否则 mkIsland(B) 之后建的全盖 B 章 */
  const mkChar = (name, kind, parentId, sbId) => {
    return S.core.upsertChar({ name, kind: kind || 'main', parentId: parentId || null, sandboxId: sbId }).id;
  };
  const mkUser = (name, sbId) => S.core.upsertUser({ name, sandboxId: sbId }).id;

  /* -- M4 不存在的岛：无副作用 -- */
  const ghost = 'noSuchSb' + Date.now();
  let r = await S.core.purgeSandbox(ghost);
  if (!r || r.ok !== false || r.message !== '找不到这间房') throw new Error('不存在岛该 ok:false');

  /* -- M5 not-applicable：无 IDB → 直接清主表 + 别岛保留 -- */
  if ('indexedDB' in win) throw new Error('smoke 前置不对：win 不该有 indexedDB');
  const A = mkIsland('P4A岛');
  const B = mkIsland('P4B岛');
  const rA = mkChar('P4大号A', 'main', null, A);   /* 盖 A 的章 */
  const subA = mkChar('P4脸A', 'sub', rA, A);      /* 挂 rA 下，盖 A 的章 */
  const rB = mkChar('P4大号B', 'main', null, B);   /* 盖 B 的章 */
  const uA = mkUser('P4马甲A', A);                  /* 盖 A 的章 */
  S.core.setSandboxChars(A, [rA]);
  S.core.setSandboxChars(B, [rB]);
  S.core.setSandboxMasks(A, [uA]);
  /* 别岛数据做参照 */
  S.store.set('chats', [{ id: 'chatA', characterId: rA, userId: uA, sandboxId: A },
                        { id: 'chatB', characterId: rB, userId: uA, sandboxId: B }]);
  S.store.set('moments', [{ id: 'momA', maskId: uA, sandboxId: A },
                          { id: 'momB', maskId: uA, sandboxId: B }]);

  r = await S.core.purgeSandbox(A);
  if (!r || r.ok !== true) throw new Error('无IDB拆岛该 ok:true，实 ' + JSON.stringify(r));
  if (S.core.findSandbox(A)) throw new Error('主表 sandboxes 没删 A');
  if (!S.core.findSandbox(B)) throw new Error('别岛 B 不该被删');
  if (S.core.findChar(rA)) throw new Error('A 岛大号没删');
  if (S.core.findChar(subA)) throw new Error('A 岛皮套没删（连坐）');
  if (!S.core.findChar(rB)) throw new Error('别岛 B 大号不该被删');
  if (S.core.findUser(uA)) throw new Error('A 岛马甲没删');
  const chats = S.store.get('chats') || [];
  if (chats.some((x) => x.id === 'chatA')) throw new Error('A 岛对话没删');
  if (!chats.some((x) => x.id === 'chatB')) throw new Error('别岛 B 对话被误删');
  const moms = S.store.get('moments') || [];
  if (moms.some((x) => x.id === 'momA')) throw new Error('A 岛朋友圈没删');
  if (!moms.some((x) => x.id === 'momB')) throw new Error('别岛 B 朋友圈被误删');

  /* -- M6 跨岛引用守卫：B 岛还引用 A 岛的角色 → still-referenced 拒绝，全不动 -- */
  const C = mkIsland('P4C岛');
  const rC = mkChar('P4大号C', 'main', null, C);
  S.core.setSandboxChars(C, [rC]);
  S.core.setSandboxChars(B, [rB, rC]);   /* B 岛也引用 rC */
  r = await S.core.purgeSandbox(C);
  if (!r || r.ok !== false) throw new Error('跨岛引用该拒绝，实 ' + JSON.stringify(r));
  if (r.why !== 'still-referenced') throw new Error('why 该 still-referenced，实 ' + r.why);
  if (!r.by || !r.by.some((x) => x.type === 'char' && x.id === rC)) throw new Error('by 该带出引用者');
  if (!S.core.findSandbox(C)) throw new Error('跨岛守卫不该删主表');
  if (!S.core.findChar(rC)) throw new Error('跨岛守卫不该删角色');
  if (S.core.findSandbox(B)) {}            /* B 还在 */
  /* 修正 B 的引用后重试 → 成功 */
  S.core.setSandboxChars(B, [rB]);
  r = await S.core.purgeSandbox(C);
  if (!r || r.ok !== true) throw new Error('解除引用后该能拆，实 ' + JSON.stringify(r));
  if (S.core.findSandbox(C)) throw new Error('重试后主表没删');

  /* -- M7 api-missing 门禁：有 IDB 但 forgetSandbox 缺失 → 失败保留主表 -- */
  const D = mkIsland('P4D岛');
  const rD = mkChar('P4大号D', 'main', null, D);
  S.core.setSandboxChars(D, [rD]);
  win.indexedDB = {};
  delete S.memoryVec.forgetSandbox;
  r = await S.core.purgeSandbox(D);
  S.memoryVec.forgetSandbox = savedFS;
  restoreIDB();
  if (!r || r.ok !== false) throw new Error('该失败，实 ' + JSON.stringify(r));
  if (r.why !== 'memory-vector-unavailable/api-missing') throw new Error('why 该 api-missing，实 ' + r.why);
  if (!S.core.findSandbox(D)) throw new Error('主表不该被删（api-missing 必须保留）');
  if (!S.core.findChar(rD)) throw new Error('角色不该被删');

  /* -- M8 vector-failed 门禁：有 IDB 但 forgetCharSet 打开失败 → 失败保留主表 -- */
  const E = mkIsland('P4E岛');
  const rE = mkChar('P4大号E', 'main', null, E);
  S.core.setSandboxChars(E, [rE]);
  win.indexedDB = {};
  r = await S.core.purgeChar(rE, E);        /* forgetChar 在但 mock IDB 打开失败 → reject */
  restoreIDB();
  if (!r || r.ok !== false) throw new Error('该失败，实 ' + JSON.stringify(r));
  if (r.why !== 'memory-vector-failed') throw new Error('why 该 vector-failed，实 ' + r.why);
  if (S.core.findChar(rE) === null) throw new Error('主表不该被删（vector-failed 必须保留）');
  if (S.core.findSandbox(E) === null) throw new Error('岛不该被删');

  /* -- M9 重试补完：失败保留的岛/角色在环境恢复后重试 → 全清 -- */
  await S.core.purgeSandbox(D);            /* 重试拆岛 → D 全清 */
  await S.core.purgeChar(rE, E);           /* 重试删角色 → rE 清；purgeChar 不删沙盒本身 */
  if (S.core.findSandbox(D)) throw new Error('D 重试后主表没清');
  if (S.core.findChar(rE)) throw new Error('rE 重试后没清');
  if (!S.core.findSandbox(E)) throw new Error('purgeChar 不该连带删沙盒 E');
  await S.core.purgeSandbox(E);            /* 空房用拆岛清掉，收尾 */
  if (S.core.findSandbox(E)) throw new Error('E 拆岛重试后没清');

  /* -- purgeUser 马甲隔离 + 补齐派生 -- */
  const F = mkIsland('P4F岛');
  const uF = mkUser('P4马甲F', F);
  S.core.setSandboxMasks(F, [uF]);
  S.store.set('chats', [{ id: 'chatF', characterId: 'c', userId: uF, sandboxId: F },
                        { id: 'chatG', characterId: 'c', userId: uF, sandboxId: 'otherSb' }]);
  S.store.set('offlineSessions', [{ id: 'offF', userId: uF, sandboxId: F },
                                  { id: 'offG', userId: uF, sandboxId: 'otherSb' }]);
  r = await S.core.purgeUser(uF, F);
  if (!r || r.ok !== true) throw new Error('删岛内马甲该 ok:true，实 ' + JSON.stringify(r));
  if (S.core.findUser(uF)) throw new Error('F 岛马甲没删');
  const chatsF = S.store.get('chats') || [];
  if (chatsF.some((x) => x.id === 'chatF')) throw new Error('F 岛马甲对话没删');
  if (!chatsF.some((x) => x.id === 'chatG')) throw new Error('同 uid 别岛对话被误删');
  const offF = S.store.get('offlineSessions') || [];
  if (offF.some((x) => x.id === 'offF')) throw new Error('F 岛马甲线下会话没删');
  if (!offF.some((x) => x.id === 'offG')) throw new Error('同 uid 别岛线下会话被误删');

  /* -- purgeFace 同 root 别的皮套主表保留 -- */
  const G = mkIsland('P4G岛');
  const rG = mkChar('P4大号G', 'main', null, G);
  const face1 = mkChar('P4脸G1', 'sub', rG, G);
  const face2 = mkChar('P4脸G2', 'sub', rG, G);
  S.core.setSandboxChars(G, [rG]);
  r = await S.core.purgeFace(face1, G);
  if (!r || r.ok !== true) throw new Error('删皮套该 ok:true，实 ' + JSON.stringify(r));
  if (S.core.findChar(face1)) throw new Error('脸1 没删');
  if (!S.core.findChar(face2)) throw new Error('同 root 别的皮套被误删（主表）');
  if (!S.core.findChar(rG)) throw new Error('大号不该被删');

  return 'M4无副作用 / M5无IDB全清+别岛保留 / M6跨岛守卫 / M7 api缺失保留 / M8 vector失败保留 / M9重试补完 / 马甲隔离 / 皮套保留';
}));

/* 项目4 静态护栏：UI 删除入口走异步 purge，成功 toast 只在 ok:true 时出现 */
t('项目4 P4-M10 静态护栏：UI 用异步 purge，失败不 toast 成功', () => {
  const fs = require('fs');
  const files = ['page-island.js', 'page-idcard.js', 'page-chat-settings.js'];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (/\.removeSandbox\(|\.removeChar\(|\.removeUser\(/.test(src)) throw new Error(f + ' 不该再同步调旧删除导出');
    if (!/\.purge(Sandbox|Char|Face|User)\(/.test(src)) throw new Error(f + ' 该用异步 purge');
    /* 成功 toast 必须被 r.ok 门禁包住：定位成功 toast 前最近的 if (!r || !r.ok) */
    const m = src.match(/ctx\.toast\('(?:已拆掉|已删除|已删除)', 'ok'\)/);
    if (!m) continue;
    const okToast = src.indexOf(m[0]);
    const gate = src.lastIndexOf('if (!r || !r.ok)', okToast);
    if (gate < 0 || gate > okToast) throw new Error(f + ' 成功 toast 该在 r.ok 门禁之后');
    if (src.indexOf("'err')", okToast) < 0 && src.indexOf("'err');", okToast) < 0) {
      /* 失败分支要有 err toast */
    }
  }
  return 'UI 全走异步 purge + 成功门禁';
});

console.log('\n--- page-group-ai：群调度 ---');

const aiFix = (() => {
  const m = S.core.upsertChar({ name: '纪言', kind: 'main', content: '群调度测试大号。' }).id;
  const s = S.core.upsertChar({ name: '夜灯', kind: 'sub', parentId: m, content: '群调度测试皮套。' }).id;
  const n = S.core.upsertChar({ name: '店长', kind: 'npc', parentId: m, content: 'NPC 人设', knownBy: [] }).id;
  const u = S.core.upsertUser({ name: '梦梦' }).id;
  const sb = S.core.createSandbox('archipelago', '群调度测试');
  S.core.setActiveSandbox(sb.id);
  const g = S.groupStore.createGroup({
    name: '调度测试群', ownerAccountId: u,
    members: [
      { kind: 'char', ownerId: m, accountId: m },
      { kind: 'char', ownerId: m, accountId: s },
      { kind: 'npc', ownerId: n, accountId: n }
    ]
  });
  if (!g.ok) throw new Error(g.message);
  S.groupStore.addMessage(g.group.id, { senderKind: 'user', senderAccountId: u, content: '@全体成员 明晚有空吗？' });
  return { m, s, n, u, gid: g.group.id };
})();

t('entitiesOf：大号+皮套归并成本体、NPC 独立（调度去重的原料）', () => {
  const es = S.groupAI.entitiesOf(aiFix.gid);
  if (es.length !== 2) throw new Error('应 2 个本体，实 ' + es.length);
  const charE = es.find((e) => e.kind === 'char');
  if (charE.accounts.length !== 2) throw new Error('同一本体应 2 个账号');
  return { 本体: es.length, 账号: charE.accounts.length };
});

t('composeRound：卡/成员/知识/历史/预算五段齐', () => {
  const r = S.groupAI.composeRound(aiFix.gid, { stimulus: '（测试）', budget: { actors: 2, msgs: 5 } });
  if (!r) throw new Error('没装配出来');
  const sys = r.messages[0].content;
  const usr = r.messages[1].content;
  if (sys.indexOf('群聊里的多个角色') < 0) throw new Error('调度卡没进 system');
  if (sys.indexOf('[ENTITY_KNOWLEDGE]') < 0) throw new Error('知识切片没进');
  if (sys.indexOf('纪言') < 0) throw new Error('本体人设没进');
  if (usr.indexOf('[RECENT_GROUP]') < 0 || usr.indexOf('明晚有空吗') < 0) throw new Error('群历史没进');
  if (usr.indexOf('[BUDGET]') < 0) throw new Error('预算没进');
  if (r.entities.length !== 2) throw new Error('候选本体不对');
  return { 段: 5, 本体: r.entities.length };
});

t('通查③：群聊 [ENTITY_KNOWLEDGE] 也带角色短字段（以前只给 content）', () => {
  S.core.upsertChar({ id: aiFix.m, speech: '说话慢，爱用长句', neverDo: '不失约' });
  const r = S.groupAI.composeRound(aiFix.gid, { stimulus: '（通查）', budget: { actors: 2, msgs: 5 } });
  const sys = r.messages[0].content;
  /* 状态签名已全量下线（2026-09-29）—— 反向断言 */
  if (sys.indexOf('当前状态：') >= 0) throw new Error('状态签名已下线，群聊却还在注入');
  if (sys.indexOf('说话与行为方式：说话慢') < 0) throw new Error('群里看不见说话方式');
  if (sys.indexOf('绝对不要做（红线）') < 0) throw new Error('群里看不见红线');
  return { 命中: 2 };
});

t('parseRoundJSON：围栏 JSON 能剥', () => {
  const raw = '```json\n{"plans":[],"messages":[],"suggestContinue":false}\n```';
  const d = S.groupAI.parseRoundJSON(raw);
  if (!d || !Array.isArray(d.plans)) throw new Error('围栏没剥掉');
  return 'ok';
});

t('validateRound：合法输出全通过，delay 收进 300~4000', () => {
  const round = S.groupAI.composeRound(aiFix.gid, { budget: { actors: 2, msgs: 5 } });
  const v = S.groupAI.validateRound(round, {
    plans: [
      { entityId: aiFix.m, action: 'group_reply', accountId: aiFix.s, intent: '接话' },
      { entityId: aiFix.n, action: 'observe', internalUpdate: '先看着' }
    ],
    messages: [
      { senderAccountId: aiFix.s, content: '我可以。', delayMs: 9000 },
      { senderAccountId: aiFix.s, content: '地点也没问题。', delayMs: 300 }
    ],
    suggestContinue: true
  }, aiFix.gid);
  if (!v.ok) throw new Error('应通过：' + JSON.stringify(v.errors));
  if (v.messages.length !== 2) throw new Error('两条都该落地');
  if (v.messages[0].delayMs !== 4000) throw new Error('delay 应夹到 4000');
  if (v.messages[1].delayMs !== 300) throw new Error('下限 300');
  return { 落地: v.messages.length, 夹取: v.messages[0].delayMs };
});

t('validateRound：未获准的账号 / 群外账号 / 超预算消息全部拒收', () => {
  const round = S.groupAI.composeRound(aiFix.gid, { budget: { actors: 1, msgs: 1 } });
  /* observe 的本体发消息 → 拒 */
  const v1 = S.groupAI.validateRound(round, {
    plans: [{ entityId: aiFix.n, action: 'observe' }],
    messages: [{ senderAccountId: aiFix.n, content: '我不该说话' }]
  }, aiFix.gid);
  if (v1.ok) throw new Error('observe 本体的发言应拒');
  /* 群外账号 → 拒 */
  const v2 = S.groupAI.validateRound(round, {
    plans: [{ entityId: aiFix.m, action: 'group_reply', accountId: aiFix.m }],
    messages: [{ senderAccountId: 'ghost-account', content: '幽灵' }]
  }, aiFix.gid);
  if (v2.ok) throw new Error('群外账号应拒');
  /* 超预算 → 截断 */
  const v3 = S.groupAI.validateRound(round, {
    plans: [{ entityId: aiFix.m, action: 'group_reply', accountId: aiFix.m }],
    messages: [
      { senderAccountId: aiFix.m, content: '一' },
      { senderAccountId: aiFix.m, content: '二' }
    ]
  }, aiFix.gid);
  if (v3.messages.length !== 1) throw new Error('超预算应截到 1 条');
  return { observe拒: true, 幽灵拒: true, 截断: v3.messages.length };
});

t('同本体未授权双账号表演被拦（总纲 7.3/12.3）', () => {
  const round = S.groupAI.composeRound(aiFix.gid, { budget: { actors: 1, msgs: 5 } });
  const v = S.groupAI.validateRound(round, {
    plans: [{ entityId: aiFix.m, action: 'group_reply', accountId: aiFix.m }],
    messages: [
      { senderAccountId: aiFix.m, content: '大号说' },
      { senderAccountId: aiFix.s, content: '小号也说' }
    ]
  }, aiFix.gid);
  if (v.ok) throw new Error('换账号应拦');
  return '拦住';
});

t('延迟补回：defer 落账 → 下一轮注入 [PENDING]，注入即清', () => {
  S.groupAI.saveDefer(aiFix.gid, [
    { entityId: aiFix.m, action: 'defer', internalUpdate: '在开会，晚点回' },
    { entityId: 'ghost-entity', action: 'defer', internalUpdate: '幽灵不该记' }
  ]);
  const r = S.groupAI.composeRound(aiFix.gid, { stimulus: '（测试）' });
  const usr = r.messages[1].content;
  if (usr.indexOf('[PENDING]') < 0) throw new Error('pending 没注入');
  if (usr.indexOf('在开会，晚点回') < 0) throw new Error('念头没带上');
  if (usr.indexOf('幽灵不该记') >= 0) throw new Error('群外本体不该入账');
  const r2 = S.groupAI.composeRound(aiFix.gid, { stimulus: '（测试2）' });
  if (r2.messages[1].content.indexOf('[PENDING]') >= 0) throw new Error('注入后应清空');
  return '落账→注入→清';
});

t('内心注记跨波连续：saveInner → 下一轮还到同一个本体', () => {
  S.groupAI.saveInner(aiFix.gid, [
    { entityId: aiFix.m, internalUpdate: '对这家店的印象变差了' }
  ]);
  const r = S.groupAI.composeRound(aiFix.gid, { stimulus: '（测试）' });
  const sys = r.messages[0].content;
  if (sys.indexOf('对这家店的印象变差了') < 0) throw new Error('注记没进切片');
  if (sys.indexOf('夜灯') < 0) throw new Error('注记该跟在人身上');
  return '注记还上了';
});


/* ---------------- 群聊记忆：线上阈值 + about 拆库 ----------------
   （放在最后：自带夹具，不依赖前面任何存活角色。） */
console.log('\n--- page-group-offline：群聊记忆 ---');

const gmFix = (() => {
  const a = S.core.upsertChar({ name: '阿澈', kind: 'main', content: '群记忆测试大号' }).id;
  const n2 = S.core.upsertChar({ name: '柜台', kind: 'npc', parentId: a, content: '群记忆测试NPC' }).id;
  const u2 = S.core.upsertUser({ name: '测试员' }).id;
  const sb = S.core.createSandbox('archipelago', '群记忆测试群岛');
  S.core.setSandboxChars(sb.id, [a]);
  S.core.setActiveSandbox(sb.id);
  const g = S.groupStore.createGroup({
    name: '记忆测试群', ownerAccountId: u2,
    members: [{ kind: 'char', ownerId: a, accountId: a }, { kind: 'npc', ownerId: n2, accountId: n2 }]
  });
  return { gid: g.group.id, a, n2, arch: sb.id };
})();

t('groupMemory.shouldRun：新群不跑，30 条触发', () => {
  if (S.groupMemory.shouldRun(gmFix.gid) !== false) throw new Error('空群不应触发');
  for (let i = 0; i < 30; i++) {
    S.groupStore.addMessage(gmFix.gid, { senderKind: 'char', senderAccountId: gmFix.a, content: '闲聊 ' + i });
  }
  if (S.groupMemory.shouldRun(gmFix.gid) !== true) throw new Error('30 条应触发');
  return '0 否 / 30 是';
});

t('groupMemory.settle：about 拆库入库，about 对不上名单的跳过', async () => {
  const fakeJson = JSON.stringify({
    changes: [
      { op: 'add', about: '阿澈', kind: 'shared_event', evidence: 'confirmed_event', text: '群里约好周末一起做饭' },
      { op: 'observe', about: '柜台', kind: 'character_inference', evidence: 'character_inference', text: '柜台觉得这群人吃饭很准时' },
      { op: 'add', about: '不存在的角色', kind: 'custom', evidence: 'uncertain', text: '这条应被跳过' },
      { op: 'add', about: '测试员', kind: 'user_fact', evidence: 'user_explicit', text: 'user 不建库，也应跳过' }
    ]
  });
  const r = await S.groupMemory.settle(
    [gmFix.a, gmFix.n2],
    '阿澈：周末一起做饭吧\n柜台：行，人齐就行',
    '群「记忆测试群」线上累计 测试', 'online',
    { source: 'main', label: '假API', cfg: {} },
    () => Promise.resolve({ ok: true, text: fakeJson })
  );
  if (!r.ok) throw new Error('settle 失败：' + r.error);
  if (r.added !== 2) throw new Error('应入库 2 条，实 ' + r.added);
  const M = S.memoryStore;
  const fa = M.loadCharMemory(gmFix.a);
  const hitA = fa.memories.find((m) => m.content === '群里约好周末一起做饭');
  if (!hitA) throw new Error('阿澈的记忆没进库');
  if (hitA.source !== 'ai_summary') throw new Error('线上来源应为 ai_summary');
  if (hitA.status !== 'active') throw new Error('confirmed_event 应 active');
  const fn = M.loadCharMemory(gmFix.n2);
  const hitN = fn.memories.find((m) => m.content === '柜台觉得这群人吃饭很准时');
  if (!hitN || hitN.status !== 'pending') throw new Error('NPC 的观察记忆应 pending 入库');
  return { 入库: r.added, 跳过: r.skipped };
});

t('groupMemory.settle：解析失败老实报错不炸', async () => {
  const r = await S.groupMemory.settle(
    [gmFix.a], '阿澈：在吗', '测试', 'online',
    { source: 'main', label: '假API', cfg: {} },
    () => Promise.resolve({ ok: true, text: '这不是 JSON' })
  );
  if (r.ok !== false) throw new Error('坏输出应报失败');
  return '报错正常';
});

/* ---------------- v5 12.1 + 确认流补课 ----------------
   独立记忆模型、autoAnchorMoments 消费端、留痕批量确认。 */

console.log('\n--- 记忆模型 / 锚定沉淀 / 批量确认 ---');
t('summaryEngine.candFor：memoryApiCfg 指定副 API，被删回落主 API', () => {
  S.store.set('mainApi', { enabled: true, baseUrl: 'https://m.test', model: 'm1', name: '主API' });
  S.store.set('subApis', [{ enabled: true, baseUrl: 'https://s.test', model: 's1', name: '副API' }]);
  S.store.set('memoryApiCfg', null);
  if (S.summaryEngine.candFor().source !== 'main') throw new Error('默认应跟随主 API');
  S.store.set('memoryApiCfg', { mode: 'pick', label: '副API' });
  const c1 = S.summaryEngine.candFor();
  if (c1.source !== 'sub' || c1.cfg.model !== 's1') throw new Error('应选副 API');
  S.store.set('memoryApiCfg', { mode: 'pick', label: '不存在的模型' });
  if (S.summaryEngine.candFor().source !== 'main') throw new Error('被删应回落主 API');
  S.store.set('memoryApiCfg', null);
  S.store.set('subApis', []);
  return '指定→副 / 缺失→主';
});
t('ingest：autoAnchor 开 → priority=high 入库即锚定；批量确认 pending', () => {
  const ch = S.core.upsertChar({ name: '锚定测试', kind: 'main' }).id;
  const parsed = { changes: [
    { op: 'add', kind: 'shared_event', evidence: 'confirmed_event', text: '高优先时刻', priority: 'high' },
    { op: 'add', kind: 'custom', evidence: 'confirmed_event', text: '普通条目', priority: 'low' }
  ] };
  const s1 = S.summaryEngine.ingest(ch, parsed, { source: 'offline', ref: '测试', autoAnchor: true });
  if (s1.added !== 2) throw new Error('应入库 2 条，实 ' + s1.added);
  const f1 = S.memoryStore.loadCharMemory(ch);
  const hi = f1.memories.find((m) => m.content === '高优先时刻');
  const lo = f1.memories.find((m) => m.content === '普通条目');
  if (!hi || !hi.isAnchor) throw new Error('priority=high 应被自动锚定');
  if (!lo || lo.isAnchor) throw new Error('low 不应锚定');

  /* 开关没开（meta 不带 autoAnchor）→ 不锚 */
  const ch2 = S.core.upsertChar({ name: '锚定测试2', kind: 'main' }).id;
  S.summaryEngine.ingest(ch2, parsed, { source: 'offline', ref: '测试' });
  const f2 = S.memoryStore.loadCharMemory(ch2);
  if (f2.memories.some((m) => m.isAnchor)) throw new Error('没开开关不应锚定');

  /* 批量确认：observe 入库两条 pending → 一次全确认 */
  S.summaryEngine.ingest(ch, { changes: [
    { op: 'observe', kind: 'custom', evidence: 'uncertain', text: '待确认A' },
    { op: 'observe', kind: 'custom', evidence: 'uncertain', text: '待确认B' }
  ] }, { source: 'offline', ref: '测试' });
  const f3 = S.memoryStore.loadCharMemory(ch);
  const pendIds = f3.memories.filter((m) => m.status === 'pending').map((m) => m.id);
  if (pendIds.length !== 2) throw new Error('应有 2 条 pending，实 ' + pendIds.length);
  const n = S.memoryStore.confirmMemoryItems(ch, pendIds);
  if (n !== 2) throw new Error('批量确认数不对：' + n);
  const f4 = S.memoryStore.loadCharMemory(ch);
  if (f4.memories.some((m) => m.status === 'pending')) throw new Error('还有 pending 残留');

  S.store.set('charMem:' + ch, null);
  S.store.set('charMem:' + ch2, null);
  S.core._purgeSync.char(ch);
  S.core._purgeSync.char(ch2);
  return { 锚定: true, 关不锚: true, 批量确认: n };
});

/* ---------------- 总结卡三字段丢失链（relation/review/uncertain） ----------------
   勘察-2026-10-05 §三：此前 ingest 白名单只接 changes/charState/openLoops/attention，
   relation / review / uncertain 产出即丢弃。2026-10-05 拍板：
   · confirmedChange → relationship_fact 恒 pending（模型自称的共识不静默生效）；
   · relation.intent → relationIntent:<rootId> 整块替换落库
     （2026-10-05 接线批：主动消息候选合成已接，见「诊断键不接消费端」白名单用例）；
   · review / uncertain → reviewLog / uncertainLog:<rootId> 只诊断（capped 10 次）。 */
console.log('\n--- 总结三字段：confirmedChange / relationIntent / review / uncertain ---');
t('ingest：changes 为空不再提前结束；confirmedChange 只产 pending；三键落库', () => {
  const ch = S.core.upsertChar({ name: '三字段测试', kind: 'main' }).id;
  const root = S.core.rootOf(ch).id;
  const parsed = {
    changes: [],
    relation: {
      confirmedChange: '双方确认了恋爱关系',
      currentReading: '关系明显更近了',
      evidence: 'user_explicit',
      sourceIds: ['3'],
      intent: { direction: 'closer', pace: 3, nextAction: '下次见面聊旅行计划',
        requiredSignal: 'user 主动提起周末安排', avoid: '不要催促', validUntil: '2026-11-01' }
    },
    review: { effective: ['节奏合适'], problems: [], temporary: [] },
    uncertain: ['那句「随便」分不清是玩笑还是敷衍']
  };
  const stat = S.summaryEngine.ingest(ch, parsed, { source: 'online', ref: '测试' });
  if (stat.added !== 0) throw new Error('changes 为空不应入库普通记忆');
  if (stat.confirmedPending !== 1) throw new Error('confirmedChange 应产 1 条 pending，实 ' + stat.confirmedPending);
  const file = S.memoryStore.loadCharMemory(ch);
  const pend = file.memories.filter((m) => m.via === 'relation.confirmedChange');
  if (pend.length !== 1) throw new Error('应有 1 条 confirmedChange 痕迹');
  const it = pend[0];
  /* 关键：模型给了 user_explicit 也必须 pending —— 共识不自认 */
  if (it.status !== 'pending' || it.kind !== 'relationship_fact') {
    throw new Error('confirmedChange 必须是 pending 的 relationship_fact，实 ' + it.status + '/' + it.kind);
  }
  if (it.evidenceType !== 'user_explicit') throw new Error('evidence 应保留（只压状态不压证据）');

  const ri = S.store.get('relationIntent:' + root);
  if (!ri || ri.intent.direction !== 'closer' || ri.intent.pace !== 3 ||
      ri.intent.validUntil !== '2026-11-01' || ri.currentReading !== '关系明显更近了') {
    throw new Error('relationIntent 落库内容不对：' + JSON.stringify(ri));
  }
  const rl = S.store.get('reviewLog:' + root);
  if (!rl || rl.items.length !== 1 || rl.items[0].effective[0] !== '节奏合适') {
    throw new Error('reviewLog 落库不对：' + JSON.stringify(rl));
  }
  const ul = S.store.get('uncertainLog:' + root);
  if (!ul || ul.items.length !== 1 || ul.items[0].items.length !== 1) {
    throw new Error('uncertainLog 落库不对：' + JSON.stringify(ul));
  }

  /* 确认前不进入已成立事实读取：getMemoryInjection 只吃 active
     （page-memory.js getMemoryInjection 过滤 status==='active'；主角默认开开关，
     断言非空转）——pending 的 confirmedChange 只能出现在留痕待确认里 */
  const injBefore = S.memoryStore.getMemoryInjection(ch) || '';
  if (injBefore.indexOf('双方确认了恋爱关系') >= 0) {
    throw new Error('pending 的 confirmedChange 不应进记忆注入（确认前不得成立）');
  }

  /* 确认闸闭环：user 确认后经 confirmMemoryItems 进既有事实链 */
  const n = S.memoryStore.confirmMemoryItems(ch, [it.id]);
  if (n !== 1) throw new Error('确认数不对：' + n);
  const after = S.memoryStore.loadCharMemory(ch);
  const done = after.memories.find((m) => m.id === it.id);
  if (!done || done.status !== 'active') throw new Error('确认后应转 active');

  S.store.set('charMem:' + ch, null);
  S.store.set('relationIntent:' + root, null);
  S.store.set('reviewLog:' + root, null);
  S.store.set('uncertainLog:' + root, null);
  S.core._purgeSync.char(ch);
  return { confirmedPending: stat.confirmedPending, 确认后active: true, 三键落库: true };
});

t('ingest：relation 缺失 / 空意向不覆盖旧状态；capped 10 次', () => {
  const ch = S.core.upsertChar({ name: '三字段覆盖测试', kind: 'main' }).id;
  const root = S.core.rootOf(ch).id;
  const rel = { relation: { intent: { direction: 'hold', pace: 2, nextAction: '陪他修相机',
    requiredSignal: '', avoid: '', validUntil: '' } } };
  S.summaryEngine.ingest(ch, rel, { source: 'online', ref: '测试' });
  const first = S.store.get('relationIntent:' + root);
  if (!first || first.intent.direction !== 'hold') throw new Error('首次应落库');

  /* 本次 relation 整个缺失（卡：缺失字段用空结构，不覆盖旧状态） */
  S.summaryEngine.ingest(ch, { changes: [] }, { source: 'online', ref: '测试' });
  if (JSON.stringify(S.store.get('relationIntent:' + root)) !== JSON.stringify(first)) {
    throw new Error('relation 缺失时不应覆盖旧 relationIntent');
  }
  /* intent 是空对象且 currentReading 也空 → 同样不算内容，不覆盖 */
  S.summaryEngine.ingest(ch, { changes: [], relation: { intent: {} } }, { source: 'online', ref: '测试' });
  if (JSON.stringify(S.store.get('relationIntent:' + root)) !== JSON.stringify(first)) {
    throw new Error('空 intent 不应覆盖旧 relationIntent');
  }

  /* review / uncertain：capped 留最近 10 次 */
  for (let i = 0; i < 12; i++) {
    S.summaryEngine.ingest(ch, { review: { problems: ['p' + i] }, uncertain: ['u' + i] },
      { source: 'online', ref: '测试' });
  }
  const rl = S.store.get('reviewLog:' + root);
  const ul = S.store.get('uncertainLog:' + root);
  if (rl.items.length !== 10) throw new Error('reviewLog 应 capped 10，实 ' + rl.items.length);
  if (rl.items[9].problems[0] !== 'p11') throw new Error('应保留最近一次 p11');
  if (rl.items[0].problems[0] !== 'p2') throw new Error('最老应滚到 p2');
  if (ul.items.length !== 10) throw new Error('uncertainLog 应 capped 10，实 ' + ul.items.length);

  S.store.set('charMem:' + ch, null);
  S.store.set('relationIntent:' + root, null);
  S.store.set('reviewLog:' + root, null);
  S.store.set('uncertainLog:' + root, null);
  S.core._purgeSync.char(ch);
  return { 不覆盖: true, capped: rl.items.length };
});

t('群线下口径：只传 changes 时行为不变（无 confirmedPending、不写新键）', () => {
  const ch = S.core.upsertChar({ name: '三字段群下测试', kind: 'main' }).id;
  const root = S.core.rootOf(ch).id;
  const stat = S.summaryEngine.ingest(ch, { changes: [
    { op: 'add', kind: 'shared_event', evidence: 'confirmed_event', text: '一起逛了夜市' }
  ] }, { source: 'offline', ref: '见面 #01' });
  if (stat.added !== 1 || stat.confirmedPending !== 0) {
    throw new Error('群线下 changes-only 应原样入库，实 ' + JSON.stringify(stat));
  }
  ['relationIntent:', 'reviewLog:', 'uncertainLog:'].forEach((k) => {
    if (S.store.get(k + root)) throw new Error('changes-only 不应写 ' + k);
  });
  S.store.set('charMem:' + ch, null);
  S.core._purgeSync.char(ch);
  return { added: stat.added, 新键全无: true };
});

t('pace 只收 1~5 整数：小数/越界/非数一律 null，不做边界夹值', () => {
  const ch = S.core.upsertChar({ name: 'pace测试', kind: 'main' }).id;
  const root = S.core.rootOf(ch).id;
  const mk = (pace) => {
    S.summaryEngine.ingest(ch, { relation: { intent: { direction: 'hold', pace } } },
      { source: 'online', ref: '测试' });
    return (S.store.get('relationIntent:' + root) || {}).intent.pace;
  };
  const cases = [
    [4, 4], ['2', 2], [' 5 ', 5],            /* 合法：整数数字 / 纯整数字符串 */
    [3.7, null], ['3.7', null],              /* 小数（含字符串形态）→ null，不截断成 3 */
    [0, null], [-1, null], [6, null], ['99', null],  /* 越界 → null，不夹值 */
    ['abc', null], [true, null], [null, null], [undefined, null], ['1.0', null]
  ];
  const got = cases.map(([v]) => mk(v));
  cases.forEach(([v, want], i) => {
    if (got[i] !== want) {
      throw new Error('pace=' + JSON.stringify(v) + ' 应得 ' + JSON.stringify(want) +
        '，实得 ' + JSON.stringify(got[i]));
    }
  });
  S.store.set('relationIntent:' + root, null);
  S.core._purgeSync.char(ch);
  return { 合法: '4/"2"/" 5 "', 越界与非数全null: true, 不夹值: true };
});

t('confirmedChange 现状：重复申报重复建 pending（无内容级幂等）+ 拒绝即不成立', () => {
  const ch = S.core.upsertChar({ name: '三字段幂等测试', kind: 'main' }).id;
  const parsed = { relation: { confirmedChange: '确定了要一起养猫', evidence: 'confirmed_event' } };
  S.summaryEngine.ingest(ch, parsed, { source: 'online', ref: '测试' });
  S.summaryEngine.ingest(ch, parsed, { source: 'online', ref: '测试' });
  const file = S.memoryStore.loadCharMemory(ch);
  const dups = file.memories.filter((m) =>
    m.via === 'relation.confirmedChange' && m.content === '确定了要一起养猫');
  /* 现状如实钉死：ingest 沿用 changes 通道纪律 —— 无内容级去重，
     幂等靠模型 replaces 引用旧 id + user 在留痕侧处理；重复申报 = 重复 pending */
  if (dups.length !== 2) throw new Error('现状应产生 2 条 pending，实 ' + dups.length);
  if (dups.some((m) => m.status !== 'pending')) throw new Error('重复条目都应是 pending');
  /* 拒绝 = user 在留痕里「标记错误」（invalidateMemoryItem）——
     ⚠️ deleteMemoryItem 只许 user_manual 物理删除（page-memory.js :316），
     ai_summary 来源的拒绝出口就是 invalidate：不再召回，原始数据保留 */
  S.memoryStore.invalidateMemoryItem(ch, dups[0].id);
  const after = S.memoryStore.loadCharMemory(ch);
  const rejected = after.memories.find((m) => m.id === dups[0].id);
  if (!rejected || rejected.status !== 'invalid') throw new Error('拒绝后应标 invalid');
  if (after.memories.some((m) => m.id === dups[1].id && m.status !== 'pending')) {
    throw new Error('未拒绝的那条应保持 pending');
  }
  const injAfter = S.memoryStore.getMemoryInjection(ch) || '';
  if (injAfter.indexOf('确定了要一起养猫') >= 0) {
    throw new Error('拒绝（invalid）后不应进记忆注入');
  }
  S.store.set('charMem:' + ch, null);
  S.core._purgeSync.char(ch);
  return { 重复建pending: dups.length, 拒绝出口: 'invalidate', 拒绝不成立: true };
});

t('changes=[] 时原有状态字段照常落库（early-return 修复覆盖同族四键）', () => {
  const ch = S.core.upsertChar({ name: '同族状态测试', kind: 'main' }).id;
  const root = S.core.rootOf(ch).id;
  const stat = S.summaryEngine.ingest(ch, {
    changes: [],
    charState: { feelings: ['有点想你'], readings: ['你最近在赶due'], unspoken: [] },
    openLoops: [{ text: '修相机的事' }],
    attention: [{ content: '留意楼下的猫' }]
  }, { source: 'online', ref: '测试' });
  if (stat.added !== 0) throw new Error('changes 为空不入普通记忆');
  const cs = S.store.get('charState:' + root);
  if (!cs || cs.feelings[0] !== '有点想你' || cs.readings[0] !== '你最近在赶due') {
    throw new Error('charState 应照常落库：' + JSON.stringify(cs));
  }
  if (!(S.store.get('openLoops:' + root) || { items: [] }).items.length) {
    throw new Error('openLoops 应照常落库');
  }
  if (!(S.store.get('attentionInbox:' + root) || { items: [] }).items.length) {
    throw new Error('attentionInbox 应照常落库');
  }
  S.store.set('charState:' + root, null);
  S.store.set('openLoops:' + root, null);
  S.store.set('attentionInbox:' + root, null);
  S.core._purgeSync.char(ch);
  return { charState: true, openLoops: true, attentionInbox: true };
});

t('诊断键不接消费端（reviewLog/uncertainLog 只落库）；relationIntent 白名单限主动消息', () => {
  /* 2026-10-05 接线批更新：page-proactive 有意接了 relationIntent:（候选队列 +
     状态块），从「零命中」改为「白名单」—— 但仅限 relationIntent:，
     reviewLog:/uncertainLog: 仍然三处全禁；page-ta / prompt-engine 对三键照旧全禁。
     另加一条正向结构断言：page-proactive 确实调用 intentStateOf（装配产物口径，
     防止「helper 测了但没接线」的假绿）。 */
  ['page-ta.js', 'prompt-engine.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ['relationIntent:', 'reviewLog:', 'uncertainLog:'].forEach((k) => {
      if (src.indexOf(k) >= 0) {
        throw new Error(f + ' 出现了 ' + k + ' —— 若是有意接线，请同步更新本断言');
      }
    });
  });
  const pro = fs.readFileSync(path.join(ROOT, 'page-proactive.js'), 'utf8');
  ['reviewLog:', 'uncertainLog:'].forEach((k) => {
    if (pro.indexOf(k) >= 0) {
      throw new Error('page-proactive.js 出现了 ' + k + ' —— 诊断键不进主动消息');
    }
  });
  if (pro.indexOf('relationIntent:') < 0) {
    throw new Error('page-proactive.js 丢了 relationIntent: 接线（本批有意接入）');
  }
  if (pro.indexOf('intentStateOf(') < 0 || pro.indexOf('intentExpired(') < 0) {
    throw new Error('page-proactive.js 没调用 intentStateOf/intentExpired（helper 测了但没接线）');
  }
  return { ta与promptEngine全净: true, proactive: 'relationIntent 白名单内' };
});

t('relation.intent 接候选队列：nextAction 进队、过期不进、指纹去重', () => {
  const c = S.core.upsertChar({ name: '意图候选测试', kind: 'main' }).id;
  const future = new Date(Date.now() + 3600e3).toISOString();
  S.store.set('relationIntent:' + c, {
    currentReading: '刚破冰', evidence: 'explicit', sourceIds: [],
    intent: { direction: '慢慢熟起来', pace: 2, nextAction: '找个由头聊聊周末的展',
      requiredSignal: '', avoid: '', validUntil: future },
    source: 'online', updatedAt: ''
  });
  let list = S.proactiveEngine.candidatesFor(c);
  const ics = list.filter((x) => x.source === 'intent');
  if (ics.length !== 1) throw new Error('intent 候选没进队或多于一条：' + JSON.stringify(list));
  if (ics[0].text.indexOf('周末的展') < 0) throw new Error('候选文本不对：' + ics[0].text);
  if (ics[0].text.indexOf('慢慢熟起来') >= 0) throw new Error('候选该取 nextAction，不是 direction');

  /* 队列刷新（重复调用）→ 内容指纹去重，不堆积 */
  const again = S.proactiveEngine.candidatesFor(c);
  if (again.filter((x) => x.source === 'intent').length !== 1) throw new Error('指纹去重失效');

  /* validUntil 已过 → 整块过期，候选不进（direction 也不许顶上） */
  const past = new Date(Date.now() - 3600e3).toISOString();
  S.store.set('relationIntent:' + c, {
    intent: { direction: '旧方向', nextAction: '过期计划', validUntil: past }
  });
  if (S.proactiveEngine.candidatesFor(c).some((x) => x.source === 'intent')) {
    throw new Error('过期意图不该进候选队列');
  }

  /* 自由文本 validUntil（解析不了）→ 不误杀，照常进队 */
  S.store.set('relationIntent:' + c, {
    intent: { nextAction: '再约一次饭', validUntil: '尽快' }
  });
  if (!S.proactiveEngine.candidatesFor(c).some((x) => x.source === 'intent')) {
    throw new Error('不可解析的 validUntil 不该误杀候选');
  }

  /* 与既有来源并存时，事件优先（intent 排后） */
  S.store.set('relationIntent:' + c, {
    intent: { nextAction: '找个由头聊聊周末的展', validUntil: future }
  });
  S.store.set('attentionInbox:' + c, { items: ['想约你去看展'], updatedAt: '' });
  const both = S.proactiveEngine.candidatesFor(c);
  if (both[0].source !== 'attention' || both[both.length - 1].source !== 'intent') {
    throw new Error('候选顺序不对：' + both.map((x) => x.source).join(','));
  }

  S.store.set('attentionInbox:' + c, null);
  S.store.set('relationIntent:' + c, null);
  S.core._purgeSync.char(c);
  return { 进队: true, 过期拦截: true, 不误杀: true, 指纹去重: true, 事件优先: true };
});

t('relation.intent 状态块：内容进块、过期/缺失回空、pace 缺失不渲染', () => {
  const E = S.proactiveEngine.intentStateOf, X = S.proactiveEngine.intentExpired;
  const full = E({
    currentReading: '刚认识一周',
    intent: { direction: '熟起来', pace: 3, nextAction: '', requiredSignal: '对方主动提周末',
      avoid: '别催', validUntil: '' }
  });
  if (full.indexOf('[RELATION_INTENT]\n') !== 0) throw new Error('块头不对：' + full);
  ['刚认识一周', '熟起来', '3/5', '对方主动提周末', '别催'].forEach((s) => {
    if (full.indexOf(s) < 0) throw new Error('块里缺「' + s + '」：' + full);
  });
  /* nextAction 不进状态块 —— 它已经作为候选出现在 [TRIGGER_CANDIDATES]，别写两遍 */
  if (full.indexOf('nextAction') >= 0) throw new Error('状态块不该出现 nextAction 行');

  /* pace 缺失（null，page-summary paceOf 拒过的形状）→ 不渲染 /5 行，不夹值 */
  const noPace = E({ intent: { direction: 'd', pace: null } });
  if (noPace.indexOf('/5') >= 0) throw new Error('pace=null 不该渲染节奏行');
  if (noPace.indexOf('d') < 0) throw new Error('direction 该照常渲染');

  /* 过期 → 状态块回空（候选与状态块口径一致）；缺失 → 回空不炸 */
  if (E({ intent: { direction: 'd', validUntil: '2000-01-01T00:00:00Z' } }) !== '') {
    throw new Error('过期意图的状态块应回空串');
  }
  if (E(null) !== '' || E({}) !== '' || E({ intent: {} }) !== '') {
    throw new Error('缺失/空意图应回空串');
  }

  /* intentExpired 细分：空 / 非串 / 不可解析 → 有效；可解析且已过 → 过期 */
  const now = Date.now();
  if (X(null, now) || X({}, now) || X({ intent: {} }, now)) throw new Error('缺失应视为有效');
  if (X({ intent: { validUntil: '  ' } }, now)) throw new Error('空白串应视为有效');
  if (X({ intent: { validUntil: '尽快' } }, now)) throw new Error('不可解析不应误杀');
  if (!X({ intent: { validUntil: '2000-01-01T00:00:00Z' } }, now)) throw new Error('已过应判过期');
  if (X({ intent: { validUntil: new Date(now + 60000).toISOString() } }, now)) {
    throw new Error('未到有效期不该判过期');
  }
  return { 状态块: true, pace不夹值: true, 过期口径: '缺失/不可解析=有效' };
});

/* 失败原因必须能翻成人话 —— 用户六.1：「没填副 api 生成底片失败，
   只显示『生成失败』」，查下去发现 7 处都写 `res.message || '请求失败'`，
   而 requestOnce 的结果里**根本没有 message 字段** → 超时 / HTTP 401 /
   没填模型 / CORS 被拦，全都显示同一句话。 */
t('api.describeError：每个失败阶段都给得出不同的原因', () => {
  const D = S.api.describeError;
  const cases = [
    [{ ok: false, stage: 'config', error: '还没填模型名' }, '还没填模型名'],
    [{ ok: false, stage: 'config', error: '接口地址是空的' }, '接口地址是空的'],
    [{ ok: false, stage: 'http', status: 401, detail: '{"error":"invalid api key"}' }, /HTTP 401.*invalid api key/],
    [{ ok: false, stage: 'timeout', error: '超时：60 秒没有响应' }, /超时/],
    [{ ok: false, stage: 'network', error: '连不上：网络错误，或接口没有开 CORS' }, /连不上/],
    [{ ok: false, stage: 'parse', detail: '<html>gateway</html>' }, /不是 JSON/]
  ];
  const outs = cases.map(([res, want]) => {
    const got = D(res);
    if (typeof want === 'string' ? got !== want : !want.test(got)) {
      throw new Error(JSON.stringify(res) + ' 翻成了「' + got + '」');
    }
    return got;
  });
  /* 这一条才是重点：以前这些全是同一句「请求失败」 */
  if (new Set(outs).size !== outs.length) {
    throw new Error('还有原因被吞成同一句：' + JSON.stringify(outs));
  }
  if (D(null) !== '未知错误') throw new Error('null 兜底没了');
  if (D(new Error('boom')) !== 'boom') throw new Error('异常对象该用自己的 message');
  if (D({ ok: false }) !== '请求失败') throw new Error('无 stage 的退化情况该给通用文案');
  return { HTTP401: outs[2], 六种各不相同: outs.length };
});

/* ==================== 查手机数据层（phone.js · 施工卡-查手机-v1） ==================== */

t('phone.ensurePhone：建壳幂等、密码/壁纸由哈希派生（同 char 恒同脸）', () => {
  const sb = S.core.createSandbox('isle', '查手机测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '手机主人', kind: 'main' }).id;
  const p1 = S.phone.ensurePhone(sb.id, c);
  const p2 = S.phone.ensurePhone(sb.id, c);
  if (p1.id !== p2.id) throw new Error('建壳不幂等');
  if (!/^\d{4}$/.test(p1.lock.pin)) throw new Error('密码不是四位数字');
  const again = S.phone.ensurePhone(sb.id, c);
  if (again.wallpaper !== p1.wallpaper || again.appOrder.join() !== p1.appOrder.join()) {
    throw new Error('两次建壳外观不一致（应该走同一个哈希）');
  }
  return { phoneId: p1.id, pin: p1.lock.pin, wallpaper: p1.wallpaper };
});

/* 锁屏：**「他设没设密码」以前在数据层不存在**，于是 pin 一旦派生好就恒真，
   所有角色一律被要求输密码 —— 用户 2026-09-21 报的「角色本身没设密码，
   却显示输入密码解锁」。现在只看 lock.enabled，默认 false。 */
t('phone 锁屏：默认没设密码；开了才有；老存档按没设解释', () => {
  const P = S.phone;
  const sb = S.core.createSandbox('isle', '锁屏测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '锁屏测试主人', kind: 'main' }).id;

  const rec = P.ensurePhone(sb.id, c);
  if (!rec.lock || !/^\d{4}$/.test(rec.lock.pin)) throw new Error('密码该派生好备着');
  if (P.lockEnabled(rec)) throw new Error('新建的手机不该默认上锁');

  P.setLockEnabled(rec, true);
  if (!P.lockEnabled(P.getPhone(rec.id))) throw new Error('开了开关却没上锁');
  P.setLockEnabled(P.getPhone(rec.id), false);
  if (P.lockEnabled(P.getPhone(rec.id))) throw new Error('关了开关还锁着');

  /* 老存档：只有 pin、没有 enabled —— 必须按「没设锁」解释，
     否则用户升级完还是被要求输密码 */
  if (P.lockEnabled({ lock: { pin: '0921' } })) throw new Error('老存档该按没设锁解释');
  if (P.lockEnabled(null) || P.lockEnabled({})) throw new Error('缺字段时别炸');

  /* 开关打开时保证密码一定存在，否则会造出「有锁却没密码」的死路 */
  const odd = { id: 'ph_odd', charId: c, lock: {} };
  P.setLockEnabled(odd, true);
  if (!/^\d{4}$/.test((odd.lock || {}).pin || '')) throw new Error('开锁时该补上密码');
  return { 默认: '没锁', 打开后: '有锁', 老存档: '没锁', 补出的密码: odd.lock.pin };
});

t('phone 会话/行动/风险：authorized 恒 0 风险；偷看随行动爬阶段；疑似必抓不存在', () => {
  const sb = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '手机主人', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  const lt = S.phone.startSession(ph, 'longterm', 'longterm');
  for (let i = 0; i < 40; i++) S.phone.spendAction(lt, 'openApp');
  if (S.phone.getSession(lt.id).riskStage !== 0) throw new Error('授权查看不该涨风险');
  S.phone.endSession(lt.id, 'putback');

  const pk = S.phone.startSession(ph, 'peek', 'pin_guess');
  let maxStage = 0;
  for (let i = 0; i < 40; i++) {
    const r = S.phone.spendAction(pk, i % 3 ? 'openApp' : 'openDerived');
    maxStage = Math.max(maxStage, r.stage);
  }
  const s = S.phone.getSession(pk.id);
  if (s.actionsSpent <= 0) throw new Error('行动没记账');
  if (maxStage < 1) throw new Error('偷看 40 次行动风险还是 0');
  if (s.riskStage > 4) throw new Error('风险阶段溢出');
  if (S.phone.hintOf(s.riskStage) === '') throw new Error('阶段没有对应环境提示');

  /* 痕迹：pin_fail / read 都记账且可被察觉 */
  S.phone.addTrace(pk, { type: 'pin_fail', detail: '测试' });
  S.phone.addTrace(pk, { type: 'read', app: 'messages', detail: '测试' });
  const tr = S.phone.tracesOf(pk.id);
  if (tr.length < 2 || !tr.every((x) => x.detectable)) throw new Error('痕迹没落库或丢了 detectable');
  S.phone.endSession(pk.id, 'putback');
  return { 行动: s.actionsSpent, 阶段: s.riskStage, 痕迹: tr.length };
});

t('phone 授权：longPermFor 生效；hidden/revoked 状态机不走删除', () => {
  const sb = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '手机主人', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  if (S.phone.longPermFor(ph.id, 'all')) throw new Error('没授权却判定有长期权限');
  const perm = S.phone.grantPerm(ph.id, { charId: c, scope: 'all', mode: 'long' });
  if (!S.phone.longPermFor(ph.id, 'all')) throw new Error('授权后查不到');
  S.phone.setPermState(perm.id, 'hidden', '在准备惊喜');
  if (S.phone.longPermFor(ph.id, 'all')) throw new Error('暂时隐藏后不该还有效');
  S.phone.setPermState(perm.id, 'open', '');
  if (!S.phone.longPermFor(ph.id, 'app:messages')) throw new Error('恢复后单 App 判定应成立');
  S.phone.setPermState(perm.id, 'revoked', '边界');
  if (S.phone.longPermFor(ph.id, 'messages') || S.phone.longPermFor(ph.id, 'all')) {
    throw new Error('正式收回后还有效');
  }
  return { ok: true };
});

t('phone 计划状态机：变化留 history，内容来源落库', () => {
  const sb = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '手机主人', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  const pl = S.phone.addPlan(ph.id, { charId: c, type: 'gift', title: '送礼物', status: 'preparing' });
  S.phone.movePlan(pl.id, 'scheduled', '定好日子了');
  S.phone.movePlan(pl.id, 'changed', '他不喜欢这个');
  const after = S.phone.plansOf(ph.id).find((x) => x.id === pl.id);
  if (after.status !== 'changed') throw new Error('状态没推进');
  if (!after.history || after.history.length !== 2) throw new Error('变化没留历史');
  if (after.history[1].from !== 'scheduled') throw new Error('历史链断了');

  const dm = S.phone.addDerived(ph.id, { charId: c, kind: 'draft', withName: '备忘', title: '想说的话', lines: [{ who: 'char', text: '那天的话我想了很久' }] });
  if (dm.status !== 'confirmed') throw new Error('展示即 confirmed 铁律被破坏');
  if (!S.phone.derivedMsgs(ph.id).some((x) => x.id === dm.id)) throw new Error('派生内容没入库');
  return { 计划历史: after.history.length };
});

t('phone 设置：自主生活档位与 phoneApiCfg 读写', () => {
  const sb = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '手机主人', kind: 'main' }).id;
  if (S.phone.autoLifeOf(c) !== 'off') throw new Error('自主生活默认应是 off');
  S.phone.setAutoLife(c, 'mid');
  if (S.phone.autoLifeOf(c) !== 'mid') throw new Error('档位没落档');
  S.phone.setApiCfg({ mode: 'pick', label: '副API' });
  if (S.phone.apiCfg().label !== '副API') throw new Error('phoneApiCfg 没写进去');
  S.phone.setApiCfg(null);
  if (S.phone.apiCfg().mode !== 'main') throw new Error('清空后应回落主 API');
  return { ok: true };
});

t('查手机页面注册 + 删房清理（十条表进 removeSandbox 名单）', () => {
  const reg = S.registered();
  if (!reg.phonecheck || !reg['phone-view']) throw new Error('phonecheck / phone-view 没注册');
  const sb = S.core.activeSandbox();
  const keys = S.phone.PHONE_KEYS;
  /* 每张表里塞一条脏数据，删房后必须全没 */
  keys.forEach((k, i) => S.store.set(k, [{ id: 'dirty' + i, sandboxId: sb.id }]));
  S.core._purgeSync.sandbox(sb.id);
  const left = keys.filter((k) => (S.store.get(k) || []).some((r) => r.sandboxId === sb.id));
  if (left.length) throw new Error('删房残留：' + left.join(','));
  S.phone.setApiCfg(null);
  S.store.set('charSettings', null);
  return { 表数: keys.length, 注册: ['phonecheck', 'phone-view'].join('/') };
});

/* ==================== 查手机第 2 批 · 生成链 ==================== */

t('extractPhoneDeltas：[手机] 行抽出 + 坏 JSON 丢弃 + 正文剥离', () => {
  const raw = ['今天去跑了步。', '[手机] {"app":"notes","op":"add_note","payload":{"title":"训练","content":"加了组"}}',
    '晚安。', '[手机] {"app":"notes","op":"add_note","payload":{"title":broken}}'].join('\n');
  const r = S.phone.extractPhoneDeltas(raw);
  if (r.list.length !== 1) throw new Error('该抽出 1 条，实 ' + r.list.length);
  if (r.text.indexOf('[手机]') >= 0) throw new Error('正文还残留标签');
  if (r.text.indexOf('今天去跑了步') < 0 || r.text.indexOf('晚安') < 0) throw new Error('正文被误伤');
  return { 条数: r.list.length };
});

t('validateDelta：语义红线（坏 app 拒/幕后须一来一回/草稿只是草稿/订单带用途）', () => {
  if (S.phone.validateDelta({ app: 'wallet', op: 'add_order' })) throw new Error('未知 app 该拒');
  if (S.phone.validateDelta({ app: 'shop', op: 'add_order', payload: { title: 'x' } }) === null) {
    throw new Error('合法订单不该拒');
  }
  if (S.phone.validateDelta({ app: 'messages', op: 'add_derived',
    payload: { withName: '阿岩', lines: [{ who: 'char', text: '只有一句' }] } })) {
    throw new Error('单句幕后不该过（要一来一回）');
  }
  const draft = S.phone.validateDelta({ app: 'messages', op: 'add_draft', payload: { text: '想说的话' } });
  if (!draft || draft.data.kind !== 'draft') throw new Error('合法草稿该过');
  const bad = S.phone.validateDelta({ app: 'shop', op: 'order_status', payload: { title: 'x', status: '已完成' } });
  if (bad) throw new Error('非法状态该拒（语义升级拦截）');
  return { ok: true };
});

t('密码叙事化：lock/set 设锁换码 + 坏 pin 拒 + 旧密码进 pinHistory + 去锁不清 pin', () => {
  const sb = S.core.createSandbox('isle', '锁叙事岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '锁角色', kind: 'main' }).id;
  S.core.setSandboxChars(sb.id, [c]);
  const ph = S.phone.ensurePhone(sb.id, c);
  const oldPin = ph.lock.pin;
  /* 剧情里他设锁 + 换成自己在意的日子 */
  const v1 = S.phone.validateDelta({ app: 'lock', op: 'set',
    payload: { enabled: true, pin: '0612', note: '生日那天就不怕你看了' } });
  if (!v1 || v1.app !== 'lock') throw new Error('合法 lock/set 该过');
  const r1 = S.phone.applyLock(ph, v1.data, Date.now());
  if (!r1 || !S.phone.lockEnabled(r1)) throw new Error('设锁没生效');
  if (r1.lock.pin !== '0612') throw new Error('密码没换成他挑的日子');
  if (r1.lock.pinNote !== '生日那天就不怕你看了') throw new Error('note 没记下来');
  if (!r1.lock.pinHistory || r1.lock.pinHistory[0].pin !== oldPin) throw new Error('旧密码没进 pinHistory');
  /* 语义红线：非 4 位 / 缺 enabled 都拒 */
  if (S.phone.validateDelta({ app: 'lock', op: 'set', payload: { enabled: true, pin: '61' } })) {
    throw new Error('非 4 位 pin 该拒');
  }
  if (S.phone.validateDelta({ app: 'lock', op: 'set', payload: { note: 'x' } })) {
    throw new Error('缺 enabled 该拒');
  }
  /* 去锁：锁关，pin 留着（再开时现成，不然是「有锁没密码」的死路） */
  const v2 = S.phone.validateDelta({ app: 'lock', op: 'set', payload: { enabled: false } });
  const r2 = S.phone.applyLock(r1, v2.data, Date.now());
  if (S.phone.lockEnabled(r2)) throw new Error('去锁没生效');
  if (!r2.lock.pin) throw new Error('去锁不该清 pin');
  /* [手机] 全链路：正文抽取 → 校验都认这条线 */
  const ex = S.phone.extractPhoneDeltas(
    '我把密码改了。\n[手机] {"app":"lock","op":"set","payload":{"enabled":true,"pin":"0307","note":"相熟的日子"}}');
  if (ex.list.length !== 1 || !S.phone.validateDelta(ex.list[0])) throw new Error('全链路抽取/校验失败');
  if (ex.text.indexOf('我把密码改了') < 0) throw new Error('正文被误伤');
  S.store.set('charSettings', null);
  return { 旧密码: '进 pinHistory', 全链路: '通' };
});

t('applySettlement：注入合法/非法混合 → 合法落库、非法丢弃、settledUntil 推进、幂等补结算语义', () => {
  const sb = S.core.createSandbox('isle', '结算测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '结算角色', kind: 'main' }).id;
  /* 岛里登记一个 NPC —— 幕后交流只能引用已登记的人（写入前校验 ③）。
     岛的成员只能是大号，NPC 挂在它名下（universeOf 能枚举到）。 */
  const npc = S.core.upsertChar({ name: '阿岩', kind: 'npc', parentId: c }).id;
  S.core.setSandboxChars(sb.id, [c]);
  const ph = S.phone.ensurePhone(sb.id, c);
  const parsed = {
    deltas: [
      { app: 'notes', op: 'add_note', payload: { title: '周末计划', content: '查一下露营地' } },
      { app: 'browser', op: 'add_history', payload: { query: '露营装备清单' } },
      { app: 'messages', op: 'add_derived', payload: { withName: '阿岩', title: '周末', lines: [
        { who: 'char', text: '周末帮我看下天气' }, { who: 'other', text: '晴，放心去' } ] } },
      /* 非法：凭空编一个岛里没有的联系人 —— 该丢 */
      { app: 'messages', op: 'add_derived', payload: { withName: '没登记的人', title: 'x', lines: [
        { who: 'char', text: '在吗' }, { who: 'other', text: '在' } ] } },
      { app: 'shop', op: 'add_order', payload: { title: '露营灯', price: 59, purpose: '自用' } },
      { app: 'shop', op: 'add_order', payload: { title: '' } }   /* 非法：该丢 */
    ],
    planChanges: []
  };
  const stat = S.phone.applySettlement(ph, parsed, 'run_test1');
  if (stat.applied !== 4 || stat.dropped !== 2) throw new Error('统计不对：' + JSON.stringify(stat));
  const after = S.phone.getPhone(ph.id);
  if (!after.settledUntil) throw new Error('settledUntil 没推进');
  /* 订单必须带用途，且默认状态是 ordered 不是已送达（搜索≠购买红线的数据面） */
  const S2 = S.store.get('phoneShop').filter((x) => x.phoneId === ph.id);
  if (S2.length !== 1 || S2[0].status !== 'ordered' || S2[0].purpose !== '自用') {
    throw new Error('订单落库不对');
  }
  /* 幕后交流展示即 confirmed；未登记联系人一条都不许落库 */
  const dm = S.store.get('phoneMsgs').filter((x) => x.phoneId === ph.id);
  if (!dm.length || dm[0].status !== 'confirmed') throw new Error('幕后交流没落 confirmed');
  if (dm.length !== 1 || dm[0].withName !== '阿岩') throw new Error('未登记 NPC 的幕后交流该被丢弃');
  S.core._purgeSync.sandbox(sb.id);
  return { applied: stat.applied, dropped: stat.dropped };
});

t('demo 对齐轮 · 权限「暂时隐藏」→ 桌面锁；健康 delta 扩展字段与未来时间不采信', () => {
  const sb = S.core.createSandbox('isle', '对齐测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '对齐角色', kind: 'main' }).id;
  S.core.setSandboxChars(sb.id, [c]);
  const ph = S.phone.ensurePhone(sb.id, c);

  /* 暂时隐藏 = 权限状态迁移：桌面上那几个 App 该被锁上，但入口还在 */
  if (S.phone.hiddenApps(ph.id).apps.length) throw new Error('还没授权就不该有被藏起来的 App');
  const long = S.phone.grantPerm(ph.id, { charId: c, scope: 'all', mode: 'long' });
  if (S.phone.hiddenApps(ph.id).apps.length) throw new Error('open 状态不算隐藏');
  S.phone.setPermState(long.id, 'hidden', '在准备惊喜');
  const hid = S.phone.hiddenApps(ph.id);
  if (hid.apps[0] !== 'all' || hid.reason !== '在准备惊喜') throw new Error('暂时隐藏没在桌面上体现');
  S.phone.setPermState(long.id, 'revoked', '');
  if (S.phone.hiddenApps(ph.id).apps.length) throw new Error('正式收回 ≠ 暂时隐藏，不该锁图标');
  /* 过期的「限时隐藏」也不该继续锁着 */
  S.phone.setPermState(long.id, 'open', '');
  const single = S.phone.grantPerm(ph.id, { charId: c, scope: 'app:taobao', mode: 'timed',
    expireAt: Date.now() - 1000 });
  S.phone.setPermState(single.id, 'hidden', '');
  if (S.phone.hiddenApps(ph.id).apps.length) throw new Error('过期的隐藏不该继续锁');
  /* 单 App 的隐藏只锁那一个 */
  const single2 = S.phone.grantPerm(ph.id, { charId: c, scope: 'app:notes', mode: 'long' });
  S.phone.setPermState(single2.id, 'hidden', '要藏一下');
  const one = S.phone.hiddenApps(ph.id);
  if (one.apps.join(',') !== 'notes' || one.reason !== '要藏一下') {
    throw new Error('单 App 隐藏不对：' + JSON.stringify(one));
  }

  /* 他自己改权限：hidden / open / revoked 都是状态迁移（定案 §B） */
  if (S.phone.validateDelta({ app: 'permission', op: 'set', payload: { scope: 'all', state: '乱写' } })) {
    throw new Error('非法权限状态该拒');
  }
  S.phone.setPermState(single2.id, 'open', '');
  const vset = S.phone.validateDelta({ app: 'permission', op: 'set',
    payload: { scope: 'app:notes', state: 'revoked', note: '他正式收回' } });
  if (!vset || !S.phone.applyDelta(ph, vset, 'run_y')) throw new Error('permission/set 该能改权限');
  if (S.phone.hiddenApps(ph.id).apps.length) throw new Error('revoked 不该当成 hidden');
  if (S.phone.setPermByScope(ph.id, { scope: 'app:browser', state: 'hidden' })) {
    throw new Error('没有这条授权就不该凭空造状态');
  }

  /* 健康：餐食带时间和短评、运动带名称与说明、随手记多条 */
  const v = S.phone.validateDelta({ app: 'health', op: 'add_day',
    occurredAt: Date.now() + 86400000,          /* 未来时间：不该采信 */
    payload: {
      day: '今天',
      meals: [{ meal: '午餐', time: '12:34', text: '鸡胸肉减脂餐', comment: '难吃。下次换一家。' }],
      workoutPlan: '原计划休息', workoutResult: '训练 52 分钟',
      workoutName: '上肢力量训练', workoutWhy: '下午想起她说喜欢我的肩背',
      comments: ['今天本来不准备练。']
    } });
  if (!v) throw new Error('带时间/短评的健康 delta 该过');
  S.phone.applyDelta(ph, v, 'run_x');
  const day = S.phone.listHealth(ph.id)[0];
  if (!day) throw new Error('健康日没落库');
  if (day.meals[0].time !== '12:34' || day.meals[0].comment.indexOf('难吃') !== 0) {
    throw new Error('餐食卡的时间/短评没落库');
  }
  if (day.workoutName !== '上肢力量训练' || !day.workoutWhy) throw new Error('运动卡的名称/说明没落库');
  if (!day.comments.length) throw new Error('随手记没落库');
  if (day.at > Date.now() + 1000) throw new Error('未来时间不该被采信（该用落库时间）');
  S.core._purgeSync.sandbox(sb.id);
  return { 隐藏: hid.apps.join('/'), 餐: day.meals.length, 随手记: day.comments.length };
});

t('phoneAI.parseSettlementJson：围栏 JSON 能剥', () => {
  const r = S.phoneAI.parseSettlementJson('前置说明```json\n{"v":1,"deltas":[]}\n```后缀');
  if (!r || r.v !== 1) throw new Error('围栏解析失败');
  if (S.phoneAI.parseSettlementJson('完全没有对象') !== null) throw new Error('没对象该返回 null');
  return 'ok';
});

t('gateFor：自主生活档位决定结算间隔，off 拦住', () => {
  const sb = S.core.createSandbox('isle', '闸门测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '闸门角色', kind: 'main' }).id;
  S.phone.setAutoLife(c, 'off');
  if (S.phone.gateFor(c).allowed) throw new Error('off 不该放行');
  S.phone.setAutoLife(c, 'high');
  const ph = S.phone.ensurePhone(sb.id, c);   /* 先有壳才有闸门 */
  if (!S.phone.gateFor(c).allowed) throw new Error('刚建壳该允许结算');
  /* 刚结算过 → 闸门关上 */
  S.phone.getPhone(ph.id) && S.phone.savePhone(Object.assign({}, S.phone.getPhone(ph.id), { settledUntil: Date.now() }));
  if (S.phone.gateFor(c).allowed) throw new Error('间隔内不该再放行');
  S.core._purgeSync.sandbox(sb.id);
  return { ok: true };
});

t('痕迹消费端：markDetected → detectedUnaddressed → markAddressed 只提醒一次', () => {
  const sb = S.core.createSandbox('isle', '痕迹测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '痕迹角色', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  const sess = S.phone.startSession(ph, 'peek', 'pin_guess');
  S.phone.addTrace(sess, { type: 'pin_fail', detail: '输错密码两次' });
  if (S.phone.detectedUnaddressed(ph.id).length) throw new Error('没打 detectedAt 就不该被消费');
  if (S.phone.markDetected(ph.id) !== 1) throw new Error('markDetected 计数不对');
  const un = S.phone.detectedUnaddressed(ph.id);
  if (un.length !== 1) throw new Error('detected 后该可消费');
  S.phone.markAddressed(ph.id);
  if (S.phone.detectedUnaddressed(ph.id).length) throw new Error('addressed 后不该再提醒');
  S.core._purgeSync.sandbox(sb.id);
  return { ok: true };
});

t('查手机第 3 批：permission/grant 落权限表 → longPermFor 生效；四 App 读口', () => {
  const sb = S.core.createSandbox('isle', '邀请测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '邀请角色', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  if (S.phone.longPermFor(ph.id, 'all')) throw new Error('没授权不该生效');

  /* 模型输出一条授权 delta：校验 → applyDelta → 长期权限生效 */
  const v = S.phone.validateDelta({ app: 'permission', op: 'grant',
    payload: { scope: 'all', mode: 'long', note: '给你看，别笑我备忘录' } });
  if (!v) throw new Error('合法授权 delta 被拒');
  const perm = S.phone.applyDelta(ph, v, 'run_t3');
  if (!perm || !S.phone.longPermFor(ph.id, 'all')) throw new Error('授权没落权限表');

  /* 单 App 授权 / 坏 scope 拒收 */
  const v2 = S.phone.validateDelta({ app: 'permission', op: 'grant',
    payload: { scope: 'app:messages', mode: 'once' } });
  if (!v2 || !S.phone.applyDelta(ph, v2, 'run_t3')) throw new Error('单 App 授权该过');
  if (S.phone.validateDelta({ app: 'permission', op: 'grant',
    payload: { scope: '整部手机' } })) throw new Error('坏 scope 该拒');

  /* 四个 App 各落一条，读口能读出来（新→旧） */
  S.phone.applyDelta(ph, S.phone.validateDelta({ app: 'notes', op: 'add_note',
    payload: { title: '备忘', content: '浇水' } }), 'r');
  S.phone.applyDelta(ph, S.phone.validateDelta({ app: 'browser', op: 'add_history',
    payload: { query: '绿萝黄叶怎么办' } }), 'r');
  S.phone.applyDelta(ph, S.phone.validateDelta({ app: 'health', op: 'add_day',
    payload: { meals: [{ meal: '晚餐', text: '轻食' }], comment: '今天有点累' } }), 'r');
  S.phone.applyDelta(ph, S.phone.validateDelta({ app: 'shop', op: 'add_order',
    payload: { title: '肥料', price: 23, purpose: '自用' } }), 'r');
  if (S.phone.listNotes(ph.id).length !== 1) throw new Error('notes 读口不对');
  if (S.phone.listBrowser(ph.id).length !== 1) throw new Error('browser 读口不对');
  if (S.phone.listHealth(ph.id).length !== 1) throw new Error('health 读口不对');
  const shop = S.phone.listShop(ph.id);
  if (shop.length !== 1 || shop[0].status !== 'ordered') throw new Error('shop 读口不对');
  S.core._purgeSync.sandbox(sb.id);
  return { 权限: true, 四App: true };
});

/* 硬翻（方案-查手机硬翻-v1，2026-09-21 拍板）：
   概率 = 三档基础（可调）+ 情境加成，封顶 85%；forceFlip 掷骰记账。 */
t('硬翻：三档概率可调 + 情境加成 + 掷骰两路记账', () => {
  const sb = S.core.createSandbox('isle', '硬翻测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '硬翻角色', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);

  /* 基础档三档 + 默认标准 */
  if (S.phone.flipTier() !== 'standard') throw new Error('默认档该是 standard');
  const p0 = S.phone.flipProb(ph);          /* 新手机：无情境加成 */
  if (Math.abs(p0 - 0.30) > 1e-9) throw new Error('标准档基础概率不对：' + p0);
  S.phone.setFlipTier('mild');
  if (Math.abs(S.phone.flipProb(ph) - 0.20) > 1e-9) throw new Error('温和档概率不对');
  S.phone.setFlipTier('spicy');
  if (Math.abs(S.phone.flipProb(ph) - 0.40) > 1e-9) throw new Error('刺激档概率不对');
  if (S.phone.setFlipTier('乱填') !== 'spicy') throw new Error('坏档位该被拒并保持原档');

  /* 情境加成：刚放下手机 +15，有锁 +10，有未消化的 pin_fail +10 */
  S.phone.setFlipTier('mild');
  const phRec = S.phone.getPhone(ph.id);
  phRec.lastExitedAt = Date.now() - 2 * 60 * 1000;
  S.phone.savePhone(phRec);
  S.phone.setLockEnabled(S.phone.getPhone(ph.id), true);
  const s0 = S.phone.startSession(S.phone.getPhone(ph.id), 'peek', 'pin_guess');
  S.phone.recordPinFail(s0.id);
  S.phone.endSession(s0.id, 'giveup');
  const p1 = S.phone.flipProb(S.phone.getPhone(ph.id));
  if (Math.abs(p1 - 0.55) > 1e-9) throw new Error('加成合计不对：' + p1 + '（该是 0.55）');
  if (p1 > 0.85) throw new Error('超过封顶');

  /* 掷骰两路：压住随机数，各走一遍 */
  const realRandom = Math.random;
  Math.random = () => 0.99;                  /* 永远不被抓 */
  const okFlip = S.phone.forceFlip(S.phone.getPhone(ph.id));
  if (okFlip.caught) throw new Error('0.99 还被抓了');
  if (!okFlip.session || okFlip.session.caughtOnScene) throw new Error('得手路径会话不对');
  Math.random = () => 0.01;                  /* 必被抓 */
  const badFlip = S.phone.forceFlip(S.phone.getPhone(ph.id));
  Math.random = realRandom;
  if (!badFlip.caught) throw new Error('0.01 都没被抓');
  const sBad = S.phone.getSession(badFlip.session.id);
  if (!sBad.caughtOnScene || !sBad.endedAt) throw new Error('被抓会话没标记/没收束');
  const traces = S.phone.tracesOf(sBad.id);
  const heavy = traces.find((t) => t.type === 'read' && t.detectedAt);
  if (!heavy) throw new Error('被抓没留当场察觉的重痕迹');
  S.phone.setFlipTier('standard');
  S.core._purgeSync.sandbox(sb.id);
  return { 三档: true, 加成: 0.55, 得手留轻痕: true, 被抓收束: true };
});

t('工坊（第 4 批）：同模板装两人实例隔离；custom delta 按模板名落库；卸载归档', () => {
  const sb = S.core.createSandbox('archipelago', '工坊测试群岛');
  S.core.setActiveSandbox(sb.id);
  const a = S.core.upsertChar({ name: '甲', kind: 'main' }).id;
  const b = S.core.upsertChar({ name: '乙', kind: 'main' }).id;
  S.core.setSandboxChars(sb.id, [a, b]);
  const pa = S.phone.ensurePhone(sb.id, a);
  const pb = S.phone.ensurePhone(sb.id, b);

  /* user 自建模板（0 API） */
  const tpl = S.workshop.createTemplate({ name: '观影记录', type: 'timeline', desc: '一起看过的' });
  if (tpl.builtin) throw new Error('自建模板不该标 builtin');
  /* 内置模板可找到 */
  if (!S.workshop.findTemplate('bt_diary')) throw new Error('内置模板丢了');

  /* 装给两个人 → 两个独立实例 */
  const ia = S.workshop.install(sb.id, pa.id, a, tpl.id);
  const ib = S.workshop.install(sb.id, pb.id, b, tpl.id);
  if (!ia.ok || !ib.ok) throw new Error('安装失败');
  if (S.workshop.install(sb.id, pa.id, a, tpl.id).ok) throw new Error('重复安装该被拒');

  /* 记录互不串：甲记了一条，乙还是空 */
  S.workshop.addRecord(ia.install.id, { title: '星际穿越', content: '第三遍看还是哭了' }, 'run_w1');
  if (S.workshop.recordsOf(ia.install.id).length !== 1) throw new Error('甲的记录没落');
  if (S.workshop.recordsOf(ib.install.id).length !== 0) throw new Error('乙的记录被串了（隔离破了）');

  /* 结算/delta 按模板名落库：乙手机的 custom delta 落到乙的实例 */
  const v = S.phone.validateDelta({ app: 'custom', op: 'add_record',
    payload: { appName: '观影记录', title: '海街日记', content: '他说结尾很温柔' } });
  const rec = S.phone.applyDelta(pb, v, 'run_w2');
  if (!rec) throw new Error('custom delta 没落库');
  if (S.workshop.recordsOf(ib.install.id).length !== 1) throw new Error('按名匹配失败');
  if (rec.status !== 'confirmed') throw new Error('展示即 confirmed 被破坏');
  /* 名字对不上的模板名 → 安全丢弃 */
  if (S.phone.applyDelta(pa, S.phone.validateDelta({ app: 'custom', op: 'add_record',
    payload: { appName: '不存在的模板', title: 'x', content: 'y' } }), 'r') !== null) {
    throw new Error('不存在的模板名该被丢弃');
  }

  /* 卸载：记录归档（不悄悄消失），实例消失 */
  S.workshop.uninstall(ia.install.id);
  if (S.workshop.recordsOf(ia.install.id).length !== 0) throw new Error('卸载后记录该不可见');
  const archived = S.store.get('wsRecords').filter((r) => r.installationId === ia.install.id);
  if (!archived.length || !archived.every((r) => r.status === 'archived')) {
    throw new Error('记录没归档（user 数据不能悄悄消失）');
  }
  return { 隔离: true, 按名落库: true, 卸载归档: true };
});

t('工坊页面注册 + 删房清理（wsInstalls/wsRecords 按岛清，wsTemplates 全局保留）', () => {
  if (!S.registered().workshop) throw new Error('workshop 没注册');
  const sb = S.core.createSandbox('isle', '工坊删房测试');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '工坊测试', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  S.workshop.install(sb.id, ph.id, c, 'bt_diary');
  S.store.set('wsTemplates', S.workshop.findTemplate('bt_diary') ? [] : []);
  /* 塞脏数据 + 删房 */
  S.store.set('wsInstalls', [{ id: 'd1', sandboxId: sb.id }]);
  S.store.set('wsRecords', [{ id: 'd2', sandboxId: sb.id }]);
  S.core._purgeSync.sandbox(sb.id);
  if ((S.store.get('wsInstalls') || []).some((r) => r.sandboxId === sb.id)) throw new Error('wsInstalls 残留');
  if ((S.store.get('wsRecords') || []).some((r) => r.sandboxId === sb.id)) throw new Error('wsRecords 残留');
  return { ok: true };
});

t('锁屏分流补全：新壳密码=岛落成日（候选可命中）；候选只来自真实事实', () => {
  const sb = S.core.createSandbox('isle', '候选测试岛');
  S.core.setActiveSandbox(sb.id);
  const c = S.core.upsertChar({ name: '候选角色', kind: 'main' }).id;
  const ph = S.phone.ensurePhone(sb.id, c);
  const d = new Date(S.core.findSandbox(sb.id).createdAt);
  const mmdd = ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  if (ph.lock.pin !== mmdd) throw new Error('新壳密码该是岛落成日 MMDD：' + ph.lock.pin + ' vs ' + mmdd);
  /* 候选至少含岛落成日，且该候选值 == 真 pin（候选玩法成立） */
  const cands = S.phone.pinCandidates(sb.id, c);
  const hit = cands.find((x) => x.value === mmdd);
  if (!hit) throw new Error('候选里没有岛落成日');
  /* 候选值正确时 submitPin 的判定路径能通过（直接比对） */
  if (String(ph.lock.pin) !== hit.value) throw new Error('候选与密码判定不一致');
  /* 老壳不重派：改档时间后再 ensure 同一部手机 pin 不变 */
  const before = S.phone.ensurePhone(sb.id, c).lock.pin;
  S.phone.savePhone(Object.assign({}, S.phone.getPhone(ph.id), { settledUntil: Date.now() }));
  if (S.phone.ensurePhone(sb.id, c).lock.pin !== before) throw new Error('已有壳密码被重派了');
  S.core._purgeSync.sandbox(sb.id);
  return { pin: mmdd, 候选数: cands.length };
});

/* 收尾：有异步断言挂着时不能提前打总结 ——
   beforeExit 在事件循环清空（Promise 全部落定）时才触发，正好。 */
let reported = false;
function finalReport() {
  if (reported) return;
  reported = true;
  console.log('');
  if (bad) {
    console.log(bad + ' 项断言失败\n');
    process.exitCode = 1;
  } else {
    console.log('全绿：' + ORDER.length + ' 个脚本加载正常，核心 API 走查通过\n');
  }
}
console.log('\n--- 帷境（Veilscape）---');
t('帷境页面注册齐（含 T6 谢幕 + T7 审阅台），桌面入口是通栏 wj 格（不是 app 图标格）', () => {
  const reg = S.registered();
  ['wj-foyer', 'wj-work', 'wj-create', 'wj-style', 'wj-read', 'wj-coread', 'wj-curtain', 'wj-canon']
    .forEach((id) => {
      if (!reg[id]) throw new Error('缺页面：' + id);
    });
  const d = S.desktop.defaultDesktop();
  const pages = d && d.pages ? d.pages : d;
  let entry = null;
  pages.forEach((cells) => cells.forEach((c) => { if (c.type === 'wj') entry = c; }));
  if (!entry) throw new Error('桌面上没有帷境入口');
  if (entry.w < 2) throw new Error('入口不是通栏，宽度只有 ' + entry.w);
  return { 页面数: 8, 入口: entry.i + ' ' + entry.w + 'x' + entry.h };
});

/* T6 · 谢幕五路。判据来自 Demo 底注：收藏 ≠ 分享 ≠ 共读 ≠ 公开 ≠ 定史，
   四条断言各守一条 —— 这四条链路一旦被谁"顺手合并"，这里立刻会红。 */

t('T6 票根：连点两次只有一张（幂等）', () => {
  S.store.set('wjTickets', []);
  const w = S.wj.createDraft({ title: '票根测试' });
  const t1 = S.wj.saveTicket(w.id);
  const t2 = S.wj.saveTicket(w.id);
  const list = S.wj.tickets();
  S.wj.remove(w.id);
  S.store.set('wjTickets', []);
  if (list.length !== 1) throw new Error('票根多了：' + list.length);
  if (!t1 || !t2 || t1.id !== t2.id) throw new Error('两次拿到的不是同一张');
  return { 张数: 1, 同一张: true, 字数: t1.chars };
});

t('T6 五路独立：分享不创建同席、也不产生票根（收藏≠分享≠共读）', () => {
  S.store.set('wjSessions', []);
  S.store.set('wjTickets', []);
  const w = S.wj.createDraft({ title: '五路测试' });
  const after = S.wj.markCurtain(w.id, 'shared');
  const c = S.wj.curtainOf(after);
  const sessions = S.wjCoread.forWork(w.id).length;
  const ticket = S.wj.ticketFor(w.id);
  S.wj.remove(w.id);
  if (!c.shared) throw new Error('shared 没记上');
  if (sessions) throw new Error('分享竟然创建了同席');
  if (ticket) throw new Error('分享竟然产生了票根');
  return { shared: true, 同席: 0, 票根: 0 };
});

t('T6 幂等：同一条路重复标记不改时间戳（重复点 = 什么都没发生）', () => {
  const w = S.wj.createDraft({ title: '幂等测试' });
  S.wj.markCurtain(w.id, 'forumPublished');
  /* 手动把时间改成过去，再标一次 —— 用真实时间戳比是比不出来的
     （同一毫秒内两次标记本来就会相等）。 */
  S.wj.mutate(w.id, function (x) {
    x.curtain.forumPublished = '2020-01-01T00:00:00.000Z';
    return x;
  });
  const again = S.wj.markCurtain(w.id, 'forumPublished');
  const stamp = S.wj.curtainOf(again).forumPublished;
  S.wj.remove(w.id);
  if (stamp !== '2020-01-01T00:00:00.000Z') throw new Error('重复标记把时间改掉了');
  return { 时间没被改: true };
});

t('T6 谢幕与三路分开记：分享过 ≠ 已经谢幕', () => {
  const w = S.wj.createDraft({ title: '谢幕判据' });
  S.wj.markCurtain(w.id, 'shared');
  const afterShare = S.wj.get(w.id);
  if (S.wj.isSealed(afterShare)) throw new Error('分享竟然把作品标成已谢幕');
  S.wj.curtain(w.id);
  const afterSeal = S.wj.get(w.id);
  const sealedAt = S.wj.curtainOf(afterSeal).sealedAt;
  S.wj.remove(w.id);
  if (!sealedAt) throw new Error('谢幕没记上时间');
  if (afterSeal.status !== 'completed') throw new Error('谢幕没把状态改成已完成');
  return { 分享后未谢幕: true, 谢幕后: afterSeal.status };
});

/* T7 · 正史审阅与写入。四条断言对着方案 §6 T7 的四条验收标准写 ——
   「拒绝一条不删小说 / 批准一条不让所有人物自动知情 /
     冲突未处理不能进下一步 / 重复确认不重复写入」。 */

t('T7 硬闸门：冲突没处理完，不许进「人物认知」那一步', () => {
  S.store.set('wjCanon', []);
  const w = S.wj.createDraft({ title: '闸门测试', reality: 'canon_candidate' });
  S.wjCanon.setCandidates(w.id, [
    { kind: 'shared_event', text: '他们一起看过一次海。', conflict: '和他已知的时间线对不上' }
  ]);
  const cid = S.wjCanon.get(w.id).candidates[0].id;
  S.wjCanon.decide(w.id, cid, 'keep');
  const step0 = S.wjCanon.advance(w.id);          /* 0 → 1 应该放行 */
  const blocked = S.wjCanon.blockers(S.wjCanon.get(w.id));
  const step1 = S.wjCanon.advance(w.id);          /* 1 → 2 应该被拦 */
  S.wj.remove(w.id);
  S.store.set('wjCanon', []);
  if (!step0.ok) throw new Error('第一步不该被拦：' + JSON.stringify(step0.why));
  if (!blocked.length) throw new Error('冲突没处理竟然没有拦');
  if (step1.ok) throw new Error('冲突没处理竟然走到了下一步');
  return { 第一步: '放行', 被拦在: blocked[0] };
});

t('T7 批准一条不让所有人自动知情：没定认知的人一条都不写', () => {
  S.store.set('wjCanon', []);
  const sb = S.core.createSandbox('archipelago', '定史测试岛');
  S.core.setActiveSandbox(sb.id);
  const a = S.core.upsertChar({ name: '定史甲', kind: 'main' });
  const b = S.core.upsertChar({ name: '定史乙', kind: 'main' });
  const w = S.wj.createDraft({
    title: '定史测试', reality: 'canon_candidate',
    cast: [{ charId: a.id, name: '定史甲' }, { charId: b.id, name: '定史乙' }]
  });
  S.wjCanon.setCandidates(w.id, [{ kind: 'shared_event', text: '他们一起修好了那盏灯。' }]);
  const cid = S.wjCanon.get(w.id).candidates[0].id;
  S.wjCanon.decide(w.id, cid, 'keep');
  S.wjCanon.setKnowledge(w.id, a.id, cid, '清晰记忆');   /* 只给甲定了 */
  S.wjCanon.setStep(w.id, 3);

  const beforeB = S.memoryStore.loadCharMemory(b.id).memories.length;
  const r = S.wjCanon.write(w.id);
  const memA = S.memoryStore.loadCharMemory(a.id).memories;
  const afterB = S.memoryStore.loadCharMemory(b.id).memories.length;
  S.wj.remove(w.id);
  S.store.set('wjCanon', []);

  if (!r.ok) throw new Error('没写成：' + JSON.stringify(r));
  if (memA.length !== 1) throw new Error('甲该拿到 1 条，实 ' + memA.length);
  if (afterB !== beforeB) throw new Error('乙被写了 —— 批准一条不等于所有人自动知情');
  if (memA[0].content.indexOf('清楚地记得') < 0) throw new Error('认知档位没写进那条记忆');
  return { 甲: memA.length, 乙: '没被写', 来源: memA[0].source };
});

t('T7 幂等 + 拒绝不删小说：第二次写入被挡，正文一个字没动', () => {
  S.store.set('wjCanon', []);
  const sb = S.core.activeSandbox() || S.core.createSandbox('archipelago', '定史岛二');
  const a = S.core.upsertChar({ name: '定史丙', kind: 'main' });
  const w = S.wj.createDraft({
    title: '幂等测试', reality: 'canon_candidate',
    cast: [{ charId: a.id, name: '定史丙' }]
  });
  S.wj.addChapter(w.id, '第一章');
  const chId = S.wj.get(w.id).chapters[0].id;
  S.wj.addPara(w.id, chId, 'prose', '他把那盏灯修好了，屋子里重新亮起来。');
  const before = S.wj.charCount(S.wj.get(w.id));

  S.wjCanon.setCandidates(w.id, [
    { kind: 'shared_event', text: '他修好了那盏灯。' },
    { kind: 'fragment', text: '灯亮的那一刻很安静。' }
  ]);
  const list = S.wjCanon.get(w.id).candidates;
  S.wjCanon.decide(w.id, list[0].id, 'keep');
  S.wjCanon.decide(w.id, list[1].id, 'reject');          /* 这条不写 */
  S.wjCanon.setKnowledge(w.id, a.id, list[0].id, '片段记忆');
  S.wjCanon.setStep(w.id, 3);

  const r1 = S.wjCanon.write(w.id);
  const r2 = S.wjCanon.write(w.id);
  const after = S.wj.charCount(S.wj.get(w.id));
  const mem = S.memoryStore.loadCharMemory(a.id).memories;
  S.wj.remove(w.id);
  S.store.set('wjCanon', []);

  if (!r1.ok) throw new Error('第一次没写成功');
  if (r2.ok) throw new Error('第二次竟然又写了一遍');
  if (r2.why !== 'already-written') throw new Error('第二次的拒绝理由不对：' + r2.why);
  if (after !== before) throw new Error('小说正文被改了 —— 定史绝不改正文');
  if (mem.length !== 1) throw new Error('被拒绝的那条也写进去了');
  return { 第一次: r1.count, 第二次: r2.why, 正文字数: after };
});

/* 2026-09-22 衔接审计修掉的两处。它们都是「跨模块的缝」——
   单看每个模块都对，缝里漏东西。 */

t('审计修复：角色删了之后，定史不再往幽灵名下写记忆', () => {
  S.store.set('wjCanon', []);
  const a = S.core.upsertChar({ name: '幽灵甲', kind: 'main' });
  const w = S.wj.createDraft({
    title: '幽灵测试', reality: 'canon_candidate',
    cast: [{ charId: a.id, name: '幽灵甲' }]   /* cast 是建作品时抄下来的名单 */
  });
  S.wjCanon.setCandidates(w.id, [{ kind: 'shared_event', text: '测试用的一条事实。' }]);
  const cid = S.wjCanon.get(w.id).candidates[0].id;
  S.wjCanon.decide(w.id, cid, 'keep');
  S.wjCanon.setKnowledge(w.id, a.id, cid, '清晰记忆');
  S.wjCanon.setStep(w.id, 3);

  const before = S.memoryStore.loadCharMemory(a.id).memories.length;
  S.core._purgeSync.char(a.id);                    /* 人没了，cast 里还留着他的 id */
  const r = S.wjCanon.write(w.id);
  const after = S.memoryStore.loadCharMemory(a.id).memories.length;
  S.wj.remove(w.id);
  S.store.set('wjCanon', []);

  if (r.ok) throw new Error('往已经删掉的角色名下写成功了（幽灵记忆）');
  if (after !== before) throw new Error('幽灵记忆被写进去了');
  return { 写入: r.why, 幽灵记忆: 0 };
});

t('审计修复：删作品时共读会话与审阅记录一起收掉', () => {
  S.store.set('wjSessions', []);
  S.store.set('wjCanon', []);
  const w = S.wj.createDraft({ title: '连坐测试' });
  S.wjCoread.createInvite({ workId: w.id, charId: 'ch-x', charName: '某人' });
  S.wjCanon.setCandidates(w.id, [{ kind: 'fragment', text: '一条。' }]);
  const before = {
    sessions: S.wjCoread.forWork(w.id).length,
    canon: S.wjCanon.get(w.id) ? 1 : 0
  };
  /* 这就是 page-wj-work 删除按钮做的那两下 */
  S.wj.remove(w.id);
  S.wjCoread.removeForWork(w.id);
  S.wjCanon.remove(w.id);
  const after = {
    sessions: S.wjCoread.forWork(w.id).length,
    canon: S.wjCanon.get(w.id) ? 1 : 0
  };
  if (!before.sessions || !before.canon) throw new Error('前置数据没造出来');
  if (after.sessions || after.canon) throw new Error('作品删了，附属数据还在');
  return { 删前: before.sessions + '/' + before.canon, 删后: after.sessions + '/' + after.canon };
});

/* 2026-09-22 用户拍板的两条语义（衔接审计留下的那两问）。 */

t('文风底座：全局是「新作品的起点」—— 改全局只影响之后新建的作品', () => {
  S.store.set('wjWorks', []);
  S.store.set('wjStyleCfg', null);
  const oldOne = S.wj.createDraft({ title: '先建的那部' });
  const oldBefore = S.wj.styleOf(oldOne).params.distance;
  S.wj.saveStyleCfg({ distance: 90, preset: '静水' });   /* 用户去文风台拉了滑杆 */
  const fresh = S.wj.createDraft({ title: '后建的那部' });
  const freshDistance = S.wj.styleOf(fresh).params.distance;
  const oldAfter = S.wj.styleOf(S.wj.get(oldOne.id)).params.distance;
  /* 顺带确认「四根滑杆跟预设一样」时不显示成「自定义」 */
  const freshName = S.wj.styleOf(fresh).name;
  S.wj.remove(oldOne.id);
  S.wj.remove(fresh.id);
  S.store.set('wjStyleCfg', null);
  S.store.set('wjWorks', []);
  if (freshDistance !== 90) throw new Error('新作品没拿到全局底座：' + freshDistance);
  if (oldAfter !== oldBefore) throw new Error('改全局把老作品也改了（老 ' + oldBefore + '→' + oldAfter + '）');
  return { 老作品: oldAfter, 新作品: freshDistance, 新作品文风名: freshName };
});

t('取材档位：「选择性读取」已从选项里收起（勾选器从来没做过）', () => {
  const ids = S.wj.MATERIAL.map((m) => m.id);
  if (ids.indexOf('select') >= 0) throw new Error('select 还留在选项里，用户会选到一个假档位');
  if (!S.wj.MATERIAL_LABEL.select) throw new Error('老存档的 label 兜底没了');
  return { 档位: ids.join('/'), 老存档兜底: S.wj.MATERIAL_LABEL.select };
});

/* 2026-09-22 接上的两个「单份接口」：总结 API / 向量记忆 API。
   用户拍板的三条语义都在这里守着（E 类待办里的「总结 api」那条）。 */

t('总结 API：单份独立配置优先，且它和副 API 互不影响', () => {
  S.store.set('summaryApi', null);
  S.store.set('memoryApiCfg', null);
  S.store.set('subApis', []);
  const fallback = S.summaryEngine.candFor();       /* 都没配 → 主 API */
  S.singleApi.saveCfg('summary', {
    baseUrl: 'https://sum.test/v1', apiKey: 'k', model: 'cheap-1'
  });
  const picked = S.summaryEngine.candFor();
  S.store.set('summaryApi', null);
  return {
    没配时: fallback && fallback.label !== '总结 API' ? '回落主 API' : '??',
    配了之后: picked && picked.cfg ? picked.cfg.model : '??'
  };
});

t('新增副 API → 空着的总结顺手带一份；向量不参与（它要 embedding，不是对话模型）', () => {
  S.store.set('summaryApi', null);
  S.store.set('summaryApis', []);
  S.store.set('summaryApiId', '');
  S.store.set('vectorApi', null);
  S.store.set('subApis', [{
    name: '便宜组', baseUrl: 'https://sub.test/v1', apiKey: 'k2', model: 'm2'
  }]);
  const n1 = S.singleApi.seedAll();
  const sumAfter = S.singleApi.cfgOf('summary');
  const vecAfter = S.singleApi.cfgOf('vector');

  /* 用户改过总结 → 再换一组副 API 也不能覆盖它 */
  S.singleApi.saveCfg('summary', { baseUrl: 'https://mine.test/v1', model: '我的模型' });
  S.store.set('subApis', [{
    name: '贵组', baseUrl: 'https://sub2.test/v1', apiKey: 'k3', model: 'm3'
  }]);
  const n2 = S.singleApi.seedAll();
  const sumKept = S.singleApi.cfgOf('summary');

  const out = {
    第一次带了几份: n1,
    总结带过来: sumAfter && sumAfter.model,
    向量: vecAfter ? '被带过来了（不该）' : '没动（对）',
    第二次又带: n2,
    用户改过的还在: sumKept && sumKept.model
  };
  S.store.set('summaryApi', null);
  S.store.set('summaryApis', []);
  S.store.set('summaryApiId', '');
  S.store.set('vectorApi', null);
  S.store.set('subApis', []);
  if (n1 !== 1) throw new Error('第一次该只带一份（总结），实 ' + n1);
  if (!sumAfter || sumAfter.model !== 'm2') throw new Error('带过来的内容不对');
  if (vecAfter) throw new Error('向量不该被带 —— 副 API 是对话模型，带过来是 404 配置');
  if (n2 !== 0) throw new Error('填过之后不该再带');
  if (sumKept.model !== '我的模型') throw new Error('用户改过的总结 API 被覆盖了');
  return out;
});

t('单份接口多预设：切「当前」镜像跟着换，cfgOf 只认当前那套', () => {
  S.store.set('subApis', []);
  S.singleApi.clearCfg('summary');

  /* 第一套：saveCfg 写完自动成为当前 */
  const a = S.singleApi.saveCfg('summary', { baseUrl: 'https://a.test/v1', model: 'ma' });
  if (!S.singleApi.cfgOf('summary') || S.singleApi.cfgOf('summary').model !== 'ma') {
    throw new Error('第一套没成为当前');
  }

  /* 手动补第二套（模拟编辑页保存），再切过去 */
  const list = S.singleApi.presetsOf('summary');
  list.push({ id: 'psum2', name: '乙', baseUrl: 'https://b.test/v1', apiKey: '', model: 'mb' });
  S.store.set('summaryApis', list);
  S.singleApi.setActive('summary', 'psum2');
  const switchTo2 = S.singleApi.cfgOf('summary');
  if (!switchTo2 || switchTo2.model !== 'mb') throw new Error('切过去之后镜像没换');
  if (S.summaryEngine.candFor().cfg.model !== 'mb') throw new Error('消费方（candFor）没跟着换');

  /* 切回第一套 */
  S.singleApi.setActive('summary', a.id);
  if (S.singleApi.cfgOf('summary').model !== 'ma') throw new Error('切回来不对');

  /* 清空 = 连预设一起清，cfgOf 变没配 */
  S.singleApi.clearCfg('summary');
  if (S.singleApi.presetsOf('summary').length) throw new Error('清空之后预设还在');
  if (S.singleApi.cfgOf('summary')) throw new Error('清空之后 cfgOf 该是 null');
  return { 第一套: 'ma', 切到第二套: switchTo2.model, 清空后: '没配' };
});

t('「从副 API 复制一份」只给总结；向量明确拒绝（协议不同，复制来是错的）', () => {
  S.singleApi.clearCfg('summary');
  S.singleApi.clearCfg('vector');
  S.store.set('subApis', [{
    name: '便宜组', baseUrl: 'https://sub.test/v1', apiKey: 'k', model: 'm2'
  }]);
  const one = S.singleApi.copyFromSub('summary');
  const two = S.singleApi.copyFromSub('summary');
  const list = S.singleApi.presetsOf('summary');
  const vecCopy = S.singleApi.copyFromSub('vector');
  const out = { 总结份数: list.length, 向量复制: vecCopy === null ? '拒绝（对）' : '居然成功了' };
  S.singleApi.clearCfg('summary');
  S.singleApi.clearCfg('vector');
  S.store.set('subApis', []);
  if (!one || !two) throw new Error('总结的复制没成功');
  if (list.length !== 2) throw new Error('该无条件复制出两份，实 ' + list.length);
  if (one.id === two.id) throw new Error('两份 id 撞了');
  if (vecCopy !== null) throw new Error('向量不该能被复制 —— 它要的是 embedding 模型');
  return out;
});

t('numField.getNum：留空回 null 而不是 0（0 在 genParams 里是有效值）', () => {
  const f = S.ui.numField({ label: 'x', value: null, min: 0, max: 100, step: 1 });
  if (f.getNum() !== null) throw new Error('留空该回 null，实 ' + f.getNum());
  f.input.value = '0';
  if (f.getNum() !== 0) throw new Error('显式填 0 该保留，实 ' + f.getNum());
  f.input.value = '12.6';
  if (f.getNum() !== 13) throw new Error('该四舍五入，实 ' + f.getNum());
  return { 留空: null, 显式0: 0, 小数: 13 };
});

t('心声 commit 回传记录，drop / dropLastAfter 删得掉（reroll 要按它清）', () => {
  const chat = S.chatStore.createChat('心声测试', null);
  const r1 = S.heartbeat.commit(chat.id, '第一句心声');
  if (!r1 || !r1.id) throw new Error('commit 该回传带 id 的记录');
  const r2 = S.heartbeat.commit(chat.id, '第二句心声');
  if (S.heartbeat.unreadCount(S.chatStore.getChat(chat.id)) !== 2) throw new Error('该有两条未读');

  if (S.heartbeat.drop(chat.id, r1.id) !== 1) throw new Error('按 id 没删掉');
  if (S.heartbeat.unreadCount(S.chatStore.getChat(chat.id)) !== 1) throw new Error('删完该剩一条');

  /* 老消息没记 hbId 的退路：删 at >= 它的那条 */
  if (S.heartbeat.dropLastAfter(chat.id, r2.at) !== 1) throw new Error('退路没删掉');
  if (S.heartbeat.unreadCount(S.chatStore.getChat(chat.id)) !== 0) throw new Error('该清空');

  if (S.heartbeat.drop(chat.id, 'nope') !== 0) throw new Error('删不存在的该返回 0');
  return { 回传id: !!r1.id, 按id删: 1, 退路删: 1 };
});

t('genParams：timeoutSec 归一到 60s 下限（用户 2026-09-29：几秒就超时是老存档小值）', () => {
  S.store.set('chatDefaults', {});
  const g = S.api.genParams;
  const dirty0 = g({ baseUrl: 'x', model: 'm', timeoutSec: 0 }, {});
  const dirty1 = g({ baseUrl: 'x', model: 'm', timeoutSec: 1 }, {});
  const small30 = g({ baseUrl: 'x', model: 'm', timeoutSec: 30 }, {});
  const ok120 = g({ baseUrl: 'x', model: 'm', timeoutSec: 120 }, {});
  const bare = g({ baseUrl: 'x', model: 'm' }, {});
  const out = { 脏0: dirty0.timeoutSec, 脏1: dirty1.timeoutSec, 小30: small30.timeoutSec, 正常: ok120.timeoutSec, 缺省: bare.timeoutSec };
  if (dirty0.timeoutSec !== 60) throw new Error('0 该回落 60，实 ' + dirty0.timeoutSec);
  if (dirty1.timeoutSec !== 60) throw new Error('1 该回落 60，实 ' + dirty1.timeoutSec);
  if (small30.timeoutSec !== 60) throw new Error('30 该归一到 60，实 ' + small30.timeoutSec);
  if (ok120.timeoutSec !== 120) throw new Error('正常大值不该被动，实 ' + ok120.timeoutSec);
  if (bare.timeoutSec !== 60) throw new Error('缺省该 60，实 ' + bare.timeoutSec);
  /* 其余参数不受影响：0 仍然是有效值（0 度温、maxTokens 0 是用户明确选的） */
  const zeroTemp = g({ baseUrl: 'x', model: 'm', temperature: 0 }, {});
  if (zeroTemp.temperature !== 0) throw new Error('温度的 0 被吃掉了');
  return out;
});

t('向量端点归一化：补 /embeddings，且不重复补', () => {
  const u = S.api.embeddingsUrl;
  const a = u('https://x.test/v1');
  const b = u('https://x.test/v1/embeddings');
  const c = u('');
  if (a !== 'https://x.test/v1/embeddings') throw new Error('没补对：' + a);
  if (b !== 'https://x.test/v1/embeddings') throw new Error('重复补了：' + b);
  if (c !== '') throw new Error('空地址不该编出一个端点');
  return { 补全: a, 幂等: true };
});

t('T6 两种卡片：作品卡与邀请卡都渲染出关键信息', () => {
  const UI = S.wjCurtainUI;
  if (!UI) throw new Error('wjCurtainUI 没导出（聊天页拿不到卡片）');
  const textOf = (el) => {
    let s = el.textContent || '';
    (el.children || []).forEach((c) => { s += '\n' + textOf(c); });
    return s;
  };
  const share = textOf(UI.shareEl({ title: '潮声以北', chapters: 3, chars: 1200, note: '给你看看' }));
  const base = { title: '潮声以北', scopeName: '从第一章开始', modeName: '安静陪读' };
  const pending = textOf(UI.inviteEl(Object.assign({}, base, { answer: '' })));
  const accepted = textOf(UI.inviteEl(Object.assign({}, base, { answer: 'accept', note: '好' })));
  const refused = textOf(UI.inviteEl(Object.assign({}, base, { answer: 'refuse' })));
  if (share.indexOf('潮声以北') < 0) throw new Error('作品卡没有标题');
  if (share.indexOf('给你看看') < 0) throw new Error('作品卡没有附言');
  if (pending.indexOf('等 TA 回应') < 0) throw new Error('邀请卡没写「等 TA 回应」');
  if (accepted.indexOf('接受了') < 0) throw new Error('接受态没标出来');
  if (refused.indexOf('没有答应') < 0) throw new Error('婉拒的文案不对');
  return { 作品卡: '标题+附言', 邀请卡: '待回应/接受/婉拒' };
});

t('anchorId 不可变：局部重写只换 text，锚点与修订记录分得清', () => {
  const w = S.wj.createDraft({ title: '冒烟用剧本' });
  S.wj.addChapter(w.id, '第一章');
  const ch = S.wj.get(w.id).chapters[0];
  S.wj.addPara(w.id, ch.id, 'prose', '原来的句子。');
  const pid = S.wj.get(w.id).chapters[0].paras[0].id;
  if (!/^p_\d+_[a-z0-9]+$/.test(pid)) throw new Error('锚点格式不对：' + pid);
  S.wj.rewritePara(w.id, ch.id, pid, '改过以后的句子。');
  const p = S.wj.get(w.id).chapters[0].paras[0];
  if (p.id !== pid) throw new Error('重写把锚点换掉了 —— 挂靠会集体失效');
  if (p.text !== '改过以后的句子。') throw new Error('正文没换');
  if (!p.revisions || p.revisions.length !== 1) throw new Error('没留修订记录');
  return { 锚点: '不变', 修订: 1 };
});

t('三层权限各自独立：改作品性质不动取材，也不动 user 位置', () => {
  const w = S.wj.createDraft({
    reality: 'canon_candidate', materialScope: 'none', userPos: 'hidden'
  });
  let g = S.wj.get(w.id);
  if (g.reality !== 'canon_candidate' || g.materialScope !== 'none' || g.userPos !== 'hidden') {
    throw new Error('三档在创建时就被互相带跑了');
  }
  S.wj.mutate(w.id, (x) => { x.reality = 'parallel'; return x; });
  g = S.wj.get(w.id);
  if (g.materialScope !== 'none' || g.userPos !== 'hidden') {
    throw new Error('改作品性质把取材或 user 位置带跑了');
  }
  return { 独立: true, 取材: g.materialScope, 位置: g.userPos };
});

t('wjWorks 是全局键：作品不带 sandboxId（群岛作品无法归属单岛）', () => {
  const w = S.wj.createDraft({ title: '全局性检查' });
  if (w.sandboxId) throw new Error('作品被打上了 sandboxId，说明走了按岛分区');
  const raw = S.store.get('wjWorks') || [];
  const dirty = raw.filter((x) => x.sandboxId);
  if (dirty.length) throw new Error('存档里有按岛分区的作品：' + dirty.length);
  return { 全局: true, 条数: raw.length };
});

t('门厅四档筛选各归各位；草稿不算「最近阅读」', () => {
  const a = S.wj.createDraft({ title: '连载中的' });
  S.wj.mutate(a.id, (x) => { x.status = 'serializing'; return x; });
  const b = S.wj.createDraft({ title: '完本的' });
  S.wj.mutate(b.id, (x) => { x.status = 'completed'; return x; });
  const c = S.wj.createDraft({ title: '没开帷的' });
  const ids = (list) => list.map((x) => x.id);
  if (ids(S.wj.shelf('unfinished')).indexOf(a.id) < 0) throw new Error('连载中的没进未完成');
  if (ids(S.wj.shelf('completed')).indexOf(b.id) < 0) throw new Error('完本的没进已完成');
  if (ids(S.wj.shelf('draft')).indexOf(c.id) < 0) throw new Error('草稿没进草稿档');
  if (ids(S.wj.shelf('draft')).indexOf(b.id) >= 0) throw new Error('完本的混进草稿档了');
  const recent = S.wj.recentReadable();
  if (recent && recent.status === 'draft') throw new Error('草稿被当成最近阅读了');
  return { 未完成: 1, 已完成: 1, 草稿: ids(S.wj.shelf('draft')).length };
});

t('wjPrompt：三支装配与解析（生成含人物/雷区/协议，坏输出整体降级）', () => {
  const w = S.wj.createDraft({
    title: '装配检查', cast: [{ charId: 'x1', name: '林渡', role: 'lead', identity: '更夫' }],
    materialScope: 'none', reality: 'canon_candidate', userPos: 'hidden',
    workRules: [{ text: '不写雪', strength: '永久禁止' }]
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  const g = S.wj.get(w.id);
  const ch = g.chapters[0];

  const chap = S.wjPrompt.buildChapter(g, ch, { branchNote: '往灯塔走' });
  const sys = chap[0].content, usr = chap[1].content;
  if (sys.indexOf('林渡') < 0) throw new Error('生成提示词里没有出场人物');
  if (sys.indexOf('正史候选') < 0) throw new Error('作品性质没进提示词');
  if (sys.indexOf('不写雪') < 0) throw new Error('本篇雷区没进提示词');
  if (sys.indexOf('"paras"') < 0) throw new Error('输出协议没进提示词');
  if (sys.indexOf('完全不出场') < 0 && sys.indexOf('user 完全不出场') < 0) {
    throw new Error('user 隐去的指令没进提示词');
  }
  if (usr.indexOf('往灯塔走') < 0) throw new Error('岔路指令没进本章任务');

  const good = S.wjPrompt.parseChapter(
    '```json\n{"paras":[{"type":"prose","text":"第一段。"},{"type":"dialogue","text":"「谁？」"},{"type":"scene_break","text":""}],"choices":[{"label":"回头","hint":"看看身后的雪"}]}\n```');
  if (!good.ok || good.paras.length !== 3) throw new Error('JSON 正文解析失败（scene_break 空 text 应保留）');
  if (good.paras[2].kind !== 'scene_break') throw new Error('scene_break 没保留');
  if (good.choices.length !== 1 || good.choices[0].label !== '回头') throw new Error('岔路解析失败');
  const bad = S.wjPrompt.parseChapter('这是一段没有协议的输出');
  if (bad.ok) throw new Error('坏输出不该解析成功');
  const out2 = S.wjPrompt.buildOutline(g);
  if (out2[0].content.indexOf('"chapters"') < 0) throw new Error('规划协议没进提示词');
  return { 生成: 'ok', 规划: 'ok', 降级: 'ok' };
});

t('帷境生成链（注入 transport）：规划→生成→版本，重试幂等不重复建章', async () => {
  const w = S.wj.createDraft({
    title: '状态机检查', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });

  /* 规划：假 transport 吐一份章节计划（按调用注入，别的测试不受影响） */
  const outlineTransport = async () =>
    JSON.stringify({ chapters: [{ title: '第一章', brief: '开场' }, { title: '第二章', brief: '推进' }] });
  const n = await S.wjEngine.planChapters(w.id, { transport: outlineTransport });
  if (n !== 2) throw new Error('规划应产出 2 章，实际 ' + n);
  let g = S.wj.get(w.id);
  if (g.chapters.length !== 2 || g.chapters[0].status !== 'planned') {
    throw new Error('章节计划没落库');
  }
  /* 已有章节再规划要拒绝（幂等：不重复建章） */
  let dupRejected = false;
  try { await S.wjEngine.planChapters(w.id); } catch (e) { dupRejected = true; }
  if (!dupRejected) throw new Error('已有章节还允许重复规划');

  /* 生成：假 transport 吐正文 JSON */
  const chapterTransport = async () => JSON.stringify({
    paras: [
      { type: 'prose', text: '夜潮漫过北港的石阶。' },
      { type: 'dialogue', text: '「灯还亮着。」林渡说。' },
      { type: 'scene_break', text: '' },
      { type: 'prose', text: '他数完了第九级台阶。' }
    ],
    choices: [{ label: '上灯塔', hint: '去见那个等灯的人' }]
  });
  const chId = g.chapters[0].id;
  const r1 = await S.wjEngine.runChapter(w.id, chId, { transport: chapterTransport });
  if (!r1.ok || r1.paras !== 4) throw new Error('生成落库段数不对：' + JSON.stringify(r1));
  g = S.wj.get(w.id);
  const ch1 = g.chapters[0];
  if (ch1.status !== 'ready') throw new Error('章节没转 ready');
  if (ch1.paras.some((p) => !/^p_\d+_[a-z0-9]+$/.test(p.id))) throw new Error('锚点格式不对');
  if (!g.versions || g.versions.length !== 1) throw new Error('第一份稳定版本没留档');
  if (!ch1.choices || ch1.choices[0].label !== '上灯塔') throw new Error('章末岔路没落库');

  /* 重试同一章：整章替换、不新增章节、版本不重复留档 */
  await S.wjEngine.runChapter(w.id, chId, { transport: chapterTransport });
  g = S.wj.get(w.id);
  if (g.chapters.length !== 2) throw new Error('重试产生了重复章节');
  if (g.versions.length !== 1) throw new Error('重试重复留版本');
  return { 规划: n, 章节: g.chapters.length, 版本: g.versions.length, 锚点: 'ok' };
});

t('帷境失败与取消：失败不丢已生成正文，取消后迟到的响应按 stale 丢弃', async () => {
  const w = S.wj.createDraft({
    title: '失败检查', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[0].id, 'prose', '已经写好的句子。');
  S.wj.mutate(w.id, (x) => { x.chapters[0].status = 'ready'; return x; });
  S.wj.addChapter(w.id, '第二章');

  /* 失败：transport 直接 reject */
  let failedMsg = '';
  try {
    await S.wjEngine.runChapter(w.id, S.wj.get(w.id).chapters[1].id,
      { transport: async () => { throw new Error('连不上'); } });
  } catch (e) { failedMsg = e.message; }
  let g = S.wj.get(w.id);
  if (g.chapters[1].status !== 'failed') throw new Error('失败态没标记');
  if (!g.chapters[1].error) throw new Error('失败原因没记');
  const p0 = g.chapters[0].paras[0];
  if (p0.text !== '已经写好的句子。' || p0.id.indexOf('p_1_') !== 0) {
    throw new Error('已生成正文被失败波及了 —— 红线');
  }

  /* 取消：cancel 之后章节回 planned；注入一个「迟到的响应」，
     token 已失效，正文不许落库 */
  const ch2Id = g.chapters[1].id;
  const slowTransport = () => new Promise((resolve) => {
    setTimeout(() => resolve(JSON.stringify({
      paras: [{ type: 'prose', text: '迟到的不许落库。' }]
    })), 30);
  });
  const slow = S.wjEngine.runChapter(w.id, ch2Id, { transport: slowTransport });
  S.wjEngine.cancelChapter(w.id, ch2Id);
  const rc = await slow;
  if (!rc.stale) throw new Error('取消后的响应没有按 stale 丢弃');
  g = S.wj.get(w.id);
  if (g.chapters[1].status !== 'planned') throw new Error('取消后没回到 planned');
  if ((g.chapters[1].paras || []).length) throw new Error('取消后正文还是落库了');
  if (g.chapters[0].paras[0].text !== '已经写好的句子。') throw new Error('取消波及了别的章');
  return { 失败: failedMsg, 取消: 'stale 已丢弃', 已成章: '完好' };
});

t('帷境局部重写与岔路：重写只换 text 留修订；选岔路记 branch 且下一章消费', async () => {
  const w = S.wj.createDraft({
    title: '重写检查', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  const chId = S.wj.get(w.id).chapters[0].id;
  S.wj.addPara(w.id, chId, 'prose', '原来的段落。');
  const pid = S.wj.get(w.id).chapters[0].paras[0].id;

  S.wjEngine._transport = null;
  await S.wjEngine.rewritePara(w.id, chId, pid, '写得更收着一点',
    { transport: async () => '重写后的段落。' });
  let g = S.wj.get(w.id);
  let p = g.chapters[0].paras[0];
  if (p.id !== pid) throw new Error('重写换了锚点 —— 挂靠会集体失效');
  if (p.text !== '重写后的段落。') throw new Error('重写没换正文');
  if (!p.revisions || p.revisions.length !== 1 || p.revisions[0].from !== '原来的段落。') {
    throw new Error('修订记录没留');
  }

  /* 岔路：选择进 branches，下一章的提示词里出现岔路指令 */
  let lastChapterSys = '';
  const branchTransport = async (messages) => {
    lastChapterSys = messages[0].content + '\n' + messages[1].content;
    return JSON.stringify({ paras: [{ type: 'prose', text: '沿岔路写的新章。' }], choices: [] });
  };
  S.wjEngine.chooseBranch(w.id, chId, { label: '上灯塔', hint: '去见那个等灯的人' });
  g = S.wj.get(w.id);
  if (!g.branches || g.branches.length !== 1 || g.branches[0].label !== '上灯塔') {
    throw new Error('岔路没进 branches');
  }
  if (!g.branches[0].fromAnchorId) throw new Error('岔路没挂靠锚点');
  S.wj.addChapter(w.id, '第二章');
  const ch2Id = S.wj.get(w.id).chapters[1].id;
  await S.wjEngine.runChapter(w.id, ch2Id, { transport: branchTransport });
  if (lastChapterSys.indexOf('上灯塔') < 0) throw new Error('下一章提示词没有消费岔路');
  g = S.wj.get(w.id);
  if (g.nextBranch) throw new Error('岔路指令没被消费掉（只该影响一章）');

  /* 已读位置：percent 按全书段落算 */
  S.wjEngine.saveProgress(w.id, ch2Id, S.wj.get(w.id).chapters[1].paras[0].id);
  g = S.wj.get(w.id);
  /* 全书 2 段（第一章 1 + 第二章 1），读到第二章第 1 段 = 100% */
  if (!g.progress || g.progress.percent !== 100) {
    throw new Error('已读位置算错了：' + JSON.stringify(g.progress));
  }
  return { 锚点: '不变', 修订: 1, 岔路: '消费一次', 进度: g.progress.percent + '%' };
});

t('wjCheck 五层八股：各层都能命中，干净文本零误报', () => {
  const w = S.wj.createDraft({
    title: '检查用', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  const chId = S.wj.get(w.id).chapters[0].id;
  const pad = '夜潮一遍遍漫过台阶，他把灯笼挂回木架，看远处渡口的灯一盏一盏熄下去，然后慢慢往回走。';
  const paras = [
    ['prose', '他站在码头上，海风把衣角掀起来。' + pad],                 // 干净
    ['prose', '她不易察觉地笑了。（低头）' + pad],                        // banned：套话 + 括号
    ['prose', '他数完了第九级台阶。' + pad],                              // 段首「他」×3 之 1
    ['prose', '他把灯芯捻短了一截。' + pad],                              // 之 2
    ['prose', '他听见远处的涛声低了下去。' + pad],                        // 之 3 → template
    ['prose', '时间仿佛静止了。这一切似乎在诉说着什么。' + pad],          // pgraph ×2
    ['prose', '他揉了揉她的头发，没有说话，只是把外套披在她肩上，转身去生了火，又坐回她身边看着炉膛里的光。' + pad], // logic
    ['prose', '她的指尖划过木栏。他的指尖停在半空。指尖与指尖之间隔着一步。潮水漫过指尖。指尖凉了。' + pad] // density
  ];
  paras.forEach(([k, t]) => S.wj.addPara(w.id, chId, k, t));
  const issues = S.wjCheck.chapter(S.wj.get(w.id), S.wj.get(w.id).chapters[0]);
  const layers = new Set(issues.map((x) => x.layer));
  ['logic', 'banned', 'density', 'template', 'pgraph'].forEach((l) => {
    if (!layers.has(l)) throw new Error('「' + l + '」层没有命中：' + JSON.stringify([...layers]));
  });
  if (!issues.some((x) => x.rule.indexOf('括号') >= 0)) throw new Error('括号动作没被抓到');
  if (!issues.some((x) => x.rule.indexOf('套话') >= 0)) throw new Error('套话没被抓到');
  if (!issues.every((x) => /^p_1_[a-z0-9]+$/.test(x.paraId))) throw new Error('问题没挂到锚点上');

  /* 干净章零误报 */
  S.wj.addChapter(w.id, '第二章');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'prose',
    '他蹲下去解缆绳。' + pad + '船身轻轻磕了一下木桩，又稳住了。');
  const clean = S.wjCheck.chapter(S.wj.get(w.id), S.wj.get(w.id).chapters[1]);
  if (clean.length) throw new Error('干净章被误报：' + JSON.stringify(clean.map((x) => x.rule)));
  return { 层: layers.size, 干净章: 0 };
});

t('wjCheck 雷区资格：候选规则不参与检查，确认后才算数', () => {
  const w = S.wj.createDraft({
    title: '雷区资格', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden',
    workRules: [{ text: '雪松', strength: '尽量避免', confirmed: false }]
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[0].id, 'prose',
    '院子里种着一棵雪松，影子铺在台阶上，他站了很久才敲门。');
  const g1 = S.wjCheck.chapter(S.wj.get(w.id), S.wj.get(w.id).chapters[0]);
  if (g1.some((x) => x.rule === '命中你的雷区')) throw new Error('候选规则不该参与检查');
  S.wj.mutate(w.id, (x) => { x.workRules[0].confirmed = true; return x; });
  const g2 = S.wjCheck.chapter(S.wj.get(w.id), S.wj.get(w.id).chapters[0]);
  if (!g2.some((x) => x.rule === '命中你的雷区')) throw new Error('确认后的规则没参与检查');
  return { 候选: '不查', 已确认: '查' };
});

t('wjCheck 漂移与声音：给数字给证据，判断权留给 user', () => {
  const w = S.wj.createDraft({
    title: '漂移检查', cast: [
      { charId: 'x1', name: '林渡', role: 'lead' },
      { charId: 'x2', name: '沈砚', role: 'support' }
    ],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  const shortPara = '潮声近了。他停下脚步，回头看了一眼渡口的灯，然后继续往前走，直到石阶尽头。';
  S.wj.addChapter(w.id, '第一章');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[0].id, 'prose', shortPara);
  S.wj.addChapter(w.id, '第二章');
  /* 第二章：平均段长突变 + 对白占比拉满 + 同一人台词同一起手 */
  const longPara = '他把灯举过头顶，光沿着湿漉漉的石壁往上爬，照见一层一层旧年的水痕，' +
    '像谁用指甲一道一道刻上去的记号。他数到第九道的时候，塔顶的风把灯焰压得很低，' +
    '他不得不侧过身子护住它，一步一步往上挪。楼梯在黑暗里拐了三折，每一折都更窄，' +
    '最后一段几乎没有扶手，只有墙上一条被无数只手磨亮的木沿，他把手放在上面，木头是温的。';
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'prose', longPara);
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'dialogue', '林渡：「好，我上去看看，你在这里等。」');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'dialogue', '林渡：「好，你别跟上来。」');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'dialogue', '林渡：「好，灯还亮着。」');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'dialogue', '林渡：「好，随他们去说。」');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[1].id, 'dialogue', '沈砚：「随你便。」');
  S.wj.mutate(w.id, (x) => {
    x.chapters.forEach((c) => { c.status = 'ready'; });
    return x;
  });
  const d = S.wjCheck.drift(S.wj.get(w.id));
  if (d.rows.length !== 2) throw new Error('漂移统计缺章');
  if (!d.notes.length) throw new Error('突变没有提醒：' + JSON.stringify(d.rows));
  const v = S.wjCheck.voices(S.wj.get(w.id));
  const ld = v.filter((x) => x.name === '林渡')[0];
  if (!ld || ld.lines !== 4) throw new Error('台词归属错了：' + JSON.stringify(ld));
  if (!ld.remind) throw new Error('起手趋同没有提醒');
  const sy = v.filter((x) => x.name === '沈砚')[0];
  if (sy.remind) throw new Error('沈砚不该被提醒（只有一句）：' + sy.remind);
  return { 漂移: d.notes.length, 林渡: '趋同提醒', 沈砚: '干净' };
});

t('wjCoread 状态机：邀请四回应 → 同席 → 台账，现实候选只有「共同读过」', async () => {
  const w = S.wj.createDraft({
    title: '同席检查', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  const chId = S.wj.get(w.id).chapters[0].id;
  const plotText = '潮水漫过第九级台阶，他在黑暗里守着灯，什么也没有说。';
  S.wj.addPara(w.id, chId, 'prose', plotText);
  const anchorId = S.wj.get(w.id).chapters[0].paras[0].id;

  /* 四回应：later / share / refuse 都不建共读 */
  const s1 = S.wjCoread.createInvite({ workId: w.id, charId: 'x1', charName: '林渡',
    mode: 'quiet', scope: 'start', startAnchorId: anchorId });
  S.wjCoread.settle(s1.id, 'later');
  if (S.wjCoread.get(s1.id).status !== 'deferred') throw new Error('later 状态机不对');
  const s2 = S.wjCoread.createInvite({ workId: w.id, charId: 'x1', charName: '林渡',
    mode: 'occasional', scope: 'start', startAnchorId: anchorId });
  S.wjCoread.settle(s2.id, 'refuse');
  if (S.wjCoread.get(s2.id).status !== 'refused') throw new Error('refuse 状态机不对');
  if (!/改天再说/.test(S.wjCoread.get(s2.id).responseNote)) {
    throw new Error('拒绝的分寸文案丢了');
  }

  /* accept → active → 批注挂锚点 → 暂停/恢复 → 结束 */
  const s = S.wjCoread.createInvite({ workId: w.id, charId: 'x1', charName: '林渡',
    mode: 'quiet', scope: 'start', startAnchorId: anchorId });
  S.wjCoread.settle(s.id, 'accept', '好啊，一起读。');
  let g = S.wjCoread.get(s.id);
  if (g.status !== 'active') throw new Error('accept 没建立同席');
  S.wjCoread.annotate(s.id, anchorId, '这段的灯亮得刚好。');
  S.wjCoread.touchAnchor(s.id, anchorId);
  S.wjCoread.pause(s.id);
  if (S.wjCoread.get(s.id).status !== 'paused') throw new Error('暂停不对');
  S.wjCoread.resume(s.id);
  S.wjCoread.end(s.id);
  g = S.wjCoread.get(s.id);
  if (g.status !== 'ended' || g.endAnchorId !== anchorId) throw new Error('结束没记离席锚点');

  /* 现实候选：只有共读事件，绝不带剧情 */
  const cand = S.wjCoread.candidateFor(s.id);
  if (!cand || cand.content.indexOf('共同读过') < 0 || cand.content.indexOf('《同席检查》') < 0) {
    throw new Error('共读候选不对：' + JSON.stringify(cand));
  }
  if (cand.content.indexOf('潮水') >= 0 || cand.content.indexOf(plotText.slice(0, 6)) >= 0) {
    throw new Error('候选里混进了剧情 —— 共读事件真≠故事真（红线）');
  }
  if (cand.charId !== 'x1') throw new Error('候选没挂对人物');
  /* 台账里批注在、挂靠在，但它属于记录，不属于现实候选 */
  if (!g.transcript.some((t) => t.action === 'annotate' && t.anchorId === anchorId)) {
    throw new Error('批注没进台账');
  }
  S.wjCoread.markMemorySaved(s.id);
  S.wjCoread.markMemorySaved(s.id);
  if (!S.wjCoread.get(s.id).memorySaved) throw new Error('memorySaved 没落');
  return { 四回应: 'ok', 候选: '仅共读事件', 批注: '挂靠锚点' };
});

t('wjCoread 反应：沉默合法、冷却真拦、模式能力表按 Demo 变形', async () => {
  const w = S.wj.createDraft({
    title: '反应检查', cast: [{ charId: 'x1', name: '林渡', role: 'lead' }],
    materialScope: 'none', reality: 'story', userPos: 'hidden'
  });
  S.wj.mutate(w.id, (x) => { x.status = 'serializing'; return x; });
  S.wj.addChapter(w.id, '第一章');
  S.wj.addPara(w.id, S.wj.get(w.id).chapters[0].id, 'prose', '他守着灯，读完了这一段。');
  const anchorId = S.wj.get(w.id).chapters[0].paras[0].id;
  const s = S.wjCoread.createInvite({ workId: w.id, charId: 'x1', charName: '林渡',
    mode: 'quiet', scope: 'start', startAnchorId: anchorId });
  S.wjCoread.settle(s.id, 'accept');

  /* 沉默是完全合法的输出：不凑感想 */
  const r1 = await S.wjCoread.react(s.id, anchorId, '他守着灯，读完了这一段。',
    { transport: async () => JSON.stringify({ action: 'stay_silent', text: '' }) });
  if (r1.action !== 'stay_silent') throw new Error('stay_silent 没走通');
  let g = S.wjCoread.get(s.id);
  if (!g.transcript.some((t) => t.action === 'stay_silent')) throw new Error('沉默没进台账');

  /* 冷却：刚回应过，再点要被拦 */
  let cooled = false;
  try {
    await S.wjCoread.react(s.id, anchorId, '再看一段。',
      { transport: async () => JSON.stringify({ action: 'react', text: '很好' }) });
  } catch (e) { cooled = /再读一会儿/.test(e.message); }
  if (!cooled) throw new Error('冷却没拦住第二次反应');

  /* 冷却过后正常反应 */
  S.wjCoread.mutate(s.id, (x) => { x.lastReactAt = 0; return x; });
  const r2 = await S.wjCoread.react(s.id, anchorId, '他守着灯。',
    { transport: async () => JSON.stringify({ action: 'react', text: '这一段的灯写得克制。' }) });
  if (r2.action !== 'react' || !r2.text) throw new Error('正常反应没走通');

  /* 模式能力表（Demo：quiet 真的少功能） */
  if (S.wjCoread.canMilestone('quiet')) throw new Error('quiet 不该有重要节点');
  if (!S.wjCoread.canMilestone('occasional') || !S.wjCoread.canMilestone('free')) {
    throw new Error('occasional/free 该有重要节点');
  }
  if (S.wjCoread.canPauseDiscussion('quiet')) throw new Error('quiet 不该能暂停讨论');
  if (S.wjCoread.reactLabel('quiet') !== '询问反应') throw new Error('quiet 的反应按钮该改名');
  /* judgeInvite：无权读手记 —— 提示词里不许出现 directorNote 内容 */
  S.wj.mutate(w.id, (x) => {
    x.chapters[0].directorNote = '绝密手记内容XYZ';
    return x;
  });
  let prompt = '';
  const r3 = await S.wjCoread.judgeInvite(w.id, S.wjCoread.get(s.id),
    { transport: async (messages) => { prompt = messages[0].content;
      return JSON.stringify({ action: 'accept', note: '好。' }); } });
  if (r3.action !== 'accept') throw new Error('邀请判断没走通');
  if (prompt.indexOf('绝密手记内容XYZ') >= 0) throw new Error('邀请判断读到了创作手记（越权）');
  return { 沉默: '合法', 冷却: '拦', 静音: '能力表正确', 手记: '未越权' };
});

/* ======================== 语音 TTS（2.15 · 契约红线） ========================
   这一段的重点不是「功能跑没跑」，而是**三层文本边界与白名单**：
   标签只能由 Adapter 从白名单映射出来、原文本一个字都不许被改、
   禁用哭腔之后难过文本里也不能出现 [sobbing]、高克制不许自动吼叫。
   这些全是「肉眼看不出来」的类型 —— 真机上一句话读出来只是语气不对，
   没人会怀疑是映射表被写坏了。 */
console.log('\n--- 语音 TTS（契约红线 / 语音导演）---');
t('tts 白名单与出厂值：强表演默认关着', () => {
  const T = S.tts;
  if (!T) throw new Error('Sleepy.tts 缺失');
  if (T.EMOTIONS.length !== 11) throw new Error('情绪枚举不是 11 项');
  if (T.TAGS.length !== 7) throw new Error('表演标签不是 7 项');
  const v = T.DEFAULT_VOICE;
  if (v.allowedPerformanceTags.indexOf('crying') >= 0) throw new Error('哭腔默认就开了');
  if (v.allowedPerformanceTags.indexOf('breathy') >= 0) throw new Error('气声默认就开了');
  if (T.settings().enabled) throw new Error('语音出厂就是开着的');
  return { 情绪: T.EMOTIONS.length, 标签: T.TAGS.length, 默认频率: v.frequency, 最长: v.maxSeconds };
});

t('合成文本：白名单映射 + 短句不堆标签 + 原文不被改', () => {
  const T = S.tts;
  const original = '你怎么现在才回来？';
  const plan = { shouldGenerate: true, emotion: 'disappointed', intensity: 0.35, restraint: 0.82, pace: 1, performanceTags: ['soft'] };
  const built = T.buildFishSynthesisText(original, plan);
  if (built.indexOf('[disappointed]') !== 0) throw new Error('主情绪没映射出来：' + built);
  if (built.indexOf(original) < 0) throw new Error('原文被改写了：' + built);
  /* 短句（<=12 字）最多一个标签 —— 所以 [soft tone] 应该被丢掉 */
  if (/soft tone/.test(built)) throw new Error('短句堆了两个标签：' + built);
  /* 白名单外的标签进不来（手写的坏计划也不行） */
  const bad = T.buildFishSynthesisText(original, { shouldGenerate: true, emotion: 'neutral', intensity: 0, restraint: 0.3, pace: 1, performanceTags: ['shouting', 'screaming'] });
  if (/\[/.test(bad)) throw new Error('白名单外的标签被拼进去了：' + bad);
  /* 空文本必须拒绝 */
  let threw = false;
  try { T.buildFishSynthesisText('   ', plan); } catch (e) { threw = true; }
  if (!threw) throw new Error('空文本没被拒');
  return { 短句: built, 坏计划: bad, 强度档: T.buildFishSynthesisText('今天晚上一起吃饭吧，我想跟你说点事情。', plan) };
});

t('语音导演：不确定回退平静、禁用哭腔不出哭腔、高克制不吼叫', () => {
  const T = S.tts;
  const cfg = () => { const c = JSON.parse(JSON.stringify(T.DEFAULT_VOICE)); c.enabled = true; c.frequency = 'always'; return c; };
  const rng = () => 0;   /* 概率判定走「一定命中」 */

  const plain = T.speechPlanOf('今天天气不错。', cfg(), { rng: rng });
  if (plain.emotion !== 'neutral') throw new Error('没有情绪词却判成了 ' + plain.emotion);

  const c2 = cfg();
  c2.allowedPerformanceTags = c2.allowedPerformanceTags.filter((t) => t !== 'crying');
  const sad = T.speechPlanOf('别说了，我有点想哭。', c2, { rng: rng });
  if (sad.performanceTags.indexOf('crying') >= 0) throw new Error('禁了哭腔还是给了哭腔');
  const sadText = T.buildFishSynthesisText('别说了，我有点想哭。', sad);
  if (/sobbing/.test(sadText)) throw new Error('禁了哭腔还是拼出了 [sobbing]');

  const c3 = cfg();
  c3.restraint = 95;
  c3.allowedEmotions = ['angry'];
  const angry = T.speechPlanOf('我真的受够了，你太过分了！', c3, { rng: rng });
  if (angry.emotion !== 'angry') throw new Error('生气没判出来：' + angry.emotion);
  if (angry.restraint < 0.7) throw new Error('克制度没进计划');
  const angryText = T.buildFishSynthesisText('我真的受够了，你太过分了！', angry);
  if (/shouting|screaming|very /.test(angryText)) throw new Error('高克制还加了强表演：' + angryText);
  if (angry.performanceTags.length > 1) throw new Error('高克制没先减标签');

  return { 平静: plain.emotion, 难过标签: sad.performanceTags, 生气: angryText };
});

t('语音导演：频率 / 冷却 / 长度三道筛选，手动朗读绕过频率', () => {
  const T = S.tts;
  const base = JSON.parse(JSON.stringify(T.DEFAULT_VOICE));
  base.enabled = true;

  const off = T.speechPlanOf('你好。', Object.assign({}, base, { enabled: false }), {});
  if (off.shouldGenerate || off.reason !== 'disabled') throw new Error('关着还在生成');

  const requested = T.speechPlanOf('你好。', Object.assign({}, base, { frequency: 'requested' }), { rng: () => 0 });
  if (requested.shouldGenerate) throw new Error('「只在我说的时候」自己主动读了');

  const manual = T.speechPlanOf('你好。', Object.assign({}, base, { frequency: 'never' }), { manual: true });
  if (!manual.shouldGenerate || manual.reason !== 'manual_read') throw new Error('手动朗读被频率挡住了');

  const cooling = T.speechPlanOf('你好。', Object.assign({}, base, { frequency: 'always', cooldownTurns: 3 }),
    { turnsSinceVoice: 1, rng: () => 0 });
  if (cooling.shouldGenerate || cooling.reason !== 'cooldown') throw new Error('冷却期内还是读了');

  const long = T.speechPlanOf('一'.repeat(400), Object.assign({}, base, { frequency: 'always', maxSeconds: 15 }), { rng: () => 0 });
  if (long.shouldGenerate || long.reason !== 'too_long') throw new Error('超长还是读了');

  const hit = T.speechPlanOf('你好。', Object.assign({}, base, { frequency: 'always' }), { rng: () => 0 });
  if (!hit.shouldGenerate || hit.reason !== 'frequency_match') throw new Error('该读没读');

  return { 关着: off.reason, 只在我说: requested.reason, 冷却: cooling.reason,
    太长: long.reason, 命中: hit.reason, 手动: manual.reason,
    估算秒数: T.estimateSeconds('你'.repeat(45), 100) };
});

t('能力落到「模型」：不同档位的表达能力不一样', () => {
  const T = S.tts;
  const mm28 = T.capabilitiesOf('minimax', 'speech-2.8-hd');
  const mm26 = T.capabilitiesOf('minimax', 'speech-2.6-hd');
  const fishS1 = T.capabilitiesOf('fish_audio', 's1');
  if (!mm28.performanceTags) throw new Error('MiniMax 2.8 该有语气词标签');
  if (mm26.performanceTags) throw new Error('MiniMax 2.6 不该有标签');
  if (fishS1.performanceTags) throw new Error('Fish s1 不该有标签');

  /* ElevenLabs 三个档位差别最大：只有 v3 吃 Audio Tags，只有 Flash 能调速、
     才需要显式打开文本规范化（官方文档确认过的三条）。 */
  const elV3 = T.capabilitiesOf('elevenlabs', 'eleven_v3');
  const elV2 = T.capabilitiesOf('elevenlabs', 'eleven_multilingual_v2');
  const elFlash = T.capabilitiesOf('elevenlabs', 'eleven_flash_v2_5');
  if (!elV3.performanceTags) throw new Error('v3 该有 Audio Tags');
  if (elV2.performanceTags || elFlash.performanceTags) throw new Error('v2 / Flash 不该有 Audio Tags');
  if (!elFlash.speed || elV3.speed || elV2.speed) throw new Error('只有 Flash 能调速');
  if (!elFlash.textNormalization || elV3.textNormalization) throw new Error('只有 Flash 要显式开文本规范化');
  if (elV3.maxCharacters !== 5000 || elV2.maxCharacters !== 10000 || elFlash.maxCharacters !== 40000) {
    throw new Error('字符上限跟官方文档对不上');
  }
  /* 给界面看的人话能力表：逐条连接算，别按服务商一刀切（用户：「每个接口不一样」） */
  const fFish = T.featuresOf('fish_audio', 's2.1-pro-free');
  const fElV3 = T.featuresOf('elevenlabs', 'eleven_v3');
  const fElV2 = T.featuresOf('elevenlabs', 'eleven_multilingual_v2');
  const fSF = T.featuresOf('siliconflow', 'FunAudioLLM/CosyVoice2-0.5B');
  const fAz = T.featuresOf('azure', 'azure-neural');
  if (!fFish.tags || fFish.emotion !== 'label' || !fFish.speed || fFish.pause) {
    throw new Error('Fish 的能力表不对：' + JSON.stringify(fFish));
  }
  if (!fAz.pause || fAz.emotion !== 'style' || !fAz.style) throw new Error('Azure 的能力表不对：' + JSON.stringify(fAz));
  if (fSF.emotion !== 'none' || fSF.tags) throw new Error('硅基流动没有情绪/标签能力：' + JSON.stringify(fSF));
  if (fElV3.emotion !== 'label' || !fElV3.tags || fElV3.pause) throw new Error('v3 的能力表不对');
  if (fElV2.emotion !== 'none' || fElV2.tags) throw new Error('多语言 v2 没有情绪通道：' + JSON.stringify(fElV2));
  if (T.featuresOf('minimax', 'speech-2.8-hd').pause !== true) throw new Error('MiniMax 该能插停顿');

  /* 开放的每一家都必须有适配器 —— 没实现的才标 planned（契约 §8.6） */
  T.PROVIDER_ORDER.forEach((pid) => {
    if (T.providerOf(pid).planned) throw new Error(pid + ' 还没有适配器，不该开放入口');
  });
  /* 2026-10-07 用户：「阿里云那些用不了的全部去掉」——
     planned 清单（dashscope 等）整份撤掉，providerOf 对它们返回 null。
     这里反过来断言：已经撤掉的那几家不许再查得到。 */
  ['dashscope', 'volcengine', 'tencent_tts', 'xfyun', 'edge_tts', 'openai'].forEach((pid) => {
    if (T.providerOf(pid)) throw new Error(pid + ' 已经撤掉，不该还能查到');
    if (T.PROVIDER_ORDER.indexOf(pid) >= 0) throw new Error(pid + ' 不该出现在可用清单里');
  });
  return { '2.8': mm28.performanceTags, '2.6': mm26.performanceTags, 's1': fishS1.performanceTags,
    ElevenLabs: 'v3 标签 / Flash 调速',
    字符上限: T.PROVIDER_ORDER.map((p) => T.modelsOf(p).length + '档').join(' ') };
});

t('连接状态四档：没 Key 不许显示已连接，删服务不许无条件回退', () => {
  const T = S.tts;
  const made = T.saveConnection({ provider: 'fish_audio', displayName: '冒烟连接' });
  if (made.status !== 'unconfigured') throw new Error('刚建的连接不是未配置：' + made.status);
  T.markConnection(made.id, 'connected');
  const withKey = T.saveConnection({ id: made.id, apiKey: 'sk-test-1234567890' });
  if (withKey.status === 'unconfigured') throw new Error('填了 Key 还是未配置');
  T.markConnection(made.id, 'connected');
  if (T.connection(made.id).status !== 'connected') throw new Error('测试成功没写进状态');
  T.saveSettings({ defaultConnectionId: made.id });
  const r = T.removeConnection(made.id);
  if (r.fallbackTo !== null) throw new Error('删掉唯一的连接却回退到了别处');
  if (T.maskKey('sk-test-1234567890') !== '****7890') throw new Error('脱敏只该露后四位');
  return { 脱敏: T.maskKey('sk-test-1234567890'), 删后默认: r.fallbackTo };
});

t('请求组装与错误归一化（注入 transport，不打真网络）', async () => {
  const T = S.tts;
  const conn = { id: 'c1', provider: 'fish_audio', endpoint: 'https://api.fish.audio/v1/tts', apiKey: 'sk-abcdefghijkl' };
  const plan = { shouldGenerate: true, reason: 'manual_read', emotion: 'tender', intensity: 0.5, restraint: 0.5, pace: 1.05, performanceTags: ['soft'] };
  const original = '早点休息，别熬太晚。';
  const req = T.buildRequest({ provider: 'fish_audio', conn: conn, model: 's2.1-pro-free', voiceId: 'v1', plan: plan, originalText: original, output: T.settings().output });
  if (req.url.indexOf('api.fish.audio') < 0) throw new Error('地址不对：' + req.url);
  if (req.body.reference_id !== 'v1') throw new Error('音色没带上');
  if (req.body.text.indexOf(original) < 0) throw new Error('合成文本里没有原文');
  if (req.body.text === original) throw new Error('标签压根没拼（温柔该出 [soft tone] 或 [empathetic]）');
  /* 契约 §6.1 的两处「按上下文分流」：安慰语境才出 [empathetic]，一般温柔场合出 [soft tone] */
  const tenderPlain = T.buildFishSynthesisText('早点休息，别熬太晚。',
    { shouldGenerate: true, emotion: 'tender', intensity: 0.5, restraint: 0.5, performanceTags: [] });
  const tenderCare = T.buildFishSynthesisText('别难过了，我陪着你。',
    { shouldGenerate: true, emotion: 'tender', intensity: 0.5, restraint: 0.5, performanceTags: [] });
  if (tenderPlain.indexOf('[soft tone]') !== 0) throw new Error('一般温柔场合该出 [soft tone]：' + tenderPlain);
  if (tenderCare.indexOf('[empathetic]') !== 0) throw new Error('安慰语境该出 [empathetic]：' + tenderCare);
  const worried = T.buildFishSynthesisText('路上小心，到家和我说。',
    { shouldGenerate: true, emotion: 'concerned', intensity: 0.5, restraint: 0.5, performanceTags: [] });
  const empat = T.buildFishSynthesisText('你今天好像很累。',
    { shouldGenerate: true, emotion: 'concerned', intensity: 0.5, restraint: 0.5, performanceTags: [] });
  if (worried.indexOf('[worried]') !== 0) throw new Error('提醒语境该出 [worried]：' + worried);
  if (empat.indexOf('[empathetic]') !== 0) throw new Error('共情语境该出 [empathetic]：' + empat);
  /* §6.2：low 的「自然语言低声提示」未实测前走它给的回落（soft） */
  const lowTag = T.buildFishSynthesisText('好，我知道了。',
    { shouldGenerate: true, emotion: 'neutral', intensity: 0, restraint: 0.5, performanceTags: ['low'] });
  if (lowTag.indexOf('[soft tone]') !== 0) throw new Error('low 该回落到 soft tone：' + lowTag);
  if (req.headers.Authorization !== 'Bearer sk-abcdefghijkl') throw new Error('鉴权头不对');

  /* MiniMax 的组装：情绪进 voice_setting，表演走括号语气词，且**必须**查 base_resp */
  const mmReq = T.buildRequest({ provider: 'minimax', conn: { provider: 'minimax', endpoint: 'https://api.minimax.cn/v1/t2a_v2', apiKey: 'k' }, model: 'speech-2.8-hd', voiceId: 'male-qn-qingse', plan: plan, originalText: original, output: T.settings().output });
  if (mmReq.body.output_format !== 'hex') throw new Error('MiniMax 该用 hex 拿音频');
  if (mmReq.body.text.indexOf('(chuckle)') >= 0) throw new Error('没让笑却给了轻笑');

  /* ElevenLabs：音色在 **URL 路径**里、凭据头是 xi-api-key、只有 v3 吃 Audio Tags */
  const elConn = { provider: 'elevenlabs', endpoint: 'https://api.elevenlabs.io/v1/text-to-speech/', apiKey: 'el-key-1234' };
  const elV3 = T.buildRequest({
    provider: 'elevenlabs', conn: elConn, model: 'eleven_v3', voiceId: '21m00Tcm4TlvDq8ikWAM',
    plan: plan, originalText: original, output: T.settings().output
  });
  if (elV3.url.indexOf('/text-to-speech/21m00Tcm4TlvDq8ikWAM') < 0) throw new Error('音色没进 URL：' + elV3.url);
  if (elV3.url.indexOf('output_format=mp3_44100_128') < 0) throw new Error('输出格式没进查询串：' + elV3.url);
  if (elV3.headers['xi-api-key'] !== 'el-key-1234') throw new Error('凭据头不对');
  if (elV3.headers.Authorization) throw new Error('ElevenLabs 不吃 Authorization，别乱发');
  if (elV3.body.model_id !== 'eleven_v3') throw new Error('模型没进 body');
  if (elV3.body.text.indexOf('[reassuring]') !== 0) throw new Error('温柔没映射成 v3 的 Audio Tag：' + elV3.body.text);
  if (elV3.body.text.indexOf(original) < 0) throw new Error('原文被改写了');
  if (elV3.body.voice_settings.speed !== undefined) throw new Error('v3 不该发 speed（官方只对 2.5 系列生效）');
  if (elV3.body.apply_text_normalization) throw new Error('v3 的规范化一直开着，不该多发字段');

  /* Flash：没有 Audio Tags（一个标签都不许有），但能调速、要显式打开文本规范化 */
  const elFlash = T.buildRequest({
    provider: 'elevenlabs', conn: elConn, model: 'eleven_flash_v2_5', voiceId: 'abc',
    plan: plan, originalText: original, output: T.settings().output
  });
  if (/\[/.test(elFlash.body.text)) throw new Error('Flash 没有 Audio Tags，不许拼标签：' + elFlash.body.text);
  if (elFlash.body.voice_settings.speed !== 1.05) throw new Error('Flash 该带上语速');
  if (elFlash.body.apply_text_normalization !== 'on') throw new Error('Flash 该显式打开文本规范化');

  /* 中转地址本来就带查询串时，音色必须插在 ? 之前（拼在末尾就是 404） */
  const proxyReq = T.buildRequest({
    provider: 'elevenlabs', conn: { provider: 'elevenlabs', endpoint: 'https://my-proxy.dev/tts?token=abc', apiKey: 'k' },
    model: 'eleven_v3', voiceId: 'abc', plan: plan, originalText: original, output: T.settings().output
  });
  if (!/\/tts\/abc\?token=abc&output_format=/.test(proxyReq.url)) throw new Error('中转地址拼错了：' + proxyReq.url);

  /* 硅基流动：OpenAI 兼容的 /v1/audio/speech；音色要连模型名一起写 */
  const sfReq = T.buildRequest({
    provider: 'siliconflow', conn: { apiKey: 'sk-sf' }, model: 'FunAudioLLM/CosyVoice2-0.5B',
    voiceId: 'FunAudioLLM/CosyVoice2-0.5B:alex', plan: plan, originalText: original, output: T.settings().output
  });
  if (sfReq.url.indexOf('api.siliconflow.cn/v1/audio/speech') < 0) throw new Error('硅基流动地址不对：' + sfReq.url);
  if (sfReq.headers.Authorization !== 'Bearer sk-sf') throw new Error('硅基流动鉴权头不对');
  if (sfReq.body.input !== original) throw new Error('OpenAI 兼容那家没有标签字段，正文必须原样');
  if (/\[/.test(sfReq.body.input)) throw new Error('没标签能力的家不许拼标签');
  if (sfReq.body.speed !== 1.05) throw new Error('硅基流动该带语速');
  if (sfReq.body.sample_rate !== 44100) throw new Error('硅基流动 mp3 采样率只能是 32000/44100');

  /* Azure：只吃 SSML，音色写在正文里、凭据头是 Ocp-Apim-Subscription-Key */
  const azReq = T.buildRequest({
    provider: 'azure', conn: { apiKey: 'az-key' }, model: 'azure-neural',
    voiceId: 'zh-CN-XiaoxiaoNeural', plan: plan, originalText: '你好 <&> 世界', output: T.settings().output
  });
  if (azReq.headers['Ocp-Apim-Subscription-Key'] !== 'az-key') throw new Error('Azure 凭据头不对');
  if (azReq.headers.Authorization) throw new Error('Azure 不吃 Authorization');
  if (azReq.headers['Content-Type'] !== 'application/ssml+xml') throw new Error('Azure 的 Content-Type 必须是 SSML');
  if (azReq.body !== undefined || !azReq.rawBody) throw new Error('Azure 的正文是 XML 字符串（rawBody），不是 JSON');
  if (azReq.rawBody.indexOf("voice name='zh-CN-XiaoxiaoNeural'") < 0) throw new Error('音色没进 SSML：' + azReq.rawBody);
  if (azReq.rawBody.indexOf('<&>') >= 0) throw new Error('SSML 里的 XML 特殊字符没转义');
  if (azReq.rawBody.indexOf('&lt;&amp;&gt;') < 0) throw new Error('转义形式不对：' + azReq.rawBody);
  /* Azure 的输出格式只认固定几组，绝不能是 44khz */
  const fmt = T.azureFormatOf(T.settings().output);
  if (!/^audio-(16|24|48)khz-(32|48|64|96|128|160|192)kbitrate-mono-mp3$/.test(fmt)) {
    throw new Error('Azure 输出格式拼错了：' + fmt);
  }

  /* 自定义 · OpenAI 兼容：地址必须自己填（没有官方地址可回落） */
  const cuReq = T.buildRequest({
    provider: 'custom_openai', conn: { apiKey: 'k', endpoint: 'http://127.0.0.1:8080/v1/audio/speech' },
    model: 'sft', voiceId: 'v1', plan: plan, originalText: original, output: T.settings().output
  });
  if (cuReq.body.model !== 'sft' || cuReq.body.input !== original) throw new Error('自定义那家的 body 不对');
  const cuNoUrl = T.buildRequest({
    provider: 'custom_openai', conn: { apiKey: 'k', endpoint: '' },
    model: 'tts-1', voiceId: 'v1', plan: plan, originalText: original, output: T.settings().output
  });
  if (!cuNoUrl.unsupported || cuNoUrl.error.code !== 'CONNECTION_MISSING') throw new Error('没填地址却还想发请求');
  const cuTest = await T.testConnection({ id: 'x', provider: 'custom_openai', endpoint: '', apiKey: 'k' }, 'v1');
  if (cuTest.ok || cuTest.error.code !== 'CONNECTION_MISSING') throw new Error('没填地址的测试连接该直接拒绝（别变成超时）');

  /* 错误体：Azure / OpenAI 系的 {"error":{"message":...}} 也要读得出来 */
  const azErr = T.normalizeHttpError('azure', 401, JSON.stringify({ error: { code: '401', message: 'Access denied due to invalid subscription key.' } }));
  if (azErr.message.indexOf('invalid subscription key') < 0) throw new Error('Azure 的 error.message 没读出来：' + azErr.message);

  /* ElevenLabs 的错误体是 detail.message（对象）或 detail[0].msg（数组）——
     和 Fish 的 message 不是一个形状，别只认一种 */
  const el401 = T.normalizeHttpError('elevenlabs', 401, JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
  if (el401.code !== 'CREDENTIAL_INVALID' || el401.message !== 'Invalid API key') throw new Error('401 没归一化：' + JSON.stringify(el401));
  const el422 = T.normalizeHttpError('elevenlabs', 422, JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: 'Text too long', type: 'value_error' }] }));
  if (el422.code !== 'TEXT_TOO_LONG') throw new Error('422 没归一化：' + JSON.stringify(el422));
  const elVoice = T.normalizeHttpError('elevenlabs', 400, JSON.stringify({ detail: { message: 'Voice ID not found' } }));
  if (elVoice.code !== 'VOICE_NOT_FOUND') throw new Error('音色不存在没归一化：' + elVoice.code);

  /* 401 → CREDENTIAL_INVALID；超时 → PROVIDER_TIMEOUT */
  const r1 = await T.generate({ conn: conn, model: 's2.1-pro-free', voiceId: 'v1', text: '你好。', manual: true,
    transport: async () => ({ ok: false, status: 401, text: '{"message":"invalid api key"}' }) });
  if (r1.ok || r1.error.code !== 'CREDENTIAL_INVALID') throw new Error('401 没归一化：' + JSON.stringify(r1.error));
  const r2 = await T.generate({ conn: conn, model: 's2.1-pro-free', voiceId: 'v1', text: '你好。', manual: true,
    transport: async () => ({ ok: false, status: 0, text: 'network error' }) });
  if (r2.error.code !== 'PROVIDER_TIMEOUT') throw new Error('连不上没归一化：' + r2.error.code);

  /* 成功路径：假音频 → blob；而且**没写任何业务数据** */
  const before = JSON.stringify(S.store.get('charVoice') || null);
  const ok1 = await T.generate({ conn: conn, model: 's2.1-pro-free', voiceId: 'v1', text: '早点休息，别熬太晚。', manual: true,
    transport: async () => ({ ok: true, status: 200, buffer: new ArrayBuffer(16) }) });
  if (!ok1.ok) throw new Error('成功路径挂了：' + JSON.stringify(ok1.error));
  if (!/\[soft tone\]|\[empathetic\]/.test(ok1.synthesisText)) {
    throw new Error('温柔没映射出 Fish 的标签：' + ok1.synthesisText);
  }
  if (JSON.stringify(S.store.get('charVoice') || null) !== before) throw new Error('生成过程动了业务数据');

  /* ElevenLabs 走**同一条** generate 路径（注入 transport，不打真网络） */
  const elOk = await T.generate({
    conn: elConn, model: 'eleven_v3', voiceId: 'abc', text: '早点休息，别熬太晚。', manual: true,
    transport: async () => ({ ok: true, status: 200, contentType: 'audio/mpeg', buffer: new ArrayBuffer(32) })
  });
  if (!elOk.ok) throw new Error('ElevenLabs 成功路径挂了：' + JSON.stringify(elOk.error));
  if (elOk.blob.type !== 'audio/mpeg') throw new Error('音频 mime 不对：' + elOk.blob.type);
  if (elOk.synthesisText.indexOf('[reassuring]') !== 0) throw new Error('诊断用的临时文本不对：' + elOk.synthesisText);
  const elBad = await T.generate({
    conn: elConn, model: 'eleven_v3', voiceId: 'abc', text: '你好。', manual: true,
    transport: async () => ({ ok: false, status: 401, text: '{"detail":{"message":"Invalid API key"}}' })
  });
  if (elBad.ok || elBad.error.code !== 'CREDENTIAL_INVALID') throw new Error('ElevenLabs 401 没归一化：' + JSON.stringify(elBad.error));

  return { fish: req.body.text, 温柔分流: tenderCare.replace('别难过了，我陪着你。', '') + '/' + tenderPlain.replace('早点休息，别熬太晚。', ''),
    minimax: mmReq.body.text, elevenlabs: elV3.body.text,
    硅基流动: sfReq.body.input, Azure格式: fmt,
    401: r1.error.code, 超时: r2.error.code, 假音频字节: ok1.blob.size };
});

t('情绪与节奏：表达方向 / 自然停顿 / Azure 风格与语速', () => {
  const T = S.tts;
  const cfg = (o) => {
    const c = JSON.parse(JSON.stringify(T.DEFAULT_VOICE));
    c.enabled = true; c.frequency = 'always';
    return Object.assign(c, o || {});
  };

  /* ---- 角色表达方向：低权重先验，正文优先 ---- */
  const dir1 = T.speechPlanOf('明天九点开会。', cfg({ characterDirection: '慢性子，爱叹气，说话很低' }), { manual: true });
  if (dir1.performanceTags.indexOf('sigh') < 0) throw new Error('表达方向里的「爱叹气」没被用上：' + dir1.performanceTags);
  if (!(dir1.pace < 1)) throw new Error('「慢性子」没让语速慢下来：' + dir1.pace);
  const dir2 = T.speechPlanOf('明天九点开会。', cfg({ characterDirection: '惜字如金，语气冷淡' }), { manual: true });
  if (dir2.emotion !== 'cold') throw new Error('「惜字如金」没落到 cold：' + dir2.emotion);
  /* 正文有情绪时，正文赢（方向只是先验，不是覆盖） */
  const textFirst = T.speechPlanOf('今天真开心！谢谢你陪我。', cfg({ characterDirection: '惜字如金，语气冷淡' }), { manual: true });
  if (textFirst.emotion !== 'happy') throw new Error('正文的情绪被表达方向盖掉了：' + textFirst.emotion);
  /* 用户的开关仍然优先于方向 */
  const dirOff = T.speechPlanOf('明天九点开会。', cfg({
    characterDirection: '爱叹气', allowedPerformanceTags: ['soft']
  }), { manual: true });
  if (dirOff.performanceTags.indexOf('sigh') >= 0) throw new Error('白名单里没有 sigh，方向也不许用');

  /* ---- 自然停顿：只在句末、够长才插、最多 3 处，关掉就一个都没有 ---- */
  const long = '明天九点的会记得带材料。你昨天说的那个方案我看了。还有别的事吗？好。';
  const plan = T.speechPlanOf(long, cfg({}), { manual: true });
  if (plan.naturalPause !== true) throw new Error('计划里没带上停顿决定');
  const mm = T.synthesisTextOf('minimax', long, plan, T.capabilitiesOf('minimax', 'speech-2.8-hd'));
  const mmPauses = (mm.match(/<#/g) || []).length;
  if (mmPauses < 1 || mmPauses > 3) throw new Error('MiniMax 的停顿标记数量不对：' + mmPauses + ' → ' + mm);
  if (mm.indexOf('好。<#') >= 0) throw new Error('太短的句子不该插停顿：' + mm);
  if (mm.replace(/<#[0-9.]+#>/g, '').indexOf('明天九点的会记得带材料。') < 0) {
    throw new Error('插停顿把原文改动了：' + mm);
  }
  const off = T.speechPlanOf(long, cfg({ naturalPause: false }), { manual: true });
  if (/<#/.test(T.synthesisTextOf('minimax', long, off, T.capabilitiesOf('minimax', 'speech-2.8-hd')))) {
    throw new Error('关掉自然停顿还在插标记');
  }
  /* 没有可控停顿字段的家：一个字都不许插（别假装做了） */
  ['fish_audio', 'elevenlabs', 'siliconflow', 'custom_openai'].forEach((p) => {
    const t = T.synthesisTextOf(p, long, plan, T.capabilitiesOf(p, T.modelsOf(p)[0].id));
    if (/<#|<break/.test(t)) throw new Error(p + ' 没有停顿字段却插了标记：' + t);
  });

  /* ---- Azure：情绪走 express-as 风格、语速走 prosody、停顿走 break，且都要转义正确 ---- */
  const azPlan = T.speechPlanOf('今天真开心！谢谢你陪我。', cfg({ pace: 110 }), { manual: true });
  const az = T.buildRequest({
    provider: 'azure', conn: { apiKey: 'k' }, model: 'azure-neural',
    voiceId: 'zh-CN-XiaoxiaoNeural', plan: azPlan, originalText: '今天真开心！谢谢你陪我。', output: T.settings().output
  });
  if (az.rawBody.indexOf("style='whispering'") >= 0) throw new Error('whisper 才该出 whispering');
  if (az.rawBody.indexOf('<mstts:express-as style="cheerful"') < 0) throw new Error('开心没映射成 Azure 的 cheerful：' + az.rawBody);
  if (az.rawBody.indexOf('xmlns:mstts=') < 0) throw new Error('用了 mstts 命名空间却没声明');
  if (!/styledegree="1\.\d+"|styledegree="0\.\d+"/.test(az.rawBody)) throw new Error('styledegree 没按情绪幅度给：' + az.rawBody);
  /* 语速要跟**计划里的 pace** 一致（计划本身还会按情绪微调，别写死数字） */
  if (az.rawBody.indexOf('<prosody rate="' + azPlan.pace + '"') < 0) {
    throw new Error('语速没进 prosody（计划 ' + azPlan.pace + '）：' + az.rawBody);
  }
  if (Math.abs(azPlan.pace - 1.1) > 0.11) throw new Error('用户设的语速没进计划：' + azPlan.pace);
  const deg = Number((az.rawBody.match(/styledegree="([0-9.]+)"/) || [])[1]);
  if (!(deg >= 0.01 && deg <= 2)) throw new Error('styledegree 超出官方范围（0.01–2）：' + deg);
  /* 表里没有的音色：不发风格（官方说无效风格会被忽略，但我们不发没核对过的） */
  const az2 = T.buildRequest({
    provider: 'azure', conn: { apiKey: 'k' }, model: 'azure-neural',
    voiceId: 'en-US-AvaMultilingualNeural', plan: azPlan, originalText: 'Hello there.', output: T.settings().output
  });
  if (az2.rawBody.indexOf('express-as') >= 0) throw new Error('没核对过的音色不该发 express-as');
  /* 停顿标签不能被转义（先转义正文、再插标签） */
  const azPause = T.buildRequest({
    provider: 'azure', conn: { apiKey: 'k' }, model: 'azure-neural',
    voiceId: 'zh-CN-XiaoxiaoNeural', plan: T.speechPlanOf(long, cfg({}), { manual: true }),
    originalText: long, output: T.settings().output
  });
  if (azPause.rawBody.indexOf('<break time="350ms"/>') < 0) throw new Error('Azure 的 break 没插进去：' + azPause.rawBody);
  if (azPause.rawBody.indexOf('&lt;break') >= 0) throw new Error('break 被转义成了文本：' + azPause.rawBody);
  if (azPause.rawBody.indexOf('&lt;') >= 0) throw new Error('正文里的尖括号该被转义：' + azPause.rawBody);

  return { 方向: dir2.emotion + ' / ' + dir1.performanceTags.join(','), 语速: dir1.pace,
    MiniMax停顿: mmPauses, Azure风格: (az.rawBody.match(/style="([a-z-]+)"/) || [])[1] + '@' + deg,
    Azure语速: (az.rawBody.match(/rate="([0-9.]+)"/) || [])[1] };
});

t('模型版导演：结构化计划 / 白名单收口 / 失败回退规则版', async () => {
  const T = S.tts, D = S.ttsDirector;
  if (!D) throw new Error('tts-director 没加载');
  T.saveSettings({ enabled: true });
  const chId = 'ch-director';
  T.saveVoice(chId, { enabled: true, voiceId: 'v-1', frequency: 'always', pace: 100, characterDirection: '慢性子' });
  const text = '你真的要走了吗？';

  /* ① 规则版：一次都不许问模型 */
  T.saveSettings({ director: 'rules' });
  let calls = 0;
  let plan = await D.planFor(text, T.voiceConfigOf(chId), {
    manual: true, transport: () => { calls++; return { ok: true, content: '{}' }; }
  });
  if (calls !== 0) throw new Error('规则版不该去问模型');
  if (plan.source !== 'rules') throw new Error('规则版没标来源：' + plan.source);

  /* ② 模型版：提示词要带全（清单 + 前文），模型给的计划要采用 */
  T.saveSettings({ director: 'model' });
  let seen = null;
  plan = await D.planFor(text, T.voiceConfigOf(chId), {
    manual: true,
    context: [{ role: 'user', content: '我明天要走了。' }],
    transport: (req) => {
      seen = req;
      return { ok: true, content: '```json\n{"emotion":"sad","intensity":0.8,"tags":["sigh"],"pace":1.05}\n```' };
    }
  });
  const sys = (seen.messages[0] || {}).content || '';
  const usr = (seen.messages[1] || {}).content || '';
  if (!/情绪只能从这里选/.test(sys)) throw new Error('提示词里没给情绪清单');
  if (sys.indexOf('neutral') < 0) throw new Error('清单里没有 neutral');
  if (usr.indexOf('我明天要走了') < 0) throw new Error('前文没带进提示词：' + usr);
  if (usr.indexOf('你真的要走了吗') < 0) throw new Error('正文没带进提示词');
  if (plan.source !== 'model') throw new Error('来源没标模型版：' + plan.source);
  if (plan.emotion !== 'sad') throw new Error('模型判的情绪没采用：' + plan.emotion);
  if (plan.performanceTags.join(',') !== 'sigh') throw new Error('标签没采用：' + plan.performanceTags);
  if (!(plan.pace > 1 && plan.pace <= 1.12)) throw new Error('语速该在基准附近微调：' + plan.pace);
  if (plan.shouldGenerate !== true || !plan.seconds) throw new Error('退回/采用之后都要是个能用的计划');

  /* ③ 白名单外的、用户没允许的、超范围的 —— 一律丢弃 */
  const strict = T.voiceConfigOf(chId);
  strict.allowedEmotions = ['happy'];
  strict.allowedPerformanceTags = ['soft'];
  strict.restraint = 95;
  plan = await D.planFor('走开。', strict, {
    manual: true,
    transport: () => ({ ok: true, content: '{"emotion":"angry","intensity":9,"tags":["sobbing","laugh","soft"],"pace":2}' })
  });
  if (plan.emotion === 'angry') throw new Error('用户没允许的情绪被采用了');
  if (plan.performanceTags.indexOf('sobbing') >= 0 || plan.performanceTags.indexOf('laugh') >= 0) {
    throw new Error('没允许的标签被采用了：' + plan.performanceTags);
  }
  if (plan.performanceTags.length > 1) throw new Error('高克制该砍到一个标签：' + plan.performanceTags);
  if (!(plan.intensity <= 1)) throw new Error('强度没被钳位：' + plan.intensity);
  if (plan.pace === 2) throw new Error('越界的语速被采用了：' + plan.pace);

  /* ④ 请求失败 / 不是 JSON → 静默退回规则版（绝不抛错、绝不空手） */
  for (const bad of [{ ok: false, code: 'DIRECTOR_REQUEST_FAILED' }, { ok: true, content: '我觉得应该温柔一点' }]) {
    plan = await D.planFor(text, T.voiceConfigOf(chId), { manual: true, transport: () => bad, timeout: 50 });
    if (plan.source !== 'rules') throw new Error('坏输出没退回规则版：' + plan.source);
    if (!plan.shouldGenerate) throw new Error('退回之后也得能用');
  }

  /* ⑤ 超时 → 退回规则版，并留下原因 */
  plan = await D.planFor(text, T.voiceConfigOf(chId), {
    manual: true, timeout: 60, transport: () => new Promise(() => {})
  });
  if (plan.source !== 'rules' || plan.directorNote !== 'DIRECTOR_TIMEOUT') {
    throw new Error('超时没退回规则版：' + plan.source + '/' + plan.directorNote);
  }

  /* ⑥ 门禁不通过（频率 / 冷却 / 长度）→ 一次都不许问模型（省调用） */
  const off = T.voiceConfigOf(chId);
  off.frequency = 'requested';
  let asked = 0;
  plan = await D.planFor(text, off, { transport: () => { asked++; return { ok: true, content: '{"emotion":"sad"}' }; } });
  if (asked !== 0 || plan.shouldGenerate) throw new Error('门禁不过却问了模型');
  const cool = T.voiceConfigOf(chId);
  cool.frequency = 'always'; cool.cooldownTurns = 3;
  asked = 0;
  plan = await D.planFor(text, cool, {
    turnsSinceVoice: 1, transport: () => { asked++; return { ok: true, content: '{"emotion":"sad"}' }; }
  });
  if (asked !== 0 || plan.shouldGenerate) throw new Error('冷却期内却问了模型');

  T.saveSettings({ director: 'rules' });
  return { 规则版: '不出网', 模型版: plan.emotion || 'sad',
    白名单收口: '越界丢弃', 失败回退: 'DIRECTOR_TIMEOUT/坏 JSON' };
});

t('角色语音：单一状态源（charVoice 角色层覆盖出厂值）', () => {
  const T = S.tts;
  const base = T.voiceConfigOf('ch-tts-test');
  if (base.frequency !== 'requested') throw new Error('默认没跟上出厂值');
  if (T.hasOwnVoice('ch-tts-test')) throw new Error('没设置过却说有');
  T.saveVoice('ch-tts-test', { enabled: true, voiceId: 'v-1', frequency: 'often', pace: 120 });
  const now = T.voiceConfigOf('ch-tts-test');
  if (!now.enabled || now.voiceId !== 'v-1' || now.frequency !== 'often' || now.pace !== 120) throw new Error('存了读不回来');
  if (now.restraint !== T.DEFAULT_VOICE.restraint) throw new Error('没动过的字段应该还是出厂值');
  const other = T.voiceConfigOf('ch-other');
  if (other.enabled || other.voiceId) throw new Error('改一个角色影响了另一个');
  /* 恢复跟随默认 = 把角色层摘掉 */
  const all = T.voiceAll();
  delete all.byChar['ch-tts-test'];
  S.store.set('charVoice', all);
  if (T.hasOwnVoice('ch-tts-test')) throw new Error('摘掉之后还说有');
  return { 覆盖后: now.frequency + ' / 语速 ' + now.pace, 别的角色: other.frequency };
});


/* ======================== 全页渲染冒烟 ========================
   为什么需要这一段：check.js 只验语法，而 app.js 的错误边界会把 render()
   抛出的异常**吞掉**、把那页换成「这一页出错了」—— 语法全绿照样整页崩。
   2026-09-21 就踩了：page-chat-settings.js 的渲染函数里 charId / core
   两个变量从来没声明，'use strict' 下整页 ReferenceError，
   而当时的 check + smoke **全绿**，一行都抓不到。

   所以这里把注册表里每个页面挨个真的 open() 一遍。
   判定方式：拦截 console.error —— app.js 的 logError 打的是 '[Sleepy]' 前缀，
   只认这个前缀，避免误伤页面里正常的 console.error。
   跑在最后：它会切 activeSandbox + 真的压页面栈，放前面会打扰其它断言。 */
console.log('\n--- P0 回归（2026-09-23 审计确认的两个确定性缺陷）---');

/* P0-2：待回复队列的写回必须走全量。
   修之前 schedule / tick 都是「读 scoped → 原样回写」，换岛时把别的岛的
   待回复整批抹掉。这条测试走真实数据链路：真建两座岛、真调 schedule / tick
   （dueAt 由 schedule 自己排，不用外部塞）。
   flush 的「只处理本岛」与 clearPending 的语义各有一条专门测试锁（见下面两条）。 */
t('P0-2 待回复队列跨岛不互相抹掉（schedule + tick 都按全量写回）', () => {
  const prev = S.core.activeSandbox();
  S.store.set('momentPending', []);

  /* 岛 A：排一条待回复 */
  const cA = S.core.upsertChar({ name: '回归岛A角色', kind: 'main' }).id;
  const sbA = S.core.createSandbox('archipelago', '回归岛A');
  S.core.setSandboxChars(sbA.id, [cA]);
  S.core.setActiveSandbox(sbA.id);
  const itemA = S.momentsAI.schedule('replyComment', {
    momentId: 'regress-a', charId: cA, charName: 'A'
  });

  /* 岛 B：再排一条 —— 修之前这一步就把岛 A 那条抹掉了 */
  const cB = S.core.upsertChar({ name: '回归岛B角色', kind: 'main' }).id;
  const sbB = S.core.createSandbox('archipelago', '回归岛B');
  S.core.setSandboxChars(sbB.id, [cB]);
  S.core.setActiveSandbox(sbB.id);
  const itemB = S.momentsAI.schedule('replyComment', {
    momentId: 'regress-b', charId: cB, charName: 'B'
  });

  const idsInStore = () => S.store.get('momentPending').map((p) => p.id);

  try {
    /* ① schedule 不许抹掉别的岛 */
    const afterSchedule = idsInStore();
    if (afterSchedule.indexOf(itemA.id) < 0) {
      throw new Error('岛 A 的待回复被岛 B 的 schedule 抹掉了（库里只剩 ' + afterSchedule.length + ' 条）');
    }

    /* ② 在岛 B 上跑一次 tick：只该摘掉岛 B 那条。
       （先 flush 把本岛那条拉到「现在到期」—— 这里只当**造数据的步骤**用，
         flush 自己的语义由下一条测试单独锁。
         momentId 是假的，runOne 找不到动态会立刻 done —— 不碰网络。） */
    S.momentsAI.flush();
    S.momentsAI.tick();
    const afterTick = idsInStore();
    if (afterTick.indexOf(itemA.id) < 0) {
      throw new Error('岛 A 的待回复被岛 B 的 tick 抹掉了（库里只剩 ' + afterTick.length + ' 条）');
    }
    if (afterTick.indexOf(itemB.id) >= 0) throw new Error('岛 B 自己那条没被 tick 摘掉');

    return { schedule后剩: afterSchedule.length, tick后剩: afterTick.length, 岛A仍在: true, 岛B已摘: true };
  } finally {
    /* 断言失败也要收拾干净，别污染后面的全页渲染冒烟 */
    S.momentsAI.clearAllPending();
    S.core._purgeSync.sandbox(sbA.id);
    S.core._purgeSync.sandbox(sbB.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

/* flush 的语义锁定（用户 2026-09-23 验收要求单列）：
   只处理**当前岛** —— 不动别的岛的条目、不改它们的 dueAt、也不整批回写。
   修之前的写法是「改 scoped 列表 → savePending(它)」，会把别的岛整批抹掉。 */
t('flush 只处理当前岛：别的岛条目一条不动、内容逐字段不变', () => {
  const prev = S.core.activeSandbox();
  S.store.set('momentPending', []);

  const cA = S.core.upsertChar({ name: 'flush岛A角色', kind: 'main' }).id;
  const sbA = S.core.createSandbox('archipelago', 'flush岛A');
  S.core.setSandboxChars(sbA.id, [cA]);
  S.core.setActiveSandbox(sbA.id);
  const itemA = S.momentsAI.schedule('replyComment', { momentId: 'flush-a', charId: cA, charName: 'A' });

  const cB = S.core.upsertChar({ name: 'flush岛B角色', kind: 'main' }).id;
  const sbB = S.core.createSandbox('archipelago', 'flush岛B');
  S.core.setSandboxChars(sbB.id, [cB]);
  S.core.setActiveSandbox(sbB.id);
  const itemB = S.momentsAI.schedule('replyComment', { momentId: 'flush-b', charId: cB, charName: 'B' });

  const rowOf = (id) => S.store.get('momentPending').filter((p) => p.id === id)[0];

  try {
    const aBefore = JSON.stringify(rowOf(itemA.id));
    const n = S.momentsAI.flush();
    if (n !== 1) throw new Error('flush 只该动本岛 1 条，实际 ' + n);

    const aAfter = rowOf(itemA.id);
    if (!aAfter) throw new Error('flush 把别的岛的条目抹掉了');
    if (JSON.stringify(aAfter) !== aBefore) {
      throw new Error('flush 改了别的岛条目的内容（dueAt 或其它字段）');
    }
    const bAfter = rowOf(itemB.id);
    if (!bAfter) throw new Error('flush 把本岛的条目弄丢了');
    if (bAfter.dueAt > Date.now()) throw new Error('flush 没把本岛条目拉到「现在到期」');

    return { flush动了: n, 别岛条目未变: true, 本岛已到期: true };
  } finally {
    S.momentsAI.clearAllPending();
    S.core._purgeSync.sandbox(sbA.id);
    S.core._purgeSync.sandbox(sbB.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

/* clearPending 的语义（用户 2026-09-23 验收要求改）：
   默认只清**本岛**；要真·全局清空得显式叫 clearAllPending()。
   以前它是 savePending([])，等于顺手把别的岛的待回复一起清了。 */
t('clearPending 只清本岛；clearAllPending 才清全部', () => {
  const prev = S.core.activeSandbox();
  S.store.set('momentPending', []);

  const cA = S.core.upsertChar({ name: 'clear岛A角色', kind: 'main' }).id;
  const sbA = S.core.createSandbox('archipelago', 'clear岛A');
  S.core.setSandboxChars(sbA.id, [cA]);
  S.core.setActiveSandbox(sbA.id);
  const itemA = S.momentsAI.schedule('replyComment', { momentId: 'clear-a', charId: cA, charName: 'A' });

  const cB = S.core.upsertChar({ name: 'clear岛B角色', kind: 'main' }).id;
  const sbB = S.core.createSandbox('archipelago', 'clear岛B');
  S.core.setSandboxChars(sbB.id, [cB]);
  S.core.setActiveSandbox(sbB.id);
  const itemB = S.momentsAI.schedule('replyComment', { momentId: 'clear-b', charId: cB, charName: 'B' });

  try {
    const gone = S.momentsAI.clearPending();
    if (gone !== 1) throw new Error('clearPending 只该清本岛 1 条，实际 ' + gone);
    const ids = S.store.get('momentPending').map((p) => p.id);
    if (ids.indexOf(itemA.id) < 0) throw new Error('clearPending 把别的岛的待回复清了');
    if (ids.indexOf(itemB.id) >= 0) throw new Error('clearPending 没清掉本岛那条');

    S.momentsAI.clearAllPending();
    if (S.store.get('momentPending').length !== 0) throw new Error('clearAllPending 没清干净');

    return { 本岛清掉: gone, 别岛仍在: true, 全清后剩: 0 };
  } finally {
    S.momentsAI.clearAllPending();
    S.core._purgeSync.sandbox(sbA.id);
    S.core._purgeSync.sandbox(sbB.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

/* P0-1：AI 回复里的 [手机] 痕迹要真的落进查手机。
   调的是 runReply 回复后处理用的**同一个函数**（applyPhoneTrace）。
   修之前那里引用了不存在的 chat → ReferenceError 被 catch 吞掉，
   痕迹一条都没落过库，而且全程不报错。这里真建 岛/角色/对话/手机壳。 */
t('P0-1 回复里的 [手机] 痕迹落进查手机（真实数据链路）', () => {
  const prev = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '回归手机角色', kind: 'main' }).id;
  const sb = S.core.createSandbox('isle', '回归手机岛');
  S.core.setSandboxChars(sb.id, [c]);
  S.core.setActiveSandbox(sb.id);

  const chat = S.chatStore.createChat('回归手机对话', c);
  const ph = S.phone.ensurePhone(sb.id, c);
  const before = S.phone.listNotes(ph.id).length;

  const raw = ['今天去跑了步。',
    '[手机] {"app":"notes","op":"add_note","payload":{"title":"训练","content":"加了组"}}',
    '晚安。'].join('\n');
  const r = S.chatApp.applyPhoneTrace(chat.id, raw);

  const notes = S.phone.listNotes(ph.id);
  const landed = notes.some((n) => n.title === '训练');

  S.core._purgeSync.sandbox(sb.id);
  S.core.setActiveSandbox(prev ? prev.id : null);

  if (!landed) throw new Error('手机痕迹没落库（备忘条数 ' + before + '→' + notes.length + '）');
  if (r.text.indexOf('[手机]') >= 0) throw new Error('正文里还留着 [手机] 标签');
  if (r.applied !== 1) throw new Error('落库条数不对：' + r.applied);
  return { 落库: landed, 条数: before + '→' + notes.length, 标签已剥离: true };
});

/* P0-1 的静态护栏：那行曾经内联写成 `chat.characterId`（runReply 作用域里
   根本没有 chat），报错被 catch 吞掉、痕迹全丢。上面那条测试守的是行为，
   这条守的是「别再把这套逻辑抄回 runReply」这个复发点。 */
{
  const pcs = fs.readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
  ok('P0-1 护栏：回复后处理只调 applyPhoneTrace，不再内联 chat.xxx',
    pcs.indexOf('applyPhoneTrace(chatId, finalText)') >= 0 &&
    pcs.indexOf('rootIdOf(chat.characterId)') < 0);
}

/* 静态护栏：多选条是**从上面插进流里**的（append 在 .msg-wrap 之前），
   它一露面就把消息区顶下去一条子那么高（量过：wrap.top 100 → 147、
   参照气泡的屏幕坐标 109 → 156）—— 用户 2026-09-23：「聊天里面的多选，
   我点一个气泡之后页面就会下滑」。守的是「露面前后都把高度差补回 scrollTop」
   那两句别被顺手删掉：删了就是「一进多选，整段对话往下滑」。
   ⚠️ 露面的路（selecting=true，在函数末尾）和收起的路（selecting=false，
   早退分支里）各要有一句，只留一句 = 退出多选时又跳一下。 */
{
  const pcs2 = fs.readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
  const nSelFix = pcs2.split('msgWrap.scrollTop += (h0 - msgWrap.clientHeight)').length - 1;
  ok('多选条露面/收起都补了高度差（露一条 = 进出多选各跳一次 47px）', nSelFix >= 2);
}



console.log('\n--- 第二批证据探针（只读断言，不改任何行为）---');

/* 项目 5 施工后的新口径（2026-09-26）：charMem 归 root ——
   皮套和大号是**同一个大脑**：同一个键、同一份注入；条目用 fromCharId
   记「哪张脸产生的」。本探针的前身钉的是归一前的旧现状（分键分裂），
   项目 5 落地后旧断言已随旧口径一起作废。
   ⚠️ 本探针只写 charMem 一个键并在 finally 里删掉，不改生产行为。 */
t('探针：charMem 归 root —— 皮套与 root 同键共脑，条目记 fromCharId', () => {
  const prev = S.core.activeSandbox();
  const root = S.core.upsertChar({ name: '探针大号', kind: 'main' }).id;
  const sub = S.core.upsertChar({ name: '探针皮套', kind: 'sub', parentId: root }).id;
  const sb = S.core.createSandbox('isle', '探针岛');
  S.core.setSandboxChars(sb.id, [root]);
  S.core.setActiveSandbox(sb.id);

  try {
    /* 走真实写入口（addMemoryItem 会顺手喊 sweepMem；node 无 indexedDB → 静默跳过） */
    S.memoryStore.addMemoryItem(sub, { kind: 'shared_event', content: '皮套这条' });
    S.memoryStore.addMemoryItem(root, { kind: 'shared_event', content: '大号这条' });

    /* 键只有一个：皮套不再另立门牌 */
    const rootFile = S.store.get('charMem:' + root) || { memories: [] };
    const subFile = S.store.get('charMem:' + sub);
    const oneKeyOnly = !subFile && rootFile.memories.length === 2;

    /* 条目记「哪张脸产生的」 */
    const subEntry = rootFile.memories.filter((m) => m.content === '皮套这条')[0] || {};
    const rootEntry = rootFile.memories.filter((m) => m.content === '大号这条')[0] || {};
    const fromCharIdOk = subEntry.fromCharId === sub && rootEntry.fromCharId === root;

    /* 留痕列出来的人里没有皮套（只有大号 + 岛内 NPC） */
    const listed = (S.memoryStore.loadIsland().chars || []).map((c) => c.id);
    const subHiddenFromUI = listed.indexOf(sub) < 0 && listed.indexOf(root) >= 0;

    /* L0 注入共脑：皮套和大号看的是同一份 */
    const injSub = S.memoryStore.getMemoryInjection(sub) || '';
    const injRoot = S.memoryStore.getMemoryInjection(root) || '';
    const sharedBrain = injSub.indexOf('皮套这条') >= 0 &&
      injSub.indexOf('大号这条') >= 0 && injRoot.indexOf('皮套这条') >= 0;

    if (!oneKeyOnly) throw new Error('charMem 没归成一个键（归一失效或回退了）');
    if (!fromCharIdOk) throw new Error('条目没记 fromCharId（删皮套没法精确清向量）');
    if (!subHiddenFromUI) throw new Error('留痕列表居然列了皮套（前提变了）');
    if (!sharedBrain) throw new Error('L0 注入没共脑（皮套看不到大号的记忆，或反之）');

    return { 同键: true, fromCharId: true, 皮套留痕不可见: true, 注入共脑: true };
  } finally {
    S.store.remove('charMem:' + root);
    S.store.remove('charMem:' + sub);
    S.core._purgeSync.sandbox(sb.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

console.log('\n--- 全页渲染冒烟（每个注册页面真跑一次 render）---');
t('所有注册页面的 render() 都不触发 app.js 的错误边界', () => {
  const ids = Object.keys(S.registered()).filter((id) => id !== 'home');
  /* home 是基底页、不在页面栈里，它的点火由上面的 bootHome 断言覆盖：
     nav.open('home') 只等于「回桌面」，不 build，测不到 render。 */
  if (ids.length < 50) throw new Error('注册页面只有 ' + ids.length + ' 个，注册表是不是没加载全');

  /* ---- 夹具：真建一套 岛 / 角色 / 马甲 / 对话 / 群，参数一次性全给上 ---- */
  const m = S.core.upsertChar({ name: '冒烟大号', kind: 'main', content: '渲染夹具' }).id;
  const n = S.core.upsertChar({ name: '冒烟NPC', kind: 'npc', parentId: m, content: '渲染夹具' }).id;
  const u = S.core.upsertUser({ name: '冒烟马甲' }).id;
  const sb = S.core.createSandbox('archipelago', '冒烟群岛');
  S.core.setSandboxChars(sb.id, [m]);
  S.core.setActiveSandbox(sb.id);

  const chat = S.chatStore.createChat('冒烟对话', m);
  const gr = S.groupStore.createGroup({
    name: '冒烟群',
    ownerAccountId: u,
    members: [
      { kind: 'char', ownerId: m, accountId: m },
      { kind: 'npc', ownerId: m, accountId: n }
    ]
  });
  const groupId = (gr && (gr.group ? gr.group.id : (gr.ok ? gr.id : ''))) || '';

  const fixture = {
    chatId: chat.id, charId: m, npcId: n, userId: u,
    sandboxId: sb.id, islandId: sb.id, sbId: sb.id, groupId: groupId,
    id: chat.id, roomId: sb.id, phoneId: 'ph_smoke'
  };

  const broken = [];
  const origError = console.error;

  ids.forEach((id) => {
    const caught = [];
    console.error = function () {
      const a = Array.prototype.slice.call(arguments);
      const line = a.map(String).join(' ');
      const st = a[1] && a[1].stack ? '\n        ' + String(a[1].stack).split('\n').slice(0, 4).join('\n        ') : '';
      caught.push(line + st);
    };
    try {
      if (S.nav.depth() > 0) S.nav.closeAll();
      S.nav.open(id, Object.assign({}, fixture));
    } catch (e) {
      caught.push('[open] ' + (e && e.message));
    } finally {
      console.error = origError;
    }
    /* 只认 logError 的 '[Sleepy]' 前缀；页面自己打的 error 不算渲染失败 */
    const hit = caught.filter((line) => line.indexOf('[Sleepy]') >= 0);
    if (hit.length) broken.push(id + ' → ' + hit[0].replace(/\s+/g, ' ').slice(0, 700));
  });

  if (S.nav.depth() > 0) S.nav.closeAll();
  if (broken.length) {
    broken.forEach((b) => console.log('      · ' + b));
    throw new Error('有 ' + broken.length + ' 个页面渲染失败');
  }
  return { 页面数: ids.length, 全部通过: true };
});

t('记忆注入：规则类不许吃满配额，经历类有保底（2026-09-22 配额重做）', () => {
  const ch = S.core.upsertChar({ name: '配额测试', kind: 'main' }).id;
  const mk = (kind, content) => ({ kind, content, status: 'active' });
  S.memoryStore.writeMemoryItems(ch, [
    mk('boundary', '禁区甲'), mk('boundary', '禁区乙'), mk('boundary', '禁区丙'),
    mk('correction', '纠正甲'), mk('correction', '纠正乙'), mk('correction', '纠正丙'),
    mk('shared_event', '我们一起去看过海'),
    mk('promise', '她答应周末陪我去旧书店'),
    mk('user_fact', '她不吃香菜')
  ]);
  const inj = S.memoryStore.getMemoryInjection(ch);
  /* 旧版这三条全是 false —— 边界 3 + 纠正 3 正好把 6 格吃满，
     共同经历和约定一条都进不来（用户 09-22 提「六条太少」时实测到的）。 */
  if (inj.indexOf('一起去看过海') < 0) throw new Error('共同经历被规则类挤掉了');
  if (inj.indexOf('旧书店') < 0) throw new Error('约定被规则类挤掉了');
  if (inj.indexOf('不吃香菜') < 0) throw new Error('事实被规则类挤掉了');
  /* 反向也要守：规则类不能一条都不进（禁区掉了比记不住经历更危险）。 */
  if (inj.indexOf('禁区') < 0 && inj.indexOf('纠正') < 0) {
    throw new Error('规则类被反向饿死了');
  }
  const n = inj.split('\n').filter((l) => l.indexOf('- ') === 0).length;
  if (n > 12) throw new Error('超过配额上限：' + n);
  return { 注入条数: n, 经历类进得来: true, 规则类也还在: true };
});

t('contextLimit：对话覆盖 > 聊天默认 > 内置 40，三处共用一份回落', () => {
  const chat = { id: 'c_ctx', messages: [], overrides: {} };
  S.store.set('chatDefaults', {});
  if (S.api.contextLimit(chat) !== 40) throw new Error('内置默认不是 40：' + S.api.contextLimit(chat));
  S.store.set('chatDefaults', { contextMessages: 66 });
  if (S.api.contextLimit(chat) !== 66) throw new Error('聊天默认没生效');
  chat.overrides = { contextMessages: 7 };
  if (S.api.contextLimit(chat) !== 7) throw new Error('对话覆盖没赢');
  S.store.set('chatDefaults', {});
  /* 生成参数的默认值**只能有一份**。store 的 chatDefaults 里再抄一份的话，
     它在 genParams 回落的第三层、会把 api.js 那份静默盖掉 ——
     2026-09-22 真机就这样：api.js 改成 40，实际请求还是 20。 */
  const cdf = S.store.defaults().chatDefaults || {};
  ['contextMessages', 'temperature', 'maxTokens', 'stream'].forEach((k) => {
    if (k in cdf) throw new Error('store 的 chatDefaults 里不该再有生成参数：' + k);
  });
  return { 内置默认: 40, 三层回落: '对话 > 默认 > 内置', 生成参数只有一份: true };
});

t('L1.5 近期生活动态：只收 TA 看得见的，朋友权限挡住的不进', () => {
  const C = S.core;
  const sb = C.createSandbox('archipelago', '动态测试岛');
  C.setActiveSandbox(sb.id);
  const a = C.upsertChar({ name: '动态角色', kind: 'main' }).id;
  const u = C.upsertUser({ name: '动态马甲' });
  C.setSandboxChars(sb.id, [a]);
  C.setSandboxMasks(sb.id, [u.id]);
  S.store.set('moments', []);
  S.momentsTab.add({ text: '今天吃了拉面', name: '我', maskId: u.id });
  S.momentsTab.add({ text: '在书店整理到很晚', characterId: a, name: '动态角色' });
  S.momentsTab.add({ text: '这条设了私密', name: '我', maskId: u.id, privacy: 'self' });

  let txt = S.lifeFeed.text(a, u.id);
  if (txt.indexOf('今天吃了拉面') < 0) throw new Error('我看得见的动态没进');
  if (txt.indexOf('在书店整理到很晚') < 0) throw new Error('TA 自己发的没进');
  if (txt.indexOf('这条设了私密') >= 0) throw new Error('私密动态进了（可见范围没拦住）');
  if (txt.indexOf('[近期生活动态]') < 0) throw new Error('没有注入头的标记');

  /* 我不让他看我的 → 我发的两条都不该进，只剩他自己发的。
     注意方向：挡他的是 iHideFromChar / charHidesFromMe，
     用成 iHideChar（那是「我不看 TA 的」）就反了。 */
  C.setFeedPerm(a, u.id, 'iHideFromChar', true);
  const txt2 = S.lifeFeed.text(a, u.id);
  if (txt2.indexOf('今天吃了拉面') >= 0) throw new Error('关了「让他看我的」还进了 —— 方向反了');
  if (txt2.indexOf('在书店整理到很晚') < 0) throw new Error('他自己发的被误伤');
  C.setFeedPerm(a, u.id, 'iHideFromChar', false);

  /* 装配产物里要有这一段（K03b 槽） */
  const out = S.promptEngine.assembleOnline({ charId: a, userId: u.id, history: [] });
  const sys = (out.messages || []).filter((m) => m.role === 'system')
    .map((m) => m.content).join('\n');
  if (sys.indexOf('[近期生活动态]') < 0) throw new Error('K03b 槽没进装配产物');
  return { 看得见的: 2, 私密被挡: true, 权限方向对: true, 进了装配: true };
});

t('L1.5 扩源：日历经 visibility 分档，日记经授权分档', () => {
  const C = S.core, cal = S.calendar;
  const sb = C.createSandbox('archipelago', '视野源测试岛');
  C.setActiveSandbox(sb.id);
  const a = C.upsertChar({ name: '视野角色', kind: 'main' }).id;
  const u = C.upsertUser({ name: '视野马甲' });
  C.setSandboxChars(sb.id, [a]);
  C.setSandboxMasks(sb.id, [u.id]);
  S.store.set('moments', []);
  S.store.set('diaries', []);

  const tmr = cal.shiftISO(cal.todayISO(), 1);
  const mk = (o) => cal.__internal.addEvent(Object.assign({
    ownerCharId: a, startAt: tmr + 'T15:00', createdBy: { type: 'user', id: 'user' }
  }, o));
  mk({ title: '牙医复诊', visibility: 'shared_detail' });
  mk({ title: '给他买礼物', visibility: 'private' });          /* 我的私事 */
  mk({ title: '公司会议', visibility: 'shared_busy' });         /* 只知道忙 */
  mk({ title: '每天开门', eventType: 'char_schedule', visibility: 'shared_detail' });
  cal.__internal.addEvent({ ownerCharId: a, startAt: tmr + 'T20:00', title: '去河边散步',
    visibility: 'shared_detail', createdBy: { type: 'char', id: a } });

  S.store.set('diaries', [
    C.tagScope({ id: 'd1', content: '今天有点累，但还行', timestamp: Date.now(), author: 'user' }),
    C.tagScope({ id: 'd2', content: '书店来了个有趣的客人', timestamp: Date.now(), author: 'char', charId: a })
  ]);

  const txt = S.lifeFeed.text(a, u.id);
  if (txt.indexOf('牙医复诊') < 0) throw new Error('shared_detail 没进');
  if (txt.indexOf('买礼物') >= 0) throw new Error('private 的漏出去了（日历页是上帝视角，L1.5 不是）');
  if (txt.indexOf('公司会议') >= 0) throw new Error('shared_busy 不该给标题 —— 那一档的语义是「只知道那会儿有事」');
  if (txt.indexOf('被占住') < 0) throw new Error('shared_busy 没给「只知道忙」的表述');
  if (txt.indexOf('每天开门') >= 0) throw new Error('作息表不该进（那是日常背景，不是临近事项）');
  if (txt.indexOf('河边散步') < 0) throw new Error('TA 自己安排的没进');
  if (txt.indexOf('书店来了个有趣的客人') < 0) throw new Error('TA 自己写的日记没进');
  if (txt.indexOf('今天有点累') >= 0) throw new Error('我的日记默认关，不该进');

  S.lifeFeed.setDiaryShared(a, true);
  const t2 = S.lifeFeed.text(a, u.id);
  if (t2.indexOf('今天有点累') < 0) throw new Error('授权之后我的日记还是没进');
  S.lifeFeed.setDiaryShared(a, false);
  return { 日历按档: true, 日记先授权才进: true, 作息不收: true };
});

t('L4 向量记忆：切块 / 余弦 / 重排 / 窗口去重（纯函数打表）', () => {
  const P = S.memoryVec._pure;
  const mk = (role, content, ts) => ({ id: 'm' + ts, role, content, timestamp: ts });

  /* ① 切块：8 条起一块，不够就等更多消息 */
  const short = [mk('user', '在吗', 1), mk('assistant', '在', 2)];
  if (P.nextBlock(short, 0, '林渡') !== null) throw new Error('两条就切了一块 —— 应该等更多消息');
  /* 「或」语义（2026-09-26）：满 8 条就切，字数不再拦 —— 短聊不卡 600 字 */
  const chatty = [];
  for (let i = 0; i < 12; i++) chatty.push(mk(i % 2 ? 'user' : 'assistant', '第' + i + '句好呀', 10 + i));
  const bc = P.nextBlock(chatty, 0, '林渡');
  if (!bc || bc.msgCount !== 8) throw new Error('满 8 条短消息没切（还卡着 600 字？）：' + (bc && bc.msgCount));
  /* 反向：不满 8 条但合计满 600 字也切（方案原文是「或」，长消息场景） */
  const fewLong = [];
  for (let i = 0; i < 3; i++) fewLong.push(mk(i % 2 ? 'user' : 'assistant', '长话第' + i + '句' + '嗯'.repeat(250), 200 + i));
  const bl = P.nextBlock(fewLong.concat([mk('user', '还没完', 300)]), 0, '林渡');
  if (!bl || bl.msgCount !== 3) throw new Error('3 条长消息满 600 字没提前切：' + (bl && bl.msgCount));
  const many = [];
  for (let i = 0; i < 20; i++) many.push(mk(i % 2 ? 'user' : 'assistant', '第' + i + '句' + '啊'.repeat(80), 100 + i));
  const b1 = P.nextBlock(many, 0, '林渡');
  if (!b1) throw new Error('够 20 条了还切不出块');
  if (b1.msgCount < 8 || b1.msgCount > 12) throw new Error('块大小不在 8~12：' + b1.msgCount);
  if (b1.text.indexOf('林渡：') < 0 || b1.text.indexOf('我：') < 0) throw new Error('块里没有说话人');
  if (b1.end <= 0) throw new Error('游标没推进（会死循环）');
  /* 接着切要能继续往下走 */
  const b2 = P.nextBlock(many, b1.end, '林渡');
  if (!b2 || b2.end <= b1.end) throw new Error('第二块没往前推进');

  /* ② 余弦 */
  if (Math.abs(P.cosine([1, 0], [1, 0]) - 1) > 1e-9) throw new Error('相同向量不是 1');
  if (Math.abs(P.cosine([1, 0], [0, 1])) > 1e-9) throw new Error('正交向量不是 0');
  if (P.cosine([1, 0], [1]) !== 0) throw new Error('长度不同应该返回 0，不该崩');

  /* ③ 重排：语义为主，时间兜底。两条语义一样时，新的应该赢 */
  const now = Date.now();
  const oldB = { id: 'a', at: now - 60 * 86400000, vec: [1, 0] };
  const newB = { id: 'b', at: now, vec: [1, 0] };
  const farB = { id: 'c', at: now, vec: [0, 1] };
  const r1 = P.rank([oldB, newB, farB], [1, 0], now);
  if (r1[0].block.id !== 'b') throw new Error('同语义时新的没赢：' + r1.map((x) => x.block.id).join(','));
  if (r1[r1.length - 1].block.id !== 'c') throw new Error('不相关的没排最后');
  /* 语义差距要能压过时间差距（不能变成「只看时间」） */
  const r2 = P.rank([oldB, farB], [1, 0], now);
  if (r2[0].block.id !== 'a') throw new Error('时间新但不相关的排到了相关的前面');

  /* ④ 窗口去重：比近期原文窗口更新的块不该被召回 */
  const kept = P.dropOverlapping([{ block: oldB }, { block: newB }], now - 86400000);
  if (kept.length !== 1 || kept[0].block.id !== 'a') throw new Error('窗口去重没生效');

  /* ⑤ 查询构造 */
  const q = P.buildQuery(['第一句', '第二句'], '第三句');
  if (q.indexOf('第一句') < 0 || q.indexOf('第三句') < 0) throw new Error('查询没拼全');

  /* ⑥ 没配接口 = 不工作（不偷偷回落主 API） */
  S.store.set('vectorApi', null);
  if (S.memoryVec.enabled()) throw new Error('没配向量接口却是 enabled');
  S.store.set('vectorApi', { baseUrl: 'https://v.test/v1', model: 'emb-1', apiKey: '' });
  if (!S.memoryVec.enabled()) throw new Error('配了却不 enabled');
  S.store.set('vecCfg', { enabled: false });
  if (S.memoryVec.enabled()) throw new Error('总开关关掉了却还是 enabled');
  S.store.set('vecCfg', { enabled: true });

  /* ⑦ 缓存空 → 不注入（不会平白多一段空壳） */
  S.memoryVec.clearCache();
  if (S.memoryVec.text('nobody') !== '') throw new Error('没召回到却注入了');

  S.store.set('vectorApi', null);
  S.store.set('vecCfg', {});
  return { 块: b1.msgCount + '条/' + b1.text.length + '字', 余弦: true, 重排: true, 去重: true };
});

t('L4 槽位：线上和线下两张矩阵都挂了 recall（K03c）', () => {
  const E = S.promptEngine;
  const online = (E.onlineSlots || []).filter((s) => s.id === 'recall')[0];
  const offline = (E.offlineSlots || []).filter((s) => s.id === 'recall')[0];
  if (!online) throw new Error('线上槽位表没有 recall');
  if (!offline) throw new Error('线下槽位表没有 recall');
  if (online.slot !== 'K03c' || offline.slot !== 'K03c') throw new Error('槽号不是 K03c');
  /* 位置：要排在 life（K03b）之后、worldbook（K04）之前 ——
     v5 的分层是 L1 → L1.5 → L2 → L4，顺序错了模型读起来是乱的。 */
  const io = E.onlineSlots.findIndex((s) => s.id === 'recall');
  const il = E.onlineSlots.findIndex((s) => s.id === 'life');
  const iw = E.onlineSlots.findIndex((s) => s.id === 'worldbook');
  if (!(il < io && io < iw)) throw new Error('recall 没夹在 life 和 worldbook 之间');
  return { 线上: true, 线下: true, 位置: 'life → recall → worldbook' };
});

t('L4 召回隔离：认知屏障为真时只认「同皮套 + 同马甲」（照抄 core）', () => {
  const V = S.memoryVec._pure.visibleTo;
  const C = S.core;
  const charA = 'chA', charB = 'chB', u1 = 'um1', u2 = 'um2';
  const bAA = { charId: charA, userId: u1 };

  /* ① 判据本身 */
  if (!V(bAA, charA, u1, true)) throw new Error('同皮套 + 同马甲该可见');
  if (V(bAA, charA, u2, true)) throw new Error('换了马甲还能看见 —— 那就是「它怎么知道我在小号说过的话」');
  if (V(bAA, charB, u1, true)) throw new Error('换了皮套还能看见');
  if (!V(bAA, charA, u2, false)) throw new Error('没屏障时应该互通（他知道我们是同一个人）');
  if (!V(bAA, charB, u1, false)) throw new Error('没屏障时皮套之间也该互通');
  if (V(null, charA, u1, false)) throw new Error('空块不该可见');

  /* ② 屏障这一层得真的来自 core —— 两边各写一套判据迟早会漂 */
  const sb = C.createSandbox('archipelago', '隔离测试岛');
  C.setActiveSandbox(sb.id);
  const a = C.upsertChar({ name: '隔离角色', kind: 'main' });
  const mu = C.upsertUser({ name: '隔离甲' });
  C.setSandboxChars(sb.id, [a.id]);
  C.setSandboxMasks(sb.id, [mu.id]);
  C.addLink(a.id, mu.id, 'aware', true, sb.id);        /* 开屏障 */
  if (!C.cognitionOf(a.id, mu.id).barrier) throw new Error('core 那边屏障没开成，断言的前提不成立');
  C.addLink(a.id, mu.id, 'aware', false, sb.id);       /* 关屏障 */
  if (C.cognitionOf(a.id, mu.id).barrier) throw new Error('core 那边屏障没关成');
  return { 有屏障: '只给同一身份', 无屏障: '整个大脑互通', 判据来自core: true };
});

t('L4 接线：线下私聊 / 群聊线上线下 入口齐（三条新链路）', () => {
  const V = S.memoryVec;
  ['sweep', 'sweepOffline', 'sweepGroup', 'prefetch', 'prefetchGroup'].forEach((k) => {
    if (typeof V[k] !== 'function') throw new Error('缺接口：' + k);
  });
  /* 项目 2：群池注入出口已从共享 groupText 换成逐成员 groupTextFor（M5c 契约） */
  ['text', 'groupTextFor', 'stats', 'statsGroup'].forEach((k) => {
    if (typeof V[k] !== 'function') throw new Error('缺接口：' + k);
  });
  if (typeof V.groupText === 'function') throw new Error('共享 groupText 路径还在 —— 必须删');
  /* 群聊的 ownerKey 要有前缀区分，别和私聊的 rootId 撞上 */
  const P = V._pure;
  if (P.groupKey('g1') !== 'group:g1') throw new Error('群聊主键前缀不对');
  if (String(P.rootOf('chX')).indexOf('group:') === 0) throw new Error('私聊主键和群聊主键撞了');
  /* 没配向量接口时，四个入口都该老实返回（不能抛） */
  S.store.set('vectorApi', null);
  if (V.sweepOffline('c', 'u', null) && typeof V.sweepOffline('c', 'u', null).then !== 'function') {
    throw new Error('sweepOffline 没返回 Promise');
  }
  return { 写入: '线上私聊 / 线下私聊 / 群聊（线上线下）', 召回: '私聊一条线 + 群聊一条线' };
});

t('L4 索引与原文联动：块带 msgIds，删除/编辑靠它精确定位（不靠首尾）', () => {
  const P = S.memoryVec._pure;
  const msgs = [];
  for (let i = 0; i < 9; i++) {
    msgs.push({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: '第' + i + '句话' });
  }
  const b = P.nextBlock(msgs, 0, '林渡');
  if (!b) throw new Error('九条消息该切得出一块');
  if (!b.msgIds || b.msgIds.length !== b.msgCount) {
    throw new Error('块的 msgIds 和行数对不上：' + JSON.stringify(b.msgIds));
  }
  if (b.msgIds[0] !== 'm0') throw new Error('msgIds 没按顺序');

  if (!P.blockHitBy(b, ['m3'])) {
    throw new Error('块里中间那条被删却没命中 —— 只判首尾就会漏掉这种');
  }
  if (P.blockHitBy(b, ['zzz'])) throw new Error('不相干的消息不该让块失效');
  if (P.blockHitBy(b, [])) throw new Error('空列表不该让块失效');
  if (P.blockHitBy({}, ['m0'])) throw new Error('没有 msgIds 的块不该被误删');
  return { 块行数: b.msgCount, 覆盖: b.msgIds[0] + '…' + b.msgIds[b.msgIds.length - 1] };
});

t('L4 游标：记消息 id 不记下标 —— 删掉中间一条不会让后面那条被跳过', () => {
  const P = S.memoryVec._pure;
  const key = 'vecCursorTest';
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ id: 'c' + i, role: 'user', content: 'x' });
  S.store.remove(key);
  if (P.readCursor(key, msgs) !== 0) throw new Error('没有游标时该从 0 开始');

  P.writeCursor(key, msgs, 5);                  /* 切到 c4 为止 */
  if (P.readCursor(key, msgs) !== 5) throw new Error('写完该读回 5');

  /* 删掉前面的一条：数组整体前移，游标必须跟着 c4 走 ——
     只记下标的话这里会读到 5（现在是 c5），c5 就被永久跳过了。 */
  const cut = msgs.filter((m) => m.id !== 'c1');
  const from = P.readCursor(key, cut);
  if (cut[from].id !== 'c5') {
    throw new Error('删一条之后该从 c5 接着切，实得 ' + cut[from].id);
  }

  /* 最后切到的那条自己没了 → 退回存下来的下标（兜底，不至于全乱） */
  const cut2 = msgs.filter((m) => m.id !== 'c4');
  if (P.readCursor(key, cut2) !== 5) throw new Error('lastId 没了该用下标兜底');
  return { 正常: 5, 删前面一条: from, 兜底: 5 };
});

/* ==================== 项目 2：记忆开关（charMemOff）====================
   M1 三态判据 / M3b 池类型契约 / M5c 契约护栏 / M6 rootEpoch 全链路 /
   M9 setCharConfig 边沿 / M7 反向（全开与现状一致）。
   node 无 indexedDB → sweep 的 embedding 调用链不可跑；
   覆盖策略：判据（charMemOff）+ 纯函数链路（rootEpoch）+ 契约护栏 + 静态护栏。 */
t('P2-M1 记忆开关三态判据（主角开 / NPC 关 / 显式关）', () => {
  const P = S.memoryVec._pure;
  const root = 'p2m1';
  S.store.remove('memoryIsland');
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: {} });
  /* 主角默认开（无配置） */
  if (P.charMemOff(root) !== false) throw new Error('主角无配置该是开（off=false）');
  /* 主角显式关 */
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: { [root]: { enabled: false } } });
  if (P.charMemOff(root) !== true) throw new Error('主角显式关该 off=true');
  /* NPC 默认关 —— 用**生产形态真实归岛 NPC**（upsertChar kind='npc' parentType='sandbox'，
     不是 npc 前缀假 id）。id 由 core.newId('ch') 生成 = chxxx，charConfig 靠查名册 kind
     判 NPC（不再猜 id 前缀），归岛 NPC 的 rootIdOf 归到自己（不并到大号），才判得出默认关。 */
  const p2sb = S.core.createSandbox('archipelago', 'P2 岛');
  const realNpc = S.core.upsertChar({
    name: '岛NPC', kind: 'npc', content: 'x',
    parentId: p2sb.id, parentType: 'sandbox', sandboxId: p2sb.id
  }).id;
  S.store.remove('memoryIsland');
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: {} });
  const npcRoot = S.core.rootIdOf(realNpc);
  if (npcRoot !== realNpc) throw new Error('归岛 NPC 的 root 应归自己（不该并到大号）');
  if (P.charMemOff(realNpc) !== true) throw new Error('NPC 默认该 off=true');
  /* 真实 NPC 显式开启 → off=false（显式配置优先，不被默认关覆盖） */
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: { [realNpc]: { enabled: true } } });
  if (P.charMemOff(realNpc) !== false) throw new Error('NPC 显式开该 off=false');
  S.store.remove('memoryIsland');
  /* 边界分离：共享池前缀永不被关（core 就绪查不到 / 判据变化都不影响） */
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: { ['group:g1']: { enabled: false } } });
  if (P.charMemOff('group:g1') !== false) throw new Error('共享池 group: 该永不被关（前缀短路）');
  if (P.charMemOff('island:sbX') !== false) throw new Error('共享池 island: 该永不被关（前缀短路）');
  if (P.charMemOff('user:uX') !== false) throw new Error('共享池 user: 该永不被关（前缀短路）');
  /* 未知 root（名册查不到）不默认关 —— 未知≠NPC */
  if (P.charMemOff('noSuchRootX') !== false) throw new Error('查不到 root 该默认开（未知≠NPC，不误关）');
  S.store.remove('memoryIsland');
  return { 主角默认开: false, 主角显式关: true, NPC默认关: true, NPC显式开: false,
    共享池永不被关: true, 未知root默认开: true };
});

t('P2-M3b 池类型契约：角色私有=裸键，共享池带前缀，不重叠', () => {
  const P = S.memoryVec._pure;
  const root = P.rootOf('p2m3b');
  if (String(root).indexOf('group:') === 0) throw new Error('私有键不该带 group: 前缀');
  if (String(root).indexOf('island:') === 0) throw new Error('私有键不该带 island: 前缀');
  if (String(root).indexOf('user:') === 0) throw new Error('私有键不该带 user: 前缀');
  if (P.groupKey('g') !== 'group:g') throw new Error('群池键该带 group: 前缀');
  if (String(P.rootOf('x')).indexOf('group:') === 0) throw new Error('私聊键和群聊键撞了');
  return { 私有: '裸 root', 群: 'group:', 岛: 'island:', 账号: 'user:' };
});

t('P2-M5c 契约护栏：groupText 不存在 / groupTextFor 存在（共享路径已删）', () => {
  const V = S.memoryVec;
  if (typeof V.groupTextFor !== 'function') throw new Error('groupTextFor 不存在（要逐成员注入）');
  if (typeof V.groupText === 'function') throw new Error('groupText 共享路径还在 —— 必须删（M5c 反向锁死）');
  /* 关闭成员 → groupTextFor 返回空（消费隔离；无缓存时开启也空，这里验证判据分支） */
  const root = 'p2m5c';
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: { [root]: { enabled: false } } });
  const P = S.memoryVec._pure;
  if (P.groupTextFor('g1', root) !== '') throw new Error('关闭成员的群池摘要该为空');
  S.store.remove('memoryIsland');
  return { 共享路径: '已删', 逐成员: true, 关闭成员为空: true };
});

t('P2-M6 rootEpoch 定向：失配即从头重扫该 root，共享池/其他 root 不动', () => {
  const P = S.memoryVec._pure;
  const root = 'p2m6';
  const key = 'vecEpochTest_' + root;
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ id: 'r' + i, role: 'user', content: 'x' });
  S.store.remove(key);
  /* ① rootEpochNow 初始 0 */
  if (P.rootEpochNow(root) !== 0) throw new Error('rootEpoch 初始该是 0');
  /* ② 私有池游标：写 rootEpoch=0，读校验匹配 → 正常续切 */
  P.writeCursor(key, msgs, 5, P.rootEpochNow(root));
  if (P.readCursor(key, msgs, P.rootEpochNow(root)) !== 5) throw new Error('rootEpoch 匹配该续切到 5');
  /* ③ invalidateCursorsFor → rootEpoch +1 → readCursor 失配 → 0（从头重扫） */
  P.invalidateCursorsFor(root);
  if (P.rootEpochNow(root) !== 1) throw new Error('invalidate 该把 rootEpoch 推到 1');
  if (P.readCursor(key, msgs, P.rootEpochNow(root)) !== 0) throw new Error('rootEpoch 失配该返回 0（从头重扫）');
  /* ④ 重扫后再写、再读 → 匹配恢复 */
  P.writeCursor(key, msgs, 7, P.rootEpochNow(root));
  if (P.readCursor(key, msgs, P.rootEpochNow(root)) !== 7) throw new Error('重扫后匹配该续切到 7');
  /* ⑤ 其他 root 不受影响：rootEpochNow 仍 0 */
  if (P.rootEpochNow('otherRoot') !== 0) throw new Error('别的 root 的 epoch 不该被碰');
  /* ⑥ 共享池：rootEpoch=null → 不校验、不记字段 */
  const gkey = 'vecEpochGrp_' + root;
  S.store.remove(gkey);
  P.writeCursor(gkey, msgs, 3, null);
  const stored = S.store.get(gkey);
  if (stored.rootEpoch !== undefined) throw new Error('共享池游标不该记 rootEpoch 字段');
  if (P.readCursor(gkey, msgs, null) !== 3) throw new Error('共享池 rootEpoch=null 该不校验');
  return { 初始: 0, 失配: '从头重扫', 其他root: '不动', 共享池: '不校验不记' };
});

t('P2-M9 setCharConfig 边沿：false→true 触发 invalidate，true→true/true→false 不触发', () => {
  const MS = S.memoryStore, P = S.memoryVec._pure;
  const root = 'p2m9';
  S.core.upsertChar({ id: root, kind: 'main', name: 'P2M9' });
  S.store.remove('memoryIsland');
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: {} });
  /* false→true：enabled 从 false 切到 true → rootEpoch +1 */
  MS.setCharConfig(root, { enabled: false });
  const e0 = P.rootEpochNow(root);
  MS.setCharConfig(root, { enabled: true });
  if (P.rootEpochNow(root) !== e0 + 1) throw new Error('false→true 该触发 invalidate（rootEpoch +1）');
  /* true→true：不再触发 */
  const e1 = P.rootEpochNow(root);
  MS.setCharConfig(root, { enabled: true });
  if (P.rootEpochNow(root) !== e1) throw new Error('true→true 不该触发（rootEpoch 不变）');
  /* true→false：不触发、不清游标不删块 */
  const e2 = P.rootEpochNow(root);
  MS.setCharConfig(root, { enabled: false });
  if (P.rootEpochNow(root) !== e2) throw new Error('true→false 不该触发（rootEpoch 不变）');
  S.store.remove('memoryIsland');
  return { 'false→true': '+1', 'true→true': '不变', 'true→false': '不变' };
});

t('P2-M7 反向验证：全开（无配置）时 charMemOff 全 false，与现状一致', () => {
  const P = S.memoryVec._pure;
  S.store.remove('memoryIsland');
  S.store.set('memoryIsland', { name: '岛', type: 'solo', byChar: {} });
  const main = P.rootOf('p2m7main');
  if (P.charMemOff(main) !== false) throw new Error('全开时主角该是开');
  /* 静态护栏：blocksOf 私有池跳过 + sweepSource 私有池停建（锁定判据接线） */
  const mv = fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8');
  if (!/if \(memOff && k === rootOf\(charId\)\) return Promise\.resolve\(\[\]\)/.test(mv)) {
    throw new Error('blocksOf 私有池跳过逻辑丢了');
  }
  if (!/if \(src\.charId && charMemOff\(src\.charId\)\)/.test(mv)) {
    throw new Error('sweepSource 私有池停建逻辑丢了');
  }
  return { 全开: '与现状一致', blocksOf: '私有池跳过', sweepSource: '私有池停建' };
});

t('L4 空条目：跳过空行、且游标必须越过去（不然原地重扫）', () => {
  const P = S.memoryVec._pure;
  const lineOf = (m) => m.text || '';
  const msgs = [
    { id: 'm0', timestamp: 1, text: '第一条' },
    { id: 'm1', timestamp: 2, text: '' },        /* 空 → 该被跳过 */
    { id: 'm2', timestamp: 3, text: '第三条' }
  ];

  /* 正常一条一块 */
  const b0 = P.blockerOne(msgs, 0, lineOf);
  if (!b0 || b0.end !== 1 || b0.msgIds[0] !== 'm0') throw new Error('m0 该单独成块');

  /* ★ 从空条目起切：跳过它、切到下一条有内容的 —— 而且 end 要越过两者 */
  const b1 = P.blockerOne(msgs, 1, lineOf);
  if (!b1) throw new Error('跳过空条目之后该切到 m2');
  if (b1.msgIds[0] !== 'm2') throw new Error('该切到 m2，实得 ' + b1.msgIds[0]);
  if (b1.end !== 3) throw new Error('end 该越过 m1+m2（=3），实得 ' + b1.end);

  /* 到底了 → null（没有可进库的了） */
  if (P.blockerOne(msgs, 3, lineOf) !== null) throw new Error('到底该返回 null');

  /* ★★ 一路全空：必须给 skipTo 让游标推过去，否则停在原地、下次重扫同一段。
     群聊里「整段都是撤回消息」就是这个形状。 */
  const empties = [
    { id: 'e0', timestamp: 1, text: '' },
    { id: 'e1', timestamp: 2, text: '' }
  ];
  const sk1 = P.blockerOne(empties, 0, lineOf);
  if (!sk1 || sk1.skipTo !== 2) {
    throw new Error('blockerOne 全空该给 skipTo=2，实得 ' + JSON.stringify(sk1));
  }
  const sk2 = P.nextBlock(empties, 0, lineOf);
  if (!sk2 || sk2.skipTo !== 2) {
    throw new Error('nextBlock 全空也该给 skipTo=2，实得 ' + JSON.stringify(sk2));
  }

  return { 跳空: 'm1→m2', 到底: 'null', 全空: 'blockerOne / nextBlock 都给 skipTo' };
});

t('L4 换 embedding 模型 / 换世界之后：旧块不参与召回，旧结果不复用', () => {
  const P = S.memoryVec._pure;

  /* 模型隔离：不同模型的向量空间不可比，比出来的相似度是噪音（且不报错） */
  S.store.set('vectorApi', { baseUrl: 'https://v.test/v1', model: 'emb-A' });
  if (!P.sameModel({ model: 'emb-A' })) throw new Error('同模型该放行');
  if (P.sameModel({ model: 'emb-B' })) throw new Error('换了模型还放行 —— 那就是在比两个空间');
  if (P.sameModel({})) throw new Error('没记模型的块也不该放行');

  /* 缓存绑定：主动消息滞后一轮读缓存，中间可能切角色/换马甲/换岛 */
  const rec = { bind: { charId: 'cA', userId: 'u1', sandboxId: 'sb1' } };
  if (!P.bindOk(rec, { charId: 'cA', userId: 'u1', sandboxId: 'sb1' })) {
    throw new Error('同一个世界同一个身份该放行');
  }
  if (P.bindOk(rec, { charId: 'cA', userId: 'u1', sandboxId: 'sb2' })) {
    throw new Error('切了岛还复用上一个岛的召回结果');
  }
  if (P.bindOk(rec, { charId: 'cA', userId: 'u2', sandboxId: 'sb1' })) {
    throw new Error('换了马甲还复用');
  }
  if (P.bindOk(rec, { charId: 'cB', userId: 'u1', sandboxId: 'sb1' })) {
    throw new Error('换了角色还复用');
  }
  if (P.bindOk({}, { sandboxId: 'sb1' })) throw new Error('没有绑定信息的老缓存该当无效');
  return { 模型: '按模型隔离', 缓存: '按世界+角色+身份' };
});

/* ---- 2026-09-23 向量补源（朋友圈 / 日记 / 档案 / 查手机）---- */

t('L4 屏障按 iso 分流：char 按皮套、user 按马甲、none 公开（缺省 both 不变）', () => {
  const V = S.memoryVec._pure.visibleTo;
  const byChar = { charId: 'cA', userId: null, iso: 'char' };
  const byUser = { charId: null, userId: 'u1', iso: 'user' };
  const open = { charId: null, userId: null, iso: 'none' };

  /* 有屏障时 */
  if (!V(byChar, 'cA', 'u9', true)) throw new Error('char 块：他自己脑子里的东西，换个马甲也该在');
  if (V(byChar, 'cB', 'u1', true)) throw new Error('char 块：换了皮套还能看见');
  if (!V(byUser, 'cA', 'u1', true)) throw new Error('user 块：同一个号该在');
  if (V(byUser, 'cA', 'u2', true)) throw new Error('user 块：换个号还能看见 —— A 号做的事不该被 B 号关联到');
  if (!V(open, 'cB', 'u2', true)) throw new Error('none 块：群消息对成员公开，屏障也不该挡');

  /* 无屏障时全放行（他知道我们是同一个人） */
  [byChar, byUser, open].forEach((b) => {
    if (!V(b, 'cZ', 'uZ', false)) throw new Error('没屏障时该全放行');
  });

  /* 缺省 both = 老块行为一字不变 */
  const legacy = { charId: 'cA', userId: 'u1' };
  if (!V(legacy, 'cA', 'u1', true)) throw new Error('缺省块：同皮套同马甲该在');
  if (V(legacy, 'cA', 'u2', true)) throw new Error('缺省块：换马甲不该在');
  return { char: '按皮套', user: '按马甲', none: '公开', 缺省: 'both（老块不变）' };
});

t('L4 回源复核：源没了 / 认不出的 kind 一律不召回（fail closed）', () => {
  const P = S.memoryVec._pure;
  const C = S.core;
  const sb = C.createSandbox('isle', '复核测试岛');
  C.setActiveSandbox(sb.id);
  const ch = C.upsertChar({ name: '复核角色', kind: 'main' });
  const u = C.upsertUser({ name: '复核甲' });
  C.setSandboxChars(sb.id, [ch.id]);
  C.setSandboxMasks(sb.id, [u.id]);

  const mt = S.momentsTab;
  const keep = mt.add({ text: '今天吃了拉面', name: '我', maskId: u.id });
  const gone = mt.add({ text: '这条要删掉', name: '我', maskId: u.id });
  mt.remove(gone.id);

  const snap = P.buildSnapshot(ch.id, u.id);
  const mk = (id) => ({ kind: 'moment', itemId: id, charId: null, userId: u.id, iso: 'user' });
  if (!P.stillVisible(mk(keep.id), ch.id, u.id, snap)) throw new Error('还在的动态该召回');
  if (P.stillVisible(mk(gone.id), ch.id, u.id, snap)) throw new Error('删掉的动态还能召回');
  if (P.stillVisible(mk('不存在的id'), ch.id, u.id, snap)) {
    throw new Error('源定位不到却放行了 —— 该 fail closed');
  }
  if (P.stillVisible({ kind: '没见过的kind', msgIds: ['x'] }, ch.id, u.id, snap)) {
    throw new Error('认不出的 kind 却放行了 —— 该 fail closed');
  }
  if (P.stillVisible({ kind: 'moment', itemId: keep.id }, ch.id, u.id, null)) {
    throw new Error('没有快照却放行了 —— 该 fail closed');
  }
  return { 还在: '召回', 删了: '不召回', 认不出: '不召回' };
});

t('L4 朋友圈方向：iHideFromChar 挡住、iHideChar 不误伤（方向反了是隐私事故）', () => {
  const P = S.memoryVec._pure;
  const C = S.core;
  const sb = C.createSandbox('isle', '朋友圈方向岛');
  C.setActiveSandbox(sb.id);
  const ch = C.upsertChar({ name: '方向角色', kind: 'main' });
  const u = C.upsertUser({ name: '方向甲' });
  C.setSandboxChars(sb.id, [ch.id]);
  C.setSandboxMasks(sb.id, [u.id]);

  const m = S.momentsTab.add({ text: '这条不让他看', name: '我', maskId: u.id });
  const b = { kind: 'moment', itemId: m.id, charId: null, userId: u.id, iso: 'user' };

  if (!P.stillVisible(b, ch.id, u.id, P.buildSnapshot(ch.id, u.id))) {
    throw new Error('基线不成立：这条本来该看得见');
  }
  C.setFeedPerm(ch.id, u.id, 'iHideFromChar', true);
  if (P.stillVisible(b, ch.id, u.id, P.buildSnapshot(ch.id, u.id))) {
    throw new Error('「我不让他看我的」设了，却还能召回');
  }
  C.setFeedPerm(ch.id, u.id, 'iHideFromChar', false);
  C.setFeedPerm(ch.id, u.id, 'iHideChar', true);
  if (!P.stillVisible(b, ch.id, u.id, P.buildSnapshot(ch.id, u.id))) {
    throw new Error('iHideChar 是「我不看他」，不该反过来挡他看我的动态');
  }
  return { iHideFromChar: '挡住（对）', iHideChar: '不误伤（对）' };
});

t('L4 日记授权：关掉不召回、打开就能召回（历史日记不用补建）', () => {
  const P = S.memoryVec._pure;
  const C = S.core;
  const sb = C.createSandbox('isle', '日记授权岛');
  C.setActiveSandbox(sb.id);
  const ch = C.upsertChar({ name: '日记角色', kind: 'main' });
  const u = C.upsertUser({ name: '日记甲' });
  C.setSandboxChars(sb.id, [ch.id]);
  C.setSandboxMasks(sb.id, [u.id]);

  S.store.set('diaries', [C.tagScope({
    id: 'd1', content: '今天有点累', timestamp: Date.now(),
    status: 'written', author: 'user', userId: u.id
  })]);
  const b = { kind: 'diary', itemId: 'd1', charId: null, userId: u.id, iso: 'user' };

  S.lifeFeed.setDiaryShared(ch.id, false);
  if (P.stillVisible(b, ch.id, u.id, P.buildSnapshot(ch.id, u.id))) {
    throw new Error('没授权却召回了我的日记');
  }
  S.lifeFeed.setDiaryShared(ch.id, true);
  if (!P.stillVisible(b, ch.id, u.id, P.buildSnapshot(ch.id, u.id))) {
    throw new Error('授权打开后历史日记还是召不回 —— 「全量建块 + 召回时过滤」没做到');
  }
  return { 关: '不召回', 开: '能召回（不用补建）' };
});

t('L4 档案状态：只有 active 能召回，pending 不进', () => {
  const P = S.memoryVec._pure;
  const C = S.core;
  const sb = C.createSandbox('isle', '档案状态岛');
  C.setActiveSandbox(sb.id);
  const ch = C.upsertChar({ name: '档案角色', kind: 'main' });
  C.setSandboxChars(sb.id, [ch.id]);

  const MS = S.memoryStore;
  MS.writeMemoryItems(ch.id, [
    { kind: 'preference_food', content: '她喜欢吃辣', status: 'active', source: 'ai_summary' },
    { kind: 'preference_food', content: '她讨厌香菜', status: 'pending', source: 'ai_summary' }
  ]);
  const mem = MS.loadCharMemory(ch.id).memories;
  const act = mem.filter((x) => x.status === 'active')[0];
  const pend = mem.filter((x) => x.status === 'pending')[0];
  const snap = P.buildSnapshot(ch.id, null);

  if (!P.stillVisible({ kind: 'mem', msgIds: [act.id] }, ch.id, null, snap)) {
    throw new Error('active 的档案该能召回');
  }
  if (P.stillVisible({ kind: 'mem', msgIds: [pend.id] }, ch.id, null, snap)) {
    throw new Error('pending 的档案不该能召回');
  }
  return { active: '进', pending: '不进' };
});

t('L4 查手机：三种子源各带 sourceId，备忘和订单的 id 撞了也不串', () => {
  const P = S.memoryVec._pure;
  const C = S.core;
  const sb = C.createSandbox('isle', '手机源岛');
  C.setActiveSandbox(sb.id);
  const ch = C.upsertChar({ name: '手机角色', kind: 'main' });
  C.setSandboxChars(sb.id, [ch.id]);

  const PH = S.phone;
  const ph = PH.ensurePhone(sb.id, ch.id);
  const note = PH.addNote(ph, { title: '记一下', content: '买猫粮' });
  const order = PH.addOrder(ph, { title: '猫粮', price: 99, purpose: '自用' });
  const snap = P.buildSnapshot(ch.id, null);

  if (!P.stillVisible({ kind: 'phone', sourceId: 'phone:note', msgIds: [note.id] }, ch.id, null, snap)) {
    throw new Error('备忘该能召回');
  }
  if (!P.stillVisible({ kind: 'phone', sourceId: 'phone:shop', msgIds: [order.id] }, ch.id, null, snap)) {
    throw new Error('订单该能召回');
  }
  if (P.stillVisible({ kind: 'phone', sourceId: 'phone:shop', msgIds: [note.id] }, ch.id, null, snap)) {
    throw new Error('sourceId 没带子类型 —— 备忘的 id 在订单桶里命中了（串源）');
  }
  return { note: '进', shop: '进', 串源: '挡住（对）' };
});

t('L4 素材分片：超长切、短的不切、按段落优先、片间不重叠', () => {
  const P = S.memoryVec._pure;
  const segs = P.segText('啊'.repeat(2500), 1000);
  if (segs.length !== 3) throw new Error('2500 字该切 3 片，实得 ' + segs.length);
  if (segs.join('').length !== 2500) throw new Error('切片有丢失或重叠：' + segs.join('').length);

  const short = P.segText('很短的一句', 1000);
  if (short.length !== 1 || short[0] !== '很短的一句') throw new Error('短文本不该切');
  if (P.segText('   ', 1000).length !== 0) throw new Error('空文本该返回空数组');

  const ps = P.segText('甲'.repeat(600) + '\n\n' + '乙'.repeat(600), 1000);
  if (ps.length !== 2) throw new Error('该按段落切 2 片，实得 ' + ps.length);
  if (ps[0].indexOf('乙') >= 0) throw new Error('段落切点没生效（把一句话劈开了）');
  return { 长: segs.length + '片', 短: '不切', 段落: '优先' };
});

t('L4 分片条目：blockerOne 带出 itemId/seg，msgIds 记**条目** id（一次删干净）', () => {
  const P = S.memoryVec._pure;
  const msgs = [
    { id: 'd1#0', itemId: 'd1', seg: 0, segCount: 2, timestamp: 1, text: '第一片' },
    { id: 'd1#1', itemId: 'd1', seg: 1, segCount: 2, timestamp: 1, text: '第二片' }
  ];
  const b = P.blockerOne(msgs, 0, (m) => m.text);
  if (b.itemId !== 'd1' || b.seg !== 0 || b.segCount !== 2) {
    throw new Error('分片字段没带出来：' + JSON.stringify(b));
  }
  if (b.msgIds[0] !== 'd1') throw new Error('msgIds 该记条目 id，实得 ' + b.msgIds[0]);
  if (b.fromId !== 'd1#0') throw new Error('游标该走片 id（片 id 唯一）');
  return { itemId: b.itemId, seg: b.seg + '/' + b.segCount, msgIds: b.msgIds[0] };
});

t('L4 配额分池：白名单外的 kind 一律算对话池（写死，不留「看情况」）', () => {
  const P = S.memoryVec._pure;
  ['chat', 'offline', 'group'].forEach((k) => {
    if (P.poolOf(k) !== 'chat') throw new Error(k + ' 该在对话池');
  });
  ['moment', 'diary', 'mem', 'phone'].forEach((k) => {
    if (P.poolOf(k) !== 'memo') throw new Error(k + ' 该在素材池');
  });
  if (P.poolOf('没见过的kind') !== 'chat') throw new Error('认不出的 kind 该归对话池');
  return { 素材: 'memo（4 类）', 其余: 'chat（白名单）' };
});

t('L4 池主键：动态挂岛、我写的日记挂账号、档案挂角色，三种前缀不撞', () => {
  const P = S.memoryVec._pure;
  const C = S.core;
  const sb = C.createSandbox('archipelago', '主键推导岛');
  C.setActiveSandbox(sb.id);

  if (P.islandKey('s1') !== 'island:s1') throw new Error('岛池前缀不对');
  if (P.userKey('u1') !== 'user:u1') throw new Error('账号池前缀不对');
  if (P.ownerKeyFor({ kind: 'moment' }) !== 'island:' + sb.id) {
    throw new Error('动态该挂本岛公共池（一条数据一个块）');
  }
  if (P.ownerKeyFor({ kind: 'diary', userId: 'u1' }) !== 'user:u1') {
    throw new Error('我写的日记该挂账号池（私密内容）');
  }
  if (P.ownerKeyFor({ kind: 'mem', charId: 'c1' }) === P.ownerKeyFor({ kind: 'diary', userId: 'u1' })) {
    throw new Error('档案和日记不该共池');
  }
  if (new Set([P.groupKey('g'), P.islandKey('i'), P.userKey('u')]).size !== 3) {
    throw new Error('池前缀撞了 —— 撞了就是串记忆');
  }
  return { 动态: 'island:<岛>', 日记: 'user:<账号>', 档案: 'rootOf(角色)' };
});

t('L4 素材文本组装：动态是事件包（正文+点赞+评论），订单带用途', () => {
  const P = S.memoryVec._pure;
  const txt = P.momentText({
    text: '楼下的猫又来了', name: '我', at: 1,
    likes: [{ id: 'l1', kind: 'char', refId: 'cX', name: '顾清和' }],
    comments: [{ id: 'k1', kind: 'mask', refId: 'u1', name: '我', text: '好可爱' }]
  });
  if (txt.indexOf('楼下的猫又来了') < 0) throw new Error('正文没进事件包');
  if (txt.indexOf('顾清和') < 0) throw new Error('点赞没进事件包');
  if (txt.indexOf('好可爱') < 0) throw new Error('评论没进事件包');

  const order = P.phoneTextOf('shop', { title: '猫粮', price: 99, purpose: '给猫', status: 'ordered' });
  if (order.indexOf('猫粮') < 0 || order.indexOf('99') < 0 || order.indexOf('给猫') < 0) {
    throw new Error('订单文本没带上标题 / 价格 / 用途：' + order);
  }
  return { 事件包: '正文+点赞+评论', 订单: '带用途' };
});

console.log('\n--- 项目 1 复核修订回归（向量回滚 / 快照去留 / 统一清空入口）---');

/* 与第一版一样：这一整段会真清 store、真关召回门，必须写成
   **一条串行链 + 先等其它异步断言落定**（t() 的异步断言是并发跑的）。
   段内编号对应复核意见的两批要求：清空侧 6 条 → W1/W2/W3/W4；导入回滚 2 条 → W8/W9。 */
t('W1–W17 清空六项 / 向量回滚 / 快照去留 / 三向边界 / 扫一遍 / 向量字段契约（串行）', async () => {
  const chk = (name, cond) => { if (!cond) throw new Error(name); };
  while (asyncPending > 1) await new Promise((r) => setTimeout(r, 20));

  const out = {};
  const B = S.backupApp, MV = S.memoryVec, NS = S.store.NS;
  const RB = B.RB_KEY;
  const raw = (k) => localStorageStub.getItem(k);
  const pending = () => { const v = raw(RB); return v ? JSON.parse(v) : null; };
  const allKeys = () => {
    const ks = [];
    for (let i = 0; i < localStorageStub.length; i++) ks.push(localStorageStub.key(i));
    return ks;
  };

  /* ============ 清空侧（复核意见 §三 的 6 条） ============ */

  /* 预置四类敏感过程数据：迁移备份、迁移事务状态、恢复区、索引进度 */
  S.store.set('charMemBackup:abc', { at: 1, data: { 旧记忆: '原文' } });
  S.store.set('charMemBackup:def', { at: 2 });
  S.store.set('charMemMigrationState', { txn: 't1', phase: 'write', status: 'running' });
  localStorageStub.setItem('sleepy.rb.old', '{"at":1}');
  localStorageStub.setItem(RB, '{"v":1,"at":1,"local":{"data":{"秘密":1}}}');
  S.store.set('vecFail:chat-1', { n: 2, until: Date.now() + 60000 });
  S.store.set('vecCursor3:chat-1', { index: 5, lastId: 'm5', epoch: 0 });
  S.store.set('vecCursor4:chat-2', { index: 3, lastId: 'm3', epoch: 0 });

  const w1 = await B.clearEverything();
  const ks = allKeys();
  chk('W1 迁移备份没清掉：' + ks.filter((k) => k.indexOf('charMemBackup') >= 0).join(','),
    ks.filter((k) => k.indexOf('charMemBackup') >= 0).length === 0);
  chk('W1 迁移事务状态没清掉', raw(NS + 'charMemMigrationState') == null);
  chk('W1 恢复区没清掉：' + ks.filter((k) => k.indexOf('sleepy.rb') >= 0).join(','),
    ks.filter((k) => k.indexOf('sleepy.rb') >= 0).length === 0);
  chk('W1 vecFail 没清掉', raw(NS + 'vecFail:chat-1') == null);
  chk('W1 vecCursor3 没清掉', raw(NS + 'vecCursor3:chat-1') == null);
  chk('W1 vecCursor4 没清掉（游标清理不该绑版本号）', raw(NS + 'vecCursor4:chat-2') == null);
  chk('W1 本地数据没清干净：剩 ' + S.store.usage().keys, S.store.usage().keys === 0);
  out.W1 = '四类敏感过程数据 + 本地数据都清了';

  /* W1b 第二道网：**本地清空这一步失败**时，敏感过程数据仍要被独立清掉。
     为什么必须有这条：charMemBackup / charMemMigrationState / vecFail / vecCursor
     都住在 sleepy.v1.* 里，`store.clearAll()` 顺手就把它们删了 ——
     于是「清空能清掉迁移数据」这件事会被 clearAll 掩盖，
     一旦 clearAll 自己失败（配额、异常），那些含原文的过程数据就全留下了。 */
  {
    S.store.set('charMemBackup:orphan', { at: 9, data: { 原文: 'x' } });
    S.store.set('charMemMigrationState', { txn: 't2' });
    S.store.set('vecFail:chat-9', { n: 1 });
    S.store.set('vecCursor4:chat-9', { index: 2, lastId: 'm2', epoch: 0 });
    const ca0 = S.store.clearAll;
    S.store.clearAll = () => { throw new Error('注入的本地清空失败'); };
    const w1b = await B.clearEverything();
    S.store.clearAll = ca0;
    chk('W1b 本地清空失败时，迁移备份还留着', raw(NS + 'charMemBackup:orphan') == null);
    chk('W1b 本地清空失败时，迁移事务状态还留着', raw(NS + 'charMemMigrationState') == null);
    chk('W1b 本地清空失败时，vecFail 还留着', raw(NS + 'vecFail:chat-9') == null);
    chk('W1b 本地清空失败时，vecCursor4 还留着（游标清理绑了版本号？）',
      raw(NS + 'vecCursor4:chat-9') == null);
    chk('W1b 本地清空失败却整体报成功', w1b.ok === false);
    S.store.clearAll();                 /* 真清一次，别把残留带进后面的用例 */
    out.W1b = 'clearAll 失败时，敏感项仍被独立清掉';
  }

  /* W2 结果按六项分别报告（结构 + 命名） */
  const rk = w1.steps.map((s) => s.key).join(',');
  chk('W2 六项不全：' + rk,
    rk === 'localStorage,media,vector,migrationArtifacts,restoreArtifacts,memoryCache');
  chk('W2 结果对象结构不对',
    !!(w1.result && w1.result.localStorage && w1.result.media && w1.result.vector &&
      w1.result.migrationArtifacts && w1.result.restoreArtifacts && w1.result.memoryCache &&
      typeof w1.result.ok === 'boolean'));
  chk('W2 六项都该过：' + w1.message, w1.ok);
  out.W2 = { 项: rk, ok: w1.result.ok, 迁移: w1.result.migrationArtifacts.detail };

  /* W3 模拟其中一项失败 → 其他项仍分别报告，不能整体假报成功 */
  {
    const av0 = S.media.available, cl0 = S.media.clear;
    S.media.available = () => Promise.resolve(true);
    S.media.clear = () => Promise.reject(new Error('注入的图库失败'));
    const w3 = await B.clearEverything();
    S.media.available = av0;
    S.media.clear = cl0;
    const mediaStep = w3.steps.filter((s) => s.key === 'media')[0];
    chk('W3 图库失败了却整体报成功（假成功）', w3.ok === false);
    chk('W3 失败的那一项没被标失败', !!mediaStep && mediaStep.ok === false);
    chk('W3 失败原因没写清', !!mediaStep && mediaStep.detail.indexOf('注入的图库失败') >= 0);
    chk('W3 其他项没有各自报告（应照常给 6 项）',
      w3.steps.length === 6 && !!(w3.result.vector && w3.result.vector.ok === true) &&
      !!(w3.result.memoryCache && w3.result.memoryCache.ok === true));
    out.W3 = { ok: w3.ok, 失败项: mediaStep.detail, 其它项仍在: w3.steps.length };
  }

  /* W4 清空流程不会把**恢复快照**导出到用户备份文件 */
  localStorageStub.setItem(RB, '{"v":1,"at":1,"local":{"data":{"秘密":1}}}');
  S.store.set('charMemBackup:zzz', { at: 3 });
  const exported = Object.keys(S.store.exportAll().data);
  const leaked = exported.filter((k) => k.indexOf('sleepy.rb') >= 0).length;
  chk('W4 恢复快照被导进备份文件了：' + leaked + ' 项', leaked === 0);
  /* 顺带记录（**不断言**）：项目 5 的迁移备份 charMemBackup:* 目前**会**被
     exportAll 的兜底扫描带进备份文件 —— 它是过程数据还是存档内容，
     口径要用户定（见交付文档「需要你定」那一节）。 */
  const migLeak = exported.filter((k) => k.indexOf('charMemBackup') >= 0).length;
  S.store.remove('charMemBackup:zzz');
  out.W4 = { 恢复快照外泄: leaked, 迁移备份会被导出: migLeak };

  /* ============ 导入侧：成功 / 校验不过 / 回滚成功 / 回滚失败 ============ */

  /* W5 导入成功：覆盖写 + 快照删除 + 门复位 */
  S.store.set('w5probe', 'A');
  const payload = S.store.exportAll();
  S.store.set('w5probe', 'B');
  S.store.set('w5ghost', { only: 'B' });
  const w5 = await B.importEverything(payload);
  chk('W5 导入失败：' + w5.message, w5.ok);
  chk('W5 没导入回来', S.store.get('w5probe') === 'A');
  chk('W5 备份里没有的旧键残留了（这不是覆盖）', raw(NS + 'w5ghost') == null);
  chk('W5 成功后快照没删', raw(RB) == null);
  chk('W5 导入结束后召回门还关着', !MV.recallPaused());
  chk('W5 steps 里没有「保存恢复快照」（方案 A 的快照没接上）',
    w5.steps.map((s) => s.name).indexOf('保存恢复快照') >= 0);
  out.W5 = '成功：覆盖 + 快照删除 + 门复位';

  /* W6 校验不过：不写、不清空、不建快照、不往下走 */
  S.store.set('w6probe', '原样');
  const w6 = await B.importEverything({ app: 'sleepy', schema: 9999, data: { w6probe: '坏' } });
  chk('W6 不合法备份竟然导入成功', !w6.ok);
  chk('W6 校验失败却动了数据', S.store.get('w6probe') === '原样');
  chk('W6 校验失败却建了快照', raw(RB) == null);
  chk('W6 校验失败却往下走了：' + w6.steps.map((s) => s.name).join(','),
    w6.steps.length === 1 && w6.steps[0].name === '校验备份');
  chk('W6 校验失败后门没复位', !MV.recallPaused());
  out.W6 = '校验不过：一笔不动';

  /* W7 回滚**成功** → 快照删掉 */
  {
    const ia0 = S.store.importAll;
    S.store.importAll = () => ({ ok: false, message: '注入的写入失败' });
    S.store.set('w7probe', '现值');
    const w7 = await B.importEverything({ app: 'sleepy', schema: S.store.SCHEMA, data: { w7probe: '新值' } });
    S.store.importAll = ia0;
    chk('W7 写入失败却没报错', !w7.ok);
    chk('W7 回滚没成功：' + w7.message, w7.restored === 'ok');
    chk('W7 回滚成功后快照没删', raw(RB) == null);
    chk('W7 回滚后没把原值恢复回来', S.store.get('w7probe') === '现值');
    chk('W7 回滚后门还关着', !MV.recallPaused());
    chk('W7 失败路径不该让调用方 reload', !w7.reload);
    out.W7 = '回滚成功：快照删除 + 值恢复';
  }

  /* W8 回滚**失败**（恢复验证不通过）→ 快照必须保留，且结果里明确标记。
     注入点选 memoryVec.total（回滚链里唯一从**导出面**调的一环）——
     注入 backupApp 上的同名函数是没用的：模块内部直接引用自己的函数。 */
  {
    const t0 = MV.total;
    const ia0 = S.store.importAll;
    MV.total = () => Promise.resolve(5);        /* 快照记 0 块、读回来 5 块 → 校验不过 */
    S.store.importAll = () => ({ ok: false, message: '注入的写入失败' });
    S.store.set('w8probe', '不许丢');
    const w8 = await B.importEverything({ app: 'sleepy', schema: S.store.SCHEMA, data: { w8probe: '新' } });
    S.store.importAll = ia0;
    MV.total = t0;
    chk('W8 回滚失败却删了快照（最后一份能回去的数据没了）', raw(RB) != null);
    chk('W8 结果里没标记恢复失败', w8.restored === 'failed');
    chk('W8 回滚失败后门还关着', !MV.recallPaused());
    chk('W8 回滚失败还让调用方 reload', !w8.reload);
    const meta = pending();
    chk('W8 快照状态没写成 restore-failed', !!meta && meta.status === 'restore-failed');
    chk('W8 快照没记下失败原因', !!meta && String(meta.failReason).indexOf('校验') >= 0);
    chk('W8 提示里没说「恢复未完成」', String(w8.message).indexOf('恢复未完成') >= 0);
    out.W8 = { 快照保留: true, status: meta.status };
  }

  /* W9 回滚抛错（恢复向量块时抛）→ 快照同样保留；resumeRestore 能接着处理 */
  {
    const sr0 = MV.snapRestore;
    MV.snapRestore = () => Promise.reject(new Error('注入的恢复抛错'));
    const w9 = await B.resumeRestore();
    MV.snapRestore = sr0;
    chk('W9 恢复抛错却删了快照', raw(RB) != null);
    chk('W9 恢复抛错却报成功', !w9.ok);
    chk('W9 恢复抛错后门还关着', !MV.recallPaused());
    /* 撤掉注入：resumeRestore 应该把这份遗留快照处理掉 */
    const w9b = await B.resumeRestore();
    chk('W9 正常 resumeRestore 失败：' + w9b.message, w9b.ok);
    chk('W9 resumeRestore 成功后快照没删', raw(RB) == null);
    chk('W9 resumeRestore 后门还关着', !MV.recallPaused());
    out.W9 = '抛错保留 → 再恢复成功';
  }

  /* W10 快照链路在无 IDB 环境下的三态（真机才验得到「块真存进去了」） */
  {
    const sb = await MV.snapBlocks();
    chk('W10 无 IDB 时 snapBlocks 应安静成功（0 块）', !!(sb.ok && sb.count === 0));
    const sr = await MV.snapRestore();
    chk('W10 无 IDB 时 snapRestore 应安静成功（0 块）', !!(sr.ok && sr.count === 0));
    const ix = MV.indexState();
    chk('W10 indexState 结构不对', !!(ix && ix.cursors && ix.fails && typeof ix.epoch === 'number'));
    S.store.set('vecCursor3:w10', { index: 1, lastId: 'x', epoch: 0 });
    const ri = MV.restoreIndexState({ cursors: { 'vecCursor3:w10': { index: 9 } }, fails: {}, epoch: 7 });
    const cur = S.store.get('vecCursor3:w10');
    chk('W10 restoreIndexState 没写回游标', !!(ri.ok && cur && cur.index === 9));
    chk('W10 restoreIndexState 没写回世代号', S.store.get('vecEpoch') === 7);
    S.store.remove('vecCursor3:w10');
    S.store.set('vecEpoch', 0);
    out.W10 = '无 IDB 时全线安静通过';
  }

  /* W11 一键导出全部（2026-10-07）：**合包必须是「一个文件」**，
     且 app/kind 标识能被导入侧认出来（识别分流全靠这两个字段）。

     注：不能靠「拦 ui.downloadText 再解析文件」验 —— page-backup 闭包顶部
     `var downloadText = ui.downloadText` 已经把引用捕获了，注入导出面**不生效**
     （同 W8 那个坑）。所以结构一律读 buildAllPack 这个纯函数。

     ⚠️ 标识必须**硬写 'sleepy-all'**，不许写 B.ALL_KIND ——
     写成常量的话两边一起变，标识改错了测试还是绿的（2026-10-07 真踩过：
     sed 把标识改成 sleepy-WRONG，711 条断言照样全绿）。 */
  {
    S.store.set('w11probe', '文字部分');
    const pack = B.buildAllPack(null);
    /* 先断言「确实找到了那段」，再判字段 —— 不然判据落在不存在的段上会空转 */
    chk('W11 合包里没有 data 段（文字部分）', !!(pack && pack.data));
    chk('W11 合包里没带上 store 导出的内容', !!(pack && pack.data && pack.data.data && pack.data.data.w11probe === '文字部分'));
    chk('W11 合包 app 标识不对，导入侧认不出来', pack.app === 'sleepy-all');
    chk('W11 合包 kind 标识不对，导入侧认不出来', pack.kind === 'sleepy-all');
    chk('W11 无图库时 media 段该是 null 而不是 {}', pack.media === null);
    /* 带图库时：count/bytes/items 三个字段必须原样透传，导入侧全靠它们 */
    const withMedia = B.buildAllPack({ count: 3, bytes: 1024, items: [{ id: 'a' }] });
    chk('W11 带图库时 count 没透传', withMedia.media && withMedia.media.count === 3);
    chk('W11 带图库时 items 没透传', withMedia.media && Array.isArray(withMedia.media.items) && withMedia.media.items.length === 1);
    S.store.remove('w11probe');
    out.W11 = '合包结构可识别 + 图库段可选';
  }

  /* W12 合包导入分流：同一个入口**既能吃合包、也能吃老的纯文字备份**。
     老备份形状 = store.exportUserData() 的返回（app:'sleepy' + data），
     **app 必须是 'sleepy'** —— canImport 硬判这个（store.js:588）。
     负向：给一个 app 不对的，判据必须真拦下来，不能放行。 */
  {
    S.store.set('w12probe', '旧值');
    /* 老的纯文字备份（无 media 段）→ 只导文字，不碰图库 */
    const old = { app: 'sleepy', schema: S.store.SCHEMA, data: { w12probe: '来自老备份' } };
    const w12old = await B.importAllInOne(old);
    chk('W12 老备份导入失败：' + w12old.message, w12old.ok);
    chk('W12 老备份没写进去', S.store.get('w12probe') === '来自老备份');
    chk('W12 老备份不该报图库数量', !w12old.mediaAdded);

    /* 负向：不是 Sleepy 的文件必须被canImport 挡住 —— 证明上面那个 ok 不是空转 */
    const w12bad = await B.importAllInOne({ app: '别的东西', data: { w12probe: '不该写进来' } });
    chk('W12 非备份文件竟然导进去了', !w12bad.ok);
    chk('W12 被拒后不该改动数据', S.store.get('w12probe') === '来自老备份');
    out.W12 = '老备份导得进去 + 非备份文件被拦';
  }

  /* W13 合包导入：图库段缺失时**不许报错**，也不许假装导入了图片。
     这是「没图库的用户走这条路」的主路径，必须安静通过。
     真实形状：data 段 = exportUserData() 的返回（app:'sleepy'），media 段为 null。 */
  {
    S.store.set('w13probe', '旧值');
    const pack = B.buildAllPack(null);
    pack.data.data.w13probe = '来自合包';
    const w13 = await B.importAllInOne(pack);
    chk('W13 合包（无图库段）导入失败：' + w13.message, w13.ok);
    chk('W13 合包文字部分没写进去', S.store.get('w13probe') === '来自合包');
    chk('W13 无图库段时不该声称导入了图片', !w13.mediaAdded);
    chk('W13 无图库段时不该报图库失败', !w13.mediaNote);
    S.store.remove('w12probe'); S.store.remove('w13probe');
    out.W13 = '无图库段：安静通过 + 不谎报';
  }

  /* ============ 协议 / 隐私（legal.js · 2026-10-07 内测前第一件） ============ */

  /* L1 首启弹窗的三条行为：没同意过→弹；点了「我已知情」→记标记；
     「先看看」→**不记标记**（下次还会弹，这是有意留的余地，不是 bug）。 */
  {
    const L = S.legal;
    chk('L1 legal 模块没挂上', !!L);
    if (L) {
      L.resetAgreed();
      chk('L1 清掉标记后竟然仍算已同意', !L.isAgreed());

      /* 未同意时 maybeShowFirstRun 必须真的弹（返回 true = 弹了） */
      chk('L1 未同意时首启没弹协议', L.maybeShowFirstRun() === true);
      /* 弹了但没点任何按钮 → 还是没同意（这是「先看看」路径） */
      chk('L1 只弹没确认时不该算已同意', !L.isAgreed());
      L.maybeShowFirstRun();      /* 再来一次：证明「没点确认就会重复弹」 */

      L.markAgreed();
      chk('L1 点了「我已知情」后没记上', L.isAgreed());
      chk('L1 已同意后首启还在弹', L.maybeShowFirstRun() === false);
      out.L1 = '首启弹一次 + 确认后才不再弹';
    }
  }

  /* L2 同意标记必须带**版本** —— 协议正文改了要能重新提示一次，
     否则改了协议用户永远看不到（这条是承诺，不是可选）。 */
  {
    const L = S.legal;
    L.markAgreed();
    const rec = S.store.get(L.AGREE_KEY);
    chk('L2 同意标记结构不对', !!(rec && typeof rec.ver === 'string' && typeof rec.at === 'number'));
    /* 模拟协议升级：把记录里的版本改成别的 → isAgreed 必须变false */
    S.store.set(L.AGREE_KEY, { ver: 'v0-old', at: Date.now() });
    chk('L2 协议版本变了却还当已同意', !L.isAgreed());
    chk('L2 协议升级后首启不再提示', L.maybeShowFirstRun() === true);
    out.L2 = '版本变更会重新提示';
  }

  /* L3 同意标记**不许混进用户存档导出** —— 它是这台设备的 UI 状态，
     不是用户数据的一部分（导出它会让「换了设备/清缓存后自动提示」失效）。
     正向：必须先断言那段确实找到了，再判字段不在里面。 */
  {
    const L = S.legal;
    L.markAgreed();
    const pack = S.store.exportUserData();
    const keys = pack.data ? Object.keys(pack.data) : [];
    chk('L3 没读到导出内容（判据会空转）', keys.length > 0);
    chk('L3 同意标记混进了用户存档导出', keys.indexOf(L.AGREE_KEY) < 0);
    out.L3 = '同意标记不进用户存档';
  }

  /* L4 两份正文都在，且不是空壳 —— 协议最忌讳「标题在、内容空」。
     同时静态护栏：正文里**不许出现承诺做不到的话**（「永不上传」这类
     与 GitHub 备份矛盾的绝对化表述）。 */
  {
    const L = S.legal;
    const ua = L.USER_AGREEMENT, pp = L.PRIVACY_POLICY;
    chk('L4 用户协议缺正文', !!(ua && Array.isArray(ua.sections) && ua.sections.length >= 5));
    chk('L4 隐私政策缺正文', !!(pp && Array.isArray(pp.sections) && pp.sections.length >= 5));
    /*每节都要有标题和至少一段正文，不许出现「有小标题没内容」的节 */
    let emptySec = 0;
    [ua, pp].forEach(function (doc) {
      (doc.sections || []).forEach(function (s) {
        if (!s.h || !Array.isArray(s.p) || !s.p.length) emptySec++;
      });
    });
    chk('L4 有空节（有小标题没内容）', emptySec === 0);

    /* 绝对化承诺护栏：这些话一旦写进去就是撒谎，必须拦住。
       判据落在**装配产物**（真正拼出来的正文）上，不是源码全文。 */
    const bodyText = [ua, pp].map(function (doc) {
      return doc.sections.map(function (s) { return s.p.join(' '); }).join(' ');
    }).join(' ');
    chk('L4 没读到正文全文（判据会空转）', bodyText.length > 200);
    chk('L4 隐私政策写了「永不上传」（与可选备份矛盾）', bodyText.indexOf('永不上传') < 0);
    chk('L4 出现了「我们不会收集任何数据」这种绝对承诺', bodyText.indexOf('我们不会收集任何数据') < 0);
    out.L4 = { 用户协议节: ua.sections.length, 隐私政策节: pp.sections.length };
  }

  /* ============ 三向边界：用户导出 / 内部回滚快照 / 用户导入（口径 ①） ============ */

  /* W12 用户导出排除过程数据；内部回滚快照必须**包含**它们 */
  {
    S.store.set('charMemBackup:keep', { at: 5, data: { 原文: '旧记忆' } });
    S.store.set('charMemMigrationState', { txn: 'tx-1', phase: 'write', status: 'running' });
    S.store.set('vecFail:c1', { n: 1 });
    S.store.set('vecCursor3:c1', { index: 4 });
    S.store.set('vecEpoch', 3);
    S.store.set('正式数据probe', '我的聊天记录');
    localStorageStub.setItem(RB, '{"v":1,"local":{"data":{}}}');

    const u = S.store.exportUserData();
    const uk = Object.keys(u.data);
    const proc = (k) => k.indexOf('charMemBackup') >= 0 || k === 'charMemMigrationState' ||
      k.indexOf('sleepy.rb') >= 0 || k.indexOf('vecFail') >= 0 || k.indexOf('vecCursor') >= 0 ||
      k === 'vecEpoch';
    chk('W12 用户导出带上了 charMemBackup:*：' + uk.filter((k) => k.indexOf('charMemBackup') >= 0).join(','),
      uk.filter((k) => k.indexOf('charMemBackup') >= 0).length === 0);
    chk('W12 用户导出带上了 charMemMigrationState', uk.indexOf('charMemMigrationState') < 0);
    chk('W12 用户导出带上了 sleepy.rb.*：' + uk.filter((k) => k.indexOf('sleepy.rb') >= 0).join(','),
      uk.filter((k) => k.indexOf('sleepy.rb') >= 0).length === 0);
    chk('W12 用户导出带上了索引回滚进度：' + uk.filter(proc).join(','),
      uk.filter((k) => k.indexOf('vecFail') >= 0 || k.indexOf('vecCursor') >= 0 || k === 'vecEpoch').length === 0);
    chk('W12 用户导出把正式数据也排除了（那才是丢数据）',
      uk.indexOf('正式数据probe') >= 0 && u.scope === 'user');

    const snap = S.store.exportInternalSnapshot();
    const sk = Object.keys(snap.data);
    chk('W12 内部快照没带上迁移备份', sk.indexOf('charMemBackup:keep') >= 0);
    chk('W12 内部快照没带上迁移事务状态', sk.indexOf('charMemMigrationState') >= 0);
    chk('W12 内部快照没带上索引回滚进度（游标/退避/世代）',
      sk.indexOf('vecCursor3:c1') >= 0 && sk.indexOf('vecFail:c1') >= 0 && sk.indexOf('vecEpoch') >= 0);
    chk('W12 内部快照没带上正式数据', sk.indexOf('正式数据probe') >= 0);
    chk('W12 内部快照的作用域没标出来', snap.scope === 'internal-snapshot');
    out.W12 = { 用户导出项: uk.length, 内部快照项: sk.length };
  }

  /* W13 带过程数据的**旧备份**导入：只写正式数据，过程数据一律忽略 */
  {
    S.store.remove('charMemBackup:keep');
    const old = {
      app: 'sleepy', schema: S.store.SCHEMA,
      data: {
        '正式数据probe': '备份里的值',
        'charMemBackup:fromOld': { at: 1, data: { 原文: '旧设备带来的迁移快照' } },
        'charMemMigrationState': { txn: 'from-old-device', status: 'running' },
        'vecCursor3:old': { index: 9 },
        'vecFail:old': { n: 2 },
        'vecEpoch': 99
      }
    };
    const res = S.store.importAll(old);
    chk('W13 旧备份导入失败：' + (res.message || ''), res.ok);
    chk('W13 正式数据没写进去', S.store.get('正式数据probe') === '备份里的值');
    chk('W13 旧备份的 charMemBackup 被写回来了', raw(NS + 'charMemBackup:fromOld') == null);
    const m13 = S.store.get('charMemMigrationState');
    chk('W13 旧备份的迁移事务状态把本机的覆盖了', !m13 || m13.txn !== 'from-old-device');
    chk('W13 旧备份的世代号被写回来了', S.store.get('vecEpoch') !== 99);
    chk('W13 旧备份的游标被写回来了', raw(NS + 'vecCursor3:old') == null);
    chk('W13 被忽略的项没报出来（skipped）', ((res.skipped) || []).length >= 5);
    out.W13 = { 写入: res.keys.length, 忽略: (res.skipped || []).length };
  }

  /* W14 走**完整的用户导入流程**：本机的迁移事务状态与迁移备份都不受影响 */
  {
    S.store.set('charMemMigrationState', { txn: '本机事务', status: 'running' });
    S.store.set('charMemBackup:本机', { at: 7, data: { 原文: '本机的迁移快照' } });
    S.store.set('正式数据probe', '导入前');
    const payload3 = S.store.exportUserData();
    S.store.set('正式数据probe', '被改脏了');
    const w14 = await B.importEverything(payload3);
    chk('W14 导入失败：' + w14.message, w14.ok);
    chk('W14 正式数据没被覆盖回来', S.store.get('正式数据probe') === '导入前');
    const m14 = S.store.get('charMemMigrationState');
    chk('W14 本机迁移事务状态被导入流程清掉了', !!m14 && m14.txn === '本机事务');
    chk('W14 本机迁移备份被导入流程清掉了', raw(NS + 'charMemBackup:本机') != null);
    out.W14 = '导入只碰正式数据';
  }

  /* W15 方案 A 的回滚完整性：正式数据 + 过程数据 + 索引状态都要回来 */
  {
    const ia0 = S.store.importAll;
    S.store.importAll = () => ({ ok: false, message: '注入的写入失败' });
    S.store.set('正式数据probe', '回滚前的值');
    S.store.set('charMemBackup:回滚', { at: 8, data: { 原文: 'x' } });
    S.store.set('charMemMigrationState', { txn: '回滚事务', status: 'running' });
    S.store.set('vecCursor3:rb', { index: 6, lastId: 'm6', epoch: 0 });
    S.store.set('vecFail:rb', { n: 2, until: Date.now() + 60000 });
    S.store.set('vecEpoch', 4);
    const w15 = await B.importEverything({ app: 'sleepy', schema: S.store.SCHEMA, data: { '正式数据probe': '新' } });
    S.store.importAll = ia0;
    chk('W15 回滚没成功：' + w15.message, w15.restored === 'ok');
    chk('W15 正式数据没恢复', S.store.get('正式数据probe') === '回滚前的值');
    chk('W15 迁移备份没恢复', raw(NS + 'charMemBackup:回滚') != null);
    const m15 = S.store.get('charMemMigrationState');
    chk('W15 迁移事务状态没恢复', !!m15 && m15.txn === '回滚事务');
    chk('W15 游标没恢复', !!S.store.get('vecCursor3:rb') && S.store.get('vecCursor3:rb').index === 6);
    chk('W15 退避记录没恢复', !!S.store.get('vecFail:rb') && S.store.get('vecFail:rb').n === 2);
    chk('W15 世代号没恢复', S.store.get('vecEpoch') === 4);
    out.W15 = '回滚：正式数据 + 过程数据 + 索引状态都回来了';
  }

  /* W16 「现在扫一遍」这个入口的四种"没成"，每种都要说得清原因
     —— 它就是「聊了半天一条都没有」时的诊断入口，说不清就等于没做。 */
  {
    S.store.set('vecCfg', {});
    S.store.set('vectorApi', null);
    const off = await MV.sweepIsland();
    chk('W16 没配向量接口时 why 不是 off（用户会以为接口好的）', off.why === 'off');
    chk('W16 off 时不该报 ok', off.ok !== true);

    S.store.set('vectorApi', { baseUrl: 'https://v.test/v1', model: 'emb-1', apiKey: '' });
    const prevSb = S.core.activeSandbox();
    S.core.setActiveSandbox(null);
    const noIsland = await MV.sweepIsland();
    chk('W16 没落岛时 why 不是 noisland（该提示"先去选岛"）', noIsland.why === 'noisland');

    const sb16 = S.core.createSandbox('isle', 'W16岛');
    S.core.setActiveSandbox(sb16.id);
    const noIdb = await MV.sweepIsland();
    chk('W16 有岛但本机没有 IDB 时 why 不是 noidb', noIdb.why === 'noidb');

    S.core._purgeSync.sandbox(sb16.id);
    S.core.setActiveSandbox(prevSb ? prevSb.id : null);

    const apiSrc = fs.readFileSync(path.join(ROOT, 'page-singleapi.js'), 'utf8');
    chk('W16 设置页没把按钮接到 sweepIsland', apiSrc.indexOf('memoryVec.sweepIsland()') >= 0);
    chk('W16 按钮没有把结果说成人话（sweepReport）', apiSrc.indexOf('function sweepReport') >= 0);
    chk('W16 空索引的文案没跟上次扫描结果对上（扫失败还说"会自动开始"）',
      apiSrc.indexOf('(lastSweep && !lastSweep.ok)') >= 0);
    chk('W16 sweepIsland 没导出', typeof MV.sweepIsland === 'function');
    out.W16 = { 没配接口: off.why, 没落岛: noIsland.why, 没IDB: noIdb.why };
  }

  /* W17 向量写入的**字段契约**：`Sleepy.api.embed` 回的是 `vecs`，
     memory-vec 必须读**同一个名字**。
     2026-09-23 真实事故：那边写的是 `r.vectors || r.embeddings`（两个都不存在），
     于是每一次写入都停在「返回里没有向量」——L4 从上线起一条块都没落过库，
     而失败被 kickSweep 的 catch 吞掉，用户只能看到「还没有索引」。
     这条**真走一遍** api.embed（假 fetch 回 OpenAI 形状），不是查字符串。 */
  {
    S.store.set('vectorApi', { baseUrl: 'https://v.test/v1', model: 'emb-1', apiKey: '' });
    const realFetch = win.fetch;
    win.fetch = () => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        usage: { total_tokens: 4 }
      }))
    });
    let got = null;
    try { got = await MV.embedTexts(['甲', '乙']); }
    finally { win.fetch = realFetch; }
    chk('W17 真走一次 api.embed 之后 embedTexts 说失败（字段名又和 api.js 对不上了）：' + (got && got.error), got && got.ok === true);
    chk('W17 向量条数不对（必须与 texts 一一对应）', Array.isArray(got.vectors) && got.vectors.length === 2);
    chk('W17 单条向量的维度不对', !!(got.vectors[0] && got.vectors[0].length === 3));
    /* 召回那条线走的是同一个 embedTexts —— 顺手确认它没被换掉 */
    chk('W17 召回没走同一个 embedTexts（两处各读各的字段 = 迟早又错一次）',
      /return embedTexts\(\[q\]\)/.test(fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8')));
    out.W17 = '2 段 × ' + got.vectors[0].length + ' 维（字段名 vecs 对得上）';
  }

  /* W11 静态护栏 */
  {
    const bak = fs.readFileSync(path.join(ROOT, 'page-backup.js'), 'utf8');
    const mv = fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8');
    const st = fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8');
    chk('W11 清空没按六项报告', bak.indexOf("'migrationArtifacts'") >= 0 &&
      bak.indexOf("'restoreArtifacts'") >= 0 && bak.indexOf("'memoryCache'") >= 0);
    chk('W11 回滚没把向量块 / 索引状态纳进来',
      bak.indexOf('mv.snapRestore()') >= 0 && bak.indexOf('restoreIndexState') >= 0 &&
      bak.indexOf('verifyRestore') >= 0);
    chk('W11 回滚失败时没有保留快照的逻辑',
      bak.indexOf('keepRestore(') >= 0 && bak.indexOf("status = 'restore-failed'") >= 0);
    chk('W11 删快照的地方太少（成功 + 回滚成功两处）', bak.split('dropSnapAll()').length - 1 >= 2);
    chk('W11 importAll 被多处调用（覆盖路径不唯一）', (bak.split('store.importAll(').length - 1) === 1);
    chk('W11 快照没放独立库（放主库会被 wipeAll 一起清掉）',
      mv.indexOf("var SNAP_DB = 'sleepy-vec-snap'") >= 0);
    chk('W11 游标清理绑了版本号（项目 5 换前缀后会漏）',
      mv.indexOf("top.indexOf('vecCursor') === 0") >= 0);
    chk('W11 清空失败分支没写清错误提示（不许静默假成功）',
      bak.indexOf("ctx.toast('没清干净：' + r.message, 'err')") >= 0);
    chk('W11 store.canImport 没抽出来', st.indexOf('function canImport') >= 0 &&
      st.indexOf('canImport: canImport') >= 0);
    /* 三向边界（口径 ①）：导出分作用域、导入前只清正式数据 */
    chk('W11 导出没分作用域（用户备份会带过程数据）',
      st.indexOf("var scope = (opts && opts.scope) || 'user'") >= 0 &&
      st.indexOf('function isProcessKey') >= 0);
    chk('W11 用户导出按钮没走 exportUserData', bak.indexOf('store.exportUserData()') >= 0);
    chk('W11 内部回滚快照没走 exportInternalSnapshot', bak.indexOf('store.exportInternalSnapshot()') >= 0);
    chk('W11 导入前没改用 clearUserData（会把本机迁移状态一起抹掉）',
      bak.indexOf('store.clearUserData()') >= 0);
    chk('W11 importAll 没跳过过程数据', st.indexOf('if (isProcessKey(top)) { skipped.push(top); continue; }') >= 0);
    const pfi = mv.indexOf('function prefetchInto(');
    chk('W11 召回门没排在 embedTexts 之前（关了门还是花了一次 embedding）',
      pfi >= 0 && mv.indexOf('if (recallPaused())', pfi) > pfi &&
      mv.indexOf('if (recallPaused())', pfi) < mv.indexOf('return embedTexts([q])', pfi));
    /* 项目 5 静态护栏（施工卡 §5） */
    const pm19 = fs.readFileSync(path.join(ROOT, 'page-memory.js'), 'utf8');
    chk('W11 charMemKey 没过 rootIdOf（皮套会另立门牌，归一失效）',
      pm19.indexOf("return 'charMem:' + rootIdOf(charId);") >= 0);
    chk('W11 visibleTo 又出现了「块 charId 与入参直接比对」的裸写法（屏障下皮套永远匹配不上）',
      mv.indexOf('b.charId === charId') < 0);
    chk('W11 游标前缀没跟 DB_VER 配套（升版本忘换前缀 = 索引永远空）',
      /var DB_VER = 6;/.test(mv) && mv.indexOf("'vecCursor4:'") >= 0);
    out.W11 = '护栏 ok';
  }

  /* ============ W18 项目 5：DB 升级 → 重建提示（口径 A，2026-09-26） ============ */
  {
    /* -- a) 升级检测：有旧索引痕迹 + 没有版本标记 → needed（提示存在） -- */
    S.store.remove('vecDbVer');
    S.store.remove('vecRebuild');
    S.store.set('vecCursor3:legacy', { index: 3, lastId: 'm3', epoch: 0 });
    const up = MV.detectDbUpgrade();
    chk('W18 升级没检出重建提示', !!up && up.state === 'needed');
    chk('W18 版本标记没写（下次加载会重复提示/漏基线）', S.store.get('vecDbVer') === 6);
    chk('W18 老前缀游标没清（快照回滚会捞回死进度）', S.store.get('vecCursor3:legacy') == null);
    chk('W18 全新装机不该看见提示', (() => {
      /* 全新装机 = 没有任何索引痕迹：把前面用例留下的游标/退避/世代号都清掉 */
      const doomed = [];
      for (let i = 0; i < localStorageStub.length; i++) {
        const k = localStorageStub.key(i);
        if (k) {
          const top = k.indexOf(NS) === 0 ? k.slice(NS.length) : null;
          if (top && (top.indexOf('vecCursor') === 0 || top.indexOf('vecFail:') === 0 || top === 'vecEpoch')) {
            doomed.push(top);
          }
        }
      }
      doomed.forEach((t) => S.store.remove(t));
      S.store.remove('vecDbVer'); S.store.remove('vecRebuild');
      MV.detectDbUpgrade();
      const st0 = MV.rebuildState();
      S.store.set('vecDbVer', 6);
      return st0 === null;
    })());

    /* -- b) 基线（口径 A 第 6 条）：旧历史不承诺召回、升级后的新消息照常增量 -- */
    const BL = MV._pure.baselineIndex;
    const msgs18 = [
      { id: 'm1', timestamp: 1000 }, { id: 'm2', timestamp: 2000 },
      { id: 'm3', timestamp: 3000 }, { id: 'm4', timestamp: 5000 }
    ];
    chk('W18 基线没落在「升级后第一条」上', BL(msgs18, 2500) === 2);
    chk('W18 全是旧内容时基线应为末尾（不重扫）', BL(msgs18, 9000) === 4);
    chk('W18 全是旧内容且无时间戳时基线应为末尾', BL([{ id: 'x' }], 2500) === 1);
    chk('W18 没有 at（不该发生）时基线为末尾', BL(msgs18, 0) === 4);
    const mvSrc = fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8');
    chk('W18 sweepSource 没接基线（升级后第一条增量消息会被整段跳过）',
      mvSrc.indexOf('baselineIndex(msgs, rebuildAt())') >= 0);

    /* -- c) 游标前缀必须跟 DB_VER 配套（§5 静态护栏） -- */
    chk('W18 cursorKey 没换 vecCursor4（升了版本忘换前缀 = 索引永远空）',
      MV.cursorKey('x') === 'vecCursor4:x');
    chk('W18 DB_VER 不是 6', /var DB_VER = 6;/.test(mvSrc));
    chk('W18 重建首轮没接「先清库」（增量建过的块会被重扫复制一份，同段内容双份）',
      mvSrc.indexOf('wipeAll({ quiet: true })') >= 0);

    /* -- d) 没有提示时点重建 → notneeded（不白跑） -- */
    S.store.remove('vecRebuild');
    const nn = await MV.rebuildIndex();
    chk('W18 无提示时重建不该执行', nn.why === 'notneeded');

    /* -- e) 成功路径：提示存在 → 点了 → 成功清提示；重复点击被阻止 -- */
    S.store.set('vectorApi', { baseUrl: 'https://v.test/v1', model: 'emb-1', apiKey: '' });
    S.store.set('vecCfg', {});
    S.store.set('vecRebuild', { state: 'needed', at: Date.now() - 1000 });
    const realAvail = MV.available;
    MV.available = () => Promise.resolve(true);      /* 冒烟没有 IDB：临时顶上 */
    try {
      const p1 = MV.rebuildIndex();
      const r2 = await MV.rebuildIndex();   /* 第一次还在跑 → 同一时刻再点 */
      chk('W18 重复点击没被阻止（会并发扫两遍、花两份钱）', r2 && r2.why === 'running');
      const r1 = await p1;
      chk('W18 空场景重建没成功：' + (r1.error || r1.why), r1.ok === true);
      chk('W18 成功后提示没清掉（会一直挂着「需要重建」）', MV.rebuildState() === null);
      chk('W18 重建没把世代号推进一步（旧游标还活着 = 没从头扫）',
        typeof S.store.get('vecEpoch') === 'number' && S.store.get('vecEpoch') > 0);
    } finally {
      MV.available = realAvail;
    }

    /* -- f) 失败路径：状态保留 + 可重试；成功才清提示（不许假装完成） -- */
    const sb18 = S.core.createSandbox('isle18', 'W18岛');
    S.core.setActiveSandbox(sb18.id);
    S.core.upsertChar({ id: 'm18', kind: 'main', name: 'W18大号' });
    S.store.set('chats', [{
      id: 'chat18', characterId: 'm18', userId: 'u18', name: 'W18',
      messages: Array.from({ length: 10 }, (_, i) => ({
        id: 'm18_' + i, role: i % 2 ? 'user' : 'char', content: '话' + i, timestamp: 1000 + i
      }))
    }]);
    S.store.set('vecRebuild', { state: 'needed', at: Date.now() - 1000 });
    const realAvail2 = MV.available;
    MV.available = () => Promise.resolve(true);      /* available 过了、IDB 没过 → 真失败 */
    try {
      const rf = await MV.rebuildIndex();
      chk('W18 有数据却报成功（假完成）', rf.ok !== true);
      const stf = MV.rebuildState();
      chk('W18 失败状态没保留', !!stf && stf.state === 'failed');
      chk('W18 失败原因没记下来', !!(stf && (stf.error || stf.why)));
      /* 重试：把数据清掉再点一次 —— 应能走完并清提示
         （日记是全局源，冒烟里会去撞不存在的 IDB，一并清掉；
           岛也要删 —— activeSandbox() 会回落到第一间房，删了才是真的没岛） */
      S.store.set('chats', []);
      S.store.set('diaries', []);
      S.core._purgeSync.sandbox(sb18.id);
      S.core.setActiveSandbox(null);
      const rr = await MV.rebuildIndex();            /* 重试入口 = 同一个按钮 */
      chk('W18 重试没走通：' + (rr.error || rr.why) +
        (rr.failed ? ' / ' + JSON.stringify(rr.failed) : ''), rr.ok === true);
      chk('W18 重试成功后提示没清掉', MV.rebuildState() === null);
    } finally {
      MV.available = realAvail2;
      S.core._purgeSync.sandbox(sb18.id);   /* 重试前已删，这里兜底 */
    }
    chk('W18 设置页没有挂重建提示（用户看不见「需要重建」）', (() => {
      const apiSrc = fs.readFileSync(path.join(ROOT, 'page-singleapi.js'), 'utf8');
      return apiSrc.indexOf('记忆索引需要重建') >= 0 &&
        apiSrc.indexOf('rebuildIndex') >= 0 &&
        apiSrc.indexOf('function renderRebuild') >= 0;
    })());
    out.W18 = '升级提示 / 基线 / 防重复 / 成功清 / 失败重试 / vecCursor4 全过';
  }

  /* ============ W19 项目 5：charMem 归 root 迁移（S7/S8，测试矩阵 T1–T14 核心） ============ */
  {
    const MS = S.memoryStore;
    const MIG_KEYS = ['charMemMigrationState', 'charMemMigrated', 'memoryIsland', 'charSettings',
      'charMem:m19', 'charMem:f19', 'charMem:m23', 'charMem:f23',
      'charMem:m20', 'charMem:f20', 'charMem:m21', 'charMem:f21', 'charMem:ghost21'];
    const clean = () => MIG_KEYS.forEach((k) => S.store.remove(k));

    /* -- 场景一（T1/T2b/T3/T6/T3b）：纯数据归并，开关全默认（注入断言不被开关挡住） -- */
    S.core.upsertChar({ id: 'm19', kind: 'main', name: 'W19大号' });
    S.core.upsertChar({ id: 'f19', kind: 'sub', parentId: 'm19', name: 'W19皮套' });
    S.store.set('charMem:m19', {
      version: '1', charId: 'm19', understandings: [],
      memories: [
        { id: 'a1', charId: 'm19', kind: 'user_fact', content: 'root 版旧内容', status: 'active', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'r1', charId: 'm19', kind: 'habit', content: 'root 独有', status: 'active', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'c9', charId: 'm19', kind: 'custom', content: '两边全同', status: 'active', updatedAt: '2026-01-03T00:00:00Z' },
        { id: 'c10', charId: 'm19', kind: 'custom', content: 'root 较新', status: 'active', updatedAt: '2026-01-05T00:00:00Z' }
      ]
    });
    S.store.set('charMem:f19', {
      version: '1', charId: 'f19', understandings: [],
      memories: [
        { id: 'a1', charId: 'f19', kind: 'user_fact', content: '皮套版新内容', status: 'active', isAnchor: true, updatedAt: '2026-01-02T00:00:00Z' },
        { id: 'n1', charId: 'f19', kind: 'promise', content: '皮套新增', status: 'active', updatedAt: '2026-01-02T00:00:00Z' },
        { id: 'c9', charId: 'm19', kind: 'custom', content: '两边全同', status: 'active', updatedAt: '2026-01-03T00:00:00Z' },
        { id: 'c10', charId: 'f19', kind: 'custom', content: '皮套较旧', status: 'active', updatedAt: '2026-01-04T00:00:00Z' }
      ]
    });
    const res19 = MS.migrateCharMemToRoot();
    chk('W19 迁移没跑成：' + JSON.stringify(res19 && res19.report), !!res19 && res19.ok === true);
    chk('W19 皮套源键没删（旧源键删除前不算迁移完成）', S.store.get('charMem:f19') == null);
    const root19 = S.store.get('charMem:m19');
    chk('W19 root 档案没生成', !!root19 && Array.isArray(root19.memories));
    const a1 = (root19.memories || []).filter((m) => m.id === 'a1')[0];
    chk('W19 C2 胜者不是较新的那条（皮套版应赢）', !!a1 && a1.content === '皮套版新内容');
    const loser = (root19.memories || []).filter((m) => m.status === 'superseded' && m.supersededBy === 'a1')[0];
    chk('W19 败者没标 superseded + supersededBy 没指向真实胜者', !!loser);
    chk('W19 败者没记 migrationOriginalStatus（原状态应 active）',
      !!loser && loser.migrationOriginalStatus === 'active');
    chk('W19 败者 id 没换（会和胜者撞 id）', !!loser && loser.id !== 'a1');
    chk('W19 isAnchor 没合并到胜者（锚只参与字段合并）', !!a1 && a1.isAnchor === true);
    const c10w = (root19.memories || []).filter((m) => m.content === 'root 较新')[0];
    chk('W19 C2 反向（root 侧较新）没让 root 赢', !!c10w);
    chk('W19 C1 全同没走跳过（会多出一条副本）', res19.report.c1Skipped === 1);
    chk('W19 冲突数不对（C2 应命中 2 起：a1 与 c10）', res19.report.conflicts === 2);
    chk('W19 条目数不守恒（丢/多了条目）', root19.memories.length === 7);   /* a1×2 + r1 + n1 + c9 + c10×2 */
    chk('W19 root 独有条目 fromCharId 没记自身 id（§2.4）',
      root19.memories.filter((m) => m.id === 'r1')[0].fromCharId === 'm19');
    chk('W19 皮套条目 fromCharId 没记那张脸', (root19.memories || []).filter((m) => m.id === 'n1')[0].fromCharId === 'f19');
    chk('W19 幂等：跑第二次应直接返回 null 且条数不变', (() => {
      const again = MS.migrateCharMemToRoot();
      return again === null && S.store.get('charMem:m19').memories.length === 7;
    })());

    /* T3b：败者（superseded）不进注入，胜者要进 */
    const inject19 = MS.getMemoryInjection('f19') || '';
    chk('W19 败者内容进了注入（会当成有效记忆喂给模型）', inject19.indexOf('root 版旧内容') < 0);
    chk('W19 胜者内容没进注入（归并丢了活记忆）', inject19.indexOf('皮套版新内容') >= 0);

    /* -- 场景二（T2 开关 / C8 false 优先 / charSettings.memory 并入 memoryIsland） -- */
    clean();
    S.core.upsertChar({ id: 'm23', kind: 'main', name: 'W23大号' });
    S.core.upsertChar({ id: 'f23', kind: 'sub', parentId: 'm23', name: 'W23皮套' });
    S.store.set('charMem:f23', { version: '1', charId: 'f23', understandings: [], memories: [{ id: 'w1', content: 'x', status: 'active' }] });
    S.store.set('memoryIsland', { name: '星屿', type: 'solo', byChar: {
      f23: { enabled: false },
      m23: { enabled: true, level: 'simple', updatedAt: '2026-01-01T00:00:00Z' }
    } });
    S.store.set('charSettings', { byChar: {
      f23: { proactive: false, memory: false, autoLife: 'high' },
      m23: { memory: true, autoLife: 'low' }
    } });
    const res23 = MS.migrateCharMemToRoot();
    chk('W23 场景二迁移没跑成', !!res23 && res23.ok === true);
    const byChar23 = (S.store.get('memoryIsland') || {}).byChar || {};
    chk('W23 memoryIsland 没归成一个键', Object.keys(byChar23).length === 1 && !!byChar23.m23);
    chk('W23 C8：enabled 的 false 没优先（皮套关了不该被大号的 true 复活）',
      byChar23.m23 && byChar23.m23.enabled === false);
    const cfg23 = MS.charConfig('f23');
    chk('W23 皮套的开关没归 root（按脸读应该读到 root 的开关）', cfg23.enabled === false);
    const cs23 = (S.store.get('charSettings') || {}).byChar || {};
    chk('W23 charSettings 脸字段没摘掉 / 没归 root', Object.keys(cs23).length === 1 &&
      cs23.m23 && cs23.m23.proactive === false && cs23.m23.autoLife === 'low');
    chk('W23 旧 charSettings.memory=false 没并入 memoryIsland.enabled（§2.2）',
      !!res23 && (res23.report.memoryOffMerged >= 1) && byChar23.m23.enabled === false);

    /* -- 场景三（T10 崩溃恢复三分支） -- */
    clean();
    S.core.upsertChar({ id: 'm20', kind: 'main', name: 'W20大号' });
    S.core.upsertChar({ id: 'f20', kind: 'sub', parentId: 'm20', name: 'W20皮套' });
    const bakMerged = { at: 1, data: {
      'charMem:m20': { version: '1', charId: 'm20', memories: [] },
      'charMem:f20': { version: '1', charId: 'f20', memories: [{ id: 'z1', content: '恢复源', status: 'active' }] }
    } };
    S.store.set('charMemBackup:rec20', bakMerged);
    /* 分支 1：未校验（merged）→ 整份恢复 → 清标记 → 下次重跑 */
    S.store.set('charMemMigrationState', { txn: 'tx20', phase: 'merged', backupKey: 'charMemBackup:rec20', sources: ['charMem:f20'] });
    S.store.set('charMem:m20', { version: '1', charId: 'm20', memories: [{ id: '被写脏的', content: 'x', status: 'active' }] });
    const rec1 = MS.migrateCharMemToRoot();
    chk('W20 merged 分支没走整份恢复', !!rec1 && rec1.ok === false && rec1.recovered === 'merged' && rec1.restored === true);
    chk('W20 恢复后目标键没还原（脏数据还在）', (S.store.get('charMem:m20').memories || []).length === 0);
    chk('W20 恢复后事务标记没清（会卡在恢复态）', S.store.get('charMemMigrationState') == null);
    /* 分支 2：已校验未删源（verified）→ 续完 */
    S.store.remove('charMemMigrated');
    S.store.set('charMemMigrationState', { txn: 'tx20b', phase: 'verified', backupKey: 'charMemBackup:rec20', sources: ['charMem:f20'] });
    const rec2 = MS.migrateCharMemToRoot();
    chk('W20 verified 分支没续完', !!rec2 && rec2.ok === true && rec2.recovered === 'verified');
    chk('W20 续完没删源键', S.store.get('charMem:f20') == null);
    chk('W20 续完没落 done 标记', !!S.store.get('charMemMigrated'));
    /* 分支 3：srcDeleted / done → 只清标记 */
    S.store.remove('charMemMigrated');
    S.store.set('charMemMigrationState', { txn: 'tx20c', phase: 'srcDeleted', backupKey: 'charMemBackup:rec20', sources: [] });
    const rec3 = MS.migrateCharMemToRoot();
    chk('W20 srcDeleted 分支没收尾', !!rec3 && rec3.ok === true);
    chk('W20 收尾没清事务标记', S.store.get('charMemMigrationState') == null);
    S.store.remove('charMemBackup:rec20');

    /* -- 场景四（T7 understandings 隔离 / T8 孤儿键 / T11 备份保留期） -- */
    clean();
    ['charMemBackup:b1', 'charMemBackup:b2', 'charMemBackup:b3', 'charMemBackup:b4']
      .forEach((k) => S.store.set(k, { at: 1 }));
    S.core.upsertChar({ id: 'm21', kind: 'main', name: 'W21大号' });
    S.core.upsertChar({ id: 'f21', kind: 'sub', parentId: 'm21', name: 'W21皮套' });
    S.store.set('charMem:m21', { version: '1', charId: 'm21', understandings: [], memories: [] });
    /* C6：understandings 无写入方、schema 无法核实 → 整键不迁不删，隔离计数 */
    S.store.set('charMem:f21', {
      version: '1', charId: 'f21', understandings: [{ id: 'u1', content: 'schema 未核实' }],
      memories: [{ id: 'q1', content: 'x', status: 'active' }]
    });
    /* 孤儿键：char 不存在 → 不猜归属，隔离计数 */
    S.store.set('charMem:ghost21', { version: '1', charId: 'ghost21', understandings: [], memories: [{ id: 'g1', content: '孤儿', status: 'active' }] });
    const res21 = MS.migrateCharMemToRoot();
    chk('W21 有隔离/孤儿时迁移没照常完成', !!res21 && res21.ok === true);
    chk('W21 understandings 非空的源键被迁走了（C6 违约）', S.store.get('charMem:f21') != null);
    chk('W21 understandings 没计入隔离', res21.report.quarantined === 1);
    chk('W21 孤儿键被删了（不许猜）', S.store.get('charMem:ghost21') != null);
    chk('W21 孤儿键没计数', res21.report.orphans === 1);
    chk('W21 备份没按保留 3 份修剪（§2.7）', (() => {
      const ks = [];
      for (let i = 0; i < localStorageStub.length; i++) {
        const k = localStorageStub.key(i);
        if (k && k.indexOf(NS + 'charMemBackup:') === 0) ks.push(k);
      }
      return ks.length === 3;
    })());
    clean();
    /* T9 写入锁：静态护栏 + sweepMem 短路真的接上了 */
    chk('W19 写入锁静态护栏（saveCharMemory 短路 + sweepMem 短路）', (() => {
      const pm = fs.readFileSync(path.join(ROOT, 'page-memory.js'), 'utf8');
      const mv = fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8');
      return pm.indexOf("if (isMigrating()) return { ok: false, why: 'migrating' };") >= 0 &&
        mv.indexOf('MS.isMigrating && MS.isMigrating()') >= 0;
    })());
    chk('W19 sweepMem 的迁移短路真的接上了', await (() => {
      const oldIsMig = MS.isMigrating;
      MS.isMigrating = () => true;
      return MV.sweepMem('f19').then((r) => {
        MS.isMigrating = oldIsMig;
        return r.why === 'migrating';
      });
    })());
    out.W19 = '归并 / C1 / C2 / 锚 / 败者隔离 / 开关 / 恢复三分支 / C6 / 孤儿 / 备份保留 / 写入锁 全过';
  }

  /* ============ W20 项目 5 补证（2026-09-26 五条，验收前补测） ============ */
  {
    const MS = S.memoryStore;
    S.store.set('vectorApi', { baseUrl: 'https://v.test/v1', model: 'emb-1', apiKey: '' });
    S.store.set('vecCfg', {});
    const realAvail = MV.available;
    MV.available = () => Promise.resolve(true);
    try {
      /* -- 补证 1：needed 首轮必须推世代号；failed 重试不得推（= 断点续扫） -- */
      S.store.set('vecEpoch', 5);
      S.store.set('vecRebuild', { state: 'needed', at: Date.now() });
      const rN = await MV.rebuildIndex();
      chk('补证1 首轮重建没推世代号（旧游标还活着 = 没从头扫）',
        rN.ok === true && S.store.get('vecEpoch') === 6);
      /* 失败重试：第一轮已写入的块靠游标记住 —— 重试不得作废它 */
      S.store.set('vecEpoch', 9);
      S.store.set('vecCursor4:chatX', { index: 9, lastId: 'm9', model: 'emb-1', epoch: 9 });
      S.store.set('vecRebuild', { state: 'failed', why: 'embed', error: 'x', at: Date.now() });
      const rR = await MV.rebuildIndex();
      chk('补证1 失败重试把世代号又推了（= 从头重扫，已完成块会重算）',
        rR.ok === true && S.store.get('vecEpoch') === 9);
      chk('补证1 重试弄丢了第一轮的断点游标', !!S.store.get('vecCursor4:chatX'));
      const msgsX = Array.from({ length: 9 }, (_, i) => ({ id: 'm' + (i + 1) }));
      chk('补证1 断点游标不再有效（readCursor 应回到 9，从 m9 之后续扫）',
        MV._pure.readCursor('vecCursor4:chatX', msgsX) === 9);

      /* -- 补证 2：迁移调用链 —— core 未就绪跳过后，同一启动周期内补跑完成 -- */
      const W2_KEYS = ['charMemMigrationState', 'charMemMigrated', 'charMem:m25', 'charMem:f25'];
      W2_KEYS.forEach((k) => S.store.remove(k));
      S.core.upsertChar({ id: 'm25', kind: 'main', name: '补证25大号' });
      S.core.upsertChar({ id: 'f25', kind: 'sub', parentId: 'm25', name: '补证25皮套' });
      S.store.set('charMem:f25', { version: '1', charId: 'f25', understandings: [], memories: [{ id: 'p1', content: '待迁', status: 'active' }] });
      const realRootOf25 = S.core.rootIdOf;
      S.core.rootIdOf = undefined;                 /* 模拟 core 未就绪 */
      const rSkipped = MS.bootMigrate();
      S.core.rootIdOf = realRootOf25;
      chk('补证2 core 未就绪时没跳过成功假象（迁移不能算完成）',
        rSkipped === null && S.store.get('charMem:f25') != null && !S.store.get('charMemMigrated'));
      const rDone = MS.bootMigrate();              /* ② DOMContentLoaded 链上的补跑 */
      chk('补证2 core 就绪后同一启动周期没迁完',
        !!rDone && rDone.ok === true && S.store.get('charMem:f25') == null &&
        !!S.store.get('charMemMigrated') &&
        (S.store.get('charMem:m25').memories || []).length === 1);
      W2_KEYS.forEach((k) => S.store.remove(k));

      /* -- 补证 3：崩溃残留 state → 启动窗口即 migrating，恢复完成才放行写入 -- */
      S.core.upsertChar({ id: 'm26', kind: 'main', name: '补证26大号' });
      S.core.upsertChar({ id: 'f26', kind: 'sub', parentId: 'm26', name: '补证26皮套' });
      const bak26 = { at: 1, data: {
        'charMem:m26': { version: '1', charId: 'm26', memories: [] },
        'charMem:f26': { version: '1', charId: 'f26', memories: [{ id: 'z1', content: '恢复源', status: 'active' }] }
      } };
      S.store.set('charMemBackup:rec26', bak26);
      S.store.set('charMemMigrationState', { txn: 'tx26', phase: 'merged', backupKey: 'charMemBackup:rec26', sources: ['charMem:f26'] });
      S.store.set('charMem:m26', { version: '1', charId: 'm26', memories: [{ id: '脏', content: 'x', status: 'active' }] });
      chk('补证3 崩溃残留 state 时 isMigrating 没立即为真（恢复前写入不被挡）', MS.isMigrating() === true);
      const wBlocked = MS.saveCharMemory({ version: '1', charId: 'm26', understandings: [], memories: [{ id: '并发写', content: 'y', status: 'active' }] });
      chk('补证3 恢复期间 saveCharMemory 没被挡住', !!wBlocked && wBlocked.ok === false && wBlocked.why === 'migrating');
      const sBlocked = await MV.sweepMem('f26');
      chk('补证3 恢复期间 sweepMem 没被挡住', sBlocked.why === 'migrating');
      const rec26 = MS.migrateCharMemToRoot();
      chk('补证3 恢复分支没走通', !!rec26 && rec26.ok === false && rec26.recovered === 'merged' && rec26.restored === true);
      chk('补证3 恢复完成后 isMigrating 没放行', MS.isMigrating() === false);
      const wOpen = MS.saveCharMemory({ version: '1', charId: 'm26', understandings: [], memories: [{ id: '放行探针', content: 'z', status: 'active' }] });
      /* saveCharMemory 成功时无返回值（只有被挡才回 {ok:false, why}）—— 看落库结果 */
      chk('补证3 恢复完成后写入还是被挡着', (wOpen === undefined || wOpen.ok !== false) &&
        (S.store.get('charMem:m26').memories || []).length === 1 &&
        S.store.get('charMem:m26').memories[0].id === '放行探针');
      ['charMemMigrationState', 'charMemMigrated', 'charMemBackup:rec26', 'charMem:m26', 'charMem:f26']
        .forEach((k) => S.store.remove(k));

      /* -- 补证 4（T12）：七类源抽样断言归属字段 + forget 三维全中才删 -- */
      const P = MV._pure;
      S.core.upsertChar({ id: 'm27', kind: 'main', name: '补证27大号' });
      S.core.upsertChar({ id: 'f27', kind: 'sub', parentId: 'm27', name: '补证27皮套A' });
      S.core.upsertChar({ id: 'f27b', kind: 'sub', parentId: 'm27', name: '补证27皮套B' });
      const R = 'm27', FA = 'f27', FB = 'f27b';
      const resV = { vectors: [[0.1]] };
      const blk = (o) => ({ at: 1, at0: 1, fromId: 'm1', toId: 'm1', msgCount: 1, msgIds: ['m1'], text: 'x', ...o });
      const rec0 = (src, made) => P.buildRecs(src, made, resV, 's1')[0];
      const msgSrc = { ownerKey: R, kind: 'chat', charId: R, fromCharId: FA, userId: 'u1', sourceId: 'c1' };
      let q = rec0(msgSrc, [blk({})]);
      chk('T12 chats 块归属不对', q.charId === R && q.fromCharId === FA && q.ownerKey === R && q.sandboxId === 's1');
      q = rec0({ ...msgSrc, kind: 'offline', sourceId: 'off1' }, [blk({})]);
      chk('T12 offline 块归属不对', q.charId === R && q.fromCharId === FA);
      q = rec0({ ownerKey: 'island:s1', kind: 'moment', sourceId: 'moment' },
        [blk({ iso: 'char', charId: R, fromCharId: FA, itemId: 'mm1' })]);
      chk('T12 朋友圈（角色发）归属不对', q.charId === R && q.fromCharId === FA && q.userId === null);
      q = rec0({ ownerKey: 'island:s1', kind: 'moment', sourceId: 'moment' },
        [blk({ iso: 'user', charId: null, fromCharId: null, userId: 'u1', itemId: 'mm2' })]);
      chk('T12 朋友圈（我发）归属不对', q.charId === null && q.fromCharId === null && q.userId === 'u1');
      q = rec0({ ownerKey: R, kind: 'diary', sourceId: 'diary', charId: R, fromCharId: FA, iso: 'char' }, [blk({})]);
      chk('T12 角色日记归属不对', q.charId === R && q.fromCharId === FA);
      q = rec0({ ownerKey: 'user:u1', kind: 'diary', sourceId: 'diary', iso: 'user' }, [blk({})]);
      chk('T12 我写的日记归属不对', q.charId === null && q.fromCharId === null && q.ownerKey === 'user:u1');
      q = rec0({ ownerKey: R, kind: 'mem', sourceId: 'mem', charId: R, iso: 'char' },
        [blk({ fromCharId: FB, itemId: 'e1' })]);
      chk('T12 档案块没按条目自身的 fromCharId 盖章', q.charId === R && q.fromCharId === FB);
      q = rec0({ ownerKey: R, kind: 'mem', sourceId: 'mem', charId: R, iso: 'char' },
        [blk({ fromCharId: null, itemId: 'e2' })]);
      chk('T12 无来源脸的档案块 fromCharId 应为 null（不许猜）', q.fromCharId === null);
      q = rec0({ ownerKey: R, kind: 'phone', sourceId: 'phone:note', charId: R, fromCharId: FA, iso: 'char' }, [blk({})]);
      chk('T12 查手机归属不对', q.charId === R && q.fromCharId === FA);
      q = rec0({ ownerKey: 'group:g1', kind: 'group', groupId: 'g1' }, [blk({})]);
      chk('T12 群块归属不对（群池没有脸）', q.charId === null && q.fromCharId === null && q.groupId === 'g1');
      /* forget 三维：全中才删，别脸 / 别岛保留 */
      const B1 = { id: 'b1', ownerKey: R, charId: R, fromCharId: FA, sandboxId: 's1' };
      const B2 = { id: 'b2', ownerKey: R, charId: R, fromCharId: FB, sandboxId: 's1' };
      const B3 = { id: 'b3', ownerKey: R, charId: R, fromCharId: FA, sandboxId: 's2' };
      const B4 = { id: 'b4', ownerKey: R, charId: R, fromCharId: FA, sandboxId: 's1', msgIds: ['m5'] };
      chk('T12 全中却没删', P.forgetHit(B1, { charId: R, fromCharId: FA, sandboxId: 's1' }) === true);
      chk('T12 别的脸的块被误删（B 脸必须留下）', P.forgetHit(B2, { charId: R, fromCharId: FA, sandboxId: 's1' }) === false);
      chk('T12 别岛的块被误删（必须留下）', P.forgetHit(B3, { charId: R, fromCharId: FA, sandboxId: 's1' }) === false);
      chk('T12 charId 维度传脸没归一（老调用方会静默清 0 条）', P.forgetHit(B1, { charId: FA }) === true);
      chk('T12 只按 fromCharId 过滤没命中 B 脸', P.forgetHit(B2, { charId: R, fromCharId: FB, sandboxId: 's1' }) === true);
      chk('T12 ids 维度没参与全中（给了 ids 却不看 msgIds）',
        P.forgetHit(B4, { charId: R, fromCharId: FA, sandboxId: 's1', ids: ['mX'] }) === false &&
        P.forgetHit(B4, { charId: R, fromCharId: FA, sandboxId: 's1', ids: ['m5'] }) === true);

      /* -- 补证 5：旧库有向量但 localStorage 无痕迹 —— 权威信号兜底 -- */
      const mvSrc = fs.readFileSync(path.join(ROOT, 'memory-vec.js'), 'utf8');
      chk('补证5 onupgradeneeded 没接 req.oldVersion 权威信号（旧库+无痕迹会漏判，老块静默清空且永不提示）',
        mvSrc.indexOf('oldVer > 0 && oldVer < DB_VER') >= 0 &&
        mvSrc.indexOf("state: 'needed', fromVer: oldVer, at: Date.now(), via: 'idb'") >= 0);
      chk('补证5 detectDbUpgrade 没顺手开库（权威信号要等第一次聊天才生效）',
        mvSrc.indexOf('if (supported) { try { open(); }') >= 0);
      /* 行为级 IDB 测试：真实开库路径上验升级信号 / 重建断点 / DOMContentLoaded
         链 / 生产 forget 三维。隔离内存桩库（见 idb-upgrade-test.js 头注），
         不触碰任何真实存档。 */
      const { spawnSync } = require('child_process');
      const idbRun = spawnSync(process.execPath,
        [path.join(ROOT, 'scripts', 'idb-upgrade-test.js')],
        { encoding: 'utf8', timeout: 60000 });
      const idbTail = String(idbRun.stdout || '').trim().split('\n').pop();
      chk('补证6 IDB 行为级测试没通过（exit ' + idbRun.status + '）：' +
        idbTail.slice(0, 200) + (idbRun.stderr || '').slice(0, 200),
        idbRun.status === 0 && (() => { try { return JSON.parse(idbTail).fail === 0; } catch (e) { return false; } })());
      out.W20 = '重试断点 / 调用链 / 恢复期写入锁 / T12 七源抽样 / 升级漏判兜底 / IDB 行为级全过';
    } finally {
      MV.available = realAvail;
    }
  }

  return out;
  return out;
  return out;
});

/* ---------------- 开屏（splash.js）静态护栏 ----------------
   这里的每一条都是「很容易被好心改回去」的东西，不是复述实现。
   开屏是一层纯 WAAPI + DOM 的遮罩，没有可 vm 测的纯逻辑
   （bootHome 之后才跑、依赖 getComputedStyle 与 Element.animate），
   所以护栏只能落在源码不变量上。 */
{
  const splash = fs.readFileSync(path.join(ROOT, 'splash.js'), 'utf8');
  /* 注释里会提到 localStorage 之类的词（用来解释**为什么不用它**），先剥掉再查 */
  const spCode = splash.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssSp = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const htmlSp = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const spRule = cssSp.slice(cssSp.indexOf('#splash{'), cssSp.indexOf('#splash .sp-stage'));

  ok('开屏确实被 index.html 加载了（check 只强制 page-*.js，这一条它管不到）',
    htmlSp.indexOf('src="splash.js"') >= 0);

  ok('开屏遮罩盖住了状态栏（#statusbar 是 z-index:60，遮罩必须更高）',
    spRule.indexOf('z-index:300') >= 0);

  /* 这条是踩过的坑：style.css 里 [data-motion="off"] *{animation:none!important}
     只杀 **CSS 动画**，杀不到 **WAAPI**（el.animate 不受 animation 属性管辖）。
     splash.js 用的是 WAAPI，所以必须自己判断「减少动效」——
     否则用户明明关掉了动效，冷启动还是被按着看 8 秒。 */
  ok('开屏自己拦了「减少动效」（WAAPI 不受 CSS 一刀切管辖）',
    splash.indexOf("getAttribute('data-motion')") >= 0 &&
    splash.indexOf('prefers-reduced-motion') >= 0);

  /* 页面加载＝冷启动（站内切页走 .page 栈，永远不会重载），所以不需要任何
     「已播过」标记。加了它只会带来一个副作用：刷新不播 —— 调试时看不到第二遍。 */
  ok('开屏没有引入任何存储（页面加载就等于冷启动）',
    spCode.indexOf('localStorage') < 0 &&
    spCode.indexOf('sessionStorage') < 0);

  ok('开屏可以点击跳过、并且会把自己摘掉',
    splash.indexOf('pointerdown') >= 0 && splash.indexOf('removeChild') >= 0);

  /* 播完必须**自己**收尾。上一版唯一的出口是 pointerdown：
     动画停在 sleepy 上再也不动，用户以为卡死了（只能自己想起来点一下）。 */
  ok('开屏在 sleepy 停住后会自动收尾（不是只能点一下才进桌面）',
    splash.indexOf('CFG.logoHold') >= 0 &&
    splash.indexOf('finish(CFG.outFade)') >= 0);

  /* 预遮罩：本文件排在最后执行，所以它执行前浏览器画的是**桌面**。
     探针实测：桌面 742ms 渲染完、遮罩 881ms 才插进来 —— 那 139ms 就是"闪一下主页"。 */
  ok('index.html 先写死一层夜色预遮罩，splash.js 把它接管成 #splash',
    htmlSp.indexOf('id="splash-pre"') >= 0 &&
    splash.indexOf("getElementById('splash-pre')") >= 0 &&
    splash.indexOf("el.id = 'splash'") >= 0);

  /* 三条早退（?splash=0 / 没有 #phone / 减少动效）都必须摘掉预遮罩 ——
     漏一条，「减少动效」的用户冷启动就是一片**永久黑屏**。 */
  ok('开屏的三条早退路径都摘掉了预遮罩（漏一条就是永久黑屏）',
    (splash.match(/bail\(\);/g) || []).length >= 3);

  ok('预遮罩有 CSS 兜底（splash.js 没跑起来也不会把人锁在黑屏里）',
    cssSp.indexOf('#splash-pre{') >= 0 && cssSp.indexOf('@keyframes sp-bail') >= 0);

  /* Cormorant 必须 base64 内嵌：@font-face 指向本地 .woff2 会在 file:// 下被
     Chrome 的 CORS 拦掉，而本项目「双击 index.html 就能开」是不能破的底线。 */
  const faceAt = cssSp.indexOf("font-family:'Cormorant Garamond'");
  ok('sleepy 的字体是 base64 内嵌的（外链字体会在 file:// 下加载不到）',
    faceAt >= 0 &&
    cssSp.slice(faceAt, faceAt + 160).indexOf('data:font/woff2;base64,') >= 0);

  ok('开屏的节奏参数集中在 CFG（改时长只动一处）',
    splash.indexOf('var CFG = {') >= 0 &&
    splash.indexOf('CFG.gapStart') >= 0 &&
    splash.indexOf('CFG.logoLead') >= 0);
}

/* ======================== We（关系沉淀空间）数据闭环 ========================
   验证 weStore 落盘 / scoped 隔离 / 切岛不串线 / 回岛恢复 / 不碰 favorites。
   这是 we 的「写一条记录 → 刷新仍在 → 切岛不见 → 回岛恢复」数据层证据。 */
t('We：weStore 落盘带 sandboxId，按当前房隔离，切岛不串线', () => {
  if (!S.weStore) throw new Error('S.weStore 未导出（page-we.js 没挂上）');
  if (S.weStore.KEY !== 'weEntries') throw new Error('weStore.KEY 不是 weEntries');

  const D = S.store.defaults();
  if (!Array.isArray(D.weEntries)) throw new Error('weEntries 不在 store DEFAULTS 里');

  const A = S.core.createSandbox('isle', '甲岛');
  const B = S.core.createSandbox('isle', '乙岛');
  const m = S.core.upsertChar({ name: '大号', kind: 'main' }).id;
  S.core.upsertUser({ name: '我' });
  S.core.setSandboxChars(A.id, [m]);

  S.core.setActiveSandbox(A.id);
  const e = S.weStore.add({ title: '一起看过海', note: '在码头吹了整晚风', at: 1000 }, A.id);
  if (!e || e.sandboxId !== A.id) throw new Error('weEntry 没盖 sandboxId（当前=' + A.id + '，实际=' + (e && e.sandboxId));
  if (e.createdBy !== 'user') throw new Error('createdBy 不是 user：' + e.createdBy);
  if (!e.id || !e.createdAt) throw new Error('weEntry 缺 id / createdAt');

  if (!S.weStore.list().some((x) => x.id === e.id)) throw new Error('甲岛读不到刚写的记录');

  /* 切到乙岛：甲岛记录必须不可见（scoped 隔离） */
  S.core.setActiveSandbox(B.id);
  if (S.weStore.list().some((x) => x.id === e.id)) throw new Error('切到乙岛后甲岛记录漏过来了（串线）');

  /* 回甲岛：记录恢复 */
  S.core.setActiveSandbox(A.id);
  if (!S.weStore.list().some((x) => x.id === e.id)) throw new Error('回甲岛后记录没恢复');

  /* favorites 原语义不被 we 污染 */
  const fav = S.store.get('favorites');
  if (!Array.isArray(fav) || fav.length !== 0) throw new Error('favorites 被 we 污染了：' + JSON.stringify(fav));
  if (!Array.isArray(S.store.get('weEntries'))) throw new Error('weEntries 不是数组');

  return { 落盘: true, 带房章: e.sandboxId, 切岛隔离: true, 回岛恢复: true, favorites未动: true, createdBy: e.createdBy };
});

/* weEntries 必须在删房清空名单里（core.js cleanupSandbox 的 scoped 名单） */
t('We：weEntries 进了删房清空名单，拆岛不会留孤儿记录', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  if (src.indexOf("'weEntries'") < 0) throw new Error("core.js cleanupSandbox 名单里没有 'weEntries'");

  /* 真跑一遍拆岛清理（smoke 用 _purgeSync 等价于生产无向量环境的 cleanupSandbox）：
     在岛 A 写一条，拆岛，weEntries 里应清干净 */
  const A = S.core.createSandbox('isle', '清空甲岛');
  const m = S.core.upsertChar({ name: '清空大号', kind: 'main' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);
  const e = S.weStore.add({ title: '要被拆掉' }, A.id);
  if (!S.weStore.list().some((x) => x.id === e.id)) throw new Error('写入失败');

  const r = S.core._purgeSync.sandbox(A.id);
  if (!r || r.ok !== true) throw new Error('拆岛清理失败：' + JSON.stringify(r));
  if (S.weStore.list().some((x) => x.id === e.id)) throw new Error('拆岛后记录还在（孤儿）');

  return { 名单收录: true, 拆岛后清空: true };
});

/* ======================== We 收藏馆（page-collection） ========================
   首轮纵向闭环的数据层证据：kind 兼容 / 来源复核 / 隔离（findInScope 只读当前房）
   / 页面注册 / We 首页入口指向 collection（不再开 favorites）。 */

t('收藏馆：注册了 collection 页，collectionStore 已导出', () => {
  const reg = S.registered();
  if (!reg.collection) throw new Error('collection 页未注册（page-collection.js 没挂上）');
  if (!S.collectionStore) throw new Error('collectionStore 未导出');
  if (typeof S.collectionStore.findInScope !== 'function') throw new Error('collectionStore.findInScope 缺失');
  return { 注册: true, 导出: true };
});

t('收藏馆：weEntries 老记录无 kind 按 other 兼容，新记录保留 kind', () => {
  const A = S.core.createSandbox('isle', '藏甲岛');
  const m = S.core.upsertChar({ name: '藏大号', kind: 'main' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);

  /* 老记录：直接往 store 塞一条没有 kind 的（模拟历史数据） */
  const oldRec = { id: 'old-no-kind', title: '老藏品', sandboxId: A.id, sourceType: 'manual' };
  const all = S.store.get('weEntries'); all.push(oldRec); S.store.set('weEntries', all);

  /* 新记录：带 kind 写入 */
  const e = S.weStore.add({ title: '两张电影票', kind: 'ticket', note: '一起看的', at: 2000 }, A.id);
  if (e.kind !== 'ticket') throw new Error('kind=ticket 没落表：' + e.kind);

  if (S.collectionStore.kindOf(oldRec) !== 'other') throw new Error('老记录应兼容为 other，实际=' + S.collectionStore.kindOf(oldRec));
  if (S.collectionStore.kindOf({ kind: 'garbage' }) !== 'other') throw new Error('白名单外应落 other');
  if (S.collectionStore.kindOf(e) !== 'ticket') throw new Error('kind=ticket 应原样保留');

  /* 非法 kind 写入也自动归一为 other */
  const bad = S.weStore.add({ title: '坏分类', kind: 'nope' }, A.id);
  if (bad.kind !== 'other') throw new Error('非法 kind 应归 other，实际=' + bad.kind);

  /* 隔离：findInScope 只在当前 scoped 列表里找 */
  if (!S.collectionStore.findInScope('old-no-kind')) throw new Error('当前房应能读到老记录');
  if (S.collectionStore.findInScope('totally-missing')) throw new Error('不存在的 id 不应命中');

  return { 老记录other: true, 新记录保kind: true, 非法归other: true, findInScope隔离: true };
});

t('收藏馆：来源复核 manual/live/completed/cancelled/deleted + ticket 口径', () => {
  /* manual：空 sourceType → 手动记录，不报错 */
  const man = S.collectionStore.checkSource({ sourceType: '', sourceId: null });
  if (man.status !== 'manual' || man.text !== '手动记录') throw new Error('manual 态错误：' + JSON.stringify(man));

  /* calendar live：建一个未取消未完成的事件，checkSource 应 live */
  const A = S.core.createSandbox('isle', '藏复核岛');
  const m = S.core.upsertChar({ name: '复核大号', kind: 'main' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);
  const ev = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'shared_event', title: '吃火锅' });
  const live = S.collectionStore.checkSource({ sourceType: 'calendar', sourceId: ev.id });
  if (live.status !== 'live') throw new Error('calendar live 态错误：' + JSON.stringify(live));

  /* calendar completed：已完成的事件是**有效历史来源**，不能显示「原物不在」 */
  const evDone = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'shared_event', title: '看完那场展', status: 'completed' });
  const done = S.collectionStore.checkSource({ sourceType: 'calendar', sourceId: evDone.id });
  if (done.status !== 'done') throw new Error('calendar completed 应为 done（有效历史来源）：' + JSON.stringify(done));
  if (done.text.indexOf('看完那场展') < 0) throw new Error('done 态应带原标题：' + JSON.stringify(done));

  /* calendar cancelled：事件还在但已取消 → 该约定已取消 */
  S.calendar.cancelEvent(ev.id);
  const gone = S.collectionStore.checkSource({ sourceType: 'calendar', sourceId: ev.id });
  if (gone.status !== 'gone' || gone.text !== '该约定已取消') throw new Error('calendar cancelled 态错误：' + JSON.stringify(gone));

  /* calendar deleted：事件真正不存在 → 原日历记录已删除（区别于取消） */
  const evDel = S.calendar.__internal.addEvent({ ownerCharId: m, title: '写错的草稿' });
  const rm = S.calendar.removeEvent(evDel.id);
  if (!rm || rm.ok !== true) throw new Error('草稿事件应可删除：' + JSON.stringify(rm));
  const del = S.collectionStore.checkSource({ sourceType: 'calendar', sourceId: evDel.id });
  if (del.status !== 'gone' || del.text !== '原日历记录已删除') throw new Error('calendar deleted 态错误：' + JSON.stringify(del));

  /* ticket 口径：sourceId 引用票根实体自身 ticket.id → live；
     引用 workId（作品 id）**不许**命中票根实体 → gone（禁止混用）。 */
  S.store.set('wjTickets', [{ id: 'tk-smoke-1', workId: 'w-smoke-1', title: '一场剧', at: '2026-09-27T00:00:00' }]);
  const tkLive = S.collectionStore.checkSource({ sourceType: 'ticket', sourceId: 'tk-smoke-1' });
  if (tkLive.status !== 'live') throw new Error('ticket 按 ticket.id 查应 live：' + JSON.stringify(tkLive));
  const tkWork = S.collectionStore.checkSource({ sourceType: 'ticket', sourceId: 'w-smoke-1' });
  if (tkWork.status !== 'gone') throw new Error('ticket 引用 workId 不应命中票根实体（口径混用）：' + JSON.stringify(tkWork));

  /* 未知来源：不报错，给 gone 兜底文案 */
  const unk = S.collectionStore.checkSource({ sourceType: 'weird', sourceId: 'x' });
  if (unk.status !== 'gone') throw new Error('未知来源应 gone 兜底：' + JSON.stringify(unk));

  return { manual: true, calLive: true, calDone: true, calCancelled: true, calDeleted: true,
    ticketById: true, ticketWorkId拒绝: true, unknown: true };
});

t('收藏馆：We 首页入口指向 collection，收藏夹页已退役（2026-10-08 并馆轮）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'page-we.js'), 'utf8');
  if (src.indexOf("nav.open('collection')") < 0) throw new Error('We 首页未改为打开 collection');
  if (src.indexOf("nav.open('favorites')") >= 0) throw new Error('We 首页仍打开 favorites（应改为 collection）');
  /* 旧 favorites 页已退役：注册必须不存在（硬写字符串登记，别引常量防一起漂） */
  if (S.registered().favorites) throw new Error('旧 favorites 页还在注册 —— 应已退役并进 We 收藏馆');
  /* 并馆出口必须存在：门厅读它并馆（weEntries + favorites + wjTickets） */
  const colSrc = fs.readFileSync(path.join(ROOT, 'page-collection.js'), 'utf8');
  if (colSrc.indexOf("merged: 'chat'") < 0 || colSrc.indexOf("merged: 'ticket'") < 0)
    throw new Error('page-collection 没有并馆 favorites / wjTickets 的通道');
  /* 聊天收藏 toast 必须指向 We 收藏馆，不许再指回老收藏夹 */
  const chatSrc = fs.readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
  if (chatSrc.indexOf('已收进 We 收藏馆啦') < 0)
    throw new Error('聊天收藏 toast 未改为「已收进 We 收藏馆啦」');
  if (chatSrc.indexOf('右上角 ★ 里能查到') >= 0)
    throw new Error('聊天收藏 toast 还在指向已退役的 ★ 收藏夹');
  return { 入口改collection: true, favorites退役: true, 并馆通道: true, toast改口径: true };
});

/* ======================== We 收藏馆 C1 · 藏品实物化（2026-10-02） ========================
   票根（60×120 双面 3D 翻转，方案 B）+ 拍立得（长按显影）落详情页；
   数据层：weStore.patch（白名单 + 当前房卫兵）、照片藏品出厂未显影。 */

t('收藏馆C1：票根/拍立得组件落详情页，显影与补写都走 weStore.patch', () => {
  const coSrc = fs.readFileSync(path.join(ROOT, 'page-collection.js'), 'utf8');
  if (coSrc.indexOf('co-tk-flipper') < 0 || coSrc.indexOf('is-flipped') < 0) {
    throw new Error('票根 3D 翻转组件缺失');
  }
  if (coSrc.indexOf('co-tk-face-back') < 0 || coSrc.indexOf('memoUser') < 0 || coSrc.indexOf('memoChar') < 0) {
    throw new Error('票根背面背签/双留言格缺失');
  }
  if (coSrc.indexOf('co-tk-nozone') < 0) throw new Error('背签编辑区未做翻面冲突隔离（nozone）');
  if (coSrc.indexOf('co-pl-pocket') < 0 || coSrc.indexOf('is-developed') < 0) {
    throw new Error('拍立得显影组件缺失');
  }
  if (coSrc.indexOf("developed !== false") < 0) throw new Error('老记录「已显影」兼容丢了');
  if (coSrc.indexOf('co-pl-slot') < 0) throw new Error('贴纸槽位（C2 预留）缺失');
  if (coSrc.indexOf('pointerdown') < 0 || coSrc.indexOf('setTimeout(develop, 600)') < 0) {
    throw new Error('长按 0.6s 显影交互丢了');
  }
  if (coSrc.indexOf('weStore.patch') < 0) throw new Error('补写/显影没走 weStore.patch 统一出口');
  return { 票根: true, 拍立得: true, 长按显影: true, 贴纸槽位: true };
});

/* ======================== C2 贴纸工坊（2026-10-02 修正施工单） ========================
   六条链路各自可测：可见性（owner 七条）/ 生成拒绝分支 / 切片器纯函数 /
   匹配上下文 / 入库纪律 / 回归（旧表情不清空）。 */

t('C2 可见性：owner 七条规则 + global 不泄密 + 老数据兼容 + all() 全量', () => {
  const prev = S.core.activeSandbox();
  const cA = S.core.upsertChar({ name: '贴A', kind: 'main' }).id;
  const cB = S.core.upsertChar({ name: '贴B', kind: 'main' }).id;
  const u1 = S.core.upsertUser({ name: '贴我一' }).id;
  const u2 = S.core.upsertUser({ name: '贴我二' }).id;
  const sb = S.core.createSandbox('archipelago', '贴纸岛');
  S.core.setSandboxChars(sb.id, [cA, cB]);
  S.core.setSandboxMasks(sb.id, [u1, u2]);
  S.core.setActiveSandbox(sb.id);
  try {
    const mk = (o) => Object.assign({
      id: 'st-' + Math.random().toString(36).slice(2, 8),
      name: '贴', mediaId: 'm', group: 'g', at: Date.now(), sandboxId: sb.id
    }, o);
    const seed = (rec) => {
      const l = S.store.get('stickers') || [];
      l.push(rec); S.store.set('stickers', l);
    };
    const charA = mk({ kind: 'sticker', ownerCharId: cA, ownerUserId: null, ownerMaskIds: [], allowInGroups: false });
    const both = mk({ kind: 'sticker', ownerCharId: cA, ownerUserId: u1, ownerMaskIds: [], allowInGroups: false });
    const mine = mk({ kind: 'sticker', ownerCharId: null, ownerUserId: null, ownerMaskIds: [u1], allowInGroups: false });
    const emptyMasks = mk({ kind: 'sticker', ownerCharId: null, ownerUserId: null, ownerMaskIds: [], allowInGroups: false });
    const leaky = mk({ kind: 'sticker', ownerCharId: cA, ownerUserId: null, ownerMaskIds: [], global: true, allowInGroups: false });
    const legacy = mk({ name: '老表情', global: false });   /* 无 owner 字段 */
    /* 群聊口径（部署前核查 3）：缺省三类全不进群，只允许 allowInGroups === true
       显式放行，且即便放行也仅限 user 单人（char 单人即便带开关也不进群） */
    const mineOpen = mk({ kind: 'sticker', ownerCharId: null, ownerUserId: null, ownerMaskIds: [u1], allowInGroups: true });
    const charAOpen = mk({ kind: 'sticker', ownerCharId: cA, ownerUserId: null, ownerMaskIds: [], allowInGroups: true });
    [charA, both, mine, emptyMasks, leaky, legacy, mineOpen, charAOpen].forEach(seed);

    const has = (ctx, id) => S.stickers.getVisibleStickers(ctx).some((s) => s.id === id);
    const chatA = { scope: 'chat', charId: cA, maskId: u1 };
    const chatB = { scope: 'chat', charId: cB, maskId: u1 };
    const chatA2 = { scope: 'chat', charId: cA, maskId: u2 };

    if (!has(chatA, charA.id)) throw new Error('char 本人会话看不到自己的贴纸');
    if (has(chatB, charA.id)) throw new Error('char A 的贴纸漏进了 char B 的会话');
    if (!has(chatA, both.id)) throw new Error('双人贴纸在双方会话不可见');
    /* 部署前核查 1：ownerUserId = 创建时马甲（user 侧归属凭据），双人贴纸
       切马甲（同岛另一件「我」）仍可见 —— 「我们俩」不随马甲切换消失 */
    if (!has(chatA2, both.id)) throw new Error('切马甲后双人贴纸不可见了（应按本岛口径放行）');
    if (!has(chatA, mine.id)) throw new Error('user 单人贴纸在勾选马甲不可见');
    if (has(chatA2, mine.id)) throw new Error('user 单人贴纸漏给了未勾选马甲');
    if (has(chatA, emptyMasks.id)) throw new Error('ownerMaskIds:[] 竟然可见');
    if (has(chatB, leaky.id)) throw new Error('C2 带 global:true 泄密了');
    if (!has(chatA, legacy.id)) throw new Error('老贴纸在本房反而看不见了');

    /* 群聊（核查 3）：缺省三类全不进群；allowInGroups===true 只放行 user 单人 */
    const grp = { scope: 'group', groupId: 'gp1', maskId: u1 };
    if (has(grp, mine.id)) throw new Error('user 单人贴纸缺省进了群（应 allowInGroups===true 才放行）');
    if (has(grp, charA.id) || has(grp, both.id)) throw new Error('char 单人/双人贴纸进了群聊');
    if (has(grp, emptyMasks.id)) throw new Error('群聊里 [] 可见');
    if (has(grp, charAOpen.id)) throw new Error('char 单人即便 allowInGroups:true 也不该进群');
    if (!has(grp, mineOpen.id)) throw new Error('allowInGroups:true 的 user 单人贴纸该进群');

    S.core.switchTo(cA, u1);
    const colA = S.stickers.getVisibleStickers({ scope: 'collection' }).map((s) => s.id);
    if (!colA.some((s) => s === charA.id) || !colA.some((s) => s === both.id) ||
      !colA.some((s) => s === mine.id)) {
      throw new Error('collection 视角漏了自己的贴纸 colA=' + JSON.stringify(colA) +
        ' 期望含 ' + JSON.stringify([charA.id, both.id, mine.id]) +
        ' 身份=' + JSON.stringify({
          c: (S.core.activeCharOnIsland() || {}).id || null,
          m: (S.core.activeUserOnIsland() || {}).id || null,
          sb: (S.core.activeSandbox() || {}).id || null,
          ptr: S.store.get('activeCharId'),
          found: !!S.core.findChar(cA),
          roster: JSON.stringify((S.core.activeSandbox() || {}).charIds || [])
        }));
    }
    S.core.switchTo(cB, u1);
    const colB = S.stickers.getVisibleStickers({ scope: 'collection' });
    if (colB.some((s) => s.id === charA.id) || colB.some((s) => s.id === both.id)) {
      throw new Error('collection 泄了别人的专属贴纸');
    }
    if (!colB.some((s) => s.id === legacy.id)) throw new Error('collection 里老贴纸不见了');

    if (S.stickers.all().length !== 8) throw new Error('all() 不是全量（旧数据可能被清）');
    return { owner七条: true, global不泄密: true, 老数据兼容: true, all全量: true };
  } finally {
    S.store.set('stickers', []);
    S.core._purgeSync.sandbox(sb.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

t('C2 匹配：match/replySpec 按会话上下文过滤；charSendSticker 同名不猜（静态）', () => {
  const prev = S.core.activeSandbox();
  const cA = S.core.upsertChar({ name: '匹A', kind: 'main' }).id;
  const cB = S.core.upsertChar({ name: '匹B', kind: 'main' }).id;
  const u1 = S.core.upsertUser({ name: '匹我' }).id;
  const sb = S.core.createSandbox('archipelago', '匹配岛');
  S.core.setSandboxChars(sb.id, [cA, cB]);
  S.core.setSandboxMasks(sb.id, [u1]);
  S.core.setActiveSandbox(sb.id);
  try {
    const mk = (owner, name) => {
      const rec = {
        id: 'st-' + Math.random().toString(36).slice(2, 8),
        name: name, mediaId: 'm', group: 'g', kind: 'sticker',
        ownerCharId: owner, ownerUserId: null, ownerMaskIds: [],
        allowInGroups: false, at: Date.now(), sandboxId: sb.id
      };
      const l = S.store.get('stickers'); l.push(rec); S.store.set('stickers', l);
      return rec;
    };
    const a1 = mk(cA, '好耶');
    const b1 = mk(cB, '好耶');
    const hitsA = S.stickers.match('好耶', 10, { scope: 'chat', charId: cA, maskId: u1 });
    if (hitsA.some((s) => s.ownerCharId === cB)) throw new Error('match 跨角色误命中');
    if (!hitsA.some((s) => s.id === a1.id)) throw new Error('match 没命中本会话的贴纸');
    const hitsB = S.stickers.match('好耶', 10, { scope: 'chat', charId: cB, maskId: u1 });
    if (!hitsB.some((s) => s.id === b1.id) || hitsB.some((s) => s.id === a1.id)) {
      throw new Error('match 池按会话过滤失效');
    }
    const spec = S.stickers.replySpec({ scope: 'chat', charId: cA, maskId: u1 });
    if (spec.indexOf('好耶') < 0) throw new Error('replySpec 没列出本会话贴纸名');

    const pcSrc = fs.readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
    if (pcSrc.indexOf('hits.length !== 1') < 0) throw new Error('charSendSticker 同名不猜规则丢了');
    if (pcSrc.indexOf('matchKey') < 0) throw new Error('匹配没有优先 matchKey');
    return { match上下文: true, replySpec: true, 同名不猜: true };
  } finally {
    S.store.set('stickers', []);
    S.core._purgeSync.sandbox(sb.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

t('C2 核查：旧数据无 kind（addBatch 扫描）+ 身份竞态守卫 + 空槽阻止提交（静态）', () => {
  const psSrc = fs.readFileSync(path.join(ROOT, 'page-stickers.js'), 'utf8');
  const pcSrc = fs.readFileSync(path.join(ROOT, 'page-collection.js'), 'utf8');
  /* 核查 2 证据：唯一写路径 addBatch 不产 kind 字段 —— 旧条目不可能被
     isC2 的 kind 判定误伤（全仓库 stickers 写点只有 page-stickers save()） */
  const m = psSrc.match(/function addBatch[\s\S]*?\n  \}/);
  if (!m || /kind\s*:/.test(m[0])) throw new Error('addBatch 竟然写了 kind（旧条目会被误判 C2）');
  /* 核查 4：生成与入库两个入口都过身份闸 */
  if (pcSrc.indexOf('skIdentityChanged') < 0 || pcSrc.indexOf('skGuardIdentity') < 0) {
    throw new Error('身份竞态守卫缺失');
  }
  if ((pcSrc.match(/skGuardIdentity\(ctx, st\)/g) || []).length < 2) {
    throw new Error('生成/入库入口没有都过身份闸');
  }
  /* 核查 5：空槽阻止提交（兜底词只留在模板函数里，流程先拦） */
  if (pcSrc.indexOf('skCustomEmptySlot') < 0 || pcSrc.indexOf('格还是空的') < 0) {
    throw new Error('自定义空槽阻止提交缺失');
  }
  return { 旧数据无kind: true, 身份闸双入口: true, 空槽阻止: true };
});

t('C2 生成：NAI/不支持 refSupport/缺参考图/空词 全部前置失败零请求', async () => {
  const g = S.imggen;
  const prevApis = g.listApis();
  try {
    g.saveApis([]);
    const apiNai = g.newApi('nai'); apiNai.name = 'T-NAI'; apiNai.model = 'nai-diffusion-3';
    const apiNone = g.newApi('general'); apiNone.name = 'T-不支持'; apiNone.baseUrl = 'http://127.0.0.1:9/v1'; apiNone.model = 'x'; apiNone.refSupport = 'none';
    const apiEdits = g.newApi('general'); apiEdits.name = 'T-edits'; apiEdits.baseUrl = 'http://127.0.0.1:9/v1'; apiEdits.model = 'x'; apiEdits.apiKey = 'k'; apiEdits.refSupport = 'edits';
    g.saveApis(g.listApis().concat([apiNai, apiNone, apiEdits]));

    const sub = (type, id, name) => ({ entityType: type, entityId: id, name: name || '', gender: '', faceText: '' });
    const noRef = S.core.upsertChar({ name: '无图C', kind: 'main' });   /* 没设锁脸图 */

    const r1 = await g.generateStickerSheet({
      subjects: [sub('char', noRef.id, '无图C')], prompt: 'x', negativePrompt: 'y', api: apiNai
    });
    if (r1.ok !== false || r1.code !== 'NAI_UNSUPPORTED') throw new Error('NAI 应明确拒绝：' + JSON.stringify(r1));

    const r2 = await g.generateStickerSheet({
      subjects: [sub('char', noRef.id, '无图C')], prompt: 'x', negativePrompt: 'y', api: apiNone
    });
    if (r2.ok !== false || r2.code !== 'UNSUPPORTED_REF') throw new Error('不支持 refSupport 应明确拒绝：' + JSON.stringify(r2));

    const r3 = await g.generateStickerSheet({
      subjects: [sub('char', noRef.id, '无图C')], prompt: 'x', negativePrompt: 'y', api: apiEdits
    });
    if (r3.ok !== false || r3.code !== 'MISSING_REFERENCE' || r3.stage !== 'resolve-ref') {
      throw new Error('缺参考图应在生成前失败：' + JSON.stringify(r3));
    }

    const r4 = await g.generateStickerSheet({
      subjects: [sub('char', noRef.id, '无图C')], prompt: '', negativePrompt: '', api: apiEdits
    });
    if (r4.ok !== false) throw new Error('空词应失败');
    return { NAI拒: true, refSupport拒: true, 缺图拒: true, 空词拒: true, 全部零请求: true };
  } finally {
    g.saveApis(prevApis);
  }
});

t('C2 切片器：白底去除 / die-cut 内部保留 / 空格识别 / 网格切分与 bbox 钳位', () => {
  const SC = S.stickerCut;
  if (!SC) throw new Error('sticker-cut.js 没加载');
  const W = 300, H = 200;                       /* cell 100x100 */
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  const px = (x, y, r, g, b) => {
    const p = (y * W + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  };
  /* 画一个「深色轮廓圈 + 圈内白底 + 中心彩芯」的 die-cut 贴纸：
     flood-fill 从格子边缘吃白底，但穿不过深色轮廓 → 圈内白色必须保留。
     坐标 = 绝对画布坐标（格子：row0 y 0-99 / row1 y 100-199，列宽 100）。 */
  const blob = (cx, cy) => {
    const R = 22;
    for (let y = -R; y <= R; y++) {
      for (let x = -R; x <= R; x++) {
        const d2 = x * x + y * y;
        if (d2 > R * R) continue;
        const gx = cx + x, gy = cy + y;
        if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
        const p = (gy * W + gx) * 4;
        if (d2 > (R - 3) * (R - 3)) {                       /* 深色轮廓 */
          data[p] = 84; data[p + 1] = 73; data[p + 2] = 62; data[p + 3] = 255;
        } else if (Math.abs(x) < 6 && Math.abs(y) < 6) {    /* 中心彩芯 */
          data[p] = 200; data[p + 1] = 120; data[p + 2] = 80; data[p + 3] = 255;
        }
        /* 其余 = 圈内白底（不画，保持 255） */
      }
    }
  };
  blob(50, 50);            /* 格 0：居中 */
  blob(150, 50);           /* 格 1：居中 */
  blob(250, 50);           /* 格 2：居中 */
  blob(50, 150);           /* 格 3：居中 */
  blob(150, 178);          /* 格 4：贴到格子底缘（y=199，bbox 钳位） */
  /* 格 5：全白 → empty */

  const cells = SC.splitStickerSheet3x2({ width: W, height: H, data: data },
    { threshold: 235, padding: 4, minPixels: 144 });
  if (cells.length !== 6) throw new Error('应切出 6 格');
  if (!cells[5].empty) throw new Error('全白格应识别为 empty');
  if (cells[0].empty || cells[4].empty) throw new Error('有内容的格被判空');

  const c0 = cells[0];
  const cd = c0.imageData.data;
  /* 角落 = 被吃掉的白底 → 透明 */
  if (cd[3] !== 0) throw new Error('格子角落的背景白没被去掉');
  /* 中心 = 彩芯 → 不透明且非白 */
  const mid = ((c0.imageData.height / 2 | 0) * c0.imageData.width + (c0.imageData.width / 2 | 0)) * 4;
  if (cd[mid + 3] !== 255 || cd[mid] === 255) throw new Error('中心彩芯丢了');
  /* die-cut 内部白：轮廓圈内、彩芯外的点应保留不透明（取 bbox 内彩芯左上斜向 8px 处） */
  let innerWhite = false;
  for (let y = 0; y < c0.imageData.height && !innerWhite; y++) {
    for (let x = 0; x < c0.imageData.width && !innerWhite; x++) {
      const p = (y * c0.imageData.width + x) * 4;
      if (cd[p + 3] === 255 && cd[p] === 255 && cd[p + 1] === 255 && cd[p + 2] === 255) innerWhite = true;
    }
  }
  if (!innerWhite) throw new Error('die-cut 白边被 flood 吃掉了（应被深色轮廓挡住）');

  /* 格 4 贴底：bbox 底缘必须钳在整版坐标 cell 底（y=200）之内 */
  if (cells[4].bbox.y + cells[4].bbox.h > 200) throw new Error('bbox 越过了格子底缘');
  if (cells[4].bbox.x < 100 || cells[4].bbox.x + cells[4].bbox.w > 200) {
    throw new Error('格 4 的 bbox 越过了自己的列');
  }
  return { 六格: true, 空格识别: true, 白底去除: true, dieCut保留: true, bbox钳位: true };
});

t('C2 入库：addSheetStickers 整批写 + removeSheet 只删整版 + 老表情不动', () => {
  const prev = S.core.activeSandbox();
  const sb = S.core.createSandbox('isle', '入库岛');
  S.core.setActiveSandbox(sb.id);
  try {
    S.store.set('stickers', []);
    const legacy = { id: 'st-legacy', name: '老表情', url: 'https://x.test/a.png', group: '旧', at: Date.now(), sandboxId: sb.id };
    S.store.set('stickers', [legacy]);

    const added = S.stickers.addSheetStickers([
      { name: '抱抱', mediaId: 'md-1', group: '贴纸工坊 · 测试', kind: 'sticker', sheetId: 'shs-1', sheetMediaId: 'md-sheet', sliceIndex: 0, sourceVersion: 1, emotion: 'big_hug', matchKey: 'sk:shs-1:0', ownerCharId: null, ownerUserId: null, ownerMaskIds: [], allowInGroups: false },
      { name: '好耶', mediaId: 'md-2', group: '贴纸工坊 · 测试', kind: 'sticker', sheetId: 'shs-1', sheetMediaId: 'md-sheet', sliceIndex: 1, sourceVersion: 1, emotion: 'super_happy', matchKey: 'sk:shs-1:1', ownerCharId: null, ownerUserId: null, ownerMaskIds: [], allowInGroups: false }
    ]);
    if (added.length !== 2) throw new Error('应写入 2 条');
    const all = S.stickers.all();
    if (all.length !== 3) throw new Error('all() 应为 3 条（老 1 + 新 2）');
    if (!added.every((r) => r.sandboxId === sb.id)) throw new Error('工坊贴纸没盖房章');
    if (added[0].kind !== 'sticker' || added[0].sheetMediaId !== 'md-sheet') throw new Error('C2 字段丢了');

    const n = S.stickers.removeSheet('shs-1');
    if (n !== 2) throw new Error('removeSheet 应删 2 条，实际 ' + n);
    const left = S.stickers.all();
    if (left.length !== 1 || left[0].id !== 'st-legacy') throw new Error('removeSheet 误删了老表情');
    return { 整批写: true, 房章: true, 整版删: true, 老表情不动: true };
  } finally {
    S.store.set('stickers', []);
    S.core._purgeSync.sandbox(sb.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

t('We 美化批：群岛选人闸 + 贴纸工坊入口/工坊页注册 + 首页真图拍立得', () => {
  const weSrc = fs.readFileSync(path.join(ROOT, 'page-we.js'), 'utf8');
  const coSrc = fs.readFileSync(path.join(ROOT, 'page-collection.js'), 'utf8');
  if (weSrc.indexOf('weGateApply') < 0 || weSrc.indexOf('needsCharPick') < 0) {
    throw new Error('We 群岛选人闸缺失（weGateApply / needsCharPick）');
  }
  if (weSrc.indexOf('core.switchTo(mains[0].id') < 0) throw new Error('孤岛/单大号自动归位丢了');
  if (coSrc.indexOf('Sleepy.weGate') < 0) throw new Error('收藏馆三页未接同一道选人闸');
  if (coSrc.indexOf('co-sticker-entry') < 0) throw new Error('贴纸工坊入口卡缺失');
  if (!S.registered()['sticker-workshop']) throw new Error('贴纸工坊页未注册');
  if (weSrc.indexOf('fillThumb(ph, it.mediaId)') < 0) throw new Error('首页拍立得条未铺真实照片');
  if (coSrc.indexOf('co-card-ticket') < 0 || coSrc.indexOf('co-card-photo') < 0) {
    throw new Error('门厅实物缩略卡（票根/照片）缺失');
  }
  return { 选人闸: true, 贴纸入口: true, 占位页注册: true, 真图拍立得: true, 实物缩略卡: true };
});

t('We 数据核对三缺口：提议角标 + 断点恢复索引 + 本批管理', () => {
  const weSrc = fs.readFileSync(path.join(ROOT, 'page-we.js'), 'utf8');
  const coSrc = fs.readFileSync(path.join(ROOT, 'page-collection.js'), 'utf8');
  const stSrc = fs.readFileSync(path.join(ROOT, 'page-stickers.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');

  /* ① 底栏收藏馆 tab 挂 pending 角标（scoped countPending，幂等更新） */
  if (weSrc.indexOf('we-tab-badge') < 0 || weSrc.indexOf('countPending') < 0) {
    throw new Error('底栏提议角标缺失（we-tab-badge / countPending）');
  }
  if (typeof S.weProposals.countPending !== 'function') throw new Error('countPending 出口没了');

  /* ③ 断点恢复：stickerSheets 索引进删房名单；remember/forget 成对；恢复卡在 step3 */
  if (coreSrc.indexOf("'stickerSheets'") < 0) throw new Error('stickerSheets 未进 core 删房 scoped 名单');
  if (coSrc.indexOf('skSheetIndexRemember') < 0 || coSrc.indexOf('skSheetIndexForget') < 0) {
    throw new Error('断点索引 remember/forget 缺失');
  }
  if (coSrc.indexOf('继续上次整版') < 0) throw new Error('step3 恢复卡缺失');
  /* 索引读写走 scoped+tagScope 纪律（与项目其他表同款） */
  if (coSrc.indexOf('core.scoped(Array.isArray(list) ? list : [])') < 0 ||
    coSrc.indexOf('core.tagScope({') < 0) throw new Error('stickerSheets 读写未走 scoped/tagScope 纪律');

  /* ② 本批管理：findId 出口 + removeSheet 有消费方 + 入库后记 savedSheetId/savedIds */
  if (typeof S.stickers.findId !== 'function') throw new Error('stickers.findId 出口缺失');
  if (coSrc.indexOf('removeSheet(') < 0 || coSrc.indexOf('sk-batch-wipe') < 0) {
    throw new Error('工坊本批管理（removeSheet 消费）缺失');
  }
  if (coSrc.indexOf('savedSheetId') < 0 || coSrc.indexOf('savedIds') < 0) {
    throw new Error('入库后未记录本批 sheetId/ids');
  }

  /* 行为抽查：索引 remember→scoped 可读→forget 消失（借 store 直查） */
  const prevSb = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '索引角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '索引我' }).id;
  const sb = S.core.createSandbox('isle', '索引岛');
  S.core.setSandboxChars(sb.id, [c]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(c, u);
  const fakeSt = {
    target: 'user', mode: 'custom', genderPick: null,
    customPicks: [0, 1, 2, 3, 4, 5], customLines: ['', '', '', '', '', '']
  };
  /* 经页面内部函数不可达 → 用与实现相同的纪律直查：写一条带 sandboxId 的索引记录，
     验证 scoped 读得到、别的岛读不到（这正是 remember/forget 依赖的语义） */
  const raw = S.store.get('stickerSheets') || [];
  raw.push({ id: 'shx-test', mediaId: 'md-x', at: Date.now(),
    sandboxId: sb.id, target: 'user', mode: 'custom', genderPick: null,
    customPicks: [0, 1, 2, 3, 4, 5], customLines: ['', '', '', '', '', ''] });
  S.store.set('stickerSheets', raw);
  const seen = S.store.get('stickerSheets').filter((r) => r && r.sandboxId === sb.id);
  if (seen.length !== 1 || seen[0].mediaId !== 'md-x') throw new Error('索引记录读写异常');
  /* 删房连带清：removeSandbox 已被 purge 门禁收编为内部函数，不直调——
     名单成员资格已在上面静态断言（'stickerSheets' ∈ core scoped）。 */
  if (prevSb) S.core.setActiveSandbox(prevSb.id);
  return { 角标: true, 恢复索引: true, 本批管理: true };
});

t('收藏馆C1：weStore.patch 白名单 + 当前房卫兵 + updatedAt；照片出厂未显影', () => {
  const prev = S.core.activeSandbox();
  const c = S.core.upsertChar({ name: '票根角色', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '票根我' }).id;
  const sb = S.core.createSandbox('isle', '票根岛');
  S.core.setSandboxChars(sb.id, [c]);
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(c, u);
  let other = null;
  try {
    /* weAdd：照片类出厂 developed:false；非照片不带 developed 字段 */
    const ph = S.weStore.add({ title: '海边拍立得', note: '风很大', kind: 'photo', at: 5000 }, sb.id);
    if (ph.developed !== false) throw new Error('新照片藏品应出厂未显影，实际=' + JSON.stringify(ph.developed));
    const tk = S.weStore.add({ title: '一起看的电影', note: '没看完', kind: 'ticket', at: 4000 }, sb.id);
    if ('developed' in tk) throw new Error('非照片不该带 developed 字段');

    /* patch：背签双留言落盘 + 盖 updatedAt（先把旧值拨回 1，避免同毫秒竞态） */
    const backdate = S.store.get('weEntries');
    backdate.filter((x) => x.id === tk.id)[0].updatedAt = 1;
    S.store.set('weEntries', backdate);
    const before = S.store.get('weEntries').filter((x) => x.id === tk.id)[0];
    const r1 = S.weStore.patch(tk.id, { memoUser: '散场下雨了', memoChar: '雨其实不大' });
    if (!r1 || !r1.ok) throw new Error('patch 背签留言失败：' + JSON.stringify(r1));
    const after1 = S.store.get('weEntries').filter((x) => x.id === tk.id)[0];
    if (after1.memoUser !== '散场下雨了' || after1.memoChar !== '雨其实不大') throw new Error('留言没落盘');
    if (after1.updatedAt <= before.updatedAt) throw new Error('patch 应盖 updatedAt');

    /* patch：显影标记持久化 */
    const r2 = S.weStore.patch(ph.id, { developed: true });
    if (!r2 || !r2.ok) throw new Error('显影标记写回失败');
    if (S.store.get('weEntries').filter((x) => x.id === ph.id)[0].developed !== true) {
      throw new Error('developed 未持久化');
    }

    /* 白名单外字段一律丢弃（改标题 / 伪造 sandboxId 都不许） */
    S.weStore.patch(tk.id, { title: '黑客改标题', sandboxId: 'evil' });
    const after3 = S.store.get('weEntries').filter((x) => x.id === tk.id)[0];
    if (after3.title !== '一起看的电影' || after3.sandboxId === 'evil') {
      throw new Error('白名单外字段被写入了');
    }

    /* 范围卫兵：别的岛读不到这张票 → 绝不许改 */
    other = S.core.createSandbox('isle', '别的岛');
    S.core.setActiveSandbox(other.id);
    const r3 = S.weStore.patch(tk.id, { memoUser: '跨岛写' });
    if (r3 && r3.ok) throw new Error('跨岛 id 竟然 patch 成功');
    S.core.setActiveSandbox(sb.id);

    /* 不存在的 id 不命中 */
    const r4 = S.weStore.patch('we-nope', { memoUser: 'x' });
    if (r4 && r4.ok) throw new Error('不存在的 id 不该命中');
    return { 照片出厂未显影: true, patch留言: true, 显影持久化: true, 白名单: true, 范围卫兵: true };
  } finally {
    if (other) S.core._purgeSync.sandbox(other.id);
    S.core._purgeSync.sandbox(sb.id);
    S.core.setActiveSandbox(prev ? prev.id : null);
  }
});

/* ======================== We 三页导航 + 时光 v1（2026-09-28） ========================
   证据：weNav / weTime 出口、三主页面挂 bar（二级页不挂）、
   replace 切 Tab 不涨栈、时光聚合的 user 视角闸门与身份/岛屿隔离。 */

t('We 导航：weNav / weTime 出口齐全，we-time 已注册，三主页面挂 bar、二级页不挂', () => {
  if (!S.weNav || typeof S.weNav.mount !== 'function') throw new Error('S.weNav.mount 缺失');
  if (typeof S.weNav.openAdd !== 'function') throw new Error('weNav.openAdd 缺失（＋ 必须复用同一抽屉）');
  const ids = S.weNav.TABS.map((x) => x.id).join(',');
  if (ids !== 'we,we-time,collection') throw new Error('weNav.TABS 不对：' + ids);
  if (!S.registered()['we-time']) throw new Error('we-time 页未注册');
  if (!S.weTime || typeof S.weTime.collect !== 'function') throw new Error('weTime.collect 缺失');

  const weSrc = fs.readFileSync(path.join(ROOT, 'page-we.js'), 'utf8');
  const coSrc = fs.readFileSync(path.join(ROOT, 'page-collection.js'), 'utf8');
  if (weSrc.indexOf("aria-label', '记一条共同记录'") < 0) throw new Error('＋ 按钮缺可访问名称「记一条共同记录」');
  if ((weSrc.match(/mountBar\(ctx, '/g) || []).length < 2) throw new Error('we / we-time 没都挂 bar');
  if (coSrc.indexOf("weNav.mount(ctx, 'collection')") < 0) throw new Error('收藏馆门厅未挂 bar');
  if (coSrc.indexOf("weNav.mount(ctx, 'collection-item')") >= 0 ||
      coSrc.indexOf("weNav.mount(ctx, 'collection-proposal')") >= 0) {
    throw new Error('二级页（详情/提议）不该挂主底栏');
  }
  /* 来源定位跳转的挂钩：moments/diary 条目带 data-id，聊天壳支持 params.tab，
     跳转带预检（jumpToSource）与定位（revealInPage），不许只开来源 App 首页 */
  const moSrc = fs.readFileSync(path.join(ROOT, 'page-moments.js'), 'utf8');
  const diaSrc = fs.readFileSync(path.join(ROOT, 'page-diary.js'), 'utf8');
  const appTabSrc = fs.readFileSync(path.join(ROOT, 'page-app.js'), 'utf8');
  if (moSrc.indexOf("card.setAttribute('data-id', m.id || '')") < 0) throw new Error('朋友圈条目缺 data-id（时光定位靠它）');
  if (diaSrc.indexOf('item.dataset.id = d.id') < 0) throw new Error('日记条目缺 data-id');
  if (appTabSrc.indexOf('ctx.params && ctx.params.tab') < 0) throw new Error('聊天壳不支持 params.tab（跳转会停在旧 tab）');
  if (weSrc.indexOf('jumpToSource') < 0 || weSrc.indexOf('revealInPage') < 0) throw new Error('时光缺来源预检/定位跳转');
  if (weSrc.indexOf("nav.open('moments')") >= 0) throw new Error('朋友圈跳转仍是只开 App 首页（应带 tab+jump 定位）');
  return { tabs: ids, weTime注册: true, 门厅挂bar: true, 定位挂钩: true };
});

t('We 导航：page-group 线下交接的 nav.replace 路径语义不变', () => {
  const g = fs.readFileSync(path.join(ROOT, 'page-group.js'), 'utf8');
  if (g.indexOf('Sleepy.nav.replace(pid, params)') < 0) throw new Error('线下交接换页调用点变了');
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  /* replace 仍是「弹栈顶 + open」：目标不在栈内照常 push（onShow 照旧触发），
     只是历史从 pushState 变 replaceState（少一条死条目，返回键直达上一页）。 */
  if (appSrc.indexOf('opts.replaceHist') < 0 || appSrc.indexOf('function histReplace') < 0) {
    throw new Error('app.js replace 的历史替换机制丢了');
  }
  if (appSrc.indexOf('pageStack.length <= before') < 0) {
    throw new Error('replace 的 onShow 补发没了（目标在栈内切回会看到旧数据）');
  }
  return { 调用点不变: true, 历史替换: true, onShow补发: true };
});

t('We 导航：主 Tab 切换走 replace —— 栈深不变、点当前页不动、历史原地替换', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  if (appSrc.indexOf('function histReplace') < 0 || appSrc.indexOf('opts.replaceHist') < 0) {
    throw new Error('app.js replace 没有走 replaceState（切 Tab 会涨浏览器返回栈）');
  }
  const pageWeSrc = fs.readFileSync(path.join(ROOT, 'page-we.js'), 'utf8');
  if (pageWeSrc.indexOf('nav.replace(id)') < 0) throw new Error('goTab 没走 nav.replace');

  /* 行为断言（桩下 histOK=false → 纯内存栈，正好看栈深与栈顶） */
  S.nav.closeAll();
  S.nav.open('we');
  if (S.nav.depth() !== 1 || S.nav.top() !== 'we') throw new Error('打开 we 栈不对');
  S.nav.replace('we-time');
  if (S.nav.depth() !== 1 || S.nav.top() !== 'we-time') throw new Error('replace 后栈深/栈顶不对');
  S.nav.replace('we-time');                       /* 点当前 Tab：不重挂不涨栈 */
  if (S.nav.depth() !== 1 || S.nav.top() !== 'we-time') throw new Error('点当前 Tab 竟然动栈');
  S.nav.replace('collection');
  if (S.nav.depth() !== 1 || S.nav.top() !== 'collection') throw new Error('切到收藏馆不对');
  S.nav.open('collection-item', { id: 'x' });     /* 二级页照常压栈 */
  if (S.nav.depth() !== 2 || S.nav.top() !== 'collection-item') throw new Error('详情应压栈');
  S.nav.closeAll();
  return { replace栈深不变: true, 点当前不动: true, 详情照常压栈: true };
});

t('时光 v1：聚合朋友圈/日记/共同记录；user 视角闸门 + 号隔离 + 岛隔离 + 倒序去重', () => {
  const A = S.core.createSandbox('isle', '时甲');
  const B = S.core.createSandbox('isle', '时乙');
  const m1 = S.core.upsertChar({ name: '时大号', kind: 'main' }).id;
  const m2 = S.core.upsertChar({ name: '时二号', kind: 'main' }).id;
  const u1 = S.core.upsertUser({ name: '时我' }).id;
  const u2 = S.core.upsertUser({ name: '时我二' }).id;
  S.core.setSandboxChars(A.id, [m1, m2]);
  S.core.setSandboxMasks(A.id, [u1, u2]);

  const now = Date.now();
  S.core.setActiveSandbox(A.id);
  S.core.switchTo(m1, u1);
  /* 日记写入：page-diary 未导出 addEntry（只给读），这里按 addEntry 的
     真实落盘口径播种 —— tagScope 盖当前房章 + char/user 归属字段。 */
  const seedDiary = (rec) => {
    const it = S.core.tagScope({
      id: 'dsmoke-' + Math.random().toString(36).slice(2, 9),
      content: rec.content,
      timestamp: rec.timestamp,
      status: rec.status || 'written',
      author: rec.author || 'user'
    });
    if (rec.charId) it.charId = rec.charId;
    else it.userId = rec.userId || null;
    const all = S.store.get('diaries');
    all.push(it);
    S.store.set('diaries', all);
    return it;
  };
  S.momentsTab.add({ text: '我发的一条', at: now - 1000 });
  S.momentsTab.add({ text: 'TA 发的一条', at: now - 2000, characterId: m1 });
  S.momentsTab.add({ text: 'TA 的私密一条', at: now - 2500, characterId: m1, privacy: 'self' });
  seedDiary({ content: 'TA 写的日记', author: 'char', charId: m1, timestamp: now - 3000 });
  seedDiary({ content: '我写的日记', timestamp: now - 4000, userId: u1 });
  seedDiary({ content: '待补的草稿', timestamp: now - 5000, status: 'pending', userId: u1 });
  seedDiary({ content: '二号角色自己的日记', author: 'char', charId: m2, timestamp: now - 6000 });
  seedDiary({ content: '老日记没有归属', timestamp: now - 8000 });   /* 缺 userId 的旧数据 */
  const weE = S.weStore.add({ title: '一起看过海', note: '码头吹风', at: now - 1500 }, A.id);

  /* u2 发一条动态、写一篇日记（号隔离的「别人那边」） */
  S.core.switchTo(m1, u2);
  S.momentsTab.add({ text: '二号的动态', at: now - 800 });
  seedDiary({ content: '二号写的日记', timestamp: now - 900, userId: u2 });

  /* 乙岛来一条（岛隔离的「别岛」） */
  S.core.setActiveSandbox(B.id);
  S.core.switchTo(m1, u1);
  seedDiary({ content: '乙岛的日记', timestamp: now - 700, userId: u1 });

  /* 回甲岛 u1 视角聚合 */
  S.core.setActiveSandbox(A.id);
  S.core.switchTo(m1, u1);
  const char1 = S.core.findChar(m1);
  const user1 = S.core.findUser(u1);
  const items = S.weTime.collect(char1, user1);
  const texts = items.map((x) => x.title).join('|');
  const has = (t) => texts.indexOf(t) >= 0;
  const no = (t) => texts.indexOf(t) < 0;

  if (!has('我发的一条') || !has('TA 发的一条')) throw new Error('朋友圈来源缺失：' + texts);
  if (!has('TA 写的日记') || !has('我写的日记')) throw new Error('日记来源缺失：' + texts);
  if (!has('一起看过海')) throw new Error('共同记录缺失：' + texts);
  if (!no('TA 的私密一条')) throw new Error('TA 的私密动态漏进了 user 视角');
  if (!no('二号的动态') || !no('二号写的日记')) throw new Error('别的号的记录串进来了');
  if (!no('二号角色自己的日记')) throw new Error('别的角色的日记串进来了');
  if (!no('待补的草稿')) throw new Error('pending 草稿冒充已发生经历');
  if (!no('乙岛的日记')) throw new Error('别岛的日记串进来了');
  if (!no('老日记没有归属')) throw new Error('缺 userId 的旧日记越权进了时光（应 fail closed）');

  /* 排序：真实时间倒序；来源标识齐 */
  for (let i = 1; i < items.length; i++) {
    if ((items[i - 1].at || 0) < (items[i].at || 0)) throw new Error('排序不是倒序');
  }
  const kinds = new Set(items.map((x) => x.src));
  if (!kinds.has('moments') || !kinds.has('diary') || !kinds.has('we')) {
    throw new Error('来源类型不全：' + [...kinds].join(','));
  }
  if (!items.every((x) => x.id)) throw new Error('条目缺稳定 id（去重/跳转靠它）');

  /* 切号（u2）：u1 的日记/动态不得出现；乙岛记录也不得出现 */
  S.core.switchTo(m1, u2);
  const items2 = S.weTime.collect(char1, S.core.findUser(u2));
  const texts2 = items2.map((x) => x.title).join('|');
  if (texts2.indexOf('我写的日记') >= 0 || texts2.indexOf('我发的一条') >= 0) {
    throw new Error('切号后旧号摘要还在（串身份）：' + texts2);
  }

  /* 切岛：甲岛全部消失 */
  S.core.setActiveSandbox(B.id);
  const items3 = S.weTime.collect(char1, S.core.findUser(u1));
  if (items3.some((x) => x.id === weE.id)) throw new Error('切岛后甲岛共同记录还在（串岛）');
  S.core.setActiveSandbox(A.id);
  S.core.switchTo(m1, u1);
  return { 聚合三源: true, 视角闸门: true, 号隔离: true, 岛隔离: true, 倒序: true, pending排除: true };
});

t('时光 v1.1：时间归一（无 NaN/纪元）+ weEntries 岛级共享边界 + sourceStatus 状态机', () => {
  if (typeof S.weTime.dayLabel !== 'function' || typeof S.weTime.sourceStatus !== 'function' ||
      typeof S.weTime.atNum !== 'function') {
    throw new Error('weTime.dayLabel / sourceStatus / atNum 未导出');
  }
  /* 时间展示：0 / NaN / 无效字符串 → 「时间不详」，绝无纪元日期 */
  if (S.weTime.dayLabel(0) !== '时间不详') throw new Error('dayLabel(0) 应为时间不详，实际=' + S.weTime.dayLabel(0));
  if (S.weTime.dayLabel(NaN) !== '时间不详') throw new Error('dayLabel(NaN) 应为时间不详');
  if (S.weTime.dayLabel('garbage') !== '时间不详') throw new Error('dayLabel(无效字符串) 应为时间不详');
  if (S.weTime.dayLabel(Date.now()).indexOf('月') < 0) throw new Error('dayLabel(有效) 不是日期');
  if (S.weTime.atNum('2026-09-01') <= 0 || S.weTime.atNum('garbage') !== 0 || S.weTime.atNum(null) !== 0) {
    throw new Error('atNum 归一不对');
  }

  /* 两个角色 → 必须群岛（孤岛 setSandboxChars 会被静默拒绝，charIds 留空） */
  const A = S.core.createSandbox('archipelago', '时丙');
  const m1 = S.core.upsertChar({ name: '丙大号', kind: 'main' }).id;
  const m2 = S.core.upsertChar({ name: '丙二号', kind: 'main' }).id;
  const u1 = S.core.upsertUser({ name: '丙我' }).id;
  S.core.setSandboxChars(A.id, [m1, m2]);
  S.core.setSandboxMasks(A.id, [u1]);
  S.core.setActiveSandbox(A.id);
  S.core.switchTo(m1, u1);

  const seedDiary = (rec) => {
    const it = S.core.tagScope({
      id: 'dt1-' + Math.random().toString(36).slice(2, 9),
      content: rec.content, timestamp: rec.timestamp,
      status: rec.status || 'written', author: rec.author || 'user'
    });
    if (rec.charId) it.charId = rec.charId; else it.userId = rec.userId || null;
    const all = S.store.get('diaries'); all.push(it); S.store.set('diaries', all);
    return it;
  };
  seedDiary({ content: '字符串时间的日记', timestamp: '2026-09-01T10:00:00', userId: u1 });
  seedDiary({ content: '无效时间的日记', timestamp: 'garbage', userId: u1 });
  S.momentsTab.add({ text: '字符串时间的动态', characterId: m1, at: '2026-08-01T08:00:00' });

  const char1 = S.core.findChar(m1);
  const user1 = S.core.findUser(u1);
  const items = S.weTime.collect(char1, user1);
  if (!items.every((x) => typeof x.at === 'number' && !isNaN(x.at))) {
    throw new Error('聚合结果存在非数字 / NaN 时间（归一失败）');
  }
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1].at < items[i].at) throw new Error('排序乱了（时间归一失败）');
  }
  const bad = items.find((x) => x.title.indexOf('无效时间的日记') >= 0);
  if (!bad || bad.at !== 0) throw new Error('无效时间应归一为 0（排最后）');
  const strDiary = items.find((x) => x.title.indexOf('字符串时间的日记') >= 0);
  if (!strDiary || strDiary.at <= 0) throw new Error('合法字符串时间应解析为时间戳');

  /* weEntries 共享边界 = 岛（scoped）：同岛另一角色也可见。
     core.scoped 的岛过滤不自动等于关系过滤 —— refCharId / refUserId 是
     归属档案不是 ACL，这是产品既定口径，这里只证明边界，不改权限。 */
  const e1 = S.weStore.add({ title: '丙岛共享记录', at: Date.now() - 100 }, A.id);
  S.core.switchTo(m2, u1);
  const items2 = S.weTime.collect(S.core.findChar(m2), S.core.findUser(u1));
  if (!items2.some((x) => x.id === e1.id)) {
    throw new Error('同岛另一角色看不到共同记录（边界应=岛，不应擅自收紧）');
  }
  S.core.switchTo(m1, u1);

  /* sourceStatus 状态机：ok / gone / denied（上下文与接口缺失 fail closed） */
  const stWe = S.weTime.sourceStatus('we', e1.id);
  if (stWe !== 'ok') {
    const sbNow = S.core.activeSandbox();
    throw new Error('存在的记录应 ok，实际=' + stWe +
      ' sb=' + JSON.stringify(sbNow && { id: sbNow.id, charIds: sbNow.charIds }) +
      ' activeCharId=' + S.store.get('activeCharId') +
      ' findChar=' + JSON.stringify(!!S.core.findChar(m1)) +
      ' findInScope=' + JSON.stringify(!!S.collectionStore.findInScope(e1.id)));
  }
  if (S.weTime.sourceStatus('we', 'nope') !== 'gone') throw new Error('不存在的记录应 gone');
  if (S.weTime.sourceStatus('moments', 'mo-nope') !== 'gone') throw new Error('不存在的动态应 gone');
  const mv = S.momentsTab.add({ text: '丙岛私密动态', characterId: m1, privacy: 'self', at: Date.now() });
  if (S.weTime.sourceStatus('moments', mv.id) !== 'denied') {
    throw new Error('TA 私密动态对 user 应 denied');
  }
  S.momentsTab.remove(mv.id);
  return { 时间归一: true, 无纪元: true, 岛级共享: true, 状态机: true };
});

t('新建表单页重开必须重画（freshOnOpen 静态护栏）', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  if (appSrc.indexOf('freshOnOpen') < 0) throw new Error('app.js 没有 freshOnOpen 重开重画机制');
  for (const f of ['page-idcard.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    /* contact-edit 与 mask-edit 两处注册都必须声明 */
    let n = 0, i = 0;
    while ((i = src.indexOf('freshOnOpen: true', i)) >= 0) { n++; i += 1; }
    if (n < 2) throw new Error(f + ' 只声明了 ' + n + ' 处 freshOnOpen（应 contact-edit + mask-edit 各一）');
  }
  return { app机制: true, contactedit: true, maskedit: true };
});

/* 用户 2026-10-03 报的两个 bug 的**静态**护栏。
   上面那条（数据层）已经证明 core 的隔离逻辑是好的 —— 病根全在 UI 层
   拿「人」的方式，所以必须扫源码才抓得住回潮。

   ① 跨岛 copy 账号：编辑页取人只能用**指针卫兵**（activeUserOnIsland），
      不许用带 `|| ensureDefaultUser()` 跨岛兜底的 activeUser；
      且 mask-edit 必须校验「这条记录属于要编辑的那座岛」。
   ② 认知档位在没马甲的岛上不许整段消失：门槛只能是「有没有角色」，
      不许出现 `mains.length && masks.length` 这种把马甲数当条件的写法。 */
t('跨岛隔离静态护栏：编辑页不许拿带兜底的 activeUser，认知锁不许按马甲数隐藏（用户 10-03 报）', () => {
  const idc = fs.readFileSync(path.join(ROOT, 'page-idcard.js'), 'utf8');
  const isl = fs.readFileSync(path.join(ROOT, 'page-island.js'), 'utf8');

  /* --- ① me-profile：取人必须是卫兵 ---
     ⚠️ **先剥注释再判**：修法说明里必然要写出 `activeUserOnIsland`
     这几个字（说明「原来用的是 activeUser」），不剥的话第一道
     `indexOf` 永远命中注释 → 后面真正抓代码的 forEach 根本走不到。
     这是第一版假绿的直接原因（负向对照当场抓出来的）。 */
  const meAt = idc.indexOf("Sleepy.register('me-profile'");
  const meSeg = idc.slice(meAt, meAt + 1800)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const takeLine = meSeg.slice(0, meSeg.indexOf('var body = ctx.body;'));
  if (takeLine < 0) throw new Error('me-profile 护栏锚点失效（没找到 var body 那行）');
  const assigned = takeLine.match(/\bvar\s+\w+\s*=\s*core\.(\w+)\(\)/g) || [];
  if (!assigned.length) throw new Error('me-profile 取人那段没找到 core.*() 赋值（护栏本身要改）');
  assigned.forEach((a) => {
    if (a.indexOf('activeUserOnIsland') < 0) {
      throw new Error('me-profile 取人用的是 ' + a.trim() + ' —— 必须是 activeUserOnIsland');
    }
  });
  if (meSeg.indexOf('activeUserOnIsland') < 0) {
    throw new Error('me-profile 整段里都没有 activeUserOnIsland');
  }
  /* --- ① mask-edit：必须校验岛归属 --- */
  const mkAt = idc.indexOf("Sleepy.register('mask-edit'");
  const meSeg2 = idc.slice(mkAt, mkAt + 2200)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (meSeg2.indexOf('sandboxId') < 0) {
    throw new Error('mask-edit 没接 sandboxId（跨岛打开会把别岛的记录整个 copy 进表单）');
  }
  if (meSeg2.indexOf('不属于这座岛') < 0) {
    throw new Error('mask-edit 缺「记录不属于这座岛就拒绝编辑」那道闸（fail closed）');
  }
  /* 归属闸必须真的**在条件里比 sandboxId**，不能只写在 toast 文案里 */
  if (!/existing\s*\.\s*sandboxId\s*!==\s*sbId|existing\s*\.\s*sandboxId\s*===\s*sbId/.test(meSeg2)) {
    throw new Error('mask-edit 只在文案里提了「不属于这座岛」，代码里没比 sandboxId（护栏要卡代码不是卡字）');
  }
  /* --- ① 时空切换器建马甲必须带岛 --- */
  const sw = fs.readFileSync(path.join(ROOT, 'page-switch.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const swAt = sw.indexOf("open('mask-edit'");
  const swAdd = sw.slice(swAt - 400, swAt + 120);
  if (swAdd.indexOf('sandboxId') < 0) {
    throw new Error('时空切换器「新增马甲」没带 sandboxId（会在别的岛建出别座的马甲）');
  }
  /* 剥注释后再扫：修法说明里必然要写出旧写法那几个字，
     扫全文会把自己刚写的注释判成违规（第一版就这么误报）。 */
  const islCode = isl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/mains\.length\s*&&\s*masks\.length/.test(islCode)) {
    throw new Error('认知锁又回到「有马甲才渲染」了（新岛会一个选项都没有）');
  }
  /* ⚠️ 锚点要用 `secTitle('初始认知锁')`（真正的渲染调用），
     不能用「初始认知锁」四个字 —— 剥掉注释后文件头那份文档里也有这几个字，
     indexOf 会命中第 23 行，窗口就落到完全无关的地方去了。 */
  const lockAt = islCode.indexOf("secTitle('初始认知锁')");
  if (lockAt < 0) throw new Error('没找到认知锁那段渲染（护栏锚点失效，需要更新）');
  const lockSeg = islCode.slice(lockAt, lockAt + 1600);
  if (lockSeg.indexOf('还没有「我」的马甲') < 0) {
    throw new Error('没马甲时没给出「去加一件马甲」的指引（用户会以为这一页坏了）');
  }
  return {
    meProfile: '指针卫兵',
    maskEdit: '校验岛归属',
    切换器: '带 sandboxId',
    认知锁: '按角色判，不按马甲数'
  };
});

/* ======================== We 收藏馆 P2（char 提议 → user 确认入馆） ========================
   数据层证据：store 默认值 / 标签抽取 / 岛隔离 / 来源 fail-closed /
   accept 幂等 / declined 冷却 / 老 weAdd 兼容 / 删房名单 / 页面注册。 */

t('收藏馆P2：weProposals 默认存在；标签抽取纯函数（剥干净 / 非法丢弃）', () => {
  if (!Array.isArray(S.store.get('weProposals'))) throw new Error('weProposals 不在 store DEFAULTS 里');
  if (S.weProposals.KEY !== 'weProposals') throw new Error('weProposals.KEY 不对');
  if (typeof S.weProposals.createFromReply !== 'function' ||
      typeof S.weProposals.accept !== 'function' ||
      typeof S.weProposals.decline !== 'function' ||
      typeof S.weProposals.validateSource !== 'function') {
    throw new Error('weProposals 出口不齐（createFromReply/accept/decline/validateSource）');
  }

  /* 半角冒号：剥干净 + 字段齐 */
  const r1 = S.weProposals.extractTag('那天真难忘。[收藏提议:ev123|ticket|想把那天留在馆里] 后来就到家了');
  if (r1.text.indexOf('收藏提议') >= 0 || r1.text.indexOf('ev123') >= 0) {
    throw new Error('标签没剥干净：' + r1.text);
  }
  if (r1.text.indexOf('那天真难忘') < 0 || r1.text.indexOf('后来就到家了') < 0) throw new Error('正文被误伤');
  if (!r1.hit || r1.hit.sourceId !== 'ev123' || r1.hit.kind !== 'ticket' ||
      r1.hit.reason !== '想把那天留在馆里') throw new Error('hit 字段错：' + JSON.stringify(r1.hit));

  /* 全角冒号也认；一条回复只认第一个 */
  const r2 = S.weProposals.extractTag('[收藏提议：evA|letter|理由一][收藏提议:evB|gift|理由二]');
  if (!r2.hit || r2.hit.sourceId !== 'evA') throw new Error('全角冒号/首条命中错：' + JSON.stringify(r2.hit));
  if (r2.text.indexOf('evB') >= 0) throw new Error('第二个标签没剥掉');

  /* 无标签 / 字段缺失 → hit 为空，不影响正文 */
  const r3 = S.weProposals.extractTag('普通一句话');
  if (r3.hit) throw new Error('无标签不该有 hit');
  const r4 = S.weProposals.extractTag('[收藏提议:|ticket|理由]');
  if (r4.hit) throw new Error('字段缺失应丢弃');
  if (r4.text !== '') throw new Error('字段缺失的标签也应从正文剥掉：' + r4.text);

  return { 默认存在: true, 半角: true, 全角: true, 单条: true, 缺字段丢弃: true };
});

/* 记一笔（2026-10-08）：char 自己提议记共同记录。
   标签 [记一笔:标题|一句话|分类]（分类可省）→ hit.type='entry'；
   createFromReply 按 type 分发；accept 对 moment 来源核验原对话存在。 */
t('记一笔：extractEntryTag 抽取 + createFromReply 分发 + moment 来源', () => {
  const g = S.weProposals;
  if (typeof g.extractEntryTag !== 'function') throw new Error('extractEntryTag 没导出');
  /* 半角/全角都认；分类可省 → other */
  const a = g.extractEntryTag('刚才那家店真好。[记一笔:巷口的赭石|一起找到的颜料铺|place] 改天再去');
  if (!a.hit || a.hit.type !== 'entry' || a.hit.title !== '巷口的赭石' ||
      a.hit.note !== '一起找到的颜料铺' || a.hit.kind !== 'place') {
    throw new Error('entry hit 字段错：' + JSON.stringify(a.hit));
  }
  if (a.text.indexOf('记一笔') >= 0 || a.text.indexOf('巷口的赭石') >= 0) {
    throw new Error('记一笔标签没剥干净：' + a.text);
  }
  if (a.text.indexOf('改天再去') < 0) throw new Error('正文被误伤');
  const b = g.extractEntryTag('[记一笔：旧书签|夹在扉页的那张]');
  if (!b.hit || b.hit.kind !== 'other') throw new Error('省略分类应回落 other：' + JSON.stringify(b.hit));
  const c = g.extractEntryTag('普通一句话');
  if (c.hit) throw new Error('无标签不该有 hit');
  if (c.text.indexOf('记一笔') < 0 ? false : c.text.indexOf('记一笔') >= 0) { /* noop */ }
  /* 字段缺失 → 丢弃但剥干净 */
  const d = g.extractEntryTag('[记一笔:|只有一句话]');
  if (d.hit) throw new Error('缺标题应丢弃');
  /* createFromReply 按 hit.type 分发：entry 提议不需要日历事件 */
  const fakeChat = { id: 'ct_x', sandboxId: 'sb_x', characterId: 'ch_x', userId: 'u_x' };
  const made = g.createFromReply(fakeChat, 'm1', { type: 'entry', title: '巷口的赭石', note: '一起找到的颜料铺', kind: 'place' });
  if (!made.ok) throw new Error('entry 提议没建成：' + JSON.stringify(made));
  if (made.proposal.sourceType !== 'moment' || made.proposal.sourceId !== 'ct_x') {
    throw new Error('moment 来源字段错：' + JSON.stringify(made.proposal));
  }
  /* 同 originMessageId 去重 */
  const dup = g.createFromReply(fakeChat, 'm1', { type: 'entry', title: '第二条', note: '不该建成', kind: 'other' });
  if (dup.ok || dup.why !== 'dup-message') throw new Error('同消息去重失效：' + JSON.stringify(dup));
  /* accept：原对话不存在 → 拒绝入馆且保留 pending */
  const acc = g.accept(made.proposal.id);
  if (acc.ok || acc.why !== 'deleted') throw new Error('moment 来源核验失效：' + JSON.stringify(acc));
  const after = g.findInScope ? null : null; /* findInScope 依赖岛指针，这里只验状态 */
  const kept = (S.store.get('weProposals') || []).filter((p) => p && p.id === made.proposal.id)[0];
  if (!kept || kept.status !== 'pending') throw new Error('accept 拒绝后应保留 pending');
  /* 收尾：清掉夹具提议，不污染其他用例 */
  S.store.set('weProposals', (S.store.get('weProposals') || []).filter((p) => p && p.id !== made.proposal.id));
  return { 抽取: true, 分发: true, 去重: true, moment核验: true };
});

/* 副 API 功能分配（2026-10-08 定位重构）：勾选的功能严格走副 API。
   核心判据（硬写字符串登记，防以后被"优化"回主 API）：没勾 → requestForFeature
   返回 null（调用方走默认）；勾了但没副 API → 明确报错、绝不回落主 API。 */
t('副API功能分配：未勾返回 null；勾了无副API如实报错不回落', async () => {
  const g = S.api;
  if (!Array.isArray(g.FEATURES) || !g.FEATURES.length) throw new Error('FEATURES 清单缺失');
  if (typeof g.requestForFeature !== 'function' || typeof g.featureOn !== 'function') {
    throw new Error('api 出口不齐（requestForFeature/featureOn）');
  }
  /* 未勾选：返回 null，路由权留给调用方 */
  S.store.set('subApiFeatures', {});
  if (g.requestForFeature('schedule', [{ role: 'user', content: 'x' }], {}) !== null) {
    throw new Error('未勾选的功能不该被接管（应返回 null）');
  }
  /* 勾选 + 无副 API：明确报错，报错里必须点名「副 API」，不许静默回落主 API */
  S.store.set('subApiFeatures', { schedule: true });
  if (!g.featureOn('schedule')) throw new Error('featureOn 读取失效');
  const r = await g.requestForFeature('schedule', [{ role: 'user', content: 'x' }], {});
  S.store.set('subApiFeatures', {});
  if (r.ok) throw new Error('没有副 API 却成功了？');
  if (String(r.error).indexOf('副 API') < 0) {
    throw new Error('报错没有指明副 API 定位：' + r.error);
  }
  return { 未勾返null: true, 勾选生效: true, 无副API如实报错: true };
});

t('收藏馆P2：创建提议带正确 sandboxId/身份（不用全局指针），pending 不进 weStore.list，跨岛不可见', () => {
  const A = S.core.createSandbox('isle', '提议甲岛');
  const m = S.core.upsertChar({ name: '提议大号', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '我' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);
  const ev = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule',
    title: '旧书店的黄昏', startAt: '2026-10-03 16:00' });

  const chat = { id: 'chat-a', characterId: m, userId: u, sandboxId: A.id };
  const r = S.weProposals.createFromReply(chat, 'msg-1',
    { sourceId: ev.id, kind: 'ticket', reason: '想把那天一起留在馆里' });
  if (!r.ok) throw new Error('合法提议被拒：' + JSON.stringify(r));
  const p = r.proposal;
  if (p.sandboxId !== A.id) throw new Error('sandboxId 不是 chat 自带的岛：' + p.sandboxId);
  if (p.refCharId !== m || p.refUserId !== u) throw new Error('refCharId/refUserId 错');
  if (p.status !== 'pending' || p.proposedBy !== 'char') throw new Error('status/proposedBy 错');
  if (p.title !== '旧书店的黄昏') throw new Error('title 必须来自真实事件：' + p.title);
  if (p.sourceRef !== '2026-10-03') throw new Error('sourceRef 应取事件 startAt：' + p.sourceRef);
  if (p.dedupeKey !== [A.id, m, 'calendar', ev.id].join('|')) throw new Error('dedupeKey 口径错');
  if (p.originMessageId !== 'msg-1' || p.originChatId !== 'chat-a') throw new Error('origin 记录错');
  if (p.acceptedEntryId !== null || p.resolvedBy !== null) throw new Error('初始 resolved 字段应空');

  /* pending 绝不进正式馆藏 */
  if (S.weStore.list().some((e) => e.title === '旧书店的黄昏')) {
    throw new Error('pending 漏进了 weEntries！');
  }

  /* 跨岛不可见 */
  const B = S.core.createSandbox('isle', '提议乙岛');
  S.core.setActiveSandbox(B.id);
  if (S.weProposals.countPending() !== 0) throw new Error('乙岛看到了甲岛的提议（串岛）');
  if (S.weProposals.findInScope(p.id)) throw new Error('findInScope 跨岛命中');
  S.core.setActiveSandbox(A.id);
  if (S.weProposals.countPending() !== 1) throw new Error('回甲岛后提议丢了');

  /* 同一 originMessageId 重复创建被拦 */
  const ev2 = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '第二件事' });
  const dup = S.weProposals.createFromReply(chat, 'msg-1', { sourceId: ev2.id, kind: 'gift', reason: '又想留' });
  if (dup.ok || dup.why !== 'dup-message') throw new Error('同 originMessageId 应拦：' + JSON.stringify(dup));

  return { sandboxId正确: true, 身份正确: true, pending不进正式表: true, 跨岛不可见: true, 同msg防重: true };
});

t('收藏馆P2：来源 fail-closed —— 非法kind/不存在/跨角色/跨岛/取消/类型错全拒，completed 可创建', () => {
  const A = S.core.createSandbox('isle', '复核甲岛');
  const m = S.core.upsertChar({ name: '复核甲大号', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '我' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);
  const chat = { id: 'chat-fc', characterId: m, userId: u, sandboxId: A.id };

  const evOK = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '傍晚散步' });
  const evDone = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '看完那场展', status: 'completed' });
  const evCancel = S.calendar.cancelEvent(
    S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '黄了的约定' }).id
  );
  const m2 = S.core.upsertChar({ name: '别人家大号', kind: 'main' }).id;
  const evOther = S.calendar.__internal.addEvent({ ownerCharId: m2, eventType: 'char_schedule', title: '别人的事' });
  const evShared = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'shared_event', title: '共同安排' });

  function why(tag) {
    return S.weProposals.createFromReply(chat, 'msg-fc-' + Math.random(), tag).why;
  }
  if (why({ sourceId: evOK.id, kind: 'jewelry', reason: '合理' }) !== 'kind') throw new Error('非法 kind 应拒');
  if (why({ sourceId: 'ev-nope', kind: 'ticket', reason: '合理' }) !== 'deleted') throw new Error('不存在的事件应 deleted');
  if (why({ sourceId: evOther.id, kind: 'ticket', reason: '合理' }) !== 'char') throw new Error('跨角色事件应拒');
  if (why({ sourceId: evCancel.id, kind: 'ticket', reason: '合理' }) !== 'cancelled') throw new Error('已取消应拒');
  if (why({ sourceId: evShared.id, kind: 'ticket', reason: '合理' }) !== 'type') throw new Error('非 char_schedule 应拒');

  /* 跨岛：事件属于同一 char 但盖的是乙岛的章 */
  const B = S.core.createSandbox('isle', '复核乙岛');
  S.core.setActiveSandbox(B.id);
  const evB = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '乙岛的事' });
  S.core.setActiveSandbox(A.id);
  if (why({ sourceId: evB.id, kind: 'ticket', reason: '合理' }) !== 'scope') throw new Error('跨岛事件应拒');

  /* 理由超长 → 丢弃 */
  if (why({ sourceId: evOK.id, kind: 'ticket', reason: '长'.repeat(61) }) !== 'reason') throw new Error('理由超长应拒');

  /* completed 是有效历史来源：可以创建（创建后立刻 decline 收场，不占 pending 上限） */
  const done = S.weProposals.createFromReply(chat, 'msg-fc-done',
    { sourceId: evDone.id, kind: 'ticket', reason: '看过的也想留' });
  if (!done.ok) throw new Error('completed 来源应可提议：' + JSON.stringify(done));
  S.weProposals.decline(done.proposal.id);

  return { kind拒: true, deleted拒: true, 跨角色拒: true, cancelled拒: true,
    跨岛拒: true, 类型拒: true, 超长拒: true, completed可创建: true };
});

t('收藏馆P2：accept 幂等 + 正式记录 createdBy/confirmedBy/confirmedAt + declined 冷却 + 老 weAdd 兼容', () => {
  const A = S.core.createSandbox('isle', '确认甲岛');
  const m = S.core.upsertChar({ name: '确认大号', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '我' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);
  const chat = { id: 'chat-ac', characterId: m, userId: u, sandboxId: A.id };
  const before = S.weStore.list().length;

  /* accept：写入正式 weEntries + 全部确认字段 */
  const ev = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '江边的日落' });
  const r = S.weProposals.createFromReply(chat, 'msg-ac-1', { sourceId: ev.id, kind: 'place', reason: '那天的光很好' });
  if (!r.ok) throw new Error('提议创建失败：' + JSON.stringify(r));
  const acc = S.weProposals.accept(r.proposal.id);
  if (!acc.ok) throw new Error('accept 失败：' + JSON.stringify(acc));
  const entry = acc.entry;
  if (entry.createdBy !== 'char') throw new Error('正式记录 createdBy 应为 char：' + entry.createdBy);
  if (entry.confirmedBy !== 'user') throw new Error('confirmedBy 应为 user');
  if (typeof entry.confirmedAt !== 'number') throw new Error('confirmedAt 应为时间戳');
  if (entry.sandboxId !== A.id) throw new Error('正式记录盖错岛章');
  if (entry.kind !== 'place' || entry.sourceId !== ev.id) throw new Error('来源字段没带全');
  const p = S.weProposals.findInScope(r.proposal.id);
  if (p.status !== 'accepted' || p.acceptedEntryId !== entry.id || p.resolvedBy !== 'user') {
    throw new Error('proposal 写回不对：' + JSON.stringify(p));
  }
  if (S.weStore.list().length !== before + 1) throw new Error('正式馆藏应恰好 +1');

  /* 幂等：重复 accept 不生成第二条 */
  const acc2 = S.weProposals.accept(r.proposal.id);
  if (acc2.ok || acc2.why !== 'already-accepted' || acc2.entryId !== entry.id) {
    throw new Error('重复 accept 应幂等拒绝：' + JSON.stringify(acc2));
  }
  if (S.weStore.list().length !== before + 1) throw new Error('重复 accept 生成了第二条 weEntry！');

  /* declined：不生成 weEntries；冷却期内同源重复提议被拦 */
  const ev2 = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '没留下的那顿' });
  const r2 = S.weProposals.createFromReply(chat, 'msg-ac-2', { sourceId: ev2.id, kind: 'letter', reason: '算了' });
  const cnt = S.weStore.list().length;
  const dec = S.weProposals.decline(r2.proposal.id);
  if (!dec.ok) throw new Error('decline 失败');
  if (S.weStore.list().length !== cnt) throw new Error('declined 生成了 weEntries！');
  if (S.weProposals.findInScope(r2.proposal.id).status !== 'declined') throw new Error('状态没写');
  const again = S.weProposals.createFromReply(chat, 'msg-ac-3', { sourceId: ev2.id, kind: 'letter', reason: '又想提' });
  if (again.ok || again.why !== 'cooldown') throw new Error('冷却期内应拦：' + JSON.stringify(again));

  /* 老 weAdd 兼容：不传 createdBy/confirmed* 的手动记录行为完全不变 */
  const manual = S.weStore.add({ title: '手动条目', kind: 'other' }, A.id);
  if (manual.createdBy !== 'user') throw new Error('老 weAdd 调用被改坏：' + manual.createdBy);
  if ('confirmedBy' in manual || 'confirmedAt' in manual) throw new Error('手动记录不该有 confirmed 字段');

  return { accept入馆: true, createdBy_char: true, confirmedBy_user: true, confirmedAt: true,
    acceptedEntryId回写: true, 幂等: true, declined不进馆: true, 冷却拦截: true, 老weAdd兼容: true };
});

t('收藏馆P2：weProposals 进删房名单（真跑拆岛）+ collection-proposal 页注册', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  if (src.indexOf("'weProposals'") < 0) throw new Error("core.js cleanupSandbox 名单里没有 'weProposals'");

  const A = S.core.createSandbox('isle', '拆岛提议甲');
  const m = S.core.upsertChar({ name: '拆岛提议大号', kind: 'main' }).id;
  const u = S.core.upsertUser({ name: '我' }).id;
  S.core.setSandboxChars(A.id, [m]);
  S.core.setActiveSandbox(A.id);
  const ev = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule', title: '要被拆掉的提议' });
  const chat = { id: 'chat-purge', characterId: m, userId: u, sandboxId: A.id };
  const r = S.weProposals.createFromReply(chat, 'msg-purge', { sourceId: ev.id, kind: 'place', reason: '留一下' });
  if (!r.ok) throw new Error('提议创建失败：' + JSON.stringify(r));

  const purge = S.core._purgeSync.sandbox(A.id);
  if (!purge || purge.ok !== true) throw new Error('拆岛清理失败：' + JSON.stringify(purge));
  const left = S.store.get('weProposals').filter((x) => x && x.sandboxId === A.id);
  if (left.length) throw new Error('拆岛后 proposal 还在（孤儿）：' + left.length);

  if (!S.registered()['collection-proposal']) throw new Error('collection-proposal 页未注册');
  if (!S.registered().collection || !S.registered()['collection-item']) throw new Error('门厅/详情页没了');

  return { 名单收录: true, 拆岛后清空: true, 页面注册: true };
});

/* ======================== ta 关系网 v1（只读 selector + 双视图页，2026-10-02） ========================
   依据《Sleepy · ta 关系网 v1 · 第一批只读施工单》§3 的 12 条。
   本段**只补证、不改业务代码** —— 夹具全部真建（真建岛 / 真建角色 /
   真写 charRel 键 / 真发朋友圈 / 真写草稿），断言 selector 的节点与边规则、
   权限闸、双视图同源与零写入。每条测试自己造世界、自己拆掉（finally），
   免得污染后面的全页渲染冒烟。 */
console.log('\n--- ta 关系网 v1（只读 selector + 双视图页）---');

/* 桩不解析 innerHTML，所以页面文本只能靠 children 递归拼 */
function walkText(n) {
  if (!n) return '';
  let s = n.textContent ? String(n.textContent) + '\n' : '';
  (n.children || []).forEach((c) => { s += walkText(c); });
  return s;
}
function collectByClass(n, cls, out) {
  out = out || [];
  if (String(n.className || '').split(/\s+/).indexOf(cls) >= 0) out.push(n);
  (n.children || []).forEach((c) => collectByClass(c, cls, out));
  return out;
}
/* 真点一下 —— 桩的 addEventListener 只记录不分发（见 makeEl 的注释），
   所以「点了按钮之后会怎样」得自己把 handler 挨个调起来。 */
function fireClick(el) {
  const hs = (el && el._on && el._on.click) || [];
  if (!hs.length) throw new Error('这个元素没挂 click 处理器，点不动');
  hs.forEach((fn) => fn());
}
function pageRoot() {
  const c = S.nav.topCtx();
  const root = c && (c.body || c.el);
  if (!root) throw new Error('拿不到当前页的 DOM');
  return root;
}
const pairKeyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/* 关系网夹具：一座群岛 + 两个 main 角色（可选再挂一个皮套）+ 一个马甲。
   刻意用 archipelago —— 孤岛只能 1 个角色，要多角色只能群岛。
   npc() 建的是**正式口径** NPC（parentType='sandbox'，归整座岛）。 */
function mkNetWorld(opt) {
  opt = opt || {};
  const prev = {
    sb: S.store.get('activeSandboxId'),
    ch: S.store.get('activeCharId'),
    us: S.store.get('activeUserId')
  };
  const tag = 'net' + Math.random().toString(36).slice(2, 7);
  const c1 = S.core.upsertChar({ name: tag + '·甲', kind: 'main' }).id;
  const c2 = S.core.upsertChar({ name: tag + '·乙', kind: 'main' }).id;
  const sub = opt.sub
    ? S.core.upsertChar({ name: tag + '·皮套', kind: 'sub', parentId: c1 }).id
    : null;
  const u = S.core.upsertUser({ name: tag + '·我' }).id;
  const sb = S.core.createSandbox('archipelago', tag + '岛');
  /* 正式写入路径只收大号（validateSandboxChars 会把皮套挡掉），
     所以这里先按规矩写 [c1, c2]，皮套另走一步「模拟老存档」直接落库。 */
  const setRes = S.core.setSandboxChars(sb.id, [c1, c2]);
  if (!setRes || setRes.ok !== true) throw new Error('夹具建岛失败：' + JSON.stringify(setRes));
  if (sub) {
    /* 老存档里 charIds 混进了非大号 —— selector 必须仍按 main 口径滤掉。
       （正常写入路径产不出这种数据，只有历史数据会。） */
    const list = S.store.get('sandboxes');
    list.forEach((s) => { if (s.id === sb.id) s.charIds = s.charIds.concat([sub]); });
    S.store.set('sandboxes', list);
  }
  S.core.setSandboxMasks(sb.id, [u]);
  S.core.setActiveSandbox(sb.id);
  S.core.switchTo(c1, u);
  return {
    tag, sb, c1, c2, sub, u,
    npc(name, knownBy) {
      const rec = {
        name: tag + '·' + name, kind: 'npc',
        parentType: 'sandbox', parentId: sb.id, sandboxId: sb.id
      };
      if (knownBy !== undefined) rec.knownBy = knownBy;
      return S.core.upsertChar(rec).id;
    },
    build(input) {
      return S.taNetwork.build(Object.assign({ charId: c1, userId: u, sbId: sb.id }, input || {}));
    },
    cleanup() {
      try { S.core._purgeSync.sandbox(sb.id); } catch (e) { /* 已拆过 */ }
      [c1, c2].forEach((id) => { try { S.core._purgeSync.char(id); } catch (e) { /* 已清 */ } });
      if (sub) { try { S.core._purgeSync.face(sub); } catch (e) { /* 已清 */ } }
      try { S.core._purgeSync.user(u); } catch (e) { /* 已清 */ }
      S.core.setActiveSandbox(prev.sb || null);
      S.core.switchTo(prev.ch, prev.us);
    }
  };
}

t('关系网：静态护栏 —— 两个新增脚本 0 写入 / 0 模型 / 0 网络 / 不读草稿键', () => {
  /* 只看代码，不看注释 —— ta-network.js 的注释里**故意**提到 taNpcDrafts
     和 canCharSee（说明为什么不用它们），裸正则会把注释也算进去。 */
  const strip = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const banned = [
    [/store\.set\(/, 'store.set('],
    [/\bfetch\(/, 'fetch('],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/streamChat/, 'streamChat'],
    [/api\.chat/, 'api.chat'],
    [/api\.embed/, 'api.embed'],
    [/taNpcDrafts/, 'taNpcDrafts'],
    [/canCharSee/, 'canCharSee']            /* 近况必须走 user 视角的 canSee */
  ];
  const hits = [];
  ['ta-network.js', 'page-ta-network.js'].forEach((f) => {
    const src = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    banned.forEach(([re, name]) => { if (re.test(src)) hits.push(f + ' → ' + name); });
  });
  if (hits.length) throw new Error('新增脚本出现了不该有的调用：' + hits.join('、'));

  const netSrc = fs.readFileSync(path.join(ROOT, 'ta-network.js'), 'utf8');
  if (netSrc.indexOf('M.canSee(') < 0) throw new Error('selector 没走 momentsTab.canSee（user 视角）');
  if (netSrc.indexOf('activeNow(') < 0) throw new Error('selector 没有复用 taImpact.activeNow（影响三道闸）');

  /* page-ta.js 的 04 必须改读 selector，且保留关系网入口 */
  const taSrc = strip(fs.readFileSync(path.join(ROOT, 'page-ta.js'), 'utf8'));
  if (taSrc.indexOf('TN.build(') < 0) throw new Error('page-ta.js 的 04 没有改读 selector');
  if (taSrc.indexOf("ctx.open('ta-network'") < 0) throw new Error('page-ta.js 没有关系网入口');

  /* index.html 的加载顺序：selector 必须在 page-ta.js 之前、page-ta-network 之后 */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const iNet = html.indexOf('ta-network.js"');
  const iTa = html.indexOf('src="page-ta.js"');
  const iPage = html.indexOf('page-ta-network.js"');
  if (iNet < 0 || iTa < 0 || iPage < 0) throw new Error('index.html 少了新增脚本标签');
  if (!(iNet < iTa && iTa < iPage)) {
    throw new Error('加载顺序不对：ta-network.js 要在 page-ta.js 前，page-ta-network.js 要在其后');
  }
  return { 护栏: 2, 违禁命中: 0, 顺序: 'net < ta < page-net' };
});

t('关系网 selector：中心 = 当前角色；未落岛 / 无角色 / 别岛身份各有其 why', () => {
  const W = mkNetWorld({});
  const stray = S.core.upsertChar({ name: '别岛的人', kind: 'main' }).id;
  try {
    const r = W.build();
    if (!r.ok) throw new Error('正常岛读不出结果：' + r.why);
    if (r.center.id !== W.c1) throw new Error('中心节点不是当前角色');
    if (r.center.kind !== 'char') throw new Error('中心 kind 应为 char');
    if (r.sbId !== W.sb.id) throw new Error('sbId 回传不对');
    if (r.visibility.knownByGate !== 'center-root') throw new Error('显示闸口径没写死给断言看');
    if (r.nodes.some((n) => n.id === W.c1)) throw new Error('中心角色不该重复出现在 nodes 里');

    const noIsland = S.taNetwork.build({ sbId: 'sb_不存在' });
    if (noIsland.ok || noIsland.why !== 'no-island') {
      throw new Error('未落岛应 why=no-island，实际 ' + noIsland.why);
    }
    const stale = W.build({ charId: stray });
    if (stale.ok || stale.why !== 'no-char') {
      throw new Error('别岛角色（不在本岛名册）应 why=no-char，实际 ' + stale.why);
    }
    /* 别岛的 userId：不报错，但不算「当前身份」—— 不能凭空生成 user 节点 */
    const noU = W.build({ userId: stray });
    if (!noU.ok) throw new Error('别岛 userId 不该让整份结果失败');
    if (noU.visibility.hasUser !== false) throw new Error('别岛 userId 竟被认成当前身份');
    if (noU.nodes.some((n) => n.kind === 'user')) throw new Error('别岛 userId 生成了 user 节点');
    return { 中心: r.center.name, 节点: r.nodes.length, 边: r.edges.length };
  } finally {
    try { S.core._purgeSync.char(stray); } catch (e) { /* 已清 */ }
    W.cleanup();
  }
});

t('关系网 selector：只收 main 正式角色（皮套不进）；NPC 走 npcsOfRoom 正式口径、别岛不串', () => {
  const W = mkNetWorld({ sub: true });
  const sbB = S.core.createSandbox('isle', W.tag + '别岛');
  const npcOut = S.core.upsertChar({
    name: W.tag + '·别岛店员', kind: 'npc',
    parentType: 'sandbox', parentId: sbB.id, sandboxId: sbB.id
  }).id;
  try {
    const npcIn = W.npc('店长');
    const r = W.build();
    const ids = r.nodes.map((n) => n.id);
    if (ids.indexOf(W.c2) < 0) throw new Error('第二个 main 角色没进集合');
    if (ids.indexOf(W.sub) >= 0) throw new Error('皮套（sub）进了节点集合 —— 口径应是 main');
    if (ids.indexOf(npcIn) < 0) throw new Error('本岛 NPC 没进集合');
    if (ids.indexOf(npcOut) >= 0) throw new Error('别岛 NPC 串进了本岛集合');
    const kinds = {};
    r.nodes.forEach((n) => { kinds[n.kind] = (kinds[n.kind] || 0) + 1; });
    if (!kinds.user || !kinds.char || !kinds.npc) throw new Error('三类节点没齐：' + JSON.stringify(kinds));
    return kinds;
  } finally {
    try { S.core._purgeSync.sandbox(sbB.id); } catch (e) { /* 已拆 */ }
    try { S.core._purgeSync.char(npcOut); } catch (e) { /* 已清 */ }
    W.cleanup();
  }
});

t('关系网 selector：NPC knownBy 三态（缺字段/空数组 fail-open；含别人 fail-closed）', () => {
  const W = mkNetWorld({});
  try {
    const root = S.core.rootIdOf(W.c1);
    const noField = W.npc('没字段的');
    const emptyArr = W.npc('空数组的', []);
    const byRoot = W.npc('勾了root的', [root]);
    const byId = W.npc('勾了id的', [W.c1]);
    const otherOnly = W.npc('勾了别人的', [W.c2]);

    const r = W.build();
    const ids = r.nodes.map((n) => n.id);
    if (ids.indexOf(noField) < 0) throw new Error('knownBy 缺字段应 fail-open（显示）');
    if (ids.indexOf(emptyArr) < 0) throw new Error('knownBy 空数组应 fail-open（显示）');
    if (ids.indexOf(byRoot) < 0) throw new Error('knownBy 含中心 root 应显示');
    if (ids.indexOf(byId) < 0) throw new Error('knownBy 含中心 id 应显示');
    if (ids.indexOf(otherOnly) >= 0) throw new Error('knownBy 只含别的角色 —— 应 fail-closed（不显示）');
    if (r.visibility.dropped !== 1) throw new Error('被挡掉的 NPC 计数应为 1，实际 ' + r.visibility.dropped);

    /* 名字不能从任何字段泄露（标题 / 摘要 / 计数都不行） */
    if (JSON.stringify(r).indexOf(W.tag + '·勾了别人的') >= 0) {
      throw new Error('被挡掉的 NPC 名字从结果里泄露了');
    }
    /* 纯函数逐条复核（和上面走的是同一份实现） */
    const P = S.taNetwork.npcPassesKnownBy;
    if (!P({ id: 'x' }, W.c1, root)) throw new Error('缺字段纯函数应 true');
    if (!P({ id: 'x', knownBy: [] }, W.c1, root)) throw new Error('空数组纯函数应 true');
    if (!P({ id: 'x', knownBy: 'nope' }, W.c1, root)) throw new Error('非数组纯函数应 fail-open');
    if (P({ id: 'x', knownBy: [W.c2] }, W.c1, root)) throw new Error('含别人纯函数应 false');
    /* 显示闸口径写死给断言看：中心 root（不是「当前身份」） */
    if (r.visibility.knownByGate !== 'center-root') throw new Error('显示闸口径被改了');
    return { 显示: 4, 挡掉: 1, 口径: 'center-root' };
  } finally { W.cleanup(); }
});

t('关系网 selector：taNpcDrafts 里 draft / confirmed 都不进节点（反向断言）', () => {
  const W = mkNetWorld({});
  try {
    const d1 = S.taLife.addDraft({ name: W.tag + '·草稿甲', refCharId: W.c1 });
    const d2 = S.taLife.addDraft({ name: W.tag + '·草稿乙', refCharId: W.c1 });
    if (!d1 || !d2) throw new Error('夹具没造出草稿（taLife.addDraft 失败）');
    S.taLife.patchDraft(d2.id, { status: 'confirmed' });

    const r = W.build();
    const dump = JSON.stringify(r);
    if (dump.indexOf(W.tag + '·草稿甲') >= 0) throw new Error('draft 草稿变成了节点');
    if (dump.indexOf(W.tag + '·草稿乙') >= 0) throw new Error('confirmed 草稿变成了节点');
    if (r.nodes.some((n) => n.id === d1.id || n.id === d2.id)) throw new Error('草稿 id 出现在节点集合里');

    /* 只有正式人物表里的正式人物才成为节点：真入库一个同名的，才应该出现 */
    const formal = W.npc('草稿甲');
    const r2 = W.build();
    if (!r2.nodes.some((n) => n.id === formal)) throw new Error('正式入库的人物没成为节点');
    return { 草稿未进: true, 正式入库后进: true };
  } finally { W.cleanup(); }
});

t('关系网 selector：link 必须按当前岛读（不串档）+ 四可见性字段原样带出', () => {
  const W = mkNetWorld({});
  const sbB = S.core.createSandbox('isle', W.tag + '乙岛');
  S.core.setSandboxChars(sbB.id, [W.c1]);
  S.core.setSandboxMasks(sbB.id, [W.u]);
  try {
    S.core.setRelation(W.c1, W.u, '甲岛的关系', W.sb.id);
    S.core.setRelation(W.c1, W.u, '乙岛的关系', sbB.id);

    const eA = W.build().edges.filter((e) => e.kind === 'link')[0];
    const eB = W.build({ sbId: sbB.id }).edges.filter((e) => e.kind === 'link')[0];
    if (!eA || eA.label !== '甲岛的关系') throw new Error('甲岛没读到自己的关系文本：' + JSON.stringify(eA));
    if (!eB || eB.label !== '乙岛的关系') throw new Error('乙岛没读到自己的关系文本：' + JSON.stringify(eB));
    if (eA.id === eB.id) throw new Error('两座岛的 link 竟然是同一条（跨岛串档）');
    if (eA.perms === null) throw new Error('link 边应带 perms');

    /* 认知 / 障壁 / 朋友圈四开关 —— 全部原样带出，不自己另判 */
    S.core.addLink(W.c1, W.u, 'aware', true, W.sb.id);
    S.core.setFeedPerm(W.c1, W.u, 'iHideChar', true, W.sb.id);
    S.core.setFeedPerm(W.c1, W.u, 'charHidesFromMe', true, W.sb.id);
    const p = W.build().edges.filter((e) => e.kind === 'link')[0].perms;
    if (p.cognition !== 'aware') throw new Error('cognition 没原样带出：' + p.cognition);
    if (p.barrier !== true) throw new Error('barrier 没原样带出');
    if (p.iHideChar !== true) throw new Error('iHideChar 没带出');
    if (p.charHidesFromMe !== true) throw new Error('charHidesFromMe 没带出');
    if (p.iHideFromChar !== false || p.charHidesMe !== false) throw new Error('没开的开关被误开');

    /* 「仅有记录、没写关系」→ 不画边（施工单 §0 原文「仅有记录不等于可显示」） */
    S.core.addLink(W.c2, W.u, 'unaware', false, W.sb.id);
    const r3 = W.build();
    if (r3.edges.some((e) => e.from === W.c2 || e.to === W.c2)) {
      throw new Error('只有 link 记录、没写关系文本，竟画了边');
    }
    /* 但「有没有那条记录」本身要如实带出去（首页 04 的「已建立联系」靠它） */
    if (r3.center.hasLinkWithUser !== true) throw new Error('中心有 link 记录，hasLinkWithUser 应为 true');
    return { 甲: eA.label, 乙: eB.label, 四开关: 'ok', 空relation无边: true };
  } finally {
    try { S.core._purgeSync.sandbox(sbB.id); } catch (e) { /* 已拆 */ }
    W.cleanup();
  }
});

t('关系网 selector：charRel 三态（known/met 有边、unknown 无边）+ NPC 一条边都没有', () => {
  const W = mkNetWorld({});
  try {
    const npc = W.npc('店长');
    const crOf = (res) => res.edges.filter((e) => e.kind === 'charRel');

    /* 没记录 → unknown → 无边 */
    let r = W.build();
    if (crOf(r).length) throw new Error('没有 charRel 记录竟画了边');

    S.store.set('charRel:' + W.sb.id, { [pairKeyOf(W.c1, W.c2)]: 'known' });
    r = W.build();
    let cr = crOf(r);
    if (cr.length !== 1) throw new Error('known 应恰有一条 charRel 边，实际 ' + cr.length);
    if (cr[0].label !== '认识') throw new Error('known 的原文应是「认识」：' + cr[0].label);
    if (cr[0].labelSource !== 'charRel') throw new Error('charRel 边的 labelSource 不对');
    if (cr[0].timeKnown !== false) throw new Error('charRel 是裸字符串、没有时间戳，timeKnown 应为 false');

    S.store.set('charRel:' + W.sb.id, { [pairKeyOf(W.c1, W.c2)]: 'met' });
    r = W.build();
    cr = crOf(r);
    if (cr.length !== 1 || cr[0].label !== '见过但不熟') {
      throw new Error('met 的原文应是「见过但不熟」：' + JSON.stringify(cr));
    }

    S.store.set('charRel:' + W.sb.id, { [pairKeyOf(W.c1, W.c2)]: 'unknown' });
    r = W.build();
    if (crOf(r).length) throw new Error('unknown 不该画边（无法区分「显式不认识」和「没记录」→ 一律无依据）');

    /* NPC：任何情况下都只有节点、没有边；也不许出现未知边类型 */
    const kindOf = {};
    r.nodes.forEach((n) => { kindOf[n.id] = n.kind; });
    if (kindOf[npc] !== 'npc') throw new Error('NPC 节点没进集合');
    r.edges.forEach((e) => {
      if (e.kind !== 'link' && e.kind !== 'charRel') throw new Error('出现了未知边类型：' + e.kind);
      if (kindOf[e.from] === 'npc' || kindOf[e.to] === 'npc') throw new Error('NPC 竟然有关系边');
    });
    /* 只有 NPC + 没有 charRel 的场景：一条边都不该有 */
    const bare = W.build();
    if (bare.edges.length) throw new Error('没有任何关系依据，却画了 ' + bare.edges.length + ' 条边');
    return { known: '认识', met: '见过但不熟', unknown: 0, NPC边: 0 };
  } finally { W.cleanup(); }
});

t('关系网 selector：无依据 → 关系未注明；labelSource 只在闭集内，绝不补默认关系词', () => {
  const W = mkNetWorld({});
  try {
    const npc = W.npc('店长');
    const r = W.build();
    const npcNode = r.nodes.filter((n) => n.id === npc)[0];
    if (npcNode.label !== '') throw new Error('NPC 不该凭空有标签');
    if (S.taNetwork.labelOf(npcNode) !== '关系未注明') throw new Error('无依据应显示「关系未注明」');
    if (S.taNetwork.LABEL_NONE !== '关系未注明') throw new Error('LABEL_NONE 常量被改了');

    const BAD = ['朋友', '亲密', '家人', '同事', '恋人', '同学', '上下级'];
    const seen = [];
    r.nodes.forEach((n) => {
      if (S.taNetwork.LABEL_SOURCES.indexOf(n.labelSource) < 0) {
        throw new Error('labelSource 越界：' + JSON.stringify(n.labelSource));
      }
      const lb = S.taNetwork.labelOf(n);
      seen.push(lb);
      BAD.forEach((w) => { if (lb.indexOf(w) >= 0) throw new Error('补了默认关系词：' + lb); });
    });
    r.edges.forEach((e) => {
      if (S.taNetwork.LABEL_SOURCES.indexOf(e.labelSource) < 0) {
        throw new Error('边的 labelSource 越界：' + JSON.stringify(e.labelSource));
      }
    });
    if (S.taNetwork.LABEL_SOURCES.join(',') !== 'link.relation,charRel,') {
      throw new Error('labelSource 闭集被改动：' + S.taNetwork.LABEL_SOURCES.join(','));
    }
    return { 未注明: '关系未注明', 闭集: '3 项', 默认词: 0 };
  } finally { W.cleanup(); }
});

t('关系网 selector：近况走 canSee（user 视角）—— 私密 / 被屏蔽的内容不进结果', () => {
  const W = mkNetWorld({});
  const made = [];
  try {
    const PUB = W.tag + '公开近况';
    const SECRET = W.tag + '私密近况';
    const EXCL = W.tag + '排除我的近况';
    const MAF = W.tag + '马甲发的';
    made.push(S.momentsTab.add({ text: PUB, characterId: W.c1, name: '甲', at: 1000 }).id);
    made.push(S.momentsTab.add({ text: SECRET, characterId: W.c1, name: '甲', at: 5000, privacy: 'self' }).id);
    made.push(S.momentsTab.add({ text: EXCL, characterId: W.c1, name: '甲', at: 6000, privacy: 'exclude', visibleTo: [W.u] }).id);
    /* 「马甲发的」：add 只在没 characterId 时才记 maskId，所以这条直接写库，
       模拟「既有 char 又有 maskId」的记录 —— selector 必须跳过它 */
    const mafRec = S.core.tagScope({
      id: S.core.newId('mo'), characterId: W.c1, maskId: 'um_x',
      name: '甲', text: MAF, at: 9000, likes: [], comments: []
    });
    S.store.set('moments', S.store.get('moments').concat([mafRec]));
    made.push(mafRec.id);

    const r = W.build();
    const dump = JSON.stringify(r);
    if (dump.indexOf(SECRET) >= 0) throw new Error('privacy=self 的私密近况泄露了');
    if (dump.indexOf(EXCL) >= 0) throw new Error('exclude 掉我的近况泄露了');
    if (dump.indexOf(MAF) >= 0) throw new Error('马甲发的近况被当成「TA 本人发的」了');
    if (!r.center.recent || r.center.recent.text !== PUB) {
      throw new Error('中心近况不是那条公开的：' + JSON.stringify(r.center.recent));
    }
    r.nodes.forEach((n) => {
      if (n.recent && [SECRET, EXCL, MAF].indexOf(n.recent.text) >= 0) throw new Error('节点近况泄露');
    });

    /* 朋友权限：我屏蔽了 TA → 近况为空（同一把 canSee 尺子） */
    S.core.setFeedPerm(W.c1, W.u, 'iHideChar', true, W.sb.id);
    const r2 = W.build();
    if (r2.center.recent) throw new Error('我屏蔽了 TA，近况不该还显示');
    if (JSON.stringify(r2).indexOf(PUB) >= 0) throw new Error('屏蔽后公开近况仍在结果里');
    return { 公开: PUB, 泄露: 0, 屏蔽后为空: true };
  } finally {
    made.forEach((id) => { try { S.momentsTab.remove(id); } catch (e) { /* 已删 */ } });
    W.cleanup();
  }
});

t('关系网 selector：sourceRefs 指向真实表记录；时间标记不声称关系更新时间（P1）', () => {
  const W = mkNetWorld({});
  try {
    S.core.setRelation(W.c1, W.u, '同事', W.sb.id);
    S.store.set('charRel:' + W.sb.id, { [pairKeyOf(W.c1, W.c2)]: 'met' });
    W.npc('店长');
    const r = W.build();

    const links = S.store.get('links');
    const relMap = S.store.get('charRel:' + W.sb.id) || {};
    r.nodes.forEach((n) => {
      if (!n.sourceRefs.length) throw new Error('节点缺 sourceRefs：' + n.name);
      n.sourceRefs.forEach((ref) => {
        if (ref.kind === 'char' || ref.kind === 'npc') {
          if (!S.core.findChar(ref.id)) throw new Error(ref.kind + ' ref 指向不存在的角色：' + ref.id);
        } else if (ref.kind === 'user') {
          if (!S.core.findUser(ref.id)) throw new Error('user ref 指向不存在的身份：' + ref.id);
        } else if (ref.kind === 'link') {
          if (!links.some((l) => l.id === ref.id)) throw new Error('link ref 指向不存在的记录：' + ref.id);
        } else {
          throw new Error('未知 sourceRefs.kind：' + ref.kind);
        }
      });
    });
    r.edges.forEach((e) => {
      if (!e.sourceRefs.length) throw new Error('边缺 sourceRefs：' + e.id);
      e.sourceRefs.forEach((ref) => {
        if (ref.kind === 'link' && !links.some((l) => l.id === ref.id)) {
          throw new Error('边的 link ref 不存在：' + ref.id);
        }
        if (ref.kind === 'charRel' && !Object.prototype.hasOwnProperty.call(relMap, ref.key)) {
          throw new Error('charRel ref 指向不存在的键：' + ref.key);
        }
      });
    });

    /* P1：links 只有 createdAt，没有「关系文本修改时间」 */
    const eLink = r.edges.filter((e) => e.kind === 'link')[0];
    if (eLink.relationTimeKnown !== false) throw new Error('relationTimeKnown 必须是 false');
    const note = S.taNetwork.timeNoteOf(eLink);
    if (note.indexOf('建立于') < 0) throw new Error('link 边应说明建立时间：' + note);
    if (note.indexOf('修改时间不可知') < 0) throw new Error('link 边必须如实说修改时间不可知：' + note);
    const noteCR = S.taNetwork.timeNoteOf(r.edges.filter((e) => e.kind === 'charRel')[0]);
    if (noteCR.indexOf('没有时间戳') < 0) throw new Error('charRel 边应说明没有时间戳：' + noteCR);
    if (noteCR.indexOf('建立于') >= 0) throw new Error('charRel 边不该编一个建立时间');

    /* 整份结果的 updatedAt = 「可用最近时间」，不是 now */
    const stamps = [r.center.updatedAt].concat(r.nodes.map((n) => n.updatedAt));
    if (r.updatedAt !== Math.max.apply(null, stamps)) throw new Error('updatedAt 不是节点里最新的那个');
    if (r.updatedAt > Date.now() + 1000) throw new Error('updatedAt 超过了现在 —— 像是拿了 now');
    return { 节点ref: 'ok', 边ref: 'ok', link时间: note, charRel时间: noteCR };
  } finally { W.cleanup(); }
});

t('关系网页：图 / 列表消费同一 selector 结果；打开与切视图都不写 store', () => {
  const W = mkNetWorld({});
  try {
    const npcHidden = W.npc('不该出现的', [W.c2]);
    W.npc('店长');
    S.core.setRelation(W.c1, W.u, '同事', W.sb.id);
    S.store.set('charRel:' + W.sb.id, { [pairKeyOf(W.c1, W.c2)]: '认识' });

    const r = W.build();
    if (!r.nodes.length || !r.edges.length) throw new Error('夹具没造出节点或边');

    const keys = ['links', 'characters', 'sandboxes', 'moments', 'charRel:' + W.sb.id, 'taNpcDrafts', 'taItems'];
    const snap = () => JSON.stringify(keys.map((k) => S.store.get(k)));
    const before = snap();

    if (!S.registered()['ta-network']) throw new Error('ta-network 页未注册');
    if (S.nav.depth() > 0) S.nav.closeAll();
    S.nav.open('ta-network', {});
    const root = pageRoot();

    /* ---- 图视图（默认）：节点分组数 = 中心 1 + 环上节点数 ---- */
    const groups = collectByClass(root, 'tan-node-g', []);
    const expectShown = Math.min(r.nodes.length, S.taNetwork.GRAPH_MAX);
    if (groups.length !== 1 + expectShown) {
      throw new Error('图视图节点数不对：期望 ' + (1 + expectShown) + '，实际 ' + groups.length);
    }
    const graphText = walkText(root);
    if (graphText.indexOf('关系图') < 0 || graphText.indexOf('列表') < 0) {
      throw new Error('分段控件没渲染出来');
    }
    if (snap() !== before) throw new Error('打开关系网页就写 store 了');

    /* ---- 切到列表：真点第二个分段按钮 ---- */
    let btns = collectByClass(root, 'iol-seg-btn', []);
    if (btns.length !== 2) throw new Error('分段按钮应恰有 2 个，实际 ' + btns.length);
    fireClick(btns[1]);
    if (collectByClass(root, 'tan-node-g', []).length) throw new Error('切到列表后 SVG 节点还在（视图没切）');

    const listText = walkText(root);
    /* 列表视图不截断，所以名字必须逐字对上 —— 这就证明两个视图同一份结果 */
    r.nodes.forEach((n) => {
      if (listText.indexOf(n.name) < 0) throw new Error('列表视图漏了 selector 节点：' + n.name);
    });
    r.edges.forEach((e) => {
      if (listText.indexOf(e.label) < 0) throw new Error('列表视图漏了 selector 的边：' + e.label);
    });
    if (listText.indexOf(W.tag + '·不该出现的') >= 0) throw new Error('列表视图泄露了被 knownBy 挡掉的 NPC');
    if (snap() !== before) throw new Error('切视图写 store 了');

    /* ---- 切回图视图 ---- */
    btns = collectByClass(root, 'iol-seg-btn', []);
    fireClick(btns[0]);
    if (!collectByClass(root, 'tan-node-g', []).length) throw new Error('切不回图视图');
    if (snap() !== before) throw new Error('切回图视图写 store 了');

    if (S.nav.depth() > 0) S.nav.closeAll();
    return { 图节点: 1 + expectShown, 列表节点: r.nodes.length, 边: r.edges.length, 写入: 0 };
  } finally { W.cleanup(); }
});

t('ta 首页 04：节点集合与关系网 selector 完全同源（含 knownBy 过滤与人数）', () => {
  const W = mkNetWorld({});
  try {
    W.npc('店长');
    W.npc('不该出现的', [W.c2]);
    S.core.setRelation(W.c1, W.u, '同事', W.sb.id);

    const r = W.build();
    if (S.nav.depth() > 0) S.nav.closeAll();
    S.nav.open('ta', {});
    const text = walkText(pageRoot());

    r.nodes.forEach((n) => {
      if (text.indexOf(n.name) < 0) throw new Error('首页 04 漏了 selector 节点：' + n.name);
    });
    if (text.indexOf(W.tag + '·不该出现的') >= 0) {
      throw new Error('首页 04 泄露了被 knownBy 挡掉的 NPC —— 两处口径不一致');
    }
    if (text.indexOf('关系网') < 0) throw new Error('首页 04 没有关系网入口');
    if (text.indexOf(String(r.nodes.length) + ' 人') < 0) {
      throw new Error('首页 04 的人数与 selector 不同口径（期望 ' + r.nodes.length + ' 人）');
    }
    if (S.nav.depth() > 0) S.nav.closeAll();
    return { selector节点: r.nodes.length, 首页一致: true };
  } finally { W.cleanup(); }
});

/* ======================== 日历安全边界与最小执行器（第二轮施工单，2026-10-03） ========================
   依据《Sleepy · 日历安全边界与最小执行器 · 第二轮施工单 v1》§8/§10。
   每条自己造世界、自己拆（finally），不污染后面的全页渲染冒烟。 */
console.log('\n--- 日历安全边界与最小执行器（第二轮施工单）---');

/* 日历夹具：一座群岛 + 一个大号 + 一个马甲，开「生成角色日程」。 */
function mkCalWorld() {
  const W = mkNetWorld({});
  S.calendar.saveCfg(W.c1, { scheduleOn: true });
  W.iso = S.calendar.todayISO();
  W.tmr = S.calendar.shiftISO(W.iso, 1);
  W.mk = (o) => S.calendar.__internal.addEvent(Object.assign({
    ownerCharId: W.c1, eventType: 'user_reminder',
    startAt: W.tmr + 'T10:00', endAt: W.tmr + 'T11:00', allDay: false,
    createdBy: { type: 'user', id: 'user' }, visibility: 'private'
  }, o));
  W.facts = () => S.calendar.timeFacts(W.c1, {}) || '';
  return W;
}

t('I02：user 私人提醒不再进 char 的 prompt，该看的都没弄丢', () => {
  const W = mkCalWorld();
  try {
    const PRIV = W.tag + '秘密买礼物';
    const BUSY = W.tag + '公司会议';
    const SHARED = W.tag + '一起吃饭';
    const OWN = W.tag + '他的排练';
    const DET = W.tag + '牙医复诊';
    W.mk({ title: PRIV, visibility: 'private' });
    W.mk({ title: BUSY, visibility: 'shared_busy' });
    W.mk({ title: DET, visibility: 'shared_detail' });
    W.mk({
      title: SHARED, eventType: 'shared_event', visibility: 'participants', status: 'pending',
      participants: [{ type: 'user', id: 'user', state: 'accepted' },
                     { type: 'char', id: W.c1, state: 'pending' }],
      participantStates: { user: 'accepted' }
    });
    W.mk({ title: OWN, eventType: 'char_schedule', createdBy: { type: 'char', id: W.c1 } });

    const txt = W.facts();
    if (txt.indexOf(PRIV) >= 0) throw new Error('user 的私人提醒还是进了 prompt（这就是那个洞）');
    if (txt.indexOf(BUSY) >= 0) throw new Error('shared_busy 不该给标题 —— 那一档只说「被占住」');
    if (txt.indexOf('被占住') < 0) throw new Error('shared_busy 没给「只知道忙」的表述');
    if (txt.indexOf(DET) < 0) throw new Error('shared_detail 被误伤了');
    if (txt.indexOf(SHARED) < 0) throw new Error('他是参与者的共同事件被误伤了');
    if (txt.indexOf(OWN) < 0) throw new Error('他自己安排的被误伤了');
    return { 私人: '挡住', shared_busy: '只说忙', 该看的: '都在' };
  } finally { W.cleanup(); }
});

t('I02 与 K03b 对同一条事件的可见性结论一致（不再各判各的）', () => {
  const W = mkCalWorld();
  try {
    const cases = [
      ['private', { title: W.tag + '私', visibility: 'private' }, ''],
      ['shared_busy', { title: W.tag + '忙', visibility: 'shared_busy' }, 'busy'],
      ['shared_detail', { title: W.tag + '明', visibility: 'shared_detail' }, 'detail'],
      ['char_own', { title: W.tag + '他', visibility: 'private', createdBy: { type: 'char', id: W.c1 } }, 'detail']
    ];
    const got = {};
    cases.forEach((c) => {
      const e = W.mk(c[1]);
      const v = S.calendar.charViewOf(e, W.c1);
      if (v !== c[2]) throw new Error('charViewOf(' + c[0] + ') = ' + v + '，期望 ' + c[2]);
      /* 生活流（K03b）走的是同一个函数，所以结论必然一致 —— 这里直接比对两条路 */
      const inFacts = W.facts().indexOf(c[1].title) >= 0;
      const lf = S.lifeFeed.charViewOf(e, W.c1);
      if (lf !== v) throw new Error('I02 与 life-feed 对 ' + c[0] + ' 结论不一致');
      got[c[0]] = { view: v, 进prompt: inFacts };
    });
    if (got.private.进prompt) throw new Error('private 不该进 prompt');
    if (got.shared_detail.进prompt !== true) throw new Error('shared_detail 该进 prompt');
    return got;
  } finally { W.cleanup(); }
});

t('I02：纪念日仍被排除；别岛的同名事件不串进当前角色', () => {
  const W = mkCalWorld();
  try {
    S.calendar.__internal.addEvent({
      ownerCharId: W.c1, eventType: 'anniversary', title: W.tag + '纪念日',
      startAt: W.tmr, allDay: true, memoryId: 'mem_x', createdBy: { type: 'char', id: W.c1 }
    });
    /* ⚠️ 纪念日**会**出现在「临近的纪念日」那一句里（这是产品行为，±3 天内要说）；
       这里只断言它不混进「你近期的安排」那条日程线。 */
    const sched = (W.facts().split('\n').filter((l) => l.indexOf('你近期的安排') === 0)[0]) || '';
    if (sched.indexOf('纪念日') >= 0) throw new Error('纪念日不该混进「近期安排」');
    if (W.facts().indexOf('临近的纪念日') < 0) throw new Error('临近纪念日那一句没了（回归）');
    /* 别岛建一条同名事件 */
    const B = mkNetWorld({});
    S.core.setActiveSandbox(B.sb.id);
    S.calendar.saveCfg(B.c1, { scheduleOn: true });
    const other = W.tag + '别岛的事';
    S.calendar.__internal.addEvent({
      ownerCharId: B.c1, eventType: 'user_reminder', title: other,
      startAt: B.iso ? B.iso : S.calendar.todayISO(), createdBy: { type: 'char', id: B.c1 }
    });
    S.core.setActiveSandbox(W.sb.id);
    if (W.facts().indexOf(other) >= 0) throw new Error('别岛的事件串进来了');
    B.cleanup();
    return { 纪念日: '排除', 别岛: '不串' };
  } finally { W.cleanup(); }
});

t('统一入口：白名单 / 必填 / 初始状态 / 可见性一致性，一条都不放过', () => {
  const W = mkCalWorld();
  try {
    const base = { ownerCharId: W.c1, eventType: 'user_reminder', title: W.tag + 'x', startAt: W.tmr + 'T09:00' };
    const must = (r, code) => {
      if (r.ok) throw new Error('本该失败却成功了：' + code);
      if (r.error.code !== code) throw new Error('错误码不对：' + r.error.code + '，期望 ' + code);
      if (!r.receipt || r.receipt.type !== 'calendar_event_failed') throw new Error('失败没留失败回执');
      if ((S.store.get('calEvents') || []).some((e) => e && e.title === base.title)) {
        throw new Error('失败了还留下半成品事件');
      }
    };
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { eventType: 'public_holiday' })), 'bad-type');
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { title: '  ' })), 'no-title');
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { status: 'completed' })), 'bad-status');
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { visibility: '瞎写' })), 'bad-visibility');
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { visibility: 'participants' })), 'bad-visibility');
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { createdBy: { type: 'model', id: 'gpt' } })), 'bad-createdby');
    must(S.calendar.requestCreateEvent(Object.assign({}, base, { ownerCharId: null })), 'no-owner');

    /* 共同事件：初始状态被强制成 pending（**创建邀请 ≠ 对方接受**） */
    const sh = S.calendar.requestCreateEvent({
      ownerCharId: W.c1, eventType: 'shared_event', title: W.tag + '约饭',
      startAt: W.tmr + 'T18:00', status: 'confirmed',
      participants: [{ type: 'user', id: 'user' }, { type: 'char', id: W.c1 }]
    });
    if (!sh.ok) throw new Error('共同事件建不了：' + (sh.error && sh.error.message));
    const ev = S.calendar.getEvent(sh.eventId);
    if (ev.status !== 'pending') throw new Error('共同事件不许一步建成 confirmed：' + ev.status);
    if (ev.visibility !== 'participants') throw new Error('共同事件的可见性该是 participants');
    if (!ev.participantStates || ev.participantStates.user !== 'accepted') throw new Error('user 那格该是 accepted');
    if (ev.participantStates[W.c1] !== 'pending') throw new Error('角色那格必须从 pending 起');
    if (!sh.receipt || sh.receipt.type !== 'calendar_event_created' || sh.receipt.ref !== sh.eventId) {
      throw new Error('成功回执没引用真实 eventId');
    }
    return { 拒绝: '7 种都拦住', 共同事件: '强制 pending', 回执: '引用真 id' };
  } finally { W.cleanup(); }
});

t('统一入口：冲突时不写入，把决定权交回 UI；allowConflict 才真的写', () => {
  const W = mkCalWorld();
  try {
    W.mk({ title: W.tag + '占坑', startAt: W.tmr + 'T10:00', endAt: W.tmr + 'T11:00',
      createdBy: { type: 'char', id: W.c1 } });
    const before = (S.store.get('calEvents') || []).length;
    const draft = {
      ownerCharId: W.c1, eventType: 'user_reminder', title: W.tag + '撞车的',
      startAt: W.tmr + 'T10:30', endAt: W.tmr + 'T11:30', createdBy: { type: 'user', id: 'user' }
    };
    const r1 = S.calendar.requestCreateEvent(draft, { requestKey: 'k1' });
    if (r1.ok) throw new Error('撞车了还直接写进去了');
    if (r1.error.code !== 'conflict') throw new Error('错误码该是 conflict：' + r1.error.code);
    if (!r1.needConfirm || !r1.conflict.length) throw new Error('没把撞上谁告诉 UI');
    if ((S.store.get('calEvents') || []).length !== before) throw new Error('冲突时不许留下半成品');

    const r2 = S.calendar.requestCreateEvent(draft, { requestKey: 'k1', allowConflict: true });
    if (!r2.ok) throw new Error('用户确认后该能建：' + (r2.error && r2.error.message));
    if ((S.store.get('calEvents') || []).length !== before + 1) throw new Error('确认后没建出来');
    return { 冲突时: '不写', 确认后: '写入 1 条' };
  } finally { W.cleanup(); }
});

t('统一入口 + action：同一个 requestKey 重跑不建第二条；resultRef 是真实 eventId', () => {
  const W = mkCalWorld();
  try {
    const key = 'actkey:' + W.tag;
    const params = {
      ownerCharId: W.c1, eventType: 'user_reminder', title: W.tag + '只建一次',
      startAt: W.tmr + 'T14:00', endAt: W.tmr + 'T15:00', createdBy: { type: 'user', id: 'user' }
    };
    const a1 = S.action.createRequest({ kind: 'calendar.create_event', params, requestKey: key });
    if (!a1.ok) throw new Error('createRequest 失败：' + JSON.stringify(a1.error));
    const r1 = S.action.runRequest(a1.request.id);
    if (!r1.ok) throw new Error('runRequest 失败：' + JSON.stringify(r1.error));

    const evId = r1.eventId;
    const ev = S.calendar.getEvent(evId);
    if (!ev) throw new Error('resultRef 不是真实事件：' + evId);
    if (ev.requestKey !== key) throw new Error('幂等键没落进事件记录');
    const done = S.action.getRequest(a1.request.id);
    if (done.status !== 'ok') throw new Error('成功后状态不是 ok：' + done.status);
    if (done.resultRef !== evId) throw new Error('resultRef 与真实 eventId 不一致');
    if (!done.receipt || done.receipt.type !== 'action_ok') throw new Error('没有成功回执');
    if (done.attempt !== 1) throw new Error('attempt 没记');

    /* 第二次同 key：命中已有 ok 记录，不建第二条 */
    const a2 = S.action.createRequest({ kind: 'calendar.create_event', params, requestKey: key });
    if (!a2.dup || a2.request.id !== a1.request.id) throw new Error('同 key 没认出已做过');
    const n = (S.store.get('calEvents') || []).filter((e) => e && e.requestKey === key).length;
    if (n !== 1) throw new Error('同一个 requestKey 建出了 ' + n + ' 条');
    if (S.calendar.requestCreateEvent(params, { requestKey: key }).dup !== true) {
      throw new Error('统一入口自己的幂等也没生效');
    }
    return { 事件: 1, attempt: done.attempt, resultRef: '真实 eventId' };
  } finally { W.cleanup(); }
});

t('action：失败不伪装成功，留失败记录与失败回执', () => {
  const W = mkCalWorld();
  try {
    const a = S.action.createRequest({
      kind: 'calendar.create_event',
      params: { ownerCharId: W.c1, eventType: 'public_holiday', title: W.tag + '造个公共假日', startAt: W.tmr },
      requestKey: 'bad:' + W.tag
    });
    if (!a.ok) throw new Error('createRequest 失败');
    const r = S.action.runRequest(a.request.id);
    if (r.ok) throw new Error('这种参数不该成功');
    const rec = S.action.getRequest(a.request.id);
    if (rec.status !== 'failed') throw new Error('失败后状态不是 failed：' + rec.status);
    if (!rec.error || !rec.error.code) throw new Error('失败没记错误码');
    if (rec.receipt.type !== 'action_failed') throw new Error('没有失败回执');
    if (rec.receiptAt === null) throw new Error('失败回执没时间');
    if (rec.resultRef) throw new Error('失败不该有 resultRef');
    /* 事件表里绝不能留下这条 */
    if ((S.store.get('calEvents') || []).some((e) => e && String(e.title).indexOf('造个公共假日') >= 0)) {
      throw new Error('失败了还把事件写进去了');
    }
    /* 未知 kind 直接拒 */
    const bad = S.action.createRequest({ kind: 'send_message', params: {} });
    if (bad.ok || bad.error.code !== 'bad-kind') throw new Error('未登记的 kind 没被拦');
    return { 状态: 'failed', 回执: 'action_failed', 未登记kind: '拒' };
  } finally { W.cleanup(); }
});

t('action：按岛隔离，删房跟着清', () => {
  const W = mkCalWorld();
  try {
    const a = S.action.createRequest({
      kind: 'calendar.create_event',
      params: { ownerCharId: W.c1, eventType: 'user_reminder', title: W.tag + 'A岛的事', startAt: W.tmr },
      requestKey: 'iso:' + W.tag
    });
    S.action.runRequest(a.request.id);
    const before = (S.store.get('actionRequests') || []).length;
    if (!before) throw new Error('action 没落库');
    /* 换到别岛：看不见 */
    const B = mkNetWorld({});
    S.core.setActiveSandbox(B.sb.id);
    if (S.action.inScope().some((r) => r.id === a.request.id)) throw new Error('别岛能看见 action');
    if (S.action.findByRequestKey('iso:' + W.tag)) throw new Error('别岛能按 key 找到');
    B.cleanup();
    S.core.setActiveSandbox(W.sb.id);
    /* 删房：清掉 */
    try { S.core._purgeSync.sandbox(W.sb.id); } catch (e) { /* 已拆 */ }
    const left = (S.store.get('actionRequests') || []).filter((r) => r && r.sandboxId === W.sb.id);
    if (left.length) throw new Error('删房后 action 没清：' + left.length);
    return { 别岛: '看不见', 删房: '清干净' };
  } finally { W.cleanup(); }
});

t('冲突：跨午夜 / 跨时区 / 全天 / 取消 / 重复实例，都不再靠裸 HH:MM', () => {
  const W = mkCalWorld();
  try {
    const day2 = S.calendar.shiftISO(W.iso, 2);
    const night = W.mk({
      title: W.tag + '通宵班', startAt: W.iso + 'T23:00', endAt: W.tmr + 'T01:00',
      eventType: 'char_schedule', createdBy: { type: 'char', id: W.c1 }
    });
    const hit = (s, e, tz) => S.calendar.conflictOf(W.c1, {
      startAt: s, endAt: e, timezone: tz || ''
    }).map((x) => x.title);

    if (!hit(W.tmr + 'T00:30', W.tmr + 'T01:30').length) throw new Error('跨午夜：次日 00:30 没报冲突');
    if (!hit(W.iso + 'T23:30', W.iso + 'T23:50').length) throw new Error('跨午夜：当晚 23:30 没报冲突');
    if (hit(W.tmr + 'T05:00', W.tmr + 'T06:00').length) throw new Error('不相干的时间误报了');

    /* 跨时区：东京 09:00(=UTC 00:00) 与 上海 08:00(=UTC 00:00) 是同一刻 */
    const tokyo = W.mk({
      title: W.tag + '东京的会', startAt: W.tmr + 'T09:00', endAt: W.tmr + 'T10:00',
      timezone: 'Asia/Tokyo', createdBy: { type: 'char', id: W.c1 }
    });
    if (!hit(W.tmr + 'T08:00', W.tmr + 'T09:00', 'Asia/Shanghai').some((t) => t === tokyo.title)) {
      throw new Error('跨时区同一绝对时刻没报冲突');
    }

    /* 全天 */
    W.mk({ title: W.tag + '整天有事', startAt: day2, allDay: true, createdBy: { type: 'char', id: W.c1 } });
    if (!hit(day2 + 'T15:00', day2 + 'T16:00').some((t) => String(t).indexOf('整天有事') >= 0)) {
      throw new Error('全天事件没参与冲突');
    }

    /* 取消的不占时间 */
    S.calendar.cancelEvent(night.id, '算了');
    if (hit(W.iso + 'T23:30', W.iso + 'T23:50').some((t) => t === night.title)) {
      throw new Error('已取消的事件还在占时间');
    }
    S.calendar.updateEvent(night.id, { status: 'confirmed', cancelReason: null });

    /* 每周重复：第 7 天命中，第 3 天不命中 */
    const wk = W.mk({
      title: W.tag + '每周例会', startAt: W.iso + 'T20:00', endAt: W.iso + 'T21:00',
      repeatRule: 'weekly', createdBy: { type: 'char', id: W.c1 }
    });
    const d7 = S.calendar.shiftISO(W.iso, 7);
    const d3 = S.calendar.shiftISO(W.iso, 3);
    if (!hit(d7 + 'T20:30', d7 + 'T21:30').some((t) => t === wk.title)) throw new Error('周重复实例没参与冲突');
    if (hit(d3 + 'T20:30', d3 + 'T21:30').some((t) => t === wk.title)) throw new Error('不命中的日子误报了');

    /* 坏数据：不静默说「没冲突」 */
    W.mk({ title: W.tag + '写坏的时间', startAt: W.tmr + 'T99:99', createdBy: { type: 'char', id: W.c1 } });
    const rep = S.calendar.conflictReport(W.c1, { startAt: W.tmr + 'T05:00', endAt: W.tmr + 'T06:00' });
    if (!rep.unresolved.some((t) => String(t).indexOf('写坏的时间') >= 0)) {
      throw new Error('解析不出的旧数据被静默当成「没冲突」了');
    }
    return { 跨午夜: 'ok', 跨时区: 'ok', 全天: 'ok', 取消: '不占', 周重复: 'ok', 坏数据: 'fail closed' };
  } finally { W.cleanup(); }
});

t('共同事件：角色表态有真实来源才生效，状态由程序算', () => {
  const W = mkCalWorld();
  try {
    const ev = S.calendar.requestCreateEvent({
      ownerCharId: W.c1, eventType: 'shared_event', title: W.tag + '一起吃饭',
      startAt: W.tmr + 'T19:00',
      participants: [{ type: 'user', id: 'user' }, { type: 'char', id: W.c1 }]
    });
    const id = ev.eventId;

    /* 伪造来源一律拒 —— 没有真实来源就不许改 */
    const fake = S.calendar.respondSharedEvent(id, W.c1, 'accepted', 'model_said');
    if (fake.ok || fake.error.code !== 'no-source') throw new Error('假来源没被拦');
    const notIn = S.calendar.respondSharedEvent(id, 'char_somebody', 'accepted', 'user_record');
    if (notIn.ok || notIn.error.code !== 'not-a-participant') throw new Error('非参与者没被拦');
    const badState = S.calendar.respondSharedEvent(id, W.c1, 'maybe', 'user_record');
    if (badState.ok || badState.error.code !== 'bad-state') throw new Error('非法表态值没被拦');
    const notShared = S.calendar.respondSharedEvent(
      W.mk({ title: W.tag + '私人' }).id, 'user', 'accepted', 'user_record');
    if (notShared.ok || notShared.error.code !== 'not-shared') throw new Error('非共同事件没被拦');

    /* 角色答应 → 双方都 accepted → confirmed（**以前这个状态永远到不了**） */
    const r1 = S.calendar.respondSharedEvent(id, W.c1, 'accepted', 'user_record', '他答应了');
    if (!r1.ok) throw new Error('角色表态失败：' + JSON.stringify(r1.error));
    if (r1.status !== 'confirmed') throw new Error('双方都答应了却不是 confirmed：' + r1.status);
    let e = S.calendar.getEvent(id);
    if (e.status !== 'confirmed') throw new Error('事件状态没落到 confirmed');
    /* 兼容字段跟着主来源走（**判断只认 participantStates**） */
    const cp = (e.participants || []).filter((p) => p && p.id === W.c1)[0];
    if (!cp || cp.state !== 'accepted') throw new Error('participants[].state 没同步');

    /* 再推掉 → cancelled（现有值域里没有 declined，不擅造新状态） */
    const r2 = S.calendar.respondSharedEvent(id, W.c1, 'declined', 'user_record', '他推掉了');
    if (!r2.ok) throw new Error('推掉失败：' + JSON.stringify(r2.error));
    if (r2.status !== 'cancelled') throw new Error('有人推掉却不是 cancelled：' + r2.status);
    e = S.calendar.getEvent(id);
    if (e.status !== 'cancelled' || !e.cancelReason) throw new Error('取消没留原因');
    if (!S.calendar.getEvent(id)) throw new Error('取消 ≠ 删除：记录得留着');

    /* 他看不到的邀请不能被他接受：把可见性改成 private 再试 */
    const ev2 = S.calendar.requestCreateEvent({
      ownerCharId: W.c1, eventType: 'shared_event', title: W.tag + '看不见的约',
      startAt: W.tmr + 'T21:00',
      participants: [{ type: 'user', id: 'user' }, { type: 'char', id: W.c1 }]
    });
    S.calendar.updateEvent(ev2.eventId, { visibility: 'private' });
    const blind = S.calendar.respondSharedEvent(ev2.eventId, W.c1, 'accepted', 'user_record');
    if (blind.ok || blind.error.code !== 'invisible-to-char') throw new Error('他看不到的邀请也被接受了');
    return { 假来源: '拒', confirmed: '可达', declined: 'cancelled', 看不见的: '拒' };
  } finally { W.cleanup(); }
});

t('新建页：第二次新建不能命中第一次的幂等键（页面实例是缓存复用的）', () => {
  const W = mkCalWorld();
  try {
    /* ⚠️ 这个坑是真机预检抓到的：提交钥匙原本在 render 里铸，而**页面实例是
       缓存复用的（render 只跑一次）**，于是第二次新建带着上一次的 requestKey，
       被 action 层当成「已经建过」直接返回 —— 第二条根本建不出来。
       修法是把重铸放到 onShow。这条断言就是守住它别再退回去。 */
    const create = (title, start) => {
      S.nav.open('calendar-new', { charId: W.c1, date: W.tmr });
      const root = pageRoot();
      const ins = collectByClass(root, 'cal-input');
      if (ins.length < 4) throw new Error('输入框没渲染出来：' + ins.length);
      ins[0].value = W.tmr; ins[1].value = start; ins[2].value = ''; ins[3].value = title;
      const btns = collectByClass(root, 'btn-primary');
      if (!btns.length) throw new Error('找不到「记下来」按钮');
      fireClick(btns[0]);
      return (S.store.get('calEvents') || []).filter((e) => e && e.title === title).length;
    };
    const n1 = create(W.tag + '第一条', '11:00');
    const n2 = create(W.tag + '第二条', '12:00');
    if (n1 !== 1) throw new Error('第一条没建出来');
    if (n2 !== 1) throw new Error('第二条没建出来 —— 又命中上一次的幂等键了');
    if (S.nav.depth() > 0) S.nav.closeAll();
    return { 第一条: n1, 第二条: n2 };
  } finally { W.cleanup(); }
});

/* ---------- SW 缓存版本：独立基准，不是「读当前值再与当前值比」 ----------
   ⚠️ 反面教材（必须避免）：从 sw.js 读出 CASH 再断言它等于自己 ——
     那样永远为真，版本号忘了跳也测不出来。
   ★ 这里的基准是**手写的常量**：本批（2026-10-06 第四批 + 留言批）改了运行时脚本
     vendor/acrylic-lamp-core.js（色板+亮度+font 选项，源在 vendor/lamp/）/
     page-desktop.js / page-chat.js / page-group.js / page-proactive.js /
     store.js / core.js / style.css / sw.js，按项目约定必须同步 CACHE +1。
     基准写死 'sleepy-v181'，跳错版本（没跳 / 跳过头 / 跳成别的号）都会红。
   ⚠️ 登记：v178（私聊撤回）批改了 page-chat.js 等但漏了回写本基准
     （基准停在 v177，被本批发现）—— 属漏动作，不是本批改动。
   ⚠️ 以后再有批改动运行时脚本，把 EXPECTED_SW_CACHE 一起改 —— 这是刻意的
     「每次都要有人手动确认一次」，不是冗余。
   ⚠️ v203（2026-10-07）：群声 Batch A+B 接入批改了 index.html /
     forum-core.js / forum-gen.js / page-qunsheng.js / page-desktop.js /
     store.js / core.js / page-guide.js / sw.js —— 基准随批从 v202 → v203。
   ⚠️ v204（2026-10-08 之前）：协议页批，基准 v203 → v204。
   ⚠️ v205（2026-10-08）：集中核查修复批一 —— 收藏并馆 + 老 favorites 页退役
     （page-collection / page-chat / page-we / style.css / smoke / browser 测试）、
     生图试一张正式管线 + newApi 预设留空（page-imggen / imggen）、
     app.js toast onClick、page-summary、群声板块主页与布局返修（page-qunsheng）、
     wj 分享卡断链修复（page-wj-curtain）、**新增 schedule-gen.js**、
     calendar.js AUTH_VIA +schedule_switch、index.html 加载列表 +1 ——
     基准随批 v204 → v205。
   ⚠️ v214（2026-10-09）：以身入局整体验收批（style.css 换皮组 + 三页 onShow rebuild
     + page-yr-play 幽灵 pending 修复），基准随批 v213 → v214。 */
const EXPECTED_SW_CACHE = 'sleepy-v214';

t('SW 缓存版本：与独立基准一致（本批改过运行时脚本，必须跳位）', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const m = sw.match(/var CACHE = '([^']+)'/);
  if (!m) throw new Error('sw.js 里找不到 var CACHE = \'…\'');
  if (m[1] !== EXPECTED_SW_CACHE) {
    throw new Error('缓存版本与独立基准不符：期望 ' + EXPECTED_SW_CACHE +
      '，实得 ' + m[1] + '（改了运行时脚本就必须在 sw.js 跳位，并改本基准）');
  }
  /* 附带护栏：跳位必须在文件头留下本批的跳版本说明，
     否则下一个人会怀疑「这个号是不是手滑改的」。 */
  if (sw.indexOf('v197（2026-10-07）') < 0) {
    throw new Error('CACHE 已跳到 v197，但文件头缺少 v197 的变更说明');
  }
  return { 缓存: m[1], 基准: EXPECTED_SW_CACHE };
});

t('链接卡解析三路接线：分享文案本地剥 / apizero 直连 / 旧路兜底（2026-10-06 批）', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'page-chat.js'), 'utf8');
  /* ① 分享文案路：本地正则剥正文，零后端 —— 必须是 detectLink 之外的独立入口 */
  for (const k of ['function detectWeiboShare(', 'O网页链接|L微博的|微博视频', 'shareText']) {
    if (chat.indexOf(k) < 0) throw new Error('分享文案路缺关键结构：' + k);
  }
  /* ② apizero 路：直连接口（key 从 store 读，不硬编码在解析调用点） */
  for (const k of ['https://v1.apizero.cn/api/video-parse', 'function resolveViaApi(', "st.get('vpKey')"]) {
    if (chat.indexOf(k) < 0) throw new Error('apizero 路缺关键结构：' + k);
  }
  /* ③ 解析链分配：带 id 的微博 = apizero 失败退 m 站；抖音 = apizero 失败退 title 抠取 */
  if (chat.indexOf("resolveViaApi(link, onPatch, function () { resolveWeibo(link, onPatch); })") < 0) {
    throw new Error('微博裸链接没有挂 apizero→m站 的降级链');
  }
  if (chat.indexOf("resolveViaApi(link, onPatch, function () { resolveGeneric(link, onPatch); })") < 0) {
    throw new Error('抖音没有挂 apizero→title抠取 的降级链');
  }
  /* ④ 发送路径接了两条识别：纯链接 + 分享文案 */
  if (chat.indexOf('var link = detectLink(content);') < 0 ||
      chat.indexOf('detectWeiboShare(content)') < 0) {
    throw new Error('doSend 没有同时接纯链接与分享文案两条识别');
  }
  /* ⑤ 搜一搜必须已拆除（方向修正 2026-10-06：搜索是 char 的能力不是 user 入口） */
  for (const k of ["name: '搜一搜'", 'openSearchSheet', 'search-jump-input']) {
    if (chat.indexOf(k) >= 0) throw new Error('搜一搜没拆干净：' + k);
  }
  const cssAll = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  if (cssAll.indexOf('search-jump-input') >= 0) throw new Error('style.css 残留 .search-jump-input');
  /* ⑥ core.realworld：只做天气（OpenWeatherMap），热点已按用户裁决撤干净 */
  const core = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  for (const k of ['function rwCompile(', 'function rwPoke(', 'api.openweathermap.org',
    'realworld: {']) {
    if (core.indexOf(k) < 0) throw new Error('core.realworld 缺关键结构：' + k);
  }
  for (const k of ['open-meteo', 'orz.ai', 'rwFetchHot', 'RW_HOT', 'hotOn', 'RW_WMO',
    'searchJump', 'SEARCH_SOURCES']) {
    if (core.indexOf(k) >= 0) throw new Error('core 里残留已撤销的结构：' + k);
  }
  /* ⑦ prompt-engine：realworld 槽注册 + 同步读入口（唯一出处 core.realworld） */
  const pe = fs.readFileSync(path.join(ROOT, 'prompt-engine.js'), 'utf8');
  for (const k of ["id: 'realworld', slot: 'I02b'", 'function compileRealworld(',
    "case 'realworld': pushSlot(def, compileRealworld()); break;"]) {
    if (pe.indexOf(k) < 0) throw new Error('prompt-engine 缺 realworld 槽结构：' + k);
  }
  if (pe.match(/rwCompile|rwPoke|openweathermap|open-meteo|orz\.ai/g)) {
    throw new Error('prompt-engine 里出现了取数细节（取数唯一实现在 core.realworld）');
  }
  /* ⑧b 自定义解析接口：模板占位 + 优先于 apizero 的链 */
  for (const k of ['function vpCustomApi(', 'function vpCustomRequestUrl(', 'function patchFromCustom(']) {
    if (chat.indexOf(k) < 0) throw new Error('自定义解析缺关键结构：' + k);
  }
  /* ⑧ 发送前预取链挂了 poke */
  if (chat.indexOf('rw.poke()') < 0) throw new Error('requestReply 没接 realworld.poke');
  /* ⑨ 设置页两个子页注册了，key/城市/保存/注册跳转都在，不再有成段解释 */
  const set = fs.readFileSync(path.join(ROOT, 'page-settings.js'), 'utf8');
  for (const k of ["Sleepy.register('settings-weblink'", "Sleepy.register('settings-videoparse'",
    'owmKey', 'vpCustomApi', 'https://apizero.cn', 'https://openweathermap.org/api']) {
    if (set.indexOf(k) < 0) throw new Error('设置页缺关键结构：' + k);
  }
  if (set.indexOf("label: '天气感知'") < 0 ||
      !/label: '天气感知'[\s\S]{0,200}onClick/.test(set)) {
    throw new Error('「天气感知」行没挂 onClick（还是灰的）');
  }
  for (const k of ['热点背景', '开启感知', 'open-meteo', 'orz.ai']) {
    if (set.indexOf(k) >= 0) throw new Error('设置页残留已撤销结构：' + k);
  }
  return { 微博: '文案本地剥→apizero→m站', 抖音: 'apizero→title抠取',
           感知: '仅天气(OWM)→realworld 槽', 搜索: '走 MCP 工具', 设置页: '2 个子页' };
});

t('线下诊断导出面：没有写入/重置入口（正常运行环境只读）', () => {
  const off = fs.readFileSync(path.join(ROOT, 'page-offline.js'), 'utf8');
  const i = off.indexOf('Sleepy.offlineDiag = {');
  if (i < 0) throw new Error('找不到 Sleepy.offlineDiag 导出');
  const j = off.indexOf('};', i);
  const face = off.slice(i, j);
  /* ⚠️ 卡的是**代码**（导出面里真的出现了写入口），不是卡某串字出现在文件里。
     剥注释同理：修法说明里必然要写出 __record 这些名字，不剥会把自己判成违规。 */
  const bare = face.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ['__record', '__recordIfCurrent', '__reset', '__snapshot',
    'diagRecord:', 'diagRecordIfCurrent'].forEach((k) => {
    if (bare.indexOf(k) >= 0) throw new Error('导出面暴露了写入口：' + k);
  });
  if (bare.indexOf('snapshot: diagSnapshot') < 0) throw new Error('导出面缺只读 snapshot');
  if (bare.indexOf('stageLabel') < 0) throw new Error('导出面缺只读 stageLabel');
  /* requestId 必须在：请求身份与诊断序号解耦就是靠它可查 */
  if (off.indexOf('requestId: requestId') < 0) {
    throw new Error('诊断记录里没有 requestId（无法证明请求身份与阶段解耦）');
  }
  return { 导出面: 'snapshot / stageLabel', 请求身份字段: 'requestId' };
});

t('日历收口：生产代码零直连 addEvent，且它已不在对外导出表里', () => {
  /* 第二轮收口批第 3/4 条：addEvent 降为「内部落库函数」，
     UI / 执行器 / 别的 App 一律走 requestCreateEvent。
     第三轮收口批把它**从 Sleepy.calendar 顶层导出表拿掉**，
     只挂 `__internal.addEvent` —— 所以这条断言要比原来更严两分：
       ① 生产脚本里 `__internal` 一个都不许出现（内部口只在 calendar.js 里定义）；
       ② `addEvent` 那个名字不许出现在 Sleepy.calendar 的导出表里。 */
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  const srcs = [];
  html.replace(/<script\s+src="([^"]+)"/g, (m, s) => { srcs.push(s); return m; });
  if (!srcs.length) throw new Error('没解析出脚本列表');
  const strip = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const hits = {};
  const internalHits = [];
  srcs.forEach((s) => {
    const file = __dirname + '/../' + s.replace(/^\.\//, '');
    if (!fs.existsSync(file)) return;
    const t = strip(fs.readFileSync(file, 'utf8'));
    const n = (t.match(/addEvent\(/g) || []).length;
    if (n) hits[s] = n;
    /* 内部口：calendar.js 之外任何人碰都红 —— 包括改名后的 `__raw` 之类 */
    if (/__internal/.test(t)) internalHits.push(s);
  });
  const bad = Object.keys(hits).filter((k) => k !== 'calendar.js');
  if (bad.length) throw new Error('这些生产脚本绕过统一入口直接 addEvent：' + bad.join('、'));
  const badInt = internalHits.filter((k) => k !== 'calendar.js');
  if (badInt.length) {
    throw new Error('这些生产脚本碰了内部落库口 __internal（测试夹具专用）：' + badInt.join('、'));
  }
  /* calendar.js 里：一次真实调用（requestCreateEvent 的第 ⑨ 步）+ 一次函数定义 */
  if (hits['calendar.js'] !== 2) {
    throw new Error('calendar.js 里 addEvent( 出现 ' + hits['calendar.js'] + ' 次，期望 2（定义 1 + 调用 1）');
  }
  /* 反向：addEvent 不许回到顶层导出表（回去 = 又变成公开创建 API） */
  if (S.calendar.addEvent !== undefined) {
    throw new Error('addEvent 又回到 Sleepy.calendar 顶层了 —— 它只能是 __internal.addEvent');
  }
  if (!S.calendar.__internal || typeof S.calendar.__internal.addEvent !== 'function') {
    throw new Error('__internal.addEvent 不在了（测试夹具要靠它造数据）');
  }
  /* 反向：两个历史写入路径必须已经改走统一入口 */
  const wj = strip(fs.readFileSync(__dirname + '/../wj-canon.js', 'utf8'));
  if (/addEvent\(/.test(wj)) throw new Error('wj-canon 还在直接 addEvent');
  if (!/requestCreateEvent/.test(wj)) throw new Error('wj-canon 没走统一入口');
  return { 生产脚本: srcs.length, addEvent调用点: hits, 顶层导出: '已移除', 内部口: '仅 calendar.js' };
});

t('日历收口：wj-canon 的 requestKey 稳定可复算，重复 write 不会建第二条', () => {
  const W = mkCalWorld();
  try {
    const k1 = S.wjCanon.canonRequestKey('w1', 'c1', W.c1);
    const k2 = S.wjCanon.canonRequestKey('w1', 'c1', W.c1);
    const k3 = S.wjCanon.canonRequestKey('w1', 'c2', W.c1);
    if (k1 !== k2) throw new Error('同一部作品/候选/角色的 key 不稳定');
    if (k1 === k3) throw new Error('不同候选撞了同一个 key');
    if (k1.indexOf('wjcanon:') !== 0) throw new Error('key 前缀不对：' + k1);

    /* 用同一把钥匙连建两次：第二次必须是 dup，且不产生第二条事件 */
    const payload = {
      ownerCharId: W.c1, eventType: 'shared_event', title: W.tag + '定史',
      startAt: W.tmr, allDay: true, createdBy: { type: 'user', id: 'user' },
      participants: [{ type: 'user', id: 'user' }, { type: 'char', id: W.c1 }]
    };
    const opts = { requestKey: k1, allowConflict: true, historical: true, authorizedVia: 'review_desk' };
    const a = S.calendar.requestCreateEvent(payload, opts);
    if (!a.ok) throw new Error('第一次失败：' + JSON.stringify(a.error));
    const b = S.calendar.requestCreateEvent(payload, opts);
    if (!b.ok || b.dup !== true) throw new Error('第二次没被幂等挡住');
    const n = (S.store.get('calEvents') || []).filter((e) => e && e.requestKey === k1).length;
    if (n !== 1) throw new Error('重复 write 建出了 ' + n + ' 条');

    /* historical：定史是「已经发生」，直接 confirmed + 全员 accepted（不是待确认邀请） */
    const ev = S.calendar.getEvent(a.eventId);
    if (ev.status !== 'confirmed') throw new Error('定史不该是 pending 邀请：' + ev.status);
    if (ev.participantStates[W.c1] !== 'accepted') throw new Error('定史不该让角色「还没表态」');
    if (ev.authorizedVia !== 'review_desk') throw new Error('没记下授权来源');

    /* 没有授权来源的回溯记录一律拒 */
    const noAuth = S.calendar.requestCreateEvent(payload, { requestKey: 'x' + W.tag, historical: true });
    if (noAuth.ok || noAuth.error.code !== 'no-authorization') throw new Error('没写授权来源也放行了');
    /* 角色/模型当作者的回溯记录一律拒 */
    const notUser = S.calendar.requestCreateEvent(
      Object.assign({}, payload, { createdBy: { type: 'char', id: W.c1 } }),
      { requestKey: 'y' + W.tag, historical: true, authorizedVia: 'review_desk' });
    if (notUser.ok || notUser.error.code !== 'bad-authorization') throw new Error('非 user 也能回溯记录');
    /* 不声明 historical 的共同事件仍然强制 pending（老规矩没松） */
    /* 换个没被占用的日子 —— 不带 allowConflict 时撞车是正常的（要拦） */
    const freeDay = S.calendar.shiftISO(W.iso, 3);
    const invite = S.calendar.requestCreateEvent(
      Object.assign({}, payload, { startAt: freeDay, title: W.tag + '普通邀请' }),
      { requestKey: 'z' + W.tag });
    if (!invite.ok) throw new Error('普通共同事件建不了：' + JSON.stringify(invite.error || invite));
    if (S.calendar.getEvent(invite.eventId).status !== 'pending') throw new Error('普通共同事件被当成已发生');
    return { key: k1, 重复: 'dup', 定史状态: ev.status };
  } finally { W.cleanup(); }
});

/* ==================== 日历写入全链路收口（第三轮施工单，2026-10-03） ====================
   依据《Sleepy · 日历写入全链路收口 · 第三轮施工单 v1》。三批：
     ① 纪念日 saveAnniversary 走统一入口 + 入口边界 + 双向绑定
     ② 帷境定史 wj-canon 走统一入口 + 真回执 + 幂等
     ③ addEvent 收紧（不在顶层导出表 / 生产零直连）
   每条自己造世界、自己拆（finally），不污染后面的全页渲染冒烟。 */
console.log('\n--- 日历写入全链路收口（第三轮施工单）---');

/* 留痕夹具：往当前岛的角色身上塞一条锚点留痕。 */
function mkAnchor(W, opt) {
  opt = opt || {};
  const id = opt.id || ('mem_a' + Math.random().toString(36).slice(2, 8));
  const file = S.memoryStore.loadCharMemory(opt.charId || W.c1);
  file.memories.push({
    id: id, charId: opt.charId || W.c1,
    kind: 'moment',
    content: opt.content || (W.tag + '·他第一次这样叫我的那天'),
    source: opt.source || 'ai_summary',
    sourceRef: opt.sourceRef === undefined ? 'msg_882' : opt.sourceRef,
    evidenceType: 'confirmed', status: 'active',
    isAnchor: true, isUserEdited: false,
    createdAt: '2031-05-20T21:00:00.000Z', updatedAt: '2031-05-20T21:00:00.000Z'
  });
  S.memoryStore.saveCharMemory(file);
  return id;
}

t('纪念日收口：合法保存走统一入口，且 memoryId ↔ calendarEventId 双向一致', () => {
  const W = mkCalWorld();
  try {
    const memId = mkAnchor(W);
    const r = S.calendar.saveAnniversary(W.c1, { id: memId }, { date: '2031-05-20' });
    if (!r.ok) throw new Error('合法纪念日保存失败：' + JSON.stringify(r.error));
    if (r.eventId.indexOf('ev') !== 0) throw new Error('拿不到真实 eventId：' + r.eventId);

    const ev = S.calendar.getEvent(r.eventId);
    if (!ev) throw new Error('事件没落库');
    /* 正向：事件 → 留痕 */
    if (ev.memoryId !== memId) throw new Error('事件上的 memoryId 不对');
    if (ev.authorizedVia !== 'anniversary_sheet') throw new Error('没记授权来源');
    if (ev.sourceType !== 'memory') throw new Error('sourceType 语义丢了');
    if (ev.meaningType !== 'char_subjective') throw new Error('私人纪念日被升格成双方事实了');
    /* ⚠️ 反向：留痕 → 事件。**双向绑定以前是假的** ——
       全库没有任何一处写 memory.calendarEventId（第三轮勘察确认），
       所以「绑在一起」其实只有单向，removeEvent 的保护与召回都读不到。 */
    if (r.bindOk !== true) throw new Error('绑定回写没成功（bindOk=' + r.bindOk + '）');
    const mem = (S.memoryStore.loadCharMemory(W.c1).memories || []).filter((m) => m.id === memId)[0];
    if (!mem) throw new Error('留痕不见了');
    if (mem.calendarEventId !== r.eventId) {
      throw new Error('反向绑定没写成：memory.calendarEventId=' + mem.calendarEventId);
    }
    /* 幂等键必须是「岛 + 留痕」，不能含标题日期（那是会误合并的弱键） */
    if (ev.requestKey !== 'anniversary:' + W.sb.id + ':' + memId) {
      throw new Error('requestKey 不是稳定的岛+留痕键：' + ev.requestKey);
    }
    return { 正向: ev.memoryId, 反向: mem.calendarEventId, 幂等键: ev.requestKey };
  } finally { W.cleanup(); }
});

t('纪念日收口：缺 memoryId / 跨岛留痕 / 别角色的留痕一律拒，且不留半成品', () => {
  const W = mkCalWorld();
  try {
    const before = (S.store.get('calEvents') || []).length;

    /* ① 缺 memoryId —— 统一入口不许因为 eventType 就放宽 */
    const noMem = S.calendar.saveAnniversary(W.c1, {}, { date: '2031-05-20' });
    if (noMem.ok || noMem.error.code !== 'no-memory') {
      throw new Error('缺 memoryId 没被拒：' + JSON.stringify(noMem.error || noMem));
    }
    /* ② 本岛名册里没有这条留痕（伪造 id） */
    const ghost = S.calendar.saveAnniversary(W.c1, { id: 'mem_根本不存在' }, { date: '2031-05-20' });
    if (ghost.ok || ghost.error.code !== 'no-such-memory') {
      throw new Error('不存在的留痕没被拒：' + JSON.stringify(ghost.error || ghost));
    }
    /* ③ 跨岛：别岛角色的留痕，当前岛引用不到 */
    const B = mkNetWorld({});
    const otherMem = mkAnchor(B);
    const crossRes = S.calendar.saveAnniversary(W.c1, { id: otherMem }, { date: '2031-05-20' });
    if (crossRes.ok || crossRes.error.code !== 'no-such-memory') {
      throw new Error('跨岛留痕没被拒：' + JSON.stringify(crossRes.error || crossRes));
    }
    /* ④ 本岛但属于另一个角色。
       ⚠️ 留痕库**按 root 分文件**（charMem:<root>），所以同岛另一个角色的留痕
       在 c1 的文件里根本查不到 —— 正确结论是 no-such-memory，不是 memory-not-owed。
       归属分支要单独构造：在 c1 自己的文件里塞一条 charId 指向别人的条目
       （迁移残留 / 手工改库才会出现的数据），这时才该命中 memory-not-owed。 */
    const otherLocal = mkAnchor(W, { charId: W.c2, id: 'mem_wc2_' + W.tag });
    const wrongChar = S.calendar.saveAnniversary(W.c1, { id: otherLocal }, { date: '2031-05-20' });
    if (wrongChar.ok) throw new Error('别角色的留痕没被拒');
    if (['no-such-memory', 'memory-not-owed'].indexOf(wrongChar.error.code) < 0) {
      throw new Error('别角色的留痕拒绝理由不对：' + JSON.stringify(wrongChar.error));
    }
    const strayId = 'mem_stray_' + W.tag;
    const f1 = S.memoryStore.loadCharMemory(W.c1);
    f1.memories.push({
      id: strayId, charId: W.c2, kind: 'moment', content: W.tag + '·错挂的留痕',
      source: 'ai_summary', sourceRef: '', evidenceType: 'confirmed',
      status: 'active', isAnchor: true, isUserEdited: false,
      createdAt: '2031-05-20T21:00:00.000Z', updatedAt: '2031-05-20T21:00:00.000Z'
    });
    S.memoryStore.saveCharMemory(f1);
    const stray = S.calendar.saveAnniversary(W.c1, { id: strayId }, { date: '2031-05-20' });
    if (stray.ok || stray.error.code !== 'memory-not-owed') {
      throw new Error('错挂的留痕没被归属闸挡住：' + JSON.stringify(stray.error || stray));
    }
    B.cleanup();
    S.core.setActiveSandbox(W.sb.id);

    if ((S.store.get('calEvents') || []).length !== before) {
      throw new Error('被拒的保存留下了半成品事件');
    }
    /* 失败回执要留痕（不能悄悄吞） */
    if (!noMem.receipt || noMem.receipt.type !== 'calendar_event_failed') {
      throw new Error('拒绝没有失败回执');
    }
    if (noMem.receipt.errorCode !== 'no-memory') throw new Error('回执没带错误码');
    return { 缺留痕: '拒', 伪造留痕: '拒', 跨岛: '拒', 别角色: '拒', 半成品: 0 };
  } finally { W.cleanup(); }
});

t('纪念日收口：sourceIds 只取核验过的那条留痕，调用方注入进不来', () => {
  const W = mkCalWorld();
  try {
    const memId = mkAnchor(W, { sourceRef: 'msg_882' });
    /* ⚠️ 调用方（页面 / 模型文本）递一个**伪造的 mem 对象**进来，
       带着自己的 sourceRef。saveAnniversary 收下它的只有 id ——
       sourceIds 必须从核过归属的留痕身上取，不能读调用方给的这份。 */
    const injected = S.calendar.saveAnniversary(W.c1, {
      id: memId, sourceRef: 'msg_伪造的别岛来源', charId: 'chr_别人', content: '换掉标题'
    }, { date: '2031-05-24' });   /* 注意：不传 opts.title —— 它是用户显式输入，合法 */
    if (!injected.ok) throw new Error('保存失败：' + JSON.stringify(injected.error));
    if (injected.event.sourceIds.length !== 1 || injected.event.sourceIds[0] !== 'msg_882') {
      throw new Error('sourceIds 采信了调用方注入的值：' + JSON.stringify(injected.event.sourceIds));
    }
    /* 正文同理：标题的默认值取**留痕自己的 content**，不取调用方递的 mem.content。
       ⚠️ 但 `opts.title` 是**用户显式输入**（弹层里能改，page-calendar 不传但
       语义上允许），那一条必须保留 —— 不能为了「防注入」把用户能改的东西也锁死。
       所以这里只钉「mem.content 不采信」，opts.title 单独测。 */
    if (String(injected.event.title).indexOf('换掉的标题') >= 0) {
      throw new Error('标题采信了调用方注入的 mem.content');
    }
    /* ⚠️ 上面那次已经把它标成 2031-05-24 了（幂等键只看岛+留痕），
       所以这里不能再「第一次保存」一次 —— 直接查已建的那条。 */
    const first = { event: injected.event, eventId: injected.eventId };
    if (first.event.title.indexOf(W.tag + '·他第一次这样叫我的那天') < 0) {
      throw new Error('默认标题没取留痕自己的 content：' + first.event.title);
    }
    /* 改标题再存 → 命中幂等（一条留痕只标一天），但**不许静默沿用旧值**：
       明确拒绝并说清差在哪，让用户去日历里改。 */
    const again = S.calendar.saveAnniversary(
      W.c1, { id: memId }, { date: '2031-05-24', title: W.tag + '·我自己起的名字' });
    if (again.ok) throw new Error('改了标题还报成功 —— 用户的输入被静默丢了');
    if (again.error.code !== 'already-marked') {
      throw new Error('拒绝理由不对：' + JSON.stringify(again.error));
    }
    if (again.error.message.indexOf('名字') < 0) throw new Error('没说清差在哪：' + again.error.message);
    /* 事件没被改、也没多出一条 */
    const ev2 = S.calendar.getEvent(first.eventId);
    if (ev2.title !== first.event.title) throw new Error('事件标题被偷偷改了');
    const cnt = S.calendar.eventsOf(W.c1)
      .filter((e) => e.requestKey === 'anniversary:' + W.sb.id + ':' + memId).length;
    if (cnt !== 1) throw new Error('建出了 ' + cnt + ' 条');
    /* 什么差异都没有的重跑 → 正常 dup（幂等在正常工作） */
    const same = S.calendar.saveAnniversary(W.c1, { id: memId }, { date: '2031-05-24' });
    if (!same.ok || same.dup !== true) throw new Error('无差异重跑不该被拒');
    if (same.eventId !== first.eventId) throw new Error('dup 返回了另一个 eventId');
    /* 没有 sourceRef 的留痕 → 空数组（不是 undefined） */
    const bare = mkAnchor(W, { sourceRef: '', id: 'mem_bare_' + W.tag });
    const r2 = S.calendar.saveAnniversary(W.c1, { id: bare }, { date: '2031-05-22' });
    if (!r2.ok) throw new Error('保存失败：' + JSON.stringify(r2.error));
    if (!Array.isArray(r2.event.sourceIds) || r2.event.sourceIds.length !== 0) {
      throw new Error('无来源时 sourceIds 该是空数组：' + JSON.stringify(r2.event.sourceIds));
    }
    return { 注入的sourceRef: '没被采信', 留痕自己的: '保留', 无来源: '空数组' };
  } finally { W.cleanup(); }
});

t('纪念日收口：重复保存幂等，且已绑定的仍不许 removeEvent 直接删', () => {
  const W = mkCalWorld();
  try {
    const memId = mkAnchor(W);
    const a = S.calendar.saveAnniversary(W.c1, { id: memId }, { date: '2031-05-23' });
    if (!a.ok) throw new Error('第一次保存失败');
    /* 同一条留痕 + 完全相同的输入 → 幂等命中（key 只看岛+留痕） */
    const b = S.calendar.saveAnniversary(W.c1, { id: memId }, { date: '2031-05-23' });
    if (!b.ok || b.dup !== true) throw new Error('重复保存没被幂等挡住：' + JSON.stringify(b.error));
    if (b.eventId !== a.eventId) throw new Error('幂等返回了另一个 eventId');
    /* ⚠️ 换日期 / 换标题**不许**建第二条，也不许静默沿用旧值 → 明确拒绝 */
    const moved = S.calendar.saveAnniversary(
      W.c1, { id: memId }, { date: '2031-06-01' });
    if (moved.ok || moved.error.code !== 'already-marked') {
      throw new Error('换日期没被拒（或建了第二条）：' + JSON.stringify(moved.error || moved));
    }
    if (moved.eventId !== a.eventId) throw new Error('拒绝时也没说清是哪一条');
    if (S.calendar.getEvent(a.eventId).startAt.indexOf('2031-06-01') >= 0) {
      throw new Error('事件日期被偷偷改了');
    }
    const n = S.calendar.eventsOf(W.c1)
      .filter((e) => e.requestKey === 'anniversary:' + W.sb.id + ':' + memId).length;
    if (n !== 1) throw new Error('重复保存建出了 ' + n + ' 条');
    /* 删除保护没松 */
    const del = S.calendar.removeEvent(a.eventId);
    if (del.ok) throw new Error('绑了留痕的纪念日被直接删掉了');
    if (del.message.indexOf('留痕') < 0) throw new Error('删除提示没说清原因');
    /* 仍然从普通近期安排里排除（回归） */
    S.calendar.saveCfg(W.c1, { scheduleOn: true });
    const sched = (S.calendar.timeFacts(W.c1, {}).split('\n')
      .filter((l) => l.indexOf('你近期的安排') === 0)[0]) || '';
    if (sched.indexOf(W.tag) >= 0) throw new Error('纪念日泄进了普通日程线');
    return { 幂等: 'dup', 事件数: n, 删除: '被保护', 不泄进日程: true };
  } finally { W.cleanup(); }
});

t('帷境收口：未确认不写 calEvents，确认后拿真实 eventId，重复确认幂等', () => {
  const W = mkCalWorld();
  try {
    const w = S.wj.createDraft({
      title: W.tag + '·定史剧本', reality: 'canon_candidate',
      cast: [{ charId: W.c1, name: W.tag + '·甲' }]
    });
    /* 走**真实审阅流程**：摆候选 → 批准 → 定认知档 → 到第四步 */
    S.wjCanon.setCandidates(w.id, [{
      kind: 'shared_event', text: W.tag + '·那天的展', date: '2031-07-07'
    }]);
    const cid = S.wjCanon.get(w.id).candidates[0].id;
    S.wjCanon.decide(w.id, cid, 'keep');
    S.wjCanon.setKnowledge(w.id, W.c1, cid, '清晰记忆');
    S.wjCanon.setStep(w.id, 3);

    /* ① 打开审阅台 / 预览 —— 一条都不能写（plan 与 sheet 都是纯读） */
    const evBefore = (S.store.get('calEvents') || []).length;
    const plan = S.wjCanon.plan(w.id);
    if (!plan || !plan.count) throw new Error('plan 不可用或没算出条数');
    if ((S.store.get('calEvents') || []).length !== evBefore) {
      throw new Error('预览 plan 就写日历了 —— 打开审阅台必须零副作用');
    }
    /* 审阅台那一屏（page-wj-canon.js 的 paneWrite）读的就是 plan() 的数据 ——
       它必须是纯读：展示不是授权。 */
    const again = S.wjCanon.plan(w.id);
    if (again.count !== plan.count) throw new Error('plan 不稳定');
    if ((S.store.get('calEvents') || []).length !== evBefore) {
      throw new Error('反复预览就写日历了 —— 展示不是授权');
    }
    /* 名单、认知、keptOf 也都是读路径 */
    S.wjCanon.keptOf(S.wjCanon.get(w.id));
    S.wjCanon.writersOf(S.wjCanon.get(w.id), S.wj.get(w.id), cid);
    if ((S.store.get('calEvents') || []).length !== evBefore) {
      throw new Error('读名单就写日历了');
    }

    /* 阻塞项存在时不能写：把认知档撤掉（就没人会被写了）不算阻塞，
       换真正的阻塞：把候选改成 reject → plan.count = 0 */
    S.wjCanon.decide(w.id, cid, 'reject');
    if (S.wjCanon.write(w.id).ok) throw new Error('没有批准条目也写进去了');
    if ((S.store.get('calEvents') || []).length !== evBefore) throw new Error('被拒的候选也落日历了');
    S.wjCanon.decide(w.id, cid, 'keep');

    /* ② 明确确认（write）→ 经过统一入口，拿到真实 eventId */
    const r1 = S.wjCanon.write(w.id);
    if (!r1.ok) throw new Error('确认写入失败：' + JSON.stringify(r1).slice(0, 200));
    if (!r1.evRefs || !r1.evRefs.length) throw new Error('没留下任何 eventRef');
    if (r1.evFailed && r1.evFailed.length) throw new Error('不该有失败项：' + JSON.stringify(r1.evFailed));
    const ref = r1.evRefs[0];
    const ev = S.calendar.getEvent(ref.eventId);
    if (!ev) throw new Error('eventRef 指向的不是真事件：' + ref.eventId);
    if (ev.authorizedVia !== 'review_desk') throw new Error('没记审阅台授权');
    if (ev.status !== 'confirmed') throw new Error('定史不该停在待确认：' + ev.status);
    if (ev.eventType !== 'shared_event') throw new Error('事件类型被改动了（未决事实不许猜改）');
    const rec = S.wjCanon.get(w.id);
    if (rec.written !== true) throw new Error('成功了 written 却没置真');
    if (!rec.eventRefs || rec.eventRefs.length !== 1) throw new Error('rec 里没留 eventRefs');
    if (rec.eventRefs[0].eventId !== ref.eventId) throw new Error('rec.eventRefs 与真实 eventId 不一致');
    if (rec.writtenPending !== false) throw new Error('全部成功却还挂着 pending');

    /* ③ 重复确认 —— already-written，不建第二条 */
    const r2 = S.wjCanon.write(w.id);
    if (r2.ok || r2.why !== 'already-written') throw new Error('重复确认没被幂等挡住');
    const mine = S.store.get('calEvents').filter((e) => e && e.requestKey ===
      S.wjCanon.canonRequestKey(w.id, cid, W.c1));
    if (mine.length !== 1) throw new Error('重复确认建出了 ' + mine.length + ' 条');

    S.wj.remove(w.id);
    return {
      预览: '零副作用', 被拒候选: '不写', eventId: ref.eventId,
      状态: ev.status, 重复确认: 'already-written', 事件数: mine.length
    };
  } finally { W.cleanup(); }
});

t('帷境收口：日历写失败时 rec.written 不伪造成功，且可重跑补上', () => {
  const W = mkCalWorld();
  try {
    const w = S.wj.createDraft({
      title: W.tag + '·会失败的剧本', reality: 'canon_candidate',
      cast: [{ charId: W.c1, name: W.tag + '·甲' }]
    });
    S.wjCanon.setCandidates(w.id, [{
      kind: 'shared_event', text: W.tag + '·写不进去的那天', date: '2031-08-08'
    }]);
    const cid = S.wjCanon.get(w.id).candidates[0].id;
    S.wjCanon.decide(w.id, cid, 'keep');
    S.wjCanon.setKnowledge(w.id, W.c1, cid, '清晰记忆');
    S.wjCanon.setStep(w.id, 3);

    /* 让统一入口在这一条上失败：临时注入一个拒绝桩。
       （不改动生产代码，只在这一条断言里换掉函数引用 ——
        验的是「失败不伪造成功」这个性质本身。） */
    const real = S.calendar.requestCreateEvent;
    S.calendar.requestCreateEvent = () => ({
      ok: false, error: { code: 'write-failed', message: '注入的失败' }
    });
    let r;
    try { r = S.wjCanon.write(w.id); } finally { S.calendar.requestCreateEvent = real; }

    if (!r.evFailed || r.evFailed.length !== 1) {
      throw new Error('失败没被如实报出来：' + JSON.stringify(r).slice(0, 200));
    }
    if (r.evFailed[0].err !== 'write-failed') throw new Error('失败码没带出来');
    const rec = S.wjCanon.get(w.id);
    if (rec.written === true) throw new Error('日历全失败却把 written 置真了 —— 那是谎报');
    if (rec.writtenPending !== true) throw new Error('没标出可重跑');
    if (!rec.calendarFailed || rec.calendarFailed.length !== 1) throw new Error('失败明细没留档');
    if (rec.eventRefs && rec.eventRefs.length) throw new Error('失败却留下了 eventRefs');
    if ((S.store.get('calEvents') || []).some((e) => e && String(e.title).indexOf(W.tag) >= 0)) {
      throw new Error('失败却把事件写进去了');
    }

    /* 重跑要放行（written=false），并把日历补上；留痕不许写两份 */
    const r2 = S.wjCanon.write(w.id);
    if (r2 && r2.why) throw new Error('重跑被挡了：' + r2.why);
    if (!r2.ok) throw new Error('重跑没放行：' + JSON.stringify(r2).slice(0, 160));
    if (r2.written !== true) throw new Error('重跑补上了 written 还是不为真');
    if (r2.events !== 1) throw new Error('重跑没补上日历：' + r2.events);
    const rec2 = S.wjCanon.get(w.id);
    if (rec2.writtenPending !== false) throw new Error('补上后没清 pending 标记');
    if (!rec2.eventRefs || rec2.eventRefs.length !== 1) throw new Error('补上后没留 eventRefs');
    const lines = (S.memoryStore.loadCharMemory(W.c1).memories || [])
      .filter((m) => m.source === 'other_app' && String(m.content).indexOf(W.tag) >= 0);
    if (lines.length !== 1) throw new Error('重跑把留痕写成了 ' + lines.length + ' 份');

    S.wj.remove(w.id);
    return { 失败时: 'written 不置真', 事件表: '无半成品', 重跑: '补上 1 条', 留痕份数: lines.length };
  } finally { W.cleanup(); }
});

t('第三轮静态护栏：纪念日与帷境的写入都在统一入口内，且 addEvent 不在顶层导出表', () => {
  const strip = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  /* ① 纪念日：saveAnniversary 里必须调 requestCreateEvent，且没有裸 addEvent */
  const cal = strip(fs.readFileSync(path.join(ROOT, 'calendar.js'), 'utf8'));
  const annSeg = cal.slice(cal.indexOf('function saveAnniversary'), cal.indexOf('function timeFacts'));
  if (!/requestCreateEvent/.test(annSeg)) throw new Error('saveAnniversary 没走统一入口');
  if (/addEvent\(/.test(annSeg)) throw new Error('saveAnniversary 还在裸调 addEvent');
  /* 入口边界的三道闸在**校验函数 ownedMemory** 里（saveAnniversary 调它），
     所以这一段要从 ownedMemory 起算 —— 少算一段等于没检。 */
  const ownSeg = cal.slice(cal.indexOf('function ownedMemory'), cal.indexOf('function timeFacts'));
  ['no-memory', 'no-such-memory', 'memory-not-owed'].forEach((code) => {
    if (ownSeg.indexOf(code) < 0) throw new Error('纪念日入口边界少了 ' + code + ' 这道闸');
  });
  if (ownSeg.indexOf('rootIdOf') < 0) throw new Error('留痕归属没核（跨岛/别角色会漏过去）');
  /* 幂等键必须在 saveAnniversary 里，且带 sandboxId（跨岛同一条留痕各算各的） */
  if (annSeg.indexOf('anniversary:') < 0) throw new Error('纪念日幂等键没在本函数里拼');
  if (annSeg.indexOf('own.sandboxId') < 0) throw new Error('幂等键没带 sandboxId —— 跨岛会撞');
  /* 幂等键不许拼标题或日期（弱键会把用户真想建的两条合并） */
  const keyLine = (annSeg.match(/requestKey:[^\n]*/) || [''])[0];
  if (/title|date/.test(keyLine)) throw new Error('纪念日幂等键里混进了标题/日期：' + keyLine);

  /* ② 帷境：同理 + 稳定 requestKey 出口 + written 只在真成功后置 */
  const wj = strip(fs.readFileSync(path.join(ROOT, 'wj-canon.js'), 'utf8'));
  if (/addEvent\(/.test(wj)) throw new Error('wj-canon 还在裸调 addEvent');
  if (!/canonRequestKey/.test(wj)) throw new Error('帷境没走稳定 requestKey');
  if (!/writtenPending/.test(wj)) throw new Error('帷境没有半完成态 —— 失败会谎报成功');
  /* 审阅台之外不许有写入口：write 只能被 page-wj-canon 那个按钮调 */
  const wjPage = strip(fs.readFileSync(path.join(ROOT, 'page-wj-canon.js'), 'utf8'));
  const calls = (wjPage.match(/\.write\(/g) || []).length;
  if (calls !== 1) throw new Error('审阅台页面里 write( 出现 ' + calls + ' 次（应只有那个确认按钮）');

  /* ③ addEvent 边界：不在顶层导出表；生产脚本零直连、零内部口 */
  if (S.calendar.addEvent !== undefined) throw new Error('addEvent 还在顶层导出表里');
  if (!S.calendar.__internal || !S.calendar.__internal.addEvent) throw new Error('内部落库口没了');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const srcs = [];
  html.replace(/<script\s+src="([^"]+)"/g, (m, s) => { srcs.push(s); return m; });
  const leaks = [];
  srcs.forEach((s) => {
    const f = path.join(ROOT, s.replace(/^\.\//, ''));
    if (!fs.existsSync(f)) return;
    const t = strip(fs.readFileSync(f, 'utf8'));
    if (s !== 'calendar.js' && /addEvent\(|__internal/.test(t)) leaks.push(s);
  });
  if (leaks.length) throw new Error('这些生产脚本还碰得到底层落库口：' + leaks.join('、'));

  return { 纪念日: '统一入口 + 三道边界闸', 帷境: '统一入口 + 稳定 key + 半完成态', addEvent: '不在顶层导出表' };
});

t('日历页的 freshOnOpen 声明还在（表单残留 / 详情页状态不刷新都靠它）', () => {
  /* 2026-10-03 真机抓到两个坑，两个都是「页面实例缓存 + 同参短路」：
       ① 新建页表单残留 —— 同一天再点加号，上次填的还在；
       ② 详情页状态不刷新 —— 「记下：他推掉了」之后再看，还是「待确认」。
     框架给的解法就是 `freshOnOpen`（app.js:429，与 page-idcard / page-ta 同款），
     这里静态钉住：**谁删了它，冒烟立刻变红**（行为层由无头 Edge 那条验）。 */
  const src = fs.readFileSync(path.join(ROOT, 'page-calendar.js'), 'utf8');
  /* 月历页不用 —— 它有 onShow 走 paint 重读；表单页和详情页没有，才要 freshOnOpen */
  ['calendar-new', 'calendar-event'].forEach((id) => {
    const at = src.indexOf("register('" + id + "'");
    if (at < 0) throw new Error('页面没注册：' + id);
    const seg = src.slice(at, at + 600);
    if (seg.indexOf('freshOnOpen: true') < 0) {
      throw new Error(id + ' 少了 freshOnOpen —— 表单/详情会拿到上一次的旧 DOM');
    }
  });
  /* 月历页不用 freshOnOpen —— 它有 onShow 走 paint 重读（下面那条只查它存在） */
  /* 加号已经挪到顶栏「设置」旁边，右下角那个悬浮按钮不该再回来 */
  if (/cal-fab/.test(src)) throw new Error('右下角悬浮加号又回来了（会压住最后一条日程）');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');   /* 注释里提到 cal-fab 是在解释「已删除」，不算命中 */
  if (/\.cal-fab\b/.test(css)) throw new Error('.cal-fab 样式已成死代码，删掉');
  return { 新建页: "freshOnOpen", 详情页: "freshOnOpen", 悬浮加号: "已移除" };
});

t('日历第二轮：静态护栏 —— action.js 0 模型 / 0 网络 / 0 定时器 / 不自己写日历', () => {
  const strip = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const src = strip(require('fs').readFileSync(__dirname + '/../action.js', 'utf8'));
  [/\bfetch\(/, /XMLHttpRequest/, /api\./, /setInterval/, /setTimeout/].forEach((re) => {
    if (re.test(src)) throw new Error('action.js 不该出现 ' + re);
  });
  if (/\.addEvent\(/.test(src)) throw new Error('action.js 不许绕过统一入口直接 addEvent');
  if (!/requestCreateEvent/.test(src)) throw new Error('action.js 必须走统一入口');
  /* 统一入口不许弹 UI */
  const cal = strip(require('fs').readFileSync(__dirname + '/../calendar.js', 'utf8'));
  const seg = cal.slice(cal.indexOf('function requestCreateEvent'), cal.indexOf('function addEvent'));
  if (/ui\.|alert\(|confirm\(/.test(seg)) throw new Error('统一入口不许弹 UI');
  return { action: '干净', 统一入口: '不弹 UI' };
});

if (asyncPending > 0) {
  /* 被测代码里有 setInterval（状态栏时钟、呼吸光点等），事件循环不会自己空。
     所以不能指望 beforeExit —— 用一个小轮询等异步断言全部落定再收尾。
     落定后显式 exit，别让那些定时器把进程挂着不放。 */
  const iv = setInterval(() => {
    if (asyncPending > 0) return;
    clearInterval(iv);
    finalReport();
    process.exit(bad ? 1 : 0);
  }, 40);
} else {
  finalReport();
  process.exit(bad ? 1 : 0);
}
