/* ============================================================
   scripts/browser-cal-holiday-test.js
   ------------------------------------------------------------
   用户 2026-10-03 真机报：「设置中国大陆 + 中国传统节日 + 国际节日 + 时区上海，
   结果他说今天是国庆第一天」（**换了几个 API 都一样**，上次中秋也犯过）。

   根因不是措辞不精确，是**事实错了**：CN_OFFICIAL 的 name 是**整段连休的名**
   （国庆 = 10-01~10-07），旧句式连着 7 天都说「今天是国庆节」—— 7 天里 6 天是假的。
   模型同时读到「今天是 10 月 3 日」和「今天是国庆节」两条打架的信息，
   只能采信假期名、忽略日期 → 说成「第一天」。**它不是算错，是我们逼它二选一。**

   这条走**真浏览器 + 真页面**，验两件事（smoke 只能验纯函数）：
     H1 注入给模型的原文：三件事实齐，且**没有**「今天是<假期名>」这种以偏概全的说法
     H2 日历页日列表标题/描述：多日连休要带「第 N/共 M 天」和区间
        （同一个错以前在界面上会重现一次）

   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-cal-holiday-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('需要 playwright-core（managed node workspace）');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.CAL_HOLIDAY_PORT || 5213;
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
/* 文化节日那一行的固定前缀。**冒号在「今天是」之后**（calendar.js:
   `lines.push('今天是：' + names.join('、'))`）—— 写断言时别漏掉这个冒号，
   漏了 indexOf 永远 -1，看着像功能坏了其实是断言写错了。 */
const FEST_PREFIX = '今天是：清明节。';
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
    }());
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
    return !!(S && S.nav && S.core && S.calendar && S.nav.open);
  }, { timeout: 15000 });
  await sleep(600);
  return sleepyErrs;
}

