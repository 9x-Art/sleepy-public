/* ============================================================
   page-moments.js — 朋友圈（聊天 App 的第 3 屏 · 房内信息流）

   《聊天 App · 核心架构》：「朋友圈＝房内信息流」。
   这一屏现在是**活的**：能发、能赞、能评论，而且——

   · **谁都能发**：我（当前马甲）和这间房里的任何一个角色
     （造物主可以替角色发 —— 这是配置台「捏人」的自然延伸）
   · **谁都能互动**：每条动态下的赞和评论都可以选身份
     （我 / 角色 chips），谁赞的、谁说的，记录上分得清清楚楚
   · **微信式封面**：顶部壁纸可换（URL），右上角是自己的头像

   数据（moments，一条 = 一个动态；赞和评论内嵌，不另开表）：
     { id, characterId, name, text, at, sandboxId,
       likes:    [{ id, kind:'mask'|'char', refId, name, at }],
       comments: [{ id, kind, refId, name, text, at }] }
   kind='mask' → 我的哪张马甲发的；kind='char' → 哪个角色发的。
   壁纸单存：momentWall: [{ id, url, sandboxId, userId }]（**一间房里每张脸各一张**；
   老数据没有 userId 的当这座岛的默认，见 wallFor）。

   读写规矩和别处一致：**读**走 core.scoped()（只看得见本房的），
   **写**拿全量按 id 找到那条再落盘 —— 拿过滤过的列表回写会抹掉别的房的。

   依赖：store.js、core.js、ui.js、app.js
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var store = Sleepy.store;
  var core = Sleepy.core;

  var h = ui.h;
  var button = ui.button;

  var SVG = 'viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  /* ---------------------------- 数据 ---------------------------- */

  function all() {
    var list = store.get('moments');
    return Array.isArray(list) ? list : [];
  }

  function saveAll(list) { store.set('moments', list); }

  /* 向量索引联动（见 memory-vec 的素材源「朋友圈」）。
     **变更时显式喊一声**（施工卡 §5-3）—— 不做 store.onChange 统一监听：
     时机隐式、出错难查。全都后台跑，索引失败绝不能挡住发布 / 删除，所以吞异常。 */
  function vecCall(name, args) {
    var mv = Sleepy.memoryVec;
    if (!mv || typeof mv[name] !== 'function') return;
    try { mv[name].apply(mv, args || []); } catch (e) { /* 静默 */ }
  }

  /* 壁纸挂了（外网图、URL 打错）时底下还有一层兜底渐变 ——
     **渐变和 url 分两层写**：只设 url 的话图一挂整个封面就空了。
     色值引用 CSS 里的 --mo-wall-*（内联样式里也能用 var()），
     **这里不许再抄一遍色值** —— 抄了就会跟 .mo-cover 的默认底漂移。 */
  var WALL_FALLBACK =
    'radial-gradient(120% 80% at 82% 8%, rgba(255,255,255,.42) 0%, transparent 48%), ' +
    'radial-gradient(100% 70% at 8% 100%, rgba(255,255,255,.22) 0%, transparent 46%), ' +
    'linear-gradient(180deg,' +
    ' var(--mo-wall-1) 0%, var(--mo-wall-2) 50%, var(--mo-wall-3) 100%)';

  function wallBg(url) {
    return 'url("' + String(url).replace(/"/g, '%22') + '"), ' + WALL_FALLBACK;
  }

  function byId(id) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* 这条动态对「谁」可见 —— 认知锁的那道闸。

     refId 是**看的人**，可能是 user（马甲）也可能是 char（AI 判断自己看不看得见），
     所以第三个参数 kind 要带上（'user' / 'char'），不传就按库查一下。

     ⚠️ 这个区分很要紧：**char 视角必须能看见我发的动态**（否则他不会来评论），
     所以「账号隔离」那一条只对 user 视角生效。

     三道闸，从外到里：
       ⓪ 账号隔离   某个马甲发的动态是**那个号的朋友圈**，别的号看不见
       ① 朋友权限   我能看 TA 的 = 我没设「不看 TA」且 TA 没设「不让我看」
                    （用户 2026-09-22：「和微信一样」；「加了好友」这条
                    由 scoped + 同岛保证 —— 不在这座岛上的人根本不在视野里）
       ② 可见范围   动态自己的四档（照微信「谁可以看」页做）：
                    all 公开 / self 私密 / include 部分可见 / exclude 不给谁看

     老数据没有 privacy 字段 = all；传进来的 refId 认不出来（库里没这个人）
     也不拦 —— 宁可漏拦，也不要让人「动态莫名其妙消失」还找不到原因。 */
  function canSee(m, refId, kind) {
    if (!m) return false;
    if (!kind) {
      kind = (core.findUser && refId && core.findUser(refId)) ? 'user'
        : (core.findChar && refId && core.findChar(refId)) ? 'char' : '';
    }

    /* ⓪ 账号隔离：这个号发的，别的号看不见 */
    if (m.maskId && kind === 'user' && m.maskId !== refId) return false;

    /* ① 朋友权限（只对 char 发的动态、只从 user 视角看） */
    if (m.characterId && kind === 'user' && refId && core.feedPermOf) {
      var perm = core.feedPermOf(m.characterId, refId);
      if (perm.iHideChar || perm.charHidesMe) return false;
    }

    /* ② 动态自己的可见范围 */
    var mode = m.privacy || 'all';
    if (mode === 'all') return true;
    if (!refId) return true;
    var list = m.visibleTo || [];
    if (mode === 'self') {
      /* 作者自己 —— 角色发的比 characterId，我发的比 maskId */
      var selfId = m.characterId || m.maskId || null;
      return selfId ? refId === selfId : true;
    }
    if (mode === 'include') return list.indexOf(refId) >= 0;
    if (mode === 'exclude') return list.indexOf(refId) < 0;
    return true;
  }

  /* char 视角：这个角色看得见这条动态吗？
     和 canSee 是**镜像**关系（那边是「我看得见谁」），别混用 ——
     方向反了就成了「角色偷看你设了私密的东西」。
     ⓪ 他自己发的 → 看得见
     ① 我（马甲）发的 → 挡他的是这两个方向相反的开光：
        iHideFromChar（我不让他看我的）+ charHidesFromMe（他不看我的）
     ② 可见范围（privacy / visibleTo）和 canSee 同一套规则。
     老数据没 privacy = all；link 不存在时 feedPermOf 全 false = 不拦。 */
  function canCharSee(m, charId, userId) {
    if (!m || !charId) return false;
    if (m.characterId === charId) return true;              /* 自己发的 */
    if (m.maskId && core.feedPermOf) {
      var perm = core.feedPermOf(charId, m.maskId);
      if (perm.iHideFromChar || perm.charHidesFromMe) return false;
    }
    var mode = m.privacy || 'all';
    if (mode === 'all') return true;
    var list = m.visibleTo || [];
    if (mode === 'self') {
      var selfId = m.characterId || m.maskId || null;
      return selfId ? charId === selfId : true;
    }
    if (mode === 'include') return list.indexOf(charId) >= 0;
    if (mode === 'exclude') return list.indexOf(charId) < 0;
    return true;
  }

  /* 某个角色「近期实际看见」的动态（L1.5 近期生活动态的源，见 life-feed.js）。
     v1 只收**我发的**和**他自己发的**：别的角色/NPC 发的动态属于他自己
     世界里的事，模型本来就知道，再注一遍只是白烧 token。 */
  function listForChar(charId, userId, opts) {
    opts = opts || {};
    var days = opts.days || 10;
    var limit = opts.limit || 12;
    var floor = Date.now() - days * 86400000;
    var out = [];
    core.scoped(all()).forEach(function (m) {
      if (m.status === 'deleted') return;
      if (m.characterId !== charId && !m.maskId) return;     /* 只留我发的 / TA 发的 */
      if (!canCharSee(m, charId, userId)) return;
      if (typeof m.at === 'number' && m.at < floor) return;
      out.push(m);
    });
    return out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); })
      .slice(0, limit);
  }

  /* 我在朋友圈里动了 → 让人**过一会儿**来接（逻辑在 moments-ai.js）。
     只在我（马甲）自己做事的时侯叫：替角色发的不算 ——
     那本来就是「我让他发的」，再自动回一条给自己就成自问自答了。 */
  function pingAI(kind, momentId, who, comment) {
    if (!Sleepy.momentsAI) return;
    if (!who || who.kind !== 'mask') return;
    Sleepy.momentsAI.onUserAction(kind, momentId, comment || null);
  }

  /* 「让 TA 自己想一条发」曾经是这里一个单独区块（一排名字）。
     用户：「这个直接点我们上面那个刷新键不行嘛」—— 说得对，
     那件事本质上就是「催更」，已经并进顶栏的刷新键了（见 mountTab）。 */

  /* 往**当前这间房**写一条动态。
     characterId 为空 = 我（当前马甲）发的。 */
  function add(entry) {
    if (!entry) return null;
    var text = String(entry.text || '').trim();
    /* 允许「只发图不写字」，但两者都没有就没意义 */
    if (!text && !entry.mediaId && !entry.url) return null;

    var list = all();
    var item = core.tagScope({
      id: core.newId('mo'),
      characterId: entry.characterId || null,
      name: entry.name || '',
      text: text,
      at: entry.at || Date.now(),
      likes: [],
      comments: []
    });

    /* 带图：本体在图库（media.js），这里只留引用。
       用户要的「朋友圈可以带图发」。 */
    if (entry.mediaId) {
      item.mediaId = entry.mediaId;
      item.w = entry.w || 0;
      item.h = entry.h || 0;
    } else if (entry.url) {
      item.url = entry.url;
    }

    /* 群声帖子引用（施工卡-群声-v1 Batch E）：只存公开摘要 qsRef，
       点开时显式带 sandboxId+postId 回原帖；朋友圈评论不写回群声。 */
    if (entry.qsRef) item.qsRef = entry.qsRef;

    /* **为什么发这条**（reason）—— 角色自己发的时候由模型给出。
       用户：「朋友圈和记忆挂钩，他一定要知道自己为什么发这条朋友圈」。
       所以它不只是个备注，是要写进记忆库的（见 rememberMoment）。 */
    if (entry.reason) item.reason = String(entry.reason).slice(0, 200);

    /* 可见范围（认知锁）。用户：「在我选择发朋友圈的时候就选择允许谁可见就好啦」。
       四档见 canSee 的注释。存的是「脸」不是「人」：同一句动态，
       换张小号就看不见了 —— 这正好是「被屏蔽的人从小号看到了」那种玩法的地基。 */
    if (entry.privacy && entry.privacy !== 'all') item.privacy = entry.privacy;
    if (entry.visibleTo && entry.visibleTo.length) {
      item.visibleTo = entry.visibleTo.slice(0, 20);
    }
    /* 「@ 提醒谁看」：被提醒的人会在自动回复链里**优先**接话。 */
    if (entry.mentions && entry.mentions.length) {
      item.mentions = entry.mentions.slice(0, 20);
    }

    /* 我（马甲）发的记下 maskId —— 「私密」那档要靠它判断「是不是作者本人」。
       过岛卫兵：指针停在上一座岛时宁可不记，也不把动态挂到别人名下。 */
    if (!item.characterId) {
      var meNow = core.activeUserOnIsland ? core.activeUserOnIsland() : null;
      item.maskId = entry.maskId || (meNow ? meNow.id : null);
    }

    list.unshift(item);
    saveAll(list);
    /* 新动态进向量库（岛级公共池，一条一个事件包）—— 后台跑，不挡发布 */
    vecCall('sweepMoments');
    return item;
  }

  /* 给动态补一张图（角色发动态的生成配图到这里落）。
     只认 mediaId —— objectURL 活不过刷新，不能进存档。 */
  function setMedia(momentId, ref) {
    if (!momentId || !ref || !ref.mediaId) return null;
    var list = all();
    var hit = null;
    list.forEach(function (m) {
      if (m.id !== momentId) return;
      m.mediaId = ref.mediaId;
      m.w = ref.w || 0;
      m.h = ref.h || 0;
      hit = m;
    });
    if (hit) saveAll(list);
    return hit;
  }

  /* 把「我发了什么、为什么发」写进这个角色的记忆库 ——
     这样之后在聊天里提到「你早上发的那条」他接得上。
     记忆是**按角色 rootId** 存的（皮套共用一副脑子）。 */
  function rememberMoment(item, who) {
    if (!item || !who || who.kind !== 'char' || !who.refId) return;
    if (!core || !core.addMemory) return;
    var rootId = core.rootIdOf(who.refId) || who.refId;
    var body = item.text || (item.mediaId || item.url ? '（配图）' : '');
    var line = '我发了一条朋友圈：' + body
      + (item.reason ? '（因为' + item.reason + '）' : '');
    core.addMemory({
      rootId: rootId,
      fromCharId: who.refId,
      toUserId: null,
      role: 'assistant',
      text: line.slice(0, 600)
    });
  }

  /* 赞 / 取消赞。同一个 refId 再点一次就是取消。 */
  function toggleLike(momentId, who) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== momentId) continue;
      var m = list[i];
      m.likes = m.likes || [];
      for (var j = 0; j < m.likes.length; j++) {
        if (m.likes[j].refId === who.refId) {
          m.likes.splice(j, 1);
          saveAll(list);
          return { ok: true, liked: false };
        }
      }
      m.likes.push({
        id: core.newId('ml'),
        kind: who.kind, refId: who.refId, name: who.name || '', at: Date.now()
      });
      saveAll(list);
      /* 赞也有反应（用户点名要的）：角色**知道**谁赞了他 —— 记进他的记忆，
         聊天里提得起来。不自动蹦评论（被赞还条条回话太吵了）。 */
      if (who.kind === 'mask' && m.characterId && Sleepy.momentsAI && Sleepy.momentsAI.onLike) {
        Sleepy.momentsAI.onLike(momentId, m.characterId, who);
      }
      return { ok: true, liked: true };
    }
    return { ok: false, message: '动态不见了' };
  }

  /* 评论。text 可以为空 —— 那时候必须带 extra.mediaId（就是发个表情）。
     extra: { mediaId, url, replyTo }
       · mediaId/url  表情评论（用户：「朋友圈评论可以发表情包（双向可以）」）
       · replyTo      指着某条评论回（user 回 NPC、NPC 再回 user 都靠它） */
  function addComment(momentId, who, text, extra) {
    extra = extra || {};
    text = String(text || '').trim();
    if (!text && !extra.mediaId && !extra.url) {
      return { ok: false, message: '评论不能是空的' };
    }
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== momentId) continue;
      var c = {
        id: core.newId('mc'),
        kind: who.kind, refId: who.refId, name: who.name || '',
        text: text.slice(0, 140), at: Date.now()
      };
      if (extra.mediaId) c.mediaId = extra.mediaId;
      else if (extra.url) c.url = extra.url;
      if (extra.replyTo) c.replyTo = extra.replyTo;
      list[i].comments = (list[i].comments || []).concat([c]);
      saveAll(list);
      return { ok: true, item: c };
    }
    return { ok: false, message: '动态不见了' };
  }

  function removeComment(momentId, commentId) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== momentId || !(list[i].comments || []).length) continue;
      var keep = list[i].comments.filter(function (c) { return c.id !== commentId; });
      if (keep.length === list[i].comments.length) continue;
      list[i].comments = keep;
      saveAll(list);
      /* 评论是**事件包**的一部分 → 重切那一条动态（不是删整个源）：
         不重切的话，TA 会引用一条已经被删掉的评论。 */
      vecCall('refreshMoment', [momentId]);
      return { ok: true };
    }
    return { ok: false };
  }

  /* 删掉整条动态。**造物主视角**：user 和角色的都删得掉
     （用户：「评论和朋友圈可手动删除」）—— 入口在动态右上角那个「⋯」。 */
  function remove(momentId) {
    saveAll(all().filter(function (m) { return m.id !== momentId; }));
    /* 删了就失效 —— 留着索引等于「删了也没用，它还记得」。
       按**条目 id** 精确命中（不是 sourceId —— 那会把整个源删掉，§8.4）。 */
    vecCall('forget', [{ kind: 'moment', ids: [momentId] }]);
    return { ok: true };
  }

  /* ---- 壁纸（**按账号**，一间房里每张脸各一张）----

     用户 2026-09-22：「那个封面也做按账号吧」—— 微信的封面本来就是每个号自己的。
     记录是 { url | mediaId, sandboxId, userId }：
       · 贴网址（长按封面）→ url
       · 从相册选（点封面）→ mediaId —— **不能存 objectURL**，
         那玩意儿刷新页面就失效了

     **老数据**（只有 sandboxId、没有 userId）当「这座岛的默认」：
     哪个账号还没设自己的封面，就显示它 —— 升级老存档不会突然白掉。
     改封面只写自己那条，**不动**默认那条（别的账号还要用）。
     wall() 返回记录对象（null = 没设），渲染方自己解析。 */
  function wallFor(userId) {
    var list = core.scoped(store.get('momentWall'));
    var uid = userId || ((core.activeUserOnIsland && core.activeUserOnIsland()) || {}).id || '';
    var mine = null, fallback = null;
    list.forEach(function (w) {
      if (!w) return;
      if (w.userId && uid && w.userId === uid) mine = w;
      else if (!w.userId && !fallback) fallback = w;
    });
    var hit = mine || fallback;
    if (!hit) return null;
    if (hit.mediaId) return { mediaId: hit.mediaId };
    return { url: hit.url || '' };
  }

  function wall() { return wallFor(''); }

  function setWall(ref) {
    var allWalls = store.get('momentWall');
    if (!Array.isArray(allWalls)) allWalls = [];
    var sid = core.scopeId();
    var uid = ((core.activeUserOnIsland && core.activeUserOnIsland()) || {}).id || '';
    for (var i = 0; i < allWalls.length; i++) {
      var w = allWalls[i];
      if (!w || w.sandboxId !== sid) continue;
      /* 只认「自己那条」—— uid 为空时匹配的正是没有 userId 的那条（老行为） */
      if ((w.userId || '') !== uid) continue;
      if (ref) {
        allWalls[i] = core.tagScope({
          id: w.id, url: ref.url || '', mediaId: ref.mediaId || null, userId: uid
        });
      } else {
        allWalls.splice(i, 1);
      }
      store.set('momentWall', allWalls);
      return { ok: true };
    }
    if (!ref) return { ok: true };
    var made = core.tagScope({ id: core.newId('mw'), url: ref.url || '', mediaId: ref.mediaId || null });
    made.userId = uid;
    allWalls.push(made);
    store.set('momentWall', allWalls);
    return { ok: true };
  }

  /* ---------------------------- 工具 ---------------------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function timeText(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 2) return '昨天';
    if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' +
      pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  /* 这间房里「能发动态 / 能互动」的所有人：
     我（当前马甲）打头，然后是全部角色（大号 / 皮套平铺），
     最后是岛内全体 NPC（唯一口径 core.npcsOfRoom —— 以前这里只认
     挂在名下的老 NPC，岛级 NPC 完全发不了动态，2026-09-21 收敛修掉）。
     造物主可以替任何一个角色发和说话 —— 这是配置台的自然延伸。 */
  function peopleIn(sb) {
    /* 「我」过岛卫兵：拿不到就不把自己列进候选（造物主仍可替任意角色发/说，
       但不硬塞一个别座岛的马甲来当「我」）。 */
    var me = core.activeUserOnIsland ? core.activeUserOnIsland() : null;
    var out = [];
    if (me) out.push({ kind: 'mask', refId: me.id, name: core.labelOfUser(me) });
    var mains = sb ? core.charsOfSandbox(sb.id) : [];
    mains.forEach(function (m) {
      out.push({ kind: 'char', refId: m.id, name: m.name });
      if (Sleepy.island) {
        Sleepy.island.childrenOf(sb.id, m.id, 'sub', 'char').forEach(function (k) {
          out.push({ kind: 'char', refId: k.id, name: k.name });
        });
      }
    });
    (core.npcsOfRoom ? core.npcsOfRoom(sb) : []).forEach(function (k) {
      out.push({ kind: 'char', refId: k.id, name: k.name });
    });
    return out;
  }

  /* 一颗朋友圈头像。
     ⚠️ 2026-09-22 修：以前只查 `core.findChar(refId)` —— 角色的能找到，
     **我（马甲 / user）永远找不到**，于是我自己发的每一条动态都是一个首字。
     用户报的「朋友圈的头像没有同步账号」就是这一条。
     现在按 kind 分流：mask → findUser，char → findChar，没标 kind 的两个都试。 */
  function avatarEl(who, cls) {
    who = who || {};
    var rec = who;
    var isUser = who.kind === 'mask';

    if (who.refId) {
      var found = null;
      if (who.kind === 'mask') found = core.findUser ? core.findUser(who.refId) : null;
      else if (who.kind === 'char') found = core.findChar ? core.findChar(who.refId) : null;
      /* 没标 kind（老调用点 / 临时对象）：两边都试一遍 */
      if (!found) {
        found = (core.findChar && core.findChar(who.refId)) ||
                (core.findUser && core.findUser(who.refId)) || null;
      }
      if (found) {
        rec = found;
        /* char 表里没这个人 + user 表里有 → 它是件马甲（首字要按「名字→微信名」取） */
        if (!isUser && core.findUser && !(core.findChar && core.findChar(found.id)) &&
            core.findUser(found.id)) isUser = true;
      }
    }

    var label = (rec && rec.name) || who.name || '';
    var av = h('span', cls, isUser ? core.initialOfUser(rec) : core.initialOf(label || '?'));
    /* 本地图 avatarMedia 优先，回落网址；has-img 由 helper 异步加 */
    core.setAvatarBg(av, rec);
    return av;
  }

  /* ---------------------------- 屏 ---------------------------- */

  /* 顶栏右上角的相机 —— 微信朋友圈的发布入口就在这，不用 FAB */
  var CAM_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 8.2a2.2 2.2 0 0 1 2.2-2.2h1.9l1.6-2h4.6l1.6 2h2.1A2.2 2.2 0 0 1 20 8.2v9.1a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.3z"/>' +
    '<circle cx="12" cy="12.4" r="3.3"/></svg>';

  /* 「两个点」：微信的赞/评论入口就是它 */
  var DOTS_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" ' +
    'fill="currentColor" aria-hidden="true">' +
    '<circle cx="7.5" cy="12" r="1.7"/><circle cx="16.5" cy="12" r="1.7"/></svg>';

  /* 顶栏的刷新 */
  var REFRESH_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.6V10h-5.4"/></svg>';

  function mountTab(panel, ctx) {
    var sb = core.activeSandbox();

    /* 顶栏右上角：相机 = 发一条动态（微信的规矩） */
    ctx.setActions([
      {
        /* 刷新 = 重读这间房的动态，**顺手让一个人想想发不发**
           （用户：「这个直接点我们上面那个刷新键不行嘛」）——
           以前底部专门摆了一排「让他自己想一条发」的名字，其实那件事
           就是「催更」，跟刷新是同一件事，合起来更省地方。
           随机挑一个：每次都是同一个人发会显得像自动机。 */
        label: '刷新', svg: REFRESH_SVG, onClick: function () {
          paint();
          var chars = sb
            ? (peopleIn(sb) || []).filter(function (p) { return p.kind === 'char'; })
            : [];
          if (!chars.length || !Sleepy.momentsAI) { ctx.toast('刷新了', 'ok'); return; }

          var pick = chars[Math.floor(Math.random() * chars.length)];
          ctx.toast('刷新了 · ' + pick.name + ' 在想…', 'ok');
          Sleepy.momentsAI.askCharToPost(sb, pick.refId, function (err, item) {
            if (err) { ctx.toast(err, 'err'); return; }
            if (!item) { ctx.toast(pick.name + ' 这会儿不想发', 'warn'); return; }
            ctx.toast(pick.name + ' 发了一条', 'ok');
            paint();
          });
        }
      },
      {
        label: '发一条动态', svg: CAM_SVG,
        /* 微信的交互（用户点名要的）：**点一下** = 选图发；**长按** = 纯文字。
           点一下给四选一的小菜单：相册 / 本地 / 图片链接 / 不配图。
           （2026-09-21 用户：要跟发消息一样能选「小手机相册 / 本地 / URL」。）
           「生成一张图发」要等生图 API 那批，这里先留了路。 */
        onClick: function () {
          if (!sb) { ctx.toast('先降落进一间房', 'warn'); return; }
          var host = document.getElementById('phone') || ctx.el;
          var mask = h('div', 'msg-menu-mask');
          var sheet = h('div', 'msg-menu');
          var closed = false;
          function close() {
            if (closed) return;
            closed = true;
            mask.classList.remove('is-open'); sheet.classList.remove('is-open');
            setTimeout(function () {
              if (mask.parentNode) mask.parentNode.removeChild(mask);
              if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
            }, 240);
          }
          function item(name, run) {
            var b = h('button', 'msg-menu-item', name);
            b.type = 'button';
            b.addEventListener('click', function () { close(); run(); });
            sheet.appendChild(b);
          }
          item('从相册选一张', function () {
            openPhotoPick(ctx, function (p) {
              openComposer(ctx, sb, peopleIn(sb), paint, {
                pic: { mediaId: p.mediaId || null, url: p.mediaId ? null : (p.url || '') }
              });
            });
          });
          item('本地传一张', function () {
            pickLocalPic(ctx, function (pic) {
              openComposer(ctx, sb, peopleIn(sb), paint, { pic: pic });
            });
          });
          item('用图片链接', function () {
            ui.prompt({
              title: '用图片链接',
              placeholder: 'https://…',
              ok: '用它'
            }).then(function (v) {
              if (v === null) return;
              var t = String(v).trim();
              if (!t) return;
              if (!/^https?:\/\//i.test(t)) { ctx.toast('得是 http/https 开头的地址', 'err'); return; }
              openComposer(ctx, sb, peopleIn(sb), paint, { pic: { url: t } });
            });
          });
          item('不配图，直接写', function () {
            openComposer(ctx, sb, peopleIn(sb), paint, {});
          });
          var c = h('button', 'msg-menu-cancel', '取消');
          c.type = 'button';
          c.addEventListener('click', close);
          sheet.appendChild(c);
          mask.addEventListener('click', close);
          host.appendChild(mask); host.appendChild(sheet);
          /* sheet 也要 is-open —— 它默认是收起的，漏了的话菜单只有一个空遮罩（实测） */
          setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
        },
        onLongPress: function () {
          if (!sb) { ctx.toast('先降落进一间房', 'warn'); return; }
          openComposer(ctx, sb, peopleIn(sb), paint, {});
        }
      }
    ]);

    /* ---- 封面（微信式壁纸 + 右下角自己的头像）----
       换壁纸两条路（用户嫌原来那个弹层解释多、绿色丑）：
         · **点封面** = 从相册选（图库里的图，清晰、不用找网址）
         · **长按封面** = 贴一个图片网址（想用外网图的时候）
       两条路都不带一句解释 —— 界面自己要说得清。 */
    var cover = h('div', 'mo-cover');
    var wallRef = wall();
    function paintWall() {
      wallRef = wall();
      cover.classList.remove('has-img');
      cover.style.backgroundImage = '';
      if (!wallRef) return;
      if (wallRef.mediaId && Sleepy.media) {
        Sleepy.media.url(wallRef.mediaId).then(function (u) {
          if (!u) return;
          cover.style.backgroundImage = wallBg(u);
          cover.classList.add('has-img');
        });
      } else if (wallRef.url) {
        cover.style.backgroundImage = wallBg(wallRef.url);
        cover.classList.add('has-img');
      }
    }
    paintWall();

    cover.appendChild(h('span', 'mo-cover-tip', '点一下换壁纸（手机相册）· 长按贴网址'));
    var wallPress = null;
    cover.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      wallPress = setTimeout(function () {
        wallPress = null;
        cover.__lpFired = true;
        ui.prompt({
          title: '朋友圈壁纸',
          placeholder: 'https://…',
          value: wallRef && wallRef.url ? wallRef.url : '',
          ok: '换上'
        }).then(function (v) {
          if (v === null) return;
          var t = String(v).trim();
          if (t && !/^https?:\/\//i.test(t)) { ctx.toast('得是 http/https 开头的地址', 'err'); return; }
          setWall(t ? { url: t } : null);
          paintWall();
        });
      }, 480);
    });
    function wallCancel() { if (wallPress) { clearTimeout(wallPress); wallPress = null; } }
    cover.addEventListener('pointermove', function (e) {
      /* 移动了就是滑屏，不算长按 */
      if (!wallPress) return;
      wallCancel();
    });
    cover.addEventListener('pointerup', wallCancel);
    cover.addEventListener('pointercancel', wallCancel);
    cover.addEventListener('pointerleave', wallCancel);
    cover.addEventListener('click', function (e) {
      if (cover.__lpFired) { cover.__lpFired = false; e.preventDefault(); return; }
      pickSystemPhoto(ctx, function (r) {
        if (r && r.mediaId) {
          /* 落库完成：换成持久的那张，本地预览可以撤了 */
          setWall({ mediaId: r.mediaId });
          paintWall();
          if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
          ctx.toast('换上了', 'ok');
          return;
        }
        /* 还没落库：先用本地预览顶上去，封面不能空着等 */
        if (r && r.previewUrl) {
          cover.style.backgroundImage = wallBg(r.previewUrl);
          cover.classList.add('has-img');
        }
      });
    });

    /* 顶部那颗「我的头」也过卫兵 —— 显示成上一座岛的人比显示成「我」更糟。
       直接把**当前马甲这条记录**递进去（别只递名字 + 网址）：
       recorder 里有 avatarMedia，只递 avatar 的话本地图那份头像是拿不到的。 */
    var me = core.activeUserOnIsland ? core.activeUserOnIsland() : null;
    var meHead = h('div', 'mo-me');
    meHead.appendChild(h('span', 'mo-me-name', me ? core.labelOfUser(me) : '我'));
    meHead.appendChild(avatarEl(
      me ? { kind: 'mask', refId: me.id, name: core.labelOfUser(me), avatar: me.avatar, avatarMedia: me.avatarMedia }
         : { kind: 'mask', name: '我' }, 'mo-me-av'));
    meHead.title = '这是你 · 换脸去「我」那一屏';
    cover.appendChild(meHead);
    panel.appendChild(cover);

    /* ---- 动态列表 ---- */
    var feed = h('div', 'mo-feed');
    panel.appendChild(feed);

    function paint() {
      paintWall();
      feed.innerHTML = '';

      var raw = core.scoped(all()).slice().sort(function (a, b) {
        return (b.at || 0) - (a.at || 0);
      });
      var people = peopleIn(sb);
      var meNow = core.activeUserOnIsland ? core.activeUserOnIsland() : null;
      var meId = meNow ? meNow.id : '';

      /* 按**当前这张脸**过一遍认知锁（用户：「选择允许谁可见」）。
         被挡住的不静默消失 —— 底下留一句「另有 N 条你看不见」，
         不然用户会以为动态丢了。 */
      var hidden = 0;
      var list = raw.filter(function (m) {
        if (canSee(m, meId, 'user')) return true;
        hidden++;
        return false;
      });

      if (!list.length) {
        var empty = h('div', 'moment-empty');
        if (hidden) {
          empty.appendChild(h('p', 'moment-empty-title', '这 ' + hidden + ' 条动态没让你看'));
          empty.appendChild(h('p', 'moment-empty-hint',
            '发的人选了可见范围 · 换一张马甲试试能不能看到'));
        } else {
          empty.appendChild(h('p', 'moment-empty-title', '这间房里还没有人发过动态'));
          empty.appendChild(h('p', 'moment-empty-hint',
            '点右上角的相机自己发一条 · 或者点刷新，让 TA 自己想一条'));
        }
        feed.appendChild(empty);
        return;
      }

      list.forEach(function (m) {
        feed.appendChild(momentCard(m, people, paint, ctx));
      });

      if (hidden) {
        feed.appendChild(h('p', 'mo-hidden-note',
          '另有 ' + hidden + ' 条动态没让你看 · 换张马甲试试'));
      }
    }

    paint();

    /* 队列跑完（有人真回了）要自动重画 —— 不然用户看到的还是老样子，
       只能自己去点刷新，会以为「自动回复没生效」。 */
    if (Sleepy.momentsAI) {
      Sleepy.momentsAI.setRefresh(paint);
      Sleepy.momentsAI.tick(function (n) { if (n) paint(); });
    }

    return { rebuild: paint };
  }

  /* ---------------------------- 一条动态 ----------------------------

     微信的排法：左头像，右侧一列 = 名字（蓝灰）/ 正文 / 时间+两个点。
     赞和评论**不常驻** —— 点「两个点」才弹出「赞 | 评论」，
     互动收在正文下面那块浅灰里（赞一行、评论若干行）。 */

  /* ---------------------------- 挑一个表情 ----------------------------

     朋友圈评论要能发表情（用户：「朋友圈评论可以发表情包（双向可以）」）。
     复用聊天那边那套 .stk-panel 样式（底部弹一层 + 组 chips + 网格），
     不另造一套皮。选一张就把 mediaId/url 交给回调。 */
  function openStickerPick(ctx, onPick) {
    var pool = (Sleepy.stickers && Sleepy.stickers.visible) ? Sleepy.stickers.visible() : [];
    if (!pool.length) {
      ctx.toast('还没有表情 · 去「我 → 表情包」导入一批', 'warn');
      return;
    }

    var host = document.getElementById('phone') || ctx.el;
    var mask = h('div', 'stk-panel-mask');
    var box = h('div', 'stk-panel');
    var tabs = h('div', 'stk-panel-tabs');
    var grid = h('div', 'stk-panel-grid');

    var groups = Sleepy.stickers.groupsOf(pool);
    var cur = groups[0];

    function srcOf(st) {
      if (st.mediaId && Sleepy.media) return Sleepy.media.url(st.mediaId);
      return Promise.resolve(st.url || '');
    }

    function paint() {
      tabs.innerHTML = '';
      groups.forEach(function (gn) {
        var on = gn === cur;
        var chip = h('button', 'stk-panel-chip' + (on ? ' is-on' : ''), gn);
        chip.type = 'button';
        chip.addEventListener('click', function () { cur = gn; paint(); });
        tabs.appendChild(chip);
      });
      grid.innerHTML = '';
      pool.filter(function (st) { return Sleepy.stickers.groupOf(st) === cur; })
        .forEach(function (st) {
          var cell = h('button', 'stk-panel-cell');
          cell.type = 'button';
          cell.title = st.name || '表情';
          srcOf(st).then(function (u) {
            if (u) cell.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
          });
          cell.addEventListener('click', function () { close(); onPick(st); });
          grid.appendChild(cell);
        });
    }
    paint();

    box.appendChild(tabs);
    box.appendChild(grid);
    mask.appendChild(box);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    host.appendChild(mask);
    setTimeout(function () { mask.classList.add('is-open'); }, 20);

    function close() {
      mask.classList.remove('is-open');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
    }
  }

  /* ---------------------------- 从相册挑一张 ----------------------------
     用户：「以后相册里有的图可以拿出来用」。相册里的图本来就已经在图库里，
     这里只是把 mediaId 借过来引用一次，**不复制第二份**。
     皮复用表情那层底部浮层（.stk-panel），不另造一套。 */
  /* 从**手机系统相册**选一张（2026-09-22 用户：「我要的是用手机系统里的图做背景」）。
     跟 openPhotoPick 的区别：那个是**小手机相册**（角色发过的图），
     封面以前走的就是它 —— 图库当然是空的，还堵一句「相册还是空的」，
     把用户挡在门外。这个直接开系统文件选择器。
     存进去的只有 mediaId（objectURL 活不过刷新，不进存档）。 */
  function pickSystemPhoto(ctx, onPick) {
    var file = h('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.display = 'none';
    file.addEventListener('change', function () {
      var picked = file.files && file.files[0];
      file.value = '';
      if (!picked) return;
      if (!Sleepy.media || !Sleepy.media.shrink || !Sleepy.media.put) {
        ctx.toast('图库没就绪，选不了图', 'err');
        return;
      }
      /* 先**立刻**给一张（objectURL，秒出），压缩 + 落库扔后台 ——
         用户 2026-09-22：「显示正在收入图库，然后没反应了，再过了一会儿才有，
         中间太慢了会让人觉得是坏了」。别让人对着空气等。
         objectURL 只是这一次的预览，进存档的仍然只有 mediaId。 */
      var local = URL.createObjectURL(picked);
      onPick({ previewUrl: local });
      ctx.toast('已换上 · 正在存进图库…');
      Sleepy.media.shrink(picked, 1280).then(function (r) {
        return Sleepy.media.put(r.blob, { name: '朋友圈壁纸', kind: 'wall', w: r.w, h: r.h });
      }).then(function (mid) {
        onPick({ mediaId: mid, previewUrl: local });
      }, function () {
        URL.revokeObjectURL(local);
        ctx.toast('这张图读不出来', 'err');
      });
    });
    var host = document.getElementById('phone') || ctx.el;
    host.appendChild(file);
    file.click();
  }

  function openPhotoPick(ctx, onPick) {
    var host = document.getElementById('phone') || ctx.el;
    var list = (Sleepy.photos && Sleepy.photos.all) ? Sleepy.photos.all() : [];

    var mask = h('div', 'stk-panel-mask');
    var box = h('div', 'stk-panel');
    box.appendChild(h('p', 'mo-composer-title', '从相册挑一张'));

    if (!list.length) {
      box.appendChild(h('p', 'stk-panel-empty',
        '相册还是空的 · 先去相册 App 里收几张，或者点上面的「带一张图」'));
    } else {
      var grid = h('div', 'stk-panel-grid');
      list.forEach(function (p) {
        var cell = h('button', 'stk-panel-cell');
        cell.type = 'button';
        cell.title = p.caption || '相册里的图';
        var src = (p.mediaId && Sleepy.media)
          ? Sleepy.media.url(p.mediaId)
          : Promise.resolve(p.url || '');
        src.then(function (u) {
          if (u) cell.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
        });
        cell.addEventListener('click', function () { close(); onPick(p); });
        grid.appendChild(cell);
      });
      box.appendChild(grid);
    }

    var acts = h('div', 'mo-composer-acts');
    var cancel = h('button', 'mo-csend mo-csend-ghost', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { close(); });
    acts.appendChild(cancel);
    box.appendChild(acts);

    mask.appendChild(box);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    host.appendChild(mask);
    setTimeout(function () { mask.classList.add('is-open'); }, 20);

    function close() {
      mask.classList.remove('is-open');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
    }
  }

  /* 本地传一张：文件框 → 缩放入库 → 回调。
     跟「从相册选」是并排的两个入口 —— 相册里没有的图走这条。 */
  function pickLocalPic(ctx, onPic) {
    if (!Sleepy.media) { ctx.toast('这台设备存不了图', 'warn'); return; }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (input.parentNode) input.parentNode.removeChild(input);
      if (!f) return;
      Sleepy.media.shrink(f).then(function (r) {
        return Sleepy.media.put(r.blob, { name: f.name, kind: 'moment', w: r.w, h: r.h })
          .then(function (id) { onPic({ mediaId: id, w: r.w, h: r.h }); });
      }, function () { ctx.toast('这张图没能存进图库', 'err'); });
    });
    document.body.appendChild(input);
    input.click();
  }

  function momentCard(m, people, repaint, ctx) {
    /* 作者是谁：角色发的比 characterId，我（马甲）发的比 maskId
       （见本文件头部的记录形状）。**maskId 不能漏** —— 漏了的话
       我自己发的动态连头像都找不到人（老代码就是这么写的）。 */
    var author = m.characterId
      ? { kind: 'char', refId: m.characterId, name: m.name || '某人' }
      : { kind: 'mask', refId: m.maskId, name: m.name || '我' };
    var card = h('div', 'moment-item');
    card.setAttribute('data-id', m.id || '');   /* 时光跳转定位用（weNav revealInPage） */

    card.appendChild(avatarEl(author, 'mo-avatar'));

    var main = h('div', 'mo-main');

    main.appendChild(h('div', 'mo-name', author.name));

    if (m.text) main.appendChild(h('p', 'mo-text', m.text));

    /* 群声引用卡（Batch E）：米白小卡一行来源，点开回原帖（显式带岛）。 */
    if (m.qsRef && m.qsRef.sourcePostId) {
      var qsCard = h('div', 'mo-qs-card');
      qsCard.appendChild(h('span', 'mo-qs-k', '群声 · ' + (m.qsRef.boardName || '社区')));
      qsCard.appendChild(h('b', null, m.qsRef.title || '（无标题）'));
      var qsSub = (m.qsRef.authorName || '') +
        ((m.qsRef.stats && m.qsRef.stats.comments) ? ' · ' + m.qsRef.stats.comments + ' 条留声' : '');
      if (qsSub) qsCard.appendChild(h('small', null, qsSub));
      qsCard.addEventListener('click', function () {
        Sleepy.nav.open('qunsheng-post', {
          sandboxId: m.qsRef.sandboxId, postId: m.qsRef.sourcePostId
        });
      });
      main.appendChild(qsCard);
    }

    /* 带图（用户：「朋友圈可以带图发」）。本体在图库，现取 objectURL；
       取不到就整块不显示 —— 别留一个破图占着位置。 */
    if (m.mediaId || m.url) {
      var pic = h('div', 'mo-pic');
      main.appendChild(pic);
      var picSrc = (m.mediaId && Sleepy.media)
        ? Sleepy.media.url(m.mediaId)
        : Promise.resolve(m.url || '');
      picSrc.then(function (src) {
        if (!src) { if (pic.parentNode) pic.parentNode.removeChild(pic); return; }
        pic.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
      });
    }

    /* 时间 + 两个点（微信：赞/评论的入口收在这） */
    var foot = h('div', 'mo-foot');
    foot.appendChild(h('span', 'mo-time', timeText(m.at)));
    var moreBtn = h('button', 'mo-more');
    moreBtn.type = 'button';
    moreBtn.title = '赞 / 评论';
    moreBtn.setAttribute('aria-label', '赞 / 评论');
    moreBtn.innerHTML = DOTS_SVG;
    foot.appendChild(moreBtn);
    main.appendChild(foot);

    /* ---- 点「两个点」弹出的快捷条：赞 | 评论 ----
       赞 → 弹身份 chips，点一个就是以 TA 的身份赞 / 取消赞；
       评论 → 弹身份 chips + 输入框。 */
    var commentWho = null;

    function whoNow() {
      if (commentWho) return commentWho;
      /* 评论的身份也过卫兵：别用上一座岛的马甲去评论 */
      var me = core.activeUserOnIsland ? core.activeUserOnIsland() : null;
      return { kind: 'mask', refId: me ? me.id : null, name: me ? me.name : '我' };
    }

    var quick = h('div', 'mo-quick');
    var detail = h('div', 'mo-detail');
    main.appendChild(quick);
    main.appendChild(detail);

    var quickOpen = false;
    moreBtn.addEventListener('click', function () {
      quickOpen = !quickOpen;
      renderQuick();
      if (!quickOpen) { renderDetail(''); }
    });

    function renderQuick() {
      quick.innerHTML = '';
      quick.classList.toggle('is-open', quickOpen);
      if (!quickOpen) return;
      var likeB = h('button', 'mo-quick-btn', '赞');
      likeB.type = 'button';
      likeB.addEventListener('click', function () {
        quickOpen = false;
        renderQuick();
        renderDetail('like');
      });
      var cmB = h('button', 'mo-quick-btn', '评论');
      cmB.type = 'button';
      cmB.addEventListener('click', function () {
        quickOpen = false;
        renderQuick();
        renderDetail('comment');
      });
      quick.appendChild(likeB);
      quick.appendChild(cmB);

      /* 删除（用户：「评论和朋友圈可手动删除」）。
         造物主视角 —— user 的和角色的都能删，所以不按作者区别对待。
         放在这个「更多」条里，不藏在长按手势后面（长按没人发现得了）。 */
      var delB = h('button', 'mo-quick-btn is-danger', '删除');
      delB.type = 'button';
      delB.addEventListener('click', function () {
        quickOpen = false;
        renderQuick();
        renderDetail('');
        ui.confirm({
          title: '删掉这条动态？',
          note: (m.name || '某人') + '：' + (m.text || '（配图）').slice(0, 24),
          ok: '删掉',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          remove(m.id);
          repaint();
          ctx.toast('删掉了', 'ok');
        });
      });
      quick.appendChild(delB);
    }

    var detailMode = '';
    /* 正在回复哪条评论（点评论行上的「回复」就会设它） */
    var replyTarget = null;

    function renderDetail(mode) {
      detailMode = mode || '';
      detail.innerHTML = '';
      if (!mode) return;

      /* 身份 chips：我 / 这间房里的角色们。谁都能赞、谁都能说。
         评论模式下当前身份高亮；点赞模式不记 —— 点 chips 就是赞。 */
      var chips = h('div', 'mo-chips');
      people.forEach(function (p) {
        var on = (mode === 'comment' && commentWho) ? (commentWho.refId === p.refId) : false;
        var c = h('button', 'mo-chip' + (on ? ' is-on' : ''), p.name);
        c.type = 'button';
        c.addEventListener('click', function () {
          if (mode === 'like') {
            var r = toggleLike(m.id, p);
            if (!r.ok) { ctx.toast(r.message || '没成功', 'err'); return; }
            repaint();
          } else {
            commentWho = p;
            renderDetail('comment');
          }
        });
        chips.appendChild(c);
      });
      detail.appendChild(chips);

      if (mode === 'comment') {
        /* 指着某条评论回的时候，上面先显示一行「回复 某某」并可取消 */
        if (replyTarget) {
          var rt = (m.comments || []).filter(function (x) { return x.id === replyTarget; })[0];
          var rtLine = h('div', 'mo-replying');
          rtLine.appendChild(h('span', '', '正在回复 ' + ((rt && rt.name) || '某人')));
          var rtX = h('button', 'mo-replying-x', '取消');
          rtX.type = 'button';
          rtX.addEventListener('click', function () {
            replyTarget = null;
            renderDetail('comment');
          });
          rtLine.appendChild(rtX);
          detail.appendChild(rtLine);
        }

        var form = h('div', 'mo-cform');
        var inp = h('input', 'mo-cinput');
        inp.type = 'text';
        inp.placeholder = replyTarget
          ? '回一句…'
          : ('以「' + whoNow().name + '」的身份评论…');
        inp.maxLength = 140;

        /* 表情评论（用户：「朋友圈评论可以发表情包（双向可以）」）——
           选一张就作为**一条评论**发出去，不是塞进文字里。 */
        var stkB = h('button', 'mo-cstk', '😊');
        stkB.type = 'button';
        stkB.title = '发一个表情';
        stkB.setAttribute('aria-label', '发一个表情');
        stkB.innerHTML = '<svg ' + SVG + '><circle cx="12" cy="12" r="8.2"/>' +
          '<path d="M9 10.2h.01M15 10.2h.01M9.2 14.4a3.4 3.4 0 0 0 5.6 0"/></svg>';
        stkB.addEventListener('click', function () {
          openStickerPick(ctx, function (st) {
            var who = whoNow();
            var r = addComment(m.id, who, '', {
              mediaId: st.mediaId || null,
              url: st.mediaId ? null : st.url,
              replyTo: replyTarget || null
            });
            if (!r.ok) { ctx.toast(r.message || '没成功', 'err'); return; }
            replyTarget = null;
            pingAI('comment', m.id, who, r.item);
            repaint();
          });
        });

        var send = h('button', 'mo-csend', '发送');
        send.type = 'button';
        send.addEventListener('click', function () {
          var who = whoNow();
          var r = addComment(m.id, who, inp.value, { replyTo: replyTarget || null });
          if (!r.ok) { ctx.toast(r.message || '没成功', 'err'); return; }
          replyTarget = null;
          pingAI('comment', m.id, who, r.item);
          repaint();
        });
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); send.click(); }
        });
        form.appendChild(stkB);
        form.appendChild(inp);
        form.appendChild(send);
        detail.appendChild(form);
      }
    }

    /* ---- 已有的赞和评论：收在一块**浅灰**里（赞一行、评论若干行）----
       名字是蓝灰，正文黑，跟微信一致。 */
    var hasLikes = (m.likes || []).length > 0;
    var hasComments = (m.comments || []).length > 0;
    if (hasLikes || hasComments) {
      var grey = h('div', 'mo-grey');
      if (hasLikes) {
        var names = m.likes.map(function (l) { return esc(l.name || '?'); }).join('，');
        /* 微信是**一个空心爱心 + 名字列表**（名字蓝灰、逗号隔开），
           没有「觉得很赞」那四个字 —— 用户拿微信截图指过。
           图标和文案要一起 innerHTML：h() 的第三个参数是 textContent，
           把 SVG 塞进去会被当文字原样显示出来（之前那一坨就是这么来的）。 */
        var likeLine = h('div', 'mo-grey-likes');
        likeLine.innerHTML = '<svg ' + SVG + '><path d="M12 20.2c-.4 0-6.9-4.3-6.9-9.2A4.1 4.1 0 0 1 12 7.9a4.1 4.1 0 0 1 6.9 3.1c0 4.9-6.5 9.2-6.9 9.2z"/></svg>' +
          '<span>' + names + '</span>';
        grey.appendChild(likeLine);
      }
      /* 「两个点」的快捷条 + 点评论行弹出的小菜单（回复 / 删除） */
      var host = document.getElementById('phone') || ctx.el;

      (m.comments || []).forEach(function (c) {
        /* 微信那条评论长这样：「甲 回复 乙：内容」（两个名字都是蓝灰，中间
           「回复」是黑的）。不回复某人时就是「甲：内容」。
           用户给的那张截图就是这个排法。 */
        var line = h('div', 'mo-grey-comment' + (c.replyTo ? ' is-reply' : ''));
        line.title = '点一下：回复 / 删除';
        var headName = c.name || '?';
        var tgt = c.replyTo
          ? (m.comments || []).filter(function (x) { return x.id === c.replyTo; })[0]
          : null;
        if (tgt) {
          line.appendChild(h('span', 'mo-grey-name', headName));
          line.appendChild(h('span', 'mo-grey-rep2', ' 回复 '));
          line.appendChild(h('span', 'mo-grey-name', (tgt.name || '?') + '：'));
        } else {
          line.appendChild(h('span', 'mo-grey-name', headName + '：'));
        }

        /* **先文字、后图**（用户：「图片或者表情包放在文字的后面好看一些」） */
        if (c.text) line.appendChild(h('span', 'mo-grey-text', c.text));
        if (c.mediaId || c.url) {
          var cPic = h('span', 'mo-grey-sticker');
          line.appendChild(cPic);
          var cp = (c.mediaId && Sleepy.media)
            ? Sleepy.media.url(c.mediaId)
            : Promise.resolve(c.url || '');
          cp.then(function (src) {
            if (src) cPic.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
          });
        }

        /* 点整行 → 弹「回复 / 删除」。
           用户：「点击某个人的评论就可以选择是要删除还是回复，
           所以那个回复和 × 的按钮可以变成点一下选择」——
           常驻两个按钮在手机上又挤又容易误触，收进菜单干净得多。 */
        line.addEventListener('click', function (e) {
          e.stopPropagation();
          openCommentMenu(host, line, [
            {
              label: '回复 ' + headName,
              run: function () { replyTarget = c.id; renderDetail('comment'); }
            },
            {
              label: '删除这条评论',
              danger: true,
              run: function () {
                ui.confirm({
                  title: '删掉这条评论？',
                  note: '「' + headName + '：' + (c.text || '（表情）').slice(0, 20) + '」',
                  ok: '删掉',
                  danger: true
                }).then(function (yes) {
                  if (!yes) return;
                  removeComment(m.id, c.id);
                  repaint();
                });
              }
            }
          ]);
        });

        grey.appendChild(line);
      });
      main.appendChild(grey);
    }

    card.appendChild(main);
    return card;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------------- 评论行上的小菜单 ----------------------

     点一条评论弹「回复 / 删除」。为什么不常驻两个按钮：
       · 手机上评论本来就窄，多两个按钮整行都在挤；
       · 「删除」是破坏性动作，常驻会有误触风险（点「回复」点到「删除」）；
       · 微信本来就是点一下才出菜单 —— 用户给的就是微信的截图。

     位置算在 #phone 里（那层是定位上下文，聊天浮层也挂在那儿）。 */
  var cmMenu = null;

  function closeCommentMenu() {
    if (!cmMenu) return;
    var el = cmMenu;
    cmMenu = null;
    document.removeEventListener('click', onMenuDocClick, true);
    el.classList.remove('is-open');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 160);
  }

  function onMenuDocClick(e) {
    if (cmMenu && cmMenu.contains(e.target)) return;
    closeCommentMenu();
  }

  function openCommentMenu(host, anchor, items) {
    if (!host) return;
    closeCommentMenu();
    var menu = h('div', 'mo-cmenu');
    items.forEach(function (it) {
      var b = h('button', 'mo-cmenu-item' + (it.danger ? ' is-danger' : ''), it.label);
      b.type = 'button';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        closeCommentMenu();
        it.run();
      });
      menu.appendChild(b);
    });
    if (items.length) menu.appendChild(h('i', 'mo-cmenu-arrow'));

    host.appendChild(menu);

    /* 先量一下真实宽度再摆位 —— 写死宽度的话中文长一点就会溢出屏幕 */
    var r = anchor.getBoundingClientRect();
    var hr = host.getBoundingClientRect();
    var w = menu.offsetWidth || 150;
    var left = r.left - hr.left;
    if (left + w > hr.width - 8) left = hr.width - w - 8;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = (r.bottom - hr.top + 6) + 'px';

    cmMenu = menu;
    requestAnimationFrame(function () { menu.classList.add('is-open'); });
    setTimeout(function () {
      document.addEventListener('click', onMenuDocClick, true);
    }, 0);
  }

  /* ---------------------------- 发布 ---------------------------- */

  /* ---------------------------- 发布弹层 ----------------------------

     照微信的朋友圈发表页做（用户给了截图）：
       · 上面是输入框 + 表情按钮 —— 表情选一张就当**配图**（表情本来就是图）
       · 中间两条设置行：谁可以看 / 提醒谁看，点开各有一层
       · 底部「发表 / 取消」—— 白卡灰底，不再是大绿块
       · 一句解释都没有 —— 用户：「解释的太多了」

     「以谁的身份发」（替角色发）是我们自己的能力，微信没有 ——
     放最顶上一行紧凑 chips，不解释，点了就懂。

     opts.wantPic：从相机**点击**进来时带上 —— 先选好图再打开弹层；
     长按进来不带（纯文字）。 */
  function openComposer(ctx, sb, people, done, opts) {
    opts = opts || {};
    var host = document.getElementById('phone') || ctx.el;
    var mask = h('div', 'msg-menu-mask');
    var sheet = h('div', 'msg-menu mo-composer');

    /* ---- 以谁的身份发（紧凑一行）---- */
    var cur = people[0];
    var chips = h('div', 'mo-chips mo-who');
    people.forEach(function (p, i) {
      var c = h('button', 'mo-chip' + (i === 0 ? ' is-on' : ''), p.name);
      c.type = 'button';
      c.addEventListener('click', function () {
        cur = p;
        [].forEach.call(chips.children, function (x) { x.classList.remove('is-on'); });
        c.classList.add('is-on');
      });
      chips.appendChild(c);
    });
    sheet.appendChild(h('p', 'mo-composer-label', '以谁的身份发'));
    sheet.appendChild(chips);

    /* ---- 正文 ---- */
    var ta = h('textarea', 'mo-cinput mo-composer-text');
    ta.placeholder = '这一刻的想法…';
    ta.rows = 4;
    ta.maxLength = 300;
    sheet.appendChild(ta);

    /* ---- 配图 ---- */
    var picked = null;
    var picRow = h('div', 'mo-pic-row');
    var picPreview = h('span', 'mo-pic-thumb');
    var picX = h('button', 'mo-pic-x', '×');
    picX.type = 'button';
    picX.title = '去掉这张图';
    picX.addEventListener('click', function () { setPicked(null); });
    picRow.appendChild(picPreview);
    picRow.appendChild(picX);
    sheet.appendChild(picRow);

    function setPicked(p) {
      picked = p;
      if (p && (p.mediaId || p.url)) {
        var src = (p.mediaId && Sleepy.media)
          ? Sleepy.media.url(p.mediaId)
          : Promise.resolve(p.url || '');
        src.then(function (s) {
          if (s) picPreview.style.backgroundImage = 'url(' + JSON.stringify(s) + ')';
        });
        picRow.classList.add('has-pic');
      } else {
        picPreview.style.backgroundImage = '';
        picRow.classList.remove('has-pic');
      }
      refreshSend();
    }

    /* 表情按钮：选一张表情图当配图（不另做一套） */
    var emojiRow = h('div', 'mo-emoji-row');
    var emojiBtn = h('button', 'mo-emoji-btn');
    emojiBtn.type = 'button';
    emojiBtn.title = '配一个表情';
    emojiBtn.setAttribute('aria-label', '配一个表情');
    emojiBtn.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="8.4"/><path d="M9 10.2h.01M15 10.2h.01M9.2 14.4a3.4 3.4 0 0 0 5.6 0"/></svg>';
    emojiBtn.addEventListener('click', function () {
      openStickerPick(ctx, function (st) {
        setPicked({ mediaId: st.mediaId || null, url: st.mediaId ? null : (st.url || '') });
      });
    });
    emojiRow.appendChild(emojiBtn);
    sheet.appendChild(emojiRow);

    /* ---- 设置行 ---- */
    var privacy = { mode: 'all', list: [] };
    var mentions = [];

    function nameOf(refId) {
      var hit = visPool().filter(function (p) { return p.refId === refId; })[0];
      return hit ? hit.name : '';
    }

    var visRow = h('button', 'mo-set-row');
    visRow.type = 'button';
    var visVal = h('span', 'mo-set-val', '公开');
    visRow.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19.2c0-3.1 2.9-5.2 6.5-5.2s6.5 2.1 6.5 5.2"/></svg>';
    visRow.appendChild(h('span', 'mo-set-label', '谁可以看'));
    visRow.appendChild(visVal);
    visRow.appendChild(h('span', 'mo-set-arrow', '›'));
    visRow.addEventListener('click', function () {
      openPrivacyPicker(ctx, visPool(), privacy, function (r) {
        privacy = r;
        visVal.textContent = privacyText(r);
      });
    });

    var atRow = h('button', 'mo-set-row');
    atRow.type = 'button';
    var atVal = h('span', 'mo-set-val', '');
    atRow.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/></svg>';
    atRow.appendChild(h('span', 'mo-set-label', '提醒谁看'));
    atRow.appendChild(atVal);
    atRow.appendChild(h('span', 'mo-set-arrow', '›'));
    atRow.addEventListener('click', function () {
      openPickPeople(ctx, visPool(), mentions, '提醒谁看', function (list) {
        mentions = list;
        atVal.textContent = list.map(nameOf).filter(Boolean).join('、');
      });
    });

    /* h() 只收一个 text 子节点 —— 多个元素要一个个 append，
       塞进去会被静默丢弃（实测：设置行整组消失） */
    var setGroup = h('div', 'mo-set-group');
    setGroup.appendChild(visRow);
    setGroup.appendChild(atRow);
    sheet.appendChild(setGroup);

    function privacyText(r) {
      if (r.mode === 'all') return '公开';
      if (r.mode === 'self') return '私密';
      if (r.mode === 'include') return r.list.length ? ('只有 ' + r.list.length + ' 个人') : '部分可见';
      return r.list.length ? ('不给 ' + r.list.length + ' 个人') : '不给谁看';
    }

    /* 可见范围 / 提醒的人选 = 所有马甲 + 角色（只用当前那张脸的话，
       就没法「只让小号看见」了）。 */
    function visPool() {
      var out = [];
      (core.masksOfSandbox(sb) || []).forEach(function (m) {
        out.push({ kind: 'mask', refId: m.id, name: m.name });
      });
      people.forEach(function (p) { if (p.kind === 'char') out.push(p); });
      return out;
    }

    if (opts.pic) setPicked(opts.pic);

    /* ---- 底部按钮：微信是「发表」（白底，空内容时灰字）+「取消」（灰底）---- */
    var acts = h('div', 'mo-composer-acts');
    var send = h('button', 'mo-btn mo-btn-main', '发表');
    send.type = 'button';
    var cancel = h('button', 'mo-btn mo-btn-alt', '取消');
    cancel.type = 'button';

    function refreshSend() {
      var has = String(ta.value || '').trim() || picked;
      send.classList.toggle('is-idle', !has);
    }
    ta.addEventListener('input', refreshSend);
    refreshSend();

    send.addEventListener('click', function () {
      var text = String(ta.value || '').trim();
      if (!text && !picked) { ctx.toast('写点什么，或者带一张图', 'warn'); return; }
      var who = { kind: cur.kind, refId: cur.refId, name: cur.name };
      var r = add({
        text: text,
        characterId: cur.kind === 'char' ? cur.refId : null,
        name: cur.name,
        mediaId: picked ? picked.mediaId : null,
        url: picked ? picked.url : null,
        w: picked ? picked.w : 0,
        h: picked ? picked.h : 0,
        privacy: privacy.mode,
        visibleTo: privacy.list,
        mentions: mentions
      });
      if (!r) { ctx.toast('没发出去', 'err'); return; }

      /* 角色发的，记进**它的**记忆库；我发的 → 过一会儿有人来接 */
      rememberMoment(r, who);
      pingAI('post', r.id, who, null);

      close();
      if (done) done();
      ctx.toast('发出去了', 'ok');
    });
    cancel.addEventListener('click', close);
    acts.appendChild(send);
    acts.appendChild(cancel);
    sheet.appendChild(acts);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('is-open');
      sheet.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }, 240);
    }
    mask.addEventListener('click', close);

    host.appendChild(mask);
    host.appendChild(sheet);
    setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
    setTimeout(function () { ta.focus(); }, 60);
  }

  /* 「谁可以看」—— 照微信那页做：公开 / 私密 / 部分可见 / 不给谁看。
     后两档选中后展开选人。**点确定才生效**（点遮罩算取消）。 */
  function openPrivacyPicker(ctx, pool, cur, onDone) {
    var host = document.getElementById('phone') || ctx.el;
    var mask = h('div', 'msg-menu-mask');
    var sheet = h('div', 'msg-menu mo-composer mo-privacy');
    sheet.appendChild(h('p', 'mo-composer-title', '谁可以看'));

    var mode = cur.mode || 'all';
    var list = (cur.list || []).slice();

    var opts = [
      { id: 'all', name: '公开', hint: '这间房所有人都可见' },
      { id: 'self', name: '私密', hint: '仅自己可见' },
      { id: 'include', name: '部分可见', hint: '选中的成员可见', pick: true },
      { id: 'exclude', name: '不给谁看', hint: '选中的成员不可见', pick: true }
    ];

    var pickWrap = h('div', 'mo-pick-people');
    var listEl = h('div', 'mo-radio-list');
    opts.forEach(function (o) {
      var line = h('button', 'mo-radio' + (mode === o.id ? ' is-on' : ''));
      line.type = 'button';
      line.appendChild(h('span', 'mo-radio-dot'));
      var main = h('span', 'mo-radio-main');
      main.appendChild(h('span', 'mo-radio-name', o.name));
      main.appendChild(h('span', 'mo-radio-hint', o.hint));
      line.appendChild(main);
      if (o.pick) line.appendChild(h('span', 'mo-radio-arrow', '›'));
      line.addEventListener('click', function () {
        mode = o.id;
        [].forEach.call(listEl.children, function (x) { x.classList.remove('is-on'); });
        line.classList.add('is-on');
        paintPick(o);
      });
      listEl.appendChild(line);
    });
    sheet.appendChild(listEl);
    sheet.appendChild(pickWrap);

    function paintPick(o) {
      pickWrap.innerHTML = '';
      if (!o || !o.pick) { pickWrap.style.display = 'none'; return; }
      pickWrap.style.display = '';
      pickWrap.appendChild(h('p', 'mo-composer-label',
        o.id === 'include' ? '这些成员可见' : '这些成员不可见'));
      var chips = h('div', 'mo-chips');
      pool.forEach(function (p) {
        var on = list.indexOf(p.refId) >= 0;
        var c = h('button', 'mo-chip' + (on ? ' is-on' : ''), p.name);
        c.type = 'button';
        c.addEventListener('click', function () {
          var i = list.indexOf(p.refId);
          if (i >= 0) list.splice(i, 1); else list.push(p.refId);
          c.classList.toggle('is-on');
        });
        chips.appendChild(c);
      });
      pickWrap.appendChild(chips);
    }
    paintPick(opts.filter(function (o) { return o.id === mode; })[0]);

    var acts = h('div', 'mo-composer-acts');
    var ok = h('button', 'mo-btn mo-btn-main', '确定');
    ok.type = 'button';
    var cancel = h('button', 'mo-btn mo-btn-alt', '取消');
    cancel.type = 'button';
    ok.addEventListener('click', function () {
      close();
      onDone({ mode: mode, list: list.slice() });
    });
    cancel.addEventListener('click', close);
    acts.appendChild(ok);
    acts.appendChild(cancel);
    sheet.appendChild(acts);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('is-open');
      sheet.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }, 240);
    }
    mask.addEventListener('click', close);

    host.appendChild(mask);
    host.appendChild(sheet);
    setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
  }

  /* 「提醒谁看」—— chips 多选。被提醒的人在自动回复链里**优先**接话。 */
  function openPickPeople(ctx, pool, cur, title, onDone) {
    var host = document.getElementById('phone') || ctx.el;
    var mask = h('div', 'msg-menu-mask');
    var sheet = h('div', 'msg-menu mo-composer mo-privacy');
    sheet.appendChild(h('p', 'mo-composer-title', title));

    var list = (cur || []).slice();
    var chips = h('div', 'mo-chips mo-pick-chips');
    pool.forEach(function (p) {
      var on = list.indexOf(p.refId) >= 0;
      var c = h('button', 'mo-chip' + (on ? ' is-on' : ''), p.name);
      c.type = 'button';
      c.addEventListener('click', function () {
        var i = list.indexOf(p.refId);
        if (i >= 0) list.splice(i, 1); else list.push(p.refId);
        c.classList.toggle('is-on');
      });
      chips.appendChild(c);
    });
    sheet.appendChild(chips);

    var acts = h('div', 'mo-composer-acts');
    var ok = h('button', 'mo-btn mo-btn-main', '确定');
    ok.type = 'button';
    var cancel = h('button', 'mo-btn mo-btn-alt', '取消');
    cancel.type = 'button';
    ok.addEventListener('click', function () { close(); onDone(list.slice()); });
    cancel.addEventListener('click', close);
    acts.appendChild(ok);
    acts.appendChild(cancel);
    sheet.appendChild(acts);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('is-open');
      sheet.classList.remove('is-open');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }, 240);
    }
    mask.addEventListener('click', close);

    host.appendChild(mask);
    host.appendChild(sheet);
    setTimeout(function () { mask.classList.add('is-open'); sheet.classList.add('is-open'); }, 20);
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.momentsTab = {
    mountTab: mountTab,
    all: all,
    add: add,
    setMedia: setMedia,
    canSee: canSee,
    byId: byId,
    peopleIn: peopleIn,
    rememberMoment: rememberMoment,
    remove: remove,
    toggleLike: toggleLike,
    addComment: addComment,
    removeComment: removeComment,
    wall: wall,
    setWall: setWall,
    /* char 视角的两个（2026-09-22 加，给 L1.5 近期生活动态用）——
       别的模块要「这个角色看得见什么」时走它们，别自己抄一遍三道闸。 */
    canCharSee: canCharSee,
    listForChar: listForChar
  };

})(window);
