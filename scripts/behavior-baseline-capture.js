#!/usr/bin/env node
/* ============================================================
   scripts/behavior-baseline-capture.js — 五场景装配产物的迁移前基线捕获

   跑法：
     node scripts/behavior-baseline-capture.js            # 只捕获 + 自检，**不写盘**
     node scripts/behavior-baseline-capture.js --write    # 创建基线（**仅创建**，已存在则拒绝）

   ★ 本脚本不接生产、不进 index.html、不调模型、不发网络请求、不读真实用户数据。
   ★ 默认不写盘（§四「capture 默认不写」）。
   ★ **没有覆盖能力**：`--force` 已移除并会显式报错（不静默忽略）。
     新建或更新基线均需单独授权 —— 更新时请先申请，不要指望换个文件名就自动放行。
   ★ 排他创建（openSync 'wx'）：已存在 → EEXIST → 拒绝写入，不留 TOCTOU 窗口。
   ★ 环境变量 SLEEPY_BASELINE_PATH 只用于**测试**把落点指到临时目录；
     生产用法不要设它。

   ---- 本批捕获边界（scope 只有两种取值，不许含混）----
   transport  过了「传输记录器」—— 能证明记录器被真实调用，抓到的是
              装配 + 调用点拼出来的完整请求（system + user）。
   assembly   直接调已导出的装配函数拿到 messages（或 system 串）。
              这是装配边界，**不是**传输边界 —— 不冒充。

   ---- 本批只捕这些（逐项标函数与边界）----
     私聊线上  Sleepy.promptEngine.assembleOnline(ctx)            assembly
     私聊线下  Sleepy.promptEngine.assembleOffline(ctx)           assembly
     主动消息  Sleepy.proactiveEngine.evaluate(charId, opts)      transport
     群线上    Sleepy.groupAI.composeRound(groupId, opts)         assembly
     群线下    Sleepy.groupOfflineStore.buildSystem(session)      assembly
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var H = require('./harness.js');

var BASELINE = path.join(H.ROOT, 'scripts', 'fixtures', 'behavior-baseline-v1.json');
var BASELINE_VERSION = 'behavior-baseline-v1';

/* ============================================================
   1. 虚构夹具的哨兵文本
   ------------------------------------------------------------
   每个哨兵对应一个真实的读字段位置（注释里给锚点）；捕获时**逐个断言
   真的出现在出站内容里**，不靠字段名猜（§二）。
   全部虚构，不含任何真实用户数据 / API Key / 真实聊天内容。
   ============================================================ */
var S = {
  /* 角色卡短字段 —— prompt-engine.js charMetaLines():832-844 */
  charContent: '【夹具·角色人设】旧书店老板，话不多，习惯把书按年代摆。',
  charSpeech: '夹具·说话方式：句子短，爱用句号。',
  charNeverDo: '夹具·红线：不撒谎。',
  charJpContent: '【夹具·日语角色人设】东京来的编辑，说话轻。',
  subContent: '【夹具·皮套人设】夜里的另一张脸。',
  npcContent: '【夹具·NPC人设】店长，只管收银。',

  /* user 马甲：小号 name 留空 + wechatName 顶上（core.labelOfUser 唯一出口）
     人设 persona —— prompt-engine.js compileUserCore():859-865 */
  userWechat: '夹具·微信名·小号',
  userPersona: '夹具·user马甲人设：喜欢在雨天翻旧书。',
  bigUserName: '夹具·大号',

  /* K03 关系与记忆 —— core.memoryViewFor()，落 store 'memories' */
  memory: '夹具·记忆：她说她怕打雷。',

  /* K04 世界书 —— compileWorldbook():993-1025 */
  worldbook: '夹具·世界书：这座岛上只有一家旧书店。',

  /* L1.5 近期生活动态 —— life-feed.js momentsItems() */
  moment: '夹具·动态：今天翻到一本缺页的旧书。',

  /* 日历日程 —— I02 时间事实 + 收藏提议候选（char_schedule） */
  calEvent: '夹具·日程：把书还给旧友。',

  /* C04 表情包 / 发图能力 */
  stickerName: '夹具表情',

  /* 主动消息三条输入 */
  attention: '夹具·关注：她上次提过想看那部老电影。',
  charStateFeeling: '夹具·当前感受：有点挂念。',
  charStateReading: '夹具·对对方的理解：她最近很累。',

  /* K03d 已成立影响 —— ta-impact.js 三道闸 */
  taImpact: '夹具·已成立影响：他答应过陪她看那部老电影。',

  /* 群场景 */
  groupName: '夹具·周三读书会',
  groupMsgUser: '夹具·群消息：明晚有空吗？',
  groupMsgChar: '夹具·群消息：我可以，地点没问题。',
  sessionPurpose: '夹具·见面目的：把上次没收好的书还给他。',
  envLocation: '夹具·地点：旧书店后间',

  /* K03 掉马事件（compileDrop 有写副作用：markDropEventsSeen） */
  dropText: '夹具·掉马事件：她认出了你另一张脸。',

  /* 自定义卡（cfg().custom） */
  customBody: '夹具·自定义卡：记得带伞。',

  /* 用户覆盖（cfg().overrides）—— 只在分流用例里出现 */
  overrideShell: '夹具·覆盖外壳：这是用户改过的共享外壳。',

  /* 历史 */
  histUser1: '夹具·历史1：上周末她说想看那部老电影。',
  histChar1: '夹具·历史1：他说好，下周一起去。',
  histUser2: '夹具·历史2：今天想把书还了。'
};

/* 静态探针：代码里的固定字面量（不是夹具数据）。
   作用与哨兵相反 —— 哨兵证「字段被消费」，探针证「这一段代码还在装配里」。
   都只在捕获时读一遍，值进基线、由 test 比较。 */
