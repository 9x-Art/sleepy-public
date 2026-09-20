/* ============================================================
   sw.js — Sleepy 的 Service Worker（PWA 离线壳）
   策略：**运行时缓存 + 缓存优先**。
   不在安装期写死文件清单 —— index.html 的脚本列表会一直长，
   维护两份清单迟早漏一个。改成「第一个请求谁就存谁」，
   装完第一次打开之后整个 App 就能离线跑（file:// 不走 SW，
   本来就是全离线的，两边正好互补）。

   更新：版本号 CACHE 一改，旧缓存整体清掉；
   skipWaiting + clients.claim 让新版立刻接管，不用关两次页面。

   v3（2026-09-18）：第 2 屏接上亚克力挂件灯，新增 vendor/（three + 灯核心）。
   它**不写进 CORE**：671 KB 的引擎塞进安装期预缓存，会让第一次装 SW
   白等好几秒，而灯在第 2 屏 —— 很多人一轮都不一定滑过去。
   交给下面那条「第一个请求谁就存谁」的运行时缓存，第一次滑到第 2 屏时再落盘，
   之后离线也能点亮。

   v2（2026-09-17）：配色整体换成纯白 + 玻璃，视觉全表重写。
   版本号必须跟着跳 —— 不跳的话老用户装到的主屏应用会一直用
   缓存里那份旧 style.css，看到的是上一版米白皮肤。
   ============================================================ */
'use strict';

var CACHE = 'sleepy-v63';
var CORE = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  /* 只管自己家 —— 接口请求（聊天/生图打给外站的）一律放行直连 */
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        /* 后台悄悄更新一份（stale-while-revalidate），下次打开就是新的 */
        fetch(req).then(function (r) {
          if (r && r.ok) caches.open(CACHE).then(function (c) { c.put(req, r); });
        })['catch'](function () { /* 离线就算了 */ });
        return hit;
      }
      return fetch(req).then(function (r) {
        if (r && r.ok) {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return r;
      })['catch'](function () {
        /* 完全没缓存又离线：导航请求兜底回 index.html（PWA 的壳） */
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
