/* ============================================================
   usage.js — 手机使用情况（APK 壳专属，2026-10-31 用户点名）

   数据源：安卓壳桥 SleepyNative.usageStats(days)（UsageStatsManager，
   PACKAGE_USAGE_STATS 特殊权限，用户在系统设置手动授）。本机数据，
   不出设备、不进任何云端。

   键（设备级）：
     usage  { master }   总开关（默认开 —— 关了既不显示也不注入）

   三个消费口：
     available()          壳 + 桥在不在（设置页/角色设置用它决定显不显示）
     fetch(days)          拉原始聚合（同步，壳桥直接返回 JSON 串）
     text()               prompt 注入块（prompt-engine 的 usage 槽唯一来源；
                          每角色的开关在 prompt-engine.compileUsage 里判，
                          这里只管「总开关 + 数据成不成块」）

   「刚刚用了什么」口径：last（每 app 最后一次前台时刻）在最近 60 分钟
   内的 app，按 last 倒序。「整体时长」= 窗口内前台时长总和 + 前 N 名。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  var RECENT_MS = 60 * 60 * 1000;   /* 「刚刚」= 最近 1 小时 */
  var TOPN_PROMPT = 5;              /* 注入块里最多点名的 app 数 */
  var MIN_SHOW_MS = 60 * 1000;      /* 少于 1 分钟的 app 不点名（噪音） */

  function available() {
    return !!(global.SleepyNative &&
      typeof global.SleepyNative.usageStats === 'function');
  }

  function masterOn() {
    var v = store.get('usage') || {};
    return v.master !== false;
  }

  function setMaster(v) {
    var c = store.get('usage') || {};
    c.master = !!v;
    store.set('usage', c);
  }

  /* 同步拉取。壳桥每次都现查 UsageStats（ms 级），不设过期缓存 ——
     每轮装配读一次的代价可以忽略，缓存反而会让「刚刚」变陈旧。 */
  function fetch(days) {
    if (!available()) return { ok: false, reason: 'no-bridge' };
    try {
      return JSON.parse(global.SleepyNative.usageStats(days || 1)) ||
        { ok: false, reason: 'empty' };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  }

  function fmtDur(ms) {
    var min = Math.round(ms / 60000);
    if (min < 1) return '不到 1 分钟';
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60), m = min % 60;
    return m ? (h + ' 小时 ' + m + ' 分钟') : (h + ' 小时');
  }

  /* 「刚刚」清单：最近 60 分钟内有前台记录的 app，last 倒序 */
  function recentApps(j) {
    var now = j.now || Date.now();
    var out = [];
    (j.apps || []).forEach(function (a) {
      if (a.last && now - a.last <= RECENT_MS) out.push(a);
    });
    out.sort(function (a, b) { return b.last - a.last; });
    return out;
  }

  /* prompt 注入块（线上 usage 槽）。没桥 / 总开关关 / 没授权 / 没数据
     都返回 ''，槽自动不上 —— 普通聊天照常跑。 */
  function text() {
    if (!available() || !masterOn()) return '';
    var j = fetch(1);
    if (!j || !j.ok) return '';
    var lines = [];
    var rec = recentApps(j);
    if (rec.length) {
      var names = rec.slice(0, 3).map(function (a) { return a.label; });
      lines.push('刚刚（最近一小时内）在用：' + names.join('、'));
    }
    var tops = (j.apps || []).filter(function (a) { return a.t >= MIN_SHOW_MS; })
      .slice(0, TOPN_PROMPT);
    if (tops.length) {
      lines.push('今天亮屏合计约 ' + fmtDur(j.total || 0) + '，主要用在：' +
        tops.map(function (a) { return a.label + '（' + fmtDur(a.t) + '）'; }).join('、'));
    }
    if (!lines.length) return '';
    return ['【user 的手机使用情况】下面是 user 手机系统的使用统计，' +
      'user 在设置里开了「手机使用感知」主动让 TA 知道 —— 这是双方都知情的事实，' +
      'TA 可以自然地关心或提起（比如「刚刷了半小时视频？」），但别当成监视工具逐条汇报：']
      .concat(lines).join('\n');
  }

  Sleepy.usage = {
    available: available,
    fetch: fetch,
    text: text,
    masterOn: masterOn,
    setMaster: setMaster,
    fmtDur: fmtDur,
    recentApps: recentApps
  };
})(window);