var P = {
  shellHead: '[身份与场景]',
  f1Check: '【输入确定性】',
  f2Bridge: '【线上承接到线下】',
  patSpec: '[拍一拍:后缀]',
  c05Head: '【输出格式 · 硬约束】',
  c05offHead: '【输出协议 · 硬约束】',
  proactiveHead: '【候选判断】',
  proactiveCand: '[TRIGGER_CANDIDATES]',
  proactiveNow: '[NOW]',
  proactiveContact: '[CONTACT_STATE]',
  groupRoundSchedule: '【先调度',
  groupEntityKnowledge: '[ENTITY_KNOWLEDGE]',
  groupBudget: '[BUDGET]',
  groupRecent: '[RECENT_GROUP]',
  offScene: '[SCENE]',
  offParticipants: '[PARTICIPANTS]',
  offLanguages: '[LANGUAGES]',
  offPresence: '[PRESENCE RULES]',
  offOutput: '[OUTPUT]',
  offWriting: '[WRITING]',
  timeFactsHead: '【时间事实】',
  langHead: '【说话方式】',
  i01Head: '[I01]',
  userCoreHead: '[USER_CORE]',
  charCoreHead: '[CHARACTER]',
  worldbookHead: '【世界书】',
  memoryHead: '【记忆】',
  lifeHead: '[近期生活动态]',
  stickerHead: '【表情包】',
  genimgHead: '【发图】',
  phoneHead: '【他的手机】',
  weProposalHead: '【收藏提议】',
  dropHead: '【刚刚发生的事】',
  taImpactHead: '[TA_IMPACT]'
};

/* 固定 id：显式给定，不依赖 newId 的时间+随机（那两样也冻结了） */
var ID = {
  sb: 'sb_fixture_1',
  chMain: 'ch_fixture_main',
  chSub: 'ch_fixture_sub',
  chJp: 'ch_fixture_jp',
  chNpc: 'ch_fixture_npc',
  umBig: 'um_fixture_big',
  umSmall: 'um_fixture_small',
  chat: 'chat_fixture_1',
  offSession: 'off_fixture_1',
  calEvent: 'ce_fixture_1',
  moment: 'mo_fixture_1',
  memory: 'mem_fixture_1',
  wb: 'wb_fixture_1',
  sticker: 'st_fixture_1',
  drop: 'de_fixture_1',
  taEvent: 'ta_fixture_1',
  taImpact: 'ti_fixture_1',
  customCard: 'custom_fixture_1',
  phone: 'ph_fixture_1'
};

/* ============================================================
   2. 夹具：把全新沙箱灌成「一座群岛 + 一主一皮套一外籍一 NPC」
   ------------------------------------------------------------
   尽量走生产自己的写入口（core.upsertChar / upsertUser / createSandbox /
   setSandboxChars / setSandboxMasks / groupStore.createGroup …）；
   生产没提供写入口的键才直接写 localStorage（并在这里注明键名）。
   ============================================================ */
