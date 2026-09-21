/* ============================================================
   phone.js · 查手机数据层（Sleepy.phone）

   《施工卡-查手机-v1》第 1 批。所有表 scoped 到 sandboxId（=岛），
   删房清理名单在 core.removeSandbox（本次已同步加进去）。

   三条铁律（总纲 v1 §17，写代码前再读一遍）：
   ① 展示给 user 的内容 = 世界事实，落库 confirmed，永不被重生成覆盖；
   ② 知道密码 / 获得允许 / 成功进入 是三个独立字段，绝不合并成一个布尔；
   ③ char 只能凭合理可见的痕迹察觉，系统知道 ≠ char 知道。

   API 预算：本文件里没有任何模型调用 —— 建壳、授权判定、痕迹、
   风险推进全是本地规则（架构 v1 §0.1「打开 App 默认 0 次生成 API」）。
   模型调用（phone_delta / phone_life_settlement / phone_bootstrap）
   属第 2 批，统一走领域服务 + 闸门 + 队列，UI 永远不直接调模型。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var tagScope = core.tagScope;

  /* core 只导出了 scoped/tagScope，arr 是内部函数 —— 这里自己备一份 */
  function arr(v) { return Array.isArray(v) ? v : []; }

  /* 查手机相关的 store 键。删房时跟着清 —— 这串必须和
     core.removeSandbox 里的 scoped 名单保持一致（漏一个就是幽灵数据）。 */
  var PHONE_KEYS = ['phones', 'phonePerms', 'phoneSessions', 'phoneTraces',
    'phonePlans', 'phoneMsgs', 'phoneNotes', 'phoneBrowser', 'phoneShop',
    'phoneHealth'];

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------------------------- 表读写 ---------------------------- */
  /* 模式与 chats/photos 相同：写入 = 全量取出、改完整表落盘；
     读取 = core.scoped 过滤当前房。绝不能把 scoped 结果 set 回去。 */

  function load(key) { return arr(store.get(key)); }
  function save(key, list) { store.set(key, list); }

  function pick(key, filter) {
    var sid = core.scopeId();
    return load(key).filter(function (r) {
      if (!r) return false;
      if (sid && r.sandboxId !== sid) return false;
      return filter ? filter(r) : true;
    });
  }

  function insert(key, rec) {
    var list = load(key);
    list.push(tagScope(rec));
    save(key, list);
    return rec;
  }

  function patch(key, id, fields) {
    var list = load(key);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) {
        Object.keys(fields || {}).forEach(function (k) { list[i][k] = fields[k]; });
        save(key, list);
        return list[i];
      }
    }
    return null;
  }

  /* ---------------------------- 手机壳 ---------------------------- */

  /* 壁纸 / 强调色 / App 排列从 charId 哈希派生 ——
     同一个 char 每次进来都一样（持续存在），不同 char 不千人一面。
     色板全部暖调，遵守项目审美规则：不要蓝。 */
  var WALLS = [
    { bg: '#F3EBDD', deep: '#E7DBC5', name: '奶油' },
    { bg: '#F6E3DA', deep: '#EED2C4', name: '蜜桃' },
    { bg: '#EFD9D4', deep: '#E5C6BE', name: '豆沙' },
    { bg: '#E9E9E2', deep: '#DBDCD1', name: '米灰' },
    { bg: '#EFEADF', deep: '#E2D9C9', name: '亚麻' }
  ];
  var ACCENTS = ['#B08A5E', '#B4766B', '#8F9B7A', '#A98AA8', '#C08A52'];

  /* 字符串 → 稳定正整数。用来派生壁纸/排列/密码，别用 Math.random ——
     那样每次刷新手机就换一张脸，违反「持续存在」。 */
  function hashOf(str) {
    var h = 5381;
    var s = String(str || '');
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }

  function phoneOf(sbId, charId) {
    return pick('phones', function (p) {
      return p.charId === charId && (!sbId || p.sandboxId === sbId);
    })[0] || null;
  }

  /* 锁屏密码的派生（分流定案 §E）：优先用**这座岛落成的日子**（MMDD）——
     那是 user 合理知道的关系事实，「试试你们的日子」的候选玩法才有意义。
     没有建档时间的极端情况才退回哈希随机。
     ⚠️ 无符号移位：>> 会把 ≥2^31 的哈希变成负数 → 三位数密码（冒烟抓过）。 */
  function derivePin(sbId, h) {
    var sbRec = core.findSandbox(sbId);
    if (sbRec && sbRec.createdAt) {
      var d0 = new Date(sbRec.createdAt);
      return ('0' + (d0.getMonth() + 1)).slice(-2) + ('0' + d0.getDate()).slice(-2);
    }
    return String(1000 + ((h >>> 3) % 9000));
  }

  /* 「他到底有没有给手机上锁」的**唯一判据**。页面里别自己拼
     （`rec.lock && rec.lock.pin` 那种写法是没意义的 —— pin 一直是派生好的，
     以前正是因为它恒真，才出现「角色明明没设密码，却要你输密码」）。
     ⚠️ 老存档只有 pin、没有 enabled，这里按「没设锁」解释（!!undefined = false），
     所以那个现象对老存档也会自动消失；用户在设置里把开关打开时 pin 现成可用。 */
  function lockEnabled(rec) {
    return !!(rec && rec.lock && rec.lock.enabled && rec.lock.pin);
  }

  /* 改「他有没有上锁」。打开的时候保证 pin 一定存在 ——
     否则会造出「有锁却没有密码」的死状态（猜也猜不中）。 */
  function setLockEnabled(rec, on) {
    if (!rec) return null;
    if (!rec.lock) rec.lock = {};
    if (on) {
      if (!rec.lock.pin) {
        var sid = core.scopeId();
        rec.lock.pin = derivePin(sid, hashOf(sid + ':' + rec.charId));
      }
      rec.lock.enabled = true;
    } else {
      rec.lock.enabled = false;
    }
    savePhone(rec);
    return rec;
  }

  /* 建壳：0 次 API、幂等。密码也由哈希派生 —— user 可以真的猜中，
     「猜中」这个事件本身会成为关系事实（knownPin 置真）。
     ⚠️ pin 是**派生好的备着**，不代表他上了锁：上没上锁只看 lock.enabled
     （见 lockEnabled）。2026-09-21 用户报的「没设密码却被要求输密码」就是
     把「pin 存在」当成了「有锁」。 */
  function ensurePhone(sbId, charId) {
    var hit = phoneOf(sbId, charId);
    if (hit) return hit;
    var h = hashOf(sbId + ':' + charId);
    /* 桌面上的 App 排列。**日历不在里面** ——
       2026-09-19 用户拍板：日历是桌面上的一个独立 App（第 3 屏），
       不是查手机里翻到的那一个，所以这里的日历撤掉了（相册暂时留着）。
       ⚠️ 老存档的 phones.appOrder 里可能还有 'calendar'，page-phone 渲染时
       会按这张表过滤掉它 —— 不改这里的话删记录的写法也得跟着动，别偷懒。 */
    var order = ['messages', 'taobao', 'health', 'notes', 'browser', 'gallery'];
    /* 排列微调：把第 0 个和第 h%len 个对调，制造「他习惯把常用的放别处」 */
    var k = h % order.length;
    var tmp = order[0]; order[0] = order[k]; order[k] = tmp;
    return insert('phones', {
      id: 'ph_' + newId(),
      charId: charId,
      wallpaper: h % WALLS.length,
      accent: ACCENTS[h % ACCENTS.length],
      appOrder: order,
      /* enabled = 他到底给不给手机上锁。**默认 false** ——
         用户 2026-09-21 原话：「角色本身没有设置密码，但界面仍然显示输入密码解锁」。
         现在「设不设密码」是角色设置里一个明确的开关（聊天 → 角色设置 → 他的手机），
         没打开就是真的没密码：锁屏那一屏照样在（「打开通知」只在这屏存在），
         但不会有任何要你输密码的入口。 */
      lock: { enabled: false, pin: derivePin(sbId, h) },
      knownPin: false,
      lastExitedAt: null,
      bootstrapStatus: 'none',
      bootstrapVersion: 0,
      settledUntil: null,
      createdAt: Date.now()
    });
  }

  function getPhone(phoneId) {
    return pick('phones', function (p) { return p.id === phoneId; })[0] || null;
  }

  function savePhone(phone) {
    patch('phones', phone.id, phone);
  }

  /* ---------------------------- 授权 ----------------------------
     scope: 'all' | 'app:<appType>' | 'item:<itemId>'
     mode:  'once' | 'timed' | 'long'
     state: 'open' | 'hidden'（暂时隐藏：为具体事件保密）
            | 'revoked'（正式收回） | 'expired'
     hidden 和 revoked 的关系含义不同（总纲 §9），数据上分开存。 */

  function activePerms(phoneId, now) {
    var t = now || Date.now();
    return pick('phonePerms', function (p) {
      return p.phoneId === phoneId && p.state === 'open' &&
        (!p.expireAt || p.expireAt > t);
    });
  }

  /* 长期权限（有效 open 且未过期）。整机 or 覆盖指定 app。 */
  function longPermFor(phoneId, appType) {
    return activePerms(phoneId).filter(function (p) {
      return p.mode === 'long' &&
        (p.scope === 'all' || p.scope === 'app:' + appType);
    })[0] || null;
  }

  function grantPerm(phoneId, o) {
    return insert('phonePerms', {
      id: 'pm_' + newId(),
      phoneId: phoneId,
      charId: o.charId,
      scope: o.scope || 'all',
      mode: o.mode || 'long',
      state: 'open',
      reason: o.reason || '',
      expireAt: o.expireAt || null,
      createdAt: Date.now()
    });
  }

  /* 暂时隐藏 / 正式收回 / 恢复：都是权限记录的状态迁移，不是删除。 */
  function setPermState(permId, state, reason) {
    var p = patch('phonePerms', permId, { state: state, reason: reason || '' });
    if (p) { p.updatedAt = Date.now(); }
    return p;
  }

  /* 按 scope 改权限（模型只知道范围，不知道权限记录 id）。
     同 scope 有多条时改最新的那条；找不到返回 null（没有授权就别凭空造状态）。 */
  function setPermByScope(phoneId, o) {
    var hit = pick('phonePerms', function (p) {
      return p.phoneId === phoneId && (p.scope || 'all') === (o.scope || 'all');
    }).sort(function (a, b) { return b.createdAt - a.createdAt; })[0];
    if (!hit) return null;
    return setPermState(hit.id, o.state, o.note);
  }

  /* 暂时隐藏 / 正式收回的权限 → 桌面上被锁起来的 App（总纲 §9/§11）。
     「暂时隐藏」是权限状态迁移，不是删数据：入口照常出现在桌面，但打不开。
     返回 { apps:['all'|appType], reason } —— reason 是 char 自己给的说法。 */
  function hiddenApps(phoneId) {
    var out = { apps: [], reason: '' };
    pick('phonePerms', function (p) { return p.phoneId === phoneId; }).forEach(function (p) {
      if (p.state === 'revoked') return;       /* 正式收回 = 权限没了，另有路径 */
      if (p.state !== 'hidden') return;
      if (p.mode !== 'long' && p.mode !== 'timed') return;
      if (p.expireAt && p.expireAt <= Date.now()) return;
      if (p.scope === 'all') { out.apps = ['all']; out.reason = p.reason || ''; return; }
      if (p.scope.indexOf('app:') === 0) {
        var a = p.scope.slice(4);
        if (out.apps.indexOf('all') >= 0) return;
        if (out.apps.indexOf(a) < 0) out.apps.push(a);
        if (!out.reason) out.reason = p.reason || '';
      }
    });
    return out;
  }

  /* ---------------------------- 进入会话 ----------------------------
     accessContext（总纲 §二·五）：入口类型、是否授权、解锁方式、
     行动消耗、风险阶段、是否当场被抓 —— 一次进入一条记录。 */

  var ENTRY_META = {
    peek:     { authorized: false, label: '偷看' },
    invite:   { authorized: true,  label: '他请你看的' },
    longterm: { authorized: true,  label: '长期授权' }
  };

  function startSession(phone, entryType, unlockMethod) {
    var meta = ENTRY_META[entryType] || ENTRY_META.peek;
    var s = insert('phoneSessions', {
      id: 'ps_' + newId(),
      phoneId: phone.id,
      charId: phone.charId,
      entryType: entryType,
      authorized: !!meta.authorized,
      unlockMethod: unlockMethod || null,
      pinFails: 0,
      actionsSpent: 0,
      riskStage: 0,
      caughtOnScene: false,
      lastAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null
    });
    return s;
  }

  function getSession(id) {
    return pick('phoneSessions', function (s) { return s.id === id; })[0] || null;
  }

  function endSession(id, how) {
    var s = getSession(id);
    if (!s) return null;
    patch('phoneSessions', id, {
      endedAt: Date.now(),
      endedHow: how || 'putback',
      caughtOnScene: !!s.caughtOnScene
    });
    var ph = getPhone(s.phoneId);
    if (ph) { ph.lastExitedAt = Date.now(); savePhone(ph); }
    return getSession(id);
  }

  /* ---------------------------- 痕迹 ----------------------------
     detectable=true 的痕迹是「char 有可能事后发现」的候选；
     发现时机（触发条件 + detectedAt）第 2 批结算接，先如实记账。 */

  function addTrace(session, o) {
    if (!session) return null;
    return insert('phoneTraces', {
      id: 'pt_' + newId(),
      sessionId: session.id,
      phoneId: session.phoneId,
      charId: session.charId,
      app: o.app || null,
      type: o.type,              /* read/recent/pin_fail/location/misclick */
      detail: o.detail || '',
      at: Date.now(),
      detectable: o.detectable !== false,
      detectedAt: null
    });
  }

  function tracesOf(sessionId) {
    return pick('phoneTraces', function (t) { return t.sessionId === sessionId; });
  }

  /* ---------------------------- 行动 / 风险 ----------------------------
     正式原则（分流定案 §四）：行动消耗解释风险为什么上升；
     少量概率保留不可预测性；痕迹支持事后发现。 */

  /* 动作的基础消耗。查看越深、越敏感，消耗越大。
     openNotice = 从锁屏打开一条通知（清单 §行动消耗里点名的「打开通知」）。 */
  var ACTION_COST = {
    wake: 1, openNotice: 1, openApp: 1, openChat: 1, deepScroll: 1,
    openDerived: 2, openDraft: 2, pinTry: 1
  };

  /* 环境提示按阶段推：沉浸、克制，不做红色警告（总纲 §14）。 */
  var STAGE_HINTS = [
    '',
    '门外很安静。',
    '走廊里好像有动静。',
    '有脚步声，正在靠近。',
    '门把手轻轻响了一下。'
  ];

  /* 离开时长 → 允许消耗的行动基准。超过基准，风险阶段开始爬。
     两条线取高的那条：
       · 行动消耗（分流定案 §四：解释风险为什么上升）
       · 密码失败次数（§E：失败越多风险越高 —— 1 次就起一档，3 次到顶）
     都没有「第 N 次必抓」——抓到与否仍由 maybeCaught 的概率决定。 */
  function stageOf(session) {
    var budget = (session.absenceMin || 30) * 0.35 + 2;
    var over = Math.max(0, session.actionsSpent - budget);
    var byAction = Math.min(4, Math.floor(over / 2) + (over > 0 ? 1 : 0));
    var byPin = Math.min(3, session.pinFails || 0);
    return Math.max(byAction, byPin);
  }

  function hintOf(stage) { return STAGE_HINTS[stage] || ''; }

  /* 消耗一次行动。返回 {stage, hint}； authorized 的会话风险恒 0
     （授权查看不触发偷看判定 —— 分流定案 §三·4）。
     ⚠️ 不信任调用方手里的 session 引用 —— 那是快照，连续调用会把
     行动数永远加在 1 上（每次都从旧值算起）。先读新、再累加、再落盘。 */
  function spendAction(session, action, o) {
    var s = getSession(session.id);
    if (!s) return { stage: 0, hint: '', spent: 0 };
    var cost = (ACTION_COST[action] || 1) * ((o && o.sensitivity) || 1);
    s.actionsSpent = (s.actionsSpent || 0) + cost;
    s.lastAt = Date.now();
    if (!s.absenceMin) s.absenceMin = (o && o.absenceMin) || 30;
    var stage = s.authorized ? 0 : stageOf(s);
    s.riskStage = stage;
    patch('phoneSessions', s.id, s);
    return { stage: stage, hint: hintOf(stage), spent: s.actionsSpent };
  }

  /* 密码失败记账：同样走「读新再写」。失败次数留在会话上，
     满 5 次由 UI 决定暂时锁设备（不是必抓机关）。 */
  function recordPinFail(sessionId) {
    var s = getSession(sessionId);
    if (!s) return null;
    s.pinFails = (s.pinFails || 0) + 1;
    s.actionsSpent = (s.actionsSpent || 0) + (ACTION_COST.pinTry || 1);
    s.lastAt = Date.now();
    /* 失败次数自己会推风险阶段（不一定非得靠行动预算攒够） */
    s.riskStage = s.authorized ? 0 : stageOf(s);
    patch('phoneSessions', s.id, s);
    addTrace(s, { type: 'pin_fail', detail: '第 ' + s.pinFails + ' 次输错密码' });
    return s;
  }

  /* 当场判定：综合离开时长、已消耗行动、当前阶段、内容敏感度、
     剧情强度（默认轻微 risk=1）、少量随机。没有任何「第 N 次必抓」。 */
  function maybeCaught(session, o) {
    var s = getSession(session.id);
    if (!s || s.authorized || s.caughtOnScene) return false;
    var intensity = (o && o.intensity) || 1;     /* 剧情强度 0=安心 1=轻微 2=沉浸 */
    if (intensity <= 0) return false;
    var stage = s.riskStage || 0;
    if (stage <= 0) return false;
    var sens = (o && o.sensitivity) || 1;
    var p = 0.03 * stage * sens * intensity;
    if (Math.random() >= p) return false;
    patch('phoneSessions', s.id, { caughtOnScene: true });
    return true;
  }

  /* ---------------------------- 硬翻（2026-09-21 拍板） ----------------------------
     不知道密码时强行进手机，进入那一刻掷骰。方案：docs/方案-查手机硬翻-v1.md。
     基础档是 **OOC 玩法难度**（user 可调，安乐提议「概率做成可调整」，
     入口在锁屏右上角的小设置浮层——不在全局设置 app）；加成是**角色侧状态**，
     不归 user 调。被发现后「他怎么反应」交给 char 决定（模型即时演出），
     本地不写死惩罚。 */

  var FLIP_TIERS = { mild: 0.20, standard: 0.30, spicy: 0.40 };
  var FLIP_TIER_LABELS = { mild: '温和', standard: '标准', spicy: '刺激' };

  function flipTier() {
    var t = store.get('flipRisk');
    return FLIP_TIERS[t] !== undefined ? t : 'standard';
  }

  function setFlipTier(t) {
    if (FLIP_TIERS[t] === undefined) return flipTier();
    store.set('flipRisk', t);
    return t;
  }

  /* 掷骰概率 = 基础档 + 情境加成，封顶 85%（永远留一线没被发现的可能）。 */
  function flipProb(ph) {
    var p = FLIP_TIERS[flipTier()];
    if (ph && ph.lastExitedAt && (Date.now() - ph.lastExitedAt) < 10 * 60 * 1000) p += 0.15;
    if (ph && lockEnabled(ph)) p += 0.10;   /* 有防备的人警觉（硬翻只在有锁时出现） */
    if (ph) {
      var suspicion = pick('phoneTraces', function (t) {
        return t.phoneId === ph.id && t.type === 'pin_fail' && !t.detectedAt;
      }).length;
      if (suspicion) p += 0.10;             /* 他可能已经起疑 */
    }
    return Math.min(p, 0.85);
  }

  /* 硬翻一次：掷骰 + 记账。
     得手 → 轻痕迹照留（他事后凭痕迹起疑，走既有察觉机制，不当场抓包）；
     被抓 → 会话当场标记 caughtOnScene 并收束，重痕迹 immediate detected。 */
  function forceFlip(ph) {
    var caught = Math.random() < flipProb(ph);
    var s = startSession(ph, 'peek', 'force');
    if (caught) {
      patch('phoneSessions', s.id, { caughtOnScene: true, riskStage: 3 });
      var t = addTrace(s, { type: 'read', app: null,
        detail: '硬翻手机时被他抓了现行', detectable: true });
      if (t) patch('phoneTraces', t.id, { detectedAt: Date.now() });
      endSession(s.id, 'caught');
      return { caught: true, session: getSession(s.id) };
    }
    addTrace(s, { type: 'recent', app: null, detail: '硬翻着进入了手机，他没在场' });
    return { caught: false, session: getSession(s.id) };
  }

  /* ---------------------------- 派生内容（第 2 批生成，先落结构） ----------------------------
     kind: 'derived' 幕后交流（char 和合法联系人的幕后对话）
           'draft'  未发送草稿
     展示给 user 时 status 至少 confirmed —— 一旦看见就是世界事实。 */

  function derivedMsgs(phoneId) {
    return pick('phoneMsgs', function (m) {
      return m.phoneId === phoneId && m.status !== 'draft_hidden';
    });
  }

  function addDerived(phoneId, o) {
    return insert('phoneMsgs', {
      id: 'pn_' + newId(),
      phoneId: phoneId,
      charId: o.charId,
      kind: o.kind || 'derived',
      withId: o.withId || null,
      withName: o.withName || '',
      title: o.title || '',
      lines: o.lines || [],
      status: 'confirmed',
      sourceEventIds: o.sourceEventIds || [],
      secrecy: o.secrecy || 0,
      at: o.at || Date.now()
    });
  }

  /* ---------------------------- 计划（charPlan） ----------------------------
     状态机（总纲 §八）：brewing → preparing → scheduled → done
                                      ↘ paused / cancelled / changed
     变化必须留 history。 */

  var PLAN_STATUS = ['brewing', 'preparing', 'scheduled', 'done', 'paused', 'cancelled', 'changed'];

  function plansOf(phoneId) {
    return pick('phonePlans', function (p) { return p.phoneId === phoneId; });
  }

  function addPlan(phoneId, o) {
    return insert('phonePlans', {
      id: 'pl_' + newId(),
      phoneId: phoneId,
      charId: o.charId,
      type: o.type || 'general',
      title: o.title || '',
      status: o.status || 'brewing',
      secrecy: o.secrecy || 0,
      linkedIds: o.linkedIds || [],
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  function movePlan(planId, toStatus, reason) {
    var p = pick('phonePlans', function (x) { return x.id === planId; })[0];
    if (!p) return null;
    p.history = p.history || [];
    p.history.push({ from: p.status, to: toStatus, reason: reason || '', at: Date.now() });
    p.status = toStatus;
    p.updatedAt = Date.now();
    patch('phonePlans', planId, p);
    return p;
  }

  /* ---------------------------- 设置 ----------------------------
     自主生活档位（用户 2026-09-19 定：聊天 char 设置里 关/低/中/高）：
     off=完全离屏不生活；low/mid/high 只影响第 2 批结算闸门的阈值。 */

  function autoLifeOf(charId) {
    var all = store.get('charSettings') || {};
    var mine = (all.byChar && all.byChar[charId]) || {};
    return mine.autoLife || 'off';
  }

  function setAutoLife(charId, level) {
    var all = store.get('charSettings') || { byChar: {} };
    all.byChar = all.byChar || {};
    all.byChar[charId] = all.byChar[charId] || {};
    all.byChar[charId].autoLife = level;
    store.set('charSettings', all);
  }

  /* 离屏结算闸门（架构 v1 §6）：档位 → 最短结算间隔（分钟）。
     off = 不允许自动结算；manual 永远可以。 */
  var LIFE_GAP_MIN = { off: null, low: 1440, mid: 720, high: 360 };

  function gateFor(charId, now) {
    var level = autoLifeOf(charId);
    var gap = LIFE_GAP_MIN[level];
    if (gap == null) return { allowed: false, why: '自主生活是关的' };
    var ph = (function () {
      var sid = core.scopeId();
      var list = pick('phones', function (p) { return p.charId === charId && (!sid || p.sandboxId === sid); });
      return list[0] || null;
    })();
    if (!ph) return { allowed: false, why: '还没有手机壳' };
    /* 只认 settledUntil：新建的壳（还没结算过）必须放行 ——
       回落 createdAt 的话新角色会被「刚结算过」永远拦住（冒烟抓过） */
    var last = ph.settledUntil || 0;
    if (now == null) now = Date.now();
    if (now - last < gap * 60000) {
      return { allowed: false, why: '距上次结算不足 ' + gap + ' 分钟', phone: ph };
    }
    return { allowed: true, phone: ph, gapMin: gap };
  }

  /* 查手机生成用的模型（第 2 批消费）。语义同 memoryApiCfg：
     {mode:'main'} 或 {mode:'pick', label}，被删回落主 API。 */
  function apiCfg() { return store.get('phoneApiCfg') || { mode: 'main' }; }
  function setApiCfg(cfg) { store.set('phoneApiCfg', cfg || { mode: 'main' }); }

  /* ---------------------------- 第 2 批 · 生成链数据侧 ----------------------------
     原则（架构 v1 §0/§5/§10）：增量不重写；写入前程序校验；
     搜索≠购买、草稿≠已发送、计划≠完成 —— 语义升级一律拦下。 */

  /* [手机] 行提取：每行一个 JSON 对象。纯函数，冒烟直接打表。
     返回 { list, text } —— text 是抽掉标签后的正文。 */
  function extractPhoneDeltas(raw) {
    var list = [];
    var text = String(raw == null ? '' : raw)
      .replace(/^[ \t]*\[手机\][ \t]*(\{.*\})[ \t]*$/gm, function (_, j) {
        try { list.push(JSON.parse(j)); } catch (e) { /* 坏 JSON 直接丢 */ }
        return '';
      })
      .replace(/\n{3,}/g, '\n\n').trim();
    return { list: list, text: text };
  }

  /* op 白名单：搜索≠购买、草稿≠发送 —— 语义在数据层就锁死。
     permission/grant = char 在聊天里主动递手机（邀请授权流）；
     lock/set = 密码叙事化：char 在剧情里自己设锁 / 改密码 / 去掉锁。 */
  var PHONE_OPS = {
    messages: ['add_derived', 'add_draft'],
    browser:  ['add_history', 'add_bookmark'],
    notes:    ['add_note'],
    health:   ['add_day'],
    shop:     ['add_order', 'order_status', 'add_fav', 'add_cart'],
    permission: ['grant', 'set'],
    custom:   ['add_record'],
    lock:     ['set']
  };

  function clipStr(v, n) {
    var s = String(v == null ? '' : v).trim();
    return s.slice(0, n);
  }

  /* 岛内已登记的人名（大号 + 皮套 + 挂在他名下的 NPC + 我的马甲 + 我名下的
     NPC）。用来拦下「凭空编一个联系人」—— 写入前校验第 ③ 条：
     不引用未登记 NPC（架构 v1 §10）。
     拿不到岛上下文（没 scoped / 查不到）时返回 null = 不拦：只有能确证才拒。 */
  function knownPeople() {
    var sid = core.scopeId();
    if (!sid) return null;
    var names = [];
    try {
      /* 名字池：大号 + 皮套 + 岛内全体 NPC（唯一口径 core.npcsOfRoom）+ 马甲。
         以前用 universeOf（带出挂在 char 名下的 NPC）+ userNpcs，
         岛级 NPC 完全进不了池子；universeOf 还不按岛过滤，有跨岛泄漏。 */
      core.charsOfSandbox(sid).forEach(function (c) {
        if (!c) return;
        if (c.name) names.push(c.name);
        (Sleepy.island
          ? Sleepy.island.childrenOf(sid, c.id, 'sub', 'char')
          : core.subChars(c.id)).forEach(function (s) {
            if (s && s.name) names.push(s.name);
          });
      });
      if (core.npcsOfRoom) {
        core.npcsOfRoom(sid).forEach(function (n) {
          if (n && n.name) names.push(n.name);
        });
      }
      core.masksOfSandbox(sid).forEach(function (u) {
        if (!u) return;
        if (u.name) names.push(u.name);
      });
    } catch (e) { return null; }
    return names.length ? names : null;
  }

  /* 单条 delta 校验 + 归一化。不合法返回 null（丢弃单项不阻塞其他）。 */
  function validateDelta(d) {
    if (!d || typeof d !== 'object') return null;
    var app = d.app;
    var op = d.op;
    if (!PHONE_OPS[app] || PHONE_OPS[app].indexOf(op) < 0) return null;
    var p = d.payload || d;
    var out = { app: app, op: op, occurredAt: d.occurredAt || Date.now() };
    if (app === 'messages' && op === 'add_derived') {
      var withName = clipStr(p.withName || p.with || '', 20);
      if (!withName) return null;
      /* 不认得这个名字 = 模型在编联系人，整条丢弃 */
      var known = knownPeople();
      if (known && known.indexOf(withName) < 0) return null;
      var lines = (p.lines || []).slice(0, 6).map(function (ln) {
        return { who: ln && ln.who === 'other' ? 'other' : 'char', text: clipStr(ln && ln.text, 200) };
      }).filter(function (ln) { return ln.text; });
      if (lines.length < 2) return null;    /* 一来一回才算一段交流 */
      out.data = { kind: 'derived', withName: withName, title: clipStr(p.title, 30), lines: lines };
    } else if (app === 'messages' && op === 'add_draft') {
      var t = clipStr(p.text || p.content, 300);
      if (!t) return null;
      out.data = { kind: 'draft', withName: '', title: '', lines: [{ who: 'char', text: t }] };
    } else if (app === 'browser') {
      var q = clipStr(p.query || p.title, 60);
      if (!q) return null;
      out.data = { query: q, note: clipStr(p.note, 120),
        kind: op === 'add_bookmark' ? 'bookmark' : 'search' };
    } else if (app === 'notes') {
      var c = clipStr(p.content || p.text, 400);
      if (!c && !clipStr(p.title, 40)) return null;
      out.data = { title: clipStr(p.title, 40), content: c,
        folder: clipStr(p.folder, 20) || null };
    } else if (app === 'health') {
      /* 一天一条：三餐/零食 + 运动计划 vs 实际 + 他自己的短评。
         饮食卡要带时间与短评（Demo 03 的 mealHead/.comment），
         运动卡要带名称与「为什么改了」（Demo 的 workoutName/.why）。 */
      var meals = (p.meals || []).slice(0, 6).map(function (m) {
        return { meal: clipStr(m && m.meal, 10), time: clipStr(m && m.time, 10),
          text: clipStr(m && m.text, 60), comment: clipStr(m && m.comment, 40) };
      }).filter(function (m) { return m.text; });
      var words = (p.comments || p.thoughts || []).slice(0, 4).map(function (x) {
        return clipStr(x, 80);
      }).filter(function (x) { return !!x; });
      var plan = clipStr(p.workoutPlan, 60);
      var result = clipStr(p.workoutResult, 60);
      if (!meals.length && !clipStr(p.comment, 100) && !words.length && !plan && !result) return null;
      out.data = {
        day: clipStr(p.day, 12) || null,
        meals: meals,
        workoutPlan: plan,
        workoutResult: result,
        workoutName: clipStr(p.workoutName || p.workout, 20),
        workoutWhy: clipStr(p.workoutWhy || p.changeReason, 120),
        comment: clipStr(p.comment, 100),
        comments: words
      };
    } else if (app === 'shop' && op === 'add_order') {
      var title = clipStr(p.title, 40);
      if (!title) return null;
      out.data = { title: title, price: Number(p.price) || 0, purpose: clipStr(p.purpose, 60), status: 'ordered' };
    } else if (app === 'shop' && op === 'order_status') {
      var t2 = clipStr(p.title, 40);
      var st = clipStr(p.status, 20);
      if (!t2 || ['shipped', 'received', 'refunded', 'gifted'].indexOf(st) < 0) return null;
      out.data = { title: t2, status: st };
    } else if (app === 'shop' && op === 'add_fav') {
      var ft = clipStr(p.title, 40);
      if (!ft) return null;
      out.data = { kind: 'fav', title: ft, note: clipStr(p.note, 80) };
    } else if (app === 'shop' && op === 'add_cart') {
      var ct = clipStr(p.title, 40);
      if (!ct) return null;
      out.data = { kind: 'cart', title: ct, price: Number(p.price) || 0 };
    } else if (app === 'custom' && op === 'add_record') {
      /* 工坊自定义 App：模型不知道实例 id，按模板名匹配该手机上的安装 */
      var an = clipStr(p.appName || p.name, 12);
      if (!an) return null;
      var ct2 = clipStr(p.content || p.text || p.note, 300);
      if (!ct2 && !clipStr(p.title, 40)) return null;
      out.data = { appName: an, title: clipStr(p.title, 40), content: ct2 };
    } else if (app === 'permission' && op === 'grant') {
      /* 邀请授权：scope 整机或 app:xxx；mode 缺省长期。
         reason 会随邀请卡展示给 user（char 的一句话）。 */
      var scope = p.scope === 'all' ? 'all' : clipStr(p.scope, 30);
      var md = ['once', 'timed', 'long'].indexOf(p.mode) >= 0 ? p.mode : 'long';
      if (scope !== 'all' && !/^app:[a-z]+$/.test(scope)) return null;
      out.data = { scope: scope, mode: md, note: clipStr(p.note || p.reason, 60) };
    } else if (app === 'permission' && op === 'set') {
      /* 他自己改权限：暂时隐藏（为惊喜保密）/ 恢复 / 正式收回。
         定案 §B：char 可扩大、暂时隐藏、正式收回 —— 都是状态迁移，不删记录。 */
      var st = clipStr(p.state, 10);
      if (['open', 'hidden', 'revoked'].indexOf(st) < 0) return null;
      out.data = { scope: p.scope === 'all' ? 'all' : clipStr(p.scope, 30),
        state: st, note: clipStr(p.note || p.reason, 60) };
    } else if (app === 'lock' && op === 'set') {
      /* 密码叙事化（2026-09-21 拍板）：锁由 char 在剧情里自己设 / 改 / 去 ——
         不是 user 在设置页 OOC 扳开关。pin 是 4 位数字（他会在意的一个日子，
         MMDD 口径，与锁屏密码盘一致）；不传 pin 就沿用现有密码。
         改密码是剧情事件：旧 pin 进 pinHistory，「旧密码作废了」本身可玩。 */
      var on = p.enabled === true || p.enabled === 'true';
      var off = p.enabled === false || p.enabled === 'false';
      if (!on && !off) return null;
      var npin = clipStr(p.pin, 4);
      if (on && npin && !/^\d{4}$/.test(npin)) return null;
      out.data = { enabled: on, pin: npin, note: clipStr(p.note || p.reason, 60) };
    } else { return null; }
    return out;
  }

  /* ------- 内容落库（结算 / delta 共用） ------- */

  /* delta 带的 occurredAt 只在「不晚于现在」时才采信 —— 未来时间说明模型
     没在讲已经发生的事，用落库时间兜底（写入前校验「时间在范围内」的
     本地可做那半边；跨岛的 range 判定在 applySettlement 那层）。 */
  function atOf(v) {
    var t = Number(v && v.occurredAt) || 0;
    var now = Date.now();
    if (!t || t > now + 60000) return now;
    return t;
  }

  function addNote(phone, o, at) {
    return insert('phoneNotes', {
      id: 'pn_' + newId(), phoneId: phone.id, charId: phone.charId,
      title: o.title || '', content: o.content || '',
      folder: o.folder || null,
      status: 'confirmed', at: at || Date.now()
    });
  }
  function addHistory(phone, o, kind, at) {
    return insert('phoneBrowser', {
      id: 'pb_' + newId(), phoneId: phone.id, charId: phone.charId,
      query: o.query, note: o.note || '',
      kind: kind === 'bookmark' ? 'bookmark' : 'search',
      at: at || Date.now()
    });
  }
  function addHealthDay(phone, o, at) {
    return insert('phoneHealth', {
      id: 'ph_' + newId(), phoneId: phone.id, charId: phone.charId,
      day: o.day, meals: o.meals || [],
      workoutPlan: o.workoutPlan || '', workoutResult: o.workoutResult || '',
      workoutName: o.workoutName || '', workoutWhy: o.workoutWhy || '',
      comment: o.comment || '', comments: o.comments || [],
      at: at || Date.now()
    });
  }
  function addOrder(phone, o, at) {
    return insert('phoneShop', {
      id: 'po_' + newId(), phoneId: phone.id, charId: phone.charId,
      title: o.title, price: o.price || 0, purpose: o.purpose || '',
      /* 订单记录购买用途 —— 不能默认都是送人的（总纲 §11·2） */
      status: o.status || 'ordered', history: [], at: at || Date.now()
    });
  }
  function moveOrder(phone, title, toStatus) {
    var hit = pick('phoneShop', function (x) {
      return x.phoneId === phone.id && x.title === title && x.status !== toStatus;
    })[0];
    if (!hit) return null;
    hit.history = hit.history || [];
    hit.history.push({ from: hit.status, to: toStatus, at: Date.now() });
    hit.status = toStatus;
    patch('phoneShop', hit.id, hit);
    return hit;
  }

  /* 四个 App 的读口（第 3 批 UI 消费）：新→旧 */
  function listNotes(phoneId) {
    return pick('phoneNotes', function (x) { return x.phoneId === phoneId; })
      .sort(function (a, b) { return b.at - a.at; });
  }

  function listHealth(phoneId) {
    return pick('phoneHealth', function (x) { return x.phoneId === phoneId; })
      .sort(function (a, b) { return b.at - a.at; });
  }
  function listShop(phoneId) {
    return pick('phoneShop', function (x) {
      return x.phoneId === phoneId && x.kind !== 'fav' && x.kind !== 'cart';
    }).sort(function (a, b) { return b.at - a.at; });
  }
  function listFavs(phoneId) {
    return pick('phoneShop', function (x) { return x.phoneId === phoneId && x.kind === 'fav'; })
      .sort(function (a, b) { return b.at - a.at; });
  }
  function listCart(phoneId) {
    return pick('phoneShop', function (x) { return x.phoneId === phoneId && x.kind === 'cart'; })
      .sort(function (a, b) { return b.at - a.at; });
  }
  function listBrowser(phoneId, kind) {
    return pick('phoneBrowser', function (x) {
      return x.phoneId === phoneId && (!kind || (x.kind || 'search') === kind);
    }).sort(function (a, b) { return b.at - a.at; });
  }

  /* 密码叙事化落库（lock/set）。改密码时旧 pin 进 pinHistory ——
     「旧密码作废了」是剧情事实，user 之后拿旧密码去猜，失败也是真实事件。
     pinNote 留他设锁/改密码时说的一句话（OOC 设置页展示，不进提示词）。 */
  function applyLock(phone, d, at) {
    var hit = getPhone(phone.id);
    if (!hit) return null;
    if (!hit.lock) hit.lock = {};
    if (d.enabled) {
      var old = hit.lock.pin;
      var changing = d.pin && d.pin !== old;
      if (d.pin) {
        hit.lock.pin = d.pin;
      } else if (!old) {
        /* 「有锁没密码」是死路 —— 保底派生一个 */
        hit.lock.pin = derivePin(hit.sandboxId, hashOf(hit.sandboxId + ':' + hit.charId));
      }
      if (changing) {
        hit.lock.pinHistory = (hit.lock.pinHistory || []).slice(-4).concat([{
          pin: old,
          note: hit.lock.pinNote || '',
          changedAt: hit.lock.changedAt || null
        }]);
      }
      hit.lock.enabled = true;
      if (d.note) hit.lock.pinNote = d.note;
      hit.lock.changedAt = at;
      hit.lock.narrative = true;
    } else {
      hit.lock.enabled = false;
    }
    savePhone(hit);
    return hit;
  }

  /* 应用一条已校验的 delta。来源记进 generationRunId 语义位。 */
  function applyDelta(phone, v, runId) {
    if (!v) return null;
    var at = atOf(v);
    if (v.app === 'lock') return applyLock(phone, v.data, at);
    if (v.app === 'messages') {
      return addDerived(phone.id, {
        charId: phone.charId, kind: v.data.kind,
        withName: v.data.withName, title: v.data.title, lines: v.data.lines,
        at: at,
        sourceEventIds: runId ? [runId] : []
      });
    }
    if (v.app === 'browser') return addHistory(phone, v.data, v.data.kind, at);
    if (v.app === 'notes') return addNote(phone, v.data, at);
    if (v.app === 'health') return addHealthDay(phone, v.data, at);
    if (v.app === 'permission') {
      /* 邀请授权走权限表；返回记录本身，调用方（聊天钩子）据此发邀请卡 */
      if (v.op === 'set') return setPermByScope(phone.id, v.data);
      return grantPerm(phone.id, {
        charId: phone.charId, scope: v.data.scope, mode: v.data.mode, reason: v.data.note
      });
    }
    if (v.app === 'custom') {
      /* 工坊记录：展示即 confirmed（数据层的铁律对自定义 App 同样生效） */
      if (!Sleepy.workshop) return null;
      return Sleepy.workshop.addRecordByName(phone.id, v.data.appName,
        { title: v.data.title, content: v.data.content }, runId);
    }
    if (v.app === 'shop') {
      if (v.op === 'order_status') return moveOrder(phone, v.data.title, v.data.status);
      if (v.data.kind === 'fav') return insert('phoneShop', {
        id: 'po_' + newId(), phoneId: phone.id, charId: phone.charId,
        kind: 'fav', title: v.data.title, note: v.data.note || '', at: at
      });
      if (v.data.kind === 'cart') return insert('phoneShop', {
        id: 'po_' + newId(), phoneId: phone.id, charId: phone.charId,
        kind: 'cart', title: v.data.title, price: v.data.price || 0, at: at
      });
      return addOrder(phone, v.data, at);
    }
    return null;
  }

  /* 结算落库：校验 → 逐条写入 → 推进 settledUntil（幂等的关键：
     写失败不推进，下一轮补结算 —— 架构 v1 §12）。 */
  function applySettlement(phone, parsed, runId) {
    var deltas = (parsed && Array.isArray(parsed.deltas)) ? parsed.deltas : [];
    var applied = 0, dropped = 0;
    deltas.slice(0, 12).forEach(function (d) {
      var v = validateDelta(d);
      if (!v) { dropped++; return; }
      if (applyDelta(phone, v, runId)) applied++; else dropped++;
    });
    (parsed.planChanges || []).slice(0, 2).forEach(function (pc) {
      if (!pc || !pc.title) return;
      var hit = plansOf(phone.id).filter(function (x) {
        return x.title === clipStr(pc.title, 40) &&
          ['brewing', 'preparing', 'scheduled'].indexOf(x.status) >= 0;
      })[0];
      if (hit && PLAN_STATUS.indexOf(pc.to) >= 0) movePlan(hit.id, pc.to, clipStr(pc.reason, 60));
    });
    patch('phones', phone.id, { settledUntil: Date.now() });
    return { applied: applied, dropped: dropped };
  }

  /* 痕迹 → char 可察觉（第 2 批消费端）：结算时把未处理的可检测痕迹
     打上 detectedAt；聊天注入槽消费后补 addressedAt，只提醒一次。 */
  function openTraces(phoneId) {
    return pick('phoneTraces', function (t) {
      return t.phoneId === phoneId && t.detectable && !t.detectedAt;
    });
  }
  function markDetected(phoneId) {
    var n = 0;
    openTraces(phoneId).forEach(function (t) {
      patch('phoneTraces', t.id, { detectedAt: Date.now() });
      n++;
    });
    return n;
  }
  function detectedUnaddressed(phoneId) {
    return pick('phoneTraces', function (t) {
      return t.phoneId === phoneId && t.detectedAt && !t.addressedAt;
    });
  }
  function markAddressed(phoneId) {
    var n = 0;
    detectedUnaddressed(phoneId).forEach(function (t) {
      patch('phoneTraces', t.id, { addressedAt: Date.now() });
      n++;
    });
    return n;
  }

  /* ---------------------------- 候选密码 ----------------------------
     分流定案 §E：「user 可以选择由真实关系事实形成的候选日期」。
     候选只从真实数据里来（岛落成日 / 首次聊天的日子），绝不编造纪念日。 */
  function pinCandidates(sbId, charId) {
    var out = [], seen = {};
    function push(label, d) {
      if (!d) return;
      var v = ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
      if (seen[v]) return;
      seen[v] = 1;
      out.push({ label: label, value: v });
    }
    var sb = core.findSandbox(sbId);
    if (sb && sb.createdAt) push('你们这座岛落成的日子', new Date(sb.createdAt));
    try {
      var first = null;
      var cs = Sleepy.chatStore;
      (cs ? cs.getChats() : []).forEach(function (c) {
        if (core.rootIdOf(c.characterId) !== charId) return;
        (c.messages || []).forEach(function (m) {
          if (!m.timestamp) return;
          if (!first || m.timestamp < first) first = m.timestamp;
        });
      });
      if (first) push('你们第一次聊天的日子', new Date(first));
    } catch (e) { /* 没有聊天就少一个候选 */ }
    return out;
  }

  /* ---------------------------- 导出 ---------------------------- */

  Sleepy.phone = {
    PHONE_KEYS: PHONE_KEYS,
    WALLS: WALLS,
    ACCENTS: ACCENTS,
    hashOf: hashOf,
    ensurePhone: ensurePhone,
    phoneOf: phoneOf,
    getPhone: getPhone,
    savePhone: savePhone,
    /* 锁屏：他有没有上锁的**唯一判据** + 改它的唯一入口。
       页面里别自己去读 lock.pin（那恒真，就是六.2 的根）。 */
    lockEnabled: lockEnabled,
    setLockEnabled: setLockEnabled,
    derivePin: derivePin,
    activePerms: activePerms,
    longPermFor: longPermFor,
    hiddenApps: hiddenApps,
    grantPerm: grantPerm,
    setPermState: setPermState,
    setPermByScope: setPermByScope,
    ENTRY_META: ENTRY_META,
    startSession: startSession,
    getSession: getSession,
    endSession: endSession,
    addTrace: addTrace,
    tracesOf: tracesOf,
    ACTION_COST: ACTION_COST,
    STAGE_HINTS: STAGE_HINTS,
    stageOf: stageOf,
    hintOf: hintOf,
    spendAction: spendAction,
    recordPinFail: recordPinFail,
    maybeCaught: maybeCaught,
    /* 硬翻（方案-查手机硬翻-v1） */
    FLIP_TIERS: FLIP_TIERS,
    FLIP_TIER_LABELS: FLIP_TIER_LABELS,
    flipTier: flipTier,
    setFlipTier: setFlipTier,
    flipProb: flipProb,
    forceFlip: forceFlip,
    derivedMsgs: derivedMsgs,
    addDerived: addDerived,
    PLAN_STATUS: PLAN_STATUS,
    plansOf: plansOf,
    addPlan: addPlan,
    movePlan: movePlan,
    autoLifeOf: autoLifeOf,
    setAutoLife: setAutoLife,
    gateFor: gateFor,
    LIFE_GAP_MIN: LIFE_GAP_MIN,
    apiCfg: apiCfg,
    setApiCfg: setApiCfg,
    extractPhoneDeltas: extractPhoneDeltas,
    pinCandidates: pinCandidates,
    PHONE_OPS: PHONE_OPS,
    validateDelta: validateDelta,
    applyDelta: applyDelta,
    applyLock: applyLock,
    applySettlement: applySettlement,
    addNote: addNote,
    addHistory: addHistory,
    addHealthDay: addHealthDay,
    addOrder: addOrder,
    moveOrder: moveOrder,
    listNotes: listNotes,
    listBrowser: listBrowser,
    listFavs: listFavs,
    listCart: listCart,
    listHealth: listHealth,
    listShop: listShop,
    openTraces: openTraces,
    markDetected: markDetected,
    detectedUnaddressed: detectedUnaddressed,
    markAddressed: markAddressed
  };

})(window);
