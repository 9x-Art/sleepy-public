/* ============================================================
   scripts/probe-message-loss.js — 「退出重进消息没了」最小复现探针
   ------------------------------------------------------------
   真浏览器（headless Edge，一次性 profile）+ 生产源码原文。
   场景：写 chats（带消息）→ 读回 → 整页 reload（模拟「退出重进」）
   → 再读。两边各打印条数与首末消息 id，用行为证据定位丢在哪层。
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/probe-message-loss.js
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

const PORT = process.env.PROBE_PORT || 5199;
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
    path.join(ROOT, '_tmp-probe-profile'),
    { channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.indexOf('[probe]') === 0) console.log('  ' + t);
  });
  page.on('pageerror', (e) => console.log('  [probe] pageerror: ' + e.message));

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(1500);   // 等启动流程（迁移/演示岛）落定

  // ① 直接走生产 store 层写一段带消息的 chats
  await page.evaluate(() => {
    const S = window.Sleepy;
    const chat = {
      id: 'probe_chat_1', name: '探针', characterId: 'probe_c', userId: 'probe_u',
      messages: [
        { id: 'm1', role: 'user', content: '第一条', timestamp: Date.now() - 2000 },
        { id: 'm2', role: 'assistant', content: '第二条', timestamp: Date.now() - 1000 },
        { id: 'm3', role: 'user', content: '第三条', timestamp: Date.now() }
      ]
    };
    const ok = S.store.set('chats', [chat]);
    const back = S.store.get('chats') || [];
    console.log('[probe] 写入 ok=' + ok + '，写完内存读回条数=' + (back[0] ? back[0].messages.length : -1));
    console.log('[probe] localStorage 直接读条数=' +
      JSON.parse(localStorage.getItem('sleepy.v1.chats') || '[]').map(c => c.messages.length).join(','));
  });

  // ② reload = 「退出重进」
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(1500);

  await page.evaluate(() => {
    const S = window.Sleepy;
    const ls = JSON.parse(localStorage.getItem('sleepy.v1.chats') || '[]');
    const mine = ls.filter(c => c.id === 'probe_chat_1')[0];
    const viaStore = (S.store.get('chats') || []).filter(c => c.id === 'probe_chat_1')[0];
    console.log('[probe] reload 后 localStorage 条数=' + (mine ? mine.messages.length : '整条对话没了'));
    console.log('[probe] reload 后 store.get 条数=' + (viaStore ? viaStore.messages.length : '整条对话没了'));
    // 存档里还有什么键、各自多大
    const sizes = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      sizes[k] = (localStorage.getItem(k) || '').length;
    }
    console.log('[probe] 键清单: ' + Object.keys(sizes).map(k => k + '=' + sizes[k]).join(' '));
  });

  // ③ 真实 chatStore 路径：铺一座探针岛（headless 里 demo-seed 不一定跑）
  const chatId = await page.evaluate(() => {
    const S = window.Sleepy;
    const core = S.core;
    const store = S.store;
    const sbId = 'probe_sb_1';
    store.set('sandboxes', (store.get('sandboxes') || []).filter(s => s.id !== sbId).concat([{
      id: sbId, kind: 'isle', name: '探针岛', charIds: ['probe_ch_1'], maskIds: ['probe_um_1']
    }]));
    core.upsertChar({ id: 'probe_ch_1', kind: 'main', name: '探针酱', content: '测试人设', sandboxId: sbId, parentId: sbId, parentType: 'sandbox' });
    core.upsertUser({ id: 'probe_um_1', name: '我', sandboxId: sbId });
    store.set('activeSandboxId', sbId);
    const chat = S.chatStore.createChat('probe_ch_1', '探针对话');
    S.chatStore.addMessage(chat.id, { id: S.chatStore.newId(), role: 'user', content: '真路径一条', timestamp: Date.now() });
    S.chatStore.addMessage(chat.id, { id: S.chatStore.newId(), role: 'assistant', content: '真路径两条', timestamp: Date.now() });
    return chat.id;
  });
  const c1 = await page.evaluate((id) => {
    const c = id && window.Sleepy.chatStore.getChat(id);
    return c ? c.messages.length : -1;
  }, chatId);
  console.log('[probe] 真路径 chatId=' + chatId + '，reload 前消息数=' + c1);

  // ④ 再 reload 一次
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(1500);
  await page.evaluate((id) => {
    const S = window.Sleepy;
    const c = S.chatStore.getChat(id);
    console.log('[probe] 第二次 reload 后真路径消息数=' + (c ? c.messages.length : -1));
    const ls = JSON.parse(localStorage.getItem('sleepy.v1.chats') || '[]');
    const mine = ls.filter(x => x.id === id)[0];
    console.log('[probe] 第二次 reload 后 localStorage 消息数=' + (mine ? mine.messages.length : -1));
  }, chatId);

  await browser.close();
  server.kill();
  console.log('探针跑完');
}

main().catch((e) => { console.error(e); process.exit(1); });
