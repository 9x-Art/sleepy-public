/* ============================================================
   scripts/probe-beautify-css.js — 美化 CSS 全链路探针（2026-10-30）
   ------------------------------------------------------------
   真机视口（390×844）+ Edge headless。用户口径：
   「只要可以做美化 css 的地方，改一改看看能不能使用，
     退出后再进入是否还是对的」。

   A. 私聊 · 角色外观 CSS（charAppearance.byChar.customCss）
      写入（外观页 textarea，input 即落库）→ 聊天页注入生效
      → reload 冷启动后仍在
   B. 群聊 · 群聊美化 CSS（group.beautifyCss）
      写入（群聊美化页 textarea，input 即落库）→ 群聊页注入生效
      → reload 冷启动后仍在
   C. 互斥：#apCustomStyle 单槽位 —— 进私聊摘群 CSS，进群聊摘私聊 CSS
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

const PORT = process.env.PROBE_PORT || 5235;
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
  localStorage.setItem('sleepy.v1.legalAgreedAt', JSON.stringify(Date.now()));
  localStorage.setItem('sleepy.v1.license', JSON.stringify({ token: 'probe-token', lastVerifiedAt: Date.now() }));
};

const HIDE_MASKS = () => {
  const sp = document.getElementById('splash');
  if (sp) sp.style.display = 'none';
  const lm = document.querySelector('.legal-mask');
  if (lm) lm.style.display = 'none';
};

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail ? '  \u2192 ' + detail : ''));
}

/* 在某个编辑页的 .cap-css-area 里写 CSS（input 即落库，同一手感） */
async function writeCss(page, css) {
  await page.evaluate((c) => {
    const area = document.querySelector('.cap-css-area');
    area.value = c;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, css);
  await sleep(300);
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

    /* ---------- 准备：演示岛 + 会话/群 id ---------- */
    const ids = await page.evaluate(() => {
      Sleepy.demoSeed.ensure();
      const chats = Sleepy.store.get('chats') || [];
      const demo = chats.filter((c) => c && c.messages && c.messages.length)[0];
      const charId = demo.characterId;
      const g = Sleepy.groupStore.createGroup({
        name: '探针群',
        members: [{ accountId: charId, kind: 'char' }],
        ownerAccountId: demo.userId || null
      });
      return { chatId: demo.id, charId, groupId: g.ok ? g.group.id : null, gMsg: g.message || '' };
    });
    check('演示会话就位', !!ids.chatId, ids.chatId || '');
    check('探针群建好', !!ids.groupId, ids.gMsg);

    /* ---------- A. 私聊 · 角色外观 CSS ---------- */
    console.log('[A] 私聊角色外观 CSS');
    await page.evaluate((id) => Sleepy.nav.open('chat-detail', { chatId: id }), ids.chatId);
    await sleep(900);
    const a0 = await page.evaluate(() => !!document.getElementById('apCustomStyle'));
    check('基线：还没写 CSS 时聊天页没有注入', !a0);

    await page.evaluate((id) => Sleepy.nav.open('char-appearance', { chatId: id }), ids.chatId);
    await sleep(700);
    await writeCss(page,
      '/*probe-private*/ .msg-bubble{border:2px solid rgb(255, 0, 0) !important;}');
    const a1 = await page.evaluate(() => {
      return JSON.stringify(Sleepy.store.get('charAppearance') || {}).indexOf('/*probe-private*/') >= 0;
    });
    check('写入即落库（charAppearance 含标记）', a1);

    await page.evaluate((id) => Sleepy.nav.open('chat-detail', { chatId: id }), ids.chatId);
    await sleep(900);
    const a2 = await page.evaluate(() => {
      const st = document.getElementById('apCustomStyle');
      const bubble = document.querySelector('.msg-bubble');
      return {
        injected: !!st && st.textContent.indexOf('/*probe-private*/') >= 0,
        applied: bubble ? getComputedStyle(bubble).borderRightWidth === '2px' &&
                           getComputedStyle(bubble).borderTopColor === 'rgb(255, 0, 0)' : false
      };
    });
    check('回到聊天页：CSS 已注入', a2.injected);
    check('CSS 真的生效（气泡边框变红）', a2.applied);

    /* 冷启动：reload 后重进，还在 */
    await page.reload();
    await sleep(2000);
    await page.evaluate(HIDE_MASKS);
    await sleep(400);
    await page.evaluate((id) => Sleepy.nav.open('chat-detail', { chatId: id }), ids.chatId);
    await sleep(900);
    const a3 = await page.evaluate(() => {
      const st = document.getElementById('apCustomStyle');
      const bubble = document.querySelector('.msg-bubble');
      return {
        injected: !!st && st.textContent.indexOf('/*probe-private*/') >= 0,
        applied: bubble ? getComputedStyle(bubble).borderTopColor === 'rgb(255, 0, 0)' : false
      };
    });
    check('退出重进（冷启动）：CSS 还在', a3.injected && a3.applied,
      'injected=' + a3.injected + ' applied=' + a3.applied);

    /* ---------- B. 群聊 · 群聊美化 CSS ---------- */
    console.log('[B] 群聊美化 CSS');
    await page.evaluate((id) => Sleepy.nav.open('group-beautify', { groupId: id }), ids.groupId);
    await sleep(700);
    await writeCss(page,
      '/*probe-group*/ .gc-list{border-top:3px solid rgb(0, 128, 0) !important;}');
    const b1 = await page.evaluate((gid) => {
      const g = Sleepy.groupStore.findGroup(gid);
      return !!g && String(g.beautifyCss || '').indexOf('/*probe-group*/') >= 0;
    }, ids.groupId);
    check('写入即落库（群记录 beautifyCss 含标记）', b1);

    await page.evaluate((id) => Sleepy.nav.open('group-chat', { groupId: id }), ids.groupId);
    await sleep(900);
    const b2 = await page.evaluate(() => {
      const st = document.getElementById('apCustomStyle');
      const list = document.querySelector('.gc-list');
      return {
        injected: !!st && st.textContent.indexOf('/*probe-group*/') >= 0,
        applied: list ? getComputedStyle(list).borderTopColor === 'rgb(0, 128, 0)' : false,
        privateGone: !st || st.textContent.indexOf('/*probe-private*/') < 0
      };
    });
    check('群聊页：CSS 已注入且生效', b2.injected && b2.applied,
      'injected=' + b2.injected + ' applied=' + b2.applied);
    check('进群聊摘掉了私聊 CSS（单槽互斥）', b2.privateGone);

    await page.reload();
    await sleep(2000);
    await page.evaluate(HIDE_MASKS);
    await sleep(400);
    await page.evaluate((id) => Sleepy.nav.open('group-chat', { groupId: id }), ids.groupId);
    await sleep(900);
    const b3 = await page.evaluate(() => {
      const st = document.getElementById('apCustomStyle');
      const list = document.querySelector('.gc-list');
      return {
        injected: !!st && st.textContent.indexOf('/*probe-group*/') >= 0,
        applied: list ? getComputedStyle(list).borderTopColor === 'rgb(0, 128, 0)' : false
      };
    });
    check('退出重进（冷启动）：群 CSS 还在', b3.injected && b3.applied,
      'injected=' + b3.injected + ' applied=' + b3.applied);

    /* ---------- C. 反向互斥：再进私聊，群 CSS 摘掉 ---------- */
    await page.evaluate((id) => Sleepy.nav.open('chat-detail', { chatId: id }), ids.chatId);
    await sleep(900);
    const c1 = await page.evaluate(() => {
      const st = document.getElementById('apCustomStyle');
      return !st || st.textContent.indexOf('/*probe-group*/') < 0;
    });
    check('再进私聊：群 CSS 被摘掉', c1);

    check('全程无页面 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    console.log(failures ? ('失败 ' + failures + ' 条') : '全绿：美化 CSS 写入/生效/持久化/互斥 验收通过');
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('探针异常：', e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}
main();
