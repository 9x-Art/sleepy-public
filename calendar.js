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

  function arr(v) { return Array.isArray(v) ? v : []; }

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
  /* 两个 ISO 日期之间**含首尾**的天数（'2026-10-01'~'2026-10-07' = 7）。
     走 parseISO 本地构造，不碰 new Date(str) —— 那会把 YYYY-MM-DD 当 UTC 解析、
     东八区整体退一天（同 isoOf 的坑）。
     算出来的天数直接进 prompt，所以**不许四舍五入、不许取整到周**。 */
  function daysBetween(fromISO, toISO) {
    var a = parseISO(fromISO), b = parseISO(toISO);
    if (!a || !b || isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
    return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
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
    timezone: '',              /* ⚠️ 默认「未选择」—— 运行时按 runtimeTzOf 解析
                                  （char 显式 > 设备系统时区 > UTC 兜底），
                                  不许再写死 Asia/Shanghai：那会让没选时区的
                                  char 永远被当成住在上海（2026-09-28 收尾）。 */
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

  /* ---------------------------- 运行时时区（唯一出口） ----------------------------

     2026-09-28 收尾定稿（用户）：
       ① 日历显式覆盖（calConfigs 那条记录里 timezone 非空）
       ② char 常驻地点（char.timezone 非空）
       ③ 都没选 → **跟随 user 设备系统时区**（Intl resolvedOptions，
          运行时展示规则，绝不回写进 char 资料 —— 红线）
       ④ 设备时区读不到 / 解析失败 → 项目安全兜底 'UTC'
     不允许「未选择」默认成上海 / UTC / 任何开发环境时区（③④之外没有路）。
     level 如实暴露，测试和降级提示都从这里拿，不许自己再推一遍。 */
  function deviceTimezone() {
    if (typeof Intl === 'undefined' || !Intl.DateTimeFormat ||
        !Intl.DateTimeFormat.prototype || !Intl.DateTimeFormat.prototype.resolvedOptions) return '';
    try {
      var tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof tz === 'string' && tz ? tz : '';
    } catch (e) { return ''; }
  }
  /* 时区串能不能真的用（旧数据可能存了无效/过期 IANA 名）。
     校验用「显式 timeZone」的 formatter —— 与 tzNow 同一条路，结果一致；
     带记忆：无效值反复查不贵，但月历每格都会过这里。 */
  var TZ_USABLE_MEMO = {};
  function tzUsable(tz) {
    if (!tz) return false;
    if (TZ_USABLE_MEMO[tz] !== undefined) return TZ_USABLE_MEMO[tz];
    var ok = true;
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
      catch (e) { ok = false; }
    }
    TZ_USABLE_MEMO[tz] = ok;
    return ok;
  }
  function runtimeTzOf(charId) {
    /* 每级都先验有效性：无效的显式值（旧数据写坏）不采用，直接落到下一级 ——
       宁可跟设备，也不要拿着坏串假装是时区。
       ⚠️ 旧版本自动写入的 'Asia/Shanghai' 不做批量清洗 —— 无法区分
       「自动默认」和「用户主动选的上海」；旧角色想跟设备，
       在设置里明确选一次「跟随设备」即可。 */
    var rec = cfgRec(charId);
    if (rec && rec.timezone && tzUsable(rec.timezone)) return { tz: String(rec.timezone), level: 'calendar' };
    var p = placeOf(charId);
    if (p.timezone && tzUsable(p.timezone)) return { tz: p.timezone, level: 'char' };
    var dev = deviceTimezone();
    if (dev) return { tz: dev, level: 'device' };
    return { tz: 'UTC', level: 'fallback' };
  }

  function cfgOf(charId) {
    var out = {};
    for (var k in DEFAULT_CFG) if (DEFAULT_CFG.hasOwnProperty(k)) out[k] = DEFAULT_CFG[k];
    /* ① 常驻地点 */
    var place = placeOf(charId);
    if (place.region) out.region = place.region;
    /* ② 日历里的覆盖 */
    var rec = cfgRec(charId);
    if (rec) {
      for (var k2 in DEFAULT_CFG) {
        if (rec[k2] !== undefined && rec[k2] !== null) out[k2] = rec[k2];
      }
    }
    /* 时区不走上面的复制/覆盖 —— 运行时解析是唯一出口（runtimeTzOf）：
       显式两级（日历覆盖 > char 常驻地点）都没选时跟随设备系统时区，
       最后才落到 UTC 兜底。 */
    out.timezone = runtimeTzOf(charId).tz;
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

  /* ⚠️ 缓存键**必须带上 cultures**（2026-10-03 修复）。
     以前只有 `year|region`，而文化节日那层是按 cfg.cultures 逐组铺的 ——
     于是同一年的这块缓存会被**第一个来问的人**定死：
       · 甲只选「中国传统节日」先问 2026 → 乙（选了国际节日）再问
         12-25，拿到的是甲那份、圣诞节整个不见；
       · 反过来甲先问，乙就看到自己没选的中文节日，甚至跨角色串味。
     设置页里每次点 chips 都调了 clearCache()，所以**手动改完看着是对的**；
     真正漏的是「两个 char 交替问同一年」这条路 —— 聊天注入（timeFacts）
     和月历都会走它。带上 cultures 就互不干扰（同键才复用）。 */
  function cultureKey(cfg) {
    var gs = (cfg && cfg.cultures) || [];
    return gs.slice().sort().join(',');
  }

  function buildYear(year, cfg) {
    var ck = year + '|' + (cfg.region || 'CN') + '|' + cultureKey(cfg);
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
            /* ⚠️ 2026-10-03：这里带上**整段区间**和**今天在区间里的第几天**。
               下游要靠它说「10 月 1 日—7 日 · 今天是第 3 天」这种完整事实，
               而不是让模型自己从「今天是国庆节」去推（推出来的必然是「第一天」）。
               span 为 1 时（2025 元旦）不写 day/total —— 没有区间就没有「第几天」。 */
            var span = daysBetween(h.from, h.to);
            var rec = {
              name: h.name, kind: isWeekend(cur) ? 'weekend' : 'legal_off', tag: '休',
              from: h.from, to: h.to, span: span
            };
            if (span > 1) {
              /* ⚠️ `daysBetween` 本身**已含首尾**（from~to = span），
                 所以 from 当天就是第 1 天，**这里不许再 +1** ——
                 多加一次会让 10-01 变成「第 2 天」，7 天的假期说成 8 天。 */
              rec.day = daysBetween(h.from, cur);
              rec.total = span;
            }
            idx.off[cur] = rec;
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

  /* ---------------------------- 绝对时间区间 ----------------------------

     2026-10-03 重写（第二轮施工单第四批）。旧实现比的是裸 'HH:MM' 字符串：
       `23:00 → 次日 01:00` 的 endAt 取到 '01:00'，于是 '23:30' < '01:00' 为 false
       → **跨午夜的事件一次冲突都报不出来**（连同一天 23:30 都漏），
       而且完全不读事件的 timezone。
     现在一律折成「绝对分钟」再比：
       绝对分钟 = 该日期当地 0 点的 epoch 分钟 + HH:MM 的分钟数 − 时区偏移(分钟)
     两个事件的时区不同也能比（各自减自己的偏移，落到同一根 UTC 轴上）。 */

  /* 'HH:MM' → 当天分钟数；解析不出返回 -1（**不许兜成 0** —— 那会凭空造一个 0 点） */
  function minuteOfDay(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return -1;
    var hh = Number(m[1]), mm = Number(m[2]);
    if (hh > 23 || mm > 59) return -1;
    return hh * 60 + mm;
  }

  /* 'YYYY-MM-DD' → 当天 0 点的 epoch 分钟（本地构造，跨日期一致即可） */
  function dayMin(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return null;
    var t = parseISO(iso).getTime();
    return isFinite(t) ? t / 60000 : null;
  }

  /* 时区 → 东偏分钟。表里没有（或没填）就返回 null，由调用方决定兜底。
     ⚠️ 用的是偏移表（`DATA.TZ_OFFSET_MIN`），**不处理夏令时** ——
     跟 `tzNow` 那条「约」是同一个口径，宁可标近似也不要假装精确。 */
  function offsetOfTz(tz) {
    if (!tz || !DATA.TZ_OFFSET_MIN) return null;
    var v = DATA.TZ_OFFSET_MIN[tz];
    return (typeof v === 'number') ? v : null;
  }
  /* 没写时区 → 按 user 设备本地（0 差基准） */
  function deviceOffsetMin() { return -(new Date().getTimezoneOffset()); }

  /* 一条事件在「目标日期 iso」上实际占用的绝对区间 [s, e)。

     ⚠️ **基准一定是目标日期，不是事件自己的日期**：重复事件（每周例会
     startAt 停在 2026-10-03）在 2026-10-10 也要占 20:00—21:00，
     拿它自己的日期当基准就会把区间算回原日，从而在目标日上永远查不到。
     做法：先取「自己那天的 HH:MM」和「结束相对开始差几天」，
     再整体平移到目标日 —— 不建实例表也能算对。

     返回 null = 这条解析不出来（旧脏数据 / 非法时间）→ 调用方必须 fail closed。 */
  function spanOf(e, iso) {
    if (!e || !iso) return null;
    var off = offsetOfTz(e.timezone);
    if (off === null) off = deviceOffsetMin();
    var base = dayMin(iso);
    if (base === null) return null;
    if (e.allDay) return { s: base - off, e: base - off + 1440 };
    var sMin = minuteOfDay(timeOf(e.startAt));
    if (sMin < 0) return null;
    var s = base + sMin - off;
    var eMin = minuteOfDay(timeOf(e.endAt));
    var eBase = (eMin < 0) ? null : dayMin(dateOf(e.endAt));
    if (eBase === null) return { s: s, e: s };      /* 没写结束 / 写坏了 = 一个点，不占时长 */
    var sBase = dayMin(dateOf(e.startAt));
    if (sBase === null) return { s: s, e: s };
    var dayDelta = Math.round((eBase - sBase) / 1440);   /* 结束比开始晚几天（通常 0） */
    var e2 = base + dayDelta * 1440 + eMin - off;
    /* 跨午夜：结束不晚于开始（要么日期真隔了一天、要么时间写反了）→ 算到次日 */
    if (e2 <= s) e2 = s + 1440;
    return { s: s, e: e2 };
  }

  /* 这条事件在目标日期 iso 上占不占时间、占哪一段。
     除了「当天命中」，还要算**从昨天跨过来的那半截** ——
     通宵班 23:00→次日 01:00 在「次日」这一天同样占着 00:00—01:00，
     而 `eventsOn` 只认 startAt 那天，光靠它会漏（第二轮施工单第四批抓到的）。
     返回 { span, unresolved }；span 为 null 且 unresolved=true = 程序算不出来。 */
  function spanOnDay(e, iso) {
    if (!e || !iso) return { span: null, unresolved: true };
    if (occursOn(e, iso)) {
      var sp = spanOf(e, iso);
      return sp ? { span: sp, unresolved: false } : { span: null, unresolved: true };
    }
    var prev = shiftISO(iso, -1);
    if (!occursOn(e, prev)) return { span: null, unresolved: false };  /* 这天压根没它 */
    var spPrev = spanOf(e, prev);
    if (!spPrev) return { span: null, unresolved: true };
    var off = offsetOfTz(e.timezone);
    if (off === null) off = deviceOffsetMin();
    var dayStart = dayMin(iso) - off;
    if (spPrev.e <= dayStart) return { span: null, unresolved: false };  /* 没跨过午夜 */
    return { span: { s: dayStart, e: Math.min(spPrev.e, dayStart + 1440) }, unresolved: false };
  }

  /* 时间重叠检测（§12.6：程序做确定性判断，模型不负责算时间）。
     已取消的事件**不占用时间**；只显示忙碌的也照样参与。

     ⚠️ fail closed：**解析不出来的旧数据不静默当「没冲突」** ——
     要么整条 draft 算不出（那就把这天碰到的都报出来让 user 自己看），
     要么某条旧事件算不出（那就把它算进冲突里）。
     宁可多问一句，也不要默默放行一个其实撞车的安排。 */
  function conflictOf(charId, draft) {
    if (!draft) return [];
    var iso = dateOf(draft.startAt);
    if (!iso) return [];
    var ds = spanOf(draft, iso);
    var out = [];
    eventsOf(charId).forEach(function (e) {
      if (!e) return;
      if (draft.id && e.id === draft.id) return;
      if (e.status === 'cancelled') return;
      var got = spanOnDay(e, iso);
      if (!got.span) {
        if (got.unresolved) out.push(e);   /* 算不出来 → 算它撞 */
        return;
      }
      if (!ds) { out.push(e); return; }    /* draft 自己解析不出 → 全报 */
      if (ds.s < got.span.e && got.span.s < ds.e) out.push(e);
    });
    return out;
  }

  /* 给 UI 的可解释版本：`conflictOf` 只给结论，这里额外说清
     「有哪些是程序算不准、只能请你自己看的」。 */
  function conflictReport(charId, draft) {
    var iso = draft ? dateOf(draft.startAt) : '';
    var list = conflictOf(charId, draft);
    var unresolved = [];
    if (draft && iso && !spanOf(draft, iso)) unresolved.push('这次要建的时间');
    if (iso) {
      eventsOf(charId).forEach(function (e) {
        if (!e || e.status === 'cancelled') return;
        var got = spanOnDay(e, iso);
        if (got.unresolved) unresolved.push(e.title || '（无标题）');
      });
    }
    return {
      conflicts: list,
      unresolved: unresolved,
      needConfirm: list.length > 0 || unresolved.length > 0
    };
  }

  /* ---------------------------- 共同事件：参与者表态 ----------------------------

     第二轮施工单第五批。修之前的状态：`participantStates` 只有 user 那一格被写过，
     char 那一格**全库没有任何一处赋值**，于是 `both` 永远 false、
     `confirmed` 从来没被写过 —— 邀请发出去就永远停在「待确认」。 */

  var PSTATE = ['pending', 'accepted', 'declined'];
  var PSTATE_TEXT = { pending: '还没表态', accepted: '答应了', declined: '推掉了' };

  function fail(code, message) { return { ok: false, error: { code: code, message: message } }; }

  /* 参与者状态的**唯一事实来源 = participantStates**（页面读的也是它，
     page-calendar.js:150 / :888）。`participants[].state` 降为**兼容字段**：
     每次写状态时同步一份，但任何判断都不许读它 ——
     两套并存、谁都能写，正是 char 侧永远置不上 accepted 的原因。 */
  function syncParticipantsTo(e, ps) {
    if (!e || !e.participants) return null;
    return e.participants.map(function (p) {
      if (!p) return p;
      var key = (p.type === 'user') ? 'user' : p.id;
      var next = {};
      Object.keys(p).forEach(function (k) { next[k] = p[k]; });
      if (ps[key] !== undefined) next.state = ps[key];
      return next;
    });
  }

  /* 由参与者状态算事件状态 —— **程序算，不接受外部传入**：
       双方都 accepted → confirmed
       任一 declined   → cancelled（现有状态值域里没有 declined，不擅造新状态）
       还有 pending    → pending */
  function sharedStatusOf(e) {
    var ps = (e && e.participantStates) || {};
    var keys = Object.keys(ps);
    if (!keys.length) return 'pending';
    var declined = false, waiting = false;
    keys.forEach(function (k) {
      if (ps[k] === 'declined') declined = true;
      else if (ps[k] !== 'accepted') waiting = true;
    });
    if (declined) return 'cancelled';
    return waiting ? 'pending' : 'confirmed';
  }

  function participantText(e, key) {
    var ps = (e && e.participantStates) || {};
    return PSTATE_TEXT[ps[key]] || '还没表态';
  }

  /* 表态入口。**这是 char 那一格唯一被允许写入的地方。**

     ⚠️ `via` 必须显式传，它记录「这次表态是哪来的」：
       'user_record'      玩家在日历里明确记下他的回应（**本轮唯一可用来源**）
       'story_candidate'  将来的角色侧候选（本轮**不存在**这个来源，传了就拒）
     没有真实来源就不许改 —— 不允许「玩家打开页面 = 角色接受」，
     也不允许「模型一句话 = 角色接受」。本轮宁可只把数据与显示补齐，
     也不伪造一个自动接受。 */
  function respondSharedEvent(eventId, actorKey, state, via, reason) {
    var e = getEvent(eventId);
    if (!e) return fail('no-event', '找不到这条日程');
    if (e.eventType !== 'shared_event') return fail('not-shared', '只有共同事件才有参与者的表态');
    if (PSTATE.indexOf(state) < 0) return fail('bad-state', '表态只能是 还没表态 / 答应了 / 推掉了');
    if (via !== 'user_record') {
      return fail('no-source', '角色表态必须有真实来源：本轮只认玩家明确记录（via=user_record）');
    }
    var inList = (e.participants || []).some(function (p) {
      return p && ((p.type === 'user' && actorKey === 'user') || p.id === actorKey);
    });
    if (!inList) return fail('not-a-participant', '这个人不在参与者名单里');
    /* 角色看不到的邀请不能被接受 —— 连玩家替他记都不行，
       否则「他不知道这件事」和「他答应了」会同时成立。 */
    if (actorKey !== 'user' && charViewOf(e, actorKey) !== 'detail') {
      return fail('invisible-to-char', '这条邀请他看不到，不能替他表态');
    }
    var cur = e.participantStates || {};
    if (e.status === 'cancelled' && !cur[actorKey]) {
      return fail('already-cancelled', '这条已经取消了，要改就重新约一次');
    }

    var ps = {};
    Object.keys(cur).forEach(function (k) { ps[k] = cur[k]; });
    ps[actorKey] = state;

    var patch = { participantStates: ps };
    var parts = syncParticipantsTo(e, ps);
    if (parts) patch.participants = parts;
    var st = sharedStatusOf({ participantStates: ps });
    patch.status = st;
    if (st === 'cancelled') patch.cancelReason = reason || '有人推掉了';
    else if (e.status === 'cancelled') patch.cancelReason = null;

    var after = updateEvent(eventId, patch, reason || (PSTATE_TEXT[state] || '表态'));
    if (!after) return fail('no-event', '找不到这条日程');
    return { ok: true, event: after, status: after.status, states: after.participantStates };
  }

  /* ---------------------------- 统一写入出口 ----------------------------

     第二轮施工单第二批。以前 UI 自己拼一个 rec 直接 `addEvent`，
     执行器（将来）也会各拼一份 —— 校验就会分叉，而且「谁定的」这种字段
     各写各的。现在所有写入都走 `requestCreateEvent`：
     **addEvent 退成纯落库函数，不再被 UI / 执行器直接绕过去调。**

     ⚠️ 这不是「模型权限」。它只是**所有写入都要经过的程序边界**：
     模型只能生成候选或 action request，不能直接调 store.set，
     也不能伪造成功回执（回执里的 eventId 一定是 addEvent 返回的真 id）。 */

  /* 客观日期（公共假日 / 文化节日）是内置数据，**不许任何入口造** */
  var CREATE_TYPES = ['user_reminder', 'shared_event', 'char_schedule', 'anniversary'];
  var CREATE_STATUS = ['confirmed', 'pending'];
  var CREATE_VIS = ['private', 'participants', 'shared_busy', 'shared_detail'];
  var CREATE_FIELDS = ['ownerCharId', 'eventType', 'title', 'desc', 'startAt', 'endAt',
    'timezone', 'allDay', 'repeatRule', 'visibility', 'participants', 'participantStates',
    'status', 'sourceType', 'sourceIds', 'memoryId', 'meaningType', 'createdBy', 'requestKey',
    'authorizedVia'];
  /* 谁能授权一次写入。空串 = 没记录（老数据）。
     'schedule_switch'（2026-10-08）：每日日程生成器（schedule-gen.js）——
     user 打开某个角色的「生成角色日程」开关，就是对「替他排日程」这件事的
     一次性长期授权；每次自动写入都带这个来源，审计时能认出是生成器写的。 */
  var AUTH_VIA = ['ui_form', 'anniversary_sheet', 'review_desk', 'schedule_switch'];

  function requestCreateEvent(payload, options) {
    var opt = options || {};
    var p = payload || {};
    var requestId = opt.requestId || newId('creq');
    var at = Date.now();

    function bad(code, message, extra) {
      var r = {
        ok: false, requestId: requestId,
        error: { code: code, message: message },
        receipt: { type: 'calendar_event_failed', at: at, errorCode: code }
      };
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }

    /* ① 必填 */
    if (!p.ownerCharId) return bad('no-owner', '缺 ownerCharId');
    if (!p.eventType) return bad('no-type', '缺 eventType');
    if (CREATE_TYPES.indexOf(p.eventType) < 0) {
      return bad('bad-type', '这种日程不能建：' + p.eventType);
    }
    if (!String(p.title || '').trim()) return bad('no-title', '得写个标题');
    if (!p.startAt) return bad('no-start', '缺开始时间');

    /* ② 只允许白名单字段（多给的丢掉，不给机会写脏东西） */
    var rec = {};
    CREATE_FIELDS.forEach(function (k) { if (p[k] !== undefined) rec[k] = p[k]; });

    /* ③ 授权来源：**每次写入都要说清是谁批准的**。
       'ui_form'          用户手点保存
       'anniversary_sheet' 纪念日弹层
       'review_desk'      帷境审阅台（**审阅台本身就是确认台**，见 wj-canon.js:341）
       没给就默认 ui_form。 */
    var via = opt.authorizedVia || 'ui_form';
    if (AUTH_VIA.indexOf(via) < 0) return bad('bad-authorization', '不认识的授权来源：' + via);

    /* ③b 「回溯记录」开关：`historical` 表示**这不是邀请，是已经发生的事的补记**
       （帷境定史那种）。它才允许共同事件直接建成 confirmed ——
       但必须同时有授权来源，否则谁都能拿它绕过「创建邀请 ≠ 对方接受」。
       ⚠️ 还要求作者是 user：角色/模型都没有「回溯现实」的资格。 */
    var hist = !!opt.historical;
    if (hist) {
      if (!opt.authorizedVia) return bad('no-authorization', '回溯记录必须写明是谁授权的');
      var by0 = p.createdBy || {};
      if (by0.type !== 'user') return bad('bad-authorization', '回溯记录只能由 user 写');
    }

    /* ③c status 初始值限制：**创建邀请 ≠ 对方接受** ——
       共同事件一律从 pending 起，谁都不能一步建成 confirmed（回溯记录除外）。 */
    var st = rec.status || 'confirmed';
    if (CREATE_STATUS.indexOf(st) < 0) return bad('bad-status', '初始状态只能是 confirmed / pending');
    if (rec.eventType === 'shared_event' && !hist) st = 'pending';
    rec.status = st;

    /* ④ visibility 与 participants 的一致性 */
    var vis = rec.visibility || 'private';
    if (CREATE_VIS.indexOf(vis) < 0) return bad('bad-visibility', '可见性取值不认识：' + vis);
    if (rec.eventType === 'shared_event') {
      vis = 'participants';
      var parts = arr(rec.participants);
      if (!parts.length) return bad('no-participants', '共同事件得有参与者');
      var hasUser = parts.some(function (x) { return x && x.type === 'user'; });
      var hasChar = parts.some(function (x) { return x && x.type === 'char'; });
      if (!hasUser || !hasChar) return bad('bad-participants', '共同事件要同时有你和角色');
      /* 参与者状态由**程序**定：user 建 = user 已答应，角色一律从 pending 起。
         唯一例外是回溯记录 —— 事情已经发生了，不存在「等他表态」这一说，
         所以全员 accepted（且这个开关要求 user 授权，见 ③b）。 */
      var ps = rec.participantStates || {};
      ps.user = 'accepted';
      parts.forEach(function (x) {
        if (!x || x.type !== 'char') return;
        if (hist) ps[x.id] = 'accepted';
        else if (ps[x.id] === undefined) ps[x.id] = 'pending';
      });
      rec.participantStates = ps;
      rec.participants = parts.map(function (x) {
        var n = {}; Object.keys(x).forEach(function (k) { n[k] = x[k]; });
        n.state = (x.type === 'user') ? 'accepted' : (ps[x.id] || 'pending');
        return n;
      });
    } else if (vis === 'participants') {
      return bad('bad-visibility', '只有共同事件能用「只有参与的人看得到」');
    }
    rec.visibility = vis;

    /* ⑤ createdBy 明确记录（**不接受 model** —— 模型不能当作者） */
    var by = rec.createdBy || { type: 'user', id: 'user' };
    if (!by || !by.type || by.type === 'model') {
      return bad('bad-createdby', 'createdBy 只能是 user 或 char，不接受 model');
    }
    rec.createdBy = by;
    rec.authorizedVia = via;

    /* ⑥ 当前 sandbox 归属：没落岛就不写（写了就是一岛外的孤儿数据） */
    var sid = core() ? core().scopeId() : null;
    if (!sid) return bad('no-sandbox', '还没进任何一间房，不能建日程');

    /* ⑦ 幂等：同一个 requestKey 只建一条 */
    var key = opt.requestKey || rec.requestKey || '';
    if (key) {
      var hit = null;
      allEvents().forEach(function (e) {
        if (e && e.requestKey === key && e.sandboxId === sid) hit = e;
      });
      if (hit) {
        /* ⚠️ dup 分支**也要把 event 带回去**（第三轮补上）。
           原来只回 eventId，于是重跑的人拿不到事件对象 ——
           saveAnniversary 重试时就没法补写绑定、也没法核对字段。
           「已经建过」是一条完整的成功答复，不是一条半截的。 */
        return {
          ok: true, eventId: hit.id, requestId: requestId, dup: true, event: hit,
          receipt: { type: 'calendar_event_created', at: at, ref: hit.id, dup: true }
        };
      }
      rec.requestKey = key;
    }

    /* ⑧ 冲突检查 —— **冲突时不写，把结论交回 UI**。
       二次确认永远由 UI 负责（统一入口不许弹窗），UI 确认后带 allowConflict 再来一次。 */
    var clash = conflictOf(rec.ownerCharId, rec);
    if (clash.length && !opt.allowConflict) {
      return bad('conflict', '这个时间和别的安排撞了', {
        conflict: clash.map(function (e) { return { id: e.id, title: e.title }; }),
        needConfirm: true
      });
    }

    /* ⑨ 落库 —— 到这一步才真的写，前面任何一步失败都不会留下半成品 */
    var ev = addEvent(rec);
    if (!ev || !ev.id) return bad('write-failed', '没写成');
    return {
      ok: true, eventId: ev.id, requestId: requestId, dup: false, event: ev,
      receipt: { type: 'calendar_event_created', at: at, ref: ev.id }
    };
  }

  /* ⚠️ **内部落库函数** —— 外部（UI / 执行器 / 别的 App）一律走
     `requestCreateEvent`，不许直接调它。它不做任何校验，给什么写什么。

     为什么**没有**改成闭包私有：测试夹具（scripts/smoke.js、scripts/browser-*-test.js）
     要靠它直接造数据 —— 大量断言测的正是「统一入口该不该拒掉这种数据」，
     而那些数据（缺标题 / 坏时间 / `public_holiday`）走 requestCreateEvent
     会被正确地拒掉，就没法测「拒得对不对」。将来的备份导入 / 旧数据修复
     也需要这样一个不校验的写入口。

     所以它**从 `Sleepy.calendar` 顶层导出表里拿掉了**（第三轮施工单第三批），
     只挂在 `Sleepy.calendar.__internal.addEvent`。
     ⚠️ 代价是它仍可被调到，所以护栏必须对它比对顶层 addEvent **更敏感**：
     `scripts/smoke.js` 那条静态断言扫的就是 `__internal` 这个词 ——
     生产脚本里出现 `__internal.addEvent` 立刻红。 */
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
      /* 这次写入是谁授权的（'ui_form' / 'anniversary_sheet' / 'review_desk'）。
         只有统一入口会写它 —— 见 requestCreateEvent 的 ③。 */
      authorizedVia: rec.authorizedVia || '',
      /* 参与者表态的**唯一事实来源**（第二轮施工单第五批）。以前只写
         participants[].state，两套并存、谁都能写，于是角色那一格永远置不上
         accepted —— 「已确认」从来没被写过。现在只认这一份，
         participants[].state 降为每次同步的兼容字段。 */
      participantStates: rec.participantStates || {},
      visibility: rec.visibility || 'private',
      deviceProtection: rec.deviceProtection || 'none',
      sourceType: rec.sourceType || 'manual',
      sourceIds: rec.sourceIds || [],
      memoryId: rec.memoryId || null,
      meaningType: rec.meaningType || null,
      repeatRule: rec.repeatRule || null,
      cancelReason: null,
      /* 幂等键：只有统一入口会写它（requestCreateEvent 的 requestKey）。
         有了它，同一个 requestKey 重跑就能认出「这条已经建过」，
         而不是靠「标题 + 时间」那种会把用户真想建的两条相同日程误合并的弱键。 */
      requestKey: rec.requestKey || '',
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
    /* 项目 5：键归 root —— 兜底读取也要过 rootIdOf，别读皮套键 */
    var rid = (Sleepy.core && Sleepy.core.rootIdOf)
      ? (Sleepy.core.rootIdOf(charId) || charId) : charId;
    var raw = store.get('charMem:' + rid);
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

  /* 找一条留痕，**并核它是不是当前岛、当前角色的**。
     第三轮施工单 §1「入口边界」：统一入口不许因为 eventType==='anniversary'
     就放宽权限，所以校验必须发生在**落库之前**：
       · 缺 memoryId            → no-memory
       · 当前岛名册里没有这条留痕 → no-such-memory
       · 留痕不属于这个角色       → memory-not-owed
     跨岛留痕在这里被挡住 —— 因为「能在当前 sandboxId 找到」本身就是一道闸。 */
  function ownedMemory(charId, memId) {
    if (!memId) return { ok: false, code: 'no-memory', message: '这条纪念日没有绑定留痕，不写进日历' };
    var sid = core() ? core().scopeId() : null;
    if (!sid) return { ok: false, code: 'no-sandbox', message: '还没进任何一间房，不能建日程' };
    var mem = null;
    try {
      (memoryFile(charId).memories || []).forEach(function (m) {
        if (m && m.id === memId) mem = m;
      });
    } catch (e) { mem = null; }
    if (!mem) {
      return {
        ok: false, code: 'no-such-memory',
        message: '当前这座岛里找不到这条留痕，可能属于别的地方'
      };
    }
    /* 留痕归属：写库时归了 root，皮套的脸也算同一个人的留痕 */
    var root = (core() && core().rootIdOf) ? (core().rootIdOf(charId) || charId) : charId;
    var mroot = (core() && core().rootIdOf) ? (core().rootIdOf(mem.charId || '') || mem.charId || '') : '';
    var mFrom = mem.fromCharId ? ((core().rootIdOf(mem.fromCharId)) || mem.fromCharId) : '';
    if (mroot && mroot !== root) {
      return { ok: false, code: 'memory-not-owed', message: '这条留痕不属于这个角色' };
    }
    if (!mroot && mFrom && mFrom !== root) {
      return { ok: false, code: 'memory-not-owed', message: '这条留痕不属于这个角色' };
    }
    return { ok: true, memory: mem, sandboxId: sid };
  }

  /* 留痕的来源 id（sourceIds）。
     ⚠️ **只从核过归属的那条留痕身上取**（`ownedMemory` 查出来的那份），
     绝不读调用方传进来的 `mem` 对象 —— 那是模型文本能碰到的地方。

     施工单 §1 写的是「sourceIds 不接受模型任意注入的跨岛 id」，
     这里的做法是**从结构上让它注入不了**，而不是去猜哪些 id 像本项目的：
     `writeMemoryItems` / `addMemoryItem` 写进来的 sourceRef 本来就五花八门
     （`msg_882`、`帷境《…》`、`用户手动添加`），按前缀白名单猜反而会
     把合法来源一起丢掉 —— 那是**破坏原有来源规则**，比放进一个假 id 更糟。
     真要收紧该收紧的是「谁来调 saveAnniversary」，不是「长什么样的字符串合法」。 */
  function sourceIdsOf(verifiedMemory) {
    var one = verifiedMemory && verifiedMemory.sourceRef;
    if (!one || typeof one !== 'string') return [];
    return [one];
  }

  /* 从候选写一条纪念日。meaningType 区分「双方已确认」与「char 自己的意义」
     （§11.2）—— 私人纪念日**不许**被当成双方关系事实。

     第三轮收口批：**改走统一入口 requestCreateEvent**，不再自己 addEvent。
     保留的东西一样都没动：memoryId（留痕双向绑定）、meaningType、
     yearly 重复、全天、sourceType:'memory'、createdBy:char，
     以及「绑了留痕不许删」那条保护（那在 removeEvent 里，跟入口无关）。

     ⚠️ 三处刻意的例外，都写在注释里：
       · allowConflict —— 纪念日是**留痕的标记**，不是占时间的安排，
         它天然会和别的事落在同一天（同一天两条纪念日很正常），
         所以不做冲突拦截，否则「存过的不该再当候选」会被一条无关日程卡住。
       · requestKey 用「岛 + 留痕」—— 一条留痕只该对应一条纪念日，
         重复点保存不会建出第二条。**不带标题和日期**：那是会把用户真想建的
         两条相同纪念日误合并的弱键，产品语义上一条留痕只标一天。
       · 先校验 → 再创建 → 最后写回绑定（见下面的顺序注释）。 */

  /* ⚠️ 写回顺序（施工单 §1「不能留下孤立的成功事件」）：
       ① 核留痕归属（失败 → 什么都没发生）
       ② 走统一入口创建（失败 → 事件表里没有半成品）
       ③ 写回 memory.calendarEventId 建立反向引用
     ③ 失败时**不吞**：事件已经在了（它是真相，不能装作没发生），
     所以如实返回 ok:true + bindOk:false + 可重试的 requestKey，
     下一次同一条留痕再存一次会命中幂等（dup）并**补上绑定**，
     不会建出第二条。这条重试路径由下面的 dup 分支自己兜住。 */
  function saveAnniversary(charId, mem, opts) {
    opts = opts || {};
    var memId = (mem && mem.id) || opts.memoryId || '';
    var own = ownedMemory(charId, memId);
    if (!own.ok) {
      return {
        ok: false,
        error: { code: own.code, message: own.message },
        receipt: { type: 'calendar_event_failed', at: Date.now(), errorCode: own.code }
      };
    }
    var memRec = own.memory;
    var date = opts.date || dateOf((memRec && memRec.createdAt) || '') || todayISO();
    var title = opts.title || (memRec && memRec.content) || '纪念日';
    var res = requestCreateEvent({
      ownerCharId: charId,
      eventType: 'anniversary',
      title: title,
      desc: opts.desc || '',
      startAt: date,
      allDay: true,
      status: 'confirmed',
      repeatRule: opts.repeatRule || 'yearly',
      visibility: opts.visibility || 'private',
      meaningType: opts.meaningType || 'char_subjective',
      memoryId: memId,
      sourceIds: sourceIdsOf(memRec),
      createdBy: { type: 'char', id: charId },
      sourceType: 'memory',
      participants: [{ type: 'char', id: charId, state: 'accepted' }]
    }, {
      requestKey: 'anniversary:' + own.sandboxId + ':' + memId,
      allowConflict: true,
      authorizedVia: 'anniversary_sheet'
    });
    if (!res.ok) return res;

    /* ③ 幂等命中时的**冲突检测**（2026-10-03 定）。
       产品语义是「一条留痕 = 一条纪念日」，所以第二次保存一定命中同一个
       requestKey。此时如果用户又改了标题 / 日期 / 重复规则 / 可见性，
       **不能静默沿用旧值** —— 那等于把用户的输入悄悄扔掉还报「已写进日历」。
       也不能建第二条（那就破了「一条留痕只标一天」）。

       所以：差异存在时**明确拒绝并说清差在哪**，让用户去日历里改
       （本轮施工单「只管创建收口」，不开 update 通道）。
       没差异则正常返回 dup —— 那是幂等在正常工作。 */
    if (res.dup && res.event) {
      var diff = [];
      if (opts.title && String(res.event.title) !== String(opts.title)) {
        diff.push('名字（现在是「' + (res.event.title || '无标题') + '」）');
      }
      if (opts.date && dateOf(res.event.startAt) !== dateOf(opts.date)) {
        diff.push('日期（现在是 ' + (dateOf(res.event.startAt) || '未定') + '）');
      }
      if (opts.repeatRule !== undefined && opts.repeatRule &&
          (res.event.repeatRule || 'yearly') !== opts.repeatRule) {
        diff.push('重复方式');
      }
      if (opts.visibility && (res.event.visibility || 'private') !== opts.visibility) {
        diff.push('谁能看到');
      }
      if (diff.length) {
        return {
          ok: false, eventId: res.eventId, event: res.event, dup: true,
          error: {
            code: 'already-marked',
            message: '这条留痕已经标过日子了，改不了' + diff.join('、') +
              '。要去日历里改那一条。'
          },
          receipt: { type: 'calendar_event_failed', at: Date.now(), errorCode: 'already-marked' }
        };
      }
    }

    /* ③ 反向引用：留痕那条也记下自己是哪条日历事件。
       走 memoryStore 自己的更新出口（它负责归 root 门牌与迁移写锁），
       **不直接 store.set** —— 绕过它就绕过了迁移保护。 */
    var bindOk = false;
    try {
      var ms = Sleepy.memoryStore;
      if (ms && ms.updateMemoryItem) {
        ms.updateMemoryItem(charId, memId, { calendarEventId: res.eventId });
        bindOk = true;
      }
    } catch (e) { bindOk = false; }
    var out = {
      ok: true, eventId: res.eventId, event: res.event, requestId: res.requestId,
      dup: !!res.dup, bindOk: bindOk, memoryId: memId,
      receipt: res.receipt
    };
    if (!bindOk) {
      /* 事件是真的、日历那边成功了 —— 如实说，别报成「整体失败」，
         否则用户会以为没写进去而反复点（那才会重复创建）。 */
      out.receipt = {
        type: 'calendar_event_created', at: Date.now(), ref: res.eventId,
        bindOk: false
      };
    }
    return out;
  }

  /* ---------------------------- 时间事实（喂给模型的） ----------------------------

     总纲 §14 的落地：
       · **不常驻整份日历** —— 只给「现在」+ 今天的状态 + 极少量近期相关项；
       · 关闭「生成角色日程」时只注入客观日期背景（§14.2）；
       · 结构化短行优先于长摘要；
       · 公共假期只描述客观环境，**不代表 char 一定休息**（§10）。

     时区：先走 Intl（准），拿不到就退回近似偏移表并在文本里标一个「约」字 ——
     绝不假装精确。 */

  /* 角色可见性：**唯一出口在 life-feed.js:111 的 charViewOf**。
     这里只做「惰性取 + 调不到就 fail closed」，**自己不再判一遍** ——
     判两遍的结果就是 2026-10-03 勘察抓到的那个洞：
     user 的私人提醒走 I02 进了 char 的 prompt，走 K03b 却被正确挡掉。
     ⚠️ life-feed.js 排在 calendar.js **之前**（index.html:135 vs :196），
     所以调用时它一定已经在了；万一不在（改文件名 / 拆模块），
     **一律当「看不见」** —— 宁可少说一句，也不能把不该让他知道的安排念出来。 */
  function charViewOf(e, charId) {
    var lf = Sleepy.lifeFeed;
    if (!lf || !lf.charViewOf) return '';
    try { return lf.charViewOf(e, charId) || ''; } catch (err) { return ''; }
  }

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

  /* ------------------------- 聊天历史时间标注（2026-10-15 方案 A） -------------------------
     喂模型的历史此前只有 role+content，模型把「昨天发的」全当「刚刚」（真机复现：
     user 昨晚发的消息，今天触发回复 char 以为是今天发的）。数据层早有时刻
     （私聊 msg.timestamp / 群 msg.createdAt），缺的只是装配层渲染。

     histStamp：历史行内戳的唯一出口（私聊引擎/旧路径 + 群聊 [RECENT_GROUP] 共用）。
     · 口径：opts.tz 传角色时区（私聊，配合 timeFacts 已有的「user 那边」时差行）；
       不传 = 设备本地（群聊——群世界锚在 user 手机，各角色时差在逐本体时间块里）。
     · 同一天只给钟点（省 token）；昨天说「昨天」；更早给「M月D日」；跨年带年份。
     · at 缺失/非法（老存档、导入假数据）返回 ''，调用方原样跳过 —— 不编时间。 */
  function histStamp(at, opts) {
    opts = opts || {};
    if (!at) return '';
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    var now = opts.now ? new Date(opts.now) : new Date();
    if (isNaN(now.getTime())) return '';
    var cur, msg;
    if (opts.tz) {
      cur = tzNow(opts.tz, now);
      msg = tzNow(opts.tz, d);
    }
    if (!cur || !msg) { cur = localNow(now); msg = localNow(d); }   /* 时区不可用兜底本地 */
    var time = msg.time;
    if (msg.iso === cur.iso) return '[' + time + '] ';
    /* daysBetween 含首尾（红线：别再 +1）—— 「昨天」= 返回值 2 */
    var dayDiff = daysBetween(msg.iso, cur.iso) - 1;
    if (cur.iso.slice(0, 4) !== msg.iso.slice(0, 4)) {
      return '[' + msg.iso.slice(0, 4) + '年' + monthDayText(msg.iso) + ' ' + time + '] ';
    }
    if (dayDiff === 1) return '[昨天 ' + time + '] ';
    return '[' + monthDayText(msg.iso) + ' ' + time + '] ';
  }

  /* gapLine：间隔事实（方案 A②）。**相对时间必须代码算好直接喂** ——
     让模型自己拿「现在」减「最后一条的时刻」算差值不可靠（这也是方案
     不只靠行内戳的原因）。<5 分钟不说话：正常聊天节奏不需要解释，
     也避免每轮都多一行。 */
  function gapLine(fromTs, opts) {
    opts = opts || {};
    if (!fromTs) return '';
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var ms = now - fromTs;
    if (isNaN(ms) || ms <= 0) return '';
    var min = Math.round(ms / 60000);
    if (min < 5) return '';
    var txt;
    if (min < 60) txt = min + ' 分钟';
    else if (min < 60 * 48) txt = (Math.round(min / 6) / 10) + ' 小时';
    else txt = Math.round(min / 1440) + ' 天';
    return (opts.label || '距最后一条消息已过 ') + txt;
  }

  /* 公共日期那一行的**唯一出口**（2026-10-03）。
     timeFacts（喂模型）与 page-calendar 的日事件列表（给人看）都走它 ——
     以前两边各拼一次，模型那边说错、界面这边显示同一个错。

     ---- 为什么不许再用「今天是<名字>」这个句式 ----
     名字是**整段连休的名**（国庆假期 = 10 月 1 日—7 日），而这一句会连着 7 天都说
     「今天是国庆假期」。于是模型同时读到「今天是 10 月 3 日」和「今天是国庆假期」
     两条互相打架的信息（假期名通常对应 10 月 1 日）—— 它只能采信假期名、
     忽略日期，于是说成「国庆第一天」（用户 2026-10-03 报，换了几个 API 都一样；
     中秋那次同病）。
     **模型不是算错了，是我们逼它二选一。**

     所以改成把三件**不需要它推理**的事实一次给全：区间、今天、第几天。 */
  function publicDayLine(info, iso) {
    var lg = info.legal;
    if (lg) {
      if (lg.kind === 'workday_adjustment') {
        return '今天是' + lg.name + '（官方调休上班日）';
      }
      /* 规则型区域是**单日**假日（name 就是当天名），照旧「今天是X」没有歧义 */
      if (!lg.from || !lg.to || lg.from === lg.to) {
        return '今天是' + lg.name + '（法定放假日）';
      }
      /* 多日连休：说全区间 + 位置，一句都不留给模型猜 */
      return lg.name + '（' + monthDayText(lg.from) + '—' + monthDayText(lg.to) +
        '，共 ' + lg.total + ' 天）· 今天是 ' + monthDayText(iso) +
        '，是这段假期的第 ' + lg.day + ' 天';
    }
    return info.isDayOff ? '今天是普通周末' : '今天是普通工作日';
  }

  /* 主入口。返回一段可直接进 prompt 的纯文本；没有任何可说的就返回 ''（整槽不注入）。 */
  function timeFacts(charId, opts) {
    opts = opts || {};
    var at = opts.at ? new Date(opts.at) : new Date();
    var cfg = cfgOf(charId);
    var place = placeOf(charId);
    var rt = runtimeTzOf(charId);          /* 兜底级别：calendar/char/device/fallback */
    var mine = tzNow(cfg.timezone, at);
    var local = localNow(at);
    if (!mine) mine = { iso: local.iso, time: local.time, exact: true };  /* 第 5 层：连近似表都没有 → 设备本地时间 */

    var lines = [];
    var where = place.city || (DATA.TZ_LABELS && DATA.TZ_LABELS[cfg.timezone]) || cfg.timezone || '';
    lines.push('【时间事实】现在的真实时间以这里为准；不要自己编日期，也不要把它当台词念出来。');
    lines.push('你的现在：' + cnDate(mine.iso) + ' ' + mine.time +
      (where ? '（' + where + (cfg.timezone ? ' · ' + cfg.timezone : '') + '）' : '') +
      (mine.exact ? '' : '，约') +
      (rt.level === 'fallback' ? '（时区未知，暂按 UTC 计）' : ''));

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
      lines.push('公共日期（' + region.label + '）：' + publicDayLine(info, mine.iso) +
        '。它只描述客观环境，不代表你一定休息。');
      if (info.festivals.length) {
        lines.push('今天是：' + info.festivals.map(function (f) { return f.name; }).join('、') + '。');
      }
      if (!info.builtin && info.notes[0]) lines.push('（' + info.notes[0] + '）');
    }

    /* ---- 日程层：**只有开了「生成角色日程」才注入**（§14.2）---- */
    if (cfg.scheduleOn) {
      /* ⚠️ 每一条都要过 charViewOf —— 这层是**喂给 char 的**，不是给 user 看的。
         user 建的私人提醒（ownerCharId 挂在 char 名下、但 visibility='private'）
         在这里必须被挡掉，否则「只有你看得到」就成了假话。 */
      var soon = [];
      upcoming(charId, 7, mine.iso).forEach(function (x) {
        var e = x.event;
        if (!e || e.eventType === 'anniversary') return;
        var view = charViewOf(e, charId);
        if (!view) return;                       /* 他看不到 → 一个字都不给 */
        if (soon.length >= 5) return;
        soon.push({ x: x, e: e, view: view });
      });
      if (soon.length) {
        lines.push('你近期的安排：' + soon.map(function (it) {
          var e = it.e, x = it.x;
          var when = x.inDays === 0 ? '今天' : (x.inDays === 1 ? '明天' : monthDayText(x.date));
          var t = e.allDay ? '' : (' ' + timeOf(e.startAt) +
            (timeOf(e.endAt) ? '—' + timeOf(e.endAt) : ''));
          var st = e.status === 'pending'
            ? (e.eventType === 'shared_event' ? '（还没和你确认）' : '（待确认）') : '';
          /* shared_busy：只说「那会儿有事」，**不许把标题递过去** ——
             和 life-feed.js:146 同一句话，两边措辞必须一致。 */
          if (it.view === 'busy') {
            return when + t + ' 有一段时间被占住了（只显示忙，你并不知道具体是什么事）';
          }
          return when + t + ' ' + e.title + st;
        }).join('；') + '。');
        /* 2026-10-08 用户：日程是背景不是剧本 —— 别让角色被自己的
           日程锁死；跟你聊到的事、临时起意都可以打乱它。 */
        lines.push('（这些安排只是你自己的日常盘算，不是照着演的剧本——临时起意、或者聊天里冒出更要紧的事，都可以打乱它。）');
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
    /* 聊天历史时间标注（2026-10-15 方案 A）：行内戳 + 间隔事实，装配层共用 */
    histStamp: histStamp, gapLine: gapLine,
    /* 运行时时区唯一出口 + 兜底级别（2026-09-28 收尾；测试也从这里锚） */
    deviceTimezone: deviceTimezone, runtimeTzOf: runtimeTzOf,
    /* 公共日期 */
    dayInfo: dayInfo, monthGrid: monthGrid, buildYear: buildYear,
    /* 公共日期那一行的唯一出口（timeFacts 与日历页共用，避免两边各拼一次） */
    publicDayLine: publicDayLine, daysBetween: daysBetween,
    monthDayText: monthDayText,
    /* 事件 */
    eventsOf: eventsOf, eventsOn: eventsOn, visibleEventsOn: visibleEventsOn,
    occursOn: occursOn, getEvent: getEvent,
    updateEvent: updateEvent, cancelEvent: cancelEvent, removeEvent: removeEvent,
    /* 统一写入出口（第二轮施工单第二批）：UI 与执行器都只准走这里 */
    requestCreateEvent: requestCreateEvent,
    /* ⚠️ 第三轮施工单第三批：`addEvent` **已从对外导出表移除**。
       它不再是 `Sleepy.calendar.addEvent` —— 任何还想绕过统一入口直接建事件的
       生产代码，拿到的会是 `undefined` 并立刻炸出来，而不是静悄悄建成功。

       仍然保留一个入口，挂在**显式标注为内部**的命名空间下，给两类正当用途：
         · 测试夹具（scripts/smoke.js、scripts/browser-*-test.js）要造
           「故意非法」的数据 —— 缺标题、坏时间、`public_holiday` ——
           那种数据走 requestCreateEvent 会被正确地拒掉，就没法测「拒得对不对」；
         · 将来的备份导入 / 旧数据修复，需要一个不校验的落库口。
       ⚠️ 代价是它仍可被调到，所以护栏必须**对它比对顶层 addEvent 更敏感**：
       `scripts/smoke.js` 里那条静态断言扫的就是 `__internal` 这个词 ——
       生产脚本里出现 `__internal.addEvent` 立刻红（见该断言）。 */
    __internal: { addEvent: addEvent },
    CREATE_TYPES: CREATE_TYPES, CREATE_STATUS: CREATE_STATUS, CREATE_VIS: CREATE_VIS,
    /* 共同事件表态（第五批） */
    respondSharedEvent: respondSharedEvent, sharedStatusOf: sharedStatusOf,
    participantText: participantText, PSTATE: PSTATE, PSTATE_TEXT: PSTATE_TEXT,
    conflictOf: conflictOf, conflictReport: conflictReport, spanOnDay: spanOnDay, clearGenerated: clearGenerated,
    upcoming: upcoming, marks: marks,
    /* 绝对时间区间（第二轮施工单第四批）：跨午夜 / 时区 / 重复实例都在这里折 */
    minuteOfDay: minuteOfDay, dayMin: dayMin, offsetOfTz: offsetOfTz,
    deviceOffsetMin: deviceOffsetMin, spanOf: spanOf,
    /* 角色可见性的唯一出口（代理 life-feed.js:111，调不到就 fail closed） */
    charViewOf: charViewOf,
    /* 纪念日 */
    memoryFile: memoryFile, anniversaryCandidates: anniversaryCandidates,
    anniversariesOn: anniversariesOn, saveAnniversary: saveAnniversary
  };

})(window);
