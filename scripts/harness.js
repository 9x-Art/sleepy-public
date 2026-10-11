/* ============================================================
   scripts/harness.js — 迁移前基线的隔离沙箱引导（A1 批次）

   ★ 本文件不接生产、不进 index.html、不调模型、不发网络请求、
     不读任何真实用户数据。它只被两个脚本 require：
       · scripts/behavior-baseline-capture.js（默认不写盘，--write 才落基线）
       · scripts/behavior-baseline-test.js    （只读比较）
     两者都是纯 Node、零依赖。

   ---- 来源范围（从 smoke 复制的「必要引导段」）----
   DOM 桩 / localStorage 桩 / window 桩 / 「按 index.html 真实顺序加载」
   四段复制自 scripts/smoke.js 第 21–300 行（该文件当时的版本）。
   复制时**没有**带上 smoke 的任何一条测试断言，也没有带它后续用到的
   夹具、真实资源访问、假 fetch 安装段、全页渲染段。
   两处刻意改写（不能照抄，照抄就不能满足本批的隔离要求）：
     ① smoke 的桩是模块级单例；这里改成 makeDom()/makeWindow() 工厂，
        每次 create() 得到一套全新桩与全新 store 内存，互不串味。
     ② smoke 的加载循环是顶层 forEach；这里包成 loadScripts(handle)。

   ---- 与 smoke 的差异（全部登记，便于日后核对）----
   D1 时间冻结：沙箱内 `Date` 换成「now 恒为 FIXED_MS」的代理，只装在
      沙箱上下文上，**不碰宿主 globalThis.Date**。
   D2 随机冻结：沙箱内 `Math` 换成以 SEED 起种的 LCG（Object.create(Math)
      派生对象，`random` 是自有属性），**不碰宿主 globalThis.Math.random**。
   D3 时区固定：进程启动时设 process.env.TZ = 'Asia/Shanghai'（只影响这一个
      子进程，不改用户的系统设置、不改 JS 宿主全局对象）。理由：calendar 的
      deviceTimezone() 读 Intl resolvedOptions().timeZone，不固定的话
      换台机器跑基线就漂。已记进基线 meta。
   D4 定时器不触发：setTimeout/setInterval/requestAnimationFrame 只入队、
      永不执行（smoke 是真跑 0ms 定时器）。理由是让捕获严格同步、可复现；
      队列条数会记进捕获元数据。
   D5 网络 fail-closed：fetch 一律 reject；XMLHttpRequest/WebSocket/
      EventSource/Worker 在沙箱里**根本不存在**（引用即 ReferenceError）。
      另加一层计数式绊线：真的走到网络就记进 handle.violations。
   D6 传输记录器：Sleepy.api.requestOnce 可被 installTransport() 换成
      「深拷贝入账 + 返回固定假结果」，用来抓主动消息那条路的完整
      system+user 请求。全部调用点都在沙箱里，替换不影响宿主。
   D7 console 只记账不打印（避免加载期的告警污染捕获输出；条数记进 meta）。

   跑法：node scripts/behavior-baseline-capture.js
         node scripts/behavior-baseline-test.js
   ============================================================ */
'use strict';

/* D3：必须在任何 Date / Intl 使用之前设好 —— 见文件头 */
process.env.TZ = 'Asia/Shanghai';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');

/* 冻结时刻：2026-03-14T04:30:00Z = 北京时间 12:30（周六）
   挑这个时间是为了让 [NOW] / [时间事实] / 免打扰判定全都落在明确的一侧：
   12:30 不在默认免打扰区间 23:00~08:00 内。 */
var FIXED_MS = Date.UTC(2026, 2, 14, 4, 30, 0);
var FIXED_ISO = new Date(FIXED_MS).toISOString();
var TZ = 'Asia/Shanghai';
var SEED = 20261003;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/* 深拷贝：只吃 JSON 能表达的捕获产物（请求体就是这种形态）。
   JSON 往返同时也是一种「与后续代码脱钩」的保证 —— 见 §捕获时立即深拷贝。 */
function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/* ---------------------------- DOM 桩 ---------------------------- */
/* 复制自 smoke.js:21–158（detach / makeEl）。除了把类名集合 cls 收进
   工厂内部，逻辑逐字保留 —— 包括「appendChild 是移动语义」那条注释。 */
