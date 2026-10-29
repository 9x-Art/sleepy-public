/* ============================================================
   page-group.js — 线上群聊（实施总纲 v1 · 阶段 B/C）
   依赖：core.js、core-group.js（Sleepy.groupStore）、ui.js、app.js

   三个页面：
     group-create  建群三步（创建身份 → 选择成员 → 群资料）
     group-chat    群消息页（多账号时间线 / 切发言身份 / @）
     group-detail  群详情与成员管理

   ---- 本轮（阶段 B + C 的第一批）做了什么 ----
     数据层全量（core-group.js）；建群全流程；群消息页静态收发 +
     ＋面板切换发言身份 + 长按头像 @；详情页成员管理 + 群设置。
     还没做（后面几轮）：左滑引用、撤回的 UI 入口、AI 调度、
     自动续聊、延迟补回、多人线下交接。

   ---- 成员按账号、不按本体（总纲 3.4）----
     群成员列表 / 成员计数全部按账号展示。同一角色的两个皮套在群里
     就是两个独立的「人」，UI 不显示它们属于同一个本体 ——
     只有建群勾选页里，同一本体的账号被同时勾上时才提示一句
     「会共享意识与记忆」（这是给 user 看的导演提示，不是群内信息）。

   ---- 视觉 ----
     布局结构照四张 Demo；配色全部走主题变量（--g-* / --amber /
     --paper / --text-faint），不引入 Demo 的鼠尾草绿硬编码 ——
     否则夜间模式没着落。拼图头像的六格底色是唯一的新色值，
     选的都是暖调（没有一種蓝），四个主题下都不发脏。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var core = Sleepy.core;
  var h = ui.h;

  function gs() { return Sleepy.groupStore; }
  function island() { return Sleepy.island || null; }

  function newId() { return core.newId('gu'); }
  function fmtTime(ts) { return ui.timeStr(ts); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"';

  var ICON_PLUS = '<svg ' + SVG + '><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_DOOR = '<svg ' + SVG + '><path d="M5 21h14M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M11 12h2"/></svg>';
  var ICON_MORE = '<svg ' + SVG + '><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  var ICON_SEARCH = '<svg ' + SVG + '><circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/></svg>';
  var ICON_SWITCH = '<svg ' + SVG + '><path d="M4 9h12l-3-3M20 15H8l3 3"/></svg>';
  var ICON_PHOTO = '<svg ' + SVG + '><rect x="3.4" y="5" width="17.2" height="14" rx="2.6"/><circle cx="9" cy="10" r="1.5"/><path d="M4.6 16.6l4.4-3.9 3.4 3 3-2.5 4 3.4"/></svg>';
  var ICON_FILE = '<svg ' + SVG + '><path d="M6.2 3.6h6.3l5.3 5.3v10.5a1.2 1.2 0 0 1-1.2 1.2H6.2A1.2 1.2 0 0 1 5 19.4V4.8a1.2 1.2 0 0 1 1.2-1.2z"/><path d="M12.4 3.6v5.3h5.4"/></svg>';
  var ICON_TRANSFER = '<svg ' + SVG + '><rect x="2.8" y="6.6" width="18.4" height="10.8" rx="2.2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.2 9.8v4.4M17.8 9.8v4.4"/></svg>';
  var ICON_PAT = '<svg ' + SVG + '><path d="M10 12V6.3a1.5 1.5 0 0 1 3 0V12"/><path d="M13 11.6V5a1.5 1.5 0 0 1 3 0v7"/><path d="M16 12V8a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1.6a5 5 0 0 1-3.5-1.4l-2.6-2.6a1.5 1.5 0 0 1 2.1-2.1L10 16"/></svg>';
  var ICON_GENIMG = '<svg ' + SVG + '><path d="M4.6 19.4l8.6-8.6"/><path d="M15.6 4.4l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/><path d="M6 4.8l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L4 6.8l1.4-.6z"/></svg>';
  var ICON_STICKER = '<svg ' + SVG + '><circle cx="12" cy="12" r="8.6"/><path d="M8.8 14.2a4.2 4.2 0 0 0 6.4 0"/><path d="M9.2 9.6h.01M14.8 9.6h.01"/></svg>';
  /* 发送键：小猫爪（跟私聊同一只） */
  var ICON_PAW = '<svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true">' +
    '<ellipse cx="12" cy="15.9" rx="5.8" ry="4.5"/>' +
    '<ellipse cx="4.7" cy="11.7" rx="2.1" ry="2.7"/>' +
    '<ellipse cx="9.3" cy="6.7" rx="2.2" ry="2.9"/>' +
    '<ellipse cx="14.7" cy="6.7" rx="2.2" ry="2.9"/>' +
    '<ellipse cx="19.3" cy="11.7" rx="2.1" ry="2.7"/>' +
    '</svg>';

  /* ==================== 通用小组件 ==================== */

  /* 单个头像格：有图用图，没图落**幽灵头像**（2026-10-24，v255 起全库统一
     口径：不再「首字 + 暖色底」—— 群成员也是 user 侧记录，setAvatarBg 会
     按 kind 落 user 幽灵并加 has-img/is-default-ava）。
     图的地址走 core.setAvatarImg（avatarMedia 图库优先，回落网址）——
     别直接读 meta.avatar 当 src，本地图会显示不出来。 */
  function tileEl(meta, size) {
    var el = h('span', 'gu-tile' + (size ? ' gu-tile-' + size : ''));
    el.style.background = gs().tileColor(meta.name);
    var img = h('img', 'gu-tile-img');
    img.alt = '';
    core.setAvatarImg(img, meta);
    el.appendChild(img);
    return el;
  }

  /* 群自定义头像的三种来源与统一取址：
     avatarMedia（本地图，IndexedDB —— 正确做法）/
     avatar（http 链接）/ 老存档残留的 data: base64。
     老的 base64 在首次显示时顺手搬进图库，搬完清掉群记录里的 base64
     （群记录在 localStorage，塞二进制迟早爆 5MB 配额）。
     搬家失败就原样返回，至少还能显示，下次再试。 */
  var avatarMigrating = {};
  function groupAvatarSrc(g) {
    if (g.avatarMedia && Sleepy.media && Sleepy.media.url) {
      return Sleepy.media.url(g.avatarMedia);
    }
    var legacy = g.avatar || '';
    if (!/^data:/.test(legacy)) return Promise.resolve(legacy);
    if (!Sleepy.media || !Sleepy.media.put || !Sleepy.media.available ||
        typeof fetch !== 'function' || avatarMigrating[g.id]) {
      return Promise.resolve(legacy);
    }
    avatarMigrating[g.id] = true;
    Sleepy.media.available().then(function (okd) {
      if (!okd) return legacy;
      return fetch(legacy).then(function (res) { return res.blob(); })
        .then(function (blob) {
          return Sleepy.media.put(blob, { name: '群头像', kind: 'avatar' });
        })
        .then(function (mid) {
          return gs().updateGroup(g.id, { avatar: '', avatarMedia: mid, avatarMode: 'custom' });
        });
    }).catch(function () { /* 迁移失败保留原样，下次显示再试 */ }).then(function () {
      delete avatarMigrating[g.id];
    });
    return Promise.resolve(legacy);
  }
  function hasCustomAvatar(g) {
    return !!(g && (g.avatarMedia || g.avatar));
  }

  /* 拼图头像：前四个成员的 2×2。群在任何列表里的脸就是它。
     群自定义过头像（avatarMedia / avatar）就整格换成那一张图。 */
  function collageEl(groupId, size) {
    var g = gs().findGroup(groupId);
    if (hasCustomAvatar(g)) {
      var single = h('span', 'gu-collage is-single' + (size ? ' gu-collage-' + size : ''));
      var el = h('span', 'gu-tile');
      el.style.background = gs().tileColor(g.id);
      var img = h('img', 'gu-tile-img');
      img.alt = '';
      groupAvatarSrc(g).then(function (src) { if (src) img.src = src; });
      el.appendChild(img);
      single.appendChild(el);
      return single;
    }
    var wrap = h('span', 'gu-collage' + (size ? ' gu-collage-' + size : ''));
    var members = gs().membersOf(groupId);
    for (var i = 0; i < 4; i++) {
      var m = members[i];
      if (!m) break;
      wrap.appendChild(tileEl(gs().accountMeta(m), 'sm'));
    }
    return wrap;
  }

  /* 通讯录式的成员挑选行。selected 控制勾选态 */
  function pickRow(o) {
    var row = h('button', 'gg-choice' + (o.selected ? ' is-on' : ''));
    row.type = 'button';
    row.appendChild(tileEl(o.meta, 'md'));
    var body = h('span', 'gg-choice-body');
    body.appendChild(h('b', null, o.meta.name));
    body.appendChild(h('small', null, o.sub || ''));
    row.appendChild(body);
    row.appendChild(h('span', o.radio ? 'gg-radio' : 'gg-check'));
    if (o.onClick) row.addEventListener('click', o.onClick);
    return row;
  }

  /* ==================== 建群候选（这间房里能拉谁） ==================== */

  /* user 账号 = 房里的马甲；char 账号 = 大号 + 它的皮套；
     NPC = 房里全部 NPC（它们默认就有线上账号）。
     孤岛也放行（2026-09-19 用户拍板）：孤岛锁的是「只有一位主角色」，
     不是「不能有群」—— 我 + TA + 岛上的 NPC 照样能拉一个小群。 */
  function collectCandidates() {
    var sb = core.activeSandbox();
    if (!sb) return { ok: false, message: '还没有进任何一间房' };

    var masks = core.masksOfSandbox(sb.id);
    if (!masks.length) {
      var me = core.activeUser();
      if (me) masks = [me];
    }

    var entities = [];
    var isl = island();
    core.charsOfSandbox(sb.id).forEach(function (m) {
      var subs = isl
        ? isl.childrenOf(sb.id, m.id, 'sub', 'char')
        : core.subChars(m.id);
      entities.push({ main: m, subs: subs });
    });

    /* NPC 唯一口径 core.npcsOfRoom：属于整座岛（含老数据兜底），
       不再按「挂在谁名下」分组 */
    var npcs = core.npcsOfRoom(sb);
    return { ok: true, sb: sb, masks: masks, entities: entities, npcs: npcs };
  }

  /* ==================== 页面：新建群聊（三步） ==================== */

  Sleepy.register('group-create', {
    title: '新建群聊',
    render: function (ctx) {
      var cand = collectCandidates();
      var body = ctx.body;
      body.classList.add('gg-page');

      if (!cand.ok) {
        body.appendChild(h('p', 'set-group-note', cand.message));
        return;
      }
      /* 孤岛不再拦：一位主角色 + 岛上 NPC 照样能组一个群（用户定的）。 */
      /* ---- 会话内状态（页面实例缓存，进页重 render 重置）---- */
      var state = {
        step: 0,
        creator: (cand.masks[0] && cand.masks[0].id) || null,
        members: [],        /* [{kind, ownerId, accountId}] 不含创建者 */
        opening: 'natural',
        name: ''
      };

      /* 步骤条 */
      var stepsBar = h('div', 'gg-steps');
      ['创建身份', '选择成员', '群聊资料'].forEach(function (t, i) {
        var s = h('div', 'gg-step');
        s.appendChild(h('i', null, String(i + 1)));
        s.appendChild(h('span', null, t));
        stepsBar.appendChild(s);
      });
      body.appendChild(stepsBar);

      var viewport = h('div', 'gg-viewport');
      body.appendChild(viewport);

      /* 底部按钮条 */
      var bottom = h('div', 'gg-bottom');
      var backBtn = h('button', 'gg-btn gg-btn-back', '取消');
      backBtn.type = 'button';
      var nextBtn = h('button', 'gg-btn gg-btn-next', '下一步');
      nextBtn.type = 'button';
      bottom.appendChild(backBtn);
      bottom.appendChild(nextBtn);
      body.appendChild(bottom);

      function toast(t) { ctx.toast(t, 'warn'); }

      function paintSteps() {
        var kids = stepsBar.children;
        for (var i = 0; i < kids.length; i++) {
          kids[i].classList.toggle('is-active', i === state.step);
          kids[i].classList.toggle('is-done', i < state.step);
        }
        backBtn.textContent = state.step === 0 ? '取消' : '上一步';
        nextBtn.textContent = state.step === 2 ? '创建群聊' : '下一步';
      }

      function allSpecs() {
        var out = [{ kind: 'user', ownerId: 'user', accountId: state.creator }];
        return out.concat(state.members);
      }

      /* ---------- 第 1 步：创建身份 ---------- */
      function pageCreator() {
        var wrap = h('div', 'gg-pagepane');
        wrap.appendChild(h('h2', 'gg-intro-title', '由谁发起？'));
        wrap.appendChild(h('p', 'gg-intro-sub',
          '选择一个账号作为创建者与初始群主。群内只会看到这个公开身份。'));
        wrap.appendChild(h('p', 'gg-sect', '我的账号'));
        cand.masks.forEach(function (m) {
          wrap.appendChild(pickRow({
            meta: { name: core.labelOfUser(m), avatar: m.avatar, initial: core.initialOfUser(m) },
            sub: m.isDefault ? '主账号' : '马甲',
            radio: true,
            selected: state.creator === m.id,
            onClick: function () { state.creator = m.id; paint(); }
          }));
        });
        return wrap;
      }

      /* ---------- 第 2 步：选择成员 ---------- */
      function pageMembers() {
        var wrap = h('div', 'gg-pagepane');

        wrap.appendChild(h('h2', 'gg-intro-title', '邀请哪些账号？'));
        wrap.appendChild(h('p', 'gg-intro-sub',
          '按角色查看账号，实际加入群聊的是你勾选的公开账号。'));

        /* 已选择条 */
        var strip = h('div', 'gg-strip');
        var creatorMask = core.findUser(state.creator);
        strip.appendChild(chipOf({
          name: creatorMask ? creatorMask.name : '我',
          avatar: creatorMask ? creatorMask.avatar : '',
          fixed: true
        }));
        state.members.forEach(function (m, idx) {
          var kind = m.kind;
          var rec = kind === 'user' ? core.findUser(m.accountId) : core.findChar(m.accountId);
          var chip = chipOf({
            name: rec ? rec.name : '?',
            avatar: rec ? (rec.avatar || '') : '',
            fixed: false
          });
          chip.addEventListener('click', function () {
            state.members.splice(idx, 1);
            paint();
          });
          strip.appendChild(chip);
        });
        wrap.appendChild(h('p', 'gg-sect', '已选择'));
        wrap.appendChild(strip);

        /* 我的其他身份 */
        var others = cand.masks.filter(function (m) { return m.id !== state.creator; });
        if (others.length) {
          wrap.appendChild(h('p', 'gg-sect', '我的其他身份'));
          others.forEach(function (m) {
            wrap.appendChild(pickRow({
              meta: { name: m.name, avatar: m.avatar, initial: core.initialOf(m.name) },
              sub: '可作为另一个账号加入',
              selected: hasSpec('user', m.accountId),
              onClick: function () { toggleSpec('user', 'user', m.accountId); }
            }));
          });
        }

        /* 角色：按本体分组，大号 + 皮套 */
        cand.entities.forEach(function (en) {
          var picked = [];
          var head = h('div', 'gg-entity-head');
          head.appendChild(h('strong', null, en.main.name));
          head.appendChild(h('span', null, (1 + en.subs.length) + ' 个账号'));
          wrap.appendChild(head);

          var card = h('div', 'gg-card');
          [en.main].concat(en.subs).forEach(function (c) {
            var on = hasSpec('char', c.id);
            if (on) picked.push(c.name);
            card.appendChild(pickRow({
              meta: { name: c.name, avatar: c.avatar, initial: core.initialOf(c.name) },
              sub: (c.id === en.main.id) ? '公开账号' : '另一个公开身份',
              selected: on,
              onClick: function () { toggleSpec('char', en.main.id, c.id); }
            }));
          });
          /* 同本体多账号勾选提示：只给 user 看的导演提示（总纲 1.2） */
          if (picked.length > 1) {
            card.appendChild(h('p', 'gg-notice',
              picked.join('、') + ' 属于同一角色 —— 会共享意识与记忆，' +
              '但会以不同身份出现在群里。'));
          }
          wrap.appendChild(card);
        });

        /* NPC */
        if (cand.npcs.length) {
          wrap.appendChild(h('p', 'gg-sect', '其他人物'));
          var npcCard = h('div', 'gg-card');
          cand.npcs.forEach(function (n) {
            npcCard.appendChild(pickRow({
              meta: { name: n.name, avatar: n.avatar, initial: core.initialOf(n.name) },
              sub: '拥有线上账号的 NPC',
              selected: hasSpec('npc', n.id),
              onClick: function () { toggleSpec('npc', n.id, n.id); }
            }));
          });
          wrap.appendChild(npcCard);
        }
        return wrap;
      }

      function chipOf(m) {
        var chip = h('span', 'gg-chip');
        chip.appendChild(tileEl({ name: m.name, avatar: m.avatar, initial: core.initialOf(m.name) }, 'sm'));
        if (!m.fixed) chip.appendChild(h('em', null, '×'));
        return chip;
      }

      function hasSpec(kind, accountId) {
        for (var i = 0; i < state.members.length; i++) {
          if (state.members[i].kind === kind && state.members[i].accountId === accountId) return true;
        }
        return false;
      }
      function toggleSpec(kind, ownerId, accountId) {
        if (hasSpec(kind, accountId)) {
          state.members = state.members.filter(function (m) {
            return !(m.kind === kind && m.accountId === accountId);
          });
        } else {
          state.members.push({ kind: kind, ownerId: ownerId, accountId: accountId });
        }
        paint();
      }

      /* ---------- 第 3 步：群聊资料 ---------- */
      function pageMeta() {
        var wrap = h('div', 'gg-pagepane');
        wrap.appendChild(h('h2', 'gg-intro-title', '最后确认一下'));
        wrap.appendChild(h('p', 'gg-intro-sub',
          '这里只设置公开资料与开场方式，其他群聊规则以后仍可修改。'));

        /* 拼图头像预览（用已选账号） */
        var cover = h('div', 'gg-cover');
        var cg = h('span', 'gu-collage gu-collage-lg');
        var specs = allSpecs();
        for (var i = 0; i < Math.min(4, specs.length); i++) {
          var sp = specs[i];
          var rec = sp.kind === 'user' ? core.findUser(sp.accountId) : core.findChar(sp.accountId);
          var recIsUser = sp.kind === 'user';
          cg.appendChild(tileEl({
            name: rec ? (recIsUser ? core.labelOfUser(rec) : rec.name) : '?',
            avatar: rec ? (rec.avatar || '') : '',
            initial: rec ? (recIsUser ? core.initialOfUser(rec) : core.initialOf(rec.name)) : '?'
          }, 'md'));
        }
        cover.appendChild(cg);
        var copy = h('div', 'gg-cover-copy');
        copy.appendChild(h('b', null, '群头像自动拼图'));
        copy.appendChild(h('p', null, '使用前四个群成员账号头像生成，也可以稍后更换。'));
        cover.appendChild(copy);
        wrap.appendChild(cover);

        var field = h('div', 'gg-field');
        field.appendChild(h('label', null, '群聊名称'));
        var input = h('input');
        input.type = 'text';
        input.maxLength = 24;
        input.value = state.name;
        input.placeholder = '给这个群起个名字';
        input.addEventListener('input', function () { state.name = input.value; paintSummary(); });
        field.appendChild(input);
        wrap.appendChild(field);

        wrap.appendChild(h('p', 'gg-sect', '创建后'));
        var opening = h('div', 'gg-card');
        [['natural', '允许成员自然开场', '有空且有动机的角色可能先说话'],
         ['user', '等我先说', '创建后先保留安静的群聊页面']].forEach(function (row) {
          opening.appendChild(pickRow({
            meta: { name: row[1], initial: '' },
            sub: row[2],
            radio: true,
            selected: state.opening === row[0],
            onClick: function () { state.opening = row[0]; paint(); }
          }));
        });
        wrap.appendChild(opening);

        var summary = h('p', 'gg-summary');
        wrap.appendChild(summary);
        function paintSummary() {
          var creatorMask = core.findUser(state.creator);
          var names = state.members.map(function (m) {
            var rec = m.kind === 'user' ? core.findUser(m.accountId) : core.findChar(m.accountId);
            return rec ? rec.name : '?';
          });
          summary.innerHTML = '<b>' + esc(state.name || '未命名群聊') + '</b><br>创建者：' +
            esc(creatorMask ? creatorMask.name : '我') +
            '<br>账号成员：' + esc(names.length ? names.join('、') : '（还没选）') +
            '<br>开场：' + (state.opening === 'natural' ? '允许成员自然开场' : '等你先发言');
        }
        paintSummary();
        return wrap;
      }

      /* ---------- 装配 ---------- */
      var pages = [pageCreator, pageMembers, pageMeta];
      function paint() {
        paintSteps();
        viewport.innerHTML = '';
        viewport.appendChild(pages[state.step]());
        viewport.scrollTop = 0;
      }

      backBtn.addEventListener('click', function () {
        if (state.step > 0) { state.step--; paint(); }
        else ctx.back();
      });
      nextBtn.addEventListener('click', function () {
        if (state.step < 2) { state.step++; paint(); return; }
        if (!state.name.trim()) { toast('请先填写群聊名称'); return; }
        if (!state.members.some(function (m) { return m.kind !== 'user'; })) {
          toast('至少要有一个角色或 NPC 账号'); return;
        }
        var r = gs().createGroup({
          name: state.name,
          ownerAccountId: state.creator,
          members: state.members,
          opening: state.opening
        });
        if (!r.ok) { toast(r.message); return; }
        ctx.toast('已创建「' + r.group.name + '」', 'ok');
        /* 建完直接进群；自然开场的调度交给引擎（等我先说就保持安静） */
        if (Sleepy.groupAI) Sleepy.groupAI.onOpening(r.group.id);
        ctx.open('group-chat', { groupId: r.group.id });
      });

      paint();
    }
  });

  /* ==================== 页面：群消息 ==================== */

  /* 记住每个群当前用的发言账号（会话内）。群里第一次发言前默认群主账号。 */
  var speakingAs = {};
  /* 群引擎活动订阅的退订句柄（group-chat 页面实例间共享一个） */
  var groupChatUnsub = null;

  Sleepy.register('group-chat', {
    title: '群聊',
    render: function (ctx) {
      var groupId = ctx.params.groupId;
      var g = gs().findGroup(groupId);
      if (!g) { ctx.toast('找不到这个群', 'err'); ctx.back(); return; }
      var body = ctx.body;
      body.classList.add('gc-page');

      /* ---------- 顶栏 ---------- */
      function headName() {
        var n = gs().membersOf(groupId).length;
        ctx.setTitle(g.name + '（' + n + '）');
      }
      headName();
      ctx.setActions([
        { label: '多人线下', svg: ICON_DOOR, onClick: function () {
            /* 进门先选「继续上次 / 开一次新的」（照私聊线下的门） */
            if (Sleepy.groupOfflineUI && Sleepy.groupOfflineUI.openDoorSheet) {
              Sleepy.groupOfflineUI.openDoorSheet(ctx, groupId);
            } else {
              ctx.open('group-offline', { groupId: groupId });
            }
          } },
        { label: '搜索群聊记录', svg: ICON_SEARCH, onClick: function () { openSearch(); } },
        { label: '群聊详情', svg: ICON_MORE, onClick: function () {
            ctx.open('group-detail', { groupId: groupId });
          } }
      ]);

      /* ---------- 群聊美化 CSS（群详情「群聊美化」卡编辑，2026-10-05）----------
         复用 apCustomStyle 这个 <style> 槽位 —— 角色外观（私聊）每次进页
         也是先摘再按需挂回，两边天然互斥：
         进私聊 → applyTo 摘掉群 CSS；进群聊 → 这里摘掉私聊 CSS 再挂群的。
         头判 document 是给无头夹具兜底：没有 DOM 就什么都不注入。 */
      if (typeof document !== 'undefined' && document.head) {
        var prevAp = document.getElementById('apCustomStyle');
        if (prevAp && prevAp.parentNode) prevAp.parentNode.removeChild(prevAp);
        var btCss = (g.beautifyCss || '').trim();
        if (btCss) {
          var btStyle = document.createElement('style');
          btStyle.id = 'apCustomStyle';
          btStyle.textContent = '/* 群聊美化 · ' + (g.name || '') + ' */\n' + btCss;
          document.head.appendChild(btStyle);
        }
      }

      /* ---------- 消息时间线 ---------- */
      var list = h('div', 'gc-list');
      body.appendChild(list);

      /* 引用条（左滑引用是下一轮的入口方式，这条 bar 本轮就位） */
      var quoteBar = h('div', 'gc-quotebar');
      var quoteCopy = h('span', 'gc-quote-copy');
      var quoteCancel = h('button', 'gc-quote-cancel', '×');
      quoteCancel.type = 'button';
      quoteBar.appendChild(quoteCopy);
      quoteBar.appendChild(quoteCancel);
      quoteBar.style.display = 'none';
      body.appendChild(quoteBar);

      var quote = null;   /* { id, author, text } */
      quoteCancel.addEventListener('click', function () {
        quote = null;
        quoteBar.style.display = 'none';
      });
      function setQuote(msg) {
        var m = gs().findMember(groupId, msg.senderAccountId);
        var meta = gs().accountMeta(m);
        quote = {
          id: msg.id,
          author: meta.name,
          text: String(msg.content || '').slice(0, 60)
        };
        quoteCopy.innerHTML = '<b>回复 ' + esc(quote.author) + '</b><span>' +
          esc(quote.text) + '</span>';
        quoteBar.style.display = 'flex';
      }

      /* @高亮：@名字 片段上色。名字表来自在群成员的展示名 */
      function memberNameMap() {
        var map = {};
        gs().membersOf(groupId).forEach(function (m) {
          map[gs().accountMeta(m).name] = m.accountId;
        });
        return map;
      }

      function bubbleHtml(msg) {
        var names = memberNameMap();
        var raw = esc(msg.content).replace(/(@[^\s@,，。!?！？]+)/g, function (tok) {
          var nm = tok.slice(1);
          return names.hasOwnProperty(nm) ? '<span class="gc-mention">' + tok + '</span>' : tok;
        });
        /* 引用条不再拼进气泡里（2026-10-29 用户口径）：挂气泡下面、
           不参与气泡宽度 —— 渲染在 renderMessages 里单独出一个 .gc-quote。
           这里只管正文。 */
        return raw;
      }

      function renderMessages() {
        var msgs = gs().messagesOf(groupId);
        list.innerHTML = '';

        /* 顶部系统条：建群事件 */
        var sys = msgs.filter(function (m) { return m.type === 'system'; })[0];
        if (sys) list.appendChild(systemLine(sys.content));

        var members = gs().membersOf(groupId);
        var ownerAccountId = g.ownerAccountId;

        msgs.forEach(function (msg) {
          if (msg.type === 'system') return;   /* 顶部已放建群那条 */

          if (msg.recalledAt) {
            var rm = gs().findMember(groupId, msg.senderAccountId);
            list.appendChild(systemLine(
              (rm ? gs().accountMeta(rm).name : '有人') + ' 撤回了一条消息'));
            return;
          }

          var m = gs().findMember(groupId, msg.senderAccountId);
          var meta = m ? gs().accountMeta(m) : { name: '?', avatar: '', initial: '?' };
          var mine = msg.senderKind === 'user';

          var row = h('div', 'gc-row' + (mine ? ' is-me' : ''));
          row.dataset.id = msg.id;   /* 搜索命中跳回来定位用 */
          row.appendChild(tileEl(meta));

          var mid = h('div', 'gc-mid');
          var nameLine = h('div', 'gc-name');
          nameLine.appendChild(h('span', null, meta.name));
          if (m && m.accountId === ownerAccountId) {
            nameLine.appendChild(h('em', 'gc-owner', '群主'));
          }
          mid.appendChild(nameLine);

          var bubble = h('div', 'gc-bubble');
          if (msg.mentionAll) bubble.classList.add('is-mention-all');
          if (msg.type === 'sticker' || msg.type === 'image') {
            /* 表情包 / 照片：气泡里是一张图（mediaId 走图库，url 直连） */
            bubble.classList.add('is-media');
            var mimg = h('img', 'gc-media');
            mimg.alt = msg.name || msg.content || '图片';
            if (msg.mediaId && Sleepy.media) {
              Sleepy.media.url(msg.mediaId).then(function (u) { if (u) mimg.src = u; });
            } else if (msg.url) {
              mimg.src = msg.url;
            }
            bubble.appendChild(mimg);
          } else if (msg.type === 'qunsheng-share') {
            /* 群声帖子卡（Batch C）：渲染共用 forum-share.cardEl；
               附言先按普通文本一行，卡片点击显式带 sandboxId+postId 回原帖 */
            bubble.classList.add('is-media');
            if (String(msg.content || '').trim()) {
              var qsNote = h('div', 'gc-text');
              qsNote.textContent = msg.content;
              qsNote.style.cssText = 'font-size:12px;line-height:1.6;margin-bottom:6px';
              bubble.appendChild(qsNote);
            }
            bubble.appendChild(Sleepy.forumShare.cardEl(msg, function (qs) {
              /* 回执（Batch D）：群成员打开 → 给分享者记一条 */
              Sleepy.forumShare.markOpened({
                sandboxId: qs.sandboxId, sourcePostId: qs.sourcePostId,
                targetType: 'group', targetId: groupId,
                openerName: meta.name
              });
              Sleepy.nav.open('qunsheng-post', { sandboxId: qs.sandboxId, postId: qs.sourcePostId });
            }));
          } else {
            bubble.innerHTML = bubbleHtml(msg);
          }
          mid.appendChild(bubble);
          /* 引用条挂在**气泡下面**（2026-10-29 用户口径）：gc-bubble 是
             inline-block 按自己的字收缩，引用条单独占一行、有自己的
             宽度上限 —— 引用再长也不会把一两个字的短气泡撑宽。 */
          if (msg.replyToMessageId) {
            var src0 = gs().findMessage(groupId, msg.replyToMessageId);
            if (src0 && !src0.recalledAt) {
              var sm0 = gs().findMember(groupId, src0.senderAccountId);
              mid.appendChild(h('div', 'gc-quote',
                (sm0 ? gs().accountMeta(sm0).name : '?') + '：' +
                String(src0.content || '').slice(0, 40)));
            }
          }
          mid.appendChild(h('div', 'gc-time', fmtTime(msg.createdAt)));
          row.appendChild(mid);
          list.appendChild(row);

          /* 长按头像 = 快速 @（总纲 14.2）；别人行左滑引用下一轮接 */
          attachMentionHold(row.firstChild, meta.name, mine);
          if (!mine) {
            attachSwipeQuote(row, mid, msg);
            /* 长按别人的纯文字 = 留在灯上（署说话人的名）；图片和撤回的不进 */
            if (!msg.url && !msg.recalledAt && String(msg.content || '').trim()) {
              attachLampHold(mid.querySelector('.gc-bubble'), msg, meta.name);
            }
          }
          else attachRecallHold(mid.querySelector('.gc-bubble'), msg);
        });

        try { list.scrollTop = list.scrollHeight; } catch (e) { /* 无头桩 */ }
      }

      function systemLine(text) {
        var line = h('div', 'gc-system');
        line.appendChild(h('span', null, text));
        return line;
      }

      /* ---------- 搜索群聊记录（顶栏放大镜，和私聊同一套面板样式） ----------
         输入即筛本群消息；点结果关面板、跳到那条气泡并描边高亮。 */
      var searchPanel = null;
      function openSearch() {
        if (searchPanel) { searchPanel.classList.add('is-open'); return; }
        searchPanel = h('div', 'chat-search');
        var bar = h('div', 'chat-search-bar');
        var input = h('input', 'chat-search-input');
        input.type = 'text';
        input.placeholder = '搜群聊记录';
        var closeBtn = h('button', 'chat-search-close', '完成');
        closeBtn.type = 'button';
        bar.appendChild(input);
        bar.appendChild(closeBtn);
        var results = h('div', 'chat-search-results');
        searchPanel.appendChild(bar);
        searchPanel.appendChild(results);
        var phone = document.getElementById('phone');
        (phone || ctx.el).appendChild(searchPanel);
        setTimeout(function () { input.focus(); }, 60);

        closeBtn.addEventListener('click', function () {
          searchPanel.classList.remove('is-open');
        });

        input.addEventListener('input', function () {
          var q = String(input.value || '').trim().toLowerCase();
          results.innerHTML = '';
          if (!q) return;
          var msgs = gs().messagesOf(groupId);
          var hits = [];
          for (var i = 0; i < msgs.length && hits.length < 50; i++) {
            var msg = msgs[i];
            if (msg.type === 'system' || msg.recalledAt) continue;
            if (String(msg.content || '').toLowerCase().indexOf(q) >= 0) hits.push(msg);
          }
          if (!hits.length) {
            results.appendChild(h('p', 'chat-search-empty', '没找到'));
            return;
          }
          hits.forEach(function (msg) {
            var m = gs().findMember(groupId, msg.senderAccountId);
            var meta = m ? gs().accountMeta(m) : { name: '?' };
            var r = h('button', 'chat-search-hit');
            r.type = 'button';
            var text = String(msg.content || '');
            var pos = text.toLowerCase().indexOf(q);
            var start = Math.max(0, pos - 18);
            var snippet = (start > 0 ? '…' : '') + text.slice(start, pos + q.length + 30) +
                          (start + q.length + 30 < text.length ? '…' : '');
            r.appendChild(h('span', 'chat-search-role', meta.name));
            r.appendChild(h('span', 'chat-search-text', snippet));
            r.addEventListener('click', function () {
              searchPanel.classList.remove('is-open');
              var row = list.querySelector('[data-id="' + msg.id + '"]');
              var bubble = row ? row.querySelector('.gc-bubble') : null;
              if (bubble) {
                row.scrollIntoView({ block: 'center' });
                bubble.classList.add('is-flash');
                setTimeout(function () { bubble.classList.remove('is-flash'); }, 1600);
              }
            });
            results.appendChild(r);
          });
        });
      }

      /* 长按头像插入 @名字 */
      function attachMentionHold(el, name, mine) {
        if (mine) return;
        var timer = null;
        el.addEventListener('pointerdown', function () {
          timer = setTimeout(function () {
            timer = null;
            insertAt(name);
          }, 520);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
          el.addEventListener(ev, function () {
            if (timer) { clearTimeout(timer); timer = null; }
          });
        });
      }

      /* 长按自己发的气泡 = 撤回。撤回只打戳不删原文（数据层纪律），
         时间线上原位显示「撤回了一条消息」。 */
      function attachRecallHold(bubble, msg) {
        if (!bubble) return;
        var timer = null;
        bubble.addEventListener('pointerdown', function () {
          timer = setTimeout(async function () {
            timer = null;
            var yes = await ui.confirm({
              title: '撤回这条消息？',
              note: '撤回前已经读到的人可能还记得内容。',
              ok: '撤回',
              danger: true
            });
            if (!yes) return;
            gs().recallMessage(groupId, msg.id);
            /* 索引里如果已经有这一条，也得撤掉 —— 撤回的意义就是「当没说过」，
               留着索引等于「撤回也没用，TA 还记得」（见 memoryVec.forget）。 */
            if (Sleepy.memoryVec && Sleepy.memoryVec.forget) {
              Sleepy.memoryVec.forget({ groupId: groupId, ids: [msg.id] })
                ['catch'](function () { /* 同上 */ });
            }
            renderMessages();
          }, 520);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
          bubble.addEventListener(ev, function () {
            if (timer) { clearTimeout(timer); timer = null; }
          });
        });
      }

      /* 长按别人的气泡 = 留在灯上（2026-10-06）。群里的可爱处：
         谁说的话署谁的名（meta.name 直接跟过来），落款在放大卡片时可见。
         不弹确认 —— 长按本身就是明确意图，留错了去灯上等风吹不走，
         走桌面编辑（TODO 组件商城批）。只收纯文字，图片/撤回的不进。 */
      function attachLampHold(bubble, msg, senderName) {
        if (!bubble) return;
        var timer = null;
        bubble.addEventListener('pointerdown', function () {
          timer = setTimeout(function () {
            timer = null;
            var rec = Sleepy.lampNotes && Sleepy.lampNotes.add({
              text: String(msg.content || ''),
              by: senderName || '群友',
              ts: msg.createdAt || Date.now(),
              src: 'group'
            });
            toast(rec ? '已替 ' + (senderName || 'ta') + ' 留在灯上' : '这句留不上灯',
              rec ? 'ok' : 'warn');
          }, 520);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
          bubble.addEventListener(ev, function () {
            if (timer) { clearTimeout(timer); timer = null; }
          });
        });
      }

      /* 左滑引用：气泡上横滑过阈值松手 = 引用（总纲 14.3）。
         与竖向滚动冲突的裁决交给 touch-action：横滑才触发。 */
      function attachSwipeQuote(row, mid, msg) {
        var bubble = mid.querySelector('.gc-bubble');
        if (!bubble) return;
        var x0 = null, dx = 0;
        bubble.addEventListener('pointerdown', function (e) {
          x0 = e.clientX; dx = 0;
        });
        bubble.addEventListener('pointermove', function (e) {
          if (x0 === null) return;
          dx = e.clientX - x0;
          if (dx < 0) {
            bubble.style.transform = 'translateX(' + Math.max(dx, -64) + 'px)';
            bubble.style.opacity = String(Math.max(0.55, 1 + dx / 160));
          }
        });
        function end() {
          if (x0 === null) return;
          if (dx < -44) setQuote(msg);
          bubble.style.transform = '';
          bubble.style.opacity = '';
          x0 = null;
        }
        bubble.addEventListener('pointerup', end);
        bubble.addEventListener('pointercancel', end);
        bubble.addEventListener('pointerleave', end);
      }

      /* ---------- 发言身份 ---------- */
      function currentAccountId() {
        var users = gs().userAccountsOf(groupId);
        var saved = speakingAs[groupId];
        for (var i = 0; i < users.length; i++) {
          if (users[i].accountId === saved) return saved;
        }
        return g.ownerAccountId || (users[0] && users[0].accountId) || null;
      }

      function insertAt(name) {
        var at = input.selectionStart;
        var before = input.value.slice(0, at == null ? input.value.length : at);
        var after = input.value.slice(at == null ? input.value.length : at);
        var ins = '@' + name + ' ';
        input.value = before + ins + after;
        syncSend();
        input.focus();
      }

      /* ---------- @ 面板（键入 @ 弹出，总纲 14.2）----------
         「全体成员」置顶；列表是群成员账号，不显示本体归属。
         放在输入栏上方当普通块（不做浮层），高度随内容收放，
         也就不用跟自动长高的输入框算重叠。 */
      var mentionPanel = h('div', 'gc-mention-panel');
      body.appendChild(mentionPanel);

      function closeMention() { mentionPanel.classList.remove('is-open'); }

      function insertMentionAtCaret(name) {
        var pos = input.selectionStart == null ? input.value.length : input.selectionStart;
        var before = input.value.slice(0, pos);
        var after = input.value.slice(pos);
        var m = before.match(/(^|\s)@([^\s@]*)$/);
        var atLen = m ? m[2].length + 1 : 0;
        before = m ? before.slice(0, before.length - atLen) : before;
        var next = before + '@' + name + ' ' + after;
        input.value = next;
        var caret = (before + '@' + name + ' ').length;
        try { input.setSelectionRange(caret, caret); } catch (e) { /* 无头桩 */ }
        closeMention();
        syncSend();
        input.focus();
      }

      function paintMention() {
        var pos = input.selectionStart == null ? input.value.length : input.selectionStart;
        var before = input.value.slice(0, pos);
        var m = before.match(/(^|\s)@([^\s@]*)$/);
        if (!m) { closeMention(); return; }
        var q = m[2];
        var members = gs().membersOf(groupId).filter(function (mm) {
          var nm = gs().accountMeta(mm).name;
          return !q || nm.indexOf(q) === 0;
        });
        mentionPanel.innerHTML = '';

        var all = h('button', 'gc-mn-item');
        all.type = 'button';
        all.innerHTML = '<span class="gc-mn-av gc-mn-av-all">全</span>' +
          '<span class="gc-mn-body"><b>全体成员</b>' +
          '<small>高优先级通知，不是强制回答</small></span>';
        all.addEventListener('click', function () { insertMentionAtCaret('全体成员'); });
        mentionPanel.appendChild(all);

        if (members.length) {
          mentionPanel.appendChild(h('p', 'gc-mn-label', '群成员账号'));
          members.forEach(function (mm) {
            var meta = gs().accountMeta(mm);
            var b = h('button', 'gc-mn-item');
            b.type = 'button';
            var av = tileEl(meta, 'sm');
            av.classList.add('gc-mn-av');
            b.appendChild(av);
            var bodyEl = h('span', 'gc-mn-body');
            bodyEl.appendChild(h('b', null, meta.name));
            bodyEl.appendChild(h('small', null,
              mm.kind === 'npc' ? 'NPC 账号' : '群成员账号'));
            b.appendChild(bodyEl);
            b.addEventListener('click', function () { insertMentionAtCaret(meta.name); });
            mentionPanel.appendChild(b);
          });
        }
        mentionPanel.classList.add('is-open');
      }

      /* ---------- 输入区（照私聊：笑脸 · 加号 · 输入框 · 爪印发送） ---------- */
      var dock = h('div', 'gc-dock');

      /* 加号面板：和私聊同一套 .plus-panel 网格，贴在输入栏上方。
         群聊不做日记 / 查岗（用户定的）；切换发言身份收进面板。 */
      var panel = h('div', 'plus-panel');

      var emoBtn = h('button', 'gc-plus gc-emo');
      emoBtn.type = 'button';
      emoBtn.title = '表情包';
      emoBtn.innerHTML = ICON_STICKER;
      emoBtn.addEventListener('click', openStickerPanel);

      var plusBtn = h('button', 'gc-plus');
      plusBtn.type = 'button';
      plusBtn.title = '更多';
      plusBtn.innerHTML = ICON_PLUS;
      plusBtn.addEventListener('click', togglePanel);

      var shell = h('div', 'gc-shell');
      var input = h('textarea', 'gc-input');
      input.rows = 1;
      input.placeholder = '输入消息，键入 @ 提及成员';
      shell.appendChild(input);
      var sendBtn = h('button', 'gc-send gc-send-paw');
      sendBtn.type = 'button';
      sendBtn.disabled = true;
      sendBtn.setAttribute('aria-label', '发送');
      sendBtn.title = '发送';
      sendBtn.innerHTML = ICON_PAW;
      dock.appendChild(emoBtn);
      dock.appendChild(plusBtn);
      dock.appendChild(shell);
      dock.appendChild(sendBtn);
      body.appendChild(panel);
      body.appendChild(dock);

      var GROUP_PLUS_ITEMS = [
        { id: 'photo', svg: ICON_PHOTO, name: '发照片', run: pickPhoto },
        { id: 'switch', svg: ICON_SWITCH, name: '切换身份', run: function () { closePanel(); openPlusSheet(); } },
        { id: 'file', svg: ICON_FILE, name: '发文件' },
        { id: 'transfer', svg: ICON_TRANSFER, name: '转账' },
        { id: 'pat', svg: ICON_PAT, name: '拍一拍' },
        { id: 'genimg', svg: ICON_GENIMG, name: '生图' }
        /* 日记 / 查岗是私聊的东西，群聊不做（用户定的） */
      ];
      function buildPanel() {
        panel.innerHTML = '';
        GROUP_PLUS_ITEMS.forEach(function (it) {
          var b = h('button', 'plus-item' + (it.run ? '' : ' is-soon'));
          b.type = 'button';
          var ic = h('span', 'plus-ic');
          ic.innerHTML = it.svg;
          b.appendChild(ic);
          b.appendChild(h('span', 'plus-name', it.name));
          b.addEventListener('click', function () {
            if (!it.run) {
              ctx.toast(it.name + ' 在群聊里还没上线，先留个座', 'warn');
              return;
            }
            it.run();
          });
          panel.appendChild(b);
        });
      }
      function togglePanel() {
        if (panel.classList.contains('is-open')) closePanel();
        else panel.classList.add('is-open');
      }
      function closePanel() { panel.classList.remove('is-open'); }
      buildPanel();

      /* 发照片：压到 320 存图库 → image 消息（引擎看到「发了一张照片」） */
      function pickPhoto() {
        closePanel();
        var inp = h('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.addEventListener('change', function () {
          var f = inp.files && inp.files[0];
          if (inp.parentNode) inp.parentNode.removeChild(inp);
          if (!f) return;
          if (!Sleepy.media || !Sleepy.media.shrink) {
            ctx.toast('图库没就绪，发不了照片', 'err');
            return;
          }
          ctx.toast('正在处理图片…');
          Sleepy.media.shrink(f, 320).then(function (r) {
            return Sleepy.media.put(r.blob, { name: '群聊照片', kind: 'image', w: r.w, h: r.h });
          }).then(function (mid) {
            gs().addMessage(groupId, {
              senderKind: 'user',
              senderAccountId: currentAccountId(),
              type: 'image',
              content: '发了一张照片',
              mediaId: mid
            });
            renderMessages();
            if (Sleepy.groupAI) Sleepy.groupAI.onUserMessage(groupId);
          }, function () {
            ctx.toast('图片没存上', 'err');
          });
        });
        inp.click();
      }

      /* ---- 表情包（照私聊：按组分的面板，点一张就发） ----
         C2：群聊只放 user 单人贴纸（char 单人/双人不进群，修正施工单 §一）；
         身份命中 = 当前发消息的账号（currentAccountId）在 ownerMaskIds 里。 */
      function stickerPool() {
        if (Sleepy.stickers && Sleepy.stickers.getVisibleStickers) {
          return Sleepy.stickers.getVisibleStickers({
            scope: 'group',
            groupId: groupId,
            maskId: currentAccountId()
          });
        }
        return (Sleepy.stickers && Sleepy.stickers.visible) ? Sleepy.stickers.visible() : [];
      }
      function stickerSrc(s) {
        if (s.mediaId && Sleepy.media) return Sleepy.media.url(s.mediaId);
        return Promise.resolve(s.url || '');
      }
      function sendSticker(s) {
        if (!s) return;
        var msg = {
          senderKind: 'user',
          senderAccountId: currentAccountId(),
          type: 'sticker',
          name: s.name || '表情',
          content: '[表情] ' + (s.name || '')
        };
        if (s.mediaId) msg.mediaId = s.mediaId;
        else msg.url = s.url;
        gs().addMessage(groupId, msg);
        renderMessages();
        if (Sleepy.groupAI) Sleepy.groupAI.onUserMessage(groupId);
      }
      function openStickerPanel() {
        closePanel();
        var pool = stickerPool();
        if (!pool.length) {
          ctx.toast('还没有表情 · 去「我 → 表情包」导入一批', 'warn');
          return;
        }
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'stk-panel-mask');
        var box = h('div', 'stk-panel');
        var tabs = h('div', 'stk-panel-tabs');
        var grid = h('div', 'stk-panel-grid');
        var groups = Sleepy.stickers.groupsOf(pool);
        var cur = groups[0];
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
          pool.filter(function (s) { return Sleepy.stickers.groupOf(s) === cur; })
            .forEach(function (s) {
              var cell = h('button', 'stk-panel-cell');
              cell.type = 'button';
              cell.title = s.name || '表情';
              stickerSrc(s).then(function (u) {
                if (u) cell.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
              });
              cell.addEventListener('click', function () { close(); sendSticker(s); });
              grid.appendChild(cell);
            });
        }
        paint();
        var pfoot = h('div', 'stk-panel-foot');
        var mgr = h('button', 'stk-panel-mgr', '管理表情包 ›');
        mgr.type = 'button';
        mgr.addEventListener('click', function () { close(); ctx.open('stickers'); });
        pfoot.appendChild(mgr);
        box.appendChild(tabs);
        box.appendChild(grid);
        box.appendChild(pfoot);
        mask.appendChild(box);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); }, 20);
        function close() {
          mask.classList.remove('is-open');
          setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
        }
      }

      function syncSend() {
        sendBtn.disabled = !input.value.trim();
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 86) + 'px';
      }
      input.addEventListener('input', function () {
        syncSend();
        paintMention();
      });

      sendBtn.addEventListener('click', function () {
        var text = input.value.trim();
        if (!text) return;
        /* @解析：提到名字的账号 + @全体成员 */
        var names = memberNameMap();
        var mentioned = [];
        var mentionAll = /@全体成员/.test(text);
        Object.keys(names).forEach(function (nm) {
          if (text.indexOf('@' + nm) >= 0) mentioned.push(names[nm]);
        });
        gs().addMessage(groupId, {
          senderKind: 'user',
          senderAccountId: currentAccountId(),
          content: text,
          replyToMessageId: quote ? quote.id : null,
          mentionedAccountIds: mentioned,
          mentionAll: mentionAll
        });
        input.value = '';
        quote = null;
        quoteBar.style.display = 'none';
        closeMention();
        syncSend();
        renderMessages();
        /* 群引擎：user 新消息有抢占权（先作废在途旧波，再开新一轮） */
        if (Sleepy.groupAI) Sleepy.groupAI.onUserMessage(groupId);
      });

      /* ＋面板：切换身份 + 预留位。切换后短暂提示当前账号（总纲 14.1） */
      function openPlusSheet() {
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'gu-sheet-mask');
        var sheet = h('div', 'gu-sheet');
        sheet.appendChild(h('i', 'gu-grab'));
        sheet.appendChild(h('h3', null, '选择发言身份'));

        var users = gs().userAccountsOf(groupId);
        var cur = currentAccountId();
        users.forEach(function (m) {
          var meta = gs().accountMeta(m);
          var b = h('button', 'gu-opt' + (m.accountId === cur ? ' is-on' : ''));
          b.type = 'button';
          b.appendChild(tileEl(meta, 'sm'));
          var t = h('span', 'gu-opt-body');
          t.appendChild(h('b', null, meta.name));
          t.appendChild(h('small', null,
            m.accountId === g.ownerAccountId ? '主账号 · 群主' : '本群的另一个身份'));
          b.appendChild(t);
          b.appendChild(h('span', 'gg-radio'));
          b.addEventListener('click', function () {
            speakingAs[groupId] = m.accountId;
            gs().updateGroup(groupId, { lastUserId: m.accountId });
            close();
            ctx.toast('已切换为「' + meta.name + '」', 'ok');
          });
          sheet.appendChild(b);
        });

        /* 预留位：图片 / 位置 / 互动卡（总纲 14.1 面板可继续扩展） */
        var foot = h('div', 'gu-sheet-foot');
        foot.appendChild(h('span', null, '图片 · 位置 · 互动卡在后面的版本里来'));
        sheet.appendChild(foot);

        mask.appendChild(sheet);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); }, 20);
        function close() {
          mask.classList.remove('is-open');
          setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
        }
      }

      /* ---------- 刷新 ---------- */
      ctx.reload = function () {
        g = gs().findGroup(groupId);
        if (!g) { ctx.back(); return; }
        headName();
        renderMessages();
      };
      renderMessages();
      /* 群聊记忆：进群消息页也是一次整理时机（阈值 + 节流在引擎里） */
      if (Sleepy.groupMemory) Sleepy.groupMemory.check(groupId);

      /* ---------- 群引擎接线：实时刷新 + 输入中指示 ----------
         页面实例缓存，订阅必须先退旧的再挂新的，不然来回进出
         会叠出一排监听器（每个都在重画）。 */
      if (Sleepy.groupAI) {
        if (groupChatUnsub) groupChatUnsub();
        var typingLine = h('div', 'gc-typing');
        typingLine.innerHTML = '<span class="gc-typing-dots"><i></i><i></i><i></i></span>有人正在输入…';
        function showTyping(on) {
          if (on) {
            if (!typingLine.parentNode) list.after(typingLine);
          } else if (typingLine.parentNode) {
            typingLine.remove();
          }
          try { list.scrollTop = list.scrollHeight; } catch (e) { /* 无头桩 */ }
        }
        groupChatUnsub = Sleepy.groupAI.onActivity(function (type, gid) {
          if (gid !== groupId) return;
          if (type === 'message') {
            showTyping(false);
            renderMessages();
          } else if (type === 'busy') {
            showTyping(true);
          }
        });
      }
    },
    onShow: function (ctx) { if (ctx.reload) ctx.reload(); },
    onHide: function () {
      /* 离开页面收掉输入中指示（消息照常落库，回来 reload 会补上） */
      if (groupChatUnsub) { groupChatUnsub(); groupChatUnsub = null; }
    }
  });

  /* ==================== 页面：群聊详情 ==================== */

  Sleepy.register('group-detail', {
    title: '群聊详情',
    render: function (ctx) {
      var groupId = ctx.params.groupId;
      var g = gs().findGroup(groupId);
      if (!g) { ctx.toast('找不到这个群', 'err'); ctx.back(); return; }
      var body = ctx.body;
      body.classList.add('gd-page');

      function toast(t, k) { ctx.toast(t, k || 'warn'); }

      /* ---------- hero ---------- */
      var hero = h('div', 'gd-hero');
      var heroCg = collageEl(groupId, 'xl');
      hero.appendChild(heroCg);
      var heroName = h('h2', null, g.name);
      hero.appendChild(heroName);
      var heroSub = h('p');
      hero.appendChild(heroSub);
      body.appendChild(hero);

      function paintHero() {
        var ms = gs().membersOf(groupId);
        var owner = gs().findMember(groupId, g.ownerAccountId);
        heroName.textContent = g.name;
        heroSub.textContent = ms.length + ' 个账号 · 创建者：' +
          (owner ? gs().accountMeta(owner).name : '?');
        /* 头像也跟着刷（换自定义头像 / 恢复拼图后原地换脸） */
        var fresh = collageEl(groupId, 'xl');
        heroCg.className = fresh.className;
        heroCg.innerHTML = '';
        while (fresh.firstChild) heroCg.appendChild(fresh.firstChild);
      }

      /* ---------- 成员宫格 ---------- */
      var memBlock = h('div', 'set-group');
      memBlock.appendChild(h('p', 'set-group-title', '群成员 · 按公开账号显示'));
      var memCard = h('div', 'set-card gd-memcard');
      memBlock.appendChild(memCard);
      body.appendChild(memBlock);

      function paintMembers() {
        memCard.innerHTML = '';
        gs().membersOf(groupId).forEach(function (m) {
          var meta = gs().accountMeta(m);
          var cell = h('div', 'gd-mem');
          cell.appendChild(tileEl(meta, 'lg'));
          cell.appendChild(h('span', null, meta.name));
          memCard.appendChild(cell);
        });
        /* 邀请格 */
        var add = h('button', 'gd-mem gd-mem-add');
        add.type = 'button';
        add.innerHTML = '<span class="gd-mem-plus">' + ICON_PLUS + '</span><span>邀请</span>';
        add.addEventListener('click', openInvite);
        memCard.appendChild(add);
      }

      /* ---------- 设置卡（复用 set-* 组件，跟全 App 一个语气）---------- */
      var setWrap = h('div', 'set-group');
      setWrap.appendChild(h('p', 'set-group-title', '群聊管理'));
      var card = h('div', 'set-card');
      setWrap.appendChild(card);
      body.appendChild(setWrap);

      var rowName = ui.row({ label: '群聊名称', onClick: renameFlow });
      var rowAvatar = ui.row({
        label: '群头像', hint: '点按更换 · 上传照片或用图片链接',
        onClick: openAvatarFlow
      });
      var rowSearch = ui.row({
        label: '查找聊天记录',
        onClick: function () { toast('聊天记录搜索入口已预留'); }
      });
      var rowMine = ui.row({ label: '我在本群的账号', onClick: openMine });
      var rowSettings = ui.row({ label: '群聊设置', onClick: openSettings });
      /* 整理群记忆（群记忆轮的 runNow 一直没 UI 入口）：
         有失败记录时行注变成重试提示，成功后记录被摘掉、下次进来恢复常态 */
      var gmFail = Sleepy.store.get('sumRawFail:g:' + groupId);
      var rowGm = ui.row({
        label: '整理群记忆',
        hint: gmFail ? '上次没整成 · 点按再试一次' : '把上次整理之后的群聊过一遍总结',
        onClick: function () {
          if (!Sleepy.groupMemory) { toast('群记忆引擎没加载'); return; }
          toast('正在整理…', 'ok');
          Sleepy.groupMemory.runNow(groupId).then(function (r) {
            if (!r.ok) {
              toast(r.error === 'noapi' ? '先去 设置 → 主 API 配一个模型'
                : r.error === 'empty' ? '没有新的群聊可整理'
                : '✗ ' + (r.error || '整理失败'), 'err');
            }
            /* 成功的 toast 由引擎自己发 */
          });
        }
      });
      [rowName, rowAvatar, rowSearch, rowMine, rowSettings, rowGm].forEach(function (r) {
        card.appendChild(r);
      });

      /* 群聊美化（2026-10-05）：多人线下在群聊页顶栏已经有入口
         （ICON_DOOR 那个「多人线下」动作），这张卡不再重复 ——
         用户：「改成美化的，就还是可以自定义美化 css」。
         CSS 存群记录的 beautifyCss（updateGroup 白名单），进群聊页时注入。 */
      var btWrap = h('div', 'set-group');
      var btCard = h('div', 'set-card gd-beautify');
      var btCopy = h('div', 'gd-beautify-copy');
      btCopy.appendChild(h('b', null, '群聊美化'));
      btCopy.appendChild(h('small', null, '写一段自定义 CSS，只作用于这个群的聊天页。'));
      var btBtn = ui.button('打开 CSS 编辑', 'primary', function () {
        ctx.open('group-beautify', { groupId: groupId });
      });
      btCard.appendChild(btCopy);
      btCard.appendChild(btBtn);
      btWrap.appendChild(btCard);
      body.appendChild(btWrap);

      /* 退群 */
      var exitWrap = h('div', 'set-group');
      var exitCard = h('div', 'set-card');
      var meAccounts = gs().userAccountsOf(groupId);
      var exitLabel = meAccounts.length > 1
        ? '退出群聊（当前账号）'
        : '退出群聊';
      exitCard.appendChild(ui.row({
        label: exitLabel,
        hint: '只让这个 user 账号退出，不影响其他身份',
        onClick: exitFlow
      }));
      exitWrap.appendChild(exitCard);
      body.appendChild(exitWrap);

      /* ---------- 动作 ---------- */
      function syncRows() {
        ui.setRowValue(rowName, g.name);
        ui.setRowValue(rowAvatar, hasCustomAvatar(g) ? '自定义头像' : '成员拼图');
        var mine = gs().userAccountsOf(groupId);
        ui.setRowValue(rowMine, mine.length ? mine.map(function (m) {
          return gs().accountMeta(m).name;
        }).join('、') : '（不在群里）');
        var s = g.settings || gs().DEFAULT_SETTINGS;
        var labels = { off: '关闭续聊', light: '轻量续聊', active: '活跃续聊' };
        ui.setRowValue(rowSettings,
          labels[s.rhythm] + ' · ' + (s.crossChannel ? '允许' : '关闭') + '跨频道余波');
        paintHero();
      }

      async function renameFlow() {
        var name = await ui.prompt({
          title: '修改群聊名称',
          value: g.name,
          note: '修改会作为一条群系统事件，对所有成员可见。'
        });
        if (name === null) return;
        name = String(name).trim();
        if (!name) { toast('群聊名称不能为空'); return; }
        if (name === g.name) return;
        var old = g.name;
        gs().updateGroup(groupId, { name: name });
        gs().systemMessage(groupId, '群聊名称已由「' + old + '」改为「' + name + '」');
        g = gs().findGroup(groupId);
        syncRows();
        toast('群聊名称已更新', 'ok');
      }

      /* 群头像：页面正中的两选弹窗（用户定的交互）——
         传照片（压到 240px 存进图库 IndexedDB，群记录里只留 mediaId，
         localStorage 里塞 base64 会把整个存档撑爆）或贴图片链接；
         用腻了可恢复成员拼图。 */
      function openAvatarFlow() {
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'dl-mask');
        var cardEl = h('div', 'dl-card');
        cardEl.appendChild(h('p', 'dl-title', '群头像'));
        cardEl.appendChild(h('p', 'dl-note',
          hasCustomAvatar(g) ? '当前使用自定义头像。' : '当前使用成员头像拼图。'));

        var fileIn = h('input');
        fileIn.type = 'file';
        fileIn.accept = 'image/*';
        fileIn.style.display = 'none';

        function close() {
          mask.classList.remove('is-open');
          cardEl.classList.remove('is-open');
          setTimeout(function () {
            if (mask.parentNode) mask.parentNode.removeChild(mask);
            if (cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
          }, 200);
        }

        function applyAvatar(opts) {
          opts = opts || {};
          var r = gs().updateGroup(groupId, {
            avatar: opts.url || '',
            avatarMedia: opts.mediaId || '',
            avatarMode: (opts.url || opts.mediaId) ? 'custom' : 'collage'
          });
          if (!r.ok) { toast(r.message); return; }
          g = gs().findGroup(groupId);
          close();
          syncRows();
          toast(opts.url || opts.mediaId ? '群头像已更新' : '已恢复成员拼图头像', 'ok');
        }

        fileIn.addEventListener('change', function () {
          var file = fileIn.files && fileIn.files[0];
          if (!file) return;
          if (!Sleepy.media || !Sleepy.media.shrink || !Sleepy.media.put) {
            toast('图库没就绪，传不了照片', 'err');
            return;
          }
          toast('正在处理图片…');
          Sleepy.media.shrink(file, 240).then(function (r) {
            return Sleepy.media.put(r.blob, { name: '群头像', kind: 'avatar', w: r.w, h: r.h });
          }).then(function (mid) {
            applyAvatar({ mediaId: mid });
          }, function () { toast('这张图读不出来', 'err'); });
        });

        var upBtn = h('button', 'gd-av-opt', '上传照片');
        upBtn.type = 'button';
        upBtn.appendChild(h('small', null, '从手机相册选一张，自动压到 240px'));
        upBtn.addEventListener('click', function () { fileIn.click(); });

        var urlBtn = h('button', 'gd-av-opt', '使用图片链接');
        urlBtn.type = 'button';
        urlBtn.appendChild(h('small', null, '贴一张网上图片的 URL'));
        urlBtn.addEventListener('click', async function () {
          var u = await ui.prompt({
            title: '图片链接',
            placeholder: 'https://…',
            value: /^https?:/.test(g.avatar || '') ? g.avatar : '',
            note: '链接失效的话头像就会显示不出来。想稳一点就用上面那个「上传照片」。'
          });
          if (u === null) return;
          u = String(u).trim();
          if (!u) { toast('没有填链接'); return; }
          applyAvatar({ url: u });
        });

        cardEl.appendChild(upBtn);
        cardEl.appendChild(urlBtn);
        cardEl.appendChild(fileIn);

        if (hasCustomAvatar(g)) {
          var resetBtn = h('button', 'gd-av-opt is-dim', '恢复成员拼图头像');
          resetBtn.type = 'button';
          resetBtn.addEventListener('click', function () { applyAvatar(''); });
          cardEl.appendChild(resetBtn);
        }

        var cancelBtn = h('button', 'dl-btn', '取消');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', close);
        cardEl.appendChild(cancelBtn);

        mask.appendChild(cardEl);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); cardEl.classList.add('is-open'); }, 20);
      }

      function openInvite() {
        var cand = collectCandidates();
        if (!cand.ok) { toast(cand.message); return; }
        var inGroup = {};
        gs().membersOf(groupId, true).forEach(function (m) { inGroup[m.accountId] = true; });

        var pool = [];
        cand.masks.forEach(function (m) {
          if (m.id !== g.ownerAccountId && !inGroup[m.id]) {
            pool.push({ kind: 'user', ownerId: 'user', accountId: m.id,
              name: m.name, avatar: m.avatar, sub: '我的马甲' });
          }
        });
        cand.entities.forEach(function (en) {
          [en.main].concat(en.subs).forEach(function (c) {
            if (!inGroup[c.id]) {
              pool.push({ kind: 'char', ownerId: en.main.id, accountId: c.id,
                name: c.name, avatar: c.avatar, sub: '角色账号' });
            }
          });
        });
        cand.npcs.forEach(function (n) {
          if (!inGroup[n.id]) {
            pool.push({ kind: 'npc', ownerId: n.id, accountId: n.id,
              name: n.name, avatar: n.avatar, sub: 'NPC 账号' });
          }
        });

        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'gu-sheet-mask');
        var sheet = h('div', 'gu-sheet');
        sheet.appendChild(h('i', 'gu-grab'));
        sheet.appendChild(h('h3', null, '邀请账号'));
        if (!pool.length) {
          sheet.appendChild(h('p', 'gu-sheet-foot',
            '这间房里的人都在群里了。想加新人先去浮岛的配置台。'));
        }
        pool.forEach(function (p) {
          var b = h('button', 'gu-opt');
          b.type = 'button';
          b.appendChild(tileEl({
            name: p.name, avatar: p.avatar, initial: core.initialOf(p.name)
          }, 'sm'));
          var t = h('span', 'gu-opt-body');
          t.appendChild(h('b', null, p.name));
          t.appendChild(h('small', null, p.sub));
          b.appendChild(t);
          var btn = h('span', 'gu-invite-btn', '邀请');
          b.appendChild(btn);
          b.addEventListener('click', function () {
            gs().addMembers(groupId, [p]);
            gs().systemMessage(groupId, p.name + ' 加入了群聊');
            g = gs().findGroup(groupId);
            btn.textContent = '已邀请';
            btn.classList.add('is-done');
            paintMembers();
            syncRows();
          });
          sheet.appendChild(b);
        });

        mask.appendChild(sheet);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); }, 20);
        function close() {
          mask.classList.remove('is-open');
          setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
        }
      }

      /* 我在本群的账号：列出 + 非群主可退出 */
      function openMine() {
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'gu-sheet-mask');
        var sheet = h('div', 'gu-sheet');
        sheet.appendChild(h('i', 'gu-grab'));
        sheet.appendChild(h('h3', null, '我在本群的账号'));
        sheet.appendChild(h('p', 'gu-sheet-foot',
          '这里只管理 user 自己的公开身份。日常发言时仍从加号面板切换。'));

        gs().userAccountsOf(groupId).forEach(function (m) {
          var meta = gs().accountMeta(m);
          var b = h('div', 'gu-opt');
          b.appendChild(tileEl(meta, 'sm'));
          var t = h('span', 'gu-opt-body');
          t.appendChild(h('b', null, meta.name));
          t.appendChild(h('small', null,
            m.accountId === g.ownerAccountId ? '创建者 · 默认发言身份' : '本群的另一个身份'));
          b.appendChild(t);
          if (m.accountId === g.ownerAccountId) {
            b.appendChild(h('span', 'gu-badge', '群主'));
          } else {
            var leave = h('button', 'gu-danger-btn', '退出本群');
            leave.type = 'button';
            leave.addEventListener('click', async function () {
              var yes = await ui.confirm({
                title: '让「' + meta.name + '」退出本群？',
                note: '群聊里会留下一条退群系统消息。',
                ok: '退出',
                danger: true
              });
              if (!yes) return;
              gs().setMemberStatus(groupId, m.accountId, 'left');
              gs().systemMessage(groupId, meta.name + ' 退出了群聊');
              close();
              paintMembers();
              syncRows();
              toast('已退出', 'ok');
            });
            b.appendChild(leave);
          }
          sheet.appendChild(b);
        });

        mask.appendChild(sheet);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); }, 20);
        function close() {
          mask.classList.remove('is-open');
          setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
        }
      }

      /* 群聊设置：续聊三档 + 三个开关（数据就位，引擎后面几轮接） */
      function openSettings() {
        var host = document.getElementById('phone') || document.body;
        var mask = h('div', 'gu-sheet-mask');
        var sheet = h('div', 'gu-sheet');
        sheet.appendChild(h('i', 'gu-grab'));
        sheet.appendChild(h('h3', null, '群聊设置'));
        sheet.appendChild(h('p', 'gu-sheet-foot',
          '这些设置控制群聊节奏，不会把成员关系改成统一友好或统一敌对。'));

        function applyPatch(patch) {
          gs().updateGroup(groupId, { settings: patch });
          g = gs().findGroup(groupId);
          syncRows();
        }

        /* 续聊三档 */
        var segs = h('div', 'gu-segs');
        var s = g.settings || gs().DEFAULT_SETTINGS;
        [['off', '关闭'], ['light', '轻量'], ['active', '活跃']].forEach(function (o) {
          var b = h('button', 'gu-seg' + (s.rhythm === o[0] ? ' is-on' : ''), o[1]);
          b.type = 'button';
          b.addEventListener('click', function () {
            applyPatch({ rhythm: o[0] });
            Array.prototype.forEach.call(segs.children, function (x) {
              x.classList.remove('is-on');
            });
            b.classList.add('is-on');
          });
          segs.appendChild(b);
        });
        var segBlock = h('div', 'gu-setblock');
        segBlock.appendChild(h('b', null, '自动续聊'));
        segBlock.appendChild(h('p', null,
          'user 停止发言后，角色之间可以有限接话；达到上限或没有新信息时停止。'));
        segBlock.appendChild(segs);
        sheet.appendChild(segBlock);

        /* 三个开关 */
        [
          ['privateFollow', '允许群聊触发私聊',
            '角色可以把不适合公开的话留到私聊，但不会自动搬运整段群聊。'],
          ['naturalTopic', '允许成员自然发起话题',
            '角色有足够动机时可以主动开口，仍受忙碌状态与关系影响。'],
          ['crossChannel', '跨频道状态余波',
            '群内争执、合作和情绪会影响之后的私聊；私聊也会反向影响群聊。']
        ].forEach(function (o) {
          var blk = h('div', 'gu-setblock gu-setblock-row');
          var copy = h('div');
          copy.appendChild(h('b', null, o[1]));
          copy.appendChild(h('p', null, o[2]));
          blk.appendChild(copy);
          var lab = h('label', 'set-switch');
          var cb = h('input');
          cb.type = 'checkbox';
          cb.checked = !!s[o[0]];
          lab.appendChild(cb);
          lab.appendChild(h('span', 'set-switch-track'));
          cb.addEventListener('change', function () {
            var patch = {};
            patch[o[0]] = cb.checked;
            applyPatch(patch);
          });
          blk.appendChild(lab);
          sheet.appendChild(blk);
        });

        mask.appendChild(sheet);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
        host.appendChild(mask);
        setTimeout(function () { mask.classList.add('is-open'); }, 20);
        function close() {
          mask.classList.remove('is-open');
          setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
        }
      }

      /* 解散群（从聊天列表的「删」也能到，这里是正门） */
      async function exitFlow() {
        var cur = currentAccountIdOf(groupId, g);
        var meta = cur ? gs().accountMeta(cur) : null;
        var yes = await ui.confirm({
          title: meta ? '让「' + meta.name + '」退出本群？' : '退出本群？',
          note: '只让这个 user 账号退出；群和其他成员不受影响。想连群一起删，去聊天列表长按删除。',
          ok: '退出',
          danger: true
        });
        if (!yes) return;
        if (cur) {
          gs().setMemberStatus(groupId, cur.accountId, 'left');
          gs().systemMessage(groupId, meta.name + ' 退出了群聊');
        }
        ctx.back();
        toast('已退出', 'ok');
      }

      paintMembers();
      syncRows();
      /* 群聊记忆：进群消息页也是一次整理时机（阈值 + 节流在引擎里） */
      if (Sleepy.groupMemory) Sleepy.groupMemory.check(groupId);
      /* 从线下三步 / 邀请 / 设置回来时原地刷成员与行值
         （页面实例缓存，render 只跑一次；之前这个钩子没人赋值，是死代码） */
      ctx.__gdRefresh = function () {
        g = gs().findGroup(groupId);
        if (!g) return;
        paintMembers();
        syncRows();
      };
    },
    onShow: function (ctx) {
      /* 从邀请/设置回来时整页重画（页面实例缓存，render 只跑一次） */
      if (ctx.__gdRefresh) ctx.__gdRefresh();
    }
  });

  /* 某个群「我此刻默认的发言账号」—— 退群确认弹窗用。
     独立成函数是因为 group-detail 里拿不到 group-chat 的模块状态。 */
  function currentAccountIdOf(groupId, g) {
    var users = gs().userAccountsOf(groupId);
    var last = g.lastUserId;
    for (var i = 0; i < users.length; i++) {
      if (users[i].accountId === last) return users[i];
    }
    var owner = gs().findMember(groupId, g.ownerAccountId);
    if (owner && (owner.status || 'active') === 'active') return owner;
    return users[0] || null;
  }

  /* ---- 复制 CSS 变量（群聊美化编辑页用，2026-10-06）----
     从样式表里 :root / #phone / [data-theme…] 规则收集自定义属性名，
     再读文档上的计算值 —— 用户写覆盖样式要引用 --g-* 变量，
     手抄名字太苦，一键给一份「--名: 值;」清单。
     只挑主题相关的那几个选择器，别把组件私有变量也倒进去。 */
  function collectCssVars() {
    if (typeof document === 'undefined') return '';
    var names = {};
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      var rules;
      try { rules = sheet.cssRules; } catch (e) { return; }  /* 跨域样式表读不了，跳过 */
      Array.prototype.forEach.call(rules || [], function (r) {
        if (!r || !r.selectorText || !r.style) return;
        var sel = r.selectorText;
        if (sel.indexOf(':root') < 0 && sel.indexOf('#phone') < 0 &&
            sel.indexOf('[data-theme') < 0 && sel.indexOf('[data-icstyle') < 0) return;
        var m = (r.style.cssText || '').match(/--[\w-]+/g) || [];
        m.forEach(function (n) { names[n] = true; });
      });
    });
    var host = document.getElementById('phone') || document.documentElement;
    var cs = global.getComputedStyle ? global.getComputedStyle(host) : null;
    if (!cs) return '';
    return Object.keys(names).sort().map(function (n) {
      var v = String(cs.getPropertyValue(n) || '').trim();
      return v ? (n + ': ' + v + ';') : '';
    }).filter(function (line) { return !!line; }).join('\n');
  }

  /* 剪贴板写入：clipboard API 只在安全上下文可用 ——
     手机走局域网 http（192.168.x / 172.x）访问开发服务器时没有它，
     必须留 execCommand 兜底，不然「复制」在真机上永远失败。 */
  function copyText(text) {
    return new Promise(function (resolve) {
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        } catch (e) { return false; }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); },
          function () { resolve(fallback()); });
        return;
      }
      resolve(fallback());
    });
  }

  /* ==================== 页面：群聊美化（自定义 CSS，2026-10-05） ====================

     群详情页「群聊美化」卡的编辑页。textarea 改的就是群记录的
     beautifyCss（updateGroup 白名单字段，见 core-group.js），即时落库；
     注入发生在 group-chat 的 render 里（复用 apCustomStyle 槽位，
     和角色外观的私聊 CSS 互斥，不叠加）。 */

  Sleepy.register('group-beautify', {
    title: '群聊美化',
    render: function (ctx) {
      var groupId = ctx.params.groupId;
      var g = gs().findGroup(groupId);
      if (!g) { ctx.toast('找不到这个群', 'err'); ctx.back(); return; }
      var body = ctx.body;

      var wrap = h('div', 'set-group');
      wrap.appendChild(h('p', 'set-group-title', 'CSS 自定义'));
      var card = h('div', 'set-card gd-beautify');
      var area = h('textarea', 'cap-css-area');
      area.placeholder = '/* 在这里写覆盖样式，作用域为这个群的聊天页 */\n.gc-list { padding-bottom: 30px; }';
      area.value = g.beautifyCss || '';
      /* input 即落库：和角色外观的 CSS 编辑同一手感，不另设保存键 */
      area.addEventListener('input', function () {
        gs().updateGroup(groupId, { beautifyCss: area.value });
      });
      card.appendChild(area);
      /* 复制变量（2026-10-06 用户）：写覆盖样式要引用 --g-* 那批变量，
         名字手抄太苦 —— 一键把「--名: 值;」清单复制走，粘到编辑框里挑着用。 */
      var varBtn = ui.button('复制 CSS 变量', 'ghost', function () {
        var text = collectCssVars();
        if (!text) { ctx.toast('没读到变量（样式表还没就绪？）', 'warn'); return; }
        copyText(text).then(function (ok) {
          ctx.toast(ok ? '已复制 · 粘到上面就能挑着用' : '浏览器没给剪贴板权限', ok ? 'ok' : 'err');
        });
      });
      varBtn.type = 'button';
      card.appendChild(varBtn);
      card.appendChild(h('p', 'cap-hint', '即时保存 · 回到群聊页生效'));
      wrap.appendChild(card);
      body.appendChild(wrap);
    }
  });

  /* ==================== 页面：发起多人线下（三步，Demo 4） ====================

     线上按账号、线下按本体（总纲 13.1）：这一页只做「交接单」——
     按本体合并群内账号、选真实到场者、排到场时序、定前情继承范围。
     交接单落 store（offlineHandoffs），多人线下场景页等新的交互 demo 来接。 */

  Sleepy.register('group-offline', {
    title: '发起多人线下',
    render: function (ctx) {
      var groupId = ctx.params.groupId;
      var g = gs().findGroup(groupId);
      if (!g) { ctx.toast('找不到这个群', 'err'); ctx.back(); return; }
      var body = ctx.body;
      body.classList.add('gol-page');

      /* ---- 候选：user 账号 / 按本体合并的持久角色 / NPC ---- */
      var users = gs().userAccountsOf(groupId);
      var entities = Sleepy.groupAI ? Sleepy.groupAI.entitiesOf(groupId) : [];
      var npcs = entities.filter(function (e) { return e.kind === 'npc'; });
      var chars = entities.filter(function (e) { return e.kind === 'char'; });

      var state = {
        step: 0,
        identity: g.lastUserId ||
          (g.ownerAccountId) ||
          (users[0] && users[0].accountId) || null,
        picked: chars.map(function (e) { return e.ownerId; }),   /* 默认全选持久角色 */
        arrival: {},        /* ownerId -> 'opening' | 'late'，默认 opening */
        manual: true,
        inherit: true,
        location: '',
        purpose: ''
      };

      /* 步骤条 */
      var stepsBar = h('div', 'gg-steps');
      ['参与者', '到场安排', '确认场景'].forEach(function (t, i) {
        var s = h('div', 'gg-step');
        s.appendChild(h('i', null, String(i + 1)));
        s.appendChild(h('span', null, t));
        stepsBar.appendChild(s);
      });
      body.appendChild(stepsBar);

      var viewport = h('div', 'gg-viewport');
      body.appendChild(viewport);

      var bottom = h('div', 'gg-bottom');
      var backBtn = h('button', 'gg-btn gg-btn-back', '取消');
      backBtn.type = 'button';
      var nextBtn = h('button', 'gg-btn gg-btn-next', '下一步');
      nextBtn.type = 'button';
      bottom.appendChild(backBtn);
      bottom.appendChild(nextBtn);
      body.appendChild(bottom);

      function toast(t) { ctx.toast(t, 'warn'); }

      function contextBanner() {
        var b = h('div', 'gol-context');
        b.appendChild(h('b', null, '来自「' + g.name + '」'));
        b.appendChild(h('small', null,
          '可以继承群里刚刚公开发生的事情，不会带入任何未公开私聊。'));
        return b;
      }

      function personRow(o) {
        var row = h('button', 'gg-choice' + (o.selected ? ' is-on' : ''));
        row.type = 'button';
        row.appendChild(tileEl(o.meta, 'md'));
        var bodyEl = h('span', 'gg-choice-body');
        bodyEl.appendChild(h('b', null, o.title));
        bodyEl.appendChild(h('small', null, o.sub || ''));
        row.appendChild(bodyEl);
        row.appendChild(h('span', o.radio ? 'gg-radio' : 'gg-check'));
        if (o.onClick) row.addEventListener('click', o.onClick);
        return row;
      }

      /* ---- 第 1 步：参与者 ---- */
      function pagePeople() {
        var wrap = h('div', 'gg-pagepane');
        wrap.appendChild(h('h2', 'gg-intro-title', '这次谁会到场？'));
        wrap.appendChild(h('p', 'gg-intro-sub',
          '线上群成员按账号出现；进入线下时，同一角色的多个账号会合并为一个真实参与者。'));
        wrap.appendChild(contextBanner());

        wrap.appendChild(h('p', 'gg-sect', 'user 的出场身份'));
        var uc = h('div', 'gg-card');
        users.forEach(function (m) {
          var meta = gs().accountMeta(m);
          uc.appendChild(personRow({
            meta: meta,
            title: meta.name,
            sub: m.accountId === g.ownerAccountId ? '主账号' : '另一个群内身份',
            radio: true,
            selected: state.identity === m.accountId,
            onClick: function () { state.identity = m.accountId; paint(); }
          }));
        });
        wrap.appendChild(uc);

        wrap.appendChild(h('p', 'gg-sect', '持久角色'));
        var cc = h('div', 'gg-card');
        chars.forEach(function (e) {
          var rec = core.findChar(e.ownerId);
          var accNames = e.accounts.map(function (m) {
            return gs().accountMeta(m).name;
          });
          cc.appendChild(personRow({
            meta: {
              name: rec ? rec.name : '?',
              avatar: rec ? (rec.avatar || '') : '',
              initial: core.initialOf(rec ? rec.name : '?')
            },
            title: rec ? rec.name : '?',
            sub: '群内账号：' + accNames.join('、') +
              (accNames.length > 1 ? ' · 线下合并为一人' : ''),
            selected: state.picked.indexOf(e.ownerId) >= 0,
            onClick: function () {
              var i = state.picked.indexOf(e.ownerId);
              if (i >= 0) state.picked.splice(i, 1);
              else state.picked.push(e.ownerId);
              paint();
            }
          }));
        });
        wrap.appendChild(cc);
        wrap.appendChild(h('p', 'gol-note',
          '账号合并说明：同一角色的多个账号在线上仍是两个公开身份；这里只因为' +
          '线下到场的是同一个人而合并，不会向其他角色公开账号归属。'));

        if (npcs.length) {
          wrap.appendChild(h('p', 'gg-sect', 'NPC'));
          var nc = h('div', 'gg-card');
          npcs.forEach(function (e) {
            var rec = core.findChar(e.ownerId);
            nc.appendChild(personRow({
              meta: {
                name: rec ? rec.name : '?',
                avatar: rec ? (rec.avatar || '') : '',
                initial: core.initialOf(rec ? rec.name : '?')
              },
              title: rec ? rec.name : '?',
              sub: '已有 NPC · 拥有群聊账号',
              selected: state.picked.indexOf(e.ownerId) >= 0,
              onClick: function () {
                var i = state.picked.indexOf(e.ownerId);
                if (i >= 0) state.picked.splice(i, 1);
                else state.picked.push(e.ownerId);
                paint();
              }
            }));
          });
          wrap.appendChild(nc);
        }
        return wrap;
      }

      /* ---- 第 2 步：到场安排 ---- */
      function pageArrival() {
        var wrap = h('div', 'gg-pagepane');
        wrap.appendChild(h('h2', 'gg-intro-title', '谁先到，谁晚点来？'));
        wrap.appendChild(h('p', 'gg-intro-sub',
          '稍后到场者知道邀约信息，但不会自动获得抵达前的现场对话。'));

        state.picked.forEach(function (oid) {
          var rec = core.findChar(oid);
          var late = state.arrival[oid] === 'late';
          var card = h('div', 'gg-card gol-arrival' + (late ? ' is-late' : ''));
          var head = h('div', 'gol-arrival-head');
          head.appendChild(tileEl({
            name: rec ? rec.name : '?',
            avatar: rec ? (rec.avatar || '') : '',
            initial: core.initialOf(rec ? rec.name : '?')
          }, 'md'));
          var copy = h('span', 'gg-choice-body');
          copy.appendChild(h('b', null, rec ? rec.name : '?'));
          copy.appendChild(h('small', null,
            (rec && rec.kind === 'npc') ? 'NPC' : '持久角色'));
          head.appendChild(copy);
          card.appendChild(head);

          var segs = h('div', 'gu-segs');
          [['opening', '开场就在'], ['late', '稍后到场']].forEach(function (o) {
            var b = h('button', 'gu-seg' +
              ((state.arrival[oid] || 'opening') === o[0] ? ' is-on' : ''), o[1]);
            b.type = 'button';
            b.addEventListener('click', function () {
              state.arrival[oid] = o[0];
              paint();
            });
            segs.appendChild(b);
          });
          card.appendChild(segs);

          if (late) {
            card.appendChild(h('p', 'gol-late-note',
              '已受邀并知道地点与见面目的；抵达前的现场内容保持不可知。'));
          }
          wrap.appendChild(card);
        });

        /* user 也在到场名单里（默认开场就在；user 的时机由自己掌握） */
        var manualCard = h('div', 'gg-card gol-toggle');
        var mc = h('span', 'gg-choice-body');
        mc.appendChild(h('b', null, '由 user 决定晚到时机'));
        mc.appendChild(h('small', null,
          '稍后到场的角色会保持「在路上」，直到你在场景中让其进入。'));
        manualCard.appendChild(mc);
        var lab = h('label', 'set-switch');
        var cb = h('input');
        cb.type = 'checkbox';
        cb.checked = state.manual;
        lab.appendChild(cb);
        lab.appendChild(h('span', 'set-switch-track'));
        cb.addEventListener('change', function () { state.manual = cb.checked; });
        manualCard.appendChild(lab);
        wrap.appendChild(manualCard);
        return wrap;
      }

      /* ---- 第 3 步：确认场景 ---- */
      function pageConfirm() {
        var wrap = h('div', 'gg-pagepane');
        wrap.appendChild(h('h2', 'gg-intro-title', '确认这次见面'));
        wrap.appendChild(h('p', 'gg-intro-sub',
          '创建后仍可中途邀请其他角色，也可以让在场成员先行离开。'));

        var loc = h('div', 'gg-field');
        loc.appendChild(h('label', null, '地点'));
        var locIn = h('input');
        locIn.type = 'text';
        locIn.value = state.location;
        locIn.placeholder = '在哪里见面';
        locIn.addEventListener('input', function () { state.location = locIn.value; paintSummary(); });
        loc.appendChild(locIn);
        wrap.appendChild(loc);

        var pur = h('div', 'gg-field');
        pur.appendChild(h('label', null, '场景开端'));
        var purIn = h('input');
        purIn.type = 'text';
        purIn.value = state.purpose;
        purIn.placeholder = '见面要做什么（可留空自由开始）';
        purIn.addEventListener('input', function () { state.purpose = purIn.value; paintSummary(); });
        pur.appendChild(purIn);
        wrap.appendChild(pur);

        var inh = h('div', 'gg-card gol-toggle');
        var ic = h('span', 'gg-choice-body');
        ic.appendChild(h('b', null, '继承群聊公开前情'));
        ic.appendChild(h('small', null, '只带入在场角色有权知道的群事件与各自主观状态。'));
        inh.appendChild(ic);
        var lab2 = h('label', 'set-switch');
        var cb2 = h('input');
        cb2.type = 'checkbox';
        cb2.checked = state.inherit;
        lab2.appendChild(cb2);
        lab2.appendChild(h('span', 'set-switch-track'));
        cb2.addEventListener('change', function () { state.inherit = cb2.checked; });
        inh.appendChild(lab2);
        wrap.appendChild(inh);

        var summary = h('p', 'gg-summary');
        wrap.appendChild(summary);
        var timeline = h('div', 'gg-card gol-timeline');
        wrap.appendChild(timeline);

        function paintSummary() {
          var opening = [], late = [];
          state.picked.forEach(function (oid) {
            var rec = core.findChar(oid);
            var nm = rec ? rec.name : '?';
            (state.arrival[oid] === 'late' ? late : opening).push(nm);
          });
          var ident = core.findUser(state.identity);
          summary.innerHTML = '<strong>' + esc(state.location || '未填写地点') + '</strong>' +
            'user 身份：' + esc(ident ? ident.name : '我') +
            '<br>场景开端：' + esc(state.purpose || '自由开始') +
            '<br>开场在场：' + esc(opening.length ? opening.join('、') : '暂无') +
            '<br>稍后到场：' + esc(late.length ? late.join('、') : '暂无') +
            '<br>群聊前情：' + (state.inherit ? '按每个人的知情范围继承' : '不带入本场');
          timeline.innerHTML =
            '<div class="gol-tl-row"><b>场景开始</b><span>' +
            (opening.length ? esc(opening.join('、')) + '已经在场' : 'user 暂时独自在场') +
            '</span></div>' +
            late.map(function (n) {
              return '<div class="gol-tl-row"><b>等待到场</b><span>' + esc(n) +
                '不会读取此前现场；由你在合适时机让其进入。</span></div>';
            }).join('');
        }
        paintSummary();
        return wrap;
      }

      var pages = [pagePeople, pageArrival, pageConfirm];
      function paint() {
        var kids = stepsBar.children;
        for (var i = 0; i < kids.length; i++) {
          kids[i].classList.toggle('is-active', i === state.step);
          kids[i].classList.toggle('is-done', i < state.step);
        }
        backBtn.textContent = state.step === 0 ? '取消' : '上一步';
        nextBtn.textContent = state.step === 2 ? '进入线下' : '下一步';
        viewport.innerHTML = '';
        viewport.appendChild(pages[state.step]());
        viewport.scrollTop = 0;
      }

      backBtn.addEventListener('click', function () {
        if (state.step > 0) { state.step--; paint(); }
        else ctx.back();
      });
      nextBtn.addEventListener('click', function () {
        if (state.step === 0 && !state.picked.length) { toast('至少选择一位参与者'); return; }
        if (state.step < 2) { state.step++; paint(); return; }
        if (!state.location.trim()) { toast('请先填写地点'); return; }

        /* 交接单落库（总纲 13.2 的 GroupToOfflineHandoff，字段做了归一）。
           场景页还没来 —— 交接单先存着，等新 demo 接上时直接消费。 */
        var rec = {
          id: core.newId('ho'),
          groupId: groupId,
          groupName: g.name,
          userIdentityAccountId: state.identity,
          participants: state.picked.map(function (oid) {
            return {
              ownerId: oid,
              kind: (core.findChar(oid) || {}).kind === 'npc' ? 'npc' : 'char',
              arrival: state.arrival[oid] || 'opening'
            };
          }),
          manualArrival: state.manual,
          location: state.location.trim(),
          purpose: state.purpose.trim(),
          inheritPublicContext: state.inherit,
          status: 'pending',
          createdAt: Date.now()
        };
        core.tagScope(rec);
        var list = Sleepy.store.get('offlineHandoffs');
        if (!Array.isArray(list)) list = [];
        list.unshift(rec);
        Sleepy.store.set('offlineHandoffs', list);

        /* 交接单落地 → 建场景会话 → 秒弹「谁先开场」（照私聊线下的门）。
           用 replace 换页：三步页从栈里退掉，返回键直接回群聊。 */
        if (Sleepy.groupOfflineStore && Sleepy.groupOfflineUI) {
          var session = Sleepy.groupOfflineStore.createFromHandoff(rec);
          var shim = Object.create(ctx);
          shim.open = function (pid, params) { Sleepy.nav.replace(pid, params); };
          Sleepy.groupOfflineUI.chooseOpening(shim, ctx.el, session);
        } else {
          ctx.toast('多人线下模块没加载出来', 'err');
          ctx.back();
        }
      });

      paint();
    }
  });

  /* ==================== 对外 ==================== */

  /* page-chat 的消息 tab 要在列表里插群入口，借这里的拼图头像 */
  Sleepy.groupUI = {
    collageEl: collageEl,
    tileEl: tileEl
  };

})(window);
