/* ============================================================
   page-diary.js — 日记（2026-09-19 重做：界面 + 设置 + 自动日记）

   页面：diary（列表）→ diary-edit（写/补写）→ diary-settings（设置）

   数据：
   · diaries: [{ id, content, timestamp, status, author, charId }]
       status: 'written' / 'pending'（待补，老数据）
       author: 'user'（默认，老数据没有这个字段也算 user）/ 'char'（TA 写的）
   · diarySettings: { paper, wallpaper, auto, autoTime }
       paper: ruled | grid | dotted | blank
       wallpaper: plain | cream | mint | sakura | kraft | dusk | 'media:<id>'
   · diaryAuto:<charId>: { lastDate } —— 自动日记的补算游标。
       定时不是 setTimeout（DRAFT.md 教训：刷新就丢），存的是
       「每天几点 + 最后写到哪天」，打开小手机时比对补算。

   自动日记（TA 代笔）：走主 API，角色第一人称，依据 = 角色卡 +
   今天的聊天节选；没有聊天就写 TA 自己的一天（贴合人设作息）。
   入口：设置里「现在写一篇」+ 到点后的启动补算（app.js 喊一声）。

   口子纪律（沿用旧的）：
     读取用 getDiaries()（当前沙盒可见），写回必须用 writableDiaries()
     全量 —— 不然 set 回去一份过滤过的列表，别的存档会被整批抹掉。

   视觉（finesse 过一遍后的取舍）：这页的灵魂是「纸」——
   花字只花在日期头（衬线大数字 + 手写波浪线），信纸卡片靠
   横线/方格/点阵的 repeating-linear-gradient 撑质感，
   不堆渐变不堆光。壁纸全部是浅色纸纹，跟焦糖主色同一族。
   ============================================================ */
