/* ============================================================
   functions/[[path]].js — Pages 同源反代（2026-10-29）
   ------------------------------------------------------------
   为什么要有它：授权/仓库 Worker 住在 *.workers.dev，这个域在
   大陆网络普遍被墙（DNS 污染 + TCP 静默丢包，本机实测 connect
   21s 超时）—— iPhone 用户卡死在「激活」。但用户能打开的恰恰是
   这个 Pages 站（app 本体就是它伺服的），所以把 API 挂在同源：
   /account/* /public-shelf /item/* /inbox /publish
   反代到 worker，其余路径照常回静态资产。

   worker 的 CORS 是 `*`，反代后照常带 token 头，无白名单问题。
   注意：_redirects 目前只有 /index.html 一条，不会盖住 functions。
   ============================================================ */

const API_RE = /^\/(account|public-shelf|item|inbox|publish|gate|shelf)(\/|$)/;
const WORKER = 'https://sleepy-repo.sleepy-goodluck.workers.dev';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!API_RE.test(url.pathname)) {
    /* 非 API 路径 → 静态资产（Pages 内置 ASSETS 绑定） */
    return env.ASSETS.fetch(request);
  }

  const target = WORKER + url.pathname + url.search;
  /* 原样转发（method/headers/body 全保留），响应原样回 —— worker 自带
     CORS `*` 与 JSON 错误体，代理层不做任何加工 */
  try {
    return await fetch(new Request(target, request));
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, message: '代理层连不上授权服务器' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
