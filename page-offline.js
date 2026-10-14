/* ============================================================
   page-offline.js — 线下模式（Chat 内的第二空间）
   依赖：store.js、core.js、ui.js、app.js、api.js、prompt-engine.js、
         media.js、imggen.js（生图，运行时惰性取用）
   页面：offline（入口页）→ offline-scene（场景页）

   依据《Sleepy 线下模式 · 施工指令卡 v1》+ 场景空间 Demo：
   · 线下模式不是独立 App —— 从聊天顶栏的门进来，跟当前角色见面
   · UI 按 Demo 逐值移植（配色变量一个不改，见 style.css 的 .off-* 段）
   · 数据层：store 的 offlineSessions（本地 localStorage，指令卡 3.1 的
     结构去掉 TS 类型；每条会话含完整 messages）
   · Prompt 装配走 prompt-engine.assembleOffline（F2 卡 + 共享外壳 + 记忆）
   · 模型返回 JSON（paras / suggests / envUpdate），解析失败降级为单段
     prose，不崩溃（指令卡九-8）
   · 总结（endSession）： MVP 先存在会话身上 —— 留痕记忆系统未开工，
     总结失败不阻塞离开（指令卡九-6）

   MVP 边界（跟指令卡的偏差，都已在施工卡里记档）：
   · API 列表来自现有主/副 API 配置（Demo 里 Claude/GPT-4o 是占位）
   · 生图接现有 imggen 引擎
   · 自定义壁纸选图后存图库（mediaId），「导出/上传」没有——本地附件
   ============================================================ */
