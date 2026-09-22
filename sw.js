/* ============================================================
   sw.js — Sleepy 的 Service Worker（PWA 离线壳）
   策略：**运行时缓存 + 缓存优先**，外加一次安装期的整壳预热。

   为什么要「预热」而不只靠运行时缓存：**首次访问时 SW 还没控制这个页面**，
   页面自己发的那些 <script> 请求根本不经过 fetch 处理函数 —— 一个都存不下。
   只靠运行时缓存的话，离线可用要等到**第二次**打开才成立；中间只要断网，
   用户看到的就是「有壳没 app」的残页。
   所以 install 期额外走一遍 warmShell()：读 index.html 的文本、正则出
   全部本地资源逐个塞缓存。**仍然没有写死清单** —— 脚本列表继续长也不会漏。

   更新：版本号 CACHE 一改，旧缓存整体清掉；
   skipWaiting + clients.claim 让新版立刻接管，不用关两次页面。
   （file:// 不走 SW，本来就是全离线的，两边正好互补。）

   v15（2026-09-21 第 14 批）：图片出 localStorage —— ①群头像改存图库
   （IndexedDB 的 mediaId，老 dataURL 首次显示时自动搬家）；②头像 /
   faceLockImage 之外的三处头像字段都能选本地图了（avatarFieldLocal），
   显示统一走 core.avatarSrc/setAvatarBg/setAvatarImg（本地图优先）；
   ③聊天流式输出不再每个 delta 整页重画（只更新 pending 气泡那一个
   .msg-text，长对话不再接近 O(n²)）；④密码叙事化：[手机] lock/set ——
   char 在剧情里自己设锁/改密码/去锁，旧密码进 pinHistory。
   → 必须跳版本：core.js / phone.js / prompt-engine.js / 多个 page-*.js 都改了。

   v9（2026-09-21 第 6 批）：大号按岛（2026-09-21 拍板：没有全局大号，想玩
   同一个人设就是新建一个新的人）—— 新建大号一律打当前岛的章；拆岛连岛上的
   人一起清；「移出岛」保留本体但摘掉岛的章；导入人设不再同名覆盖、导入即
   打目标岛的章；删岛确认换成 v2 抽屉（列清楚要没掉的是什么 + 提示可以先
   移出单个人）；upsertUser 新建分支补丢掉的 city/region/timezone。
   → 必须跳版本：core.js / page-idcard.js / page-island.js 都改了。

   v8（2026-09-21 第 5 批）：查手机两条 —— ①「他设没设锁屏密码」在数据层立起来了
   （`lock.enabled`，默认没设；角色设置里一个开关），没设密码的锁屏不再出现任何
   输密码入口，但仍然建会话留痕；②失败提示统一走 `api.describeError`
   （以前 7 处写 `res.message || '请求失败'`，而 requestOnce 根本没有 message 字段，
   所以超时 / HTTP 401 / 没填模型 / CORS 全被吞成同一句）；补上 phoneRawFail 的
   重试入口；「轻量 / 丰富底片」两档提示词以前一样，现在真的分开了。

   v7（2026-09-21 第 4 批）：会话列表照微信改（预览不带「对方回：/你说：」、
   只显示最后一句、时间挪到最右上角；`previewOf` 改走 splitBubblesT，
   顺手把 [译]…[/译] 标签剥掉）；聊天页只留一层滚动（.page 不再和 .msg-wrap
   抢，点内容不再往上弹）；气泡最大宽度 82% → 90%；输入区改成
   「加号 / 输入框（表情按钮挪进框里）/ 发送」一行。
   → 必须跳版本：老用户装到的主屏应用会一直用缓存里那份旧 style.css / page-chat.js。

   v6（2026-09-21 第 3 批）：聊天页的长按菜单从「整宽底部动作表」改成
   **贴着被长按气泡的锚点浮层**；引用 / 编辑 / 复制 / 收藏 全部改成只作用于
   **被点中的那一个气泡**（以前都取整轮的 `a || b || c` 串）；新增左滑引用；
   编辑框改多行 + 宽版；多选的勾只挂在每条消息的第一个气泡上；
   气泡改按内容收缩（助手气泡以前被 stretch 拉到 82% 宽）。
   → 必须跳版本：老用户装到的主屏应用会一直用缓存里那份旧 style.css / page-chat.js。

   v5（2026-09-21 第 2 批）：模型选择器从「平铺进页面」改成**锚点浮层**
   （框内自己滚 + 顶部搜索 + 选完即收），四处重复实现收敛成一个
   `ui.modelPicker` / `ui.modelPickButton`；新增 `.anchor-pop` 系列样式。
   → 必须跳版本：老用户装到的主屏应用会一直用缓存里那份旧 style.css / ui.js。

   v4（2026-09-21）：修「对话设置整页崩」「副 API 存不了」「工坊按钮没反应」
   等一批渲染 bug；聊天列表加了头像、删除改成点按变长按；PWA 图标重画
   （去掉了烤进去的圆角，manifest 主题色跟着纯白底走）。

   同时修了两个**只在弱网/已装主屏时才暴露**的坑（用户报「手机加到首页点开
   报 ERR_FAILED」时排查出来的）：
   1) 缓存兜底可能 resolve 成 undefined —— respondWith(undefined) 在 Chromium
      里就是 ERR_FAILED，页面一片空白且我们这边毫无报错。改成三级兜底：
      index.html → './' → 自带的离线页（`offlineShell()`）。
   2) install 用 addAll 是「全成功才算成功」，弱网挂一个文件就整个装不上，
      这台设备直接没有离线壳。改成逐个 add、单个失败不拦安装。
   3) **只靠运行时缓存时，离线可用要等到第二次打开才成立** —— 首次访问时
      SW 还没接管页面，页面自己发的脚本请求它一个都存不下。断网重载的结果
      是「有壳没 app」（顶部时间和底栏在、界面全空）。加 warmShell()：
      install 期读 index.html、正则出全部本地资源主动灌缓存。
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

var CACHE = 'sleepy-v96';
var CORE = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* 逐个 add，**不要用 addAll**：addAll 是「全部成功才算成功」，
         弱网下只要挂掉其中任意一个，整个 install 就 reject → SW 停在
         redundant，结果是这台设备上根本没有可用的离线壳（下次弱网打开
         就是白屏）。逐个来的话，缺哪个下次运行时缓存再补。
         2026-09-21 排查「PWA 点开 ERR_FAILED / 打不开」时改的。 */
      return Promise.all(CORE.map(function (u) {
        return c.add(u)['catch'](function () { /* 单个失败不拦整个安装 */ });
      })).then(function () { return warmShell(c); });
    }).then(function () { return self.skipWaiting(); })
  );
});

