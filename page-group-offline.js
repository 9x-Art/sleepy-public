/* ============================================================
   page-group-offline.js — 多人线下场景页（群聊线下）
   依赖：store.js、core.js、ui.js、app.js、api.js、prompt-engine.js、
         core-group.js、page-group.js（Sleepy.groupStore）、
         page-offline.js（Sleepy.offlineStore 的接口选择/调用）、imggen（可选）
   页面：group-offline-scene（场景页）；门弹窗 / 谁先开场挂在宿主页身上

   依据《多人线下场景交互页 Demo v1》（2026-09-19 用户交付）：
   · 顶栏：场景名 + 来自群名 · 第 NN 次；返回键 = 离开抽屉（照私聊线下）
   · 环境条：时段 / 天气 / 地点 + 时刻胶囊
   · 在场条：脸堆（在场实心 / 在路上虚线 / 暂时离开降饱和）+ 现场状态抽屉
   · 时间线：场景框 → user 行动 → 群像轮（prose 叙述 + dialogue 台词，带说话人）
   · 输入行：＋（场景操作：生成场景图 / 焦点 / 局部重写）+ 文本 + 发送
   · 离开三选（先离开 / 保存进度 / 结束见面）、设置两页签 —— 都照私聊线下

   引擎（MVP，诚实边界）：
   · 一轮 = 一次非流式调用；system = 共享外壳 + F2 叙事卡 + 场景/在场规则
     + 参与者人设；输出协议沿用线下（paras/suggests/envUpdate），
     每段可带 speaker（说话人名），渲染成群像轮
   · 暂时离开者不可感知现场；在路上者不被写入、到场后才获得信息
   · 结束见面的多人记忆结算（逐本体）还没接线 —— 本轮只标记结束
   ============================================================ */