function buildFixture(h, opts) {
  opts = opts || {};
  var S3 = h.S;

  /* ---- 岛：先按生产入口建，再把 id 改成固定的（只动 id 字段，schema 不变）---- */
  var sb = S3.core.createSandbox('archipelago', '夹具岛');
  var list = S3.core.listSandboxes().map(function (x) {
    return x.id === sb.id ? Object.assign({}, x, { id: ID.sb }) : x;
  });
  S3.core.saveSandboxes(list);
  S3.core.setActiveSandbox(ID.sb);

  /* ---- 角色 ---- */
  S3.core.upsertChar({
    id: ID.chMain, kind: 'main', name: '夹具·纪言',
    content: S.charContent, speech: S.charSpeech, neverDo: S.charNeverDo,
    region: 'CN', city: '上海', timezone: 'Asia/Shanghai'
  });
  S3.core.upsertChar({
    id: ID.chSub, kind: 'sub', parentId: ID.chMain, name: '夹具·夜灯',
    content: S.subContent
  });
  S3.core.upsertChar({
    id: ID.chJp, kind: 'main', name: '夹具·Yuki',
    content: S.charJpContent, region: 'JP', city: '东京', timezone: 'Asia/Tokyo'
  });
  S3.core.upsertChar({
    id: ID.chNpc, kind: 'npc', parentId: ID.chMain, name: '夹具·店长',
    content: S.npcContent, knownBy: []
  });

  /* ---- 我（两件马甲；小号名字留空，靠微信名顶上）---- */
  S3.core.upsertUser({ id: ID.umBig, name: S.bigUserName, isDefault: true });
  S3.core.upsertUser({ id: ID.umSmall, name: '', wechatName: S.userWechat, persona: S.userPersona });

  /* setSandboxChars 只收大号（validateSandboxChars 会退回 NPC）—— 返回要核 */
  var vChars = S3.core.setSandboxChars(ID.sb, [ID.chMain, ID.chJp]);
  if (!vChars || !vChars.ok) throw new Error('夹具设岛内角色失败：' + (vChars && vChars.message));
  var vMasks = S3.core.setSandboxMasks(ID.sb, [ID.umBig, ID.umSmall]);
  if (vMasks && vMasks.ok === false) throw new Error('夹具设岛内马甲失败：' + vMasks.message);
  S3.core.switchTo(ID.chMain, ID.umBig);

  /* ---- 关系：小号已知情（→ awareness merged）、大号 single ---- */
  S3.core.addLink(ID.chMain, ID.umSmall, 'aware', false);
  S3.core.addLink(ID.chMain, ID.umBig, 'single', false);

  /* ---- 记忆（四元组 rootId / fromCharId / toUserId / role / text）---- */
  S3.core.addMemory({
    id: ID.memory, rootId: ID.chMain, fromCharId: ID.chMain, toUserId: ID.umSmall,
    role: 'user', text: S.memory
  });

  /* ---- 以下键生产没有对外的写入 API，直接写存档（键名与 schema 见注释）---- */

  /* 'worldbooks'：[{ id, name, enabled, scope, characterId, sandboxId, entries:[…] }] */
  S3.store.set('worldbooks', [{
    id: ID.wb, name: '夹具世界书', enabled: true, scope: 'personal', characterId: ID.chMain,
    sandboxId: ID.sb,
    entries: [{ name: '夹具条目', content: S.worldbook, keys: '', always: true, enabled: true }]
  }]);

  /* 'moments'：朋友圈动态（lifeFeed 的 L1.5 来源之一） */
  S3.store.set('moments', opts.noMoments ? [] : [{
    id: ID.moment, sandboxId: ID.sb, characterId: ID.chMain,
    text: S.moment, at: H.FIXED_MS - 3600 * 1000, name: '夹具·纪言',
    privacy: 'all', likes: [{ name: S.bigUserName }],
    comments: [{ name: S.bigUserName, text: '夹具·评论：我也想看。' }]
  }]);

  /* 'calEvents'：[{ id, sandboxId, ownerCharId, eventType, title, status, startAt }] */
  S3.store.set('calEvents', [{
    id: ID.calEvent, sandboxId: ID.sb, ownerCharId: ID.chMain,
    eventType: 'char_schedule', title: S.calEvent, status: 'active',
    startAt: H.FIXED_MS + 6 * 3600 * 1000, allDay: false
  }]);

  /* 'stickers' / 'imgApis' / 'imgApiId' */
  S3.store.set('stickers', [
    { id: ID.sticker, name: S.stickerName, url: 'stub://sticker', global: true }
  ]);
  S3.store.set('imgApis', [
    { id: 'imgApi_fixture', name: '夹具生图', baseUrl: 'stub://imggen', model: 'fixture-img',
      enabled: true }
  ]);
  S3.store.set('imgApiId', 'imgApi_fixture');

  /* 'phones'（compilePhoneDelta 只判壳是否存在） */
  S3.store.set('phones', [
    { id: ID.phone, charId: ID.chMain, sandboxId: ID.sb }
  ]);

  /* 'dropEvents'（未读掉马事件） */
  S3.store.set('dropEvents', [
    { id: ID.drop, sandboxId: ID.sb, rootId: ID.chMain,
      at: H.FIXED_MS - 60 * 1000, text: S.dropText, seen: false }
  ]);

  /* 主动消息：候选 / 心绪 / 主 API / 设置（键名见 page-proactive.js） */
  S3.store.set('attentionInbox:' + ID.chMain, { items: [{ content: S.attention }] });
  S3.store.set('charState:' + ID.chMain, {
    feelings: [S.charStateFeeling], readings: [S.charStateReading], unspoken: []
  });
  S3.store.set('openLoops:' + ID.chMain, { items: [] });
  S3.store.set('mainApi', {
    name: '夹具主模型', baseUrl: 'stub://main', apiKey: 'fixture-key', model: 'fixture-model',
    temperature: null, maxTokens: null, contextMessages: null, stream: false,
    timeoutSec: 60, enabled: true
  });
  S3.store.set('proactiveSettings', {
    quietStart: '', quietEnd: '', maxPerDay: 8, cooldownMin: 0, deferMin: 90
  });

  /* 'taEvents'：已成立影响（知情闸 knownCharId === rootIdOf(charId)） */
  S3.store.set('taEvents', [{
    id: ID.taEvent, sandboxId: ID.sb, refCharId: ID.chMain, status: 'active',
    impacts: [{
      id: ID.taImpact, eventRef: ID.taEvent, kind: 'situation',
      text: S.taImpact, basis: '夹具·依据：他们约过一起看老电影。',
      knownCharId: ID.chMain, strength: 3, status: 'active',
      acceptedAt: H.FIXED_MS - 2 * 3600 * 1000
    }]
  }]);

  /* 'chats'：私聊会话（主动消息那条路要走 chatStore.chatOf） */
  S3.store.set('chats', [{
    id: ID.chat, sandboxId: ID.sb, name: '夹具·纪言', characterId: ID.chMain,
    userId: ID.umBig, createdAt: H.FIXED_MS - 86400000, updatedAt: H.FIXED_MS - 3600000,
    messages: [
      { id: 'msg_f1', role: 'user', content: S.histUser1, timestamp: H.FIXED_MS - 7200000 },
      { id: 'msg_f2', role: 'assistant', content: S.histChar1, timestamp: H.FIXED_MS - 7000000 },
      { id: 'msg_f3', role: 'user', content: S.histUser2, timestamp: H.FIXED_MS - 600000 }
    ]
  }]);

  /* 'presetEngine'：{ useEngine, developerMode, overrides, disabled, custom } */
  var preset = {
    useEngine: true, developerMode: true, overrides: {}, disabled: {},
    /* devMigrated:true：生产 2026-10-07 起出厂 dev=off 且旧值会被一次性洗成 false；
       基线捕获口径仍是 dev=true（hidden:false 依赖它）—— 显式带迁移标记，
       让 promptEngine.cfg() 的迁移跳过这里，黄金基线一字不动。 */
    devMigrated: true,
    custom: [{ id: ID.customCard, title: '夹具自定义卡', body: S.customBody }]
  };
  if (opts.overrides) preset.overrides = opts.overrides;
  if (opts.disabled) preset.disabled = opts.disabled;
  S3.store.set('presetEngine', preset);

  /* ---- 群（线上要群岛；线下也要 groupId）---- */
  var g = S3.groupStore.createGroup({
    name: S.groupName, ownerAccountId: ID.umBig,
    members: [
      { kind: 'char', ownerId: ID.chMain, accountId: ID.chMain },
      { kind: 'char', ownerId: ID.chMain, accountId: ID.chSub },
      { kind: 'char', ownerId: ID.chJp, accountId: ID.chJp },
      { kind: 'npc', ownerId: ID.chNpc, accountId: ID.chNpc }
    ]
  });
  if (!g || !g.ok) throw new Error('夹具建群失败：' + (g && g.message));
  h.groupId = g.group.id;
  S3.groupStore.addMessage(h.groupId, {
    senderKind: 'user', senderAccountId: ID.umBig, content: S.groupMsgUser
  });
  S3.groupStore.addMessage(h.groupId, {
    senderKind: 'char', senderAccountId: ID.chMain, content: S.groupMsgChar
  });

  /* ---- 群线下会话（用户身份用**小号**，顺带验 labelOfUser 那条出口）---- */
  h.offSession = {
    id: ID.offSession, sandboxId: ID.sb, groupId: h.groupId,
    charId: ID.chMain, userIdentityAccountId: ID.umSmall,
    purpose: S.sessionPurpose,
    env: { location: S.envLocation, timeOfDay: '傍晚', weather: '小雨', clockTime: '18:40' },
    systemSettings: {}, narrativeSettings: {},
    participants: [
      { ownerId: ID.chMain, kind: 'char', present: true, away: false },
      { ownerId: ID.chJp, kind: 'char', present: true, away: false },
      { ownerId: ID.chNpc, kind: 'npc', present: true, away: false }
    ],
    messages: [
      { id: 'off_m1', role: 'user', text: S.histUser2 },
      { id: 'off_m2', role: 'char',
        paras: [{ speaker: '夹具·纪言', type: 'prose', text: '夹具·线下历史：他把书放在柜台上。' }] }
    ]
  };
  S3.store.set('groupOfflineSessions', [h.offSession]);

  return h;
}