(function (global) {
  'use strict';

  global.Sleepy = global.Sleepy || {};
  var Sleepy = global.Sleepy;
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var core = Sleepy.core;
  var h = ui.h;
  var relativeTime = ui.relativeTime;

  /* ============================ 设置 ============================ */

  var SET_KEY = 'diarySettings';
  var DEF = { paper: 'ruled', wallpaper: 'plain', auto: false, autoTime: '22:00', autoPic: true };

  function settings() {
    var s = store.get(SET_KEY) || {};
    var out = {};
    for (var k in DEF) out[k] = s[k] !== undefined ? s[k] : DEF[k];
    return out;
  }
  function saveSettings(patch) {
    var s = settings();
    for (var k in patch) s[k] = patch[k];
    store.set(SET_KEY, s);
  }

  var WALLPAPERS = [
    { id: 'plain', name: '素白' },
    { id: 'cream', name: '奶油' },
    { id: 'mint', name: '薄荷' },
    { id: 'sakura', name: '樱粉' },
    { id: 'kraft', name: '牛皮' },
    { id: 'dusk', name: '暮色' }
  ];
  var PAPERS = [
    { id: 'ruled', name: '横线信纸' },
    { id: 'grid', name: '方格信纸' },
    { id: 'dotted', name: '点阵信纸' },
    { id: 'blank', name: '空白信纸' }
  ];

  /* 日期头下面的小引言：按日期轮换，一天一句 */
  var QUOTES = [
    '把今天折好，夹进这一页。',
    '日子是过出来的，也是记下来的。',
    '小事才值得写。',
    '今天有什么想留住的吗？',
    '写下来，就不会忘得太快。',
    '纸比记忆可靠。',
    '今天也辛苦了。'
  ];

  /* ============================ 数据口子 ============================ */

  function writableDiaries() {
    var list = store.get('diaries');
    return Array.isArray(list) ? list : [];
  }

  /* 向量索引联动（见 memory-vec 的素材源「日记」）。
     **变更时显式喊一声**（施工卡 §5-3），后台跑、失败不挡写日记。 */
  function vecCall(name, args) {
    var mv = Sleepy.memoryVec;
    if (!mv || typeof mv[name] !== 'function') return;
    try { mv[name].apply(mv, args || []); } catch (e) { /* 静默 */ }
  }
  function getDiaries() {
    var list = writableDiaries();
    return (core && core.scoped) ? core.scoped(list) : list;
  }
  /* 写一篇。**归属要盖章**（2026-09-23 向量补源时补）：
       · sandboxId —— 日记属于「写它的那间房」（core.tagScope）。
         不盖的话，有岛时 core.scoped 会把它当别岛的过滤掉 —— 新写的日记
         当场就从列表里消失（这是补归属之前就存在的坑）。
       · userId    —— **user 写的**日记记下写它的是哪个马甲。日记是私密内容
         （方案 §5-2），向量那边按 user:<账号> 分池（见 memory-vec 的 sweepDiary）；
         没有它就做不到「按账号隔离」。char 写的不记 —— 他的日记挂在他自己名下，
         跟 user 用哪个号无关。 */
  function addEntry(rec) {
    var item = core.tagScope({
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      content: String(rec.content || ''),
      timestamp: rec.timestamp || Date.now(),
      status: rec.status || 'written',
      author: rec.author || 'user'
    });
    if (rec.charId) item.charId = rec.charId;
    if (rec.mediaId) item.mediaId = rec.mediaId;   /* 配图（生图 / 相册选图） */
    if (!item.charId) {
      var u = (core.activeUserOnIsland && core.activeUserOnIsland()) || null;
      item.userId = rec.userId || (u && u.id) || null;
    }
    var all = writableDiaries();
    all.push(item);
    store.set('diaries', all);
    /* 新日记进向量库（我写的挂账号池、他写的挂角色池）—— 后台跑 */
    vecCall('sweepDiary');
    return item;
  }
  function patchEntry(id, patch) {
    var all = writableDiaries();
    var hit = null;
    all.forEach(function (x) {
      if (x.id !== id) return;
      for (var k in patch) x[k] = patch[k];
      hit = x;
    });
    store.set('diaries', all);
    /* 正文改了 → **定向重建那一条**（不是重新扫）—— 旧正文不能留在索引里，
       否则 TA 会引用一句你早就改掉的话（见 memory-vec.refreshDiary）。 */
    if (hit) vecCall('refreshDiary', [hit]);
  }
  function removeEntry(id) {
    var all = writableDiaries();
    var hit = null;
    all.forEach(function (x) { if (x.id === id) hit = x; });
    store.set('diaries', all.filter(function (x) { return x.id !== id; }));
    /* 删了就失效（按条目 id 精确命中，不是整个源） */
    if (hit) {
      vecCall('forget', [{
        kind: 'diary', charId: hit.charId || null,
        userId: hit.userId || null, sourceId: 'diary', ids: [id]
      }]);
    }
  }

  function charNameOf(d) {
    var c = d.charId && core.findChar ? core.findChar(d.charId) : null;
    return c ? c.name : 'TA';
  }

  /* ============================ 自动日记 ============================ */

  function autoStateKey(charId) { return 'diaryAuto:' + charId; }
  function ymd(d) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function hhmmOf(d) {
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function weekCn(d) { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]; }

  var autoRunning = {};

  /* 写一篇（force=true 表示手动「现在写一篇」，无视开关和游标） */
  function autoCheck(opts) {
    opts = opts || {};
    var force = !!opts.force;
    var st = settings();
    if (!st.auto && !force) return Promise.resolve({ ok: false, why: 'off' });
    /* 指针卫兵：写日记的人必须在本岛名册里 —— 指针停在上一个岛的人身上时
       宁可不写，也绝不能替别的岛的 TA 代笔（清查 §5.1）。 */
    var ch = core.activeCharOnIsland
      ? core.activeCharOnIsland()
      : (core.activeChar ? core.activeChar() : null);
    if (!ch) return Promise.resolve({ ok: false, why: 'nochar' });

    var key = autoStateKey(ch.id);
    var state = store.get(key) || { lastDate: '' };
    var now = new Date();
    var today = ymd(now);
    if (!force && state.lastDate === today) return Promise.resolve({ ok: false, why: 'done' });
    if (!force && hhmmOf(now) < (st.autoTime || '22:00')) return Promise.resolve({ ok: false, why: 'early' });
    if (autoRunning[ch.id]) return Promise.resolve({ ok: false, why: 'busy' });
    autoRunning[ch.id] = true;

    /* 游标先落，防短时间内反复触发；失败再回滚，明天/下次打开还会补 */
    state.lastDate = today;
    store.set(key, state);

    return writeCharDiary(ch.id).then(function (r) {
      autoRunning[ch.id] = false;
      /* 名字跟着**写入的人**一起带出去 —— 调用方别再去读全局指针，
         那时指针可能已经飘到别的岛了（清查 §5.1）。 */
      if (r.ok) { r.who = ch.name; return r; }
      store.set(key, { lastDate: '' });   /* 失败回滚，允许重试 */
      return r;
    }, function (e) {
      autoRunning[ch.id] = false;
      store.set(key, { lastDate: '' });
      return { ok: false, error: (e && e.message) || '写入失败' };
    });
  }

  /* 日记正文和 [图] 描述拆开（AI 代笔的输出可能带配图行）。
     纯函数，冒烟里单测。 */
  function splitDiaryImg(raw) {
    var text = [];
    var imgDesc = '';
    String(raw == null ? '' : raw).split(/\r?\n/).forEach(function (ln) {
      var t = String(ln).trim();
      if (!t) { text.push(t); return; }
      var m = /^\[\s*图\s*\]\s*([\s\S]*)$/.exec(t);
      if (m && m[1].trim()) { imgDesc = m[1].trim().slice(0, 240); return; }   /* B0：结构化 JSON 需要更长 */
      text.push(t);
    });
    return { text: text.join('\n').trim(), imgDesc: imgDesc };
  }

  function diaryCand() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }

  /* 今天的聊天节选（跟总结引擎同款格式，简版）。
     人由调用方传进来（写谁的日记就采谁的聊天）—— 这里**不读全局指针**：
     指针停在上一个岛的人身上时会采错人的聊天（清查 §5.1）。 */
  function transcriptToday(charName, charId) {
    var chats = (core.scoped ? core.scoped(store.get('chats') || []) : (store.get('chats') || []));
    /* 采的是「当前账号 × 这个角色」那一条 —— 只按角色找会把小号今天说的话
       当成大号说的写进日记（两个身份的话混在一篇里）。 */
    var chat = (charId && Sleepy.chatStore && Sleepy.chatStore.chatOf)
      ? Sleepy.chatStore.chatOf(charId) : null;
    if (!chat && charId) chats.forEach(function (c) { if (!chat && c.characterId === charId) chat = c; });
    var msgs = (chat && chat.messages) || [];
    var today = ymd(new Date());
    var lines = [];
    for (var i = msgs.length - 1; i >= 0 && lines.length < 30; i--) {
      var m = msgs[i];
      if (!m.timestamp || ymd(new Date(m.timestamp)) !== today) continue;
      var who = m.role === 'user' ? '对方' : charName;
      lines.unshift(who + '：' + String(m.content || '').slice(0, 80));
    }
    return lines.join('\n');
  }

  function writeCharDiary(charId) {
    var cand = diaryCand();
    if (!cand) return Promise.resolve({ ok: false, error: '主 API 没配，写不了' });
    var ch = core.findChar(charId);
    if (!ch) return Promise.resolve({ ok: false, error: '找不到当前角色' });

    var now = new Date();
    var dateLine = now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' +
      now.getDate() + ' 日 ' + weekCn(now);
    var transcript = transcriptToday(ch.name);
    /* 配图开关：关了就不教 [图]，模型想配也配不了 */
    var canPic = settings().autoPic !== false &&
      !!(Sleepy.imggen && Sleepy.imggen.readEnabled() && Sleepy.imggen.activeApi());

    var sys = [
      '你是「' + ch.name + '」，现在要写今天的日记。',
      ch.content ? '[CHARACTER]\n' + ch.content + '\n[/CHARACTER]' : '',
      '【写日记的要求】',
      '- 第一人称「我」，150~300 字',
      '- 语气、用词、关心的事都按角色设定来',
      '- 只能写你今天真实经历的：聊天节选里你的言行与感受；没聊天就写你自己的一天（贴合人设的生活和作息，不编造跟对方的大事件）',
      '- 这是写给自己看的日记，不是发给对方的消息。可以提到对方，但用你平时的称呼',
      '- 不总结、不升华，结尾停在一件具体的小事上',
      canPic
        ? '- 想配一幅插图的话，在正文最后一行单独写一行 [图]，后面跟一段 JSON：{"description":"画面描述，英文 tag 风格","contentType":"scene|object|person|mixed","shot":"auto|selfie|portrait|full|candid|group|scene","subjects":["user","char"]}（subjects 只写画面里真实出现的人：你是 "char"，对方是 "user"；只拍到桌面/窗外/风景就留 []；不想配就不写这行，也别每次都配；写不了 JSON 才退回一句话描述）'
        : '- 不要写 [图] 行（现在配不了图）',
      '- 除了 [图] 行，只输出日记正文：不要日期抬头，不要标题，不要任何解释'
    ].filter(Boolean).join('\n\n');

    var user = '[今天] ' + dateLine + '\n[今天的聊天节选]\n' +
      (transcript || '（今天还没有聊天）');

    return Sleepy.api.requestOnce(cand, [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], {}).then(function (res) {
      if (!res.ok) return { ok: false, error: Sleepy.api.describeError(res) };
      var raw = String(res.content || '').trim()
        .replace(/^```(?:markdown|text)?\s*|\s*```$/g, '')
        .replace(/^["「」]+|["「」]+$/g, '').trim();
      var parsed = splitDiaryImg(raw);
      if (!parsed.text) return { ok: false, error: '这次没写出来' };
      var item = addEntry({ author: 'char', charId: charId, content: parsed.text });
      maybeDiaryPic(ch, parsed.imgDesc, item);
      return { ok: true, item: item };
    }, function (e) {
      return { ok: false, error: (e && e.message) || '请求失败' };
    });
  }

  /* 日记配图（生图接口）：autoPic 开关开 + 接口可用才画，画完落回条目。
     顺手喂给聊天页的多模态缓存 —— 之后 TA 在聊天里「偷看」这篇日记时
     第一轮就能看见图。
     B0：[图] 里带结构化 JSON → 按 plan 画（主体由 subjects 决定，
     日记里也可以只画风景/物件）；还是一句话 → legacy：按正则猜 shot
     并默认锁 char（旧行为，标 legacyFallback 供验收定位）。 */
  function maybeDiaryPic(ch, imgDesc, item) {
    if (!imgDesc || !item) return;
    if (settings().autoPic === false) return;
    if (!(Sleepy.imggen && Sleepy.imggen.readEnabled() && Sleepy.imggen.activeApi())) return;
    var parsed = Sleepy.imggen.parsePlanJson(imgDesc);
    var genOpts;
    if (parsed) {
      var me = (core.activeUserOnIsland && core.activeUserOnIsland()) || null;
      var subs = [];
      parsed.subjects.forEach(function (k) {
        if (k === 'char') subs.push(Sleepy.imggen.subjectForChar(ch, parsed.shot));
        else if (k === 'user' && me) subs.push(Sleepy.imggen.subjectForUser(me, parsed.shot));
      });
      genOpts = { plan: {
        sender: 'char', contentType: parsed.contentType, shot: parsed.shot,
        subjects: subs, description: parsed.description
      } };
    } else {
      var shot = /selfie|自拍|近照/i.test(imgDesc) ? 'selfie' : '';
      genOpts = {
        subject: imgDesc,
        faceText: Sleepy.imggen.faceTextFor(ch, shot),
        gender: ch,
        legacyFallback: true
      };
    }
    Sleepy.imggen.generate(genOpts).then(function (r) {
      if (!(r.ok && r.mediaId)) return;
      patchEntry(item.id, { mediaId: r.mediaId });
      if (Sleepy.chatVision) Sleepy.chatVision.preloadPhotoData(r.mediaId);
    });
  }

  /* ============================ 页面：日记 ============================ */

  Sleepy.register('diary', {
    title: '日记',
    render: function (ctx) {
      var body = ctx.body;

      var page = h('div', 'dia-page');
      body.appendChild(page);

      /* ---- 壁纸 ----
         铺在整页（section 级）而不是内容层：顶栏是透明的，
         铺上去之后顶栏后面露出来的才是同一张纸。
         换壁纸要等 onShow→rebuild 时也重刷一遍（设置页在另一层）。 */
      var lastWall = null;
      function applyWallpaper() {
        var el = ctx.el;
        var wp = settings().wallpaper;
        if (lastWall === wp) return;
        if (lastWall) el.classList.remove('dia-wall-' + lastWall);
        el.style.removeProperty('background-image');
        lastWall = wp;
        var builtin = WALLPAPERS.some(function (w) { return w.id === wp; });
        if (builtin) {
          el.classList.add('dia-wall-' + wp);
        } else if (wp.indexOf('media:') === 0 && Sleepy.media) {
          Sleepy.media.url(wp.slice(6)).then(function (u) {
            if (u && el.isConnected) {
              el.style.backgroundImage =
                'linear-gradient(rgba(255,255,255,.78),rgba(255,255,255,.78)), url(' + u + ')';
            }
          });
        }
      }

      /* ---- 日期头（花字只在这里）---- */
      var now = new Date();
      var head = h('header', 'dia-head');
      var gear = h('button', 'dia-gear');
      gear.type = 'button';
      gear.title = '日记设置';
      gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></svg>';
      gear.addEventListener('click', function () { ctx.open('diary-settings', {}); });
      head.appendChild(gear);

      head.appendChild(h('p', 'dia-head-month', (now.getMonth() + 1) + '月 · ' + weekCn(now)));
      head.appendChild(h('p', 'dia-head-day', String(now.getDate())));
      /* 手写感的波浪线（花字的第二笔）。svg 要走 innerHTML ——
         h() 的第三参是字符串时按纯文本处理，直接传会整段显示成源码 */
      var wave = h('div', 'dia-head-wave');
      wave.innerHTML = '<svg viewBox="0 0 120 8" preserveAspectRatio="none"><path d="M2 5 C 12 1, 22 1, 32 5 S 52 9, 62 5 S 82 1, 92 5 S 112 9, 118 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      head.appendChild(wave);
      head.appendChild(h('p', 'dia-head-quote', QUOTES[now.getDate() % QUOTES.length]));
      page.appendChild(head);

      /* ---- 列表 ---- */
      var feed = h('div', 'dia-feed');
      page.appendChild(feed);

      var empty = h('div', 'dia-empty');
      empty.appendChild(h('div', 'dia-empty-seal', '记'));
      empty.appendChild(h('p', 'dia-empty-text', '这一页还空着'));
      empty.appendChild(h('p', 'dia-empty-hint', '点右下角的笔，让 TA 写点什么，或者自己写一篇'));
      page.appendChild(empty);

      /* FAB：点开两选一 —— 这本子主打「看 TA 写」，但自己也写得 */
      var fab = h('button', 'fab-btn dia-fab');
      fab.type = 'button';
      fab.title = '写一篇';
      fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20z"/><path d="M13.5 6.5l3 3"/></svg>';
      page.appendChild(fab);

      var sheet = h('div', 'dia-fab-sheet');
      var mask = h('div', 'dia-fab-mask');
      var menu = h('div', 'dia-fab-menu');
      var bChar = h('button', 'dia-fab-item', '让 TA 写一篇');
      bChar.type = 'button';
      bChar.appendChild(h('span', 'dia-fab-item-hint', '以 TA 的口吻，写 TA 的今天'));
      var bMe = h('button', 'dia-fab-item', '我自己写');
      bMe.type = 'button';
      bMe.appendChild(h('span', 'dia-fab-item-hint', '写给自己的，TA 平时看不到'));
      menu.appendChild(bChar);
      menu.appendChild(bMe);
      sheet.appendChild(mask);
      sheet.appendChild(menu);
      page.appendChild(sheet);

      function closeSheet() { sheet.classList.remove('is-open'); }
      mask.addEventListener('click', closeSheet);
      bMe.addEventListener('click', function () {
        closeSheet();
        ctx.open('diary-edit', { id: '' });
      });
      bChar.addEventListener('click', function () {
        closeSheet();
        /* 卫兵同 autoCheck：别岛的人不能替写 */
        var ch = core.activeCharOnIsland
          ? core.activeCharOnIsland()
          : (core.activeChar ? core.activeChar() : null);
        if (!ch) { ctx.toast('这座岛还没选人 —— 先落岛选一位，或去切号器换', 'warn'); return; }
        ctx.toast('TA 正在构思…', 'ok');
        autoCheck({ force: true }).then(function (r) {
          if (r.ok) {
            ctx.toast('写好了', 'ok');
            ctx.rebuild && ctx.rebuild();
          } else if (r.why === 'busy') {
            ctx.toast('正在写呢', 'warn');
          } else {
            ctx.toast(r.error || '这次没写成', 'err');
          }
        });
      });
      fab.addEventListener('click', function () { sheet.classList.add('is-open'); });

      function rebuild() {
        var list = getDiaries().slice().sort(function (a, b) {
          return (b.timestamp || 0) - (a.timestamp || 0);
        });
        var cur = settings();

        feed.innerHTML = '';
        empty.style.display = list.length ? 'none' : '';

        list.forEach(function (d) {
          var written = d.status !== 'pending';
          var dt = new Date(d.timestamp || Date.now());
          var item = h('article', 'dia-paper dia-paper-' + (PAPERS.some(function (p) { return p.id === cur.paper; }) ? cur.paper : 'ruled'));
          item.dataset.id = d.id || '';   /* 时光跳转定位用（weNav revealInPage） */

          var meta = h('div', 'dia-meta');
          var stamp = h('span', 'dia-stamp',
            (dt.getMonth() + 1) + '月' + dt.getDate() + '日 · ' + weekCn(dt));
          meta.appendChild(stamp);
          if ((d.author || 'user') === 'char') {
            meta.appendChild(h('span', 'dia-author', '✒ ' + charNameOf(d) + ' 写的'));
          } else {
            /* 双方都在写：作者标始终亮出来，谁的日记一眼分清 */
            meta.appendChild(h('span', 'dia-author', '你写的'));
          }
          if (!written) meta.appendChild(h('span', 'dia-author is-pending-tag', '待补'));
          item.appendChild(meta);

          var text = h('p', 'dia-text', d.content || '');
          if (!written) text.classList.add('is-pending');
          item.appendChild(text);

          /* 配图：TA 生成的插画 / 你从相册选的那张 */
          if (d.mediaId && Sleepy.media) {
            var pic = h('div', 'dia-pic');
            var pimg = h('img', 'dia-pic-img');
            pimg.alt = '配图';
            pimg.addEventListener('error', function () {
              if (pimg.parentNode) pimg.parentNode.removeChild(pimg);
            });
            pic.appendChild(pimg);
            Sleepy.media.url(d.mediaId).then(function (u) { if (u) pimg.src = u; });
            item.appendChild(pic);
          }

          if (!written) {
            var foot = h('div', 'dia-foot');
            var write = h('button', 'dia-foot-btn', '现在补写');
            write.type = 'button';
            write.addEventListener('click', function () { ctx.open('diary-edit', { id: d.id }); });
            foot.appendChild(write);
            item.appendChild(foot);
          } else {
            var t = h('span', 'dia-rel', relativeTime(d.timestamp));
            item.appendChild(t);
          }
          feed.appendChild(item);
        });
      }

      ctx.rebuild = function () {
        applyWallpaper();
        rebuild();
        /* 到点补算：列表刷新时顺手喊一声，写完原地多出一篇 */
        autoCheck().then(function (r) {
          if (r && r.ok && page.isConnected) {
            ctx.toast('「' + (r.who || 'TA') + '」写了一篇日记', 'ok');
            rebuild();
          }
        });
      };
      ctx.rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ============================ 页面：写日记 ============================ */

  Sleepy.register('diary-edit', {
    title: '写日记',
    render: function (ctx) {
      var body = ctx.body;
      body.innerHTML = '';
      var id = ctx.params.id || '';
      var existing = null;
      if (id) {
        getDiaries().forEach(function (d) { if (d.id === id) existing = d; });
        if (!existing) { ctx.back(); return; }
      }
      if (existing) ctx.setTitle('补写这篇');

      var st = settings();
      var paper = h('div', 'dia-paper dia-paper-' + st.paper + ' dia-edit-paper');
      var ta = ui.textArea({
        label: '',
        hint: '写给自己的。日期会自动记下来。',
        value: existing ? (existing.content || '') : '',
        rows: 12,
        counter: true
      });
      paper.appendChild(ta.el);

      /* ---- 配图：从相册选一张（AI 代笔的日记由生图画，这里是你自己贴） ---- */
      var myPic = (existing && existing.mediaId) || '';
      var picRow = h('div', 'dia-edit-pic');
      var picImg = h('img', 'dia-edit-pic-img');
      function paintPic() {
        picRow.innerHTML = '';
        if (myPic && Sleepy.media) {
          picImg.src = '';
          Sleepy.media.url(myPic).then(function (u) { if (u) picImg.src = u; });
          picRow.appendChild(picImg);
          var rm = h('button', 'dia-edit-pic-rm', '拿掉');
          rm.type = 'button';
          rm.addEventListener('click', function () { myPic = ''; paintPic(); });
          picRow.appendChild(rm);
        } else {
          var add = h('button', 'dia-edit-pic-add', '📷 贴一张图');
          add.type = 'button';
          add.addEventListener('click', pickPic);
          picRow.appendChild(add);
          picRow.appendChild(h('span', 'dia-edit-pic-hint', '可不留'));
        }
      }
      function pickPic() {
        if (!Sleepy.media) { ctx.toast('图库不可用', 'warn'); return; }
        var inp = h('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.addEventListener('change', function () {
          var f = inp.files && inp.files[0];
          if (!f) return;
          Sleepy.media.available().then(function (yes) {
            if (!yes) { ctx.toast('图库打不开', 'warn'); return; }
            Sleepy.media.shrink(f).then(function (r) {
              return Sleepy.media.put(r.blob, { name: '日记配图', kind: 'photo', w: r.w, h: r.h });
            }).then(function (mid) {
              myPic = mid;
              if (Sleepy.chatVision) Sleepy.chatVision.preloadPhotoData(mid);
              paintPic();
            }, function (e) {
              ctx.toast('没存上：' + ((e && e.message) || e), 'err');
            });
          });
        });
        inp.click();
      }
      paintPic();
      paper.appendChild(picRow);
      body.appendChild(paper);

      var row = h('div', 'btn-row');
      if (existing) {
        var del = ui.button('删除', 'danger', function () {
          ui.confirm({ title: '撕掉这一页？', ok: '撕掉', danger: true }).then(function (yes) {
            if (!yes) return;
            removeEntry(existing.id);
            ctx.toast('撕掉了', 'ok');
            ctx.back();
          });
        });
        row.appendChild(del);
      }
      var save = ui.button('写好了', 'primary', function () {
        var text = String(ta.get() || '').trim();
        if (!text) { ctx.toast('还没写呢', 'warn'); return; }
        if (existing) {
          var patch = { content: text, status: 'written', timestamp: Date.now() };
          patch.mediaId = myPic || null;   /* 拿掉了也要能落库成「没图」 */
          patchEntry(existing.id, patch);
        } else {
          var item = addEntry({ author: 'user', content: text, mediaId: myPic || '' });
          /* 递一张「TA 写了日记」的字条：下一轮对话里 TA 会知道，
             可以选择偷看 / 尊重隐私 / 直接问你能不能看（见 page-chat diaryPeekMsg）。
             卫兵：字条只递给本岛的人 —— 指针残留时宁可不递。 */
          var ch = core.activeCharOnIsland ? core.activeCharOnIsland() : null;
          /* 项目 5 S6：字条按 root 递（page-chat 的读取侧也归 root）——
             用皮套聊着天，字条也得能被同一个大脑读到。 */
          if (ch) {
            var peekTo = (core.rootIdOf ? core.rootIdOf(ch.id) : ch.id) || ch.id;
            store.set('diaryPeek:' + peekTo, { entryId: item.id, at: Date.now() });
          }
        }
        ctx.toast('收进本子里了', 'ok');
        ctx.back();
      });
      row.appendChild(save);
      body.appendChild(row);

      ctx.setActions([{ label: '写好了', kind: 'primary', onClick: function () { save.click(); } }]);
    }
  });

  /* ============================ 页面：日记设置 ============================ */

  Sleepy.register('diary-settings', {
    title: '日记设置',
    render: function (ctx) {
      var body = ctx.body;

      function build() {
        body.innerHTML = '';
        var st = settings();

        /* ---- 外观 ---- */
        var g1 = ui.group('外观', '换一张纸，换一种心情。');
        var wallRow = h('div', 'dia-wall-row');
        WALLPAPERS.forEach(function (w) {
          var chip = h('button', 'dia-wall-chip' + (st.wallpaper === w.id ? ' is-on' : ''));
          chip.type = 'button';
          chip.appendChild(h('span', 'dia-wall-swatch dia-wall-' + w.id));
          chip.appendChild(h('span', 'dia-wall-name', w.name));
          chip.addEventListener('click', function () {
            saveSettings({ wallpaper: w.id });
            ctx.toast('换了「' + w.name + '」', 'ok');
            build();
          });
          wallRow.appendChild(chip);
        });
        var customChip = h('button', 'dia-wall-chip' + (st.wallpaper.indexOf('media:') === 0 ? ' is-on' : ''));
        customChip.type = 'button';
        customChip.appendChild(h('span', 'dia-wall-swatch dia-wall-custom', '+'));
        customChip.appendChild(h('span', 'dia-wall-name', '用一张图'));
        customChip.addEventListener('click', function () {
          var inp = h('input');
          inp.type = 'file';
          inp.accept = 'image/*';
          inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            if (!f || !Sleepy.media) return;
            Sleepy.media.put(f, { name: '日记壁纸', kind: 'image' }).then(function (mid) {
              saveSettings({ wallpaper: 'media:' + mid });
              ctx.toast('壁纸换好了', 'ok');
              build();
            }, function (e) {
              ctx.toast('没存上：' + ((e && e.message) || e), 'err');
            });
          });
          inp.click();
        });
        wallRow.appendChild(customChip);
        g1.card.appendChild(wallRow);

        var paperRow = h('div', 'dia-paper-row');
        PAPERS.forEach(function (p) {
          var chip = h('button', 'dia-paper-chip' + (st.paper === p.id ? ' is-on' : ''));
          chip.type = 'button';
          chip.appendChild(h('span', 'dia-paper-swatch dia-paper-' + p.id));
          chip.appendChild(h('span', 'dia-wall-name', p.name));
          chip.addEventListener('click', function () {
            saveSettings({ paper: p.id });
            ctx.toast('换成' + p.name, 'ok');
            build();
          });
          paperRow.appendChild(chip);
        });
        g1.card.appendChild(paperRow);
        body.appendChild(g1.wrap);

        /* ---- 自动日记 ---- */
        /* 展示也过卫兵：说的得是「这座岛会写的那个人」 */
        var ch = core.activeCharOnIsland
          ? core.activeCharOnIsland()
          : (core.activeChar ? core.activeChar() : null);
        var g2 = ui.group('自动日记',
          '到点后第一次打开小手机时，「' + (ch ? ch.name : 'TA') + '」会自己补上。不弹通知，安静地写。');

        var swAuto = ui.switchField({
          label: '让 TA 每天写一篇',
          hint: '写的是 TA 的日记（第一人称）',
          value: st.auto
        });
        swAuto.input.addEventListener('change', function () {
          saveSettings({ auto: swAuto.get() });
          ctx.toast(swAuto.get() ? '好，TA 每天都会写' : '关掉了', 'ok');
        });
        g2.card.appendChild(swAuto.el);

        var timeRow = ui.row({
          label: '每天几点写',
          badge: st.autoTime || '22:00',
          onClick: function () {
            ui.prompt({
              title: '每天几点写',
              value: st.autoTime || '22:00',
              placeholder: '22:00',
              note: '24 小时制，比如 22:00'
            }).then(function (v) {
              if (v === null) return;
              var t = String(v).trim();
              if (!/^\d{1,2}:\d{2}$/.test(t) ||
                  parseInt(t.split(':')[0], 10) > 23 || parseInt(t.split(':')[1], 10) > 59) {
                ctx.toast('格式像这样：22:00', 'warn');
                return;
              }
              var parts = t.split(':');
              saveSettings({ autoTime: ('0' + parseInt(parts[0], 10)).slice(-2) + ':' + parts[1] });
              build();
            });
          }
        });
        g2.card.appendChild(timeRow);
        /* 「由谁写」不设行 —— 日记本来就开在私聊语境里，写的就是当前角色 */

        var canPicNow = !!(Sleepy.imggen && Sleepy.imggen.readEnabled() && Sleepy.imggen.activeApi());
        var swPic = ui.switchField({
          label: '让 TA 的日记配插图',
          hint: canPicNow
            ? 'TA 写完日记会按内容画一幅（也可能不配）'
            : '要先去 设置 → 生图 配一个接口才画得出来',
          value: st.autoPic !== false
        });
        swPic.input.addEventListener('change', function () {
          saveSettings({ autoPic: swPic.get() });
          ctx.toast(swPic.get() ? '好，日记可以配图了' : '不配图了', 'ok');
        });
        g2.card.appendChild(swPic.el);

        var nowBtn = ui.button('让 TA 现在写一篇', 'primary', function () {
          if (!ch) { ctx.toast('先去名片夹加一个角色', 'warn'); return; }
          nowBtn.disabled = true;
          nowBtn.textContent = '正在写…';
          autoCheck({ force: true }).then(function (r) {
            nowBtn.disabled = false;
            nowBtn.textContent = '让 TA 现在写一篇';
            if (r.ok) {
              ctx.toast('写好了，去列表看', 'ok');
              build();
            } else if (r.why === 'busy') {
              ctx.toast('正在写呢', 'warn');
            } else {
              ctx.toast(r.error || '没写成', 'err');
            }
          });
        });
        nowBtn.style.margin = '10px 0 2px';
        g2.card.appendChild(nowBtn);
        body.appendChild(g2.wrap);
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ============================ 对外 ============================ */

  /* app.js 启动后喊一声：到点的自动日记在这里补算 */
  Sleepy.diary = {
    autoCheck: autoCheck,
    settings: settings,
    splitDiaryImg: splitDiaryImg,
    /* 读口子（2026-09-22 加，给 L1.5 近期生活动态用）。
       **只给读** —— 写一律走 addEntry / patchEntry，别从外面 set 回一份
       过滤过的列表（那是「别的存档被整批抹掉」的老坑）。 */
    list: getDiaries
  };

})(window);
