/* ============================================================
   scripts/probe-widget-remove-island.js — 岛覆盖层下的组件删除复现
   ------------------------------------------------------------
   无岛探针（probe-widget-remove.js）全绿，但真实用户有「岛覆盖」
   （desktop.islands[sbId]，岛覆盖 > 全局）。本探针在**有岛覆盖**的
   存档形态下重跑同一组删除链路，看读写层是否错位。

   跑法：NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
         node scripts/probe-widget-remove-island.js
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

const PORT = process.env.PROBE_PORT || 5203;
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
    /* 预置存档：一间房 + 活动岛 + 这座岛的桌面覆盖层（在脚本加载前写进 localStorage） */
    await page.addInitScript(() => {
      const SB = { id: 'sb-probe-1', name: '探针房', kind: 'island', charIds: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
      localStorage.setItem('sleepy.v1.sandboxes', JSON.stringify([SB]));
      localStorage.setItem('sleepy.v1.activeSandboxId', JSON.stringify('sb-probe-1'));
      localStorage.setItem('sleepy.v1.legalAgreedAt', JSON.stringify(Date.now()));
    });

    await page.goto(BASE + '/index.html');
    await sleep(1800);
    await page.evaluate(() => {
      const sp = document.getElementById('splash');
      if (sp) sp.style.display = 'none';
      const lm = document.querySelector('.legal-mask');
      if (lm) lm.style.display = 'none';
    });
    await sleep(600);

    const report = await page.evaluate(() => {
      const out = {};
      const WS = Sleepy.widgetStore, D = Sleepy.desktop, core = Sleepy.core, store = Sleepy.store;

      out.activeIsland = (core.activeSandbox() || {}).id || null;
      if (out.activeIsland) {
        /* 给这座岛造一份覆盖层（用户在自己岛上摆过桌面的形态）。
           授权闸没过时 bootHome 不跑，desktop 存档可能还没落 —— 先触一次。 */
        if (!store.get('desktop')) D.getDesktop();
        const base = store.get('desktop');
        base.islands = base.islands || {};
        base.islands[out.activeIsland] = JSON.parse(JSON.stringify(base));
        store.set('desktop', base);

        /* 关键：getDesktop 现在应该返回覆盖层 */
        const d1 = D.getDesktop();
        out.readsOverlay = d1 !== base && !!d1.islands; /* 覆盖层上不该有 islands 字段，粗判 */

        const def = { type: 'dateclock', app: '', label: '日期时钟方', w: 1, h: 1 };
        const key = 'dateclock||日期时钟方';

        /* 商城加 + 删 */
        out.addOk = WS.addWidget(def).ok;
        out.countAfterAdd = WS.countOf(key);
        out.rm = WS.removeWidget({ key: key });
        out.countAfterRemove = WS.countOf(key);

        /* 穿透看两层存档 */
        const raw = (() => {
          const k = Object.keys(localStorage).find((x) => x.indexOf('desktop') >= 0 && x.indexOf('Removed') < 0);
          return JSON.parse(localStorage.getItem(k) || 'null');
        })();
        const cellIn = (d) => (d.pages || []).some((l) => (l || []).some((c) => c.type === 'dateclock'));
        out.globalHasCell = cellIn(raw);
        out.overlayHasCell = !!(raw.islands && raw.islands[out.activeIsland] && cellIn(raw.islands[out.activeIsland]));

        /* 编辑态叉叉数据面：再加一件 → getDesktop 手删 → setDesktop */
        WS.addWidget(def);
        const d2 = D.getDesktop();
        d2.pages.forEach((l) => { for (let i = l.length - 1; i >= 0; i--) if (l[i].type === 'dateclock') l.splice(i, 1); });
        D.setDesktop(d2);
        const raw2 = (() => {
          const k = Object.keys(localStorage).find((x) => x.indexOf('desktop') >= 0 && x.indexOf('Removed') < 0);
          return JSON.parse(localStorage.getItem(k) || 'null');
        })();
        out.afterManualEdit = {
          globalHasCell: cellIn(raw2),
          overlayHasCell: !!(raw2.islands && raw2.islands[out.activeIsland] && cellIn(raw2.islands[out.activeIsland])),
          visibleCount: WS.countOf(key)
        };
      }
      return out;
    });

    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
