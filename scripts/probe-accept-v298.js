/* ============================================================
   scripts/probe-accept-v298.js — v295~v298 真机验收探针
   ------------------------------------------------------------
   真机视口（390×844 + touch）+ Edge headless，过四条 UI 全链路：
   A. v296 组件商城小样：帷境卡是幕布新样，不是白圆角块
   B. v297 户型升级保自装：v24 旧档 + 自装组件 → 重载不蒸发
   C. v297 自制组件删→装回：tplId 全程跟走，DOM 不出「模板不见了」
   D. v298 存量自愈：老档嵌套 islands / 跨岛共享 w-id 读档即修
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

const PORT = process.env.PROBE_PORT || 5231;
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
  const SB = { id: 'sb-acc-1', name: '验收房', kind: 'island', charIds: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
  localStorage.setItem('sleepy.v1.sandboxes', JSON.stringify([SB]));
  localStorage.setItem('sleepy.v1.activeSandboxId', JSON.stringify('sb-acc-1'));
  localStorage.setItem('sleepy.v1.legalAgreedAt', JSON.stringify(Date.now()));
  localStorage.setItem('sleepy.v1.license', JSON.stringify({ token: 'probe-token', lastVerifiedAt: Date.now() }));
};

const HIDE_MASKS = () => {
  const sp = document.getElementById('splash');
  if (sp) sp.style.display = 'none';
  const lm = document.querySelector('.legal-mask');
  if (lm) lm.style.display = 'none';
};

async function reloadAndUnmask(page) {
  await page.reload();
  await sleep(2000);
  await page.evaluate(HIDE_MASKS);
  await sleep(400);
}

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  → ' + detail : ''));
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
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.addInitScript(SEED);
    await page.goto(BASE + '/index.html');
    await sleep(2000);
    await page.evaluate(HIDE_MASKS);
    await sleep(400);

    /* ---------- A. v296 商城小样 ---------- */
    console.log('[A] v296 商城小样');
    await page.evaluate(() => Sleepy.nav.open('widgetstore'));
    await sleep(800);
    const a = await page.evaluate(() => {
      const cards = document.querySelectorAll('.ws-card');
      let wjCard = null;
      document.querySelectorAll('.ws-card').forEach((c) => {
        if (c.querySelector('.ws-mock--wj')) wjCard = c;
      });
      const mock = wjCard ? wjCard.querySelector('.ws-mock--wj') : null;
      return {
        cardCount: cards.length,
        hasWj: !!wjCard,
        curtains: wjCard ? wjCard.querySelectorAll('.ws-mock--wj-curtain').length : 0,
        hasCopy: wjCard ? !!wjCard.querySelector('.ws-mock--wj-copy') : false,
        wjText: wjCard ? (wjCard.querySelector('.ws-mock--wj-copy') || {}).textContent || '' : '',
        mockHTML: mock ? mock.outerHTML : null
      };
    });
    check('商城卡渲染出来', a.cardCount > 0, a.cardCount + ' 张卡');
    check('帷境卡在架上', a.hasWj);
    check('帷境小样是幕布新样（两片幕布 + 小字）', a.curtains === 2 && a.hasCopy, JSON.stringify(a));
    await page.evaluate(() => Sleepy.nav.closeAll ? Sleepy.nav.closeAll() : null);
    await sleep(400);

    /* ---------- B. v297 迁移保自装 ---------- */
    console.log('[B] v297 户型升级保自装');
    await page.evaluate(() => {
      const d = Sleepy.desktop.defaultDesktop();
      d.version = Sleepy.desktop.LAYOUT_VERSION - 1;
      d.pages[2].push({ i: 'wAccB1', type: 'custom', tplId: 'tplAccB',
        label: '验收模板B', x: 1, y: 6, w: 1, h: 1 });
      Sleepy.store.set('customWidgets', [{ id: 'tplAccB', name: '验收模板B',
        html: '<div class="accb">迁移保自装OK</div>', css: '', w: 1, h: 1, sandboxId: 'sb-acc-1' }]);
      Sleepy.store.set('desktop', d);
      Sleepy.store.set('desktopRemoved', []);
    });
    await reloadAndUnmask(page);
    const b = await page.evaluate(() => {
      let cell = null;
      Sleepy.desktop.getDesktop().pages.forEach((l) => (l || []).forEach((c) => {
        if (c.i === 'wAccB1') cell = c;
      }));
      const body = document.querySelector('.w-custom-body');
      return {
        cellAlive: !!cell, tplId: cell ? cell.tplId : null,
        domText: body ? body.textContent : null,
        emptyShown: !!document.querySelector('.w-custom-empty')
      };
    });
    check('自装组件熬过户型升级', b.cellAlive, b.cellAlive ? 'id 保留' : '蒸发了');
    check('tplId 跟走', b.tplId === 'tplAccB');
    check('DOM 渲染的是模板本体（不是「模板不见了」）',
      b.domText && b.domText.indexOf('迁移保自装OK') >= 0 && !b.emptyShown, JSON.stringify(b));

    /* ---------- C. v297 自制组件删→装回 ---------- */
    console.log('[C] v297 自制组件删→装回');
    const c1 = await page.evaluate(() => {
      /* 清掉 B 场景的桌面与模板，别让上一幕的孤儿格混进断言 */
      Sleepy.store.set('desktop', null);
      Sleepy.store.set('customWidgets', []);
      Sleepy.store.set('desktopRemoved', []);
      const add = Sleepy.widgetStore.addWidget({ type: 'custom', app: '',
        label: '验收模板C', w: 1, h: 1, tplId: 'tplAccC' });
      if (!add.ok) return { addFail: add.message };
      const rm = Sleepy.widgetStore.removeWidget({ key: 'custom||验收模板C',
        type: 'custom', app: '', label: '验收模板C' });
      if (!rm.ok) return { rmFail: rm.message };
      const recs = Sleepy.store.get('desktopRemoved') || [];
      const rec = recs[recs.length - 1];
      return { ok: true, recTplId: rec ? rec.tplId : null };
    });
    check('删除记账带 tplId', c1.ok && c1.recTplId === 'tplAccC', JSON.stringify(c1));
    const c2 = await page.evaluate(() => {
      Sleepy.store.set('customWidgets', [{ id: 'tplAccC', name: '验收模板C',
        html: '<div class="accc">删了又装回OK</div>', css: '', w: 1, h: 1, sandboxId: 'sb-acc-1' }]);
      const recs = Sleepy.store.get('desktopRemoved') || [];
      const back = Sleepy.widgetStore.restoreWidget(recs[recs.length - 1]);
      return { ok: back.ok, cellTplId: back.cell ? back.cell.tplId : null };
    });
    check('装回的格子接住 tplId', c2.ok && c2.cellTplId === 'tplAccC', JSON.stringify(c2));
    await reloadAndUnmask(page);
    const c3 = await page.evaluate(() => {
      const body = document.querySelector('.w-custom-body');
      return {
        domText: body ? body.textContent : null,
        emptyShown: !!document.querySelector('.w-custom-empty')
      };
    });
    check('重载后渲染模板本体', c3.domText && c3.domText.indexOf('删了又装回OK') >= 0 && !c3.emptyShown,
      JSON.stringify(c3));

    /* ---------- D. v298 存量自愈 ---------- */
    console.log('[D] v298 存量自愈');
    await page.evaluate(() => {
      Sleepy.store.set('desktop', null);
      Sleepy.store.set('widgetCfg', {});
      Sleepy.store.set('desktopRemoved', []);
      Sleepy.store.set('customWidgets', []);
      const base = Sleepy.desktop.getDesktop();
      base.pages[2].push({ i: 'wSharedCd', type: 'countdown',
        label: '倒数日方', x: 1, y: 6, w: 2, h: 1 });
      const sid = Sleepy.core.scopeId();
      const ov = JSON.parse(JSON.stringify(base));
      ov.islands = { sbLegacyJunk: { version: 1, pages: [[], [], [], []] } };
      base.islands = base.islands || {};
      base.islands[sid] = ov;
      Sleepy.store.set('desktop', base);
      Sleepy.store.set('widgetCfg', { wSharedCd: { target: '2027-02-02', label: '存量' } });
    });
    await reloadAndUnmask(page);
    const d = await page.evaluate(() => {
      const base = Sleepy.store.get('desktop');
      const sid = Sleepy.core.scopeId();
      const ov = base.islands && base.islands[sid];
      let novId = null;
      (ov ? ov.pages : []).forEach((l) => (l || []).forEach((c) => {
        if (c.type === 'countdown') novId = c.i;
      }));
      const num = document.querySelector('.w-countdown-num');
      const label = document.querySelector('.w-countdown-label');
      return {
        overlayAlive: !!ov,
        nestedGone: ov ? !ov.islands : null,
        novId: novId, idChanged: novId && novId !== 'wSharedCd',
        cfgMigrated: novId ? !!((Sleepy.store.get('widgetCfg') || {})[novId]) : false,
        globalCfgAlive: !!((Sleepy.store.get('widgetCfg') || {}).wSharedCd),
        domNum: num ? num.textContent : null,
        domLabel: label ? label.textContent : null
      };
    });
    check('存量覆盖层读出来', d.overlayAlive);
    check('嵌套 islands 被剥掉', d.nestedGone === true);
    check('共享 w-id 重发（配置不再跨岛共享）', d.idChanged === true, '新id=' + d.novId);
    check('widgetCfg 条目迁到新 id', d.cfgMigrated === true);
    check('全局那份配置原地健在', d.globalCfgAlive === true);
    check('倒计时 DOM 正常渲染（大数字 + 标签）',
      d.domNum && /^\d+$/.test(d.domNum) && d.domLabel === '存量', JSON.stringify({ num: d.domNum, label: d.domLabel }));

    console.log('[pageerror]', errors.length ? errors : '无');
    if (errors.length) failures++;

    console.log(failures === 0 ? '\n真机验收全过 ✅' : '\n真机验收有 ' + failures + ' 项没过 ❌');
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error(e);
    if (browser) await browser.close();
    process.exit(1);
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
