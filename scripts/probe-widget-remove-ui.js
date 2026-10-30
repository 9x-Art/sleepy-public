/* ============================================================
   scripts/probe-widget-remove-ui.js — 组件删除失效真机复现（UI 全链路）
   ------------------------------------------------------------
   数据面探针（probe-widget-remove.js）全绿 —— 删除的存档链路没问题。
   本探针走**真 UI**：商城点「加到桌面」→ 回桌面 → 长按进编辑态 →
   点小叉叉 → 确认弹窗「拿掉」→ 看 DOM 上组件到底消失没有。
   再补一条商城页「在桌上 ×N → 拿下来」的 UI 路径。

   跑法：NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
         node scripts/probe-widget-remove-ui.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— NODE_PATH=... node scripts/probe-widget-remove-ui.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PROBE_PORT || 5201;
const BASE = 'http://127.0.0.1:' + PORT;
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

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  try {
    await waitServer();
    const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/index.html');
    await sleep(1800);

    /* 过掉首启协议弹窗（legal）和开屏动画（splash）—— 不然它们盖在页面上拦截点击 */
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.legal-mask button'));
      const agree = btns.find((b) => b.textContent.indexOf('我已知情') >= 0) || btns[btns.length - 1];
      if (agree) agree.click();
    });
    await sleep(600);
    await page.evaluate(() => {
      const sp = document.getElementById('splash');
      if (sp) { sp.style.display = 'none'; sp.setAttribute('aria-hidden', 'true'); }
      const lm = document.querySelector('.legal-mask');
      if (lm) lm.style.display = 'none';
    });
    await sleep(400);

    /* ---- ① 商城 UI：加一件日期时钟方 ---- */
    await page.evaluate(() => { Sleepy.nav.open('widgetstore'); });
    await sleep(700);
    const cards = await page.$$('.ws-card');
    let target = null, targetText = '';
    for (const c of cards) {
      const t = await c.textContent();
      if (t.indexOf('日期时钟方') >= 0) { target = c; targetText = t.trim().slice(0, 40); break; }
    }
    console.log('[1] 找到橱窗卡:', !!target, JSON.stringify(targetText));
    if (target) {
      const btn = await target.$('.ws-card-btn');
      await btn.click();
      await sleep(500);
      console.log('[1] 点击后按钮文案:', JSON.stringify(await target.$eval('.ws-card-btn', (b) => b.textContent)));
    }

    /* ---- ② 回桌面，数 DOM 上的 dateclock 组件 ---- */
    await page.evaluate(() => { Sleepy.nav.back(); });
    await sleep(900);
    const countDom = () => page.evaluate(() => document.querySelectorAll('.widget').length);
    console.log('[2] 回桌面, .widget 总数:', await countDom());

    /* ---- ③ 长按刚加的那块进编辑态 → 点叉叉 ---- */
    const killed = await page.evaluate(() => {
      const d = Sleepy.desktop.getDesktop();
      let found = null;
      d.pages.forEach((l) => (l || []).forEach((c) => { if (c.type === 'dateclock') found = c; }));
      if (!found) return { found: false };
      const node = document.querySelector('[style*="' + found.y + ' / ' + found.x + '"]');
      return { found: true, gridArea: node ? node.style.gridArea : null, hasKill: !!(node && node.querySelector('.dt-kill')) };
    });
    console.log('[3] 找到桌上组件:', JSON.stringify(killed));

    if (killed.found && killed.hasKill) {
      /* 长按 600ms（EDIT_MS=420）进编辑态 */
      const w = await page.$('.widget');
      const bb = await w.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await sleep(700);
      await page.mouse.up();
      await sleep(600);
      const editing = await page.evaluate(() => Sleepy.desktop.isEditing());
      console.log('[3] 进编辑态:', editing);

      const kill = await page.$('.dt-kill');
      console.log('[3] 叉叉可见:', !!(kill && await kill.boundingBox()));
      if (kill) {
        await kill.click();
        await sleep(600);
        /* 确认弹窗 */
        const dlg = await page.evaluate(() => {
          const ok = document.querySelector('.dl-btn-ok');
          return { open: !!ok, text: ok ? ok.textContent : null };
        });
        console.log('[4] 确认弹窗:', JSON.stringify(dlg));
        if (dlg.open) {
          await page.click('.dl-btn-ok');
          await sleep(800);
        }
        const after = await page.evaluate(() => ({
          domWidgets: document.querySelectorAll('.widget').length,
          editing: Sleepy.desktop.isEditing(),
          deskCount: Sleepy.widgetStore.countOf('dateclock||日期时钟方')
        }));
        console.log('[5] 确认后:', JSON.stringify(after));
      }
    }

    /* ---- ⑥ 商城页「在桌上 ×N」路径 ---- */
    await page.evaluate(() => { Sleepy.nav.open('widgetstore'); });
    await sleep(700);
    const rm = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.ws-card'));
      const c = cards.find((x) => x.textContent.indexOf('日期时钟方') >= 0);
      if (!c) return { card: false };
      const btn = c.querySelector('.ws-card-btn');
      const before = btn.textContent;
      btn.click();
      return { card: true, before: before };
    });
    await sleep(500);
    const after2 = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.ws-card'));
      const c = cards.find((x) => x.textContent.indexOf('日期时钟方') >= 0);
      return { btn: c ? c.querySelector('.ws-card-btn').textContent : null, count: Sleepy.widgetStore.countOf('dateclock||日期时钟方') };
    });
    console.log('[6] 商城移除:', JSON.stringify({ click: rm, after: after2 }));

    console.log('[pageerror]', errors.length ? errors : '无');
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