function makeDom() {
  function detach(c) {
    var p = c && c.parentNode;
    if (!p) return;
    var i = p.childNodes.indexOf(c);
    if (i >= 0) p.childNodes.splice(i, 1);
    var j = p.children.indexOf(c);
    if (j >= 0) p.children.splice(j, 1);
    c.parentNode = null;
  }

  function makeEl(tag) {
    var cls = new Set();
    var style = {
      _p: {},
      setProperty: function (k, v) { this._p[k] = String(v); this[k] = String(v); },
      removeProperty: function (k) { delete this._p[k]; delete this[k]; },
      getPropertyValue: function (k) { return this._p[k] || ''; }
    };
    var el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [], childNodes: [], style: style, dataset: {},
      /* input/select 语义（同 smoke.js 桩） */
      value: '',
      options: [],
      selectedIndex: -1,
      parentNode: null,
      _text: '', _html: '', _attrs: {},
      classList: {
        add: function () { [].slice.call(arguments).forEach(function (x) { if (x) cls.add(x); }); },
        remove: function () { [].slice.call(arguments).forEach(function (x) { cls.delete(x); }); },
        contains: function (c) { return cls.has(c); },
        toggle: function (c, f) {
          var on = f === undefined ? !cls.has(c) : !!f;
          on ? cls.add(c) : cls.delete(c);
          return on;
        }
      },
      get className() { return Array.from(cls).join(' '); },
      set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(function (x) { cls.add(x); }); },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        this.children.forEach(function (c) { c.parentNode = null; });
        this.children = []; this.childNodes = [];
        this._q = null;
      },
      appendChild: function (c) { detach(c); c.parentNode = this; this.children.push(c); this.childNodes.push(c); return c; },
      append: function () { var self = this; [].slice.call(arguments).forEach(function (c) { self.appendChild(c); }); },
      prepend: function (c) { detach(c); c.parentNode = this; this.children.unshift(c); this.childNodes.unshift(c); return c; },
      insertBefore: function (c) { detach(c); c.parentNode = this; this.children.unshift(c); this.childNodes.unshift(c); return c; },
      removeChild: function (c) {
        var i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        var j = this.childNodes.indexOf(c);
        if (j >= 0) this.childNodes.splice(j, 1);
        if (c) c.parentNode = null;
        return c;
      },
      replaceChildren: function () {
        var self = this;
        this.children.forEach(function (c) { c.parentNode = null; });
        [].slice.call(arguments).forEach(function (c) { c.parentNode = self; });
        this.children = [].slice.call(arguments); this.childNodes = this.children;
      },
      remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
      get firstChild() { return this.childNodes[0] || null; },
      get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
      get firstElementChild() { return this.children[0] || null; },
      get lastElementChild() { return this.children[this.children.length - 1] || null; },
      get nextSibling() {
        if (!this.parentNode) return null;
        var s = this.parentNode.childNodes;
        return s[s.indexOf(this) + 1] || null;
      },
      get previousSibling() {
        if (!this.parentNode) return null;
        var s = this.parentNode.childNodes;
        var i = s.indexOf(this);
        return i > 0 ? s[i - 1] : null;
      },
      get nextElementSibling() {
        if (!this.parentNode) return null;
        var s = this.parentNode.children;
        return s[s.indexOf(this) + 1] || null;
      },
      setAttribute: function (k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; },
      getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
      removeAttribute: function (k) { delete this._attrs[k]; },
      addEventListener: function (t, fn) {
        if (typeof fn !== 'function') return;
        this._on = this._on || Object.create(null);
        this._on[t] = (this._on[t] || []).concat([fn]);
      },
      removeEventListener: function (t, fn) {
        if (!this._on || !this._on[t]) return;
        this._on[t] = this._on[t].filter(function (x) { return x !== fn; });
      },
      dispatchEvent: function () {},
      querySelector: function (sel) {
        this._q = this._q || Object.create(null);
        if (!this._q[sel]) { this._q[sel] = makeEl('div'); this._q[sel].parentNode = this; }
        return this._q[sel];
      },
      querySelectorAll: function () { return []; },
      closest: function () { return null; },
      contains: function () { return false; },
      matches: function () { return false; },
      focus: function () {}, blur: function () {}, click: function () {},
      scrollIntoView: function () {}, scrollTo: function () {},
      getBoundingClientRect: function () { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
      cloneNode: function () { return makeEl(this.tagName); },
      animate: function () { return { finished: Promise.resolve(), cancel: function () {} }; }
    };
    return el;
  }

  var DOC_IDS = Object.create(null);
  var DOC_SEL = Object.create(null);

  var documentStub = {
    createElement: makeEl,
    createElementNS: function (ns, tag) { return makeEl(tag); },
    createTextNode: function (t) { var e = makeEl('#text'); e.textContent = t; return e; },
    createDocumentFragment: function () { return makeEl('#fragment'); },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    head: makeEl('head'),
    activeElement: null,
    getElementById: function (id) {
      if (!DOC_IDS[id]) DOC_IDS[id] = makeEl('div');
      if (!DOC_IDS[id].parentNode) DOC_IDS[id].parentNode = documentStub.body;
      return DOC_IDS[id];
    },
    querySelector: function (sel) {
      if (!DOC_SEL[sel]) { DOC_SEL[sel] = makeEl('div'); DOC_SEL[sel].parentNode = documentStub.body; }
      return DOC_SEL[sel];
    },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}, removeEventListener: function () {},
    readyState: 'complete'
  };
  /* index.html 里真实存在的 id，桩必须提供（同 smoke.js:191–193） */
  ['phone', 'stack', 'statusbar', 'sb-time', 'sb-battery', 'edge-hint', 'toast']
    .forEach(function (id) { DOC_IDS[id] = makeEl('div'); });

  return { documentStub: documentStub, DOC_IDS: DOC_IDS, DOC_SEL: DOC_SEL, makeEl: makeEl };
}

