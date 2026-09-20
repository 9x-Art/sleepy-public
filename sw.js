/* ============================================================
   sw.js — Sleepy 的 Service Worker（PWA 离线壳）
   策略：**运行时缓存 + 缓存优先**。
   不在安装期写死文件清单 —— index.html 的脚本列表会一直长，
   维护两份清单迟早漏一个。改成「第一个请求谁就存谁」，
   装完第一次打开之后整个 App 就能离线跑（file:// 不走 SW，
   本来就是全离线的，两边正好互补）。

   更新：版本号 CACHE 一改，旧缓存整体清掉；
   skipWaiting + clients.claim 让新版立刻接管，不用关两次页面。

   v4（2026-09-21）：修「对话设置整页崩」「副 API 存不了」「工坊按钮没反应」
   等一批渲染 bug；聊天列表加了头像、删除改成点按变长按；PWA 图标重画
   （去掉了烤进去的圆角，manifest 主题色跟着纯白底走）。
   → 必须跳版本：图标和 manifest 被缓存住的话，主屏上还是旧图标旧配色。

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

var CACHE = 'sleepy-v64';
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
        /* 完全没缓存又离线：导航请求兜底回外壳页。
           ⚠️ 这里**绝不能 resolve 成 undefined** —— respondWith(undefined)
           在 Chromium 里就是 ERR_FAILED，用户看到的是「嗯…无法访问此页面」
           加一个错误码，而我们这边什么都没报错，极难定位。
           2026-09-21 就是踩在这上面：手机上加到首页的 PWA 点开 ERR_FAILED。
           所以做三级兜底：index.html → './' → 一张自带的离线页。 */
        if (req.mode === 'navigate') {
          return caches.match('./index.html')
            .then(function (r) { return r || caches.match('./'); })
            .then(function (r) { return r || offlineShell(); });
        }
        return Response.error();
      });
    })
  );
});

/* 彻底没缓存又连不上时的兜底页。自带文案、不依赖网络 ——
   有它就不会再出现 respondWith(undefined) → ERR_FAILED 那种一片空白，
   用户至少知道「是网络，不是 app 坏了」。 */
function offlineShell() {
  var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Sleepy</title></head>' +
    '<body style="margin:0;display:flex;min-height:100vh;align-items:center;' +
    'justify-content:center;background:#FFFFFF;color:#43382C;' +
    'font:15px/1.7 system-ui,sans-serif;text-align:center">' +
    '<div style="padding:32px">' +
    '<p style="font-size:17px;margin:0 0 10px">连不上，本地也还没有缓存</p>' +
    '<p style="margin:0;color:#8A7A67">第一次打开需要联网。' +
    '加载过一次之后，再到桌面打开就能离线用了。</p>' +
    '<p style="margin:16px 0 0;color:#8A7A67"><button ' +
    'onclick="location.reload()" style="font:inherit;color:#8A6844;' +
    'background:none;border:0;border-bottom:1px solid currentColor;' +
    'padding:0 0 1px;cursor:pointer">再试一次</button></p>' +
    '</div></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
