/* ============================================================
   scripts/browser-cal-w3-test.js — 日历写入全链路收口 · 第三轮施工单
   ------------------------------------------------------------
   2026-10-03。真系统 Edge（channel: 'msedge'）+ 生产源码 + 真 indexedDB，
   走**真实 UI**（不开页面注入的假路径），验施工单 §6「无头 Edge」那八项：

     C1  打开纪念日界面，保存一条合法纪念日 → 走统一入口，拿到真 eventId
     C2  刷新后纪念日仍显示，普通近期安排不出现它
     C3  对同一留痕重复操作 → 符合「拒绝并说明」语义，不建第二条
     C4  打开帷境候选但不确认 → 确认没有日历写入
     C5  明确确认一条帷境记录 → 真实 eventId + 页面状态
     C6  重复点击确认 → 不新增第二条
     C7  失败样本不会显示「已写入」
     C8  全程没有 [Sleepy] 报错

   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-cal-w3-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-cal-w3-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.CALW3_PORT || 5207;
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
  const errs = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (t && t.indexOf('[Sleepy]') >= 0) errs.push(t.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => {
    const t = String(e && e.message || e);
    if (t.indexOf('[Sleepy]') >= 0) errs.push(t.slice(0, 300));
  });
  await page.waitForFunction(() => {
    const S = window.Sleepy;
    return !!(S && S.nav && S.core && S.calendar && S.memoryStore && S.wjCanon);
  }, null, { timeout: 20000 });
  await sleep(600);
  return errs;
}

function pageHelpers() {
  return `
window.__w3 = {
  vis(el) { return !!(el && el.offsetParent !== null); },
  byClass(root, cls) {
    return Array.prototype.slice.call((root || document).querySelectorAll('.' + cls));
  },
  text(el) { return el ? String(el.textContent || '') : ''; },
  seedAnchors(charId, list) {
    const S = window.Sleepy;
    const f = S.memoryStore.loadCharMemory(charId);
    list.forEach((it) => {
      f.memories.push({
        id: it.id, charId: charId, kind: 'moment', content: it.content,
        source: 'ai_summary', sourceRef: it.sourceRef || 'msg_seed',
        evidenceType: 'confirmed', status: 'active',
        isAnchor: true, isUserEdited: false,
        createdAt: it.at + 'T21:00:00.000Z', updatedAt: it.at + 'T21:00:00.000Z'
      });
    });
    S.memoryStore.saveCharMemory(f);
    return list.length;
  },
  memOf(charId, memId) {
    const f = window.Sleepy.memoryStore.loadCharMemory(charId);
    return (f.memories || []).filter((m) => m && m.id === memId)[0] || null;
  },
  evsOf(charId) { return window.Sleepy.calendar.eventsOf(charId); },
  evByKey(k) {
    return (window.Sleepy.store.get('calEvents') || []).filter((e) => e && e.requestKey === k);
  }
};
`;
}

async function seed(page) {
  return page.evaluate(() => {
    const S = window.Sleepy;
    const tag = 'w3' + Math.random().toString(36).slice(2, 7);
    const c1 = S.core.upsertChar({ name: tag + '·甲', kind: 'main' }).id;
    const u = S.core.upsertUser({ name: tag + '·我' }).id;
    const sb = S.core.createSandbox('archipelago', tag + '岛');
    S.core.setSandboxChars(sb.id, [c1]);
    S.core.setSandboxMasks(sb.id, [u]);
    S.core.setActiveSandbox(sb.id);
    S.core.switchTo(c1, u);
    S.calendar.saveCfg(c1, { scheduleOn: true });
    return { tag, sb: sb.id, c1, u };
  });
}

async function main() {
  process.on('uncaughtException', (e) => { console.error('[uncaught] ' + (e && e.stack || e)); process.exit(3); });
  process.on('unhandledRejection', (e) => { console.error('[unhandledRejection] ' + (e && e.stack || e)); process.exit(4); });
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  const allErrs = [];
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const errs = await waitApp(page);
    allErrs.push.apply(allErrs, errs);
    await page.evaluate(pageHelpers());

    const A = await seed(page);
    const MEM = 'mem_w3_' + A.tag;
    await page.evaluate((a) => {
      window.__w3.seedAnchors(a.c1, [{
        id: 'mem_w3_' + a.tag, content: a.tag + '·他第一次这样叫我的那天',
        sourceRef: 'msg_w3', at: '2031-05-20'
      }]);
    }, A);

    /* ---------- C1 走真实 UI：月历页 → 留痕候选 → 弹层 → 保存 ---------- */
    await page.evaluate((a) => { window.Sleepy.nav.open('calendar', { charId: a.c1 }); }, A);
    await sleep(700);
    const openedUi = await page.evaluate(() => {
      const root = document.querySelector('[data-page="calendar"]');
      return { has: !!root, txt: root ? String(root.textContent || '').slice(0, 200) : '' };
    });
    chk('C1a 月历页能打开', openedUi.has, openedUi.txt.slice(0, 80));

    /* 候选卡在「留痕里的候选」区块；点它的按钮开弹层 */
    const candInfo = await page.evaluate(() => {
      const root = document.querySelector('[data-page="calendar"]');
      const cards = window.__w3.byClass(root, 'cal-cand');
      const btns = window.__w3.byClass(cards[0], 'cal-cand-btn').filter(window.__w3.vis);
      return { cards: cards.length, btns: btns.length };
    });
    chk('C1b 留痕候选卡渲染出来了', candInfo.cards > 0, JSON.stringify(candInfo));

    if (candInfo.btns) {
      await page.evaluate(() => {
        const root = document.querySelector('[data-page="calendar"]');
        const cards = window.__w3.byClass(root, 'cal-cand');
        const b = window.__w3.byClass(cards[0], 'cal-cand-btn').filter(window.__w3.vis)[0];
        b.click();
      });
      await sleep(500);
      /* 弹层里点「让他记住这一天」 */
      const sheet = await page.evaluate(() => {
        const btns = window.__w3.byClass(document, 'btn-primary')
          .filter(window.__w3.vis)
          .map((b) => window.__w3.text(b));
        return btns;
      });
      chk('C1c 弹层里有保存按钮', sheet.some((t) => t.indexOf('让他记住这一天') >= 0),
        JSON.stringify(sheet));

      const before = await page.evaluate((a) => window.__w3.evsOf(a.c1).length, A);
      await page.evaluate(() => {
        const b = window.__w3.byClass(document, 'btn-primary')
          .filter(window.__w3.vis)
          .filter((x) => window.__w3.text(x).indexOf('让他记住这一天') >= 0)[0];
        if (b) b.click();
      });
      await sleep(700);

      const c1res = await page.evaluate((a) => {
        const S = window.Sleepy;
        const evs = (S.store.get('calEvents') || []).filter((e) => e && e.eventType === 'anniversary');
        const mine = evs.filter((e) => e.memoryId === 'mem_w3_' + a.tag);
        const ev = mine[0] || null;
        const mem = window.__w3.memOf(a.c1, 'mem_w3_' + a.tag);
        return {
          n: mine.length,
          eventId: ev ? ev.id : null,
          via: ev ? ev.authorizedVia : null,
          key: ev ? ev.requestKey : null,
          meaning: ev ? ev.meaningType : null,
          srcIds: ev ? ev.sourceIds : null,
          back: mem ? (mem.calendarEventId || null) : null,
          toast: (window.__w3.byClass(document, 'toast').map(window.__w3.text).join(' | ')).slice(-120)
        };
      }, A);
      chk('C1d 保存后只建了一条纪念日事件', c1res.n === 1, 'before=' + before + ' n=' + c1res.n);
      chk('C1e 走的是统一入口（authorizedVia=anniversary_sheet）',
        c1res.via === 'anniversary_sheet', JSON.stringify(c1res));
      chk('C1f 幂等键是「岛+留痕」且不含标题日期',
        !!c1res.key && c1res.key.indexOf('anniversary:' + A.sb + ':mem_w3_' + A.tag) === 0,
        String(c1res.key));
      chk('C1g 私人纪念日没被升格成双方事实', c1res.meaning === 'char_subjective', String(c1res.meaning));
      /* ⚠️ 这一条是本轮的核心新增：以前全库没有一处写 memory.calendarEventId，
         「双向绑定」其实是假的。 */
      chk('C1h 双向绑定：memory.calendarEventId === event.id',
        !!c1res.eventId && c1res.back === c1res.eventId,
        'eventId=' + c1res.eventId + ' back=' + c1res.back);
    }

    /* ---------- C2 刷新后仍在，且不泄进普通近期安排 ---------- */
    await page.reload({ waitUntil: 'load' });
    const errs2 = await waitApp(page);
    allErrs.push.apply(allErrs, errs2);
    await page.evaluate(pageHelpers());
    await page.evaluate((a) => {
      const S = window.Sleepy;
      const u = (S.store.get('sandboxes') || []).filter((s) => s.id === a.sb)[0];
      const cur = (u ? (u.charIds || []) : ['x'])[0];
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(cur, a.u);
      S.calendar.saveCfg(cur, { scheduleOn: true });
      S.nav.open('calendar', { charId: cur });
    }, A);
    await sleep(800);

    const c2 = await page.evaluate((a) => {
      const S = window.Sleepy;
      const u = (S.store.get('sandboxes') || []).filter((s) => s.id === a.sb)[0];
      const cid = (u ? (u.charIds || []) : ['x'])[0];
      const root = document.querySelector('[data-page="calendar"]');
      const ann = S.calendar.anniversariesOn(cid, '2031-05-20');
      const facts = String(S.calendar.timeFacts(cid, {}) || '');
      const sched = (facts.split('\n').filter((l) => l.indexOf('你近期的安排') === 0)[0]) || '';
      return {
        annN: ann.length,
        annTitle: ann[0] ? ann[0].title : '',
        inPage: root ? String(root.textContent || '').indexOf(a.tag) >= 0 : false,
        inSched: sched.indexOf(a.tag) >= 0,
        inFacts: facts.indexOf(a.tag) >= 0
      };
    }, A);
    chk('C2a 刷新后纪念日仍在（事件表 + 纪念日区）',
      c2.annN === 1 && c2.annTitle.indexOf(A.tag) >= 0, JSON.stringify(c2));
    chk('C2b 纪念日不泄进「近期安排」', c2.inSched === false, c2.inSched ? '泄了' : '没泄');

    /* ---------- C3 重复保存：拒绝并说明，不建第二条 ---------- */
    const c3 = await page.evaluate((a) => {
      const S = window.Sleepy;
      const u = (S.store.get('sandboxes') || []).filter((s) => s.id === a.sb)[0];
      const cid = (u ? (u.charIds || []) : ['x'])[0];
      const mem = { id: 'mem_w3_' + a.tag, content: '想换掉的名字' };
      const same = S.calendar.saveAnniversary(cid, mem, { date: '2031-05-20' });
      const diff = S.calendar.saveAnniversary(cid, mem, {
        date: '2031-06-11', title: '换个日子换个名字'
      });
      const key = 'anniversary:' + a.sb + ':mem_w3_' + a.tag;
      return {
        sameOk: !!same.ok, sameDup: !!same.dup,
        diffOk: !!diff.ok, diffCode: diff.ok ? '' : (diff.error && diff.error.code),
        diffMsg: diff.ok ? '' : String((diff.error && diff.error.message) || ''),
        n: window.__w3.evByKey(key).length
      };
    }, A);
    chk('C3a 无差异重跑 → 幂等 dup', c3.sameOk && c3.sameDup, JSON.stringify(c3));
    chk('C3b 改了日期/标题 → 明确拒绝（already-marked），不建第二条',
      c3.diffOk === false && c3.diffCode === 'already-marked' && c3.n === 1,
      JSON.stringify(c3));

    /* ---------- C4 帷境：只打开不确认，不许写日历 ---------- */
    const wj = await page.evaluate((a) => {
      const S = window.Sleepy;
      const u = (S.store.get('sandboxes') || []).filter((s) => s.id === a.sb)[0];
      const cid = (u ? (u.charIds || []) : ['x'])[0];
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(cid, a.u);
      const w = S.wj.createDraft({
        title: a.tag + '·定史剧本', reality: 'canon_candidate',
        cast: [{ charId: cid, name: a.tag + '·甲' }]
      });
      S.wjCanon.setCandidates(w.id, [{
        kind: 'shared_event', text: a.tag + '·那天的展', date: '2031-07-07'
      }]);
      const c = S.wjCanon.get(w.id).candidates[0];
      S.wjCanon.decide(w.id, c.id, 'keep');
      S.wjCanon.setKnowledge(w.id, cid, c.id, '清晰记忆');
      S.wjCanon.setStep(w.id, 3);
      const before = (S.store.get('calEvents') || []).length;
      /* 打开审阅台那一屏（真实注册页，走真渲染） */
      S.nav.open('wj-canon', { workId: w.id });
      return { workId: w.id, cid, candId: c.id, before };
    }, A);
    await sleep(900);

    const c4 = await page.evaluate((o) => {
      const S = window.Sleepy;
      const after = (S.store.get('calEvents') || []).length;
      const root = document.querySelector('[data-page="wj-canon"]');
      return {
        grew: after - o.before,
        hasPage: !!root,
        hasGo: !!(root && String(root.textContent || '').indexOf('写入现实') >= 0),
        planCount: S.wjCanon.plan(o.workId).count,
        recWritten: S.wjCanon.get(o.workId).written
      };
    }, wj);
    chk('C4 打开审阅台（不点确认）→ calEvents 零增长、rec.written 仍为假',
      c4.grew === 0 && c4.recWritten !== true && c4.planCount > 0, JSON.stringify(c4));
    chk('C4b 审阅台那一屏渲染出来了（有「写入现实」按钮）', c4.hasPage && c4.hasGo,
      'page=' + c4.hasPage + ' go=' + c4.hasGo);

    /* ---------- C5 / C6 真实点击确认 ---------- */
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-page="wj-canon"]');
      const btns = window.__w3.byClass(root, 'wj-btn').filter(window.__w3.vis);
      const go = btns.filter((b) => window.__w3.text(b).indexOf('写入现实') >= 0)[0];
      if (!go) return false;
      if (go.disabled) return 'disabled';
      go.click();
      return true;
    });
    await sleep(900);
    const c5 = await page.evaluate((o) => {
      const S = window.Sleepy;
      const rec = S.wjCanon.get(o.workId);
      const evs = window.__w3.evByKey(S.wjCanon.canonRequestKey(o.workId, o.candId, o.cid));
      const ev = evs[0] || null;
      return {
        clicked: true,
        written: rec.written,
        pending: rec.writtenPending,
        refs: (rec.eventRefs || []).length,
        refId: (rec.eventRefs || [])[0] ? rec.eventRefs[0].eventId : null,
        realEv: ev ? ev.id : null,
        status: ev ? ev.status : null,
        via: ev ? ev.authorizedVia : null,
        n: evs.length,
        pageTxt: String((document.querySelector('[data-page="wj-canon"]') || {}).textContent || '').slice(0, 160)
      };
    }, wj);
    chk('C5a 点「写入现实」后 rec.written 置真', c5.written === true, JSON.stringify({ w: c5.written, p: c5.pending }));
    chk('C5b eventRefs 指向真实事件（不是模型自报）',
      c5.refs === 1 && c5.refId && c5.refId === c5.realEv, JSON.stringify(c5));
    chk('C5c 事件是定史（authorizedVia=review_desk / confirmed）',
      c5.via === 'review_desk' && c5.status === 'confirmed', c5.via + '/' + c5.status);
    chk('C5d 页面不再显示「写入现实」（已写完态）',
      c5.pageTxt.indexOf('已经写过了') >= 0, c5.pageTxt.slice(0, 90));

    /* C6 重复点：按钮已消失；再直接调 write 也必须 already-written */
    const c6 = await page.evaluate((o) => {
      const S = window.Sleepy;
      const root = document.querySelector('[data-page="wj-canon"]');
      const stillGo = window.__w3.byClass(root, 'wj-btn').filter(window.__w3.vis)
        .some((b) => window.__w3.text(b).indexOf('写入现实') >= 0);
      const again = S.wjCanon.write(o.workId);
      const n = window.__w3.evByKey(S.wjCanon.canonRequestKey(o.workId, o.candId, o.cid)).length;
      return { stillGo, ok: again.ok, why: again.why || '', n };
    }, wj);
    chk('C6 重复确认：不新增第二条（页面无按钮 + write 返回 already-written）',
      c6.stillGo === false && c6.ok === false && c6.why === 'already-written' && c6.n === 1,
      JSON.stringify(c6));

    /* ---------- C7 失败样本不显示「已写入」 ---------- */
    const c7 = await page.evaluate((a) => {
      const S = window.Sleepy;
      const u = (S.store.get('sandboxes') || []).filter((s) => s.id === a.sb)[0];
      const cid = (u ? (u.charIds || []) : ['x'])[0];
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(cid, a.u);
      const w2 = S.wj.createDraft({
        title: a.tag + '·会失败的剧本', reality: 'canon_candidate',
        cast: [{ charId: cid, name: a.tag + '·甲' }]
      });
      S.wjCanon.setCandidates(w2.id, [{
        kind: 'shared_event', text: a.tag + '·写不进去的那天', date: '2031-08-08'
      }]);
      const c2d = S.wjCanon.get(w2.id).candidates[0];
      S.wjCanon.decide(w2.id, c2d.id, 'keep');
      S.wjCanon.setKnowledge(w2.id, cid, c2d.id, '清晰记忆');
      S.wjCanon.setStep(w2.id, 3);
      /* 注入失败：统一入口在这一条上拒 */
      const real = S.calendar.requestCreateEvent;
      S.calendar.requestCreateEvent = () => ({ ok: false, error: { code: 'write-failed', message: '注入' } });
      let r;
      try { r = S.wjCanon.write(w2.id); } finally { S.calendar.requestCreateEvent = real; }
      S.nav.open('wj-canon', { workId: w2.id });
      return {
        workId: w2.id, evFailed: (r.evFailed || []).length,
        written: S.wjCanon.get(w2.id).written,
        pending: S.wjCanon.get(w2.id).writtenPending
      };
    }, A);
    await sleep(800);
    const c7b = await page.evaluate((o) => {
      const root = document.querySelector('[data-page="wj-canon"]');
      const txt = String((root || {}).textContent || '');
      return {
        saysWritten: txt.indexOf('已经写过了') >= 0,
        saysPending: txt.indexOf('没记上') >= 0 || txt.indexOf('可以再点一次补') >= 0
      };
    }, c7);
    chk('C7a 日历全失败时 rec.written 不为真、标出可重跑',
      c7.evFailed === 1 && c7.written !== true && c7.pending === true, JSON.stringify(c7));
    chk('C7b 页面不显示「已经写过了」，而是显示半完成态',
      c7b.saysWritten === false && c7b.saysPending === true, JSON.stringify(c7b));

    /* ---------- 清理 + C8 ---------- */
    await page.evaluate((a) => {
      const S = window.Sleepy;
      try { S.core._purgeSync.sandbox(a.sb); } catch (e) { /* 已拆 */ }
      const sandboxes = S.store.get('sandboxes') || [];
      (S.wj.all() || []).forEach((w) => {
        if (String(w.title || '').indexOf(a.tag) >= 0) { try { S.wj.remove(w.id); } catch (e) {} }
      });
      sandboxes.filter((s) => String(s.name || '').indexOf(a.tag) >= 0)
        .forEach((s) => { try { S.core._purgeSync.sandbox(s.id); } catch (e) {} });
    }, A);

    chk('C8 全程没有 [Sleepy] 报错', allErrs.length === 0, allErrs.slice(0, 3).join(' || '));

    console.log('\n--- 日历写入全链路收口 · 第三轮 无头 Edge 汇总 ---');
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
