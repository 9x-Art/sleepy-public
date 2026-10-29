/* ============================================================
   scripts/probe-ui-message-loss.js — 「刷新后 TA 的话没了」UI 级复现
   ------------------------------------------------------------
   在真浏览器里走完整用户路径：
     过授权闸（探针内打桩）→ 建岛/角色/对话 → 打开聊天页（真渲染）
     → addMessage user/assistant → 数 DOM 气泡 → 离开再回 → 数
     → 整页 reload → 再开聊天页 → 数 DOM vs 数 store。
   谁少了当场印出来：store 丢了 / 渲染丢了，一层一层剥。
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/probe-ui-message-loss.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— 用 managed node workspace 跑');
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
  try { await waitServer(); } catch (e) { server.kill(); throw e; }

  const browser = await pw.chromium.launchPersistentContext(
    path.join(ROOT, '_tmp-probe-profile-ui'),
    { channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.indexOf('[probe]') === 0) console.log('  ' + t); });
  page.on('pageerror', (e) => console.log('  [probe] pageerror: ' + e.message));

  // 授权闸打桩：Sleepy 一出现就把 state 改成 ok（bootHome 每次都查它）
  await page.addInitScript(() => {
    const t = setInterval(() => {
      if (window.Sleepy && window.Sleepy.licenseGate) {
        window.Sleepy.licenseGate.state = function () { return 'ok'; };
        clearInterval(t);
      }
    }, 5);
  });

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(2000);   // 等 bootHome / demo seed 落定

  // 建探针岛 + 对话（生产 core/chatStore 路径）
  const chatId = await page.evaluate(() => {
    const S = window.Sleepy, core = S.core, store = S.store;
    const sbId = 'probe2_sb';
    store.set('sandboxes', (store.get('sandboxes') || []).filter(s => s.id !== sbId).concat([{
      id: sbId, kind: 'isle', name: '探针岛2', charIds: ['probe2_ch'], maskIds: ['probe2_um']
    }]));
    core.upsertChar({ id: 'probe2_ch', kind: 'main', name: '探针酱', content: '测试', sandboxId: sbId, parentId: sbId, parentType: 'sandbox' });
    core.upsertUser({ id: 'probe2_um', name: '我', sandboxId: sbId });
    store.set('activeSandboxId', sbId);
    const chat = S.chatStore.createChat('probe2_ch', '探针对话2');
    return chat.id;
  });

  // 打开聊天页（真渲染），逐条 addMessage，数气泡
  await page.evaluate((id) => { window.Sleepy.nav.open('chat-detail', { chatId: id }); }, chatId);
  await sleep(800);
  await page.evaluate((id) => {
    const S = window.Sleepy;
    S.chatStore.addMessage(id, { id: S.chatStore.newId(), role: 'user', content: '你说的第一句', timestamp: Date.now() - 2000 });
    S.chatStore.addMessage(id, { id: S.chatStore.newId(), role: 'assistant', content: 'TA回的第一句||TA回的第二句', timestamp: Date.now() - 1000, memoryId: null, trans: [], quote: null });
    S.chatStore.addMessage(id, { id: S.chatStore.newId(), role: 'user', content: '你说的第二句', timestamp: Date.now() });
    // 通知当前页重画（真实路径由页面自己喊；这里手动触发一次）
    const tc = S.nav.topCtx();
    if (tc && tc.el) {
      const ev = new Event('probe-rerender');
      // renderMessages 不在导出面上 —— 直接看增量快路径是否吃这条消息：
      // 聊天页监听 store 变化吗？先只读 DOM。
    }
  }, chatId);
  await sleep(500);
  const count1 = await page.evaluate(() => document.querySelectorAll('.msg-bubble').length);
  const store1 = await page.evaluate((id) => (window.Sleepy.chatStore.getChat(id).messages || []).length, chatId);
  console.log('[probe] 第一阶段 DOM 气泡=' + count1 + '，store 消息=' + store1);

  // 离开聊天页 → 回来（页面实例缓存复用，走 onShow）
  await page.evaluate(() => { window.Sleepy.nav.closeAll(); });
  await sleep(400);
  await page.evaluate((id) => { window.Sleepy.nav.open('chat-detail', { chatId: id }); }, chatId);
  await sleep(800);
  const count2 = await page.evaluate(() => document.querySelectorAll('.msg-bubble').length);
  console.log('[probe] 离开再回 DOM 气泡=' + count2);

  // 整页 reload（大刷新）→ 再开聊天页
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(2000);
  const store2 = await page.evaluate((id) => (window.Sleepy.chatStore.getChat(id).messages || []).length, chatId);
  await page.evaluate((id) => { window.Sleepy.nav.open('chat-detail', { chatId: id }); }, chatId);
  await sleep(800);
  const count3 = await page.evaluate(() => document.querySelectorAll('.msg-bubble').length);
  const roles = await page.evaluate((id) => (window.Sleepy.chatStore.getChat(id).messages || []).map(m => m.role).join(','), chatId);
  console.log('[probe] reload 后 store 消息=' + store2 + '（roles: ' + roles + '）');
  console.log('[probe] reload 后 DOM 气泡=' + count3);

  await browser.close();
  server.kill();
  console.log('UI 探针跑完');
}

main().catch((e) => { console.error(e); process.exit(1); });
