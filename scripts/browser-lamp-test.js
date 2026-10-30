/* ============================================================
   scripts/browser-lamp-test.js — 挂件灯三点返修真机复现（2026-10-12 批）
   ------------------------------------------------------------
   用户反馈三点：
   ① 灯上 char 的句子带「||」分割符（气泡的分割），不是选中的那句话；
   ② 卡面一行字数太少，看得难受；
   ③ 选了一句话，上中下三层各自挂一张同句卡（重复）。
   跑法：NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
         node scripts/browser-lamp-test.js
   依赖：本机 Edge（channel:'msedge'）+ playwright-core，零网络。
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('找不到 playwright-core —— NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-lamp-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const PORT = process.env.LAMP_TEST_PORT || 5198;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(ROOT, 'docs', '验收截图-挂件灯三点返修-2026-10-12');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 长留言：28 字，用来看卡面折行后一行能排几个字 */
const LONG_NOTE = '这条留言故意写得长一点，用来看看卡面一行到底能排几个字才舒服';
/* 一条拆成两段的角色回复（输出协议的 || 分段） */
const MSG = '第一句气泡的话 || 第二句气泡的话';

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
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  try {
    await waitServer();
    /* 真机视口：项目约定 390×844；dSF 2 让卡面字在截图里可辨 */
    const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

      /* 首跑前种数据：跳过协议弹窗 + 一个角色 + 一个带 || 的对话。
         ⚠️ 留言**不在这里种**：种了 characters 之后 App 会自动建房
         （群岛 + activeSandboxId），没盖章的留言会被 core.scoped 正确
         过滤掉 —— 那是应用的正确行为。所以留言走 App 自己的写入口
         Sleepy.lampNotes.add（落库 + 盖当前的岛章），启动后再加。 */
      await page.addInitScript(({ msg }) => {
        const NS = 'sleepy.v1.';
        localStorage.setItem(NS + 'legalAgreedAt', String(Date.now()));
        localStorage.setItem(NS + 'characters', JSON.stringify([
          { id: 'c1', name: '测试角色', persona: '测试人设', createdAt: Date.now(), updatedAt: Date.now() }
        ]));
        localStorage.setItem(NS + 'chats', JSON.stringify([
          {
            id: 'ch1', characterId: 'c1', name: '测试对话',
            sandboxId: 'sb-lamp-1',   /* 盖岛章：岛隔离下没章的聊天在房里看不见 */
            createdAt: Date.now(), updatedAt: Date.now(),
            messages: [{ id: 'm1', role: 'assistant', content: msg, timestamp: Date.now() }]
          }
        ]));
        /* 预置一间活动房：真机上桌面挂载时房间早已就位 ——
           只种 characters 的话，自动建房发生在 splash finish 之后，
           ?splash=0 跳开屏就没人喊桌面挂载了（真机验收 2026-10-30 实锤，
           v295 基线同样如此，与当日改动无关）。 */
        const SB = { id: 'sb-lamp-1', name: '灯测房', kind: 'island',
          charIds: ['c1'], createdAt: 1700000000000, updatedAt: 1700000000000 };
        localStorage.setItem(NS + 'sandboxes', JSON.stringify([SB]));
        localStorage.setItem(NS + 'activeSandboxId', JSON.stringify('sb-lamp-1'));
        /* 授权闸：没这个桌面根本不挂（probe-widget-remove-ui2 的教训） */
        localStorage.setItem(NS + 'license', JSON.stringify({ token: 'probe-token', lastVerifiedAt: Date.now() }));
      }, { msg: MSG });

      /* ⚠️ 不用 ?splash=0：桌面挂载挂在开屏收尾的时点上，跳开屏会
         连 bootHome 一起跳掉（2026-10-30 真机验收实锤，v295 基线同样）。
         正常等开屏播完，只把遮罩藏掉方便断言。 */
      await page.goto(BASE + '/index.html');
      await page.waitForFunction(() => !!window.Sleepy && !!window.Sleepy.nav, null, { timeout: 20000 });
      await sleep(2500);   // 等开屏收尾（桌面在这时挂载）
      await page.evaluate(() => {
        const sp = document.getElementById('splash');
        if (sp) sp.style.display = 'none';
        const lm = document.querySelector('.legal-mask');
        if (lm) lm.style.display = 'none';
      });
      /* 长留言：走真实写入口落库（灯还没建的话，boot 时会从 store 现读） */
      const noteRec = await page.evaluate((text) => window.Sleepy.lampNotes.add({
        text: text, by: '阿玥', src: 'chat'
      }), LONG_NOTE);
      if (!noteRec) throw new Error('留言没写进去');
      await sleep(1500);   // 等桌面挂好

      /* ---- 等灯点亮 ----
         ⚠️ 先就位再滚屏：520px 预挂边距让灯从主屏就开始下，但**滚屏动作
         本身会把桌面重画**（goHome 瞬移回主屏）—— 在核心 import 窗口期内
         滚屏会撞上一个预存的竞态（IO 没挂上 + 旧 box 已摘），灯卡在
         「点亮中…」。这是本次三点修复之前就有的问题，与改动无关；
         测试侧绕开：等 is-ready 之后再滚。 */
      let ready = false;
      for (let attempt = 0; attempt < 2 && !ready; attempt++) {
        try {
          await page.waitForSelector('.w-lamp.is-ready', { timeout: attempt ? 15000 : 30000 });
          ready = true;
        } catch (e) {
          if (attempt) break;
          /* 兜底：开关一页逼桌面重画，新 box 的 IO 会重新预挂 */
          await page.evaluate(() => window.Sleepy.nav.open('chat-list'));
          await sleep(1200);
          await page.evaluate(() => window.Sleepy.nav.closeAll());
          await sleep(800);
        }
      }
      if (!ready) {
        const diag = await page.evaluate(() => ({
          灯格: !!document.querySelector('.w-lamp'),
          灯注: (document.querySelector('.w-lamp-note') || {}).textContent || '(无)',
          canvas: !!document.querySelector('.w-lamp-host canvas')
        }));
        console.log('未点亮诊断:', JSON.stringify(diag));
        throw new Error('灯没点亮');
      }
      await sleep(2500);   // 等卡片摆好、自转稳定

      /* ---- 滚到第 3 屏（就绪之后才滚，见上）---- */
      for (let t = 0; t < 5; t++) {
        await page.evaluate(() => {
          const sc = document.querySelector('.dt-scroll');
          if (sc) { sc.style.scrollBehavior = 'auto'; sc.scrollLeft = sc.clientWidth * 2; void sc.scrollLeft; }
        });
        await sleep(350);
        const sl = await page.evaluate(() => {
          const sc = document.querySelector('.dt-scroll');
          return sc ? sc.scrollLeft : -1;
        });
        if (sl >= 700) break;   // 没被 goHome 弹回去
      }

      /* ---- ①③ 装配层：一条留言只占一个挂点 ---- */
      const asm = await page.evaluate(() => {
        const cards = window.Sleepy.desktop.lampCards();
        const txt = String(cards[0] && cards[0].text || '');
        return {
          总数: cards.length,
          该留言出现次数: cards.filter((c) => String(c.text || '').indexOf('这条留言故意写得长一点') >= 0).length,
          首卡正文: txt.split('\n')[0],
          落款行: txt.split('\n')[1] || '',
          留言条数: (window.Sleepy.lampNotes.list() || []).length
        };
      });
      console.log('装配:', JSON.stringify(asm));
      if (asm.总数 !== 36) throw new Error('没补齐到 36 挂点：' + asm.总数);
      if (asm.该留言出现次数 !== 1) throw new Error('同句重复悬挂：' + asm.该留言出现次数 + ' 次');

      /* ---- 截图：桌面第 3 屏全景 + 灯的特写 ---- */
      await page.screenshot({ path: path.join(OUT, '1-桌面第三屏-灯.png') });
      const host = await page.locator('.w-lamp-host canvas').boundingBox();
      if (host) {
        await page.screenshot({
          path: path.join(OUT, '2-灯特写.png'),
          clip: { x: Math.max(0, host.x - 8), y: Math.max(0, host.y - 8), width: host.width + 16, height: host.height + 16 }
        });
      }
      console.log('截图 1/2 已存');

      /* ---- ② 放大态特写：点一张**留言卡**（落款浮层 is-on 只有留言卡有）---- */
      let focused = false;
      if (host) {
        const pts = [];
        for (let ry = 0.08; ry <= 0.5; ry += 0.105) {
          for (let rx = 0.2; rx <= 0.8; rx += 0.12) pts.push([rx, ry]);
        }
        for (const [rx, ry] of pts) {
          const x = host.x + host.width * rx, y = host.y + host.height * ry;
          await page.mouse.click(x, y);
          await sleep(320);
          const on = await page.evaluate(() =>
            document.querySelector('.w-lamp').classList.contains('is-focus') &&
            document.querySelector('.w-lamp-sign').classList.contains('is-on'));
          if (on) { focused = true; break; }
          /* 没中点/点中了空板 → 再点一下收起，换下一个点 */
          const still = await page.evaluate(() => document.querySelector('.w-lamp').classList.contains('is-focus'));
          if (still) { await page.mouse.click(x, y); await sleep(260); }
        }
      }
      if (focused) {
        await sleep(900);   // 等放大动画稳
        await page.screenshot({ path: path.join(OUT, '3-放大态-留言卡.png') });
        const sign = await page.evaluate(() => document.querySelector('.w-lamp-sign').textContent);
        console.log('放大态落款:', sign);
        /* 收回去：点一下 */
        await page.mouse.click(host.x + host.width / 2, host.y + host.height / 2);
        await sleep(400);
      } else {
        console.log('放大态：没点到留言卡（自转 + 钟摆晃动，扫描点没命中）—— 桌面截图已足够看折行');
      }

      /* ---- ① 长按第二段气泡「留在灯上」：挂上去的必须是那一句，不带 || ---- */
      await page.evaluate(() => window.Sleepy.nav.open('chat-detail', { chatId: 'ch1' }));
      await sleep(1500);
      const bubbles = await page.locator('.msg-bubble').count();
      console.log('气泡数（应为 2，一条回复按 || 拆两段）:', bubbles);
      if (bubbles !== 2) throw new Error('|| 分段气泡数不对：' + bubbles);

      const b2 = page.locator('.msg-bubble').nth(1);
      const box = await b2.boundingBox();
      if (!box) throw new Error('第二个气泡没渲染出来');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(850);            // > 长按阈值
      await page.mouse.up();
      await sleep(500);
      const menuOk = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.msg-pop-item')).map((b) => b.textContent);
        return { 菜单: items, 有留在灯上: items.indexOf('留在灯上') >= 0 };
      });
      console.log('长按菜单:', JSON.stringify(menuOk));
      if (!menuOk.有留在灯上) throw new Error('长按菜单里没有「留在灯上」');

      await page.evaluate(() => {
        const bs = Array.from(document.querySelectorAll('.msg-pop-item'));
        (bs.find((b) => b.textContent === '留在灯上') || {}).click && bs.find((b) => b.textContent === '留在灯上').click();
      });
      await sleep(900);

      const after = await page.evaluate(() => {
        const notes = window.Sleepy.lampNotes.list() || [];
        const last = notes[notes.length - 1] || {};
        const cards = window.Sleepy.desktop.lampCards();
        return {
          留言数: notes.length,
          最后一条正文: last.text || '',
          署名: last.by || '',
          新留言在灯上出现次数: cards.filter((c) => String(c.text || '').indexOf(last.text || '\u0000') >= 0).length,
          总挂点: cards.length
        };
      });
      console.log('留灯后:', JSON.stringify(after));
      if (after.留言数 !== 2) throw new Error('留言没落库：' + after.留言数);
      if (after.最后一条正文 !== '第二句气泡的话') {
        throw new Error('挂上去的不是选中的那句话（带分割符或挂错段）：' + JSON.stringify(after.最后一条正文));
      }
      if (after.新留言在灯上出现次数 !== 1) throw new Error('新留言重复悬挂：' + after.新留言在灯上出现次数);
      if (after.总挂点 !== 36) throw new Error('补齐破坏：' + after.总挂点);

      /* ---- 回桌面看灯：新卡热刷新上灯 ---- */
      await page.evaluate(() => window.Sleepy.nav.closeAll());
      await sleep(1500);
      await page.evaluate(() => {
        const sc = document.querySelector('.dt-scroll');
        if (sc) { sc.style.scrollBehavior = 'auto'; sc.scrollLeft = sc.clientWidth * 2; void sc.scrollLeft; }
      });
      await sleep(900);
      await page.screenshot({ path: path.join(OUT, '4-回桌面-两条留言.png') });

      console.log('页面错误:', errors.length ? errors : '(无)');
      if (errors.length) throw new Error('有页面错误：' + errors[0]);

      console.log('\n全部通过：①选中哪句挂哪句（无 ||） ②一条只挂一个挂点 ③卡面折行见截图');
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
