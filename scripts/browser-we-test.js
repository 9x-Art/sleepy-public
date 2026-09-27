/* ============================================================
   scripts/browser-we-test.js — We（关系沉淀空间）真机行为验收
   ------------------------------------------------------------
   复用 browser-p2-test.js 的隔离设施：真系统 Edge（headless、一次性
   profile）+ 生产源码原文（这次加载**完整生产 app**：/index.html，
   含 app.js / page-desktop.js / page-we.js / calendar.js / life-feed.js）。

   为什么必须加载完整 app：we 首页是「组合现有真实数据源」的页面
   （lifeFeed.recent + calendar.upcoming + favorites + weEntries），
   只在完整 app 里才能拿到 calendar / lifeFeed 这些挂载，idb-test 那种
   只加载底层数据层的站点测不到页面渲染。

   验证的闭环（生产路径证据，不只是静态护栏 / 桩 render）：
     W1  nav.open('we') 能打开，且没有 [Sleepy] 报错；
     W2  首页真实读取当前岛数据：关系标题出现「角色名 × 用户名」；
     W3  写一条共同记录 → weEntries 落盘带 sandboxId；
     W4  we 页面渲染出这条记录（共同记录列表可见）；
     W5  切到另一座岛 → 原记录不可见（空态「先记下一件小事」）；
     W6  回原岛 → 记录恢复；
     W7  刷新页面 → 记录仍在；
     W8  LAYOUT_VERSION === 17（桌面入口那格是 we）。
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-we-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-we-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-we-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.WE_TEST_PORT || 5199;
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
function chk(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  if (!cond) console.error('  ✗ ' + name + (extra ? '  ' + extra : ''));
  else console.log('  ✓ ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitServer() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      http.get(BASE + '/index.html', (r) => { r.resume(); r.statusCode === 200 ? res() : retry(); })
        .on('error', retry);
      function retry() {
        if (Date.now() - t0 > 15000) rej(new Error('测试站点起不来'));
        else setTimeout(poll, 250);
      }
    })();
  });
}

/* 生产 app 启动是异步的（bootHome 渲染桌面）。轮询到核心挂载可用为止。
   同时收集 [Sleepy] 报错 —— 那是 logError 的唯一前缀（app.js 错误边界）。 */
async function waitApp(page) {
  const sleepyErrs = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (t && t.indexOf('[Sleepy]') >= 0) sleepyErrs.push(t.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => {
    const t = String(e && e.message || e);
    if (t.indexOf('[Sleepy]') >= 0) sleepyErrs.push(t.slice(0, 300));
  });
  await page.waitForFunction(() => {
    const S = window.Sleepy;
    return !!(S && S.nav && S.core && S.core.activeSandbox && S.weStore && S.nav.open);
  }, null, { timeout: 20000 });
  /* bootHome 桌面渲染 + splash 收尾，截图驱动一下无头 freeze 的定时器 */
  await sleep(600);
  await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-boot.png') }).catch(() => {});
  return sleepyErrs;
}

/* 用生产 core API 在页面里建一座岛 + 大号 + 马甲，并切好身份。返回建好的 id。 */
async function seedIsland(page, name) {
  return page.evaluate((nm) => {
    const S = window.Sleepy;
    const sb = S.core.createSandbox('isle', nm);
    const m = S.core.upsertChar({ name: nm + '大号', kind: 'main' }).id;
    const u = S.core.upsertUser({ name: '我' });
    S.core.setSandboxChars(sb.id, [m]);
    S.core.setSandboxMasks(sb.id, [u.id]);
    return { sb: sb.id, m, u: u.id };
  }, name);
}

