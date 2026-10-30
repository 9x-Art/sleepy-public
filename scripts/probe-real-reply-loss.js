/* ============================================================
   scripts/probe-real-reply-loss.js — 真实发消息→真实流式回复→刷新
   ------------------------------------------------------------
   用户实锤「全部关掉单会话：回复可见，再刷新就没了」。桌面 store/
   chatStore/UI 探针都不复现 → 怀疑在真实回复落库路径（streaming
   onDone / memoryId / commitMemory 链）。本探针用真 API 走完整链：
     配主 API（探针注入）→ 建岛/角色/对话 → 真实 UI 输入 + 点发送
     → 等流式回复落库 → 记 store/DOM → reload → 再看。
   跑法（需真网络到网关）：
     NODE_PATH=...node_modules node scripts/probe-real-reply-loss.js
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
const API_BASE = process.env.PROBE_API || 'https://www.xinxiwang.org/v1';
const API_KEY = process.env.PROBE_KEY || 'sk-QaDfTTT3R7OuZr0RV3ex2RwTc3pdFHiFeOW4VQqdqFrhhZ6n';
const MODEL = process.env.PROBE_MODEL || '[vertex]gemini-3.5-flash-lite';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitServer() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      http.get(BASE + '/store.js', (r) => { r.resume(); r.statusCode === 200 ? res() : retry(); })
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
  await waitServer();
  const browser = await pw.chromium.launchPersistentContext(
    path.join(ROOT, '_tmp-probe-profile-real'), { channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.indexOf('[probe]') === 0 || t.indexOf('[api-debug]') === 0) console.log('  ' + t); });
  page.on('pageerror', (e) => console.log('  [probe] pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.url().indexOf('chat/completions') >= 0 || r.url().indexOf('xinxiwang') >= 0) {
      console.log('  [probe] LLM ' + r.status() + ' ' + r.url().slice(0, 70));
    }
  });
  // 页面 toast 全收（发送失败/等回复提示都从这里看）
  await page.addInitScript(() => {
    const t = setInterval(() => {
      if (window.Sleepy && window.Sleepy.toast) {
        const orig = window.Sleepy.toast;
        window.Sleepy.toast = function (msg, kind) {
          console.log('[probe] toast(' + (kind || '') + '): ' + String(msg).slice(0, 80));
          return orig.apply(this, arguments);
        };
        clearInterval(t);
      }
    }, 5);
  });
  await page.addInitScript(() => {
    const t = setInterval(() => {
      if (window.Sleepy && window.Sleepy.licenseGate) {
        window.Sleepy.licenseGate.state = function () { return 'ok'; };
        clearInterval(t);
      }
    }, 5);
    // 首启协议标记前置落好（对象形态 { ver, at }，见 legal.js），弹窗就不会出来拦点击
    localStorage.setItem('sleepy.v1.legalAgreedAt',
      JSON.stringify({ ver: 'v1', at: Date.now() }));
    // onDone 链里若有人同步抛错，多半被吞成 unhandled rejection —— 抓出来
    window.addEventListener('unhandledrejection', function (e) {
      const r = e.reason;
      console.log('[probe] UNHANDLED: ' + ((r && r.stack) || r));
    });
    window.addEventListener('error', function (e) {
      console.log('[probe] WINDOWERR: ' + (e.message || e));
    });
    // runChat 间谍：onDelta/onDone/onFail 各走没走、页面 onDone 是否抛错
    // + fetch 分块时序（finish_reason 帧到底有没有到页面、什么时候到的）
    const t2 = setInterval(() => {
      if (window.Sleepy && window.Sleepy.api && window.Sleepy.api.runChat && !window.__spy) {
        console.log('[probe] api标记='+(window.Sleepy.api.__v||'无(旧文件!)')); window.__spy = 1;
        const orig = window.Sleepy.api.runChat;
        window.Sleepy.api.runChat = function (msgs, handlers, useStream, ov) {
          const h = handlers || {};
          let deltas = 0;
          const wrap = Object.assign({}, h, {
            onDelta: function (d, m) {
              deltas++;
              if (deltas === 1) console.log('[probe] spy: first delta');
              try {
                return h.onDelta && h.onDelta(d, m);
              } catch (err) {
                console.log('[probe] spy: 页面 onDelta 抛错!! ' + ((err && err.stack) || err));
                throw err;
              }
            },
            onDone: function (cand, text, extra) {
              console.log('[probe] spy: onDone len=' + String(text || '').length);
              try {
                const r = h.onDone && h.onDone(cand, text, extra);
                console.log('[probe] spy: 页面 onDone 走完未抛错');
                return r;
              } catch (err) {
                console.log('[probe] spy: 页面 onDone 抛错!! ' + ((err && err.stack) || err));
              }
            },
            onFail: function (c, e) {
              console.log('[probe] spy: onFail ' + JSON.stringify(e || {}).slice(0, 140));
              return h.onFail && h.onFail(c, e);
            }
          });
          return orig.call(this, msgs, wrap, useStream, ov);
        };
        clearInterval(t2);
      }
    }, 5);
    const t3 = setInterval(() => {
      if (!window.fetch || window.__fetchSpy) { if (window.__fetchSpy) clearInterval(t3); return; }
      window.__fetchSpy = 1;
      const of = window.fetch;
      window.fetch = function () {
        const u = String(arguments[0] || '');
        const isLLM = u.indexOf('chat/completions') >= 0;
        const p = of.apply(this, arguments);
        if (isLLM) {
          console.log('[probe] fetch LLM 发出');
          p.then(function (r) {
            console.log('[probe] fetch LLM 响应头 status=' + r.status);
            const cloned = r.clone();
            let n = 0, sawFR = false, sawDone = false, t0 = Date.now();
            (function read() {
              cloned.body.getReader().read().then(function (x) {
                if (x.done) { console.log('[probe] 分块流关闭，共 ' + n + ' 块, fr=' + sawFR + ' [DONE]=' + sawDone + ' 用时 ' + (Date.now() - t0) + 'ms'); return; }
                n++;
                const s = new TextDecoder().decode(x.value);
                if (s.indexOf('finish_reason') >= 0) { sawFR = true; console.log('[probe] 分块#' + n + ' 含 finish_reason，t=' + (Date.now() - t0) + 'ms'); }
                if (s.indexOf('[DONE]') >= 0) { sawDone = true; console.log('[probe] 分块#' + n + ' 含 [DONE]，t=' + (Date.now() - t0) + 'ms'); }
                read();
              })['catch'](function (e) { console.log('[probe] 读流出错: ' + e); });
            })();
          })['catch'](function (e) { console.log('[probe] fetch LLM 失败: ' + e); });
        }
        return p;
      };
      clearInterval(t3);
    }, 5);
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(2000);

  // 首启协议弹窗：直接点「我已知情，不再提示」（真路径落 legalAgreedAt）
  try {
    await page.click('.dl-btn-ok', { timeout: 4000 });
    await sleep(400);
  } catch (e) { /* 没弹就继续 */ }

  // 配主 API + 建岛/角色/对话
  const chatId = await page.evaluate((cfg) => {
    const S = window.Sleepy, core = S.core, store = S.store;
    store.set('mainApi', {
      enabled: true, name: '探针主API', baseUrl: cfg.apiBase,
      apiKey: cfg.apiKey, model: cfg.model
    });
    const sbId = 'probeR_sb';
    store.set('sandboxes', (store.get('sandboxes') || []).filter(s => s.id !== sbId).concat([{
      id: sbId, kind: 'isle', name: '真回复岛', charIds: ['probeR_ch'], maskIds: ['probeR_um']
    }]));
    core.upsertChar({
      id: 'probeR_ch', kind: 'main', name: '真回复酱', sandboxId: sbId,
      parentId: sbId, parentType: 'sandbox',
      content: '你是「真回复酱」，一个测试用角色。每次回复只说一句不超过15字的口语短句。'
    });
    core.upsertUser({ id: 'probeR_um', name: '我', sandboxId: sbId });
    store.set('activeSandboxId', sbId);
    return S.chatStore.createChat('probeR_ch', '真回复对话').id;
  }, { apiBase: API_BASE, apiKey: API_KEY, model: MODEL });
  console.log('[probe] chatId=' + chatId);

  // 打开聊天页，真实 UI 输入 + 点发送
  await page.evaluate((id) => { window.Sleepy.nav.open('chat-detail', { chatId: id }); }, chatId);
  await sleep(1000);
  await page.fill('.chat-input', '你好呀，测试一下');
  await page.click('.send-btn');
  await sleep(400);
  // 两义发送键：有字只发消息不触发回复 —— 再空点一次让 TA 开口
  await page.click('.send-btn');
  // 等流式回复落库（最多 90s）
  let replied = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    replied = await page.evaluate((id) => {
      const c = window.Sleepy.chatStore.getChat(id);
      const msgs = (c && c.messages) || [];
      return msgs.some(m => m.role === 'assistant' && m.content);
    }, chatId);
    if (replied) break;
  }
  const before = await page.evaluate((id) => {
    const c = window.Sleepy.chatStore.getChat(id);
    const ls = JSON.parse(localStorage.getItem('sleepy.v1.chats') || '[]').filter(x => x.id === id)[0];
    const pend = document.querySelector('.msg-bubble.is-pending');
    return {
      store: (c.messages || []).map(m => m.role),
      disk: ls ? ls.messages.map(m => m.role) : null,
      dom: document.querySelectorAll('.msg-bubble').length,
      pendingEl: !!pend,
      pendingText: pend ? (pend.textContent || '').slice(0, 60) : ''
    };
  }, chatId);
  console.log('[probe] 回复落库后 store=' + JSON.stringify(before.store) +
    ' disk=' + JSON.stringify(before.disk) + ' DOM气泡=' + before.dom +
    ' pending=' + before.pendingEl + ' pendingText=' + JSON.stringify(before.pendingText));

  // 整页 reload（等价「退出重进」）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(2000);
  const after = await page.evaluate((id) => {
    const c = window.Sleepy.chatStore.getChat(id);
    const ls = JSON.parse(localStorage.getItem('sleepy.v1.chats') || '[]').filter(x => x.id === id)[0];
    return {
      store: c ? (c.messages || []).map(m => m.role) : null,
      disk: ls ? ls.messages.map(m => m.role) : null
    };
  }, chatId);
  console.log('[probe] reload 后 store=' + JSON.stringify(after.store) +
    ' disk=' + JSON.stringify(after.disk));

  await browser.close();
  server.kill();
  console.log('真实回复探针跑完');
}

main().catch((e) => { console.error(e); process.exit(1); });
