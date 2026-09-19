/* ============================================================
   calendar.js — 日历数据层（模块：时间事实）

   定位（《日历系统 · 产品与实施总纲 v1》§1）：
   日历是 Sleepy 里与「时间」有关的**统一事实来源**。它不是一张静态资料页。
   三层数据：
     ① 公共日期层  —— 内置离线数据（calendar-data.js），char 改不了
     ② 角色生活日程层 —— 按 char 独立，受「生成角色日程」开关控制
     ③ 留痕纪念日层 —— 与记忆系统双向绑定，**不随开关关闭**

   ---- 红线 ----
   · 打开日历 / 翻月 / 看事件 / 新建提醒 **一律 0 次模型调用**（总纲 §13.1）。
     本文件里没有任何 api.* 引用，以后也不许有。
   · 按 char 隔离（总纲 §0.4）：配置表与事件表都以 charId 为键之一，
     并且照项目规矩盖 sandboxId（core.tagScope），删房跟着清。
   · 关闭「生成角色日程」**不等于删除**（§6.3）：只停止后续生成与注入，
     历史数据、user 提醒、共同事件、纪念日一律保留。
   · 删除与取消分开（§7.3）：取消保留历史（它还会影响记忆与关系）。

   依赖：store.js、core.js、calendar-data.js
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var DATA = Sleepy.calendarData;

  function core() { return Sleepy.core; }

  var KEY_CFG = 'calConfigs';   /* [{ id, sandboxId, charId, ...配置 }] */
  var KEY_EVT = 'calEvents';    /* [{ id, sandboxId, ownerCharId, ...事件 }] */

  /* ---------------------------- 工具 ---------------------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function newId(p) {
    return (p || 'ce') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* 'YYYY-MM-DD'。**一律走本地时间构造**，不要用 new Date(str) ——
     'YYYY-MM-DD' 被当成 UTC 解析，东八区会整体退一天
     （项目里 page-phone / 日记都栽在同一个坑上）。 */
  function isoOf(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function parseISO(iso) {
    var p = String(iso || '').split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function todayISO() { return isoOf(new Date()); }
  function shiftISO(iso, days) {
    return isoOf(new Date(parseISO(iso).getTime() + days * 86400000));
  }
  /* 时间部分：'YYYY-MM-DDTHH:MM' → 'HH:MM'；全天事件返回 '' */
  function timeOf(startAt) {
    var s = String(startAt || '');
    return s.length > 10 ? s.slice(11, 16) : '';
  }
  function dateOf(startAt) { return String(startAt || '').slice(0, 10); }
  function at(date, time) { return time ? date + 'T' + time : date; }

  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
  var MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];

  function weekdayOf(iso) { return parseISO(iso).getDay(); }
  function isWeekend(iso) {
    var w = weekdayOf(iso);
    return w === 0 || w === 6;
  }
  function monthLabel(m) { return MONTH_CN[m] || ''; }

  /* ---------------------------- 常驻地点 ----------------------------

     2026-09-19 用户：「选择那边的 char，时间喂给 char 的也要是那样才对，
     或者我们加一个字段是目前常驻地点什么的？」

     定稿：**常驻地点挂在 char 身上**（`char.city` / `char.region` / `char.timezone`），
     不另建一张表。理由：它描述的是「这个人现在在哪儿」，不只是日历的设置 ——
     日历地区、时区、以后的语言档都从这同一个字段推。
     三个下游读同一处，才不会出现「日历写东京、聊天以为在上海」。

     ⚠️ 用 `rootOf` 而不是 findChar：常驻地点属于**这个人**，
     皮套（小号）只是他对外的一个身份，不该各有一份所在地。 */
  function placeOf(charId) {
    var out = { city: '', region: '', timezone: '' };
    if (!charId || !core()) return out;
    var ch = null;
    try { ch = core().rootOf(charId) || core().findChar(charId); } catch (e) { ch = null; }
    if (!ch) return out;
    out.city = String(ch.city || '').trim();
    out.region = String(ch.region || '').trim();
    out.timezone = String(ch.timezone || '').trim();
    return out;
  }

  /* 常驻地点的显示名：优先他自己填的城市，否则用时区表里那个地名 */
  function placeLabel(charId, cfg) {
    var p = placeOf(charId);
    if (p.city) return p.city;
    var tz = (cfg && cfg.timezone) || p.timezone;
    return (DATA.TZ_LABELS && DATA.TZ_LABELS[tz]) || tz || '未设置';
  }

  /* 他说哪国话 —— **从常驻地点推**，不另开设置项。
     zh 那一支返回 same:true，表示「跟 user 同一种语言，不用翻译」。 */
  function langOf(charId) {
    var cfg = cfgOf(charId);
    var code = (DATA.REGION_LANG && DATA.REGION_LANG[cfg.region]) || 'zh';
    return (DATA.LANGS && DATA.LANGS[code]) || { code: 'zh', name: '中文', same: true };
  }

  /* 翻译开关：全局的 user 偏好（不是每条对话一份）——
     它管的是「我要不要看译文」，跟具体跟谁聊没关系。 */
  var KEY_TRANS = 'translateOn';
  function translateOn() { return store.get(KEY_TRANS) !== false; }
  function setTranslateOn(on) { store.set(KEY_TRANS, !!on); return !!on; }

  /* ---------------------------- 每个 char 的配置 ----------------------------

     总纲 §0.4：每个 char 拥有独立的日历数据、设置、地区、日程开关和纪念日权限。
     两层来源，**顺序要紧**：
       ① 常驻地点（char 身上的字段）—— 天然默认，改了常驻地点日历就跟着走
       ② 日历里的显式覆盖（calConfigs 那条记录）—— 用户在日历设置里动过的
     所以优先级是「先铺地点、再盖记录」，而不是反过来。
     没有存档时返回默认值的副本并且**不写盘** —— user 没动过的东西不该凭空产生数据。 */
  var DEFAULT_CFG = {
    region: 'CN',              /* 法定日历：CN/JP/KR/US/UK/NONE */
    cultures: ['cn', 'intl'],  /* 文化节日多选（总纲 §4.2） */
    timezone: 'Asia/Shanghai',
    scheduleOn: false,         /* 生成角色日程。§6.4：默认关闭，由 user 主动开 */
    anniversaryPerm: 'ask',    /* off | ask | auto，默认「保存前询问」§10.3 */
    remindOn: true             /* 本地提醒开关 */
  };
  /* 会被「常驻地点」带默认值的两个键 —— 「恢复跟随他的常驻地」就是把这俩删掉 */
  var PLACE_KEYS = ['region', 'timezone'];

  function cfgRec(charId) {
    var list = store.get(KEY_CFG);
    if (!Array.isArray(list)) list = [];
    var sid = core() ? core().scopeId() : null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || r.charId !== charId) continue;
      if (sid && r.sandboxId !== sid) continue;
      return r;
    }
    return null;
  }

  function cfgOf(charId) {
    var out = {};
    for (var k in DEFAULT_CFG) if (DEFAULT_CFG.hasOwnProperty(k)) out[k] = DEFAULT_CFG[k];
    /* ① 常驻地点 */
    var place = placeOf(charId);
    if (place.region) out.region = place.region;
    if (place.timezone) out.timezone = place.timezone;
    /* ② 日历里的覆盖 */
    var rec = cfgRec(charId);
    if (rec) {
      for (var k2 in DEFAULT_CFG) {
        if (rec[k2] !== undefined && rec[k2] !== null) out[k2] = rec[k2];
      }
    }
    if (!out.cultures) out.cultures = [];
    return out;
  }

  /* 这两个键是不是「被日历显式改过」（而不是跟着常驻地点走的） */
  function overridden(charId) {
    var rec = cfgRec(charId);
    var out = {};
    PLACE_KEYS.forEach(function (k) {
      out[k] = !!(rec && rec[k] !== undefined && rec[k] !== null && rec[k] !== '');
    });
    return out;
  }

  /* 写配置。⚠️ 必须拿**全量**列表改那一条再落盘 —— 用过滤过的列表回写
     会把别的房/别的 char 的记录抹掉（page-wallet 那节记过同一个坑）。 */
  function saveCfg(charId, patch) {
    var all = store.get(KEY_CFG);
    if (!Array.isArray(all)) all = [];
    var sid = core() ? core().scopeId() : null;
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r || r.charId !== charId) continue;
      if (sid && r.sandboxId !== sid) continue;
      for (var k in patch) if (patch.hasOwnProperty(k)) r[k] = patch[k];
      r.updatedAt = Date.now();
      store.set(KEY_CFG, all);
      return r;
    }
    var rec = { id: newId('cc'), charId: charId, createdAt: Date.now(), updatedAt: Date.now() };
    for (var k2 in patch) if (patch.hasOwnProperty(k2)) rec[k2] = patch[k2];
    if (core()) core().tagScope(rec);
    all.push(rec);
    store.set(KEY_CFG, all);
    return rec;
  }

  /* 「恢复跟随他的常驻地」：把 region/timezone 两个键从记录里摘掉。
     摘完记录空了就把整条删掉 —— 留一条只有时间戳的空记录，日后排查会以为是脏数据。 */
  function resetToPlace(charId) {
    var all = store.get(KEY_CFG);
    if (!Array.isArray(all)) return null;
    var sid = core() ? core().scopeId() : null;
    var kept = [];
    var touched = null;
    all.forEach(function (r) {
      if (!r || r.charId !== charId) { kept.push(r); return; }
      if (sid && r.sandboxId !== sid) { kept.push(r); return; }
      PLACE_KEYS.forEach(function (k) { delete r[k]; });
      var rest = Object.keys(r).filter(function (k) {
        return ['id', 'charId', 'sandboxId', 'createdAt', 'updatedAt'].indexOf(k) < 0;
      });
      if (rest.length) { r.updatedAt = Date.now(); kept.push(r); touched = r; }
      else touched = null;   /* 空记录丢掉 */
    });
    store.set(KEY_CFG, kept);
    return touched;
  }

  function regionMeta(id) {
    for (var i = 0; i < DATA.REGIONS.length; i++) {
      if (DATA.REGIONS[i].id === id) return DATA.REGIONS[i];
    }
    return DATA.REGIONS[0];
  }
  function cultureMeta(id) {
    for (var i = 0; i < DATA.CULTURE_GROUPS.length; i++) {
      if (DATA.CULTURE_GROUPS[i].id === id) return DATA.CULTURE_GROUPS[i];
    }
    return null;
  }

  /* ---------------------------- 公共日期层 ----------------------------

     dayInfo(iso, cfg) 返回：
       {
         date, weekday,
         legal:   { name, kind, tag } | null,   // 法定层
         festivals: [{ name, group, soft }],    // 文化层
         isDayOff, isWorkday,
         builtin: true/false,                   // 该年度有没有内置数据
         notes: [ '…' ]                         // 降级 / 缺数据的如实说明
       }

     kind 取值（总纲 §5.3 要求五类必须分得开）：
       legal_off            法定放假日（含调休出来的休息日）
       weekend              普通周末（也可能正好落在假期区间里）
       workday_adjustment   周末补班日 —— 这一条是「不许把补班当普通周末」的落点
     */
  var yearCache = {};

  function buildYear(year, cfg) {
    var ck = year + '|' + (cfg.region || 'CN');
    var hit = yearCache[ck];
    if (hit) return hit;

    var idx = { off: {}, work: {}, festivals: {}, builtin: true, notes: [] };
    var region = regionMeta(cfg.region);

    /* ---- 法定层 ---- */
    if (region.id === 'NONE') {
      idx.builtin = false;
    } else if (region.id === 'CN') {
      var table = DATA.CN_OFFICIAL[year];
      if (!table) {
        /* 总纲 §19.1：超出内置年份就如实降级，不伪造调休安排 */
        idx.builtin = false;
        idx.notes.push('该年度未内置法定节假日数据（中国大陆官方安排尚未公布时不猜）');
      } else {
        table.holidays.forEach(function (h) {
          var cur = h.from;
          while (cur <= h.to) {
            if (isWeekend(cur)) {
              /* 落在假期区间里的自然周末：休息，但它不是「调休出来的」 */
              idx.off[cur] = { name: h.name, kind: 'weekend', tag: '休' };
            } else {
              idx.off[cur] = { name: h.name, kind: 'legal_off', tag: '休' };
            }
            cur = shiftISO(cur, 1);
          }
          h.workdays.forEach(function (w) {
            idx.work[w] = { name: h.name + '调休上班', kind: 'workday_adjustment', tag: '班' };
          });
        });
        idx.source = table.source;
        idx.note = table.note;
      }
    } else {
      /* 规则型区域：规则本身就是内置数据，年份不限 */
      var rules = DATA.REGION_RULES[region.id];
      if (rules) {
        rules.holidays(year).forEach(function (h) {
          if (!h.date) return;
          idx.off[year + '-' + h.date] = { name: h.name, kind: 'legal_off', tag: '休' };
        });
      }
    }

    /* ---- 文化层 ---- */
    (cfg.cultures || []).forEach(function (gid) {
      var g = cultureMeta(gid);
      if (!g) return;
      if (g.builtinYears && g.builtinYears.indexOf(year) < 0) {
        if (idx.notes.indexOf('该年度未内置农历节日日期') < 0) {
          idx.notes.push('该年度未内置农历节日日期');
        }
        return;
      }
      g.items(year).forEach(function (it) {
        var k = it.date.indexOf('-') === 2 ? year + '-' + it.date : it.date;
        if (!idx.festivals[k]) idx.festivals[k] = [];
        idx.festivals[k].push({ name: it.name, group: g.label, soft: !!it.soft });
      });
    });

    yearCache[ck] = idx;
    return idx;
  }

  function clearCache() { yearCache = {}; }

  function dayInfo(iso, cfg) {
    cfg = cfg || DEFAULT_CFG;
    var year = Number(String(iso).slice(0, 4));
    var idx = buildYear(year, cfg);
    var legal = idx.off[iso] || idx.work[iso] || null;
    var isWork = iso in idx.work;
    var off = !!idx.off[iso];
    var weekend = isWeekend(iso);
    /* ⚠️ 「周末补班」优先级最高：它落在周六/周日上，但**这天要上班**。
       不特判的话 isDayOff = weekend = true，补班日就被当成休息日了 ——
       总纲 §5.3 那条红线，冒烟桩当场抓到过一次。 */
    var isDayOff = isWork ? false : (off || weekend);
    var isWorkday = isWork ? true : (!off && !weekend);
    return {
      date: iso,
      day: Number(String(iso).slice(8, 10)),
      weekday: weekdayOf(iso),
      weekdayText: '星期' + WEEK_CN[weekdayOf(iso)],
      legal: legal,
      festivals: idx.festivals[iso] || [],
      isDayOff: isDayOff,
      isWorkday: isWorkday,
      builtin: idx.builtin,
      notes: idx.notes || [],
      source: idx.source || null
    };
  }

  /* 42 格月历（含前后补位）。muted = 不属于本月。 */
  function monthGrid(year, month) {
    var first = new Date(year, month, 1).getDay();
    var count = new Date(year, month + 1, 0).getDate();
    var prevCount = new Date(year, month, 0).getDate();
    var cells = [];
    var i;
    for (i = first - 1; i >= 0; i--) {
      var pd = new Date(year, month - 1, prevCount - i);
      cells.push({ date: isoOf(pd), day: prevCount - i, muted: true });
    }
    for (i = 1; i <= count; i++) {
      cells.push({ date: isoOf(new Date(year, month, i)), day: i, muted: false });
    }
    var tail = 42 - cells.length;
    for (i = 1; i <= tail; i++) {
      cells.push({ date: isoOf(new Date(year, month + 1, i)), day: i, muted: true });
    }
    return cells;
  }

  /* ---------------------------- 事件层 ---------------------------- */

  function allEvents() {
    var list = store.get(KEY_EVT);
    return Array.isArray(list) ? list : [];
  }

  /* 当前房 + 指定 char 的事件（含 user 自己的提醒与共同事件）。 */
  function eventsOf(charId) {
    var sid = core() ? core().scopeId() : null;
    return allEvents().filter(function (e) {
      if (!e) return false;
      if (sid && e.sandboxId !== sid) return false;
      if (e.ownerCharId === charId) return true;
      /* 共同事件用同一个对象关联双方（§8.4），user 建的也要能看见 */
      return (e.participants || []).some(function (p) { return p && p.id === charId; });
    });
  }

  /* 这条事件在 iso 这天有没有发生（含重复规则展开）。
     status='cancelled' 的**照常返回**（历史要留），由调用方按状态显示。 */
  function occursOn(e, iso) {
    var d0 = dateOf(e.startAt);
    if (!e.repeatRule) return d0 === iso;
    if (iso < d0) return false;
    if (e.repeatRule === 'yearly') {
      return iso.slice(5) === d0.slice(5);
    }
    if (e.repeatRule === 'weekly') {
      return weekdayOf(iso) === weekdayOf(d0);
    }
    if (e.repeatRule === 'monthly') {
      return iso.slice(8) === d0.slice(8);
    }
    /* yearly_lunar 第一版不展开（§10.6：农历重复必须有可靠本地库，
       本项目还没有）—— 只保留原始那一天，不假装能算。 */
    return d0 === iso;
  }

  function eventsOn(charId, iso) {
    return eventsOf(charId)
      .filter(function (e) { return occursOn(e, iso); })
      .sort(function (a, b) {
        var at = timeOf(a.startAt) || '99:99';
        var bt = timeOf(b.startAt) || '99:99';
        return at < bt ? -1 : (at > bt ? 1 : 0);
      });
  }

  /* 时间重叠检测（§12.6：程序做确定性判断，模型不负责算时间）。
     已取消的事件**不占用时间**；只显示忙碌的也照样参与。 */
  function conflictOf(charId, draft) {
    var iso = dateOf(draft.startAt);
    var s = timeOf(draft.startAt) || '00:00';
    var e2 = draft.endAt ? (timeOf(draft.endAt) || '23:59') : (draft.allDay ? '23:59' : s);
    return eventsOn(charId, iso).filter(function (e) {
      if (e.id === draft.id) return false;
      if (e.status === 'cancelled') return false;
      var es = timeOf(e.startAt) || '00:00';
      var ee = e.endAt ? (timeOf(e.endAt) || '23:59') : (e.allDay ? '23:59' : es);
      return s < ee && es < e2;
    });
  }

  function addEvent(rec) {
    var all = allEvents();
    var iso = todayISO();
    var ev = {
      id: rec.id || newId('ev'),
      ownerCharId: rec.ownerCharId || null,
      eventType: rec.eventType || 'user_reminder',
      title: String(rec.title || '').trim(),
      desc: rec.desc || '',
      startAt: rec.startAt,
      endAt: rec.endAt || '',
      timezone: rec.timezone || '',
      allDay: !!rec.allDay,
      status: rec.status || 'confirmed',
      tentative: !!rec.tentative,
      createdBy: rec.createdBy || { type: 'user', id: 'user' },
      participants: rec.participants || [],
      visibility: rec.visibility || 'private',
      deviceProtection: rec.deviceProtection || 'none',
      sourceType: rec.sourceType || 'manual',
      sourceIds: rec.sourceIds || [],
      memoryId: rec.memoryId || null,
      meaningType: rec.meaningType || null,
      repeatRule: rec.repeatRule || null,
      cancelReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    if (core()) core().tagScope(ev);
    all.push(ev);
    store.set(KEY_EVT, all);
    return ev;
  }

  function getEvent(id) {
    var list = allEvents();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /* 改事件：保留修改痕迹（§12.5 要求原时间/新时间/修改者/原因留档）。
     第一版把 history 挂在事件上，界面上只显示一条「改过」。 */
  function updateEvent(id, patch, reason) {
    var all = allEvents();
    for (var i = 0; i < all.length; i++) {
      if (!all[i] || all[i].id !== id) continue;
      var e = all[i];
      e.history = e.history || [];
      e.history.push({
        at: Date.now(),
        from: e.startAt,
        to: patch.startAt || e.startAt,
        reason: reason || ''
      });
      for (var k in patch) if (patch.hasOwnProperty(k)) e[k] = patch[k];
      e.updatedAt = Date.now();
      store.set(KEY_EVT, all);
      return e;
    }
    return null;
  }

  /* 取消 ≠ 删除（§7.3）。取消保留历史：它可能继续影响记忆与关系。 */
  function cancelEvent(id, reason) {
    return updateEvent(id, { status: 'cancelled', cancelReason: reason || '' });
  }

  /* 删除只许删「误创建 / 重复 / 没意义的草稿」。
     有现实意义的安排一律走取消 —— 所以这里对已确认的共同事件直接拒绝，
     免得以后某个入口手滑把它抹掉。 */
  function removeEvent(id) {
    var ev = getEvent(id);
    if (!ev) return { ok: false, message: '找不到这条日程' };
    if (ev.eventType === 'shared_event' && ev.status !== 'pending') {
      return { ok: false, message: '已经成立过的共同安排只能取消，不能删除' };
    }
    if (ev.memoryId) {
      return { ok: false, message: '这条和留痕绑在一起，去留痕里处理' };
    }
    store.set(KEY_EVT, allEvents().filter(function (x) { return !x || x.id !== id; }));
    return { ok: true };
  }

  /* 关闭「生成角色日程」时要清的那一批（§6.3）。
     **手动告诉 user 会清什么**：只清 char 自动生成的生活日程；
     公共日期、user 提醒、共同事件、纪念日一律不碰。 */
  function clearGenerated(charId) {
    var keep = allEvents().filter(function (e) {
      if (!e) return false;
      var sid = core() ? core().scopeId() : null;
      if (sid && e.sandboxId !== sid) return true;
      if (e.ownerCharId !== charId) return true;
      return e.eventType !== 'char_schedule';
    });
    var gone = allEvents().length - keep.length;
    store.set(KEY_EVT, keep);
    return gone;
  }

  /* 未来 N 天里发生的事（供「临近事项」与日后的主动消息候选） */
  function upcoming(charId, days, fromISO) {
    var start = fromISO || todayISO();
    var out = [];
    for (var i = 0; i <= (days || 30); i++) {
      var iso = shiftISO(start, i);
      eventsOn(charId, iso).forEach(function (e) {
        if (e.status === 'cancelled' || e.status === 'completed') return;
        out.push({ date: iso, event: e, inDays: i });
      });
    }
    return out;
  }

  /* ---------------------------- 留痕纪念日层 ----------------------------

     纪念日必须**绑定来源记忆**（§10:16-17），所以候选只从记忆库里挑，
     不在这里凭空造。第一版候选 = 被 user 标成「锚点」(isAnchor) 的条目 ——
     那正是「值得反复回到的时刻」的现有信号。
     写入时建立 calendarEventId ↔ memoryId 双向引用（§10.4）。 */
  function memoryFile(charId) {
    var ms = Sleepy.memoryStore;
    if (ms && ms.loadCharMemory) {
      try { return ms.loadCharMemory(charId) || { memories: [] }; } catch (e) { /* 落到下面兜底 */ }
    }
    var raw = store.get('charMem:' + charId);
    return raw && Array.isArray(raw.memories) ? raw : { memories: [] };
  }

  function anniversaryCandidates(charId) {
    var list = (memoryFile(charId).memories || []);
    var saved = eventsOf(charId).filter(function (e) { return e.eventType === 'anniversary'; });
    var savedBy = {};
    saved.forEach(function (e) { if (e.memoryId) savedBy[e.memoryId] = e; });
    return list.filter(function (m) {
      return m && m.isAnchor && m.status !== 'invalid';
    }).map(function (m) {
      return { memory: m, saved: savedBy[m.id] || null };
    });
  }

  function anniversariesOn(charId, iso) {
    return eventsOn(charId, iso).filter(function (e) { return e.eventType === 'anniversary'; });
  }

  /* 从候选写一条纪念日。meaningType 区分「双方已确认」与「char 自己的意义」
     （§11.2）—— 私人纪念日**不许**被当成双方关系事实。 */
  function saveAnniversary(charId, mem, opts) {
    opts = opts || {};
    var date = opts.date || dateOf(mem.createdAt || '') || todayISO();
    return addEvent({
      ownerCharId: charId,
      eventType: 'anniversary',
      title: opts.title || mem.content || '纪念日',
      desc: opts.desc || '',
      startAt: date,
      allDay: true,
      status: 'confirmed',
      repeatRule: opts.repeatRule || 'yearly',
      visibility: opts.visibility || 'private',
      meaningType: opts.meaningType || 'char_subjective',
      memoryId: mem.id,
      sourceIds: mem.sourceRef ? [mem.sourceRef] : [],
      createdBy: { type: 'char', id: charId },
      sourceType: 'memory',
      participants: [{ type: 'char', id: charId, state: 'accepted' }]
    });
  }

  /* ---------------------------- 时间事实（喂给模型的） ----------------------------

     总纲 §14 的落地：
       · **不常驻整份日历** —— 只给「现在」+ 今天的状态 + 极少量近期相关项；
       · 关闭「生成角色日程」时只注入客观日期背景（§14.2）；
       · 结构化短行优先于长摘要；
       · 公共假期只描述客观环境，**不代表 char 一定休息**（§10）。

     时区：先走 Intl（准），拿不到就退回近似偏移表并在文本里标一个「约」字 ——
     绝不假装精确。 */
  function tzNow(tz, at) {
    var d = at || new Date();
    if (!tz) return null;
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      try {
        var parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }).formatToParts(d);
        var g = {};
        parts.forEach(function (p) { g[p.type] = p.value; });
        if (g.year && g.month && g.day) {
          return {
            iso: g.year + '-' + g.month + '-' + g.day,
            time: (g.hour === '24' ? '00' : g.hour) + ':' + g.minute,
            exact: true
          };
        }
      } catch (e) { /* 落到下面的近似表 */ }
    }
    var off = DATA.TZ_OFFSET_MIN ? DATA.TZ_OFFSET_MIN[tz] : undefined;
    if (off === undefined || off === null) return null;
    var t = new Date(d.getTime() + off * 60000);
    return {
      iso: t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate()),
      time: pad2(t.getUTCHours()) + ':' + pad2(t.getUTCMinutes()),
      exact: false
    };
  }

  function localNow(at) {
    var d = at || new Date();
    return { iso: isoOf(d), time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) };
  }

  function cnDate(iso) {
    return Number(iso.slice(0, 4)) + '年' + Number(iso.slice(5, 7)) + '月' +
      Number(iso.slice(8, 10)) + '日 星期' + WEEK_CN[weekdayOf(iso)];
  }

  function monthDayText(dateISO) {
    return Number(String(dateISO).slice(5, 7)) + '月' + Number(String(dateISO).slice(8, 10)) + '日';
  }

  /* 主入口。返回一段可直接进 prompt 的纯文本；没有任何可说的就返回 ''（整槽不注入）。 */
  function timeFacts(charId, opts) {
    opts = opts || {};
    var at = opts.at ? new Date(opts.at) : new Date();
    var cfg = cfgOf(charId);
    var place = placeOf(charId);
    var mine = tzNow(cfg.timezone, at);
    var local = localNow(at);
    if (!mine) mine = { iso: local.iso, time: local.time, exact: true };

    var lines = [];
    var where = place.city || (DATA.TZ_LABELS && DATA.TZ_LABELS[cfg.timezone]) || cfg.timezone || '';
    lines.push('【时间事实】现在的真实时间以这里为准；不要自己编日期，也不要把它当台词念出来。');
    lines.push('你的现在：' + cnDate(mine.iso) + ' ' + mine.time +
      (where ? '（' + where + (cfg.timezone ? ' · ' + cfg.timezone : '') + '）' : '') +
      (mine.exact ? '' : '，约'));

    /* 时差：只在真的不同的时候说一句。同一天且同一时刻就不占篇幅。 */
    if (mine.iso !== local.iso) {
      lines.push('user 那边：' + cnDate(local.iso) + ' ' + local.time + '（和你不在同一天）');
    } else if (mine.time !== local.time) {
      lines.push('user 那边：' + local.time);
    }

    /* ---- 客观日期背景 ---- */
    var region = regionMeta(cfg.region);
    if (region.id !== 'NONE') {
      var info = dayInfo(mine.iso, cfg);
      var seg;
      if (info.legal) {
        var kind = info.legal.kind;
        seg = '今天是' + info.legal.name +
          (kind === 'workday_adjustment' ? '（官方调休上班日）'
            : (kind === 'weekend' ? '（假期期间的周末）' : '（法定放假日）'));
      } else {
        seg = info.isDayOff ? '今天是普通周末' : '今天是普通工作日';
      }
      lines.push('公共日期（' + region.label + '）：' + seg +
        '。它只描述客观环境，不代表你一定休息。');
      if (info.festivals.length) {
        lines.push('今天是：' + info.festivals.map(function (f) { return f.name; }).join('、') + '。');
      }
      if (!info.builtin && info.notes[0]) lines.push('（' + info.notes[0] + '）');
    }

    /* ---- 日程层：**只有开了「生成角色日程」才注入**（§14.2）---- */
    if (cfg.scheduleOn) {
      var soon = upcoming(charId, 7, mine.iso).filter(function (x) {
        return x.event.eventType !== 'anniversary';
      }).slice(0, 5);
      if (soon.length) {
        lines.push('你近期的安排：' + soon.map(function (x) {
          var e = x.event;
          var when = x.inDays === 0 ? '今天' : (x.inDays === 1 ? '明天' : monthDayText(x.date));
          var t = e.allDay ? '' : (' ' + timeOf(e.startAt) +
            (timeOf(e.endAt) ? '—' + timeOf(e.endAt) : ''));
          var st = e.status === 'pending'
            ? (e.eventType === 'shared_event' ? '（还没和你确认）' : '（待确认）') : '';
          return when + t + ' ' + e.title + st;
        }).join('；') + '。');
      }
    }

    /* ---- 纪念日：临近才说（±3 天）---- */
    var near = [];
    var anns = eventsOf(charId).filter(function (e) {
      return e.eventType === 'anniversary' && e.status !== 'cancelled';
    });
    anns.forEach(function (e) {
      var d0 = dateOf(e.startAt);
      var diff = Math.round((parseISO(addYearsToMD(d0, mine.iso.slice(0, 4))).getTime() -
        parseISO(mine.iso).getTime()) / 86400000);
      if (diff >= -3 && diff <= 3) {
        near.push(monthDayText(d0) + '「' + e.title + '」' +
          (e.meaningType === 'shared_confirmed' ? '（你们确认过的）' : '（他自己赋予的意义）'));
      }
    });
    if (near.length) {
      lines.push('临近的纪念日：' + near.join('；') +
        '。可以放在心里，也可以做点什么 —— 不必刻意，也不必装作不知道。');
    }

    /* 只有第一行的空壳（char 没设时区又没有地区）时干脆不注入 */
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /* 把 'MM-DD' 拼到指定年份上（纪念日是按每年回来的） */
  function addYearsToMD(mdISO, year) {
    return year + '-' + String(mdISO).slice(5);
  }

  /* ---------------------------- 月格标记 ---------------------------- */

  function marks(charId, iso, cfg) {
    var info = dayInfo(iso, cfg);
    var evs = eventsOn(charId, iso);
    var out = { public: false, schedule: false, memory: false, count: 0 };
    if (info.legal || info.festivals.length) out.public = true;
    evs.forEach(function (e) {
      if (e.status === 'cancelled') return;
      if (e.eventType === 'anniversary') out.memory = true;
      else out.schedule = true;
      out.count++;
    });
    return out;
  }

  /* 关掉「生成角色日程」后，月格上那些自动排的生活日程不再显示。
     ⚠️ 只是不显示 —— 数据一条都不动（§6.2 保留历史日程数据）。 */
  function scheduleHidden(charId, cfg) { return !cfg.scheduleOn; }

  function visibleEventsOn(charId, iso, cfg) {
    var evs = eventsOn(charId, iso);
    if (scheduleHidden(charId, cfg)) {
      evs = evs.filter(function (e) { return e.eventType !== 'char_schedule'; });
    }
    return evs;
  }

  Sleepy.calendar = {
    KEY_CFG: KEY_CFG,
    KEY_EVT: KEY_EVT,
    DEFAULT_CFG: DEFAULT_CFG,
    /* 工具 */
    isoOf: isoOf, parseISO: parseISO, todayISO: todayISO, shiftISO: shiftISO,
    timeOf: timeOf, dateOf: dateOf, at: at, weekdayOf: weekdayOf, isWeekend: isWeekend,
    monthLabel: monthLabel, WEEK_CN: WEEK_CN, clearCache: clearCache,
    /* 配置 */
    cfgOf: cfgOf, saveCfg: saveCfg, regionMeta: regionMeta, cultureMeta: cultureMeta,
    /* 常驻地点（char 身上的字段，日历/时区/语言都从它推） */
    placeOf: placeOf, placeLabel: placeLabel, overridden: overridden, resetToPlace: resetToPlace,
    /* 语言与翻译开关（语言也是从常驻地点推） */
    langOf: langOf, KEY_TRANS: KEY_TRANS, translateOn: translateOn, setTranslateOn: setTranslateOn,
    /* 时间事实（喂给模型的那一段） */
    tzNow: tzNow, localNow: localNow, cnDate: cnDate, timeFacts: timeFacts,
    /* 公共日期 */
    dayInfo: dayInfo, monthGrid: monthGrid, buildYear: buildYear,
    /* 事件 */
    eventsOf: eventsOf, eventsOn: eventsOn, visibleEventsOn: visibleEventsOn,
    occursOn: occursOn, addEvent: addEvent, getEvent: getEvent,
    updateEvent: updateEvent, cancelEvent: cancelEvent, removeEvent: removeEvent,
    conflictOf: conflictOf, clearGenerated: clearGenerated, upcoming: upcoming,
    marks: marks,
    /* 纪念日 */
    memoryFile: memoryFile, anniversaryCandidates: anniversaryCandidates,
    anniversariesOn: anniversariesOn, saveAnniversary: saveAnniversary
  };

})(window);
