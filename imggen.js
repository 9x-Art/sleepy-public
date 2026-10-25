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
    /* expectedSubjectCount（正式接入 2026-10-01；返修单 v2 §5 修正）：
       模型**声明**要画几个人，由构造 plan 的入口随 plan 带进来 ——
       **必须取自解析前的原始声明**（filter/去重之前），不能拿 filter 后的
       subjects.length 冒充。区分 absent（未声明，undefined）与显式 0：
       显式声明的有效非负整数要与解析数**严格相等**，少人（有人解析不了）
       和多人（声明与事实矛盾）都拦。 */
    var hasExpected = plan.expectedSubjectCount !== undefined
      && plan.expectedSubjectCount !== null;
    return {
      sender: PLAN_SENDERS.indexOf(plan.sender) >= 0 ? plan.sender : 'system',
      contentType: PLAN_CONTENT_TYPES.indexOf(plan.contentType) >= 0 ? plan.contentType : 'person',
      description: String(plan.description || '').trim(),
      shot: PLAN_SHOTS.indexOf(plan.shot) >= 0 ? plan.shot : 'auto',
      expectedSubjectCount: hasExpected ? plan.expectedSubjectCount : undefined,
      hasExpectedSubjectCount: hasExpected,
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

  /* 单个主体的身份段（正式接入 2026-10-01 拆出的**唯一实现**）：
     性别 tag + 锁脸词；withName=true 时前缀名字保持「谁长什么样」的对应。
     subjectTextForPlan 按主体数决定要不要名字，正式拼接器按同一规则逐块取 ——
     两处共用这一份，别再抄第三份。 */
  function identitySegmentFor(s, withName) {
    s = s || {};
    var bits = [];
    var g = genderTagOf(s.gender);
    if (g) bits.push(g);
    if (s.faceText) bits.push(String(s.faceText).replace(/^\s*,\s*/, ''));
    var seg = bits.join(', ');
    if (!seg) return '';
    return (withName && s.name) ? (s.name + ' (' + seg + ')') : seg;
  }

  /* 人物身份段：每个主体独立一段（性别 tag + 锁脸词），多人时前缀名字
     保持「谁长什么样」的对应。**身份段永不合并去重** —— 两个人都有
     「silver hair」是两份不同的特征，parts.indexOf 式去重只许用在
     description/extras 这类全局词上。 */
  function subjectTextForPlan(plan) {
    var subs = normalizePlan(plan).subjects;
    return subs.map(function (s) {
      return identitySegmentFor(s, subs.length > 1);
    }).filter(Boolean).join(', ');
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
      subjects: subs,
      /* 解析前的原始声明数（filter 之前）—— 正式拼接器用它严格对账，
         白名单滤掉的非法引用也算「解析不了的人」，不许静默减员。 */
      subjectsDeclared: Array.isArray(obj.subjects) ? obj.subjects.length : null
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

  /* 新建一份接口记录：**不再预灌内置预设词**（2026-10-08 用户拍板：
     「不要把我们的提示词放出来」—— 预灌的词会直接出现在设置表单里）。
     留空即可：正式/legacy/NAI 三条路对空 positivePreset / negativePreset
     都回落 BUILTIN_PRESET，拼出来的词分毫不变，只是不再展示、不再拷进
     用户存档。想覆盖的用户在表单里自己填。 */
  function newApi(kind) {
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
      positivePreset: '',
      negativePreset: '',
      /* B2 图片锁脸：参考图支持方式由用户按服务方能力显式声明
         （none=不支持/未核实，默认）；'edits'=通用 /images/edits，
         'chat'=文字通道多模态送图。NAI 暂不支持。 */
      refSupport: 'none',
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

  /* --------------------- 正式生图视觉层（内置 / 自定义） ---------------------
     2026-10-01 施工单 v1 §四：正式路径只有两档，用户只选「内置」或「自定义」。
     **独立字段**，不与实验区的 visualExpMode/visualExpCustom 混用：
     - sleepy_img_style_mode    'builtin' | 'custom'（新用户无配置默认 builtin）
     - sleepy_img_style_custom  自定义视觉词原文
     已有选择和原文照旧保留；切换**不清空** custom 文本（切走再切回来还在）。
     内置模式不提供内置词编辑（§一：内置词暂不提供编辑）。 */
  var IMG_STYLE_MODES = ['builtin', 'custom'];
  function imgStyleMode() {
    var v = store.get('sleepy_img_style_mode');
    return IMG_STYLE_MODES.indexOf(v) >= 0 ? v : 'builtin';
  }
  function setImgStyleMode(m) {
    return store.set('sleepy_img_style_mode',
      IMG_STYLE_MODES.indexOf(m) >= 0 ? m : 'builtin');
  }
  function imgStyleCustom() {
    return String(store.get('sleepy_img_style_custom') || '');
  }
  function setImgStyleCustom(t) {
    return store.set('sleepy_img_style_custom', String(t || ''));
  }

  /* 正式拼接器（施工单 §五 校验 + §七 层序）。唯一入口：imggen.generate 的
     plan 分支 —— chat 标签 / 生图弹层 / 查岗 / 重画 / 日记 / 朋友圈 / 线下键
     全部经它生效，不用逐入口改。
     buildFormalPrompt(opts) →
       { ok:true, positive, negative, debug }   拼好了，交给 requestAndStore
     | { ok:false, error:{message,detail} }     校验不过 → **零请求**，明确报错
     | null                                     NAI 等不接的组合 → 调用方回落 legacy
     层序（§七）：必要质量 → 人数结构 → 独立主体身份块 → 合法镜头 → 共同画面描述
     → 内置或自定义视觉层 → 适用负面。身份块**永不参与跨层去重**（不同身份
     外貌文本相同是合法的，§五.3）；description / 视觉层 / extras 之间的全局
     去重沿用 legacy 口径（joinLayers）。
     底座路由（§五）：0 人→01；1 人→02（男 / 女 C）；2 人→03；3～4 人→04；
     超过 4 人明确报错不截断。custom 只换视觉层；空 custom 合法 —— 保留结构与
     必要质量层，不回退内置。系统附加手部正向段**恒空**（§七，与实验路径一致）；
     用户描述 / custom 里的手部原文照常保留。 */
  /* §五 主体校验（2026-10-02 从 buildFormalPrompt 抽出共用）：
     General（buildFormalPrompt）与 NAI（buildFormalNaiRequest）两个编译器
     共用这一份，不抄第三份。只读 plan、不改状态；
     返回 { ok:true, plan, subs, n } | { ok:false, error }。 */
  function validatePlanSubjects(planIn) {
    var plan = normalizePlan(planIn);
    var subs = plan.subjects;
    var n = subs.length;

    /* —— §五 校验：任何一条不过 → 明确报错、零生图请求 —— */
    /* 1. 重复身份引用：同一实体出现两次（不同身份外貌文本相同是合法的，
          只看 entityType+entityId；空 id 不参与 —— 群像临时主体没有 id）。 */
    var seenId = {};
    for (var i = 0; i < n; i++) {
      var si = subs[i];
      if (!si.entityId) continue;
      var key = si.entityType + ':' + si.entityId;
      if (seenId[key]) {
        return { ok: false, error: err('画面主体重复了',
          '「' + (si.name || si.entityType) + '」在画面主体里出现两次。'
          + '同一个身份只报一次；两个不同的人就算外貌描述一样也要各自引用。') };
      }
      seenId[key] = true;
    }
    /* 2. 声明主体数与解析结果**严格相等**（返修单 v2 §5）：
          - absent（程序自造主体的入口，无模型声明）→ 不做人数对账，
            但身份引用仍逐个校验；
          - 显式声明必须是有效非负整数，格式不对 → 拦；
          - 声明 < 解析（有人解析不了：失效 / 越界 / 资料缺失）→ 拦，不静默减员；
          - 声明 > 解析（声明与事实矛盾 / 列表被截断）→ 同样拦。 */
    if (plan.hasExpectedSubjectCount) {
      var declared = plan.expectedSubjectCount;
      if (typeof declared !== 'number' || !isFinite(declared)
        || Math.floor(declared) !== declared || declared < 0) {
        return { ok: false, error: err('画面主体声明格式不对，这张没有生成',
          '声明的主体数（' + declared + '）不是有效的非负整数 —— 拒绝生成，'
          + '不会按猜的人数继续。重试或换画面再试。') };
      }
      if (declared !== n) {
        return { ok: false, error: err(declared > n
          ? '画面里有人解析不了，这张没有生成'
          : '画面主体数和声明对不上，这张没有生成',
          '模型声明要画 ' + declared + ' 个人，实际只解析出 ' + n + ' 个。'
          + (declared > n
            ? '可能有人不在当前场域、身份引用失效或资料缺失。'
            : '解析结果比声明多，属于矛盾（可能是引用重复或列表异常）。')
          + '不会静默换人、减员或降级成无人图；重试或换画面再试。') };
      }
    }
    /* 3. 人数上限：超过 4 人本轮明确不支持，不能截断。 */
    if (n > GROUP_MAX) {
      return { ok: false, error: err('一次最多画 ' + GROUP_MAX + ' 个人',
        '这张要画 ' + n + ' 人，超出本轮多人底座（' + GROUP_MIN + '～' + GROUP_MAX
        + ' 人）的范围。不会悄悄截掉谁再画 —— 请减少画面里的人数。') };
    }
    /* 4. 0 人却报 person/mixed：主体缺失导致语义不明，不降级成无人图。 */
    if (n === 0 && plan.contentType !== 'scene' && plan.contentType !== 'object') {
      return { ok: false, error: err('画面说有人，但一个主体都没解析出来',
        'contentType 是「' + plan.contentType + '」却没有任何可用主体。'
        + '不会静默画成空场景；请让 TA 重报画面，或改成场景／物品描述。') };
    }
    return { ok: true, plan: plan, subs: subs, n: n };
  }

  function buildFormalPrompt(opts) {
    opts = opts || {};
    var api = opts.api || {};
    /* NAI 已由 generate 分流到 buildFormalNaiRequest（2026-10-02 施工单）；
       本守卫保留为纯函数层保护：直接调用者拿到 null，不会误用 General 词。 */
    if (api.kind === 'nai') return null;

    var kind = 'general';
    var scenePack = SLEEPY_VISUAL_STYLE[kind];
    var singlePack = SLEEPY_SINGLE_STYLE[kind];
    var styleMode = IMG_STYLE_MODES.indexOf(opts.styleMode) >= 0
      ? opts.styleMode : imgStyleMode();
    var customStyle = String(opts.customStyle != null ? opts.customStyle : imgStyleCustom()).trim();

    var v = validatePlanSubjects(opts.plan);
    if (!v.ok) return { ok: false, error: v.error };
    var plan = v.plan;
    var subs = v.subs;
    var n = v.n;

    /* —— 底座路由 + 视觉层 —— */
    var baseTag, structure, visual, identityBlocks = [];
    var frame = '';
    if (n === 0) {
      baseTag = '01-scene';
      structure = scenePack.sceneObjectStructure;
      visual = styleMode === 'builtin' ? scenePack.sceneObjectPositive : customStyle;
    } else {
      identityBlocks = subs.map(function (s) {
        var seg = identitySegmentFor(s, n > 1);
        /* B2 图片锁脸约束句：按主体逐份、标注参考图编号与名字（§5），
           直接进身份层 —— 身份层不走 joinLayers 的按逗号切词去重，
           长句不会被拆碎。只是提示词引导，不是检测器。 */
        var ref = (opts.imageRefs || []).filter(function (r) {
          return r.key === refKeyFor(s);
        })[0];
        if (ref && seg) {
          seg += ' Reference image ' + ref.refNo + ' is ' + (s.name || 'this character')
            + '\'s face reference: use it only for facial identity and physical features '
            + '(face, hairstyle, hair color, skin, body type); where the text description '
            + 'and the reference conflict about appearance, follow the reference. '
            + 'Ignore the reference image for pose, expression, clothing, background '
            + 'and rendering style — the text description governs those.';
        }
        return seg;
      }).filter(Boolean);
      if (n === 1) {
        structure = singlePack.structure;
        frame = singlePack.frame[plan.shot] || '';
        if (styleMode === 'builtin') {
          /* 返修单 v2 §1：未知／其他性别**不再是拒绝理由** —— 走中性底座
             neutral-subject-v1（不填性别/年龄/物种/五官，外貌跟随设定）。
             男 / 女 → 各自的正式 v2 词（返修单 §3 最小保真修订版；
             实验旧词不进正式路径）。身份引用无效等真错误仍零请求拒绝。 */
          baseTag = subs[0].gender === 'male' ? '02-male-v2'
            : subs[0].gender === 'female' ? '02-female-c-v2' : '02-neutral-v1';
          visual = subs[0].gender === 'male' ? SLEEPY_FORMAL_MALE_LOOK_V2
            : subs[0].gender === 'female' ? SLEEPY_FORMAL_FEMALE_LOOK_V2
            : SLEEPY_NEUTRAL_SUBJECT_V1;
          if (baseTag === '02-neutral-v1') {
            /* 非人/未知性别主体的结构与负面最小适配（§2 审计）：person→subject，
               去掉人体脸型三连 —— 鱼尾不是缺腿，非人附肢不是人体错误。 */
            structure = SLEEPY_NEUTRAL_STRUCTURE_V1;
          }
        } else {
          baseTag = '02-custom';
          visual = customStyle;
        }
      } else {
        baseTag = (n === 2 ? '03' : '04') + (styleMode === 'custom' ? '-custom' : '');
        /* 03/04 内置视觉层（2026-10-01 用户找回原稿，见常量处注释）：
           builtin 按人数各追加一次（two→TWO_LOOK / 3~4→GROUP_LOOK）；
           custom 只透传用户词、不注入内置段。系统手部段恒空。 */
        structure = n === 2 ? TWO_SUBJECT_STRUCTURE : GROUP_SUBJECT_STRUCTURE;
        visual = styleMode === 'custom' ? customStyle
          : (n === 2 ? SLEEPY_FORMAL_TWO_LOOK_V1 : SLEEPY_FORMAL_GROUP_LOOK_V1);
      }
    }

    /* —— 层序拼装 —— */
    var global = joinLayers([plan.description, visual, (opts.extras || []).join(', ')]
      .filter(function (t) { return String(t || '').trim(); }));
    var positive = [
      scenePack.qualityPositive,
      structure,
      identityBlocks.join(', '),
      frame,
      global
    ].filter(Boolean).join(', ');

    /* —— 负面（§七：沿用已核准实验分支的负面组成，不混 legacy 整表）——
       01：质量 + 结构（排人）；02：质量 + 单人结构（定稿态 noAesthetic，
       中性档用中性负面）；03/04：只留质量负面。 */
    var negative = joinLayers([scenePack.qualityNegative,
      n === 0 ? scenePack.sceneObjectNegativeStructural
        : (n === 1 ? (baseTag === '02-neutral-v1'
          ? SLEEPY_NEUTRAL_NEGATIVE_V1
          : singlePack.negativeStructural) : '')
    ]);

    var debug = {
      path: 'formal',
      base: baseTag,
      visualVersion: baseTag,
      styleMode: styleMode,
      custom: customStyle ? '(有)' : '(空)',
      kind: kind,
      shot: plan.shot,
      personCount: n,
      expectedSubjectCount: plan.expectedSubjectCount,
      subjects: subs.map(function (s) {
        return { entityType: s.entityType, entityId: s.entityId, name: s.name,
          gender: s.gender || '(未填)', faceText: s.faceText ? '(有)' : '(空)' };
      }),
      handsVersion: 'off',
      positive: positive,
      negative: negative
    };
    if (typeof console !== 'undefined' && console.info) {
      console.info('[Sleepy][正式生图]', debug);
    }
    return { ok: true, positive: positive, negative: negative, debug: debug };
  }

  /* -------------------- NAI 正式编译器（2026-10-02 施工单） --------------------
     generate 的 plan 分流：general/chat → buildFormalPrompt；nai → 本函数。
     返回 { ok:true, request:{ positive, negative, v4Prompt?, v4NegativePrompt? } }
        | { ok:false, error } —— **没有 null 形态**：不支持的组合是明确报错，
     由 generate 零请求回传，绝不静默回落 legacy；编译抛错由 generate 的
     try/catch 兜住（同样零请求、不回落）。

     模型分支（只认 NAI_MODELS 现有四个，不扩新版本）：
     - nai-diffusion-3：只发 input + negative_prompt，不发任何 V4 字段；
       多人身份按**顺序描述**进 input（降级形态，非独立绑定，debug 标明）；
     - 其余（V4 / V4.5 full/curated）：另发 v4_prompt / v4_negative_prompt，
       每人一格 char_captions。

     接口预设消费（选 C 语义，2026-10-02 第二轮定稿）：
     - positivePreset / negativePreset **沿用现有消费契约**（与 legacy 同款：
       `api.xxx || BUILTIN_PRESET.nai.xxx`，空串/未配置都回填出厂词）——
       已有 NAI 接口的自定义预设词**不静默失效**，也不覆盖存储内容；
     - 预设**就是质量层**：本编译器不再另抄一份质量词，不会把同一套出厂词
       追加两遍；结构负面与预设负面做**词条级跨层去重**（dedupeTerms），
       重复的 watermark 等只出现一份；
     - ucPreset 维持 0（requestNai 现状）；不新增官方 UC 清单；
     - builtin/custom 视觉层与接口预设**分别处理**：视觉层只进 core，
       预设只当质量层，不混作一项。

     身份消费（subjects 来自上游 subjectForChar / subjectForUser，锁脸沿用）：
     - V4/V4.5：每人一格 char_captions（不带数字的 girl/boy + 该主体锁脸 tag；
       未知性别**不写性别词也不丢主体**——保留档位保顺序）；
     - V3：每人外貌按顺序进 input（已知性别配不带数字的 girl/boy；
       未知性别只写外貌）；
     - 人数 tag 只聚合**已知性别**：female/male 分别计数，1→'1girl'、
       ≥2→'Ngirls'；未知性别不贡献人数 tag（debug.countCoverage 记录）。
     ⚠️ 结构词只是文本引导，不是人数/绑定检测器；顺序连排不冒充已实现绑定。 */
  function buildFormalNaiRequest(opts) {
    opts = opts || {};
    var api = opts.api || {};
    var model = String(api.model || '');
    if (NAI_MODELS.indexOf(model) < 0) {
      return { ok: false, error: err('NAI 接口模型没配好，这张没有生成',
        '模型名是「' + (model || '(空)') + '」，不在支持的模型名单（'
        + NAI_MODELS.join(' / ') + '）里。不会回落旧拼接路径；去 设置 → 生图 补模型名。') };
    }
    var isV4 = model !== 'nai-diffusion-3';

    var v = validatePlanSubjects(opts.plan);
    if (!v.ok) return { ok: false, error: v.error };
    var plan = v.plan;
    var subs = v.subs;
    var n = v.n;

    var styleMode = IMG_STYLE_MODES.indexOf(opts.styleMode) >= 0
      ? opts.styleMode : imgStyleMode();
    var customStyle = String(opts.customStyle != null ? opts.customStyle : imgStyleCustom()).trim();

    /* —— 人数聚合（只数已知性别；未知性别不贡献、不丢主体） —— */
    var girls = 0, boys = 0, unknown = 0;
    subs.forEach(function (s) {
      if (s.gender === 'female') girls++;
      else if (s.gender === 'male') boys++;
      else unknown++;
    });
    function naiCountTag(c, one, many) {
      return c === 1 ? one : (c > 1 ? c + many : '');
    }
    var countTags = [naiCountTag(girls, '1girl', 'girls'),
      naiCountTag(boys, '1boy', 'boys')].filter(Boolean);

    /* —— 镜头 tag（只说取景；auto/未知 shot 不产词） —— */
    var NAI_FRAME = { auto: '', selfie: 'selfie, close-up', portrait: 'portrait, upper body',
      full: 'full body', candid: 'candid' };
    var frameTag = NAI_FRAME[plan.shot] || '';

    /* —— 视觉层（builtin 候选草案 / custom 透传；空串 = 合法空，不回退） —— */
    var visual;
    if (styleMode === 'custom') {
      visual = customStyle;
    } else if (n === 0) {
      visual = 'scenery, no humans, detailed background, soft lighting, highly detailed';
    } else if (unknown === n) {
      visual = 'detailed, soft lighting, detailed background';  /* 全未知性别：不塞人类词 */
    } else {
      visual = 'detailed face, detailed eyes, natural skin texture, soft lighting, detailed background';
    }

    /* —— 身份 / 主体段 —— */
    var coreHead = [];
    var subjectSegments = [];
    if (n === 0) {
      coreHead.push('no humans');
    } else if (n === 1) {
      coreHead.push('solo');
    } else if (countTags.length) {
      coreHead.push(countTags.join(', '));
    }
    if (frameTag) coreHead.push(frameTag);
    if (n === 1) {
      /* 单人：identitySegmentFor 自带 1girl/1boy + 锁脸，不再单独加人数 tag */
      subjectSegments.push(identitySegmentFor(subs[0], false));
    } else if (n > 1) {
      if (isV4) {
        /* V4：外貌进 char_captions，base 不重复身份段（人数 tag 已在 base） */
      } else {
        /* V3 顺序描述（降级）：每人 girl/boy（不带数字）+ 外貌 tag 按顺序连排；
           未知性别只写外貌。顺序近似，不是独立绑定。 */
        subs.forEach(function (s) {
          var bits = [];
          var gw = s.gender === 'female' ? 'girl' : (s.gender === 'male' ? 'boy' : '');
          if (gw) bits.push(gw);
          if (s.faceText) bits.push(String(s.faceText).replace(/^\s*,\s*/, ''));
          if (bits.length) subjectSegments.push(bits.join(', '));
        });
      }
    }
    if (subjectSegments.length) coreHead.push(subjectSegments.join(', '));

    var core = joinLayers(coreHead.concat([
      plan.description,
      visual,
      (opts.extras || []).join(', ')
    ]).filter(function (t) { return String(t || '').trim(); }));

    /* —— 接口预设 = 质量层（沿用现有消费契约：空/未配置回填出厂词） —— */
    var posPreset = api.positivePreset || BUILTIN_PRESET.nai.positive;
    var positive = posPreset.indexOf('{p}') >= 0
      ? posPreset.replace('{p}', core)
      : (core ? posPreset + ', ' + core : posPreset);

    var negPreset = api.negativePreset || BUILTIN_PRESET.nai.negative;
    /* 结构负面（按档；预设已带质量词，不再另抄质量词） */
    var structureNeg;
    if (n === 0) {
      structureNeg = '1girl, 1boy, human, person, face, portrait, selfie, watermark, logo, signature';
    } else if (n === 1 && unknown === 1) {
      structureNeg = 'extra person, duplicate person, watermark, signature, username, text';
    } else if (n === 1) {
      structureNeg = 'extra person, duplicate person, bad anatomy, deformed face, asymmetrical eyes, watermark, signature, username, text';
    } else {
      structureNeg = 'multiple views, out of frame, crowd, watermark, signature, text';
    }
    var negative = dedupeTerms(negPreset + ', ' + structureNeg);

    /* —— V4 请求字段（schema：image.V4ConditionInput / V4ExternalCaption /
       V4ExternalCharacterCaption；全部无 default —— 不用未验证默认：
       use_coords/use_order 显式传，centers / legacy_uc 省略不发；
       use_coords=false + use_order=true 是本地实现选择（不做坐标定位、
       按列表顺序，与官方多人文档的顺序行为一致），远端实际行为待真图验证） —— */
    var request = { positive: positive, negative: negative };
    if (isV4) {
      var charCaptions = subs.map(function (s) {
        var bits = [];
        var gw = s.gender === 'female' ? 'girl' : (s.gender === 'male' ? 'boy' : '');
        if (gw) bits.push(gw);
        if (s.faceText) bits.push(String(s.faceText).replace(/^\s*,\s*/, ''));
        return { char_caption: bits.join(', ') };
      });
      request.v4Prompt = {
        caption: { base_caption: positive, char_captions: charCaptions },
        use_coords: false,
        use_order: true
      };
      request.v4NegativePrompt = {
        caption: { base_caption: negative, char_captions: [] },
        use_coords: false,
        use_order: true
      };
    }

    var debug = {
      path: 'formal-nai',
      kind: 'nai',
      model: model,
      isV4: isV4,
      styleMode: styleMode,
      custom: customStyle ? '(有)' : '(空)',
      shot: plan.shot,
      personCount: n,
      girls: girls,
      boys: boys,
      unknown: unknown,
      countCoverage: unknown ? 'partial' : 'full',
      multiCharacter: !isV4 ? (n > 1 ? 'sequential-degraded' : 'single')
        : (n > 1 ? 'char_captions' : 'char_captions'),
      presetSource: {
        positive: api.positivePreset ? 'api' : 'builtin',
        negative: api.negativePreset ? 'api' : 'builtin'
      },
      positive: positive,
      negative: negative
    };
    if (typeof console !== 'undefined' && console.info) {
      console.info('[Sleepy][NAI 正式]', debug);
    }
    return { ok: true, request: request, debug: debug };
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

  /* --------------------- E2 单人角色视觉层本地实验 ---------------------
     01｜场景与物品已封板，本批**只加单人这一档**，两者常量互不覆写。
     实验字段同样只走 localStorage，不进接口配置 / 不进导出：
     - sleepy_img_single_exp_subject  'char:<id>' | 'user:<id>' | '@temp' | ''
                                      （空=没人走 01；@temp=临时单人，不读身份）
     - sleepy_img_single_exp_shot     auto | selfie | portrait | full | candid
     - sleepy_img_single_exp_hands    'unspecified' | 'visible' | 'hidden'
     - sleepy_img_single_exp_gender   临时单人的性别 '' | 'female' | 'male'

     主体有两**类**，实验函数里必须分得清清楚楚（2026-09-30 入口调整）：
     ① 真实身份（锁脸联调）：只认**本岛名册**（角色 / 我的马甲）经
        subjectForChar / subjectForUser 读出来的那一份。缺字段就空着（B1 口径），
        绝不静默换成别的身份。
     ② 临时单人（普通底座测试）：没有岛、没有角色、没有马甲时也能用。
        **不读任何真实身份**、不装成 entityType:'char'/'user'、不编 entityId、
        不落库；性别只在实验局部由 genderTagOf 生成，年龄/外貌/服装/动作
        全部交给「想画什么」那段 description。
     两条路都不靠 description 里的中英文关键词去「猜这里有个人」。 */
  var VISUAL_EXP_HANDS = ['unspecified', 'visible', 'hidden'];
  var SINGLE_EXP_SHOTS = ['auto', 'selfie', 'portrait', 'full', 'candid'];
  /* 与 genderTagOf / 角色卡下拉同一套真实枚举，不另造档位 */
  var TEMP_SINGLE_GENDERS = ['', 'female', 'male'];
  /* 临时单人在「主体」下拉里的哨兵值。它不是 entityType，也不是 id ——
     真身份分支永远不会看到它（page-imggen 在调实验函数前就分好路了）。 */
  var TEMP_SINGLE_REF = '@temp';

  /* 临时双人在「主体」下拉里的哨兵值（2026-10-01 · 03 临时双人测试入口）。
     与 TEMP_SINGLE_REF 同理：它不是 entityType、不是 id —— 真身份分支
     （buildSingleSubjectExperimentPrompt 的真实主体路）永远看不到它。
     ⚠️ 临时双人**不读任何角色 / 马甲资料**：人物外貌、年龄、衣着全由
     page-imggen 的「人物A / 人物B」两个独立输入框承载，只进下面这个
     buildTwoSubjectExperimentPrompt，不写真实角色存储，也不伪造 user/char 引用，
     不改 ImagePlan 契约。临时标签不构成跨图锁脸。 */
  var TEMP_TWO_REF = '@temp-two';

  /* 临时多人群像在「主体」下拉里的哨兵值（2026-10-01 · 04 临时多人群像测试）。
     与 TEMP_TWO_REF 同构：不是 entityType、不是 id。
     ⚠️ 多人**不读任何群岛 / 角色 / 马甲资料**：每个人的外貌、年龄、衣着由
     page-imggen 的「人物A/B/C(/D)」四个独立输入框承载，只进
     buildGroupSubjectExperimentPrompt，不写真实角色存储、不建岛、不伪造
     user/char 引用、不改 ImagePlan 契约。多人临时标签同样不构成跨图锁脸。 */
  var TEMP_GROUP_REF = '@temp-group';
  /* 本轮人数上下限：3～4 人。UI 只允许点到 4 就停，这里再硬拦一次
     （纯函数层兜底，不依赖页面）。 */
  var GROUP_MIN = 3;
  var GROUP_MAX = 4;
  var GROUP_LABELS = ['A', 'B', 'C', 'D'];

  function singleExpSubjectRef() {
    var v = store.get('sleepy_img_single_exp_subject');
    return typeof v === 'string' ? v : '';
  }
  function setSingleExpSubjectRef(ref) {
    return store.set('sleepy_img_single_exp_subject', String(ref || ''));
  }
  function singleExpShot() {
    var v = store.get('sleepy_img_single_exp_shot');
    return SINGLE_EXP_SHOTS.indexOf(v) >= 0 ? v : 'auto';
  }
  function setSingleExpShot(s) {
    return store.set('sleepy_img_single_exp_shot', SINGLE_EXP_SHOTS.indexOf(s) >= 0 ? s : 'auto');
  }
  function singleExpHands() {
    var v = store.get('sleepy_img_single_exp_hands');
    return VISUAL_EXP_HANDS.indexOf(v) >= 0 ? v : 'unspecified';
  }
  function setSingleExpHands(v) {
    return store.set('sleepy_img_single_exp_hands',
      VISUAL_EXP_HANDS.indexOf(v) >= 0 ? v : 'unspecified');
  }
  /* 临时单人的性别（真实枚举 '' / 'female' / 'male'）。只服务临时单人模式，
     选真实身份时这一项不参与 —— 身份带自己的 gender。 */
  function singleExpGender() {
    var v = store.get('sleepy_img_single_exp_gender');
    return TEMP_SINGLE_GENDERS.indexOf(v) >= 0 ? v : '';
  }
  function setSingleExpGender(g) {
    return store.set('sleepy_img_single_exp_gender',
      TEMP_SINGLE_GENDERS.indexOf(g) >= 0 ? g : '');
  }

  /* 单人视觉底座（02 实验草案，**不是正式替换词**）。
     按实施单「纠正补充 §五」落位，与草案原卡的差别都在这里：
     - 不写死 adult / rested，也不排皱纹、排疲态 —— 年龄、胡须、皮肤、
       疲态、表情一律以身份层为准，通用层不许反着改；
     - 男性校准只做「避免**额外**老化」，不强制年轻、无胡须或精神饱满；
     - 人物类不用 subtle imperfections（会被模型读成皱纹和粗糙）。
     必要质量层直接复用 01 的 SLEEPY_VISUAL_STYLE[].quality*（不另抄一份）。 */
  var SLEEPY_SINGLE_STYLE = {
    general: {
      structure: 'solo, exactly one person, single subject',
      /* 镜头层：只说取景，不带审美 —— custom 也保留（实施单 §十二） */
      frame: {
        auto: '',
        selfie: 'close-up selfie shot',
        portrait: 'half-body portrait',
        full: 'full-body shot',
        candid: 'candid shot'
      },
      /* 视觉审美层：仅 sleepy-default 消费 */
      look: {
        auto: 'natural realistic photography, believable proportions, natural posture, natural skin texture, soft natural light, realistic depth, soft natural color, visually pleasing but unposed',
        selfie: 'natural realistic photography, believable facial proportions, natural skin texture, clear relaxed eyes, relaxed facial muscles, soft natural light, realistic depth, soft natural color, visually pleasing but unposed',
        portrait: 'natural realistic portrait photography, believable facial proportions, natural skin texture, clear relaxed eyes, relaxed posture, soft directional light, realistic depth, natural color, visually pleasing but unposed',
        full: 'natural realistic full-body photography, believable body proportions, natural posture, relaxed shoulders, authentic clothing texture, believable spatial relationships, natural light, realistic depth, soft natural color, visually pleasing but unposed',
        candid: 'natural realistic candid photography, believable facial and body proportions, natural skin texture, relaxed posture, authentic movement, soft natural light, realistic depth, lived-in atmosphere, soft natural color, visually pleasing but unposed'
      },
      malePositive: 'defined but not weathered features, facial hair only when specified by the identity description',
      maleNegative: 'unintended aging, unintentionally weathered face, overly rugged features, thick beard when unspecified',
      handsPositive: 'well-proportioned hands, naturally long fingers, subtle visible knuckle definition, relaxed graceful hand posture, clean natural nails, realistic hands that interact naturally with nearby objects',
      /* custom 版：只留「不改身份的比例 / 接触关系」这类结构要求 ——
         「修长、骨感、干净指甲」是 sleepy-default 的审美方向，不是结构。 */
      handsStructure: 'well-proportioned hands, relaxed natural hand posture, realistic hands that interact naturally with nearby objects',
      negativeStructural: 'extra person, duplicate person, random passerby, unwanted character, deformed face, asymmetrical eyes, distorted facial proportions, text, watermark, logo',
      negativeAesthetic: 'plastic skin, overly airbrushed skin, stiff pose, forced smile'
    },
    nai: {
      structure: 'solo, exactly one character, single subject',
      frame: {
        auto: '',
        selfie: 'close-up selfie shot',
        portrait: 'half-body portrait',
        full: 'full-body shot',
        candid: 'candid shot'
      },
      look: {
        auto: 'natural slice-of-life illustration, believable proportions, natural posture, natural skin rendering, gentle natural lighting, harmonious natural colors, grounded and unembellished',
        selfie: 'natural slice-of-life illustration, believable facial proportions, natural skin rendering, clear relaxed eyes, relaxed facial muscles, gentle natural lighting, tactile materials, harmonious natural colors, grounded and unembellished',
        portrait: 'natural character portrait illustration, believable facial proportions, natural skin rendering, clear relaxed eyes, detailed but unexaggerated features, relaxed posture, gentle directional lighting, harmonious natural colors, grounded and unembellished',
        full: 'natural full-body slice-of-life illustration, believable body proportions, natural posture, relaxed shoulders, tactile clothing materials, believable spatial relationships, gentle natural lighting, grounded composition, harmonious natural colors, unembellished',
        candid: 'natural candid slice-of-life illustration, believable facial and body proportions, natural skin rendering, relaxed posture, authentic movement, gentle natural lighting, detailed environment, tactile materials, grounded and unembellished'
      },
      malePositive: 'defined but not weathered features, facial hair only when specified by the identity description',
      maleNegative: 'unintended aging, unintentionally weathered face, overly rugged features, thick beard when unspecified',
      handsPositive: 'well-proportioned hands, naturally long fingers, subtle visible knuckle definition, relaxed elegant hand posture, clean natural nails, realistic hands that interact naturally with nearby objects',
      handsStructure: 'well-proportioned hands, relaxed natural hand posture, realistic hands that interact naturally with nearby objects',
      negativeStructural: 'extra person, duplicate character, random character, unwanted figure, deformed face, asymmetrical eyes, distorted facial proportions, text, watermark, logo',
      negativeAesthetic: 'plastic skin, stiff pose, forced smile'
    }
  };

  /* General · 临时单人 · 显式 male · sleepy-default 的**替换**视觉底座
     （2026-09-30 施工单 v2 §5：用户在 custom 实验里认可后迁回来的原文，逐字保存）。
     ⚠️ 它是**替换**旧的 general.look[shot]，不是叠加 —— 路由见 tempMaleLookOn。
     只服务「试一张实验 + General + sleepy-default + 临时单人 + 显式 male」这一条路；
     女性 / 性别未指定 / NAI / 真实身份 / 01 无人 / legacy / custom 全部维持现状。
     这里的 daylight、发型与面部设计会形成默认倾向：夜景、既定发型脸型属于
     **后续保真适配项**，本轮不把它声明成适配所有场景与身份的通用规则，
     也不把窗边 / 灰衣服 / 25 岁 / 花束 / 摩托车这些测试内容写进默认常量。
     段落之间的换行按拼接器的空白规范合成一个空格，其余逐字未改。 */
  var SLEEPY_TEMP_MALE_LOOK = [
    'A beautifully idealized adult male face with a photorealistic finish, combining the refined facial beauty of a romance illustration with believable human skin and dimensionality.',
    'An elegantly tapered facial outline, softly sculpted cheekbones, a clean and refined jawline, and a well-proportioned chin that is neither broad nor excessively pointed. Elongated almond-shaped eyes with clearly defined eyelids, subtly emphasized lash lines, expressive dark irises, and delicately shaped eyebrows. A straight, finely defined nose bridge with a neat, softly sculpted tip. Beautifully shaped lips with a distinct cupid\'s bow and a softly full lower lip.',
    'A balance of delicate beauty and adult masculine definition, with harmonious facial proportions and a distinctive, memorable appearance. Fine, even skin texture, subtle natural translucency, and polished beauty retouching. Airy, layered hair softly framing the face.',
    'Prioritize exquisite facial design and visual appeal while retaining the stated age. Keep the face photographic rather than drawn, with soft dimensional daylight and believable everyday surroundings.'
  ].join(' ');

  /* 女性定稿底座（2026-10-01）：用户在多张真图投票后定稿选的 C 版，逐字保存。
     适用面与男性那一份**完全对称**：试一张实验 + General + sleepy-default
     + 临时单人 + 显式 female，命中即**替换**旧的 general.look[shot]（不是叠加）。
     命中之外的分支（性别未指定 / NAI / 真实身份 / custom 之外的一切）维持现状。

     这段正文已经写死「Follow the description … do not replace them with a
     default face」—— 即用户要求强调的**设定优先**，不另补一条重复的词，
     程序也不对描述里的外貌做二次改写。

     ⚠️ 三点如实标注，别当成通用规则往外扩：
     1. 它写死 `adult woman` 与 `East Asian` 默认族裔 —— 只服务这条实验分支，
        真实身份保真适配、未成年人、其他族裔默认都是**后续项**；
     2. 命中后负面**仍沿用 sleepy-default 那套审美负面**（plastic skin / stiff pose 等），
        与男性分支的 noAesthetic 不同 —— 本轮只替换视觉层，负面不动；
     3. `cinematic photograph` / `depth of field` 会把夜景或既有构图往电影感推，
        与男性那一份同理，属**后续保真适配项**，本轮不声明为通用规则。（上面那段正文
        里的双空格是 C 版原文自带，逐字保留，拼接时会按空白规范合成单空格。） */
  var SLEEPY_TEMP_FEMALE_LOOK = 'A cinematic photograph of a strikingly beautiful adult woman, with the idealized, refined visual appeal of a lead actress in a live-action romance drama or a live-action anime adaptation. Realistic photography, not illustration.  Follow the description for facial features, hairstyle, makeup, outfit, expression and mood; do not replace them with a default face. Render whatever is described at its most attractive and harmonious: balanced, delicate proportions, clear expressive eyes, and clean, luminous skin with soft natural texture, polished but never plastic. Keep makeup light and natural unless the description says otherwise.  Natural, flattering light that belongs to the scene, soft photographic rendering with a gentle film-like quality, and natural depth of field. She feels caught in a genuine moment within a real, detailed environment. If ethnicity is not specified, default to an East Asian appearance.';

  /* --------------------- 正式生图底座 v2（2026-10-01 返修单 v2 §2/§3） ---------------------
     与上面两份实验历史词**分开版本化**：旧词原样保留、只服务实验路径（tempLookOn 那套），
     正式路径（buildFormalPrompt）只消费下面三份。三份都是**新正式候选，未做真图验收**，
     不冒称延续旧真图结论；新旧全文与差异见《验收-正式生图接入返修-v2.md》。

     男性正式 v2 —— 以实验胜出全文为底的最小保真修订（返修单 §3 锚点逐句）：
     - 删除整段写死脸型 / 眼形 / 鼻唇 / 发型的特征模板，换成身份优先句；
     - adult male face → described male character's face；
     - delicate beauty and adult masculine definition → refined beauty and the character's described appearance；
     - 删除 Airy, layered hair softly framing the face.；
     - soft dimensional daylight → soft dimensional lighting consistent with the described scene；
     - 保留 retaining the stated age（不根据缺字段自动补成年）。 */
  var SLEEPY_FORMAL_MALE_LOOK_V2 = [
    'A beautifully idealized described male character\'s face with a photorealistic finish, combining the refined facial beauty of a romance illustration with believable human skin and dimensionality.',
    'Preserve the supplied facial structure, eye shape, nose, lips, hairstyle, proportions, and distinguishing features. Refine their rendering without replacing them with a default face.',
    'A balance of refined beauty and the character\'s described appearance, with harmonious facial proportions and a distinctive, memorable appearance. Fine, even skin texture, subtle natural translucency, and polished beauty retouching.',
    'Prioritize exquisite facial design and visual appeal while retaining the stated age. Keep the face photographic rather than drawn, with soft dimensional lighting consistent with the described scene and believable everyday surroundings.'
  ].join(' ');

  /* 女性 C 正式 v2 —— 同为最小保真修订（返修单 §3）：
     - strikingly beautiful adult woman → strikingly beautiful female character；
     - 删除整句 East Asian 族裔兜底；
     - balanced, delicate proportions → the character's stated proportions；
     - clear expressive eyes → faithfully rendered eyes；
     - clean, luminous skin with soft natural texture → the described complexion with soft natural texture；
     - 删除默认妆容句（Keep makeup light…）。摄影美感与贴合场景光线的方向保留。 */
  var SLEEPY_FORMAL_FEMALE_LOOK_V2 = 'A cinematic photograph of a strikingly beautiful female character, with the idealized, refined visual appeal of a lead actress in a live-action romance drama or a live-action anime adaptation. Realistic photography, not illustration. Follow the description for facial features, hairstyle, makeup, outfit, expression and mood; do not replace them with a default face. Render whatever is described at its most attractive and harmonious: the character\'s stated proportions, faithfully rendered eyes, and the described complexion with soft natural texture, polished but never plastic. Natural, flattering light that belongs to the scene, soft photographic rendering with a gentle film-like quality, and natural depth of field. She feels caught in a genuine moment within a real, detailed environment.';

  /* 中性审美层 neutral-subject-v1（返修单 §2，本轮原创候选，尚未真图验收）：
     适用于缺适用男女底座的单主体（性别未指定 / 非二元）或明确非人形态。
     它**不填**身份、性别、年龄、物种或五官 —— 外貌跟随设定；也不能用于
     custom 档（custom 只透传用户词，不注入此词）。只加一次，与人数结构分开。 */
  var SLEEPY_NEUTRAL_SUBJECT_V1 = [
    'Render the described subject with exceptional visual appeal and a carefully crafted photographic finish. Preserve the supplied identity, apparent age, species, body plan, proportions, facial features where present, and distinguishing traits; do not replace them with a standardized human appearance.',
    'Bring refinement and expressive detail to the subject as described, with convincing dimensionality, nuanced surface texture, and coherent materials. Where skin, hair, scales, fur, or other surfaces are described, render those surfaces faithfully rather than substituting a default complexion or material.',
    'Use flattering illumination motivated by the actual scene and its light sources. Preserve the requested framing, expression, action, mood, and environment. The image should feel vivid, visually compelling, and cohesive without imposing a gender, an adult age, a human anatomy, a daylight setting, or an unrequested relationship.'
  ].join(' ');

  /* 中性主体配套（返修单 §2 的结构 / 负面审计，最小适配，不建全物种库）：
     - 结构：'person' → 'subject'（单主体不一定等于 one human person）；
     - 负面：去掉人体脸型三连（deformed face / asymmetrical eyes /
       distorted facial proportions —— 鱼尾不是缺腿，非人附肢不能被机械
       当成人体错误），保留防增人 / 防杂人 / 防水印。 */
  var SLEEPY_NEUTRAL_STRUCTURE_V1 = 'solo, exactly one subject, single subject';
  var SLEEPY_NEUTRAL_NEGATIVE_V1 = 'extra person, duplicate person, random passerby, unwanted character, text, watermark, logo';

  /* ---- 03 双人 / 04 多人 内置视觉层（2026-10-01 深夜用户找回原稿，逐字落库）----
     用户确认这两段与 03/04 真图验证时所用的 custom 视觉原文**一致**——
     同时更正此前两份报告「真图验证时 custom 为空」的表述：那是无依据推断，作废。
     版本化：SLEEPY_FORMAL_TWO_LOOK_V1（03）/ SLEEPY_FORMAL_GROUP_LOOK_V1（04）。
     消费规则：**仅**正式 builtin、主体校验全部通过后，按 2 人 / 3～4 人分别
     追加**一次**；人数结构、独立身份块、画面描述照旧在前，审美词不替代结构词。
     custom 档不注入这两段（custom 只透传用户词），也不覆盖用户已存的自定义文本。
     不拼男女单人词 / 中性词；系统手部附加段仍恒空；旧实验记录与实验路径不动。
     ⚠️ 两段含 human presence 与面部/皮肤表达 —— 只证明人物画面形态；
     不能据此宣称**非人形态**的 03/04 已验收；与明确非人设定的适用性冲突
     单列回报，不偷偷改写原稿。 */
  var SLEEPY_FORMAL_TWO_LOOK_V1 = [
    'A beautifully crafted cinematic photograph of the two described people, with refined, subtly idealized visual appeal and believable human presence. Realistic photography, not illustration.',
    'Preserve each person\'s stated age, ethnicity, facial features, hairstyle, body type, makeup, clothing, expression, and distinguishing traits. Bring out the individual beauty of each person without replacing their features with a standard face or making them look younger than described. Render both people with equally careful facial detail and soft, convincing dimensionality. Skin has natural texture and translucency, polished but never plastic.',
    'Use flattering photographic light that belongs to the described scene, with coherent color, shadows, and material detail across both people and their surroundings. Adapt the framing and depth of field to the requested composition, keeping both people\'s faces readable. Let the scene description determine the mood and interaction, with the feeling of a shared moment in a real, detailed environment.'
  ].join(' ');

  var SLEEPY_FORMAL_GROUP_LOOK_V1 = [
    'A beautifully crafted cinematic photograph of the described people, with refined, subtly idealized visual appeal and believable human presence. Realistic photography, not illustration.',
    'Preserve each person\'s stated age, ethnicity, facial features, hairstyle, body type, makeup, clothing, expression, and distinguishing traits. Bring out the individual beauty of each person without replacing their features with a standard face or making them look younger than described. Render every person with equally careful facial detail and soft, convincing dimensionality. Skin has natural texture and translucency, polished but never plastic.',
    'Use flattering photographic light that belongs to the described scene, with coherent color, shadows, and material detail across the people and their surroundings. Adapt the framing and depth of field to the requested composition, keeping every person\'s face readable. Let the scene description determine the mood and interaction, with the feeling of a shared moment in a real, detailed environment.'
  ].join(' ');


  /* ⚠️ 已退休 —— **当前不参与任何拼接**（2026-10-01 定点返修）。
     前身是 09-30 的临时男性手部候选段，10-01 短暂当过「全分支唯一手部段」，
     返修后回到「关闭」状态：visibleHandsText 一律 return ''，
     各分支不追加、旧的 general/nai handsPositive 与 handsStructure
     也**不拿来补位**，本段同样不补位。

     退休原因（两段都在同一份返修单里）：
     1. 男性那一路已经定在「额外手部词返回空串」这个最终状态上，
        把统一段推广全分支与「同步男性最终状态」不是一回事，已回退；
     2. 关键结构约束 `well-proportioned hands, relaxed natural hand posture,
        realistic hands that interact naturally with nearby objects`
        （原 handsStructure）失去唯一出处 —— 已单列回报，**不自行重写补词**。

     常量本身原样留着（含导出）当历史对照与重新启用位置，
     不删、不改、不新增替代段，也不新增手部负面词。
     动作归属始终由本次 description 决定 —— 不把「比耶」写进任何通用底座。 */
  var SLEEPY_HANDS_UNIFIED = 'Anatomically coherent hands with balanced palm and finger proportions, softly modeled finger pads and natural joint contours. Hand and finger skin tones consistent with the person\'s complexion and the scene\'s lighting, with continuous natural shading from wrist to fingertips. A natural execution of the described gesture, with believable finger spacing and bending.';

  /* 路由判定（施工单 v2 §3）—— **唯一出口**，别在别处再抄一份：
     试一张实验路径 + General 接口 + sleepy-default + 临时单人 + 显式 male。
     少一个条件就退回原来的视觉层；MALE_CALIBRATION_ENABLED 仍然 false，
     与这组新词无关（那是旧防老校准，本单不重新启用）。 */
  /* 两个底座路由的**共同实现**（2026-10-01 女性 C 版定稿后拆出来的），
     **唯一出口**，别在别处再抄一份：
     试一张实验路径 + General 接口 + sleepy-default + 临时单人 + 显式性别。
     少一个条件就退回原来的视觉层；MALE_CALIBRATION_ENABLED 仍然 false。 */
  function tempLookOn(opts, gender) {
    opts = opts || {};
    return opts.tempSingle === true && opts.gender === gender
      && opts.visualMode === 'sleepy-default'
      && !(opts.api && opts.api.kind === 'nai');
  }
  function tempMaleLookOn(opts) { return tempLookOn(opts, 'male'); }
  function tempFemaleLookOn(opts) { return tempLookOn(opts, 'female'); }

  /* 视觉层版本标签：给 UI 的「本次生成参数」显示用（走同一个判定，不另写一份） */
  function singleVisualLayerOf(opts) {
    opts = opts || {};
    var mode = VISUAL_EXP_MODES.indexOf(opts.visualMode) >= 0 ? opts.visualMode : 'legacy';
    if (mode === 'legacy') return 'legacy';
    if (tempMaleLookOn(opts)) return 'temp-male-v2';
    if (tempFemaleLookOn(opts)) return 'temp-female-c';
    return mode;
  }

  /* 单人视觉层：只产「怎么画」，不产「画的是谁」。
     custom → 透传用户词；空串的含义是「没有额外审美词」，**不是**回退 Sleepy 默认。 */
  function singleSubjectVisualStyleText(apiKind, shot, visualMode, customText) {
    if (visualMode === 'custom') return String(customText || '').trim();
    if (visualMode !== 'sleepy-default') return '';
    var pack = SLEEPY_SINGLE_STYLE[apiKind] || SLEEPY_SINGLE_STYLE.general;
    return pack.look[shot] || pack.look.auto || '';
  }

  /* 男性默认变老校准 —— **当前是关着的**（2026-09-30 返修）。
     为什么关：这两组词只按 `gender === 'male'` 就注入，而「这个角色到底
     有没有被明确写成年长 / 有胡须 / 沧桑 / 疲惫」目前**没有可靠的结构化依据**
     —— 手上只有一串自由文本（faceText / description）。这种条件下注入
     `facial hair only when specified…`、`unintended aging`、`thick beard
     when unspecified` 就是拿通用层去**反向覆盖身份事实**；
     `when unspecified` 只是把判断丢给模型，不等于程序完成了条件判断，
     「身份词还在字符串里」也不能证明它没被反向词覆盖。
     → 本轮让 malePositive / maleNegative **两种模式都不进最终 prompt**，
       函数与常量原样留在这儿当扩展位置：等有了结构化依据（年龄档 / 胡须字段 /
       冲突检测）再打开，到时候只动 MALE_CALIBRATION_ENABLED 和这两个函数。
     ⚠️ 这只是暂停有冲突风险的词，**不是取消「男性不额外老化」的审美目标**
     —— General 真图仍然按年龄感观察，后续拿真图结果定向调整。 */
  var MALE_CALIBRATION_ENABLED = false;

  /* 性别校准（扩展位置）：只看这个 subject 自己存的 gender
     （真实值 '' / 'female' / 'male'，见 genderTagOf），不看 sender、
     不看描述关键词。male 才追加，female / 未填 → 空。 */
  function singleSubjectGenderAdjustment(apiKind, subject) {
    if (!MALE_CALIBRATION_ENABLED) return '';
    var s = subject || {};
    if (s.gender !== 'male') return '';
    var pack = SLEEPY_SINGLE_STYLE[apiKind] || SLEEPY_SINGLE_STYLE.general;
    return pack.malePositive;
  }
  function singleSubjectGenderNegative(apiKind, subject) {
    if (!MALE_CALIBRATION_ENABLED) return '';
    var s = subject || {};
    if (s.gender !== 'male') return '';
    var pack = SLEEPY_SINGLE_STYLE[apiKind] || SLEEPY_SINGLE_STYLE.general;
    return pack.maleNegative;
  }

  /* 手部质量层（**唯一出口**：imggen.js buildSingleSubjectExperimentPrompt
     的 positive 层序里调它，全部分支都从这一处走，改这里＝全分支生效）。

     ⚠️ 当前行为（2026-10-01 定点返修后）：**恒返回空串**，与 hands 取值无关。
     `unspecified / hidden / visible` 三种都不追加任何系统手部词 ——
     这里不再存在「只有手可见才给词」的旧逻辑，别再按那个旧注释去改。

     关闭范围只限**当前单人实验拼接路径**（buildSingleSubjectExperimentPrompt）。
     legacy 路径（buildPromptForPlan）不走本函数，它自己的既有逻辑未动：
     防多余肢体那串（extra fingers / fewer digits / extra limbs / malformed limbs）
     仍在 BUILTIN_PRESET.general.negative 里，只进 legacy。

     实际效果：hands 选项**不独立产生手部要求**；画面里手的出现与动作
     由 description / 用户自定义视觉词（custom）／身份资料里的手部描述承载，
     本函数不改写它们，也不新增任何替代手部段或手部负面词。
     hands=visible 的**意图照旧记录**（UI 下拉、debug.hands、参数回显仍是
     visible），只是「系统附加的手部词」这一层为空 —— 不许把 visible 改写成
     hidden 来假装关闭。 */
  function visibleHandsText(apiKind, hands, visualMode) {
    return '';
  }

  /* 单人负面：结构负面（防随机增人 / 崩脸）两种模式都保留；
     审美型负面（塑料皮肤、僵硬摆拍）只 sleepy-default 注入。
     男性校准负面：走 singleSubjectGenderNegative，当前被
     MALE_CALIBRATION_ENABLED 关着（见上面的说明），两种模式都不注入 ——
     它一旦打开就可能在两种模式里反向覆盖身份事实，所以**不跟着 custom 走**，
     也不算「结构约束」。

     noAesthetic=true → 只要「必要质量负面 + 结构负面」这一份（施工单 v2 §6：
     新男性分支沿用 custom 的负面组成，不叠加旧默认 negativeAesthetic，
     也不新增负面词；其他分支不受影响）。 */
  function singleSubjectNegativeText(apiKind, subject, visualMode, noAesthetic) {
    var pack = SLEEPY_SINGLE_STYLE[apiKind] || SLEEPY_SINGLE_STYLE.general;
    var layers = [pack.negativeStructural];
    if (visualMode === 'sleepy-default' && !noAesthetic) layers.push(pack.negativeAesthetic);
    var male = singleSubjectGenderNegative(apiKind, subject);
    if (male) layers.push(male);
    return layers.filter(Boolean).join(', ');
  }

  /* 单人实验拼接（实施单 §四 层序）：
     positive = [必要质量层] + [单人主体结构] + [身份/性别层] + [面部状态校准]
              + [镜头取景] + [description] + [视觉层(默认底座|自定义)] + [手部层] + [extras]
     negative = [必要负面] + [结构负面] +（仅 sleepy-default）[审美负面]
     第 4 层「面部状态校准」= singleSubjectGenderAdjustment，当前由
     MALE_CALIBRATION_ENABLED 关着（返回空串），**层位保留、词不注入**。

     主体两类，**显式分开、互不冒充**（2026-09-30 入口调整）：
     - opts.tempSingle === true → 临时单人：不看也不读 opts.subjects，
       性别只取 opts.gender（真实枚举 ''|'female'|'male'）经 genderTagOf，
       身份段**只有性别 tag**，没有 entityType / entityId / 锁脸；
     - 否则 → 真实身份：必须恰好 1 个主体，且 entityType 是 user / char
       （npc 不是 B0 主体类型，返回 null，不伪装成 char），
       身份段整段复用 B0 的 subjectTextForPlan（含 B1 锁脸），
       **永不参与跨层去重**。
     两种模式的其余层（质量 / 单人结构 / 镜头 / 视觉 / 手部 / extras）完全一致。

     守卫：legacy → null；真实身份分支不满足条件 → null，调用方走旧路。 */
  function buildSingleSubjectExperimentPrompt(opts) {
    opts = opts || {};
    var mode = VISUAL_EXP_MODES.indexOf(opts.visualMode) >= 0 ? opts.visualMode : 'legacy';
    if (mode === 'legacy') return null;

    var temp = opts.tempSingle === true;
    var subject = null;   /* 真实身份分支用；临时分支保持 null，绝不造一个假主体 */
    var gender = '';
    if (temp) {
      gender = TEMP_SINGLE_GENDERS.indexOf(opts.gender) >= 0 ? opts.gender : '';
    } else {
      var subjects = Array.isArray(opts.subjects) ? opts.subjects : [];
      if (subjects.length !== 1) return null;
      var raw = subjects[0] || {};
      var entityType = (raw.entityType === 'user') ? 'user'
        : (raw.entityType === 'char') ? 'char' : '';
      if (!entityType) return null;
      subject = {
        entityType: entityType,
        entityId: String(raw.entityId || ''),
        name: String(raw.name || ''),
        gender: String(raw.gender || ''),
        faceText: String(raw.faceText || '').trim()
      };
      gender = subject.gender;
    }

    var api = opts.api || {};
    var kind = (api.kind === 'nai') ? 'nai' : 'general';
    var pack = SLEEPY_SINGLE_STYLE[kind];
    var shot = SINGLE_EXP_SHOTS.indexOf(opts.shot) >= 0 ? opts.shot : 'auto';
    /* 临时单人：身份层只有性别 tag；真实身份：走 B0 的 subjectTextForPlan（含 B1 锁脸） */
    var identity = temp ? genderTagOf(gender) : subjectTextForPlan({ subjects: [subject] });
    /* 施工单 v2 §3/§6：只有「临时单人 + 显式 male + General + sleepy-default」
       用男性底座**替换**旧的 look[shot]（不是叠加），负面也退回 custom 那一套。
       2026-10-01 女性定稿 C 版：**同一个判定**再挂一条 female 分支
       （见 tempLookOn / tempFemaleLookOn），同样替换 look[shot]。
       负面（本轮收尾）：女性 C 与 custom C **对齐** —— 命中时 both 传
       noAesthetic=true，同样只留「必要质量负面 + 结构负面」，不追加
       negativeAesthetic（plastic skin / overly airbrushed skin / stiff pose /
       forced smile 这一组），与男性分支一致。
       ⚠️ 这是**只作用于 femaleLook 这一次传参**，不是改 negativeAesthetic 常量、
       也不是放开 maleLook：男性分支仍由 maleLook 单独命中。 */
    var maleLook = tempMaleLookOn(opts);
    var femaleLook = tempFemaleLookOn(opts);

    var positive = joinLayers([
      SLEEPY_VISUAL_STYLE[kind].qualityPositive,
      pack.structure,
      identity,
      singleSubjectGenderAdjustment(kind, { gender: gender }),
      pack.frame[shot] || '',
      opts.description,
      maleLook ? SLEEPY_TEMP_MALE_LOOK
        : femaleLook ? SLEEPY_TEMP_FEMALE_LOOK
        : singleSubjectVisualStyleText(kind, shot, mode, opts.customVisualStyle),
      visibleHandsText(kind, opts.hands, mode),
      (opts.extras || []).join(', ')
    ]);
    var negative = joinLayers([
      SLEEPY_VISUAL_STYLE[kind].qualityNegative,
      singleSubjectNegativeText(kind, { gender: gender }, mode, maleLook || femaleLook)
    ]);
    var debug = {
      mode: mode, kind: kind, shot: shot, hands: opts.hands || 'unspecified',
      visualLayer: femaleLook ? 'temp-female-c' : (maleLook ? 'temp-male-v2' : mode),
      /* 手部词版本（2026-10-01 定点返修后只剩两态，与实际空串行为一致）：
         off=系统附加手部段已关闭（visible 也返回空串，各分支一视同仁）
         / none=一个字都没加（hidden 或 unspecified）。
         ⚠️ 这是「系统有没有追加手部词」的状态，**不是** hands 的选择状态 ——
         hands 仍按 opts.hands 原始记录，不许把 visible 改写成 hidden。 */
      handsVersion: (opts.hands !== 'visible') ? 'none' : 'off',
      subjectSource: temp ? 'temp-single' : 'identity',
      entityType: temp ? '(临时单人，不读身份)' : subject.entityType,
      entityId: temp ? '' : subject.entityId,
      gender: gender || '(未填)',
      faceText: temp ? '(不适用)' : (subject.faceText ? '(有)' : '(空)'),
      positive: positive, negative: negative
    };
    if (typeof console !== 'undefined' && console.info) {
      console.info('[Sleepy][单人视觉实验]', debug);
    }
    return { positive: positive, negative: negative, debug: debug };
  }

  /* -------------------- 临时双人实验拼接（03 勘察后新增） --------------------
     buildTwoSubjectExperimentPrompt(opts) → { positive, negative, debug } | null

     返回形状与 buildSingleSubjectExperimentPrompt **完全一致**
     （generateBuilt 直接吃 positive/negative，网络栈不另写一套），
     但它是**独立实现**：单人那条路一个字没动，subjects.length !== 1 的守卫
     也**没有放宽** —— 双人不是「把单人放宽成两个」，是另一条实验路。

     输入契约（**仅限本函数**，别拿去套正式 ImagePlan）：
       opts.tempTwo       === true（必须显式声明是临时双人）
       opts.tempSubjects  = [{ label:'A', description:'…' }, { label:'B', description:'…' }]
       opts.description   共同画面描述（位置 / 视线 / 动作 / 接触写在里面，
                          用「人物A / 人物B」指代；没有专用结构位，就是自然语言承担）
       opts.visualMode   === 'custom'（本轮双人**只**支持 General + custom）
       opts.customVisualStyle 用户自定义视觉词（可空；空 = 没有额外审美词，不回退）
       opts.extras       勾选的词条
       opts.api.kind     === 'general'

     守卫（缺一项 → null；UI 显示原因，**一次请求都不发**，不静默减员）：
       legacy / 非 custom 模式、NAI 或非 General 接口、tempTwo 不是 true、
       人物数不是恰好 2、任一人物的描述为空、共同画面描述为空。
     ⚠️ 不许 filter 掉空的那个人物后继续出图；一人 / 三人一律拒绝。
        两人描述完全相同**不算无效**（可能是双胞胎），A / B 两段各自独立保留。

     positive 层序（施工单 03 §二）：
       [General qualityPositive] + [双人结构约束] + [Person A 块] + [Person B 块]
       + [Scene 块（共同描述原文）] + [自定义视觉词] + [extras]
     两个人物块**各自一层**、不互相覆盖、不做整块去重；用户原文不被自动补改。
     「画面描述」这一层就是 Scene 块本身，不重复再拼一遍描述（避免同一句出现两次）。

     negative：**只**复用 SLEEPY_VISUAL_STYLE.general.qualityNegative。
       不沿用单人的 negativeStructural（含 extra person），也不沿用 legacy 整表 ——
       本轮把人数与身份约束放在正向，免得「负面字段支持情况未知」变成「完全没有人数要求」。
       那张 legacy 表里 old / elderly / wrinkle 与明确年长主体存在语义方向冲突
       （见《验收-03双人关系图前置勘察-v1.md》），本轮**不删任何常量**，只是这条路不取用。

     ⚠️ 这段是**文本引导**，不是串脸 / 人数 / 动作检测器：
       两人是否真被画出来、手有没有归到对的人，只有真图能判断，本函数不声称能做到。

     系统手部附加段**恒空**：不恢复 handsPositive / handsStructure / SLEEPY_HANDS_UNIFIED，
     也不拼男女两个单人底座（那是单人实验的事）。用户描述与 custom 原文里
     自带的手部内容照常保留，本函数不改写、不补词。 */
  var TWO_SUBJECT_STRUCTURE = 'Exactly two people are present in the image: Person A and Person B. Keep each person\'s described appearance and clothing associated with that person. Follow the scene description for their positions, expressions, gaze, actions, and any physical contact. Do not add other people or invent a relationship or physical contact that is not described.';

  function buildTwoSubjectExperimentPrompt(opts) {
    opts = opts || {};
    /* 本轮双人只走 experimental 两档里的 custom（施工单 §一 4 / §二 守卫） */
    var mode = VISUAL_EXP_MODES.indexOf(opts.visualMode) >= 0 ? opts.visualMode : 'legacy';
    if (mode !== 'custom') return null;

    var api = opts.api || {};
    var kind = (api.kind === 'nai') ? 'nai' : 'general';
    if (kind !== 'general') return null;          /* 本轮不展开 NAI / 其他接口 */
    if (opts.tempTwo !== true) return null;        /* 必须显式「临时双人」 */

    var subs = Array.isArray(opts.tempSubjects) ? opts.tempSubjects : [];
    if (subs.length !== 2) return null;            /* 恰好两个，不多不少 */
    function descOf(v) {
      if (!v) return '';
      return String(v.description != null ? v.description : v.text || '').trim();
    }
    var a = descOf(subs[0]);
    var b = descOf(subs[1]);
    if (!a || !b) return null;                     /* 两个人物描述都必须非空 */
    var scene = String(opts.description || '').trim();
    if (!scene) return null;                       /* 共同画面描述非空 */

    var customText = String(opts.customVisualStyle || '').trim();
    var positive = joinLayers([
      SLEEPY_VISUAL_STYLE[kind].qualityPositive,
      TWO_SUBJECT_STRUCTURE,
      'Person A（人物A）: ' + a,
      'Person B（人物B）: ' + b,
      'Scene（画面描述）: ' + scene,
      customText,
      (opts.extras || []).join(', ')
    ]);
    /* 系统负面只有必要质量负面 —— 理由见函数头（人数/身份约束放正向） */
    var negative = joinLayers([SLEEPY_VISUAL_STYLE[kind].qualityNegative]);

    var debug = {
      mode: mode,
      kind: kind,
      /* 本轮镜头固定「按画面描述」，不产出任何隐含镜头词（连 shot 都是 auto） */
      shot: 'auto',
      visualLayer: 'custom',
      customVisual: customText ? '(有)' : '(空)',
      /* 系统手部附加段本轮为关闭态，与单人的 handsVersion=off 同义 */
      handsVersion: 'off',
      subjectSource: 'temp-two',
      entityType: '(临时双人，不读身份)',
      entityId: '',
      personCount: 2,
      positive: positive,
      negative: negative
    };
    if (typeof console !== 'undefined' && console.info) {
      console.info('[Sleepy][临时双人实验]', debug);
    }
    return { positive: positive, negative: negative, debug: debug };
  }

  /* ---- 04 临时多人群像（群像 3～4 人，临时虚构人物，不读群岛资料）———————
     为什么**另起一个函数**而不是把 buildTwoSubjectExperimentPrompt 放宽：
     1. 人数守卫语义不同 —— 双人「恰好 2」、多人「3～4」，共用会把已通过真图
        的双人路径牵连进来；
     2. 结构词不同（见下），镜头 / 人数 / 关系的表述不能互相污染；
     3. 施工单要求「宁可新增清晰的多人函数，避免影响已通过的双人真图」。
     与双人路径同享的只有**常量取值**（SLEEPY_VISUAL_STYLE 的 quality 层）与
     joinLayers 去重，没有公共层需要抽取 —— 抽取会扩大改动面，不做。

     本函数**不是**人数检测器 / 身份锁脸器 / 动作校验器：
     结构词只是一段文本引导，画不画得出来、谁在哪边、手归到谁，只有真图能判断。

     系统手部附加段**恒空**：不恢复 handsPositive / handsStructure /
     SLEEPY_HANDS_UNIFIED，也不拼男女两个单人底座。人物描述里自己写到的手部
     动作原样保留，本函数不改写、不补词、不删。 */
  var GROUP_SUBJECT_STRUCTURE = 'Exactly the described number of people are present in the image. '
    + 'Keep each person\'s appearance, clothing, and identity associated with that person. '
    + 'Follow the group scene description for positions, expressions, gaze, actions, and relationships. '
    + 'Do not merge identities, omit described people, add unrequested people, or invent '
    + 'relationships and physical contact that are not described.';

  function buildGroupSubjectExperimentPrompt(opts) {
    opts = opts || {};
    /* 与双人同档：本轮只走 experimental 里的 custom；legacy / sleepy-default 不接 */
    var mode = VISUAL_EXP_MODES.indexOf(opts.visualMode) >= 0 ? opts.visualMode : 'legacy';
    if (mode !== 'custom') return null;

    var api = opts.api || {};
    var kind = (api.kind === 'nai') ? 'nai' : 'general';
    if (kind !== 'general') return null;          /* 本轮不展开 NAI / 其他接口 */
    if (opts.tempGroup !== true) return null;     /* 必须显式「临时多人」 */

    var subs = Array.isArray(opts.tempSubjects) ? opts.tempSubjects : [];
    /* 人数区间硬守：少于 3 直接 null（不静默减成双人），多于 4 也 null */
    var n = subs.length;
    if (n < GROUP_MIN || n > GROUP_MAX) return null;

    var people = [];
    for (var i = 0; i < n; i++) {
      var raw = (subs[i] && (subs[i].description != null ? subs[i].description : subs[i].text)) || '';
      var d = String(raw).trim();
      if (!d) return null;                        /* 任何一个人为空都不发 */
      people.push('Person ' + GROUP_LABELS[i] + '（人物' + GROUP_LABELS[i] + '）: ' + d);
    }

    var scene = String(opts.description || '').trim();
    if (!scene) return null;                      /* 共同画面描述非空 */

    var customText = String(opts.customVisualStyle || '').trim();

    var positive = joinLayers([
      SLEEPY_VISUAL_STYLE[kind].qualityPositive,
      GROUP_SUBJECT_STRUCTURE,
      people.join(', '),
      'Group scene（共同画面描述）: ' + scene,
      customText,
      (opts.extras || []).join(', ')
    ]);
    /* 与双人一致：只留必要质量负面，人数 / 身份 / 关系约束都放正向 */
    var negative = joinLayers([SLEEPY_VISUAL_STYLE[kind].qualityNegative]);

    var debug = {
      mode: mode,
      kind: kind,
      /* 多人不使用单人镜头下拉：构图由共同描述承担，shot 固定 auto */
      shot: 'auto',
      visualLayer: 'custom',
      customVisual: customText ? '(有)' : '(空)',
      handsVersion: 'off',                        /* 系统手部附加段本轮恒空 */
      subjectSource: 'temp-group',
      personCount: n,
      entityType: '(临时多人，不读群岛资料)',
      entityId: '',
      positive: positive,
      negative: negative
    };
    if (typeof console !== 'undefined' && console.info) {
      console.info('[Sleepy][临时多人群像实验]', debug);
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

  /* ==================== C2 贴纸工坊（2026-10-02 施工单 §四） ====================
     定稿词逐字落库（实施单原文，禁改写）：
     · both  = 双人 CP 六情绪（big hug / cheek pinch / good morning /
               good night / super happy / pouting and head pat）
     · single_male / single_female = 单人高频情绪（good morning / good night /
               hug request / pouting angry / super happy / gentle comfort|shy blush）
     自定义模式：只替换 `Sticker N` 六段正文（实施单：不允许覆盖模板级约束
     —— 6 格、die-cut、白底、无道具），base 与负面词不动。 */
  var STICKER_PROMPT_VERSION = 'c2-v1';

  var STICKER_BOTH_BASE =
    'masterpiece, best quality, cute chibi couple sticker sheet, exactly 6 separate mini die-cut stickers arranged in a clean 3 by 2 grid, all six stickers fully visible with generous empty margins on every side, no sticker touching or crossing the canvas edge. Use the two reference characters consistently in every sticker. Preserve only their recognizable facial features, hairstyles, hair colors, clothing colors, and character identities from the reference images. Do not add animal traits unless they are explicitly present in the character design. The characters are ordinary human chibi characters by default, with normal human ears and no animal features. Keep the same two people throughout the entire sheet. Cute 2.5-head-tall chibi proportions, clean anime lineart, soft pastel colors, expressive faces, simple uncluttered compositions. Each sticker must have its own completely separate thick smooth white die-cut outline. The outlines must not merge between stickers. Pure solid white background. Focus on emotion, facial expression, and clear body language. Keep every hand, arm, leg, and foot anatomically separate and clearly visible.';

  var STICKER_BOTH_SLICES = [
    'Sticker 1, "big hug": the girl jumps into the boy\'s arms, the boy supports her with both arms, the girl wraps both arms around his neck, no props, no extra limbs.',
    'Sticker 2, "cheek pinch": the boy uses exactly one hand to gently pinch one of the girl\'s cheeks, his other hand stays clearly visible beside his body, the girl\'s hands stay down, no props, no extra hands.',
    'Sticker 3, "good morning": both characters have messy sleepy hair and cheerful sleepy faces, the girl waves with one hand, the boy yawns with one hand covering his mouth, no cups, no food, no objects.',
    'Sticker 4, "good night": both characters sleep peacefully side by side under one simple fluffy blanket, only their upper bodies and faces are visible above the blanket, no extra legs, no duplicated bodies, no objects.',
    'Sticker 5, "super happy": both characters stand side by side with both arms raised in celebration, eyes closed in joyful smiles, surrounded by a few small hearts and sparkles, no props, no complicated overlapping poses.',
    'Sticker 6, "pouting and head pat": the girl stands with both arms crossed and puffed cheeks, the boy uses exactly one hand to gently pat the top of her head, his other hand stays down beside his body, both faces clearly visible, no extra hands.',
    'Clean separation between all six stickers, complete bodies where applicable, natural hand and foot structure, readable silhouette, polished stationery sticker pack design, soft cute romantic atmosphere.'
  ].join(' ');

  var STICKER_SINGLE_BASE =
    'masterpiece, best quality, cute chibi sticker sheet, exactly 6 separate mini die-cut stickers arranged in a clean 3 by 2 grid, all six stickers fully visible with generous empty margins on every side, no sticker touching or crossing the canvas edge. Use the reference character consistently in every sticker. Preserve only their recognizable facial features, hairstyle, hair color, clothing colors, and character identity from the reference image. Do not add animal traits unless they are explicitly present in the character design. Ordinary human chibi character by default, with normal human ears and no animal features. Cute 2.5-head-tall proportions, clean anime lineart, soft pastel colors, expressive face, simple uncluttered compositions. Each sticker must have its own completely separate thick smooth white die-cut outline. Pure solid white background. Focus on emotion, facial expression, and clear body language. Keep every hand, arm, leg, and foot anatomically separate and clearly visible.';

  var STICKER_MALE_SLICES = [
    'Sticker 1, "good morning": messy bedhead, sleepy but gentle expression, rubbing one eye with exactly one hand, the other hand clearly visible beside his body, no cup and no props.',
    'Sticker 2, "good night": sleeping peacefully while hugging one simple soft pillow, only the upper body is visible, no extra legs, no duplicated body.',
    'Sticker 3, "hug request": standing with both arms opened toward the viewer, looking forward with an affectionate expectant expression, no extra arms and no props.',
    'Sticker 4, "pouting angry": arms crossed, puffed cheeks, slightly narrowed eyes, tiny steam lines above his head, no objects.',
    'Sticker 5, "super happy": both arms raised in celebration, eyes closed in a bright joyful smile, a few small hearts and sparkles only.',
    'Sticker 6, "gentle comfort": one hand giving a small friendly wave while the other hand rests clearly beside his body, soft reassuring smile, no complicated pose.',
    'Clean separation between all six stickers, complete readable silhouettes, natural human anatomy, polished stationery sticker pack design, soft cute romantic atmosphere.'
  ].join(' ');

  var STICKER_FEMALE_SLICES = [
    'Sticker 1, "good morning": slightly messy hair, sleepy cheerful expression, waving with exactly one hand, the other hand clearly visible beside her body, no cup and no props.',
    'Sticker 2, "good night": sleeping peacefully while hugging one simple soft pillow, only the upper body is visible, no extra legs, no duplicated body.',
    'Sticker 3, "hug request": standing with both arms opened toward the viewer, looking up with an affectionate expectant expression, no extra arms and no props.',
    'Sticker 4, "pouting angry": arms crossed, puffed cheeks, cute frustrated expression, tiny steam lines above her head, no objects.',
    'Sticker 5, "super happy": both arms raised in celebration, eyes closed in a bright joyful smile, a few small hearts and sparkles only.',
    'Sticker 6, "shy blush": both hands held near her cheeks, visible blush, bashful smile, hands not covering or merging with the face, no complicated pose.',
    'Clean separation between all six stickers, complete readable silhouettes, natural human anatomy, polished stationery sticker pack design, soft cute romantic atmosphere.'
  ].join(' ');

  /* 负面词：both 版比 single 版多「overlapping stickers, characters fused together」等
     双人项 —— 与实施单两个负面词原文一致，不合并。 */
  var STICKER_NEG_BOTH =
    'photorealistic, realistic human proportions, 3d render, complex detailed background, noisy background, gradient background, broken white border, merged borders, extra arms, extra hands, extra legs, extra feet, duplicated limbs, missing limbs, fused limbs, tangled arms, twisted wrists, malformed fingers, hand merged with face, hand merged with hair, hand merged with clothing, duplicated face, duplicated body, deformed anatomy, impossible pose, unclear silhouette, characters fused together, overlapping stickers, cropped sticker, cut-off body, sticker touching canvas edge, sticker outside the canvas, partial sticker, cat ears, animal ears, fox ears, rabbit ears, furry ears, animal tail, horns, fantasy creature traits, prop duplication, cup, mug, food, complicated background, text, watermark, blurry, low resolution';

  var STICKER_NEG_SINGLE =
    'photorealistic, realistic human proportions, 3d render, complex detailed background, noisy background, gradient background, broken white border, merged borders, extra arms, extra hands, extra legs, extra feet, duplicated limbs, missing limbs, fused limbs, tangled arms, twisted wrists, malformed fingers, hand merged with face, hand merged with hair, hand merged with clothing, duplicated face, duplicated body, deformed anatomy, impossible pose, unclear silhouette, cropped sticker, cut-off body, sticker touching canvas edge, sticker outside the canvas, partial sticker, cat ears, animal ears, fox ears, rabbit ears, furry ears, animal tail, horns, fantasy creature traits, prop duplication, cup, mug, food, complicated background, text, watermark, blurry, low resolution';

  /* 自定义情绪段的模板级约束尾巴（实施单：不许覆盖） */
  var STICKER_CUSTOM_TAIL =
    'Clean separation between all six stickers, complete readable silhouettes, natural human anatomy, polished stationery sticker pack design, soft cute romantic atmosphere.';

  /* 自定义六段拼接：lines = 6 句单行英文动作描述（工坊页已限 80 字符/句、无换行）。
     输出仍保持 "Sticker N:" 形状，便于模型按格产出；空槽兜一句中性表达。 */
  function stickerCustomSlices(lines) {
    var out = [];
    for (var i = 0; i < 6; i++) {
      var t = String((lines || [])[i] || '').trim().replace(/\s+/g, ' ');
      out.push('Sticker ' + (i + 1) + ': ' +
        (t || 'a simple cheerful chibi expression') + ', no props.');
    }
    out.push(STICKER_CUSTOM_TAIL);
    return out.join(' ');
  }

  /* 工坊生成（施工单 §四）：定稿词/自定义词**原样直发**，不进 buildFormalPrompt；
     参考图链路全复用 B2（intent → resolveRefData → requestGeneralEdits/requestChat）。
     返回协议：成功 {ok, mediaId, blob, width, height, subjectKeys, promptVersion}；
     失败 {ok:false, code, stage, message}（error:{message} 双带，兼容现有 toast 口）。 */
  function stickerFail(code, stage, message) {
    var e = err(message);
    return { ok: false, code: code, stage: stage, message: message, error: e };
  }

  function generateStickerSheet(opts) {
    opts = opts || {};
    var api = opts.api || activeApi();
    if (!api) {
      return Promise.resolve(stickerFail('REQUEST_FAILED', 'generate', '还没有配置生图接口'));
    }
    var subjects = (opts.subjects && opts.subjects.length) ? opts.subjects : null;
    if (!subjects) {
      return Promise.resolve(stickerFail('MISSING_REFERENCE', 'resolve-ref', '没有可锁脸的主体'));
    }
    var prompt = String(opts.prompt || '').trim();
    var negativePrompt = String(opts.negativePrompt || '').trim();
    if (!prompt) {
      return Promise.resolve(stickerFail('REQUEST_FAILED', 'generate', '贴纸提示词是空的'));
    }
    if (api.kind === 'nai') {
      /* 施工单 §四.5：NAI 明确失败，绝不静默降级成无参考图生图 */
      return Promise.resolve(stickerFail('NAI_UNSUPPORTED', 'resolve-ref',
        'NAI 暂不支持图片锁脸，贴纸没有生成 —— 换一个开了参考图支持的接口'));
    }
    if (!refChannelSupported(api)) {
      return Promise.resolve(stickerFail('UNSUPPORTED_REF', 'resolve-ref',
        '当前接口「' + (api.name || api.kind) + '」未开启参考图支持，贴纸没有生成 —— '
        + '去 设置 → 生图 → 接口编辑里按服务方能力选择支持方式'));
    }
    /* 锁脸是工坊的硬需求：所有主体都必须带参考图。locks 缺省全 true
       （显式 true 覆盖存档开关；缺图主体会进 intent.warns，逐个点名）。 */
    var intent = imageRefIntentFor({ subjects: subjects }, opts.imageLocks || null);
    if (!intent.any || intent.items.length < subjects.length) {
      var missing = [];
      subjects.forEach(function (s) {
        var k = refKeyFor(s);
        var hit = intent.items.some(function (it) { return it.key === k; });
        if (!hit) missing.push(s.name || k);
      });
      if (!missing.length) missing = intent.warns.length ? intent.warns : ['参考图未设置'];
      return Promise.resolve(stickerFail('MISSING_REFERENCE', 'resolve-ref',
        '参考图缺失：' + missing.join('、') + ' —— 先去资料页设置锁脸图，贴纸没有生成'));
    }
    return resolveRefData(intent.items).then(function (refs) {
      if (typeof console !== 'undefined' && console.info) {
        console.info('[Sleepy][贴纸工坊] 参考图 ' + refs.items.length +
          ' 张拉取完成，开始生成（两次独立请求）');
      }
      var built = { positive: prompt, negative: negativePrompt };
      var send = api.kind === 'general'
        ? requestGeneralEdits(api, built, refUrlsOf(refs), opts.size)
        : requestChat(api, built, null, refUrlsOf(refs));
      return send.then(function (blob) {
        return storeBlobResult(blob, opts.size,
          { name: '贴纸整版 ' + new Date().toLocaleString(), kind: 'sticker-sheet' });
      }).then(function (r) {
        /* storeBlobResult 图库挂了也返回 ok:true + mediaId:''（一次性 url）——
           贴纸没有 mediaId 就没法切片入库，必须按 STORE_FAILED 收口 */
        if (!r || !r.ok || !r.mediaId) {
          return stickerFail('STORE_FAILED', 'store',
            (r && r.warn) || (r && r.error && r.error.message) || '贴纸整版落库失败');
        }
        if (typeof console !== 'undefined' && console.info) {
          console.info('[Sleepy][贴纸工坊] 整版生成完成 mediaId=' + r.mediaId);
        }
        return {
          ok: true,
          mediaId: r.mediaId,
          blob: r.blob,
          width: r.width || 0,
          height: r.height || 0,
          subjectKeys: intent.items.map(refKeyFor),
          promptVersion: STICKER_PROMPT_VERSION
        };
      });
    }).catch(function (e) {
      /* 图源解析/发送失败：统一收口，绝不静默降级成无图请求 */
      var msg = String((e && e.message) || e);
      return stickerFail('REQUEST_FAILED', 'generate', '贴纸生成失败：' + msg);
    });
  }

  /* ---------------------------- 调接口 ----------------------------
     generate(opts) → Promise<{ok:true, mediaId, blob} | {ok:false, error:{message, detail}}>
     opts = { plan(优先), subject, faceText, extras, api, size }
     带 plan 时 subject/faceText/gender 被忽略 —— 一切以 plan 为准。
     generateBuilt(opts)：E1 实验专用 —— 调用方已拼好最终 prompt，
     直接进请求+落库，不再过 buildPrompt（保住 legacy 路径分毫不动）。 */
  /* -------------------- B2 图片锁脸（2026-10-02 施工单） --------------------
     三件事分家（§1）：sender 只管归属；plan.subjects 只管画面里有谁；
     每主体图片锁脸开关只决定是否为该主体附带参考图 —— 开关不改 subjects、
     不改人数、不改 sender、不强改镜头。 */

  /* 主体稳定键（§2）：user 绑 maskId、char/NPC 绑实体 id，带类型命名空间
     防撞 —— 同名角色不共用状态，数组顺序不作身份键。 */
  function refKeyFor(s) {
    s = s || {};
    return (s.entityType === 'user' ? 'user:' : 'char:') + String(s.entityId || '');
  }

  /* 接口能力（§5）：不在 kind 上想当然 —— 由接口配置的 refSupport 显式声明
     （设置 → 生图 → 接口编辑；'none' 默认＝未核实＝不支持）。 */
  function refChannelSupported(api) {
    api = api || {};
    if (api.kind === 'general') return api.refSupport === 'edits';
    if (api.kind === 'chat') return api.refSupport === 'chat';
    return false;
  }

  /* 意图解析（同步、零 IO）：逐主体算「本次是否带参考图」——
     本次显式 true/false > 已保存的 faceLockImageOn > false（§3 优先级；
     显式 false 绝不被 || 或默认值重新打开）。图源也在这里定型：
     本地图（faceLockImageMedia）优先，URL（faceLockImage）备用，
     两者都没有 → 该主体视为未设置、不带图（不报错，UI 显示未设置）。
     关闭/未启用的主体**不读取任何资料**。 */
  function imageRefIntentFor(planIn, locks) {
    var plan = normalizePlan(planIn);
    var core = (typeof Sleepy !== 'undefined') ? Sleepy.core : null;
    var items = [];
    var warns = [];
    plan.subjects.forEach(function (s, idx) {
      var key = refKeyFor(s);
      var override = (locks && Object.prototype.hasOwnProperty.call(locks, key))
        ? locks[key] : undefined;
      var rec = core ? ((s.entityType === 'user')
        ? core.findUser(s.entityId) : core.findChar(s.entityId)) : null;
      var savedOn = !!(rec && rec.faceLockImageOn === true);
      var active = (override !== undefined) ? !!override : savedOn;
      if (!active) return;
      var sourceType = (rec && rec.faceLockImageMedia) ? 'media'
        : (rec && rec.faceLockImage ? 'url' : 'none');
      if (sourceType === 'none') {
        warns.push((s.name || key) + ' 启用了图片锁脸但还没设置参考图，这张按无图处理');
        return;
      }
      items.push({
        key: key,
        subjectIndex: idx,
        name: s.name || (s.entityType === 'user' ? '我' : '角色'),
        sourceType: sourceType,
        mediaId: (rec && rec.faceLockImageMedia) || '',
        url: (rec && rec.faceLockImage) || ''
      });
    });
    return { any: items.length > 0, items: items, warns: warns,
      names: items.map(function (it) { return it.name; }) };
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('图片读不出来')); };
      fr.readAsDataURL(blob);
    });
  }

  /* 图源解析（异步，唯一 IO 段）：失败 → 明确到主体的报错，
     由 generate 在发送前整体失败（零生成请求、不自动换来源、不做无图兜底）。
     参考图下载与生成是两次独立请求 —— 计数在 UI 层分别呈现。 */
  function resolveRefData(items) {
    return Promise.all(items.map(function (it) {
      var fail = function (msg) {
        var e = err('图片锁脸失败：' + it.name, msg + ' —— 这张没有生成，'
          + '不会自动改用别的来源或无图兜底。');
        e.refSubject = it.name;
        throw e;
      };
      var p;
      if (it.sourceType === 'media') {
        p = (Sleepy.media && Sleepy.media.get)
          ? Sleepy.media.get(it.mediaId).then(function (rec) {
              if (!rec || !rec.blob) return fail('参考图在图库里找不到了（可能被清理）');
              return blobToDataUrl(rec.blob);
            }, function () { return fail('参考图读取失败'); })
          : Promise.reject('图库不可用');
      } else {
        p = fetch(it.url, { mode: 'cors' }).then(function (r) {
          if (!r.ok) return fail('参考图网址拉取失败 HTTP ' + r.status);
          return r.blob().then(blobToDataUrl,
            function () { return fail('参考图网址内容读不出来'); });
        }, function () {
          return fail('参考图网址拉取失败（跨域或网络不通）—— 可改用「选本地图」');
        });
      }
      return p.then(function (dataUrl) {
        return { key: it.key, name: it.name, dataUrl: dataUrl };
      });
    })).then(function (refs) { return { items: refs }; });
  }

  function refUrlsOf(resolved) {
    return (resolved && resolved.items ? resolved.items : []).map(function (it) {
      return it.dataUrl;
    });
  }

  /* general + edits：multipart /images/edits（OpenAI 兼容系参考图标准位）。
     仅在接口 refSupport==='edits' 且有启用参考图时使用；字段名按服务方契约，
     常见为 image[]（gpt-image-1 支持多张）。edits 不接 negative_prompt 字段
     —— 负面并进 prompt 末尾并注明，不悄悄丢弃。 */
  function requestGeneralEdits(api, built, refUrls, sizeStr) {
    var base = String(api.baseUrl || '').trim().replace(/\/+$/, '');
    var url = /\/images\/edits$/i.test(base) ? base
      : (base ? base + '/images/edits' : '');
    if (!url || !api.model) {
      return Promise.reject(err('接口没配好', !url ? '先填接口地址' : '先填模型名'));
    }
    var size = String(sizeStr || api.size || '1024x1024');
    var fd = new FormData();
    fd.append('model', api.model);
    fd.append('prompt', built.positive +
      (built.negative ? '\n\nDo not include: ' + built.negative : ''));
    fd.append('n', '1');
    fd.append('size', size);
    fd.append('response_format', 'b64_json');
    /* dataURL → blob 必须在发送前完成：fetch(dataURL) 是异步的，
       串行收集后再发，保证附件齐全且顺序稳定。 */
    return Promise.all(refUrls.map(function (u) {
      return fetch(u).then(function (r) { return r.blob(); });
    })).then(function (blobs) {
      blobs.forEach(function (b, i) {
        fd.append('image[]', b, 'reference-' + (i + 1) + '.png');
      });
      var headers = {};
      if (api.apiKey) headers['Authorization'] = 'Bearer ' + api.apiKey;
      return fetchWithTimeout(url, { method: 'POST', headers: headers, body: fd })
        .then(function (r) {
          return r.text().then(function (txt) {
            if (!r.ok) return Promise.reject(err('接口报错 HTTP ' + r.status, txt));
            var data = null;
            try { data = JSON.parse(txt); } catch (e) { /* 落到下面 */ }
            var item = data && data.data && data.data[0];
            if (!item) return Promise.reject(err('返回里没有图片数据', txt));
            if (item.b64_json) return b64ToBlob(item.b64_json, txt);
            if (item.url) {
              return fetchWithTimeout(item.url, {}, null).then(function (r2) {
                if (!r2.ok) return Promise.reject(err('图片下载失败 HTTP ' + r2.status, item.url));
                return r2.blob();
              }, function (e) {
                return Promise.reject(err('图片下载失败（链接抓不动）',
                  item.url + '\n' + ((e && e.message) || e)));
              });
            }
            return Promise.reject(err('返回里既没有 b64 也没有 url', txt));
          });
        }, function (e) { return Promise.reject(netErr(e)); });
    });
  }

  /* -------------------- B2 图片锁脸（2026-10-02 施工单） -------------------- */

  function generate(opts) {
    opts = opts || {};
    var api = opts.api || activeApi();
    if (!api) {
      return Promise.resolve({ ok: false, error: err('还没有配置生图接口', '去 设置 → 生图 添加一个') });
    }
    /* B2 图片锁脸（2026-10-02 施工单）：意图快照在请求开始时就固定 ——
       调用方中途改 opts 不影响在途请求（§3 快照要求）。 */
    var locks = opts.imageLocks ? JSON.parse(JSON.stringify(opts.imageLocks)) : null;
    /* 正式接入（2026-10-01 施工单 v1）：plan 分支先走正式拼接器（内置/自定义）。
       一个咽喉覆盖全部正式入口 —— chat 标签 / 弹层 / 查岗 / 重画 / 日记 /
       朋友圈 / 线下键都从 generate({plan}) 进来。
       - 校验不过 → 明确报错、零请求（不静默换人 / 减员 / 降级无人）；
       - NAI → null 回落 legacy（既有能力原样保留，如实回落不冒充新词生效）。
       无 plan（试一张 legacy 档 + AI 解析失败兜底）照走旧路，分毫不动。 */
    if (opts.plan) {
      var intent = imageRefIntentFor(opts.plan, locks);
      if (intent.any && api.kind === 'nai') {
        /* §5：启用图片锁脸却选到未支持通道 → 阻止并提示；用户明确关闭
           本次图片锁脸后才走原无图路径。零请求、不做无图兜底。 */
        return Promise.resolve({ ok: false, error: err('NAI 暂不支持图片锁脸，这张没有生成',
          '画面里启用了图片锁脸（' + intent.names.join('、') + '）。NAI 通道暂不接参考图'
          + '（img2img/vibe 都不是只锁脸的机制）。关闭本次图片锁脸后可按原无图路径生成。') });
      }
      if (intent.any && !refChannelSupported(api)) {
        return Promise.resolve({ ok: false, error: err('当前接口未开启参考图支持，这张没有生成',
          '画面里启用了图片锁脸（' + intent.names.join('、') + '），但接口「'
          + (api.name || api.kind) + '」的「参考图支持」是「不支持」。'
          + '去 设置 → 生图 → 接口编辑里按服务方能力选择支持方式；'
          + '或关闭本次图片锁脸后按原无图路径生成。') });
      }
      if (api.kind === 'nai') {
        /* NAI 正式编译（2026-10-02 施工单）：校验失败 / 模型不支持 / 编译抛错
           → 明确报错零请求，一律不回落 legacy。 */
        var fnai;
        try {
          fnai = buildFormalNaiRequest({ api: api, plan: opts.plan, extras: opts.extras });
        } catch (eNai) {
          return Promise.resolve({ ok: false, error: err('NAI 正式生图编译失败，这张没有生成',
            (eNai && eNai.message) || String(eNai)) });
        }
        if (fnai.ok) {
          return requestAndStore(api, fnai.request, opts.size);
        }
        return Promise.resolve({ ok: false, error: fnai.error });
      }
      var formal = buildFormalPrompt({ api: api, plan: opts.plan, extras: opts.extras });
      if (formal && formal.ok === false) {
        return Promise.resolve({ ok: false, error: formal.error });
      }
      if (formal && formal.ok) {
        if (!intent.any) {
          /* 无参考图 → 原路径逐字节同形（不打 edits、不加约束句、不读图） */
          return requestAndStore(api,
            { positive: formal.positive, negative: formal.negative }, opts.size);
        }
        /* B2：有启用的参考图 → 先校验（上面已完成、零 IO），再解析图源，
           失败明确到主体、零生成请求（不自动换来源、不做无图兜底）。 */
        return resolveRefData(intent.items).then(function (refs) {
          var withRefs = buildFormalPrompt({ api: api, plan: opts.plan,
            extras: opts.extras,
            imageRefs: refs.items.map(function (it, i) {
              return { key: it.key, refNo: i + 1, name: it.name };
            }) });
          if (withRefs && withRefs.ok === false) {
            return { ok: false, error: withRefs.error };
          }
          var built = { positive: withRefs.positive, negative: withRefs.negative };
          var send = api.kind === 'general'
            ? requestGeneralEdits(api, built, refUrlsOf(refs), opts.size)
            : requestChat(api, built, null, refUrlsOf(refs));
          return send.then(function (blob) {
            return storeBlobResult(blob, opts.size);
          }).then(function (r) {
            r.refCount = refs.items.length;
            if (typeof console !== 'undefined' && console.info) {
              console.info('[Sleepy][图片锁脸] 附件 ' + refs.items.length
                + ' 张（参考图拉取与生成是两次独立请求）');
            }
            return r;
          });
        }).catch(function (e) {
          /* 图源解析/发送失败：统一收口成 {ok:false,error}（报错已点名主体），
             绝不静默降级成无图请求。 */
          if (e && typeof e === 'object' && e.detail !== undefined && e.message) {
            return { ok: false, error: e };
          }
          return { ok: false, error: err('图片锁脸失败，这张没有生成',
            String((e && e.message) || e)) };
        });
      }
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

  function storeBlobResult(blob, sizeStr, meta) {
    var size = String(sizeStr || '1024x1024').split('x');
    var w = Math.max(64, parseInt(size[0], 10) || 1024);
    var hgt = Math.max(64, parseInt(size[1], 10) || 1024);
    var m = meta || {};
    return media.put(blob, { name: m.name || ('生图 ' + new Date().toLocaleString()),
      kind: m.kind || 'image', w: w, h: hgt })
      .then(function (id) { return { ok: true, mediaId: id, blob: blob, width: w, height: hgt }; },
        function (e) {
          /* 图库不可用（IndexedDB 被拦等）：图已经拿到了，别浪费 —— 临时地址直接给出去 */
          return { ok: true, mediaId: '', blob: blob,
            url: global.URL.createObjectURL(blob),
            warn: '图库没存上（' + ((e && e.message) || e) + '），这张是一次性的' };
        });
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
          negative_prompt: built.negative || '',
          /* V4/V4.5 正式管线（2026-10-02）：字段由 buildFormalNaiRequest 给出，
             V3 / legacy 路径恒缺省 → 不发（|| undefined 只做「没有就不发」，
             不是空值回填）。 */
          v4_prompt: built.v4Prompt || undefined,
          v4_negative_prompt: built.v4NegativePrompt || undefined
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

  function requestChat(api, built, ctrl, refUrls) {
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
    var message = { role: 'user', content: content };
    /* B2：有参考图 → 多模态 content parts（复用 page-chat 聊天带图形态）；
       参考图为 dataURL/URL，主体归属由提示词里的 Reference image N 标注。 */
    if (refUrls && refUrls.length) {
      message.content = [{ type: 'text', text: content }].concat(refUrls.map(function (u) {
        return { type: 'image_url', image_url: { url: u } };
      }));
    }
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: api.model,
        messages: [message],
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
      '- 拍立得背面（可选）：描述后面加一段 |寄语，如 [生图:夕阳下的海边|想永远记住这一刻]——这句会手写在照片背面，点卡片能翻过来看；值得留念的瞬间才写',
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
    singleExpSubjectRef: singleExpSubjectRef,
    setSingleExpSubjectRef: setSingleExpSubjectRef,
    singleExpShot: singleExpShot,
    setSingleExpShot: setSingleExpShot,
    singleExpHands: singleExpHands,
    setSingleExpHands: setSingleExpHands,
    singleExpGender: singleExpGender,
    setSingleExpGender: setSingleExpGender,
    TEMP_SINGLE_REF: TEMP_SINGLE_REF,
    TEMP_TWO_REF: TEMP_TWO_REF,
    TWO_SUBJECT_STRUCTURE: TWO_SUBJECT_STRUCTURE,
    TEMP_GROUP_REF: TEMP_GROUP_REF,
    GROUP_MIN: GROUP_MIN,
    GROUP_MAX: GROUP_MAX,
    GROUP_LABELS: GROUP_LABELS,
    GROUP_SUBJECT_STRUCTURE: GROUP_SUBJECT_STRUCTURE,
    buildGroupSubjectExperimentPrompt: buildGroupSubjectExperimentPrompt,
    SLEEPY_SINGLE_STYLE: SLEEPY_SINGLE_STYLE,
    SLEEPY_TEMP_MALE_LOOK: SLEEPY_TEMP_MALE_LOOK,
    /* C 版女性定稿底座（2026-10-01 投票定稿），与男那份对称 */
    SLEEPY_TEMP_FEMALE_LOOK: SLEEPY_TEMP_FEMALE_LOOK,
    /* 全分支统一的手部段（前身 SLEEPY_TEMP_MALE_HANDS，2026-10-01 改名） */
    SLEEPY_HANDS_UNIFIED: SLEEPY_HANDS_UNIFIED,
    tempMaleLookOn: tempMaleLookOn,
    tempFemaleLookOn: tempFemaleLookOn,
    singleVisualLayerOf: singleVisualLayerOf,
    singleSubjectVisualStyleText: singleSubjectVisualStyleText,
    singleSubjectGenderAdjustment: singleSubjectGenderAdjustment,
    singleSubjectGenderNegative: singleSubjectGenderNegative,
    visibleHandsText: visibleHandsText,
    singleSubjectNegativeText: singleSubjectNegativeText,
    buildSingleSubjectExperimentPrompt: buildSingleSubjectExperimentPrompt,
    buildTwoSubjectExperimentPrompt: buildTwoSubjectExperimentPrompt,
    /* 正式生图（内置 / 自定义，2026-10-01 施工单 v1） */
    imgStyleMode: imgStyleMode,
    setImgStyleMode: setImgStyleMode,
    imgStyleCustom: imgStyleCustom,
    setImgStyleCustom: setImgStyleCustom,
    buildFormalPrompt: buildFormalPrompt,
    /* B2 图片锁脸（2026-10-02 施工单） */
    refKeyFor: refKeyFor,
    imageRefIntentFor: imageRefIntentFor,
    refChannelSupported: refChannelSupported,
    /* C2 贴纸工坊（2026-10-02 修正施工单）：定稿词常量 + 整版生成 */
    STICKER_PROMPTS: {
      VERSION: STICKER_PROMPT_VERSION,
      BOTH_BASE: STICKER_BOTH_BASE,
      BOTH_SLICES: STICKER_BOTH_SLICES,
      SINGLE_BASE: STICKER_SINGLE_BASE,
      MALE_SLICES: STICKER_MALE_SLICES,
      FEMALE_SLICES: STICKER_FEMALE_SLICES,
      NEG_BOTH: STICKER_NEG_BOTH,
      NEG_SINGLE: STICKER_NEG_SINGLE,
      customSlices: stickerCustomSlices,
      composeBoth: function () { return STICKER_BOTH_BASE + ' ' + STICKER_BOTH_SLICES; },
      composeMale: function () { return STICKER_SINGLE_BASE + ' ' + STICKER_MALE_SLICES; },
      composeFemale: function () { return STICKER_SINGLE_BASE + ' ' + STICKER_FEMALE_SLICES; }
    },
    generateStickerSheet: generateStickerSheet,
    /* NAI 正式编译器（2026-10-02 施工单）与共用校验 */
    buildFormalNaiRequest: buildFormalNaiRequest,
    validatePlanSubjects: validatePlanSubjects,
    identitySegmentFor: identitySegmentFor,
    /* 正式底座 v2（返修单 v2）：与实验旧词分开版本化 */
    SLEEPY_FORMAL_MALE_LOOK_V2: SLEEPY_FORMAL_MALE_LOOK_V2,
    SLEEPY_FORMAL_FEMALE_LOOK_V2: SLEEPY_FORMAL_FEMALE_LOOK_V2,
    SLEEPY_NEUTRAL_SUBJECT_V1: SLEEPY_NEUTRAL_SUBJECT_V1,
    SLEEPY_NEUTRAL_STRUCTURE_V1: SLEEPY_NEUTRAL_STRUCTURE_V1,
    SLEEPY_NEUTRAL_NEGATIVE_V1: SLEEPY_NEUTRAL_NEGATIVE_V1,
    /* 03/04 内置视觉层（用户找回原稿，逐字落库） */
    SLEEPY_FORMAL_TWO_LOOK_V1: SLEEPY_FORMAL_TWO_LOOK_V1,
    SLEEPY_FORMAL_GROUP_LOOK_V1: SLEEPY_FORMAL_GROUP_LOOK_V1,
    generateBuilt: generateBuilt,
    extractImageFromChatText: extractImageFromChatText,
    buildPrompt: buildPrompt,
    generate: generate,
    replySpec: replySpec,
    extractFirstFile: extractFirstFile
  };

})(window);
