/* ============================================================
   video-understand.js — 把视频「读」给角色听
   ------------------------------------------------------------
   用户在聊天里发一段视频 → 存进图库（kind:'video'）→ 聊天里可播放。
   这条模块负责「读懂」那一层：
     1. 从图库取出视频 blob，用 <video> 抽若干关键帧（canvas → dataURL）
        帧数**自适应**：每秒 1 帧，下限 6、上限 24 —— 固定 6 帧会漏掉
        中间的情节（快速动作、长视频、对话密集的内容），抽密一点才读得全。
     2. 同时把**音轨**抽出来（解码 → 16k 单声道 WAV → base64），
        对话/旁白/环境声能补回画面丢掉的大量信息。
     3. 把「帧 + 音频 + 一段中文说明指令」组装成 OpenAI 兼容的多模态请求
        （image_url + input_audio 内容块）。
     4. 拿到文字描述后，回写进那条消息的 caption 字段，并让角色据此回应。
   没配「视频理解 API」时优雅跳过：视频照发照播，只是角色读不到内容。
   密钥只在本机浏览器，请求直连用户填的 endpoint（OpenAI 兼容格式）。

   ⚠️ 端点兼容性：不是所有 OpenAI 兼容网关都吃 input_audio。带音频的请求
      失败时会**自动降级重试一次**（只发画面），所以填只支持图片的视觉模型
      也能用，只是听不到声音。
   ============================================================ */

