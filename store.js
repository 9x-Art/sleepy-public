/* ============================================================
   store.js — Sleepy 本地存储层
   依赖：无
   被依赖：app.js、page-settings.js 及后续所有页面
   约定：所有键统一加前缀 sleepy.v1.，方便整包导出与体积统计
   对应 ROADMAP：2.4 配置本地存储 / 2.5 导出导入 / 2.6 体积显示
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var NS = 'sleepy.v1.';
  var SCHEMA = 1;

  /* ------------------------------------------------------------
     默认配置。
     新增字段必须先在这里登记，否则 get() 没有兜底值，
     页面会渲染出 undefined。老存档靠 merge() 自动补齐新字段。
     ------------------------------------------------------------ */
  var DEFAULTS = {
    meta: {
      schema: SCHEMA,
      installedAt: null,
      lastOpenAt: null
    },

    /* 2.2 主 API
       注意：temperature / maxTokens / contextMessages 默认是 null，
       意思是「跟随『聊天默认参数』」。单个接口想特殊化再填，填了就以它为准
       （见 api.js 的 genParams）。如果这里给死一个 0.85，
       用户在聊天默认参数页里怎么改都不会生效 —— 那种「改了没反应」最难查。 */
    mainApi: {
      name: '主模型',
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: null,
      maxTokens: null,
      contextMessages: null,
      stream: true,
      timeoutSec: 60,
      enabled: true
    },

    /* 2.3 副 API：多组 + 轮询顺序 + 启用开关 */
    subApis: [],

    /* 2.12 聊天默认参数 */
    chatDefaults: {
      contextMessages: 20,
      maxTokens: 1024,
      temperature: 0.85,
      stream: true,
      /* E 模块：让模型在每次回复末尾顺带输出一段「心声」
         （用 <心声>…</心声> 包住），前端在流式过程中切出来。
         不额外占一次生成额度；关掉就完全不下这条指令。
         一轮就一条 —— 不做「每次几条」的配置，多了反而挑不出重点。 */
      heartbeatAuto: true
    },

    /* 2.11 外观 */
    appearance: {
      theme: 'night',
      fontScale: 1
    },

    /* 3.x 聊天记录：[{ id, name, createdAt, updatedAt, messages: [...] }] */
    chats: [],

    /* D2 收藏：被收藏的单条消息快照 */
    favorites: [],

    /* 名片夹里的角色：[{ id, name, content, createdAt, updatedAt }]
       （A5 时期叫 presets「人设预设库」，后来归到名片夹，改名并做了迁移） */
    characters: [],

    /* 手账本 */
    diaries: [],

    /* B 模块 世界书（两级）：worldbooks = [{ id, name, scope, characterId,
       createdAt, updatedAt, entries: [{ id, name, keys, content, enabled, ... }] }]
       scope: 'global' 全局 | 'personal' 个人（挂 characterId 指向的角色）。
       旧的平铺 worldbook 键由 migrateWorldbookToBooks 搬进来，旧键保留。 */
    worldbooks: [],

    /* 世界书改成两级结构之前平铺条目的旧键，只用于迁移，不再直接读写 */
    worldbook: [],

    /* 主 API 可存多套预设，切换＝换 mainApiId 指向的那套。
       mainApi 键保留：它始终镜像「当前使用」的配置，api.js 只读它，
       这样候选逻辑不用动。 */
    mainApis: [],
    mainApiId: null,

    /* 副 API 每组重试次数（1~5） */
    subRetry: 2
  };

  /* ---------------------------- 工具 ---------------------------- */

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (isObj(v)) {
      var out = {};
      for (var k in v) if (has(v, k)) out[k] = clone(v[k]);
      return out;
    }
    return v;
  }

  /* 深合并：base 当骨架，patch 覆盖。
     这样升级版本加了新字段，用户旧存档也能自动拿到默认值。 */
  function merge(base, patch) {
    if (!isObj(base) || !isObj(patch)) return clone(patch === undefined ? base : patch);
    var out = clone(base);
    for (var k in patch) {
      if (!has(patch, k)) continue;
      out[k] = isObj(out[k]) ? merge(out[k], patch[k]) : clone(patch[k]);
    }
    return out;
  }

  /* ---------------------------- 状态 ---------------------------- */

  var cache = {};
  var listeners = [];
  var lastError = null;

  /* 兼容早期版本的坏存档。
     旧版 set() 对单段路径写成了 cache[top][top] = value，
     于是 chats 被存成 { chats: [...] }。这里读的时候解一层，
     免得老用户升上来以后「聊天记录全没了」。 */
  function unwrapSelf(top, val) {
    if (!has(DEFAULTS, top)) return val;
    if (!isObj(val)) return val;
    if (!has(val, top)) return val;
    return val[top];
  }

  function load(top) {
    if (has(cache, top)) return cache[top];
    var base = has(DEFAULTS, top) ? clone(DEFAULTS[top]) : null;
    var val = base;
    try {
      var raw = global.localStorage.getItem(NS + top);
      if (raw !== null && raw !== undefined) {
        var parsed = unwrapSelf(top, JSON.parse(raw));
        val = base !== null ? merge(base, parsed) : parsed;
      }
    } catch (e) {
      lastError = {
        type: 'read',
        key: top,
        message: (e && e.message) ? e.message : String(e)
      };
    }
    cache[top] = val;
    return val;
  }

  function persist(top) {
    try {
      global.localStorage.setItem(NS + top, JSON.stringify(cache[top]));
      return true;
    } catch (e) {
      lastError = {
        type: 'write',
        key: top,
        message: (e && e.name === 'QuotaExceededError')
          ? '本地存储空间已满，请先导出备份再清理数据'
          : ((e && e.message) ? e.message : String(e))
      };
      return false;
    }
  }

  function notify(path, ok) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](path, ok); } catch (e) { /* 单个监听器炸了不影响其他 */ }
    }
  }

  /* ---------------------------- 读写 ---------------------------- */

  function get(path, fallback) {
    var parts = String(path).split('.');
    var cur = load(parts[0]);
    for (var i = 1; i < parts.length; i++) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[parts[i]];
    }
    if (cur === undefined) return fallback;
    return clone(cur);
  }

  function set(path, value) {
    var parts = String(path).split('.');
    var top = parts[0];
    load(top);

    /* 单段路径 = 整体替换。老写法会把值塞进 cache[top][top]，
       存出 { chats: [...] } 这种套娃结构，读回来就不是数组了。 */
    if (parts.length === 1) {
      cache[top] = clone(value);
    } else {
      if (!isObj(cache[top])) cache[top] = {};
      var cur = cache[top];
      for (var i = 1; i < parts.length - 1; i++) {
        if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = clone(value);
    }

    var ok = persist(top);
    notify(path, ok);
    return ok;
  }

  /* 批量写：只落一次盘、只通知一次，避免表单保存时连环触发渲染 */
  function setMany(pairs) {
    var touched = {};
    var keys = [];
    var i;

    for (i = 0; i < pairs.length; i++) {
      var parts = String(pairs[i][0]).split('.');
      var top = parts[0];
      load(top);

      if (parts.length === 1) {
        cache[top] = clone(pairs[i][1]);
      } else {
        if (!isObj(cache[top])) cache[top] = {};
        var cur = cache[top];
        for (var j = 1; j < parts.length - 1; j++) {
          if (!isObj(cur[parts[j]])) cur[parts[j]] = {};
          cur = cur[parts[j]];
        }
        cur[parts[parts.length - 1]] = clone(pairs[i][1]);
      }

      if (!touched[top]) { touched[top] = true; keys.push(top); }
    }

    var ok = true;
    for (i = 0; i < keys.length; i++) {
      if (!persist(keys[i])) ok = false;
    }
    notify('*', ok);
    return ok;
  }

  /* ---------------------- 导出 / 导入 / 清理 ---------------------- */

  function exportAll() {
    var out = {
      app: 'sleepy',
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      data: {}
    };
    for (var top in DEFAULTS) {
      if (has(DEFAULTS, top)) out.data[top] = clone(load(top));
    }
    return out;
  }

  /* 只认自己导出的结构。
     注意：这里是 .json 备份文件，和 D8「禁止导入角色卡 json / 酒馆格式」
     不是一回事——D8 禁的是外部角色卡格式，这是用户自己的全量存档。 */
  function importAll(payload) {
    if (!isObj(payload) || payload.app !== 'sleepy' || !isObj(payload.data)) {
      return { ok: false, message: '这不是 Sleepy 的备份文件' };
    }
    if (payload.schema !== SCHEMA) {
      return { ok: false, message: '备份版本不兼容（schema ' + payload.schema + '）' };
    }

    var written = [];
    for (var top in payload.data) {
      if (!has(payload.data, top)) continue;
      var base = has(DEFAULTS, top) ? clone(DEFAULTS[top]) : null;
      var incoming = unwrapSelf(top, payload.data[top]);
      cache[top] = base !== null ? merge(base, incoming) : clone(incoming);
      if (persist(top)) written.push(top);
    }
    notify('*', true);
    return { ok: true, keys: written };
  }

  /* 2.6 存档体积：按 UTF-16 估算，键名也算进去 */
  function usage() {
    var bytes = 0;
    var keys = 0;
    try {
      var ls = global.localStorage;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(NS) === 0) {
          keys++;
          bytes += (k.length + (ls.getItem(k) || '').length) * 2;
        }
      }
    } catch (e) {
      lastError = { type: 'usage', key: null, message: (e && e.message) || String(e) };
    }
    return { keys: keys, bytes: bytes };
  }

  function clearAll() {
    try {
      var ls = global.localStorage;
      var doomed = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(NS) === 0) doomed.push(k);
      }
      for (var j = 0; j < doomed.length; j++) ls.removeItem(doomed[j]);
    } catch (e) {
      lastError = { type: 'clear', key: null, message: (e && e.message) || String(e) };
    }
    cache = {};
    notify('*', true);
    return true;
  }

  /* ---------------------------- 对外 ---------------------------- */

  function ensureInstalled() {
    load('meta');
    if (!cache.meta.installedAt) {
      cache.meta.installedAt = Date.now();
      persist('meta');
    }
    cache.meta.lastOpenAt = Date.now();
    persist('meta');
  }

  /* 世界书改成两级结构（书 → 条目）之前，条目是平铺在 worldbook 键里的。
     平铺的老数据整包搬进一本「默认世界书」（全局），旧键保留不删。 */
  function migrateWorldbookToBooks() {
    try {
      if (global.localStorage.getItem(NS + 'worldbooks')) return;
      var raw = global.localStorage.getItem(NS + 'worldbook');
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list) || !list.length) return;
      var book = {
        id: 'wbmig' + Date.now().toString(36),
        name: '默认世界书',
        scope: 'global',
        characterId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entries: list
      };
      global.localStorage.setItem(NS + 'worldbooks', JSON.stringify([book]));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把 ' + list.length + ' 个旧条目迁进「默认世界书」');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 */
    }
  }



  /* 主 API 改成多预设之前只有单个 mainApi。老配置整包变成第一套预设
     并设为当前使用，mainApi 键继续镜像当前配置，api.js 无感。 */
  function migrateMainApiPresets() {
    try {
      if (global.localStorage.getItem(NS + 'mainApis')) return;
      var raw = global.localStorage.getItem(NS + 'mainApi');
      if (!raw) return;
      var cfg = JSON.parse(raw);
      if (!cfg || !cfg.baseUrl || !cfg.model) return;
      var id = 'map' + Date.now().toString(36);
      var list = [{
        id: id,
        name: cfg.name || '主模型',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        contextMessages: cfg.contextMessages,
        timeoutSec: cfg.timeoutSec,
        stream: cfg.stream,
        enabled: cfg.enabled
      }];
      global.localStorage.setItem(NS + 'mainApis', JSON.stringify(list));
      global.localStorage.setItem(NS + 'mainApiId', JSON.stringify(id));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把原主 API 存为第一套预设');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 */
    }
  }

  /* 顺序有意如此：先搬旧键，再初始化 meta（函数声明有提升，放这里没问题） */
  migrateKeys();
  migrateWorldbookToBooks();
  migrateMainApiPresets();
  ensureInstalled();

  /* ------------------------- 一次性迁移 ------------------------- */

  /* A5 时期的「人设预设库」存在 presets 键里。后来归位到名片夹，改叫 characters。
     老存档不能丢：新键还没有数据、旧键有数据时，搬一次过去。
     旧键保留不删 —— 万一要回退到旧版本，还能找到东西。 */
  function migrateKeys() {
    try {
      if (global.localStorage.getItem(NS + 'characters')) return;
      var raw = global.localStorage.getItem(NS + 'presets');
      if (!raw) return;
      var list = JSON.parse(raw);
      /* 老存档还有过「套娃」形态：{ presets: [...] } */
      if (isObj(list) && has(list, 'presets')) list = list.presets;
      if (!Array.isArray(list) || !list.length) return;
      global.localStorage.setItem(NS + 'characters', JSON.stringify(list));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把 ' + list.length + ' 个旧预设迁到名片夹');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动，用户下次打开还会再试一遍 */
    }
  }

  Sleepy.store = {
    NS: NS,
    SCHEMA: SCHEMA,
    defaults: function () { return clone(DEFAULTS); },
    get: get,
    set: set,
    setMany: setMany,
    exportAll: exportAll,
    importAll: importAll,
    usage: usage,
    clearAll: clearAll,
    lastError: function () { return lastError; },
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }
  };

})(window);