/* ============================================================
   3. 哨兵 / 探针计划
   ------------------------------------------------------------
   每项 = [key, require]
     require=true  → 捕获时必须命中，否则本脚本 exit 1、拒绝写基线
     require=false → 只记录观测值（进基线、由 test 比较），不作硬断言
   「观测但允许缺失」的项都在 GAPS 里有对应说明，不许悄悄放过。
   ============================================================ */
var SENTINEL_PLAN = {
  online: [
    ['charContent', 1], ['charSpeech', 1], ['charNeverDo', 1],
    ['userPersona', 1], ['userWechat', 1],
    ['memory', 1], ['worldbook', 1], ['calEvent', 1],
    ['moment', 0],   /* default 变体单独要求命中；life-empty 变体要求不命中 */
    ['stickerName', 1],
    ['dropText', 1], ['customBody', 1],
    ['histUser1', 1], ['histChar1', 1], ['histUser2', 1],
    ['taImpact', 0], ['subContent', 0], ['npcContent', 0], ['sessionPurpose', 0]
  ],
  offline: [
    ['charContent', 1], ['charSpeech', 1], ['charNeverDo', 1],
    ['userPersona', 1], ['userWechat', 1],
    ['memory', 1], ['worldbook', 1], ['moment', 1],
    ['stickerName', 0],
    ['customBody', 1], ['histUser2', 1], ['envLocation', 1],
    ['taImpact', 0], ['calEvent', 0], ['sessionPurpose', 0]
  ],
  proactive: [
    ['charContent', 1], ['charSpeech', 1], ['charNeverDo', 1],
    ['userPersona', 0], ['userWechat', 0],
    ['memory', 0], ['moment', 1],   /* memory：K03 批已接 compileRelation → 实测 true；require 仍 0（见 GAPS 过时登记） */
    ['attention', 1], ['charStateFeeling', 1], ['charStateReading', 1],
    ['histUser2', 1],
    ['worldbook', 0], ['calEvent', 0], ['taImpact', 0], ['customBody', 0]
  ],
  groupOnline: [
    ['charContent', 1], ['charSpeech', 1], ['charNeverDo', 1],
    ['charJpContent', 1], ['npcContent', 1],
    ['groupName', 1], ['groupMsgUser', 1], ['groupMsgChar', 1],
    ['userWechat', 0], ['userPersona', 0], ['subContent', 0],
    ['memory', 0], ['moment', 0], ['worldbook', 0], ['customBody', 0],
    ['sessionPurpose', 0]
  ],
  groupOffline: [
    ['charContent', 1], ['charSpeech', 1], ['charNeverDo', 1],
    ['charJpContent', 1], ['npcContent', 1],
    ['userWechat', 1],
    ['sessionPurpose', 1], ['envLocation', 1], ['histUser2', 0],
    ['userPersona', 0], ['subContent', 0],
    ['memory', 0], ['moment', 0], ['calEvent', 0], ['customBody', 0],
    ['worldbook', 0], ['taImpact', 0]
  ]
};

var PROBE_PLAN = {
  online: ['charCoreHead', 'userCoreHead', 'i01Head', 'timeFactsHead', 'langHead',
    'shellHead', 'f1Check', 'patSpec', 'c05Head', 'dropHead', 'memoryHead',
    'lifeHead', 'stickerHead', 'genimgHead', 'phoneHead', 'weProposalHead'],
  offline: ['charCoreHead', 'userCoreHead', 'i01Head', 'langHead', 'shellHead',
    'f2Bridge', 'memoryHead', 'lifeHead', 'worldbookHead', 'c05offHead'],
  proactive: ['shellHead', 'proactiveHead', 'proactiveCand', 'proactiveNow',
    'charCoreHead', 'i01Head', 'memoryHead', 'lifeHead', 'proactiveContact'],
  groupOnline: ['groupRoundSchedule', 'groupEntityKnowledge', 'groupBudget', 'groupRecent'],
  groupOffline: ['offScene', 'offParticipants', 'offLanguages', 'offPresence',
    'offOutput', 'offWriting', 'shellHead']
};

/* ============================================================
   4. 捕获
   ============================================================ */

function slotRow(slots) {
  return (slots || []).map(function (s) {
    return { id: s.id, slot: s.slot, on: !!s.on, tokens: s.tokens,
      hidden: !!s.hidden, required: !!s.required };
  });
}
function textOf(messages) {
  return (messages || []).map(function (m) { return String(m.content || ''); }).join('\n');
}
function slotOn(slots, id) {
  var hit = (slots || []).filter(function (s) { return s.id === id; });
  return hit.length ? !!hit[0].on : null;
}
function observe(text, plan, probes) {
  var out = {};
  plan.forEach(function (pair) { out[pair[0]] = text.indexOf(S[pair[0]]) >= 0; });
  (probes || []).forEach(function (k) { out['probe.' + k] = text.indexOf(P[k]) >= 0; });
  return out;
}
function requiredMisses(plan, obs) {
  return plan.filter(function (p) { return p[1] && !obs[p[0]]; }).map(function (p) { return p[0]; });
}
function diag(h) {
  return {
    scriptsLoaded: h.loaded.length,
    scriptsFailed: h.failed.length,
    timersQueued: h.timers.length,
    consoleCalls: h.consoleLog.length,
    forbiddenAccess: h.violations.slice()
  };
}
function pick(c) {
  return {
    id: c.id, fn: c.fn, scope: c.scope, transportCalls: c.transportCalls,
    transportCand: c.transportCand || null,
    transportOpts: c.transportOpts || null,
    evalResult: c.evalResult || null,
    messages: c.messages || null,
    system: c.system === undefined ? null : c.system,
    entities: c.entities || null,
    slots: c.slots || null,
    sentinels: c.sentinels,
    checks: c.checks
  };
}

var ONLINE_HISTORY = [
  { role: 'user', content: S.histUser1 },
  { role: 'assistant', content: S.histChar1 },
  { role: 'user', content: S.histUser2 }
];

