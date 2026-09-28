/* ============================================================
   scripts/browser-tz-test.js — 运行时时区三级兜底 真机行为验收（v2 原生时区）
   ------------------------------------------------------------
   2026-09-28 We 收尾（第二轮验收口径）：
   设备时区用 Playwright 原生 newContext({ timezoneId }) 模拟
   （playwright-core 1.63 原生支持，Chromium 真实替换 OS 时区），
   同一测试时刻用 context.clock.setFixedTime 固定 ——
   **不改 Date getter、不包装正常路径的 Intl**；Intl 故障注入
   只出现在 fallback 专用的第三个 context，不替代正常路径。

   固定时刻：2026-09-28T05:00:00Z（跨日点）
     Asia/Shanghai      2026-09-28 13:00 周一
     America/Los_Angeles 2026-09-27 22:00 周日
     Asia/Tokyo         2026-09-28 14:00 周一
     Europe/Paris       2026-09-28 07:00 周一
     UTC                2026-09-28 05:00 周一

   验证的闭环：
     TZ1  无显式配置：设备时区生效（level=device，时间=上海现在）
     TZ2  显式 Tokyo：不随设备漂移（沪/洛两个 context 同一时刻都=东京）
     TZ3  日历显式覆盖 > 角色（Tokyo 角色被覆盖成 Paris → 07:00）
     TZ4  真正打开月历并切换月份：不挂起、月份/今天高亮正确
     TZ5  We 此刻：无配置=设备口径；切显式角色=角色口径（有意不同的双口径）
     TZ6  We 时光日期分组：按设备本地日期（LA 跨天 9/27 周日 vs 上海 9/28 周一）
     TZ7  线上/线下提示词注入 = 各自运行时上下文
     TZ8  设置语义：仅改无关字段再保存，不会把解析出的设备时区写成显式配置
     TZ9  char.timezone 全程未被回写
     TZ10 无效时区旧值（'Mars/Olympus'）：校验失败跳级 → 跟设备，不直接采用
     TZ11 fallback（独立 context，Intl 故障注入）：UTC + 文本标注
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-tz-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-tz-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-tz-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.TZ_TEST_PORT || 5201;
const BASE = 'http://127.0.0.1:' + PORT;
const FIXED_MS = Date.parse('2026-09-28T05:00:00Z');

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
    return !!(S && S.nav && S.core && S.core.activeSandbox && S.weStore && S.nav.open);
  }, null, { timeout: 20000 });
  await sleep(600);
  return sleepyErrs;
}

/* fallback 专用：只劫持「未显式传 timeZone」的 resolvedOptions 让它抛错。
   显式 tz（tzNow / tzUsable 校验）不受影响 —— 正常路径没被包装。 */
const INIT_INTL_FAIL = `
(() => {
  const RealDTF = Intl.DateTimeFormat;
  const RealRO = RealDTF.prototype.resolvedOptions;
  class PatchedDTF extends RealDTF {
    constructor(...args) {
      super(...args);
      this.__explicit = !!(args[1] && Object.prototype.hasOwnProperty.call(args[1], 'timeZone'));
    }
  }
  PatchedDTF.prototype.resolvedOptions = function () {
    if (!this.__explicit) throw new Error('tz-mock: 设备时区读取失败');
    return RealRO.call(this);
  };
  Intl.DateTimeFormat = PatchedDTF;
})();
`;

const PAGE_HELPERS = `
window.__tz = {
  expect(tz, at) {
    const d = at ? new Date(at) : new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(d);
    const g = {};
    parts.forEach((p) => { g[p.type] = p.value; });
    return {
      iso: g.year + '-' + g.month + '-' + g.day,
      time: (g.hour === '24' ? '00' : g.hour) + ':' + g.minute
    };
  },
  rt(charId) { return window.Sleepy.calendar.runtimeTzOf(charId); },
  facts(charId) { return String(window.Sleepy.calendar.timeFacts(charId) || ''); },
  nowLine(charId) {
    const m = this.facts(charId).match(/你的现在：(.+)/);
    return m ? m[1] : '';
  },
  cfgRecTimezone(charId) {
    const rec = (window.Sleepy.store.get('calConfigs') || [])
      .filter((r) => r && r.charId === charId).pop();
    return rec ? Object.prototype.hasOwnProperty.call(rec, 'timezone') ? rec.timezone : undefined : undefined;
  }
};
`;

