/* ============================================================
   scripts/lib/f2-body-capture.js
   —— 「客户端提交给 fetch 的请求体」采集（fetch 旁路用）· 零依赖

   ⚠️ 措辞口径（2026-10-05 收口统一，全项目一致）：
     这一份证据叫「**客户端提交给 fetch 的请求体**」。
     它是**客户端这一侧提交的输入**，**不声称**服务端已收到、
     **更不声称**模型已消费 —— 那需要响应侧 / 回复正文侧证据。
     旧称「发送瞬间请求体」在字段名与内部变量里仍保留（改名会波及
     落盘样本的字段契约），但**对外表述**一律用上面的口径。

   ★ 为什么单独成文件：这段逻辑要同时在**两个环境**里跑 ——
     · Node 侧：单测直接 require 它做对拍（不启动浏览器）；
     · 页内：fetch 旁路是 `page.evaluate` 里跑的函数，
       **拿不到 require、也没有同步 crypto**。
     写两遍必然漂移 → 抽成一份，Node 用 require，页内用
     `new Function(src)` 注入同一个文本源（见 acceptance 脚本）。

   ---- 边界（用户 2026-10-05 明确）----
     ① 采集必须发生在**调用 origFetch 之前**（不是响应回来后补记）；
     ② 优先 JSON.parse，**只**保存脱敏后的 model/messages/stream/
        max_tokens/temperature 五个字段；
     ③ messages **保留 role 与 content 原文**（不能只落长度或哈希 ——
        只落哈希别人无法判断「到底注了什么」）；
     ④ API key / Authorization / 真实凭据**删掉或脱敏**；
     ⑤ 记 body 的 SHA-256，并**明确标注**它是「客户端提交给 fetch 的请求体」的哈希；
     ⑥ 响应侧 finish_reason / usage / reasoning_content 采集**全部保留**；
     ⑦ 采集失败**不许静默伪造** → 记 bodyCaptureError，messages 留 null。

   ⚠️ ⑦ 是最容易造假的地方：body 拿不到时若悄悄填一个空 messages，
     下游会以为「模型确实收到了空的」。**缺失必须显式缺失。**
   ============================================================ */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) { root.F2BodyCapture = mod; }
}(typeof globalThis !== 'undefined' ? globalThis
  : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  /* ============================================================
     1. 纯 JS 同步 SHA-256
     ★ 为什么不用 node:crypto：页内没有。
     ★ 为什么不用 crypto.subtle.digest：**是异步的**，
       而 fetch 旁路里采集必须**同步**完成（要在 origFetch 之前）。
     ============================================================ */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

  /* UTF-8 编码：手写而不用 TextEncoder ——
     vm 沙箱里 TextEncoder 不在白名单内，页内也有旧环境。
     ★ 对未配对代理项按 U+FFFD 处理（与 Node Buffer 一致）。 */
  function utf8Bytes(s) {
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); continue; }
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
            0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++; continue;
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) { c = 0xfffd; }   /* 落单代理 */
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function sha256hex(str) {
    var bytes = utf8Bytes(String(str));
    var bitLenHi = Math.floor(bytes.length / 536870912);   /* (len*8) >>> 32 */
    var bitLenLo = (bytes.length << 3) >>> 0;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255,
      (bitLenHi >>> 8) & 255, bitLenHi & 255,
      (bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255,
      (bitLenLo >>> 8) & 255, bitLenLo & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var off, i, t, t1, t2, a, b, c, d, e, f, g, hh, s0, s1, ch, maj;
    for (off = 0; off < bytes.length; off += 64) {
      for (i = 0; i < 16; i++) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
          (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        t = w[i - 15];
        s0 = (((t >>> 7) | (t << 25)) ^ ((t >>> 18) | (t << 14)) ^ (t >>> 3)) >>> 0;
        t = w[i - 2];
        s1 = (((t >>> 17) | (t << 15)) ^ ((t >>> 19) | (t << 13)) ^ (t >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      a = H[0]; b = H[1]; c = H[2]; d = H[3];
      e = H[4]; f = H[5]; g = H[6]; hh = H[7];
      for (i = 0; i < 64; i++) {
        s1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^
          ((e >>> 25) | (e << 7))) >>> 0;
        ch = ((e & f) ^ (~e & g)) >>> 0;
        t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
        s0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^
          ((a >>> 22) | (a << 10))) >>> 0;
        maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        t2 = (s0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + hh) >>> 0;
    }
    return H.map(function (x) {
      return ('0000000' + x.toString(16)).slice(-8);
    }).join('');
  }

  /* ============================================================
     2. 凭据脱敏
     ------------------------------------------------------------
     ★ 三条腿（2026-10-05 补齐，原先只有后两条）：
       ① **已知凭据精确匹配** —— 调用方把这一轮真实用的 key 传进来
          （opts.knownSecrets）。这是最可靠的一条：测试里用的是
          自己造的固定串，形状正则未必覆盖（`stub-trace-key-not-real`
          既不是 sk- 也不够长，纯形状匹配会漏）。
       ② **键名**命中 → 整个值替换（不保留任何片段）。
       ③ **取值形状**（sk-… / Bearer … / JWT）→ 即使键名无辜也打掉。

     ★★ 统一用「改动账本」记录**实际发生的替换**，而不是让调用方
        靠「字段名匹配」去推断有没有脱敏（用户 2026-10-05 明确）。
        账本每条带：位置（字段路径 / 'url' / '错误文本'）、原因、命中数。
        没有任何改动时账本为**空数组** —— 「空数组」本身就是证据。
     ============================================================ */
  var SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|auth|session[_-]?key|access[_-]?key|private[_-]?key|refresh[_-]?token|bearer)/i;
  /* 取值形状：OpenAI 风格 sk-…、Bearer …、JWT */
  var SECRET_VAL_RE = /(\bsk-[A-Za-z0-9._-]{8,})|(\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*)|(\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/g;
  /* URL 里的凭据 query：?key=… / ?access_token=… */
  var SECRET_QUERY_RE = /([?&](?:key|api_key|apikey|token|access_token|refresh_token|secret|password|auth|authorization)=)([^&#]*)/gi;

  function maskSecret(v) {
    var s = String(v == null ? '' : v);
    if (!s) return '';
    var h = sha256hex(s).slice(0, 8);
    return '***已脱敏(sha8=' + h + ')***';
  }
  function has(own, k) { return Object.prototype.hasOwnProperty.call(own, k); }

  /* ---------- 改动账本 ---------- */
  function newLedger() { return { 改动: [], 计数: 0 }; }
  function noteChange(ledger, where, why, n) {
    ledger.计数 += (n || 1);
    ledger.改动.push({ 位置: where, 原因: why, 命中: n || 1 });
  }
  /* 账本 → 记录字段。**空改动就是空数组**，不塌成布尔。 */
  function ledgerFields(ledger) {
    return {
      脱敏改动数: ledger.计数,
      脱敏改动: ledger.改动,
      已脱敏: ledger.计数 > 0
    };
  }

  /* ---------- 字符串脱敏（已知凭据 + 形状）----------
     opts.knownSecrets 走**字面精确匹配**（先跑，避免形状正则把
     已知串截成半个 token）。 */
  function scrubString(s, known) {
    var led = newLedger();
    var out = String(s == null ? '' : s);
    if (!out) return { text: out, 命中: 0, 账本: led };
    var n = 0;
    (known || []).forEach(function (sec) {
      if (!sec || String(sec).length < 4) return;   /* 太短的别乱替换 */
      var needle = String(sec);
      var parts = out.split(needle);
      if (parts.length > 1) {
        n += parts.length - 1;
        out = parts.join(maskSecret(needle));
      }
    });
    if (n) noteChange(led, '文本', '已知凭据精确匹配', n);
    var m = 0;
    out = out.replace(SECRET_VAL_RE, function () { m++; return maskSecret(arguments[0]); });
    if (m) noteChange(led, '文本', '凭据形状匹配', m);
    return { text: out, 命中: n + m, 账本: led };
  }

  /* ---------- URL 脱敏（query 凭据 + 已知凭据）---------- */
  function scrubUrl(u, known) {
    var led = newLedger();
    var out = String(u == null ? '' : u);
    if (!out) return { text: out, 账本: led };
    var n = 0;
    out = out.replace(SECRET_QUERY_RE, function (m, pre) {
      n++; return pre + '***';
    });
    if (n) noteChange(led, 'url', 'URL query 凭据', n);
    var knownN = 0;
    (known || []).forEach(function (sec) {
      if (!sec || String(sec).length < 4) return;
      var parts = out.split(String(sec));
      if (parts.length > 1) { knownN += parts.length - 1; out = parts.join('***'); }
    });
    if (knownN) noteChange(led, 'url', '已知凭据精确匹配', knownN);
    return { text: out, 账本: led };
  }

  /* ---------- 深度脱敏（结构化 content / 嵌套对象）----------
     ⚠️ **只动凭据本身**，其余字符逐字保留 ——
        脱敏会改掉「模型当时看到了什么」，所以必须最小化改动并记账。 */
  function redactDeep(v, known, path, led, depth) {
    depth = depth || 0;
    path = path || '';
    led = led || newLedger();
    if (depth > 12) return '[深度超限]';
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      var r = scrubString(v, known);
      if (r.命中) {
        noteChange(led, path || '(根)', '字符串内凭据', r.命中);
        r.账本.改动.forEach(function (c) { led.改动.push(c); });
      }
      return r.text;
    }
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      return v.map(function (x, i) {
        return redactDeep(x, known, path + '[' + i + ']', led, depth + 1);
      });
    }
    var out = {};
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var here = path ? path + '.' + k : k;
      if (SECRET_KEY_RE.test(k)) {
        out[k] = maskSecret(v[k]);
        noteChange(led, here, '凭据字段名', 1);
        continue;
      }
      /* 键名像 URL 的，值也要走 URL 脱敏（?key= 在 image_url.url 里很常见） */
      if (typeof v[k] === 'string' && /url$/i.test(k)) {
        var u = scrubUrl(v[k], known);
        out[k] = u.text;
        if (u.账本.计数) {
          noteChange(led, here, 'URL 内凭据', u.账本.计数);
          u.账本.改动.forEach(function (c) { led.改动.push(c); });
        }
        continue;
      }
      out[k] = redactDeep(v[k], known, here, led, depth + 1);
    }
    return out;
  }

  /* 错误文本脱敏（bodyCaptureError / parseError 会带上原始串片段，
     那里也可能含凭据 —— 用户 2026-10-05 点名要覆盖）。 */
  function scrubError(msg, known) {
    var r = scrubString(String(msg == null ? '' : msg), known);
    return r;
  }

  /* ============================================================
     3. 请求体采集
     ★ 只保留这 5 个字段（用户 2026-10-05 点名）+ messages 全文。
     ★ bodyRaw 字符串**逐字保留**（脱敏只作用于下面那份结构化摘要）——
       哈希的对象必须是「真正发出去的那串」，脱敏过的副本另存。
     ============================================================ */
  var KEEP_FIELDS = ['model', 'stream', 'max_tokens', 'temperature'];

  function pickFields(obj) {
    var out = {};
    for (var i = 0; i < KEEP_FIELDS.length; i++) {
      var k = KEEP_FIELDS[i];
      out[k] = has(obj, k) ? obj[k] : null;
    }
    return out;
  }

  /* 取出「真正会被 fetch 发出去的 body 字符串」。
     ⚠️ init.body 可能是 string，也可能没有（GET/无体）。
        传 Request 对象时 body 是流，**同步读不到** →
        这种情况必须走 bodyCaptureError，不许编一个空 body 出来。 */
  function rawBodyOf(input, init) {
    if (init && has(init, 'body') && init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') return init.body;
      /* 非字符串体（Blob/FormData/URLSearchParams…）：能同步定长的才转，
         转不了就如实报缺失 —— 生产用的是 JSON 字符串。 */
      if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
        return init.body.toString();
      }
      return null;
    }
    return null;
  }

  /* 主入口：对 init.body 做「发送瞬间」采集。纯函数、零副作用。
     opts.knownSecrets —— 本轮真实使用的凭据字面（精确匹配用）。 */
  function captureRequestBody(input, init, opts) {
    opts = opts || {};
    var known = opts.knownSecrets || [];
    var led = newLedger();
    var out = {
      采集时刻: '调用 origFetch 之前',
      bodySHA256: null,
      bodySHA256含义: '这是**客户端提交给 fetch 的请求体**（init.body 原始字符串）的 SHA-256，' +
        '不是任何装配快照的哈希。⚠️ 它是客户端这一侧提交的**输入**，' +
        '**不声称**服务端已收到、更不声称模型已消费。',
      body字节数: null,
      脱敏改动数: 0,
      脱敏改动: [],
      已脱敏: false,
      model: null, messages: null, stream: null,
      max_tokens: null, temperature: null,
      bodyTopKeys: null,
      bodyCaptureError: null
    };
    var raw = rawBodyOf(input, init);
    if (raw === null) {
      out.bodyCaptureError = init && has(init, 'body')
        ? 'init.body 存在但不是可同步读取的字符串（可能是 Request 流 / Blob / FormData）'
        : 'init.body 不存在（该 fetch 无请求体）';
      out.脱敏改动数 = led.计数; out.脱敏改动 = led.改动; out.已脱敏 = led.计数 > 0;
      return out;
    }
    /* 哈希对**原始串**算，且必须在任何脱敏之前 */
    out.bodySHA256 = sha256hex(raw);
    out.body字节数 = utf8Bytes(raw).length;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      /* 解析失败 → 记原文长度 + 错误，**不填任何字段**（不许伪造）。
         ⚠️ 错误文本本身也要过脱敏（可能带上原始片段里的凭据）。 */
      var e1 = scrubError('JSON.parse 失败：' + String((e && e.message) || e), known);
      out.bodyCaptureError = e1.text;
      led.改动.push.apply(led.改动, e1.账本.改动);
      led.计数 += e1.账本.计数;
      out.body原始长度 = raw.length;
      out.脱敏改动数 = led.计数; out.脱敏改动 = led.改动; out.已脱敏 = led.计数 > 0;
      return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      out.bodyCaptureError = 'init.body 解析后不是 JSON 对象（是 ' +
        (Array.isArray(parsed) ? '数组' : typeof parsed) + '）';
      out.body原始长度 = raw.length;
      out.脱敏改动数 = led.计数; out.脱敏改动 = led.改动; out.已脱敏 = led.计数 > 0;
      return out;
    }

    out.bodyTopKeys = Object.keys(parsed);
    var keep = pickFields(parsed);
    out.model = keep.model;
    out.stream = keep.stream;
    out.max_tokens = keep.max_tokens;
    out.temperature = keep.temperature;

    /* ★ messages：保留 role + content 原文（要求 ③）。
       逐条脱敏并**逐条记账** —— 读者必须知道这段不是逐字原文。 */
    if (Array.isArray(parsed.messages)) {
      var msgs = [];
      for (var i = 0; i < parsed.messages.length; i++) {
        var m = parsed.messages[i] || {};
        var entry = { role: m.role == null ? null : m.role, content: null };
        if (typeof m.content === 'string') {
          var sc = scrubString(m.content, known);
          entry.content = sc.text;
          if (sc.命中) {
            noteChange(led, 'messages[' + i + '].content', '凭据', sc.命中);
            sc.账本.改动.forEach(function (c) { led.改动.push(c); });
          }
        } else if (m.content !== undefined) {
          /* 多模态等**结构化** content：深脱敏（键名/URL/字符串三条腿），
             仍是**内容**本身，不退化成长度或摘要。 */
          entry.content = redactDeep(m.content, known, 'messages[' + i + '].content', led, 0);
        }
        /* content 里可能混着 name/tool_calls 等 —— 一律不落，
           落它们就等于把工具协议一起抄进来，超出「请求体证据」的范围。 */
        msgs.push(entry);
      }
      out.messages = msgs;
      out.messages条数 = msgs.length;
    } else {
      out.messages = null;
      out.bodyCaptureError = 'init.body 里没有 messages 数组（是 ' +
        (has(parsed, 'messages') ? typeof parsed.messages : '缺字段') + '）';
    }
    out.脱敏改动数 = led.计数;
    out.脱敏改动 = led.改动;
    out.已脱敏 = led.计数 > 0;
    return out;
  }

  /* ============================================================
     4. fetch 旁路安装
     ★ 只旁路记录，**不改变任何返回内容**（读 clone，原 body 透传生产）。
     ★ 请求侧采集在**同步**段完成（origFetch 之前）；
       响应侧采集仍在 .then 里（要求 ⑥），两侧互不影响。

     ---- 三条「不许静默」的红线（2026-10-05）----
       ① **请求记录写入失败 → 不得静默续发**。
          写不进去 = 这一轮的请求体证据**永远丢了**；继续发 = 可能白花钱却没有证据。
          所以把 fetch 换成 reject，让生产链按失败处理（调度器据此停机）。
       ② **请求被拒绝 / 超时（fetch 自己 reject）→ 仍要留下请求侧记录**。
          「发出去了但没回来」时**费用状态未知**（可能已计费、可能被网关丢弃）——
          保留调用与失败证据，不能因为没响应就抹掉。
       ③ **返回已有响应时，旁路记录异常不得把成功响应改成失败**。
          响应读取失败（clone().text() 抛）时**原样返回 r** ——
          生产代码已经拿到成功响应，旁路没有资格改写它。
     ---- 与停机调度的接线：见文件末尾 stopKindForSend ----
     ============================================================ */
  function installFetchBypass(win, opts) {
    opts = opts || {};
    var known = opts.knownSecrets || [];
    /* 记录写入失败时的回调（可注入观测器；不注入就只靠 reject 表达） */
    var onRecordError = typeof opts.onRecordError === 'function' ? opts.onRecordError : null;

    /* ------------------------------------------------------------
       全局模型请求预算闸（2026-10-05 · opt-in，默认**关闭**）
       ------------------------------------------------------------
       ★ 为什么必须设在 fetch 这一层，而不是只靠调度器：
         `api.js` 有 4 个出口（requestOnce / streamOnce / fetchModels /
         embed），另有 imggen.js、page-settings.js、page-subapi.js、
         tts.js 各自也发 fetch；而 `runChat` 把候选 × retryN
         （默认 2、最多 5）展开 —— **单轮就可能扇出多次**。
         ⇒ 自动开场 / 重试 / 回退 / 后台调用全都从 `window.fetch` 过，
           在这里设闸才**无处可逃**。
       ★ 计数口径：**除本地页面来源（127.0.0.1 / localhost / file:）之外的
         一切出站请求**都算模型请求。
         ⚠️ 不能只匹配「当前配的那个端点」—— 万一有别处后台调用
           指向另一个模型端点，就会漏计。
       ★ 超预算 ⇒ 直接 reject：让生产链按失败处理，
         绝不「悄悄放过」而让预算失控。
       ★ 默认关闭 ⇒ 既有测试（零网络桩）行为完全不变。
       ------------------------------------------------------------ */
    var budget = opts.budget || null;
    if (budget) {
      budget.limit = budget.limit == null ? 1 : budget.limit;
      budget.used = 0;
      budget.allowed = [];
      budget.rejected = [];
    }
    function isLocalUrl(u) {
      return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(String(u)) ||
        /^file:/i.test(String(u));
    }
    function budgetAllows(u) {
      if (!budget) return true;
      if (isLocalUrl(u)) return true;          /* 页面自己的资源，不算 */
      if (budget.used >= budget.limit) {
        budget.rejected.push({ url: String(u), 已用: budget.used });
        return false;
      }
      budget.used++;
      budget.allowed.push({ url: String(u), 第几次: budget.used });
      return true;
    }

    var origFetch = win.fetch;
    if (typeof origFetch !== 'function') throw new Error('installFetchBypass：win.fetch 不是函数');
    if (origFetch.__f2BodyBypass) return origFetch;   /* 幂等：别包两层 */

    /* 把一条响应记录写进 __HTTP；写不进去只**如实标记**，绝不抛 ——
       ★ 红线③：记录异常没有资格把生产已经拿到的成功响应改成失败。 */
    function pushHttp(rec) {
      try { win.__HTTP.push(rec); }
      catch (pushErr) {
        rec.记录写入失败 = '响应记录写入失败：'
          + String((pushErr && pushErr.message) || pushErr);
        if (onRecordError) {
          try { onRecordError(rec.记录写入失败, rec); } catch (e) { /* 观测器自己炸了也不改写这里 */ }
        }
      }
    }

    function wrapped(input, init) {
      var rawUrl = String((input && input.url) || input || '');
      /* ★ 预算闸在最前面：超预算**连采集都不做**，直接 reject。
         理由 —— 采集一次也是对「这一次调用」记账的动作，
         已经被拒绝的调用不该留下「像是发过」的记录。 */
      if (!budgetAllows(rawUrl)) {
        return Promise.reject(new Error(
          '全局模型请求预算已用尽（上限 ' + budget.limit + ' 次），本次调用被拒绝：' +
          scrubUrl(rawUrl, known).text));
      }
      var u = scrubUrl(rawUrl, known);
      var url = u.text;               /* ★ URL 也要脱敏后才进记录 */
      var t0 = win.Date.now();
      /* ---------- 请求侧：同步采集，必须早于 origFetch ---------- */
      var send;
      try {
        send = captureRequestBody(input, init, { knownSecrets: known });
      } catch (e) {
        /* 采集本身抛错也必须留痕，不许静默 */
        send = { bodyCaptureError: '采集函数抛错：' + String((e && e.message) || e),
          bodySHA256: null, messages: null, model: null,
          脱敏改动数: 0, 脱敏改动: [], 已脱敏: false };
      }
      send.url = url;
      /* URL 上的改动并进同一本账（统一口径：不靠字段名推断有没有脱敏） */
      u.账本.改动.forEach(function (c) { send.脱敏改动.push(c); send.脱敏改动数++; });
      send.已脱敏 = send.脱敏改动数 > 0;

      /* ---------- 红线①：记录写不进去 → 不许静默续发 ---------- */
      try {
        win.__SEND.push(send);
      } catch (pushErr) {
        var why = '发送瞬间记录写入失败：' + String((pushErr && pushErr.message) || pushErr);
        send.记录写入失败 = why;
        if (onRecordError) {
          try { onRecordError(why, send); } catch (e) { /* 同上 */ }
        }
        return Promise.reject(new Error(why));   /* 让生产链走失败分支，调度器据此停机 */
      }

      return origFetch.apply(this, arguments).then(function (r) {
        /* ---------- 响应侧：全部保留（要求 ⑥）---------- */
        var rec = { url: url, ms: win.Date.now() - t0, status: r.status };
        /* 请求侧摘要挂到同一条记录上，按 url 对齐 */
        rec.发送瞬间 = send;
        /* ---------- 红线③：任何记录异常都**不得改写结果**，原样返回 r ---------- */
        if (!r || typeof r.clone !== 'function') {
          rec.responseCaptureError = '响应对象没有 clone()（读不到副本）';
          pushHttp(rec);
          return r;
        }
        var cloned;
        try { cloned = r.clone(); }
        catch (cloneErr) {
          /* clone() 本身就抛（如 body 已消耗）—— 同样不能改写结果 */
          var ce = scrubError('clone() 抛错：'
            + String((cloneErr && cloneErr.message) || cloneErr), known);
          rec.responseCaptureError = ce.text;
          pushHttp(rec);
          return r;
        }
        return cloned.text().then(function (txt) {
          try {
            var d = JSON.parse(txt);
            var ch = d.choices && d.choices[0];
            var msg = ch && ch.message;
            rec.finish_reason = ch ? (ch.finish_reason === undefined ? null : ch.finish_reason) : null;
            rec.usage = d.usage || null;
            /* ⚠️ 字段缺失必须记成「接口未提供」（null / has_*=false），
               **绝不填 0** —— 0 与「没给」是两件事，填 0 会让归因结论反向。 */
            rec.has_reasoning = !!(msg &&
              Object.prototype.hasOwnProperty.call(msg, 'reasoning_content'));
            rec.reasoning_len = (msg && typeof msg.reasoning_content === 'string')
              ? msg.reasoning_content.length : null;
            rec.content_len = (msg && typeof msg.content === 'string')
              ? msg.content.length : null;
            rec.topKeys = Object.keys(d);
            rec.choiceKeys = ch ? Object.keys(ch) : null;
            rec.msgKeys = msg ? Object.keys(msg) : null;
          } catch (e) {
            var pe = scrubError(String((e && e.message) || e), known);
            rec.parseError = pe.text;
          }
          pushHttp(rec);
          return r;   /* ★ 原响应对象，一个字都没改 */
        }, function (readErr) {
          /* 读副本失败：**不吞掉生产已经拿到的响应**（用户 2026-10-05 点名） */
          var re = scrubError('响应副本读取失败：'
            + String((readErr && readErr.message) || readErr), known);
          rec.responseCaptureError = re.text;
          pushHttp(rec);
          return r;
        });
      }, function (fetchErr) {
        /* ---------- 红线②：fetch 自己 reject（网络失败 / 超时）----------
           请求侧记录**已经写进去了**（上面 push 过），这里只补失败原因。
           ⚠️ 绝不能因为「没拿到响应」就把请求记录删掉 ——
           那时**费用状态未知**，而调用与失败证据本身是确定存在的。 */
        var fe = scrubError('fetch 失败：'
          + String((fetchErr && fetchErr.message) || fetchErr), known);
        send.fetchError = fe.text;
        send.fetchErrorName = (fetchErr && fetchErr.name) || null;
        return Promise.reject(fetchErr);   /* ★ 原样抛给生产，不改写语义 */
      });
    }
    wrapped.__f2BodyBypass = true;
    win.__SEND = [];
    win.__HTTP = [];
    /* 预算报告挂到 window，Node 侧在轮次结束后读回（不在页内落盘） */
    win.__BUDGET = budget;
    win.fetch = wrapped;
    return wrapped;
  }

  /* ============================================================
     5. 与停机调度的接线
     ------------------------------------------------------------
     ★ 为什么要单独给一个函数：旁路只能**如实报告**发生了什么，
       「这个状态要不要停整跑」是**调度层**的决定。
       混进旁路就成了「旁路替调度器做判断」——
       那正是「守卫 return 掉业务回调」那类 bug 的温床。
     ★ 返回值语义与 acceptance 的 hardStopKind 对齐：
       'perm' 硬停 · 'net' 网络/超时 · 'link' 采集异常（数据不可信）· null 不停
     ============================================================ */
  function stopKindForSend(send) {
    if (!send) return null;
    /* 记录写不进去 = 这一轮的发送证据永久缺失 → 继续跑只会产出
       「无法核验」的样本 → 归为 link（采集异常，硬停）。 */
    if (send.记录写入失败) return 'link';
    /* fetch 自己失败（网络 / 超时）—— 生产已按 stage 归因，
       旁路只标记，不在这里替调度器决定停不停。 */
    if (send.fetchErrorName === 'AbortError') return 'net';
    /* 采集失败但记录还在：证据存在（知道自己没采到），可继续。
       这里**不**判停 —— 停不停是调度层的口径问题。 */
    return null;
  }

  return {
    sha256hex: sha256hex,
    utf8Bytes: utf8Bytes,
    maskSecret: maskSecret,
    scrubString: scrubString,
    scrubUrl: scrubUrl,
    scrubError: scrubError,
    redactDeep: redactDeep,
    captureRequestBody: captureRequestBody,
    installFetchBypass: installFetchBypass,
    stopKindForSend: stopKindForSend,
    KEEP_FIELDS: KEEP_FIELDS,
    SECRET_KEY_RE: SECRET_KEY_RE
  };
}));
