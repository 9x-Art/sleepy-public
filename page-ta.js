/* ============================================================
   page-ta.js — ta 首页（只读生活窗口 v1 + 结构化表接线 v2）

   产品定位（docs/勘察-ta首页-2026-10-02.md + 两批施工单）：
   ta 是当前角色的**生活窗口**，让玩家看懂：
     这个角色现在处在什么状态、最近在做什么、一直留意什么、身边有谁。
   它不在 ta 内切换岛屿（对齐 We 的「不自猜岛」）——当前身份一律走
   core 的指针卫兵：
     core.activeSandbox() / core.scopeId()
     core.activeCharOnIsland() / core.activeUserOnIsland()
     core.rootOf()            （charState / openLoops / attentionInbox 键归 root）
     core.charsOfSandbox() / core.npcsOfRoom() / core.findLink()

   ─── 数据源与优先级（v2 起：结构化表优先，现成来源兜底）────────
   01 此刻 / 最近状态（不变，仍只读）：
     ① charState:<rootId> 的 feelings / readings / unspoken（带 updatedAt）；
     ② 兜底 lifeFeed.recent 最新一条；③ 都没有 → 空态，不编生活。
     ⚠️ 不接 char.mood 六词循环（桌面组件的假数据兜底）。
   02 最近在做：
     ① **taItems（ta-life.js 三张表之一）**：非「已完成」的事项，
        状态只认五态闭集；② 空了兜底 openLoops:<rootId>；
     ③ 再兜底 lifeFeed.recent（窗口摘要，不写成事项实体）。
   03 一直留意：
     ① **taFollows**；② 空了兜底 attentionInbox:<rootId>。
     关注过期、提醒处理掉 ≠ 事项完成或承诺解除 —— 只陈列，不下结论。
   04 身边的人（v1 起改口径）：**人物节点集合唯一出处 = ta-network.js 的
     selector**（`Sleepy.taNetwork.build`），本页不再自己拼 charsOfSandbox +
     npcsOfRoom + findLink。标签含义随之变化：节点标签是「与中心角色」的关系
     （charRel 三态 / link.relation），「我 × 对方」那条作为 relationWithUser
     放在 meta 里如实说明。原因：两处各拼一套，NPC knownBy 权限过滤迟早
     只落在一边，首页人数会和关系网对不上（施工单 §2「必须同口径」）。
     人物详情的近况只取 TA 本人发的、当前账号可见的朋友圈
     （momentsTab.canSee，user 视角三道闸）；`latestVisibleMoment` 的实现
     已搬到 ta-network.js，本页只做转发（保持唯一实现）。
   承诺：首页四区是设计稿定案，**不加第五区** —— 承诺列表与详情
     都在「幕后」（ta-backstage），首页脚注给入口。

   ─── 写入边界（第二批）────────────────────────────────────
   · 唯一写入通道 = 顶栏「记一笔」/ 各详情页「编辑」的手动表单，
     落 ta-life.js 三张表（tagScope 盖章 + scoped 读取 + 删房名单）；
   · 状态只认闭集、流转留 history；**承诺绝不自动判兑现**；
  · 页面打开本身仍然 0 模型、0 写入 —— 冒烟有快照断言守着；
  · 模型产出通道（待校验提案）**已上线**（第四批，ta-proposal.js：
    模型候选先落 taProposals，确认才进正式表）—— 旧注释说「未实现」是过期信息。

   ─── 第五批：已成立影响（2026-10-02）────────────────────────
   影响挂在 taEvents[].impacts 上，读写全在 ta-impact.js（0 模型）。
   本页两处接它：
     · 人物详情（ta-person）：列出这个人名下**已成立的影响**，
       连同「谁知道 / 依据 / 有效期 / 角色是否已经有过反应」——
       没有就保持空，不填剧情（设计稿 §1 原文）；
     · 幕后（ta-backstage）六区「NPC 事件与影响」：
       事件更正（事实变了 ≠ 角色没反应过）+ 影响解除/复核。
   注入侧（F1/F2）只走 prompt-engine 的 taimpact 槽，
   本页**不参与**装配，也不因为打开页面而写任何影响状态。

   ─── 红线（延续第一批）────────────────────────────────────
   · 「user 能看到的」≠「角色能看到的」——涉及他人视角的判定一律
     复用现成实现（canSee / charViewOf），不自己另判；
   · 空状态不自动生成生活内容；所有状态显示更新时间。

   —— 切岛纪律（page-calendar.js viewSyncSandbox 同款）——
   页面实例是缓存复用的，render 只跑一次、onShow 只会 paint。
   数据每次 paint 全量重读（没有视图缓存可残留），但 sbId 变化时
   必须把滚动归零，否则新岛的窗口停在上一座岛的阅读位置。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;
  /* v2 数据层（ta-life.js 先于本文件加载）。缺失时退回第一批纯只读。 */
  var taLife = Sleepy.taLife || null;
  var P = Sleepy.taProposals || null;   /* 第四批提案层（ta-proposal.js） */
  var TM = Sleepy.taModel || null;      /* 第四批模型模块（ta-model.js） */
  var TI = Sleepy.taImpact || null;     /* 第五批影响层（ta-impact.js） */
  /* 关系网只读 selector（ta-network.js，先于本文件加载）。
     第一批起：首页 04「身边的人」的**人物节点集合唯一出口**就是它 ——
     本页不再自己拼 charsOfSandbox + npcsOfRoom（施工单 §2 原文）。 */
  var TN = Sleepy.taNetwork || null;

  function arr(v) { return Array.isArray(v) ? v : []; }

  var SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';
  function ic(body) { return '<svg ' + SVG + '>' + body + '</svg>'; }

  /* ---------------------------- 小工具 ---------------------------- */

  function empty(ctx, title, hint) {
    var box = h('div', 'empty');
    box.appendChild(h('div', 'empty-paper'));
    box.appendChild(h('p', 'empty-text', title));
    box.appendChild(h('p', 'empty-hint', hint));
    return box;
  }

  function section(title, no) {
    var sec = h('section', 'we-sec');
    var head = h('div', 'we-sec-head');
    head.appendChild(h('span', 'we-sec-no', no));
    head.appendChild(h('span', 'we-sec-title', title));
    sec.appendChild(head);
    return sec;
  }

  /* 更新时间说人话：MM-DD hh:mm。存档里可能是 ISO 串也可能是毫秒。 */
  function timeText(t) {
    if (!t) return '';
    var ms = typeof t === 'number' ? t : Date.parse(String(t));
    if (isNaN(ms)) return '';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* openLoops / attentionInbox 的条目：总结引擎写入的是字符串或轻对象
     （page-proactive.js 的取法：content || text || title，这里同口径）。 */
  function itemText(it) {
    if (typeof it === 'string') return it.trim();
    return String((it && (it.content || it.text || it.title)) || '').trim();
  }

  /* lifeFeed 的行是注入格式（“- MM-DD 谁：…”），展示时把行首短横摘掉。 */
  function stripDash(line) { return String(line || '').replace(/^- /, ''); }

  /* 键归 root：皮套的状态也是大号的状态（与 page-summary / page-proactive
     的写读两侧同一口径）。 */
  function rootIdOf(char) {
    try {
      var r = (core.rootOf && core.rootOf(char.id)) || null;
      return (r || char).id;
    } catch (e) { return char.id; }
  }

  function rootKeyOf(char, key) { return key + ':' + rootIdOf(char); }

  /* lifeFeed.recent：惰性取（page-we 同款 —— 模块没就绪不当回事）。 */
  function lifeLines(charId, userId) {
    try {
      var lf = Sleepy.lifeFeed;
      if (!lf || !lf.recent || !charId) return [];
      return lf.recent(charId, userId).filter(function (x) {
        return x && x.line;
      });
    } catch (e) { return []; }
  }

  /* 人物详情的「最近可见近况」：TA 本人发的、当前账号**能看见**的最新一条
     朋友圈。判定复用 page-moments 的 canSee（user 视角三道闸：账号隔离 /
     朋友权限 / 动态可见范围）——方向别写反，那是 canCharSee 的事。

     第一批起实现搬到 `ta-network.js`（关系网、首页 04、人物详情三处
     必须同源），这里只做**委托**，不再各留一份 —— 免得两处过滤口径漂移。
     万一 selector 没加载（不该发生），退回 null，页面照常显示「暂无」。 */
  var latestVisibleMoment = (Sleepy.taNetwork && Sleepy.taNetwork.latestVisibleMoment)
    ? Sleepy.taNetwork.latestVisibleMoment
    : function () { return null; };

  /* 列表行：主文字 + 右侧标签 + 可选 meta（更新时间）。可点击时整体是按钮。 */
  function rowEl(opt) {
    var row = h(opt.onClick ? 'button' : 'div', 'ta-row' + (opt.onClick ? ' ta-row-btn' : ''));
    if (opt.onClick) row.type = 'button';
    var main = h('div', 'ta-row-main');
    main.appendChild(h('p', 'ta-row-tx', opt.text));
    if (opt.meta) main.appendChild(h('span', 'ta-meta', opt.meta));
    row.appendChild(main);
    if (opt.tag) row.appendChild(h('span', 'ta-row-tag', opt.tag));
    if (opt.onClick) row.addEventListener('click', opt.onClick);
    return row;
  }

  /* 详情页底部动作行：编辑 / 两步确认删除。 */
  function actionRow(ctx, kind, rec, onDone) {
    var wrap = h('div', 'ta-btnrow');
    var edit = h('button', 'ta-btn', '编辑');
    edit.type = 'button';
    edit.addEventListener('click', function () { openLifeDrawer(ctx, kind, rec, onDone); });
    var del = h('button', 'ta-btn ta-btn-danger', '删除');
    del.type = 'button';
    var armed = false;
    del.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        del.textContent = '再点一次确认删除';
        return;
      }
      if (taLife && taLife.remove(kind, rec.id)) {
        if (ctx.toast) ctx.toast('已删除', 'ok');
        if (typeof ctx.back === 'function') ctx.back();
        if (onDone) onDone();
      }
    });
    wrap.appendChild(edit);
    wrap.appendChild(del);
    return wrap;
  }

  /* 第四批：详情页「复核或推进」—— 明确入口的模型调用（review 不需要
     自主开关）。按钮就地变「生成中…」，结果用 toast 如实回报。 */
  function reviewBtn(ctx, kind, rec) {
    var btn = h('button', 'ta-btn', '让 ta 复核或推进（调用模型）');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      if (!TM) { if (ctx.toast) ctx.toast('模型模块没就绪', 'err'); return; }
      btn.disabled = true;
      btn.textContent = '生成中…';
      TM.runMode('review', {
        charId: rec.refCharId || (core.activeCharOnIsland() || {}).id,
        sourceRefs: [rec.id]
      }, { extraKey: rec.id }).then(function (r) {
        btn.disabled = false;
        btn.textContent = '让 ta 复核或推进（调用模型）';
        if (ctx.toast) {
          ctx.toast(r.ok
            ? '复核完成：新增 ' + (r.saved || 0) + ' 条待审核' + (r.duplicate ? '（去重 ' + r.duplicate + '）' : '') + (r.failed ? '；非法丢弃 ' + r.failed : '')
            : (r.error || '复核失败'), r.ok ? 'ok' : 'err');
        }
        if (r.ok && kind === 'items') paintItem(ctx);
        else if (r.ok && kind === 'follows') paintFollow(ctx);
      });
    });
    return btn;
  }

  /* 详情页里的状态快改（select）：只认闭集，落 taLife.setStatus。 */
  function statusSelect(ctx, kind, rec, onDone) {
    var set = (kind === 'items') ? taLife.ITEM_STATUS : taLife.PROMISE_STATUS;
    var wrap = h('div', 'ta-status-wrap');
    wrap.appendChild(h('span', 'ta-label', '状态'));
    var sel = h('select', 'ta-select');
    set.forEach(function (s) {
      var o = h('option', '', s);
      o.value = s;
      if (s === (rec.status || set[0])) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var hit = taLife.setStatus(kind, rec.id, sel.value, '');
      if (ctx.toast) ctx.toast(hit ? '状态改为「' + sel.value + '」' : '改不了（非法状态）', hit ? 'ok' : 'err');
      if (hit && onDone) onDone();
    });
    wrap.appendChild(sel);
    return wrap;
  }

  /* ---------------------------- 录入 / 编辑抽屉 ----------------------------
     骨架整段照 page-we.js openAddDrawer（浮层挂 #phone、absolute，
     scrim/关闭钮/点空白关）。kind=null 时先选类型；existing 给了就是编辑。 */
  var FIELDS = {
    items: {
      name: '事项',
      fields: [
        { k: 'title', label: '在做什么（必填）', type: 'text' },
        { k: 'detail', label: '阻碍 / 说明（可选）', type: 'area', rows: 3 },
        { k: 'nextCheck', label: '下一复核条件（可选，如「零件到货再看」）', type: 'text' },
        { k: 'sourceRef', label: '来处备注（可选，如「聊过的」）', type: 'text' }
      ],
      need: 'title'
    },
    promises: {
      name: '承诺',
      fields: [
        { k: 'quote', label: '原话（必填，尽量照原样记）', type: 'area', rows: 2 },
        { k: 'toWhom', label: '对象（可选）', type: 'text' },
        { k: 'condition', label: '条件（可选）', type: 'text' },
        { k: 'standard', label: '完成标准（可选，什么才算兑现）', type: 'text' },
        { k: 'evidence', label: '当前证据（可选）', type: 'text' },
        { k: 'pendingWhy', label: '待核实原因（可选）', type: 'text' },
        { k: 'sourceRef', label: '来处备注（可选）', type: 'text' }
      ],
      need: 'quote'
    },
    follows: {
      name: '关注',
      fields: [
        { k: 'target', label: '在留意什么 / 谁（必填）', type: 'text' },
        { k: 'reason', label: '缘由（可选）', type: 'text' },
        { k: 'latest', label: '最新已知信息（可选）', type: 'area', rows: 2 },
        { k: 'note', label: '备注（可选）', type: 'text' },
        { k: 'sourceRef', label: '来处备注（可选）', type: 'text' }
      ],
      need: 'target'
    }
  };

  function openLifeDrawer(ctx, kind, existing, onSaved, preset) {
    if (!taLife) {
      if (ctx.toast) ctx.toast('数据层没就绪', 'err');
      return;
    }
    /* 身份闸（2026-10-02 真机验收：没岛没角色时记一笔「存不上还不说为什么」）
       —— 没有当前岛 / 当前身份，scopeId 为 null，数据层按红线会静默拒收。
       与其无声丢弃，不如一开始就讲清楚。 */
    if (!core.activeSandbox() || !core.activeCharOnIsland() || !core.activeUserOnIsland()) {
      if (ctx.toast) ctx.toast('先落岛、选好「你」和「TA」，才有的生活可记', 'err');
      return;
    }
    var phone = document.getElementById('phone');
    if (!phone) return;
    /* title0 必须在 innerHTML 之前算好（var 提升只是声明提前，赋值不提前，
       挪晚一拍标题就会渲染成 undefined —— 第三批复查抓到） */
    preset = preset || {};
    var title0 = existing ? '编辑' : (preset.sourceType ? '从兜底转正' : '记一笔');
    var drawer = h('div', 'we-drawer');
    drawer.innerHTML =
      '<div class="we-drawer-scrim"></div>' +
      '<div class="we-drawer-sheet">' +
        '<div class="we-drawer-head">' +
          '<span class="we-drawer-title">' + title0 + '</span>' +
          '<button class="we-drawer-close" type="button" aria-label="关闭">&#10005;</button>' +
        '</div>' +
        '<div class="we-drawer-body"></div>' +
      '</div>';
    phone.appendChild(drawer);

    var bodyEl = drawer.querySelector('.we-drawer-body');
    var closeBtn = drawer.querySelector('.we-drawer-close');
    var scrim = drawer.querySelector('.we-drawer-scrim');
    function close() { if (drawer.parentNode) drawer.parentNode.removeChild(drawer); }
    closeBtn.addEventListener('click', close);
    scrim.addEventListener('click', close);
    drawer.addEventListener('click', function (e) { if (e.target === drawer) close(); });

    var curKind = kind || (existing ? null : 'items');
    var kindWrap = null, kindSel = null;
    /* 第三批一键转正：preset 预填字段值 + 来源三元组（sourceType/sourceId/
       sourceRef 随 add 落表，指纹去重靠 findBySource）。 */

    /* 新建且没指定类型：先给类型选择（选了就换字段组） */
    if (!kind && !existing) {
      kindWrap = h('div', 'we-drawer-srcwrap');
      kindWrap.appendChild(h('p', 'we-drawer-label', '记哪一类'));
      kindSel = h('select', 'we-drawer-src');
      ['items', 'promises', 'follows'].forEach(function (k) {
        var o = h('option', '', FIELDS[k].name);
        o.value = k;
        if (k === curKind) o.selected = true;
        kindSel.appendChild(o);
      });
      kindWrap.appendChild(kindSel);
      bodyEl.appendChild(kindWrap);
    }

    var fieldBox = h('div', '');
    bodyEl.appendChild(fieldBox);

    /* 状态选择（编辑时才有；新建走默认态） */
    var statusField = null;

    function buildFields(k) {
      fieldBox.innerHTML = '';
      statusField = null;
      var conf = FIELDS[k];
      conf.fields.forEach(function (f) {
        var pre = existing ? existing[f.k] : (preset[f.k] !== undefined ? preset[f.k] : '');
        var ctl = (f.type === 'area')
          ? ui.textArea({ label: f.label, rows: f.rows || 2, value: pre })
          : ui.textField({ label: f.label, value: pre });
        ctl.__k = f.k;
        fieldBox.appendChild(ctl.el);
      });
      if (existing) {
        var set = (k === 'items') ? taLife.ITEM_STATUS : taLife.PROMISE_STATUS;
        var wrap = h('div', 'we-drawer-srcwrap');
        wrap.appendChild(h('p', 'we-drawer-label', '状态（改状态会留痕）'));
        var sel = h('select', 'we-drawer-src');
        set.forEach(function (s) {
          var o = h('option', '', s);
          o.value = s;
          if (s === (existing.status || set[0])) o.selected = true;
          sel.appendChild(o);
        });
        wrap.appendChild(sel);
        statusField = sel;
        fieldBox.appendChild(wrap);
      }
    }
    buildFields(curKind);
    if (kindSel) {
      kindSel.addEventListener('change', function () {
        curKind = kindSel.value;
        buildFields(curKind);
      });
    }

    var saveBtn = ui.button(existing ? '保存修改' : '记下', 'primary');
    bodyEl.appendChild(saveBtn);
    saveBtn.addEventListener('click', function () {
      var conf = FIELDS[curKind];
      var payload = {};
      var filled = '';
      /* 字段取值：buildFields 时把控件顺序与 conf.fields 对齐 ——
         直接按索引取，稳（innerHTML 重建后顺序不会变）。 */
      var ctrls = [];
      Array.prototype.forEach.call(fieldBox.children, function (child) {
        var inp = child.querySelector ? child.querySelector('.set-input, .set-textarea') : null;
        if (inp) ctrls.push(inp);
      });
      conf.fields.forEach(function (f, i) {
        var v = ctrls[i] ? String(ctrls[i].value || '').trim() : '';
        if (v) payload[f.k] = v;
        if (f.k === conf.need && v) filled = v;
      });
      if (!filled) {
        if (ctx.toast) ctx.toast('「' + conf.fields[0].label.split('（')[0] + '」还没填', 'err');
        return;
      }
      var char = core.activeCharOnIsland();
      var user = core.activeUserOnIsland();
      payload.refCharId = char ? char.id : null;
      payload.refUserId = user ? user.id : null;
      /* 转正：来源三元组随表落库（preset 只在新建时给） */
      if (!existing && preset.sourceType) {
        payload.sourceType = preset.sourceType;
        payload.sourceId = preset.sourceId || null;
        payload.sourceRef = preset.sourceRef || null;
      }

      var hit;
      if (existing) {
        hit = taLife.patch(curKind, existing.id, payload);
        if (statusField) hit = taLife.setStatus(curKind, existing.id, statusField.value, '编辑时改');
      } else {
        hit = taLife.add(curKind, payload);
      }
      close();
      if (ctx.toast) ctx.toast(existing ? '已保存' : (preset.sourceType ? '已转正' : '已记下'), 'ok');
      if (onSaved) onSaved();
      else if (typeof ctx.refresh === 'function') ctx.refresh();
      void hit;
    });
  }

  /* ---------------------------- 群岛选人闸（We 同款，2026-10-02 补） ----------------------------
   * 第一批按施工单只做了「未落岛 / 未选角色」空态；用户拍板补上 We 的
   * 选人闸：孤岛 / 单大号自动归位，群岛多角色先出选人页。
   * 身份仍不自猜 —— 归位走 core.switchTo（大号 + 岛上默认「我」）。 */
  var TA_PICK_TONES = ['linear-gradient(145deg,#8C7355,#C0A483)',
    'linear-gradient(145deg,#9A6E62,#C9A091)',
    'linear-gradient(145deg,#7E7A5E,#B3AE8B)',
    'linear-gradient(145deg,#8A6E7C,#BCA0AC)',
    'linear-gradient(145deg,#87745A,#BCA98B)'];
  function gateTone(id) {
    var str = String(id || ''); var hh = 5381;
    for (var i = 0; i < str.length; i++) hh = ((hh << 5) + hh + str.charCodeAt(i)) >>> 0;
    return TA_PICK_TONES[hh % TA_PICK_TONES.length];
  }
  function gateMains() {
    var sb = core.activeSandbox();
    if (!sb || !core.charsOfSandbox) return [];
    return core.charsOfSandbox(sb.id).filter(function (c) {
      return (c.kind || 'main') === 'main';
    });
  }
  function gatePaint(ctx, host, mains, bigMe, repaint) {
    host.appendChild(h('div', 'we-pick-hero-kicker', 'ARCHIPELAGO'));
    host.appendChild(h('h2', 'we-pick-hero-title', '想看谁的生活？'));
    host.appendChild(h('p', 'we-pick-hero-note',
      '群岛上每位角色有各自的生活窗口。选一位，ta 就为你们打开。'));
    var list = h('div', 'we-pick-list');
    mains.forEach(function (ch) {
      var name = String(ch.name || '').trim() || '他';
      var b = h('button', 'we-pick-card');
      b.type = 'button';
      var av = h('span', 'we-pick-avatar');
      av.textContent = name.slice(0, 1);
      av.style.background = gateTone(ch.id);
      if (core.setAvatarBg) { try { core.setAvatarBg(av, ch); } catch (e) { /* 桩没有 */ } }
      b.appendChild(av);
      var info = h('span', 'we-pick-info');
      info.appendChild(h('b', '', name));
      b.appendChild(info);
      b.appendChild(h('span', 'we-pick-go', '›'));
      b.addEventListener('click', function () {
        core.switchTo(ch.id, bigMe ? bigMe.id : undefined);
        /* 换身份 = 换视觉（岛覆盖 > 全局）；桌面常驻底层一并重画（We 同款） */
        if (Sleepy.appearance && Sleepy.appearance.apply) { try { Sleepy.appearance.apply(); } catch (e) { /* 桩没有 */ } }
        if (Sleepy.__homeCtx && Sleepy.__homeCtx.repaint) { try { Sleepy.__homeCtx.repaint(); } catch (e) { /* 桩没有 */ } }
        if (ctx.toast) ctx.toast('和「' + name + '」打开 ta', 'ok');
        repaint();
      });
      list.appendChild(b);
    });
    host.appendChild(list);
  }
  /* 返回 true = 闸已接管渲染（选人页）。孤岛/单大号自动归位后返回 false。 */
  function gateApply(ctx, host, repaint) {
    var sb = core.activeSandbox();
    if (!sb) return false;
    if (core.activeCharOnIsland() && core.activeUserOnIsland()) return false;
    var mains = gateMains();
    if (!mains.length) return false;   /* 空岛 → 原空态兜 */
    var bigMe = core.defaultUserOfSandbox ? core.defaultUserOfSandbox(sb) : null;
    if (!core.needsCharPick(sb)) {
      core.switchTo(mains[0].id, bigMe ? bigMe.id : undefined);
      return false;
    }
    gatePaint(ctx, host, mains, bigMe, repaint);
    return true;
  }

  /* ---------------------------- 首页 ---------------------------- */

  /* 页面级视图状态（只有滚动归零要盯换岛；数据每次 paint 全量重读）。 */
  var view = { sbId: null };

  function paint(ctx) {
    var body = ctx.body;
    var __st = 0;
    try { __st = body.scrollTop || 0; } catch (e) { /* 桩环境没有 */ }
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');   /* 骨架复用 We 的纸张语言（we- 类是通用排版） */
    body.insertBefore(out, body.firstChild);

    var sb = core.activeSandbox();
    if (!sb) {
      view.sbId = null;
      out.appendChild(empty(ctx, '未落岛 / 未选角色',
        '还没有当前世界 —— 先在桌面选一间房，ta 才有生活可看。'));
      return;
    }
    var sid = sb.id;
    var islandChanged = view.sbId !== sid;
    view.sbId = sid;

    /* 群岛选人闸：身份没定时先选人（孤岛/单大号自动归位，We 同款） */
    if (gateApply(ctx, out, function () { paint(ctx); })) return;

    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (!char || !user) {
      out.appendChild(empty(ctx, '未落岛 / 未选角色',
        '这座岛上还没有确定的「你」和「TA」。先去浮岛降落选人 —— 「记一笔」也需要身份，没有身份记下的东西没有归属。'));
      try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
      return;
    }

    var charName = String(char.name || '未命名').trim();
    var userName = core.labelOfUser(user, '我');

    /* ---- 数据预取（真实出口，一次读齐供四个区块用） ---- */
    var cs = store.get(rootKeyOf(char, 'charState')) || {};
    var loops = store.get(rootKeyOf(char, 'openLoops')) || {};
    var att = store.get(rootKeyOf(char, 'attentionInbox')) || {};
    var recent = lifeLines(char.id, user.id);
    /* v2：结构化表优先（ta-life.js；模块缺失时退回第一批纯只读） */
    var myItems = taLife ? taLife.itemsOf(char.id) : [];
    var myFollows = taLife ? taLife.followsOf(char.id) : [];
    var activeItems = myItems.filter(function (it) { return it && it.status !== '已完成'; });

    /* ---- 头部：ta 标识 + 当前角色名 ---- */
    var hero = h('div', 'ta-hero');
    hero.appendChild(h('div', 'ta-hero-kicker',
      (sb.kind === 'archipelago' ? '群岛' : '孤岛') + ' · 生活窗口'));
    hero.appendChild(h('div', 'ta-hero-name', charName));
    hero.appendChild(h('div', 'ta-hero-sub',
      '这里只陈列已经成立的生活 —— 打开这一页不会让 ta 多做任何事。'));
    out.appendChild(hero);

    /* ---- 01 此刻 / 最近状态 ---- */
    var nowSec = section('此刻 / 最近状态', '01');
    var csLine = '';
    var csFrom = '';
    (['feelings', 'readings', 'unspoken']).some(function (k) {
      var one = arr(cs[k]).map(itemText).filter(Boolean)[0] || '';
      if (one) { csLine = one; csFrom = '心绪（' + k + '）'; return true; }
      return false;
    });
    if (csLine) {
      var quote = h('div', 'we-quote');
      quote.appendChild(h('p', '', csLine));
      quote.appendChild(h('small', '',
        '更新于 ' + (timeText(cs.updatedAt) || '未知时间') + ' · ' + csFrom));
      nowSec.appendChild(quote);
    } else if (recent.length) {
      var rq = h('div', 'we-quote');
      rq.appendChild(h('p', '', stripDash(recent[0].line)));
      rq.appendChild(h('small', '',
        '更新于 ' + (timeText(recent[0].at) || '未知时间') + ' · 近期生活动态'));
      nowSec.appendChild(rq);
    } else {
      nowSec.appendChild(h('p', 'we-none',
        '还没有可显示的状态。没有真实数据时，ta 不编生活。'));
    }
    out.appendChild(nowSec);

    /* ---- 02 最近在做（v2：taItems 优先，openLoops / lifeFeed 兜底） ---- */
    var doSec = section('最近在做', '02');
    if (activeItems.length) {
      activeItems.forEach(function (it) {
        doSec.appendChild(rowEl({
          text: String(it.title || '').trim() || '（没写标题）',
          tag: it.status || '',
          meta: '更新于 ' + (timeText(it.updatedAt) || '未知时间') +
            (it.nextCheck ? ' · 下一复核：' + it.nextCheck : ''),
          onClick: function () { ctx.open('ta-item', { id: it.id }); }
        }));
      });
      var doneN = myItems.length - activeItems.length;
      doSec.appendChild(h('p', 'ta-meta',
        '手动事项 ' + activeItems.length + ' 条' +
        (doneN ? '（另有 ' + doneN + ' 条已完成，在「幕后」里）' : '') +
        '。状态是记下的，不是 ta 自己报的。'));
    } else {
      var loopItems = arr(loops.items).map(function (it) {
        return { text: itemText(it) };
      }).filter(function (x) { return x.text; });
      if (loopItems.length) {
        loopItems.forEach(function (x) {
          /* 第三批一键转正：同一来源指纹查重，已转正的行标「已接入」 */
          var fp = 'ol:' + taLife.hashText(x.text);
          var promoted = taLife.findBySource('items', 'openLoops', fp);
          doSec.appendChild(rowEl({
            text: x.text,
            tag: promoted ? '已接入' : '',
            meta: '更新于 ' + (timeText(loops.updatedAt) || '未知时间'),
            onClick: promoted
              ? function () { ctx.open('ta-item', { id: promoted.id }); }
              : function () {
                  ctx.open('ta-item', {
                    text: x.text,
                    at: loops.updatedAt || '',
                    src: '悬而未决的事（openLoops）· 总结引擎产出'
                  });
                }
          }));
        });
        doSec.appendChild(h('p', 'ta-meta',
          '以上来自已有记录 —— 点开可以一键转正为事项；原始队列不动。'));
      } else if (recent.length) {
        recent.slice(0, 4).forEach(function (x) {
          doSec.appendChild(rowEl({
            text: stripDash(x.line),
            meta: '更新于 ' + (timeText(x.at) || '未知时间'),
            onClick: function () {
              ctx.open('ta-item', {
                text: stripDash(x.line),
                at: x.at || '',
                src: '近期生活动态（lifeFeed）· 窗口摘要，不是独立事项'
              });
            }
          }));
        });
        doSec.appendChild(h('p', 'ta-meta', '还没有结构化的事项记录，以上是近期生活的窗口摘要。'));
      } else {
        doSec.appendChild(h('p', 'we-none', '还没有持续在做的事。'));
      }
    }
    out.appendChild(doSec);

    /* ---- 03 一直留意（v2：taFollows 优先，attentionInbox 兜底） ---- */
    var attSec = section('一直留意', '03');
    if (myFollows.length) {
      myFollows.forEach(function (f) {
        attSec.appendChild(rowEl({
          text: String(f.target || '').trim() || '（没写对象）',
          tag: f.reason ? String(f.reason) : '',
          meta: (f.latest ? '最新：' + String(f.latest).slice(0, 40) + ' · ' : '') +
            '更新于 ' + (timeText(f.updatedAt) || '未知时间'),
          onClick: function () { ctx.open('ta-follow', { id: f.id }); }
        }));
      });
      attSec.appendChild(h('p', 'ta-meta',
        '关注过期或提醒处理掉，不等于事情有了结果 —— 这里只陈列，不下结论。'));
    } else {
      var attItems = arr(att.items).map(itemText).filter(Boolean);
      if (attItems.length) {
        attItems.forEach(function (t) {
          var fp = 'att:' + taLife.hashText(t);
          var promoted = taLife.findBySource('follows', 'attentionInbox', fp);
          attSec.appendChild(rowEl({
            text: t,
            tag: promoted ? '已接入' : '',
            meta: '更新于 ' + (timeText(att.updatedAt) || '未知时间'),
            onClick: promoted
              ? function () { ctx.open('ta-follow', { id: promoted.id }); }
              : function () {
                  /* lifeFeed/openLoops 有类型可猜，attentionInbox 天生就是
                     关注 —— 直接开预填抽屉，用户确认才落表 */
                  openLifeDrawer(ctx, 'follows', null, function () { paint(ctx); }, {
                    target: t,
                    sourceType: 'attentionInbox',
                    sourceId: fp,
                    sourceRef: '总结引擎关注队列 · 更新于 ' + (timeText(att.updatedAt) || '未知时间')
                  });
                }
          }));
        });
        attSec.appendChild(h('p', 'ta-meta',
          '以上来自总结引擎的关注队列 —— 点一条可确认转正为关注；原始队列不动。'));
      } else {
        attSec.appendChild(h('p', 'we-none', '还没有一直在留意的事。'));
      }
    }
    out.appendChild(attSec);

    /* ---- 04 身边的人 ----
       第一批起：**人物节点集合只从关系网 selector 取**（ta-network.js）。
       本页不再自己拼 charsOfSandbox + npcsOfRoom —— 两处各拼一套的话，
       权限过滤（NPC knownBy）迟早只落在一边，首页和关系网的人数就会对不上
       （施工单 §2 原文「必须同口径」）。
       顺带一个语义变化要记住：节点标签现在是**与中心角色**的关系
       （charRel 三态 / link.relation），不再是「我 × 对方」那条 ——
       后者作为 `relationWithUser` 单独带出来，放在 meta 里如实说明。 */
    var pSec = section('身边的人', '04');
    var netRes = TN ? TN.build({ charId: char.id, userId: user.id, sbId: sid }) : null;
    var netNodes = (netRes && netRes.ok) ? netRes.nodes : [];

    pSec.appendChild(rowEl({
      text: charName + ' × ' + userName,
      /* 标签也只从 selector 取（同口径）。selector 没就绪就留空，
         绝不在本页自己 findLink 兜一遍 —— 那正是要消灭的第二套拼法。 */
      tag: (netRes && netRes.ok)
        ? (netRes.center.relationWithUser || (netRes.center.hasLinkWithUser ? '已建立联系' : ''))
        : '',
      meta: '当前身份的关系记录',
      onClick: function () { ctx.open('ta-person', { id: char.id }); }
    }));

    /* 关系网入口：图 / 列表双视图（只读投影，进去不写任何东西） */
    pSec.appendChild(rowEl({
      text: '关系网 →',
      tag: netNodes.length ? String(netNodes.length) + ' 人' : '',
      meta: '看看 TA 身边的人和已经成立的关系（图 / 列表）',
      onClick: function () { ctx.open('ta-network', {}); }
    }));

    if (netNodes.length) {
      netNodes.forEach(function (n) {
        var kindTx = n.kind === 'npc' ? '岛上的 NPC'
          : (n.kind === 'user' ? '当前身份' : '岛上的角色');
        pSec.appendChild(rowEl({
          text: String(n.name || '未命名').trim() || '未命名',
          /* 没依据就「关系未注明」，**不补默认关系词**（设计稿 §2） */
          tag: (String(n.label || '').trim() || '关系未注明'),
          meta: kindTx + (n.relationWithUser ? ' · 与你的关系：' + n.relationWithUser : ''),
          onClick: n.clickable
            ? function () { ctx.open('ta-person', { id: n.id }); }
            : null
        }));
      });
    } else if (netRes && netRes.ok) {
      pSec.appendChild(h('p', 'we-none',
        '这座岛上暂时只有你们两个人，也挺好。'));
    } else {
      pSec.appendChild(h('p', 'we-none',
        '读不到人物节点 —— 关系网数据层没就绪，这里先不猜。'));
    }
    /* 第三批：NPC 候选草稿入口 —— 草稿不进这份名单，确认入库后才出现 */
    pSec.appendChild(rowEl({
      text: '＋ 补充身边的人',
      tag: '草稿',
      meta: '先记候选，确认后才成为正式人物',
      onClick: function () { ctx.open('ta-draft-edit', {}); }
    }));
    out.appendChild(pSec);

    /* ---- 脚注：承诺与幕后入口（v2：承诺详情在幕后，不再是占位）---- */
    var footBtn = rowEl({
      text: '承诺记录 · 幕后管理',
      meta: '玩家查看不等于角色知情 —— 承诺与三张表的管理都在这里',
      onClick: function () { ctx.open('ta-backstage', {}); }
    });
    footBtn.classList.add('ta-foot-row');
    out.appendChild(footBtn);

    /* 换岛：滚动归零；普通 onShow：保持阅读位置（paintKeepingScroll 同款）。 */
    try { body.scrollTop = islandChanged ? 0 : __st; } catch (e) { /* 桩环境没有 */ }
  }

  Sleepy.register('ta', {
    title: 'ta',

    /* render 只跑一次（页面缓存复用）：建好首屏 + 顶栏动作。 */
    render: function (ctx) {
      ctx.setTitle('ta');
      ctx.setActions([
        {
          label: '记一笔',
          svg: ic('<path d="M12 6.5v11M6.5 12h11"/>'),
          onClick: function () { openLifeDrawer(ctx, null, null, function () { paint(ctx); }); }
        },
        {
          label: '幕后',
          svg: ic('<rect x="4.5" y="5" width="15" height="14" rx="2"/><path d="M9 5v14M13 9.5h4M13 12.5h4"/>'),
          onClick: function () { ctx.open('ta-backstage', {}); }
        }
      ]);
      paint(ctx);
    },

    onShow: function (ctx) {
      paint(ctx);
    }
  });

  /* ---------------------------- 事项详情 ----------------------------
     v2：params.id 命中 taItems → 完整详情（来处 / 状态 / 阻碍说明 /
     下一复核条件 / history 变化线 / 编辑 / 删除）；只有 params.text
     （第一批的兜底入口）→ 老样子的只读占位。 */
  function quoteBlock(p, small, cls) {
    var quote = h('div', 'we-quote' + (cls ? ' ' + cls : ''));
    quote.appendChild(h('p', '', p));
    if (small) quote.appendChild(h('small', '', small));
    return quote;
  }

  function histBlock(rec) {
    var hist = arr(rec.history);
    if (!hist.length) return null;
    var box = h('div', 'ta-hist');
    box.appendChild(h('p', 'ta-label', '变化'));
    hist.slice().reverse().forEach(function (e) {
      var line = (e.from || '（无）') + ' → ' + (e.to || '') +
        (e.note ? ' · ' + e.note : '');
      box.appendChild(h('p', 'ta-hist-line',
        line + '　' + (timeText(e.at) || '')));
    });
    return box;
  }

  function labelLines(sec, pairs, fillEmpty) {
    pairs.forEach(function (pr) {
      /* 设计稿 §1：详情页的字段是固定结构 —— 空的摆「还没记」，
         不藏行（藏掉就成了「页面存在代替功能完成」）。 */
      var v = pr[1] ? String(pr[1]) : (fillEmpty ? '（还没记）' : '');
      if (!v) return;
      var row = h('p', 'ta-kv');
      row.appendChild(h('span', 'ta-kv-k', pr[0]));
      row.appendChild(h('span', 'ta-kv-v', v));
      sec.appendChild(row);
    });
  }

  Sleepy.register('ta-item', {
    title: '事项',
    render: function (ctx) { paintItem(ctx); },
    onShow: function (ctx) { paintItem(ctx); }
  });

  function paintItem(ctx) {
    var p = ctx.params || {};
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var rec = (taLife && p.id) ? taLife.findInScope('items', p.id) : null;
    var sec = section('事项详情', '·');
    if (rec) {
      sec.appendChild(quoteBlock(String(rec.title || '').trim() || '（没写标题）',
        '更新于 ' + (timeText(rec.updatedAt) || '未知时间')));
      sec.appendChild(statusSelect(ctx, 'items', rec, function () { paintItem(ctx); }));
      labelLines(sec, [
        ['阻碍 / 说明', rec.detail],
        ['下一复核条件', rec.nextCheck],
        ['来处', rec.sourceRef || (rec.sourceType === 'manual' ? '手动记下' : rec.sourceType)]
      ], true);
      var hb = histBlock(rec);
      if (hb) sec.appendChild(hb);
      sec.appendChild(h('p', 'ta-meta',
        '记下的生活不冒充 ta 自己的汇报 —— 状态是玩家侧的管理标记。'));
      sec.appendChild(reviewBtn(ctx, 'items', rec));
      sec.appendChild(actionRow(ctx, 'items', rec, function () { paintItem(ctx); }));
    } else if (p.text) {
      var text0 = String(p.text || '').trim();
      var src0 = String(p.src || '').trim();
      sec.appendChild(quoteBlock(text0, '更新于 ' + (timeText(p.at) || '未知时间')));
      sec.appendChild(h('p', 'ta-meta', '来源：' + (src0 || '当前角色的生活数据')));
      /* 第三批一键转正：openLoops → 事项（类型明确，单按钮）；
         lifeFeed → 程序不猜类型，用户在「记为事项 / 记为关注」里选。
         确认走预填抽屉，写入才发生；重复转正按来源指纹去重。 */
      var isOL = src0.indexOf('openLoops') >= 0;
      var isLF = src0.indexOf('lifeFeed') >= 0;
      if (isOL || isLF) {
        var srcType = isOL ? 'openLoops' : 'lifeFeed';
        var fp = (isOL ? 'ol:' : 'lf:') + taLife.hashText(text0);
        var promoted = taLife.findBySource('items', srcType, fp);
        var promotedF = promoted ? null : taLife.findBySource('follows', srcType, fp);
        if (promoted || promotedF) {
          sec.appendChild(h('p', 'ta-meta', '这条已接入：' +
            (promoted ? '正式事项' : '正式关注') + '。'));
          var seeBtn = h('button', 'ta-btn', '查看正式记录');
          seeBtn.type = 'button';
          seeBtn.addEventListener('click', function () {
            ctx.open(promoted ? 'ta-item' : 'ta-follow', { id: (promoted || promotedF).id });
          });
          var seeWrap = h('div', 'ta-btnrow');
          seeWrap.appendChild(seeBtn);
          sec.appendChild(seeWrap);
        } else if (isOL) {
          var pb = h('button', 'ta-btn', '转正为事项');
          pb.type = 'button';
          pb.addEventListener('click', function () {
            openLifeDrawer(ctx, 'items', null, function () { paintItem(ctx); }, {
              title: text0,
              sourceType: 'openLoops',
              sourceId: fp,
              sourceRef: src0 + ' · 原文更新于 ' + (timeText(p.at) || '未知时间')
            });
          });
          var pw = h('div', 'ta-btnrow');
          pw.appendChild(pb);
          sec.appendChild(pw);
        } else {
          var pi = h('button', 'ta-btn', '记为事项');
          pi.type = 'button';
          pi.addEventListener('click', function () {
            openLifeDrawer(ctx, 'items', null, function () { paintItem(ctx); }, {
              title: text0,
              sourceType: 'lifeFeed',
              sourceId: fp,
              sourceRef: src0 + ' · 原文更新于 ' + (timeText(p.at) || '未知时间')
            });
          });
          var pf = h('button', 'ta-btn', '记为关注');
          pf.type = 'button';
          pf.addEventListener('click', function () {
            openLifeDrawer(ctx, 'follows', null, function () { paintItem(ctx); }, {
              target: text0,
              sourceType: 'lifeFeed',
              sourceId: fp,
              sourceRef: src0 + ' · 原文更新于 ' + (timeText(p.at) || '未知时间')
            });
          });
          var pfw = h('div', 'ta-btnrow');
          pfw.appendChild(pi);
          pfw.appendChild(pf);
          sec.appendChild(pfw);
          sec.appendChild(h('p', 'ta-meta',
            '这条是生活摘要 —— 是事项还是关注由你判断，程序不猜。'));
        }
      } else {
        sec.appendChild(h('p', 'ta-foot',
          '这是窗口摘要，还没转成正式事项 —— 右上角「记一笔」可以记。'));
      }
    } else {
      sec.appendChild(h('p', 'we-none', '暂无更多已确认信息。'));
    }
    out.appendChild(sec);
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

  /* ---------------------------- 关注详情 ---------------------------- */
  Sleepy.register('ta-follow', {
    title: '关注',
    render: function (ctx) { paintFollow(ctx); },
    onShow: function (ctx) { paintFollow(ctx); }
  });

  function paintFollow(ctx) {
    var p = ctx.params || {};
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var rec = (taLife && p.id) ? taLife.findInScope('follows', p.id) : null;
    var sec = section('关注详情', '·');
    if (rec) {
      sec.appendChild(quoteBlock(String(rec.target || '').trim() || '（没写对象）',
        '更新于 ' + (timeText(rec.updatedAt) || '未知时间')));
      labelLines(sec, [
        ['缘由', rec.reason],
        ['最新已知信息', rec.latest],
        ['备注', rec.note],
        ['来处', rec.sourceRef || (rec.sourceType === 'manual' ? '手动记下' : rec.sourceType)]
      ], true);
      sec.appendChild(h('p', 'ta-meta',
        '关注过期、提醒处理或次数用完，不等于事项完成或承诺解除。'));
      sec.appendChild(actionRow(ctx, 'follows', rec, function () { paintFollow(ctx); }));
    } else {
      sec.appendChild(h('p', 'we-none', '暂无更多已确认信息。'));
    }
    out.appendChild(sec);
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

  /* ---------------------------- 人物详情 ---------------------------- */
  Sleepy.register('ta-person', {
    title: '人物',
    render: function (ctx) { paintPerson(ctx); },
    onShow: function (ctx) { paintPerson(ctx); }
  });

  /* 当前角色 id（人物详情里判「是不是 TA 自己」用，拿不到就空串）。 */
  function char0Id() {
    try { return (core.activeCharOnIsland() || {}).id || ''; } catch (e) { return ''; }
  }

  function paintPerson(ctx) {
    var p = ctx.params || {};
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var sec = section('人物详情', '·');
    var sb = core.activeSandbox();
    var user = core.activeUserOnIsland();
    var c = p.id && core.findChar ? core.findChar(p.id) : null;

    var onIsland = false;
    var isNpc = false;
    if (sb && c) {
      var roster = core.charsOfSandbox(sb.id).map(function (x) { return x.id; });
      if (roster.indexOf(c.id) >= 0 && (c.kind || 'main') === 'main') onIsland = true;
      if (!onIsland && core.npcsOfRoom) {
        isNpc = core.npcsOfRoom(sb).some(function (x) { return x.id === c.id; });
        if (isNpc) onIsland = true;
      }
    }

    if (!c || !onIsland) {
      sec.appendChild(h('p', 'we-none',
        '暂无更多已确认信息。'));
      out.appendChild(sec);
      return;
    }

    var name = String(c.name || '未命名').trim() || '未命名';
    var rel = (user && core.findLink && !isNpc) ? core.findLink(c.id, user.id, sb.id) : null;
    var tag = (rel && rel.relation) ? String(rel.relation)
      : (isNpc ? '岛上的 NPC' : (c.id === char0Id() ? '' : '岛上的角色'));

    sec.appendChild(quoteBlock(name, tag || null));

    var m = latestVisibleMoment(c.id, user ? user.id : '');
    if (m) {
      sec.appendChild(quoteBlock(m.text,
        '更新于 ' + (timeText(m.at) || '未知时间') + ' · 最近可见近况（TA 自己发的朋友圈）'));
    } else {
      sec.appendChild(h('p', 'we-none',
        '暂无更多已确认信息。'));
    }
    out.appendChild(sec);

    /* ---- 第五批：已经成立的影响（设计稿 §1 人物详情最后一项）----
       没有就保持空，不填充剧情。这里是**只读**的：只显示投影后的
       此刻状态（不落盘），管理动作全在幕后（ta-backstage）。 */
    var iSec = section('已经成立的影响', '·');
    var me = char0Id();
    var list = (TI && me) ? (c.id === me ? TI.impactsOf(me) : TI.impactsForPerson(me, c.id)) : [];
    if (!list.length) {
      iSec.appendChild(h('p', 'we-none',
        '还没有已经成立的影响。没有就保持空，不填充剧情。'));
    } else {
      var nowTs = Date.now();
      list.forEach(function (im) {
        var eff = TI.effectiveOf(im, nowTs);
        iSec.appendChild(impactRow(im, eff, null));
      });
    }
    out.appendChild(iSec);
    out.appendChild(h('p', 'ta-foot',
      '影响只在 ta 确认过之后才成立；这里显示的是当前状态，复核与解除在幕后。'));
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

  /* 影响状态标签：过期/减弱都**不是**解决 —— 文案必须自己说清，
     别让玩家把「淡了」读成「已经过去了」。 */
  var IMPACT_LABEL = {
    active: '生效中',
    faded: '已淡了（不是解决）',
    expired: '已过期（不是解决）',
    resolved: '已解决',
    stale: '依据已失效'
  };
  var IMPACT_KIND_LABEL = { mood: '短期心绪', situation: '持续处境' };

  /* 一行影响：正文 + 性质/状态 + 依据 / 反应史 / 复核。
     actions 传数组 [{label, cls, onClick}] 时右侧给按钮（幕后用）。 */
  function impactRow(im, eff, actions) {
    var wrap = h('div', 'ta-imp');
    var tagTxt = (IMPACT_KIND_LABEL[im.kind] || '影响') + ' · ' +
      (IMPACT_LABEL[eff.status] || eff.status);
    if (eff.status === 'active' && im.kind === 'mood') tagTxt += '（强度 ' + eff.strength + '/3）';
    wrap.appendChild(h('p', 'ta-imp-tag', tagTxt));
    wrap.appendChild(h('p', 'ta-imp-tx', String(im.text || '（没有内容）')));

    var bits = [];
    if (im.basis) bits.push('依据：' + im.basis);
    if (im.knownCharId) {
      var who = core.findChar ? core.findChar(im.knownCharId) : null;
      bits.push('知情：' + ((who && who.name) ? who.name : '（' + String(im.knownCharId).slice(0, 8) + '…）'));
    }
    if (im.reviewWhen) bits.push('复核：' + im.reviewWhen);
    if (im.resolveWhen) bits.push('解除条件：' + im.resolveWhen);
    if (im.expiresAt) bits.push('到期：' + (timeText(im.expiresAt) || '未知时间'));
    /* 事实变了 ≠ 角色没反应过 —— 两个都如实说 */
    bits.push(im.reactedAt
      ? '角色已经有过反应（' + (timeText(im.reactedAt) || '时间未知') + '）'
      : '角色还没有对它有反应');
    if (im.staleNote) bits.push('更正说明：' + im.staleNote);
    wrap.appendChild(h('p', 'ta-meta', bits.join(' · ')));

    if (actions && actions.length) {
      var acts = h('div', 'ta-p-acts');
      actions.forEach(function (a) {
        var b = h('button', 'ta-mini' + (a.cls ? ' ' + a.cls : ''), a.label);
        b.type = 'button';
        b.addEventListener('click', a.onClick);
        acts.appendChild(b);
      });
      wrap.appendChild(acts);
    }
    return wrap;
  }

  /* ---------------------------- 幕后管理（v2） ----------------------------
     设计稿 §1：第一版「只做清晰的管理说明」+ 三张表的管理列表。
     玩家查看不等于角色知情 —— 本页所有内容都是玩家侧的管理标记。 */
  Sleepy.register('ta-backstage', {
    title: '幕后',
    render: function (ctx) { paintBackstage(ctx); },
    onShow: function (ctx) { paintBackstage(ctx); }
  });

  function backstageList(ctx, out, kind, no, title, recs, lineOf, detailPage) {
    var sec = section(title, no);
    recs.forEach(function (rec) {
      sec.appendChild(rowEl({
        text: lineOf(rec),
        tag: rec.status || '',
        meta: '更新于 ' + (timeText(rec.updatedAt) || '未知时间'),
        onClick: function () { ctx.open(detailPage, { id: rec.id }); }
      }));
    });
    var add = h('button', 'ta-add-row', '＋ 记一条' + FIELDS[kind].name);
    add.type = 'button';
    add.addEventListener('click', function () {
      openLifeDrawer(ctx, kind, null, function () { paintBackstage(ctx); });
    });
    sec.appendChild(add);
    if (!recs.length) {
      sec.appendChild(h('p', 'ta-meta', '空 —— 空的就是空的，本页不编内容。'));
    }
    out.appendChild(sec);
  }

  function paintBackstage(ctx) {
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var sb = core.activeSandbox();
    var char = core.activeCharOnIsland();
    var user = core.activeUserOnIsland();
    if (!sb || !char || !user) {
      out.appendChild(empty(ctx, '未落岛 / 未选角色',
        '幕后管理跟着当前身份走 —— 先落岛选人。'));
      return;
    }

    /* 说明卡：设计稿 §1 的四条，一条不少 */
    var ruleSec = section('管理说明', '※');
    [
      '玩家查看不等于角色知情 —— 这里的每一条都是玩家侧的管理标记。',
      '私密资料不会通过首页标题、关系线或近况摘要泄露。',
      '自主生活更新、日历写入、主动联系是三个独立能力，互不代替。',
      'NPC 候选只以草稿存在 —— 确认入库前不进正式名单、不进聊天召回、不进生活推进。'
    ].forEach(function (t) {
      var p = h('p', 'we-none', t);
      ruleSec.appendChild(p);
    });
    out.appendChild(ruleSec);

    /* 开关区（第四批）：自主生活更新是真开关（ta-proposal.setAutoLife，
       键归 root）；主动联系沿用聊天设置只读；日历写入仍不自动。 */
    var swSec = section('独立能力', '※');
    var pro = null;
    try {
      pro = (Sleepy.chatSettings && Sleepy.chatSettings.charSettings)
        ? Sleepy.chatSettings.charSettings(char.id) : null;
    } catch (e) { pro = null; }
    swSec.appendChild(rowEl({
      text: '主动联系（主动消息）',
      tag: (pro && pro.proactive) ? '开' : '关',
      meta: '沿用聊天设置 —— 本页只展示，不接管开关'
    }));
    var auto = P ? P.autoLifeOf(char.id) : { enabled: false, updatedAt: null };
    var autoCk = checkRow('自主生活更新（允许生成推进型提案）', auto.enabled,
      '关闭时只允许「复核现有事实」，不生成离屏事件；变更记录于 ' +
      (timeText(auto.updatedAt) || '尚未设置'));
    autoCk.input.addEventListener('change', function () {
      var rec = P.setAutoLife(char.id, autoCk.input.checked);
      if (ctx.toast) ctx.toast('自主生活更新已' + (rec.enabled ? '开启' : '关闭') +
        '（' + (rec.updatedAt || '').slice(0, 10) + ' 起，不倒灌关闭期间的生活）', 'ok');
    });
    swSec.appendChild(autoCk.el);
    swSec.appendChild(rowEl({
      text: '日历写入',
      tag: '不自动',
      meta: '本轮只有用户确认后才产生动作请求，没有执行器不得当成功'
    }));
    out.appendChild(swSec);

    /* ---- 第四批：模型提案生成入口（明确入口才会调用模型）---- */
    var genSec = section('生活提案（按需生成）', '✦');
    genSec.appendChild(h('p', 'ta-meta',
      '模型只提出建议（先落「待审核提案」），你确认才生效 —— 页面打开不会调用模型。'));
    var cand0 = TM ? TM.candFor() : null;
    var busy = false;
    function genBtn(label, mode, extraKey) {
      var btn = h('button', 'ta-btn', label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (busy) return;
        if (!TM) { if (ctx.toast) ctx.toast('模型模块没就绪', 'err'); return; }
        busy = true;
        btn.textContent = '生成中…';
        TM.runMode(mode, { charId: char.id, direction: '' }, { extraKey: extraKey || '' })
          .then(function (r) {
            busy = false;
            if (!r.ok) {
              if (ctx.toast) ctx.toast(r.error || '生成失败', 'err');
            } else {
              if (ctx.toast) ctx.toast('已生成：新增 ' + (r.saved || 0) + ' 条待审核' +
                (r.duplicate ? '（去重 ' + r.duplicate + '）' : '') +
                (r.failed ? '；非法丢弃 ' + r.failed : ''), 'ok');
            }
            paintBackstage(ctx);
          });
      });
      return btn;
    }
    var genWrap = h('div', 'ta-btnrow');
    genWrap.appendChild(genBtn('复核现有事实', 'review'));
    genWrap.appendChild(genBtn('生成一轮生活提案', 'advance'));
    genSec.appendChild(genWrap);
    var candBtn = genBtn('提名 NPC 候选（至多 3 个）', 'candidates');
    candBtn.style.width = '100%';
    genSec.appendChild(candBtn);
    if (!cand0) {
      genSec.appendChild(h('p', 'ta-meta', '还没有可用的模型连接 —— 先去设置配主 API。'));
    }
    genSec.appendChild(h('p', 'ta-meta',
      '「生成一轮生活提案」需要上面的自主生活更新开关；「复核」不需要。' +
      '第五批起，已成立的影响会按「知情 × 有效 × 相关」注入 F1/F2 常驻提示词 —— 只作背景。'));
    out.appendChild(genSec);

    /* 三张表的管理列表（承诺在这里看全量，含已兑现/已解除） */
    var items = taLife ? taLife.itemsOf(char.id) : [];
    var promises = taLife ? taLife.promisesOf(char.id, user.id) : [];
    var follows = taLife ? taLife.followsOf(char.id) : [];
    backstageList(ctx, out, 'items', '一', '事项', items,
      function (r) { return String(r.title || '').trim() || '（没写标题）'; }, 'ta-item');
    backstageList(ctx, out, 'promises', '二', '承诺', promises,
      function (r) { return String(r.quote || '').trim() || '（没写原话）'; }, 'ta-promise');
    backstageList(ctx, out, 'follows', '三', '关注', follows,
      function (r) { return String(r.target || '').trim() || '（没写对象）'; }, 'ta-follow');

    /* ---- 第三批：NPC 候选草稿区（全部状态可见，confirmed 显示回执）---- */
    var dSec = section('NPC 候选草稿', '四');
    var DRAFT_LABEL = { draft: '草稿', discarded: '已舍弃', confirmed: '已转正', failed: '创建失败' };
    var drafts = taLife ? taLife.draftsOf(char.id) : [];
    drafts.forEach(function (d) {
      var dName = String(d.name || '').trim() || '（没写名字）';
      if (d.role) dName += ' · ' + d.role;
      var dTag = DRAFT_LABEL[d.status] || d.status;
      if (d.sourceType === 'model_proposal') dTag = '模型候选 · ' + dTag;   /* 来源明示，不伪装手动 */
      dSec.appendChild(rowEl({
        text: dName,
        tag: dTag,
        meta: d.status === 'confirmed'
          ? '已入库：' + String(d.formalCharId || '').slice(0, 10) + '… · ' +
            (timeText(d.confirmedAt) || '')
          : '更新于 ' + (timeText(d.updatedAt) || '未知时间'),
        onClick: function () { ctx.open('ta-draft', { id: d.id }); }
      }));
    });
    var addDraftBtn = h('button', 'ta-add-row', '＋ 新建候选草稿');
    addDraftBtn.type = 'button';
    addDraftBtn.addEventListener('click', function () {
      ctx.open('ta-draft-edit', {});
    });
    dSec.appendChild(addDraftBtn);
    if (!drafts.length) {
      dSec.appendChild(h('p', 'ta-meta',
        '还没有候选。可以在下方「生活提案」里让模型提名，或手动新建 —— 确认入库前不会出现在「身边的人」里。'));
    }
    out.appendChild(dSec);

    /* ---- 第四批：待审核提案区（未审核不进首页/召回/正式表）---- */
    if (P) P.expireStale(char.id, {
      targets: {
        items: items, follows: follows, promises: promises,
        npcs: core.npcsOfRoom ? core.npcsOfRoom(sb) : []
      },
      events: P.eventsOf(char.id)
    });
    var pending = P ? P.proposalsOf(char.id, ['pending']) : [];
    var KIND_LABEL = { item_update: '事项', follow_update: '关注', promise_review: '承诺复核', npc_event: 'NPC 事件', impact_review: '影响', contact_candidate: '联系候选' };
    var pSec2 = section('待审核提案', '五');
    if (!pending.length) {
      pSec2.appendChild(h('p', 'ta-meta', '没有待审核的提案。'));
    }
    pending.forEach(function (pp) {
      var row = h('div', 'ta-prop');
      var hi = pp.extra && pp.extra.highImpact === '1';
      row.appendChild(h('p', 'ta-prop-kind',
        (KIND_LABEL[pp.kind] || pp.kind) + ' · ' + (pp.modelMeta ? (pp.modelMeta.label + ' · ' + (pp.modelMeta.model || '')) : '') +
        (hi ? ' · 高影响' : '')));
      row.appendChild(h('p', 'ta-prop-sum', pp.summary));
      row.appendChild(h('p', 'ta-meta', '依据：' + pp.reason));
      var acts = h('div', 'ta-p-acts');
      var okB = h('button', 'ta-mini', hi ? '接受（高影响）' : '接受');
      okB.type = 'button';
      okB.addEventListener('click', function () {
        var r = P.acceptProposal(pp.id, {
          confirmHighImpact: hi,
          ctx: {
            targets: {
              items: taLife.itemsOf(char.id),
              follows: taLife.followsOf(char.id),
              promises: taLife.promisesOf(char.id, user.id)
            },
            events: P.eventsOf(char.id)
          }
        });
        if (ctx.toast) ctx.toast(r.ok ? '已接受并生效' : (r.why || '接受失败'), r.ok ? 'ok' : 'err');
        paintBackstage(ctx);
      });
      var noB = h('button', 'ta-mini ta-mini-danger', '舍弃');
      noB.type = 'button';
      noB.addEventListener('click', function () {
        P.rejectProposal(pp.id, '玩家舍弃');
        paintBackstage(ctx);
      });
      acts.appendChild(okB);
      acts.appendChild(noB);
      row.appendChild(acts);
      pSec2.appendChild(row);
    });
    if (pending.length > 1) {
      var rejAll = h('button', 'ta-add-row', '全部舍弃（' + pending.length + ' 条）');
      rejAll.type = 'button';
      rejAll.addEventListener('click', function () {
        var r = P.rejectAll(char.id, '全部舍弃');
        if (ctx.toast) ctx.toast('已舍弃 ' + r.rejected + ' 条', 'ok');
        paintBackstage(ctx);
      });
      pSec2.appendChild(rejAll);
    }
    out.appendChild(pSec2);

    /* ---- 第五批：NPC 事件与影响 ----
       两条语义必须在这一区里看得见：
       ① 更正事件 = 「事实变了」→ 影响标 stale，但 **reactedAt 与 history 保留**
          （角色当时确实有过反应，不能被更正抹掉）；
       ② 过期 / 减弱都**不是**解决 —— 只有这里手点「标记已解决」才是。
       事件成立 ≠ 角色必然受影响；没有影响就保持空。 */
    var eSec = section('NPC 事件与影响', '六');
    if (!TI) {
      eSec.appendChild(h('p', 'ta-meta', '影响层没加载（ta-impact.js）。'));
    } else {
      var rf = TI.refresh(char.id);   /* 落盘复核：只会推到 faded / expired */
      if (rf.changed) {
        eSec.appendChild(h('p', 'ta-meta',
          '本次复核推进了 ' + rf.changed + ' 条（减弱 ' + rf.faded + ' · 过期 ' + rf.expired +
          '）—— 减弱和过期都不等于解决。'));
      }
      var evs = P ? P.eventsOf(char.id) : [];
      if (!evs.length) {
        eSec.appendChild(h('p', 'ta-meta',
          '还没有已成立的 NPC 事件。事件要你在「待审核提案」里确认之后才算成立。'));
      }
      var nowTs = Date.now();
      function markResolved(im, eff) {
        return function () {
          var rr = TI.resolveImpact(im.id, '玩家在幕后标记为已解决');
          if (ctx.toast) ctx.toast(rr ? '已标记为已解决（这和「过期」是两回事）' : '这条状态不允许改',
            rr ? 'ok' : 'err');
          paintBackstage(ctx);
        };
      }
      evs.forEach(function (ev) {
        var box = h('div', 'ta-ev');
        var npc = ev.npcId && core.findChar ? core.findChar(ev.npcId) : null;
        box.appendChild(h('p', 'ta-prop-kind',
          'NPC 事件 · ' + (ev.status === 'corrected' ? '已更正（事实变了）' : '成立') +
          (npc ? ' · ' + (npc.name || '未命名') : '')));
        box.appendChild(h('p', 'ta-prop-sum', String(ev.text || '（没有内容）')));
        var meta = '发生于 ' + (timeText(ev.happenedAt) || '未知时间');
        if (ev.correctedAt) {
          meta += ' · 更正于 ' + (timeText(ev.correctedAt) || '时间未知') +
            (ev.correctNote ? '（' + ev.correctNote + '）' : '');
        }
        box.appendChild(h('p', 'ta-meta', meta));

        var ims = TI.impactsOf(char.id).filter(function (x) { return x.eventRef === ev.id; });
        if (!ims.length) {
          box.appendChild(h('p', 'ta-meta',
            '这件事还没有成立的影响 —— 事件成立不等于角色必然受影响。'));
        }
        ims.forEach(function (im) {
          var eff = TI.effectiveOf(im, nowTs);
          var acts = [];
          if (eff.status !== 'resolved') {
            acts.push({ label: '标记已解决', onClick: markResolved(im, eff) });
          }
          box.appendChild(impactRow(im, eff, acts));
        });

        if (ev.status !== 'corrected') {
          var corB = h('button', 'ta-mini ta-mini-danger', '更正这件事（事实变了）');
          corB.type = 'button';
          corB.addEventListener('click', function () {
            var rr = TI.correctEvent(ev.id, '玩家更正了这件事');
            if (ctx.toast) {
              ctx.toast(rr.ok
                ? '已更正：' + rr.marked + ' 条影响依据失效（角色当时的反应保留）'
                : (rr.why || '更正失败'), rr.ok ? 'ok' : 'err');
            }
            paintBackstage(ctx);
          });
          var cActs = h('div', 'ta-p-acts');
          cActs.appendChild(corB);
          box.appendChild(cActs);
        }
        eSec.appendChild(box);
      });

      /* 已接受的联系候选：进的是现有主动消息队列，ta 侧只记结果。
         「只生成候选，不直接发送」—— 这里看到的 outcome 就是引擎判断后的回执。 */
      var cps = TI.contactProposals(char.id);
      if (cps.length) {
        eSec.appendChild(h('p', 'ta-prop-kind', '主动联系候选（走现有主动消息判断，不直接发送）'));
        cps.forEach(function (cp) {
          var oc = cp.outcome;
          var line = oc
            ? (oc.decision === 'send' ? '已由主动消息发出' : '判断结果：' + oc.decision)
            : '还没有结果（等现有主动消息闸门）';
          eSec.appendChild(h('p', 'ta-meta',
            '· ' + String(cp.summary || '') + ' —— ' + line +
            (oc && oc.at ? '（' + (timeText(oc.at) || '') + '）' : '')));
        });
      }
    }
    out.appendChild(eSec);

    out.appendChild(h('p', 'ta-foot',
      '模型提案未经你确认不会改变任何正式记录；' +
      '未确认的提案不会进聊天，已成立的影响也只按知情边界注入。'));
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

  /* ---------------------------- 承诺详情 ----------------------------
     设计稿 §1：原话、对象、条件、完成标准、当前证据、待核实原因。
     状态只能人手改（statusSelect），没有任何「事项完成 → 兑现」的通路。 */
  Sleepy.register('ta-promise', {
    title: '承诺',
    render: function (ctx) { paintPromise(ctx); },
    onShow: function (ctx) { paintPromise(ctx); }
  });

  function paintPromise(ctx) {
    var p = ctx.params || {};
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var rec = (taLife && p.id) ? taLife.findInScope('promises', p.id) : null;
    var sec = section('承诺详情', '·');
    if (rec) {
      sec.appendChild(quoteBlock('「' + (String(rec.quote || '').trim() || '（没写原话）') + '」',
        '更新于 ' + (timeText(rec.updatedAt) || '未知时间')));
      sec.appendChild(statusSelect(ctx, 'promises', rec, function () { paintPromise(ctx); }));
      labelLines(sec, [
        ['对象', rec.toWhom],
        ['条件', rec.condition],
        ['完成标准', rec.standard],
        ['当前证据', rec.evidence],
        ['待核实原因', rec.pendingWhy],
        ['来处', rec.sourceRef || (rec.sourceType === 'manual' ? '手动记下' : rec.sourceType)]
      ], true);
      var hb = histBlock(rec);
      if (hb) sec.appendChild(hb);
      sec.appendChild(h('p', 'ta-meta',
        '承诺兑现只能由人在这里手动确认 —— 事项完成、日历走完都不会自动兑现它。'));
      sec.appendChild(actionRow(ctx, 'promises', rec, function () { paintPromise(ctx); }));
    } else {
      sec.appendChild(h('p', 'we-none', '暂无更多已确认信息。'));
    }
    out.appendChild(sec);
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

  /* ---------------------------- NPC 候选草稿（第三批） ----------------------------
   * 草稿是独立数据（taNpcDrafts），确认入库前**不进** characters 表 ——
   * 正式名册 / 聊天召回 / 日程 / 生活推进读的都是正式表，天然隔离。
   * 确认 = 三个独立授权（存在 / user 认识 / 允许自主发展）+ 调既有
   * core.upsertChar；重试幂等（回执 formalCharId 在，就不再建）。
   * 本轮候选全部由玩家手动录入，页面明说「草稿 / 示例」，不伪装 AI 生成。 */

  var DRAFT_FIELDS = [
    { k: 'name', label: '名字（必填）', type: 'text' },
    { k: 'role', label: '身份 / 角色（如：楼下修表匠）', type: 'text' },
    { k: 'personality', label: '性格（可选）', type: 'area', rows: 2 },
    { k: 'interactionStyle', label: '相处方式（可选）', type: 'area', rows: 2 },
    { k: 'meetingOpportunity', label: '相识来由（可选）', type: 'area', rows: 2 },
    { k: 'reasonToStayConnected', label: '为什么留在身边（可选）', type: 'area', rows: 2 },
    { k: 'closenessAndBoundary', label: '亲疏与边界（可选）', type: 'area', rows: 2 },
    { k: 'ownLife', label: '他自己的生活（可选）', type: 'area', rows: 2 },
    { k: 'currentThreadProposal', label: '当前线索（可选）', type: 'area', rows: 2 }
  ];
  var DRAFT_LABELS = { draft: '草稿', discarded: '已舍弃', confirmed: '已转正', failed: '创建失败' };

  function checkRow(label, checked, hint) {
    /* hint 是独立的一行（放同一个 flex 里会把文字挤成竖排 —— 第四批复核抓到） */
    var wrap = h('div', 'ta-checkwrap');
    var row = h('label', 'ta-check');
    var inp = h('input', '');
    inp.type = 'checkbox';
    inp.checked = !!checked;
    row.appendChild(inp);
    row.appendChild(h('span', 'ta-check-tx', label));
    wrap.appendChild(row);
    if (hint) wrap.appendChild(h('p', 'ta-meta', hint));
    return { el: wrap, input: inp };
  }

  /* 草稿编辑页（新建 / 编辑共用）。freshOnOpen：每次 open 全新 render，
     避免「同参短路」把上一次填了一半的表单端回来（app.js:424 那条坑）。 */
  Sleepy.register('ta-draft-edit', {
    title: '候选草稿',
    freshOnOpen: true,
    render: function (ctx) { paintDraftEdit(ctx); },
    onShow: function (ctx) { paintDraftEdit(ctx); }
  });

  function paintDraftEdit(ctx) {
    var p = ctx.params || {};
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    if (!core.activeSandbox() || !core.activeCharOnIsland() || !core.activeUserOnIsland()) {
      out.appendChild(empty(ctx, '未落岛 / 未选角色',
        '候选草稿跟着当前身份走 —— 先落岛选人。'));
      return;
    }
    var existing = p.id ? taLife.findDraftInScope(p.id) : null;

    var sec = section(existing ? '编辑候选草稿' : '新建候选草稿', '·');
    sec.appendChild(h('p', 'ta-meta',
      '这是候选草稿：确认入库前不会出现在「身边的人」、聊天召回或任何生活推进里。'));
    var box = h('div', '');
    DRAFT_FIELDS.forEach(function (f) {
      var pre = existing ? existing[f.k] : '';
      var ctl = (f.type === 'area')
        ? ui.textArea({ label: f.label, rows: f.rows || 2, value: pre })
        : ui.textField({ label: f.label, value: pre });
      ctl.__k = f.k;
      box.appendChild(ctl.el);
    });
    sec.appendChild(box);
    out.appendChild(sec);

    var saveBtn = ui.button(existing ? '保存修改' : '存为草稿', 'primary');
    out.appendChild(saveBtn);
    saveBtn.addEventListener('click', function () {
      var payload = {};
      var name = '';
      var ctrls = [];
      Array.prototype.forEach.call(box.children, function (child) {
        var inp = child.querySelector ? child.querySelector('.set-input, .set-textarea') : null;
        if (inp) ctrls.push(inp);
      });
      DRAFT_FIELDS.forEach(function (f, i) {
        var v = ctrls[i] ? String(ctrls[i].value || '').trim() : '';
        if (v) payload[f.k] = v;
        if (f.k === 'name' && v) name = v;
      });
      if (!name) {
        if (ctx.toast) ctx.toast('名字还没填', 'err');
        return;
      }
      var char = core.activeCharOnIsland();
      var user = core.activeUserOnIsland();
      payload.refCharId = char ? char.id : null;
      payload.refUserId = user ? user.id : null;
      if (existing) {
        taLife.patchDraft(existing.id, payload);
        if (ctx.toast) ctx.toast('草稿已保存', 'ok');
      } else {
        var made = taLife.addDraft(payload);
        if (!made) {
          if (ctx.toast) ctx.toast('草稿没存上（没有当前岛）', 'err');
          return;
        }
        if (ctx.toast) ctx.toast('已存为草稿 —— 确认入库前不会成为正式人物', 'ok');
      }
      if (typeof ctx.back === 'function') ctx.back();
    });
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

  /* 草稿详情：字段全陈列 + 状态操作 + 确认入库（三授权独立勾选）。 */
  Sleepy.register('ta-draft', {
    title: '候选草稿',
    render: function (ctx) { paintDraft(ctx); },
    onShow: function (ctx) { paintDraft(ctx); }
  });

  function paintDraft(ctx) {
    var p = ctx.params || {};
    var body = ctx.body;
    body.innerHTML = '';
    var out = h('div', 'we-page-paper');
    body.insertBefore(out, body.firstChild);

    var d = p.id ? taLife.findDraftInScope(p.id) : null;
    var sec = section('候选草稿', '·');
    if (!d) {
      sec.appendChild(h('p', 'we-none', '暂无更多已确认信息。'));
      out.appendChild(sec);
      return;
    }

    sec.appendChild(quoteBlock(String(d.name || '').trim() || '（没写名字）',
      (DRAFT_LABELS[d.status] || d.status) + ' · 更新于 ' + (timeText(d.updatedAt) || '未知时间')));
    labelLines(sec, [
      ['身份 / 角色', d.role],
      ['性格', d.personality],
      ['相处方式', d.interactionStyle],
      ['相识来由', d.meetingOpportunity],
      ['为什么留在身边', d.reasonToStayConnected],
      ['亲疏与边界', d.closenessAndBoundary],
      ['他自己的生活', d.ownLife],
      ['当前线索', d.currentThreadProposal],
      ['来处', d.sourceRef || (d.sourceType === 'manual' ? '手动录入（示例 / 草稿，非 AI 生成）' : d.sourceType)]
    ], true);
    var hb = histBlock(d);
    if (hb) sec.appendChild(hb);

    if (d.status === 'confirmed') {
      /* 回执：入库成功的事实凭据 */
      var rc = section('入库回执', '·');
      rc.appendChild(quoteBlock('已转正为正式 NPC',
        '确认于 ' + (timeText(d.confirmedAt) || '未知时间')));
      labelLines(rc, [
        ['正式人物 ID', d.formalCharId],
        ['故事内 user 认识', d.userKnowsInStory ? '认识（已建关系）' : '不认识（未建关系）'],
        ['允许自主发展', d.autonomousDevelopmentAllowed ? '允许' : '不允许'],
        ['关系建立', d.linkMade ? '已建立' : '未建立']
      ], true);
      var goBtn = h('button', 'ta-btn', '去看正式人物');
      goBtn.type = 'button';
      goBtn.addEventListener('click', function () {
        ctx.open('ta-person', { id: d.formalCharId });
      });
      var goWrap = h('div', 'ta-btnrow');
      goWrap.appendChild(goBtn);
      rc.appendChild(goWrap);
      out.appendChild(sec);
      out.appendChild(rc);
      try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
      return;
    }

    /* 确认区：draft / failed 可确认；三个授权独立勾选，缺「确认存在」不放行 */
    var cf = section('确认入库', '·');
    cf.appendChild(h('p', 'ta-meta',
      '确认前他只是玩家侧的草稿 —— 正式入库调用既有创建链路，成功后才会出现在「身边的人」。'));
    var ckExists = checkRow('确认这个 NPC 存在（成为正式人物）', d.existsConfirmed);
    var ckUser = checkRow('故事内 user 认识他', d.userKnowsInStory);
    var ckAuto = checkRow('允许低风险自主发展', d.autonomousDevelopmentAllowed,
      '本轮只是记录授权，生活推进本身第四批才接入');
    cf.appendChild(ckExists.el);
    cf.appendChild(ckUser.el);
    cf.appendChild(ckAuto.el);
    if (d.status === 'failed') {
      cf.appendChild(h('p', 'ta-meta', '上次创建失败 —— 草稿还在，可以直接重试，不会重复创建。'));
    }
    var okBtn = h('button', 'ta-btn', '确认入库');
    okBtn.type = 'button';
    okBtn.addEventListener('click', function () {
      var r = taLife.confirmDraft(d.id, {
        existsConfirmed: ckExists.input.checked,
        userKnowsInStory: ckUser.input.checked,
        autonomousDevelopmentAllowed: ckAuto.input.checked
      });
      if (ctx.toast) ctx.toast(r.ok ? (r.dup ? '他已经是正式人物了（不重复创建）' : '已确认入库') : r.why, r.ok ? 'ok' : 'err');
      if (r.ok) paintDraft(ctx);
    });
    var okWrap = h('div', 'ta-btnrow');
    okWrap.appendChild(okBtn);
    cf.appendChild(okWrap);
    out.appendChild(sec);
    out.appendChild(cf);

    /* 状态操作：保留（不动）/ 舍弃 / 重新打开 / 删除 */
    var opSec = section('草稿操作', '·');
    var opWrap = h('div', 'ta-btnrow');
    if (d.status === 'discarded') {
      var reBtn = h('button', 'ta-btn', '重新打开');
      reBtn.type = 'button';
      reBtn.addEventListener('click', function () {
        taLife.setDraftStatus(d.id, 'draft', '重新打开');
        paintDraft(ctx);
      });
      opWrap.appendChild(reBtn);
    } else {
      var disBtn = h('button', 'ta-btn', '舍弃（可重新打开）');
      disBtn.type = 'button';
      disBtn.addEventListener('click', function () {
        taLife.setDraftStatus(d.id, 'discarded', '玩家舍弃');
        paintDraft(ctx);
      });
      opWrap.appendChild(disBtn);
    }
    var del = h('button', 'ta-btn ta-btn-danger', '删除');
    del.type = 'button';
    var armed = false;
    del.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        del.textContent = '再点一次确认删除';
        return;
      }
      if (taLife.removeDraft(d.id)) {
        if (ctx.toast) ctx.toast('草稿已删除', 'ok');
        if (typeof ctx.back === 'function') ctx.back();
      }
    });
    opWrap.appendChild(del);
    opSec.appendChild(opWrap);
    out.appendChild(opSec);
    try { body.scrollTop = 0; } catch (e) { /* 桩环境没有 */ }
  }

})(window);
