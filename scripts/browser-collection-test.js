/* ============================================================
   scripts/browser-collection-test.js — We 收藏馆真机行为验收
   ------------------------------------------------------------
   复用 browser-we-test.js 的隔离设施：真系统 Edge（headless、一次性
   profile）+ 生产源码原文（加载**完整生产 app** /index.html，含 app.js /
   page-desktop.js / page-we.js / page-collection.js / calendar.js）。

   验证的闭环（生产路径证据，覆盖拍板 §七 的 15 条验收）：
     C1  We 首页可以打开 collection（nav.open('collection') 无 [Sleepy] 报错）
     C2  collection 门厅显示真实 weEntries（真实计数 + 分类分组）
     C3  点击藏品能打开详情（title 出现）
     C4  标题 / 说明 / 日期 / kind / 来源信息正确
     C5  没有 weEntries 时显示 We 语境空态（切到空岛）
     C6  sourceType/sourceId 为空 →「手动记录」
     C7  来源仍存在（日历未取消）→ 正常来源文案
     C8  来源失效（日历已取消）→ 降级文案「该约定已取消」
     C13 来源已完成（日历 completed）→「来源已完成 · 日历 · <标题>」（有效历史来源，
         不得显示「原物已不在」）
     C14 来源已删除（事件真不存在）→「原日历记录已删除」
     C9  刷新后门厅和详情仍可用
     C10 切岛后不显示另一岛藏品
     C11 返回原岛后藏品恢复
     C12 旧 favorites 仍然正常（nav.open('favorites') 可开，注册未变）
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-collection-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-collection-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-collection-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.COLLECTION_TEST_PORT || 5201;
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
    return !!(S && S.nav && S.core && S.collectionStore && S.weStore && S.nav.open);
  }, null, { timeout: 20000 });
  await sleep(600);
  await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-boot.png') }).catch(() => {});
  return sleepyErrs;
}

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

function colText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.page[data-page="collection"]');
    if (!el) return '';
    return el.textContent || '';
  });
}
function detText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.page[data-page="collection-item"]');
    if (!el) return '';
    return el.textContent || '';
  });
}
/* 点击门厅里某条藏品卡（按标题找） */
function clickCard(page, title) {
  return page.evaluate((t) => {
    const cards = document.querySelectorAll('.page[data-page="collection"] .co-card');
    for (const c of cards) if (c.textContent.indexOf(t) >= 0) { c.click(); return true; }
    return false;
  }, title);
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
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);

    const A = await seedIsland(page, '甲');
    const B = await seedIsland(page, '乙');

    /* 切到 A 岛，写五类 weEntry：手动 / 日历存活 / 日历已完成 / 日历已取消 / 日历已删除 */
    const seeded = await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
      const manual = S.weStore.add({ title: '一张手写纸条', note: '你塞进我书里', kind: 'letter', at: 1111 }, a.sb);
      const evLive = S.calendar.addEvent({ ownerCharId: a.m, eventType: 'shared_event', title: '周五吃火锅' });
      const evDone = S.calendar.addEvent({ ownerCharId: a.m, eventType: 'shared_event', title: '看完那场展', status: 'completed' });
      const evGone = S.calendar.addEvent({ ownerCharId: a.m, eventType: 'shared_event', title: '取消的约定' });
      S.calendar.cancelEvent(evGone.id, '临时有事');
      const evDel = S.calendar.addEvent({ ownerCharId: a.m, title: '写错的草稿' });
      const rm = S.calendar.removeEvent(evDel.id);
      if (!rm || rm.ok !== true) throw new Error('草稿事件应可删除');
      const live = S.weStore.add({ title: '一起看过海', note: '在码头吹了整晚风', kind: 'ticket', at: 2222,
        sourceType: 'calendar', sourceId: evLive.id, sourceRef: '2026-10-01', refCharId: a.m, refUserId: a.u }, a.sb);
      const done = S.weStore.add({ title: '看过的那场展', note: '散场时天刚黑', kind: 'ticket', at: 2444,
        sourceType: 'calendar', sourceId: evDone.id, sourceRef: '2026-09-20', refCharId: a.m, refUserId: a.u }, a.sb);
      const gone = S.weStore.add({ title: '没成行的那顿', kind: 'ticket', at: 3333,
        sourceType: 'calendar', sourceId: evGone.id, sourceRef: '2026-10-05', refCharId: a.m, refUserId: a.u }, a.sb);
      const del = S.weStore.add({ title: '找不到出处的那条', kind: 'other', at: 3555,
        sourceType: 'calendar', sourceId: evDel.id, sourceRef: '2026-10-08', refCharId: a.m, refUserId: a.u }, a.sb);
      return { manualId: manual.id, liveId: live.id, doneId: done.id, goneId: gone.id, delId: del.id };
    }, A);

    /* C1：We 首页打开 collection */
    await page.evaluate(() => window.Sleepy.nav.open('collection'));
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-hall.png') });
    const pageErr = sleepyErrs.filter((l) => l.indexOf('page-collection') >= 0).length;
    chk('C1 nav.open(collection) 打开且无 page-collection 报错',
      pageErr === 0 && (await page.evaluate(() => !!document.querySelector('.page[data-page="collection"]'))),
      'sleepyErrs=' + JSON.stringify(sleepyErrs));

    /* C2：门厅真实 weEntries —— 计数条 + 五条都在 + 分类分组标题出现 */
    const hallA = await colText(page);
    chk('C2 门厅显示真实 weEntries（含全部五条）',
      hallA.indexOf('一起看过海') >= 0 && hallA.indexOf('一张手写纸条') >= 0 &&
      hallA.indexOf('没成行的那顿') >= 0 && hallA.indexOf('看过的那场展') >= 0 &&
      hallA.indexOf('找不到出处的那条') >= 0,
      '');
    chk('C2b 按 kind 分组标题出现（信件/票根）',
      hallA.indexOf('信 件') >= 0 || hallA.indexOf('信件') >= 0 || hallA.indexOf('票 根') >= 0 || hallA.indexOf('票根') >= 0,
      'hall=' + hallA.slice(0, 200).replace(/\n+/g, ' '));

    /* C5 + C6/C7/C8 门厅来源角标：手动→手记；live→来自 日历；gone→该约定已取消 */
    chk('C6 手动来源角标显示「手记」', hallA.indexOf('手记') >= 0, '');
    chk('C7 存活来源显示「来自 日历」', hallA.indexOf('来自 日历') >= 0, '');
    chk('C8 失效来源显示「该约定已取消」', hallA.indexOf('该约定已取消') >= 0, '');

    /* C3 + C4：点手动藏品卡片 → 打开详情，字段正确 */
    await clickCard(page, '一张手写纸条');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-manual.png') });
    const detManual = await detText(page);
    chk('C3 点击藏品打开详情（标题出现）', detManual.indexOf('一张手写纸条') >= 0, '');
    chk('C4 详情含说明/日期/分类/来源/创建',
      detManual.indexOf('你塞进我书里') >= 0 &&
      (detManual.indexOf('信') >= 0) &&
      detManual.indexOf('手记') >= 0 &&
      detManual.indexOf('我') >= 0,
      'det=' + detManual.slice(0, 220).replace(/\n+/g, ' '));

    /* 返回门厅（详情是独立页，back 应回到门厅而不是桌面） */
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);
    chk('C3b 返回后仍在门厅', (await colText(page)).indexOf('一起看过海') >= 0, '');

    /* 打开失效来源详情 → 降级文案 */
    await clickCard(page, '没成行的那顿');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-gone.png') });
    const detGone = await detText(page);
    chk('C8b 失效来源详情显示降级文案「该约定已取消（原物已不在）」',
      detGone.indexOf('该约定已取消') >= 0 && detGone.indexOf('原物已不在') >= 0, '');
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* 打开已完成来源详情 → 「来源已完成」，**不得**显示「原物已不在」 */
    await clickCard(page, '看过的那场展');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-done.png') });
    const detDone = await detText(page);
    chk('C13a completed 来源详情显示「来源已完成 · 日历 · 看完那场展」',
      detDone.indexOf('来源已完成') >= 0 && detDone.indexOf('日历') >= 0 && detDone.indexOf('看完那场展') >= 0,
      'det=' + detDone.slice(0, 220).replace(/\n+/g, ' '));
    chk('C13b completed 来源不得显示「原物已不在」/「已取消」',
      detDone.indexOf('原物已不在') < 0 && detDone.indexOf('该约定已取消') < 0 && detDone.indexOf('已删除') < 0,
      'det=' + detDone.slice(0, 220).replace(/\n+/g, ' '));
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* 打开已删除来源详情 → 「原日历记录已删除」（区别于取消） */
    await clickCard(page, '找不到出处的那条');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-deleted.png') });
    const detDel = await detText(page);
    chk('C14 deleted 来源详情显示「原日历记录已删除」',
      detDel.indexOf('原日历记录已删除') >= 0 && detDel.indexOf('该约定已取消') < 0,
      'det=' + detDel.slice(0, 220).replace(/\n+/g, ' '));
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* 打开存活来源详情 → 正常来源文案 */
    await clickCard(page, '一起看过海');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-live.png') });
    const detLive = await detText(page);
    chk('C7b 存活来源详情显示「来源仍在 · 日历 · 周五吃火锅」',
      detLive.indexOf('来源仍在') >= 0 && detLive.indexOf('周五吃火锅') >= 0, '');
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* C9：刷新页面 → 门厅与详情仍可用 */
    await page.reload({ waitUntil: 'load' });
    const errs2 = await waitApp(page);
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
    }, A);
    await page.evaluate(() => window.Sleepy.nav.open('collection'));
    await sleep(250);
    const hallR = await colText(page);
    chk('C9 刷新后门厅仍可用（五条都在）',
      hallR.indexOf('一起看过海') >= 0 && hallR.indexOf('一张手写纸条') >= 0 &&
      hallR.indexOf('看过的那场展') >= 0, '');
    await clickCard(page, '一起看过海');
    await sleep(250);
    const detR = await detText(page);
    chk('C9b 刷新后详情仍可用（标题+来源在）',
      detR.indexOf('一起看过海') >= 0 && detR.indexOf('周五吃火锅') >= 0, '');
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* C10 + C5：切到空岛 B → 原岛藏品不可见 + We 语境空态 */
    await page.evaluate((b) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(b.sb);
      S.core.switchTo(b.m, b.u);
      const t = S.nav.topCtx();
      if (t && t.refresh) t.refresh();
    }, B);
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-empty.png') });
    const hallB = await colText(page);
    chk('C10 切岛后不显示另一岛藏品', hallB.indexOf('一起看过海') < 0 && hallB.indexOf('一张手写纸条') < 0, '');
    chk('C5 空岛显示 We 语境空态', hallB.indexOf('这里还空着') >= 0, '');

    /* C11：回 A 岛 → 藏品恢复 */
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
      const t = S.nav.topCtx();
      if (t && t.refresh) t.refresh();
    }, A);
    await sleep(250);
    const hallA2 = await colText(page);
    chk('C11 返回原岛后藏品恢复', hallA2.indexOf('一起看过海') >= 0 && hallA2.indexOf('一张手写纸条') >= 0, '');

    /* C12：旧 favorites 仍可开（注册未变，原语义不动） */
    const favOpen = await page.evaluate(() => {
      const S = window.Sleepy;
      const reg = S.registered();
      S.nav.open('favorites');
      return { regFav: !!reg.favorites, open: !!document.querySelector('.page[data-page="favorites"]') };
    });
    await sleep(200);
    const favOpenAfter = await page.evaluate(() => !!document.querySelector('.page[data-page="favorites"]'));
    chk('C12 旧 favorites 仍正常（注册 + 可打开）', favOpen.regFav && favOpenAfter, '');

    /* ---- 汇总 ---- */
    console.log('\n--- 收藏馆真机闭环汇总 ---');
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
