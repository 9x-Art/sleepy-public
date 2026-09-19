/* ============================================================
   imggen.js — 生图引擎（数据层 + 拼提示词 + 调接口，不含 UI）
   依赖：store.js（localStorage）、media.js（IndexedDB 图库）。
   必须排在 media.js 之后、page-imggen.js 之前。

   两类接口（用户：「分为常规生图模型和 nai 等热门模型，专门分出来」）：
   - general  OpenAI 兼容式 /v1/images/generations，b64_json 返回
   - nai      NovelAI /ai/generate-image，返回的是一个 **zip 包**
              （里面躺着一张 png）—— 不引依赖，用 DecompressionStream
              自己拆 zip（Edge 88+ 都有，拆不动就报「返回格式不对」）

   内置预设词：按 kind 出厂自带一套（NAI 带正面质量词 + 负面模板），
   加接口时拷进这份配置里，之后随便改 —— 预设是「起手式」，不是枷锁。

   拼提示词管线（顺序固定，见 buildPrompt）：
   ① 内置/接口预设基底（含 {prompt} 占位）
   ② 锁脸段（身份特征，P1 接进聊天后由 char.faceLock 提供）
   ③ 动态段（场景/动作/服装/表情 —— 每次生成时给）
   ④ 用户自定义词条（提示词库里勾的）
   ⑤ 负面提示词单独通道（NAI 用）

   报错一律 { message, detail }：detail 是原始返回文本，
   给 UI 复制用 —— 用户要拿去反馈给接口中转站，所以要完整、
   且**不含我们自己的任何链接**（用户明确要求）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var media = Sleepy.media;

  /* ---------------------------- 接口种类 ---------------------------- */

  var KINDS = {
    general: {
      label: '常规生图',
      hint: 'OpenAI 兼容的 /images/generations（各家中转基本都支持）'
    },
    nai: {
      label: 'NAI',
      hint: 'NovelAI 等有自己一格的模型，带正负面提示词预设'
    }
  };

  /* 出厂预设。{p} 是「这回要画什么」的占位 ——
     拼装时替换成 锁脸段 + 动态段 + 自定义词条。

     预设按用户的要求调过方向（2026-09-17）：
     避免低质量、多手指、过度老化、丑 —— 要细节要好看。
     general 走通用 Danbooru 风 tag；NAI 按官方推荐用「轻负面」
     （NAI 4.x 的 UCE 已经内置规避，负面堆太重反而糊脸）。 */
  var BUILTIN_PRESET = {
    general: {
      positive: ('{p}, masterpiece, best quality, ultra detailed, '
        + 'beautiful detailed eyes, delicate face, detailed skin, soft lighting'),
      negative: ('lowres, worst quality, low quality, normal quality, jpeg artifacts, blurry, '
        + 'bad anatomy, bad hands, bad proportions, deformed, mutated, disfigured, '
        + 'extra fingers, fewer digits, missing fingers, fused fingers, too many fingers, '
        + 'extra limbs, malformed limbs, '
        + 'ugly, old, aged up, elderly, wrinkle, long face, cross-eyed, '
        + 'watermark, signature, username, text, logo, cropped')
    },
    nai: {
      /* NAI 社区通用起手式：质量词在正面，负面给一套标准规避表 */
      positive: ('{p}, best quality, amazing quality, very aesthetic, absurdres, '
        + 'finely detailed beautiful eyes, detailed background'),
      negative: ('lowres, worst quality, bad quality, jpeg artifacts, very displeasing, '
        + 'chromatic aberration, bad hands, extra digits, fewer digits, '
        + 'bad anatomy, deformed, blurry, old, aged up, watermark, signature, username')
    }
  };

  /* 场景向预设（2026-09-19 定稿的第二档）：subject 里没有人物 tag 时
     自动换用这档 —— 质量词换成景的，负面把人排掉。
     人物向/场景向是出厂起手式；用户改过 positivePreset 的只对人物向生效，
     场景向始终走内置（写两份用户预设太折磨，先这么定）。 */
  var BUILTIN_SCENE = {
    general: {
      positive: ('{p}, masterpiece, best quality, highly detailed, scenery, '
        + 'detailed background, soft lighting, atmospheric'),
      negative: ('lowres, worst quality, low quality, jpeg artifacts, blurry, '
        + 'bad proportions, deformed, ugly, watermark, signature, username, text, logo, '
        + '1girl, 1boy, person, face, close-up')
    },
    nai: {
      positive: ('{p}, best quality, amazing quality, very aesthetic, absurdres, '
        + 'scenery, no humans, detailed background'),
      negative: ('lowres, worst quality, bad quality, jpeg artifacts, very displeasing, '
        + 'bad anatomy, blurry, watermark, signature, username, '
        + '1girl, 1boy, human, face')
    }
  };

  /* subject 里有没有人物 → 选哪档预设 */
  var PERSON_RE = /1girl|1boy|1other|girl|boy|woman|man|female|male|person|people|portrait|selfie/i;
  function isSceneSubject(subject) {
    var s = String(subject || '');
    return !!s && !PERSON_RE.test(s);
  }

  /* 性别 → 基础人物 tag（其他性别手填，不硬塞） */
  function genderTag(ch) {
    var g = ch && ch.gender;
    if (g === 'male') return '1boy';
    if (g === 'female') return '1girl';
    return '';
  }

  /* 锁脸分组：base 永远带上，按画面类型加对应那组。
     老数据只有 faceLockText（字符串）→ 当 base 用，完全兼容。 */
  function faceTextFor(ch, shot) {
    if (!ch) return '';
    var base = String(ch.faceLockText || '').trim();
    var extra = (shot === 'selfie')
      ? String(ch.faceLockSelfie || '').trim()
      : String(ch.faceLockFull || '').trim();
    return [base, extra].filter(Boolean).join(', ');
  }

  /* 提示词库的类别（下拉列表选项，page-imggen 用） */
  var PROMPT_CATS = ['画质', '风格', '角色特征', '氛围', '其他'];

  /* NAI 官方常用的几个模型名，给表单当快捷填法（也可手写别的） */
  var NAI_MODELS = [
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-full',
    'nai-diffusion-3',
    'nai-diffusion-4-5-curated-preview'
  ];

  var NAI_BASE = 'https://image.novelai.net';

  /* ---------------------------- 数据层 ---------------------------- */

  function listApis() {
    var l = store.get('imgApis');
    return Array.isArray(l) ? l : [];
  }
  function saveApis(list) { return store.set('imgApis', list); }

  function activeId() {
    var v = store.get('imgApiId');
    return v ? String(v) : '';
  }

  /* 当前用于生成的接口：显式指向的 > 列表里第一个启用的 */
  function activeApi() {
    var list = listApis();
    var act = activeId();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === act && list[i].enabled !== false) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j].enabled !== false) return list[j];
    }
    return null;
  }

  function setCurrent(id) { return store.set('imgApiId', id); }

  /* 新建一份接口记录：预设当场拷进来（用户：「根据模型特色写内置预设词」，
     拷进来之后就是他自己的，随便改不影响出厂值） */
  function newApi(kind) {
    var base = BUILTIN_PRESET[kind] || BUILTIN_PRESET.general;
    return {
      id: 'ig' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: KINDS[kind] ? kind : 'general',
      name: '',
      baseUrl: kind === 'nai' ? NAI_BASE : '',
      apiKey: '',
      model: '',
      size: kind === 'nai' ? '832x1216' : '1024x1024',
      timeoutSec: kind === 'nai' ? 180 : 120,
      positivePreset: base.positive,
      negativePreset: base.negative,
      enabled: true
    };
  }

  /* ---------------------------- 提示词库 ---------------------------- */

  function listPrompts() {
    var l = store.get('promptLib');
    return Array.isArray(l) ? l : [];
  }
  function savePrompts(list) { return store.set('promptLib', list); }
  function addPrompt(rec) {
    var list = listPrompts();
    list.push({
      id: 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: rec.name || '',
      text: rec.text || '',
      cat: rec.cat || '其他'
    });
    return savePrompts(list);
  }
  function removePrompt(id) {
    return savePrompts(listPrompts().filter(function (p) { return p.id !== id; }));
  }

  /* ------------------------- 全局开关 -------------------------
     个人开关（每个会话各自开不开）后置到 chat 个人聊天设置页，
     这次只留全局闸。读 readEnabled() 而不是直接 get ——
     老存档没这个键时兜底为开。 */
  function readEnabled() {
    var v = store.get('imggenEnabled');
    return v === false ? false : true;
  }
  function setEnabled(on) { return store.set('imggenEnabled', !!on); }

  /* ---------------------------- 拼提示词 ----------------------------
     buildPrompt(opts) → { positive, negative, scene }
     opts = { subject, faceText, extras, api, gender, scene }
     顺序：性别 tag（1boy/1girl）← 锁脸段 ← 动态段 ← 自定义词条。
     锁脸只进「这个人长什么样」的身份描述；动作/服装/表情是调用方
     在 subject 里现给的 —— 两段分开拼，锁脸才不会把动作也锁死。
     预设选档：subject 里有人物 tag → 人物向（用户预设/内置）；
     没有 → 场景向内置（opts.scene=true 可强制）。 */
  function buildPrompt(opts) {
    opts = opts || {};
    var api = opts.api || activeApi() || {};
    var scene = (opts.scene != null) ? !!opts.scene : isSceneSubject(opts.subject);

    var preset;
    if (scene) {
      preset = (BUILTIN_SCENE[api.kind] || BUILTIN_SCENE.general).positive;
    } else {
      preset = api.positivePreset || BUILTIN_PRESET[api.kind] || BUILTIN_PRESET.general;
    }

    var parts = [];
    var gtag = genderTagOf(opts.gender);
    if (gtag) parts.push(gtag);
    if (opts.faceText) parts.push(String(opts.faceText).replace(/^\s*,\s*/, ''));
    if (opts.subject) parts.push(String(opts.subject).trim());
    (opts.extras || []).forEach(function (t) {
      t = String(t || '').trim();
      if (t) parts.push(t);
    });
    var core = parts.filter(function (s, i) { return parts.indexOf(s) === i; }).join(', ');

    var positive = preset.indexOf('{p}') >= 0
      ? preset.replace('{p}', core)
      : (core ? preset + ', ' + core : preset);

    var negative = scene
      ? (BUILTIN_SCENE[api.kind] || BUILTIN_SCENE.general).negative
      : (api.negativePreset || (BUILTIN_PRESET[api.kind] || BUILTIN_PRESET.general).negative);

    return { positive: positive, negative: negative, scene: scene };
  }

  /* 性别字段两种来路：直接 'male'/'female'，或整个 char 对象 */
  function genderTagOf(g) {
    if (g && typeof g === 'object') g = g.gender;
    if (g === 'male') return '1boy';
    if (g === 'female') return '1girl';
    return '';
  }

  /* ---------------------------- 报错 ----------------------------
     统一形状 { message, detail }。detail = 原始返回（截 2000 字），
     页面上做成可复制，供用户拿去反馈中转站。 */
  function err(message, detail) {
    return { message: message, detail: String(detail || '').slice(0, 2000) };
  }

  /* ------------------------ zip 拆包（NAI） ------------------------
     NAI 返回 application/zip，图在里面。最小实现：扫本地文件头
     （PK\x03\x04），取第一个条目，stored 直读 / deflate 用
     DecompressionStream 解。不追求完整 zip 规范 —— 够拆 NAI 的包就行。 */
  function extractFirstFile(buf) {
    var u8 = new Uint8Array(buf);
    var n = u8.length;
    var i = 0;
    while (i + 30 <= n) {
      /* 本地文件头签名 0x04034b50 */
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x03 && u8[i + 3] === 0x04) {
        var method = u8[i + 8] | (u8[i + 9] << 8);
        var csize = u8[i + 18] | (u8[i + 19] << 8) | (u8[i + 20] << 16) | (u8[i + 21] << 24);
        var nameLen = u8[i + 26] | (u8[i + 27] << 8);
        var extraLen = u8[i + 28] | (u8[i + 29] << 8);
        var dataStart = i + 30 + nameLen + extraLen;
        if (dataStart + csize > n) return Promise.reject(err('生图返回格式不对', 'zip 数据被截断'));
        var chunk = u8.subarray(dataStart, dataStart + csize);
        if (method === 0) return Promise.resolve(new Blob([chunk]));
        if (method === 8 && typeof global.DecompressionStream === 'function') {
          try {
            var ds = new global.DecompressionStream('deflate-raw');
            var stream = new Blob([chunk]).stream().pipeThrough(ds);
            return new Response(stream).blob()['catch'](function (e) {
              return Promise.reject(err('生图返回格式不对', 'zip 解压失败：' + (e && e.message)));
            });
          } catch (e) {
            return Promise.reject(err('生图返回格式不对', 'zip 解压失败：' + (e && e.message)));
          }
        }
        return Promise.reject(err('生图返回格式不对',
          '压缩方式 ' + method + ' 拆不动（这个浏览器可能太老）'));
      }
      i++;
    }
    return Promise.reject(err('生图返回格式不对', '没在 zip 里找到文件条目'));
  }

  /* ---------------------------- 调接口 ----------------------------
     generate(opts) → Promise<{ok:true, mediaId, blob} | {ok:false, error:{message, detail}}>
     opts = { subject, faceText, extras, api, size } */
  function generate(opts) {
    opts = opts || {};
    var api = opts.api || activeApi();
    if (!api) {
      return Promise.resolve({ ok: false, error: err('还没有配置生图接口', '去 设置 → 生图 添加一个') });
    }
    var built = buildPrompt({
      subject: opts.subject,
      faceText: opts.faceText,
      extras: opts.extras,
      api: api,
      gender: opts.gender,
      scene: opts.scene
    });
    var size = String(opts.size || api.size || '1024x1024').split('x');
    var w = Math.max(64, parseInt(size[0], 10) || 1024);
    var hgt = Math.max(64, parseInt(size[1], 10) || 1024);
    var secs = Math.max(10, api.timeoutSec || 120);

    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, secs * 1000) : null;

    function finish(res) { if (timer) clearTimeout(timer); return res; }

    var req = (api.kind === 'nai') ? requestNai(api, built, w, hgt, ctrl)
      : requestGeneral(api, built, w, hgt, ctrl);

    return req.then(function (blob) {
      if (!blob || !blob.size) {
        return finish({ ok: false, error: err('接口返回了空的图片', '') });
      }
      return media.put(blob, { name: '生图 ' + new Date().toLocaleString(), kind: 'image', w: w, h: hgt })
        .then(function (id) {
          return finish({ ok: true, mediaId: id, blob: blob });
        }, function (e) {
          /* 图库不可用（IndexedDB 被拦等）：图已经拿到了，别浪费 —— 临时地址直接给出去 */
          return finish({ ok: true, mediaId: '', blob: blob,
            url: global.URL.createObjectURL(blob),
            warn: '图库没存上（' + ((e && e.message) || e) + '），这张是一次性的' });
        });
    }, function (e) {
      return finish({ ok: false, error: e });
    });
  }

  function fetchWithTimeout(url, init, ctrl) {
    return global.fetch(url, Object.assign({ mode: 'cors', signal: ctrl ? ctrl.signal : undefined }, init));
  }

  /* 常规：OpenAI 兼容 /v1/images/generations。b64_json 优先，url 返回也接（再抓一次图） */
  function requestGeneral(api, built, w, hgt, ctrl) {
    var base = String(api.baseUrl || '').trim().replace(/\/+$/, '');
    var url = /\/images\/generations$/i.test(base) ? base
      : (base ? base + '/images/generations' : '');
    if (!url || !api.model) {
      return Promise.reject(err('接口没配好', !url ? '先填接口地址' : '先填模型名'));
    }
    var headers = { 'Content-Type': 'application/json' };
    if (api.apiKey) headers['Authorization'] = 'Bearer ' + api.apiKey;

    return fetchWithTimeout(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: api.model,
        prompt: built.positive,
        negative_prompt: api.kind === 'general' ? (built.negative || undefined) : undefined,
        n: 1,
        size: w + 'x' + hgt,
        response_format: 'b64_json'
      })
    }, ctrl).then(function (r) {
      return r.text().then(function (txt) {
        if (!r.ok) {
          return Promise.reject(err('接口报错 HTTP ' + r.status, txt));
        }
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { /* 落到下面 */ }
        var item = data && data.data && data.data[0];
        if (!item) {
          return Promise.reject(err('返回里没有图片数据', txt));
        }
        if (item.b64_json) {
          return b64ToBlob(item.b64_json, txt);
        }
        if (item.url) {
          /* 有的中转只给临时链接：再抓一次。抓图失败把链接放进 detail，用户还能自己开 */
          return fetchWithTimeout(item.url, {}, ctrl).then(function (r2) {
            if (!r2.ok) return Promise.reject(err('图片下载失败 HTTP ' + r2.status, item.url));
            return r2.blob();
          }, function (e) {
            return Promise.reject(err('图片下载失败（链接抓不动）', item.url + '\n' + ((e && e.message) || e)));
          });
        }
        return Promise.reject(err('返回里既没有 b64 也没有 url', txt));
      });
    }, function (e) {
      return Promise.reject(netErr(e));
    });
  }

  /* NAI：Bearer token，JSON 里带正负面，返回 zip。 */
  function requestNai(api, built, w, hgt, ctrl) {
    if (!api.apiKey) return Promise.reject(err('还没填 NAI 的令牌', 'NAI 用账号里的 Persistent API Token'));
    var base = String(api.baseUrl || NAI_BASE).trim().replace(/\/+$/, '');
    return fetchWithTimeout(base + '/ai/generate-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + api.apiKey
      },
      body: JSON.stringify({
        input: built.positive,
        model: api.model || 'nai-diffusion-3',
        action: 'generate',
        parameters: {
          width: w,
          height: hgt,
          scale: 5,
          sampler: 'k_euler_ancestral',
          steps: 28,
          n_samples: 1,
          ucPreset: 0,
          negative_prompt: built.negative || ''
        }
      })
    }, ctrl).then(function (r) {
      return r.arrayBuffer().then(function (buf) {
        if (!r.ok) {
          /* NAI 的报错有时是 JSON 有时是裸文本，都原样交出去 */
          var txt = '';
          try { txt = new TextDecoder().decode(buf); } catch (e) { txt = '(二进制响应)'; }
          return Promise.reject(err('NAI 报错 HTTP ' + r.status, txt));
        }
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('zip') >= 0 || ct.indexOf('octet-stream') >= 0) {
          return extractFirstFile(buf);
        }
        /* 不是 zip：可能是网关返回了 JSON 报错但状态码 200，照样交出去 */
        var maybeTxt = '';
        try { maybeTxt = new TextDecoder().decode(buf); } catch (e) { /* 忽略 */ }
        if (maybeTxt.charAt(0) === '{' || maybeTxt.charAt(0) === '<') {
          return Promise.reject(err('NAI 返回的不是图片', maybeTxt));
        }
        return new Blob([buf]);
      });
    }, function (e) {
      return Promise.reject(netErr(e));
    });
  }

  function netErr(e) {
    var aborted = e && e.name === 'AbortError';
    return err(aborted ? '超时了，接口一直没有回图' : '连不上：网络错误，或这个接口没开 CORS',
      (e && e.message) || String(e));
  }

  function b64ToBlob(b64, rawTxt) {
    try {
      var bin = atob(b64);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      /* 按 PNG/JPEG 魔数认类型，认不出就给 png（浏览器基本都能兜住） */
      var type = 'image/png';
      if (u8[0] === 0xff && u8[1] === 0xd8) type = 'image/jpeg';
      return Promise.resolve(new Blob([u8], { type: type }));
    } catch (e) {
      return Promise.reject(err('图片解码失败', 'atob 挂了：' + (e && e.message) + '\n' + (rawTxt || '').slice(0, 300)));
    }
  }

  /* ---------------------------- 发图说明卡 ----------------------------
     注入聊天 prompt 的说明书（引擎的 genimg 程序槽 / 旧路径共用这一份）。
     只在「生图接口可用」时注入 —— 没接口还教模型发图，只会出空气话。 */
  function replySpec() {
    if (!readEnabled() || !activeApi()) return '';
    return [
      '【发图】你可以在回复里写 [生图:一句话中文描述] 给对方发一张照片——',
      '- 只在真的想分享、对方想看、或话题自然需要时用；不要每轮都发，一次回复最多一张',
      '- 描述写画面本身（你此刻的样子、动作、场景），照片会自动带上你的长相特征',
      '- 发图后正常说话，像顺手拍了一张发过去；不想发就绝不写这个标签'
    ].join('\n');
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.imggen = {
    KINDS: KINDS,
    NAI_MODELS: NAI_MODELS,
    BUILTIN_PRESET: BUILTIN_PRESET,
    BUILTIN_SCENE: BUILTIN_SCENE,
    PROMPT_CATS: PROMPT_CATS,
    listApis: listApis,
    saveApis: saveApis,
    newApi: newApi,
    activeApi: activeApi,
    setCurrent: setCurrent,
    listPrompts: listPrompts,
    addPrompt: addPrompt,
    removePrompt: removePrompt,
    readEnabled: readEnabled,
    setEnabled: setEnabled,
    isSceneSubject: isSceneSubject,
    genderTag: genderTag,
    faceTextFor: faceTextFor,
    buildPrompt: buildPrompt,
    generate: generate,
    replySpec: replySpec,
    extractFirstFile: extractFirstFile
  };

})(window);
