/* ============================================================
   page-collection.js — We 收藏馆（门厅 + 藏品详情，首轮纵向闭环）
   ------------------------------------------------------------
   定位（docs/勘察-We收藏馆-2026-09-27.md + 拍板 §二/§三）：
   收藏馆不占桌面格，只从 We 首页「去收藏馆 →」进入。
   首轮两层：门厅（馆名 + 关系标题 + 真实 weEntries 按 kind 分组 + 真实计数
   + We 语境空态 + 页面内滚动）；藏品详情（title / note / at / kind / createdBy
   / sourceType / sourceId/sourceRef / refCharId/refUserId / 来源是否仍存在 /
   来源失效时降级文案）。

   数据模型（拍板 §一）：不新增 weCollection 独立表，继续用 weEntries 做主表，
   在其上加可选 kind 字段（ticket/photo/letter/music/gift/place/other）。
   老记录没有 kind → 详情页按 'other' 兼容（复用 Sleepy.weStore.kindOf）。
   不改 favorites 结构；不自动搬任何聊天收藏/照片/票根进馆 ——
   只有用户主动创建/确认的 weEntry 才在馆里。

   隔离与生命周期（拍板 §六）：读一律走
     core.scopeId() / core.activeSandbox() / core.activeCharOnIsland()
     core.activeUserOnIsland() / core.scoped(store.get('weEntries'))
   不自维护 activeSandboxId，We 内不提供切岛入口。
   切岛后 onShow 重读重画 → 当前岛数据刷新；原岛藏品不可见，回岛恢复。
   详情页只打开当前 scoped 列表中的记录，禁止通过 params 跨岛读取任意 id
   —— 详情页按 id 在 scoped 列表里查找，找不到就显示「来源已不在」。

   来源复核（拍板 §四，本轮只复核 + 展示，不做跨 App 回源跳转）：
     sourceType/sourceId 为空        →「手动记录」
     原物存在                        → 来源类型 + 来源标题/摘要
     原物已完成（日历 completed）     →「来源已完成 · …」（有效历史来源，不算失效）
     原物已删除/取消                 → 对应降级文案（原对话已删除 / 该约定已取消
                                      / 原日历记录已删除 / 原图已删除 / 原作品已不在门厅）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;

  function arr(v) { return Array.isArray(v) ? v : []; }

  /* 分类中文名：优先用 weStore 导出的同款映射（老记录兼容逻辑同源），
     页面级兜底一份，避免依赖顺序问题。 */
  var KIND_LABEL = (Sleepy.weStore && Sleepy.weStore.KIND_LABEL) || {
    ticket: '票根', photo: '照片', letter: '信件', music: '音乐',
    gift: '礼物', place: '地方', other: '其他'
  };
  var KIND_ORDER = ['ticket', 'photo', 'letter', 'music', 'gift', 'place', 'other'];

  function kindOf(en) {
    return (Sleepy.weStore && Sleepy.weStore.kindOf) ? Sleepy.weStore.kindOf(en) :
      (KIND_ORDER.indexOf(en && en.kind) >= 0 ? en.kind : 'other');
  }

  /* 来源类型中文名（展示 + 复核用）。 */
  var SRC_LABEL = {
    manual: '手记', chat: '聊天', calendar: '日历', moments: '朋友圈',
    photo: '照片', offline: '线下', ticket: '票根', moment: '聊天'
  };
  function srcLabel(t) { return SRC_LABEL[t] || t || '未知'; }

  /* ------------------------- 来源复核 -------------------------
     只判断「原物是否还在」，不做跳转。返回 { status, text }：
       manual / gone / done / live
     done＝来源事件已完成，是有效历史来源，**不算失效**（保留原物）；
     复核口径跟随各真实数据源的当前状态，fail closed（拿不准就算 gone）。 */
  function checkSource(en) {
    var st = String(en.sourceType || '').trim();
    var id = en.sourceId || null;
    if (!st || st === 'manual' || !id) {
      return { status: 'manual', text: '手动记录' };
    }
    try {
      if (st === 'calendar') {
        /* 日历四态（语义红线：completed 是有效的历史来源，不算失效）：
           scheduled/pending/tentative/confirmed → live「来源仍在」
           completed                              → done「来源已完成」（保留，不算 gone）
           cancelled                              → gone「该约定已取消」（事件还在，只是取消了）
           事件不存在（真被删掉，只可能是草稿/生成日程）→ gone「原日历记录已删除」 */
        var cal = Sleepy.calendar;
        var ev = cal && cal.getEvent ? cal.getEvent(id) : null;
        if (!ev) {
          return { status: 'gone', text: '原日历记录已删除' };
        }
        if (ev.status === 'cancelled') {
          return { status: 'gone', text: '该约定已取消' };
        }
        if (ev.status === 'completed') {
          return { status: 'done', text: '日历 · ' + String(ev.title || '').trim() };
        }
        return { status: 'live', text: '日历 · ' + String(ev.title || '').trim() };
      }
      if (st === 'offline') {
        var off = Sleepy.offlineStore;
        var s = off && off.findSession ? off.findSession(id) : null;
        if (s) {
          return { status: 'live', text: '线下 · ' + String(s.title || s.name || '一段线下时光').slice(0, 40) };
        }
        return { status: 'gone', text: '那段线下时光已不在' };
      }
      if (st === 'chat') {
        /* 聊天收藏：favorites 里还能找到这条快照即原物仍在 */
        var fav = arr(store.get('favorites')).filter(function (f) {
          return f && (f.id === id || f.savedAt === en.at);
        });
        if (fav.length) return { status: 'live', text: '收藏 · ' + String(fav[0].content || '').slice(0, 40) };
        return { status: 'gone', text: '原对话已删除' };
      }
      if (st === 'moment') {
        /* char 记一笔提议入馆的：来源就是提议发生的那场对话 */
        var mc = (Sleepy.chatStore && Sleepy.chatStore.getChat)
          ? Sleepy.chatStore.getChat(id) : null;
        return mc
          ? { status: 'live', text: '你们聊出来的时刻' }
          : { status: 'gone', text: '原对话已删除' };
      }
      if (st === 'photo') {
        var ph = Sleepy.photos;
        var found = ph && ph.all ? arr(ph.all()).some(function (p) { return p && p.id === id; }) : false;
        return found ? { status: 'live', text: '照片' } : { status: 'gone', text: '原图已删除' };
      }
      if (st === 'moments') {
        return { status: 'gone', text: '原作品已不在门厅' };
      }
      if (st === 'ticket') {
        /* 帷境票根：全局 wjTickets。**口径唯一**：weEntries.sourceId 引用的是
           票根**实体自身**的 ticket.id（'tk-' 前缀），不是 workId ——
           workId 指向 wjWorks 里的作品，若哪天要做「作品来源」是另一种
           sourceType 的语义，不许混用（本版没有这个类型，fail closed）。 */
        var ticks = arr(store.get('wjTickets'));
        if (ticks.some(function (t) { return t && t.id === id; })) {
          return { status: 'live', text: '票根' };
        }
        return { status: 'gone', text: '原票根已不在' };
      }
      /* 未知来源类型：不瞎猜，当「原物可能不在了」处理但不报错 */
      return { status: 'gone', text: '来源已不在' };
    } catch (e) {
      return { status: 'gone', text: '来源已不在' };
    }
  }

  /* ------------------------- 日期/身份工具 ------------------------- */
  function fmtDay(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var m = d.getMonth() + 1, dd = d.getDate();
    return (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }
  function fmtFull(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var y = d.getFullYear();
    return y + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* 关系标题：与 We 首页同口径（角色 × 我）。无身份时回退到岛名。 */
  function relationTitle(sid) {
    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (char && user) {
      return String(char.name || '未命名').trim() + ' × ' + core.labelOfUser(user, '我');
    }
    var sb = core.activeSandbox();
    return (sb && sb.name) ? sb.name : '收藏馆';
  }

  /* ------------------------- 读（隔离入口，唯一出口） -------------------------
     只读当前 scoped 的 weEntries，按时间倒序。切岛后 onShow 重读即换批。
     at 通常是数字时间戳，但 char 提议入馆的记录 at 继承事件 startAt
     （日期字符串）—— 减法会 NaN，这里归一：解析不出就当 0，保持原序。 */
  function atNum(v) {
    if (typeof v === 'number') return v;
    var n = new Date(v).getTime();
    return isNaN(n) ? 0 : n;
  }
  function entries() {
    var list = core.scoped(arr(store.get('weEntries'))).slice();
    /* —— 并馆（wj-data §5.1 原设计：聊天收藏按岛 + 票根全局并进收藏馆）——
       2026-10-08 用户反馈：聊天收藏只落 favorites，收藏馆里看不到；票根同病
       （帷境谢幕 toast 说「收进收藏馆了」但馆里没有）。修法 = 并馆展示、
       不搬数据：favorites / wjTickets 仍是唯一真相，这里只是读出来统一形状。
       weEntry 已引用过的（sourceType+sourceId 相同）不重复并，防双份。 */
    var refd = {};
    list.forEach(function (en) {
      if (en && en.sourceType === 'chat' && en.sourceId) refd['c:' + en.sourceId] = 1;
      if (en && en.sourceType === 'ticket' && en.sourceId) refd['t:' + en.sourceId] = 1;
    });
    core.scoped(arr(store.get('favorites'))).forEach(function (f) {
      if (!f || !f.id || refd['c:' + f.id]) return;
      var content = String(f.content || '');
      var first = content.split('\n')[0];
      list.push({
        id: 'fav:' + f.id,          /* 假 id 只用于门厅/详情定位，不是 weEntry */
        title: first.slice(0, 24) || '一条聊天',
        note: content,
        at: f.savedAt,
        kind: 'letter',
        sourceType: 'chat',
        sourceId: f.id,
        sourceRef: f.chatName || '',
        createdBy: 'user',
        merged: 'chat',             /* 详情页据此给「去原对话 / 移出」动作 */
        workId: f.chatId
      });
    });
    (Sleepy.wj && Sleepy.wj.tickets ? Sleepy.wj.tickets() : []).forEach(function (t) {
      if (!t || !t.id || refd['t:' + t.id]) return;
      list.push({
        id: 'tk:' + t.id,
        title: t.title || '未命名剧本',
        at: t.at,
        kind: 'ticket',
        sourceType: 'ticket',
        sourceId: t.id,
        createdBy: 'user',
        merged: 'ticket',
        workId: t.workId
      });
    });
    return list.sort(function (a, b) {
      return atNum(b.at) - atNum(a.at);
    });
  }

  /* 详情页按 id 只在当前 scoped 列表里找 —— 杜绝跨岛任意 id 读取 */
  function findInScope(id) {
    var list = entries();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ------------------------- 门厅 -------------------------
     门厅是 We 三主页面之一：挂共享底栏（weNav，收藏馆项高亮）。
     详情 / 提议是二级页，不挂 bar —— 返回回实际来源页。 */
  function paintHall(ctx) {
    ctx.setTitle('收藏馆');
    ctx.setActions([]);

    var body = ctx.body;
    var __st = 0;
    try { __st = body.scrollTop || 0; } catch (e) { /* 桩环境没有 */ }
    body.innerHTML = '';
    var shell = h('div', 'we-page-paper co-page co-hall');

    /* 群岛选人闸（与 We 首页同一道，经 Sleepy.weGate 共用）：
       身份没定时先选人，不渲染门厅本体。 */
    if (Sleepy.weGate && Sleepy.weGate.apply(ctx, shell, function () { paintHall(ctx); })) {
      body.appendChild(shell);
      return;
    }

    var sid = core.scopeId();
    var list = entries();

    /* 封面：馆名 + 关系标题 */
    var cover = h('div', 'we-cover co-cover');
    cover.appendChild(h('div', 'we-cover-vert', 'COLLECTION'));
    var ct = h('div', 'we-cover-txt');
    ct.appendChild(h('div', 'we-cover-kicker', 'W E · 收 藏 馆'));
    ct.appendChild(h('div', 'we-cover-title', relationTitle(sid)));
    ct.appendChild(h('div', 'we-cover-sub', '替你们把舍不得的，一件件收好。'));
    cover.appendChild(ct);
    shell.appendChild(cover);

    /* 计数条：馆藏总数 */
    var factsBar = h('div', 'we-facts');
    factsBar.appendChild(factCell(list.length, '馆 藏 总 数'));
    factsBar.appendChild(factCell(countKind(list, 'ticket'), '票 根'));
    factsBar.appendChild(factCell(countKind(list, 'photo'), '照 片'));
    shell.appendChild(factsBar);

    /* ---- 贴纸工坊入口（C2 预留；工坊不依赖馆藏，空馆也常驻） ---- */
    var stEntry = h('button', 'co-sticker-entry');
    stEntry.type = 'button';
    var stBadge = h('span', 'co-sticker-badge');
    stBadge.appendChild(h('i', 'co-sticker-chip is-a'));
    stBadge.appendChild(h('i', 'co-sticker-chip is-b'));
    stBadge.appendChild(h('i', 'co-sticker-chip is-c'));
    stEntry.appendChild(stBadge);
    var stCopy = h('span', 'co-sticker-copy');
    stCopy.appendChild(h('b', '', '贴纸工坊'));
    stCopy.appendChild(h('span', '', '把你们俩的样子，做成会话里的小表情'));
    stEntry.appendChild(stCopy);
    stEntry.appendChild(h('span', 'co-sticker-go', 'DIY ›'));
    stEntry.onclick = function () {
      if (Sleepy.nav) Sleepy.nav.open('sticker-workshop');
    };
    shell.appendChild(stEntry);

    /* 待确认条（P2）：char 提议、user 未处理的 pending 数量。
       **不算进正式馆藏计数** —— 只读 weProposals，不碰 entries()。 */
    var pend = (Sleepy.weProposals && Sleepy.weProposals.listPending)
      ? Sleepy.weProposals.listPending() : [];
    if (pend.length) {
      var pbar = h('button', 'co-pending-bar');
      pbar.type = 'button';
      pbar.appendChild(h('span', 'co-pending-no',
        String(pend.length).padStart ? ('0' + pend.length).slice(-2) : String(pend.length)));
      pbar.appendChild(h('span', 'co-pending-t', '件提议待你确认'));
      pbar.appendChild(h('span', 'co-pending-go', '去看看 →'));
      pbar.onclick = function () {
        if (Sleepy.nav) Sleepy.nav.open('collection-proposal');
      };
      shell.appendChild(pbar);
    }

    /* 空态：We 语境 */
    if (!list.length) {
      var emptyBox = h('div', 'empty co-empty');
      emptyBox.appendChild(h('div', 'empty-paper'));
      emptyBox.appendChild(h('p', 'empty-text', '这里还空着。'));
      emptyBox.appendChild(h('p', 'empty-hint', '回到 We 首页「记一条」，把值得留下的东西收进来。'));
      shell.appendChild(emptyBox);
      body.appendChild(shell);
      return;
    }

    /* 按 kind 分组（保持 KIND_ORDER 顺序，空组不渲染） */
    var section = h('div', 'co-sections');
    var seen = {};
    list.forEach(function (en) { seen[kindOf(en)] = true; });
    KIND_ORDER.forEach(function (k) {
      if (!seen[k]) return;
      var items = list.filter(function (en) { return kindOf(en) === k; });
      var sec = h('div', 'we-sec');
      var head = h('div', 'we-sec-head');
      head.appendChild(h('span', 'we-sec-no', String(items.length).padStart ? ('0' + items.length).slice(-2) : items.length));
      head.appendChild(h('span', 'we-sec-title', KIND_LABEL[k] || '其他'));
      sec.appendChild(head);

      var grid = h('div', 'co-grid');
      items.forEach(function (en) {
        var k = kindOf(en);
        /* 实物缩略：票根卡给存根冲孔边，照片卡给一条真实胶片位
           （有 mediaId 铺真图，挂不上退纸纹底）—— 门厅一眼是「物」，不是列表 */
        var card = h('button', 'co-card' + (k === 'ticket' ? ' co-card-ticket'
          : (k === 'photo' ? ' co-card-photo' : '')));
        card.type = 'button';
        var kHead = h('div', 'co-card-head');
        kHead.appendChild(h('span', 'co-card-title', en.title || '（未命名）'));
        kHead.appendChild(h('span', 'co-card-day', fmtDay(en.at)));
        card.appendChild(kHead);
        if (k === 'photo') {
          var th = h('i', 'co-thumb');
          card.appendChild(th);
          fillEntryThumb(th, en.mediaId);
        }
        if (en.note) card.appendChild(h('p', 'co-card-note', en.note));
        var src = checkSource(en);
        var foot = h('div', 'co-card-src' + (src.status === 'gone' ? ' is-gone' : ''));
        foot.appendChild(h('span', '', src.status === 'manual'
          ? '手记'
          : (src.status === 'gone' ? src.text : '来自 ' + srcLabel(en.sourceType))));
        card.appendChild(foot);
        card.onclick = function () {
          if (Sleepy.nav) Sleepy.nav.open('collection-item', { id: en.id });
        };
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      section.appendChild(sec);
    });
    shell.appendChild(section);

    body.appendChild(shell);
    /* 重画不丢滚动位置（三页 Tab 切换 / 切岛 onShow 重画是常态） */
    try { body.scrollTop = __st; } catch (e) { /* 桩环境没有 */ }
  }

  function countKind(list, k) {
    var n = 0;
    list.forEach(function (en) { if (kindOf(en) === k) n++; });
    return n;
  }

  /* 门厅照片卡缩略图：mediaId → objectURL 现挂现用（objectURL 活不过刷新）；
     必须在卡片挂进 DOM 之后调用（isConnected 卫兵与时光页 fillThumb 同款）。 */
  function fillEntryThumb(img, mediaId) {
    if (!mediaId || !img.isConnected || !Sleepy.media || !Sleepy.media.url) return;
    try {
      Sleepy.media.url(mediaId).then(function (u) {
        if (u && img.isConnected) {
          img.style.backgroundImage = 'url("' + u + '")';
          img.classList.add('has-img');
        }
      })['catch'](function () { /* 挂不上保持纸纹底 */ });
    } catch (e) { /* 桩环境没有 media */ }
  }

  function factCell(n, label) {
    var c = h('div', 'we-fact');
    c.appendChild(h('b', '', String(n)));
    c.appendChild(h('span', '', label));
    return c;
  }

  /* ------------------------- C1 藏品实物化 -------------------------
     票根（60×120 双面 3D 翻转）+ 拍立得（长按显影）。实施单定稿：
     正面走方案 B（纯大字票务块，无插画区 —— 与背面内容不重复）；
     票务格是「结构固定、内容剧情化」：有真实数据（线下/日历来源）用真的，
     没有就按藏品 id 做确定性伪随机（同一张票永远长一样，像真票根）。
     显影标记 developed：老记录没有字段 → 按「已显影」兼容；
     新照片藏品出厂 developed:false（page-we.js weAdd 落），长按显影后写回 true。
     留言 memoUser / memoChar：背面「我的留言 / Char 记录」，未填显示虚线
     占位、点击原地补写（写回走 Sleepy.weStore.patch，白名单 + 当前房卫兵）。 */

  /* FNV-1a 字符串散列 → 无符号 32 位：伪随机的种子（确定性，不真随机） */
  function hashStr(s) {
    var x = 2166136261; s = String(s || '');
    for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  /* 存档编号（票头 SERIES + 条码）：由 id 派生，稳定 */
  function serialOf(en) {
    var h = hashStr(en.id || en.title || 'we');
    return (1000 + h % 9000) + '-' + (1000 + (h >>> 12) % 9000);
  }
  /* 票面日期串：MM.DD HH:mm；解析不出回 '——' */
  function ticketDate(en) {
    var n = atNum(en.at);
    if (!n) return '——';
    var d = new Date(n);
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /* 章上的日期：YYYY.MM.DD（确认日 > 收录日） */
  function stampDate(en) {
    var n = atNum(en.confirmedAt) || atNum(en.at) || atNum(en.createdAt);
    if (!n) return '——';
    var d = new Date(n);
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
  }
  /* 右侧票务大字格：真实优先（线下→去了哪 / 日历→为了什么），否则剧情池 */
  function storyCell(en) {
    var seed = hashStr(en.id || '');
    try {
      if (en.sourceType === 'offline' && Sleepy.offlineStore && Sleepy.offlineStore.findSession) {
        var s = Sleepy.offlineStore.findSession(en.sourceId);
        if (s) return { k: '去了 · WHERE', v: String(s.title || s.name || '').trim().slice(0, 12) || '一段时光' };
      }
      if (en.sourceType === 'calendar' && Sleepy.calendar && Sleepy.calendar.getEvent) {
        var ev = Sleepy.calendar.getEvent(en.sourceId);
        if (ev && String(ev.title || '').trim()) return { k: '为了 · FOR', v: String(ev.title).trim().slice(0, 12) };
      }
    } catch (e) { /* 来源复核失败就落剧情池，不算错 */ }
    var pools = [
      { k: '开销 · SPENT', v: '¥ ' + (18 + seed % 502) },
      { k: '天气 · SKY', v: ['晴', '多云', '晚风', '小雨', '初雪', '雷阵雨'][seed % 6] },
      { k: '时长 · HOURS', v: (1 + seed % 5) + ' 小时' },
      { k: '心情 · MOOD', v: ['舍不得', '刚刚好', '意犹未尽', '太值了', '心还留在那'][seed % 5] }
    ];
    return pools[seed % pools.length];
  }

  /* 背面留言格：有字显示手写体，没字显示虚线占位；点击原地补写 */
  function memoCell(en, field, placeholder, ctx) {
    var wrap = h('div', 'co-tk-memo-wrap co-tk-nozone');
    var txt = String(en[field] || '').trim();
    var btn = h('button', 'co-tk-memo' + (txt ? '' : ' is-empty'), txt || placeholder);
    btn.type = 'button';
    btn.onclick = function (e) {
      e.stopPropagation();
      openMemoEditor(wrap, en, field, ctx);
    };
    wrap.appendChild(btn);
    return wrap;
  }
  /* 原地微型编辑：textarea + 保存/取消（次要按钮同排独立成行，不藏） */
  function openMemoEditor(wrap, en, field, ctx) {
    if (wrap.querySelector('textarea')) return;
    wrap.innerHTML = '';
    var ed = h('div', 'co-tk-memo-editor');
    var ta = h('textarea', 'co-tk-memo-editor-ta');
    ta.maxLength = 120;
    ta.placeholder = '写一点留在背面…';
    ta.value = String(en[field] || '');
    var acts = h('div', 'co-tk-memo-acts');
    var ok = h('button', 'is-primary', '存进背签'); ok.type = 'button';
    var no = h('button', '', '先不写'); no.type = 'button';
    ok.onclick = function (e) {
      e.stopPropagation();
      var f = {}; f[field] = String(ta.value || '').trim();
      var r = (Sleepy.weStore && Sleepy.weStore.patch) ? Sleepy.weStore.patch(en.id, f) : { ok: false };
      if (r && r.ok) ctx.toast('已写进背签', 'ok');
      else ctx.toast('没写上，稍后再试', 'warn');
      if (ctx.__paint) ctx.__paint();
    };
    no.onclick = function (e) {
      e.stopPropagation();
      if (ctx.__paint) ctx.__paint();
    };
    acts.appendChild(ok); acts.appendChild(no);
    ed.appendChild(ta); ed.appendChild(acts);
    wrap.appendChild(ed);
    try { ta.focus(); } catch (e2) { /* 桩环境没有 */ }
  }

  /* -- 票根正面（方案 B：纯大字票务块） -- */
  function buildTicketFront(en) {
    var face = h('div', 'co-tk-face co-tk-front');
    var mast = h('div', 'co-tk-masthead');
    mast.appendChild(h('b', '', 'CINÉMA MEMOIRE'));
    mast.appendChild(h('span', '', 'ADMIT ONE · VIP'));
    face.appendChild(mast);

    var sub = h('div', 'co-tk-subserial');
    sub.appendChild(h('span', '', 'SERIES № ' + serialOf(en)));
    sub.appendChild(h('span', '', 'WE ARCHIVE EDITION'));
    face.appendChild(sub);

    var body = h('div', 'co-tk-body');
    var tg = h('div', 'co-tk-titlegroup');
    tg.appendChild(h('div', 'co-tk-ornament', '✦ WE ARCHIVE ✦'));
    tg.appendChild(h('div', 'co-tk-title', en.title || '（未命名）'));
    tg.appendChild(h('div', 'co-tk-suben', 'A LITTLE MEMORY OF US'));
    tg.appendChild(h('i', 'co-tk-divider'));
    body.appendChild(tg);

    var story = storyCell(en);
    var grid = h('div', 'co-tk-grid');
    var c1 = h('div', 'co-tk-gridcell');
    c1.appendChild(h('span', 'co-tk-grid-k', 'DATE · 日期'));
    c1.appendChild(h('span', 'co-tk-grid-v', ticketDate(en)));
    var c2 = h('div', 'co-tk-gridcell');
    c2.appendChild(h('span', 'co-tk-grid-k', story.k));
    c2.appendChild(h('span', 'co-tk-grid-v', story.v));
    grid.appendChild(c1); grid.appendChild(c2);
    body.appendChild(grid);

    var who = charName(en.refCharId) || '我们';
    var hall = h('div', 'co-tk-hallrow');
    hall.appendChild(h('span', '', '同行：'));
    hall.appendChild(h('b', '', who));
    var hallR = h('span', '', '');
    hallR.appendChild(h('span', '', '收录 '));
    hallR.appendChild(h('b', '', stampDate(en)));
    hall.appendChild(hallR);
    body.appendChild(hall);
    face.appendChild(body);

    var perf = h('div', 'co-tk-perf');
    perf.appendChild(h('i', ''));
    perf.appendChild(h('i', ''));
    perf.appendChild(h('div', 'co-tk-perf-line'));
    face.appendChild(perf);

    var stub = h('div', 'co-tk-stub');
    var bc = h('div', 'co-tk-barcode');
    bc.appendChild(h('div', 'co-tk-barcode-art'));
    /* 13 位样张式条码号：9 + 两组六位数（同票 id 派生，稳定） */
    var h9 = hashStr(en.id || en.title || 'we');
    var g1 = 100000 + h9 % 900000;
    var g2 = 100000 + (h9 >>> 13) % 900000;
    bc.appendChild(h('div', 'co-tk-barcode-no', '9 ' + g1 + ' ' + g2));
    stub.appendChild(bc);
    var stamp = h('div', 'co-tk-stamp');
    stamp.appendChild(h('small', '', 'WE COLLECT'));
    stamp.appendChild(h('b', '', '共同留存'));
    stamp.appendChild(h('em', '', stampDate(en)));
    stub.appendChild(stamp);
    face.appendChild(stub);

    face.appendChild(h('i', 'co-tk-scallop'));
    return face;
  }

  /* -- 票根背面（手写档案表格：为何留下 / 双留言 / 存根行） -- */
  function buildTicketBack(en, src, ctx) {
    var face = h('div', 'co-tk-face co-tk-face-back co-tk-back');
    var head = h('div', 'co-tk-backhead');
    head.appendChild(h('b', '', '留 痕 存 档 · 背 签'));
    head.appendChild(h('span', '', 'MEMO BACK'));
    face.appendChild(head);

    var grid = h('div', 'co-tk-archive');
    var reason = h('div', 'co-tk-reason');
    reason.appendChild(h('div', 'co-tk-cell-k', '▍ 为 何 留 下 · REASON'));
    reason.appendChild(h('div', 'co-tk-quote', String(en.note || '').trim() || '（还没写下为什么留下）'));
    reason.appendChild(h('div', 'co-tk-quote-by',
      '—— ' + createdByLabel(en) + (en.createdBy === 'char' ? ' · 提议收录' : ' · 收录')));
    grid.appendChild(reason);

    var split = h('div', 'co-tk-split');
    var colL = h('div', 'co-tk-splitcol');
    colL.appendChild(h('div', 'co-tk-split-who', '我 的 留 言'));
    var cname = charName(en.refCharId) || 'TA';
    var colR = h('div', 'co-tk-splitcol');
    colR.appendChild(h('div', 'co-tk-split-who', cname + ' 记 录'));
    if (en.merged === 'ticket') {
      /* 并馆的帷境票根不是 weEntry，留言没有落库处 —— 摆静态占位，
         不给点了必然「没写上」的假编辑入口（2026-10-08 并馆轮）。 */
      colL.appendChild(h('div', 'co-tk-memo-static', '帷境票根 · 不在此写留言'));
      colR.appendChild(h('div', 'co-tk-memo-static', '—'));
    } else {
      colL.appendChild(memoCell(en, 'memoUser', '＋ 补一句留言', ctx));
      colR.appendChild(memoCell(en, 'memoChar', '＋ 让这一格也有字', ctx));
    }
    split.appendChild(colL); split.appendChild(colR);
    grid.appendChild(split);

    var stub = h('div', 'co-tk-backstub');
    var r1 = h('div', 'co-tk-backrow');
    /* 关联行直接展示来源复核文案（live→「日历 · 标题」/ done→已完成口径 /
       gone→「该约定已取消」等），右尖括号给一眼可辨的状态章 */
    r1.appendChild(h('span', '', '关联：' + (src.status === 'manual' ? '手动记录' : src.text)));
    r1.appendChild(h('em', '', '[' +
      (src.status === 'gone' ? '已不在' : (src.status === 'done' ? '已完成' : '在')) + ']'));
    stub.appendChild(r1);
    var r2 = h('div', 'co-tk-backrow');
    r2.appendChild(h('span', '', '状态：双方可见 · 已入馆'));
    r2.appendChild(h('em', '', '[№ ' + serialOf(en) + ']'));
    stub.appendChild(r2);
    grid.appendChild(stub);
    face.appendChild(grid);

    face.appendChild(h('i', 'co-tk-scallop'));
    return face;
  }

  /* -- 票根整体：墨黑展台 + 3D 翻转（背签区点击不翻面） -- */
  function buildTicket(ctx, en, src) {
    var stage = h('div', 'co-stage co-tk-stage');
    var flipper = h('div', 'co-tk-flipper');
    flipper.appendChild(buildTicketFront(en));
    flipper.appendChild(buildTicketBack(en, src, ctx));
    flipper.onclick = function (e) {
      if (e && e.target && e.target.closest && e.target.closest('.co-tk-nozone')) return;
      flipper.classList.toggle('is-flipped');
    };
    stage.appendChild(flipper);
    stage.appendChild(h('div', 'co-tk-hint', '轻点票根 · 翻到背面手写背签'));
    return stage;
  }

  /* -- 拍立得：黑卡展台 + 黄铜相角 + 长按显影 + 宽下巴涂鸦/贴纸槽位 -- */
  function buildPolaroid(ctx, en, src) {
    var stage = h('div', 'co-stage co-pl-stage');
    var mount = h('div', 'co-pl-mount');
    var corners = ['is-tl', 'is-tr', 'is-bl', 'is-br'];
    for (var i = 0; i < corners.length; i++) mount.appendChild(h('i', 'co-pl-corner ' + corners[i]));

    var frame = h('div', 'co-pl-frame');
    var pocket = h('button', 'co-pl-pocket'); pocket.type = 'button';
    var developed = en.developed !== false;   /* 老记录无字段 → 已显影兼容 */
    var photo = h('div', 'co-pl-photo' + (en.mediaId ? '' : ' is-empty'));
    pocket.appendChild(photo);
    if (!developed) pocket.appendChild(h('i', 'co-pl-chem'));
    pocket.appendChild(h('i', 'co-pl-glare'));

    /* 真实照片：mediaId → objectURL（objectURL 活不过刷新，只现挂现用） */
    if (en.mediaId && Sleepy.media && Sleepy.media.url) {
      try {
        Sleepy.media.url(en.mediaId).then(function (u) {
          if (u && photo.isConnected) {
            photo.style.backgroundImage = 'url("' + u + '")';
            photo.classList.add('has-img');
          }
        })['catch'](function () { /* 挂不上就留颗粒底 */ });
      } catch (e2) { /* 桩环境没有 media */ }
    }

    if (!developed) {
      /* 长按 0.6s「手心捂热」触发显影：按住泛暖光，松早了不算；
         显影完成写回 developed:true 持久化（下次进详情直接是显影好的）。 */
      var timer = null;
      var hint = null;   /* 展台下的发现性提示，显影后就地改口 */
      var cool = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        pocket.classList.remove('is-warming');
      };
      var develop = function () {
        timer = null;
        pocket.classList.remove('is-warming');
        if (pocket.classList.contains('is-developed')) return;
        pocket.classList.add('is-developed');
        var r = (Sleepy.weStore && Sleepy.weStore.patch)
          ? Sleepy.weStore.patch(en.id, { developed: true }) : { ok: false };
        if (!(r && r.ok)) ctx.toast('显影好了（没存上标记，下次再来一次）', 'warn');
        if (hint) hint.textContent = '这一张显影好了';
        setTimeout(function () {
          var c = pocket.querySelector('.co-pl-chem');
          if (c && c.parentNode) c.parentNode.removeChild(c);
        }, 2000);
      };
      pocket.addEventListener('pointerdown', function () {
        if (pocket.classList.contains('is-developed')) return;
        pocket.classList.add('is-warming');
        timer = setTimeout(develop, 600);
      });
      pocket.addEventListener('pointerup', cool);
      pocket.addEventListener('pointerleave', cool);
      pocket.addEventListener('pointercancel', cool);
      pocket.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    } else {
      pocket.classList.add('is-developed');
    }
    pocket.onclick = function (e) {
      /* 显影只走长按 —— 单击不触发（防误触；已显影后整格不可交互） */
      e.preventDefault();
    };
    frame.appendChild(pocket);

    var chin = h('div', 'co-pl-chin');
    chin.appendChild(h('div', 'co-pl-hand',
      String(en.note || '').trim() || '“这一张，还没写下当时的话。”'));
    var meta = h('div', 'co-pl-meta');
    meta.appendChild(h('span', 'co-pl-date', en.at ? fmtFull(en.at) : '——'));
    var doodle = h('div', 'co-pl-doodle');
    var cname = charName(en.refCharId) || (core.activeCharOnIsland() || {}).name || '';
    if (cname) doodle.appendChild(h('span', 'co-pl-doodle-tag', cname + ' 手绘'));
    var spark = h('span', 'co-pl-spark');
    spark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z"/></svg>';
    doodle.appendChild(spark);
    meta.appendChild(doodle);
    chin.appendChild(meta);
    /* C2 贴纸槽位：点击开贴纸抽屉（数据源走统一可见性出口） */
    var slot = h('button', 'co-pl-slot', '贴纸'); slot.type = 'button';
    slot.onclick = function (e) {
      e.stopPropagation();
      openStickerDrawer(ctx, en);
    };
    chin.appendChild(slot);
    frame.appendChild(chin);

    /* 已贴的贴纸：存的是**媒体快照的 mediaId**（实贴时复制了一份），
       表情包条目被删 / 整版清理都不影响藏品显示（施工单 §八） */
    var pasted = arr(en.stickers);
    pasted.forEach(function (p) {
      if (!p || !p.mediaId) return;
      var im = h('img', 'co-pl-pasted');
      im.alt = '贴纸';
      im.style.transform = 'rotate(' + (Number(p.rot) || 0) + 'deg)';
      frame.appendChild(im);
      if (Sleepy.media && Sleepy.media.url) {
        try {
          Sleepy.media.url(p.mediaId).then(function (u) {
            if (u && im.isConnected) im.src = u;
          })['catch'](function () { /* 挂不上就静默缺图 */ });
        } catch (e3) { /* 桩环境没有 media */ }
      }
    });

    mount.appendChild(frame);
    stage.appendChild(mount);
    hint = stage.appendChild(h('div', 'co-tk-hint', developed ? '这一张显影好了' : '按住相纸 · 手心捂热，等它显影'));
    return stage;
  }

  /* ------------------------- 藏品详情 ------------------------- */
  function paintDetail(ctx, id) {
    ctx.setTitle('藏品');
    ctx.setActions([]);

    var body = ctx.body;
    body.innerHTML = '';
    var shell = h('div', 'we-page-paper co-page co-detail');

    /* 群岛选人闸：身份没定时先选人，详情本体不渲染 */
    if (Sleepy.weGate && Sleepy.weGate.apply(ctx, shell, function () { paintDetail(ctx, id); })) {
      body.appendChild(shell);
      return;
    }

    /* 只在当前 scoped 列表里找 —— 跨岛/任意 id 一律按「不在」降级 */
    var en = findInScope(id);
    if (!en) {
      var gone = h('div', 'empty co-empty');
      gone.appendChild(h('div', 'empty-paper'));
      gone.appendChild(h('p', 'empty-text', '这件藏品不在眼前。'));
      gone.appendChild(h('p', 'empty-hint', '它可能属于另一座岛，或已经被移走。'));
      shell.appendChild(gone);
      body.appendChild(shell);
      return;
    }

    var k = kindOf(en);
    var src = checkSource(en);

    if (k === 'ticket') {
      /* C1 票根：实物本体已带标题/日期/来源/状态（正面大字票务 + 背面
         手写背签），不再重复渲染通用 head / noteBox / srcBox —— 只补档案卡。 */
      shell.appendChild(buildTicket(ctx, en, src));
    } else if (k === 'photo') {
      /* C1 拍立得：note 变宽下巴手写金句，通用 noteBox 不再重复；head 与
         来源状态条保留（相纸上没有标题与来源语义）。 */
      var phead = h('div', 'co-detail-head');
      phead.appendChild(h('div', 'co-detail-kind', (KIND_LABEL[k] || '其他') + ' · ' + srcLabel(en.sourceType)));
      phead.appendChild(h('h2', 'co-detail-title', en.title || '（未命名）'));
      if (en.at) phead.appendChild(h('p', 'co-detail-date', fmtFull(en.at)));
      shell.appendChild(phead);

      shell.appendChild(buildPolaroid(ctx, en, src));

      /* 样张 v1 的详情说明栏：黄铜左边线引文风格（memo-quote-box） */
      var psrcBox = h('div', 'co-src-box co-src-memo');
      psrcBox.style.marginTop = '18px';
      if (src.status === 'manual') {
        psrcBox.appendChild(h('div', 'co-src-line', '这是一条手动记录，没有来源。'));
      } else if (src.status === 'live') {
        psrcBox.appendChild(h('div', 'co-src-line co-src-live', '来源仍在 · ' + src.text));
      } else if (src.status === 'done') {
        psrcBox.appendChild(h('div', 'co-src-line co-src-live', '来源已完成 · ' + src.text));
      } else {
        psrcBox.appendChild(h('div', 'co-src-line co-src-gone', src.text + '（原物已不在）'));
      }
      shell.appendChild(psrcBox);
    } else {
      /* 详情头：分类章 + 标题 + 日期（非实物化分类照旧） */
      var head = h('div', 'co-detail-head');
      head.appendChild(h('div', 'co-detail-kind', (KIND_LABEL[k] || '其他') + ' · ' + srcLabel(en.sourceType)));
      head.appendChild(h('h2', 'co-detail-title', en.title || '（未命名）'));
      if (en.at) head.appendChild(h('p', 'co-detail-date', fmtFull(en.at)));
      shell.appendChild(head);

      /* 正文：note */
      if (en.note) {
        var noteBox = h('div', 'co-detail-note');
        noteBox.appendChild(h('p', '', en.note));
        shell.appendChild(noteBox);
      }

      /* 来源状态 */
      var srcBox = h('div', 'co-src-box');
      if (src.status === 'manual') {
        srcBox.appendChild(h('div', 'co-src-line', '这是一条手动记录，没有来源。'));
      } else if (src.status === 'live') {
        srcBox.appendChild(h('div', 'co-src-line co-src-live', '来源仍在 · ' + src.text));
      } else if (src.status === 'done') {
        /* 已完成的事件是有效历史来源：保留展示，**不显示**「原物已不在」 */
        srcBox.appendChild(h('div', 'co-src-line co-src-live', '来源已完成 · ' + src.text));
      } else {
        srcBox.appendChild(h('div', 'co-src-line co-src-gone', src.text + '（原物已不在）'));
      }
      shell.appendChild(srcBox);
    }

    /* 档案卡：可复制的字段明细 */
    var meta = h('div', 'co-meta');
    meta.appendChild(metaRow('分类', KIND_LABEL[k] || '其他'));
    meta.appendChild(metaRow('来源', srcLabel(en.sourceType) +
      (en.sourceRef ? ' · ' + String(en.sourceRef).slice(0, 40) : '')));
    meta.appendChild(metaRow('创建', createdByLabel(en)));
    if (en.confirmedBy === 'user' && en.confirmedAt) {
      meta.appendChild(metaRow('确认', '我 · ' + fmtFull(en.confirmedAt)));
    }
    if (en.refCharId || en.refUserId) {
      meta.appendChild(metaRow('归属', charName(en.refCharId) + (userName(en.refUserId) ? ' · ' + userName(en.refUserId) : '')));
    }
    shell.appendChild(meta);

    /* 并馆藏品（聊天收藏 / 票根）的动作行：回原物 + 移出。
       数据真相不搬 —— 移除只动 favorites / wjTickets 原表，馆是读出来的。 */
    if (en.merged === 'chat' || en.merged === 'ticket') {
      var acts = h('div', 'co-merged-acts');
      var goBtn = null;
      if (en.merged === 'chat') {
        if (src.status === 'live') {
          goBtn = h('button', 'co-merged-btn', '去原对话看看');
          goBtn.type = 'button';
          goBtn.onclick = function () {
            var f = arr(store.get('favorites')).filter(function (x) {
              return x && x.id === en.sourceId;
            })[0];
            var cid = f ? f.chatId : en.workId;
            if (!cid || !(Sleepy.chatStore && Sleepy.chatStore.getChat(cid))) {
              ctx.toast('原来的对话已经删掉了', 'warn');
              return;
            }
            Sleepy.nav.open('chat-detail', { chatId: cid });
          };
        }
      } else if (Sleepy.wj && Sleepy.wj.get && en.workId && Sleepy.wj.get(en.workId)) {
        goBtn = h('button', 'co-merged-btn', '去剧本看看');
        goBtn.type = 'button';
        goBtn.onclick = function () {
          Sleepy.nav.open('wj-work', { id: en.workId });
        };
      }
      if (goBtn) acts.appendChild(goBtn);
      var rm = h('button', 'co-merged-btn is-danger', en.merged === 'ticket' ? '移除票根' : '移出收藏馆');
      rm.type = 'button';
      rm.onclick = function () {
        if (en.merged === 'ticket') {
          if (Sleepy.wj && Sleepy.wj.removeTicket) Sleepy.wj.removeTicket(en.sourceId);
          ctx.toast('票根收起来了', 'ok');
        } else {
          var cur = arr(store.get('favorites')).filter(function (x) {
            return x && x.id !== en.sourceId;
          });
          store.set('favorites', cur);
          ctx.toast('已移出收藏馆', 'ok');
        }
        if (ctx.__paint) ctx.__paint();
        else if (Sleepy.nav) Sleepy.nav.back();
      };
      acts.appendChild(rm);
      shell.appendChild(acts);
    }

    body.appendChild(shell);
  }

  /* 创建者展示（P2）：char 提议入馆的记录显示角色名，user 的照旧「我」 */
  function createdByLabel(en) {
    if (en.createdBy === 'char') return charName(en.refCharId) || '他';
    return '我';
  }

  function metaRow(k, v) {
    var r = h('div', 'co-meta-row');
    r.appendChild(h('span', 'co-meta-k', k));
    r.appendChild(h('span', 'co-meta-v', v || '—'));
    return r;
  }

  function charName(id) {
    if (!id) return '';
    try {
      var c = core.findChar(id);
      return (c && c.name) ? c.name : '';
    } catch (e) { return ''; }
  }
  function userName(id) {
    if (!id) return '';
    try {
      var u = core.findUser(id);
      return (u && u.name) ? u.name : '';
    } catch (e) { return ''; }
  }

  /* ------------------------- 注册 -------------------------
     门厅与藏品详情用两个独立页面 id：
       'collection'        门厅（无 params）
       'collection-item'   藏品详情（params.id）
     拆开的原因：nav.open 对同一 id 是**复用栈内那一条 + applyParams 重渲染**，
     若详情也注册成 'collection'，从详情返回会直接把整个 collection 弹掉（回到桌面），
     而不是回到门厅。参照 wj-foyer → wj-work 的「列表 → 详情」分页惯例。
     详情页仍只在当前 scoped 列表里按 id 查找 —— 跨岛/任意 id 一律按「不在」降级。 */

  function paintHallSafe(ctx) { paintHall(ctx); }
  function paintDetailSafe(ctx) {
    var id = ctx.params && ctx.params.id;
    paintDetail(ctx, id);
  }

  Sleepy.register('collection', {
    title: '收藏馆',
    render: function (ctx) {
      /* 门厅是 We 三主页面之一：挂共享底栏（收藏馆项高亮，幂等） */
      if (Sleepy.weNav && Sleepy.weNav.mount) Sleepy.weNav.mount(ctx, 'collection');
      ctx.__paint = function () { paintHallSafe(ctx); };
      paintHallSafe(ctx);
    },
    /* onShow 每次进页 / 切岛都重读重画 —— 保证切岛后不串线、回岛恢复 */
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

  Sleepy.register('collection-item', {
    title: '藏品',
    render: function (ctx) {
      ctx.__paint = function () { paintDetailSafe(ctx); };
      paintDetailSafe(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

  /* ------------------------- 待确认提议（P2） -------------------------
     独立第三页（沿用门厅/详情拆页惯例）：只列当前岛 pending 的提议。
     accept 成功 → nav.back() 回门厅 → onShow 重读，新藏品立即出现；
     来源已失效 → 保留 pending + 明确提示（绝不静默入馆）；
     declined → 只改 proposal 状态，正式馆藏计数不变。 */
  function paintProposal(ctx) {
    ctx.setTitle('待确认提议');
    ctx.setActions([]);

    var body = ctx.body;
    body.innerHTML = '';
    var shell = h('div', 'we-page-paper co-page co-proposal');

    /* 群岛选人闸：身份没定时先选人，提议页不渲染 */
    if (Sleepy.weGate && Sleepy.weGate.apply(ctx, shell, function () { paintProposal(ctx); })) {
      body.appendChild(shell);
      return;
    }

    var pend = (Sleepy.weProposals && Sleepy.weProposals.listPending)
      ? Sleepy.weProposals.listPending() : [];

    var head = h('div', 'co-detail-head');
    head.appendChild(h('div', 'co-detail-kind', 'W E · 待 你 确 认'));
    head.appendChild(h('h2', 'co-detail-title', pend.length
      ? ('有 ' + pend.length + ' 件想收进馆里')
      : '暂时没有要确认的提议'));
    head.appendChild(h('p', 'co-detail-date',
      pend.length ? 'TA 提的，收不收由你决定。' : 'TA 提议过的会出现在这里。'));
    shell.appendChild(head);

    pend.forEach(function (p) {
      var card = h('div', 'co-card co-proposal-card');
      var kHead = h('div', 'co-card-head');
      kHead.appendChild(h('span', 'co-card-title', p.title || '（未命名）'));
      kHead.appendChild(h('span', 'co-card-day', fmtDay(p.proposedAt)));
      card.appendChild(kHead);
      if (p.note) card.appendChild(h('p', 'co-card-note', '「' + p.note + '」—— ' + (charName(p.refCharId) || 'TA')));
      /* 来源状态实时复核（completed 有效 / cancelled 失效照实显示） */
      var src = checkSource({ sourceType: p.sourceType, sourceId: p.sourceId });
      var srcLine = h('div', 'co-card-src' + (src.status === 'gone' ? ' is-gone' : ''));
      srcLine.appendChild(h('span', '', src.status === 'gone'
        ? src.text
        : (src.status === 'done' ? '来源已完成 · ' + src.text : '来源仍在 · ' + src.text)));
      card.appendChild(srcLine);

      var acts = h('div', 'co-proposal-acts');
      var okBtn = h('button', 'co-proposal-btn is-primary', '收进馆里');
      okBtn.type = 'button';
      okBtn.onclick = function () {
        var r = Sleepy.weProposals ? Sleepy.weProposals.accept(p.id) : { ok: false };
        if (r && r.ok) {
          ctx.toast('已收进馆里', 'ok');
          if (Sleepy.nav) Sleepy.nav.back();   /* 回门厅，onShow 重读见新藏品 */
        } else if (r && (r.why === 'cancelled' || r.why === 'deleted')) {
          ctx.toast('这条约定已经不在了，提议先留着', 'warn');
          paintProposal(ctx);
        } else if (r && r.why === 'already-accepted') {
          if (Sleepy.nav) Sleepy.nav.back();
        } else {
          ctx.toast('暂时收不进来，稍后再试', 'warn');
          paintProposal(ctx);
        }
      };
      var noBtn = h('button', 'co-proposal-btn', '暂时不留');
      noBtn.type = 'button';
      noBtn.onclick = function () {
        if (Sleepy.weProposals) Sleepy.weProposals.decline(p.id);
        ctx.toast('先不留', 'ok');
        paintProposal(ctx);
      };
      acts.appendChild(okBtn);
      acts.appendChild(noBtn);
      card.appendChild(acts);
      shell.appendChild(card);
    });

    body.appendChild(shell);
  }

  Sleepy.register('collection-proposal', {
    title: '待确认提议',
    render: function (ctx) {
      ctx.__paint = function () { paintProposal(ctx); };
      paintProposal(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

  /* ------------------------- 贴纸工坊（C2，2026-10-02 修正施工单 §六） -------------------------
     五步流：① 锁脸三态 ② 套系（内置定稿词 / 自定义 6 槽）③ 生成
     ④ 固定 3×2 切片预览（空格标红 / 阈值重切 / 单片删除）⑤ 命名归属入库。
     纪律：词原样发（imggen.generateStickerSheet）；固定网格 + 四角 flood-fill；
     入库先媒体后 stickers（addSheetStickers 一次性写 all()）；
     重切只改临时切片结果；少于 1 张有效不许入库；
     参考图缺 → 引导 contact-edit / mask-edit（不猜性别、不自动补主体）。 */

  var skState = null;   /* 工坊流程态（模块级：切页回来不丢；身份变了自动重开） */

  /* 预设情绪库（英文进提示词、中文做展示与切片默认名；都不带道具，
     不与模板级「no props」约束冲突）。cat 用于下拉分组。 */
  var SK_PRESETS = [
    /* 日常 */
    { cat: '日常', en: 'waving excitedly', zh: '招手' },
    { cat: '日常', en: 'doing a good-morning stretch with arms up', zh: '伸懒腰' },
    { cat: '日常', en: 'sleepy yawning', zh: '困困' },
    { cat: '日常', en: 'nodding vigorously', zh: '狂点头' },
    { cat: '日常', en: 'shaking head firmly', zh: '摇头' },
    { cat: '日常', en: 'shrugging with palms up', zh: '摊手' },
    { cat: '日常', en: 'thinking with a finger on the chin', zh: '思考' },
    { cat: '日常', en: 'thumbs up with sparkling eyes', zh: '点赞' },
    /* 情绪 */
    { cat: '情绪', en: 'crying with big teardrops', zh: '大哭' },
    { cat: '情绪', en: 'tearing up with watery eyes', zh: '委屈' },
    { cat: '情绪', en: 'puffing cheeks angrily', zh: '生气' },
    { en: 'steaming with anger', zh: '暴怒', cat: '情绪' },
    { cat: '情绪', en: 'laughing out loud with closed eyes', zh: '大笑' },
    { cat: '情绪', en: 'smiling through tears', zh: '又哭又笑' },
    { cat: '情绪', en: 'shy blushing', zh: '害羞' },
    { cat: '情绪', en: 'pouting sulkily', zh: '嘟嘴' },
    { cat: '情绪', en: 'surprised with wide eyes', zh: '惊' },
    { cat: '情绪', en: 'smug smirk with raised chin', zh: '得意' },
    { cat: '情绪', en: 'dizzy with swirling eyes', zh: '晕' },
    { cat: '情绪', en: 'loving heart-shaped eyes', zh: '花痴' },
    /* 搞怪 */
    { cat: '搞怪', en: 'blowing a raspberry playfully', zh: '吐舌' },
    { cat: '搞怪', en: 'making a silly face', zh: '鬼脸' },
    { cat: '搞怪', en: 'peeking with one curious eye', zh: '偷看' },
    { cat: '搞怪', en: 'dramatically fainting backward', zh: '晕倒' },
    { cat: '搞怪', en: 'wiggling eyebrows playfully', zh: '挑眉' },
    { cat: '搞怪', en: 'spinning around with joy', zh: '转圈' },
    /* 爱意 */
    { cat: '爱意', en: 'making a finger heart with one hand', zh: '比心' },
    { cat: '爱意', en: 'blowing a kiss with one hand', zh: '飞吻' },
    { cat: '爱意', en: 'asking for a hug with open arms', zh: '要抱抱' },
    { cat: '爱意', en: 'hugging itself tightly with sparkling happy eyes', zh: '自抱' }
  ];
  /* 按分类列出（保持声明顺序） */
  function skPresetCats() {
    var cats = [];
    SK_PRESETS.forEach(function (p) {
      if (cats.indexOf(p.cat) < 0) cats.push(p.cat);
    });
    return cats;
  }

  function skRefOf(rec) {
    if (!rec) return '';
    return String(rec.faceLockImageMedia || '').trim() || String(rec.faceLockImage || '').trim();
  }

  function skFreshState(char, user) {
    return {
      step: 1, char: char, user: user, target: null, mode: null, genderPick: null,
      customLines: ['', '', '', '', '', ''],
      customPicks: [null, null, null, null, null, null],
      busy: false, cutBusy: false, err: '',
      sheet: null,           /* {mediaId, blob, slices, threshold, url} */
      removed: {}, maskPick: {},
      savedGroup: null, savedCount: 0,
      savedSheetId: null, savedIds: null   /* 缺口②：入库后本批管理用 */
    };
  }

  /* ---- 缺口③：stickerSheets 索引（断点恢复） ----
     生成整版是花钱的操作，而 skState 是模块态 —— 刷新即丢。
     整版图本身已落 media 库，这里只记一张轻索引（mediaId + 重建流程态
     所需的 target/mode/gender/custom 字段），step 3 就能「继续上次整版」：
     恢复到步骤 4 重新切片即可，不用再生成一次。
     纪律同项目其他表：读 scoped、写 tagScope；records 带 sandboxId，
     键进 core.js 删房名单。上限 8 条，只做断点用，不是图库。 */
  var SK_SHEETS_KEY = 'stickerSheets';
  function skSheetIndexList() {
    var list = store.get(SK_SHEETS_KEY);
    return core.scoped(Array.isArray(list) ? list : []);
  }
  function skSheetIndexRemember(st, mediaId) {
    var list = store.get(SK_SHEETS_KEY);
    list = Array.isArray(list) ? list.filter(function (r) {
      return r && r.mediaId !== mediaId;
    }) : [];
    list.push(core.tagScope({
      id: 'shx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      mediaId: mediaId, at: Date.now(),
      target: st.target, mode: st.mode, genderPick: st.genderPick,
      customPicks: (st.customPicks || []).slice(),
      customLines: (st.customLines || []).slice()
    }));
    /* 只留最近 8 次 —— 老的 media 本体不删（媒体库有自己的账），索引够用就行 */
    list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    store.set(SK_SHEETS_KEY, list.slice(0, 8));
  }
  function skSheetIndexForget(mediaId) {
    var list = store.get(SK_SHEETS_KEY);
    if (!Array.isArray(list)) return;
    var keep = list.filter(function (r) { return r && r.mediaId !== mediaId; });
    if (keep.length !== list.length) store.set(SK_SHEETS_KEY, keep);
  }
  function skFmtWhen(at) {
    var d = new Date(at || Date.now());
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function skSubjects(st) {
    var sub = function (entityType, rec) {
      return {
        entityType: entityType, entityId: rec.id,
        name: String(rec.name || '').trim() || (entityType === 'user' ? '我' : 'TA'),
        gender: String(rec.gender || '').trim(), faceText: ''
      };
    };
    if (st.target === 'char') return [sub('char', st.char)];
    if (st.target === 'user') return [sub('user', st.user)];
    return [sub('char', st.char), sub('user', st.user)];
  }

  /* 组最终词：内置走定稿词逐字；自定义只换六段（base/负面/模板级约束不动） */
  function skCompose(st) {
    var P = Sleepy.imggen.STICKER_PROMPTS;
    var custom = st.mode === 'custom';
    if (st.target === 'both') {
      return {
        prompt: custom ? P.BOTH_BASE + ' ' + P.customSlices(st.customLines) : P.composeBoth(),
        negative: P.NEG_BOTH
      };
    }
    var rec = st.target === 'char' ? st.char : st.user;
    var male = String(rec.gender || '').trim() === 'female' ? 'female' : 'male';
    if (st.genderPick) male = st.genderPick;
    var base = custom ? P.SINGLE_BASE + ' ' + P.customSlices(st.customLines)
      : (male === 'female' ? P.composeFemale() : P.composeMale());
    return { prompt: base, negative: P.NEG_SINGLE, male: male };
  }

  function skSteps(shell, cur) {
    var bar = h('div', 'sk-steps');
    for (var i = 1; i <= 5; i++) {
      bar.appendChild(h('i', 'sk-step-dot' + (i === cur ? ' is-on' : '')));
    }
    shell.appendChild(bar);
  }

  function paintSticker(ctx) {
    ctx.setTitle('贴纸工坊');
    ctx.setActions([]);

    var body = ctx.body;
    body.innerHTML = '';
    var shell = h('div', 'we-page-paper co-page co-sticker');

    if (Sleepy.weGate && Sleepy.weGate.apply(ctx, shell, function () { paintSticker(ctx); })) {
      body.appendChild(shell);
      return;
    }

    if (!Sleepy.imggen || !Sleepy.imggen.generateStickerSheet || !Sleepy.stickerCut) {
      shell.appendChild(h('p', 'empty-hint', '贴纸工坊的零件没加载齐，刷新一下再试试。'));
      body.appendChild(shell);
      return;
    }

    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    /* 身份变了（切岛/切号）→ 流程自动重开，避免把 A 岛的锁脸身份带去 B 岛 */
    if (!skState || !skState.char || !skState.user ||
      skState.char.id !== (char && char.id) || skState.user.id !== (user && user.id)) {
      skState = skFreshState(char, user);
    }
    var st = skState;

    /* 海报横幅（墨黑 + die-cut 圆章 + DIY 钢印），步骤名跟流程走 */
    var stepNames = ['', '选谁的脸', '选套系', '生成整版', '切片预览', '归属入库'];
    var hero = h('div', 'sk-hero');
    hero.appendChild(h('span', 'sk-hero-seal', '贴'));
    hero.appendChild(h('span', 'sk-hero-tag', 'D I Y'));
    var heroTxt = h('div', 'sk-hero-txt');
    heroTxt.appendChild(h('div', 'sk-hero-kicker', 'S T I C K E R · 工 坊'));
    heroTxt.appendChild(h('div', 'sk-hero-title', '做成你们自己的小表情'));
    heroTxt.appendChild(h('div', 'sk-hero-sub',
      String(st.char && st.char.name || 'TA').trim() + ' × ' + core.labelOfUser(st.user, '我') +
      ' · ' + (stepNames[st.step] || '')));
    hero.appendChild(heroTxt);
    shell.appendChild(hero);

    /* 墨黑工坊面板（参考原始 demo 的暗色工作台）：步骤 + 当前步内容全在面板里 */
    var panel = h('div', 'sk-panel');
    skSteps(panel, st.step);
    if (st.step === 1) paintSkTarget(ctx, panel, st);
    else if (st.step === 2) paintSkStyle(ctx, panel, st);
    else if (st.step === 3) paintSkGenerate(ctx, panel, st);
    else if (st.step === 4) paintSkPreview(ctx, panel, st);
    else paintSkSave(ctx, panel, st);
    shell.appendChild(panel);

    body.appendChild(shell);
  }

  /* 面板内小节头：左标签 + 右焦糖小注 */
  function skSecHead(host, label, note) {
    var head = h('div', 'sk-sec-head');
    head.appendChild(h('span', 'sk-sec-label', label));
    if (note) head.appendChild(h('span', 'sk-sec-note', note));
    host.appendChild(head);
  }

  /* ---- 步骤 1：锁脸三态 ---- */
  function paintSkTarget(ctx, host, st) {
    var charRef = skRefOf(st.char), userRef = skRefOf(st.user);
    var charName = String(st.char && st.char.name || 'TA').trim() || 'TA';
    skSecHead(host, '选择锁脸目标', 'Q 版角色特征保持');
    var cards = [
      { t: 'char', glyph: charName.slice(0, 1), title: charName + ' (Char)',
        note: '单人表情包', ok: !!charRef },
      { t: 'user', glyph: '我', title: '我 (User)',
        note: '马甲专属', ok: !!userRef },
      { t: 'both', glyph: '双', title: charName + ' × 我 (CP)',
        note: '双人互动贴纸', ok: !!charRef && !!userRef }
    ];
    cards.forEach(function (c) {
      var b = h('button', 'sk-target is-' + c.t + (st.target === c.t ? ' is-on' : ''));
      b.type = 'button';
      b.appendChild(h('span', 'sk-glyph is-' + c.t, c.glyph));
      var copy = h('span', 'sk-target-copy');
      copy.appendChild(h('b', '', c.title));
      copy.appendChild(h('span', '', c.note));
      b.appendChild(copy);
      b.appendChild(h('span', 'sk-ref' + (c.ok ? ' is-ok' : ' is-miss'),
        c.ok ? '锁脸图 ✓' : '缺锁脸图'));
      b.onclick = function () {
        st.target = (st.target === c.t) ? null : c.t;
        if (ctx.__paint) ctx.__paint();
      };
      host.appendChild(b);
    });

    /* 双人目标：特征说明 + 情绪库分组 chips（对应预设池四大类） */
    if (st.target === 'both') {
      var feat = h('div', 'sk-feature');
      feat.appendChild(h('p', '', '双人锁定：双方锁脸图自动注入参考，六个格 = 六种你们俩的互动情绪。'));
      var chips = h('div', 'sk-chips');
      ['✦ 日常', '✦ 情绪', '✦ 搞怪', '✦ 爱意'].forEach(function (t) {
        chips.appendChild(h('span', 'sk-chip', t));
      });
      feat.appendChild(chips);
      host.appendChild(feat);
    }

    /* 缺图引导（施工单：不猜、不自动补，指路现有编辑页） */
    var need = [];
    if (st.target && st.target !== 'user' && !charRef) {
      need.push({ who: '「' + charName + '」', go: 'contact-edit', id: st.char.id });
    }
    if (st.target && st.target !== 'char' && !userRef) {
      need.push({ who: '我', go: 'mask-edit', id: st.user.id });
    }
    need.forEach(function (n) {
      var row = h('div', 'sk-miss-row');
      row.appendChild(h('span', '', n.who + '还没有锁脸图 —— 贴纸必须锁脸，先去补一张'));
      var go = h('button', 'sk-miss-go', '去设置 ›');
      go.type = 'button';
      go.onclick = function () {
        ctx.open(n.go, { id: n.id, sandboxId: core.activeSandbox() ? core.activeSandbox().id : '' });
      };
      row.appendChild(go);
      host.appendChild(row);
    });

    var next = h('button', 'sk-next', '下一步 · 选套系');
    next.type = 'button';
    next.disabled = !st.target;
    next.onclick = function () { st.step = 2; st.mode = null; st.genderPick = null; if (ctx.__paint) ctx.__paint(); };
    host.appendChild(next);
  }

  /* ---- 步骤 2：套系（内置 / 自定义 6 槽） ---- */
  function paintSkStyle(ctx, shell, st) {
    var back = h('button', 'sk-back', '‹ 上一步');
    back.type = 'button';
    back.onclick = function () { st.step = 1; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(back);

    var single = st.target !== 'both';

    var bIn = h('button', 'sk-target' + (st.mode === 'builtin' ? ' is-on' : ''));
    bIn.type = 'button';
    bIn.appendChild(h('span', 'sk-glyph is-char', '定'));
    var inC = h('span', 'sk-target-copy');
    inC.appendChild(h('b', '', '内置套系'));
    inC.appendChild(h('span', '', single ? '高频情绪六连（按性别用定稿词）' : '双人互动六连（定稿词）'));
    bIn.appendChild(inC);
    bIn.onclick = function () { st.mode = 'builtin'; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(bIn);

    var bCus = h('button', 'sk-target' + (st.mode === 'custom' ? ' is-on' : ''));
    bCus.type = 'button';
    bCus.appendChild(h('span', 'sk-glyph is-both', '自'));
    var cuC = h('span', 'sk-target-copy');
    cuC.appendChild(h('b', '', '自定义六格'));
    cuC.appendChild(h('span', '', '每格选一个预设情绪，或写一句英文动作（80 字内）'));
    bCus.appendChild(cuC);
    bCus.onclick = function () { st.mode = 'custom'; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(bCus);

    /* 单人内置：性别版本（资料缺就在这里明选 —— 不猜，施工单 §六） */
    if (single && st.mode === 'builtin') {
      var rec = st.target === 'char' ? st.char : st.user;
      var g = String(rec.gender || '').trim();
      var gRow = h('div', 'sk-gender-row');
      gRow.appendChild(h('span', 'sk-gender-label',
        '版本：' + (skEffectiveGender(st, single, rec) === 'female' ? '女生版' : '男生版') +
        (g ? '（资料性别：' + (g === 'female' ? '女' : '男') + '）' : '（资料没写，二选一）')));
      [['male', '男生版'], ['female', '女生版']].forEach(function (p) {
        var gb = h('button', 'sk-gender-btn' +
          (skEffectiveGender(st, single, rec) === p[0] ? ' is-on' : ''), p[1]);
        gb.type = 'button';
        gb.onclick = function () { st.genderPick = p[0]; if (ctx.__paint) ctx.__paint(); };
        gRow.appendChild(gb);
      });
      shell.appendChild(gRow);
    }

    /* 自定义六槽：预设下拉 + 自由文本二选一 */
    if (st.mode === 'custom') {
      shell.appendChild(h('p', 'sk-slot-tip', '预设和自由文本二选一：选了预设，输入框留空就行。'));
      for (var i = 0; i < 6; i++) (function (idx) {
        var row = h('div', 'sk-slot' + (st.customPicks[idx] != null ? ' has-preset' : ''));
        row.appendChild(h('span', 'sk-slot-no', 'No.' + (idx + 1)));
        var sel = h('select', 'sk-slot-sel');
        var op0 = h('option', '', '预设情绪…');
        op0.value = '';
        sel.appendChild(op0);
        /* 预设按分类分组（optgroup），找起来快 */
        skPresetCats().forEach(function (cat) {
          var og = h('optgroup');
          og.setAttribute('label', cat);
          SK_PRESETS.forEach(function (p, pi) {
            if (p.cat !== cat) return;
            var op = h('option', '', p.zh);
            op.value = String(pi);
            og.appendChild(op);
          });
          sel.appendChild(og);
        });
        if (st.customPicks[idx] != null) sel.value = String(st.customPicks[idx]);
        sel.onchange = function () {
          st.customPicks[idx] = sel.value === '' ? null : Number(sel.value);
          if (st.customPicks[idx] != null) st.customLines[idx] = '';
          if (ctx.__paint) ctx.__paint();
        };
        row.appendChild(sel);
        var inp = h('input', 'sk-slot-input');
        inp.type = 'text';
        inp.maxLength = 80;
        inp.placeholder = '或写英文动作，如 jumping in joy';
        inp.value = st.customLines[idx] || '';
        inp.oninput = function () {
          st.customLines[idx] = String(inp.value || '').replace(/\r?\n/g, ' ').slice(0, 80);
          if (inp.value !== st.customLines[idx]) inp.value = st.customLines[idx];
        };
        row.appendChild(inp);
        shell.appendChild(row);
      })(i);
    }

    var next = h('button', 'sk-next', '下一步 · 生成整版');
    next.type = 'button';
    next.disabled = !st.mode;
    next.onclick = function () {
      /* 自定义六格：空槽阻止提交（核查 5 —— 不静默回退兜底词） */
      var emptySlot = skCustomEmptySlot(st);
      if (emptySlot) {
        st.err = '第 ' + emptySlot + ' 格还是空的 —— 选一个预设情绪，或写一句英文动作';
        if (ctx.__paint) ctx.__paint();
        return;
      }
      st.err = '';
      st.step = 3;
      if (ctx.__paint) ctx.__paint();
    };
    shell.appendChild(next);
  }

  function skEffectiveGender(st, single, rec) {
    if (single) {
      if (st.genderPick) return st.genderPick;
      return String(rec.gender || '').trim() === 'female' ? 'female' : 'male';
    }
    return st.genderPick || 'male';
  }

  /* 部署前核查 4：身份竞态守卫。切号器/桌面切了马甲（或换了 char）之后，
     旧流程态里的 sheet 绝不能存给新身份 —— 生成与入库两个入口都先过这道闸，
     变了就整流程重开（paintSticker 的身份检测是重画时的兜底，这里挡在写前）。 */
  function skIdentityChanged(ctx, st) {
    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    return !char || !user || !st.char || !st.user ||
      char.id !== st.char.id || user.id !== st.user.id;
  }
  function skGuardIdentity(ctx, st) {
    if (!skIdentityChanged(ctx, st)) return false;
    skState = null;
    ctx.toast('身份变了，贴纸流程重新开始', 'warn');
    if (ctx.__paint) ctx.__paint();
    return true;
  }

  /* 部署前核查 5：自定义六格空槽阻止提交（不静默回退兜底词） */
  function skCustomEmptySlot(st) {
    if (st.mode !== 'custom') return 0;
    for (var i = 0; i < 6; i++) {
      if (st.customPicks[i] == null && !String(st.customLines[i] || '').trim()) {
        return i + 1;
      }
    }
    return 0;
  }

  /* ---- 步骤 3：生成 ---- */
  function paintSkGenerate(ctx, shell, st) {
    var back = h('button', 'sk-back', '‹ 上一步');
    back.type = 'button';
    back.onclick = function () { st.step = 2; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(back);

    var composed = skCompose(st);
    var api = Sleepy.imggen.activeApi();
    var info = h('div', 'sk-geninfo');
    info.appendChild(h('p', '', '锁脸：' + skSubjects(st).map(function (s) { return s.name; }).join(' × ')));
    info.appendChild(h('p', '', '接口：' + ((api && api.name) || '还没配生图接口')));
    shell.appendChild(info);

    if (st.err) shell.appendChild(h('p', 'sk-err', st.err));

    var go = h('button', 'sk-next', st.busy ? '正在生成…（参考图 + 整版，两次请求）' : '开始生成');
    go.type = 'button';
    go.disabled = !!st.busy;
    go.onclick = function () {
      if (st.busy) return;
      if (skGuardIdentity(ctx, st)) return;    /* 核查 4：身份变了不生成 */
      if (!Sleepy.imggen.activeApi()) {
        st.err = '先去 设置 → 生图 配一个生图接口';
        if (ctx.__paint) ctx.__paint();
        return;
      }
      st.busy = true; st.err = '';
      if (ctx.__paint) ctx.__paint();
      var locks = {};
      skSubjects(st).forEach(function (s) {
        locks[(s.entityType === 'user' ? 'user:' : 'char:') + s.entityId] = true;
      });
      Sleepy.imggen.generateStickerSheet({
        target: st.target,
        subjects: skSubjects(st),
        imageLocks: locks,
        prompt: composed.prompt,
        negativePrompt: composed.negative,
        size: '1024x1024'
      }).then(function (r) {
        st.busy = false;
        if (!r.ok) { st.err = r.message || '生成失败'; if (ctx.__paint) ctx.__paint(); return; }
        if (st.sheet && st.sheet.url) { try { URL.revokeObjectURL(st.sheet.url); } catch (e0) { /* 忽略 */ } }
        st.sheet = {
          mediaId: r.mediaId, blob: r.blob, slices: null, threshold: 235,
          url: r.blob ? URL.createObjectURL(r.blob) : ''
        };
        st.removed = {};
        skSheetIndexRemember(st, r.mediaId);   /* 断点索引：刷新后可免生成恢复 */
        st.step = 4;
        if (ctx.__paint) ctx.__paint();
      });
    };
    shell.appendChild(go);

    /* 断点恢复：本岛最近一次生成还在（刷新/中断后免再花一次钱）。
       只在没在 busy 时显示；恢复 = 取回 blob + 还原流程态 → 步骤 4 重切。 */
    if (!st.busy && !st.sheet) {
      var idx = skSheetIndexList();
      var last = idx.length ? idx[0] : null;
      if (last && last.mediaId && Sleepy.media && Sleepy.media.get) {
        var resumeCard = h('div', 'sk-resume');
        var txt = h('span', 'sk-resume-txt',
          '上次有张没做完的整版（' + skFmtWhen(last.at) + '）—— 直接继续切片，不用重新生成');
        var btn = h('button', 'sk-resume-go', '继续上次整版 ›');
        btn.type = 'button';
        btn.onclick = function () {
          if (st.busy) return;
          if (skGuardIdentity(ctx, st)) return;
          st.busy = true; st.err = '';
          if (ctx.__paint) ctx.__paint();
          Sleepy.media.get(last.mediaId).then(function (rec) {
            st.busy = false;
            if (!rec || !rec.blob) {
              skSheetIndexForget(last.mediaId);   /* 本体已不在：索引顺手清掉 */
              st.err = '上次的整版图找不到了（可能被清过），重新生成一张吧';
              if (ctx.__paint) ctx.__paint();
              return;
            }
            if (st.sheet && st.sheet.url) { try { URL.revokeObjectURL(st.sheet.url); } catch (e1) { /* 忽略 */ } }
            st.target = last.target || st.target;
            st.mode = last.mode || st.mode;
            st.genderPick = last.genderPick || st.genderPick;
            st.customPicks = Array.isArray(last.customPicks) ? last.customPicks.slice() : st.customPicks;
            st.customLines = Array.isArray(last.customLines) ? last.customLines.slice() : st.customLines;
            st.sheet = {
              mediaId: last.mediaId, blob: rec.blob, slices: null, threshold: 235,
              url: URL.createObjectURL(rec.blob)
            };
            st.removed = {};
            st.step = 4;
            if (ctx.__paint) ctx.__paint();
          }).catch(function () {
            st.busy = false;
            st.err = '整版图读不出来，重新生成一张吧';
            if (ctx.__paint) ctx.__paint();
          });
        };
        resumeCard.appendChild(txt);
        resumeCard.appendChild(btn);
        shell.appendChild(resumeCard);
      }
    }
  }

  /* ---- 步骤 4：切片预览（空格标红 / 阈值重切 / 单片删除） ---- */
  function paintSkPreview(ctx, shell, st) {
    var back = h('button', 'sk-back', '‹ 重新生成');
    back.type = 'button';
    back.onclick = function () { st.step = 3; st.sheet = null; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(back);

    /* 纸质整版卡（demo 的 SHEET EXCLUSIVE 语言）：整版缩略 + 衬线题签 */
    if (st.sheet.url) {
      var sheetCard = h('div', 'sk-sheet-card');
      var sheetImg = h('img', 'sk-sheet-img');
      sheetImg.alt = '整版贴纸';
      sheetImg.src = st.sheet.url;
      sheetCard.appendChild(sheetImg);
      var cap = h('div', 'sk-sheet-cap');
      cap.appendChild(h('span', '', '✦ ' + (String(st.char && st.char.name || 'TA').trim() +
        ' × ' + core.labelOfUser(st.user, '我')) + ' · STICKER SHEET ✦'));
      sheetCard.appendChild(cap);
      shell.appendChild(sheetCard);
    }

    /* 首次进预览：还没切片 → 先切（重切走下面的滑杆，只改临时结果） */
    if (!st.sheet.slices) {
      if (!st.cutBusy) {
        st.cutBusy = true;
        Sleepy.stickerCut.cutSheet3x2(st.sheet.blob, { threshold: st.sheet.threshold })
          .then(function (cells) {
            cells.forEach(function (c) { c.url = c.blob ? URL.createObjectURL(c.blob) : ''; });
            st.sheet.slices = cells;
            st.cutBusy = false;
            if (ctx.__paint) ctx.__paint();
          })
          .catch(function (e) {
            st.cutBusy = false;
            st.err = '切片失败：' + String(e && e.message || e);
            if (ctx.__paint) ctx.__paint();
          });
      }
      if (st.err) shell.appendChild(h('p', 'sk-err', st.err));
      shell.appendChild(h('p', 'sk-slot-tip', '正在切片…'));
      return;
    }

    var slices = st.sheet.slices;
    var grid = h('div', 'sk-cut-grid');
    var valid = 0;
    slices.forEach(function (s) {
      var removed = st.removed[s.sliceIndex];
      var cell = h('div', 'sk-cut-cell' +
        (s.empty ? ' is-empty' : '') + (removed ? ' is-removed' : ''));
      if (!s.empty && !removed) {
        valid++;
        var img = h('img', 'sk-cut-img');
        img.alt = '第 ' + (s.sliceIndex + 1) + ' 格';
        if (s.url) img.src = s.url;
        cell.appendChild(img);
        var rm = h('button', 'sk-cut-rm', '不用这张');
        rm.type = 'button';
        rm.onclick = function () {
          st.removed[s.sliceIndex] = true;
          if (ctx.__paint) ctx.__paint();
        };
        cell.appendChild(rm);
      } else if (removed) {
        cell.appendChild(h('span', 'sk-cut-tag', '已不用'));
        var back2 = h('button', 'sk-cut-rm', '要回来');
        back2.type = 'button';
        back2.onclick = function () {
          delete st.removed[s.sliceIndex];
          if (ctx.__paint) ctx.__paint();
        };
        cell.appendChild(back2);
      } else {
        cell.appendChild(h('span', 'sk-cut-tag', '这一格是空的'));
      }
      grid.appendChild(cell);
    });
    shell.appendChild(grid);
    shell.appendChild(h('p', 'sk-slot-tip',
      valid + ' 张有效' + (valid === 0 ? ' —— 至少要有一张才能入库' : '')));

    /* 阈值滑杆重切（只改临时切片，不碰任何已入库数据） */
    var re = h('div', 'sk-recut');
    re.appendChild(h('span', 'sk-gender-label', '去背景力度 ' + st.sheet.threshold));
    var slider = h('input', 'sk-threshold');
    slider.type = 'range';
    slider.min = '200'; slider.max = '250'; slider.value = String(st.sheet.threshold);
    var reBtn = h('button', 'sk-cut-rm', '按这个力度重切');
    reBtn.type = 'button';
    reBtn.disabled = !!st.cutBusy;
    reBtn.onclick = function () {
      var th = Number(slider.value) || 235;
      st.cutBusy = true;
      if (ctx.__paint) ctx.__paint();
      Sleepy.stickerCut.cutSheet3x2(st.sheet.blob, { threshold: th })
        .then(function (cells) {
          slices.forEach(function (old) {
            if (old.url) { try { URL.revokeObjectURL(old.url); } catch (e) { /* 忽略 */ } }
          });
          cells.forEach(function (c) { c.url = c.blob ? URL.createObjectURL(c.blob) : ''; });
          st.sheet.slices = cells;
          st.sheet.threshold = th;
          st.cutBusy = false;
          if (ctx.__paint) ctx.__paint();
        })
        .catch(function (e) {
          st.cutBusy = false;
          st.err = String(e && e.message || e);
          if (ctx.__paint) ctx.__paint();
        });
    };
    re.appendChild(slider);
    re.appendChild(reBtn);
    shell.appendChild(re);
    if (st.err) shell.appendChild(h('p', 'sk-err', st.err));

    var next = h('button', 'sk-next', '下一步 · 归属与入库');
    next.type = 'button';
    next.disabled = valid < 1 || st.cutBusy;
    next.onclick = function () { st.step = 5; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(next);
  }

  /* ---- 步骤 5：命名、归属、入库 ---- */
  function paintSkSave(ctx, shell, st) {
    var back = h('button', 'sk-back', '‹ 回预览');
    back.type = 'button';
    back.onclick = function () { st.step = 4; if (ctx.__paint) ctx.__paint(); };
    shell.appendChild(back);

    var charName = String(st.char && st.char.name || 'TA').trim() || 'TA';
    var groupName = st.target === 'both' ? ('贴纸工坊 · ' + charName + ' × 我们')
      : (st.target === 'char' ? ('贴纸工坊 · ' + charName) : '贴纸工坊 · 我的');

    shell.appendChild(h('p', 'sk-gender-label', '分组：' + groupName + '（可在表情包管理里改）'));

    /* 归属说明 + user 单人的马甲多选（ownerMaskIds: [] = 谁也看不见，明说） */
    var owner = h('div', 'sk-save-owner');
    if (st.target === 'char') {
      owner.appendChild(h('p', '', '这些贴纸只属于「' + charName + '」：只在 TA 的会话里出现、只有 TA 能发。'));
    } else if (st.target === 'both') {
      owner.appendChild(h('p', '', '双人贴纸只属于你们俩的会话（不进群聊）。'));
    } else {
      owner.appendChild(h('p', '', '我的贴纸要同步给哪些马甲？一件都不选 = 谁都看不见。'));
      var masks = core.masksOfSandbox ? core.masksOfSandbox(core.activeSandbox()) : [];
      masks.forEach(function (m) {
        var lab = h('label', 'sk-mask-pick');
        var cb = h('input', '');
        cb.type = 'checkbox';
        cb.checked = !!(st.maskPick[m.id]);
        cb.onchange = function () { st.maskPick[m.id] = !!cb.checked; };
        lab.appendChild(cb);
        lab.appendChild(h('span', '', core.labelOfUser(m, '我') + (m.isDefault ? '（大号）' : '')));
        owner.appendChild(lab);
      });
    }
    shell.appendChild(owner);

    if (st.err) shell.appendChild(h('p', 'sk-err', st.err));
    if (st.savedGroup) {
      shell.appendChild(h('p', 'sk-ok', '存好了：' + st.savedCount + ' 张进了「' + st.savedGroup + '」。'));

      /* 缺口②：本批内联管理 —— 以前想删/改名只能跑去聊天的表情管理页
         （removeSheet 一直是孤儿能力）。这里直接列出本批：缩略图 + 单张删
         + 整版删（连带回收切片媒体与断点索引）。 */
      var batch = h('div', 'sk-batch');
      batch.appendChild(h('div', 'sk-sec-label', '这一批'));
      var ids = Array.isArray(st.savedIds) ? st.savedIds : [];
      var alive = ids.map(function (id) {
        return (Sleepy.stickers.findId ? Sleepy.stickers.findId(id) : null);
      }).filter(function (s) { return s; });
      if (!alive.length) {
        batch.appendChild(h('p', 'sk-slot-tip', '这一批已经删干净了。'));
      }
      alive.forEach(function (s) {
        var row = h('div', 'sk-batch-row');
        var th = h('img', 'sk-batch-thumb');
        th.alt = s.name || '贴纸';
        if (Sleepy.media && Sleepy.media.url) {
          Sleepy.media.url(s.mediaId).then(function (u) { th.src = u; }).catch(function () { /* 缩略图缺了不碍事 */ });
        }
        row.appendChild(th);
        var nm = h('span', 'sk-batch-name', s.name || '表情');
        row.appendChild(nm);
        var del = h('button', 'sk-batch-del', '删');
        del.type = 'button';
        del.onclick = function () {
          Sleepy.stickers.remove(s.id);
          if (ctx.__paint) ctx.__paint();
        };
        row.appendChild(del);
        batch.appendChild(row);
      });
      if (alive.length && st.savedSheetId) {
        var wipe = h('button', 'sk-batch-wipe', '整版都不要了（连同切片一起删）');
        wipe.type = 'button';
        wipe.onclick = function () {
          var n = Sleepy.stickers.removeSheet(st.savedSheetId);
          skSheetIndexForget(st.sheet ? st.sheet.mediaId : null);
          skState = null;
          ctx.toast('删掉了 ' + n + ' 张', 'ok');
          if (ctx.__paint) ctx.__paint();
        };
        batch.appendChild(wipe);
      }
      shell.appendChild(batch);

      var again = h('button', 'sk-next', '再做一批');
      again.type = 'button';
      again.onclick = function () { skState = null; if (ctx.__paint) ctx.__paint(); };
      shell.appendChild(again);
      var mgr = h('button', 'sk-back', '去表情包管理 ›');
      mgr.type = 'button';
      mgr.onclick = function () { ctx.open('stickers'); };
      shell.appendChild(mgr);
      return;
    }

    var save = h('button', 'sk-next', st.busy ? '入库中…' : '存进表情包库');
    save.type = 'button';
    save.disabled = !!st.busy;
    save.onclick = function () {
      if (st.busy) return;
      if (skGuardIdentity(ctx, st)) return;    /* 核查 4：旧 sheet 不存给新身份 */
      var picked = st.sheet.slices.filter(function (s) {
        return !s.empty && !st.removed[s.sliceIndex] && s.blob;
      });
      if (!picked.length) {
        st.err = '一张有效的都没有，回预览看看吧';
        if (ctx.__paint) ctx.__paint();
        return;
      }
      var maskIds = null;
      if (st.target === 'user') {
        maskIds = Object.keys(st.maskPick).filter(function (k) { return st.maskPick[k]; });
        if (!maskIds.length) {
          st.err = '一件马甲都没勾 —— 这样谁也看不见，先勾至少一件';
          if (ctx.__paint) ctx.__paint();
          return;
        }
      }
      st.busy = true; st.err = '';
      if (ctx.__paint) ctx.__paint();

      /* 先媒体后 stickers（施工单 §六入库纪律）：逐片 media.put → 一次整批写 */
      Promise.all(picked.map(function (s) {
        var name = skSliceName(st, s);
        return Sleepy.media.put(s.blob, { name: name, kind: 'sticker', w: s.width, h: s.height })
          .then(function (mid) { return { slice: s, mediaId: mid, name: name }; });
      })).then(function (items) {
        var sheetId = 'shs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        var recs = items.map(function (it) {
          return {
            name: it.name,
            mediaId: it.mediaId,
            group: groupName,
            kind: 'sticker',
            sheetId: sheetId,
            sheetMediaId: st.sheet.mediaId,
            sliceIndex: it.slice.sliceIndex,
            sourceVersion: 1,
            emotion: skEmotionKey(st, it.slice.sliceIndex),
            matchKey: 'sk:' + sheetId + ':' + it.slice.sliceIndex,
            ownerCharId: (st.target === 'user') ? null : (st.char ? st.char.id : null),
            ownerUserId: (st.target === 'both') ? (st.user ? st.user.id : null) : null,
            ownerMaskIds: (st.target === 'user') ? maskIds : [],
            allowInGroups: false
          };
        });
        var added = Sleepy.stickers.addSheetStickers(recs);
        if (!added.length) throw new Error('一条都没写进去');
        st.busy = false;
        st.savedGroup = groupName;
        st.savedCount = added.length;
        st.savedSheetId = sheetId;
        st.savedIds = added.map(function (s) { return s.id; });
        if (ctx.__paint) ctx.__paint();
      }).catch(function (e) {
        /* 施工单：失败不留半套无引用数据 —— 记录可清理的 sheetId 供重试/回收 */
        st.busy = false;
        st.err = '入库没成功（' + String(e && e.message || e) + '）—— 整版图还在'
          + '（sheetMediaId=' + st.sheet.mediaId + '），可直接重试入库';
        if (ctx.__paint) ctx.__paint();
      });
    };
    shell.appendChild(save);
  }

  function skEmotionKey(st, sliceIndex) {
    if (st.target === 'both') {
      return ['big_hug', 'cheek_pinch', 'good_morning', 'good_night', 'super_happy', 'head_pat'][sliceIndex] || 's' + sliceIndex;
    }
    var female = skEffectiveGender(st, true, st.target === 'char' ? st.char : st.user) === 'female';
    return (female
      ? ['good_morning', 'good_night', 'hug_request', 'pouting_angry', 'super_happy', 'shy_blush']
      : ['good_morning', 'good_night', 'hug_request', 'pouting_angry', 'super_happy', 'gentle_comfort']
    )[sliceIndex] || 's' + sliceIndex;
  }

  function skSliceName(st, s) {
    if (st.mode === 'custom') {
      var pick = st.customPicks[s.sliceIndex];
      if (pick != null && SK_PRESETS[pick]) return SK_PRESETS[pick].zh;
      var t = String(st.customLines[s.sliceIndex] || '').trim();
      return t ? t.slice(0, 8) : ('贴纸 ' + (s.sliceIndex + 1));
    }
    if (st.target === 'both') {
      return ['抱抱', '捏脸', '早安', '晚安', '好耶', '摸头'][s.sliceIndex] || ('贴纸 ' + (s.sliceIndex + 1));
    }
    var female = skEffectiveGender(st, true, st.target === 'char' ? st.char : st.user) === 'female';
    return (female
      ? ['早安', '晚安', '要抱抱', '生气', '好耶', '害羞']
      : ['早安', '晚安', '要抱抱', '生气', '好耶', '摸摸'])[s.sliceIndex] || ('贴纸 ' + (s.sliceIndex + 1));
  }

  /* -- 贴纸抽屉（C2 实贴）：挂页面内 absolute（同 we-drawer 范式，
     .page 有 transform 不能用 fixed）。数据源走统一可见性出口，
     只列 C2 切片（kind:'sticker'）。贴入时复制一份媒体快照，
     藏品存自己的 mediaId —— 表情包里删掉原件不影响已贴的藏品。 */
  function openStickerDrawer(ctx, en) {
    var pool = (Sleepy.stickers && Sleepy.stickers.getVisibleStickers)
      ? Sleepy.stickers.getVisibleStickers({ scope: 'collection' })
        .filter(function (s) { return s.kind === 'sticker' && s.mediaId; })
      : [];
    var body = ctx.body;
    var drawer = h('div', 'sk-drawer');
    var scrim = h('div', 'sk-drawer-scrim');
    var sheet = h('div', 'sk-drawer-sheet');
    var head = h('div', 'sk-drawer-head');
    head.appendChild(h('span', 'sk-drawer-title', '贴一张到这张拍立得上'));
    var close = h('button', 'sk-drawer-close', '×');
    close.type = 'button';
    head.appendChild(close);
    sheet.appendChild(head);

    if (!pool.length) {
      sheet.appendChild(h('p', 'sk-slot-tip', '还没有能贴的贴纸 —— 去贴纸工坊做一批吧。'));
      var goWk = h('button', 'sk-next', '去贴纸工坊 ›');
      goWk.type = 'button';
      goWk.onclick = function () { closeDrawer(); ctx.open('sticker-workshop'); };
      sheet.appendChild(goWk);
    } else {
      var grid = h('div', 'sk-drawer-grid');
      pool.forEach(function (s) {
        var cell = h('button', 'sk-drawer-cell');
        cell.type = 'button';
        var im = h('img', 'sk-drawer-img');
        im.alt = s.name || '贴纸';
        cell.appendChild(im);
        cell.appendChild(h('span', 'sk-drawer-name', s.name || '贴纸'));
        if (Sleepy.media && Sleepy.media.url) {
          Sleepy.media.url(s.mediaId).then(function (u) {
            if (u && im.isConnected) im.src = u;
          })['catch'](function () { /* 挂不上就不亮 */ });
        }
        cell.onclick = function () { pasteSticker(ctx, en, s); };
        grid.appendChild(cell);
      });
      sheet.appendChild(grid);
    }

    function closeDrawer() {
      if (drawer.parentNode) drawer.parentNode.removeChild(drawer);
    }
    close.onclick = closeDrawer;
    scrim.onclick = closeDrawer;
    drawer.appendChild(scrim);
    drawer.appendChild(sheet);
    body.appendChild(drawer);
  }

  /* 贴入：媒体复制一份（快照），随机 -6°~+8° 微旋，weStore.patch 持久化 */
  function pasteSticker(ctx, en, sticker) {
    if (!Sleepy.media || !Sleepy.media.get || !Sleepy.media.put) {
      ctx.toast('媒体库没就绪，贴不上', 'warn');
      return;
    }
    Sleepy.media.get(sticker.mediaId).then(function (rec) {
      if (!rec || !rec.blob) throw new Error('原图读不出来了');
      var rot = Math.round((Math.random() * 14 - 6) * 10) / 10;   /* -6 ~ +8 取整到 0.1 */
      return Sleepy.media.put(rec.blob, {
        name: '实贴 · ' + (sticker.name || '贴纸'),
        kind: 'sticker', w: rec.w || 0, h: rec.h || 0
      }).then(function (mid) {
        var list = arr(en.stickers).concat([
          { mediaId: mid, rot: rot, at: Date.now() }
        ]);
        var r = (Sleepy.weStore && Sleepy.weStore.patch)
          ? Sleepy.weStore.patch(en.id, { stickers: list }) : { ok: false };
        if (r && r.ok) {
          ctx.toast('贴上去了', 'ok');
          if (ctx.__paint) ctx.__paint();
        } else {
          ctx.toast('没贴上（藏品写不进去）', 'warn');
        }
      });
    }).catch(function (e) {
      ctx.toast('贴失败：' + String(e && e.message || e), 'warn');
    });
  }

  Sleepy.register('sticker-workshop', {
    title: '贴纸工坊',
    render: function (ctx) {
      ctx.__paint = function () { paintSticker(ctx); };
      paintSticker(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

  /* 导出供冒烟/真机核对：复核状态、只读当前房、kind 兼容 */
  Sleepy.collectionStore = {
    entries: entries,
    findInScope: findInScope,
    checkSource: checkSource,
    kindOf: kindOf,
    KIND_LABEL: KIND_LABEL
  };

})(window);