/* 把整壳（index.html 引用的全部 js/css/图标）主动灌进缓存。
   ⚠️ 为什么必须有这一步：**首次访问时 SW 还没控制这个页面**，
   页面自己发的那些 `<script src="page-*.js">` 请求根本不经过 fetch 处理函数
   —— 一个都缓存不上。所以「装完第一次打开之后整个 App 就能离线跑」
   其实是**假的**：离线重载只有 index.html 能从缓存出来，六十多个脚本
   全挂，界面上剩下一个空壳（顶部时间和底栏）。
   2026-09-21 用真机 + 断网实测抓到的（断网重载：有壳没 app）。
   做法：现场读 index.html 的文本、正则出全部本地资源逐个塞缓存 ——
   而不是在代码里写死一份清单（脚本列表一直在长，写死迟早漏）。
   第二次下载基本都命中 HTTP 缓存，所以代价很小。 */
function warmShell(c) {
  return fetch('./index.html', { cache: 'no-store' }).then(function (r) {
    if (!r || !r.ok) return null;
    c.put('./index.html', r.clone());
    return r.text();
  }).then(function (html) {
    if (!html) return null;
    var urls = [];
    var re = /(?:src|href)="(\.?\/?[^":?]+?\.(?:js|css|png|json))"/g;
    var m;
    while ((m = re.exec(html))) {
      var u = m[1];
      if (/^(https?:)?\/\//i.test(u)) continue;      /* 外站不管 */
      urls.push(u.charAt(0) === '.' ? u : './' + u);
    }
    return Promise.all(urls.map(function (u) {
      return c.match(u).then(function (hit) {
        if (hit) return null;
        return fetch(u).then(function (rr) {
          if (rr && rr.ok) return c.put(u, rr.clone());
        })['catch'](function () { /* 单个失败不拦 */ });
      });
    }));
  })['catch'](function () { /* 联网失败就算了，交给运行时缓存 */ });
}

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
