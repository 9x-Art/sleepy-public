/* ============================================================
   api.js — Sleepy 接口调用层
   依赖：store.js（取 mainApi / subApis / chatDefaults）
   被依赖：page-chat.js，后续 page-settings / page-subapi 也会迁移过来

   职责：
     1. endpoint 归一化（/v1 → /v1/chat/completions）
     2. 候选列表：主 API 优先 + 启用的副 API 按顺序排队
     3. 非流式请求（测试连接、v0 兜底）
     4. SSE 流式请求（打字机效果）+ 中止
     5. 轮询编排：单个失败自动切下一个候选

   为什么单独一层：设置页要"测连接"、聊天页要"真请求"、副 API 要"轮询"，
   三处共用同一套请求逻辑。复制第三份之前，先抽出来。
   全部用浏览器原生 fetch + 手写 SSE 解析，零依赖、全原创。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  var ENDPOINT_RE = /\/chat\/completions$/i;

  /* 用户很容易只填到 /v1，也会有人把完整地址整条粘进来。两种都认 */
  function normalizeEndpoint(baseUrl) {
    var u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (ENDPOINT_RE.test(u)) return u;
    return u + '/chat/completions';
  }

  /* 生成参数：三层回落 —— 对话级覆盖 > 单个接口的配置 > 聊天默认值。
     最上面那层是用户在「某个对话的设置」里专门填的（chat.overrides）。
     它必须赢，否则又是那种「在对话里改了温度，请求里还是老值」的隐形失效。
     null / undefined 都表示「这一层没设，往下找」—— 0 和 false 是有效值。 */
  function genParams(cfg, ov) {
    var def = store.get('chatDefaults') || {};
    ov = ov || {};
    cfg = cfg || {};

    function pick(key, fallback) {
      if (ov[key] !== null && ov[key] !== undefined) return ov[key];
      if (cfg[key] !== null && cfg[key] !== undefined) return cfg[key];
      if (def[key] !== null && def[key] !== undefined) return def[key];
      return fallback;
    }

    return {
      temperature: pick('temperature', 0.85),
      maxTokens: pick('maxTokens', 1024),
      contextMessages: pick('contextMessages', 20),
      timeoutSec: pick('timeoutSec', 60),
      stream: pick('stream', true)
    };
  }

  /* 候选列表：主 API（启用且有配置）排最前，然后是启用的副 API 按数组顺序 */
  function candidates() {
    var list = [];
    var main = store.get('mainApi') || {};
    if (main.enabled && main.baseUrl && main.model) {
      list.push({ source: 'main', label: main.name || '主模型', cfg: main });
    }
    var subs = store.get('subApis');
    if (Array.isArray(subs)) {
      subs.forEach(function (it) {
        if (it && it.enabled && it.baseUrl && it.model) {
          list.push({ source: 'sub', label: it.name || '副 API', cfg: it });
        }
      });
    }
    return list;
  }

  function requestHeaders(cfg) {
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    return headers;
  }

  function bodyFor(cfg, messages, stream, ov) {
    var p = genParams(cfg, ov);
    return JSON.stringify({
      model: cfg.model,
      messages: messages,
      stream: !!stream,
      max_tokens: p.maxTokens,
      temperature: p.temperature
    });
  }

  /* ------------------------- 非流式单次请求 ------------------------- */
  /* resolve({ok, stage, status, ms, data, content, error, detail, text}) */
  function requestOnce(cand, messages, ov) {
    return new Promise(function (resolve) {
      var p = genParams(cand.cfg, ov);
      var url = normalizeEndpoint(cand.cfg.baseUrl);
      if (!url) { resolve({ ok: false, stage: 'config', error: '接口地址是空的' }); return; }
      if (!cand.cfg.model) { resolve({ ok: false, stage: 'config', error: '还没填模型名' }); return; }

      var secs = Math.max(1, p.timeoutSec);
      var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, secs * 1000) : null;
      var t0 = Date.now();

      global.fetch(url, {
        method: 'POST',
        headers: requestHeaders(cand.cfg),
        mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined,
        body: bodyFor(cand.cfg, messages, false, ov)
      }).then(function (r) {
        return r.text().then(function (txt) {
          var ms = Date.now() - t0;
          var data = null;
          try { data = JSON.parse(txt); } catch (e) { /* 落到下面 */ }
          if (!r.ok) {
            resolve({ ok: false, stage: 'http', status: r.status, ms: ms, text: txt,
              error: 'HTTP ' + r.status, detail: txt.slice(0, 400) });
            return;
          }
          if (!data) {
            resolve({ ok: false, stage: 'parse', ms: ms, error: '返回的不是 JSON', detail: txt.slice(0, 400) });
            return;
          }
          var choice = data.choices && data.choices[0];
          var content = choice && (choice.message ? choice.message.content : (choice.text || ''));
          resolve({ ok: true, ms: ms, status: r.status, data: data, content: content || '' });
        });
      })['catch'](function (err) {
        var ms = Date.now() - t0;
        var aborted = err && err.name === 'AbortError';
        resolve({
          ok: false,
          stage: aborted ? 'timeout' : 'network',
          ms: ms,
          error: aborted ? ('超时：' + secs + ' 秒没有响应')
                         : '连不上：网络错误，或接口没有开 CORS',
          detail: (err && err.message) || String(err)
        });
      }).then(function () { if (timer) clearTimeout(timer); });
    });
  }

  /* -------------------------- 流式单次请求 -------------------------- */
  /* 手写 SSE 解析：逐行读 data: 块，把 delta.content 交给 handlers.onDelta。
     handlers: { onDelta(delta, more), onDone(text), onError(err) }
     返回 { abort() } 用于用户手动停止。 */
  function streamOnce(cand, messages, handlers, ov) {
    var p = genParams(cand.cfg, ov);
    var url = normalizeEndpoint(cand.cfg.baseUrl);
    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var timer = null;
    var out = '';
    var settled = false;

    handlers = handlers || {};

    function fail(err) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (handlers.onError) handlers.onError(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (handlers.onDone) handlers.onDone(out);
    }

    global.fetch(url, {
      method: 'POST',
      headers: requestHeaders(cand.cfg),
      mode: 'cors',
      signal: ctrl ? ctrl.signal : undefined,
      body: bodyFor(cand.cfg, messages, true, ov)
    }).then(function (r) {
      if (!r.ok) {
        fail({ stage: 'http', status: r.status, error: 'HTTP ' + r.status });
        return null;
      }
      if (!r.body || !r.body.getReader) {
        /* 有些中转不支持流式返回：退化成读全文，一次给完 */
        return r.text().then(function (txt) {
          var data = null;
          try { data = JSON.parse(txt); } catch (e) { /* 落下面 */ }
          var content = data && data.choices && data.choices[0] &&
            data.choices[0].message && data.choices[0].message.content;
          if (content) {
            out += content;
            if (handlers.onDelta) handlers.onDelta(content, false);
          }
          done();
        });
      }
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (res) {
          if (settled) return;
          if (res.done) { done(); return; }
          buffer += decoder.decode(res.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            var data = null;
            try { data = JSON.parse(payload); } catch (e) { continue; }
            var delta = data.choices && data.choices[0] && data.choices[0].delta &&
                        data.choices[0].delta.content;
            if (delta) {
              out += delta;
              if (handlers.onDelta) handlers.onDelta(delta, true);
            }
          }
          return pump();
        })['catch'](function (err) {
          fail({ stage: 'network', error: (err && err.message) || String(err) });
        });
      }
      return pump();
    })['catch'](function (err) {
      if (err && err.name === 'AbortError') { fail({ stage: 'aborted', error: '已停止' }); return; }
      fail({ stage: 'network', error: '连不上：网络错误，或接口没有开 CORS' });
    });

    return {
      abort: function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }
        fail({ stage: 'aborted', error: '已停止' });
      }
    };
  }

  /* ---------------------------- 轮询编排 ---------------------------- */
  /* candidates 依次尝试；单次失败自动切下一个。
     流式只在「还没产出任何字」之前才切换，已经开口就不重试（避免内容重复）。
     useStream 是「聊天默认参数」里的总开关；单个接口还能用自己的 stream
     把它关掉（中转不支持 SSE 时用得上）—— 所以是「与」的关系，
     而不是让接口字段白写在那里当死开关。
     handlers: { onTry, onDelta, onDone(cand, text, info), onFail(list, lastErr) }
     返回 handle（流式时有 abort） */
  function runChat(messages, handlers, useStream, ov) {
    var c = candidates();
    handlers = handlers || {};
    if (!c.length) {
      var e0 = { stage: 'config', error: '还没有可用的模型连接，去 设置 → 模型连接 填 API' };
      if (handlers.onFail) handlers.onFail(c, e0);
      return null;
    }
    var idx = 0;
    var lastErr = null;
    var handle = null;

    function tryNext() {
      if (idx >= c.length) {
        if (handlers.onFail) handlers.onFail(c, lastErr);
        return null;
      }
      var cand = c[idx++];
      var streamThis = !!useStream && cand.cfg.stream !== false;
      if (handlers.onTry) handlers.onTry(cand, idx, c.length);

      if (streamThis) {
        var started = false;
        handle = streamOnce(cand, messages, {
          onDelta: function (delta, more) {
            started = true;
            if (handlers.onDelta) handlers.onDelta(delta, more);
          },
          onDone: function (text) {
            if (handlers.onDone) handlers.onDone(cand, text);
          },
          onError: function (err) {
            lastErr = err;
            if (err && err.stage === 'aborted') { if (handlers.onFail) handlers.onFail(c, err); return; }
            if (!started) tryNext();
            else if (handlers.onFail) handlers.onFail(c, err);
          }
        }, ov);
      } else {
        requestOnce(cand, messages, ov).then(function (res) {
          if (res.ok) {
            if (handlers.onDone) handlers.onDone(cand, res.content, res);
          } else {
            lastErr = res;
            tryNext();
          }
        });
        handle = { abort: function () { /* 非流式中止留给未来的 AbortController 串接 */ } };
      }
      return handle;
    }
    return tryNext();
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.api = {
    normalizeEndpoint: normalizeEndpoint,
    candidates: candidates,
    requestOnce: requestOnce,
    streamOnce: streamOnce,
    runChat: runChat
  };

})(window);