(function (global) {
  'use strict';
  var Sleepy = (global.Sleepy = global.Sleepy || {});

  var PROMPT = '这是一段视频的若干按时间顺序排列的关键帧，以及它的原声音频。' +
    '请结合画面和声音，用简体中文描述这段视频的内容与发生的事：' +
    '场景在哪、有谁、做了什么、情绪氛围如何；' +
    '如果音频里有人说话或有字幕，请尽量把关键台词/字幕转写出来。' +
    '按时间顺序，客观描述，控制在 300 字以内。';

  /* 接口地址补成 /chat/completions：用户填到 /v1 即可，若已经带全路径也不重复拼。 */
  function chatUrl(base) {
    base = String(base || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  /* 抽帧。opts: { min, max } —— 每秒 1 帧，再夹到 [min, max] 之间。
     全程超时兜底，失败返回空数组（上层据此跳过解读）。 */
  function extractFrames(blob, opts) {
    opts = opts || {};
    var minN = opts.min || 6;
    var maxN = opts.max || 24;
    return new Promise(function (resolve) {
      var done = false;
      var frames = [];
      var url = '';
      function finish() {
        if (done) return;
        done = true;
        try { if (url) global.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
        resolve(frames);
      }
      var v = document.createElement('video');
      v.muted = true; v.preload = 'metadata'; v.playsInline = true;
      try { url = global.URL.createObjectURL(blob); } catch (e) { finish(); return; }
      v.src = url;

      global.setTimeout(finish, 20000); // 安全兜底：抽帧卡住也不至于永远挂着

      v.addEventListener('error', function () { finish(); });
      v.addEventListener('loadedmetadata', function () {
        var dur = v.duration;
        if (!isFinite(dur) || dur <= 0) { finish(); return; }
        /* 每秒 1 帧，再夹上下限 */
        var n = Math.round(dur);
        n = Math.max(minN, Math.min(maxN, n));
        if (n > dur) n = Math.max(1, Math.floor(dur));
        var i = 0;
        v.addEventListener('seeked', function () {
          try {
            var cw = 480;
            var ratio = (v.videoWidth && v.videoHeight) ? (v.videoHeight / v.videoWidth) : 0.5625;
            var ch = Math.max(1, Math.round(cw * ratio));
            var c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            c.getContext('2d').drawImage(v, 0, 0, cw, ch);
            frames.push(c.toDataURL('image/jpeg', 0.72));
          } catch (e) { /* 这帧废了，略过 */ }
          i++;
          if (i < n) { try { v.currentTime = dur * (i + 0.5) / n; } catch (e) { finish(); } }
          else finish();
        });
        try { v.currentTime = dur * 0.5 / n; } catch (e) { finish(); }
      });
    });
  }

  /* 抽音轨：解码 → 降到 16k 单声道 → 编成 WAV → base64。
     长视频只取前 maxSec 秒（解码整段太吃内存，也没必要）。
     失败/不支持一律返回空串 —— 上层据此只发画面。 */
  function extractAudioWav(blob, maxSec) {
    return new Promise(function (resolve) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC || !blob) { resolve(''); return; }
      var ctx;
      try { ctx = new AC(); } catch (e) { resolve(''); return; }
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        try { ctx.close(); } catch (e) { /* 忽略 */ }
        resolve(v || '');
      }
      global.setTimeout(function () { done(''); }, 25000);
      var fr = new FileReader();
      fr.onerror = function () { done(''); };
      fr.onload = function () {
        var okFn = function (buf) {
          try { done(encodeWav(buf, maxSec || 60)); } catch (e) { done(''); }
        };
        var badFn = function () { done(''); };
        try {
          var p = ctx.decodeAudioData(fr.result, okFn, badFn);
          if (p && p.then) p.then(okFn, badFn);
        } catch (e) { badFn(); }
      };
      try { fr.readAsArrayBuffer(blob); } catch (e) { done(''); }
    });
  }

  function encodeWav(buf, maxSec) {
    var sr = buf.sampleRate;
    var target = 16000;
    var maxLen = Math.min(buf.length, Math.floor((maxSec || 60) * sr));
    var ratio = sr / target;
    var outLen = Math.floor(maxLen / ratio);
    if (outLen < 200) return '';          /* 太短，没什么可听的 */
    var pcm = new Int16Array(outLen);
    var chs = buf.numberOfChannels;
    var ch0 = buf.getChannelData(0);
    var ch1 = chs > 1 ? buf.getChannelData(1) : null;
    for (var i = 0; i < outLen; i++) {
      var idx = Math.min(maxLen - 1, Math.floor(i * ratio));
      var s = ch0[idx];
      if (ch1) s = (s + ch1[idx]) / 2;    /* 混成单声道 */
      pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
    }
    return pcmToWavBase64(pcm, target);
  }

  /* 16-bit PCM → WAV 容器 → base64（不带 data: 前缀，按各家 input_audio 的口径） */
  function pcmToWavBase64(pcm, sampleRate) {
    var bytes = pcm.length * 2;
    var buf = new global.ArrayBuffer(44 + bytes);
    var dv = new global.DataView(buf);
    var o = 0;
    function str(s) { for (var i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); }
    str('RIFF'); dv.setUint32(o, 36 + bytes, true); o += 4;
    str('WAVE'); str('fmt ');
    dv.setUint32(o, 16, true); o += 4;
    dv.setUint16(o, 1, true); o += 2;              /* PCM */
    dv.setUint16(o, 1, true); o += 2;              /* 单声道 */
    dv.setUint32(o, sampleRate, true); o += 4;
    dv.setUint32(o, sampleRate * 2, true); o += 4; /* byteRate */
    dv.setUint16(o, 2, true); o += 2;              /* blockAlign */
    dv.setUint16(o, 16, true); o += 2;             /* 位深 */
    str('data'); dv.setUint32(o, bytes, true); o += 4;
    for (var j = 0; j < pcm.length; j++) { dv.setInt16(o, pcm[j], true); o += 2; }
    var u8 = new global.Uint8Array(buf);
    var bin = '';
    var CH = 0x8000;
    for (var k = 0; k < u8.length; k += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(k, Math.min(k + CH, u8.length)));
    }
    return global.btoa(bin);
  }

  /* OpenAI 兼容多模态请求：帧作 image_url，音频作 input_audio，附中文说明指令。
     支持图片输入的视觉/多模态模型（Gemini / Qwen-Omni / GLM-4.5V…）都能接。 */
  function callApi(cfg, frames, audioB64) {
    var url = chatUrl(cfg.baseUrl);
    if (!url) return Promise.reject(new Error('接口地址为空'));
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    var content = [{ type: 'text', text: PROMPT }];
    frames.forEach(function (d) { content.push({ type: 'image_url', image_url: { url: d } }); });
    if (audioB64) {
      content.push({ type: 'input_audio', input_audio: { data: audioB64, format: 'wav' } });
    }
    return global.fetch(url, {
      method: 'POST',
      headers: headers,
      mode: 'cors',
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: content }],
        stream: false
      })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; });
    }).then(function (res) {
      if (!res.ok) {
        var msg = (res.json && res.json.error && res.json.error.message) || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      var c = res.json && res.json.choices && res.json.choices[0] &&
        res.json.choices[0].message && res.json.choices[0].message.content;
      if (!c) throw new Error('接口没有返回可读内容');
      return String(c).trim();
    });
  }

  /* 给聊天页用的入口：分析完把文字 patch 进消息，并让角色据此回应。
     hooks: { patchMessage, requestReply, toast } —— 由 page-chat 把页面内的闭包传进来，
     这样本模块不用反向依赖聊天页，也不碰全局状态。 */
  function analyzeAndInject(chatId, msgId, mediaId, hooks) {
    hooks = hooks || {};
    var cfg = (Sleepy.singleApi && Sleepy.singleApi.cfgOf) ? Sleepy.singleApi.cfgOf('video') : null;
    if (!cfg || !cfg.model) {
      if (hooks.toast) hooks.toast('没配视频理解 API，视频已发但暂不解读', 'warn');
      return;
    }
    if (!Sleepy.media || !Sleepy.media.get) return;
    Sleepy.media.get(mediaId).then(function (rec) {
      if (!rec || !rec.blob) { if (hooks.toast) hooks.toast('读不到视频本体', 'warn'); return; }
      var framesP = extractFrames(rec.blob, { min: 6, max: 24 });
      var audioP = extractAudioWav(rec.blob, 60);
      return Promise.all([framesP, audioP]).then(function (r) {
        var frames = r[0];
        var audioB64 = r[1];
        if (!frames.length && !audioB64) {
          if (hooks.toast) hooks.toast('视频抽不出画面也抽不出声音，跳过解读', 'warn');
          return;
        }
        var withAudio = !!audioB64;
        return callApi(cfg, frames, audioB64).then(null, function (err) {
          /* 端点不认 input_audio（多数 OpenAI 兼容网关只吃图）→ 降级只发画面重试一次 */
          if (withAudio) return callApi(cfg, frames, '');
          throw err;
        }).then(function (text) {
          if (hooks.patchMessage) hooks.patchMessage(chatId, msgId, { caption: text });
          if (hooks.requestReply) hooks.requestReply({});
          if (hooks.toast) hooks.toast('TA 看完视频了', 'ok');
        }, function (err) {
          if (hooks.toast) hooks.toast('视频解读失败：' + ((err && err.message) || err), 'warn');
        });
      });
    }, function () {
      if (hooks.toast) hooks.toast('读不到视频本体', 'warn');
    });
  }

  Sleepy.videoUnderstand = {
    analyzeAndInject: analyzeAndInject,
    extractFrames: extractFrames,
    extractAudioWav: extractAudioWav
  };
})(typeof window !== 'undefined' ? window : this);
