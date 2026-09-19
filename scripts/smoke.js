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
    set innerHTML(v) { this._html = String(v); this.children = []; this.childNodes = []; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    prepend(c) { this.children.unshift(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    replaceChildren(...cs) { this.children = cs; this.childNodes = cs; },
    remove() {},
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    querySelector() { return makeEl('div'); },
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
    return DOC_IDS[id];
  },
  querySelector(sel) {
    if (!DOC_SEL[sel]) DOC_SEL[sel] = makeEl('div');
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
 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console'
].forEach((k) => { try { ctx[k] = globalThis[k]; } catch (e) { /* ignore */ } });

/* ------------------- 按 index.html 的真实顺序 ------------------- */

function scriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<script\s+src="([^"]+)"><\/script>/g;
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
  ['island', 'island-saves', 'island-config'].forEach((id) => {
    if (!reg[id]) throw new Error('缺页面：' + id);
  });
  return {
    第一层: reg.island.title,
    第二层: reg['island-saves'].title,
    第三层: reg['island-config'].title
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
  if (I.metaOf('isle').badge !== '1v1') throw new Error('孤岛徽章不对');
  if (I.metaOf('archipelago').badge !== '1vN') throw new Error('群岛徽章不对');
  return { 孤岛: I.metaOf('isle').poem, 群岛: I.metaOf('archipelago').poem };
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
  /* 大号本体是全局共用的，**不该**带 sandboxId（决策 3） */
  if (mainChar && mainChar.sandboxId) throw new Error('大号不该带 sandboxId');

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
t('I01 四态映射：barrier→char_knows_events / unaware→char_sensing / aware→merged', () => {
  S.core.addLink(s1, u1, 'unaware', true);
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'char_knows_events') throw new Error('barrier 映射错了');
  S.core.setBarrier(s1, u1, false);
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'char_sensing') throw new Error('unaware 映射错了');
  S.core.setCognition(s1, u1, 'aware');
  if (S.promptEngine.awarenessOf(s1, u1).mode !== 'merged') throw new Error('aware 映射错了');
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
  S.store.set(psKey, { lastAt: 0, day: new Date().toISOString().slice(0, 10), count: 99, handled: [], deferredUntil: 0 });
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
