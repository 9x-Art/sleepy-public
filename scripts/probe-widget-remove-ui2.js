/* ============================================================
   scripts/probe-widget-remove-ui2.js — 组件删除 UI 全链路复现 v2
   ------------------------------------------------------------
   v1 没过授权闸，桌面根本没挂载（.widget 数 0 是这个原因）。
   v2 预置：授权 ok + 一间活动房 → 加组件 → **整页重载**（真机等效）
   → 长按进编辑态 → 点叉叉 → 确认 → 查 DOM 与数据。
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PROBE_PORT || 5205;
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

    await page.addInitScript(() => {
      const SB = { id: 'sb-probe-1', name: '探针房', kind: 'island', charIds: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
      localStorage.setItem('sleepy.v1.sandboxes', JSON.stringify([SB]));
      localStorage.setItem('sleepy.v1.activeSandboxId', JSON.stringify('sb-probe-1'));
      localStorage.setItem('sleepy.v1.legalAgreedAt', JSON.stringify(Date.now()));
      localStorage.setItem('sleepy.v1.license', JSON.stringify({ token: 'probe-token', lastVerifiedAt: Date.now() }));
    });

    await page.goto(BASE + '/index.html');
    await sleep(2000);
    await page.evaluate(() => {
      const sp = document.getElementById('splash');
      if (sp) sp.style.display = 'none';
      const lm = document.querySelector('.legal-mask');
      if (lm) lm.style.display = 'none';
    });
    await sleep(400);

    console.log('[0] 桌面挂载:', await page.evaluate(() => !!document.querySelector('.dt-grid')),
      '.widget 数:', await page.evaluate(() => document.querySelectorAll('.widget').length));

    /* 商城加一件日期时钟方 */
    await page.evaluate(() => {
      Sleepy.widgetStore.addWidget({ type: 'dateclock', app: '', label: '日期时钟方', w: 1, h: 1 });
    });

    /* 整页重载（等效真机重启），让桌面以新数据渲染 */
    await page.reload();
    await sleep(2000);
    await page.evaluate(() => {
      const sp = document.getElementById('splash');
      if (sp) sp.style.display = 'none';
      const lm = document.querySelector('.legal-mask');
      if (lm) lm.style.display = 'none';
    });
    await sleep(400);

    const before = await page.evaluate(() => ({
      grid: !!document.querySelector('.dt-grid'),
      domClocks: Array.from(document.querySelectorAll('.widget')).filter((w) => w.textContent.indexOf('日期') >= 0 || w.querySelector('.ws-mock--dclock')).length,
      dataCount: Sleepy.widgetStore.countOf('dateclock||日期时钟方')
    }));
    console.log('[1] 重载后 DOM/数据:', JSON.stringify(before));

    /* 找到 dateclock 的 widget 节点 */
    const nodeInfo = await page.evaluate(() => {
      const d = Sleepy.desktop.getDesktop();
      let cell = null, pi = -1;
      d.pages.forEach((l, i) => (l || []).forEach((c) => { if (c.type === 'dateclock') { cell = c; pi = i; } }));
      if (!cell) return null;
      const grids = document.querySelectorAll('.dt-grid');
      const grid = grids[pi];
      if (!grid) return { cell: cell, gridFound: false };
      const nodes = Array.from(grid.querySelectorAll('.widget'));
      const node = nodes.find((n) => n.style.gridArea.indexOf(cell.y + ' / ' + cell.x) === 0);
      return { cell: cell, gridFound: true, nodeFound: !!node, hasKill: !!(node && node.querySelector('.dt-kill')) };
    });
    console.log('[2] 桌上组件定位:', JSON.stringify(nodeInfo));

    /* 长按该组件进编辑态 */
    const grids = await page.$$('.dt-grid');
    const targetHandle = await page.evaluateHandle((pi) => {
      const d = Sleepy.desktop.getDesktop();
      let cell = null;
      d.pages.forEach((l, i) => (l || []).forEach((c) => { if (c.type === 'dateclock' && i === pi) cell = c; }));
      const grid = document.querySelectorAll('.dt-grid')[pi];
      return Array.from(grid.querySelectorAll('.widget')).find((n) => n.style.gridArea.indexOf(cell.y + ' / ' + cell.x) === 0);
    }, nodeInfo.cell ? (await page.evaluate(() => {
      const d = Sleepy.desktop.getDesktop();
      let pi = -1;
      d.pages.forEach((l, i) => (l || []).forEach((c) => { if (c.type === 'dateclock') pi = i; }));
      return pi;
    })) : 0);
    const el = targetHandle.asElement();
    if (!el) { console.log('!! 找不到 DOM 节点'); await browser.close(); return; }
    /* 目标可能在别的屏 —— 把桌面横滚条滚过去再量坐标 */
    await page.evaluate((h) => {
      const scroller = document.querySelector('.dt-scroll');
      const grid = h.closest('.dt-grid');
      const grids = Array.from(document.querySelectorAll('.dt-grid'));
      const pi = grids.indexOf(grid);
      scroller.style.scrollBehavior = 'auto';
      scroller.scrollLeft = pi * scroller.clientWidth;
    }, el);
    await sleep(400);
    const bb = await el.boundingBox();
    console.log('[3] 组件位置:', JSON.stringify(bb));
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await sleep(700);
    await page.mouse.up();
    await sleep(700);
    console.log('[3] 编辑态:', await page.evaluate(() => Sleepy.desktop.isEditing()));

    /* 点叉叉（长按可能触发过拖动重挂节点，重新取一次）。
       page.$ 取的是全页第一枚（可能在别的屏），这里精确取目标组件自己的。 */
    await sleep(500);
    const killInfo = await page.evaluate(() => {
      const kills = Array.from(document.querySelectorAll('.dt-kill'));
      const vis = kills.filter((k) => k.offsetParent !== null || k.getClientRects().length);
      return { total: kills.length, visible: vis.length,
        sampleStyle: kills[0] ? getComputedStyle(kills[0]).display : null,
        sectionEditing: !!document.querySelector('.dt-scroll.is-editing, .page.is-editing, [class*="edit"]') };
    });
    console.log('[4] 叉叉统计:', JSON.stringify(killInfo));
    const killed = await page.evaluate(() => {
      const d = Sleepy.desktop.getDesktop();
      let cell = null, pi = -1;
      d.pages.forEach((l, i) => (l || []).forEach((c) => { if (c.type === 'dateclock') { cell = c; pi = i; } }));
      if (!cell) return { cell: false };
      /* 只搜 dateclock 自己那一屏 —— 别的屏可能有相同坐标前缀的格子 */
      const grid = document.querySelectorAll('.dt-grid')[pi];
      for (const n of grid.querySelectorAll('.widget')) {
        if (n.style.gridArea.indexOf(cell.y + ' / ' + cell.x) === 0) {
          const k = n.querySelector('.dt-kill');
          if (!k) return { cell: true, kill: false };
          k.click();
          return { cell: true, kill: true, clicked: true };
        }
      }
      return { cell: true, node: false };
    });
    console.log('[4] 点叉叉:', JSON.stringify(killed));
    await sleep(800);
    const dlg = await page.evaluate(() => {
      const ok = document.querySelector('.dl-btn-ok');
      return { open: !!ok, text: ok ? ok.textContent : null, title: (document.querySelector('.dl-title') || {}).textContent || null };
    });
    console.log('[5] 确认弹窗:', JSON.stringify(dlg));
    if (dlg.open) {
      await page.click('.dl-btn-ok');
      await sleep(1000);
    }
    const after = await page.evaluate(() => ({
      domClocks: Array.from(document.querySelectorAll('.widget')).filter((w) => w.style.gridArea && w.textContent.indexOf('日期') >= 0).length,
      dataCount: Sleepy.widgetStore.countOf('dateclock||日期时钟方'),
      editing: Sleepy.desktop.isEditing(),
      toast: (document.querySelector('.toast') || {}).textContent || null
    }));
    console.log('[6] 确认后 DOM/数据:', JSON.stringify(after));

    console.log('[pageerror]', errors.length ? errors : '无');
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
