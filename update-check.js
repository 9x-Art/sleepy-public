/* ============================================================
   update-check.js — PWA 更新检测（2026-10-31 用户点名）

   APP 半边（sleepy-android 壳）2026-10-25 就有自己的 OTA（启动自动查
   + 设置手动查），这批补 web 半边：PWA / 浏览器里页面也能发现
   「线上有新版本」然后自己刷新。

   原理：
   · 部署时 gen-version.js 往副本 index.html 烙 <meta x-sleepy-build>，
     页面由此知道自己多老；version.json（永远直连网络，sw 已排除）
     报线上最新 head —— 两者 head 不一致 = 有新版。
   · 有新版：navigator.serviceWorker.getRegistration() → update() 触发
     SW 装新版（sw.js 自己 skipWaiting + claim，装完即接管）→
     短暂等待后 location.reload() —— 刷新后新 SW 伺服新缓存。
   · 防循环：sessionStorage 记上次自动刷新时刻，30s 内绝不刷第二次
     —— 万一新版还没就位（网络慢），刷新后一比还是旧的就只停手，
     不会无限 reload。

   触发点：启动后 6s 一次；页面变可见时查（10 分钟节流）；设置页
   「检查更新」手动（手动时即使没更新也回一句话，别点了没反应）。
   本地 dev（无烙印）/ file:// / 壳内（有 SleepyNative）都不启用。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var CHECK_BACKOFF = 10 * 60 * 1000;   /* 可见性触发节流：10 分钟 */
  var RELOAD_GUARD = 30 * 1000;         /* 自动刷新防循环：30 秒 */

  function ownHead() {
    var m = document.querySelector('meta[name="x-sleepy-build"]');
    if (!m) return '';
    /* build = "<短sha>-<时间戳36>"；sha 是 hex 不含 -，取第一段就是 head */
    return String(m.getAttribute('content') || '').split('-')[0] || '';
  }

  function supported() {
    return !!(ownHead() &&
      'serviceWorker' in navigator &&
      /^https?:$/.test(global.location.protocol) &&
      typeof global.SleepyNative === 'undefined');
  }

  function doReload() {
    try {
      var last = Number(global.sessionStorage.getItem('sleepyUpdReloadAt') || 0);
      if (Date.now() - last < RELOAD_GUARD) return false;
      global.sessionStorage.setItem('sleepyUpdReloadAt', String(Date.now()));
    } catch (e) { return false; }   /* sessionStorage 都没有就别自动刷了 */
    global.location.reload();
    return true;
  }

  /* 返回 'updated'（发现新版并已动手）/ 'latest'（已是最新）/ ''（没查成）。
     manual = 设置页手动触发：查不成都给 toast，别让人白点。 */
  function check(manual) {
    var head = ownHead();
    if (!head || !('serviceWorker' in navigator)) {
      if (manual) Sleepy.toast && Sleepy.toast('这个环境不用检测更新', 'dim');
      return '';
    }
    var bust = 'version.json?t=' + Date.now();
    fetch(bust, { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j || !j.head) {
        if (manual) Sleepy.toast && Sleepy.toast('没查到版本信息（网络？）', 'warn');
        return;
      }
      if (j.head === head) {
        if (manual) Sleepy.toast && Sleepy.toast('已经是最新版本', 'ok');
        return;
      }
      /* 有新版：让 SW 立刻去装新版（不等下次导航），装完就刷 */
      if (Sleepy.toast) Sleepy.toast('发现新版本，正在更新…', 'ok');
      navigator.serviceWorker.getRegistration().then(function (reg) {
        var p = reg ? reg.update() : Promise.resolve();
        p['catch'](function () { /* SW 更不动也照刷，赌它已经装好了 */ })
          .then(function () { setTimeout(doReload, 900); });
      })['catch'](function () { setTimeout(doReload, 900); });
    })['catch'](function () {
      if (manual) Sleepy.toast && Sleepy.toast('检查更新失败（网络？）', 'warn');
    });
    return 'checking';
  }

  /* ---- 触发点 ---- */
  var lastVisible = 0;
  if (supported()) {
    setTimeout(function () { check(false); }, 6000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      var now = Date.now();
      if (now - lastVisible < CHECK_BACKOFF) return;
      lastVisible = now;
      check(false);
    });
  }

  Sleepy.updatePwa = {
    supported: supported,
    check: check,
    ownHead: ownHead
  };
})(window);
