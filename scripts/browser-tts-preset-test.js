/* scripts/browser-tts-preset-test.js — TTS 页 + 预设页真机走查（临时验证脚本） */
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
const PORT = 5201;
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitServer() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      http.get(BASE + '/index.html', (r) => { r.resume(); r.statusCode === 200 ? res() : retry(); })
        .on('error', retry);
      function retry() {
        if (Date.now() - t0 > 15000) rej(new Error('起不来'));
        else setTimeout(poll, 250);
      }
    })();
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], { cwd: ROOT, stdio: 'ignore' });
  try {
    await waitServer();
    const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      await page.goto(BASE + '/index.html?splash=0');
      await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.nav, null, { timeout: 20000 });
      await sleep(1200);

      // TTS 主页：不能再出现「还不能直连的服务」，也不能再有「默认模型」下拉
      await page.evaluate(() => window.Sleepy.nav.open('settings-tts'));
      await sleep(800);
      const ttsInfo = await page.evaluate(() => {
        const t = document.body.textContent || '';
        return {
          hasPlannedGroup: t.indexOf('还不能直连') >= 0 || t.indexOf('阿里云') >= 0,
          hasDefaultModel: t.indexOf('默认模型') >= 0,
          hasDirector: t.indexOf('导演引擎') >= 0,
          providers: Array.from(document.querySelectorAll('.set-row, .pp-row')).length
        };
      });
      console.log('TTS主页:', JSON.stringify(ttsInfo));

      // Fish 详情页：应有「模型」下拉且换选即落库
      await page.evaluate(() => window.Sleepy.nav.open('settings-tts-provider', { provider: 'fish_audio' }));
      await sleep(800);
      const fish = await page.evaluate(() => {
        const S = window.Sleepy;
        const t = document.body.textContent || '';
        const sel = Array.from(document.querySelectorAll('select')).find((s) =>
          Array.from(s.options).some((o) => /s2\.1/.test(o.textContent)));
        if (sel) {
          const opts = Array.from(sel.options).map((o) => o.value);
          const pick = opts.find((v) => v && v !== 's2.1-pro-free') || opts[0];
          sel.value = pick;
          sel.dispatchEvent(new Event('change'));
          const conn = (S.tts.firstConnectionOf && null) || null;
          return { hasModelSel: true, opts: opts, picked: pick };
        }
        return { hasModelSel: false, text: t.slice(0, 120) };
      });
      console.log('Fish详情页:', JSON.stringify(fish));
      const connModel = await page.evaluate(() => {
        const c = (window.Sleepy.tts.connections() || [])[0];
        return c ? c.model : '(无连接)';
      });
      console.log('连接上的 model:', connModel);

      // 预设页：非 dev 下内置显示「已上锁」，进卡看不到正文
      await page.evaluate(() => window.Sleepy.nav.open('presets'));
      await sleep(800);
      const presetInfo = await page.evaluate(() => {
        const t = document.body.textContent || '';
        const pg = document.querySelector('.page[data-page="presets"]');
        return {
          locks: (t.match(/已上锁/g) || []).length,
          devFoot: t.indexOf('内置注入已上锁') >= 0,
          // 2026-10-07 用户：条目下面的解释（pp-row-hint）全去掉，应为 0
          rowHints: pg ? pg.querySelectorAll('.pp-row-hint').length : -1
        };
      });
      console.log('预设列表:', JSON.stringify(presetInfo));
      await page.evaluate(() => window.Sleepy.nav.open('preset-card', { id: 'shell' }));
      await sleep(800);
      const cardInfo = await page.evaluate(() => {
        const t = document.body.textContent || '';
        const ta = document.querySelector('textarea');
        return {
          lockedNote: t.indexOf('内容不可见') >= 0,
          hasTextarea: !!ta,
          bodyLeak: ta ? ta.value.indexOf('[身份与场景]') >= 0 : false
        };
      });
      console.log('shell 卡(非dev):', JSON.stringify(cardInfo));

      console.log('页面错误:', errors.length ? errors : '(无)');
    } finally { await browser.close(); }
  } finally { server.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
