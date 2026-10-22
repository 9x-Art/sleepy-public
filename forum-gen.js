/* ============================================================
   forum-gen.js — 群声内容生成层（居民种子 / char·居民回帖）
   职责：把「模型输出」变成稳定落库的论坛内容。数据写入一律走
         Sleepy.forum 的服务入口，本文件不做裸 store.set。

   ---- 用户拍板（2026-10-07）----
   · 公共居民内容：首次进岛幂等批量生成一批账号+帖子+回复，之后复用；
   · char/NPC 回复：自动队列（user 发帖后延迟触发）+ 两处手动催更
     （首页「催更」= 补种子；帖子详情「催一下」= 请大家来回复）；
   · 活人感：错落 createdAt（社区有历史）、回复错峰落库、
     不均匀响应（有的帖没人理）、居民只在自己常驻板块冒泡。

   ---- 纪律 ----
   · 施工/测试期零网络：模型调用只发生在真机运行时；
     测试用 _setTransport 注入假 transport（fetch 绊线照红）。
   · 没有 API 配置时老实降级：不伪造内容、不写 seeded 标记，UI 出提示。
   · 模型输出先 JSON.parse 校验再入库；解析失败 = 本次生成作废，可重试。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var forum = Sleepy.forum;
  var core = Sleepy.core;

  /* ------------------------------ 模型调用 ------------------------------ */

  /* transport(messages, cb)：cb(err, text)。默认走 api.runChat（主 API 候选链）；
     测试注入假 transport，绕开网络。 */
  var transport = null;

  function defaultTransport(messages, cb) {
    if (!Sleepy.api || !Sleepy.api.runChat) { cb({ stage: 'config', error: '没有模型接口' }); return; }
    Sleepy.api.runChat(messages, {
      onDone: function (cand, text) { cb(null, text); },
      onFail: function (cands, err) { cb(err || { stage: 'unknown', error: '生成失败' }); }
      /* maxTokens 覆盖（2026-10-14）：群声产出是多帖+回复的大 JSON，
         默认 1024 常截断 → 解析失败（真 API 验证复现）。max_tokens 是上限
         不影响计费下限，给足余量；种子/增量/char 回应共用本咽喉。 */
    }, false, { feature: 'forum', maxTokens: 3000 });   /* 勾了「群声走副 API」→ 只轮询副 API（api.js） */
  }

  function ask(messages, cb) {
    (transport || defaultTransport)(messages, cb);
  }

  function _setTransport(fn) { transport = fn; }

  /* 从模型输出里抠 JSON（容忍 ```json 围栏 / 前后废话）。 */
  function extractJson(text) {
    var s = String(text || '');
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  /* ------------------------------ Prompt ------------------------------ */

  function personaLine(c) {
    var t = String(c.content || '').replace(/\s+/g, ' ').trim();
    return c.name + (t ? '（' + t.slice(0, 120) + '）' : '');
  }

  function seedMessages(fx) {
    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);
    var npcNames = fx.residentNpcIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(function (n) { return n.name; });
    var boards = forum.BOARD_TEMPLATES.map(function (b) { return b.key + '=' + b.name; }).join('、');

    return [
      { role: 'system', content:
        '你是「群声」社区的内容导演。为这座岛上的公共论坛生成一批种子内容。' +
        '只输出一个 JSON 对象，不要解释、不要 markdown 围栏。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '（' + (fx.sandboxKind === 'archipelago' ? '群岛' : '孤岛') + '）\n' +
        '岛上的角色：' + (chars.join('；') || '暂无') + '\n' +
        '街坊 NPC：' + (npcNames.join('、') || '暂无') + '\n' +
        '板块：' + boards + '\n\n' +
        '生成要求：\n' +
        '1. residents：5~7 位公共居民网友，各带 style（发言风格一句话）。\n' +
        '2. posts：8~12 帖。至少 1 帖是树洞匿名帖（author 用 "@anon"）。' +
        '岛上的角色（char）**自然出演**：可能有一帖是他发的，也可能一帖都没有 —— ' +
        '别让社区围着某个人转（他不一定有名，这里不是粉丝群）。' +
        'author 写角色时用 "char:角色名"；如果这个角色这一帖选择匿名，写成 "char:角色名@anon"' +
        '（只有确实符合他性格时才匿名，不要默认全匿名）。其余帖子全部由居民发。\n' +
        '3. 每帖 comments 0~4 条，作者用居民名或 "char:角色名"（可选 @anon）或 "楼主"；' +
        '有的帖子就是没人回（0 条），别硬凑热闹。' +
        '角色回复属于偶发：这批内容里角色开口的次数别超过两三次。\n' +
        '4. minutesAgo：帖子 5~2880（分钟前），评论必须晚于所属帖子。\n' +
        '5. 语言像真实手机社区：口语、短句、有点生活气，别写鸡汤，别提 AI。\n' +
        '6. 【禁止复读人设】不许把角色卡里的设定标签、口头禅、金句、身份介绍搬进帖子或回复。' +
        '角色说话必须是在回应本楼这个具体的话题（说一件具体的事、一个具体的判断），' +
        '并且和行为场合像路人发帖 —— 不是自我介绍，不是人设说明书。\n' +
        '7. 【不要围着角色复读】居民之间要有自己的日常：找房子、加班、菜价、追剧、吐槽天气……' +
        '提到角色时也只是「顺嘴一提」，不要写成夸奖合集或人物侧写。\n' +
        '8. events：2~4 条岛上的小风闻（每条不超过 30 字）——具体、有生活气的小事' +
        '（谁家猫下崽、夜市休市、路口新开了个摊），不复述帖子内容，不提 AI。\n' +
        'JSON 结构：{"residents":[{"name":"..","style":".."}],' +
        '"posts":[{"board":"daily","author":"居民名|char:角色名|@anon","type":"normal|long|help",' +
        '"title":"..","content":"..","minutesAgo":120,' +
        '"comments":[{"author":"..","content":"..","minutesAgo":30}]}],' +
        '"events":[".."]} }' }
    ];
  }

  function replyMessages(fx, post, board, existing) {
    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);
    var lines = existing.slice(-8).map(function (c) {
      return (c.authorDisplay || '某人') + '：' + c.content;
    });
    /* v242 轻量地点：发帖挂了地点标签就让回应感知到（说得出「在哪儿」） */
    var placeLine = post.placeText ? '发帖地点：' + post.placeText + '\n' : '';

    return [
      { role: 'system', content:
        '你是「群声」社区的回帖导演。给下面这篇帖子生成一批回复。' +
        '只输出 JSON：{"comments":[{"author":"..","content":".."}]}，不要解释。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '\n' +
        '岛上的角色：' + (chars.join('；') || '暂无') + '\n' +
        '板块：' + board.name + '\n' +
        placeLine +
        '帖子' + (post.title ? '《' + post.title + '》' : '') + '：' + post.content.slice(0, 400) + '\n' +
        '已有回复：\n' + (lines.join('\n') || '（还没有人回）') + '\n\n' +
        '要求：\n' +
        '1. comments 3~6 条（用户点了催更就是想看到讨论热起来，别只给一条；没人可说才给 0 条）。\n' +
        '2. author 只能是居民名、岛上角色的 "char:角色名"（可选 "char:角色名@anon" 表示该角色这楼匿名），' +
        '或 "楼主"。**居民占多数** —— 这批回复里出现的角色最好不超过 1 位，聊的就是帖子本身，' +
        '不是给某人捧场。\n' +
        '3. 只让会刷这个板块、且真有话说的居民/角色开口；实在没人开口就输出空数组。\n' +
        '4. 回复像真人：短、口语、可以直接回应上面某条回复，别客套，别总结中心思想。\n' +
        '5. 【禁止复读人设】不许复述角色的设定标签/口头禅/金句，不许把他写成被围观的对象。' +
        '角色开口也只是在说自己对这个楼的看法，语气跟别人一样普通。' }
    ];
  }

  /* ------------------------------ 落库 ------------------------------ */

  /* list 不传 → 从 store 现读（已落库状态）；传了 → 在写入中的本地数组里找
     （seed 写入过程中居民账号刚 push、还没 putForum，必须看本地那份）。 */
  function findAccountByOwner(fx, ownerEntityId, list) {
    var src = list || forum.scopedForum('forumAccounts', fx.sandboxId);
    return src.filter(function (a) {
      return a.sandboxId === fx.sandboxId && a.ownerEntityId === ownerEntityId;
    })[0] || null;
  }

  /* author 写法：居民名 / "char:角色名" / "char:角色名@anon" / "@anon"。
     v216：「char:名字@anon」= 这个角色**这一帖/这一楼**选择匿名（账号内部照旧落
     真实 owner，公开层只露别名）—— 对应「char 可以选择匿不匿名」的口径。 */
  function resolveSeedAuthor(fx, raw, ctx, list) {
    var s = String(raw || '').trim();
    if (s === '@anon') {
      /* v218：匿名不再借 user 主号 —— 「我的帖子」按 authorAccountId 过滤，
         借主号 = 别人的匿名内容全挂到 user 头上。改借匿名池号
         （forum-core ensureSeed ⑤ 建的 ownerEntityId='anon-pool'）。 */
      var pool = findAccountByOwner(fx, 'anon-pool', list);
      return { accountId: pool ? pool.id : ctx.userMainId, anonymous: true };
    }
    var charRaw = s.indexOf('char:') === 0 ? s.slice(5).trim() : '';
    var charAnon = charRaw.slice(-5) === '@anon';
    var charName = charAnon ? charRaw.slice(0, charRaw.lastIndexOf('@anon')).trim() : charRaw;
    var owner = null;
    if (charName) {
      var ch = core.charsOfSandbox(fx.sandboxId).filter(function (c) { return c.name === charName; })[0];
      if (ch) owner = findAccountByOwner(fx, ch.id, list);
      if (owner && charAnon) return { accountId: owner.id, anonymous: true };
    } else {
      owner = findAccountByOwner(fx, 'gen:' + s, list);
    }
    if (!owner) owner = ctx.fallbackResident;
    return { accountId: owner ? owner.id : ctx.userMainId, anonymous: false };
  }

  function writeSeed(fx, data) {
    var sid = fx.sandboxId;
    /* store.get 返回深拷贝 —— 三张表各持一份引用改完统一 put 回去，
       push 到临时拷贝上会静默丢（working memory 那条坑）。 */
    var posts = (store_get('forumPosts') || []);
    var accounts = (store_get('forumAccounts') || []);
    var comments = (store_get('forumComments') || []);
    var created = { residents: 0, posts: 0, comments: 0, events: 0 };
    var now = Date.now();

    /* ① 居民账号（ownerEntityId = 'gen:名字'，与岛内真实 NPC 区分开） */
    (data.residents || []).forEach(function (r) {
      var name = String(r && r.name || '').trim();
      if (!name || findAccountByOwner(fx, 'gen:' + name)) return;
      accounts.push(forum.tagScope({
        id: forum.uid('fa'), ownerEntityId: 'gen:' + name, ownerType: 'resident',
        accountType: 'resident', displayName: name,
        handle: 'r_' + forum.strHash(sid + name).toString(36),
        avatarColor: '#e2d7c4', bio: String(r.style || ''), status: 'active',
        createdAt: forum.nowIso(), updatedAt: forum.nowIso()
      }, sid));
      created.residents++;
    });

    var userMain = forum.listOwnedForumAccounts(sid)
      .filter(function (a) { return a.accountType === 'main'; })[0];
    var fallbackResident = accounts.filter(function (a) {
      return a.sandboxId === sid && a.ownerType === 'resident';
    })[0];
    var ctx = { userMainId: userMain ? userMain.id : null, fallbackResident: fallbackResident };
    if (!ctx.userMainId) return { ok: false, message: '岛上还没有「我」的论坛账号' };

    function saveAll() {
      forum.putForum('forumAccounts', accounts);
      forum.putForum('forumPosts', posts);
      forum.putForum('forumComments', comments);
    }

    /* ② 帖子（createdAt 错落 = 社区有历史） */
    (data.posts || []).forEach(function (p) {
      var board = forum.listBoards(sid).filter(function (b) { return b.templateKey === p.board; })[0];
      var title = String(p.title || '').trim();
      var content = String(p.content || '').trim();
      if (!board || (!title && !content)) return;
      var who = resolveSeedAuthor(fx, p.author, ctx, accounts);
      var at = new Date(now - Math.max(1, Number(p.minutesAgo) || 60) * 60000).toISOString();
      var post = forum.tagScope({
        id: forum.uid('fp'),
        boardId: board.id,
        authorAccountId: who.accountId,
        authorDisplayMode: who.anonymous ? 'anonymous' : 'account',
        anonymousAlias: who.anonymous ? forum.anonymousAlias(sid, '', who.accountId) : '',
        postType: ['normal', 'long', 'help'].indexOf(p.type) >= 0 ? p.type : 'normal',
        title: title, content: content,
        visibility: 'public', allowRepost: true,
        sourceType: '', sourceId: '', sourceRef: '',
        assetRefs: [],
        /* v242：催更新帖可自带轻量地点（纯文字标签，≤20 字） */
        placeText: String(p.place || '').trim().slice(0, 20),
        status: 'active',
        createdAt: at, updatedAt: at
      }, sid);
      if (who.anonymous) post.anonymousAlias = forum.anonymousAlias(sid, post.id, who.accountId);
      posts.push(post);
      created.posts++;

      /* ③ 评论（晚于帖子，错峰） */
      var baseMin = Math.max(1, Number(p.minutesAgo) || 60);
      ((p.comments || [])).forEach(function (c, i) {
        var text = String(c && c.content || '').trim();
        if (!text) return;
        var isOwner = String(c.author || '') === '楼主';
        var cWho = isOwner ? { accountId: who.accountId, anonymous: who.anonymous }
                           : resolveSeedAuthor(fx, c.author, ctx, accounts);
        var cAt = new Date(now - Math.max(0, baseMin - Number(c.minutesAgo || 5)) * 60000).toISOString();
        comments.push(forum.tagScope({
          id: forum.uid('fc'),
          postId: post.id,
          parentId: null, rootCommentId: null,
          authorAccountId: cWho.accountId,
          isPostAuthor: cWho.accountId === who.accountId,
          /* 帖子本身就是匿名帖时不重复记（那种由 post.authorDisplayMode 统一决定） */
          anonymous: !!(cWho.anonymous && post.authorDisplayMode !== 'anonymous'),
          content: text,
          status: 'active',
          createdAt: cAt, updatedAt: cAt
        }, sid));
        created.comments++;
      });
    });

    /* ④ 世界事件（v245b）：风闻随种子/催更顺路进环形池（新在前、封顶 40） */
    created.events = forum.addWorldEvents(sid, data.events, 30);

    saveAll();
    return { ok: true, created: created };
  }

  /* 本文件内的 localStorage 兜底读 —— 不碰 store.get 的缓存语义差异，
     forum 内部读取本来就全走 store.get；这里只是省一层重复过滤。 */
  function store_get(key) { return Sleepy.store.get(key); }

  /* ------------------------------ 对外动作 ------------------------------ */

  /* 首次进岛补种子（幂等：seeded 标记在 forumSettingsBySandbox[sid]）。 */
  function ensureSeedContent(sandboxId, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    forum.ensureSeed(fx.sandboxId);

    var settings = forum.getForumMap('forumSettingsBySandbox', fx.sandboxId) || {};
    if (settings.seeded) { cb(null, { seeded: true, skipped: true }); return; }    ask(seedMessages(fx), function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data || !Array.isArray(data.posts) || !data.posts.length) {
        cb({ stage: 'parse', error: '生成结果不是能用的 JSON', raw: String(text || '').slice(0, 200) });
        return;
      }
      var r = writeSeed(fx, data);
      if (!r.ok) { cb({ stage: 'write', error: r.message }); return; }
      /* v245b：**合并写**，不许整对象覆写 —— writeSeed 里 addWorldEvents
         刚把 worldEvents 写进同一个映射，覆写会把它静默抹掉（冒烟抓过）。 */
      var st = forum.getForumMap('forumSettingsBySandbox', fx.sandboxId) || {};
      st.seeded = true;
      st.seededAt = forum.nowIso();
      forum.setForumMap('forumSettingsBySandbox', fx.sandboxId, st);
      cb(null, { seeded: true, created: r.created });
    });
  }

  /* 增量催更（user 2026-10-07：「是否可刷新」）：已种过的岛，催更 = 生成
     2~4 帖新帖追加（居民/char 都可能开口），不重置 seeded、不重复旧标题。
     60s 内存冷却，与 requestReplies 分开记。 */
  var lastMoreAt = 0;
  function genMore(sandboxId, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    if (Date.now() - lastMoreAt < 60000) {
      cb({ stage: 'cooldown', error: '刚催过，让大家喘口气' }); return;
    }
    var settings = forum.getForumMap('forumSettingsBySandbox', fx.sandboxId) || {};
    if (!settings.seeded) { cb({ stage: 'config', error: '先完成首轮种子' }); return; }

    var have = forum.scopedForum('forumPosts', fx.sandboxId)
      .map(function (p) { return p.title; }).filter(Boolean).slice(-20);
    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);
    var residents = forum.scopedForum('forumAccounts', fx.sandboxId)
      .filter(function (a) { return a.ownerType === 'resident'; })
      .map(function (a) { return a.displayName + (a.bio ? '（' + a.bio + '）' : ''); });

    ask([
      { role: 'system', content:
        '你是「群声」社区的内容导演。给这个已经营业的社区补充几帖新内容。' +
        '只输出 JSON：{"posts":[...]}，不要解释。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '\n' +
        '岛上的角色：' + (chars.join('；') || '暂无') + '\n' +
        '已有居民：' + (residents.join('、') || '暂无') + '\n' +
        '板块：' + forum.BOARD_TEMPLATES.map(function (b) { return b.key + '=' + b.name; }).join('、') + '\n' +
        '已有帖子标题（别重复）：' + (have.join(' / ') || '无') + '\n\n' +
        '要求：2~4 帖新帖，字段同前（board/author/type/title/content/minutesAgo/comments）；' +
        '可以带可选的 place 字段（岛上某个具体地点的文字标签，不超过 20 字，不定位现实）；' +
        '再带 1~3 条新的 events（岛上小风闻，每条不超过 30 字，别和已有的重复）；' +
        'author 只能是已有居民名、"char:角色名"（可选 "char:角色名@anon" 表示这个角色这一帖匿名）或 "@anon"；' +
        'minutesAgo 1~600；语言口语、有生活气，别提 AI。\n' +
        '【自然出演】角色可以出现也可以不出现，**这批里最好一帖都没有** —— 社区不是围着某一人转的地方。\n' +
        '【禁止复读人设】不许把角色的设定标签/口头禅/金句搬进帖子，不许写成夸奖合集或人物侧写。' }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data || !Array.isArray(data.posts) || !data.posts.length) {
        cb({ stage: 'parse', error: '生成结果不是能用的 JSON' }); return;
      }
      data.residents = data.residents || [];      /* 增量不新增居民 */
      var r = writeSeed(fx, data);
      if (!r.ok) { cb({ stage: 'write', error: r.message }); return; }
      lastMoreAt = Date.now();
      cb(null, { created: r.created });
      /* 催更扫尾：岛上还有投票帖就顺路安排一批人来投（静默，不挡主流程） */
      try { sweepVotes(fx.sandboxId); } catch (e) { /* 静默 */ }
    });
  }

  /* ------------------------ 单板块催更（v246b） ------------------------
     板块页自己的「催一下」：只给这一个板块生成 1~3 帖（不带动全岛）。
     复用 writeSeed 落库（board 强制成该板块的模板键，模型越权指别板块也不听）；
     events 不生成——那是全岛风景，归 genMore 管。60s 冷却按板块记。 */
  var lastBoardAt = {};
  function genBoard(sandboxId, boardId, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var board = forum.getBoard(boardId, fx.sandboxId);
    if (!board) { cb({ stage: 'config', error: '板块不在了' }); return; }
    if (Date.now() - (lastBoardAt[boardId] || 0) < 60000) {
      cb({ stage: 'cooldown', error: '刚催过这个板块，让大家喘口气' }); return;
    }
    var settings = forum.getForumMap('forumSettingsBySandbox', fx.sandboxId) || {};
    if (!settings.seeded) { cb({ stage: 'config', error: '先完成首轮种子' }); return; }

    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);
    var residents = forum.scopedForum('forumAccounts', fx.sandboxId)
      .filter(function (a) { return a.ownerType === 'resident'; })
      .map(function (a) { return a.displayName + (a.bio ? '（' + a.bio + '）' : ''); });
    var have = forum.scopedForum('forumPosts', fx.sandboxId)
      .filter(function (p) { return p.boardId === boardId; })
      .map(function (p) { return p.title; }).filter(Boolean).slice(-20);

    ask([
      { role: 'system', content:
        '你是「群声」社区的内容导演。只给指定的**一个板块**补充几帖新内容。' +
        '只输出 JSON：{"posts":[...]}，不要解释。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '\n' +
        '岛上的角色：' + (chars.join('；') || '暂无') + '\n' +
        '已有居民：' + (residents.join('、') || '暂无') + '\n' +
        '指定板块：' + board.name + '（' + String(board.description || '') + '。版规：' +
        String(board.rules || '') + '）\n' +
        '这个板块已有的帖子标题（别重复）：' + (have.join(' / ') || '无') + '\n\n' +
        '要求：\n' +
        '1. posts 1~3 帖，**全部属于指定板块**，帖子的内容要贴合这个板块的主题和版规。\n' +
        '2. 字段：title/content/minutesAgo（5~2880）/comments（0~3 条，author 同前）；' +
        '可选 place（≤20 字，不定位现实）；树洞板块的帖 author 用 "@anon"。\n' +
        '3. author 只能是已有居民名、"char:角色名"（可选 @anon）或 "@anon"；' +
        '【自然出演】这批里最好一帖角色都没有；【禁止复读人设】。\n' +
        '4. 语言口语、有生活气，别提 AI。' }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data || !Array.isArray(data.posts)) {
        cb({ stage: 'parse', error: '生成结果不是能用的 JSON' }); return;
      }
      data.posts.forEach(function (p) { p.board = board.templateKey; });   /* 越权指板块也不听 */
      data.residents = [];
      var r = writeSeed(fx, data);
      if (!r.ok) { cb({ stage: 'write', error: r.message }); return; }
      lastBoardAt[boardId] = Date.now();
      cb(null, { added: r.created.posts });
    });
  }

  /* char 收到分享后在聊天里回一句（user 2026-10-07：要像正常聊天一样回）。
     装配走 prompt-engine 同一套出口（compileCharacter / compileUserCore /
     compileWorldbook / compileRelation）—— 人设、世界书、关系记忆（含认知锁
     barrier）与正常聊天一致，不另写第二份小 prompt（有装配层时）。
     回应落库后写一条留痕记忆（「user 分享了帖子」是现实事件），进正常整理链路。
     60s 冷却按 chat 记；生成失败静默（不伪造回复）。 */
  var lastChatReactAt = {};
  function charReactToShare(opt, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(opt.sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var ch = core.findChar(opt.charId);
    if (!ch) { cb({ stage: 'config', error: '找不到这个人' }); return; }
    if (!Sleepy.api || !Sleepy.api.runChat) { cb({ stage: 'config', error: '没有模型接口' }); return; }
    if (Date.now() - (lastChatReactAt[opt.chatId] || 0) < 60000) {
      cb({ stage: 'cooldown', error: '刚回过话了' }); return;
    }
    lastChatReactAt[opt.chatId] = Date.now();

    var chat = Sleepy.chatStore.getChat(opt.chatId);
    var userId = (chat && chat.userId) ||
      (core.activeUserOnIsland ? (core.activeUserOnIsland() || {}).id : null);
    var PE = Sleepy.promptEngine;
    var attached = String(opt.attachedText || '');
    var situa = '【当前情境】user 在聊天里分享了一篇群声社区的帖子。' +
      '这是闲聊式的分享，用一句到两句自然的口语回应，像微信聊天，' +
      '不要总结全文，不要客套，不要提 AI。只输出回应本身。';

    var system;
    if (PE && PE.compileCharacter) {
      var recent = attached + ' ' + (opt.postTitle || '') + ' ' + String(opt.postContent || '');
      system = [
        PE.compileCharacter(opt.charId),
        PE.compileUserCore(userId),
        PE.compileWorldbook ? PE.compileWorldbook(opt.charId, recent) : '',
        PE.compileRelation ? PE.compileRelation(opt.charId, userId, 8) : '',
        situa
      ].filter(Boolean).join('\n\n');
    } else {
      /* 装配层不在（单测/降级）：退回人设摘要版 */
      system = '你在扮演「' + ch.name + '」。' +
        (String(ch.content || '').replace(/\s+/g, ' ').trim().slice(0, 160)) +
        ' ' + situa;
    }

    ask([
      { role: 'system', content: system },
      { role: 'user', content:
        '帖子标题：' + (opt.postTitle || '（无标题）') + '\n' +
        '帖子内容：' + String(opt.postContent || '').slice(0, 300) + '\n' +
        'user 的附言：' + (attached || '（没有，直接发的）') }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var reply = String(text || '').trim();
      if (!reply) { cb({ stage: 'parse', error: '空回应' }); return; }
      var msg = Sleepy.chatStore.addMessage(opt.chatId, {
        id: Sleepy.chatStore.newId(),
        role: 'assistant',
        type: 'text',
        content: reply.slice(0, 500),
        timestamp: Date.now()
      });
      /* 留痕记忆：分享行为进正常记忆链路（可被整理/向量检索），
         不改正史、不写帖子内容为亲历 —— 只是「user 分享过这帖」。 */
      if (userId && core.addMemory) {
        try {
          core.addMemory({
            charId: opt.charId, userId: userId, role: 'user',
            text: '在群声分享了帖子《' + (opt.postTitle || '无标题') + '》' +
              (attached ? '，附言：' + attached.slice(0, 40) : '')
          });
        } catch (e) { /* 记忆写失败不影响回应本身 */ }
      }
      cb(null, { message: msg });
    });
  }

  /* char 自己刷论坛后主动发一帖（user 2026-10-07：char 可不可以自己看了发帖）。
     装配同正常聊天（compileCharacter + compileWorldbook），产出结构化动作：
     post（落库）或 ignore（char 不想发 —— 允许沉默，不硬凑）。
     10 分钟冷却按 char 记；发帖成功给 user 主账号落一条 system 通知。 */
  var lastSelfPostAt = {};
  function askCharToPost(sandboxId, charId, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var ch = core.findChar(charId);
    if (!ch) { cb({ stage: 'config', error: '找不到这个人' }); return; }
    if (fx.primaryCharIds.indexOf(charId) < 0) {
      cb({ stage: 'config', error: '这个人不在这座岛上' }); return;
    }
    if (Date.now() - (lastSelfPostAt[charId] || 0) < 600000) {
      cb({ stage: 'cooldown', error: 'ta 刚发过帖，让内容缓缓' }); return;
    }
    var PE = Sleepy.promptEngine;
    var boards = forum.listBoards(fx.sandboxId)
      .map(function (b) { return b.templateKey + '=' + b.name; }).join('、');
    var sys = (PE && PE.compileCharacter)
      ? [PE.compileCharacter(charId),
         PE.compileWorldbook ? PE.compileWorldbook(charId, '') : '']
        .filter(Boolean).join('\n\n')
      : ('你在扮演「' + ch.name + '」。' + String(ch.content || '').slice(0, 160));

    /* char 匿名偏好（forumSettingsBySandbox 下 anonPrefByChar[charId]）：
       public（必须露脸）/ anon（必须匿名）/ auto（让 TA 自己按性格决定，默认）。 */
    var settingsMap = forum.getForumMap('forumSettingsBySandbox', fx.sandboxId) || {};
    var pref = (settingsMap.anonPrefByChar || {})[charId] || 'auto';
    var anonRule = pref === 'public'
      ? '这一帖必须公开身份（anonymous 只能是 false）。'
      : (pref === 'anon'
        ? '这一帖必须匿名（anonymous 只能是 true）。'
        : '你可以自己决定要不要藏起名字：说私事/见不得人的话就 anonymous=true，' +
          '平常一句话就用本名 anonymous=false。按你的性格选，别每帖都藏。');

    ask([
      { role: 'system', content: sys +
        '\n\n【当前情境】你闲下来刷了刷这座岛的公共论坛「群声」。' +
        '基于你的人设与近况，决定要不要发一帖。只输出 JSON：' +
        '{"action":"post|ignore","board":"板块key","title":"..","content":"..","anonymous":false}。' +
        '没得可说就输出 {"action":"ignore"} —— 允许沉默，别硬凑。\n' +
        '匿名：' + anonRule + '\n' +
        '【禁止复读人设】不要自我介绍、不要搬用口头禅/金句/设定标签，' +
        '也不要把社区当成自己的粉丝群：就事论事说一件具体的小事。' },
      { role: 'user', content: '板块：' + boards + '\n发帖要求：口语、短、像真实手机社区；不提 AI。' }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data || data.action !== 'post') { cb(null, { posted: false }); return; }
      var acc = findAccountByOwner(fx, charId);
      if (!acc) { cb({ stage: 'write', error: 'char 没有论坛账号' }); return; }
      var anon = pref === 'public' ? false : (pref === 'anon' ? true : !!data.anonymous);
      var r = forum.createPost({
        sandboxId: fx.sandboxId,
        boardId: (forum.listBoards(fx.sandboxId).filter(function (b) { return b.templateKey === data.board; })[0] || {}).id,
        accountId: acc.id,
        anonymous: anon,
        postType: 'normal',
        title: String(data.title || '').trim(),
        content: String(data.content || '').trim()
      });
      if (!r.ok) { cb({ stage: 'write', error: r.message }); return; }
      lastSelfPostAt[charId] = Date.now();
      /* 让「我」知道：ta 发帖了（system 通知，进消息中心） */
      var mainAcc = forum.listOwnedForumAccounts(fx.sandboxId)
        .filter(function (a) { return a.accountType === 'main'; })[0];
      if (mainAcc) {
        forum.notify({
          sandboxId: fx.sandboxId,
          recipientAccountId: mainAcc.id,
          category: 'system',
          actorName: ch.name,
          sourceType: 'post',
          sourceId: r.post.id,
          previewText: '在群声发了一帖《' + (r.post.title || '无标题') + '》'
        });
      }
      cb(null, { posted: true, post: r.post });
    });
  }

  /* 帖子催回复（详情页「催一下」/ user 发帖后延迟触发）。 */
  var lastReplyAt = {};            /* postId -> ts，内存冷却 60s，不持久化 */
  function requestReplies(postId, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(null);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var post = forum.getPost(postId, fx.sandboxId);
    /* v244：删帖（软删）后 4s 迟到的回应队列不能再给死帖生成内容 */
    if (!post || post.status !== 'active') { cb({ stage: 'config', error: '帖子不在了' }); return; }
    if (Date.now() - (lastReplyAt[postId] || 0) < 60000) {
      cb({ stage: 'cooldown', error: '刚催过，让大家喘口气' }); return;
    }
    var board = forum.getBoard(post.boardId, fx.sandboxId) || { name: '社区' };
    var existing = forum.listComments(postId, fx.sandboxId).map(function (c) {
      var pa = forum.publicAuthorOf(post, c.authorAccountId, fx.sandboxId);
      return { authorDisplay: pa.displayName, content: c.content };
    });

    /* 投票帖走投票导演（v240）：不生成回帖，生成选票（随口一句落评论）。 */
    var isVote = post.postType === 'vote' && post.vote;

    ask(isVote ? voteMessages(fx, post, board) : replyMessages(fx, post, board, existing), function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data) {
        cb({ stage: 'parse', error: '生成结果不是能用的 JSON' }); return;
      }
      if (isVote) {
        if (!Array.isArray(data.votes)) {
          cb({ stage: 'parse', error: '生成结果不是能用的 JSON' }); return;
        }
        var casted = applyVotes(fx, post, data);
        lastReplyAt[postId] = Date.now();
        cb(null, { voted: casted });
        return;
      }
      if (!Array.isArray(data.comments)) {
        cb({ stage: 'parse', error: '生成结果不是能用的 JSON' }); return;
      }
      var n = 0, now = Date.now();
      (data.comments || []).slice(0, 6).forEach(function (c, i) {
        var text2 = String(c && c.content || '').trim();
        var authorRaw = String(c && c.author || '').trim();
        if (!text2 || !authorRaw) return;
        var acc = null;
        if (authorRaw === '楼主') {
          acc = { accountId: post.authorAccountId };
        } else if (authorRaw.indexOf('char:') === 0) {
          var cRaw = authorRaw.slice(5).trim();
          var cAnon = cRaw.slice(-5) === '@anon';
          var cName = cAnon ? cRaw.slice(0, cRaw.lastIndexOf('@anon')).trim() : cRaw;
          var ch = core.charsOfSandbox(fx.sandboxId).filter(function (x) { return x.name === cName; })[0];
          acc = ch ? { accountId: (findAccountByOwner(fx, ch.id) || {}).id, anonymous: cAnon } : null;
        } else {
          acc = { accountId: (findAccountByOwner(fx, 'gen:' + authorRaw) || {}).id };
        }
        if (!acc || !acc.accountId) return;
        var r = forum.createComment({
          sandboxId: fx.sandboxId, postId: postId, accountId: acc.accountId,
          content: text2, anonymous: !!acc.anonymous
        });
        if (r.ok) n++;
      });
      lastReplyAt[postId] = Date.now();
      cb(null, { added: n });
    });
  }

  function replyCooldownLeft(postId) {
    return Math.max(0, 60000 - (Date.now() - (lastReplyAt[postId] || 0)));
  }

  /* ------------------------ 投票帖（v240）：安排大家来投 ------------------------
     口径（user 2026-10-16）：NPC/char 用**论坛身份**参与投票 —— 和回帖同一条
     队列回应机制，一次导演调用安排 2~5 人，各自按人设立场选选项、顺口留一句。
     投票不匿名（@anon 不收）：身份就是大小号本身，公开层走账号显示名投影。
     票随帖走（post.vote.votes），不另开表。 */

  function voteMessages(fx, post, board) {
    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);
    var sum = forum.voteSummary(post, fx.sandboxId);
    var optLines = sum.options.map(function (o, i) {
      return (i + 1) + '. ' + o + '（当前 ' + sum.counts[i] + ' 票）';
    });
    var voted = [];
    sum.voters.forEach(function (names) {
      names.forEach(function (n) { if (voted.indexOf(n) < 0) voted.push(n); });
    });

    return [
      { role: 'system', content:
        '你是「群声」社区的投票导演。这篇帖子发起了一个投票，安排岛上的人来投票。' +
        '只输出 JSON：{"votes":[{"author":"..","option":1,"say":".."}]}，不要解释。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '\n' +
        '岛上的角色：' + (chars.join('；') || '暂无') + '\n' +
        '板块：' + board.name + '\n' +
        (post.placeText ? '发帖地点：' + post.placeText + '\n' : '') +
        '帖子' + (post.title ? '《' + post.title + '》' : '') + '：' + String(post.content || '').slice(0, 300) + '\n' +
        '投票选项：\n' + optLines.join('\n') + '\n' +
        '已经投过票的：' + (voted.join('、') || '还没有人投') + '\n\n' +
        '要求：\n' +
        '1. votes 2~5 条；author 只能是居民名或 "char:角色名"（投票不匿名）；已经投过票的人不能再投。\n' +
        '2. option 是选项序号（1~' + sum.options.length + ' 的数字），按各人设和立场选，别全体扎堆同一个选项。\n' +
        '3. say 是投完随口说的一句（不超过 30 字），不想说话就给空串。\n' +
        '4. 只安排真会关心这个话题的人投；实在没人就输出空数组。' }
    ];
  }

  /* 模型输出落票 + 随口一句落评论。返回落了几票（撤票不算）。 */
  function applyVotes(fx, post, data) {
    var n = 0;
    (data.votes || []).slice(0, 5).forEach(function (v) {
      var authorRaw = String(v && v.author || '').trim();
      var idx = Number(v && v.option) - 1;
      var say = String(v && v.say || '').trim().slice(0, 60);
      if (!authorRaw) return;
      var acc = null;
      if (authorRaw.indexOf('char:') === 0) {
        var cName = authorRaw.slice(5).trim();
        var ch = core.charsOfSandbox(fx.sandboxId).filter(function (x) { return x.name === cName; })[0];
        acc = ch ? findAccountByOwner(fx, ch.id) : null;
      } else {
        acc = findAccountByOwner(fx, 'gen:' + authorRaw);
      }
      if (!acc || !acc.id) return;
      var r = forum.castVote(post.id, acc.id, idx, fx.sandboxId);
      if (!r.ok || r.changed === 'removed') return;
      n++;
      if (say) {
        forum.createComment({
          sandboxId: fx.sandboxId, postId: post.id, accountId: acc.id, content: say
        });
      }
    });
    return n;
  }

  /* 催更后的投票扫尾：岛上还有投票帖就挑最新一个安排一批人来投。
   90s 独立冷却；失败静默 —— 催更主流程不背这个锅。 */
  var lastVoteSweepAt = 0;
  function sweepVotes(sandboxId, cb) {
    cb = cb || function () {};
    if (Date.now() - lastVoteSweepAt < 90000) { cb(null, { skipped: true }); return; }
    var fx = forum.resolveContext(sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var posts = forum.scopedForum('forumPosts', fx.sandboxId)
      .filter(function (p) { return p && p.status === 'active' && p.postType === 'vote' && p.vote; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    if (!posts.length) { cb(null, { skipped: true }); return; }
    lastVoteSweepAt = Date.now();
    requestReplies(posts[0].id, cb);
  }

  /* user 发帖后的自动队列入口（page 层 setTimeout 调它，不在数据层挂定时器） */
  function queueReplies(postId, delayMs) {
    setTimeout(function () {
      requestReplies(postId, function () { /* 静默：失败留给手动催一下 */ });
    }, Math.max(0, delayMs || 4000));
  }

  /* char 在群声的匿名偏好：'auto'（TA 自己决定，默认）/ 'public' / 'anon'。 */
  function setAnonPref(sandboxId, charId, pref) {
    if (['auto', 'public', 'anon'].indexOf(pref) < 0) throw new Error('forum: 未知匿名偏好 ' + pref);
    var map = forum.getForumMap('forumSettingsBySandbox', sandboxId) || {};
    map.anonPrefByChar = map.anonPrefByChar || {};
    map.anonPrefByChar[charId] = pref;
    forum.setForumMap('forumSettingsBySandbox', sandboxId, map);
  }
  function getAnonPref(sandboxId, charId) {
    var map = forum.getForumMap('forumSettingsBySandbox', sandboxId) || {};
    return (map.anonPrefByChar || {})[charId] || 'auto';
  }


  /* ============================== v216：同人创作（真写一整篇） ==============================
     口径（user 2026-10-09）：同人创作板块要**真的产出正文**，不是聊创作进度；
     一次一篇，**要分自然段**（一千多字糊成一坨很难读）；点「追更」接着往下写，
     追更时把最近读者留言交给作者，**作者自己挑哪些听进去**（不保证每条都采纳）。 */

  /* 把模型输出规整成自然段数组：模型有时把 \n\n 写成 \n，这里按非空行切。
     ⚠️ 别自作聪明合并短行 —— 中文一个自然段常常就十几二十个字，
     按长度合并会把好好的段落吞掉（v216 首跑就是这么把 3 段并成 1 段的）。 */
  function parasOf(text) {
    return String(text || '').split(/\r?\n/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return !!t; });
  }

  function fanworkBoard(fx) {
    return forum.listBoards(fx.sandboxId).filter(function (b) { return b.templateKey === 'fanwork'; })[0];
  }

  /* 写一篇：accountId 是论坛身份（user 的小号 / 主号），topic 是 user 的题材提示。 */
  function writeFanwork(sandboxId, opt, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(sandboxId);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var board = fanworkBoard(fx);
    if (!board) { cb({ stage: 'config', error: '这个社区没有同人创作板块' }); return; }
    var accId = opt && opt.accountId;
    if (!accId) { cb({ stage: 'config', error: '还没选论坛身份' }); return; }
    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);

    ask([
      { role: 'system', content:
        '你是这座岛上一位写同人的网友，现在要给社区的同人创作板块**开一篇新文**。' +
        '你要真的写，不是聊创作计划。只输出 JSON：' +
        '{"title":"标题","paras":["第一段","第二段",...]}，不要解释、不要 markdown 围栏。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '\n' +
        '这座岛上的人：' + (chars.join('；') || '暂无') + '\n' +
        '楼主给的题材/要求：' + String((opt && opt.topic) || '（没说，你自己定）') + '\n\n' +
        '要求：\n' +
        '1. paras 是**自然段数组**，每段独立成段，一共写足一篇：1200~1800 字，' +
        '分成 6~12 段（别把所有字塞进一两个段落里，也不要一句话一段）。\n' +
        '2. 有开头有推进有收在一个念头上；可以留钩子方便以后追更，但这一篇本身要能单独读。\n' +
        '3. 写得像人：带具体的感官细节、对话、具体的犹豫。别写总结句，别写「这是第一篇」。\n' +
        '4. 不提 AI，不写与现实平台相关的内容，不碰现实政治与色情描写。' }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      var paras = parasOf(Array.isArray(data && data.paras) ? data.paras.join('\n\n') : '');
      if (!paras.length) { cb({ stage: 'parse', error: '这次没写出正文，可以再点一次' }); return; }
      var title = String((data && data.title) || '无题').trim();
      var body = paras.join('\n\n');
      var r = forum.createPost({
        sandboxId: fx.sandboxId, boardId: board.id, accountId: accId,
        anonymous: !!(opt && opt.anonymous),
        postType: 'long', title: title, content: body
      });
      if (!r.ok) { cb({ stage: 'write', error: r.message }); return; }
      var fw = {
        topic: String((opt && opt.topic) || '').trim(),
        chapters: [{
          id: forum.uid('fwc'), n: 1, title: title, paras: paras,
          createdAt: forum.nowIso(), heard: []
        }]
      };
      var u = forum.updatePost(r.post.id, { fanwork: fw }, fx.sandboxId);
      cb(null, { post: (u.ok ? u.post : r.post), paras: paras.length });
    });
  }

  /* 追更：把已有全文 + 最近读者留言交给作者，由作者自选采纳哪几条。 */
  function continueFanwork(postId, cb) {
    cb = cb || function () {};
    var fx = forum.resolveContext(null);
    if (!fx.ok) { cb({ stage: 'config', error: fx.message }); return; }
    var post = forum.getPost(postId, fx.sandboxId);
    if (!post || post.status !== 'active') { cb({ stage: 'config', error: '帖子不在了' }); return; }

    var comments = forum.listComments(postId, fx.sandboxId).slice(-10).map(function (c) {
      var pa = forum.publicAuthorOfComment(post, c, fx.sandboxId);
      return (pa.displayName || '某人') + '：' + String(c.content || '').slice(0, 120);
    });
    var fw = post.fanwork || { chapters: [] };
    var n = (fw.chapters || []).length;
    var tail = String(post.content || '').slice(-1200);   /* 只读尾巴：追更要接着上下文 */

    ask([
      { role: 'system', content:
        '你是这帖的作者，正在给自己的连载**追更下一节**。' +
        '读者在评论区留了些话 —— 你可以听一部分，也可以一条都不听，' +
        '但你自己的笔要稳：别为了迎合读者把人物写歪、别突然转换笔调。' +
        '只输出 JSON：{"title":"本节标题","paras":["..",".."],"heard":["被你采纳的那句读者留言"]}，不要解释。' },
      { role: 'user', content:
        '已有章节数：' + n + '\n' +
        '正文末尾：\n' + tail + '\n\n' +
        '最近读者留言：\n' + (comments.join('\n') || '（还没有人留言）') + '\n\n' +
        '要求：\n' +
        '1. 接着上面写下一节，600~1200 字，**分成 4~8 个自然段**（paras 数组），' +
        '每段独立成段。\n' +
        '2. 承接上文的人物与口吻；如果采纳了某条留言，heard 里写上那句原文摘要（没有就给空数组）。\n' +
        '3. 写具体的场景推进，不要写提纲，不要总结前文。' }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      var paras = parasOf(Array.isArray(data && data.paras) ? data.paras.join('\n\n') : '');
      if (!paras.length) { cb({ stage: 'parse', error: '这回没续出来，可以再试一次' }); return; }
      var title = String((data && data.title) || ('第 ' + (n + 1) + ' 节')).trim();
      var heard = Array.isArray(data && data.heard) ? data.heard.map(function (x) { return String(x).slice(0, 60); }) : [];
      var chapter = { id: forum.uid('fwc'), n: n + 1, title: title, paras: paras, createdAt: forum.nowIso(), heard: heard };
      var nextFw = JSON.parse(JSON.stringify(fw));
      nextFw.chapters = (nextFw.chapters || []).concat([chapter]);
      var body = String(post.content || '') + '\n\n—— ' + title + ' ——\n\n' + paras.join('\n\n');
      var u = forum.updatePost(post.id, { content: body, fanwork: nextFw }, fx.sandboxId);
      if (!u.ok) { cb({ stage: 'write', error: u.message }); return; }
      cb(null, { chapter: chapter, heard: heard.length, paras: paras.length });
    });
  }

  Sleepy.forumGen = {
    ensureSeedContent: ensureSeedContent,
    writeFanwork: writeFanwork,
    continueFanwork: continueFanwork,
    setAnonPref: setAnonPref,
    getAnonPref: getAnonPref,
    genMore: genMore,
    genBoard: genBoard,
    requestReplies: requestReplies,
    queueReplies: queueReplies,
    sweepVotes: sweepVotes,
    charReactToShare: charReactToShare,
    askCharToPost: askCharToPost,
    replyCooldownLeft: replyCooldownLeft,
    extractJson: extractJson,
    _setTransport: _setTransport
  };

})(window);