function capOnline(label, opts, extraPlan) {
  var h = H.boot('online:' + label);
  buildFixture(h, opts);
  var r = h.S.promptEngine.assembleOnline({
    charId: ID.chMain, userId: ID.umSmall,
    history: ONLINE_HISTORY, userInput: S.histUser2
  });
  var text = textOf(r.messages);
  var plan = SENTINEL_PLAN.online.concat(extraPlan || []);
  var out = {
    id: label,
    fn: 'Sleepy.promptEngine.assembleOnline(ctx)',
    scope: 'assembly',
    transportCalls: 0,
    messages: r.messages,
    slots: slotRow(r.slots),
    checks: {}
  };
  out.sentinels = observe(text, plan, PROBE_PLAN.online);
  out.checks.shellSlotOn = slotOn(out.slots, 'shell');
  /* 判据用「默认外壳卡的静态首节」而不是 cardBody('shell')：override 之后
     cardBody 返回的就是 override 文本，拿它比等于自己跟自己比。 */
  out.checks.shellDefaultBodyInMessages = text.indexOf(P.shellHead) >= 0;
  out.checks.patSlotOn = slotOn(out.slots, 'pat');
  out.checks.f1SlotOn = slotOn(out.slots, 'f1');
  out.checks.lifeSlotOn = slotOn(out.slots, 'life');
  out.checks.momentInMessages = text.indexOf(S.moment) >= 0;
  out.diagnostics = diag(h);
  out.requiredMisses = requiredMisses(plan, out.sentinels);
  return out;
}

function capOffline(label, opts, extraPlan) {
  var h = H.boot('offline:' + label);
  buildFixture(h, opts);
  var r = h.S.promptEngine.assembleOffline({
    charId: ID.chMain, userId: ID.umSmall,
    session: h.offSession, userInput: S.histUser2
  });
  var text = textOf(r.messages);
  var plan = SENTINEL_PLAN.offline.concat(extraPlan || []);
  var out = {
    id: label,
    fn: 'Sleepy.promptEngine.assembleOffline(ctx)',
    scope: 'assembly',
    transportCalls: 0,
    messages: r.messages,
    slots: slotRow(r.slots),
    checks: {}
  };
  out.sentinels = observe(text, plan, PROBE_PLAN.offline);
  out.checks.shellSlotOn = slotOn(out.slots, 'shell');
  out.checks.shellDefaultBodyInMessages = text.indexOf(P.shellHead) >= 0;
  out.diagnostics = diag(h);
  out.requiredMisses = requiredMisses(plan, out.sentinels);
  return out;
}

function capProactive(plan) {
  var h = H.boot('proactive');
  buildFixture(h);
  var rec = H.installTransport(h, '{"decision":"skip","reasonCode":"fixture-stub"}');
  var before = rec.length;
  return h.S.proactiveEngine.evaluate(ID.chMain, { manual: true }).then(function (res) {
    var calls = rec.slice(before);
    var out = {
      id: 'default',
      fn: 'Sleepy.proactiveEngine.evaluate(charId, { manual: true })',
      scope: 'transport',
      transportCalls: calls.length,
      transportCand: calls.length ? calls[0].cand : null,
      transportOpts: calls.length ? calls[0].opts : null,
      evalResult: H.deepClone(res),
      messages: calls.length ? calls[0].messages : null,
      slots: null,
      checks: {}
    };
    var text = textOf(out.messages);
    out.sentinels = observe(text, SENTINEL_PLAN.proactive, PROBE_PLAN.proactive);
    out.checks.recorderCalled = calls.length > 0;
    out.checks.evalOk = !!(res && res.ok);
    out.diagnostics = diag(h);
    out.requiredMisses = requiredMisses(SENTINEL_PLAN.proactive, out.sentinels);
    return out;
  });
}

function capGroupOnline() {
  var h = H.boot('groupOnline');
  buildFixture(h);
  var round = h.S.groupAI.composeRound(h.groupId, {
    stimulus: '夹具·群刺激：user 刚刚发了那条消息。',
    budget: { actors: 3, msgs: 6 }, wave: 1, wavesLeft: 2
  });
  var out = {
    id: 'default',
    fn: 'Sleepy.groupAI.composeRound(groupId, opts)',
    scope: 'assembly',
    transportCalls: 0,
    messages: round ? round.messages : null,
    entities: round ? round.entities : [],
    slots: null,
    checks: {}
  };
  var text = textOf(out.messages);
  out.sentinels = observe(text, SENTINEL_PLAN.groupOnline, PROBE_PLAN.groupOnline);
  out.checks.entitiesCount = out.entities.length;
  /* 装配边界：本批没有让它过记录器 —— 记为「请求没过记录器」，不冒充传输验证 */
  out.checks.requestPassedRecorder = false;
  out.diagnostics = diag(h);
  out.requiredMisses = requiredMisses(SENTINEL_PLAN.groupOnline, out.sentinels);
  return out;
}

function capGroupOffline() {
  var h = H.boot('groupOffline');
  buildFixture(h);
  var sys = h.S.groupOfflineStore.buildSystem(h.offSession);
  var out = {
    id: 'default',
    fn: 'Sleepy.groupOfflineStore.buildSystem(session)',
    scope: 'assembly',
    transportCalls: 0,
    /* 生产里 user 消息在 renderScene 内联拼（:1052-1057，未导出）→ 这里只有 system 串 */
    messages: null,
    system: sys,
    slots: null,
    checks: {}
  };
  var text = String(sys || '');
  out.sentinels = observe(text, SENTINEL_PLAN.groupOffline, PROBE_PLAN.groupOffline);
  out.checks.systemParts = (text.match(/^\[[A-Z_ ]+\]/gm) || []).join(' ');
  out.diagnostics = diag(h);
  out.requiredMisses = requiredMisses(SENTINEL_PLAN.groupOffline, out.sentinels);
  return out;
}

/* ============================================================
   5. 缺口清单（本批明确不做 / 抓不到的部分，绝不写成「已完成」）
   ============================================================ */
