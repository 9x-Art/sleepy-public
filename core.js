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
     kind='npc'  附属：挂在大号名下，只在该大号的宇宙/群聊里出场

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
      theme: null,       /* 每岛一套配色 + 字体，P3 填 */
      deskVersion: null, /* 每岛一份完整户型，P3 填 */
      pages: null,
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

  /* 删一间房，连带清掉**明确属于它**的数据。
     纪律：只删 sandboxId === id 的记录。
     没有 sandboxId 的那些是 S3 迁移之前的老全局数据，不属于任何房，
     一律不碰 —— 否则第一次删房就会顺手把用户的老存档抹掉。 */
  function removeSandbox(id) {
    if (!id) return { ok: false, message: '缺少沙盒 id' };
    var hit = findSandbox(id);
    if (!hit) return { ok: false, message: '找不到这间房' };

    saveSandboxes(listSandboxes().filter(function (s) { return s.id !== id; }));

    /* 这一串是「按房切开」的数据键。**新增带 sandboxId 的键要记得加进来** ——
       漏了的话删房时它不会跟着清，会在 localStorage 里越积越多，
       而且下次有人建同 id 的房（id 是随机的，概率极低）会看到幽灵数据。 */
    var removed = {};
    var scoped = ['chats', 'memories', 'links', 'photos', 'diaries',
                  'todos', 'favorites', 'userMasks', 'characters', 'moments',
                  'wallet', 'stickers', 'offlineSessions'];
    scoped.forEach(function (key) {
      var all = arr(store.get(key));
      if (!all.length) return;
      var keep = all.filter(function (r) { return !(r && r.sandboxId === id); });
      var gone = all.length - keep.length;
      if (!gone) return;
      store.set(key, keep);
      removed[key] = gone;
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

  /* 挂在这个大号名下的 NPC */
  function npcChars(mainId) {
    return allChars().filter(function (c) {
      return c.kind === 'npc' && c.parentId === mainId &&
        (c.parentType || 'char') === 'char';
    });
  }

  /* 挂在「我」（User 马甲）名下的 NPC。
     关系树里「我」下面也能加人 —— 邻居、同事、楼下咖啡店的人，
     他们跟角色无关，是「我这边」的人。 */
  function userNpcs(userId) {
    if (!userId) return [];
    return allChars().filter(function (c) {
      return c.kind === 'npc' && c.parentId === userId &&
        c.parentType === 'user';
    });
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
        content: data.content || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      for (var j in data) {
        if (Object.prototype.hasOwnProperty.call(data, j) && data[j] !== undefined) {
          item[j] = data[j];
        }
      }
      /* 皮套和 NPC 是**按房建**的（决策 3）：调用方没显式给 sandboxId 时，
         盖上当前这间房的章。漏了的话它不属于任何房 ——
         在房内的树、通讯录、切号器里全看不见，等于白建。
         大号本体（kind='main'）例外：它是全局共用的，不能带房标签。 */
      if (item.kind !== 'main' && !item.sandboxId) tagScope(item);
      list.push(item);
      hit = item;
    }
    saveChars(list);
    return hit;
  }

  /* 删除一个大号时，挂在它名下的皮套和 NPC 不能变成孤儿
     （孤儿在「谁挂在谁名下」的视图里会直接消失）。一起删掉。 */
  function removeChar(id) {
    var doomed = {};
    doomed[id] = true;
    allChars().forEach(function (c) {
      if (c.parentId === id) doomed[c.id] = true;
    });
    var next = allChars().filter(function (c) { return !doomed[c.id]; });
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
    return true;
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
        name: data.name || '我',
        avatar: has(data, 'avatar') ? data.avatar : '',
        persona: has(data, 'persona') ? data.persona : '',
        note: has(data, 'note') ? data.note : '',
        isDefault: !!data.isDefault,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      list.push(hit);
    }
    saveUsers(list);
    return hit;
  }

  function removeUser(id) {
    var list = userMasks();
    if (list.length <= 1) return { ok: false, message: '至少要留一件马甲' };
    saveUsers(list.filter(function (u) { return u.id !== id; }));
    return { ok: true };
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
    var others = userMasks().filter(function (u) { return u.id !== userId; });
    if (!others.length) return '';
    var names = others.map(function (u) { return u.name; }).join('、');
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
    parts.push('你（' + (root ? root.name : '角色') + '）在「' + (u ? u.name : '对方') + '」面前的这张脸是「' + c.name + '」');
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
    var us = u ? u.name : '对方';
    return '[' + us + ' → ' + cs + ']';
  }

  /* ---------------------------- 名称工具 ---------------------------- */

  function initialOf(name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    return s.charAt(0).toUpperCase();
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

  var KIND_LABEL = { main: '大号', sub: '皮套', npc: 'NPC' };

  function kindLabel(k) { return KIND_LABEL[k] || '大号'; }

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
    removeSandbox: removeSandbox,
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

    /* 作用域过滤：业务数据的读写统一走这两个 */
    scoped: scoped,
    tagScope: tagScope,

    allChars: allChars,
    findChar: findChar,
    mainChars: mainChars,
    subChars: subChars,
    npcChars: npcChars,
    userNpcs: userNpcs,
    universeOf: universeOf,
    switchableOf: switchableOf,
    rootOf: rootOf,
    rootIdOf: rootIdOf,
    saveChars: saveChars,
    upsertChar: upsertChar,
    removeChar: removeChar,
    kindLabel: kindLabel,

    userMasks: userMasks,
    findUser: findUser,
    saveUsers: saveUsers,
    ensureDefaultUser: ensureDefaultUser,
    upsertUser: upsertUser,
    removeUser: removeUser,
    activeUser: activeUser,
    activeChar: activeChar,
    switchTo: switchTo,

    allLinks: allLinks,
    linksOfUser: linksOfUser,
    findLink: findLink,
    addLink: addLink,
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
    summaryOf: summaryOf
  };

})(window);
