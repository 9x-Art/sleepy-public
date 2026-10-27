/* ============================================================
   video-understand.js — 把视频「读」给角色听
   ------------------------------------------------------------
   用户在聊天里发一段视频 → 存进图库（kind:'video'）→ 聊天里可播放。
   这条模块负责「读懂」那一层：
     1. 从图库取出视频 blob，用 <video> 抽若干关键帧（canvas → dataURL）
     2. 把帧 + 一段中文说明指令，组装成 OpenAI 兼容的多模态请求
        （image_url 内容块，任意支持图片输入的视觉/多模态模型都能接）
     3. 拿到文字描述后，回写进那条消息的 caption 字段，并让角色据此回应
   没配「视频理解 API」时优雅跳过：视频照发照播，只是角色读不到内容。
   密钥只在本机浏览器，请求直连用户填的 endpoint（OpenAI 兼容格式）。
   ============================================================ */

(function (global) {
  'use strict';
  var Sleepy = (global.Sleepy = global.Sleepy || {});

  var PROMPT = '请用简体中文描述这段视频的画面内容与发生的事，' +
    '包括：场景、人物/角色、动作、情绪氛围；如果画面里有字幕或台词，请尽量转写出来。' +
    '控制在 300 字以内，客观、按顺序。';

  /* 接口地址补成 /chat/completions：用户填到 /v1 即可，若已经带全路径也不重复拼。 */
  function chatUrl(base) {
    base = String(base || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  /* 抽 N 帧：把视频 load 进来，按时间均分 seek，drawImage 到 canvas 取 jpeg。
     全程超时兜底，失败返回空数组（上层据此跳过解读）。 */
  function extractFrames(blob, count) {
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

      global.setTimeout(finish, 15000); // 安全兜底：抽帧卡住也不至于永远挂着

      v.addEventListener('error', function () { finish(); });
      v.addEventListener('loadedmetadata', function () {
        var dur = v.duration;
        if (!isFinite(dur) || dur <= 0) { finish(); return; }
        var n = Math.max(1, Math.min(count, Math.floor(dur)));
        var i = 0;
        v.addEventListener('seeked', function () {
          try {
            var cw = 480;
            var ratio = (v.videoWidth && v.videoHeight) ? (v.videoHeight / v.videoWidth) : 0.5625;
            var ch = Math.max(1, Math.round(cw * ratio));
            var c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            c.getContext('2d').drawImage(v, 0, 0, cw, ch);
            frames.push(c.toDataURL('image/jpeg', 0.7));
          } catch (e) { /* 这帧废了，略过 */ }
          i++;
          if (i < n) { try { v.currentTime = dur * (i + 0.5) / n; } catch (e) { finish(); } }
          else finish();
        });
        try { v.currentTime = dur * 0.5 / n; } catch (e) { finish(); }
      });
    });
  }

  /* OpenAI 兼容多模态请求：帧作 image_url 内容块，附一段中文说明指令。
     任意支持图片输入的视觉/多模态模型（Gemini / Qwen-Omni / GLM-4.5V…）都能接。 */
  function callApi(cfg, frames) {
    var url = chatUrl(cfg.baseUrl);
    if (!url) return Promise.reject(new Error('接口地址为空'));
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    var content = [{ type: 'text', text: PROMPT }];
    frames.forEach(function (d) { content.push({ type: 'image_url', image_url: { url: d } }); });
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
      return extractFrames(rec.blob, 6).then(function (frames) {
        if (!frames.length) { if (hooks.toast) hooks.toast('视频抽帧失败，跳过解读', 'warn'); return; }
        return callApi(cfg, frames).then(function (text) {
          if (hooks.patchMessage) hooks.patchMessage(chatId, msgId, { caption: text });
          if (hooks.requestReply) hooks.requestReply({});
          if (hooks.toast) hooks.toast('TA 看完视频了', 'ok');
        }, function (err) {
          if (hooks.toast) hooks.toast('视频解读失败：' + ((err && err.message) || err), 'warn');
        });
      }, function () {
        if (hooks.toast) hooks.toast('视频抽帧失败', 'warn');
      });
    }, function () {
      if (hooks.toast) hooks.toast('读不到视频本体', 'warn');
    });
  }

  Sleepy.videoUnderstand = {
    analyzeAndInject: analyzeAndInject,
    extractFrames: extractFrames
  };
})(typeof window !== 'undefined' ? window : this);
