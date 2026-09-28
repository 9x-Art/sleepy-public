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

    /* ==================== 三页导航 + 时光 v1（2026-09-28） ==================== */

    const tabInfo = (page) => page.evaluate(() => {
      const S = window.Sleepy;
      /* .page.is-active 不可靠（home 基底也挂着 is-active）—— 按 nav.top() 定位 */
      const active = document.querySelector('.page[data-page="' + S.nav.top() + '"]');
      const bar = active && active.querySelector('.we-tabbar');
      if (!bar) return { has: false, top: S.nav.top() };
      const tabs = Array.from(bar.querySelectorAll('.we-tab')).map((b) => ({
        id: b.__weTabId,
        on: b.classList.contains('is-on'),
        cur: b.getAttribute('aria-current') === 'page'
      }));
      const add = bar.querySelector('.we-tab-add');
      return {
        has: true, tabs,
        addLabel: add ? add.getAttribute('aria-label') : null,
        depth: S.nav.depth(), top: S.nav.top(),
        histLen: history.length,
        barsInActive: active.querySelectorAll('.we-tabbar').length
      };
    });
    const clickTab = async (page, id) => {
      /* 按 nav.top() 定位当前页的底栏（.page.is-active 连 home 都算，
         不可靠），点击 + 落地确认，最多重试三次 */
      for (let i = 0; i < 3; i++) {
        await page.evaluate((tid) => {
          const btns = document.querySelectorAll('.page[data-page="' + window.Sleepy.nav.top() + '"] .we-tabbar .we-tab');
          for (const b of btns) { if (b.__weTabId === tid) { b.click(); return; } }
        }, id);
        await sleep(300);
        const top = await page.evaluate(() => window.Sleepy.nav.top());
        if (top === id) return true;
      }
      return false;
    };

    /* W9：首页底栏结构（三 Tab + ＋ 动作 + 首页高亮） */
    await sleep(200);
    const w9 = await tabInfo(page);
    chk('W9 首页挂底栏：三 Tab + ＋（记一条共同记录）+ 首页高亮',
      w9.has && w9.tabs.length === 3 &&
      w9.tabs[0].id === 'we' && w9.tabs[0].on && w9.tabs[0].cur &&
      w9.tabs[1].id === 'we-time' && !w9.tabs[1].on &&
      w9.tabs[2].id === 'collection' && !w9.tabs[2].on &&
      w9.addLabel === '记一条共同记录' && w9.barsInActive === 1,
      JSON.stringify(w9));

    /* W10：切时光 —— replace 栈深不变，时光页渲染出真实共同记录 */
    const hist0 = w9.histLen;
    await clickTab(page, 'we-time');
    await sleep(250);
    const w10 = await tabInfo(page);
    const timeTxt = await page.evaluate(() =>
      (document.querySelector('.page[data-page="we-time"]') || {}).textContent || '');
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-time.png') });
    chk('W10 时光 Tab：replace 栈深不变、时光高亮、记录进列表',
      w10.top === 'we-time' && w10.depth === 1 && w10.tabs[1].on &&
      timeTxt.indexOf('一起看过海') >= 0 && timeTxt.indexOf('共同记录') >= 0,
      JSON.stringify({ top: w10.top, depth: w10.depth, tabs: w10.tabs }) + ' txt=' + timeTxt.slice(0, 80));

    /* W11：切收藏馆 —— 门厅渲染 + 收藏馆高亮，仍不涨栈 */
    await clickTab(page, 'collection');
    await sleep(250);
    const w11 = await tabInfo(page);
    const hallTxt = await page.evaluate(() =>
      (document.querySelector('.page[data-page="collection"]') || {}).textContent || '');
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-collection.png') });
    chk('W11 收藏馆 Tab：门厅渲染、高亮正确、栈深不变',
      w11.top === 'collection' && w11.depth === 1 && w11.tabs[2].on &&
      hallTxt.indexOf('收藏馆') >= 0,
      JSON.stringify({ top: w11.top, depth: w11.depth }));

    /* W12：反复切换 5 轮 —— 栈深不动、浏览器历史不涨、每页只有一份 bar */
    for (let i = 0; i < 5; i++) {
      await clickTab(page, 'we'); await sleep(120);
      await clickTab(page, 'we-time'); await sleep(120);
      await clickTab(page, 'collection'); await sleep(120);
    }
    const w12 = await tabInfo(page);
    const barCount = await page.evaluate(() =>
      document.querySelectorAll('.page .we-tabbar').length);
    const barPer = await page.evaluate(() => {
      const out = {};
      ['we', 'we-time', 'collection'].forEach((id) => {
        const el = document.querySelector('.page[data-page="' + id + '"]');
        out[id] = el ? el.querySelectorAll('.we-tabbar').length : -1;
      });
      return out;
    });
    chk('W12 反复切换：栈深 1、历史不涨、每页 bar 恰一份（挂载幂等）',
      w12.depth === 1 && w12.top === 'collection' &&
      w12.histLen - hist0 === 0 && barCount === 3 &&
      barPer.we === 1 && barPer['we-time'] === 1 && barPer.collection === 1,
      JSON.stringify({ depth: w12.depth, histDelta: w12.histLen - hist0, barCount, barPer }));

    /* W13：＋ 打开抽屉、取消无写入（同一个新增抽屉） */
    const cnt0 = await page.evaluate(() => window.Sleepy.store.get('weEntries').length);
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="' + window.Sleepy.nav.top() + '"] .we-tabbar .we-tab-add');
      if (b) b.click();
    });
    await sleep(150);
    const drawerOpen = await page.evaluate(() => !!document.querySelector('.we-drawer-sheet'));
    await page.evaluate(() => {
      const b = document.querySelector('.we-drawer-close');
      if (b) b.click();
    });
    await sleep(100);
    const cnt1 = await page.evaluate(() => window.Sleepy.store.get('weEntries').length);
    chk('W13 ＋ 打开同一抽屉、取消不写数据',
      drawerOpen && cnt0 === cnt1, 'drawer=' + drawerOpen + ' cnt=' + cnt0 + '→' + cnt1);

    /* W14：时光条目点击 → 现有详情实现（collection-item），二级页无底栏，返回回时光 */
    await clickTab(page, 'we-time');
    await sleep(200);
    await page.evaluate(() => {
      const items = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const it of items) {
        if ((it.textContent || '').indexOf('一起看过海') >= 0) { it.click(); return; }
      }
    });
    await sleep(250);
    const w14a = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="' + window.Sleepy.nav.top() + '"]');
      return { top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
        cls: el ? el.getAttribute('data-page') : '',
        hasBar: !!(el && el.querySelector('.we-tabbar')) };
    });
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(350);
    const w14b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    chk('W14 记录点击进藏品详情（无底栏）、返回回时光（实际来源页）',
      w14a.cls === 'collection-item' && w14a.depth === 2 && !w14a.hasBar &&
      w14b.top === 'we-time' && w14b.depth === 1,
      JSON.stringify({ a: w14a, b: w14b }));

    /* W15：窄屏（320×568）三主页面可达 + 底部不裁切 */
    const page2 = await ctx.newPage();
    await page2.setViewportSize({ width: 320, height: 568 });
    await page2.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    await waitApp(page2);
    await page2.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb); S.core.switchTo(a.m, a.u);
      S.nav.open('we');
    }, A);
    await sleep(250);
    for (const id of ['we-time', 'collection', 'we']) {
      await page2.evaluate((tid) => {
        const btns = document.querySelectorAll('.page[data-page="' + window.Sleepy.nav.top() + '"] .we-tabbar .we-tab');
        for (const b of btns) { if (b.__weTabId === tid) { b.click(); return; } }
      }, id);
      await sleep(200);
      await page2.evaluate(() => {
        const body = document.querySelector('.page[data-page="' + window.Sleepy.nav.top() + '"] .app-body');
        if (body) body.scrollTop = body.scrollHeight;
      });
      await sleep(120);
    }
    await page2.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-narrow.png') });
    const w15 = await page2.evaluate(() => {
      const active = document.querySelector('.page[data-page="' + window.Sleepy.nav.top() + '"]');
      const bar = active.querySelector('.we-tabbar');
      const barR = bar.getBoundingClientRect();
      const phone = document.getElementById('phone').getBoundingClientRect();
      return {
        barBottom: Math.round(barR.bottom), phoneBottom: Math.round(phone.bottom),
        onTab: (bar.querySelector('.we-tab.is-on') || {}).__weTabId || ''
      };
    });
    chk('W15 窄屏 320×568：底栏贴住 #phone 底沿、首页高亮、可达',
      w15.barBottom <= w15.phoneBottom + 1 && w15.barBottom >= w15.phoneBottom - 3 && w15.onTab === 'we',
      JSON.stringify(w15));
    await page2.close();

    /* ==================== 收尾补测（2026-09-28 第二轮） ==================== */

    /* W16：普通 Tab 切换保留滚动位置 —— 页面实例与 .app-body 元素都复用，
       paint 存/还 scrollTop；先记下钳位后的实际值，往返后必须一致 */
    await clickTab(page, 'we');
    await sleep(250);
    const st0 = await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we"] .app-body');
      b.scrollTop = 420;
      return b.scrollTop;                      /* 实际落点（可能被钳位） */
    });
    await clickTab(page, 'we-time');
    await sleep(250);
    await clickTab(page, 'we');
    await sleep(250);
    const st1 = await page.evaluate(() =>
      document.querySelector('.page[data-page="we"] .app-body').scrollTop);
    chk('W16 切 Tab 往返后滚动位置保留', st0 > 50 && Math.abs(st1 - st0) <= 2,
      '去=' + st0 + ' 回=' + st1);

    /* W17：超过首批条数连续加载不漏不重（现存 1 条 + 34 条批量 = 35 条） */
    await page.evaluate(() => {
      const S = window.Sleepy;
      const t0 = Date.now();
      for (let i = 0; i < 34; i++) {
        S.weStore.add({ title: '批量' + i, note: 'n' + i, at: t0 - (i + 1) * 60000 }, S.core.scopeId());
      }
    });
    await clickTab(page, 'we-time');
    await sleep(250);
    const w17a = await page.evaluate(() => ({
      n: document.querySelectorAll('.page[data-page="we-time"] .we-time-item').length,
      more: !!document.querySelector('.page[data-page="we-time"] .we-time-more')
    }));
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we-time"] .we-time-more');
      if (b) b.click();
    });
    await sleep(250);
    const w17b = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.page[data-page="we-time"] .we-time-item'));
      const titles = els.map((e) => (e.querySelector('.co-card-title') || {}).textContent || '');
      return { n: els.length, uniq: new Set(titles).size,
        earliest: titles.indexOf('批量33') >= 0, latest: titles.indexOf('批量0') >= 0,
        more: !!document.querySelector('.page[data-page="we-time"] .we-time-more') };
    });
    chk('W17 35 条分批：首批 30 + 加载更多；展开后 35 条不漏不重',
      w17a.n === 30 && w17a.more && w17b.n === 35 && w17b.uniq === 35 &&
      w17b.earliest && w17b.latest && !w17b.more,
      JSON.stringify({ first: w17a, all: w17b }));

    /* W18：聚合失败 → 明确报错（不是空态）→ 重试恢复 */
    await page.evaluate(() => {
      const S = window.Sleepy;
      S.__origAll = S.momentsTab.all;
      S.momentsTab.all = function () { throw new Error('boom'); };
    });
    await clickTab(page, 'we');
    await sleep(150);
    await clickTab(page, 'we-time');
    await sleep(250);
    const w18a = await page.evaluate(() => {
      const t = document.querySelector('.page[data-page="we-time"]').textContent;
      return { fail: t.indexOf('时光暂时读不出来') >= 0,
        fakeEmpty: t.indexOf('还没有一起经过的片段') >= 0 };
    });
    await page.evaluate(() => { window.Sleepy.momentsTab.all = window.Sleepy.__origAll; });
    await page.evaluate(() => {
      const btns = document.querySelectorAll('.page[data-page="we-time"] button');
      for (const b of btns) { if ((b.textContent || '') === '重试') { b.click(); return; } }
    });
    await sleep(250);
    const w18b = await page.evaluate(() => {
      const t = document.querySelector('.page[data-page="we-time"]').textContent;
      return { recovered: t.indexOf('时光暂时读不出来') < 0 && t.indexOf('批量0') >= 0,
        stillFail: t.indexOf('时光暂时读不出来') >= 0 };
    });
    chk('W18 聚合失败显示报错+重试（不冒充空数据），恢复后列表回来',
      w18a.fail && !w18a.fakeEmpty && w18b.recovered, JSON.stringify(w18b));

    /* W19：底栏 ＋ 保存成功 → 抽屉关、只写一条、时光立即出现新条目 */
    const cnt19 = await page.evaluate(() => window.Sleepy.store.get('weEntries').length);
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we-time"] .we-tabbar .we-tab-add');
      if (b) b.click();
    });
    await sleep(150);
    await page.evaluate(() => {
      const sheet = document.querySelector('.we-drawer-sheet');
      const inp = sheet.querySelector('input');
      const ta = sheet.querySelector('textarea');
      if (inp) { inp.value = '收尾新增的一条'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      if (ta) { ta.value = '收尾测试写一句'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await page.evaluate(() => {
      const btns = document.querySelectorAll('.we-drawer-sheet button');
      for (const b of btns) { if ((b.textContent || '').indexOf('保存到共同记录') >= 0) { b.click(); return; } }
    });
    await sleep(300);
    const w19 = await page.evaluate((c0) => {
      const cnt = window.Sleepy.store.get('weEntries').length;
      const t = document.querySelector('.page[data-page="we-time"]').textContent;
      return { closed: !document.querySelector('.we-drawer-sheet'),
        added: t.indexOf('收尾新增的一条') >= 0, delta: cnt - c0 };
    }, cnt19);
    chk('W19 保存成功：抽屉关、恰好 +1 条、时光立即刷新可见',
      w19.closed && w19.added && w19.delta === 1, JSON.stringify(w19));

    /* W20：来源删除 / 无权 / 旧日记 —— 聚合层排除 + 点击预检反馈 */
    const mid = await page.evaluate(() => {
      const S = window.Sleepy;
      return S.momentsTab.add({ text: '待删动态定位', characterId: S.core.activeCharOnIsland().id, at: Date.now() - 300000 }).id;
    });
    await page.evaluate(() => window.Sleepy.nav.topCtx().refresh());
    await sleep(200);
    const w20shown = await page.evaluate(() =>
      document.querySelector('.page[data-page="we-time"]').textContent.indexOf('待删动态定位') >= 0);
    await page.evaluate((id) => window.Sleepy.momentsTab.remove(id), mid);  /* 只删存储，DOM 残留 */
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const e of els) { if ((e.textContent || '').indexOf('待删动态定位') >= 0) { e.click(); return; } }
    });
    await sleep(200);
    const w20a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(),
      toast: (document.getElementById('toast') || {}).textContent || ''
    }));
    await page.evaluate(() => window.Sleepy.nav.topCtx().refresh());
    await sleep(150);
    const w20b = await page.evaluate(() => {
      const S = window.Sleepy;
      /* TA 的私密动态（privacy self）：user 视角不可见 → 不进时光 */
      S.momentsTab.add({ text: 'TA的私密动态不进时光', characterId: S.core.activeCharOnIsland().id, privacy: 'self', at: Date.now() - 600000 });
      /* 缺 userId 的旧日记：fail closed → 不进时光 */
      const it = S.core.tagScope({ id: 'dold' + Date.now().toString(36), content: '旧日记没有归属', timestamp: Date.now() - 700000, status: 'written', author: 'user' });
      const list = S.store.get('diaries'); list.push(it); S.store.set('diaries', list);
      S.nav.topCtx().refresh();
      const t = document.querySelector('.page[data-page="we-time"]').textContent;
      return { noPrivate: t.indexOf('TA的私密动态不进时光') < 0,
        noOld: t.indexOf('旧日记没有归属') < 0, gone: t.indexOf('待删动态定位') < 0 };
    });
    chk('W20 删除/无权/旧数据：删除后消失、残留点击被预检拦下（toast，不跳页）、私密与旧日记不越权',
      w20shown && w20a.top === 'we-time' && w20a.toast.indexOf('不在了') >= 0 &&
      w20b.gone && w20b.noPrivate && w20b.noOld,
      JSON.stringify({ shown: w20shown, a: w20a, b: w20b }));

    /* W21：来源定位 —— 朋友圈 / 日记落到具体记录（data-id + 高亮） */
    const mid2 = await page.evaluate(() => {
      const S = window.Sleepy;
      return S.momentsTab.add({ text: '定位测试的动态', characterId: S.core.activeCharOnIsland().id, at: Date.now() - 200000 }).id;
    });
    await page.evaluate(() => window.Sleepy.nav.topCtx().refresh());
    await sleep(200);
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const e of els) { if ((e.textContent || '').indexOf('定位测试的动态') >= 0) { e.click(); return; } }
    });
    await sleep(300);
    /* 定位成功的判据 = 目标真的滚进了滚动容器可视区域，不只看 DOM/类名 */
    const visInScroller = (el) => {
      let c = el.parentNode;
      while (c && c !== document.body) {
        const cs = getComputedStyle(c);
        if (/(auto|scroll)/.test(cs.overflowY) && c.scrollHeight > c.clientHeight && c.clientHeight > 0) break;
        c = c.parentNode;
      }
      if (!c || c === document.body) return false;
      const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
      return r.top >= cr.top - 2 && r.bottom <= cr.bottom + 2;
    };
    /* 定位可视性判据注入页面，W21 复用：有滚动容器看容器，整页不滚就看 #phone 视口 */
    await page.evaluate(() => {
      window.__weVis = (el) => {
        let c = el.parentNode, box = null;
        while (c && c !== document.body) {
          const cs = getComputedStyle(c);
          if (/(auto|scroll)/.test(cs.overflowY) && c.scrollHeight > c.clientHeight && c.clientHeight > 0) { box = c; break; }
          c = c.parentNode;
        }
        if (!box) box = document.getElementById('phone');
        if (!box) return false;
        const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
        return r.top >= br.top - 2 && r.bottom <= br.bottom + 2;
      };
    });
    const w21a = await page.evaluate((id) => {
      const el = document.querySelector('.page[data-page="moments"] .moment-item[data-id="' + id + '"]');
      let dbg = null;
      if (el) {
        let c = el.parentNode;
        while (c && c !== document.body) {
          const cs = getComputedStyle(c);
          if (/(auto|scroll)/.test(cs.overflowY) && c.scrollHeight > c.clientHeight && c.clientHeight > 0) break;
          c = c.parentNode;
        }
        const r = el.getBoundingClientRect(), cr = c && c.getBoundingClientRect();
        dbg = { scroller: c && (c.className || c.tagName), rT: Math.round(r.top), rB: Math.round(r.bottom),
          cT: Math.round(cr.top), cB: Math.round(cr.bottom), cST: c.scrollTop };
      }
      return { top: window.Sleepy.nav.top(), has: !!el,
        flash: !!(el && el.classList.contains('we-jump-flash')),
        vis: !!(el && window.__weVis(el)), dbg };
    }, mid2);
    const did = await page.evaluate(() => {
      const S = window.Sleepy;
      const it = S.core.tagScope({ id: 'djump' + Date.now().toString(36), content: '定位测试的一篇日记', timestamp: Date.now() - 100000, status: 'written', author: 'user' });
      it.userId = S.core.activeUserOnIsland().id;
      const list = S.store.get('diaries'); list.push(it); S.store.set('diaries', list);
      return it.id;
    });
    /* 朋友圈页有 onBack 守卫（非消息 tab 先切回消息 tab，聊天 App 既有语义），
       nav.back() 不会回时光 —— 测试里用 closeTo(0) 退回 we-time。 */
    await page.evaluate(() => window.Sleepy.nav.closeTo(0));
    await sleep(500);
    await page.evaluate(() => window.Sleepy.nav.topCtx().refresh());
    await sleep(200);
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const e of els) { if ((e.textContent || '').indexOf('定位测试的一篇日记') >= 0) { e.click(); return; } }
    });
    await sleep(300);
    const w21b = await page.evaluate((id) => {
      const el = document.querySelector('.page[data-page="diary"] .dia-paper[data-id="' + id + '"]');
      return { top: window.Sleepy.nav.top(), has: !!el,
        flash: !!(el && el.classList.contains('we-jump-flash')),
        vis: !!(el && window.__weVis(el)) };
    }, did);
    chk('W21 来源定位：朋友圈/日记跳到具体那条（存在 + 高亮 + 落进可视区域）',
      w21a.top === 'moments' && w21a.has && w21a.flash && w21a.vis &&
      w21b.top === 'diary' && w21b.has && w21b.flash && w21b.vis,
      JSON.stringify({ m: w21a, d: w21b }));

    /* W22：正文入口 push 的收藏馆 → Tab 首页退回一层（目标在栈内分支）。
       先清栈到干净状态（前面积累了详情/来源页），避免多层 closeTo 的
       异步 popstate 竞态污染断言。 */
    await page.evaluate(() => { window.Sleepy.nav.closeAll(); });
    await sleep(200);
    await page.evaluate(() => { window.Sleepy.nav.open('we'); });
    await sleep(300);
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we"] .we-fav-btn');
      if (b) b.click();
    });
    await sleep(300);
    const w22a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    await clickTab(page, 'we');
    await sleep(400);
    const w22b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    chk('W22 正文入口 push 收藏馆（depth2）→ Tab 首页正确退回一层',
      w22a.top === 'collection' && w22a.depth === 2 &&
      w22b.top === 'we' && w22b.depth === 1, JSON.stringify({ a: w22a, b: w22b }));

    /* W23：缩略图真实加载 / 失败占位 / 切岛旧响应不落新视图 */
    await page.evaluate(async () => {
      const S = window.Sleepy;
      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 8;
      const c2 = canvas.getContext('2d');
      c2.fillStyle = '#B08A5E'; c2.fillRect(0, 0, 8, 8);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const mid = await S.media.put(blob, { name: '测试图', kind: 'photo' });
      S.momentsTab.add({ text: '带图的真实动态', characterId: S.core.activeCharOnIsland().id, mediaId: mid, at: Date.now() - 500000 });
      S.momentsTab.add({ text: '坏图占位动态', characterId: S.core.activeCharOnIsland().id, mediaId: 'media-nope', at: Date.now() - 490000 });
      return mid;
    });
    await clickTab(page, 'we-time');
    await sleep(600);   /* objectURL 异步 */
    const w23a = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.page[data-page="we-time"] .we-time-item'));
      const good = items.find((e) => (e.textContent || '').indexOf('带图的真实动态') >= 0);
      const bad = items.find((e) => (e.textContent || '').indexOf('坏图占位动态') >= 0);
      const gt = good && good.querySelector('.we-time-thumb');
      const bt = bad && bad.querySelector('.we-time-thumb');
      const S = window.Sleepy;
      const charNow = S.core.activeCharOnIsland();
      const userNow = S.core.activeUserOnIsland();
      const mo = S.weTime.collect(charNow, userNow).filter((x) => x.src === 'moments');
      return { total: items.length, moN: mo.length,
        top: S.nav.top(),
        memo: JSON.parse(JSON.stringify(S.nav.topCtx().__weTimeMemo || null)),
        goodHas: !!gt,
        goodLoaded: !!(gt && gt.classList.contains('has-img') && gt.style.backgroundImage),
        badHas: !!bt, badHold: !!(bt && !bt.classList.contains('has-img')) };
    });
    await page.evaluate((b) => {
      window.Sleepy.core.setActiveSandbox(b.sb);
      window.Sleepy.core.switchTo(b.m, b.u);
      window.Sleepy.nav.topCtx().refresh();
    }, B);
    await sleep(400);
    const w23b = await page.evaluate(() => ({
      noStale: document.querySelector('.page[data-page="we-time"]').textContent.indexOf('带图的真实动态') < 0,
      noForeignImg: document.querySelectorAll('.page[data-page="we-time"] .we-time-thumb.has-img').length === 0
    }));
    await page.evaluate((a) => {
      window.Sleepy.core.setActiveSandbox(a.sb);
      window.Sleepy.core.switchTo(a.m, a.u);
      window.Sleepy.nav.topCtx().refresh();
    }, A);
    await sleep(300);
    chk('W23 缩略图：真图加载成功、坏图纸纹占位、切岛旧响应不落新视图',
      w23a.goodHas && w23a.goodLoaded && w23a.badHas && w23a.badHold && w23b.noStale,
      JSON.stringify({ a: w23a, b: w23b }));

    /* W24：列表渲染后身份变化 → 残留条目点击被点击复核拦下（denied 反馈不跳页） */
    const idsA = await page.evaluate(() => {
      const S = window.Sleepy;
      return { m: S.core.activeCharOnIsland().id, u: S.core.activeUserOnIsland().id };
    });
    const u2id = await page.evaluate((ids) => {
      const S = window.Sleepy;
      const u2 = S.core.upsertUser({ name: '二号我' }).id;
      S.core.setSandboxMasks(S.core.activeSandbox().id, [ids.u, u2]);
      S.momentsTab.add({ text: 'u1专用动态', at: Date.now() - 30000 });   /* maskId = u1 */
      window.Sleepy.nav.topCtx().refresh();
      return u2;
    }, idsA);
    await sleep(250);
    await page.evaluate((u2) => {
      /* 切号但**不刷新** —— 故意留着按旧身份渲染的残留 DOM */
      window.Sleepy.core.switchTo(window.Sleepy.core.activeCharOnIsland().id, u2);
    }, u2id);
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const e of els) { if ((e.textContent || '').indexOf('u1专用动态') >= 0) { e.click(); return; } }
    });
    await sleep(200);
    const w24a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(),
      toast: (document.getElementById('toast') || {}).textContent || ''
    }));
    await page.evaluate(() => window.Sleepy.nav.topCtx().refresh());
    await sleep(200);
    const w24b = await page.evaluate(() =>
      document.querySelector('.page[data-page="we-time"]').textContent.indexOf('u1专用动态') < 0);
    await page.evaluate((ids) => {
      window.Sleepy.core.switchTo(ids.m, ids.u);
      window.Sleepy.nav.topCtx().refresh();
    }, idsA);
    await sleep(250);
    chk('W24 归属变化后残留点击：denied 反馈不跳页；刷新后聚合层排除',
      w24a.top === 'we-time' && w24a.toast.indexOf('看不到') >= 0 && w24b,
      JSON.stringify({ a: w24a, b: w24b }));

    /* W25：超过 30 条展开后，Tab 往返 / 详情往返不丢批次与位置；切岛重置回首批 */
    await clickTab(page, 'we-time');
    await sleep(250);
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we-time"] .we-time-more');
      if (b) b.click();
    });
    await sleep(250);
    const st25 = await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we-time"] .app-body');
      b.scrollTop = 500;
      return { n: document.querySelectorAll('.page[data-page="we-time"] .we-time-item').length,
        more: !!document.querySelector('.page[data-page="we-time"] .we-time-more'),
        st: b.scrollTop };
    });
    await clickTab(page, 'we');
    await sleep(250);
    await clickTab(page, 'we-time');
    await sleep(350);
    const st25b = await page.evaluate(() => ({
      n: document.querySelectorAll('.page[data-page="we-time"] .we-time-item').length,
      st: document.querySelector('.page[data-page="we-time"] .app-body').scrollTop }));
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const e of els) { if ((e.textContent || '').indexOf('批量0') >= 0) { e.click(); return; } }
    });
    await sleep(350);
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(500);
    const st25c = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(),
      n: document.querySelectorAll('.page[data-page="we-time"] .we-time-item').length,
      st: document.querySelector('.page[data-page="we-time"] .app-body').scrollTop }));
    await page.evaluate((b) => {
      window.Sleepy.core.setActiveSandbox(b.sb);
      window.Sleepy.core.switchTo(b.m, b.u);
      window.Sleepy.nav.topCtx().refresh();
    }, B);
    await sleep(300);
    const st25d = await page.evaluate(() => ({
      n: document.querySelectorAll('.page[data-page="we-time"] .we-time-item').length }));
    await page.evaluate((a) => {
      window.Sleepy.core.setActiveSandbox(a.sb);
      window.Sleepy.core.switchTo(a.m, a.u);
      window.Sleepy.nav.topCtx().refresh();
    }, A);
    await sleep(350);
    const st25e = await page.evaluate(() => ({
      n: document.querySelectorAll('.page[data-page="we-time"] .we-time-item').length,
      more: !!document.querySelector('.page[data-page="we-time"] .we-time-more') }));
    chk('W25 展开状态：Tab/详情往返不丢批次与位置；切岛（上下文变）重置回首批',
      st25.n > 30 && !st25.more && st25.st >= 400 &&
      st25b.n === st25.n && Math.abs(st25b.st - st25.st) <= 5 &&
      st25c.top === 'we-time' && st25c.n === st25.n && Math.abs(st25c.st - st25.st) <= 5 &&
      st25d.n <= 30 && st25e.n === 30 && st25e.more,
      JSON.stringify({ base: st25, tab: st25b, detail: st25c, isleB: st25d, backA: st25e }));

    /* ---- N：浏览器真实返回行为（等 popstate，核对 history.state）---- */

    /* N1：普通 Tab 切换（replaceState 原地替换）→ 浏览器返回一次回桌面 */
    await page.evaluate(() => { window.Sleepy.nav.closeAll(); });
    await sleep(250);
    await page.evaluate(() => { window.Sleepy.nav.open('we'); });
    await sleep(250);
    await clickTab(page, 'we-time');
    await sleep(250);
    await clickTab(page, 'collection');
    await sleep(300);
    const n1a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
      state: JSON.parse(JSON.stringify(window.history.state || {})) }));
    await page.goBack();
    await sleep(500);
    const n1b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
      state: JSON.parse(JSON.stringify(window.history.state || {})) }));
    chk('N1 Tab 切换后浏览器返回：一次回桌面，history.state 全程正确',
      n1a.top === 'collection' && n1a.depth === 1 &&
      n1a.state.sleepy === 'collection' && n1a.state.depth === 1 &&
      n1b.depth === 0 && n1b.state.depth === 0,
      JSON.stringify({ a: n1a, b: n1b }));

    /* N2：正文 push 收藏馆 → Tab 首页（replace 消死条目）→ 返回一次回桌面 */
    await page.evaluate(() => { window.Sleepy.nav.open('we'); });
    await sleep(300);
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we"] .we-fav-btn');
      if (b) b.click();
    });
    await sleep(300);
    await clickTab(page, 'we');
    await sleep(400);
    const n2a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
      state: JSON.parse(JSON.stringify(window.history.state || {})) }));
    await page.goBack();
    await sleep(500);
    const n2b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
      state: JSON.parse(JSON.stringify(window.history.state || {})) }));
    chk('N2 正文 push → Tab 首页 → 浏览器返回一次回桌面（无死历史条目）',
      n2a.top === 'we' && n2a.depth === 1 &&
      n2a.state.sleepy === 'we' && n2a.state.depth === 1 && n2b.depth === 0,
      JSON.stringify({ a: n2a, b: n2b }));

    /* N3：详情往返 —— collection → item → back → collection → back → 桌面 */
    await page.evaluate(() => { window.Sleepy.nav.open('we'); });
    await sleep(250);
    await clickTab(page, 'collection');
    await sleep(300);
    await page.evaluate(() => {
      const c = document.querySelector('.page[data-page="collection"] .co-card');
      if (c) c.click();
    });
    await sleep(300);
    const n3a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
      state: JSON.parse(JSON.stringify(window.history.state || {})) }));
    await page.goBack();
    await sleep(500);
    const n3b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    await page.goBack();
    await sleep(500);
    const n3c = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    chk('N3 详情往返：item → back → 门厅 → back → 桌面，层层正确',
      n3a.top === 'collection-item' && n3a.depth === 2 && n3a.state.depth === 2 &&
      n3b.top === 'collection' && n3b.depth === 1 && n3c.depth === 0,
      JSON.stringify({ a: n3a, b: n3b, c: n3c }));

    /* N4：We 跳朋友圈的来源浏览 → in-app 返回（走守卫）直接回时光；
       桌面进聊天 App 返回语义不变（先切回消息 tab）。 */
    await page.evaluate(() => { window.Sleepy.nav.open('we'); });
    await sleep(250);
    await clickTab(page, 'we-time');
    await sleep(250);
    await page.evaluate(() => {
      const els = document.querySelectorAll('.page[data-page="we-time"] .we-time-item');
      for (const e of els) { if ((e.textContent || '').indexOf('定位测试的动态') >= 0) { e.click(); return; } }
    });
    /* 定位可视性判据已在 W21 注入 window.__weVis */
    await sleep(300);
    const n4a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(450);
    const n4b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    await page.evaluate(() => { window.Sleepy.nav.closeAll(); });
    await sleep(250);
    await page.evaluate(() => { window.Sleepy.nav.open('moments'); });
    await sleep(300);
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(300);
    const n4c = await page.evaluate(() => {
      const on = document.querySelector('.page[data-page="moments"] .tab-btn.is-on .tab-tx');
      return { top: window.Sleepy.nav.top(), tab: on ? on.textContent : '' };
    });
    chk('N4 来源浏览返回回时光（守卫豁免一次）；桌面进聊天 App 仍先回消息 tab',
      n4a.top === 'moments' && n4a.depth === 2 &&
      n4b.top === 'we-time' && n4b.depth === 1 &&
      n4c.top === 'moments' && n4c.tab === '消息',
      JSON.stringify({ a: n4a, b: n4b, c: n4c }));

    /* N5：群线下交接同款 replace（depth2 处换页）—— 真实浏览器历史行为：
       history.length 不增、state 指向新页、浏览器返回回下一层来源页。
       完整群聊链路未驱动，此处为机制级等价验证（smoke 已核对调用点）。 */
    await page.evaluate(() => { window.Sleepy.nav.closeAll(); });
    await sleep(250);
    await page.evaluate(() => { window.Sleepy.nav.open('we'); });
    await sleep(250);
    await page.evaluate(() => {
      const b = document.querySelector('.page[data-page="we"] .we-fav-btn');
      if (b) b.click();
    });
    await sleep(300);
    const len0 = await page.evaluate(() => window.history.length);
    await page.evaluate(() => { window.Sleepy.nav.replace('we-time'); });
    await sleep(300);
    const n5a = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth(),
      len: window.history.length,
      state: JSON.parse(JSON.stringify(window.history.state || {})) }));
    await page.goBack();
    await sleep(500);
    const n5b = await page.evaluate(() => ({
      top: window.Sleepy.nav.top(), depth: window.Sleepy.nav.depth() }));
    chk('N5 replace 换页（交接同款）：历史不增、state 正确、返回回下一层',
      n5a.top === 'we-time' && n5a.depth === 2 && n5a.len === len0 &&
      n5a.state.sleepy === 'we-time' && n5a.state.depth === 2 &&
      n5b.top === 'we' && n5b.depth === 1,
      JSON.stringify({ a: n5a, b: n5b }));

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
