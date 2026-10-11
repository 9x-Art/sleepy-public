/* ============================================================
   store.js — Sleepy 本地存储层
   依赖：无
   被依赖：app.js、page-settings.js 及后续所有页面
   约定：所有键统一加前缀 sleepy.v1.，方便整包导出与体积统计
   对应 ROADMAP：2.4 配置本地存储 / 2.5 导出导入 / 2.6 体积显示

   ---- 数据模型（对应《小手机 OS · 终极架构总纲》）----

   1) characters —— 名片夹，树状层级，不是扁平列表
        [{ id, name, content, kind:'main'|'sub'|'npc', parentId, ... }]
        kind='main' 大号（灵魂层，根节点，parentId=null）
        kind='sub'  皮套（小号，挂在大号名下，parentId 指向大号）
        kind='npc'  附属（属于整座岛，parentType='sandbox'；谁认识 TA 单独定）
      对外展示的皮套各不相同，但底层共享同一个大脑 —— 这个「共享」
      由 parentId 表达，记忆库挂在根节点上（见 memories）。

   2) userMasks —— User 侧的马甲（玩家自己的大小号）
        [{ id, name, avatar, persona, createdAt }]
      大号 Char 必须绑定 User 马甲（boundUserId），皮套同理（boundUserId）。
      「极致的 1:1 对称」：Char 有几个皮套，User 就有几件马甲。

   3) links —— 通讯录里的关系（社交圈决定权完全交给 User，默认不强塞）
        [{ id, charId, userId, cognition, barrier, createdAt }]
        cognition 认知状态：'unaware' 不知情 / 'aware' 已知情
        barrier   true = 记忆完全隔离（平行宇宙，无任何既视感）

   4) memories —— 记忆全量存储 + 四元组标签
        不管切什么马甲，记忆全量存进该 Char 的唯一大脑（rootId）。
        [{ id, rootId, fromCharId, toUserId, role, text, at }]
        强制携带四元组标签 [U小号 -> C大号]，保证记忆绝对可溯源。

   5) desktop —— 4 屏网格桌面的摆放数据（C2：位置数据化，为拖拽预留）
        { pages: [[{ id, type, x, y, w, h, app }], ...] }
        没有任何 App 被焊死在特定位置，所有入口皆为组件。

   6) appearance —— 外观（青提玻璃感）
        { theme:'grape'|'night', fontScale }

   7) dropEvents —— 掉马事件。掉马瞬间撤销记忆障壁，强行注入系统事件
        [{ id, rootId, at, text, seen }]

   8) sandboxes —— **顶层容器**（《沙盒宇宙》）。一间房 = 一个存档，
        两种形态：kind='isle' 孤岛（1 User × 1 Char，绝对封闭）
                 kind='archipelago' 群岛（1 User × N Char，可拉群/查手机）
        [{ id, kind, name, cover, charIds, maskIds, theme, pages, ... }]
        activeSandboxId = 此刻人在哪间房，是**所有业务数据的作用域键**。

      「存档 = 平行存档」：同一个角色住在两间房里是两段互不知情的人生，
      所以 chats / memories / links / photos / diaries / todos / favorites /
      userMasks 都要带 sandboxId（S4 落地）；characters 里大号、皮套、NPC
      **全部**带 sandboxId（2026-09-21 拍板：大号也是每岛一份，没有全局大号
      —— 想玩同一个人设就是再建一个新的人）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var NS = 'sleepy.v1.';
  /* schema 3：《沙盒宇宙》落地 —— 新增 sandboxes / activeSandboxId。
     注意 importAll 只拒「比当前更新」的备份，所以 schema 2 的老存档照样能导。 */
  var SCHEMA = 3;

  /* ------------------------------------------------------------
     默认配置。
     新增字段必须先在这里登记，否则 get() 没有兜底值，
     页面会渲染出 undefined。老存档靠 merge() 自动补齐新字段。
     ------------------------------------------------------------ */
  var DEFAULTS = {
    meta: {
      schema: SCHEMA,
      installedAt: null,
      lastOpenAt: null
    },

    /* ---- 沙盒（《沙盒宇宙》的顶层容器）----
       sandboxes: [{
         id, kind: 'isle'(孤岛 1v1) | 'archipelago'(群岛 1vN),
         name, cover,
         charIds: [],   // 这间房有哪几个大号（isle 最多 1 个）
         maskIds: [],   // 这间房「我」有哪几件马甲
         theme: null,   // 每岛一套配色 + 字体（P3 填）
         deskVersion, pages   // 每岛一份完整户型（P3 填）
       }]
       activeSandboxId = 此刻「人在哪间房」，整个 OS 的数据作用域键。

       为什么不是「每房一套独立存储键」：那样 store 层的前缀、遍历、
       导入导出、体积统计全要大改；隔离度靠「读取点统一过 scopeId()」
       同样拿得到。见 docs/施工卡-沙盒宇宙-v1.md 第四节。 */
    sandboxes: [],
    activeSandboxId: null,

    /* 注意：photos / todos 这两个键**故意没有登记在这里**。
       它们是后加的，登记进 DEFAULTS 会改掉 getTodos() 的语义
       （page-desktop 靠「key 不存在」判断要不要落示例待办，
       登记之后拿到的是空数组，示例永远出不来）。
       导出兜底改在 exportAll() 里做 —— 它会扫一遍 localStorage，
       把带 NS 前缀但没登记的键一并带上。 */

    /* 2.2 主 API
       注意：temperature / maxTokens / contextMessages 默认是 null，
       意思是「跟随『聊天默认参数』」。单个接口想特殊化再填，填了就以它为准
       （见 api.js 的 genParams）。如果这里给死一个 0.85，
       用户在聊天默认参数页里怎么改都不会生效 —— 那种「改了没反应」最难查。 */
    mainApi: {
      name: '主模型',
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: null,
      maxTokens: null,
      contextMessages: null,
      stream: true,
      timeoutSec: 60,
      enabled: true
    },

    /* 2.3 副 API：多组 + 轮询顺序 + 启用开关。
       subApiFeatures（2026-10-08 定位重构）：功能分配勾选表
       { 功能key: true } —— 勾了的功能严格走副 API（api.js 读它收窄候选）。 */
    subApis: [],
    subApiFeatures: {},

    /* 2.16 生图：接口分类存（general / nai，见 imggen.js）、
       提示词库、全局开关。个人开关后置到 chat 个人聊天设置页，
       所以这里只有一把总闸。老存档靠 merge 自动补齐这批键。 */
    imgApis: [],
    imgApiId: null,
    promptLib: [],
    imggenEnabled: true,

    /* 2.12 聊天默认参数 —— **只放前端行为开关**。
       生成参数（温度 / 单次上限 / 上下文条数 / 流式）的内置默认值统一在
       api.js 的 GEN_DEFAULTS 里，这里不再抄一份：抄两份的时候以这里的为准，
       于是「改默认值」会静默失效（2026-09-22 真机踩到 —— api.js 改成 40，
       实际请求还是 20）。老存档里那几个键由 migrateChatDefaultsGenerative
       清掉，见文件末尾。 */
    chatDefaults: {
      /* E 模块：让模型在每次回复末尾顺带输出一段「心声」
         （用 <心声>…</心声> 包住），前端在流式过程中切出来。
         不额外占一次生成额度；关掉就完全不下这条指令。
         一轮就一条 —— 不做「每次几条」的配置，多了反而挑不出重点。 */
      heartbeatAuto: true
    },

    /* 2.11 外观。主题默认青提玻璃感（浅绿通透 / 玻璃拟态）。
       老的「夜灯手账」配色作为可选项保留在 appearance.legacy 里，
       但变量层不再往深色上叠补丁 —— 见 style.css 头部注释。 */
    appearance: {
      theme: 'grape',
      fontScale: 1
    },

    /* 3.x 聊天记录：[{ id, name, characterId, userId, createdAt, updatedAt, messages: [...] }]
       characterId 现在是「哪个皮套」，userId 是「哪件马甲」——
       一条对话 = 一个 (Char 皮套 × User 马甲) 组合，双向掉马矩阵就是
       在这两个维度上做文章（见 page-idcard.js 的认知矩阵）。 */
    chats: [],

    /* D2 收藏：被收藏的单条消息快照 */
    favorites: [],

    /* We（关系沉淀空间，2026-09-27）：共同记录表。
       每条 = 一条「共同记录」的引用，不复制聊天全文 / 图片本体：
       { id, sandboxId, title, note, at,
         sourceType: 'manual'|'chat'|'calendar'|'moments'|'photo'|'offline',
         sourceId, sourceRef, refCharId, refUserId,
         createdBy: 'user', createdAt, updatedAt }
       写入带 sandboxId（tagScope 盖章），读取按当前房 scoped 过滤。
       core.js cleanupSandbox 的 scoped 名单已收录，拆岛跟着清。 */
    weEntries: [],

    /* We 收藏馆 P2（2026-09-27）：char 提议、user 确认的**待确认提议表**。
       pending 绝不进 weEntries —— 只有 user 确认后经 weStore.add 生成正式藏品。
       { id, sandboxId, refCharId, refUserId,
         status: 'pending'|'accepted'|'declined',
         title, note, kind, at,
         sourceType: 'calendar', sourceId, sourceRef,
         proposedBy: 'char', proposedAt,
         originMessageId, originChatId, dedupeKey,
         resolvedBy, resolvedAt, acceptedEntryId }
       sandboxId 取 chat 记录自身（不取全局指针），读写唯一出口 page-we-proposal.js。
       core.js cleanupSandbox 的 scoped 名单已收录，拆岛跟着清。 */
    weProposals: [],

    /* ta 首页三张结构化表（2026-10-02 第二批，ta-life.js 数据层，0 模型调用）：
       事项 / 承诺 / 关注 —— 设计稿 §4「每个首页对象都能回到同源记录」。
       { id, sandboxId, refCharId(归 root), refUserId,
         …各表业务字段（见 ta-life.js 头注释）,
         sourceType:'manual'|…, sourceId, sourceRef,
         history[], createdAt, updatedAt }
       状态只认闭集；**承诺绝不自动判兑现**（只能人手改 + history 留痕）。
       写入 tagScope 盖章，读取 core.scoped 过滤；删房名单已收录。 */
    taItems: [],
    taPromises: [],
    taFollows: [],

    /* ta NPC 候选草稿（2026-10-02 第三批，ta-life.js）：
       未确认 NPC 只能是草稿 —— 独立键，不进 characters 表（正式名册），
       确认入库经 core.upsertChar 回填 formalCharId，重试幂等。
       { id, sandboxId, refCharId, refUserId, name, role, personality,
         interactionStyle, meetingOpportunity, reasonToStayConnected,
         closenessAndBoundary, ownLife, currentThreadProposal,
         existsConfirmed, userKnowsInStory, autonomousDevelopmentAllowed,
         status: 'draft'|'discarded'|'confirmed'|'failed',
         formalCharId, confirmedAt, sourceType, sourceRef, history[],
         createdAt, updatedAt } */
    taNpcDrafts: [],

    /* ta 提案表 + 已成立 NPC 事件表（2026-10-02 第四批，ta-proposal.js）：
       模型输出只准落 taProposals（status=pending），用户确认才由
       acceptProposal 改正式表（taItems/taFollows/taPromises/taEvents/
       attentionInbox 候选）。baseVersion 版本过期 → expired。
       { id, sandboxId, refCharId, refUserId, kind, operation, targetRef,
         baseVersion, summary, reason, extra{白名单}, sourceRefs, mode,
         fp, requestId, modelMeta, status: 'pending'|'accepted'|'rejected'|
         'expired'|'failed', appliedRef, history[], createdAt, updatedAt } */
    taProposals: [],
    /* 已成立 NPC 事件：提案接受后写入；knowledge/impact 各自绑定依据 */
    taEvents: [],

    /* 挂件灯留言（2026-10-06，page-desktop.js 的 Sleepy.lampNotes）：
       桌面 3D 灯上的卡。角色主动留（page-proactive 发送成功后）、
       user 长按私聊/群聊消息留。按岛隔离（tagScope 盖章 + core.scoped 读），
       cleanupSandbox 的 scoped 名单要带着它。上限 60 条，超出丢最旧。
       { id, sandboxId, text, by(署名), tone, ts, src:'proactive'|'chat'|'group' } */
    lampNotes: [],

    /* 灯的两个设置（2026-10-06 商城批2 起真正有写入方，页面在组件商城
       的灯设置面板）：lampLight 四档 warm/moon/day/candle；
       lampFontUrl 是**灯牌专属**字体直链（独立于外观的 fontUrl，
       填了就用 'SleepyLampFont' 覆盖外观字体对灯牌的影响） */
    lampLight: 'day',
    lampFontUrl: '',

    /* 桌面组件的 per-cell 配置（批3 简单砖/拍立得，page-desktop.js）：
       键 = cell.i，值随组件（countdown 的 target/label、polaroid 的
       photoIds…）。全局小键，孤儿条目无害不清理（见 page-desktop 注释） */
    widgetCfg: {},

    /* 自定义组件模板（批4，施工卡-组件商城-v1）：按岛隔离（tagScope/scoped，
       cleanupSandbox scoped 名单要带着）。user 在商城「自制」里写
       HTML/CSS 模板 + 选用变量；形状大小自由（w/h 不锁）。
       入库前必须过 sanitizeTpl（剥 <script>/on*=/javascript:，见 page-desktop）。
       { id, sandboxId, name, w, h, html, css, createdAt } */
    customWidgets: [],

    /* 慢递信箱（批4）：char 在回复里写 [慢递:小时数|信的内容]（1~72h），
       到点前 user 看不到内容。按岛隔离（tagScope/scoped + 删房清）。
       { id, sandboxId, charId, charName, body, hours, deliverAt, createdAt, opened } */
    slowLetters: [],

    /* 最小动作协议（2026-10-03 第二轮施工单第三批，action.js）：
       一次动作 = 一条记录。本轮只有 calendar.create_event 一种。
       { id, sandboxId, kind, target, params, requestKey, source,
         status:'pending'|'ok'|'failed'|'cancelled', attempt,
         createdAt, updatedAt, receiptAt, resultRef, error, receipt }
       ⚠️ status:'ok' 只能在拿到真实 eventId 之后写 —— 见 action.js 头六条规矩 */
    actionRequests: [],

    /* 群声 · 公共论坛（施工卡-群声-v1 Batch A，forum-core.js）：
       13 张表全部按岛 scoped（tagScope 盖章 + cleanupSandbox 删房清）。
       Batch A 只落键与上下文解析；账号 / 板块 / 帖子的服务入口是 Batch B。
       两个 BySandbox 映射键按 sandboxId 切，不在 scoped 名单里，
       删房走「带 sbId 的键」那条路（同 widgetCfg）。 */
    forumAccounts: [],          /* 论坛账号 { id, sandboxId, ownerEntityId, ownerType, accountType, displayName, handle, avatarRef, bio, status, createdAt, updatedAt } */
    forumBoards: [],            /* 板块实例（模板跨岛复用，实例带 sandboxId） */
    forumPosts: [],             /* 帖子 { id, sandboxId, boardId, authorAccountId, authorDisplayMode, anonymousAlias, postType, title, content, visibility, allowRepost, sourceType, sourceId, sourceRef, assetRefs, placeText, status, createdAt, updatedAt } */
    forumComments: [],          /* 回复树 { id, sandboxId, postId, parentId, rootCommentId, authorAccountId, isPostAuthor, content, status, createdAt, updatedAt } */
    forumReposts: [],           /* 公开转帖（只引用 sourcePostId，不复制原帖） */
    forumFollows: [],           /* 关注（账号 / 板块） */
    forumLikes: [],             /* 同感（界面文案「同感」，数据层 likes） */
    forumCollections: [],       /* 收藏（默认私有） */
    forumNotifications: [],     /* 论坛通知（持久化，不碰 msgcenter 的内存层） */
    forumShares: [],            /* 定向分享记录（单聊 / 群聊 / 朋友圈） */
    forumShareReceipts: [],     /* 分享回执（送达 / 打开 / 已回应，只存状态不存正文） */
    forumDrafts: [],            /* 草稿箱 */
    forumKnowledge: [],         /* 论坛认知（观察者 × 公开身份，五档状态） */
    forumSettingsBySandbox: {},          /* { [sandboxId]: 设置 } */
    selectedForumAccountBySandbox: {},   /* { [sandboxId]: 当前论坛身份 } 切岛独立恢复 */
    forumAnonPoolMigrated: {},           /* { [sandboxId]: 匿名池迁移标记 } v218 一次性 */

    /* 以身入局（book-core.js / 施工卡-以身入局-P0）：
       档案盒 / 任务运行按岛章隔离（tagScope），删房跟着清；
       身份与设置是按 sbId 切的映射键，走 core.js 映射键清理那条路。 */
    bookBoxes: [],                       /* 档案盒 { id, sandboxId, title, source, status, stamp, coverRef, note, updatedAt } */
    bookImports: [],                     /* TXT 导入原文+章节（v219，与盒 importId 绑定，随岛走） */
    bookRuns: [],                        /* 任务运行 { id, sandboxId, boxId, identity, status, logs, volume, startedAt, endedAt } */
    bookSettingsBySandbox: {},           /* { [sandboxId]: { identity, seededAt } } */

    /* 名片夹（树状）：见文件头 1) */
    characters: [],

    /* User 侧马甲：见文件头 2) */
    userMasks: [],

    /* 通讯录关系：见文件头 3) */
    links: [],

    /* 记忆（全量 + 四元组标签）：见文件头 4) */
    memories: [],

    /* 4 屏网格桌面：见文件头 5) */
    desktop: null,

    /* 掉马事件：见文件头 7) */
    dropEvents: [],

    /* 手账本 */
    diaries: [],

    /* B 模块 世界书（两级）：worldbooks = [{ id, name, scope, characterId,
       createdAt, updatedAt, entries: [{ id, name, keys, content, enabled, ... }] }]
       scope: 'global' 全局 | 'personal' 个人（挂 characterId 指向的角色）。
       旧的平铺 worldbook 键由 migrateWorldbookToBooks 搬进来，旧键保留。 */
    worldbooks: [],

    /* 世界书改成两级结构之前平铺条目的旧键，只用于迁移，不再直接读写 */
    worldbook: [],

    /* 主 API 可存多套预设，切换＝换 mainApiId 指向的那套。
       mainApi 键保留：它始终镜像「当前使用」的配置，api.js 只读它，
       这样候选逻辑不用动。 */
    mainApis: [],
    mainApiId: null,

    /* 总结 API 也存多套预设（2026-09-23 对齐主 API）：summaryApi 这个老键保留，
       始终镜像「当前使用」的那套，cfgOf / page-summary / page-settings 只读镜像。
       ⚠️ 向量记忆**没有这一层** —— 它要 embedding 模型、副 API 是对话模型，
       复制和多套都没有意义（用户 2026-09-23 明确），它还是单个 vectorApi。 */
    summaryApis: [],
    summaryApiId: null,

    /* 副 API 每组重试次数（1~5） */
    subRetry: 2,

    /* 系统级切号：当前选中的角色（大号）与当前使用的 User 马甲。
       时空切换器改的就是这两个值 —— 整个 OS 的视觉氛围和数据随之切换。 */
    activeCharId: null,
    activeUserId: null
  };

  /* ---------------------------- 工具 ---------------------------- */

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (isObj(v)) {
      var out = {};
      for (var k in v) if (has(v, k)) out[k] = clone(v[k]);
      return out;
    }
    return v;
  }

  /* 深合并：base 当骨架，patch 覆盖。
     这样升级版本加了新字段，用户旧存档也能自动拿到默认值。 */
  function merge(base, patch) {
    if (!isObj(base) || !isObj(patch)) return clone(patch === undefined ? base : patch);
    var out = clone(base);
    for (var k in patch) {
      if (!has(patch, k)) continue;
      out[k] = isObj(out[k]) ? merge(out[k], patch[k]) : clone(patch[k]);
    }
    return out;
  }

  /* ---------------------------- 状态 ---------------------------- */

  var cache = {};
  var listeners = [];
  var lastError = null;

  /* 兼容早期版本的坏存档。
     旧版 set() 对单段路径写成了 cache[top][top] = value，
     于是 chats 被存成 { chats: [...] }。这里读的时候解一层，
     免得老用户升上来以后「聊天记录全没了」。 */
  function unwrapSelf(top, val) {
    if (!has(DEFAULTS, top)) return val;
    if (!isObj(val)) return val;
    if (!has(val, top)) return val;
    return val[top];
  }

  function load(top) {
    if (has(cache, top)) return cache[top];
    var base = has(DEFAULTS, top) ? clone(DEFAULTS[top]) : null;
    var val = base;
    try {
      var raw = global.localStorage.getItem(NS + top);
      if (raw !== null && raw !== undefined) {
        var parsed = unwrapSelf(top, JSON.parse(raw));
        val = base !== null ? merge(base, parsed) : parsed;
      }
    } catch (e) {
      lastError = {
        type: 'read',
        key: top,
        message: (e && e.message) ? e.message : String(e)
      };
    }
    cache[top] = val;
    return val;
  }

  function persist(top) {
    try {
      global.localStorage.setItem(NS + top, JSON.stringify(cache[top]));
      return true;
    } catch (e) {
      lastError = {
        type: 'write',
        key: top,
        message: (e && e.name === 'QuotaExceededError')
          ? '本地存储空间已满，请先导出备份再清理数据'
          : ((e && e.message) ? e.message : String(e))
      };
      return false;
    }
  }

  function notify(path, ok) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](path, ok); } catch (e) { /* 单个监听器炸了不影响其他 */ }
    }
  }

  /* ---------------------------- 读写 ---------------------------- */

  function get(path, fallback) {
    var parts = String(path).split('.');
    var cur = load(parts[0]);
    for (var i = 1; i < parts.length; i++) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[parts[i]];
    }
    if (cur === undefined) return fallback;
    return clone(cur);
  }

  function set(path, value) {
    var parts = String(path).split('.');
    var top = parts[0];
    load(top);

    /* 单段路径 = 整体替换。老写法会把值塞进 cache[top][top]，
       存出 { chats: [...] } 这种套娃结构，读回来就不是数组了。 */
    if (parts.length === 1) {
      cache[top] = clone(value);
    } else {
      if (!isObj(cache[top])) cache[top] = {};
      var cur = cache[top];
      for (var i = 1; i < parts.length - 1; i++) {
        if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = clone(value);
    }

    var ok = persist(top);
    notify(path, ok);
    return ok;
  }

  /* 批量写：只落一次盘、只通知一次，避免表单保存时连环触发渲染 */
  function setMany(pairs) {    var touched = {};
    var keys = [];
    var i;

    for (i = 0; i < pairs.length; i++) {
      var parts = String(pairs[i][0]).split('.');
      var top = parts[0];
      load(top);

      if (parts.length === 1) {
        cache[top] = clone(pairs[i][1]);
      } else {
        if (!isObj(cache[top])) cache[top] = {};
        var cur = cache[top];
        for (var j = 1; j < parts.length - 1; j++) {
          if (!isObj(cur[parts[j]])) cur[parts[j]] = {};
          cur = cur[parts[j]];
        }
        cur[parts[parts.length - 1]] = clone(pairs[i][1]);
      }

      if (!touched[top]) { touched[top] = true; keys.push(top); }
    }

    var ok = true;
    for (i = 0; i < keys.length; i++) {
      if (!persist(keys[i])) ok = false;
    }
    notify('*', ok);
    return ok;
  }

  /* 整键删除。给「按房动态拼出来」的键用（charRel:<sbId> 这种没登记进
     DEFAULTS 的），删房时把键整个摘掉 —— set 一个 null 只会占着位，
     还会进 exportAll 的兜底扫描。键不存在时是安静的无操作。 */
  function remove(top) {
    delete cache[top];
    var ok = true;
    try {
      global.localStorage.removeItem(NS + top);
    } catch (e) {
      ok = false;
      lastError = {
        type: 'remove',
        key: top,
        message: (e && e.message) ? e.message : String(e)
      };
    }
    notify(top, ok);
    return ok;
  }

  /* ---------------------- 导出 / 导入 / 清理 ---------------------- */

  /* ---- 过程数据 vs 正式用户数据（2026-09-23 用户口径）----
     过程数据 = **不属于用户正式存档**的中间产物：
       · 迁移备份 charMemBackup:*（里面是迁移前的记忆原文）
       · 迁移事务状态 charMemMigrationState
       · 索引回滚进度 vecCursor* / vecFail:* / vecEpoch
     它们只在当前设备、只在一次操作的窗口里活着：
       · **用户导出**（备份文件）不带它们 —— 备份只装正式数据，
         换设备导入也不该把旧的迁移/恢复过程带回新设备；
       · **内部回滚快照**（导入失败回滚用）**必须**带上它们 ——
         不然回滚完存档回来了、进度的账却对不上；
       · **用户导入**忽略它们 —— 本机的迁移事务状态只由本机的迁移流程管，
         旧备份不能把它带回来、更不能覆盖掉。（sleepy.rb.* 不在 store 的
         命名空间里，本来就进不了导出，也不需要在这里排除。） */
  var PROCESS_KEYS = ['charMemMigrationState', 'vecEpoch'];
  var PROCESS_PREFIXES = ['charMemBackup:', 'vecCursor', 'vecFail:'];

  /* ---- 设备本地键（2026-10-07 协议同意标记带出来的）----
     「这台设备上发生过什么」：协议同意标记 legalAgreedAt 属于这一类。
     它**跟着设备走，不跟着存档走** —— 所以两个方向都不带：
       · 用户导出不带 → 换设备导入后**该弹的协议会重新弹**，
         而不是带着上一台设备的「我已知情」直接进桌面；
       · 内部回滚快照也不带 → 一次导入失败回滚不该把同意状态倒回去，
         用户会莫名再被弹一次。
     和过程数据的区别：过程数据**要**进内部快照（回滚时必须恢复），
     同意标记是两个方向都不进，所以单列判据，不塞进 isProcessKey ——
     混进去会让「回滚要恢复过程数据」这套口径失效。 */
  var DEVICE_LOCAL_KEYS = ['legalAgreedAt'];

  function isDeviceLocalKey(top) {
    return DEVICE_LOCAL_KEYS.indexOf(top) >= 0;
  }

  function isProcessKey(top) {
    if (PROCESS_KEYS.indexOf(top) >= 0) return true;
    for (var i = 0; i < PROCESS_PREFIXES.length; i++) {
      if (String(top).indexOf(PROCESS_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /* scope：'user'（默认，给用户备份）| 'internal-snapshot'（给导入失败回滚） */
  function exportAll(opts) {
    var scope = (opts && opts.scope) || 'user';
    var withProcess = scope === 'internal-snapshot';
    var out = {
      app: 'sleepy',
      schema: SCHEMA,
      scope: scope,
      exportedAt: new Date().toISOString(),
      data: {}
    };
    var top;
    for (top in DEFAULTS) {
      if (!has(DEFAULTS, top)) continue;
      if (!withProcess && isProcessKey(top)) continue;
      if (isDeviceLocalKey(top)) continue;         /* 设备本地状态不进任何快照 */
      out.data[top] = clone(load(top));
    }

    /* 兜底：把带 NS 前缀、但**没登记进 DEFAULTS** 的键也带上。
       早先只遍历 DEFAULTS，于是 photos / todos 这类后加的键根本进不了
       备份 —— 用户换个设备导入，照片和待办就凭空消失，而且全程不报错
       （QuotaExceededError 也不会响，因为压根没写）。
       这两个键是刻意不登记进 DEFAULTS 的（见上面的注释），
       所以堵漏点只能在这里。以后新增键忘了登记也不会再丢数据。 */
    try {
      var ls = global.localStorage;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(NS) !== 0) continue;
        var key = k.slice(NS.length);
        if (!key || has(out.data, key)) continue;
        if (!withProcess && isProcessKey(key)) continue;   /* 过程数据不进用户备份 */
        if (isDeviceLocalKey(key)) continue;              /* 同意标记等：两个方向都不进 */
        out.data[key] = clone(load(key));
      }
    } catch (e) {
      lastError = { type: 'export', key: null, message: (e && e.message) || String(e) };
    }

    return out;
  }

  /* 两个具名包装：让调用点一眼看得出拿的是哪一种，不用去记 scope 的字符串 */
  function exportUserData() { return exportAll({ scope: 'user' }); }
  function exportInternalSnapshot() { return exportAll({ scope: 'internal-snapshot' }); }

  /* 只认自己导出的结构。
     注意：这里是 .json 备份文件，和 D8「禁止导入角色卡 json / 酒馆格式」
     不是一回事——D8 禁的是外部角色卡格式，这是用户自己的全量存档。
     canImport 与 importAll 用同一份规则：导入前要先「只校验、不写入」
     （清空向量库之前必须先确认这个备份是能用的，否则会清完了才发现导不进去）。 */
  function canImport(payload) {
    if (!isObj(payload) || payload.app !== 'sleepy' || !isObj(payload.data)) {
      return { ok: false, message: '这不是 Sleepy 的备份文件' };
    }
    /* schema 1 的旧存档照样收：下面的 merge 会把新字段补齐。
       只在「比当前版本更新」时才拒绝。 */
    if (payload.schema > SCHEMA) {
      return { ok: false, message: '备份版本比当前版本新（schema ' + payload.schema + '）' };
    }
    return { ok: true };
  }

  function importAll(payload) {
    var v = canImport(payload);
    if (!v.ok) return v;

    var written = [];
    var skipped = [];
    for (var top in payload.data) {
      if (!has(payload.data, top)) continue;
      /* 用户备份只能写**正式用户数据**：过程数据一律忽略 ——
         本机的迁移事务状态只由本机的迁移流程管，旧备份不能把它带回来、
         更不能覆盖掉当前正在跑的那个事务。（用户口径 2026-09-23） */
      if (isProcessKey(top)) { skipped.push(top); continue; }
      /* 设备本地状态同理：旧设备导出的备份里可能有同意标记，
         但**新设备的同意状态必须由这台设备自己重新决定** ——
         带过来会让「该弹的协议」不弹。 */
      if (isDeviceLocalKey(top)) { skipped.push(top); continue; }
      var base = has(DEFAULTS, top) ? clone(DEFAULTS[top]) : null;
      var incoming = unwrapSelf(top, payload.data[top]);
      cache[top] = base !== null ? merge(base, incoming) : clone(incoming);
      if (persist(top)) written.push(top);
    }
    notify('*', true);
    return { ok: true, keys: written, skipped: skipped };
  }

  /* 2.6 存档体积：按 UTF-16 估算，键名也算进去 */
  function usage() {
    var bytes = 0;
    var keys = 0;
    try {
      var ls = global.localStorage;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(NS) === 0) {
          keys++;
          bytes += (k.length + (ls.getItem(k) || '').length) * 2;
        }
      }
    } catch (e) {
      lastError = { type: 'usage', key: null, message: (e && e.message) || String(e) };
    }
    return { keys: keys, bytes: bytes };
  }

  function clearAll() {
    try {
      var ls = global.localStorage;
      var doomed = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(NS) === 0) doomed.push(k);
      }
      for (var j = 0; j < doomed.length; j++) ls.removeItem(doomed[j]);
    } catch (e) {
      lastError = { type: 'clear', key: null, message: (e && e.message) || String(e) };
    }
    cache = {};
    notify('*', true);
    return true;
  }

  /* 只清**正式用户数据**（过程数据留着）—— 给「用户备份导入」的覆盖语义用。
     为什么不能用 clearAll：导入一份用户备份不该把本机正在跑的
     迁移 / 恢复事务状态也一起抹掉（那些由各自的流程自己管，见 isProcessKey）。
     清空全部数据仍然走 clearAll（那才是「清空一切」，含过程数据）。 */
  function clearUserData() {
    var cleared = [];
    try {
      var ls = global.localStorage;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(NS) !== 0) continue;
        var top = k.slice(NS.length);
        if (isProcessKey(top)) continue;          /* 过程数据留着 */
        cleared.push(top);
      }
      for (var j = 0; j < cleared.length; j++) {
        delete cache[cleared[j]];
        ls.removeItem(NS + cleared[j]);
      }
    } catch (e) {
      lastError = { type: 'clear', key: null, message: (e && e.message) || String(e) };
      return { ok: false, cleared: cleared.length, message: (e && e.message) || String(e) };
    }
    notify('*', true);
    return { ok: true, cleared: cleared.length };
  }

  /* ---------------------------- 对外 ---------------------------- */

  function ensureInstalled() {
    load('meta');
    if (!cache.meta.installedAt) {
      cache.meta.installedAt = Date.now();
      persist('meta');
    }
    cache.meta.lastOpenAt = Date.now();
    persist('meta');
  }

  /* 世界书改成两级结构（书 → 条目）之前，条目是平铺在 worldbook 键里的。
     平铺的老数据整包搬进一本「默认世界书」（全局），旧键保留不删。 */
  function migrateWorldbookToBooks() {
    try {
      if (global.localStorage.getItem(NS + 'worldbooks')) return;
      var raw = global.localStorage.getItem(NS + 'worldbook');
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list) || !list.length) return;
      var book = {
        id: 'wbmig' + Date.now().toString(36),
        name: '默认世界书',
        scope: 'global',
        characterId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entries: list
      };
      global.localStorage.setItem(NS + 'worldbooks', JSON.stringify([book]));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把 ' + list.length + ' 个旧条目迁进「默认世界书」');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 */
    }
  }

  /* 主 API 改成多预设之前只有单个 mainApi。老配置整包变成第一套预设
     并设为当前使用，mainApi 键继续镜像当前配置，api.js 无感。 */
  function migrateMainApiPresets() {
    try {
      if (global.localStorage.getItem(NS + 'mainApis')) return;
      var raw = global.localStorage.getItem(NS + 'mainApi');
      if (!raw) return;
      var cfg = JSON.parse(raw);
      if (!cfg || !cfg.baseUrl || !cfg.model) return;
      var id = 'map' + Date.now().toString(36);
      var list = [{
        id: id,
        name: cfg.name || '主模型',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        contextMessages: cfg.contextMessages,
        timeoutSec: cfg.timeoutSec,
        stream: cfg.stream,
        enabled: cfg.enabled
      }];
      global.localStorage.setItem(NS + 'mainApis', JSON.stringify(list));
      global.localStorage.setItem(NS + 'mainApiId', JSON.stringify(id));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把原主 API 存为第一套预设');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 */
    }
  }

  /* 总结改成多预设之前，它只有单个对象（summaryApi）。
     老配置整包变成第一套预设并设为当前，镜像键继续镜像当前配置，cfgOf 无感。
     （向量不走多预设，所以不在这里。） */
  function migrateSummaryApiPresets() {
    try {
      if (global.localStorage.getItem(NS + 'summaryApis')) return;
      var raw = global.localStorage.getItem(NS + 'summaryApi');
      if (!raw) return;
      var cfg = JSON.parse(raw);
      if (!cfg || (!cfg.baseUrl && !cfg.model)) return;
      var id = 'summig1';
      var list = [{
        id: id,
        name: cfg.name || '总结模型',
        baseUrl: cfg.baseUrl || '',
        apiKey: cfg.apiKey || '',
        model: cfg.model || '',
        seededFrom: cfg.seededFrom || ''
      }];
      global.localStorage.setItem(NS + 'summaryApis', JSON.stringify(list));
      global.localStorage.setItem(NS + 'summaryApiId', JSON.stringify(id));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把原总结 API 存为第一套预设');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 */
    }
  }

  /* ---- 生成参数默认值「只留一份」 ----
     温度 / 单次上限 / 上下文条数 / 流式这几个生成参数，以前在 chatDefaults 里
     也抄了一份默认值，和 api.js 的 GEN_DEFAULTS 重复。两份重复时以 chatDefaults
     为准（它在 genParams 回落的第三层），于是「改默认值」会静默失效 ——
     2026-09-22 真机踩到：api.js 改成 40，实际请求还是 20。

     现在生成参数只认 api.js 那份。这里把老存档里**正好等于旧默认**的键删掉，
     让它们回落到新默认；用户真改过的值一律留着。
     只有 contextMessages 的默认变了（20 → 40），其余几项新旧相同、删了行为不变。 */
  var GEN_OLD_DEFAULT = {
    temperature: 0.85, maxTokens: 1024, contextMessages: 20, stream: true
  };

  function migrateChatDefaultsGenerative() {
    try {
      var raw = global.localStorage.getItem(NS + 'chatDefaults');
      if (!raw) return;                       /* 还没有这份存档（新用户）→ 不用管 */
      var cfg = JSON.parse(raw);
      if (!isObj(cfg)) return;
      var changed = false;
      for (var k in GEN_OLD_DEFAULT) {
        if (!has(GEN_OLD_DEFAULT, k)) continue;
        if (cfg[k] !== GEN_OLD_DEFAULT[k]) continue;   /* 没这个键、或用户改过 → 留着 */
        delete cfg[k];
        changed = true;
      }
      if (!changed) return;
      global.localStorage.setItem(NS + 'chatDefaults', JSON.stringify(cfg));
      delete cache.chatDefaults;              /* 缓存里那份是旧的，扔掉重读 */
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 生成参数已回落到内置默认（上下文条数 20 → 40）');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 —— 那就继续用老值 */
    }
  }

  /* A5 时期的「人设预设库」存在 presets 键里。后来归位到名片夹，改叫 characters。
     老存档不能丢：新键还没有数据、旧键有数据时，搬一次过去。
     旧键保留不删 —— 万一要回退到旧版本，还能找到东西。 */
  function migrateKeys() {
    try {
      if (global.localStorage.getItem(NS + 'characters')) return;
      var raw = global.localStorage.getItem(NS + 'presets');
      if (!raw) return;
      var list = JSON.parse(raw);
      /* 老存档还有过「套娃」形态：{ presets: [...] } */
      if (isObj(list) && has(list, 'presets')) list = list.presets;
      if (!Array.isArray(list) || !list.length) return;
      global.localStorage.setItem(NS + 'characters', JSON.stringify(list));
      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 已把 ' + list.length + ' 个旧预设迁到名片夹');
      }
    } catch (e) {
      /* 迁移失败不能挡住启动，用户下次打开还会再试一遍 */
    }
  }

  /* ---- 扁平 characters → 树状 characters ----
     树状模型上线之前，名片夹是一个扁平数组，每条只有 {id,name,content}。
     现在要区分大号 / 皮套 / NPC，所以给老数据补 kind:'main'、parentId:null ——
     它们就是当年的「核心大角色」，这么补语义是对的。
     同时给 User 侧造一件默认马甲，并把老对话挂上去，否则
     对话会因为找不到 userId 而在筛选时凭空消失。 */
  function migrateCharactersToTree() {
    var touched = false;
    try {
      var raw = global.localStorage.getItem(NS + 'characters');
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return;

      list.forEach(function (c) {
        if (!c || typeof c !== 'object') return;
        if (!c.kind) { c.kind = 'main'; touched = true; }
        if (c.parentId === undefined) { c.parentId = null; touched = true; }
        if (c.boundUserId === undefined) { c.boundUserId = null; touched = true; }
      });

      if (touched) {
        global.localStorage.setItem(NS + 'characters', JSON.stringify(list));
      }

      /* 老对话没有 userId：造一件「我」当默认马甲，全部挂上去 */
      var hasUserMasks = global.localStorage.getItem(NS + 'userMasks');
      if (!hasUserMasks) {
        var maskId = 'um' + Date.now().toString(36);
        var mask = {
          id: maskId,
          name: '我',
          avatar: '',
          persona: '',
          isDefault: true,
          createdAt: Date.now()
        };
        global.localStorage.setItem(NS + 'userMasks', JSON.stringify([mask]));

        var rawChats = global.localStorage.getItem(NS + 'chats');
        if (rawChats) {
          var chats = JSON.parse(rawChats);
          if (isObj(chats) && has(chats, 'chats')) chats = chats.chats;
          if (Array.isArray(chats) && chats.length) {
            chats.forEach(function (ct) {
              if (ct && !ct.userId) ct.userId = maskId;
            });
            global.localStorage.setItem(NS + 'chats', JSON.stringify(chats));
          }
        }
        if (global.console && global.console.log) {
          global.console.log('[Sleepy] 已为老存档补一件默认 User 马甲「我」');
        }
      }
    } catch (e) {
      /* 迁移失败不能挡住启动 */
    }
  }

  /* --------------- 《沙盒宇宙》：老全局数据 → 默认存档 ---------------

     迁移之前 chats / memories / links / photos / diaries / todos / favorites /
     userMasks / desktop 全是**全局一份**，「进入某间房」只换皮肤不换数据 ——
     两个存档的数据其实是串的。现在要按房切开，所以先把现有内容整个塞进
     一间自动生成的「默认存档」，再给每条记录打上 sandboxId。
     （打标签本身不改行为，真正按它过滤在 S4。）

     三条纪律，一条都不能省：
     1. **只在还没有 sandboxes 键时跑一次**，跑过就永久跳过（幂等）
     2. **没有任何老内容就不建** —— 全新安装应该让用户自己从浮岛建第一间房，
        而不是一打开就发现多了一间他没建过的
     3. **只打标签，不删不改任何既有字段**。回退到旧版本照样能读

     房型：大号 >= 2 个 → 群岛，否则孤岛。
     成员只收大号（kind='main'）；皮套和 NPC 不进 charIds
     —— 它们是「挂在房里那个大号名下」的，不是房的成员（决策 3）。
     角色记录（大号含内）一律打上 sandboxId：大号也按岛（2026-09-21 拍板）。
  */
  function migrateToSandbox() {
    try {
      if (global.localStorage.getItem(NS + 'sandboxes')) return null;

      var chars = get('characters');
      if (!Array.isArray(chars)) chars = [];

      /* 「有老内容」的判据：角色 / 对话 / 记忆 / 照片 / 日记 / 待办 任一非空。
         **故意不看 userMasks** —— migrateCharactersToTree 在全新安装时也会
         造一件「我」，拿它当判据会让新用户凭空多出一间房。 */
      var hasBiz = ['chats', 'memories', 'photos', 'diaries', 'todos'].some(function (k) {
        var v = get(k);
        return Array.isArray(v) && v.length > 0;
      });
      if (!chars.length && !hasBiz) return null;

      var users = get('userMasks');
      if (!Array.isArray(users)) users = [];

      var sb = {
        id: 'sbmig' + Date.now().toString(36),
        kind: chars.filter(function (c) { return (c.kind || 'main') === 'main'; }).length >= 2
          ? 'archipelago' : 'isle',
        name: '默认存档',
        cover: '',
        charIds: chars.filter(function (c) {
          return (c.kind || 'main') === 'main';
        }).map(function (c) { return c.id; }),
        maskIds: users.map(function (u) { return u.id; }),
        /* 每岛外观/户型的权威挂点是 appearance.desktop.islands[sbId] 与
           desktop.islands[sbId]（岛覆盖叠全局），**不**在 sandbox 记录上 ——
           以前这里预留的 theme/deskVersion/pages 三个口子没人读，已收编删除。 */
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      var touched = [];

      /* 业务数据：整条打上沙盒标签。
         注意这里走的是 store 的 get/set（而不是裸 localStorage）——
         这样缓存跟着更新，迁移之后立刻读到的是打过标签的数据。 */
      ['chats', 'memories', 'links', 'photos', 'diaries', 'todos', 'favorites', 'userMasks']
        .forEach(function (key) {
          var list = get(key);
          if (!Array.isArray(list) || !list.length) return;
          var changed = 0;
          list.forEach(function (r) {
            if (r && typeof r === 'object' && !r.sandboxId) { r.sandboxId = sb.id; changed++; }
          });
          if (!changed) return;
          set(key, list);
          touched.push(key + ' ' + changed);
        });

      /* 角色树：大号、皮套、NPC 全部挂到房里（2026-09-21 拍板：大号按岛，
         没有全局大号 —— 老存档收编时一起打章，跟新 semantics 一致）。 */
      var stamped = 0;
      chars.forEach(function (c) {
        if (!c.sandboxId) { c.sandboxId = sb.id; stamped++; }
      });
      if (stamped) {
        set('characters', chars);
        touched.push('characters ' + stamped);
      }

      set('sandboxes', [sb]);
      set('activeSandboxId', sb.id);

      if (global.console && global.console.log) {
        global.console.log('[Sleepy] 《沙盒宇宙》迁移完成：' + sb.name +
          '（' + (sb.kind === 'archipelago' ? '群岛 1vN' : '孤岛 1v1') + '）· 成员 ' +
          sb.charIds.length + ' 个 · ' + (touched.length ? touched.join('，') : '无业务数据'));
      }
      return sb;
    } catch (e) {
      /* 迁移失败不能挡住启动，用户下次打开还会再试一遍 */
      return null;
    }
  }

  /* 顺序有意如此：先搬旧键，再初始化 meta（函数声明有提升，放这里没问题） */
  migrateKeys();
  migrateWorldbookToBooks();
  migrateMainApiPresets();
  migrateSummaryApiPresets();
  migrateChatDefaultsGenerative();
  migrateCharactersToTree();
  /* 必须排在 migrateCharactersToTree 之后：它可能会补一件默认 User 马甲，
     沙盒的 maskIds 要把那件一起收进来 */
  migrateToSandbox();
  ensureInstalled();

  Sleepy.store = {
    NS: NS,
    SCHEMA: SCHEMA,
    defaults: function () { return clone(DEFAULTS); },
    get: get,
    set: set,
    setMany: setMany,
    remove: remove,
    exportAll: exportAll,
    /* 两种导出作用域（见 isProcessKey 的注释）：
         exportUserData()         用户备份 —— 排除迁移/恢复/索引过程数据
         exportInternalSnapshot() 内部回滚快照 —— 必须带上过程数据 */
    exportUserData: exportUserData,
    exportInternalSnapshot: exportInternalSnapshot,
    isProcessKey: isProcessKey,
    importAll: importAll,
    /* 只校验不写入 —— 导入流程第一步用它（见 canImport 的注释） */
    canImport: canImport,
    usage: usage,
    clearAll: clearAll,
    /* 只清正式用户数据（导入覆盖用）—— 过程数据留给各自的流程管 */
    clearUserData: clearUserData,
    /* 只为测试与排障暴露：正常路径由本文件加载时自动跑一次。
       它是幂等的（已经迁过就直接返回 null），重复调用不会重复建房。 */
    migrateToSandbox: migrateToSandbox,
    lastError: function () { return lastError; },
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }
  };

})(window);
