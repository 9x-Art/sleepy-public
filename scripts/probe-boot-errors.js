/* ============================================================
   scripts/probe-boot-errors.js — 启动链路报错探针（2026-10-30）
   ------------------------------------------------------------
   真机视口（390×844）+ Edge headless，冷启动 index.html：
   A. 首次加载：捕获 pageerror / console.error / 报错卡
   B. reload 二次加载：同样捕获
   用途：线上「Script error.」类反馈的本地复现（本地不注册 SW，
   测的是纯静态加载链路；SW 缓存混料要在真机上关窗重开验）。
   跑法：node scripts/probe-boot-errors.js（自带 serve，端口 PROBE_PORT）
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

const PORT = process.env.PROBE_PORT || 5237;
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

const SEED = () => {
  localStorage.setItem('sleepy.v1.legalAgreedAt', JSON.stringify(Date.now()));
  localStorage.setItem('sleepy.v1.license', JSON.stringify({ token: 'probe-token', lastVerifiedAt: Date.now() }));
};

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (detail ? '  \u2192 ' + String(detail).slice(0, 200) : ''));
}

async function loadRound(page, label) {
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(e.message + ' | ' + (e.stack || '').split('\n')[1] || ''));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await sleep(2500);
  /* 开屏/协议弹层掀掉（本地无授权闸时 splash 会挡住桌面） */
  await page.evaluate(() => {
    const sp = document.getElementById('splash');
    if (sp) sp.style.display = 'none';
    const lm = document.querySelector('.legal-mask');
    if (lm) lm.style.display = 'none';
  });
  await sleep(600);

  const state = await page.evaluate(() => ({
    phone: !!document.getElementById('phone'),
    pages: document.querySelectorAll('#phone .page').length,
    errCard: !!document.querySelector('.err-card, [class*="err"]'),
  }));

  console.log('[' + label + ']');
  check('JS 零未捕获异常', errors.length === 0, errors.join(' // '));
  check('console 零 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' // '));
  check('App 壳挂载（#phone 有页面）', state.phone && state.pages > 0, 'pages=' + state.pages);
  return { errors, consoleErrors };
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await page.addInitScript(SEED);

    await loadRound(page, 'A. 首次冷启动');
    await loadRound(page, 'B. reload 二次加载');

    console.log(failures === 0 ? '\n全部通过 ✓' : '\n有 ' + failures + ' 项不过 ✗');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
