/* ============================================================
   scripts/probe-2tab-clobber.js — 双会话缓存覆盖实验
   ------------------------------------------------------------
   同一 profile 开两个标签（= 两份独立 store 内存缓存 + 一份 localStorage）：
   A 写消息 → B（缓存陈旧）任意写一次 chats → B 把 A 的写入整表覆盖？
   复现「退出重进只剩一部分消息」的经典 lost-update。
   跑法：NODE_PATH=...node_modules node scripts/probe-2tab-clobber.js
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
const PORT = process.env.PROBE_PORT || 5203;
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
  await waitServer();
  const browser = await pw.chromium.launchPersistentContext(
    path.join(ROOT, '_tmp-probe-profile-2tab'), { channel: 'msedge', headless: true });
  const mk = async () => {
    const p = await browser.newPage();
    p.on('console', (m) => { const t = m.text(); if (t.indexOf('[probe]') === 0) console.log('  ' + t); });
    await p.addInitScript(() => {
      const t = setInterval(() => {
        if (window.Sleepy && window.Sleepy.licenseGate) {
          window.Sleepy.licenseGate.state = function () { return 'ok'; };
          clearInterval(t);
        }
      }, 5);
    });
    await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
    return p;
  };
  const pageA = await mk();
  const pageB = await mk();
  await sleep(1200);

  await pageA.evaluate(() => {
    const S = window.Sleepy, core = S.core, store = S.store;
    const sbId = 'probe3_sb';
    store.set('sandboxes', (store.get('sandboxes') || []).filter(s => s.id !== sbId).concat([{
      id: sbId, kind: 'isle', name: '双标签岛', charIds: ['probe3_ch'], maskIds: ['probe3_um']
    }]));
    core.upsertChar({ id: 'probe3_ch', kind: 'main', name: '双标酱', content: 'x', sandboxId: sbId, parentId: sbId, parentType: 'sandbox' });
    core.upsertUser({ id: 'probe3_um', name: '我', sandboxId: sbId });
    store.set('activeSandboxId', sbId);
    const c = S.chatStore.createChat('probe3_ch', '双标签对话');
    window.__cid = c.id;
    S.chatStore.addMessage(c.id, { id: S.chatStore.newId(), role: 'user', content: 'A写的话', timestamp: Date.now() });
    S.chatStore.addMessage(c.id, { id: S.chatStore.newId(), role: 'assistant', content: 'TA回的话', timestamp: Date.now() });
    localStorage.setItem('probe_cid', c.id);
  });

  // B 的缓存要对齐到「已有 2 条」的真实场景：B 重载一次（从磁盘读到 2 条）
  await pageB.reload({ waitUntil: 'domcontentloaded' });
  await pageB.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(1200);
  await pageB.evaluate(() => { window.Sleepy.store.get('chats'); });

  // A 再写一条（此刻 B 的缓存里没有这条）
  await pageA.evaluate(() => {
    const S = window.Sleepy;
    const cid = localStorage.getItem('probe_cid');
    S.chatStore.addMessage(cid, { id: S.chatStore.newId(), role: 'assistant', content: 'A后写的TA回复', timestamp: Date.now() });
  });

  // B 现在写一次（它的缓存还是旧的）→ 理论上把 A 后写的覆盖掉
  await pageB.evaluate(() => {
    const S = window.Sleepy;
    const cid = localStorage.getItem('probe_cid');
    const c = S.chatStore.getChat(cid);
    console.log('[probe] B 缓存里 sees=' + (c ? c.messages.length : -1) + ' 条');
    if (c) S.chatStore.addMessage(cid, { id: S.chatStore.newId(), role: 'user', content: 'B写的话', timestamp: Date.now() });
  });

  // A reload 后看最终态
  await pageA.reload({ waitUntil: 'domcontentloaded' });
  await pageA.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.store, null, { timeout: 20000 });
  await sleep(1500);
  const res = await pageA.evaluate(() => {
    const cid = localStorage.getItem('probe_cid');
    const c = window.Sleepy.chatStore.getChat(cid);
    return { n: c ? c.messages.length : -1, roles: c ? c.messages.map(m => m.role + ':' + m.content).join(' | ') : '' };
  });
  console.log('[probe] 终态 ' + res.n + ' 条：' + res.roles);
  await browser.close();
  server.kill();
  console.log('双标签探针跑完');
}

main().catch((e) => { console.error(e); process.exit(1); });