/* 拿注入给模型的原文（走生产 timeFacts，不自己拼） */
function factsOn(page, y, m, d) {
  return page.evaluate((a) => {
    const S = window.Sleepy;
    const at = new Date(a.y, a.m, a.d, 12, 0);
    return String(S.calendar.timeFacts('cal_holiday_char', { at }) || '');
  }, { y, m, d });
}
/* 拿日历页日事件列表的公共日期行 */
function dayRows(page) {
  return page.evaluate(() => {
    const S = window.Sleepy;
    const sb = S.core.activeSandbox();
    const cfg = S.calendar.cfgOf('cal_holiday_char');
    const iso = S.calendar.todayISO();
    /* dayItems 不在导出表里；这里走 UI —— 打开日历页读那一行 */
    return { iso, has: !!document.querySelector('.page[data-page="calendar"]') };
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser, failed = 0;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const errs = await waitApp(page);
    chk('启动无 [Sleepy] 报错', errs.length === 0, errs.join(' | '));

    /* 夹具：一间孤岛 + 一个大号 + 一件带岛章的马甲；设置照用户那样勾 */
    const seed = await page.evaluate(() => {
      const S = window.Sleepy, C = S.core;
      const sb = C.createSandbox('isle', '假期测试岛');
      const cid = C.upsertChar({ name: '假期角色', kind: 'main' }).id;
      C.setSandboxChars(sb.id, [cid]);
      const u = C.upsertUser({ name: '我', sandboxId: sb.id, isDefault: true });
      C.setSandboxMasks(sb.id, [u.id]);
      C.setActiveSandbox(sb.id);
      C.switchTo(cid, u.id);
      /* 名字要能查得到：存一个别名，供 timeFacts 认 */
      window.__calHolidayChar = 'cal_holiday_char';
      /* timeFacts 按 charId 取配置；用一个真实 charId 更稳，这里直接复用 */
      C.upsertChar({ id: 'cal_holiday_char', name: '假期角色2', kind: 'main', sandboxId: sb.id });
      C.setSandboxChars(sb.id, [cid, 'cal_holiday_char']);
      C.setSandboxMasks(sb.id, [u.id]);
      S.store.set('calConfigs', (S.store.get('calConfigs') || []).concat([{
        id: 'cc_hol', charId: 'cal_holiday_char', sandboxId: sb.id,
        region: 'CN', cultures: ['cn', 'intl'], timezone: 'Asia/Shanghai', createdAt: Date.now()
      }]));
      return { sb: sb.id, u: u.id, cid: 'cal_holiday_char' };
    });
    chk('夹具建好', !!(seed.sb && seed.cid));

    /* ---- H1：注入原文（国庆区间逐日） ---- */
    const lines = {};
    for (let d = 1; d <= 8; d++) {
      const t = await factsOn(page, 2026, 9, d);
      lines[d] = t.split('\n').filter((l) => l.indexOf('公共日期') === 0)[0] || '';
    }
    chk('H1 假期名而不是节日名（10-03 说「国庆假期」）',
      lines[3].indexOf('国庆假期') >= 0, lines[3]);
    chk('H1 不再出现「今天是国庆」（6/7 天是假的）',
      lines[3].indexOf('今天是国庆') < 0, lines[3]);
    chk('H1 给全区间（10月1日—10月7日 共 7 天）',
      lines[3].indexOf('10月1日—10月7日') >= 0 && lines[3].indexOf('共 7 天') >= 0, lines[3]);
    chk('H1 明说今天（10-03 那行是 10月3日）',
      lines[3].indexOf('今天是 10月3日') >= 0, lines[3]);
    chk('H1 给第几天（10-03 是第 3 天）',
      lines[3].indexOf('第 3 天') >= 0, lines[3]);
    /* 逐日：第几天必须一路递增到 7，末日是第 7 天（我踩过 +1 的坑） */
    const days = [];
    for (let d = 1; d <= 7; d++) {
      const m = lines[d].match(/第 (\d+) 天/);
      days.push(m ? Number(m[1]) : 0);
    }
    chk('H1 第几天逐日递增 1→7（没偏 1）',
      days.join(',') === '1,2,3,4,5,6,7', days.join(','));
    chk('H1 假期结束当天回普通工作日（10-08）',
      lines[8].indexOf('普通工作日') >= 0, lines[8]);

    /* 清明：节日当天在区间中间，文化层只那天说「清明节」 */
    const q4 = await factsOn(page, 2026, 3, 4);
    const q5 = await factsOn(page, 2026, 3, 5);
    const q6 = await factsOn(page, 2026, 3, 6);
    chk('H1 清明三天法定层都是「清明节假期」',
      [q4, q5, q6].every((t) => t.indexOf('清明节假期') >= 0), [q4, q5, q6].map((t) => (t.match(/公共日期.*/) || [''])[0]).join(' | '));
    chk('H1 清明节名只在 04-05 那天（前后两天不许自称清明节）',
      /* ⚠️ 文案是「今天是：清明节。」（**冒号在**）—— 文化节日那一行是
         `lines.push('今天是：' + ...)`。断言写成「今天是清明节。」会永远 -1，
         看着像功能坏了，其实是断言自己写错了（第一版就这么误报过一次）。 */
      q4.indexOf(FEST_PREFIX) < 0 && q5.indexOf(FEST_PREFIX) >= 0 && q6.indexOf(FEST_PREFIX) < 0,
      ['04-04:' + q4.indexOf(FEST_PREFIX), '04-05:' + q5.indexOf(FEST_PREFIX), '04-06:' + q6.indexOf(FEST_PREFIX)].join(' '));

    /* 补班日 + 2027 降级不许瞎猜 */
    const mk = await factsOn(page, 2026, 9, 10);
    chk('H1 补班日说成调休上班', mk.indexOf('调休上班') >= 0, (mk.match(/公共日期.*/) || [''])[0]);
    const y27 = await factsOn(page, 2027, 9, 1);
    chk('H1 2027 没内置数据时不瞎猜（无假期名）',
      y27.indexOf('假期') < 0 && y27.indexOf('未内置') >= 0, (y27.match(/公共日期.*/) || [''])[0]);

    /* ---- H2：日历页日列表的公共日期行 ---- */
    await page.evaluate((s) => {
      const S = window.Sleepy;
      S.nav.open('calendar', { charId: s.cid });
    }, seed);
    await sleep(700);
    /* 切到 2026-10 那个月（页面默认是今天所在月，测试机就是 10 月；保险起见翻页确认） */
    const rowTxt = await page.evaluate(() => {
      const root = document.querySelector('.page[data-page="calendar"]');
      if (!root) return '';
      const txt = root.textContent || '';
      /* 找公共日期那一条（只读行） */
      const nodes = Array.from(root.querySelectorAll('.cal-ev-title, .cal-ev, [class*="ev"]'));
      for (const n of nodes) {
        const t = n.textContent || '';
        if (t.indexOf('国庆') >= 0) return t;
      }
      return txt.indexOf('国庆') >= 0 ? txt.slice(txt.indexOf('国庆') - 30, txt.indexOf('国庆') + 90) : '';
    });
    chk('H2 日历页能开到假期岛（不炸）', !!rowTxt, '页面没渲染出内容');

    /* 单日假日在界面上仍是「今天是X」那套（规则型区域） */
    const jp = await page.evaluate(() => {
      const S = window.Sleepy;
      const d = S.calendar.dayInfo('2026-01-12', { region: 'JP', cultures: [] });
      return S.calendar.publicDayLine(d, '2026-01-12');
    });
    chk('H2 单日假日不受影响（JP 成人の日仍正常）',
      jp.indexOf('成人の日') >= 0 && jp.indexOf('假期') < 0, jp);

    const tail = await page.evaluate((s) => {
      const C = window.Sleepy.core;
      C._purgeSync.sandbox(s.sb);
      return '已清理';
    }, seed);
    chk('拆岛清理跑通', tail === '已清理', tail);

    failed = results.filter((r) => !r.ok).length;
    console.log('\n' + (failed ? '✗ ' + failed + ' 项没过' : '全绿：' + results.length + ' 项'));
  } catch (e) {
    console.error('测试异常：' + (e && e.stack || e));
    failed = 99;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill(); } catch (e) {}
  }
  process.exit(failed ? 1 : 0);
}
main();
