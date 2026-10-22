/* ============================================================
   forum-share.js — 群声分享层（施工卡-群声-v1 Batch C）
   职责：① 统一群声分享 payload（私聊 / 群聊共用一份，禁双轨）；
         ② 分享前的权限复检（删帖 / 封禁 / 关转发 / 无权限）；
         ③ 真实会话候选（只来自当前岛）；
         ④ 写入 chat / group 消息并落 forumShares 台账；
         ⑤ 聊天侧卡片的共用 DOM 渲染（一份实现，两个页面吃）。

   数据真源：sandboxId + sourcePostId。卡片上的摘要只是**显示缓存**，
   打开时必须重新读公开投影并复检（openShare 里做），绝不缓存可绕权全文。

   匿名红线：payload 只带公开投影的 displayName / anonymous 布尔，
   永不带真实 accountId 映射 —— 转发不能成为身份泄露手段（总纲 §六）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var forum = Sleepy.forum;
  var store = Sleepy.store;

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function excerpt(s, n) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* ------------------------------ ① payload ------------------------------ */

  /* 实时构建分享 payload —— 每次分享都现读帖子公开投影，
     不吃任何缓存。权限不过就给 reason，不给半截数据。 */
  function buildPayload(sandboxId, postId, senderAccountId, attachedText) {
    var post = forum.getPost(postId, sandboxId);
    if (!post || post.status === 'deleted') return { ok: false, reason: 'deleted' };
    if (post.status === 'blocked') return { ok: false, reason: 'blocked' };
    if (post.visibility && post.visibility !== 'public') {
      /* 首轮只有 public 帖可分享；后续批次接板块限定 / 仅关注者 */
      return { ok: false, reason: 'no-perm' };
    }
    if (post.allowRepost === false) return { ok: false, reason: 'no-repost' };

    var board = forum.getBoard(post.boardId, sandboxId);
    var pa = forum.publicAuthorOf(post, post.authorAccountId, sandboxId);
    var sender = senderAccountId ? forum.getAccount(senderAccountId, sandboxId) : null;

    return {
      ok: true,
      payload: {
        type: 'qunsheng-share',
        sandboxId: sandboxId,
        sourcePostId: post.id,
        boardName: board ? board.name : '社区',
        author: { displayName: pa.displayName, anonymous: !!pa.anonymous },
        title: post.title || '',
        excerpt: excerpt(post.content, 60),
        stats: {
          comments: forum.listComments(post.id, sandboxId).length,
          reposts: forum.repostCount(post.id, sandboxId)
        },
        attachedText: String(attachedText || ''),
        /* 故意不带 senderAccountId：payload 是「接收方可见的公开摘要」，
           分享者身份由消息本身的 role/发送人承载；台账写入时显式传。 */
        senderName: sender ? sender.displayName : '我',
        createdAt: forum.nowIso()
      }
    };
  }

  /* ------------------------------ ② 候选目标 ------------------------------ */

  /* 只来自当前 sandboxId 的真实会话（施工单 §C-4）：
     孤岛不禁群聊 —— 有没有群聊以真实数据为准。 */
  function listTargets(sandboxId) {
    var chats = [];
    (Sleepy.chatStore && Sleepy.chatStore.viewChats
      ? Sleepy.chatStore.viewChats()
      : []).forEach(function (c) {
        if (c && c.sandboxId === sandboxId && c.characterId) {
          var ch = Sleepy.chatStore.findCharacter(c.characterId);
          chats.push({ kind: 'chat', id: c.id, name: ch ? ch.name : '对话' });
        }
      });
    var groups = [];
    (Sleepy.groupStore ? Sleepy.groupStore.listGroups() : []).forEach(function (g) {
      if (g && g.sandboxId === sandboxId) {
        groups.push({ kind: 'group', id: g.id, name: g.name || '群聊' });
      }
    });
    return { chats: chats, groups: groups };
  }

  /* ------------------------------ ③ 台账 ------------------------------ */

  function recordShare(payload, targetType, targetId, senderAccountId) {
    var all = store.get('forumShares') || [];
    /* 重复分享不算错：同一个帖子 + 同一个目标 + 同一个发送身份已存在 → dup 提示 */
    var dup = all.some(function (r) {
      return r.sandboxId === payload.sandboxId &&
        r.sourcePostId === payload.sourcePostId &&
        r.targetType === targetType && r.targetId === targetId &&
        r.senderAccountId === senderAccountId;
    });
    all.push(forum.tagScope({
      id: forum.uid('fsh'),
      sandboxId: payload.sandboxId,
      sourcePostId: payload.sourcePostId,
      senderAccountId: senderAccountId,
      targetType: targetType,            /* 'chat' | 'group' | 'moments' */
      targetId: targetId,
      attachedText: payload.attachedText,
      createdAt: payload.createdAt
    }, payload.sandboxId));
    store.set('forumShares', all);
    return { dup: dup };
  }

  /* ------------------------------ ④ 写入会话 ------------------------------ */

  function shareToChat(opt) {
    var payload = buildPayload(opt.sandboxId, opt.postId, opt.senderAccountId, opt.attachedText);
    if (!payload.ok) return payload;

    var chat = Sleepy.chatStore && Sleepy.chatStore.getChat
      ? Sleepy.chatStore.getChat(opt.chatId) : null;
    if (!chat || chat.sandboxId !== opt.sandboxId) return { ok: false, reason: 'bad-target' };

    var rec = recordShare(payload.payload, 'chat', opt.chatId, opt.senderAccountId);
    Sleepy.chatStore.addMessage(opt.chatId, {
      id: Sleepy.chatStore.newId(),
      role: 'user',
      type: 'qunsheng-share',
      content: String(opt.attachedText || ''),
      timestamp: Date.now(),
      qs: payload.payload
    });
    return { ok: true, dup: rec.dup, messageId: null };
  }

  function shareToGroup(opt) {
    var payload = buildPayload(opt.sandboxId, opt.postId, opt.senderAccountId, opt.attachedText);
    if (!payload.ok) return payload;

    var g = Sleepy.groupStore && Sleepy.groupStore.findGroup
      ? Sleepy.groupStore.findGroup(opt.groupId) : null;
    if (!g || g.sandboxId !== opt.sandboxId) return { ok: false, reason: 'bad-target' };

    var rec = recordShare(payload.payload, 'group', opt.groupId, opt.senderAccountId);
    Sleepy.groupStore.addMessage(opt.groupId, {
      senderKind: 'user',
      senderAccountId: opt.groupMemberAccountId || null,
      type: 'qunsheng-share',
      content: String(opt.attachedText || ''),
      qs: payload.payload
    });
    return { ok: true, dup: rec.dup };
  }

  /* 公开转帖（转发到我的主页）：只存 sourcePostId + 附言，不复制原帖。 */
  function repostToProfile(opt) {
    var payload = buildPayload(opt.sandboxId, opt.postId, opt.senderAccountId, opt.attachedText);
    if (!payload.ok) return payload;
    var all = store.get('forumReposts') || [];
    var rec = recordShare(payload.payload, 'profile', opt.senderAccountId, opt.senderAccountId);
    all.push(forum.tagScope({
      id: forum.uid('frp'),
      sandboxId: opt.sandboxId,
      sourcePostId: opt.postId,
      senderAccountId: opt.senderAccountId,
      attachedText: String(opt.attachedText || ''),
      createdAt: forum.nowIso()
    }, opt.sandboxId));
    store.set('forumReposts', all);
    return { ok: true, dup: rec.dup };
  }

  /* 帷境公开投影（施工单 §E-1）：只读 wjWorks 的公开层。
     严禁进入投影：privateCastIds / sourceMaterials / 创作手记 / 隐藏章节。
     成文内容仍以 workId 现读（wj-read 那边），论坛只存引用与公开摘要。 */
  function wjProjection(workId) {
    if (!Sleepy.wj || !Sleepy.wj.get) return null;
    var w = Sleepy.wj.get(workId);
    if (!w || w.status === 'draft') return null;      /* 未开帷的草稿不进论坛 */
    var summary = '';
    try {
      var chs = (w.chapters || []).filter(function (c) { return c.status === 'ready'; });
      if (chs.length) {
        var paras = chs[0].paras || [];
        summary = excerpt((paras[0] || {}).text || '', 60);
      }
    } catch (e) { /* 结构老的存档：summary 留空不炸 */ }
    return {
      sourceWorkId: w.id,
      publicTitle: w.title || '未命名剧本',
      summary: summary,
      canonStatus: w.reality || 'story',
      chapterCount: (w.chapters || []).length
    };
  }

  /* 朋友圈引用（施工单 §E-3）：写一条带 qsRef 的朋友圈，评论不写回群声。 */
  function shareToMoments(opt) {
    var payload = buildPayload(opt.sandboxId, opt.postId, opt.senderAccountId, opt.attachedText);
    if (!payload.ok) return payload;
    if (!Sleepy.momentsTab || !Sleepy.momentsTab.add) return { ok: false, reason: 'bad-target' };

    var rec = recordShare(payload.payload, 'moments', 'moments', opt.senderAccountId);
    Sleepy.momentsTab.add({
      text: String(opt.attachedText || '').trim() ||
        '分享了一篇群声帖子《' + (payload.payload.title || '无标题') + '》',
      name: payload.payload.senderName || '我',
      qsRef: {
        sandboxId: payload.payload.sandboxId,
        sourcePostId: payload.payload.sourcePostId,
        boardName: payload.payload.boardName,
        authorName: payload.payload.author.displayName,
        title: payload.payload.title || excerpt(payload.payload.excerpt, 30),
        stats: payload.payload.stats
      }
    });
    return { ok: true, dup: rec.dup };
  }

  /* ------------------------------ ⑤ 打开复检 ------------------------------ */

  /* 分享回执（施工单 §D-2 / 总纲 §十二）：只写状态不写聊天正文。
     接收方点开卡片时调用：给台账最新一条对应分享盖 openedAt，
     并给发送者落一条 receipt 通知。已回应（replyRef）首轮不做、不伪造。 */
  function markOpened(opt) {
    var shares = store.get('forumShares') || [];
    var hit = null;
    for (var i = shares.length - 1; i >= 0; i--) {
      var r = shares[i];
      if (r && r.sandboxId === opt.sandboxId && r.sourcePostId === opt.sourcePostId &&
          r.targetType === opt.targetType && r.targetId === opt.targetId && !r.openedAt) {
        hit = r;
        break;
      }
    }
    if (!hit) return false;
    hit.openedAt = forum.nowIso();
    store.set('forumShares', shares);
    forum.notify({
      sandboxId: opt.sandboxId,
      recipientAccountId: hit.senderAccountId,
      category: 'receipt',
      actorName: opt.openerName || '对方',
      sourceType: 'post',
      sourceId: opt.sourcePostId,
      previewText: '打开了你分享的帖子'
    });

    /* 认知候选（施工单 §E-4）：接收方是 char 时，他「知道 user 分享过帖子给自己」
       —— 总纲 §七.2 允许的知情，familiar 档，绝不自动 confirmed。 */
    var recvAcc = forum.getAccount(hit.senderAccountId, opt.sandboxId);   /* 发送者 */
    var openAcc = getAccountByEntity(opt.sandboxId, opt.openerEntityId);
    if (openAcc && openAcc.ownerType === 'char' && recvAcc && recvAcc.ownerType === 'user') {
      forum.addKnowledge({
        sandboxId: opt.sandboxId,
        observerEntityId: openAcc.ownerEntityId,
        subjectType: 'forumAccount',
        subjectKey: 'share:' + recvAcc.id,
        subjectName: recvAcc.displayName,
        state: 'familiar',
        evidenceRefs: [opt.sourcePostId]
      });
    }
    return true;
  }

  /* 按 ownerEntityId 找账号（回执认知用；查不到返回 null）。 */
  function getAccountByEntity(sandboxId, ownerEntityId) {
    if (!ownerEntityId) return null;
    var hit = forum.scopedForum('forumAccounts', sandboxId).filter(function (a) {
      return a.ownerEntityId === ownerEntityId;
    })[0];
    return hit || null;
  }

  /* 聊天卡点开时**重新**读投影复检 —— 摘要只是显示缓存。
     reason: deleted | blocked | no-perm（UI 显示占位，不保留全文）。 */
  function checkOpen(sandboxId, postId) {
    var post = forum.getPost(postId, sandboxId);
    if (!post || post.status === 'deleted') return { ok: false, reason: 'deleted' };
    if (post.status === 'blocked') return { ok: false, reason: 'blocked' };
    if (post.visibility && post.visibility !== 'public') return { ok: false, reason: 'no-perm' };
    return { ok: true };
  }

  /* ------------------------------ ⑥ 卡片渲染（共用） ------------------------------ */

  var STYLE_ID = 'qs-share-card-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      /* 视觉照搬 demo .chat-card（248px 米白卡 + 蓝眉行 + 宋体标题） */
      '.qs-share-card{width:248px;max-width:100%;background:#faf7ef;border:1px solid #bcb4a8;cursor:pointer;overflow:hidden}',
      '.qs-share-top{padding:9px 10px 7px;color:#315d68;font-size:8px;font-weight:800;letter-spacing:.1em}',
      '.qs-share-body{padding:0 10px 9px;min-width:0}',
      '.qs-share-body b{display:block;font:700 13px/1.42 "Songti SC","STSong",serif;color:#25231f;word-break:break-word}',
      '.qs-share-body p{margin:5px 0 0;color:#756f65;font-size:9px;line-height:1.5;word-break:break-word}',
      '.qs-share-dead{padding:2px 0 6px;color:#756f65;font-size:10px;line-height:1.6}',
      '.qs-share-dead b{font:400 11px/1.5 inherit;color:#25231f}',
      '.qs-share-foot{display:flex;justify-content:space-between;padding:7px 10px;border-top:1px solid #d8d0c2;color:#756f65;font-size:8px}'
    ].join('');
    document.head.appendChild(st);
  }

  /* 视觉照搬 demo .chat-card：米白底 + 蓝眉行 + 宋体标题 + 留声数脚注。
     chat 页和群页都调这一个 —— 不许各长一张卡。 */
  function cardEl(msg, onOpen) {
    ensureStyle();
    var qs = (msg && msg.qs) || {};
    var card = h('div', 'qs-share-card');
    card.appendChild(h('div', 'qs-share-top', '群声 · ' + (qs.boardName || '社区')));

    var body = h('div', 'qs-share-body');
    var live = null;
    if (qs.sandboxId && qs.sourcePostId) live = checkOpen(qs.sandboxId, qs.sourcePostId);

    if (live && !live.ok) {
      /* 降级状态：不保留可继续传播的全文（施工单 §C-5） */
      var dead = h('div', 'qs-share-dead');
      dead.appendChild(h('b', null,
        live.reason === 'deleted' ? '原帖已由作者删除' :
        live.reason === 'blocked' ? '该帖子已被封禁' : '你没有查看这个帖子的权限'));
      body.appendChild(dead);
      card.appendChild(body);
      return card;
    }

    var title = qs.title || excerpt(qs.excerpt, 30) || '（无标题）';
    body.appendChild(h('b', null, title));
    var sub = (qs.author && qs.author.displayName ? qs.author.displayName : '') +
      (qs.excerpt && qs.title ? ' · ' + excerpt(qs.excerpt, 40) : '');
    if (sub) body.appendChild(h('p', null, sub));
    card.appendChild(body);

    var foot = h('div', 'qs-share-foot');
    var st = qs.stats || {};
    foot.appendChild(h('span', null, (st.comments || 0) + ' 条留声'));
    foot.appendChild(h('span', null, '打开原帖'));
    card.appendChild(foot);

    card.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof onOpen === 'function') onOpen(qs);
    });
    return card;
  }

  /* ------------------------------ ⑦ 模型侧展开 ------------------------------ */

  /* 朋友圈引用喂模型时**现读原帖**（user 2026-10-16 拍板：char/NPC 看不到
     正文和评论就没法接话）。qsRef 摘要只是「知道有这么回事」的档；
     帖子已删 / 被封 / 转非公开 → 返回 null，调用方退回旧档（只知道分享过）。
     匿名纪律不变：作者与留声一律走公开投影，绝不露账号 id。
     纯本地读（store），无出站；正文/留声都截断，不挤模型窗口。 */
  function describeForModel(qsRef) {
    if (!qsRef || !qsRef.sandboxId || !qsRef.sourcePostId) return null;
    if (!checkOpen(qsRef.sandboxId, qsRef.sourcePostId).ok) return null;
    var post = forum.getPost(qsRef.sourcePostId, qsRef.sandboxId);
    if (!post) return null;
    var pa = forum.publicAuthorOf(post, post.authorAccountId, qsRef.sandboxId);
    var out = [
      '这是群声「' + (qsRef.boardName || '社区') + '」板块的一篇帖子：',
      '《' + (post.title || '（无标题）') + '》 作者：' + pa.displayName
    ];
    var body = String(post.content || '').replace(/\s+/g, ' ').trim();
    if (body) {
      out.push(body.length > 300 ? body.slice(0, 300) + '……（后文略）' : body);
    }
    /* v242 轻量地点：发帖挂了地点标签就一并交代（说得出「在哪儿」） */
    if (post.placeText) out.push('发帖地点：' + post.placeText);
    /* 投票帖：把选项和当前票况一并交代 —— 不然 TA 连在投什么都不知道 */
    if (post.postType === 'vote' && post.vote) {
      var vs = forum.voteSummary(post, qsRef.sandboxId);
      out.push('这是一个投票（当前 ' + vs.total + ' 人已投）：');
      vs.options.forEach(function (o, i) {
        out.push('- ' + o + '：' + vs.counts[i] + ' 票');
      });
    }
    var cs = forum.listComments(post.id, qsRef.sandboxId) || [];
    if (cs.length) {
      out.push('帖下的留声（最新 ' + Math.min(cs.length, 5) + ' 条）：');
      cs.slice(-5).forEach(function (c) {
        var ca = forum.publicAuthorOfComment(post, c, qsRef.sandboxId);
        out.push('- ' + ca.displayName + '：' + excerpt(c.content, 50));
      });
    } else {
      out.push('帖下还没有留声。');
    }
    return out.join('\n');
  }

  /* ------------------------------ ⑧ 回执·已回应（v247b） ------------------------------ */

  /* 接收方在分享落地的会话里**开口**了 → 给分享者补一条「回应了」回执。
     口径：
     · chat：只认接收方 char 的消息（msg.role === 'char'）—— user 自己
       再说话不算（v1 的分享者就是 user）；
     · group：只认 char/NPC 成员的消息（senderKind char|npc）—— user 的
       群消息是分享者本人的，不算回应；
     · 只认**已打开**（openedAt 有）且还没标过回应的最近一条分享；
       一条分享只回执一次；通知走 notify（居民收件人自己会被滤掉）。 */
  function onConversationMessage(targetType, targetId, msg) {
    if (!msg) return false;
    var shares = store.get('forumShares') || [];
    var hit = null;
    for (var i = shares.length - 1; i >= 0; i--) {
      var r = shares[i];
      if (!r || r.targetType !== targetType || r.targetId !== targetId) continue;
      if (!r.openedAt || r.repliedAt) continue;
      hit = r;
      break;
    }
    if (!hit) return false;

    var respond = false;
    var actorName = '对方';
    if (targetType === 'chat') {
      respond = msg.role === 'char';
      var chat = (Sleepy.chatStore && Sleepy.chatStore.getChat)
        ? Sleepy.chatStore.getChat(targetId) : null;
      var ch = (chat && chat.characterId && Sleepy.core && Sleepy.core.findChar)
        ? Sleepy.core.findChar(chat.characterId) : null;
      actorName = (ch && ch.name) || '对方';
    } else if (targetType === 'group') {
      respond = msg.senderKind === 'char' || msg.senderKind === 'npc';
      var gs = Sleepy.groupStore;
      if (gs && gs.findMember && gs.accountMeta) {
        actorName = gs.accountMeta(gs.findMember(targetId, msg.senderAccountId)).name;
      }
    }
    if (!respond) return false;

    hit.repliedAt = forum.nowIso();
    store.set('forumShares', shares);
    forum.notify({
      sandboxId: hit.sandboxId,
      recipientAccountId: hit.senderAccountId,
      category: 'receipt',
      actorName: actorName,
      sourceType: 'post',
      sourceId: hit.sourcePostId,
      previewText: '回应了你分享的帖子'
    });
    return true;
  }

  /* ------------------------------ 导出 ------------------------------ */

  Sleepy.forumShare = {
    buildPayload: buildPayload,
    listTargets: listTargets,
    shareToChat: shareToChat,
    shareToGroup: shareToGroup,
    repostToProfile: repostToProfile,
    shareToMoments: shareToMoments,
    wjProjection: wjProjection,
    checkOpen: checkOpen,
    describeForModel: describeForModel,
    onConversationMessage: onConversationMessage,
    markOpened: markOpened,
    cardEl: cardEl
  };

})(window);
