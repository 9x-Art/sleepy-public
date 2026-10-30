/* ============================================================
   scripts/probe-widget-remove.js — 组件删除失效复现探针（2026-10-30）
   ------------------------------------------------------------
   用户反馈：组件商城加到桌面的东西删不掉 —— 商城「拿下来」和
   编辑态小叉叉两条路都无效。本探针用真浏览器直接驱动
   Sleepy.widgetStore / Sleepy.desktop 的数据链路，看删除
   到底是「数据没删掉」还是「删了但 UI 没跟上」。

   跑法：NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
         node scripts/probe-widget-remove.js
   依赖：本机 Edge（channel:'msedge'）+ playwright-core，零网络。
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— NODE_PATH=... node scripts/probe-widget-remove.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PROBE_PORT || 5199;
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(BASE + '/index.html');
    await sleep(1500);

    const report = await page.evaluate(async () => {
      const out = {};
      const WS = Sleepy.widgetStore, D = Sleepy.desktop;
      const store = Sleepy.store;

      /* 环境信息 */
      out.hasIslandOverlay = (() => {
        const raw = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('desktop')) || '') || 'null');
        return !!(raw && raw.islands && Object.keys(raw.islands).length);
      })();

      const def = { type: 'dateclock', app: '', label: '日期时钟方', w: 1, h: 1 };
      const key = 'dateclock||日期时钟方';

      /* 1. 加一件 */
      const add = WS.addWidget(def);
      out.addOk = add.ok;
      out.countAfterAdd = WS.countOf(key);

      /* 2. 商城口径删除 */
      const rm = WS.removeWidget({ key: key });
      out.removeWidgetResult = rm;
      out.countAfterRemoveWidget = WS.countOf(key);

      /* 3. 再加一件，直接走 setDesktop 手删（模拟编辑态叉叉的数据面） */
      WS.addWidget(def);
      out.countBeforeManual = WS.countOf(key);
      const d = D.getDesktop();
      let removed = false;
      d.pages.forEach((list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].type === 'dateclock') { list.splice(i, 1); removed = true; }
        }
      });
      out.manualRemoved = removed;
      D.setDesktop(d);
      out.countAfterManual = WS.countOf(key);

      /* 4. 直查底层存档（穿透 getDesktop 的叠加层） */
      const deskKey = Object.keys(localStorage).filter(k => k.indexOf('desktop') >= 0 && k.indexOf('Removed') < 0);
      out.localStorageKeys = deskKey;
      out.rawDesktopHasDateclock = deskKey.some((k) => {
        try { return (localStorage.getItem(k) || '').indexOf('dateclock') >= 0; } catch (e) { return false; }
      });

      /* 5. rememberRemoved 记账是否成功 */
      const rmList = store.get('desktopRemoved') || [];
      out.removedLedgerHasDateclock = rmList.some((r) => r && r.type === 'dateclock');

      return out;
    });

    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
