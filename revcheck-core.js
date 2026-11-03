/* ============================================================
   revcheck-core.js — 反查手机 · 纯逻辑核心（P0，参考 qs utils/checkPhone/reverse*）

   TA 偷看用户的手机。设计对齐《方案-反查手机-v1.1》：
     · 触发闸：倾向（自动推导 high/medium/low/none，可手动覆盖）
       → 每轮概率 5%~20% + 20 分钟冷却 + 最少 3 轮
     · 用户主动让查：意图正则 + 倾向决定同意/拒绝 + 本地拒绝文案（不调 LLM）
     · 权限面：每个「页面」一个开关，缺省全开；内部/敏感面硬禁止
     · 浏览计划：可用页面排成步骤（私聊「滑到谁读谁」按岛内对象展开），
       按倾向裁剪（high 全看 / medium 4 / low 2 / none 1）
     · 执行形态（P1 接）：模块级 runner 驱动**真页面**——openPage 切真页面 +
       真滚动容器平滑滚动 + 内心想法弹幕 + 顶部胶囊（手法照 qs reverseTakeoverRunner）

   红线：本文件**零依赖**（不碰 store / DOM / fetch / LLM）——
   采样与页面切换由 page-chat 注入读取器；Node 单测直接 require。
   岛章红线：所有「可看内容」由注入方保证只喂本岛数据，本文件只管计划与判定。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* ---------------- 倾向：自动推导（对齐 qs resolveReverseProclivity） ---------------- */

  var LEVELS = ['high', 'medium', 'low', 'none'];

  /** 推导词表：命中越多越靠前；hard 组直接定档 */
  var PROCLIVITY_HIGH_RE = /(占有欲|控制欲|吃醋|嫉妒|黏人|粘人|多疑|敏感|查岗|翻手机|偷看|窥探|好奇心重|八卦|好奇|爱管|在意你|关注你|想知道你|在乎你)/;
  var PROCLIVITY_LOW_RE = /(尊重隐私|隐私|边界感|给空间|不过问|不干涉|信任你|互不|独立|冷淡|疏离|高冷|有自己的事)/;
  var PROCLIVITY_NONE_RE = /(绝不|从不去看|永不|坚决不看|毫不在意|无所谓)/;

  /** 从人设推导倾向（默认 medium；hard 词命中 none 优先，其次 low，再次 high） */
  function deriveProclivity(personaText) {
    var t = String(personaText || '');
    if (PROCLIVITY_NONE_RE.test(t)) return 'none';
    if (PROCLIVITY_LOW_RE.test(t)) return 'low';
    if (PROCLIVITY_HIGH_RE.test(t)) return 'high';
    return 'medium';
  }

  function normalizeLevel(v) {
    return LEVELS.indexOf(v) !== -1 ? v : deriveProclivity(v);
  }

  /** 每轮主动触发基准概率 */
  var TRIGGER_PROB = { high: 0.20, medium: 0.12, low: 0.05, none: 0 };
  /** 对「用户让查」的同意概率 */
  var CONSENT_PROB = { high: 0.9, medium: 0.7, low: 0.25, none: 0.1 };
  /** 倾向 → 浏览计划裁剪步数（high 不裁） */
  var TRIM_STEPS = { high: Infinity, medium: 4, low: 2, none: 1 };

  /* ---------------- 触发闸（冷却由调用方持久化，本文件只判定） ---------------- */

  var COOLDOWN_MS = 20 * 60 * 1000;   /* 两次主动反查最小间隔 */
  var MIN_ROUNDS = 3;                 /* 主动发起的最小聊天轮数 */

  /**
   * 是否应该主动发起反查。
   * state: { lastAt: number, persona: string }（lastAt 由调用方按岛存取）
   * rand 注入以便单测；命中后由调用方记 lastAt = now。
   */
  function shouldAutoTrigger(state, roundCount, now, rand) {
    var level = normalizeLevel(state && state.persona);
    var prob = TRIGGER_PROB[level];
    if (prob <= 0) return false;
    if ((roundCount || 0) < MIN_ROUNDS) return false;
    var last = (state && state.lastAt) || 0;
    if (now - last < COOLDOWN_MS) return false;
    return rand < prob;
  }

  /* ---------------- 用户意图正则 + 同意/拒绝（对齐 qs reverseTrigger） ---------------- */

  var USER_ASK_RE = new RegExp(
    '(你(?:去|来|可以|帮我)?(?:查|看|翻|检查|翻翻|翻看)(?:一下|下)?(?:我|我的)?(?:手机|聊天|记录|消息))' +
    '|((?:我|我的)手机(?:给|拿)你(?:看|查|翻))' +
    '|((?:让你|给你)(?:看|查|翻)(?:手机)?)' +
    '|((?:查|翻|看)(?:我的|我)手机)' +
    '|(你(?:查|翻)一下我)'
  );

  function isUserAsking(userText) {
    return USER_ASK_RE.test(String(userText || ''));
  }

  function consentOf(persona, rand) {
    var level = normalizeLevel(persona);
    return rand < CONSENT_PROB[level] ? 'agree' : 'decline';
  }

  /** 拒绝文案（本地模板，不调 LLM；傲娇式 vs 尊重隐私式） */
  function declineText(charName, persona) {
    var level = normalizeLevel(persona);
    if (level === 'high' || level === 'medium') {
      return '哼，谁要看你手机，我才不看呢。' + (charName || '') + ' 扭头。';
    }
    if (level === 'low') return '不了，尊重你的隐私，手机我就不看啦。';
    return '还是不看了，每个人都有自己的小秘密。';
  }

  function agreeText(persona) {
    var level = normalizeLevel(persona);
    if (level === 'high') return '真的让我看？那...那我看了哦。';
    if (level === 'medium') return '嗯...你确定？那我稍微看一下。';
    return '好呀，那我看一眼。';
  }

  /* ---------------- 权限面 ----------------
     页面键（P1 接线时映射到 sleepy 真页面）：
       chat 私聊 / moments 朋友圈 / photos 相册 / diary 日记 /
       favorites 收藏 / profile 微信账号（马甲资料+钱包）/ forum 群声
     hard：TA 绝不该看到的（查岗记录/设置/账密/API）压根不进清单。 */

  var PAGE_DEFS = [
    { id: 'chat', name: '私聊' },
    { id: 'moments', name: '朋友圈' },
    { id: 'photos', name: '相册' },
    { id: 'diary', name: '日记' },
    { id: 'favorites', name: '收藏' },
    { id: 'profile', name: '微信账号' },
    { id: 'forum', name: '群声' }
  ];

  function pageName(id) {
    for (var i = 0; i < PAGE_DEFS.length; i++) {
      if (PAGE_DEFS[i].id === id) return PAGE_DEFS[i].name;
    }
    return id;
  }

  /** 权限判定：state 是 { pageId: false } 形式的关单（缺省 = 开） */
  function isPageAllowed(id, offMap) {
    return !!(offMap && offMap[id] === false) === false;
  }

  /* ---------------- 浏览计划 ----------------
     available: [{ id, name?, targets?: [{ id, name, chatId }] }]
       —— 由调用方按岛现算（岛内有什么可看的、私聊有哪些对象）。
     计划步骤：{ page, pageName, targetCharId?, targetName?, chatId?, detail }
     「滑到谁读谁」：chat 页按 targets 展开成每对象一步。 */

  function buildPlan(available, persona, offMap) {
    var level = normalizeLevel(persona);
    var trim = TRIM_STEPS[level];
    var steps = [];
    var pageIds = PAGE_DEFS.map(function (p) { return p.id; });
    /* chat 优先（TA 最想看聊天），其余按固定顺序 */
    var ordered = ['chat'].concat(pageIds.filter(function (id) { return id !== 'chat'; }));

    for (var i = 0; i < ordered.length && steps.length < trim; i++) {
      var id = ordered[i];
      var def = null;
      for (var k = 0; k < available.length; k++) {
        if (available[k] && available[k].id === id) { def = available[k]; break; }
      }
      if (!def) continue;                       /* 岛上没有这个面 → 跳过 */
      if (!isPageAllowed(id, offMap)) continue; /* 权限关了 → 跳过 */
      if (id === 'chat' && Array.isArray(def.targets) && def.targets.length) {
        /* 滑到谁读谁：每个对象一步 */
        def.targets.forEach(function (t) {
          steps.push({
            page: 'chat', pageName: '私聊（' + t.name + '）',
            targetCharId: t.id, targetName: t.name, chatId: t.chatId || null,
            detail: '点开和「' + t.name + '」的私聊'
          });
        });
      } else {
        steps.push({ page: id, pageName: def.name || pageName(id), detail: '浏览了「' + (def.name || pageName(id)) + '」' });
      }
    }
    return steps.slice(0, trim === Infinity ? steps.length : trim);
  }

  /* ---------------- 汇总卡片文案（收尾播报用，对齐 qs buildSummary） ----------------
     2026-10-29 用户口径：旧的连成一坨（「TA 知道了：与…对话中你提到：你：你好…」）
     又丑又没用。现在三段式：翻了哪、心里想什么、记住了什么 —— 一句一段，
     展示面另有结构化卡片（msg.rev），这段主要喂给 eventNote/下一轮。 */

  function buildSummary(charName, items, thoughts) {
    /* 2026-10-29 用户口径（v287）：不报「翻了 A、B、C」这种**面名清单**
       让模型自己猜里面有什么 —— 空的相册就是被脑补成「全是关于我的事」
       的（用户实锤）。每面把**翻到了什么**（或「什么都没有」）直接交代。
       detail 由采样器（page-chat.revSample）生成，空面有显式话术；
       长内容截 60 字 —— 这段是给模型接话的语境，不是全文搬运。 */
    var segs = [];
    for (var i = 0; i < items.length; i++) {
      var d = String(items[i] && items[i].detail || '').trim();
      if (!d) d = '什么都没有';
      if (d.length > 60) d = d.slice(0, 60) + '…';
      segs.push((items[i].pageName || '?') + '：' + d);
    }
    var out = charName + ' 翻看了你的手机 —— ' + (segs.join('；') || '什么都没翻到');
    var learned = '';
    for (var j = 0; j < items.length; j++) {
      if (items[j].learned) { learned = items[j].learned; break; }
    }
    if (thoughts && thoughts.length) {
      out += '。心里想：「' + thoughts.filter(Boolean).join('」「') + '」';
    }
    if (learned) out += '。记住了：' + learned;
    return out + '。';
  }

  /* ---------------- 邀请卡回复解析（v1.2：user 递手机 → TA 下轮自决接不接） ---------------- */

  /**
   * 从 TA 回复里解析 [[REV_ACCEPT]]（宽容匹配：[[..]] / 【..】都认）。
   * 邀请是**一次性**的：有标签 = 接过手机（调用方随即启动接管）；
   * 没标签 = 嘴上拒绝（ TA 自己说，系统不代答）。正文里的标签一律剥净。
   */
  function parseAcceptTag(raw) {
    var s = String(raw || '');
    var accept = /[\[【]{1,2}\s*REV_ACCEPT\s*[\]】]{1,2}/i.test(s);
    return {
      accept: accept,
      text: s.replace(/[\[【]{1,2}\s*REV_ACCEPT\s*[\]】]{1,2}/gi, '').trim()
    };
  }

  /* ---------------- 主动起意（v1.3：剧情驱动，不摇骰子） ----------------
     用户口径：按剧情触发，不要每轮掷概率（否则三句话翻一次手机）。
     做法：给 TA 的上下文里挂一句「你随时可以翻看 ta 的手机」的说明，
     TA 剧情上真的起意（吃醋/起疑/八卦到忍不住）就自己夹 [[REV_PEEK]]。
     冷却（COOLDOWN_MS）只当保险丝：防模型上头连着看，不控制起意本身。 */

  /**
   * 从 TA 回复里解析 [[REV_PEEK]]（宽容匹配同上）。正文一律剥净。
   */
  function parsePeekTag(raw) {
    var s = String(raw || '');
    var peek = /[\[【]{1,2}\s*REV_PEEK\s*[\]】]{1,2}/i.test(s);
    return {
      peek: peek,
      text: s.replace(/[\[【]{1,2}\s*REV_PEEK\s*[\]】]{1,2}/gi, '').trim()
    };
  }

  /**
   * 起意是否被放行（保险丝闸，不掷骰）：
   * 人设 none 档（TA 设定上绝不翻手机）直接拦；冷却未过拦。
   * state: { persona, lastAt }；now 由调用方传。
   */
  function canPeekNow(state, now) {
    if (normalizeLevel(state && state.persona) === 'none') return false;
    var last = (state && state.lastAt) || 0;
    return now - last >= COOLDOWN_MS;
  }

  /* ---------------- 导出 ---------------- */

  Sleepy.revcheck = {
    deriveProclivity: deriveProclivity,
    normalizeLevel: normalizeLevel,
    shouldAutoTrigger: shouldAutoTrigger,
    isUserAsking: isUserAsking,
    consentOf: consentOf,
    declineText: declineText,
    agreeText: agreeText,
    isPageAllowed: isPageAllowed,
    pageName: pageName,
    buildPlan: buildPlan,
    buildSummary: buildSummary,
    parseAcceptTag: parseAcceptTag,
    parsePeekTag: parsePeekTag,
    canPeekNow: canPeekNow,
    COOLDOWN_MS: COOLDOWN_MS,
    MIN_ROUNDS: MIN_ROUNDS,
    PAGE_DEFS: PAGE_DEFS
  };

})(typeof window !== 'undefined' ? window : globalThis);
