/* ============================================================
   schedule-gen.js — 每日角色日程生成器（2026-10-08 勘察轮 A1 修复）

   背景（勘察-功能通路盘点-2026-10-08 §二 A1/A2）：
   「生成角色日程」开关、注入层、月格过滤、清理函数、We 收藏提议链
   全部就绪，但**全库没有任何生产代码会产出 char_schedule 事件**
   （只有测试脚本在造数）→ 开关是死的、提议链空转。本文件补上生产者。

   · 触发：每天（自然日）每岛最多跑一轮。聊天列表打开 / 一轮回复后
     各喊一声 maybeRun()，本模块自己判断「今天跑过没」，不叠做。
   · 范围：当前岛内、按角色开了「生成角色日程」开关（cal.cfgOf().scheduleOn）
     的 char；当天已有 char_schedule 的直接跳过（幂等，不跟手动排的撞车）。
   · 生成：角色卡 + 近 15 条聊天 + 今天日期/星期/常驻地，模型排 3~5 条
     「他今天的生活日程」（本地 HH:mm + 标题 + 一句细节），JSON 输出。
   · 落库：calendar.addEvent（eventType:'char_schedule'，sourceType:'scheduleGen'，
     requestKey:'schedgen:<charId>:<day>' 带幂等键）——
     日历日程层 / We「接下来」/ We 收藏提议 / 注入层四家消费方自动接上。
   · API：主 API（candFor 同 ta-model.js 口径）。
     ★ 这是「副 API 功能多选」的候选功能之一（盘点 §六.4）：
       之后由功能勾选接管路由，本文件先留 makeMessages/parsePlan 两个
       纯函数 seam，测得到、接管得到。
   · 失败：静默；同一天内 3 小时节流后允许重试；成功记 day 并 toast 一次。
   · 语义红线：「生成角色日程」关闭 ≠ 删除（§6.3）——本模块只管生成，
     清理仍走 calendar.clearGenerated（按角色清，不动别的层）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  var KEY_STATE = 'scheduleGenState';
  var RETRY_MS = 3 * 60 * 60 * 1000;   /* 失败后当天内的重试节流 */

  function cal() { return Sleepy.calendar || null; }
  function core() { return Sleepy.core || null; }

  function todayKey() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  /* 纯函数：装配两条消息（不读全局、不发请求）——冒烟直接打表 */
  function makeMessages(input) {
    var ch = input.char;
    var sys = [
      '你是生活编排器：按角色人设和他最近的生活，给他排「今天」的日程。',
      '以他自己的生活为主（上班/买东西/在家/见别人/去常去的地方…）。',
      '「我」（user）的影响可以算进去：最近聊天里你们约好的、他答应你的、',
      '他说过要做的事，都可以排上 —— 这才像被这段关系影响过的生活；',
      '但凭空造一个聊天里没影的新约会不算数（两个人说定了才成立）。',
      '【输出】只返回一个 JSON：{"items":[{"time":"HH:mm 或空串","title":"不超过 12 个字","detail":"不超过 30 个字的一句细节"}]}',
      '3 到 5 条，按时间先后；time 用他常驻地的本地时间，没把握就留空串。',
      '只输出 JSON 本体，不要解释。'
    ].join('\n');
    var user = [
      '[今天] ' + input.dayLine + '（星期' + WEEK[input.weekday] + '）· 常驻：' + input.place,
      '[角色卡]\n' + String(ch.content || '（没有更多设定）').slice(0, 1200),
      input.chatExcerpt ? '[近期聊天]\n' + input.chatExcerpt : '[近期聊天]\n（最近没聊过什么）',
      input.existing ? '[今天已有的安排（不要再排这些）]\n' + input.existing : ''
    ].filter(Boolean).join('\n\n');
    return [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];
  }

  /* 纯函数：解析模型输出（剥 fence → JSON → 逐条校验清洗）。坏条目丢弃不补。 */
  function parsePlan(text) {
    var t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    var s = t.indexOf('{'), a = t.indexOf('[');
    var cut = (a >= 0 && (a < s || s < 0)) ? t.slice(a) : (s >= 0 ? t.slice(s) : '');
    var j = cut.lastIndexOf('}');
    var j2 = cut.lastIndexOf(']');
    var end = Math.max(j, j2);
    if (end < 0) return [];
    try {
      var data = JSON.parse(cut.slice(0, end + 1));
      var items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
      return items.map(function (it) {
        if (!it || typeof it.title !== 'string' || !it.title.trim()) return null;
        var time = String(it.time || '').trim();
        if (time && !/^\d{1,2}:\d{2}$/.test(time)) time = '';
        return {
          time: time,
          title: it.title.trim().slice(0, 16),
          detail: String(it.detail || '').trim().slice(0, 60)
        };
      }).filter(Boolean).slice(0, 5);
    } catch (e) {
      return [];
    }
  }

  /* 主体 */
  function running() { return !!Sleepy.scheduleGen.__busy; }

  function candFor() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }

  /* 今天的 char_schedule 有没有（任何来源都算：手动排的也算「有安排」） */
  function hasToday(charId) {
    var C = cal();
    if (!C || !C.eventsOn) return true;   /* 拿不到日历就不排，宁可少做 */
    var today = C.todayISO ? C.todayISO() : todayKey();
    var evs = [];
    try { evs = C.eventsOn(charId, today) || []; } catch (e) { return true; }
    return evs.some(function (e) { return e && e.eventType === 'char_schedule'; });
  }

  function recentExcerpt(charId) {
    var cs = Sleepy.chatStore;
    if (!cs || !cs.chatOf) return '';
    var chat = null;
    try { chat = cs.chatOf(charId); } catch (e) { return ''; }
    if (!chat || !Array.isArray(chat.messages)) return '';
    var ch = null;
    try { ch = core().findChar(charId); } catch (e2) { ch = null; }
    var name = (ch && ch.name) || '他';
    return (chat.messages || []).slice(-15).map(function (m) {
      var who = m.role === 'user' ? '我' : name;
      return who + '：' + String(m.type ? '（' + (m.type === 'photo' ? '发了一张照片' : '发了附件') + '）' : (m.content || '')).slice(0, 60);
    }).filter(Boolean).join('\n');
  }

  function genForChar(ch, sid) {
    var C = cal();
    var d = new Date();
    var dayLine = todayKey();
    var existing = '';
    try {
      var today = C.todayISO ? C.todayISO() : dayLine;
      existing = (C.eventsOn(ch.id, today) || [])
        .filter(function (e) { return e && e.eventType !== 'char_schedule'; })
        .map(function (e) { return String(e.title || ''); }).filter(Boolean).join('、');
    } catch (e0) { /* 忽略 */ }

    var input = {
      char: ch,
      dayLine: dayLine,
      weekday: d.getDay(),
      place: (function () {
        try { return C.placeLabel ? C.placeLabel(ch.id) : '（未设置）'; } catch (e1) { return '（未设置）'; }
      })(),
      chatExcerpt: recentExcerpt(ch.id),
      existing: existing
    };
    /* 勾了「角色日程走副 API」→ 只轮询副 API（api.js）；没勾走主 API */
    function callModel() {
      var featP = Sleepy.api.requestForFeature('schedule', makeMessages(input), {});
      if (featP) {
        return featP.then(function (r) {
          if (!r.ok) return { ok: false, error: r.error, content: null };
          return { ok: true, error: null, content: r.content };
        });
      }
      var cand = candFor();
      if (!cand) return Promise.resolve({ ok: false, error: 'noapi', content: null });
      return Sleepy.api.requestOnce(cand, makeMessages(input), {}).then(function (res) {
        if (!res.ok) return { ok: false, error: Sleepy.api.describeError(res), content: null };
        return { ok: true, error: null, content: res.content };
      });
    }
    return callModel().then(function (out) {
      if (!out.ok) return { ok: false, error: out.error };
      var items = parsePlan(out.content);
      if (!items.length) return { ok: false, error: '模型没有给出可用的日程（原文已丢弃，稍后再试）' };
      /* 落库走统一出口 requestCreateEvent（addEvent 已收回，__internal 有静态护栏）。
         · requestKey = schedgen:<charId>:<day>：统一入口自带幂等（同键返回 dup）；
         · authorizedVia = 'schedule_switch'：user 打开这个角色的日程开关，
           就是对「替他排日程」的授权（calendar.js AUTH_VIA 已登记）；
         · allowConflict：模型排的几条是他自己的生活安排，彼此时间上允许挨着，
           不做互斥（统一入口的冲突闸本来是给「共同事件邀约」用的）。 */
      var rkey = 'schedgen:' + ch.id + ':' + dayLine;
      var n = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var startAt = dayLine + 'T00:00:00';
        var allDay = !it.time;
        if (it.time) {
          var hh = parseInt(it.time.split(':')[0], 10);
          var mm = parseInt(it.time.split(':')[1], 10);
          if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
            startAt = dayLine + 'T' +
              (hh < 10 ? '0' + hh : hh) + ':' + (mm < 10 ? '0' + mm : mm) + ':00';
          } else { allDay = true; }
        }
        var r = C.requestCreateEvent({
          ownerCharId: ch.id,
          eventType: 'char_schedule',
          title: it.title,
          desc: it.detail,
          startAt: startAt,
          allDay: allDay,
          status: 'confirmed',
          createdBy: { type: 'char', id: ch.id },
          sourceType: 'scheduleGen',
          requestKey: rkey
        }, {
          requestKey: rkey,
          authorizedVia: 'schedule_switch',
          allowConflict: true
        });
        if (r && r.ok && !r.dup) n++;
        if (r && !r.ok && r.error && r.error.code === 'write-failed') {
          return { ok: false, error: r.error.message };
        }
      }
      return { ok: true, created: n };
    });
  }

  /* 入口：每天（每岛）最多一轮。调用方只管喊，节流在这里。 */
  function maybeRun() {
    if (running()) return;
    var K = core();
    var C = cal();
    if (!K || !C || !K.activeSandbox || !Sleepy.api) return;
    var sb = K.activeSandbox();
    if (!sb || !sb.id) return;
    var sid = sb.id;

    var all = store.get(KEY_STATE) || {};
    var st = all[sid] || { day: '', errAt: 0 };
    var today = todayKey();
    if (st.day === today && Date.now() - (st.errAt || 0) < RETRY_MS) return;
    /* 今天已经整轮成功过 → 直接记完成，连「该排谁的」都不用再算 */
    if (st.day === today && !st.errAt) return;

    /* 名单：本岛 + 开了开关 + 今天还没排的 char。没有就当天记完成（不再空转）。 */
    var targets = (K.charsOfSandbox(sb) || []).filter(function (ch) {
      if (!ch || !ch.id) return false;
      var on = false;
      try { on = !!(C.cfgOf(ch.id) || {}).scheduleOn; } catch (e) { on = false; }
      return on && !hasToday(ch.id);
    });
    if (!targets.length) {
      st.day = today; st.errAt = 0;
      all[sid] = st; store.set(KEY_STATE, all);
      return;
    }

    Sleepy.scheduleGen.__busy = true;
    var idx = 0;
    var created = 0;
    var failed = false;
    function step() {
      if (idx >= targets.length) return Promise.resolve();
      var ch = targets[idx++];
      return genForChar(ch, sid).then(function (r) {
        if (r && r.ok) created += (r.created || 0);
        else failed = true;
        return step();
      });
    }
    step().then(function () {
      Sleepy.scheduleGen.__busy = false;
      var all2 = store.get(KEY_STATE) || {};
      var st2 = all2[sid] || { day: '', errAt: 0 };
      st2.day = today;
      /* 全员成功才算当天收工；有失败留下 errAt，3 小时后同一天内可重试 */
      st2.errAt = failed ? Date.now() : 0;
      all2[sid] = st2;
      store.set(KEY_STATE, all2);
      if (created && Sleepy.toast) {
        Sleepy.toast('帮 TA 排好了今天的日程（' + created + ' 条），日历和 We 里能看到', 'ok');
      }
    }, function () {
      Sleepy.scheduleGen.__busy = false;
      var all3 = store.get(KEY_STATE) || {};
      var st3 = all3[sid] || { day: '', errAt: 0 };
      st3.day = today; st3.errAt = Date.now();
      all3[sid] = st3;
      store.set(KEY_STATE, all3);
    });
  }

  /* ---------------------------- 对外 ---------------------------- */
  Sleepy.scheduleGen = {
    maybeRun: maybeRun,
    makeMessages: makeMessages,   /* 纯函数 seam：冒烟 + 未来副API勾选接管 */
    parsePlan: parsePlan,         /* 纯函数 seam */
    __busy: false
  };

})(window);
