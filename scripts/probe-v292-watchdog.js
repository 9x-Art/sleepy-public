/* ============================================================
   scripts/probe-v292-watchdog.js — v292 流式看门狗实机验证
   ------------------------------------------------------------
   起一个「坏网关」假 SSE 服务，两种病灶各打一枪：
     A. 吐完全部内容 + finish_reason 帧，但**不发 [DONE] 也不关流**，
        还用注释帧保活 —— 修复前 reader.read() 永不 resolve，
        回复停在 pending 气泡里刷新即蒸发。
     B. 吐了几个字之后**彻底沉默**（不关流不保活）——
        看门狗 15s 后应按「有内容=完成」落库。
   断言：两个 case 都必须 onDone 拿到全文、onError 不触发；
   全程收集 pageerror / console error（顺便回答「目前有 js 报错」）。
   模式识别按请求体里最后一条 user 消息文案（streamOnce 不透传自定义头）。
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/probe-v292-watchdog.js
   ============================================================ */
'use strict';
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— 用 managed node workspace 跑');
  process.exit(2);
}

const PORT = process.env.PROBE_PORT || 5222;
const BASE = 'http://127.0.0.1:' + PORT;
const MOCK_PORT = PORT + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 坏网关 ---------- */
const server = http.createServer((req, res) => {
  /* 页面跨源调用，CORS 必须给（含预检） */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let lastUser = '';
    try {
      const j = JSON.parse(body);
      const msgs = (j.messages || []).filter((m) => m.role === 'user');
      lastUser = msgs.length ? String(msgs[msgs.length - 1].content) : '';
    } catch (e) { /* 忽略 */ }
    const mode = lastUser.indexOf('再来') >= 0 ? 'B' : 'A';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    if (mode === 'A') {
      // 内容吐完 + finish_reason，然后注释帧保活，永不关流不发 [DONE]
      send({ choices: [{ delta: { content: 'TA回的第一句||' } }] });
      setTimeout(() => { send({ choices: [{ delta: { content: 'TA回的第二句' } }] }); }, 200);
      setTimeout(() => { send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); }, 400);
      const ka = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(ka); }
      }, 1000);
      req.on('close', () => clearInterval(ka));
    } else {
      // 模式 B：吐两个字后彻底沉默，连接挂着
      send({ choices: [{ delta: { content: '只吐了俩字' } }] });
    }
  });
});

function waitServer(url, what) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      http.get(url, (r) => { r.resume(); r.statusCode === 200 ? res() : retry(); })
        .on('error', retry);
      function retry() {
        if (Date.now() - t0 > 15000) rej(new Error(what + '起不来'));
        else setTimeout(poll, 250);
      }
    })();
  });
}

const step = (m) => console.log('[step] ' + m);
setTimeout(() => { console.error('[watchdog] 探针 3 分钟没跑完，强杀'); process.exit(3); }, 180000).unref();

async function main() {
  step('起坏网关 :' + MOCK_PORT);
  await new Promise((r) => server.listen(MOCK_PORT, r));
  /* 外部已起站点时（PROBE_BASE 指过去）就不自己 spawn serve.js */
  const extBase = process.env.PROBE_BASE;
  const site = extBase ? null : spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'inherit'
  });
  if (!extBase) {
    try { await waitServer(BASE + '/store.js', '测试站点'); } catch (e) { site.kill(); throw e; }
  }
  const base = extBase || BASE;

  step('起浏览器');
  const browser = await pw.chromium.launchPersistentContext(
    path.join(ROOT, '_tmp-probe-watchdog'),
    { channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') jsErrors.push('console.error: ' + m.text());
  });

  await page.addInitScript(() => {
    const t = setInterval(() => {
      if (window.Sleepy && window.Sleepy.licenseGate) {
        window.Sleepy.licenseGate.state = function () { return 'ok'; };
        clearInterval(t);
      }
    }, 5);
  });

  step('打开页面 ' + base);
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  step('等 Sleepy.api');
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.api, null, { timeout: 20000 });
  step('app 加载完成');
  await sleep(1500);

  step('配 mainApi → 坏网关');
  await page.evaluate((url) => {
    window.Sleepy.store.set('mainApi', {
      enabled: true, name: '坏网关', baseUrl: url, model: 'mock-1', apiKey: 'mock-key'
    });
    window.Sleepy.store.set('subApis', []);
  }, 'http://127.0.0.1:' + MOCK_PORT + '/v1');

  step('Case A 发射');
  const a = await page.evaluate(() => new Promise((done) => {
    let text = '';
    const t0 = Date.now();
    window.Sleepy.api.runChat(
      [{ role: 'user', content: '你好' }],
      {
        onDelta: (d) => { text += d; },
        onDone: (cand, full) => done({ ok: true, text: full, ms: Date.now() - t0, err: null }),
        onError: (e) => done({ ok: false, text: text, ms: Date.now() - t0, err: e && (e.error || e.message || JSON.stringify(e)) }),
        onFail: (list, e) => done({ ok: false, text: text, ms: Date.now() - t0, err: '候选链全败: ' + (e && (e.error || e.message || JSON.stringify(e))) })
      },
      true);
  }));

  step('Case A 回来了');
  // Case B（streamOnce 直呼）：内容后彻底沉默 → 看门狗 15s 落库
  step('Case B 发射');
  const b = await page.evaluate(() => new Promise((done) => {
    let text = '';
    const t0 = Date.now();
    window.Sleepy.api.streamOnce(
      { source: 'main', label: '坏网关', cfg: window.Sleepy.store.get('mainApi') },
      [{ role: 'user', content: '再来' }],
      {
        onDelta: (d) => { text += d; },
        onDone: (full) => done({ ok: true, text: full, ms: Date.now() - t0, err: null }),
        onError: (e) => done({ ok: false, text: text, ms: Date.now() - t0, err: e && (e.error || e.message || JSON.stringify(e)) })
      },
      {});
  }));
  step('Case B 回来了');

  console.log('--- Case A（吐完内容+finish_reason，不发 [DONE] 不关流）---');
  console.log('  ok=' + a.ok + '  耗时=' + a.ms + 'ms');
  console.log('  全文=' + JSON.stringify(a.text));
  console.log('  错误=' + JSON.stringify(a.err));
  console.log('--- Case B（内容后彻底沉默 → 看门狗 15s）---');
  console.log('  ok=' + b.ok + '  耗时=' + b.ms + 'ms');
  console.log('  全文=' + JSON.stringify(b.text));
  console.log('  错误=' + JSON.stringify(b.err));

  const pass = a.ok && a.text.indexOf('TA回的第一句') >= 0 && a.text.indexOf('TA回的第二句') >= 0
    && b.ok && b.text === '只吐了俩字' && b.ms >= 12000;

  console.log('--- 全程 JS 报错收集 ---');
  if (jsErrors.length === 0) console.log('  （无）');
  else jsErrors.slice(0, 20).forEach((e) => console.log('  ' + e));

  console.log(pass ? '\n★ 看门狗验证通过：两个病灶都被兜住' : '\n× 验证未过，见上');

  await browser.close();
  if (site) site.kill();
  server.close();
  process.exit(pass && jsErrors.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('探针炸了：' + (e.stack || e)); process.exit(1); });