/* 岛 + 角色组 + 马甲。chars: [{timezone, city, region}]。
   多角色必须用群岛（archipelago）—— 孤岛 setSandboxChars 会静默拒绝。 */
async function seedIsland(page, name, chars) {
  return page.evaluate((payload) => {
    const S = window.Sleepy;
    const sb = S.core.createSandbox('archipelago', payload.name);
    const ids = payload.chars.map((cx) => {
      const data = Object.assign({ name: cx.name, kind: 'main' }, cx.extra || {});
      return S.core.upsertChar(data).id;
    });
    const u = S.core.upsertUser({ name: '我' }).id;
    S.core.setSandboxChars(sb.id, ids);
    S.core.setSandboxMasks(sb.id, [u]);
    return { sb: sb.id, chars: ids, u };
  }, { name, chars });
}

async function boot(browser, opts) {
  const ctx = await browser.newContext(opts || {});
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
  const errs = await waitApp(page);
  await page.clock.setFixedTime(new Date(FIXED_MS));   /* 同一测试时刻（boot 后再定，避免冻结启动定时器） */
  await page.evaluate(PAGE_HELPERS);
  return { ctx, page, errs };
}

async function main() {
  process.on('uncaughtException', (e) => { console.error('[uncaught] ' + (e && e.stack || e)); process.exit(3); });
  process.on('unhandledRejection', (e) => { console.error('[unhandledRejection] ' + (e && e.stack || e)); process.exit(4); });
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });

    /* ==================== context 1：设备 Asia/Shanghai ==================== */
    const sh = await boot(browser, { timezoneId: 'Asia/Shanghai' });
    const page = sh.page;
    const nativeTz = await page.evaluate(() =>
      new Intl.DateTimeFormat().resolvedOptions().timeZone);
    chk('TZ0 原生 timezoneId 生效（context 报告 Asia/Shanghai，零包装）',
      nativeTz === 'Asia/Shanghai', 'native=' + nativeTz);

    const A = await seedIsland(page, '甲', [
      { name: '甲大号' },                                     /* 无时区 */
      { name: '东东京', extra: { city: '东京', region: 'JP', timezone: 'Asia/Tokyo' } },
      { name: '坏时区', extra: { timezone: 'Mars/Olympus' } }  /* 无效旧值 */
    ]);
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(a.sb);
      S.core.switchTo(a.chars[0], a.u);
    }, A);

    /* TZ1：无显式配置 → 设备时区生效 */
    const t1 = await page.evaluate((cid) => {
      const rt = window.__tz.rt(cid);
      const exp = window.__tz.expect('Asia/Shanghai', Date.now());
      return { rt, exp, line: window.__tz.nowLine(cid) };
    }, A.chars[0]);
    chk('TZ1 无显式配置：设备=上海生效 → level=device、时间=13:00（固定时刻）',
      t1.rt.level === 'device' && t1.rt.tz === 'Asia/Shanghai' &&
      t1.line.indexOf('13:00') >= 0 && t1.line.indexOf('2026年9月28日') >= 0,
      JSON.stringify({ rt: t1.rt, line: t1.line.slice(0, 60) }));

    /* TZ10：无效时区旧值 → 校验失败跳级跟设备（不直接采用） */
    const t10 = await page.evaluate((cid) => {
      const rt = window.__tz.rt(cid);
      return { rt, line: window.__tz.nowLine(cid) };
    }, A.chars[2]);
    chk('TZ10 无效时区值 Mars/Olympus：跳级 → level=device 按上海显示（不直接采用）',
      t10.rt.level === 'device' && t10.rt.tz === 'Asia/Shanghai' && t10.line.indexOf('13:00') >= 0,
      JSON.stringify({ rt: t10.rt, line: t10.line.slice(0, 50) }));

    /* TZ8：设置语义 —— 仅改无关字段再保存，设备时区不得被写成显式配置 */
    const t8 = await page.evaluate((cid) => {
      const S = window.Sleepy;
      const before = window.__tz.cfgRecTimezone(cid);
      S.calendar.saveCfg(cid, { scheduleOn: true });            /* 无关字段（UI 同款调用） */
      const afterSchedule = window.__tz.cfgRecTimezone(cid);
      S.core.upsertChar({ id: cid, timezone: '' });             /* idcard「跟随设备」保存空串 */
      const rt = window.__tz.rt(cid);
      return { before, afterSchedule, rt, charTz: String((S.core.rootOf(cid) || {}).timezone || '') };
    }, A.chars[0]);
    chk('TZ8 设置语义：无关字段保存不产生 timezone 键；空值保存仍 level=device（原值与有效值分离）',
      t8.before === undefined && t8.afterSchedule === undefined &&
      t8.rt.level === 'device' && t8.charTz === '',
      JSON.stringify(t8));

    /* TZ4：真正打开月历并切换月份（原生时区 context，无任何 mock） */
    await page.evaluate(() => window.Sleepy.nav.open('calendar'));
    await sleep(350);
    await page.evaluate(() => {
      const card = document.querySelector('.page[data-page="calendar"] .cal-charcard');
      if (card) card.click();
    });
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/tz2-calendar.png') });
    const t4a = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="calendar"]');
      const title = el.querySelector('.cal-monthtitle');
      const today = el.querySelector('.cal-days .cal-day.is-today .cal-day-num');
      const days = el.querySelectorAll('.cal-days .cal-day').length;
      return { ym: title ? title.textContent : '', today: today ? today.textContent : '', days };
    });
    await page.evaluate(() => {
      const btns = document.querySelectorAll('.page[data-page="calendar"] .cal-navbtn');
      btns[btns.length - 1].click();                           /* 下个月 */
    });
    await sleep(250);
    const t4b = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="calendar"]');
      return el.querySelector('.cal-monthtitle').textContent;
    });
    await page.evaluate(() => {
      const btns = document.querySelectorAll('.page[data-page="calendar"] .cal-navbtn');
      btns[0].click();                                          /* 上个月（回来） */
    });
    await sleep(250);
    const t4c = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="calendar"]');
      const btns = el.querySelectorAll('.cal-navbtn');
      btns[0].click(); btns[0].click(); btns[0].click();        /* 连翻三月：九月→八月→七月→六月 */
      return el.querySelector('.cal-monthtitle').textContent;
    });
    await sleep(200);
    const t4d = await page.evaluate(() =>
      document.querySelector('.page[data-page="calendar"] .cal-monthtitle').textContent);
    chk('TZ4 月历真开：九月（今天高亮 28）→ 下月十月 → 返回九月 → 连翻三月到六月，全程不挂起',
      t4a.ym.indexOf('2026') >= 0 && t4a.ym.indexOf('九月') >= 0 &&
      t4a.today === '28' && t4a.days >= 28 &&
      t4b.indexOf('十月') >= 0 && t4c.indexOf('六月') >= 0 && t4d.indexOf('六月') >= 0,
      JSON.stringify({ a: t4a, next: t4b, three: t4c, settled: t4d }));
    const calErrs = sh.errs.filter((l) => l.indexOf('page-calendar') >= 0).length;
    chk('TZ4b 月历渲染无 [Sleepy] 报错', calErrs === 0, 'errs=' + calErrs);

    /* TZ5a：We 此刻 —— 无配置角色的设备口径 */
    await page.evaluate(() => { window.Sleepy.nav.closeAll(); });
    await sleep(200);
    await page.evaluate(() => window.Sleepy.nav.open('we'));
    await sleep(300);
    const t5a = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="we"]');
      const txt = el ? (el.textContent || '') : '';
      return { has: txt.indexOf('你的现在：') >= 0, time: txt.indexOf('13:00') >= 0 };
    });
    chk('TZ5a We「此刻」：无配置角色 → 设备口径（13:00 上海）',
      sh.errs.filter((l) => l.indexOf('page-we') >= 0).length === 0 && t5a.has && t5a.time,
      JSON.stringify(t5a));

    /* TZ5b：切显式 Tokyo 角色 → 此刻变角色口径（有意保留的双口径之一） */
    await page.evaluate((a) => {
      const S = window.Sleepy;
      S.core.switchTo(a.chars[1], a.u);
      S.nav.topCtx().refresh();
    }, A);
    await sleep(250);
    const t5b = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="we"]');
      const txt = el ? (el.textContent || '') : '';
      return { tokyo: txt.indexOf('14:00') >= 0, notSH: txt.indexOf('13:00') < 0 };
    });
    chk('TZ5b We「此刻」：显式 Tokyo 角色 → 角色口径（14:00，不跟设备）',
      t5b.tokyo && t5b.notSH, JSON.stringify(t5b));

    /* TZ6：We 时光日期分组 = 设备本地日期（上海 9/28 周一） */
    const t6 = await page.evaluate(() =>
      window.Sleepy.weTime.dayLabel(Date.parse('2026-09-28T05:00:00Z')));
    chk('TZ6 时光分组：设备本地日期 上海=9月28日·周一',
      t6 === '9月28日 · 周一', 'label=' + t6);

    /* TZ7a：线上/线下注入 = 运行时上下文（无配置角色 → 上海） */
    const t7a = await page.evaluate((o) => {
      window.__tzFixedBack = null;
      const on = window.Sleepy.promptEngine.assembleOnline({ charId: o.cid, userId: o.uid, history: [] });
      const segOn = (on.messages || []).filter((s) => s.role === 'system').map((s) => s.content || '').join('\n');
      const off = window.Sleepy.promptEngine.assembleOffline({
        charId: o.cid, userId: o.uid,
        session: { sceneName: '场景', sceneCount: 1, env: {}, messages: [] }
      });
      const segOff = (off.messages || []).map((s) => s.content || '').join('\n');
      return {
        on: (segOn.match(/你的现在：(.+)/) || [])[1] || '',
        off: (segOff.match(/【现实时间】(.+)/) || [])[1] || ''
      };
    }, { cid: A.chars[0], uid: A.u });
    chk('TZ7a 线上【时间事实】与线下【现实时间】= 上海 13:00（无配置角色跟设备）',
      t7a.on.indexOf('13:00') >= 0 && t7a.off.indexOf('13:00') >= 0,
      JSON.stringify(t7a));
    /* 显式 Tokyo 角色的线下 = 东京 */
    const t7b = await page.evaluate((o) => {
      const off = window.Sleepy.promptEngine.assembleOffline({
        charId: o.cid, userId: o.uid,
        session: { sceneName: '东京场景', sceneCount: 1, env: {}, messages: [] }
      });
      const seg = (off.messages || []).map((s) => s.content || '').join('\n');
      return (seg.match(/【现实时间】(.+)/) || [])[1] || '';
    }, { cid: A.chars[1], uid: A.u });
    chk('TZ7b 线下：显式 Tokyo 角色 = 东京 14:00（不随设备漂移）',
      t7b.indexOf('14:00') >= 0 && t7b.indexOf('13:00') < 0, 'line=' + t7b.slice(0, 40));

    /* TZ9a：char.timezone 未被回写 */
    const t9a = await page.evaluate((ids) => {
      const S = window.Sleepy;
      return {
        noTz: String((S.core.rootOf(ids[0]) || {}).timezone || ''),
        tokyo: String((S.core.rootOf(ids[1]) || {}).timezone || ''),
        bad: String((S.core.rootOf(ids[2]) || {}).timezone || '')
      };
    }, A.chars);
    chk('TZ9 char.timezone 全程未被回写（空仍空、Tokyo 仍 Tokyo、坏值原样保存不清洗）',
      t9a.noTz === '' && t9a.tokyo === 'Asia/Tokyo' && t9a.bad === 'Mars/Olympus',
      JSON.stringify(t9a));
    await sh.ctx.close();

    /* ==================== context 2：设备 America/Los_Angeles ==================== */
    const la = await boot(browser, { timezoneId: 'America/Los_Angeles' });
    const page2 = la.page;
    const nativeTz2 = await page2.evaluate(() =>
      new Intl.DateTimeFormat().resolvedOptions().timeZone);
    chk('TZ0b 原生 timezoneId 生效（America/Los_Angeles）', nativeTz2 === 'America/Los_Angeles', 'native=' + nativeTz2);

    const B = await seedIsland(page2, '乙', [
      { name: '乙大号' },
      { name: '乙东京', extra: { city: '东京', region: 'JP', timezone: 'Asia/Tokyo' } }
    ]);
    await page2.evaluate((b) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(b.sb);
      S.core.switchTo(b.chars[0], b.u);
    }, B);

    /* TZ2：显式 Tokyo 在 LA 设备下不漂移（与 context1 同一固定时刻） */
    const t2 = await page2.evaluate((cid) => {
      const rt = window.__tz.rt(cid);
      const line = window.__tz.nowLine(cid);
      return { rt, line };
    }, B.chars[1]);
    chk('TZ2 显式 Tokyo：洛杉矶设备下仍 14:00（2026-09-28，东京）不漂移',
      t2.rt.level === 'char' && t2.rt.tz === 'Asia/Tokyo' &&
      t2.line.indexOf('14:00') >= 0 && t2.line.indexOf('2026年9月28日') >= 0,
      JSON.stringify({ rt: t2.rt, line: t2.line.slice(0, 60) }));

    /* TZ3：日历显式覆盖 > 角色（Tokyo 被日历覆盖成 Paris → 07:00） */
    const t3 = await page2.evaluate((cid) => {
      const S = window.Sleepy;
      S.calendar.saveCfg(cid, { timezone: 'Europe/Paris' });
      const rt = window.__tz.rt(cid);
      const line = window.__tz.nowLine(cid);
      /* 摘掉覆盖（UI「恢复跟随」同款）→ 回到角色层 */
      S.calendar.resetToPlace(cid);
      const rt2 = window.__tz.rt(cid);
      return { rt, line, rt2 };
    }, B.chars[1]);
    chk('TZ3 日历覆盖 Paris > 角色 Tokyo：level=calendar、07:00；恢复跟随回东京',
      t3.rt.level === 'calendar' && t3.rt.tz === 'Europe/Paris' &&
      t3.line.indexOf('07:00') >= 0 && t3.line.indexOf('22:00') < 0 &&
      t3.rt2.level === 'char' && t3.rt2.tz === 'Asia/Tokyo',
      JSON.stringify({ rt: t3.rt, line: t3.line.slice(0, 50), rt2: t3.rt2 }));

    /* 无配置角色 → LA 设备口径 */
    const t2d = await page2.evaluate((cid) => {
      const rt = window.__tz.rt(cid);
      const line = window.__tz.nowLine(cid);
      return { rt, line };
    }, B.chars[0]);
    chk('TZ2b 无显式配置：洛杉矶设备 → level=device、22:00（2026-09-27 周日，跨天）',
      t2d.rt.level === 'device' && t2d.rt.tz === 'America/Los_Angeles' &&
      t2d.line.indexOf('22:00') >= 0 && t2d.line.indexOf('2026年9月27日') >= 0,
      JSON.stringify({ rt: t2d.rt, line: t2d.line.slice(0, 60) }));

    /* TZ6b：时光分组 = 设备本地日期（LA 9/27 周日，与上海 context 的 9/28 周一不同） */
    const t6b = await page2.evaluate(() => {
      const ts = Date.parse('2026-09-28T05:00:00Z');
      return window.Sleepy.weTime.dayLabel(ts);
    });
    chk('TZ6b 时光分组：同一时刻 LA=9月27日·周日（上海 context 是 9月28日·周一 —— 分组跟设备本地日期）',
      t6b === '9月27日 · 周日', 'label=' + t6b);

    /* TZ5c：We 此刻（LA 设备 + 无配置角色 = 设备口径） */
    await page2.evaluate(() => window.Sleepy.nav.open('we'));
    await sleep(300);
    const t5c = await page2.evaluate(() => {
      const el = document.querySelector('.page[data-page="we"]');
      const txt = el ? (el.textContent || '') : '';
      return { has: txt.indexOf('你的现在：') >= 0, time: txt.indexOf('22:00') >= 0 };
    });
    chk('TZ5c We「此刻」：洛杉矶设备 + 无配置角色 → 22:00 设备口径',
      la.errs.filter((l) => l.indexOf('page-we') >= 0).length === 0 && t5c.has && t5c.time,
      JSON.stringify(t5c));

    /* TZ9b：char.timezone 未被回写（LA context） */
    const t9b = await page2.evaluate((ids) => {
      const S = window.Sleepy;
      return {
        noTz: String((S.core.rootOf(ids[0]) || {}).timezone || ''),
        tokyo: String((S.core.rootOf(ids[1]) || {}).timezone || '')
      };
    }, B.chars);
    chk('TZ9b char.timezone 未被回写（洛杉矶 context）',
      t9b.noTz === '' && t9b.tokyo === 'Asia/Tokyo', JSON.stringify(t9b));
    await la.ctx.close();

    /* ==================== context 3：fallback（独立，Intl 故障注入） ==================== */
    const fb3ctx = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
    await fb3ctx.addInitScript(INIT_INTL_FAIL);
    const page3 = await fb3ctx.newPage();
    await page3.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const errs3 = await waitApp(page3);
    await page3.clock.setFixedTime(new Date(FIXED_MS));
    await page3.evaluate(PAGE_HELPERS);
    const C = await seedIsland(page3, '丙', [{ name: '丙大号' }]);
    await page3.evaluate((c) => {
      const S = window.Sleepy;
      S.core.setActiveSandbox(c.sb);
      S.core.switchTo(c.chars[0], c.u);
    }, C);
    const t11 = await page3.evaluate((cid) => {
      const rt = window.__tz.rt(cid);
      const facts = window.__tz.facts(cid);
      return { rt, facts, utc: window.__tz.expect('UTC', Date.now()) };
    }, C.chars[0]);
    chk('TZ11 fallback（独立 context，Intl 故障注入）：level=fallback、UTC 05:00、文本标注兜底；显式校验路径未被包装（tzUsable 仍真）',
      t11.rt.level === 'fallback' && t11.rt.tz === 'UTC' &&
      t11.facts.indexOf(t11.utc.time) >= 0 &&
      t11.facts.indexOf('时区未知，暂按 UTC 计') >= 0 &&
      t11.facts.indexOf('13:00') >= 0,   /* user 那边：13:00（显式 formatter 真实解析上海） */
      JSON.stringify({ rt: t11.rt, utc: t11.utc.time, tail: t11.facts.slice(0, 130) }));
    await fb3ctx.close();

    /* ---- 汇总 ---- */
    console.log('\n--- 运行时时区真机验收汇总（原生 timezoneId） ---');
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