(function (global) {
  'use strict';

  global.Sleepy = global.Sleepy || {};
  var Sleepy = global.Sleepy;
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;

  /* 环境条小图标（照搬 Demo 的 svg） */
  var ICON_SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var ICON_CLOUD = '<svg viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
  var ICON_HOME = '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';

  /* ============================ 数据层 ============================ */

  var KEY = 'offlineSessions';

  function allSessions() {
    var list = store.get(KEY);
    return Array.isArray(list) ? list : [];
  }

  /* 写入方必须拿全量 → 改 → 整表落盘（和 chats 同一个规矩：
     只写单条会把别的会话冲掉）。 */
  function saveAll(list) { store.set(KEY, list); }

  /* 解析失败时进 paras 的**唯一**那一句中性标记。
     ⚠️ 措辞是「面向用户」的，但历史装配会把它当场景文本回灌给模型 ——
        所以**不许**出现「JSON」「格式错误」「模型」这类词，
        否则下一轮模型会看到「上一轮出了个 JSON 错」这种莫名其妙的话。 */
  var PARSE_FAIL_MARK = '这一轮的回复格式出了点问题。';
  var PARSE_FAIL_HINT = '这一轮的回复格式出了点问题，原始返回可展开查看。';
  var PARSE_FAIL_EMPTY = '（本次没有可查看的原始内容）';

  /* ==================== 解析失败的原始返回（UI 用 · 只在内存）====================

     ⚠️ 为什么必须单独放一个内存 Map，而不是挂在消息对象上：
       appendMessage → mutateSession → **saveAll**（store.set）。
       任何挂到 msg 上的字段都会被持久化进 localStorage ——
       那等于把模型的原始返回落库了。

     ★ 需求边界（逐条都要成立）：
       - 只在**当前页面内存**里，刷新 / 离开即失；
       - **不进 paras**（→ 不进正文、不进历史回灌、不进下一轮上下文）；
       - **不进 store**、不进导出、不进收藏、不进日志、**不进诊断**；
       - 不被「通用消息持久化逻辑」顺手保存（所以根本不在消息对象上）。

     键是消息 id；上限 8 条，超了丢最旧的（内存不该无限长）。
     ⚠️ 这个 Map 是**给 UI 现场看**的（折叠区），刷新即失是设计使然；
       要做事后定位（判分器 / 验收脚本）请用下面的取证落盘通道。 */
  var rawReturnMap = {};
  var rawReturnOrder = [];
  var RAW_RETURN_MAX = 8;

  /* ==================== 解析降级取证（**独立通道** · 可跨刷新留存）===============

     ★ 为什么要有这一条：rawReturnMap 是**内存态**，刷新 / 离开页面就没了。
       2026-10-05 P3 长期堵住的直接原因就在这里 ——
       模型返回 557 字（HTTP 200 / finish=stop）却因 JSON 未过协议而降级，
       落库只剩一句 14 字中性标记，**原文事后根本拿不回**，
       于是「是 JSON 结构不符 / 含协议禁止的元叙述 / 纯采样随机性」
       这三种可能永远分不开，降级率≈23% 也定位不到根因。

     ★ 与 UI 内存 Map 的分工（两者并存，互不替代）：
       - rawReturnMap：给**当场**的折叠区看，刷新即失，8 条上限；
       - 本通道：给**事后**定位用，跨刷新留存，独立命名空间。

     ★ 硬边界（每条都要成立，缺一条就是污染）：
       ① **不进 store 命名空间** —— 自己拼 key，绕开 store.get/set，
          所以绝不进 exportAll / 存档导入导出 / 删房名单 / 迁移事务；
       ② **不进消息对象** —— 不挂 msg，所以 appendMessage→saveAll 带不走它；
       ③ **不进 paras** —— 所以不进正文、不进历史回灌、不进下一轮上下文；
       ④ **不进诊断**（offlineDiag）—— 诊断面板的字段闭集不变；
       ⑤ **不参与任何业务判定** —— 读出来只在 UI 折叠区与只读取证口出现，
          解析降级的可见行为**一字不变**（仍是 14 字标记 + parseFailed 状态）。

     ★ 命名空间用 `sleepy.forensics.`（**故意不带 v1**）——
       store 的命名空间是 `sleepy.v1.`，导出/删房/迁移全按 DEFAULTS 的键名走，
       带 v1 前缀才会被卷进去；这里刻意落在外面，任何一条业务路径都碰不到它。 */
  var FORENSICS_KEY_PREFIX = 'sleepy.forensics.parseFail.';
  var FORENSICS_MAX_ENTRIES = 40;
  var FORENSICS_MAX_RAW = 20000;   /* 单条原文上限，防止超长把 localStorage 撑爆 */

  function forensicsAvailable() {
    try {
      return !!(global.localStorage && typeof global.localStorage.setItem === 'function');
    } catch (e) { return false; }
  }

  function forensicsRead(key) {
    if (!forensicsAvailable()) return null;
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function forensicsWrite(key, val) {
    if (!forensicsAvailable()) return false;
    try { global.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }

  /* 记录一条降级取证。**任何一步失败都静默** ——
     取证绝不能反过来让业务轮次失败（写入失败 = 当作没记成，业务照常走完）。 */
  function rememberForensics(msgId, info) {
    if (!msgId || !forensicsAvailable()) return false;
    var raw = String((info && info.raw) || '');
    var payload = {
      msgId: String(msgId),
      at: new Date().toISOString(),
      sessionId: String((info && info.sessionId) || '') || null,
      charId: String((info && info.charId) || '') || null,
      reason: 'parse-failed',
      rawLen: raw.length,
      rawTruncated: raw.length > FORENSICS_MAX_RAW,
      raw: raw.length > FORENSICS_MAX_RAW ? raw.slice(0, FORENSICS_MAX_RAW) : raw
    };
    try {
      if (!forensicsWrite(FORENSICS_KEY_PREFIX + msgId, JSON.stringify(payload))) return false;
      /* 环形裁剪：按键名排序（时间前缀已在 payload.at 里，但键名是 msgId），
         这里改用 at 排序才符合「丢最旧」。为省一次全量读，
         只在超上限时做一次全量扫描。 */
      var keys = forensicsKeys();
      if (keys.length > FORENSICS_MAX_ENTRIES) {
        var entries = [];
        for (var i = 0; i < keys.length; i++) {
          var v = forensicsRead(keys[i]);
          if (!v) continue;
          try { entries.push({ k: keys[i], at: (JSON.parse(v) || {}).at || '' }); } catch (e2) { /* 坏行丢掉 */ }
        }
        entries.sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : (String(a.at) > String(b.at) ? 1 : 0); });
        var over = entries.length - FORENSICS_MAX_ENTRIES;
        for (var j = 0; j < over; j++) {
          try { global.localStorage.removeItem(entries[j].k); } catch (e3) { /* 忽略 */ }
        }
      }
      return true;
    } catch (e) { return false; }
  }

  function forensicsKeys() {
    if (!forensicsAvailable()) return [];
    var out = [];
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(FORENSICS_KEY_PREFIX) === 0) out.push(k);
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /* 只读取证口（对外）。★ 只读、无删除、无清库** ——
     与 offlineDiag 同一套自律：不在导出面挂任何写入/测试钩子。 */
  function forensicsSnapshot() {
    var keys = forensicsKeys();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var v = forensicsRead(keys[i]);
      if (!v) continue;
      try { out.push(JSON.parse(v)); } catch (e) { /* 坏行跳过，不抛 */ }
    }
    out.sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : (String(a.at) > String(b.at) ? 1 : 0); });
    return out;
  }

  function rememberRawReturn(msgId, raw) {
    if (!msgId) return;
    var text = String(raw == null ? '' : raw);
    if (rawReturnMap[msgId] === undefined) rawReturnOrder.push(msgId);
    rawReturnMap[msgId] = text;
    while (rawReturnOrder.length > RAW_RETURN_MAX) {
      var drop = rawReturnOrder.shift();
      delete rawReturnMap[drop];
    }
  }
  function rawReturnOf(msgId) {
    return msgId && rawReturnMap[msgId] !== undefined ? rawReturnMap[msgId] : null;
  }

  function findSession(id) {
    if (!id) return null;
    var list = allSessions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function mutateSession(id, fn) {
    var list = allSessions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      fn(list[i]);
      list[i].updatedAt = Date.now();
      saveAll(list);
      return list[i];
    }
    return null;
  }

  function newId() { return 'offline_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function defaultNarrative() {
    return {
      pov: 'he_you', tense: 'present', style: 'nature_life',
      lengthMode: 'medium', customLengthMin: null,
      styleWords: '',
      showSuggests: true, showCharInner: true, charProactive: false,
      npcFrequency: 'none', timeAdvance: true,
      opening: 'char'           /* 开场方式：char=场景+他先开口 / scene=只铺场景 */
    };
  }

  function defaultSystem() {
    return {
      theme: '',               /* '' = 纸本（demo 的默认配色） */
      customWallpaperUrl: '',  /* mediaId；theme='custom' 时用 */
      showSuggests: true, timeAdvance: true,
      endSummary: true, autoAnchorMoments: true, offlineArchive: true
    };
  }

  function createSession(charId, form) {
    form = form || {};
    var list = allSessions();
    var count = 1;
    list.forEach(function (s) { if (s.charId === charId) count++; });
    /* pendingSetup：场景设定交给 AI 进页面后再想（门弹窗的「开新的」路径），
       表格里先占位 —— 这样「谁先开场」能秒弹，不用等模型。 */
    var pending = !!form.pendingSetup;
    var session = {
      id: newId(),
      charId: charId,
      /* 带上马甲：记忆认知层 / I01 按当前 user 组织（缺省回落激活马甲）。
         sandboxId：删房清理名单（core.removeSandbox 的 scoped 数组）认这个章。
         回落的那件**必须过岛卫兵**（activeUserOnIsland）—— 指针停在上一座岛时
         照 activeUser() 写会把新会话挂到别座岛的人名下，那是存档里的脏数据。 */
      userId: form.userId != null ? form.userId
        : ((core.activeUserOnIsland && core.activeUserOnIsland()) || {}).id || null,
      sandboxId: core.scopeId ? core.scopeId() : null,
      sceneCount: count,
      sceneName: pending ? '…' : (String(form.sceneName || '').trim() || '未命名场景'),
      status: 'active',
      env: {
        timeOfDay: pending ? '傍晚' : (form.timeOfDay || '傍晚'),
        weather: pending ? '晴' : (form.weather || '晴'),
        location: pending ? '—' : (form.location || '—'),
        clockTime: pending ? '16:42' : (form.clockTime || '16:42')
      },
      pendingSetup: pending,
      narrativeSettings: defaultNarrative(),
      systemSettings: defaultSystem(),
      apiModel: '',
      apiModelName: '',        /* 会话级模型覆盖（空 = 用接口里配的） */
      openingBy: 'char',       /* 开场谁先开口：char / user */
      messages: [],
      summary: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    list.unshift(session);
    saveAll(list);
    return session;
  }

  function appendMessage(id, data) {
    var msg = null;
    mutateSession(id, function (s) {
      msg = {
        id: newId(),
        role: data.role,
        createdAt: Date.now()
      };
      if (data.paras) msg.paras = data.paras;
      if (data.text != null) msg.text = data.text;
      if (data.mediaId) msg.mediaId = data.mediaId;
      if (data.photoCaption != null) msg.photoCaption = data.photoCaption;
      if (data.suggests) msg.suggests = data.suggests;
      /* parseFailed 是**可持久化的失败状态**（只有一个布尔标记）。
         ⚠️ rawReturn 绝不能挂这里 —— mutateSession 会 saveAll 到 store，
            挂上去等于把模型的原始返回落库。原始返回只放内存 Map（见下）。 */
      if (data.parseFailed) msg.parseFailed = true;
      s.messages.push(msg);
    });
    return msg;
  }

  /* 「先离开一下」和「保存进度并离开」功能相同（指令卡 6.3），
     都是 status → paused，不总结、不删任何东西。 */
  function pauseSession(id) {
    return mutateSession(id, function (s) { s.status = 'paused'; });
  }

  function resumeSession(id) {
    return mutateSession(id, function (s) { if (s.status === 'paused') s.status = 'active'; });
  }

  function endSession(id) {
    return mutateSession(id, function (s) { s.status = 'ended'; });
  }

  /* showSuggests / timeAdvance 在系统设置和叙事设置两处必须同步
     （指令卡九-3、九-4）：统一走这个入口写。 */
  function syncDual(id, key, val) {
    mutateSession(id, function (s) {
      s.systemSettings[key] = val;
      s.narrativeSettings[key] = val;
    });
  }

  function updateNarrative(id, patch) {
    mutateSession(id, function (s) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) s.narrativeSettings[k] = patch[k];
      }
    });
  }

  function updateSystem(id, patch) {
    mutateSession(id, function (s) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) s.systemSettings[k] = patch[k];
      }
    });
  }

  function updateEnv(id, patch) {
    mutateSession(id, function (s) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) s.env[k] = patch[k];
      }
    });
  }

  /* scope='default' 时写入全局线下默认模型（store，所有新会话用） */
  function setApiModel(id, label, scope, modelName) {
    mutateSession(id, function (s) {
      s.apiModel = label;
      s.apiModelName = String(modelName || '');
    });
    if (scope === 'default') {
      store.set('offlineDefaults.apiModel', label);
      store.set('offlineDefaults.apiModelName', String(modelName || ''));
    }
  }

  function defaultApiModel() { return store.get('offlineDefaults.apiModel') || ''; }
  function defaultApiModelName() { return store.get('offlineDefaults.apiModelName') || ''; }

  /* ============================ 模型调用 ============================ */

  /* 可选模型 = 主 API + 启用的副 API（Demo 里的 Claude/GPT-4o 是占位） */
  function apiChoices() {
    var out = [];
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      out.push({ label: main.name || '主 API', desc: '主模型 · ' + main.model, cand: { source: 'main', label: main.name || '主 API', cfg: main } });
    }
    var subs = store.get('subApis');
    if (Array.isArray(subs)) {
      subs.forEach(function (it) {
        if (it && it.enabled && it.baseUrl && it.model) {
          out.push({ label: it.name || '副 API', desc: '副模型 · ' + it.model, cand: { source: 'sub', label: it.name || '副 API', cfg: it } });
        }
      });
    }
    return out;
  }

  function candByLabel(label) {
    var list = apiChoices();
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].label === label) return list[i].cand;
    }
    return list[0].cand;   /* 记忆里的模型被删了就回落主 API */
  }

  /* 会话实际用的候选：接口 + 会话级模型覆盖（线下设置里拉的模型） */
  function candForSession(session) {
    var label = session.apiModel || defaultApiModel();
    var base = candByLabel(label);
    if (!base) return null;
    var modelName = session.apiModelName || (session.apiModel ? '' : defaultApiModelName());
    if (modelName) {
      var cfg = {};
      for (var k in base.cfg) {
        if (Object.prototype.hasOwnProperty.call(base.cfg, k)) cfg[k] = base.cfg[k];
      }
      cfg.model = modelName;
      return { source: base.source, label: base.label, cfg: cfg };
    }
    return base;
  }

  /* 线下一律非流式：返回的是 JSON，流式切片没有意义。

     ★ v2：`res.stage` 原样带出（api.requestOnce 会给 config/http/parse/
       network/timeout 五种）。**必须带出** —— 否则诊断分不清
       「服务端确实收到并拒绝」（http/parse）与「根本没送到」（network/timeout）。
       describeError 只把 stage 拼进一句中文，会把它吃掉。 */
  function callModel(cand, messages) {
    /* 勾了「线下模式走副 API」→ 只轮询副 API（api.js）；没勾走调用方的 cand。
       失败语义照旧分层：feature 路的报错是字符串，requestOnce 路带 stage。 */
    var fr = Sleepy.api.requestForFeature
      ? Sleepy.api.requestForFeature('offline', messages, {}) : null;
    if (fr) {
      return fr.then(function (r) {
        if (r.ok) return { ok: true, text: r.content };
        return { ok: false, stage: 'config', error: r.error };
      });
    }
    if (!cand) {
      /* stage='config'：本地判定，**没有出网**。与 network 区分开。 */
      return Promise.resolve({ ok: false, stage: 'config',
        error: '还没有可用的模型连接，去 设置 → 主 API 填一个' });
    }
    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (res.ok) return { ok: true, text: res.content };
      return { ok: false, stage: (res && res.stage) || 'unknown',
        error: Sleepy.api.describeError(res) };
    }, function (e) {
      /* 同步到 Promise 链上的 reject（网络库抛的）：无法确认服务端是否收到 */
      return { ok: false, stage: 'unknown', error: (e && e.message) || '请求失败' };
    });
  }

  /* ============================ 实际请求诊断（F2 批返修 · 仅内存） ============================
     ★ 放置位置说明：整块常量必须**排在下面 candForSession / callModel /
       STAGE_TO_DIAG 之前**。v2 曾把 STAGE_TO_DIAG 放在 DIAG_STAGE 之前，
       `var DIAG_STAGE` 虽被提升但值为 undefined → 模块顶层求值即抛
       TypeError → **整个 page-offline.js 的导出全部丢失**
       （Sleepy.offlineStore / offlineUI / offlineDiag 全变 undefined，
         线下场景功能完全不可用）。
       ★ 规矩：本块只依赖对象字面量与 var 声明，**不调用下方任何函数**；
         下方 STAGE_TO_DIAG 引用 DIAG_STAGE 的值，必须在本块之后执行。

     ★ 目的：回答「**这一轮出站请求**用的是新行为正文还是旧卡」。
       预览（预设 app 里重新装配一次）**不算** —— 它证明不了真机那次用了哪条路。

     ★ 只在内存保存最近一次，**不入库、不上传、不写聊天记录**。
     ★ 保留字段：请求身份、本地序号、时间、阶段、原因码、布尔状态、版本、模块标识。
     ★ **不记录**：prompt 正文、聊天内容、角色名称、用户 override 内容、
       异常全文、API 配置（baseUrl / model / key 一个都不碰）。

     ---------- 两个计数器，职责不同（v1 混用导致业务回调被丢弃）----------
     requestId —— **请求身份**。每次**新请求**分配一次，该请求内的所有阶段
                   更新**沿用同一个**（不因阶段推进而变）。
     diagSeq   —— 诊断记录序号。每写一条诊断自增，仅用于「诊断面板按写入顺序看」。

     v1 的错法：拿 diagSeq 当请求身份，于是「已到达调用边界」写一次、
     「无连接」再写一次 → 序号变了 → 回调里的 `if (diagSeq !== seq) return;`
     命中 → **整段业务回调被丢弃**（pending 永久 true、按钮不解禁、无错误提示）。

     ---------- 诊断守卫的职责边界（v2 修掉的核心）----------
     守卫**只管「这条诊断要不要写」**，**绝不管业务回调要不要跑**。
     业务收尾（pending / setBusy / toast / 落地）无条件执行，
     只用「我是不是最新那个请求」判断**要不要动共享 UI 状态**。

     ---------- 阶段闭集（严格区分，不互相顶替）----------
       assemble-failed        装配就失败 —— **没有出站请求**
       at-call-boundary       已装配完成、正要交给 callModel
       no-connection          没有可用连接 —— **没有出网**（本地判定）
       request-rejected       服务端确实收到了并拒绝（stage=http/parse）
       request-failed-unknown 失败，但**无法确认服务端是否收到**（stage=network/timeout）
       canceled               本轮被放弃（页面离开 / 被更新请求取代）
       model-returned         成功拿到内容

     ⚠️ 删除了 v1 的错误结论「ok 与 fail 都算到达服务端」——
        network / timeout 根本没到服务端，不能记成 request-rejected。 */

  var DIAG_STAGE = {
    ASSEMBLE_FAILED: 'assemble-failed',
    AT_CALL_BOUNDARY: 'at-call-boundary',
    NO_CONNECTION: 'no-connection',
    REQUEST_REJECTED: 'request-rejected',
    REQUEST_FAILED_UNKNOWN: 'request-failed-unknown',
    CANCELED: 'canceled',
    MODEL_RETURNED: 'model-returned'
  };

  /* 阶段闭集（自校验用）：不在表内的阶段一律归到 unknown，不回显任意原串。 */
  var DIAG_STAGE_SET = {};
  Object.keys(DIAG_STAGE).forEach(function (k) { DIAG_STAGE_SET[DIAG_STAGE[k]] = 1; });
  var STAGE_UNKNOWN = 'unknown';

  /* 原因码闭集：与 prompt-engine 的 BT_REASON 对齐（同一批契约）。
     成功时是空串。诊断只认这张表里的值。 */
  var DIAG_REASON_SET = {};
  ['', 'module-missing', 'version-mismatch', 'call-threw', 'not-ok',
   'bad-shape', 'bad-part', 'bad-text', 'plan-mismatch', 'join-mismatch',
   'slot-contract', 'user-override'].forEach(function (r) { DIAG_REASON_SET[r] = 1; });
  var REASON_UNKNOWN = 'unknown';

  /* 模块标识闭集：线下就是 B/P/L/N/S2。 */
  var DIAG_MODULE_SET = {};
  ['B', 'P', 'L', 'N', 'S2'].forEach(function (m) { DIAG_MODULE_SET[m] = 1; });

  /* 版本：只认受校验的那一个；其余一律 'unknown'，**不回显任意原串**
     （原串可能是被污染的任意文本，回显等于把它写进 UI）。 */
  var DIAG_VERSION_KNOWN = 'sleepy-behavior-v1-review-01';
  var VERSION_UNKNOWN = 'unknown';

  var requestSeq = 0;        /* 请求身份计数器 */
  var diagSeq = 0;           /* 诊断记录计数器 */
  var diagLast = null;       /* 最近一次线下调用诊断（内存，刷新即失） */

  /* 阶段文案（闭集 → 中文）。未知阶段落到固定文案，不回显原值。 */
  var DIAG_STAGE_LABELS = {
    'assemble-failed': '装配失败（没有出站请求）',
    'at-call-boundary': '已到达调用边界（尚未确认服务端收到）',
    'no-connection': '无可用连接（没有出网）',
    'request-rejected': '服务端已收到并拒绝',
    'request-failed-unknown': '请求失败（无法确认服务端是否收到）',
    'canceled': '本轮已放弃',
    'model-returned': '已成功拿到内容',
    'unknown': '未知阶段'
  };

  function normStage(s) { return DIAG_STAGE_SET[s] ? s : STAGE_UNKNOWN; }
  function normReason(r) { return DIAG_REASON_SET[r] ? r : REASON_UNKNOWN; }
  function normVersion(v) { return v === DIAG_VERSION_KNOWN ? v : VERSION_UNKNOWN; }

  /* 模块列表收口：逐项过滤 + 去重，非闭集项丢掉。 */
  function normModules(list) {
    if (!Array.isArray(list)) return [];
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (typeof m !== 'string' || !DIAG_MODULE_SET[m] || seen[m]) continue;
      seen[m] = 1;
      out.push(m);
    }
    return out;
  }

  /* 分配一个新的请求身份。**每次新请求一次**，阶段更新不调用它。 */
  function diagNewRequest() {
    requestSeq += 1;
    return requestSeq;
  }

  /* 写一条诊断。requestId 由调用方传入并**跨阶段保持不变**。
     ★ 这里不再有任何「守卫」—— 守卫属于业务侧，诊断侧只负责把状态写对。 */
  function diagRecord(requestId, stage, behavior, extra) {
    diagSeq += 1;
    var b = behavior || {};
    var x = extra || {};
    diagLast = {
      requestId: requestId,
      seq: diagSeq,
      at: new Date().toISOString(),
      stage: normStage(stage),
      /* used 只反映「本次装配真的采用了新正文」；候选可用不算。
         回退时 modules 必为空数组 —— 不把候选模块记成已使用。 */
      behaviorUsed: b.used === true,
      reason: normReason(typeof b.reason === 'string' ? b.reason : ''),
      touched: b.touched === true,
      version: normVersion(typeof b.VERSION === 'string' ? b.VERSION : ''),
      modules: normModules(b.modules),
      /* requestOk：true=拿到内容；false=失败；null=尚未有结论。
         ⚠️ 不再把「失败」一律说成服务端拒绝 —— 由 stage 表达失败性质。 */
      requestOk: (typeof x.requestOk === 'boolean') ? x.requestOk : null
    };
    return diagLast;
  }

  /* 只带出可展示的深拷贝 —— 外部改不到内部状态。 */
  function diagSnapshot() {
    if (!diagLast) return null;
    return JSON.parse(JSON.stringify(diagLast));
  }

  /* ---------- 失败性质 → 诊断阶段（必须排在 DIAG_STAGE 之后）----------

     ★ 语义边界（这一段是 v1 说错的地方）：
       - config    → **本地判定，根本没出网**。不能说「服务端拒绝」。
       - http/parse→ 服务端**确实收到了**并拒绝/返回了无法解析的内容。
       - network   → fetch 的 catch 分支：连接失败，**无法确认**是否送达。
       - timeout   → 超时，**无法确认**（服务端可能仍在生成）。
       - unknown   → 兜底，同样**无法确认**。
     ⚠️ v1 那句「ok 与 fail 都算到达服务端」「失败一定是服务端拒绝」是错的：
        network / timeout 根本没到服务端，混记成 request-rejected 会误导排查。 */
  var STAGE_TO_DIAG = {
    'config': DIAG_STAGE.NO_CONNECTION,
    'http': DIAG_STAGE.REQUEST_REJECTED,
    'parse': DIAG_STAGE.REQUEST_REJECTED,
    'network': DIAG_STAGE.REQUEST_FAILED_UNKNOWN,
    'timeout': DIAG_STAGE.REQUEST_FAILED_UNKNOWN,
    'unknown': DIAG_STAGE.REQUEST_FAILED_UNKNOWN
  };
  function diagStageForResult(r) {
    if (!r || r.ok) return DIAG_STAGE.MODEL_RETURNED;
    var s = STAGE_TO_DIAG[r.stage];
    return s || DIAG_STAGE.REQUEST_FAILED_UNKNOWN;
  }

  /* ============================ 转录 / 总结 ============================ */

  function charNameOf(session) {
    var c = core.findChar(session.charId);
    return (c && c.name) || '他';
  }

  function messageText(m, charName) {
    if (m.role === 'user') return '你：' + (m.text || '');
    if (m.role === 'scene') return '【场景】' + parasText(m.paras);
    if (m.role === 'char') return charName + '：' + parasText(m.paras);
    if (m.role === 'photo') return '（拍下了一张照片：' + (m.photoCaption || '') + '）';
    return '';
  }

  function parasText(paras) {
    /* 段落之间换行，不是直接粘在一起：线下是一篇连续的叙事，「他做了个动作」
     与「他说了句话」粘成一行之后，回给模型的原文就再也读不出结构了。 */
    return (paras || []).map(function (p) { return p.text || ''; }).join('\n');
  }

  /* endSession 的总结调用。返回 Promise<{ok, summary}>，
     失败不抛 —— 总结失败不阻塞离开（指令卡九-6）。 */
  function generateSummary(session) {
    var E = Sleepy.promptEngine;
    var charName = charNameOf(session);
    var transcript = session.messages.filter(function (m) {
      /* 解析失败那条不进总结正文（判状态不判文案）。
         否则 messageText 会把它拼成「沈砚：这一轮的回复格式出了点问题。」，
         总结里就会出现一句角色没说过的话。 */
      return !m.parseFailed;
    }).map(function (m) {
      return messageText(m, charName);
    }).filter(Boolean).join('\n');
    if (!transcript) return Promise.resolve({ ok: false, error: '没有可总结的内容' });

    var sysParts = [];
    sysParts.push(E.cardBody('summary'));
    var c = core.findChar(session.charId);
    /* 人设唯一出口 compileCharacter（分层+红线并集），不再裸 content（勘察 P1） */
    var personaBlock = (c && Sleepy.promptEngine.compileCharacter)
      ? Sleepy.promptEngine.compileCharacter(session.charId) : '';
    if (personaBlock) sysParts.push(personaBlock);

    var messages = [
      { role: 'system', content: sysParts.filter(Boolean).join('\n\n') },
      { role: 'user', content: '以下是这次线下见面的完整记录，请按协议整理：\n\n' + transcript }
    ];
    var cand = candForSession(session);
    return callModel(cand, messages).then(function (r) {
      if (!r.ok) return { ok: false, error: r.error };
      /* 总结输出是 JSON（协议见 summary 卡），解析失败存原文，可稍后重试 */
      var parsed = null;
      try {
        var t = String(r.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
        var i = t.indexOf('{'), j = t.lastIndexOf('}');
        if (i >= 0 && j > i) parsed = JSON.parse(t.slice(i, j + 1));
      } catch (e) { parsed = null; }
      return {
        ok: true,
        summary: {
          at: Date.now(),
          data: parsed || null,
          raw: parsed ? '' : String(r.text || '')
        }
      };
    });
  }

  /* ==================== 门：点门直接弹「新的 / 继续上次」 ====================

     挂在聊天页身上（不再经过入口页）：选「继续上次」直接进场景，
     选「推开这扇门」AI 想场景后直接进。off-* 的变量只定义在 .off-root
     身上，所以弹窗外面套一层 .off-vars（display:contents，只当变量载体）。 */
  /* 开新场景后先问一句谁先开场（用户定的交互）：
     他先 = 点进场景就生成他的开场；我先 = 进去 user 先写，写完 char 接。
     反悔取消的话把会话转成 paused，别让它消失。
     场景设定不在这里出 —— 并进 char 的第一次生成（省一次 API、
     也不预设立场），模块级函数：入口页和门弹窗共用。 */
  function chooseOpeningFor(pageCtx, host, s) {
      var wrap2 = h('div', 'off-root off-vars');
      var overlay = h('div', 'off-overlay off-door-overlay');
      var sheet = h('div', 'off-sheet');
      sheet.appendChild(h('div', 'off-sheet-handle'));

      var title = h('div', 'off-door-title');
      title.appendChild(h('span', 'off-door-title-main', '谁先开场？'));
      title.appendChild(h('span', 'off-door-title-sub',
        s.pendingSetup ? '这次的见面马上开始' : '「' + s.sceneName + '」· 第 ' + s.sceneCount + ' 次见面'));
      sheet.appendChild(title);

      var opts = h('div', 'off-leave-options');
      [
        { by: 'char', name: '他先开口', desc: '点进去就生成他的开场白', primary: true },
        { by: 'user', name: '我先开口', desc: '点进去你先写，写完他再来接' }
      ].forEach(function (o) {
        var b = h('button', 'off-leave-option' + (o.primary ? ' primary' : ''));
        b.type = 'button';
        var main = h('span', 'off-opt-main');
        main.appendChild(h('span', 'off-opt-name', o.name));
        main.appendChild(h('span', 'off-opt-desc', o.desc));
        b.appendChild(main);
        b.addEventListener('click', function () {
          mutateSession(s.id, function (x) { x.openingBy = o.by; });
          overlay.classList.remove('show');
          setTimeout(function () {
            if (wrap2.parentNode) wrap2.parentNode.removeChild(wrap2);
          }, 240);
          pageCtx.open('offline-scene', { id: s.id });
        });
        opts.appendChild(b);
      });
      sheet.appendChild(opts);

      var cancel = h('button', 'off-sheet-cancel', '先不去了');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        pauseSession(s.id);
        overlay.classList.remove('show');
        setTimeout(function () {
          if (wrap2.parentNode) wrap2.parentNode.removeChild(wrap2);
        }, 240);
      });
      sheet.appendChild(cancel);

      overlay.appendChild(sheet);
      wrap2.appendChild(overlay);
      host.appendChild(wrap2);
      requestAnimationFrame(function () { overlay.classList.add('show'); });
  }

  function openDoorSheet(pageCtx, charId, userId) {
    var host = pageCtx.el;
    var old = host.querySelector('.off-door-overlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var char = core.findChar(charId);
    var charName = char ? char.name : '他';
    var setupPending = false;

    var wrap = h('div', 'off-root off-vars');
    var overlay = h('div', 'off-overlay off-door-overlay');
    var sheet = h('div', 'off-sheet');

    sheet.appendChild(h('div', 'off-sheet-handle'));
    var title = h('div', 'off-door-title');
    title.appendChild(h('span', 'off-door-title-main', '线下 · ' + charName));
    title.appendChild(h('span', 'off-door-title-sub', '去哪里见这一面？'));
    sheet.appendChild(title);

    function close() {
      overlay.classList.remove('show');
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 240);
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var sessions = allSessions().filter(function (s) { return s.charId === charId; });
    var paused = sessions.filter(function (s) { return s.status === 'paused'; });
    var ended = sessions.filter(function (s) { return s.status === 'ended'; });

    function goScene(id) {
      close();
      pageCtx.open('offline-scene', { id: id });
    }

    function chooseOpening(s) { chooseOpeningFor(pageCtx, host, s); }

    function sessionRow(s, isEnded) {
      var last = s.messages.length ? s.messages[s.messages.length - 1] : null;
      var preview = last
        ? (last.role === 'user' ? (last.text || '') : parasText(last.paras) || (last.photoCaption || '一张照片'))
        : '（还没有开始说话）';
      if (preview.length > 34) preview = preview.slice(0, 34);
      var r = h('button', 'off-door-row');
      r.type = 'button';
      var main = h('span', 'off-door-row-main');
      main.appendChild(h('span', 'off-door-row-name', s.sceneName));
      main.appendChild(h('span', 'off-door-row-sub', '第 ' + s.sceneCount + ' 次见面 · ' + preview));
      r.appendChild(main);
      r.appendChild(h('span', 'off-door-row-tag' + (isEnded ? ' is-ended' : ''), isEnded ? '已结束' : '继续'));
      r.addEventListener('click', function () { goScene(s.id); });
      return r;
    }

    if (paused.length) {
      sheet.appendChild(h('div', 'off-door-sec', '继续上次'));
      paused.forEach(function (s) { sheet.appendChild(sessionRow(s, false)); });
    }

    var go = h('button', 'off-entry-go' + (paused.length ? ' in-sheet' : ''));
    go.type = 'button';
    go.appendChild(h('span', 'off-entry-go-name', paused.length ? '再开一次新的' : '推开这扇门'));
    go.appendChild(h('span', 'off-entry-go-sub', '场景、时间、天气都让它想 —— 你进去就好'));
    go.addEventListener('click', function () {
      if (setupPending) return;
      if (!apiChoices().length) {
        pageCtx.toast('先去 设置 → 主 API 配一个模型', 'warn');
        return;
      }
      /* 秒弹「谁先开场」——AI 想场景放到进页面之后再做，不等模型 */
      var s = createSession(charId, { pendingSetup: true, userId: userId });
      chooseOpening(s);
    });
    sheet.appendChild(go);

    /* 自己定设定（折叠） */
    var manualHint = h('button', 'off-door-manual-hint', '自己定场景设定 ▾');
    manualHint.type = 'button';
    var manualWrap = h('div', 'off-door-manual');
    manualWrap.style.display = 'none';
    manualHint.addEventListener('click', function () {
      var open = manualWrap.style.display !== 'none';
      manualWrap.style.display = open ? 'none' : '';
      manualHint.textContent = open ? '自己定场景设定 ▾' : '收起来 ▴';
    });
    sheet.appendChild(manualHint);
    manualWrap.appendChild(buildDoorManualForm());
    sheet.appendChild(manualWrap);

    /* 已结束（折叠，默认收着不占地方） */
    if (ended.length) {
      var endHint = h('button', 'off-door-manual-hint', '已结束的见面（' + ended.length + '）▾');
      endHint.type = 'button';
      var endWrap = h('div', 'off-door-manual');
      endWrap.style.display = 'none';
      endHint.addEventListener('click', function () {
        var open = endWrap.style.display !== 'none';
        endWrap.style.display = open ? 'none' : '';
        endHint.textContent = '已结束的见面（' + ended.length + '）' + (open ? '▾' : '▴');
      });
      sheet.appendChild(endHint);
      ended.forEach(function (s) { endWrap.appendChild(sessionRow(s, true)); });
      sheet.appendChild(endWrap);
    }

    var cancel = h('button', 'off-sheet-cancel', '先不去了');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    sheet.appendChild(cancel);

    overlay.appendChild(sheet);
    wrap.appendChild(overlay);
    host.appendChild(wrap);
    requestAnimationFrame(function () { overlay.classList.add('show'); });

    /* 手动表单（和入口页同一套字段，选完直接进场景） */
    function buildDoorManualForm() {
      var form = h('div', 'off-entry-form');
      var fName = ui.textField({ label: '场景名', value: '', placeholder: '比如：河边旧书店' });
      var fLoc = ui.textField({ label: '地点', value: '', placeholder: '比如：书店二楼' });
      var timeVal = '傍晚';
      var segTime = h('div', 'off-seg');
      TIME_OPTIONS.forEach(function (t) {
        var b = h('button', 'off-seg-btn' + (t === timeVal ? ' active' : ''), t);
        b.type = 'button';
        b.addEventListener('click', function () {
          timeVal = t;
          [].forEach.call(segTime.children, function (x) { x.classList.remove('active'); });
          b.classList.add('active');
        });
        segTime.appendChild(b);
      });
      var timeWrap = h('div', 'off-field-col');
      timeWrap.appendChild(h('span', 'off-field-label', '时段'));
      timeWrap.appendChild(segTime);
      var fWeather = ui.textField({ label: '天气', value: '晴', placeholder: '晴 / 微云 / 小雨…' });
      var fClock = ui.textField({ label: '时刻', value: '16:42', placeholder: '16:42' });
      form.appendChild(fName.el);
      form.appendChild(fLoc.el);
      form.appendChild(timeWrap);
      form.appendChild(fWeather.el);
      form.appendChild(fClock.el);
      var btnRow = h('div', 'off-entry-btn');
        btnRow.appendChild(ui.button('就这样开始', 'primary', function () {
          var s = createSession(charId, {
            sceneName: fName.get(), location: fLoc.get(),
            timeOfDay: timeVal, weather: fWeather.get() || '晴',
            clockTime: fClock.get() || '16:42',
            userId: userId
          });
          chooseOpening(s);
        }));
      form.appendChild(btnRow);
      return form;
    }
  }

  /* ============================ 页面：入口 ============================ */

  var TIME_OPTIONS = ['清晨', '上午', '午后', '傍晚', '夜晚', '深夜'];

  /* 场景设定的解析与回落。生成不再走独立请求 ——
     并进 char 的第一次生成（输出协议的 scene 字段），这里只负责校验落库。 */
  function parseSetup(raw) {
    var text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    var i = text.indexOf('{'), j = text.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        var o = JSON.parse(text.slice(i, j + 1));
        return {
          sceneName: String(o.sceneName || '').trim(),
          location: String(o.location || '').trim(),
          timeOfDay: TIME_OPTIONS.indexOf(o.timeOfDay) >= 0 ? o.timeOfDay : '傍晚',
          weather: String(o.weather || '晴').trim(),
          clockTime: /^\d{1,2}:\d{2}$/.test(String(o.clockTime || '')) ? o.clockTime : '16:42'
        };
      } catch (e) { /* 落到默认 */ }
    }
    return null;
  }

  function fallbackSetup() {
    return { sceneName: '未命名场景', location: '—', timeOfDay: '傍晚', weather: '晴', clockTime: '16:42' };
  }

  Sleepy.register('offline', {
    title: '线下模式',
    render: function (ctx) {
      var body = ctx.body;
      var charId = ctx.params.charId || '';
      var char = core.findChar(charId);
      if (!char) {
        ctx.toast('找不到这个角色', 'err');
        ctx.back();
        return;
      }
      ctx.setTitle('线下模式 · ' + char.name);
      var setupPending = false;

      function build() {
        body.innerHTML = '';
        /* 入口页也套 off-root：off-* 的配色变量都定义在它身上，
           不套的话抽屉和列表拿不到变量（设置抽屉透明就是这个原因）。 */
        var root = h('div', 'off-root');
        var inner = h('div', 'off-entry-body');

        /* 门形 hero：这个页面现在只从深链进，但既然能到达就别让它空着 */
        var sessions = allSessions().filter(function (s) { return s.charId === charId; });
        var hero = h('div', 'off-entry-hero');
        var heroDoor = h('div', 'off-entry-hero-door');
        heroDoor.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6.5 20.5v-12a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v12"/><path d="M3.5 20.5h17"/><path d="M14 12h.01"/></svg>';
        hero.appendChild(heroDoor);
        hero.appendChild(h('p', 'off-entry-hero-name', char.name));
        hero.appendChild(h('p', 'off-entry-hero-sub', '推开门，就是你们的第 ' +
          (sessions.length + 1) + ' 次见面'));
        inner.appendChild(hero);

        var paused = sessions.filter(function (s) { return s.status === 'paused'; });
        var ended = sessions.filter(function (s) { return s.status === 'ended'; });

        /* ---- 开启新场景：AI 想好一切，user 只负责推门 ---- */
        var gNew = h('div', 'off-entry-sec');
        gNew.appendChild(h('p', 'off-entry-title', '开启新场景'));
        var goBtn = h('button', 'off-entry-go');
        goBtn.type = 'button';
        goBtn.appendChild(h('span', 'off-entry-go-name', '推开这扇门'));
        goBtn.appendChild(h('span', 'off-entry-go-sub', '场景、时间、天气都让它想 —— 你进去就好'));
        goBtn.addEventListener('click', doAiSetup);
        gNew.appendChild(goBtn);

        var manualHint = h('button', 'off-entry-manual-hint', '自己定场景设定 ▾');
        manualHint.type = 'button';
        var manualWrap = h('div', 'off-entry-manual');
        manualWrap.style.display = 'none';
        manualHint.addEventListener('click', function () {
          var open = manualWrap.style.display !== 'none';
          manualWrap.style.display = open ? 'none' : '';
          manualHint.textContent = open ? '自己定场景设定 ▾' : '收起来 ▴';
        });
        gNew.appendChild(manualHint);
        manualWrap.appendChild(buildManualForm());
        gNew.appendChild(manualWrap);
        inner.appendChild(gNew);

        /* ---- 继续上次场景 ---- */
        var gCont = h('div', 'off-entry-sec');
        gCont.appendChild(h('p', 'off-entry-title', '继续上次场景'));
        if (!paused.length) gCont.appendChild(h('p', 'off-entry-empty', '还没有暂时离开的见面'));
        paused.forEach(function (s) { gCont.appendChild(sessionRow(s, false)); });
        inner.appendChild(gCont);

        /* ---- 已结束 ---- */
        if (ended.length) {
          var gEnd = h('div', 'off-entry-sec');
          gEnd.appendChild(h('p', 'off-entry-title', '已结束的见面'));
          ended.forEach(function (s) { gEnd.appendChild(sessionRow(s, true)); });
          inner.appendChild(gEnd);
        }

        root.appendChild(inner);
        body.appendChild(root);
      }

      function buildManualForm() {
        var form = h('div', 'off-entry-form');
        var fName = ui.textField({ label: '场景名', value: '', placeholder: '比如：河边旧书店' });
        form.appendChild(fName.el);
        var fLoc = ui.textField({ label: '地点', value: '', placeholder: '比如：书店二楼' });
        form.appendChild(fLoc.el);

        var segTime = h('div', 'off-seg');
        var timeVal = '傍晚';
        TIME_OPTIONS.forEach(function (t) {
          var b = h('button', 'off-seg-btn' + (t === timeVal ? ' active' : ''), t);
          b.type = 'button';
          b.addEventListener('click', function () {
            timeVal = t;
            [].forEach.call(segTime.children, function (x) { x.classList.remove('active'); });
            b.classList.add('active');
          });
          segTime.appendChild(b);
        });
        var timeWrap = h('div', 'off-field-col');
        timeWrap.appendChild(h('span', 'off-field-label', '时段'));
        timeWrap.appendChild(segTime);
        form.appendChild(timeWrap);

        var fWeather = ui.textField({ label: '天气', value: '晴', placeholder: '晴 / 微云 / 小雨…' });
        form.appendChild(fWeather.el);
        var fClock = ui.textField({ label: '时刻', value: '16:42', placeholder: '16:42' });
        form.appendChild(fClock.el);

        var btnRow = h('div', 'off-entry-btn');
        btnRow.appendChild(ui.button('就这样开始', 'primary', function () {
          var s = createSession(charId, {
            sceneName: fName.get(), location: fLoc.get(),
            timeOfDay: timeVal, weather: fWeather.get() || '晴',
            clockTime: fClock.get() || '16:42'
          });
          ctx.toast('第 ' + s.sceneCount + ' 次见面开始了', 'ok');
          ctx.open('offline-scene', { id: s.id });
        }));
        form.appendChild(btnRow);
        return form;
      }

      /* 「推开这扇门」：秒弹「谁先开场」，场景设定并进 char 的第一次生成 */
      function doAiSetup() {
        if (setupPending) return;
        var s = createSession(charId, { pendingSetup: true });
        chooseOpeningFor(ctx, ctx.el, s);
      }

      function sessionRow(s, isEnded) {
        var last = s.messages.length ? s.messages[s.messages.length - 1] : null;
        var preview = last
          ? (last.role === 'user' ? (last.text || '') : parasText(last.paras) || (last.photoCaption || '一张照片'))
          : '（还没有开始说话）';
        if (preview.length > 40) preview = preview.slice(0, 40);
        var r = h('button', 'off-entry-row');
        r.type = 'button';
        var main = h('span', 'off-entry-main');
        main.appendChild(h('span', 'off-entry-name', s.sceneName));
        main.appendChild(h('span', 'off-entry-hint',
          '第 ' + s.sceneCount + ' 次见面 · ' + relativeStamp(s.updatedAt)));
        main.appendChild(h('span', 'off-entry-preview', preview));
        r.appendChild(main);
        r.appendChild(h('span', 'off-entry-tag' + (isEnded ? ' is-ended' : ''), isEnded ? '已结束' : '进行中'));
        r.addEventListener('click', function () { ctx.open('offline-scene', { id: s.id }); });
        return r;
      }

      function relativeStamp(ts) {
        var d = new Date(ts);
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ============================ 页面：场景 ============================

     注意 rebuild：状态（进行中→暂停→结束）在会话数据里，不在页面参数里。
     同参重开时 app.js 不会重渲染，所以 onShow 必须整体重建 ——
     不然「已结束」的只读态永远刷不出来（实测踩过）。 */
  function renderScene(ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var session = findSession(id);
      if (!session) {
        ctx.toast('找不到这个场景', 'err');
        ctx.back();
        return;
      }
      /* 场景页要满屏铺 demo 的布局：藏掉标准标题栏、去掉页面内边距 */
      ctx.el.classList.add('is-bleed');
      if (session.status === 'paused') resumeSession(id);

      var E = Sleepy.promptEngine;
      var charName = charNameOf(session);
      var rootEl = null;           /* .off-root：off-* 变量都定义在它身上 */
      var pending = null;          /* 在途请求（存请求身份，不是布尔） */
      var themeTimer = null;
      /* 诊断面板的 DOM 引用。**必须与 refreshDiagPanel 同层**（见下方注释）。 */
      var diagPanelRef = null;
      /* 本页是否还在前台。onHide 置 false —— 在途请求的迟到回调据此判断
         「不要再去动 DOM / 忙碌态 / toast」（页面已经不在了）。 */
      ctx.__alive = true;

      body.innerHTML = '';
      body.appendChild(buildRoot());

      /* 进场引导：场景设定不单独发请求 —— 并进 char 的第一次生成
         （输出协议里带 scene 字段，解析后回填）。
         「他先开场」的会话进场自动生成开场白（顺带定场景）；
         「我先开场」的等 user 写完第一句，char 回复时顺带定场景。
         旗标挂 ctx 上，防 rebuild 双触发（实测双开场就是这么来的）。 */
      if (!ctx.__bootstrapped && session.status !== 'ended') {
        ctx.__bootstrapped = true;
        maybeOpening();
      }

      function maybeOpening() {
        var fresh = findSession(id);
        if ((fresh.messages || []).length || fresh.status === 'ended') return;
        if ((fresh.openingBy || 'char') !== 'char') return;
        if (ctx.__openingTried) return;
        ctx.__openingTried = true;
        setTimeout(function () { requestTurn(null); }, 350);
      }

      /* ---------------- 结构（按 Demo） ---------------- */

      function buildRoot() {
        var root = h('div', 'off-root' + themeClass(session));
        rootEl = root;
        root.appendChild(buildHeader());
        root.appendChild(buildScroll());
        root.appendChild(buildInput());
        /* 离开 / API / 设置三个抽屉按需建（openSheet），挂在 root 上 ——
           变量定义在 .off-root 身上，挂到 body 外面会拿不到配色（实测透明）。 */
        return root;
      }

      function themeClass(s) {
        var t = (s.systemSettings || {}).theme || '';
        return t === 'custom' ? '' : (t ? ' ' + t : '');
      }

      function buildHeader() {
        var header = h('div', 'off-header');

        var topbar = h('div', 'off-topbar');
        var left = h('div', 'off-topbar-left');
        var backBtn = h('button', 'off-back-btn');
        backBtn.type = 'button';
        backBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>';
        backBtn.addEventListener('click', function () { openSheet('leave'); });
        left.appendChild(backBtn);
        var title = h('div', 'off-scene-title');
        title.appendChild(h('span', 'off-scene-name', session.sceneName));
        title.appendChild(h('span', 'off-scene-sub', '第 ' + pad2(session.sceneCount) + ' 次见面'));
        left.appendChild(title);
        topbar.appendChild(left);

        var right = h('div', 'off-topbar-right');
        var pill = h('button', 'off-api-pill');
        pill.type = 'button';
        var apiName = session.apiModel || defaultApiModel() || (apiChoices()[0] || {}).label || '未配置';
        pill.appendChild(h('span', 'off-api-dot'));
        pill.appendChild(h('span', 'off-api-label', apiName));
        pill.addEventListener('click', function () { openSheet('api'); });
        right.appendChild(pill);
        var setBtn = h('button', 'off-settings-btn');
        setBtn.type = 'button';
        setBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
        setBtn.addEventListener('click', function () { openSheet('settings'); });
        right.appendChild(setBtn);
        topbar.appendChild(right);
        header.appendChild(topbar);

        header.appendChild(buildEnvStrip());
        return header;
      }

      function buildEnvStrip() {
        var env = session.env || {};
        var strip = h('div', 'off-env-strip');
        strip.appendChild(envItem(ICON_SUN, env.timeOfDay || '—'));
        strip.appendChild(envSep());
        strip.appendChild(envItem(ICON_CLOUD, env.weather || '—'));
        strip.appendChild(envSep());
        strip.appendChild(envItem(ICON_HOME, env.location || '—'));
        strip.appendChild(h('div', 'off-env-spacer'));
        var cap = h('div', 'off-time-capsule');
        var bar = h('div', 'off-time-bar');
        for (var i = 0; i < 5; i++) bar.appendChild(document.createElement('span'));
        cap.appendChild(bar);
        cap.appendChild(h('span', 'off-time-label', env.clockTime || '--:--'));
        strip.appendChild(cap);
        return strip;
      }

      function envItem(icon, label) {
        var it = h('div', 'off-env-item');
        var ic = h('span', 'off-env-ic');
        ic.innerHTML = icon;
        it.appendChild(ic);
        it.appendChild(h('span', '', label));
        return it;
      }
      function envSep() { return h('div', 'off-env-sep'); }

      function buildScroll() {
        var scroll = h('div', 'off-chat-scroll');
        applyWallpaper(scroll);
        fillMessages(scroll);
        return scroll;
      }

      function applyWallpaper(scroll) {
        var sys = session.systemSettings || {};
        if (sys.theme === 'custom' && sys.customWallpaperUrl) {
          Sleepy.media.url(sys.customWallpaperUrl).then(function (u) {
            if (u) {
              scroll.classList.add('has-wallpaper');
              scroll.style.backgroundImage = 'url("' + u + '")';
            }
          });
        }
      }

      function buildInput() {
        var area = h('div', 'off-input-area');
        var row = h('div', 'off-input-row');

        /* 相机 + 生图菜单 */
        var camWrap = h('div', 'off-cam-wrap');
        var camBtn = h('button', 'off-camera-btn');
        camBtn.type = 'button';
        camBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
        var menu = h('div', 'off-camera-menu');
        [
          { key: 'scene', label: '生成当前场景' },
          { key: 'char', label: '生成他此刻的样子' },
          { key: 'together', label: '生成你们在一起' }
        ].forEach(function (it) {
          var mi = h('button', 'off-camera-menu-item', it.label);
          mi.type = 'button';
          mi.addEventListener('click', function () {
            menu.classList.remove('show');
            doGenPhoto(it.key);
          });
          menu.appendChild(mi);
        });
        camBtn.addEventListener('click', function () { menu.classList.toggle('show'); });
        camWrap.appendChild(camBtn);
        camWrap.appendChild(menu);
        row.appendChild(camWrap);

        var input = h('textarea', 'off-input-field');
        input.rows = 1;
        input.placeholder = '你想怎么回应？';
        input.addEventListener('input', function () {
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });
        /* 回车＝换行（用户定的）；发送只走右边按钮。
           textarea 本来就吃 Enter 换行，这里不拦。 */
        row.appendChild(input);

        var send = h('button', 'off-send-btn');
        send.type = 'button';
        send.innerHTML = '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        send.addEventListener('click', doSend);
        row.appendChild(send);

        area.appendChild(row);

        if (session.status === 'ended') {
          input.disabled = true;
          input.placeholder = '这次见面已经结束，只能回看了';
          send.disabled = true;
          camBtn.disabled = true;
          var endedBar = h('div', 'off-ended-bar');
          var sum = session.summary;
          endedBar.textContent = sum
            ? '这次见面已结束 · 总结已生成'
            : (session.summaryError ? '这次见面已结束 · 总结没生成' : '这次见面已结束');
          /* 总结失败给个真入口 —— 之前只写「可以再试一次」却没有按钮 */
          if (!sum && session.summaryError) {
            var retry = h('button', 'off-summary-retry', '重试总结');
            retry.type = 'button';
            retry.addEventListener('click', function () {
              if (retrying) return;
              retrying = true;
              retry.disabled = true;
              retry.textContent = '正在整理…';
              var fresh = findSession(id);
              applySummary(fresh).then(function (ok) {
                retrying = false;
                if (ok) {
                  ctx.toast('总结好了', 'ok');
                  ctx.rebuild && ctx.rebuild();
                } else {
                  retry.disabled = false;
                  retry.textContent = '重试总结';
                  ctx.toast('还是没成：' + (findSession(id).summaryError || '失败'), 'err');
                }
              });
            });
            area.insertBefore(retry, area.firstChild);
          }
          if (sum && sum.data && sum.data.visible && sum.data.visible.characterMemory) {
            var memo = h('div', 'off-summary-note', '「' + sum.data.visible.characterMemory + '」');
            area.appendChild(memo);
          }
          area.insertBefore(endedBar, area.firstChild);
        }
        return area;
      }

      var retrying = false;
      /* 总结 + 入库（doEnd 和「重试总结」共用）。返回是否成功。 */
      function applySummary(session) {
        return generateSummary(session).then(function (r) {
          if (!r.ok) {
            mutateSession(id, function (s) { s.summaryError = r.error || '总结失败'; });
            return false;
          }
          mutateSession(id, function (s) { s.summary = r.summary; s.summaryError = false; });
          if (r.summary.data && Sleepy.summaryEngine) {
            var stat = Sleepy.summaryEngine.ingest(session.charId, r.summary.data,
              { source: 'offline', ref: '见面 #' + pad2(session.sceneCount),
                /* 「自动沉淀重要时刻」开 → priority=high 的条目入库即锚定 */
                autoAnchor: (session.systemSettings || {}).autoAnchorMoments !== false });
            var scene = r.summary.data.scene;
            if (scene && scene.continuationPoint) {
              mutateSession(id, function (s) { s.continuationPoint = scene.continuationPoint; });
            }
            if (stat.added) ctx.toast('整理出 ' + stat.added + ' 条记忆，去「留痕」确认', 'ok');
          }
          return true;
        });
      }

      /* ---------------- 消息渲染 ---------------- */

      /* 解析失败降级块：一句人话提示 + **默认折叠**的原始返回。
         ★ 用原生 <details>（不给 open 属性）→ 默认收起，零 JS。
           同一个模式诊断面板的 off-diag-fold 已经在用，不发明新写法。
         ★ 原始返回从**内存 Map** 取（rawReturnOf），消息对象上根本没有
           这个字段 —— 所以不可能被 saveAll 带进 store。 */
      function parseFailedBlock(m) {
        var b = h('div', 'off-parsefail');
        b.appendChild(h('div', 'off-parsefail-hint', PARSE_FAIL_HINT));
        var fold = h('details', 'off-parsefail-fold');
        fold.appendChild(h('summary', 'off-parsefail-summary', '查看原始返回'));
        var raw = rawReturnOf(m.id);
        /* 页面刷新后 Map 早空了（内存态）→ 给一句固定文案，不留空白 */
        fold.appendChild(h('pre', 'off-parsefail-raw',
          (raw == null || raw === '') ? PARSE_FAIL_EMPTY : raw));
        b.appendChild(fold);
        return b;
      }

      function fillMessages(scroll) {
        scroll.innerHTML = '';
        var msgs = session.messages || [];
        var lastCharIdx = -1;
        msgs.forEach(function (m, i) { if (m.role === 'char') lastCharIdx = i; });

        msgs.forEach(function (m, i) {
          scroll.appendChild(blockFor(m));
          if (i === lastCharIdx) {
            var suggests = m.suggests || [];
            if (suggests.length && (session.narrativeSettings || {}).showSuggests !== false) {
              scroll.appendChild(suggestBlock(suggests));
            }
          }
        });
        scroll.scrollTop = scroll.scrollHeight;
      }

      function blockFor(m) {
        /* 解析失败的降级块：**先判**，因为它的 role 也是 'char'，
           走下面的 char 分支会把中性标记当正常台词渲染成气泡。 */
        if (m.parseFailed) return parseFailedBlock(m);
        if (m.role === 'scene') {
          var sb = h('div', 'off-scene-block');
          sb.appendChild(h('div', 'off-scene-prose', parasText(m.paras)));
          return sb;
        }
        if (m.role === 'user') {
          var ua = h('div', 'off-user-action');
          ua.appendChild(h('span', 'off-user-tag', '你'));
          ua.appendChild(h('span', 'off-user-action-text', m.text || ''));
          return ua;
        }
        if (m.role === 'photo') return photoCard(m);
        /* char */
        var cb = h('div', 'off-char-block');
        cb.appendChild(h('span', 'off-char-name', charName));
        var bodyEl = h('div', 'off-char-body');
        (m.paras || []).forEach(function (p, pi) {
          bodyEl.appendChild(h('p', p.type === 'dialogue' ? 'off-char-q' : 'off-char-p', p.text));
          /* 海外角色的台词下面挂译文（组件 msg-trans）——
             只在 dialogue 段下，而且开关/语言两道闸门由组件自己判。
             键带段落序号，所以同一段消息第二次看仍是你上次的收起状态。 */
          if (p.type === 'dialogue' && p.trans) {
            Sleepy.msgTrans.attach(bodyEl, m.id + ':' + pi, p.trans, session.charId);
          }
        });
        cb.appendChild(bodyEl);
        return cb;
      }

      function suggestBlock(suggests) {
        var blk = h('div', 'off-suggest-block');
        blk.appendChild(h('div', 'off-suggest-label', '也可以 ·'));
        var list = h('div', 'off-suggest-list');
        suggests.forEach(function (s) {
          var it = h('button', 'off-suggest-item', s);
          it.type = 'button';
          it.addEventListener('click', function () {
            var input = body.querySelector('.off-input-field');
            if (input && !input.disabled) {
              input.value = s;
              input.dispatchEvent(new Event('input'));
              input.focus();
            }
          });
          list.appendChild(it);
        });
        blk.appendChild(list);
        return blk;
      }

      function photoCard(m) {
        var card = h('div', 'off-photo-card');
        var img = h('img');
        img.alt = m.photoCaption || '照片';
        if (m.mediaId && Sleepy.media) {
          Sleepy.media.url(m.mediaId).then(function (u) { if (u) img.src = u; });
        } else if (m.photoUrl) {
          img.src = m.photoUrl;
        }
        card.appendChild(img);
        card.appendChild(h('div', 'off-photo-caption', m.photoCaption || ''));
        return card;
      }

      /* ---------------- 发送 / 生图 / 总结 ---------------- */

      function setBusy(b) {
        var input = body.querySelector('.off-input-field');
        var send = body.querySelector('.off-send-btn');
        if (input) input.disabled = b || session.status === 'ended';
        if (send) send.disabled = b || session.status === 'ended';
      }

      /* 收尾本轮：解除忙碌 + 滚到底。
         ★ 只应由**本轮自己**调用（isLatest 为真时）——
           旧请求调它会把新请求的忙碌态误关掉。
         ★ pending 存的是**这一轮占用的请求身份**（不是布尔）：
           预取阶段就要先占位，否则召回那几百毫秒里用户能连点两次发送，
           发出两个在途请求，回来时两个都跑 go()，落地顺序与诊断都会乱。 */
      function finishTurn(ownId) {
        /* ownId 给了就核对身份：不是自己的活不碰共享状态。
           防御性用法 —— 正常路径上调用方已判过 isLatest。 */
        if (ownId != null && ownId !== requestSeq) return;
        pending = null;
        setBusy(false);
      }

      function doSend() {
        var input = body.querySelector('.off-input-field');
        var text = String(input && input.value || '').trim();
        if (!text) return;
        requestTurn(text);
      }

      /* 召回查询：这一轮之前 user 最后说的一句。
         开场（没说过话）时返回空 —— 那一轮不召回，本来也没什么「相关的过去」。 */
      function lastUserTextOf(s) {
        var msgs = (s && s.messages) || [];
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user' && msgs[i].text) return String(msgs[i].text);
        }
        return '';
      }

      /* 一轮对话请求。userInput=null 表示「开场」—— 角色先开口，
         不需要 user 先说话（setting：叙事设置里的开场方式）。 */
      function requestTurn(userInput) {
        if (session.status === 'ended') return;
        if (pending) { ctx.toast('还在等他回应', 'warn'); return; }

        /* ★ 请求身份在这里分配一次（不是 go() 里）：预取也是本轮的一部分，
           从这一行起本轮就已经「在途」，必须占住 pending。
           阶段更新（装配失败 / 到达调用边界 / 无连接 / 返回 / 放弃）
           全部沿用这一个 id —— v1 拿「诊断记录序号」当请求身份，
           于是无连接分支写一次诊断就自行把本请求作废，
           回调整段被丢弃 → 永久忙碌 + 无错误提示。 */
        var reqId = diagNewRequest();
        pending = reqId;

        if (userInput != null) {
          appendMessage(id, { role: 'user', text: userInput });
          session = findSession(id);
          var input = body.querySelector('.off-input-field');
          if (input) { input.value = ''; input.style.height = 'auto'; }
        }
        fillMessages(body.querySelector('.off-chat-scroll'));
        setBusy(true);

        /* L4 召回（和线上同一套）：先把「和这句话相关的旧片段」捞出来。
           prefetch 自带超时 —— 宁可这轮不召回，也不能把场景卡住。

           ★ 预取是**异步边界**：等待期间用户可能已经离开页面、会话可能被删。
             回来时必须重新核对，不能对着已失效的 session 继续跑。 */
        var mv = Sleepy.memoryVec;
        var q = userInput != null ? String(userInput) : lastUserTextOf(session);
        if (mv && mv.prefetch && session.charId && q) {
          mv.prefetch(session.charId, session.userId, q).then(function () {
            afterPrefetch(reqId, userInput);
          }, function () {
            /* 预取失败**不该打断这一轮**（召回是锦上添花），照样往下走。 */
            afterPrefetch(reqId, userInput);
          });
          return;
        }
        go(reqId, userInput);
      }

      /* 预取回来后的续跑判断。三种情形：
           1) 正常 → 继续装配出站；
           2) 页面已离开 → 本轮作废（记 canceled），解掉忙碌态，不碰 DOM；
           3) 会话已删 → 同上。
         ★ 作废也必须 finishTurn(reqId)，否则 pending 永久占位、按钮永久禁用。 */
      function afterPrefetch(reqId, userInput) {
        if (ctx.__alive === false || !findSession(id)) {
          finishTurn(reqId);
          diagRecord(reqId, DIAG_STAGE.CANCELED, null, { requestOk: null });
          return;
        }
        go(reqId, userInput);
      }

      /* 线下这一轮的正文。拆出来是因为装配是同步的 ——
         召回只能先落进 memoryVec 的缓存，再回来装配。 */
      function go(reqId, userInput) {
          /* reqId 由 requestTurn 分配并传进来 —— **本请求全程只用这一个身份**，
             阶段更新不再重新分配。 */

          /* 装配本身可能抛（缺模块、槽位契约不过等）。抛了就只记「装配失败」——
             **这一轮没有出站请求**，不能沿用上一轮的成功状态。
             收尾照做：解除忙碌 + 提示。 */
          var built = null;
          try {
            built = E.assembleOffline({
              charId: session.charId, userId: null, session: session, userInput: userInput
            });
          } catch (e) {
            diagRecord(reqId, DIAG_STAGE.ASSEMBLE_FAILED, null, { requestOk: null });
            finishTurn(reqId);
            if (ctx.__alive !== false) {
              ctx.toast('✗ 装配失败，这一轮没有发出去', 'err');
            }
            return;
          }
          if (!built || !Array.isArray(built.messages) || !built.messages.length) {
            diagRecord(reqId, DIAG_STAGE.ASSEMBLE_FAILED,
              (built && built.behavior) || null, { requestOk: null });
            finishTurn(reqId);
            if (ctx.__alive !== false) {
              ctx.toast('✗ 装配没有产出内容，这一轮没有发出去', 'err');
            }
            return;
          }
          /* ★ 诊断只从**这一份 built** 取 —— 与真正出站的是同一个对象。
             预览（预设 app）走 assembleOffline 是另一次调用，不写这里。 */
          var behavior = built.behavior || null;
          if (userInput == null) {
            built.messages.push({ role: 'user', content: '（开场。请按输出协议开始这个场景。）' });
          }

          var cand = candForSession(session);
          /* 已到达调用边界 —— 只是「准备调用」，还不知道服务端收没收到。 */
          diagRecord(reqId, DIAG_STAGE.AT_CALL_BOUNDARY, behavior, { requestOk: null });
          if (!cand) {
            /* 没有可用连接：**没有出网**。本地判定，不等 callModel。 */
            diagRecord(reqId, DIAG_STAGE.NO_CONNECTION, behavior, { requestOk: false });
            finishTurn(reqId);
            if (ctx.__alive !== false) {
              ctx.toast('✗ 还没有可用的模型连接，去 设置 → 主 API 填一个', 'err');
            }
            return;
          }

          var p = null;
          try {
            p = callModel(cand, built.messages);
          } catch (e) {
            /* callModel 同步抛（不该发生，但要收尾）：无法确认服务端是否收到。
               同步抛意味着**请求可能根本没发出去**，所以不写异常全文进诊断。 */
            diagRecord(reqId, DIAG_STAGE.REQUEST_FAILED_UNKNOWN, behavior, { requestOk: false });
            finishTurn(reqId);
            if (ctx.__alive !== false) ctx.toast('✗ 请求没能发出去', 'err');
            return;
          }
          if (!p || typeof p.then !== 'function') {
            diagRecord(reqId, DIAG_STAGE.REQUEST_FAILED_UNKNOWN, behavior, { requestOk: false });
            finishTurn(reqId);
            if (ctx.__alive !== false) ctx.toast('✗ 请求没能发出去', 'err');
            return;
          }

          /* ★ 业务守卫：**只决定「要不要动共享 UI 状态」**。
             它**不控制诊断写不写**，也**绝不丢弃业务回调** ——
             pending / setBusy / 落地 / 错误提示一律执行。
             两个方向的坑都要避开：
               - 迟到旧请求若整段 return → 新请求被永久卡在忙碌态（v1 的 bug）；
               - 迟到旧请求若无条件清 pending/setBusy → 把新请求的忙碌态误关掉。
             正确做法：**照常收尾自己的活，但只在自己仍是最新请求时才动共享状态。** */
          p.then(function (r) {
            var isLatest = (reqId === requestSeq);
            /* 页面已经离开（onHide 置位）→ 本轮 UI 归位交给下次进入，
               此时只做纯内存记账，不碰 DOM、不弹 toast。 */
            var alive = ctx.__alive !== false;

            var ok = !!(r && r.ok);
            diagRecord(reqId, diagStageForResult(r), behavior, { requestOk: ok });

            /* 收尾 pending + 忙碌态。**只有最新请求能解** ——
               旧请求解会把新请求的忙碌态误关掉（那样新请求的迟到回调
               就会去关一个已经能发的输入框）。 */
            if (isLatest) finishTurn(reqId);

            if (!ok) {
              if (isLatest && alive) {
                ctx.toast('✗ ' + (r && r.error ? r.error : '请求失败'), 'err');
              }
              return;
            }

            var parsed = E.parseOfflineReply(r.text);

            /* ---------- 解析失败：用户可见降级（方案 A）----------
               parseOfflineReply 返回 ok:false 有两种触发：
                 1. 坏 JSON —— 模型吐出语法不合法的内容（缺冒号、截断、双份）；
                 2. 空字符串 —— HTTP 200 但 content 为空。
               两者对用户是**同一个现象**（「模型回了个看不懂的东西」），
               所以统一走这一条路径。

               ⚠️ prompt-engine 的 parseOfflineReply **一行不改** ——
                 它的降级行为是正确的（抛异常 → 失败标记 + 原文兜底，
                 没崩、没丢数据、没伪称成功）。问题只在**消费方**：
                 旧代码无条件照单渲染 parsed.paras，而失败时 paras 里
                 装的是**整段原文** → 裸 JSON / 修正版双份直接进正文。

               ★ 成功路径（ok:true）完全不受影响：paras / trans /
                 suggests / envUpdate / scene 全部照旧。 */
            if (parsed.ok === false) {
              /* 中性失败标记：进 paras 是为了「历史装配能保留这一轮」，
                 **只有一个标记句**，绝不塞原始内容。
                 → 历史回灌（messageText → parasText）与下一轮
                   built.messages 里只会出现这一句中性文本。 */
              var failMsg = appendMessage(id, {
                role: 'char',
                paras: [{ type: 'prose', text: PARSE_FAIL_MARK, trans: null }],
                parseFailed: true
              });
              /* 原始返回只放内存 Map，**不挂消息对象**（挂上去会被 saveAll 落库） */
              rememberRawReturn(failMsg && failMsg.id, r.text);
              /* ★ 同时走**独立取证通道**落盘（2026-10-05 P3 堵点修复）：
                 内存 Map 刷新即失，事后无法定位降级根因（23% 降级率至今无法判断
                 是协议遵守问题还是采样随机性）。取证通道独立于 store 命名空间、
                 不挂消息对象、不进 paras、不进诊断 → 业务可见行为一字不变。 */
              rememberForensics(failMsg && failMsg.id, {
                raw: r.text,
                sessionId: id,
                charId: (session && session.charId) || null
              });
              session = findSession(id);
              if (alive) {
                fillMessages(body.querySelector('.off-chat-scroll'));
                refreshEnvStrip();
              }
              /* 这一轮没有可用内容 → 不进向量库（索引的是模型原文，不是失败标记） */
              return;
            }

            /* 第一次生成顺带定场景：解析出 scene 就回填会话并刷新顶栏/环境条。
               模型没带 scene（不听话）就回落默认，不打断这轮。 */
            if (parsed.scene && session.pendingSetup) {
              var setup = parseSetup(JSON.stringify(parsed.scene)) || fallbackSetup();
              mutateSession(id, function (s) {
                s.sceneName = setup.sceneName;
                s.env.timeOfDay = setup.timeOfDay;
                s.env.weather = setup.weather;
                s.env.location = setup.location;
                s.env.clockTime = setup.clockTime;
                s.pendingSetup = false;
              });
              session = findSession(id);
              if (alive) { refreshHeader(); refreshEnvStrip(); }
            }
            if (parsed.paras.length) {
              /* 开场若有对话段，用带名字的 char 块；纯描写就用场景块 */
              var hasDialog = parsed.paras.some(function (p) { return p.type === 'dialogue'; });
              appendMessage(id, {
                role: (userInput == null && !hasDialog) ? 'scene' : 'char',
                paras: parsed.paras,
                suggests: parsed.suggests
              });
            }
            if (parsed.envUpdate && parsed.envUpdate.clockTime) {
              updateEnv(id, { clockTime: parsed.envUpdate.clockTime });
            }
            session = findSession(id);
            /* ★ 消息一定落库（appendMessage 已写），但重绘 DOM 只在页面还在时做 ——
               页面走了以后往旧 DOM 写既无效也可能抛。 */
            if (alive) {
              fillMessages(body.querySelector('.off-chat-scroll'));
              refreshEnvStrip();
            }
            /* 这一轮落地了 → 后台索引进向量库（L4，不挡场景） */
            kickOfflineSweep();
          }, function (e) {
            /* ★ callModel 自身的 reject 兜底（它内部已兜了一层，这里是防御）。
               必须收尾：否则 pending 永久卡住、按钮永久禁用、无法重试。
               reject 只说明本地链路断了，**无法确认服务端是否收到** →
               request-failed-unknown，不是 request-rejected。 */
            var isLatest = (reqId === requestSeq);
            var alive = ctx.__alive !== false;
            diagRecord(reqId, DIAG_STAGE.REQUEST_FAILED_UNKNOWN, behavior, { requestOk: false });
            if (isLatest) {
              finishTurn(reqId);
              if (alive) ctx.toast('✗ ' + ((e && e.message) || '请求失败'), 'err');
            }
          });
      }

      /* L4 写入。**后台跑、不 await** —— 它要调 embedding，绝不能挡着场景；
         失败就留到下次（游标没推进，下一轮自然重试同一批）。
         和线上那份是同一个内核（sweepSource），只是消息结构不一样
         （user 走 text、char/scene 走 paras、还有 photo）。 */
      function kickOfflineSweep() {
        var mv = Sleepy.memoryVec;
        if (!mv || !mv.sweepOffline) return;
        setTimeout(function () {
          var s = findSession(id);
          if (!s || !s.charId) return;
          mv.sweepOffline(s.charId, s.userId, s)['catch'](function () { /* 静默 */ });
        }, 0);
      }

      function refreshEnvStrip() {
        var strip = body.querySelector('.off-env-strip');
        if (strip) {
          var fresh = buildEnvStrip();
          strip.parentNode.replaceChild(fresh, strip);
        }
      }

      /* AI 想完场景后刷顶栏（场景名 / 第 N 次），连同环境条一起 */
      function refreshHeader() {
        var old = body.querySelector('.off-header');
        if (old && old.parentNode) old.parentNode.replaceChild(buildHeader(), old);
      }

      function doGenPhoto(kind) {
        if (pending) { ctx.toast('先等手头这轮结束', 'warn'); return; }
        if (!Sleepy.imggen) { ctx.toast('生图引擎没加载', 'err'); return; }
        var env = session.env || {};
        var sceneBits = (env.location || '') + '，' + (env.timeOfDay || '') + '，' + (env.weather || '') + '的氛围';
        /* B0：三个键都显式传 ImagePlan —— 谁在画面里只看 subjects，
           中文 description 不再靠 PERSON_RE 猜基底（以前 char/合影
           会被误套「排人」的场景负面词）。env 照旧进 description。 */
        var ch = core.findChar(session.charId);
        var me = session.userId ? core.findUser(session.userId) : null;
        var plan = null;
        if (kind === 'scene') {
          plan = {
            sender: 'system', contentType: 'scene', shot: 'scene', subjects: [],
            description: sceneBits + '，电影感构图，无人物特写'
          };
        } else if (kind === 'char') {
          plan = {
            sender: 'system', contentType: 'person', shot: 'full',
            subjects: ch ? [Sleepy.imggen.subjectForChar(ch, 'full')] : [],
            description: (ch ? ch.name + '在' : '') + sceneBits + '的样子，叙事感'
          };
        } else {
          var subs = [];
          if (me) subs.push(Sleepy.imggen.subjectForUser(me, 'group'));
          if (ch) subs.push(Sleepy.imggen.subjectForChar(ch, 'group'));
          plan = {
            sender: 'user', contentType: 'mixed', shot: 'group', subjects: subs,
            description: (ch ? ch.name + '和我' : '我们') + '在' + sceneBits + '，两人的合影感，叙事感'
          };
        }
        ctx.toast('正在生成…', 'ok');
        pending = true;
        setBusy(true);
        Sleepy.imggen.generate({ plan: plan }).then(function (r) {
          pending = false;
          setBusy(false);
          if (!r.ok) {
            ctx.toast('✗ ' + ((r.error && r.error.message) || '生成失败'), 'err');
            return;
          }
          appendMessage(id, {
            role: 'photo',
            mediaId: r.mediaId || '',
            photoUrl: r.url || '',
            photoCaption: session.sceneName + ' · ' + (session.env.timeOfDay || '')
          });
          session = findSession(id);
          fillMessages(body.querySelector('.off-chat-scroll'));
        });
      }

      /* ---------------- 抽屉 ---------------- */

      var sheetBox = null;
      function openSheet(kind) {
        closeSheet();
        if (kind === 'leave') sheetBox = buildLeaveSheet();
        else if (kind === 'api') sheetBox = buildApiSheet();
        else sheetBox = buildSettingsSheet();
        /* 挂在 .off-root 里：off-* 的配色变量只定义在它身上 */
        rootEl.appendChild(sheetBox);
        requestAnimationFrame(function () { sheetBox.classList.add('show'); });
      }
      function closeSheet() {
        if (sheetBox && sheetBox.parentNode) sheetBox.parentNode.removeChild(sheetBox);
        sheetBox = null;
      }

      function sheetShell(title, contentEl, cancelLabel, onCancel) {
        /* 离开/切换模型这类小弹层跟门弹窗一样居中（用户：「放中间，
           不要黑的」）—— 设置页那种满屏的另带 off-sheet-full。 */
        var overlay = h('div', 'off-overlay off-door-overlay');
        var sheet = h('div', 'off-sheet');
        sheet.appendChild(h('div', 'off-sheet-handle'));
        sheet.appendChild(h('div', 'off-sheet-title', title));
        sheet.appendChild(contentEl);
        var cancel = h('button', 'off-sheet-cancel', cancelLabel || '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', onCancel || closeSheet);
        sheet.appendChild(cancel);
        overlay.appendChild(sheet);
        overlay.addEventListener('click', function (e) {
          if (e.target === overlay) closeSheet();
        });
        return overlay;
      }

      function buildLeaveSheet() {
        var opts = h('div', 'off-leave-options');
        [
          { name: '先离开一下', desc: '不总结，保留当前见面，回来继续', act: 'pause', primary: true },
          { name: '保存进度并离开', desc: '保留进度，稍后可从这里继续', act: 'pause' },
          { name: '结束这次见面', desc: '生成见面总结，选择留下什么记忆', act: 'end' }
        ].forEach(function (o) {
          var b = h('button', 'off-leave-option' + (o.primary ? ' primary' : ''));
          b.type = 'button';
          var main = h('span', 'off-opt-main');
          main.appendChild(h('span', 'off-opt-name', o.name));
          main.appendChild(h('span', 'off-opt-desc', o.desc));
          b.appendChild(main);
          b.addEventListener('click', function () {
            closeSheet();
            if (o.act === 'pause') {
              pauseSession(id);
              ctx.back();
            } else {
              doEnd();
            }
          });
          opts.appendChild(b);
        });
        return sheetShell('要怎么离开？', opts, '继续待着');
      }

      function doEnd() {
        var wantSummary = (session.systemSettings || {}).endSummary !== false;
        endSession(id);
        if (!wantSummary) {
          ctx.toast('见面结束了', 'ok');
          ctx.back();
          return;
        }
        /* 总结失败不阻塞离开（指令卡九-6）：先退场，总结在后台跑，
           好了写进会话，入口页/场景页都能看到；失败会记 summaryError 可重试。 */
        ctx.toast('见面结束 · 正在后台整理记忆…', 'ok');
        applySummary(session);
        setTimeout(function () { ctx.back(); }, 400);
      }

      function buildApiSheet() {
        var wrap = h('div', 'off-api-wrap');
        var list = h('div', 'off-api-list');
        var choices = apiChoices();
        var current = {
          label: session.apiModel || defaultApiModel() || (choices[0] || {}).label || '',
          model: session.apiModelName || ''
        };
        var scope = 'session';

        function cfgOf(label) {
          for (var i = 0; i < choices.length; i++) {
            if (choices[i].label === label) return choices[i].cand.cfg;
          }
          return choices.length ? choices[0].cand.cfg : null;
        }

        if (!choices.length) {
          wrap.appendChild(h('p', 'off-entry-empty', '还没有配置模型，去 设置 → 主 API'));
        }

        /* 模型名 + 小圆钮拉取（生图同款；点模型名填入并收起列表） */
        var modelSec = h('div', 'off-field-col');
        modelSec.appendChild(h('span', 'off-field-label', '模型名（留空 = 用接口里配的）'));
        var modelInput = h('input', 'off-settings-input');
        modelInput.value = current.model;
        modelInput.placeholder = '可手填，或点右边圆钮拉取';
        var modelLine = h('div', 'off-model-line');
        modelLine.appendChild(modelInput);
        /* 拉取模型走**浮层**（ui.modelPickButton）—— 以前结果平铺在这一段下面，
           回 40 个就把整页拉长（用户：「别铺在屏幕上」）。下拉函数仍然用
           「当前选中的接口」，没选接口就同步返回一个失败结果（浮层里显示）。 */
        var mini = ui.modelPickButton({
          tip: '用上面选中的接口去拉；也可以直接手填',
          load: function () {
            var cfg = cfgOf(current.label);
            if (!cfg || !cfg.baseUrl) return { ok: false, message: '先选一个接口' };
            return Sleepy.api.fetchModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
          },
          onPick: function (mid) { modelInput.value = mid; }
        });
        modelLine.appendChild(mini);
        modelSec.appendChild(modelLine);
        modelInput.addEventListener('change', function () { current.model = modelInput.value.trim(); });

        choices.forEach(function (c) {
          var opt = h('button', 'off-api-option' + (c.label === current.label ? ' active' : ''));
          opt.type = 'button';
          var left = h('span', 'off-api-opt-left');
          left.appendChild(h('span', 'off-api-opt-name', c.label));
          left.appendChild(h('span', 'off-api-opt-desc', c.desc));
          opt.appendChild(left);
          var check = h('span', 'off-api-check');
          check.appendChild(h('span', 'off-api-check-dot'));
          opt.appendChild(check);
          opt.addEventListener('click', function () {
            current.label = c.label;
            current.model = '';              /* 换接口，模型名回到该接口自己配的 */
            modelInput.value = '';
            pickBox.innerHTML = '';
            [].forEach.call(list.children, function (x) { x.classList.remove('active'); });
            opt.classList.add('active');
          });
          list.appendChild(opt);
        });
        wrap.appendChild(list);
        wrap.appendChild(modelSec);

        var scopeRow = h('div', 'off-api-scope');
        var bSession = h('button', 'off-scope-btn active', '仅本次线下');
        var bDefault = h('button', 'off-scope-btn', '设为线下默认');
        bSession.type = bDefault.type = 'button';
        bSession.addEventListener('click', function () {
          scope = 'session';
          bSession.classList.add('active'); bDefault.classList.remove('active');
        });
        bDefault.addEventListener('click', function () {
          scope = 'default';
          bDefault.classList.add('active'); bSession.classList.remove('active');
        });
        scopeRow.appendChild(bSession);
        scopeRow.appendChild(bDefault);
        wrap.appendChild(scopeRow);

        var okBtn = h('button', 'off-sheet-cancel off-ok-btn', '就这样');
        okBtn.type = 'button';
        okBtn.addEventListener('click', function () {
          current.model = modelInput.value.trim();
          setApiModel(id, current.label, scope, current.model);
          ctx.toast('已切换到 ' + current.label + (current.model ? ' · ' + current.model : ''), 'ok');
          closeSheet();
          ctx.refresh();
        });
        wrap.appendChild(okBtn);

        return sheetShell('切换模型', wrap, '取消');
      }

      function buildSettingsSheet() {
        var sheet = h('div', 'off-overlay');
        var box = h('div', 'off-sheet off-sheet-full');
        box.appendChild(h('div', 'off-sheet-handle'));

        var tabs = h('div', 'off-settings-tabs');
        var panels = {};
        /* 第三个页签 = 诊断（折叠查看）。
           ★ 刻意**不在沉浸正文里常驻技术状态行** —— 只放设置里，
             默认折叠，不影响读场景。 */
        [['sys', '系统设置'], ['narrative', '叙事设置'], ['diag', '请求诊断']].forEach(function (t, i) {
          var b = h('button', 'off-settings-tab' + (i === 0 ? ' active' : ''), t[1]);
          b.type = 'button';
          b.addEventListener('click', function () {
            [].forEach.call(tabs.children, function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            Object.keys(panels).forEach(function (k) {
              panels[k].classList[k === t[0] ? 'add' : 'remove']('active');
            });
            /* 切到诊断页签时刷新一次（诊断只在内存，可能已变化） */
            if (t[0] === 'diag') refreshDiagPanel();
          });
          tabs.appendChild(b);
        });
        box.appendChild(tabs);

        panels.sys = buildSysPanel();
        panels.narrative = buildNarrativePanel();
        panels.diag = buildDiagPanel();
        /* ★ diagPanelRef 必须挂在**与 refreshDiagPanel 同层**的作用域上。
           v2 曾把它声明成 buildSettingsSheet 的局部变量，而
           refreshDiagPanel 是同层的另一个函数 —— 两者互相看不见，
           点「请求诊断」页签时 refreshDiagPanel 读到未声明的 diagPanelRef
           → ReferenceError（面板永远刷不出来，且报在点击那一刻）。 */
        diagPanelRef = panels.diag;
        box.appendChild(panels.sys);
        box.appendChild(panels.narrative);
        box.appendChild(panels.diag);

        var close = h('button', 'off-sheet-cancel', '关闭');
        close.type = 'button';
        close.addEventListener('click', closeSheet);
        box.appendChild(close);
        sheet.appendChild(box);
        sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
        return sheet;
      }

      function section(title) {
        var sec = h('div', 'off-settings-section');
        sec.appendChild(h('div', 'off-settings-section-title', title));
        return sec;
      }

      /* ============================ 诊断面板（折叠 · 仅内存） ============================

         ★ 数据源是 diagSnapshot() —— **实际出站那次装配**的记录，不是预览。
         ★ 页面刷新即失（只在内存），**不入库、不上传**。
         ★ 展示字段就那几项：序号 / 时间 / 阶段 / 是否用了新正文 / 原因码 /
           版本 / 模块标识 / 模型是否成功。**不含** prompt、聊天、角色名、
           override 内容、异常全文、API 配置。 */
      function buildDiagPanel() {
        var wrap = h('div', 'off-settings-panel');
        var sec = section('最近一次线下请求');
        var fold = h('details', 'off-diag-fold');
        fold.appendChild(h('summary', 'off-diag-summary', '展开查看'));
        var body = h('div', 'off-diag-body');
        fold.appendChild(body);
        sec.appendChild(fold);
        wrap.appendChild(sec);
        wrap.refreshDiag = function () { fillDiagBody(body); };
        fillDiagBody(body);
        return wrap;
      }

      function refreshDiagPanel() {
        if (diagPanelRef && diagPanelRef.refreshDiag) diagPanelRef.refreshDiag();
      }

      function fillDiagBody(body) {
        body.textContent = '';
        var d = diagSnapshot();
        if (!d) {
          body.appendChild(h('div', 'off-diag-line off-diag-empty',
            '还没有过线下请求。这一页只记录最近一次出站请求的装配结果，刷新页面即清空。'));
          return;
        }
        /* 阶段文案**必须走闭集**：normStage 已把未知值归成 'unknown'，
           这里再兜一层，绝不回显任意原串。 */
        var lines = [
          ['请求身份', '#' + d.requestId],
          ['诊断记录序号', '#' + d.seq],
          ['时间', d.at],
          ['阶段', DIAG_STAGE_LABELS[d.stage] || DIAG_STAGE_LABELS[STAGE_UNKNOWN]],
          ['本次是否用了新行为正文', d.behaviorUsed ? '是' : '否'],
          ['回退原因码', d.reason ? d.reason : '（无）'],
          ['用户覆盖命中', d.touched ? '是' : '否'],
          /* 版本未知时显示固定文案（normVersion 已把非受校验值归成 'unknown'）。
             ⚠️ override 提前返回那条路径在读到 BT.VERSION 之前就 return 了，
               所以那一轮的版本**必然**是「未知」—— 这是正确结果，不是缺陷。 */
          ['行为文本版本', d.version === VERSION_UNKNOWN ? '未知（本次未走到读取版本那一步）'
            : d.version],
          ['实际使用模块', d.modules.length ? d.modules.join(' / ') : '（无 —— 回退时不记候选）'],
          ['请求结果', d.requestOk === null ? '（本轮还没有结论）'
            : (d.requestOk ? '成功拿到内容' : '未拿到内容')]
        ];
        lines.forEach(function (r) {
          var line = h('div', 'off-diag-line');
          line.appendChild(h('span', 'off-diag-k', r[0]));
          line.appendChild(h('span', 'off-diag-v', r[1]));
          body.appendChild(line);
        });
        body.appendChild(h('div', 'off-diag-note',
          '「已到达调用边界」只说明本轮已把请求交给模型通道，' +
          '**不代表服务端已收到**。「服务端已收到并拒绝」只出现在确实拿到过' +
          '服务端响应（HTTP 错误或无法解析的响应体）时；网络失败与超时' +
          '无法确认服务端是否收到，一律记「请求失败（无法确认服务端是否收到）」。' +
          '本页只记录最近一次出站请求的装配结果，刷新即清空。'));
      }

      function rowToggle(label, desc, val, onSet) {
        var row = h('div', 'off-settings-row');
        var left = h('div', 'off-settings-row-left');
        left.appendChild(h('span', 'off-settings-row-label', label));
        left.appendChild(h('span', 'off-settings-row-desc', desc));
        row.appendChild(left);
        var t = h('div', 'off-toggle' + (val ? ' on' : ''));
        t.addEventListener('click', function () {
          var next = !t.classList.contains('on');
          t.classList.toggle('on', next);
          onSet(next);
        });
        row.appendChild(t);
        return row;
      }

      function rowSeg(label, desc, options, val, onSet) {
        var row = h('div', 'off-settings-row-col');
        row.appendChild(h('span', 'off-settings-row-label', label));
        var seg = h('div', 'off-seg-ctrl');
        options.forEach(function (o) {
          var b = h('button', 'off-seg-btn' + (o.value === val ? ' active' : ''), o.label);
          b.type = 'button';
          b.addEventListener('click', function () {
            [].forEach.call(seg.children, function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            onSet(o.value);
          });
          seg.appendChild(b);
        });
        row.appendChild(seg);
        if (desc) row.appendChild(h('span', 'off-settings-row-desc', desc));
        return row;
      }

      function buildSysPanel() {
        var sys = session.systemSettings || {};
        var p = h('div', 'off-settings-panel active');

        var wpSec = section('壁纸 / 配色');
        var grid = h('div', 'off-wallpaper-grid');
        [
          { key: '', cls: 'wp-paper', name: '纸本' },
          { key: 'theme-dusk', cls: 'wp-dusk', name: '暮色' },
          { key: 'theme-mist', cls: 'wp-mist', name: '雾蓝' },
          { key: 'theme-rose', cls: 'wp-rose', name: '浅玫' },
          { key: 'custom', cls: 'wp-custom', name: '自定义' }
        ].forEach(function (w) {
          var active = (sys.theme || '') === w.key || (w.key === '' && !sys.theme);
          var item = h('button', 'off-wallpaper-item off-' + w.cls + (active ? ' active' : ''));
          item.type = 'button';
          if (w.key === 'custom') {
            var plus = h('span', 'off-wp-plus');
            plus.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
            plus.appendChild(h('span', '', '自定义'));
            item.appendChild(plus);
            item.addEventListener('click', function () { pickWallpaper(item); });
          } else {
            var prev = h('span', 'off-wp-preview');
            prev.appendChild(h('span', 'off-wp-name', w.name));
            item.appendChild(prev);
            item.addEventListener('click', function () {
              updateSystem(id, { theme: w.key });
              [].forEach.call(grid.children, function (x) { x.classList.remove('active'); });
              item.classList.add('active');
              setThemeLive(w.key);
            });
          }
          grid.appendChild(item);
        });
        wpSec.appendChild(grid);
        p.appendChild(wpSec);

        var itSec = section('交互');
        itSec.appendChild(rowToggle('显示建议选项', '每轮回复后给出可选行动',
          sys.showSuggests !== false, function (v) { syncDual(id, 'showSuggests', v); }));
        itSec.appendChild(rowToggle('场景时间推进', '随对话推进自动更新时间和氛围',
          sys.timeAdvance !== false, function (v) { syncDual(id, 'timeAdvance', v); }));
        itSec.appendChild(rowToggle('结束时生成总结', '见面结束后提示整理记忆',
          sys.endSummary !== false, function (v) { updateSystem(id, { endSummary: v }); }));
        p.appendChild(itSec);

        /* 译文开关：**跟线上加号面板是同一个全局偏好**（store 的 translateOn），
           不做成会话级 —— 「我要不要看译文」是读者的习惯，不是这场戏的属性。
           他说中文的话这一行没有意义，就不出现（语言由常驻地点推）。 */
        if (Sleepy.msgTrans && Sleepy.msgTrans.needs(session.charId)) {
          var lgSec = section('语言');
          lgSec.appendChild(rowToggle('他说的外语附译文', '关掉只是不看译文，不影响他说什么语言',
            !!(Sleepy.calendar && Sleepy.calendar.translateOn()), function (v) {
              if (Sleepy.calendar) Sleepy.calendar.setTranslateOn(v);
              fillMessages(body.querySelector('.off-chat-scroll'));
            }));
          p.appendChild(lgSec);
        }

        var memSec = section('记忆');
        memSec.appendChild(rowToggle('自动沉淀重要时刻', '总结时把模型标为「重要」的时刻自动锚定，永远优先召回',
          sys.autoAnchorMoments !== false, function (v) { updateSystem(id, { autoAnchorMoments: v }); }));
        memSec.appendChild(rowToggle('线下内容独立存档', '不流入线上聊天记录，单独归档',
          sys.offlineArchive !== false, function (v) { updateSystem(id, { offlineArchive: v }); }));
        p.appendChild(memSec);
        return p;
      }

      function setThemeLive(key) {
        var root = body.querySelector('.off-root');
        if (!root) return;
        root.className = 'off-root' + (key && key !== 'custom' ? ' ' + key : '');
        if (key === 'custom') {
          var sys = findSession(id).systemSettings || {};
          if (sys.customWallpaperUrl) {
            var sc = body.querySelector('.off-chat-scroll');
            if (sc) applyWallpaper(sc);
          }
        } else {
          var sc2 = body.querySelector('.off-chat-scroll');
          if (sc2) { sc2.classList.remove('has-wallpaper'); sc2.style.backgroundImage = ''; }
        }
      }

      function pickWallpaper(item) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var f = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (!f) return;
          if (!Sleepy.media || !Sleepy.media.available || !Sleepy.media.available()) {
            ctx.toast('图库不可用，换不了自定义壁纸', 'err');
            return;
          }
          Sleepy.media.shrink(f).then(function (r) {
            return Sleepy.media.put(r.blob, { name: '线下壁纸', kind: 'image', w: r.w, h: r.h });
          }).then(function (mid) {
            updateSystem(id, { theme: 'custom', customWallpaperUrl: mid });
            [].forEach.call(item.parentNode.children, function (x) { x.classList.remove('active'); });
            item.classList.add('active');
            setThemeLive('custom');
            ctx.toast('壁纸换好了', 'ok');
          }, function () {
            ctx.toast('壁纸没存上', 'err');
          });
        });
        input.click();
      }

      function buildNarrativePanel() {
        var n = session.narrativeSettings || {};
        var p = h('div', 'off-settings-panel');

        var lensSec = section('叙事镜头');
        lensSec.appendChild(rowSeg('叙事视角', '决定叙事里 Char 的自称和对 user 的称呼方式', [
          { value: 'he_you', label: '他看着你' },
          { value: 'i_you', label: '我看着你' },
          { value: 'name_you', label: charName + '看着你' },
          { value: 'he_she', label: '他看着她' }
        ], n.pov || 'he_you', function (v) { updateNarrative(id, { pov: v }); }));
        lensSec.appendChild(rowSeg('叙事时态', '', [
          { value: 'present', label: '现在时' },
          { value: 'past', label: '过去时' }
        ], n.tense || 'present', function (v) { updateNarrative(id, { tense: v }); }));
        lensSec.appendChild(rowSeg('开场方式', '第一次进这个场景时谁先开口', [
          { value: 'char', label: '场景 + 他先开口' },
          { value: 'scene', label: '只铺场景' }
        ], n.opening || 'char', function (v) { updateNarrative(id, { opening: v }); }));
        p.appendChild(lensSec);

        var styleSec = section('文风');
        styleSec.appendChild(rowSeg('整体风格', '', [
          { value: 'nature_life', label: '自然生活' },
          { value: 'immersive', label: '细腻沉浸' },
          { value: 'restrained', label: '克制留白' },
          { value: 'lively', label: '轻快灵动' },
          { value: 'cool_crisp', label: '冷感利落' },
          { value: 'cinematic', label: '电影叙事' },
          { value: 'custom', label: '自定义' }
        ], n.style || 'nature_life', function (v) {
          updateNarrative(id, { style: v });
          wordsWrap.style.display = v === 'custom' ? '' : 'none';
        }));

        /* 自定义文风词：写了就整段注入叙事设置，模型照着写
           （文风词库的编写在施工卡待办里，这里是给 user 的手填口） */
        var wordsWrap = h('div', 'off-custom-len');
        wordsWrap.style.display = n.style === 'custom' ? '' : 'none';
        var wordsTa = document.createElement('textarea');
        wordsTa.className = 'off-settings-input';
        wordsTa.rows = 3;
        wordsTa.placeholder = '文风词，逗号或换行分隔。例：克制的，短句，物件细节多，情绪藏在动作里';
        wordsTa.value = n.styleWords || '';
        wordsTa.addEventListener('change', function () {
          updateNarrative(id, { styleWords: wordsTa.value.trim() });
        });
        wordsWrap.appendChild(wordsTa);
        styleSec.appendChild(wordsWrap);

        /* 字数：三档 + 自定义（自定义时多出一个数字输入行） */
        var lenRow = rowSeg('回复字数', '', [
          { value: 'short', label: '简短' },
          { value: 'medium', label: '适中' },
          { value: 'long', label: '详尽' },
          { value: 'custom', label: '自定义' }
        ], n.lengthMode || 'medium', function (v) {
          updateNarrative(id, { lengthMode: v });
          customWrap.style.display = v === 'custom' ? '' : 'none';
        });
        styleSec.appendChild(lenRow);
        var customWrap = h('div', 'off-custom-len');
        customWrap.style.display = n.lengthMode === 'custom' ? '' : 'none';
        var lenInput = h('input', 'off-settings-input');
        lenInput.type = 'number';
        lenInput.placeholder = '字数下限，例：300';
        lenInput.min = '50'; lenInput.max = '2000';
        lenInput.value = n.customLengthMin || '';
        lenInput.addEventListener('change', function () {
          var v = parseInt(lenInput.value, 10);
          updateNarrative(id, { customLengthMin: isNaN(v) ? null : Math.max(50, Math.min(2000, v)) });
        });
        customWrap.appendChild(lenInput);
        styleSec.appendChild(customWrap);

        styleSec.appendChild(rowToggle('描写 Char 内心', '叙事中允许出现他的心理活动',
          n.showCharInner !== false, function (v) { updateNarrative(id, { showCharInner: v }); }));
        styleSec.appendChild(rowToggle('Char 主动推进剧情', '不只回应，也会引发新事件',
          !!n.charProactive, function (v) { updateNarrative(id, { charProactive: v }); }));
        styleSec.appendChild(rowSeg('NPC 出现频率', '', [
          { value: 'none', label: '无' },
          { value: 'occasional', label: '偶尔点缀' },
          { value: 'normal', label: '正常参与' }
        ], n.npcFrequency || 'none', function (v) { updateNarrative(id, { npcFrequency: v }); }));
        p.appendChild(styleSec);
        return p;
      }

      function pad2(n) { return n < 10 ? '0' + n : '' + n; }

      ctx.rebuild = function () { renderScene(ctx); };
      /* onShow 用：只有会话状态变了（active→ended 等）才值得整体重建，
         每次显示都重建会把空会话的开场再触发一遍 */
      ctx.__sceneStatus = session.status;
  }

  Sleepy.register('offline-scene', {
    title: '线下',
    render: renderScene,
    onShow: function (ctx) {
      /* 状态没变就不重建 —— 避免每次 onShow 都重跑一遍渲染
         （双开场就是它和 render 连击造成的）。 */
      /* ★ 页面实例是缓存复用的：再次进入走 onShow，不会重跑 render。
         所以 __alive 必须在这里重新置位。
         v2 只在 renderScene 入口置 true、onHide 置 false ——
         离开一次之后 __alive 永远停在 false，于是本场景之后所有请求
         在预取回来时都被当成「页面已离开」而作废（回复根本发不出去）。 */
      ctx.__alive = true;
      var s = Sleepy.offlineStore.findSession(ctx.params.id);
      if (ctx.rebuild && s && s.status !== ctx.__sceneStatus) ctx.rebuild();
    },
    onHide: function (ctx) {
      /* 离开页面时把「本页还有效」标记清掉。
         * 在途请求的迟到回调据此判断**不要再去动 DOM / 忙碌态 / toast** ——
           页面已经不在了，往旧 DOM 写既无效也可能抛。
         * 诊断仍照写（那是纯内存记账，与 DOM 无关）。
         *
         * 标记只有一处：**ctx.__alive**（renderScene 入口置 true，本处置 false）。
           v2 只改了 ctx.el.__offlineAlive 与一个**从未被赋值**的
           Sleepy.__offlineSceneCtx —— 而在途回调读的是 ctx.__alive，
           于是 onHide 一个标记都没真清掉，页面离开后迟到回调照样写旧 DOM。 */
      if (ctx) ctx.__alive = false;
    }
  });

  /* ============================ 对外（冒烟用） ============================ */

  Sleepy.offlineStore = {
    allSessions: allSessions,
    findSession: findSession,
    createSession: createSession,
    appendMessage: appendMessage,
    pauseSession: pauseSession,
    endSession: endSession,
    syncDual: syncDual,
    updateNarrative: updateNarrative,
    updateSystem: updateSystem,
    updateEnv: updateEnv,
    setApiModel: setApiModel,
    defaultApiModel: defaultApiModel,
    /* 群聊线下场景复用同一套接口选择与调用（page-group-offline 用） */
    apiChoices: apiChoices,
    candForSession: candForSession,
    callModel: callModel
  };

  /* 门弹窗：page-chat 的门图标直接调这个，不再经过入口页 */
  Sleepy.offlineUI = {
    openDoorSheet: openDoorSheet
  };

  /* 线下实际请求诊断（**只读**对外口）。

     ★ 正常运行环境**只有两个只读入口**：snapshot（读最近一次深拷贝）、
       stageLabel（阶段闭集文案，UI 与测试共用一份避免枚举漂移）。
     ★ **不暴露任何写入/清库入口**。v2 曾在导出面上挂 __record /
       __recordIfCurrent / __reset / __snapshot 四个测试钩子，其中
       __recordIfCurrent 还是个**根本不存在的函数引用**（v1 删除后没清理）——
       模块顶层求值到 `__recordIfCurrent: diagRecordIfCurrent` 就抛
       ReferenceError，把整个 IIFE 的导出全拖垮。
     ★ 需要构造诊断记录的测试一律走**真实发送链**（mock 模型通道），
       不再从生产接口直接写 —— 见 scripts/browser-offline-f2-req-test.js。 */
  Sleepy.offlineDiag = {
    /* 读取最近一次线下调用诊断的深拷贝；从未调用过返回 null */
    snapshot: diagSnapshot,
    /* 阶段闭集文案（UI 与测试共用一份，避免两处枚举漂移） */
    stageLabel: function (s) { return DIAG_STAGE_LABELS[s] || DIAG_STAGE_LABELS[STAGE_UNKNOWN]; }
  };

  /* 解析降级取证（**只读**对外口）。
     ★ 与 offlineDiag 同一套自律：**只暴露只读入口**，
       不提供写入 / 删除 / 清库 / 任何测试钩子。
     ★ 用途：让判分器与验收脚本在**跨刷新**后仍能拿到模型原始返回，
       以定位降级根因（此前只能记「不判」，因为原文已随内存 Map 一起消失）。
     ★ 这条通道**不参与任何业务判定**：解析成功/失败的可见行为与诊断闭集一字未改。 */
  Sleepy.offlineForensics = {
    /* 全部降级取证记录，按时间升序；返回深拷贝，调用方改不动内部状态 */
    snapshot: forensicsSnapshot
  };

})(window);