function weText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.page[data-page="we"]');
    if (!el) return '';
    return el.textContent || '';
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    /* ?splash=0：splash.js 三条早退之一，bail 不黑屏；cb 破缓存 */
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);

    /* ---- 布置：岛 A（有角色+马甲+身份）、岛 B（空参照） ---- */
    const A = await seedIsland(page, '甲');
    const B = await seedIsland(page, '乙');

    /* 切到 A 岛，写一条共同记录（带 sandboxId） */
    const entry = await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
      return S.weStore.add({ title: '一起看过海', note: '在码头吹了整晚风', at: Date.now() }, a.sb);
    }, A);

    /* W1：nav.open('we') 能打开 */
    await page.evaluate(() => window.Sleepy.nav.open('we'));
    await sleep(200);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-a.png') });
    chk('W1 nav.open(we) 打开且无 [Sleepy] 报错',
      sleepyErrs.filter((l) => l.indexOf('page-we') >= 0).length === 0 &&
      (await page.evaluate(() => !!document.querySelector('.page[data-page="we"]'))),
      'sleepyErrs=' + JSON.stringify(sleepyErrs));

    /* W3：落盘带 sandboxId */
    chk('W3 写入带 sandboxId', !!entry && entry.sandboxId === A.sb,
      'sb=' + A.sb + ' 实际=' + (entry && entry.sandboxId) + ' createdBy=' + (entry && entry.createdBy));

    /* W2 + W4：关系标题含角色名，列表渲染出记录 */
    const txtA = await weText(page);
    chk('W2 关系标题出现「角色名 × 我」', txtA.indexOf('甲大号') >= 0 && txtA.indexOf('× 我') >= 0,
      txtA.slice(0, 120).replace(/\n+/g, ' '));
    chk('W4 共同记录列表渲染出刚写的记录', txtA.indexOf('一起看过海') >= 0 && txtA.indexOf('在码头吹了整晚风') >= 0,
      '');

    /* W5：切到乙岛 + 刷新栈顶页 → 原记录不可见 */
    await page.evaluate((b) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(b.sb);
      S.core.switchTo(b.m, b.u);
      const t = S.nav.topCtx();
      if (t && t.refresh) t.refresh();
    }, B);
    await sleep(200);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-b.png') });
    const txtB = await weText(page);
    chk('W5 切到乙岛后原记录不可见（空态）',
      txtB.indexOf('一起看过海') < 0 && txtB.indexOf('先记下一件小事') >= 0,
      '');

    /* W6：回甲岛 + 刷新 → 记录恢复 */
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
      const t = S.nav.topCtx();
      if (t && t.refresh) t.refresh();
    }, A);
    await sleep(200);
    const txtA2 = await weText(page);
    chk('W6 回甲岛后记录恢复', txtA2.indexOf('一起看过海') >= 0, '');

    /* W7：刷新页面（localStorage 持久）→ 记录仍在 */
    await page.reload({ waitUntil: 'load' });
    const sleepyErrs2 = await waitApp(page);
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
    }, A);
    await page.evaluate(() => window.Sleepy.nav.open('we'));
    await sleep(200);
    const txtR = await weText(page);
    chk('W7 刷新后记录仍在', txtR.indexOf('一起看过海') >= 0, '');

    /* W8：LAYOUT_VERSION 17 + 桌面 we 入口 */
    const layout = await page.evaluate(() => {
      const d = window.Sleepy.store.get('desktop');
      let hasWe = false, ver = d && d.version;
      if (d && Array.isArray(d.pages)) {
        d.pages.forEach((p) => { (p || []).forEach((c) => { if (c && c.app === 'we') hasWe = true; }); });
      }
      return { ver, hasWe };
    });
    chk('W8 LAYOUT_VERSION 17 生效且桌面有 we 入口',
      layout.ver === 17 && layout.hasWe, 'ver=' + layout.ver + ' hasWe=' + layout.hasWe);

    /* ---- 汇总 ---- */
    console.log('\n--- We 真机闭环汇总 ---');
    const okN = results.filter((r) => r.ok).length;
    results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.extra ? '  → ' + r.extra : '')));
    console.log(okN + '/' + results.length + ' 通过');
    if (okN !== results.length) process.exit(1);
  } catch (e) {
    console.error('✗ 测试抛错：' + (e && e.stack || e));
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
}

main();
