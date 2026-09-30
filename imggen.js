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

   B0 起「谁发的图」和「画面里有谁」正式分家（实施单 B0 v1）：
   新入口传 ImagePlan（见 normalizePlan）—— 画面主体只看 plan.subjects，
   基底选档不再靠 PERSON_RE 猜中文；sender 只管图片落谁的气泡。
   没带 plan 的旧入口走 legacy fallback（isSceneSubject），只剩
   生图页「试一张」和 AI 解析失败的兜底还在用，新入口不许再加。

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
    },
    chat: {
      label: '文字通道',
      hint: '走 /chat/completions 的中转：生图模型挂在文字通道上，回图链或图数据'
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
     老数据只有 faceLockText（字符串）→ 当 base 用，完全兼容。
     portrait（近景半身）和 selfie 一样吃「自拍/近景补充」组；
     其余（full/candid/group/scene/auto/空）走「全身/场景补充」组。 */
  function faceTextFor(ch, shot) {
    if (!ch) return '';
    var base = String(ch.faceLockText || '').trim();
    var extra = (shot === 'selfie' || shot === 'portrait')
      ? String(ch.faceLockSelfie || '').trim()
      : String(ch.faceLockFull || '').trim();
    return [base, extra].filter(Boolean).join(', ');
  }

  /* ------------------------ ImagePlan（B0 统一意图） ------------------------
     消息由谁发送 ≠ 画面里出现谁：
     - sender 只决定图片落谁的气泡，不参与锁脸与基底判断；
     - 画面主体只看 subjects（谁在画面里就列谁，user/char 各是各的）；
     - 基底选档：subjects 非空 → 一律人物向；只有空 subjects 且
       contentType 是 scene/object 才允许场景向（BUILTIN_SCENE）。
     shot 只决定锁脸补充组（selfie/portrait → 自拍组，其余 → 全身组）。 */
  var PLAN_SENDERS = ['user', 'char', 'system'];
  var PLAN_CONTENT_TYPES = ['scene', 'object', 'person', 'mixed'];
  var PLAN_SHOTS = ['auto', 'selfie', 'portrait', 'full', 'candid', 'group', 'scene'];

  function normalizePlan(plan) {
    plan = plan || {};
    var subs = Array.isArray(plan.subjects) ? plan.subjects : [];
    return {
      sender: PLAN_SENDERS.indexOf(plan.sender) >= 0 ? plan.sender : 'system',
      contentType: PLAN_CONTENT_TYPES.indexOf(plan.contentType) >= 0 ? plan.contentType : 'person',
      description: String(plan.description || '').trim(),
      shot: PLAN_SHOTS.indexOf(plan.shot) >= 0 ? plan.shot : 'auto',
      subjects: subs.map(function (s) {
        s = s || {};
        return {
          entityType: s.entityType === 'user' ? 'user' : 'char',
          entityId: String(s.entityId || ''),
          name: String(s.name || ''),
          gender: String(s.gender || ''),
          faceText: String(s.faceText || '').trim()
        };
      }).filter(function (s) {
        /* 空壳主体（既没人名也没特征）没信息量，丢掉 */
        return s.entityType === 'user' || !!s.faceText || !!s.gender || !!s.name;
      })
    };
  }

  /* 人物身份段：每个主体独立一段（性别 tag + 锁脸词），多人时前缀名字
     保持「谁长什么样」的对应。**身份段永不合并去重** —— 两个人都有
     「silver hair」是两份不同的特征，parts.indexOf 式去重只许用在
     description/extras 这类全局词上。 */
  function subjectTextForPlan(plan) {
    var subs = normalizePlan(plan).subjects;
    var segs = subs.map(function (s) {
      var bits = [];
      var g = genderTagOf(s.gender);
      if (g) bits.push(g);
      if (s.faceText) bits.push(s.faceText.replace(/^\s*,\s*/, ''));
      var seg = bits.join(', ');
      if (!seg) return '';
      /* 单主体不写名字（中文名进 tag 管线是噪音）；多主体必须绑定 */
      return (subs.length > 1 && s.name) ? (s.name + ' (' + seg + ')') : seg;
    }).filter(Boolean);
    return segs.join(', ');
  }

  /* 帮调用方造 subjects。char 按 shot 取锁脸分组；
     user 现在没有外貌字段（B1 才补）—— 保持空，绝不误拼 char 的资料。 */
  function subjectForChar(ch, shot) {
    ch = ch || {};
    return {
      entityType: 'char',
      entityId: String(ch.id || ''),
      name: String(ch.name || ''),
      gender: String(ch.gender || ''),
      faceText: faceTextFor(ch, shot)
    };
  }
  /* user 马甲主体（B1）：读马甲**自己**的 gender + 锁脸三件，分档与 char
     完全同语义（faceTextFor 对 user 记录同样适用：selfie/portrait → 自拍组，
     其余 → 全身组）。马甲没填就给空串 —— 绝不读 char 的资料，
     也不回落别的马甲；名字空 → 兜「我」，多人群像时保住实体绑定。 */
  function subjectForUser(u, shot) {
    u = u || {};
    return {
      entityType: 'user',
      entityId: String(u.id || ''),
      name: String((u && (u.name || u.wechatName)) || '我'),
      gender: String(u.gender || ''),
      faceText: faceTextFor(u, shot)
    };
  }

  /* AI 文本里夹带的结构化配图信息（[图]/[生图:] 后跟一段 JSON）：
     解析得动且字段过白名单 → 返回 { description, contentType, shot, subjects }；
     解析不动 / 没有有效内容 → null（调用方走 legacy 一句话路径）。
     subjects 只认 'user'/'char' 两种字符串（群入口的多角色结构化留后续批）。 */
  function parsePlanJson(raw) {
    var t = String(raw || '').trim();
    var i = t.indexOf('{');
    var j = t.lastIndexOf('}');
    if (!(i >= 0 && j > i)) return null;
    var obj;
    try { obj = JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    var subs = (Array.isArray(obj.subjects) ? obj.subjects : []).filter(function (x) {
      return x === 'user' || x === 'char';
    });
    var description = String(obj.description || '').trim();
    if (!description && !subs.length) return null;
    return {
      description: description,
      contentType: PLAN_CONTENT_TYPES.indexOf(obj.contentType) >= 0
        ? obj.contentType : (subs.length ? 'person' : 'scene'),
      shot: PLAN_SHOTS.indexOf(obj.shot) >= 0 ? obj.shot : 'auto',
      subjects: subs
    };
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
      /* 用户 2026-09-29：「所有 api 类型的超时都改成 60s」——
         生图不再按类型给长超时，统一 60。 */
      timeoutSec: 60,
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

  /* --------------------- E1 视觉层本地实验 ---------------------
     独立实验字段（**不进接口配置对象**，不污染同步/导入导出/历史数据）：
     - sleepy_img_visual_exp_mode    'legacy' | 'sleepy-default' | 'custom'
     - sleepy_img_visual_exp_custom  用户自定义视觉词
     仅供「设置 → 生图 → 试一张」消费；legacy = 完全旧拼接路径（对照组），
     其余模式走 buildSceneObjectExperimentPrompt 的独立拼接（不走 {p}）。 */
  var VISUAL_EXP_MODES = ['legacy', 'sleepy-default', 'custom'];
  function visualExpMode() {
    var v = store.get('sleepy_img_visual_exp_mode');
    return VISUAL_EXP_MODES.indexOf(v) >= 0 ? v : 'legacy';
  }
  function setVisualExpMode(m) {
    return store.set('sleepy_img_visual_exp_mode',
      VISUAL_EXP_MODES.indexOf(m) >= 0 ? m : 'legacy');
  }
  function visualExpCustom() {
    return String(store.get('sleepy_img_visual_exp_custom') || '');
  }
  function setVisualExpCustom(t) {
    return store.set('sleepy_img_visual_exp_custom', String(t || ''));
  }

  /* Sleepy 场景/物品视觉底座（E1 实验草案，**不是正式替换词**）：
     与 BUILTIN_SCENE 完全独立、互不覆写。四件分开：
     正向视觉词 / 无人主体结构 / 结构负面（排人等，custom 也保留）/
     审美负面（过饱和、塑料、广告化 —— 仅 sleepy-default 注入）。
     质量层取各自出厂预设的质量头当「必要质量层」，
     不叠完整旧 preset（§八.2：避免重复质量词与相互冲突）。 */
  var SLEEPY_VISUAL_STYLE = {
    general: {
      qualityPositive: 'masterpiece, best quality, highly detailed',
      qualityNegative: 'lowres, worst quality, low quality, jpeg artifacts, blurry',
      sceneObjectPositive: 'natural realistic photography, believable spatial relationships, natural light, authentic material texture, clear subject, lived-in details, balanced composition, subtle imperfections, realistic depth, soft natural color, visually pleasing but unposed',
      sceneObjectStructure: 'empty of people, no human subject, the environment or object is the clear main subject',
      sceneObjectNegativeStructural: 'people, person, human, face, portrait, selfie, random passerby, unwanted character, text, watermark, logo',
      sceneObjectNegativeAesthetic: 'oversaturated colors, plastic texture, staged product shot'
    },
    nai: {
      qualityPositive: 'best quality, amazing quality, very aesthetic, absurdres',
      qualityNegative: 'lowres, worst quality, bad quality, jpeg artifacts, very displeasing',
      sceneObjectPositive: 'natural slice-of-life illustration, believable composition, gentle natural lighting, detailed environment, tactile materials, clear subject, lived-in atmosphere, harmonious colors, subtle imperfections, grounded and unembellished',
      sceneObjectStructure: 'no people, no human figure, the environment or object is the clear main subject',
      sceneObjectNegativeStructural: '1girl, 1boy, person, human, face, portrait, selfie, random character, unwanted figure, text, watermark, logo',
      sceneObjectNegativeAesthetic: 'overly glossy, plastic texture, promotional poster'
    }
  };

  /* 视觉审美层：只产视觉词，不产主体/身份/剧情；不看 sender；
     不用中英文关键词猜人物。custom 为空 → 空串
     （含义是「没有额外视觉审美词」，**不是**回退 Sleepy 默认）。 */
  function visualStyleText(apiKind, mode, customText, contentType) {
    if (mode === 'custom') return String(customText || '').trim();
    if (mode !== 'sleepy-default') return '';
    var pack = SLEEPY_VISUAL_STYLE[apiKind] || SLEEPY_VISUAL_STYLE.general;
    if (contentType === 'scene' || contentType === 'object') {
      return pack.sceneObjectPositive;
    }
    return '';
  }

  /* 层内去重：只对同一层里完全相同的词条去重；层级次序保持，不跨层合并。 */
  function dedupeTerms(layer) {
    var seen = {};
    var out = [];
    String(layer || '').split(',').forEach(function (t) {
      t = t.trim();
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out.join(', ');
  }
  function joinLayers(layers) {
    return layers.map(dedupeTerms).filter(Boolean).join(', ');
  }

  /* 场景/物品实验拼接（E1 §七/§八）：
     positive = [必要质量层] + [无人主体结构] + [description] + [视觉审美层] + [extras]
     negative = [必要负面] + [结构负面] +（仅 sleepy-default）[审美负面]
     只服务 subjects 为空的 scene/object：legacy 模式或含人物的 plan
     返回 null，由调用方走原 buildPrompt。实验新路径不依赖 {p} 占位。 */
  function buildSceneObjectExperimentPrompt(opts) {
    opts = opts || {};
    var mode = VISUAL_EXP_MODES.indexOf(opts.visualMode) >= 0 ? opts.visualMode : 'legacy';
    var subjects = Array.isArray(opts.subjects) ? opts.subjects : [];
    var contentType = (opts.contentType === 'object') ? 'object' : 'scene';
    if (mode === 'legacy') return null;
    if (subjects.length) return null;
    var api = opts.api || {};
    var kind = (api.kind === 'nai') ? 'nai' : 'general';
    var pack = SLEEPY_VISUAL_STYLE[kind];
    var visual = visualStyleText(kind, mode, opts.customVisualStyle, contentType);
    var positive = joinLayers([
      pack.qualityPositive,
      pack.sceneObjectStructure,
      opts.description,
      visual,
      (opts.extras || []).join(', ')
    ]);
    var negative = joinLayers(mode === 'sleepy-default'
      ? [pack.qualityNegative, pack.sceneObjectNegativeStructural, pack.sceneObjectNegativeAesthetic]
      : [pack.qualityNegative, pack.sceneObjectNegativeStructural]);
    var debug = {
      mode: mode, contentType: contentType, kind: kind,
      subjectCount: subjects.length,
      visualWords: visual ? (visual.slice(0, 60) + (visual.length > 60 ? '…' : '')) : '(空)',
      positive: positive, negative: negative
    };
    if (typeof console !== 'undefined' && console.info) {
      console.info('[Sleepy][视觉实验]', debug);
    }
    return { positive: positive, negative: negative, debug: debug };
  }

  /* ---------------------------- 拼提示词 ----------------------------
     buildPrompt(opts) → { positive, negative, scene, plan? }
     带 opts.plan（ImagePlan）→ 走 buildPromptForPlan（新管线，见下）；
     没带 → legacy fallback：按 isSceneSubject(subject) 用 PERSON_RE 猜
     有没有人 —— 只剩「试一张」和 AI 解析失败的兜底在用（B0）。 */
  function buildPrompt(opts) {
    opts = opts || {};
    var api = opts.api || activeApi() || {};
    if (opts.plan) return buildPromptForPlan(opts.plan, opts.extras, api);

    /* ---- legacy fallback（B0 前的旧路，新入口不许再依赖）---- */
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

  /* plan 版拼装（实施单 B0 第三节）：
     - hasPeople 只看 subjects.length，跟 description 中英文无关；
     - 只有「没人 且 contentType 是 scene/object」才允许场景基底；
     - 身份段（subjectTextForPlan）整段进 core 不去重，
       去重只发生在 description + extras 这些全局词之间。 */
  function buildPromptForPlan(planIn, extras, api) {
    var plan = normalizePlan(planIn);
    var hasPeople = plan.subjects.length > 0;
    var scene = !hasPeople && (plan.contentType === 'scene' || plan.contentType === 'object');

    var preset = scene
      ? (BUILTIN_SCENE[api.kind] || BUILTIN_SCENE.general).positive
      /* 兜底链条：接口没配时落到出厂预设的 .positive —— BUILTIN_PRESET.general
         是 {positive, negative} 对象不是字符串（B0 时从 legacy 抄来的隐患，
         B1 真机验收抓到：无接口直接 buildPrompt({plan}) 会 preset.indexOf 崩）。 */
      : (api.positivePreset || (BUILTIN_PRESET[api.kind] || BUILTIN_PRESET.general).positive);

    var coreParts = [];
    var identity = subjectTextForPlan(plan);
    if (identity) coreParts.push(identity);
    var seen = {};
    function pushDedup(t) {
      t = String(t || '').trim();
      if (!t || seen[t]) return;
      seen[t] = true;
      coreParts.push(t);
    }
    pushDedup(plan.description);
    (extras || []).forEach(pushDedup);
    var core = coreParts.join(', ');

    var positive = preset.indexOf('{p}') >= 0
      ? preset.replace('{p}', core)
      : (core ? preset + ', ' + core : preset);

    var negative = scene
      ? (BUILTIN_SCENE[api.kind] || BUILTIN_SCENE.general).negative
      : (api.negativePreset || (BUILTIN_PRESET[api.kind] || BUILTIN_PRESET.general).negative);

    return { positive: positive, negative: negative, scene: scene, plan: plan };
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
     opts = { plan(优先), subject, faceText, extras, api, size }
     带 plan 时 subject/faceText/gender 被忽略 —— 一切以 plan 为准。
     generateBuilt(opts)：E1 实验专用 —— 调用方已拼好最终 prompt，
     直接进请求+落库，不再过 buildPrompt（保住 legacy 路径分毫不动）。 */
  function generate(opts) {
    opts = opts || {};
    var api = opts.api || activeApi();
    if (!api) {
      return Promise.resolve({ ok: false, error: err('还没有配置生图接口', '去 设置 → 生图 添加一个') });
    }
    var built = buildPrompt({
      plan: opts.plan,
      subject: opts.subject,
      faceText: opts.faceText,
      extras: opts.extras,
      api: api,
      gender: opts.gender,
      scene: opts.scene
    });
    return requestAndStore(api, built, opts.size);
  }

  function generateBuilt(opts) {
    opts = opts || {};
    var api = opts.api || activeApi();
    if (!api) {
      return Promise.resolve({ ok: false, error: err('还没有配置生图接口', '去 设置 → 生图 添加一个') });
    }
    return requestAndStore(api,
      { positive: String(opts.positive || ''), negative: String(opts.negative || '') },
      opts.size);
  }

  function requestAndStore(api, built, sizeStr) {
    var size = String(sizeStr || api.size || '1024x1024').split('x');
    var w = Math.max(64, parseInt(size[0], 10) || 1024);
    var hgt = Math.max(64, parseInt(size[1], 10) || 1024);
    /* 超时归一（2026-09-29）：生图也统一 60s，存档里存了更大值（如老预设的
       120/180）照跑，小于 60 的一律按 60 —— 与主 API genParams 同口径。 */
    var secs = Math.max(60, Number(api.timeoutSec) || 60);

    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, secs * 1000) : null;

    function finish(res) { if (timer) clearTimeout(timer); return res; }

    var req = (api.kind === 'nai') ? requestNai(api, built, w, hgt, ctrl)
      : (api.kind === 'chat') ? requestChat(api, built, ctrl)
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

  /* ---- 文字通道（/chat/completions，2026-09-29）----
     很多中转站没有独立的 /images/generations，生图模型挂在文字通道上：
     发一段「画这张图」的对话，模型回 markdown 图链 / 裸链 / dataURI。
     解析顺序：markdown 图片 → dataURI → 带图片后缀的裸链。
     报错契约与 general 一致：{message, detail}，detail 原样留给用户反馈中转站。 */
  function extractImageFromChatText(text) {
    var t = String(text || '');
    var m = /!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^;)]+;base64,[A-Za-z0-9+/=]+)\)/.exec(t);
    if (m) return m[1];
    var d = /data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/.exec(t);
    if (d) return d[0];
    var u = /https?:\/\/[^\s"'<>）)\]]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>）)\]]*)?/i.exec(t);
    if (u) return u[0];
    return '';
  }

  function requestChat(api, built, ctrl) {
    var base = String(api.baseUrl || '').trim().replace(/\/+$/, '');
    var url = /\/chat\/completions$/i.test(base) ? base
      : (base ? base + '/chat/completions' : '');
    if (!url || !api.model) {
      return Promise.reject(err('接口没配好', !url ? '先填接口地址' : '先填模型名'));
    }
    var headers = { 'Content-Type': 'application/json' };
    if (api.apiKey) headers['Authorization'] = 'Bearer ' + api.apiKey;
    var content = '请生成一张图片：' + built.positive +
      (built.negative ? '\n\n画面里不要出现这些要素：' + built.negative : '') +
      '\n\n只返回图片本身（markdown 图片、图片链接或 base64 数据都可以），不要多余解释。';
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: api.model,
        messages: [{ role: 'user', content: content }],
        stream: false
      })
    }, ctrl).then(function (r) {
      return r.text().then(function (txt) {
        if (!r.ok) return Promise.reject(err('接口报错 HTTP ' + r.status, txt));
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { /* 落到下面 */ }
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var out = '';
        if (msg) {
          if (typeof msg.content === 'string') out = msg.content;
          else if (Array.isArray(msg.content)) {
            out = msg.content.map(function (p) {
              return (p && (p.text || (p.image_url && p.image_url.url))) || '';
            }).join('\n');
          }
        }
        var hit = extractImageFromChatText(out);
        if (!hit) {
          return Promise.reject(err('文字通道没返回图片（模型可能拒绝或不会画）', txt));
        }
        if (hit.indexOf('data:image/') === 0) {
          return b64ToBlob(hit.slice(hit.indexOf('base64,') + 7), txt);
        }
        /* 中转图链：再抓一次（常带防盗链/过期，抓不动就把链接放进 detail） */
        return fetchWithTimeout(hit, {}, ctrl).then(function (r2) {
          if (!r2.ok) return Promise.reject(err('图片下载失败 HTTP ' + r2.status, hit));
          return r2.blob();
        }, function (e) {
          return Promise.reject(err('图片下载失败（链接抓不动）', hit + '\n' + ((e && e.message) || e)));
        });
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
      '【发图】你可以在回复里写 [生图:...] 给对方发一张照片——',
      '- 方括号里推荐写一个 JSON：{"description":"画面内容，英文 tag 风格","contentType":"scene|object|person|mixed","shot":"auto|selfie|portrait|full|candid|group|scene","subjects":["user","char"]}',
      '- subjects 只写画面里真实出现的人：你出镜写 "char"，镜头对准对方写 "user"，合影两个都写，食物/宠物/风景留 []——发什么由你定，不一定是自拍',
      '- 实在写不了 JSON 也可以只写一句中文描述（会按你出镜处理）',
      '- 只在真的想分享、对方想看、或话题自然需要时用；不要每轮都发，一次回复最多一张',
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
    normalizePlan: normalizePlan,
    subjectTextForPlan: subjectTextForPlan,
    subjectForChar: subjectForChar,
    subjectForUser: subjectForUser,
    parsePlanJson: parsePlanJson,
    visualExpMode: visualExpMode,
    setVisualExpMode: setVisualExpMode,
    visualExpCustom: visualExpCustom,
    setVisualExpCustom: setVisualExpCustom,
    SLEEPY_VISUAL_STYLE: SLEEPY_VISUAL_STYLE,
    visualStyleText: visualStyleText,
    buildSceneObjectExperimentPrompt: buildSceneObjectExperimentPrompt,
    generateBuilt: generateBuilt,
    extractImageFromChatText: extractImageFromChatText,
    buildPrompt: buildPrompt,
    generate: generate,
    replySpec: replySpec,
    extractFirstFile: extractFirstFile
  };

})(window);