var GAPS = [
  { scenario: 'online', kind: 'boundary', what: '调用方尾部未覆盖',
    detail: 'assembleOnline 之后的尾部在 page-chat.js:2632–2650（UI 函数内、未导出）；' +
      '传输出口 :2775 api.runChat。本批不为追完整请求扩展浏览器工程。' },
  { scenario: 'offline', kind: 'boundary', what: '调用方尾部未覆盖',
    detail: 'assembleOffline 之后的开场句在 page-offline.js:1146–1148、出口 :268 requestOnce，均在 UI 函数内。' },
  { scenario: 'proactive', kind: 'boundary', what: 'transport 是注入的假 transport',
    detail: 'evaluate 内部的 Sleepy.api.requestOnce 被换成记录器；抓到的 messages 是真装配产物，' +
      '但「真的发到远端」这一层不在本批验证范围。' },
  { scenario: 'groupOnline', kind: 'boundary', what: '未经传输记录器',
    detail: 'composeRound 已返回全部 messages，本批没有让它过记录器 → 只标「装配捕获」，不冒充传输边界验证。' },
  { scenario: 'groupOffline', kind: 'boundary', what: 'user 消息未覆盖',
    detail: 'messages 在 page-group-offline.js:1052–1057（renderScene:631 内、未导出）内联拼装，' +
      '本批只捕到 system 串；出口 :1063 offlineStore.callModel。' },
  { scenario: 'online/offline/proactive', kind: 'unreachable', what: 'L4 向量召回非空未覆盖',
    detail: 'memoryVec.lastOf 的缓存是模块内私有的 lastRecall，没有对外写入口；本批不修改生产代码' +
      '去暴露入口 → 召回恒为空，只覆盖「召回空」这一支（哨兵 recall 未列入计划）。' },
  { scenario: 'groupOnline/groupOffline', kind: 'unreachable', what: '群池 L4（groupTextFor）非空未覆盖',
    detail: '同因：lastRecall[groupKey(groupId)] 无对外写入口。' },
  { scenario: 'online', kind: 'unreachable', what: 'K03d taImpact 未命中（观测值为 false）',
    detail: '影响已按 TA_IMPACT 三道闸构造，但 relevance 需要与本轮输入 2-gram 重合；' +
      '本夹具的输入与影响文本重合度不足 → 如实记为未命中，不调夹具去凑。' },
  { scenario: 'proactive', kind: 'known-behavior', what: 'K03 关系记忆未接主动链路',
    detail: 'page-proactive.js buildSystem():197-215 只拼 shell / proactive 卡 / K01 / I01 / life / recall，' +
      '**没有 compileRelation** → 【记忆】块在主动请求里不出现（哨兵 memory 记为未命中）。' +
      '与冻结包 §2.2「主动缺 K03 关系记忆」的前置清单一致，属批次 F1 的缺口，不在本批修。' },
  /* ⚠️ 上面这条 proactive 的说明自 K03/f493aca 批（2026-10-05）起已过时：
     buildSystem 现在接了 compileRelation（K03 关系记忆）与 compileWorldbook（f493aca 世界书），
     哨兵 memory / probe.memoryHead / userWechat / worldbook 在主动链路翻成 true
     （批准翻转，见 behavior-online-migration-test 的 expectedProactiveDiffSet）；
     userPersona / customBody / taImpact 仍未命中（未接线，说明仍有效）。 */
  { scenario: 'online', kind: 'known-behavior', what: '皮套 / NPC 人设不进私聊线上',
    detail: 'assembleOnline 只按 ctx.charId 编译那一张脸的 K01；subContent / npcContent 未命中是期望值。' },
  { scenario: 'online/offline', kind: 'known-behavior', what: '语言段按常驻地点推，本夹具对话角色是中国人',
    detail: 'probe.langHead（【说话方式】）未命中 = char 说中文 → I03 整段不注入。' +
      '日语角色的语言段只在群场景（charJpContent + [LANGUAGES]）出现。' },
  { scenario: 'offline', kind: 'known-behavior', what: 'stickerName / calEvent / sessionPurpose 未命中',
    detail: 'OFFLINE_SLOTS 没有表情包槽与收藏提议槽；sceneText 用的是 session.sceneName / env，' +
      '不吃 session.purpose（purpose 只在群线下 [SCENE] 里）。' },
  { scenario: 'proactive', kind: 'known-behavior', what: 'K02 马甲 / K04 世界书 / 自定义卡 / I02 之外的槽未接',
    detail: 'buildSystem 只拼 shell / proactive 卡 / K01 / I01 / life / recall → userPersona、userWechat、' +
      'worldbook、customBody 未命中；与冻结包 §7.3「K02 需补、custom 待核」一致，属批次 F1。' +
      'K03d（taImpact）在主动链路本就未接（S17 未接，前几轮已核）。' },
  /* ⚠️ 上面这条 proactive 的说明自 K03/f493aca 批（2026-10-05）起部分过时：
     worldbook / userWechat 两哨兵已随 compileWorldbook + compileRelation 接线翻成 true
     （见上一条登记）；K02 马甲（userPersona）/ 自定义卡 / taImpact 仍未接，说明仍有效。 */
  { scenario: 'groupOnline', kind: 'known-behavior', what: 'moment / worldbook / customBody / sessionPurpose 未命中',
    detail: 'composeRound 只拼 groupRound 卡 + [GROUP] + [ENTITY_KNOWLEDGE] + [RECENT_GROUP]/[PENDING]/' +
      '[STIMULUS]/[BUDGET]，没有 L1.5 / 世界书 / 自定义卡 / 线下见面目的这些槽。' },
  /* ⚠️ 上面这条 groupOnline 的说明自 K03f（2026-10-05 群线上动态上下文）起已过时：
     composeRound 现在接了逐本体世界书 / 语言行 / L1.5 生活动态 / 群可用自定义卡，
     worldbook / moment 两个哨兵在群线上翻成 true（批准翻转，见 behavior-online-migration-test）；
     userPersona 未命中 = owner 马甲没写 persona；customBody 未命中 = 夹具卡没标 group:true。
     GAPS 数组本身被 v1 基线的 gaps 指纹钉死，不能改文本 —— 过时说明只留在这里登记。 */
  { scenario: 'groupOffline', kind: 'known-behavior', what: 'worldbook / taImpact 未接',
    detail: 'buildSystem 段序里没有 K04 世界书槽，也没有 K03d 已成立影响槽（与前几轮零命中结论一致）。' },
  { scenario: 'onlineLifeEmpty', kind: 'fixture-variant', what: 'life-empty 变体里 moment 必然缺失',
    detail: '该变体就是「朋友圈为空」的对照，故 moment / [近期生活动态] 都不出现 —— 这是期望值，不是缺陷。' },
  { scenario: 'groupOnline', kind: 'known-behavior', what: 'memory / subContent 不进群线上',
    detail: 'composeRound 不注入 compileRelation；[ENTITY_KNOWLEDGE] 给的是本体级知识，皮套 content 不进。' +
      '与前几轮「群两线未接 compileRelation」的结论一致。' },
  { scenario: 'groupOffline', kind: 'known-behavior', what: 'memory / moment / calEvent / customBody 不进群线下',
    detail: 'buildSystem 的段序是 shell → f2 → [SCENE] → [PARTICIPANTS] → [LANGUAGES] → [PRESENCE RULES] ' +
      '→ [OUTPUT] → [WRITING]，没有关系记忆 / L1.5 / 收藏提议 / 自定义卡槽。' },
  { scenario: 'groupOffline', kind: 'known-behavior', what: 'user persona 未注入',
    detail: '[PARTICIPANTS] 第一行只给 core.labelOfUser 的名字；persona 与知情映射属批次 F2 的缺口。' },
  { scenario: 'online', kind: 'dispatch', what: 'useEngine=false 旧路径未覆盖',
    detail: 'page-chat.js:2655+ 的旧路径（缺 shell / I01 / S05 / S10-12 / S17 / S25）属另一条分流，本批不捕。' },
  { scenario: 'all', kind: 'dispatch', what: 'developerMode=false 未覆盖',
    detail: 'dev=false 会把 locked 卡标 hidden（hidden 字段只在 slots 里，不影响 messages 正文）；' +
      '本批只捕 dev=true（生产默认）。' },
  /* ⚠️ 上面这条的「生产默认」自 2026-10-07 起过时：内置预设全上锁（设计确认），
     生产出厂 dev=off、旧存档的 dev:true 被一次性洗成 false（promptEngine.cfg 迁移）。
     本捕获夹具显式 developerMode:true + devMigrated:true，捕获口径不变；
     GAPS 数组被 v1 基线 gaps 指纹钉死，说明文本不改，只在此登记。 */
  { scenario: 'all', kind: 'boundary', what: '生命周期 / 异步写入未覆盖',
    detail: '只捕「装配那一刻」的产物；回复落地后的记忆刷新、向量构建、群记忆结算 gmSettle 都在边界外。' }
];

