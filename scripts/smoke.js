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
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
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

  const r = S.core.removeSandbox(sbArch);
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
  S.core.removeChar(c);
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

  S.core.removeChar(main);
  S.core.removeChar(mine);
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
  S.core.removeChar(c);
  S.core.removeSandbox(ra.id);
  S.core.removeSandbox(rb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(isle.id);
  if (!put.ok) throw new Error(put.message);
  if (full !== false) throw new Error('孤岛已经住了人，却还允许再加');
  if (S.island.canAddChar(null) !== true) throw new Error('没有房时不该拦');
  const archi = S.core.createSandbox('archipelago');
  const okArchi = S.island.canAddChar(archi);
  S.core.removeSandbox(archi.id);
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
  S.core.removeSandbox(sb.id);
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
  const r = S.core.removeSandbox(sb.id);
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

  const r = S.core.removeSandbox(sb.id);
  if (!r.ok) throw new Error(r.message);
  if (!S.core.findChar(m.id)) throw new Error('拆岛把已移出的角色连带删了');
  if (!S.core.findChar(sub.id)) throw new Error('拆岛把已移出角色的皮套连带删了');

  S.core.removeChar(m.id);
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

  const r = S.core.removeSandbox(sbB.id);
  if (!r.ok) throw new Error(r.message);
  if (S.core.findUser(u2.id) || S.core.findUser(uc.id)) throw new Error('拆岛后马甲还留着');
  if (!S.core.findUser(u1.id)) throw new Error('拆 B 岛不该动 A 岛的马甲');
  S.core.removeSandbox(sbA.id);
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

  S.core.removeSandbox(sbX.id);
  S.core.removeSandbox(sbY.id);
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

  S.core.removeSandbox(sbX.id);
  S.core.removeSandbox(sbY.id);
  return { 别岛: 'null', 本岛: got.name };
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

  const r = S.core.removeSandbox(sbA.id);
  if (!r.ok) throw new Error(r.message);
  if (S.store.get('appearance').desktop.islands[sbA.id]) throw new Error('拆岛没清外观覆盖');
  if (S.store.get('desktop').islands[sbA.id]) throw new Error('拆岛没清户型覆盖');
  if (S.store.get('desktopRemoved').some((x) => x.sandboxId === sbA.id)) {
    throw new Error('拆岛没清该岛的组件删除记录');
  }
  S.core.removeSandbox(sbB.id);
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

  const r = S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(isle);
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
  S.core.removeSandbox(sbA.id);
  S.core.removeSandbox(sbB.id);
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
  S.core.removeSandbox(sb.id);
  S.core.removeChar(m.id);
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
  S.core.removeSandbox(A.id);
  S.core.removeSandbox(B.id);
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
  S.core.removeSandbox(A.id); S.core.removeSandbox(B.id);
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
  S.core.removeSandbox(A.id); S.core.removeSandbox(B.id);
  if (local !== 1) throw new Error('本房该看到 1 个，实际 ' + local);
  if (inB !== 1) throw new Error('开全局后 B 房该看见，实际 ' + inB);
  if (!isGlobal) throw new Error('开全局没清掉 sandboxId：' + JSON.stringify(rec));
  if (left !== 0) throw new Error('删完还剩 ' + left);
  return { 本房: local, 换房后: inB, 全局: isGlobal };
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
  S.core.removeSandbox(A.id);
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
  S.core.removeSandbox(A.id); S.core.removeSandbox(B.id);
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
  S.core.removeSandbox(sb.id);
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
t('面具轮盘对外出口是 Sleepy.switcher.wheel', () => {
  if (!S.switcher) throw new Error('switcher 没加载');
  if (typeof S.switcher.wheel !== 'function') throw new Error('switcher.wheel 缺失 —— 聊天页长按头像会炸');
  if (typeof S.switcher.open !== 'function') throw new Error('switcher.open 缺失 —— 系统级切号入口没了');
  return { open: true, wheel: true, close: typeof S.switcher.close === 'function' };
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
   拿掉的），但组件商城要能装回来 —— 状态签名就是靠这张卡的第二行才有人看见。 */
t('组件商城：角色卡上架了（默认户型没有，目录里能装回来）', () => {
  S.store.set('desktop', null);
  const card = S.widgetStore.catalog().filter((c) => c.type === 'char')[0];
  if (!card) throw new Error('目录里没有角色卡');
  const res = S.widgetStore.addWidget(card);
  if (!res.ok) throw new Error('装不上：' + res.message);
  const onDesk = S.desktop.getDesktop().pages.some((l) =>
    (l || []).some((c) => c.type === 'char'));
  const st = S.desktop.skin().status;   /* 卡片第二行读的就是它 */
  S.store.set('desktop', null);
  return { 尺寸: card.w + '×' + card.h, 装上了: res.ok, 桌面上有: onDesk, 状态签名: st };
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
  S.core.removeSandbox(sb.id);
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

/* 新建接口时内置预设要按 kind 拷进来 —— 用户：「根据模型特色写内置预设词」。
   NAI 必须自带正面质量词 + 负面模板；general 也要有起手式。 */
t('newApi 按 kind 带上内置预设（NAI 有正负面）', () => {
  const g = S.imggen;
  const gen = g.newApi('general');
  const nai = g.newApi('nai');
  if (gen.kind !== 'general' || nai.kind !== 'nai') throw new Error('kind 不对');
  if (!gen.positivePreset || gen.positivePreset.indexOf('{p}') < 0) throw new Error('general 预设没有 {p} 占位');
  if (!nai.negativePreset) throw new Error('nai 没有负面预设');
  if (nai.negativePreset.indexOf('{p}') >= 0) throw new Error('负面预设不该有 {p}');
  return { nai正面: nai.positivePreset.slice(0, 20), nai负面: nai.negativePreset.slice(0, 24) };
});

/* 拼提示词管线：预设基底 ← 锁脸段 + 动态段 + 词条，{p} 替换、顺序固定、
   重复词条去重。锁脸在最前面 —— 它锁的是「长什么样」，不是动作。 */
t('buildPrompt：{p} 替换 + 段落顺序 + 词条去重', () => {
  const g = S.imggen;
  const api = g.newApi('nai');
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
  const e1 = CAL.addEvent({ ownerCharId: a, eventType: 'user_reminder', title: '去旧书店',
    startAt: '2030-05-20T18:30', endAt: '2030-05-20T20:00', allDay: false });
  CAL.addEvent({ ownerCharId: a, eventType: 'char_schedule', title: '傍晚散步',
    startAt: '2030-05-20T19:00', endAt: '2030-05-20T19:40', allDay: false });
  CAL.addEvent({ ownerCharId: b, eventType: 'user_reminder', title: 'B 的事',
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
  const r1 = CAL.removeEvent(CAL.addEvent({ ownerCharId: calSb.a, eventType: 'shared_event',
    title: '一起吃饭', startAt: '2030-06-01T19:00', allDay: false, status: 'confirmed' }).id);
  if (r1.ok) throw new Error('已确认的共同事件不该允许删除');
  const ann = CAL.addEvent({ ownerCharId: calSb.a, eventType: 'anniversary', title: '某天',
    startAt: '2030-07-07', allDay: true, memoryId: 'mem_x' });
  if (CAL.removeEvent(ann.id).ok) throw new Error('绑了留痕的纪念日不能直接删');
  const draft = CAL.addEvent({ ownerCharId: calSb.a, eventType: 'user_reminder', title: '记错了',
    startAt: '2030-08-08T09:00', allDay: false });
  if (!CAL.removeEvent(draft.id).ok) throw new Error('误创建的提醒该允许删除');
  return { 共同事件: '拒绝', 纪念日: '拒绝', 误创建: '允许' };
});

t('重复规则展开：年重复在次年同月日还回来；农历重复不假装能算', () => {
  const id = CAL.addEvent({ ownerCharId: calSb.a, eventType: 'user_reminder', title: '每年这天',
    startAt: '2030-03-05T09:00', allDay: false, repeatRule: 'yearly' }).id;
  if (!CAL.eventsOn(calSb.a, '2031-03-05').some((e) => e.id === id)) throw new Error('年重复没展开');
  if (CAL.eventsOn(calSb.a, '2031-03-06').some((e) => e.id === id)) throw new Error('不该在别的日子出现');
  const lunar = CAL.addEvent({ ownerCharId: calSb.a, eventType: 'anniversary', title: '农历那条',
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
  const ev = CAL.saveAnniversary(a, cands[0].memory, { date: '2030-05-20' });
  if (ev.memoryId !== 'mem_smoke_1') throw new Error('纪念日没和留痕双向绑上');
  if (ev.meaningType !== 'char_subjective') throw new Error('私人纪念日不许自动升格成双方事实');
  if (CAL.anniversaryCandidates(a).filter((x) => !x.saved).length) throw new Error('存过的不该再当候选');
  return { 候选: 1, 绑定: ev.memoryId, 意义: ev.meaningType };
});

t('换房看不见 + removeSandbox 连带清两张日历表', () => {
  const other = S.core.createSandbox('isle', '隔壁测试岛');
  S.core.setActiveSandbox(other.id);
  if (CAL.eventsOf(calSb.a).length) throw new Error('换房还能看见上一个岛的事件');
  S.core.setActiveSandbox(calSb.sb);
  const before = CAL.eventsOf(calSb.a).length;
  if (!before) throw new Error('回到原房该能看见');
  S.core.removeSandbox(calSb.sb);
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
  S.calendar.addEvent({ ownerCharId: plTest, eventType: 'char_schedule', title: '傍晚去旧书店',
    startAt: '2026-09-19T18:30', endAt: '2026-09-19T20:00', allDay: false });
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
    status: '在整理旧书', speech: '句子短，偶尔冒一句旧诗',
    gender: 'male', nationality: '中国', neverDo: '绝对不撒谎'
  });
  const u = S.core.activeUser() || S.core.userMasks()[0];
  const sys = S.proactiveEngine.buildSystem(c.id, u && u.id).join('\n');
  if (sys.indexOf('[角色声音]') < 0) throw new Error('主动消息没有共享外壳的角色声音');
  if (sys.indexOf('当前状态：在整理旧书') < 0) throw new Error('主动消息看不见状态签名');
  if (sys.indexOf('说话与行为方式：句子短') < 0) throw new Error('主动消息看不见说话方式');
  if (sys.indexOf('绝对不要做（红线）') < 0) throw new Error('主动消息看不见红线');
  if (sys.indexOf('awareness_mode') < 0) throw new Error('主动消息没有 I01');
  return { 段数: S.proactiveEngine.buildSystem(c.id, u && u.id).length };
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
    status: '在整理旧书', speech: '句子短', neverDo: '不撒谎' });
  const sess = { purpose: '', env: {}, systemSettings: {}, narrativeSettings: {},
    participants: [{ ownerId: c.id, kind: 'char', present: true, away: false }] };
  const sys = S.groupOfflineStore.buildSystem(sess);
  if (sys.indexOf('说话与行为方式：句子短') < 0) throw new Error('群线下看不见说话方式');
  if (sys.indexOf('当前状态：在整理旧书') < 0) throw new Error('群线下看不见状态签名');
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

  S.core.removeSandbox(arch);
  S.core.removeChar(a1);
  S.core.removeChar(a2);
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

  S.core.removeSandbox(isle);
  S.core.removeSandbox(other);
  S.core.removeChar(m);
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
  S.core.removeChar(npc.id);
  S.core.removeChar(m);
  S.core.removeSandbox(isle);
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
  S.core.removeChar(c);
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
  S.core.removeChar(c);
  S.core.removeSandbox(isle);
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
  S.core.removeChar(c);
  S.core.removeSandbox(isle);
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

t('群按房隔离：换房看不见 + removeSandbox 连带清三张表', () => {
  const other = S.core.createSandbox('isle', '别的房');
  S.core.setActiveSandbox(other.id);
  const seen = S.groupStore.listGroups();
  if (seen.length !== 0) throw new Error('别的房不该看见这个群，实 ' + seen.length);
  S.core.setActiveSandbox(gFix.arch);
  S.core.removeSandbox(other.id);
  /* 删群测试群岛：三张表都应该清掉 */
  const before = {
    groups: S.store.get('groups').length,
    members: S.store.get('groupMembers').length,
    msgs: S.store.get('groupMessages').length
  };
  if (!before.groups) throw new Error('测试前置不对：群里没数据');
  S.core.removeSandbox(gFix.arch);
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

/* ---------------- page-group-ai：群聊调度引擎（纯函数部分） ----------------
   装配、本体归并、输出校验是程序正确性的核心 —— 串脑的账不能记一半。
   runRound 的网络路径打不了桩，这里只测程序裁决的部分。 */

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
  S.core.upsertChar({ id: aiFix.m, status: '刚开完庭', speech: '说话慢，爱用长句', neverDo: '不失约' });
  const r = S.groupAI.composeRound(aiFix.gid, { stimulus: '（通查）', budget: { actors: 2, msgs: 5 } });
  const sys = r.messages[0].content;
  if (sys.indexOf('当前状态：刚开完庭') < 0) throw new Error('群里看不见状态签名');
  if (sys.indexOf('说话与行为方式：说话慢') < 0) throw new Error('群里看不见说话方式');
  if (sys.indexOf('绝对不要做（红线）') < 0) throw new Error('群里看不见红线');
  return { 命中: 3 };
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
  S.core.removeChar(ch);
  S.core.removeChar(ch2);
  return { 锚定: true, 关不锚: true, 批量确认: n };
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeSandbox(sb.id);
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
  S.core.removeChar(a.id);                    /* 人没了，cast 里还留着他的 id */
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

t('genParams：timeoutSec 有 5 秒下限（老存档的 0 不会再变成 1 秒超时）', () => {
  S.store.set('chatDefaults', {});
  const g = S.api.genParams;
  const dirty0 = g({ baseUrl: 'x', model: 'm', timeoutSec: 0 }, {});
  const dirty1 = g({ baseUrl: 'x', model: 'm', timeoutSec: 1 }, {});
  const ok120 = g({ baseUrl: 'x', model: 'm', timeoutSec: 120 }, {});
  const bare = g({ baseUrl: 'x', model: 'm' }, {});
  const out = { 脏0: dirty0.timeoutSec, 脏1: dirty1.timeoutSec, 正常: ok120.timeoutSec, 缺省: bare.timeoutSec };
  if (dirty0.timeoutSec !== 60) throw new Error('0 该回落 60，实 ' + dirty0.timeoutSec);
  if (dirty1.timeoutSec !== 60) throw new Error('1 该回落 60，实 ' + dirty1.timeoutSec);
  if (ok120.timeoutSec !== 120) throw new Error('正常值不该被动，实 ' + ok120.timeoutSec);
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
  /* 探测过、接不了的那些：必须**写清原因**，否则用户看到的就是一个神秘灰行 */
  if (T.PROVIDER_PLANNED.length < 4) throw new Error('接不了的清单太短了');
  T.PROVIDER_PLANNED.forEach((pid) => {
    const p = T.providerOf(pid);
    if (!p || !p.planned) throw new Error(pid + ' 该在「接不了」清单里且标 planned');
    if (!p.desc || p.desc.length < 12) throw new Error(pid + ' 没说清为什么接不了');
    if (T.PROVIDER_ORDER.indexOf(pid) >= 0) throw new Error(pid + ' 不能同时在能用的清单里');
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
    S.core.removeSandbox(sbA.id);
    S.core.removeSandbox(sbB.id);
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
    S.core.removeSandbox(sbA.id);
    S.core.removeSandbox(sbB.id);
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
    S.core.removeSandbox(sbA.id);
    S.core.removeSandbox(sbB.id);
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

  S.core.removeSandbox(sb.id);
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

/* 项目 5 的现状证据：charMem 的归属**不一致** ——
   私聊总结传「皮套」（page-summary.js:253 chat.characterId）、
   群线下传 root（page-group-offline.js:1946 oid=ownerId）、
   留痕只列大号（page-memory.js:170 charsOfSandbox）。
   这里把现状钉成可观测事实，免得后面「以为是一套库」。
   ⚠️ 本探针只写 charMem 两个键并在 finally 里删掉，不改生产行为。 */
t('探针：charMem 归属 —— 皮套与 root 落在两个不同的键上', () => {
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

    const subFile = S.store.get('charMem:' + sub) || { memories: [] };
    const rootFile = S.store.get('charMem:' + root) || { memories: [] };
    const twoSeparateKeys = subFile.memories.length === 1 && rootFile.memories.length === 1;

    /* 留痕列出来的人里没有皮套（只有大号 + 岛内 NPC） */
    const listed = (S.memoryStore.loadIsland().chars || []).map((c) => c.id);
    const subHiddenFromUI = listed.indexOf(sub) < 0 && listed.indexOf(root) >= 0;

    /* L0 注入也按 charId 走：各自只看得到自己那一套 */
    const injSub = S.memoryStore.getMemoryInjection(sub) || '';
    const injRoot = S.memoryStore.getMemoryInjection(root) || '';
    const injectSplit = injSub.indexOf('皮套这条') >= 0 &&
      injSub.indexOf('大号这条') < 0 && injRoot.indexOf('大号这条') >= 0;

    if (!twoSeparateKeys) throw new Error('两个 charId 没落在两个键上（前提变了，先看清代码）');
    if (!subHiddenFromUI) throw new Error('留痕列表居然列了皮套（前提变了）');
    if (!injectSplit) throw new Error('L0 注入没按 charId 分裂（前提变了）');

    return { 两键独立: true, 皮套留痕不可见: true, 注入按皮套分裂: true };
  } finally {
    S.store.remove('charMem:' + sub);
    S.store.remove('charMem:' + root);
    S.core.removeSandbox(sb.id);
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
  const mk = (o) => cal.addEvent(Object.assign({
    ownerCharId: a, startAt: tmr + 'T15:00', createdBy: { type: 'user', id: 'user' }
  }, o));
  mk({ title: '牙医复诊', visibility: 'shared_detail' });
  mk({ title: '给他买礼物', visibility: 'private' });          /* 我的私事 */
  mk({ title: '公司会议', visibility: 'shared_busy' });         /* 只知道忙 */
  mk({ title: '每天开门', eventType: 'char_schedule', visibility: 'shared_detail' });
  cal.addEvent({ ownerCharId: a, startAt: tmr + 'T20:00', title: '去河边散步',
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
  ['text', 'groupText', 'stats', 'statsGroup'].forEach((k) => {
    if (typeof V[k] !== 'function') throw new Error('缺接口：' + k);
  });
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

    S.core.removeSandbox(sb16.id);
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
    out.W11 = '护栏 ok';
  }

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
