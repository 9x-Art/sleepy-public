/* ============================================================
   scripts/browser-reaction-test.js — 长按贴表情真机复现（临时排查脚本）
   跑法：NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
         node scripts/browser-reaction-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-reaction-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.REACTION_TEST_PORT || 5199;
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
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

      await page.goto(BASE + '/index.html?splash=0');
      await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.nav, null, { timeout: 20000 });
      await sleep(1500); // 等首屏/guide 渲染完

      // 种数据：一个角色 + 一个对话 + 一条角色消息
      const seed = await page.evaluate(() => {
        const S = window.Sleepy.store;
        const chars = S.get('characters') || [];
        if (!chars.some((c) => c.id === 'c1')) {
          chars.push({ id: 'c1', name: '测试角色', persona: '测试', createdAt: Date.now(), updatedAt: Date.now() });
          S.set('characters', chars);
        }
        const chats = S.get('chats') || [];
        if (!chats.some((c) => c.id === 'ch1')) {
          chats.push({
            id: 'ch1', characterId: 'c1', name: '测试对话',
            createdAt: Date.now(), updatedAt: Date.now(),
            messages: [{ id: 'm1', role: 'char', content: '你好呀，这是一条测试消息', timestamp: Date.now() }]
          });
          S.set('chats', chats);
        }
        return { navIds: typeof window.Sleepy.nav.open };
      });
      console.log('seed ok:', JSON.stringify(seed));

      await page.evaluate(() => window.Sleepy.nav.open('chat-detail', { chatId: 'ch1' }));
      await sleep(1200);

      const bubbleCount = await page.evaluate(() => document.querySelectorAll('.msg-bubble').length);
      console.log('bubbles on screen:', bubbleCount);
      if (!bubbleCount) {
        console.log('没有气泡，页面顶层是:', await page.evaluate(() => {
          const p = document.querySelector('[data-page]');
          return p ? p.getAttribute('data-page') : '(无 data-page)';
        }));
      }

      // 长按第一条气泡（mouse 按住 480ms+）
      const bubble = page.locator('.msg-bubble').first();
      const box = await bubble.boundingBox();
      if (!box) throw new Error('气泡没渲染出来');
      // 探针：谁收到了 mousedown / pointerdown
      await page.evaluate(() => {
        window.__probe = [];
        ['pointerdown', 'mousedown', 'touchstart'].forEach((t) => {
          document.addEventListener(t, (e) => {
            const d = e.target;
            const chain = [];
            let n = d;
            while (n && chain.length < 6) { chain.push((n.tagName || '') + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').join('.') : '')); n = n.parentElement; }
            window.__probe.push(t + ' <- ' + chain.join(' < '));
          }, true);
        });
      });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(300);
      const mid1 = await page.evaluate(() => ({ pops: document.querySelectorAll('.anchor-pop').length, probe: window.__probe }));
      await sleep(500); // 共 800ms > 480ms
      const mid2 = await page.evaluate(() => {
        return {
          pops: document.querySelectorAll('.anchor-pop').length,
          lpAt: (document.querySelector('.msg-bubble') || {}).__lpAt || 0
        };
      });
      console.log('按住300ms时:', JSON.stringify(mid1), '按住800ms时:', JSON.stringify(mid2));
      await page.mouse.up();
      await sleep(400);

      const menuInfo = await page.evaluate(() => {
        const pop = document.querySelector('.anchor-pop.msg-pop');
        if (!pop) return { hasMenu: false };
        const row = pop.querySelector('.msg-pop-emoji');
        return {
          hasMenu: true,
          hasEmojiRow: !!row,
          emojiBtns: row ? row.querySelectorAll('.msg-pop-emoji-btn').length : 0
        };
      });
      console.log('长按菜单:', JSON.stringify(menuInfo));

      if (menuInfo.hasEmojiRow) {
        await page.locator('.msg-pop-emoji-btn').first().click();
        await sleep(800);
        const after = await page.evaluate(() => {
          const chats = window.Sleepy.store.get('chats') || [];
          const ch = chats.find((c) => c.id === 'ch1') || {};
          const m = (ch.messages || []).find((x) => x.id === 'm1') || {};
          const pill = document.querySelector('.msg-reactions');
          return {
            reactions: m.reactions || null,
            pillOnScreen: !!pill,
            pillText: pill ? pill.textContent : ''
          };
        });
        console.log('贴表情后:', JSON.stringify(after, null, 2));
      }

      console.log('页面错误:', errors.length ? errors : '(无)');
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
