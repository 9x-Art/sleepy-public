/* ============================================================
   scripts/browser-e1-visual-test.js — E1 视觉层实验 UI 真机验收
   ------------------------------------------------------------
   验证（E1 实施单 §六/§十）：
     V1 settings-imggen「试一张」出现实验区块与免责提示
     V2 三种模式可切换且刷新后保留（localStorage 持久化）
     V3 custom 才显示自定义输入框；legacy/sleepy-default 收起
     V4 自定义词写入 sleepy_img_visual_exp_custom，不污染接口配置
     V5 真浏览器里三种模式拼出的 prompt 符合 §七 层序与负面拆分
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e1-visual-test.js
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

const PORT = process.env.E1_TEST_PORT || 5204;
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

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let failed = 0;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);
    chk('启动无 [Sleepy] 报错', sleepyErrs.length === 0, sleepyErrs.join(' | '));

    await page.evaluate(() => { window.Sleepy.nav.open('settings-imggen-add'); });
    await sleep(500);
    /* 展开「试一张」折叠组 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen-add"]');
      const head = pg && pg.querySelector('.imggen-fold-head');
      if (head) head.click();
    });
    await sleep(300);
    let txt = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen-add"]');
      return pg ? (pg.textContent || '') : '';
    });
    chk('V1 实验区块提示（仅本地实验）', txt.indexOf('仅本地实验，未接入其他生图入口') >= 0);
    chk('V1 视觉拼接模式选择', txt.indexOf('视觉拼接模式') >= 0);

    const uiState = () => page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen-add"]');
      const sel = pg.querySelector('.imggen-fold select');
      const tas = Array.from(pg.querySelectorAll('.imggen-fold textarea'));
      const custom = tas.find((t) => (t.placeholder || '').indexOf('flat graphic') >= 0);
      return { mode: sel ? sel.value : '', customVisible: !!custom && custom.offsetParent !== null };
    });

    /* V3：legacy → 输入框收起 */
    await page.evaluate(() => {
      const sel = document.querySelector('.page[data-page="settings-imggen-add"] .imggen-fold select');
      sel.value = 'legacy';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    let st = await uiState();
    chk('V3 legacy 模式输入框收起', st.mode === 'legacy' && !st.customVisible, JSON.stringify(st));
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e1-mode-legacy.png') }).catch(() => {});

    /* V3：sleepy-default → 输入框收起 */
    await page.evaluate(() => {
      const sel = document.querySelector('.page[data-page="settings-imggen-add"] .imggen-fold select');
      sel.value = 'sleepy-default';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    st = await uiState();
    chk('V3 sleepy-default 输入框收起', st.mode === 'sleepy-default' && !st.customVisible);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e1-mode-sleepy.png') }).catch(() => {});

    /* V3/V4：custom → 输入框出现，写入并持久化 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen-add"]');
      const sel = pg.querySelector('.imggen-fold select');
      sel.value = 'custom';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    await page.evaluate(() => {
      const tas = Array.from(document.querySelector('.page[data-page="settings-imggen-add"]')
        .querySelectorAll('.imggen-fold textarea'));
      const custom = tas.find((t) => (t.placeholder || '').indexOf('flat graphic') >= 0);
      custom.value = 'flat graphic illustration, limited color palette';
      custom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    st = await uiState();
    chk('V3 custom 模式输入框显示', st.mode === 'custom' && st.customVisible);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e1-mode-custom.png') }).catch(() => {});

    /* V2：刷新后保留 */
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await page.evaluate(() => { window.Sleepy.nav.open('settings-imggen-add'); });
    await sleep(500);
    await page.evaluate(() => {
      const head = document.querySelector('.page[data-page="settings-imggen-add"] .imggen-fold-head');
      if (head) head.click();
    });
    await sleep(300);
    st = await uiState();
    chk('V2 刷新后模式保留 custom', st.mode === 'custom');
    const customPersisted = await page.evaluate(() =>
      window.Sleepy.imggen.visualExpCustom());
    chk('V4 自定义词持久化', customPersisted === 'flat graphic illustration, limited color palette', customPersisted);
    const apiClean = await page.evaluate(() => {
      const apis = window.Sleepy.imggen.listApis();
      return apis.every((a) => !('visualExperimentMode' in a) && !('customVisualStyle' in a));
    });
    chk('V9 实验字段未污染接口配置', apiClean);

    /* V5：真浏览器里三种模式 prompt 对照 */
    const prompts = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const api = g.newApi('general');
      const mk = (mode, custom) => g.buildSceneObjectExperimentPrompt({
        api, description: '雨天窗边', contentType: 'scene', subjects: [],
        visualMode: mode, customVisualStyle: custom || '', extras: []
      });
      return { sd: mk('sleepy-default'), cu: mk('custom', g.visualExpCustom()) };
    });
    chk('V5 sleepy-default 层序（质量→无人→描述→视觉）',
      prompts.sd.positive.indexOf('masterpiece') === 0 &&
      prompts.sd.positive.indexOf('empty of people') > 0 &&
      prompts.sd.positive.indexOf('雨天窗边') > prompts.sd.positive.indexOf('empty of people') &&
      prompts.sd.positive.indexOf('natural realistic photography') > prompts.sd.positive.indexOf('雨天窗边'));
    chk('V5 custom 用自定义词不出现 Sleepy 底座',
      prompts.cu.positive.indexOf('flat graphic illustration') >= 0 &&
      prompts.cu.positive.indexOf('natural realistic photography') < 0);
    chk('V5 custom 负面不含审美词',
      prompts.cu.negative.indexOf('oversaturated') < 0 && prompts.cu.negative.indexOf('person') >= 0);

    /* 还原成 legacy，不给用户留实验态 */
    await page.evaluate(() => { window.Sleepy.imggen.setVisualExpMode('legacy'); });

    failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? '\nE1 视觉实验 UI 真机验收全绿' : '\nE1 真机验收有 ' + failed + ' 项失败');
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
