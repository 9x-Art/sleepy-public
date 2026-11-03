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
     开头就滑出视野了（需求：「有点少」）。上限仍是 200，设置页可调。
     以前 store 的 chatDefaults 里也抄了一份，两份重复时以它为准，于是改这里
     根本不生效（真机踩到）—— 现在 store 里不放生成参数了，老存档由
     store.js 的 migrateChatDefaultsGenerative 清掉，见那边注释。 */
  var GEN_DEFAULTS = {
    temperature: 0.85,
    /* 2048（2026-10-26 空回维稳）：reasoning 类模型会先烧思考 token 再吐正文，
       1024 常常思考烧完就到顶、content 全空 —— 是「很多地方空回」的主力
       嫌犯之一。普通模型多一倍上限只影响极端长回复，不白花钱。 */
    maxTokens: 2048,
    contextMessages: 40,
    timeoutSec: 60,
    stream: true
  };

  /* 截断提示（2026-10-31）：finish_reason = length 时追加到正文末尾。
     以前 length 和 stop 一视同仁静默收尾 —— 思考类模型把 max_tokens
     额度先烧在思考上、正文只吐几个字就到顶，用户看到的却是「角色说
     两个字就不说了」，完全无从排查。打上标记才对得起调上限的人。 */
  var TRUNC_NOTE = '\n\n〔这条回复触到了「单次回复上限」被截断 —— 思考类模型会先烧思考额度，建议把接口设置里的「单次回复上限」再调大，或换非思考模型〕';

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

    /* 超时归一（2026-09-29 设计确认「归一到 60s」）：存档里 <60 的值一律按
       60 跑 —— 用户真机遇到「几秒就超时」，查下来是早年存的小值一直生效。
       下限本来是 5 秒（老存档 timeoutSec: 0 会被算成 1 秒，2026-09-23 修），
       现在直接抬到 60：UI 就不该再让人填小于 60 的值。 */
    var tout = pick('timeoutSec', GEN_DEFAULTS.timeoutSec);
    if (!(tout >= 60)) tout = GEN_DEFAULTS.timeoutSec;

    return {
      temperature: pick('temperature', GEN_DEFAULTS.temperature),
      maxTokens: pick('maxTokens', GEN_DEFAULTS.maxTokens),
      contextMessages: pick('contextMessages', GEN_DEFAULTS.contextMessages),
      timeoutSec: tout,
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

  /* 候选列表：主 API（启用且有配置）排最前，然后是启用的副 API 按数组顺序。
     ov.feature 带了功能键且该功能被勾选「走副 API」→ **只**返回副 API
     （多组间照旧轮询），绝不掺主 API —— 这是 2026-10-08 副 API 定位重构的
     核心：副 API 服务指定功能，不是主聊天的接替队列。 */
  function candidates(feature) {
    if (feature && featureOn(feature)) return subCandidates();
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

  /* ==================== 副 API 功能分配（2026-10-08 定位重构） ====================
     副 API 的正确定位：服务**不那么重要 / 稍微简单 / 经常要用**的功能，
     不是主 API 挂了之后的接替队列。user 在 设置 → 副 API 里勾选功能：
     · 勾了 → 该功能严格走副 API（多组之间轮询，每组重试 subRetry 次），
       全部失败就报错，**绝不偷用主 API**；
     · 没勾 → 该功能照旧（主 API 候选链）。
     清单在 FEATURES（UI 与报错共用一份）；新功能接线 = 调用方二选一：
       · runChat 系：ov 传 { feature: '<key>' }（candidates 自动收窄）；
       · requestOnce 系：Sleepy.api.requestForFeature(key, messages, ov)
         —— 未勾选返回 null（调用方走自己的默认），勾选返回
         Promise<{ok,content}>，内部只轮询副 API。 */
  var KEY_FEATURES = 'subApiFeatures';

  var FEATURES = [
    { key: 'proactive', label: 'TA 主动消息' },
    { key: 'schedule',  label: '角色日程（每日生成）' },
    { key: 'heartbeat', label: '心声（手动想一条）' },
    { key: 'moments',   label: '朋友圈动态（刷新 / TA 发帖）' },
    { key: 'forum',     label: '群声（催更 / @ta）' },
    { key: 'diary',     label: '日记代笔' },
    { key: 'offline',   label: '线下模式' },
    { key: 'talife',    label: 'TA 自主生活推进' },
    { key: 'director',  label: '生图想画面（导演）' },
    { key: 'book',      label: '以身入局（入世轮 / 行动轮）' },
    { key: 'wjcurtain', label: '帷境（写章 / 审阅 / 共读回应）' }
  ];

  function featureLabel(key) {
    for (var i = 0; i < FEATURES.length; i++) {
      if (FEATURES[i].key === key) return FEATURES[i].label;
    }
    return key;
  }

  function featureOn(key) {
    var m = store.get(KEY_FEATURES);
    return !!(m && m[key] === true);
  }

  /* 启用中且配置齐全的副 API（顺序 = 数组顺序，与候选队列同口径） */
  function subCandidates() {
    var list = [];
    var subs = store.get('subApis');
    (Array.isArray(subs) ? subs : []).forEach(function (it) {
      if (it && it.enabled && it.baseUrl && it.model) {
        list.push({ source: 'sub', label: it.name || '副 API', cfg: it });
      }
    });
    return list;
  }

  /* 功能调用的统一入口（requestOnce 系模块用）。
     返回 null  = 该功能没勾选，调用方走自己的默认路径；
     返回 Promise = 已勾选，内部只在副 API 之间轮询：
       全部失败 → { ok:false, error:'副 API 全部失败（…不回落主 API）' }；
       一个都没有 → { ok:false, error:'…已指定走副 API，但没有启用中的副 API' }。 */
  function requestForFeature(key, messages, ov) {
    if (!featureOn(key)) return null;
    var subs = subCandidates();
    if (!subs.length) {
      return Promise.resolve({ ok: false,
        error: '「' + featureLabel(key) + '」已指定走副 API，但没有启用中的副 API —— 去 设置 → 副 API 检查' });
    }
    var i = 0;
    function next() {
      if (i >= subs.length) {
        return Promise.resolve({ ok: false,
          error: '副 API 全部失败（「' + featureLabel(key) + '」已指定走副 API，不回落主 API）' });
      }
      var cand = subs[i++];
      return requestOnce(cand, messages, ov || {}).then(function (res) {
        if (res.ok) return { ok: true, content: res.content, cand: cand };
        return next();
      }, function () { return next(); });
    }
    return next();
  }

  function requestHeaders(cfg) {
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    return headers;
  }

  function bodyFor(cfg, messages, stream, ov) {
    var p = genParams(cfg, ov);
    var body = {
      model: cfg.model,
      messages: messages,
      stream: !!stream,
      max_tokens: p.maxTokens,
      temperature: p.temperature
    };
    /* MCP 工具（2026-10-06）：OpenAI tools 格式，ov.tools 非空才带 ——
       没开工具的对话一个多余字段都不发（有的中转见了 tools 会挑刺）。 */
    if (ov && Array.isArray(ov.tools) && ov.tools.length) {
      body.tools = ov.tools;
      body.tool_choice = 'auto';
    }
    /* 用量统计（2026-10-26）：只在流式 + ov.askUsage 时带 include_usage
       —— 有的中转见了陌生字段会挑刺，所以默认不带；接口不认时
       streamOnce 会去掉它原地重试一次（见那边 !r.ok 分支）。 */
    if (stream && ov && ov.askUsage) {
      body.stream_options = { include_usage: true };
    }
    return JSON.stringify(body);
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
          /* length = max_tokens 烧到顶被截断：打标记，别静默（2026-10-31） */
          if (choice && choice.finish_reason === 'length') {
            content = (content || '') + TRUNC_NOTE;
          }
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
     handlers: { onDelta(delta, more), onDone(text, usage), onError(err) }
     —— usage 是响应自带的 token 用量（只在开了 askUsage 时才请求它，
     接口不认 stream_options 时自动降级重试一次，见 !r.ok 分支）。
     返回 { abort() } 用于用户手动停止。 */
  function streamOnce(cand, messages, handlers, ov) {
    var p = genParams(cand.cfg, ov);
    var url = normalizeEndpoint(cand.cfg.baseUrl);
    var ctrl = (typeof global.AbortController === 'function') ? new AbortController() : null;
    var timer = null;
    var out = '';
    var usage = null;
    var settled = false;

    handlers = handlers || {};

    /* 流空闲看门狗（2026-10-29 「回复可见却没落库」实锤）：
       网关把内容吐完但不发结束帧（或最后一帧被网络吞掉）时，reader.read()
       永远不 resolve，done() 永远不触发 —— 回复全文停在 pending 气泡里，
       刷新即蒸发，且不同网络/机型表现不同。修法：收到首个分块后启动
       空闲表，**连续 15s 一个分块都没有**就收尾 —— 有内容按完成处理
       （落库保命），一个字都没有按失败换候选。15s 的沉默对正常生成
       罕见（思考模型的 reasoning 分块也在持续流动，会不停喂表）。 */
    var IDLE_MS = 15000;
    var idleTimer = null;
    function armIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        if (settled) return;
        if (String(out || '').trim()) done();
        else fail({ stage: 'timeout', error: '流式超时：服务器 15 秒没有任何响应' });
      }, IDLE_MS);
    }
    function disarmIdle() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    /* 首块超时（2026-10-31 体检补）：空闲看门狗只罩「已开始吐内容之后」，
       网关 TCP 连上了却一个字不吐（或只发注释帧保活）时，reader.read()
       永挂、无报错、无候选轮换，用户消息永久停在 pending。
       首块等待表用 genParams 的 timeoutSec（requestOnce 同口径）；
       一旦有内容就交给上面的空闲表管，本表到点时发现已有内容就自退。 */
    var FIRST_MS = Math.max(15, (p && p.timeoutSec) || 60) * 1000;
    function armFirst() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (settled) return;
        if (String(out || '').trim()) return;   /* 已有内容：空闲表接管 */
        fail({ stage: 'timeout', error: '连接超时：服务器 ' + Math.round(FIRST_MS / 1000) + ' 秒没有返回首块内容' });
      }, FIRST_MS);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      disarmIdle();
      if (handlers.onError) handlers.onError(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      disarmIdle();
      if (handlers.onDone) handlers.onDone(out, usage);
    }

    /* 流主体读取（首次请求与 stream_options 降级重试共用） */
    function consume(r, ok) {
      if (settled) return null;
      if (!ok) {
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
          /* 非流式退化路同样打 length 截断标记（2026-10-31） */
          if (data && data.choices && data.choices[0] &&
              data.choices[0].finish_reason === 'length') {
            content = (content || '') + TRUNC_NOTE;
            if (handlers.onDelta) handlers.onDelta(TRUNC_NOTE, false);
          }
          if (data && data.usage) usage = data.usage;
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
            /* include_usage：最后一块通常不带 choices、只带 usage */
            if (data.usage) usage = data.usage;
            var ch0 = data.choices && data.choices[0];
            /* 思考分块也是「流还活着」的证据（2026-10-31 截断实锤）：
               reasoning_content / reasoning 喂空闲看门狗 —— 头注注释一直
               是这么声称的，但代码只在 content 分块喂表，思考阶段 15s
               就被当「已说完」收尾落库，正文只剩开头几个字。 */
            var rdelta = ch0 && ch0.delta &&
              (ch0.delta.reasoning_content || ch0.delta.reasoning);
            if (rdelta) armIdle();
            var delta = ch0 && ch0.delta && ch0.delta.content;
            if (delta) {
              out += delta;
              armIdle();                         /* 只有内容分块喂看门狗（keepalive 注释帧不喂） */
              if (handlers.onDelta) handlers.onDelta(delta, true);
            }
            /* finish_reason 是模型说完的权威标志（2026-10-29 实锤：有的
               网关吐完内容既不发 [DONE] 也不关流，还用注释帧保活 ——
               光等 res.done 会永远等不到）。见到就立即收尾落库，
               不等流关闭。length = max_tokens 烧到顶被截断，追加提示
               别静默（思考模型正文只出几个字的主因）。 */
            if (ch0 && ch0.finish_reason) {
              if (ch0.finish_reason === 'length') {
                out += TRUNC_NOTE;
                if (handlers.onDelta) handlers.onDelta(TRUNC_NOTE, true);
              }
              /* 网关还会用注释帧保活，流不会自己关 —— 主动断开 reader 释放连接 */
              try { reader.cancel(); } catch (e) { /* 忽略 */ }
              done();
              return;
            }
          }
          return pump();
        })['catch'](function (err) {
          if (typeof console !== 'undefined') {
            console.log('[api-debug] pump throw: ' + ((err && err.stack) || err));
          }
          fail({ stage: 'network', error: (err && err.message) || String(err) });
        });
      }
      return pump();
    }

    function fire(bodyOv) {
      armFirst();   /* 每次发起（含 stream_options 降级重试）都重挂首块表 */
      return global.fetch(url, {
        method: 'POST',
        headers: requestHeaders(cand.cfg),
        mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined,
        body: bodyFor(cand.cfg, messages, true, bodyOv)
      }).then(function (r) {
        if (!r.ok) {
          /* 接口不认 stream_options（挑刺报 4xx）：去掉用量请求原地重试一次，
             不消耗候选轮换的次数（2026-10-26 用量统计的降级路）。 */
          return r.text().then(function (txt) {
            if (bodyOv && bodyOv.askUsage && /stream_options/i.test(txt)) {
              var ov2 = {};
              for (var k in bodyOv) ov2[k] = bodyOv[k];
              ov2.askUsage = false;
              return fire(ov2);
            }
            fail({ stage: 'http', status: r.status, error: 'HTTP ' + r.status });
            return null;
          })['catch'](function () {
            fail({ stage: 'http', status: r.status, error: 'HTTP ' + r.status });
          });
        }
        return consume(r, true);
      })['catch'](function (err) {
        if (err && err.name === 'AbortError') { fail({ stage: 'aborted', error: '已停止' }); return; }
        fail({ stage: 'network', error: '连不上：网络错误，或接口没有开 CORS' });
      });
    }

    fire(ov);

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

      /* 拉模型列表也要有超时 —— 以前一点兜底都没有，接口不响应时会一直转圈
         （2026-09-23 全链路排查补）。口径跟其它请求一致：60 秒。
         2026-09-23：「api 调用很多时候要到 60s，设置 60s 超时就可以」。 */
      var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;

      global.fetch(url, {
        method: 'GET', headers: headers, mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined
      })
        .then(function (r) {
          return r.text().then(function (txt) {
            if (timer) clearTimeout(timer);
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
          if (timer) clearTimeout(timer);
          var aborted = err && err.name === 'AbortError';
          resolve({ ok: false,
            message: aborted ? '超时：拉取模型列表没有响应' : '连不上：网络错误，或这个接口没有开 CORS',
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
  /* ------------------------- MCP 工具调用循环 -------------------------
     ov.tools 非空时走这里（强制非流式 —— 工具调用要走完整的
     choice.message.tool_calls，流式的增量拼不出这个结构）：
     请求 → 模型要调工具就经 ov.toolCall(name, args) 执行 →
     结果按 role:'tool' 追加 → 再问，最多 TOOL_ROUNDS 轮。
     HTTP/网络失败返回 {ok:false}，交给 runChat 原有的换候选重试；
     工具执行失败不算请求失败 —— 结果以文字回给模型，让它自己兜。
     ov.toolCall 由页面层注入（page-chat 给的是 Sleepy.mcp.callToolByName），
     api.js 不直接依赖 mcp.js —— 层次别倒。 */
  var TOOL_ROUNDS = 6;

  function toolResultText(r) {
    if (r == null) return '';
    if (typeof r === 'string') return r;
    /* MCP 的标准返回是 {content:[{type:'text',text:…},…]} */
    if (Array.isArray(r.content)) {
      return r.content.map(function (c) {
        return (c && c.type === 'text') ? String(c.text || '') : '';
      }).filter(Boolean).join('\n');
    }
    try { return JSON.stringify(r); } catch (e) { return String(r); }
  }

  function requestToolLoop(cand, messages, ov) {
    var msgs = messages.slice();
    var rounds = 0;
    function step() {
      rounds++;
      return requestOnce(cand, msgs, ov).then(function (res) {
        if (!res.ok) return { ok: false, res: res };
        var msg = (res.data && res.data.choices && res.data.choices[0] &&
          res.data.choices[0].message) || null;
        var calls = (msg && msg.tool_calls) || null;
        if (!calls || !calls.length || rounds > TOOL_ROUNDS) {
          return { ok: true, res: res, content: res.content || '' };
        }
        /* 模型这条 tool_calls 消息要先原样进上下文（OpenAI 格式要求），
           tool 结果的 tool_call_id 才有东西可对。 */
        msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        var execs = calls.map(function (call) {
          var fname = (call.function && call.function.name) || '';
          var args = {};
          try { args = JSON.parse((call.function && call.function.arguments) || '{}'); }
          catch (e) { /* 坏参数就传空 —— 让工具侧报错回给模型 */ }
          var p = (ov && typeof ov.toolCall === 'function')
            ? ov.toolCall(fname, args)
            : Promise.resolve({ ok: false, error: '没有可用的工具执行器' });
          return Promise.resolve(p).then(function (r) {
            return { role: 'tool', tool_call_id: call.id || '', content: toolResultText(r) };
          }, function (e) {
            return { role: 'tool', tool_call_id: call.id || '',
              content: '工具执行失败: ' + ((e && e.message) || e) };
          });
        });
        return Promise.all(execs).then(function (results) {
          results.forEach(function (t) { msgs.push(t); });
          return step();
        });
      });
    }
    return step();
  }

  function runChat(messages, handlers, useStream, ov) {
    /* 重试次数（设置 → 副 API → 每组重试次数）：每个候选连续尝试 N 次
       再轮到下一个。1~5，存档坏了/没填兜底 2。 */
    var retryN = Math.max(1, Math.min(5, Math.round(Number(store.get('subRetry'))) || 2));
    var base = candidates(ov && ov.feature);
    /* 个性化（需求 2026-09-22：「模型没接上个性选择」）：
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
      var e0 = (ov && ov.feature)
        ? { stage: 'config', error: '「' + featureLabel(ov.feature) + '」已指定走副 API，但没有启用中的副 API —— 去 设置 → 副 API 检查' }
        : { stage: 'config', error: '还没有可用的模型连接，去 设置 → 模型连接 填 API' };
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
      /* 带工具的请求强制非流式（见 requestToolLoop 的注释） */
      var streamThis = !!useStream && cand.cfg.stream !== false &&
        !(ov && Array.isArray(ov.tools) && ov.tools.length);
      if (handlers.onTry) handlers.onTry(cand, idx, c.length);

      if (streamThis) {
        var started = false;
        handle = streamOnce(cand, messages, {
          onDelta: function (delta, more) {
            started = true;
            if (handlers.onDelta) handlers.onDelta(delta, more);
          },
          /* 第二参 usage 必须在这里接住（v292 修 2026-10-29 丢消息真因）：
             streamOnce 的 onDone 签名是 (out, usage)，usage 只在 streamOnce
             作用域里存在。v270/271 批次把下面那行改成引用 `usage` 却没改
             形参表 → 每次流式成功收尾都抛 ReferenceError: usage is not
             defined，又被 pump 的 .catch(fail) 静默吞掉（settled 已置位）
             —— 回复气泡看得见、永不落库、刷新即蒸发。 */
          onDone: function (text, usage) {
            /* 空流不算成功（2026-10-26 空回维稳）：流走完了但一个字都没吐
               —— 典型是 reasoning 模型把 max_tokens 烧光、content 为空 ——
               按失败换候选重试（此时没出过任何字，重试不会有重复内容；
               出过字的中途失败走 onError，口径不变）。 */
            if (!String(text || '').trim()) {
              lastErr = { stage: 'parse', error: '空响应（流式结束但正文是空的）' };
              tryNext();
              return;
            }
            /* usage：响应自带 token 用量（开了 askUsage 才有）；非流式那边
               第三个参传的是完整 res —— page-chat 统一从 extra.usage /
               extra.data.usage 取 */
            if (handlers.onDone) handlers.onDone(cand, text, usage ? { usage: usage } : null);
          },
          onError: function (err) {
            lastErr = err;
            if (err && err.stage === 'aborted') { if (handlers.onFail) handlers.onFail(c, err); return; }
            if (!started) tryNext();
            else if (handlers.onFail) handlers.onFail(c, err);
          }
        }, ov);
      } else {
        var loopP = (ov && Array.isArray(ov.tools) && ov.tools.length)
          ? requestToolLoop(cand, messages, ov)
          : requestOnce(cand, messages, ov).then(function (res) {
              return res.ok ? { ok: true, res: res, content: res.content || '' } : { ok: false, res: res };
            });
        loopP.then(function (out) {
          if (out.ok) {
            /* 空响应不算成功（2026-10-26 用户报「很多地方空回」）：
               HTTP 200 但正文空 → 记为失败换候选重试，全候选都空才 onFail。
               判的是模型原始输出 —— 合法的「空正文」轮（纯 [撤回] / 纯标签）
               原文非空，不会被误伤。 */
            if (String(out.content || '').trim()) {
              if (handlers.onDone) handlers.onDone(cand, out.content, out.res);
            } else {
              lastErr = { stage: 'parse', error: '空响应（HTTP 200 但模型没吐正文）' };
              tryNext();
            }
          } else {
            lastErr = out.res;
            tryNext();
          }
        }, function (err) {
          /* requestOnce 只 resolve 不 reject（连 fetch 异常都转成 resolve），
             但 executor 里若有同步异常仍会 reject —— 这里不接住的话整条
             链路静默断掉：onDone/onFail 都不触发，调用方（如群声催更
             按钮）会永久停在 disabled。兜住转 onFail。 */
          lastErr = { stage: 'error', error: String((err && err.message) || err || '内部错误') };
          tryNext();
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

      /* 超时归一（2026-09-29）：embed 没有 UI 入口，ov 一般不传；
         传了也不许低于 60 —— 口径与 genParams 一致。 */
      var secs = Math.max(60, Number(ov && ov.timeoutSec) || 60);
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
    __v: 'v292-watchdog',
    normalizeEndpoint: normalizeEndpoint,
    modelsUrl: modelsUrl,
    fetchModels: fetchModels,
    candidates: candidates,
    /* 上下文条数：三处（真聊天 / 预演 / 心声）共用的唯一出口 */
    contextLimit: contextLimit,
    /* 生成参数的内置默认值：页面表单拿它做灰字占位（别再用 store 那份） */
    genDefaults: GEN_DEFAULTS,
    /* 三层回落后的生成参数（纯函数）。导出是为了冒烟能直接打表验
       「超时下限」这类回退 —— 别在别处再写一份回落。 */
    genParams: genParams,
    requestOnce: requestOnce,
    /* 失败原因翻译：所有「把错误显示给用户」的地方都走它，别再各写一份
       `res.message || '请求失败'`（那等于把原因全吞了）。 */
    describeError: describeError,
    streamOnce: streamOnce,
    runChat: runChat,
    /* 副 API 功能分配（2026-10-08 定位重构）：清单/勾选态/功能调用入口 */
    FEATURES: FEATURES,
    featureLabel: featureLabel,
    featureOn: featureOn,
    subCandidates: subCandidates,
    requestForFeature: requestForFeature,
    /* 向量：端点与回落规则都和对话不同，见上面那段注释 */
    embeddingsUrl: embeddingsUrl,
    embed: embed
  };

})(window);