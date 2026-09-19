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
           isAnchor 注入时不受 maxItems 限制；关了开关注入为空但数据保留。

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

  function islandRaw() {
    return store.get('memoryIsland') || { name: '星屿', type: 'solo', byChar: {} };
  }
  function charConfig(charId) {
    var raw = islandRaw();
    var c = raw.byChar && raw.byChar[charId];
    var isNpc = charId.indexOf('npc') === 0;
    return {
      charId: charId,
      enabled: c ? c.enabled !== false : !isNpc,   /* 主角默认开，NPC 默认关 */
      level: (c && c.level) || (isNpc ? 'off' : 'full'),
      updatedAt: (c && c.updatedAt) || nowIso()
    };
  }
  function setCharConfig(charId, patch) {
    var raw = islandRaw();
    raw.byChar = raw.byChar || {};
    raw.byChar[charId] = raw.byChar[charId] || {};
    Object.keys(patch).forEach(function (k) { raw.byChar[charId][k] = patch[k]; });
    raw.byChar[charId].updatedAt = nowIso();
    store.set('memoryIsland', raw);
  }

  function charMemKey(charId) { return 'charMem:' + charId; }
  function loadCharMemory(charId) {
    return store.get(charMemKey(charId)) || {
      version: '1', charId: charId, updatedAt: nowIso(),
      understandings: [], memories: []
    };
  }
  function saveCharMemory(file) {
    file.updatedAt = nowIso();
    store.set(charMemKey(file.charId), file);
    syncIsland(file.charId);
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
       范围 = 当前岛的主要角色 + 岛内全体 NPC：
       新 NPC 归属整座岛（parentType='sandbox'）；老数据挂 char/user 名下的照收，
       兼容不丢。没降落在任何岛上时回落老行为（全部主要角色）。 */
    var sb = coreO.activeSandbox();
    var me = coreO.activeUser ? coreO.activeUser() : null;
    var islandName = '';
    try { if (Sleepy.island && sb) islandName = Sleepy.island.roomTitle(sb); } catch (e) { /* 忽略 */ }
    function npcTag(n) { return (n.content || '').split('\n')[0].slice(0, 16) || 'NPC'; }
    function sameIsland(c) { return !c.sandboxId || !sb || c.sandboxId === sb.id; }
    if (sb) {
      (coreO.charsOfSandbox(sb) || []).forEach(function (m) {
        pushChar(m, false, '');
        (coreO.npcChars(m.id) || []).forEach(function (n) {
          if (!sameIsland(n)) return;
          pushChar(n, true, npcTag(n));
        });
      });
      (coreO.allChars() || []).forEach(function (c) {
        if (c.kind !== 'npc') return;
        if (c.parentType === 'sandbox' && c.parentId === sb.id) pushChar(c, true, npcTag(c));
      });
      if (me) {
        (coreO.userNpcs(me.id) || []).forEach(function (n) {
          if (!sameIsland(n)) return;
          pushChar(n, true, npcTag(n));
        });
      }
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
  }

  function addMemoryItem(charId, item) {
    var file = loadCharMemory(charId);
    var m = {
      id: newId('mem'), charId: charId,
      kind: item.kind || 'custom',
      content: String(item.content || '').trim(),
      source: 'user_manual', sourceRef: '用户手动添加',
      evidenceType: 'user_explicit', status: 'active',
      isAnchor: false, isUserEdited: true,
      createdAt: nowIso(), updatedAt: nowIso()
    };
    file.memories.unshift(m);
    saveCharMemory(file);
    return m;
  }

  function deleteMemoryItem(charId, memoryId) {
    var file = loadCharMemory(charId);
    var m = findMemory(file, memoryId);
    /* 只有 user_manual 能物理删除；其他来源只能标 invalid */
    if (!m || m.source !== 'user_manual') return false;
    file.memories = file.memories.filter(function (x) { return x.id !== memoryId; });
    saveCharMemory(file);
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
    file.memories.forEach(function (m) {
      if (want[m.id] && m.status === 'pending') {
        m.status = 'active';
        m.updatedAt = nowIso();
        n++;
      }
    });
    if (n) saveCharMemory(file);
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

  function getMemoryInjection(charId, options) {
    options = options || {};
    var cfg = charConfig(charId);
    if (!cfg.enabled) return '';                 /* 关了开关：注入为空，数据保留 */
    var file = loadCharMemory(charId);
    var active = file.memories.filter(function (m) { return m.status === 'active'; });
    if (!active.length && !file.understandings.length) return '';

    /* 优先级：isAnchor（不受 maxItems 限制）> boundary > correction > 近期 active */
    var maxItems = options.maxItems || 6;
    var anchors = active.filter(function (m) { return m.isAnchor; });
    var picked = anchors.slice();
    function pushKind(kind, n) {
      active.filter(function (m) { return m.kind === kind && picked.indexOf(m) < 0; })
        .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })
        .slice(0, n)
        .forEach(function (m) { picked.push(m); });
    }
    pushKind('boundary', 3);
    pushKind('correction', 3);
    active.filter(function (m) { return picked.indexOf(m) < 0; })
      .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })
      .slice(0, Math.max(0, maxItems - picked.length))
      .forEach(function (m) { picked.push(m); });

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
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.memoryStore = {
    loadIsland: loadIsland,
    loadCharMemory: loadCharMemory,
    updateMemoryItem: updateMemoryItem,
    addMemoryItem: addMemoryItem,
    deleteMemoryItem: deleteMemoryItem,
    confirmMemoryItem: confirmMemoryItem,
    confirmMemoryItems: confirmMemoryItems,
    invalidateMemoryItem: invalidateMemoryItem,
    toggleAnchor: toggleAnchor,
    updateUnderstandingItem: updateUnderstandingItem,
    updateMemoryConfig: updateMemoryConfig,
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
            var chats = Sleepy.chatStore.getChats();
            for (var i = 0; i < chats.length; i++) {
              if (chats[i].characterId === charId) {
                ctx.open('chat-detail', { chatId: chats[i].id, focusMsgId: m.sourceMessageId || '' });
                return;
              }
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
