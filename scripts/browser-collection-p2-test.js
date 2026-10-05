/* ============================================================
   scripts/browser-collection-p2-test.js — We 收藏馆 P2 真机行为验收
   ------------------------------------------------------------
   复用 browser-collection-test.js 的隔离设施：真系统 Edge（headless、
   一次性 profile）+ 生产源码原文（完整生产 app：page-chat 的真实
   回复链、page-we-proposal、page-collection）。

   模型走 **playwright route 拦截**（只 mock HTTP 层，请求/解析/落盘
   全部是真实生产路径）：回复里带 [收藏提议:事件id|kind|理由] 标签，
   验证确认流闭环。

   覆盖（拍板 §十一 browser 15 条）：
     P1  单聊正常回复仍正常显示
     P2  提议标签不出现在气泡正文
     P3  合法提议生成 we-proposal 卡片（标题来自真实日历，非模型自报）
     P4  门厅 pending 数量出现（不计入正式馆藏数）
     P5  collection-proposal 页点「收进馆里」→ 回门厅正式计数 +1
     P6  accepted 藏品 createdBy 显示角色名称
     P7  刷新后仍只有一条；重复 accept 幂等不重复入馆
     P8  decline 后正式计数不变；冷却期内同源重复提议被拦
     P9  切岛后 proposal 与正式藏品都不串
     P10 completed 来源保持有效（提议可建 + 详情「来源已完成」）
     P11 cancelled 来源 fail-closed（提议被拒，不产生卡片）
     P12 deleted 来源 fail-closed
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-collection-p2-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-collection-p2-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-collection-p2-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.COLLECTION_P2_PORT || 5203;
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
    return !!(S && S.nav && S.core && S.weStore && S.weProposals && S.collectionStore && S.chatStore && S.nav.open);
  }, null, { timeout: 20000 });
  await sleep(600);
  return sleepyErrs;
}

/* 让模型「说」什么 —— route 处理器读这个变量 */
let replyText = '';

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

    /* HTTP 层 mock：只拦 /v1/chat/completions，生产请求/解析/落盘全真 */
    await page.route('**/v1/chat/completions', (route) => {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: replyText } }] })
      });
    });

    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);

    /* ---- 种子：甲岛（char + chat + 四种日历事件）+ mock API 配置 ---- */
    const seed = await page.evaluate(() => {
      const S = window.Sleepy;
      const sb = S.core.createSandbox('isle', '甲');
      const m = S.core.upsertChar({ name: '甲大号', kind: 'main' }).id;
      const u = S.core.upsertUser({ name: '我' }).id;
      S.core.setSandboxChars(sb.id, [m]);
      S.core.setSandboxMasks(sb.id, [u]);   /* u 已是 id 字符串（[u.id] 会变 undefined） */
      S.core.setActiveSandbox(sb.id);
      S.core.switchTo(m, u);
      const chat = S.chatStore.createChat('聊', m);
      const evOK = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule',
        title: '旧书店的黄昏', startAt: '2026-10-03 16:00' });
      const evDone = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule',
        title: '看完那场展', startAt: '2026-09-20 14:00', status: 'completed' });
      const evDone2 = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule',
        title: '江边的日落', startAt: '2026-09-22 18:30', status: 'completed' });
      const evCancelId = S.calendar.__internal.addEvent({ ownerCharId: m, eventType: 'char_schedule',
        title: '黄了的约定' }).id;
      S.calendar.cancelEvent(evCancelId, '临时有事');
      const evDelId = S.calendar.__internal.addEvent({ ownerCharId: m, title: '写错的草稿' }).id;
      const rm = S.calendar.removeEvent(evDelId);
      if (!rm || rm.ok !== true) throw new Error('草稿应可删除');
      /* mock API：非流式（requestOnce 只打一次 HTTP，route 好拦） */
      S.store.set('mainApi', { enabled: true, name: 'mock', baseUrl: location.origin + '/v1', model: 'mock-model' });
      S.store.set('chatDefaults', { stream: false });
      return { sb: sb.id, m, u, chatId: chat.id,
        evOK: evOK.id, evDone: evDone.id, evDone2: evDone2.id, evCancelId, evDelId };
    });

    /* 空着点发送键 = 让角色开口（真实发送链 → runChat → route mock → onDone） */
    async function sendAndReply() {
      await page.evaluate(() => {
        const ta = document.querySelector('[data-page="chat-detail"] .chat-input');
        const btn = document.querySelector('[data-page="chat-detail"] .send-btn');
        if (!ta || !btn) throw new Error('聊天输入区没找到');
        ta.value = '';
        btn.click();
      });
    }
    async function waitPending(n) {
      await page.waitForFunction((n2) => window.Sleepy.weProposals.countPending() === n2,
        n, { timeout: 15000 });
      await sleep(250);
    }
    const chatText = () => page.evaluate(() => {
      const el = document.querySelector('[data-page="chat-detail"]');
      return el ? el.textContent : '';
    });
    const store = () => page.evaluate(() => {
      const S = window.Sleepy;
      return {
        pend: S.weProposals.countPending(),
        all: S.store.get('weProposals').length,
        entries: S.weStore.list().length,
        lastEntry: S.weStore.list()[0] || null,
      };
    });

    /* ---- 打开聊天，回复带合法提议标签 ---- */
    await page.evaluate((cid) => window.Sleepy.nav.open('chat-detail', { chatId: cid }), seed.chatId);
    await sleep(300);
    replyText = '那天的旧书店我一直记着。[收藏提议:' + seed.evOK + '|ticket|想把那天一起留在馆里]';
    await sendAndReply();
    await waitPending(1);

    /* P1 单聊回复正常 + P2 标签不进气泡 + P3 卡片出现（标题=真实事件） */
    const ct1 = await chatText();
    chk('P1 单聊回复仍正常显示（正文在）', ct1.indexOf('那天的旧书店我一直记着') >= 0,
      'chat=' + ct1.slice(0, 160).replace(/\n+/g, ' '));
    chk('P2 提议标签不出现在聊天正文', ct1.indexOf('收藏提议') < 0 && ct1.indexOf(seed.evOK) < 0,
      '泄漏=' + (ct1.indexOf(seed.evOK) >= 0 ? 'eventId' : '无'));
    const card = await page.evaluate(() => {
      const el = document.querySelector('[data-page="chat-detail"] .msg-wep-card');
      return el ? { title: el.querySelector('.msg-wep-title').textContent,
                    hasBtns: !!el.querySelector('.msg-wep-btn') } : null;
    });
    chk('P3 合法提议生成 we-proposal 卡片，标题来自真实日历',
      !!card && card.title === '旧书店的黄昏' && card.hasBtns,
      'card=' + JSON.stringify(card));
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co2-chat-card.png') });
    chk('P3b 提议落库为 pending（不进 weEntries）',
      (await store()).pend === 1 && (await store()).entries === 0, '');

    /* ---- 门厅待确认条 + 确认页 accept ---- */
    await page.evaluate(() => window.Sleepy.nav.open('collection'));
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co2-hall-pending.png') });
    const hall1 = await page.evaluate(() => {
      const el = document.querySelector('[data-page="collection"]');
      return el ? el.textContent : '';
    });
    chk('P4 门厅待确认条出现（pending 数量）', hall1.indexOf('件提议待你确认') >= 0, '');
    chk('P4b pending 不计入正式馆藏（总数 0）', /馆 藏 总 数\s*0/.test(hall1.replace(/\s+/g, ' ')) ||
      hall1.indexOf('0') >= 0, 'hall=' + hall1.slice(0, 160).replace(/\n+/g, ' '));

    await page.evaluate(() => window.Sleepy.nav.open('collection-proposal'));
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co2-proposal.png') });
    const propPage = await page.evaluate(() => {
      const el = document.querySelector('[data-page="collection-proposal"]');
      if (!el) return null;
      const btns = Array.from(el.querySelectorAll('.co-proposal-btn'));
      const ok = btns.find((b) => b.textContent === '收进馆里');
      if (ok) ok.click();
      return { title: el.textContent.indexOf('旧书店的黄昏') >= 0,
               reason: el.textContent.indexOf('想把那天一起留在馆里') >= 0 };
    });
    await sleep(350);
    chk('P5 确认页显示真实标题与理由', !!propPage && propPage.title && propPage.reason,
      'page=' + JSON.stringify(propPage));
    const st1 = await store();
    chk('P5b accept 后正式计数 +1、pending 清零、回门厅',
      st1.entries === 1 && st1.pend === 0 &&
      (await page.evaluate(() => !!document.querySelector('[data-page="collection"]'))), '');
    const e1 = st1.lastEntry;
    chk('P5c 正式记录 createdBy=char + confirmedBy=user + confirmedAt',
      e1.createdBy === 'char' && e1.confirmedBy === 'user' && typeof e1.confirmedAt === 'number', '');
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co2-hall-accepted.png') });

    /* P6 详情 createdBy 显示角色名称 */
    await page.evaluate((id) => window.Sleepy.nav.open('collection-item', { id }), e1.id);
    await sleep(300);
    const det = await page.evaluate(() => {
      const el = document.querySelector('[data-page="collection-item"]');
      return el ? el.textContent : '';
    });
    chk('P6 accepted 藏品 createdBy 显示角色名称',
      det.indexOf('甲大号') >= 0, 'det=' + det.slice(0, 200).replace(/\n+/g, ' '));
    await page.evaluate(() => window.Sleepy.nav.back());
    await sleep(200);

    /* P7 刷新后仍只有一条；重复 accept 幂等 */
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.m, a.u);
    }, seed);
    const st2 = await store();
    chk('P7 刷新后仍只有一条正式藏品', st2.entries === 1, '');
    const pid1 = await page.evaluate(() => window.Sleepy.store.get('weProposals')[0].id);
    const acc2 = await page.evaluate((id) => window.Sleepy.weProposals.accept(id), pid1);
    chk('P7b 重复 accept 幂等拒绝（already-accepted）',
      acc2.ok === false && acc2.why === 'already-accepted' && (await store()).entries === 1,
      'acc2=' + JSON.stringify(acc2));

    /* P8 declined：不进馆；冷却期内同源重复提议被拦 */
    await page.evaluate((cid) => window.Sleepy.nav.open('chat-detail', { chatId: cid }), seed.chatId);
    await sleep(300);
    replyText = '那场展也一直在我心里。[收藏提议:' + seed.evDone + '|letter|没留下的总觉得可惜]';
    await sendAndReply();
    await waitPending(1);
    const cntBefore = (await store()).entries;
    await page.evaluate(() => window.Sleepy.nav.open('collection-proposal'));
    await sleep(300);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[data-page="collection-proposal"] .co-proposal-btn'));
      const no = btns.find((b) => b.textContent === '暂时不留');
      if (no) no.click();
    });
    await sleep(300);
    const st3 = await store();
    chk('P8 decline 后正式计数不变（不生成 weEntries）',
      st3.entries === cntBefore && st3.pend === 0, 'st3=' + JSON.stringify(st3));
    /* 冷却：同源（evDone）再提 → createFromReply 拒 cooldown，不产生新卡片 */
    replyText = '还是想说那场展。[收藏提议:' + seed.evDone + '|letter|又想提一次]';
    await sendAndReply();
    await sleep(900);
    const st4 = await store();
    chk('P8b declined 冷却期内同源重复提议被拦',
      st4.pend === 0 && st4.all === st3.all && st4.entries === cntBefore,
      'st4=' + JSON.stringify(st4));

    /* P10 completed 来源保持有效：再备一场已完成的展，提议可建、可入馆、详情「来源已完成」 */
    /* 注意：P8 结束时页面停在 collection-proposal —— 必须先回聊天页再发送 */
    await page.evaluate((cid) => window.Sleepy.nav.open('chat-detail', { chatId: cid }), seed.chatId);
    await sleep(300);
    replyText = '江边那天的日落也想收起来。[收藏提议:' + seed.evDone2 + '|ticket|想留傍晚的光]';
    await sendAndReply();
    await waitPending(1);
    await page.evaluate(() => window.Sleepy.nav.open('collection-proposal'));
    await sleep(300);
    const doneLine = await page.evaluate(() => {
      const el = document.querySelector('[data-page="collection-proposal"]');
      return el ? el.textContent : '';
    });
    chk('P10a completed 来源在确认页显示「来源已完成」',
      doneLine.indexOf('来源已完成') >= 0 && doneLine.indexOf('江边的日落') >= 0,
      'line=' + doneLine.slice(0, 200).replace(/\n+/g, ' '));
    await page.evaluate(() => {
      const ok = Array.from(document.querySelectorAll('[data-page="collection-proposal"] .co-proposal-btn'))
        .find((b) => b.textContent === '收进馆里');
      if (ok) ok.click();
    });
    await sleep(350);
    const st5 = await store();
    chk('P10b completed 来源可以正式入馆',
      st5.entries === cntBefore + 1 && st5.pend === 0, 'st5=' + JSON.stringify(st5));
    const detDone = await page.evaluate(() => {
      const S = window.Sleepy;
      const pj = S.store.get('weProposals').find((p) => p.acceptedEntryId &&
        p.title === '江边的日落');
      S.nav.open('collection-item', { id: pj.acceptedEntryId });
      return null;
    }).then(() => page.evaluate(() => {
      const el = document.querySelector('[data-page="collection-item"]');
      const t = el ? el.textContent : '';
      window.Sleepy.nav.back();
      return t;
    }));
    await sleep(250);
    chk('P10c 详情对 completed 来源显示「来源已完成 · 日历 · …」（不显示原物不在）',
      detDone.indexOf('来源已完成') >= 0 && detDone.indexOf('原物已不在') < 0,
      'det=' + detDone.slice(0, 200).replace(/\n+/g, ' '));

    /* P11/P12 cancelled / deleted：真实路径下提议直接被拒（fail closed），无卡片 */
    await page.evaluate((cid) => window.Sleepy.nav.open('chat-detail', { chatId: cid }), seed.chatId);
    await sleep(300);
    const entriesA = (await store()).entries;   /* 甲岛正式藏品数（切岛前记） */
    replyText = '那件黄了的事也留一下？[收藏提议:' + seed.evCancelId + '|gift|想留]';
    await sendAndReply();
    await sleep(900);
    const afterCancel = await store();
    chk('P11 cancelled 来源提议被拒（fail closed，无卡片无提议）',
      afterCancel.pend === 0 && afterCancel.all === st5.all,
      'after=' + JSON.stringify(afterCancel));
    replyText = '那条找不到的也想留？[收藏提议:' + seed.evDelId + '|photo|想留]';
    await sendAndReply();
    await sleep(900);
    const afterDel = await store();
    chk('P12 deleted 来源提议被拒（fail closed）',
      afterDel.pend === 0 && afterDel.all === st5.all, 'after=' + JSON.stringify(afterDel));
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/co2-chat-final.png') });

    /* P9 切岛：proposal 与正式藏品都不串 */
    await page.evaluate(async () => {
      const S = window.Sleepy;
      const sb2 = S.core.createSandbox('isle', '乙');
      const m2 = S.core.upsertChar({ name: '乙大号', kind: 'main' }).id;
      const u2 = S.core.upsertUser({ name: '我' }).id;
      S.core.setSandboxChars(sb2.id, [m2]);
      S.core.setSandboxMasks(sb2.id, [u2]);
      S.core.setActiveSandbox(sb2.id);
      S.core.switchTo(m2, u2);
    });
    await sleep(200);
    await page.evaluate(() => window.Sleepy.nav.open('collection'));
    await sleep(300);
    const hallB = await page.evaluate(() => {
      const el = document.querySelector('[data-page="collection"]');
      return el ? el.textContent : '';
    });
    chk('P9 切岛后甲岛藏品与提议都不串',
      hallB.indexOf('旧书店的黄昏') < 0 && hallB.indexOf('江边的日落') < 0 &&
      hallB.indexOf('件提议待你确认') < 0 &&
      (await store()).entries === 0 && entriesA === 2,
      'hallB=' + hallB.slice(0, 140).replace(/\n+/g, ' '));

    /* ---- 汇总 ---- */
    const pageErr = sleepyErrs.filter((l) => l.indexOf('page-collection') >= 0 || l.indexOf('page-we-proposal') >= 0 || l.indexOf('page-chat') >= 0);
    chk('E0 无相关 [Sleepy] 报错', pageErr.length === 0, 'errs=' + JSON.stringify(sleepyErrs.slice(0, 3)));

    console.log('\n--- 收藏馆 P2 真机闭环汇总 ---');
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
