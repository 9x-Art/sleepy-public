/* ============================================================
   book-core.js — 「以身入局」数据层（P0 第一刀）

   职责：档案盒 / 任务运行 / 岛级设置的读写，全部按岛章隔离。
   镜像 forum-core.js 的 scoping 口径：
   · 读 scoped(key, sid) —— 只返回该岛的记录；
   · 写 tagScope 盖章 + 对全量数组改完整体 set 回去；
   · 映射键 getMap/setMap（键名 bookSettingsBySandbox，值按 sbId 切）。

   红线（方案 §8.3）：以身入局的记忆只存本文件的键——
   不写进 char 的角色记忆、不进 memory-vec、不进聊天上下文。

   档案盒 status：empty（未开工）/ ongoing（进行中）/ closed（已结案）/ sealed（封存）。
   身份 identity：boss-watch（老板·纯看）/ boss-join（老板·亲自参与）/ staff（员工）。
   进局即锁死（§8.1），所以 identity 存在任务运行上，大厅选的是「下一局身份」。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;
  var store = Sleepy.store;

  var BOOK_KEYS = ['bookBoxes', 'bookRuns', 'bookImports'];
  var BOOK_MAP_KEYS = ['bookSettingsBySandbox'];

  var lockedSandboxId = null;
  function lockSandbox(sid) { lockedSandboxId = sid || null; }

  function scoped(key, sandboxId) {
    if (BOOK_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的键 ' + key);
    var all = store.get(key) || [];
    var sid = sandboxId || lockedSandboxId;
    if (!sid) return all;
    return all.filter(function (r) { return r && r.sandboxId === sid; });
  }

  function put(key, allRecords) {
    if (BOOK_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的键 ' + key);
    store.set(key, allRecords);
  }

  function tagScope(rec, sandboxId) {
    return core.tagScope(rec, sandboxId || lockedSandboxId || undefined);
  }

  function getMap(key, sandboxId) {
    if (BOOK_MAP_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的映射键 ' + key);
    var map = store.get(key) || {};
    var sid = sandboxId || lockedSandboxId;
    return sid ? (map[sid] || null) : null;
  }

  function setMap(key, sandboxId, value) {
    if (BOOK_MAP_KEYS.indexOf(key) < 0) throw new Error('book: 未登记的映射键 ' + key);
    if (!sandboxId) throw new Error('book: setMap 必须带 sandboxId');
    var map = store.get(key) || {};
    map[sandboxId] = JSON.parse(JSON.stringify(value));
    store.set(key, map);
  }

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 档案盒 ---------- */

  /* P0 口径（方案 §7.2）：正式架不放内容——留一个「待上架」占位盒；
     另给一个「局内演练」盒（演练戳、可进、可删）专供联调与验收。 */
  var DRILL_BOX_ID = 'book-box-drill';

  function ensureBoxes(sandboxId) {
    if (!sandboxId) throw new Error('book: ensureBoxes 必须带 sandboxId');
    var all = store.get('bookBoxes') || [];
    var mine = all.filter(function (r) { return r && r.sandboxId === sandboxId; });
    var dirty = false;
    var now = new Date().toISOString();

    function addBox(rec) {
      var exists = mine.some(function (b) { return b.stamp === rec.stamp && b.title === rec.title; });
      if (exists) return;
      all.push(tagScope(rec, sandboxId));
      mine.push(rec);
      dirty = true;
    }

    addBox({
      id: uid('book-box'),
      title: '待上架的世界',
      source: 'builtin', status: 'empty', stamp: '待上架', enterable: false,
      note: '世界包定稿后上架。', coverRef: null,
      createdAt: now, updatedAt: now
    });
    addBox({
      id: DRILL_BOX_ID,
      title: '局内演练',
      source: 'drill', status: 'empty', stamp: '演练', enterable: true,
      note: '专供联调与验收，随时可撤架。', coverRef: null,
      createdAt: now, updatedAt: now
    });

    if (dirty) store.set('bookBoxes', all);
    return scoped('bookBoxes', sandboxId);
  }

  function getBox(boxId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return scoped('bookBoxes', sid).filter(function (b) { return b.id === boxId; })[0] || null;
  }

  /* ---------- 运行（任务） ---------- */

  /* 身份口径（用户 2026-10-09 晚）：**每个世界定一次身份就锁死**——
     建档时把 identity 刻进档案盒，之后这个世界的所有运行都用它；
     大厅的「下一局身份」只是默认值，别的世界建档时仍可换。 */
  function startRun(boxId, identity, seat) {
    if (!lockedSandboxId) throw new Error('book: startRun 必须先 lockSandbox');
    var all = store.get('bookBoxes') || [];
    var box = null;
    all.forEach(function (b) {
      if (b && b.sandboxId === lockedSandboxId && b.id === boxId) box = b;
    });
    if (!box) throw new Error('book: 找不到档案盒 ' + boxId);
    if (!box.enterable) throw new Error('book: 不可进入的盒子');
    var hit = IDENTITIES.filter(function (x) { return x.key === identity; })[0];
    if (!hit) throw new Error('book: 未知身份 ' + identity);
    if (box.identity && box.identity !== identity) {
      throw new Error('book: 这个世界已定过身份（' + box.identity + '），不可再改');
    }
    if (box.status === 'ongoing') {
      var running = scoped('bookRuns', lockedSandboxId)
        .filter(function (r) { return r.boxId === boxId && r.status === 'ongoing'; })[0];
      if (running) return { run: running, existed: true };
    }

    var now = new Date().toISOString();
    /* v221：导入世界（source:'txt'）的运行记录带改动账本与 NPC 当前态；
       chapterIdx 按委托指定的起始章对齐。 */
    var worldKey = 'drill';
    var chapterIdx = 0;
    if (box.source === 'txt') {
      worldKey = 'txt:' + boxId;
      var imp = (store.get('bookImports') || []).filter(function (r) {
        return r && r.sandboxId === lockedSandboxId && r.id === box.importId;
      })[0];
      if (imp && box.commission && box.commission.startChapter) {
        var ci = (imp.chapters || []).findIndex(function (c) {
          return c.title === box.commission.startChapter;
        });
        if (ci >= 0) chapterIdx = ci;
      }
    }
    box.identity = identity;          /* 刻死 */
    box.status = 'ongoing';
    box.updatedAt = now;
    store.set('bookBoxes', all);

    var runs = store.get('bookRuns') || [];
    var run = tagScope({
      id: uid('book-run'),
      boxId: boxId,
      identity: identity,             /* b 层：员工/老板（锁死） */
      seat: seat || null,             /* c 层：穿书占位身份 */
      status: 'ongoing',
      world: worldKey,
      chapterIdx: chapterIdx,         /* txt 世界：当前章下标（drill 恒 0） */
      divergences: [],                /* 改动账本（v221）：已发生的对原书的改变 */
      npcStates: {},                  /* NPC 当前态（v221）：判定写回，按名存 */
      anomaly: 0,                     /* 异常度（只升不降） */
      progress: 0,                    /* 章节进度 % */
      logs: [],                       /* 行动日志（行动轮/在场轮共用） */
      volume: { chapters: [], notes: [] },  /* 卷宗（分栏，§9.3） */
      startedAt: now, endedAt: null
    }, lockedSandboxId);
    runs.push(run);
    store.set('bookRuns', runs);
    return { run: run, existed: false };
  }

  function getRunByBox(boxId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    var runs = scoped('bookRuns', sid)
      .filter(function (r) { return r.boxId === boxId && r.status === 'ongoing'; });
    return runs.length ? runs[runs.length - 1] : null;
  }

  /* 不限状态取最近一条运行记录（结算封档后游玩页复显结算卡用） */
  function getLastRunByBox(boxId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    var runs = scoped('bookRuns', sid).filter(function (r) { return r.boxId === boxId; });
    return runs.length ? runs[runs.length - 1] : null;
  }

  /* 场景图（封面）：建档时贴，随时可换/可撕。mediaId 走 photos.pick 通道。 */
  function setCover(boxId, mediaId, sandboxId) {
    if (!lockedSandboxId && !sandboxId) throw new Error('book: setCover 必须带 sandboxId 或先 lockSandbox');
    var sid = sandboxId || lockedSandboxId;
    var all = store.get('bookBoxes') || [];
    var hit = false;
    all.forEach(function (b) {
      if (b && b.sandboxId === sid && b.id === boxId) {
        b.coverRef = mediaId || null;
        b.updatedAt = new Date().toISOString();
        hit = true;
      }
    });
    if (!hit) throw new Error('book: 找不到档案盒 ' + boxId);
    store.set('bookBoxes', all);
    return getBox(boxId, sid);
  }

  /* ★ v219 场景图多张（用户：故事是发展的，场景是动态的）：
     box.sceneRefs = [mediaId]（顺序即场景顺序），coverRef 永远同步成第一张
     —— 老代码（游玩页封面等）不用改。传 [] = 清空。 */
  function setScenes(boxId, mediaIds, sandboxId) {
    if (!lockedSandboxId && !sandboxId) throw new Error('book: setScenes 必须带 sandboxId 或先 lockSandbox');
    var sid = sandboxId || lockedSandboxId;
    var list = (Array.isArray(mediaIds) ? mediaIds : []).filter(function (x) { return !!x; });
    var all = store.get('bookBoxes') || [];
    var hit = false;
    all.forEach(function (b) {
      if (b && b.sandboxId === sid && b.id === boxId) {
        b.sceneRefs = list;
        b.coverRef = list[0] || null;
        b.updatedAt = new Date().toISOString();
        hit = true;
      }
    });
    if (!hit) throw new Error('book: 找不到档案盒 ' + boxId);
    store.set('bookBoxes', all);
    return getBox(boxId, sid);
  }

  /* ---------- TXT 导入（需求清单 §十 第一版） ----------
     user 导入自己的书 → 章节切分 → 选起始章 + 手动委托/扮演角色 → 上架成
     可进的档案盒。原始文本与章节落 bookImports（与盒 id 绑定，删盒不删文本，
     「重新上架」还能用）。第一版**不做**整本自动分析（需求清单 §十）——
     只有建档时一次轻量 AI 预读（提炼简介/主要人物，失败不阻塞）。 */
  function createBoxFromImport(sid, o) {
    if (!sid) throw new Error('book: createBoxFromImport 必须带 sandboxId');
    var now = new Date().toISOString();
    var rec = tagScope({
      id: uid('book-box'),
      title: String(o.title || '未命名世界').slice(0, 40),
      source: 'txt', status: 'empty', stamp: '导入', enterable: true,
      note: String(o.note || '').slice(0, 200),
      coverRef: null, sceneRefs: [],
      importId: o.importId || null,           /* bookImports 里的原始文本 */
      commission: o.commission || null,       /* { text, roleNote, startChapter } */
      summary: o.summary || null,             /* AI 预读 { brief, npcs, places } 或 null */
      createdAt: now, updatedAt: now
    }, sid);
    var all = store.get('bookBoxes') || [];
    all.push(rec);
    store.set('bookBoxes', all);
    return rec;
  }

  function putImport(rec) {
    var all = store.get('bookImports') || [];
    var idx = -1;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === rec.id) { idx = i; break; }
    }
    if (idx >= 0) all[idx] = rec; else all.push(rec);
    store.set('bookImports', all);
    return rec;
  }

  function getImport(importId, sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get('bookImports') || []).filter(function (r) {
      return r && r.id === importId && (!sid || r.sandboxId === sid);
    })[0] || null;
  }

  function listImports(sandboxId) {
    var sid = sandboxId || lockedSandboxId;
    return (store.get('bookImports') || []).filter(function (r) {
      return r && (!sid || r.sandboxId === sid);
    }).sort(function (a, b) { return b.createdAt < a.createdAt ? -1 : 1; });
  }

  /* ============================== 第三刀：入世轮核心 ============================== */

  /* 演练世界状态种子（世界数据批次会换成正式世界包；结构即协议 §一） */
  var DRILL_WORLD = {
    key: 'drill',
    title: '局内演练 · 雾港灯站',
    chapter: '第一章',
    place: '雾港灯站',
    brief: '海雾常年不散的小港。守灯人陈婆托人把一只邮包送上旧宅，谁也不知道旧宅里住着谁。',
    npcs: [
      { name: '陈婆', stance: '照本', fact: '守着灯站，等一封没寄出去的回信', known: '灯站的公开传闻、往来船只' }
    ]
  };

  /* 演练委托（单一出处：建档页与游玩页共用） */
  var DRILL_BRIEF = {
    requester: '守灯人 陈婆',
    requesterSecret: '表面愿望是把邮包送上旧宅；真愿望是确认旧宅里还有人等她回信。',
    publicGoal: '三天内把邮包交到旧宅收信人手里。',
    hiddenGoal: '弄清楚陈婆为什么不敢亲自去。',
    restriction: '不得向世界角色透露「局」的存在。',
    reward: '基础 30 能量点（结算批次入账）'
  };

  function getWorld(key) {
    return key === 'drill' ? DRILL_WORLD : null;
  }

  /* ---------- v221 · 导入世界（txt）适配层 ---------- */

  /* 组装 txt 世界的「当轮世界对象」：原事实 + 改动账本 + NPC 当前态。
     每轮现算（不落库），数据全部来自 box.summary（预读地图）、
     run.divergences（账本）、run.npcStates（判定写回）。 */
  function worldFor(box, run) {
    if (!run) return DRILL_WORLD;
    if (run.world === 'drill' || !box || box.source !== 'txt') {
      return getWorld(run.world) || DRILL_WORLD;
    }
    var imp = getImport(box.importId, box.sandboxId);
    var chapters = (imp && imp.chapters) || [];
    var idx = Math.max(0, Math.min(chapters.length - 1, run.chapterIdx || 0));
    var sum = box.summary || {};
    var dvs = run.divergences || [];
    var st = run.npcStates || {};
    var npcs = (sum.npcs || []).map(function (n) {
      var name = typeof n === 'string' ? n : (n.name || '?');
      var fact = typeof n === 'string' ? '' : (n.fact || '');
      var mine = dvs.filter(function (d) { return d && d.about === name; });
      return {
        name: name,
        role: typeof n === 'object' && n.role ? n.role : '',
        stance: st[name] || '原作进行时',
        fact: fact,
        /* 世界角色不知道「原剧情」，只知道自己经历过的事：
           原事实 + 被波及的改动，就是 TA 的全部记忆。 */
        known: fact + (mine.length ? '（此后发生：' + mine.map(function (d) { return d.change; }).join('；') + '）' : '')
      };
    });
    var chapter = chapters[idx] || { title: '起始', text: '' };
    return {
      key: run.world, _txt: true,
      title: box.title,
      chapter: chapter.title,
      place: (sum.places && sum.places[0]) || '书中世界',
      brief: sum.brief || box.note || '',
      npcs: npcs,
      nodes: sum.nodes || [],
      chapterText: String(chapter.text || ''),
      chapterTotal: chapters.length
    };
  }

  /* txt 判定扩展：改动账本 + NPC 当前态 + 章节推进（进度由程序按章算）。
     chapters 从 bookImports 取（调用方是 yr-play）。 */
  function applyTxtVerdict(run, v, box) {
    var changed = 0;
    (v.worldChanges || []).forEach(function (wc) {
      if (!wc || !wc.about || !wc.change) return;
      run.divergences = run.divergences || [];
      run.divergences.push({ about: String(wc.about).slice(0, 20),
        change: String(wc.change).slice(0, 120), at: (run.logs || []).length });
      changed++;
    });
    Object.keys(v.npcReactions || {}).forEach(function (name) {
      var s = String(v.npcReactions[name] || '').trim();
      if (!s) return;
      run.npcStates = run.npcStates || {};
      run.npcStates[String(name).slice(0, 20)] = s.slice(0, 60);
      changed++;
    });
    if (v.chapterReached) {
      var imp = getImport(box.importId, box.sandboxId);
      var chapters = (imp && imp.chapters) || [];
      var idx = -1;
      for (var i = 0; i < chapters.length; i++) {
        if (chapters[i].title === v.chapterReached) { idx = i; break; }
      }
      /* 只许向后推进（模型说「回到第 1 章」不算数） */
      if (idx > (run.chapterIdx || 0)) {
        run.chapterIdx = idx;
        run.progress = chapters.length
          ? Math.min(100, Math.round((idx + 1) / chapters.length * 100)) : run.progress;
        changed++;
      }
    }
    return changed;
  }

  /* 建档后补改档案盒（v221）：委托建议卡「采用」、预读补充等。
     白名单字段，防止把 status/identity 这类状态机字段从后门改掉。 */
  function patchBox(boxId, fields, sandboxId) {
    if (!lockedSandboxId && !sandboxId) throw new Error('book: patchBox 必须带 sandboxId 或先 lockSandbox');
    var sid = sandboxId || lockedSandboxId;
    var ALLOWED = ['commission', 'summary', 'note', 'sceneRefs', 'coverRef'];
    var all = store.get('bookBoxes') || [];
    var hit = false;
    all.forEach(function (b) {
      if (b && b.sandboxId === sid && b.id === boxId) {
        Object.keys(fields || {}).forEach(function (k) {
          if (ALLOWED.indexOf(k) >= 0) b[k] = fields[k];
        });
        b.updatedAt = new Date().toISOString();
        hit = true;
      }
    });
    if (!hit) throw new Error('book: 找不到档案盒 ' + boxId);
    store.set('bookBoxes', all);
    return getBox(boxId, sid);
  }

  /* 手动封禁（方案 v1.2 出口之四）：run 封存 + 盒盖「已封存」戳 → 第二层书架。 */
  function sealBox(boxId, reason) {
    if (!lockedSandboxId) throw new Error('book: sealBox 必须先 lockSandbox');
    var now = new Date().toISOString();
    var runs = store.get('bookRuns') || [];
    runs.forEach(function (r) {
      if (r && r.sandboxId === lockedSandboxId && r.boxId === boxId && r.status === 'ongoing') {
        r.status = 'sealed';
        r.endedAt = now;
        r.sealReason = String(reason || '').slice(0, 60);
      }
    });
    store.set('bookRuns', runs);
    var all = store.get('bookBoxes') || [];
    all.forEach(function (b) {
      if (b && b.sandboxId === lockedSandboxId && b.id === boxId) {
        b.status = 'sealed';
        b.stamp = '已封存';
        b.updatedAt = now;
      }
    });
    store.set('bookBoxes', all);
    return getBox(boxId, lockedSandboxId);
  }

  /* 每轮字数档 → 提示词要求 */
  var WORDS = { short: '不超过 180 字', standard: '300 字左右', long: '500 字左右' };

  /* 协议四块注入（方案 §5.1：一轮=一次调用，叙事与判定同往返）。
     input=null 表示行动轮（user 在局外观测，模型推进 char 行动）。 */
  function buildBookMessages(run, box, world, settings, input) {
    if (!run || !box) throw new Error('book: buildBookMessages 缺 run/box');
    world = world || DRILL_WORLD;
    settings = settings || {};
    var words = WORDS[settings.words] || WORDS.standard;
    var idn = IDENTITIES.filter(function (x) { return x.key === run.identity; })[0];
    var seat = run.seat || { name: '未定' };
    var isTxt = !!(world && world._txt);            /* v221：导入世界 */
    var commission = box.commission || {};
    var brief = isTxt ? {
      requester: commission.requester || '委托者（局外）',
      publicGoal: commission.text || '按档案员预读的建议执行',
      hiddenGoal: commission.hiddenGoal || '（委托者的真愿望在结算时才揭晓评价）',
      restriction: commission.restriction || '不得向世界角色透露「局」的存在'
    } : DRILL_BRIEF;
    var recent = (run.logs || []).slice(-3).map(function (l) { return l.text; });

    var system = [
      '你是「以身入局」的叙事者兼裁判。用第三人称写这个世界发生的事，',
      '不许替老板（user）决定言行。世界、规则与状态如下：',
      '',
      '【席位与身份】',
      '席位: ' + (idn ? idn.name : run.identity),
      '占位: ' + seat.name,
      '身份知情范围: ' + (seat.known || '该占位的公开见闻'),
      '身份不知情范围: ' + (seat.unknown || '内情、委托者真实身份、局的存在'),
      '',
      '【世界状态】',
      '世界: ' + world.title,
      '章节进度: ' + world.chapter + ' ' + (run.progress || 0) + '%',
      '异常度: ' + (run.anomaly || 0) + ' / 100（只升不降；60 触发身份作废）',
      '在场人物: ' + world.npcs.map(function (n) { return n.name + '(' + n.stance + ')'; }).join(', '),
      '',
      '【在场人物档案】'
    ].concat(world.npcs.length ? world.npcs.map(function (n) {
      return n.name + ' / 当前态: ' + n.stance + '\n  既定事实: ' + n.fact + '\n  原文声音: ' + (n.voice || n.known);
    }) : ['（预读没认出主要人物 —— 按当前章原文里出现的人物即兴立档，他们不知道任何「剧情以外」的事。）']);

    if (isTxt) {
      /* v221 四件套：原事实(档案) / 改动账本 / 当前章原文 / 前情(recent) */
      system = system.concat([
        '',
        '【这本书】（user 与 char 从书外来，任务是走进这个故事执行委托）',
        '这是《' + world.title + '》的第 ' + world.chapter + ' 章。你写的一切必须与下面的原文衔接：',
        '文风、人物口吻、既定事实以原文为准 —— 原文没写到的才由你续写。'
      ]);
      if (world.nodes && world.nodes.length) {
        system = system.concat(['', '【剧情地图】（预读的关键事件锚点）'].concat(
          world.nodes.map(function (n) {
            return '- ' + (n.at || '?') + '：' + (n.event || '') + (n.mutable === false ? '（原作固定）' : '（可被改变）');
          })));
      }
      var dvs = run.divergences || [];
      system = system.concat(['',
        '【已发生的改变】（改动账本 —— 世界已经变成这样，NPC 只知道经历过的事）',
        dvs.length ? dvs.map(function (d) { return '- 关于 ' + d.about + '：' + d.change; }).join('\n')
                   : '（还没有。你与委托就是要来改变这本书的 —— 改变是任务本体，放心写。）',
        '',
        '【世界角色铁律】世界里的所有人（包括与委托者同名的人，如果有）都不知道：',
        '原剧情的走向、「委托」的存在、你们来自世界之外。他们只知道自己经历过的事，',
        '行为从经历出发往后推。']);
      if (world.chapterText) {
        system = system.concat(['',
          '【当前章原文节选】',
          String(world.chapterText).slice(0, 2600) + (world.chapterText.length > 2600 ? '……' : '')]);
      }
    }

    system = system.concat([
      '',
      '【委托】委托者站在世界之外（相当于未来的某人委托你们回到过去），',
      '局中任何人都不知道委托的存在。明面目标: ' + brief.publicGoal +
        ' 暗线: ' + brief.hiddenGoal + ' 限制: ' + brief.restriction,
      recent.length ? '【前情】\n' + recent.join('\n') : '【前情】开局，尚未发生任何事。',
      '',
      '【输出格式】先写正文叙事（' + words + '），',
      '正文之后另起一行输出判定块，格式严格如下（无变化的行写「无」，不许省略行）：',
      '<判定>',
      '权限: 正常|擦边|越界 / 异常度 +N（N 为 0/1/3/6 的增量）'
    ]);
    if (isTxt) {
      system = system.concat([
        '改变: 无 | 关于:人物名 / 改变:一句话（这轮对原书造成的、会影响后续的改变；没有就写无）',
        '反应: 无 | 人物名 → 新当前态（一句话；哪些人物因为这轮的言行更新了态度/认知）',
        '推进: 无 | 章节标题（故事推进到的章节标题，必须与下面原文的章节名一致；没推进就写无）'
      ]);
    } else {
      system = system.concat([
        '进度: ' + world.chapter + ' X% → Y%'
      ]);
    }
    system = system.concat([
      '</判定>',
      '硬越界（提到局/原著/结局）一律记 +6 且当轮就有世界反应。'
    ]);

    var sealNotes = (run.interventions || []).filter(function (i) { return i && !i.used && i.text; });
    if (sealNotes.length) {
      system = system.concat([
        '',
        '【局印传话】（老板干预，来自局印，本轮必须体现；这是局对局内世界的暗手，不计异常度）'
      ].concat(sealNotes.map(function (i) { return '- ' + i.text; })));
    }

    var user = input
      ? '【本轮】user 以「' + (idn ? idn.name : run.identity) + '」的占位言行：\n' + input +
        '\n\n写出世界的回应（含在场人物反应），末尾按格式给判定块。'
      : '【本轮】user 在局外观测，没有出面。推进 ' +
        (run.charName || '局内员工') + ' 的行动与心理，末尾按格式给判定块。';

    return [
      { role: 'system', content: system.join('\n') },
      { role: 'user', content: user }
    ];
  }

  /* 剥判定块：正文与判定分开返回。没有判定块 = 判定全无变化（正文照收）。
     v221：txt 世界多解析「改变 / 反应 / 推进」三行（容错：有则给，无则空）。 */
  function parseVerdict(text) {
    var s = String(text || '');
    var m = s.match(/<判定>([\s\S]*?)(<\/判定>|$)/);
    var narrative = m ? s.slice(0, m.index).trim() : s.trim();
    var v = { narrative: narrative, anomalyDelta: 0, progress: null, verdictText: null,
      worldChanges: [], npcReactions: {}, chapterReached: null };
    if (!m) return v;
    v.verdictText = m[1].trim();
    var am = v.verdictText.match(/异常度\s*([+−-]?\s*\d+)/);
    if (am) {
      var n = parseInt(am[1].replace(/[−-]/, '-').replace(/\s/g, ''), 10);
      if (!isNaN(n) && n > 0) v.anomalyDelta = n;   /* 只升不降：负增量按 0 处理 */
    }
    var pm = v.verdictText.match(/→\s*(\d+)\s*%/);
    if (pm) {
      var p = parseInt(pm[1], 10);
      if (!isNaN(p)) v.progress = Math.max(0, Math.min(100, p));
    }
    /* 改变: 关于:名字 / 改变:内容 —— 容错两种写法（带「关于:」前缀或裸「名字 → 内容」） */
    var cm = v.verdictText.match(/改变[:：]\s*([^\n]+)/);
    if (cm && !/^\s*无\s*$/.test(cm[1])) {
      var seg = cm[1].split('/');
      if (seg.length >= 2) {
        var about = (seg[0].match(/关于[:：]?\s*(.*)/) || [])[1] || seg[0];
        v.worldChanges.push({ about: about.trim(), change: seg.slice(1).join('/').replace(/^\s*改变[:：]?\s*/, '').trim() });
      } else {
        var pair = cm[1].split(/→/);
        if (pair.length >= 2) v.worldChanges.push({ about: pair[0].trim(), change: pair.slice(1).join('→').trim() });
      }
    }
    /* 反应: 名字 → 新当前态（可多行） */
    var rre = /反应[:：]\s*([^\n→]+?)\s*→\s*([^\n]+)/g, rm;
    while ((rm = rre.exec(v.verdictText)) !== null) {
      if (/^\s*无\s*$/.test(rm[1])) continue;
      v.npcReactions[rm[1].trim()] = rm[2].trim();
    }
    /* 推进: 章节标题 */
    var gm = v.verdictText.match(/推进[:：]\s*([^\n]+)/);
    if (gm && !/^\s*无\s*$/.test(gm[1])) v.chapterReached = gm[1].trim();
    return v;
  }

  /* 写回：给 run 打补丁（调用方负责持久化）。返回新增的日志条目。 */
  function applyVerdict(run, v, input) {
    run.anomaly = Math.min(100, (run.anomaly || 0) + (v.anomalyDelta || 0));
    if (v.progress !== null && v.progress > (run.progress || 0)) run.progress = v.progress;
    var entry = {
      n: (run.logs || []).length + 1,
      at: new Date().toISOString(),
      input: input || null,
      text: v.narrative,
      anomalyDelta: v.anomalyDelta || 0,
      anomaly: run.anomaly,
      progress: run.progress || 0,
      verdictText: v.verdictText
    };
    run.logs = run.logs || [];
    run.logs.push(entry);
    return entry;
  }

  /* ---------- 3B：背包 / 局印干预 / 结算封档 ---------- */

  /* 背包（run.inventory）：实物态（世界内可见可用）与存档态（副本，世界内不存在）分区。
     boss-join/staff 是 user 自己的背包；boss-watch 看的是 char 的背包（只读，由局印发道具写入）。 */
  function addInventoryItem(run, name, state, note) {
    if (!run) throw new Error('book: addInventoryItem 缺 run');
    if (['real', 'archived'].indexOf(state) < 0) throw new Error('book: 未知背包态 ' + state);
    run.inventory = run.inventory || [];
    var item = { id: uid('inv'), name: String(name || '').trim(), state: state, note: note || null, at: new Date().toISOString() };
    if (!item.name) throw new Error('book: 物件名不能为空');
    run.inventory.push(item);
    return item;
  }

  /* 局印干预：不单独调用，写进 run.interventions（未 used）等下一轮消费（方案 §5.1/§六-3）。 */
  function addIntervention(run, text) {
    if (!run) throw new Error('book: addIntervention 缺 run');
    var t = String(text || '').trim();
    if (!t) throw new Error('book: 传话不能为空');
    run.interventions = run.interventions || [];
    var item = { id: uid('seal'), text: t, at: new Date().toISOString(), used: false };
    run.interventions.push(item);
    return item;
  }

  function pendingInterventions(run) {
    return ((run && run.interventions) || []).filter(function (i) { return i && !i.used; });
  }

  /* 消费：一轮成功后把所有未读传话标记已用（调用方负责持久化）。 */
  function consumeInterventions(run) {
    var n = 0;
    (run.interventions || []).forEach(function (i) {
      if (i && !i.used) { i.used = true; n++; }
    });
    return n;
  }

  /* 结算分数：状态机按记录算，不信模型现编数（方案 §5.1）。
     完成度=进度；规则遵守=100-异常度；能量点=基础 30 按完成度折算+实物物件每件 +2。 */
  var BASE_ENERGY = 30;
  function settleScores(run) {
    var completion = Math.max(0, Math.min(100, run.progress || 0));
    var compliance = Math.max(0, 100 - (run.anomaly || 0));
    var items = ((run.inventory || []).filter(function (i) { return i.state === 'real'; })).length;
    return {
      completion: completion,
      compliance: compliance,
      energy: Math.round(BASE_ENERGY * completion / 100) + items * 2,
      realItems: items
    };
  }

  /* 结算封档：run.status='ended' + settlement 落库；档案盒 closed + 已结案戳。
     narrative 可以是模型生成的结算叙述，也可以是 null（跳过叙述直接封档）。 */
  function finishRun(boxId, narrative) {
    if (!lockedSandboxId) throw new Error('book: finishRun 必须先 lockSandbox');
    var run = getRunByBox(boxId, lockedSandboxId);
    if (!run) throw new Error('book: 没有进行中的运行可结算');
    var now = new Date().toISOString();
    run.status = 'ended';
    run.endedAt = now;
    run.settlement = { scores: settleScores(run), narrative: narrative || null, at: now };
    /* run 是深拷贝，必须整表落库，否则 store 里还挂着一条 ongoing */
    var runs = store.get('bookRuns') || [];
    runs.forEach(function (r, i) {
      if (r && r.id === run.id) runs[i] = run;
    });
    store.set('bookRuns', runs);

    var all = store.get('bookBoxes') || [];
    all.forEach(function (b) {
      if (b && b.sandboxId === lockedSandboxId && b.id === boxId) {
        b.status = 'closed';
        b.stamp = '已结案';
        b.updatedAt = now;
      }
    });
    store.set('bookBoxes', all);
    return run;
  }

  /* ---------- 身份（下一局身份；进局建档时抄到运行记录上锁死） ---------- */

  var IDENTITIES = [
    { key: 'boss-watch', name: '老板 · 纯看', desc: '派 char 进世界执行委托，你在局外看 TA 的对白与心理，用局印干预。' },
    { key: 'boss-join', name: '老板 · 亲自参与', desc: '局印特权在手，亲自入局陪同 char 完成委托。' },
    { key: 'staff', name: '员工', desc: '你自己入局执行任务，char 按局内关系同行或留守。局印认老板，不认你。' }
  ];

  function getIdentity(sandboxId) {
    var s = getMap('bookSettingsBySandbox', sandboxId) || {};
    return s.identity || null;
  }

  function setIdentity(sandboxId, key) {
    var hit = IDENTITIES.filter(function (x) { return x.key === key; })[0];
    if (!hit) throw new Error('book: 未知身份 ' + key);
    var s = getMap('bookSettingsBySandbox', sandboxId) || {};
    s.identity = key;
    setMap('bookSettingsBySandbox', sandboxId, s);
  }

  /* ---------- 对外 ---------- */

  Sleepy.book = {
    lockSandbox: lockSandbox,
    scoped: scoped,
    put: put,
    tagScope: tagScope,
    getMap: getMap,
    setMap: setMap,
    uid: uid,
    ensureBoxes: ensureBoxes,
    getBox: getBox,
    startRun: startRun,
    getRunByBox: getRunByBox,
    getLastRunByBox: getLastRunByBox,
    setCover: setCover,
    setScenes: setScenes,
    createBoxFromImport: createBoxFromImport,
    putImport: putImport,
    getImport: getImport,
    listImports: listImports,
    worldFor: worldFor,
    applyTxtVerdict: applyTxtVerdict,
    patchBox: patchBox,
    sealBox: sealBox,
    DRILL_WORLD: DRILL_WORLD,
    DRILL_BRIEF: DRILL_BRIEF,
    getWorld: getWorld,
    WORDS: WORDS,
    buildBookMessages: buildBookMessages,
    parseVerdict: parseVerdict,
    applyVerdict: applyVerdict,
    addInventoryItem: addInventoryItem,
    addIntervention: addIntervention,
    pendingInterventions: pendingInterventions,
    consumeInterventions: consumeInterventions,
    settleScores: settleScores,
    finishRun: finishRun,
    DRILL_BOX_ID: DRILL_BOX_ID,
    IDENTITIES: IDENTITIES,
    getIdentity: getIdentity,
    setIdentity: setIdentity
  };
})(window);
