/* ============================================================
   scripts/browser-b1-mask-test.js — B1 马甲生图外貌真机验收
   ------------------------------------------------------------
   复用 browser-collection-test.js 的隔离设施：真系统 Edge（headless、
   一次性 profile）+ 生产源码原文（完整生产 app）。

   验证闭环（B1 实施单 §九）：
     M1 mask-edit 出现「生图外貌」区块（性别/基础/自拍/全身四件）
     M2 填写并保存 → 记录真的存上（findUser 读回四字段）
     M3 重开页面 → 表单回显刚存的值（不是 undefined/空）
     M4 马甲 A / B 各自独立（A 的外貌不出现在 B 的表单里）
     M5 subjectForUser 在真浏览器里按马甲出锁脸段（user+char 合影绑定）
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-b1-mask-test.js
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

const PORT = process.env.B1_TEST_PORT || 5203;
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
/* textarea 的当前值不在 textContent 里 —— 回显断言必须读 .value。
   顺序：人设 → 基础外貌 → 自拍补充 → 全身补充。 */
function maskFields(page) {
  return page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="mask-edit"]');
    if (!pg) return null;
    const tas = pg.querySelectorAll('textarea');
    return {
      base: tas[1] ? tas[1].value : '',
      selfie: tas[2] ? tas[2].value : '',
      full: tas[3] ? tas[3].value : '',
      text: pg.textContent || ''
    };
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let failed = 0;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);
    chk('启动无 [Sleepy] 报错', sleepyErrs.length === 0, sleepyErrs.join(' | '));

    /* 种一座岛 + 两件马甲（直接走生产 API） */
    const seeded = await page.evaluate(() => {
      const S = window.Sleepy;
      const sb = S.core.createSandbox('isle', 'B1测试岛');
      const m = S.core.upsertChar({ name: 'B1角色', kind: 'main', gender: 'female', faceLockText: '银发红瞳' }).id;
      S.core.setSandboxChars(sb.id, [m]);
      const a = S.core.upsertUser({ name: '马甲A', gender: 'female',
        faceLockText: '黑色波波头', faceLockSelfie: '比耶', faceLockFull: '红色球鞋' });
      const b = S.core.upsertUser({ name: '马甲B', gender: 'male', faceLockText: '高个眼镜' });
      S.core.setSandboxMasks(sb.id, [a.id, b.id]);
      S.core.setActiveSandbox(sb.id);
      S.core.switchTo(m, a.id);
      return { sb: sb.id, a: a.id, b: b.id, m };
    });

    /* M4a：马甲 A 表单回显自己的外貌 */
    await page.evaluate((id) => { window.Sleepy.nav.open('mask-edit', { id, sandboxId: window.Sleepy.core.activeSandbox().id }); }, seeded.a);
    await sleep(500);
    let fA = await maskFields(page);
    chk('M4a 马甲A 表单回显基础段', fA.base === '黑色波波头', fA.base);
    chk('M4a 马甲A 表单回显自拍补充', fA.selfie === '比耶', fA.selfie);
    chk('M4a 马甲A 不串马甲B 的词', fA.base.indexOf('高个眼镜') < 0 && fA.selfie.indexOf('smirk') < 0);

    /* M1：区块四件控件都在 */
    const txt = await pageText(page, 'mask-edit');
    chk('M1 生图外貌区块', txt.indexOf('生图外貌') >= 0);
    chk('M1 性别选择', txt.indexOf('性别（生图用）') >= 0);
    chk('M1 基础外貌锁定', txt.indexOf('基础外貌锁定') >= 0);
    chk('M1 自拍与近景补充', txt.indexOf('自拍与近景补充') >= 0);
    chk('M1 全身与合影补充', txt.indexOf('全身与合影补充') >= 0);

    /* M2：真改表单并保存（改基础段 + 选性别），按钮真点 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="mask-edit"]');
      const tas = pg.querySelectorAll('textarea');
      /* textarea 顺序：人设 → 基础 → 自拍 → 全身 */
      tas[1].value = '黑色波波头 · 左眼下泪痣';
      tas[1].dispatchEvent(new Event('input', { bubbles: true }));
      const sel = pg.querySelector('select');
      sel.value = 'female';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const btns = Array.from(pg.querySelectorAll('button'));
      const save = btns.find((b) => b.textContent === '保存');
      save.click();
    });
    await sleep(400);
    const saved = await page.evaluate((id) => {
      const u = window.Sleepy.core.findUser(id);
      return { gender: u.gender, t: u.faceLockText, s: u.faceLockSelfie, f: u.faceLockFull };
    }, seeded.a);
    chk('M2 保存后 gender=female', saved.gender === 'female');
    chk('M2 保存后基础段更新', saved.t === '黑色波波头 · 左眼下泪痣', saved.t);
    chk('M2 保存后自拍补充保留', saved.s === '比耶');
    chk('M2 保存后全身补充保留', saved.f === '红色球鞋');

    /* M3：重开页面回显新值 */
    await page.evaluate((id) => { window.Sleepy.nav.open('mask-edit', { id, sandboxId: window.Sleepy.core.activeSandbox().id }); }, seeded.a);
    await sleep(500);
    fA = await maskFields(page);
    chk('M3 重开回显新基础段', fA.base === '黑色波波头 · 左眼下泪痣', fA.base);
    chk('M3 页面无 undefined', fA.text.indexOf('undefined') < 0);

    /* M4b：马甲 B 表单不串 A 的词，空字段显示为空 */
    await page.evaluate((id) => { window.Sleepy.nav.open('mask-edit', { id, sandboxId: window.Sleepy.core.activeSandbox().id }); }, seeded.b);
    await sleep(500);
    const fB = await maskFields(page);
    chk('M4b 马甲B 回显自己的基础段', fB.base === '高个眼镜', fB.base);
    chk('M4b 马甲B 空补充为空串', fB.selfie === '' && fB.full === '', fB.selfie + '/' + fB.full);
    chk('M4b 马甲B 不串 A 的词', fB.base.indexOf('黑色波波头') < 0 && fB.base.indexOf('左眼下泪痣') < 0);

    /* M5：真浏览器里 subjectForUser + 合影身份段 */
    const plan = await page.evaluate((ids) => {
      const S = window.Sleepy;
      const u = S.core.findUser(ids.a);
      const ch = S.core.findChar(ids.m);
      const subU = S.imggen.subjectForUser(u, 'group');
      const subC = S.imggen.subjectForChar(ch, 'group');
      const built = S.imggen.buildPrompt({ plan: {
        sender: 'user', contentType: 'mixed', shot: 'group',
        subjects: [subU, subC], description: '合影'
      } });
      return { pos: built.positive, scene: built.scene, subU };
    }, seeded);
    chk('M5 合影走人物基底', plan.scene === false);
    chk('M5 user 段带马甲A 外貌', plan.pos.indexOf('马甲A') >= 0 && plan.pos.indexOf('黑色波波头') >= 0);
    chk('M5 char 段独立绑定', plan.pos.indexOf('B1角色') >= 0);
    chk('M5 负面没有排人词', /1girl|1boy/.test(plan.pos) === true);

    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/b1-mask-edit.png') }).catch(() => {});

    failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? '\nB1 mask-edit 真机验收全绿' : '\nB1 真机验收有 ' + failed + ' 项失败');
  } catch (e) {
    console.error('测试异常：', e && e.message);
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