/* ============================================================
   6. 汇总
   ============================================================ */
function runAll() {
  var caps = {}, order = [];

  /* default：life 非空（夹具默认带朋友圈动态） */
  caps.online = capOnline('default', {}, [['moment', 1]]);
  order.push('online');
  /* 有效 override */
  caps.onlineOverride = capOnline('override-shell', { overrides: { shell: S.overrideShell } },
    [['overrideShell', 1]]);
  order.push('onlineOverride');
  /* 空 override */
  caps.onlineOverrideEmpty = capOnline('override-shell-empty', { overrides: { shell: '' } },
    [['overrideShell', 0]]);   /* 空 override 不该有正文 —— 观测并登记 */
  order.push('onlineOverrideEmpty');
  /* disabled：非 required 卡（pat）真能关 */
  caps.onlineDisabledPat = capOnline('disabled-pat', { disabled: { pat: true } });
  order.push('onlineDisabledPat');
  /* disabled：required 卡（shell / f1）关不掉 */
  caps.onlineDisabledRequired = capOnline('disabled-required-shell-f1',
    { disabled: { shell: true, f1: true } });
  order.push('onlineDisabledRequired');
  /* life 空 */
  caps.onlineLifeEmpty = capOnline('life-empty', { noMoments: true });
  order.push('onlineLifeEmpty');

  caps.offline = capOffline('default', {});
  order.push('offline');
  caps.offlineOverrideEmpty = capOffline('override-shell-empty', { overrides: { shell: '' } });
  order.push('offlineOverrideEmpty');

  caps.groupOnline = capGroupOnline();
  order.push('groupOnline');
  caps.groupOffline = capGroupOffline();
  order.push('groupOffline');

  /* 主动消息是异步的，最后收 */
  return capProactive().then(function (p) {
    caps.proactive = p;
    order.push('proactive');
    return { captures: caps, order: order };
  });
}

/* 被比较的那一部分（test 只比它）—— 取指纹用 */
function comparedPart(doc) {
  return { env: doc.env, fixture: doc.fixture, captures: doc.captures, gaps: doc.gaps };
}

function buildDocument(run) {
  var caps = {};
  run.order.forEach(function (k) { caps[k] = pick(run.captures[k]); });
  return {
    baselineVersion: BASELINE_VERSION,
    /* 运行日志：工具自身的不稳定信息，**不进比较范围**（test 里显式忽略 runLog） */
    runLog: {
      capturedAtUtc: new Date().toISOString(),
      node: process.version,
      argv: process.argv.slice(2),
      diagnostics: run.order.reduce(function (a, k) {
        a[k] = run.captures[k].diagnostics; return a;
      }, {}),
      requiredMisses: run.order.reduce(function (a, k) {
        a[k] = run.captures[k].requiredMisses || []; return a;
      }, {})
    },
    env: {
      tz: H.TZ, fixedMs: H.FIXED_MS, fixedIso: H.FIXED_ISO, randomSeed: H.SEED,
      scriptCount: H.ORDER.length, indexHtmlOrder: H.ORDER
    },
    fixture: {
      id: ID, sentinels: S, probes: P,
      note: '全部虚构；不含任何真实用户数据 / API Key / 真实聊天内容。' +
        '时间与随机在沙箱内冻结，时区固定为 ' + H.TZ + '。'
    },
    captures: caps,
    gaps: GAPS
  };
}

/* ============================================================
   7. CLI
   ============================================================ */
