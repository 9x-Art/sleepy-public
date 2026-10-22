/* ============================================================
   core-group.js — 线上群聊数据层（纯函数，无 UI）
   依赖：store.js、core.js（scoped/tagScope 作用域纪律）
   被依赖：page-group.js、以后的群调度引擎

   《线上群聊系统 · 实施总纲》第 3 节的领域模型，适配到 Sleepy 的
   存储层之后长这样（字段名做了归一，不照抄总纲的 TS 名）：

   ---- 本体（Entity）和账号（Account）在 Sleepy 里各是什么 ----
     char 本体 = rootOf() 的大号；账号 = 大号自己或它名下的皮套。
       同一大号的多个皮套同时进群 = 同一本体的多个账号（共享意识）。
     user 本体 = 「我」这个人（全存档唯一）；账号 = 每一件马甲。
     NPC 本体 = 它自己（kind='npc' 的角色记录就是本体）；只有
       「拥有线上账号的 NPC」能进群 —— 它的账号就是它自己。

   ---- 三张表，全部按房（sandboxId）切 ----
     groups        群：名字、头像模式、群主账号、群设置
     groupMembers  群成员：**按账号记录**（成员计数按账号展示，
                   不能按本体折叠 —— 折叠等于在 UI 上泄露马甲关联）
     groupMessages 群消息：每条同时带本体 id（内部认知/调度用）
                   和账号 id（公开展示用）

   ---- 为什么消息不挂在群记录上（跟私聊 chat.messages 不一样）----
     群消息是调度引擎、延迟补回、认知结算三方都要扫的数据，
     埋在群里每次都要整群取出来再塞回去；单列一张表才能
     按 groupId 过滤、按 createdAt 排序，mutate 粒度也细。

   ---- 撤回的存法（总纲 6.5）----
     撤回**不删原文**：msg.recalledAt 打上时间戳，原文留在库里
     （延迟补回、认知结算还要看「撤回前谁读到了什么」），
     公开时间线的渲染方看到 recalledAt 就只显示「撤回了一条消息」。
     谁还记得原文是 MessageReceipt 的事（轮 5），不归这张表。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  function newId(p) { return core.newId(p || 'gp'); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  /* 三个键的读写全走「全量数组 + scoped 过滤读 + 整表落盘写」。
     跟 chats 一个纪律：set 一个 scoped 过滤过的结果 = 别的房的群被整批抹掉。 */
  function allGroups() { return arr(store.get('groups')); }
  function allMembers() { return arr(store.get('groupMembers')); }
  function allMessages() { return arr(store.get('groupMessages')); }

  /* ---------------------------- 群 ---------------------------- */

  /* 当前房里的群。老数据没有 sandboxId（迁移前）原样返回。 */
  function listGroups() {
    var sid = core.scopeId();
    var list = allGroups();
    if (!sid) return list;
    return list.filter(function (g) { return g && g.sandboxId === sid; });
  }

  function findGroup(id) {
    if (!id) return null;
    var list = allGroups();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  var DEFAULT_SETTINGS = {
    /* opening: 'natural' 自然开场 / 'user' 等我先说（轮 4 的调度读它） */
    opening: 'natural',
    /* 自动续聊三档（轮 5）：off / light(1~2 波) / active(3~4 波) */
    rhythm: 'light',
    /* 允许群聊触发私聊 / 成员自然发起话题 / 跨频道状态余波（轮 6） */
    privateFollow: true,
    naturalTopic: true,
    crossChannel: true,
    /* 只影响 user 侧提醒，不改变角色行为（Demo 3 原文） */
    mute: false
  };

  function saveGroups(list) { return store.set('groups', list); }

  /* 建群。
     opts = { name, ownerAccountId, members: [{kind, ownerId, accountId}], opening }
       ownerAccountId  创建者的 user 马甲 id（群主）；
       members         勾选的账号清单，user 自己的其他马甲也算成员。
     校验：名字非空、至少一个非 user 账号（全是马甲的群没有意义）、
     账号不重复。通过 'contact-group' 老投影群的规则：第一版不经过
     接受/拒绝审批 —— 保护 user 的导演权（总纲 4.2）。 */
  function createGroup(opts) {
    opts = opts || {};
    var name = String(opts.name || '').trim();
    if (!name) return { ok: false, message: '群聊名称不能为空' };
    if (!core.scopeId()) return { ok: false, message: '还没有进任何一间房' };

    var specs = arr(opts.members).filter(function (m) {
      return m && m.accountId;
    });

    var hasOther = false;
    var seen = {};
    for (var i = 0; i < specs.length; i++) {
      if (seen[specs[i].accountId]) return { ok: false, message: '有账号被选了两次' };
      seen[specs[i].accountId] = true;
      if (specs[i].kind !== 'user') hasOther = true;
    }
    if (!hasOther) return { ok: false, message: '至少要有一个角色或 NPC 账号' };

    var g = {
      id: newId('grp'),
      name: name,
      avatarMode: 'collage',
      avatar: '',
      /* 本地头像走图库（IndexedDB），这里只存 mediaId —— 群记录在 localStorage，
         塞 base64 会把整个存档撑向 5MB 配额。avatar 字段只留给 http 链接。 */
      avatarMedia: '',
      ownerAccountId: opts.ownerAccountId || null,
      settings: Object.assign({}, DEFAULT_SETTINGS,
        opts.opening ? { opening: opts.opening } : null),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    core.tagScope(g);
    var groups = allGroups();
    groups.unshift(g);
    saveGroups(groups);

    /* 成员：创建者自己排第一（role=owner），勾选的账号跟在后面。
       user 本体 id 恒为 'user'（本体只有一个「我」）；char 本体 = rootId；
       NPC 本体 = 它自己的 id。 */
    var members = allMembers();
    var ownerKind = 'user';
    var ownerOwner = 'user';
    var ownerRec = {
      id: newId('gm'),
      groupId: g.id,
      kind: ownerKind,
      ownerId: ownerOwner,
      accountId: g.ownerAccountId,
      role: 'owner',
      status: 'active',
      joinedAt: Date.now(),
      nickname: ''
    };
    core.tagScope(ownerRec);
    members.push(ownerRec);
    specs.forEach(function (m) {
      var owner = m.ownerId || (m.kind === 'char' ? core.rootIdOf(m.accountId) : m.accountId);
      var rec = {
        id: newId('gm'),
        groupId: g.id,
        kind: m.kind,
        ownerId: owner,
        accountId: m.accountId,
        role: 'member',
        status: 'active',
        joinedAt: Date.now(),
        nickname: ''
      };
      core.tagScope(rec);
      members.push(rec);
    });
    store.set('groupMembers', members);

    systemMessage(g.id, name + ' 群聊已创建');
    return { ok: true, group: g };
  }

  /* 改群资料 / 设置。patch 只接受白名单字段 ——
     settings 整体替换会导致并发写互相覆盖，所以分开收。 */
  /* lastUserId：user 在这个群里最后一次用的发言账号（＋面板切身份后记住） */
  /* beautifyCss：群聊美化（2026-10-05）—— 用户自定义 CSS，进群聊页时注入。
     跟着群记录走，导出 / 换岛备份天然带上；走白名单防止并发写互相覆盖。 */
  var GROUP_FIELDS = ['name', 'avatarMode', 'avatar', 'avatarMedia', 'ownerAccountId', 'lastUserId', 'beautifyCss'];
  var SETTINGS_FIELDS = ['opening', 'rhythm', 'privateFollow', 'naturalTopic',
    'crossChannel', 'mute'];

  function updateGroup(id, patch) {
    patch = patch || {};
    var groups = allGroups();
    var hit = null;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].id === id) { hit = groups[i]; break; }
    }
    if (!hit) return { ok: false, message: '找不到这个群' };

    GROUP_FIELDS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) return;
      hit[k] = patch[k];
    });
    if (patch.settings) {
      if (!hit.settings) hit.settings = Object.assign({}, DEFAULT_SETTINGS);
      SETTINGS_FIELDS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(patch.settings, k)) {
          hit.settings[k] = patch.settings[k];
        }
      });
    }
    hit.updatedAt = Date.now();
    saveGroups(groups);
    return { ok: true, group: hit };
  }

  /* 解散群：唯一公开入口（异步）。**不可逆物理删**，所以事务顺序是硬约定：
     ① 先确认群存在（findGroup）
     ② 判定「无向量环境」—— 只有明确证明本机没有 IndexedDB 才放行
        （判据同 wipeAll：supported = !!global.indexedDB → 'not-applicable/noidb'，
        见 memory-vec.js:155/550）。这是**唯一合法**的「没有向量对象可清」情形。
     ③ 向量模块缺失 / forgetGroup 缺失 / 未初始化，但本机本应有向量能力
        （有 IndexedDB）→ **必须失败** `{ok:false, why:'memory-vector-unavailable/api-missing'}`，
        主表一行不删 —— 绝不静默物理删群却留下它的向量块（= 隐私残留 + 幻觉源）。
     ④ 向量可用 → await forgetGroup(groupId)，失败即拒（见下）。
     ⑤ 只有向量明确清空（或本无向量环境）后，才清派生键 + 线下行 + 主表。
     失败路径：主表未动、findGroup 仍命中 → 用户可重试。 */
  function purgeGroup(id) {
    var g = findGroup(id);
    if (!g) return Promise.resolve({ ok: false, message: '找不到这个群' });

    var MV = Sleepy.memoryVec;
    var hasIDB = !!global.indexedDB;

    function cleanup() {
      /* 派生裸键（不在 scoped 名单，删房清不到，必须自己 remove；store.remove 同步） */
      store.remove('groupPending:' + id);
      store.remove('groupInner:' + id);
      store.remove('sumCursor:g:' + id);
      /* 两张线下数组按行 groupId 过滤（不整键删，只动这个群的）：
         - groupOfflineSessions：active → ended（收尾给 UI 看）后立刻从数组滤掉，无观察期
         - offlineHandoffs：直接滤掉 */
      store.set('groupOfflineSessions', arr(store.get('groupOfflineSessions'))
        .map(function (s) {
          if (s && s.groupId === id && (s.status || 'active') === 'active') s.status = 'ended';
          return s;
        })
        .filter(function (s) { return !(s && s.groupId === id); }));
      store.set('offlineHandoffs', arr(store.get('offlineHandoffs'))
        .filter(function (x) { return !(x && x.groupId === id); }));
      /* 主表最后删（三张） */
      saveGroups(allGroups().filter(function (g) { return g.id !== id; }));
      store.set('groupMembers', allMembers().filter(function (m) { return m.groupId !== id; }));
      store.set('groupMessages', allMessages().filter(function (m) { return m.groupId !== id; }));
      return { ok: true };
    }

    /* ② 明确无向量环境（本机无 IndexedDB）= not-applicable，可继续删主表 */
    if (!hasIDB) return Promise.resolve(cleanup());

    /* ③ 本应有向量能力，但模块/API 缺失或未就绪 → 必须失败，保留主表 */
    if (!MV || typeof MV.forgetGroup !== 'function') {
      return Promise.resolve({ ok: false, why: 'memory-vector-unavailable/api-missing' });
    }

    /* ④ 向量可用 → 先清向量，明确成功后才动主表 */
    return MV.forgetGroup(id).then(function () {
      return cleanup();
    })['catch'](function (err) {
      /* ⑤ 向量失败（IndexedDB 打开失败 / 事务中止）：主表未动，返回失败可重试 */
      return { ok: false, why: 'memory-vector-failed',
        error: (err && err.message) ? err.message : String(err) };
    });
  }

  /* ---------------------------- 群成员 ---------------------------- */

  /* 在群成员。status 过滤：active 才是「在群里的人」。
     left/removed 留档 —— 调度要用「TA 看到过什么再退的」这个事实。 */
  function membersOf(groupId, includeInactive) {
    var list = allMembers().filter(function (m) { return m.groupId === groupId; });
    if (!includeInactive) {
      list = list.filter(function (m) { return (m.status || 'active') === 'active'; });
    }
    return list;
  }

  function findMember(groupId, accountId) {
    var list = allMembers();
    for (var i = 0; i < list.length; i++) {
      if (list[i].groupId === groupId && list[i].accountId === accountId) return list[i];
    }
    return null;
  }

  /* 某个本体的全部在群账号。调度去重（先按本体归并）就靠它（总纲 1.2）：
     返回的是深拷贝快照里的引用 —— allMembers() 是全量原始数组，
     改里面的对象要 saveMembers 落盘，见 saveMembers。 */
  function accountsOfEntity(groupId, ownerId) {
    return membersOf(groupId).filter(function (m) { return m.ownerId === ownerId; });
  }

  function saveMembers(list) { return store.set('groupMembers', list); }

  /* 邀请进群。specs 格式同 createGroup；已在本群的账号跳过。
     每次邀请落一条系统消息（公开事件）。 */
  function addMembers(groupId, specs) {
    var g = findGroup(groupId);
    if (!g) return { ok: false, message: '找不到这个群' };
    var members = allMembers();
    var added = [];
    arr(specs).forEach(function (m) {
      if (!m || !m.accountId) return;
      for (var i = 0; i < members.length; i++) {
        if (members[i].groupId === groupId &&
            members[i].accountId === m.accountId &&
            (members[i].status || 'active') === 'active') return;
      }
      var owner = m.ownerId || (m.kind === 'char' ? core.rootIdOf(m.accountId) : m.accountId);
      var rec = {
        id: newId('gm'),
        groupId: groupId,
        kind: m.kind,
        ownerId: owner,
        accountId: m.accountId,
        role: 'member',
        status: 'active',
        joinedAt: Date.now(),
        nickname: ''
      };
      core.tagScope(rec);
      members.push(rec);
      added.push(m.accountId);
    });
    if (!added.length) return { ok: true, added: [] };
    store.set('groupMembers', members);
    g.updatedAt = Date.now();
    saveGroups(allGroups());   /* 刷新 updatedAt（groups 快照里 hit 已改） */
    return { ok: true, added: added };
  }

  /* 账号退群 / 被移除。status 只在 left / removed 之间切换，
     不物理删行 —— 总纲 3.4 的 status 是事实记录。 */
  function setMemberStatus(groupId, accountId, status) {
    var members = allMembers();
    var hit = null;
    for (var i = 0; i < members.length; i++) {
      if (members[i].groupId === groupId && members[i].accountId === accountId) {
        hit = members[i]; break;
      }
    }
    if (!hit) return { ok: false, message: '这个账号不在群里' };
    hit.status = status === 'removed' ? 'removed' : 'left';
    store.set('groupMembers', members);
    return { ok: true, member: hit };
  }

  /* user 在本群自己可以切换发言的账号清单（kind=user 的在群成员） */
  function userAccountsOf(groupId) {
    return membersOf(groupId).filter(function (m) { return m.kind === 'user'; });
  }

  /* ---------------------------- 群消息 ---------------------------- */

  function messagesOf(groupId) {
    var list = allMessages().filter(function (m) { return m.groupId === groupId; });
    list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return list;
  }

  function findMessage(groupId, messageId) {
    var list = allMessages();
    for (var i = 0; i < list.length; i++) {
      if (list[i].groupId === groupId && list[i].id === messageId) return list[i];
    }
    return null;
  }

  /* 落一条群消息。msg = { senderKind, senderAccountId, content, replyToMessageId,
     mentionedAccountIds, mentionAll } —— 本体 id 在这里归一：
     user 恒 'user'，char 顺 rootOf，NPC 是自己。senderEntityId 是调度
     和认知结算的坐标，必须落库，不能渲染时再猜。 */
  function addMessage(groupId, msg) {
    msg = msg || {};
    var g = findGroup(groupId);
    if (!g) return null;

    var kind = msg.senderKind || 'user';
    var accountId = msg.senderAccountId || null;
    var entity = 'user';
    if (kind === 'char') entity = core.rootIdOf(accountId) || accountId;
    else if (kind === 'npc') entity = accountId;

    var item = {
      id: newId('gms'),
      groupId: groupId,
      senderKind: kind,
      senderEntityId: msg.senderEntityId || entity,
      senderAccountId: accountId,
      type: msg.type || 'text',
      content: String(msg.content == null ? '' : msg.content),
      replyToMessageId: msg.replyToMessageId || null,
      mentionedAccountIds: arr(msg.mentionedAccountIds),
      mentionAll: !!msg.mentionAll,
      createdAt: msg.createdAt || Date.now()
    };
    /* 表情包 / 图片消息的附件字段（可选，有才落） */
    if (msg.mediaId) item.mediaId = msg.mediaId;
    if (msg.url) item.url = String(msg.url);
    if (msg.name) item.name = String(msg.name);
    /* 业务 payload（施工卡-群声-v1 Batch C）：群声分享卡的统一结构挂在
       msg.qs —— 不平铺成零散字段（一套 payload，私聊/群聊共用一份） */
    if (msg.qs) item.qs = msg.qs;
    core.tagScope(item);
    var list = allMessages();
    list.push(item);
    store.set('groupMessages', list);

    g.updatedAt = item.createdAt;
    saveGroups(allGroups());

    /* 分享回执·已回应（v247b）：群成员（char/NPC）在分享落地的群里开口了 →
       给分享者补一条回执。咽喉挂一次；forumShare 缺席/出错不影响消息本身。 */
    if (global.Sleepy && global.Sleepy.forumShare && global.Sleepy.forumShare.onConversationMessage) {
      try { global.Sleepy.forumShare.onConversationMessage('group', groupId, item); } catch (e) { /* 静默 */ }
    }
    return item;
  }

  /* 系统消息：建群、邀请、退群、改名都落一条。公开事件，全员可见。 */
  function systemMessage(groupId, text) {
    var item = {
      id: newId('gsy'),
      groupId: groupId,
      senderKind: 'system',
      senderEntityId: null,
      senderAccountId: null,
      type: 'system',
      content: String(text || ''),
      replyToMessageId: null,
      mentionedAccountIds: [],
      mentionAll: false,
      createdAt: Date.now()
    };
    core.tagScope(item);
    var list = allMessages();
    list.push(item);
    store.set('groupMessages', list);
    return item;
  }

  /* 撤回：打时间戳，原文保留（见文件头注释）。
     撤回本身不落系统消息 —— 渲染方在原位置显示「撤回了一条消息」，
     这才是时间线该有的样子。 */
  function recallMessage(groupId, messageId) {
    var list = allMessages();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].groupId === groupId && list[i].id === messageId) { hit = list[i]; break; }
    }
    if (!hit) return { ok: false, message: '找不到这条消息' };
    if (hit.type === 'system') return { ok: false, message: '系统消息不能撤回' };
    if (hit.recalledAt) return { ok: true, message: hit };
    hit.recalledAt = Date.now();
    store.set('groupMessages', list);
    return { ok: true, message: hit };
  }

  function lastMessage(groupId) {
    var list = messagesOf(groupId);
    return list.length ? list[list.length - 1] : null;
  }

  /* ---------------------------- 展示辅助 ---------------------------- */

  /* 账号的展示名 / 头像。三种 kind 各查各的表；
     查不到记录（被删号）时回落到账号 id，宁可显示难看也别渲染成 undefined。 */
  function accountMeta(member) {
    if (!member) return { name: '?', avatar: '', avatarMedia: '', initial: '?' };
    var kind = member.kind;
    if (kind === 'user') {
      var u = core.findUser(member.accountId);
      return {
        name: u ? core.labelOfUser(u) : '我',
        avatar: (u && u.avatar) || '',
        avatarMedia: (u && u.avatarMedia) || '',
        initial: u ? core.initialOfUser(u) : '我'
      };
    }
    if (kind === 'npc') {
      var n = core.findChar(member.accountId);
      return {
        name: (n && n.name) || 'NPC',
        avatar: (n && n.avatar) || '',
        avatarMedia: (n && n.avatarMedia) || '',
        initial: core.initialOf((n && n.name) || 'N')
      };
    }
    var c = core.findChar(member.accountId);
    return {
      name: (c && c.name) || '角色',
      avatar: (c && c.avatar) || '',
      avatarMedia: (c && c.avatarMedia) || '',
      initial: core.initialOf((c && c.name) || '角')
    };
  }

  /* 本体名（系统消息、线下合并用）：user → 「我」，char → 大号名。 */
  function entityName(member) {
    if (!member) return '?';
    if (member.kind === 'user') return '我';
    var root = core.findChar(member.ownerId);
    return (root && root.name) || accountMeta(member).name;
  }

  /* 拼图头像的底色。六种暖调（跟主题不冲突，**没有一種蓝**），
     按 accountId 哈希取色 —— 同一个账号在任何群里都是同一个颜色，
     视觉上才认得出来。 */
  var TILE_COLORS = ['#98866C', '#708E83', '#B58479', '#869179', '#8B8874', '#7D708E'];
  function tileColor(accountId) {
    var s = String(accountId || '');
    var hsh = 0;
    for (var i = 0; i < s.length; i++) hsh = (hsh * 31 + s.charCodeAt(i)) >>> 0;
    return TILE_COLORS[hsh % TILE_COLORS.length];
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.groupStore = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    listGroups: listGroups,
    findGroup: findGroup,
    createGroup: createGroup,
    updateGroup: updateGroup,
    purgeGroup: purgeGroup,
    membersOf: membersOf,
    findMember: findMember,
    accountsOfEntity: accountsOfEntity,
    addMembers: addMembers,
    setMemberStatus: setMemberStatus,
    userAccountsOf: userAccountsOf,
    messagesOf: messagesOf,
    findMessage: findMessage,
    addMessage: addMessage,
    systemMessage: systemMessage,
    recallMessage: recallMessage,
    lastMessage: lastMessage,
    accountMeta: accountMeta,
    entityName: entityName,
    tileColor: tileColor
  };

})(window);
