/* ============================================================
   Sleepy · 语音导演（模型版）

   契约位置：§5「语音导演职责」——输入原文 + 短上下文 + 角色表达方向 + 允许的情绪与标签 +
   情绪幅度/克制度/语速，输出**结构化的 SpeechPlan**。

   ⚠️ 三条不许破的红线（都在契约里）：
     1. 导演**只输出结构化计划**，绝不吐服务商的控制串（`[happy]`、`(chuckle)` 这些
        是 Adapter 从白名单映射出来的，导演碰都不碰）；
     2. 不确定就回退 `neutral`；白名单外的情绪/标签一律丢弃；
     3. 导演失败**绝不能影响这条消息**：超时/解析失败/没配 API → 原样退回规则版计划。

   分工：**门禁永远是规则版的**（开关、频率、冷却、长度、跨岛身份这些事不该问模型），
   模型只负责「这句该怎么念」这一层。所以 `planFor()` 先跑规则版拿到 gates，
   只有真要生成时才去问模型 —— 不问就不花 token。

   调用路径：复用 `Sleepy.api.requestOnce`（契约要求：不新增第二条调用路径）。
   真机脚本注入 transport 时**按调用优先**，与 `Sleepy.tts` 一个规矩。
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  var _transport = null;      /* 注入点（真机脚本 / 并发测试） */
  var TIMEOUT_MS = 8000;      /* 导演超时：宁可退回规则版，也不让消息卡住 */

  function tts() { return Sleepy.tts; }

  function enabled() {
    var t = tts();
    if (!t) return false;
    if (t.settings().director !== 'model') return false;
    return true;
  }

  /* 拿一条能用的模型：主 API 优先（和日记/总结那些一次性任务同一个规矩） */
  function pickCand() {
    if (!Sleepy.api || !Sleepy.api.candidates) return null;
    var list = Sleepy.api.candidates() || [];
    return list.length ? list[0] : null;
  }

  /* ---- 提示词：把「能选什么」写死，别让模型自由发挥 ---- */
  function buildMessages(text, cfg, feat, context) {
    var t = tts();
    var emotions = t.EMOTIONS.slice();
    var tags = t.TAGS.filter(function (x) { return cfg.allowedPerformanceTags.indexOf(x) >= 0; });
    /* 只有用户开了的情绪才允许出现（契约 §5.3：先检查用户是否允许） */
    var allowedEmo = emotions.filter(function (e) { return cfg.allowedEmotions.indexOf(e) >= 0; });

    var lines = [
      '你是语音导演。读一小段对话，判断角色**这一句**该怎么念。',
      '',
      '只输出一个 JSON 对象，不要解释、不要代码块、不要任何服务商标签：',
      '{"emotion":"<情绪>","intensity":<0~1>,"tags":[],"pace":<0.7~1.3>}',
      '',
      '情绪只能从这里选：' + allowedEmo.join(' / ') + '（不确定就用 neutral）',
      tags.length
        ? '表演方式只能从这里选（最多两个）：' + tags.join(' / ')
        : '这条连接**没有表演标签能力**，tags 必须留空数组。',
      '',
      '规则：',
      '- 不确定 → emotion 用 neutral、intensity ≤ 0.2、tags 留空；',
      '- 短句（12 字以内）最多一个标签；',
      '- 难过**不等于**要哭 —— crying 是强表演，用户没允许就不能出现；',
      '- 清单外的词一个都不许出现；',
      '- pace 是语速倍率，用户基准是 ' + (cfg.pace / 100).toFixed(2) + '，只在 ±0.12 内微调。'
    ];
    if (feat) {
      lines.push('- 这条连接的情绪通道是：' + feat.emoLabel + '；界面上的开关以用户设置为准。');
    }

    var ctxLines = [];
    (context || []).slice(-2).forEach(function (m) {
      if (!m || !String(m.content || '').trim()) return;
      ctxLines.push((m.role === 'user' ? '对方' : '角色') + '：' + String(m.content).trim().slice(0, 120));
    });

    var user = [
      cfg.characterDirection ? '[角色表达习惯] ' + String(cfg.characterDirection).slice(0, 120) : '',
      ctxLines.length ? '[前文]\n' + ctxLines.join('\n') : '',
      '[要念的这句]\n' + String(text || '').trim()
    ].filter(Boolean).join('\n\n');

    return [
      { role: 'system', content: lines.join('\n') },
      { role: 'user', content: user }
    ];
  }

  /* ---- 解析：宽容地找 JSON，严格地校验字段 ---- */
  function parsePlan(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    var obj;
    try { obj = JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  }

  function pickTextField(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (typeof o[keys[i]] === 'string') return o[keys[i]];
    }
    return '';
  }

  function pickArr(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(o[keys[i]])) return o[keys[i]];
    }
    return [];
  }

  /* 模型给的东西 → 过一遍白名单与降级规则（唯一的收口在 tts.applyModelPlan） */
  function normalize(raw, base, cfg) {
    var t = tts();
    var obj = parsePlan(raw);
    if (!obj) return { ok: false, code: 'DIRECTOR_BAD_JSON' };
    var out = t.applyModelPlan({
      emotion: pickTextField(obj, ['emotion', 'emotion_type']),
      intensity: Number(obj.intensity),
      pace: Number(obj.pace),
      tags: pickArr(obj, ['tags', 'performanceTags', 'performance_tags'])
    }, base, cfg);
    return { ok: true, plan: out };
  }

  /* ---- 真实调用：复用 api.requestOnce（没有第二条路径） ---- */
  function defaultCall(cand, messages) {
    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (!res || !res.ok) {
        return { ok: false, code: 'DIRECTOR_REQUEST_FAILED', message: Sleepy.api.describeError(res) };
      }
      return { ok: true, content: res.content };
    }, function (e) {
      return { ok: false, code: 'DIRECTOR_REQUEST_FAILED', message: (e && e.message) || '请求失败' };
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = global.setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ ok: false, code: 'DIRECTOR_TIMEOUT' });
      }, ms);
      Promise.resolve(promise).then(function (r) {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        resolve(r);
      }, function (e) {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        resolve({ ok: false, code: 'DIRECTOR_REQUEST_FAILED', message: (e && e.message) || '请求失败' });
      });
    });
  }

  /* 主入口：**永远 resolve 一个可用的 SpeechPlan**，绝不抛错。
     门禁（要不要生成 / 频率 / 冷却 / 长度）一律来自规则版；模型只增强「怎么念」。 */
  function planFor(text, cfg, opts) {
    opts = opts || {};
    var t = tts();
    var base = t.speechPlanOf(text, cfg, opts);
    base.source = 'rules';
    if (!base.shouldGenerate) return Promise.resolve(base);
    if (!enabled()) return Promise.resolve(base);

    var cand = pickCand();
    if (!cand && !opts.transport && !_transport) {
      base.directorNote = 'DIRECTOR_NO_API';
      return Promise.resolve(base);
    }

    var feat = opts.features || (opts.conn ? t.featuresOf(opts.conn.provider, opts.model) : null);
    var messages = buildMessages(text, cfg, feat, opts.context);
    var send = opts.transport || _transport || defaultCall;
    var run = send === defaultCall
      ? defaultCall(cand, messages)
      : Promise.resolve().then(function () { return send({ provider: 'director', messages: messages, cand: cand }); });

    return withTimeout(run, opts.timeout || TIMEOUT_MS).then(function (res) {
      if (!res || !res.ok) {
        base.directorNote = res && res.code ? res.code : 'DIRECTOR_FAILED';
        return base;      /* 失败静默退回规则版 —— 契约：语音挂了不影响消息 */
      }
      var n = normalize(res.content, base, cfg);
      if (!n.ok) {
        base.directorNote = n.code;
        return base;
      }
      n.plan.source = 'model';
      return n.plan;
    }, function () {
      base.directorNote = 'DIRECTOR_FAILED';
      return base;
    });
  }

  Sleepy.ttsDirector = {
    enabled: enabled,
    planFor: planFor,
    /* 纯函数（给冒烟与真机脚本用） */
    buildMessages: buildMessages,
    parsePlan: parsePlan,
    TIMEOUT_MS: TIMEOUT_MS,
    /* 注入点：按调用传 transport 优先，这里只是脚本兜底口 */
    _transport: function (fn) { _transport = fn; }
  };

})(window);
