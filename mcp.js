/* ============================================================
   mcp.js — MCP（Model Context Protocol）连接层（2026-10-06）

   用户的需求：「支持工具调用，可以加多个 mcp，每个 mcp 有总开关，
   点进去每个 tool 也加开关，角色聊天设置页再加一个 MCP 能力开关。」

   ---- 只支持两种 transport（2026-10-06 用户拍板）----
   · 'http'  streamable HTTP（MCP 当前主流）：每轮 JSON-RPC 直接 POST
     到服务地址；首次 initialize 后记下 Mcp-Session-Id 响应头，
     后续请求都带上 —— 有会话要求的服务也能用。
   · 'sse'   旧版 HTTP+SSE：GET 建立 EventSource 长连，服务发 'endpoint'
     事件指 POST 地址；同一条连接上握手 + 调用（会话不能断，
     所以每次调用都开新连接走完 initialize → tools/call 再关）。
   stdio 型（本地 npx 起的）网页连不了 —— 等以后做 APK 再接本地。

   ---- 数据 ----
   store 'mcpServers'（全局一份，不分岛 —— 它是系统能力，
   和主/副 API 同一层；用不用由各对话自己的 MCP 开关决定）：
     [{ id, name, url, token, transport:'http'|'sse', enabled,
        tools:[{name,description,schema}],      ← 上次刷新拉到的清单
        toolOn:{name:true},                     ← 逐工具开关（默认关）
        lastSync, lastError }]

   ---- CORS 是硬约束 ----
   网页直连，MCP 服务必须允许跨域；连不上时错误文案里都带这一句。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var PROTOCOL_VERSION = '2025-03-26';

  /* ---------------------------- 配置读写 ---------------------------- */

  function allFull() {
    var l = store.get('mcpServers');
    return Array.isArray(l) ? l : [];
  }
  function save(list) { return store.set('mcpServers', list); }
  function list() { return allFull(); }

  function cfgOf(id) {
    var hit = null;
    allFull().forEach(function (c) { if (c.id === id) hit = c; });
    return hit;
  }

  /* 新增 / 编辑。url 必填；transport 只认 'http' | 'sse'。 */
  function upsert(rec) {
    rec = rec || {};
    if (!String(rec.url || '').trim()) return { ok: false, error: '服务地址是空的' };
    var list2 = allFull();
    var hit = null;
    for (var i = 0; i < list2.length; i++) {
      if (list2[i].id === rec.id) { hit = i; break; }
    }
    var base = hit != null ? list2[hit] : { id: core.newId('mcp'), tools: [], toolOn: {} };
    base.name = String(rec.name || base.name || '').trim() || '未命名服务';
    base.url = String(rec.url || '').trim();
    base.token = String(rec.token != null ? rec.token : (base.token || '')).trim();
    base.transport = rec.transport === 'sse' ? 'sse' : 'http';
    if (rec.enabled !== undefined) base.enabled = !!rec.enabled;
    else if (hit == null) base.enabled = true;
    if (hit != null) list2[hit] = base; else list2.push(base);
    save(list2);
    return { ok: true, cfg: base };
  }

  function remove(id) {
    save(allFull().filter(function (c) { return c.id !== id; }));
    return { ok: true };
  }

  function patch(id, fields) {
    var list2 = allFull();
    for (var i = 0; i < list2.length; i++) {
      if (list2[i].id !== id) continue;
      var c = list2[i];
      Object.keys(fields || {}).forEach(function (k) { c[k] = fields[k]; });
      save(list2);
      return c;
    }
    return null;
  }

  function setEnabled(id, on) {
    return patch(id, { enabled: !!on }) ? { ok: true } : { ok: false, error: '找不到这条配置' };
  }

  /* 逐工具开关（默认关 —— 挂了新工具不让它自动上场，用户自己点开才算数） */
  function toggleTool(id, toolName, on) {
    var c = cfgOf(id);
    if (!c) return { ok: false, error: '找不到这条配置' };
    var on2 = Object.assign({}, c.toolOn || {});
    on2[toolName] = !!on;
    patch(id, { toolOn: on2 });
    return { ok: true };
  }

  /* ---------------------------- JSON-RPC 底座 ---------------------------- */

  function headersOf(cfg) {
    var h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (cfg.token) h['Authorization'] = 'Bearer ' + cfg.token;
    return h;
  }

  /* streamable HTTP 的应答可能是纯 JSON，也可能是 SSE 帧 —— 都从文本里抠。 */
  function parseRpcText(txt) {
    try { var j = JSON.parse(txt); if (j && (j.result || j.error || j.id != null)) return j; } catch (e) { /* 落到 SSE 帧 */ }
    var lines = String(txt || '').split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var l = lines[i];
      if (l.indexOf('data:') !== 0) continue;
      try {
        var m = JSON.parse(l.slice(5).trim());
        if (m && (m.result || m.error)) return m;
      } catch (e) { /* 这一帧不是 JSON，继续往上找 */ }
    }
    return null;
  }

  function rpcError(msg) {
    return { ok: false, error: (msg && msg.error && msg.error.message) || 'MCP 服务返回了错误' };
  }

  /* ---- streamable HTTP 会话：initialize → 记 Session-Id → 用完 DELETE ---- */
  function httpSession(cfg) {
    var sid = null;
    function post(body) {
      var h = headersOf(cfg);
      if (sid) h['Mcp-Session-Id'] = sid;
      return global.fetch(cfg.url, { method: 'POST', headers: h, body: JSON.stringify(body) })
        .then(function (r) {
          var s = r.headers.get('Mcp-Session-Id');
          if (s) sid = s;
          return r.text().then(function (txt) { return { status: r.status, txt: txt }; });
        });
    }
    return {
      init: function () {
        return post({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'sleepy', version: '1.0' }
          }
        }).then(function (r) {
          if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status, detail: r.txt.slice(0, 200) };
          var msg = parseRpcText(r.txt);
          if (!msg) return { ok: false, error: '返回不是 JSON-RPC，可能不是 MCP 服务' };
          if (msg.error) return rpcError(msg);
          return post({ jsonrpc: '2.0', method: 'notifications/initialized' })
            .then(function () { return { ok: true }; });
        })['catch'](function (e) {
          return { ok: false, error: '连不上：网络错误，或服务没开 CORS', detail: (e && e.message) || '' };
        });
      },
      rpc: function (method, params) {
        var id = Date.now() % 1e9 + Math.floor(Math.random() * 1000);
        return post({ jsonrpc: '2.0', id: id, method: method, params: params || {} })
          .then(function (r) {
            if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status, detail: r.txt.slice(0, 200) };
            var msg = parseRpcText(r.txt);
            if (!msg) return { ok: false, error: '返回不是 JSON-RPC' };
            if (msg.error) return rpcError(msg);
            return { ok: true, result: msg.result };
          })['catch'](function (e) {
            return { ok: false, error: '连不上：网络错误，或服务没开 CORS', detail: (e && e.message) || '' };
          });
      },
      close: function () {
        if (!sid) return;
        try {
          var h = headersOf(cfg);
          h['Mcp-Session-Id'] = sid;
          global.fetch(cfg.url, { method: 'DELETE', headers: h });
        } catch (e) { /* 关不掉就算了 */ }
      }
    };
  }

  /* ---- 旧版 SSE 会话：一条 EventSource 上跑完握手 + 调用 ----
     会话不能跨连接复用（服务按连接记状态），所以每次都用
     openSseToolsSession 开新连接走完 initialize → 干活 → 关。 */

  /* ---------------------------- 对外动作 ---------------------------- */

  /* 拉工具清单：连上 → tools/list → 落库（覆盖旧清单）。
     已经开着的 toolOn 不动 —— 新工具默认关（见 toggleTool）。 */
  function refreshTools(id) {
    var cfg = cfgOf(id);
    if (!cfg) return Promise.resolve({ ok: false, error: '找不到这条配置' });
    if (!cfg.url) return Promise.resolve({ ok: false, error: '先填服务地址' });

    var session = null;
    var ready;
    if (cfg.transport === 'sse') {
      ready = openSseToolsSession(cfg);   /* 见下：返回 {ok, rpc, close} */
    } else {
      session = httpSession(cfg);
      ready = session.init().then(function (r) {
        return r.ok ? { ok: true, rpc: session.rpc.bind(session), close: session.close.bind(session) } : r;
      });
    }

    return ready.then(function (s) {
      if (!s.ok) {
        patch(id, { lastError: s.error || '连接失败', lastSync: 0 });
        return s;
      }
      return s.rpc('tools/list', {}).then(function (r) {
        try { s.close(); } catch (e) { /* 已关 */ }
        if (!r.ok) {
          patch(id, { lastError: r.error || 'tools/list 失败' });
          return r;
        }
        var tools = (r.result && Array.isArray(r.result.tools))
          ? r.result.tools.map(function (t) {
              return {
                name: t.name || '',
                description: t.description || '',
                schema: t.inputSchema || { type: 'object', properties: {} }
              };
            }).filter(function (t) { return t.name; })
          : [];
        patch(id, { tools: tools, lastSync: Date.now(), lastError: '' });
        return { ok: true, tools: tools };
      });
    });
  }

  /* SSE 也要「先握手再干活」的会话形状，包一层和 httpSession 同款的接口。
     时序：endpoint 事件 → POST initialize → 应答回来 → 发 initialized
     通知 → 把会话（rpc/close）交回调用方。 */
  function openSseToolsSession(cfg) {
    return new Promise(function (resolve) {
      var es;
      try { es = new global.EventSource(cfg.url); }
      catch (e) { resolve({ ok: false, error: 'EventSource 起不来：' + e.message }); return; }

      var endpoint = null;
      var rid = 0;
      var pending = {};
      var timer = setTimeout(function () {
        cleanup();
        resolve({ ok: false, error: 'SSE 握手超时（10 秒内没等到 endpoint/应答）' });
      }, 10000);

      function cleanup() {
        clearTimeout(timer);
        try { es.close(); } catch (e2) { /* 已关 */ }
      }
      function settle(res) { cleanup(); resolve(res); }

      es.addEventListener('endpoint', function (ev) {
        try { endpoint = new URL(ev.data, cfg.url).href; }
        catch (e) { endpoint = ev.data; }

        /* 第一条 = initialize；应答回来才算握手完成 */
        var initId = ++rid;
        pending[initId] = function (msg) {
          if (msg.error) { settle(rpcError(msg)); return; }
          postMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
          settle({
            ok: true,
            rpc: function (method, params) {
              return new Promise(function (res2) {
                var id2 = ++rid;
                pending[id2] = function (m2) {
                  if (m2.error) res2(rpcError(m2)); else res2({ ok: true, result: m2.result });
                };
                postMessage({ jsonrpc: '2.0', id: id2, method: method, params: params || {} });
                /* 20 秒没应答就放手，别吊死一条调用 */
                setTimeout(function () {
                  if (pending[id2]) {
                    delete pending[id2];
                    res2({ ok: false, error: 'MCP 调用超时（20 秒没应答）' });
                  }
                }, 20000);
              });
            },
            close: function () { try { es.close(); } catch (e2) { /* 已关 */ } }
          });
        };
        postMessage({ jsonrpc: '2.0', id: initId, method: 'initialize', params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'sleepy', version: '1.0' }
        }});
      });

      es.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id == null || pending[msg.id] == null) return;
        var done2 = pending[msg.id];
        delete pending[msg.id];
        done2(msg);
      };
      es.onerror = function () { /* EventSource 会自动重连；超时兜底在 timer */ };

      function postMessage(body) {
        global.fetch(endpoint, { method: 'POST', headers: headersOf(cfg), body: JSON.stringify(body) })
          .then(function (r) {
            if (!r.ok) settle({ ok: false, error: 'HTTP ' + r.status + '（POST ' + endpoint + '）' });
          })
          .catch(function (e) {
            settle({ ok: false, error: 'POST 失败：' + ((e && e.message) || e) });
          });
      }
    });
  }

  /* 执行一个工具（页面层通过 ov.toolCall 交给 api.js 的工具循环）：
     找第一个「服务开着 + 这个工具也开着」的配置，连上去 tools/call。
     同名工具挂了多个服务时用第一个 —— 设置页里自己别重复开。 */
  function callToolByName(name, args) {
    var hit = null;
    allFull().forEach(function (c) {
      if (hit || !c.enabled) return;
      var on = (c.toolOn || {})[name] === true;
      var has = (c.tools || []).some(function (t) { return t.name === name; });
      if (on && has) hit = c;
    });
    if (!hit) {
      return Promise.resolve({ ok: false, error: '没有启用中的 MCP 工具叫「' + name + '」' });
    }
    var cfg = hit;
    if (cfg.transport === 'sse') {
      return openSseToolsSession(cfg).then(function (s) {
        if (!s.ok) return s;
        return s.rpc('tools/call', { name: name, arguments: args || {} })
          .then(function (r) { try { s.close(); } catch (e) { /* 已关 */ } return r; });
      });
    }
    var session = httpSession(cfg);
    return session.init().then(function (r) {
      if (!r.ok) return r;
      return session.rpc('tools/call', { name: name, arguments: args || {} })
        .then(function (r2) { session.close(); return r2; });
    });
  }

  /* OpenAI tools 格式的清单：只收「服务开着 + 工具也开着」的。
     api.js 的工具循环拿它塞进请求体（ov.tools）。 */
  function enabledToolSpecs() {
    var out = [];
    allFull().forEach(function (c) {
      if (!c.enabled) return;
      (c.tools || []).forEach(function (t) {
        if (!t.name || (c.toolOn || {})[t.name] !== true) return;
        out.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.schema || { type: 'object', properties: {} }
          }
        });
      });
    });
    return out;
  }

  function summary() {
    var l = allFull();
    if (!l.length) return '未配置';
    var on = l.filter(function (c) { return c.enabled; }).length;
    var tools = 0;
    l.forEach(function (c) {
      if (!c.enabled) return;
      (c.tools || []).forEach(function (t) {
        if ((c.toolOn || {})[t.name] === true) tools++;
      });
    });
    return on + '/' + l.length + ' 服务 · ' + tools + ' 工具';
  }

  /* ---------------------------- 导出 ---------------------------- */

  Sleepy.mcp = {
    list: list,
    cfgOf: cfgOf,
    upsert: upsert,
    remove: remove,
    setEnabled: setEnabled,
    toggleTool: toggleTool,
    refreshTools: refreshTools,
    callToolByName: callToolByName,
    enabledToolSpecs: enabledToolSpecs,
    summary: summary,
    PROTOCOL_VERSION: PROTOCOL_VERSION
  };

})(window);
