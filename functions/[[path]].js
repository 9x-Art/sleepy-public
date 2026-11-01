/* ============================================================
   functions/[[path]].js — Pages 同源反代（2026-10-29）
   ------------------------------------------------------------
   为什么要有它：授权/仓库 Worker 住在 *.workers.dev，这个域在
   大陆网络普遍被墙（DNS 污染 + TCP 静默丢包，本机实测 connect
   21s 超时）—— iPhone 用户卡死在「激活」。但用户能打开的恰恰是
   这个 Pages 站（app 本体就是它伺服的），所以把 API 挂在同源：
   /account/* /public-shelf /item/* /inbox /publish
   反代到 worker，其余路径照常回静态资产。
   ⚠️ 发码页 /issue + /issue/claim 也要进反代（2026-10-31 补）：否则大陆用户
   领激活码这第一步还得挂 VPN 才能打开 workers.dev/issue —— 与「零 VPN 进门」
   的初衷自相矛盾。

   worker 的 CORS 是 `*`，反代后照常带 token 头，无白名单问题。
   注意：_redirects 目前只有 /index.html 一条，不会盖住 functions。

   ---- 走廊改暗门（2026-11-01，worker 用量 50% 的根治）----
   以前这里是 fetch workers.dev 公网地址 —— 机器人也扫这个地址，
   请求到达 worker 那一刻就计费（worker 内部再怎么拦都省不了配额）。
   现在：
   1) 优先走 **Service Binding**（env.API，Pages 后台配：Functions →
      Service bindings → 变量名 API → 服务 sleepy-repo）：内网直达，
      不经公网 workers.dev，绑定后 workers.dev 就可以整体关掉
      （wrangler.toml workers_dev=false + 重部署），直连扫描从此
      在边缘就吃 1016，一个请求都算不到 worker 头上。
   2) /public-shelf 加 **边缘缓存 60s**（caches.default）：缓存命中
      完全不进 worker —— 这是真人流量里最频繁的一支（进仓库页/
      换分类/搜索各一发），60s 内合并成一次。发布/下架后最多延迟
      60s 可见，可接受。
   3) 兜底保留旧 fetch（env.API 没配的过渡期照常能用）—— 所以
      **先去后台配好 Service binding，再部署 workers_dev=false**，
      顺序反了会把主路掐断。
   ============================================================ */

const API_RE = /^\/(account|public-shelf|item|inbox|publish|gate|shelf|issue|admin)(\/|$)/;
const WORKER = 'https://sleepy-repo.sleepy-goodluck.workers.dev';
const SHELF_CACHE_TTL = 60;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!API_RE.test(url.pathname)) {
    /* 非 API 路径 → 静态资产（Pages 内置 ASSETS 绑定） */
    return env.ASSETS.fetch(request);
  }

  /* /public-shelf 边缘缓存（2026-11-01）：只缓存这条最频繁的公开 GET，
     带 gate/token 的口一律不碰缓存。命中 = 零 worker 消耗。 */
  if (url.pathname === '/public-shelf' && request.method === 'GET') {
    try {
      const cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;
    } catch (e) { /* 缓存层出问题照常穿透 */ }
  }

  /* 把真实客户端 IP 带给 worker（2026-10-31 维稳）：反代子请求到 worker
     时 CF 会把 CF-Connecting-IP 重写成 CF 内部出口（2a06:98c0:…），
     worker 端限流按 IP 分桶就变成「全体用户一个桶」——几个人一起进门
     就互撞 429。这里把反代看到的真实客户端 IP 塞进自定义头；
     worker 只在直连方是 CF 内部出口时才认它（外部直连伪造无效）。 */
  const fwd = env.API
    ? new Request(request)
    : new Request(WORKER + url.pathname + url.search, request);
  fwd.headers.set('X-Forwarded-Client-IP', request.headers.get('CF-Connecting-IP') || '');
  try {
    /* env.API = Service Binding（内网直达，请求头原样带过去）；
       没配绑定 = 过渡期兜底，继续 fetch workers.dev 公网地址。 */
    const resp = env.API ? await env.API.fetch(fwd) : await fetch(fwd);

    /* 缓存回填：只存 200 的 public-shelf，标记 60s 边缘 TTL。 */
    if (url.pathname === '/public-shelf' && request.method === 'GET' && resp.status === 200) {
      try {
        const res2 = new Response(resp.body, resp);
        res2.headers.set('Cache-Control', 'public, max-age=' + SHELF_CACHE_TTL);
        context.waitUntil(caches.default.put(request, res2.clone()));
        return res2;
      } catch (e) { return resp; }
    }
    return resp;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, message: '代理层连不上授权服务器' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
