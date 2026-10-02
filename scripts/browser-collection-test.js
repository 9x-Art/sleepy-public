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
   C1 实物化（2026-10-02）：
     R1  票根点击 3D 翻面/翻回（is-flipped 切换）
     R2  背签空格原地补写 → weStore.patch 落盘 memoUser + 重画
     P1  拍立得出厂未显影（药水层在）+ 贴纸槽位（C2 预留）在
     P2  长按 0.6s 显影 → is-developed + developed:true 持久化
     P3  重开详情：已显影直接呈现，无药水层
     P4  老照片（无 developed 字段）按「已显影」兼容
     （C7b/C8b/C13 断言随实物化更新：来源语义移到票根背面存根行）
   美化批（2026-10-02）：
     M1  门厅贴纸工坊入口 + 票根/照片实物缩略卡
     M2  贴纸工坊占位页（sticker-workshop 注册 + 三枚示意贴纸）
     M3  群岛选人闸：未选身份先选人，点卡 = 进入身份 + We 重画
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

    /* 打开失效来源详情 → 票根实物背面存根行降级文案 */
    await clickCard(page, '没成行的那顿');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-gone.png') });
    const detGone = await detText(page);
    chk('C8b 失效来源票根背面显示「该约定已取消」+ 状态章[已不在]',
      detGone.indexOf('该约定已取消') >= 0 && detGone.indexOf('[已不在]') >= 0, '');
    chk('C8c 票根实物组件在（双面翻转容器 + 背签表）',
      await page.evaluate(() => {
        const el = document.querySelector('.page[data-page="collection-item"]');
        return !!(el && el.querySelector('.co-tk-flipper') && el.querySelector('.co-tk-archive'));
      }), '');
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* 打开已完成来源详情 → 「来源已完成」，**不得**显示「原物已不在」 */
    await clickCard(page, '看过的那场展');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-done.png') });
    const detDone = await detText(page);
    chk('C13a completed 来源票根背面显示「日历 · 看完那场展」+ [已完成]',
      detDone.indexOf('看完那场展') >= 0 && detDone.indexOf('[已完成]') >= 0,
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

    /* 打开存活来源详情 → 票根正面 + 背面关联行（实物化后来源在背面存根行） */
    await clickCard(page, '一起看过海');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-detail-live.png') });
    const detLive = await detText(page);
    chk('C7b 存活来源票根背面显示「日历 · 周五吃火锅」+ [在]',
      detLive.indexOf('周五吃火锅') >= 0 && detLive.indexOf('[在]') >= 0, '');

    /* ============ C1 藏品实物化 · 票根交互（真机生产路径） ============ */
    /* R1：点击翻面 → is-flipped；再点 → 翻回 */
    const flip1 = await page.evaluate(() => {
      const f = document.querySelector('.page[data-page="collection-item"] .co-tk-flipper');
      if (!f) return { has: false };
      f.click();
      return { has: true, flipped: f.classList.contains('is-flipped') };
    });
    await sleep(700);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-ticket-back.png') });
    const flip2 = await page.evaluate(() => {
      const f = document.querySelector('.page[data-page="collection-item"] .co-tk-flipper');
      if (!f || !f.classList.contains('is-flipped')) return false; /* 此时应是翻面态 */
      f.click();
      return !f.classList.contains('is-flipped'); /* 再点应翻回 */
    });
    chk('R1 票根点击 3D 翻面/翻回（is-flipped 切换）', flip1.has && flip1.flipped && flip2, '');

    /* R2：背签空格点击 → 原地补写 → 落盘 memoUser + 重画出手写体 */
    const memoEdit = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="collection-item"]');
      const cell = el.querySelector('.co-tk-memo.is-empty');
      if (!cell) return { has: false };
      cell.click();
      const ta = el.querySelector('.co-tk-memo-editor textarea');
      if (!ta) return { has: true, editor: false };
      ta.value = '散场时下雨了，他把外套借我。';
      const ok = el.querySelector('.co-tk-memo-acts .is-primary');
      ok.click();
      return { has: true, editor: true };
    });
    await sleep(350);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-ticket-memo.png') });
    const memoSaved = await page.evaluate(() => {
      const S = window.Sleepy;
      const en = S.collectionStore.entries().filter((x) => x.title === '一起看过海')[0];
      const el = document.querySelector('.page[data-page="collection-item"]');
      return {
        saved: !!(en && en.memoUser === '散场时下雨了，他把外套借我。'),
        painted: (el.textContent || '').indexOf('散场时下雨了') >= 0
      };
    });
    chk('R2 背签原地补写（textarea → 存进背签 → patch 落盘 + 重画）',
      memoEdit.has && memoEdit.editor && memoSaved.saved && memoSaved.painted,
      JSON.stringify({ memoEdit, memoSaved }));

    /* ============ C1 藏品实物化 · 拍立得显影（真机生产路径） ============ */
    /* 播一张未显影照片藏品（weAdd 出厂 developed:false）
       + 一张「老式」照片：直接塞 store 不带 developed 字段（模拟 C1 之前的历史记录） */
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.weStore.add({ title: '海边的拍立得', note: '海边风很大，你抬头看海鸥那一秒。', kind: 'photo', at: 2666 }, a.sb);
      const legacy = {
        id: 'legacy-photo-1', title: '很久前的照片', note: '老照片不用再显影',
        kind: 'photo', at: 1888, sourceType: 'manual', sourceId: null, sourceRef: null,
        refCharId: null, refUserId: null, createdBy: 'user',
        createdAt: 1888, updatedAt: 1888, sandboxId: a.sb
      };
      const all = S.store.get('weEntries');
      all.push(legacy);
      S.store.set('weEntries', all);
    }, A);
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);
    await clickCard(page, '海边的拍立得');
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-polaroid-undeveloped.png') });
    const pl1 = await page.evaluate(() => {
      const p = document.querySelector('.page[data-page="collection-item"] .co-pl-pocket');
      if (!p) return { has: false };
      return {
        has: true,
        undeveloped: !p.classList.contains('is-developed'),
        chem: !!p.querySelector('.co-pl-chem'),
        slot: !!document.querySelector('.page[data-page="collection-item"] .co-pl-slot')
      };
    });
    chk('P1 拍立得出厂未显影（药水层在）+ 贴纸槽位（C2 预留）在',
      pl1.has && pl1.undeveloped && pl1.chem && pl1.slot, JSON.stringify(pl1));

    /* P2：长按 0.6s「手心捂热」→ 显影（is-developed）→ developed:true 落盘 */
    await page.evaluate(() => {
      const p = document.querySelector('.page[data-page="collection-item"] .co-pl-pocket');
      p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await sleep(750);
    await page.evaluate(() => {
      const p = document.querySelector('.page[data-page="collection-item"] .co-pl-pocket');
      p.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-polaroid-developed.png') });
    const pl2 = await page.evaluate(() => {
      const S = window.Sleepy;
      const p = document.querySelector('.page[data-page="collection-item"] .co-pl-pocket');
      const en = S.collectionStore.entries().filter((x) => x.title === '海边的拍立得')[0];
      return { developed: !!(p && p.classList.contains('is-developed')), persisted: !!(en && en.developed === true) };
    });
    chk('P2 长按触发显影 + developed:true 持久化', pl2.developed && pl2.persisted, JSON.stringify(pl2));

    /* P3：显影过的重新打开直接是显影好的（不再有药水层） */
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);
    await clickCard(page, '海边的拍立得');
    await sleep(250);
    const pl3 = await page.evaluate(() => {
      const p = document.querySelector('.page[data-page="collection-item"] .co-pl-pocket');
      return !!(p && p.classList.contains('is-developed') && !p.querySelector('.co-pl-chem'));
    });
    chk('P3 重开详情：已显影的直接呈现，无药水层', pl3, '');

    /* P4：老照片（无 developed 字段）按「已显影」兼容 */
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);
    await clickCard(page, '很久前的照片');
    await sleep(250);
    const pl4 = await page.evaluate(() => {
      const p = document.querySelector('.page[data-page="collection-item"] .co-pl-pocket');
      return !!(p && p.classList.contains('is-developed'));
    });
    chk('P4 老照片无字段 → 已显影兼容', pl4, '');
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

    /* ---- 美化批（2026-10-02）：贴纸工坊入口/占位页 + 门厅实物缩略卡 + 群岛选人闸 ---- */
    chk('M1 门厅有贴纸工坊入口 + 票根/照片实物缩略卡',
      (await colText(page)).indexOf('贴纸工坊') >= 0 &&
      await page.evaluate(() => {
        const el = document.querySelector('.page[data-page="collection"]');
        return !!(el && el.querySelector('.co-sticker-entry') &&
          el.querySelector('.co-card-ticket') && el.querySelector('.co-card-photo'));
      }), '');
    await page.evaluate(() => window.Sleepy.nav.open('sticker-workshop'));
    await sleep(250);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co-sticker-workshop.png') });
    chk('M2 贴纸工坊页打开（五步流首屏：三态选择卡）',
      await page.evaluate(() => {
        const el = document.querySelector('.page[data-page="sticker-workshop"]');
        return !!(el && el.querySelectorAll('.sk-target').length === 3);
      }), '');
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* M3 群岛选人闸：群岛多角色 + 身份指针停在别岛 → We 系页面先选人，
       点选人卡 = 进入身份（switchTo 全局生效）+ We 重画出封面 */
    await page.evaluate(() => {
      const S = window.Sleepy;
      const c1 = S.core.upsertChar({ name: '群甲', kind: 'main' }).id;
      const c2 = S.core.upsertChar({ name: '群乙', kind: 'main' }).id;
      const u = S.core.upsertUser({ name: '群我' }).id;
      const sb = S.core.createSandbox('archipelago', '测试群岛');
      S.core.setSandboxChars(sb.id, [c1, c2]);
      S.core.setSandboxMasks(sb.id, [u]);
      S.core.setActiveSandbox(sb.id);      /* 身份指针仍停在别岛的人身上 → 闸该拦 */
      S.nav.closeAll();
      S.nav.open('we');
    });
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/we-pick.png') });
    const gatePick = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="we"]');
      return {
        has: !!(el && el.querySelector('.we-pick-hero')),
        n: el ? el.querySelectorAll('.we-pick-card').length : 0
      };
    });
    chk('M3a 群岛未选身份 → We 先渲染选人页（两张卡）',
      gatePick.has && gatePick.n === 2, JSON.stringify(gatePick));
    const picked = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="we"]');
      el.querySelectorAll('.we-pick-card')[1].click();     /* 选「群乙」 */
      const S = window.Sleepy;
      return { cur: (S.core.activeCharOnIsland() || {}).name || '' };
    });
    await sleep(300);
    const gateAfter = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="we"]');
      const t = el ? (el.textContent || '') : '';
      return {
        cover: t.indexOf('群乙 × 群我') >= 0,
        pickGone: !!(el && !el.querySelector('.we-pick-hero'))
      };
    });
    chk('M3b 点选人卡 = 进入身份（switchTo 生效 + We 重画出去掉闸）',
      picked.cur === '群乙' && gateAfter.cover && gateAfter.pickGone,
      JSON.stringify({ picked, gateAfter }));
    await page.evaluate(() => window.Sleepy.nav.closeAll());

    /* ---- C2 贴纸工坊（修正施工单闭环，2026-10-02）----
       回岛 A（单 char 孤岛，身份已定），拦生图端点回夹具整版（5 实格 + 1 空格）。 */
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
    }, A);
    await sleep(200);
    await page.evaluate(() => window.Sleepy.nav.open('sticker-workshop'));
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/sk-workshop-step1.png') });
    chk('C2-1 工坊页五步流首屏（三态选择卡 + 锁脸状态角标）',
      await page.evaluate(() => {
        const el = document.querySelector('.page[data-page="sticker-workshop"]');
        return !!(el && el.querySelectorAll('.sk-target').length === 3 &&
          el.querySelectorAll('.sk-ref').length === 3);
      }), '');

    /* 核查 4：工坊内切马甲 → 流程自动重开（旧 sheet 不存给新身份） */
    await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="sticker-workshop"]');
      el.querySelectorAll('.sk-target')[0].click();     /* 选「TA 的贴纸」 */
    });
    await sleep(150);
    await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="sticker-workshop"]');
      el.querySelector('.sk-next').click();             /* 推进到步骤 2 */
    });
    await sleep(150);
    const race = await page.evaluate((a) => {
      const S = window.Sleepy;
      const u2 = S.core.upsertUser({ name: '竞态马甲' }).id;
      const sb = S.core.activeSandbox();
      const roster = (sb.maskIds || []).slice();
      if (roster.indexOf(u2) < 0) roster.push(u2);
      S.core.setSandboxMasks(sb.id, roster);
      S.core.switchTo(a.m, u2);                         /* 等价切号器语义 */
      const t = S.nav.topCtx();
      if (t && t.__paint) t.__paint();                  /* onShow 重画兜底 */
      const el = document.querySelector('.page[data-page="sticker-workshop"]');
      return {
        firstStep: !!(el.querySelector('.sk-steps .sk-step-dot:first-child.is-on')),
        noTarget: !el.querySelector('.sk-target.is-on')
      };
    }, A);
    chk('C2-6 身份竞态：工坊内切马甲 → 流程自动重开（回步骤 1、清空选择）',
      race.firstStep && race.noTarget, JSON.stringify(race));
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.switchTo(a.m, a.u);                        /* 切回原身份继续后续用例 */
      const t = S.nav.topCtx();
      if (t && t.__paint) t.__paint();
    }, A);
    await sleep(150);
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* 夹具：锁脸图 + 生图接口 + 整版 PNG（canvas 现画，走 route 拦截） */
    await page.evaluate(async (a) => {
      const S = window.Sleepy;
      const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, 300, 200);
      for (let i = 0; i < 5; i++) {         /* 5 实格 + 1 全白空格 */
        const cxx = (i % 3) * 100 + 50, cyy = ((i / 3) | 0) * 100 + 50;
        cx.beginPath(); cx.arc(cxx, cyy, 22, 0, 7);
        cx.fillStyle = '#B8860B'; cx.fill();
        cx.lineWidth = 3; cx.strokeStyle = '#54493E'; cx.stroke();
      }
      window.__skSheetFixture = cv.toDataURL('image/png');
      const cv2 = document.createElement('canvas'); cv2.width = 8; cv2.height = 8;
      const c2 = cv2.getContext('2d'); c2.fillStyle = '#8C7355'; c2.fillRect(0, 0, 8, 8);
      const blobOf = async (b64) => (await fetch('data:image/png;base64,' + b64)).blob();
      const fid = await S.media.put(await blobOf(cv2.toDataURL('image/png').split(',')[1]),
        { name: '锁脸夹具', kind: 'faceLock' });
      const ch = S.core.activeCharOnIsland(), us = S.core.activeUserOnIsland();
      S.core.upsertChar({ id: ch.id, faceLockImageMedia: fid, faceLockImageOn: true, gender: 'female' });
      S.core.upsertUser({ id: us.id, faceLockImageMedia: fid, faceLockImageOn: true });
      S.imggen.saveApis([]);
      const api = S.imggen.newApi('general');
      api.name = 'C2夹具'; api.baseUrl = 'http://127.0.0.1:5999/v1'; api.model = 'fixture';
      api.apiKey = 'k'; api.refSupport = 'edits';
      S.imggen.saveApis(S.imggen.listApis().concat([api]));
      return { apiId: api.id };
    }, A);
    await page.route('**/v1/images/edits', async (route) => {
      const dataUrl = await page.evaluate(() => window.__skSheetFixture);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ b64_json: dataUrl.split(',')[1] }] })
      });
    });

    const gen = await page.evaluate(async () => {
      const S = window.Sleepy;
      const ch = S.core.activeCharOnIsland(), us = S.core.activeUserOnIsland();
      const api = S.imggen.listApis().find((x) => x.name === 'C2夹具');
      const P = S.imggen.STICKER_PROMPTS;
      const locks = {};
      locks['char:' + ch.id] = true;
      locks['user:' + us.id] = true;
      return S.imggen.generateStickerSheet({
        target: 'both',
        subjects: [
          { entityType: 'char', entityId: ch.id, name: ch.name, gender: 'female', faceText: '' },
          { entityType: 'user', entityId: us.id, name: '我', gender: '', faceText: '' }
        ],
        imageLocks: locks,
        prompt: P.composeBoth(), negativePrompt: P.NEG_BOTH, size: '300x200'
      });
    });
    chk('C2-2 generateStickerSheet 成功链路（参考图 2 张 + 一次生成 + 落库）',
      !!gen && gen.ok === true && !!gen.mediaId && gen.subjectKeys.length === 2 &&
      gen.promptVersion === 'c2-v1',
      JSON.stringify(gen).slice(0, 220));

    const saved = await page.evaluate(async (mediaId) => {
      const S = window.Sleepy;
      const rec = await S.media.get(mediaId);
      const cells = await S.stickerCut.cutSheet3x2(rec.blob, { threshold: 235 });
      const valid = cells.filter((c) => !c.empty);
      const puts = [];
      for (const s of valid) {
        puts.push(await S.media.put(s.blob,
          { name: '贴' + s.sliceIndex, kind: 'sticker', w: s.width, h: s.height }));
      }
      const ch = S.core.activeCharOnIsland();
      const recs = valid.map((s, i) => ({
        name: '贴' + i, mediaId: puts[i], group: '贴纸工坊 · 测试',
        kind: 'sticker', sheetId: 'shs-test', sheetMediaId: mediaId,
        sliceIndex: s.sliceIndex, sourceVersion: 1, emotion: 'test',
        matchKey: 'sk:shs-test:' + s.sliceIndex,
        ownerCharId: ch.id, ownerUserId: null, ownerMaskIds: [], allowInGroups: false
      }));
      const added = S.stickers.addSheetStickers(recs);
      return {
        cells: cells.length, empty: cells.filter((c) => c.empty).length,
        added: added.length
      };
    }, gen.mediaId);
    chk('C2-3 夹具整版切片（6 格 = 5 实 + 1 空）+ 整批入库',
      saved.cells === 6 && saved.empty === 1 && saved.added === 5,
      JSON.stringify(saved));

    const vis = await page.evaluate(() => {
      const S = window.Sleepy;
      const ch = S.core.activeCharOnIsland(), us = S.core.activeUserOnIsland();
      const f = (ctx) => S.stickers.getVisibleStickers(ctx)
        .filter((s) => s.kind === 'sticker').length;
      return {
        chat: f({ scope: 'chat', charId: ch.id, maskId: us.id }),
        group: f({ scope: 'group', groupId: 'g1', maskId: us.id }),
        other: f({ scope: 'chat', charId: 'char-other', maskId: us.id })
      };
    });
    chk('C2-4 可见性：char 贴纸进本会话、别的会话与群聊都不出现',
      vis.chat === 5 && vis.group === 0 && vis.other === 0, JSON.stringify(vis));

    /* 实贴闭环：拍立得槽位 → 抽屉 → 贴入 → patch 持久化 → 重画渲染 */
    await page.evaluate(() => window.Sleepy.nav.open('collection'));
    await sleep(250);
    await clickCard(page, '海边的拍立得');
    await sleep(250);
    const slotOpen = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="collection-item"]');
      const slot = el && el.querySelector('.co-pl-slot');
      if (!slot) return { has: false };
      slot.click();
      return {
        has: true,
        drawer: !!el.querySelector('.sk-drawer'),
        cells: el.querySelectorAll('.sk-drawer-cell').length
      };
    });
    await sleep(200);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/sk-drawer.png') });
    await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="collection-item"]');
      const cell = el.querySelector('.sk-drawer-cell');
      if (cell) cell.click();
    });
    await sleep(600);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/sk-pasted.png') });
    const pasted = await page.evaluate(() => {
      const S = window.Sleepy;
      const en = S.collectionStore.entries().filter((x) => x.title === '海边的拍立得')[0];
      const el = document.querySelector('.page[data-page="collection-item"]');
      return {
        persisted: !!(en && en.stickers && en.stickers.length === 1),
        hasRot: !!(en && en.stickers && typeof en.stickers[0].rot === 'number'),
        rendered: !!(el && el.querySelector('.co-pl-pasted'))
      };
    });
    chk('C2-5 实贴闭环（槽位 → 抽屉 → 贴入 → patch 持久化 → 渲染带微旋）',
      slotOpen.has && slotOpen.drawer && slotOpen.cells === 5 &&
      pasted.persisted && pasted.hasRot && pasted.rendered,
      JSON.stringify({ slotOpen, pasted }));
    await page.evaluate(() => window.Sleepy.nav.closeAll());

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
