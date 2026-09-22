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

  /* 生成参数的**唯一**内置默认值表（对话覆盖和接口配置都没设时用它）。
     2026-09-22 上下文条数 20 → 40：20 条只够十来个来回，稍微长一点的对话
     开头就滑出视野了（用户：「有点少」）。上限仍是 200，设置页可调。
     以前 store 的 chatDefaults 里也抄了一份，两份重复时以它为准，于是改这里
     根本不生效（真机踩到）—— 现在 store 里不放生成参数了，老存档由
     store.js 的 migrateChatDefaultsGenerative 清掉，见那边注释。 */
  var GEN_DEFAULTS = {
    temperature: 0.85,
    maxTokens: 1024,
    contextMessages: 40,
    timeoutSec: 60,
    stream: true
  };

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
      temperature: pick('temperature', GEN_DEFAULTS.temperature),
      maxTokens: pick('maxTokens', GEN_DEFAULTS.maxTokens),
      contextMessages: pick('contextMessages', GEN_DEFAULTS.contextMessages),
      timeoutSec: pick('timeoutSec', GEN_DEFAULTS.timeoutSec),
      stream: pick('stream', GEN_DEFAULTS.stream)
    };
  }

  /* 携带上下文条数的**唯一**出口：对话覆盖 > 聊天默认 > 内置默认。
     page-chat（真聊天）/ page-presets（预演）/ page-heartbeat（心声）三处
     本来各写一遍同样的回落 —— 改一次默认值要改三个地方，漏一个的表现
     就是「预演里记得的事，真聊天里忘了」这种最难查的不一致。 */
  function contextLimit(chat) {
    var ov = null;
    if (Sleepy.chatStore && Sleepy.chatStore.overridesOf) {
      ov = Sleepy.chatStore.overridesOf(chat);
    }
    if (!ov) ov = (chat && chat.overrides) || {};
    if (ov.contextMessages != null) return ov.contextMessages;
    var cfg = store.get('chatDefaults') || {};
    if (cfg.contextMessages != null) return cfg.contextMessages;
    return GEN_DEFAULTS.contextMessages;
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

  /* ------------------------- 失败原因翻译 ------------------------- */
  /* 把 requestOnce 的失败结果翻成**人能看懂的一句话**。页面里别自己拼。

     ⚠️ 为什么必须有这个：
     `requestOnce` resolve 的是 `{ok, stage, status, error, detail}` ——
     **它没有 `message` 字段**（`message` 只有 `fetchModels` 才有）。
     所以各页面里写 `res.message || '请求失败'` 的写法，等于把所有失败原因
     都吞成同一句「请求失败」：没填模型名、接口地址是空的、HTTP 401、
     超时 60 秒不响应、CORS 被拦 —— 用户看到的全都一样，没法自救。
     这个坏模式当时被抄在 6 个页面里（2026-09-21 排查「底片生成失败只说
     请求失败」时统一收敛到这里）。 */
  function brief(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    n = n || 80;
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function describeError(res) {
    if (!res) return '未知错误';
    if (res.stage) {
      if (res.stage === 'config') return res.error || '配置不完整（接口地址 / 模型名 / Key 少了一个）';
      if (res.stage === 'http') {
        /* HTTP 正文里通常写着真正的原因（model not found / invalid api key），
           截一段带上比只给一个状态码有用得多 */
        return '接口返回 HTTP ' + res.status + (res.detail ? '：' + brief(res.detail) : '');
      }
      if (res.stage === 'timeout') return res.error || '超时：接口没有在限定时间内响应';
      if (res.stage === 'network') return res.error || '连不上：网络错误，或接口没有开 CORS';
      if (res.stage === 'parse') return '接口返回的不是 JSON，可能不是兼容接口' +
        (res.detail ? '：' + brief(res.detail) : '');
      return res.error || res.message || '请求失败';
    }
    /* 走到这里说明它不是 requestOnce 的结果对象（那一定带 stage）。
       异常对象 / fetchModels 那种带 message 的，message 就是最准的描述；
       其它退化情况给一句通用文案，别把 [object Object] 显给用户看。 */
    if (typeof res === 'string') return res;
    if (res.message) return String(res.message);
    return res.error || '请求失败';
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

  /* ---------------------------- 拉取模型列表 ---------------------------- */
  /* GET {base}/models，OpenAI 兼容接口的标配。
     base 可能被填成 /v1 也可能整条 /chat/completions 都带上了，都要认。 */
  function modelsUrl(baseUrl) {
    var u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    u = u.replace(/\/chat\/completions$/i, '');
    return u + '/models';
  }

  function fetchModels(cfg) {
    return new Promise(function (resolve) {
      var url = modelsUrl(cfg.baseUrl);
      if (!url) { resolve({ ok: false, message: '先填接口地址' }); return; }

      var headers = {};
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

      global.fetch(url, { method: 'GET', headers: headers, mode: 'cors' })
        .then(function (r) {
          return r.text().then(function (txt) {
            if (!r.ok) {
              resolve({ ok: false, message: 'HTTP ' + r.status, detail: txt.slice(0, 200) });
              return;
            }
            var data = null;
            try { data = JSON.parse(txt); } catch (e) { /* 落到下面 */ }
            var arr = data && (data.data || data.models || data.model_list);
            if (!Array.isArray(arr)) {
              resolve({ ok: false, message: '返回里没有模型列表', detail: txt.slice(0, 200) });
              return;
            }
            var ids = arr.map(function (x) {
              return (typeof x === 'string') ? x : (x && (x.id || x.name));
            }).filter(Boolean);
            resolve({ ok: true, models: ids });
          });
        })
        ['catch'](function (err) {
          resolve({ ok: false, message: '连不上：网络错误，或这个接口没有开 CORS',
            detail: (err && err.message) || String(err) });
        });
    });
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
    /* 重试次数（设置 → 副 API → 每组重试次数）：每个候选连续尝试 N 次
       再轮到下一个。1~5，存档坏了/没填兜底 2。 */
    var retryN = Math.max(1, Math.min(5, Math.round(Number(store.get('subRetry'))) || 2));
    var base = candidates();
    /* 个性化（用户 2026-09-22：「模型没接上个性选择」）：
       这篇对话单独指定了走哪条连接就只用它。以前 ov 传进来**压根没读**，
       所以设置页那一行点了跟没点一样。选中的连接被删掉时（filter 后为空）
       自动回落全部候选，不至于把对话卡死。 */
    if (ov && ov.pickLabel) {
      var picked = base.filter(function (x) { return x.label === ov.pickLabel; });
      if (picked.length) base = picked;
    }
    var c = [];
    base.forEach(function (cand) {
      for (var i = 0; i < retryN; i++) c.push(cand);
    });
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

  /* ------------------------- 向量（embeddings） -------------------------
     和对话不是一回事，所以**不走 candidates()**：
     · 端点不同（/embeddings，不是 /chat/completions）；
     · 主 API 通常是对话模型，喂它 /embeddings 只会 404 ——
       所以没配向量 API 时直接说「没配」，绝不偷偷回落到主 API
       发一个注定失败的请求（那会变成「向量明明没配，却在悄悄烧钱/报错」）。

     cfg = { baseUrl, apiKey, model }（没有其余对话参数可调）。
     resolve({ok, vecs, dim, error, detail, ms}) —— 一次批量多条，
     顺序与 texts 一一对应。 */
  function embeddingsUrl(baseUrl) {
    var u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/embeddings$/i.test(u)) return u;
    return u + '/embeddings';
  }

  function embed(cfg, texts, ov) {
    return new Promise(function (resolve) {
      cfg = cfg || {};
      var list = (Array.isArray(texts) ? texts : [texts])
        .map(function (t) { return String(t == null ? '' : t); });
      var url = embeddingsUrl(cfg.baseUrl);
      if (!url) { resolve({ ok: false, stage: 'config', error: '还没填向量接口地址' }); return; }
      if (!cfg.model) { resolve({ ok: false, stage: 'config', error: '还没填向量模型名' }); return; }

      var secs = Math.max(1, Number(ov && ov.timeoutSec) || 60);
      var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, secs * 1000) : null;
      var t0 = Date.now();

      var headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

      global.fetch(url, {
        method: 'POST', headers: headers, mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined,
        body: JSON.stringify({ model: cfg.model, input: list })
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (timer) clearTimeout(timer);
          var ms = Date.now() - t0;
          var data = null;
          try { data = JSON.parse(txt); } catch (e) { /* 落到下面判 */ }
          if (!r.ok) {
            resolve({ ok: false, stage: 'http', status: r.status, ms: ms,
              error: 'HTTP ' + r.status, detail: txt.slice(0, 400) });
            return;
          }
          if (!data || !Array.isArray(data.data)) {
            resolve({ ok: false, stage: 'parse', ms: ms,
              error: '返回里没有 data 数组，可能不是 embedding 接口',
              detail: txt.slice(0, 400) });
            return;
          }
          var vecs = data.data.map(function (d) { return (d && d.embedding) || null; });
          if (!vecs.length || !vecs[0]) {
            resolve({ ok: false, stage: 'parse', ms: ms, error: '返回的向量是空的' });
            return;
          }
          resolve({ ok: true, ms: ms, vecs: vecs, dim: vecs[0].length, usage: data.usage || null });
        });
      })['catch'](function (e) {
        if (timer) clearTimeout(timer);
        var aborted = e && (e.name === 'AbortError');
        resolve({ ok: false, stage: aborted ? 'timeout' : 'network',
          error: aborted ? ('超时：' + secs + ' 秒内没有响应') : ((e && e.message) || '网络错误'),
          detail: (e && e.message) || '' });
      });
    });
  }

  Sleepy.api = {
    normalizeEndpoint: normalizeEndpoint,
    modelsUrl: modelsUrl,
    fetchModels: fetchModels,
    candidates: candidates,
    /* 上下文条数：三处（真聊天 / 预演 / 心声）共用的唯一出口 */
    contextLimit: contextLimit,
    /* 生成参数的内置默认值：页面表单拿它做灰字占位（别再用 store 那份） */
    genDefaults: GEN_DEFAULTS,
    requestOnce: requestOnce,
    /* 失败原因翻译：所有「把错误显示给用户」的地方都走它，别再各写一份
       `res.message || '请求失败'`（那等于把原因全吞了）。 */
    describeError: describeError,
    streamOnce: streamOnce,
    runChat: runChat,
    /* 向量：端点与回落规则都和对话不同，见上面那段注释 */
    embeddingsUrl: embeddingsUrl,
    embed: embed
  };

})(window);