(function (global) {
  'use strict';

  global.Sleepy = global.Sleepy || {};
  var Sleepy = global.Sleepy;
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;

  var KEY = 'groupOfflineSessions';

  var ICON_SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var ICON_CLOUD = '<svg viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
  var ICON_HOME = '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
  var TIME_OPTIONS = ['清晨', '上午', '午后', '傍晚', '夜晚', '深夜'];

  /* ============================ 数据层 ============================ */

  function all() {
    var list = store.get(KEY);
    return Array.isArray(list) ? list : [];
  }
  function saveAll(list) { store.set(KEY, list); }
  function find(id) {
    if (!id) return null;
    var list = all();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function sessionsOf(groupId) {
    return all().filter(function (s) { return s && s.groupId === groupId; });
  }
  function mutate(id, fn) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      fn(list[i]);
      list[i].updatedAt = Date.now();
      saveAll(list);
      return list[i];
    }
    return null;
  }
  function appendMessage(id, data) {
    var msg = null;
    mutate(id, function (s) {
      msg = { id: 'gof' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now() };
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
      }
      s.messages.push(msg);
    });
    return msg;
  }
  function pause(id) { return mutate(id, function (s) { s.status = 'paused'; }); }
  function endSession(id) { return mutate(id, function (s) { s.status = 'ended'; }); }

  /* 三步交接单 → 场景会话。count 按「这个群第几次见面」。 */
  function createFromHandoff(ho) {
    var list = all();
    var count = 1;
    list.forEach(function (s) { if (s.groupId === ho.groupId) count++; });
    var session = {
      id: 'gofs' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      groupId: ho.groupId,
      groupName: ho.groupName || '',
      handoffId: ho.id,
      sceneName: String(ho.location || '').trim() || '多人见面',
      count: count,
      status: 'active',
      env: {
        timeOfDay: '傍晚', weather: '晴',
        location: String(ho.location || '').trim() || '—',
        clockTime: '18:42'
      },
      openingBy: 'char',
      purpose: ho.purpose || '',
      inherit: ho.inheritPublicContext !== false,
      userIdentityAccountId: ho.userIdentityAccountId || null,
      participants: (ho.participants || []).map(function (p) {
        return {
          ownerId: p.ownerId, kind: p.kind || 'char',
          arrival: p.arrival || 'opening',
          present: p.arrival !== 'late',   /* late = 在路上，等 user 叫进场 */
          away: false
        };
      }),
      narrativeSettings: {
        pov: 'he_you', tense: 'present', style: 'pure_love',
        lengthMode: 'medium', customLengthMin: null, styleWords: '',
        showCharInner: true, charProactive: false, npcFrequency: 'normal'
      },
      systemSettings: { showSuggests: true, timeAdvance: true, endSummary: true },
      apiModel: '', apiModelName: '',
      messages: [],
      createdAt: Date.now(), updatedAt: Date.now()
    };
    core.tagScope(session);
    list.unshift(session);
    saveAll(list);
    return session;
  }

  /* ============================ 参与者辅助 ============================ */

  function partMeta(s, p) {
    var rec = core.findChar(p.ownerId);
    return {
      name: (rec && rec.name) || '?',
      avatar: (rec && rec.avatar) || '',
      initial: core.initialOf((rec && rec.name) || '?'),
      kind: p.kind,
      npc: p.kind === 'npc' || ((rec || {}).kind === 'npc')
    };
  }
  function userMetaOf(s) {
    var u = core.findUser(s.userIdentityAccountId) ||
      (core.activeUser && core.activeUser()) || null;
    return {
      name: (u && u.name) || '我',
      avatar: (u && u.avatar) || '',
      initial: core.initialOf((u && u.name) || '我')
    };
  }
  function presentParts(s) {
    return (s.participants || []).filter(function (p) { return p.present && !p.away; });
  }
  function waitingParts(s) {
    return (s.participants || []).filter(function (p) { return !p.present; });
  }
  function awayParts(s) {
    return (s.participants || []).filter(function (p) { return p.present && p.away; });
  }
  function partByName(s, name) {
    var n = String(name || '').trim();
    if (!n) return null;
    var ps = s.participants || [];
    for (var i = 0; i < ps.length; i++) {
      if (partMeta(s, ps[i]).name === n) return ps[i];
    }
    return null;
  }

  /* ============================ 装配 / 解析 ============================ */

  function styleHintOf(style) {
    return {
      pure_love: '纯爱日常：语感轻，物件细节多，情绪藏在动作里，不喊口号。',
      literary: '沉浸文学：句子可以慢下来，重意象与留白，克制抒情。',
      casual: '轻松互动：短句、抖包袱、互相打趣，节奏快。'
    }[style] || '';
  }

  function lengthHintOf(n) {
    if (n.lengthMode === 'short') return '这一轮总共 120 字上下。';
    if (n.lengthMode === 'long') return '这一轮总共 450 字上下。';
    if (n.lengthMode === 'custom' && n.customLengthMin) return '这一轮不少于 ' + n.customLengthMin + ' 字。';
    return '这一轮总共 250 字上下。';
  }

  function buildSystem(s) {
    var E = Sleepy.promptEngine;
    var parts = [];
    try {
      var shell = E.cardBody('shell');
      if (shell) parts.push(shell);
      var f2 = E.cardBody('f2');
      if (f2) parts.push(f2);
    } catch (e) { /* 卡片缺失不阻塞 */ }

    var env = s.env || {};
    var scene = ['[SCENE]'];
    scene.push('地点：' + (env.location || '—'));
    scene.push('时段：' + (env.timeOfDay || '—') + ' · 天气：' + (env.weather || '—') + ' · 时刻：' + (env.clockTime || '--:--'));
    scene.push('见面目的：' + (s.purpose || '自由开始，由在场的人自然带出'));
    if (s.inherit) scene.push('可继承该群聊里的公开前情（只限在场者各自有权知道的部分）。');
    parts.push(scene.join('\n'));

    var um = userMetaOf(s);
    var ppl = ['[PARTICIPANTS]'];
    ppl.push(um.name + '（user 的现场身份，第二人称「你」）');
    presentParts(s).forEach(function (p) {
      var m = partMeta(s, p);
      var rec = core.findChar(p.ownerId);
      ppl.push(m.name + (m.npc ? '（NPC）' : '') + '：' +
        String((rec && rec.content) || '（暂无人设，按名字与场合自然扮演）').slice(0, 900));
    });
    parts.push(ppl.join('\n'));

    var rules = ['[PRESENCE RULES]'];
    var wait = waitingParts(s), away = awayParts(s);
    if (wait.length) {
      rules.push('在路上（还没到场，不能出现、不能说话、不知道桌边发生过什么）：' +
        wait.map(function (p) { return partMeta(s, p).name; }).join('、'));
    }
    if (away.length) {
      rules.push('暂时离开（听不见也看不见现场，不要替他们接话）：' +
        away.map(function (p) { return partMeta(s, p).name; }).join('、'));
    }
    var n = s.narrativeSettings || {};
    rules.push('user 的行动已经给出：转述和回应都可以，但不要替 ' + um.name + ' 编造新的决定或台词。');
    if (n.styleWords) rules.push('文风词（必须遵守）：' + n.styleWords);
    else if (styleHintOf(n.style)) rules.push('文风：' + styleHintOf(n.style));
    rules.push(lengthHintOf(n));
    /* 叙事焦点（场景操作里调）：自动是默认，ensemble 铺群像，角色名给特写 */
    if (n.focus === 'ensemble') {
      rules.push('叙事焦点：群像。多个在场角色平均着墨，铺开场面，不要只围着一个人转。');
    } else if (n.focus) {
      rules.push('叙事焦点：这一轮以「' + n.focus + '」为中心——TA 的动作、神态或台词是这一段的主体，但不必独占全场。');
    }
    if (n.showCharInner === false) rules.push('不要直接写出角色内心，只写外部可见的言行。');
    parts.push(rules.join('\n'));

    parts.push([
      '[OUTPUT]',
      '只输出一个 JSON，不要代码块：',
      '{"paras":[{"speaker":"说话角色名，叙述段留空字符串","type":"prose 或 dialogue","text":"…"}],"suggests":["给 user 的两个可选行动"],"envUpdate":{"clockTime":"HH:MM"}}',
      '- prose：环境、动作、神态的叙述（speaker 留空）；dialogue：角色口语台词（speaker 必填在场角色名）。',
      '- 一轮里可以有多个角色的多段台词，按现场自然分配，不必人人开口。',
      '- envUpdate 在时间明显流逝时给出新的时刻，否则照旧。'
    ].join('\n'));

    return parts.filter(Boolean).join('\n\n');
  }

  function historyMessages(s, userInput) {
    var um = userMetaOf(s);
    var out = [];
    (s.messages || []).slice(-24).forEach(function (m) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: um.name + '：' + (m.text || '') });
      } else if (m.role === 'scene') {
        out.push({ role: 'assistant', content: '【场景】' + parasText(m.paras) });
      } else if (m.role === 'turn') {
        var lines = (m.paras || []).map(function (p) {
          return p.speaker ? (p.speaker + '：' + p.text) : ('（' + p.text + '）');
        });
        out.push({ role: 'assistant', content: lines.join('\n') });
      } else if (m.role === 'photo') {
        out.push({ role: 'assistant', content: '（拍下了一张现场照片）' });
      }
    });
    if (userInput != null) out.push({ role: 'user', content: userInput });
    return out;
  }

  function parasText(paras) {
    return (paras || []).map(function (p) { return p.text || ''; }).join('');
  }

  /* 解析：JSON 优先（剥围栏），失败整体降级为一条 prose。不崩溃。 */
  function parseGroupReply(raw) {
    var text = String(raw || '').trim();
    var m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (m) text = m[1].trim();
    var i = text.indexOf('{'), j = text.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        var obj = JSON.parse(text.slice(i, j + 1));
        if (obj && Array.isArray(obj.paras)) {
          return {
            ok: true,
            paras: obj.paras.filter(function (p) {
              return p && typeof p.text === 'string' && p.text.trim();
            }).map(function (p) {
              return {
                speaker: typeof p.speaker === 'string' ? p.speaker.trim() : '',
                type: p.type === 'dialogue' ? 'dialogue' : 'prose',
                text: String(p.text).trim()
              };
            }),
            suggests: (Array.isArray(obj.suggests) ? obj.suggests : [])
              .filter(function (x) { return typeof x === 'string' && x.trim(); }).slice(0, 3),
            envUpdate: (obj.envUpdate && /^\d{1,2}:\d{2}$/.test(String(obj.envUpdate.clockTime || '')))
              ? { clockTime: String(obj.envUpdate.clockTime) } : null
          };
        }
      } catch (e) { /* 降级 */ }
    }
    return {
      ok: true,
      paras: [{ speaker: '', type: 'prose', text: String(raw || '').trim() || '……' }],
      suggests: [], envUpdate: null
    };
  }

  /* ============================ 门弹窗 / 谁先开场 ============================ */

  /* 进门先选：继续上次（paused）/ 开一次新的见面。ended 折在最后。 */
  function openDoorSheet(pageCtx, groupId) {
    var g = Sleepy.groupStore.findGroup(groupId);
    var host = pageCtx.el;
    var old = host.querySelector('.off-door-overlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = h('div', 'off-root off-vars');
    var overlay = h('div', 'off-overlay off-door-overlay');
    var sheet = h('div', 'off-sheet');
    sheet.appendChild(h('div', 'off-sheet-handle'));

    var title = h('div', 'off-door-title');
    title.appendChild(h('span', 'off-door-title-main', '多人线下 · ' + ((g && g.name) || '')));
    title.appendChild(h('span', 'off-door-title-sub', '去哪里见这一面？'));
    sheet.appendChild(title);

    function close() {
      overlay.classList.remove('show');
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 240);
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var sessions = sessionsOf(groupId);
    var paused = sessions.filter(function (s) { return s.status === 'paused'; });
    var ended = sessions.filter(function (s) { return s.status === 'ended'; });

    function row(s, isEnded) {
      var last = s.messages.length ? s.messages[s.messages.length - 1] : null;
      var preview = '（还没有开始说话）';
      if (last) {
        if (last.role === 'user') preview = last.text || '';
        else if (last.role === 'turn') preview = parasText(last.paras);
        else if (last.role === 'scene') preview = parasText(last.paras);
        else if (last.role === 'photo') preview = '一张现场照片';
      }
      if (preview.length > 34) preview = preview.slice(0, 34);
      var r = h('button', 'off-door-row');
      r.type = 'button';
      var main = h('span', 'off-door-row-main');
      main.appendChild(h('span', 'off-door-row-name', s.sceneName));
      main.appendChild(h('span', 'off-door-row-sub',
        '第 ' + s.count + ' 次 · ' + preview));
      r.appendChild(main);
      r.appendChild(h('span', 'off-door-row-tag' + (isEnded ? ' is-ended' : ''),
        isEnded ? '已结束' : '继续'));
      r.addEventListener('click', function () {
        close();
        pageCtx.open('group-offline-scene', { id: s.id });
      });
      return r;
    }

    if (paused.length) {
      sheet.appendChild(h('div', 'off-door-sec', '继续上次'));
      paused.forEach(function (s) { sheet.appendChild(row(s, false)); });
    }

    var go = h('button', 'off-entry-go' + (paused.length ? ' in-sheet' : ''));
    go.type = 'button';
    go.appendChild(h('span', 'off-entry-go-name', paused.length ? '再开一次新的' : '开一次新的见面'));
    go.appendChild(h('span', 'off-entry-go-sub', '选人、排到场，然后推门进去'));
    go.addEventListener('click', function () {
      close();
      pageCtx.open('group-offline', { groupId: groupId });
    });
    sheet.appendChild(go);

    if (ended.length) {
      var endHint = h('button', 'off-door-manual-hint', '已结束的见面（' + ended.length + '）▾');
      endHint.type = 'button';
      var endWrap = h('div', 'off-door-manual');
      endWrap.style.display = 'none';
      endHint.addEventListener('click', function () {
        var open = endWrap.style.display !== 'none';
        endWrap.style.display = open ? 'none' : '';
        endHint.textContent = '已结束的见面（' + ended.length + '）' + (open ? '▾' : '▴');
      });
      sheet.appendChild(endHint);
      ended.forEach(function (s) { endWrap.appendChild(row(s, true)); });
      sheet.appendChild(endWrap);
    }

    var cancel = h('button', 'off-sheet-cancel', '先不去了');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    sheet.appendChild(cancel);

    overlay.appendChild(sheet);
    wrap.appendChild(overlay);
    host.appendChild(wrap);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
  }

  /* 开完新见面先问谁先开场（和私聊线下同一交互）。反悔 → 转 paused。 */
  function chooseOpening(pageCtx, host, s) {
    var wrap2 = h('div', 'off-root off-vars');
    var overlay = h('div', 'off-overlay off-door-overlay');
    var sheet = h('div', 'off-sheet');
    sheet.appendChild(h('div', 'off-sheet-handle'));

    var title = h('div', 'off-door-title');
    title.appendChild(h('span', 'off-door-title-main', '谁先开场？'));
    title.appendChild(h('span', 'off-door-title-sub',
      s.sceneName + ' · 第 ' + s.count + ' 次见面'));
    sheet.appendChild(title);

    var opts = h('div', 'off-leave-options');
    [
      { by: 'char', name: '他们先开场', desc: '点进去就铺场景，在场的人自然开始', primary: true },
      { by: 'user', name: '我先行动', desc: '点进去你先写，写完他们再来接' }
    ].forEach(function (o) {
      var b = h('button', 'off-leave-option' + (o.primary ? ' primary' : ''));
      b.type = 'button';
      var main = h('span', 'off-opt-main');
      main.appendChild(h('span', 'off-opt-name', o.name));
      main.appendChild(h('span', 'off-opt-desc', o.desc));
      b.appendChild(main);
      b.addEventListener('click', function () {
        mutate(s.id, function (x) { x.openingBy = o.by; });
        overlay.classList.remove('show');
        setTimeout(function () {
          if (wrap2.parentNode) wrap2.parentNode.removeChild(wrap2);
        }, 240);
        pageCtx.open('group-offline-scene', { id: s.id });
      });
      opts.appendChild(b);
    });
    sheet.appendChild(opts);

    var cancel = h('button', 'off-sheet-cancel', '先不去了');
    cancel.type = 'button';
    cancel.addEventListener('click', function () {
      pause(s.id);
      overlay.classList.remove('show');
      setTimeout(function () {
        if (wrap2.parentNode) wrap2.parentNode.removeChild(wrap2);
      }, 240);
    });
    sheet.appendChild(cancel);

    overlay.appendChild(sheet);
    wrap2.appendChild(overlay);
    host.appendChild(wrap2);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
  }

  /* ============================ 页面：场景 ============================ */

  function renderScene(ctx) {
    var body = ctx.body;
    var id = ctx.params.id || '';
    var session = find(id);
    if (!session) {
      ctx.toast('找不到这个场景', 'err');
      ctx.back();
      return;
    }
    ctx.el.classList.add('is-bleed');
    if (session.status === 'paused') mutate(id, function (s) { s.status = 'active'; });

    var pending = null;
    body.innerHTML = '';
    var root = h('div', 'off-root');
    root.appendChild(buildHeader());
    root.appendChild(buildPresence());
    root.appendChild(buildScroll());
    root.appendChild(buildInput());
    body.appendChild(root);
    /* 壁纸 / 配色 + 结束态状态条（会话带着设置进来，进页就套上） */
    var sysTheme = (session.systemSettings || {}).theme;
    if (sysTheme && sysTheme !== 'custom') root.classList.add(sysTheme);
    applyWallpaper(body.querySelector('.off-chat-scroll'));
    refreshInputState();

    /* 开场引导：只跑一次（旗标挂 ctx，防 rebuild 双触发） */
    if (!ctx.__bootstrapped && session.status !== 'ended') {
      ctx.__bootstrapped = true;
      var fresh = find(id);
      if (!(fresh.messages || []).length && (fresh.openingBy || 'char') === 'char') {
        setTimeout(function () { requestTurn(null); }, 350);
      }
    }

    /* ---------------- 结构 ---------------- */

    function buildHeader() {
      var header = h('div', 'off-header');
      var topbar = h('div', 'off-topbar');
      var left = h('div', 'off-topbar-left');
      var backBtn = h('button', 'off-back-btn');
      backBtn.type = 'button';
      backBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>';
      backBtn.addEventListener('click', function () { openSheet('leave'); });
      left.appendChild(backBtn);
      var title = h('div', 'off-scene-title');
      title.appendChild(h('span', 'off-scene-name', session.sceneName));
      title.appendChild(h('span', 'off-scene-sub',
        '来自「' + (session.groupName || '群聊') + '」· 第 ' + pad2(session.count) + ' 次见面'));
      left.appendChild(title);
      topbar.appendChild(left);

      var right = h('div', 'off-topbar-right');
      var pill = h('button', 'off-api-pill');
      pill.type = 'button';
      var choices = Sleepy.offlineStore ? Sleepy.offlineStore.apiChoices() : [];
      pill.appendChild(h('span', 'off-api-dot'));
      pill.appendChild(h('span', 'off-api-label',
        session.apiModel || (choices[0] || {}).label || '未配置'));
      pill.addEventListener('click', function () { openSheet('api'); });
      right.appendChild(pill);
      var setBtn = h('button', 'off-settings-btn');
      setBtn.type = 'button';
      setBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      setBtn.addEventListener('click', function () { openSheet('settings'); });
      right.appendChild(setBtn);
      topbar.appendChild(right);
      header.appendChild(topbar);
      header.appendChild(buildEnvStrip());
      return header;
    }

    function buildEnvStrip() {
      var env = session.env || {};
      var strip = h('div', 'off-env-strip');
      strip.appendChild(envItem(ICON_SUN, env.timeOfDay || '—'));
      strip.appendChild(envSep());
      strip.appendChild(envItem(ICON_CLOUD, env.weather || '—'));
      strip.appendChild(envSep());
      strip.appendChild(envItem(ICON_HOME, env.location || '—'));
      strip.appendChild(h('div', 'off-env-spacer'));
      strip.appendChild(h('div', 'off-time-capsule off-time-label', env.clockTime || '--:--'));
      return strip;
    }
    function envItem(icon, label) {
      var it = h('div', 'off-env-item');
      var ic = h('span', 'off-env-ic');
      ic.innerHTML = icon;
      it.appendChild(ic);
      it.appendChild(h('span', '', label));
      return it;
    }
    function envSep() { return h('div', 'off-env-sep'); }

    function buildPresence() {
      var bar = h('div', 'gof-presence');
      bar.appendChild(h('span', 'gof-presence-label', '现场'));
      var faces = h('div', 'gof-faces');
      var um = userMetaOf(session);
      faces.appendChild(faceEl(um, 'user', true));
      session.participants.forEach(function (p) {
        faces.appendChild(faceEl(partMeta(session, p), 'npc', p.present && !p.away, p));
      });
      bar.appendChild(faces);
      var n = presentParts(session).length + 1;
      var wait = waitingParts(session);
      var copy = n + ' 人在场';
      if (wait.length) copy += ' · ' + wait.map(function (p) { return partMeta(session, p).name; }).join('、') + '在路上';
      bar.appendChild(h('span', 'gof-presence-copy', copy));
      var st = h('button', 'gof-presence-btn');
      st.type = 'button';
      st.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 20c.5-4 2.2-6 5-6s4.5 2 5 6M13 20c.3-2.8 1.5-4.4 3.5-4.4s3.2 1.6 3.5 4.4"/></svg>';
      st.addEventListener('click', function () { openSheet('status'); });
      bar.appendChild(st);
      return bar;
    }

    function faceEl(meta, cls, solid) {
      var f = h('span', 'gof-face gof-face-' + cls + (solid ? '' : ' is-waiting'),
        (meta.initial || '?').charAt(0));
      return f;
    }

    function buildScroll() {
      var scroll = h('div', 'off-chat-scroll');
      fillMessages(scroll);
      return scroll;
    }

    function fillMessages(scroll) {
      scroll.innerHTML = '';
      (session.messages || []).forEach(function (m) { scroll.appendChild(blockFor(m)); });
      scroll.scrollTop = scroll.scrollHeight;
    }

    function blockFor(m) {
      if (m.role === 'scene') {
        var sb = h('div', 'off-scene-block');
        sb.appendChild(h('div', 'off-scene-prose', parasText(m.paras)));
        return sb;
      }
      if (m.role === 'event') {
        var ev = h('div', 'gof-event');
        var head = h('div', 'gof-event-head');
        head.appendChild(h('span', 'gof-event-ic'));
        var t = h('span');
        t.appendChild(h('b', null, m.title || ''));
        head.appendChild(t);
        ev.appendChild(head);
        if (m.note) ev.appendChild(h('p', null, m.note));
        return ev;
      }
      if (m.role === 'user') {
        var ua = h('div', 'off-user-action');
        ua.appendChild(h('span', 'off-user-tag', userMetaOf(session).name));
        ua.appendChild(h('span', 'off-user-action-text', m.text || ''));
        return ua;
      }
      if (m.role === 'photo') {
        var card = h('div', 'off-photo-card');
        var img = h('img');
        img.alt = '现场照片';
        if (m.mediaId && Sleepy.media) Sleepy.media.url(m.mediaId).then(function (u) { if (u) img.src = u; });
        else if (m.url) img.src = m.url;
        card.appendChild(img);
        return card;
      }
      /* turn：群像轮 —— 叙述段铺底，说话人逐段成块 */
      var wrap = h('div', 'gof-turn');
      (m.paras || []).forEach(function (p) {
        if (p.speaker) {
          var pm = partByName(session, p.speaker);
          var meta = pm ? partMeta(session, pm) : { name: p.speaker, avatar: '', initial: p.speaker.charAt(0) };
          var blk = h('div', 'gof-speaker');
          var head = h('div', 'gof-speaker-head');
          head.appendChild(h('span', 'gof-speaker-ava', (meta.initial || '?').charAt(0)));
          head.appendChild(h('strong', null, meta.name));
          blk.appendChild(head);
          blk.appendChild(h('p', 'off-char-q', p.text));
          wrap.appendChild(blk);
        } else {
          wrap.appendChild(h('p', 'off-char-p', p.text));
        }
      });
      var sugg = (m.suggests || []).filter(function (x) { return x; });
      if (sugg.length && (session.systemSettings || {}).showSuggests !== false) {
        var blk2 = h('div', 'off-suggest-block');
        blk2.appendChild(h('div', 'off-suggest-label', '也可以 ·'));
        var list = h('div', 'off-suggest-list');
        sugg.forEach(function (s2) {
          var it = h('button', 'off-suggest-item', s2);
          it.type = 'button';
          it.addEventListener('click', function () {
            var input = body.querySelector('.off-input-field');
            if (input && !input.disabled) { input.value = s2; input.focus(); }
          });
          list.appendChild(it);
        });
        blk2.appendChild(list);
        wrap.appendChild(blk2);
      }
      return wrap;
    }

    function buildInput() {
      var area = h('div', 'off-input-area');
      var row = h('div', 'off-input-row');

      var plusWrap = h('div', 'off-cam-wrap');
      var plusBtn = h('button', 'off-camera-btn');
      plusBtn.type = 'button';
      plusBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
      plusBtn.addEventListener('click', function () { openSheet('tools'); });
      plusWrap.appendChild(plusBtn);
      row.appendChild(plusWrap);

      var input = h('textarea', 'off-input-field');
      input.rows = 1;
      input.placeholder = '你想怎么行动？';
      input.addEventListener('input', function () {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
      row.appendChild(input);

      var send = h('button', 'off-send-btn');
      send.type = 'button';
      send.innerHTML = '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
      send.addEventListener('click', doSend);
      row.appendChild(send);
      area.appendChild(row);

      if (session.status === 'ended') {
        input.disabled = true;
        input.placeholder = '这次见面已经结束，只能回看了';
        send.disabled = true;
      }
      return area;
    }

    function doSend() {
      var input = body.querySelector('.off-input-field');
      var text = String(input && input.value || '').trim();
      if (!text) return;
      requestTurn(text);
    }

    /* ---------------- 一轮 ---------------- */

    function setBusy(b) {
      var input = body.querySelector('.off-input-field');
      var send = body.querySelector('.off-send-btn');
      if (input) input.disabled = b || session.status === 'ended';
      if (send) send.disabled = b || session.status === 'ended';
      var th = body.querySelector('.gof-thinking');
      if (th) th.classList.toggle('show', !!b);
    }

    function requestTurn(userInput, opts) {
      opts = opts || {};
      if (session.status === 'ended') return;
      if (pending) { ctx.toast('现场还在继续，等一下', 'warn'); return; }

      if (userInput != null) {
        appendMessage(id, { role: 'user', text: userInput });
        session = find(id);
        var input = body.querySelector('.off-input-field');
        if (input) { input.value = ''; input.style.height = 'auto'; }
      } else if (!opts.rewriteNote && !presentParts(session).length) {
        ctx.toast('现场只有你一个人 —— 等人到场，或去状态里叫人进来', 'warn');
        return;
      }
      fillMessages(body.querySelector('.off-chat-scroll'));
      ensureThinking();
      setBusy(true);

      var built = buildSystem(session);
      var messages = [{ role: 'system', content: built }].concat(
        historyMessages(session, userInput == null ? null : userInput));
      if (userInput == null) {
        messages.push({ role: 'user', content: opts.rewriteNote
          ? '（重写刚才那一轮。' + opts.rewriteNote +
            '。直接输出重写后的这一轮，不要解释自己在重写。）'
          : '（开场。请先铺开场景，再让在场的人自然开始。）' });
      }

      pending = true;
      var cand = Sleepy.offlineStore.candForSession(session);
      Sleepy.offlineStore.callModel(cand, messages).then(function (r) {
        pending = false;
        setBusy(false);
        if (!r.ok) { ctx.toast('✗ ' + r.error, 'err'); return; }
        var parsed = parseGroupReply(r.text);
        var hasDialog = parsed.paras.some(function (p) { return p.speaker; });
        appendMessage(id, {
          role: (userInput == null && !hasDialog) ? 'scene' : 'turn',
          paras: parsed.paras,
          suggests: parsed.suggests
        });
        if (parsed.envUpdate && (session.systemSettings || {}).timeAdvance !== false) {
          mutate(id, function (s) { s.env.clockTime = parsed.envUpdate.clockTime; });
        }
        session = find(id);
        refreshHeader();
        fillMessages(body.querySelector('.off-chat-scroll'));
      });
    }

    function ensureThinking() {
      if (body.querySelector('.gof-thinking')) return;
      var th = h('div', 'gof-thinking');
      var dots = h('span', 'gof-dots');
      for (var i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
      th.appendChild(dots);
      th.appendChild(h('span', null, '现场正在继续'));
      var scroll = body.querySelector('.off-chat-scroll');
      if (scroll) scroll.appendChild(th);
    }

    function refreshHeader() {
      var old = body.querySelector('.off-header');
      if (old && old.parentNode) old.parentNode.replaceChild(buildHeader(), old);
      var oldP = body.querySelector('.gof-presence');
      if (oldP && oldP.parentNode) oldP.parentNode.replaceChild(buildPresence(), oldP);
    }

    /* ---------------- 抽屉 ---------------- */

    var sheetBox = null;
    function openSheet(kind) {
      closeSheet();
      if (kind === 'leave') sheetBox = buildLeaveSheet();
      else if (kind === 'status') sheetBox = buildStatusSheet();
      else if (kind === 'invite') sheetBox = buildInviteSheet();
      else if (kind === 'tools') sheetBox = buildToolsSheet();
      else if (kind === 'api') sheetBox = buildApiSheet();
      else if (kind === 'focus') sheetBox = buildFocusSheet();
      else if (kind === 'rewrite') sheetBox = buildRewriteSheet();
      else sheetBox = buildSettingsSheet();
      root.appendChild(sheetBox);
      requestAnimationFrame(function () { sheetBox.classList.add('show'); });
    }
    function closeSheet() {
      if (sheetBox && sheetBox.parentNode) sheetBox.parentNode.removeChild(sheetBox);
      sheetBox = null;
    }
    function sheetShell(title, contentEl, cancelLabel) {
      var overlay = h('div', 'off-overlay off-door-overlay');
      var sheet = h('div', 'off-sheet');
      sheet.appendChild(h('div', 'off-sheet-handle'));
      sheet.appendChild(h('div', 'off-sheet-title', title));
      if (contentEl.intro) sheet.appendChild(h('p', 'gof-sheet-intro', contentEl.intro));
      sheet.appendChild(contentEl);
      var cancel = h('button', 'off-sheet-cancel', cancelLabel || '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', closeSheet);
      sheet.appendChild(cancel);
      overlay.appendChild(sheet);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSheet(); });
      return overlay;
    }

    function buildLeaveSheet() {
      var opts = h('div', 'off-leave-options');
      [
        { name: '先离开一下', desc: '不总结，保留现场，回来继续', act: 'pause', primary: true },
        { name: '保存进度并离开', desc: '记录每个人的在场状态，稍后从这里继续', act: 'pause' },
        { name: '结束这次见面', desc: '分别结算各人的记忆与关系，进「留痕」确认', act: 'end' }
      ].forEach(function (o) {
        var b = h('button', 'off-leave-option' + (o.primary ? ' primary' : ''));
        b.type = 'button';
        var main = h('span', 'off-opt-main');
        main.appendChild(h('span', 'off-opt-name', o.name));
        main.appendChild(h('span', 'off-opt-desc', o.desc));
        b.appendChild(main);
        b.addEventListener('click', function () {
          closeSheet();
          if (o.act === 'pause') {
            pause(id);
            ctx.back();
          } else {
            endSession(id);
            session = find(id);
            refreshInputState();
            if ((session.systemSettings || {}).endSummary === false) {
              ctx.toast('见面结束了（总结已按设置关闭）', 'ok');
            } else {
              ctx.toast('见面结束了，正在整理每个人的记忆…', 'ok');
              gmOfflineRun(session, { toast: true }).then(function (ok) {
                if (!ok) {
                  ctx.toast('总结没成：' + (find(id).summaryError || '失败') + ' · 场景页里可以重试', 'warn');
                }
              });
            }
            setTimeout(function () { ctx.back(); }, 700);
          }
        });
        opts.appendChild(b);
      });
      return sheetShell('要怎么离开？', opts, '继续待着');
    }

    /* 结束态的输入栏置灰 + 状态条（总结失败时给真重试入口，照私聊线下） */
    function refreshInputState() {
      var ended = session.status === 'ended';
      var input = body.querySelector('.off-input-field');
      var send = body.querySelector('.off-send-btn');
      if (input) {
        input.disabled = ended || !!pending;
        input.placeholder = ended ? '这次见面已经结束，只能回看了' : '你想怎么行动？';
      }
      if (send) send.disabled = ended || !!pending;
      var area = body.querySelector('.off-input-area');
      if (!area) return;
      var old = area.querySelector('.off-ended-bar');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var oldRetry = area.querySelector('.off-summary-retry');
      if (oldRetry && oldRetry.parentNode) oldRetry.parentNode.removeChild(oldRetry);
      if (!ended) return;
      var sum = session.summary;
      var label = sum
        ? '这次见面已结束 · 整理出 ' + (sum.added || 0) + ' 条记忆'
        : (session.summaryError ? '这次见面已结束 · 总结没生成' : '这次见面已结束');
      area.insertBefore(h('div', 'off-ended-bar', label), area.firstChild);
      if (!sum && session.summaryError) {
        var retry = h('button', 'off-summary-retry', '重试总结');
        retry.type = 'button';
        retry.addEventListener('click', function () {
          retry.disabled = true;
          retry.textContent = '正在整理…';
          gmOfflineRun(find(id), { toast: true }).then(function (ok) {
            if (ok) {
              ctx.toast('总结好了', 'ok');
              session = find(id);
              refreshInputState();
            } else {
              retry.disabled = false;
              retry.textContent = '重试总结';
              ctx.toast('还是没成：' + (find(id).summaryError || '失败'), 'err');
            }
          });
        });
        area.insertBefore(retry, area.firstChild);
      }
    }

    /* 现场状态：在场 / 在路上 / 暂时离开，各自的小动作 */
    function buildStatusSheet() {
      var box = h('div', 'gof-state');

      function group(label, parts2, badge, action) {
        if (!parts2.length) return;
        box.appendChild(h('p', 'gof-state-title', label));
        var list = h('div', 'gof-state-list');
        parts2.forEach(function (p) {
          var m = partMeta(session, p);
          var r = h('div', 'gof-state-row');
          r.appendChild(h('span', 'gof-speaker-ava', (m.initial || '?').charAt(0)));
          var copy = h('span', 'gof-state-copy');
          copy.appendChild(h('b', null, m.name));
          copy.appendChild(h('small', null,
            (m.npc ? 'NPC' : '持久角色') + ' · ' +
            (p.arrival === 'late' ? '稍后到场' : '从开场在场')));
          r.appendChild(copy);
          r.appendChild(h('span', 'gof-state-badge' + (badge === 'late' ? ' is-late' : ''), badgeText(badge)));
          if (action) {
            var btn = h('button', 'gof-mini-action', action.label(p));
            btn.type = 'button';
            btn.addEventListener('click', function () {
              action.run(p);
              closeSheet();
              session = find(id);
              refreshHeader();
              fillMessages(body.querySelector('.off-chat-scroll'));
            });
            r.appendChild(btn);
          }
          list.appendChild(r);
        });
        box.appendChild(list);
      }

      function badgeText(b) {
        return b === 'present' ? '在场' : (b === 'late' ? '在路上' : '暂时离开');
      }

      group('当前在场', presentParts(session), 'present', {
        label: function () { return '暂时离开'; },
        run: function (p) {
          mutate(id, function (s) {
            s.participants.forEach(function (x) { if (x.ownerId === p.ownerId) x.away = true; });
          });
          var m = partMeta(session, p);
          appendMessage(id, { role: 'event', title: m.name + ' 暂时离开了', note: 'TA 不会知道离开期间发生的事。' });
        }
      });
      group('等待到场', waitingParts(session), 'late', {
        label: function () { return '现在到场'; },
        run: function (p) {
          mutate(id, function (s) {
            s.participants.forEach(function (x) {
              if (x.ownerId === p.ownerId) { x.present = true; x.away = false; }
            });
          });
          var m = partMeta(session, p);
          appendMessage(id, {
            role: 'event', title: m.name + ' 到场了',
            note: 'TA 从这一刻开始获得现场信息；此前内容仍保持不可知。'
          });
        }
      });
      group('暂时离开', awayParts(session), 'away', {
        label: function () { return '回到现场'; },
        run: function (p) {
          mutate(id, function (s) {
            s.participants.forEach(function (x) { if (x.ownerId === p.ownerId) x.away = false; });
          });
          var m = partMeta(session, p);
          appendMessage(id, { role: 'event', title: m.name + ' 回到了现场' });
        }
      });

      var invite = h('button', 'off-entry-go in-sheet');
      invite.type = 'button';
      invite.appendChild(h('span', 'off-entry-go-name', '中途邀请其他角色'));
      invite.appendChild(h('span', 'off-entry-go-sub', '群成员按本体邀请，只传递你实际说明的内容'));
      invite.addEventListener('click', function () { openSheet('invite'); });
      box.appendChild(invite);
      box.intro = '到场时间决定每个人从哪一刻开始获得现场信息。暂时离开者不会读取离开期间的内容。';
      return sheetShell('现场成员', box, '关闭');
    }

    function buildInviteSheet() {
      var box = h('div', 'gof-state');
      var inScene = {};
      (session.participants || []).forEach(function (p) { inScene[p.ownerId] = true; });
      var entities = Sleepy.groupAI ? Sleepy.groupAI.entitiesOf(session.groupId) : [];
      var cands = entities.filter(function (e) { return !inScene[e.ownerId]; });
      if (!cands.length) {
        box.appendChild(h('p', 'gof-sheet-intro', '群里的角色都在现场了。'));
        return sheetShell('中途邀请', box, '关闭');
      }
      var list = h('div', 'gof-state-list');
      cands.forEach(function (e) {
        var rec = core.findChar(e.ownerId);
        var r = h('button', 'gof-state-row gof-state-row-btn');
        r.type = 'button';
        r.appendChild(h('span', 'gof-speaker-ava', core.initialOf((rec && rec.name) || '?')));
        var copy = h('span', 'gof-state-copy');
        copy.appendChild(h('b', null, (rec && rec.name) || '?'));
        copy.appendChild(h('small', null,
          (e.kind === 'npc' ? 'NPC' : '持久角色') + ' · 邀请后先在「路上」，由你决定何时进场'));
        r.appendChild(copy);
        r.addEventListener('click', function () {
          mutate(id, function (s) {
            s.participants.push({
              ownerId: e.ownerId, kind: e.kind, arrival: 'late',
              present: false, away: false
            });
          });
          closeSheet();
          session = find(id);
          refreshHeader();
          ctx.toast((rec && rec.name) + ' 已受邀 · 在「路上」', 'ok');
        });
        list.appendChild(r);
      });
      box.appendChild(list);
      box.intro = '只邀请群里的账号对应的本体；TA 到场后只知道你当面告诉 TA 的内容。';
      return sheetShell('邀请谁进来？', box, '取消');
    }

    function buildToolsSheet() {
      var box = h('div', 'off-leave-options');
      [
        { name: '生成当前场景图片', desc: '根据地点、时段与在场者生成画面', run: genScenePhoto },
        { name: '调整叙事焦点', desc: focusDesc() + ' · 自动、群像或指定某位角色',
          run: function () { openSheet('focus'); } },
        { name: '局部重写上一轮', desc: '标记不满意的原因，重演最后一段叙事',
          run: function () {
            if (!lastNarrative()) { ctx.toast('还没有可以重写的轮次', 'warn'); return; }
            openSheet('rewrite');
          } }
      ].forEach(function (o) {
        var b = h('button', 'off-leave-option');
        b.type = 'button';
        var main = h('span', 'off-opt-main');
        main.appendChild(h('span', 'off-opt-name', o.name));
        main.appendChild(h('span', 'off-opt-desc', o.desc));
        b.appendChild(main);
        b.addEventListener('click', function () {
          closeSheet();
          if (o.run) o.run();
          else ctx.toast(o.name + ' 的入口已预留', 'warn');
        });
        box.appendChild(b);
      });
      return sheetShell('场景操作', box, '取消');
    }

    /* ---- 会话级模型切换（数据层早通：candForSession 消费 session.apiModel，
       这里只补 UI；照私聊线下的 buildApiSheet，去掉「设为默认」档——
       群线下的默认模型在创建页选，场景页改的只是本场） ---- */
    function buildApiSheet() {
      var wrap = h('div', 'off-api-wrap');
      var list = h('div', 'off-api-list');
      var choices = Sleepy.offlineStore ? Sleepy.offlineStore.apiChoices() : [];
      var current = {
        label: session.apiModel || (choices[0] || {}).label || '',
        model: session.apiModelName || ''
      };
      function cfgOf(label) {
        for (var i = 0; i < choices.length; i++) {
          if (choices[i].label === label) return choices[i].cand.cfg;
        }
        return choices.length ? choices[0].cand.cfg : null;
      }
      if (!choices.length) {
        wrap.appendChild(h('p', 'off-entry-empty', '还没有配置模型，去 设置 → 主 API'));
      }

      var modelSec = h('div', 'off-field-col');
      modelSec.appendChild(h('span', 'off-field-label', '模型名（留空 = 用接口里配的）'));
      var modelInput = h('input', 'off-settings-input');
      modelInput.value = current.model;
      modelInput.placeholder = '可手填，或点右边圆钮拉取';
      var modelLine = h('div', 'off-model-line');
      modelLine.appendChild(modelInput);
      var mini = h('button', 'set-mini-ic');
      mini.type = 'button';
      mini.title = '拉取模型列表';
      mini.setAttribute('aria-label', '拉取模型列表');
      mini.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
        'stroke-linejoin="round"><path d="M4 10a6 6 0 0 1 10.4-4.1M16 10a6 6 0 0 1-10.4 4.1M14.5 2.5v3.6h-3.6M5.5 17.5v-3.6h3.6"/></svg>';
      modelLine.appendChild(mini);
      var pickBox = h('div', 'model-pick');
      modelSec.appendChild(modelLine);
      modelSec.appendChild(pickBox);
      mini.addEventListener('click', function () {
        var cfg = cfgOf(current.label);
        if (!cfg || !cfg.baseUrl) { pickBox.innerHTML = ''; pickBox.appendChild(h('p', 'test-tip', '先选一个接口')); return; }
        mini.disabled = true;
        pickBox.innerHTML = '';
        pickBox.appendChild(h('p', 'test-tip', '正在拉取…'));
        Sleepy.api.fetchModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }).then(function (res) {
          mini.disabled = false;
          pickBox.innerHTML = '';
          if (!res.ok) { pickBox.appendChild(h('p', 'test-tip', '没拉到：' + res.message)); return; }
          if (!res.models.length) { pickBox.appendChild(h('p', 'test-tip', '接口返回了空列表')); return; }
          pickBox.appendChild(h('p', 'test-tip', '拉到 ' + res.models.length + ' 个，点一个选用'));
          res.models.slice(0, 40).forEach(function (mid) {
            var r = h('button', 'set-row model-pick-row');
            r.type = 'button';
            r.appendChild(h('span', 'set-row-label', mid));
            r.addEventListener('click', function () {
              modelInput.value = mid;
              pickBox.innerHTML = '';
            });
            pickBox.appendChild(r);
          });
        });
      });
      modelInput.addEventListener('change', function () { current.model = modelInput.value.trim(); });

      choices.forEach(function (c) {
        var opt = h('button', 'off-api-option' + (c.label === current.label ? ' active' : ''));
        opt.type = 'button';
        var left = h('span', 'off-api-opt-left');
        left.appendChild(h('span', 'off-api-opt-name', c.label));
        left.appendChild(h('span', 'off-api-opt-desc', c.desc));
        opt.appendChild(left);
        var check = h('span', 'off-api-check');
        check.appendChild(h('span', 'off-api-check-dot'));
        opt.appendChild(check);
        opt.addEventListener('click', function () {
          current.label = c.label;
          current.model = '';              /* 换接口，模型名回到该接口自己配的 */
          modelInput.value = '';
          pickBox.innerHTML = '';
          [].forEach.call(list.children, function (x) { x.classList.remove('active'); });
          opt.classList.add('active');
        });
        list.appendChild(opt);
      });
      wrap.appendChild(list);
      wrap.appendChild(modelSec);

      var okBtn = h('button', 'off-sheet-cancel off-ok-btn', '本场就用这个');
      okBtn.type = 'button';
      okBtn.addEventListener('click', function () {
        if (!choices.length) { closeSheet(); return; }
        current.model = modelInput.value.trim();
        mutate(id, function (s) { s.apiModel = current.label; s.apiModelName = current.model; });
        session = find(id);
        closeSheet();
        refreshHeader();
        ctx.toast('本场改用 ' + current.label + (current.model ? ' · ' + current.model : ''), 'ok');
      });
      wrap.appendChild(okBtn);
      return sheetShell('本场用哪个模型', wrap, '取消');
    }

    /* ---- 调整叙事焦点：自动 / 群像 / 指定在场角色。
       存 narrativeSettings.focus，buildSystem 注入 [PRESENCE RULES]。 ---- */
    function focusDesc() {
      var n = session.narrativeSettings || {};
      if (n.focus === 'ensemble') return '当前：群像';
      if (n.focus) return '当前：' + n.focus;
      return '当前：自动';
    }
    function buildFocusSheet() {
      var box = h('div', 'off-leave-options');
      var cur = (session.narrativeSettings || {}).focus || '';
      function focusRow(key, name, desc) {
        var b = h('button', 'off-leave-option' + (cur === key ? ' primary' : ''));
        b.type = 'button';
        var main = h('span', 'off-opt-main');
        main.appendChild(h('span', 'off-opt-name', name + (cur === key ? ' · 用着' : '')));
        main.appendChild(h('span', 'off-opt-desc', desc));
        b.appendChild(main);
        b.addEventListener('click', function () {
          mutate(id, function (s) {
            s.narrativeSettings = s.narrativeSettings || {};
            s.narrativeSettings.focus = key;
          });
          session = find(id);
          closeSheet();
          ctx.toast(key === 'ensemble' ? '下一轮起镜头铺给全场'
            : key ? '下一轮起多给「' + key + '」镜头' : '焦点回到自动', 'ok');
        });
        box.appendChild(b);
      }
      focusRow('', '自动', '按现场张力自然分配镜头');
      focusRow('ensemble', '群像', '在场者平均着墨，铺开场面');
      presentParts(session).forEach(function (p) {
        var m = partMeta(session, p);
        focusRow(m.name, m.name + (m.npc ? '（NPC）' : ''), '下一轮以 TA 的动作与台词为中心');
      });
      return sheetShell('叙事焦点给谁', box, '取消');
    }

    /* ---- 局部重写上一轮：把最后一段叙事移出时间线，带着不满意的原因重跑。
       移出的轮次不进总结（结算只看剩下的时间线）。 ---- */
    function lastNarrative() {
      var ms = session.messages || [];
      for (var i = ms.length - 1; i >= 0; i--) {
        if (ms[i].role === 'turn' || ms[i].role === 'scene') return { msg: ms[i], idx: i };
      }
      return null;
    }
    function buildRewriteSheet() {
      var last = lastNarrative();
      if (!last) return sheetShell('局部重写上一轮', h('p', 'off-entry-empty', '还没有可以重写的轮次'), '取消');
      var box = h('div', 'off-rewrite');
      box.intro = '最后一轮会从时间线上拿掉（总结不再算它），按下面的意见重新演一段。';
      var picked = {};
      var REASONS = [
        { key: 'focus', label: '镜头分配不对', note: '重新分配镜头，按现场张力来，别围着不相关的人绕' },
        { key: 'repeat', label: '内容重复了', note: '换新的推进，不要重复已经写过的动作和台词' },
        { key: 'userpower', label: '抢了 user 的戏', note: '不要替 user 做决定或编造台词，只回应已给出的行动' },
        { key: 'pace', label: '推进太快 / 越界', note: '放慢节奏，一次别推进太多' }
      ];
      var chips = h('div', 'gof-chips');
      REASONS.forEach(function (r) {
        var c = h('button', 'gof-chip');
        c.type = 'button';
        c.textContent = r.label;
        c.addEventListener('click', function () {
          picked[r.key] = !picked[r.key];
          c.classList.toggle('is-on', !!picked[r.key]);
        });
        chips.appendChild(c);
      });
      box.appendChild(chips);
      box.appendChild(h('span', 'off-field-label', '还有什么要改的（可留空）'));
      var note = h('textarea', 'gof-rewrite-note');
      note.placeholder = '比如：店长不该知道那件事…';
      box.appendChild(note);

      var okBtn = h('button', 'off-sheet-cancel off-ok-btn', '重写这一轮');
      okBtn.type = 'button';
      okBtn.addEventListener('click', function () {
        var bits = [];
        REASONS.forEach(function (r) { if (picked[r.key]) bits.push(r.note); });
        var extra = String(note.value || '').trim();
        if (extra) bits.push('特别注意：' + extra);
        mutate(id, function (s) { s.messages.splice(last.idx, 1); });
        session = find(id);
        closeSheet();
        fillMessages(body.querySelector('.off-chat-scroll'));
        ctx.toast('重演这一轮…', 'ok');
        requestTurn(null, { rewriteNote: bits.join('；') });
      });
      box.appendChild(okBtn);
      return sheetShell('局部重写上一轮', box, '取消');
    }

    function genScenePhoto() {
      if (pending) { ctx.toast('先等手头这轮结束', 'warn'); return; }
      if (!Sleepy.imggen || !Sleepy.imggen.activeApi || !Sleepy.imggen.activeApi()) {
        ctx.toast('先去 设置 → 生图 配一个生图接口', 'warn');
        return;
      }
      var env = session.env || {};
      var who = presentParts(session).map(function (p) { return partMeta(session, p).name; }).join('、');
      ctx.toast('正在生成…', 'ok');
      pending = true;
      setBusy(true);
      Sleepy.imggen.generate({
        subject: (env.location || '') + '，' + who + '在场，' +
          (env.timeOfDay || '') + '，' + (env.weather || '') + '的氛围，电影感构图，无人物特写'
      }).then(function (r) {
        pending = false;
        setBusy(false);
        if (!r.ok) { ctx.toast('✗ ' + ((r.error && r.error.message) || '生成失败'), 'err'); return; }
        appendMessage(id, { role: 'photo', mediaId: r.mediaId || '', url: r.url || '' });
        session = find(id);
        fillMessages(body.querySelector('.off-chat-scroll'));
      });
    }

    /* ---------------- 设置（照私聊线下的两页签） ---------------- */

    function buildSettingsSheet() {
      var sheet = h('div', 'off-overlay');
      var box = h('div', 'off-sheet off-sheet-full');
      box.appendChild(h('div', 'off-sheet-handle'));

      var tabs = h('div', 'off-settings-tabs');
      var panels = {};
      [['sys', '系统设置'], ['narrative', '叙事设置']].forEach(function (t, i) {
        var b = h('button', 'off-settings-tab' + (i === 0 ? ' active' : ''), t[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          [].forEach.call(tabs.children, function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          Object.keys(panels).forEach(function (k) {
            panels[k].classList[k === t[0] ? 'add' : 'remove']('active');
          });
        });
        tabs.appendChild(b);
      });
      box.appendChild(tabs);
      panels.sys = buildSysPanel();
      panels.narrative = buildNarrativePanel();
      box.appendChild(panels.sys);
      box.appendChild(panels.narrative);

      var close = h('button', 'off-sheet-cancel', '关闭');
      close.type = 'button';
      close.addEventListener('click', closeSheet);
      box.appendChild(close);
      sheet.appendChild(box);
      sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
      return sheet;
    }

    function section(title) {
      var sec = h('div', 'off-settings-section');
      sec.appendChild(h('div', 'off-settings-section-title', title));
      return sec;
    }
    function rowToggle(label, desc, val, onSet) {
      var row = h('div', 'off-settings-row');
      var left = h('div', 'off-settings-row-left');
      left.appendChild(h('span', 'off-settings-row-label', label));
      left.appendChild(h('span', 'off-settings-row-desc', desc));
      row.appendChild(left);
      var t = h('div', 'off-toggle' + (val ? ' on' : ''));
      t.addEventListener('click', function () {
        var next = !t.classList.contains('on');
        t.classList.toggle('on', next);
        onSet(next);
      });
      row.appendChild(t);
      return row;
    }
    function rowSeg(label, desc, options, val, onSet) {
      var row = h('div', 'off-settings-row-col');
      row.appendChild(h('span', 'off-settings-row-label', label));
      var seg = h('div', 'off-seg-ctrl');
      options.forEach(function (o) {
        var b = h('button', 'off-seg-btn' + (o.value === val ? ' active' : ''), o.label);
        b.type = 'button';
        b.addEventListener('click', function () {
          [].forEach.call(seg.children, function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          onSet(o.value);
        });
        seg.appendChild(b);
      });
      row.appendChild(seg);
      if (desc) row.appendChild(h('span', 'off-settings-row-desc', desc));
      return row;
    }

    function buildSysPanel() {
      var sys = session.systemSettings || {};
      var p = h('div', 'off-settings-panel active');

      /* 壁纸 / 配色（照私聊线下：四款主题纸 + 自定义图） */
      var wpSec = section('壁纸 / 配色');
      var grid = h('div', 'off-wallpaper-grid');
      [
        { key: '', cls: 'wp-paper', name: '纸本' },
        { key: 'theme-dusk', cls: 'wp-dusk', name: '暮色' },
        { key: 'theme-mist', cls: 'wp-mist', name: '雾蓝' },
        { key: 'theme-rose', cls: 'wp-rose', name: '浅玫' },
        { key: 'custom', cls: 'wp-custom', name: '自定义' }
      ].forEach(function (w) {
        var active = (sys.theme || '') === w.key || (w.key === '' && !sys.theme);
        var item = h('button', 'off-wallpaper-item off-' + w.cls + (active ? ' active' : ''));
        item.type = 'button';
        if (w.key === 'custom') {
          var plus = h('span', 'off-wp-plus');
          plus.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
          plus.appendChild(h('span', '', '自定义'));
          item.appendChild(plus);
          item.addEventListener('click', function () { pickWallpaper(item); });
        } else {
          var prev = h('span', 'off-wp-preview');
          prev.appendChild(h('span', 'off-wp-name', w.name));
          item.appendChild(prev);
          item.addEventListener('click', function () {
            updateSys({ theme: w.key });
            [].forEach.call(grid.children, function (x) { x.classList.remove('active'); });
            item.classList.add('active');
            setThemeLive(w.key);
          });
        }
        grid.appendChild(item);
      });
      wpSec.appendChild(grid);
      p.appendChild(wpSec);

      var itSec = section('交互');
      itSec.appendChild(rowToggle('显示建议选项', '每轮之后给出可选行动',
        sys.showSuggests !== false, function (v) { updateSys({ showSuggests: v }); }));
      itSec.appendChild(rowToggle('场景时间推进', '随对话推进自动更新时刻',
        sys.timeAdvance !== false, function (v) { updateSys({ timeAdvance: v }); }));
      itSec.appendChild(rowToggle('结束时生成总结', '分别结算在场角色的记忆，进「留痕」确认',
        sys.endSummary !== false, function (v) { updateSys({ endSummary: v }); }));
      p.appendChild(itSec);

      var memSec = section('记忆');
      memSec.appendChild(rowToggle('自动沉淀重要时刻', '总结时把重要时刻自动标为锚定记忆，永远优先召回',
        sys.autoAnchorMoments !== false, function (v) { updateSys({ autoAnchorMoments: v }); }));
      memSec.appendChild(rowToggle('线下内容独立存档', '不流入线上聊天记录，单独归档',
        sys.offlineArchive !== false, function (v) { updateSys({ offlineArchive: v }); }));
      p.appendChild(memSec);
      return p;
    }

    function setThemeLive(key) {
      var r = body.querySelector('.off-root');
      if (!r) return;
      r.className = 'off-root' + (key && key !== 'custom' ? ' ' + key : '');
      var sc = body.querySelector('.off-chat-scroll');
      if (!sc) return;
      if (key === 'custom') {
        applyWallpaper(sc);
      } else {
        sc.classList.remove('has-wallpaper');
        sc.style.backgroundImage = '';
      }
    }

    function applyWallpaper(scroll) {
      if (!scroll) return;
      var sys = session.systemSettings || {};
      if (sys.theme === 'custom' && sys.customWallpaperUrl && Sleepy.media) {
        Sleepy.media.url(sys.customWallpaperUrl).then(function (u) {
          if (u) {
            scroll.classList.add('has-wallpaper');
            scroll.style.backgroundImage = 'url("' + u + '")';
          }
        });
      }
    }

    function pickWallpaper(item) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (!f) return;
        if (!Sleepy.media || !Sleepy.media.available || !Sleepy.media.available()) {
          ctx.toast('图库不可用，换不了自定义壁纸', 'err');
          return;
        }
        Sleepy.media.shrink(f).then(function (r) {
          return Sleepy.media.put(r.blob, { name: '线下壁纸', kind: 'image', w: r.w, h: r.h });
        }).then(function (mid) {
          updateSys({ theme: 'custom', customWallpaperUrl: mid });
          [].forEach.call(item.parentNode.children, function (x) { x.classList.remove('active'); });
          item.classList.add('active');
          setThemeLive('custom');
          ctx.toast('壁纸换好了', 'ok');
        }, function () {
          ctx.toast('壁纸没存上', 'err');
        });
      });
      input.click();
    }

    function updateSys(patch) {
      mutate(id, function (s) {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) s.systemSettings[k] = patch[k];
        }
      });
    }
    function updateNarr(patch) {
      mutate(id, function (s) {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) s.narrativeSettings[k] = patch[k];
        }
      });
    }

    function buildNarrativePanel() {
      var n = session.narrativeSettings || {};
      var p = h('div', 'off-settings-panel');

      var lensSec = section('叙事镜头');
      lensSec.appendChild(rowSeg('叙事时态', '', [
        { value: 'present', label: '现在时' },
        { value: 'past', label: '过去时' }
      ], n.tense || 'present', function (v) { updateNarr({ tense: v }); }));
      p.appendChild(lensSec);

      var styleSec = section('文风与节奏');
      styleSec.appendChild(rowSeg('整体风格', '', [
        { value: 'pure_love', label: '纯爱日常' },
        { value: 'literary', label: '沉浸文学' },
        { value: 'casual', label: '轻松互动' },
        { value: 'custom', label: '自定义' }
      ], n.style || 'pure_love', function (v) {
        updateNarr({ style: v });
        wordsWrap.style.display = v === 'custom' ? '' : 'none';
      }));
      var wordsWrap = h('div', 'off-custom-len');
      wordsWrap.style.display = n.style === 'custom' ? '' : 'none';
      var wordsTa = document.createElement('textarea');
      wordsTa.className = 'off-settings-input';
      wordsTa.rows = 3;
      wordsTa.placeholder = '文风词，逗号或换行分隔。例：克制的，短句，物件细节多';
      wordsTa.value = n.styleWords || '';
      wordsTa.addEventListener('change', function () {
        updateNarr({ styleWords: wordsTa.value.trim() });
      });
      wordsWrap.appendChild(wordsTa);
      styleSec.appendChild(wordsWrap);

      styleSec.appendChild(rowSeg('回复字数', '', [
        { value: 'short', label: '简短' },
        { value: 'medium', label: '适中' },
        { value: 'long', label: '详尽' }
      ], n.lengthMode || 'medium', function (v) { updateNarr({ lengthMode: v }); }));
      styleSec.appendChild(rowToggle('描写角色内心', '叙述中允许出现他们的心理活动',
        n.showCharInner !== false, function (v) { updateNarr({ showCharInner: v }); }));
      p.appendChild(styleSec);
      return p;
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    ctx.rebuild = function () { renderScene(ctx); };
    ctx.__sceneStatus = session.status;
  }

  Sleepy.register('group-offline-scene', {
    title: '线下',
    render: renderScene,
    onShow: function (ctx) {
      var s = find(ctx.params.id);
      if (ctx.rebuild && s && s.status !== ctx.__sceneStatus) ctx.rebuild();
    }
  });

  /* ==================== 群聊记忆（线上累计 + 线下结算） ====================

     复用 summary 卡和 summaryEngine.ingest；多角色的差异只有一点：
     输出协议里**每条 change 多一个 about 字段**（这条记忆属于谁），
     入库时按 about 拆到各角色的 charMem:<ownerId>。
     关于 user 的条目不建库 —— 留痕记忆是「角色记住了什么」。 */

  function gmCand() {
    /* v5 12.1：群记忆结算与私聊共用「记忆整理用的模型」（回落主 API） */
    if (Sleepy.summaryEngine && Sleepy.summaryEngine.candFor) {
      return Sleepy.summaryEngine.candFor();
    }
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }
  function gmCall(cand, messages) {
    if (!cand) return Promise.resolve({ ok: false, error: '还没有可用的模型连接' });
    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (res.ok) return { ok: true, text: res.content };
      return { ok: false, error: res.message || '请求失败' };
    }, function (e) {
      return { ok: false, error: (e && e.message) || '请求失败' };
    });
  }
  function gmEntitiesOf(groupId) {
    return Sleepy.groupAI ? Sleepy.groupAI.entitiesOf(groupId) : [];
  }
  function gmNameOf(e) {
    var rec = core.findChar(e.ownerId);
    return (rec && rec.name) || '?';
  }
  function gmRoster(ownerIds) {
    return ownerIds.map(function (oid) {
      var rec = core.findChar(oid);
      var isNpc = rec && rec.kind === 'npc';
      return (rec ? rec.name : '?') + (isNpc ? '（NPC）' : '') + '：' +
        String((rec && rec.content) || '（暂无人设）').slice(0, 160);
    }).join('\n');
  }
  function gmAboutMap(ownerIds) {
    var map = {};
    ownerIds.forEach(function (oid) {
      var rec = core.findChar(oid);
      if (rec && rec.name) map[rec.name] = oid;
    });
    return map;
  }
  function gmExistingBlocks(ownerIds) {
    var M = Sleepy.memoryStore;
    return ownerIds.map(function (oid) {
      var rec = core.findChar(oid);
      var file = M.loadCharMemory(oid);
      var lines = file.memories.filter(function (m) {
        return m.status === 'active' || m.status === 'pending';
      }).slice(0, 15).map(function (m) {
        return m.id + ' [' + m.kind + '] ' + m.content;
      });
      return '【' + ((rec && rec.name) || '?') + ' 的记忆库】' +
        (lines.length ? '\n' + lines.join('\n') : '（空）');
    }).join('\n');
  }
  var GM_RULES = [
    '多人规则（重要）：输出协议不变（changes 数组），但每条 change 必须多带一个 about 字段，',
    '值是名单里的角色名，表示这条记忆写进谁的记忆库（TA 主观知道 / 在意的版本）。',
    '公共事件要按各角色视角分别成条，不要写成一条公共记忆。',
    'user（「我」/梦梦等 user 名字）不建记忆库 —— 不要出现 about=user 的条目。',
    'charState / openLoops / attention 这次都留空。'
  ].join('\n');

  /* 按名单跑一次总结并拆库。transcript 已拼好；cand 为 null 时返回 noapi。
     source: 'online' | 'offline'。opts.autoAnchor：开则 priority=high 入库即锚定。 */
  function gmSettle(ownerIds, transcript, ref, source, cand, callFn, opts) {
    opts = opts || {};
    if (!transcript || !transcript.trim()) {
      return Promise.resolve({ ok: false, error: '没有可整理的内容' });
    }
    var E = Sleepy.promptEngine;
    var sysParts = [];
    try {
      var card = E.cardBody('summary');
      if (card) sysParts.push(card);
    } catch (e) { /* 卡缺失不阻塞 */ }
    sysParts.push('[GROUP]\n' + gmRoster(ownerIds));
    sysParts.push(GM_RULES);

    var userParts = [];
    userParts.push('[SOURCE_RANGE]\n下面是这次的完整记录：\n\n' + transcript);
    var existing = gmExistingBlocks(ownerIds);
    if (existing) {
      userParts.push('[EXISTING_MEMORIES]\n各角色已有的记忆（update/invalidate/supersede 的 replaces 引用对应角色名下的 id）：\n' + existing);
    }
    userParts.push('请按输出协议整理（type=online_period），每条 change 带 about。');

    return callFn(cand, [
      { role: 'system', content: sysParts.filter(Boolean).join('\n\n') },
      { role: 'user', content: userParts.join('\n\n') }
    ]).then(function (r) {
      if (!r.ok) return r;
      var parsed = Sleepy.summaryEngine.parseSummaryJson(r.text);
      if (!parsed || !Array.isArray(parsed.changes)) {
        return { ok: false, error: '解析失败' };
      }
      var map = gmAboutMap(ownerIds);
      var byOwner = {};
      var skipped = 0;
      parsed.changes.forEach(function (c) {
        var owner = c && map[String(c.about || '').trim()];
        if (!owner) { skipped++; return; }
        (byOwner[owner] = byOwner[owner] || []).push(c);
      });
      var added = 0;
      Object.keys(byOwner).forEach(function (oid) {
        var stat = Sleepy.summaryEngine.ingest(oid, { changes: byOwner[oid] }, {
          source: source, ref: ref,
          autoAnchor: opts.autoAnchor === true
        });
        added += stat.added;
      });
      if (!added && skipped) return { ok: false, error: '条目都没对上名单里的角色（' + skipped + ' 条被跳过）' };
      return { ok: true, added: added, skipped: skipped };
    });
  }

  /* ---- 线上累计：阈值触发（30 条 / 6000 字 / 跨 3 活跃日，任一） ---- */
  function gmCursorKey(groupId) { return 'sumCursor:g:' + groupId; }
  function gmShouldRun(groupId) {
    var msgs = Sleepy.groupStore.messagesOf(groupId);
    var cur = store.get(gmCursorKey(groupId)) || { startIdx: 0 };
    var from = Math.min(cur.startIdx || 0, msgs.length);
    var pending = msgs.slice(from);
    if (!pending.length) return false;
    var chars = 0, days = {};
    pending.forEach(function (m) {
      chars += String(m.content || '').length;
      if (m.createdAt) {
        var d = new Date(m.createdAt);
        days[d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())] = 1;
      }
    });
    return pending.length >= 30 || chars >= 6000 || Object.keys(days).length >= 3;
  }
  function gmTranscript(groupId, from, to) {
    return Sleepy.groupStore.messagesOf(groupId).slice(from, to).map(function (m) {
      if (m.type === 'system') return '';
      var mem = Sleepy.groupStore.findMember(groupId, m.senderAccountId);
      var who = mem ? Sleepy.groupStore.accountMeta(mem).name : '?';
      var suffix = m.recalledAt ? '（随后撤回了）' : '';
      if (m.type === 'sticker') return who + '：（发了一个表情：' + (m.name || '') + '）' + suffix;
      if (m.type === 'image') return who + '：（发了一张照片）' + suffix;
      return who + '：' + String(m.content || '') + suffix;
    }).filter(Boolean).join('\n');
  }
  function gmOnlineRun(groupId, opts) {
    opts = opts || {};
    var msgs = Sleepy.groupStore.messagesOf(groupId);
    var cur = store.get(gmCursorKey(groupId)) || { startIdx: 0 };
    var from = Math.min(cur.startIdx || 0, msgs.length);
    if (msgs.length - from > 120) from = msgs.length - 120;
    var transcript = gmTranscript(groupId, from, msgs.length);
    if (!transcript.trim()) {
      store.set(gmCursorKey(groupId), { startIdx: msgs.length, at: Date.now() });
      return Promise.resolve({ ok: false, error: 'empty' });
    }
    var g = Sleepy.groupStore.findGroup(groupId);
    var ownerIds = gmEntitiesOf(groupId).map(function (e) { return e.ownerId; });
    if (!ownerIds.length) return Promise.resolve({ ok: false, error: '群里没有角色' });
    var ref = '群「' + ((g && g.name) || '') + '」线上累计 ' + pad2(new Date().getMonth() + 1) + '-' + pad2(new Date().getDate());
    var cand = gmCand();
    if (!cand) return Promise.resolve({ ok: false, error: 'noapi' });
    return gmSettle(ownerIds, transcript, ref, 'online', cand, gmCall).then(function (r) {
      if (r.ok) {
        store.set(gmCursorKey(groupId), { startIdx: msgs.length, at: Date.now() });
        store.set('sumRawFail:g:' + groupId, null);   /* 成功了就摘掉失败记录 */
        if (opts.toast && Sleepy.toast && r.added) {
          Sleepy.toast('群聊悄悄整理了 ' + r.added + ' 条记忆，去「留痕」看看', 'ok');
        }
      } else if (r.error && r.error !== 'noapi' && r.error !== 'empty') {
        store.set('sumRawFail:g:' + groupId, { at: Date.now(), error: r.error });
      }
      return r;
    });
  }
  var gmRunning = {};
  function gmCheck(groupId) {
    if (gmRunning[groupId]) return;
    if (!gmShouldRun(groupId)) return;
    gmRunning[groupId] = true;
    gmOnlineRun(groupId, { toast: true })['finally'](function () { gmRunning[groupId] = false; });
  }
  function gmRunNow(groupId) {
    if (gmRunning[groupId]) return Promise.resolve({ ok: false, error: '正在整理中' });
    gmRunning[groupId] = true;
    return gmOnlineRun(groupId, { toast: true })['finally'](function () { gmRunning[groupId] = false; });
  }

  /* ---- 线下结算：结束见面时按在场角色拆库（失败可重试） ---- */
  function gmOfflineTranscript(s) {
    var um = userMetaOf(s);
    return (s.messages || []).map(function (m) {
      if (m.role === 'user') return um.name + '：' + (m.text || '');
      if (m.role === 'scene') return '【场景】' + parasText(m.paras);
      if (m.role === 'event') return '（' + (m.title || '') + '）';
      if (m.role === 'photo') return um.name + '：（拍下了一张现场照片）';
      if (m.role === 'turn') {
        return (m.paras || []).map(function (p) {
          return p.speaker ? (p.speaker + '：' + p.text) : ('（' + p.text + '）');
        }).join('\n');
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  function gmOfflineRun(session, opts) {
    opts = opts || {};
    var sid = session.id;
    var ownerIds = (session.participants || []).map(function (p) { return p.ownerId; });
    var transcript = gmOfflineTranscript(session);
    var ref = '第 ' + pad2(session.count) + ' 次见面 · ' + session.sceneName;
    var cand = Sleepy.offlineStore.candForSession(session);
    return gmSettle(ownerIds, transcript, ref, 'offline', cand, function (c, messages) {
      return Sleepy.offlineStore.callModel(c, messages);
    }, {
      /* 「自动沉淀重要时刻」开 → priority=high 的条目入库即锚定 */
      autoAnchor: (session.systemSettings || {}).autoAnchorMoments !== false
    }).then(function (r) {
      if (r.ok) {
        mutate(sid, function (s) { s.summary = { at: Date.now(), added: r.added }; s.summaryError = false; });
        if (opts.toast && Sleepy.toast && r.added) {
          Sleepy.toast('整理出 ' + r.added + ' 条记忆，去「留痕」确认', 'ok');
        }
      } else {
        mutate(sid, function (s) { s.summaryError = r.error || '总结失败'; });
      }
      return r.ok;
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ============================ 对外 ============================ */

  Sleepy.groupOfflineStore = {
    all: all,
    find: find,
    sessionsOf: sessionsOf,
    createFromHandoff: createFromHandoff,
    mutate: mutate,
    appendMessage: appendMessage,
    pause: pause,
    endSession: endSession,
    parseGroupReply: parseGroupReply
  };

  Sleepy.groupMemory = {
    check: gmCheck,
    runNow: gmRunNow,
    settleOffline: gmOfflineRun,
    /* 冒烟用：阈值判断与拆库管线（callFn 可注入，不发真请求） */
    shouldRun: gmShouldRun,
    settle: gmSettle
  };

  Sleepy.groupOfflineUI = {
    openDoorSheet: openDoorSheet,
    chooseOpening: chooseOpening
  };

})(window);
