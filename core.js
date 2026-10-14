/* ============================================================
   core.js — 小手机 OS 的世界观数据层（纯函数，无 UI）
   依赖：store.js
   被依赖：page-desktop.js、page-idcard.js、page-chat.js、page-mask.js

   为什么单独一层：
     这一层回答的是「这个角色是谁、谁挂在谁名下、这段记忆谁能看见」——
     它跟「怎么画」完全无关，所以既不碰 DOM 也不读 ctx。
     摆到各自页面里会造成三份「查根节点」的实现，迟早漂移。

   ---- 沙盒（顶层容器，最外面那一层）----
     一间房 = 一个存档。isle 孤岛（1v1）／ archipelago 群岛（1vN）。
     它回答的是「**此刻这块数据属于谁**」—— 也就是作用域。
     所有业务数据的读写都要过 scopeId()，这是《沙盒宇宙》的地基。
     详见 docs/施工卡-沙盒宇宙-v1.md。

   ---- 树状层级（《终极架构总纲》第 2 节）----
     kind='main' 大号 / 灵魂层：根节点，独立记忆库
     kind='sub'  皮套 / 小号：挂在某个大号名下，共享同一个大脑
     kind='npc'  附属：属于整座岛（parentType='sandbox'，唯一口径 npcsOfRoom）；
                 岛上的谁认识 TA，由 knownBy / 认知矩阵单独定（2026-09-21 拍板）

     根节点（rootOf）＝ 记忆库的主人。皮套的记忆要归到根上去。

   ---- 双向掉马矩阵（《聊天 App》认知层）----
     认知状态存在 link.cognition 上，只有两个值：
       'unaware' 不知情：系统向 LLM 注入「这是两个独立节点」，
                 它读到带另一个马甲标签的记忆时会自然当成「别人的事」，
                 产生合理既视感，而不是提前开天眼。
       'aware'  已知情：不再掩饰。
     barrier（记忆完全隔离）是更硬的一层：开启后检索层直接拦掉
     非当前马甲组合的记忆，实现纯粹的平行宇宙（连既视感都没有）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  function newId(p) {
    return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* --------------- 作用域过滤：业务数据读写的**唯一口子** ---------------

     漏了过滤 → 两个存档的数据串在一起（《沙盒宇宙》就白做了）；
     把过滤过的数组写回 store → **别的存档的数据被整批抹掉**（更惨）。
     所以下面这条纪律必须成对遵守：

       scoped(list)  只用在**读**的地方
       tagScope(rec) 只用在**写**的地方，写入前盖当前房的章

     写的时候永远是对**全量数组**做 push/filter 再整体 set 回去，
     绝不能 set 一个 scoped() 的结果。 */

  /* 取当前房里的记录。
     scopeId() 为 null（还没分房 / 迁移前）→ **原样返回全部**：
     那是老状态，不能装作没有数据。 */
  function scoped(list) {
    var all = arr(list);
    var sid = scopeId();
    if (!sid) return all;
    return all.filter(function (r) { return r && r.sandboxId === sid; });
  }

  /* 新建记录时盖章。漏盖的后果是这条记录**在任何房里都看不见**
     （静默丢数据），所以写入口一律走它，不要手写 sandboxId。 */
  function tagScope(rec, sandboxId) {
    var out = rec || {};
    var sid = sandboxId || scopeId();
    if (sid) out.sandboxId = sid;
    return out;
  }

  /* ------------------------- 沙盒（顶层容器） -------------------------

     《沙盒宇宙》的第一层：**一间房 = 一个存档**。
       isle（孤岛）        1 User × 1 Char，绝对封闭，别的角色进不来
       archipelago（群岛） 1 User × N Char，房内可拉群、可查手机

     为什么必须单独有这一层：
       现在「进入某间房子」只做到了**换皮肤** —— page-desktop 的 skin()
       跟着 activeChar 走，换的是角色卡/情绪印章/思念电量/双城时间；
       而 chats / photos / diaries / todos 全是全局单份。
       也就是说两个存档的数据根本就是串的，换肤骗不了人。
       沙盒就是这个作用域键（scopeId）。

     本段里的 findChar / findUser 定义在下面，靠函数声明提升调用 —— 
     运行时没问题，但读代码时要知道「沙盒不认识角色树，只是引用它」。 */

  var KIND_ISLE = 'isle';
  var KIND_ARCHI = 'archipelago';

  function listSandboxes() { return arr(store.get('sandboxes')); }

  function findSandbox(id) {
    if (!id) return null;
    var list = listSandboxes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function saveSandboxes(list) { return store.set('sandboxes', list); }

  function sandboxesOfKind(kind) {
    return listSandboxes().filter(function (s) { return s.kind === kind; });
  }

  /* 房成员校验。做成独立的纯函数（而不是塞在 setSandboxChars 里），
     是为了让配置台**在保存之前**就能提示错在哪，不必先写坏再回滚。
       · 孤岛最多一个大号 —— 这是「绝对封闭」的硬约束
       · 成员只能是大号：皮套和 NPC 挂在房里的大号名下，不是房的成员 */
  function validateSandboxChars(kind, charIds) {
    var ids = arr(charIds).filter(Boolean);
    if (kind === KIND_ISLE && ids.length > 1) {
      return { ok: false, message: '孤岛只能有一个角色，多出来的请开群岛' };
    }
    var miss = [];
    for (var i = 0; i < ids.length; i++) {
      var c = findChar(ids[i]);
      if (!c) { miss.push(ids[i]); continue; }
      if ((c.kind || 'main') !== 'main') miss.push(c.name + '（不是大号）');
    }
    if (miss.length) return { ok: false, message: '不能加进房里：' + miss.join('、') };
    return { ok: true, message: '' };
  }

  /* 新建一间房。**空的** —— 成员、马甲、认知锁都在配置台里配，
     所以这里不做「必须有角色」的校验（那时候还没到配人的步骤）。

     name 默认空字符串。2026-09-18 起新建流程会**问一句**岛名（可不填，
     见 page-island.js 的 createRoom）—— 起了名 roomTitle 就用它，
     没起还是由房里的人推出来。 */
  function createSandbox(kind, name) {
    var k = (kind === KIND_ARCHI) ? KIND_ARCHI : KIND_ISLE;
    var sb = {
      id: newId('sb'),
      kind: k,
      name: name || '',
      cover: '',
      charIds: [],
      maskIds: [],
      /* 每岛外观/户型的**权威挂点不在这里** ——
         外观穿着叠在 appearance.desktop.islands[sbId]、户型叠在 desktop.islands[sbId]
         （「岛覆盖 > 全局」，2026-09-21 拍板）。以前在这里预留的
         theme/deskVersion/pages 三个口子没人读过，已收编删除，别再加回来。 */
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    var list = listSandboxes();
    list.push(sb);
    saveSandboxes(list);
    return sb;
  }

  function setSandboxChars(id, charIds) {
    var list = listSandboxes();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { hit = list[i]; break; }
    }
    if (!hit) return { ok: false, message: '找不到这间房' };

    var ids = [];
    arr(charIds).forEach(function (cid) {
      if (cid && ids.indexOf(cid) < 0) ids.push(cid);
    });
    var v = validateSandboxChars(hit.kind, ids);
    if (!v.ok) return v;

    hit.charIds = ids;
    hit.updatedAt = Date.now();
    saveSandboxes(list);
    return { ok: true, sandbox: hit };
  }

  /* 这间房「我」有哪几件马甲（决策 8：马甲完全按房分组）。 */
  function setSandboxMasks(id, maskIds) {
    var list = listSandboxes();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { hit = list[i]; break; }
    }
    if (!hit) return { ok: false, message: '找不到这间房' };

    var ids = [];
    arr(maskIds).forEach(function (uid) {
      if (uid && ids.indexOf(uid) < 0) ids.push(uid);
    });
    var miss = ids.filter(function (uid) { return !findUser(uid); });
    if (miss.length) return { ok: false, message: '这些马甲不存在：' + miss.join('、') };

    hit.maskIds = ids;
    hit.updatedAt = Date.now();
    saveSandboxes(list);
    return { ok: true, sandbox: hit };
  }

  function renameSandbox(id, name) {
    var list = listSandboxes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      list[i].name = String(name || '').trim() || list[i].name;
      list[i].updatedAt = Date.now();
      saveSandboxes(list);
      return { ok: true, sandbox: list[i] };
    }
    return { ok: false, message: '找不到这间房' };
  }

  function setSandboxCover(id, cover) {
    var list = listSandboxes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      list[i].cover = cover || '';
      list[i].updatedAt = Date.now();
      saveSandboxes(list);
      return { ok: true, sandbox: list[i] };
    }
    return { ok: false, message: '找不到这间房' };
  }

  /* 项目4（2026-09-27）：删房从「同步裸删」升级为**异步 purge 门禁**。
     · 跨岛引用守卫（见 purgeGuardReferenced）：被删身份仍被别岛引用 → 拒绝。
     · 判向量能力 → 向量先清（forgetSandbox）拿硬信号 → 才删主表。
     · 失败可见可重试；只有真正清干净才落主表。
     removeSandbox 的 cleanup 逻辑保留为内部 raw 函数（purge 门禁通过后调用），
     不再对外导出（UI 一律走 purgeSandbox，见施工-项目4）。 */

  /* 跨岛引用守卫：目标岛将被连坐清掉的 characters/userMasks，
     扫描其他 sandbox 的 charIds/maskIds 是否仍引用它们。
     命中 → 返回 refs；干净 → 返回 null。任何向量/主表清理之前必须跑。 */
  function purgeGuardReferenced(sbId) {
    var doomedChars = {}, doomedUsers = {};
    var chars = arr(store.get('characters'));
    chars.forEach(function (c) {
      if (c && c.sandboxId === sbId) doomedChars[c.id] = 1;
    });
    var users = arr(store.get('userMasks'));
    users.forEach(function (u) {
      if (u && u.sandboxId === sbId) doomedUsers[u.id] = 1;
    });
    var refs = [];
    listSandboxes().forEach(function (other) {
      if (!other || other.id === sbId) return;
      var names = [];
      arr(other.charIds).forEach(function (cid) {
        if (doomedChars[cid] && names.indexOf(cid) < 0) names.push(cid);
      });
      names.forEach(function (cid) {
        refs.push({ type: 'char', id: cid, sandboxId: other.id, name: other.name || '' });
      });
      var unames = [];
      arr(other.maskIds).forEach(function (uid) {
        if (doomedUsers[uid] && unames.indexOf(uid) < 0) unames.push(uid);
      });
      unames.forEach(function (uid) {
        refs.push({ type: 'user', id: uid, sandboxId: other.id, name: other.name || '' });
      });
    });
    return refs.length ? refs : null;
  }

  /* 向量能力门禁：是否允许走「向量先清再删主表」的 purge。
     返回 { ok:true } 或 { ok:false, why }。无向量环境（!indexedDB）视为可用（直接清主表）。 */
  function purgeVecGate() {
    if (!global.indexedDB) return { ok: true, nodb: true };
    var MV = global.Sleepy && global.Sleepy.memoryVec;
    if (!MV || typeof MV.forgetSandbox !== 'function') {
      return { ok: false, why: 'memory-vector-unavailable/api-missing' };
    }
    return { ok: true, nodb: false };
  }

  function purgeSandbox(sbId) {
    if (!sbId) return Promise.resolve({ ok: false, message: '缺少沙盒 id' });
    var hit = findSandbox(sbId);
    if (!hit) return Promise.resolve({ ok: false, message: '找不到这间房' });

    /* ① 跨岛引用守卫（任何清理之前） */
    var refs = purgeGuardReferenced(sbId);
    if (refs) {
      return Promise.resolve({ ok: false, why: 'still-referenced', by: refs });
    }

    /* ② 向量能力判定 */
    var gate = purgeVecGate();
    if (!gate.ok) return Promise.resolve({ ok: false, why: gate.why });

    /* ③ 向量先清（不吞错），拿硬信号才继续 */
    var doCleanup = function () { return cleanupSandbox(sbId); };
    if (gate.nodb) return Promise.resolve(doCleanup());

    var MV = global.Sleepy.memoryVec;
    return MV.forgetSandbox({ sandboxId: sbId }).then(function (n) {
      return doCleanup();            /* 空岛 resolve 0 也是合法成功，照常清主表 */
    }, function (err) {
      return { ok: false, why: 'memory-vector-failed', error: (err && err.message) || String(err) };
    });
  }

  /* ⚠️ 测试专用同步清理（smoke 存量清理用，2026-09-27 项目4）：
     只做主表/派生 cleanup，**不做跨岛守卫、不做向量门禁**。
     生产 UI 一律走异步 purgeSandbox/purgeChar/purgeFace/purgeUser（带门禁），
     绝不允许产品代码调这些 sync 出口。smoke 默认无 indexedDB（nodb），
     它们与 purge 在无向量环境下的行为一致（直接清主表）。 */
  function _purgeSyncSandbox(id) { return cleanupSandbox(id); }
  function _purgeSyncChar(id) {
    return cleanupChar(id);
  }
  function _purgeSyncFace(subId) {
    return cleanupChar(subId);
  }
  function _purgeSyncUser(uid, sbId) {
    return cleanupUser(uid, sbId);
  }

  /* 删一间房，连带清掉**明确属于它**的数据。
     纪律：只删 sandboxId === id 的记录。
     没有 sandboxId 的那些是 S3 迁移之前的老全局数据，不属于任何房，
     一律不碰 —— 否则第一次删房就会顺手把用户的老存档抹掉。
     ⚠️ 仅供 purgeSandbox 门禁通过后调用，不再对外导出。 */
  function cleanupSandbox(id) {
    if (!id) return { ok: false, message: '缺少沙盒 id' };
    var hit = findSandbox(id);
    if (!hit) return { ok: false, message: '找不到这间房' };

    saveSandboxes(listSandboxes().filter(function (s) { return s.id !== id; }));

    /* 这一串是「按房切开」的数据键。**新增带 sandboxId 的键要记得加进来** ——
       漏了的话删房时它不会跟着清，会在 localStorage 里越积越多，
       而且下次有人建同 id 的房（id 是随机的，概率极低）会看到幽灵数据。
       characters 也在名单里：大号、皮套、NPC 全都打岛的章（2026-09-21 拍板），
       拆岛 = 岛上的人跟着没。没有章的记录（迁移前的老全局数据）不会被动。 */
    var removed = {};
    var scoped = ['chats', 'memories', 'links', 'photos', 'diaries',
                  'todos', 'favorites', 'weEntries', 'weProposals', 'userMasks', 'characters', 'moments',
                  'wallet', 'stickers', 'offlineSessions',
                  /* 贴纸工坊断点索引（page-collection skSheetIndex*）：
                     records 带 sandboxId（tagScope），删房跟着清 */
                  'stickerSheets',
                  'groups', 'groupMembers', 'groupMessages', 'offlineHandoffs',
                  'groupOfflineSessions',
                  /* 查手机系统（phone.js / 施工卡-查手机-v1）：
                     十条表全部 scoped，删房跟着清，漏了会积幽灵数据 */
                  'phones', 'phonePerms', 'phoneSessions', 'phoneTraces',
                  'phonePlans', 'phoneMsgs', 'phoneNotes', 'phoneBrowser',
                  'phoneShop', 'phoneHealth',
                  /* 工坊（page-workshop.js）：安装实例和记录按岛隔离；
                     wsTemplates 是 user 创作侧的全局资产，不随房删 */
                  'wsInstalls', 'wsRecords',
                  /* 日历（calendar.js）：每个 char 一份配置 + 事件表。
                     两张表都按 (sandboxId, charId) 隔离，删房跟着清。 */
                  'calConfigs', 'calEvents',
                  /* 最小动作协议（action.js，2026-10-03 第二轮施工单第三批）：
                     action request / result / receipt 记录，按岛隔离，删房跟着清。 */
                  'actionRequests',
                  /* ta 首页三张结构化表（ta-life.js，2026-10-02 第二批）：
                     事项/承诺/关注，tagScope 盖岛章，删房跟着清。 */
                  'taItems', 'taPromises', 'taFollows',
                  'taNpcDrafts', 'taProposals', 'taEvents',
                  /* 挂件灯留言（page-desktop Sleepy.lampNotes，2026-10-06）：
                     灯上的话跟岛走，tagScope 盖章 / scoped 读，删房跟着清 */
                  'lampNotes',
                  /* 组件商城批4（施工卡-组件商城-v1）：自定义组件模板 +
                     慢递信箱。都是 user/char 的内容数据，跟岛走，删房跟着清 */
                  'customWidgets', 'slowLetters',
                  /* 群声 · 公共论坛（施工卡-群声-v1 Batch A，forum-core.js）：
                     13 张表全部 scoped，删房跟着清；
                     forumSettingsBySandbox / selectedForumAccountBySandbox
                     是按 sbId 切的映射键，走下面「带 sbId 的键」那条路。 */
                  'forumAccounts', 'forumBoards', 'forumPosts', 'forumComments',
                  'forumReposts', 'forumFollows', 'forumLikes', 'forumCollections',
                  /* 以身入局（book-core.js，施工卡-以身入局-P0）：
                     档案盒 / 任务运行 tagScope 盖岛章，删房跟着清；
                     bookSettingsBySandbox 是映射键，走下面映射键那条路。 */
                  'bookBoxes', 'bookRuns', 'bookImports',
                  'forumNotifications', 'forumShares', 'forumKnowledge',
                  /* 数据卫生批（2026-10-12 删房名单差集）：三张盖岛章的数组表，
                     之前漏登记 —— dropEvents（掉马事件 core.js:1463 盖章）、
                     momentPending（moments-ai 待回复队列 allPending 全量写）、
                     momentWall（朋友圈壁纸，{sandboxId,...} 记录） */
                  'dropEvents', 'momentPending', 'momentWall'];
                  /* forumShareReceipts / forumDrafts 已摘（2026-10-12 P2 死键清理，见 store.js） */

    /* ⚠️ 顺序敏感：挂在**会话 id** 上的动态单键必须先清，再清 chats。
       键名里带的是 chatId（不是 sbId），所以 scoped() 和下面「带 sbId 的键」
       两条路都抓不到它 —— 只有遍历这间房的会话才拿得到那些 id。
       htmlGameResult:<chatId> 是 page-chat 的 html 小游戏待转述结算痕迹
       （page-chat 的 gameResultPeekMsg，一次性的，读走即 set(null)）。
       等 chats 清完就再也查不到这些 chatId 了，键会永远留在 localStorage 里
       （set(null) 也占着位，还会进 exportAll 的兜底扫描）。 */
    if (store.remove) {
      arr(store.get('chats')).forEach(function (ch) {
        if (!ch || ch.sandboxId !== id || !ch.id) return;
        /* remove 对不存在的键是安静的无操作 —— 这里不需要先判存在 */
        store.remove('htmlGameResult:' + ch.id);
      });
    }

    /* 数据卫生批（2026-10-12 删房名单差集核查，docs/核查-数据链路-2026-10-12.md §四）：
       挂在本房 char / chat / group id 上的**动态单键**。宿主记录马上会在
       下面的 scoped 循环里被清，而这些键键名里只有宿主 id、没有 sbId，
       scoped 名单永远抓不到 —— 必须趁宿主还在先把 id 收集齐，再逐个 remove。
       repoDeviceId / repoLikedIds / repoInboxSeen 是**设备级**键（repo-core.js
       开头注释明示不进岛章/删房名单），刻意不在这里清。 */
    var doomedChars = {}, doomedRoots = {}, doomedChats = {}, doomedGroups = {};
    arr(store.get('characters')).forEach(function (c) {
      if (c && c.sandboxId === id && c.id) {
        doomedChars[c.id] = 1;
        var rt = rootOf(c.id);
        if (rt && rt.id) doomedRoots[rt.id] = 1;
      }
    });
    arr(store.get('chats')).forEach(function (ch) {
      if (ch && ch.sandboxId === id && ch.id) doomedChats[ch.id] = 1;
    });
    arr(store.get('groups')).forEach(function (g) {
      if (g && g.sandboxId === id && g.id) doomedGroups[g.id] = 1;
    });
    if (store.remove) {
      var dynKeys = [];
      Object.keys(doomedRoots).concat(Object.keys(doomedChars)).forEach(function (cid) {
        ['charMem:', 'charState:', 'openLoops:', 'attentionInbox:',
         'relationIntent:', 'proactiveState:', 'phoneRawFail:'].forEach(function (p) {
          dynKeys.push(p + cid);
        });
      });
      Object.keys(doomedChats).forEach(function (chId) {
        dynKeys.push('sumRawFail:' + chId, 'sumCursor:' + chId);
      });
      Object.keys(doomedGroups).forEach(function (gid) {
        dynKeys.push('groupInner:' + gid, 'groupPending:' + gid,
                     'sumCursor:g:' + gid, 'sumRawFail:g:' + gid);
      });
      dynKeys.forEach(function (k) {
        var v = store.get(k);
        if (v !== null && v !== undefined) {
          store.remove(k);
          removed[k] = 1;
        }
      });
    }

    /* 挂在角色 id 上的三张 byChar 映射（memoryIsland / charSettings / charVoice）：
       同下面 charAppearance.byChar 的幽灵过滤 —— 键名没有 sbId，
       按「本房 doomed 的角色 id」删条目，别的岛/别的房不受影响。 */
    ['memoryIsland', 'charSettings', 'charVoice'].forEach(function (mk) {
      var m = store.get(mk);
      var by = m && m.byChar;
      if (!by || typeof by !== 'object') return;
      var goneBy = 0;
      for (var bk in by) {
        if (has(by, bk) && (doomedRoots[bk] || doomedChars[bk])) { delete by[bk]; goneBy++; }
      }
      if (goneBy) { store.set(mk, m); removed[mk] = goneBy; }
    });

    scoped.forEach(function (key) {
      var all = arr(store.get(key));
      if (!all.length) return;
      var keep = all.filter(function (r) { return !(r && r.sandboxId === id); });
      var gone = all.length - keep.length;
      if (!gone) return;
      store.set(key, keep);
      removed[key] = gone;
    });

    /* 岛级覆盖层（「岛覆盖 > 全局」那套）：外观穿着叠在 appearance.desktop.islands、
       户型叠在 desktop.islands，键就是 sbId —— 删房不清的话，下次建同 id 的房
       （概率极低但不是零）会穿上一座幽灵岛的穿着。desktopRemoved 的记录在
       写入时盖了章（page-desktop rememberRemoved），按章过滤。 */
    var look = store.get('appearance');
    if (look && look.desktop && look.desktop.islands && look.desktop.islands[id]) {
      delete look.desktop.islands[id];
      store.set('appearance', look);
      removed.appearanceIslands = 1;
    }
    var desk = store.get('desktop');
    if (desk && desk.islands && desk.islands[id]) {
      delete desk.islands[id];
      store.set('desktop', desk);
      removed.desktopIslands = 1;
    }
    var dr = arr(store.get('desktopRemoved'));
    var drKeep = dr.filter(function (r) { return !(r && r.sandboxId === id); });
    if (drKeep.length !== dr.length) {
      store.set('desktopRemoved', drKeep);
      removed.desktopRemoved = dr.length - drKeep.length;
    }

    /* 按房动态拼出来的键（不在 scoped 名单里 —— 它们的键名里就带着 sbId）：
       charRel:<sbId> 是群岛关系三态 / 身份归属判断 / 写在红线上的关系的宿主。
       不清的话 localStorage 里留一堆幽灵岛的关系数据。 */
    var rel = store.get('charRel:' + id);
    if (rel !== null && rel !== undefined) {
      if (store.remove) store.remove('charRel:' + id);
      removed.charRel = 1;
    }

    /* 挂在角色 id 上的悬空引用：charAppearance.byChar（角色外观按 charId 存，
       键名里没有 sbId，scoped 名单抓不到）。characters 刚才已按岛章连人清掉，
       留下的配置成了幽灵 —— 按「还活着的角色」过滤一遍。 */
    var ap = store.get('charAppearance');
    if (ap && ap.byChar && typeof ap.byChar === 'object') {
      var alive = {};
      arr(store.get('characters')).forEach(function (c) { alive[c.id] = 1; });
      var goneAp = 0;
      for (var ak in ap.byChar) {
        if (has(ap.byChar, ak) && !alive[ak]) { delete ap.byChar[ak]; goneAp++; }
      }
      if (goneAp) {
        store.set('charAppearance', ap);
        removed.charAppearance = goneAp;
      }
    }

    /* 群声的按岛映射键（forum-core.js）：键名是 sbId、值是对象，
       同上面幽灵岛那套道理 —— 删房不清会留下幽灵岛的设置 / 论坛身份。 */
    ['forumSettingsBySandbox', 'selectedForumAccountBySandbox',
     'forumAnonPoolMigrated', 'bookSettingsBySandbox'].forEach(function (mk) {
      var m = store.get(mk);
      if (m && has(m, id)) {
        delete m[id];
        store.set(mk, m);
        removed[mk] = 1;
      }
    });

    if (store.get('activeSandboxId') === id) store.set('activeSandboxId', null);

    return { ok: true, removed: removed };
  }

  /* 此刻人在哪间房。
     没有 activeSandboxId 时兜底返回第一间（免得整个 App 因为「没有当前房」
     而空白）；一间房都没有时返回 null —— S3 迁移之前就是这个状态，
     所有调用方都要能接受 null，不能假设「一定有房」。 */
  function activeSandbox() {
    var sb = findSandbox(store.get('activeSandboxId'));
    if (sb) return sb;
    var list = listSandboxes();
    return list.length ? list[0] : null;
  }

  /* **作用域键**。所有业务数据的读写都要过它。
     没有房时返回 null —— 这个 null 是有意义的：
     它表示「还没分房的老全局数据」，不是错误。 */
  function scopeId() {
    var sb = activeSandbox();
    return sb ? sb.id : null;
  }

  function setActiveSandbox(id) {
    if (!id) {
      store.set('activeSandboxId', null);
      return { ok: true, sandbox: null };
    }
    var sb = findSandbox(id);
    if (!sb) return { ok: false, message: '找不到这间房' };
    store.set('activeSandboxId', sb.id);
    return { ok: true, sandbox: sb };
  }

  /* 这间房里的大号（按 charIds 顺序，查不到的直接跳过）。 */
  function charsOfSandbox(id) {
    var sb = typeof id === 'object' ? id : findSandbox(id);
    if (!sb) return [];
    var out = [];
    arr(sb.charIds).forEach(function (cid) {
      var c = findChar(cid);
      if (c) out.push(c);
    });
    return out;
  }

  /* 这间房「我」能用的马甲。 */
  function masksOfSandbox(id) {
    var sb = typeof id === 'object' ? id : findSandbox(id);
    if (!sb) return [];
    var out = [];
    arr(sb.maskIds).forEach(function (uid) {
      var u = findUser(uid);
      if (u) out.push(u);
    });
    return out;
  }

  /* 决策 4：桌面差异只在**步骤** ——
     孤岛打开就是那个角色的桌面；群岛要先选角色再进。
     App 集合完全一样，不做可见性隐藏。 */
  function needsCharPick(id) {
    var sb = typeof id === 'object' ? id : findSandbox(id);
    if (!sb || sb.kind !== KIND_ARCHI) return false;
    return arr(sb.charIds).length > 1;
  }

  /* ---------------------------- 角色树 ---------------------------- */

  function allChars() { return arr(store.get('characters')); }

  function findChar(id) {
    if (!id) return null;
    var list = allChars();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* 大号列表（根节点）。桌面、切号器、浮岛的配置台都用它 */
  function mainChars() {
    return allChars().filter(function (c) { return (c.kind || 'main') === 'main'; });
  }

  /* 挂在这个大号名下的皮套 */
  function subChars(mainId) {
    return allChars().filter(function (c) {
      return c.kind === 'sub' && c.parentId === mainId;
    });
  }

  /* 挂在这个大号名下的 NPC（**只读老数据**：新口径 NPC 归岛，
     用 npcsOfRoom 查；这两个函数留着是为了老存档里的 NPC 不凭空消失） */
  function npcChars(mainId) {
    return allChars().filter(function (c) {
      return c.kind === 'npc' && c.parentId === mainId &&
        (c.parentType || 'char') === 'char';
    });
  }

  /* 挂在「我」（User 马甲）名下的 NPC（**只读老数据**，新口径见 npcsOfRoom）。
     关系树里「我」下面曾经也能加人 —— 邻居、同事、楼下咖啡店的人。
     2026-09-21 起不再产生这种数据（NPC 归岛），查询并入 npcsOfRoom。 */
  function userNpcs(userId) {
    if (!userId) return [];
    return allChars().filter(function (c) {
      return c.kind === 'npc' && c.parentId === userId &&
        c.parentType === 'user';
    });
  }

  /* 岛内全体 NPC —— **全仓唯一口径**（四.2 收敛，2026-09-21 用户拍板）。
     新归属（09-19 定稿）：NPC 属于整座岛（parentType='sandbox'，parentId=sb.id），
     不属于 user 或 char 的任何一方 —— 谁认识他由 knownBy 决定。
     老数据（挂在房内 char / user 名下的）仍然收进来，别让老 NPC 凭空消失。
     sb 传对象或 id 都行。没降落在任何岛上时照样可以按 id 查。 */
  function npcsOfRoom(sb) {
    if (!sb) return [];
    var room = typeof sb === 'object' ? sb : findSandbox(sb);
    if (!room) return [];
    var roomId = room.id;
    var inRoom = function (c) { return !c.sandboxId || c.sandboxId === roomId; };
    var out = allChars().filter(function (c) {
      return c.kind === 'npc' && (c.parentType || '') === 'sandbox' &&
        c.parentId === roomId && inRoom(c);
    });
    charsOfSandbox(room).forEach(function (m) {
      allChars().forEach(function (c) {
        if (c.kind !== 'npc' || !inRoom(c)) return;
        if (c.parentId === m.id && (c.parentType || 'char') === 'char') out.push(c);
      });
    });
    var me = activeUser();
    if (me) {
      allChars().forEach(function (c) {
        if (c.kind !== 'npc' || !inRoom(c)) return;
        if (c.parentId === me.id && c.parentType === 'user') out.push(c);
      });
    }
    return out;
  }

  /* 大号 + 它的全部皮套 + NPC，这是一个「宇宙」的全体成员 */
  function universeOf(mainId) {
    var root = findChar(mainId);
    if (!root) return [];
    if ((root.kind || 'main') !== 'main') root = findChar(root.parentId) || root;
    var out = [root];
    var all = allChars();
    for (var i = 0; i < all.length; i++) {
      if (all[i].parentId === root.id && all[i].id !== root.id) out.push(all[i]);
    }
    return out;
  }

  /* 记忆库的主人。给了皮套要顺着 parentId 找到它的大号 ——
     记忆全量存在大号身上，皮套自己不存一份，否则掉马时两边对不上。 */
  function rootOf(id) {
    var c = findChar(id);
    if (!c) return null;
    if ((c.kind || 'main') === 'main') return c;
    return findChar(c.parentId) || c;
  }

  function rootIdOf(id) {
    var r = rootOf(id);
    return r ? r.id : null;
  }

  /* 大号自己 + 它的皮套，切号器里可切换的「身份」 */
  function switchableOf(mainId) {
    return universeOf(mainId).filter(function (c) {
      return (c.kind || 'main') !== 'npc';
    });
  }

  function saveChars(list) { return store.set('characters', list); }

  function upsertChar(data) {
    data = data || {};
    var list = allChars();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === data.id) { hit = list[i]; break; }
    }
    if (hit) {
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) hit[k] = data[k];
      }
      hit.updatedAt = Date.now();
    } else {
      /* 先铺默认值，再把 data 叠上去。
         注意**顺序不能反**：早先的写法是先建好带 newId() 的 item、
         再 for-in 把 data 盖上来——data 里没有 id 的时候会把生成好的
         id 覆盖成 undefined，于是新建的角色永远查不到（rootOf 全挂）。
         现在先铺默认值再叠加，并且只在 data 真的带了值时才覆盖。 */
      var item = {
        id: data.id || newId('ch'),
        kind: data.kind || 'main',
        parentId: has(data, 'parentId') ? data.parentId : null,
        /* 父亲是个「人」还是个「角色」。
           原本只有大号能收养 NPC（parentType='char'）；关系树上线后
           「我」（User 马甲）下面也能挂 NPC，所以需要区分 ——
           两种 id 在不同命名空间里，光看 id 前缀去猜太脆。
           'char' = 挂在角色名下（默认，向后兼容老数据）
           'user' = 挂在 User 马甲名下 */
        parentType: has(data, 'parentType') ? data.parentType : 'char',
        boundUserId: has(data, 'boundUserId') ? data.boundUserId : null,
        name: data.name || '未命名角色',
        /* 微信名：会话列表/聊天页对外显示的名字（用户 2026-09-21）。 */
        wechatName: data.wechatName || '',
        content: data.content || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      for (var j in data) {
        if (Object.prototype.hasOwnProperty.call(data, j) && data[j] !== undefined) {
          item[j] = data[j];
        }
      }
      /* 全部按房建（2026-09-21 拍板：大号也是每岛一份，**没有全局大号** ——
         想玩同一个人设就是再建一个新的人，各长各的）。调用方没显式给
         sandboxId 时，盖上当前这间房的章。漏了的话它不属于任何房 ——
         在房内的树、通讯录、切号器里全看不见，等于白建；拆岛也不会跟着清。 */
      if (!item.sandboxId) tagScope(item);
      list.push(item);
      hit = item;
    }
    saveChars(list);
    return hit;
  }

  /* 一个角色的「整个家谱」：它自己 + 挂在它名下的全部后代（递归 char 树）。
     只收 char-口径（parentId === 上一级 id，parentType='char'）——
     sandbox 口径 NPC（parentId=岛id）不在此树里，user 口径 NPC（parentId=马甲id）也不在。
     ⚠️ 项目4（2026-09-27）：删除语义的铁律是「主表 doomed = 向量命中集合」，
     所以主表删除（cleanupChar）和向量删除（purgeChar/purgeFace → forgetCharSet）
     **必须共用同一个 doomed 集合**，不能各自算一遍。 */
  function doomedCharIds(id) {
    var out = [], seen = {};
    (function walk(x) {
      if (!x || seen[x]) return;
      seen[x] = true;
      out.push(x);
      allChars().forEach(function (c) {
        /* 2026-09-29（用户拍板）：删除**永不连坐 NPC** —— NPC 属于整座岛，
           不属于任何一方。挂在将被删的皮套/大号名下的 NPC 由 cleanupChar
           收编归岛，不进 doomed（主表与向量共用本函数，两边自动一致）。 */
        if ((c.kind || '') === 'npc') return;
        if (c.parentId === x) walk(c.id);
      });
    })(id);
    return out;
  }

  /* 删除角色（大号/皮套/NPC 均走这里）：清 doomed 家谱 + 断掉的对话/关系/记忆。
     2026-09-29 起家谱**不含 NPC** —— 挂在 doomed 名下的 char 口径 NPC 改判
     归岛（parentType='sandbox'，parentId=它的岛），不跟着死。
     ⚠️ 项目4（2026-09-27）：从「同步裸删」升级为异步 purge 门禁，
     UI 一律走 purgeChar / purgeFace。本函数保留为门禁通过后的 cleanup，
     不再对外导出。doomed 用 doomedCharIds（递归），与向量侧一致。 */
  function cleanupChar(id, sbId) {
    var doomed = {};
    doomedCharIds(id).forEach(function (cid) { doomed[cid] = true; });
    var next = allChars()
      .map(function (c) {
        /* 家谱断了但人不删：NPC 收编归岛。parentId 优先用调用方给的岛 id，
           没有就用 NPC 自己身上的章（sandboxId）—— 兜底 _purgeSyncChar 没有 sbId。 */
        if ((c.kind || '') === 'npc' && doomed[c.parentId]) {
          var home = sbId || c.sandboxId;
          if (home) return Object.assign({}, c, { parentId: home, parentType: 'sandbox' });
        }
        return c;
      })
      .filter(function (c) { return !doomed[c.id]; });
    saveChars(next);

    /* 相关的对话和关系一并清掉，否则聊天列表点进去是空壳 */
    store.set('chats', arr(store.get('chats')).filter(function (ct) {
      return !doomed[ct.characterId];
    }));
    store.set('links', arr(store.get('links')).filter(function (l) {
      return !doomed[l.charId];
    }));
    store.set('memories', arr(store.get('memories')).filter(function (m) {
      return !doomed[m.rootId] && !doomed[m.fromCharId];
    }));
    return { ok: true, removed: Object.keys(doomed).length };
  }

  /* 删大号 / NPC：按「doomed 角色树」+ 岛清主表和向量。
     doomed = doomedCharIds(该 id)（递归：皮套全带；**NPC 一律不连坐**，
     2026-09-29 用户拍板 —— 挂在 doomed 名下的 NPC 由 cleanupChar 收编归岛）。
     sandbox 口径 NPC（parentId=岛id）本就不在此树里 —— 它们是岛的成员。
     向量侧 forgetCharSet(fromCharIds=同款 doomed + sandboxId) —— 主表 doomed 与向量命中
     **严格一致**，不再按 charId=rootOf 一刀切（那张删法会误清同 root 整池，见实现注释）。 */
  function purgeChar(charId, sbId) {
    if (!charId) return Promise.resolve({ ok: false, message: '缺少角色 id' });
    var c = findChar(charId);
    if (!c) return Promise.resolve({ ok: false, message: '找不到这个角色' });
    if (!sbId) {
      sbId = c.sandboxId || (global.Sleepy.core && global.Sleepy.core.scopeId ? global.Sleepy.core.scopeId() : null);
    }
    if (!sbId) return Promise.resolve({ ok: false, message: '缺少沙盒 id' });

    var gate = purgeVecGate();
    if (!gate.ok) return Promise.resolve({ ok: false, why: gate.why });
    var doCleanup = function () { return cleanupChar(charId, sbId); };
    if (gate.nodb) return Promise.resolve(doCleanup());

    var MV = global.Sleepy.memoryVec;
    /* 按 doomedCharIds（递归家谱）删向量 —— 与主表 doomed 完全一致。
       单 NPC 只删 {NPC}，大号连坐 {大号+全部皮套}（NPC 不连坐），别岛由 sandboxId 隔离保留。 */
    return MV.forgetCharSet({ charIds: doomedCharIds(charId), sandboxId: sbId }).then(function (n) {
      return doCleanup();
    }, function (err) {
      return { ok: false, why: 'memory-vector-failed', error: (err && err.message) || String(err) };
    });
  }

  /* 删单个皮套：按「皮套 doomed 集合」同 root + 岛清（NPC 不连坐，收编归岛）。
     ⚠️ 铁律：同 root 别的皮套、别岛同 root 的块**必须保留**。
     早期实现按 charId=rootOf 一刀切 → 会把大号整池一起清；后改成三维
     {charId=root, fromCharId=sub, sandboxId} → 又漏删子 NPC（其块 fromCharId=NPC 而非皮套）。
     现统一走 forgetCharSet(fromCharIds=doomedCharIds(subId)) + sandboxId：
       主表 doomed（cleanupChar 同款递归） = 向量命中集合，一一对应。 */
  function purgeFace(subId, sbId) {
    if (!subId) return Promise.resolve({ ok: false, message: '缺少皮套 id' });
    var sub = findChar(subId);
    if (!sub) return Promise.resolve({ ok: false, message: '找不到这个皮套' });
    if ((sub.kind || 'main') === 'main') {
      return Promise.resolve({ ok: false, message: '这是大号，不是皮套' });
    }
    if (!sbId) {
      sbId = sub.sandboxId || (global.Sleepy.core && global.Sleepy.core.scopeId ? global.Sleepy.core.scopeId() : null);
    }
    if (!sbId) return Promise.resolve({ ok: false, message: '缺少沙盒 id' });

    var gate = purgeVecGate();
    if (!gate.ok) return Promise.resolve({ ok: false, why: gate.why });
    var doCleanup = function () { return cleanupChar(subId, sbId); };
    if (gate.nodb) return Promise.resolve(doCleanup());

    var MV = global.Sleepy.memoryVec;
    return MV.forgetCharSet({ charIds: doomedCharIds(subId), sandboxId: sbId })
      .then(function (n) {
        return doCleanup();
      }, function (err) {
        return { ok: false, why: 'memory-vector-failed', error: (err && err.message) || String(err) };
      });
  }

  /* ---------------------------- User 马甲 ---------------------------- */

  function userMasks() { return arr(store.get('userMasks')); }

  function findUser(id) {
    if (!id) return null;
    var list = userMasks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function saveUsers(list) { return store.set('userMasks', list); }

  /* 没有马甲时兜一个「我」，保证任何页面都不会因为 userId 是 null 而空白 */
  function ensureDefaultUser() {
    var list = userMasks();
    if (list.length) return list[0];
    var mask = {
      id: newId('um'),
      name: '我',
      avatar: '',
      persona: '',
      isDefault: true,
      createdAt: Date.now()
    };
    /* 这件兜底「我」**故意不打章**：它是「连一件马甲都没有」时的最后兜底，
       盖了章就只属于第一个岛，别的岛连兜底都没有了。真正的马甲走
       upsertUser，按岛打章。 */
    saveUsers([mask]);
    return mask;
  }

  function upsertUser(data) {
    data = data || {};
    var list = userMasks();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === data.id) { hit = list[i]; break; }
    }
    if (hit) {
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) hit[k] = data[k];
      }
      hit.updatedAt = Date.now();
    } else {
      hit = {
        id: data.id || newId('um'),
        /* 名字**允许留空**（用户 2026-09-22：「名字可以不填，不填的话 char
           就只知道微信名（大号小号都是）」）—— 调用方显式给了空串就存空串，
           只有连这个键都没给时才兜「我」。用 `||` 会把「显式留空」吃掉。 */
        name: has(data, 'name') ? data.name : '我',
        /* 微信名：会话列表/聊天页对外显示的名字（用户 2026-09-21）。
           名字留空时**反过来**由它顶上（core.labelOfUser 的口径）。 */
        wechatName: has(data, 'wechatName') ? data.wechatName : '',
        avatar: has(data, 'avatar') ? data.avatar : '',
        avatarMedia: has(data, 'avatarMedia') ? data.avatarMedia : '',
        persona: has(data, 'persona') ? data.persona : '',
        note: has(data, 'note') ? data.note : '',
        /* 常驻地点三件套随档案走（方案-浮岛时区）。city 以前在新建分支
           被丢掉 —— 编辑页传了、库里没有，读回去永远是空。 */
        city: has(data, 'city') ? data.city : '',
        region: has(data, 'region') ? data.region : '',
        timezone: has(data, 'timezone') ? data.timezone : '',
        isDefault: !!data.isDefault,
        /* B1 生图外貌：只喂生图管线的 ImagePlan subjects，**不进聊天 Prompt**。
           旧马甲没这些键 → 空字符串兜底（读取侧统一按空处理，无破坏性迁移）。 */
        gender: has(data, 'gender') ? data.gender : '',
        faceLockText: has(data, 'faceLockText') ? data.faceLockText : '',
        faceLockSelfie: has(data, 'faceLockSelfie') ? data.faceLockSelfie : '',
        faceLockFull: has(data, 'faceLockFull') ? data.faceLockFull : '',
        /* B2 图片锁脸（2026-10-02）：URL 与本地图（mediaId）两来源并存，
           本地优先；faceLockImageOn 是「授权随生图请求上传」的持久开关 ——
           存图不等于授权（施工单 §3），自动入口只认显式 true。 */
        faceLockImage: has(data, 'faceLockImage') ? data.faceLockImage : '',
        faceLockImageMedia: has(data, 'faceLockImageMedia') ? data.faceLockImageMedia : '',
        faceLockImageOn: !!data.faceLockImageOn,
        /* 岛章：调用方显式给了就照写（配置台「在本岛建马甲」），
           没给才盖当前房的章（tagScope）。以前 new-item 分支根本不收
           sandboxId，跨岛开着的配置台建出来会盖错章。 */
        sandboxId: has(data, 'sandboxId') ? data.sandboxId : '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      /* 马甲按岛（2026-09-21 拍板：马甲是 user 的小号，跟 char 同一原理 ——
         捆绑岛屿、各岛各的；想要别的岛也有这个人设，复制过去就是一件新的）。
         调用方没显式给 sandboxId 时盖当前房的章，否则删岛不清、名册语义失效。 */
      if (!hit.sandboxId) tagScope(hit);
      list.push(hit);
      /* 不变量：**每座岛至少有一件「我的大号」**（isDefault）——
         落岛要把「我」归位到大号，没有大号的岛就没法归位。
         调用方显式给了 isDefault 就听它的（编辑页的开关能关掉），
         没给才兜底：本岛一件大号都没有就给这件盖上。 */
      if (!has(data, 'isDefault')) {
        var sid = hit.sandboxId || '';
        var hasBig = list.some(function (u) {
          return u.id !== hit.id && (u.sandboxId || '') === sid && !!u.isDefault;
        });
        if (!hasBig) hit.isDefault = true;
      }
    }
    saveUsers(list);
    return hit;
  }

  /* 项目4（2026-09-27）：删马甲从「同步裸删」升级为异步 purge 门禁。
     purgeUser 显式保护跨岛共享默认「我」（ensureDefaultUser 产生、无 sandboxId 章），
     不调用向量、不改主表派生；只有真正的岛内 userMask 才进跨岛守卫 + 向量门禁。
     cleanupUser 保留为门禁通过后的 cleanup，不再对外导出。 */
  function cleanupUser(id, sbId) {
    var list = userMasks();
    /* 至少留一件（全删光了就连兜底都没了） */
    if (list.filter(function (u) { return u.id !== id; }).length < 1) {
      return { ok: false, message: '至少要留一件马甲' };
    }
    var gone = findUser(id);
    /* 只删「本岛这件」：同 uid 跨岛有两件时，别岛那件保留（马甲按岛隔离） */
    var left = list.filter(function (u) { return !(u.id === id && (u.sandboxId || '') === (sbId || '')); });
    /* 删掉的正是本岛大号 → 本岛剩下第一件顶上（守住「每岛至少一件大号」） */
    if (gone && gone.isDefault) {
      var sid = sbId || '';
      var heir = left.filter(function (u) { return (u.sandboxId || '') === sid; })[0];
      if (heir) heir.isDefault = true;
    }
    saveUsers(left);

    /* 补齐历史遗留：把「这个马甲建的、本岛的」派生数据一并清掉，
       否则删了马甲对话/关系/朋友圈/线下会话留在库里但找不到主人。 */
    if (id && sbId) {
      var ukey = function (r) { return !!(r && r.userId === id && r.sandboxId === sbId); };
      var mkey = function (r) { return !!(r && r.maskId === id && r.sandboxId === sbId); };
      ['chats'].forEach(function (k) {
        var all = arr(store.get(k));
        var keep = all.filter(function (r) { return !ukey(r); });
        if (keep.length !== all.length) store.set(k, keep);
      });
      var links = arr(store.get('links')).filter(function (r) {
        return !(r && (r.userId === id || r.maskId === id) && r.sandboxId === sbId);
      });
      store.set('links', links);
      var moments = arr(store.get('moments')).filter(function (r) {
        return !(r && r.maskId === id && r.sandboxId === sbId);
      });
      store.set('moments', moments);
      var off = arr(store.get('offlineSessions')).filter(function (r) {
        return !(r && r.userId === id && r.sandboxId === sbId);
      });
      store.set('offlineSessions', off);
    }
    return { ok: true };
  }

  function purgeUser(uid, sbId) {
    if (!uid) return Promise.resolve({ ok: false, message: '缺少马甲 id' });
    var u = findUser(uid);
    if (!u) return Promise.resolve({ ok: false, message: '找不到这件马甲' });

    /* ① 默认「我」保护：ensureDefaultUser 产生的跨岛共享默认用户没有 sandboxId 章
       （core.js 注释明确「故意不打章、跨岛共享」）。它是最后兜底，不能删。 */
    if (!u.sandboxId) {
      return Promise.resolve({ ok: false, why: 'default-user-protected' });
    }
    if (!sbId) {
      sbId = u.sandboxId || (global.Sleepy.core && global.Sleepy.core.scopeId ? global.Sleepy.core.scopeId() : null);
    }
    if (!sbId || sbId !== u.sandboxId) {
      /* 目标岛必须就是这件马甲所属的岛（马甲按岛隔离，不能跨岛删） */
      return Promise.resolve({ ok: false, message: '沙盒与马甲所属岛不一致' });
    }

    /* ② 跨岛引用守卫：本岛这件马甲是否仍被别岛引用 */
    var refs = null;
    listSandboxes().forEach(function (other) {
      if (!other || other.id === sbId) return;
      if (arr(other.maskIds).indexOf(uid) >= 0) {
        refs = refs || [];
        refs.push({ type: 'user', id: uid, sandboxId: other.id, name: other.name || '' });
      }
    });
    if (refs) {
      return Promise.resolve({ ok: false, why: 'still-referenced', by: refs });
    }

    /* ③ 向量能力判定 + 向量先清（forgetUser 按 userId+sandboxId），才删主表 */
    var gate = purgeVecGate();
    if (!gate.ok) return Promise.resolve({ ok: false, why: gate.why });
    var doCleanup = function () { return cleanupUser(uid, sbId); };
    if (gate.nodb) return Promise.resolve(doCleanup());

    var MV = global.Sleepy.memoryVec;
    return MV.forgetUser({ userId: uid, sandboxId: sbId }).then(function (n) {
      return doCleanup();
    }, function (err) {
      return { ok: false, why: 'memory-vector-failed', error: (err && err.message) || String(err) };
    });
  }

  /* 把某件马甲设成「我的大号」。大号在一座岛里唯一 ——
     同一座岛其他件的 isDefault 一并清掉，**别座岛的大号不动**
     （那是别岛的「我」，跨岛大号本来就各论各的）。
     用户 2026-09-21 拍板：入口在「我的马甲」列表 + 马甲编辑页。 */
  function setDefaultUser(id) {
    var list = userMasks();
    var hit = findUser(id);
    if (!hit) return { ok: false, message: '找不到这件马甲' };
    var sid = hit.sandboxId || '';
    list.forEach(function (u) {
      if ((u.sandboxId || '') !== sid) return;
      u.isDefault = (u.id === id);
    });
    saveUsers(list);
    return { ok: true, user: findUser(id) };
  }

  /* 这座岛的「我的大号」。名册里标了 isDefault 的那件；老存档一件都没标的
     退回名册第一件（不能让升级后的岛没有「我」）。本岛没马甲时 null ——
     调用方按「这座岛还没有我」处理（别拿全局兜底的「我」顶上）。 */
  function defaultUserOfSandbox(id) {
    var sb = typeof id === 'object' ? id : findSandbox(id);
    if (!sb) return null;
    var masks = masksOfSandbox(sb);
    if (!masks.length) return null;
    for (var i = 0; i < masks.length; i++) {
      if (masks[i].isDefault) return masks[i];
    }
    return masks[0];
  }

  /* 此刻正在使用的 User 马甲。切号时整个 OS 的「我」都跟着换 */
  function activeUser() {
    var id = store.get('activeUserId');
    var u = findUser(id);
    return u || ensureDefaultUser();
  }

  function activeChar() {
    var id = store.get('activeCharId');
    var c = findChar(id);
    if (c && (c.kind || 'main') !== 'main') {
      /* 存的是皮套也行 —— 但要回到它的大号，桌面氛围跟大号走 */
      return rootOf(c.id) || c;
    }
    return c || mainChars()[0] || null;
  }

  /* ------------------------ 指针卫兵（2026-09-21 第 2 批）------------------------
     群岛从浮岛降落时**有意不替人选**身份（landInto，身份留给切号器/桌面下拉），
     但全局指针 activeCharId 还停在上一个岛的人身上 —— 读侧没卫兵的话，
     桌面组件和日记就顺着错误指针显示、甚至把心情**写**进上一个岛的角色
     （清查-换岛数据 §5.1 的两处违规）。
     修法 = 日历 viewSyncSandbox（page-calendar.js）的模式：
     当前 char 必须在**本岛名册**里，否则一律按「没选人」处理。
     桌面组件、日记等所有「跟着当前身份走」的读写都从这里拿人，别直接 activeChar()。 */
  function activeCharOnIsland() {
    var sb = activeSandbox();
    var c = activeChar();
    if (!sb || !c) return null;
    if ((c.kind || 'main') !== 'main') return null;
    return arr(sb.charIds).indexOf(c.id) >= 0 ? c : null;
  }

  /* User 侧的同款卫兵（与 activeCharOnIsland 对称）。
     马甲也按岛（2026-09-21 拍板：char 与马甲全部按岛），所以尺子是同一把：
     **当前马甲必须在本岛 maskIds 里**，否则一律按「这座岛还没定我是谁」处理。
     为什么非要有它：群岛落岛有意不替人换身份，activeUser() 就还停在
     上一个岛的马甲上（findUser 是全局找，一定找得到）；挂掉它之前，
     聊天列表（viewChats 按 activeUser 过滤）、朋友圈的「我」、
     新建会话/线下会话的 userId 全都会串到上一座岛去。 */
  function activeUserOnIsland() {
    var sb = activeSandbox();
    var u = activeUser();
    if (!sb || !u) return null;
    return arr(sb.maskIds).indexOf(u.id) >= 0 ? u : null;
  }

  /* 系统级切号（时空切换器）。改的是全局的「现在是谁」——
     桌面氛围、组件数据、聊天默认身份全都读这两个值。 */
  function switchTo(charId, userId) {
    var pairs = [];
    if (charId !== undefined) pairs.push(['activeCharId', charId]);
    if (userId !== undefined) pairs.push(['activeUserId', userId]);
    return store.setMany(pairs);
  }

  /* ---------------------------- 关系（通讯录） ---------------------------- */

  function allLinks() { return arr(store.get('links')); }

  /* 某件 User 马甲通讯录里的关系（只读，按当前房过滤） */
  function linksOfUser(userId) {
    return scoped(allLinks()).filter(function (l) { return l.userId === userId; });
  }

  /* 找一对 (Char × User) 在某间房里的那条 link（返回深拷贝，只用于**读**）。
     sandboxId 不传就按当前房 —— 聊天页 / 切号器 / 掉马都是这个语境。
     **配置台必须显式传**：它渲染的是「被点开的那一段存档」，
     不一定是此刻正降落着的那一段。不传的话就会出现
     「在 A 房写的关系，去 B 房的配置台看是空的」。 */
  function findLink(charId, userId, sandboxId) {
    var list = allLinks();
    var sid = sandboxId || scopeId();
    for (var i = 0; i < list.length; i++) {
      if (list[i].charId !== charId || list[i].userId !== userId) continue;
      if (sid && list[i].sandboxId !== sid) continue;
      return list[i];
    }
    return null;
  }

  /* 在**当前房**里找那一对关系的对象，返回的是 allLinks() 快照里的**引用**
     （能直接改、改完 saveLinks(slot.list) 落盘）。

     这里有两个坑叠在一起，缺一个都会出事：
       1. 不能改 findLink() 的返回值 —— 它是深拷贝，改它等于什么都没改
          （障壁撕不掉就是这么来的，老注释里记过）；
       2. 也不能图省事拿「全量列表里的第一个匹配」—— 同一对 (Char × User)
          在两间房里**各有一条** link，全量里第一条很可能是别的存档那条，
          于是「写关系 / 撕障壁 / 改认知」会写到别的存档上去。
          串档而且不报错，是最难查的那种。

     所以：扫全量快照（保住引用），但只认目标房那一条。

     sandboxId 不传就按当前房（聊天页 / 切号器 / 掉马都是这个语境）；
     **配置台要显式传**被配置的那段存档 —— 它改的是「那一段」的认知锁，
     跟此刻降落着的是不是同一段无关。 */
  function linkSlot(charId, userId, sandboxId) {
    var list = allLinks();
    var sid = sandboxId || scopeId();
    for (var i = 0; i < list.length; i++) {
      if (list[i].charId !== charId || list[i].userId !== userId) continue;
      if (sid && list[i].sandboxId !== sid) continue;
      return { list: list, hit: list[i] };
    }
    return { list: list, hit: null };
  }

  function saveLinks(list) { return store.set('links', list); }

  /* 建立联系。认知状态由 User 在「建交」那一刻决定 ——
     这就是双向掉马矩阵的初始设定（Prompt 注入基调）。 */
  /* 建交 / 更新一对 (Char 皮套 × User 马甲) 的认知设定。
     位置参数：(charId, userId, cognition, barrier)

     注意这里为什么是「在 list 快照里就地找」而不是「拿 findLink() 的返回值改」：
     store.get() 返回的是**深拷贝**（见 store.js 的 clone），所以
     findLink() 每次都会给你一个全新的对象，和 allLinks() 快照里的那个
     没有任何引用关系。改 findLink() 的返回值、再 saveLinks(旧快照)，
     等于什么都没改 —— 障壁撕不掉就是这么来的。 */
  function addLink(charId, userId, cognition, barrier, sandboxId) {
    var slot = linkSlot(charId, userId, sandboxId);
    if (slot.hit) {
      if (cognition) slot.hit.cognition = cognition;
      if (barrier !== undefined) slot.hit.barrier = !!barrier;
      saveLinks(slot.list);
      return slot.hit;
    }
    var link = {
      id: newId('lk'),
      charId: charId,
      userId: userId,
      cognition: cognition || 'unaware',
      barrier: !!barrier,
      /* 「这两个人是什么关系」—— 自由文本，显示在关系树的连线中间。
         存在 links 上而不是新建一张表：links 本来语义就是
         「一对 (Char × User) 的关系」，认知锁和障壁也挂在它上面。 */
      relation: '',
      createdAt: Date.now()
    };
    tagScope(link, sandboxId);
    slot.list.push(link);
    saveLinks(slot.list);
    return link;
  }

  /* 写关系（「青梅竹马」「上下级」这种）。
     和 addLink/setBarrier 一样：必须改 allLinks() **快照里的那个对象**，
     不能改 findLink() 的返回值 —— 后者是深拷贝，改它等于什么都没做。 */
  function setRelation(charId, userId, text, sandboxId) {
    var slot = linkSlot(charId, userId, sandboxId);
    if (!slot.hit) {
      var made = addLink(charId, userId, 'unaware', false, sandboxId);
      if (!made) return { ok: false, message: '建关系失败' };
      slot = linkSlot(charId, userId, sandboxId);
    }
    if (!slot.hit) return { ok: false, message: '建关系失败' };
    slot.hit.relation = String(text || '').trim();
    saveLinks(slot.list);
    return { ok: true, relation: slot.hit.relation };
  }

  /* ---- 朋友圈的朋友权限（用户 2026-09-22：「和微信一样哇」）----

     看到某个人的朋友圈要同时满足三件事：
       ① 你加了她微信（在这个 app 里 = 她在这座岛上，由 scoped 保证）
       ② 她开放给你看（她那边没把你挡掉）
       ③ 你也开了看她的（你这边没屏蔽她）

     所以四个开关、两两属于一方（都存在 (charId × userId) 那条 link 上）：
       iHideChar        我设的「不看 TA 的朋友圈」
       iHideFromChar    我设的「不让 TA 看我的朋友圈」
       charHidesMe      TA 设的「不让我看 TA 的朋友圈」（剧情/引擎写，设置页不给玩家改）
       charHidesFromMe  TA 设的「不看我的朋友圈」

     判定：
       我能看 TA 的 = !(iHideChar || charHidesMe)
       TA 能看我的  = !(iHideFromChar || charHidesFromMe)

     和 setRelation / setBarrier 一样：必须改 allLinks() **快照里的那个对象**
     （findLink 返回的是深拷贝，改它等于什么都没改），也不能拿全量列表里
     第一条匹配 —— 同一对 (Char × User) 在两间房里各有一条。 */
  var FEED_PERM_KEYS = ['iHideChar', 'iHideFromChar', 'charHidesMe', 'charHidesFromMe'];

  function feedPermOf(charId, userId, sandboxId) {
    var out = {};
    FEED_PERM_KEYS.forEach(function (k) { out[k] = false; });
    if (!charId || !userId) return out;
    var l = findLink(charId, userId, sandboxId);
    FEED_PERM_KEYS.forEach(function (k) { out[k] = !!(l && l[k]); });
    return out;
  }

  function setFeedPerm(charId, userId, key, on, sandboxId) {
    if (FEED_PERM_KEYS.indexOf(key) < 0) return { ok: false, message: '未知的权限项' };
    if (!charId || !userId) return { ok: false, message: '缺少角色或身份' };
    var slot = linkSlot(charId, userId, sandboxId);
    if (!slot.hit) {
      var made = addLink(charId, userId, 'unaware', false, sandboxId);
      if (!made) return { ok: false, message: '建关系失败' };
      slot = linkSlot(charId, userId, sandboxId);
    }
    if (!slot.hit) return { ok: false, message: '建关系失败' };
    slot.hit[key] = !!on;
    saveLinks(slot.list);
    return { ok: true };
  }

  function relationOf(charId, userId, sandboxId) {
    var l = findLink(charId, userId, sandboxId);
    return l ? (l.relation || '') : '';
  }

  function removeLink(id) {
    saveLinks(allLinks().filter(function (l) { return l.id !== id; }));
    return true;
  }

  /* 这一对 (Char 皮套 × User 马甲) 的认知设定。
     没有显式建交时给一套保守默认：不知情 + 不隔离 ——
     「不知情」是拼图局的默认基调，比「已知情」安全得多。 */
  function cognitionOf(charId, userId, sandboxId) {
    var link = findLink(charId, userId, sandboxId);
    if (link) return { cognition: link.cognition || 'unaware', barrier: !!link.barrier };
    return { cognition: 'unaware', barrier: false };
  }

  /* ---------------------------- 记忆 ---------------------------- */

  /* 记忆全量存进大号（rootId）。四元组标签保证绝对可溯源：
       rootId     这些记忆属于哪个大脑
       fromCharId 哪张皮说/听到的
       toUserId   当时面对的是哪件马甲
       role       谁说的 */
  function allMemories() { return arr(store.get('memories')); }

  /* 取某个角色的全部记忆。
     传大号 id 或皮套/NPC id 都行 —— 函数名里的 "Root" 指的是
     「记忆库挂在根节点上」这件事，不是「调用者必须自己先找到根」。
     早先的写法是直接拿参数去比 m.rootId，传皮套进去就恒返回空数组；
     调用方（配置台的记忆面板、聊天页的上下文拼装）很容易就这么传了。
     这里自己归一化一次，少一个必须记住的隐性规则。 */
  function memoriesOfRoot(id) {
    if (!id) return [];
    var rootId = rootIdOf(id) || id;
    /* scoped：只取当前房里的记忆。存档 = 平行存档，同一个角色在另一间房
       的那段人生不属于这里（决策 2）。 */
    return scoped(allMemories()).filter(function (m) {
      return m.rootId === rootId;
    });
  }

  /* 落一条记忆。
     参数名兼容两套写法，因为调用方来自两个年代：
       · 新：{ charId, userId }        —— 页面里自然这么写（「谁跟谁说的」）
       · 旧：{ rootId, fromCharId, toUserId } —— 存储层的历史字段名
     早先只认了后一套，而 page-chat 的 commitMemory 传的是前一套，
     结果是每条记忆的 rootId 都存成 undefined、toUserId 存成 null ——
     memoriesOfRoot() 查不到任何东西，隔离层也认不出说话人是谁，
     掉马记忆互通在真实运行里其实是失效的。这里做一次归一化，
     两套都吃，并且 rootId 一律顺着 charId 归到根节点上。 */
  function addMemory(o) {
    o = o || {};
    var charId = o.charId || o.fromCharId || o.rootId || null;
    var root = rootOf(charId);
    var list = allMemories();
    var item = {
      id: newId('mm'),
      rootId: o.rootId || (root ? root.id : charId),
      fromCharId: charId,
      toUserId: o.userId || o.toUserId || null,
      role: o.role === 'user' ? 'user' : 'assistant',
      text: String(o.text || ''),
      at: o.at || Date.now()
    };
    if (!item.text) return null;
    tagScope(item);          /* 盖上当前房的章，见 scoped/tagScope 的注释 */
    list.push(item);
    store.set('memories', list);
    return item;
  }

  /* 认知解析层的核心。

     给一组记忆 + 当前的 (皮套, 马甲) 组合，决定哪些能进 LLM 上下文：
       1. 物理隔离层：这一对开了 barrier，直接只给「同组合」的记忆，
          纯粹的平行宇宙，连既视感都没有。
       2. 认知解析层：没隔离时给全量记忆。但「不知情」的组合会被打上
          标注，提示模型「带别的马甲标签的那条，是另一个人的事」。
          这就是防粉红大象的做法 —— 不是删记忆，是让模型正确归属。

     返回 { items, mode, note }
       mode: 'isolated' 物理隔离 / 'full' 全量+归属保护 */
  function memoryViewFor(charId, userId) {
    var rootId = rootIdOf(charId);
    var cog = cognitionOf(charId, userId);
    var all = memoriesOfRoot(rootId);

    if (cog.barrier) {
      var same = all.filter(function (m) {
        /* 同皮套 + 同马甲才算「这个宇宙里发生的事」 */
        return m.fromCharId === charId && m.toUserId === userId;
      });
      return { items: same, mode: 'isolated', note: '', cog: cog };
    }

    if (cog.cognition === 'unaware') {
      return { items: all, mode: 'full', cog: cog, note: unawareNote(userId) };
    }

    return { items: all, mode: 'full', cog: cog, note: '' };
  }

  function unawareNote(userId) {
    /* 只提**本岛**的其它马甲 —— 马甲按岛（2026-09-21 拍板），
       别岛的马甲对这段关系来说不存在，名字不该出现在提示词里。 */
    var sid = scopeId();
    var others = userMasks().filter(function (u) {
      return u.id !== userId && (!sid || u.sandboxId === sid);
    });
    if (!others.length) return '';
    /* 名字留空是合法状态（用户 2026-09-22）→ 走唯一出口，
       否则这里会拼出一串空名字，认知边界就白写了 */
    var names = others.map(function (u) { return labelOfUser(u, '另一个身份'); }).join('、');
    return [
      '【认知边界】你现在只认识当前对话里的这个人。',
      '记忆库里可能还有带「' + names + '」标签的片段（以 [U→C] 形式标出）。',
      '那些是**另一个人**的事，不是眼前这个人告诉你的。',
      '你可以因此对眼前这个人产生说不清的熟悉感（既视感），',
      '但**绝不能**直接说出、复述、或暗示你在别处认识对方 —— 你没有那段记忆的出处。'
    ].join('\n');
  }

  function dropMemories(pred) {
    store.set('memories', allMemories().filter(function (m) { return !pred(m); }));
  }

  /* ---------------------------- 掉马 ---------------------------- */

  /* 记忆障壁的开关。开着 = 大号小号记忆绝对隔离。
     见 addLink 的注释：必须改 allLinks() 快照里的那个对象，
     不能改 findLink() 返回的深拷贝。 */
  function setBarrier(charId, userId, on, sandboxId) {
    var slot = linkSlot(charId, userId, sandboxId);
    if (!slot.hit) {
      addLink(charId, userId, 'unaware', !!on, sandboxId);
      return true;
    }
    slot.hit.barrier = !!on;
    saveLinks(slot.list);
    return true;
  }

  function setCognition(charId, userId, cog, sandboxId) {
    var slot = linkSlot(charId, userId, sandboxId);
    if (!slot.hit) {
      addLink(charId, userId, cog, false, sandboxId);
      return true;
    }
    slot.hit.cognition = cog;
    saveLinks(slot.list);
    return true;
  }

  function dropEvents() { return arr(store.get('dropEvents')); }

  /* 掉马瞬间。
     底层动作：撤销记忆障壁 + 把认知状态推到「已知情」+
     强行注入一条系统事件（连带头像/昵称的反差一起暴露）。
     大模型下一轮就会同时读到两份反差极大的记忆 —— 修罗场是它自己引爆的，
     不是我们替它写好的。 */
  function unmask(charId, userId, text) {
    var root = rootOf(charId);
    var user = findUser(userId);
    if (!root) return null;

    var cog = cognitionOf(charId, userId);

    /* 见 linkSlot 的注释：必须改「当前房那条」的引用。
       拿全量里第一个匹配会写到别的存档上。 */
    var slot = linkSlot(charId, userId);
    var hit;
    if (!slot.hit) {
      hit = addLink(charId, userId, 'aware', false);
    } else {
      slot.hit.barrier = false;
      slot.hit.cognition = 'aware';
      saveLinks(slot.list);
      hit = slot.hit;
    }

    var lines = [];
    if (cog.barrier) {
      lines.push('记忆障壁已撤销：' + root.name + ' 的大小号记忆现在互通。');
    }
    lines.push('身份反差暴露：' + describeIdentity(charId, userId) + '。');
    if (text) lines.push(String(text));

    var ev = {
      id: newId('dp'),
      rootId: root.id,
      charId: charId,
      userId: userId,
      at: Date.now(),
      text: lines.join('\n'),
      seen: false
    };
    tagScope(ev);
    var evs = dropEvents();
    evs.push(ev);
    store.set('dropEvents', evs);

    /* 返回事件本身，同时把更新后的 link 挂在上面。
       调用方（配置台的「⚠️ 记忆互通」按钮、聊天页的长按菜单）通常
       既要拿事件文案去提示，也要立刻读回新的认知状态去刷新界面 ——
       只回事件的话它们得再查一次，多一次读盘也容易拿到旧值。 */
    ev.link = hit;
    return ev;
  }

  /* 「你眼前这个人是 A，但他在另一个身份下是 B」——
     掉马时把反差摊开，这行字会直接进系统提示词。 */
  function describeIdentity(charId, userId) {
    var c = findChar(charId);
    if (!c) return '';
    var root = rootOf(charId);
    var u = findUser(userId);
    var parts = [];
    parts.push('你（' + (root ? root.name : '角色') + '）在「' + labelOfUser(u, '对方') + '」面前的这张脸是「' + c.name + '」');
    var subs = subChars(root ? root.id : '').filter(function (s) { return s.id !== c.id; });
    if (subs.length) {
      parts.push('但你还有另一张脸：' + subs.map(function (s) {
        return s.name + (s.boundUserId && findUser(s.boundUserId) ? '（对应 ' + findUser(s.boundUserId).name + '）' : '');
      }).join('、'));
    }
    return parts.join('；');
  }

  /* 没看过的掉马事件。这些要作为系统事件插进上下文最前面。
     只取当前房的 —— 别的房里发生过的掉马跟眼前这段关系无关。 */
  function pendingDropEvents(rootId) {
    return scoped(dropEvents()).filter(function (e) {
      return !e.seen && (!rootId || e.rootId === rootId);
    });
  }

  function markDropEventsSeen(ids) {
    var list = dropEvents();
    list.forEach(function (e) {
      if (ids.indexOf(e.id) >= 0) e.seen = true;
    });
    store.set('dropEvents', list);
  }

  /* ----------------------- 群聊（跨宇宙投影） ----------------------- */

  /* 群聊不是新造的对象，是「勾了几个大号」这个动作的结果。
     它作为分身同时投影到各角色的聊天列表里 —— 在不同角色的桌面看，
     视觉氛围完全不同（因为皮肤跟着当前切号走）。 */
  function groupKeyOf(ids) {
    return 'grp:' + ids.slice().sort().join('+');
  }

  function parseGroupKey(key) {
    if (!key || key.indexOf('grp:') !== 0) return [];
    return key.slice(4).split('+').filter(Boolean);
  }

  function makeGroupName(ids) {
    var names = ids.map(function (id) {
      var c = findChar(id);
      return c ? c.name : '?';
    });
    if (!names.length) return '群聊';
    if (names.length <= 3) return names.join('、');
    return names.slice(0, 2).join('、') + ' 等 ' + names.length + ' 人';
  }

  /* ---------------------------- 记忆四元组标签 ---------------------------- */

  /* 记忆进上下文时统一带这个标签：[U小号 → C大号]
     「保证记忆绝对可溯源」—— 掉马时模型才能正确地把两段人生对上号。 */
  function tagOf(m) {
    var c = findChar(m.fromCharId);
    var u = findUser(m.toUserId);
    var cs = c ? c.name : '?';
    var us = labelOfUser(u, '对方');
    return '[' + us + ' → ' + cs + ']';
  }

  /* ---------------------------- 名称工具 ---------------------------- */

  function initialOf(name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    return s.charAt(0).toUpperCase();
  }

  /* ------------------- 「这个账号叫什么」的唯一出口 -------------------

     用户 2026-09-22：「名字可以不填，不填的话 char 就只知道微信名（大号小号都是）」。
     于是 user 侧多了一条**留空语义**，跟 char 那边（名字必填）不一样：

       name       = 人设里的真名 / 别名（可以空）
       wechatName = 对外那张名片上的名字（会话列表显示的就是它）

     名字空着就整个退到微信名，两件都空才回落 fallback。
     ⚠️ 只影响**显示与注入**，绝不回写 name —— 存档里该空还是空，
     模型也就只知道微信名（这正是用户要的效果）。 */
  function labelOfUser(u, fallback) {
    if (!u) return fallback || '我';
    var n = String(u.name || '').trim();
    if (n) return n;
    var w = String(u.wechatName || '').trim();
    if (w) return w;
    return fallback || '我';
  }

  /* 头像框里的首字：跟 labelOfUser 同一口径（别再用 initialOf(u.name)，
     那样名字留空会显示成「?」）。 */
  function initialOfUser(u) {
    return initialOf(labelOfUser(u, '我'));
  }

  function summaryOf(it) {
    var lines = String(it && it.content || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      return t.length > 42 ? t.slice(0, 42) + '…' : t;
    }
    return '还没写设定';
  }

  /* ---------------------------- 头像取图 ---------------------------- */

  /* 头像可存两处（2026-09-21 起补齐本地图这一环）：
     avatarMedia = 图库（IndexedDB）里的 mediaId —— 本地选图走这里；
     avatar      = 图片网址（也兜老存档里的 data: base64）。
     显示时本地图优先。别在渲染点直接读 rec.avatar 当 src —— 用下面三个。 */
  function avatarSrc(rec) {
    if (rec && rec.avatarMedia && Sleepy.media && Sleepy.media.url) {
      return Sleepy.media.url(rec.avatarMedia);
    }
    return Promise.resolve((rec && rec.avatar) || '');
  }

  /* 背景图式头像（.addr-av / .chat-item-ava / 朋友圈这一类）。
     has-img 类由这里加 —— 以前是渲染点同步判 rec.avatar 加的，
     本地图是异步取的，得等 url 回来再加。 */
  function setAvatarBg(el, rec) {
    return avatarSrc(rec).then(function (u) {
      if (!u || !el) return;
      el.classList.add('has-img');
      el.style.backgroundImage = 'url("' + String(u).replace(/"/g, '%22') + '")';
    });
  }

  /* <img> 式头像（tile / 桌面 / 查手机这一类） */
  function setAvatarImg(img, rec) {
    return avatarSrc(rec).then(function (u) {
      if (u && img) img.src = u;
    });
  }

  var KIND_LABEL = { main: '大号', sub: '小号', npc: 'NPC' };

  function kindLabel(k) { return KIND_LABEL[k] || '大号'; }

  /* ------------------- 外链与感知配置（唯一存储出口） -------------------

     挂两件事，共用一个 store 键：
     · 真实世界感知：rwOn（开关）/ weatherCity / owmKey（OpenWeatherMap key）；
     · （历史）搜索源表已撤 —— 实测免鉴权、开 CORS 的通用搜索源为零
       （公共中转 2026-10-06 全线不可用），char 的搜索能力走 MCP 工具
       （多个搜索服务/工具天然多选、逐个开关），配置在 MCP 连接页。 */
  var WEBLINK_KEY = 'weblinkCfg';

  function weblinkCfg() {
    var c = null;
    try { c = store.get(WEBLINK_KEY); } catch (e) { c = null; }
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  }

  function setWeblinkCfg(patch) {
    var c = weblinkCfg();
    Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; });
    store.set(WEBLINK_KEY, c);
    return c;
  }

  /* ------------------------- 真实世界感知（天气） -------------------------

     char 感知现实天气：OpenWeatherMap 免费层（CORS 全开，2026-10-06 实测
     Access-Control-Allow-Origin: *），key 免费注册、存 weblinkCfg.owmKey。
     30 分钟进程内缓存 + store 快照（rwWeatherLast）兜离线。
     取数是**异步**的而装配是同步的 ⇒ 走 recall 槽同款模式：page-chat 在
     装配前 poke()（带 4s 超时，绝不卡聊天），缓存热了 rwCompile() 同步读。
     开关/城市/key 挂 weblinkCfg（rwOn / weatherCity / owmKey），settings 改。 */
  var RW_WEATHER_TTL = 30 * 60 * 1000;
  var RW_WEATHER_KEY = 'rwWeatherLast';

  /* 进程内缓存（只在内存，不随消息/存档走） */
  var rwWeather = { data: null, at: 0 };

  function rwOn() { return weblinkCfg().rwOn === true; }

  function rwFetchWeather(city, key) {
    return fetch('https://api.openweathermap.org/data/2.5/weather?q=' +
        encodeURIComponent(city) + '&appid=' + encodeURIComponent(key) +
        '&units=metric&lang=zh_cn')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || Number(j.cod) !== 200 || !j.main) throw new Error('天气接口失败');
        return {
          city: String(j.name || city),
          desc: (j.weather && j.weather[0] && j.weather[0].description) || '',
          temp: Math.round(j.main.temp),
          feels: Math.round(j.main.feels_like),
          hum: Math.round(j.main.humidity)
        };
      });
  }

  /* 后台预取入口：带 4s 超时兜底 —— 宁可这轮块是空的，也不拖住发消息。 */
  function rwPoke() {
    if (!rwOn()) return Promise.resolve();
    var now = Date.now();
    if (rwWeather.data && now - rwWeather.at <= RW_WEATHER_TTL) return Promise.resolve();
    var c = weblinkCfg();
    var city = String(c.weatherCity || '').trim();
    var key = String(c.owmKey || '').trim();
    if (!city || !key) return Promise.resolve();
    return Promise.race([
      rwFetchWeather(city, key).then(function (w) {
        rwWeather.data = w; rwWeather.at = now;
        store.set(RW_WEATHER_KEY, w);
      })['catch'](function () { /* 拉不到用旧快照，不报错 */ }),
      new Promise(function (res) { setTimeout(res, 4000); })
    ]);
  }

  /* 装配侧同步读：先内存缓存，空了退 store 里的最近成功快照；
     开关没开 / 没有数据 ⇒ 空串，槽位整块不注入。 */
  function rwCompile() {
    if (!rwOn()) return '';
    var w = rwWeather.data;
    try { w = w || store.get(RW_WEATHER_KEY) || null; } catch (e) { w = w || null; }
    if (!w) return '';
    var city = String(weblinkCfg().weatherCity || '').trim();
    return ['【真实世界感知】下面是 user 所在现实世界的真实情况，以这里为准，不要自己编，也不要当台词念出来；用它自然地关心对方就好（下雨提一句带伞之类），对方在认真说正事时别硬插。',
      '现实天气（' + (w.city || city) + '）：' + w.desc + '，' +
      w.temp + '°C（体感 ' + w.feels + '°C），湿度 ' + w.hum + '%'].join('\n');
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.core = {
    newId: newId,

    /* 沙盒（顶层容器）—— 见文件里那段注释 */
    KIND_ISLE: KIND_ISLE,
    KIND_ARCHI: KIND_ARCHI,
    listSandboxes: listSandboxes,
    findSandbox: findSandbox,
    saveSandboxes: saveSandboxes,
    sandboxesOfKind: sandboxesOfKind,
    createSandbox: createSandbox,
    /* 项目4：拆岛改异步 purge 门禁（跨岛守卫 + 向量先清 + 失败可见可重试）。
       removeSandbox 已移除（不再对外导出）。 */
    purgeSandbox: purgeSandbox,
    renameSandbox: renameSandbox,
    setSandboxCover: setSandboxCover,
    setSandboxChars: setSandboxChars,
    setSandboxMasks: setSandboxMasks,
    validateSandboxChars: validateSandboxChars,
    activeSandbox: activeSandbox,
    scopeId: scopeId,
    setActiveSandbox: setActiveSandbox,
    charsOfSandbox: charsOfSandbox,
    masksOfSandbox: masksOfSandbox,
    needsCharPick: needsCharPick,
    activeCharOnIsland: activeCharOnIsland,
    activeUserOnIsland: activeUserOnIsland,
    defaultUserOfSandbox: defaultUserOfSandbox,
    setDefaultUser: setDefaultUser,

    /* 作用域过滤：业务数据的读写统一走这两个 */
    scoped: scoped,
    tagScope: tagScope,

    allChars: allChars,
    findChar: findChar,
    mainChars: mainChars,
    subChars: subChars,
    npcChars: npcChars,
    userNpcs: userNpcs,
    npcsOfRoom: npcsOfRoom,
    universeOf: universeOf,
    switchableOf: switchableOf,
    rootOf: rootOf,
    rootIdOf: rootIdOf,
    /* 项目4：doomedCharIds 暴露出来供冒烟直接断言「主表 doomed 集合」，
       验证它与向量命中一一对应。 */
    doomedCharIds: doomedCharIds,
    saveChars: saveChars,
    upsertChar: upsertChar,
    /* 项目4：删大号/NPC 走 purgeChar、删皮套走 purgeFace（异步门禁）。
       removeChar 已移除（不再对外导出）。 */
    purgeChar: purgeChar,
    purgeFace: purgeFace,
    kindLabel: kindLabel,

    /* 外链与感知配置 —— 读写唯一出口（realworld 的开关/城市/热榜开关都存这里） */
    weblink: {
      cfg: weblinkCfg,
      set: setWeblinkCfg
    },

    /* 真实世界感知（现实天气，OpenWeatherMap 免费层）——
       poke() 装配前预取（page-chat 调），compile() 装配同步读（prompt-engine 调） */
    realworld: {
      poke: rwPoke,
      compile: rwCompile
    },

    userMasks: userMasks,
    findUser: findUser,
    saveUsers: saveUsers,
    ensureDefaultUser: ensureDefaultUser,
    upsertUser: upsertUser,
    /* 项目4：删马甲走 purgeUser（默认「我」保护 + 跨岛守卫 + 向量门禁）。
       removeUser 已移除（不再对外导出）。 */
    purgeUser: purgeUser,
    /* ⚠️ 测试专用同步清理（smoke 存量清理用）。**非生产删除 API**，生产一律走
       异步 purge 门禁。名字带 `_` 前缀表明内部/测试用途，产品代码不得调用。 */
    _purgeSync: {
      sandbox: _purgeSyncSandbox,
      char: _purgeSyncChar,
      face: _purgeSyncFace,
      user: _purgeSyncUser
    },
    activeUser: activeUser,
    activeChar: activeChar,
    switchTo: switchTo,

    allLinks: allLinks,
    linksOfUser: linksOfUser,
    findLink: findLink,
    addLink: addLink,
    feedPermOf: feedPermOf,
    setFeedPerm: setFeedPerm,
    removeLink: removeLink,
    cognitionOf: cognitionOf,
    setBarrier: setBarrier,
    setCognition: setCognition,
    /* 关系文字：显示在关系树的连线中间 */
    setRelation: setRelation,
    relationOf: relationOf,

    allMemories: allMemories,
    memoriesOfRoot: memoriesOfRoot,
    addMemory: addMemory,
    dropMemories: dropMemories,
    memoryViewFor: memoryViewFor,
    tagOf: tagOf,

    unmask: unmask,
    dropEvents: dropEvents,
    pendingDropEvents: pendingDropEvents,
    markDropEventsSeen: markDropEventsSeen,
    describeIdentity: describeIdentity,

    groupKeyOf: groupKeyOf,
    parseGroupKey: parseGroupKey,
    makeGroupName: makeGroupName,

    initialOf: initialOf,
    /* user 侧留空语义的两个出口（见 labelOfUser 的注释）——显示与注入只认这两个 */
    labelOfUser: labelOfUser,
    initialOfUser: initialOfUser,
    summaryOf: summaryOf,

    avatarSrc: avatarSrc,
    setAvatarBg: setAvatarBg,
    setAvatarImg: setAvatarImg
  };

})(window);
