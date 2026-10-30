/* ============================================================
   scripts/probe-msgmenu.js — 长按菜单瘦身版探针（2026-10-30）
   ------------------------------------------------------------
   真机视口（390×844 + touch）+ Edge headless，验证：
   A. 长按菜单弹出：emoji 条 + 两列网格 + 「更多」 + 删除独占一行
   B. 「更多」展开低频项（留在灯上/编辑…），收起后不可见
   C. 菜单整体不出屏（390 宽视口内）
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

const PORT = process.env.PROBE_PORT || 5233;
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

/* 只给授权闸，**不预置 sandboxes** —— 让 demo 种子把演示岛注进来，
   这样有现成的角色 + 欢迎对话可以长按。 */
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

    /* ---------- 准备：演示岛 + 打开欢迎对话 ---------- */
    const chatId = await page.evaluate(() => {
      Sleepy.demoSeed.ensure();
      const chats = Sleepy.store.get('chats') || [];
      const demo = chats.filter((c) => c && c.messages && c.messages.length)[0];
      return demo ? demo.id : null;
    });
    check('演示对话就位', !!chatId, chatId || '没找到');
    await page.evaluate((id) => Sleepy.nav.open('chat-detail', { chatId: id }), chatId);
    await sleep(900);

    /* ---------- A. 长按菜单结构 ---------- */
    console.log('[A] 菜单结构');
    await page.evaluate(() => {
      const bubble = document.querySelector('.msg-bubble.msg-assistant');
      bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(500);
    const a = await page.evaluate(() => {
      const pop = document.querySelector('.msg-pop');
      if (!pop) return { open: false };
      const labels = Array.from(pop.querySelectorAll('.msg-pop-item'))
        .filter((b) => !b.closest('.msg-pop-extra'))
        .map((b) => b.textContent.trim());
      const extra = pop.querySelector('.msg-pop-extra');
      const del = Array.from(pop.querySelectorAll('.msg-pop-item.is-danger'))[0];
      const rect = pop.getBoundingClientRect();
      return {
        open: true,
        labels,
        emojiN: pop.querySelectorAll('.msg-pop-emoji-btn').length,
        hasMore: labels.indexOf('更多 \u25be') >= 0,
        extraHidden: extra ? getComputedStyle(extra).display === 'none' : null,
        delWide: del ? del.classList.contains('is-wide') : false,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      };
    });
    check('菜单弹出', a.open);
    check('emoji 回应条在', a.emojiN > 0, a.emojiN + ' 个');
    check('常用项在主列表（引用/复制/转发/收藏/多选）',
      ['引用', '复制', '转发', '收藏', '多选'].every((l) => a.labels.indexOf(l) >= 0),
      JSON.stringify(a.labels));
    check('低频项（编辑/留在灯上）收进「更多」，默认不可见',
      a.hasMore && a.labels.indexOf('编辑') < 0 && a.labels.indexOf('留在灯上') < 0,
      'hasMore=' + a.hasMore);
    check('「更多」默认收起', a.extraHidden);
    check('删除独占一整行', a.delWide);
    check('菜单不出屏（390 宽内）',
      a.rect.x >= 0 && a.rect.x + a.rect.w <= 390 && a.rect.y >= 0 && a.rect.y + a.rect.h <= 844,
      JSON.stringify(a.rect));

    /* ---------- B. 「更多」展开/收起 ---------- */
    console.log('[B] 更多展开');
    await page.evaluate(() => {
      const pop = document.querySelector('.msg-pop');
      const more = Array.from(pop.querySelectorAll('.msg-pop-more'))[0];
      more.click();
    });
    await sleep(300);
    const b = await page.evaluate(() => {
      const pop = document.querySelector('.msg-pop');
      const extra = pop.querySelector('.msg-pop-extra');
      const labels = Array.from(pop.querySelectorAll('.msg-pop-extra .msg-pop-item'))
        .map((x) => x.textContent.trim());
      const more = Array.from(pop.querySelectorAll('.msg-pop-more'))[0];
      return {
        shown: extra ? getComputedStyle(extra).display !== 'none' : false,
        labels,
        moreLabel: more ? more.textContent.trim() : '',
        popStill: !!pop
      };
    });
    check('展开后低频项可见', b.shown, JSON.stringify(b.labels));
    check('留在灯上 / 编辑在展开区',
      b.labels.indexOf('留在灯上') >= 0 && b.labels.indexOf('编辑') >= 0);
    check('按钮文案切到「收起」', b.moreLabel.indexOf('收起') >= 0, b.moreLabel);
    check('展开动作不关菜单', b.popStill);
    await page.evaluate(() => {
      const more = document.querySelector('.msg-pop-more');
      more.click();
    });
    await sleep(200);
    const b2 = await page.evaluate(() => {
      const extra = document.querySelector('.msg-pop-extra');
      return extra ? getComputedStyle(extra).display === 'none' : false;
    });
    check('再点收起', b2);

    check('全程无页面 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    console.log(failures ? ('失败 ' + failures + ' 条') : '全绿：长按菜单瘦身版验收通过');
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
