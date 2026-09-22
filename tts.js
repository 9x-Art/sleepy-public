/* ============================================================
   tts.js — 语音合成（TTS）的统一层：契约 / 语音导演 / 服务商 Adapter
   依赖：store.js（必须在它之后加载）；media.js 只在「存音频」那一步用
   被依赖：page-tts.js（设置页 · 角色语音页）、page-chat.js（语音条 · 手动朗读）

   依据 docs/方案-TTS-v1.md（= 《Fish Audio TTS v1 接入与语音导演契约 v1》的落地版）。

   ---- 三层文本边界（**这是整套东西的脊梁，别破**）----
     originalText    聊天里真正显示/保存/搜索/导出/进记忆的文本。**禁止写入任何标签。**
     SpeechPlan      本文件产出的**服务商无关**表情计划（情绪/幅度/克制度/语速/表演标签）。
     synthesisText   Adapter 临时拼出来的、只用于请求 TTS 的文本（带 [soft tone] 这类标签）。
                     **禁止回写**气泡正文 / 搜索 / 记忆 / 导出 / 主模型上下文 / 用户可见文字稿。
   谁想加「让模型直接吐 [sad]」的近路，先回来读这三行。

   ---- 为什么导演是纯函数（首版）----
   契约 §12 第 6 步要的是「基础 SpeechPlan 规则版」。规则版的好处是**可测、零成本、
   不依赖任何模型**：标点强度 + 情绪词典 + 角色许可白名单 → 计划。
   模型版（拿总结 API 跑一次小模型）是后面的增强，接口已经留好了（speechPlanOf 的入参里
   可以带 `plan`，generate() 也接受外部传进来的 plan）。

   ---- 服务商：Fish Audio 首版，MiniMax 同时接上 ----
   · Fish Audio 是契约定的首版（标签最全：[calm] / [soft tone] / [chuckling]…）。
     实测：它的 api 域名在国内网络被 DNS 污染 + TLS 阻断，需要代理或自建中转才能直连
     （连接配置里的「接口地址」就是这个口子）。
   · MiniMax 同时实现：国内可达，且 CORS 实测允许浏览器直连（回显 Origin），
     所以在没有代理的设备上它是**唯一能真跑通**的一条路。计划支持：ElevenLabs。

   ---- 凭据存哪（**与主 API 同等对待**，用户 2026-09-22 拍板）----
   契约 §4.1 想要「服务端代发 + credentialRef 引安全存储」，但 Sleepy 是零依赖静态站
   （file:// + Pages），**没有服务端**，也没有平台安全存储。所以：
     · Key 就和主 API 一样存在本地（`ttsConnections` 里的 `apiKey` 字段）；
     · **绝不**进入角色数据、聊天正文、消息记忆、日志；
     · 日志/报错只带脱敏标识（`maskKey()` 给后四位）；
     · 导出包策略与主 API 一致（store.exportAll 会带它，换设备能恢复 —— 单独剔除会让
       用户换机后语音静默失效，那种「改了没反应」最难受）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  /* ==================== 1. 白名单与出厂值 ==================== */

  /* 情绪与表演标签是**闭集**：模型/规则只能从这里面挑，Adapter 只认这里面的映射。
     想加新的，先加进 EMOTIONS/TAGS，再补 ADAPTER 里的映射表 —— 别在别处写字符串。 */
  var EMOTIONS = ['neutral', 'happy', 'tender', 'concerned', 'sad', 'disappointed',
    'surprised', 'angry', 'annoyed', 'cold', 'tired'];

  var TAGS = ['soft', 'low', 'laugh', 'sigh', 'whisper', 'breathy', 'crying'];

  /* 出厂默认里**不打开**强表演（契约 §5.6：默认不主动用哭腔、喘息、尖叫、吼叫）。
     用户可以在角色语音页里自己勾上 crying / breathy。 */
  var TAGS_DEFAULT_ON = ['soft', 'low', 'laugh', 'sigh', 'whisper'];

  var OUTPUT_DEFAULT = {
    format: 'mp3',
    sampleRate: 44100,
    bitrate: 128,
    latency: 'normal',
    normalize: true,
    normalizeLoudness: true
  };

  /* 频率档位：契约给的是 6 档枚举，顺便把「主动生成的概率」定下来。
     概率只在**非用户明确要求**时用（手动朗读/点了朗读一律绕过）。 */
  var FREQUENCIES = [
    { id: 'never', label: '从不', hint: '只看手动朗读' },
    { id: 'requested', label: '只在我说的时候', hint: '默认：你点朗读才读' },
    { id: 'rare', label: '很少', hint: '大约五次主动里有一次' },
    { id: 'sometimes', label: '偶尔', hint: '大约三次里有一次' },
    { id: 'often', label: '经常', hint: '大约两次里有一次' },
    { id: 'always', label: '每次都读', hint: '每条回复都带语音' }
  ];
  var FREQ_CHANCE = { never: 0, requested: 0, rare: 0.2, sometimes: 0.34, often: 0.5, always: 1 };

  var DEFAULT_SETTINGS = {
    enabled: false,
    defaultConnectionId: null,
    defaultModel: 's2.1-pro-free',
    /* 全局的自动播放默认（角色设置里选「跟随全局」时读它）：
       出厂是「只在我点时播」—— 手机上突然出声是很讨厌的事。 */
    autoPlay: 'manual',
    output: OUTPUT_DEFAULT
  };

  var DEFAULT_VOICE = {
    enabled: false,
    connectionMode: 'global',      /* global | override */
    connectionId: null,
    modelMode: 'global',           /* global | override */
    model: '',
    voiceId: '',                   /* 音色 ID：Fish 的 reference_id / MiniMax 的 voice_id */
    frequency: 'requested',
    maxPerTurn: 1,
    cooldownTurns: 2,
    maxSeconds: 30,                /* Sleepy 侧的「生成前筛选」，**不是**服务商参数 */
    pace: 100,                     /* UI 70–130；计划里换算成 0.7–1.3 */
    emotionIntensity: 50,          /* 0–100 */
    restraint: 70,                 /* 0–100，越高越克制（先减标签再加字） */
    emotionAuto: true,
    naturalPause: true,
    allowedEmotions: EMOTIONS.slice(),
    allowedPerformanceTags: TAGS_DEFAULT_ON.slice(),
    characterDirection: '',        /* 角色专属表达方向，拼进导演提示（模型版用） */
    autoplay: 'global',            /* manual | auto | global */
    keepTranscript: true,          /* 保留文字稿（气泡里同时有字） */
    manualRead: true               /* 长按菜单里给不给「朗读」 */
  };

  /* ==================== 2. 服务与模型（能力落到「模型」） ====================
     契约（MiniMax 那份 §4）要求能力声明挂在**具体模型**上，而不是服务商上 ——
     因为同一家的不同模型差别很大（MiniMax 只有 2.8 系列吃括号语气词；
     ElevenLabs v3 才有 Audio Tags，Flash 连数字规范化都得我们自己做）。 */
  var PROVIDERS = {
    fish_audio: {
      id: 'fish_audio',
      name: 'Fish Audio',
      desc: '首版支持 · 中文语音与自定义音色',
      consoleUrl: 'https://fish.audio/',
      defaultName: '我的 Fish Audio',
      endpoint: 'https://api.fish.audio/v1/tts',
      keyHint: '在 Fish Audio 控制台 → API Keys 里生成，形如一长串字符',
      voiceHint: '填音色的 model id（控制台里那串 id），不是音色名',
      models: [
        { id: 's2.1-pro-free', label: 'S2.1 免费开发档', note: '默认 · 繁忙时可能较慢', caps: { performanceTags: true, maxCharacters: 3000 } },
        { id: 's2.1-pro', label: 'S2.1 稳定生产档', note: '正式发布建议', caps: { performanceTags: true, maxCharacters: 3000 } },
        { id: 's2-pro', label: 'S2 兼容档', note: '老音色', caps: { performanceTags: true, maxCharacters: 3000 } },
        { id: 's1', label: 'S1 旧版兼容', note: '老音色', caps: { performanceTags: false, maxCharacters: 3000 } }
      ]
    },
    minimax: {
      id: 'minimax',
      name: 'MiniMax',
      desc: '国内可达 · 中文友好（2.8 系列才吃括号语气词）',
      consoleUrl: 'https://platform.minimaxi.com/',
      defaultName: '我的 MiniMax',
      endpoint: 'https://api.minimax.cn/v1/t2a_v2',
      keyHint: '在 MiniMax 控制台 → 接口密钥里生成',
      voiceHint: '填 voice_id（系统音色或你复刻的音色 id）',
      models: [
        { id: 'speech-2.8-hd', label: 'Speech 2.8 高质量', note: '默认 · 中文自然', caps: { performanceTags: true, emotionEnum: true, maxCharacters: 3000 } },
        { id: 'speech-2.8-turbo', label: 'Speech 2.8 快速', note: '低延迟', caps: { performanceTags: true, emotionEnum: true, maxCharacters: 3000 } },
        { id: 'speech-2.6-hd', label: 'Speech 2.6 高质量', note: '无括号语气词', caps: { performanceTags: false, emotionEnum: true, maxCharacters: 3000 } },
        { id: 'speech-02-hd', label: 'Speech 02 高质量', note: '更旧的档位', caps: { performanceTags: false, emotionEnum: true, maxCharacters: 3000 } }
      ]
    },
    elevenlabs: {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      desc: '表现力强 · 多语言（只有 v3 吃 Audio Tags）',
      consoleUrl: 'https://elevenlabs.io/',
      defaultName: '我的 ElevenLabs',
      /* 音色 ID 在**路径**里（/text-to-speech/{voice_id}）—— 这是三家唯一不把音色放 body 的。
         自建中转可以把 {voice_id} 写在地址里任意位置，见 elUrl()。 */
      endpoint: 'https://api.elevenlabs.io/v1/text-to-speech/',
      keyHint: '在 ElevenLabs 控制台 → API Keys 里生成（请求头 xi-api-key，不是 Authorization）',
      voiceHint: '填 voice_id（音色页网址里 /voice-lab/<这一段>，或 API /v1/voices 里的 voice_id）',
      /* 能力全在这张表上（MiniMax 那份 §4 的硬要求：**落到模型**，不是落到服务商）。
         speed：官方 voice_settings.speed 只对 2.5 系列生效，v3/多语言 v2 靠 Audio Tags 控速；
         textNormalization：多语言 v2 / v3 的文本规范化是一直开着的，只有 Flash 要显式打开。 */
      models: [
        {
          id: 'eleven_v3', label: 'v3', note: '表现力最强 · 70+ 语言 · 5,000 字符',
          caps: { performanceTags: true, speed: false, textNormalization: false, maxCharacters: 5000 }
        },
        {
          id: 'eleven_multilingual_v2', label: 'Multilingual v2', note: '长文本更稳 · 10,000 字符',
          caps: { performanceTags: false, speed: false, textNormalization: false, maxCharacters: 10000 }
        },
        {
          id: 'eleven_flash_v2_5', label: 'Flash v2.5', note: '低延迟 · 40,000 字符 · 支持调速',
          caps: { performanceTags: false, speed: true, textNormalization: true, maxCharacters: 40000 }
        }
      ]
    },

    /* ---- 硅基流动（OpenAI 兼容的 /v1/audio/speech）----
       实测：跨域预检回 `*`，国内直达。它上面跑的是 CosyVoice2（阿里开源的中文 TTS），
       预置 8 个中文音色 —— 对「不想注册国外账号」的人是最省事的一家。 */
    siliconflow: {
      id: 'siliconflow',
      name: '硅基流动',
      desc: '国内可达 · CosyVoice2 中文音色',
      consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
      defaultName: '我的硅基流动',
      endpoint: 'https://api.siliconflow.cn/v1/audio/speech',
      keyHint: '在硅基流动控制台 → API 密钥里生成',
      voiceHint: '要**连模型名一起写**：FunAudioLLM/CosyVoice2-0.5B:alex。' +
        '预置 8 个：alex / benjamin / charles / david（男），anna / bella / claire / diana（女）',
      models: [
        {
          id: 'FunAudioLLM/CosyVoice2-0.5B', label: 'CosyVoice 2', note: '中文自然 · 可调速',
          caps: { performanceTags: false, speed: true, maxCharacters: 1000 }
        }
      ]
    },

    /* ---- Azure 语音服务 ----
       它的接口**只吃 SSML**（音色写在 SSML 里、没有 model 字段），所以这里只有一档「模型」，
       真正决定声音的是音色名。实测 eastasia 节点跨域预检回 `*`。 */
    azure: {
      id: 'azure',
      name: 'Azure 语音',
      desc: '音色最多 · 只吃 SSML（音色写在正文里）',
      consoleUrl: 'https://portal.azure.com/',
      defaultName: '我的 Azure 语音',
      endpoint: 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',
      keyHint: '在 Azure 门户的「语音服务」资源里拿密钥（用的是 Ocp-Apim-Subscription-Key 头）',
      voiceHint: '填音色名，形如 zh-CN-XiaoxiaoNeural（晓晓）/ zh-CN-YunxiNeural（云希）/' +
        'zh-CN-XiaoyiNeural（晓伊）。中国的用户可以换成自己资源所在的节点',
      models: [
        {
          id: 'azure-neural', label: '神经网络语音', note: 'Azure 没有模型字段，声音由音色决定',
          caps: { performanceTags: false, speed: false, maxCharacters: 3000 }
        }
      ]
    },

    /* ---- 自定义 · OpenAI 兼容 ----
       这是「其它所有家的后门」：自建的 GPT-SoVITS / fish-speech / openedai-speech /
       LocalAI，或者自己搭的 one-api 之类中转，只要它说 OpenAI 的 /v1/audio/speech 就行。
       连不上的那几家（火山、腾讯、OpenAI 官方…）也都能从这里走中转用上。 */
    custom_openai: {
      id: 'custom_openai',
      name: '自定义 · OpenAI 兼容',
      desc: '自建或中转 · 只要它认 /v1/audio/speech',
      consoleUrl: 'https://platform.openai.com/docs/api-reference/audio/createSpeech',
      defaultName: '我的自建语音',
      endpoint: '',
      freeModel: true,   /* 模型 ID 由用户填（每个自建服务叫法都不一样） */
      keyHint: '填这个自建服务/中转需要的密钥；不需要就随便填一个占位（但别留空）',
      voiceHint: '填服务要求的音色名或音色 ID（每个自建服务不一样，看它的 README）',
      models: [
        {
          id: 'tts-1', label: 'tts-1', note: 'OpenAI 兼容的默认档 · 多数自建服务认这个名字',
          caps: { performanceTags: false, speed: true, maxCharacters: 4000 }
        }
      ]
    },

    /* ============ 下面这些是**探测过、现在接不了**的 ============
       planned 只表示「没有适配器」，desc 里写的是实测出来的真实原因 ——
       用户看到的是「为什么不能直连」，而不是一个神秘的灰行。 */

    dashscope: {
      id: 'dashscope', planned: true,
      name: '阿里云 CosyVoice',
      desc: '跨域是通的，但音频是用**临时链接**返回的：那个链接能不能跨域取回还没验过' +
        '（要真 Key 跑一次）→ 暂时请走「自定义 · OpenAI 兼容」'
    },
    volcengine: {
      id: 'volcengine', planned: true,
      name: '火山引擎（豆包语音）',
      desc: '接口不支持浏览器跨域（预检直接 404）→ 需要自建中转，走「自定义 · OpenAI 兼容」'
    },
    tencent_tts: {
      id: 'tencent_tts', planned: true,
      name: '腾讯云语音合成',
      desc: '要求 TC3-HMAC-SHA256 签名，而且响应里没有跨域头 → 需要自建中转'
    },
    xfyun: {
      id: 'xfyun', planned: true,
      name: '讯飞语音合成',
      desc: '只提供 WebSocket 接口，静态前端这条「拿回二进制」的链路接不了'
    },
    edge_tts: {
      id: 'edge_tts', planned: true,
      name: 'Edge 朗读（免费）',
      desc: '免费、音色多，但同样只有 WebSocket 口子 —— 浏览器里连不了'
    },
    openai: {
      id: 'openai', planned: true,
      name: 'OpenAI 官方 TTS',
      desc: 'OpenAI 不给浏览器跨域，本机网络也到不了 → 只能用「自定义 · OpenAI 兼容」填中转地址'
    }
  };
  var PROVIDER_ORDER = ['fish_audio', 'minimax', 'elevenlabs', 'siliconflow', 'azure', 'custom_openai'];

  /* 探测过、但**现在接不了**的（连同原因一起摆出来 —— 用户看得到「为什么不能直连」，
     而不是一个神秘的灰行）。这些一律不显示成可用（契约 §8.6）。 */
  var PROVIDER_PLANNED = ['dashscope', 'volcengine', 'tencent_tts', 'xfyun', 'edge_tts', 'openai'];

  function providerOf(id) { return PROVIDERS[id] || null; }
  function modelsOf(providerId) {
    var p = providerOf(providerId);
    return p ? p.models : [];
  }
  function modelOf(providerId, modelId) {
    var list = modelsOf(providerId);
    for (var i = 0; i < list.length; i++) if (list[i].id === modelId) return list[i];
    return list[0] || null;
  }
  /* 模型级能力表（契约要求）。缺省给最保守的一份 */
  function capabilitiesOf(providerId, modelId) {
    var m = modelOf(providerId, modelId);
    var caps = (m && m.caps) || {};
    return {
      streaming: !!caps.streaming,
      emotionEnum: !!caps.emotionEnum,
      performanceTags: !!caps.performanceTags,
      voiceCloning: !!caps.voiceCloning,
      voiceDesign: !!caps.voiceDesign,
      /* speed / textNormalization 是 ElevenLabs 那两家细分的口子：
         能调速的模型才把语速发过去，能显式开规范化的模型才发那个开关。
         别的服务商默认 false —— 不看模型就乱发字段，换一家就是 400。 */
      speed: !!caps.speed,
      textNormalization: !!caps.textNormalization,
      maxCharacters: caps.maxCharacters || 3000,
      supportedOutputFormats: caps.supportedOutputFormats || ['mp3']
    };
  }

  /* ==================== 3. 连接与配置（读写） ==================== */

  function newId(prefix) {
    return (prefix || 'tts') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function settings() {
    var s = store.get('ttsSettings');
    if (!s || typeof s !== 'object') s = clone(DEFAULT_SETTINGS);
    s.output = mergeObj(OUTPUT_DEFAULT, s.output || {});
    return s;
  }
  function saveSettings(patch) {
    var cur = settings();
    for (var k in patch) if (has(patch, k)) cur[k] = patch[k];
    store.set('ttsSettings', cur);
    return cur;
  }

  function connections() {
    var list = store.get('ttsConnections');
    return Array.isArray(list) ? list : [];
  }
  function connection(id) {
    var list = connections();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /* 供应商的「第一条连接」：不带参数就取全局第一条。
     设置页的「默认服务」下拉、以及没选默认时的回落都用它。 */
  function firstConnectionOf(providerId) {
    var list = connections();
    for (var i = 0; i < list.length; i++) {
      if (!providerId || list[i].provider === providerId) return list[i];
    }
    return null;
  }
  function hasModel(providerId, modelId) {
    var list = modelsOf(providerId);
    for (var i = 0; i < list.length; i++) if (list[i].id === modelId) return true;
    return false;
  }
  /* 新建或更新一条连接。status 由「测试连接」写，**不许**在这里默认成 connected。 */
  function saveConnection(data) {
    data = data || {};
    var list = connections();
    var hit = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === data.id) { hit = list[i]; break; }
    if (!hit) {
      var p = providerOf(data.provider) || PROVIDERS.fish_audio;
      hit = {
        id: data.id || newId('ttsc'),
        provider: p.id,
        displayName: data.displayName || p.defaultName,
        endpoint: data.endpoint === undefined ? (p.endpoint || '') : data.endpoint,
        apiKey: '',
        /* 连接级模型：只有「自定义 · OpenAI 兼容」这种自填模型的服务会用（见 freeModel） */
        model: data.model || '',
        status: 'unconfigured',
        createdAt: Date.now()
      };
      list.push(hit);
    }
    for (var k in data) {
      if (!has(data, k) || data[k] === undefined) continue;
      if (k === 'status' || k === 'lastVerifiedAt' || k === 'lastErrorCode') continue;  /* 只由测试写 */
      hit[k] = data[k];
    }
    hit.updatedAt = Date.now();
    /* 有 Key 但没验过 = untested（**不能**自己变成 connected —— 契约 §11.3：测试失败不能写成已连接、
       未配置 Key 不能显示已连接） */
    if (!hit.apiKey) hit.status = 'unconfigured';
    else if (hit.status === 'unconfigured') hit.status = 'untested';
    store.set('ttsConnections', list);
    return hit;
  }
  function removeConnection(id) {
    var list = connections().filter(function (c) { return c.id !== id; });
    store.set('ttsConnections', list);
    /* 契约 §8.8：删掉当前默认服务时**不许无条件回退 Fish** ——
       有其他连接就用第一件，否则置空。 */
    var s = settings();
    if (s.defaultConnectionId === id) {
      s.defaultConnectionId = list.length ? list[0].id : null;
      store.set('ttsSettings', s);
    }
    /* 引用了这条连接的角色会得到明确的「连接不存在」错误（见 resolveVoice），
       这里不替他们改配置 —— 改了就变成「静默换了个声音」。 */
    return { ok: true, fallbackTo: s.defaultConnectionId };
  }

  /* 脱敏：日志/报错里只能出现这个，不许出现完整 Key */
  function maskKey(k) {
    k = String(k || '');
    if (!k) return '(无)';
    if (k.length <= 4) return '****';
    return '****' + k.slice(-4);
  }

  /* ==================== 4. 角色语音配置（单一状态源） ====================
     形状照 page-char-appearance.js 的 charAppearance：{ global, byChar }，
     解析顺序 = 角色专属 > 全局 > 出厂默认。角色语音页**只读写这一个对象**，
     页面里的 DOM 不许自己记一份（契约 §9.6）。 */
  function voiceAll() {
    var v = store.get('charVoice');
    if (!v || typeof v !== 'object') v = { global: null, byChar: {} };
    if (!v.byChar || typeof v.byChar !== 'object') v.byChar = {};
    return v;
  }
  function voiceConfigOf(charId) {
    var all = voiceAll();
    var base = mergeObj(DEFAULT_VOICE, all.global || {});
    var own = (charId && all.byChar[charId]) || null;
    if (!own) return base;
    return mergeObj(base, own);
  }
  function saveVoice(charId, patch) {
    var all = voiceAll();
    if (charId) {
      all.byChar[charId] = mergeObj(all.byChar[charId] || {}, patch || {});
    } else {
      all.global = mergeObj(all.global || {}, patch || {});
    }
    store.set('charVoice', all);
    return charId ? all.byChar[charId] : all.global;
  }
  function hasOwnVoice(charId) {
    var all = voiceAll();
    return !!(charId && all.byChar[charId]);
  }

  /* 解析「这个角色这次要用哪条连接 / 哪个模型」。
     返回 { ok, conn, model, provider, voiceId, error } —— 缺什么就明说缺什么，
     不要让上层去猜（契约 §11.3：删除连接后引用它的角色要得到明确不可用状态）。 */
  function resolveVoice(charId) {
    var cfg = voiceConfigOf(charId);
    var s = settings();
    var connId = cfg.connectionMode === 'override' && cfg.connectionId
      ? cfg.connectionId : s.defaultConnectionId;
    if (!s.enabled) return { ok: false, cfg: cfg, code: 'TTS_DISABLED' };
    if (!connId) return { ok: false, cfg: cfg, code: 'CONNECTION_MISSING' };
    var conn = connection(connId);
    if (!conn) return { ok: false, cfg: cfg, code: 'CONNECTION_MISSING' };
    if (!conn.apiKey) return { ok: false, cfg: cfg, conn: conn, code: 'CREDENTIAL_MISSING' };
    if (!cfg.voiceId) return { ok: false, cfg: cfg, conn: conn, code: 'VOICE_ID_MISSING' };
    /* 模型的三层回落：角色单独设的 → **连接上填的**（自建/中转的服务模型名五花八门，
       只能在连接里自由填）→ 全局默认 → 这家第一条。 */
    var model = (cfg.modelMode === 'override' && cfg.model) ? cfg.model
      : (conn.model || s.defaultModel || '');
    if (!model) model = (providerOf(conn.provider) || PROVIDERS.fish_audio).models[0].id;
    return {
      ok: true, cfg: cfg, conn: conn, model: model,
      provider: conn.provider, voiceId: cfg.voiceId,
      caps: capabilitiesOf(conn.provider, model)
    };
  }

  /* ==================== 5. 语音导演（规则版，纯函数） ====================
     输出**只有** SpeechPlan，绝不输出服务商标签字符串。 */

  /* 情绪词典：保守。命中不了就 neutral（契约 §5.2「不确定时回退 neutral」）。
     每项给一个基础强度，最终强度还要乘上用户设的「情绪幅度」。 */
  var EMO_WORDS = [
    { e: 'tender', w: 0.5, re: /(晚安|抱抱|乖|想你|注意身体|别累着|别熬|早点休息|早点睡|好好吃饭|照顾好自己)/ },
    { e: 'concerned', w: 0.55, re: /(怎么了|没事吧|还好吗|小心|别逞强|你要不要紧|担心你)/ },
    { e: 'disappointed', w: 0.6, re: /(失望|没想到你会|你答应过|说好的|又放我鸽子)/ },
    { e: 'sad', w: 0.6, re: /(难过|想哭|算了|对不起|别说了|心里堵)/ },
    { e: 'angry', w: 0.7, re: /(你太过分|烦死|忍不了|别逼我|凭什么)/ },
    { e: 'annoyed', w: 0.55, re: /(别闹|懒得|随便你|啧|懒得理|烦人)/ },
    { e: 'cold', w: 0.5, re: /(不关我的事|与我无关|知道了。|嗯。$)/ },
    { e: 'tired', w: 0.45, re: /(累|熬不动|太晚了|睡了|困|没力气)/ },
    { e: 'happy', w: 0.6, re: /(哈哈|开心|真好|喜欢你|太好|嘿嘿)/ },
    { e: 'surprised', w: 0.6, re: /(真的假的|居然|竟然|没想到|哇)/ }
  ];

  /* 表演信号：只在**文本里真有这个动作**时才给（契约 §6.2 的「只在确有语义时」） */
  var TAG_WORDS = [
    { t: 'laugh', re: /(哈哈|嘿嘿|笑出声|笑了笑|乐了)/ },
    { t: 'sigh', re: /(唉|哎|叹了口?气|长叹)/ },
    { t: 'whisper', re: /(小声|悄悄|压低声音|嘘)/ },
    { t: 'crying', re: /(哭|哽咽|眼泪|抽泣)/ },
    { t: 'breathy', re: /(气声|喘|呼吸不稳)/ }
  ];

  var MAX_CHARS_SOFT = 120;   /* 超过这个字数就不再堆标签（短句也不堆） */

  function isCJK(s) { return /[\u4e00-\u9fa5]/.test(s); }

  /* 时长估算：中文按 4.5 字/秒，英文按 2.6 词/秒，取两者较大。
     它只服务「最长语音」这个**生成前筛选**（契约 §4.3 的注意），不是服务商参数。 */
  function estimateSeconds(text, pace) {
    var t = String(text || '');
    if (!t.trim()) return 0;
    var cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (t.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;
    var sec = Math.max(cjk / 4.5, words / 2.6);
    var p = (pace || 100) / 100;
    return Math.round((sec / (p || 1)) * 10) / 10;
  }

  /* 导演主函数（纯）。入参：
       text      待合成的**原文**（不改它）
       cfg       角色语音配置（voiceConfigOf 的产物）
       opts      { manual, cooldownTurns, charsSinceVoice, turnsSinceVoice, rng, lastUserText }
     出参：Contract §4.4 的 SpeechPlan。 */
  function speechPlanOf(text, cfg, opts) {
    cfg = mergeObj(DEFAULT_VOICE, cfg || {});
    opts = opts || {};
    var rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    var clean = String(text || '').trim();
    var base = {
      shouldGenerate: false,
      reason: 'not_suitable',
      emotion: 'neutral',
      intensity: 0,
      restraint: clamp01((cfg.restraint || 0) / 100),
      pace: paceRatio(cfg.pace),
      performanceTags: []
    };
    if (!cfg.enabled) { base.reason = 'disabled'; return base; }
    if (!clean) { base.reason = 'not_suitable'; return base; }

    /* 手动朗读：绕过主动频率，但仍受长度限制（契约 §5.10） */
    var manual = !!opts.manual;
    var sec = estimateSeconds(clean, cfg.pace);
    if (sec > (cfg.maxSeconds || 30)) { base.reason = 'too_long'; return base; }

    if (!manual) {
      if (cfg.frequency === 'never') { base.reason = 'disabled'; return base; }
      if (cfg.frequency === 'requested') { base.reason = 'not_suitable'; return base; }
      /* 冷却：最近 cooldownTurns 轮内发过就不发（用「查消息本身」算出来的，见 page-chat） */
      if (typeof opts.turnsSinceVoice === 'number' &&
          opts.turnsSinceVoice < (cfg.cooldownTurns || 0)) {
        base.reason = 'cooldown'; return base;
      }
      var chance = FREQ_CHANCE[cfg.frequency];
      if (typeof chance !== 'number') chance = 0;
      if (rng() > chance) { base.reason = 'not_suitable'; return base; }
      base.reason = 'frequency_match';
    } else {
      base.reason = 'manual_read';
    }

    /* ---- 情绪：命中一个就够（契约 §5.1 每句最多一个主情绪）---- */
    var emotion = 'neutral';
    var hitW = 0;
    if (cfg.emotionAuto !== false) {
      for (var i = 0; i < EMO_WORDS.length; i++) {
        var m = EMO_WORDS[i];
        if (!allowedEmotion(cfg, m.e)) continue;
        if (m.re.test(clean)) { emotion = m.e; hitW = m.w; break; }
      }
    }
    if (emotion === 'neutral') hitW = 0.25;

    /* 强度 = 文本信号 × 用户的情绪幅度。标点只能**小幅**加成，不许把平静话变成吼叫 */
    var puncBoost = 0;
    if (/[!！]{1,}/.test(clean)) puncBoost += 0.12;
    if (/[?？]{2,}|[!！]{2,}/.test(clean)) puncBoost += 0.08;
    var amp = clamp01((cfg.emotionIntensity || 0) / 100);
    var intensity = clamp01((hitW + puncBoost) * (0.4 + amp * 1.2));
    base.intensity = Math.round(intensity * 100) / 100;
    base.emotion = emotion;

    /* ---- 表演标签：白名单 + 上限 + 克制降级 ---- */
    var tags = [];
    for (var j = 0; j < TAG_WORDS.length; j++) {
      if (tags.length >= 2) break;
      if (TAG_WORDS[j].re.test(clean) && allowedTag(cfg, TAG_WORDS[j].t)) tags.push(TAG_WORDS[j].t);
    }
    /* 高克制度优先**减少标签**，而不是加一句「克制」（契约 §5.7 / §6.3） */
    if (base.restraint >= 0.8) tags = tags.slice(0, 1);
    /* 短句也不堆 */
    if (clean.length <= 12) tags = tags.slice(0, 1);
    if (clean.length > MAX_CHARS_SOFT) tags = [];
    base.performanceTags = tags;

    /* 语速：情绪激烈稍微快一点，克制时不动（只在 ±8% 内，别让人听出机械感） */
    if (intensity >= 0.7 && emotion !== 'cold' && emotion !== 'tired') {
      base.pace = round2(clamp(paceRatio(cfg.pace) + 0.06, 0.7, 1.3));
    } else if (emotion === 'tired' || emotion === 'sad') {
      base.pace = round2(clamp(paceRatio(cfg.pace) - 0.06, 0.7, 1.3));
    }

    base.shouldGenerate = true;
    base.seconds = sec;
    return base;
  }

  function allowedEmotion(cfg, e) {
    var list = cfg.allowedEmotions;
    if (!Array.isArray(list) || !list.length) return EMOTIONS.indexOf(e) >= 0;
    return list.indexOf(e) >= 0;
  }
  function allowedTag(cfg, t) {
    var list = cfg.allowedPerformanceTags;
    if (!Array.isArray(list) || !list.length) return false;
    return list.indexOf(t) >= 0;
  }
  function paceRatio(v) {
    var n = Number(v);
    if (!isFinite(n) || !n) n = 100;
    return round2(clamp(n / 100, 0.7, 1.3));
  }
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }
  function clamp01(n) { return clamp(Number(n) || 0, 0, 1); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* ==================== 6. Adapter（服务商无关的入口） ==================== */

  /* Sleepy → Fish 的映射表（契约 §6，直接抄表，别自己发挥） */
  var FISH_EMOTION = {
    neutral: 'calm', happy: 'happy', tender: 'empathetic', concerned: 'worried',
    sad: 'sad', disappointed: 'disappointed', surprised: 'surprised',
    angry: 'angry', annoyed: 'frustrated', cold: 'indifferent',
    tired: ''            /* 需实测；失败时回退「不加标签」 */
  };
  var FISH_TAG = {
    soft: 'soft tone', low: '', laugh: 'chuckling', sigh: 'sighing',
    whisper: 'whispering', breathy: '', crying: 'sobbing'
  };

  /* 强度三档（契约 §6.3）。两个额外约束是从「高克制不吼叫」那条推出来的：
     · 短句永远不用 `very`；
     · 克制度 >= 0.8 时连 `very` 都不给（契约原话是「优先降低标签数量和**强度**」）。 */
  function fishIntensityWord(intensity, text, restraint) {
    if ((restraint || 0) >= 0.8) return '';
    var short = String(text || '').trim().length <= 12;
    if (intensity >= 0.73 && !short) return 'very ';
    if (intensity > 0.02 && intensity <= 0.32) return 'slightly ';
    return '';
  }

  /* synthesisText 的组装（**纯函数**：不改传入的 originalText）。 */
  function buildFishSynthesisText(originalText, plan) {
    var text = String(originalText || '');
    if (!text.trim()) throw new Error('原文是空的，不能送去合成');
    if (!plan || !plan.shouldGenerate) return text;
    var tags = [];
    var emo = FISH_EMOTION[plan.emotion];
    /* 平静 + 零强度 = 压根没有情绪信号 → 一个标签都不加（最保守，也最省事） */
    var flatNeutral = plan.emotion === 'neutral' && !(plan.intensity > 0.02);
    if (emo && !flatNeutral) {
      /* 平静**不加强度词**：neutral 的意思是「没有情绪信号」，
         「slightly calm」读出来是自相矛盾的（契约 §6.1 给的是 [calm]）。 */
      var w = plan.emotion === 'neutral' ? '' : fishIntensityWord(plan.intensity, text, plan.restraint);
      tags.push(w + emo);
    } else if (!flatNeutral && plan.emotion !== 'neutral' && plan.intensity <= 0.32) {
      /* 映射不到的（如 tired）走自然语言轻量提示；失败也只是更平静，不会更糟 */
      tags.push('soft tone');
    }
    var per = plan.performanceTags || [];
    for (var i = 0; i < per.length && tags.length < 3; i++) {
      /* 只认闭集里的标签 —— 手写的坏计划也不许把控制串塞进来 */
      if (TAGS.indexOf(per[i]) < 0) continue;
      var f = FISH_TAG[per[i]];
      if (f) tags.push(f);
    }
    /* 短句不堆（契约 §6.3） */
    if (text.trim().length <= 12) tags = tags.slice(0, 1);
    /* 高克制先减标签 */
    if (plan.restraint >= 0.8) tags = tags.slice(0, 2);
    if (!tags.length) return text;
    var head = tags.map(function (t) { return '[' + t + ']'; }).join('');
    return head + ' ' + text;
  }

  /* MiniMax：情绪走 voice_setting.emotion（只映射已确认的），
     表演走**文本内括号语气词**（只有 2.8 系列吃） */
  var MM_EMOTION = { neutral: '', happy: 'happy', sad: 'sad', angry: 'angry', surprised: 'surprised' };
  var MM_TAG = { laugh: '(chuckle)', sigh: '(sighs)', breathy: '(breath)' };

  function buildMiniMaxText(originalText, plan, caps) {
    var text = String(originalText || '');
    if (!text.trim()) throw new Error('原文是空的，不能送去合成');
    if (!plan || !plan.shouldGenerate) return { text: text, emotion: '' };
    var tags = [];
    if (caps && caps.performanceTags) {
      var per = plan.performanceTags || [];
      for (var i = 0; i < per.length && tags.length < 2; i++) {
        if (MM_TAG[per[i]]) tags.push(MM_TAG[per[i]]);
      }
    }
    var emo = MM_EMOTION[plan.emotion] || '';
    var body = tags.length ? (tags.join('') + text) : text;
    return { text: body, emotion: emo };
  }

  /* ---- ElevenLabs ----
     只有 v3 有 Audio Tags，而且这里的映射**只放官方文档里出现过的标签**
     （v3 提示词指南的「Voice-related」表 + 帮助中心的例子）。
     官方标签表里没有对应词的（sad / angry / tired / disappointed / cold，
     以及声学类的 soft / low）**一律不加** —— 契约「无法映射回退无标签」，
     与其拼一个可能被念出来的词，不如安静地按音色本身的底子读。
     Multilingual v2 / Flash 根本没有标签控制，capabilities.performanceTags=false
     会把这条路彻底关掉（UI 里那些开关也跟着不出现）。 */
  var EL_EMOTION = {
    neutral: '',
    happy: 'happy',
    tender: 'reassuring',
    concerned: 'sympathetic',
    sad: '',
    disappointed: '',
    surprised: 'surprised',
    angry: '',
    annoyed: 'annoyed',
    cold: '',
    tired: ''
  };
  var EL_TAG = {
    laugh: 'laughs',
    sigh: 'sighs',
    whisper: 'whispers',
    crying: 'crying',
    breathy: 'exhales'
    /* soft / low：v3 没有对应标签，靠音色本身 */
  };

  function buildElevenText(originalText, plan, caps) {
    var text = String(originalText || '');
    if (!text.trim()) throw new Error('原文是空的，不能送去合成');
    if (!plan || !plan.shouldGenerate) return text;
    /* 没有标签能力的档位（v2 / Flash）连主情绪都不加 */
    if (!caps || !caps.performanceTags) return text;
    var tags = [];
    var emo = EL_EMOTION[plan.emotion];
    if (emo) tags.push(emo);
    var per = plan.performanceTags || [];
    for (var i = 0; i < per.length && tags.length < 3; i++) {
      if (EL_TAG[per[i]]) tags.push(EL_TAG[per[i]]);
    }
    /* 短句不堆（和 Fish 那条同一条规矩） */
    if (text.trim().length <= 12) tags = tags.slice(0, 1);
    /* 高克制先减标签 */
    if (plan.restraint >= 0.8) tags = tags.slice(0, 2);
    if (!tags.length) return text;
    return tags.map(function (t) { return '[' + t + ']'; }).join('') + ' ' + text;
  }

  /* VoiceSettings：官方字段 stability / similarity_boost / style / use_speaker_boost / speed。
     普通用户不该看到完整声学面板（MiniMax 那份 §5.2），所以这里只做**两件事**：
     克制度 → stability（越高越稳），情绪幅度 → style（越大越夸张）。
     相似度用官方默认 0.75，不暴露；speed 只在模型支持时才发（官方范围 0.7–1.2）。
     ⚠️ 读的是 **SpeechPlan**（intensity / restraint / pace 都是归一化过的），
     不是角色配置里的 0–100 —— Adapter 只认计划，别在这里再回头翻配置。 */
  function buildElevenVoiceSettings(plan, caps) {
    var restraint = plan ? clamp01(plan.restraint) : 0.7;
    var intensity = plan ? clamp01(plan.intensity) : 0;
    var out = {
      stability: round2(0.25 + restraint * 0.45),
      similarity_boost: 0.75,
      style: round2(intensity * 0.6),
      use_speaker_boost: true
    };
    if (caps && caps.speed && plan && plan.pace) {
      out.speed = round2(clamp(Number(plan.pace), 0.7, 1.2));
    }
    return out;
  }

  /* 音色在 URL 路径里。自建中转可以在「接口地址」里写 {voice_id} 占位，
     我们按占位替换；没写占位就默认拼在末尾（官方形状）。
     ⚠️ 地址上**本来就带查询串**时（中转常见 ?token=xxx），音色必须插在 ? 之前 ——
     直接字符串相加会拼出 .../tts?token=abc/<voice_id> 这种地址（真机上就是 404）。 */
  function elUrl(endpoint, voiceId, output) {
    var base = String(endpoint || '').trim() || PROVIDERS.elevenlabs.endpoint;
    var id = encodeURIComponent(voiceId || '');
    var u;
    if (base.indexOf('{voice_id}') >= 0) {
      u = base.replace('{voice_id}', id);
    } else {
      var qi = base.indexOf('?');
      var path = qi >= 0 ? base.slice(0, qi) : base;
      var qs = qi >= 0 ? base.slice(qi) : '';
      u = path.replace(/\/+$/, '') + '/' + id + qs;
    }
    var o = output || OUTPUT_DEFAULT;
    var fmt = 'mp3_' + (Number(o.sampleRate) || 44100) + '_' + (Number(o.bitrate) || 128);
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'output_format=' + fmt;
  }

  /* ---- OpenAI 兼容（/v1/audio/speech）----
     硅基流动与「自定义」共用这一条：body 是 { model, input, voice, response_format, speed }。
     两家都**没有**标签/情绪字段（硅基流动文档里只列了 model/input/voice/speed/gain/
     response_format/sample_rate），所以 caps.performanceTags 一律 false，
     合成文本就是原文 —— 有标签能力才拼标签，这是 Adapter 的底线。 */
  function openAICompatBody(model, text, voiceId, plan, caps, output) {
    var o = output || OUTPUT_DEFAULT;
    var body = {
      model: model,
      input: text,
      voice: voiceId,
      response_format: o.format || 'mp3'
    };
    /* 两家的 speed 都是 0.25–4.0（OpenAI 文档 / 硅基流动文档），比别家宽得多 */
    if (caps && caps.speed && plan && plan.pace) body.speed = round2(clamp(Number(plan.pace), 0.25, 4));
    return body;
  }

  /* ---- Azure：只吃 SSML，音色写在正文里，没有 model 字段 ---- */
  function xmlEscape(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  /* Azure 输出格式是一串编号（`X-Microsoft-OutputFormat`），不是 mime。
     ⚠️ 它能认的**只有这几组固定搭配**（16k:32/64/128、24k:48/96/160、48k:96/192），
     拿我们的 44100/128 直接拼 `audio-44khz-128kbitrate-mono-mp3` 会被它 400 掉 ——
     所以就近取一档能用的组合。 */
  var AZURE_FORMATS = { 16000: [32, 64, 128], 24000: [48, 96, 160], 48000: [96, 192] };
  function azureFormatOf(output) {
    var o = output || OUTPUT_DEFAULT;
    var rate = Number(o.sampleRate) || 44100;
    var bit = Number(o.bitrate) || 128;
    var r = Number(Object.keys(AZURE_FORMATS).reduce(function (best, x) {
      return Math.abs(Number(x) - rate) < Math.abs(Number(best) - rate) ? x : best;
    }, 24000));
    var allowed = AZURE_FORMATS[r];
    var b = allowed.reduce(function (best, x) {
      return Math.abs(x - bit) < Math.abs(best - bit) ? x : best;
    }, allowed[0]);
    return 'audio-' + (r / 1000) + 'khz-' + b + 'kbitrate-mono-mp3';
  }
  /* xml:lang 按文本猜（中文/英文两种够用了）—— Azure 认这个字段来选发音规则 */
  function azureLangOf(text) {
    return /[\u4e00-\u9fa5]/.test(String(text || '')) ? 'zh-CN' : 'en-US';
  }
  function buildAzureSsml(text, voiceId) {
    return "<speak version='1.0' xml:lang='" + azureLangOf(text) + "'>" +
      "<voice name='" + xmlEscape(voiceId) + "'>" + xmlEscape(text) + "</voice></speak>";
  }

  /* 服务商映射的对外入口（给 UI 的「高级诊断」看脱敏结果用） */
  function synthesisTextOf(providerId, originalText, plan, caps) {
    if (providerId === 'minimax') return buildMiniMaxText(originalText, plan, caps).text;
    if (providerId === 'elevenlabs') return buildElevenText(originalText, plan, caps);
    if (providerId === 'fish_audio') return buildFishSynthesisText(originalText, plan);
    /* 其余（硅基流动 / Azure / 自定义）没有标签与情绪字段 —— 原文怎么说就怎么念 */
    return String(originalText || '');
  }

  /* ---- 请求组装（纯函数：给什么出什么，不发请求）---- */

  function buildRequest(input) {
    var provider = input.provider;
    var conn = input.conn || {};
    var endpoint = String(conn.endpoint || (providerOf(provider) || {}).endpoint || '').trim();
    var output = input.output || OUTPUT_DEFAULT;
    var plan = input.plan;

    if (provider === 'fish_audio') {
      var text = buildFishSynthesisText(input.originalText, plan);
      return {
        provider: provider,
        url: endpoint || PROVIDERS.fish_audio.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (conn.apiKey || ''),
          'model': input.model
        },
        /* 契约 §7.2 的字段名（snake_case），参数由 Adapter 用验证过的默认值给 */
        body: {
          text: text,
          reference_id: input.voiceId,
          prosody: {
            speed: plan ? plan.pace : 1,
            volume: 0,
            normalize_loudness: !!output.normalizeLoudness
          },
          normalize: !!output.normalize,
          format: output.format,
          sample_rate: output.sampleRate,
          mp3_bitrate: output.bitrate,
          latency: output.latency
        },
        synthesisText: text,
        /* 音频直接以二进制回来 */
        expect: 'audio'
      };
    }

    if (provider === 'minimax') {
      var caps = capabilitiesOf(provider, input.model);
      var mm = buildMiniMaxText(input.originalText, plan, caps);
      var body = {
        model: input.model,
        text: mm.text,
        stream: false,
        voice_setting: {
          voice_id: input.voiceId,
          speed: plan ? plan.pace : 1,
          vol: 1,
          pitch: 0
        },
        audio_setting: {
          sample_rate: output.sampleRate,
          bitrate: output.bitrate,
          format: output.format,
          channel: 1
        },
        /* hex：直接把音频塞在 JSON 里，省一次外链下载，也不用管 24 小时的 URL 过期 */
        output_format: 'hex'
      };
      if (mm.emotion) body.voice_setting.emotion = mm.emotion;
      return {
        provider: provider,
        url: endpoint || PROVIDERS.minimax.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (conn.apiKey || '')
        },
        body: body,
        synthesisText: mm.text,
        expect: 'json-hex'
      };
    }

    if (provider === 'elevenlabs') {
      var capsEl = capabilitiesOf(provider, input.model);
      var textEl = buildElevenText(input.originalText, plan, capsEl);
      var bodyEl = {
        text: textEl,
        model_id: input.model,
        voice_settings: buildElevenVoiceSettings(plan, capsEl)
      };
      /* 官方枚举 auto / on / off；多语言 v2 与 v3 的规范化一直开着，不用发。
         Flash 默认「可能不按预期规范化」（MiniMax 那份 §5.2 点名的坑）→ 显式打开。 */
      if (capsEl.textNormalization) bodyEl.apply_text_normalization = 'on';
      return {
        provider: provider,
        url: elUrl(endpoint, input.voiceId, output),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          /* 这家的凭据头是 xi-api-key，不是 Authorization（照抄别人的适配器就死在这） */
          'xi-api-key': conn.apiKey || '',
          'Accept': 'audio/mpeg'
        },
        body: bodyEl,
        synthesisText: textEl,
        expect: 'audio'
      };
    }

    /* OpenAI 兼容那两家（硅基流动 / 自定义）：同一份 body，只有地址与音色写法不同 */
    if (provider === 'siliconflow' || provider === 'custom_openai') {
      var capsO = capabilitiesOf(provider, input.model);
      var textO = String(input.originalText || '');
      if (!textO.trim()) throw new Error('原文是空的，不能送去合成');
      var bodyO = openAICompatBody(input.model, textO, input.voiceId, plan, capsO, output);
      /* 硅基流动的 mp3 采样率只支持 32000/44100 —— 别的值会被它拒掉 */
      if (provider === 'siliconflow') bodyO.sample_rate = (Number(output.sampleRate) === 32000) ? 32000 : 44100;
      if (!endpoint) {
        /* 自定义那家**必须**先填地址（没有官方地址可回落） */
        return {
          provider: provider, unsupported: true,
          error: normalizedError('CONNECTION_MISSING', { message: '这条连接还没填接口地址' })
        };
      }
      return {
        provider: provider,
        url: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (conn.apiKey || '')
        },
        body: bodyO,
        synthesisText: textO,
        expect: 'audio'
      };
    }

    /* Azure：**只吃 SSML**，音色写在正文里；输出格式走 X-Microsoft-OutputFormat 头。
       它的凭据头是 Ocp-Apim-Subscription-Key（不是 Authorization）。 */
    if (provider === 'azure') {
      var textA = String(input.originalText || '');
      if (!textA.trim()) throw new Error('原文是空的，不能送去合成');
      if (!input.voiceId) {
        return { provider: provider, unsupported: true, error: normalizedError('VOICE_ID_MISSING') };
      }
      return {
        provider: provider,
        url: endpoint || PROVIDERS.azure.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': azureFormatOf(output),
          'Ocp-Apim-Subscription-Key': conn.apiKey || ''
        },
        /* 这一家的 body **不是 JSON**，是 XML 字符串 —— transport 认 rawBody */
        rawBody: buildAzureSsml(textA, input.voiceId),
        synthesisText: textA,
        expect: 'audio'
      };
    }

    /* 没有 Adapter 的服务商：**不许**走到这儿还假装能发 */
    return {
      provider: provider,
      unsupported: true,
      error: normalizedError('PROVIDER_ERROR', { message: '这家服务还没有适配器' })
    };
  }

  /* ---- 响应解析 ---- */

  function hexToBlob(hex, mime) {
    var clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
    if (!clean.length || clean.length % 2) throw new Error('音频数据是空的');
    var len = clean.length / 2;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    return new global.Blob([bytes], { type: mime || 'audio/mpeg' });
  }

  /* MiniMax 的成功与否**不能只看 HTTP 状态**（契约 MiniMax 那份 §2.3）：要查 base_resp */
  function parseMiniMaxJson(data) {
    var base = (data && data.base_resp) || {};
    var code = base.status_code;
    if (code !== undefined && code !== 0) {
      return { ok: false, error: normalizedError(codeToMiniMax(code, base.status_msg), {
        providerCode: code, message: base.status_msg || 'MiniMax 返回了错误'
      }) };
    }
    var hex = (data && (data.data && data.data.audio)) || '';
    if (!hex) return { ok: false, error: normalizedError('PROVIDER_ERROR', { message: 'MiniMax 没返回音频' }) };
    return { ok: true, blob: hexToBlob(hex), traceId: (data.trace_id || data['trace_id']) || null };
  }

  function codeToMiniMax(code, msg) {
    var m = String(msg || '') + ' ' + code;
    if (/1002|1004|auth|key/i.test(m)) return 'CREDENTIAL_INVALID';
    if (/1008|余额|balance|quota|insufficient/i.test(m)) return 'INSUFFICIENT_BALANCE';
    if (/1026|1027|rate|频繁|limit/i.test(m)) return 'RATE_LIMITED';
    if (/voice|1039/i.test(m)) return 'VOICE_NOT_FOUND';
    if (/model|2013/i.test(m)) return 'MODEL_UNAVAILABLE';
    if (/length|1035|too long|long/i.test(m)) return 'TEXT_TOO_LONG';
    return 'PROVIDER_ERROR';
  }

  /* ---- 错误归一化（契约 §10）---- */

  var ERROR_TEXT = {
    TTS_DISABLED: '语音还是关着的 —— 先去「设置 → 语音 TTS」打开。',
    CONNECTION_MISSING: '这件角色用的语音服务不在了（可能被删了）—— 去语音设置里重新选一条。',
    CREDENTIAL_MISSING: '这条语音服务还没填 API Key。',
    CREDENTIAL_INVALID: 'API Key 不对或已失效，去服务商控制台确认一下。',
    VOICE_ID_MISSING: '这个角色还没填音色 ID。',
    VOICE_NOT_FOUND: '音色 ID 找不到 —— 可能是别的账号下的音色，或者已经被删了。',
    MODEL_UNAVAILABLE: '这个模型现在不可用，换一个档位试试。',
    INSUFFICIENT_BALANCE: '服务商那边余额不足了。',
    RATE_LIMITED: '请求太频繁了，等一会儿再试。',
    TEXT_TOO_LONG: '这段话太长，不适合做语音。',
    PROVIDER_TIMEOUT: '服务商没在超时前回话，稍后再试。',
    PROVIDER_ERROR: '语音服务返回了错误。',
    AUDIO_DECODE_FAILED: '拿回来的音频解不开。',
    AUTOPLAY_BLOCKED: '系统拦住了自动播放 —— 点一下就能听。',
    EMPTY_TEXT: '这段话是空的，没什么可读的。'
  };

  function normalizedError(code, extra) {
    extra = extra || {};
    return {
      code: code || 'PROVIDER_ERROR',
      message: extra.message || ERROR_TEXT[code] || ERROR_TEXT.PROVIDER_ERROR,
      userText: ERROR_TEXT[code] || ERROR_TEXT.PROVIDER_ERROR,
      status: extra.status || 0,
      requestId: extra.requestId || null,
      providerCode: extra.providerCode || null,
      provider: extra.provider || null
    };
  }

  /* 把各家五花八门的错误体压成一句话。形状都不一样，谁也别猜：
       Fish        { "message": "..." }（有的还套层 data）
       ElevenLabs  401/403 → { "detail": { "message": "...", "code": "..." } }
                   422     → { "detail": [ { "loc": [...], "msg": "..." } ] }   ← detail 是数组
       MiniMax     成功也可能是业务错误，走 base_resp（见 parseMiniMaxJson）
     解析不出来就用原文，绝不编一个更好的说法。 */
  function errorMessageOf(rawText) {
    var t = String(rawText || '');
    var j = null;
    try { j = JSON.parse(t); } catch (e) { return t; }
    if (!j || typeof j !== 'object') return t;
    var d = j.detail;
    if (typeof d === 'string') return d;
    if (d && typeof d.message === 'string') return d.message;
    if (d && Array.isArray(d) && d.length) {
      var first = d[0] || {};
      if (first.msg) return String(first.msg);
    }
    if (typeof j.message === 'string') return j.message;
    /* Azure / OpenAI 系：{"error":{"code":"401","message":"..."}} */
    var e = j.error;
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
    if (j.data && typeof j.data.message === 'string') return j.data.message;
    return t;
  }

  /* HTTP 状态 + 原文 → 错误码。日志/提示都用它，别各写一份 if。 */
  function normalizeHttpError(provider, status, rawText) {
    var t = errorMessageOf(rawText);
    var code = 'PROVIDER_ERROR';
    if (status === 401 || status === 403) code = 'CREDENTIAL_INVALID';
    else if (status === 402) code = 'INSUFFICIENT_BALANCE';
    else if (status === 429) code = 'RATE_LIMITED';
    else if (status === 404) code = /voice|reference/i.test(t) ? 'VOICE_NOT_FOUND' : 'MODEL_UNAVAILABLE';
    else if (status === 413) code = 'TEXT_TOO_LONG';
    else if (status === 0) code = 'PROVIDER_TIMEOUT';
    else if (/balance|insufficient|余额|quota|credit/i.test(t)) code = 'INSUFFICIENT_BALANCE';
    else if (/invalid.{0,12}(api|key|token)|unauthor/i.test(t)) code = 'CREDENTIAL_INVALID';
    else if (/rate.?limit|too many/i.test(t)) code = 'RATE_LIMITED';
    /* 404 之外也会报音色：ElevenLabs 的「voice not found」是 400/422 */
    else if (/voice.{0,24}(not found|不存在|invalid)|voice_id/i.test(t)) code = 'VOICE_NOT_FOUND';
    else if (/model.{0,24}(not found|invalid|unavailable)|unsupported model/i.test(t)) code = 'MODEL_UNAVAILABLE';
    else if (/too long|max.{0,10}characters|字符|exceeds/i.test(t)) code = 'TEXT_TOO_LONG';
    return normalizedError(code, { status: status, provider: provider, message: t.slice(0, 200) });
  }

  /* ==================== 7. 发送（transport 可注入） ====================
     契约与项目约定双重要求：
       · 真实 fetch 兜底**必须存在**（没有它，生产环境里「没有可用的连接」）；
       · 注入点**按调用优先**（并发测试/真机脚本靠它，别只认全局 _transport）。 */

  var _transport = null;

  function defaultTransport(req) {
    var init = { method: req.method || 'POST', headers: req.headers || {} };
    /* rawBody：整段字符串原样发（Azure 的 SSML 就是这样，不能被 JSON.stringify 包一层） */
    if (req.rawBody !== undefined) init.body = req.rawBody;
    else if (req.body !== undefined) init.body = JSON.stringify(req.body);
    return global.fetch(req.url, init).then(function (r) {
      var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      /* ⚠️ 只有**成功**才按二进制读。出错时一律当文本读 ——
         不然 401 的 JSON 提示会被吞成「拿不到音频」，用户看不到原因。 */
      if (r.ok && (req.expect === 'audio' || /^audio\//.test(ct))) {
        return r.arrayBuffer().then(function (buf) {
          return { ok: true, status: r.status, contentType: ct, buffer: buf, requestId: r.headers.get('x-request-id') || null };
        });
      }
      return r.text().then(function (txt) {
        var json = null;
        try { json = JSON.parse(txt); } catch (e) { /* 原样带着 */ }
        return { ok: r.ok, status: r.status, contentType: ct, text: txt, json: json, requestId: r.headers.get('x-request-id') || null };
      });
    }, function (err) {
      /* AbortError / 网络失败都归到「连不上」：status 0 */
      return { ok: false, status: 0, networkError: true, text: (err && err.message) || 'network error' };
    });
  }

  function responseToBlob(provider, resp) {
    if (provider === 'minimax') {
      /* hex 那条路自己会带上 mime（hexToBlob），这里不改 */
      return parseMiniMaxJson(resp.json);
    }
    if (!resp.buffer || !resp.buffer.byteLength) {
      /* 出错时多数家也会回 JSON —— 用统一那句 errorMessageOf 拿出来（别在这只认 message） */
      return { ok: false, error: normalizeHttpError(provider, resp.status || 0, resp.text) };
    }
    /* 类型跟着响应走（服务商回什么就存什么）——
       写死 audio/mpeg 的话，中转/自建接口回 wav 或 ogg 时标签就是错的。 */
    var mime = /^audio\//.test(resp.contentType || '') ? resp.contentType : 'audio/mpeg';
    return { ok: true, blob: new global.Blob([resp.buffer], { type: mime }), requestId: resp.requestId };
  }

  /* 生成一条语音。**不改任何业务数据**，只回 blob（存不存、挂哪条消息由调用方决定）。
     opt.charId  → 按角色的语音配置解析连接/模型/音色（正常路径）
     opt.conn    → 直接用这条连接（设置页的「测试语音生成」走这条，因为那时
                   连接还没设成默认、也不属于任何角色） */
  function generate(opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      var r;
      if (opt.conn) {
        var prov = providerOf(opt.conn.provider);
        if (!prov || prov.planned) {
          resolve({ ok: false, skipped: false, error: normalizedError('PROVIDER_ERROR', { message: '这家服务还没有适配器' }) });
          return;
        }
        if (!opt.conn.apiKey) { resolve({ ok: false, error: normalizedError('CREDENTIAL_MISSING') }); return; }
        if (!opt.voiceId) { resolve({ ok: false, error: normalizedError('VOICE_ID_MISSING') }); return; }
        r = {
          ok: true, cfg: mergeObj(DEFAULT_VOICE, { enabled: true, restraint: 80 }),
          conn: opt.conn, model: opt.model || opt.conn.model || settings().defaultModel,
          provider: opt.conn.provider, voiceId: opt.voiceId,
          caps: capabilitiesOf(opt.conn.provider, opt.model || settings().defaultModel)
        };
      } else {
        r = resolveVoice(opt.charId);
      }
      if (!r.ok) { resolve({ ok: false, skipped: true, error: normalizedError(r.code) }); return; }
      var cfg = r.cfg;
      var plan = opt.plan || speechPlanOf(opt.text, cfg, {
        manual: opt.manual,
        turnsSinceVoice: opt.turnsSinceVoice,
        rng: opt.rng,
        lastUserText: opt.lastUserText
      });
      if (!plan.shouldGenerate) {
        resolve({ ok: false, skipped: true, plan: plan, error: normalizedError('EMPTY_TEXT') });
        return;
      }
      var req = buildRequest({
        provider: r.provider, conn: r.conn, model: r.model, voiceId: r.voiceId,
        plan: plan, originalText: opt.text, output: settings().output
      });
      if (req.unsupported) { resolve({ ok: false, plan: plan, error: req.error }); return; }
      var send = opt.transport || _transport || defaultTransport;
      Promise.resolve(send(req)).then(function (resp) {
        if (!resp.ok) {
          /* 看 status 分「超时/连不上」和「服务商明确报错」，别一律当成同一件事 */
          if (!resp.status) {
            resolve({ ok: false, plan: plan, req: req, error: normalizedError('PROVIDER_TIMEOUT') });
            return;
          }
          var t = resp.text;
          if (!t && resp.json) t = JSON.stringify(resp.json).slice(0, 200);
          resolve({ ok: false, plan: plan, req: req, error: normalizeHttpError(r.provider, resp.status, t) });
          return;
        }
        var parsed = responseToBlob(r.provider, resp);
        if (!parsed.ok) { resolve({ ok: false, plan: plan, req: req, error: parsed.error }); return; }
        resolve({
          ok: true, blob: parsed.blob, plan: plan, req: req,
          provider: r.provider, model: r.model,
          synthesisText: req.synthesisText,
          seconds: plan.seconds || estimateSeconds(opt.text, cfg.pace),
          requestId: parsed.requestId || null
        });
      }, function (err) {
        resolve({ ok: false, plan: plan, error: normalizedError('PROVIDER_ERROR', { message: (err && err.message) || String(err) }) });
      });
    });
  }

  /* 测试连接：走**同一条** Adapter 路径（契约 §11.3：测试失败不能写成已连接）。
     不填音色时只做到「鉴权 + 端点可达」这一步 —— 用一个极短文本 + 空音色是过不了
     服务商的，所以我们要求音色 ID（设置页里会提示「测试需要先填音色 ID」）。 */
  function testConnection(conn, voiceId) {
    var p = providerOf(conn && conn.provider);
    if (!p) return Promise.resolve({ ok: false, error: normalizedError('PROVIDER_ERROR', { message: '不认识的语音服务' }) });
    if (p.planned) return Promise.resolve({ ok: false, error: normalizedError('PROVIDER_ERROR', { message: p.name + ' 还没有适配器（计划支持）' }) });
    if (!conn.apiKey) return Promise.resolve({ ok: false, error: normalizedError('CREDENTIAL_MISSING') });
    if (!voiceId) return Promise.resolve({ ok: false, error: normalizedError('VOICE_ID_MISSING') });
    var model = conn.model || settings().defaultModel;
    if (!hasModel(conn.provider, model)) {
      model = (p.models[0] || {}).id;
    }
    if (!hasModel(conn.provider, model)) {
      return Promise.resolve({ ok: false, error: normalizedError('MODEL_UNAVAILABLE') });
    }
    var plan = { shouldGenerate: true, reason: 'manual_read', emotion: 'neutral', intensity: 0, restraint: 0.8, pace: 1, performanceTags: [] };
    var req = buildRequest({
      provider: conn.provider, conn: conn, model: model, voiceId: voiceId,
      plan: plan, originalText: '你好，这是一次测试。', output: settings().output
    });
    /* 组装都组不出来（比如自定义那家还没填地址）就不要发出去 ——
       发出去只会变成「连不上」，把真正的原因盖掉。 */
    if (req.unsupported) return Promise.resolve({ ok: false, error: req.error });
    var send = _transport || defaultTransport;
    return Promise.resolve(send(req)).then(function (resp) {
      if (!resp.ok) {
        if (!resp.status) return { ok: false, error: normalizedError('PROVIDER_TIMEOUT') };
        var t = resp.text;
        if (!t && resp.json) t = JSON.stringify(resp.json).slice(0, 200);
        return { ok: false, error: normalizeHttpError(conn.provider, resp.status, t) };
      }
      var parsed = responseToBlob(conn.provider, resp);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, bytes: parsed.blob.size, requestId: parsed.requestId || null, model: model };
    }, function (err) {
      return { ok: false, error: normalizedError('PROVIDER_ERROR', { message: (err && err.message) || String(err) }) };
    });
  }

  /* 状态四档的落盘（只有这里能改 status） */
  function markConnection(id, status, extra) {
    var list = connections();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      list[i].status = status;
      if (status === 'connected') {
        list[i].lastVerifiedAt = new Date().toISOString();
        list[i].lastErrorCode = null;
      } else if (status === 'error') {
        list[i].lastErrorCode = (extra && extra.code) || 'PROVIDER_ERROR';
      }
      store.set('ttsConnections', list);
      return list[i];
    }
    return null;
  }

  /* ==================== 8. 小工具（别处要用同一份） ==================== */

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function mergeObj(base, over) {
    var out = clone(base || {});
    for (var k in over) if (has(over, k)) out[k] = over[k];
    return out;
  }
  /* 摘要文案给设置页那一行的 badge 用 */
  function summary() {
    var s = settings();
    if (!s.enabled) return '未开启';
    var list = connections();
    if (!list.length) return '没有连接';
    var conn = connection(s.defaultConnectionId) || list[0];
    var p = providerOf(conn.provider);
    return (p ? p.name : conn.provider) + ' · ' + (conn.status === 'connected' ? '已连接'
      : conn.status === 'untested' ? '待验证' : conn.status === 'error' ? '连接异常' : '未配置');
  }
  function connectionSummary(conn) {
    if (!conn) return '未配置';
    return conn.status === 'connected' ? '已连接'
      : conn.status === 'untested' ? '待验证'
        : conn.status === 'error' ? '连接异常' : '未配置';
  }

  Sleepy.tts = {
    /* 常量（UI 与测试都从这里取，别在别处抄一份） */
    EMOTIONS: EMOTIONS,
    TAGS: TAGS,
    FREQUENCIES: FREQUENCIES,
    PROVIDERS: PROVIDERS,
    PROVIDER_ORDER: PROVIDER_ORDER,
    PROVIDER_PLANNED: PROVIDER_PLANNED,
    OUTPUT_DEFAULT: OUTPUT_DEFAULT,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_VOICE: DEFAULT_VOICE,
    ERROR_TEXT: ERROR_TEXT,

    /* 配置 */
    settings: settings,
    saveSettings: saveSettings,
    connections: connections,
    connection: connection,
    firstConnectionOf: firstConnectionOf,
    saveConnection: saveConnection,
    removeConnection: removeConnection,
    markConnection: markConnection,
    voiceAll: voiceAll,
    voiceConfigOf: voiceConfigOf,
    saveVoice: saveVoice,
    hasOwnVoice: hasOwnVoice,
    resolveVoice: resolveVoice,
    summary: summary,
    connectionSummary: connectionSummary,
    maskKey: maskKey,

    /* 能力与映射（纯函数，给 UI 和测试用） */
    modelsOf: modelsOf,
    modelOf: modelOf,
    providerOf: providerOf,
    capabilitiesOf: capabilitiesOf,
    estimateSeconds: estimateSeconds,
    speechPlanOf: speechPlanOf,
    buildFishSynthesisText: buildFishSynthesisText,
    buildElevenSynthesisText: buildElevenText,
    openAICompatBody: openAICompatBody,
    buildAzureSsml: buildAzureSsml,
    azureFormatOf: azureFormatOf,
    elevenVoiceSettingsOf: buildElevenVoiceSettings,
    elevenUrlOf: elUrl,
    synthesisTextOf: synthesisTextOf,

    /* 发送 */
    buildRequest: buildRequest,
    generate: generate,
    testConnection: testConnection,
    normalizeHttpError: normalizeHttpError,
    normalizedError: normalizedError,
    errorMessageOf: errorMessageOf,
    hexToBlob: hexToBlob,
    /* 注入点：按调用传 transport 优先，这里只是真机脚本/并发测试的兜底口 */
    _transport: function (fn) { _transport = fn; }
  };

})(window);
