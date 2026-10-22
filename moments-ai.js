/* ============================================================
   moments-ai.js — 朋友圈里的「角色自己动」
   ------------------------------------------------------------
   三件事：
     ① 角色自己发动态
     ② 有人评论 → 角色回来
     ③ 我发动态 → 角色来评论

   两条硬规矩（用户提的，也是这个项目的地基）：

     **不秒回。** 真人不会你一发就回。延迟几十秒，像「过一会儿才刷到」。
     秒回一眼就假，比不回还糟。

     **过认知锁。** 被挡在这条动态可见范围外的人，不评论也不回。
     不然一个还「没认识你」的人跑出来说话，世界观就破了。

   还有一条实现上的选择：**模型只写字，不碰数据**。
   它不认识 URL、不知道评论存在哪 —— 所以约定标签（[发] / [因为] / [不发]），
   前端负责解析、落库、写记忆。跟聊天里发表情那套是同一个思路。
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var PENDING_KEY = 'momentPending';
  var DELAY_MIN = 18;          /* 秒。下限别太小，太快就像机器人 */
  var DELAY_MAX = 55;
  var MEM_LIMIT = 14;          /* 提示词里带几条记忆（带太多又慢又贵） */
  var TICK_MS = 12000;

  /* ---------------------------- 文本清理 ---------------------------- */

  function cleanText(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/\*\*/g, '');
    t = t.replace(/^[\s"'“”‘’「」『』【】]+|[\s"'“”‘’「」『』【】]+$/g, '');
    t = t.replace(/^(朋友圈|动态|正文)\s*[:：]\s*/, '');
    t = t.replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  function escapeRe(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 解析「要不要发、发什么、为什么」。

     为什么按**行**解而不是按标签位置切：模型写标签的位置很随意
     （理由在前、理由在后、只写一行都见过）。第一版按「[因为] 的位置」
     前后切，结果「[因为] 有点闷 \n 正文」这种写法会把正文切没了 ——
     冒烟用例当场抓出来。

     规则：
       · 带标签的行 → 那行的内容归对应字段（[发]→正文 / [因为]→动机）
       · 没有标签的行 → 一律算正文
       · [不发] 且没写过 [发] → 他不想发

     最后一条是刻意的：**格式没对上也要尽量发出来**。
     宁可多发一条，也不要因为标签写歪了就一直没有动态 ——
     那样用户会以为这功能是坏的。 */
  function extractPost(raw) {
    var src = String(raw == null ? '' : raw).trim();
    if (!src) return null;

    var body = [];
    var reason = [];
    var img = '';
    var refused = false;
    var sawPost = false;

    src.split(/\r?\n/).forEach(function (ln) {
      var t = String(ln).trim();
      if (!t) return;
      var m = /^\[\s*(发|因为|不发|图)\s*\]\s*([\s\S]*)$/.exec(t);
      if (!m) { body.push(t); return; }
      if (m[1] === '不发') { refused = true; return; }
      var rest = m[2].trim();
      if (m[1] === '发') sawPost = true;
      if (!rest) return;
      if (m[1] === '发') body.push(rest);
      else if (m[1] === '图') img = rest.slice(0, 240);   /* B0：结构化 JSON 需要更长，120 切得断 */
      else reason.push(rest);
    });

    if (refused && !sawPost) return null;

    var text = cleanText(body.join('\n'));
    if (!text) return null;
    return {
      text: text.slice(0, 200),
      reason: cleanText(reason.join(' ')).slice(0, 120),
      imgDesc: img
    };
  }

  /* 评论只有一句话 —— 模型爱写小作文，砍到第一行 */
  function extractReply(raw, charName) {
    var s = cleanText(raw);
    if (!s) return '';
    if (/\[\s*(不回|不说|沉默)\s*\]/.test(s)) return '';
    if (charName) {
      s = s.replace(new RegExp('^\\s*' + escapeRe(charName) + '\\s*[：:]\\s*'), '');
    }
    s = cleanText(s.split('\n')[0]);
    return s.slice(0, 140);
  }

  /* ---------------------------- 提示词 ---------------------------- */

  function timeWord() {
    var h = new Date().getHours();
    if (h < 6) return '凌晨';
    if (h < 11) return '早上';
    if (h < 14) return '中午';
    if (h < 18) return '下午';
    if (h < 23) return '晚上';
    return '深夜';
  }

  function memLines(charId, limit) {
    if (!core.memoriesOfRoot) return [];
    var list = core.memoriesOfRoot(charId) || [];
    return list.slice(-(limit || MEM_LIMIT)).map(function (m) {
      return '- ' + (m.role === 'user' ? '对方说：' : '你说：') +
        String(m.text || '').slice(0, 90);
    });
  }

  /* 这个角色的人设 + 他记得的事。
     发动态和回评论都要它 —— 不然角色会变成「什么都不知道的复读机」。 */
  function baseSys(ch) {
    var out = ['你是「' + ch.name + '」。'];
    /* 人设唯一出口 compileCharacter；旧 slice(0,600) 截断已删（勘察 P0） */
    var personaBlock = (Sleepy.promptEngine && Sleepy.promptEngine.compileCharacter)
      ? Sleepy.promptEngine.compileCharacter(ch.id) : '';
    if (personaBlock) out.push(personaBlock);
    /* 状态签名已下线（2026-09-29）—— 不再注入 */
    out.push('');
    out.push('现在是' + timeWord() + '。');
    var mem = memLines(ch.id);
    if (mem.length) {
      out.push('【你记得的事】');
      out.push(mem.join('\n'));
    }
    return out.join('\n');
  }

  function recentMine(sb, charId, limit) {
    var list = core.scoped(Sleepy.momentsTab.all()).filter(function (m) {
      return m.characterId === charId;
    }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return list.slice(0, limit || 3);
  }

  function buildPostMessages(sb, ch) {
    var sys = [baseSys(ch)];
    var mine = recentMine(sb, ch.id);
    if (mine.length) {
      /* 让他知道自己最近发过什么 —— 不然同一个念头能连发三条 */
      sys.push('');
      sys.push('【你最近发过的朋友圈】');
      sys.push(mine.map(function (m) {
        return '- ' + String(m.text || (m.mediaId ? '（发过一张配图）' : '（空）')).slice(0, 40);
      }).join('\n'));
    }
    /* 生图接口可用才教 [图] 标签 —— 没接口写了也配不上图 */
    var canPic = Sleepy.imggen && Sleepy.imggen.readEnabled && Sleepy.imggen.readEnabled() &&
                 Sleepy.imggen.activeApi && Sleepy.imggen.activeApi();
    return [
      { role: 'system', content: sys.join('\n') },
      {
        role: 'user',
        content: '想发一条朋友圈就发，不想发就说不发。\n' +
          '想发的话，按这个格式回两行：\n' +
          '[发] 正文（不超过 60 字，用你自己的口气说话，别写引号）\n' +
          '[因为] 为什么想发这一条（一句话，写给你自己看，别人看不到）\n' +
          (canPic
            ? '想配一张图的话再加一行（别每条都配，真的拍了/想晒才配）：\n' +
              '[图] {"description":"画面描述，英文 tag 风格","contentType":"scene|object|person|mixed","shot":"auto|selfie|portrait|full|candid|group|scene","subjects":["user","char"]}\n' +
              '  （subjects 只写画面里真实出现的人：你是 "char"，用户是 "user"；食物/风景/宠物就留 []；写不了 JSON 才退回一句话描述）\n'
            : '') +
          '不想发就只回：[不发]'
      }
    ];
  }

  function commentLines(m) {
    var cs = (m.comments || []);
    if (!cs.length) return '';
    return '【下面已有的评论】\n' + cs.map(function (c) {
      return '- ' + (c.name || '?') + '：' + (c.text || '（发了个表情）');
    }).join('\n');
  }

  /* 转发的群声帖子（qsRef）：回应前现读原帖正文与留声 —— 只知道「TA 分享了」
     根本接不上话（user 2026-10-16 拍板）。帖子没了/被封/转非公开 → 空串，
     模型按群声规矩①「没看过就说没看过」，不编内容。 */
  function qsRefBlock(m) {
    if (!m || !m.qsRef || !Sleepy.forumShare || !Sleepy.forumShare.describeForModel) return '';
    var d = Sleepy.forumShare.describeForModel(m.qsRef);
    return d ? '\n【TA 转发的帖子原文（你点开看了）】\n' + d : '';
  }

  /* ---------------------------- ① 角色自己发 ---------------------------- */

  /* 让某个角色自己发一条。cb(err, item) —— item 为 null 表示他不想发。
     带 [图] 描述且生图接口可用时，描述会真的画出来挂到动态上（生图接口）。 */
  function askCharToPost(sb, charId, cb) {
    cb = cb || function () {};
    if (!Sleepy.api || !Sleepy.api.runChat) { cb('没有可用的模型接口'); return; }
    var ch = core.findChar(charId);
    if (!ch) { cb('找不到这个人'); return; }
    sb = sb || core.activeSandbox();

    var called = false;
    Sleepy.api.runChat(buildPostMessages(sb, ch), {
      onDone: function (cand, text) {
        if (called) return;
        called = true;
        var p = extractPost(text);
        if (!p) { cb(null, null); return; }        /* 他不想发 */
        var who = { kind: 'char', refId: ch.id, name: ch.name };
        var item = Sleepy.momentsTab.add({
          text: p.text,
          characterId: ch.id,
          name: ch.name,
          reason: p.reason
        });
        if (item) Sleepy.momentsTab.rememberMoment(item, who);

        /* 配图：画出来再挂上（图库存失败就算了，动态本身照发）。
           B0：[图] 里带结构化 JSON → 按 plan 画（主体由 subjects 决定，
           可能是自拍/他拍/纯风景）；还是一句话 → legacy：按正则猜 shot
           并默认锁 char（旧行为，标 legacyFallback 供验收定位）。 */
        if (item && p.imgDesc && Sleepy.imggen &&
            Sleepy.imggen.readEnabled() && Sleepy.imggen.activeApi()) {
          var parsed = Sleepy.imggen.parsePlanJson(p.imgDesc);
          var genOpts;
          if (parsed) {
            var bigUser = (core.defaultUserOfSandbox && sb)
              ? core.defaultUserOfSandbox(sb) : null;
            if (!bigUser && core.activeUserOnIsland) bigUser = core.activeUserOnIsland();
            var subs = [];
            parsed.subjects.forEach(function (k) {
              if (k === 'char') subs.push(Sleepy.imggen.subjectForChar(ch, parsed.shot));
              else if (k === 'user' && bigUser) subs.push(Sleepy.imggen.subjectForUser(bigUser, parsed.shot));
            });
            genOpts = { plan: {
              sender: 'char', contentType: parsed.contentType, shot: parsed.shot,
              subjects: subs, description: parsed.description,
              /* 正式接入：解析前声明数（含被白名单滤掉的非法引用）随 plan 对账，
                 声明与解析数不等就明确报错零请求，不静默减员。 */
              expectedSubjectCount: (parsed.subjectsDeclared != null)
                ? parsed.subjectsDeclared : undefined
            } };
          } else {
            var shot = /selfie|自拍|近照/i.test(p.imgDesc) ? 'selfie' : '';
            genOpts = {
              subject: p.imgDesc,
              faceText: Sleepy.imggen.faceTextFor(ch, shot),
              gender: ch,
              legacyFallback: true
            };
          }
          Sleepy.imggen.generate(genOpts).then(function (r) {
            if (r.ok && r.mediaId) {
              Sleepy.momentsTab.setMedia(item.id, { mediaId: r.mediaId, w: 0, h: 0 });
              pokeRefresh();
            }
          });
        }

        cb(null, item);
      },
      onFail: function (c, err) {
        if (called) return;
        called = true;
        cb((err && (err.message || err.error || err.stage)) || '模型没答上来');
      }
    }, false, { feature: 'moments' });
  }

  /* ---------------------------- ② 回复 ---------------------------- */

  /* 待回复队列：**读用 scoped、写用全量**（跟 chats 一个纪律）。
     把过滤过的列表写回去 = 别的岛的待回复被整批抹掉
     （2026-09-23 审计的 P0：schedule / tick / flush 原本都是这么写的）。 */
  function allPending() { return store.get(PENDING_KEY) || []; }
  function pendingAll() { return core.scoped(allPending()); }
  function savePending(list) { store.set(PENDING_KEY, list); }

  function schedule(kind, o) {
    /* 写路径：必须在**全量**上加/存 —— 见 allPending 的注释 */
    var list = allPending();
    var now = Date.now();
    /* 赞的反应用短延迟（被赞这种事不用装没看见），评论/回帖还是装一会儿 */
    var dMin = o.delayMin != null ? o.delayMin : DELAY_MIN;
    var dMax = o.delayMax != null ? o.delayMax : DELAY_MAX;
    var d = dMin + Math.random() * (dMax - dMin);
    var item = core.tagScope({
      id: core.newId('mp'),
      kind: kind,                       /* replyComment | commentOnPost | likeReact */
      momentId: o.momentId,
      charId: o.charId,
      charName: o.charName || '',
      toCommentId: o.toCommentId || null,
      dueAt: now + Math.round(d) * 1000,
      at: now
    });
    /* 其余的负载字段（likerName / text…）原样带上 ——
      以前只拷固定那几个，likeReact 的「谁赞的、赞的哪条」全丢了，
      记忆里写出来是「某人赞了我发的朋友圈：」（实测） */
    Object.keys(o).forEach(function (k) {
      if (k in item) return;
      item[k] = o[k];
    });
    list.push(item);
    savePending(list);
    return item;
  }

  /* 赞也有反应（用户点名要的）—— 角色**知道**谁赞了他。
     做法是写进记忆（他知道谁赞的、赞的是哪条），聊天里提得起来；
     **不自动蹦评论** —— 被赞还条条回话太吵了。
     走同一个延迟队列，但用短延迟：被赞这种事不用装没看见。 */
  function onLike(momentId, charId, liker) {
    var M = Sleepy.momentsTab;
    var m = M.byId(momentId);
    if (!m || !M.canSee(m, charId, 'char')) return;    /* 看不见的赞不认（认知锁） */
    var ch = core.findChar(charId);
    if (!ch) return;
    schedule('likeReact', {
      momentId: momentId,
      charId: charId,
      charName: ch.name,
      likerName: (liker && liker.name) || '某人',
      text: String(m.text || '（配图）').slice(0, 60),
      delayMin: 6, delayMax: 20
    });
  }

  function shuffle(a) {
    var out = a.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /* 这件事该谁来接？返回 [{kind:'char', refId, name}]。
     规则从紧到松：
       ① 你**指名回了某人** → 只有他接（别人不会来插嘴，不然很吵）
       ② 动态是角色发的   → 作者自己接
       ③ 再随机挑一个在场的角色（评论区不止一个人说话才热闹）
     全部都要过认知锁 —— 看不见这条动态的人不参与。 */
  function pickResponders(m, comment, sb) {
    var M = Sleepy.momentsTab;
    var out = [];
    /* must = user 显式点名的（回复了他的评论 / @ 了他）—— 必接，不走决策 */
    function add(who, must) {
      if (!who || who.kind !== 'char' || !who.refId) return;
      if (!M.canSee(m, who.refId, 'char')) return;
      var hit = out.filter(function (x) { return x.refId === who.refId; })[0];
      if (hit) { if (must) hit.must = true; return; }
      out.push({ kind: 'char', refId: who.refId, name: who.name, must: !!must });
    }

    if (comment && comment.replyTo) {
      var tgt = (m.comments || []).filter(function (c) { return c.id === comment.replyTo; })[0];
      if (tgt && tgt.kind === 'char') {
        add({ kind: 'char', refId: tgt.refId, name: tgt.name }, true);
        return out.slice(0, 1);
      }
    }

    /* 用户发动态时 @ 了谁（「提醒谁看」）→ 被提醒的优先来接 */
    (m.mentions || []).forEach(function (id) {
      var hit = (M.peopleIn(sb) || []).filter(function (p) { return p.kind === 'char' && p.refId === id; })[0];
      if (hit) add(hit, true);
    });

    if (m.characterId) add({ kind: 'char', refId: m.characterId, name: m.name });

    var others = (M.peopleIn(sb) || []).filter(function (p) {
      return p.kind === 'char' && p.refId !== (m.characterId || '');
    });
    /* forEach(add) 会把数组索引当第二个参数（must）传进去 —— 必须包一层 */
    shuffle(others).slice(0, 1).forEach(function (o) { add(o); });

    return out.slice(0, 2);
  }

  /* 用户这边发生了事 → 排几个「过一会儿回」。返回排上的队。 */
  function onUserAction(kind, momentId, comment) {
    var M = Sleepy.momentsTab;
    var m = M.byId(momentId);
    if (!m) return [];
    var sb = core.activeSandbox();
    var picks = pickResponders(m, comment, sb);
    return picks.map(function (p) {
      return schedule(kind === 'post' ? 'commentOnPost' : 'replyComment', {
        momentId: momentId,
        charId: p.refId,
        charName: p.name,
        toCommentId: comment ? comment.id : null,
        must: !!p.must
      });
    });
  }

  /* 队列跑完之后要通知界面重画 —— 不然过一会儿真有人回了，
     用户看到的还是老样子，只能自己去点刷新（实测就是这样，
     会以为「自动回复没生效」）。
     单槽而不是数组：同一时刻只可能有一个朋友圈屏活着。 */
  var refreshHook = null;
  function setRefresh(fn) { refreshHook = fn; }
  function pokeRefresh() {
    if (!refreshHook) return;
    try { refreshHook(); } catch (e) { /* 页面已经不在，忽略 */ }
  }

  /* ---------------------------- 读图 ----------------------------
     动态带图（user 发的 or 角色生图配的）→ 角色看到的是真图
     （多模态 content 数组），不再是「（只有一张配图）」。
     图取不到（图库被清 / 读失败）就原样退回文字占位。 */
  function withMomentImage(m, msgs, next) {
    if (!m || !m.mediaId || !Sleepy.media || !Sleepy.media.dataURL) { next(msgs); return; }
    Sleepy.media.dataURL(m.mediaId).then(function (d) {
      if (d) {
        msgs = msgs.slice();
        msgs[1] = {
          role: msgs[1].role,
          content: [
            { type: 'text', text: String(msgs[1].content) },
            { type: 'image_url', image_url: { url: d } }
          ]
        };
      }
      next(msgs);
    });
  }

  function askReplyToComment(m, ch, tgt, done) {
    var sys = baseSys(ch) + '\n\n' +
      '【你正在朋友圈里】\n' +
      '这条动态：' + String(m.text || '（只有一张配图，见' + (m.mediaId ? '下图' : '原文') + '）').slice(0, 120) + '\n' +
      qsRefBlock(m) + '\n' +
      commentLines(m);
    var other = (m.comments || []).filter(function (c) { return c.id !== tgt.id; })
      .slice(-2).map(function (c) {
        return '（还有人说过：' + (c.name || '?') + '：' + String(c.text || '（表情）').slice(0, 30) + '）';
      }).join('\n');

    var user = '「' + (tgt.name || '某人') + '」在下面说：「' +
      (tgt.text || '（发了个表情）') + '」' + (other ? '\n' + other : '') + '\n' +
      '回一句（不超过 40 字，口语一点，别写引号、别解释、不要写你的名字），只回这一句。';

    withMomentImage(m, [{ role: 'system', content: sys }, { role: 'user', content: user }], function (msgs) {
      runReply(msgs, ch, function (err, text) {
        if (err || !text) { done(err); return; }
        var r = Sleepy.momentsTab.addComment(m.id, { kind: 'char', refId: ch.id, name: ch.name },
          text, { replyTo: tgt.id });
        if (r && r.ok) {
          remember(ch, '我在朋友圈回了「' + (tgt.name || '某人') + '」：' + text, m);
          pokeRefresh();
        }
        done(null, r);
      });
    });
  }

  function askCommentOnPost(m, ch, done) {
    var sys = baseSys(ch) + '\n\n【你正在朋友圈里】';
    var user = '「' + (m.name || '对方') + '」刚发了条动态：「' +
      String(m.text || '（只有一张配图，见' + (m.mediaId ? '下图' : '原文') + '）').slice(0, 120) + '」' +
      qsRefBlock(m) +
      (commentLines(m) ? '\n' + commentLines(m) : '') + '\n' +
      '你在下面留一条评论（不超过 40 字，口语一点，别写引号、别解释、不要写你的名字），只回这一句。';

    withMomentImage(m, [{ role: 'system', content: sys }, { role: 'user', content: user }], function (msgs) {
      runReply(msgs, ch, function (err, text) {
        if (err || !text) { done(err); return; }
        var r = Sleepy.momentsTab.addComment(m.id, { kind: 'char', refId: ch.id, name: ch.name }, text, {});
        if (r && r.ok) {
          remember(ch, '我在「' + (m.name || '对方') + '」的动态下评论了：' + text, m);
          pokeRefresh();
        }
        done(null, r);
      });
    });
  }

  function runReply(messages, ch, done) {
    if (!Sleepy.api || !Sleepy.api.runChat) { done('没有可用的模型接口'); return; }
    var called = false;
    Sleepy.api.runChat(messages, {
      onDone: function (cand, text) {
        if (called) return;
        called = true;
        done(null, extractReply(text, ch.name));
      },
      onFail: function (c, err) {
        if (called) return;
        called = true;
        done((err && (err.message || err.error || err.stage)) || '模型没答上来');
      }
    }, false, { feature: 'moments' });
  }

  /* 回完要记下来 —— 用户要的「朋友圈和记忆挂钩」是双向的：
     他发的记进记忆，他回的也记。这样聊天里提起来他接得上。 */
  function remember(ch, line, m) {
    if (!core.addMemory) return;
    var rootId = core.rootIdOf(ch.id) || ch.id;
    var cause = m && m.text ? '（起因：' + String(m.text).slice(0, 50) + '）' : '';
    // m 传 null = 这条记忆没有「起因的动态」（比如单纯被赞）
    core.addMemory({
      rootId: rootId,
      fromCharId: ch.id,
      toUserId: null,
      role: 'assistant',
      text: (cause + line).slice(0, 500)
    });
  }

  /* ---------------------------- 队列 ---------------------------- */

  var running = false;

  /* ---------------------------- 反应决策步 ----------------------------

     用户定的原则（2026-09-17，原文要点）：
       user 允许角色看朋友圈，意味着角色**可以选择**提起，
       但不意味着每条都必须汇报阅读理解。
       行为由人设、关系状态、当前心绪和事件重要度共同决定。

     所以在「挑中谁」和「写评论」之间加一层决策：模型看完全部材料
     （动态、已有评论、和 user 的最近聊天、手头待办、自己最近的活跃度）
     自己选一个对待方式。外面套两道**不花 token 的硬护栏**：
       · 近 1 小时在朋友圈互动 ≥ 2 次 → 强制划过去（频率抑制）
       · 被 user 显式点名（回复 / @）的必接 —— 点名的不能凉拌 */

  var ACT_WINDOW = 60 * 60 * 1000;
  var ACT_CAP = 2;

  function recentActivity(charId) {
    var now = Date.now();
    var count = 0;
    core.scoped(Sleepy.momentsTab.all()).forEach(function (m) {
      (m.comments || []).forEach(function (c) {
        if (c.kind === 'char' && c.refId === charId && now - (c.at || 0) < ACT_WINDOW) count++;
      });
      (m.likes || []).forEach(function (l) {
        if (l.kind === 'char' && l.refId === charId && now - (l.at || 0) < ACT_WINDOW) count++;
      });
    });
    return count;
  }

  /* 最近和 user 的聊天 —— 「是不是刚聊过」「是不是在闹矛盾」看这个 */
  function chatExcerpt(charId) {
    if (!Sleepy.chatStore) return [];
    /* 双匹配（同 page-app 的 openChatWith）：只按角色找会读到另一个身份
       刚聊过的内容，「是不是刚聊过 / 在闹矛盾」就判错了。 */
    var one = Sleepy.chatStore.chatOf ? Sleepy.chatStore.chatOf(charId) : null;
    var list = one ? [one] : [];
    if (!list.length) return [];
    list.sort(function (a, b) {
      function lastOf(c) {
        return c.messages && c.messages.length ? c.messages[c.messages.length - 1].timestamp : 0;
      }
      return lastOf(b) - lastOf(a);
    });
    return (list[0].messages || []).slice(-4).map(function (x) {
      return '- ' + (x.role === 'user' ? '对方说：' : '你说：') +
        String(x.type === 'transfer' ? '[转账]' : (x.content || '')).slice(0, 60);
    });
  }

  function todoLines() {
    var list = core.scoped(store.get('todos')) || [];
    return list.filter(function (t) { return !t.done && t.text; })
      .slice(0, 5).map(function (t) { return '- ' + t.text; });
  }

  /* 解析决策。宽容原则同 extractPost：模型想说的话不因格式没对上而丢 ——
     没有标签但写了字 → 当评论；真什么都不想给 → 才是 skip。 */
  function extractDecision(raw) {
    var str = String(raw == null ? '' : raw).trim();
    if (!str) return { kind: 'skip' };
    var later = /^\[\s*later\s*[:\uFF1A]\s*(\d{1,3})\s*\]\s*([\s\S]*)$/.exec(str);
    if (later) {
      return { kind: 'later', minutes: Math.min(60, Math.max(1, parseInt(later[1], 10) || 5)) };
    }
    var m = /^\[\s*(skip|like|comment|private)\s*\]\s*([\s\S]*)$/.exec(str);
    if (m) {
      var rest = cleanText(m[2]);
      if (m[1] === 'skip') return { kind: 'skip' };
      if (m[1] === 'like') return { kind: 'like' };   /* 点赞不需要内容 */
      if (!rest) return { kind: 'skip' };
      if (m[1] === 'private') return { kind: 'private', text: rest.slice(0, 140) };
      return { kind: 'comment', text: rest.slice(0, 140) };
    }
    var text = cleanText(str.split('\n')[0]);
    return text ? { kind: 'comment', text: text.slice(0, 140) } : { kind: 'skip' };
  }

  function buildDecisionMessages(m, ch, tgt) {
    var sys = [baseSys(ch)];
    var chat = chatExcerpt(ch.id);
    if (chat.length) {
      sys.push('【你们最近的聊天】');
      sys.push(chat.join('\n'));
    }
    var todo = todoLines();
    if (todo.length) {
      sys.push('【你手头的事（待办）】');
      sys.push(todo.join('\n'));
    }
    sys.push('');
    sys.push('【这条动态】' + (m.name || '某人') + '：' + String(m.text || '（只有一张配图）').slice(0, 100));
    var cl = commentLines(m);
    if (cl) sys.push(cl);
    sys.push('');
    sys.push('【你最近一小时在朋友圈的互动】已经 ' + recentActivity(ch.id) + ' 次。');

    var ask = tgt
      ? '「' + (tgt.name || '某人') + '」在下面说：' + (tgt.text || '（发了个表情）') + '。'
      : '';
    ask += '决定要怎么对待这条朋友圈，只回一行标签：\n' +
      '[skip] 划过去了，不回应\n' +
      '[like] 只点个赞，不说话\n' +
      '[comment] 你的评论内容（跟在标签后面，40 字内）\n' +
      '[later: 分钟] 现在不想搭理，过一会儿再说（60 以内）\n' +
      '[private] 想私聊说（跟你想说的话）\n' +
      '按你的性格和你们现在的关系来 —— 没感觉就大方划过去，不用客套。';

    return [
      { role: 'system', content: sys.join('\n') },
      { role: 'user', content: ask }
    ];
  }

  function decide(item, m, ch, tgt, done) {
    if (!Sleepy.api || !Sleepy.api.runChat) { done('没有可用的模型接口'); return; }
    var called = false;
    /* 带图的动态：先取真图（多模态），取不到就纯文字 —— 再进决策 */
    withMomentImage(m, buildDecisionMessages(m, ch, tgt), function (msgs) {
      Sleepy.api.runChat(msgs, {
        onDone: function (cand, text) {
          if (called) return;
          called = true;
          done(null, extractDecision(text));
        },
        onFail: function (c, err) {
          if (called) return;
          called = true;
          done((err && (err.message || err.error || err.stage)) || '模型没答上来');
        }
      }, false, { feature: 'moments' });
    });
  }

  function runOne(item, done) {
    done = done || function () {};
    var M = Sleepy.momentsTab;
    var m = M.byId(item.momentId);
    if (!m) { done(); return; }
    /* 认知锁：看不见这条动态的人不参与（发的人选了可见范围） */
    if (!M.canSee(m, item.charId, 'char')) { done(); return; }
    var ch = core.findChar(item.charId);
    if (!ch) { done(); return; }

    if (item.kind === 'likeReact') {
      /* 被赞的「反应」= 记进记忆（他知道谁赞了他、赞的是哪条），
         聊天里提得起来。**不自动蹦评论** —— 被赞还条条回话太吵了。 */
      remember(ch, '「' + (item.likerName || '某人') + '」赞了我发的朋友圈：' + (item.text || ''), null);
      done();
      return;
    }

    var tgt = item.kind === 'replyComment'
      ? (m.comments || []).filter(function (c) { return c.id === item.toCommentId; })[0]
      : null;
    if (item.kind === 'replyComment' && !tgt) { done(); return; }

    /* 被 user 显式点名的（回复 / @）必接 —— 直接写，不过决策 */
    if (item.must) {
      if (item.kind === 'replyComment') askReplyToComment(m, ch, tgt, function () { done(); });
      else askCommentOnPost(m, ch, function () { done(); });
      return;
    }

    /* 硬护栏：近 1 小时互动太多 → 强制划过去（频率抑制） */
    if (recentActivity(item.charId) >= ACT_CAP) {
      remember(ch, '我在朋友圈刷了不少别人的动态，这会儿不想再说话了。', null);
      done();
      return;
    }

    decide(item, m, ch, tgt, function (err, d) {
      if (err || !d) { done(); return; }
      applyDecision(item, m, ch, tgt, d, done);
    });
  }

  function applyDecision(item, m, ch, tgt, d, done) {
    if (d.kind === 'skip') {
      /* 留痕（用户选的）：「刷到了但没说话」也是一种状态，
         之后聊天里他能想起那天看到了没吭声。 */
      remember(ch, '我在朋友圈刷到「' + (m.name || '某人') + '」的动态（' +
        String(m.text || '（配图）').slice(0, 40) + '），看了一眼没说话。', null);
      done();
      return;
    }
    if (d.kind === 'like') {
      var lr = Sleepy.momentsTab.toggleLike(m.id, { kind: 'char', refId: ch.id, name: ch.name });
      if (lr && lr.ok && lr.liked) remember(ch, '我给「' + (m.name || '某人') + '」的动态点了个赞。', null);
      pokeRefresh();
      done();
      return;
    }
    if (d.kind === 'later') {
      /* 延后：重新排一个 N 分钟后的同款任务（到时候再走一次决策） */
      schedule(item.kind, {
        momentId: m.id, charId: ch.id, charName: ch.name,
        toCommentId: tgt ? tgt.id : null,
        /* schedule 的延迟单位是**秒**，这里传分钟 —— 30 分钟会变成 30 秒（实测） */
        must: !!item.must, delayMin: d.minutes * 60, delayMax: d.minutes * 60 + 30
      });
      done();
      return;
    }
    if (d.kind === 'private') {
      postPrivate(ch, m, d.text, done);
      return;
    }
    /* comment：决策和内容是同一次调用给的 */
    var r = Sleepy.momentsTab.addComment(m.id, { kind: 'char', refId: ch.id, name: ch.name },
      d.text, { replyTo: tgt ? tgt.id : null });
    if (r && r.ok) {
      remember(ch, tgt
        ? '我在朋友圈回了「' + (tgt.name || '某人') + '」：' + d.text
        : '我在「' + (m.name || '某人') + '」的动态下评论了：' + d.text, m);
      pokeRefresh();
    }
    done();
  }

  /* 私聊提起：找到（或建一条）跟这个角色的会话，把话插到末尾。
     聊天 App 里打开就能看见 —— 不做推送通知（真后台是另一批）。 */
  function postPrivate(ch, m, text, done) {
    if (!Sleepy.chatStore) { done(); return; }
    var cs = Sleepy.chatStore;
    /* 只认「当前账号 × 这个角色」那一条 —— 同一个角色被大号和小号分别加过时
       是两条独立会话，只看 characterId 会读到别的身份刚聊过的内容，
       「是不是刚聊过 / 是不是在闹矛盾」就判错了。 */
    var chat = cs.chatOf(ch.id);
    if (!chat) chat = cs.createChat(ch.name, ch.id);
    cs.addMessage(chat.id, {
      id: cs.newId(),
      role: 'assistant',
      type: 'text',
      content: text,
      timestamp: Date.now()
    });
    remember(ch, '我在私聊里跟「' + (m.name || '对方') + '」提起了朋友圈那条：' + text, m);
    pokeRefresh();
    done();
  }

  /* 每次只跑一条：并发打模型既费钱，又会让同一个角色一口气说好几句
     —— 那比不回还假。 */
  function tick(done) {
    if (running) return;
    var list = pendingAll();
    var now = Date.now();
    var due = list.filter(function (p) { return (p.dueAt || 0) <= now; });
    if (!due.length) { if (done) done(0); return; }

    var head = due[0];
    running = true;
    /* 只从**全量**里摘掉这一条 —— 拿 scoped 的结果回写会抹掉别的岛的待回复 */
    savePending(allPending().filter(function (p) { return p.id !== head.id; }));
    runOne(head, function () {
      running = false;
      if (done) done(1);
    });
  }

  /* 让所有还没到点的立刻到期 —— 只给「我现在就想看」的调试用 */
  function flush() {
    /* 只让**本岛**的立刻到期，但写回**全量**（否则抹掉别的岛的待回复） */
    var list = pendingAll();
    var mine = {};
    list.forEach(function (p) { mine[p.id] = true; });
    var all = allPending();
    var now = Date.now();
    all.forEach(function (p) { if (mine[p.id] && p.dueAt > now) p.dueAt = now; });
    savePending(all);
    return list.length;
  }

  /* 清「本岛」的待回复 —— **默认语义就该是这个**。
     以前是 `savePending([])`，等于把别的岛的待回复一起清掉，
     跟 schedule / tick 那个 P0 是同一类坑（用户 2026-09-23 验收时点名要改）。
     老条目没有 sandboxId 的（迁移前）按纪律不动（同 core.removeSandbox 的取舍）——
     scoped() 虽然对每座岛都返回它，但清队列/删房一律不碰没盖章的老数据。
     返回清掉的条数。 */
  function clearPending() {
    var all = allPending();
    var sid = core.scopeId();
    /* 还没分房（老状态）：scoped() 本来就返回全部，那「本岛」就是全部 */
    var keep = sid ? all.filter(function (p) { return p.sandboxId !== sid; }) : [];
    var gone = all.length - keep.length;
    if (gone) savePending(keep);
    return gone;
  }

  /* 真·全局清空。名字必须写明「全部」，别在别处顺手用它 ——
     想让某座岛安静下来，用 clearPending()。 */
  function clearAllPending() { savePending([]); }

  var timer = null;
  function start() {
    if (timer) return;
    timer = global.setInterval(function () { tick(); }, TICK_MS);
  }

  Sleepy.momentsAI = {
    extractPost: extractPost,
    extractReply: extractReply,
    buildPostMessages: buildPostMessages,
    pickResponders: pickResponders,
    extractDecision: extractDecision,
    recentActivity: recentActivity,
    onUserAction: onUserAction,
    onLike: onLike,
    askCharToPost: askCharToPost,
    schedule: schedule,
    pending: pendingAll,
    tick: tick,
    flush: flush,
    clearPending: clearPending,
    clearAllPending: clearAllPending,
    setRefresh: setRefresh,
    start: start,
    DELAY_MIN: DELAY_MIN,
    DELAY_MAX: DELAY_MAX
  };

  start();
})(window);
