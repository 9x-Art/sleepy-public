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
    });
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
        '2. posts：8~12 帖。其中至少 2 帖由岛上的角色发（符合各自人设与常看板块），' +
        '至少 1 帖是树洞匿名帖（author 用 "@anon"），至少 1 帖发在 fanwork（同人创作：' +
        '聊创作进度、有感而发的短评、虚构角色讨论——居民是「写同人的网友」，不是帷境作者本人）。其余由居民发。\n' +
        '3. 每帖 comments 0~4 条，作者用居民名或 "char:角色名" 或 "楼主"；' +
        '有的帖子就是没人回（0 条），别硬凑热闹。\n' +
        '4. minutesAgo：帖子 5~2880（分钟前），评论必须晚于所属帖子。\n' +
        '5. 语言像真实手机社区：口语、短句、有点生活气，别写鸡汤，别提 AI。\n' +
        'JSON 结构：{"residents":[{"name":"..","style":".."}],' +
        '"posts":[{"board":"daily","author":"居民名|char:角色名|@anon","type":"normal|long|help",' +
        '"title":"..","content":"..","minutesAgo":120,' +
        '"comments":[{"author":"..","content":"..","minutesAgo":30}]}]}' }
    ];
  }

  function replyMessages(fx, post, board, existing) {
    var chars = fx.primaryCharIds.map(function (id) { return core.findChar(id); })
      .filter(Boolean).map(personaLine);
    var lines = existing.slice(-8).map(function (c) {
      return (c.authorDisplay || '某人') + '：' + c.content;
    });

    return [
      { role: 'system', content:
        '你是「群声」社区的回帖导演。给下面这篇帖子生成一批回复。' +
        '只输出 JSON：{"comments":[{"author":"..","content":".."}]}，不要解释。' },
      { role: 'user', content:
        '社区：' + fx.sandboxName + '\n' +
        '岛上的角色：' + (chars.join('；') || '暂无') + '\n' +
        '板块：' + board.name + '\n' +
        '帖子' + (post.title ? '《' + post.title + '》' : '') + '：' + post.content.slice(0, 400) + '\n' +
        '已有回复：\n' + (lines.join('\n') || '（还没有人回）') + '\n\n' +
        '要求：\n' +
        '1. comments 0~4 条；author 只能是岛上角色的 "char:角色名" 或居民名（若帖子的作者就是某个角色，他可以以 "楼主" 出现）。\n' +
        '2. 只让会刷这个板块、且真有话说的角色/居民开口；没话说的就输出空数组。\n' +
        '3. 回复像真人：短、口语、可以直接回应上面某条回复，别客套，别总结中心思想。' }
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

  function resolveSeedAuthor(fx, raw, ctx, list) {
    var s = String(raw || '').trim();
    if (s === '@anon') {
      return { accountId: ctx.userMainId, anonymous: true };       /* 匿名树洞：借 user 主号发，公开层只露别名 */
    }
    var charName = s.indexOf('char:') === 0 ? s.slice(5).trim() : '';
    var owner = null;
    if (charName) {
      var ch = core.charsOfSandbox(fx.sandboxId).filter(function (c) { return c.name === charName; })[0];
      if (ch) owner = findAccountByOwner(fx, ch.id, list);
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
    var created = { residents: 0, posts: 0, comments: 0 };
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
        assetRefs: [], placeText: '',
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
          content: text,
          status: 'active',
          createdAt: cAt, updatedAt: cAt
        }, sid));
        created.comments++;
      });
    });

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
      forum.setForumMap('forumSettingsBySandbox', fx.sandboxId, {
        seeded: true, seededAt: forum.nowIso()
      });
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
        'author 只能是已有居民名或 "char:角色名" 或 "@anon"；minutesAgo 1~600；' +
        '语言口语、有生活气，别提 AI。' }
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

    ask([
      { role: 'system', content: sys +
        '\n\n【当前情境】你闲下来刷了刷这座岛的公共论坛「群声」。' +
        '基于你的人设与近况，决定要不要发一帖。只输出 JSON：' +
        '{"action":"post|ignore","board":"板块key","title":"..","content":".."}。' +
        '没得可说就输出 {"action":"ignore"} —— 允许沉默，别硬凑。' },
      { role: 'user', content: '板块：' + boards + '\n发帖要求：口语、短、像真实手机社区；不提 AI。' }
    ], function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data || data.action !== 'post') { cb(null, { posted: false }); return; }
      var acc = findAccountByOwner(fx, charId);
      if (!acc) { cb({ stage: 'write', error: 'char 没有论坛账号' }); return; }
      var r = forum.createPost({
        sandboxId: fx.sandboxId,
        boardId: (forum.listBoards(fx.sandboxId).filter(function (b) { return b.templateKey === data.board; })[0] || {}).id,
        accountId: acc.id,
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
    if (!post) { cb({ stage: 'config', error: '帖子不在了' }); return; }
    if (Date.now() - (lastReplyAt[postId] || 0) < 60000) {
      cb({ stage: 'cooldown', error: '刚催过，让大家喘口气' }); return;
    }
    var board = forum.getBoard(post.boardId, fx.sandboxId) || { name: '社区' };
    var existing = forum.listComments(postId, fx.sandboxId).map(function (c) {
      var pa = forum.publicAuthorOf(post, c.authorAccountId, fx.sandboxId);
      return { authorDisplay: pa.displayName, content: c.content };
    });

    ask(replyMessages(fx, post, board, existing), function (err, text) {
      if (err) { cb(err); return; }
      var data = extractJson(text);
      if (!data || !Array.isArray(data.comments)) {
        cb({ stage: 'parse', error: '生成结果不是能用的 JSON' }); return;
      }
      var n = 0, now = Date.now();
      (data.comments || []).slice(0, 4).forEach(function (c, i) {
        var text2 = String(c && c.content || '').trim();
        var authorRaw = String(c && c.author || '').trim();
        if (!text2 || !authorRaw) return;
        var acc = null;
        if (authorRaw === '楼主') {
          acc = { accountId: post.authorAccountId };
        } else if (authorRaw.indexOf('char:') === 0) {
          var ch = core.charsOfSandbox(fx.sandboxId).filter(function (x) { return x.name === authorRaw.slice(5).trim(); })[0];
          acc = ch ? { accountId: (findAccountByOwner(fx, ch.id) || {}).id } : null;
        } else {
          acc = { accountId: (findAccountByOwner(fx, 'gen:' + authorRaw) || {}).id };
        }
        if (!acc || !acc.accountId) return;
        var r = forum.createComment({
          sandboxId: fx.sandboxId, postId: postId, accountId: acc.accountId, content: text2
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

  /* user 发帖后的自动队列入口（page 层 setTimeout 调它，不在数据层挂定时器） */
  function queueReplies(postId, delayMs) {
    setTimeout(function () {
      requestReplies(postId, function () { /* 静默：失败留给手动催一下 */ });
    }, Math.max(0, delayMs || 4000));
  }

  Sleepy.forumGen = {
    ensureSeedContent: ensureSeedContent,
    genMore: genMore,
    requestReplies: requestReplies,
    queueReplies: queueReplies,
    charReactToShare: charReactToShare,
    askCharToPost: askCharToPost,
    replyCooldownLeft: replyCooldownLeft,
    extractJson: extractJson,
    _setTransport: _setTransport
  };

})(window);
