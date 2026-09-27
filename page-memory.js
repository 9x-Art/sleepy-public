/* ============================================================
   page-memory.js — 留痕 App（记忆可视化 · 施工指令卡 v1）

   三层页面：
     memory          岛屿档案页（首页）：主角色 + NPC 列表
     memory-char     内页：某角色对 user 的全部记忆
     memory-detail   记忆详情：单条记忆 / 推测条目

   数据层 Sleepy.memoryStore（本文件底部导出）：
     数据存 store —— 'memoryIsland'（岛屿与每角色的记忆系统开关）
                   + 'charMem:<charId>'（CharMemoryFile）
     对话系统只暴露两个函数（指令卡第八节）：
       getMemoryInjection(charId, opts)  装配时取记忆摘要
       writeMemoryItems(charId, items)   总结引擎写入
     铁律：来源三字段不可改；只有 user_manual 可物理删除；
           锚点注入时不受配额限制、约定优先占座、经历类有保底（见
           getMemoryInjection 上面那段）；关了开关注入为空但数据保留。

   UI：Demo v4（暖米 + 冷蓝绿）逐值移植，类名 lh- 前缀。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var h = ui.h;
  function core() { return Sleepy.core; }

  /* ---------------------------- 标签映射 ---------------------------- */

  var KIND_LABELS = {
    preference_like: '喜欢', preference_dislike: '不喜欢', boundary: '边界',
    user_fact: '事实', shared_event: '共同经历', promise: '约定',
    relationship_fact: '关系', correction: '纠正', habit: '习惯',
    character_inference: '推测', custom: '自定义'
  };
  var KIND_COLOR = {
    preference_like: 'green', preference_dislike: 'red', boundary: 'red',
    user_fact: 'blue', shared_event: 'teal', promise: 'teal',
    relationship_fact: 'mauve', correction: 'gold', habit: 'warm',
    character_inference: 'mauve', custom: 'dim'
  };
  var SOURCE_LABELS = {
    all: '全部', chat: '聊天', offline: '线下', diary: '日记',
    user_manual: '用户添加', ai_summary: '系统整理', other_app: '其他 App'
  };
  var EVID_LABELS = {
    user_explicit: '你亲口说的', confirmed_event: '明确发生的事件',
    character_feeling: '角色自身感受', character_inference: '角色对用户的推测',
    behavior_signal: '行为信号', uncertain: '无法确认'
  };
  var STATUS_LABELS = {
    active: '当前有效', pending: '待用户确认', invalid: '已标记错误',
    superseded: '已被替代', archived: '已归档'
  };
  var EVID_BADGE = {
    user_explicit: { text: '你亲口说的', cls: 'confirm' },
    character_inference: { text: '我的推测', cls: 'infer' },
    behavior_signal: { text: '我的推测', cls: 'infer' },
    confirmed_event: { text: '近期形成', cls: 'recent' },
    character_feeling: { text: '我的推测', cls: 'infer' },
    uncertain: { text: '无法确认', cls: 'infer' }
  };
  var LEVEL_LABELS = { full: '完整记忆', simple: '简化记录', off: '未开启' };

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowIso() { return new Date().toISOString(); }
  function newId(p) { return (p || 'mem') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* 「今天 / 昨天 / N 天前 / 1 周前」 */
  function relTime(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = new Date();
    var mid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var day = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - mid) / 86400000);
    if (day === 0) return '今天';
    if (day === 1) return '昨天';
    if (day < 0) return pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日';
    if (day < 7) return day + ' 天前';
    return '1 周前';
  }

  /* ---------------------------- 数据层 ---------------------------- */

  /* 项目 5（2026-09-23 定稿）：长期记忆统一归 **rootId** —— 同一个大脑
     只有一份记忆，皮套只是「哪张脸产生的」（条目级记 fromCharId）。
     本地兜底一份 rootIdOf：core 还没挂上时按原样返回，不让记忆层
     因为脚本加载顺序挂掉（真挂不上时行为与归一前一致）。 */
  function rootIdOf(charId) {
    var C = Sleepy.core;
    return (C && C.rootIdOf) ? (C.rootIdOf(charId) || charId) : (charId || null);
  }

  function islandRaw() {
    return store.get('memoryIsland') || { name: '星屿', type: 'solo', byChar: {} };
  }
  /* 判 root 是不是 NPC（项目 2 修复）：**不再猜 id 前缀**。
     真实 NPC 的 id 是 core.newId('ch') 生成的 `chxxx`（不是 `npc` 前缀），
     旧判据 `indexOf('npc')` 对它们永远判成主角 → 默认记忆「开」，与方案「NPC 默认关」矛盾。
     改为查名册事实 `findChar(root).kind === 'npc'`（全站 NPC 唯一口径 = kind，npcsOfRoom 同源）。
     判据把**四类 root 彻底分离**，未知状态绝不直接等于 NPC：
       ① 带池前缀的共享 key（`island:` / `user:` / `group:`）→ **永远 false**
         —— 共享池不属于任何角色大脑，不受「角色/NPC 记忆开关」影响。**先短路**，
           谁都不能因 NPC 判据把它误关（memory-vec 的 charMemOff 对带前缀 key 必须返回 false）。
       ② 名册查得到且 kind==='npc'（真实 NPC root，chxxx）→ **true**
       ③ 名册查得到且 kind 非 npc（主角 / 马甲）→ **false**
       ④ core 未就绪（findChar 缺失）或名册查不到 root（假 root / 未知 id）→ **false 而非 true**
         —— 未知状态不默认关：只有名册里**确凿**的 kind==='npc' 才算 NPC。
           查不到就默认**开**（不误关，与 memory-vec 老行为「环境无记忆模块默认开」一致）。 */
  function isNpcRoot(root) {
    var C = Sleepy.core;
    if (/^(island:|user:|group:)/.test(root || '')) return false;  /* ① 共享池永远非 NPC */
    if (!C || !C.findChar) return false;                            /* ④ 未知不默认关 */
    var c = C.findChar(root);
    return !!(c && c.kind === 'npc');                              /* ②③ 名册为准 */
  }
  /* 开关归 root（项目 5 S2）：皮套里关的开关就是大号关的 ——
     `memoryIsland.byChar` 只有一个键。 */
  function charConfig(charId) {
    var root = rootIdOf(charId);
    var raw = islandRaw();
    var c = raw.byChar && raw.byChar[root];
    var isNpc = isNpcRoot(root);
    return {
      charId: root,
      enabled: c ? c.enabled !== false : !isNpc,   /* 主角默认开，NPC 默认关 */
      level: (c && c.level) || (isNpc ? 'off' : 'full'),
      updatedAt: (c && c.updatedAt) || nowIso()
    };
  }
  function setCharConfig(charId, patch) {
    var root = rootIdOf(charId);
    var raw = islandRaw();
    raw.byChar = raw.byChar || {};
    raw.byChar[root] = raw.byChar[root] || {};
    /* 项目 2：false→true 边沿。before 用 charConfig（含 NPC 默认关语义），
       仅当 patch 含 enabled 且 before===false 且 after===true 才定向作废该 root 私有池游标
       （重开记忆 → rootEpoch +1 → readCursor 失配 → 私有池从头定向重扫）。
       true→true / true→false 不调用（不清游标、不删块）。 */
    var before = charConfig(charId).enabled;
    var has = patch && Object.prototype.hasOwnProperty.call(patch, 'enabled');
    var after = has ? (patch.enabled !== false) : before;
    Object.keys(patch).forEach(function (k) { raw.byChar[root][k] = patch[k]; });
    raw.byChar[root].updatedAt = nowIso();
    store.set('memoryIsland', raw);
    if (has && before === false && after === true) {
      var mv = Sleepy.memoryVec;
      if (mv && typeof mv.invalidateCursorsFor === 'function') {
        mv.invalidateCursorsFor(root);
      }
    }
  }

  /* 键归 root（项目 5 S1）：同一个大脑一个键，皮套传进来也落到 root 门牌 */
  function charMemKey(charId) { return 'charMem:' + rootIdOf(charId); }

  /* 向量索引联动（见 memory-vec 的素材源「记忆档案」）。
     **变更时显式喊一声**（施工卡 §5-3），后台跑、失败不挡档案操作。
     · 新增 → sweepMem（补新条目）
     · 改 / 确认 / 作废 / 删 / 加锚 → refreshMem（那条重切，或状态变了就清块） */
  function vecCall(name, args) {
    var mv = Sleepy.memoryVec;
    if (!mv || typeof mv[name] !== 'function') return;
    try { mv[name].apply(mv, args || []); } catch (e) { /* 静默 */ }
  }
  function loadCharMemory(charId) {
    var root = rootIdOf(charId);
    var file = store.get(charMemKey(root));
    if (file) {
      /* 归一前写的老文件没有 rootId —— 补上，save 侧要靠它认门牌 */
      if (!file.rootId) file.rootId = root;
      return file;
    }
    return {
      version: '1', charId: root, rootId: root, updatedAt: nowIso(),
      understandings: [], memories: []
    };
  }
  function saveCharMemory(file) {
    /* 迁移写入锁（S7）：总结 / 手工写入在迁移期间一律短路，不写库 */
    if (isMigrating()) return { ok: false, why: 'migrating' };
    /* 归 root（S1）：写入方可能拿皮套调进来，门牌一律落 rootId；
       条目记「哪张脸产生的」（§2.6）：缺了按写入时的脸补，推不出填 null。 */
    var fromFace = file.charId || null;
    var root = file.rootId || rootIdOf(fromFace) || fromFace;
    ['understandings', 'memories'].forEach(function (k) {
      (file[k] || []).forEach(function (it) {
        if (it && it.fromCharId === undefined) it.fromCharId = fromFace;
      });
    });
    file.rootId = root;
    file.charId = root;
    file.updatedAt = nowIso();
    store.set(charMemKey(root), file);
    syncIsland(root);
  }

  /* 指令卡第九节 4：每次写入后同步 island 的 pendingCount / latest* */
  function syncIsland(charId) { /* island 是派生的（见 loadIsland），无需额外字段 */ }

  function loadIsland() {
    var coreO = core();
    var raw = islandRaw();
    var chars = [];
    function pushChar(c, isNpc, rel) {
      var file = loadCharMemory(c.id);
      var activeU = file.understandings.filter(function (u) { return u.status === 'active'; });
      var latest = file.memories.slice().sort(function (a, b) {
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
      })[0];
      var excerpt = activeU.length
        ? (activeU.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })[0].content || '')
        : '';
      if (excerpt.length > 60) excerpt = excerpt.slice(0, 60) + '…';
      chars.push({
        id: c.id,
        name: c.name || '未命名',
        isNpc: isNpc,
        tags: isNpc ? ['NPC', rel || ''] : ['主要角色'],
        memoryConfig: charConfig(c.id),
        latestMemoryUpdatedAt: latest ? latest.updatedAt : '',
        latestExcerpt: excerpt,
        pendingCount: file.memories.filter(function (m) { return m.status === 'pending'; }).length
      });
    }
    /* 按岛过滤（用户 09-19 定稿：留痕这类 App 显示「打开的那座岛」的数据，
       全局的只有浮岛/设置/外观/世界书/预设）。
       范围 = 当前岛的主要角色 + 岛内全体 NPC（唯一口径 core.npcsOfRoom：
       sandbox 新语义 + 挂 char/user 名下的老数据兜底）。
       没降落在任何岛上时回落老行为（全部主要角色）。 */
    var sb = coreO.activeSandbox();
    var islandName = '';
    try { if (Sleepy.island && sb) islandName = Sleepy.island.roomTitle(sb); } catch (e) { /* 忽略 */ }
    function npcTag(n) { return (n.content || '').split('\n')[0].slice(0, 16) || 'NPC'; }
    if (sb) {
      (coreO.charsOfSandbox(sb) || []).forEach(function (m) {
        pushChar(m, false, '');
      });
      (coreO.npcsOfRoom ? coreO.npcsOfRoom(sb) : []).forEach(function (n) {
        pushChar(n, true, npcTag(n));
      });
    } else {
      (coreO.mainChars() || []).forEach(function (m) {
        pushChar(m, false, '');
        (coreO.npcChars(m.id) || []).forEach(function (n) {
          pushChar(n, true, npcTag(n));
        });
      });
    }
    return {
      id: 'island_main',
      name: islandName || raw.name || '星屿',
      type: raw.type || 'solo',
      chars: chars
    };
  }

  /* ---- 记忆条目操作（指令卡第四节） ---- */

  function findMemory(file, id) {
    for (var i = 0; i < file.memories.length; i++) {
      if (file.memories[i].id === id) return file.memories[i];
    }
    return null;
  }

  function updateMemoryItem(charId, memoryId, patch) {
    var file = loadCharMemory(charId);
    var m = findMemory(file, memoryId);
    if (!m) return;
    /* 来源三字段不可篡改 —— patch 里就算带了也忽略 */
    ['content', 'status', 'isAnchor'].forEach(function (k) {
      if (patch && patch[k] !== undefined) m[k] = patch[k];
    });
    if (patch && patch.isUserEdited) m.isUserEdited = true;
    m.updatedAt = nowIso();
    saveCharMemory(file);
    /* 改一条 → 定向重建那一条（内容 / 状态 / 锚点任一变了都算） */
    vecCall('refreshMem', [charId, memoryId]);
  }

  function addMemoryItem(charId, item) {
    var file = loadCharMemory(charId);
    var m = {
      id: newId('mem'), charId: charId,
      /* §2.4：写入时能拿到脸就记下（file 已归 root，脸只在这还有；
         传进来的是大号就记大号自身） */
      fromCharId: charId || null,
      kind: item.kind || 'custom',
      content: String(item.content || '').trim(),
      source: 'user_manual', sourceRef: '用户手动添加',
      evidenceType: 'user_explicit', status: 'active',
      isAnchor: false, isUserEdited: true,
      createdAt: nowIso(), updatedAt: nowIso()
    };
    file.memories.unshift(m);
    saveCharMemory(file);
    vecCall('sweepMem', [charId]);          /* 新档案进库（他记着的事） */
    return m;
  }

  function deleteMemoryItem(charId, memoryId) {
    var file = loadCharMemory(charId);
    var m = findMemory(file, memoryId);
    /* 只有 user_manual 能物理删除；其他来源只能标 invalid */
    if (!m || m.source !== 'user_manual') return false;
    file.memories = file.memories.filter(function (x) { return x.id !== memoryId; });
    saveCharMemory(file);
    /* 不在了 → refreshMem 顺手把旧块清掉（不是重建） */
    vecCall('refreshMem', [charId, memoryId]);
    return true;
  }

  function confirmMemoryItem(charId, memoryId) {
    updateMemoryItem(charId, memoryId, { status: 'active' });
  }
  /* 批量确认（确认流升级）：一次落库，pendingCount 只同步一次 */
  function confirmMemoryItems(charId, memoryIds) {
    if (!Array.isArray(memoryIds) || !memoryIds.length) return 0;
    var file = loadCharMemory(charId);
    var want = {};
    memoryIds.forEach(function (id) { want[id] = 1; });
    var n = 0;
    var changed = [];
    file.memories.forEach(function (m) {
      if (want[m.id] && m.status === 'pending') {
        m.status = 'active';
        m.updatedAt = nowIso();
        changed.push(m.id);
        n++;
      }
    });
    if (n) {
      saveCharMemory(file);
      /* pending → active = 「这条现在能用了」→ 进索引。
         只重建**真变了**的那几条，别把整批没变的白 embed 一遍。 */
      changed.forEach(function (id) { vecCall('refreshMem', [charId, id]); });
    }
    return n;
  }
  function invalidateMemoryItem(charId, memoryId) {
    updateMemoryItem(charId, memoryId, { status: 'invalid' });
  }
  function toggleAnchor(charId, memoryId) {
    var file = loadCharMemory(charId);
    var m = findMemory(file, memoryId);
    if (!m) return;
    updateMemoryItem(charId, memoryId, { isAnchor: !m.isAnchor });
  }

  function updateUnderstandingItem(charId, itemId, patch) {
    var file = loadCharMemory(charId);
    file.understandings.forEach(function (u) {
      if (u.id !== itemId) return;
      if (patch.content !== undefined) u.content = patch.content;
      if (patch.status !== undefined) u.status = patch.status;
      u.updatedAt = nowIso();
    });
    saveCharMemory(file);
  }

  function updateMemoryConfig(charId, patch) { setCharConfig(charId, patch); }

  /* ---- 工具函数（指令卡第五节） ---- */

  var CATEGORY_KINDS = {
    profile: ['preference_like', 'preference_dislike', 'boundary', 'habit', 'user_fact'],
    together: ['shared_event'],
    told: [],              /* 特殊：evidenceType='user_explicit' */
    recent: [],            /* 特殊：14 天内 active/pending */
    inference: ['character_inference'],
    open: ['promise']
  };

  function filterByCategory(memories, category, file) {
    var now = Date.now();
    switch (category) {
      case 'profile':
        return memories.filter(function (m) {
          return CATEGORY_KINDS.profile.indexOf(m.kind) >= 0 && m.status !== 'invalid';
        });
      case 'together':
        return memories.filter(function (m) {
          return m.kind === 'shared_event' && m.source === 'offline';
        });
      case 'told':
        return memories.filter(function (m) { return m.evidenceType === 'user_explicit'; });
      case 'recent':
        return memories.filter(function (m) {
          return (now - new Date(m.createdAt).getTime()) < 14 * 86400000 &&
                 (m.status === 'active' || m.status === 'pending');
        });
      case 'inference':
        return (file ? file.understandings : []).filter(function (u) {
          return u.status === 'active';
        });
      case 'open':
        return memories.filter(function (m) {
          return (m.kind === 'promise' && m.status === 'active') || m.status === 'pending';
        });
    }
    return memories;
  }

  function filterBySource(memories, source) {
    if (source === 'all' || !source) return memories;
    return memories.filter(function (m) { return m.source === source; });
  }

  function countByCategory(file) {
    var out = {};
    ['profile', 'together', 'told', 'recent', 'inference', 'open'].forEach(function (cat) {
      out[cat] = filterByCategory(file.memories, cat, file).length;
    });
    return out;
  }
  function countPending(memories) {
    return memories.filter(function (m) { return m.status === 'pending'; }).length;
  }
  function getRecentMemories(memories, limit) {
    var list = memories.filter(function (m) {
      return m.status === 'active' || m.status === 'pending';
    }).sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
    return limit ? list.slice(0, limit) : list;
  }
  function getArchivedMemories(memories) {
    return memories.filter(function (m) {
      return m.status === 'invalid' || m.status === 'superseded';
    });
  }

  /* ---- 对话系统接口（指令卡第八节，只暴露这两个） ---- */

  /* 注入配额（2026-09-22 用户提「六条太少」之后重做）。
     旧版：锚点不限 + boundary 固定 3 条 + correction 固定 3 条 + 其余补满 6。
     边界 3 + 纠正 3 正好把 6 格吃满 → **共同经历与约定一条都进不来**
     （实测：{"注入条数":6,"共同经历":false,"约定":false,"事实":false}）。
     根子不在「少」，在于给「规则类」发了固定配额、而「经历类」没有任何保底 ——
     结果最该被反复看见的（我们一起做过什么、我答应过你什么）先被挤掉，
     最不需要每轮重复的（禁区、纠错）反而霸屏。
     现在：规则类各自有**上限**，经历类有**保底**，谁也不能把对方挤光。 */

  /* 经历类：我们之间发生过什么。注入时至少要给它们一半席位。 */
  var EXPERIENCE_KINDS = ['shared_event', 'user_fact', 'preference_like',
    'preference_dislike', 'relationship_fact', 'habit'];

  function getMemoryInjection(charId, options) {
    options = options || {};
    var cfg = charConfig(charId);
    if (!cfg.enabled) return '';                 /* 关了开关：注入为空，数据保留 */
    var file = loadCharMemory(charId);
    var active = file.memories.filter(function (m) { return m.status === 'active'; });
    if (!active.length && !file.understandings.length) return '';

    var maxItems = options.maxItems || 12;
    var RULE_MAX = 3;    /* 规则类各自的上限：够用就行，不许吃满整张表 */
    var PROMISE_N = 4;   /* 约定：越近的越可能还没兑现（兑现了会由总结引擎作废），取最近几条 */

    var picked = [];
    function take(m) { if (picked.indexOf(m) < 0) picked.push(m); }
    function byNewest(a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    }
    function pending(kinds) {
      return active.filter(function (m) {
        return (!kinds || kinds.indexOf(m.kind) >= 0) && picked.indexOf(m) < 0;
      }).sort(byNewest);
    }
    /* 每步都按「还剩几格」实时结算 —— 不这样做的话，先填的那组会吃满整张表，
       后面几组拿到的就不是「保底」而是「没有」（旧版的毛病就是这个）。 */
    function fill(kinds, n) {
      var room = Math.min(n, base + maxItems - picked.length);
      if (room > 0) pending(kinds).slice(0, room).forEach(take);
    }

    /* ① 锚点是用户手标的，不吃配额（原设计）。配额从它之后开始算。 */
    active.filter(function (m) { return m.isAnchor; }).forEach(take);
    var base = picked.length;

    /* ② 约定先占座：答应过的事，优先于规则条文的重复。 */
    fill(['promise'], PROMISE_N);
    /* ③ 经历类保底一半席位 —— 这次修的核心，旧版没有这一步。 */
    fill(EXPERIENCE_KINDS, Math.ceil(maxItems / 2));
    /* ④ 规则类各保底一条（禁区不能不进），先只给一条，余量留给经历。 */
    fill(['boundary'], 1);
    fill(['correction'], 1);
    /* ⑤ 还有余量才给规则类加到上限，然后经历类继续按时间补。 */
    fill(['boundary'], RULE_MAX);
    fill(['correction'], RULE_MAX);
    fill(EXPERIENCE_KINDS, maxItems);
    /* ⑥ 兜底：其他 kind（custom / 推测…）按时间补齐。 */
    fill(null, maxItems);

    picked = picked.slice(0, base + maxItems);   /* 硬上限：锚点 + 配额 */
    if (!picked.length) return '';
    var lines = ['【关于对方的记忆】（经过用户确认与整理）'];
    picked.forEach(function (m) {
      lines.push('- [' + (KIND_LABELS[m.kind] || m.kind) + ']' +
        (m.isAnchor ? '（锚定）' : '') + ' ' + m.content);
    });
    /* 最新一条「这样理解你」也带上（推测要标明是推测） */
    var u = file.understandings.filter(function (x) { return x.status === 'active'; })
      .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })[0];
    if (u) lines.push('- [我的推测] ' + u.content);
    return lines.join('\n');
  }

  function writeMemoryItems(charId, items) {
    if (!Array.isArray(items) || !items.length) return;
    var file = loadCharMemory(charId);
    items.forEach(function (it) {
      file.memories.push({
        id: newId('mem'), charId: charId,
        kind: it.kind || 'custom',
        content: String(it.content || '').trim(),
        source: it.source || 'ai_summary',
        sourceRef: it.sourceRef || '',
        evidenceType: it.evidenceType || 'uncertain',
        status: it.status || 'pending',
        isAnchor: false, isUserEdited: false,
        createdAt: nowIso(), updatedAt: nowIso()
      });
    });
    saveCharMemory(file);
    /* 总结引擎写完 → 新档案进向量库（只接 active，pending 等确认时再进） */
    vecCall('sweepMem', [charId]);
  }

  /* ==================== 项目 5 S7/S8：charMem 归 root 迁移（2026-09-23 定稿） ====================
     一次性的数据搬家：charMem:<皮套> / memoryIsland.byChar[皮套] /
     charSettings 的 proactive·autoLife·memory / diaryPeek:<皮套> 全部并到 root。
     七步流水线（最终设计 §2.8），中断靠持久化的 charMemMigrationState：
       snapshot → merged → verified → srcDeleted → done（校验不过 → 整份恢复 → failed）
     启动恢复三分支（S8）：未校验 → 整份恢复后重跑；已校验未删源 → 续完；done → 只清标记。
     纪律：备份 = 源键 + 目标键双份完整快照；失败不删源键；旧源键删除前不算迁移完成。 */

  var MIG_STATE_KEY = 'charMemMigrationState';
  var MIG_DONE_KEY = 'charMemMigrated';
  var MIG_BAK_PREFIX = 'charMemBackup:';
  var MIG_STATUS_RANK = { invalid: 4, superseded: 3, active: 2, pending: 1 };

  var migLock = false;
  /* 写入锁（S7 + 补证 2026-09-26）：内存锁管运行中；**持久化的未完成事务
     也算迁移中** —— 崩溃重启后的头几毫秒里 migLock 还没立起来，而
     migRecover（整份恢复）还没跑完，这扇窗里的写入会踩到「恢复到一半」的库。
     phase 只有未完成的那几种算（done 不存在——结束时 state 已被清掉）。 */
  function isMigrating() {
    if (migLock) return true;
    var st = store.get(MIG_STATE_KEY);
    return !!(st && st.phase && st.phase !== 'done');
  }

  /* C1 的「完整字段全同」：fromCharId 是迁移时才补的，不参与比较 */
  function migEntryJson(e) {
    var o = {};
    for (var k in e) {
      if (e.hasOwnProperty(k) && k !== 'fromCharId' && k !== 'migrationOriginalStatus') o[k] = e[k];
    }
    return JSON.stringify(o);
  }

  /* 把 incoming 并进 target 列表（原地改）。冲突规则 §2.4：
     C1 全同 → 跳过；同 id 不同内容 → 按 C2/C3 挑胜者，
     败者改新 id + superseded + supersededBy 指向真实胜者 + migrationOriginalStatus。
     isAnchor 只参与字段合并（OR），不得改变失效状态（锚不复活）。 */
  function migMergeIntoList(target, incoming, fromFace, report) {
    (incoming || []).forEach(function (inc) {
      if (!inc || !inc.id) return;
      if (inc.fromCharId === undefined) inc.fromCharId = fromFace;
      var dupIdx = -1;
      for (var i = 0; i < target.length; i++) {
        if (target[i] && target[i].id === inc.id) { dupIdx = i; break; }
      }
      if (dupIdx < 0) { target.push(inc); return; }
      var dup = target[dupIdx];
      if (migEntryJson(dup) === migEntryJson(inc)) { report.c1Skipped++; return; }   /* C1 */
      var rDup = MIG_STATUS_RANK[dup.status] || 0;
      var rInc = MIG_STATUS_RANK[inc.status] || 0;
      var winner, loser;
      if (rDup !== rInc) {
        winner = (rDup > rInc) ? dup : inc;          /* C3 跨级：失效优先，不复活 */
        loser = (winner === dup) ? inc : dup;
      } else {
        /* C2 同级：updatedAt 较新者（缺则 createdAt；都缺视为最旧） */
        var tDup = String(dup.updatedAt || dup.createdAt || '');
        var tInc = String(inc.updatedAt || inc.createdAt || '');
        winner = (tDup.localeCompare(tInc) >= 0) ? dup : inc;
        loser = (winner === dup) ? inc : dup;
      }
      winner.isAnchor = !!(winner.isAnchor || loser.isAnchor);
      var loserStatus = loser.status || 'pending';
      loser.id = loser.id + '_sup_' + Math.random().toString(36).slice(2, 6);
      loser.status = 'superseded';
      loser.supersededBy = winner.id;
      loser.migrationOriginalStatus = loserStatus;
      target[dupIdx] = winner;
      target.push(loser);
      report.conflicts++;
    });
  }

  /* 用备份整份恢复（源键 + 目标键都还原；不是按 id 删） */
  function migRestore(backup) {
    var data = (backup && backup.data) || {};
    Object.keys(data).forEach(function (key) {
      if (data[key] === undefined) store.remove(key);
      else store.set(key, data[key]);
    });
  }

  /* 备份保留最近 3 份，更早的清掉（§2.7） */
  function migPruneBackups() {
    try {
      var ls = global.localStorage;
      var ns = (store && store.NS) || 'sleepy.v1.';
      var keys = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(ns) === 0 &&
          k.slice(ns.length).indexOf(MIG_BAK_PREFIX) === 0) keys.push(k.slice(ns.length));
      }
      keys.sort();
      while (keys.length > 3) store.remove(keys.shift());
    } catch (e) { /* 清不掉就算了 */ }
  }

  function migrateCharMemToRoot() {
    if (store.get(MIG_DONE_KEY)) return null;            /* 跑过：幂等，直接返回 */
    var coreC = Sleepy.core;
    if (!coreC || !coreC.rootIdOf) return null;          /* core 没就绪：下次加载再跑 */
    var st = store.get(MIG_STATE_KEY);
    if (st && st.phase && st.phase !== 'done') return migRecover(st);   /* S8 三分支 */
    return migRun();
  }

  /* 启动恢复三分支（S8，最终设计 §2.5） */
  function migRecover(st) {
    if (st.phase === 'verified' || st.phase === 'srcDeleted') {
      /* 已校验未删源 → 续完：删源键 → 落日志 → 清标记 */
      (st.sources || []).forEach(function (key) { store.remove(key); });
      store.set(MIG_DONE_KEY, { at: Date.now(), txn: st.txn, recovered: st.phase });
      store.remove(MIG_STATE_KEY);
      migPruneBackups();
      return { ok: true, recovered: st.phase };
    }
    /* 未校验（snapshot / merged）或 failed → 用备份整份恢复 → 清标记 → 下次重跑 */
    var backup = store.get(st.backupKey);
    if (backup) migRestore(backup);
    store.remove(MIG_STATE_KEY);
    return { ok: false, recovered: st.phase, restored: !!backup };
  }

  function migRun() {
    var coreC = Sleepy.core;
    function rootOfOr(id) { return coreC.rootIdOf(id); }
    var report = { sources: 0, orphans: 0, quarantined: 0, c1Skipped: 0,
      conflicts: 0, movedIsland: 0, movedSettings: 0, movedPeek: 0, memoryOffMerged: 0 };

    /* ① 读源键：前缀兜底扫（孤儿键也进视野，不猜归属） */
    var faceIds = [];
    try {
      var ls0 = global.localStorage;
      var ns0 = (store && store.NS) || 'sleepy.v1.';
      for (var i0 = 0; i0 < ls0.length; i0++) {
        var k0 = ls0.key(i0);
        if (!k0 || k0.indexOf(ns0) !== 0) continue;
        var top0 = k0.slice(ns0.length);
        if (top0.indexOf('charMem:') === 0) faceIds.push(top0.slice('charMem:'.length));
      }
    } catch (e) { /* 扫不了就靠上面的空表（等于没有源） */ }

    var byRoot = {};
    faceIds.forEach(function (face) {
      var root = rootOfOr(face);
      if (!root) { report.orphans++; return; }          /* 孤儿键：隔离计数，不迁不删 */
      if (root === face) return;                         /* 本来就是 root 门牌：不动 */
      var raw = store.get('charMem:' + face);
      if (!raw) return;
      /* C6：understandings 无写入方、schema 无法核实 → 整键不迁不删，隔离计数 */
      if ((raw.understandings || []).length) { report.quarantined++; return; }
      var bucket = byRoot[root] = byRoot[root] || { faces: [], files: {} };
      bucket.faces.push(face);
      bucket.files[face] = raw;
      report.sources++;
    });

    /* diaryPeek 的源键（要跟着搬到 root 门牌下） */
    var peekSources = [];
    try {
      var ls1 = global.localStorage;
      var ns1 = (store && store.NS) || 'sleepy.v1.';
      for (var i1 = 0; i1 < ls1.length; i1++) {
        var k1 = ls1.key(i1);
        if (!k1 || k1.indexOf(ns1) !== 0) continue;
        var top1 = k1.slice(ns1.length);
        if (top1.indexOf('diaryPeek:') !== 0) continue;
        var face1 = top1.slice('diaryPeek:'.length);
        var root1 = rootOfOr(face1);
        if (!root1 || root1 === face1) continue;
        if (!store.get(top1)) continue;                  /* 空旗子不用搬 */
        peekSources.push({ key: top1, root: root1 });
      }
    } catch (e) { /* 递不了字条就算了，不挡迁移 */ }

    migLock = true;
    try {
      /* ②③ 备份：源键 + 目标键双份完整快照，先落备份再动数据；
            state（含 sources 清单）在备份落盘后持久化 —— 中断恢复靠它 */
      var state = {
        txn: 'mig' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        phase: 'snapshot',
        backupKey: MIG_BAK_PREFIX + Date.now(),
        affectedRoots: Object.keys(byRoot),
        sources: [], startedAt: migNowIso0(), updatedAt: migNowIso0()
      };
      var backup = { at: Date.now(), txn: state.txn, data: {} };
      function keepRaw(key) {
        if (backup.data[key] === undefined) backup.data[key] = store.get(key);
      }
      Object.keys(byRoot).forEach(function (root) {
        keepRaw('charMem:' + root);                      /* 目标键预像（可能不存在） */
        byRoot[root].faces.forEach(function (face) {
          keepRaw('charMem:' + face);
          state.sources.push('charMem:' + face);
        });
      });
      peekSources.forEach(function (p) {
        keepRaw(p.key);
        keepRaw('diaryPeek:' + p.root);
        state.sources.push(p.key);
      });
      keepRaw('memoryIsland');
      keepRaw('charSettings');
      store.set(state.backupKey, backup);
      store.set(MIG_STATE_KEY, state);                   /* phase=snapshot 已持久化 */

      /* ④ 合并并写目标 → merged */
      var totalBefore = 0, c1Total = 0;
      Object.keys(byRoot).forEach(function (root) {
        var bucket = byRoot[root];
        var target = store.get('charMem:' + root) ||
          { version: '1', charId: root, updatedAt: migNowIso0(), understandings: [], memories: [] };
        target.memories = target.memories || [];
        target.understandings = target.understandings || [];
        totalBefore += target.memories.length + target.understandings.length;
        bucket.faces.forEach(function (face) {
          var src = bucket.files[face];
          totalBefore += ((src.memories || []).length) + ((src.understandings || []).length);
          migMergeIntoList(target.memories, src.memories || [], face, report);
          /* 走到这里的源键 understandings 一定是空的（非空已被隔离），无需合并 */
        });
        /* fromCharId 收口：root 自身原有的条目记自身 id（§2.4） */
        target.memories.forEach(function (m) {
          if (m && m.fromCharId === undefined) m.fromCharId = root;
        });
        target.charId = root;
        target.rootId = root;
        target.updatedAt = migNowIso0();
        store.set('charMem:' + root, target);
      });
      c1Total = report.c1Skipped;

      /* memoryIsland.byChar 归 root（enabled false 优先 C8；level 冲突按 C4） */
      var island = store.get('memoryIsland') || { name: '星屿', type: 'solo', byChar: {} };
      island.byChar = island.byChar || {};
      Object.keys(byRoot).forEach(function (root) {
        var tgt = island.byChar[root] || null;
        byRoot[root].faces.forEach(function (face) {
          var c = island.byChar[face];
          if (!c) return;
          if (!tgt) tgt = island.byChar[root] = {};
          if (c.enabled === false) tgt.enabled = false;
          else if (tgt.enabled === undefined && c.enabled !== undefined) tgt.enabled = c.enabled;
          if (c.level && (!tgt.level ||
            String(c.updatedAt || '') .localeCompare(String(tgt.updatedAt || '')) > 0)) {
            tgt.level = c.level;
          }
          if (String(c.updatedAt || '') > String(tgt.updatedAt || '')) tgt.updatedAt = c.updatedAt;
          delete island.byChar[face];
          report.movedIsland++;
        });
      });

      /* charSettings 字段级归 root（§2.2）：proactive false 优先；
         autoLife 保守取低档；旧 memory:false 并入 memoryIsland 后摘掉 */
      var csAll = store.get('charSettings') || { byChar: {} };
      csAll.byChar = csAll.byChar || {};
      var lifeRank = { off: 0, low: 1, mid: 2, high: 3 };
      Object.keys(byRoot).forEach(function (root) {
        var t = csAll.byChar[root] || null;
        byRoot[root].faces.forEach(function (face) {
          var c = csAll.byChar[face];
          if (!c) return;
          if (!t) t = csAll.byChar[root] = {};
          if (c.proactive === false) t.proactive = false;
          else if (t.proactive === undefined && c.proactive !== undefined) t.proactive = c.proactive;
          if (c.autoLife && (!t.autoLife ||
            (lifeRank[c.autoLife] || 0) < (lifeRank[t.autoLife] || 0))) t.autoLife = c.autoLife;
          if (c.memory === false && island.byChar[root]) {
            island.byChar[root].enabled = false;
            report.memoryOffMerged++;
          }
          delete csAll.byChar[face];
          report.movedSettings++;
        });
      });
      store.set('memoryIsland', island);
      store.set('charSettings', csAll);

      /* diaryPeek：搬旗子（目标已有旗就不动，删源在 ⑥） */
      peekSources.forEach(function (p) {
        if (!store.get('diaryPeek:' + p.root)) {
          store.set('diaryPeek:' + p.root, store.get(p.key));
          report.movedPeek++;
        }
      });

      /* ⑤ 校验：数量守恒 / id 唯一 / supersededBy 指向真实存在的胜者 / fromCharId 齐 */
      var ok = true, totalAfter = 0;
      Object.keys(byRoot).forEach(function (root) {
        if (!ok) return;
        var f = store.get('charMem:' + root) || {};
        var seen = {};
        ((f.memories || []).concat(f.understandings || [])).forEach(function (m) {
          if (!m || !m.id || seen[m.id]) { ok = false; return; }
          seen[m.id] = 1;
          if (m.fromCharId === undefined) ok = false;
          totalAfter++;
        });
        (f.memories || []).forEach(function (m) {
          if (m && m.status === 'superseded' && m.supersededBy && !seen[m.supersededBy]) ok = false;
        });
      });
      if (totalAfter !== totalBefore - c1Total) ok = false;   /* 守恒（C1 跳过是唯一减量） */
      if (!ok) {
        migRestore(backup);                              /* 整份恢复，不删任何源键 */
        /* §2.5：迁移结束（含失败）必须清 charMemMigrationState ——
           备份本身就是审计留痕；state 留着会让持久化写入锁卡死整段会话 */
        store.remove(MIG_STATE_KEY);
        return { ok: false, why: 'verify-failed', report: report };
      }
      state.phase = 'verified';
      state.updatedAt = migNowIso0();
      store.set(MIG_STATE_KEY, state);

      /* ⑥ 删源键 → srcDeleted（删除前不算迁移完成） */
      state.sources.forEach(function (key) { store.remove(key); });
      state.phase = 'srcDeleted';
      state.updatedAt = migNowIso0();
      store.set(MIG_STATE_KEY, state);

      /* ⑦ 落日志 → 清标记 → 清过期备份（保留 3） */
      store.set(MIG_DONE_KEY, { at: Date.now(), txn: state.txn, report: report });
      store.remove(MIG_STATE_KEY);
      migPruneBackups();
      return { ok: true, report: report, roots: state.affectedRoots.length };
    } finally {
      migLock = false;
    }
  }

  function migNowIso0() { return new Date().toISOString(); }

  /* 启动迁移的**真实调用链**（两条，不是"下次再跑"）：
     ① 模块加载时直接喊（index.html 里 core.js:71 先于本文件 :174，正常都就绪）；
     ② 万一 core 没就绪（脚本顺序被好心调整 / 加载异常）→ 挂 **DOMContentLoaded**
        再喊一次 —— defer 脚本全部执行完的标准信号，那时 core 一定已挂上。
     当前加载方式（全部 defer）下 init 必然早于 DOMContentLoaded，链②天然适用；
     若未来改成动态注入且事件已发生过（readyState 不是 'loading'），事件永远
     不来 —— 那就用有界的 setTimeout 兜底重试（6 次 × 100ms），仍然不猜不无限等。
     不就绪就跳过且没有任何后续 = 整个存档的迁移被静默跳过，这是不许发生的。 */
  function bootMigrate() {
    var coreC = Sleepy.core;
    if (!coreC || !coreC.rootIdOf) {
      try {
        var ready = (typeof document !== 'undefined' && document.readyState) || 'loading';
        if (typeof document !== 'undefined' && ready !== 'loading') {
          /* 事件已经错过：有界重试（给 core 一点异步补位的时间） */
          var tries = 0;
          var iv = setInterval(function () {
            tries++;
            if ((Sleepy.core && Sleepy.core.rootIdOf) || tries >= 6) {
              clearInterval(iv);
              try { migrateCharMemToRoot(); } catch (e) { /* 失败留 state 给下次恢复 */ }
            }
          }, 100);
        } else if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('DOMContentLoaded', bootMigrate);
        }
      } catch (e) { /* 环境怪的设备：下次冷启动再补（概率趋零的兜底） */ }
      return null;
    }
    return migrateCharMemToRoot();
  }
  var __migResult = null;
  try { __migResult = bootMigrate(); } catch (e) { /* 迁移失败不挡加载；state 留给下次恢复 */ }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.memoryStore = {
    loadIsland: loadIsland,
    loadCharMemory: loadCharMemory,
    /* 项目 5：外部写方（总结 ingest / 群记忆拆库）统一走这个入口 ——
       它负责归 root 门牌、补 fromCharId、迁移期间短路 */
    saveCharMemory: saveCharMemory,
    updateMemoryItem: updateMemoryItem,
    addMemoryItem: addMemoryItem,
    deleteMemoryItem: deleteMemoryItem,
    confirmMemoryItem: confirmMemoryItem,
    confirmMemoryItems: confirmMemoryItems,
    invalidateMemoryItem: invalidateMemoryItem,
    toggleAnchor: toggleAnchor,
    updateUnderstandingItem: updateUnderstandingItem,
    updateMemoryConfig: updateMemoryConfig,
    /* 项目 5：开关归 root 后，设置页（charSettings.memory 下线）直接读写 memoryIsland */
    charConfig: charConfig,
    setCharConfig: setCharConfig,
    /* 项目 5 S7：迁移写入锁 / 迁移入口（冒烟用）与启动结果 */
    isMigrating: isMigrating,
    migrateCharMemToRoot: migrateCharMemToRoot,
    bootMigrate: bootMigrate,
    migrationResult: function () { return __migResult; },
    getMemoryInjection: getMemoryInjection,
    writeMemoryItems: writeMemoryItems,
    filterByCategory: filterByCategory,
    filterBySource: filterBySource,
    countByCategory: countByCategory,
    countPending: countPending,
    getRecentMemories: getRecentMemories,
    getArchivedMemories: getArchivedMemories,
    LABELS: { kind: KIND_LABELS, kindColor: KIND_COLOR, source: SOURCE_LABELS, evid: EVID_LABELS, status: STATUS_LABELS }
  };

  /* ---------------------------- 页面：首页 ---------------------------- */

  function memStateText(cfg) { return LEVEL_LABELS[cfg.level] || '完整记忆'; }

  Sleepy.register('memory', {
    title: '留痕',
    render: function (ctx) {
      var body = ctx.body;
      ctx.setTitle('留痕');

      var searchQ = '';

      function build() {
        body.innerHTML = '';
        var island = loadIsland();
        var mains = island.chars.filter(function (c) { return !c.isNpc; });
        var npcs = island.chars.filter(function (c) { return c.isNpc; });

        body.appendChild(h('p', 'lh-app-sub', '记忆与内页'));

        /* 搜索态：一行筛选结果列表 */
        if (searchQ) {
          var sec = h('div', 'lh-sec');
          sec.appendChild(h('p', 'lh-section-label', '搜索「' + searchQ + '」'));
          var hits = [];
          mains.concat(npcs).forEach(function (c) {
            loadCharMemory(c.id).memories.forEach(function (m) {
              if ((m.content || '').indexOf(searchQ) >= 0) hits.push({ char: c, m: m });
            });
          });
          if (!hits.length) sec.appendChild(h('p', 'lh-empty', '没有匹配的记忆'));
          hits.slice(0, 30).forEach(function (hit) {
            sec.appendChild(memRow(hit.m, hit.char));
          });
          body.appendChild(sec);
          return;
        }

        /* 岛屿行 */
        var islandRow = h('div', 'lh-island-row');
        islandRow.appendChild(h('span', 'lh-island-name', island.name));
        islandRow.appendChild(h('span', 'lh-island-meta',
          (island.type === 'solo' ? '孤岛' : '群岛') + ' · ' + mains.length + ' 位主角色 · ' + npcs.length + ' 位 NPC'));
        body.appendChild(islandRow);

        /* 主角色 */
        body.appendChild(h('p', 'lh-section-label', '主角色'));
        if (!mains.length) body.appendChild(h('p', 'lh-empty', '还没有角色 —— 去通讯录加一个'));
        mains.forEach(function (c) { body.appendChild(charRow(c, false)); });

        /* NPC 折叠区 */
        if (npcs.length) {
          var toggle = h('button', 'lh-npc-toggle');
          toggle.type = 'button';
          toggle.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>';
          toggle.appendChild(h('span', 'lh-npc-toggle-label', 'NPC · 关系网'));
          toggle.appendChild(h('span', 'lh-npc-toggle-count', npcs.length + ' 位'));
          var list = h('div', 'lh-npc-list');
          npcs.forEach(function (n) { list.appendChild(npcRow(n)); });
          toggle.addEventListener('click', function () {
            toggle.classList.toggle('open');
            list.classList.toggle('open');
          });
          body.appendChild(toggle);
          body.appendChild(list);
        }

        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      function charRow(c, isNpc) {
        var row = h('div', 'lh-char-row');
        if (c.pendingCount > 0) row.appendChild(h('span', 'lh-pending-pip'));
        var top = h('div', 'lh-char-row-top');
        var left = h('div', 'lh-char-row-left');
        left.appendChild(h('span', 'lh-char-name', c.name));
        var tags = h('div', 'lh-char-tags');
        c.tags.filter(Boolean).forEach(function (t) { tags.appendChild(h('span', 'lh-char-tag', t)); });
        left.appendChild(tags);
        top.appendChild(left);

        var right = h('div', 'lh-char-row-right');
        right.appendChild(h('span', 'lh-mem-state' + (c.memoryConfig.enabled ? ' on' : ''), memStateText(c.memoryConfig)));
        var tRow = h('div', 'lh-char-toggle-row');
        tRow.appendChild(h('span', 'lh-char-toggle-label', '记忆系统'));
        var tgl = h('div', 'lh-mini-toggle' + (c.memoryConfig.enabled ? ' on' : ''));
        tgl.addEventListener('click', function (e) {
          e.stopPropagation();
          updateMemoryConfig(c.id, { enabled: !c.memoryConfig.enabled });
          build();
        });
        tRow.appendChild(tgl);
        right.appendChild(tRow);
        top.appendChild(right);
        row.appendChild(top);

        if (c.latestExcerpt) row.appendChild(h('div', 'lh-char-excerpt', c.latestExcerpt));

        var foot = h('div', 'lh-char-row-foot');
        foot.appendChild(h('span', 'lh-char-row-time',
          c.latestMemoryUpdatedAt ? '最近更新 · ' + relTime(c.latestMemoryUpdatedAt) : '还没有记忆'));
        foot.appendChild(h('span', 'lh-char-enter', '打开内页 ›'));
        row.appendChild(foot);

        row.addEventListener('click', function () { ctx.open('memory-char', { charId: c.id }); });
        return row;
      }

      function npcRow(n) {
        var row = h('div', 'lh-npc-row');
        var left = h('div', 'lh-npc-row-left');
        left.appendChild(h('span', 'lh-npc-name', n.name));
        left.appendChild(h('span', 'lh-npc-rel', n.tags.filter(Boolean).join(' · ') || 'NPC'));
        row.appendChild(left);
        var right = h('div', 'lh-npc-row-right');
        right.appendChild(h('span', 'lh-mem-state' + (n.memoryConfig.enabled ? ' on' : ''), memStateText(n.memoryConfig)));
        var tgl = h('div', 'lh-mini-toggle' + (n.memoryConfig.enabled ? ' on' : ''));
        tgl.addEventListener('click', function (e) {
          e.stopPropagation();
          updateMemoryConfig(n.id, { enabled: !n.memoryConfig.enabled });
          build();
        });
        right.appendChild(tgl);
        row.appendChild(right);
        row.addEventListener('click', function () { ctx.open('memory-char', { charId: n.id }); });
        return row;
      }

      /* 列表行（搜索结果复用） */
      function memRow(m, char) {
        var row = h('div', 'lh-mem-row');
        var top = h('div', 'lh-mem-row-top');
        top.appendChild(h('span', 'lh-mem-kind lh-mk-' + (KIND_COLOR[m.kind] || 'dim'),
          m.status === 'pending' ? '待确认' : (KIND_LABELS[m.kind] || m.kind)));
        top.appendChild(h('span', 'lh-mem-time', relTime(m.updatedAt)));
        row.appendChild(top);
        row.appendChild(h('div', 'lh-mem-text', m.content));
        row.appendChild(h('div', 'lh-mem-src',
          '来自 · ' + (SOURCE_LABELS[m.source] || m.source) + (char ? ' · ' + char.name : '')));
        row.addEventListener('click', function () {
          ctx.open('memory-detail', { charId: m.charId, memoryId: m.id });
        });
        return row;
      }

      ctx.rebuild = build;
      build();

      ctx.setActions([
        { label: '搜索记忆', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
          onClick: function () {
            ui.prompt({ title: '搜记忆', placeholder: '输入关键词' }).then(function (q) {
              searchQ = String(q || '').trim();
              ctx.rebuild();
            });
          } },
        { label: '新增记忆', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
          onClick: function () {
            var island = loadIsland();
            if (!island.chars.length) { ctx.toast('还没有角色', 'warn'); return; }
            ui.prompt({
              title: '给谁添加一条记忆？',
              note: '输入角色名（' + island.chars.map(function (c) { return c.name; }).join(' / ') + '）'
            }).then(function (name) {
              var cname = String(name || '').trim();
              var c = island.chars.filter(function (x) { return x.name === cname; })[0] ||
                      island.chars.filter(function (x) { return x.name.indexOf(cname) >= 0; })[0];
              if (!c) { ctx.toast('没有这个角色', 'warn'); return; }
              ctx.open('memory-char', { charId: c.id, addNew: true });
            });
          } }
      ]);
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---------------------------- 页面：内页 ---------------------------- */

  Sleepy.register('memory-char', {
    title: '内页',
    render: function (ctx) {
      var body = ctx.body;
      var charId = ctx.params.charId || '';
      var coreO = core();
      var ch = coreO.findChar(charId);
      if (!ch) { ctx.toast('找不到这个角色', 'err'); ctx.back(); return; }
      ctx.setTitle(ch.name);

      /* 筛选状态：category / status / source / 关键词 四者 AND */
      var fCategory = ctx.params.addNew ? null : null;
      var fStatus = null;         /* null | 'recent' | 'pending' | 'archived' */
      var fSource = 'all';
      var fQuery = '';            /* 搜索升级（第三梯队 5）：内容/类型关键词 */

      function build() {
        body.innerHTML = '';
        var file = loadCharMemory(charId);
        var island = loadIsland();
        var summary = island.chars.filter(function (c) { return c.id === charId; })[0] || { memoryConfig: charConfig(charId) };
        var cfg = summary.memoryConfig;

        /* ---- 理解区 ---- */
        var uz = h('div', 'lh-understanding-zone');
        uz.appendChild(h('p', 'lh-uz-title', '我现在这样理解你'));
        var actives = file.understandings.filter(function (u) { return u.status === 'active'; })
          .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })
          .slice(0, 3);
        if (!actives.length) uz.appendChild(h('p', 'lh-empty', '还没有推测 —— 它来自总结引擎的整理'));
        actives.forEach(function (u) {
          var item = h('div', 'lh-uz-item');
          item.appendChild(h('div', 'lh-uz-text', '「' + u.content + '」'));
          var meta = h('div', 'lh-uz-meta');
          var badge = EVID_BADGE[u.evidenceType] || EVID_BADGE.character_inference;
          meta.appendChild(h('span', 'lh-uz-badge ' + badge.cls, badge.text));
          var edit = h('span', 'lh-uz-edit', '可修正');
          edit.addEventListener('click', function () {
            ctx.open('memory-detail', { charId: charId, memoryId: u.id });
          });
          meta.appendChild(edit);
          item.appendChild(meta);
          uz.appendChild(item);
        });
        body.appendChild(uz);

        /* ---- 六格 ---- */
        var counts = countByCategory(file);
        body.appendChild(h('p', 'lh-section-label', '记忆分类'));
        var grid = h('div', 'lh-entries-grid');
        [
          { cat: 'profile', name: '我是什么样的人', num: counts.profile, unit: '条' },
          { cat: 'together', name: '我们一起走过的', num: counts.together, unit: '次见面' },
          { cat: 'told', name: '你亲口告诉我的', num: counts.told, unit: '条' },
          { cat: 'recent', name: '最近的你', num: counts.recent, unit: '天内' },
          { cat: 'inference', name: '我现在这样理解你', num: actives.length, unit: '条推测' },
          { cat: 'open', name: '还没说完的事', num: counts.open, unit: '条待跟进' }
        ].forEach(function (cellDef) {
          var cell = h('div', 'lh-entry-cell');
          cell.appendChild(h('span', 'lh-entry-num', String(cellDef.num)));
          cell.appendChild(h('span', 'lh-entry-name', cellDef.name));
          cell.appendChild(h('span', 'lh-entry-unit', cellDef.unit));
          cell.addEventListener('click', function () {
            fCategory = cellDef.cat; fStatus = null;
            build();
            var listEl = body.querySelector('.lh-mem-list');
            if (listEl) listEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          grid.appendChild(cell);
        });
        body.appendChild(grid);

        /* ---- 整理三格 ---- */
        var pendN = countPending(file.memories);
        var recentN = getRecentMemories(file.memories).length;
        var archN = getArchivedMemories(file.memories).length;
        var triage = h('div', 'lh-triage-section');
        [
          { label: '待确认', num: pendN, alert: pendN > 0, status: 'pending' },
          { label: '最近更新', num: recentN, alert: false, status: 'recent' },
          { label: '已归档', num: archN, alert: false, status: 'archived' }
        ].forEach(function (t) {
          var it = h('div', 'lh-triage-item');
          it.appendChild(h('span', 'lh-triage-num' + (t.alert ? ' alert' : ''), String(t.num)));
          it.appendChild(h('span', 'lh-triage-label', t.label));
          it.addEventListener('click', function () {
            fStatus = fStatus === t.status ? null : t.status;
            fCategory = null;
            build();
          });
          triage.appendChild(it);
        });
        body.appendChild(triage);

        /* ---- 来源筛选 ---- */
        var bar = h('div', 'lh-source-bar');
        Object.keys(SOURCE_LABELS).forEach(function (src) {
          var b = h('button', 'lh-source-btn' + (fSource === src ? ' active' : ''), SOURCE_LABELS[src]);
          b.type = 'button';
          b.addEventListener('click', function () {
            fSource = src;
            build();
          });
          bar.appendChild(b);
        });
        body.appendChild(bar);

        /* ---- 搜索（第三梯队 5）：只重画列表，不打断输入焦点 ---- */
        var searchBar = h('div', 'lh-search-bar');
        var searchInput = h('input', 'lh-search-input');
        searchInput.type = 'search';
        searchInput.placeholder = '搜这段记忆…（内容或类型）';
        searchInput.value = fQuery;
        searchBar.appendChild(searchInput);
        body.appendChild(searchBar);

        /* ---- 记忆列表 ---- */
        var label = fCategory
          ? ({ profile: '我是什么样的人', together: '我们一起走过的', told: '你亲口告诉我的',
               recent: '最近的你', inference: '我现在这样理解你', open: '还没说完的事' }[fCategory])
          : (fStatus === 'pending' ? '待确认' : fStatus === 'archived' ? '已归档'
             : fStatus === 'recent' ? '最近更新' : '最近更新');
        body.appendChild(h('p', 'lh-section-label', label));

        function computeRows(f) {
          var q = fQuery.trim().toLowerCase();
          var rows;
          if (fCategory === 'inference') {
            rows = f.understandings.filter(function (u) { return u.status === 'active'; });
          } else {
            rows = f.memories;
            if (fCategory) rows = filterByCategory(rows, fCategory, f);
            if (fStatus === 'pending') rows = rows.filter(function (m) { return m.status === 'pending'; });
            else if (fStatus === 'archived') rows = getArchivedMemories(rows);
            else if (fStatus === 'recent') rows = getRecentMemories(rows);
          }
          rows = filterBySource(rows, fSource);
          if (q) {
            rows = rows.filter(function (m) {
              return String(m.content || '').toLowerCase().indexOf(q) >= 0 ||
                String(KIND_LABELS[m.kind] || '').toLowerCase().indexOf(q) >= 0;
            });
          }
          return rows.slice().sort(function (a, b) {
            return (b.updatedAt || '').localeCompare(a.updatedAt || '');
          });
        }
        function fillList(listEl, rows, conf) {
          listEl.innerHTML = '';
          if (!rows.length) {
            listEl.appendChild(h('p', 'lh-empty', conf.enabled
              ? (fQuery ? '没搜到 —— 换个词试试'
                : '这里还没有记忆 —— 它们会在总结引擎整理对话后出现，也可以点右上角 + 手动添加')
              : '记忆系统已关闭 —— 数据保留，但不再注入对话'));
          }
          rows.forEach(function (m) {
            var row = h('div', 'lh-mem-row');
            var top = h('div', 'lh-mem-row-top');
            var isU = (m.id || '').indexOf('understanding_') === 0;
            top.appendChild(h('span', 'lh-mem-kind lh-mk-' + (isU ? 'mauve' : (KIND_COLOR[m.kind] || 'dim')),
              m.status === 'pending' ? '待确认' : (isU ? '推测' : (KIND_LABELS[m.kind] || m.kind))));
            top.appendChild(h('span', 'lh-mem-time', relTime(m.updatedAt)));
            row.appendChild(top);
            row.appendChild(h('div', 'lh-mem-text', m.content || ''));
            if (!isU) {
              row.appendChild(h('div', 'lh-mem-src',
                '来自 · ' + (SOURCE_LABELS[m.source] || m.source) + (m.sourceRef ? ' · ' + m.sourceRef : '') +
                (m.supersededBy ? ' · 已被新版本替代' : '')));
            }
            row.addEventListener('click', function () {
              ctx.open('memory-detail', { charId: charId, memoryId: m.id });
            });
            listEl.appendChild(row);
          });
        }

        var list = h('div', 'lh-mem-list');
        fillList(list, computeRows(file), cfg);
        /* 待确认筛选下的批量确认（fillList 会 innerHTML=''，所以放在它后面插）：
           确认流不用一条条点进详情 */
        if (fStatus === 'pending' && pendN > 0) {
          var batch = h('button', 'lh-batch-confirm');
          batch.type = 'button';
          batch.textContent = '全部确认（' + pendN + ' 条都有效）';
          batch.addEventListener('click', function () {
            ui.confirm({
              title: '全部确认？',
              note: pendN + ' 条待确认记忆将全部转为当前有效。拿不准的先去详情页看原文。',
              ok: '全部确认'
            }).then(function (yes) {
              if (!yes) return;
              var fresh = loadCharMemory(charId);
              var ids = fresh.memories
                .filter(function (m) { return m.status === 'pending'; })
                .map(function (m) { return m.id; });
              var n = confirmMemoryItems(charId, ids);
              ctx.toast(n ? '已确认 ' + n + ' 条' : '没有可确认的条目', 'ok');
              build();
            });
          });
          list.insertBefore(batch, list.firstChild);
        }
        searchInput.addEventListener('input', function () {
          fQuery = searchInput.value;
          fillList(list, computeRows(file), cfg);
        });
        body.appendChild(list);
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      ctx.rebuild = build;
      build();

      /* 内页顶栏：记忆系统开关 + 新增 */
      ctx.setActions([
        { label: '新增记忆', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
          onClick: function () { openAdd(); } }
      ]);

      function openAdd() {
        var KINDS = Object.keys(KIND_LABELS).filter(function (k) { return k !== 'character_inference'; });
        ui.prompt({
          title: '手动添加一条记忆',
          note: '类型可写：' + KINDS.map(function (k) { return KIND_LABELS[k]; }).join(' / ') + '（不填=自定义）',
          fields: [
            { key: 'content', label: '内容', placeholder: '比如：我喜欢旧书' },
            { key: 'kind', label: '类型（可选）', placeholder: '自定义' }
          ]
        }).then(function (v) {
          if (!v || !String(v.content || '').trim()) return;
          var kindText = String(v.kind || '').trim();
          var kind = 'custom';
          KINDS.forEach(function (k) { if (KIND_LABELS[k] === kindText) kind = k; });
          addMemoryItem(charId, { kind: kind, content: v.content });
          ctx.toast('已添加', 'ok');
          ctx.rebuild();
        });
      }

      if (ctx.params.addNew) setTimeout(openAdd, 200);
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---------------------------- 页面：详情 ---------------------------- */

  Sleepy.register('memory-detail', {
    title: '记忆',
    render: function (ctx) {
      var body = ctx.body;
      var charId = ctx.params.charId || '';
      var memoryId = ctx.params.memoryId || '';
      var ch = core().findChar(charId);
      var isU = memoryId.indexOf('understanding_') === 0;

      function build() {
        body.innerHTML = '';
        var file = loadCharMemory(charId);
        var m = null;
        if (isU) {
          file.understandings.forEach(function (u) { if (u.id === memoryId) m = u; });
        } else {
          m = findMemory(file, memoryId);
        }
        if (!m) { ctx.toast('这条记忆不见了', 'err'); ctx.back(); return; }

        /* 类型标签 + 锚定标记 */
        var head = h('div', 'lh-detail-head');
        if (!isU) {
          head.appendChild(h('span', 'lh-mem-kind lh-mk-' + (KIND_COLOR[m.kind] || 'dim'),
            KIND_LABELS[m.kind] || m.kind));
        } else {
          head.appendChild(h('span', 'lh-mem-kind lh-mk-mauve', '推测'));
        }
        if (m.isAnchor) head.appendChild(h('span', 'lh-anchor-tag', '已锚定'));
        body.appendChild(head);

        /* 正文（点击进编辑） */
        var contentWrap = h('div', 'lh-detail-content');
        var contentText = h('p', 'lh-detail-text', m.content || '');
        contentWrap.appendChild(contentText);
        var editWrap = h('div', 'lh-detail-edit');
        editWrap.style.display = 'none';
        var ta = h('textarea', 'lh-detail-textarea');
        ta.value = m.content || '';
        editWrap.appendChild(ta);
        var editBtns = h('div', 'lh-detail-editbtns');
        var btnSave = h('button', 'lh-btn lh-btn-primary', '保存');
        var btnCancel = h('button', 'lh-btn', '取消');
        editBtns.appendChild(btnSave); editBtns.appendChild(btnCancel);
        editWrap.appendChild(editBtns);
        contentWrap.appendChild(editWrap);
        body.appendChild(contentWrap);

        function enterEdit() {
          contentText.style.display = 'none';
          editWrap.style.display = 'block';
          ta.focus();
        }
        function exitEdit() {
          contentText.style.display = '';
          editWrap.style.display = 'none';
        }
        contentText.addEventListener('click', enterEdit);
        btnCancel.addEventListener('click', exitEdit);
        btnSave.addEventListener('click', function () {
          var text = String(ta.value || '').trim();
          if (!text) { ctx.toast('内容不能为空', 'warn'); return; }
          if (isU) updateUnderstandingItem(charId, memoryId, { content: text });
          else updateMemoryItem(charId, memoryId, { content: text, isUserEdited: true });
          ctx.toast('已保存', 'ok');
          ctx.rebuild();
        });

        /* 元信息 */
        var meta = h('div', 'lh-detail-meta');
        function metaRow(k, v, onOpen) {
          if (!v) return;
          var row = h('div', 'lh-meta-row');
          row.appendChild(h('span', 'lh-meta-k', k));
          var val = h('span', 'lh-meta-v' + (onOpen ? ' is-link' : ''), v);
          if (onOpen) {
            val.style.cursor = 'pointer';
            val.addEventListener('click', onOpen);
          }
          row.appendChild(val);
          meta.appendChild(row);
        }
        if (!isU) {
          metaRow('类型', KIND_LABELS[m.kind] || m.kind);
          metaRow('来源', (SOURCE_LABELS[m.source] || m.source) + (m.sourceRef ? ' · ' + m.sourceRef : ''));
          metaRow('证据', EVID_LABELS[m.evidenceType] || m.evidenceType);
          metaRow('状态', STATUS_LABELS[m.status] || m.status);
          /* 版本链（第三梯队 5）：谁替代了它 / 它替代了谁，能互相跳 */
          if (m.supersededBy) {
            var newer = findMemory(file, m.supersededBy);
            metaRow('新版本', newer
              ? (KIND_LABELS[newer.kind] || '条目') + ' · ' + String(newer.content || '').slice(0, 22)
              : '查看替代它的条目', function () {
                ctx.open('memory-detail', { charId: charId, memoryId: m.supersededBy });
              });
          }
          file.memories.filter(function (x) { return x.supersededBy === memoryId; })
            .forEach(function (o) {
              metaRow('替代了', (KIND_LABELS[o.kind] || '条目') + ' · ' + String(o.content || '').slice(0, 22), function () {
                ctx.open('memory-detail', { charId: charId, memoryId: o.id });
              });
            });
          metaRow('创建', fmtTime(m.createdAt));
          metaRow('最近更新', fmtTime(m.updatedAt));
        } else {
          metaRow('证据', EVID_LABELS[m.evidenceType] || m.evidenceType);
          metaRow('状态', STATUS_LABELS[m.status] || m.status);
          metaRow('最近更新', fmtTime(m.updatedAt));
        }
        body.appendChild(meta);

        /* 查看原文：定位到具体气泡（第三梯队 5）。
           新条目带 sourceChatId + sourceMessageId（总结引擎写入时回填的
           消息 id）；老条目只有 sourceRef 文案，回落到「打开那个对话」。 */
        if (!isU && (m.sourceMessageId || m.source === 'ai_summary')) {
          var srcBtn = h('button', 'lh-btn lh-btn-wide', '查看原文');
          srcBtn.type = 'button';
          srcBtn.addEventListener('click', function () {
            var chat = m.sourceChatId ? Sleepy.chatStore.getChat(m.sourceChatId) : null;
            if (chat) {
              ctx.open('chat-detail', { chatId: chat.id, focusMsgId: m.sourceMessageId || '' });
              return;
            }
            /* 双匹配：别把当前账号带进另一个身份的对话里 */
            var one = Sleepy.chatStore.chatOf(charId);
            if (one) {
              ctx.open('chat-detail', { chatId: one.id, focusMsgId: m.sourceMessageId || '' });
              return;
            }
            ctx.toast('找不到来源对话', 'warn');
          });
          body.appendChild(srcBtn);
        }

        /* 操作区 */
        var ops = h('div', 'lh-detail-ops');
        function op(label, run, kind) {
          var b = h('button', 'lh-btn' + (kind ? ' lh-btn-' + kind : ''), label);
          b.type = 'button';
          b.addEventListener('click', run);
          ops.appendChild(b);
        }
        if (!isU) {
          if (m.status === 'pending') {
            op('确认', function () {
              confirmMemoryItem(charId, memoryId);
              ctx.toast('已确认', 'ok'); ctx.rebuild();
            }, 'primary');
          }
          op('编辑内容', function () { enterEdit(); });
          if (m.status !== 'invalid') {
            op('标记错误', function () {
              ui.confirm({ title: '标记为错误？', note: '不再召回，但原始数据保留。', danger: true, ok: '标记' })
                .then(function (yes) {
                  if (!yes) return;
                  invalidateMemoryItem(charId, memoryId);
                  ctx.toast('已标记', 'ok'); ctx.rebuild();
                });
            }, 'danger');
          }
          op(m.isAnchor ? '取消锚定' : '永久锚定', function () {
            toggleAnchor(charId, memoryId);
            ctx.toast(m.isAnchor ? '已取消锚定' : '已锚定 · 注入时始终优先', 'ok');
            ctx.rebuild();
          });
          if (m.source === 'user_manual') {
            op('删除', function () {
              ui.confirm({ title: '删除这条记忆？', note: '只有自己添加的记忆可以物理删除。', danger: true, ok: '删除' })
                .then(function (yes) {
                  if (!yes) return;
                  if (deleteMemoryItem(charId, memoryId)) { ctx.toast('已删除', 'ok'); ctx.back(); }
                  else ctx.toast('这条不能物理删除', 'warn');
                });
            }, 'danger');
          }
        } else {
          if (m.status === 'active') {
            op('不再这样理解', function () {
              updateUnderstandingItem(charId, memoryId, { status: 'invalid' });
              ctx.toast('已归档', 'ok'); ctx.back();
            }, 'danger');
          }
        }
        body.appendChild(ops);
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      function fmtTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

})(window);