function report(doc) {
  var L = [];
  L.push('');
  L.push('小手机 · 迁移前基线捕获（默认不写盘）');
  L.push('');
  L.push('  用例                 边界        转输调用   出站字节  槽位');
  Object.keys(doc.captures).forEach(function (k) {
    var c = doc.captures[k];
    var bytes = c.messages ? Buffer.byteLength(JSON.stringify(c.messages), 'utf8')
      : Buffer.byteLength(String(c.system || ''), 'utf8');
    var slots = c.slots ? (c.slots.filter(function (s) { return s.on; }).length + '/' + c.slots.length) : '—';
    L.push('  ' + pad(k, 20) + pad(c.scope, 12) + pad(String(c.transportCalls), 9) +
      pad(String(bytes), 10) + '  ' + slots);
  });
  L.push('');
  L.push('  哨兵 / 探针核对（必中项缺失会让本脚本 exit 1）：');
  var bad = 0;
  Object.keys(doc.captures).forEach(function (k) {
    var c = doc.captures[k];
    var miss = Object.keys(c.sentinels).filter(function (x) { return !c.sentinels[x]; });
    var reqMiss = doc.runLog.requiredMisses[k] || [];
    bad += reqMiss.length;
    L.push('    ' + pad(k, 20) + '命中 ' + pad(String(Object.keys(c.sentinels).length - miss.length), 4) +
      '/' + pad(String(Object.keys(c.sentinels).length), 4) +
      '  必中缺失 ' + (reqMiss.length ? reqMiss.join(', ') : '无') +
      (miss.length ? ('  ｜ 观测未命中：' + miss.join(', ')) : ''));
  });
  L.push('');
  L.push('  槽位明细：');
  ['online', 'onlineOverride', 'onlineOverrideEmpty', 'onlineDisabledPat',
    'onlineDisabledRequired', 'onlineLifeEmpty', 'offline', 'offlineOverrideEmpty'
  ].forEach(function (k) {
    var c = doc.captures[k];
    if (!c.slots) return;
    L.push('    ' + pad(k, 22) + c.slots.map(function (s) {
      return s.id + (s.on ? '✓' : '·');
    }).join(' '));
  });
  L.push('');
  L.push('  分流断言（checks）：');
  Object.keys(doc.captures).forEach(function (k) {
    var ch = doc.captures[k].checks || {};
    var ks = Object.keys(ch);
    if (!ks.length) return;
    L.push('    ' + pad(k, 22) + ks.map(function (x) {
      var v = ch[x];
      return x + '=' + (typeof v === 'string' ? JSON.stringify(v)
        : (typeof v === 'number' ? v : (v ? 'true' : 'false')));
    }).join('  '));
  });
  L.push('');
  return { text: L.join('\n'), missing: bad };
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

function main() {
  var argv = process.argv.slice(2);
  var write = argv.indexOf('--write') >= 0;

  /* --force 在捕获前就拒绝（不静默忽略，也不走到任何捕获逻辑） */
  if (argv.indexOf('--force') >= 0) {
    process.stdout.write('  --force 不再支持：本工具**只创建**基线，没有覆盖能力。\n' +
      '  新建或更新基线均需单独授权。\n\n');
    process.exit(1);
  }

  return runAll().then(function (run) {
    var doc = buildDocument(run);
    var rep = report(doc);
    process.stdout.write(rep.text);

    if (rep.missing) {
      process.stdout.write('  ' + rep.missing + ' 项必中哨兵没命中 —— 夹具没被真实消费，拒绝写基线。\n\n');
      process.exit(1);
    }
    if (doc.captures.proactive.transportCalls !== 1) {
      process.stdout.write('  主动消息的传输记录器被调用 ' + doc.captures.proactive.transportCalls +
        ' 次（应为 1）—— 拒绝写基线。\n\n');
      process.exit(1);
    }

    var json = JSON.stringify(doc, null, 2) + '\n';
    process.stdout.write('  被比较内容 sha256  ' + H.sha256(JSON.stringify(comparedPart(doc))) +
      '   ← 两次独立捕获应相等（runLog 不入此值）\n');
    process.stdout.write('  整份文件 sha256    ' + H.sha256(json) + '（含 runLog，故每次不同）\n');
    process.stdout.write('  基线文件          ' + BASELINE + '\n');

    if (!write) {
      process.stdout.write('  未加 --write → 什么都没写。\n\n');
      process.exit(0);
    }

    /* 落点：环境变量只服务测试（临时目录），生产不设 */
    var target = process.env.SLEEPY_BASELINE_PATH || BASELINE;
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
    catch (e) {
      process.stdout.write('  无法创建目录：' + path.dirname(target) + '（' +
        ((e && e.code) || 'unknown') + '）\n\n');
      process.exit(1);
    }

    /* 排他创建：已存在 → EEXIST（拒绝）；其他错误如实报告，不冒充「已存在」 */
    var fd = null;
    try {
      fd = fs.openSync(target, 'wx');
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        process.stdout.write('  基线已存在，拒绝写入（本工具只创建、不覆盖）：' + target + '\n\n');
      } else {
        process.stdout.write('  创建基线失败：' + ((e && e.code) || 'unknown') + ' ' +
          ((e && e.message) || '') + '\n\n');
      }
      process.exit(1);
    }

    /* 可靠写入：短写补齐；任何写入 / 关闭失败都**不能**报成创建成功 */
    var buf = Buffer.from(json, 'utf8');
    var written = 0;
    try {
      while (written < buf.length) {
        var n = fs.writeSync(fd, buf, written, buf.length - written);
        if (!n) throw new Error('writeSync 返回 0');
        written += n;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* ignore */ } }
      /* 只清理**本次刚创建**的这个测试/新建产物；对已存在的文件从不做清理。
         清理失败如实报告，不掩盖主错。 */
      var cleaned = false;
      try { fs.unlinkSync(target); cleaned = true; } catch (e3) { cleaned = false; }
      process.stdout.write('  写入基线失败：' + ((e && e.message) || e) +
        '\n  本次新建的半成品清理：' + (cleaned ? '已删除' : '失败（请人工检查 ' + target + '）') +
        '\n\n');
      process.exit(1);
    }
    if (written !== buf.length) {
      process.stdout.write('  写入不完整（' + written + '/' + buf.length + ' 字节）—— 视为失败。\n\n');
      process.exit(1);
    }
    process.stdout.write('  已创建基线（仅创建，不覆盖）：' + target + '\n\n');
    process.exit(0);
  }, function (e) {
    process.stdout.write('\n  捕获失败：' + ((e && e.stack) || e) + '\n\n');
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = {
  BASELINE: BASELINE,
  BASELINE_VERSION: BASELINE_VERSION,
  S: S,
  P: P,
  ID: ID,
  GAPS: GAPS,
  SENTINEL_PLAN: SENTINEL_PLAN,
  PROBE_PLAN: PROBE_PLAN,
  buildFixture: buildFixture,
  runAll: runAll,
  comparedPart: comparedPart,
  buildDocument: buildDocument,
  report: report
};
