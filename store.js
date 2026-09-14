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

    /* A5 人设预设库 */
    presets: [],

    /* 手账本 */
    diaries: []
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

  ensureInstalled();

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