/* ------------------------ localStorage 桩 ------------------------ */
/* 复制自 smoke.js:195–205，背后那份 LS 改成每次新建 */
function makeLocalStorage() {
  var LS = Object.create(null);
  return {
    LS: LS,
    stub: {
      get length() { return Object.keys(LS).length; },
      key: function (i) { return Object.keys(LS)[i] === undefined ? null : Object.keys(LS)[i]; },
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null; },
      setItem: function (k, v) { LS[k] = String(v); },
      removeItem: function (k) { delete LS[k]; },
      clear: function () { Object.keys(LS).forEach(function (k) { delete LS[k]; }); }
    }
  };
}

/* --------------------------- window 桩 --------------------------- */
/* 复制自 smoke.js:207–246，差异：D4 定时器入队不触发、D5 fetch 记违规、
   D7 console 记账不打印。 */
function makeWindow(dom, ls, handle) {
  function noop() {}
  function StubCtor() { return { observe: noop, disconnect: noop, unobserve: noop, addEventListener: noop }; }

  function trip(name) {
    return function () {
      handle.violations.push(name);
      throw new Error('隔离夹具：禁止 ' + name + '（基线捕获必须是离线纯读）');
    };
  }

  function timerStub(kind) {
    return function () {
      handle.timers.push({ kind: kind, at: handle.timers.length });
      return handle.timers.length;
    };
  }

  function logStub(kind) {
    return function () {
      handle.consoleLog.push({ kind: kind, n: arguments.length });
    };
  }

  var win = {
    document: dom.documentStub,
    localStorage: ls.stub,
    navigator: { userAgent: 'node-harness', language: 'zh-CN', clipboard: { writeText: function () { return Promise.resolve(); } } },
    location: { href: 'file:///D:/sleepy/index.html', protocol: 'file:', search: '', hash: '' },
    history: { replaceState: noop, pushState: noop },
    screen: { width: 390, height: 844 },
    console: { log: logStub('log'), info: logStub('info'), warn: logStub('warn'),
      error: logStub('error'), debug: logStub('debug'), trace: logStub('trace') },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
    setInterval: timerStub('setInterval'), clearInterval: noop,
    cancelAnimationFrame: noop,
    matchMedia: function () { return { matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }; },
    getComputedStyle: function () { return { getPropertyValue: function () { return ''; }, setProperty: noop }; },
    addEventListener: noop, removeEventListener: noop, scrollTo: noop,
    alert: noop, confirm: function () { return true; }, prompt: function () { return ''; },
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    btoa: function (s) { return Buffer.from(s).toString('base64'); },
    atob: function (s) { return Buffer.from(s, 'base64').toString(); },
    Blob: global.Blob, File: global.File || function File() {},
    FileReader: function FileReader() {},
    DecompressionStream: global.DecompressionStream,
    URL: { createObjectURL: function () { return 'blob:stub'; }, revokeObjectURL: noop },
    fetch: trip('fetch'),
    XMLHttpRequest: undefined,
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
  /* D4：先照 smoke 的写法定好，再覆盖成入队版（保留 smoke 的键集合） */
  win.setTimeout = timerStub('setTimeout');
  win.clearTimeout = noop;
  win.requestAnimationFrame = timerStub('requestAnimationFrame');
  win.requestIdleCallback = timerStub('requestIdleCallback');
  win.queueMicrotask = timerStub('queueMicrotask');
  return win;
}

/* ------------------- 冻结时间 / 冻结随机（D1、D2）------------------- */

/* 把宿主 Date 包成「无参构造 = FIXED_MS」的代理。
   注意：**只装在沙箱上下文上**，宿主 globalThis.Date 一字不动。
   实例方法全部透传真实 Date（生产代码要用的日期功能一个不少）。 */
function frozenDateClass(realDate, fixedMs) {
  return new Proxy(realDate, {
    get: function (t, p) {
      if (p === 'now') return function () { return fixedMs; };
      return Reflect.get(t, p, t);
    },
    construct: function (t, args) {
      return Reflect.construct(t, args.length ? args : [fixedMs]);
    },
    apply: function () {
      /* 像 Date() 这样当函数调用 → 真实语义是「此刻的字符串」，这里给冻结串 */
      return new realDate(fixedMs).toString();
    }
  });
}

/* 定种 LCG（数值稳定性优先，不用 Math.random） */
function makeLcg(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* 沙箱版 Math：原型继承宿主 Math，只把 random 换成自有属性（D2） */
function frozenMath(rand) {
  var m = Object.create(Math);
  Object.defineProperty(m, 'random', {
    value: rand, enumerable: false, writable: false, configurable: false
  });
  return m;
}

/* ------------------- 按 index.html 的真实顺序 ------------------- */
/* 复制自 smoke.js:261–271（含「defer 之后正则要放宽」那条注释里的写法） */
function scriptOrder() {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var re = /<script\s+src="([^"]+)"[^>]*><\/script>/g;
  var out = [];
  var m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

var ORDER = scriptOrder();

/* ---------------------------- create ---------------------------- */

/* 造一个全新沙箱：全新 DOM / localStorage / window / store 内存。
   每个用例一个（§二「每个测试用例使用独立沙箱和内存状态」）。 */
function create(label) {
  var handle = {
    label: label || '',
    timers: [],
    violations: [],
    consoleLog: [],
    loaded: [],
    failed: [],
    requests: [],
    transportReply: null
  };

  var dom = makeDom();
  var ls = makeLocalStorage();
  var win = makeWindow(dom, ls, handle);
  var ctx = vm.createContext(win);

  /* 同 smoke.js:249 的兜底复制 */
  Object.keys(win).forEach(function (k) { if (!(k in ctx)) ctx[k] = win[k]; });
  /* 同 smoke.js:251–257：沙箱默认只有 ES 内建，补上必要的宿主内建 */
  ['Error', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
    'Promise', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
    'Intl', 'console'
  ].forEach(function (k) { try { ctx[k] = globalThis[k]; } catch (e) { /* ignore */ } });

  /* D1 / D2：冻结时间与随机 —— 只作用于这个上下文 */
  ctx.Date = frozenDateClass(Date, FIXED_MS);
  ctx.Math = frozenMath(makeLcg(SEED));

  handle.ctx = ctx;
  handle.win = win;
  handle.ls = ls;
  handle.dom = dom;

  return handle;
}

/* 按 index.html 顺序把一个沙箱里的脚本全加载一遍（复制自 smoke.js:275–300
   的加载循环，包成函数、去掉它的失败即退出） */
function loadScripts(handle) {
  ORDER.forEach(function (f) {
    var p = path.join(ROOT, f);
    if (!fs.existsSync(p)) {
      handle.failed.push({ file: f, error: '文件不存在' });
      return;
    }
    try {
      vm.runInContext(fs.readFileSync(p, 'utf8'), handle.ctx, { filename: f });
      handle.loaded.push(f);
    } catch (e) {
      handle.failed.push({ file: f, error: (e && e.message) || String(e) });
    }
  });
  handle.S = handle.win.Sleepy;
  return handle;
}

/* 现成沙箱：create + loadScripts + 传输记录器 */
function boot(label) {
  var h = create(label);
  loadScripts(h);
  return h;
}

/* ------------------- 传输记录器（D6）-------------------
   把 Sleepy.api.requestOnce 换成「深拷贝入账 + 返回固定假结果」。
   入账那一刻就深拷贝，防止后续代码改动引用（§三）。 */
function installTransport(handle, replyContent) {
  var S = handle.S;
  if (!S || !S.api) throw new Error('api 还没加载，装不了传输记录器');
  var reply = String(replyContent || '{"decision":"skip","reasonCode":"stub"}');
  S.api.requestOnce = function (cand, messages, opts) {
    handle.requests.push({
      at: handle.requests.length,
      cand: deepClone(cand),
      messages: deepClone(messages),
      opts: deepClone(opts === undefined ? null : opts)
    });
    return Promise.resolve({ ok: true, content: reply, ms: 0 });
  };
  /* 向量这条路也断掉：不然 fail 之外的任何行为都不确定 */
  S.api.embed = function () {
    return Promise.resolve({ ok: false, error: '离线夹具：不计算向量' });
  };
  return handle.requests;
}

module.exports = {
  ROOT: ROOT,
  /* 宿主全局的两个原值：test 用它断言「捕获没有改动宿主」（D1/D2 的隔离证据） */
  __hostDate: Date,
  __hostRandom: Math.random,
  ORDER: ORDER,
  FIXED_MS: FIXED_MS,
  FIXED_ISO: FIXED_ISO,
  TZ: TZ,
  SEED: SEED,
  sha256: sha256,
  deepClone: deepClone,
  scriptOrder: scriptOrder,
  create: create,
  loadScripts: loadScripts,
  boot: boot,
  installTransport: installTransport
};
