/* ============================================================
   forum-core.js — 群声（公共论坛）数据层
   职责：显式世界上下文解析、forum 系列存储键的读写口子、
         论坛账号 / 板块 / 帖子 / 回复 / 互动的服务入口、公开投影、游标分页。
   零 UI、零模型调用 —— 生成走 forum-gen.js，页面走 page-qunsheng.js。

   依据：docs/交接-群声-BatchA / -BatchB（施工总单 v1）
   身份边界（施工总单 §4 / 产品总纲 §四）：
   · user 的世界内论坛账号按**马甲**建 —— 默认马甲 = main，其他马甲 = alt；
     别的岛的马甲不进这里（masksOfSandbox 天然按岛）。
   · char 只给**房成员**（charsOfSandbox，天然排除皮套 / NPC / 别岛角色）建账号；
     皮套不直连论坛（要发言以大号身份）。
   · NPC（npcsOfRoom）建 resident 型账号；公共居民由 forum-gen 生成。
   · maskId / charId 绝不直接当 forumAccountId —— 论坛账号是独立实体。

   ---- 纪律（与 core.js 的作用域规则一致）----
   · 读：scopedForum(key, sandboxId) —— 只返回该岛的记录；
   · 写：tagScope 盖章 + 对**全量数组**改完整体 set 回去，
     绝不把 scoped() 的结果 set 回去（会把别的岛的数据整批抹掉）。
   · store.get() 返回深拷贝 —— 改字段必须走写入口落库。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;
  var store = Sleepy.store;

  /* ------------------------------ 存储键 ------------------------------ */

  var FORUM_KEYS = [
    'forumAccounts', 'forumBoards', 'forumPosts', 'forumComments',
    'forumReposts', 'forumFollows', 'forumLikes', 'forumCollections',
    'forumNotifications', 'forumShares', 'forumShareReceipts',
    'forumDrafts', 'forumKnowledge'
  ];

  var FORUM_MAP_KEYS = ['forumSettingsBySandbox', 'selectedForumAccountBySandbox',
    /* v218：匿名池迁移的一次性标记（按岛记 moved 数，防重复迁移） */
    'forumAnonPoolMigrated'];

  /* ------------------------------ 小工具 ------------------------------ */

  function uid(prefix) {
    return (prefix || 'f') + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  }

  function nowIso() { return new Date().toISOString(); }

  /* 摘要截断（通知预览用；forum-share 里那份是显示层自己的，不互用） */
  function excerpt(s, n) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* 字符串稳定 hash（同步、跨会话一致 —— 匿名别名 / 头像色都靠它）。
     不用 crypto.subtle：页内没有 require、subtle 又是异步的。 */
  function strHash(s) {
    var h = 5381;
    var str = String(s || '');
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) & 0x7fffffff;
    return h;
  }

  /* ------------------------------ 世界上下文 ------------------------------ */

  /* 显式世界上下文解析（施工总单 §1.2 的强制优先级）：
     1. 外部显式传入的 sandboxId；2. 页面锁定的 sandboxId；3. activeSandbox()；
     4. 都没有 → { ok:false }。传了假 id 一律报错，绝不静默落到第一间房。 */
  var lockedSandboxId = null;

  function resolveContext(explicitSandboxId) {
    var sid = explicitSandboxId || lockedSandboxId ||
      (core.activeSandbox() ? core.activeSandbox().id : null);
    if (!sid) return { ok: false, reason: 'no-sandbox', message: '还没有进入任何一座岛' };

    var sb = core.findSandbox(sid);
    if (!sb) return { ok: false, reason: 'bad-sandbox', message: '当前社区不存在（找不到这座岛）' };

    lockedSandboxId = sid;

    var masks = core.masksOfSandbox(sid);
    var me = null;
    masks.forEach(function (m) { if (!me && m.isDefault) me = m; });
    if (!me) me = masks[0] || null;

    var chars = core.charsOfSandbox(sid);
    var npcs = core.npcsOfRoom(sb);

    return {
      ok: true,
      sandboxId: sid,
      sandboxKind: sb.kind || 'isle',
      sandboxName: sb.name || '未命名小岛',
      userEntityId: me ? me.id : null,
      primaryCharIds: chars.map(function (c) { return c.id; }),
      residentNpcIds: npcs.map(function (n) { return n.id; })
    };
  }

  function unlockContext() { lockedSandboxId = null; }

  /* ------------------------------ 读写口子 ------------------------------ */

  function scopedForum(key, sandboxId) {
    if (FORUM_KEYS.indexOf(key) < 0) throw new Error('forum: 未登记的键 ' + key);
    var all = store.get(key) || [];
    var sid = sandboxId || lockedSandboxId;
    if (!sid) return all;
    return all.filter(function (r) { return r && r.sandboxId === sid; });
  }

  function putForum(key, allRecords) {
    if (FORUM_KEYS.indexOf(key) < 0) throw new Error('forum: 未登记的键 ' + key);
    store.set(key, allRecords);
  }

  function tagScope(rec, sandboxId) {
    return core.tagScope(rec, sandboxId || lockedSandboxId || undefined);
  }

  function getForumMap(key, sandboxId) {
    if (FORUM_MAP_KEYS.indexOf(key) < 0) throw new Error('forum: 未登记的映射键 ' + key);
    var map = store.get(key) || {};
    var sid = sandboxId || lockedSandboxId;
    return sid ? (map[sid] || null) : null;
  }

  function setForumMap(key, sandboxId, value) {
    if (FORUM_MAP_KEYS.indexOf(key) < 0) throw new Error('forum: 未登记的映射键 ' + key);
    if (!sandboxId) throw new Error('forum: setForumMap 必须带 sandboxId');
    var map = store.get(key) || {};
    map[sandboxId] = JSON.parse(JSON.stringify(value));
    store.set(key, map);
  }

  /* ------------------------------ 板块模板 ------------------------------ */

  /* 八个板块模板（跨岛复用；实例按 sandboxId 各建一份）。
     顺序即目录顺序，别随手调换 —— UI 按数组顺序渲染。 */
  var BOARD_TEMPLATES = [
    { key: 'daily',    name: '日常生活',   desc: '柴米油盐，楼上楼下' },
    { key: 'help',     name: '情感求助',   desc: '拿不准的事，说出来参谋' },
    { key: 'treehole', name: '树洞',       desc: '匿名说点不敢说的' },
    { key: 'fanwork',  name: '同人创作',   desc: '写画剪贴，给喜欢的人' },
    { key: 'photo',    name: '摄影与旅行', desc: '路上看到的，都值得一张' },
    { key: 'food',     name: '美食与探店', desc: '好吃不好吃，说了算' },
    { key: 'game',     name: '游戏区',     desc: '打得好坏，都来聊聊' },
    { key: 'local',    name: '本地生活',   desc: '失物招领与街头巷尾' }
  ];

  /* ------------------------------ 账号与板块初始化 ------------------------------ */

  /* 幂等：同一岛重复调用不重复建。返回 { created, accounts, boards }。
     user 大小号：默认马甲 → main，其余马甲 → alt；
     char：房成员（大号）各一号；NPC → resident 型账号；公共居民暂缺（forum-gen 补）。 */
  function ensureSeed(sandboxId) {
    var fx = resolveContext(sandboxId);
    if (!fx.ok) return { ok: false, message: fx.message };
    var sid = fx.sandboxId;
    var created = { accounts: 0, boards: 0 };

    var accounts = store.get('forumAccounts') || [];
    var boards = store.get('forumBoards') || [];

    function ownedBy(ownerEntityId) {
      return accounts.some(function (a) {
        return a.sandboxId === sid && a.ownerEntityId === ownerEntityId;
      });
    }

    /* ① user 马甲 → 论坛账号 */
    core.masksOfSandbox(sid).forEach(function (m) {
      if (ownedBy(m.id)) return;
      accounts.push(tagScope({
        id: uid('fa'), ownerEntityId: m.id, ownerType: 'user',
        accountType: m.isDefault ? 'main' : 'alt',
        displayName: m.name || '无名我',
        handle: 'u_' + strHash(sid + m.id).toString(36),
        avatarColor: '#d8cec0',
        bio: '', status: 'active',
        createdAt: nowIso(), updatedAt: nowIso()
      }, sid));
      created.accounts++;
    });

    /* ② 房成员 char（大号）→ 论坛账号。皮套不直连（施工总单 §B-1）。 */
    core.charsOfSandbox(sid).forEach(function (c) {
      if (ownedBy(c.id)) return;
      accounts.push(tagScope({
        id: uid('fa'), ownerEntityId: c.id, ownerType: 'char',
        accountType: 'char',
        displayName: c.name || '无名客',
        handle: 'c_' + strHash(sid + c.id).toString(36),
        avatarColor: '#d6e0dc',
        bio: '', status: 'active',
        createdAt: nowIso(), updatedAt: nowIso()
      }, sid));
      created.accounts++;
    });

    /* ③ NPC → resident 型账号 */
    var sb = core.findSandbox(sid);
    core.npcsOfRoom(sb).forEach(function (n) {
      if (ownedBy(n.id)) return;
      accounts.push(tagScope({
        id: uid('fa'), ownerEntityId: n.id, ownerType: 'npc',
        accountType: 'resident',
        displayName: n.name || '街坊',
        handle: 'n_' + strHash(sid + n.id).toString(36),
        avatarColor: '#e2d7c4',
        bio: '', status: 'active',
        createdAt: nowIso(), updatedAt: nowIso()
      }, sid));
      created.accounts++;
    });

    /* ④ 八板块实例 */
    var have = {};
    boards.forEach(function (b) { if (b.sandboxId === sid) have[b.templateKey] = 1; });
    BOARD_TEMPLATES.forEach(function (t) {
      if (have[t.key]) return;
      boards.push(tagScope({
        id: uid('fb'), templateKey: t.key, name: t.name,
        description: t.desc, rules: '', status: 'active',
        createdAt: nowIso(), updatedAt: nowIso()
      }, sid));
      created.boards++;
    });

    /* ⑤ 匿名池账号（v218 修「别人的匿名帖挂到我头上」）：
       以前生成链的匿名树洞借 user 主号发（forum-gen resolveSeedAuthor '@anon'），
       而「我的帖子/回复」按 authorAccountId 过滤 —— 借主号 = 借出一次挂名一次。
       匿名一律改借这个 ownerType='anon' 的池号：谁也不拥有，listOwnedForumAccounts
       只认 ownerType='user'，它永远不会出现在「论坛身份」列表里。 */
    var pool = accounts.filter(function (a) {
      return a.sandboxId === sid && a.ownerEntityId === 'anon-pool';
    })[0];
    if (!pool) {
      pool = tagScope({
        id: uid('fa'), ownerEntityId: 'anon-pool', ownerType: 'anon',
        accountType: 'anon', displayName: '匿名',
        handle: 'a_' + strHash(sid + ':anon'),
        avatarColor: '#cfc8ba', bio: '', status: 'active',
        createdAt: nowIso(), updatedAt: nowIso()
      }, sid);
      accounts.push(pool);
      created.accounts++;
    }

    /* ⑥ 一次性迁移（v218）：历史上借主号的匿名内容划给池号。
       判据 = 匿名帖 authorAccountId===user 主号，或匿名帖的楼主回复 /
       单楼匿名回复 authorAccountId===user 主号 —— 正常署名内容一个不动。
       ⚠️ user 自己在发帖页选「单帖匿名」的老帖子也会被划走：老数据没有
       「这条是谁操作发的」标记，分不开；范围只有匿名那一小撮。 */
    if (!getForumMap('forumAnonPoolMigrated', sid)) {
      var mainAcc = accounts.filter(function (a) {
        return a.sandboxId === sid && a.ownerType === 'user' && a.accountType === 'main';
      })[0];
      if (mainAcc && pool) {
        var mPosts = store.get('forumPosts') || [];
        var mComments = store.get('forumComments') || [];
        var moved = 0;
        var anonPostIds = {};
        mPosts.forEach(function (p) {
          if (!p || p.sandboxId !== sid) return;
          if (p.authorDisplayMode === 'anonymous') {
            if (p.authorAccountId === mainAcc.id) {
              p.authorAccountId = pool.id; p.updatedAt = nowIso(); moved++;
            }
            anonPostIds[p.id] = 1;
          }
        });
        mComments.forEach(function (c) {
          if (!c || c.sandboxId !== sid) return;
          if (c.authorAccountId === mainAcc.id &&
              (c.anonymous === true || (c.isPostAuthor && anonPostIds[c.postId]))) {
            c.authorAccountId = pool.id; c.updatedAt = nowIso(); moved++;
          }
        });
        putForum('forumPosts', mPosts);
        putForum('forumComments', mComments);
        setForumMap('forumAnonPoolMigrated', sid, { at: nowIso(), moved: moved });
      }
    }

    if (created.accounts) putForum('forumAccounts', accounts);
    if (created.boards) putForum('forumBoards', boards);
    return { ok: true, created: created };
  }

  /* ------------------------------ 服务入口（施工总单 §B-3） ------------------------------ */

  function listBoards(sandboxId) {
    var sid = (sandboxId || lockedSandboxId);
    return scopedForum('forumBoards', sid)
      .filter(function (b) { return b.status === 'active'; })
      .sort(function (a, b) {
        /* 按模板顺序排 —— 板块实例的 id 是随机的，不能靠它排 */
        var ia = -1, ib = -1;
        BOARD_TEMPLATES.forEach(function (t, i) {
          if (t.key === a.templateKey) ia = i;
          if (t.key === b.templateKey) ib = i;
        });
        return ia - ib;
      });
  }

  function listOwnedForumAccounts(sandboxId, userEntityId) {
    var sid = (sandboxId || lockedSandboxId);
    return scopedForum('forumAccounts', sid).filter(function (a) {
      return a.ownerType === 'user' && a.status === 'active' &&
        (!userEntityId || a.ownerEntityId === userEntityId);
    });
  }

  /* 当前身份：selectedForumAccountBySandbox[sid]；失效回退 user 主账号（§B-3）。 */
  function getSelectedForumAccount(sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    if (!sid) return null;
    var sel = getForumMap('selectedForumAccountBySandbox', sid);
    if (sel && sel.accountId) {
      var hit = scopedForum('forumAccounts', sid).filter(function (a) {
        return a.id === sel.accountId && a.status === 'active';
      })[0];
      if (hit) return hit;
    }
    var owned = listOwnedForumAccounts(sid);
    return owned.filter(function (a) { return a.accountType === 'main'; })[0] || owned[0] || null;
  }

  function setSelectedForumAccount(sandboxId, accountId) {
    var sid = sandboxId || lockedSandboxId;
    if (!sid) return { ok: false, message: '没有当前岛' };
    var owned = listOwnedForumAccounts(sid);
    if (!owned.some(function (a) { return a.id === accountId; })) {
      return { ok: false, message: '这个论坛身份不属于当前岛的「我」' };
    }
    setForumMap('selectedForumAccountBySandbox', sid, { accountId: accountId, updatedAt: nowIso() });
    return { ok: true };
  }

  /* 按公开身份取展示信息。viewer 只影响「能看什么」，不影响显示名字本身。 */
  function getAccount(accountId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return scopedForum('forumAccounts', sid).filter(function (a) { return a.id === accountId; })[0] || null;
  }

  /* ------------------------------ 单帖匿名 ------------------------------ */

  /* 稳定别名（施工总单 §4.3）：键 = sandboxId + postId + realAuthorAccountId。
     同帖同作者永远同一别名；不同帖不串联；不含可逆映射。 */
  function anonymousAlias(sandboxId, postId, accountId) {
    var h = strHash(sandboxId + '|' + postId + '|' + accountId);
    return '匿名用户 ' + (h % 900 + 100);
  }

  /* 公开作者投影：匿名帖返回 { anonymous:true, displayName:别名 }，
     永不返回 realAuthorAccountId。isPostAuthor 楼层用 anonymousAlias 复用。 */
  function publicAuthorOf(post, accountId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    if (post.authorDisplayMode === 'anonymous') {
      return {
        anonymous: true,
        displayName: anonymousAlias(sid, post.id, post.authorAccountId),
        avatarChar: '匿',
        avatarColor: '#cfc8ba'
      };
    }
    var acc = getAccount(accountId || post.authorAccountId, sid);
    return {
      anonymous: false,
      accountId: acc ? acc.id : post.authorAccountId,
      ownerEntityId: acc ? acc.ownerEntityId : null,
      ownerType: acc ? acc.ownerType : null,
      displayName: acc ? acc.displayName : '已注销账号',
      /* avatarGlyph：论坛身份编辑里用户自选的头像字（v218），没设就落名字首字 */
      avatarChar: acc ? (acc.avatarGlyph || (acc.displayName || '友').charAt(0)) : '友',
      avatarColor: acc ? (acc.avatarColor || '#d6e0dc') : '#d6e0dc'
    };
  }

  /* ------------------------------ 帖子 / 回复 CRUD ------------------------------ */

  /* v218：论坛身份改名 / 换头像。只允许 user 自己的身份（ownerType==='user'）；
     char / NPC / 居民的脸是岛内的脸，不归这里改。avatarGlyph 空串 = 回落名字首字。 */
  function updateAccountProfile(accountId, fields) {
    var sid = lockedSandboxId;
    if (!sid) return { ok: false, message: '没有当前岛' };
    var list = store.get('forumAccounts') || [];
    var hit = null;
    list.forEach(function (a) {
      if (a && a.sandboxId === sid && a.id === accountId) hit = a;
    });
    if (!hit) return { ok: false, message: '找不到这个身份' };
    if (hit.ownerType !== 'user') return { ok: false, message: '只能改自己的论坛身份' };
    var f = fields || {};
    if (typeof f.displayName === 'string') {
      var dn = f.displayName.trim().slice(0, 12);
      if (dn) hit.displayName = dn;
    }
    if (typeof f.avatarColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(f.avatarColor)) {
      hit.avatarColor = f.avatarColor;
    }
    if (typeof f.avatarGlyph === 'string') {
      hit.avatarGlyph = f.avatarGlyph.trim().slice(0, 2);
    }
    hit.updatedAt = nowIso();
    putForum('forumAccounts', list);
    return { ok: true, account: hit };
  }

  /* 创建帖子。opt: { sandboxId, boardId, accountId, anonymous, postType,
     title, content, visibility, allowRepost } */
  function createPost(opt) {
    var sid = opt.sandboxId || lockedSandboxId;
    if (!sid) return { ok: false, message: '没有当前岛' };
    if (!opt.boardId || !getBoard(opt.boardId, sid)) return { ok: false, message: '板块不对' };
    if (!opt.accountId) return { ok: false, message: '还没选论坛身份' };
    var title = String(opt.title || '').trim();
    var content = String(opt.content || '').trim();
    if (!title && !content) return { ok: false, message: '总得写点什么' };

    var post = tagScope({
      id: uid('fp'),
      boardId: opt.boardId,
      authorAccountId: opt.accountId,
      authorDisplayMode: opt.anonymous ? 'anonymous' : 'account',
      anonymousAlias: opt.anonymous ? anonymousAlias(sid, 'p', opt.accountId) : '',
      postType: opt.postType || 'normal',
      title: title, content: content,
      visibility: opt.visibility || 'public',
      allowRepost: opt.allowRepost !== false,
      sourceType: opt.sourceType || '',
      sourceId: opt.sourceId || '',
      sourceRef: opt.sourceRef || null,
      assetRefs: Array.isArray(opt.assetRefs) ? opt.assetRefs.slice(0, 9) : [],
      placeText: opt.placeText || '',
      status: 'active',
      createdAt: nowIso(), updatedAt: nowIso()
    }, sid);
    /* 匿名别名要按真 postId 重算一次（上面预填的只是占位，保持字段在） */
    if (opt.anonymous) post.anonymousAlias = anonymousAlias(sid, post.id, opt.accountId);

    putForum('forumPosts', (store.get('forumPosts') || []).concat([post]));
    return { ok: true, post: post };
  }

  /* 更新帖子字段（v216：同人创作追更要往同一帖追加章节）。
     白名单是真的一步到位：fanwork 结构由数据层自己写，调用方传不来别的字段，
     免得哪天手抖把 authorAccountId / sandboxId 一起改了。
     ⚠️ store.get 是深拷贝，改完必须整表 put 回去（只改手里的副本不 put = 静默丢失）。 */
  var POST_UPDATABLE = ['title', 'content', 'fanwork', 'updatedAt'];
  function updatePost(postId, patch, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    if (!sid) return { ok: false, message: '没有当前岛' };
    var all = store.get('forumPosts') || [];
    var idx = -1;
    all.forEach(function (p, i) {
      if (p && p.id === postId && p.sandboxId === sid) idx = i;
    });
    if (idx < 0) return { ok: false, message: '帖子不在了' };
    var post = all[idx];
    Object.keys(patch || {}).forEach(function (k) {
      if (POST_UPDATABLE.indexOf(k) >= 0) post[k] = patch[k];
    });
    post.updatedAt = nowIso();
    all[idx] = post;
    putForum('forumPosts', all);
    return { ok: true, post: post };
  }

  function getBoard(boardId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return scopedForum('forumBoards', sid).filter(function (b) { return b.id === boardId; })[0] || null;
  }

  function getPost(postId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return scopedForum('forumPosts', sid).filter(function (p) { return p.id === postId; })[0] || null;
  }

  function listComments(postId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return scopedForum('forumComments', sid)
      .filter(function (c) { return c.postId === postId && c.status === 'active'; })
      .sort(function (a, b) {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
  }

  /* 回复级公开投影（v216 新增）：帖子本身是匿名帖 → 跟帖子走同一个别名；
     否则看**这条回复自己**有没有匿名（char 可以只有这一楼匿名），
     别名按 postId + 发言账号算，所以在同一帖里同一个匿名者前后一致、换帖就换脸。 */
  function publicAuthorOfComment(post, comment, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    if (!comment) return publicAuthorOf(post, post.authorAccountId, sid);
    if (post.authorDisplayMode === 'anonymous') {
      return publicAuthorOf(post, post.authorAccountId, sid);
    }
    if (comment.anonymous) {
      return {
        anonymous: true,
        displayName: anonymousAlias(sid, 'cm' + post.id, comment.authorAccountId),
        avatarChar: '匿',
        avatarColor: '#cfc8ba'
      };
    }
    return publicAuthorOf(post, comment.authorAccountId, sid);
  }

  /* 创建回复。opt: { sandboxId, postId, accountId, parentCommentId, content, anonymous }。
     匿名帖的楼主回复自动带 isPostAuthor（显示「匿名楼主」，同帖同别名）。
     anonymous=true（v216：char 单楼匿名）：公开层只露这条回复的别名，账号内部保留。 */
  function createComment(opt) {
    var sid = opt.sandboxId || lockedSandboxId;
    var post = getPost(opt.postId, sid);
    if (!post || post.status !== 'active') return { ok: false, message: '帖子不在了' };
    var content = String(opt.content || '').trim();
    if (!content) return { ok: false, message: '回复不能是空的' };

    var parent = opt.parentCommentId
      ? listComments(opt.postId, sid).filter(function (c) { return c.id === opt.parentCommentId; })[0]
      : null;

    var comment = tagScope({
      id: uid('fc'),
      postId: post.id,
      parentId: parent ? parent.id : null,
      rootCommentId: parent ? (parent.rootCommentId || parent.id) : null,
      authorAccountId: opt.accountId,
      isPostAuthor: post.authorAccountId === opt.accountId,
      anonymous: !!opt.anonymous,      /* v216：单楼匿名（char 可以选择藏起这一楼的脸） */
      content: content,
      status: 'active',
      createdAt: nowIso(), updatedAt: nowIso()
    }, sid);
    putForum('forumComments', (store.get('forumComments') || []).concat([comment]));

    /* 回复我的（Batch D）：通知帖子作者。actor 显示名走公开投影 ——
       帖子匿名且回复者就是楼主时，通知里也只露匿名别名。 */
    var actorPa = publicAuthorOfComment(post, comment, sid);
    if (post.authorAccountId !== comment.authorAccountId) {
      notify({
        sandboxId: sid,
        recipientAccountId: post.authorAccountId,
        category: 'reply',
        actorName: actorPa.displayName,
        actorAnonymous: actorPa.anonymous,
        selfActorAccountId: comment.authorAccountId,
        sourceType: 'post',
        sourceId: post.id,
        previewText: excerpt(content, 40)
      });
    }
    return { ok: true, comment: comment };
  }

  /* ------------------------------ 互动 ------------------------------ */

  function findUnique(list, actorId, targetType, targetId) {
    return list.filter(function (r) {
      return r.actorAccountId === actorId && r.targetType === targetType && r.targetId === targetId;
    })[0] || null;
  }

  /* 同感（Batch D 挂通知）：目标作者收「有人同感」。like 类自带去重。 */
  function toggleInteract(key, targetType, targetId, accountId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    if (!sid || !accountId) return { ok: false, message: '没有论坛身份' };
    var all = store.get(key) || [];
    var hit = findUnique(all, accountId, targetType, targetId);
    var on;
    if (hit) {
      on = false;
      putForum(key, all.filter(function (r) { return r !== hit; }));
    } else {
      on = true;
      putForum(key, all.concat([tagScope({
        id: uid('fx'), actorAccountId: accountId,
        targetType: targetType, targetId: targetId,
        createdAt: nowIso()
      }, sid)]));
      if (key === 'forumLikes') {
        var ownerId = null, postId = targetId;
        if (targetType === 'comment') {
          var c = (store.get('forumComments') || []).filter(function (x) {
            return x && x.id === targetId;
          })[0];
          if (c) { ownerId = c.authorAccountId; postId = c.postId; }
        } else if (targetType === 'post') {
          var p = getPost(targetId, sid);
          if (p) ownerId = p.authorAccountId;
        }
        if (ownerId) {
          var actorAcc = getAccount(accountId, sid);
          var actorPa = actorAcc ? { displayName: actorAcc.displayName, anonymous: false }
                                 : { displayName: '有人', anonymous: true };
          notify({
            sandboxId: sid,
            recipientAccountId: ownerId,
            category: 'like',
            actorName: actorPa.displayName,
            actorAnonymous: actorPa.anonymous,
            selfActorAccountId: accountId,
            sourceType: 'post',
            sourceId: postId,
            previewText: targetType === 'comment' ? '同感了你的回复' : '同感了你的帖子'
          });
        }
      }
    }
    return { ok: true, on: on };
  }

  function toggleLike(targetType, targetId, accountId, sandboxId) {
    return toggleInteract('forumLikes', targetType, targetId, accountId, sandboxId);
  }

  function toggleCollection(targetType, targetId, accountId, sandboxId) {
    return toggleInteract('forumCollections', targetType, targetId, accountId, sandboxId);
  }

  function hasInteract(key, targetType, targetId, accountId) {
    return !!findUnique(store.get(key) || [], accountId, targetType, targetId);
  }

  function countOf(key, targetType, targetId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get(key) || []).filter(function (r) {
      return r && r.sandboxId === sid && r.targetType === targetType && r.targetId === targetId;
    }).length;
  }

  function repostCount(postId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get('forumReposts') || []).filter(function (r) {
      return r && r.sandboxId === sid && r.sourcePostId === postId;
    }).length;
  }

  /* ------------------------------ 通知（Batch D） ------------------------------ */

  /* 通知只写 user / char 账号 —— 居民、NPC 没有阅读方，落库是纯垃圾。
     接收维度 = recipientAccountId（账号级，施工单 §D-1）：切小号不互曝。 */
  function shouldNotify(accountId, sandboxId) {
    var a = getAccount(accountId, sandboxId);
    return !!a && (a.ownerType === 'user' || a.ownerType === 'char');
  }

  /* opt: { sandboxId, recipientAccountId, category:'reply'|'like'|'system'|'receipt',
           actorName, actorAnonymous, selfActorAccountId, sourceType, sourceId, previewText }
     去重：like 类同 actor + sourceId 已有一条未读 → 不再堆（聚合的最简形态）。 */
  function notify(opt) {
    var sid = opt.sandboxId || lockedSandboxId;
    if (!sid || !opt.recipientAccountId) return null;
    if (!shouldNotify(opt.recipientAccountId, sid)) return null;
    if (opt.selfActorAccountId && opt.selfActorAccountId === opt.recipientAccountId) return null;

    var list = store.get('forumNotifications') || [];
    if (opt.category === 'like') {
      var dup = list.some(function (n) {
        return n.sandboxId === sid && n.recipientAccountId === opt.recipientAccountId &&
          n.category === 'like' && n.sourceId === opt.sourceId &&
          n.actorName === opt.actorName && !n.readAt;
      });
      if (dup) return null;
    }
    var rec = tagScope({
      id: uid('fn'),
      sandboxId: sid,
      recipientAccountId: opt.recipientAccountId,
      category: opt.category,
      actorName: String(opt.actorName || '有人'),
      actorAnonymous: !!opt.actorAnonymous,
      sourceType: opt.sourceType || 'post',
      sourceId: opt.sourceId || '',
      previewText: String(opt.previewText || ''),
      readAt: null,
      createdAt: nowIso()
    }, sid);
    putForum('forumNotifications', list.concat([rec]));
    return rec;
  }

  function listNotifications(sandboxId, accountId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get('forumNotifications') || [])
      .filter(function (n) {
        return n && n.sandboxId === sid && n.recipientAccountId === accountId;
      })
      .sort(function (a, b) {
        return a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0);
      });
  }

  function unreadCount(sandboxId, accountId) {
    return listNotifications(sandboxId, accountId).filter(function (n) { return !n.readAt; }).length;
  }

  /* 全量改 + 整体 set 回去（纪律：绝不 set scoped 的结果）。 */
  function markAllRead(sandboxId, accountId) {
    var sid = sandboxId || lockedSandboxId;
    var all = store.get('forumNotifications') || [];
    var changed = 0;
    var iso = nowIso();
    all.forEach(function (n) {
      if (n && n.sandboxId === sid && n.recipientAccountId === accountId && !n.readAt) {
        n.readAt = iso;
        changed++;
      }
    });
    if (changed) store.set('forumNotifications', all);
    return changed;
  }

  function markRead(notificationId) {
    var all = store.get('forumNotifications') || [];
    var hit = all.filter(function (n) { return n && n.id === notificationId && !n.readAt; })[0];
    if (!hit) return false;
    hit.readAt = nowIso();
    store.set('forumNotifications', all);
    return true;
  }

  /* ------------------------------ 论坛认知（Batch E） ------------------------------ */

  /* forumKnowledge：观察者对「公开身份/帖子」的单向知情候选（施工单 §E-4）。
     五档 unaware < familiar < suspected < high_confidence < confirmed；
     只存与查询、允许逐级上调，**绝不自动 confirmed**（模型敏锐 ≠ 后台权限）。
     这是内部表 —— 不进公开投影、不进普通 UI。 */
  var K_STATE_RANK = { unaware: 0, familiar: 1, suspected: 2, high_confidence: 3, confirmed: 4 };

  function addKnowledge(opt) {
    var sid = opt.sandboxId || lockedSandboxId;
    if (!sid || !opt.observerEntityId || !opt.subjectKey) return null;
    var state = K_STATE_RANK.hasOwnProperty(opt.state) ? opt.state : 'familiar';

    var all = store.get('forumKnowledge') || [];
    var hit = all.filter(function (k) {
      return k.sandboxId === sid &&
        k.observerEntityId === opt.observerEntityId &&
        k.subjectKey === opt.subjectKey;
    })[0];

    if (hit) {
      /* 只许升级不许降级；重复事件不重写证据 */
      if (K_STATE_RANK[hit.state] >= K_STATE_RANK[state]) return hit;
      hit.state = state;
      hit.updatedAt = nowIso();
      if (opt.evidenceRefs && opt.evidenceRefs.length) {
        hit.evidenceRefs = (hit.evidenceRefs || []).concat(opt.evidenceRefs).slice(-5);
      }
      store.set('forumKnowledge', all);
      return hit;
    }

    var rec = tagScope({
      id: uid('fk'),
      sandboxId: sid,
      observerEntityId: opt.observerEntityId,
      subjectType: opt.subjectType || 'forumAccount',
      subjectKey: opt.subjectKey,          /* 观察键：账号 id / 匿名别名等 */
      subjectName: opt.subjectName || '',
      state: state,
      evidenceRefs: (opt.evidenceRefs || []).slice(0, 5),
      updatedAt: nowIso()
    }, sid);
    putForum('forumKnowledge', all.concat([rec]));
    return rec;
  }

  function listKnowledge(sandboxId, observerEntityId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get('forumKnowledge') || []).filter(function (k) {
      return k && k.sandboxId === sid && k.observerEntityId === observerEntityId;
    });
  }

  /* ------------------------------ 信息流 ------------------------------ */

  /* mode: 'mixed' | 'follow' | 'latest'。首页首轮必须有稳定「最新」分页（§B-4）。
     follow 流（2026-10-11 关注补全）：只出我关注的账号的帖子（本地数据本地过滤），
     关注关系设备级（forumFollows 按 sandboxId 分组，键 = 被关注的论坛账号 id）。 */
  function followsOf(sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get('forumFollows') || [])
      .filter(function (r) { return r && r.sandboxId === sid; })
      .map(function (r) { return r.accountId; });
  }
  function isFollowing(sandboxId, accountId) {
    return followsOf(sandboxId).indexOf(accountId) >= 0;
  }
  /* forumFollows 注册键是数组格式：[{id, sandboxId, accountId, createdAt}] */
  function toggleFollow(sandboxId, accountId) {
    var sid = sandboxId || lockedSandboxId;
    var list = store.get('forumFollows') || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].sandboxId === sid && list[i].accountId === accountId) { hit = list[i]; break; }
    }
    if (hit) {
      list = list.filter(function (r) { return r !== hit; });
      store.set('forumFollows', list);
      return { on: false };
    }
    list.push({ id: uid('fw'), sandboxId: sid, accountId: accountId, createdAt: Date.now() });
    store.set('forumFollows', list);
    return { on: true };
  }
  function getHomeFeed(mode, cursor, limit, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    var posts = scopedForum('forumPosts', sid).filter(function (p) { return p.status === 'active'; });
    if (mode === 'follow') {
      var follows = followsOf(sid);
      var mine = posts.filter(function (p) { return follows.indexOf(p.authorAccountId) >= 0; });
      return pageOf(mine, cursor, limit || 12);
    }
    return pageOf(posts, cursor, limit || 12);
  }

  /* ------------------------------ 游标分页 ------------------------------ */

  /* 稳定分页边界：排序键 = createdAt + id（新在前）。 */
  function pageOf(list, cursor, limit) {
    var sorted = list.slice().sort(function (a, b) {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
    });
    var start = 0;
    if (cursor) {
      var sep = cursor.indexOf('|');
      var cAt = cursor.slice(0, sep), cId = cursor.slice(sep + 1);
      for (var i = 0; i < sorted.length; i++) {
        if (sorted[i].createdAt === cAt && sorted[i].id === cId) { start = i + 1; break; }
      }
    }
    var lim = Math.max(1, limit || 20);
    var items = sorted.slice(start, start + lim);
    var last = items[items.length - 1];
    var hasMore = start + lim < sorted.length;
    return {
      items: items,
      nextCursor: hasMore && last ? last.createdAt + '|' + last.id : null,
      hasMore: hasMore
    };
  }

  /* ------------------------------ 导出 ------------------------------ */

  Sleepy.forum = {
    KEYS: FORUM_KEYS,
    MAP_KEYS: FORUM_MAP_KEYS,
    BOARD_TEMPLATES: BOARD_TEMPLATES,
    resolveContext: resolveContext,
    unlockContext: unlockContext,
    scopedForum: scopedForum,
    putForum: putForum,
    tagScope: tagScope,
    getForumMap: getForumMap,
    setForumMap: setForumMap,
    uid: uid,
    nowIso: nowIso,
    strHash: strHash,
    ensureSeed: ensureSeed,
    listBoards: listBoards,
    listOwnedForumAccounts: listOwnedForumAccounts,
    getSelectedForumAccount: getSelectedForumAccount,
    setSelectedForumAccount: setSelectedForumAccount,
    getAccount: getAccount,
    anonymousAlias: anonymousAlias,
    publicAuthorOf: publicAuthorOf,
    publicAuthorOfComment: publicAuthorOfComment,
    createPost: createPost,
    updatePost: updatePost,
    updateAccountProfile: updateAccountProfile,
    getPost: getPost,
    getBoard: getBoard,
    listComments: listComments,
    createComment: createComment,
    toggleLike: toggleLike,
    toggleCollection: toggleCollection,
    hasInteract: hasInteract,
    countOf: countOf,
    repostCount: repostCount,
    getHomeFeed: getHomeFeed,
    isFollowing: isFollowing,
    toggleFollow: toggleFollow,
    followsOf: followsOf,
    pageOf: pageOf,
    notify: notify,
    listNotifications: listNotifications,
    unreadCount: unreadCount,
    markAllRead: markAllRead,
    markRead: markRead,
    addKnowledge: addKnowledge,
    listKnowledge: listKnowledge
  };

})(window);
