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
   ============================================================ */

const API_RE = /^\/(account|public-shelf|item|inbox|publish|gate|shelf|issue|admin)(\/|$)/;
const WORKER = 'https://sleepy-repo.sleepy-goodluck.workers.dev';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!API_RE.test(url.pathname)) {
    /* 非 API 路径 → 静态资产（Pages 内置 ASSETS 绑定） */
    return env.ASSETS.fetch(request);
  }

  const target = WORKER + url.pathname + url.search;
  /* 把真实客户端 IP 带给 worker（2026-10-31 维稳）：反代子请求到 worker
     时 CF 会把 CF-Connecting-IP 重写成 CF 内部出口（2a06:98c0:…），
     worker 端限流按 IP 分桶就变成「全体用户一个桶」——几个人一起进门
     就互撞 429。这里把反代看到的真实客户端 IP 塞进自定义头；
     worker 只在直连方是 CF 内部出口时才认它（外部直连伪造无效）。 */
  const fwd = new Request(target, request);
  fwd.headers.set('X-Forwarded-Client-IP', request.headers.get('CF-Connecting-IP') || '');
  try {
    return await fetch(fwd);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, message: '代理层连不上授权服务器' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
