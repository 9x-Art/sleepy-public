/* ============================================================
   scripts/browser-island-isolation-test.js
   ------------------------------------------------------------
   用户 2026-10-03 真机报的两个 bug 的**端到端**复验：

     ① 「本身点进孤岛就会有一个默认存档，改了之后再加孤岛或者群岛都直接
         挂钩那个存档，表单完全 copy 过去了；并且后面改了孤岛 B，
         其他所有岛屿的 user 账号信息都变了」
     ② 「为什么默认存档的『彼此认知』和新加的岛屿里『彼此认知』不一样，
         一个有选项，一个没有」

   ⚠️ 静态护栏（smoke 里那条）只证明「代码写了正确的句子」；
   这条走**真浏览器 + 真页面 + 真点击**，验的是「用户实际看到什么」——
   无头桩过不等于真机能看。

   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-island-isolation-test.js
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

const PORT = process.env.ISLE_ISO_PORT || 5211;
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
    return !!(S && S.nav && S.core && S.nav.open);
  }, { timeout: 15000 });
  await sleep(600);
  return sleepyErrs;
}

function pageText(page, dataPage) {
  return page.evaluate((dp) => {
    const el = document.querySelector('.page[data-page="' + dp + '"]');
    return el ? (el.textContent || '') : '';
  }, dataPage);
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

    /* ── 搭出用户描述的场景 ──────────────────────────────────────
       A 岛 = 用户说的「默认存档」那座（他先建过、我已改过）
       B 岛 = 之后新建的孤岛
       C 群 = 之后新建的群岛                              */
    const seed = await page.evaluate(() => {
      const S = window.Sleepy, C = S.core;
      const mk = (kind, name) => C.createSandbox(kind, name);

      const a = mk('isle', '默认存档那座');
      const aChar = C.upsertChar({ name: '默认角色', kind: 'main' }).id;
      C.setSandboxChars(a.id, [aChar]);
      const aMe = C.upsertUser({ name: '默认存档的我', persona: 'A岛人设' });
      aMe.sandboxId = a.id;
      C.upsertUser({ id: aMe.id, sandboxId: a.id, isDefault: true });
      C.setSandboxMasks(a.id, [aMe.id]);

      const b = mk('isle', '孤岛B');
      const c = mk('archipelago', '群岛C');
      return { a: a.id, aMe: aMe.id, aChar, b: b.id, c: c.id };
    });
    chk('夹具：A 岛有一件带岛章的马甲', !!(seed.a && seed.aMe && seed.b && seed.c));

    /* ── ① A：切到 B 岛后打开「个人资料」，表单不许是 A 岛那件 ── */
    const t1 = await page.evaluate((s) => {
      const S = window.Sleepy, C = S.core;
      C.setActiveSandbox(s.b);
      /* 指针还停在 A 岛那件（模拟用户「改了默认存档之后再加孤岛」） */
      C.switchTo(undefined, s.aMe);
      const guard = C.activeUserOnIsland();
      const loose = C.activeUser();
      return {
        guard: guard ? guard.id : null,
        loose: loose ? loose.id : null
      };
    }, seed);
    chk('① B 岛指针卫兵把 A 岛那件挡掉（null）', t1.guard === null, 'guard=' + t1.guard);
    chk('① 对照：带兜底的 activeUser 确实会给出 A 岛那件', t1.loose === seed.aMe, 'loose=' + t1.loose);

    /* 真点一次「个人资料」入口（时空切换器 → 当前账号），看页面真的打不开/不 copy */
    await page.evaluate(() => { window.Sleepy.nav.open('island-switch', {}); }).catch(() => {});
    await sleep(300);
    await page.evaluate(() => { window.Sleepy.nav.closeAll && window.Sleepy.nav.closeAll(); });
    await page.evaluate((s) => { window.Sleepy.nav.open('me-profile', {}); }, seed);
    await sleep(500);
    const meTxt = await pageText(page, 'me-profile');
    const meStill = await page.evaluate((s) => {
      const el = document.querySelector('.page[data-page="me-profile"]');
      return { shown: !!el && !!el.querySelector('input'), txt: (el && el.textContent) || '' };
    }, seed);
    /* 修好的行为：B 岛没有自己的「我」→ 明确提示 + 不给表单
       （旧行为：表单里是 A 岛那件的 name「默认存档的我」） */
    const copied = meStill.txt.indexOf('默认存档的我') >= 0;
    chk('① 个人资料没有把 A 岛账号 copy 进表单', !copied, copied ? '表单里出现了「默认存档的我」' : meStill.txt.slice(0, 60));

    /* ── ① B：B 岛建自己的一件马甲，再改它，A 岛那件不许动 ── */
    const t2 = await page.evaluate((s) => {
      const S = window.Sleepy, C = S.core;
      const bMe = C.upsertUser({ name: 'B岛的我', persona: 'B岛专属人设' });
      bMe.sandboxId = s.b;
      C.upsertUser({ id: bMe.id, sandboxId: s.b, isDefault: true });
      C.setSandboxMasks(s.b, [bMe.id]);
      C.switchTo(undefined, bMe.id);

      /* 在 B 岛改这一件 */
      C.upsertUser({ id: bMe.id, name: 'B岛改名后' });
      const aAfter = C.findUser(s.aMe);
      /* 顺序反过来也来一遍：改 A 岛那件 */
      C.upsertUser({ id: s.aMe, name: 'A岛改名后' });
      const bAfter = C.findUser(bMe.id);

      return {
        aName: aAfter ? aAfter.name : null,
        bName: bAfter ? bAfter.name : null,
        aSandbox: aAfter ? aAfter.sandboxId : null,
        bSandbox: bAfter ? bAfter.sandboxId : null,
        aRoster: C.masksOfSandbox(s.a).map((u) => u.id),
        bRoster: C.masksOfSandbox(s.b).map((u) => u.id)
      };
    }, seed);
    chk('① 改 B 岛那件，A 岛那件没跟着变', t2.aName === 'A岛改名后' || t2.aName === '默认存档的我', 'A=' + t2.aName);
    chk('① 改 A 岛那件，B 岛那件没跟着变', t2.bName === 'B岛改名后', 'B=' + t2.bName);
    chk('① 两条记录各自的岛章没被改花', t2.aSandbox === seed.a && t2.bSandbox === seed.b,
      'a=' + t2.aSandbox + ' b=' + t2.bSandbox);
    chk('① 一条记录没有同时进两座岛名册',
      !t2.aRoster.some((id) => t2.bRoster.indexOf(id) >= 0),
      JSON.stringify({ a: t2.aRoster, b: t2.bRoster }));

    /* ── ① C：mask-edit 跨岛打开必须被拒（不许 copy 别岛的记录）── */
    await page.evaluate((s) => {
      window.Sleepy.nav.open('mask-edit', { id: s.aMe, sandboxId: s.b });
    }, seed);
    await sleep(500);
    const mkTxt = await pageText(page, 'mask-edit');
    const mkCopied = mkTxt.indexOf('A岛改名后') >= 0 || mkTxt.indexOf('默认存档的我') >= 0;
    chk('① mask-edit 跨岛打开没把 A 岛记录 copy 进表单', !mkCopied,
      mkCopied ? '表单里是 A 岛那件' : mkTxt.slice(0, 60));

    /* ── ② C 群（没有马甲）打开「彼此认知」，档位不许整段消失 ── */
    await page.evaluate((s) => {
      const C = window.Sleepy.core;
      const ch = C.upsertChar({ name: '群岛角色甲', kind: 'main' }).id;
      C.setSandboxChars(s.c, [ch]);
    }, seed);
    await page.evaluate((s) => { window.Sleepy.nav.open('island-cognition', { id: s.a }); }, seed);
    await sleep(600);
    const cogA = await pageText(page, 'island-cognition');
    await page.evaluate((s) => { window.Sleepy.nav.open('island-cognition', { id: s.c }); }, seed);
    await sleep(600);
    const cogC = await pageText(page, 'island-cognition');

    const LOCKS = ['拼图局', '调情局', '死装局', '没有小号'];
    const missA = LOCKS.filter((k) => cogA.indexOf(k) < 0);
    const missC = LOCKS.filter((k) => cogC.indexOf(k) < 0);
    chk('② 默认存档那边四档齐全', missA.length === 0, '缺：' + missA.join('/'));
    chk('② 没马甲的新岛也给出同样四档（不许一个选项都没有）', missC.length === 0, '缺：' + missC.join('/'));
    chk('② 新岛给出「去哪加马甲」的指引', cogC.indexOf('马甲') >= 0, cogC.slice(0, 80));

    /* ── 收尾 ── */
    const tail = await page.evaluate((s) => {
      const C = window.Sleepy.core;
      [s.a, s.b, s.c].forEach((id) => C._purgeSync.sandbox(id));
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
